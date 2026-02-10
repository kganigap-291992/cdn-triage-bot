// app/api/chat/route.ts
import { NextResponse } from "next/server";

type ChatMsg = { role: "system" | "user" | "assistant"; content: string };

type ChatRequest = {
  messages: ChatMsg[];
  context?: {
    mode?: "csv" | "clickhouse";
    availableRegions?: string[];
    availablePops?: string[];
    availablePartners?: string[];
  };
};

type HintsResponse = {
  kind: "triage";
  serviceHint: "all" | "live" | "vod" | null;
  regionHint: string | "all" | null;
  popHint: string | "all" | null;
  windowHint: number | null; // minutes
  partnerHint: string | null;
  needsPartnerQuestion: boolean;
  partnerQuestion: string | null;
  _debug?: any;
};

type GeneralResponse = {
  kind: "general";
  reply: string;
  _debug?: any;
};

const DEFAULT_TRIAGE: Omit<HintsResponse, "_debug"> = {
  kind: "triage",
  serviceHint: null,
  regionHint: null,
  popHint: null,
  windowHint: null,
  partnerHint: null,
  needsPartnerQuestion: false,
  partnerQuestion: null,
};

function sleep(ms: number) {
  return new Promise((res) => setTimeout(res, ms));
}

function safeJsonParse(s: string): any | null {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function normalizeToken(s: string) {
  return String(s ?? "").trim().toLowerCase();
}

function stripPunctAndSpaces(s: string) {
  return String(s ?? "")
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, " ")
    .trim();
}

/* ===========================
   V3) Server Memory Store (in-memory, cookie session)
   =========================== */

const SESSION_COOKIE = "cachey_sid";
const MEMORY_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

type MemoryFilters = {
  service: "all" | "live" | "vod";
  region: string; // "all" or specific
  pop: string; // "all" or specific
  windowMinutes: number;
  partner: string | null; // clickhouse only
};

type ChatMemory = {
  updatedAt: number;
  lastFilters: MemoryFilters;
  awaitingPartner: boolean;
};

declare global {
  // eslint-disable-next-line no-var
  var __cacheyMemoryStore: Map<string, ChatMemory> | undefined;
}

function getStore() {
  if (!globalThis.__cacheyMemoryStore) {
    globalThis.__cacheyMemoryStore = new Map<string, ChatMemory>();
  }
  return globalThis.__cacheyMemoryStore;
}

function nowMs() {
  return Date.now();
}

function genSid() {
  const g: any = globalThis as any;
  if (g?.crypto?.randomUUID) return g.crypto.randomUUID();
  return `sid_${Math.random().toString(16).slice(2)}_${Date.now()}`;
}

function defaultMemory(): ChatMemory {
  return {
    updatedAt: nowMs(),
    lastFilters: {
      service: "all",
      region: "all",
      pop: "all",
      windowMinutes: 60,
      partner: null,
    },
    awaitingPartner: false,
  };
}

function loadMemory(sid: string): ChatMemory {
  const store = getStore();

  // light TTL cleanup (bounded)
  let swept = 0;
  for (const [k, v] of store.entries()) {
    if (nowMs() - v.updatedAt > MEMORY_TTL_MS) {
      store.delete(k);
      swept++;
      if (swept >= 25) break;
    }
  }

  const cur = store.get(sid);
  if (cur) return cur;

  const m = defaultMemory();
  store.set(sid, m);
  return m;
}

function saveMemory(sid: string, mem: ChatMemory) {
  mem.updatedAt = nowMs();
  getStore().set(sid, mem);
}

/* ===========================
   Cookie helpers (Route Handlers-safe)
   =========================== */

function parseCookieHeader(cookieHeader: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!cookieHeader) return out;
  const parts = cookieHeader.split(";");
  for (const part of parts) {
    const [k, ...rest] = part.trim().split("=");
    if (!k) continue;
    out[k] = decodeURIComponent(rest.join("=") || "");
  }
  return out;
}

function getSidFromRequest(req: Request): { sid: string; shouldSetCookie: boolean } {
  const jar = parseCookieHeader(req.headers.get("cookie"));
  const existing = jar[SESSION_COOKIE];
  if (existing) return { sid: existing, shouldSetCookie: false };
  return { sid: genSid(), shouldSetCookie: true };
}

function attachSidCookie<T extends object>(
  res: NextResponse<T>,
  sid: string,
  shouldSetCookie: boolean
) {
  if (!shouldSetCookie) return res;
  res.cookies.set(SESSION_COOKIE, sid, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: Math.floor(MEMORY_TTL_MS / 1000),
  });
  return res;
}

function jsonWithSid<T extends object>(
  payload: T,
  sid: string,
  shouldSetCookie: boolean,
  init?: { status?: number }
) {
  const res = NextResponse.json(payload, { status: init?.status ?? 200 });
  return attachSidCookie(res, sid, shouldSetCookie);
}

/* ===========================
   0) General FAQ intercepts (local, no LLM)
   =========================== */

function isGreetingOnly(text: string) {
  const t = stripPunctAndSpaces(text);
  if (!t) return false;
  return /^(hi|hello|hey|yo|sup|whats up|what's up|hey there|gm|good morning|good afternoon|good evening)( there)?$/.test(
    t
  );
}

function isNameQuestion(text: string) {
  const t = stripPunctAndSpaces(text);
  return /\b(your name|who are you|what are you)\b/.test(t) || t === "name";
}

function isCapabilitiesQuestion(text: string) {
  const t = stripPunctAndSpaces(text);
  return /\b(what can you do|what do you do|help me with|what r u able to do|what are you capable of)\b/.test(
    t
  );
}

function isCacheyMisspell(text: string) {
  const t = stripPunctAndSpaces(text);
  return /\b(cachey|chacey|chacy|cachy)\b/.test(t);
}

function assistantHasSpoken(msgs: ChatMsg[]) {
  return msgs.some((m) => m.role === "assistant");
}

function faqGeneralReply(text: string, msgs: ChatMsg[]): string | null {
  const raw = String(text ?? "").trim();
  const t = stripPunctAndSpaces(raw);
  if (!t) return null;

  const alreadyIntroduced = assistantHasSpoken(msgs);

  if (isGreetingOnly(raw)) {
    if (!alreadyIntroduced) {
      return `Hey — I’m Cachey 🤖. Tell me what to check (live/vod, region/POP, last 30m) and I’ll help you triage.`;
    }
    return `All good — what are we looking at?`;
  }

  if (/^(hi|hello|hey|yo|gm)\b/.test(t) && isCacheyMisspell(raw)) {
    return alreadyIntroduced
      ? `All good — what do you want to check?`
      : `Hey — I’m Cachey 🤖. Tell me what to check (live/vod, region/POP, last 30m) and I’ll help you triage.`;
  }

  if (isCacheyMisspell(raw) && t.length <= 12) {
    return alreadyIntroduced
      ? `Yep — what do you want to check?`
      : `Yep — Cachey 🤖. What are we looking at?`;
  }

  if (isNameQuestion(raw)) return `I’m Cachey 🤖.`;

  if (isCapabilitiesQuestion(raw)) {
    return `I can help you triage CDN issues: summarize errors/latency/traffic, narrow by live/vod + region/POP + time window, and suggest next checks. Ask like “live Boston last 30m”.`;
  }

  return null;
}

/* ===========================
   Partner extraction + local shortcuts
   =========================== */

function extractPartnerFromText(text: string): string | null {
  const t = String(text || "").trim();
  const m =
    t.match(/\buse\s+([a-zA-Z0-9_-]+)\b/i) ||
    t.match(/\bpartner\s*[:=]?\s*([a-zA-Z0-9_-]+)\b/i);
  return m?.[1] ? m[1].trim() : null;
}

function parseWindowShortcutToMinutes(text: string): number | null {
  const t = stripPunctAndSpaces(text);

  const m =
    t.match(
      /\b(last|past)\s+(\d+)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours)\b/
    ) || t.match(/\b(\d+)\s*(m|min|mins|h|hr|hrs)\b/);

  if (!m) return null;

  // if it's the "last/past" match, number is in group 2; otherwise group 1
  const n = Number(m[2] ?? m[1]);
  const unit = String(m[3] ?? m[2] ?? "").toLowerCase();
  if (!Number.isFinite(n) || n <= 0) return null;

  if (unit.startsWith("h")) return n * 60;
  return n;
}

function applyLocalShortcuts(text: string): {
  forceTriage: boolean;
  patch: Partial<MemoryFilters>;
} {
  const t = stripPunctAndSpaces(text);

  if (/^(same|again|run|rerun|go|triage|do it)$/.test(t)) {
    return { forceTriage: true, patch: {} };
  }

  const patch: Partial<MemoryFilters> = {};
  let forceTriage = false;

  if (/\bvod\b/.test(t)) {
    patch.service = "vod";
    forceTriage = true;
  }
  if (/\blive\b/.test(t)) {
    patch.service = "live";
    forceTriage = true;
  }

  const win = parseWindowShortcutToMinutes(t);
  if (win != null) {
    patch.windowMinutes = win;
    forceTriage = true;
  }

  return { forceTriage, patch };
}

/* ===========================
   triage detector
   =========================== */
function looksLikeTriageText(text: string) {
  const t = String(text || "").toLowerCase().trim();
  if (!t) return false;

  if (/^(same|again|run|rerun|go|triage|do it)$/.test(stripPunctAndSpaces(t))) return true;

  if (
    t.includes("service=") ||
    t.includes("svc=") ||
    t.includes("region=") ||
    t.includes("pop=") ||
    t.includes("win=") ||
    t.includes("window=")
  )
    return true;

  const timey =
    /\b(last|past)\s+\d+\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)\b/.test(
      t
    ) || /\b\d+\s*(m|min|mins|h|hr|hrs|d)\b/.test(t);

  const strong = [
    "vod",
    "live",
    "5xx",
    "4xx",
    "errors",
    "error rate",
    "p95",
    "p99",
    "ttms",
    "latency",
    "status",
    "crc",
    "host",
    "triage",
    "run",
  ];

  const hasStrong = strong.some((k) => t.includes(k));
  return hasStrong || timey;
}

function getModels(): string[] {
  const raw = process.env.OPENROUTER_MODELS || "";
  const list = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  return list.length
    ? list
    : [
        "google/gemma-3n-e2b-it:free",
        "meta-llama/llama-3.2-3b-instruct:free",
        "mistralai/mistral-small-3.1-24b-instruct:free",
      ];
}

function modelDisallowsSystem(model: string) {
  return model.startsWith("google/gemma-3n-");
}

function buildSystemPrompt(mode: "csv" | "clickhouse", ctx?: ChatRequest["context"]) {
  const regions = (ctx?.availableRegions ?? []).slice(0, 200);
  const pops = (ctx?.availablePops ?? []).slice(0, 200);
  const partners = (ctx?.availablePartners ?? []).slice(0, 200);

  return `
You are Cachey 🤖, a strict parser for a CDN incident triage chatbot.
Extract filter hints from the user's message and output ONLY valid JSON.

Return JSON with EXACT keys:
{
  "serviceHint": "all" | "live" | "vod" | null,
  "regionHint": string | "all" | null,
  "popHint": string | "all" | null,
  "windowHint": number | null,
  "partnerHint": string | null,
  "needsPartnerQuestion": boolean,
  "partnerQuestion": string | null
}

Rules:
- If user doesn't specify a field, set it to null (do not guess).
- "windowHint" is in minutes (e.g., "last 30m" => 30, "past 2 hours" => 120).
- serviceHint allowed: live, vod, all only.
- If user says "all regions"/"any region" => regionHint="all". Same for pop.

Mode rules:
- If mode is "csv": partnerHint=null, needsPartnerQuestion=false, partnerQuestion=null.
- If mode is "clickhouse" and partner is required but missing: needsPartnerQuestion=true and partnerQuestion is a short question asking which partner to use.

Context lists (may be empty):
regions: ${JSON.stringify(regions)}
pops: ${JSON.stringify(pops)}
partners: ${JSON.stringify(partners)}

Important:
- Output ONLY JSON. No prose. No markdown.
`.trim();
}

function buildGeneralPrompt() {
  return `
You are Cachey 🤖, a calm CDN incident triage assistant inside a web app.

Rules (STRICT):
- Your name is "Cachey" (never mention internal ownership like "Krishna's assistant").
- Keep replies 1–2 sentences max.
- Do NOT claim you actively change infrastructure or "optimize apps by caching data".
- Focus on triage: errors, latency, traffic, service (live/vod), region, POP, time windows.
- Ask at most ONE follow-up question only if needed.

Humor rule:
- Add subtle humor ONLY when the user is casual AND the situation sounds healthy/normal.
- If anything sounds degraded, be serious and direct.
`.trim();
}

function sanitizeGeneralReply(text: string) {
  let s = String(text ?? "").trim();

  if (/^\s*i\s*(am|'m)\s*cachey\b/i.test(s)) return s;

  s = s
    .replace(
      /^(hey there|hey|hi|hello|yo|sup|what's up|whats up|good morning|good afternoon|good evening)[!,. ]+/i,
      ""
    )
    .trim();

  s = s
    .replace(
      /^(i\s*(am|'m)\s*(krishna'?s\s*)?(your\s*)?(personal\s*)?(cdn\s*)?(triage\s*)?(assistant|bot|chatbot|helper|sidekick)\b[\s\p{Emoji}\u200d\uFE0F]*[!,. ]*)/iu,
      ""
    )
    .trim();
  s = s
    .replace(
      /^(i\s*(am|'m)\s*cachey\b[\s\p{Emoji}\u200d\uFE0F]*[!,. ]*)/iu,
      ""
    )
    .trim();

  s = s.replace(/^[\p{Emoji}\u200d\uFE0F\s]+/gu, "").trim();

  const parts = s.split(/(?<=[.!?])\s+/).filter(Boolean);
  s = parts.slice(0, 2).join(" ").trim();

  if (!s) s = "What do you want to check?";
  return s;
}

function normalizeHints(raw: any, mode: "csv" | "clickhouse"): Omit<HintsResponse, "kind" | "_debug"> {
  const res: any = { ...DEFAULT_TRIAGE };

  const svc = String(raw?.serviceHint ?? "").trim().toLowerCase();
  if (svc === "live" || svc === "vod" || svc === "all") res.serviceHint = svc;

  const region = raw?.regionHint;
  if (region != null && String(region).trim() !== "") res.regionHint = String(region).trim();

  const pop = raw?.popHint;
  if (pop != null && String(pop).trim() !== "") res.popHint = String(pop).trim();

  const w = raw?.windowHint;
  if (w != null && String(w).trim() !== "") {
    const n = Number(w);
    if (Number.isFinite(n) && n > 0) res.windowHint = Math.round(n);
  }

  const partner = raw?.partnerHint;
  if (partner != null && String(partner).trim() !== "") res.partnerHint = String(partner).trim();

  if (mode === "csv") {
    res.partnerHint = null;
    res.needsPartnerQuestion = false;
    res.partnerQuestion = null;
  } else {
    res.needsPartnerQuestion = Boolean(raw?.needsPartnerQuestion);
    res.partnerQuestion = raw?.partnerQuestion ? String(raw.partnerQuestion) : null;
  }

  return res;
}

function mergeWithMemory(
  mode: "csv" | "clickhouse",
  mem: ChatMemory,
  hints: Omit<HintsResponse, "kind" | "_debug">,
  localPatch?: Partial<MemoryFilters>
) {
  const base = mem.lastFilters;

  const merged: MemoryFilters = {
    service: (localPatch?.service as any) || (hints.serviceHint as any) || base.service || "all",
    region: (localPatch?.region as any) || (hints.regionHint as any) || base.region || "all",
    pop: (localPatch?.pop as any) || (hints.popHint as any) || base.pop || "all",
    windowMinutes:
      (localPatch?.windowMinutes as any) || (hints.windowHint as any) || base.windowMinutes || 60,
    partner:
      mode === "clickhouse"
        ? (localPatch?.partner as any) || hints.partnerHint || base.partner || null
        : null,
  };

  mem.lastFilters = merged;

  const out: Omit<HintsResponse, "kind" | "_debug"> = {
    kind: "triage",
    serviceHint: merged.service,
    regionHint: merged.region,
    popHint: merged.pop,
    windowHint: merged.windowMinutes,
    partnerHint: mode === "clickhouse" ? merged.partner : null,
    needsPartnerQuestion: false,
    partnerQuestion: null,
  };

  return out;
}

async function callOpenRouter(args: {
  model: string;
  messages: ChatMsg[];
  systemPrompt: string;
  temperature: number;
  maxTokens?: number;
}) {
  const { model, messages, systemPrompt, temperature, maxTokens } = args;

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("Missing OPENROUTER_API_KEY");

  const siteUrl = process.env.OPENROUTER_SITE_URL || "http://localhost:3000";
  const appName = process.env.OPENROUTER_APP_NAME || "cdn-triage-bot";

  const finalMessages = modelDisallowsSystem(model)
    ? [
        {
          role: "user" as const,
          content:
            `${systemPrompt}\n\nConversation:\n` +
            messages.map((m) => `${m.role.toUpperCase()}: ${m.content}`).join("\n"),
        },
      ]
    : [{ role: "system" as const, content: systemPrompt }, ...messages];

  const payload: any = { model, temperature, messages: finalMessages };
  if (typeof maxTokens === "number") payload.max_tokens = maxTokens;

  const maxRetries429 = 2;

  for (let attempt = 0; attempt <= maxRetries429; attempt++) {
    const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": siteUrl,
        "X-Title": appName,
      },
      body: JSON.stringify(payload),
    });

    const text = await r.text();

    if (r.ok) {
      const json = safeJsonParse(text) ?? {};
      return String(json?.choices?.[0]?.message?.content ?? "");
    }

    if (r.status === 429 && attempt < maxRetries429) {
      await sleep(500 * Math.pow(2, attempt));
      continue;
    }

    throw new Error(`OpenRouter ${r.status} (${model}): ${text}`);
  }

  throw new Error(`OpenRouter 429 (${model}): retries exhausted`);
}

export async function POST(req: Request) {
  const { sid, shouldSetCookie } = getSidFromRequest(req);
  const keyPresent = !!process.env.OPENROUTER_API_KEY;

  try {
    const mem = loadMemory(sid);

    const body = (await req.json().catch(() => null)) as ChatRequest | null;
    if (!body || !Array.isArray(body.messages)) {
      return jsonWithSid(
        { ok: false, error: "Bad request: missing messages[]" },
        sid,
        shouldSetCookie,
        { status: 400 }
      );
    }

    const msgs = (body.messages ?? []).slice(-12);
    const lastUser = [...msgs].reverse().find((m) => m.role === "user")?.content || "";

    const mode = body?.context?.mode === "clickhouse" ? "clickhouse" : "csv";
    const models = getModels();
    const failures: { model: string; error: string }[] = [];

    const allowedPartners = new Set((body.context?.availablePartners ?? []).map(normalizeToken));

    // awaiting partner flow
    if (mode === "clickhouse" && mem.awaitingPartner) {
      const candidate = String(lastUser || "").trim();
      const candNorm = normalizeToken(candidate);

      if (candidate && (allowedPartners.size === 0 || allowedPartners.has(candNorm))) {
        mem.lastFilters.partner = candidate;
        mem.awaitingPartner = false;
        saveMemory(sid, mem);

        const merged: HintsResponse = {
          kind: "triage",
          serviceHint: mem.lastFilters.service,
          regionHint: mem.lastFilters.region,
          popHint: mem.lastFilters.pop,
          windowHint: mem.lastFilters.windowMinutes,
          partnerHint: candidate,
          needsPartnerQuestion: false,
          partnerQuestion: null,
          _debug: { keyPresent, modelUsed: "local-partner-accept", sid },
        };

        return jsonWithSid(merged, sid, shouldSetCookie);
      }

      const example = (body.context?.availablePartners ?? []).slice(0, 6).join(", ");
      const reprompt: HintsResponse = {
        ...DEFAULT_TRIAGE,
        kind: "triage",
        serviceHint: mem.lastFilters.service,
        regionHint: mem.lastFilters.region,
        popHint: mem.lastFilters.pop,
        windowHint: mem.lastFilters.windowMinutes,
        partnerHint: null,
        needsPartnerQuestion: true,
        partnerQuestion: `Pick a partner from: ${example || "acme_media, beta_stream"}`,
        _debug: { keyPresent, modelUsed: "local-partner-reprompt", sid },
      };

      return jsonWithSid(reprompt, sid, shouldSetCookie);
    }

    // local shortcuts patch
    const shortcut = applyLocalShortcuts(lastUser);
    if (shortcut.patch && Object.keys(shortcut.patch).length) {
      mem.lastFilters = { ...mem.lastFilters, ...shortcut.patch };
      saveMemory(sid, mem);
    }

    // GENERAL CHAT
    if (!looksLikeTriageText(lastUser) && !shortcut.forceTriage) {
      const canned = faqGeneralReply(lastUser, msgs);
      if (canned) {
        const out: GeneralResponse = {
          kind: "general",
          reply: canned,
          _debug: { keyPresent, modelUsed: "local-faq", failures, sid },
        };
        return jsonWithSid(out, sid, shouldSetCookie);
      }

      const generalPrompt = buildGeneralPrompt();

      for (const model of models) {
        try {
          const reply = await callOpenRouter({
            model,
            messages: msgs,
            systemPrompt: generalPrompt,
            temperature: 0.75,
            maxTokens: 180,
          });

          const out: GeneralResponse = {
            kind: "general",
            reply: sanitizeGeneralReply(reply),
            _debug: { keyPresent, modelUsed: model, failures, sid },
          };
          return jsonWithSid(out, sid, shouldSetCookie);
        } catch (e: any) {
          failures.push({ model, error: e?.message || String(e) });
        }
      }

      const out: GeneralResponse = {
        kind: "general",
        reply: "I got rate-limited for a sec — try again.",
        _debug: { keyPresent, failures, sid },
      };
      return jsonWithSid(out, sid, shouldSetCookie);
    }

    // TRIAGE PARSER
    const systemPrompt = buildSystemPrompt(mode, body.context);
    const partnerFromRegex = extractPartnerFromText(lastUser);

    for (const model of models) {
      try {
        const llmText = await callOpenRouter({
          model,
          messages: msgs,
          systemPrompt,
          temperature: 0,
          maxTokens: 220,
        });

        let parsed = safeJsonParse(llmText);
        if (!parsed) {
          const start = llmText.indexOf("{");
          const end = llmText.lastIndexOf("}");
          if (start >= 0 && end > start) parsed = safeJsonParse(llmText.slice(start, end + 1));
        }

        if (!parsed) {
          failures.push({ model, error: "non_json" });
          continue;
        }

        let normalized = normalizeHints(parsed, mode);

        // partner override from regex
        if (mode === "clickhouse" && partnerFromRegex) {
          const p = normalizeToken(partnerFromRegex);
          if (allowedPartners.size === 0 || allowedPartners.has(p)) {
            normalized.partnerHint = partnerFromRegex.trim();
            normalized.needsPartnerQuestion = false;
            normalized.partnerQuestion = null;
          }
        }

        const merged = mergeWithMemory(mode, mem, normalized);
        saveMemory(sid, mem);

        // missing partner => ask
        if (mode === "clickhouse" && !mem.lastFilters.partner) {
          mem.awaitingPartner = true;
          saveMemory(sid, mem);

          const example = (body.context?.availablePartners ?? []).slice(0, 6);
          const out: HintsResponse = {
            ...merged,
            partnerHint: null,
            needsPartnerQuestion: true,
            partnerQuestion:
              normalized.partnerQuestion ||
              `Which partner should I use? (e.g., ${example.length ? example.join(", ") : "acme_media"})`,
            _debug: { keyPresent, modelUsed: model, failures, sid, awaitingPartner: true },
          };

          return jsonWithSid(out, sid, shouldSetCookie);
        }

        mem.awaitingPartner = false;
        saveMemory(sid, mem);

        const out: HintsResponse = {
          ...merged,
          _debug: { keyPresent, modelUsed: model, failures, sid, memory: mem.lastFilters },
        };
        return jsonWithSid(out, sid, shouldSetCookie);
      } catch (e: any) {
        failures.push({ model, error: e?.message || String(e) });
      }
    }

    // all models failed — return memory
    const fallback: HintsResponse = {
      kind: "triage",
      serviceHint: mem.lastFilters.service,
      regionHint: mem.lastFilters.region,
      popHint: mem.lastFilters.pop,
      windowHint: mem.lastFilters.windowMinutes,
      partnerHint: mode === "clickhouse" ? mem.lastFilters.partner : null,
      needsPartnerQuestion: false,
      partnerQuestion: null,
      _debug: { keyPresent, failures, error: "all_models_failed", sid },
    };

    if (mode === "clickhouse" && !mem.lastFilters.partner) {
      mem.awaitingPartner = true;
      saveMemory(sid, mem);
      const example = (body.context?.availablePartners ?? []).slice(0, 6).join(", ");
      fallback.needsPartnerQuestion = true;
      fallback.partnerQuestion = `Which partner should I use? (e.g., ${example || "acme_media, beta_stream"})`;
    }

    return jsonWithSid(fallback, sid, shouldSetCookie);
  } catch (e: any) {
    const out: HintsResponse = {
      ...DEFAULT_TRIAGE,
      kind: "triage",
      _debug: {
        keyPresent,
        error: e?.message || String(e),
        sid,
      },
    };
    return jsonWithSid(out, sid, shouldSetCookie, { status: 500 });
  }
}

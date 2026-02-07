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

function isGreetingOnly(text: string) {
  const t = stripPunctAndSpaces(text);
  if (!t) return false;
  return /^(hi|hello|hey|yo|sup|whats up|what's up|hey there|gm|good morning|good afternoon|good evening)( there)?$/.test(
    t
  );
}

/* ===========================
   0) General FAQ intercepts (local, no LLM)
   - prevents generic / identity drift
   - avoids repeating intro after first assistant message
   =========================== */
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
  // handles: cachey, chacey, chacy, cachy
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

  // Greeting-only
  if (isGreetingOnly(raw)) {
    if (!alreadyIntroduced) {
      return `Hey — I’m Cachey 🤖. Tell me what to check (live/vod, region/POP, last 30m) and I’ll help you triage.`;
    }
    return `All good — what are we looking at?`;
  }

  // Greeting + Cachey mention
  if (/^(hi|hello|hey|yo|gm)\b/.test(t) && isCacheyMisspell(raw)) {
    return alreadyIntroduced
      ? `All good — what do you want to check?`
      : `Hey — I’m Cachey 🤖. Tell me what to check (live/vod, region/POP, last 30m) and I’ll help you triage.`;
  }

  // "Cachey?" / "chacey?"
  if (isCacheyMisspell(raw) && t.length <= 12) {
    return alreadyIntroduced
      ? `Yep — what do you want to check?`
      : `Yep — Cachey 🤖. What are we looking at?`;
  }

  if (isNameQuestion(raw)) {
    return `I’m Cachey 🤖.`;
  }

  if (isCapabilitiesQuestion(raw)) {
    return `I can help you triage CDN issues: summarize errors/latency/traffic, narrow by live/vod + region/POP + time window, and suggest next checks. Ask like “live Boston last 30m”.`;
  }

  return null;
}

// For ClickHouse: accept only UI partner names (public-safe)
function extractPartnerFromText(text: string): string | null {
  const t = String(text || "").trim();
  const m =
    t.match(/\buse\s+([a-zA-Z0-9_-]+)\b/i) ||
    t.match(/\bpartner\s*[:=]?\s*([a-zA-Z0-9_-]+)\b/i);
  return m?.[1] ? m[1].trim() : null;
}

/* ===========================
   ① Better triage detector (less trigger-happy)
   =========================== */
function looksLikeTriageText(text: string) {
  const t = String(text || "").toLowerCase().trim();
  if (!t) return false;

  // explicit kv patterns
  if (
    t.includes("service=") ||
    t.includes("svc=") ||
    t.includes("region=") ||
    t.includes("pop=") ||
    t.includes("win=") ||
    t.includes("window=")
  )
    return true;

  // time windows are triage-y only if they include units
  const timey =
    /\b(last|past)\s+\d+\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)\b/.test(
      t
    ) || /\b\d+\s*(m|min|mins|h|hr|hrs|d)\b/.test(t);

  // strong triage keywords
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
  // Some providers reject system/developer for gemma-3n variants
  return model.startsWith("google/gemma-3n-");
}

function buildSystemPrompt(
  mode: "csv" | "clickhouse",
  ctx?: ChatRequest["context"]
) {
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

/* ===========================
   ② General chat prompt (Cachey 🤖)
   - concise
   - no forced greeting
   - no ownership mention
   =========================== */
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

/* ===========================
   ③ Sanitizer: removes unwanted intros and trims to 1–2 sentences
   (keeps replies tight even if model rambles)
   =========================== */
function sanitizeGeneralReply(text: string) {
  let s = String(text ?? "").trim();

  // If the reply is basically just the name, keep it
  if (/^\s*i\s*(am|'m)\s*cachey\b/i.test(s)) return s;

  // Remove greeting prefixes if they sneak in (we handle greetings locally)
  s = s.replace(
    /^(hey there|hey|hi|hello|yo|sup|what's up|whats up|good morning|good afternoon|good evening)[!,. ]+/i,
    ""
  ).trim();

  // Remove self-intro prefixes
  // Examples:
  // "I am Krishna's CDN assistant..."
  // "I'm your CDN assistant..."
  // "I am Cachey 🤖..."
  s = s.replace(
    /^(i\s*(am|'m)\s*(krishna'?s\s*)?(your\s*)?(personal\s*)?(cdn\s*)?(triage\s*)?(assistant|bot|chatbot|helper|sidekick)\b[\s\p{Emoji}\u200d\uFE0F]*[!,. ]*)/iu,
    ""
  ).trim();
  s = s.replace(
    /^(i\s*(am|'m)\s*cachey\b[\s\p{Emoji}\u200d\uFE0F]*[!,. ]*)/iu,
    ""
  ).trim();

  // Remove leading emojis/waves/etc
  s = s.replace(/^[\p{Emoji}\u200d\uFE0F\s]+/gu, "").trim();

  // Keep it short: 1–2 sentences max
  const parts = s.split(/(?<=[.!?])\s+/).filter(Boolean);
  s = parts.slice(0, 2).join(" ").trim();

  if (!s) s = "What do you want to check?";
  return s;
}

function normalizeHints(
  raw: any,
  mode: "csv" | "clickhouse"
): Omit<HintsResponse, "kind" | "_debug"> {
  const out = { ...DEFAULT_TRIAGE };
  const res: any = {
    serviceHint: null,
    regionHint: null,
    popHint: null,
    windowHint: null,
    partnerHint: null,
    needsPartnerQuestion: false,
    partnerQuestion: null,
  };

  const svc = String(raw?.serviceHint ?? "").trim().toLowerCase();
  if (svc === "live" || svc === "vod" || svc === "all") res.serviceHint = svc;

  const region = raw?.regionHint;
  if (region != null && String(region).trim() !== "")
    res.regionHint = String(region).trim();

  const pop = raw?.popHint;
  if (pop != null && String(pop).trim() !== "")
    res.popHint = String(pop).trim();

  const w = raw?.windowHint;
  if (w != null && String(w).trim() !== "") {
    const n = Number(w);
    if (Number.isFinite(n) && n > 0) res.windowHint = Math.round(n);
  }

  const partner = raw?.partnerHint;
  if (partner != null && String(partner).trim() !== "")
    res.partnerHint = String(partner).trim();

  if (mode === "csv") {
    res.partnerHint = null;
    res.needsPartnerQuestion = false;
    res.partnerQuestion = null;
  } else {
    res.needsPartnerQuestion = Boolean(raw?.needsPartnerQuestion);
    res.partnerQuestion = raw?.partnerQuestion
      ? String(raw.partnerQuestion)
      : null;
  }

  return {
    ...out,
    ...res,
  };
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

  // If model disallows system: put instructions + convo into one user msg
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

  // retry 429s a bit (free models rate-limit a lot)
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
  const keyPresent = !!process.env.OPENROUTER_API_KEY;

  try {
    const body = (await req.json()) as ChatRequest;
    const msgs = (body.messages ?? []).slice(-12);

    // Use the LAST user message for routing (general vs triage)
    const lastUser =
      [...msgs].reverse().find((m) => m.role === "user")?.content || "";

    const models = getModels();
    const failures: { model: string; error: string }[] = [];

    /* ===========================
       GENERAL CHAT PATH
       - local FAQ intercept (identity/capabilities/greetings)
       - otherwise LLM with a little higher temp
       =========================== */
    if (!looksLikeTriageText(lastUser)) {
      const canned = faqGeneralReply(lastUser, msgs);
      if (canned) {
        return NextResponse.json({
          kind: "general",
          reply: canned,
          _debug: { keyPresent, modelUsed: "local-faq", failures },
        } satisfies GeneralResponse);
      }

      const generalPrompt = buildGeneralPrompt();

      for (const model of models) {
        try {
          const reply = await callOpenRouter({
            model,
            messages: msgs,
            systemPrompt: generalPrompt,
            temperature: 0.75, // 👈 a little higher than 0.5
            maxTokens: 180,
          });

          return NextResponse.json({
            kind: "general",
            reply: sanitizeGeneralReply(reply),
            _debug: { keyPresent, modelUsed: model, failures },
          } satisfies GeneralResponse);
        } catch (e: any) {
          failures.push({ model, error: e?.message || String(e) });
        }
      }

      return NextResponse.json({
        kind: "general",
        reply: "I got rate-limited for a sec — try again.",
        _debug: { keyPresent, failures },
      } satisfies GeneralResponse);
    }

    /* ===========================
       TRIAGE PARSER PATH (strict)
       =========================== */
    const mode = body?.context?.mode === "clickhouse" ? "clickhouse" : "csv";
    const systemPrompt = buildSystemPrompt(mode, body.context);

    const allowedPartners = new Set(
      (body.context?.availablePartners ?? []).map(normalizeToken)
    );
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

        // Expect JSON-only; salvage if model adds text
        let parsed = safeJsonParse(llmText);
        if (!parsed) {
          const start = llmText.indexOf("{");
          const end = llmText.lastIndexOf("}");
          if (start >= 0 && end > start) {
            parsed = safeJsonParse(llmText.slice(start, end + 1));
          }
        }

        if (!parsed) {
          failures.push({ model, error: "non_json" });
          continue;
        }

        let normalized = normalizeHints(parsed, mode);

        // Partner override from regex (ClickHouse only, UI partner names only)
        if (mode === "clickhouse" && partnerFromRegex) {
          const p = normalizeToken(partnerFromRegex);
          if (allowedPartners.size === 0 || allowedPartners.has(p)) {
            normalized.partnerHint = partnerFromRegex.trim();
            normalized.needsPartnerQuestion = false;
            normalized.partnerQuestion = null;
          }
        }

        // Enforce partner follow-up (ClickHouse only)
        if (mode === "clickhouse" && !normalized.partnerHint) {
          const partnerOptions = (body.context?.availablePartners ?? []).slice(0, 6);
          const example = partnerOptions.length
            ? partnerOptions.join(", ")
            : "acme_media, beta_stream";

          normalized.needsPartnerQuestion = true;
          normalized.partnerQuestion =
            normalized.partnerQuestion || `Which partner should I use? (e.g., ${example})`;
        }

        const out: HintsResponse = {
          kind: "triage",
          ...normalized,
          _debug: {
            keyPresent,
            modelUsed: model,
            failures,
            partnerFromRegex,
          },
        };

        return NextResponse.json(out);
      } catch (e: any) {
        failures.push({ model, error: e?.message || String(e) });
      }
    }

    // all models failed
    return NextResponse.json({
      ...DEFAULT_TRIAGE,
      kind: "triage",
      _debug: { keyPresent, failures, error: "all_models_failed" },
    } satisfies HintsResponse);
  } catch (e: any) {
    return NextResponse.json({
      ...DEFAULT_TRIAGE,
      kind: "triage",
      _debug: {
        keyPresent: !!process.env.OPENROUTER_API_KEY,
        error: e?.message || String(e),
      },
    } satisfies HintsResponse);
  }
}

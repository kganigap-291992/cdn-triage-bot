// app/api/chat/route.ts
import { NextResponse } from "next/server";

type Role = "system" | "user" | "assistant";
type WireMsg = { role: Role; content: string };

type ChatContext = {
  mode?: "csv" | "clickhouse";
  availableRegions?: string[];
  availablePops?: string[];
  availablePartners?: string[];
};

type Body = {
  reset?: boolean;
  messages?: WireMsg[];
  context?: ChatContext;
};

function jsonOk(data: any, status = 200) {
  return NextResponse.json(data, { status });
}

function norm(s: any) {
  return String(s ?? "").trim();
}
function normLower(s: any) {
  return norm(s).toLowerCase();
}

// deterministic-ish variety without needing persistent memory
function hash32(str: string) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function pickOne<T>(arr: T[], seed: string) {
  if (!arr.length) throw new Error("pickOne called with empty array");
  const idx = hash32(seed + "|" + String(Date.now()).slice(0, 9)) % arr.length;
  return arr[idx];
}

function isGreetingOrSmallTalk(text: string) {
  const t = normLower(text);
  if (!t) return true;
  if (t.length <= 3) return ["hi", "hey", "yo", "ok", "k"].includes(t);
  return (
    /^hi\b/.test(t) ||
    /^hey\b/.test(t) ||
    /^hello\b/.test(t) ||
    /^yo\b/.test(t) ||
    /^thanks\b/.test(t) ||
    /^thank you\b/.test(t) ||
    /^good (morning|afternoon|evening)\b/.test(t) ||
    /^how are you\b/.test(t) ||
    /^sup\b/.test(t) ||
    /^what'?s up\b/.test(t) ||
    /^how's it going\b/.test(t) ||
    /^how are ya\b/.test(t)
  );
}

// -------- Command handling (NO LLM) --------
type CommandKind = "help" | "filters" | "reset" | "explain" | "run" | null;

function parseCommand(text: string): CommandKind {
  const t = normLower(text);
  if (!t) return null;

  // ✅ Treat capability questions as help (avoids LLM hiccup loops)
  if (
    t === "help" ||
    t === "?" ||
    t.startsWith("help ") ||
    t.includes("what can you do") ||
    t.includes("what do you do") ||
    t.includes("your capabilities") ||
    t.includes("how do i use") ||
    t.includes("how to use") ||
    t.includes("commands") ||
    t.includes("what are the commands")
  ) {
    return "help";
  }

  if (
    t === "filters" ||
    t === "show filters" ||
    t === "show filter" ||
    t === "current filters"
  )
    return "filters";

  if (t === "reset" || t === "clear" || t === "start over" || t === "wipe")
    return "reset";

  if (t === "explain" || t.startsWith("explain ") || t.includes("what is this"))
    return "explain";

  if (t === "run" || t === "triage" || t === "go" || t === "execute")
    return "run";

  return null;
}

// ✅ Updated: more concierge/sophisticated receptionist tone
function helpText(mode: "csv" | "clickhouse") {
  const lines = [
    "Certainly — here’s how I can help.",
    "",
    "I can run CDN triage using your filters (service / region / pop / time window), then show charts + a concise summary.",
    "",
    "Examples:",
    "- `vod in bos last 1 day`",
    "- `live in usw2 at sjc last 2h`",
    "- `service=live region=usw2 pop=all win=360`",
    "",
    "Commands: help • filters • explain • reset • run",
    "",
    mode === "clickhouse"
      ? "ClickHouse note: I’ll need a partner (ex: `partner=acme_media`)."
      : "CSV note: I’ll use your uploaded CSV or CSV URL.",
  ];
  return lines.join("\n");
}

function filtersText(args: {
  mode: "csv" | "clickhouse";
  partners: string[];
  regions: string[];
  pops: string[];
}) {
  const { mode, partners, regions, pops } = args;

  const p = partners?.length ? partners.slice(0, 25).join(", ") : "(none)";
  const r = regions?.length ? regions.slice(0, 25).join(", ") : "(none)";
  const po = pops?.length ? pops.slice(0, 25).join(", ") : "(none)";

  return [
    `Mode: ${mode}`,
    "",
    `Partners: ${p}${partners.length > 25 ? " …" : ""}`,
    `Regions: ${r}${regions.length > 25 ? " …" : ""}`,
    `POPs: ${po}${pops.length > 25 ? " …" : ""}`,
  ].join("\n");
}

function explainText() {
  return [
    "Quick explainer:",
    "",
    "Cachey does two things:",
    "1) Parses your message into filters (service/region/pop/window/partner).",
    "2) Runs triage and shows metrics + charts for that scope.",
    "",
    "Tip: natural language works (`vod in bos last 1 day`) or key=value works (`service=vod region=bos win=1440`).",
  ].join("\n");
}

// -------- Partner follow-up helpers --------
function isLikelyPartnerReply(text: string, partners: string[]) {
  const t = normLower(text);
  if (!t) return false;
  return partners.map((p) => p.toLowerCase()).includes(t);
}

function looksLikePartnerQuestion(text: string) {
  const t = normLower(text);
  return (
    t.includes("which partner") ||
    t.includes("pick a partner") ||
    t.includes("partner should i use")
  );
}

function looksLikeTriageIntent(text: string) {
  const t = normLower(text);
  if (!t) return false;
  if (t.includes("=")) return true;
  const kws = [
    "triage",
    "run",
    "status",
    "errors",
    "p95",
    "p99",
    "ttms",
    "latency",
    "vod",
    "live",
    "region",
    "pop",
    "last",
    "past",
  ];
  return kws.some((k) => t.includes(k));
}

function extractService(text: string): string | null {
  const t = normLower(text);
  const m1 = t.match(/\b(service|svc)\s*=\s*(all|live|vod)\b/);
  if (m1?.[2]) return m1[2];
  const m2 = t.match(/\b(all|live|vod)\b/);
  return m2?.[1] ?? null;
}

function extractWindowMinutes(text: string): number | null {
  const t = normLower(text);

  const m = t.match(
    /\b(last|past)\s+(\d+)\s*(d|day|days|h|hr|hrs|hour|hours|m|min|mins|minute|minutes)\b/
  );
  if (m) {
    const n = Number(m[2]);
    if (!Number.isFinite(n) || n <= 0) return null;
    const unit = m[3];
    if (unit.startsWith("d")) return n * 1440;
    if (unit.startsWith("h")) return n * 60;
    return n;
  }

  const m2 = t.match(
    /\b(win|window)\s*(=|\s)\s*(\d+)\s*(d|day|days|h|hr|hrs|hour|hours|m|min|mins|minute|minutes)?\b/
  );
  if (m2) {
    const n = Number(m2[3]);
    if (!Number.isFinite(n) || n <= 0) return null;
    const unit = m2[4] || "m";
    if (unit.startsWith("d")) return n * 1440;
    if (unit.startsWith("h")) return n * 60;
    return n;
  }

  const m3 = t.match(/\b(\d+)\s*(d|day|days)\b/);
  if (m3) {
    const n = Number(m3[1]);
    if (!Number.isFinite(n) || n <= 0) return null;
    return n * 1440;
  }

  return null;
}

const REGION_ALIASES: Record<string, string> = {
  boston: "bos",
  bos: "bos",
  newyork: "nyc",
  "new york": "nyc",
  nyc: "nyc",
  atlanta: "atl",
  atl: "atl",
  iad: "iad",
  dc: "iad",
  sanjose: "sjc",
  "san jose": "sjc",
  sjc: "sjc",
  seattle: "sea",
  sea: "sea",
  london: "lon",
  lon: "lon",
  frankfurt: "fra",
  fra: "fra",
  singapore: "sin",
  sin: "sin",
  tokyo: "tyo",
  tyo: "tyo",
  sydney: "syd",
  syd: "syd",
  use1: "use1",
  usw2: "usw2",
  eu1: "eu1",
  ap1: "ap1",
};

function extractRegion(text: string, availableRegions: string[]): string | null {
  const t = normLower(text);

  const m = t.match(/\bregion\s*=\s*([a-z0-9_\-]+)\b/);
  if (m?.[1]) return m[1];

  const m2 = t.match(/\bin\s+([a-z0-9_\-]+)\b/);
  const candidate = m2?.[1] ?? "";

  if (candidate && REGION_ALIASES[candidate]) return REGION_ALIASES[candidate];

  for (const [k, v] of Object.entries(REGION_ALIASES)) {
    if (k.includes(" ")) {
      if (t.includes(k)) return v;
    } else {
      if (new RegExp(`\\b${k}\\b`, "i").test(t)) return v;
    }
  }

  const availSet = new Set((availableRegions || []).map((x) => normLower(x)));
  if (candidate && availSet.has(candidate)) return candidate;

  return null;
}

function extractPop(text: string, availablePops: string[]): string | null {
  const t = normLower(text);

  const m = t.match(/\bpop\s*=\s*([a-z0-9_\-]+)\b/);
  if (m?.[1]) return m[1];

  const m2 = t.match(/\bat\s+([a-z0-9_\-]+)\b/);
  const candidate = m2?.[1] ?? "";
  if (!candidate) return null;

  const availSet = new Set((availablePops || []).map((x) => normLower(x)));
  if (availSet.has(candidate)) return candidate;

  if (candidate.includes("-") && candidate.length >= 5) return candidate;
  return null;
}

function extractPartner(text: string, availablePartners: string[]): string | null {
  const t = normLower(text);
  const set = new Set((availablePartners || []).map((p) => normLower(p)));
  if (set.has(t)) return t;

  const m = t.match(/\bpartner\s*=\s*([a-z0-9_\-]+)\b/);
  if (m?.[1] && set.has(m[1])) return m[1];

  return null;
}

// ✅ Updated: more receptionist/concierge phrasing
function makePartnerQuestion(partners: string[]) {
  const list = partners?.length
    ? partners.join(", ")
    : "acme_media, beta_stream, charlie_video…";
  return `Quick one — which partner are we triaging? (${list})`;
}

function collapsePartnerFollowup(messages: WireMsg[], partners: string[]) {
  const msgs = Array.isArray(messages) ? messages : [];
  if (msgs.length < 2) return { text: "", partner: null as string | null };

  const last = [...msgs].reverse().find((m) => m.role === "user");
  if (!last) return { text: "", partner: null };

  const lastUserText = norm(last.content);
  if (!isLikelyPartnerReply(lastUserText, partners))
    return { text: lastUserText, partner: null };

  const lastIdx = msgs.lastIndexOf(last);
  const prevAssistant = [...msgs.slice(0, lastIdx)]
    .reverse()
    .find((m) => m.role === "assistant");
  if (!prevAssistant || !looksLikePartnerQuestion(prevAssistant.content)) {
    return { text: lastUserText, partner: normLower(lastUserText) };
  }

  const prevUser = [...msgs.slice(0, lastIdx)]
    .reverse()
    .find((m) => m.role === "user");
  const originalQuery = norm(prevUser?.content);

  const combined = originalQuery
    ? `${originalQuery} partner=${normLower(lastUserText)}`
    : `partner=${normLower(lastUserText)}`;

  return { text: combined, partner: normLower(lastUserText) };
}

// -------- OpenRouter --------
async function callOpenRouter(messages: WireMsg[]) {
  const apiKey = process.env.OPENROUTER_API_KEY || process.env.OPENROUTER_KEY;
  if (!apiKey) throw new Error("Missing OPENROUTER_API_KEY");

  const model = process.env.OPENROUTER_MODEL || "google/gemma-3n-e2b-it:free";

  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "http://localhost:3000",
      "X-Title": "cdn-triage-bot",
    },
    body: JSON.stringify({
      model,
      temperature: 1.1,
      messages,
    }),
  });

  const json = await res.json().catch(() => null);
  if (!res.ok) {
    const msg =
      json?.error?.message || json?.message || `OpenRouter error (HTTP ${res.status})`;
    throw new Error(msg);
  }
  return json;
}

function safeJsonParse(s: string) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

// ✅ Updated: sophisticated receptionist / concierge greeting variants
function smallTalkReply(userText: string, mode: "csv" | "clickhouse") {
  const options = [
    "Good day — Cachey here 🤖. How may I assist with today’s CDN situation?",
    "Hello. I’m Cachey 🤖 — your triage concierge. What are we investigating?",
    "Welcome — Cachey at your service 🤖. Share the symptoms and I’ll narrow the scope.",
    "Hi there. If you tell me service + region/POP + a time window, I can run triage immediately.",
    "All set on my end. Shall we chase errors or latency first? (Try: `vod in bos last 60m`.)",
  ];
  return pickOne(options, userText + "|" + mode);
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as Body;

  // reset hook (page.tsx calls this best-effort)
  if (body.reset) {
    return jsonOk({ ok: true, kind: "reset" });
  }

  const rawMsgs = Array.isArray(body.messages) ? body.messages : [];
  const ctx = body.context || {};
  const partners = Array.isArray(ctx.availablePartners) ? ctx.availablePartners : [];
  const regions = Array.isArray(ctx.availableRegions) ? ctx.availableRegions : [];
  const pops = Array.isArray(ctx.availablePops) ? ctx.availablePops : [];
  const mode = ctx.mode === "clickhouse" ? "clickhouse" : "csv";

  // Handle the "partner follow-up" case cleanly
  const collapsed = collapsePartnerFollowup(rawMsgs, partners);
  const userText =
    collapsed.text ||
    norm(rawMsgs.filter((m) => m.role === "user").slice(-1)[0]?.content);

  const partnerFromFollowup = collapsed.partner;

  // ✅ Commands are deterministic (NO LLM)
  const cmd = parseCommand(userText);
  if (cmd === "help") {
    return jsonOk({ ok: true, kind: "general", reply: helpText(mode) });
  }
  if (cmd === "filters") {
    return jsonOk({
      ok: true,
      kind: "general",
      reply: filtersText({ mode, partners, regions, pops }),
    });
  }
  if (cmd === "explain") {
    return jsonOk({ ok: true, kind: "general", reply: explainText() });
  }
  if (cmd === "reset") {
    return jsonOk({
      ok: true,
      kind: "general",
      reply:
        "Done — I’ve cleared my side. If you’d like a full wipe (filters + local history), please use the Reset button in the UI.",
    });
  }
  if (cmd === "run") {
    // Let UI run triage with current filters — we just mark it triage-ish
    return jsonOk({
      ok: true,
      kind: "triage",
      reply: "Very well — running triage with the current filters…",
    });
  }

  const triageish = looksLikeTriageIntent(userText);

  // ✅ Don't burn LLM calls on greetings/small talk
  if (!triageish && isGreetingOrSmallTalk(userText)) {
    return jsonOk({
      ok: true,
      kind: "general",
      reply: smallTalkReply(userText, mode),
    });
  }

  // Deterministic hints (authoritative fallback)
  const detService = extractService(userText);
  const detRegion = extractRegion(userText, regions);
  const detPop = extractPop(userText, pops);
  const detWindow = extractWindowMinutes(userText);
  const detPartner = partnerFromFollowup || extractPartner(userText, partners);

  // If it's triage-ish and ClickHouse mode but partner missing → ask partner
  if (mode === "clickhouse" && triageish && !detPartner) {
    return jsonOk({
      ok: true,
      kind: "triage",
      needsPartnerQuestion: true,
      partnerQuestion: makePartnerQuestion(partners),
      serviceHint: detService,
      regionHint: detRegion,
      popHint: detPop,
      windowHint: detWindow,
    });
  }

  // LLM pack (JSON-only output)
  const system: WireMsg = {
    role: "system",
    content:
      "You are Cachey 🤖 — a sophisticated, calm, and helpful CDN triage concierge.\n" +
      "You can be lightly playful, but keep it polished.\n\n" +
      "Return ONLY valid JSON with keys:\n" +
      "kind ('triage'|'general'), reply (string), serviceHint, regionHint, popHint, windowHint (minutes), partnerHint, needsPartnerQuestion (bool), partnerQuestion (string).\n" +
      "If user is chatting: kind='general' and reply warmly.\n" +
      "If triage: kind='triage' and provide concise reply + hints if possible.\n" +
      "Do not output markdown, code fences, or extra text.",
  };

  const compactHistory = rawMsgs.slice(-12).map((m) => ({
    role: m.role,
    content: norm(m.content),
  }));

  const contextHint: WireMsg = {
    role: "system",
    content:
      `Context: mode=${mode}. ` +
      `AvailableRegions=${(regions || []).slice(0, 50).join(", ")}. ` +
      `AvailablePops=${(pops || []).slice(0, 50).join(", ")}. ` +
      `AvailablePartners=${(partners || []).join(", ")}.`,
  };

  let llmOut: any = null;

  try {
    const or = await callOpenRouter([
      system,
      contextHint,
      ...compactHistory,
      { role: "user", content: userText },
    ]);

    const content = or?.choices?.[0]?.message?.content;
    llmOut = typeof content === "string" ? safeJsonParse(content) : null;

    if (!llmOut || typeof llmOut !== "object") {
      const replyText =
        typeof content === "string" && content.trim()
          ? content.trim()
          : "Understood.";
      if (!triageish) return jsonOk({ ok: true, kind: "general", reply: replyText });
      llmOut = { kind: "triage", reply: replyText };
    }
  } catch (e: any) {
    // If LLM fails, stay polite and still return parsed hints when triage-ish
    const msg = e?.message || "LLM failed";
    if (!triageish) {
      return jsonOk({
        ok: true,
        kind: "general",
        reply: `Apologies — my “smart” channel had a moment (${msg}). You can still type \`help\` or run triage like: \`vod in bos last 1 day\`.`,
      });
    }
    llmOut = {
      kind: "triage",
      reply: `Apologies — the LLM channel is unavailable (${msg}). I’ll proceed using parsed filters.`,
    };
  }

  const kind = llmOut.kind === "general" ? "general" : "triage";

  // Merge: deterministic overrides LLM
  const serviceHint = detService ?? llmOut.serviceHint ?? null;
  const regionHint = detRegion ?? llmOut.regionHint ?? null;
  const popHint = detPop ?? llmOut.popHint ?? null;

  let windowHint: number | null = null;
  if (detWindow != null) windowHint = detWindow;
  else if (llmOut.windowHint != null && Number.isFinite(Number(llmOut.windowHint)))
    windowHint = Number(llmOut.windowHint);
  else windowHint = null;

  const partnerHint = detPartner ?? llmOut.partnerHint ?? null;

  // If triage, clickhouse, partner missing → ask partner (again)
  if (mode === "clickhouse" && kind === "triage" && !partnerHint) {
    return jsonOk({
      ok: true,
      kind: "triage",
      needsPartnerQuestion: true,
      partnerQuestion: makePartnerQuestion(partners),
      serviceHint,
      regionHint,
      popHint,
      windowHint,
    });
  }

  if (kind === "general") {
    return jsonOk({
      ok: true,
      kind: "general",
      reply: String(llmOut.reply || smallTalkReply(userText, mode)),
    });
  }

  return jsonOk({
    ok: true,
    kind: "triage",
    reply: String(llmOut.reply || ""),
    serviceHint,
    regionHint,
    popHint,
    windowHint,
    partnerHint,
  });
}

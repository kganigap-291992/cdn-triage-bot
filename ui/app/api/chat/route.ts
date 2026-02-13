// app/api/chat/route.ts
import { NextResponse } from "next/server";

type Role = "system" | "user" | "assistant";
type WireMsg = { role: Role; content: string };

type CurrentFilters = {
  dataSource?: "csv" | "clickhouse";
  partner?: string;
  service?: string;
  region?: string;
  pop?: string;
  windowMinutes?: number;
};

type ChatContext = {
  mode?: "csv" | "clickhouse";
  chatMode?: "deterministic" | "llm"; // ✅ NEW: honor UI toggle
  availableRegions?: string[];
  availablePops?: string[];
  availablePartners?: string[];
  currentFilters?: CurrentFilters; // ✅ enables “how about live” follow-ups
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

// deterministic-ish variety without persistent memory
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
  const idx = hash32(seed) % arr.length;
  return arr[idx];
}

/**
 * ✅ FIXED greeting checks (stable)
 */
function isGreetingOrSmallTalk(text: string) {
  const t = normLower(text);
  if (!t) return true;

  // short tokens (keep explicit)
  if (t.length <= 3 && ["hi", "hey", "yo", "ok", "k", "sup", "thx"].includes(t)) {
    return true;
  }

  // treat “what can you do” as help (NOT smalltalk)
  if (t.includes("what can you do") || t.includes("help")) return false;

  return (
    /^hi\b/.test(t) ||
    /^hey\b/.test(t) ||
    /^hello\b/.test(t) ||
    /^yo\b/.test(t) ||
    /^sup\b/.test(t) ||
    /^thanks\b/.test(t) ||
    /^thank you\b/.test(t) ||
    /^good (morning|afternoon|evening)\b/.test(t) ||
    /^how are you\b/.test(t) ||
    /^what'?s up\b/.test(t) ||
    /^how's it going\b/.test(t) ||
    /^how are ya\b/.test(t)
  );
}

/**
 * ✅ NEW: Low-signal guard (avoid calling provider for junk)
 */
function looksLikeLowSignal(text: string) {
  const t = norm(text);
  if (!t) return true;

  const lower = t.toLowerCase();
  const singleToken = !/\s/.test(lower);
  const short = lower.length <= 7;
  const hasNoNumbers = !/\d/.test(lower);
  const hasNoKV = !/=/.test(lower);
  const hasNoPunct = !/[?.!,]/.test(lower);

  // If it's clearly a known keyword, don't treat as low-signal.
  const knownWords = [
    "help",
    "triage",
    "run",
    "errors",
    "error",
    "latency",
    "p95",
    "p99",
    "ttms",
    "service",
    "region",
    "pop",
    "vod",
    "live",
    "all",
    "reset",
    "filters",
    "explain",
    "yesterday",
    "today",
    "last night",
  ];
  const containsKnown = knownWords.some((k) => lower.includes(k));

  const smallTypos = ["canyou", "canu", "pls", "plz", "helo", "hellp", "wat", "wut"];
  if (smallTypos.includes(lower)) return true;

  return singleToken && short && hasNoNumbers && hasNoKV && hasNoPunct && !containsKnown;
}

// ------------------------------------------------------------
// ✅ Edge Case #1: Natural time phrases → window minutes
// ------------------------------------------------------------
function extractNaturalWindowMinutes(text: string): number | null {
  const t = normLower(text);
  if (!t) return null;

  // explicit "last 2h", "past 60m", etc.
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

  // common phrases
  if (/\blast night\b/.test(t)) return 12 * 60; // “last night” → 12h
  if (/\byesterday\b/.test(t)) return 24 * 60;
  if (/\btoday\b/.test(t)) return 8 * 60; // “today” default 8h
  if (/\bthis morning\b/.test(t)) return 6 * 60;
  if (/\bthis week\b/.test(t)) return 7 * 24 * 60;
  if (/\blast week\b/.test(t)) return 7 * 24 * 60;

  return null;
}

// ------------------------------------------------------------
// ATS Cache Result Codes Glossary (deterministic; no LLM/RAG)
// ------------------------------------------------------------
type GlossaryEntry = { title: string; meaning: string; opsHint?: string };

const ATS_CRC_GLOSSARY: Record<string, GlossaryEntry> = {
  tcp_hit: {
    title: "TCP_HIT",
    meaning:
      "A valid copy of the requested object was in cache and Traffic Server sent it to the client.",
    opsHint: "Healthy cache behavior. Expect lower origin traffic and lower latency.",
  },
  tcp_cf_hit: {
    title: "TCP_CF_HIT",
    meaning:
      "A valid copy is being updated in cache and Traffic Server served the existing valid copy.",
    opsHint: "Often indicates refresh/revalidation while still serving a valid copy.",
  },
  tcp_miss: {
    title: "TCP_MISS",
    meaning:
      "Object not in cache; Traffic Server fetched from origin/parent and served to client.",
    opsHint: "Spikes can mean cold cache, cache-busting URLs, short TTLs, or new content.",
  },
  tcp_refresh_hit: {
    title: "TCP_REFRESH_HIT",
    meaning:
      "Object was stale; ATS revalidated with origin, got 304 Not Modified, served cached object.",
    opsHint: "Revalidation succeeded (304). Usually fine; watch if it becomes excessive.",
  },
  tcp_ref_fail_hit: {
    title: "TCP_REF_FAIL_HIT",
    meaning:
      "Object was stale; ATS attempted revalidation but origin didn’t respond; served cached object.",
    opsHint: "Origin may be unhealthy/timeout. ATS served stale to protect clients.",
  },
  tcp_refresh_miss: {
    title: "TCP_REFRESH_MISS",
    meaning:
      "Object was stale; ATS revalidated and origin returned new content; served new content.",
    opsHint: "Can increase origin load if frequent.",
  },
  tcp_client_refresh: {
    title: "TCP_CLIENT_REFRESH",
    meaning:
      "Client requested no-cache; ATS fetched from origin and deleted prior cached copy.",
    opsHint: "Can look like cache thrash when clients/devices force refresh.",
  },
  tcp_ims_hit: {
    title: "TCP_IMS_HIT",
    meaning:
      "Client sent If-Modified-Since; ATS served from cache (fresh enough or validated as fresh).",
    opsHint: "Conditional requests satisfied by cache. Usually good.",
  },
  tcp_ims_miss: {
    title: "TCP_IMS_MISS",
    meaning:
      "Client IMS could not be satisfied by cache; ATS fetched updated content from origin.",
    opsHint: "Watch for cacheability/TTL issues or changing URLs.",
  },
  tcp_swapfail: {
    title: "TCP_SWAPFAIL",
    meaning: "Object was in cache but could not be accessed; client did not receive object.",
    opsHint: "Potential cache disk/access issues if volume is non-trivial.",
  },
  err_client_abort: {
    title: "ERR_CLIENT_ABORT",
    meaning: "Client disconnected before the complete object was sent.",
    opsHint: "Often user/device/network aborts. Watch spikes by region/device type.",
  },
  err_client_read_error: {
    title: "ERR_CLIENT_READ_ERROR",
    meaning: "The client had read errors (network problems).",
    opsHint: "Commonly last-mile connectivity issues or flaky clients.",
  },
  err_connect_fail: {
    title: "ERR_CONNECT_FAIL",
    meaning: "ATS could not reach the origin server.",
    opsHint: "Origin unreachable (routing/firewall/outage). Check origin health/connectivity.",
  },
  err_dns_fail: {
    title: "ERR_DNS_FAIL",
    meaning: "DNS could not resolve the origin hostname or resolvers were unreachable.",
    opsHint: "DNS outage/misconfig. Check resolver health and origin hostname.",
  },
  err_invalid_req: {
    title: "ERR_INVALID_REQ",
    meaning: "Client HTTP request was invalid (unknown methods may be forwarded).",
    opsHint: "Malformed clients/bots. Check samples + user agents.",
  },
  err_read_timeout: {
    title: "ERR_READ_TIMEOUT",
    meaning: "Origin did not respond within the timeout interval.",
    opsHint: "Origin slow/unresponsive. Check upstream saturation + origin latency.",
  },
  err_proxy_denied: {
    title: "ERR_PROXY_DENIED",
    meaning: "Client service was denied.",
    opsHint: "ACL/auth/policy denial. Check rules, geo blocks, token/auth failures.",
  },
  err_unknown: {
    title: "ERR_UNKNOWN",
    meaning: "Client connected but disconnected without sending a request.",
    opsHint: "Often connection churn/scans. Look at connection metrics and edge logs.",
  },
};

function isDefinitionQuestion(text: string) {
  const t = normLower(text);
  if (!t) return false;
  return (
    t.startsWith("what is ") ||
    t.startsWith("what’s ") ||
    t.startsWith("whats ") ||
    t.startsWith("define ") ||
    t.startsWith("meaning of ") ||
    t.startsWith("explain ")
  );
}

function extractTermFromDefinitionQuestion(text: string) {
  const t = norm(text);
  const m =
    t.match(/^(what is|what’s|whats|define|meaning of|explain)\s+(.+)$/i) || [];
  const term = (m[2] || "").trim();
  return term.replace(/[?.!]+$/, "").trim();
}

function lookupAtsCrc(raw: string): GlossaryEntry | null {
  const k0 = normLower(raw);
  if (!k0) return null;
  const k = k0.replace(/\s+/g, "_");
  return ATS_CRC_GLOSSARY[k] || null;
}

// -------- Command handling (NO LLM) --------
type CommandKind = "help" | "filters" | "reset" | "explain" | "run" | null;

function parseCommand(text: string): CommandKind {
  const t = normLower(text);
  if (!t) return null;

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

function helpText(mode: "csv" | "clickhouse") {
  const lines = [
    "Certainly — here’s how I can help.",
    "",
    "I can parse your message into filters (service / region / pop / time window / partner), run triage, and return a concise summary + charts.",
    "",
    "Examples:",
    "- `how was vod last night`",
    "- `live in usw2 at sjc last 2h`",
    "- `service=live region=all pop=all win=360`",
    "",
    "Commands: help • filters • explain • reset • run",
    "",
    mode === "clickhouse"
      ? "ClickHouse note: I’ll need a partner (ex: `beta_stream`)."
      : "CSV note: I’ll use your uploaded CSV or CSV URL.",
  ];
  return lines.join("\n");
}

function filtersText(args: {
  mode: "csv" | "clickhouse";
  partners: string[];
  regions: string[];
  pops: string[];
  current?: CurrentFilters;
}) {
  const { mode, partners, regions, pops, current } = args;

  const p = partners?.length ? partners.slice(0, 25).join(", ") : "(none)";
  const r = regions?.length ? regions.slice(0, 25).join(", ") : "(none)";
  const po = pops?.length ? pops.slice(0, 25).join(", ") : "(none)";

  const cur = current || {};
  const curLine =
    `Current: svc=${cur.service || "all"}, region=${cur.region || "all"}, pop=${
      cur.pop || "all"
    }, win=${cur.windowMinutes ?? "?"}m` +
    (mode === "clickhouse" ? `, partner=${cur.partner || "(missing)"}` : "");

  return [
    `Mode: ${mode}`,
    curLine,
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
    "Tip: natural language works (`vod last night`) or key=value works (`service=vod win=720`).",
  ].join("\n");
}

// ------------------------------------------------------------
// ✅ Edge Case #2: Partner follow-up collapse
// ------------------------------------------------------------
function looksLikePartnerQuestion(text: string) {
  const t = normLower(text);
  return (
    t.includes("which partner") ||
    t.includes("pick a partner") ||
    t.includes("partner should i use") ||
    t.includes("partner are we triaging")
  );
}

function isLikelyPartnerReply(text: string, partners: string[]) {
  const t = normLower(text);
  if (!t) return false;
  return partners.map((p) => p.toLowerCase()).includes(t);
}

function collapsePartnerFollowup(messages: WireMsg[], partners: string[]) {
  const msgs = Array.isArray(messages) ? messages : [];
  if (msgs.length < 2) return { text: "", partner: null as string | null };

  const lastUser = [...msgs].reverse().find((m) => m.role === "user");
  if (!lastUser) return { text: "", partner: null };

  const lastUserText = norm(lastUser.content);
  if (!isLikelyPartnerReply(lastUserText, partners))
    return { text: lastUserText, partner: null };

  const lastIdx = msgs.lastIndexOf(lastUser);
  const prevAssistant = [...msgs.slice(0, lastIdx)]
    .reverse()
    .find((m) => m.role === "assistant");

  const partner = normLower(lastUserText);

  // if it wasn't asked as a partner question, treat it as “partner=...”
  if (!prevAssistant || !looksLikePartnerQuestion(prevAssistant.content)) {
    return { text: lastUserText, partner };
  }

  // merge with prior user query
  const prevUser = [...msgs.slice(0, lastIdx)]
    .reverse()
    .find((m) => m.role === "user");
  const originalQuery = norm(prevUser?.content);

  const combined = originalQuery ? `${originalQuery} partner=${partner}` : `partner=${partner}`;
  return { text: combined, partner };
}

// ------------------------------------------------------------
// Deterministic extraction helpers
// ------------------------------------------------------------
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
    "yesterday",
    "today",
    "last night",
    "how was",
    "how about",
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

function extractWindowMinutesKeyValue(text: string): number | null {
  const t = normLower(text);

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

  // "in <region>"
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

  // permissive fallback for pop-like tokens
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

function makePartnerQuestion(partners: string[]) {
  const list = partners?.length
    ? partners.join(", ")
    : "acme_media, beta_stream, charlie_video…";
  return `Quick one — which partner are we triaging? (${list})`;
}

// ------------------------------------------------------------
// ✅ Edge Case #3: Follow-up “how about live” uses current filters
// ------------------------------------------------------------
function isServiceOnlyFollowup(text: string) {
  const t = normLower(text);
  if (!t) return false;
  return (
    /\bhow about\b/.test(t) ||
    /\bwhat about\b/.test(t) ||
    /\band live\b/.test(t) ||
    /^\s*live\s*$/.test(t) ||
    /^\s*vod\s*$/.test(t)
  );
}

// ------------------------------------------------------------
// OpenRouter
// ------------------------------------------------------------
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
      temperature: 0.6,
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

function smallTalkReply(userText: string, mode: "csv" | "clickhouse") {
  const options = [
    "All set on my end. Shall we chase errors or latency first? (Try: `vod in bos last 60m`.)",
    "Hey — Cachey here 🤖. Give me service + region/POP + time window and I’ll run triage.",
    "Ready when you are. Want to start with errors (5xx/4xx) or latency (p95/p99 TTMS)?",
    "Cool. If you share scope + symptoms, I’ll narrow it down quickly.",
    "Let’s do it. Try: `live in usw2 at sjc last 2h`.",
  ];
  return pickOne(options, `${mode}|${normLower(userText)}`);
}

// ------------------------------------------------------------
// ✅ Edge Case #4 + #5 live in route: glossary + low-signal + time phrases + followups
// ------------------------------------------------------------
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as Body;

  if (body.reset) {
    return jsonOk({ ok: true, kind: "reset" });
  }

  const rawMsgs = Array.isArray(body.messages) ? body.messages : [];
  const ctx = body.context || {};

  const partners = Array.isArray(ctx.availablePartners) ? ctx.availablePartners : [];
  const regions = Array.isArray(ctx.availableRegions) ? ctx.availableRegions : [];
  const pops = Array.isArray(ctx.availablePops) ? ctx.availablePops : [];

  const mode = ctx.mode === "clickhouse" ? "clickhouse" : "csv";

  // ✅ NEW: honor UI chatMode (default deterministic)
  const chatMode: "deterministic" | "llm" = ctx.chatMode === "llm" ? "llm" : "deterministic";

  const current = ctx.currentFilters || {};
  const currentService = normLower(current.service || "") || null;
  const currentRegion = normLower(current.region || "") || null;
  const currentPop = normLower(current.pop || "") || null;
  const currentWin =
    current.windowMinutes != null && Number.isFinite(Number(current.windowMinutes))
      ? Number(current.windowMinutes)
      : null;
  const currentPartner = normLower(current.partner || "") || null;

  // ✅ Partner follow-up collapse (beta_stream after partner question)
  const collapsed = collapsePartnerFollowup(rawMsgs, partners);
  const userText =
    collapsed.text ||
    norm(rawMsgs.filter((m) => m.role === "user").slice(-1)[0]?.content);

  const partnerFromFollowup = collapsed.partner;

  // ✅ Glossary answers (no provider call)
  if (isDefinitionQuestion(userText)) {
    const term = extractTermFromDefinitionQuestion(userText);
    const entry = lookupAtsCrc(term);
    if (entry) {
      const reply = [
        `${entry.title}`,
        entry.meaning,
        entry.opsHint ? `\nOps hint: ${entry.opsHint}` : "",
      ]
        .filter(Boolean)
        .join("\n");
      return jsonOk({ ok: true, kind: "general", reply });
    }
  }

  // ✅ Commands are deterministic (no provider call)
  const cmd = parseCommand(userText);
  if (cmd === "help") return jsonOk({ ok: true, kind: "general", reply: helpText(mode) });
  if (cmd === "filters")
    return jsonOk({
      ok: true,
      kind: "general",
      reply: filtersText({ mode, partners, regions, pops, current }),
    });
  if (cmd === "explain") return jsonOk({ ok: true, kind: "general", reply: explainText() });
  if (cmd === "reset")
    return jsonOk({
      ok: true,
      kind: "general",
      reply:
        "Done — I’ve cleared my side. For a full wipe (filters + local history), please use the Reset button in the UI.",
    });
  if (cmd === "run")
    return jsonOk({
      ok: true,
      kind: "triage",
      reply: "Very well — running triage with the current filters…",
    });

  const triageish = looksLikeTriageIntent(userText);

  // ✅ Smalltalk: no provider
  if (!triageish && isGreetingOrSmallTalk(userText)) {
    return jsonOk({ ok: true, kind: "general", reply: smallTalkReply(userText, mode) });
  }

  // ✅ Low-signal: no provider
  if (!triageish && looksLikeLowSignal(userText)) {
    return jsonOk({
      ok: true,
      kind: "general",
      reply:
        "Looks like a quick typo 🙂\n\nTry:\n- `how was vod last night`\n- `live in bos last 2h`\n- `service=live region=all win=360`\n\nOr type `help`.",
    });
  }

  // Deterministic extraction (authoritative fallback)
  const detService = extractService(userText);
  const detRegion = extractRegion(userText, regions);
  const detPop = extractPop(userText, pops);

  // ✅ time: prefer key/value window, else natural phrases
  const detWinKV = extractWindowMinutesKeyValue(userText);
  const detWinNatural = extractNaturalWindowMinutes(userText);
  const detWindow = detWinKV ?? detWinNatural ?? null;

  const detPartner = partnerFromFollowup || extractPartner(userText, partners);

  // ✅ follow-up service-only like "how about live"
  const followupSvcOnly =
    isServiceOnlyFollowup(userText) &&
    !!detService &&
    !detRegion &&
    !detPop &&
    detWindow == null;

  // ✅ FIX: service comes from detService; region/pop/window fall back to current on service-only followups
  const serviceHint = detService ?? null;
  const regionHint = detRegion ?? (followupSvcOnly ? currentRegion : null);
  const popHint = detPop ?? (followupSvcOnly ? currentPop : null);
  const windowHint = detWindow ?? (followupSvcOnly ? currentWin : null);

  // partner: deterministic first, else current (sticky)
  const partnerHint = detPartner ?? currentPartner ?? null;

  // If ClickHouse triage-ish and partner missing → ask partner (deterministic)
  if (mode === "clickhouse" && triageish && !partnerHint) {
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

  // ------------------------------------------------------------
  // ✅ NEW: If UI is NOT in LLM mode, never call OpenRouter.
  // Return deterministic hints only.
  // ------------------------------------------------------------
  if (chatMode !== "llm") {
    if (!triageish) {
      return jsonOk({
        ok: true,
        kind: "general",
        reply: smallTalkReply(userText, mode),
      });
    }
    return jsonOk({
      ok: true,
      kind: "triage",
      reply: "Parsed filters. Proceeding with triage.",
      serviceHint,
      regionHint,
      popHint,
      windowHint,
      partnerHint,
    });
  }

  // ------------------------------------------------------------
  // LLM Assist (only when enabled)
  // ------------------------------------------------------------
  const system: WireMsg = {
    role: "system",
    content:
      "You are Cachey 🤖 — a calm, helpful CDN triage concierge.\n" +
      "Return ONLY valid JSON with keys:\n" +
      "kind ('triage'|'general'), reply (string), serviceHint, regionHint, popHint, windowHint (minutes), partnerHint, needsPartnerQuestion (bool), partnerQuestion (string).\n" +
      "No markdown, no code fences, no extra text.",
  };

  const contextHint: WireMsg = {
    role: "system",
    content:
      `Context: mode=${mode}. ` +
      `CurrentFilters: svc=${currentService || "all"}, region=${currentRegion || "all"}, pop=${currentPop || "all"}, win=${currentWin ?? "?"}m, partner=${currentPartner || "(none)"}. ` +
      `AvailableRegions=${(regions || []).slice(0, 50).join(", ")}. ` +
      `AvailablePops=${(pops || []).slice(0, 50).join(", ")}. ` +
      `AvailablePartners=${(partners || []).join(", ")}.`,
  };

  // Keep history short
  const compactHistory = rawMsgs.slice(-12).map((m) => ({
    role: m.role,
    content: norm(m.content),
  }));

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

    // If model ignored JSON-only instruction, accept plain text safely
    if (!llmOut || typeof llmOut !== "object") {
      const replyText =
        typeof content === "string" && content.trim() ? content.trim() : "Understood.";
      if (!triageish) return jsonOk({ ok: true, kind: "general", reply: replyText });
      llmOut = { kind: "triage", reply: replyText };
    }
  } catch {
    // Don’t leak provider errors
    if (!triageish) {
      return jsonOk({
        ok: true,
        kind: "general",
        reply:
          "My LLM assist is temporarily unavailable 😅\n\nYou can still:\n- type `help`\n- ask `what is tcp_hit`\n- run triage like `how was vod last night`",
      });
    }
    llmOut = {
      kind: "triage",
      reply: "LLM assist is temporarily unavailable. Proceeding with parsed filters.",
    };
  }

  const kind = llmOut.kind === "general" ? "general" : "triage";

  // ------------------------------------------------------------
  // ✅ Deterministic always wins over LLM + sticky current filters
  // ------------------------------------------------------------
  const mergedService = serviceHint ?? llmOut.serviceHint ?? currentService ?? null;
  const mergedRegion = regionHint ?? llmOut.regionHint ?? currentRegion ?? null;
  const mergedPop = popHint ?? llmOut.popHint ?? currentPop ?? null;

  let mergedWindow: number | null = windowHint;
  if (mergedWindow == null && llmOut.windowHint != null && Number.isFinite(Number(llmOut.windowHint))) {
    mergedWindow = Number(llmOut.windowHint);
  }
  if (mergedWindow == null && currentWin != null) mergedWindow = currentWin;

  const mergedPartner = partnerHint ?? llmOut.partnerHint ?? currentPartner ?? null;

  // ClickHouse triage + still missing partner? ask again.
  if (mode === "clickhouse" && kind === "triage" && !mergedPartner) {
    return jsonOk({
      ok: true,
      kind: "triage",
      needsPartnerQuestion: true,
      partnerQuestion: makePartnerQuestion(partners),
      serviceHint: mergedService,
      regionHint: mergedRegion,
      popHint: mergedPop,
      windowHint: mergedWindow,
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
    serviceHint: mergedService,
    regionHint: mergedRegion,
    popHint: mergedPop,
    windowHint: mergedWindow,
    partnerHint: mergedPartner,
  });
}

// ui/app/api/chat/route.ts
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

  // ✅ schema-aligned
  contentType?: string; // all|manifest|segment|api
  uaFamily?: string; // all|stb|mobile|web|smart_tv|console
};

type ChatContext = {
  mode?: "csv" | "clickhouse";
  chatMode?: "deterministic" | "llm";

  availableRegions?: string[];
  availablePops?: string[];
  availablePartners?: string[];
  availableServices?: string[];
  availableContentTypes?: string[];
  availableUaFamilies?: string[];

  currentFilters?: CurrentFilters;
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

function uniqLower(arr: string[]) {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const x of arr || []) {
    const v = normLower(x);
    if (!v) continue;
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

function inAllowed(v: string | null, allowed: string[]) {
  if (!v) return false;
  return allowed.includes(normLower(v));
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
 * Greeting / smalltalk checks
 */
function isGreetingOrSmallTalk(text: string) {
  const t = normLower(text);
  if (!t) return true;

  if (t.length <= 3 && ["hi", "hey", "yo", "ok", "k", "sup", "thx"].includes(t)) {
    return true;
  }

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
 * Low-signal guard (avoid calling provider for junk)
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

  const knownWords = [
    "help",
    "triage",
    "run",
    "errors",
    "error",
    "latency",
    "p95",
    "p99",
    "service",
    "svc",
    "region",
    "pop",
    "partner",
    "vod",
    "live",
    "dvr",
    "eas",
    "live_ott",
    "app_backend",
    "contenttype",
    "ua",
    "uafamily",
    "manifest",
    "segment",
    "api",
    "all",
    "reset",
    "filters",
    "explain",
    "yesterday",
    "today",
    "last night",
    "last",
    "past",
    "in",
    "for",
    "within",
  ];
  const containsKnown = knownWords.some((k) => lower.includes(k));

  const smallTypos = ["canyou", "canu", "pls", "plz", "helo", "hellp", "wat", "wut"];
  if (smallTypos.includes(lower)) return true;

  return singleToken && short && hasNoNumbers && hasNoKV && hasNoPunct && !containsKnown;
}

// ------------------------------------------------------------
// Natural time phrases → window minutes
// ------------------------------------------------------------
function extractNaturalWindowMinutes(text: string): number | null {
  const t = normLower(text);
  if (!t) return null;

  // ✅ "in 1hr", "for 2 hours", "within 30m"
  const mInFor = t.match(
    /\b(in|for|within)\s+(\d+)\s*(d|day|days|h|hr|hrs|hour|hours|m|min|mins|minute|minutes)\b/
  );
  if (mInFor) {
    const n = Number(mInFor[2]);
    if (!Number.isFinite(n) || n <= 0) return null;
    const unit = mInFor[3];
    if (unit.startsWith("d")) return n * 1440;
    if (unit.startsWith("h")) return n * 60;
    return n;
  }

  // existing: "last/past 2h"
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

  // ✅ bare: "1hr", "2h", "90m"
  const mBare = t.match(/\b(\d+)\s*(d|h|hr|hrs|m|min|mins)\b/);
  if (mBare) {
    const n = Number(mBare[1]);
    if (!Number.isFinite(n) || n <= 0) return null;
    const unit = mBare[2];
    if (unit === "d") return n * 1440;
    if (unit.startsWith("h") || unit.startsWith("hr")) return n * 60;
    return n;
  }

  if (/\blast night\b/.test(t)) return 12 * 60;
  if (/\byesterday\b/.test(t)) return 24 * 60;
  if (/\btoday\b/.test(t)) return 8 * 60;
  if (/\bthis morning\b/.test(t)) return 6 * 60;
  if (/\bthis week\b/.test(t)) return 7 * 24 * 60;
  if (/\blast week\b/.test(t)) return 7 * 24 * 60;

  return null;
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

  if (t === "filters" || t === "show filters" || t === "show filter" || t === "current filters")
    return "filters";

  if (t === "reset" || t === "clear" || t === "start over" || t === "wipe") return "reset";

  if (t === "explain" || t.startsWith("explain ") || t.includes("what is this")) return "explain";

  if (t === "run" || t === "triage" || t === "go" || t === "execute") return "run";

  return null;
}

function helpText(mode: "csv" | "clickhouse") {
  const lines = [
    "Here’s how to use Cachey.",
    "",
    "Ask in natural language or key=value. I’ll parse filters for triage.",
    "",
    "Examples:",
    "- `how was live last 2h`",
    "- `vod in pop_010 last night`",
    "- `partner=partner_01 service=live region=us-east pop=all win=60`",
    "- `contentType=manifest uaFamily=web last 1h`",
    "",
    "Commands: help • filters • explain • reset • run",
    "",
    mode === "clickhouse"
      ? "ClickHouse note: partner + service are required."
      : "CSV note: uses your CSV runner.",
  ];
  return lines.join("\n");
}

function filtersText(args: {
  mode: "csv" | "clickhouse";
  partners: string[];
  services: string[];
  regions: string[];
  pops: string[];
  contentTypes: string[];
  uaFamilies: string[];
  current?: CurrentFilters;
}) {
  const { mode, partners, services, regions, pops, contentTypes, uaFamilies, current } = args;

  const cur = current || {};
  const curLine =
    `Current: partner=${cur.partner || "(missing)"}, svc=${cur.service || "(missing)"}, region=${
      cur.region || "all"
    }, pop=${cur.pop || "all"}, win=${cur.windowMinutes ?? "?"}m, contentType=${
      cur.contentType || "all"
    }, uaFamily=${cur.uaFamily || "all"}`;

  const p = partners?.length ? partners.slice(0, 25).join(", ") : "(none)";
  const s = services?.length ? services.slice(0, 25).join(", ") : "(none)";
  const r = regions?.length ? regions.slice(0, 25).join(", ") : "(none)";
  const po = pops?.length ? pops.slice(0, 25).join(", ") : "(none)";
  const ct = contentTypes?.length ? contentTypes.join(", ") : "(none)";
  const ua = uaFamilies?.length ? uaFamilies.join(", ") : "(none)";

  return [
    `Mode: ${mode}`,
    curLine,
    "",
    `Partners: ${p}${partners.length > 25 ? " …" : ""}`,
    `Services: ${s}${services.length > 25 ? " …" : ""}`,
    `Regions: ${r}${regions.length > 25 ? " …" : ""}`,
    `POPs: ${po}${pops.length > 25 ? " …" : ""}`,
    `ContentTypes: ${ct}`,
    `UA Families: ${ua}`,
  ].join("\n");
}

function explainText() {
  return [
    "What this is:",
    "",
    "1) Parses your message into filters (partner/service/region/pop/window/contentType/uaFamily).",
    "2) UI applies filters, then Run executes triage.",
    "",
    "Tip: `how was live in 1hr` should set win=60.",
  ].join("\n");
}

// ------------------------------------------------------------
// Partner follow-up collapse
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
  if (!isLikelyPartnerReply(lastUserText, partners)) return { text: lastUserText, partner: null };

  const lastIdx = msgs.lastIndexOf(lastUser);
  const prevAssistant = [...msgs.slice(0, lastIdx)].reverse().find((m) => m.role === "assistant");

  const partner = normLower(lastUserText);

  if (!prevAssistant || !looksLikePartnerQuestion(prevAssistant.content)) {
    return { text: lastUserText, partner };
  }

  const prevUser = [...msgs.slice(0, lastIdx)].reverse().find((m) => m.role === "user");
  const originalQuery = norm(prevUser?.content);

  const combined = originalQuery ? `${originalQuery} partner=${partner}` : `partner=${partner}`;
  return { text: combined, partner };
}

// ------------------------------------------------------------
// Deterministic extraction helpers (schema-aligned)
// ------------------------------------------------------------
function looksLikeTriageIntent(text: string, services: string[]) {
  const t = normLower(text);
  if (!t) return false;
  if (t.includes("=")) return true;

  const kws = [
    "triage",
    "run",
    "status",
    "errors",
    "error",
    "p95",
    "p99",
    "latency",
    "region",
    "pop",
    "partner",
    "last",
    "past",
    "yesterday",
    "today",
    "last night",
    "how was",
    "how about",
    "contenttype",
    "ua",
    "uafamily",
    "manifest",
    "segment",
    "api",
  ];

  if (kws.some((k) => t.includes(k))) return true;

  // service names imply triage intent
  for (const svc of services || []) {
    if (!svc) continue;
    if (t.includes(svc)) return true;
  }
  return false;
}

function extractService(text: string, services: string[]): string | null {
  const t = normLower(text);
  const allowed = uniqLower(services || []);

  // svc=live | service=vod | service=dvr etc
  const m1 = t.match(/\b(service|svc)\s*=\s*([a-z0-9_]+)\b/);
  if (m1?.[2] && inAllowed(m1[2], allowed)) return normLower(m1[2]);

  // bare token: "live" / "dvr" / "live_ott" / "app_backend"
  for (const svc of allowed) {
    if (new RegExp(`\\b${svc.replace(/_/g, "\\_")}\\b`, "i").test(t)) return svc;
  }

  return null;
}

// minimal canonical region aliasing, but still validated against availableRegions
const CANON_REGION_ALIASES: Record<string, string> = {
  use1: "us-east",
  "us-east-1": "us-east",
  useast: "us-east",
  "us east": "us-east",

  usw2: "us-west",
  "us-west-2": "us-west",
  uswest: "us-west",
  "us west": "us-west",

  usc1: "us-central",
  uscentral: "us-central",
  "us central": "us-central",

  euw1: "eu-west",
  euwest: "eu-west",
  "eu west": "eu-west",

  euc1: "eu-central",
  eucentral: "eu-central",
  "eu central": "eu-central",

  aps1: "ap-south",
  apsouth: "ap-south",
  "ap south": "ap-south",

  apne1: "ap-northeast",
  apnortheast: "ap-northeast",
  "ap northeast": "ap-northeast",

  sae1: "sa-east",
  saeast: "sa-east",
  "sa east": "sa-east",
};

function extractRegion(text: string, availableRegions: string[]): string | null {
  const t = normLower(text);
  const allowed = uniqLower(availableRegions || []);
  if (!allowed.length) return null;

  const m = t.match(/\bregion\s*=\s*([a-z0-9_\-]+)\b/);
  if (m?.[1]) {
    const raw = normLower(m[1]);
    const aliased = CANON_REGION_ALIASES[raw] || raw;
    if (allowed.includes(aliased)) return aliased;
    if (allowed.includes(raw)) return raw;
  }

  // "in <region>"
  const m2 = t.match(/\bin\s+([a-z0-9_\-]+)\b/);
  if (m2?.[1]) {
    const raw = normLower(m2[1]);
    const aliased = CANON_REGION_ALIASES[raw] || raw;
    if (allowed.includes(aliased)) return aliased;
    if (allowed.includes(raw)) return raw;
  }

  // phrase aliases with spaces
  for (const [k, v] of Object.entries(CANON_REGION_ALIASES)) {
    if (k.includes(" ") && t.includes(k)) {
      if (allowed.includes(v)) return v;
    }
  }

  // direct match of any allowed region token
  for (const r of allowed) {
    if (r === "all") continue;
    if (new RegExp(`\\b${r.replace(/-/g, "\\-")}\\b`, "i").test(t)) return r;
  }

  return null;
}

function extractPop(text: string, availablePops: string[]): string | null {
  const t = normLower(text);
  const allowed = uniqLower(availablePops || []);
  if (!allowed.length) return null;

  const m = t.match(/\bpop\s*=\s*([a-z0-9_\-]+)\b/);
  if (m?.[1]) {
    const raw = normLower(m[1]);
    if (allowed.includes(raw)) return raw;
  }

  // "in pop_010" or "at pop_010"
  const m2 = t.match(/\b(in|at)\s+(pop_\d{3}|pop-\d{3}|pop\d{3})\b/);
  if (m2?.[2]) {
    const raw = normLower(m2[2]).replace("pop-", "pop_").replace(/^pop(\d{3})$/, "pop_$1");
    if (allowed.includes(raw)) return raw;
  }

  // any pop_### token
  const m3 = t.match(/\b(pop_\d{3}|pop-\d{3}|pop\d{3})\b/);
  if (m3?.[1]) {
    const raw = normLower(m3[1]).replace("pop-", "pop_").replace(/^pop(\d{3})$/, "pop_$1");
    if (allowed.includes(raw)) return raw;
  }

  return null;
}

function extractPartner(text: string, availablePartners: string[]): string | null {
  const t = normLower(text);
  const allowed = uniqLower(availablePartners || []);
  if (!allowed.length) return null;

  // exact reply (partner_03)
  if (allowed.includes(t)) return t;

  const m = t.match(/\bpartner\s*=\s*([a-z0-9_\-]+)\b/);
  if (m?.[1]) {
    const raw = normLower(m[1]);
    if (allowed.includes(raw)) return raw;
  }

  // any "partner_0x" token
  const m2 = t.match(/\bpartner_\d{2}\b/);
  if (m2?.[0] && allowed.includes(m2[0])) return m2[0];

  return null;
}

function extractContentType(text: string, availableContentTypes: string[]): string | null {
  const t = normLower(text);
  const allowed = uniqLower(availableContentTypes || []);
  if (!allowed.length) return null;

  const m = t.match(/\b(contenttype|content_type|ct)\s*=\s*([a-z0-9_]+)\b/);
  if (m?.[2] && inAllowed(m[2], allowed)) return normLower(m[2]);

  // bare: manifest/segment/api
  for (const ct of allowed) {
    if (ct === "all") continue;
    if (new RegExp(`\\b${ct}\\b`, "i").test(t)) return ct;
  }
  return null;
}

function extractUaFamily(text: string, availableUaFamilies: string[]): string | null {
  const t = normLower(text);
  const allowed = uniqLower(availableUaFamilies || []);
  if (!allowed.length) return null;

  const m = t.match(/\b(uafamily|ua_family|ua)\s*=\s*([a-z0-9_]+)\b/);
  if (m?.[2] && inAllowed(m[2], allowed)) return normLower(m[2]);

  // bare: stb/mobile/web/smart_tv/console
  for (const ua of allowed) {
    if (ua === "all") continue;
    if (new RegExp(`\\b${ua.replace(/_/g, "\\_")}\\b`, "i").test(t)) return ua;
  }
  return null;
}

function makePartnerQuestion(partners: string[]) {
  const list = partners?.length ? partners.join(", ") : "partner_01, partner_02, …";
  return `Which partner should I use? (${list})`;
}

function isServiceOnlyFollowup(text: string, services: string[]) {
  const t = normLower(text);
  if (!t) return false;

  // "live" or "vod" or "dvr" etc alone, or "and live"
  const allowed = uniqLower(services || []);
  if (allowed.includes(t)) return true;

  return /\bhow about\b/.test(t) || /\bwhat about\b/.test(t) || /\band\s+\w+\b/.test(t);
}

function smallTalkReply(userText: string, mode: "csv" | "clickhouse") {
  const options = [
    "Ready. Pick partner + service, then ask: `how was live in 1hr`.",
    "Cachey here 🤖 — give me partner + service + time window and I’ll parse filters.",
    "Try: `partner=partner_01 service=live region=all pop=all win=60`.",
    "Try: `vod in pop_010 last night`.",
  ];
  return pickOne(options, `${mode}|${normLower(userText)}`);
}

// ------------------------------------------------------------
// Route
// ------------------------------------------------------------
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as Body;

  if (body.reset) {
    return jsonOk({ ok: true, kind: "reset" });
  }

  const rawMsgs = Array.isArray(body.messages) ? body.messages : [];
  const ctx = body.context || {};

  const mode = ctx.mode === "clickhouse" ? "clickhouse" : "csv";
  const chatMode: "deterministic" | "llm" = ctx.chatMode === "llm" ? "llm" : "deterministic";

  // ✅ prefer passed lists; fall back to safe defaults (still schema-aligned)
  const partners = uniqLower(Array.isArray(ctx.availablePartners) ? ctx.availablePartners : []);
  const regions = uniqLower(Array.isArray(ctx.availableRegions) ? ctx.availableRegions : []);
  const pops = uniqLower(Array.isArray(ctx.availablePops) ? ctx.availablePops : []);

  const services = uniqLower(
    Array.isArray(ctx.availableServices)
      ? ctx.availableServices
      : // fallback canonical services list
        ["live", "vod", "dvr", "eas", "live_ott", "app_backend"]
  );

  const contentTypes = uniqLower(
    Array.isArray(ctx.availableContentTypes) ? ctx.availableContentTypes : ["all", "manifest", "segment", "api"]
  );

  const uaFamilies = uniqLower(
    Array.isArray(ctx.availableUaFamilies) ? ctx.availableUaFamilies : ["all", "stb", "mobile", "web", "smart_tv", "console"]
  );

  const current = ctx.currentFilters || {};
  const currentService = normLower(current.service || "") || null;
  const currentRegion = normLower(current.region || "") || null;
  const currentPop = normLower(current.pop || "") || null;
  const currentWin =
    current.windowMinutes != null && Number.isFinite(Number(current.windowMinutes))
      ? Number(current.windowMinutes)
      : null;
  const currentPartner = normLower(current.partner || "") || null;

  const currentContentType = normLower(current.contentType || "") || null;
  const currentUaFamily = normLower(current.uaFamily || "") || null;

  const collapsed = collapsePartnerFollowup(rawMsgs, partners);
  const userText =
    collapsed.text || norm(rawMsgs.filter((m) => m.role === "user").slice(-1)[0]?.content);
  const partnerFromFollowup = collapsed.partner;

  // Commands (deterministic)
  const cmd = parseCommand(userText);
  if (cmd === "help") return jsonOk({ ok: true, kind: "general", reply: helpText(mode) });
  if (cmd === "filters")
    return jsonOk({
      ok: true,
      kind: "general",
      reply: filtersText({
        mode,
        partners,
        services,
        regions,
        pops,
        contentTypes,
        uaFamilies,
        current,
      }),
    });
  if (cmd === "explain") return jsonOk({ ok: true, kind: "general", reply: explainText() });
  if (cmd === "reset")
    return jsonOk({
      ok: true,
      kind: "general",
      reply: "Cleared. Use UI Reset to wipe local history + filters.",
    });
  if (cmd === "run")
    return jsonOk({ ok: true, kind: "triage", reply: "Running triage with current filters…" });

  const triageish = looksLikeTriageIntent(userText, services);

  if (!triageish && isGreetingOrSmallTalk(userText)) {
    return jsonOk({ ok: true, kind: "general", reply: smallTalkReply(userText, mode) });
  }

  if (!triageish && looksLikeLowSignal(userText)) {
    return jsonOk({
      ok: true,
      kind: "general",
      reply:
        "Try:\n- `how was live in 1hr`\n- `vod in pop_010 last night`\n- `partner=partner_01 service=live win=60`\n\nOr type `help`.",
    });
  }

  // Deterministic extraction
  const detService = extractService(userText, services);
  const detRegion = extractRegion(userText, regions);
  const detPop = extractPop(userText, pops);
  const detPartner = partnerFromFollowup || extractPartner(userText, partners);

  const detWinKV = extractWindowMinutesKeyValue(userText);
  const detWinNatural = extractNaturalWindowMinutes(userText);
  const detWindow = detWinKV ?? detWinNatural ?? null;

  const detContentType = extractContentType(userText, contentTypes);
  const detUaFamily = extractUaFamily(userText, uaFamilies);

  const followupSvcOnly =
    isServiceOnlyFollowup(userText, services) &&
    !!detService &&
    !detRegion &&
    !detPop &&
    detWindow == null &&
    !detContentType &&
    !detUaFamily;

  const serviceHint = detService ?? null;
  const regionHint = detRegion ?? (followupSvcOnly ? currentRegion : null);
  const popHint = detPop ?? (followupSvcOnly ? currentPop : null);
  const windowHint = detWindow ?? (followupSvcOnly ? currentWin : null);
  const partnerHint = detPartner ?? currentPartner ?? null;

  const contentTypeHint = detContentType ?? (followupSvcOnly ? currentContentType : null);
  const uaFamilyHint = detUaFamily ?? (followupSvcOnly ? currentUaFamily : null);

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
      partnerHint: null,
      contentTypeHint,
      uaFamilyHint,
    });
  }

  // Deterministic-only mode: never call provider
  if (chatMode !== "llm") {
    if (!triageish) {
      return jsonOk({ ok: true, kind: "general", reply: smallTalkReply(userText, mode) });
    }

    return jsonOk({
      ok: true,
      kind: "triage",
      reply: "Parsed filters.",
      serviceHint,
      regionHint,
      popHint,
      windowHint,
      partnerHint,
      contentTypeHint,
      uaFamilyHint,
    });
  }

  // If you later re-enable LLM mode, keep your existing OpenRouter section,
  // but you should merge deterministic hints the same way (and include contentTypeHint/uaFamilyHint).
  return jsonOk({
    ok: true,
    kind: "general",
    reply: "LLM mode is not wired in this schema-aligned rewrite. Switch to Deterministic.",
  });
}
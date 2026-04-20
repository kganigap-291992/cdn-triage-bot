// lib/triage/atsCrcGlossary.ts

export type GlossaryCategory =
  | "ats_hit"
  | "ats_miss"
  | "ats_refresh"
  | "ats_client_refresh"
  | "ats_cache_failure"
  | "origin_failure"
  | "dns_failure"
  | "timeout"
  | "client_error"
  | "proxy_denial"
  | "unknown";

export type AtsOperationalFamily =
  | "hit"
  | "miss"
  | "refresh"
  | "client_err"
  | "infra_err";

export type QueryDimension =
  | "region"
  | "pop"
  | "contentType"
  | "uaFamily"
  | "host"
  | "time";

export type GlossaryEntry = {
  key: string;
  title: string;
  meaning: string;
  opsHint?: string;

  // Friendly user-facing language for parser/lexicon reuse
  aliases: string[];

  // Helps group terms later in UI / glossary views
  category: GlossaryCategory;

  // NEW: maps raw ATS/CRC codes into the backend’s 5 operational buckets
  family: AtsOperationalFamily;

  // True if we want this term available for "what is..." style questions
  definitionSupported: boolean;

  // True only if this term can safely participate in deterministic query flows
  // through current or planned sqlBuilder-backed paths
  querySupported: boolean;

  // Optional hint for parser / future exploration routing
  queryDimensions?: QueryDimension[];

  // Optional grouping for compare/trend/breakdown style requests
  queryMetricFamily?: "ats_crc";

  // Optional for future explain layer / ranking / UI grouping
  importance?: "high" | "medium" | "low";
};

function normalizeGlossaryToken(raw: string): string {
  return String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/[-\s]+/g, "_");
}

function uniqueNormalized(values: string[]): string[] {
  return Array.from(
    new Set(values.map((v) => normalizeGlossaryToken(v)).filter(Boolean))
  );
}

function defineEntry(
  entry: Omit<GlossaryEntry, "key" | "aliases"> & {
    key: string;
    aliases?: string[];
  }
): GlossaryEntry {
  return {
    ...entry,
    aliases: uniqueNormalized([entry.key, entry.title, ...(entry.aliases || [])]),
  };
}

export const ATS_CRC_GLOSSARY: Record<string, GlossaryEntry> = {
  tcp_hit: defineEntry({
    key: "tcp_hit",
    title: "TCP_HIT",
    meaning: "A valid object was served directly from cache.",
    opsHint: "Healthy cache behavior. Use as a baseline when comparing cache efficiency.",
    aliases: ["tcp hit", "cache hit", "hit", "served from cache"],
    category: "ats_hit",
    family: "hit",
    definitionSupported: true,
    querySupported: true,
    queryDimensions: ["time", "region", "pop", "contentType", "uaFamily", "host"],
    queryMetricFamily: "ats_crc",
    importance: "high",
  }),

  tcp_miss: defineEntry({
    key: "tcp_miss",
    title: "TCP_MISS",
    meaning: "The object was not served from cache and was fetched from origin or parent.",
    opsHint: "Sustained increases may indicate cache churn, poor cacheability, or new demand patterns.",
    aliases: ["tcp miss", "cache miss", "miss", "origin fetch", "fetched from origin"],
    category: "ats_miss",
    family: "miss",
    definitionSupported: true,
    querySupported: true,
    queryDimensions: ["time", "region", "pop", "contentType", "uaFamily", "host"],
    queryMetricFamily: "ats_crc",
    importance: "high",
  }),

  tcp_refresh_hit: defineEntry({
    key: "tcp_refresh_hit",
    title: "TCP_REFRESH_HIT",
    meaning: "A stale cached object was revalidated with origin and served after a 304-style refresh success.",
    opsHint: "Normal revalidation path. Watch for unusual spikes if origin revalidation load increases.",
    aliases: ["tcp refresh hit", "refresh hit", "revalidated hit", "304 refresh hit"],
    category: "ats_refresh",
    family: "refresh",
    definitionSupported: true,
    querySupported: true,
    queryDimensions: ["time", "region", "pop", "contentType", "uaFamily", "host"],
    queryMetricFamily: "ats_crc",
    importance: "medium",
  }),

  tcp_ref_fail_hit: defineEntry({
    key: "tcp_ref_fail_hit",
    title: "TCP_REF_FAIL_HIT",
    meaning: "Traffic Server attempted to refresh a stale cached object, but origin did not respond, so the stale object was still served.",
    opsHint: "Can indicate origin instability while cache is masking impact. Very useful incident signal.",
    aliases: [
      "tcp ref fail hit",
      "ref fail hit",
      "refresh fail hit",
      "stale served on refresh failure",
      "origin refresh failed",
    ],
    category: "ats_refresh",
    family: "refresh",
    definitionSupported: true,
    querySupported: true,
    queryDimensions: ["time", "region", "pop", "contentType", "uaFamily", "host"],
    queryMetricFamily: "ats_crc",
    importance: "high",
  }),

  tcp_client_refresh: defineEntry({
    key: "tcp_client_refresh",
    title: "TCP_CLIENT_REFRESH",
    meaning: "The client forced a refresh (for example with no-cache), so Traffic Server fetched a fresh object and replaced the cached one.",
    opsHint: "Spikes may reflect client no-cache behavior, app/device logic, or unusual request patterns.",
    aliases: [
      "tcp client refresh",
      "client refresh",
      "no cache refresh",
      "no-cache refresh",
      "forced refresh",
    ],
    category: "ats_client_refresh",
    family: "refresh",
    definitionSupported: true,
    querySupported: true,
    queryDimensions: ["time", "region", "pop", "contentType", "uaFamily", "host"],
    queryMetricFamily: "ats_crc",
    importance: "high",
  }),

  tcp_swapfail: defineEntry({
    key: "tcp_swapfail",
    title: "TCP_SWAPFAIL",
    meaning: "The object existed in cache but could not be accessed, and the client did not receive it.",
    opsHint: "Potential cache disk/corruption/storage issue. Important if it appears beyond low background noise.",
    aliases: ["tcp swapfail", "swapfail", "cache swap fail", "cache access failure"],
    category: "ats_cache_failure",
    family: "infra_err",
    definitionSupported: true,
    querySupported: true,
    queryDimensions: ["time", "region", "pop", "contentType", "uaFamily", "host"],
    queryMetricFamily: "ats_crc",
    importance: "high",
  }),

  err_connect_fail: defineEntry({
    key: "err_connect_fail",
    title: "ERR_CONNECT_FAIL",
    meaning: "Traffic Server could not establish a connection to origin.",
    opsHint: "Strong origin reachability signal. Check routing, firewall, origin health, and upstream connectivity.",
    aliases: [
      "err connect fail",
      "connect fail",
      "origin connect fail",
      "origin unreachable",
      "could not reach origin",
    ],
    category: "origin_failure",
    family: "infra_err",
    definitionSupported: true,
    querySupported: true,
    queryDimensions: ["time", "region", "pop", "contentType", "uaFamily", "host"],
    queryMetricFamily: "ats_crc",
    importance: "high",
  }),

  err_dns_fail: defineEntry({
    key: "err_dns_fail",
    title: "ERR_DNS_FAIL",
    meaning: "DNS could not resolve the origin hostname, or no DNS resolver could be reached.",
    opsHint: "Check DNS outage, resolver health, DNS latency, and hostname configuration.",
    aliases: [
      "err dns fail",
      "dns fail",
      "dns failure",
      "origin dns fail",
      "resolver failure",
    ],
    category: "dns_failure",
    family: "infra_err",
    definitionSupported: true,
    querySupported: true,
    queryDimensions: ["time", "region", "pop", "contentType", "uaFamily", "host"],
    queryMetricFamily: "ats_crc",
    importance: "high",
  }),

  err_read_timeout: defineEntry({
    key: "err_read_timeout",
    title: "ERR_READ_TIMEOUT",
    meaning: "Origin did not respond within the configured timeout interval.",
    opsHint: "Good signal for slow/unresponsive origin or upstream saturation.",
    aliases: [
      "err read timeout",
      "read timeout",
      "origin timeout",
      "origin read timeout",
      "upstream timeout",
    ],
    category: "timeout",
    family: "infra_err",
    definitionSupported: true,
    querySupported: true,
    queryDimensions: ["time", "region", "pop", "contentType", "uaFamily", "host"],
    queryMetricFamily: "ats_crc",
    importance: "high",
  }),

  err_client_abort: defineEntry({
    key: "err_client_abort",
    title: "ERR_CLIENT_ABORT",
    meaning: "The client disconnected before the full object was sent.",
    opsHint: "Often user/device/network aborts. Look for spikes by UA, region, or POP.",
    aliases: ["err client abort", "client abort", "client disconnected early", "aborted download"],
    category: "client_error",
    family: "client_err",
    definitionSupported: true,
    querySupported: true,
    queryDimensions: ["time", "region", "pop", "contentType", "uaFamily", "host"],
    queryMetricFamily: "ats_crc",
    importance: "medium",
  }),

  err_client_read_error: defineEntry({
    key: "err_client_read_error",
    title: "ERR_CLIENT_READ_ERROR",
    meaning: "The client encountered read-side network problems while receiving the object.",
    opsHint: "Often last-mile, device, or connectivity issues rather than edge cache problems.",
    aliases: [
      "err client read error",
      "client read error",
      "client network read error",
      "last mile read error",
    ],
    category: "client_error",
    family: "client_err",
    definitionSupported: true,
    querySupported: true,
    queryDimensions: ["time", "region", "pop", "contentType", "uaFamily", "host"],
    queryMetricFamily: "ats_crc",
    importance: "medium",
  }),

  err_invalid_req: defineEntry({
    key: "err_invalid_req",
    title: "ERR_INVALID_REQ",
    meaning: "The HTTP request from the client was invalid or malformed.",
    opsHint: "Can indicate malformed clients, bots, or bad request construction. Check samples and UA distribution.",
    aliases: ["err invalid req", "invalid request", "malformed request", "bad client request"],
    category: "client_error",
    family: "client_err",
    definitionSupported: true,
    querySupported: true,
    queryDimensions: ["time", "region", "pop", "contentType", "uaFamily", "host"],
    queryMetricFamily: "ats_crc",
    importance: "medium",
  }),

  err_proxy_denied: defineEntry({
    key: "err_proxy_denied",
    title: "ERR_PROXY_DENIED",
    meaning: "Traffic Server denied service to the client.",
    opsHint: "Check ACLs, auth/token rules, geo/policy blocks, or service-level denial conditions.",
    aliases: ["err proxy denied", "proxy denied", "request denied", "access denied"],
    category: "proxy_denial",
    family: "client_err",
    definitionSupported: true,
    querySupported: true,
    queryDimensions: ["time", "region", "pop", "contentType", "uaFamily", "host"],
    queryMetricFamily: "ats_crc",
    importance: "medium",
  }),

  err_unknown: defineEntry({
    key: "err_unknown",
    title: "ERR_UNKNOWN",
    meaning: "The client connected but disconnected without sending a valid request.",
    opsHint: "Often scans, connection churn, or incomplete client behavior. Correlate with connection metrics.",
    aliases: ["err unknown", "unknown error", "unknown client disconnect"],
    category: "unknown",
    family: "client_err",
    definitionSupported: true,
    querySupported: true,
    queryDimensions: ["time", "region", "pop", "contentType", "uaFamily", "host"],
    queryMetricFamily: "ats_crc",
    importance: "low",
  }),
};

const ATS_CRC_ALIAS_INDEX: Record<string, GlossaryEntry> = Object.values(
  ATS_CRC_GLOSSARY
)
  .flatMap((entry) => entry.aliases.map((alias) => [alias, entry] as const))
  .reduce<Record<string, GlossaryEntry>>((acc, [alias, entry]) => {
    acc[alias] = entry;
    return acc;
  }, {});

export function lookupAtsCrc(raw: string): GlossaryEntry | null {
  const token = normalizeGlossaryToken(raw);
  if (!token) return null;
  return ATS_CRC_ALIAS_INDEX[token] || ATS_CRC_GLOSSARY[token] || null;
}

export function isDefinitionQuestion(text: string): boolean {
  const t = String(text || "").trim().toLowerCase();
  return (
    t.startsWith("what is ") ||
    t.startsWith("what’s ") ||
    t.startsWith("whats ") ||
    t.startsWith("define ") ||
    t.startsWith("meaning of ") ||
    t.startsWith("explain ")
  );
}

export function extractTermFromDefinitionQuestion(text: string): string {
  const t = String(text || "").trim();
  const m =
    t.match(/^(what is|what’s|whats|define|meaning of|explain)\s+(.+)$/i) || [];
  const term = (m[2] || "").trim();
  return term.replace(/[?.!]+$/g, "").trim();
}

export function getAllAtsCrcGlossaryEntries(): GlossaryEntry[] {
  return Object.values(ATS_CRC_GLOSSARY);
}

export function getAtsCrcLexiconSeeds(): Array<{
  canonical: string;
  aliases: string[];
  category: GlossaryCategory;
  family: AtsOperationalFamily;
  querySupported: boolean;
}> {
  return Object.values(ATS_CRC_GLOSSARY).map((entry) => ({
    canonical: entry.key,
    aliases: entry.aliases,
    category: entry.category,
    family: entry.family,
    querySupported: entry.querySupported,
  }));
}
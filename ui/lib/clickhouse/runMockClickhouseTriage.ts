// lib/clickhouse/runMockClickhouseTriage.ts
// Public-safe mock ClickHouse runner.
// Returns CANONICAL metricsJson only (generator is truth).
// No legacy keys like requests/p95_ms/errors_5xx are returned.
//
// Level-2 time support:
// - Relative: windowMinutes + anchorToMaxTs (existing behavior)
// - Absolute: startTsUtc + endTsUtc (UTC ISO), overrides anchoring, generates points inside range

import type { ClickhouseTriageInputs, ClickhouseTriageResult } from "./runClickhouseTriage";
import { CANON } from "@/lib/schema/canonical";

// -----------------------------
// Helpers (deterministic mock)
// -----------------------------
function hashToInt(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}
function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}
function round(n: number) {
  return Math.round(n);
}
function pct(n: number, digits = 2) {
  if (!Number.isFinite(n)) return "n/a";
  return `${n.toFixed(digits)}%`;
}
function ms(n: number | null) {
  if (n == null || !Number.isFinite(n)) return "n/a";
  return `${Math.round(n)} ms`;
}
function int(n: number) {
  if (!Number.isFinite(n)) return "0";
  return `${Math.round(n)}`;
}
function uniqLower(arr: string[]) {
  const out = Array.from(new Set(arr.map((x) => String(x || "").trim().toLowerCase()).filter(Boolean)));
  out.sort((a, b) => a.localeCompare(b));
  return out;
}
function uniqLowerLimit(arr: string[], limit = 24) {
  return uniqLower(arr).slice(0, limit);
}
function stablePick<T>(arr: T[], seed: number, n: number): T[] {
  if (!arr.length) return [];
  const out: T[] = [];
  for (let i = 0; i < Math.min(n, arr.length); i++) {
    const idx = (seed + i * 17) % arr.length;
    out.push(arr[idx]);
  }
  const seen = new Set<any>();
  return out.filter((x) => (seen.has(x) ? false : (seen.add(x), true)));
}
function stableColorKeyList(arr: string[], seed: number, n: number) {
  const uniq = uniqLower(arr);
  const picked = stablePick(uniq, seed, Math.min(n, uniq.length));
  return picked.length ? picked : uniq.slice(0, n);
}
function normalizeToken(v: unknown, fallback = "") {
  const s = String(v ?? "").trim().toLowerCase();
  return s || fallback;
}

// stable quantile helper (no in-place mutation surprises)
function quantile(samples: number[], q: number) {
  if (!samples.length) return null;
  const s = samples.slice().sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.floor(q * (s.length - 1))));
  return s[idx];
}

function parseIsoMs(v: unknown): number | null {
  const s = typeof v === "string" ? v.trim() : "";
  if (!s) return null;
  const ms = Date.parse(s);
  if (!Number.isFinite(ms)) return null;
  return ms;
}

function floorToBucket(ms: number, bucketMs: number) {
  return Math.floor(ms / bucketMs) * bucketMs;
}
function ceilToBucket(ms: number, bucketMs: number) {
  return Math.ceil(ms / bucketMs) * bucketMs;
}

function buildAvailableFromUniverse(universe: {
  regions: string[];
  pops: string[];
  serviceBuckets: string[];
  svcs: string[];
  edgeHosts: string[];
  crcClasses: string[];
  crcs: string[];
  statusCodes: (number | string)[];
  contentTypes: string[];
  uaFamilies: string[];
}) {
  return {
    regions: uniqLower(universe.regions).slice(0, 80),
    pops: uniqLower(universe.pops).slice(0, 120),
    serviceBuckets: uniqLower(universe.serviceBuckets).slice(0, 24),
    svcs: uniqLower(universe.svcs).slice(0, 24),
    edgeHosts: uniqLower(universe.edgeHosts).slice(0, 48),
    crcClasses: uniqLower(universe.crcClasses).slice(0, 12),
    crcs: uniqLower(universe.crcs).slice(0, 24),
    statusCodes: Array.from(new Set(universe.statusCodes.map((x) => String(x)).filter(Boolean)))
      .sort((a, b) => Number(a) - Number(b))
      .slice(0, 24),
    contentTypes: uniqLowerLimit(universe.contentTypes, 24),
    uaFamilies: uniqLowerLimit(universe.uaFamilies, 24),
  };
}

// -----------------------------
// Canonical region/POP model (Step A)
// -----------------------------
function generateHosts(region: string, pop: string, seed: number, count = 5) {
  const out: string[] = [];
  for (let i = 1; i <= count; i++) {
    const id = String(((seed + i * 97) % 999) + 1).padStart(3, "0");
    out.push(`edge-${region}-${pop}-${id}`.toLowerCase());
  }
  return out;
}

function buildScopedPopsAndHostsCanon(region: string, pop: string, seed: number) {
  const r = String(region || "all").toLowerCase();
  const p = String(pop || "all").toLowerCase();

  const canonRegions = (CANON.regions as readonly string[]).map(String);
  const canonPops = (CANON.pops as readonly string[]).map(String);

  const effectiveRegion =
    r !== "all" && canonRegions.includes(r) ? r : stablePick(canonRegions, seed, 1)[0] || "us-east";

  let scopedPops: string[] = [];
  if (p !== "all") {
    scopedPops = [p];
  } else {
    const n = seed % 2 === 0 ? 2 : 3;
    scopedPops = stablePick(canonPops, seed + hashToInt(effectiveRegion), n);
  }

  const hostSeries = scopedPops.flatMap((pp, idx) =>
    generateHosts(effectiveRegion, pp, seed + idx * 101, p !== "all" ? 6 : 3)
  );

  return { effectiveRegion, scopedPops, hostSeries };
}

function buildRegionBreakdown(args: {
  canonRegions: string[];
  scopedRegion: string;
  totalRequests: number;
  baseErrorPct: number;
  baseP95: number;
  cacheHitPct: number;
  seed: number;
}) {
  const { canonRegions, scopedRegion, totalRequests, baseErrorPct, baseP95, cacheHitPct, seed } = args;

  const rows = canonRegions.map((region, idx) => {
    const regionSeed = hashToInt(`${seed}|region|${region}|${idx}`);
    const emphasis = region === scopedRegion ? 1.35 : 1.0;

    const requestShare = clamp(0.07 + ((regionSeed % 17) / 100), 0.07, 0.23);
    const requests = Math.max(1000, round(totalRequests * requestShare * emphasis));

    const errPct = clamp(baseErrorPct * (0.7 + ((regionSeed % 9) / 10)) * emphasis, 0.01, 12);
    const p95 = round(baseP95 * (0.85 + ((regionSeed % 7) / 20)) * (region === scopedRegion ? 1.08 : 1.0));
    const cacheHitRate = clamp(
      cacheHitPct * (0.85 + ((regionSeed % 11) / 50)) * (region === scopedRegion ? 0.94 : 1.0),
      1,
      99
    );
    const error5xxCount = round((requests * errPct) / 100);

    return {
      region,
      totalRequests: requests,
      error5xxCount,
      errorRatePct: errPct,
      p95TtmsMs: p95,
      cacheHitRate,
    };
  });

  rows.sort((a, b) => {
    if (b.errorRatePct !== a.errorRatePct) return b.errorRatePct - a.errorRatePct;
    if (b.p95TtmsMs !== a.p95TtmsMs) return b.p95TtmsMs - a.p95TtmsMs;
    return b.totalRequests - a.totalRequests;
  });

  return rows;
}

function buildPopBreakdown(args: {
  canonPops: string[];
  scopedPops: string[];
  totalRequests: number;
  baseErrorPct: number;
  baseP95: number;
  cacheHitPct: number;
  seed: number;
}) {
  const { canonPops, scopedPops, totalRequests, baseErrorPct, baseP95, cacheHitPct, seed } = args;

  const scopedSet = new Set(scopedPops);

  const rows = canonPops.map((pop, idx) => {
    const popSeed = hashToInt(`${seed}|pop|${pop}|${idx}`);
    const emphasis = scopedSet.has(pop) ? 1.3 : 1.0;

    const requestShare = clamp(0.015 + ((popSeed % 13) / 500), 0.015, 0.05);
    const requests = Math.max(500, round(totalRequests * requestShare * emphasis));

    const errPct = clamp(baseErrorPct * (0.8 + ((popSeed % 11) / 8)) * emphasis, 0.01, 15);
    const p95 = round(baseP95 * (0.9 + ((popSeed % 9) / 18)) * (scopedSet.has(pop) ? 1.06 : 1.0));
    const cacheHitRate = clamp(
      cacheHitPct * (0.82 + ((popSeed % 13) / 55)) * (scopedSet.has(pop) ? 0.93 : 1.0),
      1,
      99
    );
    const error5xxCount = round((requests * errPct) / 100);

    return {
      pop,
      totalRequests: requests,
      error5xxCount,
      errorRatePct: errPct,
      p95TtmsMs: p95,
      cacheHitRate,
    };
  });

  rows.sort((a, b) => {
    if (b.errorRatePct !== a.errorRatePct) return b.errorRatePct - a.errorRatePct;
    if (b.p95TtmsMs !== a.p95TtmsMs) return b.p95TtmsMs - a.p95TtmsMs;
    return b.totalRequests - a.totalRequests;
  });

  return rows;
}

// -----------------------------
// Mock runner (CANON-only output)
// -----------------------------
//
// NOTE: we allow extra "runner-provided meta" fields via (inputs as any)
// because ClickhouseTriageInputs is shared with real runner.
// These are passed from runClickhouseTriage (or route later):
//   - bucketSeconds: 60|900
//   - tableUsed: "cachey.raw_minute"|"cachey.agg_15m"
//   - anchorToMaxTs: boolean
//   - startTsUtc/endTsUtc: ISO strings (absolute mode)
//
export async function runMockClickhouseTriage(
  inputs: ClickhouseTriageInputs
): Promise<ClickhouseTriageResult> {
  const partner = normalizeToken(inputs.partner);
  const service = normalizeToken(inputs.service);
  const region = normalizeToken(inputs.region, "all");
  const pop = normalizeToken(inputs.pop, "all");
  const contentType = normalizeToken(inputs.contentType, "all");
  const uaFamily = normalizeToken(inputs.uaFamily, "all");
  const windowMinutes = Number(inputs.windowMinutes) || 60;
  const debug = !!inputs.debug;

  // Runner-provided meta (optional)
  const bucketSecondsIn = Number((inputs as any)?.bucketSeconds);
  const bucketSeconds =
    bucketSecondsIn === 60 || bucketSecondsIn === 900 ? bucketSecondsIn : 60;

  const tableUsedRaw = String((inputs as any)?.tableUsed || "cachey.raw_minute");
  const tableUsed =
    tableUsedRaw === "cachey.agg_15m" || tableUsedRaw === "cachey.raw_minute"
      ? tableUsedRaw
      : "cachey.raw_minute";

  // Absolute range (optional)
  const startTsUtcIn = (inputs as any)?.startTsUtc ?? null;
  const endTsUtcIn = (inputs as any)?.endTsUtc ?? null;
  const absStartMs = parseIsoMs(startTsUtcIn);
  const absEndMs = parseIsoMs(endTsUtcIn);
  const isAbsolute = absStartMs != null && absEndMs != null;

  // Anchor (ignored for absolute)
  const anchorToMaxTs = isAbsolute ? false : !!(inputs as any)?.anchorToMaxTs;

  const bucketMs = bucketSeconds * 1000;

  // IMPORTANT: include meta in seed so switching table/bucket/range changes output deterministically
  const seed = hashToInt(
    [
      partner,
      service,
      region,
      pop,
      contentType,
      uaFamily,
      `win=${windowMinutes}`,
      `bucket=${bucketSeconds}`,
      `table=${tableUsed}`,
      `anchor=${anchorToMaxTs ? "max" : "now"}`,
      isAbsolute ? `abs=${new Date(absStartMs!).toISOString()}..${new Date(absEndMs!).toISOString()}` : "abs=none",
    ].join("|")
  );

  const canonRegions = (CANON.regions as readonly string[]).map(String);
  const canonPops = (CANON.pops as readonly string[]).map(String);
  const canonServices = (CANON.services as readonly string[]).map(String);
  const canonContentTypes = (CANON.contentTypes as readonly string[]).map(String);
  const canonUaFamilies = (CANON.uaFamilies as readonly string[]).map(String);

  const baseTraffic = 5000 + (seed % 25000);
  const noise = (seed % 1000) / 1000;

  // CRC/status universes are mock-only (not part of CANON vocab step)
  const crcUniverse = [
    "TCP_HIT",
    "TCP_MISS",
    "TCP_CF_HIT",
    "ERR_TIMEOUT",
    "ERR_DNS",
    "TCP_CLIENT_REFRESH",
    "ERR_CONN_RESET",
    "ERR_ORIGIN_5XX",
  ];
  const crcClassUniverse = ["hit", "miss", "client", "error", "other"];
  const statusUniverse = [200, 206, 304, 403, 404, 429, 500, 502, 503, 504];

  const { effectiveRegion, scopedPops, hostSeries } = buildScopedPopsAndHostsCanon(region, pop, seed);

  const available = buildAvailableFromUniverse({
    regions: canonRegions,
    pops: canonPops,
    serviceBuckets: canonServices,
    svcs: canonServices,
    edgeHosts: hostSeries,
    crcClasses: crcClassUniverse,
    crcs: crcUniverse,
    statusCodes: statusUniverse,
    contentTypes: canonContentTypes,
    uaFamilies: canonUaFamilies,
  });

  // Time bounds
  let startAlignedMs: number;
  let endAlignedMs: number;

  if (isAbsolute) {
    // Align to buckets; treat end as exclusive.
    startAlignedMs = floorToBucket(absStartMs!, bucketMs);
    endAlignedMs = ceilToBucket(absEndMs!, bucketMs);

    // Ensure at least 1 bucket.
    if (!Number.isFinite(startAlignedMs) || !Number.isFinite(endAlignedMs) || endAlignedMs <= startAlignedMs) {
      endAlignedMs = startAlignedMs + bucketMs;
    }
  } else {
    // Existing behavior: anchor to "max(ts)" (simulated lag) or "now()"
    const nowMs = Date.now();
    const nowAlignedMs = floorToBucket(nowMs, bucketMs);

    // stable synthetic "max(ts)" lag (0..~3 buckets), deterministic per seed
    const maxLagBuckets = Math.min(3, Math.max(0, seed % 4));
    endAlignedMs = anchorToMaxTs ? nowAlignedMs - maxLagBuckets * bucketMs : nowAlignedMs;

    const spanMinutes = Math.max(1, Number(windowMinutes) || 60);
    const spanBuckets = Math.max(1, Math.ceil((spanMinutes * 60) / bucketSeconds));
    startAlignedMs = endAlignedMs - spanBuckets * bucketMs;
  }

  const startISO = new Date(startAlignedMs).toISOString();
  const endISO = new Date(endAlignedMs).toISOString();

  const spanBuckets = Math.max(1, Math.floor((endAlignedMs - startAlignedMs) / bucketMs));
  const spanMinutesEffective = Math.max(1, Math.round((endAlignedMs - startAlignedMs) / 60000));

  const baseErrorPct = (service === "live" ? 0.9 : service === "vod" ? 0.5 : 0.7) + noise * 1.2;

  const baseP95 = (service === "live" ? 180 : service === "vod" ? 240 : 210) + (seed % 120);
  const baseP99 = baseP95 + 120 + (seed % 180);

  let totalRequests = 0;
  let total5xx = 0;
  const ttmsP95Samples: number[] = [];
  const ttmsP99Samples: number[] = [];

  const statusCodeSeries = statusUniverse.map(String);
  const crcSeries = crcUniverse.map((c) => String(c).toUpperCase()).slice(0, 10);

  const points: Array<{
    ts: string;
    totalRequests: number;
    error5xxCount: number;
    errorRatePct: number;
    p95TtmsMs: number;
    p99TtmsMs: number;
    statusCountsByCode: Record<string, number>;
    hostCountsByHost: Record<string, number>;
    crcCountsByCrc: Record<string, number>;
  }> = [];

  // Force a visible anomaly when debug=true (for UI testing)
  const forceAnomaly = !!debug;
  const forcedBuckets = bucketSeconds === 900 ? 4 : 20;

  // Stable “top hosts” ordering (keeps legends stable)
  const hostSeriesOrdered = stableColorKeyList(hostSeries, seed, Math.min(18, hostSeries.length));

  for (let bi = 0; bi < spanBuckets; bi++) {
    const t = startAlignedMs + bi * bucketMs;

    const wave = 0.75 + 0.5 * Math.sin((bi / Math.max(8, spanBuckets)) * Math.PI * 2);

    let req = round(((baseTraffic * wave * (0.6 + noise * 0.8)) / spanBuckets) * 60);
    req = Math.max(req, 250);

    const isForcedRange = forceAnomaly && bi >= Math.max(0, spanBuckets - forcedBuckets);

    const randomErrSpike = seed % 7 === 0 && bi > Math.floor(spanBuckets * 0.75) ? 2.5 : 1.0;
    const randomP95Spike = seed % 11 === 0 && bi > Math.floor(spanBuckets * 0.8) ? 2.2 : 1.0;

    const errSpike = isForcedRange ? 6.0 : randomErrSpike;
    const p95Spike = isForcedRange ? 2.8 : randomP95Spike;

    const errPctPoint = clamp(baseErrorPct * errSpike * (0.75 + 0.5 * Math.cos(bi / 3)), 0, 35);
    const err5xx = round((req * errPctPoint) / 100);

    const p95 = round(baseP95 * p95Spike * (0.9 + 0.25 * Math.sin(bi / 5)));
    const p99 = round(baseP99 * Math.max(1.0, p95Spike * 0.9) * (0.9 + 0.25 * Math.cos(bi / 6)));

    totalRequests += req;
    total5xx += err5xx;
    ttmsP95Samples.push(p95);
    ttmsP99Samples.push(p99);

    const statusCountsByCode: Record<string, number> = {};
    const hostCountsByHost: Record<string, number> = {};
    const crcCountsByCrc: Record<string, number> = {};

    const s200 = round(req * 0.78);
    const s206 = round(req * 0.12);
    const s304 = round(req * 0.03);
    const s4xx = round(req * 0.03);
    const s5xx = Math.max(0, err5xx);

    statusCountsByCode["200"] = s200;
    statusCountsByCode["206"] = s206;
    statusCountsByCode["304"] = s304;
    statusCountsByCode["403"] = round(s4xx * 0.25);
    statusCountsByCode["404"] = round(s4xx * 0.35);
    statusCountsByCode["429"] = Math.max(0, s4xx - statusCountsByCode["403"] - statusCountsByCode["404"]);
    statusCountsByCode["500"] = round(s5xx * 0.22);
    statusCountsByCode["502"] = round(s5xx * 0.18);
    statusCountsByCode["503"] = round(s5xx * 0.35);
    statusCountsByCode["504"] = Math.max(
      0,
      s5xx - statusCountsByCode["500"] - statusCountsByCode["502"] - statusCountsByCode["503"]
    );

    let remainingHost = req;
    for (let hi = 0; hi < hostSeriesOrdered.length; hi++) {
      const baseShare = 0.18 - hi * 0.02;
      const share = hi === hostSeriesOrdered.length - 1 ? remainingHost : round(req * clamp(baseShare, 0.04, 0.18));
      const v = clamp(share, 0, remainingHost);
      hostCountsByHost[hostSeriesOrdered[hi]] = v;
      remainingHost -= v;
      if (remainingHost <= 0) break;
    }
    if (remainingHost > 0) {
      hostCountsByHost["other"] = (hostCountsByHost["other"] ?? 0) + remainingHost;
    }

    const hit = round(req * 0.7);
    const miss = round(req * 0.1);
    const client = round(req * 0.02);
    const errs = Math.max(0, err5xx);

    crcCountsByCrc["TCP_HIT"] = hit;
    crcCountsByCrc["TCP_MISS"] = miss;
    crcCountsByCrc["TCP_CLIENT_REFRESH"] = client;
    crcCountsByCrc["ERR_TIMEOUT"] = round(errs * 0.42);
    crcCountsByCrc["ERR_DNS"] = round(errs * 0.18);
    crcCountsByCrc["ERR_CONN_RESET"] = round(errs * 0.12);
    crcCountsByCrc["ERR_ORIGIN_5XX"] = Math.max(
      0,
      errs - crcCountsByCrc["ERR_TIMEOUT"] - crcCountsByCrc["ERR_DNS"] - crcCountsByCrc["ERR_CONN_RESET"]
    );

    points.push({
      ts: new Date(t).toISOString(),
      totalRequests: req,
      error5xxCount: err5xx,
      errorRatePct: req ? (err5xx / req) * 100 : 0,
      p95TtmsMs: p95,
      p99TtmsMs: p99,
      statusCountsByCode,
      hostCountsByHost,
      crcCountsByCrc,
    });
  }

  const p95TtmsMs = quantile(ttmsP95Samples, 0.95);
  const p99TtmsMs = quantile(ttmsP99Samples, 0.99);

  const cacheHitPct =
    service === "vod" ? clamp(82 + (seed % 12) - noise * 4, 20, 99) : clamp(68 + (seed % 18) - noise * 6, 10, 95);
  const cacheMissPct = clamp(100 - cacheHitPct, 0, 100);

  const statusCounts = [
    { code: 200, count: round(totalRequests * 0.78) },
    { code: 206, count: round(totalRequests * 0.12) },
    { code: 304, count: round(totalRequests * 0.03) },
    { code: 403, count: round(totalRequests * 0.01) },
    { code: 404, count: round(totalRequests * 0.01) },
    { code: 429, count: round(totalRequests * 0.01) },
    { code: 500, count: round(total5xx * 0.22) },
    { code: 502, count: round(total5xx * 0.18) },
    { code: 503, count: round(total5xx * 0.35) },
    { code: 504, count: round(total5xx * 0.25) },
  ].filter((x) => x.count > 0);

  const topCrcClass = [
    { crc_class: "hit", count: round(totalRequests * (cacheHitPct / 100) * 0.95) },
    { crc_class: "miss", count: round(totalRequests * (cacheMissPct / 100) * 0.85) },
    { crc_class: "client", count: round(totalRequests * 0.02) },
    { crc_class: "error", count: round(total5xx * 0.75) },
  ].filter((x) => x.count > 0);

  const topErrorCrc = [
    { crc: "ERR_TIMEOUT", count: round(total5xx * 0.42) },
    { crc: "ERR_DNS", count: round(total5xx * 0.18) },
    { crc: "ERR_CONN_RESET", count: round(total5xx * 0.12) },
    { crc: "ERR_ORIGIN_5XX", count: round(total5xx * 0.28) },
  ].filter((x) => x.count > 0);

  const errorRatePct = totalRequests ? (total5xx / totalRequests) * 100 : 0;

  const regionBreakdown = buildRegionBreakdown({
    canonRegions,
    scopedRegion: effectiveRegion,
    totalRequests,
    baseErrorPct,
    baseP95,
    cacheHitPct,
    seed,
  });

  const popBreakdown = buildPopBreakdown({
    canonPops,
    scopedPops,
    totalRequests,
    baseErrorPct,
    baseP95,
    cacheHitPct,
    seed,
  });

  const warnings: string[] = [];
  if (totalRequests === 0) warnings.push("No rows matched (mock produced 0 requests).");
  if (debug) warnings.push(`debug=true: forcing spikes in last ${forcedBuckets} buckets for UI testing.`);
  if (isAbsolute) warnings.push("absolute range mode: startTsUtc/endTsUtc provided; using explicit UTC bounds.");

  const windowLabel = isAbsolute ? `abs(${spanMinutesEffective}m)` : `${windowMinutes}m`;

  const summaryText = [
    `🧭 *CDN TRIAGE SUMMARY*`,
    `• Source: \`clickhouse (mock)\` • partner=\`${partner}\``,
    `• Scope: service=\`${service}\`  region=\`${region}\`  pop=\`${pop}\``,
    `• Filters: contentType=\`${contentType}\` uaFamily=\`${uaFamily}\``,
    `• Window: \`${windowLabel}\`  • Time (UTC): \`${startISO}\` → \`${endISO}\``,
    `• Bucket: \`${bucketSeconds}s\`  • Table: \`${tableUsed}\`  • Anchor: \`${anchorToMaxTs ? "max(ts)" : "explicit-range"}\``,
    ...(warnings.length ? ["", `⚠️ *Warnings*`, ...warnings.map((w) => `• ${w}`)] : []),
    "",
    `📊 *Traffic & Performance*`,
    `• Requests: *${int(totalRequests)}*`,
    `• P95 TTMS: *${ms(p95TtmsMs)}*`,
    `• P99 TTMS: *${ms(p99TtmsMs)}*`,
    `• Cache Hit: *${pct(cacheHitPct)}*  (miss ${pct(cacheMissPct)})`,
    "",
    `🧾 *Evidence*`,
    `• Error responses: ${int(total5xx)}/${int(totalRequests)} (${pct(errorRatePct)}).`,
    "",
    `🔧 *Mock scope*`,
    `• effectiveRegion(for hosts)=\`${effectiveRegion}\``,
    `• scopedPops(for hosts)=\`${scopedPops.join(", ")}\``,
  ].join("\n");

  const sql = debug
    ? {
        queries: [
          [
            `-- MOCK SQL (public-safe, illustrative only)`,
            `-- Partner: ${partner}`,
            `-- Table(selected): ${tableUsed}`,
            `-- Bucket(selected): ${bucketSeconds}s`,
            `-- Anchor(selected): ${anchorToMaxTs ? "max(ts)" : "explicit-range"}`,
            isAbsolute ? `-- Absolute range: ${startISO} → ${endISO} (UTC)` : `-- Relative window: last ${windowMinutes}m`,
            `SELECT`,
            `  toStartOfInterval(ts, INTERVAL ${bucketSeconds} SECOND) AS bucket,`,
            `  count() AS totalRequests,`,
            `  countIf(edge_status >= 500 AND edge_status < 600) AS error5xxCount,`,
            `  quantileExact(0.95)(ttms_ms) AS p95TtmsMs,`,
            `  quantileExact(0.99)(ttms_ms) AS p99TtmsMs`,
            `FROM edge_logs`,
            `WHERE partner = '${partner}'`,
            isAbsolute
              ? `  AND ts >= toDateTime('${startISO}') AND ts < toDateTime('${endISO}')`
              : `  AND ts >= now() - INTERVAL ${windowMinutes} MINUTE`,
            `  AND service_bucket = '${service}'`,
            `  AND ('${region}' = 'all' OR region = '${region}')`,
            `  AND ('${pop}' = 'all' OR pop = '${pop}')`,
            `  AND ('${contentType}' = 'all' OR content_type = '${contentType}')`,
            `  AND ('${uaFamily}' = 'all' OR ua_family = '${uaFamily}')`,
            `GROUP BY bucket`,
            `ORDER BY bucket ASC;`,
          ].join("\n"),
        ],
      }
    : undefined;

  const metricsJson = {
    totalRequests,
    p95TtmsMs,
    p99TtmsMs,
    error5xxCount: total5xx,
    errorRatePct,

    cacheHitPct,
    cacheMissPct,
    statusCounts,
    topCrcClass,
    topErrorCrc,
    regionBreakdown,
    popBreakdown,

    available,
    timeRangeUTC: { start: startISO, end: endISO },

    timeseries: {
      bucketSeconds,
      startTs: startISO,
      endTs: endISO,
      points,
      statusCodeSeries,
      hostSeries: hostSeriesOrdered,
      crcSeries,
    },

    warnings,

    debug: {
      __runnerVersion: "mockclickhouse-vCANON-006",
      note: "ClickHouse mock runner (no real DB access).",
      forcedAnomalies: !!debug,
      forcedBuckets,
      tableUsed,
      bucketSeconds,
      anchorToMaxTs,

      // time debug fields
      startTsUtc: isAbsolute ? startISO : null,
      endTsUtc: isAbsolute ? endISO : null,
      timeMode: isAbsolute ? "absolute" : "relative",
      effectiveWindowMinutes: spanMinutesEffective,
      spanBuckets,
    },
  };

  return {
    summary: summaryText,
    summaryText,
    metricsJson,
    sql,
  };
}
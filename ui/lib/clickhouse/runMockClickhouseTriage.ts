// lib/clickhouse/runMockClickhouseTriage.ts
// Public-safe mock ClickHouse runner.
// Returns metricsJson in the SAME SHAPE as CSV runTriage() output,
// so the UI doesn't care whether dataSource=csv or clickhouse.

import type { ClickhouseTriageInputs, ClickhouseTriageResult } from "./runClickhouseTriage";

// -----------------------------
// Helpers (deterministic mock)
// -----------------------------
function hashToInt(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) >>> 0;
  }
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

function buildAvailableFromUniverse(universe: {
  regions: string[];
  pops: string[];
  serviceBuckets: string[];
  svcs: string[];
  edgeHosts: string[];
  crcClasses: string[];
  crcs: string[];
  statusCodes: (number | string)[];
}) {
  return {
    regions: uniqLower(universe.regions).slice(0, 80),
    pops: uniqLower(universe.pops).slice(0, 120),
    serviceBuckets: uniqLower(universe.serviceBuckets).slice(0, 12),
    svcs: uniqLower(universe.svcs).slice(0, 24),
    // IMPORTANT: edgeHosts should reflect the scoped pool so legends match filters
    edgeHosts: uniqLower(universe.edgeHosts).slice(0, 24),
    crcClasses: uniqLower(universe.crcClasses).slice(0, 12),
    crcs: uniqLower(universe.crcs).slice(0, 24),
    statusCodes: Array.from(new Set(universe.statusCodes.map((x) => String(x)).filter(Boolean)))
      .sort((a, b) => Number(a) - Number(b))
      .slice(0, 24),
  };
}

// ✅ Force parity with CSV: always 5-minute buckets
function chooseBucketSeconds() {
  return 300;
}

// -----------------------------
// Region/POP model for mock data
// (hosts are GENERATED from region+pop so legend is always coherent)
// -----------------------------
const REGION_POOLS: Record<string, string[]> = {
  use1: ["use1-iad", "use1-atl", "use1-nyc", "use1-bos"],
  usw2: ["usw2-sjc", "usw2-sea", "usw2-pdx"],
  eu1: ["eu1-lon", "eu1-fra", "eu1-ams"],
  ap1: ["ap1-sin", "ap1-tyo", "ap1-syd"],
};

// allow your “city-ish” region filters to map into a macro region
const REGION_ALIASES: Record<string, string> = {
  bos: "use1",
  nyc: "use1",
  iad: "use1",
  atl: "use1",
  sjc: "usw2",
  sea: "usw2",
  lon: "eu1",
  fra: "eu1",
  sin: "ap1",
  tyo: "ap1",
  syd: "ap1",
};

function normalizeScopeRegion(region: string) {
  const r = String(region || "all").toLowerCase();
  if (r === "all") return "all";
  if (REGION_POOLS[r]) return r;
  if (REGION_ALIASES[r]) return REGION_ALIASES[r];
  return r;
}

function generateHostsForPop(macroRegion: string, pop: string, seed: number, count = 5) {
  const out: string[] = [];
  for (let i = 1; i <= count; i++) {
    const id = String(((seed + i * 97) % 999) + 1).padStart(3, "0");
    out.push(`cdn-ec-${macroRegion}-${pop}-${id}`.toLowerCase());
  }
  return out;
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

/**
 * Returns:
 * - scopedPops: the pops that should exist under the current scope
 * - hostSeries: stable list of hosts shown in legend + used in point maps
 */
function buildScopedPopsAndHosts(region: string, pop: string, seed: number) {
  const macro = normalizeScopeRegion(region);
  const p = String(pop || "all").toLowerCase();

  let scopedPops: string[] = [];
  if (p !== "all") {
    // pop is explicit; derive macro region if possible
    const parts = p.split("-");
    const macroFromPop = parts[0]; // e.g. ap1
    const macroResolved = REGION_POOLS[macroFromPop] ? macroFromPop : macro === "all" ? macroFromPop : macro;
    scopedPops = [p];
    // hosts strictly from that pop
    const hostSeries = generateHostsForPop(macroResolved, p, seed, 6);
    return { scopedPops, hostSeries };
  }

  if (macro !== "all" && REGION_POOLS[macro]) {
    // region scoped, pop=all -> show a couple pops within region
    scopedPops = stablePick(REGION_POOLS[macro], seed, 2);
    const hostSeries = scopedPops.flatMap((pp, idx) => generateHostsForPop(macro, pp, seed + idx * 101, 3));
    return { scopedPops, hostSeries };
  }

  // all/all -> show a small cross-region set
  const macros = Object.keys(REGION_POOLS);
  const chosenMacros = stablePick(macros, seed, 3);
  scopedPops = chosenMacros.flatMap((m, idx) => stablePick(REGION_POOLS[m], seed + idx * 131, 1));
  const hostSeries = scopedPops.flatMap((pp, idx) => {
    const m = pp.split("-")[0];
    return generateHostsForPop(m, pp, seed + idx * 151, 2);
  });
  return { scopedPops, hostSeries };
}

// -----------------------------
// Mock runner
// -----------------------------
export async function runMockClickhouseTriage(inputs: ClickhouseTriageInputs): Promise<ClickhouseTriageResult> {
  const { partner, service, region, pop, windowMinutes, debug } = inputs;

  const seed = hashToInt(`${partner}|${service}|${region}|${pop}|${windowMinutes}`);
  const baseTraffic = 5000 + (seed % 25000);
  const noise = (seed % 1000) / 1000;

  const regionUniverse = ["use1", "usw2", "eu1", "ap1", "bos", "nyc", "sjc", "sea", "lon", "fra", "sin"];
  const popUniverse = [
    "use1-iad",
    "use1-atl",
    "usw2-sjc",
    "usw2-sea",
    "eu1-lon",
    "eu1-fra",
    "ap1-sin",
    "bos-044",
    "nyc-012",
    "sea-007",
    "sjc-101",
  ];

  const svcUniverse = [
    "cla-nat-smf-hd.xcr.comcast.net",
    "ccr.ipvod-ads.xcr.comcast.net",
    "live-linear.xcr.comcast.net",
    "vod-library.xcr.comcast.net",
  ];

  const crcUniverse = ["TCP_HIT", "TCP_MISS", "TCP_CF_HIT", "ERR_TIMEOUT", "ERR_DNS", "TCP_CLIENT_REFRESH", "ERR_CONN_RESET", "ERR_ORIGIN_5XX"];
  const crcClassUniverse = ["hit", "miss", "client", "error", "other"];
  const statusUniverse = [200, 206, 304, 403, 404, 429, 500, 502, 503, 504];

  const regions = region === "all" ? regionUniverse : [region, ...regionUniverse].slice(0, 6);

  // ✅ scoped pops + hosts (THE KEY CHANGE)
  const { scopedPops, hostSeries } = buildScopedPopsAndHosts(region, pop, seed);

  // keep POP options realistic for dropdowns:
  const pops =
    pop === "all"
      ? popUniverse.filter((pp) => (region === "all" ? true : pp.startsWith(`${normalizeScopeRegion(region)}-`) || pp.includes(`${region}`)))
      : [pop, ...popUniverse].slice(0, 8);

  // available.edgeHosts will match what host chart can show
  const available = buildAvailableFromUniverse({
    regions,
    pops: pop === "all" ? pops : [pop, ...pops].slice(0, 12),
    serviceBuckets: ["live", "vod", "other"],
    svcs: svcUniverse,
    edgeHosts: hostSeries,
    crcClasses: crcClassUniverse,
    crcs: crcUniverse,
    statusCodes: statusUniverse,
  });

  // ✅ aligned 5m window (matches CSV behavior)
  const bucketSeconds = chooseBucketSeconds(); // 300
  const bucketMs = bucketSeconds * 1000;

  const nowMs = Date.now();
  const endAlignedMs = Math.floor(nowMs / bucketMs) * bucketMs;

  const spanMinutes = Math.max(1, windowMinutes);
  const spanBuckets = Math.max(1, Math.ceil((spanMinutes * 60) / bucketSeconds));

  const startAlignedMs = endAlignedMs - spanBuckets * bucketMs;

  const startISO = new Date(startAlignedMs).toISOString();
  const endISO = new Date(endAlignedMs).toISOString();

  const baseErrorPct = (service === "live" ? 0.9 : service === "vod" ? 0.5 : 0.7) + noise * 1.2;

  const baseP95 = (service === "live" ? 180 : service === "vod" ? 240 : 210) + (seed % 120);
  const baseP99 = baseP95 + 120 + (seed % 180);

  let totalRequests = 0;
  let total5xx = 0;
  const ttmsP95Samples: number[] = [];
  const ttmsP99Samples: number[] = [];

  // Stable series (legend order)
  const statusCodeSeries = statusUniverse.map(String);
  const crcSeries = crcUniverse.map((c) => String(c).toUpperCase()).slice(0, 10);

  const points: any[] = [];

  // ✅ points ascending order, aligned timestamps
  for (let bi = 0; bi <= spanBuckets; bi++) {
    const t = startAlignedMs + bi * bucketMs;

    const wave = 0.75 + 0.5 * Math.sin((bi / Math.max(8, spanBuckets)) * Math.PI * 2);
    const req = round((baseTraffic * wave * (0.6 + noise * 0.8) / (spanBuckets + 1)) * 60);

    const spike = seed % 7 === 0 && bi > Math.floor(spanBuckets * 0.75) ? 2.5 : 1.0;
    const errPct = clamp(baseErrorPct * spike * (0.75 + 0.5 * Math.cos(bi / 3)), 0, 25);
    const err5xx = round((req * errPct) / 100);

    const p95 = round(baseP95 * (0.9 + 0.25 * Math.sin(bi / 5)));
    const p99 = round(baseP99 * (0.9 + 0.25 * Math.cos(bi / 6)));

    totalRequests += req;
    total5xx += err5xx;
    ttmsP95Samples.push(p95);
    ttmsP99Samples.push(p99);

    // stacked maps
    const statusCountsByCode: Record<string, number> = {};
    const hostCountsByHost: Record<string, number> = {};
    const crcCountsByCrc: Record<string, number> = {};

    // status distribution
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
    statusCountsByCode["504"] = Math.max(0, s5xx - statusCountsByCode["500"] - statusCountsByCode["502"] - statusCountsByCode["503"]);

    // ✅ host distribution: ONLY among hostSeries (which is region/pop coherent)
    let remainingHost = req;
    for (let hi = 0; hi < hostSeries.length; hi++) {
      const baseShare = 0.18 - hi * 0.02; // 18%,16%,14%...
      const share =
        hi === hostSeries.length - 1 ? remainingHost : round(req * clamp(baseShare, 0.04, 0.18));
      const v = clamp(share, 0, remainingHost);
      hostCountsByHost[hostSeries[hi]] = v;
      remainingHost -= v;
      if (remainingHost <= 0) break;
    }
    if (remainingHost > 0) hostCountsByHost["other"] = (hostCountsByHost["other"] ?? 0) + remainingHost;

    // crc distribution
    const hit = round(req * 0.70);
    const miss = round(req * 0.10);
    const client = round(req * 0.02);
    const errs = Math.max(0, err5xx);

    crcCountsByCrc["TCP_HIT"] = hit;
    crcCountsByCrc["TCP_MISS"] = miss;
    crcCountsByCrc["TCP_CLIENT_REFRESH"] = client;
    crcCountsByCrc["ERR_TIMEOUT"] = round(errs * 0.42);
    crcCountsByCrc["ERR_DNS"] = round(errs * 0.18);
    crcCountsByCrc["ERR_CONN_RESET"] = round(errs * 0.12);
    crcCountsByCrc["ERR_ORIGIN_5XX"] = Math.max(0, errs - crcCountsByCrc["ERR_TIMEOUT"] - crcCountsByCrc["ERR_DNS"] - crcCountsByCrc["ERR_CONN_RESET"]);

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

  const p95TtmsMs =
    ttmsP95Samples.length ? round(ttmsP95Samples.sort((a, b) => a - b)[Math.floor(ttmsP95Samples.length * 0.95)]) : null;
  const p99TtmsMs =
    ttmsP99Samples.length ? round(ttmsP99Samples.sort((a, b) => a - b)[Math.floor(ttmsP99Samples.length * 0.99)]) : null;

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

  const errorRatePct = totalRequests ? (total5xx / totalRequests) * 100 : null;

  const warnings: string[] = [];
  if (totalRequests === 0) warnings.push("No rows matched (mock produced 0 requests).");
  if (service !== "all" && !["live", "vod", "other"].includes(service)) {
    warnings.push(`Unknown service bucket '${service}' in ClickHouse mock. Expected live|vod|other|all.`);
  }
  if ((region !== "all" || pop !== "all") && hostSeries.length === 0) {
    warnings.push(`No scoped hosts generated for region='${region}' pop='${pop}' in mock (unexpected).`);
  }

  const summaryText = [
    `🧭 *CDN TRIAGE SUMMARY*`,
    `• Source: \`clickhouse (mock)\` • partner=\`${partner}\``,
    `• Scope: service=\`${service}\`  region=\`${region}\`  pop=\`${pop}\``,
    `• Window: \`${windowMinutes}m\`  • Time (UTC): \`${startISO}\` → \`${endISO}\``,
    ...(warnings.length ? ["", `⚠️ *Warnings*`, ...warnings.map((w) => `• ${w}`)] : []),
    "",
    `📊 *Traffic & Performance*`,
    `• Requests: *${int(totalRequests)}*`,
    `• P95 TTMS: *${ms(p95TtmsMs)}*`,
    `• P99 TTMS: *${ms(p99TtmsMs)}*`,
    `• Cache Hit: *${pct(cacheHitPct)}*  (miss ${pct(cacheMissPct)})`,
    "",
    `🧮 *Response Codes*`,
    ...statusCounts.slice(0, 10).map((s) => `• ${s.code}: *${s.count}*`),
    "",
    `🧾 *Evidence*`,
    `• Error responses: ${int(total5xx)}/${int(totalRequests)} (${pct(errorRatePct ?? 0)}).`,
  ].join("\n");

  const debugSql = debug
    ? [
        `-- MOCK SQL (public-safe)`,
        `-- Partner: ${partner}`,
        `-- Filters: service=${service}, region=${region}, pop=${pop}, windowMinutes=${windowMinutes}`,
        `SELECT`,
        `  toStartOfInterval(ts, INTERVAL ${bucketSeconds} SECOND) AS bucket,`,
        `  count() AS totalRequests,`,
        `  countIf(edge_status >= 500 AND edge_status < 600) AS error5xxCount,`,
        `  quantileExact(0.95)(ttms_ms) AS p95TtmsMs,`,
        `  quantileExact(0.99)(ttms_ms) AS p99TtmsMs`,
        `FROM edge_logs`,
        `WHERE partner = '${partner}'`,
        `  AND ts >= now() - INTERVAL ${windowMinutes} MINUTE`,
        `  AND ('${service}' = 'all' OR service_bucket = '${service}')`,
        `  AND ('${region}' = 'all' OR region = '${region}')`,
        `  AND ('${pop}' = 'all' OR pop = '${pop}')`,
        `GROUP BY bucket`,
        `ORDER BY bucket ASC;`,
      ].join("\n")
    : undefined;

  const metricsJson = {
    available,
    timeRangeUTC: { start: startISO, end: endISO },
    totalRequests,
    p95TtmsMs,
    p99TtmsMs,
    cacheHitPct,
    cacheMissPct,
    statusCounts,
    error5xxCount: total5xx,
    errorRatePct,
    topCrcClass,
    topErrorCrc,

    timeseries: {
      bucketSeconds,
      startTs: points.length ? points[0].ts : startISO,
      endTs: points.length ? points[points.length - 1].ts : endISO,
      points,

      statusCodeSeries,
      hostSeries,
      crcSeries,
    },

    warnings,
    dataQuality: {
      all: {
        invalid_ts: 0,
        missing_edge_status: 0,
        unknown_service: 0,
        unknown_crc: 0,
        unknown_region: 0,
        unknown_pop: 0,
        unknown_svc: 0,
        unknown_edge_host: 0,
      },
      window: {
        invalid_ts: 0,
        missing_edge_status: 0,
        unknown_service: 0,
        unknown_crc: 0,
        unknown_region: 0,
        unknown_pop: 0,
        unknown_svc: 0,
        unknown_edge_host: 0,
      },
    },
    debug: debug ? { note: "ClickHouse mock runner (no real DB access)." } : null,
  };

  return {
    summaryText,
    metricsJson,
    ...(debugSql ? { debugSql } : {}),
  };
}

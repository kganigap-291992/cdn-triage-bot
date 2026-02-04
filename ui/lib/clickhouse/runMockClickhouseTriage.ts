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
    edgeHosts: uniqLower(universe.edgeHosts).slice(0, 24),
    crcClasses: uniqLower(universe.crcClasses).slice(0, 12),
    crcs: uniqLower(universe.crcs).slice(0, 24),
    statusCodes: Array.from(
      new Set(universe.statusCodes.map((x) => String(x)).filter(Boolean))
    )
      .sort((a, b) => Number(a) - Number(b))
      .slice(0, 24),
  };
}

function chooseBucketSeconds(spanMinutes: number) {
  return spanMinutes <= 180 ? 60 : 900;
}

// -----------------------------
// Mock runner
// -----------------------------
export async function runMockClickhouseTriage(inputs: ClickhouseTriageInputs): Promise<ClickhouseTriageResult> {
  const { partner, service, region, pop, windowMinutes, debug } = inputs;

  const seed = hashToInt(`${partner}|${service}|${region}|${pop}|${windowMinutes}`);
  const baseTraffic = 5000 + (seed % 25000); // 5k..30k
  const noise = (seed % 1000) / 1000; // 0..1

  // Mock universe (what "available" should show for this window)
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

  const edgeHostUniverse = [
    "cdn-ec-bos-044",
    "cdn-ec-nyc-012",
    "cdn-ec-sjc-101",
    "cdn-ec-sea-007",
    "cdn-ec-lon-003",
  ];

  const crcUniverse = ["TCP_HIT", "TCP_MISS", "TCP_CF_HIT", "ERR_TIMEOUT", "ERR_DNS", "TCP_CLIENT_REFRESH"];
  const crcClassUniverse = ["hit", "miss", "client", "error", "other"];
  const statusUniverse = [200, 206, 304, 403, 404, 429, 500, 502, 503, 504];

  // Filter the available lists *lightly* based on user-selected region/pop (so UI feels coherent)
  const regions = region === "all" ? regionUniverse : [region, ...regionUniverse].slice(0, 6);
  const pops =
    pop === "all"
      ? popUniverse.filter((p) => (region === "all" ? true : p.startsWith(`${region}-`) || p.includes(`${region}`)))
      : [pop, ...popUniverse].slice(0, 8);

  const available = buildAvailableFromUniverse({
    regions,
    pops,
    serviceBuckets: ["live", "vod", "other"],
    svcs: svcUniverse,
    edgeHosts: edgeHostUniverse,
    crcClasses: crcClassUniverse,
    crcs: crcUniverse,
    statusCodes: statusUniverse,
  });

  // Time window (UTC)
  const endMs = Date.now();
  const startMs = endMs - Math.max(1, windowMinutes) * 60 * 1000;
  const startISO = new Date(startMs).toISOString();
  const endISO = new Date(endMs).toISOString();

  // Timeseries generation
  const spanMinutes = Math.max(1, windowMinutes);
  const bucketSeconds = chooseBucketSeconds(spanMinutes);
  const bucketMs = bucketSeconds * 1000;

  const buckets = Math.max(3, Math.min(96, Math.floor((spanMinutes * 60) / bucketSeconds)));
  const points: any[] = [];

  // Base rates influenced by seed + service
  const baseErrorPct =
    (service === "live" ? 0.9 : service === "vod" ? 0.5 : 0.7) + (noise * 1.2); // ~0.5%..2.1%
  const baseP95 =
    (service === "live" ? 180 : service === "vod" ? 240 : 210) + (seed % 120); // ms
  const baseP99 = baseP95 + 120 + (seed % 180);

  let totalRequests = 0;
  let total5xx = 0;
  const ttmsP95Samples: number[] = [];
  const ttmsP99Samples: number[] = [];

  for (let i = buckets - 1; i >= 0; i--) {
    const t = endMs - i * bucketMs;
    // Traffic wave
    const wave = 0.75 + 0.5 * Math.sin((i / Math.max(8, buckets)) * Math.PI * 2);
    const req = round(baseTraffic * wave * (0.6 + noise * 0.8) / buckets * 60); // scaled

    // Error spike sometimes
    const spike = (seed % 7 === 0 && i < Math.floor(buckets / 4)) ? 2.5 : 1.0;
    const errPct = clamp(baseErrorPct * spike * (0.75 + 0.5 * Math.cos(i / 3)), 0, 25);
    const err5xx = round((req * errPct) / 100);

    // Latency drift
    const p95 = round(baseP95 * (0.9 + 0.25 * Math.sin(i / 5)));
    const p99 = round(baseP99 * (0.9 + 0.25 * Math.cos(i / 6)));

    totalRequests += req;
    total5xx += err5xx;

    ttmsP95Samples.push(p95);
    ttmsP99Samples.push(p99);

    points.push({
      ts: new Date(t - (t % bucketMs)).toISOString(),
      totalRequests: req,
      error5xxCount: err5xx,
      errorRatePct: req ? (err5xx / req) * 100 : 0,
      p95TtmsMs: p95,
      p99TtmsMs: p99,
      // keep these optional fields off unless you want to show status/crc mini-metrics:
      // statusCounts: { "200": ..., "500": ... },
      // crcCounts: { "TCP_HIT": ... },
      // hostCounts: { "cdn-ec-bos-044": ... },
    });
  }

  // Overall aggregates (match CSV fields)
  const p95TtmsMs = ttmsP95Samples.length ? round(ttmsP95Samples.sort((a, b) => a - b)[Math.floor(ttmsP95Samples.length * 0.95)]) : null;
  const p99TtmsMs = ttmsP99Samples.length ? round(ttmsP99Samples.sort((a, b) => a - b)[Math.floor(ttmsP99Samples.length * 0.99)]) : null;

  // Cache hit/miss (mock)
  const cacheHitPct =
    service === "vod"
      ? clamp(82 + (seed % 12) - noise * 4, 20, 99)
      : clamp(68 + (seed % 18) - noise * 6, 10, 95);
  const cacheMissPct = clamp(100 - cacheHitPct, 0, 100);

  // Status counts (simple)
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

  // CRC breakdown (mock)
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

  // Build summary text (same vibe as CSV)
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

  // Optional debug SQL (for UI route.ts: _debug.sql)
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
    // ✅ SAME CONTRACT AS CSV
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

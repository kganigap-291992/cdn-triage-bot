// lib/clickhouse/sqlBuilder.ts

export type ClickhouseFilters = {
  partner: string;
  service: string;
  region: string;
  pop: string;
  contentType: string;
  uaFamily: string;
  windowMinutes: number;

  startTsUtc?: string;
  endTsUtc?: string;

  anchorToMaxTs?: boolean;
  tableHint?: "raw_minute" | "agg_15m";
};

export type BuiltSql = {
  queries: string[];
  params: Record<string, any>;
  meta: {
    tableUsed: "cachey.raw_minute" | "cachey.agg_15m";
    bucketSeconds: 60 | 900;
    anchorToMaxTs: boolean;
  };
};

function normalizeRequiredToken(v: unknown, field: string): string {
  const s = String(v ?? "").trim();
  if (!s) throw new Error(`sqlBuilder: ${field} is required`);
  return s;
}

function normalizeOptionalToken(v: unknown, fallback = "all"): string {
  const s = String(v ?? "").trim();
  return s || fallback;
}

function addEq(
  where: string[],
  params: Record<string, any>,
  col: string,
  key: string,
  val: string
) {
  if (!val || val === "all") return;
  where.push(`${col} = {${key}:String}`);
  params[key] = val;
}

function clampInt(n: number, min: number, max: number) {
  const x = Math.floor(n);
  return Math.max(min, Math.min(max, x));
}

function toIsoOrNull(s: unknown): string | null {
  const raw = typeof s === "string" ? s.trim() : "";
  if (!raw) return null;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

function minutesBetweenIso(startIso: string, endIso: string): number {
  const s = new Date(startIso).getTime();
  const e = new Date(endIso).getTime();
  if (!Number.isFinite(s) || !Number.isFinite(e)) return 0;
  return Math.max(0, Math.floor((e - s) / 60000));
}

function pickTable(windowMinutes: number, hint?: "raw_minute" | "agg_15m") {
  if (hint === "raw_minute") return { table: "cachey.raw_minute" as const, bucketSeconds: 60 as const };
  if (hint === "agg_15m") return { table: "cachey.agg_15m" as const, bucketSeconds: 900 as const };

  if (Number.isFinite(windowMinutes) && windowMinutes > 360) {
    return { table: "cachey.agg_15m" as const, bucketSeconds: 900 as const };
  }
  return { table: "cachey.raw_minute" as const, bucketSeconds: 60 as const };
}

export function buildClickhouseSql(f: ClickhouseFilters): BuiltSql {
  const params: Record<string, any> = {};
  const where: string[] = [];

  const partner = normalizeRequiredToken(f.partner, "partner");
  const service = normalizeRequiredToken(f.service, "service");

  const region = normalizeOptionalToken(f.region, "all");
  const pop = normalizeOptionalToken(f.pop, "all");
  const contentType = normalizeOptionalToken(f.contentType, "all");
  const uaFamily = normalizeOptionalToken(f.uaFamily, "all");

  const windowMinutes = clampInt(Number(f.windowMinutes || 60), 1, 60 * 24 * 31);
  params.windowMinutes = windowMinutes;

  const startIso = toIsoOrNull(f.startTsUtc);
  const endIso = toIsoOrNull(f.endTsUtc);
  const hasAbsolute = !!(startIso && endIso);

  if ((startIso && !endIso) || (!startIso && endIso)) {
    throw new Error("sqlBuilder: startTsUtc and endTsUtc must both be provided");
  }

  if (hasAbsolute) {
    const sMs = new Date(startIso!).getTime();
    const eMs = new Date(endIso!).getTime();
    if (!Number.isFinite(sMs) || !Number.isFinite(eMs) || eMs <= sMs) {
      throw new Error("invalid absolute range");
    }
  }

  const durationMinutes = hasAbsolute ? minutesBetweenIso(startIso!, endIso!) : windowMinutes;
  const { table, bucketSeconds } = pickTable(durationMinutes, f.tableHint);

  params.bucketSeconds = bucketSeconds;

  where.push(`partner = {partner:String}`);
  params.partner = partner;

  where.push(`service = {service:String}`);
  params.service = service;

  addEq(where, params, "region", "region", region);
  addEq(where, params, "pop", "pop", pop);
  addEq(where, params, "content_type", "contentType", contentType);
  addEq(where, params, "ua_family", "uaFamily", uaFamily);

  const anchorToMaxTs = hasAbsolute ? false : !!f.anchorToMaxTs;

  if (hasAbsolute) {
    params.startTsUtc = startIso!;
    params.endTsUtc = endIso!;
  }

  const timeWith = hasAbsolute
    ? `
WITH
  parseDateTime64BestEffort({startTsUtc:String}) AS t_start,
  parseDateTime64BestEffort({endTsUtc:String})   AS t_end
`.trim()
    : anchorToMaxTs
    ? `
WITH
  (SELECT max(ts) FROM ${table}) AS t_end,
  (t_end - toIntervalMinute({windowMinutes:Int32})) AS t_start
`.trim()
    : `
WITH
  now() AS t_end,
  (t_end - toIntervalMinute({windowMinutes:Int32})) AS t_start
`.trim();

  where.push(`ts >= t_start AND ts < t_end`);
  const whereSql = `WHERE ${where.join(" AND ")}`;

  const q0 = `
${timeWith}
SELECT
  t_start AS window_start,
  t_end   AS window_end,
  sum(requests) AS total_requests,
  sum(http_5xx_count) AS http_5xx,
  avg(p95_ms) AS p95_ms,
  avg(p99_ms) AS p99_ms,
  avg(cache_hit_rate) AS cache_hit_rate
FROM ${table}
${whereSql}
`.trim();

  const q1 = `
${timeWith}
SELECT status, c
FROM
(
  SELECT '200' AS status, sum(status_200) AS c FROM ${table} ${whereSql}
  UNION ALL SELECT '500', sum(status_500) FROM ${table} ${whereSql}
)
ORDER BY c DESC
`.trim();

  const q2 = `
${timeWith}
SELECT region,
  sum(requests) AS total_requests,
  sum(http_5xx_count) AS error_5xx_count,
  round(100.0 * sum(http_5xx_count)/nullIf(sum(requests),0),3) AS error_rate_pct,
  avg(p95_ms) AS p95_ttms_ms,
  avg(cache_hit_rate) AS cache_hit_rate
FROM ${table}
${whereSql}
GROUP BY region
ORDER BY error_5xx_count DESC
LIMIT 20
`.trim();

  const q3 = `
${timeWith}
SELECT pop,
  sum(requests) AS total_requests,
  sum(http_5xx_count) AS error_5xx_count,
  round(100.0 * sum(http_5xx_count)/nullIf(sum(requests),0),3) AS error_rate_pct,
  avg(p95_ms) AS p95_ttms_ms,
  avg(cache_hit_rate) AS cache_hit_rate
FROM ${table}
${whereSql}
GROUP BY pop
ORDER BY error_5xx_count DESC
LIMIT 20
`.trim();

  const q4 = `
${timeWith}
SELECT
  toStartOfInterval(ts, INTERVAL {bucketSeconds:Int32} SECOND) AS bucket,
  sum(requests) AS total_requests,
  sum(http_5xx_count) AS http_5xx,
  avg(p95_ms) AS p95_ms
FROM ${table}
${whereSql}
GROUP BY bucket
ORDER BY bucket ASC
`.trim();

  // ✅ NEW: UA breakdown
  const q5 = `
${timeWith}
SELECT
  ua_family,
  sum(requests) AS total_requests,
  sum(http_5xx_count) AS error_5xx_count,
  round(100.0 * sum(http_5xx_count)/nullIf(sum(requests),0),3) AS error_rate_pct,
  avg(p95_ms) AS p95_ttms_ms,
  avg(cache_hit_rate) AS cache_hit_rate
FROM ${table}
${whereSql}
GROUP BY ua_family
ORDER BY error_5xx_count DESC
LIMIT 20
`.trim();

  // ✅ NEW: Content breakdown
  const q6 = `
${timeWith}
SELECT
  content_type,
  sum(requests) AS total_requests,
  sum(http_5xx_count) AS error_5xx_count,
  round(100.0 * sum(http_5xx_count)/nullIf(sum(requests),0),3) AS error_rate_pct,
  avg(p95_ms) AS p95_ttms_ms,
  avg(cache_hit_rate) AS cache_hit_rate
FROM ${table}
${whereSql}
GROUP BY content_type
ORDER BY error_5xx_count DESC
LIMIT 20
`.trim();

  return {
    queries: [q0, q1, q2, q3, q4, q5, q6],
    params,
    meta: {
      tableUsed: table,
      bucketSeconds,
      anchorToMaxTs,
    },
  };
}
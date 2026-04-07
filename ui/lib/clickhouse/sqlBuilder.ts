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
  if (hint === "raw_minute") {
    return { table: "cachey.raw_minute" as const, bucketSeconds: 60 as const };
  }
  if (hint === "agg_15m") {
    return { table: "cachey.agg_15m" as const, bucketSeconds: 900 as const };
  }

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

  const prevTimeWith = hasAbsolute
    ? `
WITH
  parseDateTime64BestEffort({startTsUtc:String}) AS t_start,
  parseDateTime64BestEffort({endTsUtc:String})   AS t_end,
  dateDiff('second', t_start, t_end) AS span_seconds,
  subtractSeconds(t_start, span_seconds) AS prev_start,
  t_start AS prev_end
`.trim()
    : anchorToMaxTs
    ? `
WITH
  (SELECT max(ts) FROM ${table}) AS t_end,
  (t_end - toIntervalMinute({windowMinutes:Int32})) AS t_start,
  (t_start - toIntervalMinute({windowMinutes:Int32})) AS prev_start,
  t_start AS prev_end
`.trim()
    : `
WITH
  now() AS t_end,
  (t_end - toIntervalMinute({windowMinutes:Int32})) AS t_start,
  (t_start - toIntervalMinute({windowMinutes:Int32})) AS prev_start,
  t_start AS prev_end
`.trim();

  where.push(`ts >= t_start AND ts < t_end`);
  const whereSql = `WHERE ${where.join(" AND ")}`;

  const prevWhereParts = [...where];
  prevWhereParts[prevWhereParts.length - 1] = `ts >= prev_start AND ts < prev_end`;
  const prevWhereSql = `WHERE ${prevWhereParts.join(" AND ")}`;

  const q0 = `
${timeWith}
SELECT
  t_start AS window_start,
  t_end   AS window_end,
  sum(requests) AS total_requests,
  sum(http_5xx_count) AS http_5xx,
  round(100.0 * sum(http_5xx_count) / nullIf(sum(requests), 0), 3) AS error_rate_pct,
  round(
    100.0 * (sum(status_200) + sum(status_206) + sum(status_304)) / nullIf(sum(requests), 0),
    3
  ) AS success_rate_pct,
  avg(p95_ms) AS p95_ms,
  avg(p99_ms) AS p99_ms,
  avg(cache_hit_rate) AS cache_hit_rate,
  sum(crc_errors) AS crc_errors
FROM ${table}
${whereSql}
FORMAT JSON
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
FORMAT JSON
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
FORMAT JSON
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
FORMAT JSON
`.trim();

  const q4 = `
${timeWith}
SELECT
  toStartOfInterval(ts, INTERVAL {bucketSeconds:Int32} SECOND) AS bucket,
  sum(requests) AS total_requests,
  sum(http_5xx_count) AS http_5xx,
  round(100.0 * sum(http_5xx_count) / nullIf(sum(requests), 0), 3) AS error_rate_pct,
  round(
    100.0 * (sum(status_200) + sum(status_206) + sum(status_304)) / nullIf(sum(requests), 0),
    3
  ) AS success_rate_pct,
  avg(p95_ms) AS p95_ms,
  avg(p99_ms) AS p99_ms,
  avg(cache_hit_rate) AS cache_hit_rate,
  sum(crc_errors) AS crc_errors
FROM ${table}
${whereSql}
GROUP BY bucket
ORDER BY bucket ASC
FORMAT JSON
`.trim();

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
FORMAT JSON
`.trim();

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
FORMAT JSON
`.trim();

  const q7 = `
${prevTimeWith}
SELECT
  prev_start AS window_start,
  prev_end   AS window_end,
  sum(requests) AS total_requests,
  sum(http_5xx_count) AS http_5xx,
  round(100.0 * sum(http_5xx_count) / nullIf(sum(requests), 0), 3) AS error_rate_pct,
  round(
    100.0 * (sum(status_200) + sum(status_206) + sum(status_304)) / nullIf(sum(requests), 0),
    3
  ) AS success_rate_pct,
  avg(p95_ms) AS p95_ms,
  avg(p99_ms) AS p99_ms,
  avg(cache_hit_rate) AS cache_hit_rate,
  sum(crc_errors) AS crc_errors
FROM ${table}
${prevWhereSql}
FORMAT JSON
`.trim();

  const q8 = `
${prevTimeWith}
SELECT
  toStartOfInterval(ts, INTERVAL {bucketSeconds:Int32} SECOND) AS bucket,
  sum(requests) AS total_requests,
  sum(http_5xx_count) AS http_5xx,
  round(100.0 * sum(http_5xx_count) / nullIf(sum(requests), 0), 3) AS error_rate_pct,
  round(
    100.0 * (sum(status_200) + sum(status_206) + sum(status_304)) / nullIf(sum(requests), 0),
    3
  ) AS success_rate_pct,
  avg(p95_ms) AS p95_ms,
  avg(p99_ms) AS p99_ms,
  avg(cache_hit_rate) AS cache_hit_rate,
  sum(crc_errors) AS crc_errors
FROM ${table}
${prevWhereSql}
GROUP BY bucket
ORDER BY bucket ASC
FORMAT JSON
`.trim();

  const q9 = `
${timeWith}
SELECT
  toStartOfInterval(ts, INTERVAL {bucketSeconds:Int32} SECOND) AS bucket,
  sum(status_200) AS status_200,
  sum(status_206) AS status_206,
  sum(status_304) AS status_304,
  sum(status_403) AS status_403,
  sum(status_404) AS status_404,
  sum(status_429) AS status_429,
  sum(status_500) AS status_500,
  sum(status_502) AS status_502,
  sum(status_503) AS status_503,
  sum(status_504) AS status_504
FROM ${table}
${whereSql}
GROUP BY bucket
ORDER BY bucket ASC
FORMAT JSON
`.trim();

  const q10 = `
${prevTimeWith}
SELECT
  toStartOfInterval(ts, INTERVAL {bucketSeconds:Int32} SECOND) AS bucket,
  sum(status_200) AS status_200,
  sum(status_206) AS status_206,
  sum(status_304) AS status_304,
  sum(status_403) AS status_403,
  sum(status_404) AS status_404,
  sum(status_429) AS status_429,
  sum(status_500) AS status_500,
  sum(status_502) AS status_502,
  sum(status_503) AS status_503,
  sum(status_504) AS status_504
FROM ${table}
${prevWhereSql}
GROUP BY bucket
ORDER BY bucket ASC
FORMAT JSON
`.trim();

  const q11 = `
${timeWith}
SELECT
  toStartOfInterval(ts, INTERVAL {bucketSeconds:Int32} SECOND) AS bucket,
  sum(crc_errors) AS crc_errors
FROM ${table}
${whereSql}
GROUP BY bucket
ORDER BY bucket ASC
FORMAT JSON
`.trim();

  const q12 = `
${prevTimeWith}
SELECT
  toStartOfInterval(ts, INTERVAL {bucketSeconds:Int32} SECOND) AS bucket,
  sum(crc_errors) AS crc_errors
FROM ${table}
${prevWhereSql}
GROUP BY bucket
ORDER BY bucket ASC
FORMAT JSON
`.trim();

  const q13 = `
${timeWith}
SELECT
  host,
  sum(requests) AS total_requests,
  sum(http_5xx_count) AS error_5xx_count,
  sum(crc_errors) AS crc_error_count,
  round(100.0 * sum(http_5xx_count)/nullIf(sum(requests),0),3) AS error_rate_pct,
  avg(p95_ms) AS p95_ttms_ms,
  avg(p99_ms) AS p99_ttms_ms
FROM ${table}
${whereSql}
GROUP BY host
ORDER BY total_requests DESC
LIMIT 20
FORMAT JSON
`.trim();

  const q14 = `
${timeWith}
SELECT
  sum(status_200) AS status_200,
  sum(status_206) AS status_206,
  sum(status_304) AS status_304,
  sum(status_403) AS status_403,
  sum(status_404) AS status_404,
  sum(status_429) AS status_429,
  sum(status_500) AS status_500,
  sum(status_502) AS status_502,
  sum(status_503) AS status_503,
  sum(status_504) AS status_504
FROM ${table}
${whereSql}
FORMAT JSON
`.trim();

  const q15 = `
${prevTimeWith}
SELECT
  sum(status_200) AS status_200,
  sum(status_206) AS status_206,
  sum(status_304) AS status_304,
  sum(status_403) AS status_403,
  sum(status_404) AS status_404,
  sum(status_429) AS status_429,
  sum(status_500) AS status_500,
  sum(status_502) AS status_502,
  sum(status_503) AS status_503,
  sum(status_504) AS status_504
FROM ${table}
${prevWhereSql}
FORMAT JSON
`.trim();

  const q16 = `
${timeWith}
SELECT
  (
    sum(ats_tcp_hit_count) +
    sum(ats_tcp_cf_hit_count) +
    sum(ats_tcp_ims_hit_count)
  ) AS hit_count,
  (
    sum(ats_tcp_miss_count) +
    sum(ats_tcp_ims_miss_count)
  ) AS miss_count,
  (
    sum(ats_tcp_refresh_hit_count) +
    sum(ats_tcp_refresh_miss_count) +
    sum(ats_tcp_client_refresh_count) +
    sum(ats_tcp_ref_fail_hit_count)
  ) AS refresh_count,
  (
    sum(ats_err_client_abort_count) +
    sum(ats_err_client_read_error_count) +
    sum(ats_err_invalid_req_count)
  ) AS client_error_count,
  (
    sum(ats_err_connect_fail_count) +
    sum(ats_err_dns_fail_count) +
    sum(ats_err_read_timeout_count) +
    sum(ats_err_proxy_denied_count) +
    sum(ats_err_unknown_count) +
    sum(ats_tcp_swapfail_count)
  ) AS infra_error_count,
  (
    sum(ats_tcp_hit_count) +
    sum(ats_tcp_cf_hit_count) +
    sum(ats_tcp_ims_hit_count) +
    sum(ats_tcp_miss_count) +
    sum(ats_tcp_ims_miss_count) +
    sum(ats_tcp_refresh_hit_count) +
    sum(ats_tcp_refresh_miss_count) +
    sum(ats_tcp_client_refresh_count) +
    sum(ats_tcp_ref_fail_hit_count) +
    sum(ats_err_client_abort_count) +
    sum(ats_err_client_read_error_count) +
    sum(ats_err_invalid_req_count) +
    sum(ats_err_connect_fail_count) +
    sum(ats_err_dns_fail_count) +
    sum(ats_err_read_timeout_count) +
    sum(ats_err_proxy_denied_count) +
    sum(ats_err_unknown_count) +
    sum(ats_tcp_swapfail_count)
  ) AS ats_total,
  round(
    100.0 * (
      sum(ats_tcp_hit_count) +
      sum(ats_tcp_cf_hit_count) +
      sum(ats_tcp_ims_hit_count)
    ) / nullIf(sum(requests), 0),
    3
  ) AS hit_pct,
  round(
    100.0 * (
      sum(ats_tcp_miss_count) +
      sum(ats_tcp_ims_miss_count)
    ) / nullIf(sum(requests), 0),
    3
  ) AS miss_pct,
  round(
    100.0 * (
      sum(ats_tcp_refresh_hit_count) +
      sum(ats_tcp_refresh_miss_count) +
      sum(ats_tcp_client_refresh_count) +
      sum(ats_tcp_ref_fail_hit_count)
    ) / nullIf(sum(requests), 0),
    3
  ) AS refresh_pct,
  round(
    100.0 * (
      sum(ats_err_client_abort_count) +
      sum(ats_err_client_read_error_count) +
      sum(ats_err_invalid_req_count)
    ) / nullIf(sum(requests), 0),
    3
  ) AS client_error_pct,
  round(
    100.0 * (
      sum(ats_err_connect_fail_count) +
      sum(ats_err_dns_fail_count) +
      sum(ats_err_read_timeout_count) +
      sum(ats_err_proxy_denied_count) +
      sum(ats_err_unknown_count) +
      sum(ats_tcp_swapfail_count)
    ) / nullIf(sum(requests), 0),
    3
  ) AS infra_error_pct
FROM ${table}
${whereSql}
FORMAT JSON
`.trim();

  const q17 = `
${prevTimeWith}
SELECT
  (
    sum(ats_tcp_hit_count) +
    sum(ats_tcp_cf_hit_count) +
    sum(ats_tcp_ims_hit_count)
  ) AS hit_count,
  (
    sum(ats_tcp_miss_count) +
    sum(ats_tcp_ims_miss_count)
  ) AS miss_count,
  (
    sum(ats_tcp_refresh_hit_count) +
    sum(ats_tcp_refresh_miss_count) +
    sum(ats_tcp_client_refresh_count) +
    sum(ats_tcp_ref_fail_hit_count)
  ) AS refresh_count,
  (
    sum(ats_err_client_abort_count) +
    sum(ats_err_client_read_error_count) +
    sum(ats_err_invalid_req_count)
  ) AS client_error_count,
  (
    sum(ats_err_connect_fail_count) +
    sum(ats_err_dns_fail_count) +
    sum(ats_err_read_timeout_count) +
    sum(ats_err_proxy_denied_count) +
    sum(ats_err_unknown_count) +
    sum(ats_tcp_swapfail_count)
  ) AS infra_error_count,
  (
    sum(ats_tcp_hit_count) +
    sum(ats_tcp_cf_hit_count) +
    sum(ats_tcp_ims_hit_count) +
    sum(ats_tcp_miss_count) +
    sum(ats_tcp_ims_miss_count) +
    sum(ats_tcp_refresh_hit_count) +
    sum(ats_tcp_refresh_miss_count) +
    sum(ats_tcp_client_refresh_count) +
    sum(ats_tcp_ref_fail_hit_count) +
    sum(ats_err_client_abort_count) +
    sum(ats_err_client_read_error_count) +
    sum(ats_err_invalid_req_count) +
    sum(ats_err_connect_fail_count) +
    sum(ats_err_dns_fail_count) +
    sum(ats_err_read_timeout_count) +
    sum(ats_err_proxy_denied_count) +
    sum(ats_err_unknown_count) +
    sum(ats_tcp_swapfail_count)
  ) AS ats_total,
  round(
    100.0 * (
      sum(ats_tcp_hit_count) +
      sum(ats_tcp_cf_hit_count) +
      sum(ats_tcp_ims_hit_count)
    ) / nullIf(sum(requests), 0),
    3
  ) AS hit_pct,
  round(
    100.0 * (
      sum(ats_tcp_miss_count) +
      sum(ats_tcp_ims_miss_count)
    ) / nullIf(sum(requests), 0),
    3
  ) AS miss_pct,
  round(
    100.0 * (
      sum(ats_tcp_refresh_hit_count) +
      sum(ats_tcp_refresh_miss_count) +
      sum(ats_tcp_client_refresh_count) +
      sum(ats_tcp_ref_fail_hit_count)
    ) / nullIf(sum(requests), 0),
    3
  ) AS refresh_pct,
  round(
    100.0 * (
      sum(ats_err_client_abort_count) +
      sum(ats_err_client_read_error_count) +
      sum(ats_err_invalid_req_count)
    ) / nullIf(sum(requests), 0),
    3
  ) AS client_error_pct,
  round(
    100.0 * (
      sum(ats_err_connect_fail_count) +
      sum(ats_err_dns_fail_count) +
      sum(ats_err_read_timeout_count) +
      sum(ats_err_proxy_denied_count) +
      sum(ats_err_unknown_count) +
      sum(ats_tcp_swapfail_count)
    ) / nullIf(sum(requests), 0),
    3
  ) AS infra_error_pct
FROM ${table}
${prevWhereSql}
FORMAT JSON
`.trim();

  const q18 = `
${timeWith}
SELECT
  toStartOfInterval(ts, INTERVAL {bucketSeconds:Int32} SECOND) AS bucket,
  (
    sum(ats_tcp_hit_count) +
    sum(ats_tcp_cf_hit_count) +
    sum(ats_tcp_ims_hit_count)
  ) AS hit_count,
  (
    sum(ats_tcp_miss_count) +
    sum(ats_tcp_ims_miss_count)
  ) AS miss_count,
  (
    sum(ats_tcp_refresh_hit_count) +
    sum(ats_tcp_refresh_miss_count) +
    sum(ats_tcp_client_refresh_count) +
    sum(ats_tcp_ref_fail_hit_count)
  ) AS refresh_count,
  (
    sum(ats_err_client_abort_count) +
    sum(ats_err_client_read_error_count) +
    sum(ats_err_invalid_req_count)
  ) AS client_error_count,
  (
    sum(ats_err_connect_fail_count) +
    sum(ats_err_dns_fail_count) +
    sum(ats_err_read_timeout_count) +
    sum(ats_err_proxy_denied_count) +
    sum(ats_err_unknown_count) +
    sum(ats_tcp_swapfail_count)
  ) AS infra_error_count
FROM ${table}
${whereSql}
GROUP BY bucket
ORDER BY bucket ASC
FORMAT JSON
`.trim();

  const q19 = `
${prevTimeWith}
SELECT
  toStartOfInterval(ts, INTERVAL {bucketSeconds:Int32} SECOND) AS bucket,
  (
    sum(ats_tcp_hit_count) +
    sum(ats_tcp_cf_hit_count) +
    sum(ats_tcp_ims_hit_count)
  ) AS hit_count,
  (
    sum(ats_tcp_miss_count) +
    sum(ats_tcp_ims_miss_count)
  ) AS miss_count,
  (
    sum(ats_tcp_refresh_hit_count) +
    sum(ats_tcp_refresh_miss_count) +
    sum(ats_tcp_client_refresh_count) +
    sum(ats_tcp_ref_fail_hit_count)
  ) AS refresh_count,
  (
    sum(ats_err_client_abort_count) +
    sum(ats_err_client_read_error_count) +
    sum(ats_err_invalid_req_count)
  ) AS client_error_count,
  (
    sum(ats_err_connect_fail_count) +
    sum(ats_err_dns_fail_count) +
    sum(ats_err_read_timeout_count) +
    sum(ats_err_proxy_denied_count) +
    sum(ats_err_unknown_count) +
    sum(ats_tcp_swapfail_count)
  ) AS infra_error_count
FROM ${table}
${prevWhereSql}
GROUP BY bucket
ORDER BY bucket ASC
FORMAT JSON
`.trim();

  const q20 = `
${timeWith}
SELECT
  region,
  (
    sum(ats_tcp_hit_count) +
    sum(ats_tcp_cf_hit_count) +
    sum(ats_tcp_ims_hit_count)
  ) AS hit_count,
  (
    sum(ats_tcp_miss_count) +
    sum(ats_tcp_ims_miss_count)
  ) AS miss_count,
  (
    sum(ats_tcp_refresh_hit_count) +
    sum(ats_tcp_refresh_miss_count) +
    sum(ats_tcp_client_refresh_count) +
    sum(ats_tcp_ref_fail_hit_count)
  ) AS refresh_count,
  (
    sum(ats_err_client_abort_count) +
    sum(ats_err_client_read_error_count) +
    sum(ats_err_invalid_req_count)
  ) AS client_error_count,
  (
    sum(ats_err_connect_fail_count) +
    sum(ats_err_dns_fail_count) +
    sum(ats_err_read_timeout_count) +
    sum(ats_err_proxy_denied_count) +
    sum(ats_err_unknown_count) +
    sum(ats_tcp_swapfail_count)
  ) AS infra_error_count,
  sum(requests) AS total_requests
FROM ${table}
${whereSql}
GROUP BY region
ORDER BY total_requests DESC
LIMIT 20
FORMAT JSON
`.trim();

  const q21 = `
${timeWith}
SELECT
  pop,
  (
    sum(ats_tcp_hit_count) +
    sum(ats_tcp_cf_hit_count) +
    sum(ats_tcp_ims_hit_count)
  ) AS hit_count,
  (
    sum(ats_tcp_miss_count) +
    sum(ats_tcp_ims_miss_count)
  ) AS miss_count,
  (
    sum(ats_tcp_refresh_hit_count) +
    sum(ats_tcp_refresh_miss_count) +
    sum(ats_tcp_client_refresh_count) +
    sum(ats_tcp_ref_fail_hit_count)
  ) AS refresh_count,
  (
    sum(ats_err_client_abort_count) +
    sum(ats_err_client_read_error_count) +
    sum(ats_err_invalid_req_count)
  ) AS client_error_count,
  (
    sum(ats_err_connect_fail_count) +
    sum(ats_err_dns_fail_count) +
    sum(ats_err_read_timeout_count) +
    sum(ats_err_proxy_denied_count) +
    sum(ats_err_unknown_count) +
    sum(ats_tcp_swapfail_count)
  ) AS infra_error_count,
  sum(requests) AS total_requests
FROM ${table}
${whereSql}
GROUP BY pop
ORDER BY total_requests DESC
LIMIT 20
FORMAT JSON
`.trim();

  const q22 = `
${timeWith}
SELECT
  content_type,
  (
    sum(ats_tcp_hit_count) +
    sum(ats_tcp_cf_hit_count) +
    sum(ats_tcp_ims_hit_count)
  ) AS hit_count,
  (
    sum(ats_tcp_miss_count) +
    sum(ats_tcp_ims_miss_count)
  ) AS miss_count,
  (
    sum(ats_tcp_refresh_hit_count) +
    sum(ats_tcp_refresh_miss_count) +
    sum(ats_tcp_client_refresh_count) +
    sum(ats_tcp_ref_fail_hit_count)
  ) AS refresh_count,
  (
    sum(ats_err_client_abort_count) +
    sum(ats_err_client_read_error_count) +
    sum(ats_err_invalid_req_count)
  ) AS client_error_count,
  (
    sum(ats_err_connect_fail_count) +
    sum(ats_err_dns_fail_count) +
    sum(ats_err_read_timeout_count) +
    sum(ats_err_proxy_denied_count) +
    sum(ats_err_unknown_count) +
    sum(ats_tcp_swapfail_count)
  ) AS infra_error_count,
  sum(requests) AS total_requests
FROM ${table}
${whereSql}
GROUP BY content_type
ORDER BY total_requests DESC
LIMIT 20
FORMAT JSON
`.trim();

  const q23 = `
${timeWith}
SELECT
  ua_family,
  (
    sum(ats_tcp_hit_count) +
    sum(ats_tcp_cf_hit_count) +
    sum(ats_tcp_ims_hit_count)
  ) AS hit_count,
  (
    sum(ats_tcp_miss_count) +
    sum(ats_tcp_ims_miss_count)
  ) AS miss_count,
  (
    sum(ats_tcp_refresh_hit_count) +
    sum(ats_tcp_refresh_miss_count) +
    sum(ats_tcp_client_refresh_count) +
    sum(ats_tcp_ref_fail_hit_count)
  ) AS refresh_count,
  (
    sum(ats_err_client_abort_count) +
    sum(ats_err_client_read_error_count) +
    sum(ats_err_invalid_req_count)
  ) AS client_error_count,
  (
    sum(ats_err_connect_fail_count) +
    sum(ats_err_dns_fail_count) +
    sum(ats_err_read_timeout_count) +
    sum(ats_err_proxy_denied_count) +
    sum(ats_err_unknown_count) +
    sum(ats_tcp_swapfail_count)
  ) AS infra_error_count,
  sum(requests) AS total_requests
FROM ${table}
${whereSql}
GROUP BY ua_family
ORDER BY total_requests DESC
LIMIT 20
FORMAT JSON
`.trim();

  const q24 = `
${timeWith}
SELECT
  sum(ats_tcp_hit_count) AS ats_tcp_hit_count,
  sum(ats_tcp_cf_hit_count) AS ats_tcp_cf_hit_count,
  sum(ats_tcp_miss_count) AS ats_tcp_miss_count,
  sum(ats_tcp_refresh_hit_count) AS ats_tcp_refresh_hit_count,
  sum(ats_tcp_ref_fail_hit_count) AS ats_tcp_ref_fail_hit_count,
  sum(ats_tcp_refresh_miss_count) AS ats_tcp_refresh_miss_count,
  sum(ats_tcp_client_refresh_count) AS ats_tcp_client_refresh_count,
  sum(ats_tcp_ims_hit_count) AS ats_tcp_ims_hit_count,
  sum(ats_tcp_ims_miss_count) AS ats_tcp_ims_miss_count,
  sum(ats_tcp_swapfail_count) AS ats_tcp_swapfail_count,
  sum(ats_err_client_abort_count) AS ats_err_client_abort_count,
  sum(ats_err_client_read_error_count) AS ats_err_client_read_error_count,
  sum(ats_err_connect_fail_count) AS ats_err_connect_fail_count,
  sum(ats_err_dns_fail_count) AS ats_err_dns_fail_count,
  sum(ats_err_invalid_req_count) AS ats_err_invalid_req_count,
  sum(ats_err_read_timeout_count) AS ats_err_read_timeout_count,
  sum(ats_err_proxy_denied_count) AS ats_err_proxy_denied_count,
  sum(ats_err_unknown_count) AS ats_err_unknown_count
FROM ${table}
${whereSql}
FORMAT JSON
`.trim();

  const q25 = `
${prevTimeWith}
SELECT
  sum(ats_tcp_hit_count) AS ats_tcp_hit_count,
  sum(ats_tcp_cf_hit_count) AS ats_tcp_cf_hit_count,
  sum(ats_tcp_miss_count) AS ats_tcp_miss_count,
  sum(ats_tcp_refresh_hit_count) AS ats_tcp_refresh_hit_count,
  sum(ats_tcp_ref_fail_hit_count) AS ats_tcp_ref_fail_hit_count,
  sum(ats_tcp_refresh_miss_count) AS ats_tcp_refresh_miss_count,
  sum(ats_tcp_client_refresh_count) AS ats_tcp_client_refresh_count,
  sum(ats_tcp_ims_hit_count) AS ats_tcp_ims_hit_count,
  sum(ats_tcp_ims_miss_count) AS ats_tcp_ims_miss_count,
  sum(ats_tcp_swapfail_count) AS ats_tcp_swapfail_count,
  sum(ats_err_client_abort_count) AS ats_err_client_abort_count,
  sum(ats_err_client_read_error_count) AS ats_err_client_read_error_count,
  sum(ats_err_connect_fail_count) AS ats_err_connect_fail_count,
  sum(ats_err_dns_fail_count) AS ats_err_dns_fail_count,
  sum(ats_err_invalid_req_count) AS ats_err_invalid_req_count,
  sum(ats_err_read_timeout_count) AS ats_err_read_timeout_count,
  sum(ats_err_proxy_denied_count) AS ats_err_proxy_denied_count,
  sum(ats_err_unknown_count) AS ats_err_unknown_count
FROM ${table}
${prevWhereSql}
FORMAT JSON
`.trim();

  const q26 = `
${timeWith}
SELECT
  toStartOfInterval(ts, INTERVAL {bucketSeconds:Int32} SECOND) AS bucket,
  sum(ats_tcp_hit_count) AS ats_tcp_hit_count,
  sum(ats_tcp_cf_hit_count) AS ats_tcp_cf_hit_count,
  sum(ats_tcp_miss_count) AS ats_tcp_miss_count,
  sum(ats_tcp_refresh_hit_count) AS ats_tcp_refresh_hit_count,
  sum(ats_tcp_ref_fail_hit_count) AS ats_tcp_ref_fail_hit_count,
  sum(ats_tcp_refresh_miss_count) AS ats_tcp_refresh_miss_count,
  sum(ats_tcp_client_refresh_count) AS ats_tcp_client_refresh_count,
  sum(ats_tcp_ims_hit_count) AS ats_tcp_ims_hit_count,
  sum(ats_tcp_ims_miss_count) AS ats_tcp_ims_miss_count,
  sum(ats_tcp_swapfail_count) AS ats_tcp_swapfail_count,
  sum(ats_err_client_abort_count) AS ats_err_client_abort_count,
  sum(ats_err_client_read_error_count) AS ats_err_client_read_error_count,
  sum(ats_err_connect_fail_count) AS ats_err_connect_fail_count,
  sum(ats_err_dns_fail_count) AS ats_err_dns_fail_count,
  sum(ats_err_invalid_req_count) AS ats_err_invalid_req_count,
  sum(ats_err_read_timeout_count) AS ats_err_read_timeout_count,
  sum(ats_err_proxy_denied_count) AS ats_err_proxy_denied_count,
  sum(ats_err_unknown_count) AS ats_err_unknown_count
FROM ${table}
${whereSql}
GROUP BY bucket
ORDER BY bucket ASC
FORMAT JSON
`.trim();

  const q27 = `
${prevTimeWith}
SELECT
  toStartOfInterval(ts, INTERVAL {bucketSeconds:Int32} SECOND) AS bucket,
  sum(ats_tcp_hit_count) AS ats_tcp_hit_count,
  sum(ats_tcp_cf_hit_count) AS ats_tcp_cf_hit_count,
  sum(ats_tcp_miss_count) AS ats_tcp_miss_count,
  sum(ats_tcp_refresh_hit_count) AS ats_tcp_refresh_hit_count,
  sum(ats_tcp_ref_fail_hit_count) AS ats_tcp_ref_fail_hit_count,
  sum(ats_tcp_refresh_miss_count) AS ats_tcp_refresh_miss_count,
  sum(ats_tcp_client_refresh_count) AS ats_tcp_client_refresh_count,
  sum(ats_tcp_ims_hit_count) AS ats_tcp_ims_hit_count,
  sum(ats_tcp_ims_miss_count) AS ats_tcp_ims_miss_count,
  sum(ats_tcp_swapfail_count) AS ats_tcp_swapfail_count,
  sum(ats_err_client_abort_count) AS ats_err_client_abort_count,
  sum(ats_err_client_read_error_count) AS ats_err_client_read_error_count,
  sum(ats_err_connect_fail_count) AS ats_err_connect_fail_count,
  sum(ats_err_dns_fail_count) AS ats_err_dns_fail_count,
  sum(ats_err_invalid_req_count) AS ats_err_invalid_req_count,
  sum(ats_err_read_timeout_count) AS ats_err_read_timeout_count,
  sum(ats_err_proxy_denied_count) AS ats_err_proxy_denied_count,
  sum(ats_err_unknown_count) AS ats_err_unknown_count
FROM ${table}
${prevWhereSql}
GROUP BY bucket
ORDER BY bucket ASC
FORMAT JSON
`.trim();

  const q28 = `
${timeWith}
SELECT
  region,
  sum(ats_tcp_hit_count) AS ats_tcp_hit_count,
  sum(ats_tcp_cf_hit_count) AS ats_tcp_cf_hit_count,
  sum(ats_tcp_miss_count) AS ats_tcp_miss_count,
  sum(ats_tcp_refresh_hit_count) AS ats_tcp_refresh_hit_count,
  sum(ats_tcp_ref_fail_hit_count) AS ats_tcp_ref_fail_hit_count,
  sum(ats_tcp_refresh_miss_count) AS ats_tcp_refresh_miss_count,
  sum(ats_tcp_client_refresh_count) AS ats_tcp_client_refresh_count,
  sum(ats_tcp_ims_hit_count) AS ats_tcp_ims_hit_count,
  sum(ats_tcp_ims_miss_count) AS ats_tcp_ims_miss_count,
  sum(ats_tcp_swapfail_count) AS ats_tcp_swapfail_count,
  sum(ats_err_client_abort_count) AS ats_err_client_abort_count,
  sum(ats_err_client_read_error_count) AS ats_err_client_read_error_count,
  sum(ats_err_connect_fail_count) AS ats_err_connect_fail_count,
  sum(ats_err_dns_fail_count) AS ats_err_dns_fail_count,
  sum(ats_err_invalid_req_count) AS ats_err_invalid_req_count,
  sum(ats_err_read_timeout_count) AS ats_err_read_timeout_count,
  sum(ats_err_proxy_denied_count) AS ats_err_proxy_denied_count,
  sum(ats_err_unknown_count) AS ats_err_unknown_count,
  sum(requests) AS total_requests
FROM ${table}
${whereSql}
GROUP BY region
ORDER BY total_requests DESC
LIMIT 20
FORMAT JSON
`.trim();

  const q29 = `
${timeWith}
SELECT
  pop,
  sum(ats_tcp_hit_count) AS ats_tcp_hit_count,
  sum(ats_tcp_cf_hit_count) AS ats_tcp_cf_hit_count,
  sum(ats_tcp_miss_count) AS ats_tcp_miss_count,
  sum(ats_tcp_refresh_hit_count) AS ats_tcp_refresh_hit_count,
  sum(ats_tcp_ref_fail_hit_count) AS ats_tcp_ref_fail_hit_count,
  sum(ats_tcp_refresh_miss_count) AS ats_tcp_refresh_miss_count,
  sum(ats_tcp_client_refresh_count) AS ats_tcp_client_refresh_count,
  sum(ats_tcp_ims_hit_count) AS ats_tcp_ims_hit_count,
  sum(ats_tcp_ims_miss_count) AS ats_tcp_ims_miss_count,
  sum(ats_tcp_swapfail_count) AS ats_tcp_swapfail_count,
  sum(ats_err_client_abort_count) AS ats_err_client_abort_count,
  sum(ats_err_client_read_error_count) AS ats_err_client_read_error_count,
  sum(ats_err_connect_fail_count) AS ats_err_connect_fail_count,
  sum(ats_err_dns_fail_count) AS ats_err_dns_fail_count,
  sum(ats_err_invalid_req_count) AS ats_err_invalid_req_count,
  sum(ats_err_read_timeout_count) AS ats_err_read_timeout_count,
  sum(ats_err_proxy_denied_count) AS ats_err_proxy_denied_count,
  sum(ats_err_unknown_count) AS ats_err_unknown_count,
  sum(requests) AS total_requests
FROM ${table}
${whereSql}
GROUP BY pop
ORDER BY total_requests DESC
LIMIT 20
FORMAT JSON
`.trim();

  const q30 = `
${timeWith}
SELECT
  content_type,
  sum(ats_tcp_hit_count) AS ats_tcp_hit_count,
  sum(ats_tcp_cf_hit_count) AS ats_tcp_cf_hit_count,
  sum(ats_tcp_miss_count) AS ats_tcp_miss_count,
  sum(ats_tcp_refresh_hit_count) AS ats_tcp_refresh_hit_count,
  sum(ats_tcp_ref_fail_hit_count) AS ats_tcp_ref_fail_hit_count,
  sum(ats_tcp_refresh_miss_count) AS ats_tcp_refresh_miss_count,
  sum(ats_tcp_client_refresh_count) AS ats_tcp_client_refresh_count,
  sum(ats_tcp_ims_hit_count) AS ats_tcp_ims_hit_count,
  sum(ats_tcp_ims_miss_count) AS ats_tcp_ims_miss_count,
  sum(ats_tcp_swapfail_count) AS ats_tcp_swapfail_count,
  sum(ats_err_client_abort_count) AS ats_err_client_abort_count,
  sum(ats_err_client_read_error_count) AS ats_err_client_read_error_count,
  sum(ats_err_connect_fail_count) AS ats_err_connect_fail_count,
  sum(ats_err_dns_fail_count) AS ats_err_dns_fail_count,
  sum(ats_err_invalid_req_count) AS ats_err_invalid_req_count,
  sum(ats_err_read_timeout_count) AS ats_err_read_timeout_count,
  sum(ats_err_proxy_denied_count) AS ats_err_proxy_denied_count,
  sum(ats_err_unknown_count) AS ats_err_unknown_count,
  sum(requests) AS total_requests
FROM ${table}
${whereSql}
GROUP BY content_type
ORDER BY total_requests DESC
LIMIT 20
FORMAT JSON
`.trim();

  const q31 = `
${timeWith}
SELECT
  ua_family,
  sum(ats_tcp_hit_count) AS ats_tcp_hit_count,
  sum(ats_tcp_cf_hit_count) AS ats_tcp_cf_hit_count,
  sum(ats_tcp_miss_count) AS ats_tcp_miss_count,
  sum(ats_tcp_refresh_hit_count) AS ats_tcp_refresh_hit_count,
  sum(ats_tcp_ref_fail_hit_count) AS ats_tcp_ref_fail_hit_count,
  sum(ats_tcp_refresh_miss_count) AS ats_tcp_refresh_miss_count,
  sum(ats_tcp_client_refresh_count) AS ats_tcp_client_refresh_count,
  sum(ats_tcp_ims_hit_count) AS ats_tcp_ims_hit_count,
  sum(ats_tcp_ims_miss_count) AS ats_tcp_ims_miss_count,
  sum(ats_tcp_swapfail_count) AS ats_tcp_swapfail_count,
  sum(ats_err_client_abort_count) AS ats_err_client_abort_count,
  sum(ats_err_client_read_error_count) AS ats_err_client_read_error_count,
  sum(ats_err_connect_fail_count) AS ats_err_connect_fail_count,
  sum(ats_err_dns_fail_count) AS ats_err_dns_fail_count,
  sum(ats_err_invalid_req_count) AS ats_err_invalid_req_count,
  sum(ats_err_read_timeout_count) AS ats_err_read_timeout_count,
  sum(ats_err_proxy_denied_count) AS ats_err_proxy_denied_count,
  sum(ats_err_unknown_count) AS ats_err_unknown_count,
  sum(requests) AS total_requests
FROM ${table}
${whereSql}
GROUP BY ua_family
ORDER BY total_requests DESC
LIMIT 20
FORMAT JSON
`.trim();

  const q32 = `
${timeWith}
SELECT
  region,
  sum(requests) AS total_requests,
  sum(status_200) AS status_200,
  sum(status_206) AS status_206,
  sum(status_304) AS status_304,
  sum(status_403) AS status_403,
  sum(status_404) AS status_404,
  sum(status_429) AS status_429,
  sum(status_500) AS status_500,
  sum(status_502) AS status_502,
  sum(status_503) AS status_503,
  sum(status_504) AS status_504
FROM ${table}
${whereSql}
GROUP BY region
ORDER BY total_requests DESC
LIMIT 20
FORMAT JSON
`.trim();

  const q33 = `
${timeWith}
SELECT
  pop,
  sum(requests) AS total_requests,
  sum(status_200) AS status_200,
  sum(status_206) AS status_206,
  sum(status_304) AS status_304,
  sum(status_403) AS status_403,
  sum(status_404) AS status_404,
  sum(status_429) AS status_429,
  sum(status_500) AS status_500,
  sum(status_502) AS status_502,
  sum(status_503) AS status_503,
  sum(status_504) AS status_504
FROM ${table}
${whereSql}
GROUP BY pop
ORDER BY total_requests DESC
LIMIT 20
FORMAT JSON
`.trim();

  const q34 = `
${timeWith}
SELECT
  content_type,
  sum(requests) AS total_requests,
  sum(status_200) AS status_200,
  sum(status_206) AS status_206,
  sum(status_304) AS status_304,
  sum(status_403) AS status_403,
  sum(status_404) AS status_404,
  sum(status_429) AS status_429,
  sum(status_500) AS status_500,
  sum(status_502) AS status_502,
  sum(status_503) AS status_503,
  sum(status_504) AS status_504
FROM ${table}
${whereSql}
GROUP BY content_type
ORDER BY total_requests DESC
LIMIT 20
FORMAT JSON
`.trim();

  const q35 = `
${timeWith}
SELECT
  ua_family,
  sum(requests) AS total_requests,
  sum(status_200) AS status_200,
  sum(status_206) AS status_206,
  sum(status_304) AS status_304,
  sum(status_403) AS status_403,
  sum(status_404) AS status_404,
  sum(status_429) AS status_429,
  sum(status_500) AS status_500,
  sum(status_502) AS status_502,
  sum(status_503) AS status_503,
  sum(status_504) AS status_504
FROM ${table}
${whereSql}
GROUP BY ua_family
ORDER BY total_requests DESC
LIMIT 20
FORMAT JSON
`.trim();

  const q36 = `
${timeWith}
SELECT
  host,
  sum(requests) AS total_requests,
  sum(status_200) AS status_200,
  sum(status_206) AS status_206,
  sum(status_304) AS status_304,
  sum(status_403) AS status_403,
  sum(status_404) AS status_404,
  sum(status_429) AS status_429,
  sum(status_500) AS status_500,
  sum(status_502) AS status_502,
  sum(status_503) AS status_503,
  sum(status_504) AS status_504
FROM ${table}
${whereSql}
GROUP BY host
ORDER BY total_requests DESC
LIMIT 20
FORMAT JSON
`.trim();

  return {
    queries: [
      q0,
      q1,
      q2,
      q3,
      q4,
      q5,
      q6,
      q7,
      q8,
      q9,
      q10,
      q11,
      q12,
      q13,
      q14,
      q15,
      q16,
      q17,
      q18,
      q19,
      q20,
      q21,
      q22,
      q23,
      q24,
      q25,
      q26,
      q27,
      q28,
      q29,
      q30,
      q31,
      q32,
      q33,
      q34,
      q35,
      q36,
    ],
    params,
    meta: {
      tableUsed: table,
      bucketSeconds,
      anchorToMaxTs,
    },
  };
}
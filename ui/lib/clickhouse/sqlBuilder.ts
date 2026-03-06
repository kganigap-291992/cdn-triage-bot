// lib/clickhouse/sqlBuilder.ts

export type ClickhouseFilters = {
  partner: string; // required
  service: string; // required (canon; never "all" in our app, but keep addEq safe)
  region: string; // all|...
  pop: string; // all|...
  contentType: string; // all|manifest|segment|api
  uaFamily: string; // all|stb|mobile|web|smart_tv|console
  windowMinutes: number; // e.g. 60

  // ✅ Absolute UTC range override (ISO strings)
  // If both present: ignore windowMinutes for time bounds (but may still be used for chips/UI).
  startTsUtc?: string;
  endTsUtc?: string;

  // dataset-clock anchoring (max(ts)) vs realtime-clock (now())
  anchorToMaxTs?: boolean;

  // OPTIONAL override (future): force a table explicitly
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

function addEq(where: string[], params: Record<string, any>, col: string, key: string, val: string) {
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

// Rule: duration ≤ 6h → raw_minute; > 6h → agg_15m
function pickTable(windowMinutes: number, hint?: "raw_minute" | "agg_15m") {
  if (hint === "raw_minute") return { table: "cachey.raw_minute" as const, bucketSeconds: 60 as const };
  if (hint === "agg_15m") return { table: "cachey.agg_15m" as const, bucketSeconds: 900 as const };

  const wm = Number(windowMinutes);
  if (Number.isFinite(wm) && wm > 360) return { table: "cachey.agg_15m" as const, bucketSeconds: 900 as const };
  return { table: "cachey.raw_minute" as const, bucketSeconds: 60 as const };
}

export function buildClickhouseSql(f: ClickhouseFilters): BuiltSql {
  const params: Record<string, any> = {};
  const where: string[] = [];

  // Normalize windowMinutes for relative mode + fallback
  const windowMinutes = clampInt(Number(f.windowMinutes || 60), 1, 60 * 24 * 31);
  params.windowMinutes = windowMinutes;

  // ✅ Absolute range detection
  const startIso = toIsoOrNull(f.startTsUtc);
  const endIso = toIsoOrNull(f.endTsUtc);
  const hasAbsolute = !!(startIso && endIso);

  if ((startIso && !endIso) || (!startIso && endIso)) {
    throw new Error("sqlBuilder: startTsUtc and endTsUtc must both be provided for absolute range");
  }
  if (hasAbsolute) {
    const sMs = new Date(startIso!).getTime();
    const eMs = new Date(endIso!).getTime();
    if (!Number.isFinite(sMs) || !Number.isFinite(eMs) || eMs <= sMs) {
      throw new Error("sqlBuilder: invalid absolute range (endTsUtc must be after startTsUtc)");
    }
  }

  // ✅ Choose table based on *actual* duration for absolute mode, else windowMinutes.
  const durationMinutes = hasAbsolute ? minutesBetweenIso(startIso!, endIso!) : windowMinutes;
  const { table, bucketSeconds } = pickTable(durationMinutes, f.tableHint);

  // ✅ expose bucketSeconds to SQL (for q3)
  params.bucketSeconds = bucketSeconds;

  // required
  where.push(`partner = {partner:String}`);
  params.partner = f.partner;

  // optional dims
  addEq(where, params, "service", "service", f.service);
  addEq(where, params, "region", "region", f.region);
  addEq(where, params, "pop", "pop", f.pop);
  addEq(where, params, "content_type", "contentType", f.contentType);
  addEq(where, params, "ua_family", "uaFamily", f.uaFamily);

  // ✅ Anchoring rules:
  // - absolute: NEVER anchor to max(ts) / now()
  // - relative: respect anchorToMaxTs flag
  const anchorToMaxTs = hasAbsolute ? false : !!f.anchorToMaxTs;

  // ✅ Time bounds: absolute vs relative
  // Use parseDateTime64BestEffort for ISO strings (UTC Z included)
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

  // ✅ ALWAYS include both bounds
  // Level-2 rule: end is exclusive for clean bucket boundaries.
  where.push(`ts >= t_start AND ts < t_end`);
  const whereSql = `WHERE ${where.join(" AND ")}`;

  // ---- Query 0: headline totals ----
  const q0 = `
${timeWith}
SELECT
  t_start AS window_start,
  t_end   AS window_end,

  sum(requests) AS total_requests,
  sum(bytes_sent) AS bytes_sent,
  sum(http_2xx_count) AS http_2xx,
  sum(http_3xx_count) AS http_3xx,
  sum(http_4xx_count) AS http_4xx,
  sum(http_5xx_count) AS http_5xx,
  avg(p50_ms) AS p50_ms,
  avg(p95_ms) AS p95_ms,
  avg(p99_ms) AS p99_ms,
  avg(cache_hit_rate) AS cache_hit_rate,
  sum(crc_errors) AS crc_errors
FROM ${table}
${whereSql}
`.trim();

  // ---- Query 1: status breakdown ----
  const q1 = `
${timeWith}
SELECT status, c
FROM
(
  SELECT '200' AS status, sum(status_200) AS c FROM ${table} ${whereSql}
  UNION ALL SELECT '206', sum(status_206) FROM ${table} ${whereSql}
  UNION ALL SELECT '304', sum(status_304) FROM ${table} ${whereSql}
  UNION ALL SELECT '403', sum(status_403) FROM ${table} ${whereSql}
  UNION ALL SELECT '404', sum(status_404) FROM ${table} ${whereSql}
  UNION ALL SELECT '429', sum(status_429) FROM ${table} ${whereSql}
  UNION ALL SELECT '500', sum(status_500) FROM ${table} ${whereSql}
  UNION ALL SELECT '502', sum(status_502) FROM ${table} ${whereSql}
  UNION ALL SELECT '503', sum(status_503) FROM ${table} ${whereSql}
  UNION ALL SELECT '504', sum(status_504) FROM ${table} ${whereSql}
)
ORDER BY c DESC
`.trim();

  // ---- Query 2: top pops by 5xx ----
  const q2 = `
${timeWith}
SELECT
  pop,
  sum(http_5xx_count) AS http_5xx,
  sum(requests) AS total_requests,
  round(100.0 * http_5xx / nullIf(total_requests, 0), 3) AS err_rate_pct
FROM ${table}
${whereSql}
GROUP BY pop
ORDER BY http_5xx DESC
LIMIT 20
`.trim();

  // ---- Query 3: timeseries buckets (for UI graphs) ----
  const q3 = `
${timeWith}
SELECT
  toStartOfInterval(ts, INTERVAL {bucketSeconds:Int32} SECOND) AS bucket,
  sum(requests) AS total_requests,
  sum(http_5xx_count) AS http_5xx,
  avg(p95_ms) AS p95_ms,
  avg(p99_ms) AS p99_ms
FROM ${table}
${whereSql}
GROUP BY bucket
ORDER BY bucket ASC
`.trim();

  return {
    queries: [q0, q1, q2, q3],
    params,
    meta: {
      tableUsed: table,
      bucketSeconds,
      anchorToMaxTs,
    },
  };
}
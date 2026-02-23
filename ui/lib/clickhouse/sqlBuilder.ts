// lib/clickhouse/sqlBuilder.ts

export type ClickhouseFilters = {
  partner: string; // required
  service: string; // all|live|vod
  region: string; // all|...
  pop: string; // all|...
  contentType: string; // all|manifest|segment|api
  uaFamily: string; // all|stb|mobile|web|smart_tv|console
  windowMinutes: number; // e.g. 60

  // ✅ NEW: debug-friendly time anchoring
  anchorToMaxTs?: boolean;
};

export type BuiltSql = {
  queries: string[];
  params: Record<string, any>;
};

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

export function buildClickhouseSql(f: ClickhouseFilters): BuiltSql {
  const params: Record<string, any> = {};
  const where: string[] = [];

  // required
  where.push(`partner = {partner:String}`);
  params.partner = f.partner;

  // time window (toggle)
  if (f.anchorToMaxTs) {
    where.push(
      `ts >= (SELECT max(ts) FROM cachey.raw_minute) - toIntervalMinute({windowMinutes:Int32})`
    );
  } else {
    where.push(`ts >= now() - toIntervalMinute({windowMinutes:Int32})`);
  }
  params.windowMinutes = Math.max(1, Math.floor(f.windowMinutes || 60));

  // optional dims
  addEq(where, params, "service", "service", f.service);
  addEq(where, params, "region", "region", f.region);
  addEq(where, params, "pop", "pop", f.pop);
  addEq(where, params, "content_type", "contentType", f.contentType);
  addEq(where, params, "ua_family", "uaFamily", f.uaFamily);

  const whereSql = `WHERE ${where.join(" AND ")}`;

  const q0 = `
SELECT
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
FROM cachey.raw_minute
${whereSql}
`.trim();

  const q1 = `
SELECT status, c
FROM
(
  SELECT '200' AS status, sum(status_200) AS c FROM cachey.raw_minute ${whereSql}
  UNION ALL SELECT '206', sum(status_206) FROM cachey.raw_minute ${whereSql}
  UNION ALL SELECT '304', sum(status_304) FROM cachey.raw_minute ${whereSql}
  UNION ALL SELECT '403', sum(status_403) FROM cachey.raw_minute ${whereSql}
  UNION ALL SELECT '404', sum(status_404) FROM cachey.raw_minute ${whereSql}
  UNION ALL SELECT '429', sum(status_429) FROM cachey.raw_minute ${whereSql}
  UNION ALL SELECT '500', sum(status_500) FROM cachey.raw_minute ${whereSql}
  UNION ALL SELECT '502', sum(status_502) FROM cachey.raw_minute ${whereSql}
  UNION ALL SELECT '503', sum(status_503) FROM cachey.raw_minute ${whereSql}
  UNION ALL SELECT '504', sum(status_504) FROM cachey.raw_minute ${whereSql}
)
ORDER BY c DESC
`.trim();

  const q2 = `
SELECT
  pop,
  sum(http_5xx_count) AS http_5xx,
  sum(requests) AS total_requests,
  round(100.0 * http_5xx / nullIf(total_requests, 0), 3) AS err_rate_pct
FROM cachey.raw_minute
${whereSql}
GROUP BY pop
ORDER BY http_5xx DESC
LIMIT 20
`.trim();

  return { queries: [q0, q1, q2], params };
}
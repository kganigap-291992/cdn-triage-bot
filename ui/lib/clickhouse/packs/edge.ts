// lib/clickhouse/packs/edge.ts
// SQL builders for "Edge pack" metrics (summary / timeseries / breakdowns).
// NOTE: This file only builds SQL strings. It does not execute ClickHouse.
// NOTE: region/pop filtering intentionally not applied until mapping tables are wired.

import { EDGE_TABLES } from "../schema/edgeTables";

export type EdgePackInputs = {
  db: string;          // partner DB name (e.g., acme_media_db)
  service: string;     // "all" | "live" | "vod" etc
  region: string;      // "all" | "use1" | ...
  pop: string;         // "all" | "sjc" | ...
  windowMinutes: number;
};

export type EdgePackSql = {
  summarySql: string;
  timeseriesSql: string;
  hostBreakdownSql: string;
  crcByHostSql: string;
};

export function buildEdgePack(inputs: EdgePackInputs): EdgePackSql {
  // region/pop are intentionally unused for now (see NOTE above)
  const { db, service, windowMinutes } = inputs;

  // ------------------------------------------------------------
  // Resolve tables (generic + public-safe)
  // ------------------------------------------------------------
  const rollup15m = `${db}.${EDGE_TABLES.ROLLUP_15M}`;
  const host1m = `${db}.${EDGE_TABLES.HOST_1M}`;

  // ------------------------------------------------------------
  // Base time window filter (shared across queries)
  // ------------------------------------------------------------
  const safeWindowMinutes = Math.max(1, Math.floor(windowMinutes));

  const timeWhere =
    `datetime >= now() - INTERVAL ${safeWindowMinutes} MINUTE ` +
    `AND datetime < now()`;

  // ------------------------------------------------------------
  // WHERE clause builder
  // ------------------------------------------------------------
  const whereParts: string[] = [timeWhere];

  // Service filter (maps to `svc`, which exists in rollups)
  if (service && service !== "all") {
    const safeService = service.replace(/'/g, "''");
    whereParts.push(`svc = '${safeService}'`);
  }

  // TODO (later): region + pop require mapping/join (not present in schemas shown)
  // if (region && region !== "all") { ... }
  // if (pop && pop !== "all") { ... }

  const whereClause = `WHERE ${whereParts.join(" AND ")}`;

  // ------------------------------------------------------------
  // Summary SQL
  // - event_count (UInt64)
  // - client_response (LowCardinality(String)) for 5xx detection
  // - ttms_quants AggregateFunction(quantilesTiming(0.99,0.95,0.9), UInt32)
  //
  // We merge quantiles with quantilesTimingMerge and extract tuple elements:
  // - tupleElement(q, 1) = p95
  // - tupleElement(q, 2) = p99
  // ------------------------------------------------------------
  const summarySql = `
    WITH
      quantilesTimingMerge(0.95, 0.99)(ttms_quants) AS q
    SELECT
      toUInt64(sum(event_count)) AS totalRequests,
      toUInt64(sumIf(event_count, startsWith(client_response, '5'))) AS error5xxCount,
      toFloat64(tupleElement(q, 1)) AS p95TtmsMs,
      toFloat64(tupleElement(q, 2)) AS p99TtmsMs
    FROM ${rollup15m}
    ${whereClause}
  `;

  // ------------------------------------------------------------
  // Timeseries SQL (15m buckets from rollup table)
  // Safer GROUP BY datetime (avoid relying on alias support)
  // ------------------------------------------------------------
  const timeseriesSql = `
    SELECT
      datetime AS ts,
      toUInt64(sum(event_count)) AS totalRequests,
      toUInt64(sumIf(event_count, startsWith(client_response, '5'))) AS error5xxCount,
      toFloat64(tupleElement(quantilesTimingMerge(0.95, 0.99)(ttms_quants), 1)) AS p95TtmsMs,
      toFloat64(tupleElement(quantilesTimingMerge(0.95, 0.99)(ttms_quants), 2)) AS p99TtmsMs
    FROM ${rollup15m}
    ${whereClause}
    GROUP BY datetime
    ORDER BY datetime ASC
  `;

  // ------------------------------------------------------------
  // Host breakdown SQL (top hosts by request volume)
  // ------------------------------------------------------------
  const hostBreakdownSql = `
    SELECT
      host,
      toUInt64(sum(event_count)) AS totalRequests,
      toFloat64(tupleElement(quantilesTimingMerge(0.95, 0.99)(ttms_quants), 1)) AS p95TtmsMs,
      toFloat64(tupleElement(quantilesTimingMerge(0.95, 0.99)(ttms_quants), 2)) AS p99TtmsMs
    FROM ${host1m}
    ${whereClause}
    GROUP BY host
    ORDER BY totalRequests DESC
    LIMIT 50
  `;

  // ------------------------------------------------------------
  // CRC-by-host SQL (top CRCs overall)
  // ------------------------------------------------------------
  const crcByHostSql = `
    SELECT
      host,
      crc,
      toUInt64(sum(event_count)) AS count
    FROM ${host1m}
    ${whereClause}
    GROUP BY host, crc
    ORDER BY count DESC
    LIMIT 500
  `;

  return {
    summarySql,
    timeseriesSql,
    hostBreakdownSql,
    crcByHostSql,
  };
}

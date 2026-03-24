import type { DrillType } from "@/lib/triage/drillTypes";
import type { DrillPlan } from "@/lib/triage/drillPlanner";

export type BuiltDrillSql = {
  type: DrillType;
  title: string;
  queries: string[];
  params: Record<string, any>;
};

function quote(value: string): string {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function buildWhereClause(filters: DrillPlan["filters"]): string {
  const clauses: string[] = [];

  clauses.push(`partner = ${quote(filters.partner)}`);
  clauses.push(`service = ${quote(filters.service)}`);

  if (filters.region) clauses.push(`region = ${quote(filters.region)}`);
  if (filters.pop) clauses.push(`pop = ${quote(filters.pop)}`);
  if (filters.uaFamily) clauses.push(`ua_family = ${quote(filters.uaFamily)}`);
  if (filters.contentType) clauses.push(`content_type = ${quote(filters.contentType)}`);
  if (filters.host) clauses.push(`host = ${quote(filters.host)}`);
  if (filters.statusCode) clauses.push(`status_code = ${quote(filters.statusCode)}`);
  if (filters.endpointClass) clauses.push(`endpoint_class = ${quote(filters.endpointClass)}`);

  return clauses.join("\n  AND ");
}

function buildTimeClause(window: DrillPlan["window"]): string {
  if (
    window.timeMode === "absolute" &&
    window.startTsUtc &&
    window.endTsUtc
  ) {
    return `ts >= toDateTime(${quote(window.startTsUtc)}) AND ts < toDateTime(${quote(window.endTsUtc)})`;
  }

  return `ts >= now() - INTERVAL ${Math.max(1, Number(window.windowMinutes || 0))} MINUTE`;
}

// -----------------------------
// Core metric block (reusable)
// -----------------------------
function metricSelectBlock() {
  return `
  sum(requests) AS totalRequests,
  avg(p95_ms) AS p95TtmsMs,
  avg(p99_ms) AS p99TtmsMs,
  sum(http_5xx_count) AS error5xxCount,
  round(100.0 * sum(http_5xx_count) / nullIf(sum(requests), 0), 3) AS errorRatePct,
  avg(cache_hit_rate) AS cacheHitRate
`.trim();
}

// -----------------------------
// Query builders
// -----------------------------
function buildPeerComparisonQuery(plan: DrillPlan): string {
  const groupCol = plan.groupBy?.[0] || "region";
  const whereClause = buildWhereClause(plan.filters);
  const timeClause = buildTimeClause(plan.window);

  return `
SELECT
  ${groupCol} AS dimension,
  ${metricSelectBlock()}
FROM cachey.raw_minute
WHERE
  ${whereClause}
  AND ${timeClause}
GROUP BY ${groupCol}
ORDER BY errorRatePct DESC, p95TtmsMs DESC, totalRequests DESC
LIMIT 20
`.trim();
}

function buildOffenderRankingQuery(plan: DrillPlan): string {
  const groupCol = plan.groupBy?.[0] || "host";
  const whereClause = buildWhereClause(plan.filters);
  const timeClause = buildTimeClause(plan.window);

  return `
SELECT
  ${groupCol} AS dimension,
  ${metricSelectBlock()}
FROM cachey.raw_minute
WHERE
  ${whereClause}
  AND ${timeClause}
GROUP BY ${groupCol}
ORDER BY errorRatePct DESC, p95TtmsMs DESC, totalRequests DESC
LIMIT 20
`.trim();
}

function buildTimelineQuery(plan: DrillPlan): string {
  const whereClause = buildWhereClause(plan.filters);
  const timeClause = buildTimeClause(plan.window);

  return `
SELECT
  ts,
  ${metricSelectBlock()}
FROM cachey.raw_minute
WHERE
  ${whereClause}
  AND ${timeClause}
GROUP BY ts
ORDER BY ts ASC
`.trim();
}

function buildComparisonQuery(plan: DrillPlan): string {
  const whereClause = buildWhereClause(plan.filters);
  const timeClause = buildTimeClause(plan.window);

  return `
SELECT
  region,
  pop,
  ua_family,
  content_type,
  ${metricSelectBlock()}
FROM cachey.raw_minute
WHERE
  ${whereClause}
  AND ${timeClause}
GROUP BY region, pop, ua_family, content_type
ORDER BY errorRatePct DESC, p95TtmsMs DESC, totalRequests DESC
LIMIT 50
`.trim();
}

function buildNarrowScopeQuery(plan: DrillPlan): string {
  const whereClause = buildWhereClause(plan.filters);
  const timeClause = buildTimeClause(plan.window);

  return `
SELECT
  ${metricSelectBlock()}
FROM cachey.raw_minute
WHERE
  ${whereClause}
  AND ${timeClause}
`.trim();
}

// -----------------------------
// Main builder
// -----------------------------
export function buildDrillSql(plan: DrillPlan): BuiltDrillSql {
  let query: string;

  switch (plan.queryFamily) {
    case "peer_comparison":
      query = buildPeerComparisonQuery(plan);
      break;
    case "offender_ranking":
      query = buildOffenderRankingQuery(plan);
      break;
    case "timeline":
      query = buildTimelineQuery(plan);
      break;
    case "comparison":
      query = buildComparisonQuery(plan);
      break;
    case "narrow_scope":
    default:
      query = buildNarrowScopeQuery(plan);
      break;
  }

  return {
    type: plan.type,
    title: plan.title,
    queries: [query],
    params: {
      ...plan.filters,
      ...plan.window,
      targetDimension: plan.targetDimension,
      anchorValue: plan.anchorValue,
      queryFamily: plan.queryFamily,
    },
  };
}
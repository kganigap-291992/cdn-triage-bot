import type { EvidenceBundle } from "@/lib/triage/types";
import type { DrillRequest, DrillResult } from "@/lib/triage/drillTypes";
import { buildDrillPlan } from "@/lib/triage/drillPlanner";
import { buildDrillSql } from "@/lib/triage/drillSqlBuilder";

export type ExecuteDrillDeps = {
  runQuery?: (queries: string[], params: Record<string, any>) => Promise<any[]>;
};

function toNumberOrNull(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function normalizeRow(row: any): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {};

  for (const [k, v] of Object.entries(row || {})) {
    if (
      v == null ||
      typeof v === "string" ||
      typeof v === "number" ||
      typeof v === "boolean"
    ) {
      out[k] = v as string | number | boolean | null;
    } else if (v instanceof Date) {
      out[k] = v.toISOString();
    } else {
      out[k] = String(v);
    }
  }

  return out;
}

function summarizeRows(request: DrillRequest, rows: Record<string, any>[]): string {
  if (!rows.length) {
    switch (request.type) {
      case "worst_region":
        return "No region drill-down evidence found for the current scope.";
      case "worst_pop":
        return "No POP drill-down evidence found for the current scope.";
      case "worst_ua":
        return "No UA-family drill-down evidence found for the current scope.";
      case "worst_content":
        return "No content-type drill-down evidence found for the current scope.";
      case "worst_host":
        return "No host-level drill-down evidence found for the current scope.";
      case "worst_status":
        return "No status-code drill-down evidence found for the current scope.";
      case "worst_endpoint":
        return "No endpoint-class drill-down evidence found for the current scope.";
      case "time_trend":
        return "No timeline drill-down evidence found for the current scope.";
      case "comparison":
        return "No comparison drill-down evidence found for the current scope.";
      default:
        return "No drill-down evidence found.";
    }
  }

  const top = rows[0] || {};
  const dimension =
    top.dimension ??
    top.region ??
    top.pop ??
    top.ua_family ??
    top.content_type ??
    top.host ??
    top.status_code ??
    top.endpoint_class ??
    top.ts ??
    "top result";

  const totalRequests =
    toNumberOrNull(top.totalRequests) ??
    toNumberOrNull(top.total_requests) ??
    0;

  const p95 =
    toNumberOrNull(top.p95TtmsMs) ??
    toNumberOrNull(top.p95_ms) ??
    toNumberOrNull(top.p95_ttms_ms);

  const p99 =
    toNumberOrNull(top.p99TtmsMs) ??
    toNumberOrNull(top.p99_ms) ??
    toNumberOrNull(top.p99_ttms_ms);

  const errorRate =
    toNumberOrNull(top.errorRatePct) ??
    toNumberOrNull(top.error_rate_pct);

  const cacheHit =
    toNumberOrNull(top.cacheHitPct) ??
    toNumberOrNull(top.cacheHitRate) ??
    toNumberOrNull(top.cache_hit_rate);

  const metrics = [
    totalRequests ? `requests=${Math.round(totalRequests).toLocaleString()}` : null,
    p95 != null ? `p95=${Math.round(p95)}ms` : null,
    p99 != null ? `p99=${Math.round(p99)}ms` : null,
    errorRate != null ? `5xx=${errorRate.toFixed(3)}%` : null,
    cacheHit != null ? `cache=${(cacheHit > 1 ? cacheHit : cacheHit * 100).toFixed(1)}%` : null,
  ]
    .filter(Boolean)
    .join(", ");

  switch (request.type) {
    case "worst_region":
      return `Top impacted region is ${dimension}${metrics ? ` (${metrics})` : ""}.`;
    case "worst_pop":
      return `Top impacted POP is ${dimension}${metrics ? ` (${metrics})` : ""}.`;
    case "worst_ua":
      return `Top impacted UA family is ${dimension}${metrics ? ` (${metrics})` : ""}.`;
    case "worst_content":
      return `Top impacted content type is ${dimension}${metrics ? ` (${metrics})` : ""}.`;
    case "worst_host":
      return `Top impacted host is ${dimension}${metrics ? ` (${metrics})` : ""}.`;
    case "worst_status":
      return `Top status-code signal is ${dimension}${metrics ? ` (${metrics})` : ""}.`;
    case "worst_endpoint":
      return `Top impacted endpoint class is ${dimension}${metrics ? ` (${metrics})` : ""}.`;
    case "time_trend":
      return `Timeline drill returned ${rows.length} point${rows.length === 1 ? "" : "s"} for the current scope.`;
    case "comparison":
      return `Comparison drill returned ${rows.length} row${rows.length === 1 ? "" : "s"} for the current scope.`;
    default:
      return `Drill returned ${rows.length} row${rows.length === 1 ? "" : "s"}.`;
  }
}

export async function executeDrill(
  request: DrillRequest,
  bundle: EvidenceBundle,
  deps: ExecuteDrillDeps = {}
): Promise<DrillResult> {
  const plan = buildDrillPlan(request);
  const built = buildDrillSql(plan);

  let rawRows: any[] = [];

  if (request.type === "worst_region") {
    rawRows = bundle?.regionBreakdown ?? [];
  } else if (request.type === "worst_pop") {
    rawRows = bundle?.popBreakdown ?? [];
  }

  if (!rawRows.length && deps.runQuery) {
    rawRows = await deps.runQuery(built.queries, built.params);
  }

  const rows = Array.isArray(rawRows) ? rawRows.map(normalizeRow) : [];
  const summary = summarizeRows(request, rows);

  return {
    type: request.type,
    title: plan.title,
    summary,
    rows,
    sql: {
      queries: built.queries,
      params: built.params,
    },
    metadata: {
      targetDimension: plan.targetDimension as any,
      anchorValue: plan.anchorValue,
      rowCount: rows.length,
    },
  };
}
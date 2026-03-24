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
      case "ua_breakdown":
        return "No UA-family drill-down evidence found for the current scope.";
      case "content_breakdown":
        return "No content-type drill-down evidence found for the current scope.";
      case "host_breakdown":
        return "No host-level drill-down evidence found for the current scope.";
      case "status_breakdown":
        return "No status-code drill-down evidence found for the current scope.";
      case "endpoint_breakdown":
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
    default:
      return `Drill returned ${rows.length} rows.`;
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

  // ✅ USE EXISTING EVIDENCE FIRST
  if (request.type === "worst_region") {
    rawRows = bundle?.regionBreakdown ?? [];
  } else if (request.type === "worst_pop") {
    rawRows = bundle?.popBreakdown ?? [];
  }

  // ✅ FALLBACK TO SQL (future / advanced drills)
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
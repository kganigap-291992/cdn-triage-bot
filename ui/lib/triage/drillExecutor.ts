import type { EvidenceBundle } from "@/lib/triage/types";
import type {
  DrillRequest,
  DrillResult,
  DrillTargetDimension,
  DrillTimeseries,
  DrillTimeseriesPoint,
} from "@/lib/triage/drillTypes";
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
    top.uaFamily ??
    top.ua_family ??
    top.contentType ??
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
    cacheHit != null
      ? `cache=${(cacheHit > 1 ? cacheHit : cacheHit * 100).toFixed(1)}%`
      : null,
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

function getBundleRows(bundle: EvidenceBundle, source?: string): any[] {
  switch (source) {
    case "regionBreakdown":
      return bundle.regionBreakdown ?? [];
    case "popBreakdown":
      return bundle.popBreakdown ?? [];
    case "uaBreakdown":
      return bundle.uaBreakdown ?? [];
    case "contentBreakdown":
      return bundle.contentBreakdown ?? [];
    case "hostBreakdown":
      return bundle.hostBreakdown ?? [];
    default:
      return [];
  }
}

function inferSelectedValueFromTopRow(
  targetDimension: DrillTargetDimension | undefined,
  topRow: Record<string, any> | null | undefined
): string | null {
  if (!targetDimension || !topRow) return null;

  switch (targetDimension) {
    case "region":
      return String(topRow.region ?? topRow.dimension ?? "").trim() || null;
    case "pop":
      return String(topRow.pop ?? topRow.dimension ?? "").trim() || null;
    case "uaFamily":
      return (
        String(topRow.uaFamily ?? topRow.ua_family ?? topRow.dimension ?? "").trim() || null
      );
    case "contentType":
      return (
        String(topRow.contentType ?? topRow.content_type ?? topRow.dimension ?? "").trim() || null
      );
    default:
      return null;
  }
}

function canEnrichTimeseries(
  plan: ReturnType<typeof buildDrillPlan>,
  rows: Record<string, any>[],
  deps: ExecuteDrillDeps
): boolean {
  if (!plan.enableTimeseries) return false;
  if (!rows.length) return false;
  if (!deps.runQuery) return false;

  return (
    plan.targetDimension === "region" ||
    plan.targetDimension === "pop" ||
    plan.targetDimension === "uaFamily" ||
    plan.targetDimension === "contentType"
  );
}

function buildTimeseriesFilters(
  plan: ReturnType<typeof buildDrillPlan>,
  selectedValue: string
) {
  const baseFilters = {
    ...plan.filters,
  };

  switch (plan.targetDimension) {
    case "region":
      return { ...baseFilters, region: selectedValue };
    case "pop":
      return { ...baseFilters, pop: selectedValue };
    case "uaFamily":
      return { ...baseFilters, uaFamily: selectedValue };
    case "contentType":
      return { ...baseFilters, contentType: selectedValue };
    default:
      return baseFilters;
  }
}

function toDrillTimeseriesPoints(rows: any[]): DrillTimeseriesPoint[] {
  return (Array.isArray(rows) ? rows : [])
    .map((row): DrillTimeseriesPoint | null => {
      const ts = String(row?.ts ?? row?.bucket ?? "").trim();
      if (!ts) return null;

      return {
        ts,
        totalRequests:
          Number(row?.totalRequests ?? row?.total_requests ?? row?.requests ?? 0) || 0,
        error5xxCount:
          Number(row?.error5xxCount ?? row?.error_5xx_count ?? row?.http_5xx ?? 0) || 0,
        errorRatePct:
          Number(row?.errorRatePct ?? row?.error_rate_pct ?? 0) || 0,
        p95TtmsMs: toNumberOrNull(row?.p95TtmsMs ?? row?.p95_ms ?? row?.p95_ttms_ms),
        p99TtmsMs: toNumberOrNull(row?.p99TtmsMs ?? row?.p99_ms ?? row?.p99_ttms_ms),
        cacheHitRate: toNumberOrNull(
          row?.cacheHitRate ?? row?.cache_hit_rate ?? row?.cacheHitPct
        ),
      };
    })
    .filter(Boolean) as DrillTimeseriesPoint[];
}

function inferBucketSecondsFromTimeseries(points: DrillTimeseriesPoint[]): number | null {
  if (!points || points.length < 2) return null;

  const t0 = new Date(points[0].ts).getTime();
  const t1 = new Date(points[1].ts).getTime();

  if (!Number.isFinite(t0) || !Number.isFinite(t1) || t1 <= t0) return null;

  return Math.round((t1 - t0) / 1000);
}

async function fetchDrillTimeseries(
  plan: ReturnType<typeof buildDrillPlan>,
  selectedValue: string,
  deps: ExecuteDrillDeps
): Promise<{
  timeseries: DrillTimeseries | undefined;
  timeseriesSql:
    | {
        queries?: string[];
        params?: Record<string, any>;
      }
    | undefined;
}> {
  if (!deps.runQuery || !plan.targetDimension) {
    return { timeseries: undefined, timeseriesSql: undefined };
  }

  const narrowedPlan = {
    ...plan,
    executionMode: "canonical_query" as const,
    evidenceSource: "timeseries" as const,
    queryFamily: "timeline" as const,
    filters: buildTimeseriesFilters(plan, selectedValue),
    anchorValue: selectedValue,
  };

  const built = buildDrillSql(narrowedPlan);
  if (!built.queries?.length) {
    return { timeseries: undefined, timeseriesSql: undefined };
  }

  const raw = await deps.runQuery(built.queries, built.params);
  const points = toDrillTimeseriesPoints(raw);

  if (!points.length || !narrowedPlan.targetDimension) {
    return {
      timeseries: undefined,
      timeseriesSql: {
        queries: built.queries,
        params: built.params,
      },
    };
  }

  const bucketSeconds = inferBucketSecondsFromTimeseries(points);

  return {
    timeseries: {
      selectedDimension: narrowedPlan.targetDimension as DrillTargetDimension,
      selectedValue,
      bucketSeconds,
      startTs: points[0]?.ts ?? null,
      endTs: points[points.length - 1]?.ts ?? null,
      points,
    },
    timeseriesSql: {
      queries: built.queries,
      params: built.params,
    },
  };
}

export async function executeDrill(
  request: DrillRequest,
  bundle: EvidenceBundle,
  deps: ExecuteDrillDeps = {}
): Promise<DrillResult> {
  const plan = buildDrillPlan(request);

  let rawRows: any[] = [];

  if (request.executionMode === "bundle") {
    rawRows = getBundleRows(bundle, request.evidenceSource);
  }

  if (!rawRows.length && deps.runQuery) {
    const built = buildDrillSql(plan);
    rawRows = await deps.runQuery(built.queries, built.params);

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
        executionMode: request.executionMode,
        evidenceSource: request.evidenceSource,
      },
    };
  }

  const rows = Array.isArray(rawRows) ? rawRows.map(normalizeRow) : [];
  const summary = summarizeRows(request, rows);

  let timeseries: DrillTimeseries | undefined;
  let timeseriesSql:
    | {
        queries?: string[];
        params?: Record<string, any>;
      }
    | undefined;

  if (canEnrichTimeseries(plan, rows, deps)) {
    const topRow = rows[0] || null;
    const selectedValue = inferSelectedValueFromTopRow(
      plan.targetDimension as DrillTargetDimension | undefined,
      topRow
    );

    if (selectedValue) {
      const enriched = await fetchDrillTimeseries(plan, selectedValue, deps);
      timeseries = enriched.timeseries;
      timeseriesSql = enriched.timeseriesSql;
    }
  }

  return {
    type: request.type,
    title: plan.title,
    summary,
    rows,
    sql: timeseriesSql,
    timeseries,
    metadata: {
      targetDimension: plan.targetDimension as any,
      anchorValue: plan.anchorValue,
      rowCount: rows.length,
      executionMode: request.executionMode,
      evidenceSource: request.evidenceSource,
    },
  };
}
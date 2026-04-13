import type { DrillType } from "@/lib/triage/drillTypes";
import type { DrillPlan } from "@/lib/triage/drillPlanner";
import {
  buildClickhouseSql,
  type ClickhouseFilters,
} from "@/lib/clickhouse/sqlBuilder";

export type BuiltDrillSql = {
  type: DrillType;
  title: string;
  queries: string[];
  params: Record<string, any>;
};

function denorm(v: string | undefined): string {
  return v && v.trim() ? v.trim() : "all";
}

function toCanonicalFilters(plan: DrillPlan): ClickhouseFilters {
  return {
    partner: plan.filters.partner,
    service: plan.filters.service,
    region: denorm(plan.filters.region),
    pop: denorm(plan.filters.pop),
    contentType: denorm(plan.filters.contentType),
    uaFamily: denorm(plan.filters.uaFamily),
    windowMinutes: Math.max(1, Number(plan.window.windowMinutes || 60)),
    startTsUtc:
      plan.window.timeMode === "absolute"
        ? plan.window.startTsUtc || undefined
        : undefined,
    endTsUtc:
      plan.window.timeMode === "absolute"
        ? plan.window.endTsUtc || undefined
        : undefined,
    anchorToMaxTs: plan.window.timeMode === "relative",
  };
}

/**
 * Canonical sqlBuilder.ts query index map
 *
 * q4  = current timeseries
 * q8  = previous timeseries
 * q9  = current status over time
 * q10 = previous status over time
 * q13 = host summary
 * q14 = current status totals
 * q15 = previous status totals
 * q16 = current ATS summary
 * q17 = previous ATS summary
 * q18 = current ATS over time
 * q19 = previous ATS over time
 */
const CANONICAL_QUERY_INDEX = {
  timeseriesCurrent: 4,
  timeseriesPrevious: 8,
  statusOverTimeCurrent: 9,
  statusOverTimePrevious: 10,
  hostSummary: 13,
  statusTotalsCurrent: 14,
  statusTotalsPrevious: 15,
  atsSummaryCurrent: 16,
  atsSummaryPrevious: 17,
  atsTimeseriesCurrent: 18,
  atsTimeseriesPrevious: 19,
} as const;

function isTimeseriesEnrichmentPlan(plan: DrillPlan): boolean {
  return (
    plan.executionMode === "canonical_query" &&
    plan.evidenceSource === "timeseries" &&
    plan.queryFamily === "timeline" &&
    !!plan.anchorValue &&
    (plan.targetDimension === "region" ||
      plan.targetDimension === "pop" ||
      plan.targetDimension === "uaFamily" ||
      plan.targetDimension === "contentType")
  );
}

export function buildDrillSql(plan: DrillPlan): BuiltDrillSql {
  // Bundle-backed ranking drills should not generate SQL
  // in their normal ranking path.
  if (plan.executionMode === "bundle") {
    return {
      type: plan.type,
      title: plan.title,
      queries: [],
      params: {
        ...plan.filters,
        ...plan.window,
        targetDimension: plan.targetDimension,
        anchorValue: plan.anchorValue,
        executionMode: plan.executionMode,
        evidenceSource: plan.evidenceSource,
        enableTimeseries: plan.enableTimeseries,
      },
    };
  }

  const built = buildClickhouseSql(toCanonicalFilters(plan));
  let selectedQueries: string[] = [];

  // Generic narrowed same-window drill enrichment path:
  // worst_region / worst_pop / worst_ua / worst_content over time
  if (isTimeseriesEnrichmentPlan(plan)) {
    selectedQueries = [built.queries[CANONICAL_QUERY_INDEX.timeseriesCurrent]];
  } else {
    switch (plan.evidenceSource) {
      case "host_summary":
        selectedQueries = [built.queries[CANONICAL_QUERY_INDEX.hostSummary]];
        break;

      case "timeseries":
        selectedQueries = [
          built.queries[CANONICAL_QUERY_INDEX.timeseriesCurrent],
          built.queries[CANONICAL_QUERY_INDEX.timeseriesPrevious],
        ];
        break;

      case "status_totals":
        selectedQueries = [
          built.queries[CANONICAL_QUERY_INDEX.statusTotalsCurrent],
          built.queries[CANONICAL_QUERY_INDEX.statusTotalsPrevious],
        ];
        break;

      case "status_over_time":
        selectedQueries = [
          built.queries[CANONICAL_QUERY_INDEX.statusOverTimeCurrent],
          built.queries[CANONICAL_QUERY_INDEX.statusOverTimePrevious],
        ];
        break;

      case "ats_summary":
        selectedQueries = [
          built.queries[CANONICAL_QUERY_INDEX.atsSummaryCurrent],
          built.queries[CANONICAL_QUERY_INDEX.atsSummaryPrevious],
        ];
        break;

      case "ats_timeseries":
        selectedQueries = [
          built.queries[CANONICAL_QUERY_INDEX.atsTimeseriesCurrent],
          built.queries[CANONICAL_QUERY_INDEX.atsTimeseriesPrevious],
        ];
        break;

      case "unsupported":
      case "unknown":
      default:
        selectedQueries = [];
        break;
    }
  }

  return {
    type: plan.type,
    title: plan.title,
    queries: selectedQueries.filter(Boolean),
    params: {
      ...built.params,
      targetDimension: plan.targetDimension,
      anchorValue: plan.anchorValue,
      executionMode: plan.executionMode,
      evidenceSource: plan.evidenceSource,
      enableTimeseries: plan.enableTimeseries,
      canonicalTableUsed: built.meta.tableUsed,
      canonicalBucketSeconds: built.meta.bucketSeconds,
      canonicalAnchorToMaxTs: built.meta.anchorToMaxTs,
    },
  };
}
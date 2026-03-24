import type { DrillRequest, DrillResult, DrillType } from "@/lib/triage/drillTypes";

export type DrillPlan = {
  type: DrillType;
  title: string;
  description: string;
  queryFamily:
    | "peer_comparison"
    | "offender_ranking"
    | "timeline"
    | "narrow_scope"
    | "comparison";
  groupBy?: string[];
  filters: {
    partner: string;
    service: string;
    region?: string;
    pop?: string;
    uaFamily?: string;
    contentType?: string;
    host?: string;
    statusCode?: string;
    endpointClass?: string;
  };
  window: {
    startTsUtc?: string | null;
    endTsUtc?: string | null;
    windowMinutes: number;
    timeMode: "relative" | "absolute";
  };
  targetDimension?: string;
  anchorValue?: string;
};

function normalizeScopeFilterValue(v: string | undefined): string | undefined {
  if (!v) return undefined;
  const s = String(v).trim();
  if (!s || s === "all") return undefined;
  return s;
}

export function buildDrillPlan(request: DrillRequest): DrillPlan {
  const baseFilters = {
    partner: request.scope.partner,
    service: request.scope.service,
    region: normalizeScopeFilterValue(request.scope.region),
    pop: normalizeScopeFilterValue(request.scope.pop),
    uaFamily: normalizeScopeFilterValue(request.scope.uaFamily),
    contentType: normalizeScopeFilterValue(request.scope.contentType),
    host: normalizeScopeFilterValue(request.scope.host),
    statusCode: normalizeScopeFilterValue(request.scope.statusCode),
    endpointClass: normalizeScopeFilterValue(request.scope.endpointClass),
  };

  switch (request.type) {
    // ---------------------------------------------
    // REGION / POP
    // ---------------------------------------------
    case "worst_region":
      return {
        type: request.type,
        title: "Worst Region",
        description: "Rank regions within the current investigation scope.",
        queryFamily: "peer_comparison",
        groupBy: ["region"],
        filters: { ...baseFilters, region: undefined },
        window: request.window,
        targetDimension: "region",
      };

    case "worst_pop":
      return {
        type: request.type,
        title: "Worst POP",
        description: "Rank POPs within the current investigation scope.",
        queryFamily: "peer_comparison",
        groupBy: ["pop"],
        filters: { ...baseFilters, pop: undefined },
        window: request.window,
        targetDimension: "pop",
      };

    // ---------------------------------------------
    // USER / CONTENT
    // ---------------------------------------------
    case "worst_ua":
      return {
        type: request.type,
        title: "Worst UA Family",
        description: "Identify most impacted user-agent families.",
        queryFamily: "peer_comparison",
        groupBy: ["uaFamily"],
        filters: { ...baseFilters, uaFamily: undefined },
        window: request.window,
        targetDimension: "uaFamily",
      };

    case "worst_content":
      return {
        type: request.type,
        title: "Worst Content Type",
        description: "Identify most impacted content types.",
        queryFamily: "peer_comparison",
        groupBy: ["contentType"],
        filters: { ...baseFilters, contentType: undefined },
        window: request.window,
        targetDimension: "contentType",
      };

    // ---------------------------------------------
    // INFRA
    // ---------------------------------------------
    case "worst_host":
      return {
        type: request.type,
        title: "Worst Host",
        description: "Identify hosts contributing most to degradation.",
        queryFamily: "offender_ranking",
        groupBy: ["host"],
        filters: baseFilters,
        window: request.window,
        targetDimension: "host",
      };

    case "worst_status":
      return {
        type: request.type,
        title: "Worst Status Codes",
        description: "Identify status codes driving errors.",
        queryFamily: "offender_ranking",
        groupBy: ["statusCode"],
        filters: baseFilters,
        window: request.window,
        targetDimension: "statusCode",
      };

    case "worst_endpoint":
      return {
        type: request.type,
        title: "Worst Endpoint Class",
        description: "Identify endpoints contributing most to degradation.",
        queryFamily: "offender_ranking",
        groupBy: ["endpointClass"],
        filters: baseFilters,
        window: request.window,
        targetDimension: "endpointClass",
      };

    // ---------------------------------------------
    // ANALYSIS
    // ---------------------------------------------
    case "time_trend":
      return {
        type: request.type,
        title: "Time Trend",
        description: "Analyze how the signal evolved over time.",
        queryFamily: "timeline",
        filters: baseFilters,
        window: request.window,
      };

    case "comparison":
      return {
        type: request.type,
        title: "Comparison",
        description: "Compare slices within the investigation scope.",
        queryFamily: "comparison",
        filters: baseFilters,
        window: request.window,
        targetDimension: request.targetDimension,
      };

    default:
      return {
        type: request.type,
        title: "Drill-down",
        description: "Generic drill-down plan.",
        queryFamily: "narrow_scope",
        filters: baseFilters,
        window: request.window,
      };
  }
}

export function buildPlannedEmptyDrillResult(
  plan: DrillPlan,
  summary?: string
): DrillResult {
  return {
    type: plan.type,
    title: plan.title,
    summary: summary || plan.description,
    rows: [],
    metadata: {
      targetDimension: plan.targetDimension as any,
      anchorValue: plan.anchorValue,
      rowCount: 0,
    },
  };
}
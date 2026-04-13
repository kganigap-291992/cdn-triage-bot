import type { EvidenceBundle } from "@/lib/triage/types";
import type {
  DrillEvidenceSource,
  DrillRequest,
  DrillResult,
} from "@/lib/triage/drillTypes";

export type DrillIntent =
  | "worst_region"
  | "worst_pop"
  | "worst_ua"
  | "worst_content"
  | "worst_host"
  | "worst_status"
  | "worst_endpoint"
  | "time_trend"
  | "comparison";

function buildBaseScope(bundle: EvidenceBundle): DrillRequest["scope"] {
  return {
    partner: bundle.normalizedScope.partner,
    service: bundle.normalizedScope.service,
    region: bundle.normalizedScope.region,
    pop: bundle.normalizedScope.pop,
    uaFamily: bundle.normalizedScope.uaFamily,
    contentType: bundle.normalizedScope.contentType,
  };
}

function buildBaseWindow(bundle: EvidenceBundle): DrillRequest["window"] {
  return {
    startTsUtc:
      bundle.windowInfo.timeMode === "absolute"
        ? bundle.windowInfo.startTs
        : null,
    endTsUtc:
      bundle.windowInfo.timeMode === "absolute"
        ? bundle.windowInfo.endTs
        : null,
    windowMinutes: bundle.windowInfo.windowMinutes,
    timeMode: bundle.windowInfo.timeMode,
  };
}

function pickWorstValue(
  rows: any[] | undefined,
  key: string
): string | undefined {
  if (!Array.isArray(rows) || !rows.length) return undefined;

  const sorted = [...rows].sort((a, b) => {
    const aErr = Number(a?.errorRatePct ?? a?.error_rate_pct ?? 0);
    const bErr = Number(b?.errorRatePct ?? b?.error_rate_pct ?? 0);
    if (bErr !== aErr) return bErr - aErr;

    const aP95 = Number(a?.p95TtmsMs ?? a?.p95_ttms_ms ?? a?.p95_ms ?? 0);
    const bP95 = Number(b?.p95TtmsMs ?? b?.p95_ttms_ms ?? b?.p95_ms ?? 0);
    if (bP95 !== aP95) return bP95 - aP95;

    const aReq = Number(
      a?.totalRequests ?? a?.total_requests ?? a?.requests ?? 0
    );
    const bReq = Number(
      b?.totalRequests ?? b?.total_requests ?? b?.requests ?? 0
    );
    return bReq - aReq;
  });

  const val = String(sorted[0]?.[key] ?? "").trim();
  return val || undefined;
}

function buildBundleRequest(
  type: DrillRequest["type"],
  scope: DrillRequest["scope"],
  window: DrillRequest["window"],
  targetDimension: DrillRequest["targetDimension"],
  evidenceSource: DrillEvidenceSource,
  anchorValue?: string
): DrillRequest {
  return {
    type,
    scope,
    window,
    targetDimension,
    anchorValue,
    executionMode: "bundle",
    evidenceSource,
  };
}

function buildCanonicalRequest(
  type: DrillRequest["type"],
  scope: DrillRequest["scope"],
  window: DrillRequest["window"],
  targetDimension?: DrillRequest["targetDimension"],
  evidenceSource?: DrillEvidenceSource,
  anchorValue?: string
): DrillRequest {
  return {
    type,
    scope,
    window,
    targetDimension,
    anchorValue,
    executionMode: "canonical_query",
    evidenceSource,
  };
}

export function resolveDrillRequest(
  intent: DrillIntent,
  bundle: EvidenceBundle
): DrillRequest | null {
  const scope = buildBaseScope(bundle);
  const window = buildBaseWindow(bundle);

  switch (intent) {
    case "worst_region": {
      const worstRegion = pickWorstValue(bundle.regionBreakdown, "region");
      return buildBundleRequest(
        "worst_region",
        scope,
        window,
        "region",
        "regionBreakdown",
        worstRegion
      );
    }

    case "worst_pop": {
      const worstPop = pickWorstValue(bundle.popBreakdown, "pop");
      return buildBundleRequest(
        "worst_pop",
        scope,
        window,
        "pop",
        "popBreakdown",
        worstPop
      );
    }

    case "worst_ua": {
      const worstUa = pickWorstValue(bundle.uaBreakdown, "uaFamily");
      return buildBundleRequest(
        "worst_ua",
        scope,
        window,
        "uaFamily",
        "uaBreakdown",
        worstUa
      );
    }

    case "worst_content": {
      const worstContent = pickWorstValue(bundle.contentBreakdown, "contentType");
      return buildBundleRequest(
        "worst_content",
        scope,
        window,
        "contentType",
        "contentBreakdown",
        worstContent
      );
    }

    case "worst_host": {
      const worstHost = pickWorstValue(bundle.hostBreakdown, "host");
      return buildCanonicalRequest(
        "worst_host",
        scope,
        window,
        "host",
        "host_summary",
        worstHost
      );
    }

    case "worst_status":
      return buildCanonicalRequest(
        "worst_status",
        scope,
        window,
        "statusCode",
        "status_totals"
      );

    case "worst_endpoint":
      return buildCanonicalRequest(
        "worst_endpoint",
        scope,
        window,
        "endpointClass",
        "unsupported"
      );

    case "time_trend":
      return buildCanonicalRequest(
        "time_trend",
        scope,
        window,
        undefined,
        "timeseries"
      );

    case "comparison":
      return buildCanonicalRequest(
        "comparison",
        scope,
        window,
        undefined,
        "timeseries"
      );

    default:
      return null;
  }
}

export function buildEmptyDrillResult(
  request: DrillRequest,
  summary: string
): DrillResult {
  return {
    type: request.type,
    title: request.type,
    summary,
    rows: [],
    metadata: {
      targetDimension: request.targetDimension,
      anchorValue: request.anchorValue,
      rowCount: 0,
      executionMode: request.executionMode,
      evidenceSource: request.evidenceSource,
    },
  };
}
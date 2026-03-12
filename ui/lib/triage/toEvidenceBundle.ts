// ui/lib/triage/toEvidenceBundle.ts

import type {
  ClickhouseTriageInputs,
  ClickhouseTriageResult,
} from "@/lib/clickhouse/runClickhouseTriage";
import type {
  Diagnostics,
  DerivedMetrics,
  EvidenceBundle,
  NormalizedScope,
  TimeSeriesPoint,
  WindowInfo,
} from "@/lib/triage/types";

function safeNumber(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function asString(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v : null;
}

function buildNormalizedScope(inputs: ClickhouseTriageInputs): NormalizedScope {
  return {
    partner: String(inputs.partner || "").trim(),
    service: String(inputs.service || "").trim(),
    region: String(inputs.region || "all").trim(),
    pop: String(inputs.pop || "all").trim(),
    contentType: String(inputs.contentType || "all").trim(),
    uaFamily: String(inputs.uaFamily || "all").trim(),
  };
}

function buildWindowInfo(
  inputs: ClickhouseTriageInputs,
  result: ClickhouseTriageResult
): WindowInfo {
  const debug = result?.metricsJson?.debug || {};
  const tr = result?.metricsJson?.timeRangeUTC || {};
  const startTs =
    asString(tr.start) ||
    asString(result?.metricsJson?.timeseries?.startTs) ||
    asString(debug.startTsUtc) ||
    "";
  const endTs =
    asString(tr.end) ||
    asString(result?.metricsJson?.timeseries?.endTs) ||
    asString(debug.endTsUtc) ||
    "";

  const timeMode =
    debug.timeMode === "absolute" || debug.timeMode === "relative"
      ? debug.timeMode
      : inputs.startTsUtc && inputs.endTsUtc
      ? "absolute"
      : "relative";

  return {
    startTs,
    endTs,
    windowMinutes: Number(inputs.windowMinutes || 0),
    timeMode,
  };
}

function buildCurrentMetrics(result: ClickhouseTriageResult) {
  const m = result?.metricsJson || {};
  return {
    totalRequests: Number(m.totalRequests || 0),
    p95TtmsMs: safeNumber(m.p95TtmsMs),
    error5xxCount: safeNumber(m.error5xxCount),
    errorRatePct: safeNumber(m.errorRatePct),
    cacheHitRate:
      safeNumber(m.cacheHitRate) ??
      safeNumber(m.cacheHitPct),
  };
}

function buildTimeseries(result: ClickhouseTriageResult): TimeSeriesPoint[] {
  const points = result?.metricsJson?.timeseries?.points;
  if (!Array.isArray(points)) return [];

  return points
    .map((p: any): TimeSeriesPoint => ({
      ts: String(p?.ts || ""),
      requests:
        safeNumber(p?.requests) ??
        safeNumber(p?.totalRequests),
      p95TtmsMs: safeNumber(p?.p95TtmsMs),
      errorRatePct: safeNumber(p?.errorRatePct),
      cacheHitRate:
        safeNumber(p?.cacheHitRate) ??
        safeNumber(p?.cacheHitPct),
    }))
    .filter((pt: TimeSeriesPoint) => Boolean(pt.ts));
}

function buildDerivedMetrics(result: ClickhouseTriageResult): DerivedMetrics {
  const m = result?.metricsJson || {};
  return {
    errorRatePct: safeNumber(m.errorRatePct),
    cacheHitRate:
      safeNumber(m.cacheHitRate) ??
      safeNumber(m.cacheHitPct),
  };
}

function buildDiagnostics(result: ClickhouseTriageResult): Diagnostics {
  const debug = result?.metricsJson?.debug || {};
  return {
    tableUsed: asString(debug.tableUsed) || undefined,
    bucketSeconds: safeNumber(debug.bucketSeconds),
    timeMode:
      debug.timeMode === "absolute" || debug.timeMode === "relative"
        ? debug.timeMode
        : undefined,
    anchorToMaxTs:
      typeof debug.anchorToMaxTs === "boolean"
        ? debug.anchorToMaxTs
        : undefined,
    source: debug.forcedLocal ? "local" : "proxy",
  };
}

export function toEvidenceBundle(
  inputs: ClickhouseTriageInputs,
  result: ClickhouseTriageResult
): EvidenceBundle {
  const normalizedScope = buildNormalizedScope(inputs);
  const windowInfo = buildWindowInfo(inputs, result);
  const currentMetrics = buildCurrentMetrics(result);
  const currentPoints = buildTimeseries(result);
  const derivedMetrics = buildDerivedMetrics(result);
  const diagnostics = buildDiagnostics(result);

  return {
    normalizedScope,
    windowInfo,
    currentMetrics,
    previousMetrics: undefined,
    timeseries: {
      bucketSeconds:
        safeNumber(result?.metricsJson?.timeseries?.bucketSeconds) ?? null,
      startTs:
        asString(result?.metricsJson?.timeseries?.startTs) ?? null,
      endTs:
        asString(result?.metricsJson?.timeseries?.endTs) ?? null,
      points: currentPoints,
    },
    derivedMetrics,
    regionBreakdown: [],
    popBreakdown: [],
    worstLatency: [],
    worstErrors: [],
    worstCache: [],
    diagnostics,
    sql: result?.sql
      ? {
          queries: Array.isArray(result.sql.queries)
            ? result.sql.queries.map(String)
            : [],
          params: result.sql.params ?? undefined,
        }
      : undefined,
  };
}
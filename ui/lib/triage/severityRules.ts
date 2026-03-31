// ui/lib/triage/severityRules.ts

export type SeverityLevel =
  | "healthy"
  | "early_warning"
  | "performance_issue"
  | "major_incident";

export type SeveritySignal = "latency" | "errors" | "cache";

export type NumericLike = number | null | undefined;

export type SeverityThresholds = {
  latency: {
    earlyWarningMs: number;
    performanceIssueMs: number;
    majorIncidentMs: number;
  };
  errors: {
    earlyWarningPct: number;
    performanceIssuePct: number;
    majorIncidentPct: number;
  };
  cacheHitRate: {
    earlyWarningBelowPct: number;
    performanceIssueBelowPct: number;
    majorIncidentBelowPct: number;
  };
};

export const SEVERITY_THRESHOLDS: SeverityThresholds = {
  latency: {
    earlyWarningMs: 800,
    performanceIssueMs: 1000,
    majorIncidentMs: 2000,
  },
  errors: {
    earlyWarningPct: 1,
    performanceIssuePct: 5,
    majorIncidentPct: 10,
  },
  cacheHitRate: {
    earlyWarningBelowPct: 90,
    performanceIssueBelowPct: 85,
    majorIncidentBelowPct: 75,
  },
};

export type EvidenceMetricsLike = {
  p95TtmsMs?: NumericLike;
  p95_ttms_ms?: NumericLike;
  p95_ms?: NumericLike;

  errorRatePct?: NumericLike;
  error_rate_pct?: NumericLike;

  cacheHitRate?: NumericLike;
  cache_hit_rate?: NumericLike;
};

export type EvidenceBundleLike = {
  currentMetrics?: EvidenceMetricsLike | null;
  previousMetrics?: EvidenceMetricsLike | null;
};

export type SeverityReason = {
  signal: SeveritySignal;
  severity: SeverityLevel;
  reason: string;
  currentValue: number | null;
  previousValue: number | null;
  unit: "ms" | "pct";
};

export type SeverityAssessment = {
  overall: SeverityLevel;
  reasons: SeverityReason[];
  topDriver: SeverityReason | null;
  signals: {
    latency: SeverityLevel;
    errors: SeverityLevel;
    cache: SeverityLevel;
  };
};

const SEVERITY_RANK: Record<SeverityLevel, number> = {
  healthy: 0,
  early_warning: 1,
  performance_issue: 2,
  major_incident: 3,
};

function toNumber(value: NumericLike): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function pickMetric(
  obj: EvidenceMetricsLike | null | undefined,
  ...keys: (keyof EvidenceMetricsLike)[]
): number | null {
  if (!obj) return null;
  for (const key of keys) {
    const value = toNumber(obj[key]);
    if (value !== null) return value;
  }
  return null;
}

function normalizeCacheHitRatePct(value: number | null): number | null {
  if (value === null) return null;
  return value <= 1 ? value * 100 : value;
}

function maxSeverity(a: SeverityLevel, b: SeverityLevel): SeverityLevel {
  return SEVERITY_RANK[a] >= SEVERITY_RANK[b] ? a : b;
}

export function severityToUiState(
  severity: SeverityLevel
): "normal" | "elevated" | "degraded" {
  if (severity === "healthy") return "normal";
  if (severity === "early_warning") return "elevated";
  return "degraded";
}

function getLatencySeverity(latencyMs: number | null): SeverityLevel {
  if (latencyMs === null) return "healthy";
  if (latencyMs >= SEVERITY_THRESHOLDS.latency.majorIncidentMs) {
    return "major_incident";
  }
  if (latencyMs >= SEVERITY_THRESHOLDS.latency.performanceIssueMs) {
    return "performance_issue";
  }
  if (latencyMs >= SEVERITY_THRESHOLDS.latency.earlyWarningMs) {
    return "early_warning";
  }
  return "healthy";
}

function getErrorSeverity(errorRatePct: number | null): SeverityLevel {
  if (errorRatePct === null) return "healthy";
  if (errorRatePct >= SEVERITY_THRESHOLDS.errors.majorIncidentPct) {
    return "major_incident";
  }
  if (errorRatePct >= SEVERITY_THRESHOLDS.errors.performanceIssuePct) {
    return "performance_issue";
  }
  if (errorRatePct >= SEVERITY_THRESHOLDS.errors.earlyWarningPct) {
    return "early_warning";
  }
  return "healthy";
}

function getCacheSeverity(cacheHitRatePct: number | null): SeverityLevel {
  if (cacheHitRatePct === null) return "healthy";
  if (cacheHitRatePct < SEVERITY_THRESHOLDS.cacheHitRate.majorIncidentBelowPct) {
    return "major_incident";
  }
  if (
    cacheHitRatePct <
    SEVERITY_THRESHOLDS.cacheHitRate.performanceIssueBelowPct
  ) {
    return "performance_issue";
  }
  if (cacheHitRatePct < SEVERITY_THRESHOLDS.cacheHitRate.earlyWarningBelowPct) {
    return "early_warning";
  }
  return "healthy";
}

function formatNumber(value: number | null, digits = 1): string {
  if (value === null) return "n/a";
  return value.toFixed(digits);
}

function buildLatencyReason(
  severity: SeverityLevel,
  currentValue: number | null,
  previousValue: number | null
): SeverityReason | null {
  if (severity === "healthy") return null;

  const thresholdText =
    severity === "major_incident"
      ? `p95 latency is ${formatNumber(currentValue, 0)}ms (>= ${SEVERITY_THRESHOLDS.latency.majorIncidentMs}ms)`
      : severity === "performance_issue"
        ? `p95 latency is ${formatNumber(currentValue, 0)}ms (>= ${SEVERITY_THRESHOLDS.latency.performanceIssueMs}ms)`
        : `p95 latency is ${formatNumber(currentValue, 0)}ms (>= ${SEVERITY_THRESHOLDS.latency.earlyWarningMs}ms)`;

  const previousText =
    previousValue !== null
      ? ` vs previous ${formatNumber(previousValue, 0)}ms`
      : "";

  return {
    signal: "latency",
    severity,
    reason: `${thresholdText}${previousText}`,
    currentValue,
    previousValue,
    unit: "ms",
  };
}

function buildErrorReason(
  severity: SeverityLevel,
  currentValue: number | null,
  previousValue: number | null
): SeverityReason | null {
  if (severity === "healthy") return null;

  const thresholdText =
    severity === "major_incident"
      ? `5xx error rate is ${formatNumber(currentValue, 2)}% (>= ${SEVERITY_THRESHOLDS.errors.majorIncidentPct}%)`
      : severity === "performance_issue"
        ? `5xx error rate is ${formatNumber(currentValue, 2)}% (>= ${SEVERITY_THRESHOLDS.errors.performanceIssuePct}%)`
        : `5xx error rate is ${formatNumber(currentValue, 2)}% (>= ${SEVERITY_THRESHOLDS.errors.earlyWarningPct}%)`;

  const previousText =
    previousValue !== null
      ? ` vs previous ${formatNumber(previousValue, 2)}%`
      : "";

  return {
    signal: "errors",
    severity,
    reason: `${thresholdText}${previousText}`,
    currentValue,
    previousValue,
    unit: "pct",
  };
}

function buildCacheReason(
  severity: SeverityLevel,
  currentValue: number | null,
  previousValue: number | null
): SeverityReason | null {
  if (severity === "healthy") return null;

  const thresholdText =
    severity === "major_incident"
      ? `cache hit rate is ${formatNumber(currentValue, 2)}% (< ${SEVERITY_THRESHOLDS.cacheHitRate.majorIncidentBelowPct}%)`
      : severity === "performance_issue"
        ? `cache hit rate is ${formatNumber(currentValue, 2)}% (< ${SEVERITY_THRESHOLDS.cacheHitRate.performanceIssueBelowPct}%)`
        : `cache hit rate is ${formatNumber(currentValue, 2)}% (< ${SEVERITY_THRESHOLDS.cacheHitRate.earlyWarningBelowPct}%)`;

  const previousText =
    previousValue !== null
      ? ` vs previous ${formatNumber(previousValue, 2)}%`
      : "";

  return {
    signal: "cache",
    severity,
    reason: `${thresholdText}${previousText}`,
    currentValue,
    previousValue,
    unit: "pct",
  };
}

function sortReasonsDesc(reasons: SeverityReason[]): SeverityReason[] {
  return [...reasons].sort((a, b) => {
    const severityDelta = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
    if (severityDelta !== 0) return severityDelta;

    const aValue = a.currentValue ?? Number.NEGATIVE_INFINITY;
    const bValue = b.currentValue ?? Number.NEGATIVE_INFINITY;
    return bValue - aValue;
  });
}

export function assessSeverity(
  bundle: EvidenceBundleLike
): SeverityAssessment {
  const current = bundle.currentMetrics ?? null;
  const previous = bundle.previousMetrics ?? null;

  const currentLatency = pickMetric(current, "p95TtmsMs", "p95_ttms_ms", "p95_ms");
  const previousLatency = pickMetric(previous, "p95TtmsMs", "p95_ttms_ms", "p95_ms");

  const currentErrors = pickMetric(current, "errorRatePct", "error_rate_pct");
  const previousErrors = pickMetric(previous, "errorRatePct", "error_rate_pct");

  const currentCacheRaw = pickMetric(current, "cacheHitRate", "cache_hit_rate");
  const previousCacheRaw = pickMetric(previous, "cacheHitRate", "cache_hit_rate");

  const currentCache = normalizeCacheHitRatePct(currentCacheRaw);
  const previousCache = normalizeCacheHitRatePct(previousCacheRaw);

  const latencySeverity = getLatencySeverity(currentLatency);
  const errorSeverity = getErrorSeverity(currentErrors);
  const cacheSeverity = getCacheSeverity(currentCache);

  let overall: SeverityLevel = "healthy";
  overall = maxSeverity(overall, latencySeverity);
  overall = maxSeverity(overall, errorSeverity);
  overall = maxSeverity(overall, cacheSeverity);

  const reasons: SeverityReason[] = [
    buildLatencyReason(latencySeverity, currentLatency, previousLatency),
    buildErrorReason(errorSeverity, currentErrors, previousErrors),
    buildCacheReason(cacheSeverity, currentCache, previousCache),
  ].filter((reason): reason is SeverityReason => reason !== null);

  const sortedReasons = sortReasonsDesc(reasons);

  return {
    overall,
    reasons: sortedReasons,
    topDriver: sortedReasons[0] ?? null,
    signals: {
      latency: latencySeverity,
      errors: errorSeverity,
      cache: cacheSeverity,
    },
  };
}
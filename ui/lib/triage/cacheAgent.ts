import type { AgentResult, EvidenceBundle } from "@/lib/triage/types";
import { assessSeverity } from "@/lib/triage/severityRules";

function mapSeverityToState(
  severity: AgentResult["severityInternal"]
): AgentResult["state"] {
  switch (severity) {
    case "healthy":
      return "normal";
    case "early_warning":
      return "elevated";
    case "performance_issue":
    case "major_incident":
      return "degraded";
    default:
      return "elevated";
  }
}

function toDisplayPercent(value: number): number {
  return value <= 1 ? value * 100 : value;
}

export function cacheAgent(bundle: EvidenceBundle): AgentResult {
  const rawCacheHit =
    bundle.currentMetrics?.cacheHitRate ?? bundle.derivedMetrics?.cacheHitRate;
  const rawPrevCacheHit = bundle.previousMetrics?.cacheHitRate;
  const cacheDeltaPct = bundle.derivedMetrics?.cacheDeltaPct;

  const cacheHit =
    rawCacheHit != null ? toDisplayPercent(rawCacheHit) : null;
  const prevCacheHit =
    rawPrevCacheHit != null ? toDisplayPercent(rawPrevCacheHit) : null;

  const findings: string[] = [];

  if (cacheHit != null) {
    findings.push(`cacheHitRate=${cacheHit.toFixed(2)}`);
  } else {
    findings.push("cacheHitRate=missing");
  }

  if (prevCacheHit != null) {
    findings.push(`previousCacheHitRate=${prevCacheHit.toFixed(2)}`);
  }

  if (cacheDeltaPct != null) {
    findings.push(`cacheDeltaPct=${cacheDeltaPct.toFixed(1)}`);
  }

  const severityAssessment = assessSeverity(bundle);
  const cacheReasons = severityAssessment.reasons.filter(
    (reason) => reason.signal === "cache"
  );
  const cacheTopReason =
    cacheReasons[0] ??
    (severityAssessment.topDriver?.signal === "cache"
      ? severityAssessment.topDriver
      : null);

  const severityInternal =
    cacheTopReason?.severity ??
    (rawCacheHit == null ? "early_warning" : "healthy");

  const state = mapSeverityToState(severityInternal);

  let summary: string;

  if (cacheHit == null) {
    summary = "Cache signal is unavailable for this window.";
  } else {
    let base: string;

    switch (state) {
      case "degraded":
        base = `Cache performance is degraded at ${cacheHit.toFixed(2)}% hit rate`;
        break;
      case "elevated":
        base = `Cache performance is slightly elevated for review at ${cacheHit.toFixed(
          2
        )}% hit rate`;
        break;
      default:
        base = `Cache performance looks normal at ${cacheHit.toFixed(2)}% hit rate`;
        break;
    }

    const previousText =
      prevCacheHit != null ? ` (previous ${prevCacheHit.toFixed(2)}%)` : "";

    const deltaText =
      cacheDeltaPct != null
        ? `, ${cacheDeltaPct >= 0 ? "up" : "down"} ${Math.abs(
            cacheDeltaPct
          ).toFixed(1)}% vs previous window`
        : "";

    const reasonText = cacheTopReason?.reason
      ? ` ${cacheTopReason.reason}.`
      : ".";

    summary = `${base}${previousText}${deltaText}.`;
  }

  const recommendedNextSteps: string[] = [];

  if (state === "degraded") {
    recommendedNextSteps.push("Drill into worst cache region.");
    recommendedNextSteps.push("Drill into worst cache pop.");
  } else if (state === "elevated") {
    recommendedNextSteps.push("Compare cache trend against the previous window.");
  }

  return {
    agent: "cache",
    state,
    severityInternal,
    summary,
    findings,
    graphs: [],
    recommendedNextSteps,
  };
}
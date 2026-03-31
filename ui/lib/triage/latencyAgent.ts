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

export function latencyAgent(bundle: EvidenceBundle): AgentResult {
  const p95 = bundle.currentMetrics?.p95TtmsMs;
  const p99 = bundle.currentMetrics?.p99TtmsMs;

  const p95DeltaPct = bundle.derivedMetrics?.latencyDeltaPct;
  const p99DeltaPct = bundle.derivedMetrics?.p99DeltaPct;

  const findings: string[] = [];

  if (p95 != null) findings.push(`p95TtmsMs=${Math.round(p95)}`);
  else findings.push("p95TtmsMs=missing");

  if (p99 != null) findings.push(`p99TtmsMs=${Math.round(p99)}`);
  else findings.push("p99TtmsMs=missing");

  if (p95DeltaPct != null) {
    findings.push(`p95DeltaPct=${p95DeltaPct.toFixed(1)}`);
  }

  if (p99DeltaPct != null) {
    findings.push(`p99DeltaPct=${p99DeltaPct.toFixed(1)}`);
  }

  const severityAssessment = assessSeverity(bundle);
  const latencyReasons = severityAssessment.reasons.filter(
    (reason) => reason.signal === "latency"
  );
  const latencyTopReason =
    latencyReasons[0] ??
    (severityAssessment.topDriver?.signal === "latency"
      ? severityAssessment.topDriver
      : null);

  const severityInternal =
    latencyTopReason?.severity ??
    (p95 == null && p99 == null ? "early_warning" : "healthy");

  const state = mapSeverityToState(severityInternal);

  let summary: string;

  if (p95 == null && p99 == null) {
    summary = "Latency signal is unavailable for this window.";
  } else {
    let base: string;

    switch (state) {
      case "degraded":
        base = "Latency is degraded";
        break;
      case "elevated":
        base = "Latency is elevated for review";
        break;
      default:
        base = "Latency looks normal";
        break;
    }

    const metrics = [
      p95 != null ? `p95=${Math.round(p95)}ms` : null,
      p99 != null ? `p99=${Math.round(p99)}ms` : null,
    ]
      .filter(Boolean)
      .join(", ");

    const deltas = [
      p95DeltaPct != null
        ? `p95 ${p95DeltaPct >= 0 ? "up" : "down"} ${Math.abs(
            p95DeltaPct
          ).toFixed(1)}%`
        : null,
      p99DeltaPct != null
        ? `p99 ${p99DeltaPct >= 0 ? "up" : "down"} ${Math.abs(
            p99DeltaPct
          ).toFixed(1)}%`
        : null,
    ]
      .filter(Boolean)
      .join(", ");

    const reasonText = latencyTopReason?.reason
      ? ` ${latencyTopReason.reason}`
      : "";

    const core = deltas
      ? `${base} (${metrics}; ${deltas} vs previous window)`
      : `${base} (${metrics})`;

    summary = `${core}${reasonText}.`;
  }

  const recommendedNextSteps: string[] = [];

  if (state === "degraded") {
    recommendedNextSteps.push("Drill into worst latency region.");
    recommendedNextSteps.push("Drill into worst latency pop.");
  } else if (state === "elevated") {
    recommendedNextSteps.push("Compare latency trend against the previous window.");
  }

  return {
    agent: "latency",
    state,
    severityInternal,
    summary,
    findings,
    graphs: [],
    recommendedNextSteps,
  };
}
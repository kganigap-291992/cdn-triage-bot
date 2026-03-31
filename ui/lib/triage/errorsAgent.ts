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

export function errorsAgent(bundle: EvidenceBundle): AgentResult {
  const errPct = bundle.currentMetrics?.errorRatePct;
  const err5xx = bundle.currentMetrics?.error5xxCount;
  const totalRequests = bundle.currentMetrics?.totalRequests ?? 0;

  const prevErrPct = bundle.previousMetrics?.errorRatePct;
  const errDeltaPct = bundle.derivedMetrics?.errorDeltaPct;

  const findings: string[] = [];

  if (err5xx != null) findings.push(`error5xxCount=${Math.round(err5xx)}`);
  else findings.push("error5xxCount=missing");

  if (errPct != null) findings.push(`errorRatePct=${errPct.toFixed(2)}`);
  else findings.push("errorRatePct=missing");

  if (prevErrPct != null) {
    findings.push(`previousErrorRatePct=${prevErrPct.toFixed(2)}`);
  }

  if (errDeltaPct != null) {
    findings.push(`errorDeltaPct=${errDeltaPct.toFixed(1)}`);
  }

  findings.push(`totalRequests=${Math.round(totalRequests)}`);

  const lowVolume = totalRequests > 0 && totalRequests < 1000;
  if (lowVolume) {
    findings.push("lowVolumeWindow=true");
  }

  const severityAssessment = assessSeverity(bundle);
  const errorReasons = severityAssessment.reasons.filter(
    (reason) => reason.signal === "errors"
  );
  const errorTopReason =
    errorReasons[0] ??
    (severityAssessment.topDriver?.signal === "errors"
      ? severityAssessment.topDriver
      : null);

  const severityInternal =
    errorTopReason?.severity ??
    (errPct == null && err5xx == null ? "early_warning" : "healthy");

  const state = mapSeverityToState(severityInternal);

  let summary: string;

  if (errPct == null && err5xx == null) {
    summary = "Error signal is unavailable for this window.";
  } else {
    let base: string;

    switch (state) {
      case "degraded":
        base = `Errors are degraded${
          errPct != null ? ` at ${errPct.toFixed(2)}% 5xx rate` : ""
        }`;
        break;
      case "elevated":
        base = `Errors are elevated for review${
          errPct != null ? ` at ${errPct.toFixed(2)}% 5xx rate` : ""
        }`;
        break;
      default:
        base = `Errors look normal${
          errPct != null ? ` at ${errPct.toFixed(2)}% 5xx rate` : ""
        }`;
        break;
    }

    const countText =
      err5xx != null
        ? ` with ${Math.round(err5xx).toLocaleString()} 5xx responses`
        : "";

    const previousText =
      prevErrPct != null ? ` (previous ${prevErrPct.toFixed(2)}%)` : "";

    const deltaText =
      errDeltaPct != null
        ? `, ${errDeltaPct >= 0 ? "up" : "down"} ${Math.abs(errDeltaPct).toFixed(
            1
          )}% vs previous window`
        : "";

    const volumeText = lowVolume
      ? ` across a low-volume window (${Math.round(totalRequests).toLocaleString()} requests)`
      : "";

    const reasonText = errorTopReason?.reason ? ` ${errorTopReason.reason}.` : ".";

    summary = `${base}${countText}${previousText}${deltaText}${volumeText}${reasonText}`;
  }

  const recommendedNextSteps: string[] = [];

  if (state === "degraded") {
    recommendedNextSteps.push("Drill into worst error region.");
    recommendedNextSteps.push("Drill into worst error pop.");
  } else if (state === "elevated") {
    recommendedNextSteps.push("Compare error trend against the previous window.");
  }

  if (lowVolume) {
    recommendedNextSteps.push("Validate whether the error signal is sample-size sensitive.");
  }

  return {
    agent: "errors",
    state,
    severityInternal,
    summary,
    findings,
    graphs: [],
    recommendedNextSteps,
  };
}
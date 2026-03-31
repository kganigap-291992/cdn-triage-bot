import type { AgentResult, EvidenceBundle, SeverityLevel } from "@/lib/triage/types";

function mapSeverityToState(
  severity: SeverityLevel
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

export function trafficAgent(bundle: EvidenceBundle): AgentResult {
  const total = Number(bundle.currentMetrics?.totalRequests || 0);
  const prevTotal = Number(bundle.previousMetrics?.totalRequests || 0);
  const trafficDeltaPct = bundle.derivedMetrics?.trafficDeltaPct;
  const points = bundle.timeseries?.points || [];

  const findings: string[] = [`totalRequests=${Math.round(total)}`];

  if (prevTotal > 0) {
    findings.push(`previousTotalRequests=${Math.round(prevTotal)}`);
  } else {
    findings.push("previousTotalRequests=missing_or_zero");
  }

  if (trafficDeltaPct != null) {
    findings.push(`trafficDeltaPct=${trafficDeltaPct.toFixed(1)}`);
  }

  if (points.length <= 2) {
    findings.push("timeseries=sparse");
  }

  const lowVolume = total > 0 && total < 1000;
  if (lowVolume) {
    findings.push("lowVolumeWindow=true");
  }

  let severityInternal: SeverityLevel = "healthy";

  // --------------------------------------------------
  // Traffic-specific severity logic
  // --------------------------------------------------
  if (total === 0) {
    severityInternal = "major_incident";
  } else if (trafficDeltaPct != null && trafficDeltaPct <= -80) {
    severityInternal = "major_incident";
  } else if (points.length <= 2) {
    severityInternal = "early_warning";
  } else if (trafficDeltaPct != null && trafficDeltaPct <= -40) {
    severityInternal = "early_warning";
  }

  // In very low-volume windows, avoid over-escalating mild drops.
  if (
    lowVolume &&
    severityInternal === "early_warning" &&
    trafficDeltaPct != null &&
    trafficDeltaPct > -80
  ) {
    severityInternal = "healthy";
  }

  const state = mapSeverityToState(severityInternal);

  let summary: string;

  if (total === 0) {
    summary = "Traffic is degraded because no requests were observed in the current window.";
  } else if (points.length <= 2) {
    summary = `Traffic is present with ${total.toLocaleString()} requests, but confidence is limited because only ${points.length} time-series points are available.`;
  } else {
    let base: string;

    switch (state) {
      case "degraded":
        base = `Traffic is degraded with ${total.toLocaleString()} requests in the current window`;
        break;
      case "elevated":
        base = `Traffic looks elevated for review with ${total.toLocaleString()} requests in the current window`;
        break;
      default:
        base = `Traffic looks normal with ${total.toLocaleString()} requests in the current window`;
        break;
    }

    const previousText =
      prevTotal > 0 ? ` (previous ${prevTotal.toLocaleString()})` : "";

    const deltaText =
      trafficDeltaPct != null
        ? `, ${trafficDeltaPct >= 0 ? "up" : "down"} ${Math.abs(
            trafficDeltaPct
          ).toFixed(1)}% vs previous window`
        : "";

    const lowVolumeText = lowVolume ? ` across a low-volume window` : "";

    summary = `${base}${previousText}${deltaText}${lowVolumeText}.`;
  }

  const recommendedNextSteps: string[] = [];

  if (state === "degraded") {
    recommendedNextSteps.push("Drill into traffic by region.");
    recommendedNextSteps.push("Drill into traffic by pop.");
  } else if (state === "elevated") {
    recommendedNextSteps.push("Compare traffic trend against the previous window.");
  }

  if (points.length <= 2) {
    recommendedNextSteps.push("Validate whether sparse time-series data is limiting confidence.");
  }

  if (lowVolume) {
    recommendedNextSteps.push("Validate whether the traffic signal is sample-size sensitive.");
  }

  return {
    agent: "traffic",
    state,
    severityInternal,
    summary,
    findings,
    graphs: [],
    recommendedNextSteps,
  };
}
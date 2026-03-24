import type { AgentResult, EvidenceBundle } from "@/lib/triage/types";

export function trafficAgent(bundle: EvidenceBundle): AgentResult {
  const total = Number(bundle.currentMetrics?.totalRequests || 0);
  const prevTotal = Number(bundle.previousMetrics?.totalRequests || 0);
  const trafficDeltaPct = bundle.derivedMetrics?.trafficDeltaPct;
  const points = bundle.timeseries?.points || [];

  let status: AgentResult["status"] = "ok";
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

  // --------------------------------------------------
  // Severity logic
  // Rules:
  // - zero traffic is critical
  // - sparse data is warn, unless zero traffic already made it critical
  // - strong traffic collapse matters more than growth
  // - large growth alone is informational, not automatically bad
  // --------------------------------------------------
  if (total === 0) {
    status = "critical";
  } else if (points.length <= 2) {
    status = "warn";
  }

  if (trafficDeltaPct != null) {
    if (trafficDeltaPct <= -80) {
      status = "critical";
    } else if (trafficDeltaPct <= -40 && status !== "critical") {
      status = "warn";
    }
  }

  // In very low-volume windows, avoid over-escalating mild drops
  if (lowVolume && status === "warn" && trafficDeltaPct != null && trafficDeltaPct > -80) {
    status = "ok";
  }

  // --------------------------------------------------
  // Summary
  // --------------------------------------------------
  let summary: string;

  if (total === 0) {
    summary = "No traffic observed in the current window.";
  } else if (points.length <= 2) {
    summary = `Traffic observed (${total.toLocaleString()} requests), but signal is limited because only ${points.length} points are available.`;
  } else {
    const base = `Traffic volume is present with ${total.toLocaleString()} requests in the current window`;

    const deltaText =
      trafficDeltaPct != null
        ? `, ${trafficDeltaPct >= 0 ? "up" : "down"} ${Math.abs(trafficDeltaPct).toFixed(
            1
          )}% vs previous window`
        : "";

    const lowVolumeText = lowVolume ? ` across a low-volume window` : "";

    summary = `${base}${deltaText}${lowVolumeText}.`;
  }

  return {
    agent: "traffic",
    status,
    summary,
    findings,
    graphs: [],
  };
}
import type { AgentResult, EvidenceBundle } from "@/lib/triage/types";

export function latencyAgent(bundle: EvidenceBundle): AgentResult {
  const p95 = bundle.currentMetrics?.p95TtmsMs;
  const p99 = bundle.currentMetrics?.p99TtmsMs;

  const p95DeltaPct = bundle.derivedMetrics?.latencyDeltaPct;
  const p99DeltaPct = bundle.derivedMetrics?.p99DeltaPct;

  let status: AgentResult["status"] = "ok";
  const findings: string[] = [];

  // --------------------------------------------------
  // Findings
  // --------------------------------------------------
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

  // --------------------------------------------------
  // Severity logic
  // Rules:
  // - absolute thresholds matter first
  // - p99 catches tail pain / hotspots
  // - deltas add trend-awareness
  // --------------------------------------------------
  if (p95 == null && p99 == null) {
    status = "warn";
  } else {
    // Absolute thresholds
    if ((p95 != null && p95 >= 2000) || (p99 != null && p99 >= 2500)) {
      status = "critical";
    } else if ((p95 != null && p95 >= 800) || (p99 != null && p99 >= 1500)) {
      status = "warn";
    }

    // Trend escalation
    // Large p95 jump can escalate
    if (p95DeltaPct != null) {
      if (p95DeltaPct >= 200) {
        status = "critical";
      } else if (p95DeltaPct >= 100 && status === "ok") {
        status = "warn";
      }
    }

    // Very large p99 jump can also escalate tail issues
    if (p99DeltaPct != null) {
      if (p99DeltaPct >= 250) {
        status = "critical";
      } else if (p99DeltaPct >= 125 && status === "ok") {
        status = "warn";
      }
    }
  }

  // --------------------------------------------------
  // Summary
  // --------------------------------------------------
  let summary: string;

  if (p95 == null && p99 == null) {
    summary = "Latency signal unavailable.";
  } else {
    const level =
      status === "critical"
        ? "Latency is critically elevated"
        : status === "warn"
        ? "Latency is elevated"
        : "Latency is within expected range";

    const metrics = [
      p95 != null ? `p95=${Math.round(p95)}ms` : null,
      p99 != null ? `p99=${Math.round(p99)}ms` : null,
    ]
      .filter(Boolean)
      .join(", ");

    const deltas = [
      p95DeltaPct != null
        ? `p95 ${p95DeltaPct >= 0 ? "up" : "down"} ${Math.abs(p95DeltaPct).toFixed(1)}%`
        : null,
      p99DeltaPct != null
        ? `p99 ${p99DeltaPct >= 0 ? "up" : "down"} ${Math.abs(p99DeltaPct).toFixed(1)}%`
        : null,
    ]
      .filter(Boolean)
      .join(", ");

    summary = deltas
      ? `${level} (${metrics}; ${deltas} vs previous window).`
      : `${level} (${metrics}).`;
  }

  return {
    agent: "latency",
    status,
    summary,
    findings,
    graphs: [],
  };
}
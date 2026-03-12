import type { AgentResult, EvidenceBundle } from "@/lib/triage/types";

export function trafficAgent(bundle: EvidenceBundle): AgentResult {
  const total = Number(bundle.currentMetrics?.totalRequests || 0);
  const points = bundle.timeseries?.points || [];

  let status: AgentResult["status"] = "ok";
  let summary = `Traffic volume looks stable with ${total.toLocaleString()} requests in the current window.`;
  const findings: string[] = [`totalRequests=${total}`];

  if (total === 0) {
    status = "critical";
    summary = "No traffic observed in the current window.";
    findings.push("traffic=zero");
  } else if (points.length <= 2) {
    status = "warn";
    summary = `Traffic observed (${total.toLocaleString()} requests), but signal is limited because only ${points.length} points are available.`;
    findings.push("timeseries=sparse");
  }

  return {
    agent: "traffic",
    status,
    summary,
    findings,
    graphs: [],
  };
}
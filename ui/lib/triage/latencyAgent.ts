import type { AgentResult, EvidenceBundle } from "@/lib/triage/types";

export function latencyAgent(bundle: EvidenceBundle): AgentResult {
  const p95 = bundle.currentMetrics?.p95TtmsMs ?? undefined;

  let status: AgentResult["status"] = "ok";
  let summary = p95 != null
    ? `Latency is within expected range with p95=${Math.round(p95)}ms.`
    : "Latency signal unavailable.";
  const findings: string[] = [];

  if (p95 != null) {
    findings.push(`p95TtmsMs=${Math.round(p95)}`);
    if (p95 >= 1500) {
      status = "critical";
      summary = `Latency is critically elevated with p95=${Math.round(p95)}ms.`;
    } else if (p95 >= 500) {
      status = "warn";
      summary = `Latency is elevated with p95=${Math.round(p95)}ms.`;
    }
  } else {
    status = "warn";
    findings.push("p95TtmsMs=missing");
  }

  return {
    agent: "latency",
    status,
    summary,
    findings,
    graphs: [],
  };
}
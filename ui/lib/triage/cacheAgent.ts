import type { AgentResult, EvidenceBundle } from "@/lib/triage/types";

export function cacheAgent(bundle: EvidenceBundle): AgentResult {
  const cacheHit = bundle.currentMetrics?.cacheHitRate ?? bundle.derivedMetrics?.cacheHitRate;

  let status: AgentResult["status"] = "ok";
  let summary =
    cacheHit != null
      ? `Cache efficiency looks healthy at ${cacheHit.toFixed(2)}%.`
      : "Cache signal unavailable.";
  const findings: string[] = [];

  if (cacheHit != null) {
    findings.push(`cacheHitRate=${cacheHit.toFixed(2)}`);
    if (cacheHit < 60) {
      status = "critical";
      summary = `Cache efficiency is critically low at ${cacheHit.toFixed(2)}%.`;
    } else if (cacheHit < 80) {
      status = "warn";
      summary = `Cache efficiency is below target at ${cacheHit.toFixed(2)}%.`;
    }
  } else {
    status = "warn";
    findings.push("cacheHitRate=missing");
  }

  return {
    agent: "cache",
    status,
    summary,
    findings,
    graphs: [],
  };
}
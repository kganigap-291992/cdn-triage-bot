import type { AgentResult, EvidenceBundle } from "@/lib/triage/types";

export function errorsAgent(bundle: EvidenceBundle): AgentResult {
  const errPct = bundle.currentMetrics?.errorRatePct ?? undefined;
  const err5xx = bundle.currentMetrics?.error5xxCount ?? undefined;

  let status: AgentResult["status"] = "ok";
  let summary =
    errPct != null
      ? `Errors are under control at ${errPct.toFixed(2)}% 5xx rate.`
      : "Error-rate signal unavailable.";

  const findings: string[] = [];
  if (err5xx != null) findings.push(`error5xxCount=${Math.round(err5xx)}`);
  if (errPct != null) findings.push(`errorRatePct=${errPct.toFixed(2)}`);

  if (errPct != null) {
    if (errPct >= 1.0) {
      status = "critical";
      summary = `Errors are critically elevated at ${errPct.toFixed(2)}% 5xx rate.`;
    } else if (errPct >= 0.2) {
      status = "warn";
      summary = `Errors are elevated at ${errPct.toFixed(2)}% 5xx rate.`;
    }
  } else {
    status = "warn";
    findings.push("errorRatePct=missing");
  }

  return {
    agent: "errors",
    status,
    summary,
    findings,
    graphs: [],
  };
}
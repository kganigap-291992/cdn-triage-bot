import type { AgentResult, EvidenceBundle } from "@/lib/triage/types";

export function scopeAgent(bundle: EvidenceBundle): AgentResult {
  const scope = bundle.normalizedScope;

  return {
    agent: "scope",
    status: "ok",
    summary: `Scope locked to partner=${scope.partner}, service=${scope.service}, region=${scope.region}, pop=${scope.pop}.`,
    findings: [
      `partner=${scope.partner}`,
      `service=${scope.service}`,
      `region=${scope.region}`,
      `pop=${scope.pop}`,
      `contentType=${scope.contentType}`,
      `uaFamily=${scope.uaFamily}`,
    ],
    graphs: [],
  };
}
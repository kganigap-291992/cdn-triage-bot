import type { AgentResult, EvidenceBundle } from "@/lib/triage/types";

export function scopeAgent(bundle: EvidenceBundle): AgentResult {
  const scope = bundle.normalizedScope;

  const hasPartner = Boolean(scope.partner?.trim());
  const hasService = Boolean(scope.service?.trim());
  const isValid = hasPartner && hasService;

  if (!isValid) {
    return {
      agent: "scope",
      status: "critical",
      summary: `Scope is invalid: partner=${scope.partner || "<missing>"}, service=${scope.service || "<missing>"}, region=${scope.region}, pop=${scope.pop}.`,
      findings: [
        `partner=${scope.partner || "<missing>"}`,
        `service=${scope.service || "<missing>"}`,
        `region=${scope.region}`,
        `pop=${scope.pop}`,
        `contentType=${scope.contentType}`,
        `uaFamily=${scope.uaFamily}`,
        "scopeValidation=failed",
      ],
      graphs: [],
    };
  }

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
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

export function scopeAgent(bundle: EvidenceBundle): AgentResult {
  const scope = bundle.normalizedScope;

  const partner = scope.partner || "<missing>";
  const service = scope.service || "<missing>";
  const region = scope.region || "all";
  const pop = scope.pop || "all";
  const contentType = scope.contentType || "all";
  const uaFamily = scope.uaFamily || "all";

  const hasPartner = Boolean(scope.partner?.trim());
  const hasService = Boolean(scope.service?.trim());
  const isValid = hasPartner && hasService;

  const findings: string[] = [
    `partner=${partner}`,
    `service=${service}`,
    `region=${region}`,
    `pop=${pop}`,
    `contentType=${contentType}`,
    `uaFamily=${uaFamily}`,
  ];

  let severityInternal: SeverityLevel = "healthy";

  if (!isValid) {
    severityInternal = "performance_issue";
    findings.push("scopeValidation=failed");
  }

  const state = mapSeverityToState(severityInternal);

  let summary: string;
  const recommendedNextSteps: string[] = [];

  if (!isValid) {
    summary = `Assessment scope is incomplete: partner=${partner}, service=${service}, region=${region}, pop=${pop}.`;
    recommendedNextSteps.push("Provide both partner and service to run a scoped triage.");
  } else {
    summary = `Scope is locked to partner=${partner}, service=${service}, region=${region}, pop=${pop}.`;
  }

  return {
    agent: "scope",
    state,
    severityInternal,
    summary,
    findings,
    graphs: [],
    recommendedNextSteps,
  };
}
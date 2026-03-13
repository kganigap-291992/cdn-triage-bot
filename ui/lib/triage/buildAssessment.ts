import type {
  AgentResult,
  EvidenceBundle,
  IncidentAssessment,
} from "@/lib/triage/types";

function getPrimarySignal(agents: AgentResult[]): IncidentAssessment["primarySignal"] {
  const critical = agents.filter((a) => a.status === "critical");
  const warn = agents.filter((a) => a.status === "warn");

  const pool = critical.length ? critical : warn.length ? warn : [];

  if (!pool.length) return "mixed";

  const first = pool.find((a) => a.agent !== "scope");
  if (!first) return "mixed";

  if (
    first.agent === "traffic" ||
    first.agent === "latency" ||
    first.agent === "errors" ||
    first.agent === "cache"
  ) {
    return first.agent;
  }

  return "mixed";
}

function getOverallStatus(agents: AgentResult[]): IncidentAssessment["overallStatus"] {
  if (agents.some((a) => a.status === "critical")) return "critical";
  if (agents.some((a) => a.status === "warn")) return "warn";
  return "ok";
}

function getScopeAgent(agents: AgentResult[]): AgentResult | undefined {
  return agents.find((a) => a.agent === "scope");
}

function getNonScopeAgents(agents: AgentResult[]): AgentResult[] {
  return agents.filter((a) => a.agent !== "scope");
}

function getKeyFindings(agents: AgentResult[]): string[] {
  const scope = getScopeAgent(agents);
  const nonScope = getNonScopeAgents(agents)
    .map((a) => a.summary)
    .filter(Boolean);

  if (scope?.status === "critical" && scope.summary) {
    return [scope.summary, ...nonScope].slice(0, 5);
  }

  return nonScope.slice(0, 5);
}

function pickHeadlineSummary(
  bundle: EvidenceBundle,
  agents: AgentResult[],
  overallStatus: IncidentAssessment["overallStatus"],
  keyFindings: string[]
): string {
  const scope = getScopeAgent(agents);
  if (scope?.status === "critical" && scope.summary) {
    return scope.summary;
  }

  const nonScope = getNonScopeAgents(agents);

  const critical = nonScope.find((a) => a.status === "critical" && a.summary);
  if (critical?.summary) {
    return critical.summary;
  }

  const warn = nonScope.find((a) => a.status === "warn" && a.summary);
  if (warn?.summary) {
    return warn.summary;
  }

  if (keyFindings[0]) {
    return keyFindings[0];
  }

  return `Service ${bundle.normalizedScope.service} for ${bundle.normalizedScope.partner} appears ${overallStatus}.`;
}

export function buildAssessment(
  bundle: EvidenceBundle,
  agents: AgentResult[]
): IncidentAssessment {
  const overallStatus = getOverallStatus(agents);
  const primarySignal = getPrimarySignal(agents);
  const keyFindings = getKeyFindings(agents);
  const summary = pickHeadlineSummary(bundle, agents, overallStatus, keyFindings);

  return {
    overallStatus,
    primarySignal,
    blastRadius: {
      regionCount: bundle.normalizedScope.region === "all" ? 0 : 1,
      popCount: bundle.normalizedScope.pop === "all" ? 0 : 1,
      topRegions:
        bundle.normalizedScope.region === "all" ? [] : [bundle.normalizedScope.region],
      topPops:
        bundle.normalizedScope.pop === "all" ? [] : [bundle.normalizedScope.pop],
    },
    keyFindings,
    agents,
    summary,
    metadata: {
      table: bundle.diagnostics?.tableUsed,
      bucketSeconds: bundle.diagnostics?.bucketSeconds,
      timeMode: bundle.windowInfo.timeMode,
    },
  };
}
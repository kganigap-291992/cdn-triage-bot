import type {
  AgentResult,
  EvidenceBundle,
  IncidentAssessment,
} from "@/lib/triage/types";
import { assessSeverity, severityToUiState } from "@/lib/triage/severityRules";

type AssessmentStatus = "ok" | "warn" | "critical";
type NonScopeSignal = Exclude<IncidentAssessment["primarySignal"], "mixed">;

function getScopeAgent(agents: AgentResult[]): AgentResult | undefined {
  return agents.find((a) => a.agent === "scope");
}

function getNonScopeAgents(agents: AgentResult[]): AgentResult[] {
  return agents.filter((a) => a.agent !== "scope");
}

function normalizeSeverity(
  level: AgentResult["severityInternal"]
): AssessmentStatus {
  switch (level) {
    case "major_incident":
      return "critical";
    case "performance_issue":
    case "early_warning":
      return "warn";
    case "healthy":
    default:
      return "ok";
  }
}

function getOverallStatus(agents: AgentResult[]): AssessmentStatus {
  const normalized = agents.map((a) => normalizeSeverity(a.severityInternal));

  if (normalized.some((s) => s === "critical")) return "critical";
  if (normalized.some((s) => s === "warn")) return "warn";
  return "ok";
}

function severityWeight(status: AssessmentStatus): number {
  switch (status) {
    case "critical":
      return 3;
    case "warn":
      return 2;
    case "ok":
    default:
      return 1;
  }
}

function signalPriority(agent: NonScopeSignal): number {
  switch (agent) {
    case "errors":
      return 4;
    case "latency":
      return 3;
    case "cache":
      return 2;
    case "traffic":
      return 1;
    default:
      return 0;
  }
}

function severityLevelToOverallStatus(
  level: "healthy" | "early_warning" | "performance_issue" | "major_incident"
): AssessmentStatus {
  switch (level) {
    case "major_incident":
      return "critical";
    case "performance_issue":
    case "early_warning":
      return "warn";
    case "healthy":
    default:
      return "ok";
  }
}

function severitySignalToPrimarySignal(
  signal: "latency" | "errors" | "cache" | undefined
): IncidentAssessment["primarySignal"] {
  switch (signal) {
    case "latency":
      return "latency";
    case "errors":
      return "errors";
    case "cache":
      return "cache";
    default:
      return "mixed";
  }
}

function getPrimarySignal(
  agents: AgentResult[],
  bundle: EvidenceBundle
): IncidentAssessment["primarySignal"] {
  const nonScope = getNonScopeAgents(agents).filter(
    (a) =>
      a.agent === "traffic" ||
      a.agent === "latency" ||
      a.agent === "errors" ||
      a.agent === "cache"
  ) as Array<AgentResult & { agent: NonScopeSignal }>;

  const active = nonScope.filter((a) => {
    const s = normalizeSeverity(a.severityInternal);
    return s === "critical" || s === "warn";
  });

  if (!active.length) {
    const severityAssessment = assessSeverity(bundle);
    return severitySignalToPrimarySignal(
      severityAssessment.topDriver?.signal
    );
  }

  const criticalSignals = active.filter(
    (a) => normalizeSeverity(a.severityInternal) === "critical"
  );
  const warnSignals = active.filter(
    (a) => normalizeSeverity(a.severityInternal) === "warn"
  );

  const strongest = (
    criticalSignals.length ? criticalSignals : warnSignals
  ).sort((a, b) => {
    const sevDiff =
      severityWeight(normalizeSeverity(b.severityInternal)) -
      severityWeight(normalizeSeverity(a.severityInternal));
    if (sevDiff !== 0) return sevDiff;
    return signalPriority(b.agent) - signalPriority(a.agent);
  });

  const topSeverity = strongest[0]
    ? normalizeSeverity(strongest[0].severityInternal)
    : null;

  const sameTopSeverity = active.filter(
    (a) => normalizeSeverity(a.severityInternal) === topSeverity
  );

  const uniqueTopSignals = new Set(sameTopSeverity.map((a) => a.agent));
  if (uniqueTopSignals.size >= 2) return "mixed";

  return strongest[0]?.agent ?? "mixed";
}

function countImpactedFromBreakdown(
  rows: any[] | undefined,
  kind: "region" | "pop"
): {
  count: number;
  top: string[];
} {
  if (!Array.isArray(rows) || !rows.length) {
    return { count: 0, top: [] };
  }

  const normalized = rows
    .map((row) => {
      const name = String(row?.[kind] || "").trim();
      if (!name || name === "all") return null;

      const errorRatePct = Number(row?.errorRatePct);
      const p95TtmsMs = Number(row?.p95TtmsMs);
      const cacheHitPct = Number(row?.cacheHitPct ?? row?.cacheHitRate);
      const totalRequests = Number(row?.totalRequests ?? row?.requests ?? 0);

      const impacted =
        (Number.isFinite(errorRatePct) && errorRatePct >= 0.2) ||
        (Number.isFinite(p95TtmsMs) && p95TtmsMs >= 500) ||
        (Number.isFinite(cacheHitPct) && cacheHitPct < 80);

      const score =
        (Number.isFinite(errorRatePct) ? errorRatePct * 1000 : 0) +
        (Number.isFinite(p95TtmsMs) ? p95TtmsMs : 0) +
        (Number.isFinite(cacheHitPct)
          ? Math.max(0, 100 - cacheHitPct) * 10
          : 0) +
        (Number.isFinite(totalRequests)
          ? Math.min(totalRequests / 1000, 100)
          : 0);

      return {
        name,
        impacted,
        score,
      };
    })
    .filter(Boolean) as Array<{
    name: string;
    impacted: boolean;
    score: number;
  }>;

  if (!normalized.length) {
    return { count: 0, top: [] };
  }

  const impactedOnly = normalized.filter((x) => x.impacted);
  const source = impactedOnly.length ? impactedOnly : normalized;

  const sorted = [...source].sort((a, b) => b.score - a.score);
  const top = sorted.slice(0, 3).map((x) => x.name);

  return {
    count: impactedOnly.length,
    top,
  };
}

function getBlastRadius(
  bundle: EvidenceBundle
): IncidentAssessment["blastRadius"] {
  const regionStats = countImpactedFromBreakdown(
    bundle.regionBreakdown,
    "region"
  );
  const popStats = countImpactedFromBreakdown(bundle.popBreakdown, "pop");

  const fallbackRegion =
    bundle.normalizedScope.region && bundle.normalizedScope.region !== "all"
      ? [bundle.normalizedScope.region]
      : [];
  const fallbackPop =
    bundle.normalizedScope.pop && bundle.normalizedScope.pop !== "all"
      ? [bundle.normalizedScope.pop]
      : [];

  return {
    regionCount:
      regionStats.count > 0 ? regionStats.count : fallbackRegion.length,
    popCount: popStats.count > 0 ? popStats.count : fallbackPop.length,
    topRegions: regionStats.top.length ? regionStats.top : fallbackRegion,
    topPops: popStats.top.length ? popStats.top : fallbackPop,
  };
}

function getKeyFindings(bundle: EvidenceBundle, agents: AgentResult[]): string[] {
  const scope = getScopeAgent(agents);
  const severityAssessment = assessSeverity(bundle);

  const critical = getNonScopeAgents(agents)
    .filter(
      (a) => normalizeSeverity(a.severityInternal) === "critical" && a.summary
    )
    .map((a) => a.summary);

  const warn = getNonScopeAgents(agents)
    .filter(
      (a) => normalizeSeverity(a.severityInternal) === "warn" && a.summary
    )
    .map((a) => a.summary);

  const ok = getNonScopeAgents(agents)
    .filter((a) => normalizeSeverity(a.severityInternal) === "ok" && a.summary)
    .map((a) => a.summary);

  const severityReasonFindings = severityAssessment.reasons
    .map((r) => r.reason)
    .filter(Boolean);

  const ordered = [
    ...(normalizeSeverity(scope?.severityInternal) === "critical" &&
    scope?.summary
      ? [scope.summary]
      : []),
    ...critical,
    ...warn,
    ...severityReasonFindings,
    ...ok,
  ].filter(Boolean);

  return Array.from(new Set(ordered)).slice(0, 5);
}

function getNextActions(agents: AgentResult[]): string[] {
  const actions = agents
    .flatMap((a) => a.recommendedNextSteps || [])
    .filter(Boolean);

  return Array.from(new Set(actions)).slice(0, 5);
}

function formatBlastRadiusText(
  blastRadius: IncidentAssessment["blastRadius"]
): string | null {
  const regionText =
    blastRadius.regionCount > 0
      ? `${blastRadius.regionCount} region${
          blastRadius.regionCount === 1 ? "" : "s"
        }`
      : null;

  const popText =
    blastRadius.popCount > 0
      ? `${blastRadius.popCount} pop${blastRadius.popCount === 1 ? "" : "s"}`
      : null;

  const joined = [regionText, popText].filter(Boolean).join(", ");
  return joined || null;
}

function pickHeadlineSummary(
  bundle: EvidenceBundle,
  agents: AgentResult[],
  overallStatus: AssessmentStatus,
  primarySignal: IncidentAssessment["primarySignal"],
  blastRadius: IncidentAssessment["blastRadius"],
  keyFindings: string[]
): string {
  const severityAssessment = assessSeverity(bundle);
  const scope = getScopeAgent(agents);

  if (
    normalizeSeverity(scope?.severityInternal) === "critical" &&
    scope?.summary
  ) {
    return scope.summary;
  }

  const nonScope = getNonScopeAgents(agents);
  const strongest = nonScope
    .filter((a) => {
      const s = normalizeSeverity(a.severityInternal);
      return s === "critical" || s === "warn";
    })
    .sort((a, b) => {
      const sevDiff =
        severityWeight(normalizeSeverity(b.severityInternal)) -
        severityWeight(normalizeSeverity(a.severityInternal));
      if (sevDiff !== 0) return sevDiff;

      const aPriority =
        a.agent === "errors" ||
        a.agent === "latency" ||
        a.agent === "cache" ||
        a.agent === "traffic"
          ? signalPriority(a.agent)
          : 0;
      const bPriority =
        b.agent === "errors" ||
        b.agent === "latency" ||
        b.agent === "cache" ||
        b.agent === "traffic"
          ? signalPriority(b.agent)
          : 0;

      return bPriority - aPriority;
    });

  const strongestSummary = strongest[0]?.summary;
  const blastText = formatBlastRadiusText(blastRadius);

  if (strongestSummary && blastText && primarySignal !== "mixed") {
    return `${strongestSummary} Blast radius currently spans ${blastText}.`;
  }

  if (strongestSummary) {
    return strongestSummary;
  }

  const topReason = severityAssessment.topDriver?.reason;

  if (topReason) {
    if (
      strongestSummary &&
      strongestSummary.toLowerCase().includes("cache hit rate")
    ) {
      return strongestSummary;
    }

    const blastSuffix =
      blastText && primarySignal !== "mixed"
        ? ` Blast radius currently spans ${blastText}.`
        : "";

    return `${topReason}.${blastSuffix}`;
  }

  if (keyFindings[0]) {
    return keyFindings[0];
  }

  if (primarySignal !== "mixed") {
    return `Service ${bundle.normalizedScope.service} for ${bundle.normalizedScope.partner} appears ${overallStatus}, primarily driven by ${primarySignal}.`;
  }

  return `Service ${bundle.normalizedScope.service} for ${bundle.normalizedScope.partner} appears ${overallStatus}.`;
}

export function buildAssessment(
  bundle: EvidenceBundle,
  agents: AgentResult[]
): IncidentAssessment {
  const severityAssessment = assessSeverity(bundle);

  const agentOverallStatus = getOverallStatus(agents);
  const severityOverallStatus = severityLevelToOverallStatus(
    severityAssessment.overall
  );

  const overallStatus =
    severityWeight(agentOverallStatus) >= severityWeight(severityOverallStatus)
      ? agentOverallStatus
      : severityOverallStatus;

  const primarySignal = getPrimarySignal(agents, bundle);
  const blastRadius = getBlastRadius(bundle);
  const keyFindings = getKeyFindings(bundle, agents);
  const nextActions = getNextActions(agents);
  const summary = pickHeadlineSummary(
    bundle,
    agents,
    overallStatus,
    primarySignal,
    blastRadius,
    keyFindings
  );

  return {
    overallState: severityToUiState(severityAssessment.overall),
    overallStatus,
    primarySignal,
    blastRadius,
    keyFindings,
    nextActions,
    agents,
    summary,
    severity: severityAssessment.overall,
    severityReasons: severityAssessment.reasons,
    severityTopDriver: severityAssessment.topDriver,
    metadata: {
      table: bundle.diagnostics?.tableUsed,
      bucketSeconds: bundle.diagnostics?.bucketSeconds,
      timeMode: bundle.windowInfo.timeMode,
      source: bundle.diagnostics?.source,
    },
  };
}
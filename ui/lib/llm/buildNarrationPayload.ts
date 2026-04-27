import type {
  NarrationConfidence,
  NarrationPayload,
  NarrationScope,
  NarrationTimeWindow,
} from "./narrationTypes";

type AnyRecord = Record<string, any>;

const toNumber = (value: unknown): number | undefined => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
};

const compactString = (value: unknown, fallback = ""): string => {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return fallback;
};

const asArray = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (typeof item === "string") return item;
      if (item && typeof item === "object") {
        return compactString((item as AnyRecord).label ?? (item as AnyRecord).text ?? (item as AnyRecord).summary);
      }
      return "";
    })
    .filter(Boolean)
    .slice(0, 8);
};

const confidenceFromScore = (score?: number): NarrationConfidence => {
  if (typeof score !== "number") return "medium";
  if (score >= 0.8) return "high";
  if (score >= 0.5) return "medium";
  return "low";
};

export function buildNarrationScope(input: AnyRecord): NarrationScope {
  return {
    partner: compactString(input.partner ?? input.activeScope?.partner, "unknown_partner"),
    service: compactString(input.service ?? input.activeScope?.service, "unknown_service"),
    region: input.region ?? input.activeScope?.region ?? null,
    pop: input.pop ?? input.activeScope?.pop ?? null,
  };
}

export function buildNarrationTimeWindow(input: AnyRecord): NarrationTimeWindow {
  return {
    label: compactString(input.timeLabel ?? input.windowLabel ?? input.timeWindow?.label, "Selected window"),
    actualStart: compactString(
      input.startTsUtc ?? input.actualStart ?? input.timeWindow?.actualStart,
      ""
    ),
    actualEnd: compactString(
      input.endTsUtc ?? input.actualEnd ?? input.timeWindow?.actualEnd,
      ""
    ),
  };
}

function basePayload(input: AnyRecord) {
  const result = input.result ?? input.metricsJson ?? input.assessment ?? input;

  const agents = result.agents ?? result.agentOutputs ?? {};
  const agentOutputs: Record<string, string> = {};

  if (Array.isArray(agents)) {
    for (const agent of agents.slice(0, 8)) {
      const name = compactString(agent.name ?? agent.agent ?? agent.id, "agent");
      const summary = compactString(agent.summary ?? agent.verdict ?? agent.reason ?? agent.status);
      if (summary) agentOutputs[name] = summary;
    }
  } else if (agents && typeof agents === "object") {
    for (const [key, value] of Object.entries(agents).slice(0, 8)) {
      agentOutputs[key] =
        typeof value === "string"
          ? value
          : compactString((value as AnyRecord)?.summary ?? (value as AnyRecord)?.verdict ?? (value as AnyRecord)?.reason);
    }
  }

  return {
    userQuestion: compactString(input.userQuestion ?? input.question, ""),
    parsedIntent: compactString(input.parsedIntent ?? input.intent ?? input.lane, "unknown"),
    activeScope: buildNarrationScope(input),
    timeWindow: buildNarrationTimeWindow(input),
    confidence: confidenceFromScore(toNumber(input.confidence ?? input.parserConfidence)),
    deterministicSummary: compactString(
      result.summary ?? result.deterministicSummary ?? result.assessment?.summary,
      "Deterministic result completed."
    ),
    keyFindings: asArray(result.keyFindings ?? result.findings ?? result.severityReasons),
    agentOutputs,
    importantMetrics: {},
    evidenceUsed: asArray(result.evidenceUsed ?? result.evidence ?? result.proof),
    allowedNextActions: asArray(result.nextActions ?? result.allowedNextActions),
  };
}

export function buildExplainNarrationPayload(input: AnyRecord): NarrationPayload {
  const result = input.result ?? input.metricsJson ?? input.assessment ?? input;
  const base = basePayload(input);

  return {
    ...base,
    cardType: "explain",
    primarySignal: compactString(result.primarySignal ?? result.assessment?.primarySignal, "unknown"),
    supportingMetrics: {
      requests: toNumber(result.requests ?? result.totalRequests) ?? 0,
      p95: toNumber(result.p95 ?? result.p95TtmsMs ?? result.p95_ms) ?? 0,
      p99: toNumber(result.p99 ?? result.p99TtmsMs ?? result.p99_ms) ?? 0,
      errorRate: toNumber(result.errorRate ?? result.errorRatePct ?? result.error_rate_pct) ?? 0,
      cacheHitRate: toNumber(result.cacheHitRate ?? result.cacheHitPct ?? result.cache_hit_rate_pct) ?? 0,
    },
  };
}

export function buildTriageNarrationPayload(input: AnyRecord): NarrationPayload {
  const result = input.result ?? input.metricsJson ?? input.assessment ?? input;
  const base = basePayload(input);

  return {
    ...base,
    cardType: "triage",
    overallState: compactString(result.overallState ?? result.overallStatus, "unknown"),
    primarySignal: compactString(result.primarySignal, "unknown"),
    importantMetrics: {
      requests: toNumber(result.requests ?? result.totalRequests) ?? "unknown",
      p95: toNumber(result.p95 ?? result.p95TtmsMs ?? result.p95_ms) ?? "unknown",
      p99: toNumber(result.p99 ?? result.p99TtmsMs ?? result.p99_ms) ?? "unknown",
      errorRate: toNumber(result.errorRate ?? result.errorRatePct ?? result.error_rate_pct) ?? "unknown",
      cacheHitRate: toNumber(result.cacheHitRate ?? result.cacheHitPct ?? result.cache_hit_rate_pct) ?? "unknown",
    },
    metrics: {
      requests: toNumber(result.requests ?? result.totalRequests),
      p95: toNumber(result.p95 ?? result.p95TtmsMs ?? result.p95_ms),
      p99: toNumber(result.p99 ?? result.p99TtmsMs ?? result.p99_ms),
      errorRate: toNumber(result.errorRate ?? result.errorRatePct ?? result.error_rate_pct),
      cacheHitRate: toNumber(result.cacheHitRate ?? result.cacheHitPct ?? result.cache_hit_rate_pct),
    },
    atsSummary: {
      hit: toNumber(result.atsSummary?.hit ?? result.atsHitPct),
      miss: toNumber(result.atsSummary?.miss ?? result.atsMissPct),
      refresh: toNumber(result.atsSummary?.refresh ?? result.atsRefreshPct),
      clientErr: toNumber(result.atsSummary?.clientErr ?? result.atsClientErrPct),
      infraErr: toNumber(result.atsSummary?.infraErr ?? result.atsInfraErrPct),
    },
    blastRadius: {
      regions: toNumber(result.blastRadius?.regions ?? result.regionCount),
      pops: toNumber(result.blastRadius?.pops ?? result.popCount),
    },
  };
}

export function buildNarrationPayload(input: AnyRecord): NarrationPayload {
  const cardType = compactString(input.cardType, "explain");

  if (cardType === "triage") return buildTriageNarrationPayload(input);

  return buildExplainNarrationPayload({
    ...input,
    cardType: "explain",
  });
}
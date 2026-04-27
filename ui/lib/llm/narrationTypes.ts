// ===============================
// Cachey LLM Narration Types
// ===============================

// ---------- Card Types ----------
export type NarrationCardType =
  | "triage"
  | "exploration"
  | "drill"
  | "compare"
  | "explain"
  | "status";

// ---------- Confidence ----------
export type NarrationConfidence = "high" | "medium" | "low";

// ---------- Scope ----------
export type NarrationScope = {
  partner: string;
  service: string;
  region?: string | null;
  pop?: string | null;
};

// ---------- Time Window ----------
export type NarrationTimeWindow = {
  label: string; // "Last 24h"
  actualStart: string; // ISO
  actualEnd: string;   // ISO
};

// ---------- Base Payload ----------
export type BaseNarrationPayload = {
  userQuestion: string;
  parsedIntent: string;

  cardType: NarrationCardType;

  activeScope: NarrationScope;
  timeWindow: NarrationTimeWindow;

  confidence: NarrationConfidence;

  deterministicSummary: string;
  keyFindings: string[];

  agentOutputs: Record<string, string>;

  importantMetrics: Record<string, number | string>;

  evidenceUsed: string[];

  allowedNextActions: string[];
};

// ===============================
// CARD-SPECIFIC PAYLOADS
// ===============================

// ---------- TRIAGE ----------
export type TriageNarrationPayload = BaseNarrationPayload & {
  overallState: string;
  primarySignal: string;

  metrics: {
    requests?: number;
    p95?: number;
    p99?: number;
    errorRate?: number;
    cacheHitRate?: number;
  };

  atsSummary?: {
    hit?: number;
    miss?: number;
    refresh?: number;
    clientErr?: number;
    infraErr?: number;
  };

  blastRadius?: {
    regions?: number;
    pops?: number;
  };
};

// ---------- EXPLORATION ----------
export type ExplorationNarrationPayload = BaseNarrationPayload & {
  metric: string;
  view: "timeseries" | "breakdown" | "compare";
  dimension?: string;

  seriesSummary?: {
    latest?: number;
    min?: number;
    max?: number;
    trend?: "up" | "down" | "stable";
  };

  rowsSummary?: string[];

  confidenceHint?: string;
};

// ---------- DRILL ----------
export type DrillNarrationPayload = BaseNarrationPayload & {
  drillType:
    | "worst_region"
    | "worst_pop"
    | "worst_ua"
    | "worst_content"
    | "worst_host";

  selectedEntity: string;

  topMetrics?: {
    requests?: number;
    p95?: number;
    errorRate?: number;
    cacheHitRate?: number;
  };

  comparisonContext?: string;

  rowsSummary?: string[];

  parentTriageSummary?: string;
};

// ---------- COMPARE ----------
export type CompareNarrationPayload = BaseNarrationPayload & {
  metric: string;

  current: number;
  previous: number;

  delta: number;
  direction: "up" | "down";

  context?: string;
};

// ---------- EXPLAIN ----------
export type ExplainNarrationPayload = BaseNarrationPayload & {
  primarySignal: string;

  supportingMetrics?: Record<string, number>;

  // userQuestion already exists in base
};

// ---------- STATUS ----------
export type StatusNarrationPayload = BaseNarrationPayload & {
  mode: "aggregate" | "region" | "pop" | "host";

  statusCounts: Record<string, number>;

  totalRequests?: number;

  dominantStatuses?: string[];

  interpretationHint?: string;
};

// ===============================
// UNION TYPE
// ===============================

export type NarrationPayload =
  | TriageNarrationPayload
  | ExplorationNarrationPayload
  | DrillNarrationPayload
  | CompareNarrationPayload
  | ExplainNarrationPayload
  | StatusNarrationPayload;

// ===============================
// OUTPUT TYPE
// ===============================

export type NarrationOutput = {
  leadershipSummary: string;
  engineerRead: string;
  nextChecks: string[];
};

// ===============================
// API RESPONSE WRAPPER
// ===============================

export type NarrationApiResponse = {
  success: boolean;
  data?: NarrationOutput;
  error?: string;
};
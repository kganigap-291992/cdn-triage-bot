// ui/lib/triage/types.ts

// ---------------------------------------------
// Core Scope
// ---------------------------------------------

export type NormalizedScope = {
  partner: string;
  service: string;
  region: string;
  pop: string;
  contentType: string;
  uaFamily: string;
};

// ---------------------------------------------
// Time Series
// ---------------------------------------------

export type TimeSeriesPoint = {
  ts: string;

  // Backward-compatible alias
  requests?: number;

  // Canonical going forward
  totalRequests?: number;

  error5xxCount?: number;
  crcErrorCount?: number;

  errorRatePct?: number;
  successRatePct?: number;

  p95TtmsMs?: number;
  p99TtmsMs?: number;

  cacheHitRate?: number;

  statusCountsByCode?: Record<string, number>;
};

export type HostSeriesPoint = {
  host: string;
  totalRequests?: number;
  error5xxCount?: number;
  crcErrorCount?: number;
  errorRatePct?: number;
  p95TtmsMs?: number | null;
  p99TtmsMs?: number | null;
};

export type CrcSeriesPoint = {
  ts: string;
  crcErrorCount?: number;
};

export type StatusOverTimePoint = {
  ts: string;
  statusCounts: Record<string, number>;
};

export type TimeSeries = {
  bucketSeconds: number | null;
  startTs: string | null;
  endTs: string | null;

  points: TimeSeriesPoint[];

  statusCodeSeries?: string[];

  hostSeries?: HostSeriesPoint[];
  crcSeries?: CrcSeriesPoint[];

  statusOverTime?: StatusOverTimePoint[];
};

// ---------------------------------------------
// Window
// ---------------------------------------------

export type WindowInfo = {
  startTs: string;
  endTs: string;
  windowMinutes: number;
  timeMode: "relative" | "absolute";
};

// ---------------------------------------------
// Derived Metrics
// ---------------------------------------------

export type DerivedMetrics = {
  errorRatePct?: number;
  cacheHitRate?: number;

  trafficDeltaPct?: number;
  latencyDeltaPct?: number;
  p99DeltaPct?: number;
  errorDeltaPct?: number;
  cacheDeltaPct?: number;
};

// ---------------------------------------------
// Diagnostics
// ---------------------------------------------

export type Diagnostics = {
  tableUsed?: string;
  bucketSeconds?: number;
  timeMode?: "relative" | "absolute";
  anchorToMaxTs?: boolean;
  source?: "proxy" | "local";
};

// ---------------------------------------------
// Severity
// ---------------------------------------------

export type SeverityLevel =
  | "healthy"
  | "early_warning"
  | "performance_issue"
  | "major_incident";

export type SeveritySignal = "latency" | "errors" | "cache";

export type SeverityReason = {
  signal: SeveritySignal;
  severity: SeverityLevel;
  reason: string;
  currentValue: number | null;
  previousValue: number | null;
  unit: "ms" | "pct";
};

export type SeverityAssessment = {
  overall: SeverityLevel;
  reasons: SeverityReason[];
  topDriver: SeverityReason | null;
};

// ---------------------------------------------
// User-facing state
// ---------------------------------------------

export type UiState = "normal" | "elevated" | "degraded";

export type PrimarySignal =
  | "scope"
  | "traffic"
  | "latency"
  | "errors"
  | "cache"
  | "mixed";

export type AgentName = "scope" | "traffic" | "latency" | "errors" | "cache";

// ---------------------------------------------
// Evidence Bundle
// ---------------------------------------------

export type BreakdownRow = {
  totalRequests?: number;
  error5xxCount?: number;
  errorRatePct?: number;
  p95TtmsMs?: number | null;
  cacheHitRate?: number | null;

  [key: string]: unknown;
};

export type EvidenceBundle = {
  normalizedScope: NormalizedScope;

  windowInfo: WindowInfo;

  currentMetrics: {
    totalRequests: number;
    p95TtmsMs?: number;
    p99TtmsMs?: number;
    error5xxCount?: number;
    errorRatePct?: number;
    cacheHitRate?: number;
  };

  previousMetrics?: {
    totalRequests?: number;
    p95TtmsMs?: number;
    p99TtmsMs?: number;
    error5xxCount?: number;
    errorRatePct?: number;
    cacheHitRate?: number;
  };

  timeseries?: TimeSeries;

  derivedMetrics?: DerivedMetrics;

  regionBreakdown?: BreakdownRow[];
  popBreakdown?: BreakdownRow[];
  uaBreakdown?: BreakdownRow[];
  contentBreakdown?: BreakdownRow[];
  hostBreakdown?: BreakdownRow[];

  worstLatency?: BreakdownRow[];
  worstErrors?: BreakdownRow[];
  worstCache?: BreakdownRow[];

  diagnostics?: Diagnostics;

  sql?: {
    queries?: string[];
    params?: Record<string, any>;
  };
};

// ---------------------------------------------
// Agent Graph
// ---------------------------------------------

export type AgentGraph = {
  title: string;
  type: "line" | "bar";
  series: {
    name: string;
    data: any[];
  }[];
};

// ---------------------------------------------
// Agent Result
// ---------------------------------------------

export type AgentResult = {
  agent: AgentName;

  state: UiState;

  severityInternal?: SeverityLevel;

  summary: string;

  findings?: string[];

  graphs?: AgentGraph[];

  recommendedNextSteps?: string[];
};

// ---------------------------------------------
// Incident Assessment
// ---------------------------------------------

export type IncidentAssessment = {
  overallState: UiState;

  overallStatus?: "ok" | "warn" | "critical";

  severity?: SeverityLevel;
  severityReasons?: SeverityReason[];
  severityTopDriver?: SeverityReason | null;

  primarySignal: Exclude<PrimarySignal, "scope">;

  blastRadius: {
    regionCount: number;
    popCount: number;
    topRegions?: string[];
    topPops?: string[];
  };

  keyFindings: string[];

  nextActions?: string[];

  agents: AgentResult[];

  summary: string;

  metadata?: {
    table?: string;
    bucketSeconds?: number;
    timeMode?: "relative" | "absolute";
    source?: "proxy" | "local";
  };
};
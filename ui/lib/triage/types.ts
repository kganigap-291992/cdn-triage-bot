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
  requests?: number;
  p95TtmsMs?: number;
  p99TtmsMs?: number;
  errorRatePct?: number;
  cacheHitRate?: number;
};

export type TimeSeries = {
  bucketSeconds: number | null;
  startTs: string | null;
  endTs: string | null;
  points: TimeSeriesPoint[];
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
// Evidence Bundle
// ---------------------------------------------

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

  regionBreakdown?: any[];

  popBreakdown?: any[];

  worstLatency?: any[];

  worstErrors?: any[];

  worstCache?: any[];

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
  series: any[];
};

// ---------------------------------------------
// Agent Result
// ---------------------------------------------

export type AgentResult = {
  agent: "scope" | "traffic" | "latency" | "errors" | "cache";
  status: "ok" | "warn" | "critical";
  summary: string;
  findings?: string[];
  graphs?: AgentGraph[];
};

// ---------------------------------------------
// Incident Assessment
// ---------------------------------------------

export type IncidentAssessment = {
  overallStatus: "ok" | "warn" | "critical";

  primarySignal: "traffic" | "latency" | "errors" | "cache" | "mixed";

  blastRadius: {
    regionCount: number;
    popCount: number;
    topRegions?: string[];
    topPops?: string[];
  };

  keyFindings: string[];

  agents: AgentResult[];

  summary: string;

  metadata?: {
    table?: string;
    bucketSeconds?: number;
    timeMode?: "relative" | "absolute";
  };
};
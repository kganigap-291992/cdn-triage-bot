export type DrillType =
  | "worst_region"
  | "worst_pop"
  | "worst_ua"
  | "worst_content"
  | "worst_host"
  | "worst_status"
  | "worst_endpoint"
  | "time_trend"
  | "comparison";

export type DrillTargetDimension =
  | "region"
  | "pop"
  | "uaFamily"
  | "contentType"
  | "host"
  | "statusCode"
  | "endpointClass";

export type DrillExecutionMode = "bundle" | "canonical_query";

export type DrillEvidenceSource =
  | "regionBreakdown"
  | "popBreakdown"
  | "uaBreakdown"
  | "contentBreakdown"
  | "hostBreakdown"
  | "host_summary"
  | "timeseries"
  | "status_totals"
  | "status_over_time"
  | "ats_summary"
  | "ats_timeseries"
  | "unsupported"
  | "unknown";

export type DrillRequest = {
  type: DrillType;
  scope: {
    partner: string;
    service: string;
    region?: string;
    pop?: string;
    uaFamily?: string;
    contentType?: string;
    host?: string;
    statusCode?: string;
    endpointClass?: string;
  };
  window: {
    startTsUtc?: string | null;
    endTsUtc?: string | null;
    windowMinutes: number;
    timeMode: "relative" | "absolute";
  };
  targetDimension?: DrillTargetDimension;
  anchorValue?: string;
  executionMode?: DrillExecutionMode;
  evidenceSource?: DrillEvidenceSource;
};

export type DrillRow = Record<string, string | number | boolean | null>;

export type DrillTimeseriesPoint = {
  ts: string;
  totalRequests: number;
  error5xxCount: number;
  errorRatePct: number;
  p95TtmsMs: number | null;
  p99TtmsMs: number | null;
  cacheHitRate?: number | null;
};

export type DrillTimeseries = {
  selectedDimension: DrillTargetDimension;
  selectedValue: string;
  bucketSeconds: number | null;
  startTs: string | null;
  endTs: string | null;
  points: DrillTimeseriesPoint[];
};

export type DrillResult = {
  type: DrillType;
  title: string;
  summary: string;
  rows: DrillRow[];
  sql?: {
    queries?: string[];
    params?: Record<string, any>;
  };
  timeseries?: DrillTimeseries;
  metadata?: {
    targetDimension?: DrillTargetDimension;
    anchorValue?: string;
    rowCount?: number;
    executionMode?: DrillExecutionMode;
    evidenceSource?: DrillEvidenceSource;
  };
};
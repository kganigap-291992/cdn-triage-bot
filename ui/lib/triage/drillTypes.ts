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
};

export type DrillRow = Record<string, string | number | boolean | null>;

export type DrillResult = {
  type: DrillType;
  title: string;
  summary: string;
  rows: DrillRow[];
  sql?: {
    queries?: string[];
    params?: Record<string, any>;
  };
  metadata?: {
    targetDimension?: DrillTargetDimension;
    anchorValue?: string;
    rowCount?: number;
  };
};
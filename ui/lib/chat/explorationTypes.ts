// ui/lib/chat/explorationTypes.ts

export type ExplorationMetric =
  | "errors"
  | "latency"
  | "requests"
  | "ats";

export type ExplorationView =
  | "over_time"
  | "by_region"
  | "by_pop"
  | "by_ua"
  | "by_content";

export type ExplorationAtsMode =
  | "category"
  | "detailed";

export type ExplorationIntent = {
  mode: "exploration";
  metric: ExplorationMetric;
  view: ExplorationView;
  atsMode?: ExplorationAtsMode;
  rawText: string;
};

export type ExplorationSeriesPoint = {
  ts: string;
  value: number | null;
};

export type ExplorationBreakdownRow = {
  key: string;
  value: number | null;
  secondaryValue?: number | null;
  tertiaryValue?: number | null;
};

export type ExplorationResult =
  | {
      type: "exploration";
      metric: ExplorationMetric;
      view: "over_time";
      atsMode?: ExplorationAtsMode;
      title: string;
      summary: string;
      series: ExplorationSeriesPoint[];
      sql?: {
        queries: string[];
        params?: Record<string, any>;
      } | null;
    }
  | {
      type: "exploration";
      metric: ExplorationMetric;
      view: "by_region" | "by_pop" | "by_ua" | "by_content";
      atsMode?: ExplorationAtsMode;
      title: string;
      summary: string;
      rows: ExplorationBreakdownRow[];
      sql?: {
        queries: string[];
        params?: Record<string, any>;
      } | null;
    };

export function isExplorationMetric(value: string): value is ExplorationMetric {
  return value === "errors" || value === "latency" || value === "requests" || value === "ats";
}

export function isExplorationView(value: string): value is ExplorationView {
  return (
    value === "over_time" ||
    value === "by_region" ||
    value === "by_pop" ||
    value === "by_ua" ||
    value === "by_content"
  );
}

export function isExplorationAtsMode(value: string): value is ExplorationAtsMode {
  return value === "category" || value === "detailed";
}
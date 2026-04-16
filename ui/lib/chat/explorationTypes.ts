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

export type ExplorationTimeOverride =
  | {
      mode: "relative";
      windowMinutes: number;
      sourceText: string;
    }
  | {
      mode: "absolute";
      startTsUtc: string;
      endTsUtc: string;
      windowMinutes: number;
      sourceText: string;
    };

export type ExplorationIntent = {
  mode: "exploration";
  metric: ExplorationMetric;
  view: ExplorationView;
  atsMode?: ExplorationAtsMode;
  timeOverride?: ExplorationTimeOverride;
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

export type ExplorationSpotlight = {
  key: string;
  title?: string;
  summary?: string;
  series: ExplorationSeriesPoint[];
  seriesSecondary?: ExplorationSeriesPoint[];
};

export type ExplorationResult =
  | {
      type: "exploration";
      metric: ExplorationMetric;
      view: "over_time";
      atsMode?: ExplorationAtsMode;
      title: string;
      summary: string;

      // Primary series (p95 for latency, or main metric)
      series: ExplorationSeriesPoint[];

      // Optional secondary series (used for latency p99)
      seriesSecondary?: ExplorationSeriesPoint[];

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

      // Optional spotlight trend for the worst offender in the breakdown
      spotlight?: ExplorationSpotlight;

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

export function isExplorationTimeOverride(
  value: unknown
): value is ExplorationTimeOverride {
  if (!value || typeof value !== "object") return false;

  const v = value as Record<string, unknown>;

  if (v.mode === "relative") {
    return (
      typeof v.windowMinutes === "number" &&
      Number.isFinite(v.windowMinutes) &&
      v.windowMinutes > 0 &&
      typeof v.sourceText === "string"
    );
  }

  if (v.mode === "absolute") {
    return (
      typeof v.startTsUtc === "string" &&
      typeof v.endTsUtc === "string" &&
      typeof v.windowMinutes === "number" &&
      Number.isFinite(v.windowMinutes) &&
      v.windowMinutes > 0 &&
      typeof v.sourceText === "string"
    );
  }

  return false;
}
// ui/lib/chat/explorationTypes.ts

import type { AtsOperationalFamily } from "@/lib/triage/atsCrcGlossary";

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

  // Family-level ATS support (existing path)
  atsFamily?: AtsOperationalFamily | null;

  // Raw ATS code support (Phase 2A+)
  // Example: "tcp_miss", "err_dns_fail"
  atsRawCode?: string | null;

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
  quaternaryValue?: number | null;
};

export type ExplorationSpotlight = {
  key: string;
  title?: string;
  summary?: string;
  series: ExplorationSeriesPoint[];
  seriesSecondary?: ExplorationSeriesPoint[];
};

export type ExplorationSqlEvidence = {
  queries: string[];
  params?: Record<string, any>;
} | null;

export type ExplorationResult =
  | {
      type: "exploration";
      metric: ExplorationMetric;
      view: "over_time";
      atsMode?: ExplorationAtsMode;
      displayLabel?: string;
      title: string;
      summary: string;

      // Primary timeseries
      series: ExplorationSeriesPoint[];

      // Optional comparison / secondary line
      seriesSecondary?: ExplorationSeriesPoint[];

      // Optional delta / compare rows
      rows?: ExplorationBreakdownRow[];

      sql?: ExplorationSqlEvidence;
    }
  | {
      type: "exploration";
      metric: ExplorationMetric;
      view: "by_region" | "by_pop" | "by_ua" | "by_content";
      atsMode?: ExplorationAtsMode;
      displayLabel?: string;
      title: string;
      summary: string;
      rows: ExplorationBreakdownRow[];

      spotlight?: ExplorationSpotlight;

      sql?: ExplorationSqlEvidence;
    };

export function isExplorationMetric(value: string): value is ExplorationMetric {
  return (
    value === "errors" ||
    value === "latency" ||
    value === "requests" ||
    value === "ats"
  );
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
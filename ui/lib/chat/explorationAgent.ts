// ui/lib/chat/explorationAgent.ts

import type {
  ExplorationAtsMode,
  ExplorationBreakdownRow,
  ExplorationIntent,
  ExplorationMetric,
  ExplorationResult,
  ExplorationView,
} from "./explorationTypes";

export type ExplorationAgentContext = {
  partner: string;
  service: string;
  region: string;
  pop: string;
  contentType: string;
  uaFamily: string;
  windowMinutes: number;
  startTsUtc?: string | null;
  endTsUtc?: string | null;
};

function makeIsoSeries(args: {
  startTsUtc?: string | null;
  endTsUtc?: string | null;
  windowMinutes: number;
  points?: number;
  baseValue: number;
  waveAmplitude?: number;
  driftPerStep?: number;
  floor?: number;
  ceiling?: number;
}): Array<{ ts: string; value: number | null }> {
  const fallbackEndMs = Date.now();

  const parsedEndMs = args.endTsUtc ? new Date(args.endTsUtc).getTime() : NaN;
  const endMs = Number.isFinite(parsedEndMs) ? parsedEndMs : fallbackEndMs;

  const parsedStartMs = args.startTsUtc ? new Date(args.startTsUtc).getTime() : NaN;
  const fallbackStartMs = endMs - Math.max(1, args.windowMinutes) * 60 * 1000;
  const startMs = Number.isFinite(parsedStartMs) ? parsedStartMs : fallbackStartMs;

  const totalPoints = Math.max(6, args.points ?? 12);
  const spanMs = Math.max(1, endMs - startMs);
  const stepMs = totalPoints > 1 ? spanMs / (totalPoints - 1) : spanMs;

  const waveAmplitude = args.waveAmplitude ?? 20;
  const driftPerStep = args.driftPerStep ?? 2;

  return Array.from({ length: totalPoints }, (_, i) => {
    const ts = new Date(startMs + i * stepMs).toISOString();
    const wave = Math.sin(i / 2) * waveAmplitude;
    const drift = i * driftPerStep;

    let value = args.baseValue + wave + drift;

    if (typeof args.floor === "number") {
      value = Math.max(args.floor, value);
    }
    if (typeof args.ceiling === "number") {
      value = Math.min(args.ceiling, value);
    }

    return {
      ts,
      value: Math.round(value * 100) / 100,
    };
  });
}

function buildScopeLabel(context: ExplorationAgentContext): string {
  const scopeBits = [
    context.partner,
    context.service,
    context.region !== "all" ? context.region : null,
    context.pop !== "all" ? context.pop : null,
    context.contentType !== "all" ? context.contentType : null,
    context.uaFamily !== "all" ? context.uaFamily : null,
  ].filter(Boolean);

  return scopeBits.join(" • ");
}

function humanizeView(view: ExplorationView): string {
  return view.replace("by_", "by ");
}

function titleFor(metric: ExplorationMetric, view: ExplorationView): string {
  if (view === "over_time") return `${metric} over time`;
  return `${metric} ${humanizeView(view)}`;
}

function summaryFor(args: {
  metric: ExplorationMetric;
  view: ExplorationView;
  scopeLabel: string;
  atsMode?: ExplorationAtsMode;
}): string {
  if (args.metric === "ats") {
    const atsLabel = args.atsMode === "detailed" ? "ATS detailed" : "ATS";
    if (args.view === "over_time") {
      return `Showing ${atsLabel} trend for ${args.scopeLabel}.`;
    }
    return `Showing ${atsLabel} breakdown for ${args.scopeLabel}.`;
  }

  if (args.view === "over_time") {
    return `Showing ${args.metric} trend for ${args.scopeLabel}.`;
  }

  return `Showing ${args.metric} breakdown for ${args.scopeLabel}.`;
}

function breakdownKeysForView(view: ExplorationView): string[] {
  switch (view) {
    case "by_region":
      return ["us-east", "us-west", "us-central", "eu-west", "eu-central", "ap-south"];
    case "by_pop":
      return ["pop_003", "pop_007", "pop_011", "pop_014", "pop_017", "pop_020"];
    case "by_ua":
      return ["mobile", "web", "stb", "smart_tv", "console"];
    case "by_content":
      return ["manifest", "segment", "api"];
    case "over_time":
    default:
      return [];
  }
}

function buildMetricSeries(
  metric: ExplorationMetric,
  context: ExplorationAgentContext,
  atsMode?: ExplorationAtsMode
): Array<{ ts: string; value: number | null }> {
  switch (metric) {
    case "latency":
      return makeIsoSeries({
        startTsUtc: context.startTsUtc,
        endTsUtc: context.endTsUtc,
        windowMinutes: context.windowMinutes,
        baseValue: 220,
        waveAmplitude: 40,
        driftPerStep: 3,
        floor: 80,
      });

    case "requests":
      return makeIsoSeries({
        startTsUtc: context.startTsUtc,
        endTsUtc: context.endTsUtc,
        windowMinutes: context.windowMinutes,
        baseValue: 12000,
        waveAmplitude: 1800,
        driftPerStep: 150,
        floor: 0,
      });

    case "errors":
      return makeIsoSeries({
        startTsUtc: context.startTsUtc,
        endTsUtc: context.endTsUtc,
        windowMinutes: context.windowMinutes,
        baseValue: 0.35,
        waveAmplitude: 0.18,
        driftPerStep: 0.03,
        floor: 0,
        ceiling: 8,
      });

    case "ats":
      return makeIsoSeries({
        startTsUtc: context.startTsUtc,
        endTsUtc: context.endTsUtc,
        windowMinutes: context.windowMinutes,
        baseValue: atsMode === "detailed" ? 8 : 82,
        waveAmplitude: atsMode === "detailed" ? 2.5 : 6,
        driftPerStep: atsMode === "detailed" ? 0.12 : -0.08,
        floor: 0,
        ceiling: atsMode === "detailed" ? 30 : 100,
      });

    default:
      return [];
  }
}

function buildBreakdownRows(args: {
  metric: ExplorationMetric;
  view: Exclude<ExplorationView, "over_time">;
  atsMode?: ExplorationAtsMode;
}): ExplorationBreakdownRow[] {
  const keys = breakdownKeysForView(args.view);

  if (args.metric === "latency") {
    return keys.map((key, idx) => ({
      key,
      value: Math.round((180 + idx * 28 + (idx % 2 === 0 ? 24 : 8)) * 100) / 100,
      secondaryValue: Math.round((260 + idx * 32 + (idx % 3) * 14) * 100) / 100,
      tertiaryValue: Math.round((9000 + idx * 2200 + (idx % 2) * 700) * 100) / 100,
    }));
  }

  if (args.metric === "requests") {
    return keys.map((key, idx) => ({
      key,
      value: Math.round((22000 - idx * 2300 + (idx % 2) * 900) * 100) / 100,
      secondaryValue: Math.round((0.18 + idx * 0.07) * 100) / 100,
      tertiaryValue: Math.round((190 + idx * 22) * 100) / 100,
    }));
  }

  if (args.metric === "errors") {
    return keys.map((key, idx) => ({
      key,
      value: Math.round((0.32 + idx * 0.19 + (idx % 2) * 0.08) * 100) / 100,
      secondaryValue: Math.round((180 + idx * 26) * 100) / 100,
      tertiaryValue: Math.round((16000 - idx * 1700) * 100) / 100,
    }));
  }

  const atsMode = args.atsMode ?? "category";

  if (atsMode === "detailed") {
    return keys.map((key, idx) => ({
      key,
      value: Math.round((68 - idx * 4.5) * 100) / 100,
      secondaryValue: Math.round((14 + idx * 2.4) * 100) / 100,
      tertiaryValue: Math.round((3 + idx * 0.8) * 100) / 100,
    }));
  }

  return keys.map((key, idx) => ({
    key,
    value: Math.round((82 - idx * 3.2) * 100) / 100,
    secondaryValue: Math.round((10 + idx * 1.7) * 100) / 100,
    tertiaryValue: Math.round((4 + idx * 0.9) * 100) / 100,
  }));
}

export async function runExplorationAgent(args: {
  intent: ExplorationIntent;
  context: ExplorationAgentContext;
}): Promise<ExplorationResult> {
  const { intent, context } = args;
  const scopeLabel = buildScopeLabel(context);

  if (intent.view === "over_time") {
    return {
      type: "exploration",
      metric: intent.metric,
      view: "over_time",
      atsMode: intent.atsMode,
      title: titleFor(intent.metric, intent.view),
      summary: summaryFor({
        metric: intent.metric,
        view: intent.view,
        scopeLabel,
        atsMode: intent.atsMode,
      }),
      series: buildMetricSeries(intent.metric, context, intent.atsMode),
      sql: null,
    };
  }

  return {
    type: "exploration",
    metric: intent.metric,
    view: intent.view,
    atsMode: intent.atsMode,
    title: titleFor(intent.metric, intent.view),
    summary: summaryFor({
      metric: intent.metric,
      view: intent.view,
      scopeLabel,
      atsMode: intent.atsMode,
    }),
    rows: buildBreakdownRows({
      metric: intent.metric,
      view: intent.view,
      atsMode: intent.atsMode,
    }),
    sql: null,
  };
}
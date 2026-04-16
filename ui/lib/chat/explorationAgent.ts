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

type TriageTimeseriesPoint = {
  ts: string;
  totalRequests?: number | null;
  errorRatePct?: number | null;
  error5xxCount?: number | null;
  p95TtmsMs?: number | null;
  p99TtmsMs?: number | null;
  cacheHitRate?: number | null;
};

type TriageResponseShape = {
  ok?: boolean;
  error?: string;
  metricsJson?: {
    timeseries?: {
      points?: TriageTimeseriesPoint[];
      bucketSeconds?: number | null;
      startTs?: string | null;
      endTs?: string | null;
    };
  };
  sql?: {
    queries?: string[];
    params?: Record<string, any>;
  } | null;
};

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

function humanizeDimensionValue(key: string): string {
  return String(key || "").replace(/_/g, " ");
}

function makeSummaryForOverTime(args: {
  metric: ExplorationMetric;
  scopeLabel: string;
  pointCount: number;
  startTs?: string | null;
  endTs?: string | null;
  latestValue?: number | null;
  latestP95?: number | null;
  latestP99?: number | null;
}): string {
  const rangeText =
    args.startTs && args.endTs
      ? `${args.startTs} → ${args.endTs}`
      : "active investigation window";

  if (args.metric === "latency") {
    return [
      `Showing latency trend for ${args.scopeLabel}.`,
      `Window: ${rangeText}.`,
      `Points: ${args.pointCount}.`,
      `Latest p95: ${
        args.latestP95 == null ? "n/a" : `${Math.round(args.latestP95)} ms`
      } • Latest p99: ${
        args.latestP99 == null ? "n/a" : `${Math.round(args.latestP99)} ms`
      }.`,
    ].join(" ");
  }

  if (args.metric === "errors") {
    return [
      `Showing errors trend for ${args.scopeLabel}.`,
      `Window: ${rangeText}.`,
      `Points: ${args.pointCount}.`,
      `Latest error rate: ${
        args.latestValue == null ? "n/a" : `${args.latestValue.toFixed(2)}%`
      }.`,
    ].join(" ");
  }

  if (args.metric === "requests") {
    return [
      `Showing requests trend for ${args.scopeLabel}.`,
      `Window: ${rangeText}.`,
      `Points: ${args.pointCount}.`,
      `Latest requests: ${
        args.latestValue == null ? "n/a" : Math.round(args.latestValue).toLocaleString()
      }.`,
    ].join(" ");
  }

  return `Showing ${args.metric} trend for ${args.scopeLabel}.`;
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

function pickWorstKey(
  rows: ExplorationBreakdownRow[],
  metric: ExplorationMetric
): string | null {
  if (!rows.length) return null;

  if (metric === "latency" || metric === "errors") {
    return rows.reduce((worst, row) => {
      const worstVal = worst.value ?? Number.NEGATIVE_INFINITY;
      const rowVal = row.value ?? Number.NEGATIVE_INFINITY;
      return rowVal > worstVal ? row : worst;
    }).key;
  }

  return null;
}

function cleanNumber(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function cleanTs(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function toSeriesPoint(ts: string, value: number | null) {
  return { ts, value };
}

async function fetchExplorationTriage(
  context: ExplorationAgentContext
): Promise<TriageResponseShape> {
  const payload: Record<string, any> = {
    dataSource: "clickhouse",
    partner: context.partner,
    service: context.service,
    region: context.region,
    pop: context.pop,
    contentType: context.contentType,
    uaFamily: context.uaFamily,
    windowMinutes: context.windowMinutes,
    debug: false,
  };

  if (context.startTsUtc && context.endTsUtc) {
    payload.startTsUtc = context.startTsUtc;
    payload.endTsUtc = context.endTsUtc;
  }

  const resp = await fetch("/api/triage", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const json = (await resp.json().catch(() => null)) as TriageResponseShape | null;

  if (!resp.ok) {
    throw new Error(
      json?.error || `Exploration request failed (HTTP ${resp.status})`
    );
  }

  if (!json?.ok) {
    throw new Error(json?.error || "Exploration request returned ok=false");
  }

  return json;
}

async function buildRealOverTimeResult(args: {
  metric: ExplorationMetric;
  context: ExplorationAgentContext;
}): Promise<ExplorationResult> {
  const { metric, context } = args;
  const scopeLabel = buildScopeLabel(context);
  const triage = await fetchExplorationTriage(context);

  const points = Array.isArray(triage.metricsJson?.timeseries?.points)
    ? triage.metricsJson.timeseries?.points ?? []
    : [];

  const startTs = triage.metricsJson?.timeseries?.startTs ?? context.startTsUtc ?? null;
  const endTs = triage.metricsJson?.timeseries?.endTs ?? context.endTsUtc ?? null;

  if (metric === "latency") {
    const p95Series = points
      .map((point) => {
        const ts = cleanTs(point.ts);
        const value = cleanNumber(point.p95TtmsMs);
        return ts ? toSeriesPoint(ts, value) : null;
      })
      .filter(Boolean) as Array<{ ts: string; value: number | null }>;

    const p99Series = points
      .map((point) => {
        const ts = cleanTs(point.ts);
        const value = cleanNumber(point.p99TtmsMs);
        return ts ? toSeriesPoint(ts, value) : null;
      })
      .filter(Boolean) as Array<{ ts: string; value: number | null }>;

    const latest = points.length ? points[points.length - 1] : null;
    const latestP95 = cleanNumber(latest?.p95TtmsMs);
    const latestP99 = cleanNumber(latest?.p99TtmsMs);

    return {
      type: "exploration",
      metric,
      view: "over_time",
      title: titleFor(metric, "over_time"),
      summary: makeSummaryForOverTime({
        metric,
        scopeLabel,
        pointCount: p95Series.length,
        startTs,
        endTs,
        latestP95,
        latestP99,
      }),
      series: p95Series,
      seriesSecondary: p99Series,
      sql: triage.sql
        ? {
            queries: Array.isArray(triage.sql.queries) ? triage.sql.queries : [],
            params: triage.sql.params ?? undefined,
          }
        : null,
    };
  }

  if (metric === "errors") {
    const series = points
      .map((point) => {
        const ts = cleanTs(point.ts);
        const value = cleanNumber(point.errorRatePct);
        return ts ? toSeriesPoint(ts, value) : null;
      })
      .filter(Boolean) as Array<{ ts: string; value: number | null }>;

    const latest = series.length ? series[series.length - 1] : null;

    return {
      type: "exploration",
      metric,
      view: "over_time",
      title: titleFor(metric, "over_time"),
      summary: makeSummaryForOverTime({
        metric,
        scopeLabel,
        pointCount: series.length,
        startTs,
        endTs,
        latestValue: latest?.value ?? null,
      }),
      series,
      sql: triage.sql
        ? {
            queries: Array.isArray(triage.sql.queries) ? triage.sql.queries : [],
            params: triage.sql.params ?? undefined,
          }
        : null,
    };
  }

  if (metric === "requests") {
    const series = points
      .map((point) => {
        const ts = cleanTs(point.ts);
        const value = cleanNumber(point.totalRequests);
        return ts ? toSeriesPoint(ts, value) : null;
      })
      .filter(Boolean) as Array<{ ts: string; value: number | null }>;

    const latest = series.length ? series[series.length - 1] : null;

    return {
      type: "exploration",
      metric,
      view: "over_time",
      title: titleFor(metric, "over_time"),
      summary: makeSummaryForOverTime({
        metric,
        scopeLabel,
        pointCount: series.length,
        startTs,
        endTs,
        latestValue: latest?.value ?? null,
      }),
      series,
      sql: triage.sql
        ? {
            queries: Array.isArray(triage.sql.queries) ? triage.sql.queries : [],
            params: triage.sql.params ?? undefined,
          }
        : null,
    };
  }

  throw new Error(`Unsupported real over-time metric: ${metric}`);
}

async function buildLatencyBreakdownSpotlight(args: {
  context: ExplorationAgentContext;
  view: Exclude<ExplorationView, "over_time">;
  key: string;
}) {
  const { context, view, key } = args;

  const scopedContext: ExplorationAgentContext = {
    ...context,
    region: view === "by_region" ? key : context.region,
    pop: view === "by_pop" ? key : context.pop,
    uaFamily: view === "by_ua" ? key : context.uaFamily,
    contentType: view === "by_content" ? key : context.contentType,
  };

  const triage = await fetchExplorationTriage(scopedContext);

  const points = Array.isArray(triage.metricsJson?.timeseries?.points)
    ? triage.metricsJson.timeseries?.points ?? []
    : [];

  const p95Series = points
    .map((point) => {
      const ts = cleanTs(point.ts);
      const value = cleanNumber(point.p95TtmsMs);
      return ts ? toSeriesPoint(ts, value) : null;
    })
    .filter(Boolean) as Array<{ ts: string; value: number | null }>;

  const p99Series = points
    .map((point) => {
      const ts = cleanTs(point.ts);
      const value = cleanNumber(point.p99TtmsMs);
      return ts ? toSeriesPoint(ts, value) : null;
    })
    .filter(Boolean) as Array<{ ts: string; value: number | null }>;

  const latest = points.length ? points[points.length - 1] : null;
  const latestP95 = cleanNumber(latest?.p95TtmsMs);
  const latestP99 = cleanNumber(latest?.p99TtmsMs);
  const startTs = triage.metricsJson?.timeseries?.startTs ?? scopedContext.startTsUtc ?? null;
  const endTs = triage.metricsJson?.timeseries?.endTs ?? scopedContext.endTsUtc ?? null;

  return {
    key,
    title: `Worst ${humanizeView(view).replace("by ", "")} over time`,
    summary: makeSummaryForOverTime({
      metric: "latency",
      scopeLabel: buildScopeLabel(scopedContext),
      pointCount: p95Series.length,
      startTs,
      endTs,
      latestP95,
      latestP99,
    }),
    series: p95Series,
    seriesSecondary: p99Series,
  };
}

export async function runExplorationAgent(args: {
  intent: ExplorationIntent;
  context: ExplorationAgentContext;
}): Promise<ExplorationResult> {
  const { intent, context } = args;
  const scopeLabel = buildScopeLabel(context);

  const isRealOverTimeMetric =
    intent.view === "over_time" &&
    (intent.metric === "latency" ||
      intent.metric === "errors" ||
      intent.metric === "requests");

  if (isRealOverTimeMetric) {
    return buildRealOverTimeResult({
      metric: intent.metric,
      context,
    });
  }

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
      series: [],
      sql: null,
    };
  }

  const rows = buildBreakdownRows({
    metric: intent.metric,
    view: intent.view,
    atsMode: intent.atsMode,
  });

  if (intent.metric === "latency") {
    const worstKey = pickWorstKey(rows, intent.metric);

    if (worstKey) {
      const spotlight = await buildLatencyBreakdownSpotlight({
        context,
        view: intent.view,
        key: worstKey,
      });

      return {
        type: "exploration",
        metric: intent.metric,
        view: intent.view,
        atsMode: intent.atsMode,
        title: titleFor(intent.metric, intent.view),
        summary: `${summaryFor({
          metric: intent.metric,
          view: intent.view,
          scopeLabel,
          atsMode: intent.atsMode,
        })} Spotlight: worst ${humanizeView(intent.view).replace("by ", "")} is ${humanizeDimensionValue(
          worstKey
        )}.`,
        rows,
        spotlight,
        sql: null,
      };
    }
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
    rows,
    sql: null,
  };
}
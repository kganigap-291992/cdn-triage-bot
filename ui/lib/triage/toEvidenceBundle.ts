// ui/lib/triage/toEvidenceBundle.ts

import type {
  ClickhouseTriageInputs,
  ClickhouseTriageResult,
} from "@/lib/clickhouse/runClickhouseTriage";
import type {
  Diagnostics,
  DerivedMetrics,
  EvidenceBundle,
  NormalizedScope,
  TimeSeriesPoint,
  WindowInfo,
} from "@/lib/triage/types";

type AtsRawTimeseriesPoint = {
  ts: string;
  requests: number;
  tcp_hit_pct?: number;
  tcp_cf_hit_pct?: number;
  tcp_ims_hit_pct?: number;
  tcp_miss_pct?: number;
  tcp_ims_miss_pct?: number;
  tcp_refresh_hit_pct?: number;
  tcp_refresh_miss_pct?: number;
  err_client_abort_pct?: number;
  err_connect_fail_pct?: number;
  err_dns_fail_pct?: number;
  err_invalid_req_pct?: number;
  err_read_timeout_pct?: number;
  err_lost_server_conn_pct?: number;
  err_write_timeout_pct?: number;
  err_no_origin_pct?: number;
};

function safeNumber(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function asString(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function normalizeAllToken(v: unknown, fallback = "all"): string {
  const s = String(v ?? "").trim();
  return s || fallback;
}

function pctDelta(
  current: number | undefined,
  previous: number | undefined
): number | undefined {
  if (
    current == null ||
    previous == null ||
    !Number.isFinite(current) ||
    !Number.isFinite(previous)
  ) {
    return undefined;
  }

  if (previous === 0) {
    if (current === 0) return 0;
    return undefined;
  }

  return ((current - previous) / Math.abs(previous)) * 100;
}

function pickNumber(obj: any, keys: string[]): number | undefined {
  for (const key of keys) {
    const val = safeNumber(obj?.[key]);
    if (val != null) return val;
  }
  return undefined;
}

function pickArray(obj: any, keys: string[]): any[] {
  for (const key of keys) {
    if (Array.isArray(obj?.[key])) return obj[key];
  }
  return [];
}

function percentFromCount(
  count: number | undefined,
  requests: number | undefined
): number | undefined {
  if (
    count == null ||
    requests == null ||
    !Number.isFinite(count) ||
    !Number.isFinite(requests) ||
    requests <= 0
  ) {
    return undefined;
  }

  return Number(((count / requests) * 100).toFixed(3));
}

function buildNormalizedScope(inputs: ClickhouseTriageInputs): NormalizedScope {
  return {
    partner: String(inputs.partner ?? "").trim(),
    service: String(inputs.service ?? "").trim(),
    region: normalizeAllToken(inputs.region, "all"),
    pop: normalizeAllToken(inputs.pop, "all"),
    contentType: normalizeAllToken(inputs.contentType, "all"),
    uaFamily: normalizeAllToken(inputs.uaFamily, "all"),
  };
}

function buildWindowInfo(
  inputs: ClickhouseTriageInputs,
  result: ClickhouseTriageResult
): WindowInfo {
  const debug = result?.metricsJson?.debug || {};
  const tr = result?.metricsJson?.timeRangeUTC || {};

  const startTs =
    asString(tr.start) ||
    asString(result?.metricsJson?.timeseries?.startTs) ||
    asString(result?.metricsJson?.window_start) ||
    asString(debug.startTsUtc) ||
    "";

  const endTs =
    asString(tr.end) ||
    asString(result?.metricsJson?.timeseries?.endTs) ||
    asString(result?.metricsJson?.window_end) ||
    asString(debug.endTsUtc) ||
    "";

  const timeMode =
    debug.timeMode === "absolute" || debug.timeMode === "relative"
      ? debug.timeMode
      : inputs.startTsUtc && inputs.endTsUtc
      ? "absolute"
      : "relative";

  return {
    startTs,
    endTs,
    windowMinutes: Number(inputs.windowMinutes || 0),
    timeMode,
  };
}

function buildCurrentMetrics(result: ClickhouseTriageResult) {
  const m = result?.metricsJson || {};

  return {
    totalRequests:
      pickNumber(m, ["totalRequests", "total_requests", "requests"]) ?? 0,
    p95TtmsMs: pickNumber(m, ["p95TtmsMs", "p95_ms", "p95_ttms_ms"]),
    p99TtmsMs: pickNumber(m, ["p99TtmsMs", "p99_ms", "p99_ttms_ms"]),
    error5xxCount: pickNumber(m, [
      "error5xxCount",
      "error_5xx_count",
      "http_5xx",
      "http_5xx_count",
    ]),
    errorRatePct: pickNumber(m, ["errorRatePct", "error_rate_pct"]),
    cacheHitRate: pickNumber(m, [
      "cacheHitRate",
      "cacheHitPct",
      "cache_hit_rate",
      "cache_hit_pct",
    ]),
  };
}

function pickPreviousMetricsSource(result: ClickhouseTriageResult): any | null {
  const m = result?.metricsJson || {};

  return (
    m.previousMetrics ||
    m.previousWindow ||
    m.previous ||
    m.prev ||
    m.evidenceBundle?.previousMetrics ||
    null
  );
}

function buildPreviousMetrics(result: ClickhouseTriageResult) {
  const prev = pickPreviousMetricsSource(result);
  if (!prev || typeof prev !== "object") return undefined;

  return {
    totalRequests:
      pickNumber(prev, ["totalRequests", "total_requests", "requests"]) ?? 0,
    p95TtmsMs: pickNumber(prev, ["p95TtmsMs", "p95_ms", "p95_ttms_ms"]),
    p99TtmsMs: pickNumber(prev, ["p99TtmsMs", "p99_ms", "p99_ttms_ms"]),
    error5xxCount: pickNumber(prev, [
      "error5xxCount",
      "error_5xx_count",
      "http_5xx",
      "http_5xx_count",
    ]),
    errorRatePct: pickNumber(prev, ["errorRatePct", "error_rate_pct"]),
    cacheHitRate: pickNumber(prev, [
      "cacheHitRate",
      "cacheHitPct",
      "cache_hit_rate",
      "cache_hit_pct",
    ]),
  };
}

function buildTimeseries(result: ClickhouseTriageResult): TimeSeriesPoint[] {
  const points = result?.metricsJson?.timeseries?.points;
  if (!Array.isArray(points)) return [];

  return points
    .map(
      (p: any): TimeSeriesPoint => ({
        ts: String(p?.ts || p?.bucket || ""),
        requests: pickNumber(p, ["requests", "totalRequests", "total_requests"]),
        p95TtmsMs: pickNumber(p, ["p95TtmsMs", "p95_ms", "p95_ttms_ms"]),
        p99TtmsMs: pickNumber(p, ["p99TtmsMs", "p99_ms", "p99_ttms_ms"]),
        errorRatePct: pickNumber(p, ["errorRatePct", "error_rate_pct"]),
        cacheHitRate: pickNumber(p, [
          "cacheHitRate",
          "cacheHitPct",
          "cache_hit_rate",
          "cache_hit_pct",
        ]),
      })
    )
    .filter((pt: TimeSeriesPoint) => Boolean(pt.ts));
}

function buildAtsRawTimeseries(
  result: ClickhouseTriageResult
): AtsRawTimeseriesPoint[] {
  const m = result?.metricsJson || {};

  const fromMetrics = pickArray(m, [
    "atsRawTimeseries",
    "atsRawOverTime",
    "rawAtsTimeseries",
    "rawAtsOverTime",
  ]);
  const fromMetricsBundle = pickArray(m?.evidenceBundle, [
    "atsRawTimeseries",
    "atsRawOverTime",
    "rawAtsTimeseries",
    "rawAtsOverTime",
  ]);
  const fromMetricsEvidence = pickArray((m as any)?.evidence, [
    "atsRawTimeseries",
    "atsRawOverTime",
    "rawAtsTimeseries",
    "rawAtsOverTime",
  ]);
  const fromResultBundle = pickArray((result as any)?.evidenceBundle, [
    "atsRawTimeseries",
    "atsRawOverTime",
    "rawAtsTimeseries",
    "rawAtsOverTime",
  ]);
  const fromResultEvidence = pickArray((result as any)?.evidence, [
    "atsRawTimeseries",
    "atsRawOverTime",
    "rawAtsTimeseries",
    "rawAtsOverTime",
  ]);

  const points = fromMetrics.length
    ? fromMetrics
    : fromMetricsBundle.length
    ? fromMetricsBundle
    : fromMetricsEvidence.length
    ? fromMetricsEvidence
    : fromResultBundle.length
    ? fromResultBundle
    : fromResultEvidence.length
    ? fromResultEvidence
    : [];

  if (!points.length) return [];

  return points
    .map((p: any): AtsRawTimeseriesPoint => {
      const requests =
        pickNumber(p, ["requests", "totalRequests", "total_requests"]) ?? 0;

      const tcpHit =
        pickNumber(p, ["tcp_hit_count", "ats_tcp_hit_count", "tcp_hit"]) ?? 0;
      const tcpCfHit =
        pickNumber(p, [
          "tcp_cf_hit_count",
          "ats_tcp_cf_hit_count",
          "tcp_cf_hit",
        ]) ?? 0;
      const tcpImsHit =
        pickNumber(p, [
          "tcp_ims_hit_count",
          "ats_tcp_ims_hit_count",
          "tcp_ims_hit",
        ]) ?? 0;
      const tcpMiss =
        pickNumber(p, ["tcp_miss_count", "ats_tcp_miss_count", "tcp_miss"]) ?? 0;
      const tcpImsMiss =
        pickNumber(p, [
          "tcp_ims_miss_count",
          "ats_tcp_ims_miss_count",
          "tcp_ims_miss",
        ]) ?? 0;
      const tcpRefreshHit =
        pickNumber(p, [
          "tcp_refresh_hit_count",
          "ats_tcp_refresh_hit_count",
          "tcp_refresh_hit",
        ]) ?? 0;
      const tcpRefreshMiss =
        pickNumber(p, [
          "tcp_refresh_miss_count",
          "ats_tcp_refresh_miss_count",
          "tcp_refresh_miss",
        ]) ?? 0;

      const errClientAbort =
        pickNumber(p, [
          "err_client_abort_count",
          "ats_err_client_abort_count",
          "err_client_abort",
        ]) ?? 0;
      const errConnectFail =
        pickNumber(p, [
          "err_connect_fail_count",
          "ats_err_connect_fail_count",
          "err_connect_fail",
        ]) ?? 0;
      const errDnsFail =
        pickNumber(p, [
          "err_dns_fail_count",
          "ats_err_dns_fail_count",
          "err_dns_fail",
        ]) ?? 0;
      const errInvalidReq =
        pickNumber(p, [
          "err_invalid_req_count",
          "ats_err_invalid_req_count",
          "err_invalid_req",
        ]) ?? 0;
      const errReadTimeout =
        pickNumber(p, [
          "err_read_timeout_count",
          "ats_err_read_timeout_count",
          "err_read_timeout",
        ]) ?? 0;
      const errLostServerConn =
        pickNumber(p, [
          "err_lost_server_conn_count",
          "ats_err_lost_server_conn_count",
          "err_lost_server_conn",
        ]) ?? 0;
      const errWriteTimeout =
        pickNumber(p, [
          "err_write_timeout_count",
          "ats_err_write_timeout_count",
          "err_write_timeout",
        ]) ?? 0;
      const errNoOrigin =
        pickNumber(p, [
          "err_no_origin_count",
          "ats_err_no_origin_count",
          "err_no_origin",
        ]) ?? 0;

      return {
        ts: String(p?.ts || p?.bucket || ""),
        requests,
        tcp_hit_pct: percentFromCount(tcpHit, requests),
        tcp_cf_hit_pct: percentFromCount(tcpCfHit, requests),
        tcp_ims_hit_pct: percentFromCount(tcpImsHit, requests),
        tcp_miss_pct: percentFromCount(tcpMiss, requests),
        tcp_ims_miss_pct: percentFromCount(tcpImsMiss, requests),
        tcp_refresh_hit_pct: percentFromCount(tcpRefreshHit, requests),
        tcp_refresh_miss_pct: percentFromCount(tcpRefreshMiss, requests),
        err_client_abort_pct: percentFromCount(errClientAbort, requests),
        err_connect_fail_pct: percentFromCount(errConnectFail, requests),
        err_dns_fail_pct: percentFromCount(errDnsFail, requests),
        err_invalid_req_pct: percentFromCount(errInvalidReq, requests),
        err_read_timeout_pct: percentFromCount(errReadTimeout, requests),
        err_lost_server_conn_pct: percentFromCount(errLostServerConn, requests),
        err_write_timeout_pct: percentFromCount(errWriteTimeout, requests),
        err_no_origin_pct: percentFromCount(errNoOrigin, requests),
      };
    })
    .filter((pt) => Boolean(pt.ts));
}

function buildDerivedMetrics(
  result: ClickhouseTriageResult,
  currentMetrics: {
    totalRequests: number;
    p95TtmsMs?: number;
    p99TtmsMs?: number;
    error5xxCount?: number;
    errorRatePct?: number;
    cacheHitRate?: number;
  },
  previousMetrics?: {
    totalRequests?: number;
    p95TtmsMs?: number;
    p99TtmsMs?: number;
    error5xxCount?: number;
    errorRatePct?: number;
    cacheHitRate?: number;
  }
): DerivedMetrics {
  const m = result?.metricsJson || {};

  return {
    errorRatePct: pickNumber(m, ["errorRatePct", "error_rate_pct"]),
    cacheHitRate: pickNumber(m, [
      "cacheHitRate",
      "cacheHitPct",
      "cache_hit_rate",
      "cache_hit_pct",
    ]),
    trafficDeltaPct: pctDelta(
      safeNumber(currentMetrics.totalRequests),
      safeNumber(previousMetrics?.totalRequests)
    ),
    latencyDeltaPct: pctDelta(
      currentMetrics.p95TtmsMs,
      previousMetrics?.p95TtmsMs
    ),
    p99DeltaPct: pctDelta(
      currentMetrics.p99TtmsMs,
      previousMetrics?.p99TtmsMs
    ),
    errorDeltaPct: pctDelta(
      currentMetrics.errorRatePct,
      previousMetrics?.errorRatePct
    ),
    cacheDeltaPct: pctDelta(
      currentMetrics.cacheHitRate,
      previousMetrics?.cacheHitRate
    ),
  };
}

function buildDiagnostics(result: ClickhouseTriageResult): Diagnostics {
  const debug = result?.metricsJson?.debug || {};

  let source: Diagnostics["source"] = "proxy";
  if (debug.forcedLocal === true) source = "local";
  else if (debug.forcedLocal === false) source = "proxy";

  return {
    tableUsed: asString(debug.tableUsed) || undefined,
    bucketSeconds: safeNumber(debug.bucketSeconds),
    timeMode:
      debug.timeMode === "absolute" || debug.timeMode === "relative"
        ? debug.timeMode
        : undefined,
    anchorToMaxTs:
      typeof debug.anchorToMaxTs === "boolean"
        ? debug.anchorToMaxTs
        : undefined,
    source,
  };
}

function normalizeSql(result: ClickhouseTriageResult) {
  const sql = result?.sql;
  if (!sql) return undefined;

  if (Array.isArray(sql.queries)) {
    return {
      queries: sql.queries.map(String),
      params: sql.params ?? undefined,
    };
  }

  if (typeof (sql as any).query === "string" && (sql as any).query.trim()) {
    return {
      queries: [String((sql as any).query).trim()],
      params: (sql as any).params ?? undefined,
    };
  }

  return {
    queries: [],
    params: (sql as any).params ?? undefined,
  };
}

function buildRegionBreakdown(result: ClickhouseTriageResult) {
  const m = result?.metricsJson || {};
  return pickArray(m, ["regionBreakdown"]).length
    ? pickArray(m, ["regionBreakdown"])
    : pickArray(m?.evidenceBundle, ["regionBreakdown"]);
}

function buildPopBreakdown(result: ClickhouseTriageResult) {
  const m = result?.metricsJson || {};
  return pickArray(m, ["popBreakdown"]).length
    ? pickArray(m, ["popBreakdown"])
    : pickArray(m?.evidenceBundle, ["popBreakdown"]);
}

function buildUABreakdown(result: ClickhouseTriageResult) {
  const m = result?.metricsJson || {};
  return pickArray(m, ["uaBreakdown"]).length
    ? pickArray(m, ["uaBreakdown"])
    : pickArray(m?.evidenceBundle, ["uaBreakdown"]);
}

function buildContentBreakdown(result: ClickhouseTriageResult) {
  const m = result?.metricsJson || {};
  return pickArray(m, ["contentBreakdown"]).length
    ? pickArray(m, ["contentBreakdown"])
    : pickArray(m?.evidenceBundle, ["contentBreakdown"]);
}

function normalizeHostBreakdownRow(row: any) {
  const host = asString(row?.host ?? row?.hostname ?? row?.host_name) || "unknown";

  return {
    host,
    totalRequests:
      pickNumber(row, ["totalRequests", "total_requests", "requests"]) ?? 0,
    error5xxCount:
      pickNumber(row, [
        "error5xxCount",
        "error_5xx_count",
        "http_5xx",
        "http_5xx_count",
      ]) ?? 0,
    errorRatePct: pickNumber(row, ["errorRatePct", "error_rate_pct"]) ?? 0,
    p95TtmsMs: pickNumber(row, ["p95TtmsMs", "p95_ms", "p95_ttms_ms"]) ?? null,
    p99TtmsMs: pickNumber(row, ["p99TtmsMs", "p99_ms", "p99_ttms_ms"]) ?? null,
    cacheHitRate: pickNumber(row, [
      "cacheHitRate",
      "cacheHitPct",
      "cache_hit_rate",
      "cache_hit_pct",
    ]) ?? null,
    crcErrorCount:
      pickNumber(row, ["crcErrorCount", "crc_error_count", "crc_errors"]) ?? 0,
  };
}

function buildHostBreakdown(result: ClickhouseTriageResult) {
  const m = result?.metricsJson || {};

  const fromMetrics = pickArray(m, ["hostBreakdown"]);
  const fromResult = pickArray(result, ["hostBreakdown"]);
  const fromMetricsBundle = pickArray(m?.evidenceBundle, ["hostBreakdown"]);
  const fromMetricsEvidence = pickArray((m as any)?.evidence, ["hostBreakdown"]);
  const fromResultBundle = pickArray((result as any)?.evidenceBundle, ["hostBreakdown"]);
  const fromResultEvidence = pickArray((result as any)?.evidence, ["hostBreakdown"]);

  const rows = fromMetrics.length
    ? fromMetrics
    : fromResult.length
    ? fromResult
    : fromMetricsBundle.length
    ? fromMetricsBundle
    : fromMetricsEvidence.length
    ? fromMetricsEvidence
    : fromResultBundle.length
    ? fromResultBundle
    : fromResultEvidence.length
    ? fromResultEvidence
    : [];

  if (!rows.length) return [];

  return rows
    .map((row: any) => normalizeHostBreakdownRow(row))
    .filter((row: any) => Boolean(row?.host));
}

export function toEvidenceBundle(
  inputs: ClickhouseTriageInputs,
  result: ClickhouseTriageResult
): EvidenceBundle {
  const normalizedScope = buildNormalizedScope(inputs);
  const windowInfo = buildWindowInfo(inputs, result);
  const currentMetrics = buildCurrentMetrics(result);
  const previousMetrics = buildPreviousMetrics(result);
  const currentPoints = buildTimeseries(result);
  const atsRawTimeseries = buildAtsRawTimeseries(result);
  const derivedMetrics = buildDerivedMetrics(
    result,
    currentMetrics,
    previousMetrics
  );
  const diagnostics = buildDiagnostics(result);
  const sql = normalizeSql(result);
  const regionBreakdown = buildRegionBreakdown(result);
  const popBreakdown = buildPopBreakdown(result);
  const uaBreakdown = buildUABreakdown(result);
  const contentBreakdown = buildContentBreakdown(result);
  const hostBreakdown = buildHostBreakdown(result);

  return {
    normalizedScope,
    windowInfo,
    currentMetrics,
    previousMetrics,
    timeseries: {
      bucketSeconds:
        safeNumber(result?.metricsJson?.timeseries?.bucketSeconds) ??
        safeNumber(result?.metricsJson?.debug?.bucketSeconds) ??
        null,
      startTs:
        asString(result?.metricsJson?.timeseries?.startTs) ??
        asString(result?.metricsJson?.window_start) ??
        null,
      endTs:
        asString(result?.metricsJson?.timeseries?.endTs) ??
        asString(result?.metricsJson?.window_end) ??
        null,
      points: currentPoints,
    },
    derivedMetrics,
    regionBreakdown,
    popBreakdown,
    uaBreakdown,
    contentBreakdown,
    hostBreakdown,
    worstLatency: [],
    worstErrors: [],
    worstCache: [],
    diagnostics,
    sql,
    ...(atsRawTimeseries.length ? { atsRawTimeseries } : {}),
  } as EvidenceBundle;
}
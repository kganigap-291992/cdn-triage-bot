// ui/app/api/triage/route.ts
import { NextResponse } from "next/server";
import { CANON } from "@/lib/schema/canonical";
import { runClickhouseTriage } from "@/lib/clickhouse/runClickhouseTriage";
import { buildClickhouseSql } from "@/lib/clickhouse/sqlBuilder";
import { toEvidenceBundle } from "@/lib/triage/toEvidenceBundle";
import { runAgents } from "@/lib/triage/runAgents";
import { buildAssessment } from "@/lib/triage/buildAssessment";
import { resolveDrillRequest, type DrillIntent } from "@/lib/triage/drillResolver";
import { executeDrill } from "@/lib/triage/drillExecutor";

export const runtime = "nodejs";

type Inputs = {
  dataSource: string;
  partner: string;
  service: string;
  region: string;
  pop: string;
  windowMinutes: number;
  startTsUtc: string | null;
  endTsUtc: string | null;
  debug: boolean;
  contentType: string;
  uaFamily: string;
  drillIntent: DrillIntent | null;
};

type EvidenceScope = {
  partner: string;
  service: string;
  region: string;
  pop: string;
  contentType: string;
  uaFamily: string;
  windowMinutes: number;
  startTsUtc: string | null;
  endTsUtc: string | null;
};

type TimeMode =
  | { mode: "relative" }
  | { mode: "absolute"; startIso: string; endIso: string };

function boolish(v: unknown) {
  if (typeof v === "boolean") return v;
  const s = String(v ?? "").trim().toLowerCase();
  return ["1", "true", "yes", "on"].includes(s);
}

function tok(v: unknown) {
  return String(v ?? "").trim();
}

function clampInt(n: number, min: number, max: number) {
  const x = Math.floor(n);
  return Math.max(min, Math.min(max, x));
}

function numOrNull(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function numOrZero(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function asString(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function isCanonPartner(x: string) {
  return (CANON.partners as readonly string[]).includes(x);
}

function isCanonService(x: string) {
  return (CANON.services as readonly string[]).includes(x);
}

function isAllOrOneOf(x: string, allowed: readonly string[]) {
  return x === "all" || allowed.includes(x);
}

function isDrillIntent(x: string): x is DrillIntent {
  return [
    "worst_region",
    "worst_pop",
    "worst_ua",
    "worst_content",
    "worst_host",
    "worst_status",
    "worst_endpoint",
    "time_trend",
    "comparison",
  ].includes(x);
}

function buildEvidenceScope(inputs: Inputs, tm: TimeMode): EvidenceScope {
  return {
    partner: inputs.partner,
    service: inputs.service,
    region: inputs.region,
    pop: inputs.pop,
    contentType: inputs.contentType,
    uaFamily: inputs.uaFamily,
    windowMinutes: inputs.windowMinutes,
    startTsUtc: tm.mode === "absolute" ? tm.startIso : null,
    endTsUtc: tm.mode === "absolute" ? tm.endIso : null,
  };
}

function normalizeBreakdownKey(v: unknown): string | null {
  const s = String(v ?? "").trim().toLowerCase();
  return s || null;
}

function readUiOrSqlNumber(
  row: Record<string, any>,
  uiKey: string,
  sqlKey: string
): number {
  if (row?.[uiKey] != null) return numOrZero(row[uiKey]);
  if (row?.[sqlKey] != null) return numOrZero(row[sqlKey]);
  return 0;
}

function readUiOrSqlNullableNumber(
  row: Record<string, any>,
  uiKey: string,
  sqlKey: string
): number | null {
  if (row?.[uiKey] != null) return numOrNull(row[uiKey]);
  if (row?.[sqlKey] != null) return numOrNull(row[sqlKey]);
  return null;
}

function sortBreakdownRows(a: any, b: any) {
  if (b.error5xxCount !== a.error5xxCount) return b.error5xxCount - a.error5xxCount;
  if ((b.p95TtmsMs ?? -1) !== (a.p95TtmsMs ?? -1)) return (b.p95TtmsMs ?? -1) - (a.p95TtmsMs ?? -1);
  return b.totalRequests - a.totalRequests;
}

function normalizeRegionBreakdownRow(row: any) {
  const region = normalizeBreakdownKey(row?.region);
  if (!region) return null;

  return {
    region,
    totalRequests: readUiOrSqlNumber(row, "totalRequests", "total_requests"),
    error5xxCount: readUiOrSqlNumber(row, "error5xxCount", "error_5xx_count"),
    errorRatePct: readUiOrSqlNumber(row, "errorRatePct", "error_rate_pct"),
    p95TtmsMs: readUiOrSqlNullableNumber(row, "p95TtmsMs", "p95_ttms_ms"),
    cacheHitPct:
      row?.cacheHitPct != null
        ? numOrNull(row.cacheHitPct)
        : row?.cache_hit_rate != null
        ? numOrNull(row.cache_hit_rate)
        : row?.cacheHitRate != null
        ? numOrNull(row.cacheHitRate)
        : null,
  };
}

function normalizePopBreakdownRow(row: any) {
  const pop = normalizeBreakdownKey(row?.pop);
  if (!pop) return null;

  return {
    pop,
    totalRequests: readUiOrSqlNumber(row, "totalRequests", "total_requests"),
    error5xxCount: readUiOrSqlNumber(row, "error5xxCount", "error_5xx_count"),
    errorRatePct: readUiOrSqlNumber(row, "errorRatePct", "error_rate_pct"),
    p95TtmsMs: readUiOrSqlNullableNumber(row, "p95TtmsMs", "p95_ttms_ms"),
    cacheHitPct:
      row?.cacheHitPct != null
        ? numOrNull(row.cacheHitPct)
        : row?.cache_hit_rate != null
        ? numOrNull(row.cache_hit_rate)
        : row?.cacheHitRate != null
        ? numOrNull(row.cacheHitRate)
        : null,
  };
}

function normalizeUaBreakdownRow(row: any) {
  const uaFamily = normalizeBreakdownKey(row?.uaFamily ?? row?.ua_family);
  if (!uaFamily) return null;

  return {
    uaFamily,
    totalRequests: readUiOrSqlNumber(row, "totalRequests", "total_requests"),
    error5xxCount: readUiOrSqlNumber(row, "error5xxCount", "error_5xx_count"),
    errorRatePct: readUiOrSqlNumber(row, "errorRatePct", "error_rate_pct"),
    p95TtmsMs: readUiOrSqlNullableNumber(row, "p95TtmsMs", "p95_ttms_ms"),
    cacheHitPct:
      row?.cacheHitPct != null
        ? numOrNull(row.cacheHitPct)
        : row?.cache_hit_rate != null
        ? numOrNull(row.cache_hit_rate)
        : row?.cacheHitRate != null
        ? numOrNull(row.cacheHitRate)
        : null,
  };
}

function normalizeContentBreakdownRow(row: any) {
  const contentType = normalizeBreakdownKey(row?.contentType ?? row?.content_type);
  if (!contentType) return null;

  return {
    contentType,
    totalRequests: readUiOrSqlNumber(row, "totalRequests", "total_requests"),
    error5xxCount: readUiOrSqlNumber(row, "error5xxCount", "error_5xx_count"),
    errorRatePct: readUiOrSqlNumber(row, "errorRatePct", "error_rate_pct"),
    p95TtmsMs: readUiOrSqlNullableNumber(row, "p95TtmsMs", "p95_ttms_ms"),
    cacheHitPct:
      row?.cacheHitPct != null
        ? numOrNull(row.cacheHitPct)
        : row?.cache_hit_rate != null
        ? numOrNull(row.cache_hit_rate)
        : row?.cacheHitRate != null
        ? numOrNull(row.cacheHitRate)
        : null,
  };
}

function normalizeAtsSummary(raw: any) {
  if (!raw || typeof raw !== "object") return undefined;

  const hitCount = numOrZero(raw.hitCount ?? raw.hit_count);
  const missCount = numOrZero(raw.missCount ?? raw.miss_count);
  const refreshCount = numOrZero(raw.refreshCount ?? raw.refresh_count);
  const clientErrorCount = numOrZero(raw.clientErrorCount ?? raw.client_error_count);
  const infraErrorCount = numOrZero(raw.infraErrorCount ?? raw.infra_error_count);

  const atsTotal =
    raw.atsTotal != null
      ? numOrZero(raw.atsTotal)
      : hitCount + missCount + refreshCount + clientErrorCount + infraErrorCount;

  const hitPct =
    numOrNull(raw.hitPct ?? raw.hit_pct) ??
    (atsTotal > 0 ? (100 * hitCount) / atsTotal : 0);

  const missPct =
    numOrNull(raw.missPct ?? raw.miss_pct) ??
    (atsTotal > 0 ? (100 * missCount) / atsTotal : 0);

  const refreshPct =
    numOrNull(raw.refreshPct ?? raw.refresh_pct) ??
    (atsTotal > 0 ? (100 * refreshCount) / atsTotal : 0);

  const clientErrorPct =
    numOrNull(raw.clientErrorPct ?? raw.client_error_pct) ??
    (atsTotal > 0 ? (100 * clientErrorCount) / atsTotal : 0);

  const infraErrorPct =
    numOrNull(raw.infraErrorPct ?? raw.infra_error_pct) ??
    (atsTotal > 0 ? (100 * infraErrorCount) / atsTotal : 0);

  return {
    hitCount,
    missCount,
    refreshCount,
    clientErrorCount,
    infraErrorCount,
    atsTotal,
    hitPct,
    missPct,
    refreshPct,
    clientErrorPct,
    infraErrorPct,
  };
}

function pickAtsSummaryFromProxy(parsed: any, rawMetrics: any) {
  return (
    normalizeAtsSummary(rawMetrics?.atsSummary) ||
    normalizeAtsSummary(rawMetrics?.ats_summary) ||
    normalizeAtsSummary(rawMetrics?.evidenceBundle?.atsSummary) ||
    normalizeAtsSummary(rawMetrics?.evidence?.atsSummary) ||
    normalizeAtsSummary(parsed?.evidenceBundle?.atsSummary) ||
    normalizeAtsSummary(parsed?.evidence?.atsSummary) ||
    undefined
  );
}

function pickPreviousAtsSummaryFromProxy(parsed: any, rawMetrics: any) {
  return (
    normalizeAtsSummary(rawMetrics?.previousAtsSummary) ||
    normalizeAtsSummary(rawMetrics?.previous_ats_summary) ||
    normalizeAtsSummary(rawMetrics?.previousWindow?.atsSummary) ||
    normalizeAtsSummary(parsed?.previousAtsSummary) ||
    normalizeAtsSummary(parsed?.previousWindow?.atsSummary) ||
    undefined
  );
}


function normalizeHostBreakdownRow(row: any) {
  const host = asString(row?.host);
  if (!host) return null;

  return {
    host,
    totalRequests: readUiOrSqlNumber(row, "totalRequests", "total_requests"),
    error5xxCount: readUiOrSqlNumber(row, "error5xxCount", "error_5xx_count"),
    errorRatePct: readUiOrSqlNumber(row, "errorRatePct", "error_rate_pct"),
    p95TtmsMs:
      row?.p95TtmsMs != null
        ? numOrNull(row.p95TtmsMs)
        : row?.p95_ttms_ms != null
        ? numOrNull(row.p95_ttms_ms)
        : null,
    p99TtmsMs:
      row?.p99TtmsMs != null
        ? numOrNull(row.p99TtmsMs)
        : row?.p99_ttms_ms != null
        ? numOrNull(row.p99_ttms_ms)
        : row?.p99_ms != null
        ? numOrNull(row.p99_ms)
        : null,
    crcErrorCount:
      row?.crcErrorCount != null
        ? numOrZero(row.crcErrorCount)
        : row?.crc_error_count != null
        ? numOrZero(row.crc_error_count)
        : row?.crc_errors != null
        ? numOrZero(row.crc_errors)
        : 0,
    cacheHitPct:
      row?.cacheHitPct != null
        ? numOrNull(row.cacheHitPct)
        : row?.cache_hit_rate != null
        ? numOrNull(row.cache_hit_rate)
        : row?.cacheHitRate != null
        ? numOrNull(row.cacheHitRate)
        : null,
  };
}

function normalizeRegionBreakdown(rows: unknown): any[] | undefined {
  if (!Array.isArray(rows)) return undefined;
  const out = rows.map((row) => normalizeRegionBreakdownRow(row)).filter(Boolean) as any[];
  if (!out.length) return undefined;
  out.sort(sortBreakdownRows);
  return out;
}

function normalizePopBreakdown(rows: unknown): any[] | undefined {
  if (!Array.isArray(rows)) return undefined;
  const out = rows.map((row) => normalizePopBreakdownRow(row)).filter(Boolean) as any[];
  if (!out.length) return undefined;
  out.sort(sortBreakdownRows);
  return out;
}

function normalizeUaBreakdown(rows: unknown): any[] | undefined {
  if (!Array.isArray(rows)) return undefined;
  const out = rows.map((row) => normalizeUaBreakdownRow(row)).filter(Boolean) as any[];
  if (!out.length) return undefined;
  out.sort(sortBreakdownRows);
  return out;
}

function normalizeContentBreakdown(rows: unknown): any[] | undefined {
  if (!Array.isArray(rows)) return undefined;
  const out = rows.map((row) => normalizeContentBreakdownRow(row)).filter(Boolean) as any[];
  if (!out.length) return undefined;
  out.sort(sortBreakdownRows);
  return out;
}

function normalizeHostBreakdown(rows: unknown): any[] | undefined {
  if (!Array.isArray(rows)) return undefined;
  const out = rows.map((row) => normalizeHostBreakdownRow(row)).filter(Boolean) as any[];
  if (!out.length) return undefined;
  out.sort(sortBreakdownRows);
  return out;
}

function pickRegionBreakdownFromProxy(parsed: any, rawMetrics: any): any[] | undefined {
  return (
    normalizeRegionBreakdown(rawMetrics?.regionBreakdown) ||
    normalizeRegionBreakdown(rawMetrics?.evidenceBundle?.regionBreakdown) ||
    normalizeRegionBreakdown(rawMetrics?.evidence?.regionBreakdown) ||
    normalizeRegionBreakdown(parsed?.evidenceBundle?.regionBreakdown) ||
    normalizeRegionBreakdown(parsed?.evidence?.regionBreakdown) ||
    undefined
  );
}

function pickPopBreakdownFromProxy(parsed: any, rawMetrics: any): any[] | undefined {
  return (
    normalizePopBreakdown(rawMetrics?.popBreakdown) ||
    normalizePopBreakdown(rawMetrics?.evidenceBundle?.popBreakdown) ||
    normalizePopBreakdown(rawMetrics?.evidence?.popBreakdown) ||
    normalizePopBreakdown(parsed?.evidenceBundle?.popBreakdown) ||
    normalizePopBreakdown(parsed?.evidence?.popBreakdown) ||
    undefined
  );
}

function pickUaBreakdownFromProxy(parsed: any, rawMetrics: any): any[] | undefined {
  return (
    normalizeUaBreakdown(rawMetrics?.uaBreakdown) ||
    normalizeUaBreakdown(rawMetrics?.evidenceBundle?.uaBreakdown) ||
    normalizeUaBreakdown(rawMetrics?.evidence?.uaBreakdown) ||
    normalizeUaBreakdown(parsed?.evidenceBundle?.uaBreakdown) ||
    normalizeUaBreakdown(parsed?.evidence?.uaBreakdown) ||
    undefined
  );
}

function pickContentBreakdownFromProxy(parsed: any, rawMetrics: any): any[] | undefined {
  return (
    normalizeContentBreakdown(rawMetrics?.contentBreakdown) ||
    normalizeContentBreakdown(rawMetrics?.evidenceBundle?.contentBreakdown) ||
    normalizeContentBreakdown(rawMetrics?.evidence?.contentBreakdown) ||
    normalizeContentBreakdown(parsed?.evidenceBundle?.contentBreakdown) ||
    normalizeContentBreakdown(parsed?.evidence?.contentBreakdown) ||
    undefined
  );
}

function pickHostBreakdownFromProxy(parsed: any, rawMetrics: any): any[] | undefined {
  return (
    normalizeHostBreakdown(rawMetrics?.hostBreakdown) ||
    normalizeHostBreakdown(rawMetrics?.evidenceBundle?.hostBreakdown) ||
    normalizeHostBreakdown(rawMetrics?.evidence?.hostBreakdown) ||
    normalizeHostBreakdown(parsed?.evidenceBundle?.hostBreakdown) ||
    normalizeHostBreakdown(parsed?.evidence?.hostBreakdown) ||
    undefined
  );
}

function deriveSuccessRatePctFromStatusCounts(
  statusCountsByCode: Record<string, number> | undefined,
  totalRequests: number
): number {
  if (!statusCountsByCode || totalRequests <= 0) return 0;
  const ok200 = numOrZero(statusCountsByCode["200"]);
  const ok206 = numOrZero(statusCountsByCode["206"]);
  const ok304 = numOrZero(statusCountsByCode["304"]);
  return (100 * (ok200 + ok206 + ok304)) / totalRequests;
}

function normalizeTimeseriesPoint(row: any) {
  const ts = asString(row?.ts) ?? asString(row?.bucket);
  if (!ts) return null;

  const totalRequests =
    row?.totalRequests != null
      ? numOrZero(row.totalRequests)
      : row?.total_requests != null
      ? numOrZero(row.total_requests)
      : 0;

  const error5xxCount =
    row?.error5xxCount != null
      ? numOrZero(row.error5xxCount)
      : row?.http_5xx != null
      ? numOrZero(row.http_5xx)
      : 0;

  const errorRatePct =
    row?.errorRatePct != null
      ? numOrZero(row.errorRatePct)
      : row?.error_rate_pct != null
      ? numOrZero(row.error_rate_pct)
      : totalRequests > 0
      ? (100 * error5xxCount) / totalRequests
      : 0;

  const statusCountsByCode =
    row?.statusCountsByCode && typeof row.statusCountsByCode === "object"
      ? row.statusCountsByCode
      : row?.status_counts_by_code && typeof row.status_counts_by_code === "object"
      ? row.status_counts_by_code
      : undefined;

  const successRatePct =
    row?.successRatePct != null && numOrZero(row.successRatePct) > 0
      ? numOrZero(row.successRatePct)
      : row?.success_rate_pct != null && numOrZero(row.success_rate_pct) > 0
      ? numOrZero(row.success_rate_pct)
      : deriveSuccessRatePctFromStatusCounts(statusCountsByCode, totalRequests);

  return {
    ts,
    totalRequests,
    error5xxCount,
    crcErrorCount:
      row?.crcErrorCount != null
        ? numOrZero(row.crcErrorCount)
        : row?.crc_errors != null
        ? numOrZero(row.crc_errors)
        : 0,
    errorRatePct,
    successRatePct,
    p95TtmsMs:
      row?.p95TtmsMs != null
        ? numOrNull(row.p95TtmsMs)
        : row?.p95_ms != null
        ? numOrNull(row.p95_ms)
        : null,
    p99TtmsMs:
      row?.p99TtmsMs != null
        ? numOrNull(row.p99TtmsMs)
        : row?.p99_ms != null
        ? numOrNull(row.p99_ms)
        : null,
    cacheHitRate:
      row?.cacheHitRate != null
        ? numOrNull(row.cacheHitRate)
        : row?.cache_hit_rate != null
        ? numOrNull(row.cache_hit_rate)
        : null,
    statusCountsByCode,
  };
}

function normalizeHostSeriesRow(row: any) {
  const host = asString(row?.host);
  if (!host) return null;

  return {
    host,
    totalRequests: readUiOrSqlNumber(row, "totalRequests", "total_requests"),
    error5xxCount: readUiOrSqlNumber(row, "error5xxCount", "error_5xx_count"),
    crcErrorCount:
      row?.crcErrorCount != null
        ? numOrZero(row.crcErrorCount)
        : row?.crc_errors != null
        ? numOrZero(row.crc_errors)
        : 0,
    errorRatePct: readUiOrSqlNumber(row, "errorRatePct", "error_rate_pct"),
    p95TtmsMs:
      row?.p95TtmsMs != null
        ? numOrNull(row.p95TtmsMs)
        : row?.p95_ttms_ms != null
        ? numOrNull(row.p95_ttms_ms)
        : null,
    p99TtmsMs:
      row?.p99TtmsMs != null
        ? numOrNull(row.p99TtmsMs)
        : row?.p99_ms != null
        ? numOrNull(row.p99_ms)
        : null,
  };
}

function normalizeCrcSeriesRow(row: any) {
  const ts = asString(row?.ts) ?? asString(row?.bucket);
  if (!ts) return null;

  return {
    ts,
    crcErrorCount:
      row?.crcErrorCount != null
        ? numOrZero(row.crcErrorCount)
        : row?.crc_errors != null
        ? numOrZero(row.crc_errors)
        : 0,
  };
}

function normalizeTimeseries(metricsJson: any) {
  const t = metricsJson?.timeseries;
  if (!t || typeof t !== "object") {
    return { bucketSeconds: null, startTs: null, endTs: null, points: [] };
  }

  const points = Array.isArray(t.points)
    ? t.points.map((row: any) => normalizeTimeseriesPoint(row)).filter(Boolean)
    : [];

  const hostSeries = Array.isArray(t.hostSeries)
    ? t.hostSeries.map((row: any) => normalizeHostSeriesRow(row)).filter(Boolean)
    : [];

  const crcSeries = Array.isArray(t.crcSeries)
    ? t.crcSeries.map((row: any) => normalizeCrcSeriesRow(row)).filter(Boolean)
    : [];

  const statusOverTime = Array.isArray(t.statusOverTime)
    ? t.statusOverTime
    : Array.isArray(t.status_over_time)
    ? t.status_over_time
    : [];

  return {
    bucketSeconds: t.bucketSeconds != null ? numOrZero(t.bucketSeconds) : null,
    startTs: asString(t.startTs) ?? (points.length ? asString(points[0]?.ts) : null) ?? null,
    endTs:
      asString(t.endTs) ?? (points.length ? asString(points[points.length - 1]?.ts) : null) ?? null,
    points,
    statusCodeSeries: Array.isArray(t.statusCodeSeries)
      ? t.statusCodeSeries.map(String)
      : undefined,
    hostSeries,
    crcSeries,
    statusOverTime,
  };
}

function normalizePreviousWindow(previousWindow: any) {
  if (!previousWindow || typeof previousWindow !== "object") return undefined;

  const timeseriesRaw = previousWindow.timeseries && typeof previousWindow.timeseries === "object"
    ? previousWindow.timeseries
    : {};

  const crcOverTime = Array.isArray(timeseriesRaw.crcOverTime)
    ? timeseriesRaw.crcOverTime
    : Array.isArray(timeseriesRaw.crc_over_time)
    ? timeseriesRaw.crc_over_time
    : [];

  const statusOverTime = Array.isArray(timeseriesRaw.statusOverTime)
    ? timeseriesRaw.statusOverTime
    : Array.isArray(timeseriesRaw.status_over_time)
    ? timeseriesRaw.status_over_time
    : [];

  return {
    totalRequests:
      previousWindow.totalRequests != null
        ? numOrZero(previousWindow.totalRequests)
        : previousWindow.total_requests != null
        ? numOrZero(previousWindow.total_requests)
        : 0,
    p50TtmsMs:
      previousWindow.p50TtmsMs != null
        ? numOrNull(previousWindow.p50TtmsMs)
        : previousWindow.p50_ms != null
        ? numOrNull(previousWindow.p50_ms)
        : null,
    p95TtmsMs:
      previousWindow.p95TtmsMs != null
        ? numOrNull(previousWindow.p95TtmsMs)
        : previousWindow.p95_ms != null
        ? numOrNull(previousWindow.p95_ms)
        : null,
    p99TtmsMs:
      previousWindow.p99TtmsMs != null
        ? numOrNull(previousWindow.p99TtmsMs)
        : previousWindow.p99_ms != null
        ? numOrNull(previousWindow.p99_ms)
        : null,
    cacheHitRate:
      previousWindow.cacheHitRate != null
        ? numOrNull(previousWindow.cacheHitRate)
        : previousWindow.cache_hit_rate != null
        ? numOrNull(previousWindow.cache_hit_rate)
        : null,
    error5xxCount:
      previousWindow.error5xxCount != null
        ? numOrZero(previousWindow.error5xxCount)
        : previousWindow.http_5xx != null
        ? numOrZero(previousWindow.http_5xx)
        : 0,
    crcErrorCount:
      previousWindow.crcErrorCount != null
        ? numOrZero(previousWindow.crcErrorCount)
        : previousWindow.crc_errors != null
        ? numOrZero(previousWindow.crc_errors)
        : 0,
    errorRatePct:
      previousWindow.errorRatePct != null
        ? numOrZero(previousWindow.errorRatePct)
        : previousWindow.error_rate_pct != null
        ? numOrZero(previousWindow.error_rate_pct)
        : 0,
    successRatePct:
      previousWindow.successRatePct != null
        ? numOrZero(previousWindow.successRatePct)
        : previousWindow.success_rate_pct != null
        ? numOrZero(previousWindow.success_rate_pct)
        : 0,
    timeRangeUTC:
      previousWindow.timeRangeUTC && typeof previousWindow.timeRangeUTC === "object"
        ? {
            start: asString(previousWindow.timeRangeUTC.start),
            end: asString(previousWindow.timeRangeUTC.end),
          }
        : undefined,
    timeseries: {
      ...normalizeTimeseries({ timeseries: timeseriesRaw }),
      crcOverTime,
      statusOverTime,
    },
  };
}

function buildCompareMetrics(metricsJson: any) {
  const previous = metricsJson?.previousMetrics ?? metricsJson?.previousWindow ?? null;

  if (!previous || typeof previous !== "object") return undefined;

  const currentTraffic = numOrNull(metricsJson?.totalRequests);
  const previousTraffic = numOrNull(previous?.totalRequests);

  const currentErrors = numOrNull(metricsJson?.errorRatePct);
  const previousErrors = numOrNull(previous?.errorRatePct);

  const currentLatency = numOrNull(metricsJson?.p95TtmsMs);
  const previousLatency = numOrNull(previous?.p95TtmsMs);

  const currentCache = numOrNull(metricsJson?.cacheHitRate);
  const previousCache = numOrNull(previous?.cacheHitRate);

  return {
    traffic: {
      current: currentTraffic,
      previous: previousTraffic,
      delta:
        currentTraffic != null && previousTraffic != null
          ? currentTraffic - previousTraffic
          : null,
    },
    errors: {
      current: currentErrors,
      previous: previousErrors,
      delta:
        currentErrors != null && previousErrors != null
          ? currentErrors - previousErrors
          : null,
    },
    latency: {
      current: currentLatency,
      previous: previousLatency,
      delta:
        currentLatency != null && previousLatency != null
          ? currentLatency - previousLatency
          : null,
    },
    cache: {
      current: currentCache,
      previous: previousCache,
      delta:
        currentCache != null && previousCache != null
          ? currentCache - previousCache
          : null,
    },
  };
}

function assertCanonicalMetricsJson(metricsJson: any) {
  if (!metricsJson || typeof metricsJson !== "object") {
    throw new Error("route: metricsJson missing");
  }

  const totalRequests =
    metricsJson.totalRequests != null
      ? numOrZero(metricsJson.totalRequests)
      : metricsJson.total_requests != null
      ? numOrZero(metricsJson.total_requests)
      : null;

  const p95TtmsMs =
    metricsJson.p95TtmsMs != null
      ? numOrNull(metricsJson.p95TtmsMs)
      : metricsJson.p95_ms != null
      ? numOrNull(metricsJson.p95_ms)
      : null;

  const cacheHitRate =
    metricsJson.cacheHitRate != null
      ? numOrNull(metricsJson.cacheHitRate)
      : metricsJson.cache_hit_rate != null
      ? numOrNull(metricsJson.cache_hit_rate)
      : null;

  const error5xxCount =
    metricsJson.error5xxCount != null
      ? numOrZero(metricsJson.error5xxCount)
      : metricsJson.http_5xx != null
      ? numOrZero(metricsJson.http_5xx)
      : null;

  const errorRatePct =
    metricsJson.errorRatePct != null
      ? numOrZero(metricsJson.errorRatePct)
      : metricsJson.error_rate_pct != null
      ? numOrZero(metricsJson.error_rate_pct)
      : totalRequests != null && error5xxCount != null && totalRequests > 0
      ? (100 * error5xxCount) / totalRequests
      : 0;

  const successRatePct =
    metricsJson.successRatePct != null && numOrZero(metricsJson.successRatePct) > 0
      ? numOrZero(metricsJson.successRatePct)
      : metricsJson.success_rate_pct != null && numOrZero(metricsJson.success_rate_pct) > 0
      ? numOrZero(metricsJson.success_rate_pct)
      : 0;

  if (totalRequests == null) {
    throw new Error("route: non-canonical metricsJson (missing totalRequests|total_requests)");
  }
  if (error5xxCount == null) {
    throw new Error("route: non-canonical metricsJson (missing error5xxCount|http_5xx)");
  }
  if (p95TtmsMs == null && metricsJson.p95TtmsMs == null && metricsJson.p95_ms == null) {
    throw new Error("route: non-canonical metricsJson (missing p95TtmsMs|p95_ms)");
  }

  const out: any = {
    ...metricsJson,
    totalRequests,
    p95TtmsMs,
    cacheHitRate,
    error5xxCount,
    errorRatePct,
    successRatePct,
  };

  if (!out.debug || typeof out.debug !== "object") {
    out.debug = {};
  }

  out.timeseries = normalizeTimeseries(metricsJson);

  const previousWindow = normalizePreviousWindow(metricsJson.previousWindow);
  if (previousWindow) {
    out.previousWindow = previousWindow;

    // 🔥 BACKWARD COMPATIBILITY SHIM (CRITICAL)
    out.previousMetrics = {
      totalRequests: previousWindow.totalRequests,
      p50TtmsMs: previousWindow.p50TtmsMs,
      p95TtmsMs: previousWindow.p95TtmsMs,
      p99TtmsMs: previousWindow.p99TtmsMs,
      cacheHitRate: previousWindow.cacheHitRate,
      error5xxCount: previousWindow.error5xxCount,
      crcErrorCount: previousWindow.crcErrorCount,
      errorRatePct: previousWindow.errorRatePct,
      successRatePct: previousWindow.successRatePct,
    };

    out.previousTimeseries = previousWindow.timeseries;
  }

  return out;
}

function canonicalStubMetricsJson(debug: Record<string, any>) {
  return {
    totalRequests: 0,
    p95TtmsMs: null,
    cacheHitRate: null,
    error5xxCount: 0,
    errorRatePct: 0,
    successRatePct: 0,
    timeseries: { bucketSeconds: null, startTs: null, endTs: null, points: [] },
    debug: { ...(debug || {}) },
  };
}

function normalizeSqlForUi(sql: any) {
  if (!sql) return undefined;

  if (Array.isArray(sql.queries)) {
    return {
      queries: sql.queries.map((q: any) => String(q)),
      params: sql.params ?? undefined,
    };
  }

  if (typeof sql.query === "string" && sql.query.trim()) {
    return {
      queries: [sql.query.trim()],
      params: sql.params ?? undefined,
    };
  }

  return undefined;
}

function buildPlannerSqlFallback(scope: EvidenceScope, tm: TimeMode) {
  const built = buildClickhouseSql({
    partner: scope.partner,
    service: scope.service,
    region: scope.region,
    pop: scope.pop,
    contentType: scope.contentType,
    uaFamily: scope.uaFamily,
    windowMinutes: scope.windowMinutes,
    startTsUtc: tm.mode === "absolute" ? tm.startIso : undefined,
    endTsUtc: tm.mode === "absolute" ? tm.endIso : undefined,
    anchorToMaxTs: tm.mode === "relative",
  } as any);

  return {
    queries: built.queries.map((q: any) => String(q)),
    params: built.params ?? undefined,
  };
}

function normalize(x: Record<string, any>): Inputs {
  const dataSource = String(x.dataSource ?? x.data_source ?? "clickhouse")
    .trim()
    .toLowerCase();

  const partner = tok(x.partner);
  const service = tok(x.service ?? x.svc);
  const region = tok(x.region) || "all";
  const pop = tok(x.pop) || "all";
  const ctRaw = tok(x.contentType ?? x.content_type ?? x.ct) || "all";
  const uaRaw = tok(x.uaFamily ?? x.ua_family ?? x.ua) || "all";

  const wmRaw = Number(x.windowMinutes ?? x.win ?? x.window ?? 60);
  const windowMinutes = Number.isFinite(wmRaw) ? clampInt(wmRaw, 5, 1440) : 60;

  const startTsUtc = tok(x.startTsUtc ?? x.start_ts_utc ?? x.start ?? "").trim() || null;
  const endTsUtc = tok(x.endTsUtc ?? x.end_ts_utc ?? x.end ?? "").trim() || null;

  const debug = boolish(x.debug);

  const rawDrillIntent = tok(x.drillIntent ?? x.drill_intent ?? "");
  const drillIntent = rawDrillIntent && isDrillIntent(rawDrillIntent) ? rawDrillIntent : null;

  return {
    dataSource,
    partner,
    service,
    region,
    pop,
    windowMinutes,
    startTsUtc,
    endTsUtc,
    debug,
    contentType: ctRaw,
    uaFamily: uaRaw,
    drillIntent,
  };
}

async function parseRequest(req: Request): Promise<Inputs> {
  const ct = req.headers.get("content-type") || "";

  if (ct.includes("application/json")) {
    const body = (await req.json().catch(() => ({}))) as any;
    return normalize(body);
  }

  if (ct.includes("application/x-www-form-urlencoded")) {
    const text = await req.text();
    const params = new URLSearchParams(text);
    const obj: Record<string, any> = {};
    for (const [k, v] of params.entries()) obj[k] = v;
    return normalize(obj);
  }

  if (ct.includes("multipart/form-data")) {
    const form = await req.formData();
    const obj: Record<string, any> = {};
    for (const [k, v] of form.entries()) {
      if (typeof v === "string") obj[k] = v;
    }
    return normalize(obj);
  }

  const body = (await req.json().catch(() => ({}))) as any;
  return normalize(body);
}

function badRequest(error: string, extra?: Record<string, any>) {
  return NextResponse.json(
    { ok: false, error, ...(extra ? { details: extra } : {}) },
    { status: 400 }
  );
}

function okJson(payload: any) {
  return NextResponse.json(payload, { status: 200 });
}

function hasProxyEnv() {
  return !!process.env.CACHEY_PROXY_URL;
}

function proxyTriageUrl() {
  const proxyUrl = process.env.CACHEY_PROXY_URL!;
  const base = proxyUrl.replace(/\/+$/, "");
  return base.endsWith("/triage") ? base : `${base}/triage`;
}

function parseIsoOrNull(s: string | null): { ok: true; iso: string } | { ok: false; error: string } {
  if (!s) return { ok: false, error: "missing" };
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return { ok: true, iso: s };
  return { ok: true, iso: d.toISOString() };
}

function computeTimeMode(inputs: Inputs): TimeMode {
  const hasStart = !!inputs.startTsUtc;
  const hasEnd = !!inputs.endTsUtc;

  if (!hasStart && !hasEnd) return { mode: "relative" };

  if (hasStart !== hasEnd) {
    throw new Error("startTsUtc and endTsUtc must both be provided for absolute range");
  }

  const s = parseIsoOrNull(inputs.startTsUtc);
  const e = parseIsoOrNull(inputs.endTsUtc);
  if (!s.ok || !e.ok) {
    throw new Error("startTsUtc/endTsUtc must be valid UTC ISO strings");
  }

  const sMs = new Date(s.iso).getTime();
  const eMs = new Date(e.iso).getTime();
  if (!Number.isFinite(sMs) || !Number.isFinite(eMs) || eMs <= sMs) {
    throw new Error("invalid range: endTsUtc must be after startTsUtc");
  }

  return { mode: "absolute", startIso: s.iso, endIso: e.iso };
}

async function maybeExecuteDrill(
  inputs: Inputs,
  evidenceBundle: any,
  metricsJson: any,
  sql: any,
  mode: "local" | "proxy"
) {
  if (!inputs.drillIntent) return null;

  const drillRequest = resolveDrillRequest(inputs.drillIntent, evidenceBundle);
  if (!drillRequest) {
    return okJson({
      ok: false,
      kind: "drill",
      error: `Unsupported drill intent: ${inputs.drillIntent}`,
      metricsJson,
      sql,
      _mode: mode,
    });
  }

  console.log("ROUTE DEBUG drillIntent", inputs.drillIntent);
  console.log("ROUTE DEBUG metricsJson.hostBreakdown.length", metricsJson?.hostBreakdown?.length ?? 0);
  console.log("ROUTE DEBUG evidenceBundle.hostBreakdown.length", evidenceBundle?.hostBreakdown?.length ?? 0);
  console.log("ROUTE DEBUG evidenceBundle.hostBreakdown.sample", evidenceBundle?.hostBreakdown?.slice?.(0, 2));
  console.log("ROUTE DEBUG metricsJson.hostBreakdown.sample", metricsJson?.hostBreakdown?.slice?.(0, 2));

    const drill = await executeDrill(drillRequest, evidenceBundle, {
    runQuery: async (queries, params) => {
      if (!Array.isArray(queries) || !queries.length) return [];

      if (mode === "local") {
        const payload: any = {
          partner: inputs.partner,
          service: inputs.service,
          region: inputs.region,
          pop: inputs.pop,
          contentType: inputs.contentType,
          uaFamily: inputs.uaFamily,
          windowMinutes: inputs.windowMinutes,
          debug: inputs.debug,
        };

        const timeMode = metricsJson?.debug?.timeMode;
        const startTsUtc = metricsJson?.debug?.startTsUtc;
        const endTsUtc = metricsJson?.debug?.endTsUtc;

        if (
          timeMode === "absolute" &&
          typeof startTsUtc === "string" &&
          typeof endTsUtc === "string"
        ) {
          payload.startTsUtc = startTsUtc;
          payload.endTsUtc = endTsUtc;
        }

        const result = await runClickhouseTriage(payload);

        console.log(
          "ROUTE TS DEBUG local payload",
          payload
        );
        console.log(
          "ROUTE TS DEBUG local result.timeseries.points.length",
          result?.metricsJson?.timeseries?.points?.length ?? 0
        );
        console.log(
          "ROUTE TS DEBUG local result.timeseries.points.sample",
          result?.metricsJson?.timeseries?.points?.slice?.(0, 2)
        );

        const rows = result?.metricsJson?.timeseries?.points;
        return Array.isArray(rows) ? rows : [];
      }

      if (!hasProxyEnv()) return [];

      const triageUrl = proxyTriageUrl();

      const upstreamBody: any = {
        partner: params?.partner ?? inputs.partner,
        service: params?.service ?? inputs.service,
        region: params?.region ?? inputs.region,
        pop: params?.pop ?? inputs.pop,
        contentType: params?.contentType ?? inputs.contentType,
        uaFamily: params?.uaFamily ?? inputs.uaFamily,
        windowMinutes: params?.windowMinutes ?? inputs.windowMinutes,
        debug: inputs.debug,
        sql: {
          queries,
          params: params ?? {},
        },
      };

      if (
        typeof params?.startTsUtc === "string" &&
        typeof params?.endTsUtc === "string"
      ) {
        upstreamBody.startTsUtc = params.startTsUtc;
        upstreamBody.endTsUtc = params.endTsUtc;
      }

      const upstream = await fetch(triageUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(process.env.CACHEY_PROXY_TOKEN
            ? { "x-cachey-token": process.env.CACHEY_PROXY_TOKEN }
            : {}),
        },
        body: JSON.stringify(upstreamBody),
      });

      const text = await upstream.text().catch(() => "");
      const parsed = (() => {
        try {
          return text ? JSON.parse(text) : null;
        } catch {
          return null;
        }
      })();

      if (!upstream.ok) {
        throw new Error(
          parsed?.error
            ? String(parsed.error)
            : `proxy drill query failed (HTTP ${upstream.status})`
        );
      }

      const tsRows =
        parsed?.metricsJson?.timeseries?.points ??
        parsed?.metrics?.timeseries?.points ??
        parsed?.timeseries?.points ??
        [];

      console.log(
        "ROUTE TS DEBUG proxy params",
        params
      );
      console.log(
        "ROUTE TS DEBUG proxy tsRows.length",
        Array.isArray(tsRows) ? tsRows.length : -1
      );
      console.log(
        "ROUTE TS DEBUG proxy tsRows.sample",
        Array.isArray(tsRows) ? tsRows.slice(0, 2) : tsRows
      );

      return Array.isArray(tsRows) ? tsRows : [];
    },
  });

  return okJson({
    ok: true,
    kind: "drill",
    summary: `Drill: ${drill.title}`,
    metricsJson,
    sql,
    drill,
    _mode: mode,
  });
}

async function runLocal(inputs: Inputs, tm: TimeMode) {
  const payload: any = {
    partner: inputs.partner,
    service: inputs.service,
    region: inputs.region,
    pop: inputs.pop,
    contentType: inputs.contentType,
    uaFamily: inputs.uaFamily,
    windowMinutes: inputs.windowMinutes,
    debug: inputs.debug,
  };

  if (tm.mode === "absolute") {
    payload.startTsUtc = tm.startIso;
    payload.endTsUtc = tm.endIso;
  }

  const result = await runClickhouseTriage(payload);

  const metricsJson = assertCanonicalMetricsJson(result.metricsJson);
  const localAtsSummary = normalizeAtsSummary(result.metricsJson?.atsSummary);
  if (localAtsSummary) metricsJson.atsSummary = localAtsSummary;

  const localPreviousAtsSummary = normalizeAtsSummary(
    result.metricsJson?.previousAtsSummary
  );
  if (localPreviousAtsSummary) metricsJson.previousAtsSummary = localPreviousAtsSummary;
  const compareMetrics = buildCompareMetrics(metricsJson);

  metricsJson.debug = {
    ...(metricsJson.debug || {}),
    hasProxyEnv: hasProxyEnv(),
    forcedLocal: true,
    timeMode: tm.mode,
    startTsUtc: tm.mode === "absolute" ? tm.startIso : null,
    endTsUtc: tm.mode === "absolute" ? tm.endIso : null,
    anchorToMaxTs: tm.mode === "absolute" ? false : metricsJson.debug?.anchorToMaxTs ?? undefined,
    sqlSource: "runner",
    partner: inputs.partner,
    service: inputs.service,
    region: inputs.region,
    pop: inputs.pop,
    contentType: inputs.contentType,
    uaFamily: inputs.uaFamily,
    windowMinutes: inputs.windowMinutes,
  };

  const sql = normalizeSqlForUi(result.sql ?? undefined);
  const scope = buildEvidenceScope(inputs, tm);

  const evidenceBundle = toEvidenceBundle(
    {
      ...scope,
      debug: inputs.debug,
    } as any,
    {
      ...result,
      metricsJson,
      sql,
    }
  );

  const drillResponse = await maybeExecuteDrill(inputs, evidenceBundle, metricsJson, sql, "local");
  if (drillResponse) return drillResponse;

  const agents = runAgents(evidenceBundle);
  const assessment = buildAssessment(evidenceBundle, agents);

  return okJson({
    ok: true,
    kind: "triage",
    summaryText: result.summaryText ?? result.summary ?? "",
    summary: result.summary ?? result.summaryText ?? "",
    metricsJson,
    compareMetrics,
    sql,
    swarm: {
      assessment,
      agents,
    },
    _mode: "local",
  });
}

function adaptLegacyProxyMetricsToCanonical(legacyMetrics: any, parsed?: any) {
  const totalRequests =
    legacyMetrics?.totalRequests != null
      ? numOrZero(legacyMetrics.totalRequests)
      : legacyMetrics?.total_requests != null
      ? numOrZero(legacyMetrics.total_requests)
      : 0;

  const error5xxCount =
    legacyMetrics?.error5xxCount != null
      ? numOrZero(legacyMetrics.error5xxCount)
      : legacyMetrics?.http_5xx != null
      ? numOrZero(legacyMetrics.http_5xx)
      : 0;

  const errorRatePct =
    legacyMetrics?.errorRatePct != null
      ? numOrZero(legacyMetrics.errorRatePct)
      : legacyMetrics?.error_rate_pct != null
      ? numOrZero(legacyMetrics.error_rate_pct)
      : totalRequests > 0
      ? (100 * error5xxCount) / totalRequests
      : 0;

  const successRatePct =
    legacyMetrics?.successRatePct != null && numOrZero(legacyMetrics.successRatePct) > 0
      ? numOrZero(legacyMetrics.successRatePct)
      : legacyMetrics?.success_rate_pct != null && numOrZero(legacyMetrics.success_rate_pct) > 0
      ? numOrZero(legacyMetrics.success_rate_pct)
      : 0;

  const out: any = {
    totalRequests,
    p50TtmsMs:
      legacyMetrics?.p50TtmsMs != null
        ? numOrNull(legacyMetrics.p50TtmsMs)
        : legacyMetrics?.p50_ms != null
        ? numOrNull(legacyMetrics.p50_ms)
        : null,
    p95TtmsMs:
      legacyMetrics?.p95TtmsMs != null
        ? numOrNull(legacyMetrics.p95TtmsMs)
        : legacyMetrics?.p95_ms != null
        ? numOrNull(legacyMetrics.p95_ms)
        : null,
    p99TtmsMs:
      legacyMetrics?.p99TtmsMs != null
        ? numOrNull(legacyMetrics.p99TtmsMs)
        : legacyMetrics?.p99_ms != null
        ? numOrNull(legacyMetrics.p99_ms)
        : null,
    cacheHitRate:
      legacyMetrics?.cacheHitRate != null
        ? numOrNull(legacyMetrics.cacheHitRate)
        : legacyMetrics?.cache_hit_rate != null
        ? numOrNull(legacyMetrics.cache_hit_rate)
        : null,
    crcErrorCount:
      legacyMetrics?.crcErrorCount != null
        ? numOrZero(legacyMetrics.crcErrorCount)
        : legacyMetrics?.crc_errors != null
        ? numOrZero(legacyMetrics.crc_errors)
        : 0,
    error5xxCount,
    errorRatePct,
    successRatePct,
    warnings: Array.isArray(legacyMetrics?.warnings) ? legacyMetrics.warnings : undefined,
    timeseries: normalizeTimeseries(legacyMetrics),
    debug:
      legacyMetrics?.debug && typeof legacyMetrics.debug === "object"
        ? legacyMetrics.debug
        : {},
  };

  const previousWindow = normalizePreviousWindow(legacyMetrics?.previousWindow);
  if (previousWindow) out.previousWindow = previousWindow;

  const regionBreakdown = pickRegionBreakdownFromProxy(parsed, legacyMetrics);
  if (regionBreakdown) out.regionBreakdown = regionBreakdown;

  const popBreakdown = pickPopBreakdownFromProxy(parsed, legacyMetrics);
  if (popBreakdown) out.popBreakdown = popBreakdown;

  const uaBreakdown = pickUaBreakdownFromProxy(parsed, legacyMetrics);
  if (uaBreakdown) out.uaBreakdown = uaBreakdown;

  const contentBreakdown = pickContentBreakdownFromProxy(parsed, legacyMetrics);
  if (contentBreakdown) out.contentBreakdown = contentBreakdown;

  const hostBreakdown = pickHostBreakdownFromProxy(parsed, legacyMetrics);
  if (hostBreakdown) out.hostBreakdown = hostBreakdown;

  return out;
}

async function safeAdaptProxyToUi(parsed: any, tm: TimeMode, scope: EvidenceScope, inputs: Inputs) {
  const ok = !!parsed?.ok;
  if (!ok) {
    return {
      ok: false,
      error: parsed?.error ? String(parsed.error) : "proxy returned ok=false",
      _mode: "proxy",
    };
  }

  const rawMetrics = parsed?.metricsJson ?? parsed?.metrics ?? null;

  const metricsJson = assertCanonicalMetricsJson(
    rawMetrics && typeof rawMetrics === "object"
      ? rawMetrics
      : adaptLegacyProxyMetricsToCanonical(rawMetrics || {}, parsed)
  );

  const compareMetrics = buildCompareMetrics(metricsJson);

  const regionBreakdown = pickRegionBreakdownFromProxy(parsed, rawMetrics);
  if (regionBreakdown) metricsJson.regionBreakdown = regionBreakdown;

  const popBreakdown = pickPopBreakdownFromProxy(parsed, rawMetrics);
  if (popBreakdown) metricsJson.popBreakdown = popBreakdown;

  const uaBreakdown = pickUaBreakdownFromProxy(parsed, rawMetrics);
  if (uaBreakdown) metricsJson.uaBreakdown = uaBreakdown;

  const contentBreakdown = pickContentBreakdownFromProxy(parsed, rawMetrics);
  if (contentBreakdown) metricsJson.contentBreakdown = contentBreakdown;

  const hostBreakdown = pickHostBreakdownFromProxy(parsed, rawMetrics);
  if (hostBreakdown) metricsJson.hostBreakdown = hostBreakdown;

  const atsSummary = pickAtsSummaryFromProxy(parsed, rawMetrics);
  if (atsSummary) metricsJson.atsSummary = atsSummary;

  const previousAtsSummary = pickPreviousAtsSummaryFromProxy(parsed, rawMetrics);
  if (previousAtsSummary) metricsJson.previousAtsSummary = previousAtsSummary;

  // status-by-dimension passthrough
  metricsJson.statusByRegion = Array.isArray(rawMetrics?.statusByRegion)
    ? rawMetrics.statusByRegion
    : [];
  metricsJson.statusByPop = Array.isArray(rawMetrics?.statusByPop)
    ? rawMetrics.statusByPop
    : [];
  metricsJson.statusByContentType = Array.isArray(rawMetrics?.statusByContentType)
    ? rawMetrics.statusByContentType
    : [];
  metricsJson.statusByUaFamily = Array.isArray(rawMetrics?.statusByUaFamily)
    ? rawMetrics.statusByUaFamily
    : [];
  metricsJson.statusByHost = Array.isArray(rawMetrics?.statusByHost)
    ? rawMetrics.statusByHost
    : [];

  metricsJson.debug = {
    ...(metricsJson.debug || {}),
    hasProxyEnv: true,
    forcedLocal: false,
    timeMode: tm.mode,
    startTsUtc: tm.mode === "absolute" ? tm.startIso : null,
    endTsUtc: tm.mode === "absolute" ? tm.endIso : null,
    anchorToMaxTs: tm.mode === "absolute" ? false : metricsJson.debug?.anchorToMaxTs ?? undefined,
    partner: scope.partner,
    service: scope.service,
    region: scope.region,
    pop: scope.pop,
    contentType: scope.contentType,
    uaFamily: scope.uaFamily,
    windowMinutes: scope.windowMinutes,
  };

  const sql =
    normalizeSqlForUi(parsed?.sql ?? undefined) ??
    buildPlannerSqlFallback(scope, tm);

  const effectiveSqlSource =
    metricsJson.debug?.sqlSource ??
    (parsed?.sql ? "request-sql" : "planner-fallback");

  metricsJson.debug = {
    ...(metricsJson.debug || {}),
    sqlSource: effectiveSqlSource,
  };

  const evidenceBundle = toEvidenceBundle(
    {
      ...scope,
      debug: false,
    } as any,
    {
      summary: parsed?.summary ?? parsed?.summaryText ?? "",
      summaryText: parsed?.summaryText ?? parsed?.summary ?? "",
      metricsJson,
      sql,
    }
  );

  const drillResponse = await maybeExecuteDrill(inputs, evidenceBundle, metricsJson, sql, "proxy");
  if (drillResponse) {
    return {
      ok: true,
      passthrough: true,
      response: drillResponse,
    };
  }

  const agents = runAgents(evidenceBundle);
  const assessment = buildAssessment(evidenceBundle, agents);

  return {
    ok: true,
    summaryText: parsed?.summaryText ?? parsed?.summary ?? "",
    summary: parsed?.summary ?? parsed?.summaryText ?? "",
    metricsJson,
    compareMetrics,
    sql,
    swarm: {
      assessment,
      agents,
    },
    inputs: parsed?.inputs ?? undefined,
    _mode: "proxy",
    kind: "triage",
  };
}

export async function POST(req: Request) {
  try {
    const inputs = await parseRequest(req);

    if (!inputs.partner) {
      return badRequest("partner is required", { allowedPartners: CANON.partners });
    }
    if (!isCanonPartner(inputs.partner)) {
      return badRequest(`invalid partner: ${inputs.partner}`, { allowedPartners: CANON.partners });
    }

    if (!inputs.service) {
      return badRequest("service is required", { allowedServices: CANON.services });
    }
    if (inputs.service === "all") {
      return badRequest(`service cannot be "all"`, { allowedServices: CANON.services });
    }
    if (!isCanonService(inputs.service)) {
      return badRequest(`invalid service: ${inputs.service}`, { allowedServices: CANON.services });
    }

    if (!isAllOrOneOf(inputs.region, CANON.regions as readonly string[])) {
      return badRequest(`invalid region: ${inputs.region}`, {
        allowedRegions: ["all", ...CANON.regions],
      });
    }

    if (!isAllOrOneOf(inputs.pop, CANON.pops as readonly string[])) {
      return badRequest(`invalid pop: ${inputs.pop}`, { allowedPops: ["all", ...CANON.pops] });
    }

    if (!isAllOrOneOf(inputs.contentType, CANON.contentTypes as readonly string[])) {
      return badRequest(`invalid contentType: ${inputs.contentType}`, {
        allowedContentTypes: ["all", ...CANON.contentTypes],
      });
    }

    if (!isAllOrOneOf(inputs.uaFamily, CANON.uaFamilies as readonly string[])) {
      return badRequest(`invalid uaFamily: ${inputs.uaFamily}`, {
        allowedUaFamilies: ["all", ...CANON.uaFamilies],
      });
    }

    let tm: TimeMode;
    try {
      tm = computeTimeMode(inputs);
    } catch (err: any) {
      return badRequest(err?.message || "invalid time range");
    }

    const scope = buildEvidenceScope(inputs, tm);

    if (!hasProxyEnv()) {
      return await runLocal(inputs, tm);
    }

    const triageUrl = proxyTriageUrl();

    const builtSql = buildClickhouseSql({
      partner: inputs.partner,
      service: inputs.service,
      region: inputs.region,
      pop: inputs.pop,
      contentType: inputs.contentType,
      uaFamily: inputs.uaFamily,
      windowMinutes: inputs.windowMinutes,
      startTsUtc: tm.mode === "absolute" ? tm.startIso : undefined,
      endTsUtc: tm.mode === "absolute" ? tm.endIso : undefined,
      anchorToMaxTs: tm.mode === "relative",
    } as any);

    const upstreamBody: any = {
      partner: inputs.partner,
      service: inputs.service,
      region: inputs.region,
      pop: inputs.pop,
      windowMinutes: inputs.windowMinutes,
      debug: inputs.debug,
      contentType: inputs.contentType,
      uaFamily: inputs.uaFamily,
      sql: {
        queries: Array.isArray(builtSql?.queries)
          ? builtSql.queries.map((q: any) => String(q))
          : [],
        params:
          builtSql?.params && typeof builtSql.params === "object"
            ? builtSql.params
            : {},
      },
    };

    if (tm.mode === "absolute") {
      upstreamBody.startTsUtc = tm.startIso;
      upstreamBody.endTsUtc = tm.endIso;
    }

    const upstream = await fetch(triageUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(process.env.CACHEY_PROXY_TOKEN
          ? { "x-cachey-token": process.env.CACHEY_PROXY_TOKEN }
          : {}),
      },
      body: JSON.stringify(upstreamBody),
    });

    const text = await upstream.text().catch(() => "");
    const parsed = (() => {
      try {
        return text ? JSON.parse(text) : null;
      } catch {
        return null;
      }
    })();

    if (!upstream.ok) {
      const msg =
        parsed && typeof parsed === "object" && (parsed as any)?.error
          ? String((parsed as any).error)
          : text
          ? `proxy triage failed (HTTP ${upstream.status}): ${text.slice(0, 220)}`
          : `proxy triage failed (HTTP ${upstream.status})`;

      return NextResponse.json(
        {
          ok: false,
          error: msg,
          upstreamUrl: triageUrl,
          metricsJson: canonicalStubMetricsJson({
            hasProxyEnv: true,
            forcedLocal: false,
            upstreamStatus: upstream.status,
            timeMode: tm.mode,
            startTsUtc: tm.mode === "absolute" ? tm.startIso : null,
            endTsUtc: tm.mode === "absolute" ? tm.endIso : null,
            anchorToMaxTs: tm.mode === "absolute" ? false : undefined,
            sqlSource: "none",
            partner: scope.partner,
            service: scope.service,
            region: scope.region,
            pop: scope.pop,
            contentType: scope.contentType,
            uaFamily: scope.uaFamily,
            windowMinutes: scope.windowMinutes,
          }),
          _mode: "proxy",
        },
        { status: 502 }
      );
    }

    const adapted = await safeAdaptProxyToUi(parsed, tm, scope, inputs);

    if (!adapted.ok) {
      return NextResponse.json(
        {
          ok: false,
          error: (adapted as any).error || "proxy returned ok=false",
          upstreamUrl: triageUrl,
          upstreamParsed: parsed,
          metricsJson: canonicalStubMetricsJson({
            hasProxyEnv: true,
            forcedLocal: false,
            upstreamStatus: upstream.status,
            timeMode: tm.mode,
            startTsUtc: tm.mode === "absolute" ? tm.startIso : null,
            endTsUtc: tm.mode === "absolute" ? tm.endIso : null,
            anchorToMaxTs: tm.mode === "absolute" ? false : undefined,
            sqlSource: "none",
            partner: scope.partner,
            service: scope.service,
            region: scope.region,
            pop: scope.pop,
            contentType: scope.contentType,
            uaFamily: scope.uaFamily,
            windowMinutes: scope.windowMinutes,
          }),
          _mode: "proxy",
        },
        { status: 502 }
      );
    }

    if ((adapted as any).passthrough && (adapted as any).response) {
      return (adapted as any).response;
    }

    return okJson(adapted);
  } catch (e: any) {
    console.error("TRIAGE_ROUTE_FATAL", e);
    return NextResponse.json({ ok: false, error: e?.message || "triage failed" }, { status: 500 });
  }
}
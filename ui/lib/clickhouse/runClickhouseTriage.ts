// lib/clickhouse/runClickhouseTriage.ts

import { buildClickhouseSql } from "./sqlBuilder";
import { runMockClickhouseTriage } from "./runMockClickhouseTriage";
import { CANON } from "@/lib/schema/canonical";

export type ClickhouseTriageInputs = {
  partner: string;

  // Core scope filters (service REQUIRED; no "all")
  service: string; // canon only (live|vod|dvr|eas|live_ott|app_backend)
  region: string; // all|<canon>
  pop: string; // all|<canon>

  // Generator schema dims
  contentType: string; // all|manifest|segment|api
  uaFamily: string; // all|stb|mobile|web|smart_tv|console

  // time range (choose one)
  windowMinutes: number; // used when absolute range not provided
  startTsUtc?: string | null; // ISO string
  endTsUtc?: string | null; // ISO string

  debug: boolean;
};

// Canonical SQL shape (include params so runner can execute later)
export type SqlPayload = { queries: string[]; params?: Record<string, any> };

export type ClickhouseTriageResult = {
  summary: string;
  metricsJson: any;
  evidence?: any;
  sql?: SqlPayload;

  // Legacy compatibility
  summaryText?: string;
};

type CanonicalRunnerScope = {
  partner: string;
  service: string;
  region: string;
  pop: string;
  contentType: string;
  uaFamily: string;
  windowMinutes: number;
};

function isCanon(x: string, allowed: readonly string[]) {
  return allowed.includes(x);
}

function asString(x: unknown): string | null {
  if (typeof x === "string" && x.trim()) return x.trim();
  return null;
}

function parseIsoOrNull(s: string | null | undefined): string | null {
  const raw = typeof s === "string" ? s.trim() : "";
  if (!raw) return null;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

function safeNumberOrNull(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function safeNumber(v: unknown, fallback = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function computeTimeMode(
  inputs: ClickhouseTriageInputs
):
  | { mode: "absolute"; startIso: string; endIso: string }
  | { mode: "relative" } {
  const startIso = parseIsoOrNull(inputs.startTsUtc ?? null);
  const endIso = parseIsoOrNull(inputs.endTsUtc ?? null);

  if (!startIso && !endIso) return { mode: "relative" };

  if (!startIso || !endIso) {
    throw new Error(
      "runClickhouseTriage: startTsUtc and endTsUtc must both be provided for absolute range"
    );
  }

  const sMs = new Date(startIso).getTime();
  const eMs = new Date(endIso).getTime();
  if (!Number.isFinite(sMs) || !Number.isFinite(eMs) || eMs <= sMs) {
    throw new Error(
      "runClickhouseTriage: invalid absolute range (endTsUtc must be after startTsUtc)"
    );
  }

  return { mode: "absolute", startIso, endIso };
}

function buildCanonicalRunnerScope(
  inputs: ClickhouseTriageInputs
): CanonicalRunnerScope {
  const partner = String(inputs.partner || "").trim().toLowerCase();
  const service = String(inputs.service || "").trim().toLowerCase();
  const region = String(inputs.region || "all").trim().toLowerCase();
  const pop = String(inputs.pop || "all").trim().toLowerCase();
  const contentType = String(inputs.contentType || "all").trim().toLowerCase();
  const uaFamily = String(inputs.uaFamily || "all").trim().toLowerCase();

  if (!partner || !isCanon(partner, CANON.partners as readonly string[])) {
    throw new Error(`runClickhouseTriage: invalid partner '${inputs.partner}'`);
  }
  if (
    !service ||
    service === "all" ||
    !isCanon(service, CANON.services as readonly string[])
  ) {
    throw new Error(`runClickhouseTriage: invalid service '${inputs.service}'`);
  }
  if (region !== "all" && !isCanon(region, CANON.regions as readonly string[])) {
    throw new Error(`runClickhouseTriage: invalid region '${inputs.region}'`);
  }
  if (pop !== "all" && !isCanon(pop, CANON.pops as readonly string[])) {
    throw new Error(`runClickhouseTriage: invalid pop '${inputs.pop}'`);
  }
  if (
    contentType !== "all" &&
    !isCanon(contentType, CANON.contentTypes as readonly string[])
  ) {
    throw new Error(
      `runClickhouseTriage: invalid contentType '${inputs.contentType}'`
    );
  }
  if (
    uaFamily !== "all" &&
    !isCanon(uaFamily, CANON.uaFamilies as readonly string[])
  ) {
    throw new Error(`runClickhouseTriage: invalid uaFamily '${inputs.uaFamily}'`);
  }

  const win = Number(inputs.windowMinutes);
  if (!Number.isFinite(win) || win <= 0) {
    throw new Error(
      `runClickhouseTriage: invalid windowMinutes '${inputs.windowMinutes}'`
    );
  }

  return {
    partner,
    service,
    region,
    pop,
    contentType,
    uaFamily,
    windowMinutes: win,
  };
}

function normalizeBreakdownKey(v: unknown): string | null {
  const s = String(v ?? "").trim().toLowerCase();
  return s ? s : null;
}

function readUiOrSqlNumber(
  row: Record<string, any>,
  uiKey: string,
  sqlKey: string
): number {
  if (row?.[uiKey] != null) return safeNumber(row[uiKey], 0);
  if (row?.[sqlKey] != null) return safeNumber(row[sqlKey], 0);
  return 0;
}

function readUiOrSqlNullableNumber(
  row: Record<string, any>,
  uiKey: string,
  sqlKey: string
): number | null {
  if (row?.[uiKey] != null) return safeNumberOrNull(row[uiKey]);
  if (row?.[sqlKey] != null) return safeNumberOrNull(row[sqlKey]);
  return null;
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
    cacheHitPct: readUiOrSqlNullableNumber(row, "cacheHitPct", "cache_hit_rate"),
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
    cacheHitPct: readUiOrSqlNullableNumber(row, "cacheHitPct", "cache_hit_rate"),
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
    cacheHitPct: readUiOrSqlNullableNumber(row, "cacheHitPct", "cache_hit_rate"),
  };
}

function normalizeContentBreakdownRow(row: any) {
  const contentType = normalizeBreakdownKey(
    row?.contentType ?? row?.content_type
  );
  if (!contentType) return null;

  return {
    contentType,
    totalRequests: readUiOrSqlNumber(row, "totalRequests", "total_requests"),
    error5xxCount: readUiOrSqlNumber(row, "error5xxCount", "error_5xx_count"),
    errorRatePct: readUiOrSqlNumber(row, "errorRatePct", "error_rate_pct"),
    p95TtmsMs: readUiOrSqlNullableNumber(row, "p95TtmsMs", "p95_ttms_ms"),
    cacheHitPct: readUiOrSqlNullableNumber(row, "cacheHitPct", "cache_hit_rate"),
  };
}

function sortBreakdownRows(a: any, b: any) {
  if (b.error5xxCount !== a.error5xxCount) {
    return b.error5xxCount - a.error5xxCount;
  }
  if ((b.p95TtmsMs ?? -1) !== (a.p95TtmsMs ?? -1)) {
    return (b.p95TtmsMs ?? -1) - (a.p95TtmsMs ?? -1);
  }
  return b.totalRequests - a.totalRequests;
}

function normalizeRegionBreakdown(rows: unknown): any[] | undefined {
  if (!Array.isArray(rows)) return undefined;

  const out = rows
    .map((row) => normalizeRegionBreakdownRow(row))
    .filter(Boolean) as any[];

  if (!out.length) return undefined;

  out.sort(sortBreakdownRows);
  return out;
}

function normalizePopBreakdown(rows: unknown): any[] | undefined {
  if (!Array.isArray(rows)) return undefined;

  const out = rows
    .map((row) => normalizePopBreakdownRow(row))
    .filter(Boolean) as any[];

  if (!out.length) return undefined;

  out.sort(sortBreakdownRows);
  return out;
}

function normalizeUaBreakdown(rows: unknown): any[] | undefined {
  if (!Array.isArray(rows)) return undefined;

  const out = rows
    .map((row) => normalizeUaBreakdownRow(row))
    .filter(Boolean) as any[];

  if (!out.length) return undefined;

  out.sort(sortBreakdownRows);
  return out;
}

function normalizeContentBreakdown(rows: unknown): any[] | undefined {
  if (!Array.isArray(rows)) return undefined;

  const out = rows
    .map((row) => normalizeContentBreakdownRow(row))
    .filter(Boolean) as any[];

  if (!out.length) return undefined;

  out.sort(sortBreakdownRows);
  return out;
}

function pickRegionBreakdown(metricsJson: any): any[] | undefined {
  return (
    normalizeRegionBreakdown(metricsJson?.regionBreakdown) ||
    normalizeRegionBreakdown(metricsJson?.evidenceBundle?.regionBreakdown) ||
    normalizeRegionBreakdown(metricsJson?.evidence?.regionBreakdown) ||
    undefined
  );
}

function pickPopBreakdown(metricsJson: any): any[] | undefined {
  return (
    normalizePopBreakdown(metricsJson?.popBreakdown) ||
    normalizePopBreakdown(metricsJson?.evidenceBundle?.popBreakdown) ||
    normalizePopBreakdown(metricsJson?.evidence?.popBreakdown) ||
    undefined
  );
}

function pickUaBreakdown(metricsJson: any): any[] | undefined {
  return (
    normalizeUaBreakdown(metricsJson?.uaBreakdown) ||
    normalizeUaBreakdown(metricsJson?.evidenceBundle?.uaBreakdown) ||
    normalizeUaBreakdown(metricsJson?.evidence?.uaBreakdown) ||
    undefined
  );
}

function pickContentBreakdown(metricsJson: any): any[] | undefined {
  return (
    normalizeContentBreakdown(metricsJson?.contentBreakdown) ||
    normalizeContentBreakdown(metricsJson?.evidenceBundle?.contentBreakdown) ||
    normalizeContentBreakdown(metricsJson?.evidence?.contentBreakdown) ||
    undefined
  );
}

function deriveSuccessRatePctFromStatusCounts(
  statusCountsByCode: Record<string, number> | undefined,
  totalRequests: number
): number {
  if (!statusCountsByCode || !totalRequests) return 0;
  const ok200 = safeNumber(statusCountsByCode["200"], 0);
  const ok206 = safeNumber(statusCountsByCode["206"], 0);
  const ok304 = safeNumber(statusCountsByCode["304"], 0);
  return totalRequests > 0 ? (100 * (ok200 + ok206 + ok304)) / totalRequests : 0;
}

function normalizeTimeseriesPoint(row: any) {
  const ts = asString(row?.ts) ?? asString(row?.bucket);
  if (!ts) return null;

  const totalRequests =
    row?.totalRequests != null
      ? safeNumber(row.totalRequests, 0)
      : row?.total_requests != null
      ? safeNumber(row.total_requests, 0)
      : 0;

  const error5xxCount =
    row?.error5xxCount != null
      ? safeNumber(row.error5xxCount, 0)
      : row?.http_5xx != null
      ? safeNumber(row.http_5xx, 0)
      : 0;

  const errorRatePct =
    row?.errorRatePct != null
      ? safeNumber(row.errorRatePct, 0)
      : row?.error_rate_pct != null
      ? safeNumber(row.error_rate_pct, 0)
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
    row?.successRatePct != null && safeNumber(row.successRatePct, 0) > 0
      ? safeNumber(row.successRatePct, 0)
      : row?.success_rate_pct != null && safeNumber(row.success_rate_pct, 0) > 0
      ? safeNumber(row.success_rate_pct, 0)
      : deriveSuccessRatePctFromStatusCounts(statusCountsByCode, totalRequests);

  return {
    ts,
    totalRequests,
    error5xxCount,
    errorRatePct,
    successRatePct,
    p95TtmsMs:
      row?.p95TtmsMs != null
        ? safeNumberOrNull(row.p95TtmsMs)
        : row?.p95_ms != null
        ? safeNumberOrNull(row.p95_ms)
        : null,
    p99TtmsMs:
      row?.p99TtmsMs != null
        ? safeNumberOrNull(row.p99TtmsMs)
        : row?.p99_ms != null
        ? safeNumberOrNull(row.p99_ms)
        : null,
    cacheHitRate:
      row?.cacheHitRate != null
        ? safeNumberOrNull(row.cacheHitRate)
        : row?.cache_hit_rate != null
        ? safeNumberOrNull(row.cache_hit_rate)
        : null,
    crcErrorCount:
      row?.crcErrorCount != null
        ? safeNumber(row.crcErrorCount, 0)
        : row?.crc_errors != null
        ? safeNumber(row.crc_errors, 0)
        : 0,
    statusCountsByCode,
  };
}

function normalizeHostSeriesRow(row: any) {
  const host = asString(row?.host);
  if (!host) return null;

  return {
    host,
    totalRequests: readUiOrSqlNumber(row, "totalRequests", "total_requests"),
    error5xxCount:
      row?.error5xxCount != null
        ? safeNumber(row.error5xxCount, 0)
        : row?.error_5xx_count != null
        ? safeNumber(row.error_5xx_count, 0)
        : 0,
    crcErrorCount:
      row?.crcErrorCount != null
        ? safeNumber(row.crcErrorCount, 0)
        : row?.crc_error_count != null
        ? safeNumber(row.crc_error_count, 0)
        : row?.crc_errors != null
        ? safeNumber(row.crc_errors, 0)
        : 0,
    errorRatePct: readUiOrSqlNumber(row, "errorRatePct", "error_rate_pct"),
    p95TtmsMs:
      row?.p95TtmsMs != null
        ? safeNumberOrNull(row.p95TtmsMs)
        : row?.p95_ttms_ms != null
        ? safeNumberOrNull(row.p95_ttms_ms)
        : null,
    p99TtmsMs:
      row?.p99TtmsMs != null
        ? safeNumberOrNull(row.p99TtmsMs)
        : row?.p99TtmsMs != null
        ? safeNumberOrNull(row.p99TtmsMs)
        : row?.p99_ttms_ms != null
        ? safeNumberOrNull(row.p99_ttms_ms)
        : row?.p99_ms != null
        ? safeNumberOrNull(row.p99_ms)
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
        ? safeNumber(row.crcErrorCount, 0)
        : row?.crc_errors != null
        ? safeNumber(row.crc_errors, 0)
        : 0,
  };
}

function normalizeTimeseries(metricsJson: any, fallbackBucketSeconds: number | null) {
  const t = metricsJson?.timeseries;
  if (!t || typeof t !== "object") {
    return {
      bucketSeconds: fallbackBucketSeconds,
      startTs: null,
      endTs: null,
      points: [],
    };
  }

  const rawPoints = Array.isArray(t.points) ? t.points : [];
  const points = rawPoints
    .map((row: any) => normalizeTimeseriesPoint(row))
    .filter(Boolean);

  const hostSeries = Array.isArray(t.hostSeries)
    ? t.hostSeries
        .map((row: any) => normalizeHostSeriesRow(row))
        .filter(Boolean)
    : [];

  const crcSeries = Array.isArray(t.crcSeries)
    ? t.crcSeries
        .map((row: any) => normalizeCrcSeriesRow(row))
        .filter(Boolean)
    : [];

  const startTs =
    asString(t.startTs) ??
    (points.length ? asString(points[0]?.ts) : null) ??
    null;

  const endTs =
    asString(t.endTs) ??
    (points.length ? asString(points[points.length - 1]?.ts) : null) ??
    null;

  return {
    bucketSeconds:
      t.bucketSeconds != null ? safeNumber(t.bucketSeconds, 0) : fallbackBucketSeconds,
    startTs,
    endTs,
    points,
    statusCodeSeries: Array.isArray(t.statusCodeSeries)
      ? t.statusCodeSeries.map(String)
      : undefined,
    hostSeries,
    crcSeries,
  };
}

function normalizeAggregateMetrics(source: any) {
  if (!source || typeof source !== "object") return null;

  const totalRequests =
    source.totalRequests != null
      ? safeNumber(source.totalRequests, 0)
      : source.total_requests != null
      ? safeNumber(source.total_requests, 0)
      : null;

  const error5xxCount =
    source.error5xxCount != null
      ? safeNumber(source.error5xxCount, 0)
      : source.http_5xx != null
      ? safeNumber(source.http_5xx, 0)
      : null;

  const errorRatePct =
    source.errorRatePct != null
      ? safeNumber(source.errorRatePct, 0)
      : source.error_rate_pct != null
      ? safeNumber(source.error_rate_pct, 0)
      : totalRequests != null && error5xxCount != null && totalRequests > 0
      ? (100 * error5xxCount) / totalRequests
      : 0;

  const successRatePct =
    source.successRatePct != null
      ? safeNumber(source.successRatePct, 0)
      : source.success_rate_pct != null
      ? safeNumber(source.success_rate_pct, 0)
      : 0;

  return {
    totalRequests: totalRequests ?? 0,
    p50TtmsMs:
      source.p50TtmsMs != null
        ? safeNumberOrNull(source.p50TtmsMs)
        : source.p50_ms != null
        ? safeNumberOrNull(source.p50_ms)
        : null,
    p95TtmsMs:
      source.p95TtmsMs != null
        ? safeNumberOrNull(source.p95TtmsMs)
        : source.p95_ms != null
        ? safeNumberOrNull(source.p95_ms)
        : null,
    p99TtmsMs:
      source.p99TtmsMs != null
        ? safeNumberOrNull(source.p99TtmsMs)
        : source.p99_ms != null
        ? safeNumberOrNull(source.p99_ms)
        : null,
    error5xxCount: error5xxCount ?? 0,
    errorRatePct,
    successRatePct,
    cacheHitPct:
      source.cacheHitPct != null
        ? safeNumber(source.cacheHitPct, 0)
        : source.cache_hit_rate != null
        ? safeNumber(source.cache_hit_rate, 0)
        : null,
    cacheMissPct:
      source.cacheMissPct != null ? safeNumber(source.cacheMissPct, 0) : null,
    crcErrorCount:
      source.crcErrorCount != null
        ? safeNumber(source.crcErrorCount, 0)
        : source.crc_errors != null
        ? safeNumber(source.crc_errors, 0)
        : 0,
    windowStart:
      asString(source.windowStart) ??
      asString(source.window_start) ??
      asString(source.startTs) ??
      null,
    windowEnd:
      asString(source.windowEnd) ??
      asString(source.window_end) ??
      asString(source.endTs) ??
      null,
  };
}

function pickPreviousWindowCandidate(metricsJson: any): any {
  return (
    metricsJson?.previousWindow ??
    metricsJson?.previous_window ??
    metricsJson?.compare?.previous ??
    metricsJson?.compare?.previousWindow ??
    metricsJson?.previous ??
    null
  );
}

function assertCanonicalMetrics(metricsJson: any) {
  if (!metricsJson || typeof metricsJson !== "object") {
    throw new Error("runClickhouseTriage: metricsJson missing");
  }

  const requiredTopLevel =
    metricsJson.totalRequests != null ||
    metricsJson.total_requests != null ||
    metricsJson.error5xxCount != null ||
    metricsJson.http_5xx != null ||
    metricsJson.p95TtmsMs != null ||
    metricsJson.p95_ms != null;

  if (!requiredTopLevel) {
    throw new Error("runClickhouseTriage: non-canonical metricsJson");
  }

  const debugIn = metricsJson.debug;
  const debug = debugIn && typeof debugIn === "object" ? debugIn : {};

  const base = normalizeAggregateMetrics(metricsJson);
  const timeseries = normalizeTimeseries(
    metricsJson,
    debug?.bucketSeconds != null ? safeNumber(debug.bucketSeconds, 0) : null
  );

  const tr = metricsJson.timeRangeUTC;
  const start =
    (tr && typeof tr === "object" && asString((tr as any).start)) ||
    asString(timeseries.startTs);
  const end =
    (tr && typeof tr === "object" && asString((tr as any).end)) ||
    asString(timeseries.endTs);

  const timeRangeUTC = start && end ? { start, end } : null;

  const out: any = {
    totalRequests: base?.totalRequests ?? 0,
    p50TtmsMs: base?.p50TtmsMs ?? null,
    p95TtmsMs: base?.p95TtmsMs ?? null,
    p99TtmsMs: base?.p99TtmsMs ?? null,
    error5xxCount: base?.error5xxCount ?? 0,
    errorRatePct: base?.errorRatePct ?? 0,
    successRatePct: base?.successRatePct ?? 0,
    timeseries,
    timeRangeUTC,
    debug,
  };

  if (base?.cacheHitPct != null) out.cacheHitPct = base.cacheHitPct;
  if (base?.cacheMissPct != null) out.cacheMissPct = base.cacheMissPct;
  if (base?.crcErrorCount != null) out.crcErrorCount = base.crcErrorCount;

  if (Array.isArray(metricsJson.statusCounts)) out.statusCounts = metricsJson.statusCounts;
  if (Array.isArray(metricsJson.topCrcClass)) out.topCrcClass = metricsJson.topCrcClass;
  if (Array.isArray(metricsJson.topErrorCrc)) out.topErrorCrc = metricsJson.topErrorCrc;

  const regionBreakdown = pickRegionBreakdown(metricsJson);
  if (regionBreakdown) out.regionBreakdown = regionBreakdown;

  const popBreakdown = pickPopBreakdown(metricsJson);
  if (popBreakdown) out.popBreakdown = popBreakdown;

  const uaBreakdown = pickUaBreakdown(metricsJson);
  if (uaBreakdown) out.uaBreakdown = uaBreakdown;

  const contentBreakdown = pickContentBreakdown(metricsJson);
  if (contentBreakdown) out.contentBreakdown = contentBreakdown;

  if (metricsJson.available && typeof metricsJson.available === "object") {
    out.available = metricsJson.available;
  }
  if (Array.isArray(metricsJson.warnings)) out.warnings = metricsJson.warnings;

  const previousWindowRaw = pickPreviousWindowCandidate(metricsJson);
  if (previousWindowRaw && typeof previousWindowRaw === "object") {
    const previousBase = normalizeAggregateMetrics(previousWindowRaw);
    const previousTimeseries = normalizeTimeseries(
      previousWindowRaw,
      debug?.bucketSeconds != null ? safeNumber(debug.bucketSeconds, 0) : null
    );

    out.previousWindow = {
      totalRequests: previousBase?.totalRequests ?? 0,
      p50TtmsMs: previousBase?.p50TtmsMs ?? null,
      p95TtmsMs: previousBase?.p95TtmsMs ?? null,
      p99TtmsMs: previousBase?.p99TtmsMs ?? null,
      error5xxCount: previousBase?.error5xxCount ?? 0,
      errorRatePct: previousBase?.errorRatePct ?? 0,
      successRatePct: previousBase?.successRatePct ?? 0,
      cacheHitPct: previousBase?.cacheHitPct ?? null,
      cacheMissPct: previousBase?.cacheMissPct ?? null,
      crcErrorCount: previousBase?.crcErrorCount ?? 0,
      timeRangeUTC:
        previousBase?.windowStart && previousBase?.windowEnd
          ? { start: previousBase.windowStart, end: previousBase.windowEnd }
          : null,
      timeseries: previousTimeseries,
    };
  }

  return out;
}

export async function runClickhouseTriage(
  inputs: ClickhouseTriageInputs
): Promise<ClickhouseTriageResult> {
  const scope = buildCanonicalRunnerScope(inputs);

  const tm = computeTimeMode(inputs);

  const anchorToMaxTs = tm.mode === "relative";

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
    anchorToMaxTs,
  });

  const raw = await runMockClickhouseTriage({
    ...inputs,
    partner: scope.partner,
    service: scope.service,
    region: scope.region,
    pop: scope.pop,
    contentType: scope.contentType,
    uaFamily: scope.uaFamily,
    windowMinutes: scope.windowMinutes,
    startTsUtc: tm.mode === "absolute" ? tm.startIso : null,
    endTsUtc: tm.mode === "absolute" ? tm.endIso : null,
    tableUsed: built.meta.tableUsed,
    bucketSeconds: built.meta.bucketSeconds,
    anchorToMaxTs,
  } as any);

  const summary = String(raw?.summary ?? raw?.summaryText ?? "");
  const evidence = raw?.evidence ?? undefined;

  const baseMetrics = raw?.metricsJson ?? raw ?? {};
  const metricsJson = assertCanonicalMetrics(baseMetrics);

  metricsJson.timeseries = metricsJson.timeseries || {
    bucketSeconds: null,
    startTs: null,
    endTs: null,
    points: [],
  };
  metricsJson.timeseries.bucketSeconds = built.meta.bucketSeconds;

  if (tm.mode === "absolute") {
    metricsJson.timeseries.startTs = tm.startIso;
    metricsJson.timeseries.endTs = tm.endIso;
    metricsJson.timeRangeUTC = { start: tm.startIso, end: tm.endIso };
  } else {
    if (!metricsJson.timeRangeUTC) {
      const s = asString(metricsJson.timeseries?.startTs);
      const e = asString(metricsJson.timeseries?.endTs);
      if (s && e) metricsJson.timeRangeUTC = { start: s, end: e };
    }
  }

  if (metricsJson.previousWindow?.timeseries) {
    metricsJson.previousWindow.timeseries.bucketSeconds = built.meta.bucketSeconds;
  }

  metricsJson.debug = {
    ...(metricsJson.debug || {}),
    __runnerVersion: "runclickhouse-vSTRICT-012",
    partner: scope.partner,
    service: scope.service,
    region: scope.region,
    pop: scope.pop,
    contentType: scope.contentType,
    uaFamily: scope.uaFamily,
    timeMode: tm.mode,
    windowMinutes: scope.windowMinutes,
    startTsUtc: tm.mode === "absolute" ? tm.startIso : null,
    endTsUtc: tm.mode === "absolute" ? tm.endIso : null,
    anchorToMaxTs,
    tableUsed: built.meta.tableUsed,
    bucketSeconds: built.meta.bucketSeconds,
    queryCount: built.queries.length,
    hasCompareQueries: built.queries.length >= 9,
    hasStatusOverTimeQueries: built.queries.length >= 11,
    hasCrcOverTimeQueries: built.queries.length >= 13,
    hasHostQueries: built.queries.length >= 14,
  };

  const anchorLabel = anchorToMaxTs ? "max(ts)" : "absolute";
  const p95ForSummary = safeNumberOrNull(metricsJson.p95TtmsMs);
  const p95Label = p95ForSummary == null ? "n/a" : `${Math.round(p95ForSummary)}ms`;

  const rangeLabel =
    tm.mode === "absolute"
      ? `range=${tm.startIso}→${tm.endIso} UTC`
      : `win=${scope.windowMinutes}m anchor=max(ts)`;

  const compareSuffix = metricsJson.previousWindow
    ? ` prev_requests=${Number(metricsJson.previousWindow.totalRequests).toLocaleString()} prev_p95=${
        metricsJson.previousWindow.p95TtmsMs == null
          ? "n/a"
          : `${Math.round(Number(metricsJson.previousWindow.p95TtmsMs))}ms`
      } prev_5xx=${Number(metricsJson.previousWindow.error5xxCount).toLocaleString()}`
    : "";

  const finalSummary =
    summary ||
    `Triage: partner=${scope.partner} service=${scope.service} region=${scope.region} pop=${scope.pop} ${rangeLabel} ct=${scope.contentType} ua=${scope.uaFamily}\n` +
      `table=${built.meta.tableUsed} bucket=${built.meta.bucketSeconds}s anchor=${anchorLabel}\n` +
      `requests=${Number(metricsJson.totalRequests).toLocaleString()} p95=${p95Label} 5xx=${Number(
        metricsJson.error5xxCount
      ).toLocaleString()} (${Number(metricsJson.errorRatePct).toFixed(2)}%)${compareSuffix}`;

  return {
    summary: finalSummary,
    summaryText: finalSummary,
    metricsJson,
    evidence,
    sql: { queries: built.queries, params: built.params },
  };
}
// ui/app/api/triage/route.ts
import { NextResponse } from "next/server";
import { CANON } from "@/lib/schema/canonical";
import { runClickhouseTriage } from "@/lib/clickhouse/runClickhouseTriage";
import { buildClickhouseSql } from "@/lib/clickhouse/sqlBuilder";
import { toEvidenceBundle } from "@/lib/triage/toEvidenceBundle";
import { runAgents } from "@/lib/triage/runAgents";
import { buildAssessment } from "@/lib/triage/buildAssessment";

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

function isCanonPartner(x: string) {
  return (CANON.partners as readonly string[]).includes(x);
}

function isCanonService(x: string) {
  return (CANON.services as readonly string[]).includes(x);
}

function isAllOrOneOf(x: string, allowed: readonly string[]) {
  return x === "all" || allowed.includes(x);
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

function normalizeBreakdownNumber(v: unknown, fallback = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeRegionBreakdownRow(row: any) {
  const region = normalizeBreakdownKey(row?.region);
  if (!region) return null;

  return {
    region,
    totalRequests: normalizeBreakdownNumber(
      row?.totalRequests ?? row?.total_requests ?? row?.requests
    ),
    error5xxCount: normalizeBreakdownNumber(
      row?.error5xxCount ?? row?.error_5xx_count ?? row?.http_5xx ?? row?.http5xx
    ),
    errorRatePct: normalizeBreakdownNumber(
      row?.errorRatePct ?? row?.error_rate_pct ?? row?.err_rate_pct
    ),
    p95TtmsMs: numOrNull(row?.p95TtmsMs ?? row?.p95_ttms_ms ?? row?.p95_ms),
    cacheHitPct: numOrNull(
      row?.cacheHitPct ?? row?.cache_hit_pct ?? row?.cache_hit_rate ?? row?.cacheHitRate
    ),
  };
}

function normalizePopBreakdownRow(row: any) {
  const pop = normalizeBreakdownKey(row?.pop);
  if (!pop) return null;

  return {
    pop,
    totalRequests: normalizeBreakdownNumber(
      row?.totalRequests ?? row?.total_requests ?? row?.requests
    ),
    error5xxCount: normalizeBreakdownNumber(
      row?.error5xxCount ?? row?.error_5xx_count ?? row?.http_5xx ?? row?.http5xx
    ),
    errorRatePct: normalizeBreakdownNumber(
      row?.errorRatePct ?? row?.error_rate_pct ?? row?.err_rate_pct
    ),
    p95TtmsMs: numOrNull(row?.p95TtmsMs ?? row?.p95_ttms_ms ?? row?.p95_ms),
    cacheHitPct: numOrNull(
      row?.cacheHitPct ?? row?.cache_hit_pct ?? row?.cache_hit_rate ?? row?.cacheHitRate
    ),
  };
}

function normalizeRegionBreakdown(rows: unknown): any[] | undefined {
  if (!Array.isArray(rows)) return undefined;

  const out = rows
    .map((row) => normalizeRegionBreakdownRow(row))
    .filter(Boolean) as any[];

  if (!out.length) return undefined;

  out.sort((a, b) => {
    if (b.error5xxCount !== a.error5xxCount) return b.error5xxCount - a.error5xxCount;
    if ((b.p95TtmsMs ?? -1) !== (a.p95TtmsMs ?? -1)) return (b.p95TtmsMs ?? -1) - (a.p95TtmsMs ?? -1);
    return b.totalRequests - a.totalRequests;
  });

  return out;
}

function normalizePopBreakdown(rows: unknown): any[] | undefined {
  if (!Array.isArray(rows)) return undefined;

  const out = rows
    .map((row) => normalizePopBreakdownRow(row))
    .filter(Boolean) as any[];

  if (!out.length) return undefined;

  out.sort((a, b) => {
    if (b.error5xxCount !== a.error5xxCount) return b.error5xxCount - a.error5xxCount;
    if ((b.p95TtmsMs ?? -1) !== (a.p95TtmsMs ?? -1)) return (b.p95TtmsMs ?? -1) - (a.p95TtmsMs ?? -1);
    return b.totalRequests - a.totalRequests;
  });

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

function assertCanonicalMetricsJson(metricsJson: any) {
  if (!metricsJson || typeof metricsJson !== "object") {
    throw new Error("route: metricsJson missing");
  }

  const required = ["totalRequests", "p95TtmsMs", "error5xxCount", "errorRatePct"];
  for (const k of required) {
    if (!(k in metricsJson)) {
      throw new Error(`route: non-canonical metricsJson (missing ${k})`);
    }
  }

  if (!metricsJson.debug || typeof metricsJson.debug !== "object") {
    metricsJson.debug = {};
  }

  const t = metricsJson.timeseries;
  if (!t || typeof t !== "object" || !Array.isArray(t.points)) {
    metricsJson.timeseries = { bucketSeconds: null, startTs: null, endTs: null, points: [] };
  }

  return metricsJson;
}

function canonicalStubMetricsJson(debug: Record<string, any>) {
  return {
    totalRequests: 0,
    p95TtmsMs: null,
    error5xxCount: 0,
    errorRatePct: 0,
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
  if (Number.isNaN(d.getTime())) return { ok: false, error: `invalid ISO: ${s}` };
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

  const agents = runAgents(evidenceBundle);
  const assessment = buildAssessment(evidenceBundle, agents);

  return okJson({
    ok: true,
    summaryText: result.summaryText ?? result.summary ?? "",
    summary: result.summary ?? result.summaryText ?? "",
    metricsJson,
    sql,
    swarm: {
      assessment,
      agents,
    },
    _mode: "local",
  });
}

function adaptLegacyProxyMetricsToCanonical(
  legacyMetrics: any,
  parsed?: any
) {
  const totalRequests = numOrNull(legacyMetrics?.totalRequests) ?? numOrNull(legacyMetrics?.requests) ?? 0;
  const p50 = numOrNull(legacyMetrics?.p50TtmsMs) ?? numOrNull(legacyMetrics?.p50_ms);
  const p95 = numOrNull(legacyMetrics?.p95TtmsMs) ?? numOrNull(legacyMetrics?.p95_ms);
  const p99 = numOrNull(legacyMetrics?.p99TtmsMs) ?? numOrNull(legacyMetrics?.p99_ms);
  const error5xxCount =
    numOrNull(legacyMetrics?.error5xxCount) ?? numOrNull(legacyMetrics?.errors_5xx) ?? 0;
  const errorRatePct =
    numOrNull(legacyMetrics?.errorRatePct) ??
    (totalRequests > 0 ? (error5xxCount / totalRequests) * 100 : 0);

  const out: any = {
    totalRequests,
    p50TtmsMs: p50,
    p95TtmsMs: p95,
    p99TtmsMs: p99,
    error5xxCount,
    errorRatePct,
    timeseries:
      legacyMetrics?.timeseries && Array.isArray(legacyMetrics.timeseries?.points)
        ? legacyMetrics.timeseries
        : { bucketSeconds: null, startTs: null, endTs: null, points: [] },
    debug: legacyMetrics?.debug && typeof legacyMetrics.debug === "object" ? legacyMetrics.debug : {},
  };

  const regionBreakdown = pickRegionBreakdownFromProxy(parsed, legacyMetrics);
  if (regionBreakdown) out.regionBreakdown = regionBreakdown;

  const popBreakdown = pickPopBreakdownFromProxy(parsed, legacyMetrics);
  if (popBreakdown) out.popBreakdown = popBreakdown;

  return out;
}

function safeAdaptProxyToUi(parsed: any, tm: TimeMode, scope: EvidenceScope) {
  const ok = !!parsed?.ok;
  if (!ok) {
    return {
      ok: false,
      error: parsed?.error ? String(parsed.error) : "proxy returned ok=false",
      _mode: "proxy",
    };
  }

  const rawMetrics = parsed?.metricsJson ?? parsed?.metrics ?? null;

  let metricsJson: any;
  if (
    rawMetrics &&
    typeof rawMetrics === "object" &&
    "totalRequests" in rawMetrics &&
    "p95TtmsMs" in rawMetrics &&
    "error5xxCount" in rawMetrics &&
    "errorRatePct" in rawMetrics
  ) {
    metricsJson = assertCanonicalMetricsJson(rawMetrics);
  } else {
    metricsJson = assertCanonicalMetricsJson(adaptLegacyProxyMetricsToCanonical(rawMetrics || {}, parsed));
  }

  const regionBreakdown = pickRegionBreakdownFromProxy(parsed, rawMetrics);
  if (regionBreakdown) {
    metricsJson.regionBreakdown = regionBreakdown;
  }

  const popBreakdown = pickPopBreakdownFromProxy(parsed, rawMetrics);
  if (popBreakdown) {
    metricsJson.popBreakdown = popBreakdown;
  }

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

  metricsJson.debug = {
    ...(metricsJson.debug || {}),
    sqlSource: parsed?.sql ? "proxy" : "planner-fallback",
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

  const agents = runAgents(evidenceBundle);
  const assessment = buildAssessment(evidenceBundle, agents);

  return {
    ok: true,
    summaryText: parsed?.summaryText ?? parsed?.summary ?? "",
    summary: parsed?.summary ?? parsed?.summaryText ?? "",
    metricsJson,
    sql,
    swarm: {
      assessment,
      agents,
    },
    inputs: parsed?.inputs ?? undefined,
    _mode: "proxy",
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
      return badRequest(`invalid region: ${inputs.region}`, { allowedRegions: ["all", ...CANON.regions] });
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

    const upstreamBody: any = {
      partner: inputs.partner,
      service: inputs.service,
      region: inputs.region,
      pop: inputs.pop,
      windowMinutes: inputs.windowMinutes,
      debug: inputs.debug,
      contentType: inputs.contentType,
      uaFamily: inputs.uaFamily,
    };

    if (tm.mode === "absolute") {
      upstreamBody.startTsUtc = tm.startIso;
      upstreamBody.endTsUtc = tm.endIso;
    }

    const upstream = await fetch(triageUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
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

    const adapted = safeAdaptProxyToUi(parsed, tm, scope);

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

    return okJson(adapted);
  } catch (e: any) {
    console.error("TRIAGE_ROUTE_FATAL", e);
    return NextResponse.json({ ok: false, error: e?.message || "triage failed" }, { status: 500 });
  }
}
// ui/app/api/triage/route.ts
import { NextResponse } from "next/server";
import { Buffer } from "node:buffer";
import { CANON } from "@/lib/schema/canonical";
import { runClickhouseTriage } from "@/lib/clickhouse/runClickhouseTriage";

export const runtime = "nodejs";

type Inputs = {
  dataSource: string; // csv|clickhouse (we care about clickhouse)
  partner: string;
  service: string;
  region: string; // all|<canon>
  pop: string; // all|<canon>
  windowMinutes: number;

  // Absolute range (UTC ISO) — optional, but must be BOTH if present
  startTsUtc: string | null;
  endTsUtc: string | null;

  debug: boolean;
  contentType: string; // all|manifest|segment|api
  uaFamily: string; // all|stb|mobile|web|smart_tv|console
};

type TimeMode =
  | { mode: "relative" }
  | { mode: "absolute"; startIso: string; endIso: string };

function boolish(v: unknown) {
  if (typeof v === "boolean") return v;
  const s = String(v ?? "").trim().toLowerCase();
  return ["1", "true", "yes", "on"].includes(s);
}

// IMPORTANT: do NOT lowercase canonical tokens.
function tok(v: unknown) {
  return String(v ?? "").trim();
}

function clampInt(n: number, min: number, max: number) {
  const x = Math.floor(n);
  return Math.max(min, Math.min(max, x));
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

/**
 * Generator is source of truth.
 * Route must NOT reshape metrics.
 * Only asserts + ensures debug/timeseries exist.
 */
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
    return { queries: sql.queries.map((q: any) => String(q)), params: sql.params ?? undefined };
  }

  if (typeof sql.query === "string" && sql.query.trim()) {
    return { queries: [sql.query.trim()], params: sql.params ?? undefined };
  }

  return undefined;
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
    for (const [k, v] of form.entries()) if (typeof v === "string") obj[k] = v;
    return normalize(obj);
  }

  // last resort
  const body = (await req.json().catch(() => ({}))) as any;
  return normalize(body);
}

function badRequest(error: string, extra?: Record<string, any>) {
  return NextResponse.json({ ok: false, error, ...(extra ? { details: extra } : {}) }, { status: 400 });
}

function okJson(payload: any) {
  return NextResponse.json(payload, { status: 200 });
}

function hasProxyEnv() {
  const url = process.env.CACHEY_PROXY_URL;
  const user = process.env.CACHEY_BASIC_USER;
  const pass = process.env.CACHEY_BASIC_PASS;
  const token = process.env.CACHEY_TOKEN;
  return !!(url && user && pass && token);
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
    // if absolute, do NOT anchor to max(ts)
    anchorToMaxTs: tm.mode === "absolute" ? false : metricsJson.debug?.anchorToMaxTs ?? undefined,
  };

  const sql = normalizeSqlForUi(result.sql ?? undefined);

  return okJson({
    ok: true,
    summaryText: result.summaryText ?? result.summary ?? "",
    summary: result.summary ?? result.summaryText ?? "",
    metricsJson,
    sql,
    _mode: "local",
  });
}

function safeAdaptProxyToUi(parsed: any, tm: TimeMode) {
  const ok = !!parsed?.ok;
  if (!ok) {
    return {
      ok: false,
      error: parsed?.error ? String(parsed.error) : "proxy returned ok=false",
      _mode: "proxy",
    };
  }

  const metricsJson = assertCanonicalMetricsJson(parsed?.metricsJson ?? parsed?.metrics);
  metricsJson.debug = {
    ...(metricsJson.debug || {}),
    hasProxyEnv: true,
    forcedLocal: false,
    timeMode: tm.mode,
    startTsUtc: tm.mode === "absolute" ? tm.startIso : null,
    endTsUtc: tm.mode === "absolute" ? tm.endIso : null,
    anchorToMaxTs: tm.mode === "absolute" ? false : metricsJson.debug?.anchorToMaxTs ?? undefined,
  };

  const sql = normalizeSqlForUi(parsed?.sql ?? undefined);

  return {
    ok: true,
    summaryText: parsed?.summaryText ?? parsed?.summary ?? "",
    summary: parsed?.summary ?? parsed?.summaryText ?? "",
    metricsJson,
    sql,
    inputs: parsed?.inputs ?? undefined,
    _mode: "proxy",
  };
}

export async function POST(req: Request) {
  try {
    const inputs = await parseRequest(req);

    // Dev convenience: default debug=true locally
    if (process.env.NODE_ENV !== "production" && inputs.debug === false) {
      inputs.debug = true;
    }

    // Guardrails
    if (!inputs.partner) return badRequest("partner is required", { allowedPartners: CANON.partners });
    if (!isCanonPartner(inputs.partner)) {
      return badRequest(`invalid partner: ${inputs.partner}`, { allowedPartners: CANON.partners });
    }

    if (!inputs.service) return badRequest("service is required", { allowedServices: CANON.services });
    if (inputs.service === "all") return badRequest(`service cannot be "all"`, { allowedServices: CANON.services });
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

    // Validate time mode once (and canonicalize ISO)
    let tm: TimeMode;
    try {
      tm = computeTimeMode(inputs);
    } catch (err: any) {
      return badRequest(err?.message || "invalid time range");
    }

    const wantsClickhouse = inputs.dataSource === "clickhouse";
    const isDev = process.env.NODE_ENV !== "production";

    // Dev override: always run local for clickhouse in dev (fast iteration)
    if (wantsClickhouse && isDev) {
      return await runLocal(inputs, tm);
    }

    // Use proxy if configured; else local fallback.
    if (!hasProxyEnv()) {
      return await runLocal(inputs, tm);
    }

    // Proxy path
    const user = process.env.CACHEY_BASIC_USER!;
    const pass = process.env.CACHEY_BASIC_PASS!;
    const token = process.env.CACHEY_TOKEN!;
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
        Authorization: `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`,
        "X-Cachey-Token": token,
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
          metricsJson: canonicalStubMetricsJson({
            hasProxyEnv: true,
            forcedLocal: false,
            upstreamStatus: upstream.status,
            timeMode: tm.mode,
            startTsUtc: tm.mode === "absolute" ? tm.startIso : null,
            endTsUtc: tm.mode === "absolute" ? tm.endIso : null,
            anchorToMaxTs: tm.mode === "absolute" ? false : undefined,
          }),
          _mode: "proxy",
        },
        { status: 502 }
      );
    }

    const adapted = safeAdaptProxyToUi(parsed, tm);

    if (!adapted.ok) {
      return NextResponse.json(
        {
          ok: false,
          error: (adapted as any).error || "proxy returned ok=false",
          metricsJson: canonicalStubMetricsJson({
            hasProxyEnv: true,
            forcedLocal: false,
            upstreamStatus: upstream.status,
            timeMode: tm.mode,
            startTsUtc: tm.mode === "absolute" ? tm.startIso : null,
            endTsUtc: tm.mode === "absolute" ? tm.endIso : null,
            anchorToMaxTs: tm.mode === "absolute" ? false : undefined,
          }),
          _mode: "proxy",
        },
        { status: 502 }
      );
    }

    return okJson(adapted);
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || "triage failed" }, { status: 500 });
  }
}
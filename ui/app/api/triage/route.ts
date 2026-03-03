// ui/app/api/triage/route.ts
import { NextResponse } from "next/server";
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
  debug: boolean;
  contentType: string; // all|manifest|segment|api
  uaFamily: string; // all|stb|mobile|web|smart_tv|console
};

function boolish(v: unknown) {
  if (typeof v === "boolean") return v;
  const s = String(v ?? "").trim().toLowerCase();
  return ["1", "true", "yes", "on"].includes(s);
}

// IMPORTANT: do NOT lowercase canonical tokens.
// Canon tokens are already normalized in generator (partner_01, us-east, etc).
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
 * ✅ Generator is source of truth.
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
  const dataSource = String(x.dataSource ?? x.data_source ?? "clickhouse").trim().toLowerCase();

  const partner = tok(x.partner);
  const service = tok(x.service ?? x.svc);

  const region = tok(x.region) || "all";
  const pop = tok(x.pop) || "all";

  const ctRaw = tok(x.contentType ?? x.content_type ?? x.ct) || "all";
  const uaRaw = tok(x.uaFamily ?? x.ua_family ?? x.ua) || "all";

  const wmRaw = Number(x.windowMinutes ?? x.win ?? x.window ?? 60);
  const windowMinutes = Number.isFinite(wmRaw) ? clampInt(wmRaw, 5, 1440) : 60;

  const debug = boolish(x.debug);

  return {
    dataSource,
    partner,
    service,
    region,
    pop,
    windowMinutes,
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
  const url = process.env.CACHEY_PROXY_URL;
  const user = process.env.CACHEY_BASIC_USER;
  const pass = process.env.CACHEY_BASIC_PASS;
  const token = process.env.CACHEY_TOKEN;
  return !!(url && user && pass && token);
}

function proxyTriageUrl() {
  const proxyUrl = process.env.CACHEY_PROXY_URL!;
  const base = proxyUrl.replace(/\/+$/, "");
  // Accept either base or explicit /triage path, with/without trailing slash.
  return base.endsWith("/triage") ? base : `${base}/triage`;
}

async function runLocal(inputs: Inputs) {
  const result = await runClickhouseTriage({
    partner: inputs.partner,
    service: inputs.service,
    region: inputs.region,
    pop: inputs.pop,
    contentType: inputs.contentType,
    uaFamily: inputs.uaFamily,
    windowMinutes: inputs.windowMinutes,
    debug: inputs.debug,
  });

  const metricsJson = assertCanonicalMetricsJson(result.metricsJson);
  metricsJson.debug = {
    ...(metricsJson.debug || {}),
    hasProxyEnv: hasProxyEnv(),
    forcedLocal: true,
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

function safeAdaptProxyToUi(parsed: any) {
  // If proxy returned a non-success payload, do NOT try to assert metricsJson.
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
    if (!isCanonPartner(inputs.partner))
      return badRequest(`invalid partner: ${inputs.partner}`, { allowedPartners: CANON.partners });

    if (!inputs.service) return badRequest("service is required", { allowedServices: CANON.services });
    if (inputs.service === "all")
      return badRequest(`service cannot be "all"`, { allowedServices: CANON.services });
    if (!isCanonService(inputs.service))
      return badRequest(`invalid service: ${inputs.service}`, { allowedServices: CANON.services });

    if (!isAllOrOneOf(inputs.region, CANON.regions as readonly string[]))
      return badRequest(`invalid region: ${inputs.region}`, { allowedRegions: ["all", ...CANON.regions] });

    if (!isAllOrOneOf(inputs.pop, CANON.pops as readonly string[]))
      return badRequest(`invalid pop: ${inputs.pop}`, { allowedPops: ["all", ...CANON.pops] });

    if (!isAllOrOneOf(inputs.contentType, CANON.contentTypes as readonly string[]))
      return badRequest(`invalid contentType: ${inputs.contentType}`, {
        allowedContentTypes: ["all", ...CANON.contentTypes],
      });

    if (!isAllOrOneOf(inputs.uaFamily, CANON.uaFamilies as readonly string[]))
      return badRequest(`invalid uaFamily: ${inputs.uaFamily}`, {
        allowedUaFamilies: ["all", ...CANON.uaFamilies],
      });

    // ✅ Mode selection override:
    // If user asks for clickhouse AND we're in dev, force local so we can iterate.
    const wantsClickhouse = inputs.dataSource === "clickhouse";
    const isDev = process.env.NODE_ENV !== "production";

    if (wantsClickhouse && isDev) {
      return await runLocal(inputs);
    }

    // Otherwise, use proxy if configured; else local fallback.
    if (!hasProxyEnv()) {
      return await runLocal(inputs);
    }

    // Proxy path
    const user = process.env.CACHEY_BASIC_USER!;
    const pass = process.env.CACHEY_BASIC_PASS!;
    const token = process.env.CACHEY_TOKEN!;

    const triageUrl = proxyTriageUrl();

    const upstream = await fetch(triageUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`,
        "X-Cachey-Token": token,
      },
      body: JSON.stringify({
        partner: inputs.partner,
        service: inputs.service,
        region: inputs.region,
        pop: inputs.pop,
        windowMinutes: inputs.windowMinutes,
        debug: inputs.debug,
        contentType: inputs.contentType,
        uaFamily: inputs.uaFamily,
      }),
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

      // Include a tiny debug stub so UI can still show source badge correctly.
      return NextResponse.json(
        {
          ok: false,
          error: msg,
          metricsJson: {
            totalRequests: 0,
            p95TtmsMs: null,
            error5xxCount: 0,
            errorRatePct: 0,
            timeseries: { bucketSeconds: null, startTs: null, endTs: null, points: [] },
            debug: { hasProxyEnv: true, forcedLocal: false, upstreamStatus: upstream.status },
          },
          _mode: "proxy",
        },
        { status: 502 }
      );
    }

    const adapted = safeAdaptProxyToUi(parsed);

    // If proxy replied ok=false with a JSON body, map it to 502 with a clean message.
    if (!adapted.ok) {
      return NextResponse.json(
        {
          ok: false,
          error: (adapted as any).error || "proxy returned ok=false",
          metricsJson: {
            totalRequests: 0,
            p95TtmsMs: null,
            error5xxCount: 0,
            errorRatePct: 0,
            timeseries: { bucketSeconds: null, startTs: null, endTs: null, points: [] },
            debug: { hasProxyEnv: true, forcedLocal: false, upstreamStatus: upstream.status },
          },
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
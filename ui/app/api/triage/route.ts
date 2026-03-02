// ui/app/api/triage/route.ts
import { NextResponse } from "next/server";
import { CANON } from "@/lib/schema/canonical";
import { runClickhouseTriage } from "@/lib/clickhouse/runClickhouseTriage";

export const runtime = "nodejs";

type Inputs = {
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

function tok(v: unknown) {
  return String(v ?? "").trim().toLowerCase();
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
 * ✅ Normalizes legacy metrics shape → UI contract shape.
 * Legacy: { requests, p50_ms, p95_ms, p99_ms, errors_5xx }
 * UI expects: { totalRequests, p50TtmsMs, p95TtmsMs, p99TtmsMs, error5xxCount, errorRatePct }
 */
function normalizeMetricsJson(metricsJson: any) {
  if (!metricsJson || typeof metricsJson !== "object") return metricsJson;

  // already normalized
  if (
    "totalRequests" in metricsJson ||
    "p95TtmsMs" in metricsJson ||
    "errorRatePct" in metricsJson
  ) {
    // ensure debug exists
    const dbg =
      metricsJson.debug && typeof metricsJson.debug === "object"
        ? metricsJson.debug
        : {};
    metricsJson.debug = dbg;
    return metricsJson;
  }

  const requests = Number(metricsJson.requests ?? 0);
  const p50 = Number(metricsJson.p50_ms ?? 0);
  const p95 = Number(metricsJson.p95_ms ?? 0);
  const p99 = Number(metricsJson.p99_ms ?? 0);
  const e5 = Number(metricsJson.errors_5xx ?? 0);
  const errPct =
    Number.isFinite(requests) && requests > 0 && Number.isFinite(e5)
      ? (e5 / requests) * 100
      : 0;

  const dbg =
    metricsJson.debug && typeof metricsJson.debug === "object"
      ? metricsJson.debug
      : {};

  return {
    ...metricsJson,

    // ✅ stable UI contract
    totalRequests: Number.isFinite(requests) ? requests : 0,
    p50TtmsMs: Number.isFinite(p50) ? p50 : 0,
    p95TtmsMs: Number.isFinite(p95) ? p95 : 0,
    p99TtmsMs: Number.isFinite(p99) ? p99 : 0,
    error5xxCount: Number.isFinite(e5) ? e5 : 0,
    errorRatePct: Number.isFinite(errPct) ? errPct : 0,

    // UI sometimes renders charts; keep empty timeseries if missing
    timeseries:
      metricsJson.timeseries ??
      { bucketSeconds: null, startTs: null, endTs: null, points: [] },

    debug: {
      ...dbg,
      normalizedAt: new Date().toISOString(),
      normalizedFrom: "legacy_clickhouse_shape",
    },
  };
}

function normalizeSqlForUi(sql: any) {
  if (!sql) return undefined;

  // Already { queries: [...] }
  if (Array.isArray(sql.queries)) {
    return { queries: sql.queries.map((q: any) => String(q)), params: sql.params ?? undefined };
  }

  // Legacy { query: "..." }
  if (typeof sql.query === "string" && sql.query.trim()) {
    return { queries: [sql.query.trim()], params: sql.params ?? undefined };
  }

  return undefined;
}

function normalize(x: Record<string, any>): Inputs {
  // required
  const partner = tok(x.partner);

  // ✅ accept svc alias (UI chips often show `svc`)
  const service = tok(x.service ?? x.svc);

  // optional filters (allow "all")
  const region = tok(x.region) || "all";
  const pop = tok(x.pop) || "all";

  // ✅ accept ct / ua aliases
  const ctRaw = tok(x.contentType ?? x.content_type ?? x.ct) || "all";
  const uaRaw = tok(x.uaFamily ?? x.ua_family ?? x.ua) || "all";

  // ✅ accept win/window aliases (UI chips often show `win`)
  const wmRaw = Number(x.windowMinutes ?? x.win ?? x.window ?? 60);
  const windowMinutes = Number.isFinite(wmRaw) ? clampInt(wmRaw, 5, 1440) : 60;

  const debug = boolish(x.debug);

  return {
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

/**
 * Local dev fallback:
 * - Runs clickhouse runner in-process (mock for now, real later)
 * - Returns same API contract as proxy path
 */
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

  const metricsJson = normalizeMetricsJson(result.metricsJson ?? null);
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

/**
 * Adapt proxy response into the UI's expected contract.
 * Proxy currently returns: { ok, inputs, metrics, sql? }
 * UI expects: { ok, summaryText, metricsJson, sql? }
 */
function adaptProxyToUi(parsed: any) {
  const ok = !!parsed?.ok;

  const metricsJson = normalizeMetricsJson(parsed?.metricsJson ?? parsed?.metrics ?? null);
  const sql = normalizeSqlForUi(parsed?.sql ?? undefined);

  return {
    ok,
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

    // -----------------------------
    // Guardrails (Phase C)
    // -----------------------------
    if (!inputs.partner) {
      return badRequest("partner is required", { allowedPartners: CANON.partners });
    }
    if (!isCanonPartner(inputs.partner)) {
      return badRequest(`invalid partner: ${inputs.partner}`, {
        allowedPartners: CANON.partners,
      });
    }

    if (!inputs.service) {
      return badRequest("service is required", { allowedServices: CANON.services });
    }
    if (inputs.service === "all") {
      return badRequest(`service cannot be "all"`, { allowedServices: CANON.services });
    }
    if (!isCanonService(inputs.service)) {
      return badRequest(`invalid service: ${inputs.service}`, {
        allowedServices: CANON.services,
      });
    }

    if (!isAllOrOneOf(inputs.region, CANON.regions as readonly string[])) {
      return badRequest(`invalid region: ${inputs.region}`, {
        allowedRegions: ["all", ...CANON.regions],
      });
    }

    if (!isAllOrOneOf(inputs.pop, CANON.pops as readonly string[])) {
      return badRequest(`invalid pop: ${inputs.pop}`, {
        allowedPops: ["all", ...CANON.pops],
      });
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

    // -----------------------------
    // Mode selection
    // -----------------------------
    if (!hasProxyEnv()) {
      return await runLocal(inputs);
    }

    // Proxy path
    const proxyUrl = process.env.CACHEY_PROXY_URL!;
    const user = process.env.CACHEY_BASIC_USER!;
    const pass = process.env.CACHEY_BASIC_PASS!;
    const token = process.env.CACHEY_TOKEN!;

    const base = proxyUrl.replace(/\/+$/, "");
    const triageUrl = base.endsWith("/triage") ? base : `${base}/triage`;
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
      try { return text ? JSON.parse(text) : null; } catch { return null; }
    })();

    if (!upstream.ok) {
      const msg =
        parsed && typeof parsed === "object" && parsed?.error
          ? String(parsed.error)
          : text
          ? `proxy triage failed (HTTP ${upstream.status}): ${text.slice(0, 220)}`
          : `proxy triage failed (HTTP ${upstream.status})`;
      return NextResponse.json({ ok: false, error: msg }, { status: 502 });
    }

    return okJson(adaptProxyToUi(parsed));
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: e?.message || "triage failed" },
      { status: 500 }
    );
  }
}
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

function normalize(x: Record<string, any>): Inputs {
  // required
  const partner = tok(x.partner);
  const service = tok(x.service);

  // optional filters (allow "all")
  const region = tok(x.region) || "all";
  const pop = tok(x.pop) || "all";

  const ctRaw = tok(x.contentType ?? x.content_type) || "all";
  const uaRaw = tok(x.uaFamily ?? x.ua_family) || "all";

  const wmRaw = Number(x.windowMinutes ?? 60);
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
 * - Runs clickhouse runner in-process (mock or real later)
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

  return okJson({
    ok: true,
    summaryText: result.summaryText ?? result.summary ?? "",
    summary: result.summary ?? result.summaryText ?? "",
    metricsJson: result.metricsJson ?? null,
    sql: result.sql ?? undefined,
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

  // Prefer the canonical "metricsJson" if proxy ever returns it later,
  // otherwise fall back to "metrics" (current proxy shape).
  const metricsJson = parsed?.metricsJson ?? parsed?.metrics ?? null;

  return {
    ok,
    summaryText: parsed?.summaryText ?? parsed?.summary ?? "",
    summary: parsed?.summary ?? parsed?.summaryText ?? "",
    metricsJson,
    sql: parsed?.sql ?? undefined,
    inputs: parsed?.inputs ?? undefined, // keep for debugging / evidence
  };
}

export async function POST(req: Request) {
  try {
    const inputs = await parseRequest(req);

    // Dev convenience: if dataset is stale, default debug=true locally
    // so you see real data without hunting timestamps.
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

    // If proxy envs not configured -> local fallback
    if (!hasProxyEnv()) {
      return await runLocal(inputs);
    }

    // -----------------------------
    // Proxy forward path (prod)
    // -----------------------------
    const forwardPayload = {
      dataSource: "clickhouse",
      partner: inputs.partner,
      service: inputs.service,
      region: inputs.region,
      pop: inputs.pop,
      windowMinutes: inputs.windowMinutes,
      debug: inputs.debug,
      contentType: inputs.contentType,
      uaFamily: inputs.uaFamily,
    };

    const url = process.env.CACHEY_PROXY_URL!;
    const user = process.env.CACHEY_BASIC_USER!;
    const pass = process.env.CACHEY_BASIC_PASS!;
    const token = process.env.CACHEY_TOKEN!; // kept for now (route gating), proxy ignores if from Caddy

    const auth = Buffer.from(`${user}:${pass}`).toString("base64");

    let resp: Response;
    try {
      resp = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Basic ${auth}`,
          "x-cachey-token": token,
        },
        body: JSON.stringify(forwardPayload),
      });
    } catch {
      // proxy unreachable -> local fallback
      return await runLocal(inputs);
    }

    const text = await resp.text();

    // Parse + adapt to UI contract
    try {
      const parsed = JSON.parse(text);

      // If proxy returned non-ok, still adapt and pass through status
      const adapted = adaptProxyToUi(parsed);

      return NextResponse.json(
        { ...adapted, _mode: "proxy" },
        { status: resp.status }
      );
    } catch {
      // non-json response -> local fallback
      return await runLocal(inputs);
    }
  } catch (err: any) {
    console.error("api/triage error", err);
    return NextResponse.json(
      { ok: false, error: String(err?.message ?? err) },
      { status: 500 }
    );
  }
}
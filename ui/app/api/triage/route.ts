// ui/app/api/triage/route.ts
import { NextResponse } from "next/server";

export const runtime = "nodejs";

type Inputs = {
  partner: string;
  service: string;
  region: string;
  pop: string;
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

function normToken(v: unknown, fallback: string) {
  const s = String(v ?? "").trim().toLowerCase();
  return s || fallback;
}

function oneOf(v: unknown, allowed: string[], fallback: string) {
  const s = String(v ?? "").trim().toLowerCase();
  return allowed.includes(s) ? s : fallback;
}

function normalize(x: Record<string, any>): Inputs {
  const partner = String(x.partner ?? "acme_media").trim() || "acme_media";

  const service = normToken(x.service, "all");
  const region = normToken(x.region, "all");
  const pop = normToken(x.pop, "all");

  const ctRaw = x.contentType ?? x.content_type ?? "all";
  const uaRaw = x.uaFamily ?? x.ua_family ?? "all";

  const contentType = oneOf(ctRaw, ["all", "manifest", "segment", "api"], "all");
  const uaFamily = oneOf(uaRaw, ["all", "stb", "mobile", "web", "smart_tv", "console"], "all");

  const wm = Number(x.windowMinutes ?? 60);
  const windowMinutes = Number.isFinite(wm) && wm > 0 ? Math.floor(wm) : 60;

  const debug = boolish(x.debug);

  return { partner, service, region, pop, windowMinutes, debug, contentType, uaFamily };
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

export async function POST(req: Request) {
  try {
    const inputs = await parseRequest(req);

    // Payload we send to the VPS proxy (keep shape stable)
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
    const token = process.env.CACHEY_TOKEN!;

    if (!url || !user || !pass || !token) {
      return NextResponse.json(
        { ok: false, error: "Missing CACHEY_* env vars" },
        { status: 500 }
      );
    }

    const auth = Buffer.from(`${user}:${pass}`).toString("base64");

    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Basic ${auth}`,
        "x-cachey-token": token,
      },
      body: JSON.stringify(forwardPayload),
    });

    const text = await resp.text();
    return new NextResponse(text, {
      status: resp.status,
      headers: { "content-type": "application/json" },
    });
  } catch (err: any) {
    console.error("api/triage error", err);
    return NextResponse.json(
      { ok: false, error: String(err?.message ?? err) },
      { status: 500 }
    );
  }
}
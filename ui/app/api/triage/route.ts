// ui/app/api/triage/route.ts
import { NextResponse } from "next/server";
import { runTriage } from "@/lib/triage/metricsEngine";
import { runClickhouseTriage, type ClickhouseTriageInputs } from "@/lib/clickhouse/runClickhouseTriage";

export const runtime = "nodejs";

function truthy(v: unknown) {
  const s = String(v ?? "").trim().toLowerCase();
  return ["1", "true", "yes", "on"].includes(s);
}

function asPositiveInt(v: unknown, fallback = 60) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

function normalizeStr(v: unknown, fallback: string) {
  const s = String(v ?? "").trim();
  return s ? s : fallback;
}

type ParsedInputs =
  | { mode: "json"; body: Record<string, any> }
  | { mode: "form"; form: FormData; body: Record<string, any> }
  | { mode: "urlencoded"; body: Record<string, any> }
  | { mode: "unknown"; body: Record<string, any> };

async function readInputs(req: Request): Promise<ParsedInputs> {
  const ct = req.headers.get("content-type") || "";

  // ✅ JSON (Debug UI + curl path)
  if (ct.includes("application/json")) {
    const body = (await req.json().catch(() => ({}))) as Record<string, any>;
    return { mode: "json", body };
  }

  // ✅ multipart/form-data (CSV upload path)
  if (ct.includes("multipart/form-data")) {
    const form = await req.formData();
    const obj: Record<string, any> = {};
    for (const [k, v] of form.entries()) obj[k] = v;
    return { mode: "form", form, body: obj };
  }

  // ✅ urlencoded (optional)
  if (ct.includes("application/x-www-form-urlencoded")) {
    const text = await req.text();
    const params = new URLSearchParams(text);
    const obj: Record<string, any> = {};
    for (const [k, v] of params.entries()) obj[k] = v;
    return { mode: "urlencoded", body: obj };
  }

  // Fallback attempt
  const body = (await req.json().catch(() => ({}))) as Record<string, any>;
  return { mode: "unknown", body };
}

export async function POST(req: Request) {
  console.log("🔥 USING ROUTE: ui/app/api/triage/route.ts 🔥");

  try {
    const parsed = await readInputs(req);
    const body = parsed.body || {};

    // -----------------------------
    // Common fields (CSV + ClickHouse)
    // -----------------------------
    const dataSource = normalizeStr(body.dataSource, "csv").toLowerCase();
    const partner = normalizeStr(body.partner, "acme_media");

    const service = normalizeStr(body.service, "all");
    const region = normalizeStr(body.region, "all");
    const pop = normalizeStr(body.pop, "all");

    // Accept common naming variants
    const contentType = normalizeStr(
      body.contentType ?? body.content_type ?? body.contentTypes ?? body.content_types,
      "all"
    );

    const uaFamily = normalizeStr(
      body.uaFamily ?? body.ua_family ?? body.uaFamilies ?? body.ua_families,
      "all"
    );

    const windowMinutes = asPositiveInt(body.windowMinutes, 60);
    const debug = truthy(body.debug);

    // -----------------------------
    // ✅ ClickHouse branch
    // -----------------------------
    if (dataSource === "clickhouse") {
      const inputs: ClickhouseTriageInputs = {
        partner,
        service,
        region,
        pop,
        contentType,
        uaFamily,
        windowMinutes,
        debug,
      };

      const result = await runClickhouseTriage(inputs);

      // Stable UI contract: put sql at top-level when debug enabled
      return NextResponse.json({
        ok: true,
        summaryText: result.summaryText,
        metricsJson: result.metricsJson,
        ...(debug && result.debugSql ? { sql: { queries: [result.debugSql] } } : {}),
      });
    }

    // -----------------------------
    // CSV branch (still supported)
    // -----------------------------
    // Allow csvText directly (JSON) OR csvUrl OR multipart file upload
    let csvText = "";

    if (typeof body.csvText === "string" && body.csvText.trim()) {
      csvText = body.csvText;
    } else if (typeof body.csvUrl === "string" && body.csvUrl.trim()) {
      const resp = await fetch(body.csvUrl);
      if (!resp.ok) throw new Error(`Failed to fetch csvUrl (${resp.status} ${resp.statusText})`);
      csvText = await resp.text();
    } else if (parsed.mode === "form") {
      const file = parsed.form.get("file");
      const csvUrl = String(parsed.form.get("csvUrl") ?? "").trim();

      if (file && typeof file === "object" && typeof (file as any).text === "function") {
        csvText = await (file as any).text();
      } else {
        if (!csvUrl) throw new Error("Provide either a CSV file upload or csvUrl.");
        const resp = await fetch(csvUrl);
        if (!resp.ok) throw new Error(`Failed to fetch csvUrl (${resp.status} ${resp.statusText})`);
        csvText = await resp.text();
      }
    } else {
      throw new Error("CSV mode requires csvText, csvUrl, or multipart file upload.");
    }

    const { summaryText, metricsJson } = runTriage({
      csvText,
      service,
      region,
      pop,
      windowMinutes,
      debug,
      // NOTE: CSV engine currently ignores contentType/uaFamily.
      // We can wire those later if needed.
    });

    return NextResponse.json({ ok: true, summaryText, metricsJson });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ ok: false, error: message }, { status: 400 });
  }
}
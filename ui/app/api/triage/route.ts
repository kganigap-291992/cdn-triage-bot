<<<<<<< HEAD
// ui/app/api/triage/route.ts
=======
// app/api/triage/route.ts
>>>>>>> origin/main
import { NextResponse } from "next/server";
import { runTriage } from "@/lib/triage/metricsEngine";
import { runClickhouseTriage, type ClickhouseTriageInputs } from "@/lib/clickhouse/runClickhouseTriage";

export const runtime = "nodejs";

<<<<<<< HEAD
function truthy(v: unknown) {
=======
type Inputs = {
  dataSource: "csv" | "clickhouse";
  partner: string;
  service: string;
  region: string;
  pop: string;
  windowMinutes: number;
  debug: boolean;

  // ✅ NEW (generator schema dims)
  contentType: string; // all|manifest|segment|api
  uaFamily: string; // all|stb|mobile|web|smart_tv|console

  csvUrl?: string;
  csvText?: string;
};

function boolish(v: unknown) {
  if (typeof v === "boolean") return v;
>>>>>>> origin/main
  const s = String(v ?? "").trim().toLowerCase();
  return ["1", "true", "yes", "on"].includes(s);
}

<<<<<<< HEAD
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

=======
function normToken(v: unknown, fallback: string) {
  const s = String(v ?? "").trim().toLowerCase();
  return s || fallback;
}

// ✅ NEW: validate enumerated tokens so SQL builder can't be fed junk/typos
function oneOf(v: unknown, allowed: string[], fallback: string) {
  const s = String(v ?? "").trim().toLowerCase();
  return allowed.includes(s) ? s : fallback;
}

function normalize(x: Partial<Inputs>): Inputs {
  const ds = String(x.dataSource ?? "csv").trim().toLowerCase();
  const dataSource = (ds === "clickhouse" ? "clickhouse" : "csv") as Inputs["dataSource"];

  // NOTE: keep CSV default partner behavior for legacy path
  const partner = String(x.partner ?? "acme_media").trim() || "acme_media";

  const service = normToken(x.service, "all");
  const region = normToken(x.region, "all");
  const pop = normToken(x.pop, "all");

  // ✅ NEW: enforce canonical vocab (matches generator + CH columns)
  const contentType = oneOf((x as any).contentType, ["all", "manifest", "segment", "api"], "all");
  const uaFamily = oneOf((x as any).uaFamily, ["all", "stb", "mobile", "web", "smart_tv", "console"], "all");

  const wm = Number(x.windowMinutes ?? 60);
  const windowMinutes = Number.isFinite(wm) && wm > 0 ? Math.floor(wm) : 60;

  const debug = boolish(x.debug);

  return {
    dataSource,
    partner,
    service,
    region,
    pop,
    windowMinutes,
    debug,
    contentType,
    uaFamily,
    csvUrl: x.csvUrl,
    csvText: x.csvText,
  };
}

async function parseRequest(req: Request): Promise<Inputs> {
  const ct = req.headers.get("content-type") || "";

  // -----------------------------
  // JSON
  // -----------------------------
  if (ct.includes("application/json")) {
    const body = (await req.json().catch(() => ({}))) as any;
    return normalize({
      dataSource: body.dataSource,
      partner: body.partner,
      service: body.service,
      region: body.region,
      pop: body.pop,
      windowMinutes: body.windowMinutes,
      debug: body.debug,
      contentType: body.contentType,
      uaFamily: body.uaFamily,
      csvUrl: body.csvUrl,
    });
  }

  // -----------------------------
  // FormData
  // -----------------------------
  const form = await req.formData();

  const dataSource = String(form.get("dataSource") ?? "csv");
  const partner = String(form.get("partner") ?? "acme_media");
  const service = String(form.get("service") ?? "all");
  const region = String(form.get("region") ?? "all");
  const pop = String(form.get("pop") ?? "all");

  // ✅ NEW
  const contentType = String(form.get("contentType") ?? "all");
  const uaFamily = String(form.get("uaFamily") ?? "all");

  const windowMinutes = Number(form.get("windowMinutes") ?? 60);
  const debug = form.get("debug");

  const csvUrl = String(form.get("csvUrl") ?? "").trim();

  let csvText = "";
  const file = form.get("file");
  if (file && typeof file === "object" && typeof (file as any).text === "function") {
    csvText = await (file as any).text();
  }

  return normalize({
    dataSource,
    partner,
    service,
    region,
    pop,
    windowMinutes,
    debug,
    contentType,
    uaFamily,
    csvUrl,
    csvText,
  });
}

export async function POST(req: Request) {
  try {
    const inputs = await parseRequest(req);

    // ✅ NEW: partner must be explicitly provided in ClickHouse mode
    // (Prevents silently querying "acme_media" when user forgets partner)
    if (inputs.dataSource === "clickhouse") {
      const p = String(inputs.partner ?? "").trim();
      if (!p || p.toLowerCase() === "acme_media") {
        return NextResponse.json(
          { ok: false, error: "partner is required in clickhouse mode" },
          { status: 400 }
        );
      }
    }

>>>>>>> origin/main
    // -----------------------------
    // ClickHouse
    // -----------------------------
<<<<<<< HEAD
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
=======
    if (inputs.dataSource === "clickhouse") {
      const result = await runClickhouseTriage({
        partner: inputs.partner,
        service: inputs.service,
        region: inputs.region,
        pop: inputs.pop,
        windowMinutes: inputs.windowMinutes,
        debug: inputs.debug,
        contentType: inputs.contentType,
        uaFamily: inputs.uaFamily,
      });

      // ✅ Contract: never return null/missing sql.queries[0] (jq-safe)
      const sql = {
        queries:
          Array.isArray(result.sql?.queries) && result.sql!.queries.length > 0
            ? result.sql!.queries.map(String)
            : [""],
        params: result.sql?.params ?? {},
      };

>>>>>>> origin/main
      return NextResponse.json({
        ok: true,
        summary: result.summaryText ?? result.summary ?? "",
        summaryText: result.summaryText ?? result.summary ?? "",
        metricsJson: result.metricsJson,
<<<<<<< HEAD
        ...(debug && result.debugSql ? { sql: { queries: [result.debugSql] } } : {}),
=======
        sql,
>>>>>>> origin/main
      });
    }

    // -----------------------------
<<<<<<< HEAD
    // CSV branch (still supported)
    // -----------------------------
    // Allow csvText directly (JSON) OR csvUrl OR multipart file upload
    let csvText = "";

    if (typeof body.csvText === "string" && body.csvText.trim()) {
      csvText = body.csvText;
    } else if (typeof body.csvUrl === "string" && body.csvUrl.trim()) {
      const resp = await fetch(body.csvUrl);
      if (!resp.ok) throw new Error(`Failed to fetch csvUrl (${resp.status} ${resp.statusText})`);
=======
    // CSV (legacy)
    // -----------------------------
    let csvText = inputs.csvText || "";

    if (!csvText) {
      const csvUrl = String(inputs.csvUrl || "").trim();
      if (!csvUrl) {
        return NextResponse.json(
          { ok: false, error: "Provide either a CSV file upload or csvUrl." },
          { status: 400 }
        );
      }

      const resp = await fetch(csvUrl);
      if (!resp.ok) {
        return NextResponse.json(
          { ok: false, error: `Failed to fetch csvUrl (${resp.status} ${resp.statusText})` },
          { status: 400 }
        );
      }

>>>>>>> origin/main
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

    // NOTE: runTriage currently ignores contentType/uaFamily.
    // That’s OK because CSV path is legacy / optional.
    const { summaryText, metricsJson } = runTriage({
      csvText,
<<<<<<< HEAD
      service,
      region,
      pop,
      windowMinutes,
      debug,
      // NOTE: CSV engine currently ignores contentType/uaFamily.
      // We can wire those later if needed.
=======
      service: inputs.service,
      region: inputs.region,
      pop: inputs.pop,
      windowMinutes: inputs.windowMinutes,
      debug: inputs.debug,
>>>>>>> origin/main
    });

    return NextResponse.json({
      ok: true,
      summary: summaryText,
      summaryText,
      metricsJson,
      // ✅ Contract: never null/missing queries[0]
      sql: { queries: [""], params: {} },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err ?? "Unknown error");
    console.error("api/triage error:", err);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
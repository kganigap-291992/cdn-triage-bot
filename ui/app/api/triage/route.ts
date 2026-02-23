// app/api/triage/route.ts
import { NextResponse } from "next/server";
import { runTriage } from "@/lib/triage/metricsEngine";
import { runClickhouseTriage } from "@/lib/clickhouse/runClickhouseTriage";

export const runtime = "nodejs";

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
  const s = String(v ?? "").trim().toLowerCase();
  return ["1", "true", "yes", "on"].includes(s);
}

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

    // -----------------------------
    // ClickHouse
    // -----------------------------
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

      return NextResponse.json({
        ok: true,
        summary: result.summaryText ?? result.summary ?? "",
        summaryText: result.summaryText ?? result.summary ?? "",
        metricsJson: result.metricsJson,
        sql,
      });
    }

    // -----------------------------
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

      csvText = await resp.text();
    }

    // NOTE: runTriage currently ignores contentType/uaFamily.
    // That’s OK because CSV path is legacy / optional.
    const { summaryText, metricsJson } = runTriage({
      csvText,
      service: inputs.service,
      region: inputs.region,
      pop: inputs.pop,
      windowMinutes: inputs.windowMinutes,
      debug: inputs.debug,
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
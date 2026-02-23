// ui/app/api/triage/route.ts
import { NextResponse } from "next/server";
import { runTriage } from "@/lib/triage/metricsEngine";
import { runClickhouseTriage } from "@/lib/clickhouse/runClickhouseTriage";

export const runtime = "nodejs";

function toBool(v: unknown) {
  const s = String(v ?? "").trim().toLowerCase();
  return ["1", "true", "yes", "on"].includes(s);
}

function toStr(v: unknown, fallback = "") {
  const s = String(v ?? "").trim();
  return s ? s : fallback;
}

function toNum(v: unknown, fallback: number) {
  const n = Number(String(v ?? "").trim());
  return Number.isFinite(n) ? n : fallback;
}

export async function POST(req: Request) {
  console.log("🔥 USING ROUTE: ui/app/api/triage/route.ts 🔥");

  try {
    const form = await req.formData();

    // -----------------------------
    // Common inputs
    // -----------------------------
    const dataSource = toStr(form.get("dataSource"), "csv").toLowerCase();
    const partner = toStr(form.get("partner"), "acme_media");

    const service = toStr(form.get("service"), "all");
    const region = toStr(form.get("region"), "all");
    const pop = toStr(form.get("pop"), "all");

    const windowMinutes = toNum(form.get("windowMinutes"), 60);
    if (!Number.isFinite(windowMinutes) || windowMinutes <= 0) {
      throw new Error("windowMinutes must be a positive number.");
    }

    const debug = toBool(form.get("debug"));

    // -----------------------------
    // ✅ ClickHouse branch
    // -----------------------------
    if (dataSource === "clickhouse") {
      const result = await runClickhouseTriage({
        partner,
        service,
        region,
        pop,
        windowMinutes,
        debug,
      });

      return NextResponse.json({
        ok: true,

        // ✅ canonical
        summary: result.summaryText,
        metricsJson: result.metricsJson,

        // ✅ legacy compat (keep until all callers migrate)
        summaryText: result.summaryText,

        // ✅ canonical SQL location (only in debug)
        ...(debug && (result as any).debugSql
          ? {
              sql: {
                queries: Array.isArray((result as any).debugSql)
                  ? (result as any).debugSql
                  : [String((result as any).debugSql)],
              },
            }
          : {}),
      });
    }

    // -----------------------------
    // ✅ CSV branch
    // -----------------------------
    const csvUrl = toStr(form.get("csvUrl"), "");
    const file = form.get("file");

    let csvText = "";

    if (file && typeof file === "object" && typeof (file as any).text === "function") {
      csvText = await (file as any).text();
    } else {
      if (!csvUrl) throw new Error("Provide either a CSV file upload or csvUrl.");
      const resp = await fetch(csvUrl);
      if (!resp.ok) {
        throw new Error(`Failed to fetch csvUrl (${resp.status} ${resp.statusText})`);
      }
      csvText = await resp.text();
    }

    const { summaryText, metricsJson } = runTriage({
      csvText,
      service,
      region,
      pop,
      windowMinutes,
      debug,
    });

    return NextResponse.json({
      ok: true,

      // ✅ canonical
      summary: summaryText,
      metricsJson,

      // ✅ legacy compat
      summaryText,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ ok: false, error: message }, { status: 400 });
  }
}
import { NextResponse } from "next/server";
import { runTriage } from "@/lib/triage/metricsEngine";
import { runClickhouseTriage } from "@/lib/clickhouse/runClickhouseTriage";

export const runtime = "nodejs";

export async function POST(req: Request) {
  console.log("🔥 USING ROUTE: app/api/triage/route.ts 🔥");
  try {
    const form = await req.formData();

    // ✅ Data source + partner (public-safe default)
    const dataSource = (form.get("dataSource") || "csv").toString().trim().toLowerCase();
    const partner = (form.get("partner") || "acme_media").toString().trim();

    // Common filters (used by CSV + ClickHouse)
    const service = (form.get("service") || "all").toString();
    const region = (form.get("region") || "all").toString();
    const pop = (form.get("pop") || "all").toString();

    const windowMinutesRaw = (form.get("windowMinutes") || "60").toString();
    const windowMinutes = Number(windowMinutesRaw);
    if (!Number.isFinite(windowMinutes) || windowMinutes <= 0) {
      throw new Error("windowMinutes must be a positive number.");
    }

    const debugRaw = (form.get("debug") || "").toString().toLowerCase();
    const debug = ["1", "true", "yes", "on"].includes(debugRaw);

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

      // result can be { summaryText, metricsJson, debugSql? }
      return NextResponse.json({
        ok: true,
        summaryText: result.summaryText,
        metricsJson: result.metricsJson,
        ...(debug && result.debugSql ? { _debug: { sql: result.debugSql } } : {}),
      });
    }

    // -----------------------------
    // CSV branch
    // -----------------------------
    const csvUrl = (form.get("csvUrl") || "").toString().trim();

    const file = form.get("file");
    let csvText = "";

    if (file && typeof file === "object" && typeof (file as any).text === "function") {
      csvText = await (file as any).text();
    } else {
      if (!csvUrl) throw new Error("Provide either a CSV file upload or csvUrl.");
      const resp = await fetch(csvUrl);
      if (!resp.ok) throw new Error(`Failed to fetch csvUrl (${resp.status} ${resp.statusText})`);
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

    return NextResponse.json({ ok: true, summaryText, metricsJson });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ ok: false, error: message }, { status: 400 });
  }
}

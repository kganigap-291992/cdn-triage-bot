import { NextResponse } from "next/server";
import { runTriage } from "@/lib/triage/metricsEngine";

export const runtime = "nodejs";

export async function POST(req) {
  try {
    const form = await req.formData();

    const csvUrl = (form.get("csvUrl") || "").toString().trim();
    const service = (form.get("service") || "all").toString();
    const region = (form.get("region") || "all").toString();
    const pop = (form.get("pop") || "all").toString();

    const windowMinutesRaw = (form.get("windowMinutes") || "60").toString();
    const windowMinutes = Number(windowMinutesRaw);
    if (!Number.isFinite(windowMinutes) || windowMinutes <= 0) {
      throw new Error("windowMinutes must be a positive number.");
    }

    const filtersRaw = form.get("filters");
    let filters = {};
    if (filtersRaw) {
      const s = filtersRaw.toString().trim();
      if (s) filters = JSON.parse(s);
    }

    const debugRaw = (form.get("debug") || "").toString().toLowerCase();
    const debug = ["1", "true", "yes", "on"].includes(debugRaw);

    const file = form.get("file");
    let csvText = "";

    if (file && typeof file === "object" && typeof file.text === "function") {
      csvText = await file.text();
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
      filters,
      debug,
    });

    return NextResponse.json({ ok: true, summaryText, metricsJson });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ ok: false, error: message }, { status: 400 });
  }
}

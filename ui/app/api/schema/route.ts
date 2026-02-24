// ui/app/api/schema/route.ts
import { NextResponse } from "next/server";

export const runtime = "nodejs";

function env(name: string): string {
  return String(process.env[name] ?? "").trim();
}

type ProxySchemaResponse = {
  ok: boolean;
  schema: {
    partners: string[];
    services: string[];
    regions: string[];
    pops: string[];
    contentTypes: string[];
    uaFamilies: string[];
  };
};

export async function GET() {
  const proxyUrl = env("CACHEY_PROXY_URL");
  const proxyKey = env("CACHEY_PROXY_KEY");

  // ✅ Phase 2: Proxy-first
  if (proxyUrl && proxyKey) {
    const url = `${proxyUrl.replace(/\/+$/, "")}/schema`;

    try {
      const resp = await fetch(url, {
        method: "GET",
        headers: {
          "Accept": "application/json",
          "X-CACHEY-KEY": proxyKey,
        },
      });

      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        throw new Error(
          `Proxy schema failed (${resp.status} ${resp.statusText})${
            text ? `: ${text}` : ""
          }`
        );
      }

      const data = (await resp.json()) as ProxySchemaResponse;

      if (!data || !data.ok || !data.schema) {
        throw new Error("Proxy schema returned invalid payload.");
      }

      return NextResponse.json({
        ok: true,
        schema: data.schema,
        source: "proxy",
      });
    } catch (err) {
      console.error("Schema proxy error:", err);
      // fall through to static fallback
    }
  }

  // ✅ Static fallback (Phase 1 / local mode)
  const schema = {
    partners: [
      "partner_01",
      "partner_02",
      "partner_03",
      "partner_04",
      "partner_05",
      "partner_06",
    ],
    services: ["live", "vod"],
    regions: ["us", "eu", "apac"],
    pops: ["lax", "sjc", "iad", "cdg"],
    contentTypes: ["manifest", "segment", "api"],
    uaFamilies: ["web", "mobile", "stb", "smart_tv", "console"],
  };

  return NextResponse.json({
    ok: true,
    schema,
    source: "static-fallback",
  });
}
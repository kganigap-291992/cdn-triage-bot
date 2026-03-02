// ui/app/api/schema/route.ts
import { NextResponse } from "next/server";
import { CANON } from "@/lib/schema/canonical";

export const runtime = "nodejs";

function env(name: string): string {
  return String(process.env[name] ?? "").trim();
}

// This matches what your VPS currently returns from:
//   https://cachey.cloud/api/schema?partner=...&service=...&region=...
type UpstreamSchemaResponse = {
  ok: boolean;

  partners?: string[];
  services?: string[];
  regions?: string[];
  pops?: string[];
  contentTypes?: string[];
  uaFamilies?: string[];

  availableRegions?: string[];
  availablePops?: string[];
  context?: {
    partner?: string;
    service?: string;
    region?: string;
  };

  error?: string;
};

function canonFallback() {
  return NextResponse.json({
    ok: true,
    schema: {
      partners: [...CANON.partners],
      services: [...CANON.services],
      regions: [...CANON.regions],
      pops: [...CANON.pops],
      // UI expects "all" in these dropdowns
      contentTypes: ["all", ...CANON.contentTypes],
      uaFamilies: ["all", ...CANON.uaFamilies],
    },
    source: "canon-fallback",
  });
}

export async function GET(req: Request) {
  const base = env("CACHEY_PROXY_URL"); // e.g. https://cachey.cloud/api
  const user = env("CACHEY_BASIC_USER");
  const pass = env("CACHEY_BASIC_PASS");

  // If not configured, fallback to CANON
  if (!base || !user || !pass) return canonFallback();

  // Forward query params so we can do dependent schema later:
  // /api/schema?partner=...&service=...&region=...
  const inUrl = new URL(req.url);
  const qs = inUrl.searchParams.toString();
  const upstreamUrl = `${base.replace(/\/+$/, "")}/schema${qs ? `?${qs}` : ""}`;

  try {
    const resp = await fetch(upstreamUrl, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`,
      },
    });

    const data = (await resp.json().catch(() => null)) as UpstreamSchemaResponse | null;

    if (!resp.ok || !data?.ok) {
      const msg =
        (data && typeof data === "object" && data.error && String(data.error)) ||
        `schema upstream failed (HTTP ${resp.status})`;
      return NextResponse.json({ ok: false, error: msg }, { status: 502 });
    }

    // Adapt upstream (top-level lists) -> UI expected nested schema
    const schema = {
      partners: Array.isArray(data.partners) ? data.partners.map(String) : [...CANON.partners],
      services: Array.isArray(data.services) ? data.services.map(String) : [...CANON.services],
      regions: Array.isArray(data.regions) ? data.regions.map(String) : [...CANON.regions],
      pops: Array.isArray(data.pops) ? data.pops.map(String) : [...CANON.pops],
      contentTypes: Array.isArray(data.contentTypes) ? data.contentTypes.map(String) : ["all", ...CANON.contentTypes],
      uaFamilies: Array.isArray(data.uaFamilies) ? data.uaFamilies.map(String) : ["all", ...CANON.uaFamilies],
    };

    // Ensure "all" exists (UI expects it)
    if (!schema.contentTypes.includes("all")) schema.contentTypes = ["all", ...schema.contentTypes];
    if (!schema.uaFamilies.includes("all")) schema.uaFamilies = ["all", ...schema.uaFamilies];

    return NextResponse.json({
      ok: true,
      schema,
      // Pass-through dependent slices for next step (UI can use these)
      availableRegions: Array.isArray(data.availableRegions) ? data.availableRegions.map(String) : undefined,
      availablePops: Array.isArray(data.availablePops) ? data.availablePops.map(String) : undefined,
      context: data.context ?? undefined,
      source: "proxy",
      upstreamUrl: process.env.NODE_ENV !== "production" ? upstreamUrl : undefined,
    });
  } catch (err: any) {
    console.error("Schema proxy error:", err);
    return NextResponse.json(
      { ok: false, error: err?.message || "schema proxy failed" },
      { status: 502 }
    );
  }
}
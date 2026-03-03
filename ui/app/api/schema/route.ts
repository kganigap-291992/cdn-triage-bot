// ui/app/api/schema/route.ts
import { NextResponse } from "next/server";
import { CANON } from "@/lib/schema/canonical";

export const runtime = "nodejs";

function env(name: string): string {
  return String(process.env[name] ?? "").trim();
}

type SchemaShape = {
  partners?: string[];
  services?: string[];
  regions?: string[];
  pops?: string[];
  contentTypes?: string[];
  uaFamilies?: string[];
};

// Upstream may be:
// A) top-level lists (your current VPS format)
// B) { ok:true, schema:{...} } (nested)
type UpstreamSchemaResponse = {
  ok: boolean;

  schema?: SchemaShape;

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

function canonSchema() {
  return {
    partners: [...CANON.partners],
    services: [...CANON.services],
    regions: [...CANON.regions],
    pops: [...CANON.pops],
    // UI expects "all" in these dropdowns
    contentTypes: ["all", ...CANON.contentTypes],
    uaFamilies: ["all", ...CANON.uaFamilies],
  };
}

function normalizeSchemaShape(s: SchemaShape | null | undefined) {
  const fallback = canonSchema();

  const next = {
    partners: Array.isArray(s?.partners) ? s!.partners.map(String) : fallback.partners,
    services: Array.isArray(s?.services) ? s!.services.map(String) : fallback.services,
    regions: Array.isArray(s?.regions) ? s!.regions.map(String) : fallback.regions,
    pops: Array.isArray(s?.pops) ? s!.pops.map(String) : fallback.pops,
    contentTypes: Array.isArray(s?.contentTypes) ? s!.contentTypes.map(String) : fallback.contentTypes,
    uaFamilies: Array.isArray(s?.uaFamilies) ? s!.uaFamilies.map(String) : fallback.uaFamilies,
  };

  if (!next.contentTypes.includes("all")) next.contentTypes = ["all", ...next.contentTypes];
  if (!next.uaFamilies.includes("all")) next.uaFamilies = ["all", ...next.uaFamilies];

  return next;
}

function bestEffortOk(payload: {
  source: "canon-fallback" | "proxy" | "proxy-fallback";
  schema: ReturnType<typeof canonSchema>;
  warning?: string;
  context?: UpstreamSchemaResponse["context"];
  availableRegions?: string[];
  availablePops?: string[];
  upstreamUrl?: string;
}) {
  return NextResponse.json(
    {
      ok: true,
      schema: payload.schema,
      source: payload.source,
      warning: payload.warning,
      context: payload.context,
      availableRegions: payload.availableRegions,
      availablePops: payload.availablePops,
      upstreamUrl: process.env.NODE_ENV !== "production" ? payload.upstreamUrl : undefined,
    },
    { status: 200 }
  );
}

export async function GET(req: Request) {
  const base = env("CACHEY_PROXY_URL"); // e.g. https://cachey.cloud/api  (or .../triage in some setups)
  const user = env("CACHEY_BASIC_USER");
  const pass = env("CACHEY_BASIC_PASS");

  // If not configured, fallback to CANON (ok:true so UI always has options)
  if (!base || !user || !pass) {
    return bestEffortOk({
      source: "canon-fallback",
      schema: canonSchema(),
      warning: "proxy env not configured; using CANON",
    });
  }

  // Forward query params for future dependent schema:
  // /api/schema?partner=...&service=...&region=...
  const inUrl = new URL(req.url);
  const qs = inUrl.searchParams.toString();

  // Be resilient if CACHEY_PROXY_URL accidentally points at /triage.
  // We want the API base, then /schema.
  const cleaned = base.replace(/\/+$/, "");
  const apiBase = cleaned.endsWith("/triage") ? cleaned.replace(/\/triage$/, "") : cleaned;

  const upstreamUrl = `${apiBase}/schema${qs ? `?${qs}` : ""}`;

  try {
    const resp = await fetch(upstreamUrl, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`,
      },
      // Prevent long hangs from freezing UI boot:
      cache: "no-store",
    });

    const data = (await resp.json().catch(() => null)) as UpstreamSchemaResponse | null;

    if (!resp.ok || !data?.ok) {
      const msg =
        (data && typeof data === "object" && data.error && String(data.error)) ||
        `schema upstream failed (HTTP ${resp.status})`;

      // IMPORTANT: schema is best-effort; keep UI usable.
      return bestEffortOk({
        source: "proxy-fallback",
        schema: canonSchema(),
        warning: msg,
        upstreamUrl,
      });
    }

    // Accept either {schema:{...}} or top-level lists
    const shape: SchemaShape = data.schema ?? {
      partners: data.partners,
      services: data.services,
      regions: data.regions,
      pops: data.pops,
      contentTypes: data.contentTypes,
      uaFamilies: data.uaFamilies,
    };

    const schema = normalizeSchemaShape(shape);

    return bestEffortOk({
      source: "proxy",
      schema,
      context: data.context ?? undefined,
      availableRegions: Array.isArray(data.availableRegions) ? data.availableRegions.map(String) : undefined,
      availablePops: Array.isArray(data.availablePops) ? data.availablePops.map(String) : undefined,
      upstreamUrl,
    });
  } catch (err: any) {
    // IMPORTANT: schema is best-effort; keep UI usable.
    return bestEffortOk({
      source: "proxy-fallback",
      schema: canonSchema(),
      warning: err?.message || "schema proxy failed",
      upstreamUrl,
    });
  }
}
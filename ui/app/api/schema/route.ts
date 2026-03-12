// ui/app/api/schema/route.ts
import { NextResponse } from "next/server";
import { Buffer } from "node:buffer";
import { CANON } from "@/lib/schema/canonical";

export const runtime = "nodejs";

function env(name: string): string {
  return String(process.env[name] ?? "").trim();
}

type CanonPartner = (typeof CANON.partners)[number];
type CanonService = (typeof CANON.services)[number];
type CanonRegion = (typeof CANON.regions)[number];

type SchemaShape = {
  partners?: string[];
  services?: string[];
  regions?: string[];
  pops?: string[];
  contentTypes?: string[];
  uaFamilies?: string[];
};

type NormalizedSchema = {
  partners: CanonPartner[];
  services: CanonService[];
  regions: CanonRegion[];
  pops: string[];
  contentTypes: string[];
  uaFamilies: string[];
};

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

function canonSchema(): NormalizedSchema {
  return {
    partners: [...CANON.partners],
    services: [...CANON.services],
    regions: [...CANON.regions],
    pops: [...CANON.pops],
    contentTypes: ["all", ...CANON.contentTypes],
    uaFamilies: ["all", ...CANON.uaFamilies],
  };
}

function isCanonPartner(x: string): x is CanonPartner {
  return (CANON.partners as readonly string[]).includes(x);
}

function isCanonService(x: string): x is CanonService {
  return (CANON.services as readonly string[]).includes(x);
}

function isCanonRegion(x: string): x is CanonRegion {
  return (CANON.regions as readonly string[]).includes(x);
}

function normalizeCanonicalList<T extends string>(
  input: string[] | undefined,
  fallback: readonly T[],
  guard: (x: string) => x is T
): T[] {
  if (!Array.isArray(input) || input.length === 0) {
    return [...fallback];
  }

  const filtered = input.map((x) => String(x).trim()).filter(guard);
  return filtered.length > 0 ? filtered : [...fallback];
}

function normalizeStringList(input: string[] | undefined, fallback: string[]): string[] {
  if (!Array.isArray(input) || input.length === 0) {
    return [...fallback];
  }

  const normalized = input.map((x) => String(x).trim()).filter(Boolean);
  return normalized.length > 0 ? normalized : [...fallback];
}

function normalizeSchemaShape(s: SchemaShape | null | undefined): NormalizedSchema {
  const fallback = canonSchema();

  return {
    partners: normalizeCanonicalList(s?.partners, CANON.partners, isCanonPartner),
    services: normalizeCanonicalList(s?.services, CANON.services, isCanonService),
    regions: normalizeCanonicalList(s?.regions, CANON.regions, isCanonRegion),
    pops: normalizeStringList(s?.pops, fallback.pops),
    contentTypes: (() => {
      const list = normalizeStringList(s?.contentTypes, fallback.contentTypes);
      return list.includes("all") ? list : ["all", ...list];
    })(),
    uaFamilies: (() => {
      const list = normalizeStringList(s?.uaFamilies, fallback.uaFamilies);
      return list.includes("all") ? list : ["all", ...list];
    })(),
  };
}

function bestEffortOk(payload: {
  source: "canon-fallback" | "proxy" | "proxy-fallback";
  schema: NormalizedSchema;
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
  const base = env("CACHEY_PROXY_URL");
  const user = env("CACHEY_BASIC_USER");
  const pass = env("CACHEY_BASIC_PASS");

  if (!base || !user || !pass) {
    return bestEffortOk({
      source: "canon-fallback",
      schema: canonSchema(),
      warning: "proxy env not configured; using CANON",
    });
  }

  const inUrl = new URL(req.url);
  const qs = inUrl.searchParams.toString();

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
      cache: "no-store",
    });

    const data = (await resp.json().catch(() => null)) as UpstreamSchemaResponse | null;

    if (!resp.ok || !data?.ok) {
      const msg =
        (data && typeof data === "object" && data.error && String(data.error)) ||
        `schema upstream failed (HTTP ${resp.status})`;

      return bestEffortOk({
        source: "proxy-fallback",
        schema: canonSchema(),
        warning: msg,
        upstreamUrl,
      });
    }

    const shape: SchemaShape = data.schema ?? {
      partners: data.partners,
      services: data.services,
      regions: data.regions,
      pops: data.pops,
      contentTypes: data.contentTypes,
      uaFamilies: data.uaFamilies,
    };

    const schema: NormalizedSchema = normalizeSchemaShape(shape);

    return bestEffortOk({
      source: "proxy",
      schema,
      context: data.context ?? undefined,
      availableRegions: Array.isArray(data.availableRegions) ? data.availableRegions.map(String) : undefined,
      availablePops: Array.isArray(data.availablePops) ? data.availablePops.map(String) : undefined,
      upstreamUrl,
    });
  } catch (err: any) {
    return bestEffortOk({
      source: "proxy-fallback",
      schema: canonSchema(),
      warning: err?.message || "schema proxy failed",
      upstreamUrl,
    });
  }
}
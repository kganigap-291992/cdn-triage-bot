"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";
import type { TriageResponse } from "@/lib/triage/contracts";
import { CANON } from "@/lib/schema/canonical";
import { parseTriageIntent } from "@/lib/triage/intent";
import { resolveNamedTimeWindow } from "@/lib/triage/resolveNamedTimeWindow";

// ── constants ──────────────────────────────────────────────────────────────
const LOGO_SRC = "/cachey-logo.png";
const PARTNER_KEY = "cachey:partner";
const SERVICE_KEY = "cachey:service";
const FILTERS_KEY = "cachey:filters";
const FILTERS_TTL_MS = 10 * 60 * 1000;
const PARTNER_OPTIONS = CANON.partners;
const SERVICE_OPTIONS = CANON.services;
const GRID_STROKE = "rgba(255,255,255,0.06)";

// ── types ──────────────────────────────────────────────────────────────────
type Partner = (typeof CANON.partners)[number];
type PartnerOrMissing = Partner | "";
type DataSource = "clickhouse";
type TimeMode = "relative" | "absolute";

type TriageInputs = {
  dataSource: DataSource;
  partner: PartnerOrMissing;
  service: string;
  region: string;
  pop: string;
  windowMinutes: number;
  startTsUtc?: string | null;
  endTsUtc?: string | null;
  contentType: string;
  uaFamily: string;
};

type ChatText = {
  id: string;
  type: "text";
  role: "system" | "user" | "assistant";
  ts: string;
  text: string;
};

type ChatTriage = {
  id: string;
  type: "triage";
  role: "assistant";
  ts: string;
  run: {
    inputs: TriageInputs;
    summaryText: string;
    metricsJson: any;
    sql?: { queries: string[]; params?: Record<string, any> } | null;
    swarm?: {
      assessment?: {
        overallStatus?: "ok" | "warn" | "critical";
        primarySignal?: "traffic" | "latency" | "errors" | "cache" | "mixed";
        summary?: string;
        keyFindings?: string[];
        metadata?: {
          table?: string;
          bucketSeconds?: number;
          timeMode?: "relative" | "absolute";
          startTs?: string;
          endTs?: string;
          compareStartTs?: string;
          compareEndTs?: string;
        };
      };
      agents?: Array<{
        agentId?: "scope" | "traffic" | "latency" | "errors" | "cache";
        agent?: "scope" | "traffic" | "latency" | "errors" | "cache";
        title?: string;
        status: "ok" | "warn" | "critical";
        summary: string;
      }>;
    } | null;
    scopeSource?: "filters" | "chat";
    chatContext?: {
      rawText: string;
      parseMode: "filters-default" | "chat-overrides";
      detected: Record<string, any>;
    } | null;
  };
};

type ChatDrill = {
  id: string;
  type: "drill";
  role: "assistant";
  ts: string;
  drill: any;
  summaryText: string;
};

type ChatMsg = ChatText | ChatTriage | ChatDrill;

type TimeseriesPoint = {
  ts: string;
  totalRequests: number;
  error5xxCount: number;
  errorRatePct: number;
  p95TtmsMs: number | null;
  p99TtmsMs: number | null;
  cacheHitRate?: number | null;
  crcErrorCount?: number;
  statusCountsByCode?: Record<string, number>;
};

type HostSeriesItem = {
  host: string;
  totalRequests: number;
  error5xxCount: number;
  crcErrorCount: number;
  errorRatePct: number;
  p95TtmsMs: number | null;
  p99TtmsMs: number | null;
};

type CrcSeriesItem = {
  ts: string;
  crcErrorCount: number;
};

type TimeseriesData = {
  bucketSeconds: number | null;
  startTs: string | null;
  endTs: string | null;
  points: TimeseriesPoint[];
  statusCodeSeries?: string[];
  hostSeries?: HostSeriesItem[];
  crcSeries?: CrcSeriesItem[];
};

type SchemaState = {
  partners: string[];
  services: string[];
  regions: string[];
  pops: string[];
  contentTypes: string[];
  uaFamilies: string[];
};

type InvestigationScope = {
  partner: PartnerOrMissing;
  service: string;
  region: string;
  pop: string;
  contentType: string;
  uaFamily: string;
};

type InvestigationTimeContext = {
  mode: "relative" | "absolute";
  windowMinutes: number;
  startTsUtc: string | null;
  endTsUtc: string | null;
};

type InvestigationWorstCandidate = {
  value: string;
  errorRatePct: number | null;
  p95TtmsMs: number | null;
  cacheHitRate: number | null;
  totalRequests: number | null;
  source: string;
};

type InvestigationContext = {
  baseScope: InvestigationScope;
  time: InvestigationTimeContext;
  worstRegion: InvestigationWorstCandidate | null;
  worstPop: InvestigationWorstCandidate | null;
  availableDimensions: {
    regions: string[];
    pops: string[];
    contentTypes: string[];
    uaFamilies: string[];
  };
};

// ── pure helpers ───────────────────────────────────────────────────────────

function nowIso() {
  return new Date().toISOString();
}
function safeGetLS(key: string) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function safeSetLS(key: string, val: string) {
  try {
    localStorage.setItem(key, val);
  } catch {}
}
function safeDelLS(key: string) {
  try {
    localStorage.removeItem(key);
  } catch {}
}
function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}
function formatMsOrNA(x: number | null | undefined): string {
  if (x == null || !Number.isFinite(Number(x))) return "n/a";
  return `${Math.round(Number(x))} ms`;
}
function formatPctOrNA(x: number | null | undefined): string {
  if (x == null || !Number.isFinite(Number(x))) return "n/a";
  return `${Number(x).toFixed(2)}%`;
}
function formatIntOrNA(x: number | null | undefined): string {
  if (x == null || !Number.isFinite(Number(x))) return "0";
  return `${Math.round(Number(x)).toLocaleString()}`;
}
function windowMinutesFromRange(
  startIso?: string | null,
  endIso?: string | null,
  fallback = 120
) {
  if (!startIso || !endIso) return fallback;
  const s = new Date(startIso).getTime();
  const e = new Date(endIso).getTime();
  if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) return fallback;
  return Math.max(1, Math.round((e - s) / 60000));
}
function bucketLabel(bucketSeconds: number | null | undefined) {
  const s = Number(bucketSeconds || 0);
  if (!Number.isFinite(s) || s <= 0) return "bucket";
  if (s % 3600 === 0) return `${s / 3600}h`;
  if (s % 60 === 0) return `${s / 60}m`;
  return `${s}s`;
}
function formatCountTick(v: number): string {
  const n = Number(v);
  if (!Number.isFinite(n)) return "";
  const abs = Math.abs(n);
  if (abs >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return Math.round(n).toString();
}
function formatUtcHM(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(
    d.getUTCMinutes()
  ).padStart(2, "0")}`;
}
function formatUtcYmdHm(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, "0");
  const da = String(d.getUTCDate()).padStart(2, "0");
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${y}-${mo}-${da} ${hh}:${mm}`;
}
function timeLabelShort(tsIso: string, spanMinutes: number) {
  if (spanMinutes <= 180) return formatUtcHM(tsIso);
  if (spanMinutes <= 1440) {
    const d = new Date(tsIso);
    if (Number.isNaN(d.getTime())) return tsIso;
    const mo = String(d.getUTCMonth() + 1).padStart(2, "0");
    const da = String(d.getUTCDate()).padStart(2, "0");
    const hh = String(d.getUTCHours()).padStart(2, "0");
    const mm = String(d.getUTCMinutes()).padStart(2, "0");
    return `${mo}-${da} ${hh}:${mm}`;
  }
  const d = new Date(tsIso);
  if (Number.isNaN(d.getTime())) return tsIso;
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(
    2,
    "0"
  )}-${String(d.getUTCDate()).padStart(2, "0")}`;
}
function isoToDatetimeLocalUtc(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, "0");
  const da = String(d.getUTCDate()).padStart(2, "0");
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${y}-${mo}-${da}T${hh}:${mm}`;
}
function parseDatetimeLocalAsUtcToIso(v: string): string | null {
  const raw = String(v || "").trim();
  if (!raw) return null;
  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
  if (!m) return null;
  const dt = new Date(
    Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], 0, 0)
  );
  return Number.isNaN(dt.getTime()) ? null : dt.toISOString();
}
function isoToUtcText(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, "0");
  const da = String(d.getUTCDate()).padStart(2, "0");
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${y}-${mo}-${da} ${hh}:${mm}`;
}
function computeWindowPreview(startLocal: string, endLocal: string): string {
  const s = parseDatetimeLocalAsUtcToIso(startLocal);
  const e = parseDatetimeLocalAsUtcToIso(endLocal);
  if (!s || !e) return "";
  const mins = windowMinutesFromRange(s, e, 0);
  if (mins <= 0) return "invalid range";
  if (mins < 60) return `${mins}m window`;
  if (mins % 60 === 0) return `${mins / 60}h window`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m window`;
}

function detectRegionOverrideFromText(text: string): {
  mentioned: boolean;
  value: string | null;
  sourceText: string | null;
} {
  const raw = String(text || "").toLowerCase().trim();
  if (!raw) {
    return { mentioned: false, value: null, sourceText: null };
  }

  const patterns: Array<{ re: RegExp; value: string; sourceText: string }> = [
    { re: /\bus[\s-]*east\b/, value: "us-east", sourceText: "us east" },
    { re: /\bus[\s-]*west\b/, value: "us-west", sourceText: "us west" },
    { re: /\bus[\s-]*central\b/, value: "us-central", sourceText: "us central" },
    { re: /\beu[\s-]*west\b/, value: "eu-west", sourceText: "eu west" },
    { re: /\beu[\s-]*central\b/, value: "eu-central", sourceText: "eu central" },
    { re: /\bap[\s-]*south\b/, value: "ap-south", sourceText: "ap south" },
    { re: /\bap[\s-]*northeast\b/, value: "ap-northeast", sourceText: "ap northeast" },
    { re: /\bsa[\s-]*east\b/, value: "sa-east", sourceText: "sa east" },
  ];

  for (const entry of patterns) {
    if (entry.re.test(raw)) {
      return {
        mentioned: true,
        value: entry.value,
        sourceText: entry.sourceText,
      };
    }
  }

  const explicitRegionMatch = raw.match(
    /\bregion\s+([a-z0-9-]+(?:\s+[a-z0-9-]+){0,2})\b/i
  );
  if (explicitRegionMatch) {
    return {
      mentioned: true,
      value: null,
      sourceText: explicitRegionMatch[1]?.trim() || "unknown region",
    };
  }

  return { mentioned: false, value: null, sourceText: null };
}

function detectPopOverrideFromText(text: string): {
  mentioned: boolean;
  value: string | null;
  sourceText: string | null;
} {
  const raw = String(text || "").toLowerCase().trim();
  if (!raw) {
    return { mentioned: false, value: null, sourceText: null };
  }

  const explicitPop = raw.match(/\bpop[_\s-]?(\d{1,3})\b/i);
  if (explicitPop) {
    const num = explicitPop[1].padStart(3, "0");
    return {
      mentioned: true,
      value: `pop_${num}`,
      sourceText: explicitPop[0],
    };
  }

  const directional = raw.match(/\b(?:east|west|central|south|northeast)\s+(\d{1,2})\b/);
  if (directional) {
    const num = directional[1].padStart(3, "0");
    return {
      mentioned: true,
      value: `pop_${num}`,
      sourceText: directional[0],
    };
  }

  if (/\bpop\b/i.test(raw)) {
    return {
      mentioned: true,
      value: null,
      sourceText: "pop",
    };
  }

  return { mentioned: false, value: null, sourceText: null };
}

function detectUaFamilyOverrideFromText(text: string): {
  mentioned: boolean;
  value: string | null;
  sourceText: string | null;
} {
  const raw = String(text || "").toLowerCase().trim();
  if (!raw) {
    return { mentioned: false, value: null, sourceText: null };
  }

  const patterns: Array<{ re: RegExp; value: string; sourceText: string }> = [
    { re: /\bmobile\b/i, value: "mobile", sourceText: "mobile" },
    { re: /\bweb\b/i, value: "web", sourceText: "web" },
    { re: /\bstb\b/i, value: "stb", sourceText: "stb" },
    { re: /\bsmart[\s_:-]*tv\b/i, value: "smart_tv", sourceText: "smart tv" },
    { re: /\bconsole\b/i, value: "console", sourceText: "console" },
  ];

  for (const entry of patterns) {
    if (entry.re.test(raw)) {
      return {
        mentioned: true,
        value: entry.value,
        sourceText: entry.sourceText,
      };
    }
  }

  const explicitUaMatch = raw.match(
    /\b(?:ua|ua family|device|device type)\s+([a-z0-9_-]+(?:\s+[a-z0-9_-]+){0,2})\b/i
  );
  if (explicitUaMatch) {
    return {
      mentioned: true,
      value: null,
      sourceText: explicitUaMatch[1]?.trim() || "unknown ua family",
    };
  }

  return { mentioned: false, value: null, sourceText: null };
}

function detectContentTypeOverrideFromText(text: string): {
  mentioned: boolean;
  value: string | null;
  sourceText: string | null;
} {
  const raw = String(text || "").toLowerCase().trim();
  if (!raw) {
    return { mentioned: false, value: null, sourceText: null };
  }

  const patterns: Array<{ re: RegExp; value: string; sourceText: string }> = [
    { re: /\bmanifest(?:s)?\b/i, value: "manifest", sourceText: "manifest" },
    { re: /\bsegment(?:s)?\b/i, value: "segment", sourceText: "segment" },
    { re: /\bapi\b/i, value: "api", sourceText: "api" },
  ];

  for (const entry of patterns) {
    if (entry.re.test(raw)) {
      return {
        mentioned: true,
        value: entry.value,
        sourceText: entry.sourceText,
      };
    }
  }

  const explicitContentMatch = raw.match(
    /\b(?:content\s*type|content)\s+([a-z0-9_-]+(?:\s+[a-z0-9_-]+){0,2})\b/i
  );
  if (explicitContentMatch) {
    return {
      mentioned: true,
      value: null,
      sourceText: explicitContentMatch[1]?.trim() || "unknown content type",
    };
  }

  return { mentioned: false, value: null, sourceText: null };
}

// ── color helpers ──────────────────────────────────────────────────────────
function stableColorForKey(key: string) {
  const palette = [
    "#2563eb",
    "#60a5fa",
    "#9ca3af",
    "#f59e0b",
    "#f97316",
    "#f43f5e",
    "#ef4444",
    "#fb7185",
    "#dc2626",
    "#7f1d1d",
    "#10b981",
    "#22c55e",
    "#0ea5e9",
    "#a78bfa",
    "#facc15",
    "#14b8a6",
  ];
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return palette[h % palette.length];
}
function statusColorForCode(code: string) {
  switch (code) {
    case "200":
    case "206":
      return "#22c55e";
    case "304":
      return "#14b8a6";
    case "403":
    case "404":
    case "429":
      return "#f59e0b";
    case "500":
      return "#ef4444";
    case "502":
      return "#dc2626";
    case "503":
      return "#f43f5e";
    case "504":
      return "#7f1d1d";
    default:
      return stableColorForKey(code);
  }
}
function seriesColor(kind: "status" | "host" | "crc", key: string) {
  if (kind === "status") return statusColorForCode(key);
  return stableColorForKey(key);
}
function severityPillClass(status?: "ok" | "warn" | "critical") {
  switch (status) {
    case "ok":
      return "border-emerald-400/30 bg-emerald-400/10 text-emerald-200";
    case "warn":
      return "border-amber-400/30 bg-amber-400/10 text-amber-200";
    case "critical":
      return "border-red-400/30 bg-red-400/10 text-red-200";
    default:
      return "border-white/10 bg-white/10 text-gray-200";
  }
}
function signalLabel(
  signal?: "traffic" | "latency" | "errors" | "cache" | "mixed"
) {
  if (!signal) return "n/a";
  return String(signal);
}
function uiStatusLabel(status?: "ok" | "warn" | "critical", isLoading?: boolean) {
  if (isLoading) return "Running triage…";
  switch (status) {
    case "ok":
      return "OK";
    case "warn":
      return "WARN";
    case "critical":
      return "CRITICAL";
    default:
      return "Idle";
  }
}
function uiStatusClass(status?: "ok" | "warn" | "critical", isLoading?: boolean) {
  if (isLoading) return "text-blue-300";
  switch (status) {
    case "ok":
      return "text-emerald-300";
    case "warn":
      return "text-amber-300";
    case "critical":
      return "text-red-300";
    default:
      return "text-gray-300";
  }
}

function buildChatInputsFromIntent(args: {
  parseResult: ReturnType<typeof parseTriageIntent>;
  resolvedPartner: PartnerOrMissing;
  resolvedService: string;
  region: string;
  pop: string;
  windowMinutes: number;
  contentType: string;
  uaFamily: string;
  allowedRegions: string[];
  allowedPops: string[];
  allowedContentTypes: string[];
  allowedUaFamilies: string[];
  now?: Date;
}):
  | {
      ok: true;
      inputs: TriageInputs;
      chatContext: {
        rawText: string;
        parseMode: "filters-default" | "chat-overrides";
        detected: Record<string, any>;
      };
    }
  | { ok: false; error: string } {
  const { parseResult } = args;

  const detected: Record<string, any> = {
    intentKind: parseResult.intentKind,
    shouldTrigger: parseResult.shouldTrigger,
    requiresPriorContext: parseResult.requiresPriorContext,
    confidence: parseResult.confidence,
    debug: parseResult.debug ?? null,
    metricHints: parseResult.metricHints ?? [],
    timeMeta: parseResult.timeMeta ?? null,
    missingPartner: parseResult.missingPartner,
    missingService: parseResult.missingService,
  };

  let parseMode: "filters-default" | "chat-overrides" = "filters-default";

  const partner = args.resolvedPartner;
  const service = args.resolvedService || "";

  const regionDetection = detectRegionOverrideFromText(parseResult.rawText);
  const popDetection = detectPopOverrideFromText(parseResult.rawText);
  const uaDetection = detectUaFamilyOverrideFromText(parseResult.rawText);
  const contentTypeDetection = detectContentTypeOverrideFromText(parseResult.rawText);

  const detectedRegion =
    regionDetection.value && (args.allowedRegions || []).includes(regionDetection.value)
      ? regionDetection.value
      : null;

  const detectedPop =
    popDetection.value && (args.allowedPops || []).includes(popDetection.value)
      ? popDetection.value
      : null;

  const detectedUaFamily =
    uaDetection.value && (args.allowedUaFamilies || []).includes(uaDetection.value)
      ? uaDetection.value
      : null;

  const detectedContentType =
    contentTypeDetection.value &&
    (args.allowedContentTypes || []).includes(contentTypeDetection.value)
      ? contentTypeDetection.value
      : null;

  const region = detectedRegion || args.region || "all";
  const pop = detectedPop || args.pop || "all";
  const contentType = detectedContentType || args.contentType || "all";
  const uaFamily = detectedUaFamily || args.uaFamily || "all";

  if (parseResult.partnerCanonical) {
    detected.partnerCanonical = parseResult.partnerCanonical;
    parseMode = "chat-overrides";
  }

  if (parseResult.serviceCanonical) {
    detected.serviceCanonical = parseResult.serviceCanonical;
    parseMode = "chat-overrides";
  }

  if (regionDetection.mentioned) {
    detected.regionMentioned = regionDetection.sourceText;

    if (!regionDetection.value) {
      return {
        ok: false,
        error: `I couldn't resolve region "${regionDetection.sourceText || "unknown"}". Use one of: ${(args.allowedRegions || []).join(", ")}.`,
      };
    }

    if (!(args.allowedRegions || []).includes(regionDetection.value)) {
      return {
        ok: false,
        error: `Region "${regionDetection.value}" is valid, but it is not available in the current scope. Available regions: ${(args.allowedRegions || []).join(", ")}.`,
      };
    }

    detected.region = regionDetection.value;
    parseMode = "chat-overrides";
  }

  if (popDetection.mentioned) {
    detected.popMentioned = popDetection.sourceText;

    if (!popDetection.value) {
      return {
        ok: false,
        error: `I couldn't resolve POP "${popDetection.sourceText || "unknown"}". Use one of: ${(args.allowedPops || []).join(", ")}.`,
      };
    }

    if (!(args.allowedPops || []).includes(popDetection.value)) {
      return {
        ok: false,
        error: `POP "${popDetection.value}" is valid, but it is not available in the current scope. Available POPs: ${(args.allowedPops || []).join(", ")}.`,
      };
    }

    detected.pop = popDetection.value;
    parseMode = "chat-overrides";
  }

  if (uaDetection.mentioned) {
    detected.uaFamilyMentioned = uaDetection.sourceText;

    if (!uaDetection.value) {
      return {
        ok: false,
        error: `I couldn't resolve device type "${uaDetection.sourceText || "unknown"}". Use one of: ${(args.allowedUaFamilies || []).join(", ")}.`,
      };
    }

    if (!(args.allowedUaFamilies || []).includes(uaDetection.value)) {
      return {
        ok: false,
        error: `Device type "${uaDetection.value}" is valid, but it is not available in the current scope. Available device types: ${(args.allowedUaFamilies || []).join(", ")}.`,
      };
    }

    detected.uaFamily = uaDetection.value;
    parseMode = "chat-overrides";
  }

  if (contentTypeDetection.mentioned) {
    detected.contentTypeMentioned = contentTypeDetection.sourceText;

    if (!contentTypeDetection.value) {
      return {
        ok: false,
        error: `I couldn't resolve content type "${contentTypeDetection.sourceText || "unknown"}". Use one of: ${(args.allowedContentTypes || []).join(", ")}.`,
      };
    }

    if (!(args.allowedContentTypes || []).includes(contentTypeDetection.value)) {
      return {
        ok: false,
        error: `Content type "${contentTypeDetection.value}" is valid, but it is not available in the current scope. Available content types: ${(args.allowedContentTypes || []).join(", ")}.`,
      };
    }

    detected.contentType = contentTypeDetection.value;
    parseMode = "chat-overrides";
  }
  
  if (!partner) {
    return {
      ok: false,
      error: `Pick a partner first. (${PARTNER_OPTIONS.join(", ")})`,
    };
  }

  if (!service) {
    return {
      ok: false,
      error: `Pick a service first. (${SERVICE_OPTIONS.join(", ")})`,
    };
  }

  let startTsUtc: string | null = null;
  let endTsUtc: string | null = null;
  let effectiveWindowMinutes = args.windowMinutes;

  if (parseResult.timeMeta?.kind === "absolute") {
    startTsUtc = parseResult.timeMeta.startTsUtc;
    endTsUtc = parseResult.timeMeta.endTsUtc;
    effectiveWindowMinutes = windowMinutesFromRange(
      startTsUtc,
      endTsUtc,
      args.windowMinutes
    );
    detected.startTsUtc = startTsUtc;
    detected.endTsUtc = endTsUtc;
    parseMode = "chat-overrides";
  } else if (parseResult.timeMeta?.kind === "relative") {
    effectiveWindowMinutes = parseResult.timeMeta.windowMinutes;
    detected.windowMinutes = effectiveWindowMinutes;
    parseMode = "chat-overrides";
  } else if (parseResult.timeMeta?.kind === "named") {
    const resolvedNamedTime = resolveNamedTimeWindow({
      key: parseResult.timeMeta.key,
      label: parseResult.timeMeta.label,
      matchedText: parseResult.timeMeta.sourceText,
      now: args.now ?? new Date(),
    });

    detected.namedTime = parseResult.timeMeta.label;
    detected.namedTimeKey = parseResult.timeMeta.key;
    detected.namedTimeSourceText = parseResult.timeMeta.sourceText;

    if (!resolvedNamedTime.ok) {
      detected.namedTimeResolution = resolvedNamedTime;
      return {
        ok: false,
        error: resolvedNamedTime.message,
      };
    }

    startTsUtc = resolvedNamedTime.startUtcIso;
    endTsUtc = resolvedNamedTime.endUtcIso;
    effectiveWindowMinutes = windowMinutesFromRange(
      startTsUtc,
      endTsUtc,
      args.windowMinutes
    );

    detected.namedTimeResolution = {
      key: resolvedNamedTime.key,
      label: resolvedNamedTime.label,
      timezone: resolvedNamedTime.timezone,
      startLocalIso: resolvedNamedTime.startLocalIso,
      endLocalIso: resolvedNamedTime.endLocalIso,
      startUtcIso: resolvedNamedTime.startUtcIso,
      endUtcIso: resolvedNamedTime.endUtcIso,
      timeMode: resolvedNamedTime.timeMode,
      source: resolvedNamedTime.source,
    };
    detected.startTsUtc = startTsUtc;
    detected.endTsUtc = endTsUtc;
    detected.windowMinutes = effectiveWindowMinutes;
    parseMode = "chat-overrides";
  }

  return {
    ok: true,
    inputs: {
      dataSource: "clickhouse",
      partner,
      service,
      region,
      pop,
      windowMinutes: effectiveWindowMinutes,
      startTsUtc,
      endTsUtc,
      contentType,
      uaFamily,
    },
    chatContext: {
      rawText: parseResult.rawText,
      parseMode,
      detected,
    },
  };
}

// ── parseTimeseries ────────────────────────────────────────────────────────
function parseTimeseries(metricsJson: any): TimeseriesData | null {
  const t = metricsJson?.timeseries;
  if (!t || !Array.isArray(t.points)) return null;

  const points: TimeseriesPoint[] = t.points
    .map(
      (p: any): TimeseriesPoint => ({
        ts: String(p.ts || ""),
        totalRequests: Number(p.totalRequests) || 0,
        error5xxCount: Number(p.error5xxCount) || 0,
        errorRatePct: Number(p.errorRatePct) || 0,
        p95TtmsMs: p.p95TtmsMs == null ? null : Number(p.p95TtmsMs),
        p99TtmsMs: p.p99TtmsMs == null ? null : Number(p.p99TtmsMs),
        cacheHitRate: p.cacheHitRate == null ? null : Number(p.cacheHitRate),
        crcErrorCount: Number(p.crcErrorCount || 0),
        statusCountsByCode: p.statusCountsByCode || undefined,
      })
    )
    .filter((pt: TimeseriesPoint) => Boolean(pt.ts));

  const hostSeries: HostSeriesItem[] = Array.isArray(t.hostSeries)
    ? t.hostSeries.map((h: any) => ({
        host: String(h.host || ""),
        totalRequests: Number(h.totalRequests || 0),
        error5xxCount: Number(h.error5xxCount || 0),
        crcErrorCount: Number(h.crcErrorCount || 0),
        errorRatePct: Number(h.errorRatePct || 0),
        p95TtmsMs: h.p95TtmsMs == null ? null : Number(h.p95TtmsMs),
        p99TtmsMs: h.p99TtmsMs == null ? null : Number(h.p99TtmsMs),
      }))
    : [];

  const crcSeries: CrcSeriesItem[] = Array.isArray(t.crcSeries)
    ? t.crcSeries
        .map((c: any) => ({
          ts: String(c.ts || ""),
          crcErrorCount: Number(c.crcErrorCount || 0),
        }))
        .filter((x: CrcSeriesItem) => Boolean(x.ts))
    : [];

  return {
    bucketSeconds: t.bucketSeconds == null ? null : Number(t.bucketSeconds),
    startTs: t.startTs ? String(t.startTs) : null,
    endTs: t.endTs ? String(t.endTs) : null,
    points,
    statusCodeSeries: Array.isArray(t.statusCodeSeries)
      ? t.statusCodeSeries.map(String)
      : undefined,
    hostSeries,
    crcSeries,
  };
}

// ── TypingDots ─────────────────────────────────────────────────────────────
function TypingDots() {
  return (
    <div className="inline-flex items-center gap-1">
      <span className="inline-block h-1.5 w-1.5 rounded-full bg-gray-300/70 animate-bounce [animation-delay:-0.2s]" />
      <span className="inline-block h-1.5 w-1.5 rounded-full bg-gray-300/70 animate-bounce [animation-delay:-0.1s]" />
      <span className="inline-block h-1.5 w-1.5 rounded-full bg-gray-300/70 animate-bounce" />
    </div>
  );
}

// ── StackedBarTimeseries ───────────────────────────────────────────────────
function StackedBarTimeseries({
  title,
  subtitle,
  ts,
  bucketSeconds,
  seriesKeys,
  getMap,
  height = 190,
  windowMinutes,
  kind,
}: {
  title: string;
  subtitle: string;
  ts: TimeseriesData;
  bucketSeconds: number | null;
  seriesKeys: string[];
  getMap: (p: TimeseriesPoint) => Record<string, number> | undefined;
  height?: number;
  windowMinutes: number;
  kind: "status" | "host" | "crc";
}) {
  const maxBars = windowMinutes <= 180 ? 60 : windowMinutes <= 1440 ? 144 : 180;
  const basePoints = (ts.points || []).slice(-maxBars);
  const [zoom, setZoom] = useState<{ start: number; end: number } | null>(null);
  const [focusedKey, setFocusedKey] = useState<string | null>(null);
  const points =
    zoom && zoom.end > zoom.start
      ? basePoints.slice(zoom.start, zoom.end + 1)
      : basePoints;
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [drag, setDrag] = useState<{ active: boolean; x0: number; x1: number }>({
    active: false,
    x0: 0,
    x1: 0,
  });

  if (!points.length) return null;

  const present = new Map<string, number>();
  for (const p of points) {
    const m = getMap(p) || {};
    for (const k of Object.keys(m)) {
      present.set(k, (present.get(k) ?? 0) + Number(m[k] ?? 0));
    }
  }

  const ordered = [
    ...seriesKeys.filter((k) => present.has(k)),
    ...Array.from(present.keys()).filter((k) => !seriesKeys.includes(k)),
  ];
  const allKeys = ordered.slice(0, 10);
  if (!allKeys.length) return null;

  const keys = focusedKey && allKeys.includes(focusedKey) ? [focusedKey] : allKeys;

  const totals = points.map((p) => {
    const m = getMap(p) || {};
    let sum = 0;
    for (const k of keys) sum += Number(m[k] ?? 0);
    return sum;
  });
  const maxTotal = Math.max(1, ...totals);

  const w = 360;
  const h = height;
  const padLeft = 54;
  const padRight = 12;
  const padTop = 12;
  const padBottom = 44;
  const plotW = w - padLeft - padRight;
  const plotH = h - padTop - padBottom;

  const barCount = points.length;
  const gap = clamp(Math.round(plotW / (Math.max(1, barCount) * 10)), 2, 6);
  const barW = Math.max(
    4,
    Math.floor((plotW - gap * Math.max(0, barCount - 1)) / Math.max(1, barCount))
  );

  const yTicks = 4;
  const tickVals = Array.from({ length: yTicks + 1 }, (_, i) =>
    Math.round((maxTotal * (yTicks - i)) / yTicks)
  );
  const xLabelEvery = Math.max(1, Math.floor(points.length / 6));
  const latest = points[points.length - 1];
  const latestTotal = totals[totals.length - 1] || 0;

  function toSvgX(clientX: number) {
    const el = svgRef.current;
    if (!el) return 0;
    const r = el.getBoundingClientRect();
    return ((clientX - r.left) / Math.max(1, r.width)) * w;
  }

  function idxFromSvgX(sx: number) {
    return clamp(
      Math.floor((sx - padLeft) / Math.max(1, barW + gap)),
      0,
      Math.max(0, basePoints.length - 1)
    );
  }

  function commitZoom(x0: number, x1: number) {
    const i0 = idxFromSvgX(Math.min(x0, x1));
    const i1 = idxFromSvgX(Math.max(x0, x1));
    if (i1 - i0 >= 2) setZoom({ start: i0, end: i1 });
  }

  const selectionX = Math.min(drag.x0, drag.x1);
  const selectionW = Math.abs(drag.x1 - drag.x0);

  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.04] backdrop-blur p-4 min-w-0">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-xs text-gray-400">{subtitle}</div>
          <div className="text-sm font-semibold text-gray-100">{title}</div>
          <div className="text-[11px] text-gray-400 mt-1">
            {ts.startTs && ts.endTs
              ? `${formatUtcYmdHm(ts.startTs)} → ${formatUtcYmdHm(
                  ts.endTs
                )} UTC (bucket: ${bucketLabel(bucketSeconds)})`
              : `bucket: ${bucketLabel(bucketSeconds)} (UTC)`}
          </div>
          <div className="text-[11px] text-gray-500 mt-1">
            {focusedKey ? (
              <>
                Focused: <span className="text-gray-200">{focusedKey}</span>
                <button
                  type="button"
                  className="ml-2 underline hover:text-gray-300"
                  onClick={() => setFocusedKey(null)}
                >
                  reset focus
                </button>
              </>
            ) : (
              <>Click legend to isolate • Drag to zoom • double-click to reset</>
            )}
          </div>
        </div>
        <div className="text-right">
          <div className="text-xs text-gray-400">Latest</div>
          <div className="text-[11px] text-gray-200">
            {latest
              ? `${formatUtcHM(latest.ts)} UTC • ${latestTotal.toLocaleString()} events`
              : "n/a"}
          </div>
        </div>
      </div>

      <div className="mt-3 rounded-2xl border border-white/10 bg-black/25 p-3">
        <svg
          viewBox={`0 0 ${w} ${h}`}
          className="w-full"
          style={{ height, touchAction: "none", cursor: "crosshair" }}
          ref={svgRef}
          onDoubleClick={() => setZoom(null)}
          onPointerDown={(e) => {
            const sx = toSvgX(e.clientX);
            setDrag({ active: true, x0: sx, x1: sx });
            (e.currentTarget as any).setPointerCapture?.(e.pointerId);
          }}
          onPointerMove={(e) => {
            if (!drag.active) return;
            setDrag((d) => ({ ...d, x1: toSvgX(e.clientX) }));
          }}
          onPointerUp={() => {
            if (!drag.active) return;
            const { x0, x1 } = drag;
            setDrag({ active: false, x0: 0, x1: 0 });
            commitZoom(x0, x1);
          }}
          onPointerCancel={() => setDrag({ active: false, x0: 0, x1: 0 })}
          onPointerLeave={() => {
            if (!drag.active) return;
            setDrag({ active: false, x0: 0, x1: 0 });
          }}
        >
          <text
            x={padLeft - 38}
            y={padTop + plotH / 2}
            fontSize="10"
            fill="#9ca3af"
            transform={`rotate(-90 ${padLeft - 38} ${padTop + plotH / 2})`}
          >
            Events
          </text>
          <text
            x={padLeft + plotW / 2}
            y={h - 10}
            fontSize="10"
            fill="#9ca3af"
            textAnchor="middle"
          >
            Time (UTC, {bucketLabel(bucketSeconds)} buckets)
          </text>

          {tickVals.map((v, idx) => {
            const y = padTop + (1 - v / maxTotal) * plotH;
            return (
              <g key={idx}>
                <line
                  x1={padLeft}
                  y1={y}
                  x2={padLeft + plotW}
                  y2={y}
                  stroke={GRID_STROKE}
                />
                <text
                  x={padLeft - 10}
                  y={y + 3}
                  fontSize="10"
                  fill="#9ca3af"
                  textAnchor="end"
                  opacity={0.95}
                >
                  {formatCountTick(v)}
                </text>
              </g>
            );
          })}

          {points.map((p, i) => {
            const x = padLeft + i * (barW + gap);
            const m = getMap(p) || {};
            let yTop = padTop + plotH;
            return (
              <g key={p.ts}>
                {keys.map((k) => {
                  const val = Number(m[k] ?? 0);
                  if (!val) return null;
                  const segH = (val / maxTotal) * plotH;
                  const y = yTop - segH;
                  yTop = y;
                  return (
                    <rect
                      key={`${p.ts}-${k}`}
                      x={x}
                      y={y}
                      width={barW}
                      height={Math.max(0, segH)}
                      rx={2}
                      fill={seriesColor(kind, k)}
                      opacity={0.9}
                    />
                  );
                })}
              </g>
            );
          })}

          {points.map((p, i) => {
            if (i % xLabelEvery !== 0 && i !== points.length - 1) return null;
            return (
              <text
                key={`xl-${p.ts}`}
                x={padLeft + i * (barW + gap) + barW / 2}
                y={padTop + plotH + 18}
                fontSize="10"
                fill="#9ca3af"
                textAnchor="middle"
              >
                {timeLabelShort(p.ts, windowMinutes)}
              </text>
            );
          })}

          {drag.active && selectionW > 2 && (
            <rect
              x={selectionX}
              y={padTop}
              width={selectionW}
              height={plotH}
              fill="rgba(59,130,246,0.12)"
              stroke="rgba(59,130,246,0.55)"
              strokeWidth={1}
              rx={6}
            />
          )}
        </svg>

        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-[11px] text-gray-300">
          {allKeys.map((k) => {
            const active = focusedKey ? focusedKey === k : true;
            return (
              <button
                key={k}
                type="button"
                onClick={() => setFocusedKey((prev) => (prev === k ? null : k))}
                className={`flex items-center gap-1.5 rounded-full border px-2 py-1 transition ${
                  active
                    ? "border-white/10 bg-white/5 text-gray-100"
                    : "border-white/5 bg-white/[0.02] text-gray-500"
                }`}
              >
                <span
                  className="inline-block h-2.5 w-2.5 rounded-full"
                  style={{ background: seriesColor(kind, k) }}
                />
                <span className="truncate max-w-[220px]">{k}</span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ── RequestsErrorRateLines ─────────────────────────────────────────────────
function RequestsErrorRateLines({
  points,
  bucketSeconds,
  height = 190,
  windowMinutes,
}: {
  points: TimeseriesPoint[];
  bucketSeconds: number | null;
  height?: number;
  windowMinutes: number;
}) {
  const maxBars = windowMinutes <= 180 ? 60 : windowMinutes <= 1440 ? 144 : 180;
  const base = points.slice(-maxBars);
  const [zoom, setZoom] = useState<{ start: number; end: number } | null>(null);
  const slice = zoom && zoom.end > zoom.start ? base.slice(zoom.start, zoom.end + 1) : base;
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [drag, setDrag] = useState<{ active: boolean; x0: number; x1: number }>({
    active: false,
    x0: 0,
    x1: 0,
  });

  if (!slice.length) return null;

  const reqVals = slice.map((p) => Number(p.totalRequests || 0));
  const errVals = slice.map((p) =>
    Number.isFinite(Number(p.errorRatePct))
      ? Number(p.errorRatePct)
      : p.totalRequests > 0
      ? (Number(p.error5xxCount || 0) / Number(p.totalRequests)) * 100
      : 0
  );

  const reqMax = Math.max(1, ...reqVals);
  const errMax = Math.max(0.5, Math.max(0, ...errVals) * 1.2 || 0.5);

  const w = 360;
  const h = height;
  const padLeft = 54;
  const padRight = 44;
  const padTop = 12;
  const padBottom = 44;
  const plotW = w - padLeft - padRight;
  const plotH = h - padTop - padBottom;
  const n = slice.length;
  const denom = Math.max(1, n - 1);

  function x(i: number) {
    return padLeft + (i / denom) * plotW;
  }
  function yReq(v: number) {
    return padTop + (1 - v / reqMax) * plotH;
  }
  function yErr(v: number) {
    return padTop + (1 - v / errMax) * plotH;
  }

  const reqPts: string[] = [];
  const errPts: string[] = [];
  slice.forEach((p, i) => {
    reqPts.push(`${x(i)},${yReq(Number(p.totalRequests || 0))}`);
    const err = Number.isFinite(Number(p.errorRatePct))
      ? Number(p.errorRatePct)
      : p.totalRequests > 0
      ? (Number(p.error5xxCount || 0) / Number(p.totalRequests)) * 100
      : 0;
    errPts.push(`${x(i)},${yErr(err)}`);
  });

  const xLabelEvery = Math.max(1, Math.floor(n / 6));
  const latest = slice[slice.length - 1];
  const latestErr =
    latest && Number.isFinite(Number(latest.errorRatePct))
      ? Number(latest.errorRatePct)
      : latest && latest.totalRequests > 0
      ? (Number(latest.error5xxCount || 0) / Number(latest.totalRequests)) * 100
      : 0;

  function toSvgX(clientX: number) {
    const el = svgRef.current;
    if (!el) return 0;
    return ((clientX - el.getBoundingClientRect().left) / Math.max(1, el.getBoundingClientRect().width)) * w;
  }
  function idxFromSvgX(sx: number) {
    return clamp(
      Math.round(((sx - padLeft) / Math.max(1, plotW)) * (base.length - 1)),
      0,
      Math.max(0, base.length - 1)
    );
  }
  function commitZoom(x0: number, x1: number) {
    const i0 = idxFromSvgX(Math.min(x0, x1));
    const i1 = idxFromSvgX(Math.max(x0, x1));
    if (i1 - i0 >= 2) setZoom({ start: i0, end: i1 });
  }
  const selectionX = Math.min(drag.x0, drag.x1);
  const selectionW = Math.abs(drag.x1 - drag.x0);

  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.04] backdrop-blur p-4 min-w-0">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-xs text-gray-400">Traffic + incident signal</div>
          <div className="text-sm font-semibold text-gray-100">Requests / Error Rate</div>
          <div className="text-[11px] text-gray-400 mt-1">
            {slice.length
              ? `${formatUtcYmdHm(slice[0].ts)} → ${formatUtcYmdHm(
                  slice[slice.length - 1].ts
                )} UTC (bucket: ${bucketLabel(bucketSeconds)})`
              : `bucket: ${bucketLabel(bucketSeconds)} (UTC)`}
          </div>
          <div className="text-[11px] text-gray-500 mt-1">
            Drag to zoom • double-click to reset
          </div>
        </div>
        <div className="text-right">
          <div className="text-xs text-gray-400">Latest</div>
          <div className="text-[11px] text-gray-200">
            {latest
              ? `${formatUtcHM(latest.ts)} UTC • req=${formatIntOrNA(
                  latest.totalRequests
                )} • err=${formatPctOrNA(latestErr)}`
              : "n/a"}
          </div>
        </div>
      </div>

      <div className="mt-3 rounded-2xl border border-white/10 bg-black/25 p-3">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${w} ${h}`}
          className="w-full"
          style={{ height, touchAction: "none", cursor: "crosshair" }}
          onDoubleClick={() => setZoom(null)}
          onPointerDown={(e) => {
            const sx = toSvgX(e.clientX);
            setDrag({ active: true, x0: sx, x1: sx });
            (e.currentTarget as any).setPointerCapture?.(e.pointerId);
          }}
          onPointerMove={(e) => {
            if (!drag.active) return;
            setDrag((d) => ({ ...d, x1: toSvgX(e.clientX) }));
          }}
          onPointerUp={() => {
            if (!drag.active) return;
            const { x0, x1 } = drag;
            setDrag({ active: false, x0: 0, x1: 0 });
            commitZoom(x0, x1);
          }}
          onPointerCancel={() => setDrag({ active: false, x0: 0, x1: 0 })}
          onPointerLeave={() => {
            if (!drag.active) return;
            setDrag({ active: false, x0: 0, x1: 0 });
          }}
        >
          <text
            x={padLeft - 38}
            y={padTop + plotH / 2}
            fontSize="10"
            fill="#9ca3af"
            transform={`rotate(-90 ${padLeft - 38} ${padTop + plotH / 2})`}
          >
            Requests
          </text>
          <text
            x={w - padRight + 28}
            y={padTop + plotH / 2}
            fontSize="10"
            fill="#9ca3af"
            transform={`rotate(90 ${w - padRight + 28} ${padTop + plotH / 2})`}
          >
            Error %
          </text>

          {[0, 0.25, 0.5, 0.75, 1].map((t, idx) => {
            const yy = padTop + (1 - t) * plotH;
            return (
              <g key={idx}>
                <line
                  x1={padLeft}
                  y1={yy}
                  x2={padLeft + plotW}
                  y2={yy}
                  stroke={GRID_STROKE}
                />
                <text
                  x={padLeft - 10}
                  y={yy + 3}
                  fontSize="10"
                  fill="#9ca3af"
                  textAnchor="end"
                >
                  {formatCountTick(Math.round(reqMax * t))}
                </text>
                <text
                  x={padLeft + plotW + 10}
                  y={yy + 3}
                  fontSize="10"
                  fill="#9ca3af"
                  textAnchor="start"
                >
                  {(errMax * t).toFixed(2)}%
                </text>
              </g>
            );
          })}

          <polyline
            fill="none"
            stroke="rgba(59,130,246,0.88)"
            strokeWidth="2.75"
            strokeLinecap="round"
            strokeLinejoin="round"
            points={reqPts.join(" ")}
          />
          <polyline
            fill="none"
            stroke="rgba(239,68,68,0.88)"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            points={errPts.join(" ")}
          />

          {slice.map((p, i) => {
            if (i % xLabelEvery !== 0 && i !== slice.length - 1) return null;
            return (
              <text
                key={`xl-${p.ts}`}
                x={x(i)}
                y={padTop + plotH + 18}
                fontSize="10"
                fill="#9ca3af"
                textAnchor="middle"
              >
                {timeLabelShort(p.ts, windowMinutes)}
              </text>
            );
          })}

          {drag.active && selectionW > 2 && (
            <rect
              x={selectionX}
              y={padTop}
              width={selectionW}
              height={plotH}
              fill="rgba(59,130,246,0.12)"
              stroke="rgba(59,130,246,0.55)"
              strokeWidth={1}
              rx={6}
            />
          )}
        </svg>

        <div className="mt-3 flex items-center justify-center gap-5 text-[11px] text-gray-300">
          <div className="flex items-center gap-1.5">
            <span
              className="inline-block h-2.5 w-2.5 rounded-full"
              style={{ background: "rgba(59,130,246,0.88)" }}
            />
            <span>requests</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span
              className="inline-block h-2.5 w-2.5 rounded-full"
              style={{ background: "rgba(239,68,68,0.88)" }}
            />
            <span>error rate</span>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── LatencyTimeseriesLines ─────────────────────────────────────────────────
function LatencyTimeseriesLines({
  points,
  bucketSeconds,
  height = 190,
  windowMinutes,
}: {
  points: TimeseriesPoint[];
  bucketSeconds: number | null;
  height?: number;
  windowMinutes: number;
}) {
  const maxBars = windowMinutes <= 180 ? 60 : windowMinutes <= 1440 ? 144 : 180;
  const base = points.slice(-maxBars);
  const [zoom, setZoom] = useState<{ start: number; end: number } | null>(null);
  const slice = zoom && zoom.end > zoom.start ? base.slice(zoom.start, zoom.end + 1) : base;
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [drag, setDrag] = useState<{ active: boolean; x0: number; x1: number }>({
    active: false,
    x0: 0,
    x1: 0,
  });

  if (!slice.length) return null;

  const vals: number[] = [];
  for (const p of slice) {
    if (p.p95TtmsMs != null && Number.isFinite(p.p95TtmsMs)) vals.push(Number(p.p95TtmsMs));
    if (p.p99TtmsMs != null && Number.isFinite(p.p99TtmsMs)) vals.push(Number(p.p99TtmsMs));
  }

  const minV = vals.length ? Math.min(...vals) : 0;
  const maxV = vals.length ? Math.max(...vals) : 1;
  const span = maxV - minV || 1;

  const w = 360;
  const h = height;
  const padLeft = 54;
  const padRight = 12;
  const padTop = 12;
  const padBottom = 44;
  const plotW = w - padLeft - padRight;
  const plotH = h - padTop - padBottom;
  const n = slice.length;
  const denom = Math.max(1, n - 1);

  function x(i: number) {
    return padLeft + (i / denom) * plotW;
  }
  function y(v: number | null) {
    if (v == null || !Number.isFinite(Number(v))) return null;
    return padTop + (1 - (Number(v) - minV) / span) * plotH;
  }

  const p95Pts: string[] = [];
  const p99Pts: string[] = [];
  slice.forEach((p, i) => {
    const yy95 = y(p.p95TtmsMs);
    const yy99 = y(p.p99TtmsMs);
    if (yy95 != null) p95Pts.push(`${x(i)},${yy95}`);
    if (yy99 != null) p99Pts.push(`${x(i)},${yy99}`);
  });

  const tickVals = Array.from({ length: 5 }, (_, i) =>
    Math.round(minV + (span * (4 - i)) / 4)
  );
  const xLabelEvery = Math.max(1, Math.floor(n / 6));
  const latest = slice[slice.length - 1];

  function toSvgX(clientX: number) {
    const el = svgRef.current;
    if (!el) return 0;
    return ((clientX - el.getBoundingClientRect().left) / Math.max(1, el.getBoundingClientRect().width)) * w;
  }
  function idxFromSvgX(sx: number) {
    return clamp(
      Math.round(((sx - padLeft) / Math.max(1, plotW)) * (base.length - 1)),
      0,
      Math.max(0, base.length - 1)
    );
  }
  function commitZoom(x0: number, x1: number) {
    const i0 = idxFromSvgX(Math.min(x0, x1));
    const i1 = idxFromSvgX(Math.max(x0, x1));
    if (i1 - i0 >= 2) setZoom({ start: i0, end: i1 });
  }
  const selectionX = Math.min(drag.x0, drag.x1);
  const selectionW = Math.abs(drag.x1 - drag.x0);

  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.04] backdrop-blur p-4 min-w-0">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-xs text-gray-400">Latency trend</div>
          <div className="text-sm font-semibold text-gray-100">p95 / p99 TTMS</div>
          <div className="text-[11px] text-gray-400 mt-1">
            {slice.length
              ? `${formatUtcYmdHm(slice[0].ts)} → ${formatUtcYmdHm(
                  slice[slice.length - 1].ts
                )} UTC (bucket: ${bucketLabel(bucketSeconds)})`
              : `bucket: ${bucketLabel(bucketSeconds)} (UTC)`}
          </div>
          <div className="text-[11px] text-gray-500 mt-1">
            Drag to zoom • double-click to reset
          </div>
        </div>
        <div className="text-right">
          <div className="text-xs text-gray-400">Latest</div>
          <div className="text-[11px] text-gray-200">
            {latest
              ? `${formatUtcHM(latest.ts)} UTC • p95=${formatMsOrNA(
                  latest.p95TtmsMs
                )} • p99=${formatMsOrNA(latest.p99TtmsMs)}`
              : "n/a"}
          </div>
        </div>
      </div>

      <div className="mt-3 rounded-2xl border border-white/10 bg-black/25 p-3">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${w} ${h}`}
          className="w-full"
          style={{ height, touchAction: "none", cursor: "crosshair" }}
          onDoubleClick={() => setZoom(null)}
          onPointerDown={(e) => {
            const sx = toSvgX(e.clientX);
            setDrag({ active: true, x0: sx, x1: sx });
            (e.currentTarget as any).setPointerCapture?.(e.pointerId);
          }}
          onPointerMove={(e) => {
            if (!drag.active) return;
            setDrag((d) => ({ ...d, x1: toSvgX(e.clientX) }));
          }}
          onPointerUp={() => {
            if (!drag.active) return;
            const { x0, x1 } = drag;
            setDrag({ active: false, x0: 0, x1: 0 });
            commitZoom(x0, x1);
          }}
          onPointerCancel={() => setDrag({ active: false, x0: 0, x1: 0 })}
          onPointerLeave={() => {
            if (!drag.active) return;
            setDrag({ active: false, x0: 0, x1: 0 });
          }}
        >
          <text
            x={padLeft - 38}
            y={padTop + plotH / 2}
            fontSize="10"
            fill="#9ca3af"
            transform={`rotate(-90 ${padLeft - 38} ${padTop + plotH / 2})`}
          >
            Latency (ms)
          </text>
          <text
            x={padLeft + plotW / 2}
            y={h - 10}
            fontSize="10"
            fill="#9ca3af"
            textAnchor="middle"
          >
            Time (UTC, {bucketLabel(bucketSeconds)} buckets)
          </text>

          {tickVals.map((v, idx) => {
            const yy = padTop + (1 - (v - minV) / span) * plotH;
            return (
              <g key={idx}>
                <line
                  x1={padLeft}
                  y1={yy}
                  x2={padLeft + plotW}
                  y2={yy}
                  stroke={GRID_STROKE}
                />
                <text
                  x={padLeft - 10}
                  y={yy + 3}
                  fontSize="10"
                  fill="#9ca3af"
                  textAnchor="end"
                >
                  {v}
                </text>
              </g>
            );
          })}

          <polyline
            fill="none"
            stroke="rgba(59,130,246,0.88)"
            strokeWidth="2.75"
            strokeLinecap="round"
            strokeLinejoin="round"
            points={p95Pts.join(" ")}
          />
          <polyline
            fill="none"
            stroke="rgba(139,92,246,0.88)"
            strokeWidth="2.75"
            strokeLinecap="round"
            strokeLinejoin="round"
            points={p99Pts.join(" ")}
          />

          {slice.map((p, i) => {
            if (i % xLabelEvery !== 0 && i !== slice.length - 1) return null;
            return (
              <text
                key={`xl-${p.ts}`}
                x={x(i)}
                y={padTop + plotH + 18}
                fontSize="10"
                fill="#9ca3af"
                textAnchor="middle"
              >
                {timeLabelShort(p.ts, windowMinutes)}
              </text>
            );
          })}

          {drag.active && selectionW > 2 && (
            <rect
              x={selectionX}
              y={padTop}
              width={selectionW}
              height={plotH}
              fill="rgba(59,130,246,0.12)"
              stroke="rgba(59,130,246,0.55)"
              strokeWidth={1}
              rx={6}
            />
          )}
        </svg>

        <div className="mt-3 flex items-center justify-center gap-5 text-[11px] text-gray-300">
          <div className="flex items-center gap-1.5">
            <span
              className="inline-block h-2.5 w-2.5 rounded-full"
              style={{ background: "rgba(59,130,246,0.88)" }}
            />
            <span>p95</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span
              className="inline-block h-2.5 w-2.5 rounded-full"
              style={{ background: "rgba(139,92,246,0.88)" }}
            />
            <span>p99</span>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── HostSummaryCard ────────────────────────────────────────────────────────
function HostSummaryCard({ hosts }: { hosts: HostSeriesItem[] }) {
  const rows = (hosts || []).slice(0, 10);
  if (!rows.length) return null;
  const maxReq = Math.max(1, ...rows.map((r) => Number(r.totalRequests || 0)));

  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.04] backdrop-blur p-4 min-w-0">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-xs text-gray-400">Diagnostic view</div>
          <div className="text-sm font-semibold text-gray-100">Host distribution</div>
          <div className="text-[11px] text-gray-500 mt-1">
            Top hosts by request volume in the current window
          </div>
        </div>
        <div className="text-right">
          <div className="text-xs text-gray-400">Hosts</div>
          <div className="text-[11px] text-gray-200">{rows.length}</div>
        </div>
      </div>

      <div className="mt-3 rounded-2xl border border-white/10 bg-black/25 p-3">
        <div className="space-y-3">
          {rows.map((row) => (
            <div key={row.host} className="space-y-1.5">
              <div className="flex items-center justify-between gap-3 text-[11px]">
                <div className="truncate text-gray-200 font-medium">{row.host}</div>
                <div className="shrink-0 text-gray-400">
                  req={formatIntOrNA(row.totalRequests)} • 5xx={formatPctOrNA(
                    row.errorRatePct
                  )} • crc={formatIntOrNA(row.crcErrorCount)}
                </div>
              </div>
              <div className="h-2.5 rounded-full bg-white/5 overflow-hidden">
                <div
                  className="h-full rounded-full"
                  style={{
                    width: `${Math.max(
                      4,
                      (Number(row.totalRequests || 0) / maxReq) * 100
                    )}%`,
                    background: stableColorForKey(row.host),
                  }}
                />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── CrcTimeseriesBars ──────────────────────────────────────────────────────
function CrcTimeseriesBars({
  crcSeries,
  bucketSeconds,
  height = 190,
  windowMinutes,
}: {
  crcSeries: CrcSeriesItem[];
  bucketSeconds: number | null;
  height?: number;
  windowMinutes: number;
}) {
  const maxBars = windowMinutes <= 180 ? 60 : windowMinutes <= 1440 ? 144 : 180;
  const base = (crcSeries || []).slice(-maxBars);
  const [zoom, setZoom] = useState<{ start: number; end: number } | null>(null);
  const slice = zoom && zoom.end > zoom.start ? base.slice(zoom.start, zoom.end + 1) : base;
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [drag, setDrag] = useState<{ active: boolean; x0: number; x1: number }>({
    active: false,
    x0: 0,
    x1: 0,
  });

  if (!slice.length) return null;

  const maxVal = Math.max(1, ...slice.map((p) => Number(p.crcErrorCount || 0)));
  const w = 360;
  const h = height;
  const padLeft = 54;
  const padRight = 12;
  const padTop = 12;
  const padBottom = 44;
  const plotW = w - padLeft - padRight;
  const plotH = h - padTop - padBottom;
  const count = slice.length;
  const gap = clamp(Math.round(plotW / (Math.max(1, count) * 10)), 2, 6);
  const barW = Math.max(4, Math.floor((plotW - gap * Math.max(0, count - 1)) / Math.max(1, count)));
  const xLabelEvery = Math.max(1, Math.floor(slice.length / 6));
  const latest = slice[slice.length - 1];

  function toSvgX(clientX: number) {
    const el = svgRef.current;
    if (!el) return 0;
    return ((clientX - el.getBoundingClientRect().left) / Math.max(1, el.getBoundingClientRect().width)) * w;
  }
  function idxFromSvgX(sx: number) {
    return clamp(
      Math.floor((sx - padLeft) / Math.max(1, barW + gap)),
      0,
      Math.max(0, base.length - 1)
    );
  }
  function commitZoom(x0: number, x1: number) {
    const i0 = idxFromSvgX(Math.min(x0, x1));
    const i1 = idxFromSvgX(Math.max(x0, x1));
    if (i1 - i0 >= 2) setZoom({ start: i0, end: i1 });
  }
  const selectionX = Math.min(drag.x0, drag.x1);
  const selectionW = Math.abs(drag.x1 - drag.x0);

  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.04] backdrop-blur p-4 min-w-0">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-xs text-gray-400">Diagnostic view</div>
          <div className="text-sm font-semibold text-gray-100">CRC / response classification</div>
          <div className="text-[11px] text-gray-400 mt-1">
            {slice.length
              ? `${formatUtcYmdHm(slice[0].ts)} → ${formatUtcYmdHm(
                  slice[slice.length - 1].ts
                )} UTC (bucket: ${bucketLabel(bucketSeconds)})`
              : `bucket: ${bucketLabel(bucketSeconds)} (UTC)`}
          </div>
          <div className="text-[11px] text-gray-500 mt-1">
            Drag to zoom • double-click to reset
          </div>
        </div>
        <div className="text-right">
          <div className="text-xs text-gray-400">Latest</div>
          <div className="text-[11px] text-gray-200">
            {latest
              ? `${formatUtcHM(latest.ts)} UTC • crc=${formatIntOrNA(
                  latest.crcErrorCount
                )}`
              : "n/a"}
          </div>
        </div>
      </div>

      <div className="mt-3 rounded-2xl border border-white/10 bg-black/25 p-3">
        <svg
          viewBox={`0 0 ${w} ${h}`}
          className="w-full"
          style={{ height, touchAction: "none", cursor: "crosshair" }}
          ref={svgRef}
          onDoubleClick={() => setZoom(null)}
          onPointerDown={(e) => {
            const sx = toSvgX(e.clientX);
            setDrag({ active: true, x0: sx, x1: sx });
            (e.currentTarget as any).setPointerCapture?.(e.pointerId);
          }}
          onPointerMove={(e) => {
            if (!drag.active) return;
            setDrag((d) => ({ ...d, x1: toSvgX(e.clientX) }));
          }}
          onPointerUp={() => {
            if (!drag.active) return;
            const { x0, x1 } = drag;
            setDrag({ active: false, x0: 0, x1: 0 });
            commitZoom(x0, x1);
          }}
          onPointerCancel={() => setDrag({ active: false, x0: 0, x1: 0 })}
          onPointerLeave={() => {
            if (!drag.active) return;
            setDrag({ active: false, x0: 0, x1: 0 });
          }}
        >
          <text
            x={padLeft - 38}
            y={padTop + plotH / 2}
            fontSize="10"
            fill="#9ca3af"
            transform={`rotate(-90 ${padLeft - 38} ${padTop + plotH / 2})`}
          >
            CRC count
          </text>
          <text
            x={padLeft + plotW / 2}
            y={h - 10}
            fontSize="10"
            fill="#9ca3af"
            textAnchor="middle"
          >
            Time (UTC, {bucketLabel(bucketSeconds)} buckets)
          </text>

          {[0, 0.25, 0.5, 0.75, 1].map((t, idx) => {
            const y = padTop + (1 - t) * plotH;
            return (
              <g key={idx}>
                <line
                  x1={padLeft}
                  y1={y}
                  x2={padLeft + plotW}
                  y2={y}
                  stroke={GRID_STROKE}
                />
                <text
                  x={padLeft - 10}
                  y={y + 3}
                  fontSize="10"
                  fill="#9ca3af"
                  textAnchor="end"
                >
                  {formatCountTick(Math.round(maxVal * t))}
                </text>
              </g>
            );
          })}

          {slice.map((p, i) => {
            const x = padLeft + i * (barW + gap);
            const barH = (Number(p.crcErrorCount || 0) / maxVal) * plotH;
            return (
              <rect
                key={p.ts}
                x={x}
                y={padTop + plotH - barH}
                width={barW}
                height={Math.max(0, barH)}
                rx={2}
                fill="rgba(245,158,11,0.88)"
                opacity={0.92}
              />
            );
          })}

          {slice.map((p, i) => {
            if (i % xLabelEvery !== 0 && i !== slice.length - 1) return null;
            return (
              <text
                key={`xl-${p.ts}`}
                x={padLeft + i * (barW + gap) + barW / 2}
                y={padTop + plotH + 18}
                fontSize="10"
                fill="#9ca3af"
                textAnchor="middle"
              >
                {timeLabelShort(p.ts, windowMinutes)}
              </text>
            );
          })}

          {drag.active && selectionW > 2 && (
            <rect
              x={selectionX}
              y={padTop}
              width={selectionW}
              height={plotH}
              fill="rgba(59,130,246,0.12)"
              stroke="rgba(59,130,246,0.55)"
              strokeWidth={1}
              rx={6}
            />
          )}
        </svg>

        <div className="mt-3 flex items-center justify-center gap-5 text-[11px] text-gray-300">
          <div className="flex items-center gap-1.5">
            <span
              className="inline-block h-2.5 w-2.5 rounded-full"
              style={{ background: "rgba(245,158,11,0.88)" }}
            />
            <span>crc errors</span>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── SwarmAgentCards ────────────────────────────────────────────────────────
function SwarmAgentCards({
  agents,
}: {
  agents?: Array<{
    agentId?: "scope" | "traffic" | "latency" | "errors" | "cache";
    agent?: "scope" | "traffic" | "latency" | "errors" | "cache";
    title?: string;
    status: "ok" | "warn" | "critical";
    summary: string;
  }> | null;
}) {
  if (!agents?.length) return null;
  return (
    <div>
      <div className="text-xs text-gray-400 mb-2">Agent findings</div>
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
        {agents.map((agent, idx) => {
          const agentKey = agent.agentId || agent.agent || `agent-${idx}`;
          const agentTitle = agent.title || agent.agentId || agent.agent || "agent";
          return (
            <div key={agentKey} className="rounded-xl border border-white/10 bg-black/25 p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-xs text-gray-400">{agentKey}</div>
                  <div className="text-sm font-semibold text-gray-100 truncate">
                    {agentTitle}
                  </div>
                </div>
                <span
                  className={`shrink-0 rounded-full border px-2 py-1 text-[11px] font-semibold ${severityPillClass(
                    agent.status
                  )}`}
                >
                  {agent.status}
                </span>
              </div>
              <div className="mt-3 text-xs leading-relaxed text-gray-300 whitespace-pre-wrap">
                {agent.summary || "No summary."}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── MetricChips ────────────────────────────────────────────────────────────
function MetricChips({ metricsJson }: { metricsJson: any }) {
  if (!metricsJson) return null;
  const totalRequests = Number(metricsJson.totalRequests) || 0;
  const p95 = metricsJson.p95TtmsMs == null ? null : Number(metricsJson.p95TtmsMs);
  const p99 = metricsJson.p99TtmsMs == null ? null : Number(metricsJson.p99TtmsMs);
  const err5xx = metricsJson.error5xxCount == null ? null : Number(metricsJson.error5xxCount);
  const errPct = metricsJson.errorRatePct == null ? null : Number(metricsJson.errorRatePct);
  const rawCache =
    metricsJson.cacheHitRate != null
      ? Number(metricsJson.cacheHitRate)
      : metricsJson.cacheHitPct != null
      ? Number(metricsJson.cacheHitPct)
      : null;
  const cachePct = rawCache == null ? null : rawCache <= 1 ? rawCache * 100 : rawCache;
  const chips = [
    { k: "requests", v: formatIntOrNA(totalRequests) },
    { k: "p95", v: formatMsOrNA(p95) },
    { k: "p99", v: formatMsOrNA(p99) },
    { k: "5xx", v: err5xx == null ? "n/a" : formatIntOrNA(err5xx) },
    { k: "5xx%", v: formatPctOrNA(errPct) },
    { k: "cache", v: formatPctOrNA(cachePct) },
  ];
  return (
    <div className="flex flex-wrap gap-2">
      {chips.map((c) => (
        <span
          key={c.k}
          className="text-xs px-2.5 py-1 rounded-full border border-white/10 bg-white/10 text-gray-200"
        >
          <span className="text-gray-400 mr-1">{c.k}</span>
          <span className="font-semibold">{c.v}</span>
        </span>
      ))}
    </div>
  );
}

// ── buildSummaryFallback ───────────────────────────────────────────────────

function buildSummaryFallback(run: ChatTriage["run"]): string {
  const m = run.metricsJson || {};
  const totalRequests = Number(m.totalRequests) || 0;
  const p95 = m.p95TtmsMs == null ? null : Number(m.p95TtmsMs);
  const p99 = m.p99TtmsMs == null ? null : Number(m.p99TtmsMs);
  const err5xx = m.error5xxCount == null ? null : Number(m.error5xxCount);
  const errPct =
    m.errorRatePct != null && Number.isFinite(Number(m.errorRatePct))
      ? Number(m.errorRatePct)
      : totalRequests > 0 && err5xx != null
      ? (Number(err5xx) / totalRequests) * 100
      : null;

  let health = "GREEN";
  if ((errPct != null && errPct >= 1.0) || (p95 != null && p95 >= 1500)) health = "RED";
  else if ((errPct != null && errPct >= 0.2) || (p95 != null && p95 >= 500)) health = "AMBER";

  return [
    `Scope: ${run.inputs.partner || "—"} / ${run.inputs.service} / region=${run.inputs.region} / pop=${run.inputs.pop} / win=${run.inputs.windowMinutes}m / ct=${run.inputs.contentType} / ua=${run.inputs.uaFamily}`,
    `Traffic: ${formatIntOrNA(totalRequests)} requests`,
    `Latency: p95=${formatMsOrNA(p95)} • p99=${formatMsOrNA(p99)}`,
    `Errors: 5xx=${err5xx == null ? "n/a" : formatIntOrNA(err5xx)} • 5xx%=${formatPctOrNA(
      errPct
    )}`,
    `Health: ${health}`,
  ].join("\n");
}

function getRunBaseScope(run: ChatTriage["run"]): InvestigationScope {
  return {
    partner: run.inputs.partner || "",
    service: run.inputs.service || "",
    region: run.inputs.region || "all",
    pop: run.inputs.pop || "all",
    contentType: run.inputs.contentType || "all",
    uaFamily: run.inputs.uaFamily || "all",
  };
}

function getRunTimeContext(run: ChatTriage["run"]): InvestigationTimeContext {
  const startTsUtc = run.inputs.startTsUtc ?? null;
  const endTsUtc = run.inputs.endTsUtc ?? null;

  return {
    mode: startTsUtc && endTsUtc ? "absolute" : "relative",
    windowMinutes: windowMinutesFromRange(
      startTsUtc,
      endTsUtc,
      run.inputs.windowMinutes || 120
    ),
    startTsUtc,
    endTsUtc,
  };
}

function getRunAnchoredWindow(run: ChatTriage["run"]): {
  startTsUtc: string | null;
  endTsUtc: string | null;
} {
  const ts = parseTimeseries(run.metricsJson);
  if (ts?.startTs && ts?.endTs) {
    return {
      startTsUtc: ts.startTs,
      endTsUtc: ts.endTs,
    };
  }

  const meta = run.swarm?.assessment?.metadata;
  if (meta?.startTs && meta?.endTs) {
    return {
      startTsUtc: String(meta.startTs),
      endTsUtc: String(meta.endTs),
    };
  }

  if (run.inputs.startTsUtc && run.inputs.endTsUtc) {
    return {
      startTsUtc: run.inputs.startTsUtc,
      endTsUtc: run.inputs.endTsUtc,
    };
  }

  return {
    startTsUtc: null,
    endTsUtc: null,
  };
}

function toNumOrNull(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function normalizePctMaybe(v: unknown): number | null {
  const n = toNumOrNull(v);
  if (n == null) return null;
  return n <= 1 ? n * 100 : n;
}

function normalizeCachePctMaybe(v: unknown): number | null {
  const n = toNumOrNull(v);
  if (n == null) return null;
  return n <= 1 ? n * 100 : n;
}

function scoreWorstCandidate(x: {
  errorRatePct: number | null;
  p95TtmsMs: number | null;
  cacheHitRate: number | null;
  totalRequests: number | null;
}): number {
  const err = x.errorRatePct ?? 0;
  const p95 = x.p95TtmsMs ?? 0;
  const cachePenalty = x.cacheHitRate == null ? 0 : Math.max(0, 100 - x.cacheHitRate);
  const reqWeight = x.totalRequests == null ? 0 : Math.min(x.totalRequests / 1000, 100);

  return err * 1000 + p95 + cachePenalty * 10 + reqWeight;
}

function coerceBreakdownCandidate(
  raw: any,
  keyField: "region" | "pop",
  source: string
): InvestigationWorstCandidate | null {
  const value = String(raw?.[keyField] || "").trim();
  if (!value || value === "all") return null;

  return {
    value,
    errorRatePct: normalizePctMaybe(raw?.errorRatePct ?? raw?.errorRate),
    p95TtmsMs: toNumOrNull(raw?.p95TtmsMs ?? raw?.p95Ms ?? raw?.latencyP95Ms),
    cacheHitRate: normalizeCachePctMaybe(raw?.cacheHitRate ?? raw?.cacheHitPct),
    totalRequests: toNumOrNull(raw?.totalRequests ?? raw?.requests),
    source,
  };
}

function pickWorstFromBreakdown(
  items: any[],
  keyField: "region" | "pop",
  source: string
): InvestigationWorstCandidate | null {
  const candidates = items
    .map((item) => coerceBreakdownCandidate(item, keyField, source))
    .filter(Boolean) as InvestigationWorstCandidate[];

  if (!candidates.length) return null;

  candidates.sort((a, b) => scoreWorstCandidate(b) - scoreWorstCandidate(a));
  return candidates[0] ?? null;
}

function extractWorstRegionCandidate(run: ChatTriage["run"]): InvestigationWorstCandidate | null {
  const m = run.metricsJson || {};

  const candidateSources: Array<{ items: any[]; source: string }> = [
    {
      items:
        Array.isArray(m?.regionBreakdown) && m.regionBreakdown.length > 0
          ? m.regionBreakdown
          : [],
      source: "metricsJson.regionBreakdown",
    },
    {
      items:
        Array.isArray(m?.evidenceBundle?.regionBreakdown) &&
        m.evidenceBundle.regionBreakdown.length > 0
          ? m.evidenceBundle.regionBreakdown
          : [],
      source: "metricsJson.evidenceBundle.regionBreakdown",
    },
  ];

  for (const entry of candidateSources) {
    if (entry.items.length) {
      const safeItems = entry.items.filter(
        (x) => x && typeof x === "object" && x.region
      );

      const picked = pickWorstFromBreakdown(safeItems, "region", entry.source);
      if (picked) return picked;
    }
  }

  return null;
}

function extractWorstPopCandidate(run: ChatTriage["run"]): InvestigationWorstCandidate | null {
  const m = run.metricsJson || {};

  const candidateSources: Array<{ items: any[]; source: string }> = [
    {
      items:
        Array.isArray(m?.popBreakdown) && m.popBreakdown.length > 0
          ? m.popBreakdown
          : [],
      source: "metricsJson.popBreakdown",
    },
    {
      items:
        Array.isArray(m?.evidenceBundle?.popBreakdown) &&
        m.evidenceBundle.popBreakdown.length > 0
          ? m.evidenceBundle.popBreakdown
          : [],
      source: "metricsJson.evidenceBundle.popBreakdown",
    },
  ];

  for (const entry of candidateSources) {
    if (entry.items.length) {
      const safeItems = entry.items.filter(
        (x) => x && typeof x === "object" && x.pop
      );

      const picked = pickWorstFromBreakdown(safeItems, "pop", entry.source);
      if (picked) return picked;
    }
  }

  return null;
}

function buildLatestInvestigationContext(args: {
  run: ChatTriage["run"];
  availableRegions: string[];
  availablePops: string[];
  availableContentTypes: string[];
  availableUaFamilies: string[];
}): InvestigationContext {
  const baseTime = getRunTimeContext(args.run);
  const anchored = getRunAnchoredWindow(args.run);

  const resolvedTime: InvestigationTimeContext =
    anchored.startTsUtc && anchored.endTsUtc
      ? {
          mode: "absolute",
          windowMinutes: windowMinutesFromRange(
            anchored.startTsUtc,
            anchored.endTsUtc,
            baseTime.windowMinutes
          ),
          startTsUtc: anchored.startTsUtc,
          endTsUtc: anchored.endTsUtc,
        }
      : baseTime;

  return {
    baseScope: getRunBaseScope(args.run),
    time: resolvedTime,
    worstRegion: extractWorstRegionCandidate(args.run),
    worstPop: extractWorstPopCandidate(args.run),
    availableDimensions: {
      regions: (args.availableRegions || []).filter((x) => x && x !== "all"),
      pops: (args.availablePops || []).filter((x) => x && x !== "all"),
      contentTypes: (args.availableContentTypes || []).filter((x) => x && x !== "all"),
      uaFamilies: (args.availableUaFamilies || []).filter((x) => x && x !== "all"),
    },
  };
}

function contextToTriageInputs(ctx: InvestigationContext): TriageInputs {
  const { baseScope, time } = ctx;

  return {
    dataSource: "clickhouse",
    partner: baseScope.partner,
    service: baseScope.service,
    region: baseScope.region,
    pop: baseScope.pop,
    contentType: baseScope.contentType,
    uaFamily: baseScope.uaFamily,
    windowMinutes: time.windowMinutes,
    startTsUtc: time.mode === "absolute" ? time.startTsUtc : null,
    endTsUtc: time.mode === "absolute" ? time.endTsUtc : null,
  };
}

function deriveRefreshInputs(ctx: InvestigationContext): TriageInputs {
  return contextToTriageInputs(ctx);
}

function derivePreviousWindowInputs(
  ctx: InvestigationContext,
  now: Date = new Date()
): TriageInputs {
  const base = contextToTriageInputs(ctx);
  const windowMs = Math.max(1, ctx.time.windowMinutes) * 60 * 1000;

  if (ctx.time.mode === "absolute" && ctx.time.startTsUtc && ctx.time.endTsUtc) {
    const startMs = new Date(ctx.time.startTsUtc).getTime();
    const endMs = new Date(ctx.time.endTsUtc).getTime();

    if (Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs) {
      const spanMs = endMs - startMs;
      const prevStart = new Date(startMs - spanMs).toISOString();
      const prevEnd = new Date(startMs).toISOString();

      return {
        ...base,
        windowMinutes: Math.max(1, Math.round(spanMs / 60000)),
        startTsUtc: prevStart,
        endTsUtc: prevEnd,
      };
    }
  }

  const endMs = now.getTime() - windowMs;
  const startMs = endMs - windowMs;

  return {
    ...base,
    windowMinutes: ctx.time.windowMinutes,
    startTsUtc: new Date(startMs).toISOString(),
    endTsUtc: new Date(endMs).toISOString(),
  };
}

function deriveWorstRegionInputs(ctx: InvestigationContext): TriageInputs | null {
  if (!ctx.worstRegion?.value) return null;

  const base = contextToTriageInputs(ctx);

  return {
    ...base,
    region: ctx.worstRegion.value,
    pop: "all",
  };
}

function deriveWorstPopInputs(ctx: InvestigationContext): TriageInputs | null {
  if (!ctx.worstPop?.value) return null;

  const base = contextToTriageInputs(ctx);

  return {
    ...base,
    pop: ctx.worstPop.value,
  };
}

function deriveScopedFollowupInputs(
  ctx: InvestigationContext,
  overrides: {
    region?: string;
    pop?: string;
    contentType?: string;
    uaFamily?: string;
    service?: string;
  }
): TriageInputs {
  const base = contextToTriageInputs(ctx);

  const nextRegion =
    overrides.region != null
      ? overrides.region
      : overrides.pop != null
      ? "all"
      : base.region;

  const nextPop =
    overrides.pop != null
      ? overrides.pop
      : overrides.region != null
      ? "all"
      : base.pop;

  return {
    ...base,
    service: overrides.service ?? base.service,
    region: nextRegion,
    pop: nextPop,
    contentType: overrides.contentType ?? base.contentType,
    uaFamily: overrides.uaFamily ?? base.uaFamily,
  };
}

// ── TriageCard ─────────────────────────────────────────────────────────────
function TriageCard({ run }: { run: ChatTriage["run"] }) {
  const ts = parseTimeseries(run.metricsJson);
  const effectiveWindowMinutes = windowMinutesFromRange(
    run.inputs.startTsUtc,
    run.inputs.endTsUtc,
    run.inputs.windowMinutes
  );
  const bucketSeconds = ts?.bucketSeconds ?? run.metricsJson?.timeseries?.bucketSeconds ?? null;
  const assessment = run.swarm?.assessment ?? null;
  const agents = run.swarm?.agents ?? null;
  const swarmSummary = String(assessment?.summary || "").trim();
  const classicSummary = String(run.summaryText || "").trim();
  const summaryText = swarmSummary || classicSummary || buildSummaryFallback(run);
  const keyFindings = Array.isArray(assessment?.keyFindings)
    ? assessment!.keyFindings!.map((x) => String(x || "").trim()).filter(Boolean)
    : [];
  const pointsCount = ts?.points?.length ?? 0;
  const debug = run.metricsJson?.debug ?? null;
  const runnerVersion = debug?.__runnerVersion
    ? String(debug.__runnerVersion)
    : debug?.proxyVersion
    ? String(debug.proxyVersion)
    : "unknown";
  const scopeSource = run.scopeSource || "filters";
  const forcedLocal = Boolean(debug?.forcedLocal);
  const proxyEnabled = Boolean(debug?.hasProxyEnv);
  const tableUsed = debug?.tableUsed ? String(debug.tableUsed) : "unknown";
  const debugBucketSeconds = debug?.bucketSeconds != null ? Number(debug.bucketSeconds) : null;
  const anchorMode =
    run.inputs.startTsUtc && run.inputs.endTsUtc
      ? "absolute"
      : debug?.anchorToMaxTs
      ? "max(ts)"
      : "now()";
  const answerSource = forcedLocal ? "Forced Local" : proxyEnabled ? "Proxy" : "Local";
  const timeRangeText =
    run.inputs.startTsUtc && run.inputs.endTsUtc
      ? `${isoToUtcText(run.inputs.startTsUtc)} → ${isoToUtcText(run.inputs.endTsUtc)} UTC`
      : `last ${run.inputs.windowMinutes}m`;

  return (
    <div className="triage-enter rounded-2xl border border-white/10 bg-white/[0.05] backdrop-blur p-4 shadow-lg shadow-black/10 space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-xs text-gray-400">Triage result</div>
          <div className="text-sm font-semibold text-gray-100 truncate">
            {[
              run.inputs.partner || "—",
              run.inputs.service || "—",
              run.inputs.region,
              run.inputs.pop,
              run.inputs.contentType !== "all" ? `ct=${run.inputs.contentType}` : null,
              run.inputs.uaFamily !== "all" ? `ua=${run.inputs.uaFamily}` : null,
              timeRangeText,
            ]
              .filter(Boolean)
              .join(" • ")}
          </div>
          {ts?.startTs && ts?.endTs && (
            <div className="text-[11px] text-gray-500 mt-1">
              actual window: {formatUtcYmdHm(ts.startTs)} → {formatUtcYmdHm(ts.endTs)} UTC
            </div>
          )}
        </div>
        <div className="flex flex-wrap justify-end gap-1.5 shrink-0">
          <span className="text-[11px] px-2 py-1 rounded-full border border-white/10 bg-white/5 text-gray-200">
            <span className="text-gray-400 mr-1">scope</span>
            <span className="font-semibold">{scopeSource}</span>
          </span>
          <span
            className={`text-[11px] px-2 py-1 rounded-full border ${
              forcedLocal
                ? "border-amber-400/30 bg-amber-400/10 text-amber-200"
                : proxyEnabled
                ? "border-emerald-400/30 bg-emerald-400/10 text-emerald-200"
                : "border-white/10 bg-white/5 text-gray-200"
            }`}
          >
            <span className="text-gray-400 mr-1">src</span>
            <span className="font-semibold">{answerSource}</span>
          </span>
          {assessment?.overallStatus && (
            <span
              className={`text-[11px] px-2 py-1 rounded-full border font-semibold ${severityPillClass(
                assessment.overallStatus
              )}`}
            >
              {assessment.overallStatus}
            </span>
          )}
        </div>
      </div>

      {assessment && (
        <div className="flex flex-wrap gap-2">
          {assessment.primarySignal && (
            <span className="text-xs px-2.5 py-1 rounded-full border border-white/10 bg-white/10 text-gray-200">
              <span className="text-gray-400 mr-1">primary</span>
              <span className="font-semibold">{signalLabel(assessment.primarySignal)}</span>
            </span>
          )}
          {assessment.metadata?.timeMode && (
            <span className="text-xs px-2.5 py-1 rounded-full border border-white/10 bg-white/10 text-gray-200">
              <span className="text-gray-400 mr-1">timeMode</span>
              <span className="font-semibold">{assessment.metadata.timeMode}</span>
            </span>
          )}
        </div>
      )}

      <div className="rounded-xl border border-white/10 bg-black/25 p-3">
        <div className="text-xs text-gray-400 mb-2">Summary</div>
        <pre className="whitespace-pre-wrap text-sm text-gray-100/90 leading-relaxed">
          {summaryText}
        </pre>
      </div>

      <div>
        <div className="text-xs text-gray-400 mb-2">Key Signals</div>
        <MetricChips metricsJson={run.metricsJson} />
      </div>

      {keyFindings.length > 0 && (
        <div className="rounded-xl border border-white/10 bg-black/25 p-3">
          <div className="text-xs text-gray-400 mb-2">Key Findings</div>
          <div className="space-y-2">
            {keyFindings.map((finding, idx) => (
              <div
                key={`${finding}-${idx}`}
                className="flex items-start gap-2 text-sm text-gray-200/90"
              >
                <span className="mt-1 h-1.5 w-1.5 rounded-full bg-blue-400 shrink-0" />
                <span>{finding}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {ts && ts.points.length > 0 ? (
        <div className="space-y-4">
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
            <RequestsErrorRateLines
              points={ts.points}
              bucketSeconds={bucketSeconds}
              height={190}
              windowMinutes={effectiveWindowMinutes}
            />
            <LatencyTimeseriesLines
              points={ts.points}
              bucketSeconds={bucketSeconds}
              height={190}
              windowMinutes={effectiveWindowMinutes}
            />
          </div>

          <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
            <StackedBarTimeseries
              title="Status code distribution"
              subtitle="Diagnostic view"
              ts={ts}
              bucketSeconds={bucketSeconds}
              seriesKeys={ts.statusCodeSeries || []}
              getMap={(p) => p.statusCountsByCode}
              height={190}
              windowMinutes={effectiveWindowMinutes}
              kind="status"
            />
            <HostSummaryCard hosts={ts.hostSeries || []} />
          </div>

          <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
            <CrcTimeseriesBars
              crcSeries={ts.crcSeries || []}
              bucketSeconds={bucketSeconds}
              height={190}
              windowMinutes={effectiveWindowMinutes}
            />
            <div className="rounded-2xl border border-white/10 bg-white/[0.04] backdrop-blur p-4 flex items-center justify-center">
              <div className="text-center text-xs text-gray-500 space-y-1">
                <div className="text-2xl opacity-30">📊</div>
                <div>
                  Points: <span className="text-gray-300 font-semibold">{pointsCount}</span>
                </div>
                <div>
                  Hosts: <span className="text-gray-300 font-semibold">{ts.hostSeries?.length || 0}</span>
                </div>
                <div>
                  CRC buckets: <span className="text-gray-300 font-semibold">{ts.crcSeries?.length || 0}</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div className="text-sm text-gray-400">Timeseries: 0 points (aggregate-only).</div>
      )}

      <details className="rounded-2xl border border-white/10 bg-black/20 p-3 group">
        <summary className="cursor-pointer text-sm font-semibold text-gray-200 select-none">
          Evidence
        </summary>
        <div className="mt-4 space-y-4">
          {agents?.length ? <SwarmAgentCards agents={agents} /> : null}

          <div className="text-xs text-gray-300 grid grid-cols-2 gap-x-6 gap-y-1.5">
            <div>
              <span className="text-gray-400">Actual window:</span>{" "}
              {ts?.startTs && ts?.endTs
                ? `${formatUtcYmdHm(ts.startTs)} → ${formatUtcYmdHm(ts.endTs)} UTC`
                : "n/a"}
            </div>
            <div>
              <span className="text-gray-400">Bucket:</span> {bucketLabel(bucketSeconds)}
            </div>
            <div>
              <span className="text-gray-400">Runner:</span> {runnerVersion}
            </div>
            <div>
              <span className="text-gray-400">Table:</span> {tableUsed}
            </div>
            <div>
              <span className="text-gray-400">Anchor:</span> {anchorMode}
            </div>
            <div>
              <span className="text-gray-400">Debug bucket:</span>{" "}
              {debugBucketSeconds != null ? `${debugBucketSeconds}s` : "n/a"}
            </div>
            {assessment?.metadata?.compareStartTs && assessment?.metadata?.compareEndTs && (
              <div className="col-span-2">
                <span className="text-gray-400">Compare window:</span>{" "}
                {formatUtcYmdHm(assessment.metadata.compareStartTs)} →{" "}
                {formatUtcYmdHm(assessment.metadata.compareEndTs)} UTC
              </div>
            )}
          </div>

          <details className="rounded-xl border border-white/10 bg-black/20 p-3">
            <summary className="cursor-pointer text-sm text-gray-200 select-none">
              Inputs
            </summary>
            <pre className="mt-3 whitespace-pre-wrap text-xs text-gray-200/90 rounded-xl border border-white/10 bg-black/30 p-3 overflow-x-auto">
              {JSON.stringify(run.inputs, null, 2)}
            </pre>
          </details>

          {run.chatContext && (
            <details className="rounded-xl border border-white/10 bg-black/20 p-3">
              <summary className="cursor-pointer text-sm text-gray-200 select-none">
                Chat parse context
              </summary>
              <pre className="mt-3 whitespace-pre-wrap text-xs text-gray-200/90 rounded-xl border border-white/10 bg-black/30 p-3 overflow-x-auto">
                {JSON.stringify(run.chatContext, null, 2)}
              </pre>
            </details>
          )}

          {run.swarm && (
            <details className="rounded-xl border border-white/10 bg-black/20 p-3">
              <summary className="cursor-pointer text-sm text-gray-200 select-none">
                Swarm payload
              </summary>
              <pre className="mt-3 whitespace-pre-wrap text-xs text-gray-200/90 rounded-xl border border-white/10 bg-black/30 p-3 overflow-x-auto">
                {JSON.stringify(run.swarm, null, 2)}
              </pre>
            </details>
          )}
        </div>
      </details>

      {run.sql?.queries?.length ? (
        <details className="rounded-2xl border border-white/10 bg-black/20 p-3">
          <summary className="cursor-pointer text-sm font-semibold text-gray-200 select-none">
            SQL Evidence
          </summary>
          <div className="mt-4 space-y-3">
            {run.sql.queries.map((query, idx) => (
              <div key={idx}>
                <div className="text-xs text-gray-400 mb-1">Query {idx + 1}</div>
                <pre className="whitespace-pre-wrap text-xs text-gray-200/90 rounded-xl border border-white/10 bg-black/30 p-3 overflow-x-auto">
                  {query}
                </pre>
              </div>
            ))}
            {run.sql.params && (
              <div>
                <div className="text-xs text-gray-400 mb-1">Params</div>
                <pre className="whitespace-pre-wrap text-xs text-gray-200/90 rounded-xl border border-white/10 bg-black/30 p-3 overflow-x-auto">
                  {JSON.stringify(run.sql.params, null, 2)}
                </pre>
              </div>
            )}
          </div>
        </details>
      ) : null}

      <style jsx>{`
        .triage-enter {
          animation: triageIn 220ms ease-out;
        }
        @keyframes triageIn {
          from {
            opacity: 0;
            transform: translateY(6px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }
      `}</style>
    </div>
  );
}

function drillDimensionLabel(row: any): string {
  return (
    row?.region ||
    row?.pop ||
    row?.uaFamily ||
    row?.contentType ||
    row?.dimension ||
    "n/a"
  );
}

function drillDimensionHeader(drill: any): string {
  switch (drill?.type) {
    case "worst_region":
      return "Region";
    case "worst_pop":
      return "POP";
    case "worst_ua":
      return "UA Family";
    case "worst_content":
      return "Content Type";
    default:
      return "Dimension";
  }
}


function DrillCard({
  drill,
  summaryText,
}: {
  drill: any;
  summaryText: string;
}) {
  return (
    <div className="triage-enter rounded-2xl border border-white/10 bg-white/[0.05] backdrop-blur p-4 shadow-lg shadow-black/10 space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-xs text-gray-400">Drill result</div>
          <div className="text-sm font-semibold text-gray-100 truncate">
            {drill?.title || "Drill"}
          </div>
        </div>
        <div className="flex flex-wrap justify-end gap-1.5 shrink-0">
          <span className="text-[11px] px-2 py-1 rounded-full border border-blue-400/30 bg-blue-400/10 text-blue-200">
            drill
          </span>
        </div>
      </div>

      <div className="rounded-xl border border-white/10 bg-black/25 p-3">
        <div className="text-xs text-gray-400 mb-2">Summary</div>
        <pre className="whitespace-pre-wrap text-sm text-gray-100/90 leading-relaxed">
          {drill?.summary || summaryText || ""}
        </pre>
      </div>

      {Array.isArray(drill?.rows) && drill.rows.length > 0 ? (
        <div className="rounded-2xl border border-white/10 bg-black/20 p-3">
          <div className="flex items-center justify-between gap-3">
            <div className="text-sm font-semibold text-gray-200">Top results</div>
            <div className="text-[11px] text-gray-500">
              {drill.rows.length} row{drill.rows.length === 1 ? "" : "s"}
            </div>
          </div>

          <div className="mt-4 overflow-x-auto rounded-xl border border-white/10 bg-black/30">
            <table className="min-w-full text-left text-xs text-gray-200">
              <thead className="border-b border-white/10 bg-white/[0.03] text-gray-400">
                <tr>
                  <th className="px-4 py-3 font-medium">
                    {drillDimensionHeader(drill)}
                  </th>
                  <th className="px-4 py-3 font-medium">Requests</th>
                  <th className="px-4 py-3 font-medium">5xx</th>
                  <th className="px-4 py-3 font-medium">5xx %</th>
                  <th className="px-4 py-3 font-medium">P95</th>
                  <th className="px-4 py-3 font-medium">Cache</th>
                </tr>
              </thead>
              <tbody>
                {drill.rows.map((row: any, idx: number) => {
                  const cachePct =
                    row?.cacheHitPct == null && row?.cacheHitRate == null
                      ? null
                      : Number(
                          row?.cacheHitPct != null ? row.cacheHitPct : row.cacheHitRate
                        ) <= 1
                      ? Number(
                          row?.cacheHitPct != null ? row.cacheHitPct : row.cacheHitRate
                        ) * 100
                      : Number(
                          row?.cacheHitPct != null ? row.cacheHitPct : row.cacheHitRate
                        );

                  return (
                    <tr
                      key={`${drillDimensionLabel(row)}-${idx}`}
                      className="border-b border-white/5 last:border-b-0 hover:bg-white/[0.03]"
                    >
                      <td className="px-4 py-3 font-medium text-gray-100">
                        {drillDimensionLabel(row)}
                      </td>
                      <td className="px-4 py-3 text-gray-300">
                        {formatIntOrNA(row?.totalRequests)}
                      </td>
                      <td className="px-4 py-3 text-gray-300">
                        {formatIntOrNA(row?.error5xxCount)}
                      </td>
                      <td className="px-4 py-3 text-gray-300">
                        {formatPctOrNA(row?.errorRatePct)}
                      </td>
                      <td className="px-4 py-3 text-gray-300">
                        {formatMsOrNA(row?.p95TtmsMs)}
                      </td>
                      <td className="px-4 py-3 text-gray-300">
                        {formatPctOrNA(cachePct)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      {drill?.sql?.queries?.length ? (
        <details className="rounded-2xl border border-white/10 bg-black/20 p-3">
          <summary className="cursor-pointer text-sm font-semibold text-gray-200 select-none">
            SQL Evidence
          </summary>
          <div className="mt-4 space-y-3">
            {drill.sql.queries.map((query: string, idx: number) => (
              <div key={idx}>
                <div className="text-xs text-gray-400 mb-1">Query {idx + 1}</div>
                <pre className="whitespace-pre-wrap text-xs text-gray-200/90 rounded-xl border border-white/10 bg-black/30 p-3 overflow-x-auto">
                  {query}
                </pre>
              </div>
            ))}
            {drill.sql.params && (
              <div>
                <div className="text-xs text-gray-400 mb-1">Params</div>
                <pre className="whitespace-pre-wrap text-xs text-gray-200/90 rounded-xl border border-white/10 bg-black/30 p-3 overflow-x-auto">
                  {JSON.stringify(drill.sql.params, null, 2)}
                </pre>
              </div>
            )}
          </div>
        </details>
      ) : null}
    </div>
  );
}

// ── Home ───────────────────────────────────────────────────────────────────
export default function Home() {
  const [mounted, setMounted] = useState(false);

  const [partner, setPartner] = useState<PartnerOrMissing>("");
  function setPartnerSticky(p: string) {
    const v = String(p || "").trim();
    if (!v) {
      setPartner("");
      safeDelLS(PARTNER_KEY);
      return;
    }
    if ((PARTNER_OPTIONS as readonly string[]).includes(v)) {
      setPartner(v as Partner);
      safeSetLS(PARTNER_KEY, v);
    }
  }

  const [isTriageLoading, setIsTriageLoading] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [filtersDirty, setFiltersDirty] = useState(false);

  const [schemaState, setSchemaState] = useState<SchemaState>({
    partners: [...CANON.partners],
    services: [...CANON.services],
    regions: [...CANON.regions],
    pops: [...CANON.pops],
    contentTypes: ["all", ...CANON.contentTypes],
    uaFamilies: ["all", ...CANON.uaFamilies],
  });

  const [chatInput, setChatInput] = useState("");
  const [chatMessages, setChatMessages] = useState<ChatMsg[]>([]);
  const chatScrollRef = useRef<HTMLDivElement | null>(null);
  const lastMsgIdRef = useRef<string | null>(null);
  const [typing, setTyping] = useState(false);

  const [pendingChatScope, setPendingChatScope] = useState<{
    partner: PartnerOrMissing;
    service: string;
  }>({
    partner: "",
    service: "",
  });

  const [debugOpen, setDebugOpen] = useState(false);
  const [runLog, setRunLog] = useState<Array<{ ts: string; text: string }>>([]);

  const [service, setService] = useState<string>("");
  const [region, setRegion] = useState<string>("all");
  const [pop, setPop] = useState<string>("all");
  const [windowMinutes, setWindowMinutes] = useState<number>(120);
  const [contentType, setContentType] = useState<string>("all");
  const [uaFamily, setUaFamily] = useState<string>("all");
  const [timeMode, setTimeMode] = useState<TimeMode>("relative");
  const [startTsUtc, setStartTsUtc] = useState<string | null>(null);
  const [endTsUtc, setEndTsUtc] = useState<string | null>(null);

  const serviceRef = useRef(service);
  useEffect(() => {
    serviceRef.current = service;
  }, [service]);

  function setServiceSticky(s: string) {
    const v = String(s || "").trim();
    if (!v) {
      setService("");
      safeDelLS(SERVICE_KEY);
      return;
    }
    if ((SERVICE_OPTIONS as readonly string[]).includes(v)) {
      setService(v);
      safeSetLS(SERVICE_KEY, v);
    }
  }

  const [draftService, setDraftService] = useState<string>("");
  const [draftRegion, setDraftRegion] = useState<string>("all");
  const [draftPop, setDraftPop] = useState<string>("all");
  const [draftWindowMinutes, setDraftWindowMinutes] = useState<number>(120);
  const [draftContentType, setDraftContentType] = useState<string>("all");
  const [draftUaFamily, setDraftUaFamily] = useState<string>("all");
  const [draftTimeMode, setDraftTimeMode] = useState<TimeMode>("relative");
  const [draftStartUtcLocal, setDraftStartUtcLocal] = useState<string>("");
  const [draftEndUtcLocal, setDraftEndUtcLocal] = useState<string>("");

  useEffect(() => setMounted(true), []);

  function loadFiltersEnvelope() {
    const raw = safeGetLS(FILTERS_KEY);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      return {
        expiresAt: Number(parsed?.expiresAt ?? 0),
        value: parsed?.value ?? null,
      };
    } catch {
      safeDelLS(FILTERS_KEY);
      return null;
    }
  }

  function loadFiltersFromTTL() {
    const env = loadFiltersEnvelope();
    if (!env) return null;
    if (!Number.isFinite(env.expiresAt) || env.expiresAt <= Date.now()) {
      safeDelLS(FILTERS_KEY);
      return null;
    }
    return env.value ?? null;
  }

  function saveFiltersToTTL(next: {
    region: string;
    pop: string;
    windowMinutes: number;
    contentType: string;
    uaFamily: string;
    timeMode: TimeMode;
    startTsUtc: string | null;
    endTsUtc: string | null;
  }) {
    safeSetLS(
      FILTERS_KEY,
      JSON.stringify({
        expiresAt: Date.now() + FILTERS_TTL_MS,
        value: next,
      })
    );
  }

  function pushRunLog(text: string) {
    setRunLog((prev) => [...prev.slice(-80), { ts: nowIso(), text }]);
  }

  function addText(role: ChatText["role"], text: string) {
    const id = `${Date.now()}-${Math.random()}`;
    setChatMessages((prev) => [...prev, { id, type: "text", role, ts: nowIso(), text }]);
    return id;
  }

  function addTriageCard(run: ChatTriage["run"]) {
    setChatMessages((prev) => [
      ...prev,
      {
        id: `${Date.now()}-${Math.random()}`,
        type: "triage",
        role: "assistant",
        ts: nowIso(),
        run,
      },
    ]);
  }

  function addDrillCard(payload: { drill: any; summaryText: string }) {
    setChatMessages((prev) => [
      ...prev,
      {
        id: `${Date.now()}-${Math.random()}`,
        type: "drill",
        role: "assistant",
        ts: nowIso(),
        drill: payload.drill,
        summaryText: payload.summaryText,
      },
    ]);
  }

  function handleResetInvestigation() {
    setChatMessages([]);
    setChatInput("");
    setTyping(false);
    setPendingChatScope({
      partner: "",
      service: "",
    });
    pushRunLog("Investigation reset by user.");
  }

  function resetAllFilters() {
    safeDelLS(FILTERS_KEY);
    safeDelLS(PARTNER_KEY);
    safeDelLS(SERVICE_KEY);
    setPartner("");
    setService("");
    setRegion("all");
    setPop("all");
    setWindowMinutes(120);
    setContentType("all");
    setUaFamily("all");
    setTimeMode("relative");
    setStartTsUtc(null);
    setEndTsUtc(null);
    setDraftService("");
    setDraftRegion("all");
    setDraftPop("all");
    setDraftWindowMinutes(120);
    setDraftContentType("all");
    setDraftUaFamily("all");
    setDraftTimeMode("relative");
    setDraftStartUtcLocal("");
    setDraftEndUtcLocal("");
    setFiltersDirty(false);
    setPendingChatScope({
      partner: "",
      service: "",
    });
    pushRunLog("Reset: cleared saved filters + partner + service");
  }

  useEffect(() => {
    if (!mounted) return;

    const savedPartner = safeGetLS(PARTNER_KEY);
    if (savedPartner && (PARTNER_OPTIONS as readonly string[]).includes(savedPartner)) {
      setPartner(savedPartner as Partner);
    }

    const savedService = safeGetLS(SERVICE_KEY);
    if (savedService && (SERVICE_OPTIONS as readonly string[]).includes(savedService)) {
      setService(savedService);
      setDraftService(savedService);
    }

    const ttl = loadFiltersFromTTL();
    if (ttl) {
      const r = String(ttl.region || "all").trim() || "all";
      const pp = String(ttl.pop || "all").trim() || "all";
      const w = Number(ttl.windowMinutes ?? 120);
      const ct = String(ttl.contentType || "all").trim() || "all";
      const ua = String(ttl.uaFamily || "all").trim() || "all";

      setRegion(r);
      setDraftRegion(r);
      setPop(pp);
      setDraftPop(pp);

      if (Number.isFinite(w) && w > 0) {
        setWindowMinutes(w);
        setDraftWindowMinutes(w);
      }

      setContentType(ct);
      setDraftContentType(ct);
      setUaFamily(ua);
      setDraftUaFamily(ua);

      const tm: TimeMode = ttl.timeMode === "absolute" ? "absolute" : "relative";
      setTimeMode(tm);
      setDraftTimeMode(tm);

      const sIso = ttl.startTsUtc ? String(ttl.startTsUtc) : null;
      const eIso = ttl.endTsUtc ? String(ttl.endTsUtc) : null;
      setStartTsUtc(sIso);
      setEndTsUtc(eIso);
      setDraftStartUtcLocal(isoToDatetimeLocalUtc(sIso));
      setDraftEndUtcLocal(isoToDatetimeLocalUtc(eIso));

      pushRunLog("Loaded non-sticky filters from TTL (10m).");
    } else {
      setDraftRegion("all");
      setDraftPop("all");
      setDraftWindowMinutes(120);
      setDraftContentType("all");
      setDraftUaFamily("all");
      setDraftTimeMode("relative");
      setDraftStartUtcLocal("");
      setDraftEndUtcLocal("");
    }
  }, [mounted]);

  useEffect(() => {
    if (!mounted) return;

    const tick = () => {
      const raw = safeGetLS(FILTERS_KEY);
      if (!raw) return;
      try {
        const parsed = JSON.parse(raw);
        const expiresAt = Number(parsed?.expiresAt ?? 0);
        if (!Number.isFinite(expiresAt) || expiresAt <= 0 || expiresAt > Date.now()) return;

        safeDelLS(FILTERS_KEY);
        setRegion("all");
        setPop("all");
        setWindowMinutes(120);
        setContentType("all");
        setUaFamily("all");
        setTimeMode("relative");
        setStartTsUtc(null);
        setEndTsUtc(null);
        setDraftService(serviceRef.current);
        setDraftRegion("all");
        setDraftPop("all");
        setDraftWindowMinutes(120);
        setDraftContentType("all");
        setDraftUaFamily("all");
        setDraftTimeMode("relative");
        setDraftStartUtcLocal("");
        setDraftEndUtcLocal("");
        setFiltersDirty(false);

        pushRunLog("TTL expired: reset non-sticky filters (kept partner + service).");
      } catch {}
    };

    tick();
    const id = window.setInterval(tick, 15_000);
    return () => window.clearInterval(id);
  }, [mounted]);

  useEffect(() => {
    if (!mounted) return;
    if (!service) {
      safeDelLS(FILTERS_KEY);
      return;
    }
    saveFiltersToTTL({
      region,
      pop,
      windowMinutes,
      contentType,
      uaFamily,
      timeMode,
      startTsUtc,
      endTsUtc,
    });
  }, [
    mounted,
    service,
    region,
    pop,
    windowMinutes,
    contentType,
    uaFamily,
    timeMode,
    startTsUtc,
    endTsUtc,
  ]);

  useEffect(() => {
    if (!mounted) return;
    (async () => {
      try {
        const resp = await fetch("/api/schema");
        const json = await resp.json().catch(() => null);
        if (!resp.ok || !json?.ok || !json?.schema) return;

        const s = json.schema as SchemaState;
        const next: SchemaState = {
          partners: Array.isArray(s.partners) ? s.partners.map(String) : [...CANON.partners],
          services: Array.isArray(s.services) ? s.services.map(String) : [...CANON.services],
          regions: Array.isArray(s.regions) ? s.regions.map(String) : [...CANON.regions],
          pops: Array.isArray(s.pops) ? s.pops.map(String) : [...CANON.pops],
          contentTypes: Array.isArray(s.contentTypes)
            ? s.contentTypes.map(String)
            : ["all", ...CANON.contentTypes],
          uaFamilies: Array.isArray(s.uaFamilies)
            ? s.uaFamilies.map(String)
            : ["all", ...CANON.uaFamilies],
        };

        if (!next.contentTypes.includes("all")) next.contentTypes = ["all", ...next.contentTypes];
        if (!next.uaFamilies.includes("all")) next.uaFamilies = ["all", ...next.uaFamilies];

        setSchemaState(next);
      } catch {}
    })();
  }, [mounted]);

  useEffect(() => {
    const last = chatMessages[chatMessages.length - 1];
    if (!last) return;
    if (lastMsgIdRef.current !== last.id) {
      lastMsgIdRef.current = last.id;
      chatScrollRef.current?.scrollTo({
        top: chatScrollRef.current.scrollHeight,
        behavior: "smooth",
      });
    }
  }, [chatMessages]);

  const availableRegions = useMemo(() => {
    const uniq = Array.from(
      new Set(
        (schemaState.regions || [])
          .map((x) => String(x || "").trim())
          .filter(Boolean)
      )
    ).sort((a, b) => a.localeCompare(b));
    return ["all", ...uniq];
  }, [schemaState.regions]);

  const availablePops = useMemo(() => {
    const uniq = Array.from(
      new Set(
        (schemaState.pops || [])
          .map((x) => String(x || "").trim())
          .filter(Boolean)
      )
    ).sort((a, b) => a.localeCompare(b));
    return ["all", ...uniq];
  }, [schemaState.pops]);

  const availableContentTypes = useMemo(() => {
    const uniq = Array.from(
      new Set(
        (schemaState.contentTypes || [])
          .map((x) => String(x || "").trim())
          .filter(Boolean)
      )
    ).sort((a, b) => a.localeCompare(b));
    return uniq.includes("all") ? uniq : ["all", ...uniq];
  }, [schemaState.contentTypes]);

  const availableUaFamilies = useMemo(() => {
    const uniq = Array.from(
      new Set(
        (schemaState.uaFamilies || [])
          .map((x) => String(x || "").trim())
          .filter(Boolean)
      )
    ).sort((a, b) => a.localeCompare(b));
    return uniq.includes("all") ? uniq : ["all", ...uniq];
  }, [schemaState.uaFamilies]);

    const latestTriageRun = useMemo<ChatTriage["run"] | null>(() => {
    for (let i = chatMessages.length - 1; i >= 0; i--) {
      const m = chatMessages[i];
      if (m.type === "triage") return m.run;
    }
    return null;
  }, [chatMessages]);

    const latestInvestigationContext = useMemo<InvestigationContext | null>(() => {
      let candidateRun: ChatTriage["run"] | null = null;

      for (let i = chatMessages.length - 1; i >= 0; i--) {
        const msg = chatMessages[i];
        if (msg.type !== "triage") continue;

        const metrics = msg.run.metricsJson || {};
        const hasRegionEvidence =
          Array.isArray(metrics.regionBreakdown) && metrics.regionBreakdown.length > 0;
        const hasPopEvidence =
          Array.isArray(metrics.popBreakdown) && metrics.popBreakdown.length > 0;
        const hasEvidenceBundleRegion =
          Array.isArray(metrics?.evidenceBundle?.regionBreakdown) &&
          metrics.evidenceBundle.regionBreakdown.length > 0;
        const hasEvidenceBundlePop =
          Array.isArray(metrics?.evidenceBundle?.popBreakdown) &&
          metrics.evidenceBundle.popBreakdown.length > 0;

        if (hasRegionEvidence || hasPopEvidence || hasEvidenceBundleRegion || hasEvidenceBundlePop) {
          candidateRun = msg.run;
          break;
        }

        if (!candidateRun) {
          candidateRun = msg.run;
        }
      }

      if (!candidateRun) return null;

      return buildLatestInvestigationContext({
        run: candidateRun,
        availableRegions,
        availablePops,
        availableContentTypes,
        availableUaFamilies,
      });
    }, [
      chatMessages,
      availableRegions,
      availablePops,
      availableContentTypes,
      availableUaFamilies,
    ]);

  function buildMissingContextReply(
    followUpKind?: ReturnType<typeof parseTriageIntent>["followUpKind"] | null
  ): string {
    switch (followUpKind) {
      case "compare_previous_window":
        return "Compare with previous window needs a prior triage result. Run a triage first, then compare it.";
      case "drilldown_region":
        return "I need a prior triage result with region evidence before I can drill into the worst region.";
      case "drilldown_pop":
        return "I need a prior triage result with POP evidence before I can drill into the worst POP.";
      case "drilldown_dimension":
        return "That refinement needs a prior triage result. Run a triage first, then narrow it with region, POP, content type, or device filters.";
      case "repeat_or_refresh":
        return "There is no prior triage result to refresh yet. Run a triage first.";
      case "explain_signal":
        return "I need a prior triage result before I can explain what is driving the current signal.";
      default:
        return "Run a triage first, then I can refine or compare results.";
    }
  }

  function resolveFollowupAction(args: {
    parseResult: ReturnType<typeof parseTriageIntent>;
    ctx: InvestigationContext | null;
  }):
    | { kind: "missing_context"; replyText: string }
    | { kind: "rerun"; inputs: TriageInputs; reason: string }
    | { kind: "unhandled" } {
    const { parseResult, ctx } = args;

    const followUpKind = parseResult.followUpKind ?? null;
    if (!followUpKind) return { kind: "unhandled" };

    if (!ctx) {
      return {
        kind: "missing_context",
        replyText: buildMissingContextReply(followUpKind),
      };
    }

    const allowedRegions = ctx.availableDimensions.regions || [];
    const allowedPops = ctx.availableDimensions.pops || [];
    const allowedContentTypes = ctx.availableDimensions.contentTypes || [];
    const allowedUaFamilies = ctx.availableDimensions.uaFamilies || [];

    if (followUpKind === "repeat_or_refresh") {
      return {
        kind: "rerun",
        inputs: deriveRefreshInputs(ctx),
        reason: "repeat_or_refresh",
      };
    }

    if (followUpKind === "compare_previous_window") {
      return {
        kind: "rerun",
        inputs: derivePreviousWindowInputs(ctx),
        reason: "compare_previous_window",
      };
    }

    if (followUpKind === "drilldown_region") {
      const inputs = deriveWorstRegionInputs(ctx);
      if (!inputs) {
        return {
          kind: "missing_context",
          replyText:
            "I need region evidence from the last run before I can drill into the worst region.",
        };
      }

      return {
        kind: "rerun",
        inputs,
        reason: "drilldown_region",
      };
    }

    if (followUpKind === "drilldown_pop") {
      const inputs = deriveWorstPopInputs(ctx);
      if (!inputs) {
        return {
          kind: "missing_context",
          replyText:
            "I need POP evidence from the last run before I can drill into the worst POP.",
        };
      }

      return {
        kind: "rerun",
        inputs,
        reason: "drilldown_pop",
      };
    }

    if (followUpKind === "drilldown_ua") {
      return {
        kind: "rerun",
        inputs: contextToTriageInputs(ctx),
        reason: "drilldown_ua",
      };
    }

    if (followUpKind === "drilldown_content") {
      return {
        kind: "rerun",
        inputs: contextToTriageInputs(ctx),
        reason: "drilldown_content",
      };
    }

    if (followUpKind === "drilldown_dimension") {
      const overrides: {
        region?: string;
        pop?: string;
        contentType?: string;
        uaFamily?: string;
        service?: string;
      } = {};

      const rawText = parseResult.rawText || "";

      const regionDetection = detectRegionOverrideFromText(rawText);
      const popDetection = detectPopOverrideFromText(rawText);
      const uaDetection = detectUaFamilyOverrideFromText(rawText);
      const contentTypeDetection = detectContentTypeOverrideFromText(rawText);

      if (parseResult.serviceCanonical) {
        overrides.service = parseResult.serviceCanonical;
      }

      if (regionDetection.mentioned) {
        if (!regionDetection.value) {
          return {
            kind: "missing_context",
            replyText: `I couldn't resolve region "${regionDetection.sourceText || "unknown"}". Use one of: ${allowedRegions.join(", ")}.`,
          };
        }

        if (!allowedRegions.includes(regionDetection.value)) {
          return {
            kind: "missing_context",
            replyText: `Region "${regionDetection.value}" is valid, but it is not available in the current scope. Available regions: ${allowedRegions.join(", ")}.`,
          };
        }

        overrides.region = regionDetection.value;
      }

      if (popDetection.mentioned) {
        if (!popDetection.value) {
          return {
            kind: "missing_context",
            replyText: `I couldn't resolve POP "${popDetection.sourceText || "unknown"}". Use one of: ${allowedPops.join(", ")}.`,
          };
        }

        if (!allowedPops.includes(popDetection.value)) {
          return {
            kind: "missing_context",
            replyText: `POP "${popDetection.value}" is valid, but it is not available in the current scope. Available POPs: ${allowedPops.join(", ")}.`,
          };
        }

        overrides.pop = popDetection.value;
      }

      if (uaDetection.mentioned) {
        if (!uaDetection.value) {
          return {
            kind: "missing_context",
            replyText: `I couldn't resolve device type "${uaDetection.sourceText || "unknown"}". Use one of: ${allowedUaFamilies.join(", ")}.`,
          };
        }

        if (!allowedUaFamilies.includes(uaDetection.value)) {
          return {
            kind: "missing_context",
            replyText: `Device type "${uaDetection.value}" is valid, but it is not available in the current scope. Available device types: ${allowedUaFamilies.join(", ")}.`,
          };
        }

        overrides.uaFamily = uaDetection.value;
      }

      if (contentTypeDetection.mentioned) {
        if (!contentTypeDetection.value) {
          return {
            kind: "missing_context",
            replyText: `I couldn't resolve content type "${contentTypeDetection.sourceText || "unknown"}". Use one of: ${allowedContentTypes.join(", ")}.`,
          };
        }

        if (!allowedContentTypes.includes(contentTypeDetection.value)) {
          return {
            kind: "missing_context",
            replyText: `Content type "${contentTypeDetection.value}" is valid, but it is not available in the current scope. Available content types: ${allowedContentTypes.join(", ")}.`,
          };
        }

        overrides.contentType = contentTypeDetection.value;
      }

      return {
        kind: "rerun",
        inputs: deriveScopedFollowupInputs(ctx, overrides),
        reason: "drilldown_dimension",
      };
    }

    return { kind: "unhandled" };
  }

  function isAllowed(val: string, allowed: string[]) {
    const v = String(val ?? "").trim();
    return v ? allowed.includes(v) : false;
  }

  function openFilters() {
    setFiltersOpen(true);
    setDraftService(service);
    setDraftRegion(region);
    setDraftPop(pop);
    setDraftWindowMinutes(windowMinutes);
    setDraftContentType(contentType);
    setDraftUaFamily(uaFamily);
    setDraftTimeMode(timeMode);
    setDraftStartUtcLocal(isoToDatetimeLocalUtc(startTsUtc));
    setDraftEndUtcLocal(isoToDatetimeLocalUtc(endTsUtc));
    setFiltersDirty(false);
  }

  function applyDraftFilters() {
    const s = String(draftService || "").trim();
    if (!s) return { ok: false as const, error: "Pick a service before Apply." };
    if (!(SERVICE_OPTIONS as readonly string[]).includes(s)) {
      return { ok: false as const, error: "Invalid service selection." };
    }

    setServiceSticky(s);
    setDraftService(s);

    const tm: TimeMode = draftTimeMode === "absolute" ? "absolute" : "relative";
    if (tm === "absolute") {
      const sIso = parseDatetimeLocalAsUtcToIso(draftStartUtcLocal);
      const eIso = parseDatetimeLocalAsUtcToIso(draftEndUtcLocal);
      if (!sIso || !eIso) {
        return {
          ok: false as const,
          error: "Pick start and end time (UTC) using the calendar inputs.",
        };
      }
      const sMs = new Date(sIso).getTime();
      const eMs = new Date(eIso).getTime();
      if (!Number.isFinite(sMs) || !Number.isFinite(eMs) || eMs <= sMs) {
        return { ok: false as const, error: "Invalid range: end must be after start." };
      }
      setTimeMode("absolute");
      setStartTsUtc(sIso);
      setEndTsUtc(eIso);
      const derivedWin = windowMinutesFromRange(sIso, eIso, draftWindowMinutes || 120);
      setWindowMinutes(derivedWin);
      setDraftWindowMinutes(derivedWin);
    } else {
      setTimeMode("relative");
      setStartTsUtc(null);
      setEndTsUtc(null);
      setWindowMinutes(Number(draftWindowMinutes) || 120);
    }

    const ct = String(draftContentType || "all").trim() || "all";
    const ua = String(draftUaFamily || "all").trim() || "all";
    const allowedCT = availableContentTypes.length
      ? availableContentTypes
      : ["all", "manifest", "segment", "api"];
    const allowedUA = availableUaFamilies.length
      ? availableUaFamilies
      : ["all", "stb", "mobile", "web", "smart_tv", "console"];

    if (!isAllowed(ct, allowedCT)) {
      return { ok: false as const, error: "Invalid contentType selection." };
    }
    if (!isAllowed(ua, allowedUA)) {
      return { ok: false as const, error: "Invalid uaFamily selection." };
    }

    setRegion(String(draftRegion || "all"));
    setPop(String(draftPop || "all"));
    setContentType(ct);
    setUaFamily(ua);
    setFiltersDirty(false);
    setFiltersOpen(false);

    pushRunLog(
      `Applied filters: svc=${s} timeMode=${tm} region=${draftRegion} pop=${draftPop} win=${draftWindowMinutes}m ct=${ct} ua=${ua}`
    );
    return { ok: true as const };
  }

  async function runTriage(
    inputs: TriageInputs,
    extra?: { drillIntent?: "worst_region" | "worst_pop" | "worst_ua" | "worst_content" }
  ) {
    const formData = new FormData();
    formData.append("dataSource", inputs.dataSource);
    formData.append("partner", inputs.partner || "");
    formData.append("csvUrl", "");
    formData.append("service", inputs.service);
    formData.append("region", inputs.region);
    formData.append("pop", inputs.pop);
    formData.append("windowMinutes", String(inputs.windowMinutes));
    formData.append("contentType", String(inputs.contentType || "all"));
    formData.append("uaFamily", String(inputs.uaFamily || "all"));
    if (extra?.drillIntent) formData.append("drillIntent", extra.drillIntent);
    if (inputs.startTsUtc) formData.append("startTsUtc", inputs.startTsUtc);
    if (inputs.endTsUtc) formData.append("endTsUtc", inputs.endTsUtc);

    const response = await fetch("/api/triage", { method: "POST", body: formData });
    const data = (await response.json().catch(() => null)) as TriageResponse | null;

    if (!response.ok) {
      throw new Error(
        data && !(data as any).ok ? (data as any).error : `Triage failed (HTTP ${response.status})`
      );
    }
    if (!data) throw new Error("Triage failed (empty response)");
    if (!(data as any).ok) throw new Error((data as any).error);

    return {
      kind: (data as any).kind ?? "triage",
      summaryText: (data as any).summaryText ?? (data as any).summary ?? "",
      metricsJson: (data as any).metricsJson ?? null,
      sql: (data as any).sql ?? null,
      swarm: (data as any).swarm ?? null,
      drill: (data as any).drill ?? null,
    };
  }

  async function executeTriageRun(
    inputs: TriageInputs,
    scopeSource: "filters" | "chat",
    extra?: {
      chatContext?: ChatTriage["run"]["chatContext"];
      drillIntent?: "worst_region" | "worst_pop" | "worst_ua" | "worst_content";
    }
  ) {
    if (isTriageLoading) return;
    setIsTriageLoading(true);
    setTyping(true);
    try {
      const timeLabel =
        inputs.startTsUtc && inputs.endTsUtc
          ? `abs=${isoToUtcText(inputs.startTsUtc)}→${isoToUtcText(inputs.endTsUtc)} UTC`
          : `win=${inputs.windowMinutes}m`;
      pushRunLog(
        `Running triage [${scopeSource}]: partner=${inputs.partner} svc=${inputs.service} region=${inputs.region} pop=${inputs.pop} ${timeLabel} ct=${inputs.contentType} ua=${inputs.uaFamily}`
      );
      const data = await runTriage(inputs, {
        drillIntent: extra?.drillIntent,
      });

      if (data.kind === "drill" && data.drill) {
        addDrillCard({
          drill: data.drill,
          summaryText: data.summaryText || "",
        });
      } else {
        addTriageCard({
          inputs,
          summaryText: data.summaryText || "",
          metricsJson: data.metricsJson || null,
          sql: data.sql || null,
          swarm: data.swarm || null,
          scopeSource,
          chatContext: extra?.chatContext ?? null,
        });
      }

      setPendingChatScope({
        partner: "",
        service: "",
      });

    } catch (e: any) {
      const msg = String(e?.message || "").toLowerCase();

      if (msg.includes("invalid region")) {
        addText(
          "assistant",
          `⚠️ I couldn't resolve that region. Use one of: ${availableRegions.join(", ")}.`
        );
      } else if (msg.includes("invalid pop")) {
        addText(
          "assistant",
          `⚠️ I couldn't resolve that POP. Use one of: ${availablePops.join(", ")}.`
        );
      } else if (msg.includes("invalid uafamily")) {
        addText(
          "assistant",
          `⚠️ I couldn't resolve that device type. Use one of: ${availableUaFamilies.join(", ")}.`
        );
      } else if (msg.includes("invalid contenttype")) {
        addText(
          "assistant",
          `⚠️ I couldn't resolve that content type. Use one of: ${availableContentTypes.join(", ")}.`
        );
      } else if (msg.includes("missing partner")) {
        addText("assistant", "⚠️ Please select a partner first.");
      } else if (msg.includes("missing service")) {
        addText("assistant", "⚠️ Please select a service (live, vod, etc).");
      } else {
        // fallback
        addText("assistant", `⚠️ ${e?.message || "Triage failed."}`);
      }
    } finally {
      setTyping(false);
      setIsTriageLoading(false);
    }
  }

  async function handleRunFromFilters() {
    if (!partner) {
      addText("assistant", `Pick a partner first. (${PARTNER_OPTIONS.join(", ")})`);
      return;
    }
    if (!service) {
      addText("assistant", `Pick a service first. Open Filters, then Apply. (${SERVICE_OPTIONS.join(", ")})`);
      return;
    }

    const effectiveWin =
      timeMode === "absolute" && startTsUtc && endTsUtc
        ? windowMinutesFromRange(startTsUtc, endTsUtc, windowMinutes)
        : windowMinutes;

    await executeTriageRun(
      {
        dataSource: "clickhouse",
        partner,
        service,
        region,
        pop,
        windowMinutes: effectiveWin,
        startTsUtc: timeMode === "absolute" ? startTsUtc : null,
        endTsUtc: timeMode === "absolute" ? endTsUtc : null,
        contentType,
        uaFamily,
      },
      "filters"
    );
  }

  async function handleSend() {
    const text = chatInput.trim();
    if (!text || isTriageLoading) return;

    setChatInput("");
    addText("user", text);

    const parseResult = parseTriageIntent({
      text,
      hasPriorContext: Boolean(latestTriageRun),
    });

    pushRunLog(
      `Intent parse: kind=${parseResult.intentKind} shouldTrigger=${parseResult.shouldTrigger} partner=${parseResult.partnerCanonical || "-"} service=${parseResult.serviceCanonical || "-"} time=${parseResult.timeMeta?.kind || "-"}`
    );

    if (!parseResult.shouldTrigger) {
      addText(
        "assistant",
        parseResult.replyText ||
          "That didn't look like a triage request. Ask about traffic, latency, errors, cache, or incidents — or click Run Triage with the current scope."
      );
      return;
    }

    const followupAction = resolveFollowupAction({
      parseResult,
      ctx: latestInvestigationContext,
    });

    if (followupAction.kind === "missing_context") {
      addText("assistant", followupAction.replyText);
      return;
    }

    if (followupAction.kind === "rerun") {
      pushRunLog(`Follow-up rerun resolved: ${followupAction.reason}`);

      const followUpDrillIntent =
        parseResult.followUpKind === "drilldown_region"
          ? "worst_region"
          : parseResult.followUpKind === "drilldown_pop"
          ? "worst_pop"
          : parseResult.followUpKind === "drilldown_ua"
          ? "worst_ua"
          : parseResult.followUpKind === "drilldown_content"
          ? "worst_content"
          : undefined;

      await executeTriageRun(followupAction.inputs, "chat", {
        drillIntent: followUpDrillIntent,
        chatContext: {
          rawText: parseResult.rawText,
          parseMode: "chat-overrides",
          detected: {
            followUpKind: parseResult.followUpKind ?? null,
            followUpReason: followupAction.reason,
            derivedFromLatestRun: true,
            latestContextSummary: latestInvestigationContext
              ? {
                  baseScope: latestInvestigationContext.baseScope,
                  time: latestInvestigationContext.time,
                  worstRegion: latestInvestigationContext.worstRegion?.value ?? null,
                  worstPop: latestInvestigationContext.worstPop?.value ?? null,
                  availableRegionCount: latestInvestigationContext.availableDimensions.regions.length,
                  availablePopCount: latestInvestigationContext.availableDimensions.pops.length,
                  availableContentTypeCount:
                    latestInvestigationContext.availableDimensions.contentTypes.length,
                  availableUaFamilyCount:
                    latestInvestigationContext.availableDimensions.uaFamilies.length,
                }
              : null,
            rerunScope: {
              partner: followupAction.inputs.partner,
              service: followupAction.inputs.service,
              region: followupAction.inputs.region,
              pop: followupAction.inputs.pop,
              contentType: followupAction.inputs.contentType,
              uaFamily: followupAction.inputs.uaFamily,
              windowMinutes: followupAction.inputs.windowMinutes,
              startTsUtc: followupAction.inputs.startTsUtc ?? null,
              endTsUtc: followupAction.inputs.endTsUtc ?? null,
            },
          },
        },
      });
      return;
    }

    const mergedPartner =
      (parseResult.partnerCanonical ||
        pendingChatScope.partner ||
        latestTriageRun?.inputs.partner ||
        partner ||
        "") as PartnerOrMissing;

    const mergedService =
      parseResult.serviceCanonical ||
      pendingChatScope.service ||
      latestTriageRun?.inputs.service ||
      service ||
      "";

    if (!mergedPartner || !mergedService) {
      setPendingChatScope({
        partner: mergedPartner,
        service: mergedService,
      });

      if (!mergedPartner && !mergedService) {
        addText(
          "assistant",
          `Pick a partner and service first. Partners: ${PARTNER_OPTIONS.join(", ")}. Services: ${SERVICE_OPTIONS.join(", ")}.`
        );
        return;
      }

      if (!mergedPartner) {
        addText(
          "assistant",
          `Got it${mergedService ? ` — service=${mergedService}` : ""}. Now pick a partner. (${PARTNER_OPTIONS.join(", ")})`
        );
        return;
      }

      addText(
        "assistant",
        `Got it${mergedPartner ? ` — partner=${mergedPartner}` : ""}. Now pick a service. (${SERVICE_OPTIONS.join(", ")})`
      );
      return;
    }

    const built = buildChatInputsFromIntent({
      parseResult,
      resolvedPartner: mergedPartner,
      resolvedService: mergedService,
      region,
      pop,
      windowMinutes,
      contentType,
      uaFamily,
      allowedRegions: availableRegions,
      allowedPops: availablePops,
      allowedContentTypes: availableContentTypes,
      allowedUaFamilies: availableUaFamilies,
      now: new Date(),
    });
  

    if (!built.ok) {
      addText("assistant", built.error);
      return;
    }

    await executeTriageRun(built.inputs, "chat", {
      chatContext: {
        ...(built.chatContext || {}),
        detected: {
          ...(built.chatContext?.detected || {}),
          mergedPartner,
          mergedService,
          pendingScopeUsed: Boolean(
            pendingChatScope.partner || pendingChatScope.service
          ),
        },
      },
    });
  }
    
  const latestAssessment = latestTriageRun?.swarm?.assessment ?? null;
  const headerStatusLabel = uiStatusLabel(
    latestAssessment?.overallStatus,
    isTriageLoading
  );
  const headerStatusClass = uiStatusClass(
    latestAssessment?.overallStatus,
    isTriageLoading
  );

  const scopeSummary = useMemo(() => {
    if (isTriageLoading) return `Status: ${headerStatusLabel}`;
    if (!latestTriageRun || !latestAssessment?.overallStatus) return "Status: Idle";
    const run = latestTriageRun.inputs;
    const timeText =
      run.startTsUtc && run.endTsUtc
        ? `${isoToUtcText(run.startTsUtc)} → ${isoToUtcText(run.endTsUtc)} UTC`
        : `last ${run.windowMinutes}m`;
    return `Status: ${headerStatusLabel} • ${run.partner || "—"} • ${run.service || "—"} • ${run.region || "all"} • ${timeText}`;
  }, [
    isTriageLoading,
    latestTriageRun,
    latestAssessment?.overallStatus,
    headerStatusLabel,
  ]);

  const utcWindowPreview = useMemo(() => {
    if (draftTimeMode !== "absolute") return "";
    return computeWindowPreview(draftStartUtcLocal, draftEndUtcLocal);
  }, [draftTimeMode, draftStartUtcLocal, draftEndUtcLocal]);

  return (
    <main className="min-h-screen bg-black text-gray-100">
      <div className="sticky top-0 z-50 border-b border-white/10 bg-black/75 backdrop-blur">
        <div className="mx-auto max-w-6xl px-6 py-4">
          <div className="flex items-center gap-3">
            <Image src={LOGO_SRC} alt="Cachey" width={34} height={34} className="rounded-full" />
            <div className="min-w-0">
              <div className="font-semibold text-lg text-white leading-tight">
                Cachey <span className="text-gray-400">🤖</span>
              </div>
            </div>
            <div className="ml-auto flex items-center gap-2">
              <a
                href="/debug"
                className="rounded-full border border-white/10 bg-white/10 px-4 py-2 text-sm text-gray-100 hover:bg-white/15"
              >
                Debug
              </a>
            </div>
          </div>
          <div className={`mt-3 text-sm ${headerStatusClass}`}>{scopeSummary}</div>
        </div>
      </div>

      <div className="mx-auto max-w-6xl px-6 py-6">
        {filtersOpen && (
          <div className="mb-6 rounded-2xl border border-white/10 bg-white/[0.04] p-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-sm font-semibold text-white">Scope Controls</div>
                <div className="text-xs text-gray-400 mt-1">
                  Apply updates the active scope. Run uses the applied scope.
                  <span className="ml-2 text-gray-500">(TTL: 10m · service persists)</span>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setDraftService(service);
                    setDraftRegion(region);
                    setDraftPop(pop);
                    setDraftWindowMinutes(windowMinutes);
                    setDraftContentType(contentType);
                    setDraftUaFamily(uaFamily);
                    setDraftTimeMode(timeMode);
                    setDraftStartUtcLocal(isoToDatetimeLocalUtc(startTsUtc));
                    setDraftEndUtcLocal(isoToDatetimeLocalUtc(endTsUtc));
                    setFiltersDirty(false);
                  }}
                  className="rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-xs hover:bg-white/10"
                >
                  Reset draft
                </button>
                <button
                  type="button"
                  onClick={resetAllFilters}
                  className="rounded-lg border border-white/10 bg-red-500/10 px-3 py-2 text-xs text-red-200 hover:bg-red-500/15"
                >
                  Clear all
                </button>
                <button
                  type="button"
                  onClick={() => setFiltersOpen(false)}
                  className="rounded-lg border border-white/10 bg-white/10 px-3 py-2 text-xs hover:bg-white/15"
                >
                  Close
                </button>
              </div>
            </div>

            <div className="mt-4 grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3">
              <div className="min-w-0">
                <div className="text-xs text-gray-400 mb-1">
                  Partner <span className="text-amber-300">*</span>
                </div>
                <select
                  className="w-full rounded-lg border border-white/10 bg-white/10 text-gray-100 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500/40"
                  value={partner}
                  onChange={(e) => {
                    setPartnerSticky(e.target.value);
                    setFiltersDirty(true);
                  }}
                  disabled={!mounted}
                >
                  <option value="" className="bg-black">
                    Select…
                  </option>
                  {PARTNER_OPTIONS.map((p) => (
                    <option key={p} value={p} className="bg-black">
                      {p}
                    </option>
                  ))}
                </select>
              </div>

              <div className="min-w-0">
                <div className="text-xs text-gray-400 mb-1">
                  Service <span className="text-amber-300">*</span>
                </div>
                <select
                  className="w-full rounded-lg border border-white/10 bg-white/10 text-gray-100 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500/40"
                  value={draftService}
                  onChange={(e) => {
                    setDraftService(String(e.target.value || ""));
                    setFiltersDirty(true);
                  }}
                  disabled={!mounted}
                >
                  <option value="" className="bg-black">
                    Select…
                  </option>
                  {SERVICE_OPTIONS.map((s) => (
                    <option key={s} value={s} className="bg-black">
                      {s}
                    </option>
                  ))}
                </select>
              </div>

              <div className="min-w-0">
                <div className="text-xs text-gray-400 mb-1">Region</div>
                <select
                  className="w-full rounded-lg border border-white/10 bg-white/10 text-gray-100 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500/40"
                  value={draftRegion}
                  onChange={(e) => {
                    setDraftRegion(String(e.target.value || "all"));
                    setFiltersDirty(true);
                  }}
                  disabled={!mounted}
                >
                  {availableRegions.map((r) => (
                    <option key={r} value={r} className="bg-black">
                      {r}
                    </option>
                  ))}
                </select>
              </div>

              <div className="min-w-0">
                <div className="text-xs text-gray-400 mb-1">POP</div>
                <select
                  className="w-full rounded-lg border border-white/10 bg-white/10 text-gray-100 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500/40"
                  value={draftPop}
                  onChange={(e) => {
                    setDraftPop(String(e.target.value || "all"));
                    setFiltersDirty(true);
                  }}
                  disabled={!mounted}
                >
                  {availablePops.map((p) => (
                    <option key={p} value={p} className="bg-black">
                      {p}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="mt-3 grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3">
              <div className="min-w-0">
                <div className="text-xs text-gray-400 mb-1">Content Type</div>
                <select
                  className="w-full rounded-lg border border-white/10 bg-white/10 text-gray-100 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500/40"
                  value={draftContentType}
                  onChange={(e) => {
                    setDraftContentType(String(e.target.value || "all"));
                    setFiltersDirty(true);
                  }}
                  disabled={!mounted}
                >
                  {availableContentTypes.map((ct) => (
                    <option key={ct} value={ct} className="bg-black">
                      {ct}
                    </option>
                  ))}
                </select>
              </div>

              <div className="min-w-0">
                <div className="text-xs text-gray-400 mb-1">UA Family</div>
                <select
                  className="w-full rounded-lg border border-white/10 bg-white/10 text-gray-100 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500/40"
                  value={draftUaFamily}
                  onChange={(e) => {
                    setDraftUaFamily(String(e.target.value || "all"));
                    setFiltersDirty(true);
                  }}
                  disabled={!mounted}
                >
                  {availableUaFamilies.map((ua) => (
                    <option key={ua} value={ua} className="bg-black">
                      {ua}
                    </option>
                  ))}
                </select>
              </div>

              <div className="min-w-0 xl:col-span-2">
                <div className="flex items-center justify-between mb-1">
                  <div className="text-xs text-gray-400">Time Window</div>
                  <div className="text-[11px] text-blue-400/70 font-mono">UTC</div>
                </div>

                <div className="flex items-center gap-2 mb-2">
                  <button
                    type="button"
                    onClick={() => {
                      setDraftTimeMode("relative");
                      setFiltersDirty(true);
                    }}
                    className={`px-3 py-1.5 rounded-full border text-xs transition ${
                      draftTimeMode === "relative"
                        ? "border-blue-400/40 bg-blue-400/15 text-blue-100"
                        : "border-white/10 bg-white/5 text-gray-200 hover:bg-white/10"
                    }`}
                  >
                    Relative
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setDraftTimeMode("absolute");
                      setFiltersDirty(true);
                    }}
                    className={`px-3 py-1.5 rounded-full border text-xs transition ${
                      draftTimeMode === "absolute"
                        ? "border-blue-400/40 bg-blue-400/15 text-blue-100"
                        : "border-white/10 bg-white/5 text-gray-200 hover:bg-white/10"
                    }`}
                  >
                    Absolute
                  </button>
                </div>

                {draftTimeMode === "relative" ? (
                  <select
                    className="w-full rounded-lg border border-white/10 bg-white/10 text-gray-100 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500/40"
                    value={String(draftWindowMinutes)}
                    onChange={(e) => {
                      setDraftWindowMinutes(Number(e.target.value));
                      setFiltersDirty(true);
                    }}
                    disabled={!mounted}
                  >
                    {[30, 60, 120, 360, 720, 1440].map((m) => (
                      <option key={m} value={String(m)} className="bg-black">
                        Last {m}m
                      </option>
                    ))}
                  </select>
                ) : (
                  <div className="space-y-2">
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <div className="text-[11px] text-gray-400 mb-1">Start (UTC)</div>
                        <input
                          type="datetime-local"
                          value={draftStartUtcLocal}
                          onChange={(e) => {
                            setDraftStartUtcLocal(e.target.value);
                            setFiltersDirty(true);
                          }}
                          className="w-full rounded-lg border border-white/10 bg-white/10 text-gray-100 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500/40"
                        />
                      </div>
                      <div>
                        <div className="text-[11px] text-gray-400 mb-1">End (UTC)</div>
                        <input
                          type="datetime-local"
                          value={draftEndUtcLocal}
                          onChange={(e) => {
                            setDraftEndUtcLocal(e.target.value);
                            setFiltersDirty(true);
                          }}
                          className="w-full rounded-lg border border-white/10 bg-white/10 text-gray-100 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500/40"
                        />
                      </div>
                    </div>

                    <div className="flex items-center justify-between gap-2">
                      <div className="text-[11px] font-mono text-blue-300/80 min-h-[16px]">
                        {utcWindowPreview && (
                          <>
                            <span className="text-gray-500 mr-1">
                              {draftStartUtcLocal
                                ? isoToUtcText(parseDatetimeLocalAsUtcToIso(draftStartUtcLocal))
                                : "—"}
                            </span>
                            <span className="text-gray-500 mx-1">→</span>
                            <span className="text-gray-500 mr-2">
                              {draftEndUtcLocal
                                ? isoToUtcText(parseDatetimeLocalAsUtcToIso(draftEndUtcLocal))
                                : "—"}
                            </span>
                            <span className="text-blue-300 font-semibold">{utcWindowPreview}</span>
                          </>
                        )}
                      </div>
                      <div className="flex gap-2 shrink-0">
                        <button
                          type="button"
                          onClick={() => {
                            const end = new Date();
                            const start = new Date(end.getTime() - 60 * 60 * 1000);
                            setDraftStartUtcLocal(isoToDatetimeLocalUtc(start.toISOString()));
                            setDraftEndUtcLocal(isoToDatetimeLocalUtc(end.toISOString()));
                            setFiltersDirty(true);
                          }}
                          className="rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs hover:bg-white/10"
                        >
                          Last 60m
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setDraftEndUtcLocal(isoToDatetimeLocalUtc(new Date().toISOString()));
                            setFiltersDirty(true);
                          }}
                          className="rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs hover:bg-white/10"
                        >
                          End=Now
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>

            <div className="mt-4 flex items-center justify-between gap-3">
              <div className="text-xs text-gray-400">
                Apply updates the active scope. Run executes triage with the applied scope.
              </div>
              <button
                type="button"
                disabled={!filtersDirty}
                onClick={() => {
                  const res = applyDraftFilters();
                  if (!res.ok) addText("assistant", res.error);
                }}
                className="rounded-xl px-5 py-2 text-sm font-semibold bg-white/10 hover:bg-white/15 border border-white/10 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Apply
              </button>
            </div>
          </div>
        )}

        <div className="rounded-3xl border border-white/10 bg-white/[0.05] backdrop-blur p-4 shadow-lg shadow-black/10">
          <div
            ref={chatScrollRef}
            className="h-[66vh] min-h-[520px] overflow-y-auto rounded-2xl border border-white/10 bg-black/25 p-4"
          >
            {chatMessages.length === 0 && (
              <div className="flex flex-col items-center justify-center h-full text-center gap-3 select-none">
                <div className="text-5xl opacity-25">🤖</div>
                <div className="text-base font-semibold text-gray-300">
                  Run triage to analyze CDN health
                </div>
                <div className="text-sm text-gray-500 leading-relaxed">
                  Select partner and service,
                  <br />
                  then press <span className="text-gray-300">Run Triage</span>.
                </div>
                <div className="mt-2 text-xs text-gray-600">
                  Or ask in the chat box below using ISO UTC timestamps for absolute windows.
                </div>
              </div>
            )}

            <div className="space-y-4">
              {chatMessages.map((m) => {
                const isUser = m.role === "user";
                const isSystem = m.role === "system";
                const rowAlign = isSystem
                  ? "justify-center"
                  : isUser
                  ? "justify-end"
                  : "justify-start";
                const bubbleMax = isUser ? "max-w-[70%]" : "max-w-[82%]";
                const bubbleStyle = isSystem
                  ? "border-white/10 bg-white/5 text-gray-300"
                  : isUser
                  ? "border-white/10 bg-white/10 text-gray-100"
                  : "border-white/10 bg-white/5 text-gray-100";

                return (
                  <div key={m.id} className={`flex ${rowAlign}`}>
                    <div className={`${bubbleMax} w-full`}>
                      <div
                        className={`text-[10px] text-gray-500 mb-1 ${
                          isSystem ? "text-center" : isUser ? "text-right" : "text-left"
                        }`}
                      >
                        {mounted ? `${formatUtcYmdHm(m.ts)} UTC` : m.ts}
                      </div>

                      {m.type === "text" ? (
                        <div className={`rounded-2xl border ${bubbleStyle} px-4 py-3`}>
                          <pre className="whitespace-pre-wrap text-sm leading-relaxed">
                            {m.text}
                          </pre>
                        </div>
                      ) : m.type === "triage" ? (
                        <TriageCard run={m.run} />
                      ) : (
                        <DrillCard drill={m.drill} summaryText={m.summaryText} />
                      )}
                    </div>
                  </div>
                );
              })}

              {typing && (
                <div className="flex justify-start">
                  <div className="max-w-[82%] w-full">
                    <div className="text-[10px] text-gray-500 mb-1 text-left">
                      {mounted ? `${formatUtcYmdHm(nowIso())} UTC` : nowIso()}
                    </div>
                    <div className="rounded-2xl border border-white/10 bg-white/5 px-4 py-3">
                      <TypingDots />
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="mt-4 flex gap-3">
            <input
              value={chatInput}
              onChange={(e) => setChatInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  handleSend();
                }
              }}
              placeholder="Ask about traffic, latency, errors, cache, or incidents…"
              className="flex-1 rounded-2xl border border-white/10 bg-white/10 px-4 py-3 text-sm text-white placeholder-gray-400 outline-none focus:ring-2 focus:ring-blue-500/40"
              disabled={isTriageLoading}
            />
            <button
              onClick={handleSend}
              disabled={isTriageLoading || !chatInput.trim()}
              className="rounded-2xl px-5 py-3 text-sm font-semibold bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isTriageLoading ? "Running…" : "Send"}
            </button>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={openFilters}
              className="rounded-full border border-white/10 bg-white/5 px-3 py-2 text-xs text-gray-200 hover:bg-white/10"
            >
              Filters
            </button>

            <button
              type="button"
              onClick={handleRunFromFilters}
              disabled={isTriageLoading || !partner || !service}
              className="rounded-full border border-white/10 bg-white/5 px-3 py-2 text-xs text-gray-200 hover:bg-white/10 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isTriageLoading ? "Running…" : "Run Triage"}
            </button>

            {chatMessages.length > 0 && (
              <button
                type="button"
                onClick={handleResetInvestigation}
                className="rounded-full border border-red-500/20 bg-red-500/5 px-3 py-2 text-xs text-red-300/80 hover:bg-red-500/10 hover:text-red-200"
              >
                Reset Investigation
              </button>
            )}

            {!partner || !service ? (
              <span className="text-xs text-gray-500">
                Select partner and service to run triage.
              </span>
            ) : (
              <span className="text-xs text-gray-500 truncate">{scopeSummary}</span>
            )}
          </div>

          <details
            className="mt-6 rounded-2xl border border-white/10 bg-black/25 p-4"
            open={debugOpen}
            onToggle={(e) => setDebugOpen((e.target as HTMLDetailsElement).open)}
          >
            <summary className="cursor-pointer text-sm font-semibold text-gray-200 select-none">
              Debug (internal)
            </summary>
            <div className="mt-3 max-h-[220px] overflow-auto rounded-xl border border-white/10 bg-black/30 p-3">
              {runLog.length ? (
                <div className="space-y-2">
                  {runLog
                    .slice()
                    .reverse()
                    .map((x, idx) => (
                      <div key={`${x.ts}-${idx}`} className="text-xs text-gray-300">
                        <span className="text-gray-500 mr-2">{formatUtcYmdHm(x.ts)} UTC</span>
                        {x.text}
                      </div>
                    ))}
                </div>
              ) : (
                <div className="text-xs text-gray-500">No runs yet.</div>
              )}
            </div>
          </details>

          <div className="mt-6 border-t border-white/10 pt-4 text-[11px] text-gray-500">
            Cachey • Deterministic triage assistant • ClickHouse path
          </div>
        </div>
      </div>
    </main>
  );
}
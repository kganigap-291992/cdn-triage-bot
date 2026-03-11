"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";
import type { TriageResponse } from "@/lib/triage/contracts";
import { CANON } from "@/lib/schema/canonical";

// ------------------------------------------------------------
// Home page (/) — Chat-first deterministic triage
// - UTC everywhere
// - Collapsible advanced filters
// - Chat-first layout
// - Hero graphs: Requests, Error Rate, Latency
// - Diagnostic graphs: Status, Host, CRC
// - Local focus mode for stacked charts (no DB re-query)
// ------------------------------------------------------------

const LOGO_SRC = "/cachey-logo.png";

// Sticky + TTL keys
const PARTNER_KEY = "cachey:partner";
const SERVICE_KEY = "cachey:service";
const FILTERS_KEY = "cachey:filters";
const FILTERS_TTL_MS = 10 * 60 * 1000;

const PARTNER_OPTIONS = CANON.partners;
const SERVICE_OPTIONS = CANON.services;

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
    sql?: {
      queries: string[];
      params?: Record<string, any>;
    } | null;
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
        agentId: "scope" | "traffic" | "latency" | "errors" | "cache";
        title: string;
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

type ChatMsg = ChatText | ChatTriage;

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

function windowMinutesFromRange(startIso?: string | null, endIso?: string | null, fallback = 120) {
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

// ---- UTC helpers ----
function formatUtcHM(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
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
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, "0");
  const da = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${mo}-${da}`;
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
  const dt = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], 0, 0));
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

// ---- color helpers ----
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

// ------------------------------------------------------------
// Conservative chat parsing helpers
// ------------------------------------------------------------
function findToken(text: string, allowed: readonly string[]): string | null {
  const lower = text.toLowerCase();
  for (const token of allowed) {
    if (lower.includes(String(token).toLowerCase())) return String(token);
  }
  return null;
}

function extractIsoUtcStrings(text: string): string[] {
  const matches =
    text.match(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d{3})?Z\b/g) || [];
  return matches;
}

function extractRelativeWindowMinutes(text: string): number | null {
  const lower = text.toLowerCase();

  const mMinutes = lower.match(/\blast\s+(\d+)\s*(m|min|mins|minute|minutes)\b/);
  if (mMinutes) return clamp(Number(mMinutes[1]), 5, 1440);

  const mHours = lower.match(/\blast\s+(\d+)\s*(h|hr|hrs|hour|hours)\b/);
  if (mHours) return clamp(Number(mHours[1]) * 60, 5, 1440);

  const mDays = lower.match(/\blast\s+(\d+)\s*(d|day|days)\b/);
  if (mDays) return clamp(Number(mDays[1]) * 1440, 5, 10080);

  return null;
}

function buildChatInputsFromText(args: {
  text: string;
  partner: PartnerOrMissing;
  service: string;
  region: string;
  pop: string;
  windowMinutes: number;
  contentType: string;
  uaFamily: string;
}): {
  ok: true;
  inputs: TriageInputs;
  chatContext: {
    rawText: string;
    parseMode: "filters-default" | "chat-overrides";
    detected: Record<string, any>;
  };
} | {
  ok: false;
  error: string;
} {
  const rawText = args.text.trim();
  const detected: Record<string, any> = {};
  let parseMode: "filters-default" | "chat-overrides" = "filters-default";

  const explicitPartner = findToken(rawText, PARTNER_OPTIONS);
  const explicitService = findToken(rawText, SERVICE_OPTIONS);
  const explicitRegion = findToken(rawText, CANON.regions);
  const explicitPop = findToken(rawText, CANON.pops);
  const explicitContentType = findToken(rawText, ["all", ...CANON.contentTypes]);
  const explicitUaFamily = findToken(rawText, ["all", ...CANON.uaFamilies]);

  const isoMatches = extractIsoUtcStrings(rawText);
  const relativeWindow = extractRelativeWindowMinutes(rawText);

  if (explicitPartner) {
    detected.partner = explicitPartner;
    parseMode = "chat-overrides";
  }
  if (explicitService) {
    detected.service = explicitService;
    parseMode = "chat-overrides";
  }
  if (explicitRegion) {
    detected.region = explicitRegion;
    parseMode = "chat-overrides";
  }
  if (explicitPop) {
    detected.pop = explicitPop;
    parseMode = "chat-overrides";
  }
  if (explicitContentType) {
    detected.contentType = explicitContentType;
    parseMode = "chat-overrides";
  }
  if (explicitUaFamily) {
    detected.uaFamily = explicitUaFamily;
    parseMode = "chat-overrides";
  }

  const partner = (explicitPartner || args.partner) as PartnerOrMissing;
  const service = explicitService || args.service;
  const region = explicitRegion || args.region || "all";
  const pop = explicitPop || args.pop || "all";
  const contentType = explicitContentType || args.contentType || "all";
  const uaFamily = explicitUaFamily || args.uaFamily || "all";

  if (!partner) {
    return { ok: false, error: `Pick a partner first. (${PARTNER_OPTIONS.join(", ")})` };
  }
  if (!service) {
    return { ok: false, error: `Pick a service first or mention one in chat. (${SERVICE_OPTIONS.join(", ")})` };
  }

  // Absolute UTC range: require 2 explicit ISO UTC timestamps in chat text.
  if (isoMatches.length >= 2) {
    const startTsUtc = new Date(isoMatches[0]).toISOString();
    const endTsUtc = new Date(isoMatches[1]).toISOString();
    const derivedWin = windowMinutesFromRange(startTsUtc, endTsUtc, args.windowMinutes);

    detected.startTsUtc = startTsUtc;
    detected.endTsUtc = endTsUtc;
    parseMode = "chat-overrides";

    return {
      ok: true,
      inputs: {
        dataSource: "clickhouse",
        partner,
        service,
        region,
        pop,
        windowMinutes: derivedWin,
        startTsUtc,
        endTsUtc,
        contentType,
        uaFamily,
      },
      chatContext: { rawText, parseMode, detected },
    };
  }

  // Relative window override
  if (relativeWindow != null) {
    detected.windowMinutes = relativeWindow;
    parseMode = "chat-overrides";
    return {
      ok: true,
      inputs: {
        dataSource: "clickhouse",
        partner,
        service,
        region,
        pop,
        windowMinutes: relativeWindow,
        startTsUtc: null,
        endTsUtc: null,
        contentType,
        uaFamily,
      },
      chatContext: { rawText, parseMode, detected },
    };
  }

  // Default to current applied scope if chat did not explicitly override time/scope.
  return {
    ok: true,
    inputs: {
      dataSource: "clickhouse",
      partner,
      service,
      region,
      pop,
      windowMinutes: args.windowMinutes,
      startTsUtc: null,
      endTsUtc: null,
      contentType,
      uaFamily,
    },
    chatContext: { rawText, parseMode, detected },
  };
}

// ------------------------------------------------------------
// Typing dots
// ------------------------------------------------------------
function TypingDots() {
  return (
    <div className="inline-flex items-center gap-1">
      <span className="inline-block h-1.5 w-1.5 rounded-full bg-gray-300/70 animate-bounce [animation-delay:-0.2s]" />
      <span className="inline-block h-1.5 w-1.5 rounded-full bg-gray-300/70 animate-bounce [animation-delay:-0.1s]" />
      <span className="inline-block h-1.5 w-1.5 rounded-full bg-gray-300/70 animate-bounce" />
    </div>
  );
}

// ------------------------------------------------------------
// Generic stacked chart with local focus mode
// ------------------------------------------------------------
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

  const points = zoom && zoom.end > zoom.start ? basePoints.slice(zoom.start, zoom.end + 1) : basePoints;

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
  const barW = Math.max(4, Math.floor((plotW - gap * Math.max(0, barCount - 1)) / Math.max(1, barCount)));

  const yTicks = 4;
  const tickVals = Array.from({ length: yTicks + 1 }, (_, i) => Math.round((maxTotal * (yTicks - i)) / yTicks));

  const xLabelEvery = Math.max(1, Math.floor(points.length / 6));
  const latest = points[points.length - 1];
  const latestTotal = totals[totals.length - 1] || 0;

  function toSvgX(clientX: number) {
    const el = svgRef.current;
    if (!el) return 0;
    const r = el.getBoundingClientRect();
    const rel = (clientX - r.left) / Math.max(1, r.width);
    return rel * w;
  }

  function idxFromSvgX(sx: number) {
    const raw = Math.floor((sx - padLeft) / Math.max(1, barW + gap));
    return clamp(raw, 0, Math.max(0, basePoints.length - 1));
  }

  function commitZoom(x0: number, x1: number) {
    const a = Math.min(x0, x1);
    const b = Math.max(x0, x1);
    const i0 = idxFromSvgX(a);
    const i1 = idxFromSvgX(b);
    if (i1 - i0 >= 2) setZoom({ start: i0, end: i1 });
  }

  const selectionX = Math.min(drag.x0, drag.x1);
  const selectionW = Math.abs(drag.x1 - drag.x0);

  return (
    <div className="rounded-2xl border border-white/10 bg-white/5 backdrop-blur p-4 shadow-[0_0_0_1px_rgba(255,255,255,0.04)] min-w-0">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-xs text-gray-400">{subtitle}</div>
          <div className="text-sm font-semibold text-gray-100">{title}</div>
          <div className="text-[11px] text-gray-400 mt-1">
            {ts.startTs && ts.endTs
              ? `${formatUtcYmdHm(ts.startTs)} → ${formatUtcYmdHm(ts.endTs)} UTC (bucket: ${bucketLabel(bucketSeconds)})`
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
              <>Click legend to isolate a series • Drag to zoom • double-click to reset</>
            )}
          </div>
        </div>

        <div className="text-right">
          <div className="text-xs text-gray-400">Latest</div>
          <div className="text-[11px] text-gray-200">
            {latest ? `${formatUtcHM(latest.ts)} UTC • ${latestTotal.toLocaleString()} events` : "n/a"}
          </div>
        </div>
      </div>

      <div className="mt-3 rounded-2xl border border-white/10 bg-black/30 p-3">
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
            setDrag((d) => {
              commitZoom(d.x0, d.x1);
              return { active: false, x0: 0, x1: 0 };
            });
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
          <text x={padLeft + plotW / 2} y={h - 10} fontSize="10" fill="#9ca3af" textAnchor="middle">
            Time (UTC, {bucketLabel(bucketSeconds)} buckets)
          </text>

          {tickVals.map((v, idx) => {
            const t = v / maxTotal;
            const y = padTop + (1 - t) * plotH;
            return (
              <g key={idx} opacity={0.35}>
                <line x1={padLeft} y1={y} x2={padLeft + plotW} y2={y} stroke="currentColor" />
                <text x={padLeft - 10} y={y + 3} fontSize="10" fill="#9ca3af" textAnchor="end" opacity={0.95}>
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
                      opacity={0.95}
                    />
                  );
                })}
              </g>
            );
          })}

          {points.map((p, i) => {
            const show = i % xLabelEvery === 0 || i === points.length - 1;
            if (!show) return null;
            const x = padLeft + i * (barW + gap) + barW / 2;
            const label = timeLabelShort(p.ts, windowMinutes);
            return (
              <text key={`xl-${p.ts}`} x={x} y={padTop + plotH + 18} fontSize="10" fill="#9ca3af" textAnchor="middle">
                {label}
              </text>
            );
          })}

          {drag.active && selectionW > 2 ? (
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
          ) : null}
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
                <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: seriesColor(kind, k) }} />
                <span className="truncate max-w-[220px]">{k}</span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------
// Hero line chart: Requests + Error Rate
// ------------------------------------------------------------
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
  const errMaxRaw = Math.max(0, ...errVals);
  const errMax = Math.max(0.5, errMaxRaw * 1.2 || 0.5);

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
    const t = v / reqMax;
    return padTop + (1 - t) * plotH;
  }
  function yErr(v: number) {
    const t = v / errMax;
    return padTop + (1 - t) * plotH;
  }

  const reqPts: string[] = [];
  const errPts: string[] = [];
  slice.forEach((p, i) => {
    const xx = x(i);
    reqPts.push(`${xx},${yReq(Number(p.totalRequests || 0))}`);
    const err = Number.isFinite(Number(p.errorRatePct))
      ? Number(p.errorRatePct)
      : p.totalRequests > 0
      ? (Number(p.error5xxCount || 0) / Number(p.totalRequests)) * 100
      : 0;
    errPts.push(`${xx},${yErr(err)}`);
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
    const r = el.getBoundingClientRect();
    const rel = (clientX - r.left) / Math.max(1, r.width);
    return rel * w;
  }
  function idxFromSvgX(sx: number) {
    const t = (sx - padLeft) / Math.max(1, plotW);
    const i = Math.round(t * (base.length - 1));
    return clamp(i, 0, Math.max(0, base.length - 1));
  }
  function commitZoom(x0: number, x1: number) {
    const a = Math.min(x0, x1);
    const b = Math.max(x0, x1);
    const i0 = idxFromSvgX(a);
    const i1 = idxFromSvgX(b);
    if (i1 - i0 >= 2) setZoom({ start: i0, end: i1 });
  }

  const selectionX = Math.min(drag.x0, drag.x1);
  const selectionW = Math.abs(drag.x1 - drag.x0);

  return (
    <div className="rounded-2xl border border-white/10 bg-white/5 backdrop-blur p-4 shadow-[0_0_0_1px_rgba(255,255,255,0.04)] min-w-0">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-xs text-gray-400">Traffic + incident signal</div>
          <div className="text-sm font-semibold text-gray-100">Requests / Error Rate</div>
          <div className="text-[11px] text-gray-400 mt-1">
            {slice.length
              ? `${formatUtcYmdHm(slice[0].ts)} → ${formatUtcYmdHm(slice[slice.length - 1].ts)} UTC (bucket: ${bucketLabel(
                  bucketSeconds
                )})`
              : `bucket: ${bucketLabel(bucketSeconds)} (UTC)`}
          </div>
          <div className="text-[11px] text-gray-500 mt-1">Drag to zoom • double-click to reset</div>
        </div>
        <div className="text-right">
          <div className="text-xs text-gray-400">Latest</div>
          <div className="text-[11px] text-gray-200">
            {latest
              ? `${formatUtcHM(latest.ts)} UTC • req=${formatIntOrNA(latest.totalRequests)} • err=${formatPctOrNA(
                  latestErr
                )}`
              : "n/a"}
          </div>
        </div>
      </div>

      <div className="mt-3 rounded-2xl border border-white/10 bg-black/30 p-3">
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
            setDrag((d) => {
              commitZoom(d.x0, d.x1);
              return { active: false, x0: 0, x1: 0 };
            });
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
            const reqTick = Math.round(reqMax * t);
            const errTick = errMax * t;
            return (
              <g key={idx} opacity={0.35}>
                <line x1={padLeft} y1={yy} x2={padLeft + plotW} y2={yy} stroke="currentColor" />
                <text x={padLeft - 10} y={yy + 3} fontSize="10" fill="#9ca3af" textAnchor="end">
                  {formatCountTick(reqTick)}
                </text>
                <text x={padLeft + plotW + 10} y={yy + 3} fontSize="10" fill="#9ca3af" textAnchor="start">
                  {errTick.toFixed(2)}%
                </text>
              </g>
            );
          })}

          <polyline
            fill="none"
            stroke="rgba(59,130,246,0.92)"
            strokeWidth="2.75"
            strokeLinecap="round"
            strokeLinejoin="round"
            points={reqPts.join(" ")}
          />
          <polyline
            fill="none"
            stroke="rgba(239,68,68,0.92)"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            points={errPts.join(" ")}
          />

          {slice.map((p, i) => {
            const show = i % xLabelEvery === 0 || i === slice.length - 1;
            if (!show) return null;
            const xx = x(i);
            const label = timeLabelShort(p.ts, windowMinutes);
            return (
              <text key={`xl-${p.ts}`} x={xx} y={padTop + plotH + 18} fontSize="10" fill="#9ca3af" textAnchor="middle">
                {label}
              </text>
            );
          })}

          {drag.active && selectionW > 2 ? (
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
          ) : null}
        </svg>

        <div className="mt-3 flex items-center justify-center gap-5 text-[11px] text-gray-300">
          <div className="flex items-center gap-1.5">
            <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: "rgba(59,130,246,0.92)" }} />
            <span>requests</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: "rgba(239,68,68,0.92)" }} />
            <span>error rate</span>
          </div>
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------
// Latency line chart
// ------------------------------------------------------------
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
    const t = (Number(v) - minV) / span;
    return padTop + (1 - t) * plotH;
  }

  const p95Pts: string[] = [];
  const p99Pts: string[] = [];
  slice.forEach((p, i) => {
    const yy95 = y(p.p95TtmsMs);
    const yy99 = y(p.p99TtmsMs);
    const xx = x(i);
    if (yy95 != null) p95Pts.push(`${xx},${yy95}`);
    if (yy99 != null) p99Pts.push(`${xx},${yy99}`);
  });

  const yTicks = 4;
  const tickVals = Array.from({ length: yTicks + 1 }, (_, i) => Math.round(minV + (span * (yTicks - i)) / yTicks));

  const xLabelEvery = Math.max(1, Math.floor(n / 6));
  const latest = slice[slice.length - 1];

  function toSvgX(clientX: number) {
    const el = svgRef.current;
    if (!el) return 0;
    const r = el.getBoundingClientRect();
    const rel = (clientX - r.left) / Math.max(1, r.width);
    return rel * w;
  }
  function idxFromSvgX(sx: number) {
    const t = (sx - padLeft) / Math.max(1, plotW);
    const i = Math.round(t * (base.length - 1));
    return clamp(i, 0, Math.max(0, base.length - 1));
  }
  function commitZoom(x0: number, x1: number) {
    const a = Math.min(x0, x1);
    const b = Math.max(x0, x1);
    const i0 = idxFromSvgX(a);
    const i1 = idxFromSvgX(b);
    if (i1 - i0 >= 2) setZoom({ start: i0, end: i1 });
  }

  const selectionX = Math.min(drag.x0, drag.x1);
  const selectionW = Math.abs(drag.x1 - drag.x0);

  return (
    <div className="rounded-2xl border border-white/10 bg-white/5 backdrop-blur p-4 shadow-[0_0_0_1px_rgba(255,255,255,0.04)] min-w-0">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-xs text-gray-400">Latency trend</div>
          <div className="text-sm font-semibold text-gray-100">p95 / p99 TTMS</div>
          <div className="text-[11px] text-gray-400 mt-1">
            {slice.length
              ? `${formatUtcYmdHm(slice[0].ts)} → ${formatUtcYmdHm(slice[slice.length - 1].ts)} UTC (bucket: ${bucketLabel(
                  bucketSeconds
                )})`
              : `bucket: ${bucketLabel(bucketSeconds)} (UTC)`}
          </div>
          <div className="text-[11px] text-gray-500 mt-1">Drag to zoom • double-click to reset</div>
        </div>
        <div className="text-right">
          <div className="text-xs text-gray-400">Latest</div>
          <div className="text-[11px] text-gray-200">
            {latest
              ? `${formatUtcHM(latest.ts)} UTC • p95=${formatMsOrNA(latest.p95TtmsMs)} • p99=${formatMsOrNA(
                  latest.p99TtmsMs
                )}`
              : "n/a"}
          </div>
        </div>
      </div>

      <div className="mt-3 rounded-2xl border border-white/10 bg-black/30 p-3">
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
            setDrag((d) => {
              commitZoom(d.x0, d.x1);
              return { active: false, x0: 0, x1: 0 };
            });
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
          <text x={padLeft + plotW / 2} y={h - 10} fontSize="10" fill="#9ca3af" textAnchor="middle">
            Time (UTC, {bucketLabel(bucketSeconds)} buckets)
          </text>

          {tickVals.map((v, idx) => {
            const t = (v - minV) / span;
            const yy = padTop + (1 - t) * plotH;
            return (
              <g key={idx} opacity={0.35}>
                <line x1={padLeft} y1={yy} x2={padLeft + plotW} y2={yy} stroke="currentColor" />
                <text x={padLeft - 10} y={yy + 3} fontSize="10" fill="#9ca3af" textAnchor="end">
                  {v}
                </text>
              </g>
            );
          })}

          <polyline
            fill="none"
            stroke="rgba(59,130,246,0.92)"
            strokeWidth="2.75"
            strokeLinecap="round"
            strokeLinejoin="round"
            points={p95Pts.join(" ")}
          />
          <polyline
            fill="none"
            stroke="rgba(139,92,246,0.92)"
            strokeWidth="2.75"
            strokeLinecap="round"
            strokeLinejoin="round"
            points={p99Pts.join(" ")}
          />

          {slice.map((p, i) => {
            const show = i % xLabelEvery === 0 || i === slice.length - 1;
            if (!show) return null;
            const xx = x(i);
            const label = timeLabelShort(p.ts, windowMinutes);
            return (
              <text key={`xl-${p.ts}`} x={xx} y={padTop + plotH + 18} fontSize="10" fill="#9ca3af" textAnchor="middle">
                {label}
              </text>
            );
          })}

          {drag.active && selectionW > 2 ? (
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
          ) : null}
        </svg>

        <div className="mt-3 flex items-center justify-center gap-5 text-[11px] text-gray-300">
          <div className="flex items-center gap-1.5">
            <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: "rgba(59,130,246,0.92)" }} />
            <span>p95</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: "rgba(139,92,246,0.92)" }} />
            <span>p99</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function HostSummaryCard({ hosts }: { hosts: HostSeriesItem[] }) {
  const rows = (hosts || []).slice(0, 10);
  if (!rows.length) return null;

  const maxReq = Math.max(1, ...rows.map((r) => Number(r.totalRequests || 0)));

  return (
    <div className="rounded-2xl border border-white/10 bg-white/5 backdrop-blur p-4 shadow-[0_0_0_1px_rgba(255,255,255,0.04)] min-w-0">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-xs text-gray-400">Diagnostic view</div>
          <div className="text-sm font-semibold text-gray-100">Host distribution</div>
          <div className="text-[11px] text-gray-500 mt-1">Top hosts by request volume in the current window</div>
        </div>
        <div className="text-right">
          <div className="text-xs text-gray-400">Hosts</div>
          <div className="text-[11px] text-gray-200">{rows.length}</div>
        </div>
      </div>

      <div className="mt-3 rounded-2xl border border-white/10 bg-black/30 p-3">
        <div className="space-y-3">
          {rows.map((row) => {
            const widthPct = Math.max(4, (Number(row.totalRequests || 0) / maxReq) * 100);
            return (
              <div key={row.host} className="space-y-1.5">
                <div className="flex items-center justify-between gap-3 text-[11px]">
                  <div className="truncate text-gray-200 font-medium">{row.host}</div>
                  <div className="shrink-0 text-gray-400">
                    req={formatIntOrNA(row.totalRequests)} • 5xx={formatPctOrNA(row.errorRatePct)} • crc={formatIntOrNA(row.crcErrorCount)}
                  </div>
                </div>
                <div className="h-2.5 rounded-full bg-white/5 overflow-hidden">
                  <div
                    className="h-full rounded-full"
                    style={{
                      width: `${widthPct}%`,
                      background: stableColorForKey(row.host),
                    }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

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

  function toSvgX(clientX: number) {
    const el = svgRef.current;
    if (!el) return 0;
    const r = el.getBoundingClientRect();
    const rel = (clientX - r.left) / Math.max(1, r.width);
    return rel * w;
  }

  function idxFromSvgX(sx: number) {
    const raw = Math.floor((sx - padLeft) / Math.max(1, barW + gap));
    return clamp(raw, 0, Math.max(0, base.length - 1));
  }

  function commitZoom(x0: number, x1: number) {
    const a = Math.min(x0, x1);
    const b = Math.max(x0, x1);
    const i0 = idxFromSvgX(a);
    const i1 = idxFromSvgX(b);
    if (i1 - i0 >= 2) setZoom({ start: i0, end: i1 });
  }

  const latest = slice[slice.length - 1];
  const selectionX = Math.min(drag.x0, drag.x1);
  const selectionW = Math.abs(drag.x1 - drag.x0);

  return (
    <div className="rounded-2xl border border-white/10 bg-white/5 backdrop-blur p-4 shadow-[0_0_0_1px_rgba(255,255,255,0.04)] min-w-0">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-xs text-gray-400">Diagnostic view</div>
          <div className="text-sm font-semibold text-gray-100">CRC / response classification</div>
          <div className="text-[11px] text-gray-400 mt-1">
            {slice.length
              ? `${formatUtcYmdHm(slice[0].ts)} → ${formatUtcYmdHm(slice[slice.length - 1].ts)} UTC (bucket: ${bucketLabel(
                  bucketSeconds
                )})`
              : `bucket: ${bucketLabel(bucketSeconds)} (UTC)`}
          </div>
          <div className="text-[11px] text-gray-500 mt-1">Drag to zoom • double-click to reset</div>
        </div>
        <div className="text-right">
          <div className="text-xs text-gray-400">Latest</div>
          <div className="text-[11px] text-gray-200">
            {latest ? `${formatUtcHM(latest.ts)} UTC • crc=${formatIntOrNA(latest.crcErrorCount)}` : "n/a"}
          </div>
        </div>
      </div>

      <div className="mt-3 rounded-2xl border border-white/10 bg-black/30 p-3">
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
            setDrag((d) => {
              commitZoom(d.x0, d.x1);
              return { active: false, x0: 0, x1: 0 };
            });
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
          <text x={padLeft + plotW / 2} y={h - 10} fontSize="10" fill="#9ca3af" textAnchor="middle">
            Time (UTC, {bucketLabel(bucketSeconds)} buckets)
          </text>

          {[0, 0.25, 0.5, 0.75, 1].map((t, idx) => {
            const y = padTop + (1 - t) * plotH;
            const v = Math.round(maxVal * t);
            return (
              <g key={idx} opacity={0.35}>
                <line x1={padLeft} y1={y} x2={padLeft + plotW} y2={y} stroke="currentColor" />
                <text x={padLeft - 10} y={y + 3} fontSize="10" fill="#9ca3af" textAnchor="end">
                  {formatCountTick(v)}
                </text>
              </g>
            );
          })}

          {slice.map((p, i) => {
            const x = padLeft + i * (barW + gap);
            const barH = (Number(p.crcErrorCount || 0) / maxVal) * plotH;
            const y = padTop + plotH - barH;
            return (
              <rect
                key={p.ts}
                x={x}
                y={y}
                width={barW}
                height={Math.max(0, barH)}
                rx={2}
                fill="#f59e0b"
                opacity={0.95}
              />
            );
          })}

          {slice.map((p, i) => {
            const show = i % xLabelEvery === 0 || i === slice.length - 1;
            if (!show) return null;
            const x = padLeft + i * (barW + gap) + barW / 2;
            const label = timeLabelShort(p.ts, windowMinutes);
            return (
              <text key={`xl-${p.ts}`} x={x} y={padTop + plotH + 18} fontSize="10" fill="#9ca3af" textAnchor="middle">
                {label}
              </text>
            );
          })}

          {drag.active && selectionW > 2 ? (
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
          ) : null}
        </svg>

        <div className="mt-3 flex items-center justify-center gap-5 text-[11px] text-gray-300">
          <div className="flex items-center gap-1.5">
            <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: "#f59e0b" }} />
            <span>crc errors</span>
          </div>
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------
// Main Home component
// ------------------------------------------------------------
export default function Home() {
  const [mounted, setMounted] = useState(false);

  const [partner, setPartner] = useState<PartnerOrMissing>("partner_01");
  function setPartnerSticky(p: string) {
    const v = String(p || "").trim();
    if (!v) return;
    if ((PARTNER_OPTIONS as readonly string[]).includes(v)) {
      setPartner(v as Partner);
      safeSetLS(PARTNER_KEY, v);
    }
  }

  const [isTriageLoading, setIsTriageLoading] = useState(false);
  const isLoading = isTriageLoading;

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

  function setServiceSticky(s: string) {
    const v = String(s || "").trim();
    if (!v) return;
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
      const expiresAt = Number(parsed?.expiresAt ?? 0);
      const value = parsed?.value ?? null;
      return { expiresAt, value };
    } catch {
      safeDelLS(FILTERS_KEY);
      return null;
    }
  }

  function loadFiltersFromTTL() {
    const env = loadFiltersEnvelope();
    if (!env) return null;
    const expiresAt = Number(env.expiresAt ?? 0);
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
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
    const msg: ChatText = { id, type: "text", role, ts: nowIso(), text };
    setChatMessages((prev) => [...prev, msg]);
    return id;
  }

  function addTriageCard(run: ChatTriage["run"]) {
    setChatMessages((prev) => [
      ...prev,
      { id: `${Date.now()}-${Math.random()}`, type: "triage", role: "assistant", ts: nowIso(), run },
    ]);
  }

  function resetNonStickyFiltersBecauseExpired() {
    safeDelLS(FILTERS_KEY);

    setRegion("all");
    setPop("all");
    setWindowMinutes(120);
    setContentType("all");
    setUaFamily("all");

    setTimeMode("relative");
    setStartTsUtc(null);
    setEndTsUtc(null);

    setDraftService(service || "");
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
    addText("assistant", "TTL expired (10m): reset non-sticky filters. Partner + service were kept.");
  }

  function resetAllFilters() {
    safeDelLS(FILTERS_KEY);
    safeDelLS(PARTNER_KEY);
    safeDelLS(SERVICE_KEY);

    setPartner("partner_01");
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
    pushRunLog("Reset: cleared saved filters + partner + service");
    addText("assistant", "Reset complete: cleared saved filters (10m TTL), partner, and service.");
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
      const env = loadFiltersEnvelope();
      if (!env) return;
      const expiresAt = Number(env.expiresAt ?? 0);
      if (Number.isFinite(expiresAt) && expiresAt > 0 && expiresAt <= Date.now()) {
        resetNonStickyFiltersBecauseExpired();
      }
    };

    tick();
    const id = window.setInterval(tick, 15_000);
    return () => window.clearInterval(id);
  }, [mounted, service]);

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
  }, [mounted, service, region, pop, windowMinutes, contentType, uaFamily, timeMode, startTsUtc, endTsUtc]);

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
          contentTypes: Array.isArray(s.contentTypes) ? s.contentTypes.map(String) : ["all", ...CANON.contentTypes],
          uaFamilies: Array.isArray(s.uaFamilies) ? s.uaFamilies.map(String) : ["all", ...CANON.uaFamilies],
        };

        if (!next.contentTypes.includes("all")) next.contentTypes = ["all", ...next.contentTypes];
        if (!next.uaFamilies.includes("all")) next.uaFamilies = ["all", ...next.uaFamilies];

        setSchemaState(next);
      } catch {}
    })();
  }, [mounted]);

  useEffect(() => {
    if (!mounted) return;
    if (chatMessages.length) return;

    setChatMessages([
      {
        id: "welcome",
        type: "text",
        role: "system",
        ts: nowIso(),
        text:
          "Cachey 🤖 — deterministic triage assistant.\n\n" +
          "Pick a service in Filters, then run triage.\n" +
          "You can also ask about traffic, latency, or errors using the current scope.\n" +
          "UTC absolute time in chat is supported when you provide ISO timestamps like 2026-03-09T21:59:00Z.",
      },
    ]);
  }, [mounted, chatMessages.length]);

  useEffect(() => {
    const last = chatMessages[chatMessages.length - 1];
    if (!last) return;
    if (lastMsgIdRef.current !== last.id) {
      lastMsgIdRef.current = last.id;
      const el = chatScrollRef.current;
      el?.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    }
  }, [chatMessages]);

  const availableRegions: string[] = useMemo(() => {
    const uniq = Array.from(new Set((schemaState.regions || []).map((x) => String(x || "").trim()).filter(Boolean))).sort(
      (a, b) => a.localeCompare(b)
    );
    return ["all", ...uniq];
  }, [schemaState.regions]);

  const availablePops: string[] = useMemo(() => {
    const uniq = Array.from(new Set((schemaState.pops || []).map((x) => String(x || "").trim()).filter(Boolean))).sort(
      (a, b) => a.localeCompare(b)
    );
    return ["all", ...uniq];
  }, [schemaState.pops]);

  const availableContentTypes: string[] = useMemo(() => {
    const uniq = Array.from(new Set((schemaState.contentTypes || []).map((x) => String(x || "").trim()).filter(Boolean))).sort(
      (a, b) => a.localeCompare(b)
    );
    return uniq.includes("all") ? uniq : ["all", ...uniq];
  }, [schemaState.contentTypes]);

  const availableUaFamilies: string[] = useMemo(() => {
    const uniq = Array.from(new Set((schemaState.uaFamilies || []).map((x) => String(x || "").trim()).filter(Boolean))).sort(
      (a, b) => a.localeCompare(b)
    );
    return uniq.includes("all") ? uniq : ["all", ...uniq];
  }, [schemaState.uaFamilies]);

  function parseTimeseries(metricsJson: any): TimeseriesData | null {
    const t = metricsJson?.timeseries;
    if (!t || !Array.isArray(t.points)) return null;

    const points: TimeseriesPoint[] = t.points
      .map((p: any): TimeseriesPoint => ({
        ts: String(p.ts || ""),
        totalRequests: Number(p.totalRequests) || 0,
        error5xxCount: Number(p.error5xxCount) || 0,
        errorRatePct: Number(p.errorRatePct) || 0,
        p95TtmsMs: p.p95TtmsMs == null ? null : Number(p.p95TtmsMs),
        p99TtmsMs: p.p99TtmsMs == null ? null : Number(p.p99TtmsMs),
        cacheHitRate: p.cacheHitRate == null ? null : Number(p.cacheHitRate),
        crcErrorCount: Number(p.crcErrorCount || 0),
        statusCountsByCode: p.statusCountsByCode || undefined,
      }))
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
      statusCodeSeries: Array.isArray(t.statusCodeSeries) ? t.statusCodeSeries.map(String) : undefined,
      hostSeries,
      crcSeries,
    };
  }

  function isAllowed(val: string, allowed: string[]) {
    const v = String(val ?? "").trim();
    if (!v) return false;
    return allowed.includes(v);
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
        return { ok: false as const, error: "Pick start and end time (UTC) using the calendar inputs." };
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

    const allowedCT = availableContentTypes.length ? availableContentTypes : ["all", "manifest", "segment", "api"];
    const allowedUA = availableUaFamilies.length ? availableUaFamilies : ["all", "stb", "mobile", "web", "smart_tv", "console"];

    if (!isAllowed(ct, allowedCT)) return { ok: false as const, error: "Invalid contentType selection." };
    if (!isAllowed(ua, allowedUA)) return { ok: false as const, error: "Invalid uaFamily selection." };

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

  async function runTriage(inputs: TriageInputs): Promise<{
    summaryText: string;
    metricsJson: any;
    sql?: {
      queries: string[];
      params?: Record<string, any>;
    } | null;
    swarm?: any;
  }> {
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

    if (inputs.startTsUtc) formData.append("startTsUtc", inputs.startTsUtc);
    if (inputs.endTsUtc) formData.append("endTsUtc", inputs.endTsUtc);

    const response = await fetch("/api/triage", { method: "POST", body: formData });
    const data = (await response.json().catch(() => null)) as TriageResponse | null;

    if (!response.ok) {
      const msg = data && !data.ok ? (data as any).error : `Triage failed (HTTP ${response.status})`;
      throw new Error(msg);
    }
    if (!data) throw new Error("Triage failed (empty response)");
    if (!data.ok) throw new Error((data as any).error);

    return {
      summaryText: (data as any).summaryText ?? (data as any).summary ?? "",
      metricsJson: (data as any).metricsJson ?? null,
      sql: (data as any).sql ?? null,
      swarm: (data as any).swarm ?? null,
    };
  }

  async function executeTriageRun(
    inputs: TriageInputs,
    scopeSource: "filters" | "chat",
    extra?: {
      chatContext?: ChatTriage["run"]["chatContext"];
    }
  ) {
    if (isLoading) return;

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

      const data = await runTriage(inputs);

      addTriageCard({
        inputs,
        summaryText: data.summaryText || "",
        metricsJson: data.metricsJson || null,
        sql: data.sql || null,
        swarm: data.swarm || null,
        scopeSource,
        chatContext: extra?.chatContext ?? null,
      });
    } catch (e: any) {
      addText("assistant", `Triage failed: ${e?.message || "unknown error"}`);
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
    if (!text || isLoading) return;

    setChatInput("");
    addText("user", text);

    const built = buildChatInputsFromText({
      text,
      partner,
      service,
      region,
      pop,
      windowMinutes,
      contentType,
      uaFamily,
    });

    if (!built.ok) {
      addText("assistant", built.error);
      return;
    }

    await executeTriageRun(built.inputs, "chat", { chatContext: built.chatContext });
  }

  function MetricChips({ metricsJson }: { metricsJson: any }) {
    if (!metricsJson) return null;
    const totalRequests = Number(metricsJson.totalRequests) || 0;
    const p95 = metricsJson.p95TtmsMs == null ? null : Number(metricsJson.p95TtmsMs);
    const p99 = metricsJson.p99TtmsMs == null ? null : Number(metricsJson.p99TtmsMs);
    const err5xx = metricsJson.error5xxCount == null ? null : Number(metricsJson.error5xxCount);
    const errPct = metricsJson.errorRatePct == null ? null : Number(metricsJson.errorRatePct);

    const chips = [
      { k: "requests", v: formatIntOrNA(totalRequests) },
      { k: "p95", v: formatMsOrNA(p95) },
      { k: "p99", v: formatMsOrNA(p99) },
      { k: "5xx", v: err5xx == null ? "n/a" : formatIntOrNA(err5xx) },
      { k: "5xx%", v: formatPctOrNA(errPct) },
    ];

    return (
      <div className="flex flex-wrap gap-2">
        {chips.map((c) => (
          <span key={c.k} className="text-xs px-2.5 py-1 rounded-full border border-white/10 bg-white/10 text-gray-200">
            <span className="text-gray-400 mr-1">{c.k}</span>
            <span className="font-semibold">{c.v}</span>
          </span>
        ))}
      </div>
    );
  }

  function buildSummaryFallback(run: ChatTriage["run"]) {
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
    const p95ms = p95 == null ? null : Number(p95);
    const errp = errPct == null ? null : Number(errPct);
    if ((errp != null && errp >= 1.0) || (p95ms != null && p95ms >= 1500)) health = "RED";
    else if ((errp != null && errp >= 0.2) || (p95ms != null && p95ms >= 500)) health = "AMBER";

    const scope = `Scope: ${run.inputs.partner || "—"} / ${run.inputs.service} / region=${run.inputs.region} / pop=${run.inputs.pop} / win=${run.inputs.windowMinutes}m / ct=${run.inputs.contentType} / ua=${run.inputs.uaFamily}`;
    const traffic = `Traffic: ${formatIntOrNA(totalRequests)} requests`;
    const latency = `Latency: p95=${formatMsOrNA(p95)} • p99=${formatMsOrNA(p99)}`;
    const errors = `Errors: 5xx=${err5xx == null ? "n/a" : formatIntOrNA(err5xx)} • 5xx%=${formatPctOrNA(errPct)}`;
    const h = `Health: ${health}`;

    return [scope, traffic, latency, errors, h].join("\n");
  }

  function TriageCard({ run }: { run: ChatTriage["run"] }) {
    const ts = parseTimeseries(run.metricsJson);
    const effectiveWindowMinutes = windowMinutesFromRange(
      run.inputs.startTsUtc,
      run.inputs.endTsUtc,
      run.inputs.windowMinutes
    );
    const bucketSeconds = ts?.bucketSeconds ?? run.metricsJson?.timeseries?.bucketSeconds ?? null;
     
    const swarmSummary = String(run.swarm?.assessment?.summary || "").trim();
    const classicSummary = String(run.summaryText || "").trim();
    const summaryText = swarmSummary || classicSummary || buildSummaryFallback(run);

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

    const answerSource = forcedLocal ? "Forced Local" : proxyEnabled ? "Proxy enabled" : "Local";
    const debugOn = process.env.NODE_ENV !== "production";

    return (
      <div className="triage-enter rounded-2xl border border-white/10 bg-white/5 backdrop-blur p-4 shadow-[0_0_0_1px_rgba(255,255,255,0.04)] space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-xs text-gray-400">Triage result</div>
            <div className="text-sm font-semibold text-gray-100 truncate">
              {run.inputs.partner} • {run.inputs.service} • {run.inputs.region} • {run.inputs.pop} •{" "}
              {run.inputs.startTsUtc && run.inputs.endTsUtc
                ? `${isoToUtcText(run.inputs.startTsUtc)} → ${isoToUtcText(run.inputs.endTsUtc)} UTC`
                : `last ${run.inputs.windowMinutes}m`}{" "}
              • {run.inputs.contentType} • {run.inputs.uaFamily}
            </div>
            {ts?.startTs && ts?.endTs ? (
              <div className="text-[11px] text-gray-500 mt-1">
                actual window: {formatUtcYmdHm(ts.startTs)} → {formatUtcYmdHm(ts.endTs)} UTC
              </div>
            ) : null}
          </div>

          <div className="flex flex-col items-end gap-1 text-[11px]">
            <div className="flex flex-wrap justify-end gap-1.5">
              <span className="px-2 py-1 rounded-full border border-white/10 bg-white/5 text-gray-200">
                <span className="text-gray-400 mr-1">scope</span>
                <span className="font-semibold">{scopeSource}</span>
              </span>

              <span
                className={`px-2 py-1 rounded-full border ${
                  forcedLocal
                    ? "border-amber-400/30 bg-amber-400/10 text-amber-200"
                    : proxyEnabled
                    ? "border-emerald-400/30 bg-emerald-400/10 text-emerald-200"
                    : "border-white/10 bg-white/5 text-gray-200"
                }`}
              >
                <span className="text-gray-400 mr-1">source</span>
                <span className="font-semibold">{answerSource}</span>
              </span>

              <span className="px-2 py-1 rounded-full border border-white/10 bg-white/5 text-gray-200">
                <span className="text-gray-400 mr-1">runner</span>
                <span className="font-semibold">{runnerVersion}</span>
              </span>

              <span className="px-2 py-1 rounded-full border border-white/10 bg-white/5 text-gray-200">
                <span className="text-gray-400 mr-1">table</span>
                <span className="font-semibold">{tableUsed}</span>
              </span>

              <span className="px-2 py-1 rounded-full border border-white/10 bg-white/5 text-gray-200">
                <span className="text-gray-400 mr-1">bucket</span>
                <span className="font-semibold">{debugBucketSeconds != null ? `${debugBucketSeconds}s` : "n/a"}</span>
              </span>

              <span className="px-2 py-1 rounded-full border border-white/10 bg-white/5 text-gray-200">
                <span className="text-gray-400 mr-1">anchor</span>
                <span className="font-semibold">{anchorMode}</span>
              </span>

              <span
                className={`px-2 py-1 rounded-full border ${
                  debugOn ? "border-sky-400/30 bg-sky-400/10 text-sky-200" : "border-white/10 bg-white/5 text-gray-200"
                }`}
              >
                <span className="text-gray-400 mr-1">debug</span>
                <span className="font-semibold">{debugOn ? "on" : "off"}</span>
              </span>
            </div>
          </div>
        </div>

        <MetricChips metricsJson={run.metricsJson} />

        {run.swarm?.assessment ? (
          <div className="flex flex-wrap gap-2">
            <span className="text-xs px-2.5 py-1 rounded-full border border-white/10 bg-white/10 text-gray-200">
              <span className="text-gray-400 mr-1">overall</span>
              <span className="font-semibold">{run.swarm.assessment.overallStatus || "n/a"}</span>
            </span>
            <span className="text-xs px-2.5 py-1 rounded-full border border-white/10 bg-white/10 text-gray-200">
              <span className="text-gray-400 mr-1">primary</span>
              <span className="font-semibold">{run.swarm.assessment.primarySignal || "n/a"}</span>
            </span>
          </div>
        ) : null}

        <div className="rounded-xl border border-white/10 bg-black/30 p-3">
          <div className="text-xs text-gray-400 mb-2">Summary</div>
          <pre className="whitespace-pre-wrap text-sm text-gray-100/90 leading-relaxed">{summaryText}</pre>
        </div>

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

              <div className="rounded-2xl border border-white/10 bg-white/5 backdrop-blur p-4 shadow-[0_0_0_1px_rgba(255,255,255,0.04)]">
                <div className="text-xs text-gray-400">Deterministic evidence</div>
                <div className="text-sm font-semibold text-gray-100 mt-1">Run details</div>

                <div className="mt-3 text-xs text-gray-300 space-y-2">
                  <div>
                    <span className="text-gray-400">Points:</span>{" "}
                    <span className="font-semibold">{pointsCount}</span>
                  </div>
                  <div>
                    <span className="text-gray-400">Hosts:</span>{" "}
                    <span className="font-semibold">{ts.hostSeries?.length || 0}</span>
                  </div>
                  <div>
                    <span className="text-gray-400">CRC buckets:</span>{" "}
                    <span className="font-semibold">{ts.crcSeries?.length || 0}</span>
                  </div>
                  <div>
                    <span className="text-gray-400">Actual window:</span>{" "}
                    <span className="font-semibold">
                      {ts.startTs && ts.endTs
                        ? `${formatUtcYmdHm(ts.startTs)} → ${formatUtcYmdHm(ts.endTs)} UTC`
                        : "n/a"}
                    </span>
                  </div>
                  <div>
                    <span className="text-gray-400">Bucket:</span>{" "}
                    <span className="font-semibold">{bucketLabel(bucketSeconds)}</span>
                  </div>
                  <div>
                    <span className="text-gray-400">SQL queries:</span>{" "}
                    <span className="font-semibold">{run.sql?.queries?.length || 0}</span>
                  </div>
                </div>

                <details className="mt-4 rounded-xl border border-white/10 bg-black/20 p-3">
                  <summary className="cursor-pointer text-sm text-gray-200">Inputs</summary>
                  <div className="mt-3">
                    <pre className="whitespace-pre-wrap text-xs text-gray-200/90 rounded-xl border border-white/10 bg-black/30 p-3 overflow-x-auto">
                      {JSON.stringify(run.inputs, null, 2)}
                    </pre>
                  </div>
                </details>

                {run.chatContext ? (
                  <details className="mt-4 rounded-xl border border-white/10 bg-black/20 p-3">
                    <summary className="cursor-pointer text-sm text-gray-200">Chat parse context</summary>
                    <div className="mt-3">
                      <pre className="whitespace-pre-wrap text-xs text-gray-200/90 rounded-xl border border-white/10 bg-black/30 p-3 overflow-x-auto">
                        {JSON.stringify(run.chatContext, null, 2)}
                      </pre>
                    </div>
                  </details>
                ) : null}

                {run.sql?.queries?.length ? (
                  <details className="mt-4 rounded-xl border border-white/10 bg-black/20 p-3">
                    <summary className="cursor-pointer text-sm text-gray-200">SQL Evidence</summary>
                    <div className="mt-3 space-y-3">
                      {run.sql.queries.map((query, idx) => (
                        <div key={idx}>
                          <div className="text-xs text-gray-400 mb-1">Query {idx + 1}</div>
                          <pre className="whitespace-pre-wrap text-xs text-gray-200/90 rounded-xl border border-white/10 bg-black/30 p-3 overflow-x-auto">
                            {query}
                          </pre>
                        </div>
                      ))}

                      {run.sql.params ? (
                        <div>
                          <div className="text-xs text-gray-400 mb-1">Params</div>
                          <pre className="whitespace-pre-wrap text-xs text-gray-200/90 rounded-xl border border-white/10 bg-black/30 p-3 overflow-x-auto">
                            {JSON.stringify(run.sql.params, null, 2)}
                          </pre>
                        </div>
                      ) : null}
                    </div>
                  </details>
                ) : null}
              </div>
            </div>
          </div>
        ) : (
          <div className="text-sm text-gray-400">Timeseries: 0 points (aggregate-only).</div>
        )}

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

  const scopeSummary = useMemo(() => {
    const timeText =
      timeMode === "absolute" && startTsUtc && endTsUtc
        ? `${isoToUtcText(startTsUtc)} → ${isoToUtcText(endTsUtc)} UTC`
        : `last ${windowMinutes}m`;
    return `Investigating: ${partner || "—"} • ${service || "service not set"} • ${region || "all regions"} • ${timeText}`;
  }, [partner, service, region, timeMode, startTsUtc, endTsUtc, windowMinutes]);

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
              <div className="text-xs text-gray-400">Deterministic triage assistant • ClickHouse path</div>
            </div>

            <div className="ml-auto flex items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  setFiltersOpen((v) => {
                    const next = !v;
                    if (next) {
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
                    return next;
                  });
                }}
                className={`rounded-full border border-white/10 px-4 py-2 text-sm text-gray-100 hover:bg-white/15 ${
                  filtersOpen ? "bg-white/15" : "bg-white/10"
                }`}
              >
                Filters{filtersDirty ? <span className="ml-2 text-[11px] text-amber-300">(draft)</span> : null}
              </button>

              <button
                type="button"
                onClick={handleRunFromFilters}
                disabled={isLoading || !partner || !service}
                className="rounded-xl px-4 py-2 text-sm font-semibold bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isTriageLoading ? "Running..." : "Run"}
              </button>

              <a
                href="/debug"
                className="rounded-full border border-white/10 bg-white/10 px-4 py-2 text-sm text-gray-100 hover:bg-white/15"
              >
                Debug
              </a>
            </div>
          </div>

          <div className="mt-3 text-sm text-gray-300">{scopeSummary}</div>

          {filtersOpen ? (
            <div className="mt-4 rounded-2xl border border-white/10 bg-white/5 p-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-sm font-semibold text-white">Advanced Scope Controls</div>
                  <div className="text-xs text-gray-400 mt-1">
                    Apply updates the active scope. Run uses the applied scope.
                    <span className="ml-2 text-gray-500">(TTL: 10m; service persists)</span>
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
                    Reset (clear saved)
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

              <div className="mt-4 grid grid-cols-1 md:grid-cols-7 gap-3">
                <div className="min-w-0">
                  <div className="text-xs text-gray-400 mb-1">Partner</div>
                  <select
                    className="w-full rounded-lg border border-white/10 bg-white/10 text-gray-100 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500/40"
                    value={partner}
                    onChange={(e) => setPartnerSticky(e.target.value)}
                    disabled={!mounted}
                  >
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

                <div className="min-w-0 md:col-span-2">
                  <div className="text-xs text-gray-400 mb-1">Time (UTC)</div>

                  <div className="flex items-center gap-2 mb-2">
                    <button
                      type="button"
                      onClick={() => {
                        setDraftTimeMode("relative");
                        setFiltersDirty(true);
                      }}
                      className={`px-3 py-1.5 rounded-full border text-xs ${
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
                      className={`px-3 py-1.5 rounded-full border text-xs ${
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
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
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

                      <div className="sm:col-span-2 flex flex-wrap gap-2 mt-1">
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
                            const now = new Date();
                            setDraftEndUtcLocal(isoToDatetimeLocalUtc(now.toISOString()));
                            setFiltersDirty(true);
                          }}
                          className="rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs hover:bg-white/10"
                        >
                          Set End=Now
                        </button>
                      </div>
                    </div>
                  )}
                </div>

                <div className="min-w-0">
                  <div className="text-xs text-gray-400 mb-1">ContentType</div>
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
              </div>

              <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
                <div className="text-xs text-gray-400">Apply updates the active scope. Run executes triage with the active scope.</div>

                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      const res = applyDraftFilters();
                      if (!res.ok) addText("assistant", res.error);
                    }}
                    className="rounded-xl px-4 py-2 text-sm font-semibold bg-white/10 hover:bg-white/15 border border-white/10"
                  >
                    Apply
                  </button>

                  <button
                    type="button"
                    onClick={async () => {
                      const res = applyDraftFilters();
                      if (!res.ok) {
                        addText("assistant", res.error);
                        return;
                      }
                      await handleRunFromFilters();
                    }}
                    disabled={isLoading}
                    className="rounded-xl px-4 py-2 text-sm font-semibold bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    Apply & Run
                  </button>
                </div>
              </div>
            </div>
          ) : null}
        </div>
      </div>

      <div className="mx-auto max-w-6xl px-6 py-6">
        <div className="rounded-3xl border border-white/10 bg-white/5 backdrop-blur p-4 shadow-[0_0_0_1px_rgba(255,255,255,0.04)]">
          <div
            ref={chatScrollRef}
            className="h-[66vh] min-h-[520px] overflow-y-auto rounded-2xl border border-white/10 bg-black/30 p-4"
          >
            <div className="space-y-4">
              {chatMessages.map((m) => {
                const isUser = m.role === "user";
                const isSystem = m.role === "system";

                const bubbleMax = isUser ? "max-w-[70%]" : "max-w-[82%]";
                const rowAlign = isSystem ? "justify-center" : isUser ? "justify-end" : "justify-start";

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
                          <pre className="whitespace-pre-wrap text-sm leading-relaxed">{m.text}</pre>
                        </div>
                      ) : (
                        <TriageCard run={m.run} />
                      )}
                    </div>
                  </div>
                );
              })}

              {typing ? (
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
              ) : null}
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
              placeholder="Ask about traffic, latency, errors, or incidents…"
              className="flex-1 rounded-2xl border border-white/10 bg-white/10 px-4 py-3 text-sm text-white placeholder-gray-400 outline-none focus:ring-2 focus:ring-blue-500/40"
              disabled={isLoading}
            />
            <button
              onClick={handleSend}
              disabled={isLoading || !chatInput.trim()}
              className="rounded-2xl px-5 py-3 text-sm font-semibold bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isLoading ? "Running..." : "Send"}
            </button>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => {
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
              }}
              className="rounded-full border border-white/10 bg-white/5 px-3 py-2 text-xs text-gray-200 hover:bg-white/10"
            >
              Open Filters
            </button>

            <button
              type="button"
              onClick={handleRunFromFilters}
              disabled={isLoading || !partner || !service}
              className="rounded-full border border-white/10 bg-white/5 px-3 py-2 text-xs text-gray-200 hover:bg-white/10 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Run Triage
            </button>

            {!service ? (
              <span className="text-xs text-gray-500">Pick a service in Filters, then run triage.</span>
            ) : (
              <span className="text-xs text-gray-500">{scopeSummary}</span>
            )}
          </div>

          <details
            className="mt-6 rounded-2xl border border-white/10 bg-black/30 p-4"
            open={debugOpen}
            onToggle={(e) => setDebugOpen((e.target as HTMLDetailsElement).open)}
          >
            <summary className="cursor-pointer text-sm font-semibold text-gray-200">Debug</summary>
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
        </div>
      </div>
    </main>
  );
}
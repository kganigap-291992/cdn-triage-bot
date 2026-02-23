// app/debug/page.tsx
"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";

// ------------------------------------------------------------
// Debug UI = ClickHouse-first (no CSV)
// ------------------------------------------------------------
const STORAGE_KEY = "cdn-triage-history-v1";
const CHAT_MODE_KEY = "cdn-triage-chatmode-v1";
const PARTNER_KEY = "cdn-triage-partner-v1";

const MAX_HISTORY = 10;
const LOGO_SRC = "/cachey-logo.png";

// ------------------------------------------------------------
// localStorage helpers
// ------------------------------------------------------------
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
function safeRemoveLS(key: string) {
  try {
    localStorage.removeItem(key);
  } catch {}
}

// ------------------------------------------------------------
// Canonical allowed values (from generator contract)
// ------------------------------------------------------------
const ALLOWED = {
  service: new Set(["all", "live", "vod", "dvr", "eas", "live_ott", "app_backend"]),
  contentType: new Set(["all", "manifest", "segment", "api"]),
  uaFamily: new Set(["all", "stb", "mobile", "web", "smart_tv", "console"]),
} as const;

function optionsFromSet(set: Set<string>) {
  const arr = Array.from(set);
  return arr.sort((a, b) => (a === "all" ? -1 : b === "all" ? 1 : a.localeCompare(b)));
}

const SERVICE_OPTIONS = optionsFromSet(ALLOWED.service);
const CONTENT_TYPE_OPTIONS = optionsFromSet(ALLOWED.contentType);
const UA_FAMILY_OPTIONS = optionsFromSet(ALLOWED.uaFamily);

// Public-safe mock partners (real mapping later)
const PARTNER_OPTIONS = [
  "acme_media",
  "beta_stream",
  "charlie_video",
  "delta_tv",
  "echo_entertainment",
] as const;

// ------------------------------------------------------------
// Types
// ------------------------------------------------------------
type DataSource = "clickhouse";
type Partner = (typeof PARTNER_OPTIONS)[number];
type PartnerOrMissing = Partner | "";
type ChatMode = "deterministic" | "llm";

type ChatTextMessage = {
  id: string;
  type: "text";
  role: "system" | "user" | "assistant";
  text: string;
  timestamp: string; // ISO
};

type ChatTriageMessage = {
  id: string;
  type: "triage_result";
  role: "assistant";
  timestamp: string; // ISO
  run: {
    inputs: {
      dataSource: DataSource;
      partner: PartnerOrMissing;
      service: string;
      region: string;
      pop: string;
      contentType: string;
      uaFamily: string;
      windowMinutes: number;
      debug: boolean;
    };
    summaryText: string;
    metricsJson: any;
    sql?: any;
  };
};

type ChatMessage = ChatTextMessage | ChatTriageMessage;

type TriageInputs = {
  dataSource: DataSource;
  partner: PartnerOrMissing;
  service: string;
  region: string;
  pop: string;
  contentType: string;
  uaFamily: string;
  windowMinutes: number;
  debug: boolean;
};

type TriageRun = {
  id: string;
  timestamp: string;
  inputs: TriageInputs;
  summaryText: string;
  metricsJson: any;
  sql?: any;
};

type MetricsData = {
  totalRequests: number;
  p95TtmsMs: number | null;
  p99TtmsMs: number | null;
  error5xxCount: number | null;
  errorRatePct: number | null;
};

type TimeseriesPoint = {
  ts: string;
  totalRequests: number;
  error5xxCount: number;
  errorRatePct: number;
  p95TtmsMs: number | null;
  p99TtmsMs: number | null;

  // stacked
  statusCountsByCode?: Record<string, number>;
  hostCountsByHost?: Record<string, number>;
  crcCountsByCrc?: Record<string, number>;
};

type TimeseriesData = {
  bucketSeconds: number | null;
  startTs: string | null;
  endTs: string | null;
  points: TimeseriesPoint[];

  statusCodeSeries?: string[];
  hostSeries?: string[];
  crcSeries?: string[];
};

// ------------------------------------------------------------
// Utility
// ------------------------------------------------------------
function getCurrentTimestamp(): string {
  return new Date().toISOString();
}

function safeParse<T>(json: string, fallback: T): T {
  try {
    return JSON.parse(json);
  } catch {
    return fallback;
  }
}

function normalizeText(text: string): string {
  return (text || "").trim().toLowerCase();
}

function isGreetingOrSmallTalk(text: string): boolean {
  const t = normalizeText(text);
  if (!t) return true;
  if (t.length <= 3) return ["hi", "hey", "yo", "ok", "k"].includes(t);
  if (t.includes("what can you do") || t.includes("help")) return false;

  const greetingPatterns = [
    /^hi\b/,
    /^hey\b/,
    /^hello\b/,
    /^yo\b/,
    /^sup\b/,
    /^what'?s up\b/,
    /^good (morning|afternoon|evening)\b/,
    /^how are you\b/,
    /^how's it going\b/,
    /^how r u\b/,
    /^thanks\b/,
    /^thank you\b/,
  ];
  return greetingPatterns.some((pattern) => pattern.test(t));
}

function looksLikeTriageQuery(text: string): boolean {
  const normalized = normalizeText(text);
  if (!normalized) return false;
  if (normalized.includes("=")) return true;

  const keywords = [
    "service",
    "region",
    "pop",
    "content",
    "content_type",
    "ua",
    "ua_family",
    "win",
    "window",
    "errors",
    "p95",
    "p99",
    "ttms",
    "triage",
    "run",
    "vod",
    "live",
    "last",
    "past",
    "manifest",
    "segment",
    "api",
    "stb",
    "smart_tv",
    "mobile",
    "web",
    "console",
  ];
  return keywords.some((keyword) => normalized.includes(keyword));
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

function formatTimestampClientSafe(iso: string, mounted: boolean): string {
  if (!iso) return "";
  if (!mounted) return iso.replace("T", " ").replace(".000Z", "Z");
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function bucketLabel(bucketSeconds: number | null | undefined) {
  const s = Number(bucketSeconds || 0);
  if (!Number.isFinite(s) || s <= 0) return "bucket";
  if (s % 3600 === 0) return `${s / 3600}h`;
  if (s % 60 === 0) return `${s / 60}m`;
  return `${s}s`;
}

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

// ---- UTC + axis formatting (charts) ----
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

function formatCountTick(v: number): string {
  const n = Number(v);
  if (!Number.isFinite(n)) return "";
  const abs = Math.abs(n);
  if (abs >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return Math.round(n).toString();
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

// ------------------------------------------------------------
// Chat "AI-smart" helpers (Deterministic)
// ------------------------------------------------------------
type ChatIntent = {
  command: "help" | "reset" | "show_filters" | "explain" | "run" | null;
  partner?: string | null;
  service?: string | null;
  region?: string | null;
  pop?: string | null;
  contentType?: string | null;
  uaFamily?: string | null;
  windowMinutes?: number | null;
  mentionedRegion?: boolean;
  mentionedPop?: boolean;
};

function normalizeToken(v: string) {
  return String(v || "")
    .trim()
    .toLowerCase()
    .replace(/^["']|["']$/g, "");
}

function parseWindowToMinutes(raw: string): number | null {
  const s = normalizeToken(raw);
  if (!s) return null;
  const m = s.match(/^(\d+)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours)?$/);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = m[2] || "m";
  if (unit.startsWith("h")) return n * 60;
  return n;
}

function parseChatIntent(text: string): ChatIntent {
  const t = normalizeText(text);

  if (t === "help" || t === "?" || t.startsWith("help ") || t.includes("what can you do"))
    return { command: "help" };

  if (t === "reset" || t === "clear" || t === "start over" || t === "wipe")
    return { command: "reset" };

  if (t === "filters" || t === "show filters" || t === "show filter" || t === "current filters")
    return { command: "show_filters" };

  if (t === "explain" || t.startsWith("explain ") || t.includes("what is this"))
    return { command: "explain" };

  if (t === "run" || t === "triage" || t === "go" || t === "execute")
    return { command: "run" };

  // partner
  const partnerKV = t.match(/\bpartner\s*=\s*([a-z0-9_\-]+)\b/);
  const partnerWord = t.match(/\bpartner\s+([a-z0-9_\-]+)\b/);
  const partner = partnerKV?.[1] || partnerWord?.[1] || null;

  // service
  const serviceKV = t.match(/\b(service|svc)\s*=\s*([a-z0-9_]+)\b/);
  const serviceWord = t.match(/\b(service|svc)\s+([a-z0-9_]+)\b/);
  let service = serviceKV?.[2] || serviceWord?.[2] || null;
  if (!service) {
    const svcLoose = t.match(/\b(vod|live|all|dvr|eas|live_ott|app_backend)\b/);
    service = svcLoose?.[1] || null;
  }

  // region/pop
  const regionKV = t.match(/\bregion\s*=\s*([a-z0-9_\-]+)\b/);
  const regionWord = t.match(/\bregion\s+([a-z0-9_\-]+)\b/);
  const regionIn = t.match(/\bin\s+([a-z0-9_\-]+)\b/);
  const region = regionKV?.[1] || regionWord?.[1] || regionIn?.[1] || null;

  const popKV = t.match(/\bpop\s*=\s*([a-z0-9_\-]+)\b/);
  const popWord = t.match(/\bpop\s+([a-z0-9_\-]+)\b/);
  const popAt = t.match(/\bat\s+([a-z0-9_\-]+)\b/);
  const pop = popKV?.[1] || popWord?.[1] || popAt?.[1] || null;

  // contentType
  const ctKV = t.match(/\b(content_type|contenttype|content)\s*=\s*([a-z0-9_]+)\b/);
  const ctWord = t.match(/\b(content_type|contenttype|content)\s+([a-z0-9_]+)\b/);
  let contentType = ctKV?.[2] || ctWord?.[2] || null;
  if (!contentType) {
    const loose = t.match(/\b(manifest|segment|api)\b/);
    contentType = loose?.[1] || null;
  }

  // uaFamily
  const uaKV = t.match(/\b(ua_family|uafamily|ua)\s*=\s*([a-z0-9_]+)\b/);
  const uaWord = t.match(/\b(ua_family|uafamily|ua)\s+([a-z0-9_]+)\b/);
  let uaFamily = uaKV?.[2] || uaWord?.[2] || null;
  if (!uaFamily) {
    const loose = t.match(/\b(stb|mobile|web|smart_tv|console)\b/);
    uaFamily = loose?.[1] || null;
  }

  // window
  const winKV = t.match(/\b(win|window)\s*=\s*([0-9a-z]+)\b/);
  const winWord = t.match(/\b(win|window)\s+([0-9a-z]+)\b/);
  const lastWord = t.match(/\blast\s+([0-9a-z]+)\b/);
  const windowMinutes =
    parseWindowToMinutes(winKV?.[2] || winWord?.[2] || lastWord?.[1] || "") ?? null;

  const mentionedRegion = /\bregion\b|\bin\b/.test(t);
  const mentionedPop = /\bpop\b|\bat\b/.test(t);

  return {
    command: null,
    partner: partner ? normalizeToken(partner) : null,
    service: service ? normalizeToken(service) : null,
    region: region ? normalizeToken(region) : null,
    pop: pop ? normalizeToken(pop) : null,
    contentType: contentType ? normalizeToken(contentType) : null,
    uaFamily: uaFamily ? normalizeToken(uaFamily) : null,
    windowMinutes,
    mentionedRegion,
    mentionedPop,
  };
}

function buildFiltersSummary(args: {
  dataSource: DataSource;
  partner: PartnerOrMissing;
  service: string;
  region: string;
  pop: string;
  contentType: string;
  uaFamily: string;
  windowMinutes: number;
}) {
  const { partner, service, region, pop, contentType, uaFamily, windowMinutes } = args;
  return `source=clickhouse, partner=${partner || "(missing)"}, svc=${service}, region=${region}, pop=${pop}, content=${contentType}, ua=${uaFamily}, win=${windowMinutes}m`;
}

// ------------------------------------------------------------
// Generic stacked bar chart (status / host / crc) with drag-to-zoom
// ------------------------------------------------------------
function StackedBarTimeseries({
  title,
  subtitle,
  ts,
  bucketSeconds,
  seriesKeys,
  getMap,
  height = 180,
  windowMinutes,
}: {
  title: string;
  subtitle: string;
  ts: TimeseriesData;
  bucketSeconds: number | null;
  seriesKeys: string[];
  getMap: (p: TimeseriesPoint) => Record<string, number> | undefined;
  height?: number;
  windowMinutes: number;
}) {
  const maxBars = windowMinutes <= 180 ? 60 : windowMinutes <= 1440 ? 144 : 180;
  const basePoints = (ts.points || []).slice(-maxBars);
  const [zoom, setZoom] = useState<{ start: number; end: number } | null>(null);

  const points = zoom && zoom.end > zoom.start ? basePoints.slice(zoom.start, zoom.end + 1) : basePoints;

  const svgRef = useRef<SVGSVGElement | null>(null);
  const [drag, setDrag] = useState<{ active: boolean; x0: number; x1: number }>({ active: false, x0: 0, x1: 0 });

  if (!points.length) return null;

  const present = new Map<string, number>();
  for (const p of points) {
    const m = getMap(p) || {};
    for (const k of Object.keys(m)) {
      present.set(k, (present.get(k) ?? 0) + Number((m as any)[k] ?? 0));
    }
  }
  const presentKeys = Array.from(present.entries())
    .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))
    .map(([k]) => k);

  const ordered = [...seriesKeys.filter((k) => present.has(k)), ...presentKeys.filter((k) => !seriesKeys.includes(k))];
  const keys = ordered.slice(0, 10);
  if (!keys.length) return null;

  const totals = points.map((p) => {
    const m = getMap(p) || {};
    let sum = 0;
    for (const k of keys) sum += Number((m as any)[k] ?? 0);
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
  const gap = clamp(Math.round(plotW / (barCount * 10)), 2, 6);
  const barW = Math.max(4, Math.floor((plotW - gap * (barCount - 1)) / barCount));

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
    <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm min-w-0">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-xs text-gray-500">{subtitle}</div>
          <div className="text-sm font-semibold text-gray-900">{title}</div>
          <div className="text-[11px] text-gray-500 mt-1">
            {ts.startTs && ts.endTs
              ? `${formatUtcYmdHm(ts.startTs)} → ${formatUtcYmdHm(ts.endTs)} UTC (bucket: ${bucketLabel(bucketSeconds)})`
              : `bucket: ${bucketLabel(bucketSeconds)} (UTC)`}
          </div>
          <div className="text-[11px] text-gray-400 mt-1">
            Drag to zoom • double-click to reset
            {zoom ? (
              <button type="button" className="ml-2 underline hover:text-gray-600" onClick={() => setZoom(null)}>
                reset zoom
              </button>
            ) : null}
          </div>
        </div>

        <div className="text-right">
          <div className="text-xs text-gray-500">Latest</div>
          <div className="text-[11px] text-gray-700">
            {latest ? `${formatUtcHM(latest.ts)} UTC • ${latestTotal.toLocaleString()} events` : "n/a"}
          </div>
        </div>
      </div>

      <div className="mt-3 rounded-xl border border-gray-100 bg-gray-50/60 p-3">
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
            fill="#6b7280"
            transform={`rotate(-90 ${padLeft - 38} ${padTop + plotH / 2})`}
          >
            Events
          </text>
          <text x={padLeft + plotW / 2} y={h - 10} fontSize="10" fill="#6b7280" textAnchor="middle">
            Time (UTC, {bucketLabel(bucketSeconds)} buckets)
          </text>

          {tickVals.map((v, idx) => {
            const t = v / maxTotal;
            const y = padTop + (1 - t) * plotH;
            return (
              <g key={idx} opacity={0.35}>
                <line x1={padLeft} y1={y} x2={padLeft + plotW} y2={y} stroke="currentColor" />
                <text x={padLeft - 10} y={y + 3} fontSize="10" fill="#6b7280" textAnchor="end" opacity={0.95}>
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
                  const val = Number((m as any)[k] ?? 0);
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
                      fill={stableColorForKey(k)}
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
              <text key={`xl-${p.ts}`} x={x} y={padTop + plotH + 18} fontSize="10" fill="#6b7280" textAnchor="middle">
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

        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-[11px] text-gray-600">
          {keys.map((k) => (
            <div key={k} className="flex items-center gap-1.5">
              <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: stableColorForKey(k) }} />
              <span className="truncate max-w-[220px]">{k}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------
// Latency line chart with drag-to-zoom + real ticks
// ------------------------------------------------------------
function LatencyTimeseriesLines({
  points,
  bucketSeconds,
  height = 180,
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
  const [drag, setDrag] = useState<{ active: boolean; x0: number; x1: number }>({ active: false, x0: 0, x1: 0 });

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
    <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm min-w-0">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-xs text-gray-500">Latency timeseries</div>
          <div className="text-sm font-semibold text-gray-900">p95 / p99 TTMS</div>
          <div className="text-[11px] text-gray-500 mt-1">
            {slice.length
              ? `${formatUtcYmdHm(slice[0].ts)} → ${formatUtcYmdHm(slice[slice.length - 1].ts)} UTC (bucket: ${bucketLabel(
                  bucketSeconds
                )})`
              : `bucket: ${bucketLabel(bucketSeconds)} (UTC)`}
          </div>
          <div className="text-[11px] text-gray-400 mt-1">
            Drag to zoom • double-click to reset
            {zoom ? (
              <button type="button" className="ml-2 underline hover:text-gray-600" onClick={() => setZoom(null)}>
                reset zoom
              </button>
            ) : null}
          </div>
        </div>
        <div className="text-right">
          <div className="text-xs text-gray-500">Latest</div>
          <div className="text-[11px] text-gray-700">
            {latest
              ? `${formatUtcHM(latest.ts)} UTC • p95=${formatMsOrNA(latest.p95TtmsMs)} • p99=${formatMsOrNA(latest.p99TtmsMs)}`
              : "n/a"}
          </div>
        </div>
      </div>

      <div className="mt-3 rounded-xl border border-gray-100 bg-gray-50/60 p-3">
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
            fill="#6b7280"
            transform={`rotate(-90 ${padLeft - 38} ${padTop + plotH / 2})`}
          >
            Latency (ms)
          </text>
          <text x={padLeft + plotW / 2} y={h - 10} fontSize="10" fill="#6b7280" textAnchor="middle">
            Time (UTC, {bucketLabel(bucketSeconds)} buckets)
          </text>

          {tickVals.map((v, idx) => {
            const t = (v - minV) / span;
            const yy = padTop + (1 - t) * plotH;
            return (
              <g key={idx} opacity={0.35}>
                <line x1={padLeft} y1={yy} x2={padLeft + plotW} y2={yy} stroke="currentColor" />
                <text x={padLeft - 10} y={yy + 3} fontSize="10" fill="#6b7280" textAnchor="end" opacity={0.95}>
                  {v}
                </text>
              </g>
            );
          })}

          <polyline
            fill="none"
            stroke="rgba(37,99,235,0.92)"
            strokeWidth="2.75"
            strokeLinecap="round"
            strokeLinejoin="round"
            points={p95Pts.join(" ")}
          />
          <polyline
            fill="none"
            stroke="rgba(17,24,39,0.45)"
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
              <text key={`xl-${p.ts}`} x={xx} y={padTop + plotH + 18} fontSize="10" fill="#6b7280" textAnchor="middle">
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

        <div className="mt-3 flex items-center justify-center gap-5 text-[11px] text-gray-600">
          <div className="flex items-center gap-1.5">
            <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: "rgba(37,99,235,0.92)" }} />
            <span>p95</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: "rgba(17,24,39,0.45)" }} />
            <span>p99</span>
          </div>
          <div className="text-gray-400">
            min <span className="text-gray-700">{Math.round(minV)}ms</span> • max{" "}
            <span className="text-gray-700">{Math.round(maxV)}ms</span>
          </div>
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------
// Chat Panel
// ------------------------------------------------------------
function ChatPanel({
  title,
  mounted,
  isLoading,
  chatMessages,
  chatInput,
  setChatInput,
  onSend,
  chatScrollRef,
  chatMode,
  setChatMode,
  execLabel,
  showPartnerMissing,
  partnerOptions,
  onPickPartner,
  onReset,
  resetDisabled,
}: {
  title: string;
  mounted: boolean;
  isLoading: boolean;
  chatMessages: ChatMessage[];
  chatInput: string;
  setChatInput: (v: string) => void;
  onSend: () => void;
  chatScrollRef: React.RefObject<HTMLDivElement | null>;

  chatMode: ChatMode;
  setChatMode: (m: ChatMode) => void;

  execLabel: string;
  showPartnerMissing: boolean;
  partnerOptions: readonly string[];
  onPickPartner: (p: string) => void;

  onReset: () => void;
  resetDisabled?: boolean;
}) {
  const placeholder = chatMode === "llm" ? "Try: partner beta_stream boston live last 1hr" : "Try: vod in usw2 at sjc manifest stb last 60m";

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm flex flex-col h-[420px] min-w-0">
      <div className="flex items-center justify-between gap-3 mb-3">
        <div className="font-medium text-gray-900">{title}</div>

        <div className="flex items-center gap-2">
          <div className="inline-flex rounded-lg border border-gray-200 bg-gray-50 p-0.5">
            <button
              type="button"
              onClick={() => setChatMode("deterministic")}
              className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors ${
                chatMode === "deterministic" ? "bg-white text-gray-900 shadow-sm" : "text-gray-600 hover:text-gray-900"
              }`}
              disabled={isLoading}
              title="Use deterministic parser only"
            >
              Deterministic
            </button>
            <button
              type="button"
              onClick={() => setChatMode("llm")}
              className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors ${
                chatMode === "llm" ? "bg-white text-gray-900 shadow-sm" : "text-gray-600 hover:text-gray-900"
              }`}
              disabled={isLoading}
              title="LLM Assist (general chat + hint parsing)"
            >
              LLM Assist
            </button>
          </div>

          <div className="text-[11px] text-gray-600 border border-gray-200 rounded-full px-2.5 py-1 bg-white">
            {execLabel}
          </div>

          <button
            type="button"
            onClick={onReset}
            disabled={Boolean(resetDisabled) || isLoading}
            className="text-[11px] text-gray-600 border border-gray-200 rounded-full px-2.5 py-1 bg-white hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
            title="Reset chat + filters + local + server memory"
          >
            Reset
          </button>
        </div>
      </div>

      {showPartnerMissing && (
        <div className="mb-3 rounded-lg border border-amber-200 bg-amber-50 p-3">
          <div className="text-sm font-medium text-amber-900">Partner required</div>
          <div className="text-xs text-amber-800 mt-1">Pick a partner below or select one in the filters panel.</div>
          <div className="mt-2 flex flex-wrap gap-2">
            {partnerOptions.map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => onPickPartner(p)}
                className="px-2.5 py-1 text-xs font-semibold rounded-md border border-amber-200 bg-white hover:bg-amber-100 text-amber-900"
                disabled={isLoading}
              >
                {p}
              </button>
            ))}
          </div>
        </div>
      )}

      <div ref={chatScrollRef} className="flex-1 overflow-y-auto rounded-lg border border-gray-200 p-4 bg-white mb-2">
        <div className="space-y-4">
          {chatMessages.map((msg) => (
            <div key={msg.id}>
              <div className="text-xs text-gray-500 mb-1">
                <span className="font-medium capitalize text-gray-700">{msg.role}</span> •{" "}
                {formatTimestampClientSafe(msg.timestamp, mounted)}
              </div>

              {msg.type === "text" ? (
                <pre className="whitespace-pre-wrap text-sm text-gray-900">{msg.text}</pre>
              ) : (
                <div className="rounded-xl border border-gray-200 bg-gray-50 p-3">
                  <div className="text-xs text-gray-600 font-medium mb-2">Triage run</div>
                  <pre className="whitespace-pre-wrap text-xs text-gray-700">{msg.run.summaryText || "(no summary)"}</pre>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      <div className="text-xs text-gray-400 mb-3">{isLoading ? "⏳ Running..." : "\u00A0"}</div>

      <div className="space-y-2">
        <div className="flex gap-2">
          <input
            type="text"
            disabled={isLoading}
            className="flex-1 rounded-lg border border-gray-300 bg-white text-gray-900 px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 placeholder-gray-400 disabled:opacity-60 disabled:cursor-not-allowed"
            placeholder={placeholder}
            value={chatInput ?? ""}
            onChange={(e) => setChatInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                onSend();
              }
            }}
          />
          <button
            onClick={onSend}
            disabled={isLoading || !chatInput.trim()}
            className="px-4 py-2 bg-blue-600 text-white font-semibold rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {isLoading ? "Running..." : "Send"}
          </button>
        </div>
        <div className="text-xs text-gray-500">{chatInput.trim() ? "Enter sends" : "Try: help • filters • reset • explain • run"}</div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------
// Main component
// ------------------------------------------------------------
export default function CDNTriageDebug() {
  const [mounted, setMounted] = useState(false);

  // Debug UI is ClickHouse-only
  const dataSource: DataSource = "clickhouse";

  // Partner (sticky)
  const [partner, setPartner] = useState<PartnerOrMissing>("");

  function setPartnerSticky(p: string) {
    const val = String(p || "").trim();
    if (!val) {
      setPartner("");
      safeRemoveLS(PARTNER_KEY);
      return;
    }
    if ((PARTNER_OPTIONS as readonly string[]).includes(val)) {
      setPartner(val as Partner);
      safeSetLS(PARTNER_KEY, val);
    }
  }

  // Filters
  const [service, setService] = useState("all");
  const [region, setRegion] = useState("all");
  const [pop, setPop] = useState("all");
  const [contentType, setContentType] = useState("all");
  const [uaFamily, setUaFamily] = useState("all");
  const [windowMinutes, setWindowMinutes] = useState(60);
  const [debugMode, setDebugMode] = useState(false);

  // Chat mode
  const [chatMode, setChatMode] = useState<ChatMode>("deterministic");
  const chatModeLabel = chatMode === "llm" ? "LLM Assist" : "Deterministic";

  // State
  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [summaryText, setSummaryText] = useState("");
  const [metricsJson, setMetricsJson] = useState<any>(null);
  const [sqlBlock, setSqlBlock] = useState<any>(null);

  // History
  const [runHistory, setRunHistory] = useState<TriageRun[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);

  // Chat
  const [chatInput, setChatInput] = useState("");
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);

  // Refs
  const chatScrollRef = useRef<HTMLDivElement | null>(null);
  const lastMessageIdRef = useRef<string | null>(null);

  useEffect(() => setMounted(true), []);

  // Restore partner from localStorage
  useEffect(() => {
    if (!mounted) return;
    const saved = safeGetLS(PARTNER_KEY);
    if (saved && (PARTNER_OPTIONS as readonly string[]).includes(saved)) {
      setPartner(saved as Partner);
    }
  }, [mounted]);

  // Restore chat mode
  useEffect(() => {
    if (!mounted) return;
    const stored = safeGetLS(CHAT_MODE_KEY);
    if (!stored) return;
    setChatMode(stored === "llm" ? "llm" : "deterministic");
  }, [mounted]);

  useEffect(() => {
    if (!mounted) return;
    safeSetLS(CHAT_MODE_KEY, chatMode);
  }, [chatMode, mounted]);

  function welcomeMessage(): ChatTextMessage {
    return {
      id: "welcome",
      type: "text",
      role: "system",
      text:
        "Welcome — Cachey 🤖 (Debug).\n\n" +
        "This page is ClickHouse-first (no CSV).\n" +
        "Pick a partner, then share symptoms + scope and I’ll triage.\n\n" +
        "Type `help` for examples.\n" +
        "Examples:\n" +
        "- `partner=beta_stream vod manifest stb last 60m`\n" +
        "- `service=live region=all pop=all content=segment ua=smart_tv win=120`\n",
      timestamp: getCurrentTimestamp(),
    };
  }

  useEffect(() => {
    if (!mounted) return;
    if (chatMessages.length > 0) return;
    setChatMessages([welcomeMessage()]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mounted, chatMessages.length]);

  // Restore history
  useEffect(() => {
    if (!mounted) return;
    const stored = safeGetLS(STORAGE_KEY);
    if (!stored) return;
    const parsed = safeParse<TriageRun[]>(stored, []);
    if (Array.isArray(parsed)) setRunHistory(parsed);
  }, [mounted]);

  useEffect(() => {
    if (!mounted) return;
    safeSetLS(STORAGE_KEY, JSON.stringify(runHistory));
  }, [runHistory, mounted]);

  // Chat auto-scroll
  useEffect(() => {
    const lastMessage = chatMessages[chatMessages.length - 1];
    if (!lastMessage) return;
    if (lastMessageIdRef.current !== lastMessage.id) {
      lastMessageIdRef.current = lastMessage.id;
      const el = chatScrollRef.current;
      if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    }
  }, [chatMessages]);

  const partnerMissing = !partner;
  const canRunTriage = Boolean(partner);

  // Dynamic Region/POP options from metricsJson.available (if present)
  const availableRegions: unknown = metricsJson?.available?.regions;
  const availablePops: unknown = metricsJson?.available?.pops;

  const REGION_OPTIONS = useMemo(() => {
    const arr = Array.isArray(availableRegions) ? availableRegions : [];
    const cleaned = (arr as unknown[])
      .map((x) => String(x ?? "").trim().toLowerCase())
      .filter((x) => Boolean(x));
    const uniq = Array.from(new Set<string>(cleaned));
    uniq.sort((a, b) => a.localeCompare(b));
    return ["all", ...uniq];
  }, [availableRegions]);

  const POP_OPTIONS = useMemo(() => {
    const arr = Array.isArray(availablePops) ? availablePops : [];
    const cleaned = (arr as unknown[])
      .map((x) => String(x ?? "").trim().toLowerCase())
      .filter((x) => Boolean(x));
    const uniq = Array.from(new Set<string>(cleaned));
    uniq.sort((a, b) => a.localeCompare(b));
    return ["all", ...uniq];
  }, [availablePops]);

  useEffect(() => {
    if (!REGION_OPTIONS.includes(region)) setRegion("all");
    if (!POP_OPTIONS.includes(pop)) setPop("all");
  }, [REGION_OPTIONS, POP_OPTIONS, region, pop]);

  const parsedMetrics = useMemo((): MetricsData | null => {
    if (!metricsJson) return null;
    return {
      totalRequests: Number(metricsJson.totalRequests) || 0,
      p95TtmsMs: metricsJson.p95TtmsMs == null ? null : Number(metricsJson.p95TtmsMs),
      p99TtmsMs: metricsJson.p99TtmsMs == null ? null : Number(metricsJson.p99TtmsMs),
      error5xxCount: metricsJson.error5xxCount == null ? null : Number(metricsJson.error5xxCount),
      errorRatePct: metricsJson.errorRatePct == null ? null : Number(metricsJson.errorRatePct),
    };
  }, [metricsJson]);

  const ts: TimeseriesData | null = useMemo(() => {
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
        statusCountsByCode: p.statusCountsByCode ? (p.statusCountsByCode as Record<string, number>) : undefined,
        hostCountsByHost: p.hostCountsByHost ? (p.hostCountsByHost as Record<string, number>) : undefined,
        crcCountsByCrc: p.crcCountsByCrc ? (p.crcCountsByCrc as Record<string, number>) : undefined,
      }))
      .filter((pt: TimeseriesPoint) => Boolean(pt.ts));

    return {
      bucketSeconds: t.bucketSeconds == null ? null : Number(t.bucketSeconds),
      startTs: t.startTs ? String(t.startTs) : null,
      endTs: t.endTs ? String(t.endTs) : null,
      points,
      statusCodeSeries: Array.isArray(t.statusCodeSeries) ? t.statusCodeSeries.map(String) : undefined,
      hostSeries: Array.isArray(t.hostSeries) ? t.hostSeries.map(String) : undefined,
      crcSeries: Array.isArray(t.crcSeries) ? t.crcSeries.map(String) : undefined,
    };
  }, [metricsJson]);

  function addChatText(role: ChatTextMessage["role"], text: string) {
    setChatMessages((prev) => [
      ...prev,
      {
        id: `${Date.now()}-${Math.random()}`,
        type: "text",
        role,
        text,
        timestamp: getCurrentTimestamp(),
      },
    ]);
  }

  function addChatTriage(run: ChatTriageMessage["run"]) {
    setChatMessages((prev) => [
      ...prev,
      {
        id: `${Date.now()}-${Math.random()}`,
        type: "triage_result",
        role: "assistant",
        timestamp: getCurrentTimestamp(),
        run,
      },
    ]);
  }

  async function runTriageRequest(inputs: TriageInputs) {
    // JSON wire (matches your curl)
    const response = await fetch("/api/triage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(inputs),
    });

    let data: any = null;
    try {
      data = await response.json();
    } catch {
      throw new Error(`Non-JSON response (HTTP ${response.status})`);
    }

    if (!response.ok || !data?.ok) {
      throw new Error(data?.error || `Request failed (HTTP ${response.status})`);
    }
    return data;
  }

  async function callChatApi(userText: string, history?: ChatMessage[]) {
    const safeHistory = Array.isArray(history) ? history : [];
    const wireMsgs = safeHistory
      .filter((m): m is ChatTextMessage => m.type === "text")
      .slice(-12)
      .map((m) => ({ role: m.role, content: m.text }));

    if (wireMsgs.length === 0) {
      wireMsgs.push({ role: "user", content: userText });
    } else {
      const last = wireMsgs[wireMsgs.length - 1];
      if (last.role !== "user") wireMsgs.push({ role: "user", content: userText });
      else last.content = userText;
    }

    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: wireMsgs,
        context: {
          mode: "clickhouse",
          chatMode,
          availableRegions: REGION_OPTIONS,
          availablePops: POP_OPTIONS,
          availablePartners: Array.from(PARTNER_OPTIONS),
          availableContentTypes: CONTENT_TYPE_OPTIONS,
          availableUaFamilies: UA_FAMILY_OPTIONS,
          currentFilters: {
            dataSource: "clickhouse",
            partner,
            service,
            region,
            pop,
            contentType,
            uaFamily,
            windowMinutes,
          },
        },
      }),
    });

    const json = await res.json().catch(() => null);
    if (!json) throw new Error("api/chat returned non-JSON");
    return json as any;
  }

  async function handleLogout() {
    try {
      await fetch("/api/demo-logout", { method: "POST" });
    } finally {
      window.location.href = "/demo";
    }
  }

  function resetAllUI() {
    if (isLoading) return;

    try {
      fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          reset: true,
          messages: [],
          context: {
            mode: "clickhouse",
            chatMode: "deterministic",
            availableRegions: [],
            availablePops: [],
            availablePartners: [],
            availableContentTypes: [],
            availableUaFamilies: [],
            currentFilters: {
              dataSource: "clickhouse",
              partner: "",
              service: "all",
              region: "all",
              pop: "all",
              contentType: "all",
              uaFamily: "all",
              windowMinutes: 60,
            },
          },
        }),
      }).catch(() => {});
    } catch {}

    if (mounted) {
      try {
        localStorage.removeItem(STORAGE_KEY);
        localStorage.removeItem(CHAT_MODE_KEY);
        localStorage.removeItem(PARTNER_KEY);
      } catch {}
    }

    setErrorMessage("");
    setSummaryText("");
    setMetricsJson(null);
    setSqlBlock(null);
    setSelectedRunId(null);

    setRunHistory([]);
    setChatInput("");
    setChatMessages([welcomeMessage()]);

    setPartnerSticky("");
    setService("all");
    setRegion("all");
    setPop("all");
    setContentType("all");
    setUaFamily("all");
    setWindowMinutes(60);
    setDebugMode(false);

    setChatMode("deterministic");
  }

  async function handleRunTriage() {
    setErrorMessage("");
    setSummaryText("");
    setMetricsJson(null);
    setSqlBlock(null);
    setSelectedRunId(null);

    if (!canRunTriage) {
      setErrorMessage("Please select a Partner to run ClickHouse triage.");
      return;
    }

    setIsLoading(true);
    try {
      const data = await runTriageRequest({
        dataSource,
        partner,
        service,
        region,
        pop,
        contentType,
        uaFamily,
        windowMinutes,
        debug: debugMode,
      });

      setSummaryText(data.summaryText || "");
      setMetricsJson(data.metricsJson || null);
      setSqlBlock(data.sql || null);

      const newRun: TriageRun = {
        id: `${Date.now()}`,
        timestamp: getCurrentTimestamp(),
        inputs: {
          dataSource,
          partner,
          service,
          region,
          pop,
          contentType,
          uaFamily,
          windowMinutes,
          debug: debugMode,
        },
        summaryText: data.summaryText || "",
        metricsJson: data.metricsJson || null,
        sql: data.sql || null,
      };
      setRunHistory((prev) => [newRun, ...prev].slice(0, MAX_HISTORY));
    } catch (error: any) {
      setErrorMessage(error?.message || "Something went wrong");
    } finally {
      setIsLoading(false);
    }
  }

  async function handleChatSend() {
    const text = chatInput.trim();
    if (!text) return;
    if (isLoading) return;

    setChatInput("");
    setErrorMessage("");

    const userMsg: ChatTextMessage = {
      id: `${Date.now()}-${Math.random()}`,
      type: "text",
      role: "user",
      text,
      timestamp: getCurrentTimestamp(),
    };

    const nextHistory = [...chatMessages, userMsg];
    setChatMessages(nextHistory);

    // Deterministic blocks clickhouse without partner
    if (partnerMissing && chatMode !== "llm") {
      addChatText(
        "assistant",
        [
          "ClickHouse triage requires a partner.",
          "",
          "Pick a partner in the dropdown (left panel) or click one of the quick buttons above.",
          "",
          `Available partners: ${PARTNER_OPTIONS.join(", ")}`,
        ].join("\n")
      );
      return;
    }

    // -----------------------------
    // LLM Assist mode
    // -----------------------------
    if (chatMode === "llm") {
      setIsLoading(true);
      try {
        const out = await callChatApi(text, nextHistory);

        if (out?.kind === "general") {
          addChatText("assistant", String(out.reply || "Hey 👋"));
          return;
        }

        if (!partner && out?.needsPartnerQuestion) {
          addChatText(
            "assistant",
            String(out.partnerQuestion || `Which partner should I use? (${PARTNER_OPTIONS.join(", ")})`)
          );
          return;
        }

        const nextService: string = out?.serviceHint ?? service;
        const nextRegion: string = out?.regionHint ?? region;
        const nextPop: string = out?.popHint ?? pop;
        const nextContentType: string = out?.contentTypeHint ?? contentType;
        const nextUaFamily: string = out?.uaFamilyHint ?? uaFamily;
        const nextWindow: number = Number(out?.windowHint ?? windowMinutes);

        if (out?.serviceHint) setService(String(out.serviceHint));
        if (out?.regionHint) setRegion(String(out.regionHint));
        if (out?.popHint) setPop(String(out.popHint));
        if (out?.contentTypeHint) setContentType(String(out.contentTypeHint));
        if (out?.uaFamilyHint) setUaFamily(String(out.uaFamilyHint));
        if (out?.windowHint != null && Number.isFinite(nextWindow) && nextWindow > 0) setWindowMinutes(nextWindow);

        // partner hint
        let nextPartner: PartnerOrMissing = partner;
        const p = String(out?.partnerHint || "").trim();
        if (p && (PARTNER_OPTIONS as readonly string[]).includes(p)) {
          setPartnerSticky(p);
          nextPartner = p as Partner;
        }

        addChatText(
          "assistant",
          `Parsed ✅ partner=${nextPartner || "(missing)"}, service=${nextService}, region=${nextRegion}, pop=${nextPop}, content=${nextContentType}, ua=${nextUaFamily}, win=${nextWindow}m`
        );

        if (!nextPartner) {
          addChatText("assistant", "Please select a partner first.");
          return;
        }

        addChatText(
          "system",
          `mode=llm • Running triage with ${buildFiltersSummary({
            dataSource,
            partner: nextPartner,
            service: nextService,
            region: nextRegion,
            pop: nextPop,
            contentType: nextContentType,
            uaFamily: nextUaFamily,
            windowMinutes: nextWindow,
          })}`
        );

        const data = await runTriageRequest({
          dataSource,
          partner: nextPartner,
          service: nextService,
          region: nextRegion,
          pop: nextPop,
          contentType: nextContentType,
          uaFamily: nextUaFamily,
          windowMinutes: nextWindow,
          debug: debugMode,
        });

        setSummaryText(data.summaryText || "");
        setMetricsJson(data.metricsJson || null);
        setSqlBlock(data.sql || null);
        setSelectedRunId(null);

        const newRun: TriageRun = {
          id: `${Date.now()}`,
          timestamp: getCurrentTimestamp(),
          inputs: {
            dataSource,
            partner: nextPartner,
            service: nextService,
            region: nextRegion,
            pop: nextPop,
            contentType: nextContentType,
            uaFamily: nextUaFamily,
            windowMinutes: nextWindow,
            debug: debugMode,
          },
          summaryText: data.summaryText || "",
          metricsJson: data.metricsJson || null,
          sql: data.sql || null,
        };
        setRunHistory((prev) => [newRun, ...prev].slice(0, MAX_HISTORY));

        addChatTriage({
          inputs: newRun.inputs,
          summaryText: newRun.summaryText,
          metricsJson: newRun.metricsJson,
          sql: newRun.sql,
        });

        return;
      } catch (error: any) {
        const msg = error?.message || "LLM Assist failed";
        setErrorMessage(msg);

        // fallback deterministic
        const intent = parseChatIntent(text);

        const isJustChat =
          !looksLikeTriageQuery(text) &&
          !intent.command &&
          !intent.partner &&
          !intent.service &&
          !intent.region &&
          !intent.pop &&
          !intent.contentType &&
          !intent.uaFamily &&
          intent.windowMinutes == null;

        if (isJustChat) {
          addChatText(
            "assistant",
            "My LLM brain glitched 😅 but I can still run deterministic triage.\n\nTry:\n- `partner=beta_stream vod manifest stb last 60m`\n- `help`"
          );
          return;
        }

        // apply hints
        if (intent.partner) {
          const p = String(intent.partner).trim();
          if ((PARTNER_OPTIONS as readonly string[]).includes(p)) setPartnerSticky(p);
        }
        const nextService = intent.service ?? service;
        const nextRegion = intent.region ?? region;
        const nextPop = intent.pop ?? pop;
        const nextContentType = intent.contentType ?? contentType;
        const nextUaFamily = intent.uaFamily ?? uaFamily;
        const nextWindow = intent.windowMinutes ?? windowMinutes;

        if (intent.service) setService(nextService);
        if (intent.region) setRegion(nextRegion);
        if (intent.pop) setPop(nextPop);
        if (intent.contentType) setContentType(nextContentType);
        if (intent.uaFamily) setUaFamily(nextUaFamily);
        if (intent.windowMinutes != null) setWindowMinutes(nextWindow);

        addChatText(
          "assistant",
          `LLM hiccup — fallback ✅ partner=${partner || "(missing)"}, service=${nextService}, region=${nextRegion}, pop=${nextPop}, content=${nextContentType}, ua=${nextUaFamily}, win=${nextWindow}m`
        );

        const shouldRun = intent.command === "run" || looksLikeTriageQuery(text);
        if (!shouldRun) return;

        if (!partner) {
          addChatText("assistant", `Pick a partner first: ${PARTNER_OPTIONS.join(", ")}`);
          return;
        }

        addChatText(
          "system",
          `mode=fallback • Running triage with ${buildFiltersSummary({
            dataSource,
            partner,
            service: nextService,
            region: nextRegion,
            pop: nextPop,
            contentType: nextContentType,
            uaFamily: nextUaFamily,
            windowMinutes: nextWindow,
          })}`
        );

        setIsLoading(true);
        try {
          const data = await runTriageRequest({
            dataSource,
            partner,
            service: nextService,
            region: nextRegion,
            pop: nextPop,
            contentType: nextContentType,
            uaFamily: nextUaFamily,
            windowMinutes: nextWindow,
            debug: debugMode,
          });

          setSummaryText(data.summaryText || "");
          setMetricsJson(data.metricsJson || null);
          setSqlBlock(data.sql || null);
          setSelectedRunId(null);

          const newRun: TriageRun = {
            id: `${Date.now()}`,
            timestamp: getCurrentTimestamp(),
            inputs: {
              dataSource,
              partner,
              service: nextService,
              region: nextRegion,
              pop: nextPop,
              contentType: nextContentType,
              uaFamily: nextUaFamily,
              windowMinutes: nextWindow,
              debug: debugMode,
            },
            summaryText: data.summaryText || "",
            metricsJson: data.metricsJson || null,
            sql: data.sql || null,
          };
          setRunHistory((prev) => [newRun, ...prev].slice(0, MAX_HISTORY));

          addChatTriage({
            inputs: newRun.inputs,
            summaryText: newRun.summaryText,
            metricsJson: newRun.metricsJson,
            sql: newRun.sql,
          });
        } catch (e: any) {
          const m = e?.message || "Fallback triage failed";
          setErrorMessage(m);
          addChatText("assistant", `Error: ${m}`);
        } finally {
          setIsLoading(false);
        }

        return;
      } finally {
        setIsLoading(false);
      }
    }

    // -----------------------------
    // Deterministic mode
    // -----------------------------
    if (isGreetingOrSmallTalk(text)) {
      addChatText(
        "assistant",
        "Hey — Cachey 🤖 (Debug)\n\nPick a partner, then try:\n- `vod manifest stb last 60m`\n- `service=live content=segment ua=smart_tv win=120`\n\nType `help` to see everything I can do."
      );
      return;
    }

    const intent = parseChatIntent(text);

    if (intent.command === "help") {
      addChatText(
        "assistant",
        [
          `Chat mode: ${chatModeLabel}`,
          "",
          "What I can do:",
          "- Run ClickHouse triage with filters (partner / service / region / pop / content_type / ua_family / window)",
          "- Show stacked charts + latency (p95/p99)",
          "- Commands: `filters`, `reset`, `explain`, `run`",
          "",
          "Examples:",
          "- `partner=beta_stream vod manifest stb last 60m`",
          "- `service=live content=segment ua=smart_tv win=120`",
          "- `region=all pop=all` (run once to discover region/pop options)",
        ].join("\n")
      );
      return;
    }

    if (intent.command === "show_filters") {
      addChatText(
        "assistant",
        `Current filters:\n${buildFiltersSummary({
          dataSource,
          partner,
          service,
          region,
          pop,
          contentType,
          uaFamily,
          windowMinutes,
        })}`
      );
      return;
    }

    if (intent.command === "reset") {
      resetAllUI();
      addChatText("assistant", "Reset ✅ Cleared chat + filters + memory. Pick a partner and type `run` when ready.");
      return;
    }

    if (intent.command === "explain") {
      addChatText(
        "assistant",
        [
          "What this computes:",
          "- totalRequests",
          "- error5xxCount + errorRatePct",
          "- p95 / p99 TTMS (latency)",
          "",
          "Charts:",
          "- Status stacked: events by HTTP status over time",
          "- Host stacked: events by host over time",
          "- CRC stacked: cache/response classification over time",
          "- Latency line: p95/p99 TTMS over time",
          "",
          "Tip: Run once with `region=all pop=all` to discover available region/pop options, then narrow down.",
        ].join("\n")
      );
      return;
    }

    // partner parsing
    if (intent.partner) {
      const p = String(intent.partner).trim();
      if ((PARTNER_OPTIONS as readonly string[]).includes(p)) {
        setPartnerSticky(p);
      } else {
        addChatText("assistant", `Unknown partner '${p}'. Allowed: ${PARTNER_OPTIONS.join(", ")}`);
        return;
      }
    }

    if (!partner) {
      addChatText("assistant", `Pick a partner first: ${PARTNER_OPTIONS.join(", ")}`);
      return;
    }

    const hasRegionOptions = REGION_OPTIONS.length > 1;
    const hasPopOptions = POP_OPTIONS.length > 1;

    if ((intent.region || intent.pop) && (!hasRegionOptions || !hasPopOptions)) {
      const pending: string[] = [];
      if (intent.region && !hasRegionOptions) pending.push("region (options not discovered yet)");
      if (intent.pop && !hasPopOptions) pending.push("pop (options not discovered yet)");

      const svcOk = intent.service == null || ALLOWED.service.has(intent.service);
      const winOk =
        intent.windowMinutes == null || (Number.isFinite(intent.windowMinutes) && intent.windowMinutes > 0);

      if (!svcOk || !winOk) {
        addChatText("assistant", "I can’t apply that yet—some values look invalid. Try `help` for examples.");
        return;
      }

      const changed: string[] = [];
      if (intent.service != null && intent.service !== service) {
        setService(intent.service);
        changed.push(`service=${intent.service}`);
      }
      if (intent.contentType != null && intent.contentType !== contentType) {
        setContentType(intent.contentType);
        changed.push(`content=${intent.contentType}`);
      }
      if (intent.uaFamily != null && intent.uaFamily !== uaFamily) {
        setUaFamily(intent.uaFamily);
        changed.push(`ua=${intent.uaFamily}`);
      }
      if (intent.windowMinutes != null && intent.windowMinutes !== windowMinutes) {
        setWindowMinutes(intent.windowMinutes);
        changed.push(`win=${intent.windowMinutes}m`);
      }

      addChatText(
        "assistant",
        [
          changed.length ? `Updated ✅ (${changed.join(", ")})` : "Got it ✅",
          "",
          `I can’t validate ${pending.join(" + ")} until we discover them from data.`,
          "Run once with broad filters:",
          "- `region=all pop=all` (or click “Run Triage”)",
          "Then try your region/pop again.",
        ].join("\n")
      );

      if (intent.command !== "run") return;
    }

    const invalids: string[] = [];

    if (intent.service && !ALLOWED.service.has(intent.service)) {
      invalids.push(`service=${intent.service} (allowed: ${Array.from(ALLOWED.service).join("|")})`);
    }
    if (intent.contentType && !ALLOWED.contentType.has(intent.contentType)) {
      invalids.push(`content=${intent.contentType} (allowed: ${Array.from(ALLOWED.contentType).join("|")})`);
    }
    if (intent.uaFamily && !ALLOWED.uaFamily.has(intent.uaFamily)) {
      invalids.push(`ua=${intent.uaFamily} (allowed: ${Array.from(ALLOWED.uaFamily).join("|")})`);
    }
    if (intent.region && hasRegionOptions && !REGION_OPTIONS.includes(intent.region)) {
      invalids.push(`region=${intent.region} (allowed: ${REGION_OPTIONS.join("|")})`);
    }
    if (intent.pop && hasPopOptions && !POP_OPTIONS.includes(intent.pop)) {
      invalids.push(`pop=${intent.pop} (allowed: ${POP_OPTIONS.join("|")})`);
    }
    if (intent.windowMinutes != null && (!Number.isFinite(intent.windowMinutes) || intent.windowMinutes <= 0)) {
      invalids.push(`win=${String(intent.windowMinutes)} (must be positive)`);
    }

    if (invalids.length) {
      addChatText(
        "assistant",
        `I couldn't run that because some values are invalid:\n- ${invalids.join("\n- ")}\n\nTry:\n- partner=beta_stream vod manifest stb last 60m\n- service=live content=segment ua=smart_tv win=120`
      );
      return;
    }

    const nextService = intent.service ?? service;
    const nextRegion = intent.region ?? region;
    const nextPop = intent.pop ?? pop;
    const nextContentType = intent.contentType ?? contentType;
    const nextUaFamily = intent.uaFamily ?? uaFamily;
    const nextWindow = intent.windowMinutes ?? windowMinutes;

    const changed: string[] = [];
    if (intent.service && intent.service !== service) {
      setService(intent.service);
      changed.push(`service=${intent.service}`);
    }
    if (intent.region && intent.region !== region) {
      setRegion(intent.region);
      changed.push(`region=${intent.region}`);
    }
    if (intent.pop && intent.pop !== pop) {
      setPop(intent.pop);
      changed.push(`pop=${intent.pop}`);
    }
    if (intent.contentType && intent.contentType !== contentType) {
      setContentType(intent.contentType);
      changed.push(`content=${intent.contentType}`);
    }
    if (intent.uaFamily && intent.uaFamily !== uaFamily) {
      setUaFamily(intent.uaFamily);
      changed.push(`ua=${intent.uaFamily}`);
    }
    if (intent.windowMinutes != null && intent.windowMinutes !== windowMinutes) {
      setWindowMinutes(intent.windowMinutes);
      changed.push(`win=${intent.windowMinutes}m`);
    }

    const shouldRun = intent.command === "run" || looksLikeTriageQuery(text) || changed.length > 0;
    if (!shouldRun) {
      addChatText("assistant", "I didn’t catch a triage command or filters.\nType `help` for examples.");
      return;
    }

    if (changed.length) addChatText("assistant", `Updated ✅ ${changed.join(", ")}`);

    addChatText(
      "system",
      `mode=${chatMode} • Running triage with ${buildFiltersSummary({
        dataSource,
        partner,
        service: nextService,
        region: nextRegion,
        pop: nextPop,
        contentType: nextContentType,
        uaFamily: nextUaFamily,
        windowMinutes: nextWindow,
      })}`
    );

    setIsLoading(true);
    try {
      const data = await runTriageRequest({
        dataSource,
        partner,
        service: nextService,
        region: nextRegion,
        pop: nextPop,
        contentType: nextContentType,
        uaFamily: nextUaFamily,
        windowMinutes: nextWindow,
        debug: debugMode,
      });

      setSummaryText(data.summaryText || "");
      setMetricsJson(data.metricsJson || null);
      setSqlBlock(data.sql || null);
      setSelectedRunId(null);

      const newRun: TriageRun = {
        id: `${Date.now()}`,
        timestamp: getCurrentTimestamp(),
        inputs: {
          dataSource,
          partner,
          service: nextService,
          region: nextRegion,
          pop: nextPop,
          contentType: nextContentType,
          uaFamily: nextUaFamily,
          windowMinutes: nextWindow,
          debug: debugMode,
        },
        summaryText: data.summaryText || "",
        metricsJson: data.metricsJson || null,
        sql: data.sql || null,
      };

      setRunHistory((prev) => [newRun, ...prev].slice(0, MAX_HISTORY));

      addChatTriage({
        inputs: newRun.inputs,
        summaryText: newRun.summaryText,
        metricsJson: newRun.metricsJson,
        sql: newRun.sql,
      });
    } catch (error: any) {
      const msg = error?.message || "Something went wrong";
      setErrorMessage(msg);
      addChatText("assistant", `Error: ${msg}`);
    } finally {
      setIsLoading(false);
    }
  }

  function loadHistoricalRun(run: TriageRun) {
    setSelectedRunId(run.id);
    setErrorMessage("");
    setSummaryText(run.summaryText || "");
    setMetricsJson(run.metricsJson || null);
    setSqlBlock(run.sql || null);

    setPartnerSticky((run.inputs?.partner as PartnerOrMissing) || "");

    setService(run.inputs?.service || "all");
    setRegion(run.inputs?.region || "all");
    setPop(run.inputs?.pop || "all");
    setContentType(run.inputs?.contentType || "all");
    setUaFamily(run.inputs?.uaFamily || "all");

    const wm = Number(run.inputs?.windowMinutes);
    setWindowMinutes(Number.isFinite(wm) && wm > 0 ? wm : 60);
    setDebugMode(!!run.inputs?.debug);
  }

  function deleteHistoricalRun(id: string) {
    setRunHistory((prev) => prev.filter((r) => r.id !== id));
    if (selectedRunId === id) {
      setSelectedRunId(null);
      setSummaryText("");
      setMetricsJson(null);
      setSqlBlock(null);
    }
  }

  function clearAllHistory() {
    setRunHistory([]);
    setSelectedRunId(null);
    setSummaryText("");
    setMetricsJson(null);
    setSqlBlock(null);
  }

  function MetricCard({ label, value, subtitle }: { label: string; value: string; subtitle?: string | null }) {
    return (
      <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm min-w-0">
        <div className="text-xs text-gray-600 font-medium">{label}</div>
        <div className="text-3xl font-bold mt-2 text-gray-900">{value}</div>
        {subtitle && <div className="text-xs text-gray-500 mt-2">{subtitle}</div>}
      </div>
    );
  }

  const bucketSeconds = ts?.bucketSeconds ?? metricsJson?.timeseries?.bucketSeconds ?? null;
  const execLabel = `Exec: ClickHouse • partner=${partner || "missing"}`;

  return (
    <main className="min-h-screen w-full bg-gray-50 px-6 py-6">
      <div className="mx-auto w-full">
        <div className="flex items-center gap-3 border-b border-gray-200 pb-4 mb-6">
          <Image src={LOGO_SRC} alt="Cachey" width={34} height={34} className="rounded-full" />
          <div className="min-w-0">
            <div className="font-semibold text-lg text-gray-900">
              Cachey <span className="text-gray-500">🤖</span> <span className="text-gray-400">(Debug)</span>
            </div>
            <div className="text-xs text-gray-500">ClickHouse-first triage console (no CSV)</div>
          </div>

          <div className="ml-auto">
            <button
              type="button"
              onClick={handleLogout}
              className="text-xs text-gray-700 border border-gray-200 rounded-full px-3 py-1.5 bg-white hover:bg-gray-50 transition-colors"
              title="Logout"
            >
              Logout
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          <aside className="lg:col-span-3 space-y-6">
            <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
              <div className="flex items-center justify-between mb-4">
                <h2 className="font-semibold text-gray-900 text-sm">Run History (last {MAX_HISTORY})</h2>
                <button
                  onClick={clearAllHistory}
                  disabled={runHistory.length === 0}
                  className="text-xs text-gray-600 hover:text-gray-900 px-2 py-1 rounded border border-gray-300 disabled:opacity-50 disabled:cursor-not-allowed hover:bg-gray-50"
                >
                  Clear
                </button>
              </div>

              {runHistory.length === 0 ? (
                <div className="text-sm text-gray-500">No history yet. Run triage once and it will appear here.</div>
              ) : (
                <div className="space-y-3">
                  {runHistory.map((run) => {
                    const isActive = run.id === selectedRunId;
                    const inp = run.inputs || ({} as any);
                    const subtitle = `clickhouse • partner=${inp.partner || "(missing)"} • svc=${inp.service} region=${inp.region} pop=${inp.pop} content=${inp.contentType} ua=${inp.uaFamily} win=${inp.windowMinutes}m`;

                    return (
                      <div
                        key={run.id}
                        className={`rounded-lg border p-3 transition-colors ${
                          isActive ? "bg-blue-50 border-blue-300" : "bg-white border-gray-200 hover:bg-gray-50"
                        }`}
                      >
                        <div className="text-xs font-semibold text-gray-900">{formatTimestampClientSafe(run.timestamp, mounted)}</div>
                        <div className="text-xs text-gray-600 mt-1">{subtitle}</div>
                        <div className="flex gap-2 mt-3">
                          <button
                            onClick={() => loadHistoricalRun(run)}
                            className="flex-1 text-xs font-medium px-3 py-1.5 rounded-md border border-gray-300 hover:bg-gray-50"
                          >
                            Load
                          </button>
                          <button
                            onClick={() => deleteHistoricalRun(run.id)}
                            className="text-xs font-medium px-3 py-1.5 rounded-md border border-red-300 text-red-600 hover:bg-red-50"
                          >
                            Delete
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </aside>

          <section className="lg:col-span-9 min-w-0">
            <div className="mb-6">
              <ChatPanel
                title="Chat"
                mounted={mounted}
                isLoading={isLoading}
                chatMessages={chatMessages}
                chatInput={chatInput}
                setChatInput={setChatInput}
                onSend={handleChatSend}
                chatScrollRef={chatScrollRef}
                chatMode={chatMode}
                setChatMode={setChatMode}
                execLabel={execLabel}
                showPartnerMissing={partnerMissing && chatMode !== "llm"}
                partnerOptions={PARTNER_OPTIONS}
                onPickPartner={(p) => setPartnerSticky(p)}
                onReset={resetAllUI}
                resetDisabled={isLoading}
              />
            </div>

            <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
              {/* Left */}
              <div className="space-y-4 min-w-0">
                <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
                  <div className="space-y-4">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-2">Partner</label>
                      <select
                        className="w-full rounded-lg border border-gray-300 bg-white text-gray-900 px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                        value={partner}
                        onChange={(e) => setPartnerSticky(e.target.value)}
                        disabled={isLoading}
                      >
                        <option value="">Select partner…</option>
                        {PARTNER_OPTIONS.map((p) => (
                          <option key={p} value={p}>
                            {p}
                          </option>
                        ))}
                      </select>
                      <div className="text-xs text-gray-500 mt-2">Public-safe mock partner routing (real partner → DB mapping later).</div>
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-2">Service</label>
                        <select
                          className="w-full rounded-lg border border-gray-300 bg-white text-gray-900 px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                          value={service}
                          onChange={(e) => setService(e.target.value)}
                          disabled={isLoading}
                        >
                          {SERVICE_OPTIONS.map((v) => (
                            <option key={v} value={v}>
                              {v}
                            </option>
                          ))}
                        </select>
                      </div>

                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-2">Content Type</label>
                        <select
                          className="w-full rounded-lg border border-gray-300 bg-white text-gray-900 px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                          value={contentType}
                          onChange={(e) => setContentType(e.target.value)}
                          disabled={isLoading}
                        >
                          {CONTENT_TYPE_OPTIONS.map((v) => (
                            <option key={v} value={v}>
                              {v}
                            </option>
                          ))}
                        </select>
                      </div>

                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-2">UA Family</label>
                        <select
                          className="w-full rounded-lg border border-gray-300 bg-white text-gray-900 px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                          value={uaFamily}
                          onChange={(e) => setUaFamily(e.target.value)}
                          disabled={isLoading}
                        >
                          {UA_FAMILY_OPTIONS.map((v) => (
                            <option key={v} value={v}>
                              {v}
                            </option>
                          ))}
                        </select>
                      </div>

                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-2">Region</label>
                        <select
                          className="w-full rounded-lg border border-gray-300 bg-white text-gray-900 px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                          value={region}
                          onChange={(e) => setRegion(e.target.value)}
                          disabled={isLoading}
                        >
                          {REGION_OPTIONS.map((v) => (
                            <option key={v} value={v}>
                              {v}
                            </option>
                          ))}
                        </select>
                        {REGION_OPTIONS.length <= 1 && (
                          <div className="text-[11px] text-gray-400 mt-2">Run once to populate region options.</div>
                        )}
                      </div>

                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-2">POP</label>
                        <select
                          className="w-full rounded-lg border border-gray-300 bg-white text-gray-900 px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                          value={pop}
                          onChange={(e) => setPop(e.target.value)}
                          disabled={isLoading}
                        >
                          {POP_OPTIONS.map((v) => (
                            <option key={v} value={v}>
                              {v}
                            </option>
                          ))}
                        </select>
                        {POP_OPTIONS.length <= 1 && (
                          <div className="text-[11px] text-gray-400 mt-2">Run once to populate POP options.</div>
                        )}
                      </div>

                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-2">Window (minutes)</label>
                        <input
                          type="number"
                          className="w-full rounded-lg border border-gray-300 bg-white text-gray-900 px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                          value={Number.isFinite(windowMinutes) ? windowMinutes : 60}
                          onChange={(e) => {
                            const raw = e.target.value;
                            if (raw === "") {
                              setWindowMinutes(60);
                              return;
                            }
                            const n = Number(raw);
                            setWindowMinutes(Number.isFinite(n) && n > 0 ? n : 60);
                          }}
                          min={1}
                          disabled={isLoading}
                        />
                      </div>
                    </div>

                    <div className="flex items-center justify-between gap-3 pt-2">
                      <label className="flex items-center gap-2 text-sm text-gray-700">
                        <input
                          type="checkbox"
                          checked={debugMode}
                          onChange={(e) => setDebugMode(e.target.checked)}
                          className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                          disabled={isLoading}
                        />
                        Enable debug output (SQL + extra)
                      </label>

                      <button
                        onClick={handleRunTriage}
                        disabled={isLoading || !canRunTriage}
                        className="px-6 py-2 bg-blue-600 text-white font-semibold rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                        title={!canRunTriage ? "Select a partner to run ClickHouse triage" : undefined}
                      >
                        {isLoading ? "Running..." : "Run Triage"}
                      </button>
                    </div>

                    {errorMessage && (
                      <div className="rounded-lg border border-red-300 bg-red-50 p-3">
                        <p className="text-sm text-red-800">
                          <strong>Error:</strong> {errorMessage}
                        </p>
                      </div>
                    )}
                  </div>
                </div>

                {parsedMetrics && (
                  <div className="grid grid-cols-2 gap-3">
                    <MetricCard label="totalRequests" value={formatIntOrNA(parsedMetrics.totalRequests)} />
                    <MetricCard label="p95TtmsMs" value={formatMsOrNA(parsedMetrics.p95TtmsMs)} />
                    <MetricCard label="p99TtmsMs" value={formatMsOrNA(parsedMetrics.p99TtmsMs)} />
                    <MetricCard
                      label="errorRate (5xx)"
                      value={formatPctOrNA(parsedMetrics.errorRatePct)}
                      subtitle={
                        parsedMetrics.error5xxCount == null
                          ? null
                          : `${parsedMetrics.error5xxCount.toLocaleString()} / ${parsedMetrics.totalRequests.toLocaleString()}`
                      }
                    />
                  </div>
                )}

                <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
                  <div className="font-medium text-gray-900 mb-2">Summary</div>
                  <pre className="whitespace-pre-wrap text-sm text-gray-700 font-mono">{summaryText || "Run triage to see results..."}</pre>
                </div>

                {debugMode && (
                  <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
                    <div className="font-medium text-gray-900 mb-2">SQL (debug)</div>
                    <pre className="whitespace-pre-wrap text-xs text-gray-600 font-mono overflow-auto max-h-64">
                      {sqlBlock ? JSON.stringify(sqlBlock, null, 2) : "No sql block yet."}
                    </pre>
                  </div>
                )}

                {debugMode && (
                  <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
                    <div className="font-medium text-gray-900 mb-2">Raw metricsJson (debug)</div>
                    <pre className="whitespace-pre-wrap text-xs text-gray-600 font-mono overflow-auto max-h-64">
                      {metricsJson ? JSON.stringify(metricsJson, null, 2) : "No metricsJson yet."}
                    </pre>
                  </div>
                )}
              </div>

              {/* Right */}
              <div className="space-y-4 min-w-0">
                {ts && ts.points.length > 0 ? (
                  <>
                    <StackedBarTimeseries
                      title="Total events by status code (stacked)"
                      subtitle="Traffic timeseries"
                      ts={ts}
                      bucketSeconds={bucketSeconds}
                      seriesKeys={ts.statusCodeSeries || []}
                      getMap={(p) => p.statusCountsByCode}
                      height={190}
                      windowMinutes={windowMinutes}
                    />

                    <StackedBarTimeseries
                      title="Total events by host (stacked)"
                      subtitle="Traffic timeseries"
                      ts={ts}
                      bucketSeconds={bucketSeconds}
                      seriesKeys={ts.hostSeries || []}
                      getMap={(p) => p.hostCountsByHost}
                      height={190}
                      windowMinutes={windowMinutes}
                    />

                    <StackedBarTimeseries
                      title="Total events by CRC code (stacked)"
                      subtitle="Cache / response classification"
                      ts={ts}
                      bucketSeconds={bucketSeconds}
                      seriesKeys={ts.crcSeries || []}
                      getMap={(p) => p.crcCountsByCrc}
                      height={190}
                      windowMinutes={windowMinutes}
                    />

                    <LatencyTimeseriesLines points={ts.points} bucketSeconds={bucketSeconds} height={190} windowMinutes={windowMinutes} />
                  </>
                ) : (
                  <div className="rounded-xl border border-gray-200 bg-gray-50 p-3 text-sm text-gray-600">
                    Select a partner and run triage to see charts.
                  </div>
                )}
              </div>
            </div>
          </section>
        </div>
      </div>
    </main>
  );
}
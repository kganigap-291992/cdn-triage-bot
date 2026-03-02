// ui/app/page.tsx
"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";
import type { TriageResponse } from "@/lib/triage/contracts";
import { CANON } from "@/lib/schema/canonical";

// ------------------------------------------------------------
// Home page (/) — Deterministic v1 (Option A)
// - Single deterministic behavior (Run + cards)
// - No LLM mode / no schema modal
// - Keep /debug as legacy page (unchanged)
// - Keep schema fetch silently (dropdown options)
// ------------------------------------------------------------

const LOGO_SRC = "/cachey-logo.png";

// Sticky + TTL keys
const PARTNER_KEY = "cachey:partner";
const FILTERS_KEY = "cachey:filters";
const FILTERS_TTL_MS = 24 * 60 * 60 * 1000; // 24h

const PARTNER_OPTIONS = CANON.partners;
const SERVICE_OPTIONS = CANON.services;

type Partner = (typeof CANON.partners)[number];
type PartnerOrMissing = Partner | "";

type DataSource = "clickhouse";

type TriageInputs = {
  dataSource: DataSource;
  partner: PartnerOrMissing;
  service: string; // required (never "all")
  region: string; // "all" | canon region
  pop: string; // "all" | canon pop
  windowMinutes: number;

  // schema-aligned filters
  contentType: string; // all|manifest|segment|api
  uaFamily: string; // all|stb|mobile|web|smart_tv|console
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
    sql?: any | null;
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

// ---- UTC label helpers (charts) ----
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

function formatCountTick(v: number): string {
  const n = Number(v);
  if (!Number.isFinite(n)) return "";
  const abs = Math.abs(n);
  if (abs >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return Math.round(n).toString();
}

// Stable palette used in old page
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

// ------------------------------------------------------------
// Typing dots (subtle)
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
// Generic stacked bar chart (ported from old page)
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
  const presentKeys = Array.from(present.entries())
    .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))
    .map(([k]) => k);

  const ordered = [...seriesKeys.filter((k) => present.has(k)), ...presentKeys.filter((k) => !seriesKeys.includes(k))];

  const keys = ordered.slice(0, 10);
  if (!keys.length) return null;

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
            Drag to zoom • double-click to reset
            {zoom ? (
              <button type="button" className="ml-2 underline hover:text-gray-300" onClick={() => setZoom(null)}>
                reset zoom
              </button>
            ) : null}
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
// Latency line chart (ported from old page)
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
          <div className="text-xs text-gray-400">Latency timeseries</div>
          <div className="text-sm font-semibold text-gray-100">p95 / p99 TTMS</div>
          <div className="text-[11px] text-gray-400 mt-1">
            {slice.length
              ? `${formatUtcYmdHm(slice[0].ts)} → ${formatUtcYmdHm(slice[slice.length - 1].ts)} UTC (bucket: ${bucketLabel(
                  bucketSeconds
                )})`
              : `bucket: ${bucketLabel(bucketSeconds)} (UTC)`}
          </div>
          <div className="text-[11px] text-gray-500 mt-1">
            Drag to zoom • double-click to reset
            {zoom ? (
              <button type="button" className="ml-2 underline hover:text-gray-300" onClick={() => setZoom(null)}>
                reset zoom
              </button>
            ) : null}
          </div>
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
                <text x={padLeft - 10} y={yy + 3} fontSize="10" fill="#9ca3af" textAnchor="end" opacity={0.95}>
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
            stroke="rgba(17,24,39,0.55)"
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
            <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: "rgba(37,99,235,0.92)" }} />
            <span>p95</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: "rgba(17,24,39,0.55)" }} />
            <span>p99</span>
          </div>
          <div className="text-gray-500">
            min <span className="text-gray-200">{Math.round(minV)}ms</span> • max{" "}
            <span className="text-gray-200">{Math.round(maxV)}ms</span>
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

  // sticky partner
  const [partner, setPartner] = useState<PartnerOrMissing>("partner_01");
  function setPartnerSticky(p: string) {
    const v = String(p || "").trim();
    if (!v) return;
    if ((PARTNER_OPTIONS as readonly string[]).includes(v)) {
      setPartner(v as Partner);
      safeSetLS(PARTNER_KEY, v);
    }
  }

  // UI state
  const [isTriageLoading, setIsTriageLoading] = useState(false);
  const isLoading = isTriageLoading;

  // Filters UX: collapsible panel + staged selections
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [filtersDirty, setFiltersDirty] = useState(false);

  // Schema state (loaded once on mount) — SILENT
  const [schemaState, setSchemaState] = useState<SchemaState>({
    partners: [...CANON.partners],
    services: [...CANON.services],
    regions: [...CANON.regions],
    pops: [...CANON.pops],
    contentTypes: ["all", ...CANON.contentTypes],
    uaFamilies: ["all", ...CANON.uaFamilies],
  });

  // Chat
  const [chatInput, setChatInput] = useState("");
  const [chatMessages, setChatMessages] = useState<ChatMsg[]>([]);
  const chatScrollRef = useRef<HTMLDivElement | null>(null);
  const lastMsgIdRef = useRef<string | null>(null);

  // typing indicator
  const [typing, setTyping] = useState(false);

  // Run log (system messages) separated
  const [runLogOpen, setRunLogOpen] = useState(false);
  const [runLog, setRunLog] = useState<Array<{ ts: string; text: string }>>([]);

  // current filters (applied)
  const [service, setService] = useState<string>("");
  const [region, setRegion] = useState<string>("all");
  const [pop, setPop] = useState<string>("all");
  const [windowMinutes, setWindowMinutes] = useState<number>(120);

  // extra filters
  const [contentType, setContentType] = useState<string>("all");
  const [uaFamily, setUaFamily] = useState<string>("all");

  // staged filters (draft UI selections before Apply)
  const [draftService, setDraftService] = useState<string>("");
  const [draftRegion, setDraftRegion] = useState<string>("all");
  const [draftPop, setDraftPop] = useState<string>("all");
  const [draftWindowMinutes, setDraftWindowMinutes] = useState<number>(120);
  const [draftContentType, setDraftContentType] = useState<string>("all");
  const [draftUaFamily, setDraftUaFamily] = useState<string>("all");

  useEffect(() => setMounted(true), []);

  // TTL helpers for filter persistence
  function loadFiltersFromTTL() {
    const raw = safeGetLS(FILTERS_KEY);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      const expiresAt = Number(parsed?.expiresAt ?? 0);
      if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
        safeDelLS(FILTERS_KEY);
        return null;
      }
      return parsed?.value ?? null;
    } catch {
      safeDelLS(FILTERS_KEY);
      return null;
    }
  }
  function saveFiltersToTTL(next: {
    partner: string;
    service: string;
    region: string;
    pop: string;
    windowMinutes: number;
    contentType: string;
    uaFamily: string;
  }) {
    safeSetLS(
      FILTERS_KEY,
      JSON.stringify({
        expiresAt: Date.now() + FILTERS_TTL_MS,
        value: next,
      })
    );
  }

  // Load sticky partner + TTL filters on mount
  useEffect(() => {
    if (!mounted) return;

    const savedPartner = safeGetLS(PARTNER_KEY);
    if (savedPartner && (PARTNER_OPTIONS as readonly string[]).includes(savedPartner)) {
      setPartner(savedPartner as Partner);
    }

    const ttl = loadFiltersFromTTL();
    if (ttl) {
      const p = String(ttl.partner || "").trim();
      if (p && (PARTNER_OPTIONS as readonly string[]).includes(p)) setPartner(p as Partner);

      const s = String(ttl.service || "").trim();
      if (s && (SERVICE_OPTIONS as readonly string[]).includes(s)) {
        setService(s);
        setDraftService(s);
      }

      const r = String(ttl.region || "all").trim() || "all";
      setRegion(r);
      setDraftRegion(r);

      const pp = String(ttl.pop || "all").trim() || "all";
      setPop(pp);
      setDraftPop(pp);

      const w = Number(ttl.windowMinutes ?? 120);
      if (Number.isFinite(w) && w > 0) {
        setWindowMinutes(w);
        setDraftWindowMinutes(w);
      }

      const ct = String(ttl.contentType || "all").trim() || "all";
      setContentType(ct);
      setDraftContentType(ct);

      const ua = String(ttl.uaFamily || "all").trim() || "all";
      setUaFamily(ua);
      setDraftUaFamily(ua);
    } else {
      // initialize drafts from defaults
      setDraftService(service);
      setDraftRegion(region);
      setDraftPop(pop);
      setDraftWindowMinutes(windowMinutes);
      setDraftContentType(contentType);
      setDraftUaFamily(uaFamily);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mounted]);

  // Persist TTL whenever applied filters change
  useEffect(() => {
    if (!mounted) return;
    saveFiltersToTTL({
      partner: partner || "",
      service: service || "",
      region,
      pop,
      windowMinutes,
      contentType,
      uaFamily,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mounted, partner, service, region, pop, windowMinutes, contentType, uaFamily]);

  // Load schema once on mount (drives dropdowns) — SILENT
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
      } catch {
        // keep CANON defaults
      }
    })();
  }, [mounted]);

  // welcome message once
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
          "Cachey 🤖 — deterministic triage.\n\n" +
          "Pick a partner + service, then:\n" +
          "- Apply filters\n" +
          "- Run triage\n\n" +
          "Send box is a shortcut: it logs what you typed and triggers Run using the applied filters.",
      },
    ]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mounted]);

  // autoscroll
  useEffect(() => {
    const last = chatMessages[chatMessages.length - 1];
    if (!last) return;
    if (lastMsgIdRef.current !== last.id) {
      lastMsgIdRef.current = last.id;
      const el = chatScrollRef.current;
      el?.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    }
  }, [chatMessages]);

  // Dropdown options are schema-driven
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
    const uniq = Array.from(
      new Set((schemaState.contentTypes || []).map((x) => String(x || "").trim()).filter(Boolean))
    ).sort((a, b) => a.localeCompare(b));
    return uniq.includes("all") ? uniq : ["all", ...uniq];
  }, [schemaState.contentTypes]);

  const availableUaFamilies: string[] = useMemo(() => {
    const uniq = Array.from(
      new Set((schemaState.uaFamilies || []).map((x) => String(x || "").trim()).filter(Boolean))
    ).sort((a, b) => a.localeCompare(b));
    return uniq.includes("all") ? uniq : ["all", ...uniq];
  }, [schemaState.uaFamilies]);

  // Parse metricsJson.timeseries into TimeseriesData
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
        statusCountsByCode: p.statusCountsByCode || undefined,
        hostCountsByHost: p.hostCountsByHost || undefined,
        crcCountsByCrc: p.crcCountsByCrc || undefined,
      }))
      .filter((pt: any) => Boolean(pt.ts));

    return {
      bucketSeconds: t.bucketSeconds == null ? null : Number(t.bucketSeconds),
      startTs: t.startTs ? String(t.startTs) : null,
      endTs: t.endTs ? String(t.endTs) : null,
      points,
      statusCodeSeries: Array.isArray(t.statusCodeSeries) ? t.statusCodeSeries.map(String) : undefined,
      hostSeries: Array.isArray(t.hostSeries) ? t.hostSeries.map(String) : undefined,
      crcSeries: Array.isArray(t.crcSeries) ? t.crcSeries.map(String) : undefined,
    };
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
      {
        id: `${Date.now()}-${Math.random()}`,
        type: "triage",
        role: "assistant",
        ts: nowIso(),
        run,
      },
    ]);
  }

  function isAllowed(val: string, allowed: string[]) {
    const v = String(val ?? "").trim();
    if (!v) return false;
    return allowed.includes(v);
  }

  function applyDraftFilters() {
    // validate service
    const s = String(draftService || "").trim();
    if (!s) return { ok: false as const, error: "Pick a service before Apply." };
    if (!(SERVICE_OPTIONS as readonly string[]).includes(s)) return { ok: false as const, error: "Invalid service selection." };

    // validate contentType/uaFamily
    const ct = String(draftContentType || "all").trim() || "all";
    const ua = String(draftUaFamily || "all").trim() || "all";

    const allowedCT = availableContentTypes.length ? availableContentTypes : ["all", "manifest", "segment", "api"];
    const allowedUA = availableUaFamilies.length ? availableUaFamilies : ["all", "stb", "mobile", "web", "smart_tv", "console"];

    if (!isAllowed(ct, allowedCT)) return { ok: false as const, error: "Invalid contentType selection." };
    if (!isAllowed(ua, allowedUA)) return { ok: false as const, error: "Invalid uaFamily selection." };

    // apply
    setService(s);
    setRegion(String(draftRegion || "all"));
    setPop(String(draftPop || "all"));
    setWindowMinutes(Number(draftWindowMinutes) || 120);
    setContentType(ct);
    setUaFamily(ua);

    setFiltersDirty(false);
    setFiltersOpen(false);

    pushRunLog(`Applied filters: svc=${s} region=${draftRegion} pop=${draftPop} win=${draftWindowMinutes}m ct=${ct} ua=${ua}`);
    return { ok: true as const };
  }

  // One deterministic triage call
  async function runTriage(inputs: TriageInputs) {
    const formData = new FormData();

    formData.append("dataSource", inputs.dataSource);
    formData.append("partner", inputs.partner || "");
    formData.append("csvUrl", ""); // harmless legacy
    formData.append("service", inputs.service);
    formData.append("region", inputs.region);
    formData.append("pop", inputs.pop);
    formData.append("windowMinutes", String(inputs.windowMinutes));
    formData.append("contentType", String(inputs.contentType || "all"));
    formData.append("uaFamily", String(inputs.uaFamily || "all"));

    if (process.env.NODE_ENV !== "production") {
      formData.append("debug", "true");
    }

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
    };
  }

  // Run triage directly from applied filters
  async function handleRunFromFilters() {
    if (isLoading) return;

    if (!partner) {
      addText("assistant", `Pick a partner first. (${PARTNER_OPTIONS.join(", ")})`);
      return;
    }
    if (!service) {
      addText("assistant", `Pick a service first. (Filters → Apply) (${SERVICE_OPTIONS.join(", ")})`);
      return;
    }

    setIsTriageLoading(true);
    setTyping(true);

    try {
      pushRunLog(
        `Running triage: partner=${partner} svc=${service} region=${region} pop=${pop} win=${windowMinutes}m ct=${contentType} ua=${uaFamily}`
      );

      const data = await runTriage({
        dataSource: "clickhouse",
        partner,
        service,
        region,
        pop,
        windowMinutes,
        contentType,
        uaFamily,
      });

      addTriageCard({
        inputs: { dataSource: "clickhouse", partner, service, region, pop, windowMinutes, contentType, uaFamily },
        summaryText: data.summaryText || "",
        metricsJson: data.metricsJson || null,
        sql: data.sql ?? null,
      });
    } catch (e: any) {
      addText("assistant", `Triage failed: ${e?.message || "unknown error"}`);
    } finally {
      setTyping(false);
      setIsTriageLoading(false);
    }
  }

  // Composer: log text, then run using applied filters
  async function handleSend() {
    const text = chatInput.trim();
    if (!text || isLoading) return;
    setChatInput("");

    addText("user", text);
    await handleRunFromFilters();
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

    // Simple demo-safe health thresholds
    const p95ms = p95 == null ? null : Number(p95);
    const errp = errPct == null ? null : Number(errPct);

    let health = "GREEN";
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
    const bucketSeconds = ts?.bucketSeconds ?? run.metricsJson?.timeseries?.bucketSeconds ?? null;

    const summary = String(run.summaryText || "").trim();
    const summaryText = summary ? summary : buildSummaryFallback(run);

    const pointsCount = ts?.points?.length ?? 0;
    const debug = run.metricsJson?.debug ?? null;
    const normalizedFrom = debug?.normalizedFrom ?? debug?.normalized_from ?? null;
    const normalizedAt = debug?.normalizedAt ?? debug?.normalized_at ?? null;

    return (
      <div className="triage-enter rounded-2xl border border-white/10 bg-white/5 backdrop-blur p-4 shadow-[0_0_0_1px_rgba(255,255,255,0.04)] space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-xs text-gray-400">Triage result</div>
            <div className="text-sm font-semibold text-gray-100 truncate">
              partner={run.inputs.partner} • svc={run.inputs.service} • region={run.inputs.region} • pop={run.inputs.pop} • win=
              {run.inputs.windowMinutes}m • ct={run.inputs.contentType} • ua={run.inputs.uaFamily}
            </div>
            {ts?.startTs && ts?.endTs ? (
              <div className="text-[11px] text-gray-500 mt-1">
                actual window: {formatUtcYmdHm(ts.startTs)} → {formatUtcYmdHm(ts.endTs)} UTC
              </div>
            ) : null}
          </div>
          <div className="text-xs text-gray-500">/api/triage</div>
        </div>

        <MetricChips metricsJson={run.metricsJson} />

        <div className="rounded-xl border border-white/10 bg-black/30 p-3">
          <div className="text-xs text-gray-400 mb-2">Summary</div>
          <pre className="whitespace-pre-wrap text-sm text-gray-100/90 leading-relaxed">{summaryText}</pre>
        </div>

        {ts && ts.points.length > 0 ? (
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
            <StackedBarTimeseries
              title="Status code (stacked)"
              subtitle="Traffic timeseries"
              ts={ts}
              bucketSeconds={bucketSeconds}
              seriesKeys={ts.statusCodeSeries || []}
              getMap={(p) => p.statusCountsByCode}
              height={190}
              windowMinutes={run.inputs.windowMinutes}
            />
            <LatencyTimeseriesLines points={ts.points} bucketSeconds={bucketSeconds} height={190} windowMinutes={run.inputs.windowMinutes} />
            <StackedBarTimeseries
              title="Host (stacked)"
              subtitle="Traffic timeseries"
              ts={ts}
              bucketSeconds={bucketSeconds}
              seriesKeys={ts.hostSeries || []}
              getMap={(p) => p.hostCountsByHost}
              height={190}
              windowMinutes={run.inputs.windowMinutes}
            />
            <StackedBarTimeseries
              title="CRC (stacked)"
              subtitle="Cache / response classification"
              ts={ts}
              bucketSeconds={bucketSeconds}
              seriesKeys={ts.crcSeries || []}
              getMap={(p) => p.crcCountsByCrc}
              height={190}
              windowMinutes={run.inputs.windowMinutes}
            />
          </div>
        ) : (
          <div className="text-sm text-gray-400">Timeseries: 0 points (aggregate-only).</div>
        )}

        <details className="rounded-xl border border-white/10 bg-black/20 p-3">
          <summary className="cursor-pointer text-sm text-gray-200">Deterministic Evidence</summary>
          <div className="mt-3 space-y-3">
            <div>
              <div className="text-[11px] text-gray-400 mb-1">Inputs</div>
              <pre className="whitespace-pre-wrap text-xs text-gray-200/90 rounded-xl border border-white/10 bg-black/30 p-3">
                {JSON.stringify(run.inputs, null, 2)}
              </pre>
            </div>

            <div className="text-xs text-gray-300">
              <span className="text-gray-400">Timeseries points:</span> <span className="font-semibold">{pointsCount}</span>
            </div>

            {normalizedFrom || normalizedAt ? (
              <div className="text-xs text-gray-300">
                <span className="text-gray-400">Normalization:</span>{" "}
                {normalizedFrom ? <span className="font-semibold">from={String(normalizedFrom)} </span> : null}
                {normalizedAt ? <span className="font-semibold">at={String(normalizedAt)}</span> : null}
              </div>
            ) : (
              <div className="text-xs text-gray-500">Normalization stamps not provided by API.</div>
            )}
          </div>
        </details>

        <details className="rounded-xl border border-white/10 bg-black/20 p-3">
          <summary className="cursor-pointer text-sm text-gray-200">SQL Query</summary>
          <div className="mt-3">
            {run.sql ? (
              <pre className="whitespace-pre-wrap text-xs text-gray-200/90 rounded-xl border border-white/10 bg-black/30 p-3">
                {typeof run.sql === "string" ? run.sql : JSON.stringify(run.sql, null, 2)}
              </pre>
            ) : (
              <div className="text-xs text-gray-500">No SQL returned by API (will be added in v2).</div>
            )}
          </div>
        </details>

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

  const partnerMissing = !partner;
  const serviceMissing = !service;

  // Compact header "chips" (show applied filters)
  const appliedChips = useMemo(() => {
    const chips: Array<{ k: string; v: string }> = [];
    chips.push({ k: "partner", v: partner || "—" });
    chips.push({ k: "svc", v: service || "—" });
    chips.push({ k: "region", v: region || "all" });
    chips.push({ k: "pop", v: pop || "all" });
    chips.push({ k: "win", v: `${windowMinutes}m` });
    chips.push({ k: "ct", v: contentType || "all" });
    chips.push({ k: "ua", v: uaFamily || "all" });
    return chips;
  }, [partner, service, region, pop, windowMinutes, contentType, uaFamily]);

  return (
    <main className="min-h-screen bg-black text-gray-100">
      {/* Sticky header */}
      <div className="sticky top-0 z-50 border-b border-white/10 bg-black/75 backdrop-blur">
        <div className="mx-auto max-w-6xl px-6 py-4">
          {/* Row 1: brand + actions */}
          <div className="flex items-center gap-3">
            <Image src={LOGO_SRC} alt="Cachey" width={34} height={34} className="rounded-full" />
            <div className="min-w-0">
              <div className="font-semibold text-lg text-white leading-tight">
                Cachey <span className="text-gray-400">🤖</span>
              </div>
              <div className="text-xs text-gray-400">Deterministic triage • ClickHouse path</div>
            </div>

            <div className="ml-auto flex items-center gap-2">
              <button
                type="button"
                onClick={() => setFiltersOpen((v) => !v)}
                className={`rounded-full border border-white/10 px-4 py-2 text-sm text-gray-100 hover:bg-white/15 ${
                  filtersOpen ? "bg-white/15" : "bg-white/10"
                }`}
                title="Filters"
              >
                Filters{filtersDirty ? <span className="ml-2 text-[11px] text-amber-300">(draft)</span> : null}
              </button>

              <a
                href="/debug"
                className="rounded-full border border-white/10 bg-white/10 px-4 py-2 text-sm text-gray-100 hover:bg-white/15"
                title="Legacy /debug page"
              >
                Debug
              </a>
            </div>
          </div>

          {/* Row 2: compact applied chips + Run */}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {appliedChips.map((c) => (
              <span key={c.k} className="text-xs px-2.5 py-1 rounded-full border border-white/10 bg-white/5 text-gray-200">
                <span className="text-gray-500 mr-1">{c.k}</span>
                <span className="font-semibold">{c.v}</span>
              </span>
            ))}

            <div className="ml-auto flex items-center gap-2">
              <button
                type="button"
                onClick={() => setRunLogOpen((v) => !v)}
                className="rounded-full border border-white/10 bg-white/5 px-3 py-2 text-xs text-gray-200 hover:bg-white/10"
                title="Run log"
              >
                Log
              </button>

              <button
                type="button"
                onClick={handleRunFromFilters}
                disabled={isLoading || !partner || !service}
                className="rounded-xl px-4 py-2 text-sm font-semibold bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
                title="Run triage using the applied filters"
              >
                {isTriageLoading ? "Running..." : "Run"}
              </button>
            </div>
          </div>

          {/* Row 3: Filters panel (collapsible) */}
          {filtersOpen ? (
            <div className="mt-4 rounded-2xl border border-white/10 bg-white/5 p-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-sm font-semibold text-white">Filters</div>
                  <div className="text-xs text-gray-400 mt-1">
                    Select values, then hit <span className="text-gray-200">Apply</span>. Run executes triage.
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      // reset drafts to applied
                      setDraftService(service);
                      setDraftRegion(region);
                      setDraftPop(pop);
                      setDraftWindowMinutes(windowMinutes);
                      setDraftContentType(contentType);
                      setDraftUaFamily(uaFamily);
                      setFiltersDirty(false);
                    }}
                    className="rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-xs hover:bg-white/10"
                  >
                    Reset draft
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
                {/* Partner */}
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

                {/* Service (draft) */}
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

                {/* Region (draft) */}
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

                {/* POP (draft) */}
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

                {/* Window (draft) */}
                <div className="min-w-0">
                  <div className="text-xs text-gray-400 mb-1">Window</div>
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
                        {m}m
                      </option>
                    ))}
                  </select>
                </div>

                {/* contentType (draft) */}
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

                {/* uaFamily (draft) */}
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
                <div className="text-xs text-gray-400">Apply updates the chips (top bar). Run executes triage using applied filters.</div>

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

          {/* Run log (collapsible) */}
          {runLogOpen ? (
            <div className="mt-4 rounded-2xl border border-white/10 bg-black/40 p-4">
              <div className="flex items-center justify-between">
                <div className="text-sm font-semibold text-white">Run log</div>
                <button
                  className="rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs hover:bg-white/10"
                  onClick={() => setRunLog([])}
                  type="button"
                >
                  Clear
                </button>
              </div>
              <div className="mt-3 max-h-[200px] overflow-auto rounded-xl border border-white/10 bg-black/30 p-3">
                {runLog.length ? (
                  <div className="space-y-2">
                    {runLog
                      .slice()
                      .reverse()
                      .map((x, idx) => (
                        <div key={`${x.ts}-${idx}`} className="text-xs text-gray-300">
                          <span className="text-gray-500 mr-2">{formatUtcYmdHm(x.ts)}</span>
                          {x.text}
                        </div>
                      ))}
                  </div>
                ) : (
                  <div className="text-xs text-gray-500">No runs yet.</div>
                )}
              </div>
            </div>
          ) : null}
        </div>
      </div>

      {/* Body */}
      <div className="mx-auto max-w-6xl px-6 py-6">
        {/* Partner/service missing banner */}
        {partnerMissing || serviceMissing ? (
          <div className="mb-4 rounded-2xl border border-amber-400/20 bg-amber-400/10 p-4">
            <div className="text-sm font-semibold text-amber-200">Required filters missing</div>
            <div className="text-xs text-amber-100/80 mt-1">
              {partnerMissing ? "Pick a partner" : null}
              {partnerMissing && serviceMissing ? " and " : null}
              {serviceMissing ? "pick a service (Filters → Apply)" : null} in the top bar to run triage.
            </div>
          </div>
        ) : null}

        {/* Chat surface */}
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
                        {mounted ? new Date(m.ts).toLocaleString() : m.ts}
                      </div>

                      {m.type === "text" ? (
                        <div className={`rounded-2xl border ${bubbleStyle} px-4 py-3`}>
                          <pre className="whitespace-pre-wrap text-sm leading-relaxed">{m.text}</pre>
                        </div>
                      ) : (
                        // @ts-ignore
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
                      {mounted ? new Date().toLocaleString() : nowIso()}
                    </div>
                    <div className="rounded-2xl border border-white/10 bg-white/5 px-4 py-3">
                      <TypingDots />
                    </div>
                  </div>
                </div>
              ) : null}
            </div>
          </div>

          {/* Composer */}
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
              placeholder="Type anything (logged) → runs triage using applied filters"
              className="flex-1 rounded-2xl border border-white/10 bg-white/10 px-4 py-3 text-sm text-white placeholder-gray-400 outline-none focus:ring-2 focus:ring-blue-500/40"
              disabled={isLoading}
            />
            <button
              onClick={handleSend}
              disabled={isLoading || !chatInput.trim()}
              className="rounded-2xl px-5 py-3 text-sm font-semibold bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isLoading ? "Running..." : "Run"}
            </button>
          </div>

          <div className="mt-2 text-xs text-gray-500">Send/Enter logs your message and runs deterministic triage using applied filters.</div>
        </div>
      </div>
    </main>
  );
}
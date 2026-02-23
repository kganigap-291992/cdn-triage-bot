"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";
import type { TriageResponse } from "@/lib/triage/contracts";

// ------------------------------------------------------------
// Home page (/) — Chat-first, dark theme, ClickHouse-first
// Keeps /debug as legacy page (unchanged).
// Keeps /demo unchanged.
// Keeps /api/triage unchanged.
// ------------------------------------------------------------

const LOGO_SRC = "/cachey-logo.png";
const PARTNER_KEY = "cdn-triage-partner-v1";

const PARTNER_OPTIONS = [
  "acme_media",
  "beta_stream",
  "charlie_video",
  "delta_tv",
  "echo_entertainment",
] as const;

type Partner = (typeof PARTNER_OPTIONS)[number];
type PartnerOrMissing = Partner | "";

type DataSource = "clickhouse";
type ChatMode = "deterministic" | "llm";

type TriageInputs = {
  dataSource: DataSource;
  partner: PartnerOrMissing;
  service: string;
  region: string;
  pop: string;
  windowMinutes: number;
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
  const maxBars =
    windowMinutes <= 180 ? 60 : windowMinutes <= 1440 ? 144 : 180;
  const basePoints = (ts.points || []).slice(-maxBars);
  const [zoom, setZoom] = useState<{ start: number; end: number } | null>(null);

  const points =
    zoom && zoom.end > zoom.start
      ? basePoints.slice(zoom.start, zoom.end + 1)
      : basePoints;

  const svgRef = useRef<SVGSVGElement | null>(null);
  const [drag, setDrag] = useState<{ active: boolean; x0: number; x1: number }>(
    { active: false, x0: 0, x1: 0 }
  );

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

  const ordered = [
    ...seriesKeys.filter((k) => present.has(k)),
    ...presentKeys.filter((k) => !seriesKeys.includes(k)),
  ];

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
  const barW = Math.max(
    4,
    Math.floor((plotW - gap * (barCount - 1)) / barCount)
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
              ? `${formatUtcYmdHm(ts.startTs)} → ${formatUtcYmdHm(
                  ts.endTs
                )} UTC (bucket: ${bucketLabel(bucketSeconds)})`
              : `bucket: ${bucketLabel(bucketSeconds)} (UTC)`}
          </div>
          <div className="text-[11px] text-gray-500 mt-1">
            Drag to zoom • double-click to reset
            {zoom ? (
              <button
                type="button"
                className="ml-2 underline hover:text-gray-300"
                onClick={() => setZoom(null)}
              >
                reset zoom
              </button>
            ) : null}
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
          {/* Axis labels */}
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

          {/* Grid + y ticks */}
          {tickVals.map((v, idx) => {
            const t = v / maxTotal;
            const y = padTop + (1 - t) * plotH;
            return (
              <g key={idx} opacity={0.35}>
                <line
                  x1={padLeft}
                  y1={y}
                  x2={padLeft + plotW}
                  y2={y}
                  stroke="currentColor"
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

          {/* Bars */}
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

          {/* X labels */}
          {points.map((p, i) => {
            const show = i % xLabelEvery === 0 || i === points.length - 1;
            if (!show) return null;
            const x = padLeft + i * (barW + gap) + barW / 2;
            const label = timeLabelShort(p.ts, windowMinutes);
            return (
              <text
                key={`xl-${p.ts}`}
                x={x}
                y={padTop + plotH + 18}
                fontSize="10"
                fill="#9ca3af"
                textAnchor="middle"
              >
                {label}
              </text>
            );
          })}

          {/* Drag selection */}
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
              <span
                className="inline-block h-2.5 w-2.5 rounded-full"
                style={{ background: stableColorForKey(k) }}
              />
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
  const maxBars =
    windowMinutes <= 180 ? 60 : windowMinutes <= 1440 ? 144 : 180;
  const base = points.slice(-maxBars);

  const [zoom, setZoom] = useState<{ start: number; end: number } | null>(null);
  const slice =
    zoom && zoom.end > zoom.start ? base.slice(zoom.start, zoom.end + 1) : base;

  const svgRef = useRef<SVGSVGElement | null>(null);
  const [drag, setDrag] = useState<{ active: boolean; x0: number; x1: number }>(
    { active: false, x0: 0, x1: 0 }
  );

  if (!slice.length) return null;

  const vals: number[] = [];
  for (const p of slice) {
    if (p.p95TtmsMs != null && Number.isFinite(p.p95TtmsMs))
      vals.push(Number(p.p95TtmsMs));
    if (p.p99TtmsMs != null && Number.isFinite(p.p99TtmsMs))
      vals.push(Number(p.p99TtmsMs));
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
  const tickVals = Array.from({ length: yTicks + 1 }, (_, i) =>
    Math.round(minV + (span * (yTicks - i)) / yTicks)
  );

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
          <div className="text-sm font-semibold text-gray-100">
            p95 / p99 TTMS
          </div>
          <div className="text-[11px] text-gray-400 mt-1">
            {slice.length
              ? `${formatUtcYmdHm(slice[0].ts)} → ${formatUtcYmdHm(
                  slice[slice.length - 1].ts
                )} UTC (bucket: ${bucketLabel(bucketSeconds)})`
              : `bucket: ${bucketLabel(bucketSeconds)} (UTC)`}
          </div>
          <div className="text-[11px] text-gray-500 mt-1">
            Drag to zoom • double-click to reset
            {zoom ? (
              <button
                type="button"
                className="ml-2 underline hover:text-gray-300"
                onClick={() => setZoom(null)}
              >
                reset zoom
              </button>
            ) : null}
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
            const t = (v - minV) / span;
            const yy = padTop + (1 - t) * plotH;
            return (
              <g key={idx} opacity={0.35}>
                <line
                  x1={padLeft}
                  y1={yy}
                  x2={padLeft + plotW}
                  y2={yy}
                  stroke="currentColor"
                />
                <text
                  x={padLeft - 10}
                  y={yy + 3}
                  fontSize="10"
                  fill="#9ca3af"
                  textAnchor="end"
                  opacity={0.95}
                >
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
              <text
                key={`xl-${p.ts}`}
                x={xx}
                y={padTop + plotH + 18}
                fontSize="10"
                fill="#9ca3af"
                textAnchor="middle"
              >
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
            <span
              className="inline-block h-2.5 w-2.5 rounded-full"
              style={{ background: "rgba(37,99,235,0.92)" }}
            />
            <span>p95</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span
              className="inline-block h-2.5 w-2.5 rounded-full"
              style={{ background: "rgba(17,24,39,0.55)" }}
            />
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
  const [partner, setPartner] = useState<PartnerOrMissing>("beta_stream");
  function setPartnerSticky(p: string) {
    const v = String(p || "").trim();
    if (!v) return;
    if ((PARTNER_OPTIONS as readonly string[]).includes(v)) {
      setPartner(v as Partner);
      safeSetLS(PARTNER_KEY, v);
    }
  }

  // chat mode
  const [chatMode, setChatMode] = useState<ChatMode>("deterministic");

  // UI state
  const [isLoading, setIsLoading] = useState(false);
  const [schemaOpen, setSchemaOpen] = useState(false);

  // Chat
  const [chatInput, setChatInput] = useState("");
  const [chatMessages, setChatMessages] = useState<ChatMsg[]>([]);
  const chatScrollRef = useRef<HTMLDivElement | null>(null);
  const lastMsgIdRef = useRef<string | null>(null);

  // typing indicator (assistant bubble)
  const [typing, setTyping] = useState(false);

  // rate limit banner state
  const [rateLimit, setRateLimit] = useState<null | {
    msgId: string;
    untilMs: number;
    retryAfterMs: number;
    lastUserText: string;
  }>(null);
  const [rateLimitRemainingMs, setRateLimitRemainingMs] = useState<number>(0);

  // current filters (kept minimal on home)
  const [service, setService] = useState("all");
  const [region, setRegion] = useState("all");
  const [pop, setPop] = useState("all");
  const [windowMinutes, setWindowMinutes] = useState(120);

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (!mounted) return;
    const saved = safeGetLS(PARTNER_KEY);
    if (saved && (PARTNER_OPTIONS as readonly string[]).includes(saved)) {
      setPartner(saved as Partner);
    }
  }, [mounted]);

  function clearRateLimit() {
    setRateLimit(null);
    setRateLimitRemainingMs(0);
  }

  function fmtCountdown(ms: number) {
    const s = Math.max(0, Math.ceil(ms / 1000));
    return `${s}s`;
  }

  useEffect(() => {
    if (!rateLimit) return;
    const tick = () => {
      const left = Math.max(0, rateLimit.untilMs - Date.now());
      setRateLimitRemainingMs(left);
    };
    tick();
    const id = setInterval(tick, 250);
    return () => clearInterval(id);
  }, [rateLimit]);

  // welcome message once (NO personal greeting)
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
          "Cachey 🤖 — chat-first triage.\n\n" +
          "Pick a partner (sticky), then ask:\n" +
          "- `how was live last 2h`\n" +
          "- `vod in bos last night`\n\n" +
          "Triage results render inline as cards.",
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

  // Derive available regions/pops from last triage card (if any)
  const lastMetricsJson = useMemo(() => {
    const lastTriage = [...chatMessages].reverse().find((m) => m.type === "triage") as
      | ChatTriage
      | undefined;
    return lastTriage?.run?.metricsJson || null;
  }, [chatMessages]);

  const availableRegions: string[] = useMemo(() => {
    const arr = lastMetricsJson?.available?.regions;
    const list = Array.isArray(arr) ? arr : [];
    const cleaned = list
      .map((x: any) => String(x ?? "").trim().toLowerCase())
      .filter(Boolean);
    const uniq = Array.from(new Set(cleaned)).sort((a, b) => a.localeCompare(b));
    return ["all", ...uniq];
  }, [lastMetricsJson]);

  const availablePops: string[] = useMemo(() => {
    const arr = lastMetricsJson?.available?.pops;
    const list = Array.isArray(arr) ? arr : [];
    const cleaned = list
      .map((x: any) => String(x ?? "").trim().toLowerCase())
      .filter(Boolean);
    const uniq = Array.from(new Set(cleaned)).sort((a, b) => a.localeCompare(b));
    return ["all", ...uniq];
  }, [lastMetricsJson]);

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
      statusCodeSeries: Array.isArray(t.statusCodeSeries)
        ? t.statusCodeSeries.map(String)
        : undefined,
      hostSeries: Array.isArray(t.hostSeries) ? t.hostSeries.map(String) : undefined,
      crcSeries: Array.isArray(t.crcSeries) ? t.crcSeries.map(String) : undefined,
    };
  }

  // /api/triage call (unchanged backend)
  async function runTriage(inputs: TriageInputs) {
    const formData = new FormData();
    formData.append("dataSource", inputs.dataSource);
    formData.append("partner", inputs.partner || "");
    formData.append("csvUrl", "");
    formData.append("service", inputs.service);
    formData.append("region", inputs.region);
    formData.append("pop", inputs.pop);
    formData.append("windowMinutes", String(inputs.windowMinutes));

    const response = await fetch("/api/triage", { method: "POST", body: formData });

    const data = (await response.json().catch(() => null)) as TriageResponse | null;

    if (!response.ok || !data?.ok) {
      throw new Error(data?.error || `Triage failed (HTTP ${response.status})`);
    }

    return {
      summaryText: data.summaryText ?? data.summary ?? "",
      metricsJson: data.metricsJson ?? null,
    };
  }

  // /api/chat call
  async function callChatApi(userText: string) {
    const wireMsgs = chatMessages
      .filter((m): m is ChatText => m.type === "text")
      .slice(-12)
      .map((m) => ({ role: m.role, content: m.text }));

    wireMsgs.push({ role: "user", content: userText });

    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: wireMsgs,
        context: {
          mode: "clickhouse",
          chatMode,
          availableRegions,
          availablePops,
          availablePartners: Array.from(PARTNER_OPTIONS),
          currentFilters: {
            dataSource: "clickhouse",
            partner,
            service,
            region,
            pop,
            windowMinutes,
          },
        },
      }),
    });

    const json = await res.json().catch(() => null);
    if (!json) throw new Error("api/chat returned non-JSON");
    return json as any;
  }

  // add message helpers
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

  async function sendUserText(userText: string, opts?: { appendUser?: boolean }) {
    const appendUser = opts?.appendUser !== false;
    if (!userText.trim() || isLoading) return;

    setIsLoading(true);
    setTyping(true);

    if (appendUser) {
      const userMsg: ChatText = {
        id: `${Date.now()}-${Math.random()}`,
        type: "text",
        role: "user",
        ts: nowIso(),
        text: userText,
      };
      setChatMessages((prev) => [...prev, userMsg]);
    }

    if (!partner) {
      addText("assistant", `Pick a partner first. (${PARTNER_OPTIONS.join(", ")})`);
      setTyping(false);
      setIsLoading(false);
      return;
    }

    try {
      const out = await callChatApi(userText);

      // Rate limit banner path (from your route.ts)
      if (out?.rateLimited) {
        const assistantId = addText(
          "assistant",
          String(out?.reply || "LLM is rate-limited. Try again shortly or switch to Deterministic.")
        );
        const retryAfter = Number(out?.retryAfterMs ?? 45000);
        const untilMs = Date.now() + (Number.isFinite(retryAfter) ? retryAfter : 45000);
        setRateLimit({
          msgId: assistantId,
          untilMs,
          retryAfterMs: retryAfter,
          lastUserText: userText,
        });
        setTyping(false);
        setIsLoading(false);
        return;
      }

      // general
      if (out?.kind === "general") {
        addText("assistant", String(out.reply || "Got it."));
        clearRateLimit();
        setTyping(false);
        setIsLoading(false);
        return;
      }

      // triage: update hints if present
      const nextService = String(out?.serviceHint ?? service);
      const nextRegion = String(out?.regionHint ?? region);
      const nextPop = String(out?.popHint ?? pop);
      const nextWindow = Number(out?.windowHint ?? windowMinutes);

      if (out?.serviceHint) setService(nextService);
      if (out?.regionHint) setRegion(nextRegion);
      if (out?.popHint) setPop(nextPop);
      if (Number.isFinite(nextWindow) && nextWindow > 0) setWindowMinutes(nextWindow);

      const pHint = String(out?.partnerHint || "").trim();
      if (pHint && (PARTNER_OPTIONS as readonly string[]).includes(pHint)) {
        setPartnerSticky(pHint);
      }

      if (out?.needsPartnerQuestion) {
        addText("assistant", String(out.partnerQuestion || "Which partner?"));
        clearRateLimit();
        setTyping(false);
        setIsLoading(false);
        return;
      }

      addText(
        "system",
        `Running triage: partner=${partner} svc=${nextService} region=${nextRegion} pop=${nextPop} win=${nextWindow}m`
      );

      const data = await runTriage({
        dataSource: "clickhouse",
        partner,
        service: nextService,
        region: nextRegion,
        pop: nextPop,
        windowMinutes:
          Number.isFinite(nextWindow) && nextWindow > 0 ? nextWindow : windowMinutes,
      });

      addTriageCard({
        inputs: {
          dataSource: "clickhouse",
          partner,
          service: nextService,
          region: nextRegion,
          pop: nextPop,
          windowMinutes:
            Number.isFinite(nextWindow) && nextWindow > 0 ? nextWindow : windowMinutes,
        },
        summaryText: data.summaryText || "",
        metricsJson: data.metricsJson || null,
      });

      clearRateLimit();
    } catch (e: any) {
      const msg = e?.message || "Chat/Triage failed";
      addText(
        "assistant",
        `Chat failed: ${msg}\n\nIf LLM is down, switch to Deterministic and run:\n- \`live in usw2 at sjc last 2h\`\n- \`service=vod win=720\``
      );
    } finally {
      setTyping(false);
      setIsLoading(false);
    }
  }

  async function handleSend() {
    const text = chatInput.trim();
    if (!text) return;
    setChatInput("");
    await sendUserText(text, { appendUser: true });
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

  function TriageCard({ run }: { run: ChatTriage["run"] }) {
    const ts = parseTimeseries(run.metricsJson);
    const bucketSeconds = ts?.bucketSeconds ?? run.metricsJson?.timeseries?.bucketSeconds ?? null;

    return (
      <div className="triage-enter rounded-2xl border border-white/10 bg-white/5 backdrop-blur p-4 shadow-[0_0_0_1px_rgba(255,255,255,0.04)] space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-xs text-gray-400">Triage result</div>
            <div className="text-sm font-semibold text-gray-100 truncate">
              partner={run.inputs.partner} • svc={run.inputs.service} • region={run.inputs.region} • pop={run.inputs.pop} • win={run.inputs.windowMinutes}m
            </div>
          </div>
          <div className="text-xs text-gray-500">/api/triage</div>
        </div>

        <MetricChips metricsJson={run.metricsJson} />

        <div className="rounded-xl border border-white/10 bg-black/30 p-3">
          <div className="text-xs text-gray-400 mb-2">Summary</div>
          <pre className="whitespace-pre-wrap text-sm text-gray-100/90 leading-relaxed">
            {run.summaryText || "(no summary)"}
          </pre>
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
            <LatencyTimeseriesLines
              points={ts.points}
              bucketSeconds={bucketSeconds}
              height={190}
              windowMinutes={run.inputs.windowMinutes}
            />
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
          <div className="text-sm text-gray-400">No timeseries returned.</div>
        )}

        <details className="rounded-xl border border-white/10 bg-black/20 p-3">
          <summary className="cursor-pointer text-sm text-gray-200">
            Evidence (placeholder)
          </summary>
          <div className="text-xs text-gray-400 mt-2">
            Placeholder for deterministic trace / evidence list.
          </div>
        </details>

        <details className="rounded-xl border border-white/10 bg-black/20 p-3">
          <summary className="cursor-pointer text-sm text-gray-200">
            SQL Query (placeholder)
          </summary>
          <div className="text-xs text-gray-400 mt-2">
            Placeholder for SQL text + copy button.
          </div>
        </details>

        {/* local CSS for triage card entrance */}
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

  return (
    <main className="min-h-screen bg-black text-gray-100">
      {/* Sticky header */}
      <div className="sticky top-0 z-50 border-b border-white/10 bg-black/70 backdrop-blur">
        <div className="mx-auto max-w-6xl px-6 py-4 flex items-center gap-3">
          <Image
            src={LOGO_SRC}
            alt="Cachey"
            width={34}
            height={34}
            className="rounded-full"
          />
          <div className="min-w-0">
            <div className="font-semibold text-lg text-white">
              Cachey <span className="text-gray-400">🤖</span>
            </div>
            <div className="text-xs text-gray-400">Chat-first triage</div>
          </div>

          <div className="ml-auto flex items-center gap-3">
            {/* Partner selector */}
            <div className="flex items-center gap-2">
              <div className="text-xs text-gray-400">Partner</div>
              <select
                className="rounded-lg border border-white/10 bg-white/10 text-gray-100 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500/40"
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

            {/* Schema helper */}
            <button
              type="button"
              onClick={() => setSchemaOpen(true)}
              className="rounded-full border border-white/10 bg-white/10 px-4 py-2 text-sm text-gray-100 hover:bg-white/15"
              title="Schema helper"
            >
              Schema
            </button>

            {/* Chat mode toggle */}
            <div className="inline-flex rounded-full border border-white/10 bg-white/5 p-1">
              <button
                type="button"
                onClick={() => {
                  setChatMode("deterministic");
                  clearRateLimit();
                }}
                className={`px-3 py-1 text-xs rounded-full ${
                  chatMode === "deterministic"
                    ? "bg-white/15 text-white"
                    : "text-gray-300 hover:text-white"
                }`}
              >
                Deterministic
              </button>
              <button
                type="button"
                onClick={() => setChatMode("llm")}
                className={`px-3 py-1 text-xs rounded-full ${
                  chatMode === "llm"
                    ? "bg-white/15 text-white"
                    : "text-gray-300 hover:text-white"
                }`}
              >
                LLM
              </button>
            </div>

            <a
              href="/debug"
              className="rounded-full border border-white/10 bg-white/10 px-4 py-2 text-sm text-gray-100 hover:bg-white/15"
              title="Legacy /debug page"
            >
              Debug
            </a>
          </div>
        </div>
      </div>

      {/* Body */}
      <div className="mx-auto max-w-6xl px-6 py-6">
        {/* Partner missing banner */}
        {partnerMissing ? (
          <div className="mb-4 rounded-2xl border border-amber-400/20 bg-amber-400/10 p-4">
            <div className="text-sm font-semibold text-amber-200">
              Partner required
            </div>
            <div className="text-xs text-amber-100/80 mt-1">
              Pick a partner in the top bar to run ClickHouse triage.
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

                // bubble widths: assistant wider than user
                const bubbleMax =
                  isUser ? "max-w-[70%]" : "max-w-[82%]";

                // alignment: assistant left, user right. system centered
                const rowAlign = isSystem
                  ? "justify-center"
                  : isUser
                  ? "justify-end"
                  : "justify-start";

                const bubbleStyle = isSystem
                  ? "border-white/10 bg-white/5 text-gray-300"
                  : isUser
                  ? "border-white/10 bg-white/10 text-gray-100"
                  : "border-white/10 bg-white/5 text-gray-100";

                return (
                  <div key={m.id} className={`flex ${rowAlign}`}>
                    <div className={`${bubbleMax} w-full`}>
                      {/* tiny timestamp only (no User:/Assistant:) */}
                      <div
                        className={`text-[10px] text-gray-500 mb-1 ${
                          isSystem ? "text-center" : isUser ? "text-right" : "text-left"
                        }`}
                      >
                        {mounted ? new Date(m.ts).toLocaleString() : m.ts}
                      </div>

                      {m.type === "text" ? (
                        <div
                          className={`rounded-2xl border ${bubbleStyle} px-4 py-3`}
                        >
                          <pre className="whitespace-pre-wrap text-sm leading-relaxed">
                            {m.text}
                          </pre>

                          {/* inline rate-limit banner under assistant bubble */}
                          {rateLimit && m.id === rateLimit.msgId ? (
                            <div className="mt-3 rounded-xl border border-white/10 bg-black/20 px-3 py-2">
                              <div className="text-xs text-gray-200">
                                LLM is rate-limited. Retrying in{" "}
                                <span className="font-semibold">
                                  {fmtCountdown(rateLimitRemainingMs)}
                                </span>{" "}
                                or switch to Deterministic.
                              </div>
                              <div className="mt-2 flex gap-2">
                                <button
                                  type="button"
                                  onClick={async () => {
                                    await sendUserText(rateLimit.lastUserText, {
                                      appendUser: false,
                                    });
                                  }}
                                  className="rounded-lg border border-white/10 bg-white/10 px-3 py-1.5 text-xs hover:bg-white/15 disabled:opacity-50"
                                  disabled={isLoading}
                                >
                                  Retry now
                                </button>
                                <button
                                  type="button"
                                  onClick={() => {
                                    setChatMode("deterministic");
                                    clearRateLimit();
                                    addText(
                                      "assistant",
                                      "Switched to Deterministic. Try the same query again."
                                    );
                                  }}
                                  className="rounded-lg border border-white/10 bg-white/10 px-3 py-1.5 text-xs hover:bg-white/15"
                                >
                                  Switch to Deterministic
                                </button>
                              </div>
                            </div>
                          ) : null}
                        </div>
                      ) : (
                        <TriageCard run={m.run} />
                      )}
                    </div>
                  </div>
                );
              })}

              {/* typing indicator bubble (assistant, left) */}
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
              placeholder="Try: live in bos last 2h"
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

          <div className="mt-2 text-xs text-gray-500">
            Enter sends • Results appear inline as cards • Evidence/SQL are placeholders
          </div>
        </div>
      </div>

      {/* Schema modal (placeholder) */}
      {schemaOpen ? (
        <div className="fixed inset-0 z-[100] bg-black/70 backdrop-blur-sm flex items-center justify-center p-6">
          <div className="w-full max-w-2xl rounded-3xl border border-white/10 bg-[#0b0b0b] p-6">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-lg font-semibold text-white">Schema helper</div>
                <div className="text-sm text-gray-400 mt-1">
                  Contract / fields / examples (placeholder).
                </div>
              </div>
              <button
                onClick={() => setSchemaOpen(false)}
                className="rounded-full border border-white/10 bg-white/10 px-4 py-2 text-sm hover:bg-white/15"
              >
                Close
              </button>
            </div>

            <div className="mt-4 rounded-2xl border border-white/10 bg-white/5 p-4 text-sm text-gray-200">
              <div className="text-xs text-gray-400 mb-2">Coming soon</div>
              <ul className="list-disc ml-5 space-y-1 text-gray-200/90">
                <li>Partner + service/region/pop definitions</li>
                <li>CRC glossary shortcuts</li>
                <li>Example prompts + filter syntax</li>
              </ul>
            </div>
          </div>
        </div>
      ) : null}
    </main>
  );
}

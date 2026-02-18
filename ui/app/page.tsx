"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";

// ------------------------------------------------------------
// Home Page Day: Chat-first UI with inline triage cards
// - Sticky partner selector
// - Schema helper button (placeholder drawer)
// - Inline triage result cards: Summary + chips + graphs + Evidence/SQL expanders
// ------------------------------------------------------------

const LOGO_SRC = "/cachey-logo.png";
const PARTNER_KEY = "cdn-triage-partner-v1";
const CHAT_MODE_KEY = "cdn-triage-chatmode-v1";

// Home is ClickHouse-first today.
type DataSource = "clickhouse";
type ChatMode = "deterministic" | "llm";

const PARTNER_OPTIONS = [
  "acme_media",
  "beta_stream",
  "charlie_video",
  "delta_tv",
  "echo_entertainment",
] as const;

type Partner = (typeof PARTNER_OPTIONS)[number];
type PartnerOrMissing = Partner | "";

// ------------------------------------------------------------
// Types (minimal set for Home)
// ------------------------------------------------------------
type ChatTextMessage = {
  id: string;
  type: "text";
  role: "system" | "user" | "assistant";
  text: string;
  timestamp: string;
};

type ChatTriageMessage = {
  id: string;
  type: "triage_result";
  role: "assistant";
  timestamp: string;
  run: {
    inputs: {
      dataSource: DataSource;
      partner: PartnerOrMissing;
      service: string;
      region: string;
      pop: string;
      windowMinutes: number;
    };
    summaryText: string;
    metricsJson: any;
  };
};

type ChatMessage = ChatTextMessage | ChatTriageMessage;

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

// ------------------------------------------------------------
// LocalStorage helpers
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
// Utility
// ------------------------------------------------------------
function getCurrentTimestamp() {
  return new Date().toISOString();
}
function normalizeText(text: string): string {
  return (text || "").trim().toLowerCase();
}
function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}
function formatMsOrNA(x: number | null | undefined): string {
  if (x == null || !Number.isFinite(Number(x))) return "n/a";
  return `${Math.round(Number(x))} ms`;
}
function formatIntOrNA(x: number | null | undefined): string {
  if (x == null || !Number.isFinite(Number(x))) return "0";
  return `${Math.round(Number(x)).toLocaleString()}`;
}
function formatPctOrNA(x: number | null | undefined): string {
  if (x == null || !Number.isFinite(Number(x))) return "n/a";
  return `${Number(x).toFixed(2)}%`;
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

// ---- UTC format helpers reused by charts ----
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
function bucketLabel(bucketSeconds: number | null | undefined) {
  const s = Number(bucketSeconds || 0);
  if (!Number.isFinite(s) || s <= 0) return "bucket";
  if (s % 3600 === 0) return `${s / 3600}h`;
  if (s % 60 === 0) return `${s / 60}m`;
  return `${s}s`;
}

// stable palette for stacked charts
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
// Schema helper (placeholder drawer)
// ------------------------------------------------------------
function SchemaHelper({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[80]">
      <div
        className="absolute inset-0 bg-black/30"
        onClick={onClose}
        aria-hidden
      />
      <div className="absolute right-0 top-0 h-full w-full max-w-[420px] bg-white shadow-2xl border-l border-gray-200 p-5">
        <div className="flex items-center justify-between">
          <div className="text-sm font-semibold text-gray-900">Schema Helper</div>
          <button
            type="button"
            onClick={onClose}
            className="text-xs border border-gray-200 rounded-full px-3 py-1.5 hover:bg-gray-50"
          >
            Close
          </button>
        </div>

        <div className="mt-4 text-xs text-gray-600 space-y-3">
          <div className="rounded-lg border border-gray-200 bg-gray-50 p-3">
            <div className="font-semibold text-gray-900 text-xs">Telemetry Contract (placeholder)</div>
            <div className="mt-2 space-y-1">
              <div>• raw_minute (events)</div>
              <div>• buckets_5m (graph frame)</div>
              <div>• features_5m (model frame)</div>
              <div>• scores_zscore (later)</div>
            </div>
          </div>

          <div className="rounded-lg border border-amber-200 bg-amber-50 p-3">
            <div className="font-semibold text-amber-900 text-xs">Note</div>
            <div className="mt-2 text-amber-800">
              Today is UI pivot day — this helper becomes “real” once ClickHouse
              is wired to the canonical contract.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------
// Expandable section (Evidence / SQL placeholders)
// ------------------------------------------------------------
function Expander({
  title,
  children,
  defaultOpen = false,
}: {
  title: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="rounded-lg border border-gray-200 bg-white">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-3 py-2 text-xs font-semibold text-gray-800 hover:bg-gray-50"
      >
        <span>{title}</span>
        <span className="text-gray-500">{open ? "▲" : "▼"}</span>
      </button>
      {open ? <div className="px-3 pb-3 text-xs text-gray-700">{children}</div> : null}
    </div>
  );
}

// ------------------------------------------------------------
// Metric chips row (from metricsJson)
// ------------------------------------------------------------
function MetricChips({ metricsJson }: { metricsJson: any }) {
  const total = Number(metricsJson?.totalRequests) || 0;
  const p95 = metricsJson?.p95TtmsMs == null ? null : Number(metricsJson.p95TtmsMs);
  const p99 = metricsJson?.p99TtmsMs == null ? null : Number(metricsJson.p99TtmsMs);
  const e5 = metricsJson?.error5xxCount == null ? null : Number(metricsJson.error5xxCount);
  const er = metricsJson?.errorRatePct == null ? null : Number(metricsJson.errorRatePct);

  const chips: { k: string; v: string }[] = [
    { k: "requests", v: formatIntOrNA(total) },
    { k: "p95", v: formatMsOrNA(p95) },
    { k: "p99", v: formatMsOrNA(p99) },
    { k: "5xx", v: formatIntOrNA(e5) },
    { k: "5xx%", v: formatPctOrNA(er) },
  ];

  return (
    <div className="flex flex-wrap gap-2">
      {chips.map((c) => (
        <div
          key={c.k}
          className="text-[11px] px-2.5 py-1 rounded-full border border-gray-200 bg-gray-50 text-gray-700"
        >
          <span className="font-semibold text-gray-900">{c.k}</span>{" "}
          <span className="text-gray-600">{c.v}</span>
        </div>
      ))}
    </div>
  );
}

// ------------------------------------------------------------
// Triage Card (inline in chat)
// ------------------------------------------------------------
function TriageCard({ run }: { run: ChatTriageMessage["run"] }) {
  const metricsJson = run.metricsJson;

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
      .filter((pt) => Boolean(pt.ts));

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

  const bucketSeconds = ts?.bucketSeconds ?? metricsJson?.timeseries?.bucketSeconds ?? null;

  return (
    <div className="rounded-2xl border border-gray-200 bg-white shadow-sm p-4 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-xs text-gray-600">
          <span className="font-semibold text-gray-900">Triage</span>{" "}
          <span className="text-gray-500">
            partner={run.inputs.partner || "(missing)"} • svc={run.inputs.service} • region={run.inputs.region} • pop={run.inputs.pop} • win={run.inputs.windowMinutes}m
          </span>
        </div>
      </div>

      <div className="text-sm font-semibold text-gray-900">Summary</div>
      <pre className="whitespace-pre-wrap text-sm text-gray-800">{run.summaryText || "(no summary)"}</pre>

      <MetricChips metricsJson={metricsJson} />

      {/* Graphs */}
      {ts && ts.points.length > 0 ? (
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
          <StackedBarTimeseries
            title="Status codes (stacked)"
            subtitle="Traffic"
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
            title="Hosts (stacked)"
            subtitle="Traffic"
            ts={ts}
            bucketSeconds={bucketSeconds}
            seriesKeys={ts.hostSeries || []}
            getMap={(p) => p.hostCountsByHost}
            height={190}
            windowMinutes={run.inputs.windowMinutes}
          />
          <StackedBarTimeseries
            title="CRC codes (stacked)"
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
        <div className="rounded-lg border border-gray-200 bg-gray-50 p-3 text-sm text-gray-600">
          No timeseries to chart.
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <Expander title="Evidence (placeholder)">
          Coming soon — deterministic trace + evidence pointers.
        </Expander>
        <Expander title="SQL Query (placeholder)">
          Coming soon — copyable ClickHouse SQL used to compute these aggregates.
        </Expander>
      </div>
    </div>
  );
}

// ------------------------------------------------------------
// Charts (copied from your current page; unchanged behavior)
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
    for (const k of Object.keys(m)) present.set(k, (present.get(k) ?? 0) + Number(m[k] ?? 0));
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
              ? `${formatUtcYmdHm(slice[0].ts)} → ${formatUtcYmdHm(slice[slice.length - 1].ts)} UTC (bucket: ${bucketLabel(bucketSeconds)})`
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
// API calls (triage + chat) — unchanged endpoints
// ------------------------------------------------------------
async function runTriageRequest(inputs: {
  partner: PartnerOrMissing;
  service: string;
  region: string;
  pop: string;
  windowMinutes: number;
  debug: boolean;
}) {
  const formData = new FormData();
  formData.append("dataSource", "clickhouse");
  formData.append("partner", inputs.partner || "");
  formData.append("csvUrl", "");
  formData.append("service", inputs.service);
  formData.append("region", inputs.region);
  formData.append("pop", inputs.pop);
  formData.append("windowMinutes", String(inputs.windowMinutes));
  if (inputs.debug) formData.append("debug", "true");

  const response = await fetch("/api/triage", { method: "POST", body: formData });

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

async function callChatApi(args: {
  userText: string;
  history: ChatMessage[];
  partner: PartnerOrMissing;
  service: string;
  region: string;
  pop: string;
  windowMinutes: number;
  chatMode: ChatMode;
}) {
  const { userText, history, partner, service, region, pop, windowMinutes, chatMode } = args;

  const wireMsgs = history
    .filter((m): m is ChatTextMessage => m.type === "text")
    .slice(-12)
    .map((m) => ({ role: m.role, content: m.text }));

  if (wireMsgs.length === 0) wireMsgs.push({ role: "user", content: userText });
  else {
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
        availableRegions: [], // home does not show filters; chat route can still respond
        availablePops: [],
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

// ------------------------------------------------------------
// Main Home component
// ------------------------------------------------------------
export default function Home() {
  const [mounted, setMounted] = useState(false);

  // sticky partner
  const [partner, setPartner] = useState<PartnerOrMissing>("");

  // lightweight filter state (no UI for these today; chat drives them)
  const [service, setService] = useState("all");
  const [region, setRegion] = useState("all");
  const [pop, setPop] = useState("all");
  const [windowMinutes, setWindowMinutes] = useState(60);
  const [debugMode] = useState(false);

  // chat + state
  const [chatMode, setChatMode] = useState<ChatMode>("deterministic");
  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [chatInput, setChatInput] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const chatScrollRef = useRef<HTMLDivElement | null>(null);
  const lastMessageIdRef = useRef<string | null>(null);

  // schema helper
  const [schemaOpen, setSchemaOpen] = useState(false);

  useEffect(() => setMounted(true), []);

  // restore partner
  useEffect(() => {
    if (!mounted) return;
    const saved = safeGetLS(PARTNER_KEY);
    if (saved && (PARTNER_OPTIONS as readonly string[]).includes(saved)) {
      setPartner(saved as Partner);
    }
  }, [mounted]);

  // restore chatMode
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

  function welcome(): ChatTextMessage {
    return {
      id: "welcome",
      type: "text",
      role: "system",
      text:
        "Cachey 🤖 — chat-first triage.\n\n" +
        "Pick a partner (sticky), then ask:\n" +
        "- `how was live last 2h`\n" +
        "- `vod in bos last night`\n\n" +
        "Triage results will render inline as cards.",
      timestamp: getCurrentTimestamp(),
    };
  }

  useEffect(() => {
    if (!mounted) return;
    if (messages.length > 0) return;
    setMessages([welcome()]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mounted, messages.length]);

  useEffect(() => {
    const last = messages[messages.length - 1];
    if (!last) return;
    if (lastMessageIdRef.current !== last.id) {
      lastMessageIdRef.current = last.id;
      const el = chatScrollRef.current;
      if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    }
  }, [messages]);

  function addText(role: ChatTextMessage["role"], text: string) {
    setMessages((prev) => [
      ...prev,
      { id: `${Date.now()}-${Math.random()}`, type: "text", role, text, timestamp: getCurrentTimestamp() },
    ]);
  }
  function addTriage(run: ChatTriageMessage["run"]) {
    setMessages((prev) => [
      ...prev,
      { id: `${Date.now()}-${Math.random()}`, type: "triage_result", role: "assistant", timestamp: getCurrentTimestamp(), run },
    ]);
  }

  const partnerMissing = !partner;

  async function onSend() {
    const text = chatInput.trim();
    if (!text || isLoading) return;

    setChatInput("");
    setErrorMessage("");

    const userMsg: ChatTextMessage = {
      id: `${Date.now()}-${Math.random()}`,
      type: "text",
      role: "user",
      text,
      timestamp: getCurrentTimestamp(),
    };

    const nextHistory = [...messages, userMsg];
    setMessages(nextHistory);

    // If deterministic and partner missing, hard-stop nicely
    if (partnerMissing && chatMode !== "llm") {
      addText(
        "assistant",
        `ClickHouse mode needs a partner first.\nPick one: ${PARTNER_OPTIONS.join(", ")}`
      );
      return;
    }

    setIsLoading(true);
    try {
      // Ask chat route for hints (LLM or deterministic depending on ctx.chatMode)
      const out = await callChatApi({
        userText: text,
        history: nextHistory,
        partner,
        service,
        region,
        pop,
        windowMinutes,
        chatMode,
      });

      if (out?.kind === "general") {
        addText("assistant", String(out.reply || "Ok."));
        return;
      }

      // Partner question handling
      if (!partner && out?.needsPartnerQuestion) {
        addText("assistant", String(out.partnerQuestion || "Which partner?"));
        return;
      }

      // Apply hints (sticky)
      const nextService = String(out?.serviceHint ?? service);
      const nextRegion = String(out?.regionHint ?? region);
      const nextPop = String(out?.popHint ?? pop);
      const nextWindow = Number(out?.windowHint ?? windowMinutes);

      setService(nextService);
      setRegion(nextRegion);
      setPop(nextPop);
      if (Number.isFinite(nextWindow) && nextWindow > 0) setWindowMinutes(nextWindow);

      let nextPartner: PartnerOrMissing = partner;
      const pHint = String(out?.partnerHint || "").trim();
      if (pHint && (PARTNER_OPTIONS as readonly string[]).includes(pHint)) {
        setPartnerSticky(pHint);
        nextPartner = pHint as Partner;
      }

      // still missing partner -> stop
      if (!nextPartner) {
        addText("assistant", `Pick a partner to run triage: ${PARTNER_OPTIONS.join(", ")}`);
        return;
      }

      addText(
        "system",
        `Running triage • partner=${nextPartner} • svc=${nextService} • region=${nextRegion} • pop=${nextPop} • win=${nextWindow}m`
      );

      const data = await runTriageRequest({
        partner: nextPartner,
        service: nextService,
        region: nextRegion,
        pop: nextPop,
        windowMinutes: nextWindow,
        debug: debugMode,
      });

      addTriage({
        inputs: {
          dataSource: "clickhouse",
          partner: nextPartner,
          service: nextService,
          region: nextRegion,
          pop: nextPop,
          windowMinutes: nextWindow,
        },
        summaryText: data.summaryText || "",
        metricsJson: data.metricsJson || null,
      });
    } catch (e: any) {
      const msg = e?.message || "Something went wrong";
      setErrorMessage(msg);
      addText("assistant", `Error: ${msg}`);
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <main className="min-h-screen w-full bg-gray-50">
      <SchemaHelper open={schemaOpen} onClose={() => setSchemaOpen(false)} />

      {/* Sticky header */}
      <div className="sticky top-0 z-[60] border-b border-gray-200 bg-white/95 backdrop-blur">
        <div className="mx-auto w-full px-6 py-4 flex items-center gap-3">
          <Image src={LOGO_SRC} alt="Cachey" width={34} height={34} className="rounded-full" />

          <div className="min-w-0">
            <div className="font-semibold text-lg text-gray-900">
              Cachey <span className="text-gray-500">🤖</span>
            </div>
            <div className="text-xs text-gray-500">Chat-first triage (home)</div>
          </div>

          <div className="ml-auto flex items-center gap-2">
            {/* Sticky partner selector */}
            <div className="flex items-center gap-2">
              <div className="text-[11px] text-gray-500">Partner</div>
              <select
                className="rounded-lg border border-gray-300 bg-white text-gray-900 px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                value={partner}
                onChange={(e) => setPartnerSticky(e.target.value)}
                disabled={isLoading}
              >
                <option value="">Select…</option>
                {PARTNER_OPTIONS.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </div>

            {/* Schema helper button */}
            <button
              type="button"
              onClick={() => setSchemaOpen(true)}
              className="text-sm font-semibold rounded-lg border border-gray-200 bg-white px-3 py-2 hover:bg-gray-50"
            >
              Schema
            </button>

            {/* Chat mode toggle (small, keeps behavior consistent) */}
            <div className="inline-flex rounded-lg border border-gray-200 bg-gray-50 p-0.5">
              <button
                type="button"
                onClick={() => setChatMode("deterministic")}
                className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors ${
                  chatMode === "deterministic" ? "bg-white text-gray-900 shadow-sm" : "text-gray-600 hover:text-gray-900"
                }`}
                disabled={isLoading}
                title="Deterministic only"
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
                title="LLM Assist"
              >
                LLM
              </button>
            </div>

            <a
              href="/debug"
              className="text-xs text-gray-600 border border-gray-200 rounded-full px-3 py-2 bg-white hover:bg-gray-50"
              title="Legacy debug UI"
            >
              Debug
            </a>
          </div>
        </div>
      </div>

      {/* Chat-first body */}
      <div className="mx-auto w-full px-6 py-6">
        {partnerMissing ? (
          <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50 p-4">
            <div className="text-sm font-semibold text-amber-900">Pick a partner to begin</div>
            <div className="text-xs text-amber-800 mt-1">
              Home is ClickHouse-first. Select one partner (sticky) and start chatting.
            </div>
          </div>
        ) : null}

        {errorMessage ? (
          <div className="mb-4 rounded-xl border border-red-200 bg-red-50 p-4">
            <div className="text-sm font-semibold text-red-900">Error</div>
            <div className="text-xs text-red-800 mt-1">{errorMessage}</div>
          </div>
        ) : null}

        <div className="rounded-2xl border border-gray-200 bg-white shadow-sm overflow-hidden">
          <div ref={chatScrollRef} className="h-[70vh] overflow-y-auto p-5 bg-white">
            <div className="space-y-4">
              {messages.map((m) => (
                <div key={m.id} className="space-y-1">
                  <div className="text-[11px] text-gray-500">
                    <span className="font-semibold text-gray-700 capitalize">{m.role}</span> •{" "}
                    {formatTimestampClientSafe(m.timestamp, mounted)}
                  </div>

                  {m.type === "text" ? (
                    <pre className="whitespace-pre-wrap text-sm text-gray-900">{m.text}</pre>
                  ) : (
                    <TriageCard run={m.run} />
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* Composer */}
          <div className="border-t border-gray-200 bg-gray-50 p-4">
            <div className="flex gap-2">
              <input
                type="text"
                className="flex-1 rounded-xl border border-gray-300 bg-white text-gray-900 px-4 py-3 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 placeholder-gray-400"
                placeholder={chatMode === "llm" ? "Try: boston live last 1hr" : "Try: live in bos last 60m"}
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    onSend();
                  }
                }}
                disabled={isLoading}
              />
              <button
                type="button"
                onClick={onSend}
                disabled={isLoading || !chatInput.trim()}
                className="px-5 py-3 rounded-xl bg-blue-600 text-white font-semibold hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isLoading ? "Running..." : "Send"}
              </button>
            </div>
            <div className="mt-2 text-[11px] text-gray-500">
              Enter sends • Results appear inline as cards • Evidence/SQL are placeholders today
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}

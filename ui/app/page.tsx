"use client";

import { useEffect, useMemo, useRef, useState } from "react";

// ------------------------------------------------------------
// Configuration
// ------------------------------------------------------------
const DEFAULT_CSV_URL =
  "https://raw.githubusercontent.com/kganigap-291992/cdn-triage-bot/refs/heads/main/data/cdn_logs_6h_80k_stresstest.csv";

const STORAGE_KEY = "cdn-triage-history-v1";
const MAX_HISTORY = 10;

// Allowed values for chat parsing (keeps demo deterministic)
const ALLOWED = {
  service: new Set(["all", "live", "vod"]),
} as const;

function optionsFromSet(set: Set<string>) {
  const arr = Array.from(set);
  return arr.sort((a, b) => (a === "all" ? -1 : b === "all" ? 1 : a.localeCompare(b)));
}

const SERVICE_OPTIONS = optionsFromSet(ALLOWED.service);

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
type DataSource = "csv" | "clickhouse";
type Partner = (typeof PARTNER_OPTIONS)[number];

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
      partner: Partner;
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

type TriageInputs = {
  dataSource: DataSource;
  partner: Partner;
  csvUrl: string;
  fileName: string;
  service: string;
  region: string;
  pop: string;
  windowMinutes: number;
  debug: boolean;
};

type TriageRun = {
  id: string;
  timestamp: string;
  inputs: TriageInputs;
  summaryText: string;
  metricsJson: any;
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

  // stacked maps (NEW)
  statusCountsByCode?: Record<string, number>;
  hostCountsByHost?: Record<string, number>;
  crcCountsByCrc?: Record<string, number>;
};

type TimeseriesData = {
  bucketSeconds: number | null;
  startTs: string | null;
  endTs: string | null;
  points: TimeseriesPoint[];

  // stable legend order (optional but recommended)
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
  const normalized = normalizeText(text);
  if (!normalized) return true;
  if (normalized.length <= 3) {
    return ["hi", "hey", "yo", "ok", "k"].includes(normalized);
  }
  const greetingPatterns = [
    /^hi\b/,
    /^hey\b/,
    /^hello\b/,
    /^yo\b/,
    /^thanks\b/,
    /^thank you\b/,
    /^good (morning|afternoon|evening)\b/,
    /^how are you\b/,
    /^sup\b/,
    /^what'?s up\b/,
  ];
  return greetingPatterns.some((pattern) => pattern.test(normalized));
}

function looksLikeTriageQuery(text: string): boolean {
  const normalized = normalizeText(text);
  if (!normalized) return false;
  if (normalized.includes("=")) return true;
  const keywords = ["service", "region", "pop", "win", "window", "errors", "p95", "p99", "ttms", "triage"];
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

// -------- Legend utilities (status/host/crc) --------
function pickLegendOrder(
  ts: TimeseriesData | null,
  metricsJson: any,
  kind: "status" | "host" | "crc"
): string[] {
  if (!ts) return [];

  if (kind === "status") {
    const a = (ts.statusCodeSeries || []).map(String).filter(Boolean);
    if (a.length) return a;

    const avail = metricsJson?.available?.statusCodes;
    if (Array.isArray(avail) && avail.length) return avail.map(String);

    const seen = new Set<string>();
    for (const p of ts.points || []) {
      const m = p.statusCountsByCode || {};
      for (const k of Object.keys(m)) seen.add(String(k));
    }
    const observed = Array.from(seen).sort((x, y) => Number(x) - Number(y));
    if (observed.length) return observed;
    return ["200", "206", "304", "403", "404", "429", "500", "502", "503", "504"];
  }

  if (kind === "host") {
    const a = (ts.hostSeries || []).map(String).filter(Boolean);
    if (a.length) return a;

    const avail = metricsJson?.available?.edgeHosts;
    if (Array.isArray(avail) && avail.length) return avail.map(String).map((x: string) => x.toLowerCase());

    const seen = new Set<string>();
    for (const p of ts.points || []) {
      const m = p.hostCountsByHost || {};
      for (const k of Object.keys(m)) seen.add(String(k));
    }
    const observed = Array.from(seen).sort((a, b) => a.localeCompare(b));
    if (observed.length) return observed;
    return [];
  }

  // crc
  const a = (ts.crcSeries || []).map(String).filter(Boolean);
  if (a.length) return a;

  const avail = metricsJson?.available?.crcs;
  if (Array.isArray(avail) && avail.length) return avail.map(String).map((x: string) => x.toUpperCase());

  const seen = new Set<string>();
  for (const p of ts.points || []) {
    const m = p.crcCountsByCrc || {};
    for (const k of Object.keys(m)) seen.add(String(k));
  }
  const observed = Array.from(seen).sort((a, b) => a.localeCompare(b));
  if (observed.length) return observed;
  return [];
}

// Deterministic palette for any series key
function stableColorForKey(key: string) {
  const palette = [
    "#2563eb", // blue
    "#60a5fa", // light blue
    "#9ca3af", // gray
    "#f59e0b", // amber
    "#f97316", // orange
    "#f43f5e", // rose
    "#ef4444", // red
    "#10b981", // green
    "#22c55e", // green2
    "#a78bfa", // purple
    "#14b8a6", // teal
    "#eab308", // yellow
  ];

  // simple string hash
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return palette[h % palette.length];
}

function prettyBucketLabel(ts: TimeseriesData, mounted: boolean) {
  const b = ts.bucketSeconds;
  const s = ts.startTs ? formatTimestampClientSafe(ts.startTs, mounted) : "n/a";
  const e = ts.endTs ? formatTimestampClientSafe(ts.endTs, mounted) : "n/a";
  const bucket = b ? `${Math.round(b / 60)}m` : "n/a";
  return `${s} → ${e} (bucket: ${bucket})`;
}

// ------------------------------------------------------------
// Generic stacked chart (status/host/crc) over time
// ------------------------------------------------------------
function StackedKeyedTimeseries({
  ts,
  metricsJson,
  mounted,
  title,
  subtitle,
  kind,
  height = 160,
  maxBars = 36,
  seriesLimit = 12,
}: {
  ts: TimeseriesData;
  metricsJson: any;
  mounted: boolean;
  title: string;
  subtitle?: string;
  kind: "status" | "host" | "crc";
  height?: number;
  maxBars?: number;
  seriesLimit?: number;
}) {
  const points = (ts.points || []).slice(-maxBars);

  const legendOrder = pickLegendOrder(ts, metricsJson, kind);

  // union + totals, then take top N (keeps legend tidy even for CSV)
  const totals = new Map<string, number>();
  for (const p of points) {
    const m =
      kind === "status"
        ? p.statusCountsByCode || {}
        : kind === "host"
        ? p.hostCountsByHost || {}
        : p.crcCountsByCrc || {};
    for (const [k, v] of Object.entries(m)) {
      totals.set(k, (totals.get(k) ?? 0) + Number(v ?? 0));
    }
  }

  const presentKeys = Array.from(totals.entries())
    .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))
    .map(([k]) => k);

  // Respect stable order first, then append any missing observed keys.
  const ordered = [
    ...legendOrder.filter((k) => totals.has(k)),
    ...presentKeys.filter((k) => !legendOrder.includes(k)),
  ];

  const keys = ordered.slice(0, seriesLimit);
  if (!keys.length) return null;

  const totalsByPoint = points.map((p) => {
    const m =
      kind === "status"
        ? p.statusCountsByCode || {}
        : kind === "host"
        ? p.hostCountsByHost || {}
        : p.crcCountsByCrc || {};
    let sum = 0;
    for (const k of keys) sum += Number(m[k] || 0);
    return sum;
  });

  const maxTotal = Math.max(1, ...totalsByPoint);

  const w = 320;
  const h = height;
  const padLeft = 44;
  const padRight = 14;
  const padTop = 10;
  const padBottom = 34;
  const plotW = w - padLeft - padRight;
  const plotH = h - padTop - padBottom;

  const barCount = Math.max(1, points.length);
  const gap = clamp(Math.round(plotW / (barCount * 8)), 2, 6);
  const barW = Math.max(4, Math.floor((plotW - gap * (barCount - 1)) / barCount));

  const yTicks = 3;
  const tickVals = Array.from({ length: yTicks + 1 }, (_, i) =>
    Math.round((maxTotal * (yTicks - i)) / yTicks)
  );

  const xLabelEvery = Math.max(1, Math.floor(points.length / 6));
  const xLabels = points.map((p, i) => ({
    i,
    label:
      formatTimestampClientSafe(p.ts, mounted).split(",")[1]?.trim() ||
      formatTimestampClientSafe(p.ts, mounted),
    show: i % xLabelEvery === 0 || i === points.length - 1,
  }));

  const latest = points[points.length - 1];
  const latestTotal = totalsByPoint[totalsByPoint.length - 1] || 0;

  const latestLine = latest
    ? `${formatTimestampClientSafe(latest.ts, mounted)} • ${latestTotal.toLocaleString()} events`
    : "n/a";

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm min-w-0">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-xs text-gray-500">{subtitle || "Traffic timeseries"}</div>
          <div className="text-sm font-semibold text-gray-900">{title}</div>
          <div className="mt-1 text-[11px] text-gray-500">{prettyBucketLabel(ts, mounted)}</div>
        </div>
        <div className="text-right">
          <div className="text-xs text-gray-500">Latest</div>
          <div className="text-[11px] text-gray-700">{latestLine}</div>
        </div>
      </div>

      <div className="mt-3 rounded-xl border border-gray-100 bg-gray-50/60 p-3">
        <svg viewBox={`0 0 ${w} ${h}`} className="w-full" style={{ height }}>
          {/* Axis labels */}
          <text
            x={padLeft - 28}
            y={padTop + plotH / 2}
            fontSize="10"
            fill="#6b7280"
            transform={`rotate(-90 ${padLeft - 28} ${padTop + plotH / 2})`}
          >
            Events
          </text>
          <text x={padLeft + plotW / 2} y={h - 6} fontSize="10" fill="#6b7280" textAnchor="middle">
            Time (bucket)
          </text>

          {/* Y grid + ticks */}
          {tickVals.map((v, idx) => {
            const t = v / maxTotal;
            const y = padTop + (1 - t) * plotH;
            return (
              <g key={idx} opacity={0.35}>
                <line x1={padLeft} y1={y} x2={padLeft + plotW} y2={y} stroke="currentColor" />
                <text x={padLeft - 8} y={y + 3} fontSize="9" fill="#6b7280" textAnchor="end" opacity={0.9}>
                  {v >= 1000 ? `${Math.round(v / 1000)}k` : String(v)}
                </text>
              </g>
            );
          })}

          {/* Bars */}
          {points.map((p, i) => {
            const x = padLeft + i * (barW + gap);
            const m =
              kind === "status"
                ? p.statusCountsByCode || {}
                : kind === "host"
                ? p.hostCountsByHost || {}
                : p.crcCountsByCrc || {};

            let yTop = padTop + plotH;
            return (
              <g key={p.ts}>
                {keys.map((k) => {
                  const val = Number(m[k] || 0);
                  if (!val) return null;
                  const hSeg = (val / maxTotal) * plotH;
                  const y = yTop - hSeg;
                  yTop = y;

                  return (
                    <rect
                      key={`${p.ts}-${k}`}
                      x={x}
                      y={y}
                      width={barW}
                      height={Math.max(0, hSeg)}
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
          {xLabels.map((xl) => {
            if (!xl.show) return null;
            const x = padLeft + xl.i * (barW + gap) + barW / 2;
            return (
              <text key={xl.i} x={x} y={padTop + plotH + 16} fontSize="9" fill="#6b7280" textAnchor="middle">
                {xl.label}
              </text>
            );
          })}
        </svg>

        {/* Legend */}
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-[11px] text-gray-600">
          {keys.map((k) => (
            <div key={k} className="flex items-center gap-1.5">
              <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: stableColorForKey(k) }} />
              <span className="truncate max-w-[240px]">{k}</span>
            </div>
          ))}
        </div>

        <div className="mt-2 text-[11px] text-gray-500">
          Stacked by <span className="text-gray-700">{kind === "status" ? "statusCountsByCode" : kind === "host" ? "hostCountsByHost" : "crcCountsByCrc"}</span>
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------
// Minimal line chart: p95 + p99 (bucketed)
// ------------------------------------------------------------
function TimeseriesLines({
  points,
  mounted,
  height = 120,
  bucketLabel,
}: {
  points: TimeseriesPoint[];
  mounted: boolean;
  height?: number;
  bucketLabel?: string;
}) {
  const slice = points.slice(-60);
  const vals: number[] = [];
  for (const p of slice) {
    if (p.p95TtmsMs != null && Number.isFinite(p.p95TtmsMs)) vals.push(Number(p.p95TtmsMs));
    if (p.p99TtmsMs != null && Number.isFinite(p.p99TtmsMs)) vals.push(Number(p.p99TtmsMs));
  }
  const minV = vals.length ? Math.min(...vals) : 0;
  const maxV = vals.length ? Math.max(...vals) : 1;
  const span = maxV - minV || 1;

  const w = Math.max(1, slice.length - 1);

  function y(v: number | null) {
    if (v == null || !Number.isFinite(Number(v))) return null;
    const t = (Number(v) - minV) / span;
    return Math.round((1 - t) * (height - 28) + 12);
  }

  const p95Pts: string[] = [];
  const p99Pts: string[] = [];

  slice.forEach((p, i) => {
    const x = Math.round((i / w) * 300);
    const y95 = y(p.p95TtmsMs);
    const y99 = y(p.p99TtmsMs);
    if (y95 != null) p95Pts.push(`${x},${y95}`);
    if (y99 != null) p99Pts.push(`${x},${y99}`);
  });

  const latest = slice[slice.length - 1];
  const latestText = latest
    ? `${formatTimestampClientSafe(latest.ts, mounted)} • p95=${formatMsOrNA(latest.p95TtmsMs)} • p99=${formatMsOrNA(
        latest.p99TtmsMs
      )}`
    : "n/a";

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm min-w-0">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-xs text-gray-500">Latency timeseries</div>
          <div className="text-sm font-semibold text-gray-900">p95 / p99 TTMS</div>
          {bucketLabel ? <div className="mt-1 text-[11px] text-gray-500">{bucketLabel}</div> : null}
        </div>
        <div className="text-right">
          <div className="text-xs text-gray-500">Latest</div>
          <div className="text-[11px] text-gray-700">{latestText}</div>
        </div>
      </div>

      <div className="mt-3 rounded-xl border border-gray-100 bg-gray-50/60 p-3">
        <svg viewBox="0 0 300 120" className="w-full" style={{ height }}>
          <text x="8" y="60" fontSize="10" fill="#6b7280" transform="rotate(-90 8 60)">
            ms
          </text>
          <text x="150" y="116" fontSize="10" fill="#6b7280" textAnchor="middle">
            time (bucket)
          </text>

          <g opacity={0.35}>
            <line x1="0" y1="30" x2="300" y2="30" stroke="currentColor" />
            <line x1="0" y1="60" x2="300" y2="60" stroke="currentColor" />
            <line x1="0" y1="90" x2="300" y2="90" stroke="currentColor" />
          </g>

          <polyline
            fill="none"
            stroke="rgba(37,99,235,0.92)"
            strokeWidth="2.75"
            strokeLinecap="round"
            strokeLinejoin="round"
            opacity="1"
            points={p95Pts.join(" ")}
          />
          <polyline
            fill="none"
            stroke="rgba(17,24,39,0.38)"
            strokeWidth="2.75"
            strokeLinecap="round"
            strokeLinejoin="round"
            opacity="1"
            points={p99Pts.join(" ")}
          />
        </svg>

        <div className="mt-2 flex items-center justify-between text-[11px] text-gray-500">
          <div>
            min <span className="text-gray-700">{formatMsOrNA(minV)}</span>
          </div>
          <div>
            max <span className="text-gray-700">{formatMsOrNA(maxV)}</span>
          </div>
        </div>
        <div className="mt-2 flex items-center justify-center gap-4 text-[11px] text-gray-600">
          <div className="flex items-center gap-1.5">
            <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: "rgba(37,99,235,0.92)" }} />
            <span>p95</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: "rgba(17,24,39,0.38)" }} />
            <span>p99</span>
          </div>
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------
// Chat Panel (reusable — rendered in TWO places)
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
}: {
  title: string;
  mounted: boolean;
  isLoading: boolean;
  chatMessages: ChatMessage[];
  chatInput: string;
  setChatInput: (v: string) => void;
  onSend: () => void;
  chatScrollRef: React.RefObject<HTMLDivElement | null>;
}) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm flex flex-col h-[420px] min-w-0">
      <div className="font-medium text-gray-900 mb-3">{title}</div>

      <div
        ref={chatScrollRef}
        className="flex-1 overflow-y-auto rounded-lg border border-gray-200 p-4 bg-white mb-2"
      >
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
                  <pre className="whitespace-pre-wrap text-xs text-gray-700">
                    {msg.run.summaryText || "(no summary)"}
                  </pre>
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
            placeholder="Try: service=vod region=usw2 pop=sjc win=60"
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
        <div className="text-xs text-gray-500">
          {chatInput.trim() ? "Enter sends" : "Try: service=vod region=usw2 pop=sjc win=60"}
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------
// Main component
// ------------------------------------------------------------
export default function CDNTriageApp() {
  const [mounted, setMounted] = useState(false);

  // Form inputs
  const [dataSource, setDataSource] = useState<DataSource>("csv");
  const [partner, setPartner] = useState<Partner>("acme_media");
  const [csvUrl, setCsvUrl] = useState(DEFAULT_CSV_URL);
  const [uploadedFile, setUploadedFile] = useState<File | null>(null);
  const [service, setService] = useState("all");
  const [region, setRegion] = useState("all");
  const [pop, setPop] = useState("all");
  const [windowMinutes, setWindowMinutes] = useState(60);
  const [debugMode, setDebugMode] = useState(false);

  // State
  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [summaryText, setSummaryText] = useState("");
  const [metricsJson, setMetricsJson] = useState<any>(null);

  // History
  const [runHistory, setRunHistory] = useState<TriageRun[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);

  // Chat
  const [chatInput, setChatInput] = useState("");
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);

  // Refs
  const chatScrollLeftRef = useRef<HTMLDivElement | null>(null);
  const chatScrollRightRef = useRef<HTMLDivElement | null>(null);
  const lastMessageIdRef = useRef<string | null>(null);

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (dataSource === "clickhouse") setUploadedFile(null);
  }, [dataSource]);

  // Welcome message
  useEffect(() => {
    if (!mounted) return;
    if (chatMessages.length > 0) return;
    setChatMessages([
      {
        id: "welcome",
        type: "text",
        role: "system",
        text:
          "Chat ready. Type a message and I’ll run triage using the current filters.\n\nTry:\nservice=vod region=usw2 pop=sjc win=60",
        timestamp: getCurrentTimestamp(),
      },
    ]);
  }, [mounted, chatMessages.length]);

  // Load history
  useEffect(() => {
    if (!mounted) return;
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return;
    const parsed = safeParse<TriageRun[]>(stored, []);
    if (Array.isArray(parsed)) setRunHistory(parsed);
  }, [mounted]);

  // Save history
  useEffect(() => {
    if (!mounted) return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(runHistory));
  }, [runHistory, mounted]);

  // Auto scroll BOTH chat panels
  useEffect(() => {
    const lastMessage = chatMessages[chatMessages.length - 1];
    if (!lastMessage) return;
    if (lastMessageIdRef.current !== lastMessage.id) {
      lastMessageIdRef.current = lastMessage.id;
      const els = [chatScrollLeftRef.current, chatScrollRightRef.current].filter(Boolean) as HTMLDivElement[];
      for (const el of els) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    }
  }, [chatMessages]);

  // Allow ClickHouse runs without CSV
  const canRunTriage = useMemo(() => {
    if (dataSource === "clickhouse") return true;
    return Boolean(uploadedFile) || (csvUrl && csvUrl.trim().length > 0);
  }, [dataSource, uploadedFile, csvUrl]);

  // Dynamic Region/POP options from metricsJson.available (if present)
  const available = metricsJson?.available ?? {};

  const REGION_OPTIONS = useMemo(() => {
    const arr = Array.isArray(available.regions) ? available.regions : [];
    const cleaned = arr.map((x: any) => String(x || "").trim().toLowerCase()).filter(Boolean);
    const uniq = Array.from(new Set(cleaned));
    uniq.sort((a, b) => a.localeCompare(b));
    return ["all", ...uniq];
  }, [available.regions]);

  const POP_OPTIONS = useMemo(() => {
    const arr = Array.isArray(available.pops) ? available.pops : [];
    const cleaned = arr.map((x: any) => String(x || "").trim().toLowerCase()).filter(Boolean);
    const uniq = Array.from(new Set(cleaned));
    uniq.sort((a, b) => a.localeCompare(b));
    return ["all", ...uniq];
  }, [available.pops]);

  // Safety guard: reset invalid region/pop once options change
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
      .map((p: any) => ({
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
      .filter((p) => Boolean(p.ts));

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

  const csvInputsDisabled = isLoading || dataSource === "clickhouse";

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

  async function runTriageRequest(inputs: {
    dataSource: DataSource;
    partner: Partner;
    csvUrl: string;
    file: File | null;
    service: string;
    region: string;
    pop: string;
    windowMinutes: number;
    debug: boolean;
  }) {
    const formData = new FormData();
    formData.append("dataSource", inputs.dataSource);
    formData.append("partner", inputs.partner || "acme_media");
    formData.append("csvUrl", inputs.csvUrl || "");
    formData.append("service", inputs.service);
    formData.append("region", inputs.region);
    formData.append("pop", inputs.pop);
    formData.append("windowMinutes", String(inputs.windowMinutes));
    if (inputs.file) formData.append("file", inputs.file);
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

  async function handleRunTriage() {
    setErrorMessage("");
    setSummaryText("");
    setMetricsJson(null);
    setSelectedRunId(null);

    if (!canRunTriage) {
      setErrorMessage(
        dataSource === "clickhouse"
          ? "ClickHouse mode should be runnable (unexpected)."
          : "Please provide a CSV URL or upload a CSV file."
      );
      return;
    }

    setIsLoading(true);
    try {
      const data = await runTriageRequest({
        dataSource,
        partner,
        csvUrl,
        file: uploadedFile,
        service,
        region,
        pop,
        windowMinutes,
        debug: debugMode,
      });

      setSummaryText(data.summaryText || "");
      setMetricsJson(data.metricsJson || null);

      const newRun: TriageRun = {
        id: `${Date.now()}`,
        timestamp: getCurrentTimestamp(),
        inputs: {
          dataSource,
          partner,
          csvUrl: uploadedFile || dataSource === "clickhouse" ? "" : csvUrl || "",
          fileName: uploadedFile ? uploadedFile.name : "",
          service,
          region,
          pop,
          windowMinutes,
          debug: debugMode,
        },
        summaryText: data.summaryText || "",
        metricsJson: data.metricsJson || null,
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

    addChatText("user", text);
    setChatInput("");
    setErrorMessage("");

    if (isGreetingOrSmallTalk(text)) {
      addChatText("assistant", "Hey! 👋 I can triage CDN logs.\n\nTry:\nservice=vod region=usw2 pop=sjc win=60");
      return;
    }

    if (!looksLikeTriageQuery(text)) {
      addChatText("assistant", "I didn't see filters yet.\n\nTry:\nservice=vod region=usw2 pop=sjc win=60");
      return;
    }

    const lowerText = text.toLowerCase();
    const serviceMatch = lowerText.match(/\b(service|svc)\s*=\s*([a-z0-9_]+)\b/);
    const regionMatch = lowerText.match(/\bregion\s*=\s*([a-z0-9_]+)\b/);
    const popMatch = lowerText.match(/\bpop\s*=\s*([a-z0-9_]+)\b/);
    const windowMatch = lowerText.match(/\b(win|window)\s*=\s*(\d+)\b/);

    const candidateService = serviceMatch?.[2];
    const candidateRegion = regionMatch?.[1];
    const candidatePop = popMatch?.[1];
    const candidateWindow = windowMatch?.[2] ? Number(windowMatch[2]) : null;

    const invalids: string[] = [];

    if (candidateService && !ALLOWED.service.has(candidateService)) {
      invalids.push(`service=${candidateService} (allowed: ${Array.from(ALLOWED.service).join("|")})`);
    }

    // validate region/pop only if options discovered from a prior run
    const hasRegionOptions = REGION_OPTIONS.length > 1;
    const hasPopOptions = POP_OPTIONS.length > 1;

    if (candidateRegion && hasRegionOptions && !REGION_OPTIONS.includes(candidateRegion)) {
      invalids.push(`region=${candidateRegion} (allowed: ${REGION_OPTIONS.join("|")})`);
    }
    if (candidatePop && hasPopOptions && !POP_OPTIONS.includes(candidatePop)) {
      invalids.push(`pop=${candidatePop} (allowed: ${POP_OPTIONS.join("|")})`);
    }

    if (candidateWindow != null && (!Number.isFinite(candidateWindow) || candidateWindow <= 0)) {
      invalids.push(`win=${String(candidateWindow)} (must be a positive number)`);
    }

    if (invalids.length) {
      addChatText(
        "assistant",
        `I couldn't run that because some values are invalid:\n- ${invalids.join("\n- ")}\n\nTry:\nservice=vod region=usw2 pop=sjc win=60`
      );
      return;
    }

    const nextService = candidateService ?? service;
    const nextRegion = candidateRegion ?? region;
    const nextPop = candidatePop ?? pop;
    const nextWindow = candidateWindow ?? windowMinutes;

    if (candidateService) setService(nextService);
    if (candidateRegion) setRegion(nextRegion);
    if (candidatePop) setPop(nextPop);
    if (candidateWindow != null) setWindowMinutes(nextWindow);

    if (!canRunTriage) {
      addChatText(
        "assistant",
        dataSource === "clickhouse"
          ? "ClickHouse mode should be runnable (unexpected)."
          : "Please upload a CSV or provide a CSV URL first."
      );
      return;
    }

    addChatText(
      "system",
      `Running triage (${dataSource}${dataSource === "clickhouse" ? `, partner=${partner}` : ""}) with svc=${nextService}, region=${nextRegion}, pop=${nextPop}, win=${nextWindow}m`
    );

    setIsLoading(true);
    try {
      const data = await runTriageRequest({
        dataSource,
        partner,
        csvUrl,
        file: uploadedFile,
        service: nextService,
        region: nextRegion,
        pop: nextPop,
        windowMinutes: nextWindow,
        debug: debugMode,
      });

      setSummaryText(data.summaryText || "");
      setMetricsJson(data.metricsJson || null);
      setSelectedRunId(null);

      const newRun: TriageRun = {
        id: `${Date.now()}`,
        timestamp: getCurrentTimestamp(),
        inputs: {
          dataSource,
          partner,
          csvUrl: uploadedFile || dataSource === "clickhouse" ? "" : csvUrl || "",
          fileName: uploadedFile ? uploadedFile.name : "",
          service: nextService,
          region: nextRegion,
          pop: nextPop,
          windowMinutes: nextWindow,
          debug: debugMode,
        },
        summaryText: data.summaryText || "",
        metricsJson: data.metricsJson || null,
      };
      setRunHistory((prev) => [newRun, ...prev].slice(0, MAX_HISTORY));

      addChatTriage({
        inputs: {
          dataSource,
          partner,
          service: nextService,
          region: nextRegion,
          pop: nextPop,
          windowMinutes: nextWindow,
        },
        summaryText: data.summaryText || "",
        metricsJson: data.metricsJson || null,
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

    setDataSource((run.inputs?.dataSource || "csv") as DataSource);
    setPartner((run.inputs?.partner as Partner) || "acme_media");
    setUploadedFile(null);
    setCsvUrl(run.inputs?.csvUrl || DEFAULT_CSV_URL);
    setService(run.inputs?.service || "all");
    setRegion(run.inputs?.region || "all");
    setPop(run.inputs?.pop || "all");
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
    }
  }

  function clearAllHistory() {
    setRunHistory([]);
    setSelectedRunId(null);
    setSummaryText("");
    setMetricsJson(null);
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

  const bucketLabel = ts ? prettyBucketLabel(ts, mounted) : "";

  return (
    <main className="min-h-screen w-full bg-gray-50 px-6 py-6">
      <div className="mx-auto w-full">
        <h1 className="text-2xl font-bold text-gray-900 mb-6">CDN Triage UI (REPO)</h1>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          {/* Sidebar */}
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
                    const title = inp.fileName
                      ? `file: ${inp.fileName}`
                      : inp.dataSource === "clickhouse"
                      ? "source: clickhouse"
                      : "url: csv";
                    const partnerText = inp.dataSource === "clickhouse" ? ` • partner=${inp.partner || "acme_media"}` : "";
                    const subtitle = `${inp.dataSource || "csv"}${partnerText} • svc=${inp.service} region=${inp.region} pop=${inp.pop} win=${inp.windowMinutes}m`;

                    return (
                      <div
                        key={run.id}
                        className={`rounded-lg border p-3 transition-colors ${
                          isActive ? "bg-blue-50 border-blue-300" : "bg-white border-gray-200 hover:bg-gray-50"
                        }`}
                      >
                        <div className="text-xs font-semibold text-gray-900">
                          {formatTimestampClientSafe(run.timestamp, mounted)}
                        </div>
                        <div className="text-xs text-gray-600 mt-1">{subtitle}</div>
                        <div className="text-xs text-gray-500 mt-1 truncate">{title}</div>
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

            {/* Chat panel in sidebar */}
            <ChatPanel
              title="Chat (Filters sidebar)"
              mounted={mounted}
              isLoading={isLoading}
              chatMessages={chatMessages}
              chatInput={chatInput}
              setChatInput={setChatInput}
              onSend={handleChatSend}
              chatScrollRef={chatScrollLeftRef}
            />
          </aside>

          {/* Main */}
          <section className="lg:col-span-9 min-w-0">
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
              {/* Left */}
              <div className="space-y-4 min-w-0">
                <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
                  <div className="space-y-4">
                    {/* Data source selector */}
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-2">Data Source</label>
                      <select
                        className="w-full rounded-lg border border-gray-300 bg-white text-gray-900 px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                        value={dataSource}
                        onChange={(e) => setDataSource(e.target.value as DataSource)}
                        disabled={isLoading}
                      >
                        <option value="csv">CSV</option>
                        <option value="clickhouse">ClickHouse</option>
                      </select>
                      <div className="text-xs text-gray-500 mt-2">
                        {dataSource === "csv"
                          ? "Uses CSV URL or uploaded file."
                          : "Uses ClickHouse (mock for now; next step = real queries). CSV fields below are ignored."}
                      </div>
                    </div>

                    {/* Partner selector */}
                    {dataSource === "clickhouse" && (
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-2">Partner</label>
                        <select
                          className="w-full rounded-lg border border-gray-300 bg-white text-gray-900 px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                          value={partner}
                          onChange={(e) => setPartner(e.target.value as Partner)}
                          disabled={isLoading}
                        >
                          {PARTNER_OPTIONS.map((p) => (
                            <option key={p} value={p}>
                              {p}
                            </option>
                          ))}
                        </select>
                        <div className="text-xs text-gray-500 mt-2">
                          Public-safe mock partner routing (real partner → DB mapping later).
                        </div>
                      </div>
                    )}

                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-2">CSV URL</label>
                      <input
                        type="text"
                        className="w-full rounded-lg border border-gray-300 bg-white text-gray-900 px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                        value={csvUrl ?? ""}
                        onChange={(e) => setCsvUrl(e.target.value)}
                        placeholder="https://..."
                        disabled={csvInputsDisabled}
                      />
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-2">Or upload CSV</label>
                      <input
                        type="file"
                        accept=".csv,text/csv"
                        onChange={(e) => setUploadedFile(e.target.files?.[0] ?? null)}
                        className="text-sm text-gray-700"
                        disabled={csvInputsDisabled}
                      />
                      {uploadedFile && <div className="text-xs text-gray-600 mt-2">Selected: {uploadedFile.name}</div>}
                      <div className="text-xs text-gray-500 mt-2">
                        Note: history can reload URL-based runs. File uploads can't be reloaded (browser limitation).
                      </div>
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
                        {REGION_OPTIONS.length <= 1 ? (
                          <div className="text-[11px] text-gray-400 mt-2">Run once to populate region options.</div>
                        ) : null}
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
                        {POP_OPTIONS.length <= 1 ? (
                          <div className="text-[11px] text-gray-400 mt-2">Run once to populate POP options.</div>
                        ) : null}
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
                        Enable debug output
                      </label>

                      <button
                        onClick={handleRunTriage}
                        disabled={isLoading || !canRunTriage}
                        className="px-6 py-2 bg-blue-600 text-white font-semibold rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                      >
                        {isLoading ? "Running..." : "Run Triage"}
                      </button>
                    </div>

                    {errorMessage ? (
                      <div className="rounded-lg border border-red-300 bg-red-50 p-3">
                        <p className="text-sm text-red-800">
                          <strong>Error:</strong> {errorMessage}
                        </p>
                      </div>
                    ) : null}
                  </div>
                </div>

                {parsedMetrics ? (
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
                ) : null}

                {/* Summary */}
                <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
                  <div className="font-medium text-gray-900 mb-2">Summary</div>
                  <pre className="whitespace-pre-wrap text-sm text-gray-700 font-mono">
                    {summaryText || "Run triage to see results..."}
                  </pre>
                </div>

                <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
                  <div className="font-medium text-gray-900 mb-2">Raw metricsJson (debug)</div>
                  <pre className="whitespace-pre-wrap text-xs text-gray-600 font-mono overflow-auto max-h-64">
                    {metricsJson ? JSON.stringify(metricsJson, null, 2) : "No metricsJson yet."}
                  </pre>
                </div>
              </div>

              {/* Right: Charts + Chat */}
              <div className="space-y-4 min-w-0">
                {ts && ts.points.length > 0 ? (
                  <>
                    {/* Status codes (stacked) */}
                    <StackedKeyedTimeseries
                      ts={ts}
                      metricsJson={metricsJson}
                      mounted={mounted}
                      kind="status"
                      title="Total events by status code (stacked)"
                      subtitle="Traffic timeseries"
                      seriesLimit={14}
                    />

                    {/* ✅ NEW: Total events by host (stacked) */}
                    <StackedKeyedTimeseries
                      ts={ts}
                      metricsJson={metricsJson}
                      mounted={mounted}
                      kind="host"
                      title="Total events by host (stacked)"
                      subtitle="Host distribution"
                      seriesLimit={10}
                    />

                    {/* ✅ NEW: CRC error code chart (stacked) */}
                    <StackedKeyedTimeseries
                      ts={ts}
                      metricsJson={metricsJson}
                      mounted={mounted}
                      kind="crc"
                      title="Total events by CRC code (stacked)"
                      subtitle="CRC distribution"
                      seriesLimit={10}
                    />

                    {/* Latency chart */}
                    <TimeseriesLines points={ts.points} mounted={mounted} bucketLabel={bucketLabel} />
                  </>
                ) : (
                  <div className="rounded-xl border border-gray-200 bg-gray-50 p-3 text-sm text-gray-600">
                    Run triage to see charts.
                  </div>
                )}

                {/* Chat panel on the right */}
                <ChatPanel
                  title="Chat (Main panel)"
                  mounted={mounted}
                  isLoading={isLoading}
                  chatMessages={chatMessages}
                  chatInput={chatInput}
                  setChatInput={setChatInput}
                  onSend={handleChatSend}
                  chatScrollRef={chatScrollRightRef}
                />
              </div>
              {/* /Right */}
            </div>
          </section>
        </div>
      </div>
    </main>
  );
}

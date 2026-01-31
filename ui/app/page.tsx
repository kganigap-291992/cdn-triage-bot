"use client";

import { useEffect, useMemo, useRef, useState } from "react";

// Configuration
const DEFAULT_CSV_URL =
  "https://raw.githubusercontent.com/kganigap-291992/cdn-triage-bot/refs/heads/main/data/cdn_logs_6h_80k_stresstest.csv";

const STORAGE_KEY = "cdn-triage-history-v1";
const MAX_HISTORY = 10;

// Allowed values for chat parsing (keeps demo deterministic)
const ALLOWED = {
  service: new Set(["all", "live", "vod"]),
  region: new Set(["all", "use1", "usw2", "usw1", "euw1", "apse1"]),
  pop: new Set(["all", "iad", "sjc", "dfw", "mia", "ord", "lhr"]),
} as const;

function optionsFromSet(set: Set<string>) {
  const arr = Array.from(set);
  return arr.sort((a, b) => (a === "all" ? -1 : b === "all" ? 1 : a.localeCompare(b)));
}
const SERVICE_OPTIONS = optionsFromSet(ALLOWED.service);
const REGION_OPTIONS = optionsFromSet(ALLOWED.region);
const POP_OPTIONS = optionsFromSet(ALLOWED.pop);

// Types
type ChatMessage = {
  id: string;
  role: "system" | "user" | "assistant";
  text: string;
  timestamp: string; // ISO
};

type TriageInputs = {
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
};

type TimeseriesData = {
  bucketSeconds: number | null;
  startTs: string | null;
  endTs: string | null;
  points: TimeseriesPoint[];
};

type ChartMetric = "errorRatePct" | "totalRequests" | "p95TtmsMs" | "p99TtmsMs" | "error5xxCount";

// Utility functions
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

function clamp01(x: number) {
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(1, x));
}

function getMetricValue(p: TimeseriesPoint, metric: ChartMetric): number | null {
  switch (metric) {
    case "errorRatePct":
      return Number.isFinite(p.errorRatePct) ? p.errorRatePct : 0;
    case "totalRequests":
      return Number.isFinite(p.totalRequests) ? p.totalRequests : 0;
    case "error5xxCount":
      return Number.isFinite(p.error5xxCount) ? p.error5xxCount : 0;
    case "p95TtmsMs":
      return p.p95TtmsMs == null ? null : Number(p.p95TtmsMs);
    case "p99TtmsMs":
      return p.p99TtmsMs == null ? null : Number(p.p99TtmsMs);
  }
}

function metricLabel(metric: ChartMetric) {
  switch (metric) {
    case "errorRatePct":
      return "5xx%";
    case "totalRequests":
      return "Requests";
    case "error5xxCount":
      return "5xx Count";
    case "p95TtmsMs":
      return "p95 TTMS (ms)";
    case "p99TtmsMs":
      return "p99 TTMS (ms)";
  }
}

function formatMetric(metric: ChartMetric, v: number | null) {
  if (v == null || !Number.isFinite(v)) return "n/a";
  if (metric === "errorRatePct") return `${v.toFixed(2)}%`;
  if (metric === "p95TtmsMs" || metric === "p99TtmsMs") return `${Math.round(v)} ms`;
  return Math.round(v).toLocaleString();
}

// Format timestamps ONLY after mount to avoid SSR/CSR mismatch.
function formatTimestampClientSafe(iso: string, mounted: boolean): string {
  if (!iso) return "";
  if (!mounted) {
    return iso.replace("T", " ").replace(".000Z", "Z");
  }
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

// Apple-ish tooltip bubble (pure CSS via group-hover)
function TooltipBubble({ text }: { text: string }) {
  return (
    <div
      className="
        pointer-events-none absolute bottom-full left-1/2 -translate-x-1/2 mb-2
        opacity-0 translate-y-1 scale-[0.98]
        group-hover:opacity-100 group-hover:translate-y-0 group-hover:scale-100
        transition-all duration-150 ease-out
        z-20
      "
    >
      <div
        className="
          rounded-xl border border-gray-200 bg-white/95 backdrop-blur
          px-2.5 py-1.5 text-[11px] text-gray-900 shadow-lg
          whitespace-nowrap
        "
      >
        {text}
      </div>
      <div
        className="
          mx-auto h-2 w-2 rotate-45 -mt-1
          border-r border-b border-gray-200
          bg-white/95
        "
      />
    </div>
  );
}

function MiniBars({
  points,
  metric,
  mounted,
  maxBars = 48,
}: {
  points: TimeseriesPoint[];
  metric: ChartMetric;
  mounted: boolean;
  maxBars?: number;
}) {
  const slice = points.slice(-maxBars);

  const values = slice
    .map((p) => getMetricValue(p, metric))
    .filter((v): v is number => v != null && Number.isFinite(v));

  const minV = values.length ? Math.min(...values) : 0;
  const maxV = values.length ? Math.max(...values) : 1;

  const span = maxV - minV;
  const safeSpan = span === 0 ? 1 : span;

  const last = slice[slice.length - 1];
  const lastV = last ? getMetricValue(last, metric) : null;

  const isErrorMetric = metric === "errorRatePct" || metric === "error5xxCount";

  const barBase =
    "rounded-[3px] shadow-[0_1px_0_rgba(0,0,0,0.06)] transition-all duration-150 ease-out";
  const barColor = isErrorMetric
    ? "bg-gradient-to-t from-red-500/70 to-red-500/35"
    : "bg-gradient-to-t from-blue-600/70 to-blue-600/35";

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm min-w-0">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-xs text-gray-500">Mini chart</div>
          <div className="text-sm font-semibold text-gray-900">{metricLabel(metric)}</div>
        </div>

        <div className="text-right">
          <div className="text-xs text-gray-500">Latest</div>
          <div className="text-sm font-semibold text-gray-900">{formatMetric(metric, lastV)}</div>
        </div>
      </div>

      {/* Chart area */}
      <div className="mt-3 rounded-xl border border-gray-100 bg-gray-50/60 p-3">
        <div className="relative h-28">
          {/* subtle grid */}
          <div className="absolute inset-0 pointer-events-none">
            <div className="h-full w-full grid grid-rows-4">
              <div className="border-b border-gray-200/60" />
              <div className="border-b border-gray-200/60" />
              <div className="border-b border-gray-200/60" />
              <div className="border-b border-gray-200/60" />
            </div>
          </div>

          {/* Bars */}
          {/* ✅ Improvement: overflow-hidden prevents "overlap" look from shadows/tooltips */}
          <div className="relative h-full flex items-end gap-[3px] overflow-hidden">
            {slice.map((p, idx) => {
              const v = getMetricValue(p, metric);
              const normalized = v == null ? 0 : clamp01((v - minV) / safeSpan);
              const hPct = Math.max(0.06, normalized) * 100;

              const tip = `${formatTimestampClientSafe(p.ts, mounted)} • ${metricLabel(metric)}: ${formatMetric(
                metric,
                v
              )}`;

              return (
                <div
                  key={`${p.ts}-${idx}`}
                  className="group relative flex-1 min-w-[2px] h-full flex items-end"
                >
                  <TooltipBubble text={tip} />

                  <div
                    className={[
                      "w-full",
                      barBase,
                      barColor,
                      "group-hover:-translate-y-[1px] group-hover:brightness-105",
                      "group-hover:shadow-[0_6px_18px_rgba(0,0,0,0.08)]",
                      "ring-0 group-hover:ring-1 group-hover:ring-black/5",
                    ].join(" ")}
                    style={{ height: `${hPct}%` }}
                  />
                </div>
              );
            })}
          </div>
        </div>

        <div className="mt-2 flex items-center justify-between text-[11px] text-gray-500">
          <div>
            min <span className="text-gray-700">{formatMetric(metric, minV)}</span>
          </div>
          <div>
            max <span className="text-gray-700">{formatMetric(metric, maxV)}</span>
          </div>
        </div>
      </div>

      <div className="mt-2 text-[11px] text-gray-500">Hover bars for exact values.</div>
    </div>
  );
}

function TimeseriesPanel({ points, mounted }: { points: TimeseriesPoint[]; mounted: boolean }) {
  const [metric, setMetric] = useState<ChartMetric>("errorRatePct");

  return (
    <div className="mt-4 space-y-3">
      {/* Control row */}
      <div className="flex items-center justify-between gap-3">
        <div className="text-xs text-gray-500">View</div>
        <div className="flex items-center gap-2">
          <select
            value={metric}
            onChange={(e) => setMetric(e.target.value as ChartMetric)}
            className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-xs text-gray-900
                       focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
          >
            <option value="errorRatePct">5xx%</option>
            <option value="error5xxCount">5xx Count</option>
            <option value="totalRequests">Requests</option>
            <option value="p95TtmsMs">p95 TTMS</option>
            <option value="p99TtmsMs">p99 TTMS</option>
          </select>

          <div className="text-xs text-gray-400 hidden sm:block">last 48 buckets</div>
        </div>
      </div>

      <MiniBars points={points} metric={metric} mounted={mounted} maxBars={48} />

      {/* ✅ Fix: responsive auto-fit grid prevents overlap on mid-width screens */}
      <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(360px,1fr))] w-full">
        <div className="min-w-0">
          <MiniBars points={points} metric="errorRatePct" mounted={mounted} maxBars={48} />
        </div>
        <div className="min-w-0">
          <MiniBars points={points} metric="p95TtmsMs" mounted={mounted} maxBars={48} />
        </div>
      </div>
    </div>
  );
}

// Main component
export default function CDNTriageApp() {
  const [mounted, setMounted] = useState(false);

  // Form inputs
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

  // Chat (IMPORTANT: start empty to avoid hydration mismatch)
  const [chatInput, setChatInput] = useState("");
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);

  // Refs
  const chatScrollRef = useRef<HTMLDivElement | null>(null);
  const lastMessageIdRef = useRef<string | null>(null);

  // Mark mounted (fix hydration mismatch for timestamps)
  useEffect(() => {
    setMounted(true);
  }, []);

  // Initialize welcome chat message after mount (deterministic SSR)
  useEffect(() => {
    if (!mounted) return;
    if (chatMessages.length > 0) return;

    setChatMessages([
      {
        id: "welcome",
        role: "system",
        text: "Chat ready. Type a message and I'll run triage using the current filters.",
        timestamp: getCurrentTimestamp(),
      },
    ]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mounted]);

  // Load history from localStorage on mount
  useEffect(() => {
    if (!mounted) return;
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return;

    const parsed = safeParse<TriageRun[]>(stored, []);
    if (Array.isArray(parsed)) setRunHistory(parsed);
  }, [mounted]);

  // Save history to localStorage
  useEffect(() => {
    if (!mounted) return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(runHistory));
  }, [runHistory, mounted]);

  // Auto-scroll chat to bottom on new messages
  useEffect(() => {
    const lastMessage = chatMessages[chatMessages.length - 1];
    if (!lastMessage) return;

    if (lastMessageIdRef.current !== lastMessage.id) {
      lastMessageIdRef.current = lastMessage.id;

      const el = chatScrollRef.current;
      if (el) {
        el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
      }
    }
  }, [chatMessages]);

  // Computed values
  const canRunTriage = useMemo(() => {
    return Boolean(uploadedFile) || (csvUrl && csvUrl.trim().length > 0);
  }, [uploadedFile, csvUrl]);

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

  const parsedTimeseries = useMemo((): TimeseriesData | null => {
    if (!metricsJson?.timeseries) return null;

    const ts = metricsJson.timeseries;
    const pointsRaw = Array.isArray(ts.points) ? ts.points : [];

    const points: TimeseriesPoint[] = pointsRaw
      .map((p: any) => ({
        ts: String(p.ts || ""),
        totalRequests: Number(p.totalRequests) || 0,
        error5xxCount: Number(p.error5xxCount) || 0,
        errorRatePct: Number(p.errorRatePct) || 0,
        p95TtmsMs: p.p95TtmsMs == null ? null : Number(p.p95TtmsMs),
        p99TtmsMs: p.p99TtmsMs == null ? null : Number(p.p99TtmsMs),
      }))
      .filter((p) => p.ts);

    return {
      bucketSeconds: ts.bucketSeconds == null ? null : Number(ts.bucketSeconds),
      startTs: ts.startTs ? String(ts.startTs) : null,
      endTs: ts.endTs ? String(ts.endTs) : null,
      points,
    };
  }, [metricsJson]);

  // Helper: add chat message
  function addChatMessage(role: ChatMessage["role"], text: string) {
    setChatMessages((prev) => [
      ...prev,
      {
        id: `${Date.now()}-${Math.random()}`,
        role,
        text,
        timestamp: getCurrentTimestamp(),
      },
    ]);
  }

  // API call: run triage
  async function runTriageRequest(inputs: {
    csvUrl: string;
    file: File | null;
    service: string;
    region: string;
    pop: string;
    windowMinutes: number;
    debug: boolean;
  }) {
    const formData = new FormData();
    formData.append("csvUrl", inputs.csvUrl || "");
    formData.append("service", inputs.service);
    formData.append("region", inputs.region);
    formData.append("pop", inputs.pop);
    formData.append("windowMinutes", String(inputs.windowMinutes));

    if (inputs.file) formData.append("file", inputs.file);
    if (inputs.debug) formData.append("debug", "true");

    const response = await fetch("/api/triage", { method: "POST", body: formData });
    const data = await response.json();

    if (!data.ok) throw new Error(data.error || "Request failed");
    return data;
  }

  // Manual Run Triage button
  async function handleRunTriage() {
    setErrorMessage("");
    setSummaryText("");
    setMetricsJson(null);
    setSelectedRunId(null);

    if (!canRunTriage) {
      setErrorMessage("Please provide a CSV URL or upload a CSV file.");
      return;
    }

    setIsLoading(true);
    try {
      const data = await runTriageRequest({
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
          csvUrl: uploadedFile ? "" : csvUrl || "",
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

  // Chat send
  async function handleChatSend() {
    const text = chatInput.trim();
    if (!text) return;
    if (isLoading) return;

    addChatMessage("user", text);
    setChatInput("");
    setErrorMessage("");

    if (isGreetingOrSmallTalk(text)) {
      addChatMessage("assistant", "Hey! 👋 I can triage CDN logs.\n\nTry:\nservice=vod region=usw2 pop=sjc win=60");
      return;
    }

    if (!looksLikeTriageQuery(text)) {
      addChatMessage("assistant", "I didn't see filters yet.\n\nTry:\nservice=vod region=usw2 pop=sjc win=60");
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
    if (candidateRegion && !ALLOWED.region.has(candidateRegion)) {
      invalids.push(`region=${candidateRegion} (allowed: ${Array.from(ALLOWED.region).join("|")})`);
    }
    if (candidatePop && !ALLOWED.pop.has(candidatePop)) {
      invalids.push(`pop=${candidatePop} (allowed: ${Array.from(ALLOWED.pop).join("|")})`);
    }
    if (candidateWindow != null && (!Number.isFinite(candidateWindow) || candidateWindow <= 0)) {
      invalids.push(`win=${String(candidateWindow)} (must be a positive number)`);
    }

    if (invalids.length) {
      addChatMessage(
        "assistant",
        `I couldn’t run that because some values are invalid:\n- ${invalids.join("\n- ")}\n\nTry:\nservice=vod region=usw2 pop=sjc win=60`
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
      addChatMessage("assistant", "Please upload a CSV or provide a CSV URL first.");
      return;
    }

    addChatMessage("system", `Running triage with svc=${nextService}, region=${nextRegion}, pop=${nextPop}, win=${nextWindow}m`);

    setIsLoading(true);
    try {
      const data = await runTriageRequest({
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
          csvUrl: uploadedFile ? "" : csvUrl || "",
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
      addChatMessage("assistant", data.summaryText || "(no summary)");
    } catch (error: any) {
      const msg = error?.message || "Something went wrong";
      setErrorMessage(msg);
      addChatMessage("assistant", `Error: ${msg}`);
    } finally {
      setIsLoading(false);
    }
  }

  function loadHistoricalRun(run: TriageRun) {
    setSelectedRunId(run.id);
    setErrorMessage("");
    setSummaryText(run.summaryText || "");
    setMetricsJson(run.metricsJson || null);

    setUploadedFile(null);
    setCsvUrl(run.inputs?.csvUrl || DEFAULT_CSV_URL);
    setService(run.inputs?.service || "all");
    setRegion(run.inputs?.region || "all");
    setPop(run.inputs?.pop || "all");
    setWindowMinutes(Number(run.inputs?.windowMinutes || 60));
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

  return (
    <main className="min-h-screen w-full bg-gray-50 px-6 py-6">
      {/* ✅ Improvement: full width container (no max-width cap) */}
      <div className="mx-auto w-full">
        <h1 className="text-2xl font-bold text-gray-900 mb-6">CDN Triage UI (REPO)</h1>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          {/* Sidebar: History */}
          <aside className="lg:col-span-3">
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
                    const inp = run.inputs || {};
                    const title = inp.fileName ? `file: ${inp.fileName}` : "url: csv";
                    const subtitle = `svc=${inp.service} region=${inp.region} pop=${inp.pop} win=${inp.windowMinutes}m`;

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
          </aside>

          {/* Main */}
          <section className="lg:col-span-9 min-w-0">
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
              {/* Left: Triage UI */}
              <div className="space-y-4 min-w-0">
                <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
                  <div className="space-y-4">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-2">CSV URL</label>
                      <input
                        type="text"
                        className="w-full rounded-lg border border-gray-300 bg-white text-gray-900 px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                        value={csvUrl}
                        onChange={(e) => setCsvUrl(e.target.value)}
                        placeholder="https://..."
                        disabled={isLoading}
                      />
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-2">Or upload CSV</label>
                      <input
                        type="file"
                        accept=".csv,text/csv"
                        onChange={(e) => setUploadedFile(e.target.files?.[0] ?? null)}
                        className="text-sm text-gray-700"
                        disabled={isLoading}
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
                      </div>

                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-2">Window (minutes)</label>
                        <input
                          type="number"
                          className="w-full rounded-lg border border-gray-300 bg-white text-gray-900 px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                          value={windowMinutes}
                          onChange={(e) => setWindowMinutes(Number(e.target.value))}
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
                    <MetricCard label="totalRequests" value={parsedMetrics.totalRequests.toLocaleString()} />
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

                <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm min-w-0">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="font-medium text-gray-900">Timeseries</div>
                      <div className="text-xs text-gray-500 mt-1">
                        {parsedTimeseries?.startTs && parsedTimeseries?.endTs
                          ? `${formatTimestampClientSafe(parsedTimeseries.startTs, mounted)} → ${formatTimestampClientSafe(
                              parsedTimeseries.endTs,
                              mounted
                            )}`
                          : "Run triage to load timeseries."}
                      </div>
                    </div>

                    <div className="text-xs text-gray-500">
                      {parsedTimeseries?.bucketSeconds ? `bucket=${parsedTimeseries.bucketSeconds}s` : "bucket=n/a"}
                    </div>
                  </div>

                  {!parsedTimeseries || parsedTimeseries.points.length === 0 ? (
                    <div className="text-sm text-gray-500 mt-3">No timeseries yet (run triage).</div>
                  ) : (
                    <TimeseriesPanel points={parsedTimeseries.points} mounted={mounted} />
                  )}
                </div>

                <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
                  <div className="font-medium text-gray-900 mb-2">Summary</div>
                  <pre className="whitespace-pre-wrap text-sm text-gray-700 font-mono">
                    {summaryText || "Run triage to see results..."}
                  </pre>
                </div>

                <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
                  <div className="font-medium text-gray-900 mb-2">Raw metricsJson (for chat later)</div>
                  <pre className="whitespace-pre-wrap text-xs text-gray-600 font-mono overflow-auto max-h-64">
                    {metricsJson ? JSON.stringify(metricsJson, null, 2) : "No metricsJson yet."}
                  </pre>
                </div>
              </div>

              {/* Right: Chat */}
              <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm flex flex-col h-[680px] min-w-0">
                <div className="font-medium text-gray-900 mb-3">Chat (deterministic for now)</div>

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
                        <pre className="whitespace-pre-wrap text-sm text-gray-900">{msg.text}</pre>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="text-xs text-gray-400 mb-3">{isLoading ? "⏳" : "\u00A0"}</div>

                <div className="space-y-2">
                  <div className="flex gap-2">
                    <input
                      type="text"
                      disabled={isLoading}
                      className="flex-1 rounded-lg border border-gray-300 bg-white text-gray-900 px-3 py-2 text-sm
                                 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 placeholder-gray-400
                                 disabled:opacity-60 disabled:cursor-not-allowed"
                      placeholder="Try: service=vod region=usw2 pop=sjc win=60"
                      value={chatInput}
                      onChange={(e) => setChatInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.shiftKey) {
                          e.preventDefault();
                          handleChatSend();
                        }
                      }}
                    />
                    <button
                      onClick={handleChatSend}
                      disabled={isLoading || !chatInput.trim()}
                      className="px-4 py-2 bg-blue-600 text-white font-semibold rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                    >
                      {isLoading ? "Running..." : "Send"}
                    </button>
                  </div>

                  <div className="text-xs text-gray-500">
                    {chatInput.trim() ? "Enter sends • Shift+Enter for newline" : "Try: service=vod region=usw2 pop=sjc win=60"}
                  </div>
                </div>
              </div>
              {/* /Chat */}
            </div>
          </section>
        </div>
      </div>
    </main>
  );
}

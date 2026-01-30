"use client";

import { useEffect, useMemo, useRef, useState } from "react";

// Configuration
const DEFAULT_CSV_URL =
  "https://raw.githubusercontent.com/kganigap-291992/cdn-triage-bot/refs/heads/main/data/cdn_logs_6h_80k_stresstest.csv";

const STORAGE_KEY = "cdn-triage-history-v1";
const MAX_HISTORY = 10;

// Types
type ChatMessage = {
  id: string;
  role: "system" | "user" | "assistant";
  text: string;
  timestamp: string;
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

// Utility functions
function getCurrentTimestamp(): string {
  return new Date().toISOString();
}

function formatTimestamp(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
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

  const keywords = [
    "service",
    "region",
    "pop",
    "win",
    "window",
    "errors",
    "p95",
    "p99",
    "ttms",
    "triage",
  ];

  return keywords.some((keyword) => normalized.includes(keyword));
}

// Main component
export default function CDNTriageApp() {
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

  // Chat
  const [chatInput, setChatInput] = useState("");
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([
    {
      id: "welcome",
      role: "system",
      text: "Chat ready. Type a message and I'll run triage using the current filters.",
      timestamp: getCurrentTimestamp(),
    },
  ]);

  // Refs
  const chatScrollRef = useRef<HTMLDivElement | null>(null);
  const lastMessageIdRef = useRef<string | null>(null);

  // Load history from localStorage on mount
  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return;

    const parsed = safeParse<TriageRun[]>(stored, []);
    if (Array.isArray(parsed)) setRunHistory(parsed);
  }, []);

  // Save history to localStorage
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(runHistory));
  }, [runHistory]);

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

    // Record user message
    addChatMessage("user", text);
    setChatInput("");
    setErrorMessage("");

    // Guardrail 1: greeting/smalltalk
    if (isGreetingOrSmallTalk(text)) {
      addChatMessage(
        "assistant",
        "Hey! 👋 I can triage CDN logs.\n\nTry:\nservice=vod region=usw2 pop=sjc win=60"
      );
      return;
    }

    // Guardrail 2: not triage intent
    if (!looksLikeTriageQuery(text)) {
      addChatMessage(
        "assistant",
        "I didn't see filters yet.\n\nTry:\nservice=vod region=usw2 pop=sjc win=60"
      );
      return;
    }

    // Parse key=value overrides
    const lowerText = text.toLowerCase();

    const serviceMatch = lowerText.match(/\b(service|svc)\s*=\s*(all|live|vod)\b/);
    const regionMatch = lowerText.match(/\bregion\s*=\s*(all|use1|usw2)\b/);
    const popMatch = lowerText.match(/\bpop\s*=\s*(all|iad|sjc)\b/);
    const windowMatch = lowerText.match(/\b(win|window)\s*=\s*(\d+)\b/);

    const nextService =
     serviceMatch?.[2] ?? service;

    const nextRegion =
      regionMatch?.[1] ?? region;

    const nextPop =
      popMatch?.[1] ?? pop;

    const nextWindow =
       windowMatch?.[2] ? Number(windowMatch[2]) : windowMinutes;


    if (serviceMatch) setService(nextService);
    if (regionMatch) setRegion(nextRegion);
    if (popMatch) setPop(nextPop);
    if (windowMatch) setWindowMinutes(nextWindow);

    if (!canRunTriage) {
      addChatMessage("assistant", "Please upload a CSV or provide a CSV URL first.");
      return;
    }

    addChatMessage(
      "system",
      `Running triage with svc=${nextService}, region=${nextRegion}, pop=${nextPop}, win=${nextWindow}m`
    );

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
      // Optional: completion marker
      // addChatMessage("system", "Done ✅");
    } catch (error: any) {
      const msg = error?.message || "Something went wrong";
      setErrorMessage(msg);
      addChatMessage("assistant", `Error: ${msg}`);
    } finally {
      setIsLoading(false);
    }
  }

  // History: load run
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

  // History: delete run
  function deleteHistoricalRun(id: string) {
    setRunHistory((prev) => prev.filter((r) => r.id !== id));
    if (selectedRunId === id) {
      setSelectedRunId(null);
      setSummaryText("");
      setMetricsJson(null);
    }
  }

  // History: clear all
  function clearAllHistory() {
    setRunHistory([]);
    setSelectedRunId(null);
    setSummaryText("");
    setMetricsJson(null);
  }

  // UI: Metric card
  function MetricCard({
    label,
    value,
    subtitle,
  }: {
    label: string;
    value: string;
    subtitle?: string | null;
  }) {
    return (
      <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
        <div className="text-xs text-gray-600 font-medium">{label}</div>
        <div className="text-3xl font-bold mt-2 text-gray-900">{value}</div>
        {subtitle && <div className="text-xs text-gray-500 mt-2">{subtitle}</div>}
      </div>
    );
  }

  return (
    <main className="min-h-screen bg-gray-50 p-6">
      <div className="mx-auto max-w-7xl">
        <h1 className="text-2xl font-bold text-gray-900 mb-6">CDN Triage UI (REPO)</h1>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          {/* Sidebar: History */}
          <aside className="lg:col-span-3">
            <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
              <div className="flex items-center justify-between mb-4">
                <h2 className="font-semibold text-gray-900 text-sm">
                  Run History (last {MAX_HISTORY})
                </h2>
                <button
                  onClick={clearAllHistory}
                  disabled={runHistory.length === 0}
                  className="text-xs text-gray-600 hover:text-gray-900 px-2 py-1 rounded border border-gray-300 disabled:opacity-50 disabled:cursor-not-allowed hover:bg-gray-50"
                >
                  Clear
                </button>
              </div>

              {runHistory.length === 0 ? (
                <div className="text-sm text-gray-500">
                  No history yet. Run triage once and it will appear here.
                </div>
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
                          isActive
                            ? "bg-blue-50 border-blue-300"
                            : "bg-white border-gray-200 hover:bg-gray-50"
                        }`}
                      >
                        <div className="text-xs font-semibold text-gray-900">
                          {formatTimestamp(run.timestamp)}
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
          <section className="lg:col-span-9">
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
              {/* Left: Triage UI */}
              <div className="space-y-4">
                <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
                  <div className="space-y-4">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-2">
                        CSV URL
                      </label>
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
                      <label className="block text-sm font-medium text-gray-700 mb-2">
                        Or upload CSV
                      </label>
                      <input
                        type="file"
                        accept=".csv,text/csv"
                        onChange={(e) => setUploadedFile(e.target.files?.[0] ?? null)}
                        className="text-sm text-gray-700"
                        disabled={isLoading}
                      />
                      {uploadedFile && (
                        <div className="text-xs text-gray-600 mt-2">
                          Selected: {uploadedFile.name}
                        </div>
                      )}
                      <div className="text-xs text-gray-500 mt-2">
                        Note: history can reload URL-based runs. File uploads can't be reloaded
                        (browser limitation).
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-2">
                          Service
                        </label>
                        <select
                          className="w-full rounded-lg border border-gray-300 bg-white text-gray-900 px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                          value={service}
                          onChange={(e) => setService(e.target.value)}
                          disabled={isLoading}
                        >
                          <option value="all">all</option>
                          <option value="live">live</option>
                          <option value="vod">vod</option>
                        </select>
                      </div>

                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-2">
                          Region
                        </label>
                        <select
                          className="w-full rounded-lg border border-gray-300 bg-white text-gray-900 px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                          value={region}
                          onChange={(e) => setRegion(e.target.value)}
                          disabled={isLoading}
                        >
                          <option value="all">all</option>
                          <option value="use1">use1</option>
                          <option value="usw2">usw2</option>
                        </select>
                      </div>

                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-2">
                          POP
                        </label>
                        <select
                          className="w-full rounded-lg border border-gray-300 bg-white text-gray-900 px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                          value={pop}
                          onChange={(e) => setPop(e.target.value)}
                          disabled={isLoading}
                        >
                          <option value="all">all</option>
                          <option value="iad">iad</option>
                          <option value="sjc">sjc</option>
                        </select>
                      </div>

                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-2">
                          Window (minutes)
                        </label>
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
                          className="flex-1 overflow-y-auto rounded-lg border border-gray-200 p-4 bg-gray-50 mb-2"
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
                    <MetricCard
                      label="totalRequests"
                      value={parsedMetrics.totalRequests.toLocaleString()}
                    />
                    <MetricCard
                      label="p95TtmsMs"
                      value={
                        parsedMetrics.p95TtmsMs == null
                          ? "n/a"
                          : `${Math.round(parsedMetrics.p95TtmsMs)} ms`
                      }
                    />
                    <MetricCard
                      label="p99TtmsMs"
                      value={
                        parsedMetrics.p99TtmsMs == null
                          ? "n/a"
                          : `${Math.round(parsedMetrics.p99TtmsMs)} ms`
                      }
                    />
                    <MetricCard
                      label="errorRate (5xx)"
                      value={
                        parsedMetrics.errorRatePct == null
                          ? "n/a"
                          : `${parsedMetrics.errorRatePct.toFixed(2)}%`
                      }
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
                  <pre className="whitespace-pre-wrap text-sm text-gray-700 font-mono">
                    {summaryText || "Run triage to see results..."}
                  </pre>
                </div>

                <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
                  <div className="font-medium text-gray-900 mb-2">
                    Raw metricsJson (for chat later)
                  </div>
                  <pre className="whitespace-pre-wrap text-xs text-gray-600 font-mono overflow-auto max-h-64">
                    {metricsJson ? JSON.stringify(metricsJson, null, 2) : "No metricsJson yet."}
                  </pre>
                </div>
              </div>

              {/* Right: Chat */}
              <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm flex flex-col h-[680px]">
                <div className="font-medium text-gray-900 mb-3">Chat (deterministic for now)</div>

                <div
                  ref={chatScrollRef}
                  className="flex-1 overflow-y-auto rounded-lg border border-gray-200 p-4 bg-white mb-2"
                >
                  <div className="space-y-4">
                    {chatMessages.map((msg) => (
                      <div key={msg.id}>
                        <div className="text-xs text-gray-500 mb-1">
                          <span className="font-medium capitalize text-gray-700">{msg.role}</span>{" "}
                          • {formatTimestamp(msg.timestamp)}
                        </div>
                        <pre className="whitespace-pre-wrap text-sm text-gray-900">{msg.text}</pre>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Running indicator (emoji-only, subtle) */}
                <div className="text-xs text-gray-400 mb-3">
                  {isLoading ? "⏳" : "\u00A0"}
                </div>

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
                    {chatInput.trim()
                      ? "Enter sends • Shift+Enter for newline"
                      : "Try: service=vod region=usw2 pop=sjc win=60"}
                  </div>
                </div>
              </div>
            </div>
          </section>
        </div>
      </div>
    </main>
  );
}

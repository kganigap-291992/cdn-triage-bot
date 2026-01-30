"use client";

import { useEffect, useMemo, useState } from "react";

const DEFAULT_URL =
  "https://raw.githubusercontent.com/kganigap-291992/cdn-triage-bot/refs/heads/main/data/cdn_logs_6h_80k_stresstest.csv";

const STORAGE_KEY = "cdn-triage-history-v1";
const MAX_HISTORY = 10;

function nowIso() {
  return new Date().toISOString();
}

function shortTime(iso: string) {
  try {
    const d = new Date(iso);
    return d.toLocaleString();
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

type ChatMsg = {
  id: string;
  role: "system" | "user" | "assistant";
  text: string;
  ts: string;
};

function normalizeText(s: string) {
  return (s || "").trim().toLowerCase();
}

function isGreetingOrSmalltalk(s: string) {
  const t = normalizeText(s);
  if (!t) return true;

  if (t.length <= 3) return ["hi", "hey", "yo", "ok", "k"].includes(t);

  const patterns = [
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

  return patterns.some((p) => p.test(t));
}

function looksLikeTriageQuery(s: string) {
  const t = normalizeText(s);
  if (!t) return false;

  if (t.includes("=")) return true;

  const keywords = ["service", "region", "pop", "win", "window", "errors", "p95", "p99", "ttms"];
  return keywords.some((k) => t.includes(k));
}

export default function Home() {
  // Inputs
  const [csvUrl, setCsvUrl] = useState(DEFAULT_URL);
  const [file, setFile] = useState<File | null>(null);

  const [service, setService] = useState("all");
  const [region, setRegion] = useState("all");
  const [pop, setPop] = useState("all");
  const [windowMinutes, setWindowMinutes] = useState(60);
  const [debug, setDebug] = useState(false);

  // Output
  const [loading, setLoading] = useState(false);
  const [summaryText, setSummaryText] = useState("");
  const [metricsJson, setMetricsJson] = useState<any>(null);
  const [error, setError] = useState("");

  // History
  const [history, setHistory] = useState<any[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);

  // Chat
  const [chatInput, setChatInput] = useState("");
  const [messages, setMessages] = useState<ChatMsg[]>([
    {
      id: "sys-1",
      role: "system",
      text: "Chat ready. Type a message and I’ll run triage using the current filters.",
      ts: nowIso(),
    },
  ]);

  function addMsg(role: ChatMsg["role"], text: string) {
    setMessages((prev) => [
      ...prev,
      { id: `${Date.now()}-${Math.random()}`, role, text, ts: nowIso() },
    ]);
  }

  // Load history once on mount
  useEffect(() => {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const parsed = safeParse<any[]>(raw, []);
    if (Array.isArray(parsed)) setHistory(parsed);
  }, []);

  // Persist history
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(history));
  }, [history]);

  const canRun = useMemo(() => {
    return Boolean(file) || (csvUrl && csvUrl.trim().length > 0);
  }, [file, csvUrl]);

  const topMetrics = useMemo(() => {
    if (!metricsJson) return null;

    const totalRequests = Number(metricsJson.totalRequests) || 0;

    const p95TtmsMs = metricsJson.p95TtmsMs == null ? null : Number(metricsJson.p95TtmsMs);
    const p99TtmsMs = metricsJson.p99TtmsMs == null ? null : Number(metricsJson.p99TtmsMs);

    const error5xxCount =
      metricsJson.error5xxCount == null ? null : Number(metricsJson.error5xxCount);

    const errorRatePct = metricsJson.errorRatePct == null ? null : Number(metricsJson.errorRatePct);

    return { totalRequests, p95TtmsMs, p99TtmsMs, error5xxCount, errorRatePct };
  }, [metricsJson]);

  function MetricCard({
    label,
    value,
    sub,
  }: {
    label: string;
    value: string;
    sub?: string | null;
  }) {
    return (
      <div className="rounded-xl border p-3">
        <div className="text-xs text-gray-600">{label}</div>
        <div className="text-2xl font-bold mt-1">{value}</div>
        {sub ? <div className="text-xs text-gray-500 mt-1">{sub}</div> : null}
      </div>
    );
  }

  async function runTriageRequest({
    csvUrlArg,
    fileArg,
    serviceArg,
    regionArg,
    popArg,
    windowMinutesArg,
    debugArg,
  }: {
    csvUrlArg: string;
    fileArg: File | null;
    serviceArg: string;
    regionArg: string;
    popArg: string;
    windowMinutesArg: number;
    debugArg: boolean;
  }) {
    const fd = new FormData();
    fd.append("csvUrl", csvUrlArg || "");
    fd.append("service", serviceArg);
    fd.append("region", regionArg);
    fd.append("pop", popArg);
    fd.append("windowMinutes", String(windowMinutesArg));

    if (fileArg) fd.append("file", fileArg);
    if (debugArg) fd.append("debug", "true");

    const resp = await fetch("/api/triage", {
      method: "POST",
      body: fd,
    });

    const data = await resp.json();
    if (!data.ok) throw new Error(data.error || "Request failed");
    return data;
  }

  async function onRun() {
    setError("");
    setSummaryText("");
    setMetricsJson(null);
    setSelectedRunId(null);

    if (!canRun) {
      setError("Please provide a CSV URL or upload a CSV file.");
      return;
    }

    setLoading(true);

    try {
      const data = await runTriageRequest({
        csvUrlArg: csvUrl,
        fileArg: file,
        serviceArg: service,
        regionArg: region,
        popArg: pop,
        windowMinutesArg: windowMinutes,
        debugArg: debug,
      });

      setSummaryText(data.summaryText || "");
      setMetricsJson(data.metricsJson || null);

      const run = {
        id: `${Date.now()}`,
        ts: nowIso(),
        inputs: {
          csvUrl: file ? "" : (csvUrl || ""),
          fileName: file ? file.name : "",
          service,
          region,
          pop,
          windowMinutes,
          debug: !!debug,
        },
        summaryText: data.summaryText || "",
        metricsJson: data.metricsJson || null,
      };

      setHistory((prev) => [run, ...prev].slice(0, MAX_HISTORY));
    } catch (e: any) {
      setError(e?.message || "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  async function handleChatSend() {
    const text = chatInput.trim();
    if (!text) return;

    if (loading) return;

    // Record user message once
    addMsg("user", text);
    setChatInput("");
    setError("");

    // Guardrail: greetings / smalltalk
    if (isGreetingOrSmalltalk(text)) {
      addMsg(
        "assistant",
        "Hey! 👋 I can triage CDN logs.\n\nTry:\nservice=vod region=usw2 pop=sjc win=60"
      );
      return;
    }

    // Guardrail: not triage intent
    if (!looksLikeTriageQuery(text)) {
      addMsg(
        "assistant",
        "I didn’t see filters yet.\n\nTry:\nservice=vod region=usw2 pop=sjc win=60"
      );
      return;
    }

    // Parse key=value overrides
    const lower = text.toLowerCase();

    const svcMatch = lower.match(/\b(service|svc)\s*=\s*(all|live|vod)\b/);
    const regionMatch = lower.match(/\bregion\s*=\s*(all|use1|usw2)\b/);
    const popMatch = lower.match(/\bpop\s*=\s*(all|iad|sjc)\b/);
    const winMatch = lower.match(/\b(win|window)\s*=\s*(\d+)\b/);

    const nextService = svcMatch ? svcMatch[2] : service;
    const nextRegion = regionMatch ? regionMatch[2] : region;
    const nextPop = popMatch ? popMatch[2] : pop;
    const nextWindow = winMatch ? Number(winMatch[2]) : windowMinutes;

    if (svcMatch) setService(nextService);
    if (regionMatch) setRegion(nextRegion);
    if (popMatch) setPop(nextPop);
    if (winMatch) setWindowMinutes(nextWindow);

    if (!canRun) {
      addMsg("assistant", "Please upload a CSV or provide a CSV URL first.");
      return;
    }

    addMsg(
      "system",
      `Running triage with svc=${nextService}, region=${nextRegion}, pop=${nextPop}, win=${nextWindow}m`
    );

    setLoading(true);
    try {
      const data = await runTriageRequest({
        csvUrlArg: csvUrl,
        fileArg: file,
        serviceArg: nextService,
        regionArg: nextRegion,
        popArg: nextPop,
        windowMinutesArg: nextWindow,
        debugArg: debug,
      });

      setSummaryText(data.summaryText || "");
      setMetricsJson(data.metricsJson || null);
      setSelectedRunId(null);

      const run = {
        id: `${Date.now()}`,
        ts: nowIso(),
        inputs: {
          csvUrl: file ? "" : (csvUrl || ""),
          fileName: file ? file.name : "",
          service: nextService,
          region: nextRegion,
          pop: nextPop,
          windowMinutes: nextWindow,
          debug: !!debug,
        },
        summaryText: data.summaryText || "",
        metricsJson: data.metricsJson || null,
      };

      setHistory((prev) => [run, ...prev].slice(0, MAX_HISTORY));

      addMsg("assistant", data.summaryText || "(no summaryText)");
    } catch (e: any) {
      const msg = e?.message || "Something went wrong";
      setError(msg);
      addMsg("assistant", `Error: ${msg}`);
    } finally {
      setLoading(false);
    }
  }

  function loadRun(run: any) {
    setSelectedRunId(run.id);
    setError("");
    setSummaryText(run.summaryText || "");
    setMetricsJson(run.metricsJson || null);

    // Restore inputs (file cannot be restored)
    setFile(null);
    setCsvUrl(run.inputs?.csvUrl || DEFAULT_URL);
    setService(run.inputs?.service || "all");
    setRegion(run.inputs?.region || "all");
    setPop(run.inputs?.pop || "all");
    setWindowMinutes(Number(run.inputs?.windowMinutes || 60));
    setDebug(!!run.inputs?.debug);
  }

  function deleteRun(id: string) {
    setHistory((prev) => prev.filter((r) => r.id !== id));
    if (selectedRunId === id) {
      setSelectedRunId(null);
      setSummaryText("");
      setMetricsJson(null);
    }
  }

  function clearHistory() {
    setHistory([]);
    setSelectedRunId(null);
    setSummaryText("");
    setMetricsJson(null);
  }

  return (
    <main className="min-h-screen p-6">
      <div className="mx-auto max-w-6xl">
        <h1 className="text-2xl font-bold mb-4">CDN Triage UI (REPO)</h1>

        <div className="grid grid-cols-1 md:grid-cols-12 gap-4">
          {/* History Sidebar */}
          <aside className="md:col-span-4 rounded-xl border p-4">
            <div className="flex items-center justify-between mb-3">
              <div className="font-medium">Run History (last {MAX_HISTORY})</div>
              <button
                onClick={clearHistory}
                className="text-sm rounded-md border px-2 py-1"
                disabled={history.length === 0}
              >
                Clear
              </button>
            </div>

            {history.length === 0 ? (
              <div className="text-sm text-gray-600">
                No history yet. Run triage once and it will appear here.
              </div>
            ) : (
              <div className="space-y-2">
                {history.map((run) => {
                  const active = run.id === selectedRunId;
                  const inp = run.inputs || {};
                  const title = inp.fileName
                    ? `file: ${inp.fileName}`
                    : `url: ${inp.csvUrl ? "csv" : "n/a"}`;

                  const subtitle = `svc=${inp.service} region=${inp.region} pop=${inp.pop} win=${inp.windowMinutes}m`;

                  return (
                    <div
                      key={run.id}
                      className={`rounded-lg border p-3 ${active ? "bg-gray-50" : ""}`}
                    >
                      <div className="text-sm font-semibold">{shortTime(run.ts)}</div>
                      <div className="text-xs text-gray-700 mt-1">{subtitle}</div>
                      <div className="text-xs text-gray-500 mt-1">{title}</div>

                      <div className="flex gap-2 mt-2">
                        <button
                          onClick={() => loadRun(run)}
                          className="text-sm rounded-md border px-2 py-1"
                        >
                          Load
                        </button>
                        <button
                          onClick={() => deleteRun(run.id)}
                          className="text-sm rounded-md border px-2 py-1"
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </aside>

          {/* Main Panel */}
          <section className="md:col-span-8">
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              {/* LEFT: Triage UI */}
              <div className="space-y-4">
                {/* Inputs */}
                <div className="rounded-xl border p-4 space-y-4">
                  <div>
                    <label className="block font-medium mb-2">CSV URL</label>
                    <input
                      className="w-full rounded-lg border px-3 py-2"
                      value={csvUrl}
                      onChange={(e) => setCsvUrl(e.target.value)}
                      placeholder="https://..."
                    />
                  </div>

                  <div>
                    <label className="block font-medium mb-2">Or upload CSV</label>
                    <input
                      type="file"
                      accept=".csv,text/csv"
                      onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                    />
                    {file ? <div className="text-sm mt-1">Selected: {file.name}</div> : null}
                    <div className="text-xs text-gray-500 mt-1">
                      Note: history can reload URL-based runs. File uploads can’t be reloaded (browser
                      limitation).
                    </div>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
                    <div>
                      <label className="block font-medium mb-2">Service</label>
                      <select
                        className="w-full rounded-lg border px-3 py-2"
                        value={service}
                        onChange={(e) => setService(e.target.value)}
                      >
                        <option value="all">all</option>
                        <option value="live">live</option>
                        <option value="vod">vod</option>
                      </select>
                    </div>

                    <div>
                      <label className="block font-medium mb-2">Region</label>
                      <select
                        className="w-full rounded-lg border px-3 py-2"
                        value={region}
                        onChange={(e) => setRegion(e.target.value)}
                      >
                        <option value="all">all</option>
                        <option value="use1">use1</option>
                        <option value="usw2">usw2</option>
                      </select>
                    </div>

                    <div>
                      <label className="block font-medium mb-2">POP</label>
                      <select
                        className="w-full rounded-lg border px-3 py-2"
                        value={pop}
                        onChange={(e) => setPop(e.target.value)}
                      >
                        <option value="all">all</option>
                        <option value="iad">iad</option>
                        <option value="sjc">sjc</option>
                      </select>
                    </div>

                    <div>
                      <label className="block font-medium mb-2">Window (minutes)</label>
                      <input
                        type="number"
                        className="w-full rounded-lg border px-3 py-2"
                        value={windowMinutes}
                        onChange={(e) => setWindowMinutes(Number(e.target.value))}
                      />
                    </div>
                  </div>

                  <div className="flex items-center justify-between gap-3 flex-wrap">
                    <label className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={debug}
                        onChange={(e) => setDebug(e.target.checked)}
                      />
                      Enable debug output
                    </label>

                    <button
                      onClick={onRun}
                      disabled={loading}
                      className="rounded-lg border px-4 py-2 font-semibold"
                    >
                      {loading ? "Running..." : "Run Triage"}
                    </button>
                  </div>

                  {error ? (
                    <div className="rounded-lg border border-red-300 p-3">
                      <b>Error:</b> {error}
                    </div>
                  ) : null}
                </div>

                {/* Metric cards */}
                {topMetrics ? (
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                    <MetricCard label="totalRequests" value={topMetrics.totalRequests.toLocaleString()} />
                    <MetricCard
                      label="p95TtmsMs"
                      value={topMetrics.p95TtmsMs == null ? "n/a" : `${Math.round(topMetrics.p95TtmsMs)} ms`}
                    />
                    <MetricCard
                      label="p99TtmsMs"
                      value={topMetrics.p99TtmsMs == null ? "n/a" : `${Math.round(topMetrics.p99TtmsMs)} ms`}
                    />
                    <MetricCard
                      label="errorRate (5xx)"
                      value={topMetrics.errorRatePct == null ? "n/a" : `${topMetrics.errorRatePct.toFixed(2)}%`}
                      sub={
                        topMetrics.error5xxCount == null
                          ? null
                          : `${topMetrics.error5xxCount.toLocaleString()} / ${topMetrics.totalRequests.toLocaleString()}`
                      }
                    />
                  </div>
                ) : null}

                {/* Summary */}
                <div className="rounded-xl border p-4">
                  <div className="font-medium mb-2">Summary</div>
                  <pre className="whitespace-pre-wrap text-sm">
                    {summaryText || "Run triage to see results..."}
                  </pre>
                </div>

                {/* Raw metrics */}
                <div className="rounded-xl border p-4">
                  <div className="font-medium mb-2">Raw metricsJson (for chat later)</div>
                  <pre className="whitespace-pre-wrap text-xs">
                    {metricsJson ? JSON.stringify(metricsJson, null, 2) : "No metricsJson yet."}
                  </pre>
                </div>
              </div>

              {/* RIGHT: Chat panel */}
              <div className="rounded-xl border p-4 flex flex-col h-[680px]">
                <div className="font-medium mb-2">Chat (deterministic for now)</div>

                <div className="flex-1 overflow-auto rounded-lg border p-3 bg-white text-gray-900">
                  <div className="space-y-3">
                    {messages.map((m) => (
                      <div key={m.id} className="text-sm">
                        <div className="text-xs text-gray-500">
                          {m.role} • {shortTime(m.ts)}
                        </div>
                        <pre className="whitespace-pre-wrap text-gray-900">{m.text}</pre>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="mt-3 flex gap-2">
                  <input
                    className="flex-1 rounded-lg border px-3 py-2"
                    placeholder='Try: service=vod region=usw2 pop=sjc win=60'
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
                    className="rounded-lg border px-4 py-2 font-semibold"
                    onClick={handleChatSend}
                    disabled={loading}
                  >
                    Send
                  </button>
                </div>

                {/* helper line (small, muted, intentional) */}
                {!chatInput ? (
                  <div className="text-xs text-gray-500 mt-2">
                    Try: <code className="px-1 py-0.5 rounded bg-gray-100">service=vod region=usw2 pop=sjc win=60</code>
                  </div>
                ) : (
                  <div className="text-xs text-gray-500 mt-2">
                    Enter sends • Shift+Enter for newline
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

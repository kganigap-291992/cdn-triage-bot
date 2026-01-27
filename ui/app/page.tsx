"use client";

import { useEffect, useMemo, useState } from "react";

const DEFAULT_URL =
  "https://raw.githubusercontent.com/kganigap-291992/cdn-triage-bot/refs/heads/main/data/cdn_logs_6h_80k_stresstest.csv";

const STORAGE_KEY = "cdn-triage-history-v1";
const MAX_HISTORY = 10;

function nowIso() {
  return new Date().toISOString();
}

function shortTime(iso) {
  try {
    const d = new Date(iso);
    return d.toLocaleString();
  } catch {
    return iso;
  }
}

function safeParse(json, fallback) {
  try {
    return JSON.parse(json);
  } catch {
    return fallback;
  }
}

export default function Home() {
  // Inputs
  const [csvUrl, setCsvUrl] = useState(DEFAULT_URL);
  const [file, setFile] = useState(null);

  const [service, setService] = useState("all");
  const [region, setRegion] = useState("all");
  const [pop, setPop] = useState("all");
  const [windowMinutes, setWindowMinutes] = useState(60);
  const [debug, setDebug] = useState(false);

  // Output
  const [loading, setLoading] = useState(false);
  const [summaryText, setSummaryText] = useState("");
  const [metricsJson, setMetricsJson] = useState(null);
  const [error, setError] = useState("");

  // History
  const [history, setHistory] = useState([]);
  const [selectedRunId, setSelectedRunId] = useState(null);

  // Load history once on mount
  useEffect(() => {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const parsed = safeParse(raw, []);
    if (Array.isArray(parsed)) setHistory(parsed);
  }, []);

  // Persist history
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(history));
  }, [history]);

  const canRun = useMemo(() => {
    return Boolean(file) || (csvUrl && csvUrl.trim().length > 0);
  }, [file, csvUrl]);

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
      const fd = new FormData();
      fd.append("csvUrl", csvUrl || "");
      fd.append("service", service);
      fd.append("region", region);
      fd.append("pop", pop);
      fd.append("windowMinutes", String(windowMinutes));

      if (file) fd.append("file", file);
      if (debug) fd.append("debug", "true");

      const resp = await fetch("/api/triage", {
        method: "POST",
        body: fd,
      });

      const data = await resp.json();
      if (!data.ok) throw new Error(data.error || "Request failed");

      setSummaryText(data.summaryText || "");
      setMetricsJson(data.metricsJson || null);

      // Save run into history (keep last 10)
      const run = {
        id: `${Date.now()}`, // simple unique id
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

      setHistory((prev) => {
        const next = [run, ...prev];
        return next.slice(0, MAX_HISTORY);
      });
    } catch (e) {
      setError(e?.message || "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  function loadRun(run) {
    setSelectedRunId(run.id);
    setError("");
    setSummaryText(run.summaryText || "");
    setMetricsJson(run.metricsJson || null);

    // Restore inputs (note: file cannot be restored, only csvUrl)
    setFile(null);
    setCsvUrl(run.inputs?.csvUrl || DEFAULT_URL);
    setService(run.inputs?.service || "all");
    setRegion(run.inputs?.region || "all");
    setPop(run.inputs?.pop || "all");
    setWindowMinutes(Number(run.inputs?.windowMinutes || 60));
    setDebug(!!run.inputs?.debug);
  }

  function deleteRun(id) {
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
          <section className="md:col-span-8 space-y-4">
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
                {file ? (
                  <div className="text-sm mt-1">Selected: {file.name}</div>
                ) : null}
                <div className="text-xs text-gray-500 mt-1">
                  Note: history can reload URL-based runs. File uploads can’t be reloaded (browser limitation).
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

            {/* Summary */}
            <div className="rounded-xl border p-4">
              <div className="font-medium mb-2">Summary</div>
              <pre className="whitespace-pre-wrap text-sm">
                {summaryText || "Run triage to see results..."}
              </pre>
            </div>

            {/* Raw metrics (optional, helpful for debugging + future chat) */}
            <div className="rounded-xl border p-4">
              <div className="font-medium mb-2">Raw metricsJson (for chat later)</div>
              <pre className="whitespace-pre-wrap text-xs">
                {metricsJson ? JSON.stringify(metricsJson, null, 2) : "No metricsJson yet."}
              </pre>
            </div>
          </section>
        </div>
      </div>
    </main>
  );
}

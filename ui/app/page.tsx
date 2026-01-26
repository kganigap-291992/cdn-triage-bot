"use client";

import { useMemo, useState } from "react";

const DEFAULT_URL =
  "https://raw.githubusercontent.com/kganigap-291992/cdn-triage-bot/refs/heads/main/data/cdn_logs_6h_80k_stresstest.csv";

export default function Home() {
  const [csvUrl, setCsvUrl] = useState(DEFAULT_URL);
  const [file, setFile] = useState<File | null>(null);

  const [service, setService] = useState("all");
  const [region, setRegion] = useState("all");
  const [pop, setPop] = useState("all");
  const [windowMinutes, setWindowMinutes] = useState<number>(60);

  const [loading, setLoading] = useState(false);
  const [summaryText, setSummaryText] = useState("");
  const [error, setError] = useState("");
  const [debug, setDebug] = useState(false);

  const canRun = useMemo(() => {
    return Boolean(file) || (csvUrl && csvUrl.trim().length > 0);
  }, [file, csvUrl]);

  async function onRun() {
    setError("");
    setSummaryText("");

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

      if (debug) fd.append("debug", "true");
      if (file) fd.append("file", file);

      const resp = await fetch("/api/triage", {
        method: "POST",
        body: fd,
      });

      const data = await resp.json();
      if (!data.ok) throw new Error(data.error || "Request failed");

      setSummaryText(data.summaryText);
    } catch (e: any) {
      setError(e?.message || "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="min-h-screen p-6">
      <div className="mx-auto max-w-4xl space-y-5">
        <h1 className="text-2xl font-bold">CDN Triage UI (v1)</h1>

        <div className="rounded-xl border p-4 space-y-4">
          {/* CSV URL */}
          <div>
            <label className="block font-medium mb-2">CSV URL</label>
            <input
              className="w-full rounded-lg border px-3 py-2"
              value={csvUrl}
              onChange={(e) => setCsvUrl(e.target.value)}
              placeholder="https://..."
            />
          </div>

          {/* File upload */}
          <div>
            <label className="block font-medium mb-2">Or upload CSV</label>
            <input
              type="file"
              accept=".csv,text/csv"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
            {file && (
              <div className="text-sm mt-1">Selected: {file.name}</div>
            )}
          </div>

          {/* Filters */}
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
              <label className="block font-medium mb-2">
                Window (minutes)
              </label>
              <input
                type="number"
                className="w-full rounded-lg border px-3 py-2"
                value={windowMinutes}
                onChange={(e) =>
                  setWindowMinutes(Number(e.target.value))
                }
              />
            </div>
          </div>

          {/* Debug checkbox */}
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={debug}
              onChange={(e) => setDebug(e.target.checked)}
            />
            Enable debug output
          </label>

          {/* Run button */}
          <button
            onClick={onRun}
            disabled={loading}
            className="rounded-lg border px-4 py-2 font-semibold"
          >
            {loading ? "Running..." : "Run Triage"}
          </button>

          {/* Error */}
          {error && (
            <div className="rounded-lg border border-red-300 p-3">
              <b>Error:</b> {error}
            </div>
          )}
        </div>

        {/* Summary */}
        <div className="rounded-xl border p-4">
          <div className="font-medium mb-2">Summary</div>
          <pre className="whitespace-pre-wrap text-sm">
            {summaryText || "Run triage to see results..."}
          </pre>
        </div>
      </div>
    </main>
  );
}

// lib/clickhouse/runClickhouseTriage.ts
// Decision point: mock vs real ClickHouse execution.
// For public repo / no credentials, use mock runner.
// For your VPS setup, call the Cachey Proxy behind Caddy.

import { runMockClickhouseTriage } from "./runMockClickhouseTriage";

export type ClickhouseTriageInputs = {
  partner: string;

  // Core scope filters
  service: string; // live|vod|all
  region: string;  // region|all
  pop: string;     // pop|all

  // Option B filters
  contentType: string; // manifest|segment|api|all
  uaFamily: string;    // web|mobile|...|all

  windowMinutes: number;
  debug: boolean;
};

export type ClickhouseTriageResult = {
  summaryText: string;
  metricsJson: any;
  debugSql?: string;
};

function env(name: string): string {
  return String(process.env[name] ?? "").trim();
}

function isClickhouseTriageResult(x: any): x is ClickhouseTriageResult {
  return (
    x &&
    typeof x === "object" &&
    typeof x.summaryText === "string" &&
    x.metricsJson != null
  );
}

export async function runClickhouseTriage(
  inputs: ClickhouseTriageInputs
): Promise<ClickhouseTriageResult> {
  const proxyUrl = env("CACHEY_PROXY_URL");
  const proxyKey = env("CACHEY_PROXY_KEY");

  // Proxy path (Phase 2)
  if (proxyUrl && proxyKey) {
    const url = `${proxyUrl.replace(/\/+$/, "")}/triage`;

    // ✅ Timeout guard (default 12s; adjust later)
    const controller = new AbortController();
    const timeoutMs = Number(env("CACHEY_PROXY_TIMEOUT_MS") || 12000);
    const t = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json",
          "X-CACHEY-KEY": proxyKey,
        },
        body: JSON.stringify(inputs),
        signal: controller.signal,
      });

      if (!resp.ok) {
        // Try JSON first
        let details = "";
        const ct = resp.headers.get("content-type") || "";
        try {
          if (ct.includes("application/json")) {
            const j = await resp.json();
            details = j?.error ? String(j.error) : JSON.stringify(j);
          } else {
            details = await resp.text();
          }
        } catch {
          // ignore
        }

        throw new Error(
          `Proxy triage failed (${resp.status} ${resp.statusText})${details ? `: ${details}` : ""}`
        );
      }

      const data = await resp.json();

      if (!isClickhouseTriageResult(data)) {
        throw new Error(
          "Proxy triage returned an invalid payload (expected {summaryText, metricsJson, debugSql?})."
        );
      }

      return data;
    } catch (e: any) {
      if (e?.name === "AbortError") {
        throw new Error(`Proxy triage timed out after ${timeoutMs}ms`);
      }
      throw e;
    } finally {
      clearTimeout(t);
    }
  }

  // Public / local fallback
  return runMockClickhouseTriage(inputs);
}
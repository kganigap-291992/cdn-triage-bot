import type { AgentResult, EvidenceBundle } from "@/lib/triage/types";

export function cacheAgent(bundle: EvidenceBundle): AgentResult {
  const cacheHit =
    bundle.currentMetrics?.cacheHitRate ?? bundle.derivedMetrics?.cacheHitRate;
  const prevCacheHit = bundle.previousMetrics?.cacheHitRate;
  const cacheDeltaPct = bundle.derivedMetrics?.cacheDeltaPct;

  let status: AgentResult["status"] = "ok";
  const findings: string[] = [];

  if (cacheHit != null) {
    findings.push(`cacheHitRate=${cacheHit.toFixed(2)}`);
  } else {
    findings.push("cacheHitRate=missing");
  }

  if (prevCacheHit != null) {
    findings.push(`previousCacheHitRate=${prevCacheHit.toFixed(2)}`);
  }

  if (cacheDeltaPct != null) {
    findings.push(`cacheDeltaPct=${cacheDeltaPct.toFixed(1)}`);
  }

  // --------------------------------------------------
  // Severity logic
  // Rules:
  // - absolute cache efficiency matters first
  // - negative delta shows degradation
  // - positive delta should not hide poor absolute cache health
  // --------------------------------------------------
  if (cacheHit == null) {
    status = "warn";
  } else {
    // Absolute thresholds
    if (cacheHit < 60) {
      status = "critical";
    } else if (cacheHit < 80) {
      status = "warn";
    }

    // Delta-based escalation
    if (cacheDeltaPct != null) {
      // More negative means cache got worse
      if (cacheDeltaPct <= -25) {
        status = "critical";
      } else if (cacheDeltaPct <= -10 && status === "ok") {
        status = "warn";
      }
    }
  }

  // --------------------------------------------------
  // Summary
  // --------------------------------------------------
  let summary: string;

  if (cacheHit == null) {
    summary = "Cache signal unavailable.";
  } else {
    const base =
      status === "critical"
        ? `Cache efficiency is critically low at ${cacheHit.toFixed(2)}%`
        : status === "warn"
        ? `Cache efficiency is below target at ${cacheHit.toFixed(2)}%`
        : `Cache efficiency looks healthy at ${cacheHit.toFixed(2)}%`;

    const previousText =
      prevCacheHit != null
        ? ` (previous ${prevCacheHit.toFixed(2)}%)`
        : "";

    const deltaText =
      cacheDeltaPct != null
        ? `, ${cacheDeltaPct >= 0 ? "up" : "down"} ${Math.abs(cacheDeltaPct).toFixed(
            1
          )}% vs previous window`
        : "";

    summary = `${base}${previousText}${deltaText}.`;
  }

  return {
    agent: "cache",
    status,
    summary,
    findings,
    graphs: [],
  };
}
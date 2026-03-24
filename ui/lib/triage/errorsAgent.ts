import type { AgentResult, EvidenceBundle } from "@/lib/triage/types";

export function errorsAgent(bundle: EvidenceBundle): AgentResult {
  const errPct = bundle.currentMetrics?.errorRatePct;
  const err5xx = bundle.currentMetrics?.error5xxCount;
  const totalRequests = bundle.currentMetrics?.totalRequests ?? 0;

  const prevErrPct = bundle.previousMetrics?.errorRatePct;
  const errDeltaPct = bundle.derivedMetrics?.errorDeltaPct;

  let status: AgentResult["status"] = "ok";
  const findings: string[] = [];

  if (err5xx != null) findings.push(`error5xxCount=${Math.round(err5xx)}`);
  else findings.push("error5xxCount=missing");

  if (errPct != null) findings.push(`errorRatePct=${errPct.toFixed(2)}`);
  else findings.push("errorRatePct=missing");

  if (prevErrPct != null) {
    findings.push(`previousErrorRatePct=${prevErrPct.toFixed(2)}`);
  }

  if (errDeltaPct != null) {
    findings.push(`errorDeltaPct=${errDeltaPct.toFixed(1)}`);
  }

  findings.push(`totalRequests=${Math.round(totalRequests)}`);

  // --------------------------------------------------
  // Severity logic
  // Rules:
  // - rate matters
  // - absolute 5xx count matters for large windows
  // - deltas add trend context
  // - tiny traffic windows should not overreact too easily
  // --------------------------------------------------
  if (errPct == null && err5xx == null) {
    status = "warn";
  } else {
    const lowVolume = totalRequests > 0 && totalRequests < 1000;

    // Rate-based severity
    if (errPct != null) {
      if (errPct >= 1.0) {
        status = "critical";
      } else if (errPct >= 0.2) {
        status = "warn";
      }

      // In very low-volume windows, avoid overreacting to a tiny sample
      if (lowVolume && errPct < 5.0 && status === "warn") {
        status = "ok";
        findings.push("lowVolumeWindow=true");
      }
    }

    // Count-based escalation
    if (err5xx != null) {
      if (err5xx >= 10000) {
        status = "critical";
      } else if (err5xx >= 1000 && status !== "critical") {
        status = "warn";
      }
    }

    // Delta-based escalation
    if (errDeltaPct != null) {
      if (errDeltaPct >= 200) {
        status = "critical";
      } else if (errDeltaPct >= 100 && status === "ok") {
        status = "warn";
      }
    }
  }

  // --------------------------------------------------
  // Summary
  // --------------------------------------------------
  let summary: string;

  if (errPct == null && err5xx == null) {
    summary = "Error signal unavailable.";
  } else {
    const base =
      status === "critical"
        ? `Errors are critically elevated${errPct != null ? ` at ${errPct.toFixed(2)}% 5xx rate` : ""}`
        : status === "warn"
        ? `Errors are elevated${errPct != null ? ` at ${errPct.toFixed(2)}% 5xx rate` : ""}`
        : `Errors are under control${errPct != null ? ` at ${errPct.toFixed(2)}% 5xx rate` : ""}`;

    const countText =
      err5xx != null
        ? ` with ${Math.round(err5xx).toLocaleString()} 5xx responses`
        : "";

    const deltaText =
      errDeltaPct != null
        ? `, ${errDeltaPct >= 0 ? "up" : "down"} ${Math.abs(errDeltaPct).toFixed(
            1
          )}% vs previous window`
        : "";

    const lowVolumeText =
      totalRequests > 0 && totalRequests < 1000
        ? ` across a low-volume window (${Math.round(totalRequests).toLocaleString()} requests)`
        : "";

    summary = `${base}${countText}${deltaText}${lowVolumeText}.`;
  }

  return {
    agent: "errors",
    status,
    summary,
    findings,
    graphs: [],
  };
}
// ui/components/cards/CompareCard.tsx

import React from "react";

type CompareMetricBlock = {
  current: number | null;
  previous: number | null;
  delta: number | null;
};

type CompareMetrics = {
  traffic?: CompareMetricBlock;
  errors?: CompareMetricBlock;
  latency?: CompareMetricBlock;
  cache?: CompareMetricBlock;
};

type Props = {
  summary: string;
  overallState?: string;
  primarySignal?: string;
  compareMetrics?: CompareMetrics;
};

function getStateColor(state?: string) {
  switch (state) {
    case "ok":
      return "bg-green-500/20 text-green-300 border-green-500/30";
    case "warn":
      return "bg-yellow-500/20 text-yellow-300 border-yellow-500/30";
    case "critical":
      return "bg-red-500/20 text-red-300 border-red-500/30";
    default:
      return "bg-gray-500/20 text-gray-300 border-gray-500/30";
  }
}

function getSignalColor(signal?: string) {
  switch (signal) {
    case "cache":
      return "bg-blue-500/20 text-blue-300 border-blue-500/30";
    case "latency":
      return "bg-purple-500/20 text-purple-300 border-purple-500/30";
    case "errors":
      return "bg-red-500/20 text-red-300 border-red-500/30";
    case "traffic":
      return "bg-green-500/20 text-green-300 border-green-500/30";
    default:
      return "bg-gray-500/20 text-gray-300 border-gray-500/30";
  }
}

function formatStateLabel(state?: string) {
  switch (state) {
    case "ok":
      return "Healthy";
    case "warn":
      return "Degraded";
    case "critical":
      return "Critical";
    default:
      return null;
  }
}

function formatSignalLabel(signal?: string) {
  switch (signal) {
    case "cache":
      return "Cache";
    case "latency":
      return "Latency";
    case "errors":
      return "Errors";
    case "traffic":
      return "Traffic";
    default:
      return null;
  }
}

function splitCompareSummary(summary: string) {
  const text = String(summary || "").trim();

  if (!text) {
    return {
      intro: "",
      current: "",
      previous: "",
    };
  }

  const currentMarker = "\n\nCurrent:";
  const previousMarker = "\n\nPrevious:";

  const currentIdx = text.indexOf(currentMarker);
  const previousIdx = text.indexOf(previousMarker);

  if (currentIdx === -1 || previousIdx === -1) {
    return {
      intro: text,
      current: "",
      previous: "",
    };
  }

  const intro = text.slice(0, currentIdx).trim();
  const current = text
    .slice(currentIdx + currentMarker.length, previousIdx)
    .trim();
  const previous = text
    .slice(previousIdx + previousMarker.length)
    .trim();

  return { intro, current, previous };
}

function extractCachePct(text: string): number | null {
  const match = String(text || "").match(
    /cache(?: performance)?(?: is)?(?: degraded)? at\s+(\d+(?:\.\d+)?)%/i
  );
  if (!match) return null;

  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

function extractErrorPct(text: string): number | null {
  const match = String(text || "").match(
    /errors look normal at\s+(\d+(?:\.\d+)?)%\s+5xx/i
  );
  if (!match) return null;

  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

function extractP95Ms(text: string): number | null {
  const match = String(text || "").match(/p95[= ](\d+(?:\.\d+)?)ms/i);
  if (!match) return null;

  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

function extractRequests(text: string): number | null {
  const match = String(text || "").match(
    /traffic looks normal with\s+([\d,]+)\s+requests/i
  );
  if (!match) return null;

  const value = Number(String(match[1]).replace(/,/g, ""));
  return Number.isFinite(value) ? value : null;
}

function formatNumber(value: number, digits = 2) {
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
}

function formatInteger(value: number) {
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 0,
  }).format(value);
}

function buildCompareVerdictFromMetrics(args: {
  primarySignal?: string;
  compareMetrics?: CompareMetrics;
}) {
  const { primarySignal, compareMetrics } = args;

  if (primarySignal === "cache") {
    const metric = compareMetrics?.cache;
    if (
      metric?.current != null &&
      metric.previous != null &&
      metric.delta != null
    ) {
      const deltaPctPoints = metric.delta * 100;
      const absDelta = formatNumber(Math.abs(deltaPctPoints), 2);

      if (deltaPctPoints > 0.005) {
        return {
          label: `↑ Cache +${absDelta}%`,
          className: "border-green-500/30 bg-green-500/10 text-green-200",
        };
      }

      if (deltaPctPoints < -0.005) {
        return {
          label: `↓ Cache -${absDelta}%`,
          className: "border-red-500/30 bg-red-500/10 text-red-200",
        };
      }

      return {
        label: "→ Cache flat",
        className: "border-white/10 bg-white/10 text-gray-200",
      };
    }
  }

  if (primarySignal === "errors") {
    const metric = compareMetrics?.errors;
    if (
      metric?.current != null &&
      metric.previous != null &&
      metric.delta != null
    ) {
      const absDelta = formatNumber(Math.abs(metric.delta), 3);

      if (metric.delta > 0.0005) {
        return {
          label: `↑ Errors +${absDelta}%`,
          className: "border-red-500/30 bg-red-500/10 text-red-200",
        };
      }

      if (metric.delta < -0.0005) {
        return {
          label: `↓ Errors -${absDelta}%`,
          className: "border-green-500/30 bg-green-500/10 text-green-200",
        };
      }

      return {
        label: "→ Errors flat",
        className: "border-white/10 bg-white/10 text-gray-200",
      };
    }
  }

  if (primarySignal === "latency") {
    const metric = compareMetrics?.latency;
    if (
      metric?.current != null &&
      metric.previous != null &&
      metric.delta != null
    ) {
      const absDelta = Math.abs(Math.round(metric.delta));

      if (metric.delta > 0.5) {
        return {
          label: `↑ Latency +${absDelta}ms`,
          className: "border-red-500/30 bg-red-500/10 text-red-200",
        };
      }

      if (metric.delta < -0.5) {
        return {
          label: `↓ Latency -${absDelta}ms`,
          className: "border-green-500/30 bg-green-500/10 text-green-200",
        };
      }

      return {
        label: "→ Latency flat",
        className: "border-white/10 bg-white/10 text-gray-200",
      };
    }
  }

  if (primarySignal === "traffic") {
    const metric = compareMetrics?.traffic;
    if (
      metric?.current != null &&
      metric.previous != null &&
      metric.previous > 0
    ) {
      const deltaPct = ((metric.current - metric.previous) / metric.previous) * 100;
      const absDelta = formatNumber(Math.abs(deltaPct), 1);

      if (deltaPct > 0.05) {
        return {
          label: `↑ Traffic +${absDelta}%`,
          className: "border-blue-500/30 bg-blue-500/10 text-blue-200",
        };
      }

      if (deltaPct < -0.05) {
        return {
          label: `↓ Traffic -${absDelta}%`,
          className: "border-yellow-500/30 bg-yellow-500/10 text-yellow-200",
        };
      }

      return {
        label: "→ Traffic flat",
        className: "border-white/10 bg-white/10 text-gray-200",
      };
    }
  }

  return null;
}

function buildCompareVerdictFromText(args: {
  summary: string;
  primarySignal?: string;
  currentText: string;
  previousText: string;
}) {
  const { summary, primarySignal, currentText, previousText } = args;

  if (primarySignal === "cache") {
    const currentCache = extractCachePct(currentText);
    const previousCache = extractCachePct(previousText);

    if (currentCache != null && previousCache != null) {
      const delta = currentCache - previousCache;
      const absDelta = Math.abs(delta).toFixed(2);

      if (delta > 0.005) {
        return {
          label: `↑ Cache +${absDelta}%`,
          className: "border-green-500/30 bg-green-500/10 text-green-200",
        };
      }

      if (delta < -0.005) {
        return {
          label: `↓ Cache -${absDelta}%`,
          className: "border-red-500/30 bg-red-500/10 text-red-200",
        };
      }

      return {
        label: "→ Cache flat",
        className: "border-white/10 bg-white/10 text-gray-200",
      };
    }
  }

  if (primarySignal === "errors") {
    const currentErrors = extractErrorPct(currentText);
    const previousErrors = extractErrorPct(previousText);

    if (currentErrors != null && previousErrors != null) {
      const delta = currentErrors - previousErrors;
      const absDelta = Math.abs(delta).toFixed(2);

      if (delta > 0.0005) {
        return {
          label: `↑ Errors +${absDelta}%`,
          className: "border-red-500/30 bg-red-500/10 text-red-200",
        };
      }

      if (delta < -0.0005) {
        return {
          label: `↓ Errors -${absDelta}%`,
          className: "border-green-500/30 bg-green-500/10 text-green-200",
        };
      }

      return {
        label: "→ Errors flat",
        className: "border-white/10 bg-white/10 text-gray-200",
      };
    }
  }

  if (primarySignal === "latency") {
    const currentP95 = extractP95Ms(currentText);
    const previousP95 = extractP95Ms(previousText);

    if (currentP95 != null && previousP95 != null) {
      const delta = currentP95 - previousP95;
      const absDelta = Math.abs(Math.round(delta));

      if (delta > 0.5) {
        return {
          label: `↑ Latency +${absDelta}ms`,
          className: "border-red-500/30 bg-red-500/10 text-red-200",
        };
      }

      if (delta < -0.5) {
        return {
          label: `↓ Latency -${absDelta}ms`,
          className: "border-green-500/30 bg-green-500/10 text-green-200",
        };
      }

      return {
        label: "→ Latency flat",
        className: "border-white/10 bg-white/10 text-gray-200",
      };
    }
  }

  if (primarySignal === "traffic") {
    const currentRequests = extractRequests(currentText);
    const previousRequests = extractRequests(previousText);

    if (currentRequests != null && previousRequests != null && previousRequests > 0) {
      const deltaPct = ((currentRequests - previousRequests) / previousRequests) * 100;
      const absDelta = Math.abs(deltaPct).toFixed(1);

      if (deltaPct > 0.05) {
        return {
          label: `↑ Traffic +${absDelta}%`,
          className: "border-blue-500/30 bg-blue-500/10 text-blue-200",
        };
      }

      if (deltaPct < -0.05) {
        return {
          label: `↓ Traffic -${absDelta}%`,
          className: "border-yellow-500/30 bg-yellow-500/10 text-yellow-200",
        };
      }

      return {
        label: "→ Traffic flat",
        className: "border-white/10 bg-white/10 text-gray-200",
      };
    }
  }

  const text = String(summary || "").toLowerCase();
  const upCount = (text.match(/\bup\b/g) || []).length;
  const downCount = (text.match(/\bdown\b/g) || []).length;

  if (upCount > 0 && downCount === 0) {
    return {
      label: "Worsened",
      className: "border-red-500/30 bg-red-500/10 text-red-200",
    };
  }

  if (downCount > 0 && upCount === 0) {
    return {
      label: "Improved",
      className: "border-green-500/30 bg-green-500/10 text-green-200",
    };
  }

  if (upCount > 0 && downCount > 0) {
    return {
      label: "Changed",
      className: "border-yellow-500/30 bg-yellow-500/10 text-yellow-200",
    };
  }

  return {
    label: "Steady",
    className: "border-white/10 bg-white/10 text-gray-200",
  };
}

function formatCompareMetricValue(signal?: string, value?: number | null) {
  if (value == null) return "—";

  if (signal === "cache") {
    return `${formatNumber(value * 100, 2)}%`;
  }

  if (signal === "errors") {
    return `${formatNumber(value, 3)}%`;
  }

  if (signal === "latency") {
    return `${formatNumber(value, 0)} ms`;
  }

  if (signal === "traffic") {
    return formatInteger(value);
  }

  return formatNumber(value, 2);
}

export default function CompareCard({
  summary,
  overallState,
  primarySignal,
  compareMetrics,
}: Props) {
  const stateLabel = formatStateLabel(overallState);
  const signalLabel = formatSignalLabel(primarySignal);
  const parts = splitCompareSummary(summary);

  const verdict =
    buildCompareVerdictFromMetrics({
      primarySignal,
      compareMetrics,
    }) ??
    buildCompareVerdictFromText({
      summary,
      primarySignal,
      currentText: parts.current,
      previousText: parts.previous,
    });

  const metricBlock =
    primarySignal === "cache"
      ? compareMetrics?.cache
      : primarySignal === "errors"
      ? compareMetrics?.errors
      : primarySignal === "latency"
      ? compareMetrics?.latency
      : primarySignal === "traffic"
      ? compareMetrics?.traffic
      : undefined;

  const showStructuredMetrics =
    metricBlock?.current != null || metricBlock?.previous != null;

  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.04] backdrop-blur p-4 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-xs text-gray-400">Comparison</div>
          <div className="text-sm font-semibold text-gray-100">
            Previous window vs current
          </div>
        </div>

        <div className="flex items-center gap-2 flex-wrap justify-end">
          {stateLabel && (
            <span
              className={`text-xs px-2 py-1 rounded-full border ${getStateColor(
                overallState
              )}`}
            >
              {stateLabel}
            </span>
          )}

          {signalLabel && (
            <span
              className={`text-xs px-2 py-1 rounded-full border ${getSignalColor(
                primarySignal
              )}`}
            >
              {signalLabel}
            </span>
          )}
        </div>
      </div>

      <div className="space-y-3">
        <div
          className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium ${verdict.className}`}
        >
          {verdict.label}
        </div>

        {parts.intro && (
          <div className="text-sm text-gray-200 leading-relaxed">
            {parts.intro}
          </div>
        )}

        {showStructuredMetrics && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="rounded-xl border border-white/10 bg-black/20 p-3">
              <div className="text-xs text-gray-400 mb-1">Current</div>
              <div className="text-base font-semibold text-gray-100">
                {formatCompareMetricValue(primarySignal, metricBlock?.current)}
              </div>
            </div>

            <div className="rounded-xl border border-white/10 bg-black/20 p-3">
              <div className="text-xs text-gray-400 mb-1">Previous</div>
              <div className="text-base font-semibold text-gray-100">
                {formatCompareMetricValue(primarySignal, metricBlock?.previous)}
              </div>
            </div>
          </div>
        )}

        {!showStructuredMetrics && parts.current && (
        <div className="rounded-xl border border-white/10 bg-black/20 p-3">
            <div className="text-xs text-gray-400 mb-1">Current</div>
            <div className="text-sm text-gray-100 leading-relaxed whitespace-pre-wrap">
            {parts.current}
            </div>
        </div>
        )}

        {!showStructuredMetrics && parts.previous && (
        <div className="rounded-xl border border-white/10 bg-black/20 p-3">
            <div className="text-xs text-gray-400 mb-1">Previous</div>
            <div className="text-sm text-gray-100 leading-relaxed whitespace-pre-wrap">
            {parts.previous}
            </div>
        </div>
        )}
      </div>
    </div>
  );
}
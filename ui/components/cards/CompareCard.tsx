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

type CompareSeriesPoint = {
  ts: string;
  value: number | null;
};

type CompareGraph = {
  metricType: "cache" | "latency" | "errors" | "traffic";
  currentSeries: CompareSeriesPoint[];
  previousSeries: CompareSeriesPoint[];
};

type Props = {
  summary: string;
  overallState?: string;
  primarySignal?: string;
  compareMetrics?: CompareMetrics;
  compareGraph?: CompareGraph;
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

function normalizeCachePercent(value?: number | null): number | null {
  if (value == null || !Number.isFinite(Number(value))) return null;
  const n = Number(value);
  return n <= 1 ? n * 100 : n;
}

function metricLabel(signal?: string) {
  switch (signal) {
    case "cache":
      return "Cache hit";
    case "errors":
      return "Error rate";
    case "latency":
      return "p95 latency";
    case "traffic":
      return "Requests";
    default:
      return "Metric";
  }
}

function selectMetricBlock(
  primarySignal?: string,
  compareMetrics?: CompareMetrics
): CompareMetricBlock | undefined {
  if (primarySignal === "cache") return compareMetrics?.cache;
  if (primarySignal === "errors") return compareMetrics?.errors;
  if (primarySignal === "latency") return compareMetrics?.latency;
  if (primarySignal === "traffic") return compareMetrics?.traffic;
  return undefined;
}

function buildCompareVerdictFromMetrics(args: {
  primarySignal?: string;
  compareMetrics?: CompareMetrics;
}) {
  const { primarySignal, compareMetrics } = args;

  if (primarySignal === "cache") {
    const metric = compareMetrics?.cache;
    const current = normalizeCachePercent(metric?.current);
    const previous = normalizeCachePercent(metric?.previous);

    if (current != null && previous != null) {
      const deltaPctPoints = current - previous;
      const absDelta = formatNumber(Math.abs(deltaPctPoints), 2);

      if (deltaPctPoints > 0.05) {
        return {
          label: `↑ Cache +${absDelta}%`,
          className: "border-green-500/30 bg-green-500/10 text-green-200",
        };
      }

      if (deltaPctPoints < -0.05) {
        return {
          label: `↓ Cache ${absDelta}%`,
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
    if (metric?.current != null && metric.previous != null) {
      const delta = Number(metric.current) - Number(metric.previous);
      const absDelta = formatNumber(Math.abs(delta), 3);

      if (delta > 0.01) {
        return {
          label: `↑ Errors +${absDelta}%`,
          className: "border-red-500/30 bg-red-500/10 text-red-200",
        };
      }

      if (delta < -0.01) {
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
    if (metric?.current != null && metric.previous != null) {
      const delta = Number(metric.current) - Number(metric.previous);
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
    const metric = compareMetrics?.traffic;
    if (
      metric?.current != null &&
      metric.previous != null &&
      Number(metric.previous) > 0
    ) {
      const deltaPct =
        ((Number(metric.current) - Number(metric.previous)) / Number(metric.previous)) *
        100;
      const absDelta = formatNumber(Math.abs(deltaPct), 1);

      if (deltaPct > 0.1) {
        return {
          label: `↑ Traffic +${absDelta}%`,
          className: "border-blue-500/30 bg-blue-500/10 text-blue-200",
        };
      }

      if (deltaPct < -0.1) {
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

      if (delta > 0.05) {
        return {
          label: `↑ Cache +${absDelta}%`,
          className: "border-green-500/30 bg-green-500/10 text-green-200",
        };
      }

      if (delta < -0.05) {
        return {
          label: `↓ Cache ${absDelta}% `,
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

      if (delta > 0.01) {
        return {
          label: `↑ Errors +${absDelta}%`,
          className: "border-red-500/30 bg-red-500/10 text-red-200",
        };
      }

      if (delta < -0.01) {
        return {
          label: `↓ Errors ${absDelta}% `,
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
          label: `↓ Latency ${absDelta}ms`,
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

      if (deltaPct > 0.1) {
        return {
          label: `↑ Traffic +${absDelta}%`,
          className: "border-blue-500/30 bg-blue-500/10 text-blue-200",
        };
      }

      if (deltaPct < -0.1) {
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
    const pct = normalizeCachePercent(value);
    return pct == null ? "—" : `${formatNumber(pct, 2)}%`;
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

function formatGraphValue(metricType: CompareGraph["metricType"], value: number | null) {
  if (value == null) return "—";

  if (metricType === "cache") {
    const pct = normalizeCachePercent(value);
    return pct == null ? "—" : `${formatNumber(pct, 2)}%`;
  }

  if (metricType === "errors") {
    return `${formatNumber(value, 3)}%`;
  }

  if (metricType === "latency") {
    return `${formatNumber(value, 0)} ms`;
  }

  if (metricType === "traffic") {
    return formatInteger(value);
  }

  return formatNumber(value, 2);
}

function normalizeGraphSeries(
  metricType: CompareGraph["metricType"],
  series: CompareSeriesPoint[]
) {
  return series
    .map((point) => {
      const raw =
        point?.value == null || !Number.isFinite(Number(point.value))
          ? null
          : Number(point.value);

      const normalized =
        metricType === "cache" ? normalizeCachePercent(raw) : raw;

      return {
        ts: String(point?.ts || ""),
        value: normalized,
      };
    })
    .filter((point) => point.ts);
}

function buildPolylinePoints(
  values: Array<number | null>,
  width: number,
  height: number,
  padX: number,
  padY: number
) {
  const numericValues = values.filter(
    (value): value is number => value != null && Number.isFinite(value)
  );

  if (!numericValues.length) return "";

  const min = Math.min(...numericValues);
  const max = Math.max(...numericValues);
  const span = max - min || 1;
  const usableWidth = Math.max(1, width - padX * 2);
  const usableHeight = Math.max(1, height - padY * 2);
  const count = Math.max(1, values.length - 1);

  return values
    .map((value, index) => {
      if (value == null || !Number.isFinite(value)) return null;

      const x = padX + (index / count) * usableWidth;
      const y = padY + (1 - (value - min) / span) * usableHeight;

      return `${x},${y}`;
    })
    .filter(Boolean)
    .join(" ");
}

function CompareMiniGraph({ compareGraph }: { compareGraph: CompareGraph }) {
  const currentSeries = normalizeGraphSeries(
    compareGraph.metricType,
    compareGraph.currentSeries || []
  );
  const previousSeries = normalizeGraphSeries(
    compareGraph.metricType,
    compareGraph.previousSeries || []
  );

  const pointCount = Math.max(currentSeries.length, previousSeries.length);
  if (!pointCount) return null;

  const currentValues = currentSeries.map((point) => point.value);
  const previousValues = previousSeries.map((point) => point.value);

  const width = 760;
  const height = 180;
  const padX = 16;
  const padY = 14;

  const currentPolyline = buildPolylinePoints(
    currentValues,
    width,
    height,
    padX,
    padY
  );
  const previousPolyline = buildPolylinePoints(
    previousValues,
    width,
    height,
    padX,
    padY
  );

  const latestCurrent =
    currentSeries.length > 0 ? currentSeries[currentSeries.length - 1]?.value ?? null : null;
  const latestPrevious =
    previousSeries.length > 0 ? previousSeries[previousSeries.length - 1]?.value ?? null : null;

  return (
    <div className="rounded-xl border border-white/10 bg-black/20 p-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-xs text-gray-400">Compare graph</div>
          <div className="text-sm font-semibold text-gray-100">
            {metricLabel(compareGraph.metricType)} over time
          </div>
        </div>
        <div className="text-right text-[11px] text-gray-400">
          <div>Current: {formatGraphValue(compareGraph.metricType, latestCurrent)}</div>
          <div>Previous: {formatGraphValue(compareGraph.metricType, latestPrevious)}</div>
        </div>
      </div>

      <div className="mt-3">
        <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-[180px]">
          <line
            x1={padX}
            y1={height - padY}
            x2={width - padX}
            y2={height - padY}
            stroke="rgba(255,255,255,0.08)"
          />
          <line
            x1={padX}
            y1={padY}
            x2={padX}
            y2={height - padY}
            stroke="rgba(255,255,255,0.08)"
          />

          {previousPolyline ? (
            <polyline
              fill="none"
              stroke="rgba(156,163,175,0.95)"
              strokeWidth="2.25"
              strokeDasharray="5 5"
              strokeLinecap="round"
              strokeLinejoin="round"
              points={previousPolyline}
            />
          ) : null}

          {currentPolyline ? (
            <polyline
              fill="none"
              stroke="rgba(59,130,246,0.95)"
              strokeWidth="2.75"
              strokeLinecap="round"
              strokeLinejoin="round"
              points={currentPolyline}
            />
          ) : null}
        </svg>

        <div className="mt-3 flex items-center justify-center gap-5 text-[11px] text-gray-300">
          <div className="flex items-center gap-1.5">
            <span
              className="inline-block h-2.5 w-2.5 rounded-full"
              style={{ background: "rgba(59,130,246,0.95)" }}
            />
            <span>current</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span
              className="inline-block h-2.5 w-2.5 rounded-full"
              style={{ background: "rgba(156,163,175,0.95)" }}
            />
            <span>previous</span>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function CompareCard({
  summary,
  overallState,
  primarySignal,
  compareMetrics,
  compareGraph,
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

  const metricBlock = selectMetricBlock(primarySignal, compareMetrics);

  const showStructuredMetrics =
    metricBlock?.current != null || metricBlock?.previous != null;

  const showCompareGraph =
    compareGraph != null &&
    ((compareGraph.currentSeries?.length ?? 0) > 0 ||
      (compareGraph.previousSeries?.length ?? 0) > 0);

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

        {showCompareGraph ? <CompareMiniGraph compareGraph={compareGraph!} /> : null}

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
// ui/components/cards/ExplainCard.tsx

import React from "react";

type Props = {
  summary: string;
  overallState?: string;
  primarySignal?: string;
  signalDelta?: number | null;
  signalValue?: number | null;
  latencyStatus?: "stable" | "up" | "down" | null;
  errorStatus?: "low" | "high" | null;
  narration?: {
    leadershipSummary: string;
    engineerRead: string;
    nextChecks: string[];
  } | null;
};

function getCacheChipColor(delta?: number | null) {
  if (delta == null || !Number.isFinite(delta)) {
    return "bg-blue-500/20 text-blue-300 border-blue-500/30";
  }

  if (delta < 0) {
    return "bg-red-500/20 text-red-300 border-red-500/30";
  }

  if (delta > 0) {
    return "bg-green-500/20 text-green-300 border-green-500/30";
  }

  return "bg-gray-500/20 text-gray-300 border-gray-500/30";
}

function getCacheChipLabel(args: {
  primarySignal?: string;
  signalDelta?: number | null;
  signalValue?: number | null;
}) {
  if (args.primarySignal !== "cache") return null;

  const value =
    args.signalValue != null && Number.isFinite(args.signalValue)
      ? `${args.signalValue.toFixed(1)}%`
      : null;

  const arrow =
    args.signalDelta == null || !Number.isFinite(args.signalDelta)
      ? "↓"
      : args.signalDelta < 0
      ? "↓"
      : args.signalDelta > 0
      ? "↑"
      : "•";

  return value ? `Cache ${arrow} ${value}` : `Cache ${arrow}`;
}

function getLatencyChip(latencyStatus?: "stable" | "up" | "down" | null) {
  if (!latencyStatus) return null;

  if (latencyStatus === "stable") {
    return {
      label: "Latency ✓ Stable",
      className: "bg-green-500/20 text-green-300 border-green-500/30",
    };
  }

  if (latencyStatus === "up") {
    return {
      label: "Latency ↑ High",
      className: "bg-red-500/20 text-red-300 border-red-500/30",
    };
  }

  return {
    label: "Latency ↓ Lower",
    className: "bg-blue-500/20 text-blue-300 border-blue-500/30",
  };
}

export default function ExplainCard({
  summary,
  primarySignal,
  signalDelta,
  signalValue,
  latencyStatus,
  narration,
}: Props) {
  const cacheChipLabel = getCacheChipLabel({
    primarySignal,
    signalDelta,
    signalValue,
  });

  const latencyChip = getLatencyChip(latencyStatus);

  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.04] backdrop-blur p-4 space-y-3">
      {(cacheChipLabel || latencyChip) && (
        <div className="flex items-center gap-2 flex-wrap">
          {cacheChipLabel && (
            <span
              className={`text-xs px-2 py-1 rounded-full border ${getCacheChipColor(
                signalDelta
              )}`}
            >
              {cacheChipLabel}
            </span>
          )}

          {latencyChip && (
            <span
              className={`text-xs px-2 py-1 rounded-full border ${latencyChip.className}`}
            >
              {latencyChip.label}
            </span>
          )}
        </div>
      )}

      <div>
        <div className="text-xs text-gray-400 mb-1">Telemetry Truth</div>
        <div className="text-sm text-gray-200 leading-relaxed whitespace-pre-wrap">
          {summary}
        </div>
      </div>

      {narration && (
        <div className="mt-3 rounded-xl border border-white/10 bg-white/[0.04] p-3 space-y-2">
          <div className="text-xs text-gray-400">Cachey Insight</div>

          <div className="text-sm text-gray-200 leading-relaxed">
            <span className="text-gray-400">Impact: </span>
            {narration.leadershipSummary}
          </div>

          <div className="text-sm text-gray-200 leading-relaxed">
            <span className="text-gray-400">Triage: </span>
            {narration.engineerRead}
          </div>

          {narration.nextChecks?.length > 0 && (
            <div className="text-xs text-blue-300 mt-1">
              Next checks:
              <ul className="list-disc ml-4 mt-1 space-y-1">
                {narration.nextChecks.map((n, i) => (
                  <li key={`${n}-${i}`}>{n}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
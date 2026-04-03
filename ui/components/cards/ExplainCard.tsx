// ui/components/cards/ExplainCard.tsx

import React from "react";

type Props = {
  summary: string;
  overallState?: string;
  primarySignal?: string;
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

export default function ExplainCard({
  summary,
  overallState,
  primarySignal,
}: Props) {
  const stateLabel = formatStateLabel(overallState);
  const signalLabel = formatSignalLabel(primarySignal);

  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.04] backdrop-blur p-4 space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
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

      <div className="text-sm text-gray-200 leading-relaxed whitespace-pre-wrap">
        {summary}
      </div>
    </div>
  );
}
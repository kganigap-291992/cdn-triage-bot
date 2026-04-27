"use client";

import React from "react";

type CompareMetricBlock = {
  current: number | null;
  previous: number | null;
  delta: number | null;
};

type CompareMetrics = {
  cache?: CompareMetricBlock;
  errors?: CompareMetricBlock;
  latency?: CompareMetricBlock;
  traffic?: CompareMetricBlock;
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

type ExplorationMessage = {
  id: string;
  role: "assistant";
  ts: string;
  title: string;
  summary: string;
  confidenceHint?: string | null;
  metric: string;
  view: "timeseries" | "breakdown";
  displayLabel?: string;
  series?: Array<{ ts: string; value: number | null }>;
  seriesSecondary?: Array<{ ts: string; value: number | null }>;
  rows?: any[];
  spotlight?: {
    key: string;
    title?: string;
    summary?: string;
    series: Array<{ ts: string; value: number | null }>;
    seriesSecondary?: Array<{ ts: string; value: number | null }>;
  };
};

type ConversationThreadProps = {
  chatMessages: any[];
  typing: boolean;
  mounted: boolean;
  chatScrollRef: React.RefObject<HTMLDivElement | null>;
  renderTriageCard: (run: any) => React.ReactNode;
  renderDrillCard: (drill: any, summaryText: string) => React.ReactNode;
  renderStatusBreakdownCard: (breakdown: any) => React.ReactNode;
  renderExplainCard: (payload: {
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
  }) => React.ReactNode;
  renderCompareCard: (payload: {
    summary: string;
    overallState?: string;
    primarySignal?: string;
    compareMetrics?: CompareMetrics;
    compareGraph?: CompareGraph;
  }) => React.ReactNode;
  renderExplorationCard: (payload: ExplorationMessage) => React.ReactNode;
  renderTypingDots: () => React.ReactNode;
  formatUtcYmdHm: (iso: string) => string;
  nowIso: () => string;
};

export default function ConversationThread({
  chatMessages,
  typing,
  mounted,
  chatScrollRef,
  renderTriageCard,
  renderDrillCard,
  renderStatusBreakdownCard,
  renderExplainCard,
  renderCompareCard,
  renderExplorationCard,
  renderTypingDots,
  formatUtcYmdHm,
  nowIso,
}: ConversationThreadProps) {
  return (
    <div
      ref={chatScrollRef}
      className="h-[66vh] min-h-[520px] overflow-y-auto rounded-2xl border border-white/10 bg-black/25 p-4"
    >
      {chatMessages.length === 0 && (
        <div className="flex h-full select-none flex-col items-center justify-center gap-3 text-center">
          <div className="text-5xl opacity-25">🤖</div>
          <div className="text-base font-semibold text-gray-300">
            Run triage to analyze CDN health
          </div>
          <div className="text-sm leading-relaxed text-gray-500">
            Select partner and service,
            <br />
            then press <span className="text-gray-300">Run Triage</span>.
          </div>
          <div className="mt-2 text-xs text-gray-600">
            Or ask in the chat box below using ISO UTC timestamps for absolute windows.
          </div>
        </div>
      )}

      <div className="space-y-4">
        {chatMessages.map((m) => {
          const isUser = m.role === "user";
          const isSystem = m.role === "system";
          const rowAlign = isSystem
            ? "justify-center"
            : isUser
            ? "justify-end"
            : "justify-start";
          const bubbleMax = isUser ? "max-w-[70%]" : "max-w-[82%]";
          const bubbleStyle = isSystem
            ? "border-white/10 bg-white/5 text-gray-300"
            : isUser
            ? "border-white/10 bg-white/10 text-gray-100"
            : "border-white/10 bg-white/5 text-gray-100";

          return (
            <div key={m.id} className={`flex ${rowAlign}`}>
              <div className={`${bubbleMax} w-full`}>
                <div
                  className={`mb-1 text-[10px] text-gray-500 ${
                    isSystem ? "text-center" : isUser ? "text-right" : "text-left"
                  }`}
                >
                  {mounted ? `${formatUtcYmdHm(m.ts)} UTC` : m.ts}
                </div>

                {m.type === "text" && (
                  <div className={`rounded-2xl border ${bubbleStyle} px-4 py-3`}>
                    <pre className="whitespace-pre-wrap text-sm leading-relaxed">
                      {m.text}
                    </pre>
                  </div>
                )}

                {m.type === "triage" && renderTriageCard(m.run)}

                {m.type === "drill" && renderDrillCard(m.drill, m.summaryText)}

                {m.type === "status_breakdown" &&
                  renderStatusBreakdownCard(m.breakdown)}

                {m.type === "explain" &&
                renderExplainCard({
                  summary: m.summary,
                  overallState: m.overallState,
                  primarySignal: m.primarySignal,
                  signalDelta: m.signalDelta ?? null,
                  signalValue: m.signalValue ?? null,
                  latencyStatus: m.latencyStatus ?? null,
                  errorStatus: m.errorStatus ?? null,
                  narration: m.narration ?? null,
                })}

                {m.type === "compare" &&
                  renderCompareCard({
                    summary: m.summary,
                    overallState: m.overallState,
                    primarySignal: m.primarySignal,
                    compareMetrics: m.compareMetrics,
                    compareGraph: m.compareGraph,
                  })}

                {m.type === "exploration" && renderExplorationCard(m)}

                {![
                  "text",
                  "triage",
                  "drill",
                  "status_breakdown",
                  "explain",
                  "compare",
                  "exploration",
                ].includes(m.type) && (
                  <div className="rounded-2xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
                    Unknown message type: {m.type}
                  </div>
                )}
              </div>
            </div>
          );
        })}

        {typing && (
          <div className="flex justify-start">
            <div className="max-w-[82%] w-full">
              <div className="mb-1 text-left text-[10px] text-gray-500">
                {mounted ? `${formatUtcYmdHm(nowIso())} UTC` : nowIso()}
              </div>
              <div className="rounded-2xl border border-white/10 bg-white/5 px-4 py-3">
                {renderTypingDots()}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
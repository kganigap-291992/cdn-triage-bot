export type NextAction = {
  id: string;
  label: string;
  query: string;
};

type ResultType = "triage" | "drill" | "compare" | "explain";

type SignalType = "traffic" | "latency" | "errors" | "cache" | "mixed";

type ResultLike = {
  type?: ResultType | string;
  primarySignal?: SignalType | string;
};

const triageActionsBySignal: Record<SignalType, NextAction[]> = {
  cache: [
    { id: "pop", label: "Which POP has low cache?", query: "show worst pop" },
    { id: "region", label: "Which region is degraded?", query: "show worst region" },
    { id: "host", label: "Which host has low cache?", query: "show worst host" },
  ],
  latency: [
    { id: "region", label: "Where is latency highest?", query: "show worst region" },
    { id: "pop", label: "Which POP is slow?", query: "show worst pop" },
    { id: "host", label: "Which host is slow?", query: "show worst host" },
  ],
  errors: [
    { id: "region", label: "Where are errors highest?", query: "show worst region" },
    { id: "pop", label: "Which POP has most 5xx?", query: "show worst pop" },
    { id: "host", label: "Which host has most errors?", query: "show worst host" },
  ],
  traffic: [
    { id: "region", label: "Which region dropped traffic?", query: "show worst region" },
    { id: "pop", label: "Which POP is impacted?", query: "show worst pop" },
    { id: "host", label: "Which host lost traffic?", query: "show worst host" },
  ],
  mixed: [
    { id: "region", label: "Which region looks worst?", query: "show worst region" },
    { id: "pop", label: "Which POP looks worst?", query: "show worst pop" },
    { id: "host", label: "Which host looks worst?", query: "show worst host" },
  ],
};

export function getNextActions(result: ResultLike | null | undefined): NextAction[] {
  if (!result?.type) return [];

  const type = result.type as ResultType;
  const signal = (result.primarySignal || "mixed") as SignalType;

  switch (type) {
    case "triage":
      return triageActionsBySignal[signal] || triageActionsBySignal.mixed;

    case "drill":
      return [
        { id: "status", label: "Break down status codes", query: "status by host" },
        { id: "compare", label: "Compare this scope", query: "compare this scope" },
        { id: "explain", label: "Explain this result", query: "explain this" },
      ];

    case "compare":
      return [
        { id: "region", label: "Which region drove this change?", query: "show worst region" },
        { id: "host", label: "Which host contributed most?", query: "show worst host" },
        { id: "explain", label: "Explain this delta", query: "explain this delta" },
      ];

    case "explain":
      return [
        { id: "region", label: "Show worst region", query: "show worst region" },
        { id: "host", label: "Show worst host", query: "show worst host" },
        { id: "status", label: "Show status by host", query: "status by host" },
      ];

    default:
      return [];
  }
}
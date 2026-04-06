export type NextAction = {
  id: string;
  label: string;
  query: string;
};

type ResultLike = {
  type?: "triage" | "drill" | "compare" | "explain" | string;
  primarySignal?: "traffic" | "latency" | "errors" | "cache" | "mixed" | string;
};

export function getNextActions(result: ResultLike | null | undefined): NextAction[] {
  if (!result?.type) return [];

  const signal = result.primarySignal;

  const triageActionsBySignal: Record<string, NextAction[]> = {
    cache: [
      { id: "pop", label: "Which POP has low cache?", query: "show worst pop" },
      { id: "region", label: "Which region is degraded?", query: "show worst region" },
      { id: "compare", label: "Compare cache vs previous", query: "compare to previous window" },
    ],
    latency: [
      { id: "region", label: "Where is latency highest?", query: "show worst region" },
      { id: "pop", label: "Which POP is slow?", query: "show worst pop" },
      { id: "compare", label: "Compare latency vs previous", query: "compare to previous window" },
    ],
    errors: [
      { id: "region", label: "Where are errors highest?", query: "show worst region" },
      { id: "pop", label: "Which POP has most 5xx?", query: "show worst pop" },
      { id: "compare", label: "Compare errors vs previous", query: "compare to previous window" },
    ],
    traffic: [
      { id: "region", label: "Which region dropped traffic?", query: "show worst region" },
      { id: "compare", label: "Compare traffic vs previous", query: "compare to previous window" },
      { id: "pop", label: "Which POP is impacted?", query: "show worst pop" },
    ],
  };

  switch (result.type) {
    case "triage": {
      if (signal && triageActionsBySignal[signal]) {
        return triageActionsBySignal[signal];
      }

      return [
        { id: "region", label: "What’s the worst region?", query: "show worst region" },
        { id: "pop", label: "Which POP looks bad?", query: "show worst pop" },
        { id: "compare", label: "Compare to previous window", query: "compare to previous window" },
      ];
    }

    case "drill":
      return [
        { id: "compare", label: "Compare this scope", query: "compare this scope" },
        { id: "explain", label: "Explain this result", query: "explain this" },
        { id: "deeper", label: "Drill further", query: "drill deeper" },
      ];

    case "compare":
      return [
        { id: "region", label: "Which region drove this change?", query: "show worst region" },
        { id: "pop", label: "Which POP contributed most?", query: "show worst pop" },
        { id: "explain", label: "Explain this delta", query: "explain this delta" },
      ];

    case "explain":
      return [
        { id: "region", label: "Show worst region", query: "show worst region" },
        { id: "pop", label: "Show worst POP", query: "show worst pop" },
        { id: "compare", label: "Compare to previous window", query: "compare to previous window" },
      ];

    default:
      return [];
  }
}
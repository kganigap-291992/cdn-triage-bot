export type NextAction = {
  id: string;
  label: string;
  query: string;
};

type ResultLike = {
  type?: string;
};

export function getNextActions(result: ResultLike | null | undefined): NextAction[] {
  if (!result?.type) return [];

  switch (result.type) {
    case "triage":
      return [
        {
          id: "region",
          label: "What’s the worst region?",
          query: "show worst region",
        },
        {
          id: "pop",
          label: "Which POP looks bad?",
          query: "show worst pop",
        },
        {
          id: "compare",
          label: "Compare to previous window",
          query: "compare to previous window",
        },
      ];

    case "drill":
      return [
        {
          id: "compare",
          label: "Compare this scope",
          query: "compare this scope",
        },
        {
          id: "explain",
          label: "Explain this result",
          query: "explain this",
        },
        {
          id: "deeper",
          label: "Drill further",
          query: "drill deeper",
        },
      ];

    case "compare":
      return [
        {
          id: "region",
          label: "Which region drove this change?",
          query: "show worst region",
        },
        {
          id: "pop",
          label: "Which POP contributed most?",
          query: "show worst pop",
        },
        {
          id: "explain",
          label: "Explain this delta",
          query: "explain this delta",
        },
      ];

    case "explain":
      return [
        {
          id: "region",
          label: "Show worst region",
          query: "show worst region",
        },
        {
          id: "pop",
          label: "Show worst POP",
          query: "show worst pop",
        },
        {
          id: "compare",
          label: "Compare to previous window",
          query: "compare to previous window",
        },
      ];

    default:
      return [];
  }
}
export type IntentType =
  | "greeting"
  | "triage"
  | "drill"
  | "compare"
  | "explain"
  | "status_breakdown"
  | "unknown";

function includesAny(text: string, needles: string[]): boolean {
  return needles.some((needle) => text.includes(needle));
}

export function detectIntent(input: string): IntentType {
  let text = input.toLowerCase().trim();

  // normalize common punctuation / phrasing variants
  text = text.replace(/what’s/g, "whats");
  text = text.replace(/break down/g, "breakdown");
  text = text.replace(/status codes/g, "status code");
  text = text.replace(/uafamily/g, "ua family");

  // -----------------------------
  // Greeting
  // -----------------------------
  if (/\b(hi|hello|hey|yo)\b/.test(text)) {
    return "greeting";
  }

  // -----------------------------
  // Compare (highest priority)
  // -----------------------------
  if (
    includesAny(text, [
      "compare",
      "vs",
      "versus",
      "previous",
      "last hour",
      "yesterday",
      "previous window",
      "compared to",
    ])
  ) {
    return "compare";
  }

  // -----------------------------
  // Status breakdown
  // Must stay before drill so
  // "status by pop/region/host" stays status-specific
  // -----------------------------
  const mentionsStatusConcept = includesAny(text, [
    "status code",
    "status",
    "200",
    "206",
    "304",
    "403",
    "404",
    "429",
    "500",
    "502",
    "503",
    "504",
  ]);

  const mentionsStatusViewIntent = includesAny(text, [
    "breakdown",
    "distribution",
    "mix",
    "split",
    "show status",
    "show me status",
    "by pop",
    "by region",
    "by host",
    "per pop",
    "per region",
    "per host",
  ]);

  if (mentionsStatusConcept && mentionsStatusViewIntent) {
    return "status_breakdown";
  }

  // -----------------------------
  // Explain / health-check
  // -----------------------------
  if (
    includesAny(text, [
      "why",
      "explain",
      "whats going on",
      "what is going on",
      "what happened",
      "anything bad",
      "is something wrong",
      "are we good",
      "are we okay",
      "are we ok",
      "any issues",
      "any problem",
      "how are things looking",
    ])
  ) {
    return "explain";
  }

  // -----------------------------
  // Drill
  // -----------------------------
  if (
    includesAny(text, [
      "drill",
      "deep dive",
      "show worst",
      "worst region",
      "worst pop",
      "worst host",
      "worst ua",
      "worst ua family",
      "worst device",
      "worst content",
      "worst content type",
      "which region",
      "which pop",
      "which host",
      "which ua",
      "which device",
      "which content",
      "which content type",
      "bad region",
      "bad pop",
      "bad host",
      "bad ua",
      "bad device",
      "bad content",
      "bad content type",
      "region breakdown",
      "pop breakdown",
      "host breakdown",
      "ua breakdown",
      "device breakdown",
      "content breakdown",
      "content type breakdown",
      "show regions",
      "show pops",
      "show hosts",
      "show ua",
      "show devices",
      "show content",
      "top regions",
      "top pops",
      "top hosts",
      "top ua",
      "top devices",
      "top content",
      "drill deeper",
    ])
  ) {
    return "drill";
  }

  if (
    includesAny(text, [
      "by region",
      "by pop",
      "by host",
      "by ua",
      "by device",
      "by content",
    ]) &&
    !includesAny(text, [
      "status",
      "status code",
      "distribution",
      "breakdown",
      "mix",
      "split",
    ])
  ) {
    return "drill";
  }

  // -----------------------------
  // Triage
  // -----------------------------
  if (
    includesAny(text, [
      "status",
      "current status",
      "how is",
      "how are things",
      "check",
      "check status",
      "investigate",
      "look into",
      "look at",
      "analyze",
      "analyse",
      "traffic",
      "latency",
      "errors",
      "cache",
    ])
  ) {
    return "triage";
  }

  return "unknown";
}
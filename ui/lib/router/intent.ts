export type IntentType =
  | "greeting"
  | "triage"
  | "drill"
  | "compare"
  | "explain"
  | "unknown";

export function detectIntent(input: string): IntentType {
  let text = input.toLowerCase();

  // normalize common punctuation variants
  text = text.replace(/what’s/g, "whats");

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
    text.includes("compare") ||
    text.includes("vs") ||
    text.includes("versus") ||
    text.includes("previous") ||
    text.includes("last hour") ||
    text.includes("yesterday") ||
    text.includes("previous window") ||
    text.includes("compared to")
  ) {
    return "compare";
  }

  // -----------------------------
  // Drill (explicit breakdown / worst)
  // -----------------------------
  if (
    text.includes("drill") ||
    text.includes("breakdown") ||
    text.includes("deep dive") ||
    text.includes("show worst") ||
    text.includes("worst region") ||
    text.includes("worst pop") ||
    text.includes("which region") ||
    text.includes("which pop") ||
    text.includes("bad region") ||
    text.includes("bad pop") ||
    text.includes("by region") ||
    text.includes("by pop")
  ) {
    return "drill";
  }

  // -----------------------------
  // Explain / health-check
  // -----------------------------
  if (
    text.includes("why") ||
    text.includes("explain") ||
    text.includes("whats going on") ||
    text.includes("what is going on") ||
    text.includes("what happened") ||
    text.includes("anything bad") ||
    text.includes("is something wrong") ||
    text.includes("are we good") ||
    text.includes("are we okay") ||
    text.includes("are we ok") ||
    text.includes("any issues") ||
    text.includes("any problem") ||
    text.includes("how are things looking")
  ) {
    return "explain";
  }

  // -----------------------------
  // Triage (status / investigation)
  // -----------------------------
  if (
    text.includes("status") ||
    text.includes("current status") ||
    text.includes("how is") ||
    text.includes("how are things") ||
    text.includes("check") ||
    text.includes("check status") ||
    text.includes("investigate") ||
    text.includes("look into") ||
    text.includes("look at") ||
    text.includes("analyze") ||
    text.includes("analyse") ||
    text.includes("traffic") ||
    text.includes("latency") ||
    text.includes("errors") ||
    text.includes("cache")
  ) {
    return "triage";
  }

  return "unknown";
}
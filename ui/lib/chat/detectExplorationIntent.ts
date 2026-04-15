// ui/lib/chat/detectExplorationIntent.ts

import type {
  ExplorationAtsMode,
  ExplorationIntent,
  ExplorationMetric,
  ExplorationView,
} from "./explorationTypes";

function normalizeText(input: string): string {
  return String(input || "")
    .toLowerCase()
    .trim()
    .replace(/what’s/g, "whats")
    .replace(/break down/g, "breakdown")
    .replace(/uafamily/g, "ua family")
    .replace(/user agent/g, "ua")
    .replace(/content type/g, "content")
    .replace(/\s+/g, " ");
}

function includesAny(text: string, needles: string[]): boolean {
  return needles.some((needle) => text.includes(needle));
}

function detectMetric(text: string): ExplorationMetric | null {
  if (includesAny(text, ["latency", "p95", "p99", "ttms"])) {
    return "latency";
  }

  if (includesAny(text, ["errors", "error", "5xx", "failures", "failure"])) {
    return "errors";
  }

  if (includesAny(text, ["requests", "request", "traffic", "volume"])) {
    return "requests";
  }

  if (includesAny(text, ["ats", "cache"])) {
    return "ats";
  }

  return null;
}

function detectView(text: string): ExplorationView | null {
  if (includesAny(text, ["over time", "trend", "trends", "timeline"])) {
    return "over_time";
  }

  if (includesAny(text, ["by region", "per region"])) {
    return "by_region";
  }

  if (includesAny(text, ["by pop", "per pop"])) {
    return "by_pop";
  }

  if (includesAny(text, ["by ua", "per ua", "by device", "per device"])) {
    return "by_ua";
  }

  if (includesAny(text, ["by content", "per content"])) {
    return "by_content";
  }

  return null;
}

function detectAtsMode(text: string): ExplorationAtsMode | undefined {
  if (!includesAny(text, ["ats", "cache"])) return undefined;

  if (
    includesAny(text, [
      "detailed ats",
      "ats detailed",
      "detailed cache",
      "cache detailed",
      "detailed breakdown",
    ])
  ) {
    return "detailed";
  }

  if (
    includesAny(text, [
      "ats breakdown",
      "cache breakdown",
      "ats split",
      "cache split",
      "ats categories",
      "cache categories",
    ])
  ) {
    return "category";
  }

  return "category";
}

function hasExplorationShape(text: string): boolean {
  return includesAny(text, [
    "over time",
    "trend",
    "trends",
    "timeline",
    "by region",
    "per region",
    "by pop",
    "per pop",
    "by ua",
    "per ua",
    "by device",
    "per device",
    "by content",
    "per content",
  ]);
}

function looksLikeFrozenIntent(text: string): boolean {
  return includesAny(text, [
    "compare",
    "versus",
    "vs",
    "previous",
    "previous window",
    "last hour",
    "yesterday",
    "what changed",
    "explain",
    "why is",
    "why are",
    "what happened",
    "show worst",
    "worst region",
    "worst pop",
    "worst host",
    "worst ua",
    "worst device",
    "worst content",
    "drill",
    "deep dive",
    "status breakdown",
    "status code",
    "show status",
  ]);
}

export function detectExplorationIntent(input: string): ExplorationIntent | null {
  const rawText = String(input || "");
  const text = normalizeText(rawText);

  if (!text) return null;

  // Keep the current frozen rail protected.
  if (looksLikeFrozenIntent(text)) {
    return null;
  }

  if (!hasExplorationShape(text)) {
    return null;
  }

  const metric = detectMetric(text);
  const view = detectView(text);

  if (!metric || !view) {
    return null;
  }

  const atsMode = metric === "ats" ? detectAtsMode(text) : undefined;

  return {
    mode: "exploration",
    metric,
    view,
    atsMode,
    rawText,
  };
}
// ui/lib/chat/detectExplorationIntent.ts

import type {
  ExplorationAtsMode,
  ExplorationIntent,
  ExplorationMetric,
  ExplorationTimeOverride,
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

function computeWindowMinutes(startTsUtc: string, endTsUtc: string): number {
  const startMs = new Date(startTsUtc).getTime();
  const endMs = new Date(endTsUtc).getTime();

  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    return 0;
  }

  return Math.max(1, Math.round((endMs - startMs) / 60000));
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function buildUtcIso(args: {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}): string | null {
  const { year, month, day, hour, minute } = args;

  if (
    !Number.isFinite(year) ||
    !Number.isFinite(month) ||
    !Number.isFinite(day) ||
    !Number.isFinite(hour) ||
    !Number.isFinite(minute)
  ) {
    return null;
  }

  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59
  ) {
    return null;
  }

  const iso = `${year}-${pad2(month)}-${pad2(day)}T${pad2(hour)}:${pad2(minute)}:00.000Z`;
  const dt = new Date(iso);

  if (Number.isNaN(dt.getTime())) return null;

  return dt.toISOString();
}

function detectRelativeTimeOverride(text: string): ExplorationTimeOverride | undefined {
  const match = text.match(
    /\blast\s+(\d+)\s*(m|mins?|minutes?|h|hr|hrs?|hours?)\b/
  );

  if (!match) return undefined;

  const rawValue = Number(match[1]);
  const rawUnit = String(match[2] || "").toLowerCase();

  if (!Number.isFinite(rawValue) || rawValue <= 0) return undefined;

  const isMinutes = /^m|^min|^minute/.test(rawUnit);
  const windowMinutes = isMinutes ? rawValue : rawValue * 60;

  if (!Number.isFinite(windowMinutes) || windowMinutes <= 0) return undefined;

  return {
    mode: "relative",
    windowMinutes,
    sourceText: match[0],
  };
}

function detectAbsoluteTimeOverride(text: string): ExplorationTimeOverride | undefined {
  const betweenMatch = text.match(
    /\bbetween\s+(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})\s+(?:and|-)\s+(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})\s*utc\b/
  );

  const fromToMatch = text.match(
    /\bfrom\s+(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})\s+to\s+(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})\s*utc\b/
  );

  const match = betweenMatch || fromToMatch;
  if (!match) return undefined;

  const startTsUtc = buildUtcIso({
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
  });

  const endTsUtc = buildUtcIso({
    year: Number(match[6]),
    month: Number(match[7]),
    day: Number(match[8]),
    hour: Number(match[9]),
    minute: Number(match[10]),
  });

  if (!startTsUtc || !endTsUtc) return undefined;

  const windowMinutes = computeWindowMinutes(startTsUtc, endTsUtc);
  if (windowMinutes <= 0) return undefined;

  return {
    mode: "absolute",
    startTsUtc,
    endTsUtc,
    windowMinutes,
    sourceText: match[0],
  };
}

function detectTimeOverride(text: string): ExplorationTimeOverride | undefined {
  return detectAbsoluteTimeOverride(text) || detectRelativeTimeOverride(text);
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
  const timeOverride = detectTimeOverride(text);

  return {
    mode: "exploration",
    metric,
    view,
    atsMode,
    timeOverride,
    rawText,
  };
}
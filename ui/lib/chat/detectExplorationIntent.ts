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
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ");
}

function includesAny(text: string, needles: string[]): boolean {
  return needles.some((needle) => text.includes(needle));
}

function detectMetric(text: string): ExplorationMetric | null {
  if (
    includesAny(text, [
      "ats",
      "cache",
      "cache hit",
      "cache miss",
      "hit",
      "hits",
      "miss",
      "misses",
      "refresh",
      "client refresh",
      "client error",
      "client errors",
      "client err",
      "infra error",
      "infra errors",
      "infra err",
      "tcp hit",
      "tcp miss",
      "tcp refresh hit",
      "tcp ref fail hit",
      "tcp client refresh",
      "dns fail",
      "connect fail",
      "read timeout",
      "proxy denied",
    ])
  ) {
    return "ats";
  }

  if (includesAny(text, ["latency", "p95", "p99", "ttms"])) {
    return "latency";
  }

  if (
    includesAny(text, [
      "errors",
      "error",
      "error rate",
      "errors over time",
      "5xx",
      "failure",
      "failures",
    ])
  ) {
    return "errors";
  }

  if (includesAny(text, ["request", "requests", "traffic", "volume"])) {
    return "requests";
  }

  return null;
}

function detectView(text: string): ExplorationView | null {
  if (
    includesAny(text, ["over time", "trend", "trends", "timeline"]) ||
    /\bover\s+(\d+)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)\b/i.test(
      text
    )
  ) {
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

function detectAtsRawCode(text: string): string | null {
  const rawCodePatterns: Array<{ pattern: string; code: string }> = [
    { pattern: "tcp hit", code: "tcp_hit" },
    { pattern: "tcp miss", code: "tcp_miss" },
    { pattern: "tcp refresh hit", code: "tcp_refresh_hit" },
    { pattern: "tcp ref fail hit", code: "tcp_ref_fail_hit" },
    { pattern: "tcp client refresh", code: "tcp_client_refresh" },
    { pattern: "dns fail", code: "err_dns_fail" },
    { pattern: "connect fail", code: "err_connect_fail" },
    { pattern: "read timeout", code: "err_read_timeout" },
    { pattern: "proxy denied", code: "err_proxy_denied" },
  ];

  for (const entry of rawCodePatterns) {
    if (text.includes(entry.pattern)) {
      return entry.code;
    }
  }

  return null;
}

function detectAtsMode(text: string): ExplorationAtsMode | undefined {
  if (
    !includesAny(text, [
      "ats",
      "cache",
      "hit",
      "hits",
      "miss",
      "misses",
      "refresh",
      "client error",
      "client errors",
      "client err",
      "infra error",
      "infra errors",
      "infra err",
      "tcp hit",
      "tcp miss",
      "tcp refresh hit",
      "tcp ref fail hit",
      "tcp client refresh",
      "dns fail",
      "connect fail",
      "read timeout",
      "proxy denied",
    ])
  ) {
    return undefined;
  }

  if (detectAtsRawCode(text)) {
    return "detailed";
  }

  if (
    includesAny(text, [
      "detailed ats",
      "ats detailed",
      "detailed cache",
      "cache detailed",
      "detailed breakdown",
      "raw ats",
      "detailed split",
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
  return (
    includesAny(text, [
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
      "what changed",
      "what increased",
      "what decreased",
      "previous window",
      "vs previous",
      "compare ats",
    ]) ||
    /\bover\s+(\d+)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)\b/i.test(
      text
    )
  );
}

function looksLikeFrozenIntent(text: string): boolean {
  const metric = detectMetric(text);

  if (metric === "ats") {
    const isAtsExplorationCompare = includesAny(text, [
      "compare",
      "vs",
      "previous",
      "previous window",
      "what changed",
      "what increased",
      "what decreased",
    ]);

    if (isAtsExplorationCompare) {
      return false;
    }
  }

  return includesAny(text, [
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

  return `${year}-${pad2(month)}-${pad2(day)}T${pad2(hour)}:${pad2(minute)}:00.000Z`;
}

function detectRelativeTimeOverride(text: string): ExplorationTimeOverride | undefined {
  const patterns: Array<{
    re: RegExp;
    toMinutes: (n: number) => number;
  }> = [
    { re: /\blast\s+(\d+)\s*(m|min|mins|minute|minutes)\b/i, toMinutes: (n) => n },
    { re: /\blast\s+(\d+)\s*(h|hr|hrs|hour|hours)\b/i, toMinutes: (n) => n * 60 },
    { re: /\blast\s+(\d+)\s*(d|day|days)\b/i, toMinutes: (n) => n * 24 * 60 },
    { re: /\bover\s+(\d+)\s*(m|min|mins|minute|minutes)\b/i, toMinutes: (n) => n },
    { re: /\bover\s+(\d+)\s*(h|hr|hrs|hour|hours)\b/i, toMinutes: (n) => n * 60 },
    { re: /\bover\s+(\d+)\s*(d|day|days)\b/i, toMinutes: (n) => n * 24 * 60 },
    { re: /\bfor\s+(\d+)\s*(m|min|mins|minute|minutes)\b/i, toMinutes: (n) => n },
    { re: /\bfor\s+(\d+)\s*(h|hr|hrs|hour|hours)\b/i, toMinutes: (n) => n * 60 },
    { re: /\bfor\s+(\d+)\s*(d|day|days)\b/i, toMinutes: (n) => n * 24 * 60 },
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern.re);
    if (!match) continue;

    const amount = Number(match[1]);
    if (!Number.isFinite(amount) || amount <= 0) continue;

    return {
      mode: "relative",
      windowMinutes: pattern.toMinutes(amount),
      sourceText: match[0],
    };
  }

  return undefined;
}

function detectAbsoluteTimeOverride(text: string): ExplorationTimeOverride | undefined {
  const betweenMatch = text.match(
    /\bbetween\s+(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})\s+and\s+(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})\s*utc\b/
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

  if (looksLikeFrozenIntent(text)) {
    return null;
  }

  if (!hasExplorationShape(text)) {
    return null;
  }

  const metric = detectMetric(text);
  const view = detectView(text) ?? (metric === "ats" ? "over_time" : null);

  if (!metric || !view) {
    return null;
  }

  const atsRawCode = metric === "ats" ? detectAtsRawCode(text) : null;
  const atsMode = metric === "ats" ? detectAtsMode(text) : undefined;
  const timeOverride = detectTimeOverride(text);

  return {
    mode: "exploration",
    metric,
    view,
    atsMode,
    atsRawCode,
    timeOverride,
    rawText,
  };
}
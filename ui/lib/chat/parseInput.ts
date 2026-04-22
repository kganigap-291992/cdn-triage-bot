import { normalizeInput } from "@/lib/chat/normalizeInput";
import {
  createEmptyParserOutput,
  createEmptyScopeChanges,
  type ParserDimension,
  type ParserFamily,
  type ParserLane,
  type ParserMetric,
  type ParserOutput,
  type ParserTimeOverride,
  type ParserView,
} from "./parserContract";

type RepairResult = {
  repairedText: string;
  repairApplied: boolean;
  repairReason: string | null;
};

function applyBoundedRepair(normalizedText: string): RepairResult {
  let text = String(normalizedText || "").trim();
  let changed = false;
  const reasons: string[] = [];

  const replacements: Array<[RegExp, string, string]> = [
    [/\bovertime\b/g, "over time", "split overtime -> over time"],
    [/\bcompare to\b/g, "compare", "normalize compare phrase"],
    [/\bcompare with\b/g, "compare", "normalize compare phrase"],
    [/\bvs\b/g, "compare", "normalize vs -> compare"],
    [/\bversus\b/g, "compare", "normalize versus -> compare"],
    [
      /\bprevious window\b/g,
      "compare previous window",
      "normalize previous window",
    ],
    [/\bwhat changed\b/g, "compare", "normalize what changed"],

    [/\btcp miss\b/g, "tcp_miss", "normalize ats raw"],
    [/\berr dns fail\b/g, "err_dns_fail", "normalize ats raw"],

    [/\binfra error\b/g, "infra_err", "normalize ats family"],
    [/\binfra errors\b/g, "infra_err", "normalize ats family"],
    [/\bclient error\b/g, "client_err", "normalize ats family"],
    [/\bclient errors\b/g, "client_err", "normalize ats family"],

    [/\bdevice type\b/g, "ua family", "normalize device type -> ua family"],
    [/\buser agent\b/g, "ua family", "normalize user agent -> ua family"],
  ];

  for (const [pattern, replacement, reason] of replacements) {
    const next = text.replace(pattern, replacement);
    if (next !== text) {
      text = next;
      changed = true;
      reasons.push(reason);
    }
  }

  text = text.replace(/\s+/g, " ").trim();

  return {
    repairedText: text,
    repairApplied: changed,
    repairReason: reasons.length ? reasons.join("; ") : null,
  };
}

function detectMetric(text: string): ParserMetric {
  if (text.includes("tcp_miss") || text.includes("err_dns_fail")) return "ats";

  if (
    text.includes("ats") ||
    text.includes("cache") ||
    text.includes("hit") ||
    text.includes("miss") ||
    text.includes("refresh") ||
    text.includes("client_err") ||
    text.includes("infra_err")
  ) {
    return "ats";
  }

  if (
    text.includes("latency") ||
    text.includes("p95") ||
    text.includes("p99") ||
    text.includes("ttms")
  ) {
    return "latency";
  }

  if (
    text.includes("errors") ||
    text.includes("error") ||
    text.includes("5xx")
  ) {
    return "errors";
  }

  if (
    text.includes("requests") ||
    text.includes("request") ||
    text.includes("traffic") ||
    text.includes("volume")
  ) {
    return "requests";
  }

  if (text.includes("status")) return "status_codes";

  return null;
}

function detectRawCode(text: string): string | null {
  if (text.includes("tcp_miss")) return "tcp_miss";
  if (text.includes("err_dns_fail")) return "err_dns_fail";
  return null;
}

function detectFamily(text: string, rawCode: string | null): ParserFamily {
  if (rawCode === "tcp_miss") return "miss";
  if (rawCode === "err_dns_fail") return "infra_err";

  if (text.includes("client_err")) return "client_err";
  if (text.includes("infra_err")) return "infra_err";
  if (text.includes("refresh")) return "refresh";
  if (text.includes("miss")) return "miss";
  if (text.includes("hit")) return "hit";

  return null;
}

function detectTimeOverride(text: string): ParserTimeOverride {
  const match = text.match(
    /\b(over|for|last|past)\s+(\d+)\s*(minutes|minute|hours|hour|days|day)\b/
  );

  if (!match) return null;

  const value = `${match[2]} ${match[3]}`;
  return {
    type: "relative",
    value,
  };
}

function detectDimension(text: string): ParserDimension {
  if (text.includes("by region") || text.includes("region breakdown")) {
    return "region";
  }

  if (text.includes("by pop") || text.includes("pop breakdown")) {
    return "pop";
  }

  if (
    text.includes("by ua") ||
    text.includes("by ua family") ||
    text.includes("by device") ||
    text.includes("ua family breakdown")
  ) {
    return "uaFamily";
  }

  if (
    text.includes("by content") ||
    text.includes("by content type") ||
    text.includes("content breakdown")
  ) {
    return "contentType";
  }

  if (text.includes("by host") || text.includes("host breakdown")) {
    return "host";
  }

  if (text.includes("by status") || text.includes("status breakdown")) {
    return "status_code";
  }

  return null;
}

function detectRegionScope(text: string): string | null {
  const patterns: Array<{ re: RegExp; value: string }> = [
    { re: /\bin\s+us-east\b/, value: "us-east" },
    { re: /\bin\s+us-west\b/, value: "us-west" },
    { re: /\bin\s+us-central\b/, value: "us-central" },
    { re: /\bin\s+eu-west\b/, value: "eu-west" },
    { re: /\bin\s+eu-central\b/, value: "eu-central" },
    { re: /\bin\s+ap-south\b/, value: "ap-south" },
    { re: /\bin\s+ap-northeast\b/, value: "ap-northeast" },
    { re: /\bin\s+sa-east\b/, value: "sa-east" },

    { re: /\bfor\s+us-east\b/, value: "us-east" },
    { re: /\bfor\s+us-west\b/, value: "us-west" },
    { re: /\bfor\s+us-central\b/, value: "us-central" },
    { re: /\bfor\s+eu-west\b/, value: "eu-west" },
    { re: /\bfor\s+eu-central\b/, value: "eu-central" },
    { re: /\bfor\s+ap-south\b/, value: "ap-south" },
    { re: /\bfor\s+ap-northeast\b/, value: "ap-northeast" },
    { re: /\bfor\s+sa-east\b/, value: "sa-east" },
  ];

  for (const entry of patterns) {
    if (entry.re.test(text)) return entry.value;
  }

  return null;
}

function detectPopScope(text: string): string | null {
  const match = text.match(/\b(?:in|for)\s+pop[_\s-]?(\d{1,3})\b/);
  if (!match) return null;
  return `pop_${match[1].padStart(3, "0")}`;
}

function detectUaFamilyScope(text: string): string | null {
  const patterns: Array<{ re: RegExp; value: string }> = [
    { re: /\b(?:in|for)\s+mobile\b/, value: "mobile" },
    { re: /\b(?:in|for)\s+web\b/, value: "web" },
    { re: /\b(?:in|for)\s+stb\b/, value: "stb" },
    { re: /\b(?:in|for)\s+smart tv\b/, value: "smart_tv" },
    { re: /\b(?:in|for)\s+console\b/, value: "console" },
  ];

  for (const entry of patterns) {
    if (entry.re.test(text)) return entry.value;
  }

  return null;
}

function detectContentTypeScope(text: string): string | null {
  const patterns: Array<{ re: RegExp; value: string }> = [
    { re: /\b(?:in|for)\s+manifest\b/, value: "manifest" },
    { re: /\b(?:in|for)\s+segment\b/, value: "segment" },
    { re: /\b(?:in|for)\s+api\b/, value: "api" },
  ];

  for (const entry of patterns) {
    if (entry.re.test(text)) return entry.value;
  }

  return null;
}

function detectScopeChanges(text: string) {
  const scopeChanges = createEmptyScopeChanges();

  scopeChanges.region = detectRegionScope(text);
  scopeChanges.pop = detectPopScope(text);
  scopeChanges.uaFamily = detectUaFamilyScope(text);
  scopeChanges.contentType = detectContentTypeScope(text);

  const hasAnyScopeChange = Object.values(scopeChanges).some(Boolean);

  return {
    scopeChanges,
    scopeMode: hasAnyScopeChange ? "narrow" : "inherit" as "narrow" | "inherit",
  };
}

function detectView(
  text: string,
  hasTimeOverride: boolean,
  dimension: ParserDimension
): ParserView {
  if (hasTimeOverride) return "timeseries";

  if (
    text.includes("over time") ||
    text.includes("trend") ||
    text.includes("timeline")
  ) {
    return "timeseries";
  }

  if (dimension) {
    return "breakdown";
  }

  if (text.includes("compare")) return "compare";

  return "summary";
}

function detectLane(metric: ParserMetric, view: ParserView): ParserLane {
  if (view === "compare") return "compare";

  if (metric && (view === "timeseries" || view === "breakdown")) {
    return "exploration";
  }

  if (metric) return "triage";

  return "clarification";
}

function detectIntentSubtype(args: {
  lane: ParserLane;
  view: ParserView;
  dimension: ParserDimension;
}): string | null {
  const { lane, view, dimension } = args;

  if (lane === "compare") return "previous_window";

  if (lane === "exploration" && view === "timeseries") {
    return "over_time";
  }

  if (lane === "exploration" && view === "breakdown") {
    if (dimension === "region") return "by_region";
    if (dimension === "pop") return "by_pop";
    if (dimension === "uaFamily") return "by_ua";
    if (dimension === "contentType") return "by_content";
    if (dimension === "host") return "by_host";
    if (dimension === "status_code") return "by_status";
    return "breakdown";
  }

  if (lane === "triage") return "full_triage";

  return null;
}

export function parseInput(input: string): ParserOutput {
  const { rawText, normalizedText } = normalizeInput(input);
  const repaired = applyBoundedRepair(normalizedText);

  const result = createEmptyParserOutput({
    rawText,
    normalizedText,
  });

  const workingText = repaired.repairedText;

  const rawCode = detectRawCode(workingText);
  const family = detectFamily(workingText, rawCode);
  const metric = detectMetric(workingText);
  const timeOverride = detectTimeOverride(workingText);
  const dimension = detectDimension(workingText);
  const { scopeChanges, scopeMode } = detectScopeChanges(workingText);
  const view = detectView(workingText, Boolean(timeOverride), dimension);
  const lane = detectLane(metric, view);
  const intentSubtype = detectIntentSubtype({
    lane,
    view,
    dimension,
  });

  result.repairedText = workingText;
  result.repairApplied = repaired.repairApplied;

  result.metric = metric;
  result.rawCode = rawCode;
  result.family = family;
  result.dimension = dimension;
  result.view = view;
  result.lane = lane;
  result.timeOverride = timeOverride;
  result.intentSubtype = intentSubtype;

  result.scopeChanges = scopeChanges;
  result.scopeMode = scopeMode;

  result.compareTarget = lane === "compare" ? "previous_window" : null;
  result.requiresActiveContext = lane === "compare";

  if (lane === "clarification") {
    result.confidence = "low";
    result.confidenceReason = "no supported metric detected";
    result.clarificationRequired = true;
    result.clarificationReason = "unsupported_or_ambiguous_request";
  } else {
    result.confidence = rawCode ? "high" : family || metric ? "medium" : "low";
    result.confidenceReason = rawCode
      ? "raw code matched"
      : family
      ? "family matched"
      : "metric matched";
    result.clarificationRequired = false;
    result.clarificationReason = null;
  }

  console.log("🧠 PARSER OUTPUT", result);

  return result;
}
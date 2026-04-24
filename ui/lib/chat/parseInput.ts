import { normalizeInput } from "@/lib/chat/normalizeInput";
import {
  createEmptyParserOutput,
  createEmptyScopeChanges,
  type ParserConfidence,
  type ParserDimension,
  type ParserFamily,
  type ParserLane,
  type ParserMetric,
  type ParserOutput,
  type ParserScopeChanges,
  type ParserScopeMode,
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
      "normalize previous window phrase",
    ],
    [/\bwhat changed\b/g, "compare", "normalize what changed -> compare"],

    [/\btcp miss\b/g, "tcp_miss", "normalize ATS raw code"],
    [/\berr dns fail\b/g, "err_dns_fail", "normalize ATS raw code"],

    [/\binfra error\b/g, "infra_err", "normalize ATS family"],
    [/\binfra errors\b/g, "infra_err", "normalize ATS family"],
    [/\bclient error\b/g, "client_err", "normalize ATS family"],
    [/\bclient errors\b/g, "client_err", "normalize ATS family"],

    [/\bdevice type\b/g, "ua family", "normalize device type"],
    [/\buser agent\b/g, "ua family", "normalize user agent"],
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
  if (text.includes("tcp_miss") || text.includes("err_dns_fail")) {
    return "ats";
  }

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

  if (text.includes("status")) {
    return "status_codes";
  }

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

  return {
    type: "relative",
    value: `${match[2]} ${match[3]}`,
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
    { re: /\b(?:in|for)\s+us-east\b/, value: "us-east" },
    { re: /\b(?:in|for)\s+us-west\b/, value: "us-west" },
    { re: /\b(?:in|for)\s+us-central\b/, value: "us-central" },
    { re: /\b(?:in|for)\s+eu-west\b/, value: "eu-west" },
    { re: /\b(?:in|for)\s+eu-central\b/, value: "eu-central" },
    { re: /\b(?:in|for)\s+ap-south\b/, value: "ap-south" },
    { re: /\b(?:in|for)\s+ap-northeast\b/, value: "ap-northeast" },
    { re: /\b(?:in|for)\s+sa-east\b/, value: "sa-east" },
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

function detectScopeChanges(text: string): {
  scopeChanges: ParserScopeChanges;
  scopeMode: ParserScopeMode;
} {
  const scopeChanges = createEmptyScopeChanges();

  scopeChanges.region = detectRegionScope(text);
  scopeChanges.pop = detectPopScope(text);
  scopeChanges.uaFamily = detectUaFamilyScope(text);
  scopeChanges.contentType = detectContentTypeScope(text);

  const hasAnyScopeChange = Object.values(scopeChanges).some(Boolean);

  return {
    scopeChanges,
    scopeMode: hasAnyScopeChange ? "narrow" : "inherit",
  };
}

function hasCompareLanguage(text: string): boolean {
  return (
    text.includes("compare") ||
    text.includes("previous window") ||
    text.includes("vs") ||
    text.includes("versus")
  );
}


function detectDrillSubtype(
  text: string
):
  | "worst_region"
  | "worst_pop"
  | "worst_host"
  | "worst_ua"
  | "worst_content"
  | null {
  const lowered = String(text || "").toLowerCase().replace(/what’s/g, "whats");

  const mentionsStatusBreakdown =
    (lowered.includes("status") || lowered.includes("status code")) &&
    (lowered.includes("breakdown") ||
      lowered.includes("distribution") ||
      lowered.includes("mix") ||
      lowered.includes("split"));

  // Keep status breakdown out of drill. That path stays separate.
  if (mentionsStatusBreakdown) return null;

  const hasDrillLanguage =
    lowered.includes("bad") ||
    lowered.includes("worst") ||
    lowered.includes("which") ||
    lowered.includes("show") ||
    lowered.includes("top") ||
    lowered.includes("breakdown") ||
    lowered.includes("drill");

  if (!hasDrillLanguage) return null;

  if (lowered.includes("pop") || lowered.includes("by pop")) {
    return "worst_pop";
  }

  if (lowered.includes("host") || lowered.includes("by host")) {
    return "worst_host";
  }

  if (lowered.includes("region") || lowered.includes("by region")) {
    return "worst_region";
  }

  if (
    lowered.includes("ua") ||
    lowered.includes("ua family") ||
    lowered.includes("device") ||
    lowered.includes("by ua") ||
    lowered.includes("by device")
  ) {
    return "worst_ua";
  }

  if (
    lowered.includes("content type") ||
    lowered.includes("content") ||
    lowered.includes("by content")
  ) {
    return "worst_content";
  }

  return null;
}

function detectView(args: {
  text: string;
  hasTimeOverride: boolean;
  dimension: ParserDimension;
  metric: ParserMetric;
}): ParserView {
  const { text, hasTimeOverride, dimension, metric } = args;

  // Compare should win over time/breakdown in v1.
  if (hasCompareLanguage(text)) {
    return "compare";
  }

  if (hasTimeOverride) {
    return "timeseries";
  }

  if (
    text.includes("over time") ||
    text.includes("trend") ||
    text.includes("timeline")
  ) {
    return "timeseries";
  }

  if (metric === "status_codes") return "breakdown";

    if (dimension) return "breakdown";

  // Broad graphable metric asks should default to exploration-style timeseries.
  if (
    metric === "latency" ||
    metric === "errors" ||
    metric === "requests" ||
    metric === "ats"
  ) {
    return "timeseries";
  }

  return "summary";
}

function hasExplainLanguage(text: string): boolean {
  return (
    /\b(explain|why|what happened|what is happening|what is going on|whats going on)\b/i.test(
      text
    ) ||
    /\bwhy is\b/i.test(text) ||
    /\bwhy are\b/i.test(text)
  );
}

function detectLane(args: {
  text: string;
  metric: ParserMetric;
  view: ParserView;
  drillSubtype: ReturnType<typeof detectDrillSubtype>;
}): ParserLane {
  const { text, metric, view, drillSubtype } = args;

  if (hasExplainLanguage(text)) return "explain";

  if (drillSubtype) return "drill";

  if (view === "compare") return "compare";

  if (metric === "status_codes" && view === "breakdown") {
    return "triage";
    }

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
  drillSubtype: ReturnType<typeof detectDrillSubtype>;
}): string | null {
  const { lane, view, dimension, drillSubtype } = args;

  if (lane === "explain") return "explain_signal";

  if (lane === "drill") return drillSubtype;

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

function detectConfidence(args: {
  text: string;
  lane: ParserLane;
  view: ParserView;
  metric: ParserMetric;
  rawCode: string | null;
  family: ParserFamily;
  dimension: ParserDimension;
  timeOverride: ParserTimeOverride;
  scopeChanges: ParserScopeChanges;
}): {
  confidence: ParserConfidence;
  confidenceReason: string;
} {
  const {
    text,
    lane,
    view,
    metric,
    rawCode,
    family,
    dimension,
    timeOverride,
    scopeChanges,
  } = args;

  const hasScope = Object.values(scopeChanges).some(Boolean);

  const hasCompareLanguage =
    text.includes("compare") ||
    text.includes("previous window") ||
    text.includes("vs") ||
    text.includes("versus");

  const hasWeakScopeLanguage =
    /\b(in|for)\b/.test(text) &&
    !hasScope &&
    !dimension;

  const hasWeakTimeLanguage =
    /\b(last|past|over|for)\b/.test(text) &&
    !timeOverride &&
    view !== "compare";

  const hasMetric = Boolean(metric);

  // -----------------------------
  // HIGH confidence
  // -----------------------------
  if (rawCode) {
    return {
      confidence: "high",
      confidenceReason: "strong metric match: raw ATS code matched deterministically",
    };
  }

  if (family && metric === "ats") {
    return {
      confidence: "high",
      confidenceReason: "strong metric match: ATS family matched deterministically",
    };
  }

  if (lane === "compare" && hasMetric) {
    return {
        confidence: "high",
        confidenceReason: "compare intent is clear with supported metric",
    };
    }

    if (lane === "drill") {
    return {
        confidence: "high",
        confidenceReason:
        "drill intent is clear and will inherit active investigation context",
    };
    }

    if (hasMetric && (timeOverride || dimension || hasScope)) {
    const parts: string[] = ["strong metric match"];
    if (timeOverride) parts.push("explicit time match");
    if (dimension) parts.push("explicit dimension match");
    if (hasScope) parts.push("explicit scope match");

    return {
      confidence: "high",
      confidenceReason: parts.join(" + "),
    };
  }

  // -----------------------------
  // LOW confidence
  // -----------------------------
    if (!hasMetric && hasCompareLanguage) {
    return {
        confidence: "low",
        confidenceReason: "compare ambiguity: compare language found without a supported metric",
    };
    }

  if (!hasMetric && hasWeakScopeLanguage) {
    return {
      confidence: "low",
      confidenceReason: "weak scope match: scope-like language found but no valid scope or metric resolved",
    };
  }

  if (!hasMetric && hasWeakTimeLanguage) {
    return {
      confidence: "low",
      confidenceReason: "partial time match: time-like language found but no supported metric resolved",
    };
  }

  if (!hasMetric) {
    return {
      confidence: "low",
      confidenceReason: "no supported metric detected",
    };
  }

  // -----------------------------
  // MEDIUM confidence
  // -----------------------------
  return {
    confidence: "medium",
    confidenceReason: "strong metric match, but no explicit time, dimension, or scope",
  };
}

function detectClarification(args: {
  text: string;
  lane: ParserLane;
  metric: ParserMetric;
  confidence: ParserConfidence;
  scopeChanges: ParserScopeChanges;
  dimension: ParserDimension;
  timeOverride: ParserTimeOverride;
}): {
  clarificationRequired: boolean;
  clarificationReason: string | null;
} {
  
const { text, lane, metric, confidence, scopeChanges, dimension, timeOverride } = args;

if (lane === "drill") {
  return {
    clarificationRequired: false,
    clarificationReason: null,
  };
}

const isPlainStatusCodesAsk =
  /\bstatus\s+codes?\b/i.test(text) &&
  !/\b(breakdown|distribution|mix|split|over time|trend|timeline|by\s+(region|pop|host))\b/i.test(
    text
  );

if (isPlainStatusCodesAsk) {
  return {
    clarificationRequired: true,
    clarificationReason: "status_codes_ambiguous",
  };
}

const hasScope = Object.values(scopeChanges).some(Boolean);

  const hasCompareLanguage =
    text.includes("compare") ||
    text.includes("previous window") ||
    text.includes("vs") ||
    text.includes("versus");

  const hasWeakScopeLanguage =
    /\b(in|for)\b/.test(text) &&
    !hasScope &&
    !dimension;

  const hasWeakTimeLanguage =
    /\b(last|past|over|for)\b/.test(text) &&
    !timeOverride &&
    lane !== "compare";

  if (!metric && hasCompareLanguage) {
    return {
      clarificationRequired: true,
      clarificationReason: "compare_requires_metric",
    };
  }

  if (!metric && hasWeakScopeLanguage) {
    return {
      clarificationRequired: true,
      clarificationReason: "scope_mentioned_but_unresolved",
    };
  }

  if (!metric && hasWeakTimeLanguage) {
    return {
      clarificationRequired: true,
      clarificationReason: "time_mentioned_but_unresolved",
    };
  }

  if (!metric) {
    return {
      clarificationRequired: true,
      clarificationReason: "unsupported_or_ambiguous_request",
    };
  }

  if (confidence === "low") {
    return {
      clarificationRequired: true,
      clarificationReason: "low_confidence_parse",
    };
  }

  return {
    clarificationRequired: false,
    clarificationReason: null,
  };
}


type ParsedFields = {
  workingText: string;
  rawCode: string | null;
  family: ParserFamily;
  metric: ParserMetric;
  timeOverride: ParserTimeOverride;
  dimension: ParserDimension;
  scopeChanges: ParserScopeChanges;
  scopeMode: ParserScopeMode;
  view: ParserView;
  lane: ParserLane;
  intentSubtype: string | null;
  confidence: ParserConfidence;
  confidenceReason: string;
  clarificationRequired: boolean;
  clarificationReason: string | null;
};

function confidenceRank(confidence: ParserConfidence): number {
  if (confidence === "high") return 3;
  if (confidence === "medium") return 2;
  return 1;
}

function applyLowConfidenceRepair(text: string): {
  repairedText: string;
  repairApplied: boolean;
  repairReason: string | null;
} {
  let repairedText = String(text || "").trim();
  let repairApplied = false;
  const reasons: string[] = [];

  const replacements: Array<[RegExp, string, string]> = [
    [/\blatncy\b/g, "latency", "fixed latency typo"],
    [/\btrafic\b/g, "traffic", "fixed traffic typo"],
    [/\berors\b/g, "errors", "fixed errors typo"],
    [/\berrots\b/g, "errors", "fixed errors typo"],
    [/\bregon\b/g, "region", "fixed region typo"],
    [/\bregoin\b/g, "region", "fixed region typo"],
    [/\bmanifset\b/g, "manifest", "fixed manifest typo"],

    [/\b(\d+)\s*h\b/g, "$1 hours", "expanded hour shorthand"],
    [/\b(\d+)\s*hr\b/g, "$1 hour", "expanded hour shorthand"],
    [/\b(\d+)\s*hrs\b/g, "$1 hours", "expanded hour shorthand"],
    [/\b(\d+)\s*m\b/g, "$1 minutes", "expanded minute shorthand"],
    [/\b(\d+)\s*min\b/g, "$1 minute", "expanded minute shorthand"],
    [/\b(\d+)\s*mins\b/g, "$1 minutes", "expanded minute shorthand"],

    [/\btcp miss\b/g, "tcp_miss", "normalized ATS raw code wording"],
    [/\bdns fail\b/g, "err_dns_fail", "normalized ATS raw code wording"],
  ];

  for (const [pattern, replacement, reason] of replacements) {
    const next = repairedText.replace(pattern, replacement);
    if (next !== repairedText) {
      repairedText = next;
      repairApplied = true;
      reasons.push(reason);
    }
  }

  repairedText = repairedText.replace(/\s+/g, " ").trim();

  return {
    repairedText,
    repairApplied,
    repairReason: reasons.length ? reasons.join("; ") : null,
  };
}

function parseWorkingText(workingText: string): ParsedFields {
  const rawCode = detectRawCode(workingText);
  const family = detectFamily(workingText, rawCode);
  const metric = detectMetric(workingText);
  const timeOverride = detectTimeOverride(workingText);
  const dimension = detectDimension(workingText);
  const { scopeChanges, scopeMode } = detectScopeChanges(workingText);

  const view = detectView({
    text: workingText,
    hasTimeOverride: Boolean(timeOverride),
    dimension,
    metric,
  });

  const drillSubtype = detectDrillSubtype(workingText);

  const lane = detectLane({
    text: workingText,
    metric,
    view,
    drillSubtype,
  });

    const intentSubtype = detectIntentSubtype({
    lane,
    view,
    dimension,
    drillSubtype,
    });

  const { confidence, confidenceReason } = detectConfidence({
    text: workingText,
    lane,
    view,
    metric,
    rawCode,
    family,
    dimension,
    timeOverride,
    scopeChanges,
  });

  const { clarificationRequired, clarificationReason } = detectClarification({
    text: workingText,
    lane,
    metric,
    confidence,
    scopeChanges,
    dimension,
    timeOverride,
  });

  return {
    workingText,
    rawCode,
    family,
    metric,
    timeOverride,
    dimension,
    scopeChanges,
    scopeMode,
    view,
    lane,
    intentSubtype,
    confidence,
    confidenceReason,
    clarificationRequired,
    clarificationReason,
  };
}

function chooseBestParse(args: {
  original: ParsedFields;
  repaired: ParsedFields;
  repairedTextChanged: boolean;
}): ParsedFields {
  const { original, repaired, repairedTextChanged } = args;

  if (!repairedTextChanged) return original;

  const originalRank = confidenceRank(original.confidence);
  const repairedRank = confidenceRank(repaired.confidence);

  if (repairedRank > originalRank) return repaired;

  if (
    original.clarificationRequired &&
    !repaired.clarificationRequired &&
    repairedRank >= originalRank
  ) {
    return repaired;
  }

  return original;
}


export function parseInput(input: string): ParserOutput {
  const { rawText, normalizedText } = normalizeInput(input);
  const repaired = applyBoundedRepair(normalizedText);

  const result = createEmptyParserOutput({
    rawText,
    normalizedText,
  });

  const firstPass = parseWorkingText(repaired.repairedText);

    let finalPass = firstPass;
    let finalRepairApplied = repaired.repairApplied;
    let finalRepairText = repaired.repairedText;

    const shouldAttemptRepair =
        firstPass.confidence === "low" ||
        (
            firstPass.confidence === "medium" &&
            Boolean(firstPass.metric) &&
            !firstPass.dimension &&
            !firstPass.timeOverride &&
            firstPass.scopeMode === "inherit" &&
            /\b(by|in|for)\b/.test(firstPass.workingText)
        );

        if (shouldAttemptRepair) {
        const lowConfidenceRepair = applyLowConfidenceRepair(firstPass.workingText);

        if (lowConfidenceRepair.repairApplied) {
            const repairedPass = parseWorkingText(lowConfidenceRepair.repairedText);

            finalPass = chooseBestParse({
                original: firstPass,
                repaired: repairedPass,
                repairedTextChanged:
                lowConfidenceRepair.repairedText !== firstPass.workingText,
            });
            }
        }

    const {
    workingText,
    rawCode,
    family,
    metric,
    timeOverride,
    dimension,
    scopeChanges,
    scopeMode,
    view,
    lane,
    intentSubtype,
    confidence,
    confidenceReason,
    clarificationRequired,
    clarificationReason,
    } = finalPass;

  result.repairedText = workingText;
  result.repairApplied =
    String(workingText || "").trim() !== String(normalizedText || "").trim();

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
  result.requiresActiveContext =
    lane === "compare" || lane === "explain" || lane === "drill";

  result.confidence = confidence;
  result.confidenceReason = confidenceReason;

    result.clarificationRequired = clarificationRequired;
    result.clarificationReason = clarificationReason;

  console.log("🧠 PARSER OUTPUT", result);

  return result;
}

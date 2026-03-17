import {
  resolvePartner,
  resolveService,
  normalizeInputText,
  type PartnerResolveResult,
  type ServiceResolveResult,
} from "@/lib/schema/normalize";
import type { CanonPartner, CanonService } from "@/lib/schema/canonical";

export type IntentKind = "must_trigger" | "conditional" | "reject";

export type TimeMeta =
  | {
      kind: "relative";
      windowMinutes: number;
      sourceText: string;
    }
  | {
      kind: "absolute";
      startTsUtc: string;
      endTsUtc: string;
      sourceText: string;
    }
  | {
      kind: "named";
      label:
        | "now"
        | "right now"
        | "today"
        | "this morning"
        | "this afternoon"
        | "tonight"
        | "last night"
        | "overnight"
        | "yesterday"
        | "yesterday evening";
      sourceText: string;
    };

export type MetricHint =
  | "traffic"
  | "latency"
  | "errors"
  | "cache"
  | "p95"
  | "p99"
  | "crc"
  | "health"
  | "incident";

export type IntentParseResult = {
  intentKind: IntentKind;
  shouldTrigger: boolean;
  confidence: number;
  requiresPriorContext: boolean;

  partnerCanonical: CanonPartner | null;
  serviceCanonical: CanonService | null;

  missingPartner: boolean;
  missingService: boolean;

  metricHints: MetricHint[];
  timeMeta: TimeMeta | null;

  partnerMeta: PartnerResolveResult | null;
  serviceMeta: ServiceResolveResult | null;

  rawText: string;
  replyText?: string;

  debug: {
    normalizedText: string;
    reasons: string[];
  };
};

const NEVER_EXACT = new Set([
  "hi",
  "hello",
  "hey",
  "yo",
  "sup",
  "thanks",
  "thank you",
  "ok",
  "okay",
  "cool",
  "nice",
  "test",
  "testing",
]);

const NEVER_PHRASES = [
  "hello live team",
  "partner 1 meeting",
  "partner 2 meeting",
  "partner 3 meeting",
  "partner 4 meeting",
  "partner 5 meeting",
  "partner 6 meeting",
];

const INVESTIGATION_PHRASES = [
  "check",
  "investigate",
  "investigation",
  "analyze",
  "analyse",
  "look into",
  "look at",
  "triage",
  "show me",
  "show",
  "confirm",
  "isolate",
  "review",
  "run triage",
];

const HEALTH_PHRASES = [
  "how was",
  "was it okay",
  "was it ok",
  "is it okay",
  "is it ok",
  "did we have",
  "any issues",
  "any issue",
  "any problems",
  "any problem",
  "anything go wrong",
  "were we stable",
  "are we good",
  "was there an outage",
  "was there customer impact",
  "how did",
];

const CONDITIONAL_PHRASES = [
  "what about",
  "check it again",
  "run it again",
  "check again",
  "only us east",
  "only us west",
  "only us central",
  "only eu west",
  "only eu central",
  "only ap south",
  "only ap northeast",
  "only sa east",
  "only",
  "show live instead",
  "now check",
  "what changed",
  "compare with previous window",
  "compare with previous",
];

const METRIC_TERMS: Array<{ term: string; hint: MetricHint }> = [
  { term: "traffic", hint: "traffic" },
  { term: "latency", hint: "latency" },
  { term: "error", hint: "errors" },
  { term: "errors", hint: "errors" },
  { term: "5xx", hint: "errors" },
  { term: "cache", hint: "cache" },
  { term: "p95", hint: "p95" },
  { term: "p99", hint: "p99" },
  { term: "crc", hint: "crc" },
  { term: "health", hint: "health" },
  { term: "healthy", hint: "health" },
  { term: "incident", hint: "incident" },
  { term: "incidents", hint: "incident" },
  { term: "outage", hint: "incident" },
  { term: "slow", hint: "latency" },
  { term: "spike", hint: "incident" },
  { term: "drop", hint: "incident" },
  { term: "degradation", hint: "incident" },
];

const NAMED_TIME_PHRASES: Array<TimeMeta["kind"] extends "named" ? never : never> = [];
const NAMED_TIME_LABELS: Array<
  | "now"
  | "right now"
  | "today"
  | "this morning"
  | "this afternoon"
  | "tonight"
  | "last night"
  | "overnight"
  | "yesterday"
  | "yesterday evening"
> = [
  "right now",
  "this morning",
  "this afternoon",
  "yesterday evening",
  "last night",
  "overnight",
  "yesterday",
  "tonight",
  "today",
  "now",
];

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function hasBoundaryPhrase(text: string, phrase: string): boolean {
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(^|\\s)${escaped}(?=$|\\s)`, "i");
  return re.test(text);
}

function firstMatchingPhrase(text: string, phrases: readonly string[]): string | null {
  for (const phrase of phrases) {
    if (hasBoundaryPhrase(text, phrase)) return phrase;
  }
  return null;
}

function extractMetricHints(text: string): MetricHint[] {
  const hintSet = new Set<MetricHint>();
  for (const entry of METRIC_TERMS) {
    if (hasBoundaryPhrase(text, entry.term)) hintSet.add(entry.hint);
  }
  return Array.from(hintSet);
}

function extractRelativeWindowMinutes(text: string): TimeMeta | null {
  const mMinutes = text.match(/\blast\s+(\d+)\s*(m|min|mins|minute|minutes)\b/i);
  if (mMinutes) {
    return {
      kind: "relative",
      windowMinutes: clamp(Number(mMinutes[1]), 5, 1440),
      sourceText: mMinutes[0],
    };
  }

  const mHours = text.match(/\blast\s+(\d+)\s*(h|hr|hrs|hour|hours)\b/i);
  if (mHours) {
    return {
      kind: "relative",
      windowMinutes: clamp(Number(mHours[1]) * 60, 5, 1440),
      sourceText: mHours[0],
    };
  }

  const mDays = text.match(/\blast\s+(\d+)\s*(d|day|days)\b/i);
  if (mDays) {
    return {
      kind: "relative",
      windowMinutes: clamp(Number(mDays[1]) * 1440, 5, 10080),
      sourceText: mDays[0],
    };
  }

  return null;
}

function extractIsoRange(text: string): TimeMeta | null {
  const matches =
    text.match(/\b\d{4}-\d{2}-\d{2}t\d{2}:\d{2}(?::\d{2})?(?:\.\d{3})?z\b/gi) || [];
  if (matches.length < 2) return null;

  const start = new Date(matches[0]);
  const end = new Date(matches[1]);

  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
  if (end.getTime() <= start.getTime()) return null;

  return {
    kind: "absolute",
    startTsUtc: start.toISOString(),
    endTsUtc: end.toISOString(),
    sourceText: `${matches[0]} → ${matches[1]}`,
  };
}

function extractNamedTime(text: string): TimeMeta | null {
  for (const label of NAMED_TIME_LABELS) {
    if (hasBoundaryPhrase(text, label)) {
      return {
        kind: "named",
        label,
        sourceText: label,
      };
    }
  }
  return null;
}

function extractTimeMeta(text: string): TimeMeta | null {
  return extractIsoRange(text) || extractRelativeWindowMinutes(text) || extractNamedTime(text);
}

export function parseTriageIntent(args: {
  text: string;
  hasPriorContext?: boolean;
}): IntentParseResult {
  const rawText = String(args.text || "");
  const normalizedText = normalizeInputText(rawText);
  const hasPriorContext = Boolean(args.hasPriorContext);

  const reasons: string[] = [];

  if (!normalizedText) {
    reasons.push("empty_text");
    return {
      intentKind: "reject",
      shouldTrigger: false,
      confidence: 0,
      requiresPriorContext: false,
      partnerCanonical: null,
      serviceCanonical: null,
      missingPartner: true,
      missingService: true,
      metricHints: [],
      timeMeta: null,
      partnerMeta: null,
      serviceMeta: null,
      rawText,
      replyText:
        "That didn't look like a triage request. Ask about traffic, latency, errors, cache, or incidents — or click Run Triage with the current scope.",
      debug: {
        normalizedText,
        reasons,
      },
    };
  }

  if (
    NEVER_EXACT.has(normalizedText) ||
    firstMatchingPhrase(normalizedText, NEVER_PHRASES)
  ) {
    reasons.push("small_talk_or_never_trigger");
    return {
      intentKind: "reject",
      shouldTrigger: false,
      confidence: 0.05,
      requiresPriorContext: false,
      partnerCanonical: null,
      serviceCanonical: null,
      missingPartner: true,
      missingService: true,
      metricHints: [],
      timeMeta: null,
      partnerMeta: null,
      serviceMeta: null,
      rawText,
      replyText:
        "That didn't look like a triage request. Ask about traffic, latency, errors, cache, or incidents — or click Run Triage with the current scope.",
      debug: {
        normalizedText,
        reasons,
      },
    };
  }

  const partnerMeta = resolvePartner(normalizedText);
  const serviceMeta = resolveService(normalizedText);

  const partnerCanonical = partnerMeta?.value ?? null;
  const serviceCanonical = serviceMeta?.value ?? null;

  const metricHints = extractMetricHints(normalizedText);
  const timeMeta = extractTimeMeta(normalizedText);

  const matchedInvestigation = firstMatchingPhrase(normalizedText, INVESTIGATION_PHRASES);
  const matchedHealth = firstMatchingPhrase(normalizedText, HEALTH_PHRASES);
  const matchedConditional = firstMatchingPhrase(normalizedText, CONDITIONAL_PHRASES);

  const hasStrongIntentSignal = Boolean(
    matchedInvestigation ||
      matchedHealth ||
      metricHints.length > 0 ||
      (timeMeta && (partnerCanonical || serviceCanonical))
  );

  const hasRegionLikeFollowUp = Boolean(
    /\b(?:us[\s-]*east|us[\s-]*west|us[\s-]*central|eu[\s-]*west|eu[\s-]*central|ap[\s-]*south|ap[\s-]*northeast|sa[\s-]*east)\b/i.test(
        normalizedText
    )
    );

    const hasPopLikeFollowUp = Boolean(/\b(?:east|west|central|south|northeast)\s+\d{1,2}\b/i.test(normalizedText));

    const hasScopeOnlyFollowUp = Boolean(
    partnerCanonical || serviceCanonical || hasRegionLikeFollowUp || hasPopLikeFollowUp
    );

  const missingPartner = !partnerCanonical;
  const missingService = !serviceCanonical;

  if (hasStrongIntentSignal) {
    reasons.push("strong_intent_signal");
    return {
      intentKind: "must_trigger",
      shouldTrigger: true,
      confidence: 0.9,
      requiresPriorContext: false,
      partnerCanonical,
      serviceCanonical,
      missingPartner,
      missingService,
      metricHints,
      timeMeta,
      partnerMeta,
      serviceMeta,
      rawText,
      debug: {
        normalizedText,
        reasons,
      },
    };
  }

  if (matchedConditional) {
    reasons.push("conditional_phrase");
    if (hasPriorContext) {
      reasons.push("prior_context_present");
      return {
        intentKind: "conditional",
        shouldTrigger: true,
        confidence: 0.75,
        requiresPriorContext: true,
        partnerCanonical,
        serviceCanonical,
        missingPartner,
        missingService,
        metricHints,
        timeMeta,
        partnerMeta,
        serviceMeta,
        rawText,
        debug: {
          normalizedText,
          reasons,
        },
      };
    }

    reasons.push("prior_context_missing");
    return {
      intentKind: "conditional",
      shouldTrigger: false,
      confidence: 0.4,
      requiresPriorContext: true,
      partnerCanonical,
      serviceCanonical,
      missingPartner,
      missingService,
      metricHints,
      timeMeta,
      partnerMeta,
      serviceMeta,
      rawText,
      replyText:
        "That follow-up needs prior context. Run a triage first, then refine it.",
      debug: {
        normalizedText,
        reasons,
      },
    };
  }

  if (hasScopeOnlyFollowUp) {
    reasons.push("scope_only_followup");
    return {
      intentKind: "must_trigger",
      shouldTrigger: true,
      confidence: 0.8,
      requiresPriorContext: false,
      partnerCanonical,
      serviceCanonical,
      missingPartner,
      missingService,
      metricHints,
      timeMeta,
      partnerMeta,
      serviceMeta,
      rawText,
      debug: {
        normalizedText,
        reasons,
      },
    };
  }

  reasons.push("no_valid_trigger");
  return {
    intentKind: "reject",
    shouldTrigger: false,
    confidence: 0.1,
    requiresPriorContext: false,
    partnerCanonical,
    serviceCanonical,
    missingPartner,
    missingService,
    metricHints,
    timeMeta,
    partnerMeta,
    serviceMeta,
    rawText,
    replyText:
      "That didn't look like a triage request. Ask about traffic, latency, errors, cache, or incidents — or click Run Triage with the current scope.",
    debug: {
      normalizedText,
      reasons,
    },
  };
}
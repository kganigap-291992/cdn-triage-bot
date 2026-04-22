export type ParserLane =
  | "triage"
  | "drill"
  | "compare"
  | "exploration"
  | "explain"
  | "clarification"
  | "guardrail"
  | "glossary";

export type ParserMetric =
  | "ats"
  | "latency"
  | "errors"
  | "requests"
  | "status_codes"
  | null;

export type ParserFamily =
  | "hit"
  | "miss"
  | "refresh"
  | "client_err"
  | "infra_err"
  | null;

export type ParserDimension =
  | "region"
  | "pop"
  | "uaFamily"
  | "contentType"
  | "host"
  | "status_code"
  | null;

export type ParserView =
  | "summary"
  | "timeseries"
  | "breakdown"
  | "compare"
  | null;

export type ParserScopeMode = "inherit" | "narrow" | "override";

export type ParserConfidence = "high" | "medium" | "low";

export type ParserTimeOverride =
  | {
      type: "relative" | "absolute";
      value: string;
    }
  | null;

export type ParserScopeChanges = {
  partner: string | null;
  service: string | null;
  region: string | null;
  pop: string | null;
  uaFamily: string | null;
  contentType: string | null;
};

export type ParserOutput = {
  rawText: string;
  normalizedText: string;
  repairedText: string | null;

  lane: ParserLane;
  intentSubtype: string | null;

  metric: ParserMetric;
  rawCode: string | null;
  family: ParserFamily;
  dimension: ParserDimension;
  view: ParserView;

  scopeChanges: ParserScopeChanges;
  blockedScopeChanges: Array<keyof ParserScopeChanges>;
  scopeMode: ParserScopeMode;

  timeOverride: ParserTimeOverride;
  compareTarget: string | null;

  requiresActiveContext: boolean;

  confidence: ParserConfidence;
  confidenceReason: string;

  repairApplied: boolean;

  clarificationRequired: boolean;
  clarificationReason: string | null;
};

export function createEmptyScopeChanges(): ParserScopeChanges {
  return {
    partner: null,
    service: null,
    region: null,
    pop: null,
    uaFamily: null,
    contentType: null,
  };
}

export function createEmptyParserOutput(args: {
  rawText: string;
  normalizedText: string;
}): ParserOutput {
  return {
    rawText: args.rawText,
    normalizedText: args.normalizedText,
    repairedText: null,

    lane: "clarification",
    intentSubtype: null,

    metric: null,
    rawCode: null,
    family: null,
    dimension: null,
    view: null,

    scopeChanges: createEmptyScopeChanges(),
    blockedScopeChanges: [],
    scopeMode: "inherit",

    timeOverride: null,
    compareTarget: null,

    requiresActiveContext: false,

    confidence: "low",
    confidenceReason: "parser not implemented yet",

    repairApplied: false,

    clarificationRequired: true,
    clarificationReason: "parser_not_implemented",
  };
}
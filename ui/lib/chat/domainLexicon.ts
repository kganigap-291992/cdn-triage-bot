import { normalizeInput } from "@/lib/chat/normalizeInput";
import {
  extractTermFromDefinitionQuestion,
  getAtsCrcLexiconSeeds,
  isDefinitionQuestion,
  lookupAtsCrc,
  type AtsOperationalFamily,
} from "@/lib/triage/atsCrcGlossary";

export type CanonicalMetric =
  | "ats"
  | "latency"
  | "errors"
  | "requests"
  | "status_codes"
  | "ats_crc";

export type CanonicalView =
  | "summary"
  | "timeseries"
  | "breakdown"
  | "compare"
  | "drill"
  | "explain"
  | "glossary";

export type CanonicalDimension =
  | "region"
  | "pop"
  | "contentType"
  | "uaFamily"
  | "host";

export type CanonicalLane =
  | "triage"
  | "exploration"
  | "drill"
  | "compare"
  | "explain"
  | "clarification"
  | "guardrail"
  | "glossary";

export type CanonicalService =
  | "live"
  | "vod"
  | "dvr"
  | "eas"
  | "live_ott"
  | "app_backend";

export type CanonicalTokenKind =
  | "metric"
  | "view"
  | "dimension"
  | "service"
  | "scope"
  | "time"
  | "glossary_term"
  | "intent_signal";

export type LexiconSeed = {
  canonical: string;
  aliases: string[];
  kind: CanonicalTokenKind;
  querySupported?: boolean;
  metadata?: Record<string, unknown>;
};

export type LexiconMatch = {
  canonical: string;
  alias: string;
  kind: CanonicalTokenKind;
  querySupported?: boolean;
  metadata?: Record<string, unknown>;
};

export type GlossaryDetection =
  | {
      isGlossary: true;
      term: string;
      canonical: string;
      title: string;
      family: AtsOperationalFamily;
      querySupported: boolean;
    }
  | {
      isGlossary: false;
    };

export type AtsGlossaryExecutionHint = {
  canonical: string;
  family: AtsOperationalFamily;
  title?: string;
  querySupported: boolean;
};

function normalizeText(raw: string): string {
  return String(raw || "")
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/[^\w\s:%/]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeToken(raw: string): string {
  return normalizeText(raw).replace(/\s+/g, " ");
}

function uniq<T>(values: T[]): T[] {
  return Array.from(new Set(values));
}

function escapeRegExp(raw: string): string {
  return raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function makeSeed(
  kind: CanonicalTokenKind,
  canonical: string,
  aliases: string[],
  opts?: {
    querySupported?: boolean;
    metadata?: Record<string, unknown>;
  }
): LexiconSeed {
  return {
    kind,
    canonical,
    aliases: uniq([canonical, ...aliases].map(normalizeToken).filter(Boolean)),
    querySupported: opts?.querySupported,
    metadata: opts?.metadata,
  };
}

const CORE_LEXICON_SEEDS: LexiconSeed[] = [
  // Metrics
  makeSeed("metric", "ats", [
    "ats",
    "cache",
    "cache health",
    "cache performance",
    "cache behavior",
  ]),

  makeSeed("metric", "latency", [
    "latency",
    "p95",
    "p99",
    "slow",
    "response time",
    "ttms",
  ]),

  makeSeed("metric", "errors", [
    "errors",
    "error",
    "error rate",
    "failures",
    "5xx",
    "server errors",
  ]),

  makeSeed("metric", "requests", [
    "requests",
    "request volume",
    "traffic",
    "volume",
    "load",
    "throughput",
  ]),

  makeSeed("metric", "status_codes", [
    "status",
    "status code",
    "status codes",
    "http status",
    "http codes",
    "response codes",
  ]),

  makeSeed("metric", "ats_crc", [
    "ats code",
    "ats codes",
    "cache result",
    "cache result code",
    "cache result codes",
    "crc",
    "ats crc",
    "ats response code",
    "ats response codes",
  ]),

  // ATS family aliases
  makeSeed("metric", "ats", [
    "hit",
    "hits",
    "miss",
    "misses",
    "refresh",
    "refreshes",
    "client error",
    "client errors",
    "client err",
    "infra error",
    "infra errors",
    "infra err",
  ]),

  // Views
  makeSeed("view", "timeseries", [
    "over time",
    "trend",
    "timeline",
    "timeseries",
    "time series",
    "through time",
  ]),

  makeSeed("view", "breakdown", [
    "by",
    "breakdown",
    "split by",
    "group by",
    "distribution",
  ]),

  makeSeed("view", "compare", [
    "compare",
    "vs",
    "versus",
    "against",
    "what changed",
    "changed",
    "previous window",
    "compare with previous",
  ]),

  makeSeed("view", "summary", [
    "summary",
    "overview",
    "health",
    "how was",
    "how is",
    "what happened",
  ]),

  makeSeed("view", "drill", [
    "worst",
    "deep dive",
    "drill",
    "drill down",
    "narrow down",
    "top bad",
  ]),

  makeSeed("view", "explain", [
    "explain",
    "why",
    "reason",
    "what caused",
    "help me understand",
  ]),

  // Dimensions
  makeSeed("dimension", "region", ["region", "geo", "geography", "area"]),
  makeSeed("dimension", "pop", ["pop", "edge", "edge node", "edge location"]),
  makeSeed("dimension", "contentType", ["content", "content type", "asset type"]),
  makeSeed("dimension", "uaFamily", [
    "ua",
    "ua family",
    "user agent",
    "device",
    "client",
    "device family",
  ]),
  makeSeed("dimension", "host", ["host", "hostname", "server"]),

  // Services
  makeSeed("service", "live", ["live", "linear", "live tv"]),
  makeSeed("service", "vod", ["vod", "on demand", "ondemand"]),
  makeSeed("service", "dvr", ["dvr", "cdvr", "recording", "recordings"]),
  makeSeed("service", "eas", ["eas"]),
  makeSeed("service", "live_ott", ["live ott", "ott", "tve"]),
  makeSeed("service", "app_backend", ["app backend"]),

  // Scope-ish helper tokens
  makeSeed("scope", "partner", ["partner", "tenant"]),
  makeSeed("scope", "service", ["service"]),

  // Time helpers
  makeSeed("time", "relative", [
    "last",
    "past",
    "previous",
    "yesterday",
    "today",
    "last night",
    "overnight",
    "this morning",
    "this afternoon",
    "tonight",
    "right now",
    "now",
    "hour",
    "hours",
    "hr",
    "hrs",
    "hts",
    "minute",
    "minutes",
    "min",
    "mins",
    "day",
    "days",
  ]),

  // Intent signals
  makeSeed("intent_signal", "triage", [
    "check",
    "investigate",
    "triage",
    "look into",
    "look at",
    "analyze",
    "run triage",
  ]),

  makeSeed("intent_signal", "exploration", [
    "show",
    "plot",
    "graph",
    "trend",
    "over time",
    "breakdown",
  ]),
];

const ATS_CRC_SEEDS: LexiconSeed[] = getAtsCrcLexiconSeeds().map((entry) =>
  makeSeed("glossary_term", entry.canonical, entry.aliases, {
    querySupported: entry.querySupported,
    metadata: {
      category: entry.category,
      family: entry.family,
      metric: "ats_crc",
    },
  })
);

export const DOMAIN_LEXICON_SEEDS: LexiconSeed[] = [
  ...CORE_LEXICON_SEEDS,
  ...ATS_CRC_SEEDS,
];

const ALIAS_INDEX = DOMAIN_LEXICON_SEEDS.flatMap((seed) =>
  seed.aliases.map((alias) => ({
    alias,
    canonical: seed.canonical,
    kind: seed.kind,
    querySupported: seed.querySupported,
    metadata: seed.metadata,
  }))
).sort((a, b) => b.alias.length - a.alias.length);

export const SUPPORTED_METRICS: CanonicalMetric[] = [
  "ats",
  "latency",
  "errors",
  "requests",
  "status_codes",
  "ats_crc",
];

export const SUPPORTED_VIEWS: CanonicalView[] = [
  "summary",
  "timeseries",
  "breakdown",
  "compare",
  "drill",
  "explain",
  "glossary",
];

export const SUPPORTED_DIMENSIONS: CanonicalDimension[] = [
  "region",
  "pop",
  "contentType",
  "uaFamily",
  "host",
];

export const SUPPORTED_SERVICES: CanonicalService[] = [
  "live",
  "vod",
  "dvr",
  "eas",
  "live_ott",
  "app_backend",
];

export function getDomainLexiconSeeds(): LexiconSeed[] {
  return DOMAIN_LEXICON_SEEDS;
}

export function getAliasesForCanonical(canonical: string): string[] {
  const matches = DOMAIN_LEXICON_SEEDS.filter((seed) => seed.canonical === canonical);
  return uniq(matches.flatMap((m) => m.aliases));
}

function dedupeMatches(matches: LexiconMatch[]): LexiconMatch[] {
  const seen = new Set<string>();
  const out: LexiconMatch[] = [];

  for (const match of matches) {
    const key = `${match.kind}:${match.canonical}:${match.alias}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(match);
  }

  return out;
}

export function findLexiconMatches(raw: string): LexiconMatch[] {
  const text = normalizeText(raw);
  if (!text) return [];

  const matches: LexiconMatch[] = [];

  for (const item of ALIAS_INDEX) {
    const pattern = new RegExp(`(^|\\s)${escapeRegExp(item.alias)}(?=\\s|$)`, "i");
    if (pattern.test(text)) {
      matches.push({
        canonical: item.canonical,
        alias: item.alias,
        kind: item.kind,
        querySupported: item.querySupported,
        metadata: item.metadata,
      });
    }
  }

  return dedupeMatches(matches);
}

export function findCanonicalByAlias(
  raw: string,
  kind?: CanonicalTokenKind
): LexiconMatch | null {
  const token = normalizeToken(raw);
  if (!token) return null;

  const seeds = kind
    ? DOMAIN_LEXICON_SEEDS.filter((seed) => seed.kind === kind)
    : DOMAIN_LEXICON_SEEDS;

  for (const seed of seeds) {
    if (seed.aliases.includes(token)) {
      return {
        canonical: seed.canonical,
        alias: token,
        kind: seed.kind,
        querySupported: seed.querySupported,
        metadata: seed.metadata,
      };
    }
  }

  return null;
}

export function detectGlossaryIntent(raw: string): GlossaryDetection {
  const text = String(raw || "").trim();
  if (!text) return { isGlossary: false };

  if (isDefinitionQuestion(text)) {
    const term = extractTermFromDefinitionQuestion(text);
    const entry = lookupAtsCrc(term);
    if (entry) {
      return {
        isGlossary: true,
        term,
        canonical: entry.key,
        title: entry.title,
        family: entry.family,
        querySupported: entry.querySupported,
      };
    }
  }

  const direct = lookupAtsCrc(text);
  if (direct) {
    return {
      isGlossary: true,
      term: text,
      canonical: direct.key,
      title: direct.title,
      family: direct.family,
      querySupported: direct.querySupported,
    };
  }

  return { isGlossary: false };
}

export function detectMetricHints(raw: string): CanonicalMetric[] {
  const matches = findLexiconMatches(raw);
  const metrics = matches
    .filter((m) => m.kind === "metric")
    .map((m) => m.canonical as CanonicalMetric);

  const hasAtsCode = matches.some((m) => m.kind === "glossary_term");
  if (hasAtsCode) metrics.push("ats_crc");

  return uniq(metrics);
}

export function detectViewHints(raw: string): CanonicalView[] {
  const matches = findLexiconMatches(raw);
  return uniq(
    matches
      .filter((m) => m.kind === "view")
      .map((m) => m.canonical as CanonicalView)
  );
}

export function detectDimensionHints(raw: string): CanonicalDimension[] {
  const matches = findLexiconMatches(raw);
  return uniq(
    matches
      .filter((m) => m.kind === "dimension")
      .map((m) => m.canonical as CanonicalDimension)
  );
}

export function detectServiceHints(raw: string): CanonicalService[] {
  const matches = findLexiconMatches(raw);
  return uniq(
    matches
      .filter((m) => m.kind === "service")
      .map((m) => m.canonical as CanonicalService)
  );
}

export function detectAtsCrcTerms(raw: string): AtsGlossaryExecutionHint[] {
  const matches = findLexiconMatches(raw).filter((m) => m.kind === "glossary_term");

  const fromLexicon: AtsGlossaryExecutionHint[] = matches.map((m) => ({
    canonical: m.canonical,
    family: String(m.metadata?.family || "miss") as AtsOperationalFamily,
    title: undefined,
    querySupported: !!m.querySupported,
  }));

  const direct = lookupAtsCrc(raw);
  if (direct) {
    fromLexicon.push({
      canonical: direct.key,
      family: direct.family,
      title: direct.title,
      querySupported: direct.querySupported,
    });
  }

  const seen = new Set<string>();
  return fromLexicon.filter((item) => {
    if (seen.has(item.canonical)) return false;
    seen.add(item.canonical);
    return true;
  });
}

export function detectAtsFamilyHints(raw: string): AtsOperationalFamily[] {
  const normalized = normalizeForLexicon(raw);
  const families: AtsOperationalFamily[] = [];

  if (/\bhit\b/.test(normalized)) families.push("hit");
  if (/\bmiss\b/.test(normalized)) families.push("miss");
  if (/\brefresh\b/.test(normalized)) families.push("refresh");

  if (
    /\bclient_err\b|\bclient err(or)?s?\b|\bclient errors?\b/.test(normalized)
  ) {
    families.push("client_err");
  }

  if (
    /\binfra_err\b|\binfra err(or)?s?\b|\binfra errors?\b/.test(normalized)
  ) {
    families.push("infra_err");
  }

  for (const term of detectAtsCrcTerms(normalized)) {
    families.push(term.family);
  }

  return uniq(families);
}

export function normalizeAtsExecutionFamily(
  raw: string
): AtsOperationalFamily | null {
  const families = detectAtsFamilyHints(raw);
  if (!families.length) return null;
  return families[0] ?? null;
}

/**
 * Safe bounded normalization for glossary + parser hints.
 * This does not attempt full intent parsing.
 */
export function normalizeForLexicon(raw: string): string {
  return normalizeInput(raw).normalizedText;
}
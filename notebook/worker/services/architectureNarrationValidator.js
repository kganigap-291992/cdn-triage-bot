/**
 * architectureNarrationValidator.js
 *
 * BUG-22P.3
 *
 * Deterministic post-generation safety validator for architecture narration.
 *
 * Borrowed ideas:
 * - Guardrails AI: rule-based validators after generation
 * - RAGFlow: evidence-bound acceptance before surfacing answers
 * - OpenAI eval-style checks: explicit violation categories
 *
 * Owns:
 * - unsafe phrase detection
 * - unresolved internal component safety checks
 * - validator result payload
 *
 * Does NOT own:
 * - LLM generation
 * - traversal
 * - architecture truth
 * - fallback narration generation
 * - component classification
 */

const VALIDATOR_VERSION = "architecture-narration-validator-v1";

const VIOLATION_TYPES = {
  UNSAFE_PHRASE: "unsafe_phrase",
  INTERNAL_COMPONENT_BEHAVIOR: "internal_component_behavior",
};

const UNSAFE_PHRASE_RULES = [
  {
    phrase: "load balances traffic",
    pattern: /\bload\s+balances?\s+traffic\b/i,
    reason: "Claims load balancing behavior without evidence.",
  },
  {
    phrase: "business logic",
    pattern: /\bbusiness\s+logic\b/i,
    reason: "Claims application behavior without evidence.",
  },
  {
    phrase: "validates jwt",
    pattern: /\bvalidates?\s+jwt\b|\bjwt\s+validation\b/i,
    reason: "Claims JWT validation without evidence.",
  },
  {
    phrase: "oauth",
    pattern: /\boauth\b/i,
    reason: "Claims OAuth behavior without evidence.",
  },
  {
    phrase: "cache invalidation",
    pattern: /\bcache\s+invalidation\b|\binvalidates?\s+cache\b/i,
    reason: "Claims cache invalidation behavior without evidence.",
  },
  {
    phrase: "replication",
    pattern: /\breplicat(?:e|es|ed|ion|ing)\b/i,
    reason: "Claims replication behavior without evidence.",
  },
  {
    phrase: "failover",
    pattern: /\bfailover\b/i,
    reason: "Claims failover behavior without evidence.",
  },
  {
    phrase: "autoscaling",
    pattern: /\bauto[-\s]?scal(?:e|es|ing)\b/i,
    reason: "Claims autoscaling behavior without evidence.",
  },
  {
    phrase: "service mesh",
    pattern: /\bservice\s+mesh\b/i,
    reason: "Claims service mesh behavior without evidence.",
  },
  {
    phrase: "token validation",
    pattern: /\btoken\s+validation\b|\bvalidates?\s+tokens?\b/i,
    reason: "Claims token validation without evidence.",
  },
  {
    phrase: "encrypts traffic",
    pattern: /\bencrypts?\s+traffic\b|\bencryption\b/i,
    reason: "Claims encryption behavior without evidence.",
  },
  {
  phrase: "responsible for directing requests",
  pattern: /\bresponsible\s+for\s+directing\s+requests\b/i,
  reason: "Claims routing/directing behavior without evidence.",
},
{
  phrase: "directing requests",
  pattern: /\bdirecting\s+requests\b/i,
  reason: "Claims routing/directing behavior without evidence.",
},
{
  phrase: "handles core processing tasks",
  pattern: /\bhandles?\s+core\s+processing\s+tasks\b/i,
  reason: "Claims application processing behavior without evidence.",
},
{
  phrase: "core processing tasks",
  pattern: /\bcore\s+processing\s+tasks\b/i,
  reason: "Claims application processing behavior without evidence.",
},
  {
    phrase: "retry logic",
    pattern: /\bretry\s+logic\b|\bretries\b/i,
    reason: "Claims retry behavior without evidence.",
  },
];

const BEHAVIOR_VERBS = [
  "balances",
  "routes",
  "validates",
  "authenticates",
  "authorizes",
  "processes",
  "executes",
  "stores",
  "replicates",
  "encrypts",
  "decrypts",
  "orchestrates",
  "scales",
  "caches",
  "invalidates",
  "transforms",
  "directs",
    "handles",
];

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function safeString(value) {
  return String(value || "").trim();
}

function normalizeText(value) {
  return safeString(value)
    .replace(/\s+/g, " ")
    .trim();
}

function escapeRegExp(value = "") {
  return safeString(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function containsUnsafePhrase(text = "") {
  const narration = normalizeText(text);

  return UNSAFE_PHRASE_RULES
    .filter((rule) => rule.pattern.test(narration))
    .map((rule) => ({
      type: VIOLATION_TYPES.UNSAFE_PHRASE,
      phrase: rule.phrase,
      reason: rule.reason,
      severity: "high",
    }));
}

function collectInternalComponents(compactNarrationContext = []) {
  const components = new Map();

  for (const hop of asArray(compactNarrationContext)) {
    for (const side of ["from", "to"]) {
      const component = hop?.[side];
      const name = safeString(component?.componentName);

      if (!name) continue;

      if (component.knowledgeType === "internal_unresolved") {
        components.set(name.toLowerCase(), {
          componentName: name,
          journeyRole: component.journeyRole || "unknown",
          journeyPosition: component.journeyPosition || null,
        });
      }
    }
  }

  return Array.from(components.values());
}

function findInternalBehaviorClaims({
  narration = "",
  compactNarrationContext = [],
} = {}) {
  const text = normalizeText(narration);
  const violations = [];
  const internalComponents = collectInternalComponents(compactNarrationContext);

  for (const component of internalComponents) {
    const componentName = component.componentName;
    const escapedName = escapeRegExp(componentName);

    for (const verb of BEHAVIOR_VERBS) {
      const pattern = new RegExp(
        `\\b${escapedName}\\b[^.]{0,80}\\b${verb}\\b`,
        "i"
      );

      if (pattern.test(text)) {
        violations.push({
          type: VIOLATION_TYPES.INTERNAL_COMPONENT_BEHAVIOR,
          componentName,
          verb,
          journeyRole: component.journeyRole,
          reason:
            "Narration appears to assign implementation behavior to an unresolved internal component.",
          severity: "high",
        });
      }
    }
  }

  return violations;
}

function validateRailNarration({
  narration = "",
  railInput = {},
  compactNarrationContext = null,
} = {}) {
  const effectiveCompactContext =
    compactNarrationContext ||
    railInput.compactNarrationContext ||
    [];

  const unsafePhraseViolations =
    containsUnsafePhrase(narration);

  const internalBehaviorViolations =
    findInternalBehaviorClaims({
      narration,
      compactNarrationContext: effectiveCompactContext,
    });

  const violations = [
    ...unsafePhraseViolations,
    ...internalBehaviorViolations,
  ];

  return {
    version: VALIDATOR_VERSION,
    valid: violations.length === 0,
    violationCount: violations.length,
    violations,
    stats: {
      unsafePhraseCount: unsafePhraseViolations.length,
      internalBehaviorClaimCount: internalBehaviorViolations.length,
    },
  };
}

module.exports = {
  VALIDATOR_VERSION,
  VIOLATION_TYPES,
  UNSAFE_PHRASE_RULES,
  BEHAVIOR_VERBS,
  containsUnsafePhrase,
  collectInternalComponents,
  findInternalBehaviorClaims,
  validateRailNarration,
};
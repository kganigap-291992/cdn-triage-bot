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
  UNSUPPORTED_EVIDENCE_CLAIM: "unsupported_evidence_claim",

  RESPONSIBILITY_COUNT_MISMATCH:
    "responsibility_count_mismatch",

  RESPONSIBILITY_TRANSITION_MISSING:
    "responsibility_transition_missing",

  SHARED_NODE_GLOBAL_BEHAVIOR:
    "shared_node_global_behavior",

  MULTIRAIL_PRIMARY_MISSING:
    "multirail_primary_missing",

  MULTIRAIL_PARALLEL_MISSING:
    "multirail_parallel_missing",

  MULTIRAIL_SUPPORTING_AS_PRIMARY:
    "multirail_supporting_as_primary",

  RESPONSIBILITY_COMPONENT_TO_COMPONENT:
    "responsibility_component_to_component",

  DIRECTION_REVERSE_INVENTED:
  "direction_reverse_invented",

    DIRECTION_OBSERVED_CONTRADICTION:
    "direction_observed_contradiction",

    DIRECTION_UNSUPPORTED_BIDIRECTIONAL_CLAIM:
    "direction_unsupported_bidirectional_claim",
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
  phrase: "responsible for directing traffic",
    pattern: /\bresponsible\s+for\s+directing\s+traffic\b/i,
    reason: "Claims routing/directing behavior without evidence.",
    },
    {
    phrase: "directing traffic",
    pattern: /\bdirecting\s+traffic\b/i,
    reason: "Claims routing/directing behavior without evidence.",
    },
    {
    phrase: "core processing occurs",
    pattern: /\bcore\s+processing\s+occurs\b/i,
    reason: "Claims application processing behavior without evidence.",
    },
    {
    phrase: "core application logic",
    pattern: /\bcore\s+application\s+logic\b/i,
    reason: "Claims application logic behavior without evidence.",
    },
    {
    phrase: "processes the request",
    pattern: /\bprocess(?:es|ing)?\s+the\s+request\b/i,
    reason: "Claims request processing behavior without evidence.",
    },
    {
    phrase: "responsible for directing incoming requests",
    pattern: /\bresponsible\s+for\s+directing\s+incoming\s+requests\b/i,
    reason: "Claims routing/directing behavior without evidence.",
    },
    {
    phrase: "cached content",
    pattern: /\bcached\s+content\b|\brelevant\s+data\s+cached\b/i,
    reason: "Claims cache contents/behavior without evidence.",
    },
    {
    phrase: "fetching data from origin",
    pattern: /\bfetch(?:es|ing)?\s+data\s+from\s+(?:the\s+)?origin\b/i,
    reason: "Claims origin fetch behavior without evidence.",
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

function collectComponentEvidenceText(compactNarrationContext = []) {
  return asArray(compactNarrationContext)
    .flatMap((hop) => [hop?.from, hop?.to, hop?.handoffTeaching])
    .filter(Boolean)
    .map((item) =>
      [
        item.componentName,
        item.journeyRole,
        item.documentDefinition,
        item.industryExplanation,
        ...asArray(item.whyHere),
        ...asArray(item.problemSolved),
        ...asArray(item.nextStageBenefit),
        item.whyHereMentorExplanation,
        item.whatChanged,
        item.responsibilityShift,
        item.whyHandoffExists,
        item.teachingFrame,
      ]
        .filter(Boolean)
        .join(" ")
    )
    .join(" ");
}

function collectAllowedEvidenceClaims(compactNarrationContext = []) {
  return Array.from(
    new Set(
      asArray(compactNarrationContext)
        .flatMap((hop) => [
          ...asArray(hop?.allowedEvidenceClaims),
          ...asArray(hop?.from?.allowedEvidenceClaims),
          ...asArray(hop?.to?.allowedEvidenceClaims),
        ])
        .map((claim) => safeString(claim).toLowerCase())
        .filter(Boolean)
    )
  );
}

function classifyUnsafePhrase(rule = {}) {
  const phrase = safeString(rule.phrase).toLowerCase();

  if (/directing|routing|route/.test(phrase)) return "routing";
  if (/processing|application logic|business logic|processes|core processing/.test(phrase)) return "processing";
  if (/cached content|cache/.test(phrase)) return "cache_delivery";
  if (/database|stores|storage|state/.test(phrase)) return "state";
  if (/validates|validation|jwt|oauth|token/.test(phrase)) return "validation";

  return null;
}

function hasEvidenceForUnsafePhrase(rule = {}, compactNarrationContext = []) {
  const claimType = classifyUnsafePhrase(rule);
  if (!claimType) return false;

  const allowedClaims =
    collectAllowedEvidenceClaims(compactNarrationContext);

  return allowedClaims.includes(claimType);
}

function containsUnsafePhrase(text = "", compactNarrationContext = []) {
  const narration = normalizeText(text);

  return UNSAFE_PHRASE_RULES
    .filter((rule) => rule.pattern.test(narration))
    .map((rule) => {
      const evidenceSupported = hasEvidenceForUnsafePhrase(
        rule,
        compactNarrationContext
      );

      if (evidenceSupported) {
        return {
          type: VIOLATION_TYPES.UNSUPPORTED_EVIDENCE_CLAIM,
          phrase: rule.phrase,
          reason:
            "Phrase matched an unsafe pattern, but compact narration context contains supporting evidence. Allowed with evidence.",
          severity: "allowed_with_evidence",
          allowed: true,
        };
      }

      return {
        type: VIOLATION_TYPES.UNSAFE_PHRASE,
        phrase: rule.phrase,
        reason: rule.reason,
        severity: "high",
        allowed: false,
      };
    })
    .filter((violation) => violation.allowed !== true);
}

function hasDocumentBackedMeaning(component = {}) {
  return Boolean(
    safeString(component.documentDefinition)
  );
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
        documentDefinition: component.documentDefinition || null,
        evidenceBackedMeaning:
            hasDocumentBackedMeaning(component),
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
      if (component.evidenceBackedMeaning) {
            continue;
        }
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

function parseResponsibilityTransitionSentence(sentence = "") {
  const text = normalizeText(sentence);

  const match = text.match(
    /^(.+?)\s+transfers responsibility from\s+([a-z_]+)\s+to\s+([a-z_]+)\s+as\s+([a-z_]+)\.?$/i
  );

  if (!match) {
    return null;
  }

  return {
    componentName: safeString(match[1]),
    fromRole: safeString(match[2]).toLowerCase(),
    toRole: safeString(match[3]).toLowerCase(),
    handoffType: safeString(match[4]).toLowerCase(),
  };
}

function validateResponsibilityTransitions({
  narration = "",
  railInput = {},
} = {}) {
  const violations = [];

  const expectedTransitions =
    asArray(
      railInput.hopResponsibilitySentences
    );

  if (!expectedTransitions.length) {
    return violations;
  }

  const text = normalizeText(narration);

  const actualCount =
    (
      text.match(
        /\b(?:transfers|transferring|moves|moving)\s+responsibility\s+from\b/gi
      ) || []
    ).length;

  if (actualCount > expectedTransitions.length) {
    violations.push({
      type:
        VIOLATION_TYPES
          .RESPONSIBILITY_COUNT_MISMATCH,

      expectedCount:
        expectedTransitions.length,

      actualCount,

      severity: "high",

      reason:
        "Narration contains more responsibility transitions than supplied hops.",
    });
  }

  for (const sentence of expectedTransitions) {
    const expected =
        parseResponsibilityTransitionSentence(sentence);

    if (!expected) {
        continue;
    }

    const componentPattern =
        escapeRegExp(expected.componentName);

    const transitionPattern = new RegExp(
        `\\b${componentPattern}\\b[^.]{0,160}\\b(?:transfers|transferring|moves|moving)\\s+responsibility\\s+from\\s+${expected.fromRole}\\s+to\\s+${expected.toRole}\\b`,
        "i"
    );

    if (!transitionPattern.test(text)) {
        violations.push({
        type:
            VIOLATION_TYPES
            .RESPONSIBILITY_TRANSITION_MISSING,

        expectedTransition: sentence,

        expectedComponent:
            expected.componentName,

        expectedFromRole:
            expected.fromRole,

        expectedToRole:
            expected.toRole,

        severity: "high",

        reason:
            "Expected responsibility transition role pair is missing from narration.",
        });
    }
    }

  return violations;
}

function validateSharedNodeNarration({
  narration = "",
  railInput = {},
} = {}) {
  const violations = [];
  const text = normalizeText(narration).toLowerCase();

  const sharedHints =
    asArray(railInput.sharedNodeNarrationHints);

  if (!sharedHints.length) {
    return violations;
  }

  for (const hint of sharedHints) {
    const componentName = safeString(hint.componentName);
    if (!componentName) continue;

    const escapedName = escapeRegExp(componentName);

    const railRoleClassification =
        hint.railRoleClassification || null;

    const hasRailSpecificRoleDifference =
        hint.hasRailSpecificRoleDifference === true;

    const globalBehaviorPattern = new RegExp(
        `\\b${escapedName}\\b[^.]{0,100}\\b(always|globally|across all rails|in every rail|same responsibility|same role)\\b`,
        "i"
    );

    if (
        hasRailSpecificRoleDifference &&
        globalBehaviorPattern.test(text)
    ) {
        violations.push({
        type:
            VIOLATION_TYPES.SHARED_NODE_GLOBAL_BEHAVIOR,

        componentName,
        classification: hint.classification,

        railRoleClassification,
        hasRailSpecificRoleDifference,

        severity: "high",

        reason:
            "Narration implies a shared node has one global behavior across rails instead of using per-hop responsibility.",
        });
    }
    }

  return violations;
}

function validateMultiRailNarration({
  narration = "",
  railInput = {},
} = {}) {
  const violations = [];

  const text =
    normalizeText(narration).toLowerCase();

  const multiRailContext =
    railInput.multiRailContext || {};

  const relationship =
    safeString(
      multiRailContext.railRelationship
    );

  if (relationship === "primary") {
    if (
      !/\bcanonical\b|\bmain walkthrough\b/i.test(text)
    ) {
      violations.push({
        type:
          VIOLATION_TYPES.MULTIRAIL_PRIMARY_MISSING,
        severity: "medium",
        reason:
          "Primary rail narration does not identify itself as the canonical/main walkthrough.",
      });
    }
  }

  if (relationship === "parallel") {
    if (
      !/\balongside the canonical journey\b/i.test(text)
    ) {
      violations.push({
        type:
          VIOLATION_TYPES.MULTIRAIL_PARALLEL_MISSING,
        severity: "medium",
        reason:
          "Parallel rail narration does not explain that it is taught alongside the canonical journey.",
      });
    }
  }

  if (relationship === "supports") {
    if (
      /\bcanonical\b|\bmain walkthrough\b|\bprimary journey\b/i.test(text)
    ) {
      violations.push({
        type:
          VIOLATION_TYPES.MULTIRAIL_SUPPORTING_AS_PRIMARY,
        severity: "high",
        reason:
          "Supporting rail is being described as the primary journey.",
      });
    }
  }

  return violations;
}

function validateResponsibilityLanguage(
  narration = ""
) {
  const violations = [];

  const text = normalizeText(narration);

  const pattern =
  /\bresponsibility\s+(?:then\s+)?moves\s+from\s+(?:the\s+)?[A-Z][A-Za-z0-9 _-]+\s+to\s+(?:the\s+)?[A-Z][A-Za-z0-9 _-]+/;

  if (pattern.test(text)) {
    violations.push({
      type:
        VIOLATION_TYPES
          .RESPONSIBILITY_COMPONENT_TO_COMPONENT,

      severity: "medium",

      reason:
        "Responsibility should move between roles, not component names.",
    });
  }

  return violations;
}

function validateDirectionNarration({
  narration = "",
  railInput = {},
} = {}) {
  const violations = [];

  const text =
    normalizeText(narration).toLowerCase();

  const compactContext =
    asArray(
      railInput.compactNarrationContext
    );

  const directionContexts =
    compactContext
      .map((hop) => hop.directionContext)
      .filter(Boolean);

  if (!directionContexts.length) {
    return violations;
  }

  const hasReversePossible =
    directionContexts.some(
      (ctx) =>
        ctx.directionTeachingContext
          ?.teachingBoundary ===
        "observed_forward_reverse_possible"
    );

  if (
    /\breverse flow\b|\breverse direction\b|\bflows back\b/i.test(
      text
    ) &&
    !hasReversePossible
  ) {
    violations.push({
      type:
        VIOLATION_TYPES
          .DIRECTION_UNSUPPORTED_BIDIRECTIONAL_CLAIM,
      severity: "high",
      reason:
        "Narration introduces reverse direction without supporting direction context.",
    });
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
  containsUnsafePhrase(
    narration,
    effectiveCompactContext
  );

  const internalBehaviorViolations =
    findInternalBehaviorClaims({
      narration,
      compactNarrationContext: effectiveCompactContext,
    });

  const responsibilityViolations =
    validateResponsibilityTransitions({
        narration,
        railInput,
    });

    const sharedNodeViolations =
    validateSharedNodeNarration({
        narration,
        railInput,
    });

    const multiRailViolations =
    validateMultiRailNarration({
         narration,
        railInput,
        });

    const responsibilityLanguageViolations =
    validateResponsibilityLanguage(
        narration
    );

    const directionViolations =
    validateDirectionNarration({
        narration,
        railInput,
    });

    const violations = [
    ...unsafePhraseViolations,
    ...internalBehaviorViolations,
    ...responsibilityViolations,
    ...sharedNodeViolations,
    ...multiRailViolations,
    ...responsibilityLanguageViolations,
    ...directionViolations,
    ];

  return {
    version: VALIDATOR_VERSION,
    valid: violations.length === 0,
    violationCount: violations.length,
    violations,
    stats: {
    unsafePhraseCount:
        unsafePhraseViolations.length,

    internalBehaviorClaimCount:
        internalBehaviorViolations.length,

    responsibilityViolationCount:
        responsibilityViolations.length,

    sharedNodeViolationCount:
        sharedNodeViolations.length,

    multiRailViolationCount:
        multiRailViolations.length,

    responsibilityLanguageViolationCount:
        responsibilityLanguageViolations.length,

    directionViolationCount:
        directionViolations.length,
    }
  };
}

module.exports = {
  VALIDATOR_VERSION,
  VIOLATION_TYPES,
  UNSAFE_PHRASE_RULES,
  BEHAVIOR_VERBS,
  containsUnsafePhrase,
  collectComponentEvidenceText,
  collectAllowedEvidenceClaims,
  classifyUnsafePhrase,
  hasEvidenceForUnsafePhrase,
  collectInternalComponents,
  findInternalBehaviorClaims,
  validateSharedNodeNarration,
  validateRailNarration,
};
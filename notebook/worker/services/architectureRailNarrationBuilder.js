// notebook/worker/services/architectureRailNarrationBuilder.js

/**
 * architectureRailNarrationBuilder.js
 *
 * BUG-22U.11C
 *
 * Owns rail-level mentor narration.
 *
 * Does:
 * - turn deterministic rail groups into natural senior-engineer narration
 * - preserve hop order, evidence, confidence, and safety boundaries
 * - produce fallback narration if LLM is unavailable/invalid
 *
 * Does NOT:
 * - decide traversal order
 * - create or remove hops
 * - infer architecture truth
 * - decide camera/rendering
 */

const fs = require("fs");
const path = require("path");

const {
  validateRailNarration,
} = require("./architectureNarrationValidator");

const BUILDER_VERSION = "architecture-rail-narration-v1";

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function safeString(value) {
  return String(value || "").trim();
}

function compactText(value, maxLength = 1400) {
  const text = safeString(value).replace(/\s+/g, " ");
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1).trim()}…`;
}

function formatRailPath(hops = []) {
  return asArray(hops)
    .map((hop, index) => {
      const from = safeString(hop?.from?.name);
      const to = safeString(hop?.to?.name);
      if (!from || !to) return null;
      return index === 0 ? `${from} → ${to}` : `→ ${to}`;
    })
    .filter(Boolean)
    .join(" ");
}


function normalizeKey(value) {
  return safeString(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function buildComponentContextLookup({
  componentUnderstanding = {},
  architectureIndustryKnowledge = {},
} = {}) {
  const lookup = new Map();

  const componentIndex = new Map();

  for (const component of asArray(componentUnderstanding.components)) {
    componentIndex.set(
      normalizeKey(component.componentName),
      component
    );
  }

  const industryIndex = new Map();

  for (const context of asArray(
    architectureIndustryKnowledge.contexts
  )) {
    industryIndex.set(
      normalizeKey(context.componentName),
      context
    );
  }

  for (const [key, component] of componentIndex.entries()) {
    lookup.set(key, {
      component,

      industryKnowledge:
        industryIndex.get(key) || null,
    });
  }

  return lookup;
}

function resolveComponentContext(
  componentName,
  lookup
) {
  if (!componentName) return null;

  return (
    lookup.get(
      normalizeKey(componentName)
    ) || null
  );
}


function buildComponentTeachingContext(
  componentName,
  componentContext
) {
  if (!componentName) return null;

  const component = componentContext?.component || null;
  const industryKnowledge =
    componentContext?.industryKnowledge || null;

  if (!component) {
    return {
      componentName,
      found: false,
      knowledgeType: "unknown",
      industryConcept: null,
      industryExplanation: null,
      journeyRole: "unknown",
      journeyPosition: null,
      safeToExplainIndustry: false,
      documentDefinition: null,
      safety: {
        canInferInternalBehavior: false,
      },
    };
  }

  return {
    componentName:
      component.componentName || componentName,

    found: true,

    knowledgeType:
      component.knowledgeType || "unknown",

    industryConcept:
      component.industryConcept || null,

    industryExplanation:
      industryKnowledge?.explanation || null,

    journeyRole:
      component.primaryJourneyRole || "unknown",

    journeyPosition:
      component.primaryJourneyPosition || null,

    safeToExplainIndustry:
      component.safety?.canExplainIndustryContext === true &&
      Boolean(industryKnowledge?.explanation),

    documentDefinition:
      component.documentDefinition || null,

    primaryRailContext:
      component.primaryRailContext || null,

    safety: {
      canInferInternalBehavior:
        component.safety?.canInferInternalBehavior === true,

      requiresEvidenceForPrivateMeaning:
        component.safety?.requiresEvidenceForPrivateMeaning === true,

      industryContextAllowed:
        industryKnowledge?.industryContextAllowed === true,
    },
  };
}

function buildHopTeachingContext(
  hop,
  componentContextLookup
) {
  const fromContext =
    resolveComponentContext(
      hop.from,
      componentContextLookup
    );

  const toContext =
    resolveComponentContext(
      hop.to,
      componentContextLookup
    );

  return {
    hopId: hop.hopId,
    from:
      buildComponentTeachingContext(
        hop.from,
        fromContext
      ),
    to:
      buildComponentTeachingContext(
        hop.to,
        toContext
      ),
  };
}

function compactComponentNarrationContext(component = {}) {
  if (!component) return null;

  return {
    componentName:
      component.componentName || null,

    knowledgeType:
      component.knowledgeType || "unknown",

    industryConcept:
      component.industryConcept || null,

    journeyRole:
      component.journeyRole || "unknown",

    journeyPosition:
      component.journeyPosition || null,

    industryExplanation:
      component.safeToExplainIndustry
        ? compactText(component.industryExplanation, 450)
        : null,

    documentDefinition:
      component.documentDefinition || null,

    safeToExplainIndustry:
      component.safeToExplainIndustry === true,

    canInferInternalBehavior:
      component.safety?.canInferInternalBehavior === true,
  };
}

function buildCompactNarrationContext(hopTeachingContext = []) {
  return asArray(hopTeachingContext).map((hop) => ({
    hopId: hop.hopId,
    from: compactComponentNarrationContext(hop.from),
    to: compactComponentNarrationContext(hop.to),
  }));
}


function buildRailNarrationInput(rail = {}, index = 0) {
  const hops = asArray(rail.hops);

  return {
    railId:
      rail.id ||
      rail.flowLaneId ||
      `rail_${index + 1}`,

    index,

    title:
      safeString(rail.title) ||
      "Architecture rail",

    flowLaneId:
      rail.flowLaneId || null,

    flowLaneType: null,

    flowLaneLabel:
    rail.flowLaneType || null,

    primaryRailType:
      rail.primaryRailType || null,

    promotionReason:
      rail.promotionReason || null,

    pathText:
      safeString(rail.pathText) ||
      formatRailPath(hops),

    hopCount:
      hops.length,

    allowedNarrationScope: [
    "hop order",
    "component names",
    "architectural position",
    "ownership progression",
    ],

    disallowedInferences: [
    "cache behavior",
    "api processing behavior",
    "routing behavior",
    "application business logic",
    "database storage behavior",
    "synchronization behavior",
    ],  

    hops: hops.map((hop, hopIndex) => ({
      hopId: hop.hopId || `hop_${hopIndex + 1}`,
      canonicalOrder: hop.canonicalOrder ?? hopIndex + 1,
      from: hop.from?.name || null,
      to: hop.to?.name || null,
      flowLaneId: hop.flowLaneId || null,
      flowLaneType: null,
      flowLaneLabel:
        hop.flowLaneType || null,
      confidence: hop.confidence || rail.confidence || "unknown",
      evidenceTypes: asArray(hop.evidenceTypes),
      inferred: hop?.safety?.inferred === true,
    })),
  };
}

function buildRailNarrationFallback(rail = {}) {
  const title = safeString(rail.title) || "Architecture rail";
  const flowLaneType = safeString(rail.flowLaneType);
  const primaryRailType = safeString(rail.primaryRailType);
  const hops = asArray(rail.hops);
  const pathText = safeString(rail.pathText) || formatRailPath(hops);

  const intro =
    primaryRailType === "canonical_primary"
      ? `${title} is the main walkthrough path through the architecture.`
      : `${title} is a supporting walkthrough rail in the architecture.`;

  const laneContext = flowLaneType
    ? `It is classified as ${flowLaneType.replace(/_/g, " ")}.`
    : "";

  return compactText(
    [
      intro,
      pathText ? `The path is ${pathText}.` : "",
      laneContext,
      "Read it as one coherent responsibility story, not as isolated arrows.",
    ]
      .filter(Boolean)
      .join(" ")
  );
}

function buildRailStyleContract() {
  return {
    version: "architecture-rail-narration-style-contract-v1",
    targetStyle: "senior_engineer_architecture_walkthrough",
    voice: "single_primary_mentor",
    narrationRules: [
      "explain the rail as one coherent architecture journey",
      "preserve the exact hop order",
      "do not add, remove, or reorder hops",
      "explain responsibility transitions, not isolated arrows",
      "do not invent protocols, auth behavior, cache behavior, retries, failover, replication, autoscaling, encryption, or vendor-specific details",
      "use cautious language when confidence is limited",
      "avoid repeated phrases like documented handoff, responsibility shift, or flow moves",
      "sound natural and calm, not corporate or preachy",
    ],
    borrowedIdeas: [
      "NotebookLM chapter-level explanation",
      "OpenTelemetry trace-level narration",
      "RAGFlow evidence-bounded generation",
      "LlamaIndex source-grounded synthesis",
    ],
  };
}

function parseJsonObject(value) {
  try {
    if (!value) return null;
    if (typeof value === "object") return value;
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function isValidRailNarration(value) {
  return Boolean(
    value &&
      typeof value.narration === "string" &&
      safeString(value.narration).length >= 40
  );
}

async function generateRailNarrationWithLlm({
  input,
  llmClient,
  fallbackNarration,
}) {
  if (!llmClient) {
    return {
      narration: fallbackNarration,
      llmUsed: false,
      llmValid: false,
      fallbackUsed: true,
    };
  }

  try {
    const raw = await llmClient({
      task: "rail_narration",
      style: buildRailStyleContract(),
      input,
      requiredJsonShape: {
        narration: "string",
      },
    });

    const parsed = parseJsonObject(raw);

    if (!isValidRailNarration(parsed)) {
      throw new Error("Invalid rail narration JSON");
    }

    return {
      narration: compactText(parsed.narration, 1800),
      llmUsed: true,
      llmValid: true,
      fallbackUsed: false,
    };
  } catch {
    return {
      narration: fallbackNarration,
      llmUsed: true,
      llmValid: false,
      fallbackUsed: true,
    };
  }
}

async function buildArchitectureRailNarration({
  rails = [],
  llmClient = null,
  outputDir = null,
  componentUnderstanding = {},
  architectureIndustryKnowledge = {},
} = {}) {
  const railNarrations = [];

    const componentContextLookup =
  buildComponentContextLookup({
    componentUnderstanding,
    architectureIndustryKnowledge,
  });

  for (const [index, rail] of asArray(rails).entries()) {
    const input = buildRailNarrationInput(
        rail,
        index
        );

        input.hopTeachingContext = input.hops.map((hop) =>
        buildHopTeachingContext(
            hop,
            componentContextLookup
        )
        );

        input.compactNarrationContext =
        buildCompactNarrationContext(
            input.hopTeachingContext
        );
    const fallbackNarration = buildRailNarrationFallback(rail);

    const result = await generateRailNarrationWithLlm({
    input,
    llmClient,
    fallbackNarration,
    });

    const validation =
    validateRailNarration({
        narration: result.narration,
        railInput: input,
        compactNarrationContext:
        input.compactNarrationContext,
    });

    if (!validation.valid) {
        result.narration = fallbackNarration;
        result.llmValid = false;
        result.fallbackUsed = true;
        }

    railNarrations.push({
      railId: input.railId,
      index,
      title: input.title,
      flowLaneId: input.flowLaneId,
      flowLaneType: input.flowLaneType,
      flowLaneLabel: input.flowLaneLabel,
      primaryRailType: input.primaryRailType,
      promotionReason: input.promotionReason,
      pathText: input.pathText,
      hopCount: input.hopCount,
      hopIds: input.hops.map((hop) => hop.hopId),

        hopTeachingContext:
            input.hopTeachingContext,

            compactNarrationContext:
            input.compactNarrationContext,

            narration: result.narration,

            validation,

            llmUsed: result.llmUsed,
            llmValid: result.llmValid,
            fallbackUsed: result.fallbackUsed,
    });
  }

  const payload = {
    version: BUILDER_VERSION,
    source: "architectureRailNarrationBuilder",
    purpose:
      "Produce rail-level mentor narration from deterministic canonical traversal rails.",
    styleContract: buildRailStyleContract(),
    railCount: railNarrations.length,
    rails: railNarrations,
    stats: {
      llmUsedCount: railNarrations.filter((rail) => rail.llmUsed).length,
      llmValidCount: railNarrations.filter((rail) => rail.llmValid).length,
      fallbackUsedCount: railNarrations.filter((rail) => rail.fallbackUsed).length,
    },
  };

  if (outputDir) {
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(
      path.join(outputDir, "architecture-rail-narration.json"),
      JSON.stringify(payload, null, 2),
      "utf8"
    );
  }

  return payload;
}

module.exports = {
  BUILDER_VERSION,
  buildRailNarrationFallback,
  buildRailNarrationInput,
  buildRailStyleContract,
  generateRailNarrationWithLlm,
  buildArchitectureRailNarration,
};
/**
 * componentContinuityMemoryBuilder.js
 *
 * BUG-11A — Component Continuity Memory
 *
 * Owns:
 * - deterministic memory of which components have already been introduced
 * - component revisit guidance
 * - component continuity artifact generation
 *
 * Does NOT:
 * - change traversal
 * - call LLM
 * - narrate
 * - infer private implementation behavior
 */

const fs = require("fs");
const path = require("path");

const BUILDER_VERSION =
  "component-continuity-memory-v1";

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function safeString(value) {
  return String(value || "").trim();
}

function normalizeKey(value) {
  return safeString(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function uniq(values = []) {
  return Array.from(
    new Set(asArray(values).map(safeString).filter(Boolean))
  );
}

function buildComponentSupportIndex(evidenceTeachingSupport = {}) {
  const index = new Map();

  for (const item of asArray(evidenceTeachingSupport.components)) {
    const key = normalizeKey(
      item.subjectName ||
        item.componentName ||
        item.subjectId
    );

    if (key) {
      index.set(key, item);
    }
  }

  return index;
}

function buildHopMemoryByComponentName(hopContinuityMemory = {}) {
  const index = new Map();

  function add(name, hopMemory = {}) {
    const key = normalizeKey(name);
    if (!key) return;

    const current = index.get(key) || [];
    current.push(hopMemory);
    index.set(key, current);
  }

  for (const hop of asArray(hopContinuityMemory.hops)) {
    add(hop.from, hop);
    add(hop.to, hop);
  }

  return index;
}

function collectComponentJourneyTypes({
  component = {},
  hopMemories = [],
} = {}) {
  const fromRailContexts =
    asArray(component.railContexts).flatMap(
      (context) => [
        context.journeyType,
        context.primaryJourneyType,
        context.flowLaneType,
      ]
    );

  const fromHopMemory =
    asArray(hopMemories).flatMap(
      (hop) => hop.journeyTypes
    );

  return uniq([
    ...fromRailContexts,
    ...fromHopMemory,
  ]);
}

function collectSupportingHopIds({
  component = {},
  hopMemories = [],
} = {}) {
  const fromRailContexts =
    asArray(component.railContexts).flatMap(
      (context) => context.hopIds
    );

  const fromHopMemory =
    asArray(hopMemories).map((hop) => hop.hopId);

  return uniq([
    ...fromRailContexts,
    ...fromHopMemory,
  ]);
}

function collectJourneyRoles({
  component = {},
  support = null,
} = {}) {
  return uniq([
    component.primaryJourneyRole,
    ...asArray(component.railContexts).map(
      (context) => context.journeyRole
    ),
    support?.journeyRole,
  ]);
}

function findFirstIntroducedHop(hopMemories = []) {
  return (
    asArray(hopMemories).find(
      (hop) => hop.alreadyExplained === true
    ) || null
  );
}

function buildComponentMemoryRecord({
  component = {},
  support = null,
  hopMemories = [],
} = {}) {
  const componentName =
    component.componentName ||
    support?.subjectName ||
    "Unknown Component";

  const componentKey =
    component.normalizedName ||
    normalizeKey(componentName);

  const introducedHop =
    findFirstIntroducedHop(hopMemories);

  const alreadyExplained =
    Boolean(introducedHop);

  const journeyTypes =
    collectComponentJourneyTypes({
      component,
      hopMemories,
    });

  const supportingHopIds =
    collectSupportingHopIds({
      component,
      hopMemories,
    });

  const journeyRoles =
    collectJourneyRoles({
      component,
      support,
    });

  return {
    componentId:
      component.componentId ||
      support?.subjectId ||
      componentKey,

    componentName,

    normalizedName:
      componentKey,

    status:
      alreadyExplained
        ? "introduced"
        : "available",

    alreadyExplained,

    firstExplainedInHopId:
      introducedHop?.hopId || null,

    firstExplainedInRailTitle:
      introducedHop?.firstExplainedInRailTitle || null,

    firstExplainedInJourneyType:
      introducedHop?.firstExplainedInJourneyType || null,

    primaryJourneyRole:
      component.primaryJourneyRole ||
      support?.journeyRole ||
      "unknown",

    primaryJourneyPosition:
      component.primaryJourneyPosition ||
      support?.journeyPosition ||
      null,

    journeyRoles,

    journeyTypes,

    supportingHopIds,

    railContextCount:
      asArray(component.railContexts).length,

    knowledgeType:
      component.knowledgeType ||
      support?.knowledgeType ||
      "unknown",

    meaning:
      support?.meaning ||
      component.documentDefinition ||
      component.industryConcept ||
      null,

    supportedTeaching:
      asArray(support?.supportedTeaching).slice(0, 5),

    whyNeeded:
      asArray(support?.whyNeeded).slice(0, 5),

    problemSolved:
      asArray(support?.problemSolved).slice(0, 5),

    evidenceIds:
      uniq([
        ...asArray(component.definitionEvidenceId),
        ...asArray(support?.evidenceIds),
      ]),

    revisitGuidance:
      alreadyExplained
        ? `${componentName} has already been introduced. Do not reintroduce it from scratch; teach only the new journey, role, or responsibility context.`
        : `${componentName} has not been introduced yet. It can be taught as a new component.`,

    safety: {
      traversalChanged: false,
      memoryOnly: true,
      deterministic: true,
      canInferPrivateImplementation: false,
    },
  };
}

function buildComponentContinuityMemory({
  componentUnderstanding = {},
  evidenceTeachingSupport = {},
  hopContinuityMemory = {},
  outputDir = null,
} = {}) {
  const componentSupportIndex =
    buildComponentSupportIndex(evidenceTeachingSupport);

  const hopMemoryByComponentName =
    buildHopMemoryByComponentName(hopContinuityMemory);

  const components =
    asArray(componentUnderstanding.components).map(
      (component) => {
        const key = normalizeKey(
          component.normalizedName ||
            component.componentName ||
            component.componentId
        );

        const support =
          componentSupportIndex.get(key) || null;

        const hopMemories =
          hopMemoryByComponentName.get(key) || [];

        return buildComponentMemoryRecord({
          component,
          support,
          hopMemories,
        });
      }
    );

  const introducedComponentNames =
    components
      .filter((component) => component.alreadyExplained)
      .map((component) => component.componentName);

  const payload = {
    version: BUILDER_VERSION,
    source: "componentContinuityMemoryBuilder",
    purpose:
      "Track which architecture components have already been introduced so later teaching can avoid restarting component explanations.",

    rules: {
      traversalMutation: "forbidden",
      llmGeneratedMemory: "forbidden",
      componentIdentitySource:
        "component-understanding.normalizedName",
      memoryOnly: true,
    },

    introducedComponentNames,
    components,

    stats: {
      componentCount:
        components.length,

      introducedComponentCount:
        introducedComponentNames.length,

      availableComponentCount:
        components.length - introducedComponentNames.length,

      componentWithSupportingHopCount:
        components.filter(
          (component) =>
            component.supportingHopIds.length > 0
        ).length,

      componentWithTeachingSupportCount:
        components.filter(
          (component) =>
            component.supportedTeaching.length > 0
        ).length,

      traversalChanged:
        false,
    },
  };

  if (outputDir) {
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(
      path.join(
        outputDir,
        "component-continuity-memory.json"
      ),
      JSON.stringify(payload, null, 2),
      "utf8"
    );
  }

  return payload;
}

module.exports = {
  BUILDER_VERSION,
  buildComponentContinuityMemory,
};
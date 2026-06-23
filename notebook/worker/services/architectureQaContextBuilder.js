/**
 * architectureQaContextBuilder.js
 *
 * BUG-9B — Architecture QA Context Builder
 *
 * Owns:
 * - normalize existing cognition artifacts into one Q&A context
 * - expose journey/component/rail/hop lookup maps as plain objects
 *
 * Does NOT:
 * - classify questions
 * - answer questions
 * - call LLM
 * - mutate traversal
 */

const {
  buildArchitectureQaContract,
} = require("./architectureQaContract");

const BUILDER_VERSION = "architecture-qa-context-v1";

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

function indexBy(items = [], keyFn) {
  return asArray(items).reduce((acc, item) => {
    const key = keyFn(item);
    if (key) acc[key] = item;
    return acc;
  }, {});
}

function buildComponentIndex(componentUnderstanding = {}) {
  return indexBy(
    componentUnderstanding.components,
    (component) => normalizeKey(component.componentName)
  );
}

function buildJourneyIndex(journeyUnderstanding = {}) {
  return indexBy(
    journeyUnderstanding.journeys,
    (journey) => journey.journeyType
  );
}

function buildRailIndex(journeyUnderstanding = {}) {
  return indexBy(
    journeyUnderstanding.rails,
    (rail) => rail.railId || rail.flowLaneId
  );
}

function buildResponsibilityHopIndex(responsibilityUnderstanding = {}) {
  return indexBy(
    responsibilityUnderstanding.hops,
    (hop) => hop.hopId
  );
}

function buildSharedNodeIndex(sharedNodeUnderstanding = {}) {
  const out = {};

  for (const node of asArray(sharedNodeUnderstanding.nodes)) {
    if (node.nodeName) {
      out[normalizeKey(node.nodeName)] = node;
    }

    if (node.nodeId) {
      out[normalizeKey(node.nodeId)] = node;
    }
  }

  return out;
}

function buildEvidenceIndex(architectureEvidence = {}) {
  const out = {};

  for (const record of asArray(
    architectureEvidence.evidenceRecords
  )) {
    if (record.evidenceId) {
      out[record.evidenceId] = record;
    }
  }

  return out;
}

function buildHopContinuityIndex(hopContinuityMemory = {}) {
  return indexBy(
    hopContinuityMemory.hops,
    (hop) => hop.hopId
  );
}


function buildComponentContinuityIndex(componentContinuityMemory = {}) {
  return indexBy(
    componentContinuityMemory.components,
    (component) =>
      component.normalizedName ||
      normalizeKey(component.componentName)
  );
}

function buildArchitectureQaContext({
  journeyUnderstanding = {},
  componentUnderstanding = {},
  responsibilityUnderstanding = {},
  sharedNodeUnderstanding = {},
  multiRailUnderstanding = {},
  architectureEvidence = {},
  evidenceTeachingSupport = {},
  hopContinuityMemory = {},
  componentContinuityMemory = {},
} = {}) {
  const contract = buildArchitectureQaContract();

  const context = {
    version: BUILDER_VERSION,
    source: "architectureQaContextBuilder",

    purpose:
      "Provide deterministic lookup context for enterprise architecture Q&A.",

    contract,

    artifacts: {
        journeyUnderstanding,
        componentUnderstanding,
        responsibilityUnderstanding,
        sharedNodeUnderstanding,
        multiRailUnderstanding,
        architectureEvidence,
        evidenceTeachingSupport,
        hopContinuityMemory,
        componentContinuityMemory,
        },

    indexes: {
      journeysByType:
        buildJourneyIndex(journeyUnderstanding),

      railsById:
        buildRailIndex(journeyUnderstanding),

      componentsByName:
        buildComponentIndex(componentUnderstanding),

      responsibilityByHopId:
        buildResponsibilityHopIndex(
          responsibilityUnderstanding
        ),

      sharedNodesByName:
        buildSharedNodeIndex(sharedNodeUnderstanding),

      evidenceById:
        buildEvidenceIndex(architectureEvidence),

        hopContinuityByHopId:
        buildHopContinuityIndex(hopContinuityMemory),

        componentContinuityByName:
        buildComponentContinuityIndex(componentContinuityMemory),
    },

    stats: {
      journeyCount:
        asArray(journeyUnderstanding.journeys).length,

      railCount:
        asArray(journeyUnderstanding.rails).length,

      componentCount:
        asArray(componentUnderstanding.components).length,

      responsibilityHopCount:
        asArray(responsibilityUnderstanding.hops).length,

      sharedNodeCount:
        asArray(sharedNodeUnderstanding.nodes).length,

      evidenceRecordCount:
        asArray(architectureEvidence.evidenceRecords).length,

        evidenceTeachingComponentCount:
        asArray(evidenceTeachingSupport.components).length,

        evidenceTeachingHandoffCount:
        asArray(evidenceTeachingSupport.handoffs).length,

        hopContinuityCount:
        asArray(hopContinuityMemory.hops).length,

        explainedHopCount:
        asArray(hopContinuityMemory.explainedHopIds).length,

        componentContinuityCount:
        asArray(componentContinuityMemory.components).length,

        introducedComponentCount:
        asArray(componentContinuityMemory.introducedComponentNames).length,

        traversalChanged:
        false,
    },
  };

  return context;
}

module.exports = {
  BUILDER_VERSION,
  buildArchitectureQaContext,
};
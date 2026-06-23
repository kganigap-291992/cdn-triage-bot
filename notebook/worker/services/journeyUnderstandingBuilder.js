/**
 * journeyUnderstandingBuilder.js
 *
 * BUG-7A — Journey Discovery
 *
 * Owns:
 * - convert already-classified rails into architecture journeys
 * - group rails by journey type
 * - attach primary + secondary journey tags per rail
 * - preserve traversal without changing it
 *
 * Does NOT:
 * - choose traversal
 * - infer new hops
 * - create rails
 * - narrate
 * - call LLM
 * - validate narration
 */

const fs = require("fs");
const path = require("path");

const BUILDER_VERSION = "journey-understanding-v1";

const JOURNEY_TYPES = [
  "request_journey",
  "content_delivery_journey",
  "validation_journey",
  "control_journey",
  "state_journey",
  "observability_journey",
  "retrieval_journey",
  "configuration_journey",
  "replication_or_sync_journey",
  "unknown_journey",
];

const JOURNEY_ID_BY_TYPE = {
  request_journey: "journey_request",
  content_delivery_journey: "journey_content_delivery",
  validation_journey: "journey_validation",
  control_journey: "journey_control",
  state_journey: "journey_state",
  observability_journey: "journey_observability",
  retrieval_journey: "journey_retrieval",
  configuration_journey: "journey_configuration",
  replication_or_sync_journey: "journey_replication_or_sync",
  unknown_journey: "journey_unknown",
};

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function safeString(value) {
  return String(value || "").trim();
}

function unique(items = []) {
  return Array.from(
    new Set(asArray(items).filter(Boolean))
  );
}

function normalizeJourneyType(value = "") {
  const type = safeString(value);

  if (JOURNEY_TYPES.includes(type)) {
    return type;
  }

  if (
    [
      "supporting_journey",
      "background_journey",
      "unknown_supporting_journey",
      "unknown_supporting_flow",
      "supporting_flow",
      "background_flow",
    ].includes(type)
  ) {
    return "unknown_journey";
  }

  return "unknown_journey";
}

function journeyIdForType(journeyType = "") {
  const normalized = normalizeJourneyType(journeyType);
  return JOURNEY_ID_BY_TYPE[normalized] || "journey_unknown";
}

function teachingPurposeForJourney(journeyType = "") {
  switch (normalizeJourneyType(journeyType)) {
    case "request_journey":
      return "Represents the main request or service journey through the architecture.";

    case "content_delivery_journey":
      return "Represents content, payload, cache, or delivery movement through the architecture.";

    case "validation_journey":
      return "Represents validation, authorization, policy, or access-check context.";

    case "control_journey":
      return "Represents control-plane, routing, coordination, or configuration decision context.";

    case "state_journey":
      return "Represents persistence, state, read/write, storage, or synchronization context.";

    case "observability_journey":
      return "Represents telemetry, monitoring, health, metrics, logs, or observability context.";

    case "retrieval_journey":
      return "Represents lookup, read, fetch, or retrieval-oriented context.";

    case "configuration_journey":
      return "Represents configuration or policy distribution context.";

    case "replication_or_sync_journey":
      return "Represents replication, synchronization, or state-copy context.";

    case "unknown_journey":
    default:
      return "A supporting journey was detected, but deterministic evidence is not strong enough to classify its purpose.";
  }
}

function findDirectionRail(rail = {}, bidirectionalRailUnderstanding = {}) {
  const railId =
    rail.flowLaneId ||
    rail.railId ||
    rail.id ||
    null;

  if (!railId) return null;

  return asArray(bidirectionalRailUnderstanding.rails).find(
    (candidate) =>
      candidate.flowLaneId === railId ||
      candidate.railId === railId
  ) || null;
}

function buildSecondaryJourneyTypes(rail = {}) {
  const primaryJourneyType =
    normalizeJourneyType(rail.railCategory);

  const secondary = [];

  const relatedToRaw =
    safeString(rail.relatedTo);

  const railRelationship =
    safeString(rail.railRelationship);

  if (
    relatedToRaw === "canonical_primary" ||
    railRelationship === "parallel"
  ) {
    secondary.push("request_journey");
  }

  const relatedTo =
    normalizeJourneyType(relatedToRaw);

  if (
    relatedTo &&
    relatedTo !== "unknown_journey" &&
    relatedTo !== primaryJourneyType
  ) {
    secondary.push(relatedTo);
  }

  return unique(secondary);
}

function buildJourneyRailEntry({
  rail = {},
  bidirectionalRailUnderstanding = {},
} = {}) {
  const directionRail =
    findDirectionRail(rail, bidirectionalRailUnderstanding);

  const primaryJourneyType =
    normalizeJourneyType(rail.railCategory);

  const secondaryJourneyTypes =
    buildSecondaryJourneyTypes(rail);

  const hopIds = unique([
    ...asArray(rail.selectedHopIds),
    ...asArray(directionRail?.hopIds),
  ]);

  return {
    railId:
      rail.railId ||
      rail.flowLaneId ||
      rail.id ||
      null,

    flowLaneId:
      rail.flowLaneId || null,

    flowLaneType:
      rail.flowLaneType || null,

    primaryJourneyType,

    secondaryJourneyTypes,

    sourceRailCategory:
      rail.railCategory || null,

    railRelationship:
      rail.railRelationship || null,

    relatedTo:
      rail.relatedTo || null,

    relationshipToPrimary:
      rail.relationshipToPrimary || null,

    teachingPurpose:
      primaryJourneyType === "unknown_journey"
        ? teachingPurposeForJourney("unknown_journey")
        : rail.railPurpose || teachingPurposeForJourney(primaryJourneyType),

    classificationSource:
      "deterministic",

    classificationSignals: [
      rail.flowLaneType ? "flowLaneType" : null,
      rail.railCategory ? "railCategory" : null,
      rail.railRelationship ? "railRelationship" : null,
      directionRail ? "directionContext" : null,
    ].filter(Boolean),

    hopIds,

    hopCount:
      hopIds.length,

    directionContext:
      directionRail
        ? {
            bidirectional:
              directionRail.bidirectional === true,

            reverseCapable:
              directionRail.reverseCapable === true,

            reverseObserved:
              directionRail.reverseObserved === true,

            directionTypes:
              asArray(directionRail.directionTypes),

            teachingHint:
              directionRail.teachingHint || null,
          }
        : null,

    traversalChanged:
      false,

    safety: {
      traversalUnchanged: true,
      journeyClassificationOnly: true,
      noTraversalSelection: true,
      noHopCreation: true,
      noRailCreation: true,
      llmClassification: "forbidden",
      unknownJourneyTeaching:
        primaryJourneyType === "unknown_journey"
          ? "minimal_only"
          : "allowed_when_deterministic",
    },
  };
}

function ensureJourneyGroup(byType, journeyType) {
  const normalizedJourneyType =
    normalizeJourneyType(journeyType);

  if (!byType.has(normalizedJourneyType)) {
    byType.set(normalizedJourneyType, {
      journeyId:
        journeyIdForType(normalizedJourneyType),

      journeyType:
        normalizedJourneyType,

      sourceRailIds: [],
      secondarySourceRailIds: [],
      allRelatedRailIds: [],

      hopIds: [],
      secondaryHopIds: [],
      allRelatedHopIds: [],

      teachingPurpose:
        teachingPurposeForJourney(normalizedJourneyType),

      classificationSource:
        "deterministic",

      traversalChanged:
        false,
    });
  }

  return byType.get(normalizedJourneyType);
}

function buildJourneyGroups(rails = []) {
  const byType = new Map();

  for (const rail of asArray(rails)) {
    const primaryJourneyType =
      normalizeJourneyType(rail.primaryJourneyType);

    const primaryJourney =
      ensureJourneyGroup(byType, primaryJourneyType);

    primaryJourney.sourceRailIds.push(rail.railId);
    primaryJourney.allRelatedRailIds.push(rail.railId);

    primaryJourney.hopIds.push(...asArray(rail.hopIds));
    primaryJourney.allRelatedHopIds.push(...asArray(rail.hopIds));

    for (const secondaryJourneyType of asArray(
      rail.secondaryJourneyTypes
    )) {
      const secondaryJourney =
        ensureJourneyGroup(byType, secondaryJourneyType);

      secondaryJourney.secondarySourceRailIds.push(rail.railId);
      secondaryJourney.allRelatedRailIds.push(rail.railId);

      secondaryJourney.secondaryHopIds.push(...asArray(rail.hopIds));
      secondaryJourney.allRelatedHopIds.push(...asArray(rail.hopIds));
    }
  }

  return Array.from(byType.values()).map((journey) => {
    const sourceRailIds =
      unique(journey.sourceRailIds);

    const secondarySourceRailIds =
      unique(journey.secondarySourceRailIds);

    const allRelatedRailIds =
      unique([
        ...sourceRailIds,
        ...secondarySourceRailIds,
        ...journey.allRelatedRailIds,
      ]);

    const hopIds =
      unique(journey.hopIds);

    const secondaryHopIds =
      unique(journey.secondaryHopIds);

    const allRelatedHopIds =
      unique([
        ...hopIds,
        ...secondaryHopIds,
        ...journey.allRelatedHopIds,
      ]);

    return {
      ...journey,

      sourceRailIds,
      secondarySourceRailIds,
      allRelatedRailIds,

      hopIds,
      secondaryHopIds,
      allRelatedHopIds,

      railCount:
        sourceRailIds.length,

      secondaryRailCount:
        secondarySourceRailIds.length,

      allRelatedRailCount:
        allRelatedRailIds.length,

      hopCount:
        hopIds.length,

      secondaryHopCount:
        secondaryHopIds.length,

      allRelatedHopCount:
        allRelatedHopIds.length,
    };
  });
}

function buildJourneyUnderstanding({
  multiRailUnderstanding = {},
  bidirectionalRailUnderstanding = {},
  outputDir = null,
} = {}) {
  const rails = asArray(multiRailUnderstanding.rails).map((rail) =>
    buildJourneyRailEntry({
      rail,
      bidirectionalRailUnderstanding,
    })
  );

  const journeys =
    buildJourneyGroups(rails);

  const journeyTypeBreakdown =
    journeys.reduce((acc, journey) => {
      acc[journey.journeyType] =
        (acc[journey.journeyType] || 0) + 1;
      return acc;
    }, {});

  const railJourneyBreakdown =
    rails.reduce((acc, rail) => {
      acc[rail.primaryJourneyType] =
        (acc[rail.primaryJourneyType] || 0) + 1;
      return acc;
    }, {});

  const payload = {
    version: BUILDER_VERSION,
    source: "journeyUnderstandingBuilder",

    purpose:
      "Group deterministic rail understanding into teachable architecture journeys without changing traversal.",

    rules: {
      traversalMutation: "forbidden",
      railMutation: "forbidden",
      hopCreation: "forbidden",
      journeyObjectRule: "one_journey_object_per_journey_type",
      primaryJourneyRule: "one_primary_journey_per_rail",
      secondaryJourneyRule: "zero_or_more_secondary_tags",
      classificationSource: "deterministic_only",
      unknownJourneyTeaching: "minimal_only",
    },

    journeyTypeEnum:
      JOURNEY_TYPES,

    journeyCount:
      journeys.length,

    railCount:
      rails.length,

    journeys,

    rails,

    stats: {
      journeyCount:
        journeys.length,

      railCount:
        rails.length,

      knownJourneyRailCount:
        rails.filter(
          (rail) => rail.primaryJourneyType !== "unknown_journey"
        ).length,

      unknownJourneyRailCount:
        rails.filter(
          (rail) => rail.primaryJourneyType === "unknown_journey"
        ).length,

      secondaryJourneyTaggedRailCount:
        rails.filter(
          (rail) => rail.secondaryJourneyTypes.length > 0
        ).length,

      journeyTypeBreakdown,
      railJourneyBreakdown,

      traversalChanged:
        false,
    },
  };

  if (outputDir) {
    fs.mkdirSync(outputDir, { recursive: true });

    fs.writeFileSync(
      path.join(outputDir, "journey-understanding.json"),
      JSON.stringify(payload, null, 2),
      "utf8"
    );
  }

  return payload;
}

module.exports = {
  BUILDER_VERSION,
  JOURNEY_TYPES,
  normalizeJourneyType,
  buildJourneyRailEntry,
  buildJourneyGroups,
  buildJourneyUnderstanding,
};
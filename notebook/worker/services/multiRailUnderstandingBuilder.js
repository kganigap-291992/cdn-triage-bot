/**
 * multiRailUnderstandingBuilder.js
 *
 * BUG-5B — Multi-Rail Understanding
 *
 * Owns:
 * - classify discovered traversal rails into teachable rail journeys
 * - preserve canonical traversal without changing it
 * - emit rail-level purpose, role, and safety metadata
 *
 * Does NOT:
 * - choose traversal
 * - infer new hops
 * - mutate selectedWalkthrough / selectedWalkthroughs
 * - narrate
 * - call LLM
 */

const fs = require("fs");
const path = require("path");

const BUILDER_VERSION = "multi-rail-understanding-v1";

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function safeString(value) {
  return String(value || "").trim();
}

function classifyRail(flowLaneType = "") {
  const lane = safeString(flowLaneType);

  const map = {
    primary_request_flow: {
      railCategory: "request_journey",
      railPurpose:
        "Represents the main documented request or service journey through the architecture.",
      teachingPriority: 100,
    },

    cache_or_payload_delivery_flow: {
      railCategory: "content_delivery_journey",
      railPurpose:
        "Represents content, payload, cache, or delivery movement through the architecture.",
      teachingPriority: 90,
    },

    auth_validation_flow: {
      railCategory: "validation_journey",
      railPurpose:
        "Represents validation, authorization, policy, or access-check related flow.",
      teachingPriority: 70,
    },

    bidirectional_sync_flow: {
      railCategory: "state_journey",
      railPurpose:
        "Represents state, persistence, synchronization, read/write, or storage-related flow.",
      teachingPriority: 65,
    },

    config_control_flow: {
      railCategory: "control_journey",
      railPurpose:
        "Represents configuration, control-plane, policy, or coordination flow.",
      teachingPriority: 50,
    },

    observability_flow: {
      railCategory: "observability_journey",
      railPurpose:
        "Represents telemetry, monitoring, health, metrics, or observability flow.",
      teachingPriority: 35,
    },

    supporting_flow: {
      railCategory: "supporting_journey",
      railPurpose:
        "Represents a supporting documented flow that should be taught as context, not as the primary journey.",
      teachingPriority: 30,
    },

    background_flow: {
      railCategory: "background_journey",
      railPurpose:
        "Represents background architecture context that should be used cautiously during teaching.",
      teachingPriority: 20,
    },

    unknown_supporting_flow: {
      railCategory: "unknown_supporting_journey",
      railPurpose:
        "Represents a discovered supporting flow whose teaching meaning is not yet clear from deterministic evidence.",
      teachingPriority: 10,
    },
  };

  return (
    map[lane] || {
      railCategory: "unknown_journey",
      railPurpose:
        "Represents a discovered rail without enough deterministic context to classify confidently.",
      teachingPriority: 5,
    }
  );
}

function classifyRelationshipToPrimary(rail = {}) {
  if (rail.primaryRailType === "canonical_primary") {
    return "is_canonical_primary_journey";
  }

  if (rail.primaryRailType === "parallel_primary") {
    return "parallel_primary_journey";
  }

  if (rail.selectedForPrimaryWalkthrough === true) {
    return "selected_primary_lane";
  }

  return "supporting_context_journey";
}

function buildRailUnderstandingEntry(rail = {}, index = 0) {
  const flowLaneType =
    rail.flowLaneType ||
    asArray(rail.laneTypes)[0] ||
    "unknown_supporting_flow";

  const classification = classifyRail(flowLaneType);

  const relationship =
    inferRailRelationship({
        ...rail,
        railCategory: classification.railCategory,
    });

  return {
    railId:
      rail.flowLaneId ||
      rail.id ||
      `rail_${index + 1}`,

    railIndex: index,

    flowLaneId:
      rail.flowLaneId || null,

    flowLaneType,

    railCategory:
      classification.railCategory,

    railPurpose:
      classification.railPurpose,

    relationshipToPrimary:
    classifyRelationshipToPrimary(rail),

    railRelationship:
    relationship.relationshipType,

    relatedTo:
    relationship.relatedTo,

    railRelationshipTeachingHint:
    relationship.teachingHint,

    primaryRailType:
    rail.primaryRailType || null,

    promotionReason:
      rail.promotionReason || null,

    selectedForPrimaryWalkthrough:
      rail.selectedForPrimaryWalkthrough === true,

    railScore:
      rail.railScore ?? null,

    confidence:
      rail.confidence || "unknown",

    hopCount:
      Number(rail.hopCount || asArray(rail.selectedHopIds).length || 0),

    selectedHopIds:
      asArray(rail.selectedHopIds),

    pathText:
      rail.pathText || "",

    firstHopId:
      rail.firstHopId || null,

    lastHopId:
      rail.lastHopId || null,

    teaching: {
      teachingPriority:
        classification.teachingPriority,

      teachAsPrimary:
        rail.primaryRailType === "canonical_primary" ||
        rail.selectedForPrimaryWalkthrough === true,

      teachAsParallelPrimary:
        rail.primaryRailType === "parallel_primary",

      teachAsSupportingContext:
        ![
          "canonical_primary",
          "parallel_primary",
        ].includes(rail.primaryRailType),

      safeTeachingFrame:
        classification.railPurpose,
    },

    safety: {
      traversalUnchanged: true,
      roleMutation: "forbidden",
      railClassificationOnly: true,
      doNotInventRailRelationships: true,
      hopIdsAreSourceOfTruth: true,
    },
  };
}

function buildPrimaryRailMetadataIndex(selectedPrimaryWalkthroughs = []) {
  const byRailId = new Map();

  for (const rail of asArray(selectedPrimaryWalkthroughs)) {
    const key =
      rail.flowLaneId ||
      rail.id ||
      asArray(rail.selectedHopIds).join("|");

    if (!key) continue;

    byRailId.set(key, {
      primaryRailType:
        rail.primaryRailType || null,

      promotionReason:
        rail.promotionReason || null,
    });
  }

  return byRailId;
}

function mergePrimaryRailMetadata(rail = {}, primaryIndex = new Map()) {
  const key =
    rail.flowLaneId ||
    rail.id ||
    asArray(rail.selectedHopIds).join("|");

  const primaryMetadata =
    primaryIndex.get(key) || {};

  return {
    ...rail,

    primaryRailType:
      rail.primaryRailType ||
      primaryMetadata.primaryRailType ||
      "supporting",

    promotionReason:
      rail.promotionReason ||
      primaryMetadata.promotionReason ||
      "not_promoted_to_primary",
  };
}

function inferRailRelationship(rail = {}) {
  if (rail.primaryRailType === "canonical_primary") {
    return {
      relationshipType: "primary",
      relatedTo: null,
      teachingHint:
        "This rail is the canonical journey used as the main walkthrough.",
    };
  }

  if (rail.primaryRailType === "parallel_primary") {
    return {
      relationshipType: "parallel",
      relatedTo: "canonical_primary",
      teachingHint:
        "This rail is evidence-backed enough to teach alongside the canonical journey.",
    };
  }

  if (rail.railCategory === "validation_journey") {
    return {
      relationshipType: "supports",
      relatedTo: "request_journey",
      teachingHint:
        "This rail supports the main journey by representing validation or policy context.",
    };
  }

  if (rail.railCategory === "state_journey") {
    return {
      relationshipType: "supports",
      relatedTo: "request_journey",
      teachingHint:
        "This rail supports the main journey by representing state or persistence context.",
    };
  }

  if (rail.railCategory === "control_journey") {
    return {
      relationshipType: "supports",
      relatedTo: "request_journey",
      teachingHint:
        "This rail supports the main journey by representing control or configuration context.",
    };
  }

  return {
    relationshipType: "context",
    relatedTo: "request_journey",
    teachingHint:
      "This rail provides supporting context for the architecture journey.",
  };
}

function buildMultiRailUnderstanding({
  canonicalTraversalRail = {},
  outputDir = null,
} = {}) {
  const selectedWalkthroughs =
    asArray(canonicalTraversalRail.selectedWalkthroughs);

  const selectedPrimaryWalkthroughs =
    asArray(canonicalTraversalRail.selectedPrimaryWalkthroughs);

  const primaryRailMetadataIndex =
    buildPrimaryRailMetadataIndex(
        selectedPrimaryWalkthroughs
    );

    const sourceRails = selectedWalkthroughs.length
    ? selectedWalkthroughs
    : selectedPrimaryWalkthroughs;

    const rails = sourceRails.map((rail, index) =>
    buildRailUnderstandingEntry(
        mergePrimaryRailMetadata(
        rail,
        primaryRailMetadataIndex
        ),
        index
    )
    );

  const railCategoryBreakdown = rails.reduce((acc, rail) => {
    acc[rail.railCategory] =
      (acc[rail.railCategory] || 0) + 1;
    return acc;
  }, {});

  const relationshipBreakdown = rails.reduce((acc, rail) => {
    acc[rail.relationshipToPrimary] =
        (acc[rail.relationshipToPrimary] || 0) + 1;
    return acc;
    }, {});

    const railRelationshipBreakdown = rails.reduce((acc, rail) => {
    acc[rail.railRelationship] =
        (acc[rail.railRelationship] || 0) + 1;
    return acc;
    }, {});

  const payload = {
    version: BUILDER_VERSION,
    source: "multiRailUnderstandingBuilder",
    purpose:
      "Classify discovered traversal rails into teachable architecture journeys without changing traversal.",

    rules: {
      traversalMutation: "forbidden",
      roleMutation: "forbidden",
      railClassificationOnly: true,
      selectedWalkthroughsAreSourceOfTruth: true,
      selectedWalkthroughRemainsCanonicalPath: true,
    },

    railCount: rails.length,
    primaryRailCount:
      rails.filter((rail) =>
        ["is_canonical_primary_journey", "parallel_primary_journey"]
          .includes(rail.relationshipToPrimary)
      ).length,

    supportingRailCount:
      rails.filter(
        (rail) =>
          rail.relationshipToPrimary ===
          "supporting_context_journey"
      ).length,

    rails,

    canonicalJourney: canonicalTraversalRail.selectedWalkthrough || null,

    stats: {
      railCount: rails.length,

      selectedWalkthroughRailCount:
        selectedWalkthroughs.length,

      selectedPrimaryWalkthroughCount:
        selectedPrimaryWalkthroughs.length,

      canonicalPrimaryRailCount:
        rails.filter(
          (rail) =>
            rail.relationshipToPrimary ===
            "is_canonical_primary_journey"
        ).length,

      parallelPrimaryRailCount:
        rails.filter(
          (rail) =>
            rail.relationshipToPrimary ===
            "parallel_primary_journey"
        ).length,

      supportingRailCount:
        rails.filter(
          (rail) =>
            rail.relationshipToPrimary ===
            "supporting_context_journey"
        ).length,

      railCategoryBreakdown,
      relationshipBreakdown,
      railRelationshipBreakdown,
      traversalChanged: false,
    },
  };

  if (outputDir) {
    fs.mkdirSync(outputDir, { recursive: true });

    fs.writeFileSync(
      path.join(outputDir, "multi-rail-understanding.json"),
      JSON.stringify(payload, null, 2),
      "utf8"
    );
  }

  return payload;
}

module.exports = {
  BUILDER_VERSION,
  classifyRail,
  classifyRelationshipToPrimary,
  buildRailUnderstandingEntry,
  buildMultiRailUnderstanding,
};
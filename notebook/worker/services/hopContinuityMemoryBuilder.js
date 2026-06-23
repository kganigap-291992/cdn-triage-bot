/**
 * hopContinuityMemoryBuilder.js
 *
 * BUG-10A — Hop Continuity Memory
 *
 * Owns:
 * - deterministic memory of which hops have already been introduced
 * - per-hop revisit guidance
 *
 * Does NOT:
 * - change traversal
 * - reorder hops
 * - call LLM
 * - narrate
 */

const fs = require("fs");
const path = require("path");

const BUILDER_VERSION = "hop-continuity-memory-v1";

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function safeString(value) {
  return String(value || "").trim();
}

function uniq(values = []) {
  return Array.from(
    new Set(asArray(values).map(safeString).filter(Boolean))
  );
}

function buildJourneyHopLookup(journeyUnderstanding = {}) {
  const lookup = new Map();

  for (const journey of asArray(journeyUnderstanding.journeys)) {
    for (const hopId of asArray(journey.hopIds)) {
      const current = lookup.get(hopId) || [];
      lookup.set(hopId, uniq([...current, journey.journeyType]));
    }

    for (const hopId of asArray(journey.secondaryHopIds)) {
      const current = lookup.get(hopId) || [];
      lookup.set(hopId, uniq([...current, journey.journeyType]));
    }
  }

  return lookup;
}

function buildNarratedHopLookup(architectureRailNarration = {}) {
  const lookup = new Map();

  for (const rail of asArray(architectureRailNarration.rails)) {
    for (const hopId of asArray(rail.hopIds)) {
      if (!lookup.has(hopId)) {
        lookup.set(hopId, {
          firstExplainedInRailId:
            rail.railId || rail.flowLaneId || null,
          firstExplainedInRailTitle:
            rail.title || null,
          firstExplainedInJourneyType:
            rail.journeyContext?.primaryJourneyType || null,
        });
      }
    }
  }

  return lookup;
}

function buildResponsibilityLookup(responsibilityUnderstanding = {}) {
  const lookup = new Map();

  for (const hop of asArray(responsibilityUnderstanding.hops)) {
    lookup.set(hop.hopId, hop);
  }

  return lookup;
}

function buildHopContinuityMemory({
  canonicalTraversalRail = {},
  journeyUnderstanding = {},
  architectureRailNarration = {},
  responsibilityUnderstanding = {},
  outputDir = null,
} = {}) {
  const journeyHopLookup =
    buildJourneyHopLookup(journeyUnderstanding);

  const narratedHopLookup =
    buildNarratedHopLookup(architectureRailNarration);

  const responsibilityLookup =
    buildResponsibilityLookup(responsibilityUnderstanding);

  const hops = asArray(canonicalTraversalRail.hops).map((hop, index) => {
    const hopId = hop.hopId || `hop_${index + 1}`;
    const narrated = narratedHopLookup.get(hopId) || null;
    const responsibility = responsibilityLookup.get(hopId) || null;

    const fromName =
      hop.from?.name ||
      responsibility?.from?.name ||
      null;

    const toName =
      hop.to?.name ||
      responsibility?.to?.name ||
      null;

    const fromRole =
      responsibility?.from?.responsibility?.role ||
      null;

    const toRole =
      responsibility?.to?.responsibility?.role ||
      null;

    const roleTransitionText =
      fromRole && toRole
        ? `${fromRole} → ${toRole}`
        : null;

    const introduced = Boolean(narrated);

    return {
      hopId,
      canonicalOrder:
        hop.canonicalOrder ?? index + 1,

      flowLaneId:
        hop.flowLaneId || null,

      flowLaneType:
        hop.flowLaneType || null,

      from:
        fromName,

      to:
        toName,

      label:
        fromName && toName
          ? `${fromName} → ${toName}`
          : null,

      status:
        introduced ? "introduced" : "available",

      alreadyExplained:
        introduced,

      firstExplainedInRailId:
        narrated?.firstExplainedInRailId || null,

      firstExplainedInRailTitle:
        narrated?.firstExplainedInRailTitle || null,

      firstExplainedInJourneyType:
        narrated?.firstExplainedInJourneyType || null,

      journeyTypes:
        journeyHopLookup.get(hopId) || [],

      roleTransitionText,

      handoffType:
        responsibility?.handoffResponsibility?.handoffType || null,

      revisitGuidance:
        introduced
          ? "Do not reintroduce this hop from scratch. Refer back to it briefly and teach only the new journey, role, or context."
          : "This hop has not been introduced yet. It can be taught as new.",

      safety: {
        traversalChanged: false,
        memoryOnly: true,
        deterministic: true,
      },
    };
  });

  const explainedHopIds =
    hops
      .filter((hop) => hop.alreadyExplained)
      .map((hop) => hop.hopId);

  const payload = {
    version: BUILDER_VERSION,
    source: "hopContinuityMemoryBuilder",
    purpose:
      "Track which canonical traversal hops have already been introduced so later teaching can avoid restarting explanations.",

    rules: {
      traversalMutation: "forbidden",
      llmGeneratedMemory: "forbidden",
      canonicalHopIdRequired: true,
      memoryOnly: true,
    },

    explainedHopIds,
    hops,

    stats: {
      hopCount: hops.length,
      introducedHopCount: explainedHopIds.length,
      availableHopCount:
        hops.length - explainedHopIds.length,
      journeyLinkedHopCount:
        hops.filter((hop) => hop.journeyTypes.length > 0).length,
      responsibilityLinkedHopCount:
        hops.filter((hop) => hop.roleTransitionText).length,
      traversalChanged: false,
    },
  };

  if (outputDir) {
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(
      path.join(outputDir, "hop-continuity-memory.json"),
      JSON.stringify(payload, null, 2),
      "utf8"
    );
  }

  return payload;
}

module.exports = {
  BUILDER_VERSION,
  buildHopContinuityMemory,
};
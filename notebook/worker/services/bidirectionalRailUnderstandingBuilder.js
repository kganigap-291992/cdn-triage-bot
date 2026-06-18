/**
 * bidirectionalRailUnderstandingBuilder.js
 *
 * BUG-6A — Bidirectional Rail Discovery
 *
 * Owns:
 * - detect rails / hops that may be bidirectional
 * - classify direction risk from canonical traversal metadata
 * - preserve traversal without changing it
 *
 * Borrows ideas from:
 * - OpenTelemetry span direction: keep observed direction separate from possible reverse direction
 * - BPMN message flow: do not assume reverse flow unless the diagram/evidence supports it
 * - NetworkX edge metadata: annotate edges/rails without mutating traversal
 *
 * Does NOT:
 * - choose traversal
 * - infer new hops
 * - reverse edges
 * - narrate
 * - call LLM
 */

const fs = require("fs");
const path = require("path");

const BUILDER_VERSION =
  "bidirectional-rail-understanding-v1";

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

function uniqueBy(items = [], keyFn) {
  const seen = new Set();
  const out = [];

  for (const item of items) {
    const key = keyFn(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }

  return out;
}

function isBidirectionalLaneType(flowLaneType = "") {
  return [
    "bidirectional_sync_flow",
    "state_sync_flow",
    "read_write_flow",
    "replication_flow",
    "sync_flow",
  ].includes(safeString(flowLaneType));
}

function isBidirectionalInteractionMode(interactionMode = "") {
  return [
    "bidirectional_sync",
    "read_write",
    "state_sync",
    "replication",
    "sync",
  ].includes(safeString(interactionMode));
}

function hasBidirectionalEvidence(hop = {}) {
  const evidenceText = [
    hop.relationshipType,
    hop.interactionMode,
    hop.flowLaneType,
    hop.directionality,
    ...asArray(hop.evidenceTypes),
  ]
    .map(safeString)
    .join(" ")
    .toLowerCase();

  return /\b(bidirectional|bi-directional|two[-\s]?way|read[-\s]?write|read\s+and\s+write|sync|synchroni[sz]e|replication|replicate)\b/.test(
    evidenceText
  );
}


function buildForwardTeachingFrame({
  flowLaneType = "",
  interactionMode = "",
  directionType = "",
} = {}) {
  if (
    directionType ===
    "sync_or_state_bidirectional_direction"
  ) {
    return "observed_state_sync_direction";
  }

  if (
    flowLaneType === "primary_request_flow" ||
    interactionMode === "request_response"
  ) {
    return "observed_request_direction";
  }

  return "observed_forward_direction";
}

function buildReverseTeachingFrame({
  bidirectional = false,
  reverseObserved = false,
  directionType = "",
} = {}) {
  if (!bidirectional) {
    return "reverse_not_supported";
  }

  if (reverseObserved) {
    return "reverse_direction_observed";
  }

  if (
    directionType ===
    "sync_or_state_bidirectional_direction"
  ) {
    return "reverse_direction_possible_not_observed";
  }

  return "reverse_direction_unknown";
}

function buildDirectionTeachingContext({
  observedDirection = "",
  forwardTeachingFrame = "",
  reverseTeachingFrame = "",
  bidirectional = false,
} = {}) {
  if (!bidirectional) {
    return {
      forwardTeachingSentence:
        `Observed direction: ${observedDirection}. Teach this as the documented handoff direction.`,

      reverseTeachingSentence:
        "No reverse direction should be taught unless stronger evidence appears.",

      teachingBoundary:
        "observed_direction_only",
    };
  }

  if (
    forwardTeachingFrame ===
      "observed_state_sync_direction" &&
    reverseTeachingFrame ===
      "reverse_direction_possible_not_observed"
  ) {
    return {
      forwardTeachingSentence:
        `Observed direction: ${observedDirection}. Teach this as the documented state or sync-side direction.`,

      reverseTeachingSentence:
        "Reverse direction may be possible for this rail type, but it is not directly observed in the traversal. Mention it only as cautious context.",

      teachingBoundary:
        "observed_forward_reverse_possible",
    };
  }

  return {
    forwardTeachingSentence:
      `Observed direction: ${observedDirection}. Teach this direction first.`,

    reverseTeachingSentence:
      bidirectional
        ? "Reverse direction may exist, but should not be expanded into a new hop without evidence."
        : "Reverse direction is not supported by this artifact.",

    teachingBoundary:
      bidirectional
        ? "observed_forward_reverse_cautious"
        : "observed_direction_only",
  };
}
function classifyHopDirection(hop = {}) {
  const flowLaneType = safeString(hop.flowLaneType);
  const interactionMode = safeString(hop.interactionMode);
  const directionality = safeString(hop.directionality);

  const bidirectionalByLane =
    isBidirectionalLaneType(flowLaneType);

  const bidirectionalByMode =
    isBidirectionalInteractionMode(interactionMode);

  const bidirectionalByDirectionality =
    ["bidirectional", "two_way", "undirected"].includes(
      directionality
    );

  const evidenceBacked =
    hasBidirectionalEvidence(hop);

  const bidirectional =
    bidirectionalByLane ||
    bidirectionalByMode ||
    bidirectionalByDirectionality ||
    evidenceBacked;

  const reverseObserved =
    directionality === "bidirectional" ||
    directionality === "two_way" ||
    directionality === "undirected";

  const observedDirection =
    `${hop.from?.name || hop.from?.id || "unknown"} → ${
      hop.to?.name || hop.to?.id || "unknown"
    }`;

  let directionType = "forward_observed_direction";

  if (bidirectional) {
    directionType = "bidirectional_possible_direction";
  }

  if (
    flowLaneType === "bidirectional_sync_flow" ||
    interactionMode === "bidirectional_sync"
  ) {
    directionType = "sync_or_state_bidirectional_direction";
  }

  const forwardTeachingFrame =
    buildForwardTeachingFrame({
      flowLaneType,
      interactionMode,
      directionType,
    });

  const reverseTeachingFrame =
    buildReverseTeachingFrame({
      bidirectional,
      reverseObserved,
      directionType,
    });

  const directionTeachingContext =
    buildDirectionTeachingContext({
      observedDirection,
      forwardTeachingFrame,
      reverseTeachingFrame,
      bidirectional,
    });

  return {
    hopId: hop.hopId || null,

    from:
      hop.from?.name || hop.from?.id || null,

    to:
      hop.to?.name || hop.to?.id || null,

    flowLaneId:
      hop.flowLaneId || null,

    flowLaneType,
    interactionMode,
    directionality:
      directionality || "directed",

    directionType,
    observedDirection,
    forwardTeachingFrame,
    reverseTeachingFrame,
    directionTeachingContext,

    bidirectional,
    reverseCapable:
      bidirectional === true,

    reverseObserved,

    evidence: {
      bidirectionalByLane,
      bidirectionalByMode,
      bidirectionalByDirectionality,
      evidenceBacked,
      evidenceTypes:
        asArray(hop.evidenceTypes),
      evidenceIds:
        asArray(hop.evidenceIds),
    },

    teachingHint:
      bidirectional
        ? "This hop may represent a read/write, sync, or two-way style interaction. Teach the observed direction first and only mention reverse direction cautiously."
        : "This hop is treated as an observed forward handoff unless stronger reverse evidence appears.",

    safety: {
      traversalUnchanged: true,
      noReverseHopCreated: true,
      observedDirectionRemainsSourceOfTruth: true,
      reverseDirectionRequiresEvidence: true,
    },
  };
}

function buildRailDirectionSummary({
  flowLaneId,
  flowLaneType,
  hops = [],
} = {}) {
  const hopDirections =
    asArray(hops).map(classifyHopDirection);

  const bidirectionalHopCount =
    hopDirections.filter((hop) => hop.bidirectional).length;

  const reverseObservedHopCount =
    hopDirections.filter((hop) => hop.reverseObserved).length;

  const bidirectional =
    isBidirectionalLaneType(flowLaneType) ||
    bidirectionalHopCount > 0;

  const reverseCapable =
    bidirectional === true;

  const directionTypes = uniqueBy(
    hopDirections
      .map((hop) => hop.directionType)
      .filter(Boolean),
    (item) => item
  );

  return {
    flowLaneId,
    flowLaneType,

    bidirectional,
    reverseCapable,
    reverseObserved:
      reverseObservedHopCount > 0,

    hopCount:
      hopDirections.length,

    bidirectionalHopCount,
    reverseObservedHopCount,

    directionTypes,

    hopIds:
      hopDirections.map((hop) => hop.hopId).filter(Boolean),

    hops:
      hopDirections,

    teachingHint:
      bidirectional
        ? "This rail may be read as a bidirectional or sync-style rail. Narration should teach the observed path first, then explain reverse capability only as cautious context."
        : "This rail should be taught as an observed one-way traversal unless stronger reverse evidence appears.",

    safety: {
      traversalUnchanged: true,
      noReverseRailCreated: true,
      noReverseHopCreated: true,
      observedDirectionRemainsSourceOfTruth: true,
      reverseDirectionRequiresEvidence: true,
    },
  };
}

function groupHopsByRail(hops = []) {
  const byRail = new Map();

  for (const hop of asArray(hops)) {
    const flowLaneId =
      hop.flowLaneId ||
      `lane_${normalizeKey(hop.flowLaneType || "unknown")}`;

    if (!byRail.has(flowLaneId)) {
      byRail.set(flowLaneId, {
        flowLaneId,
        flowLaneType:
          hop.flowLaneType || "unknown_supporting_flow",
        hops: [],
      });
    }

    byRail.get(flowLaneId).hops.push(hop);
  }

  return Array.from(byRail.values());
}

function buildBidirectionalRailUnderstanding({
  canonicalTraversalRail = {},
  outputDir = null,
} = {}) {
  const hops =
    asArray(canonicalTraversalRail.hops);

  const railGroups =
    groupHopsByRail(hops);

  const rails =
    railGroups.map((group) =>
      buildRailDirectionSummary(group)
    );

  const bidirectionalRails =
    rails.filter((rail) => rail.bidirectional);

  const hopDirections =
    rails.flatMap((rail) => rail.hops);

  const directionTypeBreakdown =
    hopDirections.reduce((acc, hop) => {
      acc[hop.directionType] =
        (acc[hop.directionType] || 0) + 1;
      return acc;
    }, {});

  const payload = {
    version: BUILDER_VERSION,
    source:
      "bidirectionalRailUnderstandingBuilder",

    purpose:
      "Detect bidirectional or reverse-capable architecture rails without changing canonical traversal.",

    rules: {
      traversalMutation: "forbidden",
      reverseHopCreation: "forbidden",
      observedDirectionFirst: true,
      reverseDirectionRequiresEvidence: true,
      narrationOnlyAfterDeterministicContext: true,
    },

    railCount:
      rails.length,

    bidirectionalRailCount:
      bidirectionalRails.length,

    rails,

    bidirectionalRails,

    hopDirections,

    stats: {
      railCount:
        rails.length,

      bidirectionalRailCount:
        bidirectionalRails.length,

      reverseCapableRailCount:
        rails.filter((rail) => rail.reverseCapable).length,

      reverseObservedRailCount:
        rails.filter((rail) => rail.reverseObserved).length,

      hopCount:
        hopDirections.length,

      bidirectionalHopCount:
        hopDirections.filter((hop) => hop.bidirectional).length,

      reverseObservedHopCount:
        hopDirections.filter((hop) => hop.reverseObserved).length,

      directionTypeBreakdown,

      traversalChanged:
        false,
    },
  };

  if (outputDir) {
    fs.mkdirSync(outputDir, { recursive: true });

    fs.writeFileSync(
      path.join(
        outputDir,
        "bidirectional-rail-understanding.json"
      ),
      JSON.stringify(payload, null, 2),
      "utf8"
    );
  }

  return payload;
}

module.exports = {
  BUILDER_VERSION,
  classifyHopDirection,
  buildRailDirectionSummary,
  buildBidirectionalRailUnderstanding,
};
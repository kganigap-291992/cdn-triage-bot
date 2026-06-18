/**
 * sharedNodeUnderstandingBuilder.js
 *
 * BUG-3 — Shared Node Hardening
 *
 * Owns:
 * - detect components reused across hops / rails / lanes
 * - classify shared-node risk
 * - preserve traversal without changing it
 *
 * Does NOT:
 * - choose traversal
 * - infer new edges
 * - change responsibility roles
 * - narrate
 * - call LLM
 */

const fs = require("fs");
const path = require("path");

const BUILDER_VERSION = "shared-node-understanding-v1";

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

function buildResponsibilityIndex(responsibilityUnderstanding = {}) {
  const byHop = new Map();

  for (const hop of asArray(responsibilityUnderstanding.hops)) {
    byHop.set(hop.hopId, hop);
  }

  return byHop;
}

function classifySharedNode({
  membershipCount = 0,
  laneTypes = [],
  rolePairs = [],
  perHopRoles = [],
} = {}) {
  const uniqueLaneCount = laneTypes.length;
  const uniqueRoleCount = perHopRoles.length;
  const uniqueRolePairCount = rolePairs.length;

  if (membershipCount <= 1) {
    return "not_shared";
  }

  if (uniqueLaneCount > 1 && uniqueRoleCount > 1) {
    return "multi_rail_multi_role_shared";
  }

  if (uniqueLaneCount > 1) {
    return "multi_rail_shared";
  }

  if (uniqueRoleCount > 1) {
    return "multi_role_shared";
  }

  return "single_role_shared";
}

function buildRailRoleProfiles(enrichedMemberships = []) {
  const byLane = new Map();

  for (const membership of asArray(enrichedMemberships)) {
    const flowLaneType =
      membership.flowLaneType || "unknown_lane";

    if (!byLane.has(flowLaneType)) {
      byLane.set(flowLaneType, {
        flowLaneType,
        flowLaneIds: [],
        roles: [],
        hopIds: [],
        endpoints: [],
        handoffTypes: [],
      });
    }

    const profile = byLane.get(flowLaneType);

    profile.flowLaneIds.push(membership.flowLaneId);
    profile.roles.push(membership.perHopRole);
    profile.hopIds.push(membership.hopId);
    profile.endpoints.push(membership.endpoint);
    profile.handoffTypes.push(membership.handoffType);
  }

  return Array.from(byLane.values()).map((profile) => ({
    flowLaneType: profile.flowLaneType,

    flowLaneIds: uniqueBy(
      profile.flowLaneIds.filter(Boolean),
      (item) => item
    ),

    roles: uniqueBy(
      profile.roles.filter((role) => role && role !== "unknown"),
      (item) => item
    ),

    unknownRoleCount:
      profile.roles.filter((role) => role === "unknown").length,

    hopIds: uniqueBy(
      profile.hopIds.filter(Boolean),
      (item) => item
    ),

    endpoints: uniqueBy(
      profile.endpoints.filter(Boolean),
      (item) => item
    ),

    handoffTypes: uniqueBy(
      profile.handoffTypes.filter(Boolean),
      (item) => item
    ),
  }));
}


function hasRailSpecificRoleDifference(railRoleProfiles = []) {
  const roleSignatures = uniqueBy(
    asArray(railRoleProfiles)
      .map((profile) =>
        profile.roles.length
          ? profile.roles.join("|")
          : "unknown"
      ),
    (item) => item
  );

  return roleSignatures.length > 1;
}

function buildSharedNodeFromMembership({
  node = {},
  responsibilityByHop = new Map(),
} = {}) {
  const memberships = asArray(node.flowLaneMemberships);

  const enrichedMemberships = memberships.map((membership) => {
    const hopResponsibility =
      responsibilityByHop.get(membership.hopId) || null;

    const endpointResponsibility =
      membership.endpoint === "from"
        ? hopResponsibility?.from?.responsibility
        : hopResponsibility?.to?.responsibility;

    const oppositeResponsibility =
      membership.endpoint === "from"
        ? hopResponsibility?.to?.responsibility
        : hopResponsibility?.from?.responsibility;

    return {
      hopId: membership.hopId,
      flowLaneId: membership.flowLaneId || null,
      flowLaneType: membership.flowLaneType || null,
      endpoint: membership.endpoint || null,
      contextualRole: membership.contextualRole || null,

      perHopRole:
        endpointResponsibility?.role || "unknown",

      perHopRoleSource:
        endpointResponsibility?.roleSource || null,

      oppositeRole:
        oppositeResponsibility?.role || "unknown",

      handoffType:
        hopResponsibility?.handoffResponsibility?.handoffType || null,
    };
  });

  const laneTypes = uniqueBy(
    enrichedMemberships
      .map((item) => item.flowLaneType)
      .filter(Boolean),
    (item) => item
  );

  const perHopRoles = uniqueBy(
    enrichedMemberships
      .map((item) => item.perHopRole)
      .filter((role) => role && role !== "unknown"),
    (item) => item
  );

  const rolePairs = uniqueBy(
    enrichedMemberships
      .map((item) =>
        `${item.perHopRole || "unknown"}->${item.oppositeRole || "unknown"}`
      )
      .filter(Boolean),
    (item) => item
  );

  const classification = classifySharedNode({
    membershipCount: enrichedMemberships.length,
    laneTypes,
    rolePairs,
    perHopRoles,
    });

    const railRoleProfiles =
    buildRailRoleProfiles(enrichedMemberships);

    const railSpecificRoleDifference =
    hasRailSpecificRoleDifference(railRoleProfiles);

    const railRoleClassification =
    classifyRailRoleProfile({
        railRoleProfiles,
        hasRailSpecificRoleDifference:
        railSpecificRoleDifference,
    });

    const teachingHint =
    buildSharedNodeTeachingHint(classification);

    return {
    nodeId: node.nodeId || normalizeKey(node.nodeName),
    nodeName: node.nodeName || node.nodeId || "Unknown node",
    globalRole: node.globalRole || null,

    shared: classification !== "not_shared",
    classification,
    teachingHint,

    membershipCount: enrichedMemberships.length,
    laneCount: laneTypes.length,
    roleCount: perHopRoles.length,

    railRoleProfileCount:
    railRoleProfiles.length,

    hasRailSpecificRoleDifference:
    railSpecificRoleDifference,

    railRoleClassification,

    participatingLaneTypes: laneTypes,
    perHopRoles,
    rolePairs,
    railRoleProfiles,

    memberships: enrichedMemberships,

    safety: {
      traversalUnchanged: true,
      roleEnrichmentOnly: true,
      perHopRoleWins: true,
      doNotAssumeSameRoleEverywhere:
        classification === "multi_role_shared" ||
        classification === "multi_rail_multi_role_shared",
    },
  };
}


function classifyRailRoleProfile({
  railRoleProfiles = [],
  hasRailSpecificRoleDifference = false,
} = {}) {
  const laneCount = asArray(railRoleProfiles).length;

  if (laneCount <= 1) {
    return "single_rail_role";
  }

  if (hasRailSpecificRoleDifference) {
    return "multi_rail_different_role";
  }

  return "multi_rail_same_role";
}

function buildSharedNodeTeachingHint(classification) {
  if (classification === "single_role_shared") {
    return "This component appears in multiple handoffs, but keeps the same per-hop responsibility.";
  }

  if (classification === "multi_rail_shared") {
    return "This component appears across multiple rails. Narration should describe its responsibility per handoff, not as one global behavior.";
  }

  if (classification === "multi_role_shared") {
    return "This component changes responsibility depending on the handoff. Per-hop role must win.";
  }

  if (classification === "multi_rail_multi_role_shared") {
    return "This component appears across multiple rails and may change responsibility by handoff. Narration must use per-hop responsibility.";
  }

  return "This component is not meaningfully shared in the current traversal.";
}

function buildSharedNodeUnderstanding({
  canonicalTraversalRail = {},
  responsibilityUnderstanding = {},
  outputDir = null,
} = {}) {
  const responsibilityByHop =
    buildResponsibilityIndex(responsibilityUnderstanding);

  const sourceNodes = asArray(canonicalTraversalRail.nodeMemberships).length
    ? asArray(canonicalTraversalRail.nodeMemberships)
    : asArray(canonicalTraversalRail.sharedNodeSummary);

  const nodes = sourceNodes
    .map((node) =>
      buildSharedNodeFromMembership({
        node,
        responsibilityByHop,
      })
    )
    .filter((node) => node.shared === true);

  const classificationBreakdown = nodes.reduce((acc, node) => {
    acc[node.classification] =
      (acc[node.classification] || 0) + 1;
    return acc;
  }, {});

  const payload = {
    version: BUILDER_VERSION,
    source: "sharedNodeUnderstandingBuilder",
    purpose:
      "Detect shared architecture nodes across hops and rails without changing traversal or responsibility selection.",

    rules: {
      traversalMutation: "forbidden",
      roleMutation: "forbidden",
      perHopRoleWins: true,
      sharedNodeDoesNotImplySameResponsibilityEverywhere: true,
    },

    nodeCount: nodes.length,
    nodes,

    stats: {
        sharedNodeCount: nodes.length,

        multiRailSharedCount: nodes.filter((node) =>
            node.classification.includes("multi_rail")
        ).length,

        multiRoleSharedCount: nodes.filter((node) =>
            node.classification.includes("multi_role")
        ).length,

        railSpecificRoleDifferenceCount:
            nodes.filter(
            (node) => node.hasRailSpecificRoleDifference === true
            ).length,

        classificationBreakdown,
        traversalChanged: false,
        },
  };

  if (outputDir) {
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(
      path.join(outputDir, "shared-node-understanding.json"),
      JSON.stringify(payload, null, 2),
      "utf8"
    );
  }

  return payload;
}

module.exports = {
  BUILDER_VERSION,
  buildSharedNodeUnderstanding,
};
'use strict';

/**
 * BUG-22U.5 — Parallel Multi-Flow Node Participation
 *
 * Builds flow lanes from architecture relationships and records how each node
 * participates across multiple lanes.
 *
 * Ownership:
 * - architectureFlowBuilder owns traversal/path selection.
 * - architectureFlowLaneBuilder owns lane extraction + node participation.
 * - lessonGraphBuilder decides what to teach.
 * - renderPlan/Root.jsx only render.
 *
 * Borrowed ideas:
 * - OpenTelemetry: same service can participate in many traces.
 * - BPMN: same task/node can participate in multiple process lanes.
 * - Mermaid: one node can be reused across multiple semantic paths.
 *
 * No narration here.
 * No LLM here.
 * No camera logic here.
 */

const VERSION = 'architecture-flow-lanes-v1';

const LANE_TYPES = {
  PRIMARY_REQUEST_FLOW: 'primary_request_flow',
  PAYLOAD_DELIVERY_FLOW: 'payload_delivery_flow',
  VALIDATION_FLOW: 'validation_flow',
  ROUTING_CONTROL_FLOW: 'routing_control_flow',
  STATE_FLOW: 'state_flow',
  OBSERVABILITY_FLOW: 'observability_flow',
  CONFIG_CONTROL_FLOW: 'config_control_flow',
  ASYNC_EVENT_FLOW: 'async_event_flow',
  FAILURE_FALLBACK_FLOW: 'failure_fallback_flow',
  DEPENDENCY_FLOW: 'dependency_flow',
  TOPOLOGY_CONTINUITY_FLOW: 'topology_continuity_flow',
  UNKNOWN_FLOW: 'unknown_flow',
};

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function lower(value) {
  return cleanText(value).toLowerCase();
}

function normalizeKey(value) {
  return lower(value)
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function uniqueBy(items, getKey) {
  const seen = new Set();
  const out = [];

  for (const item of items || []) {
    const key = getKey(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }

  return out;
}

function getRelationshipId(relationship = {}, index = 0) {
  return (
    relationship.id ||
    relationship.relationshipId ||
    `lane_relationship_${index + 1}_${normalizeKey(
      `${relationship.sourceId || relationship.sourceName}_to_${
        relationship.targetId || relationship.targetName
      }`
    )}`
  );
}

function getSourceId(relationship = {}) {
  return (
    relationship.sourceId ||
    relationship.from?.id ||
    relationship.fromId ||
    relationship.source ||
    normalizeKey(relationship.sourceName || relationship.from?.name)
  );
}

function getTargetId(relationship = {}) {
  return (
    relationship.targetId ||
    relationship.to?.id ||
    relationship.toId ||
    relationship.target ||
    normalizeKey(relationship.targetName || relationship.to?.name)
  );
}

function getSourceName(relationship = {}) {
  return cleanText(
    relationship.sourceName ||
      relationship.from?.name ||
      relationship.source ||
      relationship.sourceId
  );
}

function getTargetName(relationship = {}) {
  return cleanText(
    relationship.targetName ||
      relationship.to?.name ||
      relationship.target ||
      relationship.targetId
  );
}

function getInteractionMode(relationship = {}) {
  return (
    relationship.interactionMode ||
    relationship.mappedInteractionMode ||
    relationship.contextualRoles?.interactionMode ||
    relationship.semanticFlowType ||
    'unknown_interaction'
  );
}

function getFlowPriority(relationship = {}) {
  return relationship.flowPriority || relationship.contextualRoles?.flowPriority || 'unknown';
}

function inferLaneType(relationship = {}) {
  const mode = getInteractionMode(relationship);
  const handoffRole = relationship.contextualRoles?.handoffRole;
  const text = lower(
    [
      relationship.edgeLabel,
      relationship.evidenceText,
      relationship.reason,
      relationship.directionality,
      relationship.semanticFlowType,
      relationship.operationalIntent,
    ]
      .filter(Boolean)
      .join(' ')
  );

  if (
    mode === 'request_response' ||
    handoffRole === 'request_entry_handoff'
  ) {
    return LANE_TYPES.PRIMARY_REQUEST_FLOW;
  }

  if (mode === 'payload_delivery') {
    return LANE_TYPES.PAYLOAD_DELIVERY_FLOW;
  }

  if (
    mode === 'auth_validation' ||
    handoffRole === 'auth_validation_handoff'
  ) {
    return LANE_TYPES.VALIDATION_FLOW;
  }

  if (
    mode === 'traffic_distribution' ||
    handoffRole === 'routing_control_handoff'
  ) {
    return LANE_TYPES.ROUTING_CONTROL_FLOW;
  }

  if (
    mode === 'bidirectional_sync' ||
    handoffRole === 'state_handoff' ||
    /\b(reads?|writes?|sync|replicat|database|state|store|storage|persist)\b/.test(text)
  ) {
    return LANE_TYPES.STATE_FLOW;
  }

  if (
    mode === 'observability_signal' ||
    mode === 'health_signal' ||
    handoffRole === 'observability_handoff'
  ) {
    return LANE_TYPES.OBSERVABILITY_FLOW;
  }

  if (
    mode === 'configuration_flow' ||
    handoffRole === 'config_control_handoff'
  ) {
    return LANE_TYPES.CONFIG_CONTROL_FLOW;
  }

  if (
    mode === 'async_event' ||
    handoffRole === 'async_event_handoff'
  ) {
    return LANE_TYPES.ASYNC_EVENT_FLOW;
  }

  if (
    mode === 'failure_or_fallback' ||
    handoffRole === 'failure_fallback_handoff'
  ) {
    return LANE_TYPES.FAILURE_FALLBACK_FLOW;
  }

  if (
    mode === 'dependency' ||
    handoffRole === 'dependency_handoff'
  ) {
    return LANE_TYPES.DEPENDENCY_FLOW;
  }

  if (
    mode === 'topology_continuity' ||
    handoffRole === 'topology_continuity_handoff'
  ) {
    return LANE_TYPES.TOPOLOGY_CONTINUITY_FLOW;
  }

  return LANE_TYPES.UNKNOWN_FLOW;
}

function lanePriority(laneType) {
  switch (laneType) {
    case LANE_TYPES.PRIMARY_REQUEST_FLOW:
      return 100;
    case LANE_TYPES.PAYLOAD_DELIVERY_FLOW:
      return 90;
    case LANE_TYPES.ROUTING_CONTROL_FLOW:
      return 75;
    case LANE_TYPES.VALIDATION_FLOW:
      return 70;
    case LANE_TYPES.STATE_FLOW:
      return 65;
    case LANE_TYPES.ASYNC_EVENT_FLOW:
      return 45;
    case LANE_TYPES.CONFIG_CONTROL_FLOW:
      return 35;
    case LANE_TYPES.FAILURE_FALLBACK_FLOW:
      return 30;
    case LANE_TYPES.OBSERVABILITY_FLOW:
      return 20;
    case LANE_TYPES.DEPENDENCY_FLOW:
      return 15;
    case LANE_TYPES.TOPOLOGY_CONTINUITY_FLOW:
      return 5;
    case LANE_TYPES.UNKNOWN_FLOW:
    default:
      return 0;
  }
}

function getLaneId(laneType) {
  return `lane_${laneType}`;
}

function confidenceRank(confidence) {
  switch (confidence) {
    case 'deterministic':
      return 4;
    case 'high':
      return 3;
    case 'medium':
      return 2;
    case 'low':
      return 1;
    default:
      return 0;
  }
}

function summarizeConfidence(values = []) {
  const ranks = values.map(confidenceRank).filter((rank) => rank > 0);
  if (!ranks.length) return 'unknown';

  const min = Math.min(...ranks);

  if (min >= 4) return 'deterministic';
  if (min >= 3) return 'high';
  if (min >= 2) return 'medium';
  if (min >= 1) return 'low';

  return 'unknown';
}

function serializeRelationshipForLane(relationship = {}, index = 0) {
  const laneType = inferLaneType(relationship);

  return {
    relationshipId: getRelationshipId(relationship, index),
    sourceId: getSourceId(relationship),
    sourceName: getSourceName(relationship),
    targetId: getTargetId(relationship),
    targetName: getTargetName(relationship),

    laneType,
    interactionMode: getInteractionMode(relationship),
    flowPriority: getFlowPriority(relationship),
    directionality: relationship.directionality || 'directed',

    confidence:
    relationship.contextualRoles?.confidence ||
    relationship.confidence ||
    'unknown',

    confidenceSource:
    relationship.evidenceInteraction?.mappedEvidenceSource ||
    relationship.mappedEvidenceSource ||
    'unknown',

    consensus:
    relationship.evidenceInteraction?.consensus ||
    'unknown',

    demotionApplied:
    relationship.evidenceInteraction?.demotionApplied === true,
    reason: relationship.reason || null,
    inferred: relationship.inferred === true,

    fromRoleInHandoff:
      relationship.contextualRoles?.fromRoleInHandoff ||
      relationship.contextualRoles?.sourceRole ||
      null,

    toRoleInHandoff:
      relationship.contextualRoles?.toRoleInHandoff ||
      relationship.contextualRoles?.targetRole ||
      null,

    handoffRole: relationship.contextualRoles?.handoffRole || null,

    edgeLabel: relationship.edgeLabel || null,
    evidenceIds: asArray(relationship.evidenceIds),
    stepSupported: relationship.stepArrowFusion?.stepSupported === true,
    stepSupportStrength: relationship.stepArrowFusion?.stepSupportStrength || null,
  };
}

function buildLaneRelationshipGroups(relationships = []) {
  const groups = new Map();

  asArray(relationships).forEach((relationship, index) => {
    const laneRel = serializeRelationshipForLane(relationship, index);
    const laneId = getLaneId(laneRel.laneType);

    if (!groups.has(laneId)) {
      groups.set(laneId, {
        laneId,
        laneType: laneRel.laneType,
        priority: lanePriority(laneRel.laneType),
        relationships: [],
      });
    }

    groups.get(laneId).relationships.push(laneRel);
  });

  return Array.from(groups.values()).sort((a, b) => b.priority - a.priority);
}

function buildNodeParticipation(lanes = []) {
  const participationByNode = new Map();

  function addParticipation(nodeId, nodeName, relationship, side) {
    if (!nodeId) return;

    if (!participationByNode.has(nodeId)) {
      participationByNode.set(nodeId, {
        componentId: nodeId,
        componentName: nodeName || nodeId,
        laneParticipation: [],
      });
    }

    const node = participationByNode.get(nodeId);
    const role =
      side === 'source'
        ? relationship.fromRoleInHandoff
        : relationship.toRoleInHandoff;

    node.laneParticipation.push({
      laneId: getLaneId(relationship.laneType),
      laneType: relationship.laneType,
      side,
      roleInLane: role || 'unknown_contextual_role',
      handoffRole: relationship.handoffRole || null,
      relationshipId: relationship.relationshipId,
      connectedComponentId:
        side === 'source' ? relationship.targetId : relationship.sourceId,
      connectedComponentName:
        side === 'source' ? relationship.targetName : relationship.sourceName,
      interactionMode: relationship.interactionMode,
      flowPriority: relationship.flowPriority,
      confidence: relationship.confidence,

        confidenceSource:
        relationship.confidenceSource || 'unknown',

        consensus:
        relationship.consensus || 'unknown',

        demotionApplied:
        relationship.demotionApplied === true,

        stepSupported: relationship.stepSupported,
    });
  }

  for (const lane of lanes) {
    for (const relationship of lane.relationships) {
      addParticipation(
        relationship.sourceId,
        relationship.sourceName,
        relationship,
        'source'
      );

      addParticipation(
        relationship.targetId,
        relationship.targetName,
        relationship,
        'target'
      );
    }
  }

  return Array.from(participationByNode.values()).map((node) => ({
    ...node,
    laneParticipation: uniqueBy(
      node.laneParticipation,
      (item) =>
        `${item.laneId}:${item.side}:${item.connectedComponentId}:${item.relationshipId}`
    ).sort((a, b) => {
      const priorityDelta =
        lanePriority(a.laneType) - lanePriority(b.laneType);

      if (priorityDelta !== 0) return -priorityDelta;

      return a.connectedComponentName.localeCompare(b.connectedComponentName);
    }),
    laneCount: uniqueBy(
      node.laneParticipation,
      (item) => item.laneId
    ).length,
  }));
}

function summarizeLane(lane = {}) {
  const relationships = asArray(lane.relationships);
  const nodes = uniqueBy(
    relationships.flatMap((relationship) => [
      {
        id: relationship.sourceId,
        name: relationship.sourceName,
      },
      {
        id: relationship.targetId,
        name: relationship.targetName,
      },
    ]),
    (node) => node.id
  );

  return {
    laneId: lane.laneId,
    laneType: lane.laneType,
    priority: lane.priority,
    confidence: summarizeConfidence(relationships.map((item) => item.confidence)),
    relationshipCount: relationships.length,
    nodeCount: nodes.length,
    nodes,
    relationships,
  };
}

function buildArchitectureFlowLanes({ relationships = [] } = {}) {
  const laneGroups = buildLaneRelationshipGroups(relationships);
  const lanes = laneGroups.map(summarizeLane);
  const nodeParticipation = buildNodeParticipation(lanes);

  return {
    version: VERSION,
    generatedAt: new Date().toISOString(),
    lanes,
    nodeParticipation,
    stats: {
      laneCount: lanes.length,
      relationshipCount: asArray(relationships).length,
      nodeParticipationCount: nodeParticipation.length,
      sharedNodeCount: nodeParticipation.filter((node) => node.laneCount > 1).length,
      primaryLaneCount: lanes.filter(
        (lane) =>
          lane.laneType === LANE_TYPES.PRIMARY_REQUEST_FLOW ||
          lane.laneType === LANE_TYPES.PAYLOAD_DELIVERY_FLOW
      ).length,
      supportingLaneCount: lanes.filter(
        (lane) =>
          lane.laneType !== LANE_TYPES.PRIMARY_REQUEST_FLOW &&
          lane.laneType !== LANE_TYPES.PAYLOAD_DELIVERY_FLOW
      ).length,
    },
  };
}

module.exports = {
  VERSION,
  LANE_TYPES,
  buildArchitectureFlowLanes,
  inferLaneType,
}; 
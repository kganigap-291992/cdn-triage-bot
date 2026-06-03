'use strict';

/**
 * BUG-22U.6 — Shared Infrastructure Across Parallel Flow Lanes
 *
 * Detects components that participate across multiple semantic flow lanes.
 *
 * Input:
 * - architectureFlow.flowLanes from architectureFlowLaneBuilder.js
 *
 * Ownership:
 * - FlowLaneBuilder: extracts lanes + node participation
 * - SharedInfrastructureBuilder: classifies shared nodes across lanes
 * - LessonGraph: decides what to teach
 * - Dialogue: explains
 * - RenderPlan/Root.jsx: render only
 *
 * No LLM.
 * No traversal selection.
 * No camera logic.
 */

const VERSION = 'architecture-shared-infrastructure-v1';

const SHARED_INFRASTRUCTURE_TYPES = {
  SHARED_GATEWAY_OR_CONTROL_POINT: 'shared_gateway_or_control_point',
  SHARED_PROCESSING_LAYER: 'shared_processing_layer',
  SHARED_STATE_OR_PERSISTENCE: 'shared_state_or_persistence',
  SHARED_OBSERVABILITY_OR_CONTROL: 'shared_observability_or_control',
  SHARED_DEPENDENCY: 'shared_dependency',
  SHARED_TOPOLOGY_ONLY: 'shared_topology_only',
  UNKNOWN_SHARED_INFRASTRUCTURE: 'unknown_shared_infrastructure',
};

const TRUSTED_CONSENSUS = new Set(['agreed', 'strong_consensus']);
const WEAK_LANES = new Set([
  'topology_continuity_flow',
  'unknown_flow',
]);

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function lower(value) {
  return cleanText(value).toLowerCase();
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

function summarizeConfidence(confidences = []) {
  const ranks = confidences.map(confidenceRank).filter((rank) => rank > 0);
  if (!ranks.length) return 'unknown';

  const min = Math.min(...ranks);

  if (min >= 4) return 'deterministic';
  if (min >= 3) return 'high';
  if (min >= 2) return 'medium';
  if (min >= 1) return 'low';

  return 'unknown';
}

function isTrustedParticipation(participation = {}) {
  if (participation.demotionApplied === true) return false;
  if (WEAK_LANES.has(participation.laneType)) return false;

  const confidence = confidenceRank(participation.confidence);
  if (confidence < confidenceRank('medium')) return false;

  const consensus = participation.consensus || 'unknown';
  if (consensus !== 'unknown' && !TRUSTED_CONSENSUS.has(consensus)) {
    return false;
  }

  return true;
}

function classifySharedInfrastructure(node = {}) {
  const participations = asArray(node.laneParticipation);
  const trusted = participations.filter(isTrustedParticipation);

  const laneTypes = new Set(trusted.map((item) => item.laneType));
  const roles = new Set(trusted.map((item) => item.roleInLane));
  const text = lower(
    [
      node.componentName,
      ...trusted.map((item) => item.laneType),
      ...trusted.map((item) => item.roleInLane),
      ...trusted.map((item) => item.handoffRole),
      ...trusted.map((item) => item.interactionMode),
    ].join(' ')
  );

  if (!trusted.length) {
    return SHARED_INFRASTRUCTURE_TYPES.SHARED_TOPOLOGY_ONLY;
  }

  if (
    roles.has('processing_executor') ||
    /application|cluster|processor|worker|service|execution/.test(text)
    ) {
    return SHARED_INFRASTRUCTURE_TYPES.SHARED_PROCESSING_LAYER;
    }

    if (
    roles.has('routing_controller') ||
    roles.has('ingress_receiver') ||
    laneTypes.has('routing_control_flow') ||
    laneTypes.has('validation_flow') ||
    /gateway|routing|router|control|ingress|edge/.test(text)
    ) {
    return SHARED_INFRASTRUCTURE_TYPES.SHARED_GATEWAY_OR_CONTROL_POINT;
    }

  if (
    roles.has('state_owner') ||
    laneTypes.has('state_flow') ||
    /database|state|store|storage|persistence/.test(text)
  ) {
    return SHARED_INFRASTRUCTURE_TYPES.SHARED_STATE_OR_PERSISTENCE;
  }

  if (
    laneTypes.has('observability_flow') ||
    laneTypes.has('config_control_flow') ||
    /metrics|telemetry|observability|config|configuration/.test(text)
  ) {
    return SHARED_INFRASTRUCTURE_TYPES.SHARED_OBSERVABILITY_OR_CONTROL;
  }

  if (
    laneTypes.has('dependency_flow') ||
    roles.has('dependency_provider') ||
    roles.has('dependency_consumer')
  ) {
    return SHARED_INFRASTRUCTURE_TYPES.SHARED_DEPENDENCY;
  }

  return SHARED_INFRASTRUCTURE_TYPES.UNKNOWN_SHARED_INFRASTRUCTURE;
}

function buildSharedReason(node = {}, trustedParticipations = []) {
  const lanes = uniqueBy(
    trustedParticipations.map((item) => item.laneType),
    (item) => item
  );

  if (!trustedParticipations.length) {
    return `${node.componentName} appears in multiple lanes, but only weak or topology-only evidence supports the sharing.`;
  }

  return `${node.componentName} participates across ${lanes.length} trusted flow lane(s): ${lanes.join(', ')}.`;
}

function buildSharedInfrastructureEntry(node = {}) {
  const participations = asArray(node.laneParticipation);
  const trustedParticipations = participations.filter(isTrustedParticipation);
  const weakParticipations = participations.filter(
    (item) => !isTrustedParticipation(item)
  );

  const sharedType = classifySharedInfrastructure(node);

  return {
    componentId: node.componentId,
    componentName: node.componentName,

    sharedType,
    laneCount: node.laneCount || uniqueBy(participations, (item) => item.laneId).length,
    trustedLaneCount: uniqueBy(
      trustedParticipations,
      (item) => item.laneId
    ).length,
    weakLaneCount: uniqueBy(
      weakParticipations,
      (item) => item.laneId
    ).length,

    confidence: summarizeConfidence(
      trustedParticipations.map((item) => item.confidence)
    ),

    reason: buildSharedReason(node, trustedParticipations),

    trustedParticipations: trustedParticipations.map((item) => ({
      laneId: item.laneId,
      laneType: item.laneType,
      roleInLane: item.roleInLane,
      handoffRole: item.handoffRole,
      connectedComponentName: item.connectedComponentName,
      interactionMode: item.interactionMode,
      flowPriority: item.flowPriority,
      confidence: item.confidence,
      confidenceSource: item.confidenceSource,
      consensus: item.consensus,
      relationshipId: item.relationshipId,
      stepSupported: item.stepSupported === true,
    })),

    weakParticipations: weakParticipations.map((item) => ({
      laneId: item.laneId,
      laneType: item.laneType,
      roleInLane: item.roleInLane,
      handoffRole: item.handoffRole,
      connectedComponentName: item.connectedComponentName,
      interactionMode: item.interactionMode,
      flowPriority: item.flowPriority,
      confidence: item.confidence,
      confidenceSource: item.confidenceSource,
      consensus: item.consensus,
      demotionApplied: item.demotionApplied === true,
      relationshipId: item.relationshipId,
      stepSupported: item.stepSupported === true,
    })),
  };
}

function buildSharedInfrastructureFromFlowLanes(flowLanes = {}) {
  const nodeParticipation = asArray(flowLanes.nodeParticipation);

  const sharedNodes = nodeParticipation.filter((node) => {
    const laneCount =
      node.laneCount ||
      uniqueBy(asArray(node.laneParticipation), (item) => item.laneId).length;

    return laneCount > 1;
  });

  const sharedInfrastructure = sharedNodes.map(buildSharedInfrastructureEntry);

  return {
    version: VERSION,
    generatedAt: new Date().toISOString(),

    sharedInfrastructure,

    stats: {
      nodeParticipationCount: nodeParticipation.length,
      sharedNodeCount: sharedNodes.length,
      trustedSharedNodeCount: sharedInfrastructure.filter(
        (item) => item.trustedLaneCount > 1
      ).length,
      weakOrTopologyOnlySharedNodeCount: sharedInfrastructure.filter(
        (item) => item.trustedLaneCount <= 1
      ).length,
      sharedTypeBreakdown: sharedInfrastructure.reduce((acc, item) => {
        acc[item.sharedType] = (acc[item.sharedType] || 0) + 1;
        return acc;
      }, {}),
    },
  };
}

module.exports = {
  VERSION,
  SHARED_INFRASTRUCTURE_TYPES,
  buildSharedInfrastructureFromFlowLanes,
  classifySharedInfrastructure,
  isTrustedParticipation,
};
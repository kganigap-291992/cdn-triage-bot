'use strict';

/**
 * BUG-22U.2A — Contextual Role Builder
 *
 * Assigns per-handoff roles to each side of an architecture relationship.
 *
 * Core idea:
 * A component does not have one fixed meaning everywhere.
 * Its role depends on the handoff:
 *
 *   Client -> Gateway     Gateway = ingress_receiver / validation_checkpoint
 *   Gateway -> Router     Gateway = routing_controller
 *   Gateway -> Metrics    Gateway = observability_emitter
 *
 * Ownership:
 * - This file infers contextual roles per relationship/handoff.
 * - It does not choose traversal.
 * - It does not narrate.
 * - It does not use LLM.
 */

const CONTEXTUAL_ROLES = {
  TRAFFIC_ORIGIN: 'traffic_origin',
  INGRESS_RECEIVER: 'ingress_receiver',
  EDGE_ACCELERATOR: 'edge_accelerator',
  REQUEST_FORWARDER: 'request_forwarder',
  VALIDATION_CHECKPOINT: 'validation_checkpoint',
  ROUTING_CONTROLLER: 'routing_controller',
  PROCESSING_EXECUTOR: 'processing_executor',
  STATE_OWNER: 'state_owner',
  OBSERVABILITY_EMITTER: 'observability_emitter',
  OBSERVABILITY_COLLECTOR: 'observability_collector',
  CONFIG_CONTROLLER: 'config_controller',
  CONFIG_RECEIVER: 'config_receiver',
  ASYNC_PRODUCER: 'async_producer',
  ASYNC_CONSUMER: 'async_consumer',
  FAILURE_PRIMARY: 'failure_primary',
  FAILURE_BACKUP: 'failure_backup',
  DEPENDENCY_CONSUMER: 'dependency_consumer',
  DEPENDENCY_PROVIDER: 'dependency_provider',
  UNKNOWN_CONTEXTUAL_ROLE: 'unknown_contextual_role',
};

const HANDOFF_ROLES = {
  REQUEST_ENTRY_HANDOFF: 'request_entry_handoff',
  PAYLOAD_DELIVERY_HANDOFF: 'payload_delivery_handoff',
  AUTH_VALIDATION_HANDOFF: 'auth_validation_handoff',
  ROUTING_CONTROL_HANDOFF: 'routing_control_handoff',
  PROCESSING_HANDOFF: 'processing_handoff',
  STATE_HANDOFF: 'state_handoff',
  OBSERVABILITY_HANDOFF: 'observability_handoff',
  CONFIG_CONTROL_HANDOFF: 'config_control_handoff',
  ASYNC_EVENT_HANDOFF: 'async_event_handoff',
  FAILURE_FALLBACK_HANDOFF: 'failure_fallback_handoff',
  DEPENDENCY_HANDOFF: 'dependency_handoff',
  TOPOLOGY_CONTINUITY_HANDOFF: 'topology_continuity_handoff',
  UNKNOWN_HANDOFF: 'unknown_handoff',
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

function collectRelationshipText(relationship = {}) {
  return lower(
    [
      relationship.sourceName,
      relationship.targetName,
      relationship.edgeLabel,
      relationship.evidenceText,
      relationship.mappedReason,
      relationship.reason,
      relationship.interactionMode,
      relationship.flowPriority,
      relationship.directionality,
      relationship.semanticFlowType,
      relationship.operationalIntent,
      relationship.stepArrowFusion?.fusionReason,
      asArray(relationship.stepArrowFusion?.supportingSteps)
        .map((step) => step.text)
        .join(' '),
    ]
      .filter(Boolean)
      .join(' ')
  );
}

function getInteractionMode(relationship = {}) {
  return (
    relationship.interactionMode ||
    relationship.mappedInteractionMode ||
    relationship.semanticFlowType ||
    'unknown_interaction'
  );
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

function inferComponentShape(name = '', role = '') {
  const text = normalizeKey(`${name} ${role}`);

  if (/user|client|browser|consumer|viewer|customer|external_actor/.test(text)) {
    return 'external_actor';
  }

  if (/cdn|edge|cache/.test(text)) {
    return 'edge_or_cache';
  }

  if (/gateway|api|proxy|ingress/.test(text)) {
    return 'gateway_or_boundary';
  }

  if (/auth|policy|validation|credential|token/.test(text)) {
    return 'validation_component';
  }

  if (/routing|router|load_balancer|balancer|control/.test(text)) {
    return 'routing_component';
  }

  if (/app|application|cluster|service|worker|processor|engine|runtime/.test(text)) {
    return 'processing_component';
  }

  if (/database|db|store|storage|repository|state|persistent/.test(text)) {
    return 'state_component';
  }

  if (/metrics|monitor|telemetry|observability|logs|traces/.test(text)) {
    return 'observability_component';
  }

  if (/config|configuration|admin|management|controller/.test(text)) {
    return 'configuration_component';
  }

  if (/queue|topic|stream|bus|event/.test(text)) {
    return 'async_component';
  }

  return 'unknown_component_shape';
}

function inferHandoffRole(relationship = {}) {
  const mode = getInteractionMode(relationship);
  const text = collectRelationshipText(relationship);

  if (mode === 'topology_continuity') {
    return HANDOFF_ROLES.TOPOLOGY_CONTINUITY_HANDOFF;
  }

  if (mode === 'auth_validation') {
    return HANDOFF_ROLES.AUTH_VALIDATION_HANDOFF;
  }

  if (mode === 'traffic_distribution') {
    return HANDOFF_ROLES.ROUTING_CONTROL_HANDOFF;
  }

  if (mode === 'payload_delivery') {
    return HANDOFF_ROLES.PAYLOAD_DELIVERY_HANDOFF;
  }

  if (mode === 'observability_signal' || mode === 'health_signal') {
    return HANDOFF_ROLES.OBSERVABILITY_HANDOFF;
  }

  if (
    mode === 'configuration_flow' ||
    mode === 'management_relationship'
  ) {
    return HANDOFF_ROLES.CONFIG_CONTROL_HANDOFF;
  }

  if (mode === 'async_event') {
    return HANDOFF_ROLES.ASYNC_EVENT_HANDOFF;
  }

  if (mode === 'failure_or_fallback') {
    return HANDOFF_ROLES.FAILURE_FALLBACK_HANDOFF;
  }

  if (mode === 'dependency') {
    return HANDOFF_ROLES.DEPENDENCY_HANDOFF;
  }

  if (mode === 'bidirectional_sync' || /reads? and writes?|sync|replicat|state/.test(text)) {
    return HANDOFF_ROLES.STATE_HANDOFF;
  }

  if (mode === 'request_response') {
    return HANDOFF_ROLES.REQUEST_ENTRY_HANDOFF;
  }

  if (/database|state|storage|persist/.test(text)) {
    return HANDOFF_ROLES.STATE_HANDOFF;
  }

  if (/process|execute|application|worker|service|cluster/.test(text)) {
    return HANDOFF_ROLES.PROCESSING_HANDOFF;
  }

  return HANDOFF_ROLES.UNKNOWN_HANDOFF;
}

function inferSourceContextualRole(relationship = {}, handoffRole) {
  const sourceShape = inferComponentShape(
    relationship.sourceName,
    relationship.sourceRole
  );

  switch (handoffRole) {
    case HANDOFF_ROLES.REQUEST_ENTRY_HANDOFF:
      if (sourceShape === 'external_actor') return CONTEXTUAL_ROLES.TRAFFIC_ORIGIN;
      if (sourceShape === 'edge_or_cache') return CONTEXTUAL_ROLES.REQUEST_FORWARDER;
      return CONTEXTUAL_ROLES.REQUEST_FORWARDER;

    case HANDOFF_ROLES.PAYLOAD_DELIVERY_HANDOFF:
      if (sourceShape === 'edge_or_cache') return CONTEXTUAL_ROLES.EDGE_ACCELERATOR;
      return CONTEXTUAL_ROLES.REQUEST_FORWARDER;

    case HANDOFF_ROLES.AUTH_VALIDATION_HANDOFF:
      return CONTEXTUAL_ROLES.REQUEST_FORWARDER;

    case HANDOFF_ROLES.ROUTING_CONTROL_HANDOFF:
      return CONTEXTUAL_ROLES.ROUTING_CONTROLLER;

    case HANDOFF_ROLES.PROCESSING_HANDOFF:
      return CONTEXTUAL_ROLES.REQUEST_FORWARDER;

    case HANDOFF_ROLES.STATE_HANDOFF:
      return CONTEXTUAL_ROLES.PROCESSING_EXECUTOR;

    case HANDOFF_ROLES.OBSERVABILITY_HANDOFF:
      return CONTEXTUAL_ROLES.OBSERVABILITY_EMITTER;

    case HANDOFF_ROLES.CONFIG_CONTROL_HANDOFF:
      return CONTEXTUAL_ROLES.CONFIG_CONTROLLER;

    case HANDOFF_ROLES.ASYNC_EVENT_HANDOFF:
      return CONTEXTUAL_ROLES.ASYNC_PRODUCER;

    case HANDOFF_ROLES.FAILURE_FALLBACK_HANDOFF:
      return CONTEXTUAL_ROLES.FAILURE_PRIMARY;

    case HANDOFF_ROLES.DEPENDENCY_HANDOFF:
      return CONTEXTUAL_ROLES.DEPENDENCY_CONSUMER;

    case HANDOFF_ROLES.TOPOLOGY_CONTINUITY_HANDOFF:
      return CONTEXTUAL_ROLES.UNKNOWN_CONTEXTUAL_ROLE;

    default:
      return CONTEXTUAL_ROLES.UNKNOWN_CONTEXTUAL_ROLE;
  }
}

function inferTargetContextualRole(relationship = {}, handoffRole) {
  const targetShape = inferComponentShape(
    relationship.targetName,
    relationship.targetRole
  );

  switch (handoffRole) {
    case HANDOFF_ROLES.REQUEST_ENTRY_HANDOFF:
      if (targetShape === 'gateway_or_boundary') return CONTEXTUAL_ROLES.INGRESS_RECEIVER;
      if (targetShape === 'edge_or_cache') return CONTEXTUAL_ROLES.EDGE_ACCELERATOR;
      if (targetShape === 'processing_component') return CONTEXTUAL_ROLES.PROCESSING_EXECUTOR;
      return CONTEXTUAL_ROLES.INGRESS_RECEIVER;

    case HANDOFF_ROLES.PAYLOAD_DELIVERY_HANDOFF:
      if (targetShape === 'gateway_or_boundary') return CONTEXTUAL_ROLES.INGRESS_RECEIVER;
      if (targetShape === 'processing_component') return CONTEXTUAL_ROLES.PROCESSING_EXECUTOR;
      return CONTEXTUAL_ROLES.DEPENDENCY_PROVIDER;

    case HANDOFF_ROLES.AUTH_VALIDATION_HANDOFF:
    if (targetShape === 'validation_component') {
        return CONTEXTUAL_ROLES.VALIDATION_CHECKPOINT;
    }

    if (targetShape === 'routing_component') {
        return CONTEXTUAL_ROLES.ROUTING_CONTROLLER;
    }

    if (targetShape === 'processing_component') {
        return CONTEXTUAL_ROLES.PROCESSING_EXECUTOR;
    }

    return CONTEXTUAL_ROLES.VALIDATION_CHECKPOINT;

    case HANDOFF_ROLES.ROUTING_CONTROL_HANDOFF:
    if (targetShape === 'routing_component') {
        return CONTEXTUAL_ROLES.ROUTING_CONTROLLER;
    }

    if (targetShape === 'processing_component') {
        return CONTEXTUAL_ROLES.PROCESSING_EXECUTOR;
    }

    if (targetShape === 'state_component') {
        return CONTEXTUAL_ROLES.STATE_OWNER;
    }

  return CONTEXTUAL_ROLES.ROUTING_CONTROLLER;

    case HANDOFF_ROLES.PROCESSING_HANDOFF:
      return CONTEXTUAL_ROLES.PROCESSING_EXECUTOR;

    case HANDOFF_ROLES.STATE_HANDOFF:
      return CONTEXTUAL_ROLES.STATE_OWNER;

    case HANDOFF_ROLES.OBSERVABILITY_HANDOFF:
      return CONTEXTUAL_ROLES.OBSERVABILITY_COLLECTOR;

    case HANDOFF_ROLES.CONFIG_CONTROL_HANDOFF:
      return CONTEXTUAL_ROLES.CONFIG_RECEIVER;

    case HANDOFF_ROLES.ASYNC_EVENT_HANDOFF:
      return CONTEXTUAL_ROLES.ASYNC_CONSUMER;

    case HANDOFF_ROLES.FAILURE_FALLBACK_HANDOFF:
      return CONTEXTUAL_ROLES.FAILURE_BACKUP;

    case HANDOFF_ROLES.DEPENDENCY_HANDOFF:
      return CONTEXTUAL_ROLES.DEPENDENCY_PROVIDER;

    case HANDOFF_ROLES.TOPOLOGY_CONTINUITY_HANDOFF:
      return CONTEXTUAL_ROLES.UNKNOWN_CONTEXTUAL_ROLE;

    default:
      return CONTEXTUAL_ROLES.UNKNOWN_CONTEXTUAL_ROLE;
  }
}

function buildRoleEvidence(relationship = {}) {
  const evidence = [];

  if (relationship.interactionMode) {
    evidence.push({
      source: 'interaction_mode',
      value: relationship.interactionMode,
    });
  }

  if (relationship.mappedEvidenceSource) {
    evidence.push({
      source: 'mapped_evidence_source',
      value: relationship.mappedEvidenceSource,
      confidence: relationship.mappedConfidence || null,
    });
  }

  if (relationship.evidenceInteraction) {
    evidence.push({
      source: 'evidence_interaction',
      consensus: relationship.evidenceInteraction.consensus || null,
      strength: relationship.evidenceInteraction.evidenceStrength || null,
      demotionApplied: relationship.evidenceInteraction.demotionApplied || false,
    });
  }

  if (relationship.stepArrowFusion?.stepSupported) {
    evidence.push({
      source: 'step_arrow_fusion',
      strength: relationship.stepArrowFusion.stepSupportStrength,
      confidence: relationship.stepArrowFusion.fusionConfidence,
      supportCount: asArray(relationship.stepArrowFusion.supportingSteps).length,
    });
  }

  if (relationship.reason) {
    evidence.push({
      source: 'relationship_reason',
      value: relationship.reason,
    });
  }

  if (relationship.evidenceText) {
    evidence.push({
      source: 'relationship_evidence_text',
      value: cleanText(relationship.evidenceText).slice(0, 240),
    });
  }

  return evidence;
}

function inferContextualRoleConfidence(relationship = {}, handoffRole) {
  const values = [
    relationship.confidence,
    relationship.mappedConfidence,
    relationship.stepArrowFusion?.fusionConfidence,
  ].filter(Boolean);

  let confidence = summarizeConfidence(values);

  if (handoffRole === HANDOFF_ROLES.TOPOLOGY_CONTINUITY_HANDOFF) {
    confidence = confidenceRank(confidence) > confidenceRank('low')
      ? 'low'
      : confidence;
  }

  if (relationship.evidenceInteraction?.demotionApplied) {
    if (confidence === 'high' || confidence === 'deterministic') {
      confidence = 'medium';
    } else if (confidence === 'medium') {
      confidence = 'low';
    }
  }

  return confidence || 'unknown';
}

function buildContextualRoleForRelationship(relationship = {}) {
  const handoffRole = inferHandoffRole(relationship);

  const sourceRole = inferSourceContextualRole(relationship, handoffRole);
  const targetRole = inferTargetContextualRole(relationship, handoffRole);

  const confidence = inferContextualRoleConfidence(relationship, handoffRole);

  return {
    version: 'architecture-contextual-role-v1',
    handoffRole,
    sourceRole,
    targetRole,

    fromRoleInHandoff: sourceRole,
    toRoleInHandoff: targetRole,

    confidence,
    roleEvidence: buildRoleEvidence(relationship),

    relationshipId: relationship.id || null,
    interactionMode: getInteractionMode(relationship),
    flowPriority: relationship.flowPriority || null,
  };
}

function attachContextualRolesToRelationships(relationships = []) {
  if (!Array.isArray(relationships)) return [];

  return relationships.map((relationship) => ({
    ...relationship,
    contextualRoles: buildContextualRoleForRelationship(relationship),
  }));
}

module.exports = {
  CONTEXTUAL_ROLES,
  HANDOFF_ROLES,
  buildContextualRoleForRelationship,
  attachContextualRolesToRelationships,
  inferHandoffRole,
};
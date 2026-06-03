'use strict';

/**
 * BUG-22U.3A — Unknown Enterprise Component Inference
 *
 * Infers likely roles for undefined/internal/opaque enterprise components
 * from graph position and handoff context.
 *
 * Ownership:
 * - Evidence resolver owns known term meaning.
 * - Contextual role builder owns per-handoff roles.
 * - Unknown component inference owns best-effort role inference for opaque names.
 * - LLM enrichment comes later in architectureUnknownComponentEnricher.js.
 *
 * No traversal selection here.
 * No narration here.
 * No LLM here.
 */

const UNKNOWN_COMPONENT_INFERRED_ROLES = {
  TRAFFIC_MEDIATION_LAYER: 'traffic_mediation_layer',
  PROCESSING_EXECUTOR: 'processing_executor',
  ROUTING_OR_CONTROL_LAYER: 'routing_or_control_layer',
  VALIDATION_OR_POLICY_LAYER: 'validation_or_policy_layer',
  STATE_OR_PERSISTENCE_LAYER: 'state_or_persistence_layer',
  OBSERVABILITY_OR_CONTROL_LAYER: 'observability_or_control_layer',
  ASYNC_OR_EVENT_LAYER: 'async_or_event_layer',
  DEPENDENCY_OR_SHARED_SERVICE: 'dependency_or_shared_service',
  UNKNOWN_ENTERPRISE_COMPONENT: 'unknown_enterprise_component',
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

function confidenceFromScore(score) {
  if (score >= 8) return 'high';
  if (score >= 4) return 'medium';
  if (score > 0) return 'low';
  return 'unknown';
}

function isOpaqueEnterpriseName(component = {}) {
  const name = cleanText(component.name || component.label || '');
  const role = lower(component.role || component.structuralRole || '');

  if (!name) return false;

  // Document labels / presentation artifacts
  if (
    /architecture[-\s]?only/i.test(name) ||
    /diagram[-\s]?only/i.test(name) ||
    /overview/i.test(name) ||
    /legend/i.test(name) ||
    /glossary/i.test(name)
  ) {
    return false;
  }

  // Known non-enterprise component categories
  if (
    role === 'external_actor' ||
    role === 'data_store' ||
    role === 'protocol_or_standard'
  ) {
    return false;
  }

  const normalized = normalizeKey(name);

  const knownGeneric =
    /(^|_)(api|gateway|routing|router|database|db|cdn|edge|cache|application|cluster|service|auth|policy|metrics|monitor|telemetry|queue|topic|stream|worker|processor|engine|storage|store)($|_)/.test(
      normalized
    );

  if (knownGeneric) return false;

  // Enterprise-style opaque names:
  // ONYX, RIO, PILLAR, MAT, DELTA, etc.
  if (/^[A-Z0-9]{2,16}$/.test(name)) return true;

  // Single-token internal platform names
  if (/^[A-Z][A-Za-z0-9]{2,24}$/.test(name) && !/\s/.test(name)) {
    return true;
  }

  // Internal service naming conventions
  if (/^[A-Za-z0-9]+[-_/#][A-Za-z0-9_/#.-]+$/.test(name)) {
    return true;
  }

  return (
    role === 'unknown' ||
    role === 'system_component' ||
    role === 'process_step'
  );
}

function getComponentId(component = {}) {
  return (
    component.id ||
    component.componentId ||
    component.entityId ||
    normalizeKey(component.name || component.label)
  );
}

function getComponentName(component = {}) {
  return cleanText(component.name || component.label || getComponentId(component));
}

function buildComponentIndex(components = []) {
  const byId = new Map();
  const byNameKey = new Map();

  for (const component of asArray(components)) {
    const id = getComponentId(component);
    const normalized = {
      ...component,
      id,
      name: getComponentName(component),
    };

    byId.set(id, normalized);
    byNameKey.set(normalizeKey(normalized.name), normalized);
  }

  return { byId, byNameKey };
}

function buildRelationshipIndex(relationships = []) {
  const incoming = new Map();
  const outgoing = new Map();

  for (const relationship of asArray(relationships)) {
    const sourceId = relationship.sourceId || relationship.from?.id;
    const targetId = relationship.targetId || relationship.to?.id;

    if (sourceId) {
      if (!outgoing.has(sourceId)) outgoing.set(sourceId, []);
      outgoing.get(sourceId).push(relationship);
    }

    if (targetId) {
      if (!incoming.has(targetId)) incoming.set(targetId, []);
      incoming.get(targetId).push(relationship);
    }
  }

  return { incoming, outgoing };
}

function addScore(scores, role, value, reason, relationshipId = null) {
  if (!scores[role]) {
    scores[role] = {
      score: 0,
      reasons: [],
      supportingRelationships: [],
    };
  }

  scores[role].score += value;

  if (reason) scores[role].reasons.push(reason);
  if (relationshipId) scores[role].supportingRelationships.push(relationshipId);
}

function roleHintsFromIncoming(relationship = {}, scores = {}) {
  const contextualRoles = relationship.contextualRoles || {};
  const handoffRole = contextualRoles.handoffRole;
  const toRole = contextualRoles.toRoleInHandoff || contextualRoles.targetRole;
  const interactionMode = relationship.interactionMode || contextualRoles.interactionMode;
  const confidence = contextualRoles.confidence || relationship.confidence || 'unknown';
  const strength = confidenceRank(confidence);

  const value = Math.max(1, strength);

  if (toRole === 'processing_executor') {
    addScore(
      scores,
      UNKNOWN_COMPONENT_INFERRED_ROLES.PROCESSING_EXECUTOR,
      value + 2,
      'incoming_handoff_targets_processing_executor',
      relationship.id
    );
  }

  if (toRole === 'ingress_receiver' || handoffRole === 'request_entry_handoff') {
    addScore(
      scores,
      UNKNOWN_COMPONENT_INFERRED_ROLES.TRAFFIC_MEDIATION_LAYER,
      value + 1,
      'incoming_handoff_targets_traffic_mediation',
      relationship.id
    );
  }

  if (toRole === 'routing_controller' || interactionMode === 'traffic_distribution') {
    addScore(
      scores,
      UNKNOWN_COMPONENT_INFERRED_ROLES.ROUTING_OR_CONTROL_LAYER,
      value + 2,
      'incoming_handoff_targets_routing_or_control',
      relationship.id
    );
  }

  if (toRole === 'validation_checkpoint' || interactionMode === 'auth_validation') {
    addScore(
      scores,
      UNKNOWN_COMPONENT_INFERRED_ROLES.VALIDATION_OR_POLICY_LAYER,
      value + 2,
      'incoming_handoff_targets_validation_or_policy',
      relationship.id
    );
  }

  if (toRole === 'state_owner') {
    addScore(
      scores,
      UNKNOWN_COMPONENT_INFERRED_ROLES.STATE_OR_PERSISTENCE_LAYER,
      value + 2,
      'incoming_handoff_targets_state_owner',
      relationship.id
    );
  }

  if (toRole === 'observability_collector' || interactionMode === 'observability_signal') {
    addScore(
      scores,
      UNKNOWN_COMPONENT_INFERRED_ROLES.OBSERVABILITY_OR_CONTROL_LAYER,
      value + 2,
      'incoming_handoff_targets_observability',
      relationship.id
    );
  }

  if (toRole === 'async_consumer' || interactionMode === 'async_event') {
    addScore(
      scores,
      UNKNOWN_COMPONENT_INFERRED_ROLES.ASYNC_OR_EVENT_LAYER,
      value + 2,
      'incoming_handoff_targets_async_or_event',
      relationship.id
    );
  }
}

function roleHintsFromOutgoing(relationship = {}, scores = {}) {
  const contextualRoles = relationship.contextualRoles || {};
  const handoffRole = contextualRoles.handoffRole;
  const fromRole = contextualRoles.fromRoleInHandoff || contextualRoles.sourceRole;
  const toRole = contextualRoles.toRoleInHandoff || contextualRoles.targetRole;
  const interactionMode = relationship.interactionMode || contextualRoles.interactionMode;
  const confidence = contextualRoles.confidence || relationship.confidence || 'unknown';
  const strength = confidenceRank(confidence);
  const value = Math.max(1, strength);

  if (fromRole === 'processing_executor') {
    addScore(
      scores,
      UNKNOWN_COMPONENT_INFERRED_ROLES.PROCESSING_EXECUTOR,
      value + 2,
      'outgoing_handoff_source_is_processing_executor',
      relationship.id
    );
  }

  if (fromRole === 'routing_controller' || interactionMode === 'traffic_distribution') {
    addScore(
      scores,
      UNKNOWN_COMPONENT_INFERRED_ROLES.ROUTING_OR_CONTROL_LAYER,
      value + 2,
      'outgoing_handoff_source_is_routing_or_control',
      relationship.id
    );
  }

  if (fromRole === 'request_forwarder' || handoffRole === 'request_entry_handoff') {
    addScore(
      scores,
      UNKNOWN_COMPONENT_INFERRED_ROLES.TRAFFIC_MEDIATION_LAYER,
      value + 1,
      'outgoing_handoff_source_forwards_request_flow',
      relationship.id
    );
  }

  if (fromRole === 'edge_accelerator') {
    addScore(
      scores,
      UNKNOWN_COMPONENT_INFERRED_ROLES.TRAFFIC_MEDIATION_LAYER,
      value + 1,
      'outgoing_handoff_source_accelerates_or_mediates_traffic',
      relationship.id
    );
  }

  if (fromRole === 'config_controller' || interactionMode === 'configuration_flow') {
    addScore(
      scores,
      UNKNOWN_COMPONENT_INFERRED_ROLES.OBSERVABILITY_OR_CONTROL_LAYER,
      value + 1,
      'outgoing_handoff_source_controls_configuration',
      relationship.id
    );
  }

  if (fromRole === 'observability_emitter' || interactionMode === 'observability_signal') {
    addScore(
      scores,
      UNKNOWN_COMPONENT_INFERRED_ROLES.OBSERVABILITY_OR_CONTROL_LAYER,
      value + 1,
      'outgoing_handoff_source_emits_observability',
      relationship.id
    );
  }

  if (fromRole === 'async_producer' || interactionMode === 'async_event') {
    addScore(
      scores,
      UNKNOWN_COMPONENT_INFERRED_ROLES.ASYNC_OR_EVENT_LAYER,
      value + 1,
      'outgoing_handoff_source_emits_async_event',
      relationship.id
    );
  }

  if (toRole === 'state_owner') {
    addScore(
      scores,
      UNKNOWN_COMPONENT_INFERRED_ROLES.PROCESSING_EXECUTOR,
      value + 2,
      'outgoing_handoff_to_state_owner_suggests_processing_source',
      relationship.id
    );
  }
}

function addBetweenNeighborHints(component = {}, incoming = [], outgoing = [], scores = {}) {
  const hasIngressLikeIncoming = incoming.some((relationship) => {
    const role = relationship.contextualRoles?.fromRoleInHandoff;
    const mode = relationship.interactionMode || relationship.contextualRoles?.interactionMode;

    return (
      role === 'traffic_origin' ||
      role === 'request_forwarder' ||
      mode === 'request_response' ||
      mode === 'payload_delivery'
    );
  });

  const hasStateLikeOutgoing = outgoing.some((relationship) => {
    const role = relationship.contextualRoles?.toRoleInHandoff;
    const mode = relationship.interactionMode || relationship.contextualRoles?.interactionMode;

    return (
      role === 'state_owner' ||
      mode === 'bidirectional_sync'
    );
  });

  const hasRoutingLikeIncoming = incoming.some((relationship) => {
    const role = relationship.contextualRoles?.toRoleInHandoff;
    const mode = relationship.interactionMode || relationship.contextualRoles?.interactionMode;

    return role === 'routing_controller' || mode === 'traffic_distribution';
  });

  const hasProcessingLikeOutgoing = outgoing.some((relationship) => {
    const role = relationship.contextualRoles?.toRoleInHandoff;

    return role === 'processing_executor';
  });

  if (hasIngressLikeIncoming && hasStateLikeOutgoing) {
    addScore(
      scores,
      UNKNOWN_COMPONENT_INFERRED_ROLES.PROCESSING_EXECUTOR,
      4,
      'component_between_ingress_or_request_flow_and_state_owner'
    );
  }

  if (hasRoutingLikeIncoming && hasProcessingLikeOutgoing) {
    addScore(
      scores,
      UNKNOWN_COMPONENT_INFERRED_ROLES.ROUTING_OR_CONTROL_LAYER,
      3,
      'component_between_routing_input_and_processing_output'
    );
  }
}

function selectBestInference(scores = {}) {
  const entries = Object.entries(scores);

  if (!entries.length) {
    return {
      inferredRole: UNKNOWN_COMPONENT_INFERRED_ROLES.UNKNOWN_ENTERPRISE_COMPONENT,
      confidence: 'unknown',
      score: 0,
      reasoning: ['no_graph_context_available'],
      supportingRelationships: [],
    };
  }

  entries.sort((a, b) => b[1].score - a[1].score);

  const [role, metadata] = entries[0];

  return {
    inferredRole: role,
    confidence: confidenceFromScore(metadata.score),
    score: metadata.score,
    reasoning: uniqueBy(metadata.reasons || [], (item) => item),
    supportingRelationships: uniqueBy(
      metadata.supportingRelationships || [],
      (item) => item
    ),
  };
}

function buildUnknownComponentExplanation(component = {}, inference = {}) {
  const name = getComponentName(component);

  switch (inference.inferredRole) {
    case UNKNOWN_COMPONENT_INFERRED_ROLES.PROCESSING_EXECUTOR:
      return `${name} appears to function as a processing or execution layer based on where it sits in the documented handoffs.`;

    case UNKNOWN_COMPONENT_INFERRED_ROLES.TRAFFIC_MEDIATION_LAYER:
      return `${name} appears to mediate incoming or forwarded traffic based on its neighboring handoffs.`;

    case UNKNOWN_COMPONENT_INFERRED_ROLES.ROUTING_OR_CONTROL_LAYER:
      return `${name} appears to help route, coordinate, or control the flow based on graph context.`;

    case UNKNOWN_COMPONENT_INFERRED_ROLES.VALIDATION_OR_POLICY_LAYER:
      return `${name} appears to participate in validation, policy, or checkpoint behavior based on its surrounding handoffs.`;

    case UNKNOWN_COMPONENT_INFERRED_ROLES.STATE_OR_PERSISTENCE_LAYER:
      return `${name} appears to sit near state or persistence behavior based on the flow context.`;

    case UNKNOWN_COMPONENT_INFERRED_ROLES.OBSERVABILITY_OR_CONTROL_LAYER:
      return `${name} appears related to observability or operational control based on its handoff context.`;

    case UNKNOWN_COMPONENT_INFERRED_ROLES.ASYNC_OR_EVENT_LAYER:
      return `${name} appears related to async or event movement based on its handoff context.`;

    case UNKNOWN_COMPONENT_INFERRED_ROLES.DEPENDENCY_OR_SHARED_SERVICE:
      return `${name} appears to act as a shared dependency or supporting service, but the document does not define it clearly.`;

    default:
      return `The document does not define ${name} clearly enough to infer its role beyond an unknown enterprise component.`;
  }
}

function inferUnknownComponent(component = {}, relationshipIndex = {}) {
  const componentId = getComponentId(component);
  const incoming = asArray(relationshipIndex.incoming?.get(componentId));
  const outgoing = asArray(relationshipIndex.outgoing?.get(componentId));

  const scores = {};

  for (const relationship of incoming) {
    roleHintsFromIncoming(relationship, scores);
  }

  for (const relationship of outgoing) {
    roleHintsFromOutgoing(relationship, scores);
  }

  addBetweenNeighborHints(component, incoming, outgoing, scores);

  const inference = selectBestInference(scores);

  return {
    componentId,
    componentName: getComponentName(component),

    inferredRole: inference.inferredRole,
    confidence: inference.confidence,
    score: inference.score,

    reasoning: inference.reasoning,
    supportingRelationships: inference.supportingRelationships,

    incomingRelationshipCount: incoming.length,
    outgoingRelationshipCount: outgoing.length,

    explanation: buildUnknownComponentExplanation(component, inference),
  };
}

function inferUnknownEnterpriseComponents({
  components = [],
  relationships = [],
} = {}) {
  const relationshipIndex = buildRelationshipIndex(relationships);

  const unknownComponents = asArray(components).filter(isOpaqueEnterpriseName);

  const inferences = unknownComponents.map((component) =>
    inferUnknownComponent(component, relationshipIndex)
  );

  return {
    version: 'architecture-unknown-component-inference-v1',
    generatedAt: new Date().toISOString(),
    components: inferences,
    stats: {
      componentCount: asArray(components).length,
      relationshipCount: asArray(relationships).length,
      unknownComponentCount: unknownComponents.length,
      inferredUnknownComponentCount: inferences.filter(
        (item) =>
          item.inferredRole !==
          UNKNOWN_COMPONENT_INFERRED_ROLES.UNKNOWN_ENTERPRISE_COMPONENT
      ).length,
      highConfidenceCount: inferences.filter((item) => item.confidence === 'high').length,
      mediumConfidenceCount: inferences.filter((item) => item.confidence === 'medium').length,
      lowConfidenceCount: inferences.filter((item) => item.confidence === 'low').length,
    },
  };
}

module.exports = {
  UNKNOWN_COMPONENT_INFERRED_ROLES,
  inferUnknownEnterpriseComponents,
  inferUnknownComponent,
  isOpaqueEnterpriseName,
};
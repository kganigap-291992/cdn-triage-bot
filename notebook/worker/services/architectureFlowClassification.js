'use strict';

/**
 * BUG-22H — Flow Classification
 *
 * Classifies typed architecture relationships into semantic interaction modes,
 * flow priorities, and directionality.
 *
 * No traversal changes here.
 */

function normalize(value) {
  return String(value || '').trim();
}

function lower(value) {
  return normalize(value).toLowerCase();
}

function looksLikeEntityChain(label = '') {
  const value = normalize(label);

  if (!value) return false;

  const tokens = value.split(/\s+/).filter(Boolean);

  // Entity-chain blobs usually have 3+ noun-ish tokens and no action verb.
  if (tokens.length < 3) return false;

  const hasVerb =
    /\b(sends?|forwards?|routes?|validates?|reads?|writes?|authenticates?|delivers?|pushes?|manages?|syncs?|replicates?|publishes?|subscribes?|streams?|requests?|responds?|calls?)\b/i.test(
      value
    );

  if (hasVerb) return false;

  const capitalizedCount = tokens.filter((token) =>
    /^[A-Z][A-Za-z0-9_-]+$/.test(token)
  ).length;

  const knownArchitectureNounCount = tokens.filter((token) =>
    /^(client|cdn|edge|api|gateway|auth|service|routing|layer|application|cluster|database|cache|origin|proxy|router|worker|node|region|zone)$/i.test(
      token
    )
  ).length;

  return (
    capitalizedCount >= Math.max(2, Math.floor(tokens.length * 0.6)) ||
    knownArchitectureNounCount >= Math.max(2, Math.floor(tokens.length * 0.6))
  );
}

function classifyInteractionMode(relationship = {}) {
  const edgeType = relationship.edgeType || 'unknown';
  const label = lower(relationship.edgeLabel || '');

  // Entity chains are topology continuity, not semantic actions.
  if (looksLikeEntityChain(relationship.edgeLabel || '')) {
    return 'topology_continuity';
  }

  if (edgeType === 'observability_signal') return 'observability_signal';
  if (edgeType === 'health_signal') return 'health_signal';
  if (edgeType === 'configuration_flow') return 'configuration_flow';
  if (edgeType === 'async_event') return 'async_event';
  if (edgeType === 'replication_or_sync') return 'bidirectional_sync';
  if (edgeType === 'metadata_request') return 'metadata_lookup';
  if (edgeType === 'content_or_payload_delivery') return 'payload_delivery';

  if (
    /\b(validates? authentication|authenticate|authorization|auth service)\b/i.test(
      label
    )
  ) {
    return 'auth_validation';
  }

  if (
    /\b(manages? internal service distribution|distributes? traffic|routes? requests?)\b/i.test(
      label
    )
  ) {
    return 'traffic_distribution';
  }

  if (/\b(reads? and writes?|sync|synchroni[sz]e|replicat|mirror)\b/i.test(label)) {
    return 'bidirectional_sync';
  }

  if (
    /\b(request|response|sends?|forwards?|routes?|delivers?|calls?)\b/i.test(
      label
    )
  ) {
    return 'request_response';
  }

  return 'unknown';
}

function classifyFlowPriority(relationship = {}) {
  const interactionMode = classifyInteractionMode(relationship);

  if (
    interactionMode === 'observability_signal' ||
    interactionMode === 'health_signal'
  ) {
    return 'background';
  }

  if (
    interactionMode === 'configuration_flow' ||
    interactionMode === 'bidirectional_sync' ||
    interactionMode === 'auth_validation' ||
    interactionMode === 'topology_continuity'
  ) {
    return 'supporting';
  }

  if (
    interactionMode === 'metadata_lookup' ||
    interactionMode === 'payload_delivery' ||
    interactionMode === 'request_response' ||
    interactionMode === 'traffic_distribution'
  ) {
    return 'primary';
  }

  return 'unknown';
}

function inferDirectionality(relationship = {}) {
  const label = lower(relationship.edgeLabel || '');
  const mode = relationship.interactionMode || '';
  const edgeType = relationship.edgeType || '';

  if (mode === 'topology_continuity') {
    return 'topology_inferred';
  }

  if (
    mode === 'bidirectional_sync' ||
    edgeType === 'replication_or_sync' ||
    /\b(reads? and writes?|sync|synchroni[sz]e|replicat|mirror)\b/i.test(label)
  ) {
    return 'bidirectional';
  }

  if (/\b(request|response)\b/i.test(label) || mode === 'request_response') {
    return 'duplex_request_response';
  }

  if (
    mode === 'observability_signal' ||
    mode === 'health_signal' ||
    mode === 'configuration_flow'
  ) {
    return 'one_way_signal';
  }

  return 'directed';
}

function classifyArchitectureRelationshipFlow(relationship = {}) {
  const interactionMode = classifyInteractionMode(relationship);
  const flowPriority = classifyFlowPriority({
    ...relationship,
    interactionMode,
  });
  const directionality = inferDirectionality({
    ...relationship,
    interactionMode,
  });

  return {
    ...relationship,
    interactionMode,
    flowPriority,
    directionality,
    flowClassification: {
      version: 'architecture-flow-classification-v1',
      source: 'architectureFlowClassification',
      notes: [
        interactionMode === 'unknown'
          ? 'no_interaction_mode_found'
          : 'classified_from_edge_type_and_label',
      ],
    },
  };
}

function classifyArchitectureRelationshipFlows(relationships = []) {
  if (!Array.isArray(relationships)) return [];

  return relationships.map(classifyArchitectureRelationshipFlow);
}

module.exports = {
  classifyInteractionMode,
  classifyFlowPriority,
  inferDirectionality,
  classifyArchitectureRelationshipFlow,
  classifyArchitectureRelationshipFlows,
  looksLikeEntityChain,
};
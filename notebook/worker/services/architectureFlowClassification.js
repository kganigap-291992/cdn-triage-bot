'use strict';

/**
 * BUG-22U.1A — Flow Classification
 *
 * Interprets typed architecture relationships into semantic interaction modes,
 * flow priorities, and directionality.
 *
 * EdgeTyping owns detection/tagging.
 * FlowClassification owns interpretation/scoring.
 *
 * No traversal changes here.
 */

function normalize(value) {
  return String(value || '').trim();
}

function lower(value) {
  return normalize(value).toLowerCase();
}

function getRelationshipSearchText(relationship = {}) {
  return lower(
    [
      relationship.edgeLabel,
      relationship.label,
      relationship.evidenceText,
      relationship.rawText,
      relationship.text,
      relationship.evidence,
      relationship.reason,
      relationship.type,
      relationship.direction,
      relationship.sourceName,
      relationship.targetName,
      relationship.from,
      relationship.to,
    ]
      .filter(Boolean)
      .join(' ')
  );
}

function looksLikeEntityChain(label = '') {
  const value = normalize(label);

  if (!value) return false;

  const tokens = value.split(/\s+/).filter(Boolean);

  // Entity-chain blobs usually have 3+ noun-ish tokens and no action verb.
  if (tokens.length < 3) return false;

  const hasVerb =
    /\b(sends?|forwards?|routes?|validates?|reads?|writes?|authenticates?|authorizes?|delivers?|pushes?|pulls?|manages?|syncs?|replicates?|publishes?|subscribes?|streams?|requests?|responds?|calls?|reports?|emits?|collects?|monitors?|configures?|controls?|redirects?|resolves?|fails?|fallbacks?|mirrors?|branches?|joins?|broadcasts?)\b/i.test(
      value
    );

  if (hasVerb) return false;

  const capitalizedCount = tokens.filter((token) =>
    /^[A-Z][A-Za-z0-9_-]+$/.test(token)
  ).length;

  const knownArchitectureNounCount = tokens.filter((token) =>
    /^(client|cdn|edge|api|gateway|auth|service|routing|layer|application|cluster|database|cache|origin|proxy|router|worker|node|region|zone|queue|topic|bus|stream|monitor|metrics|controller|control|plane)$/i.test(
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
  const searchText = getRelationshipSearchText(relationship);
  const lineStyle = relationship.lineStyle || relationship.edgeStyle || '';

  if (relationship.mappedInteractionMode) {
    return relationship.mappedInteractionMode;
  }

  // Entity chains are topology continuity, not semantic actions.
  if (looksLikeEntityChain(relationship.edgeLabel || '')) {
    return 'topology_continuity';
  }

  // Strong edge typing wins first.
  if (edgeType === 'observability_signal') return 'observability_signal';
  if (edgeType === 'health_signal') return 'health_signal';

  if (edgeType === 'control_flow') {
    if (
      /\b(auth|authentication|authorization|authorize|validates?|policy check|access check|token|credential)\b/i.test(
        searchText
      )
    ) {
      return 'auth_validation';
    }

    return 'configuration_flow';
  }

  if (edgeType === 'configuration_flow') return 'configuration_flow';
  if (edgeType === 'async_event') return 'async_event';
  if (edgeType === 'replication_or_sync') return 'bidirectional_sync';
  if (edgeType === 'metadata_request') return 'metadata_lookup';
  if (edgeType === 'content_or_payload_delivery') return 'payload_delivery';
  if (edgeType === 'failure_or_fallback') return 'failure_or_fallback';
  if (edgeType === 'dependency') return 'dependency';
  if (edgeType === 'management_relationship') return 'management_relationship';
  if (edgeType === 'workflow_transition') return 'workflow_transition';

  // OpenTelemetry-style signals: request, response, dependency, async, telemetry.
  if (
    /\b(metrics?|telemetry|monitoring|observability|logs?|traces?|spans?|health|reports?|emits?|collects?)\b/i.test(
      searchText
    )
  ) {
    return 'observability_signal';
  }

  if (
    /\b(health\s*check|heartbeat|liveness|readiness|probe|status\s*check)\b/i.test(
      searchText
    )
  ) {
    return 'health_signal';
  }

  if (
    /\b(auth|authentication|authorization|authorize|validates?|policy check|access check|token|credential)\b/i.test(
      searchText
    )
  ) {
    return 'auth_validation';
  }

  if (
    /\b(config|configuration|control plane|policy|rules?|settings?|manages? config|pushes? config|controls?|admin|management|orchestrates?|governs?)\b/i.test(
      searchText
    )
  ) {
    if (/\b(management|admin|governs?|orchestrates?)\b/i.test(searchText)) {
      return 'management_relationship';
    }

    return 'configuration_flow';
  }

  if (
    /\b(failover|fallback|fail\s*over|backup|standby|secondary|disaster recovery|dr|redirects? on failure|fallbacks?)\b/i.test(
      searchText
    )
  ) {
    return 'failure_or_fallback';
  }

  // BPMN-style flow patterns: gateway, branch, join, broadcast, workflow.
  if (
    /\b(fan[-\s]?out|fans?\s+out|branches?|splits?|parallel branch|scatter|distributes? to multiple|one[-\s]?to[-\s]?many)\b/i.test(
      searchText
    )
  ) {
    return 'fan_out';
  }

  if (
    /\b(fan[-\s]?in|joins?|merges?|aggregates?|many[-\s]?to[-\s]?one|gathers?)\b/i.test(
      searchText
    )
  ) {
    return 'fan_in';
  }

  if (
    /\b(broadcasts?|publishes? to all|multicast|notify all|notifies all)\b/i.test(
      searchText
    )
  ) {
    return 'broadcast';
  }

  if (
    /\b(workflow|transition|state change|step transition|handoff|approval|event flow|message flow)\b/i.test(
      searchText
    )
  ) {
    return 'workflow_transition';
  }

  if (
    /\b(region|cross[-\s]?region|multi[-\s]?region|active[-\s]?active|active[-\s]?passive|datacenter|data center|dc|availability zone|az)\b/i.test(
      searchText
    )
  ) {
    return 'cross_region_transition';
  }

  if (
    /\b(parallel primary|primary rail|primary path|mirrored path|duplicated architecture|same path in another region)\b/i.test(
      searchText
    )
  ) {
    return 'parallel_primary_flow';
  }

  if (
    /\b(request|response|sends?|forwards?|routes?|delivers?|calls?|invokes?)\b/i.test(
      searchText
    )
  ) {
    return 'request_response';
  }

  if (
    /\b(cache|cdn|edge cache|payload|content|object|asset|manifest|deliver|delivery)\b/i.test(
      searchText
    )
  ) {
    return 'payload_delivery';
  }

  if (
    /\b(manages? internal service distribution|distributes? traffic|routes? requests?|load balances?|load[-\s]?balanc(?:e|es|ing))\b/i.test(
      searchText
    )
  ) {
    return 'traffic_distribution';
  }

  if (
    /\b(reads? and writes?|sync|synchroni[sz]e|replicat|mirror|two[-\s]?way|bidirectional|bi[-\s]?directional)\b/i.test(
      searchText
    )
  ) {
    return 'bidirectional_sync';
  }

  if (
    /\b(async|asynchronous|event|queue|topic|stream|publish|subscribe|pubsub|pub\/sub|message bus)\b/i.test(
      searchText
    )
  ) {
    return 'async_event';
  }

  if (
    /\b(metadata|lookup|resolve|resolution|catalog|registry)\b/i.test(
      searchText
    )
  ) {
    return 'metadata_lookup';
  }

  // Mermaid-style line semantics. Style modifies meaning; it does not create
  // primary traversal by itself.
  if (lineStyle === 'dotted_line') {
    return 'dependency';
  }

  if (lineStyle === 'dashed_line') {
    return 'dependency';
  }

  if (lineStyle === 'double_line') {
    return 'bidirectional_sync';
  }

  return 'unknown_interaction';
}

function classifyFlowPriority(relationship = {}) {
  if (relationship.mappedFlowPriority) {
    return relationship.mappedFlowPriority;
  }

  const interactionMode =
    relationship.interactionMode || classifyInteractionMode(relationship);

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
    interactionMode === 'async_event' ||
    interactionMode === 'topology_continuity' ||
    interactionMode === 'failure_or_fallback' ||
    interactionMode === 'dependency' ||
    interactionMode === 'management_relationship' ||
    interactionMode === 'workflow_transition' ||
    interactionMode === 'fan_out' ||
    interactionMode === 'fan_in' ||
    interactionMode === 'broadcast' ||
    interactionMode === 'cross_region_transition' ||
    interactionMode === 'parallel_primary_flow' ||
    interactionMode === 'unknown_interaction'
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

  return 'supporting';
}

function inferDirectionality(relationship = {}) {
  const label = lower(relationship.edgeLabel || '');
  const searchText = getRelationshipSearchText(relationship);
  const mode = relationship.interactionMode || '';
  const edgeType = relationship.edgeType || '';

  if (mode === 'topology_continuity') {
    return 'topology_inferred';
  }

  if (
    mode === 'bidirectional_sync' ||
    edgeType === 'replication_or_sync' ||
    /\b(reads? and writes?|sync|synchroni[sz]e|replicat|mirror|two[-\s]?way|bidirectional|bi[-\s]?directional)\b/i.test(
      searchText
    )
  ) {
    return 'bidirectional';
  }

  if (
    mode === 'fan_out' ||
    mode === 'broadcast' ||
    /\b(fan[-\s]?out|broadcasts?|one[-\s]?to[-\s]?many)\b/i.test(searchText)
  ) {
    return 'one_to_many';
  }

  if (
    mode === 'fan_in' ||
    /\b(fan[-\s]?in|many[-\s]?to[-\s]?one|joins?|merges?|aggregates?)\b/i.test(
      searchText
    )
  ) {
    return 'many_to_one';
  }

  if (/\b(request|response)\b/i.test(label) || mode === 'request_response') {
    return 'duplex_request_response';
  }

  if (
    mode === 'observability_signal' ||
    mode === 'health_signal' ||
    mode === 'configuration_flow' ||
    mode === 'management_relationship'
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
      version: 'architecture-flow-classification-v2-enterprise-arrow-taxonomy',
      source: 'architectureFlowClassification',
      lineStyle: relationship.lineStyle || relationship.edgeStyle || '',
      mappedInteractionMode: relationship.mappedInteractionMode || null,
      mappedFlowPriority: relationship.mappedFlowPriority || null,
      mappedEvidenceSource: relationship.mappedEvidenceSource || null,
      mappedConfidence: relationship.mappedConfidence || null,
      mappedReason: relationship.mappedReason || null,
      notes: [
        interactionMode === 'unknown_interaction'
          ? 'no_interaction_mode_found_defaulted_to_unknown_interaction'
          : 'classified_from_edge_type_label_and_line_style',
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
  getRelationshipSearchText,
};
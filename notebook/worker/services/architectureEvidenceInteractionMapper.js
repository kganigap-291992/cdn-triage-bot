'use strict';

/**
 * BUG-22U.1E — Legend + Glossary Semantics
 *
 * Converts document evidence into interaction hints and records why the
 * interaction was trusted.
 *
 * Ownership:
 * - EvidenceExtractor extracts glossary/legend/boundary/internal/public evidence.
 * - EdgeTyping detects edgeType, edgeLabel, lineStyle.
 * - EvidenceInteractionMapper maps evidence + edge signals into likely interaction meaning.
 * - EvidenceInteractionMapper emits confidence attribution and consensus metadata.
 * - FlowClassification still owns final interactionMode / priority / directionality.
 *
 * Precedence:
 * 1. Legend
 * 2. Glossary
 * 3. Arrow Label
 * 4. Line Style
 * 5. Heuristic
 *
 * Borrowed ideas:
 * - OpenTelemetry: request/response, dependency, async, telemetry.
 * - BPMN: fan-out, fan-in, broadcast, workflow transition.
 * - Mermaid: line-style semantics and legend-defined edge meaning.
 *
 * No traversal changes here.
 * No LLM here.
 */

const DEFAULT_RESULT = Object.freeze({
  mappedInteractionMode: null,
  mappedFlowPriority: null,
  mappedEvidenceSource: 'none',
  mappedConfidence: 'low',
  mappedReason: 'no_evidence_mapping_found',
  mappedEvidence: [],

  evidenceStrength: 'weak',
  attributionSources: [],
  attributionReasons: [],
  supportingEvidence: [],

  consensus: 'no_evidence',
  supportingSources: [],
  conflictingSources: [],
  conflictCount: 0,
  demotionApplied: false,
});

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function lower(value) {
  return cleanText(value).toLowerCase();
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeStyle(value) {
  const text = lower(value);

  if (!text) return 'unknown_line_style';

  if (
    text === 'dotted_line' ||
    text === 'dotted' ||
    text === 'dot_line' ||
    text.includes('dotted')
  ) {
    return 'dotted_line';
  }

  if (
    text === 'dashed_line' ||
    text === 'dashed' ||
    text === 'dash_line' ||
    text.includes('dashed')
  ) {
    return 'dashed_line';
  }

  if (
    text === 'solid_line' ||
    text === 'solid' ||
    text === 'solidline' ||
    text.includes('solid')
  ) {
    return 'solid_line';
  }

  if (
    text === 'double_line' ||
    text === 'double' ||
    text === 'doubleline' ||
    text.includes('double')
  ) {
    return 'double_line';
  }

  return 'unknown_line_style';
}

function inferInteractionFromText(text = '') {
  const value = lower(text);

  if (!value) return null;

  if (
    /\b(metrics?|telemetry|monitoring|observability|logs?|traces?|spans?|reports?|emits?|collects?)\b/.test(
      value
    )
  ) {
    return {
      interactionMode: 'observability_signal',
      flowPriority: 'background',
      reason: 'text_indicates_observability',
    };
  }

  if (
    /\b(health\s*check|heartbeat|liveness|readiness|probe|status\s*check)\b/.test(
      value
    )
  ) {
    return {
      interactionMode: 'health_signal',
      flowPriority: 'background',
      reason: 'text_indicates_health_signal',
    };
  }

  if (
    /\b(auth|authentication|authorization|authorize|validates?|verifies?|access check|policy check|token|credential)\b/.test(
      value
    )
  ) {
    return {
      interactionMode: 'auth_validation',
      flowPriority: 'supporting',
      reason: 'text_indicates_auth_validation',
    };
  }

  if (
    /\b(failover|fallback|fail\s*over|backup|standby|secondary|disaster recovery|dr|redirects? on failure|fallbacks?)\b/.test(
      value
    )
  ) {
    return {
      interactionMode: 'failure_or_fallback',
      flowPriority: 'supporting',
      reason: 'text_indicates_failure_or_fallback',
    };
  }

  if (
    /\b(config|configuration|control plane|policy|rules?|settings?|pushes? config|manages? config|controls?|admin|management|orchestrates?|governs?)\b/.test(
      value
    )
  ) {
    if (/\b(management|admin|orchestrates?|governs?)\b/.test(value)) {
      return {
        interactionMode: 'management_relationship',
        flowPriority: 'supporting',
        reason: 'text_indicates_management_relationship',
      };
    }

    return {
      interactionMode: 'configuration_flow',
      flowPriority: 'supporting',
      reason: 'text_indicates_configuration_flow',
    };
  }

  if (
    /\b(fan[-\s]?out|fans?\s+out|branches?|splits?|parallel branch|scatter|distributes? to multiple|one[-\s]?to[-\s]?many)\b/.test(
      value
    )
  ) {
    return {
      interactionMode: 'fan_out',
      flowPriority: 'supporting',
      reason: 'text_indicates_fan_out',
    };
  }

  if (
    /\b(fan[-\s]?in|joins?|merges?|aggregates?|many[-\s]?to[-\s]?one|gathers?)\b/.test(
      value
    )
  ) {
    return {
      interactionMode: 'fan_in',
      flowPriority: 'supporting',
      reason: 'text_indicates_fan_in',
    };
  }

  if (
    /\b(broadcasts?|publishes? to all|multicast|notify all|notifies all)\b/.test(
      value
    )
  ) {
    return {
      interactionMode: 'broadcast',
      flowPriority: 'supporting',
      reason: 'text_indicates_broadcast',
    };
  }

  if (
    /\b(workflow|transition|state change|step transition|handoff|approval|event flow|message flow)\b/.test(
      value
    )
  ) {
    return {
      interactionMode: 'workflow_transition',
      flowPriority: 'supporting',
      reason: 'text_indicates_workflow_transition',
    };
  }

  if (
    /\b(region|cross[-\s]?region|multi[-\s]?region|active[-\s]?active|active[-\s]?passive|datacenter|data center|availability zone|az)\b/.test(
      value
    )
  ) {
    return {
      interactionMode: 'cross_region_transition',
      flowPriority: 'supporting',
      reason: 'text_indicates_cross_region_transition',
    };
  }

  if (
    /\b(parallel primary|primary rail|primary path|mirrored path|duplicated architecture|same path in another region)\b/.test(
      value
    )
  ) {
    return {
      interactionMode: 'parallel_primary_flow',
      flowPriority: 'supporting',
      reason: 'text_indicates_parallel_primary_flow',
    };
  }

  if (
    /\b(async|asynchronous|event|queue|topic|stream|publish|subscribe|pubsub|pub\/sub|message bus)\b/.test(
      value
    )
  ) {
    return {
      interactionMode: 'async_event',
      flowPriority: 'supporting',
      reason: 'text_indicates_async_event',
    };
  }

  if (
    /\b(reads? and writes?|sync|synchroni[sz]e|replicat|mirror|two[-\s]?way|bidirectional|bi[-\s]?directional)\b/.test(
      value
    )
  ) {
    return {
      interactionMode: 'bidirectional_sync',
      flowPriority: 'supporting',
      reason: 'text_indicates_bidirectional_sync',
    };
  }

  if (
    /\b(metadata|lookup|resolve|resolution|catalog|registry)\b/.test(value)
  ) {
    return {
      interactionMode: 'metadata_lookup',
      flowPriority: 'primary',
      reason: 'text_indicates_metadata_lookup',
    };
  }

  if (
    /\b(manages? internal service distribution|distributes? traffic|routes? requests?|load balances?|load[-\s]?balanc(?:e|es|ing))\b/.test(
      value
    )
  ) {
    return {
      interactionMode: 'traffic_distribution',
      flowPriority: 'primary',
      reason: 'text_indicates_traffic_distribution',
    };
  }

  if (
    /\b(request|response|sends?|forwards?|routes?|delivers?|calls?|invokes?)\b/.test(
      value
    )
  ) {
    return {
      interactionMode: 'request_response',
      flowPriority: 'primary',
      reason: 'text_indicates_request_response',
    };
  }

  if (
    /\b(cache|cdn|edge cache|payload|content|object|asset|manifest|deliver|delivery)\b/.test(
      value
    )
  ) {
    return {
      interactionMode: 'payload_delivery',
      flowPriority: 'primary',
      reason: 'text_indicates_payload_delivery',
    };
  }

  return null;
}

function inferInteractionFromLineStyle(lineStyle, text = '') {
  const normalizedStyle = normalizeStyle(lineStyle);
  const textMapping = inferInteractionFromText(text);

  if (normalizedStyle === 'unknown_line_style') return null;

  if (textMapping) {
    return {
      ...textMapping,
      reason: `line_style_${normalizedStyle}_with_${textMapping.reason}`,
    };
  }

  if (normalizedStyle === 'dotted_line') {
    return {
      interactionMode: 'dependency',
      flowPriority: 'supporting',
      reason: 'dotted_line_without_stronger_text_defaults_to_dependency',
    };
  }

  if (normalizedStyle === 'dashed_line') {
    return {
      interactionMode: 'dependency',
      flowPriority: 'supporting',
      reason: 'dashed_line_without_stronger_text_defaults_to_dependency',
    };
  }

  if (normalizedStyle === 'double_line') {
    return {
      interactionMode: 'bidirectional_sync',
      flowPriority: 'supporting',
      reason: 'double_line_defaults_to_bidirectional_sync',
    };
  }

  if (normalizedStyle === 'solid_line') {
    return null;
  }

  return null;
}

function findLegendMappingForLineStyle(lineStyle, architectureEvidence = {}) {
  const normalizedStyle = normalizeStyle(lineStyle);

  if (normalizedStyle === 'unknown_line_style') return null;

  const legendItems = asArray(architectureEvidence.legendItems);

  for (const item of legendItems) {
    const legendStyle = normalizeStyle(item.visualStyle || item.lineStyle);
    if (legendStyle !== normalizedStyle) continue;

    const text = cleanText(
      [
        item.rawText,
        item.meaning,
        item.label,
        item.inferredEdgeType,
      ]
        .filter(Boolean)
        .join(' ')
    );

    const textMapping = inferInteractionFromText(text);

    if (textMapping) {
      return {
        ...textMapping,
        sourceItem: item,
        reason: `legend_maps_${normalizedStyle}_to_${textMapping.interactionMode}`,
      };
    }

    if (item.inferredEdgeType && item.inferredEdgeType !== 'unknown') {
      return {
        interactionMode: edgeTypeToInteractionMode(item.inferredEdgeType),
        flowPriority: 'supporting',
        sourceItem: item,
        reason: `legend_inferred_edge_type_${item.inferredEdgeType}`,
      };
    }
  }

  return null;
}

function findGlossaryMappingForRelationship(relationship = {}, architectureEvidence = {}) {
  const glossaryTerms = asArray(architectureEvidence.glossaryTerms);

  if (!glossaryTerms.length) return null;

  const relationshipText = lower(
    [
      relationship.edgeLabel,
      relationship.label,
      relationship.evidenceText,
      relationship.rawText,
      relationship.text,
      relationship.evidence,
      relationship.sourceName,
      relationship.targetName,
      relationship.from,
      relationship.to,
    ]
      .filter(Boolean)
      .join(' ')
  );

  if (!relationshipText) return null;

  for (const item of glossaryTerms) {
    const term = lower(item.term);
    const meaning = cleanText(item.meaning);

    if (!term || !meaning) continue;

    const termPattern = new RegExp(`\\b${escapeRegExp(term)}\\b`, 'i');

    if (!termPattern.test(relationshipText)) continue;

    const textMapping = inferInteractionFromText(`${item.term} ${meaning}`);

    if (!textMapping) continue;

    return {
      ...textMapping,
      sourceItem: item,
      reason: `glossary_maps_${item.term}_to_${textMapping.interactionMode}`,
    };
  }

  return null;
}

function edgeTypeToInteractionMode(edgeType = '') {
  switch (edgeType) {
    case 'observability_signal':
      return 'observability_signal';
    case 'health_signal':
      return 'health_signal';
    case 'configuration_flow':
      return 'configuration_flow';
    case 'control_flow':
      return 'configuration_flow';
    case 'async_event':
      return 'async_event';
    case 'replication_or_sync':
      return 'bidirectional_sync';
    case 'metadata_request':
      return 'metadata_lookup';
    case 'content_or_payload_delivery':
      return 'payload_delivery';
    case 'failure_or_fallback':
      return 'failure_or_fallback';
    case 'dependency':
      return 'dependency';
    case 'management_relationship':
      return 'management_relationship';
    case 'workflow_transition':
      return 'workflow_transition';
    case 'request_response':
      return 'request_response';
    default:
      return 'unknown_interaction';
  }
}

function evidenceSourceWeight(source) {
  switch (source) {
    case 'legend':
      return 100;
    case 'glossary':
      return 90;
    case 'arrow_label':
      return 80;
    case 'line_style':
      return 70;
    case 'boundary':
      return 50;
    case 'heuristic':
      return 30;
    default:
      return 0;
  }
}

function evidenceStrength(source) {
  switch (source) {
    case 'legend':
    case 'glossary':
      return 'strong';

    case 'arrow_label':
    case 'line_style':
      return 'moderate';

    case 'heuristic':
    case 'none':
    default:
      return 'weak';
  }
}

function buildConsensusMetadata(ranked = []) {
  if (!ranked.length) {
    return {
      consensus: 'no_evidence',
      supportingSources: [],
      conflictingSources: [],
      conflictCount: 0,
      demotionApplied: false,
    };
  }

  const winner = ranked[0];
  const winnerMode = winner.mappedInteractionMode;

  const supporting = ranked.filter(
    (item) => item.mappedInteractionMode === winnerMode
  );

  const conflicting = ranked.filter(
    (item) => item.mappedInteractionMode !== winnerMode
  );

  const hasConflict = conflicting.length > 0;

  return {
    consensus: hasConflict ? 'contested' : 'agreed',
    supportingSources: supporting
      .map((item) => item.mappedEvidenceSource)
      .filter(Boolean),
    conflictingSources: conflicting
      .map((item) => item.mappedEvidenceSource)
      .filter(Boolean),
    conflictCount: conflicting.length,
    demotionApplied: hasConflict,
  };
}

function chooseBestMapping(candidates = []) {
  const valid = candidates.filter(Boolean);

  if (!valid.length) {
    return { ...DEFAULT_RESULT };
  }

  const ranked = [...valid].sort((a, b) => {
    const sourceDelta =
      evidenceSourceWeight(b.mappedEvidenceSource) -
      evidenceSourceWeight(a.mappedEvidenceSource);

    if (sourceDelta !== 0) return sourceDelta;

    const confidenceDelta =
      confidenceWeight(b.mappedConfidence) -
      confidenceWeight(a.mappedConfidence);

    return confidenceDelta;
  });

  const winner = ranked[0];
  const consensusMetadata = buildConsensusMetadata(ranked);
  const finalConfidence = consensusMetadata.demotionApplied
    ? demoteConfidence(winner.mappedConfidence)
    : winner.mappedConfidence;

  return {
    ...winner,
    mappedConfidence: finalConfidence,

    attributionSources: ranked
      .map((item) => item.mappedEvidenceSource)
      .filter(Boolean),
    attributionReasons: ranked
      .map((item) => item.mappedReason)
      .filter(Boolean),
    supportingEvidence: ranked.flatMap((item) => item.mappedEvidence || []),

    ...consensusMetadata,
  };
}

function confidenceWeight(confidence) {
  switch (confidence) {
    case 'deterministic':
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

function demoteConfidence(confidence) {
  switch (confidence) {
    case 'deterministic':
    case 'high':
      return 'medium';
    case 'medium':
      return 'low';
    case 'low':
    default:
      return 'low';
  }
}

function createCandidate({
  mapping,
  source,
  confidence,
  reason,
  evidence,
}) {
  if (!mapping?.interactionMode) return null;

  const mappedReason = reason || mapping.reason || 'mapped_from_evidence';

  return {
    mappedInteractionMode: mapping.interactionMode,
    mappedFlowPriority: mapping.flowPriority || null,
    mappedEvidenceSource: source,
    mappedConfidence: confidence,
    mappedReason,
    mappedEvidence: evidence ? [evidence] : [],

    evidenceStrength: evidenceStrength(source),
    attributionSources: [source],
    attributionReasons: [mappedReason],
    supportingEvidence: evidence ? [evidence] : [],
  };
}

function mapArchitectureRelationshipEvidence(
  relationship = {},
  architectureEvidence = {}
) {
  const lineStyle = relationship.lineStyle || relationship.edgeStyle;
  const labelText = cleanText(
    [
      relationship.edgeLabel,
      relationship.label,
      relationship.evidenceText,
      relationship.rawText,
      relationship.text,
      relationship.evidence,
    ]
      .filter(Boolean)
      .join(' ')
  );

  const legendMapping = findLegendMappingForLineStyle(
    lineStyle,
    architectureEvidence
  );

  const glossaryMapping = findGlossaryMappingForRelationship(
    relationship,
    architectureEvidence
  );

  const arrowLabelMapping = inferInteractionFromText(
    relationship.edgeLabel || relationship.label || ''
  );

  const lineStyleMapping = inferInteractionFromLineStyle(
    lineStyle,
    labelText
  );

  const heuristicMapping = inferInteractionFromText(labelText);

  return chooseBestMapping([
    createCandidate({
      mapping: legendMapping,
      source: 'legend',
      confidence: legendMapping ? 'high' : 'low',
      reason: legendMapping?.reason,
      evidence: legendMapping?.sourceItem || null,
    }),
    createCandidate({
      mapping: glossaryMapping,
      source: 'glossary',
      confidence: glossaryMapping ? 'high' : 'low',
      reason: glossaryMapping?.reason,
      evidence: glossaryMapping?.sourceItem || null,
    }),
    createCandidate({
      mapping: arrowLabelMapping,
      source: 'arrow_label',
      confidence: arrowLabelMapping ? 'high' : 'low',
      reason: arrowLabelMapping?.reason,
      evidence: relationship.edgeLabel || relationship.label || null,
    }),
    createCandidate({
      mapping: lineStyleMapping,
      source: 'line_style',
      confidence:
        relationship.lineStyleConfidence ||
        (lineStyleMapping ? 'medium' : 'low'),
      reason: lineStyleMapping?.reason,
      evidence: {
        lineStyle,
        lineStyleEvidence: relationship.lineStyleEvidence || [],
      },
    }),
    createCandidate({
      mapping: heuristicMapping,
      source: 'heuristic',
      confidence: heuristicMapping ? 'medium' : 'low',
      reason: heuristicMapping?.reason,
      evidence: labelText || null,
    }),
  ]);
}

function mapArchitectureRelationshipsEvidence(
  relationships = [],
  architectureEvidence = {}
) {
  if (!Array.isArray(relationships)) return [];

  return relationships.map((relationship) => {
    const mapping = mapArchitectureRelationshipEvidence(
      relationship,
      architectureEvidence
    );

    return {
      ...relationship,
      evidenceInteraction: {
        version: 'architecture-evidence-interaction-mapper-v4-legend-glossary-semantics',
        ...mapping,
      },

      mappedInteractionMode:
        mapping.mappedInteractionMode || relationship.mappedInteractionMode,

      mappedFlowPriority:
        mapping.mappedFlowPriority || relationship.mappedFlowPriority,

      mappedEvidenceSource:
        mapping.mappedEvidenceSource || relationship.mappedEvidenceSource,

      mappedConfidence:
        mapping.mappedConfidence || relationship.mappedConfidence,

      mappedReason:
        mapping.mappedReason || relationship.mappedReason,
    };
  });
}

module.exports = {
  mapArchitectureRelationshipEvidence,
  mapArchitectureRelationshipsEvidence,
  inferInteractionFromText,
  inferInteractionFromLineStyle,
  findLegendMappingForLineStyle,
  findGlossaryMappingForRelationship,
  normalizeStyle,
  edgeTypeToInteractionMode,
  evidenceStrength,
  demoteConfidence,
};
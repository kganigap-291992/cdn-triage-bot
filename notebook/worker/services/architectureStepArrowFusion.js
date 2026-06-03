'use strict';

/**
 * BUG-22U.4 — Step + Arrow Fusion
 *
 * Fuses explicit ordered/numbered steps with deterministic architecture
 * relationships.
 *
 * Ownership:
 * - architectureUnderstandingBuilder owns extraction of sequences/relationships.
 * - architectureStepArrowFusion owns evidence fusion only.
 * - architectureFlowBuilder consumes fused truth later.
 *
 * Borrowed ideas:
 * - BPMN sequence flow: ordered steps reinforce directed handoffs.
 * - Process mining: event order strengthens causal edges.
 * - OpenTelemetry causal chains: step evidence can support request/response paths.
 *
 * No traversal selection here.
 * No narration here.
 * No LLM here.
 */

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function lower(value) {
  return cleanText(value).toLowerCase();
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeKey(value) {
  return lower(value)
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function containsName(text, name) {
  const t = lower(text);
  const n = lower(name);

  if (!t || !n) return false;

  return (
    t.includes(n) ||
    normalizeKey(t).includes(normalizeKey(n))
  );
}

function inferStepInteractionMode(text = '') {
  const value = lower(text);

  if (!value) return null;

  if (/\b(auth|authentication|authorization|authorize|validates?|verifies?|access check|policy check|token|credential)\b/.test(value)) {
    return 'auth_validation';
  }

  if (/\b(metrics?|telemetry|monitoring|observability|logs?|traces?|spans?|reports?|emits?|collects?)\b/.test(value)) {
    return 'observability_signal';
  }

  if (/\b(config|configuration|control plane|policy|rules?|settings?|pushes? config|manages? config|controls?|admin|management|orchestrates?|governs?)\b/.test(value)) {
    return 'configuration_flow';
  }

  if (/\b(failover|fallback|backup|standby|secondary|disaster recovery|dr)\b/.test(value)) {
    return 'failure_or_fallback';
  }

  if (/\b(reads? and writes?|sync|synchroni[sz]e|replicat|mirror|bidirectional|two[-\s]?way)\b/.test(value)) {
    return 'bidirectional_sync';
  }

  if (/\b(manages? internal service distribution|distributes? traffic|routes? requests?|load balances?|load[-\s]?balanc(?:e|es|ing))\b/.test(value)) {
    return 'traffic_distribution';
  }

  if (/\b(cache|cdn|edge cache|payload|content|object|asset|manifest|deliver|delivery|cache miss|cache hit)\b/.test(value)) {
    return 'payload_delivery';
  }

  if (/\b(async|asynchronous|event|queue|topic|stream|publish|subscribe|message bus)\b/.test(value)) {
    return 'async_event';
  }

  if (/\b(request|response|sends?|forwards?|routes?|delivers?|calls?|invokes?|hands off|handoff)\b/.test(value)) {
    return 'request_response';
  }

  return null;
}

function flattenSequenceSteps(explicitSequences = []) {
  const steps = [];

  for (const sequence of asArray(explicitSequences)) {
    for (const item of asArray(sequence.items)) {
      const text = cleanText(item.text || item.rawText);

      if (!text) continue;

      steps.push({
        sequenceId: sequence.id || null,
        sequenceTitle: sequence.title || null,
        sequenceSource: sequence.source || item.sequenceSource || item.source || null,
        sequenceConfidence: sequence.confidence || 'medium',
        order: item.order ?? steps.length + 1,
        text,
        rawText: cleanText(item.rawText || item.text),
        evidenceId: item.evidenceId || null,
        page: item.page || null,
        entities: asArray(item.entities),
        inferredInteractionMode: inferStepInteractionMode(text),
      });
    }
  }

  return steps;
}

function stepMentionsRelationship(step, relationship) {
  const text = `${step.text || ''} ${step.rawText || ''}`;

  const sourceMentioned =
    containsName(text, relationship.sourceName) ||
    asArray(step.entities).some(
      (entity) =>
        entity.id === relationship.sourceId ||
        lower(entity.name) === lower(relationship.sourceName)
    );

  const targetMentioned =
    containsName(text, relationship.targetName) ||
    asArray(step.entities).some(
      (entity) =>
        entity.id === relationship.targetId ||
        lower(entity.name) === lower(relationship.targetName)
    );

  return sourceMentioned && targetMentioned;
}

function adjacentStepsSupportRelationship(currentStep, nextStep, relationship) {
  if (!currentStep || !nextStep) return false;

  const currentText = `${currentStep.text || ''} ${currentStep.rawText || ''}`;
  const nextText = `${nextStep.text || ''} ${nextStep.rawText || ''}`;

  const sourceInCurrent =
    containsName(currentText, relationship.sourceName) ||
    asArray(currentStep.entities).some(
      (entity) =>
        entity.id === relationship.sourceId ||
        lower(entity.name) === lower(relationship.sourceName)
    );

  const targetInNext =
    containsName(nextText, relationship.targetName) ||
    asArray(nextStep.entities).some(
      (entity) =>
        entity.id === relationship.targetId ||
        lower(entity.name) === lower(relationship.targetName)
    );

  return sourceInCurrent && targetInNext;
}

function modeAgreement(stepMode, relationshipMode) {
  if (!stepMode || !relationshipMode) return 'unknown';
  if (stepMode === relationshipMode) return 'agreed';

  const compatible = new Set([
    'request_response:payload_delivery',
    'payload_delivery:request_response',
    'request_response:traffic_distribution',
    'traffic_distribution:request_response',
  ]);

  return compatible.has(`${stepMode}:${relationshipMode}`)
    ? 'compatible'
    : 'contested';
}

function fusionStrengthFromMatches(matches = []) {
  if (!matches.length) return 'none';

  const hasDirect = matches.some((match) => match.matchType === 'same_step_mentions_source_and_target');
  const hasModeAgreement = matches.some(
    (match) =>
      match.modeAgreement === 'agreed' ||
      match.modeAgreement === 'compatible'
  );

  if (hasDirect && hasModeAgreement) return 'high';
  if (hasDirect) return 'medium';
  return 'low';
}

function confidenceFromFusion(strength) {
  switch (strength) {
    case 'high':
      return 'high';
    case 'medium':
      return 'medium';
    case 'low':
      return 'low';
    case 'none':
    default:
      return null;
  }
}

function buildRelationshipStepMatches(relationship = {}, steps = []) {
  const matches = [];

  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];
    const nextStep = steps[index + 1] || null;

    const directMatch = stepMentionsRelationship(step, relationship);

    if (directMatch) {
      const agreement = modeAgreement(
        step.inferredInteractionMode,
        relationship.interactionMode || relationship.mappedInteractionMode
      );

      matches.push({
        matchType: 'same_step_mentions_source_and_target',
        sequenceId: step.sequenceId,
        sequenceTitle: step.sequenceTitle,
        order: step.order,
        text: step.text,
        evidenceId: step.evidenceId,
        page: step.page,
        stepInteractionMode: step.inferredInteractionMode,
        relationshipInteractionMode:
          relationship.interactionMode || relationship.mappedInteractionMode || null,
        modeAgreement: agreement,
      });
    }

    if (
      !directMatch &&
      adjacentStepsSupportRelationship(step, nextStep, relationship)
    ) {
      const combinedText = `${step.text || ''} ${nextStep.text || ''}`;
      const stepMode =
        inferStepInteractionMode(combinedText) ||
        step.inferredInteractionMode ||
        nextStep.inferredInteractionMode;

      const agreement = modeAgreement(
        stepMode,
        relationship.interactionMode || relationship.mappedInteractionMode
      );

      matches.push({
        matchType: 'adjacent_steps_source_then_target',
        sequenceId: step.sequenceId || nextStep.sequenceId,
        sequenceTitle: step.sequenceTitle || nextStep.sequenceTitle,
        order: step.order,
        nextOrder: nextStep.order,
        text: combinedText,
        evidenceId: step.evidenceId || nextStep.evidenceId,
        page: step.page || nextStep.page,
        stepInteractionMode: stepMode,
        relationshipInteractionMode:
          relationship.interactionMode || relationship.mappedInteractionMode || null,
        modeAgreement: agreement,
      });
    }
  }

  return matches;
}

function fuseStepArrowEvidence({
  relationships = [],
  explicitSequences = [],
} = {}) {
  const steps = flattenSequenceSteps(explicitSequences);

  if (!steps.length || !Array.isArray(relationships)) {
    return {
      version: 'architecture-step-arrow-fusion-v1',
      relationships,
      stats: {
        stepCount: steps.length,
        relationshipCount: Array.isArray(relationships) ? relationships.length : 0,
        fusedRelationshipCount: 0,
      },
    };
  }

  let fusedRelationshipCount = 0;

  const fusedRelationships = relationships.map((relationship) => {
    const matches = buildRelationshipStepMatches(relationship, steps);
    const strength = fusionStrengthFromMatches(matches);
    const confidence = confidenceFromFusion(strength);

    if (matches.length) fusedRelationshipCount += 1;

    return {
      ...relationship,
      stepArrowFusion: {
        version: 'architecture-step-arrow-fusion-v1',
        stepSupported: matches.length > 0,
        stepSupportStrength: strength,
        fusionConfidence: confidence,
        fusionReason:
          matches.length > 0
            ? 'explicit_sequence_reinforces_relationship'
            : 'no_explicit_sequence_support_found',
        supportingSteps: matches,
      },
    };
  });

  return {
    version: 'architecture-step-arrow-fusion-v1',
    relationships: fusedRelationships,
    stats: {
      stepCount: steps.length,
      relationshipCount: fusedRelationships.length,
      fusedRelationshipCount,
    },
  };
}

module.exports = {
  fuseStepArrowEvidence,
  flattenSequenceSteps,
  inferStepInteractionMode,
  buildRelationshipStepMatches,
};
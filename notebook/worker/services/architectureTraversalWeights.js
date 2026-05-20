const INTERACTION_MODE_WEIGHTS = Object.freeze({
  request_response: 1.0,
  payload_delivery: 0.95,
  traffic_distribution: 0.9,
  auth_validation: 0.75,
  bidirectional_sync: 0.65,
  configuration_flow: 0.45,
  observability_signal: 0.3,
  topology_continuity: 0.2,
  unknown: 0.05,
});

const FLOW_PRIORITY_BONUS = Object.freeze({
  primary: 0.25,
  supporting: 0.08,
  background: -0.15,
  unknown: -0.25,
});

const RELATIONSHIP_PENALTIES = Object.freeze({
  emptyLabel: -0.35,
  unknownInteraction: -0.3,
  inferredOnly: -0.2,
  lowConfidence: -0.15,
  topologyContinuityNarrationRisk: -0.1,
});

const REGION_AFFINITY_BONUS = 0.12;

function clampScore(score) {
  if (!Number.isFinite(score)) return 0;
  return Math.max(0, Math.min(1.5, score));
}

function normalizeInteractionMode(mode) {
  return INTERACTION_MODE_WEIGHTS[mode] !== undefined ? mode : 'unknown';
}

function normalizeFlowPriority(priority) {
  return FLOW_PRIORITY_BONUS[priority] !== undefined ? priority : 'unknown';
}

function hasMeaningfulLabel(relationship = {}) {
  const label = String(relationship.edgeLabel || relationship.label || '').trim();
  return label.length > 0;
}

function isInferredRelationship(relationship = {}) {
  const reason = String(relationship.reason || '').toLowerCase();
  const evidenceType = String(relationship.evidenceType || '').toLowerCase();

  return (
    relationship.inferred === true ||
    reason.includes('inferred') ||
    reason.includes('continuity_repair') ||
    evidenceType.includes('inferred')
  );
}

function confidencePenalty(relationship = {}) {
  const confidence = String(relationship.confidence || '').toLowerCase();

  if (confidence === 'low') return RELATIONSHIP_PENALTIES.lowConfidence;
  if (confidence === 'unknown') return RELATIONSHIP_PENALTIES.lowConfidence;

  return 0;
}

function scoreRelationship(relationship = {}, options = {}) {
  const interactionMode = normalizeInteractionMode(relationship.interactionMode);
  const flowPriority = normalizeFlowPriority(relationship.flowPriority);

  const baseWeight = INTERACTION_MODE_WEIGHTS[interactionMode];
  const priorityBonus = FLOW_PRIORITY_BONUS[flowPriority];

  const penalties = [];

  if (!hasMeaningfulLabel(relationship)) {
    penalties.push({
      type: 'empty_label',
      value: RELATIONSHIP_PENALTIES.emptyLabel,
    });
  }

  if (interactionMode === 'unknown') {
    penalties.push({
      type: 'unknown_interaction',
      value: RELATIONSHIP_PENALTIES.unknownInteraction,
    });
  }

  if (isInferredRelationship(relationship)) {
    penalties.push({
      type: 'inferred_only',
      value: RELATIONSHIP_PENALTIES.inferredOnly,
    });
  }

  const cPenalty = confidencePenalty(relationship);
  if (cPenalty !== 0) {
    penalties.push({
      type: 'low_or_unknown_confidence',
      value: cPenalty,
    });
  }

  if (
    interactionMode === 'topology_continuity' &&
    options.narrationCandidate === true
  ) {
    penalties.push({
      type: 'topology_continuity_narration_risk',
      value: RELATIONSHIP_PENALTIES.topologyContinuityNarrationRisk,
    });
  }

  const penaltyTotal = penalties.reduce((sum, item) => sum + item.value, 0);
  const rawScore = baseWeight + priorityBonus + penaltyTotal;
  const score = clampScore(rawScore);

  return {
    score,
    rawScore,
    baseWeight,
    priorityBonus,
    penaltyTotal,
    penalties,
    interactionMode,
    flowPriority,
  };
}

function scoreRegionAffinity(sourceRegion, targetRegion) {
  if (!sourceRegion || !targetRegion) return 0;
  if (sourceRegion !== targetRegion) return 0;

  return REGION_AFFINITY_BONUS;
}

function scoreTraversalPath(relationships = []) {
  const scoredEdges = relationships.map((relationship) => ({
    relationship,
    scoring: scoreRelationship(relationship),
  }));

  const totalScore = scoredEdges.reduce(
    (sum, edge) => sum + edge.scoring.score,
    0
  );

  const averageScore =
    scoredEdges.length > 0 ? totalScore / scoredEdges.length : 0;

  return {
    totalScore,
    averageScore,
    edgeCount: scoredEdges.length,
    scoredEdges,
  };
}

module.exports = {
  INTERACTION_MODE_WEIGHTS,
  FLOW_PRIORITY_BONUS,
  RELATIONSHIP_PENALTIES,
  REGION_AFFINITY_BONUS,
  scoreRelationship,
  scoreTraversalPath,
  scoreRegionAffinity,
};
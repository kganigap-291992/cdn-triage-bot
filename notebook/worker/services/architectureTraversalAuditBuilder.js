function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function safeNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function buildArchitectureTraversalAudit({
  traversalModeMetadata = {},
  traversalModeSelectionContract = {},
  traversalPreferenceDebug = null,
  regionTraversalDebug = null,
} = {}) {
  const preferenceUnits = asArray(traversalPreferenceDebug?.units);
  const regionUnits = asArray(regionTraversalDebug?.units);

  const changedOrderCount = preferenceUnits.filter((unit) => {
    return safeNumber(unit.originalIndex) !== safeNumber(unit.index);
  }).length;

  const continuityPenaltyCount = preferenceUnits.filter((unit) => {
    return safeNumber(unit.continuityPenalty) > 0;
  }).length;

  return {
    version: "architecture-traversal-audit-v1",
    source: "architectureTraversalAuditBuilder",
    selectedTraversalMode: traversalModeMetadata.selectedTraversalMode || null,
    selectedTraversalModeLabel:
      traversalModeMetadata.selectedTraversalModeLabel || null,
    selectionEnabled: Boolean(traversalModeSelectionContract.selectionEnabled),
    selectionSource:
      traversalModeSelectionContract.currentSelectionSource ||
      "hardcoded_default",

    executionSummary: {
      modeSelectionExecuted: false,
      heuristicSelectionExecuted: false,
      llmSelectionExecuted: false,
      traversalModeChangedOrder: changedOrderCount > 0,
      changedOrderCount,
      preferenceBiasApplied: Boolean(traversalPreferenceDebug?.preferenceApplied),
      continuityGuardApplied: Boolean(traversalPreferenceDebug?.continuityAware),
      continuityPenaltyCount,
      regionTraversalApplied: Boolean(regionTraversalDebug),
      regionContinuityBreakCount:
        safeNumber(regionTraversalDebug?.continuityBreakCount),
      distantRegionJumpCount:
        safeNumber(regionTraversalDebug?.distantRegionJumpCount),
      wildRegionJumpCount:
        safeNumber(regionTraversalDebug?.wildRegionJumpCount),
    },

    influenceSummary: {
      influencedTeachingOrder:
        Boolean(traversalPreferenceDebug?.preferenceApplied),
      influencedCamera: false,
      influencedNarration: false,
      generatedNewPaths: false,
      generatedSyntheticBridgeUnits: false,
      changedDocumentTruth: false,
    },

    safetySummary: {
      modeSelectionMustNotInventArchitecture: true,
      modeSelectionMustNotOverrideEvidence: true,
      fallbackMustNotInventArchitecture: true,
      lowConfidenceNeverDrivesCamera: true,
      lessonGraphRemainsTeachingAuthority: true,
      renderPlanRemainsCameraTranslator: true,
      llmRemainsNarrationOnly: true,
    },

    modePreferences: {
      traversalDirection: traversalModeMetadata.traversalDirection || null,
      preferredRegions: asArray(traversalModeMetadata.preferredRegions),
      secondaryRegions: asArray(traversalModeMetadata.secondaryRegions),
      optionalRegions: asArray(traversalModeMetadata.optionalRegions),
      avoidRegions: asArray(traversalModeMetadata.avoidRegions),
      cameraBias: traversalModeMetadata.cameraBias || null,
      continuityStrategy: traversalModeMetadata.continuityStrategy || null,
    },

    unitAudit: preferenceUnits.map((unit) => ({
      title: unit.title,
      region: unit.region,
      score: unit.score,
      continuityPenalty: unit.continuityPenalty,
      continuityAdjustedScore: unit.continuityAdjustedScore,
      reason: unit.reason,
      penaltyReasons: asArray(unit.penaltyReasons),
      originalIndex: unit.originalIndex,
      finalIndex: unit.index,
    })),

    regionAudit: regionUnits.map((unit) => ({
      title: unit.title,
      region: unit.regionAffinity || unit.region,
      continuityType: unit.continuityType,
      continuityScore: unit.continuityScore,
    })),
  };
}

module.exports = {
  buildArchitectureTraversalAudit,
};
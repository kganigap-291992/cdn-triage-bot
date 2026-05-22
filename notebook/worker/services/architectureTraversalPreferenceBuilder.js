const {
  buildTraversalModeMetadata,
} = require("./architectureTraversalModes");

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function safeNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function getRegionRank(region, orderedRegions = []) {
  const index = orderedRegions.indexOf(region);
  return index >= 0 ? index : orderedRegions.length + 10;
}

function getUnitRegion(unit = {}) {
  const metadata = unit.metadata || {};

  return (
    metadata.regionAffinity ||
    metadata.responsibilityLayer ||
    metadata.regionLabel ||
    null
  );
}

function scoreUnitForTraversalMode(unit = {}, traversalMode = {}) {
  const metadata = unit.metadata || {};
  const region = getUnitRegion(unit);

  const preferredRegions = asArray(traversalMode.preferredRegions);
  const secondaryRegions = asArray(traversalMode.secondaryRegions);
  const optionalRegions = asArray(traversalMode.optionalRegions);
  const avoidRegions = asArray(traversalMode.avoidRegions);

  let score = 0;
  let reason = "neutral";

  if (region && preferredRegions.includes(region)) {
    score += 100 - getRegionRank(region, preferredRegions);
    reason = "preferred_region";
  } else if (region && secondaryRegions.includes(region)) {
    score += 60 - getRegionRank(region, secondaryRegions);
    reason = "secondary_region";
  } else if (region && optionalRegions.includes(region)) {
    score += 30 - getRegionRank(region, optionalRegions);
    reason = "optional_region";
  } else if (region && avoidRegions.includes(region)) {
    score -= 100;
    reason = "avoid_region";
  }

  if (metadata.regionConfidence === "high" || metadata.confidence === "high") {
    score += 8;
  }

  if (metadata.regionConfidence === "medium" || metadata.confidence === "medium") {
    score += 4;
  }

  if (metadata.regionConfidence === "low" || metadata.confidence === "low") {
    score -= 6;
  }

  return {
    score,
    reason,
    region,
    selectedTraversalMode: traversalMode.selectedTraversalMode,
  };
}

function calculateContinuityPenalty({
  unit = {},
  originalIndex = 0,
  proposedIndex = 0,
  traversalMode = {},
}) {
  const region = getUnitRegion(unit);
  const preferredRegions = asArray(traversalMode.preferredRegions);

  const originalMoveDistance = Math.abs(proposedIndex - originalIndex);
  const preferredRank = getRegionRank(region, preferredRegions);
  const originalRegionOrder = safeNumber(unit.metadata?.regionOrder, originalIndex);

  let penalty = 0;
  const reasons = [];

  if (originalMoveDistance > 1) {
    penalty += originalMoveDistance * 8;
    reasons.push("large_index_move");
  }

  if (Number.isFinite(originalRegionOrder)) {
    const regionRankDistance = Math.abs(preferredRank - originalRegionOrder);

    if (regionRankDistance > 1) {
      penalty += regionRankDistance * 6;
      reasons.push("region_order_distance");
    }
  }

  if (unit.metadata?.continuityType === "wild_region_jump") {
    penalty += 18;
    reasons.push("wild_region_jump_guard");
  }

  if (unit.metadata?.continuityType === "distant_region") {
    penalty += 8;
    reasons.push("distant_region_guard");
  }

  return {
    penalty,
    reasons,
    originalIndex,
    proposedIndex,
    originalMoveDistance,
  };
}

function applyContinuityAwarePreferenceStability(scoredUnits = [], traversalMode = {}) {
  const initiallySorted = [...scoredUnits].sort((a, b) => {
    const aPref = a.metadata?.traversalModePreference || {};
    const bPref = b.metadata?.traversalModePreference || {};

    if (bPref.score !== aPref.score) {
      return bPref.score - aPref.score;
    }

    return safeNumber(aPref.originalIndex) - safeNumber(bPref.originalIndex);
  });

  const continuityAdjusted = initiallySorted.map((unit, proposedIndex) => {
    const preference = unit.metadata?.traversalModePreference || {};
    const originalIndex = safeNumber(preference.originalIndex, proposedIndex);

    const continuity = calculateContinuityPenalty({
      unit,
      originalIndex,
      proposedIndex,
      traversalMode,
    });

    const rawScore = safeNumber(preference.score);
    const continuityAdjustedScore = rawScore - continuity.penalty;

    return {
      ...unit,
      metadata: {
        ...(unit.metadata || {}),
        traversalModePreference: {
          ...preference,
          continuityAware: true,
          continuityPenalty: continuity.penalty,
          continuityPenaltyReasons: continuity.reasons,
          continuityAdjustedScore,
          proposedIndex,
          finalSortStrategy: "preference_score_minus_continuity_penalty",
        },
      },
    };
  });

  return continuityAdjusted.sort((a, b) => {
    const aPref = a.metadata?.traversalModePreference || {};
    const bPref = b.metadata?.traversalModePreference || {};

    if (bPref.continuityAdjustedScore !== aPref.continuityAdjustedScore) {
      return bPref.continuityAdjustedScore - aPref.continuityAdjustedScore;
    }

    return safeNumber(aPref.originalIndex) - safeNumber(bPref.originalIndex);
  });
}

function buildTraversalPreferenceDebug(units = []) {
  const preferences = asArray(units)
    .map((unit, index) => {
      const preference = unit.metadata?.traversalModePreference;
      if (!preference) return null;

      return {
        index,
        title: unit.title,
        region: preference.region,
        selectedTraversalMode: preference.selectedTraversalMode,
        score: preference.score,
        continuityAware: Boolean(preference.continuityAware),
        continuityPenalty: safeNumber(preference.continuityPenalty),
        continuityAdjustedScore: safeNumber(preference.continuityAdjustedScore),
        reason: preference.reason,
        penaltyReasons: asArray(preference.continuityPenaltyReasons),
        originalIndex: preference.originalIndex,
        proposedIndex: preference.proposedIndex,
      };
    })
    .filter(Boolean);

  const penaltyCount = preferences.filter(
    (item) => safeNumber(item.continuityPenalty) > 0
  ).length;

  return {
    version: "architecture-traversal-preference-debug-v1",
    preferenceApplied: preferences.length > 0,
    preferenceCount: preferences.length,
    continuityAware: preferences.some((item) => item.continuityAware),
    penaltyCount,
    maxPenalty: preferences.reduce(
      (max, item) => Math.max(max, safeNumber(item.continuityPenalty)),
      0
    ),
    units: preferences,
  };
}

function applyTraversalModePreferences(units = [], selectedMode = "request_lifecycle") {
  const traversalMode = buildTraversalModeMetadata(selectedMode);

  const scoredUnits = asArray(units).map((unit, index) => {
    const preference = scoreUnitForTraversalMode(unit, traversalMode);

    return {
      ...unit,
      metadata: {
        ...(unit.metadata || {}),
        traversalModePreference: {
          version: "architecture-traversal-preference-v2",
          execution: "bounded_sort_bias_with_continuity_guard",
          selectedTraversalMode: traversalMode.selectedTraversalMode,
          selectedTraversalModeLabel: traversalMode.selectedTraversalModeLabel,
          score: preference.score,
          reason: preference.reason,
          region: preference.region,
          originalIndex: index,
        },
      },
    };
  });

  return applyContinuityAwarePreferenceStability(scoredUnits, traversalMode);
}

module.exports = {
  scoreUnitForTraversalMode,
  calculateContinuityPenalty,
  applyContinuityAwarePreferenceStability,
  buildTraversalPreferenceDebug,
  applyTraversalModePreferences,
};
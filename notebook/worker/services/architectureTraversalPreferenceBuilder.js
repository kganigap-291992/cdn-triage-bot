const {
  buildTraversalModeMetadata,
} = require("./architectureTraversalModes");

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function getRegionRank(region, orderedRegions = []) {
  const index = orderedRegions.indexOf(region);
  return index >= 0 ? index : orderedRegions.length + 10;
}

function scoreUnitForTraversalMode(unit = {}, traversalMode = {}) {
  const metadata = unit.metadata || {};
  const region =
    metadata.regionAffinity ||
    metadata.responsibilityLayer ||
    metadata.regionLabel ||
    null;

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

function applyTraversalModePreferences(units = [], selectedMode = "request_lifecycle") {
  const traversalMode = buildTraversalModeMetadata(selectedMode);

  const scoredUnits = asArray(units).map((unit, index) => {
    const preference = scoreUnitForTraversalMode(unit, traversalMode);

    return {
      ...unit,
      metadata: {
        ...(unit.metadata || {}),
        traversalModePreference: {
          version: "architecture-traversal-preference-v1",
          execution: "bounded_sort_bias_only",
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

  return scoredUnits.sort((a, b) => {
    const aPref = a.metadata?.traversalModePreference || {};
    const bPref = b.metadata?.traversalModePreference || {};

    if (bPref.score !== aPref.score) {
      return bPref.score - aPref.score;
    }

    return Number(aPref.originalIndex || 0) - Number(bPref.originalIndex || 0);
  });
}

module.exports = {
  scoreUnitForTraversalMode,
  applyTraversalModePreferences,
};
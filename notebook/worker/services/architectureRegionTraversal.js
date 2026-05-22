// notebook/worker/services/architectureRegionTraversal.js

const REGION_TYPES = {
  TRAFFIC_ENTRY: "traffic_entry",
  VALIDATION: "validation",
  ROUTING: "routing",
  PROCESSING: "processing",
  PERSISTENCE: "persistence",
  RECAP: "recap_or_mental_model",
};

const REGION_ORDER = [
  REGION_TYPES.TRAFFIC_ENTRY,
  REGION_TYPES.VALIDATION,
  REGION_TYPES.ROUTING,
  REGION_TYPES.PROCESSING,
  REGION_TYPES.PERSISTENCE,
  REGION_TYPES.RECAP,
];

const REGION_LABELS = {
  [REGION_TYPES.TRAFFIC_ENTRY]: "Traffic Entry",
  [REGION_TYPES.VALIDATION]: "Validation",
  [REGION_TYPES.ROUTING]: "Routing",
  [REGION_TYPES.PROCESSING]: "Processing",
  [REGION_TYPES.PERSISTENCE]: "Persistence",
  [REGION_TYPES.RECAP]: "Architecture Mental Model",
};

const REASONING_MODE_TO_REGION = {
  ingress_path: REGION_TYPES.TRAFFIC_ENTRY,
  validation_path: REGION_TYPES.VALIDATION,
  control_path: REGION_TYPES.ROUTING,
  processing_path: REGION_TYPES.PROCESSING,
  persistence_path: REGION_TYPES.PERSISTENCE,
  async_path: REGION_TYPES.PROCESSING,
  orchestration_path: REGION_TYPES.ROUTING,
};

function safeString(value) {
  return String(value || "").trim();
}

function safeLower(value) {
  return safeString(value).toLowerCase();
}

function normalizeConfidence(value) {
  const confidence = safeLower(value);
  if (confidence === "deterministic") return "high";
  if (confidence === "high") return "high";
  if (confidence === "medium") return "medium";
  return "low";
}

function inferRegionFromText(summary = {}) {
  const text = [
    summary.mode,
    summary.title,
    summary.reasonedMeaning,
    summary.documentSays,
    ...(Array.isArray(summary.steps) ? summary.steps : []),
  ]
    .map(safeLower)
    .join(" ");

  if (/(entry|ingress|edge|client|traffic|boundary)/.test(text)) {
    return REGION_TYPES.TRAFFIC_ENTRY;
  }

  if (/(auth|validate|validation|policy|access|permission|token)/.test(text)) {
    return REGION_TYPES.VALIDATION;
  }

  if (/(route|routing|gateway|control|orchestrat|dispatch)/.test(text)) {
    return REGION_TYPES.ROUTING;
  }

  if (/(database|db|store|storage|state|persist|terminal)/.test(text)) {
    return REGION_TYPES.PERSISTENCE;
  }

  if (/(process|service|worker|transform|compute|backend)/.test(text)) {
    return REGION_TYPES.PROCESSING;
  }

  return REGION_TYPES.PROCESSING;
}

function mapReasoningSummaryToRegion(summary = {}, index = 0) {
  const mode = safeLower(summary.mode);
  const confidence = normalizeConfidence(summary.confidence);

  if (REASONING_MODE_TO_REGION[mode]) {
    const regionType = REASONING_MODE_TO_REGION[mode];

    return {
      regionAffinity: regionType,
      responsibilityLayer: regionType,
      regionLabel: REGION_LABELS[regionType],
      regionOrder: REGION_ORDER.indexOf(regionType),
      regionSource: "reasoning_mode",
      regionConfidence: confidence,
      cameraAffinity: confidence === "high" ? "region_focus" : "broad_region",
    };
  }

  const fallbackRegion = inferRegionFromText(summary);

  return {
    regionAffinity: fallbackRegion,
    responsibilityLayer: fallbackRegion,
    regionLabel: REGION_LABELS[fallbackRegion],
    regionOrder: REGION_ORDER.indexOf(fallbackRegion),
    regionSource: "keyword_fallback",
    regionConfidence: confidence === "low" ? "low" : "medium",
    cameraAffinity: "broad_region",
  };
}

function sortUnitsByRegionStability(units = []) {
  const sorted = [...units].sort((a, b) => {
    const aOrder = Number(a?.metadata?.regionOrder ?? 999);
    const bOrder = Number(b?.metadata?.regionOrder ?? 999);

    if (aOrder !== bOrder) return aOrder - bOrder;

    return Number(b.importance || 0) - Number(a.importance || 0);
  });

  return sorted.map((unit, index) => {
    const previousUnit = sorted[index - 1];

    const continuity = scoreRegionContinuity(
      previousUnit?.metadata?.regionAffinity,
      unit?.metadata?.regionAffinity
    );

    return {
      ...unit,
      metadata: {
        ...unit.metadata,
        continuityScore: continuity.score,
        continuityType: continuity.continuity,
        continuityPreferred: continuity.preferred,
      },
    };
  });
}

function buildRegionTraversalDebug(units = []) {
  const regionUnits = units.map((unit, index) => ({
    index,
    id: unit.id,
    title: unit.title,
    regionAffinity: unit.metadata?.regionAffinity || null,
    responsibilityLayer: unit.metadata?.responsibilityLayer || null,
    regionLabel: unit.metadata?.regionLabel || null,
    regionSource: unit.metadata?.regionSource || null,
    regionConfidence: unit.metadata?.regionConfidence || null,
    continuityType: unit.metadata?.continuityType || null,
    continuityScore: unit.metadata?.continuityScore ?? null,
    continuityPreferred: unit.metadata?.continuityPreferred ?? null,
  }));

  const scored = regionUnits.filter(
    (unit) => typeof unit.continuityScore === "number"
  );

  const continuityBreakCount = regionUnits.filter((unit) => {
    return (
      unit.continuityType === "distant_region" ||
      unit.continuityType === "wild_region_jump"
    );
  }).length;

  const distantRegionJumpCount = regionUnits.filter(
    (unit) => unit.continuityType === "distant_region"
  ).length;

  const wildRegionJumpCount = regionUnits.filter(
    (unit) => unit.continuityType === "wild_region_jump"
  ).length;

  const averageContinuityScore = scored.length
    ? Number(
        (
          scored.reduce((sum, unit) => sum + unit.continuityScore, 0) /
          scored.length
        ).toFixed(2)
      )
    : null;

  return {
    version: "architecture-region-traversal-v1",
    ownership: "architectureRegionTraversal",
    rule: "Group architecture teaching by stable responsibility regions before camera/rendering.",
    regionOrder: REGION_ORDER,
    unitCount: regionUnits.length,
    continuityBreakCount,
    distantRegionJumpCount,
    wildRegionJumpCount,
    averageContinuityScore,
    units: regionUnits,
  };
}

function getRegionOrderIndex(regionType) {
  const index = REGION_ORDER.indexOf(regionType);
  return index >= 0 ? index : 999;
}

function getRegionDistance(fromRegion, toRegion) {
  return Math.abs(
    getRegionOrderIndex(fromRegion) -
    getRegionOrderIndex(toRegion)
  );
}

function scoreRegionContinuity(previousRegion, nextRegion) {
  if (!previousRegion || !nextRegion) {
    return {
      score: 0.7,
      continuity: "unknown",
      preferred: false,
    };
  }

  if (previousRegion === nextRegion) {
    return {
      score: 1,
      continuity: "same_region",
      preferred: true,
    };
  }

  const distance = getRegionDistance(previousRegion, nextRegion);

  if (distance === 1) {
    return {
      score: 0.82,
      continuity: "adjacent_region",
      preferred: true,
    };
  }

  if (distance === 2) {
    return {
      score: 0.55,
      continuity: "distant_region",
      preferred: false,
    };
  }

  return {
    score: 0.25,
    continuity: "wild_region_jump",
    preferred: false,
  };
}


function shouldUseSoftTransition(unit = {}) {
  const continuityType = unit?.metadata?.continuityType;

  return (
    continuityType === "distant_region" ||
    continuityType === "wild_region_jump"
  );
}

module.exports = {
  REGION_TYPES,
  REGION_ORDER,
  REGION_LABELS,
  mapReasoningSummaryToRegion,
  sortUnitsByRegionStability,
  buildRegionTraversalDebug,
  getRegionDistance,
  scoreRegionContinuity,
  shouldUseSoftTransition,
};
// notebook/worker/services/cameraNarrationAlignmentBuilder.js

/**
 * 22O.6A — Camera / Narration Alignment Builder
 *
 * Owns:
 * - Aligning teaching unit order, narration continuity, region traversal, and camera intent.
 *
 * Does NOT own:
 * - architecture truth
 * - dialogue wording
 * - final rendering
 * - OCR precision
 *
 * Borrowed ideas:
 * - Motion Canvas: explicit semantic beats
 * - tldraw: broad safe zoom-to-bounds before precision
 * - NotebookLM-style walkthrough: narration and visual attention follow same chapter
 */

const CAMERA_SCOPE = {
  EXACT: "exact_focus",
  FLOW_REGION: "flow_region",
  FULL_PAGE: "full_page",
  FULL_ARCHITECTURE: "full_architecture",
};

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

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

function isUsableFocusRegion(region) {
  if (!region || typeof region !== "object") return false;

  const x = Number(region.x);
  const y = Number(region.y);
  const width = Number(region.width);
  const height = Number(region.height);

  return (
    Number.isFinite(x) &&
    Number.isFinite(y) &&
    Number.isFinite(width) &&
    Number.isFinite(height) &&
    width > 0 &&
    height > 0 &&
    x >= 0 &&
    y >= 0 &&
    x <= 1 &&
    y <= 1
  );
}

function getTeachingUnits(lessonGraph = {}) {
  return asArray(
    lessonGraph.teachingUnits ||
      lessonGraph.lessonGraph?.teachingUnits
  );
}

function getContinuityScenes(narrationContinuity = {}) {
  return asArray(narrationContinuity.scenes);
}


function getTeachingUnitId(value = {}) {
  return (
    value.teachingUnitId ||
    value.id ||
    value.metadata?.teachingUnitId ||
    null
  );
}

function getHopId(value = {}) {
  return (
    value.hopId ||
    value.metadata?.hopId ||
    null
  );
}

function getCanonicalOrder(value = {}) {
  return (
    value.canonicalOrder ||
    value.metadata?.canonicalOrder ||
    null
  );
}


function getTraversalUnits(architectureTraversal = {}) {
  return asArray(
    architectureTraversal.regionTraversalDebug?.units ||
      architectureTraversal.units
  );
}

function getRole({ unit = {}, section = {} }) {
  const haystack = [
    unit.type,
    unit.title,
    unit.sceneIntent,
    unit.presentationStyle,
    unit.metadata?.role,
    unit.metadata?.chapterType,
    section.type,
    section.title,
    section.caption,
    section.visualIntent?.sceneIntent,
    section.visualIntent?.presentationStyle,
    section.teachingUnitId,
  ]
    .map(safeLower)
    .join(" ");

  if (
    haystack.includes("overview") ||
    haystack.includes("show_full_architecture")
  ) {
    return "architecture_overview";
  }

  if (
    haystack.includes("recap") ||
    haystack.includes("putting") ||
    haystack.includes("mental_model") ||
    haystack.includes("mental model")
  ) {
    return "architecture_recap";
  }

  return "architecture_chapter";
}

function getRegion({ unit = {}, continuityScene = {}, traversalUnit = {} }) {
  return (
    continuityScene.region ||
    unit.metadata?.regionAffinity ||
    unit.metadata?.responsibilityLayer ||
    unit.metadata?.teachingRegion?.responsibilityLayer ||
    traversalUnit.regionAffinity ||
    traversalUnit.responsibilityLayer ||
    "unknown_region"
  );
}

function getFocusRegion({ unit = {}, section = {} }) {
  return (
    section.focusRegion ||
    section.visualIntent?.focusRegion ||
    section.visualIntent?.focusHint?.focusRegion ||
    section.metadata?.focusHint?.focusRegion ||
    unit.focusHint?.focusRegion ||
    null
  );
}

function resolveCameraScope({ role, focusRegion }) {
  if (
    role === "architecture_overview" ||
    role === "architecture_recap"
  ) {
    return CAMERA_SCOPE.FULL_ARCHITECTURE;
  }

  if (!isUsableFocusRegion(focusRegion)) {
    return CAMERA_SCOPE.FULL_PAGE;
    }

    if (role === "architecture_chapter") {
    return CAMERA_SCOPE.FLOW_REGION;
    }

    const confidence = normalizeConfidence(focusRegion.confidence);

    if (confidence === "high") return CAMERA_SCOPE.EXACT;
    if (confidence === "medium") return CAMERA_SCOPE.FLOW_REGION;

  return CAMERA_SCOPE.FULL_PAGE;
}

function resolveFocusStrategy({ cameraScope, focusRegion }) {
  if (cameraScope === CAMERA_SCOPE.FULL_ARCHITECTURE) {
    return "full_architecture_context";
  }

  if (cameraScope === CAMERA_SCOPE.EXACT) {
    return "exact_focus_allowed";
  }

  if (cameraScope === CAMERA_SCOPE.FLOW_REGION) {
    return "broad_flow_region";
  }

  if (!isUsableFocusRegion(focusRegion)) {
    return "safe_full_page_no_region";
  }

  return "safe_full_page_low_confidence";
}

function resolveCameraIntent({ role, cameraScope, unit = {}, section = {} }) {
  if (role === "architecture_overview") {
    return "establish_full_architecture";
  }

  if (role === "architecture_recap") {
    return "return_to_full_architecture";
  }

  const explicit =
    unit.focusHint?.cameraIntent ||
    section.visualIntent?.cameraIntent ||
    section.visualIntent?.focusHint?.cameraIntent ||
    null;

  if (explicit) return explicit;

  if (cameraScope === CAMERA_SCOPE.EXACT) {
    return "follow_flow_to_component";
  }

  if (cameraScope === CAMERA_SCOPE.FLOW_REGION) {
    return "follow_flow_to_region";
  }

  return "hold_safe_context";
}

function resolveCameraStyle({ role, cameraScope, softTransition }) {
  if (role === "architecture_overview") {
    return "broad_establishing_hold";
  }

  if (role === "architecture_recap") {
    return "slow_zoom_out_recap";
  }

  if (softTransition) {
    return "broad_context_continuation";
  }

  if (cameraScope === CAMERA_SCOPE.EXACT) {
    return "smooth_pan_soft_zoom";
  }

  if (cameraScope === CAMERA_SCOPE.FLOW_REGION) {
    return "broader_flow_region_focus";
  }

  return "safe_full_page_hold";
}

function shouldUseSoftTransition({ continuityType }) {
  return (
    continuityType === "distant_region" ||
    continuityType === "wild_region_jump"
  );
}

function findContinuityScene({ continuityScenes, unit, section, index }) {
  const teachingUnitId =
    getTeachingUnitId(section) ||
    getTeachingUnitId(unit);

  const hopId =
    getHopId(section) ||
    getHopId(unit);

  const canonicalOrder =
    getCanonicalOrder(section) ||
    getCanonicalOrder(unit);

  const byTeachingUnitId = continuityScenes.find(
    (scene) =>
      teachingUnitId &&
      scene.teachingUnitId === teachingUnitId
  );

  if (byTeachingUnitId) {
    return {
      scene: byTeachingUnitId,
      matchStrategy: "teachingUnitId",
    };
  }

  const byHopId = continuityScenes.find(
    (scene) =>
      hopId &&
      scene.hopId === hopId
  );

  if (byHopId) {
    return {
      scene: byHopId,
      matchStrategy: "hopId",
    };
  }

  const byCanonicalOrder = continuityScenes.find(
    (scene) =>
      canonicalOrder &&
      scene.canonicalOrder === canonicalOrder
  );

  if (byCanonicalOrder) {
    return {
      scene: byCanonicalOrder,
      matchStrategy: "canonicalOrder",
    };
  }

  const byUnitTitle = continuityScenes.find(
    (scene) => scene.title === unit?.title
  );

  if (byUnitTitle) {
    return {
      scene: byUnitTitle,
      matchStrategy: "unitTitle",
    };
  }

  const bySectionCaption = continuityScenes.find(
    (scene) => scene.title === section?.caption
  );

  if (bySectionCaption) {
    return {
      scene: bySectionCaption,
      matchStrategy: "sectionCaption",
    };
  }

  const byIndex = continuityScenes[index] || null;

  return {
    scene: byIndex,
    matchStrategy: byIndex ? "indexFallback" : "missing",
  };
}

function findTraversalUnit({ traversalUnits, unit, continuityScene, index }) {
  const unitTitle = safeLower(unit?.title);
    const teachingUnitId =
    getTeachingUnitId(unit);

    const hopId =
    getHopId(unit);

    const canonicalOrder =
    getCanonicalOrder(unit);

  const continuityRegion = safeLower(continuityScene?.region);
  const unitRegion = safeLower(unit?.metadata?.regionAffinity);

    return (
    traversalUnits.find(
        (item) =>
        teachingUnitId &&
        getTeachingUnitId(item) === teachingUnitId
    ) ||
    traversalUnits.find(
        (item) =>
        hopId &&
        getHopId(item) === hopId
    ) ||
    traversalUnits.find(
        (item) =>
        canonicalOrder &&
        getCanonicalOrder(item) === canonicalOrder
    ) ||
    traversalUnits.find((item) => safeLower(item.title) === unitTitle) ||
    traversalUnits.find(
        (item) =>
        safeLower(item.regionAffinity) === continuityRegion
    ) ||
    traversalUnits.find(
        (item) =>
        safeLower(item.regionAffinity) === unitRegion
    ) ||
    traversalUnits[index] ||
    null
    );
}

function buildAlignmentWarnings({
  role,
  region,
  focusRegion,
  cameraScope,
  continuityScene,
  traversalUnit,
  continuityMatchStrategy,
}) {
  const warnings = [];

  if (!continuityScene) {
    warnings.push("missing_narration_continuity_scene");
  }

  if (!traversalUnit) {
    warnings.push("missing_region_traversal_unit");
  }

  if (region === "unknown_region" && role === "architecture_chapter") {
    warnings.push("unknown_semantic_region");
  }

  if (!isUsableFocusRegion(focusRegion)) {
    warnings.push("missing_or_invalid_focus_region_using_safe_fallback");
  }

  if (
    normalizeConfidence(focusRegion?.confidence) === "low" &&
    cameraScope !== CAMERA_SCOPE.FULL_PAGE
  ) {
    warnings.push("low_confidence_region_should_not_drive_precise_camera");
  }

  if (
    continuityMatchStrategy === "unitTitle" ||
    continuityMatchStrategy === "sectionCaption" ||
    continuityMatchStrategy === "indexFallback"
    ) {
    warnings.push(`continuity_used_weak_match_${continuityMatchStrategy}`);
    }

    return warnings;
}

function buildCameraNarrationAlignment({
  lessonGraph = {},
  sections = [],
  architectureTraversal = {},
  narrationContinuity = {},
} = {}) {
  const teachingUnits = getTeachingUnits(lessonGraph);
  const continuityScenes = getContinuityScenes(narrationContinuity);
  const traversalUnits = getTraversalUnits(architectureTraversal);

  const sceneCount = Math.max(
    sections.length,
    teachingUnits.length,
    continuityScenes.length
  );

  const scenes = [];

  for (let index = 0; index < sceneCount; index += 1) {
    const unit = teachingUnits[index] || {};
    const section = sections[index] || {};
    const continuityMatch = findContinuityScene({
    continuityScenes,
    unit,
    section,
    index,
    });

    const continuityScene = continuityMatch.scene;

    const traversalUnit = findTraversalUnit({
      traversalUnits,
      unit,
      continuityScene,
      index,
    });

    const role = getRole({
      unit,
      section,
      index,
      total: sceneCount,
    });

    const region = getRegion({
      unit,
      continuityScene,
      traversalUnit,
    });

    const focusRegion = getFocusRegion({ unit, section });
    const cameraScope = resolveCameraScope({ role, focusRegion });
    const continuityType =
      traversalUnit?.continuityType ||
      unit.metadata?.continuityType ||
      null;

    const continuityScore =
      traversalUnit?.continuityScore ??
      unit.metadata?.continuityScore ??
      null;

    const softTransition = shouldUseSoftTransition({ continuityType });
    const cameraIntent = resolveCameraIntent({
      role,
      cameraScope,
      unit,
      section,
    });

    const cameraStyle = resolveCameraStyle({
      role,
      cameraScope,
      softTransition,
    });

    const focusStrategy = resolveFocusStrategy({
      cameraScope,
      focusRegion,
    });

    scenes.push({
      sceneIndex: index,
      teachingUnitId: section.teachingUnitId || unit.id || null,
      title:
        unit.title ||
        section.title ||
        section.caption ||
        `Scene ${index + 1}`,

      role,
      region,

      continuityType,
      continuityScore,
      transitionHint: continuityScene?.transitionHint || null,
      openingStyle: continuityScene?.openingStyle || null,

      cameraIntent,
      cameraStyle,
      cameraScope,
      focusStrategy,
      focusRegion: isUsableFocusRegion(focusRegion) ? focusRegion : null,

      softTransition,
      transitionStyle: softTransition
        ? "broad_context_continuation"
        : "semantic_progression",

      confidence: normalizeConfidence(focusRegion?.confidence),

      alignmentWarnings: buildAlignmentWarnings({
        role,
        region,
        focusRegion,
        cameraScope,
        continuityScene,
        traversalUnit,
        continuityMatchStrategy: continuityMatch.matchStrategy,
        }),

      matchStrategy: {
        narrationContinuity:
            continuityMatch.matchStrategy,
        },

        sources: {
        teachingUnit: Boolean(unit.id),
        narrationContinuity: Boolean(continuityScene),
        regionTraversal: Boolean(traversalUnit),
        focusHint: Boolean(unit.focusHint || section.visualIntent?.focusHint),
        },
    });
  }

  return {
    version: "camera-narration-alignment-v1",
    enabled: true,
    ownership: {
      alignmentOwner: "cameraNarrationAlignmentBuilder",
      pedagogicalSource: "lessonGraph",
      narrationSource: "narrationContinuityBuilder",
      traversalSource: "architectureRegionTraversal",
      cinematicConsumer: "renderPlan",
      renderer: "Root.jsx",
    },
    rule:
      "Narration and camera must follow the same teaching traversal. Broad safe framing beats tiny wrong focus.",
    sceneCount: scenes.length,
    scenes,
    stats: {
    weakContinuityMatchCount: scenes.filter((scene) =>
        ["unitTitle", "sectionCaption", "indexFallback"].includes(
        scene.matchStrategy?.narrationContinuity
        )
    ).length,

    strongContinuityMatchCount: scenes.filter((scene) =>
        ["teachingUnitId", "hopId", "canonicalOrder"].includes(
        scene.matchStrategy?.narrationContinuity
        )
    ).length,

    warningCount: scenes.reduce(
        (sum, scene) => sum + scene.alignmentWarnings.length,
        0
      ),
      softTransitionCount: scenes.filter((scene) => scene.softTransition).length,
      exactFocusCount: scenes.filter(
        (scene) => scene.cameraScope === CAMERA_SCOPE.EXACT
      ).length,
      broadOrSafeCount: scenes.filter((scene) =>
        [
          CAMERA_SCOPE.FLOW_REGION,
          CAMERA_SCOPE.FULL_PAGE,
          CAMERA_SCOPE.FULL_ARCHITECTURE,
        ].includes(scene.cameraScope)
      ).length,
    },
  };
}

module.exports = {
  buildCameraNarrationAlignment,
};
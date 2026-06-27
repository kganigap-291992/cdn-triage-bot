'use strict';

/**
 * regionTraversalTeachingBuilder.js
 *
 * BUG-17A — Region Traversal Teaching Builder
 *
 * Owns:
 * - deterministic region traversal from narration continuity + lesson graph
 * - region grouping
 * - region transition chain
 * - traversal health
 *
 * Does NOT:
 * - call LLM
 * - mutate traversal
 * - render
 * - narrate
 */

const fs = require('fs');
const path = require('path');

const BUILDER_VERSION = 'region-traversal-teaching-v1';

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function safeString(value) {
  return String(value || '').trim();
}

function safeLower(value) {
  return safeString(value).toLowerCase();
}

function slugify(value) {
  return safeLower(value)
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);
}

function uniq(values = []) {
  return Array.from(
    new Set(
      asArray(values).filter(
        (value) => value !== null && value !== undefined && value !== ''
      )
    )
  );
}

function isUnknownRegion(region) {
  const value = safeLower(region);

  return (
    !value ||
    value === 'unknown_region' ||
    value === 'unknown' ||
    value === 'unknown region'
  );
}

function getSceneRegion(scene = {}) {
  return (
    safeString(scene.architectureBoundary) ||
    safeString(scene.region) ||
    safeString(scene.semanticRegion) ||
    'unknown_region'
  );
}

function getTeachingUnitsById(lessonGraph = {}) {
  return new Map(
    asArray(lessonGraph.teachingUnits).map((unit) => [
      unit.id || unit.metadata?.teachingUnitId,
      unit,
    ])
  );
}

function getChapterIdsForTeachingUnit({
  teachingUnit = {},
  learningChapters = {},
} = {}) {
  const unitId =
    teachingUnit.id ||
    teachingUnit.metadata?.teachingUnitId ||
    null;

  const focusIds =
    asArray(teachingUnit.metadata?.focusIds);

  return asArray(learningChapters.chapters)
    .filter((chapter) => {
      const chapterFocusIds = asArray(chapter.focusIds);

      return (
        chapter.teachingUnitIds?.includes?.(unitId) ||
        focusIds.some((focusId) =>
          chapterFocusIds.includes(focusId)
        )
      );
    })
    .map((chapter) => chapter.chapterId)
    .filter(Boolean);
}

function makeRegionId(regionName) {
  return `region_${slugify(regionName || 'unknown_region')}`;
}

function inferRegionTeachingGoal(regionName) {
  if (isUnknownRegion(regionName)) {
    return 'Orient the learner around architecture context that does not yet have a reliable region boundary.';
  }

  return `Teach the architecture elements associated with ${regionName} as one coherent region of the system.`;
}

function inferRegionRole(region = {}) {
  const title = safeLower(region.title);
  const sceneTitles = asArray(region.sceneTitles)
    .map(safeLower)
    .join(' ');

  if (isUnknownRegion(title)) {
    if (/overview|orient|architecture overview/.test(sceneTitles)) {
      return 'context_region';
    }

    if (/recap|putting|summary|mental model/.test(sceneTitles)) {
      return 'recap_region';
    }

    return 'unknown_context_region';
  }

  if (/edge|entry|ingress|gateway|routing|cdn|traffic/.test(title)) {
    return 'entry_or_routing_region';
  }

  if (/auth|identity|validation|policy|access/.test(title)) {
    return 'validation_region';
  }

  if (/application|cluster|service|processing|compute/.test(title)) {
    return 'application_processing_region';
  }

  if (/database|state|storage|persistence|sync/.test(title)) {
    return 'state_or_persistence_region';
  }

  return 'architecture_walkthrough_region';
}

function inferTraversalRole(regionRole) {
  const role = safeString(regionRole);

  if (role === 'context_region') return 'orientation';
  if (role === 'recap_region') return 'recap';
  if (role === 'unknown_context_region') return 'context';
  if (role === 'entry_or_routing_region') return 'entry';
  if (role === 'validation_region') return 'checkpoint';
  if (role === 'application_processing_region') return 'processing';
  if (role === 'state_or_persistence_region') return 'state';

  return 'walkthrough';
}

function shouldTeachRegion(region = {}) {
  if (region.regionRole === 'unknown_context_region') {
    return false;
  }

  return asArray(region.sceneIndexes).length > 0;
}

function buildRegionTeachingPurpose(region = {}) {
  if (region.regionRole === 'context_region') {
    return 'Use this region to orient the learner before entering architecture-specific walkthrough regions.';
  }

  if (region.regionRole === 'recap_region') {
    return 'Use this region to recap the architecture without introducing new claims.';
  }

  if (region.regionRole === 'application_processing_region') {
    return `Teach ${region.title} as the region where core application or service work is grouped.`;
  }

  if (region.regionRole === 'entry_or_routing_region') {
    return `Teach ${region.title} as the region where traffic enters, routes, or changes direction.`;
  }

  if (region.regionRole === 'validation_region') {
    return `Teach ${region.title} as the region where access, identity, policy, or validation responsibilities are grouped.`;
  }

  if (region.regionRole === 'state_or_persistence_region') {
    return `Teach ${region.title} as the region where state, storage, persistence, or synchronization responsibilities are grouped.`;
  }

  return region.teachingGoal || inferRegionTeachingGoal(region.title);
}

function buildRegions({
  narrationContinuity = {},
  lessonGraph = {},
  learningChapters = {},
} = {}) {
  const teachingUnitsById =
    getTeachingUnitsById(lessonGraph);

  const buckets = new Map();

  for (const scene of asArray(narrationContinuity.scenes)) {
    const regionName = getSceneRegion(scene);
    const regionId = makeRegionId(regionName);

    if (!buckets.has(regionId)) {
      buckets.set(regionId, {
        regionId,
        title: regionName,
        architectureBoundary:
          safeString(scene.architectureBoundary) || null,
        semanticRegion:
          safeString(scene.semanticRegion) || null,
        sceneIndexes: [],
        teachingUnitIds: [],
        chapterIds: [],
        components: [],
        handoffs: [],
        sceneTitles: [],
        entrySceneIndex: null,
        exitSceneIndex: null,
        teachingGoal: inferRegionTeachingGoal(regionName),
        confidence: isUnknownRegion(regionName) ? 'low' : 'medium',
        source: 'narration-continuity.json',
      });
    }

    const bucket = buckets.get(regionId);
    const teachingUnit =
      teachingUnitsById.get(scene.teachingUnitId) || {};

    bucket.sceneIndexes.push(scene.sceneIndex);
    bucket.sceneTitles.push(scene.title);

    if (scene.teachingUnitId) {
      bucket.teachingUnitIds.push(scene.teachingUnitId);
    }

    bucket.chapterIds.push(
      ...getChapterIdsForTeachingUnit({
        teachingUnit,
        learningChapters,
      })
    );

    bucket.components.push(...asArray(scene.components));
    bucket.handoffs.push(
      ...asArray(scene.handoffs).map((handoff) =>
        handoff.label || `${handoff.from} → ${handoff.to}`
      )
    );
  }

  return Array.from(buckets.values()).map((region) => {
    const sceneIndexes = uniq(region.sceneIndexes).map(Number);

    const enrichedRegion = {
  ...region,
  sceneIndexes,
  sceneTitles: uniq(region.sceneTitles),
  teachingUnitIds: uniq(region.teachingUnitIds),
  chapterIds: uniq(region.chapterIds),
  components: uniq(region.components),
  handoffs: uniq(region.handoffs),
  entrySceneIndex:
    sceneIndexes.length > 0 ? Math.min(...sceneIndexes) : null,
  exitSceneIndex:
    sceneIndexes.length > 0 ? Math.max(...sceneIndexes) : null,
};

const regionRole = inferRegionRole(enrichedRegion);
const traversalRole = inferTraversalRole(regionRole);

return {
  ...enrichedRegion,
  regionRole,
  traversalRole,
  shouldTeachAsRegion: shouldTeachRegion({
    ...enrichedRegion,
    regionRole,
  }),
  teachingPurpose: buildRegionTeachingPurpose({
    ...enrichedRegion,
    regionRole,
  }),
};
  });
}

function buildTransitions(narrationContinuity = {}) {
  const scenes = asArray(narrationContinuity.scenes);
  const transitions = [];

  for (let index = 1; index < scenes.length; index += 1) {
    const previousScene = scenes[index - 1];
    const currentScene = scenes[index];

    const fromRegion = getSceneRegion(previousScene);
    const toRegion = getSceneRegion(currentScene);

    if (fromRegion === toRegion) continue;

    transitions.push({
      transitionId:
        `region_transition_${index}_${slugify(fromRegion)}_to_${slugify(toRegion)}`,
      fromRegionId: makeRegionId(fromRegion),
      toRegionId: makeRegionId(toRegion),
      fromRegion,
      toRegion,
      sceneIndex: currentScene.sceneIndex,
      transitionType:
        isUnknownRegion(fromRegion) || isUnknownRegion(toRegion)
          ? 'context_boundary_transition'
          : 'region_boundary_transition',
      source: 'narration-continuity.json',
      traversalChanged: false,
    });
  }

  return transitions;
}

function buildRegionTraversalHealth({
  regions = [],
  transitions = [],
  narrationContinuity = {},
} = {}) {
  const regionIds = new Set(regions.map((region) => region.regionId));

  const regionsMissingRequiredFields =
    regions.filter((region) => {
        return (
        !safeString(region.regionId) ||
        !safeString(region.title) ||
        !Array.isArray(region.sceneIndexes) ||
        region.sceneIndexes.length === 0 ||
        !safeString(region.regionRole) ||
        !safeString(region.traversalRole)
        );
    });

  const missingTransitionEndpoints =
    transitions.filter(
      (transition) =>
        !regionIds.has(transition.fromRegionId) ||
        !regionIds.has(transition.toRegionId)
    );

  const duplicateRegionIds =
    regions
      .map((region) => region.regionId)
      .filter((id, index, ids) => ids.indexOf(id) !== index);

  const sceneIndexesWithRegion =
    new Set(
      regions.flatMap((region) => asArray(region.sceneIndexes))
    );

  const orphanSceneIndexes =
    asArray(narrationContinuity.scenes)
        .map((scene) => scene.sceneIndex)
        .filter((sceneIndex) => !sceneIndexesWithRegion.has(sceneIndex));

    const invalidRegionSceneRanges =
    regions.filter((region) => {
        const sceneIndexes = asArray(region.sceneIndexes)
        .filter((value) => typeof value === 'number');

        if (!sceneIndexes.length) {
        return true;
        }

        return (
        region.entrySceneIndex !== Math.min(...sceneIndexes) ||
        region.exitSceneIndex !== Math.max(...sceneIndexes)
        );
    });

    const invalidTransitionOrdering =
    transitions.filter((transition) => {
        return (
        !Number.isFinite(Number(transition.sceneIndex)) ||
        Number(transition.sceneIndex) < 0
        );
    });

    const hasScenes =
    asArray(narrationContinuity.scenes).length > 0;

    const teachableRegionCount =
    regions.filter(
        (region) => region.shouldTeachAsRegion
    ).length;

    const missingTeachableRegion =
    hasScenes && teachableRegionCount === 0;

    const traversalChanged = false;

    const violations = [
    ...duplicateRegionIds.map((regionId) => ({
        type: 'duplicate_region_id',
        severity: 'high',
        regionId,
    })),

    ...regionsMissingRequiredFields.map((region) => ({
        type: 'region_missing_required_fields',
        severity: 'high',
        regionId: region.regionId,
    })),

    ...invalidRegionSceneRanges.map((region) => ({
        type: 'invalid_region_scene_range',
        severity: 'high',
        regionId: region.regionId,
    })),

    ...invalidTransitionOrdering.map((transition) => ({
        type: 'invalid_transition_ordering',
        severity: 'medium',
        transitionId: transition.transitionId,
    })),

  ...(missingTeachableRegion
    ? [{
        type: 'missing_teachable_region',
        severity: 'high',
      }]
    : []),

  ...missingTransitionEndpoints.map((transition) => ({
    type: 'missing_transition_endpoint',
    severity: 'high',
    transitionId: transition.transitionId,
  })),

  ...orphanSceneIndexes.map((sceneIndex) => ({
    type: 'orphan_scene_without_region',
    severity: 'medium',
    sceneIndex,
  })),
];

  return {
    version: 'region-traversal-health-v1',
    valid: violations.length === 0 && traversalChanged === false,
    violationCount: violations.length,

    duplicateRegionIdCount:
        duplicateRegionIds.length,

    missingRequiredRegionFieldCount:
        regionsMissingRequiredFields.length,

    invalidRegionSceneRangeCount:
        invalidRegionSceneRanges.length,

    invalidTransitionOrderingCount:
        invalidTransitionOrdering.length,

    missingTransitionEndpointCount:
        missingTransitionEndpoints.length,

    orphanSceneCount:
        orphanSceneIndexes.length,

    teachableRegionCount,

    missingTeachableRegion,

    traversalChanged,
    violations,
    samples: {
    duplicateRegionIds:
        duplicateRegionIds.slice(0, 5),

    regionsMissingRequiredFields:
        regionsMissingRequiredFields.slice(0, 5),

    invalidRegionSceneRanges:
        invalidRegionSceneRanges.slice(0, 5),

    invalidTransitionOrdering:
        invalidTransitionOrdering.slice(0, 5),

    missingTransitionEndpoints:
        missingTransitionEndpoints.slice(0, 5),

    orphanSceneIndexes:
        orphanSceneIndexes.slice(0, 5),
    },
  };
}

function buildRegionTraversalTeaching({
  lessonGraph = {},
  learningChapters = {},
  narrationContinuity = {},
  outputDir = null,
} = {}) {
  const regions = buildRegions({
    narrationContinuity,
    lessonGraph,
    learningChapters,
  });

  const transitions = buildTransitions(narrationContinuity);

  const unknownRegionCount =
    regions.filter((region) => isUnknownRegion(region.title)).length;

  const health = buildRegionTraversalHealth({
    regions,
    transitions,
    narrationContinuity,
  });

  const payload = {
    version: BUILDER_VERSION,
    source: 'regionTraversalTeachingBuilder',
    purpose:
      'Create deterministic region traversal teaching metadata from existing lesson graph and narration continuity regions.',

    rules: {
      traversalMutation: 'forbidden',
      llmGeneratedTraversal: 'forbidden',
      renderingChanges: 'forbidden',
      narrationGeneration: 'forbidden',
      deterministicOnly: true,
    },

    regions,
    transitions,
    health,

    stats: {
      regionCount: regions.length,
      transitionCount: transitions.length,
      unknownRegionCount,
      sceneCount: asArray(narrationContinuity.scenes).length,
      traversalChanged: false,
    },
  };

  if (outputDir) {
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(
      path.join(outputDir, 'region-traversal.json'),
      JSON.stringify(payload, null, 2),
      'utf8'
    );
  }

  return payload;
}

module.exports = {
  BUILDER_VERSION,
  buildRegionTraversalTeaching,
};
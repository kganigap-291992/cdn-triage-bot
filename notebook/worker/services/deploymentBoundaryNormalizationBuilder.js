'use strict';

/**
 * deploymentBoundaryNormalizationBuilder.js
 *
 * BUG-17F.1 — Deployment Boundary Normalization
 *
 * Owns:
 * - discover clean deployment regions/zones/sites/cells from noisy candidates
 * - normalize labels like Region A / Zone 1 / Data Center East
 * - infer component membership from the full component graph after regions are known
 *
 * Does NOT:
 * - infer deployment pattern
 * - detect replication
 * - mutate traversal
 * - narrate
 * - call LLM
 */

const fs = require('fs');
const path = require('path');

const BUILDER_VERSION =
  'deployment-boundary-normalization-v2';

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
      asArray(values)
        .map(safeString)
        .filter(Boolean)
    )
  );
}

function capitalize(value = '') {
  const text = safeLower(value);
  if (!text) return '';
  return `${text[0].toUpperCase()}${text.slice(1)}`;
}

const DEPLOYMENT_SCOPE_WORDS = [
  'region',
  'zone',
  'az',
  'availability zone',
  'site',
  'dc',
  'datacenter',
  'data center',
  'cell',
];

const DEPLOYMENT_DIFFERENTIATORS = [
  'a',
  'b',
  'c',
  'd',
  '1',
  '2',
  '3',
  '4',
  'east',
  'west',
  'north',
  'south',
  'primary',
  'secondary',
  'active',
  'standby',
  'passive',
];

const COMPONENT_SUFFIX_REGION_HINTS = [
  'routing layer',
  'application cluster',
  'app cluster',
  'api gateway',
  'cdn edge',
  'database',
  'cache',
  'waf',
  'bot shield',
  'origin',
  'packager',
  'transcoder',
  'service',
  'worker',
];

const GENERIC_BOUNDARY_LABELS = new Set([
  'multi',
  'region',
  'regions',
  'cross',
  'cross-region',
  'cross region',
  'active',
  'standby',
  'shared',
  'generic',
  'architecture',
  'streaming architecture',
  'active region',
  'standby region',
  'application cluster observability',
  'region streaming',
  'multi region streaming architecture',
]);

const DOCUMENT_NOISE_PATTERNS = [
  /\bbug[-\s]?\d+/i,
  /\bwhy this sample is useful\b/i,
  /\bwhy it exists\b/i,
  /\bco_mentions\b/i,
  /\btable of contents\b/i,
  /\boverview\b/i,
  /\bnotes?\b/i,
  /\bexample\b/i,
  /\bpdf\b/i,
  /\bevery\b/i,
  /\bmulti[-\s]?region\s+streaming\s+architecture\b/i,
  /\bregion\s+streaming\s+architecture\b/i,
  /\bstreaming\s+architecture\b/i,
  /^[-•]/,
];

const SHARED_OR_GLOBAL_PATTERNS = [
  /\bglobal\b/i,
  /\bshared\b/i,
  /\bcross[-\s]?region\b/i,
  /\bmetrics?\b/i,
  /\balerts?\b/i,
  /\btelemetry\b/i,
  /\bconfig\b/i,
  /\bdns\b/i,
  /\barchitecture\b/i,
  /\bgeneric\b/i,
  /\bsolid\b/i,
  /\bdashed\b/i,
];

function isGenericBoundaryLabel(label = '') {
  return GENERIC_BOUNDARY_LABELS.has(safeLower(label));
}

function isDocumentNoise(label = '') {
  const value = safeString(label);
  if (!value) return true;

  return DOCUMENT_NOISE_PATTERNS.some((pattern) =>
    pattern.test(value)
  );
}

function isSharedOrGlobalComponentName(name = '') {
  const value = safeString(name);

  return SHARED_OR_GLOBAL_PATTERNS.some((pattern) =>
    pattern.test(value)
  );
}

function isRegionHeaderComponentName(name = '') {
  return /^\s*region\s+[a-z0-9]+\s*[-:/]?\s*(active|standby|passive|primary|secondary)(\s*\/\s*(active|standby|passive|primary|secondary))*\s*$/i
    .test(safeString(name));
}

function scopePattern() {
  return DEPLOYMENT_SCOPE_WORDS
    .map((word) => word.replace(/\s+/g, '\\s+'))
    .join('|');
}

function differentiatorPattern() {
  return DEPLOYMENT_DIFFERENTIATORS.join('|');
}

function extractDeploymentDifferentiator(label = '') {
  const value = safeString(label);

  const scopeThenDiff = value.match(
    new RegExp(
      `\\b(?:${scopePattern()})\\s*[-_:]?\\s*(${differentiatorPattern()})\\b`,
      'i'
    )
  );

  if (scopeThenDiff) return scopeThenDiff[1];

  const diffThenScope = value.match(
    new RegExp(
      `\\b(${differentiatorPattern()})\\s+(?:${scopePattern()})\\b`,
      'i'
    )
  );

  if (diffThenScope) return diffThenScope[1];

  const suffix = value.match(
    new RegExp(`\\b(${differentiatorPattern()})\\b$`, 'i')
  );

  if (suffix) return suffix[1];

  return null;
}

function hasDeploymentScopeAndDifferentiator(label = '') {
  const value = safeString(label);
  const diff = extractDeploymentDifferentiator(value);

  if (!diff) return false;

  return new RegExp(`\\b(?:${scopePattern()})\\b`, 'i')
    .test(value);
}

function hasComponentSuffixRegionHint(label = '') {
  const value = safeString(label);
  const diff = extractDeploymentDifferentiator(value);

  if (!diff) return false;

  return COMPONENT_SUFFIX_REGION_HINTS.some((hint) =>
    new RegExp(`\\b${hint.replace(/\s+/g, '\\s+')}\\b`, 'i')
      .test(value)
  );
}

function normalizeDeploymentLabel(label = '') {
  const value = safeString(label);
  if (!value) return null;

  const statusMatch = value.match(
    new RegExp(
      `\\b(region|zone|az|site|dc|datacenter|data\\s+center|cell)\\s*(${differentiatorPattern()})\\s*[-:/]\\s*(active|standby|passive|primary|secondary)\\b`,
      'i'
    )
  );

  if (statusMatch) {
    return `${capitalize(statusMatch[1])} ${statusMatch[2].toUpperCase()}`;
  }

  const scopeMatch = value.match(
    new RegExp(
      `\\b(region|zone|az|site|dc|datacenter|data\\s+center|cell)\\s*[-_:]?\\s*(${differentiatorPattern()})\\b`,
      'i'
    )
  );

  if (scopeMatch) {
    const scope = scopeMatch[1]
      .replace(/\s+/g, ' ')
      .replace(/^az$/i, 'AZ');

    const normalizedScope =
      /^AZ$/i.test(scope) ? 'AZ' : capitalize(scope);

    return `${normalizedScope} ${scopeMatch[2].toUpperCase()}`;
  }

  if (hasComponentSuffixRegionHint(value)) {
    const diff = extractDeploymentDifferentiator(value);
    return `Region ${safeString(diff).toUpperCase()}`;
  }

  return null;
}

function normalizeBoundaryCandidate(candidate = {}) {
  const rawText = safeString(candidate.rawText);

  if (!rawText) {
    return {
      keep: false,
      reason: 'empty_boundary',
    };
  }

  if (isGenericBoundaryLabel(rawText)) {
    return {
      keep: false,
      reason: 'generic_boundary_label',
      rawText,
    };
  }

  if (isDocumentNoise(rawText)) {
    return {
      keep: false,
      reason: 'document_noise',
      rawText,
    };
  }

  const deploymentRelevant =
    hasDeploymentScopeAndDifferentiator(rawText) ||
    hasComponentSuffixRegionHint(rawText);

  if (!deploymentRelevant) {
    return {
      keep: false,
      reason: 'not_deployment_relevant',
      rawText,
    };
  }

  const normalizedLabel =
    normalizeDeploymentLabel(rawText);

  if (!normalizedLabel) {
    return {
      keep: false,
      reason: 'normalization_failed',
      rawText,
    };
  }

  return {
    keep: true,
    boundaryId:
      `deployment_boundary_${slugify(normalizedLabel)}`,

    normalizedLabel,

    rawBoundaryLabel:
      safeString(candidate.rawBoundaryLabel) ||
      rawText,

    canonicalBoundaryType:
      safeString(candidate.canonicalBoundaryType) ||
      candidate.boundaryType ||
      'unknown',

    deploymentDifferentiator:
      safeString(candidate.deploymentDifferentiator) ||
      extractDeploymentDifferentiator(normalizedLabel),

    rawText,
    boundaryType: candidate.boundaryType || 'unknown',
    confidence:
      candidate.confidence === 'high' ? 'high' : 'medium',
    source: candidate.source || 'unknown',
    candidateSource: candidate.candidateSource || 'unknown',
    sceneIndexes: asArray(candidate.sceneIndexes),
    teachingUnitIds: asArray(candidate.teachingUnitIds),
    normalizationReason:
      normalizedLabel !== rawText
        ? 'normalized_from_deployment_boundary_or_component_suffix'
        : 'kept_as_deployment_boundary',
  };
}

function collectBoundaryCandidatesFromComponents(
  architectureUnderstanding = {}
) {
  const components =
    asArray(
      architectureUnderstanding?.deterministicGraph?.components
    );

  return components.flatMap((component) =>
    asArray(component.boundaries).map((boundary) => {
      const rawBoundaryLabel = safeString(
        boundary.rawBoundaryLabel ||
        boundary.rawText ||
        boundary.label
      );

      return {
        rawText: rawBoundaryLabel,
        rawBoundaryLabel,

        canonicalBoundaryType: safeString(
          boundary.canonicalBoundaryType ||
          boundary.boundaryType
        ),

        deploymentDifferentiator: safeString(
          boundary.deploymentDifferentiator
        ),

        boundaryType: safeString(boundary.boundaryType),
        confidence: boundary.confidence || 'unknown',
        source: boundary.source || 'component_boundary',
        sceneIndexes: asArray(boundary.sceneIndexes),
        teachingUnitIds: asArray(boundary.teachingUnitIds),
        candidateSource:
          'architectureUnderstanding.deterministicGraph.components.boundaries',
      };
    })
  );
}

function collectBoundaryCandidatesFromRegionTraversal(
  regionTraversal = {}
) {
  return asArray(regionTraversal.regions)
    .map((region) => ({
      rawText: safeString(
        region.architectureBoundary ||
        region.title
      ),
      boundaryType: 'region_traversal_boundary',
      confidence: region.confidence || 'medium',
      source: region.source || 'region-traversal.json',
      sceneIndexes: asArray(region.sceneIndexes),
      teachingUnitIds: asArray(region.teachingUnitIds),
      candidateSource: 'regionTraversal.regions',
    }))
    .filter((item) => item.rawText);
}

function mergeRegionBoundaries(boundaries = []) {
  const byId = new Map();

  for (const boundary of asArray(boundaries)) {
    if (!boundary.boundaryId) continue;

    if (!byId.has(boundary.boundaryId)) {
      byId.set(boundary.boundaryId, {
        boundaryId: boundary.boundaryId,
        normalizedLabel: boundary.normalizedLabel,
        deploymentDifferentiator:
          boundary.deploymentDifferentiator,
        rawTexts: [],
        boundaryTypes: [],
        sources: [],
        candidateSources: [],
        sceneIndexes: [],
        teachingUnitIds: [],
        confidence: boundary.confidence || 'medium',
        normalizationReason: boundary.normalizationReason,
      });
    }

    const existing = byId.get(boundary.boundaryId);

    existing.rawTexts.push(boundary.rawText);
    existing.boundaryTypes.push(boundary.boundaryType);
    existing.sources.push(boundary.source);
    existing.candidateSources.push(boundary.candidateSource);
    existing.sceneIndexes.push(...asArray(boundary.sceneIndexes));
    existing.teachingUnitIds.push(...asArray(boundary.teachingUnitIds));

    if (boundary.confidence === 'high') {
      existing.confidence = 'high';
    }
  }

  return Array.from(byId.values()).map((boundary) => ({
    ...boundary,
    rawTexts: uniq(boundary.rawTexts),
    boundaryTypes: uniq(boundary.boundaryTypes),
    sources: uniq(boundary.sources),
    candidateSources: uniq(boundary.candidateSources),
    sceneIndexes: uniq(boundary.sceneIndexes).map(Number),
    teachingUnitIds: uniq(boundary.teachingUnitIds),
  }));
}

function componentMatchesRegion(component = {}, region = {}) {
  const name = safeString(component.name);
  const diff = safeString(region.deploymentDifferentiator);

  if (!name || !diff) return false;
  if (isRegionHeaderComponentName(name)) return false;

  if (
    isSharedOrGlobalComponentName(name) &&
    !new RegExp(`\\b${diff}\\b`, 'i').test(name)
    ) {
  return false;
    }

    return (
    new RegExp(`\\b${diff}\\b`, 'i').test(name) ||
    new RegExp(`[-_ ]${diff}$`, 'i').test(name)
  );
}


function runtimeInstanceMatchesRegion(
  runtimeInstance = {},
  region = {}
) {
  const runtimeOrdinal =
    safeString(
      runtimeInstance.runtimeOrdinal
    );

  const deploymentDifferentiator =
    safeString(
      region.deploymentDifferentiator
    );

  if (
    !runtimeOrdinal ||
    !deploymentDifferentiator
  ) {
    return false;
  }

  return (
    safeLower(runtimeOrdinal) ===
    safeLower(deploymentDifferentiator)
  );
}


function collectVisualMembershipForBoundary({
  region = {},
  visualDeploymentEvidence = {},
} = {}) {
  const eligibleMemberships =
    asArray(
      visualDeploymentEvidence
        .deploymentEligibleMemberships
    );

  /*
   * BUG-2F V1 intentionally does NOT invent a new
   * deployment-boundary identity from the visual rail.
   *
   * Visual evidence may augment only an already-normalized
   * deployment boundary.
   *
   * We match through explicit normalized/canonical labels
   * carried by the eligible observation when available.
   */

  const normalizedLabel =
    safeLower(
      region.normalizedLabel
    );

  const matches =
    eligibleMemberships.filter(
      (membership) => {
        const targetLabel =
          normalizeDeploymentLabel(
            membership
              .deploymentBoundaryLabel
          );

        const targetNormalizedLabel =
          safeLower(
            targetLabel
          );

        /*
        * BUG-2F:
        *
        * Visual and existing deployment evidence converge
        * through the existing deployment-label
        * normalization contract.
        *
        * No visual-specific deployment identity.
        * No substring matching.
        * No fuzzy matching.
        * No differentiator-only matching.
        */

        return (
          normalizedLabel &&
          targetNormalizedLabel &&
          normalizedLabel ===
            targetNormalizedLabel
        );
      }
    );

  return {
    observations:
      matches,

    componentIds:
      uniq(
        matches
          .filter(
            (membership) =>
              membership
                .canonicalEntityType ===
              'component'
          )
          .map(
            (membership) =>
              membership.componentId ||
              membership.canonicalEntityId
          )
          .filter(Boolean)
      ),

    componentNames:
      uniq(
        matches
          .filter(
            (membership) =>
              membership
                .canonicalEntityType ===
              'component'
          )
          .map(
            (membership) =>
              membership.componentName ||
              membership.canonicalEntityName
          )
          .filter(Boolean)
      ),

    runtimeInstanceIds:
      uniq(
        matches
          .filter(
            (membership) =>
              membership
                .canonicalEntityType ===
              'runtime_instance'
          )
          .map(
            (membership) =>
              membership.runtimeInstanceId ||
              membership.canonicalEntityId
          )
          .filter(Boolean)
      ),
  };
}

function intersectValues(
  left = [],
  right = []
) {
  const rightSet =
    new Set(
      asArray(right)
    );

  return uniq(
    asArray(left).filter(
      (value) =>
        rightSet.has(value)
    )
  );
}

function subtractValues(
  left = [],
  right = []
) {
  const rightSet =
    new Set(
      asArray(right)
    );

  return uniq(
    asArray(left).filter(
      (value) =>
        !rightSet.has(value)
    )
  );
}

function mergeMembershipEvidence({
  existingComponentIds = [],
  existingComponentNames = [],
  existingMembershipSource = null,
  existingMembershipConfidence = 'low',
  visualMembership = {},
} = {}) {
  const existingIds =
    uniq(
      existingComponentIds
    );

  const visualIds =
    uniq(
      visualMembership
        .componentIds
    );

  const visualNames =
    uniq(
      visualMembership
        .componentNames
    );

  const existingHasEvidence =
    existingIds.length > 0;

  const visualHasEvidence =
    visualIds.length > 0;

  const agreedComponentIds =
    intersectValues(
      existingIds,
      visualIds
    );

  const existingOnlyComponentIds =
    subtractValues(
      existingIds,
      visualIds
    );

  const visualOnlyComponentIds =
    subtractValues(
      visualIds,
      existingIds
    );

  /*
   * No visual evidence:
   * preserve the existing behavior exactly.
   */

  if (
    !visualHasEvidence
  ) {
    return {
      componentIds:
        existingIds,

      componentNames:
        uniq(
          existingComponentNames
        ),

      membershipSource:
        existingMembershipSource,

      membershipConfidence:
        existingMembershipConfidence,

      membershipConflict:
        false,

      membershipConflictDetails:
        null,

      membershipEvidence: [
        {
          source:
            existingMembershipSource,

          componentIds:
            existingIds,

          confidence:
            existingMembershipConfidence,
        },
      ].filter(
        (item) =>
          safeString(
            item.source
          )
      ),
    };
  }

  /*
   * Visual-only membership can be used because BUG-2E
   * has already enforced:
   *
   * - resolved identity
   * - deployment-qualified boundary
   * - no label self-membership
   *
   * BUG-2F does not redo those decisions.
   */

  if (
    !existingHasEvidence &&
    visualHasEvidence
  ) {
    return {
      componentIds:
        visualIds,

      componentNames:
        visualNames,

      membershipSource:
        'visualDeploymentEvidence',

      membershipConfidence:
        'high',

      membershipConflict:
        false,

      membershipConflictDetails:
        null,

      membershipEvidence: [
        {
          source:
            'visualDeploymentEvidence',

          componentIds:
            visualIds,

          confidence:
            'high',

          observationIds:
            uniq(
              asArray(
                visualMembership
                  .observations
              ).map(
                (observation) =>
                  observation
                    .observationId
              )
            ),
        },
      ],
    };
  }

  /*
   * Both rails agree completely.
   */

  if (
    existingOnlyComponentIds.length === 0 &&
    visualOnlyComponentIds.length === 0
  ) {
    return {
      componentIds:
        existingIds,

      componentNames:
        uniq([
          ...asArray(
            existingComponentNames
          ),
          ...visualNames,
        ]),

      membershipSource:
        'corroborated_existing_and_visual',

      membershipConfidence:
        'high',

      membershipConflict:
        false,

      membershipConflictDetails:
        null,

      membershipEvidence: [
        {
          source:
            existingMembershipSource,

          componentIds:
            existingIds,

          confidence:
            existingMembershipConfidence,
        },

        {
          source:
            'visualDeploymentEvidence',

          componentIds:
            visualIds,

          confidence:
            'high',

          observationIds:
            uniq(
              asArray(
                visualMembership
                  .observations
              ).map(
                (observation) =>
                  observation
                    .observationId
              )
            ),
        },
      ],
    };
  }

  /*
   * Partial overlap is preserved as a conflict rather than
   * silently unioning or choosing one rail.
   */

  return {
    componentIds:
      agreedComponentIds,

    componentNames:
      [],

    membershipSource:
      'conflicting_existing_and_visual_evidence',

    membershipConfidence:
      'low',

    membershipConflict:
      true,

    membershipConflictDetails: {
      agreedComponentIds,

      existingComponentIds:
        existingIds,

      visualComponentIds:
        visualIds,

      existingOnlyComponentIds,

      visualOnlyComponentIds,

      existingSource:
        existingMembershipSource,

      visualSource:
        'visualDeploymentEvidence',

      visualObservationIds:
        uniq(
          asArray(
            visualMembership
              .observations
          ).map(
            (observation) =>
              observation
                .observationId
          )
        ),
    },

    membershipEvidence: [
      {
        source:
          existingMembershipSource,

        componentIds:
          existingIds,

        confidence:
          existingMembershipConfidence,
      },

      {
        source:
          'visualDeploymentEvidence',

        componentIds:
          visualIds,

        confidence:
          'high',
      },
    ],
  };
}

function assignRegionMembership({
  normalizedBoundaries = [],
  architectureUnderstanding = {},
  visualDeploymentEvidence = {},
} = {}) {
  const components =
    asArray(
      architectureUnderstanding
        ?.deterministicGraph
        ?.components
    );

  const runtimeInstances =
    asArray(
      architectureUnderstanding
        ?.deterministicGraph
        ?.runtimeInstances
    );

  return normalizedBoundaries.map(
    (region) => {
      const matchedRuntimeInstances =
        runtimeInstances.filter(
          (runtimeInstance) =>
            runtimeInstanceMatchesRegion(
              runtimeInstance,
              region
            )
        );

      const resolvedLogicalComponentIds =
        uniq(
          matchedRuntimeInstances
            .map(
              (instance) =>
                instance.logicalComponentId
            )
            .filter(Boolean)
        );

      const resolvedLogicalComponents =
        components.filter(
          (component) =>
            resolvedLogicalComponentIds.includes(
              component.id
            )
        );

      /*
       * Backward-compatible fallback for fixtures
       * that do not expose runtime instances.
       */
      const fallbackComponents =
        matchedRuntimeInstances.length === 0
          ? components.filter(
              (component) =>
                componentMatchesRegion(
                  component,
                  region
                )
            )
          : [];

      const finalComponents =
        matchedRuntimeInstances.length > 0
          ? resolvedLogicalComponents
          : fallbackComponents;

      const existingComponentIds =
        uniq(
          finalComponents.map(
            (component) =>
              component.id
          )
        );

      const existingComponentNames =
        uniq(
          finalComponents.map(
            (component) =>
              component.name
          )
        );

      const existingMembershipSource =
        matchedRuntimeInstances.length > 0
          ? 'architectureUnderstanding.deterministicGraph.runtimeInstances'
          : 'architectureUnderstanding.deterministicGraph.components.name_differentiator_fallback';

      const existingMembershipConfidence =
        matchedRuntimeInstances.length > 0
          ? 'high'
          : finalComponents.length > 0
            ? 'medium'
            : 'low';

      const visualMembership =
        collectVisualMembershipForBoundary({
          region,
          visualDeploymentEvidence,
        });

      const mergedMembership =
          mergeMembershipEvidence({
          existingComponentIds,
          existingComponentNames,
          existingMembershipSource,
          existingMembershipConfidence,
          visualMembership,
        });

      return {
        ...region,

        componentIds:
          mergedMembership
            .componentIds,

        componentNames:
          mergedMembership
            .componentNames,

        runtimeInstanceIds:
          uniq(
            matchedRuntimeInstances.map(
              (instance) =>
                instance.runtimeInstanceId
            )
          ),

        runtimeInstanceNames:
          uniq(
            matchedRuntimeInstances.map(
              (instance) =>
                instance.runtimeInstanceName
            )
          ),

        runtimeInstances:
          matchedRuntimeInstances,

        unresolvedRuntimeInstanceIds:
          uniq(
            matchedRuntimeInstances
              .filter(
                (instance) =>
                  !instance.logicalComponentId
              )
              .map(
                (instance) =>
                  instance.runtimeInstanceId
              )
          ),

        membershipSource:
          mergedMembership
            .membershipSource,

        membershipConfidence:
          mergedMembership
            .membershipConfidence,

        membershipEvidence:
          mergedMembership
            .membershipEvidence,

        membershipConflict:
          mergedMembership
            .membershipConflict,

        membershipConflictDetails:
          mergedMembership
            .membershipConflictDetails,

        visualMembershipObservationIds:
          uniq(
            asArray(
              visualMembership
                .observations
            ).map(
              (observation) =>
                observation.observationId
            )
          ),
      };
    }
  );
}

function buildNormalizationHealth({
  normalizedBoundaries = [],
  rejectedCandidates = [],
} = {}) {
  const duplicateIds =
    normalizedBoundaries
      .map((item) => item.boundaryId)
      .filter((id, index, ids) => ids.indexOf(id) !== index);

  const missingLabels =
    normalizedBoundaries.filter(
      (item) => !safeString(item.normalizedLabel)
    );

  const emptyMemberships =
    normalizedBoundaries.filter(
      (item) =>
        asArray(item.componentNames).length === 0 &&
        asArray(item.runtimeInstanceNames).length === 0
    );

  const membershipConflicts =
    normalizedBoundaries.filter(
      (boundary) =>
        boundary.membershipConflict ===
        true
    );

  const traversalChanged = false;

  const violations = [
    ...duplicateIds.map((boundaryId) => ({
      type: 'duplicate_boundary_id',
      severity: 'high',
      boundaryId,
    })),

    ...missingLabels.map((boundary) => ({
      type: 'missing_normalized_label',
      severity: 'high',
      boundaryId: boundary.boundaryId,
    })),
  ];

  return {
    version:
      'deployment-boundary-normalization-health-v2',
    valid:
      violations.length === 0 &&
      traversalChanged === false,
    violationCount: violations.length,
    duplicateBoundaryIdCount: duplicateIds.length,
    missingNormalizedLabelCount: missingLabels.length,
    emptyMembershipRegionCount:
      emptyMemberships.length,

    membershipConflictCount:
      membershipConflicts.length,

    rejectedCandidateCount:
      rejectedCandidates.length,

    traversalChanged,
    violations,
  };
}

function buildDeploymentBoundaryNormalization({
  architectureUnderstanding = {},
  regionTraversal = {},
  visualDeploymentEvidence = {},
  outputDir = null,
} = {}) {
  const rawCandidates = [
    ...collectBoundaryCandidatesFromComponents(
      architectureUnderstanding
    ),
    ...collectBoundaryCandidatesFromRegionTraversal(
      regionTraversal
    ),
  ];

  const normalizedResults =
    rawCandidates.map(normalizeBoundaryCandidate);

  const kept =
    normalizedResults.filter((item) => item.keep);

  const rejected =
    normalizedResults.filter((item) => !item.keep);

  const discoveredRegions =
    mergeRegionBoundaries(kept);

  const normalizedBoundaries =
    assignRegionMembership({
      normalizedBoundaries:
        discoveredRegions,

      architectureUnderstanding,

      visualDeploymentEvidence,
    });

  const rejectedBreakdown =
    rejected.reduce((acc, item) => {
      acc[item.reason || 'unknown'] =
        (acc[item.reason || 'unknown'] || 0) + 1;
      return acc;
    }, {});

  const health =
    buildNormalizationHealth({
      normalizedBoundaries,
      rejectedCandidates: rejected,
    });

  const payload = {
    version: BUILDER_VERSION,
    source:
      'deploymentBoundaryNormalizationBuilder',

    purpose:
      'Normalize noisy architecture boundary candidates into clean deployment regions and assign region membership from the full component graph.',

    rules: {
      traversalMutation: 'forbidden',
      llmGeneratedNormalization: 'forbidden',
      graphMutation: 'forbidden',
      deterministicOnly: true,
      regionDiscoveryBeforeMembership: true,
      sharedOrGlobalComponentsExcludedFromRegionMembership: true,
    },

    normalizedBoundaries,
    rejectedCandidates: rejected.slice(0, 50),
    health,

    stats: {
      rawCandidateCount: rawCandidates.length,
      discoveredRegionCount:
        discoveredRegions.length,
      normalizedBoundaryCount:
        normalizedBoundaries.length,
      rejectedCandidateCount:
        rejected.length,
      rejectedBreakdown,
      regionWithMembershipCount:
        normalizedBoundaries.filter(
          (region) =>
            asArray(region.componentNames).length > 0 ||
            asArray(region.runtimeInstanceNames).length > 0
        ).length,

      runtimeInstanceCount:
        normalizedBoundaries.reduce(
          (sum, region) =>
            sum +
            asArray(
              region.runtimeInstances
            ).length,
          0
        ),

      unresolvedRuntimeInstanceCount:
        normalizedBoundaries.reduce(
          (sum, region) =>
            sum +
            asArray(
              region.unresolvedRuntimeInstanceIds
            ).length,
          0
        ),

      visualMembershipObservationCount:
        normalizedBoundaries.reduce(
          (sum, region) =>
            sum +
            asArray(
              region
                .visualMembershipObservationIds
            ).length,
          0
        ),

      corroboratedMembershipRegionCount:
        normalizedBoundaries.filter(
          (region) =>
            region.membershipSource ===
            'corroborated_existing_and_visual'
        ).length,

      visualOnlyMembershipRegionCount:
        normalizedBoundaries.filter(
          (region) =>
            region.membershipSource ===
            'visualDeploymentEvidence'
        ).length,

      membershipConflictCount:
        normalizedBoundaries.filter(
          (region) =>
            region.membershipConflict ===
            true
        ).length,

      traversalChanged: false,
    },
  };

  if (outputDir) {
    fs.mkdirSync(outputDir, { recursive: true });

    fs.writeFileSync(
      path.join(
        outputDir,
        'deployment-boundaries-normalized.json'
      ),
      JSON.stringify(payload, null, 2),
      'utf8'
    );
  }

  return payload;
}

module.exports = {
  BUILDER_VERSION,
  buildDeploymentBoundaryNormalization,
};
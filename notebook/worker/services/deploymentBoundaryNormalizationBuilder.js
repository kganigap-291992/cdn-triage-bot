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

function assignRegionMembership({
  normalizedBoundaries = [],
  architectureUnderstanding = {},
} = {}) {
  const components =
    asArray(
      architectureUnderstanding?.deterministicGraph?.components
    );

  return normalizedBoundaries.map((region) => {
    const sourceBoundaryNames =
        asArray(region.rawTexts)
            .filter((name) =>
            componentMatchesRegion({ name }, region)
            );

        const matchedComponents =
        components.filter((component) =>
            componentMatchesRegion(component, region)
        );

        const componentIds =
        uniq(matchedComponents.map((component) => component.id));

        const componentNames =
        uniq([
            ...matchedComponents.map((component) => component.name),
            ...sourceBoundaryNames,
        ]);

    return {
        ...region,
        componentIds,
        componentNames,
        membershipSource:
            'architectureUnderstanding.deterministicGraph.components.name_differentiator_match_plus_source_boundaries',
        membershipConfidence:
            componentNames.length > 0 ? 'medium' : 'low',
        };
  });
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
      (item) => asArray(item.componentNames).length === 0
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
    emptyMembershipRegionCount: emptyMemberships.length,
    rejectedCandidateCount: rejectedCandidates.length,
    traversalChanged,
    violations,
  };
}

function buildDeploymentBoundaryNormalization({
  architectureUnderstanding = {},
  regionTraversal = {},
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
      normalizedBoundaries: discoveredRegions,
      architectureUnderstanding,
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
          (region) => asArray(region.componentNames).length > 0
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
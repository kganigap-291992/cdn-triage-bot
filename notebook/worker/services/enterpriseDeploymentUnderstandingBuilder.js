'use strict';

/**
 * enterpriseDeploymentUnderstandingBuilder.js
 *
 * BUG-17F — Enterprise Deployment Understanding
 *
 * Borrowed ideas:
 * - C4 deployment diagrams: regions/sites/zones contain runtime nodes.
 * - Kubernetes: same workload can appear in multiple zones/clusters.
 * - Cloud reference architectures: global entry + regional stacks + shared services.
 * - Observability topology maps: repeated groups and shared dependencies.
 * - DR patterns: mirrored topology, active-active, active-passive, standby.
 *
 * Rule:
 * - Prefer deployment-boundaries-normalized.json.
 * - Do not let raw OCR / boundary noise become deployment regions.
 * - Do not mutate traversal or graph truth.
 */

const fs = require('fs');
const path = require('path');

const BUILDER_VERSION = 'enterprise-deployment-understanding-v1';

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

function isTrueDeploymentRegion(label = '') {
  const text = safeString(label);

  return (
    /\b(region|zone|az|availability zone|site|dc|datacenter|data center|cell)\s+([a-z0-9]+|east|west|north|south|primary|secondary|active|standby|passive)\b/i.test(text) ||
    /\b(primary|secondary|active|standby|passive|east|west|north|south)\s+(region|zone|site|dc|datacenter|data center|cell)\b/i.test(text)
  );
}

function getRegionDifferentiator(label = '') {
  const text = safeLower(label);

  const explicit =
    text.match(/\b(region|zone|az|availability zone|site|dc|datacenter|data center|cell)\s+([a-z0-9]+|east|west|north|south|primary|secondary|active|standby|passive)\b/i);

  if (explicit) return explicit[2];

  const prefix =
    text.match(/\b(primary|secondary|active|standby|passive|east|west|north|south)\s+(region|zone|site|dc|datacenter|data center|cell)\b/i);

  if (prefix) return prefix[1];

  return null;
}

function getComponentBaseName(name = '') {
  return safeLower(name)
    .replace(/\b(region|zone|az|site|dc|datacenter|data center)\s+[a-z0-9]+\b/gi, '')
    .replace(/\b(primary|secondary|active|standby|passive|east|west|north|south)\b/gi, '')
    .replace(/\b[a-z]\b$/gi, '')
    .replace(/\b\d+\b/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function buildComponentIndex(architectureUnderstanding = {}) {
  const components = asArray(
    architectureUnderstanding?.deterministicGraph?.components
  );

  return new Map(
    components
      .filter((component) => component.id)
      .map((component) => [component.id, component])
  );
}

function buildRegionsFromNormalizedBoundaries(
  deploymentBoundaryNormalization = {}
) {
  return asArray(deploymentBoundaryNormalization.normalizedBoundaries)
    .filter((boundary) => isTrueDeploymentRegion(boundary.normalizedLabel))
    .map((boundary) => ({
      regionId: `deployment_region_${slugify(boundary.normalizedLabel)}`,
      title: boundary.normalizedLabel,
      regionDifferentiator: getRegionDifferentiator(boundary.normalizedLabel),
      sourceBoundary: asArray(boundary.rawTexts)[0] || boundary.normalizedLabel,
      sourceBoundaries: asArray(boundary.rawTexts),
      boundaryType:
        asArray(boundary.boundaryTypes)[0] || 'normalized_deployment_boundary',
      componentIds: asArray(boundary.componentIds),
      componentNames: asArray(boundary.componentNames),
      sceneIndexes: asArray(boundary.sceneIndexes),
      teachingUnitIds: asArray(boundary.teachingUnitIds),
      confidence: boundary.confidence || 'medium',
      evidenceSources: asArray(boundary.candidateSources),
      source: 'deployment-boundaries-normalized.json',
    }));
}

function buildFallbackRegions(regionTraversal = {}) {
  return asArray(regionTraversal.regions)
    .filter((region) => isTrueDeploymentRegion(region.title))
    .map((region) => ({
      regionId: `deployment_region_${slugify(region.title)}`,
      title: region.title,
      regionDifferentiator: getRegionDifferentiator(region.title),
      sourceBoundary: region.title,
      sourceBoundaries: [region.title],
      boundaryType: 'region_traversal_fallback',
      componentIds: [],
      componentNames: asArray(region.components),
      sceneIndexes: asArray(region.sceneIndexes),
      teachingUnitIds: asArray(region.teachingUnitIds),
      confidence: 'low',
      evidenceSources: ['region-traversal.json'],
      source: 'region-traversal.json',
    }));
}

function buildDeploymentRegions({
  deploymentBoundaryNormalization = {},
  regionTraversal = {},
} = {}) {
  const normalizedRegions =
    buildRegionsFromNormalizedBoundaries(deploymentBoundaryNormalization);

  if (normalizedRegions.length) {
    return normalizedRegions;
  }

  return buildFallbackRegions(regionTraversal);
}

function buildRegionTopologyProfiles({
  regions = [],
  architectureUnderstanding = {},
} = {}) {
  const componentById = buildComponentIndex(architectureUnderstanding);

  return asArray(regions).map((region) => {
    const matchedComponents =
      asArray(region.componentIds)
        .map((id) => componentById.get(id))
        .filter(Boolean);

    const componentNames =
      matchedComponents.length
        ? matchedComponents.map((component) => component.name)
        : asArray(region.componentNames);

    const baseComponentNames =
      uniq(
        componentNames
          .map(getComponentBaseName)
          .filter(Boolean)
          .filter((name) => !['region', 'architecture', 'generic'].includes(name))
      );

    return {
      regionId: region.regionId,
      title: region.title,
      componentCount: componentNames.length,
      componentNames,
      baseComponentNames,
      roleBreakdown:
        matchedComponents.reduce((acc, component) => {
          acc[component.role || component.type || 'unknown'] =
            (acc[component.role || component.type || 'unknown'] || 0) + 1;
          return acc;
        }, {}),
    };
  });
}

function jaccardSimilarity(a = [], b = []) {
  const left = new Set(a);
  const right = new Set(b);

  if (!left.size || !right.size) return 0;

  const intersection =
    [...left].filter((item) => right.has(item)).length;

  const union = new Set([...left, ...right]).size;

  return union ? intersection / union : 0;
}

function buildReplicatedRegionCandidates(profiles = []) {
  const candidates = [];

  for (let i = 0; i < profiles.length; i += 1) {
    for (let j = i + 1; j < profiles.length; j += 1) {
      const left = profiles[i];
      const right = profiles[j];

      if (!left.baseComponentNames.length || !right.baseComponentNames.length) {
        continue;
      }

      const similarity =
        jaccardSimilarity(left.baseComponentNames, right.baseComponentNames);

      if (similarity < 0.45) continue;

      candidates.push({
        replicationId:
          `replicated_regions_${slugify(left.title)}_${slugify(right.title)}`,
        regionA: left.title,
        regionB: right.title,
        regionIds: [left.regionId, right.regionId],
        similarity: Number(similarity.toFixed(2)),
        sharedBaseComponents:
          left.baseComponentNames.filter((name) =>
            right.baseComponentNames.includes(name)
          ),
        classification:
          similarity >= 0.75
            ? 'mirrored_topology_candidate'
            : 'partial_replication_candidate',
        confidence: similarity >= 0.75 ? 'medium' : 'low',
        source: 'normalized_region_topology_profile_similarity',
      });
    }
  }

  return candidates;
}


function buildCrossRegionRelationshipSummary({
  bidirectionalRailUnderstanding = {},
  multiRailUnderstanding = {},
} = {}) {
  const bidirectionalRails =
    asArray(bidirectionalRailUnderstanding.bidirectionalRails);

  const supportingRails =
    asArray(multiRailUnderstanding.rails).filter((rail) =>
      ['state_journey', 'control_journey', 'observability_journey'].includes(
        rail.railCategory
      )
    );

  return {
    bidirectionalRailCount: bidirectionalRails.length,
    supportingRailCount: supportingRails.length,
    bidirectionalRails: bidirectionalRails.map((rail) => ({
      flowLaneId: rail.flowLaneId,
      flowLaneType: rail.flowLaneType,
      teachingHint: rail.teachingHint,
      reverseCapable: rail.reverseCapable,
      reverseObserved: rail.reverseObserved,
    })),
    supportingRails: supportingRails.map((rail) => ({
      railId: rail.railId,
      railCategory: rail.railCategory,
      railRelationship: rail.railRelationship,
      teachingHint: rail.railRelationshipTeachingHint,
    })),
  };
}

function classifyDeploymentPattern({
  regions = [],
  replicatedRegionCandidates = [],
  crossRegionRelationships = {},
} = {}) {
  if (regions.length <= 1) {
    return {
      pattern: 'single_region_or_unknown',
      confidence: 'low',
      reason: 'Fewer than two deployment regions were detected.',
    };
  }

  if (replicatedRegionCandidates.length > 0) {
    const hasBidirectional =
      Number(crossRegionRelationships.bidirectionalRailCount || 0) > 0;

    return {
      pattern: hasBidirectional
        ? 'active_active_or_synchronized_mirrored_topology'
        : 'mirrored_topology',
      confidence: hasBidirectional ? 'medium' : 'low',
      reason: hasBidirectional
        ? 'Multiple normalized deployment regions have similar topology and bidirectional or sync-style rails exist.'
        : 'Multiple normalized deployment regions have similar topology, but sync/failover evidence is limited.',
    };
  }

  return {
    pattern: 'multi_region_unknown_relationship',
    confidence: 'low',
    reason:
      'Multiple deployment regions were detected, but topology similarity was not strong enough to classify replication.',
  };
}

function buildTeachingMetadata({
  deploymentPattern = {},
  replicatedRegionCandidates = [],
  sharedInfrastructure = [],
} = {}) {
  const safeTeachingClaims = [];

  if (replicatedRegionCandidates.length > 0) {
    safeTeachingClaims.push({
      claimType: 'replicated_region_candidate',
      text:
        'Multiple deployment regions appear to contain similar architecture structure. Teach this as a candidate mirrored deployment, not as guaranteed failover.',
      confidence: replicatedRegionCandidates[0].confidence || 'low',
    });
  }

  if (sharedInfrastructure.length > 0) {
    safeTeachingClaims.push({
      claimType: 'shared_infrastructure',
      text:
        'Some components participate across multiple rails or responsibilities. Teach them as shared infrastructure only when tied to supporting evidence.',
      confidence: 'medium',
    });
  }

  if (deploymentPattern.pattern) {
    safeTeachingClaims.push({
      claimType: 'deployment_pattern',
      text:
        `Deployment pattern classified as ${deploymentPattern.pattern} with ${deploymentPattern.confidence} confidence.`,
      confidence: deploymentPattern.confidence,
    });
  }

  return {
    safeTeachingClaims,
    narrationSafety: {
      doNotClaimFailoverUnlessEvidenceBacked: true,
      doNotClaimActiveActiveUnlessSyncOrParallelEvidenceBacked: true,
      regionReplicationIsCandidateUnlessHighConfidence: true,
      traversalChanged: false,
    },
  };
}

function buildEnterpriseDeploymentHealth({
  regions = [],
  deploymentPattern = {},
} = {}) {
  const missingRegionIds =
    regions.filter((region) => !safeString(region.regionId));

  const nonDeploymentRegionLabels =
    regions.filter((region) => !isTrueDeploymentRegion(region.title));

  const traversalChanged = false;

  const violations = [
    ...missingRegionIds.map((region) => ({
      type: 'missing_region_id',
      severity: 'high',
      title: region.title || null,
    })),

    ...nonDeploymentRegionLabels.map((region) => ({
      type: 'non_deployment_region_label',
      severity: 'high',
      regionId: region.regionId,
      title: region.title,
    })),
  ];

  return {
    version: 'enterprise-deployment-understanding-health-v1',
    valid: violations.length === 0 && traversalChanged === false,
    violationCount: violations.length,
    missingRegionIdCount: missingRegionIds.length,
    nonDeploymentRegionLabelCount: nonDeploymentRegionLabels.length,
    deploymentPatternKnown: safeString(deploymentPattern.pattern) !== '',
    traversalChanged,
    violations,
  };
}

function buildEnterpriseDeploymentUnderstanding({
  architectureUnderstanding = {},
  regionTraversal = {},
  deploymentBoundaryNormalization = {},
  sharedNodeUnderstanding = {},
  enterpriseSharedInfrastructure = {},
  multiRailUnderstanding = {},
  bidirectionalRailUnderstanding = {},
  outputDir = null,
} = {}) {
  const regions =
    buildDeploymentRegions({
      deploymentBoundaryNormalization,
      regionTraversal,
    });

  const regionTopologyProfiles =
    buildRegionTopologyProfiles({
      regions,
      architectureUnderstanding,
    });

  const replicatedRegionCandidates =
    buildReplicatedRegionCandidates(regionTopologyProfiles);

  const sharedInfrastructure =
    asArray(
      enterpriseSharedInfrastructure.sharedInfrastructure
    );

  const crossRegionRelationships =
    buildCrossRegionRelationshipSummary({
      bidirectionalRailUnderstanding,
      multiRailUnderstanding,
    });

  const deploymentPattern =
    classifyDeploymentPattern({
      regions,
      replicatedRegionCandidates,
      crossRegionRelationships,
    });

  const teachingMetadata =
    buildTeachingMetadata({
      deploymentPattern,
      replicatedRegionCandidates,
      sharedInfrastructure,
    });

  const health =
    buildEnterpriseDeploymentHealth({
      regions,
      deploymentPattern,
    });

  const payload = {
    version: BUILDER_VERSION,
    source: 'enterpriseDeploymentUnderstandingBuilder',

    purpose:
      'Create deterministic enterprise deployment understanding from normalized deployment boundaries, canonical enterprise shared infrastructure, region traversal, multi-rail, and bidirectional architecture cognition.',

    rules: {
      traversalMutation: 'forbidden',
      llmGeneratedDeploymentUnderstanding: 'forbidden',
      graphMutation: 'forbidden',
      narrationGeneration: 'forbidden',
      deterministicOnly: true,
      normalizedDeploymentBoundariesPreferred: true,
      sharedInfrastructureSource:
        'enterprise-shared-infrastructure.json',
    },

    regions,
    regionTopologyProfiles,
    replicatedRegionCandidates,
    sharedInfrastructure,
    crossRegionRelationships,
    deploymentPattern,
    teachingMetadata,
    health,

    sourceArtifacts: {
      enterpriseSharedInfrastructure:
        enterpriseSharedInfrastructure.version || null,
    },



    stats: {
      regionCount: regions.length,
      regionTopologyProfileCount: regionTopologyProfiles.length,
      replicatedRegionCandidateCount: replicatedRegionCandidates.length,
      sharedInfrastructureCount: sharedInfrastructure.length,
      bidirectionalRailCount:
        crossRegionRelationships.bidirectionalRailCount,
      deploymentPattern: deploymentPattern.pattern || 'unknown',
      traversalChanged: false,
    },
  };

  if (outputDir) {
    fs.mkdirSync(outputDir, { recursive: true });

    fs.writeFileSync(
      path.join(outputDir, 'enterprise-deployment-understanding.json'),
      JSON.stringify(payload, null, 2),
      'utf8'
    );
  }

  return payload;
}

module.exports = {
  BUILDER_VERSION,
  buildEnterpriseDeploymentUnderstanding,
};
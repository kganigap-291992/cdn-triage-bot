'use strict';

/**
 * deploymentUnitDiscoveryBuilder.js
 *
 * BUG-17F.2 — Deployment Unit Discovery
 *
 * Owns:
 * - convert explicit normalized deployment boundaries into deployment units
 * - prepare a stable deployment-unit model for later implicit graph grouping
 *
 * Borrowed ideas:
 * - C4 deployment diagrams: deployment nodes contain runtime components.
 * - Kubernetes: workloads can be grouped into deployment units.
 * - Network topology: sites, branches, clusters, cells, and regions are all units.
 * - Graph theory: explicit units first; implicit communities later.
 *
 * Does NOT:
 * - infer deployment pattern
 * - detect replica relationships
 * - detect shared infrastructure
 * - mutate traversal
 * - narrate
 * - call LLM
 */

const fs = require('fs');
const path = require('path');

const BUILDER_VERSION = 'deployment-unit-discovery-v1';

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

function inferDeploymentUnitScope(label = '') {
  const value = safeLower(label);

  if (/\bregion\b/.test(value)) return 'region';
  if (/\bavailability zone\b|\baz\b/.test(value)) return 'availability_zone';
  if (/\bdata center\b|\bdatacenter\b|\bdc\b/.test(value)) return 'data_center';
  if (/\bsite\b/.test(value)) return 'site';
  if (/\bcell\b/.test(value)) return 'cell';
  if (/\bcluster\b/.test(value)) return 'cluster';

  return 'deployment_unit';
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

function hydrateComponents({
  componentIds = [],
  componentNames = [],
  architectureUnderstanding = {},
} = {}) {
  const componentById = buildComponentIndex(architectureUnderstanding);

  const fromIds =
    asArray(componentIds)
      .map((componentId) => componentById.get(componentId))
      .filter(Boolean)
      .map((component) => ({
        componentId: component.id,
        componentName: component.name,
        architectureRole:
          component.architectureRole ||
          component.role ||
          component.type ||
          'unknown',
        source: 'architecture-understanding.json',
      }));

  const knownNames = new Set(
    fromIds.map((component) =>
      safeLower(component.componentName)
    )
  );

  const fromNames =
    asArray(componentNames)
      .filter((name) => !knownNames.has(safeLower(name)))
      .map((name) => ({
        componentId: null,
        componentName: safeString(name),
        architectureRole: 'unknown',
        source: 'deployment-boundaries-normalized.json',
      }));

  return [...fromIds, ...fromNames];
}

function buildExplicitDeploymentUnits({
  deploymentBoundaryNormalization = {},
  architectureUnderstanding = {},
} = {}) {
  return asArray(deploymentBoundaryNormalization.normalizedBoundaries)
    .map((boundary, index) => {
      const title = safeString(
        boundary.normalizedLabel ||
        `Deployment Unit ${index + 1}`
      );

      const components = hydrateComponents({
        componentIds: boundary.componentIds,
        componentNames: boundary.componentNames,
        architectureUnderstanding,
      });

      return {
        deploymentUnitId:
          `deployment_unit_${slugify(title)}`,
        title,
        unitType: 'explicit_deployment_boundary',
        unitScope: inferDeploymentUnitScope(title),
        sourceBoundaryId: boundary.boundaryId || null,
        sourceBoundaries: asArray(boundary.rawTexts),
        deploymentDifferentiator:
          boundary.deploymentDifferentiator || null,
        componentIds:
          uniq(components.map((component) => component.componentId)),
        componentNames:
          uniq(components.map((component) => component.componentName)),
        components,
        evidenceSources:
          asArray(boundary.candidateSources),
        confidence: boundary.confidence || 'medium',
        source: 'deployment-boundaries-normalized.json',
      };
    })
    .filter((unit) => unit.componentNames.length > 0);
}

function buildImplicitDeploymentUnits({
  architectureUnderstanding = {},
} = {}) {
  const relationships = asArray(
    architectureUnderstanding?.deterministicGraph?.relationships
  );

  return {
    status: 'not_implemented',
    reason:
      'Implicit deployment unit discovery will be added after explicit deployment units are stable.',
    relationshipCount: relationships.length,
    deploymentUnits: [],
  };
}

function buildDeploymentUnitHealth({
  deploymentUnits = [],
  explicitDeploymentUnits = [],
  implicitDiscovery = {},
} = {}) {
  const missingIds =
    deploymentUnits.filter((unit) =>
      !safeString(unit.deploymentUnitId)
    );

  const missingTitles =
    deploymentUnits.filter((unit) =>
      !safeString(unit.title)
    );

  const emptyUnits =
    deploymentUnits.filter((unit) =>
      asArray(unit.componentNames).length === 0
    );

  const duplicateIds =
    deploymentUnits
      .map((unit) => unit.deploymentUnitId)
      .filter((id, index, ids) => ids.indexOf(id) !== index);

  const traversalChanged = false;

  const violations = [
    ...missingIds.map((unit) => ({
      type: 'missing_deployment_unit_id',
      severity: 'high',
      title: unit.title || null,
    })),

    ...missingTitles.map((unit) => ({
      type: 'missing_deployment_unit_title',
      severity: 'high',
      deploymentUnitId: unit.deploymentUnitId || null,
    })),

    ...emptyUnits.map((unit) => ({
      type: 'empty_deployment_unit',
      severity: 'medium',
      deploymentUnitId: unit.deploymentUnitId,
      title: unit.title,
    })),

    ...duplicateIds.map((deploymentUnitId) => ({
      type: 'duplicate_deployment_unit_id',
      severity: 'high',
      deploymentUnitId,
    })),
  ];

  return {
    version: 'deployment-unit-discovery-health-v1',
    valid:
      violations.length === 0 &&
      traversalChanged === false,
    violationCount: violations.length,
    missingDeploymentUnitIdCount: missingIds.length,
    missingDeploymentUnitTitleCount: missingTitles.length,
    emptyDeploymentUnitCount: emptyUnits.length,
    duplicateDeploymentUnitIdCount: duplicateIds.length,
    explicitDeploymentUnitCount:
      explicitDeploymentUnits.length,
    implicitDeploymentUnitCount:
      asArray(implicitDiscovery.deploymentUnits).length,
    implicitDiscoveryStatus:
      implicitDiscovery.status || 'unknown',
    traversalChanged,
    violations,
  };
}

function buildDeploymentUnitDiscovery({
  architectureUnderstanding = {},
  deploymentBoundaryNormalization = {},
  outputDir = null,
} = {}) {
  const explicitDeploymentUnits =
    buildExplicitDeploymentUnits({
      deploymentBoundaryNormalization,
      architectureUnderstanding,
    });

  const implicitDiscovery =
    buildImplicitDeploymentUnits({
      architectureUnderstanding,
    });

  const implicitDeploymentUnits =
    asArray(implicitDiscovery.deploymentUnits);

  const deploymentUnits = [
    ...explicitDeploymentUnits,
    ...implicitDeploymentUnits,
  ];

  const health =
    buildDeploymentUnitHealth({
      deploymentUnits,
      explicitDeploymentUnits,
      implicitDiscovery,
    });

  const payload = {
    version: BUILDER_VERSION,
    source: 'deploymentUnitDiscoveryBuilder',

    purpose:
      'Discover explicit and implicit enterprise deployment units without inferring deployment patterns or mutating traversal.',

    rules: {
      traversalMutation: 'forbidden',
      llmGeneratedDeploymentUnits: 'forbidden',
      graphMutation: 'forbidden',
      deterministicOnly: true,
      explicitBoundariesPreferred: true,
      unlabeledGroupsMustNotBeCalledRegions: true,
      implicitGroupsRequireGraphEvidence: true,
    },

    explicitDeploymentUnits,
    implicitDiscovery,
    deploymentUnits,
    health,

    stats: {
      explicitDeploymentUnitCount:
        explicitDeploymentUnits.length,
      implicitDeploymentUnitCount:
        implicitDeploymentUnits.length,
      deploymentUnitCount:
        deploymentUnits.length,
      deploymentUnitWithComponentsCount:
        deploymentUnits.filter(
          (unit) => asArray(unit.componentNames).length > 0
        ).length,
      implicitDiscoveryStatus:
        implicitDiscovery.status || 'unknown',
      traversalChanged: false,
    },
  };

  if (outputDir) {
    fs.mkdirSync(outputDir, { recursive: true });

    fs.writeFileSync(
      path.join(outputDir, 'deployment-units.json'),
      JSON.stringify(payload, null, 2),
      'utf8'
    );
  }

  return payload;
}

module.exports = {
  BUILDER_VERSION,
  buildDeploymentUnitDiscovery,
};
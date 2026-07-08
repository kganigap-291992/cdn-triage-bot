'use strict';

/**
 * enterpriseTopologyBuilder.js
 *
 * BUG-17F.3 — Canonical Enterprise Topology Model
 *
 * Borrowed ideas, not reinvented:
 * - C4 deployment view: deployment units contain runtime components.
 * - Kubernetes topology: workloads live inside clusters/zones/namespaces.
 * - Cloud reference architectures: global entry, regional stacks, shared services.
 * - Network topology: ingress, egress, fan-in, fan-out, aggregation points.
 * - Graph theory: nodes, edges, cross-boundary relationships.
 * - Observability service maps: shared services and dependency hubs.
 *
 * Owns:
 * - canonical enterprise topology artifact
 * - deployment unit membership map
 * - graph-backed shared infrastructure
 * - cross-unit relationships
 * - fan-in / fan-out / aggregation candidates
 * - traffic entry / exit points
 *
 * Does NOT:
 * - classify final deployment pattern
 * - claim failover / active-active
 * - mutate traversal
 * - narrate
 * - call LLM
 */

const fs = require('fs');
const path = require('path');

const BUILDER_VERSION = 'enterprise-topology-v1';

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

function buildComponentIndex(architectureUnderstanding = {}) {
  const components = asArray(
    architectureUnderstanding?.deterministicGraph?.components
  );

  const byId = new Map();
  const byName = new Map();

  for (const component of components) {
    if (component.id) byId.set(component.id, component);
    if (component.name) byName.set(safeLower(component.name), component);
  }

  return { byId, byName, components };
}

function buildRelationshipIndex(architectureUnderstanding = {}) {
  return asArray(
    architectureUnderstanding?.deterministicGraph?.relationships
  ).filter((relationship) => relationship.from && relationship.to);
}

function normalizeDeploymentUnit(unit = {}) {
  return {
    deploymentUnitId:
      unit.deploymentUnitId || `deployment_unit_${slugify(unit.title)}`,
    title: unit.title || 'Unknown Deployment Unit',
    unitType: unit.unitType || 'deployment_unit',
    unitScope: unit.unitScope || 'deployment_unit',
    deploymentDifferentiator:
      unit.deploymentDifferentiator || null,
    sourceBoundaryId: unit.sourceBoundaryId || null,
    sourceBoundaries: asArray(unit.sourceBoundaries),
    componentIds: uniq(unit.componentIds),
    componentNames: uniq(unit.componentNames),
    components: asArray(unit.components),
    confidence: unit.confidence || 'medium',
    source: unit.source || 'deployment-units.json',
  };
}

function buildDeploymentUnits(deploymentUnitDiscovery = {}) {
  return asArray(deploymentUnitDiscovery.deploymentUnits)
    .map(normalizeDeploymentUnit)
    .filter((unit) => unit.deploymentUnitId && unit.title);
}

function buildComponentToDeploymentUnit({
  deploymentUnits = [],
} = {}) {
  const componentToDeploymentUnit = {};

  for (const unit of deploymentUnits) {
    for (const componentId of asArray(unit.componentIds)) {
      if (!componentId) continue;

      componentToDeploymentUnit[componentId] = {
        deploymentUnitId: unit.deploymentUnitId,
        deploymentUnitTitle: unit.title,
        matchType: 'component_id',
        confidence: unit.confidence || 'medium',
        source: 'deployment-units.json',
      };
    }

    for (const componentName of asArray(unit.componentNames)) {
      if (!componentName) continue;

      const key = `name:${safeLower(componentName)}`;

      if (componentToDeploymentUnit[key]) continue;

      componentToDeploymentUnit[key] = {
        deploymentUnitId: unit.deploymentUnitId,
        deploymentUnitTitle: unit.title,
        matchType: 'component_name',
        confidence: unit.confidence || 'medium',
        source: 'deployment-units.json',
      };
    }
  }

  return componentToDeploymentUnit;
}

function resolveComponentDeploymentUnit({
  componentId,
  componentName,
  componentToDeploymentUnit = {},
} = {}) {
  return (
    componentToDeploymentUnit[componentId] ||
    componentToDeploymentUnit[`name:${safeLower(componentName)}`] ||
    null
  );
}

function resolveRelationshipEndpoint({
  endpointId,
  componentIndex = {},
} = {}) {
  const byId = componentIndex.byId || new Map();
  const byName = componentIndex.byName || new Map();

  return (
    byId.get(endpointId) ||
    byName.get(safeLower(endpointId)) ||
    {
      id: endpointId,
      name: endpointId,
    }
  );
}

function buildCrossUnitRelationships({
  relationships = [],
  componentIndex = {},
  componentToDeploymentUnit = {},
} = {}) {
  return relationships
    .map((relationship, index) => {
      const fromComponent = resolveRelationshipEndpoint({
        endpointId: relationship.from,
        componentIndex,
      });

      const toComponent = resolveRelationshipEndpoint({
        endpointId: relationship.to,
        componentIndex,
      });

      const fromUnit = resolveComponentDeploymentUnit({
        componentId: fromComponent.id,
        componentName: fromComponent.name,
        componentToDeploymentUnit,
      });

      const toUnit = resolveComponentDeploymentUnit({
        componentId: toComponent.id,
        componentName: toComponent.name,
        componentToDeploymentUnit,
      });

      if (!fromUnit || !toUnit) return null;
      if (fromUnit.deploymentUnitId === toUnit.deploymentUnitId) return null;

      return {
        relationshipId:
          relationship.id ||
          `cross_unit_relationship_${index + 1}`,
        fromComponentId: fromComponent.id || null,
        fromComponentName: fromComponent.name || relationship.from,
        toComponentId: toComponent.id || null,
        toComponentName: toComponent.name || relationship.to,
        fromDeploymentUnitId: fromUnit.deploymentUnitId,
        fromDeploymentUnitTitle: fromUnit.deploymentUnitTitle,
        toDeploymentUnitId: toUnit.deploymentUnitId,
        toDeploymentUnitTitle: toUnit.deploymentUnitTitle,
        relationshipType:
          relationship.type ||
          relationship.relationshipType ||
          'architecture_relationship',
        confidence: relationship.confidence || 'unknown',
        evidenceIds: asArray(relationship.evidenceIds),
        source: 'architecture-understanding.json',
        traversalChanged: false,
      };
    })
    .filter(Boolean);
}

function buildDegreeMap(relationships = []) {
  const degree = new Map();

  function ensure(name) {
    if (!degree.has(name)) {
      degree.set(name, {
        componentName: name,
        incoming: [],
        outgoing: [],
      });
    }

    return degree.get(name);
  }

  for (const relationship of relationships) {
    const from = safeString(relationship.from);
    const to = safeString(relationship.to);

    if (!from || !to) continue;

    ensure(from).outgoing.push(relationship);
    ensure(to).incoming.push(relationship);
  }

  return degree;
}

function buildAggregationPoints({
  relationships = [],
  componentToDeploymentUnit = {},
  componentIndex = {},
} = {}) {
  const degree = buildDegreeMap(relationships);

  return Array.from(degree.values())
    .filter((item) => item.incoming.length >= 2)
    .map((item) => {
      const component = resolveRelationshipEndpoint({
        endpointId: item.componentName,
        componentIndex,
      });

      const deploymentUnit = resolveComponentDeploymentUnit({
        componentId: component.id,
        componentName: component.name,
        componentToDeploymentUnit,
      });

      return {
        componentId: component.id || null,
        componentName: component.name || item.componentName,
        deploymentUnitId: deploymentUnit?.deploymentUnitId || null,
        deploymentUnitTitle: deploymentUnit?.deploymentUnitTitle || null,
        incomingRelationshipCount: item.incoming.length,
        incomingFrom: uniq(item.incoming.map((rel) => rel.from)),
        topologyRole: 'aggregation_point',
        borrowedIdea: 'network_topology_fan_in',
        confidence: 'medium',
        source: 'architecture-understanding.json',
      };
    });
}

function buildFanOutPoints({
  relationships = [],
  componentToDeploymentUnit = {},
  componentIndex = {},
} = {}) {
  const degree = buildDegreeMap(relationships);

  return Array.from(degree.values())
    .filter((item) => item.outgoing.length >= 2)
    .map((item) => {
      const component = resolveRelationshipEndpoint({
        endpointId: item.componentName,
        componentIndex,
      });

      const deploymentUnit = resolveComponentDeploymentUnit({
        componentId: component.id,
        componentName: component.name,
        componentToDeploymentUnit,
      });

      return {
        componentId: component.id || null,
        componentName: component.name || item.componentName,
        deploymentUnitId: deploymentUnit?.deploymentUnitId || null,
        deploymentUnitTitle: deploymentUnit?.deploymentUnitTitle || null,
        outgoingRelationshipCount: item.outgoing.length,
        outgoingTo: uniq(item.outgoing.map((rel) => rel.to)),
        topologyRole: 'fan_out_point',
        borrowedIdea: 'network_topology_fan_out',
        confidence: 'medium',
        source: 'architecture-understanding.json',
      };
    });
}

function classifyEntryRole(componentName = '') {
  const value = safeLower(componentName);

  if (/\b(global dns|dns|traffic steering|load balancer|edge|cdn|gateway|ingress|client)\b/.test(value)) {
    return true;
  }

  return false;
}

function classifyExitRole(componentName = '') {
  const value = safeLower(componentName);

  if (/\b(client|cdn|edge|cache|object storage|database|db|storage|origin|collector|metrics|alerts)\b/.test(value)) {
    return true;
  }

  return false;
}

function buildTrafficEntryPoints({
  relationships = [],
  componentIndex = {},
  componentToDeploymentUnit = {},
} = {}) {
  const targets = new Set(relationships.map((rel) => safeString(rel.to)));
  const sources = uniq(relationships.map((rel) => rel.from));

  return sources
    .filter((source) => !targets.has(source) || classifyEntryRole(source))
    .map((source) => {
      const component = resolveRelationshipEndpoint({
        endpointId: source,
        componentIndex,
      });

      const deploymentUnit = resolveComponentDeploymentUnit({
        componentId: component.id,
        componentName: component.name,
        componentToDeploymentUnit,
      });

      return {
        componentId: component.id || null,
        componentName: component.name || source,
        deploymentUnitId: deploymentUnit?.deploymentUnitId || null,
        deploymentUnitTitle: deploymentUnit?.deploymentUnitTitle || null,
        topologyRole: 'traffic_entry_point',
        borrowedIdea: 'cloud_global_entry_or_network_ingress',
        confidence: classifyEntryRole(source) ? 'medium' : 'low',
        source: 'architecture-understanding.json',
      };
    });
}

function buildTrafficExitPoints({
  relationships = [],
  componentIndex = {},
  componentToDeploymentUnit = {},
} = {}) {
  const sources = new Set(relationships.map((rel) => safeString(rel.from)));
  const targets = uniq(relationships.map((rel) => rel.to));

  return targets
    .filter((target) => !sources.has(target) || classifyExitRole(target))
    .map((target) => {
      const component = resolveRelationshipEndpoint({
        endpointId: target,
        componentIndex,
      });

      const deploymentUnit = resolveComponentDeploymentUnit({
        componentId: component.id,
        componentName: component.name,
        componentToDeploymentUnit,
      });

      return {
        componentId: component.id || null,
        componentName: component.name || target,
        deploymentUnitId: deploymentUnit?.deploymentUnitId || null,
        deploymentUnitTitle: deploymentUnit?.deploymentUnitTitle || null,
        topologyRole: 'traffic_exit_point',
        borrowedIdea: 'network_egress_or_terminal_node',
        confidence: classifyExitRole(target) ? 'medium' : 'low',
        source: 'architecture-understanding.json',
      };
    });
}

function buildSharedInfrastructure({
  sharedNodeUnderstanding = {},
  componentToDeploymentUnit = {},
  componentIndex = {},
} = {}) {
  return asArray(sharedNodeUnderstanding.nodes).map((node) => {
    const component =
      componentIndex.byId.get(node.nodeId) ||
      componentIndex.byName.get(safeLower(node.nodeName)) ||
      null;

    const deploymentUnit = resolveComponentDeploymentUnit({
      componentId: component?.id || node.nodeId,
      componentName: component?.name || node.nodeName,
      componentToDeploymentUnit,
    });

    return {
      nodeId: node.nodeId,
      nodeName: node.nodeName,
      componentId: component?.id || null,
      deploymentUnitId: deploymentUnit?.deploymentUnitId || null,
      deploymentUnitTitle: deploymentUnit?.deploymentUnitTitle || null,
      classification: node.classification,
      railRoleClassification: node.railRoleClassification || null,
      participatingLaneTypes: asArray(node.participatingLaneTypes),
      membershipCount: node.membershipCount || 0,
      laneCount: node.laneCount || 0,
      roleCount: node.roleCount || 0,
      topologyRole: 'shared_infrastructure',
      borrowedIdea: 'observability_service_map_shared_dependency',
      confidence: 'medium',
      source: 'shared-node-understanding.json',
    };
  });
}

function buildReplicaRelationships({
  enterpriseDeployment = {},
} = {}) {
  return asArray(enterpriseDeployment.replicatedRegionCandidates)
    .map((candidate) => ({
      replicaRelationshipId:
        candidate.replicationId ||
        `replica_${slugify(asArray(candidate.regionIds).join('_'))}`,
      relationshipType: candidate.classification || 'replica_candidate',
      deploymentUnitTitles: [
        candidate.regionA,
        candidate.regionB,
      ].filter(Boolean),
      deploymentRegionIds: asArray(candidate.regionIds),
      sharedBaseComponents: asArray(candidate.sharedBaseComponents),
      similarity: candidate.similarity ?? null,
      confidence: candidate.confidence || 'low',
      source: candidate.source || 'enterprise-deployment-understanding.json',
      safety: {
        candidateOnly: true,
        doNotClaimFailover: true,
        doNotClaimActiveActive: true,
      },
    }));
}

function buildTopologyHealth({
  deploymentUnits = [],
  componentToDeploymentUnit = {},
  crossUnitRelationships = [],
} = {}) {
  const missingDeploymentUnitIds = deploymentUnits.filter(
    (unit) => !safeString(unit.deploymentUnitId)
  );

  const missingDeploymentUnitTitles = deploymentUnits.filter(
    (unit) => !safeString(unit.title)
  );

  const duplicateDeploymentUnitIds =
    deploymentUnits
      .map((unit) => unit.deploymentUnitId)
      .filter((id, index, ids) => ids.indexOf(id) !== index);

  const traversalChanged = false;

  const violations = [
    ...missingDeploymentUnitIds.map((unit) => ({
      type: 'missing_deployment_unit_id',
      severity: 'high',
      title: unit.title || null,
    })),

    ...missingDeploymentUnitTitles.map((unit) => ({
      type: 'missing_deployment_unit_title',
      severity: 'high',
      deploymentUnitId: unit.deploymentUnitId || null,
    })),

    ...duplicateDeploymentUnitIds.map((deploymentUnitId) => ({
      type: 'duplicate_deployment_unit_id',
      severity: 'high',
      deploymentUnitId,
    })),
  ];

  return {
    version: 'enterprise-topology-health-v1',
    valid: violations.length === 0 && traversalChanged === false,
    violationCount: violations.length,
    missingDeploymentUnitIdCount: missingDeploymentUnitIds.length,
    missingDeploymentUnitTitleCount: missingDeploymentUnitTitles.length,
    duplicateDeploymentUnitIdCount: duplicateDeploymentUnitIds.length,
    componentToDeploymentUnitCount:
      Object.keys(componentToDeploymentUnit).length,
    crossUnitRelationshipCount: crossUnitRelationships.length,
    traversalChanged,
    violations,
  };
}

function buildEnterpriseTopology({
  architectureUnderstanding = {},
  canonicalTraversalRail = {},
  responsibilityUnderstanding = {},
  journeyUnderstanding = {},
  deploymentBoundaryNormalization = {},
  deploymentUnitDiscovery = {},
  enterpriseDeployment = {},
  sharedNodeUnderstanding = {},
  multiRailUnderstanding = {},
  bidirectionalRailUnderstanding = {},
  outputDir = null,
} = {}) {
  const componentIndex = buildComponentIndex(architectureUnderstanding);
  const relationships = buildRelationshipIndex(architectureUnderstanding);

  const deploymentUnits = buildDeploymentUnits(
    deploymentUnitDiscovery
  );

  const componentToDeploymentUnit =
    buildComponentToDeploymentUnit({
      deploymentUnits,
    });

  const sharedInfrastructure =
    buildSharedInfrastructure({
      sharedNodeUnderstanding,
      componentToDeploymentUnit,
      componentIndex,
    });

  const replicaRelationships =
    buildReplicaRelationships({
      enterpriseDeployment,
    });

  const crossUnitRelationships =
    buildCrossUnitRelationships({
      relationships,
      componentIndex,
      componentToDeploymentUnit,
    });

  const aggregationPoints =
    buildAggregationPoints({
      relationships,
      componentIndex,
      componentToDeploymentUnit,
    });

  const fanOutPoints =
    buildFanOutPoints({
      relationships,
      componentIndex,
      componentToDeploymentUnit,
    });

  const trafficEntryPoints =
    buildTrafficEntryPoints({
      relationships,
      componentIndex,
      componentToDeploymentUnit,
    });

  const trafficExitPoints =
    buildTrafficExitPoints({
      relationships,
      componentIndex,
      componentToDeploymentUnit,
    });

  const health =
    buildTopologyHealth({
      deploymentUnits,
      componentToDeploymentUnit,
      crossUnitRelationships,
    });

  const payload = {
    version: BUILDER_VERSION,
    source: 'enterpriseTopologyBuilder',

    purpose:
      'Create a canonical, deterministic enterprise topology model from deployment units, graph relationships, shared-node understanding, and enterprise deployment summaries.',

    borrowedIdeas: [
      'c4_deployment_view',
      'kubernetes_topology_grouping',
      'cloud_reference_architecture_global_regional_shared',
      'network_topology_ingress_egress_fan_in_fan_out',
      'graph_theory_cross_boundary_edges',
      'observability_service_map_shared_dependencies',
    ],

    rules: {
      traversalMutation: 'forbidden',
      llmGeneratedTopology: 'forbidden',
      graphMutation: 'forbidden',
      narrationGeneration: 'forbidden',
      deterministicOnly: true,
      topologyTruthFromDeploymentUnits: true,
      failoverClaimsForbiddenInF3: true,
      activeActiveClaimsForbiddenInF3: true,
    },

    deploymentUnits,
    componentToDeploymentUnit,
    sharedInfrastructure,
    replicaRelationships,
    aggregationPoints,
    fanOutPoints,
    crossUnitRelationships,
    trafficEntryPoints,
    trafficExitPoints,

    sourceArtifacts: {
      architectureUnderstanding:
        architectureUnderstanding.version || architectureUnderstanding.schemaVersion || null,
      canonicalTraversalRail:
        canonicalTraversalRail.version || null,
      responsibilityUnderstanding:
        responsibilityUnderstanding.version || null,
      journeyUnderstanding:
        journeyUnderstanding.version || null,
      deploymentBoundaryNormalization:
        deploymentBoundaryNormalization.version || null,
      deploymentUnitDiscovery:
        deploymentUnitDiscovery.version || null,
      enterpriseDeployment:
        enterpriseDeployment.version || null,
      sharedNodeUnderstanding:
        sharedNodeUnderstanding.version || null,
      multiRailUnderstanding:
        multiRailUnderstanding.version || null,
      bidirectionalRailUnderstanding:
        bidirectionalRailUnderstanding.version || null,
    },

    health,

    stats: {
      deploymentUnitCount: deploymentUnits.length,
      componentToDeploymentUnitCount:
        Object.keys(componentToDeploymentUnit).length,
      sharedInfrastructureCount:
        sharedInfrastructure.length,
      replicaRelationshipCount:
        replicaRelationships.length,
      aggregationPointCount:
        aggregationPoints.length,
      fanOutPointCount:
        fanOutPoints.length,
      crossUnitRelationshipCount:
        crossUnitRelationships.length,
      trafficEntryPointCount:
        trafficEntryPoints.length,
      trafficExitPointCount:
        trafficExitPoints.length,
      traversalChanged: false,
    },
  };

  if (outputDir) {
    fs.mkdirSync(outputDir, { recursive: true });

    fs.writeFileSync(
      path.join(outputDir, 'enterprise-topology.json'),
      JSON.stringify(payload, null, 2),
      'utf8'
    );
  }

  return payload;
}

module.exports = {
  BUILDER_VERSION,
  buildEnterpriseTopology,
};
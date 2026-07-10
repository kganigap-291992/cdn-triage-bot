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

function buildDeploymentUnitComponentNameMap({
  deploymentUnits = [],
} = {}) {
  const componentNameToUnit = new Map();

  for (const unit of deploymentUnits) {
    for (const componentName of asArray(unit.componentNames)) {
      const key = safeLower(componentName);
      if (!key) continue;

      componentNameToUnit.set(key, {
        deploymentUnitId: unit.deploymentUnitId,
        deploymentUnitTitle: unit.title,
      });
    }
  }

  return componentNameToUnit;
}

function classifySharedInfrastructureRole(componentName = '') {
  const value = safeLower(componentName);

  if (/\b(auth|identity|iam|ckm|key|token|policy)\b/.test(value)) {
    return 'shared_identity_or_policy';
  }

  if (/\b(redis|cache|db|database|store|storage|origin|object)\b/.test(value)) {
    return 'shared_state_or_storage';
  }

  if (/\b(kafka|queue|broker|event|bus|stream)\b/.test(value)) {
    return 'shared_messaging';
  }

  if (/\b(metrics|monitor|collector|observability|log|alert)\b/.test(value)) {
    return 'shared_observability';
  }

  if (/\b(cdn|edge|dns|gateway|load balancer|waf)\b/.test(value)) {
    return 'shared_entry_or_delivery';
  }

  return 'shared_dependency';
}

function buildGraphDrivenSharedInfrastructure({
  relationships = [],
  componentIndex = {},
  deploymentUnits = [],
} = {}) {
  const componentNameToUnit =
    buildDeploymentUnitComponentNameMap({
      deploymentUnits,
    });

  const dependencyMap = new Map();

  function ensureSharedCandidate(component = {}) {
    const name = safeString(component.name);
    if (!name) return null;

    const key = safeLower(name);

    if (!dependencyMap.has(key)) {
      dependencyMap.set(key, {
        componentId: component.id || null,
        componentName: name,
        connectedDeploymentUnits: new Map(),
        incomingFromDeploymentUnits: new Map(),
        outgoingToDeploymentUnits: new Map(),
        evidenceRelationshipIds: [],
        connectedComponents: [],
      });
    }

    return dependencyMap.get(key);
  }

  for (const relationship of relationships) {
    const fromComponent = resolveRelationshipEndpoint({
      endpointId: relationship.from,
      componentIndex,
    });

    const toComponent = resolveRelationshipEndpoint({
      endpointId: relationship.to,
      componentIndex,
    });

    const fromUnit =
      componentNameToUnit.get(safeLower(fromComponent.name));

    const toUnit =
      componentNameToUnit.get(safeLower(toComponent.name));

    if (fromUnit && !toUnit) {
      const candidate = ensureSharedCandidate(toComponent);
      if (!candidate) continue;

      candidate.connectedDeploymentUnits.set(
        fromUnit.deploymentUnitId,
        fromUnit
      );

      candidate.incomingFromDeploymentUnits.set(
        fromUnit.deploymentUnitId,
        fromUnit
      );

      candidate.evidenceRelationshipIds.push(
        relationship.id || null
      );

      candidate.connectedComponents.push(
        fromComponent.name
      );
    }

    if (!fromUnit && toUnit) {
      const candidate = ensureSharedCandidate(fromComponent);
      if (!candidate) continue;

      candidate.connectedDeploymentUnits.set(
        toUnit.deploymentUnitId,
        toUnit
      );

      candidate.outgoingToDeploymentUnits.set(
        toUnit.deploymentUnitId,
        toUnit
      );

      candidate.evidenceRelationshipIds.push(
        relationship.id || null
      );

      candidate.connectedComponents.push(
        toComponent.name
      );
    }
  }

  return Array.from(dependencyMap.values())
    .filter((candidate) =>
      candidate.connectedDeploymentUnits.size >= 2
    )
    .map((candidate) => {
      const connectedDeploymentUnits =
        Array.from(candidate.connectedDeploymentUnits.values());

      return {
        nodeId:
          candidate.componentId ||
          `graph_shared_${slugify(candidate.componentName)}`,
        nodeName: candidate.componentName,
        componentId: candidate.componentId,
        deploymentUnitId: null,
        deploymentUnitTitle: null,

        classification:
          classifySharedInfrastructureRole(candidate.componentName),

        topologyRole: 'shared_infrastructure',
        graphBacked: true,
        candidateOnly: true,

        connectedDeploymentUnitCount:
          connectedDeploymentUnits.length,

        connectedDeploymentUnits,

        incomingFromDeploymentUnitCount:
          candidate.incomingFromDeploymentUnits.size,

        outgoingToDeploymentUnitCount:
          candidate.outgoingToDeploymentUnits.size,

        connectedComponents:
          uniq(candidate.connectedComponents),

        evidenceRelationshipIds:
          uniq(candidate.evidenceRelationshipIds),

        basis:
          'graph_connected_to_multiple_deployment_units',

        borrowedIdea:
          'opentelemetry_service_graph_istio_kiali_shared_dependency_detection',

        confidence: 'medium',
        source: 'architecture-understanding.json',

        safety: {
          candidateOnly: true,
          doNotClaimOwnership: true,
          doNotClaimFailover: true,
          doNotClaimActiveActive: true,
          doNotClaimDeploymentPattern: true,
        },
      };
    });
}

function mergeSharedInfrastructure({
  explicitSharedInfrastructure = [],
  graphSharedInfrastructure = [],
} = {}) {
  const merged = new Map();

  for (const item of [
    ...explicitSharedInfrastructure,
    ...graphSharedInfrastructure,
  ]) {
    const key =
      item.componentId ||
      safeLower(item.nodeName) ||
      safeLower(item.componentName);

    if (!key) continue;

    if (!merged.has(key)) {
      merged.set(key, item);
      continue;
    }

    const existing = merged.get(key);

    merged.set(key, {
      ...existing,
      ...item,
      sources: uniq([
        existing.source,
        item.source,
        ...asArray(existing.sources),
        ...asArray(item.sources),
      ]),
      graphBacked:
        Boolean(existing.graphBacked || item.graphBacked),
      candidateOnly:
        Boolean(existing.candidateOnly || item.candidateOnly),
    });
  }

  return Array.from(merged.values());
}

function getTopologyRole(component = {}) {
  const text = safeLower([
    component.name,
    component.architectureRole,
    component.role,
    component.type,
  ].filter(Boolean).join(' '));

  if (/\b(client|user|browser|mobile|player|consumer)\b/.test(text)) {
    return 'external_interface';
  }

  if (/\b(cdn|edge|ingress|gateway|api gateway|load balancer|waf|bot shield|dns)\b/.test(text)) {
    return 'entry_or_security';
  }

  if (/\b(route|routing|router|broker|queue|kafka|event bus)\b/.test(text)) {
    return 'routing_or_messaging';
  }

  if (/\b(app|application|service|worker|processor|cluster|transcoder|packager)\b/.test(text)) {
    return 'processing';
  }

  if (/\b(db|database|cache|redis|store|storage|origin|regional db)\b/.test(text)) {
    return 'state_or_storage';
  }

  if (/\b(metrics|monitor|log|collector|observability|alert)\b/.test(text)) {
    return 'observability';
  }

  return 'unknown';
}

function buildDeploymentUnitTopologySignatures({
  deploymentUnits = [],
  relationships = [],
  componentIndex = {},
} = {}) {
  return deploymentUnits.map((unit) => {
    const unitComponentNames = new Set(
      asArray(unit.componentNames).map(safeLower)
    );

    const unitComponents =
      asArray(unit.components)
        .map((component) => {
          const indexed =
            component.componentId
              ? componentIndex.byId.get(component.componentId)
              : componentIndex.byName.get(safeLower(component.componentName));

          return indexed || {
            id: component.componentId,
            name: component.componentName,
            architectureRole: component.architectureRole,
          };
        })
        .filter((component) => safeString(component.name));

    const roleCounts = unitComponents.reduce((acc, component) => {
      const role = getTopologyRole(component);
      acc[role] = (acc[role] || 0) + 1;
      return acc;
    }, {});

    const internalRelationships =
      relationships.filter((relationship) => {
        const fromComponent = resolveRelationshipEndpoint({
          endpointId: relationship.from,
          componentIndex,
        });

        const toComponent = resolveRelationshipEndpoint({
          endpointId: relationship.to,
          componentIndex,
        });

        return (
          unitComponentNames.has(safeLower(fromComponent.name)) &&
          unitComponentNames.has(safeLower(toComponent.name))
        );
      });

    const relationshipShape =
      internalRelationships
        .map((relationship) => {
          const fromComponent = resolveRelationshipEndpoint({
            endpointId: relationship.from,
            componentIndex,
          });

          const toComponent = resolveRelationshipEndpoint({
            endpointId: relationship.to,
            componentIndex,
          });

          return [
            getTopologyRole(fromComponent),
            relationship.type || relationship.relationshipType || 'relationship',
            getTopologyRole(toComponent),
          ].join('->');
        })
        .sort();

    const canonicalTopologySignature = uniq([
      ...Object.keys(roleCounts)
        .sort()
        .map((role) => `${role}:${roleCounts[role]}`),
      ...relationshipShape,
    ]);

    return {
      deploymentUnitId: unit.deploymentUnitId,
      deploymentUnitTitle: unit.title,
      unitScope: unit.unitScope,
      componentCount: unitComponents.length,
      roleCounts,
      relationshipShape,
      canonicalTopologySignature,
      source: 'enterpriseTopologyBuilder',
      borrowedIdea:
        'kubernetes_deployment_template_and_service_graph_topology_signature',
    };
  });
}

function jaccardSimilarity(leftValues = [], rightValues = []) {
  const left = new Set(asArray(leftValues));
  const right = new Set(asArray(rightValues));

  if (!left.size || !right.size) return 0;

  const intersection =
    [...left].filter((value) => right.has(value)).length;

  const union = new Set([...left, ...right]).size;

  return union ? intersection / union : 0;
}


function calculateWeightedTopologySimilarity({
  left = {},
  right = {},
} = {}) {
  const leftRoles = Object.keys(left.roleCounts || {});
  const rightRoles = Object.keys(right.roleCounts || {});

  const presenceScore =
    jaccardSimilarity(leftRoles, rightRoles);

  const allRoles =
    uniq([...leftRoles, ...rightRoles]);

  const countScores =
    allRoles.map((role) => {
      const leftCount = Number(left.roleCounts?.[role] || 0);
      const rightCount = Number(right.roleCounts?.[role] || 0);
      const maxCount = Math.max(leftCount, rightCount);

      if (maxCount === 0) return 1;

      return 1 - (Math.abs(leftCount - rightCount) / maxCount);
    });

  const countScore =
    countScores.length
      ? countScores.reduce((sum, score) => sum + score, 0) / countScores.length
      : 0;

  const relationshipScore =
    asArray(left.relationshipShape).length || asArray(right.relationshipShape).length
      ? jaccardSimilarity(left.relationshipShape, right.relationshipShape)
      : presenceScore;

  const weightedScore =
    (presenceScore * 0.45) +
    (countScore * 0.35) +
    (relationshipScore * 0.20);

  return Number(weightedScore.toFixed(2));
}

function buildReplicaRelationshipsFromTopology({
  topologySignatures = [],
} = {}) {
  const relationships = [];

  for (let i = 0; i < topologySignatures.length; i += 1) {
    for (let j = i + 1; j < topologySignatures.length; j += 1) {
      const left = topologySignatures[i];
      const right = topologySignatures[j];

      const similarity =
        calculateWeightedTopologySimilarity({
            left,
            right,
        });

      if (similarity < 0.45) continue;

      relationships.push({
        replicaRelationshipId:
          `replica_${slugify(left.deploymentUnitTitle)}_${slugify(right.deploymentUnitTitle)}`,
        relationshipType:
          similarity >= 0.75
            ? 'mirrored_topology_candidate'
            : 'partial_replica_candidate',
        deploymentUnitA: {
          deploymentUnitId: left.deploymentUnitId,
          deploymentUnitTitle: left.deploymentUnitTitle,
        },
        deploymentUnitB: {
          deploymentUnitId: right.deploymentUnitId,
          deploymentUnitTitle: right.deploymentUnitTitle,
        },
        similarity: Number(similarity.toFixed(2)),
        confidence: similarity >= 0.75 ? 'high' : 'medium',
        candidateOnly: true,
        basis: 'structural_topology_signature_similarity',
        similarityMethod: 'presence_weighted_role_and_relationship_similarity',
        sharedTopologySignature:
          left.canonicalTopologySignature.filter((item) =>
            right.canonicalTopologySignature.includes(item)
          ),
        borrowedIdea:
          'kubernetes_deployment_template_comparison_c4_deployment_topology_service_graph_similarity',
        source: 'enterpriseTopologyBuilder',
        safety: {
          candidateOnly: true,
          doNotClaimFailover: true,
          doNotClaimActiveActive: true,
          doNotClaimDisasterRecovery: true,
          doNotClaimReplicationTechnology: true,
          doNotClaimTrafficRouting: true,
        },
      });
    }
  }

  return relationships;
}



function buildDeploymentPatternCandidates({
  deploymentUnits = [],
  replicaRelationships = [],
  sharedInfrastructure = [],
  aggregationPoints = [],
  fanOutPoints = [],
  crossUnitRelationships = [],
} = {}) {
  const candidates = [];

  const mirroredReplicas =
    asArray(replicaRelationships).filter((relationship) =>
      relationship.relationshipType === 'mirrored_topology_candidate'
    );

  if (deploymentUnits.length <= 1) {
    candidates.push({
      pattern: 'single_deployment',
      confidence: 'medium',
      candidateOnly: true,
      basis: 'one_or_fewer_deployment_units_detected',
      source: 'enterpriseTopologyBuilder',
    });
  }

  if (mirroredReplicas.length > 0) {
    candidates.push({
      pattern: 'mirrored_topology',
      confidence:
        mirroredReplicas.some((relationship) => relationship.confidence === 'high')
          ? 'high'
          : 'medium',
      candidateOnly: true,
      basis: 'mirrored_replica_relationship_detected',
      supportingReplicaRelationshipIds:
        mirroredReplicas.map((relationship) => relationship.replicaRelationshipId),
      source: 'enterpriseTopologyBuilder',
      safety: {
        doNotClaimActiveActive: true,
        doNotClaimFailover: true,
        doNotClaimDisasterRecovery: true,
        doNotClaimReplicationTechnology: true,
        doNotClaimTrafficRouting: true,
      },
    });
  }

  const graphShared =
    asArray(sharedInfrastructure).filter((item) => item.graphBacked);

  if (graphShared.length > 0) {
    candidates.push({
      pattern: 'shared_infrastructure_topology',
      confidence: 'medium',
      candidateOnly: true,
      basis: 'graph_shared_infrastructure_detected',
      supportingSharedInfrastructureIds:
        graphShared.map((item) => item.nodeId),
      source: 'enterpriseTopologyBuilder',
    });
  }

  if (aggregationPoints.length > 0) {
    candidates.push({
      pattern: 'fan_in',
      confidence: 'medium',
      candidateOnly: true,
      basis: 'aggregation_points_detected',
      source: 'enterpriseTopologyBuilder',
    });
  }

  if (fanOutPoints.length > 0) {
    candidates.push({
      pattern: 'fan_out',
      confidence: 'medium',
      candidateOnly: true,
      basis: 'fan_out_points_detected',
      source: 'enterpriseTopologyBuilder',
    });
  }

  if (crossUnitRelationships.length > 0) {
    candidates.push({
      pattern: 'cross_unit_connected_topology',
      confidence: 'medium',
      candidateOnly: true,
      basis: 'cross_unit_relationships_detected',
      source: 'enterpriseTopologyBuilder',
    });
  }

  if (!candidates.length && deploymentUnits.length > 1) {
    candidates.push({
      pattern: 'multi_deployment_unknown_relationship',
      confidence: 'low',
      candidateOnly: true,
      basis: 'multiple_deployment_units_without_strong_pattern_signal',
      source: 'enterpriseTopologyBuilder',
    });
  }

  return candidates;
}

function buildTopologyHealth({
  deploymentUnits = [],
  componentToDeploymentUnit = {},
  replicaRelationships = [],
  sharedInfrastructure = [],
  deploymentPatternCandidates = [],
  crossUnitRelationships = [],
  enterpriseDeployment = {},
} = {}) {
  const deploymentUnitIds = new Set(
    deploymentUnits
      .map((unit) => safeString(unit.deploymentUnitId))
      .filter(Boolean)
  );

  const missingDeploymentUnitIds = deploymentUnits.filter(
    (unit) => !safeString(unit.deploymentUnitId)
  );

  const missingDeploymentUnitTitles = deploymentUnits.filter(
    (unit) => !safeString(unit.title)
  );

  const deploymentUnitsWithoutEvidence = deploymentUnits.filter(
    (unit) =>
      !safeString(unit.sourceBoundaryId) &&
      asArray(unit.sourceBoundaries).length === 0 &&
      asArray(unit.componentIds).length === 0 &&
      asArray(unit.componentNames).length === 0
  );

  const duplicateDeploymentUnitIds =
    deploymentUnits
      .map((unit) => unit.deploymentUnitId)
      .filter((id, index, ids) => id && ids.indexOf(id) !== index);

  const replicaRelationshipsWithUnknownUnits =
    replicaRelationships.filter((relationship) => {
      const leftId =
        relationship?.deploymentUnitA?.deploymentUnitId;

      const rightId =
        relationship?.deploymentUnitB?.deploymentUnitId;

      return (
        !deploymentUnitIds.has(leftId) ||
        !deploymentUnitIds.has(rightId)
      );
    });

  const replicaRelationshipsNotCandidateOnly =
    replicaRelationships.filter(
      (relationship) => relationship.candidateOnly !== true
    );

  const replicaRelationshipsWithoutEvidence =
    replicaRelationships.filter(
      (relationship) =>
        !safeString(relationship.basis) ||
        typeof relationship.similarity !== 'number'
    );

  const invalidGraphSharedInfrastructure =
    sharedInfrastructure.filter(
      (item) =>
        item.graphBacked === true &&
        Number(item.connectedDeploymentUnitCount || 0) < 2
    );

  const graphSharedInfrastructureWithoutEvidence =
    sharedInfrastructure.filter(
      (item) =>
        item.graphBacked === true &&
        asArray(item.evidenceRelationshipIds).length === 0
    );

  const patternCandidatesNotCandidateOnly =
    deploymentPatternCandidates.filter(
      (candidate) => candidate.candidateOnly !== true
    );

  const patternCandidatesWithoutBasis =
    deploymentPatternCandidates.filter(
      (candidate) =>
        !safeString(candidate.pattern) ||
        !safeString(candidate.basis) ||
        !safeString(candidate.confidence)
    );

  const unsupportedOperationalPatternClaims =
    deploymentPatternCandidates.filter((candidate) =>
      /\b(active[_ -]?active|active[_ -]?passive|failover|disaster[_ -]?recovery|standby)\b/i.test(
        safeString(candidate.pattern)
      )
    );

  const crossUnitRelationshipsWithUnknownUnits =
    crossUnitRelationships.filter(
      (relationship) =>
        !deploymentUnitIds.has(
          relationship.fromDeploymentUnitId
        ) ||
        !deploymentUnitIds.has(
          relationship.toDeploymentUnitId
        )
    );

  const crossUnitSelfRelationships =
    crossUnitRelationships.filter(
      (relationship) =>
        relationship.fromDeploymentUnitId &&
        relationship.fromDeploymentUnitId ===
          relationship.toDeploymentUnitId
    );

  const legacyDeploymentPattern =
    safeString(enterpriseDeployment?.deploymentPattern?.pattern);

  const legacyUnsafePatternWarnings =
    /\b(active[_ -]?active|active[_ -]?passive|failover|disaster[_ -]?recovery|standby|synchronized)\b/i.test(
      legacyDeploymentPattern
    )
      ? [
          {
            type: 'legacy_operational_pattern_claim',
            severity: 'warning',
            pattern: legacyDeploymentPattern,
            preferredSource: 'enterprise-topology.json',
            message:
              'Legacy enterprise deployment output contains a stronger operational pattern claim. Use enterprise-topology.json deploymentPatternCandidates as the canonical safe source.',
          },
        ]
      : [];

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

    ...deploymentUnitsWithoutEvidence.map((unit) => ({
      type: 'deployment_unit_without_evidence',
      severity: 'high',
      deploymentUnitId: unit.deploymentUnitId || null,
      title: unit.title || null,
    })),

    ...duplicateDeploymentUnitIds.map((deploymentUnitId) => ({
      type: 'duplicate_deployment_unit_id',
      severity: 'high',
      deploymentUnitId,
    })),

    ...replicaRelationshipsWithUnknownUnits.map((relationship) => ({
      type: 'replica_relationship_unknown_deployment_unit',
      severity: 'high',
      replicaRelationshipId:
        relationship.replicaRelationshipId || null,
    })),

    ...replicaRelationshipsNotCandidateOnly.map((relationship) => ({
      type: 'replica_relationship_not_candidate_only',
      severity: 'high',
      replicaRelationshipId:
        relationship.replicaRelationshipId || null,
    })),

    ...replicaRelationshipsWithoutEvidence.map((relationship) => ({
      type: 'replica_relationship_without_structural_evidence',
      severity: 'high',
      replicaRelationshipId:
        relationship.replicaRelationshipId || null,
    })),

    ...invalidGraphSharedInfrastructure.map((item) => ({
      type: 'graph_shared_infrastructure_insufficient_unit_connections',
      severity: 'high',
      nodeId: item.nodeId || null,
      nodeName: item.nodeName || null,
    })),

    ...graphSharedInfrastructureWithoutEvidence.map((item) => ({
      type: 'graph_shared_infrastructure_without_relationship_evidence',
      severity: 'high',
      nodeId: item.nodeId || null,
      nodeName: item.nodeName || null,
    })),

    ...patternCandidatesNotCandidateOnly.map((candidate) => ({
      type: 'deployment_pattern_not_candidate_only',
      severity: 'high',
      pattern: candidate.pattern || null,
    })),

    ...patternCandidatesWithoutBasis.map((candidate) => ({
      type: 'deployment_pattern_missing_basis',
      severity: 'high',
      pattern: candidate.pattern || null,
    })),

    ...unsupportedOperationalPatternClaims.map((candidate) => ({
      type: 'unsupported_operational_pattern_claim',
      severity: 'high',
      pattern: candidate.pattern || null,
    })),

    ...crossUnitRelationshipsWithUnknownUnits.map((relationship) => ({
      type: 'cross_unit_relationship_unknown_deployment_unit',
      severity: 'high',
      relationshipId: relationship.relationshipId || null,
    })),

    ...crossUnitSelfRelationships.map((relationship) => ({
      type: 'cross_unit_relationship_same_deployment_unit',
      severity: 'high',
      relationshipId: relationship.relationshipId || null,
      deploymentUnitId:
        relationship.fromDeploymentUnitId || null,
    })),
  ];

  const warnings = [
    ...legacyUnsafePatternWarnings,
  ];

  return {
    version: 'enterprise-topology-health-v2',

    valid:
      violations.length === 0 &&
      traversalChanged === false,

    violationCount: violations.length,
    warningCount: warnings.length,

    missingDeploymentUnitIdCount:
      missingDeploymentUnitIds.length,

    missingDeploymentUnitTitleCount:
      missingDeploymentUnitTitles.length,

    deploymentUnitWithoutEvidenceCount:
      deploymentUnitsWithoutEvidence.length,

    duplicateDeploymentUnitIdCount:
      duplicateDeploymentUnitIds.length,

    replicaRelationshipUnknownUnitCount:
      replicaRelationshipsWithUnknownUnits.length,

    replicaRelationshipNotCandidateOnlyCount:
      replicaRelationshipsNotCandidateOnly.length,

    replicaRelationshipWithoutEvidenceCount:
      replicaRelationshipsWithoutEvidence.length,

    invalidGraphSharedInfrastructureCount:
      invalidGraphSharedInfrastructure.length,

    graphSharedInfrastructureWithoutEvidenceCount:
      graphSharedInfrastructureWithoutEvidence.length,

    deploymentPatternNotCandidateOnlyCount:
      patternCandidatesNotCandidateOnly.length,

    deploymentPatternMissingBasisCount:
      patternCandidatesWithoutBasis.length,

    unsupportedOperationalPatternClaimCount:
      unsupportedOperationalPatternClaims.length,

    crossUnitRelationshipUnknownUnitCount:
      crossUnitRelationshipsWithUnknownUnits.length,

    crossUnitSelfRelationshipCount:
      crossUnitSelfRelationships.length,

    componentToDeploymentUnitCount:
      Object.keys(componentToDeploymentUnit).length,

    replicaRelationshipCount:
      replicaRelationships.length,

    sharedInfrastructureCount:
      sharedInfrastructure.length,

    deploymentPatternCandidateCount:
      deploymentPatternCandidates.length,

    crossUnitRelationshipCount:
      crossUnitRelationships.length,

    canonicalPatternSource:
      'enterprise-topology.json',

    traversalChanged,
    violations,
    warnings,
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

  const explicitSharedInfrastructure =
    buildSharedInfrastructure({
      sharedNodeUnderstanding,
      componentToDeploymentUnit,
      componentIndex,
    });

  const graphSharedInfrastructure =
    buildGraphDrivenSharedInfrastructure({
      relationships,
      componentIndex,
      deploymentUnits,
    });

  const sharedInfrastructure =
    mergeSharedInfrastructure({
      explicitSharedInfrastructure,
      graphSharedInfrastructure,
    });

  const topologySignatures =
    buildDeploymentUnitTopologySignatures({
        deploymentUnits,
        relationships,
        componentIndex,
    });

    const replicaRelationships =
    buildReplicaRelationshipsFromTopology({
        topologySignatures,
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

  const deploymentPatternCandidates =
    buildDeploymentPatternCandidates({
      deploymentUnits,
      replicaRelationships,
      sharedInfrastructure,
      aggregationPoints,
      fanOutPoints,
      crossUnitRelationships,
    });

  const health =
    buildTopologyHealth({
      deploymentUnits,
      componentToDeploymentUnit,
      replicaRelationships,
      sharedInfrastructure,
      deploymentPatternCandidates,
      crossUnitRelationships,
      enterpriseDeployment,
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
    topologySignatures,
    sharedInfrastructure,
    replicaRelationships,

    deploymentPatternCandidates,

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

        // NEW
        topologySignatureCount:
            topologySignatures.length,

        sharedInfrastructureCount:
          sharedInfrastructure.length,

        explicitSharedInfrastructureCount:
          explicitSharedInfrastructure.length,

        graphSharedInfrastructureCount:
          graphSharedInfrastructure.length,

        replicaRelationshipCount:
            replicaRelationships.length,

        deploymentPatternCandidateCount:
            deploymentPatternCandidates.length,

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
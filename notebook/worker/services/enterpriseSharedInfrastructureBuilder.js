'use strict';

/**
 * enterpriseSharedInfrastructureBuilder.js
 *
 * BUG-17F.5 — Enterprise Shared Infrastructure Discovery
 *
 * Owns:
 * - distinguish traversal-shared nodes from deployment-shared infrastructure
 * - detect components connected to multiple deployment units
 * - preserve explicit global/shared scope as supporting evidence
 * - emit candidate-only enterprise shared-infrastructure findings
 *
 * Borrowed ideas:
 * - C4 deployment diagrams:
 *   infrastructure outside deployment nodes may serve multiple nodes.
 * - Kubernetes / service graphs:
 *   shared services are identified by workload connectivity.
 * - OpenTelemetry / Istio / Kiali:
 *   dependency graphs reveal shared backends and service fan-in/fan-out.
 * - AWS global vs regional services:
 *   explicit global scope strengthens classification but does not replace
 *   deterministic graph evidence.
 *
 * Does NOT:
 * - mutate traversal
 * - change deployment-unit membership
 * - infer failover, active-active, disaster recovery, or ownership
 * - classify the overall deployment pattern
 * - call an LLM
 */

const fs = require('fs');
const path = require('path');

const BUILDER_VERSION =
  'enterprise-shared-infrastructure-v1';

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
    .slice(0, 100);
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

function uniqueObjectsBy(items = [], keyFn) {
  const seen = new Set();
  const output = [];

  for (const item of asArray(items)) {
    const key = keyFn(item);

    if (!key || seen.has(key)) {
      continue;
    }

    seen.add(key);
    output.push(item);
  }

  return output;
}

function buildComponentIndex(
  architectureUnderstanding = {}
) {
  const components = asArray(
    architectureUnderstanding
      ?.deterministicGraph
      ?.components
  );

  const byId = new Map();
  const byName = new Map();

  for (const component of components) {
    if (component?.id) {
      byId.set(component.id, component);
    }

    const nameKey = safeLower(component?.name);

    if (nameKey && !byName.has(nameKey)) {
      byName.set(nameKey, component);
    }
  }

  return {
    components,
    byId,
    byName,
  };
}

function buildDeploymentUnitIndexes(
  deploymentUnitDiscovery = {}
) {
  const deploymentUnits = asArray(
    deploymentUnitDiscovery.deploymentUnits
  );

  const componentIdToUnit = new Map();
  const componentNameToUnit = new Map();
  const unitById = new Map();

  for (const unit of deploymentUnits) {
    if (unit?.deploymentUnitId) {
      unitById.set(unit.deploymentUnitId, unit);
    }

    for (const componentId of asArray(
      unit.componentIds
    )) {
      if (!componentId) continue;

      componentIdToUnit.set(componentId, {
        deploymentUnitId:
          unit.deploymentUnitId,
        deploymentUnitTitle:
          unit.title,
      });
    }

    for (const componentName of asArray(
      unit.componentNames
    )) {
      const key = safeLower(componentName);

      if (!key) continue;

      componentNameToUnit.set(key, {
        deploymentUnitId:
          unit.deploymentUnitId,
        deploymentUnitTitle:
          unit.title,
      });
    }
  }

  return {
    deploymentUnits,
    unitById,
    componentIdToUnit,
    componentNameToUnit,
  };
}

function resolveComponentDeploymentUnit({
  component = null,
  deploymentIndexes = {},
} = {}) {
  if (!component) return null;

  if (
    component.id &&
    deploymentIndexes
      .componentIdToUnit
      ?.has(component.id)
  ) {
    return deploymentIndexes
      .componentIdToUnit
      .get(component.id);
  }

  const nameKey = safeLower(component.name);

  if (
    nameKey &&
    deploymentIndexes
      .componentNameToUnit
      ?.has(nameKey)
  ) {
    return deploymentIndexes
      .componentNameToUnit
      .get(nameKey);
  }

  return null;
}

function buildTraversalSharedIndex(
  sharedNodeUnderstanding = {}
) {
  const byId = new Map();
  const byName = new Map();

  for (const node of asArray(
    sharedNodeUnderstanding.nodes
  )) {
    if (node?.nodeId) {
      byId.set(node.nodeId, node);
    }

    const nameKey = safeLower(node?.nodeName);

    if (nameKey && !byName.has(nameKey)) {
      byName.set(nameKey, node);
    }
  }

  return {
    byId,
    byName,
  };
}

function resolveTraversalSharedNode({
  component = {},
  traversalSharedIndex = {},
} = {}) {
  if (
    component.id &&
    traversalSharedIndex.byId?.has(component.id)
  ) {
    return traversalSharedIndex.byId.get(
      component.id
    );
  }

  const nameKey = safeLower(component.name);

  if (
    nameKey &&
    traversalSharedIndex.byName?.has(nameKey)
  ) {
    return traversalSharedIndex.byName.get(
      nameKey
    );
  }

  return null;
}

function isRegionalOrDeploymentScopedName(
  name = ''
) {
  const value = safeString(name);

  if (!value) return false;

  return (
    /\bregional\b/i.test(value) ||
    /\b(region|availability zone|az|zone|site|cell|data center|datacenter)\s+(a|b|c|d|1|2|3|4|east|west|north|south|primary|secondary)\b/i.test(
      value
    )
  );
}

function isDocumentOrTraversalConcept({
  component = {},
  traversalNode = null,
} = {}) {
  const componentId = safeLower(component.id);
  const traversalNodeId = safeLower(
    traversalNode?.nodeId
  );

  const name = safeString(
    component.name ||
    traversalNode?.nodeName
  );

  const wordCount =
    name.split(/\s+/).filter(Boolean).length;

  if (!name) return true;

  if (
    componentId.startsWith(
      'sequence_reference_'
    ) ||
    traversalNodeId.startsWith(
      'sequence_reference_'
    ) ||
    componentId.startsWith(
      'sequence_entity_all_'
    ) ||
    traversalNodeId.startsWith(
      'sequence_entity_all_'
    )
  ) {
    return true;
  }

  if (
    /[.!?]$/.test(name) &&
    wordCount >= 4
  ) {
    return true;
  }

  if (
    /\b(pattern\s+classification|validator|health\.valid|learning\s+engine|content\s+delivery|state\s+synchronization|cross-unit|fan-out|fan-in|candidate-only|regression)\b/i.test(
      name
    )
  ) {
    return true;
  }

  return false;
}

function hasExplicitGlobalOrSharedScope(
  component = {}
) {
  const value = safeLower([
    component.name,
    component.architectureRole,
    component.role,
    component.type,
  ].filter(Boolean).join(' '));

  return /\b(global|shared|central|common)\b/i
    .test(value);
}

function hasInfrastructureSignal(
  component = {}
) {
  const value = safeLower([
    component.name,
    component.architectureRole,
    component.role,
    component.type,
  ].filter(Boolean).join(' '));

  /*
   * Positive signal only.
   * This is not used as a hard allowlist by itself.
   */
  return /\b(dns|cdn|gateway|load balancer|proxy|identity|iam|auth|authentication|authorization|ckm|key|policy|config|configuration|redis|cache|database|db|store|storage|origin|object storage|bucket|kafka|queue|broker|event bus|stream|telemetry|logging|metrics|monitoring|observability|collector|alerting|mesh|router|routing)\b/i
    .test(value);
}

function buildRelationshipAdjacency(
  architectureUnderstanding = {}
) {
  const relationships = asArray(
    architectureUnderstanding
      ?.deterministicGraph
      ?.relationships
  );

  const adjacencyByComponentId = new Map();

  function ensure(componentId) {
    if (
      componentId &&
      !adjacencyByComponentId.has(componentId)
    ) {
      adjacencyByComponentId.set(
        componentId,
        []
      );
    }
  }

  for (const relationship of relationships) {
    const sourceId =
      safeString(relationship.sourceId);

    const targetId =
      safeString(relationship.targetId);

    if (!sourceId || !targetId) {
      continue;
    }

    ensure(sourceId);
    ensure(targetId);

    const relationshipEvidence = {
      relationshipId:
        relationship.id || null,

      sourceId,
      sourceName:
        relationship.sourceName || null,

      targetId,
      targetName:
        relationship.targetName || null,

      relationshipType:
        relationship.type || null,

      direction:
        relationship.direction || null,

      reason:
        relationship.reason || null,

      confidence:
        relationship.confidence || 'unknown',

      inferred:
        Boolean(relationship.inferred),

      evidenceIds:
        asArray(relationship.evidenceIds),
    };

    adjacencyByComponentId
      .get(sourceId)
      .push({
        neighborId: targetId,
        endpoint: 'source',
        relationship:
          relationshipEvidence,
      });

    adjacencyByComponentId
      .get(targetId)
      .push({
        neighborId: sourceId,
        endpoint: 'target',
        relationship:
          relationshipEvidence,
      });
  }

  return {
    relationships,
    adjacencyByComponentId,
  };
}

function analyzeComponentConnectivity({
  component = {},
  componentIndex = {},
  deploymentIndexes = {},
  relationshipAdjacency = {},
} = {}) {
  const adjacency = asArray(
    relationshipAdjacency
      .adjacencyByComponentId
      ?.get(component.id)
  );

  const deploymentUnits = new Map();
  const connectedComponents = [];
  const evidenceRelationshipIds = [];
  const evidenceIds = [];

  let incomingRelationshipCount = 0;
  let outgoingRelationshipCount = 0;

  for (const edge of adjacency) {
    const neighbor =
      componentIndex.byId.get(
        edge.neighborId
      ) || null;

    if (!neighbor) continue;

    connectedComponents.push({
      componentId: neighbor.id,
      componentName: neighbor.name,
    });

    const neighborDeploymentUnit =
      resolveComponentDeploymentUnit({
        component: neighbor,
        deploymentIndexes,
      });

    if (
      neighborDeploymentUnit
        ?.deploymentUnitId
    ) {
      deploymentUnits.set(
        neighborDeploymentUnit
          .deploymentUnitId,
        neighborDeploymentUnit
      );
    }

    if (
      edge.relationship
        ?.relationshipId
    ) {
      evidenceRelationshipIds.push(
        edge.relationship.relationshipId
      );
    }

    evidenceIds.push(
      ...asArray(
        edge.relationship?.evidenceIds
      )
    );

    if (edge.endpoint === 'source') {
      outgoingRelationshipCount += 1;
    }

    if (edge.endpoint === 'target') {
      incomingRelationshipCount += 1;
    }
  }

  return {
    adjacencyCount: adjacency.length,

    connectedDeploymentUnits:
      Array.from(deploymentUnits.values()),

    connectedDeploymentUnitCount:
      deploymentUnits.size,

    connectedComponents:
      uniqueObjectsBy(
        connectedComponents,
        (item) => item.componentId
      ),

    evidenceRelationshipIds:
      uniq(evidenceRelationshipIds),

    evidenceIds:
      uniq(evidenceIds),

    incomingRelationshipCount,
    outgoingRelationshipCount,
  };
}

function classifyEnterpriseSharing({
  component = {},
  ownDeploymentUnit = null,
  connectivity = {},
  traversalNode = null,
} = {}) {
  const reasons = [];

  if (!component?.id || !component?.name) {
    return {
      eligible: false,
      classification:
        'unresolved_component',
      confidence: 'low',
      reasons: [
        'component_not_resolved_in_architecture_graph',
      ],
    };
  }

  if (ownDeploymentUnit) {
    return {
      eligible: false,
      classification:
        'deployment_local',
      confidence: 'high',
      reasons: [
        'component_assigned_to_single_deployment_unit',
      ],
    };
  }

  if (
    isRegionalOrDeploymentScopedName(
      component.name
    )
  ) {
    return {
      eligible: false,
      classification:
        'deployment_scoped_name',
      confidence: 'high',
      reasons: [
        'regional_or_deployment_differentiator_present',
      ],
    };
  }

  if (
    isDocumentOrTraversalConcept({
      component,
      traversalNode,
    })
  ) {
    return {
      eligible: false,
      classification:
        'document_or_traversal_concept',
      confidence: 'high',
      reasons: [
        'not_a_runtime_infrastructure_component',
      ],
    };
  }

  const connectedUnitCount =
    connectivity
      .connectedDeploymentUnitCount || 0;

  const explicitScope =
    hasExplicitGlobalOrSharedScope(
      component
    );

  const infrastructureSignal =
    hasInfrastructureSignal(component);

  const traversalShared =
    Boolean(traversalNode?.shared);

  /*
   * Strongest deterministic case:
   * one component outside all units connects to
   * members of at least two deployment units.
   */
  if (connectedUnitCount >= 2) {
    reasons.push(
      'graph_connected_to_multiple_deployment_units'
    );

    if (explicitScope) {
      reasons.push(
        'explicit_global_or_shared_scope'
      );
    }

    if (infrastructureSignal) {
      reasons.push(
        'infrastructure_semantic_signal'
      );
    }

    if (traversalShared) {
      reasons.push(
        'also_shared_across_traversal'
      );
    }

    return {
      eligible: true,
      classification:
        'graph_shared_across_deployment_units',

      confidence:
        explicitScope ||
        infrastructureSignal
          ? 'high'
          : 'medium',

      reasons,
    };
  }

  /*
   * Conservative explicit candidate:
   * explicit global/shared scope plus actual graph
   * connection to at least one deployment unit and
   * independent traversal-sharing evidence.
   *
   * This remains candidate-only because the graph
   * does not yet prove use by two deployment units.
   */
  if (
    connectedUnitCount >= 1 &&
    explicitScope &&
    infrastructureSignal &&
    traversalShared
  ) {
    return {
      eligible: true,
      classification:
        'explicit_global_shared_candidate',

      confidence: 'medium',

      reasons: [
        'explicit_global_or_shared_scope',
        'infrastructure_semantic_signal',
        'graph_connected_to_deployment_unit',
        'shared_across_traversal',
        'cross_unit_usage_not_fully_proven',
      ],
    };
  }

  return {
    eligible: false,
    classification:
      'insufficient_enterprise_sharing_evidence',

    confidence: 'low',

    reasons: [
      connectedUnitCount === 0
        ? 'no_graph_connection_to_deployment_unit'
        : 'connected_to_only_one_deployment_unit',

      !explicitScope
        ? 'no_explicit_global_or_shared_scope'
        : null,

      !infrastructureSignal
        ? 'no_infrastructure_semantic_signal'
        : null,

      !traversalShared
        ? 'not_shared_in_traversal'
        : null,
    ].filter(Boolean),
  };
}

function buildCandidate({
  component = {},
  ownDeploymentUnit = null,
  connectivity = {},
  traversalNode = null,
  enterpriseSharing = {},
} = {}) {
  return {
    sharedInfrastructureId:
      `enterprise_shared_${slugify(
        component.id || component.name
      )}`,

    componentId: component.id,
    componentName: component.name,

    architectureRole:
      component.architectureRole ||
      component.role ||
      component.type ||
      'unknown',

    ownDeploymentUnitId:
      ownDeploymentUnit
        ?.deploymentUnitId || null,

    ownDeploymentUnitTitle:
      ownDeploymentUnit
        ?.deploymentUnitTitle || null,

    enterpriseShared: true,

    enterpriseSharedClassification:
      enterpriseSharing.classification,

    connectedDeploymentUnitCount:
      connectivity
        .connectedDeploymentUnitCount,

    connectedDeploymentUnits:
      connectivity.connectedDeploymentUnits,

    connectedComponents:
      connectivity.connectedComponents,

    incomingRelationshipCount:
      connectivity
        .incomingRelationshipCount,

    outgoingRelationshipCount:
      connectivity
        .outgoingRelationshipCount,

    adjacencyCount:
      connectivity.adjacencyCount,

    graphBacked:
      connectivity
        .connectedDeploymentUnitCount >= 2,

    explicitScopeBacked:
      hasExplicitGlobalOrSharedScope(
        component
      ),

    traversalShared:
      Boolean(traversalNode?.shared),

    traversalSharedClassification:
      traversalNode?.classification || null,

    participatingLaneTypes:
      asArray(
        traversalNode?.participatingLaneTypes
      ),

    evidenceRelationshipIds:
      connectivity
        .evidenceRelationshipIds,

    evidenceIds:
      connectivity.evidenceIds,

    basis:
      enterpriseSharing.reasons,

    confidence:
      enterpriseSharing.confidence,

    candidateOnly: true,

    topologyRole:
      'shared_infrastructure_candidate',

    borrowedIdeas: [
      'c4_deployment_node_external_shared_infrastructure',
      'kubernetes_service_to_workload_connectivity',
      'opentelemetry_dependency_graph_shared_backend_detection',
      'istio_kiali_cross_workload_service_graph',
      'aws_global_vs_regional_service_scope',
    ],

    source:
      'enterpriseSharedInfrastructureBuilder',

    safety: {
      candidateOnly: true,
      traversalChanged: false,
      deploymentMembershipChanged: false,
      doNotClaimOwnership: true,
      doNotClaimFailover: true,
      doNotClaimActiveActive: true,
      doNotClaimDisasterRecovery: true,
      doNotClaimReplicationTechnology: true,
      doNotClaimTrafficRouting: true,
    },
  };
}

function buildEnterpriseSharedInfrastructureHealth({
  sharedInfrastructure = [],
  rejectedCandidates = [],
  deploymentUnitDiscovery = {},
} = {}) {
  const knownDeploymentUnitIds = new Set(
    asArray(
      deploymentUnitDiscovery.deploymentUnits
    )
      .map((unit) =>
        safeString(unit.deploymentUnitId)
      )
      .filter(Boolean)
  );

  const missingComponentIds =
    sharedInfrastructure.filter(
      (item) =>
        !safeString(item.componentId)
    );

  const deploymentLocalShared =
    sharedInfrastructure.filter(
      (item) =>
        safeString(
          item.ownDeploymentUnitId
        )
    );

  const unknownConnectedUnits =
    sharedInfrastructure.flatMap(
      (item) =>
        asArray(
          item.connectedDeploymentUnits
        )
          .filter(
            (unit) =>
              !knownDeploymentUnitIds.has(
                unit.deploymentUnitId
              )
          )
          .map((unit) => ({
            componentId:
              item.componentId,

            componentName:
              item.componentName,

            deploymentUnitId:
              unit.deploymentUnitId,
          }))
    );

  const missingGraphEvidence =
    sharedInfrastructure.filter(
      (item) =>
        item.graphBacked === true &&
        asArray(
          item.evidenceRelationshipIds
        ).length === 0
    );

  const violations = [
    ...missingComponentIds.map((item) => ({
      type:
        'shared_infrastructure_missing_component_id',
      severity: 'high',
      componentName:
        item.componentName || null,
    })),

    ...deploymentLocalShared.map((item) => ({
      type:
        'deployment_local_component_marked_shared',
      severity: 'high',
      componentId:
        item.componentId,
      componentName:
        item.componentName,
      deploymentUnitId:
        item.ownDeploymentUnitId,
    })),

    ...unknownConnectedUnits.map((item) => ({
      type:
        'shared_infrastructure_unknown_deployment_unit',
      severity: 'high',
      ...item,
    })),

    ...missingGraphEvidence.map((item) => ({
      type:
        'graph_shared_infrastructure_missing_relationship_evidence',
      severity: 'high',
      componentId:
        item.componentId,
      componentName:
        item.componentName,
    })),
  ];

  return {
    version:
      'enterprise-shared-infrastructure-health-v1',

    valid: violations.length === 0,

    violationCount:
      violations.length,

    missingComponentIdCount:
      missingComponentIds.length,

    deploymentLocalSharedCount:
      deploymentLocalShared.length,

    unknownConnectedDeploymentUnitCount:
      unknownConnectedUnits.length,

    graphSharedWithoutEvidenceCount:
      missingGraphEvidence.length,

    rejectedCandidateCount:
      rejectedCandidates.length,

    traversalChanged: false,

    violations,
  };
}

function buildEnterpriseSharedInfrastructure({
  architectureUnderstanding = {},
  deploymentUnitDiscovery = {},
  sharedNodeUnderstanding = {},
  outputDir = null,
} = {}) {
  const componentIndex =
    buildComponentIndex(
      architectureUnderstanding
    );

  const deploymentIndexes =
    buildDeploymentUnitIndexes(
      deploymentUnitDiscovery
    );

  const traversalSharedIndex =
    buildTraversalSharedIndex(
      sharedNodeUnderstanding
    );

  const relationshipAdjacency =
    buildRelationshipAdjacency(
      architectureUnderstanding
    );

  const accepted = [];
  const rejected = [];

  for (const component of componentIndex.components) {
    const ownDeploymentUnit =
      resolveComponentDeploymentUnit({
        component,
        deploymentIndexes,
      });

    const traversalNode =
      resolveTraversalSharedNode({
        component,
        traversalSharedIndex,
      });

    const connectivity =
      analyzeComponentConnectivity({
        component,
        componentIndex,
        deploymentIndexes,
        relationshipAdjacency,
      });

    const enterpriseSharing =
      classifyEnterpriseSharing({
        component,
        ownDeploymentUnit,
        connectivity,
        traversalNode,
      });

    if (enterpriseSharing.eligible) {
      accepted.push(
        buildCandidate({
          component,
          ownDeploymentUnit,
          connectivity,
          traversalNode,
          enterpriseSharing,
        })
      );

      continue;
    }

    rejected.push({
      componentId:
        component.id || null,

      componentName:
        component.name || null,

      ownDeploymentUnitId:
        ownDeploymentUnit
          ?.deploymentUnitId || null,

      connectedDeploymentUnitCount:
        connectivity
          .connectedDeploymentUnitCount,

      connectedDeploymentUnits:
        connectivity
          .connectedDeploymentUnits,

      traversalShared:
        Boolean(traversalNode?.shared),

      classification:
        enterpriseSharing.classification,

      confidence:
        enterpriseSharing.confidence,

      reasons:
        enterpriseSharing.reasons,
    });
  }

  const sharedInfrastructure =
    uniqueObjectsBy(
      accepted,
      (item) => item.componentId
    );

  const rejectedCandidates =
    uniqueObjectsBy(
      rejected,
      (item) => item.componentId
    );

  const health =
    buildEnterpriseSharedInfrastructureHealth({
      sharedInfrastructure,
      rejectedCandidates,
      deploymentUnitDiscovery,
    });

  const payload = {
    version: BUILDER_VERSION,

    source:
      'enterpriseSharedInfrastructureBuilder',

    purpose:
      'Discover deployment-shared enterprise infrastructure using deterministic deployment membership and architecture graph evidence.',

    rules: {
      deterministicOnly: true,

      traversalMutation:
        'forbidden',

      deploymentMembershipMutation:
        'forbidden',

      traversalSharedDoesNotMeanEnterpriseShared:
        true,

      deploymentLocalComponentsCannotBeSharedInfrastructure:
        true,

      graphEvidencePreferred:
        true,

      explicitGlobalScopeIsSupportingEvidenceOnly:
        true,

      candidateOnly:
        true,
    },

    sharedInfrastructure,

    rejectedCandidates,

    health,

    stats: {
      architectureComponentCount:
        componentIndex.components.length,

      relationshipCount:
        relationshipAdjacency
          .relationships.length,

      deploymentUnitCount:
        deploymentIndexes
          .deploymentUnits.length,

      traversalSharedNodeCount:
        asArray(
          sharedNodeUnderstanding.nodes
        ).length,

      sharedInfrastructureCount:
        sharedInfrastructure.length,

      graphSharedInfrastructureCount:
        sharedInfrastructure.filter(
          (item) =>
            item.enterpriseSharedClassification ===
            'graph_shared_across_deployment_units'
        ).length,

      explicitGlobalSharedCandidateCount:
        sharedInfrastructure.filter(
          (item) =>
            item.enterpriseSharedClassification ===
            'explicit_global_shared_candidate'
        ).length,

      rejectedCandidateCount:
        rejectedCandidates.length,

      deploymentLocalRejectedCount:
        rejectedCandidates.filter(
          (item) =>
            item.classification ===
            'deployment_local'
        ).length,

      documentOrTraversalConceptRejectedCount:
        rejectedCandidates.filter(
          (item) =>
            item.classification ===
            'document_or_traversal_concept'
        ).length,

      insufficientEvidenceRejectedCount:
        rejectedCandidates.filter(
          (item) =>
            item.classification ===
            'insufficient_enterprise_sharing_evidence'
        ).length,

      traversalChanged: false,
    },
  };

  if (outputDir) {
    fs.mkdirSync(
      outputDir,
      { recursive: true }
    );

    fs.writeFileSync(
      path.join(
        outputDir,
        'enterprise-shared-infrastructure.json'
      ),
      JSON.stringify(payload, null, 2),
      'utf8'
    );
  }

  return payload;
}

module.exports = {
  BUILDER_VERSION,
  buildEnterpriseSharedInfrastructure,
};
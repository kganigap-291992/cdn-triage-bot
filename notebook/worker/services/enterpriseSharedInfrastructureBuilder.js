'use strict';

/**
 * enterpriseSharedInfrastructureBuilder.js
 *
 * BUG-17F.5 — Enterprise Shared Infrastructure Discovery
 *
 * Owns:
 * - distinguish traversal-shared nodes from deployment-shared infrastructure
 * - detect components connected to multiple deployment units
* - consume canonical document-backed shared placement evidence
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

  const componentIdToUnits = new Map();
  const componentNameToUnits = new Map();
  const unitById = new Map();

  function addMembership(index, key, unit) {
    if (!key || !unit?.deploymentUnitId) {
      return;
    }

    if (!index.has(key)) {
      index.set(key, []);
    }

    const existing =
      index.get(key);

    if (
      !existing.some(
        (item) =>
          item.deploymentUnitId ===
          unit.deploymentUnitId
      )
    ) {
      existing.push({
        deploymentUnitId:
          unit.deploymentUnitId,

        deploymentUnitTitle:
          unit.title,
      });
    }
  }

  for (const unit of deploymentUnits) {
    if (unit?.deploymentUnitId) {
      unitById.set(
        unit.deploymentUnitId,
        unit
      );
    }

    for (const componentId of asArray(
      unit.componentIds
    )) {
      addMembership(
        componentIdToUnits,
        componentId,
        unit
      );
    }

    for (const componentName of asArray(
      unit.componentNames
    )) {
      addMembership(
        componentNameToUnits,
        safeLower(componentName),
        unit
      );
    }
  }

  return {
    deploymentUnits,
    unitById,
    componentIdToUnits,
    componentNameToUnits,
  };
}

function resolveComponentDeploymentUnits({
  component = null,
  deploymentIndexes = {},
} = {}) {
  if (!component) {
    return [];
  }

  if (
    component.id &&
    deploymentIndexes
      .componentIdToUnits
      ?.has(component.id)
  ) {
    return asArray(
      deploymentIndexes
        .componentIdToUnits
        .get(component.id)
    );
  }

  const nameKey =
    safeLower(component.name);

  if (
    nameKey &&
    deploymentIndexes
      .componentNameToUnits
      ?.has(nameKey)
  ) {
    return asArray(
      deploymentIndexes
        .componentNameToUnits
        .get(nameKey)
    );
  }

  return [];
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
  if (
    component
      ?.enterprisePlacement
      ?.explicitShared === true
  ) {
    return true;
  }

  const value = safeLower([
    component.name,
    component.architectureRole,
    component.role,
    component.type,
  ].filter(Boolean).join(' '));

  return /\b(global|shared|central|common)\b/i
    .test(value);
}


function classifyInfrastructureSemantics(
  component = {}
) {
  const value = safeLower([
    component.name,
    component.architectureRole,
    component.role,
    component.type,
  ].filter(Boolean).join(' '));

  const categories = {
    network_or_routing:
      /\b(dns|cdn|edge|gateway|load balancer|proxy|mesh|router|routing|ingress)\b/i.test(
        value
      ),

    identity_or_security:
      /\b(identity|iam|oidc|auth|authentication|authorization|policy|key|secrets?|vault)\b/i.test(
        value
      ),

    state_or_storage:
      /\b(redis|cache|database|db|postgres|store|storage|object storage|bucket|repository|backup)\b/i.test(
        value
      ),

    messaging_or_streaming:
      /\b(kafka|queue|broker|event bus|stream|registry|schema registry)\b/i.test(
        value
      ),

    configuration_or_control:
      /\b(config|configuration|gitops|control plane|catalog)\b/i.test(
        value
      ),

    observability:
      /\b(telemetry|logging|logs|metrics|monitoring|observability|collector|alerting|tracing)\b/i.test(
        value
      ),
  };

  const infrastructureLike =
    Object.values(
      categories
    ).some(Boolean);

  const applicationOrEndpoint =
    /\b(client|consumer|user|partner client|web|ui|frontend|api pod|gateway pod|public ingress|worker|processor|orchestrator|training jobs?|batch jobs?|application|app|route|routes)\b/i.test(
      value
    );

  return {
    infrastructureLike,
    applicationOrEndpoint,
    categories,
  };
}

function hasInfrastructureSignal(
  component = {}
) {
  return classifyInfrastructureSemantics(
    component
  ).infrastructureLike;
}

/*
 * Bounded graph reachability is weaker than direct cross-unit
 * connectivity, so only infrastructure-like runtime components
 * may be promoted by the bounded graph rule.
 *
 * This prevents clients, application workloads, UIs, jobs, and
 * generic interfaces from becoming shared infrastructure merely
 * because they can reach multiple deployment units.
 */
function isEligibleBoundedSharedInfrastructure(
  component = {}
) {
  const semantics =
    classifyInfrastructureSemantics(
      component
    );

  return (
    semantics.infrastructureLike &&
    !semantics.applicationOrEndpoint
  );
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

function analyzeDirectComponentConnectivity({
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

    const neighborDeploymentUnits =
      resolveComponentDeploymentUnits({
        component: neighbor,
        deploymentIndexes,
      });

    for (
      const neighborDeploymentUnit of
      neighborDeploymentUnits
    ) {
      if (
        !neighborDeploymentUnit
          ?.deploymentUnitId
      ) {
        continue;
      }

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

    fanInObserved:
      incomingRelationshipCount >= 2,

    fanOutObserved:
      outgoingRelationshipCount >= 2,
  };
}

function escapeRegExp(value = '') {
  return safeString(value)
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}


function findDeploymentLocalVariants({
  component = {},
  componentIndex = {},
  deploymentIndexes = {},
} = {}) {
  const baseName = safeString(component.name);

  if (!baseName) {
    return {
      replicatedFamily: false,
      familyName: null,
      variantCount: 0,
      deploymentUnitCount: 0,
      variants: [],
      deploymentUnits: [],
    };
  }

  const escapedBaseName =
    escapeRegExp(baseName);

  const variantPattern =
    new RegExp(
      `^${escapedBaseName}\\s+(?:` +
      `[a-z]|` +
      `[0-9]+|` +
      `east|west|north|south|` +
      `primary|secondary|` +
      `active|standby|` +
      `replica[-_ ]?[a-z0-9]+|` +
      `instance[-_ ]?[a-z0-9]+|` +
      `az[-_ ]?[a-z0-9]+|` +
      `zone[-_ ]?[a-z0-9]+|` +
      `region[-_ ]?[a-z0-9]+` +
      `)$`,
      'i'
    );

  const variants = [];
  const deploymentUnits = new Map();

  for (const candidate of asArray(
    componentIndex.components
  )) {
    if (
      !candidate?.id ||
      candidate.id === component.id
    ) {
      continue;
    }

    const candidateName =
      safeString(candidate.name);

    if (
      !candidateName ||
      !variantPattern.test(candidateName)
    ) {
      continue;
    }

    const candidateDeploymentUnits =
      resolveComponentDeploymentUnits({
        component: candidate,
        deploymentIndexes,
      });

    const deploymentUnit =
      candidateDeploymentUnits.length === 1
        ? candidateDeploymentUnits[0]
        : null;

    if (!deploymentUnit?.deploymentUnitId) {
      continue;
    }

    variants.push({
      componentId: candidate.id,
      componentName: candidate.name,
      deploymentUnitId:
        deploymentUnit.deploymentUnitId,
      deploymentUnitTitle:
        deploymentUnit.deploymentUnitTitle,
    });

    deploymentUnits.set(
      deploymentUnit.deploymentUnitId,
      deploymentUnit
    );
  }

  const uniqueVariants =
    uniqueObjectsBy(
      variants,
      (item) => item.componentId
    );

  return {
    replicatedFamily:
      uniqueVariants.length >= 2 &&
      deploymentUnits.size >= 2,

    familyName: baseName,

    variantCount:
      uniqueVariants.length,

    deploymentUnitCount:
      deploymentUnits.size,

    variants:
      uniqueVariants,

    deploymentUnits:
      Array.from(deploymentUnits.values()),
  };
}


/*
 * Discover deployment units reachable through a bounded graph walk.
 *
 * Safety rules:
 * - stop a branch as soon as a deployment-local component is reached
 * - never traverse through a deployment unit to another unit
 * - never revisit a component
 * - never exceed maxDepth
 * - retain evidence paths for explainability
 */
function analyzeReachableDeploymentUnitConnectivity({
  component = {},
  componentIndex = {},
  deploymentIndexes = {},
  relationshipAdjacency = {},
  maxDepth = 3,
} = {}) {
  if (!component?.id) {
    return {
      maxDepth,
      reachableDeploymentUnitCount: 0,
      reachableDeploymentUnits: [],
      reachablePaths: [],
      evidenceRelationshipIds: [],
      evidenceIds: [],
    };
  }

  const queue = [
    {
      componentId: component.id,
      depth: 0,
      pathComponentIds: [component.id],
      pathComponentNames: [component.name],
      pathRelationshipIds: [],
      pathEvidenceIds: [],
    },
  ];

  const visitedDepthByComponentId =
    new Map([
      [component.id, 0],
    ]);

  const deploymentUnits = new Map();
  const reachablePaths = [];
  const evidenceRelationshipIds = [];
  const evidenceIds = [];

  while (queue.length > 0) {
    const current = queue.shift();

    if (
      !current ||
      current.depth >= maxDepth
    ) {
      continue;
    }

    const edges = asArray(
      relationshipAdjacency
        .adjacencyByComponentId
        ?.get(current.componentId)
    );

    for (const edge of edges) {
      const neighbor =
        componentIndex.byId.get(
          edge.neighborId
        ) || null;

      if (!neighbor?.id) {
        continue;
      }

      const nextDepth =
        current.depth + 1;

      const relationshipId =
        edge.relationship
          ?.relationshipId || null;

      const relationshipEvidenceIds =
        asArray(
          edge.relationship?.evidenceIds
        );

      const nextRelationshipIds =
        uniq([
          ...current.pathRelationshipIds,
          relationshipId,
        ]);

      const nextEvidenceIds =
        uniq([
          ...current.pathEvidenceIds,
          ...relationshipEvidenceIds,
        ]);

      const neighborDeploymentUnits =
        resolveComponentDeploymentUnits({
          component: neighbor,
          deploymentIndexes,
        });

      if (
        neighborDeploymentUnits.length > 0
      ) {
        for (
          const neighborDeploymentUnit of
          neighborDeploymentUnits
        ) {
          if (
            !neighborDeploymentUnit
              ?.deploymentUnitId
          ) {
            continue;
          }

          deploymentUnits.set(
            neighborDeploymentUnit
              .deploymentUnitId,
            neighborDeploymentUnit
          );

          reachablePaths.push({
            deploymentUnitId:
              neighborDeploymentUnit
                .deploymentUnitId,

            deploymentUnitTitle:
              neighborDeploymentUnit
                .deploymentUnitTitle,

            depth: nextDepth,

            terminalComponentId:
              neighbor.id,

            terminalComponentName:
              neighbor.name,

            componentPath: [
              ...current.pathComponentIds,
              neighbor.id,
            ],

            componentNamePath: [
              ...current.pathComponentNames,
              neighbor.name,
            ],

            relationshipIds:
              nextRelationshipIds,

            evidenceIds:
              nextEvidenceIds,
          });
        }

        evidenceRelationshipIds.push(
          ...nextRelationshipIds
        );

        evidenceIds.push(
          ...nextEvidenceIds
        );

        continue;
      }

      const previouslyVisitedDepth =
        visitedDepthByComponentId.get(
          neighbor.id
        );

      if (
        previouslyVisitedDepth !== undefined &&
        previouslyVisitedDepth <= nextDepth
      ) {
        continue;
      }

      visitedDepthByComponentId.set(
        neighbor.id,
        nextDepth
      );

      queue.push({
        componentId: neighbor.id,
        depth: nextDepth,

        pathComponentIds: [
          ...current.pathComponentIds,
          neighbor.id,
        ],

        pathComponentNames: [
          ...current.pathComponentNames,
          neighbor.name,
        ],

        pathRelationshipIds:
          nextRelationshipIds,

        pathEvidenceIds:
          nextEvidenceIds,
      });
    }
  }

  const uniquePaths =
    uniqueObjectsBy(
      reachablePaths,
      (item) =>
        `${item.deploymentUnitId}:` +
        `${item.terminalComponentId}:` +
        `${item.relationshipIds.join('|')}`
    );

  return {
    maxDepth,

    reachableDeploymentUnitCount:
      deploymentUnits.size,

    reachableDeploymentUnits:
      Array.from(deploymentUnits.values()),

    reachablePaths:
      uniquePaths,

    evidenceRelationshipIds:
      uniq(evidenceRelationshipIds),

    evidenceIds:
      uniq(evidenceIds),
  };
}

function getEffectiveDeploymentConnectivity({
  directConnectivity = {},
  reachableConnectivity = {},
} = {}) {
  const directCount =
    Number(
      directConnectivity
        .connectedDeploymentUnitCount || 0
    );

  const reachableCount =
    Number(
      reachableConnectivity
        .reachableDeploymentUnitCount || 0
    );

  const useDirect =
    directCount >= 2;

  return {
    directCount,
    reachableCount,

    effectiveCount:
      useDirect
        ? directCount
        : reachableCount,

    effectiveMode:
      useDirect
        ? 'direct_connectivity'
        : reachableCount > 0
          ? 'bounded_reachability'
          : 'none',

    effectiveDeploymentUnits:
      useDirect
        ? asArray(
            directConnectivity
              .connectedDeploymentUnits
          )
        : asArray(
            reachableConnectivity
              .reachableDeploymentUnits
          ),
  };
}

function classifyEnterpriseSharing({
  component = {},
  ownDeploymentUnit = null,
  ownDeploymentUnits = [],
  directConnectivity = {},
  reachableConnectivity = {},
  replicatedFamily = {},
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
    asArray(ownDeploymentUnits).length >= 2
  ) {
    return {
      eligible: false,
      classification:
        'multi_unit_logical_deployment',
      confidence: 'high',
      reasons: [
        'logical_component_present_in_multiple_deployment_units',
        'multi_unit_deployment_does_not_imply_shared_infrastructure',
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

  /*
   * A generic family node is not a shared singleton when concrete
   * deployment-local variants exist across multiple units.
   */
  if (replicatedFamily.replicatedFamily) {
    return {
      eligible: false,
      classification:
        'replicated_component_family',
      confidence: 'high',
      reasons: [
        'deployment_local_variants_detected',
        'generic_family_node_not_shared_singleton',
        'variants_span_multiple_deployment_units',
      ],
    };
  }

  const connectivity =
    getEffectiveDeploymentConnectivity({
      directConnectivity,
      reachableConnectivity,
    });

  const connectedUnitCount =
    connectivity.directCount;

  const reachableUnitCount =
    connectivity.reachableCount;

  const effectiveUnitCount =
    connectivity.effectiveCount;

  const explicitScope =
    hasExplicitGlobalOrSharedScope(
      component
    );

  const explicitOutsideDeploymentUnits =
    component
      ?.enterprisePlacement
      ?.explicitOutsideDeploymentUnits === true;

  const explicitMultiUnitByEvidence =
    component
      ?.enterprisePlacement
      ?.explicitMultiUnitByEvidence === true;

  const infrastructureSignal =
    hasInfrastructureSignal(
      component
    );

  const boundedInfrastructureEligible =
    isEligibleBoundedSharedInfrastructure(
      component
    );

  const traversalShared =
    Boolean(
      traversalNode?.shared
    );

  /*
   * Strong direct graph-backed infrastructure case:
   * the component reaches members of at least two deployment
   * units and independently passes the infrastructure semantic gate.
   */
  if (
    connectedUnitCount >= 2 &&
    boundedInfrastructureEligible
  ) {
    reasons.push(
      'graph_connected_to_multiple_deployment_units'
    );

    reasons.push(
      'infrastructure_semantic_gate_passed'
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
   * Weaker bounded-reachability case.
   * Because indirect reachability is less conclusive than direct
   * connectivity, infrastructure semantics remains mandatory.
   */
  if (
    reachableUnitCount >= 2 &&
    boundedInfrastructureEligible
  ) {
    reasons.push(
      'bounded_graph_reaches_multiple_deployment_units'
    );

    reasons.push(
      'bounded_graph_infrastructure_semantic_gate_passed'
    );

    reasons.push(
      `bounded_graph_max_depth_${reachableConnectivity.maxDepth}`
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
        'bounded_graph_shared_across_deployment_units',
      confidence:
        explicitScope &&
        infrastructureSignal
          ? 'high'
          : 'medium',
      reasons,
    };
  }

  /*
   * Strong document-defined shared placement.
   *
   * The document explicitly classifies this component as shared,
   * places it outside deployment units, and states that it serves
   * more than one deployment unit.
   */
  if (
    explicitScope &&
    explicitOutsideDeploymentUnits &&
    explicitMultiUnitByEvidence
  ) {
    return {
      eligible: true,
      classification:
        'explicit_document_shared_infrastructure',
      confidence: 'high',
      reasons: [
        'explicit_global_or_shared_scope',
        'explicit_outside_deployment_units',
        'explicit_multi_unit_document_evidence',
        connectedUnitCount >= 1
          ? 'graph_connected_to_deployment_unit'
          : 'graph_cross_unit_usage_not_required_for_explicit_document_scope',
      ],
    };
  }

  /*
   * Conservative explicit candidate:
   * explicit global/shared scope plus graph connectivity
   * and independent traversal-sharing evidence.
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
      effectiveUnitCount === 0
        ? 'no_graph_connection_to_deployment_unit'
        : effectiveUnitCount === 1
          ? 'connected_or_reachable_to_only_one_deployment_unit'
          : !boundedInfrastructureEligible
            ? 'multiple_deployment_units_reachable_but_bounded_semantic_gate_failed'
            : 'multiple_deployment_units_reachable_but_shared_infrastructure_evidence_incomplete',

      !boundedInfrastructureEligible
        ? 'not_eligible_for_bounded_shared_infrastructure'
        : null,

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
  directConnectivity = {},
  reachableConnectivity = {},
  traversalNode = null,
  enterpriseSharing = {},
} = {}) {
  const connectivity =
    getEffectiveDeploymentConnectivity({
      directConnectivity,
      reachableConnectivity,
    });
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

    directConnectedDeploymentUnitCount:
      directConnectivity
        .connectedDeploymentUnitCount,

    directConnectedDeploymentUnits:
      directConnectivity
        .connectedDeploymentUnits,

    reachableDeploymentUnitCount:
      reachableConnectivity
        .reachableDeploymentUnitCount,

    reachableDeploymentUnits:
      reachableConnectivity
        .reachableDeploymentUnits,

    reachableMaxDepth:
      reachableConnectivity.maxDepth,

    reachablePaths:
      reachableConnectivity
        .reachablePaths,

    connectedDeploymentUnitCount:
      connectivity.effectiveCount,

    connectedDeploymentUnits:
      connectivity.effectiveDeploymentUnits,

    connectedComponents:
      directConnectivity
        .connectedComponents,

    incomingRelationshipCount:
      directConnectivity
        .incomingRelationshipCount,

    outgoingRelationshipCount:
      directConnectivity
        .outgoingRelationshipCount,

    fanInObserved:
      Boolean(
        directConnectivity
          .fanInObserved
      ),

    fanOutObserved:
      Boolean(
        directConnectivity
          .fanOutObserved
      ),

    adjacencyCount:
      directConnectivity.adjacencyCount,

    graphEvidenceMode:
      connectivity.effectiveMode,

    graphBacked:
      directConnectivity
        .connectedDeploymentUnitCount >= 2 ||
      reachableConnectivity
        .reachableDeploymentUnitCount >= 2,

    canonicalPlacementBacked:
      enterpriseSharing.classification ===
        'explicit_document_shared_infrastructure',

    explicitScopeBacked:
      hasExplicitGlobalOrSharedScope(
        component
      ),

    explicitOutsideDeploymentUnits:
      component
        ?.enterprisePlacement
        ?.explicitOutsideDeploymentUnits === true,

    explicitMultiUnitByEvidence:
      component
        ?.enterprisePlacement
        ?.explicitMultiUnitByEvidence === true,

    enterprisePlacementEvidenceIds:
      uniq(
        component
          ?.enterprisePlacement
          ?.evidenceIds
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
      uniq([
        ...asArray(
          directConnectivity
            .evidenceRelationshipIds
        ),
        ...asArray(
          reachableConnectivity
            .evidenceRelationshipIds
        ),
      ]),

    evidenceIds:
      uniq([
        ...asArray(
          directConnectivity.evidenceIds
        ),
        ...asArray(
          reachableConnectivity.evidenceIds
        ),
        ...asArray(
          component
            ?.enterprisePlacement
            ?.evidenceIds
        ),
      ]),

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
    const ownDeploymentUnits =
      resolveComponentDeploymentUnits({
        component,
        deploymentIndexes,
      });

    const ownDeploymentUnit =
      ownDeploymentUnits.length === 1
        ? ownDeploymentUnits[0]
        : null;

    const traversalNode =
      resolveTraversalSharedNode({
        component,
        traversalSharedIndex,
      });

    const directConnectivity =
      analyzeDirectComponentConnectivity({
        component,
        componentIndex,
        deploymentIndexes,
        relationshipAdjacency,
      });

    const reachableConnectivity =
      analyzeReachableDeploymentUnitConnectivity({
        component,
        componentIndex,
        deploymentIndexes,
        relationshipAdjacency,
        maxDepth: 3,
      });

    const replicatedFamily =
      findDeploymentLocalVariants({
        component,
        componentIndex,
        deploymentIndexes,
      });

    const enterpriseSharing =
      classifyEnterpriseSharing({
        component,
        ownDeploymentUnit,
        ownDeploymentUnits,
        directConnectivity,
        reachableConnectivity,
        replicatedFamily,
        traversalNode,
      });

    if (enterpriseSharing.eligible) {
      accepted.push(
        buildCandidate({
          component,
          ownDeploymentUnit,
          directConnectivity,
          reachableConnectivity,
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

      directConnectedDeploymentUnitCount:
        directConnectivity
          .connectedDeploymentUnitCount,

      directConnectedDeploymentUnits:
        directConnectivity
          .connectedDeploymentUnits,

      reachableDeploymentUnitCount:
        reachableConnectivity
          .reachableDeploymentUnitCount,

      reachableDeploymentUnits:
        reachableConnectivity
          .reachableDeploymentUnits,

      replicatedFamily:
        Boolean(
          replicatedFamily.replicatedFamily
        ),

      replicatedFamilyName:
        replicatedFamily.familyName,

      replicatedVariantCount:
        replicatedFamily.variantCount,

      replicatedVariants:
        replicatedFamily.variants,

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

      explicitDocumentSharedPlacementMayEstablishCandidate:
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
              'graph_shared_across_deployment_units' ||
            item.enterpriseSharedClassification ===
              'bounded_graph_shared_across_deployment_units'
        ).length,

      directGraphSharedInfrastructureCount:
        sharedInfrastructure.filter(
          (item) =>
            item.enterpriseSharedClassification ===
              'graph_shared_across_deployment_units'
        ).length,

      boundedGraphSharedInfrastructureCount:
        sharedInfrastructure.filter(
          (item) =>
            item.enterpriseSharedClassification ===
              'bounded_graph_shared_across_deployment_units'
        ).length,

      replicatedComponentFamilyRejectedCount:
        rejectedCandidates.filter(
          (item) =>
            item.classification ===
              'replicated_component_family'
        ).length,

      explicitDocumentSharedInfrastructureCount:
        sharedInfrastructure.filter(
          (item) =>
            item.enterpriseSharedClassification ===
              'explicit_document_shared_infrastructure'
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
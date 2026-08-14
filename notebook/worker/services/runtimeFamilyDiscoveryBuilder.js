'use strict';

/**
 * runtimeFamilyDiscoveryBuilder.js
 *
 * BUG-8 — Replica / Runtime Family Discovery
 *
 * Owns:
 * - discover explicit runtime-instance labels from document evidence
 * - separate runtime family identity from deployed instance identity
 * - group sibling instances by shared family name
 * - attach runtime instances to deployment units
 * - conservatively link runtime families to logical canonical components
 * - preserve deterministic evidence and provenance
 *
 * Borrowed ideas:
 * - Kubernetes:
 *     Deployment / ReplicaSet / Pod identity separation
 * - OpenTelemetry:
 *     service.name versus service.instance.id
 * - C4 deployment model:
 *     logical software identity versus deployed instances
 * - Existing Notebook builders:
 *     deployment differentiator normalization
 *     deployment-unit membership
 *     canonical registry ownership
 *     health / safety / provenance contracts
 *
 * Does NOT:
 * - add runtime instances to the logical architecture graph
 * - infer active-active, failover, or disaster recovery
 * - infer replication technology
 * - promote runtime instances to shared infrastructure
 * - broadly resolve aliases
 * - mutate traversal
 * - call an LLM
 */

const fs = require('fs');
const path = require('path');

const BUILDER_VERSION =
  'runtime-family-discovery-v1';

function asArray(value) {
  return Array.isArray(value)
    ? value
    : [];
}

function safeString(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function safeLower(value) {
  return safeString(value)
    .toLowerCase();
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
        .filter(
          (value) =>
            value !== null &&
            value !== undefined &&
            value !== ''
        )
    )
  );
}

function normalizeDifferentiator(value) {
  const text =
    safeLower(value)
      .replace(/^availability\s+zone\s+/, '')
      .replace(/^zone\s+/, '')
      .replace(/^az[-_ ]?/, '')
      .replace(/^region\s+/, '')
      .replace(/^site\s+/, '')
      .replace(/^cell\s+/, '')
      .trim();

  if (!text) {
    return null;
  }

  const aliases = {
    first: '1',
    second: '2',
    third: '3',
    one: '1',
    two: '2',
    three: '3',
  };

  return aliases[text] || text;
}

/*
 * V1 intentionally supports explicit deployment-like suffixes.
 *
 * Examples:
 *   Atlas Worker 1
 *   Atlas Worker A
 *   Query API East
 *   Processor Primary
 *
 * Non-examples:
 *   Phase 1
 *   Step 2
 *   BUG-8
 *   HTTP 2
 */
const INSTANCE_DIFFERENTIATOR_PATTERN =
  '(?:[1-9][0-9]*|[A-D]|East|West|North|South|Primary|Secondary|Active|Standby|Passive)';

const RUNTIME_FAMILY_ROLE_PATTERN =
  /\b(worker|processor|indexer|api|service|application|app|cache|replica|database|db|pod|node|instance|runtime|executor|consumer|producer|gateway|router|broker|queue|scheduler|orchestrator|engine|cluster|server)\b/i;

const DOCUMENT_NOISE_PATTERN =
  /\b(step|phase|bug|page|figure|table|chapter|section|example|version|journey)\b/i;

const PROTOCOL_OR_FORMAT_PATTERN =
  /^(http|https|tcp|udp|hls|dash|mp4|json|xml|yaml|oidc)\s+[a-z0-9-]+$/i;

function parseRuntimeInstanceLabel(value = '') {
  const name =
    safeString(value);

  if (
    !name ||
    name.length < 4 ||
    name.length > 100
  ) {
    return null;
  }

  if (
    DOCUMENT_NOISE_PATTERN.test(name) ||
    PROTOCOL_OR_FORMAT_PATTERN.test(name)
  ) {
    return null;
  }

  const suffixMatch =
    name.match(
      new RegExp(
        `^(.*?)\\s+(${INSTANCE_DIFFERENTIATOR_PATTERN})$`,
        'i'
      )
    );

  if (!suffixMatch) {
    return null;
  }

  const familyName =
    safeString(suffixMatch[1]);

  const rawDifferentiator =
    safeString(suffixMatch[2]);

  if (
    !familyName ||
    familyName.length < 3 ||
    !RUNTIME_FAMILY_ROLE_PATTERN.test(
      familyName
    )
  ) {
    return null;
  }

  const differentiator =
    normalizeDifferentiator(
      rawDifferentiator
    );

  if (!differentiator) {
    return null;
  }

  return {
    runtimeFamilyId:
      `runtime_family_${slugify(
        familyName
      )}`,

    runtimeFamilyName:
      familyName,

    runtimeInstanceId:
      slugify(name),

    runtimeInstanceName:
      name,

    rawDifferentiator,

    instanceDifferentiator:
      differentiator,
  };
}

function isStrongRuntimeInstanceEvidence(
  evidence = {}
) {
  const text =
    safeString(evidence.text);

  const type =
    safeLower(evidence.type);

  const source =
    safeLower(evidence.source);

  if (!text) {
    return false;
  }

  /*
   * Prefer explicit short labels.
   *
   * EPG examples currently arrive as:
   *   type = section
   *   source = layoutBoxBuilder:pymupdf-heading-section
   */
  const explicitStructuralLabel =
    (
      type === 'section' ||
      type === 'heading' ||
      type === 'label' ||
      type === 'diagram_label'
    ) &&
    text.length <= 100;

  const layoutHeadingLabel =
    source.includes(
      'heading-section'
    ) &&
    text.length <= 100;

  return (
    explicitStructuralLabel ||
    layoutHeadingLabel
  );
}

function collectRuntimeInstanceCandidates({
  documentUnderstanding = {},
} = {}) {
  const evidence =
    asArray(
      documentUnderstanding.evidence
    );

  const candidatesById =
    new Map();

  for (const item of evidence) {
    if (
      !isStrongRuntimeInstanceEvidence(
        item
      )
    ) {
      continue;
    }

    const parsed =
      parseRuntimeInstanceLabel(
        item.text
      );

    if (!parsed) {
      continue;
    }

    const key =
      parsed.runtimeInstanceId;

    const existing =
      candidatesById.get(key) || {
        ...parsed,

        evidenceIds: [],

        pages: [],

        sectionIds: [],

        parentSectionIds: [],

        headingKinds: [],

        evidenceSources: [],

        evidenceTypes: [],

        confidence:
          'high',

        source:
          'document-understanding.json',
      };

    existing.evidenceIds =
      uniq([
        ...existing.evidenceIds,
        item.id,
      ]);

    existing.pages =
      uniq([
        ...existing.pages,
        item.page,
      ]);

    existing.sectionIds =
      uniq([
        ...existing.sectionIds,
        item.sectionId,
      ]);

    existing.parentSectionIds =
      uniq([
        ...existing.parentSectionIds,
        item.parentSectionId,
      ]);

    existing.headingKinds =
      uniq([
        ...existing.headingKinds,
        item.headingKind,
      ]);

    existing.evidenceSources =
      uniq([
        ...existing.evidenceSources,
        item.source,
      ]);

    existing.evidenceTypes =
      uniq([
        ...existing.evidenceTypes,
        item.type,
      ]);

    candidatesById.set(
      key,
      existing
    );
  }

  return Array
    .from(
      candidatesById.values()
    )
    .sort((left, right) => {
      const familyComparison =
        left.runtimeFamilyName
          .localeCompare(
            right.runtimeFamilyName
          );

      if (familyComparison !== 0) {
        return familyComparison;
      }

      return String(
        left.instanceDifferentiator
      ).localeCompare(
        String(
          right.instanceDifferentiator
        ),
        undefined,
        {
          numeric: true,
        }
      );
    });
}

function buildDeploymentUnitIndex({
  deploymentUnitDiscovery = {},
} = {}) {
  const deploymentUnits =
    asArray(
      deploymentUnitDiscovery
        .deploymentUnits
    );

  const byDifferentiator =
    new Map();

  for (const unit of deploymentUnits) {
    const differentiator =
      normalizeDifferentiator(
        unit.deploymentDifferentiator
      );

    if (!differentiator) {
      continue;
    }

    if (
      !byDifferentiator.has(
        differentiator
      )
    ) {
      byDifferentiator.set(
        differentiator,
        []
      );
    }

    byDifferentiator
      .get(differentiator)
      .push(unit);
  }

  return {
    deploymentUnits,
    byDifferentiator,
  };
}

function resolveInstanceDeploymentUnit({
  instance = {},
  deploymentUnitIndex = {},
} = {}) {
  const differentiator =
    normalizeDifferentiator(
      instance.instanceDifferentiator
    );

  if (!differentiator) {
    return {
      deploymentUnit:
        null,

      matchType:
        'missing_instance_differentiator',

      confidence:
        'low',
    };
  }

  const matchingUnits =
    asArray(
      deploymentUnitIndex
        .byDifferentiator
        ?.get(differentiator)
    );

  if (matchingUnits.length === 1) {
    return {
      deploymentUnit:
        matchingUnits[0],

      matchType:
        'deployment_differentiator_exact_match',

      confidence:
        'high',
    };
  }

  if (matchingUnits.length > 1) {
    return {
      deploymentUnit:
        null,

      matchType:
        'ambiguous_deployment_differentiator',

      confidence:
        'low',

      candidateDeploymentUnitIds:
        matchingUnits
          .map(
            (unit) =>
              unit.deploymentUnitId
          )
          .filter(Boolean),
    };
  }

  return {
    deploymentUnit:
      null,

    matchType:
      'deployment_differentiator_not_found',

    confidence:
      'low',
  };
}

function buildCanonicalComponentIndex({
  documentUnderstanding = {},
  architectureUnderstanding = {},
  componentAliasRegistry = {},
} = {}) {
  const documentComponents =
    asArray(
      documentUnderstanding
        .canonicalComponents
    );

  const architectureComponents =
    asArray(
      architectureUnderstanding
        ?.deterministicGraph
        ?.components
    );

  const byId =
    new Map();

  const byName =
    new Map();

  const byAlias =
    new Map();

  for (const component of [
    ...documentComponents.map(
      (item) => ({
        id:
          item.id,

        name:
          item.title ||
          item.name,

        rawIdentityNames:
          item.rawIdentityNames,

        source:
          'document-understanding.json',
      })
    ),

    ...architectureComponents.map(
      (item) => ({
        id:
          item.id,

        name:
          item.name,

        rawIdentityNames:
          item.rawIdentityNames,

        source:
          'architecture-understanding.json',
      })
    ),
  ]) {
    if (
      !component.id ||
      !safeString(component.name)
    ) {
      continue;
    }

    byId.set(
      component.id,
      component
    );

    byName.set(
      safeLower(component.name),
      component
    );
  }

  /*
   * Consume only aliases already resolved by the
   * canonical alias registry.
   *
   * componentAliasRegistry.aliasLookup contains
   * deterministic, unambiguous alias ownership.
   *
   * Runtime-family discovery does not infer,
   * expand, or guess aliases here.
   */
  for (
    const aliasRecord of
    asArray(
      componentAliasRegistry.aliasLookup
    )
  ) {
    const normalizedAlias =
      safeLower(
        aliasRecord.normalizedAlias ||
        aliasRecord.alias
      );

    const componentId =
      safeString(
        aliasRecord.componentId
      );

    if (
      !normalizedAlias ||
      !componentId
    ) {
      continue;
    }

    const component =
      byId.get(componentId);

    if (!component) {
      continue;
    }

    byAlias.set(
      normalizedAlias,
      component
    );
  }

  return {
    byId,
    byName,
    byAlias,

    components:
      Array.from(
        byId.values()
      ),
  };
}

function resolveLogicalComponent({
  runtimeFamilyName = '',
  canonicalComponentIndex = {},
} = {}) {
  const familyName =
    safeString(runtimeFamilyName);

  const familyLower =
    safeLower(familyName);

  if (!familyName) {
    return {
      logicalComponent:
        null,

      resolution:
        'missing_runtime_family_name',

      confidence:
        'low',
    };
  }

  const exact =
    canonicalComponentIndex
      .byName
      ?.get(familyLower);

  if (exact) {
    return {
      logicalComponent:
        exact,

      resolution:
        'exact_canonical_name_match',

      confidence:
        'high',
    };
  }
   
  const exactAlias =
        canonicalComponentIndex
            .byAlias
            ?.get(familyLower);

        if (exactAlias) {
        return {
            logicalComponent:
            exactAlias,

            resolution:
            'exact_registered_alias_match',

            confidence:
            'high',
        };
    }
  /*
    * Conservative canonical-parent resolution.
    *
    * Resolution order:
    *
    * 1. Exact canonical component name.
    * 2. Exact registered alias from the
    *    canonical alias registry.
    * 3. Explicit canonical-prefix match.
    *
    * Runtime role words such as Worker,
    * API, Service, Cache, Replica,
    * Pod or Instance never establish
    * logical identity on their own.
    *
    * If no deterministic identity exists,
    * the runtime family remains unresolved.
    */
  const prefixCandidates =
    asArray(
      canonicalComponentIndex.components
    )
      .filter((component) => {
        const componentName =
          safeString(
            component.name
          );

        const componentLower =
          safeLower(
            componentName
          );

        if (
          !componentLower ||
          componentLower.length < 3
        ) {
          return false;
        }

        return (
          familyLower ===
            componentLower ||
          familyLower.startsWith(
            `${componentLower} `
          )
        );
      })
      .sort(
        (left, right) =>
          safeString(
            right.name
          ).length -
          safeString(
            left.name
          ).length
      );

  if (prefixCandidates.length === 1) {
    return {
      logicalComponent:
        prefixCandidates[0],

      resolution:
        'canonical_prefix_match',

      confidence:
        'high',
    };
  }

  if (prefixCandidates.length > 1) {
    const longest =
      prefixCandidates[0];

    const second =
      prefixCandidates[1];

    if (
      safeString(longest.name).length >
      safeString(second.name).length
    ) {
      return {
        logicalComponent:
          longest,

        resolution:
          'longest_canonical_prefix_match',

        confidence:
          'medium',
      };
    }

    return {
      logicalComponent:
        null,

      resolution:
        'ambiguous_canonical_prefix_match',

      confidence:
        'low',

      candidateLogicalComponentIds:
        prefixCandidates
          .map(
            (component) =>
              component.id
          )
          .filter(Boolean),
    };
  }

  return {
    logicalComponent:
      null,

    resolution:
      'unresolved',

    confidence:
      'low',
  };
}

function groupRuntimeFamilies({
  runtimeInstanceCandidates = [],
  deploymentUnitDiscovery = {},
  documentUnderstanding = {},
  architectureUnderstanding = {},
  componentAliasRegistry = {},
} = {}) {
  const deploymentUnitIndex =
    buildDeploymentUnitIndex({
      deploymentUnitDiscovery,
    });

  const canonicalComponentIndex =
    buildCanonicalComponentIndex({
        documentUnderstanding,
        architectureUnderstanding,
        componentAliasRegistry,
    });

  const familyMap =
    new Map();

  for (
    const candidate of
    runtimeInstanceCandidates
  ) {
    const familyKey =
      safeLower(
        candidate.runtimeFamilyName
      );

    if (!familyKey) {
      continue;
    }

    if (!familyMap.has(familyKey)) {
      familyMap.set(
        familyKey,
        {
          runtimeFamilyId:
            candidate.runtimeFamilyId,

          runtimeFamilyName:
            candidate.runtimeFamilyName,

          instances: [],
        }
      );
    }

    const deploymentResolution =
      resolveInstanceDeploymentUnit({
        instance:
          candidate,

        deploymentUnitIndex,
      });

    const deploymentUnit =
      deploymentResolution
        .deploymentUnit;

    familyMap
      .get(familyKey)
      .instances
      .push({
        runtimeInstanceId:
          candidate.runtimeInstanceId,

        runtimeInstanceName:
          candidate.runtimeInstanceName,

        rawDifferentiator:
          candidate.rawDifferentiator,

        instanceDifferentiator:
          candidate.instanceDifferentiator,

        deploymentUnitId:
          deploymentUnit
            ?.deploymentUnitId ||
          null,

        deploymentUnitTitle:
          deploymentUnit
            ?.title ||
          null,

        deploymentMatchType:
          deploymentResolution
            .matchType,

        deploymentMatchConfidence:
          deploymentResolution
            .confidence,

        candidateDeploymentUnitIds:
          asArray(
            deploymentResolution
              .candidateDeploymentUnitIds
          ),

        evidenceIds:
          candidate.evidenceIds,

        pages:
          candidate.pages,

        sectionIds:
          candidate.sectionIds,

        parentSectionIds:
          candidate.parentSectionIds,

        headingKinds:
          candidate.headingKinds,

        evidenceSources:
          candidate.evidenceSources,

        evidenceTypes:
          candidate.evidenceTypes,

        confidence:
          candidate.confidence,

        source:
          candidate.source,
      });
  }

  return Array
    .from(
      familyMap.values()
    )
    /*
     * A family requires at least two distinct explicit
     * deployed instances.
     */
    .filter((family) => {
      const differentiators =
        new Set(
          family.instances
            .map(
              (instance) =>
                normalizeDifferentiator(
                  instance
                    .instanceDifferentiator
                )
            )
            .filter(Boolean)
        );

      return (
        family.instances.length >= 2 &&
        differentiators.size >= 2
      );
    })
    .map((family) => {
      const logicalResolution =
        resolveLogicalComponent({
          runtimeFamilyName:
            family.runtimeFamilyName,

          canonicalComponentIndex,
        });

      const logicalComponent =
        logicalResolution
          .logicalComponent;

      const instances =
        family.instances
          .sort((left, right) =>
            String(
              left.instanceDifferentiator
            ).localeCompare(
              String(
                right.instanceDifferentiator
              ),
              undefined,
              {
                numeric: true,
              }
            )
          );

      const distinctDeploymentUnitIds =
        uniq(
          instances.map(
            (instance) =>
              instance.deploymentUnitId
          )
        );

      const matchedInstanceCount =
        instances.filter(
          (instance) =>
            Boolean(
              instance.deploymentUnitId
            )
        ).length;

      return {
        runtimeFamilyId:
          family.runtimeFamilyId,

        runtimeFamilyName:
          family.runtimeFamilyName,

        logicalComponentId:
          logicalComponent?.id ||
          null,

        logicalComponentName:
          logicalComponent?.name ||
          null,

        logicalComponentResolution:
          logicalResolution
            .resolution,

        logicalComponentConfidence:
          logicalResolution
            .confidence,

        candidateLogicalComponentIds:
          asArray(
            logicalResolution
              .candidateLogicalComponentIds
          ),

        runtimeFamilyType:
          'deployment_local_runtime_family',

        instanceCount:
          instances.length,

        distinctDifferentiatorCount:
          new Set(
            instances.map(
              (instance) =>
                normalizeDifferentiator(
                  instance
                    .instanceDifferentiator
                )
            )
          ).size,

        distinctDeploymentUnitCount:
          distinctDeploymentUnitIds.length,

        genericFamilyIsSingleton:
          false,

        deploymentLocal:
          true,

        allInstancesDeploymentMatched:
          matchedInstanceCount ===
          instances.length,

        matchedInstanceCount,

        unmatchedInstanceCount:
          instances.length -
          matchedInstanceCount,

        instances,

        evidenceIds:
          uniq(
            instances.flatMap(
              (instance) =>
                instance.evidenceIds
            )
          ),

        pages:
          uniq(
            instances.flatMap(
              (instance) =>
                instance.pages
            )
          ),

        sectionIds:
          uniq(
            instances.flatMap(
              (instance) =>
                instance.sectionIds
            )
          ),

        basis: [
          'explicit_runtime_instance_labels',
          'shared_runtime_family_base_name',
          'distinct_instance_differentiators',
          'deployment_unit_differentiator_matching',
        ],

        confidence:
          matchedInstanceCount ===
            instances.length
            ? 'high'
            : 'medium',

        candidateOnly:
          false,

        source:
          'runtimeFamilyDiscoveryBuilder',

        safety: {
          doNotClaimActiveActive:
            true,

          doNotClaimFailover:
            true,

          doNotClaimDisasterRecovery:
            true,

          doNotClaimReplicationTechnology:
            true,

          doNotPromoteToSharedInfrastructure:
            true,

          doNotMutateLogicalArchitectureGraph:
            true,

          doNotMutateTraversal:
            true,
        },
      };
    })
    .sort(
      (left, right) =>
        left.runtimeFamilyName
          .localeCompare(
            right.runtimeFamilyName
          )
    );
}

function buildRuntimeFamilyHealth({
  runtimeInstanceCandidates = [],
  runtimeFamilies = [],
} = {}) {
  const allInstances =
    runtimeFamilies.flatMap(
      (family) =>
        asArray(
          family.instances
        )
    );

  const missingFamilyIds =
    runtimeFamilies.filter(
      (family) =>
        !safeString(
          family.runtimeFamilyId
        )
    );

  const missingFamilyNames =
    runtimeFamilies.filter(
      (family) =>
        !safeString(
          family.runtimeFamilyName
        )
    );

  const duplicateFamilyIds =
    runtimeFamilies
      .map(
        (family) =>
          family.runtimeFamilyId
      )
      .filter(
        (id, index, ids) =>
          id &&
          ids.indexOf(id) !==
            index
      );

  const duplicateInstanceIds =
    allInstances
      .map(
        (instance) =>
          instance.runtimeInstanceId
      )
      .filter(
        (id, index, ids) =>
          id &&
          ids.indexOf(id) !==
            index
      );

  const singletonFamilies =
    runtimeFamilies.filter(
      (family) =>
        Number(
          family.instanceCount ||
          0
        ) < 2
    );

  const unmatchedInstances =
    allInstances.filter(
      (instance) =>
        !safeString(
          instance.deploymentUnitId
        )
    );

  const instancesWithoutEvidence =
    allInstances.filter(
      (instance) =>
        asArray(
          instance.evidenceIds
        ).length === 0
    );

  const unresolvedLogicalFamilies =
    runtimeFamilies.filter(
      (family) =>
        !safeString(
          family.logicalComponentId
        )
    );

  const traversalChanged =
    false;

  const graphChanged =
    false;

  const violations = [
    ...missingFamilyIds.map(
      (family) => ({
        type:
          'missing_runtime_family_id',

        severity:
          'high',

        runtimeFamilyName:
          family.runtimeFamilyName ||
          null,
      })
    ),

    ...missingFamilyNames.map(
      (family) => ({
        type:
          'missing_runtime_family_name',

        severity:
          'high',

        runtimeFamilyId:
          family.runtimeFamilyId ||
          null,
      })
    ),

    ...duplicateFamilyIds.map(
      (runtimeFamilyId) => ({
        type:
          'duplicate_runtime_family_id',

        severity:
          'high',

        runtimeFamilyId,
      })
    ),

    ...duplicateInstanceIds.map(
      (runtimeInstanceId) => ({
        type:
          'duplicate_runtime_instance_id',

        severity:
          'high',

        runtimeInstanceId,
      })
    ),

    ...singletonFamilies.map(
      (family) => ({
        type:
          'runtime_family_has_fewer_than_two_instances',

        severity:
          'high',

        runtimeFamilyId:
          family.runtimeFamilyId,

        runtimeFamilyName:
          family.runtimeFamilyName,
      })
    ),

    ...instancesWithoutEvidence.map(
      (instance) => ({
        type:
          'runtime_instance_without_evidence',

        severity:
          'high',

        runtimeInstanceId:
          instance.runtimeInstanceId,

        runtimeInstanceName:
          instance.runtimeInstanceName,
      })
    ),
  ];

  const warnings = [
    ...unmatchedInstances.map(
      (instance) => ({
        type:
          'runtime_instance_without_deployment_unit',

        severity:
          'warning',

        runtimeInstanceId:
          instance.runtimeInstanceId,

        runtimeInstanceName:
          instance.runtimeInstanceName,

        instanceDifferentiator:
          instance.instanceDifferentiator,
      })
    ),

    ...unresolvedLogicalFamilies.map(
      (family) => ({
        type:
          'runtime_family_without_logical_component',

        severity:
          'warning',

        runtimeFamilyId:
          family.runtimeFamilyId,

        runtimeFamilyName:
          family.runtimeFamilyName,

        logicalComponentResolution:
          family.logicalComponentResolution,
      })
    ),
  ];

  return {
    version:
      'runtime-family-discovery-health-v1',

    valid:
      violations.length === 0 &&
      traversalChanged === false &&
      graphChanged === false,

    violationCount:
      violations.length,

    warningCount:
      warnings.length,

    runtimeInstanceCandidateCount:
      runtimeInstanceCandidates.length,

    runtimeFamilyCount:
      runtimeFamilies.length,

    runtimeInstanceCount:
      allInstances.length,

    matchedDeploymentInstanceCount:
      allInstances.length -
      unmatchedInstances.length,

    unmatchedDeploymentInstanceCount:
      unmatchedInstances.length,

    unresolvedLogicalFamilyCount:
      unresolvedLogicalFamilies.length,

    singletonFamilyCount:
      singletonFamilies.length,

    duplicateRuntimeFamilyIdCount:
      duplicateFamilyIds.length,

    duplicateRuntimeInstanceIdCount:
      duplicateInstanceIds.length,

    runtimeInstanceWithoutEvidenceCount:
      instancesWithoutEvidence.length,

    genericFamilySingletonCount:
      runtimeFamilies.filter(
        (family) =>
          family
            .genericFamilyIsSingleton ===
          true
      ).length,

    traversalChanged,

    graphChanged,

    violations,

    warnings,
  };
}

function buildRuntimeFamilyDiscovery({
  documentUnderstanding = {},
  architectureUnderstanding = {},
  deploymentUnitDiscovery = {},
  componentAliasRegistry = {},
  outputDir = null,
} = {}) {
  const runtimeInstanceCandidates =
    collectRuntimeInstanceCandidates({
      documentUnderstanding,
    });

  const runtimeFamilies =
    groupRuntimeFamilies({
        runtimeInstanceCandidates,
        deploymentUnitDiscovery,
        documentUnderstanding,
        architectureUnderstanding,
        componentAliasRegistry,
    });

  const health =
    buildRuntimeFamilyHealth({
      runtimeInstanceCandidates,
      runtimeFamilies,
    });

  const runtimeInstances =
    runtimeFamilies.flatMap(
      (family) =>
        asArray(
          family.instances
        ).map(
          (instance) => ({
            ...instance,

            runtimeFamilyId:
              family.runtimeFamilyId,

            runtimeFamilyName:
              family.runtimeFamilyName,

            logicalComponentId:
              family.logicalComponentId,

            logicalComponentName:
              family.logicalComponentName,
          })
        )
    );

  const payload = {
    version:
      BUILDER_VERSION,

    source:
      'runtimeFamilyDiscoveryBuilder',

    purpose:
      'Discover evidence-backed runtime families and deployed instances while preserving logical architecture identity.',

    borrowedIdeas: [
      'kubernetes_deployment_replicaset_pod_identity',
      'opentelemetry_service_name_and_service_instance_id',
      'c4_logical_software_and_deployment_instance_separation',
      'notebook_canonical_component_registry',
      'notebook_deployment_differentiator_normalization',
      'notebook_deployment_unit_membership',
    ],

    rules: {
      deterministicOnly:
        true,

      llmGeneratedRuntimeFamilies:
        'forbidden',

      logicalGraphMutation:
        'forbidden',

      traversalMutation:
        'forbidden',

      sharedInfrastructurePromotion:
        'forbidden',

      activeActiveClaims:
        'forbidden',

      failoverClaims:
        'forbidden',

      disasterRecoveryClaims:
        'forbidden',

      replicationTechnologyClaims:
        'forbidden',

      minimumDistinctInstancesPerFamily:
        2,

      explicitRuntimeLabelsPreferred:
        true,

      deploymentDifferentiatorMatchPreferred:
            true,

        registeredAliasResolution:
            'exact_unambiguous_only',

        inferredSemanticAliasResolution:
            'forbidden',

        fuzzyLogicalComponentResolution:
            'forbidden',

        unresolvedLogicalParentsAllowed:
            true,
    },

    runtimeInstanceCandidates,

    runtimeFamilies,

    runtimeInstances,

    health,

    sourceArtifacts: {
        documentUnderstanding:
            documentUnderstanding.version ||
            null,

        architectureUnderstanding:
            architectureUnderstanding.version ||
            architectureUnderstanding.schemaVersion ||
            null,

        deploymentUnitDiscovery:
            deploymentUnitDiscovery.version ||
            null,

        componentAliasRegistry:
            componentAliasRegistry.version ||
            null,
        },

    stats: {
      runtimeInstanceCandidateCount:
        runtimeInstanceCandidates.length,

      runtimeFamilyCount:
        runtimeFamilies.length,

      runtimeInstanceCount:
        runtimeInstances.length,

      deploymentMatchedInstanceCount:
        runtimeInstances.filter(
          (instance) =>
            Boolean(
              instance.deploymentUnitId
            )
        ).length,

      deploymentUnmatchedInstanceCount:
        runtimeInstances.filter(
          (instance) =>
            !instance.deploymentUnitId
        ).length,

      logicallyResolvedFamilyCount:
        runtimeFamilies.filter(
          (family) =>
            Boolean(
              family.logicalComponentId
            )
        ).length,

      logicallyUnresolvedFamilyCount:
        runtimeFamilies.filter(
          (family) =>
            !family.logicalComponentId
        ).length,
      
      aliasResolvedFamilyCount:
            runtimeFamilies.filter(
                (family) =>
                    family.logicalComponentResolution ===
                    'exact_registered_alias_match'
            ).length,

        canonicalPrefixResolvedFamilyCount:
            runtimeFamilies.filter(
                (family) =>
                    family.logicalComponentResolution ===
                        'canonical_prefix_match' ||
                    family.logicalComponentResolution ===
                        'longest_canonical_prefix_match'
            ).length,

      genericFamilySingletonCount:
        runtimeFamilies.filter(
          (family) =>
            family
              .genericFamilyIsSingleton ===
            true
        ).length,

      traversalChanged:
        false,

      graphChanged:
        false,
    },
  };

  if (outputDir) {
    fs.mkdirSync(
      outputDir,
      {
        recursive:
          true,
      }
    );

    fs.writeFileSync(
      path.join(
        outputDir,
        'runtime-families.json'
      ),

      JSON.stringify(
        payload,
        null,
        2
      ),

      'utf8'
    );
  }

  return payload;
}

module.exports = {
  BUILDER_VERSION,
  buildRuntimeFamilyDiscovery,
};
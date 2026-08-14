'use strict';

/**
 * visualEntityGroundingBuilder.js
 *
 * BUG-2D — Visual Entity Grounding
 *
 * Purpose:
 * Convert neutral diagram objects + visual containment into
 * deterministic, provenance-backed entity grounding evidence.
 *
 * Owns:
 * - diagram-object → visual relationship grounding
 * - boundary-label relationships
 * - direct / nested containment relationships
 * - exact canonical identity resolution
 * - exact unambiguous alias resolution
 * - optional runtime-family / runtime-instance resolution
 * - explicit ambiguous / unresolved states
 * - provenance and health reporting
 *
 * Does NOT:
 * - infer deployment units
 * - infer regions / sites / zones
 * - infer shared infrastructure
 * - infer component meaning
 * - fuzzy-match names
 * - strip arbitrary suffixes
 * - use product/domain dictionaries
 * - mutate architecture graph
 * - mutate traversal
 * - call an LLM
 *
 * Design principles:
 * - Visual role and canonical identity are orthogonal.
 * - A boundary label may still legitimately resolve to a component.
 * - Being inside a visual boundary does not imply deployment membership.
 * - Ambiguous identity fails closed.
 * - Unknown is a valid result.
 */

const fs = require('fs');
const path = require('path');

const {
  normalizeAlias,
} = require('./componentAliasRegistryBuilder');

const BUILDER_VERSION =
  'visual-entity-grounding-v1';

const HEALTH_VERSION =
  'visual-entity-grounding-health-v1';

/* ------------------------------------------------------- */
/* Generic helpers                                         */
/* ------------------------------------------------------- */

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

function uniq(values = []) {
  return [
    ...new Set(
      asArray(values)
        .filter(
          (value) =>
            value !== null &&
            value !== undefined &&
            safeString(value)
        )
    ),
  ];
}

function finiteNumber(value) {
  if (
    value === null ||
    value === undefined ||
    value === ''
  ) {
    return null;
  }

  const number =
    Number(value);

  return Number.isFinite(number)
    ? number
    : null;
}

function normalizeIdentity(value) {
  return normalizeAlias(
    safeString(value)
  );
}

/* ------------------------------------------------------- */
/* Boundary indexes                                       */
/* ------------------------------------------------------- */

function buildBoundaryIndex(
  visualBoundaryUnderstanding = {}
) {
  return new Map(
    asArray(
      visualBoundaryUnderstanding
        .boundaries
    )
      .filter(
        (boundary) =>
          boundary.boundaryId
      )
      .map(
        (boundary) => [
          boundary.boundaryId,
          boundary,
        ]
      )
  );
}

function buildSemanticBoundaryIndex(
  visualBoundarySemantics = {}
) {
  return new Map(
    asArray(
      visualBoundarySemantics
        .boundaries
    )
      .filter(
        (boundary) =>
          boundary.boundaryId
      )
      .map(
        (boundary) => [
          boundary.boundaryId,
          boundary,
        ]
      )
  );
}

function buildBoundaryLabelIndex(
  visualBoundaryUnderstanding = {}
) {
  const byObjectId =
    new Map();

  for (
    const boundary of
    asArray(
      visualBoundaryUnderstanding
        .boundaries
    )
  ) {
    const objectId =
      boundary.primaryLabelObjectId;

    if (!objectId) {
      continue;
    }

    if (
      !byObjectId.has(
        objectId
      )
    ) {
      byObjectId.set(
        objectId,
        []
      );
    }

    byObjectId
      .get(objectId)
      .push(
        boundary.boundaryId
      );
  }

  return byObjectId;
}

function buildDirectMembershipIndex(
  visualBoundaryUnderstanding = {}
) {
  const byObjectId =
    new Map();

  for (
    const boundary of
    asArray(
      visualBoundaryUnderstanding
        .boundaries
    )
  ) {
    for (
      const objectId of
      asArray(
        boundary
          .directContainedObjectIds
      )
    ) {
      if (
        !byObjectId.has(
          objectId
        )
      ) {
        byObjectId.set(
          objectId,
          []
        );
      }

      byObjectId
        .get(objectId)
        .push(
          boundary.boundaryId
        );
    }
  }

  return byObjectId;
}

function buildContainmentIndex(
  visualBoundaryUnderstanding = {}
) {
  const byObjectId =
    new Map();

  for (
    const boundary of
    asArray(
      visualBoundaryUnderstanding
        .boundaries
    )
  ) {
    for (
      const objectId of
      asArray(
        boundary
          .containedObjectIds
      )
    ) {
      if (
        !byObjectId.has(
          objectId
        )
      ) {
        byObjectId.set(
          objectId,
          []
        );
      }

      byObjectId
        .get(objectId)
        .push(
          boundary.boundaryId
        );
    }
  }

  return byObjectId;
}

/* ------------------------------------------------------- */
/* Canonical component indexes                            */
/* ------------------------------------------------------- */

function buildCanonicalComponentIndex(
  componentAliasRegistry = {}
) {
  const byNormalizedName =
    new Map();

  for (
    const component of
    asArray(
      componentAliasRegistry
        .components
    )
  ) {
    const normalized =
      normalizeIdentity(
        component.canonicalName
      );

    if (!normalized) {
      continue;
    }

    if (
      !byNormalizedName.has(
        normalized
      )
    ) {
      byNormalizedName.set(
        normalized,
        []
      );
    }

    byNormalizedName
      .get(normalized)
      .push({
        componentId:
          component.componentId ||
          null,

        canonicalName:
          component.canonicalName ||
          null,

        sourceEntityId:
          component.sourceEntityId ||
          null,

        canonicalIdentitySource:
          component
            .canonicalIdentitySource ||
          null,

        confidence:
          finiteNumber(
            component.confidence
          ),
      });
  }

  return byNormalizedName;
}

function buildResolvedAliasIndex(
  componentAliasRegistry = {}
) {
  const byNormalizedAlias =
    new Map();

  for (
    const alias of
    asArray(
      componentAliasRegistry
        .aliasLookup
    )
  ) {
    const normalized =
      normalizeIdentity(
        alias.normalizedAlias ||
        alias.alias
      );

    if (
      !normalized
    ) {
      continue;
    }

    if (
      !byNormalizedAlias.has(
        normalized
      )
    ) {
      byNormalizedAlias.set(
        normalized,
        []
      );
    }

    byNormalizedAlias
      .get(normalized)
      .push({
        componentId:
          alias.componentId ||
          null,

        canonicalName:
          alias.canonicalName ||
          null,

        alias:
          alias.alias ||
          null,

        sourceEntityId:
          alias.sourceEntityId ||
          null,
      });
  }

  return byNormalizedAlias;
}

function buildAmbiguousAliasIndex(
  componentAliasRegistry = {}
) {
  const byNormalizedAlias =
    new Map();

  for (
    const alias of
    asArray(
      componentAliasRegistry
        .ambiguousAliases
    )
  ) {
    const normalized =
      normalizeIdentity(
        alias.normalizedAlias ||
        alias.alias
      );

    if (
      !normalized
    ) {
      continue;
    }

    byNormalizedAlias.set(
      normalized,
      {
        normalizedAlias:
          normalized,

        componentIds:
          uniq(
            alias.componentIds
          ),

        canonicalNames:
          uniq(
            alias.canonicalNames
          ),

        status:
          alias.status ||
          'ambiguous',

        resolution:
          alias.resolution ||
          'unresolved',

        reason:
          alias.reason ||
          'ambiguous_alias',
      }
    );
  }

  return byNormalizedAlias;
}

/* ------------------------------------------------------- */
/* Runtime indexes                                        */
/* ------------------------------------------------------- */

function runtimeFamilyRecords(
  runtimeFamilies = {}
) {
  return asArray(
    runtimeFamilies.runtimeFamilies ||
    runtimeFamilies.families
  );
}

function runtimeInstanceRecords(
  runtimeFamilies = {}
) {
  const direct =
    asArray(
      runtimeFamilies.runtimeInstances
    );

  if (
    direct.length
  ) {
    return direct;
  }

  return runtimeFamilyRecords(
    runtimeFamilies
  ).flatMap(
    (family) =>
      asArray(
        family.runtimeInstances ||
        family.instances
      )
  );
}

function buildRuntimeInstanceIndex(
  runtimeFamilies = {}
) {
  const index =
    new Map();

  for (
    const instance of
    runtimeInstanceRecords(
      runtimeFamilies
    )
  ) {
    const name =
      safeString(
        instance.runtimeInstanceName ||
        instance.instanceName ||
        instance.name ||
        instance.label
      );

    const normalized =
      normalizeIdentity(name);

    if (
      !normalized
    ) {
      continue;
    }

    if (
      !index.has(
        normalized
      )
    ) {
      index.set(
        normalized,
        []
      );
    }

    index
      .get(normalized)
      .push({
        runtimeInstanceId:
          instance.runtimeInstanceId ||
          instance.instanceId ||
          instance.id ||
          null,

        runtimeInstanceName:
          name,

        runtimeFamilyId:
          instance.runtimeFamilyId ||
          instance.familyId ||
          null,

        runtimeFamilyName:
          instance.runtimeFamilyName ||
          instance.familyName ||
          null,

        logicalComponentId:
          instance.logicalComponentId ||
          instance.componentId ||
          null,

        logicalComponentName:
          instance.logicalComponentName ||
          instance.componentName ||
          null,
      });
  }

  return index;
}

function buildRuntimeFamilyIndex(
  runtimeFamilies = {}
) {
  const index =
    new Map();

  for (
    const family of
    runtimeFamilyRecords(
      runtimeFamilies
    )
  ) {
    const name =
      safeString(
        family.runtimeFamilyName ||
        family.familyName ||
        family.name ||
        family.label
      );

    const normalized =
      normalizeIdentity(name);

    if (
      !normalized
    ) {
      continue;
    }

    if (
      !index.has(
        normalized
      )
    ) {
      index.set(
        normalized,
        []
      );
    }

    index
      .get(normalized)
      .push({
        runtimeFamilyId:
          family.runtimeFamilyId ||
          family.familyId ||
          family.id ||
          null,

        runtimeFamilyName:
          name,

        logicalComponentId:
          family.logicalComponentId ||
          family.componentId ||
          null,

        logicalComponentName:
          family.logicalComponentName ||
          family.componentName ||
          null,

        resolved:
          family.resolved ??
          Boolean(
            family.logicalComponentId ||
            family.componentId
          ),
      });
  }

  return index;
}

/* ------------------------------------------------------- */
/* Exact identity resolution                              */
/* ------------------------------------------------------- */

function buildIdentityResolver({
  componentAliasRegistry = {},
  runtimeFamilies = {},
} = {}) {
  const ambiguousAliasIndex =
    buildAmbiguousAliasIndex(
      componentAliasRegistry
    );

  const canonicalComponentIndex =
    buildCanonicalComponentIndex(
      componentAliasRegistry
    );

  const resolvedAliasIndex =
    buildResolvedAliasIndex(
      componentAliasRegistry
    );

  const runtimeInstanceIndex =
    buildRuntimeInstanceIndex(
      runtimeFamilies
    );

  const runtimeFamilyIndex =
    buildRuntimeFamilyIndex(
      runtimeFamilies
    );

  function resolve(text = '') {
    const rawText =
      safeString(text);

    const normalizedText =
      normalizeIdentity(
        rawText
      );

    if (
      !normalizedText
    ) {
      return {
        status:
          'unresolved',

        identityType:
          'unknown',

        rawText,

        normalizedText,

        basis: [
          'empty_normalized_identity',
        ],

        candidates:
          [],
      };
    }

    /*
     * Ambiguity wins before canonical resolution.
     *
     * If an identity is explicitly known to have multiple
     * owners, do not silently select one merely because a
     * canonical component with the same text also exists.
     */

    const ambiguous =
      ambiguousAliasIndex.get(
        normalizedText
      );

    if (ambiguous) {
      return {
        status:
          'ambiguous',

        identityType:
          'component',

        rawText,

        normalizedText,

        basis: [
          'explicit_ambiguous_alias_registry_record',
        ],

        reason:
          ambiguous.reason,

        candidates:
          ambiguous.componentIds.map(
            (
              componentId,
              index
            ) => ({
              componentId,

              canonicalName:
                ambiguous
                  .canonicalNames
                  ?.[index] ||
                null,
            })
          ),
      };
    }

    const canonicalMatches =
      canonicalComponentIndex.get(
        normalizedText
      ) || [];

    if (
      canonicalMatches.length === 1
    ) {
      const match =
        canonicalMatches[0];

      return {
        status:
          'resolved',

        identityType:
          'component',

        rawText,

        normalizedText,

        componentId:
          match.componentId,

        canonicalName:
          match.canonicalName,

        sourceEntityId:
          match.sourceEntityId,

        confidence:
          match.confidence,

        basis: [
          'exact_canonical_component_name',
        ],

        candidates: [
          match,
        ],
      };
    }

    if (
      canonicalMatches.length > 1
    ) {
      return {
        status:
          'ambiguous',

        identityType:
          'component',

        rawText,

        normalizedText,

        basis: [
          'multiple_exact_canonical_component_names',
        ],

        candidates:
          canonicalMatches,
      };
    }

    const aliasMatches =
      resolvedAliasIndex.get(
        normalizedText
      ) || [];

    if (
      aliasMatches.length === 1
    ) {
      const match =
        aliasMatches[0];

      return {
        status:
          'resolved',

        identityType:
          'component',

        rawText,

        normalizedText,

        componentId:
          match.componentId,

        canonicalName:
          match.canonicalName,

        sourceEntityId:
          match.sourceEntityId,

        alias:
          match.alias,

        basis: [
          'exact_unambiguous_component_alias',
        ],

        candidates: [
          match,
        ],
      };
    }

    if (
      aliasMatches.length > 1
    ) {
      return {
        status:
          'ambiguous',

        identityType:
          'component',

        rawText,

        normalizedText,

        basis: [
          'multiple_exact_resolved_alias_records',
        ],

        candidates:
          aliasMatches,
      };
    }

    /*
     * Runtime resolution is optional.
     *
     * It is intentionally attempted only after component
     * identity resolution fails.
     */

    const runtimeInstances =
      runtimeInstanceIndex.get(
        normalizedText
      ) || [];

    if (
      runtimeInstances.length === 1
    ) {
      const match =
        runtimeInstances[0];

      return {
        status:
          'resolved',

        identityType:
          'runtime_instance',

        rawText,

        normalizedText,

        runtimeInstanceId:
          match.runtimeInstanceId,

        runtimeInstanceName:
          match.runtimeInstanceName,

        runtimeFamilyId:
          match.runtimeFamilyId,

        runtimeFamilyName:
          match.runtimeFamilyName,

        logicalComponentId:
          match.logicalComponentId,

        logicalComponentName:
          match.logicalComponentName,

        basis: [
          'exact_runtime_instance_identity',
        ],

        candidates: [
          match,
        ],
      };
    }

    if (
      runtimeInstances.length > 1
    ) {
      return {
        status:
          'ambiguous',

        identityType:
          'runtime_instance',

        rawText,

        normalizedText,

        basis: [
          'multiple_exact_runtime_instance_records',
        ],

        candidates:
          runtimeInstances,
      };
    }

    const runtimeFamiliesFound =
      runtimeFamilyIndex.get(
        normalizedText
      ) || [];

    if (
      runtimeFamiliesFound.length === 1
    ) {
      const match =
        runtimeFamiliesFound[0];

      return {
        status:
          'resolved',

        identityType:
          'runtime_family',

        rawText,

        normalizedText,

        runtimeFamilyId:
          match.runtimeFamilyId,

        runtimeFamilyName:
          match.runtimeFamilyName,

        logicalComponentId:
          match.logicalComponentId,

        logicalComponentName:
          match.logicalComponentName,

        basis: [
          'exact_runtime_family_identity',
        ],

        candidates: [
          match,
        ],
      };
    }

    if (
      runtimeFamiliesFound.length > 1
    ) {
      return {
        status:
          'ambiguous',

        identityType:
          'runtime_family',

        rawText,

        normalizedText,

        basis: [
          'multiple_exact_runtime_family_records',
        ],

        candidates:
          runtimeFamiliesFound,
      };
    }

    return {
      status:
        'unresolved',

      identityType:
        'unknown',

      rawText,

      normalizedText,

      basis: [
        'no_exact_identity_evidence',
      ],

      candidates:
        [],
    };
  }

  return {
    resolve,

    stats: {
      canonicalIdentityKeyCount:
        canonicalComponentIndex.size,

      resolvedAliasKeyCount:
        resolvedAliasIndex.size,

      ambiguousAliasKeyCount:
        ambiguousAliasIndex.size,

      runtimeInstanceIdentityKeyCount:
        runtimeInstanceIndex.size,

      runtimeFamilyIdentityKeyCount:
        runtimeFamilyIndex.size,
    },
  };
}

/* ------------------------------------------------------- */
/* Visual relationship grounding                          */
/* ------------------------------------------------------- */

function buildVisualRelationships({
  object = {},
  boundaryLabelIndex = new Map(),
  directMembershipIndex = new Map(),
  containmentIndex = new Map(),
  boundaryIndex = new Map(),
} = {}) {
  const objectId =
    object.id;

  const labeledBoundaryIds =
    uniq(
      boundaryLabelIndex.get(
        objectId
      ) || []
    );

  const directMemberBoundaryIds =
    uniq(
      directMembershipIndex.get(
        objectId
      ) || []
    );

  const allContainedBoundaryIds =
    uniq(
      containmentIndex.get(
        objectId
      ) || []
    );

  /*
   * A boundary label is not treated as a contained member
   * of the boundary that it labels.
   *
   * This prevents:
   *   "Origin Zone belongs to Origin Zone"
   *
   * while still allowing the same object to be inside an
   * ancestor container.
   */

  const effectiveDirectMemberBoundaryIds =
    directMemberBoundaryIds.filter(
      (boundaryId) =>
        !labeledBoundaryIds.includes(
          boundaryId
        )
    );

  const effectiveContainedBoundaryIds =
    allContainedBoundaryIds.filter(
      (boundaryId) =>
        !labeledBoundaryIds.includes(
          boundaryId
        )
    );

  const ancestorBoundaryIds =
    uniq(
      labeledBoundaryIds.flatMap(
        (boundaryId) =>
          asArray(
            boundaryIndex.get(
              boundaryId
            )
              ?.ancestorBoundaryIds
          )
      )
    );

  const nestedMemberBoundaryIds =
    effectiveContainedBoundaryIds.filter(
      (boundaryId) =>
        !effectiveDirectMemberBoundaryIds.includes(
          boundaryId
        )
    );

  const visualRoles = [];

  if (
    labeledBoundaryIds.length
  ) {
    visualRoles.push(
      'boundary_label'
    );
  }

  if (
    effectiveDirectMemberBoundaryIds.length
  ) {
    visualRoles.push(
      'direct_member'
    );
  }

  if (
    nestedMemberBoundaryIds.length ||
    ancestorBoundaryIds.length
  ) {
    visualRoles.push(
      'nested_member'
    );
  }

  if (
    !visualRoles.length
  ) {
    visualRoles.push(
      'uncontained'
    );
  }

  return {
    visualRoles,

    labeledBoundaryIds,

    directMemberBoundaryIds:
      effectiveDirectMemberBoundaryIds,

    nestedMemberBoundaryIds,

    containedBoundaryIds:
      effectiveContainedBoundaryIds,

    ancestorBoundaryIds,
  };
}

/* ------------------------------------------------------- */
/* Boundary provenance                                    */
/* ------------------------------------------------------- */

function buildBoundaryContext({
  boundaryIds = [],
  boundaryIndex = new Map(),
  semanticBoundaryIndex = new Map(),
} = {}) {
  return uniq(
    boundaryIds
  )
    .map(
      (boundaryId) => {
        const visual =
          boundaryIndex.get(
            boundaryId
          );

        const semantic =
          semanticBoundaryIndex.get(
            boundaryId
          );

        if (
          !visual &&
          !semantic
        ) {
          return null;
        }

        return {
          boundaryId,

          label:
            semantic?.rawText ||
            visual?.primaryLabelText ||
            null,

          visualRole:
            visual?.visualRole ||
            null,

          visualConfidence:
            visual?.confidence ||
            null,

          visualAmbiguous:
            Boolean(
              visual?.ambiguous
            ),

          boundaryType:
            semantic?.boundaryType ||
            'unknown',

          boundarySubtype:
            semantic?.boundarySubtype ||
            'unknown',

          semanticConfidence:
            semantic?.confidence ||
            null,

          semanticAmbiguous:
            Boolean(
              semantic?.ambiguous
            ),

          parentBoundaryId:
            visual?.parentBoundaryId ||
            semantic?.parentBoundaryId ||
            null,

          depth:
            finiteNumber(
              visual?.depth ??
              semantic?.depth
            ),
        };
      }
    )
    .filter(Boolean);
}

/* ------------------------------------------------------- */
/* Ground one diagram object                              */
/* ------------------------------------------------------- */

function groundDiagramObject({
  object = {},
  identityResolver,
  boundaryLabelIndex,
  directMembershipIndex,
  containmentIndex,
  boundaryIndex,
  semanticBoundaryIndex,
} = {}) {
  const visualRelationships =
    buildVisualRelationships({
      object,
      boundaryLabelIndex,
      directMembershipIndex,
      containmentIndex,
      boundaryIndex,
    });

  const identityResolution =
    identityResolver.resolve(
      object.text
    );

  const relatedBoundaryIds =
    uniq([
      ...visualRelationships
        .labeledBoundaryIds,

      ...visualRelationships
        .directMemberBoundaryIds,

      ...visualRelationships
        .nestedMemberBoundaryIds,

      ...visualRelationships
        .ancestorBoundaryIds,
    ]);

  const boundaryContext =
    buildBoundaryContext({
      boundaryIds:
        relatedBoundaryIds,

      boundaryIndex,

      semanticBoundaryIndex,
    });

  return {
    objectId:
      object.id ||
      null,

    page:
      object.page ??
      null,

    text:
      safeString(
        object.text
      ),

    normalizedText:
      normalizeIdentity(
        object.text
      ),

    bounds:
      object.bounds ||
      null,

    source:
      object.source ||
      null,

    sourceLabelId:
      object.sourceLabelId ||
      null,

    sourceConfidence:
      finiteNumber(
        object.confidence
      ),

    visualRelationships,

    boundaryContext,

    identityResolution,

    provenance: {
      diagramObjectId:
        object.id ||
        null,

      diagramObjectSource:
        object.source ||
        null,

      diagramObjectConfidence:
        finiteNumber(
          object.confidence
        ),

      visualBoundaryIds:
        relatedBoundaryIds,

      identityBasis:
        asArray(
          identityResolution.basis
        ),
    },
  };
}

/* ------------------------------------------------------- */
/* Health                                                  */
/* ------------------------------------------------------- */

function buildVisualEntityGroundingHealth({
  entities = [],
  diagramObjectRegistry = {},
} = {}) {
  const violations = [];

  const sourceObjectCount =
    asArray(
      diagramObjectRegistry
        .objects
    ).length;

  const groundedObjectCount =
    entities.length;

  const sourceGroundingMismatchCount =
    Math.abs(
      sourceObjectCount -
      groundedObjectCount
    );

  if (
    sourceGroundingMismatchCount >
    0
  ) {
    violations.push({
      reason:
        'diagram_object_grounding_count_mismatch',

      sourceObjectCount,

      groundedObjectCount,
    });
  }

  const missingObjectIdCount =
    entities.filter(
      (entity) =>
        !entity.objectId
    ).length;

  if (
    missingObjectIdCount >
    0
  ) {
    violations.push({
      reason:
        'missing_grounded_object_id',

      count:
        missingObjectIdCount,
    });
  }

  const duplicateObjectIdCount =
    entities.length -
    new Set(
      entities
        .map(
          (entity) =>
            entity.objectId
        )
        .filter(Boolean)
    ).size;

  if (
    duplicateObjectIdCount >
    0
  ) {
    violations.push({
      reason:
        'duplicate_grounded_object_id',

      count:
        duplicateObjectIdCount,
    });
  }

  const invalidResolutionStatusCount =
    entities.filter(
      (entity) =>
        ![
          'resolved',
          'ambiguous',
          'unresolved',
        ].includes(
          entity
            ?.identityResolution
            ?.status
        )
    ).length;

  if (
    invalidResolutionStatusCount >
    0
  ) {
    violations.push({
      reason:
        'invalid_identity_resolution_status',

      count:
        invalidResolutionStatusCount,
    });
  }

  const guessedResolutionCount =
    entities.filter(
      (entity) =>
        asArray(
          entity
            ?.identityResolution
            ?.basis
        ).some(
          (basis) =>
            /fuzzy|substring|guess|heuristic/i
              .test(
                safeString(
                  basis
                )
              )
        )
    ).length;

  if (
    guessedResolutionCount >
    0
  ) {
    violations.push({
      reason:
        'unsafe_guessed_identity_resolution',

      count:
        guessedResolutionCount,
    });
  }

  return {
    version:
      HEALTH_VERSION,

    valid:
      violations.length ===
      0,

    violationCount:
      violations.length,

    sourceObjectCount,

    groundedObjectCount,

    sourceGroundingMismatchCount,

    missingObjectIdCount,

    duplicateObjectIdCount,

    invalidResolutionStatusCount,

    guessedResolutionCount,

    violations,
  };
}

/* ------------------------------------------------------- */
/* Builder                                                 */
/* ------------------------------------------------------- */

function buildVisualEntityGrounding({
  diagramObjectRegistry = {},
  visualBoundaryUnderstanding = {},
  visualBoundarySemantics = {},
  componentAliasRegistry = {},
  runtimeFamilies = {},
} = {}) {
  const objects =
    asArray(
      diagramObjectRegistry
        .objects
    );

  const boundaryIndex =
    buildBoundaryIndex(
      visualBoundaryUnderstanding
    );

  const semanticBoundaryIndex =
    buildSemanticBoundaryIndex(
      visualBoundarySemantics
    );

  const boundaryLabelIndex =
    buildBoundaryLabelIndex(
      visualBoundaryUnderstanding
    );

  const directMembershipIndex =
    buildDirectMembershipIndex(
      visualBoundaryUnderstanding
    );

  const containmentIndex =
    buildContainmentIndex(
      visualBoundaryUnderstanding
    );

  const identityResolver =
    buildIdentityResolver({
      componentAliasRegistry,
      runtimeFamilies,
    });

  const entities =
    objects.map(
      (object) =>
        groundDiagramObject({
          object,

          identityResolver,

          boundaryLabelIndex,

          directMembershipIndex,

          containmentIndex,

          boundaryIndex,

          semanticBoundaryIndex,
        })
    );

  const resolvedEntities =
    entities.filter(
      (entity) =>
        entity
          .identityResolution
          .status ===
        'resolved'
    );

  const ambiguousEntities =
    entities.filter(
      (entity) =>
        entity
          .identityResolution
          .status ===
        'ambiguous'
    );

  const unresolvedEntities =
    entities.filter(
      (entity) =>
        entity
          .identityResolution
          .status ===
        'unresolved'
    );

  const boundaryLabelEntities =
    entities.filter(
      (entity) =>
        entity
          .visualRelationships
          .visualRoles
          .includes(
            'boundary_label'
          )
    );

  const directMemberEntities =
    entities.filter(
      (entity) =>
        entity
          .visualRelationships
          .visualRoles
          .includes(
            'direct_member'
          )
    );

  const nestedMemberEntities =
    entities.filter(
      (entity) =>
        entity
          .visualRelationships
          .visualRoles
          .includes(
            'nested_member'
          )
    );

  const componentResolvedEntities =
    resolvedEntities.filter(
      (entity) =>
        entity
          .identityResolution
          .identityType ===
        'component'
    );

  const runtimeInstanceResolvedEntities =
    resolvedEntities.filter(
      (entity) =>
        entity
          .identityResolution
          .identityType ===
        'runtime_instance'
    );

  const runtimeFamilyResolvedEntities =
    resolvedEntities.filter(
      (entity) =>
        entity
          .identityResolution
          .identityType ===
        'runtime_family'
    );

  const health =
    buildVisualEntityGroundingHealth({
      entities,
      diagramObjectRegistry,
    });

  return {
    version:
      BUILDER_VERSION,

    source:
      'visualEntityGroundingBuilder',

    identityPolicy: {
      normalization:
        'componentAliasRegistryBuilder.normalizeAlias',

      resolutionOrder: [
        'explicit_ambiguous_alias_guard',
        'exact_canonical_component_name',
        'exact_unambiguous_component_alias',
        'exact_runtime_instance_identity',
        'exact_runtime_family_identity',
        'unresolved',
      ],

      fuzzyMatching:
        false,

      substringMatching:
        false,

      llmResolution:
        false,

      failClosedOnAmbiguity:
        true,
    },

    stats: {
      diagramObjectCount:
        objects.length,

      groundedEntityCount:
        entities.length,

      resolvedEntityCount:
        resolvedEntities.length,

      ambiguousEntityCount:
        ambiguousEntities.length,

      unresolvedEntityCount:
        unresolvedEntities.length,

      resolvedComponentCount:
        componentResolvedEntities.length,

      resolvedRuntimeInstanceCount:
        runtimeInstanceResolvedEntities.length,

      resolvedRuntimeFamilyCount:
        runtimeFamilyResolvedEntities.length,

      boundaryLabelEntityCount:
        boundaryLabelEntities.length,

      directMemberEntityCount:
        directMemberEntities.length,

      nestedMemberEntityCount:
        nestedMemberEntities.length,

      visualBoundaryCount:
        boundaryIndex.size,

      semanticBoundaryCount:
        semanticBoundaryIndex.size,

      canonicalIdentityKeyCount:
        identityResolver
          .stats
          .canonicalIdentityKeyCount,

      resolvedAliasKeyCount:
        identityResolver
          .stats
          .resolvedAliasKeyCount,

      ambiguousAliasKeyCount:
        identityResolver
          .stats
          .ambiguousAliasKeyCount,

      runtimeInstanceIdentityKeyCount:
        identityResolver
          .stats
          .runtimeInstanceIdentityKeyCount,

      runtimeFamilyIdentityKeyCount:
        identityResolver
          .stats
          .runtimeFamilyIdentityKeyCount,

      graphChanged:
        false,

      traversalChanged:
        false,
    },

    entities,

    health,

    graphChanged:
      false,

    traversalChanged:
      false,

    notes: [
      'Visual relationships and canonical identity are intentionally modeled as independent facts.',
      'Boundary-label objects are excluded from membership in the same boundary that they label, but may still resolve to legitimate canonical identities.',
      'Containment does not imply deployment membership.',
      'Explicit alias ambiguity is checked before canonical-name resolution.',
      'Only exact identity evidence is accepted in V1.',
      'Runtime identity resolution is optional and does not block visual grounding when runtime artifacts are absent.',
      'Unknown and ambiguous identities remain unresolved rather than being guessed.',
    ],
  };
}

/* ------------------------------------------------------- */
/* Persistence                                             */
/* ------------------------------------------------------- */

function saveVisualEntityGrounding(
  jobDir,
  grounding
) {
  const outputPath =
    path.join(
      jobDir,
      'visual-entity-grounding.json'
    );

  fs.writeFileSync(
    outputPath,
    JSON.stringify(
      grounding,
      null,
      2
    ),
    'utf8'
  );

  return outputPath;
}

module.exports = {
  BUILDER_VERSION,

  buildBoundaryIndex,
  buildSemanticBoundaryIndex,
  buildBoundaryLabelIndex,
  buildDirectMembershipIndex,
  buildContainmentIndex,

  buildCanonicalComponentIndex,
  buildResolvedAliasIndex,
  buildAmbiguousAliasIndex,

  buildRuntimeInstanceIndex,
  buildRuntimeFamilyIndex,

  buildIdentityResolver,
  buildVisualRelationships,
  buildBoundaryContext,
  groundDiagramObject,

  buildVisualEntityGroundingHealth,
  buildVisualEntityGrounding,
  saveVisualEntityGrounding,
};
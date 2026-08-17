'use strict';

/**
 * visualDeploymentEvidenceBuilder.js
 *
 * BUG-2E — Visual → Deployment Evidence Bridge
 *
 * Purpose:
 * Convert neutral visual entity grounding + visual boundary semantics
 * into deployment evidence candidates without mutating deployment truth.
 *
 * Owns:
 * - boundary deployment qualification
 * - direct/nested visual membership observations
 * - deployment usability gating
 * - provenance
 * - conflict-set detection
 * - health/stats
 *
 * Does NOT:
 * - create deployment units
 * - mutate deployment normalization
 * - infer new identities
 * - rerun alias resolution
 * - rerun geometry
 * - rerun boundary semantics
 * - fuzzy match
 * - use LLMs
 *
 * Core rule:
 *
 *   visual containment
 *       !=
 *   deployment membership
 *
 * Deployment usability requires BOTH:
 * - resolved canonical identity
 * - deployment-qualified boundary
 */

const fs = require('fs');
const path = require('path');

const BUILDER_VERSION =
  'visual-deployment-evidence-v1';

const HEALTH_VERSION =
  'visual-deployment-evidence-health-v1';

const QUALIFICATION_STATUS = {
  QUALIFIED: 'qualified',
  REJECTED: 'rejected',
  UNRESOLVED: 'unresolved',
};

const USABILITY_STATUS = {
  ELIGIBLE: 'eligible',
  BLOCKED: 'blocked',
};

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

/* ------------------------------------------------------- */
/* Boundary indexes                                       */
/* ------------------------------------------------------- */

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

function buildGroundedEntityIndex(
  visualEntityGrounding = {}
) {
  return new Map(
    asArray(
      visualEntityGrounding
        .entities
    )
      .filter(
        (entity) =>
          entity.objectId
      )
      .map(
        (entity) => [
          entity.objectId,
          entity,
        ]
      )
  );
}

/* ------------------------------------------------------- */
/* BUG-2E.1 Boundary qualification                        */
/* ------------------------------------------------------- */

function qualifyBoundary(
  semanticBoundary = {}
) {
  const boundaryType =
    safeString(
      semanticBoundary.boundaryType
    ) ||
    'unknown';

  const boundarySubtype =
    safeString(
      semanticBoundary.boundarySubtype
    ) ||
    'unknown';

  const semanticAmbiguous =
    Boolean(
      semanticBoundary.ambiguous
    );

  const semanticConfidence =
    safeString(
      semanticBoundary.confidence
    ) ||
    'low';

  /*
   * Policy-engine style:
   * explicit allow / explicit reject / unresolved.
   *
   * Default is unresolved, not qualified.
   */

  if (
    semanticAmbiguous
  ) {
    return {
      boundaryId:
        semanticBoundary.boundaryId ||
        null,

      status:
        QUALIFICATION_STATUS.UNRESOLVED,

      qualified:
        false,

      confidence:
        semanticConfidence,

      boundaryType,

      boundarySubtype,

      basis: [
        'semantic_boundary_ambiguous',
      ],

      blockReasons: [
        'boundary_not_deployment_qualified',
      ],
    };
  }

  if (
    boundaryType ===
      'deployment_boundary'
  ) {
    return {
      boundaryId:
        semanticBoundary.boundaryId ||
        null,

      boundaryLabel:
        safeString(
          semanticBoundary.rawText
        ),

      status:
        QUALIFICATION_STATUS.QUALIFIED,

      qualified:
        true,

      confidence:
        semanticConfidence,

      boundaryType,

      boundarySubtype,

      basis: [
        'explicit_deployment_boundary_semantics',
      ],

      blockReasons:
        [],
    };
  }

  /*
   * Logical grouping is explicitly not deployment truth.
   */

  if (
    boundaryType ===
      'logical_group'
  ) {
    return {
      boundaryId:
        semanticBoundary.boundaryId ||
        null,

      status:
        QUALIFICATION_STATUS.REJECTED,

      qualified:
        false,

      confidence:
        semanticConfidence,

      boundaryType,

      boundarySubtype,

      basis: [
        'logical_group_not_deployment_boundary',
      ],

      blockReasons: [
        'logical_group_not_deployment_scope',
      ],
    };
  }

  /*
   * Region-group evidence may become useful later in BUG-2F,
   * but 2E does not automatically promote it.
   */

  if (
    boundaryType ===
      'region_group'
  ) {
    return {
      boundaryId:
        semanticBoundary.boundaryId ||
        null,

      status:
        QUALIFICATION_STATUS.UNRESOLVED,

      qualified:
        false,

      confidence:
        semanticConfidence,

      boundaryType,

      boundarySubtype,

      basis: [
        'region_group_requires_deployment_confirmation',
      ],

      blockReasons: [
        'region_group_not_explicitly_deployment_qualified',
      ],
    };
  }

  return {
    boundaryId:
      semanticBoundary.boundaryId ||
      null,

    status:
      QUALIFICATION_STATUS.UNRESOLVED,

    qualified:
      false,

    confidence:
      semanticConfidence,

    boundaryType,

    boundarySubtype,

    basis: [
      'semantic_boundary_type_unknown',
    ],

    blockReasons: [
      'boundary_not_deployment_qualified',
    ],
  };
}

function buildBoundaryQualifications(
  visualBoundarySemantics = {}
) {
  return asArray(
    visualBoundarySemantics
      .boundaries
  ).map(
    (boundary) =>
      qualifyBoundary(
        boundary
      )
  );
}

function buildQualificationIndex(
  boundaryQualifications = []
) {
  return new Map(
    asArray(
      boundaryQualifications
    )
      .filter(
        (qualification) =>
          qualification.boundaryId
      )
      .map(
        (qualification) => [
          qualification.boundaryId,
          qualification,
        ]
      )
  );
}

/* ------------------------------------------------------- */
/* BUG-2E.2/3 Membership observations                     */
/* ------------------------------------------------------- */

function buildMembershipObservation({
  entity = {},
  boundaryId,
  membershipKind,
  qualificationIndex,
} = {}) {
  const identity =
    entity.identityResolution ||
    {};

  const qualification =
    qualificationIndex.get(
      boundaryId
    ) ||
    {
      boundaryId,
      status:
        QUALIFICATION_STATUS.UNRESOLVED,
      qualified:
        false,
      confidence:
        'low',
      basis: [
        'missing_boundary_qualification',
      ],
      blockReasons: [
        'boundary_not_deployment_qualified',
      ],
    };

  const identityResolved =
    identity.status ===
    'resolved';

  const canonicalEntityType =
    identityResolved
      ? safeString(
          identity.identityType
        ) || 'unknown'
      : 'unknown';

  const canonicalEntityId =
    identityResolved
      ? (
          identity.componentId ||
          identity.runtimeInstanceId ||
          identity.runtimeFamilyId ||
          null
        )
      : null;

  const canonicalEntityName =
    identityResolved
      ? (
          identity.canonicalName ||
          identity.runtimeInstanceName ||
          identity.runtimeFamilyName ||
          null
        )
      : null;

  const blockReasons = [];

  if (
    !identityResolved
  ) {
    blockReasons.push(
      identity.status ===
        'ambiguous'
        ? 'identity_ambiguous'
        : 'identity_unresolved'
    );
  }

  if (
    !qualification.qualified
  ) {
    blockReasons.push(
      ...asArray(
        qualification.blockReasons
      )
    );
  }

  /*
   * Boundary labels are allowed to have identities,
   * but are never deployment members of the boundary
   * they label.
   *
   * 2D already strips those self-membership relationships,
   * so this remains a defensive invariant.
   */

  const labelsThisBoundary =
    asArray(
      entity
        .visualRelationships
        ?.labeledBoundaryIds
    ).includes(
      boundaryId
    );

  if (
    labelsThisBoundary
  ) {
    blockReasons.push(
      'object_labels_target_boundary'
    );
  }

  const deploymentUsable =
    identityResolved &&
    qualification.qualified &&
    !labelsThisBoundary;

  const visualBasis =
    membershipKind ===
      'direct'
      ? [
          'visual_direct_containment',
        ]
      : [
          'visual_nested_containment',
        ];

  return {
    observationId:
      [
        'visual_deployment_membership',
        boundaryId,
        entity.objectId,
        membershipKind,
      ]
        .filter(Boolean)
        .join('::'),

    visualBoundaryId:
      boundaryId,

    diagramObjectId:
      entity.objectId ||
      null,

    page:
      entity.page ??
      null,

    rawText:
      safeString(
        entity.text
      ),

    membershipKind,

    observationStatus:
      'observed',

    identityStatus:
      identity.status ||
      'unresolved',

    canonicalEntityType,

    canonicalEntityId,

    canonicalEntityName,

    componentId:
      canonicalEntityType ===
        'component'
        ? identity.componentId ||
          null
        : null,

    componentName:
      canonicalEntityType ===
        'component'
        ? identity.canonicalName ||
          null
        : null,

    runtimeInstanceId:
      canonicalEntityType ===
        'runtime_instance'
        ? identity.runtimeInstanceId ||
          null
        : null,

    runtimeInstanceName:
      canonicalEntityType ===
        'runtime_instance'
        ? identity.runtimeInstanceName ||
          null
        : null,

    runtimeFamilyId:
      canonicalEntityType ===
        'runtime_family'
        ? identity.runtimeFamilyId ||
          null
        : null,

    runtimeFamilyName:
      canonicalEntityType ===
        'runtime_family'
        ? identity.runtimeFamilyName ||
          null
        : null,

    deploymentQualificationStatus:
      qualification.status,

    deploymentBoundaryQualified:
      qualification.qualified,

    deploymentUsability:
      deploymentUsable
        ? USABILITY_STATUS.ELIGIBLE
        : USABILITY_STATUS.BLOCKED,

    deploymentUsable,

    blockReasons:
      uniq(
        blockReasons
      ),

    identityBasis:
      asArray(
        identity.basis
      ),

    visualBasis,

    qualificationBasis:
      asArray(
        qualification.basis
      ),

    confidence: {
      visual:
        finiteNumber(
          entity.sourceConfidence
        ),

      identity:
        finiteNumber(
          identity.confidence
        ),

      boundary:
        qualification.confidence ||
        'low',
    },

    provenance: {
      visualEntityGroundingObjectId:
        entity.objectId ||
        null,

      visualBoundaryId:
        boundaryId,

      identityResolutionBasis:
        asArray(
          identity.basis
        ),

      containmentBasis:
        visualBasis,

      qualificationBasis:
        asArray(
          qualification.basis
        ),
    },
  };
}

function buildMembershipObservations({
  visualEntityGrounding = {},
  qualificationIndex = new Map(),
} = {}) {
  const observations = [];

  for (
    const entity of
    asArray(
      visualEntityGrounding.entities
    )
  ) {
    const relationships =
      entity.visualRelationships ||
      {};

    for (
      const boundaryId of
      asArray(
        relationships
          .directMemberBoundaryIds
      )
    ) {
      observations.push(
        buildMembershipObservation({
          entity,
          boundaryId,
          membershipKind:
            'direct',
          qualificationIndex,
        })
      );
    }

    for (
      const boundaryId of
      asArray(
        relationships
          .nestedMemberBoundaryIds
      )
    ) {
      observations.push(
        buildMembershipObservation({
          entity,
          boundaryId,
          membershipKind:
            'nested',
          qualificationIndex,
        })
      );
    }
  }

  return observations;
}

/* ------------------------------------------------------- */
/* BUG-2E.5 Deployment usability                          */
/* ------------------------------------------------------- */

function buildDeploymentEligibleMemberships(
  membershipObservations = []
) {
  return asArray(
    membershipObservations
  ).filter(
    (observation) =>
      observation.deploymentUsable ===
      true
  );
}

/* ------------------------------------------------------- */
/* BUG-2E.7 Conflict sets                                 */
/* ------------------------------------------------------- */

function buildMembershipConflictSets(
  deploymentEligibleMemberships = []
) {
  const byEntity =
    new Map();

  for (
    const observation of
    asArray(
      deploymentEligibleMemberships
    )
  ) {
    const entityType =
      observation.canonicalEntityType;

    const entityId =
      observation.canonicalEntityId;

    if (
      !entityType ||
      !entityId
    ) {
      continue;
    }

    const key =
      `${entityType}:${entityId}`;

    if (
      !byEntity.has(
        key
      )
    ) {
      byEntity.set(
        key,
        []
      );
    }

    byEntity
      .get(key)
      .push(
        observation
      );
  }

  const conflicts = [];

  for (
    const [
      entityKey,
      observations,
    ] of
    byEntity.entries()
  ) {
    const boundaryIds =
      uniq(
        observations.map(
          (observation) =>
            observation
              .visualBoundaryId
        )
      );

    if (
      boundaryIds.length <= 1
    ) {
      continue;
    }

    /*
     * BUG-2E does not adjudicate whether multiple deployment
     * boundaries are compatible replication vs conflict.
     *
     * It merely exposes the competing eligible memberships
     * for BUG-2F.
     */

    conflicts.push({
      conflictId:
        `visual_deployment_conflict::${entityKey}`,

      entityKey,

      canonicalEntityType:
        observations[0]
          .canonicalEntityType,

      canonicalEntityId:
        observations[0]
          .canonicalEntityId,

      canonicalEntityName:
        observations[0]
          .canonicalEntityName,

      boundaryIds,

      observationIds:
        observations.map(
          (observation) =>
            observation
              .observationId
        ),

      status:
        'unresolved',

      basis: [
        'same_entity_has_multiple_deployment_qualified_visual_memberships',
      ],

      resolution:
        'deferred_to_bug_2f',
    });
  }

  return conflicts;
}

/* ------------------------------------------------------- */
/* BUG-2E.8 Health                                        */
/* ------------------------------------------------------- */

function buildVisualDeploymentEvidenceHealth({
  boundaryQualifications = [],
  membershipObservations = [],
  deploymentEligibleMemberships = [],
  conflicts = [],
} = {}) {
  const violations = [];

  const invalidQualificationStatusCount =
    boundaryQualifications.filter(
      (qualification) =>
        !Object.values(
          QUALIFICATION_STATUS
        ).includes(
          qualification.status
        )
    ).length;

  if (
    invalidQualificationStatusCount >
    0
  ) {
    violations.push({
      reason:
        'invalid_boundary_qualification_status',

      count:
        invalidQualificationStatusCount,
    });
  }

  const invalidUsabilityStatusCount =
    membershipObservations.filter(
      (observation) =>
        !Object.values(
          USABILITY_STATUS
        ).includes(
          observation.deploymentUsability
        )
    ).length;

  if (
    invalidUsabilityStatusCount >
    0
  ) {
    violations.push({
      reason:
        'invalid_deployment_usability_status',

      count:
        invalidUsabilityStatusCount,
    });
  }

  const eligibleWithoutResolvedIdentityCount =
    deploymentEligibleMemberships.filter(
      (observation) =>
        observation.identityStatus !==
        'resolved'
    ).length;

  if (
    eligibleWithoutResolvedIdentityCount >
    0
  ) {
    violations.push({
      reason:
        'deployment_eligible_membership_without_resolved_identity',

      count:
        eligibleWithoutResolvedIdentityCount,
    });
  }

  const eligibleWithoutQualifiedBoundaryCount =
    deploymentEligibleMemberships.filter(
      (observation) =>
        observation
          .deploymentBoundaryQualified !==
        true
    ).length;

  if (
    eligibleWithoutQualifiedBoundaryCount >
    0
  ) {
    violations.push({
      reason:
        'deployment_eligible_membership_without_qualified_boundary',

      count:
        eligibleWithoutQualifiedBoundaryCount,
    });
  }

  const eligibleBoundaryLabelSelfMembershipCount =
    deploymentEligibleMemberships.filter(
      (observation) =>
        asArray(
          observation.blockReasons
        ).includes(
          'object_labels_target_boundary'
        )
    ).length;

  if (
    eligibleBoundaryLabelSelfMembershipCount >
    0
  ) {
    violations.push({
      reason:
        'deployment_eligible_boundary_label_self_membership',

      count:
        eligibleBoundaryLabelSelfMembershipCount,
    });
  }

  const duplicateObservationIdCount =
    membershipObservations.length -
    new Set(
      membershipObservations
        .map(
          (observation) =>
            observation.observationId
        )
        .filter(Boolean)
    ).size;

  if (
    duplicateObservationIdCount >
    0
  ) {
    violations.push({
      reason:
        'duplicate_membership_observation_ids',

      count:
        duplicateObservationIdCount,
    });
  }

  const unsafeInferenceCount =
    membershipObservations.filter(
      (observation) =>
        [
          ...asArray(
            observation.identityBasis
          ),
          ...asArray(
            observation.visualBasis
          ),
          ...asArray(
            observation.qualificationBasis
          ),
        ].some(
          (basis) =>
            /fuzzy|substring|guess|llm/i
              .test(
                safeString(
                  basis
                )
              )
        )
    ).length;

  if (
    unsafeInferenceCount >
    0
  ) {
    violations.push({
      reason:
        'unsafe_visual_deployment_inference',

      count:
        unsafeInferenceCount,
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

    invalidQualificationStatusCount,

    invalidUsabilityStatusCount,

    eligibleWithoutResolvedIdentityCount,

    eligibleWithoutQualifiedBoundaryCount,

    eligibleBoundaryLabelSelfMembershipCount,

    duplicateObservationIdCount,

    unsafeInferenceCount,

    conflictCount:
      conflicts.length,

    violations,
  };
}

/* ------------------------------------------------------- */
/* Builder                                                 */
/* ------------------------------------------------------- */

function buildVisualDeploymentEvidence({
  visualBoundarySemantics = {},
  visualEntityGrounding = {},
} = {}) {
  const boundaryQualifications =
    buildBoundaryQualifications(
      visualBoundarySemantics
    );

  const qualificationIndex =
    buildQualificationIndex(
      boundaryQualifications
    );

  const membershipObservations =
    buildMembershipObservations({
      visualEntityGrounding,
      qualificationIndex,
    });

  const deploymentEligibleMemberships =
    buildDeploymentEligibleMemberships(
      membershipObservations
    );

  const conflicts =
    buildMembershipConflictSets(
      deploymentEligibleMemberships
    );

  const health =
    buildVisualDeploymentEvidenceHealth({
      boundaryQualifications,
      membershipObservations,
      deploymentEligibleMemberships,
      conflicts,
    });

  return {
    version:
      BUILDER_VERSION,

    source:
      'visualDeploymentEvidenceBuilder',

    policy: {
      defaultDeploymentQualification:
        'deny',

      boundaryQualificationStates: [
        QUALIFICATION_STATUS.QUALIFIED,
        QUALIFICATION_STATUS.REJECTED,
        QUALIFICATION_STATUS.UNRESOLVED,
      ],

      deploymentUsabilityStates: [
        USABILITY_STATUS.ELIGIBLE,
        USABILITY_STATUS.BLOCKED,
      ],

      identityReresolution:
        'forbidden',

      geometryReanalysis:
        'forbidden',

      boundarySemanticReanalysis:
        'forbidden',

      fuzzyMatching:
        false,

      substringMatching:
        false,

      llmAdjudication:
        false,

      deploymentMutation:
        'forbidden',

      graphMutation:
        'forbidden',

      traversalMutation:
        'forbidden',
    },

    boundaryQualifications,

    membershipObservations,

    deploymentEligibleMemberships,

    conflicts,

    health,

    stats: {
      boundaryQualificationCount:
        boundaryQualifications.length,

      qualifiedBoundaryCount:
        boundaryQualifications.filter(
          (qualification) =>
            qualification.status ===
            QUALIFICATION_STATUS.QUALIFIED
        ).length,

      rejectedBoundaryCount:
        boundaryQualifications.filter(
          (qualification) =>
            qualification.status ===
            QUALIFICATION_STATUS.REJECTED
        ).length,

      unresolvedBoundaryCount:
        boundaryQualifications.filter(
          (qualification) =>
            qualification.status ===
            QUALIFICATION_STATUS.UNRESOLVED
        ).length,

      membershipObservationCount:
        membershipObservations.length,

      directMembershipObservationCount:
        membershipObservations.filter(
          (observation) =>
            observation.membershipKind ===
            'direct'
        ).length,

      nestedMembershipObservationCount:
        membershipObservations.filter(
          (observation) =>
            observation.membershipKind ===
            'nested'
        ).length,

      resolvedIdentityObservationCount:
        membershipObservations.filter(
          (observation) =>
            observation.identityStatus ===
            'resolved'
        ).length,

      ambiguousIdentityObservationCount:
        membershipObservations.filter(
          (observation) =>
            observation.identityStatus ===
            'ambiguous'
        ).length,

      unresolvedIdentityObservationCount:
        membershipObservations.filter(
          (observation) =>
            observation.identityStatus ===
            'unresolved'
        ).length,

      deploymentEligibleMembershipCount:
        deploymentEligibleMemberships.length,

      blockedMembershipCount:
        membershipObservations.filter(
          (observation) =>
            observation.deploymentUsable ===
            false
        ).length,

      conflictCount:
        conflicts.length,

      graphChanged:
        false,

      traversalChanged:
        false,
    },

    graphChanged:
      false,

    traversalChanged:
      false,

    notes: [
      'Visual containment is preserved independently from deployment qualification.',
      'Only boundaries already typed as deployment_boundary are deployment-qualified in BUG-2E V1.',
      'Logical groups are explicitly rejected as deployment scope.',
      'Region groups remain unresolved pending deployment confirmation.',
      'Boundary subtypes are supporting metadata only and never qualify deployment by themselves.',
      'Only already-resolved identities from visualEntityGrounding may become deployment-eligible memberships.',
      'BUG-2E does not adjudicate multiple eligible boundary memberships; conflict resolution is deferred to BUG-2F.',
    ],
  };
}

/* ------------------------------------------------------- */
/* Persistence                                             */
/* ------------------------------------------------------- */

function saveVisualDeploymentEvidence(
  jobDir,
  evidence
) {
  const outputPath =
    path.join(
      jobDir,
      'visual-deployment-evidence.json'
    );

  fs.writeFileSync(
    outputPath,
    JSON.stringify(
      evidence,
      null,
      2
    ),
    'utf8'
  );

  return outputPath;
}

module.exports = {
  BUILDER_VERSION,
  QUALIFICATION_STATUS,
  USABILITY_STATUS,

  buildSemanticBoundaryIndex,
  buildGroundedEntityIndex,

  qualifyBoundary,
  buildBoundaryQualifications,
  buildQualificationIndex,

  buildMembershipObservation,
  buildMembershipObservations,
  buildDeploymentEligibleMemberships,
  buildMembershipConflictSets,

  buildVisualDeploymentEvidenceHealth,
  buildVisualDeploymentEvidence,
  saveVisualDeploymentEvidence,
};
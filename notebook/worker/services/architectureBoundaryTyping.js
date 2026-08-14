'use strict';

/**
 * BUG-22E.1 — Architecture Boundary Typing
 * BUG-2C — Visual Boundary Semantics
 *
 * Deterministic, domain-independent boundary/group semantics.
 *
 * Existing responsibility:
 * - type text-derived architecture boundary evidence
 *
 * BUG-2C responsibility:
 * - consume visually proven containers from
 *   visualBoundaryUnderstandingBuilder
 * - score competing semantic interpretations
 * - preserve ambiguity rather than forcing a type
 * - retain hierarchy / containment evidence
 *
 * Important rules:
 * - Geometry proves that a visual grouping exists.
 * - Text/context suggests what that grouping means.
 * - Generic words such as "zone", "cluster", "group",
 *   "service", or "platform" do not alone prove deployment.
 * - Repeated geometry does not prove replication, DR,
 *   active-active, failover, or deployment semantics.
 * - Unknown is a valid result.
 * - No graph or traversal mutation.
 */

const {
  CONFIDENCE,
  inferBoundaryTypeFromText,
  normalizeText,
} = require('./architectureEvidenceTaxonomy');

const VISUAL_TYPING_VERSION =
  'architecture-visual-boundary-typing-v1';

const VISUAL_SUMMARY_VERSION =
  'architecture-visual-boundary-summary-v1';

const STABLE_BOUNDARY_TYPES = {
  DEPLOYMENT_BOUNDARY: 'deployment_boundary',
  LOGICAL_GROUP: 'logical_group',
  REGION_GROUP: 'region_group',
  UNKNOWN: 'unknown',
};

function cleanText(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function asArray(value) {
  return Array.isArray(value)
    ? value
    : [];
}

function safeLower(value) {
  return cleanText(value)
    .toLowerCase();
}

function clamp01(value) {
  const number =
    Number(value);

  if (!Number.isFinite(number)) {
    return 0;
  }

  return Math.max(
    0,
    Math.min(1, number)
  );
}

function roundScore(value) {
  return Number(
    clamp01(value)
      .toFixed(4)
  );
}

function uniq(values = []) {
  return [
    ...new Set(
      asArray(values)
        .map(cleanText)
        .filter(Boolean)
    ),
  ];
}

function confidenceRank(value) {
  switch (safeLower(value)) {
    case 'deterministic':
      return 4;

    case 'high':
      return 3;

    case 'medium':
      return 2;

    case 'low':
      return 1;

    default:
      return 0;
  }
}

function confidenceFromScore(
  score,
  ambiguous = false
) {
  const value =
    Number(score || 0);

  if (
    value >= 0.8 &&
    !ambiguous
  ) {
    return CONFIDENCE.HIGH;
  }

  if (
    value >= 0.58 &&
    !ambiguous
  ) {
    return CONFIDENCE.MEDIUM;
  }

  return CONFIDENCE.LOW;
}

/* ------------------------------------------------------- */
/* Existing text-boundary typing                          */
/* ------------------------------------------------------- */

function splitBoundaryPhrase(text = '') {
  const value =
    cleanText(text);

  if (!value) {
    return [];
  }

  const separators = [
    /\s{2,}/,
    /\s+\|\s+/,
    /\s+\/\s+/,
    /\s+>\s+/,
    /\s+→\s+/,
  ];

  let parts = [
    value,
  ];

  for (
    const separator of
    separators
  ) {
    parts =
      parts.flatMap(
        (part) =>
          part.split(
            separator
          )
      );
  }

  /*
   * Split merged title-case phrases:
   *
   * "Routing Layer Application Cluster"
   * ->
   * ["Routing Layer", "Application Cluster"]
   */

  const titleChunks =
    value.match(
      /(?:[A-Z][a-z0-9]+(?:\s+[A-Z][a-z0-9]+){0,2})/g
    ) || [];

  if (
    titleChunks.length >= 2
  ) {
    parts.push(
      ...titleChunks
    );
  }

  return [
    ...new Set(
      parts
        .map(cleanText)
        .filter(Boolean)
    ),
  ];
}

function boundaryConfidence(
  boundaryType,
  source
) {
  if (
    !boundaryType ||
    boundaryType ===
      STABLE_BOUNDARY_TYPES.UNKNOWN
  ) {
    return CONFIDENCE.LOW;
  }

  /*
   * Explicit graphical box labels are strong sources.
   *
   * NOTE:
   * spatial_region is intentionally NOT high confidence.
   * Existing spatial regions currently represent OCR/text
   * proximity clusters, not proven graphical boundaries.
   */

  if (
    source === 'group_box_label' ||
    source === 'dotted_box_label' ||
    source === 'visual_boundary_understanding'
  ) {
    return CONFIDENCE.HIGH;
  }

  if (
    source === 'spatial_region'
  ) {
    return CONFIDENCE.MEDIUM;
  }

  return CONFIDENCE.MEDIUM;
}

function typeBoundaryEvidence(
  item = {}
) {
  const rawText =
    cleanText(
      item.rawText ||
      item.label ||
      item.text ||
      item.name ||
      ''
    );

  const source =
    item.source ||
    'unknown';

  const boundaryType =
    item.boundaryType ||
    inferBoundaryTypeFromText(
      rawText
    );

  return {
    rawText,

    boundaryType,

    source,

    confidence:
      item.confidence ||
      boundaryConfidence(
        boundaryType,
        source
      ),

    page:
      item.page ??
      null,

    evidenceIds:
      asArray(
        item.evidenceIds
      ),

    boundaryTyping: {
      version:
        'architecture-boundary-typing-v1',

      source:
        'architectureBoundaryTyping',

      notes:
        boundaryType ===
        STABLE_BOUNDARY_TYPES.UNKNOWN
          ? [
              'no_boundary_semantics_found',
            ]
          : [
              'typed_from_boundary_text',
            ],
    },
  };
}

function typeBoundaryEvidenceList(
  boundaryEvidence = []
) {
  return asArray(
    boundaryEvidence
  )
    .flatMap(
      (item) => {
        const phrases =
          splitBoundaryPhrase(
            item.rawText ||
            item.label ||
            item.text ||
            ''
          );

        if (
          !phrases.length
        ) {
          return [
            typeBoundaryEvidence(
              item
            ),
          ];
        }

        return phrases.map(
          (phrase) =>
            typeBoundaryEvidence({
              ...item,

              rawText:
                phrase,
            })
        );
      }
    )
    .filter(
      (item) =>
        item.rawText
    );
}

function findBoundaryForComponent(
  component = {},
  boundaryEvidence = []
) {
  const name =
    normalizeText(
      component.name ||
      component.label ||
      ''
    );

  if (!name) {
    return null;
  }

  return (
    asArray(
      boundaryEvidence
    ).find(
      (boundary) =>
        normalizeText(
          boundary.rawText ||
          ''
        ).includes(
          name
        )
    ) ||
    null
  );
}

/* ------------------------------------------------------- */
/* BUG-2C Generic subtype hints                           */
/* ------------------------------------------------------- */

function inferBoundarySubtypeHints(
  label = ''
) {
  const value =
    safeLower(label);

  const hints = [];

  if (!value) {
    return [
      {
        subtype:
          'unknown',
        score:
          0,
        basis:
          'missing_label',
      },
    ];
  }

  /*
   * These are supporting hints only.
   *
   * They never directly determine the stable boundaryType.
   */

  if (
    /\bavailability\s+zone\b|\baz[-\s_:]?[a-z0-9]+\b/i
      .test(value)
  ) {
    hints.push({
      subtype:
        'availability_zone_candidate',

      score:
        0.95,

      basis:
        'explicit_availability_zone_phrase',
    });
  }

  if (
    /\bdata\s*center\b|\bdatacenter\b/i
      .test(value)
  ) {
    hints.push({
      subtype:
        'data_center_candidate',

      score:
        0.92,

      basis:
        'explicit_data_center_phrase',
    });
  }

  if (
    /\bregion\s*[-_:]?\s*[a-z0-9]+\b/i
      .test(value)
  ) {
    hints.push({
      subtype:
        'region_candidate',

      score:
        0.9,

      basis:
        'explicit_region_with_differentiator',
    });
  }

  if (
    /\bsite\s*[-_:]?\s*[a-z0-9]+\b/i
      .test(value)
  ) {
    hints.push({
      subtype:
        'site_candidate',

      score:
        0.88,

      basis:
        'explicit_site_with_differentiator',
    });
  }

  if (
    /\bnamespace\b/i
      .test(value)
  ) {
    hints.push({
      subtype:
        'namespace_candidate',

      score:
        0.72,

      basis:
        'explicit_namespace_phrase',
    });
  }

  if (
    /\bcluster\b/i
      .test(value)
  ) {
    hints.push({
      subtype:
        'cluster_candidate',

      score:
        0.58,

      basis:
        'generic_cluster_phrase',
    });
  }

  if (
    /\bshared\b|\bglobal\b/i
      .test(value)
  ) {
    hints.push({
      subtype:
        'shared_group_candidate',

      score:
        0.66,

      basis:
        'shared_or_global_phrase',
    });
  }

  if (
    /\bdelivery\b/i
      .test(value)
  ) {
    hints.push({
      subtype:
        'delivery_group_candidate',

      score:
        0.56,

      basis:
        'delivery_group_phrase',
    });
  }

  if (
    /\borigin\b/i
      .test(value)
  ) {
    hints.push({
      subtype:
        'origin_group_candidate',

      score:
        0.56,

      basis:
        'origin_group_phrase',
    });
  }

  if (
    /\b(control\s+plane|data\s+plane|management\s+plane)\b/i
      .test(value)
  ) {
    hints.push({
      subtype:
        'plane_group_candidate',

      score:
        0.62,

      basis:
        'explicit_plane_phrase',
    });
  }

  if (
    /\b(layer|group|suite|domain|platform)\b/i
      .test(value)
  ) {
    hints.push({
      subtype:
        'logical_group_candidate',

      score:
        0.54,

      basis:
        'generic_grouping_phrase',
    });
  }

  if (
    /\b(zone)\b/i
      .test(value)
  ) {
    hints.push({
      subtype:
        'zone_candidate',

      score:
        0.46,

      basis:
        'generic_zone_phrase',
    });
  }

  if (
    !hints.length
  ) {
    hints.push({
      subtype:
        'unknown',

      score:
        0,

      basis:
        'no_supported_subtype_hint',
    });
  }

  return hints
    .sort(
      (a, b) =>
        b.score -
        a.score
    );
}

/* ------------------------------------------------------- */
/* BUG-2C Semantic candidate scoring                      */
/* ------------------------------------------------------- */

function emptySemanticScores() {
  return {
    [STABLE_BOUNDARY_TYPES.DEPLOYMENT_BOUNDARY]:
      0,

    [STABLE_BOUNDARY_TYPES.LOGICAL_GROUP]:
      0,

    [STABLE_BOUNDARY_TYPES.REGION_GROUP]:
      0,

    [STABLE_BOUNDARY_TYPES.UNKNOWN]:
      0,
  };
}

function addScore(
  scores,
  type,
  amount
) {
  if (
    !Object.prototype.hasOwnProperty.call(
      scores,
      type
    )
  ) {
    return;
  }

  scores[type] =
    roundScore(
      Number(
        scores[type] ||
        0
      ) +
      Number(
        amount ||
        0
      )
    );
}

function scoreVisualBoundarySemantics({
  boundary = {},
  parent = null,
  children = [],
} = {}) {
  const label =
    cleanText(
      boundary.primaryLabelText
    );

  const value =
    safeLower(label);

  const scores =
    emptySemanticScores();

  const basis = [];

  const visualRole =
    boundary.visualRole ||
    'unresolved';

  const visualConfidence =
    safeLower(
      boundary.confidence
    );

  const visualAmbiguous =
    Boolean(
      boundary.ambiguous
    );

  /*
   * Existing text taxonomy is supporting evidence.
   */

  const taxonomyType =
    label
      ? inferBoundaryTypeFromText(
          label
        )
      : STABLE_BOUNDARY_TYPES.UNKNOWN;

  /*
    * Existing taxonomy is supporting evidence only.
    *
    * Do not allow a broad lexical taxonomy result to dominate
    * stronger visual/hierarchical context.
    *
    * In particular, generic "zone" language must not by itself
    * establish geographic or deployment scope.
    */

    if (
      taxonomyType &&
      taxonomyType !==
        STABLE_BOUNDARY_TYPES.UNKNOWN
    ) {
      let taxonomyWeight =
        0.28;

      const genericZoneOnly =
        /\bzone\b/i.test(value) &&
        !/\bavailability\s+zone\b/i.test(value) &&
        !/\bregion\b/i.test(value) &&
        !/\bdata\s*center\b|\bdatacenter\b/i.test(value) &&
        !/\bsite\b/i.test(value);

      if (
        taxonomyType ===
          STABLE_BOUNDARY_TYPES.REGION_GROUP &&
        genericZoneOnly
      ) {
        taxonomyWeight =
          0.08;

        basis.push(
          'taxonomy_region_weakened_generic_zone'
        );
      }

      addScore(
        scores,
        taxonomyType,
        taxonomyWeight
      );

      basis.push(
        `existing_taxonomy:${taxonomyType}`
      );
    }

  /*
   * Explicit deployment phrases.
   *
   * These are intentionally narrower than generic
   * words such as zone / cluster / site.
   */

  if (
    /\bavailability\s+zone\b|\baz[-\s_:]?[a-z0-9]+\b/i
      .test(value)
  ) {
    addScore(
      scores,
      STABLE_BOUNDARY_TYPES.DEPLOYMENT_BOUNDARY,
      0.46
    );

    addScore(
      scores,
      STABLE_BOUNDARY_TYPES.REGION_GROUP,
      0.18
    );

    basis.push(
      'explicit_availability_zone'
    );
  }

  if (
    /\bdata\s*center\b|\bdatacenter\b/i
      .test(value)
  ) {
    addScore(
      scores,
      STABLE_BOUNDARY_TYPES.DEPLOYMENT_BOUNDARY,
      0.44
    );

    basis.push(
      'explicit_data_center'
    );
  }

  if (
    /\bregion\s*[-_:]?\s*[a-z0-9]+\b/i
      .test(value)
  ) {
    addScore(
      scores,
      STABLE_BOUNDARY_TYPES.REGION_GROUP,
      0.42
    );

    addScore(
      scores,
      STABLE_BOUNDARY_TYPES.DEPLOYMENT_BOUNDARY,
      0.28
    );

    basis.push(
      'explicit_region_with_differentiator'
    );
  }

  if (
    /\bsite\s*[-_:]?\s*[a-z0-9]+\b/i
      .test(value)
  ) {
    addScore(
      scores,
      STABLE_BOUNDARY_TYPES.DEPLOYMENT_BOUNDARY,
      0.38
    );

    basis.push(
      'explicit_site_with_differentiator'
    );
  }

  /*
   * Generic scope words contribute cautiously.
   */

  /*
    * "Zone" proves some kind of grouping vocabulary,
    * not geography or deployment.
    *
    * Examples across arbitrary architecture documents:
    * security zone
    * trust zone
    * origin zone
    * processing zone
    * storage zone
    * application zone
    *
    * Explicit phrases such as Availability Zone are handled
    * separately above.
    */

    if (
      /\bzone\b/i
        .test(value) &&
      !/\bavailability\s+zone\b/i.test(value)
    ) {
      addScore(
        scores,
        STABLE_BOUNDARY_TYPES.LOGICAL_GROUP,
        0.16
      );

      basis.push(
        'generic_zone_supports_grouping_only'
      );
    }

  if (
    /\bcluster\b/i
      .test(value)
  ) {
    addScore(
      scores,
      STABLE_BOUNDARY_TYPES.LOGICAL_GROUP,
      0.16
    );

    addScore(
      scores,
      STABLE_BOUNDARY_TYPES.DEPLOYMENT_BOUNDARY,
      0.08
    );

    basis.push(
      'generic_cluster_hint'
    );
  }

  /*
   * Generic logical grouping language.
   */

  if (
    /\b(group|layer|suite|domain|platform|service|plane)\b/i
      .test(value)
  ) {
    addScore(
      scores,
      STABLE_BOUNDARY_TYPES.LOGICAL_GROUP,
      0.26
    );

    basis.push(
      'generic_logical_group_language'
    );
  }

  if (
    /\b(shared|global)\b/i
      .test(value)
  ) {
    addScore(
      scores,
      STABLE_BOUNDARY_TYPES.LOGICAL_GROUP,
      0.24
    );

    basis.push(
      'shared_or_global_group_language'
    );
  }

  /*
   * Hierarchy proves structural grouping, but not deployment.
   */

  if (
    asArray(children)
      .length > 0
  ) {
    addScore(
      scores,
      STABLE_BOUNDARY_TYPES.LOGICAL_GROUP,
      0.16
    );

    basis.push(
      'contains_visual_child_boundaries'
    );
  }

  if (
    Number(
      boundary.depth ||
      0
    ) > 0
  ) {
    addScore(
      scores,
      STABLE_BOUNDARY_TYPES.LOGICAL_GROUP,
      0.14
    );

    basis.push(
      'nested_visual_boundary_supports_logical_group'
    );
  }

  if (parent) {
    addScore(
      scores,
      STABLE_BOUNDARY_TYPES.LOGICAL_GROUP,
      0.05
    );

    basis.push(
      'has_visual_parent'
    );
  }

  /*
   * Strong visual evidence increases trust in the existence
   * of the boundary, not any particular semantic type.
   */

  if (
    visualRole ===
      'container_candidate' &&
    visualConfidence ===
      'high'
  ) {
    basis.push(
      'high_confidence_visual_container'
    );
  }

  /*
   * Weak / ambiguous geometry suppresses forced semantics.
   */

  if (
    visualRole ===
      'unresolved' ||
    visualAmbiguous
  ) {
    scores[
      STABLE_BOUNDARY_TYPES.DEPLOYMENT_BOUNDARY
    ] *= 0.6;

    scores[
      STABLE_BOUNDARY_TYPES.LOGICAL_GROUP
    ] *= 0.6;

    scores[
      STABLE_BOUNDARY_TYPES.REGION_GROUP
    ] *= 0.6;

    addScore(
      scores,
      STABLE_BOUNDARY_TYPES.UNKNOWN,
      0.4
    );

    basis.push(
      'visual_boundary_ambiguous'
    );
  }

  if (!label) {
    scores[
      STABLE_BOUNDARY_TYPES.DEPLOYMENT_BOUNDARY
    ] *= 0.4;

    scores[
      STABLE_BOUNDARY_TYPES.LOGICAL_GROUP
    ] *= 0.4;

    scores[
      STABLE_BOUNDARY_TYPES.REGION_GROUP
    ] *= 0.4;

    addScore(
      scores,
      STABLE_BOUNDARY_TYPES.UNKNOWN,
      0.5
    );

    basis.push(
      'missing_label'
    );
  }

  for (
    const key of
    Object.keys(scores)
  ) {
    scores[key] =
      roundScore(
        scores[key]
      );
  }

  const ranked =
    Object.entries(scores)
      .map(
        ([type, score]) => ({
          type,
          score,
        })
      )
      .sort(
        (a, b) =>
          b.score -
          a.score
      );

  const top =
    ranked[0];

  const second =
    ranked[1];

  const margin =
    roundScore(
      Math.max(
        0,
        top.score -
        second.score
      )
    );

  /*
   * Require both meaningful evidence and separation.
   *
   * Unknown remains a valid result.
   */

  /*
    * Resolve semantics through either:
    *
    * 1. strong direct semantic evidence, or
    * 2. moderate semantic evidence supported by multiple
    *    independent structural/context signals.
    *
    * This avoids both extremes:
    * - forcing semantics from one keyword;
    * - leaving well-supported structural groups unresolved.
    */

    const semanticSupportSignals =
      [
        'existing_taxonomy:',
        'generic_zone_supports_grouping_only',
        'generic_logical_group_language',
        'shared_or_global_group_language',
        'generic_cluster_hint',
        'nested_visual_boundary_supports_logical_group',
        'has_visual_parent',
        'contains_visual_child_boundaries',
        'explicit_availability_zone',
        'explicit_data_center',
        'explicit_region_with_differentiator',
        'explicit_site_with_differentiator',
      ];

    const semanticSupportCount =
      semanticSupportSignals.filter(
        (signal) =>
          basis.some(
            (item) =>
              item === signal ||
              item.startsWith(signal)
          )
      ).length;

    const strongDirectDecision =
      top.type !==
        STABLE_BOUNDARY_TYPES.UNKNOWN &&
      top.score >= 0.55 &&
      margin >= 0.12;

    const corroboratedDecision =
      top.type !==
        STABLE_BOUNDARY_TYPES.UNKNOWN &&
      top.score >= 0.32 &&
      margin >= 0.15 &&
      semanticSupportCount >= 3;

    const strongDecision =
      (
        strongDirectDecision ||
        corroboratedDecision
      ) &&
      visualRole !==
        'unresolved' &&
      !visualAmbiguous;

  const boundaryType =
    strongDecision
      ? top.type
      : STABLE_BOUNDARY_TYPES.UNKNOWN;

  const ambiguous =
    !strongDecision;

  return {
    boundaryType,

    taxonomyBoundaryType:
      taxonomyType ||
      STABLE_BOUNDARY_TYPES.UNKNOWN,

    semanticCandidates:
      ranked,

    semanticSupportCount,

    decisionEvidence: {
      strongDirectDecision,
      corroboratedDecision,
      strongDecision,

      topType:
        top.type,

      topScore:
        top.score,

      secondType:
        second?.type ||
        null,

      secondScore:
        second?.score ??
        null,

      margin,

      visualRole,

      visualAmbiguous,
    },

    semanticScore:
      strongDecision
        ? top.score
        : ranked.find(
            (candidate) =>
              candidate.type ===
              STABLE_BOUNDARY_TYPES.UNKNOWN
          )?.score ||
          top.score,

    semanticMargin:
      margin,

    ambiguous,

    basis:
      uniq(basis),
  };
}

/* ------------------------------------------------------- */
/* BUG-2C Visual boundary typing                          */
/* ------------------------------------------------------- */

function typeVisualBoundary({
  boundary = {},
  boundaryById = new Map(),
} = {}) {
  const parent =
    boundary.parentBoundaryId
      ? boundaryById.get(
          boundary.parentBoundaryId
        )
      : null;

  const children =
    asArray(
      boundary.childBoundaryIds
    )
      .map(
        (boundaryId) =>
          boundaryById.get(
            boundaryId
          )
      )
      .filter(Boolean);

  const semantic =
    scoreVisualBoundarySemantics({
      boundary,
      parent,
      children,
    });

  const subtypeHints =
    inferBoundarySubtypeHints(
      boundary.primaryLabelText
    );

  const primarySubtype =
    subtypeHints[0] ||
    {
      subtype:
        'unknown',

      score:
        0,

      basis:
        'no_supported_subtype_hint',
    };

  const confidence =
    confidenceFromScore(
      semantic.semanticScore,
      semantic.ambiguous
    );

  return {
    boundaryId:
      boundary.boundaryId ||
      null,

    page:
      boundary.page ??
      null,

    rawText:
      cleanText(
        boundary.primaryLabelText
      ),

    source:
      'visual_boundary_understanding',

    sourceDrawingId:
      boundary.sourceDrawingId ||
      null,

    bounds:
      boundary.bounds ||
      null,

    visualRole:
      boundary.visualRole ||
      'unresolved',

    visualConfidence:
      boundary.confidence ||
      CONFIDENCE.LOW,

    visualAmbiguous:
      Boolean(
        boundary.ambiguous
      ),

    boundaryType:
      semantic.boundaryType,

    taxonomyBoundaryType:
      semantic.taxonomyBoundaryType,

    boundarySubtype:
      primarySubtype.subtype,

    subtypeCandidates:
      subtypeHints,

    semanticCandidates:
      semantic.semanticCandidates,

    semanticScore:
      semantic.semanticScore,

    semanticMargin:
      semantic.semanticMargin,

    semanticSupportCount:
      semantic.semanticSupportCount,

    decisionEvidence:
      semantic.decisionEvidence,

    semanticBasis:
      semantic.basis,

    confidence,

    ambiguous:
      semantic.ambiguous,

    parentBoundaryId:
      boundary.parentBoundaryId ||
      null,

    childBoundaryIds:
      asArray(
        boundary.childBoundaryIds
      ),

    ancestorBoundaryIds:
      asArray(
        boundary.ancestorBoundaryIds
      ),

    descendantBoundaryIds:
      asArray(
        boundary.descendantBoundaryIds
      ),

    rootBoundaryId:
      boundary.rootBoundaryId ||
      null,

    depth:
      Number(
        boundary.depth ||
        0
      ),

    containedObjectIds:
      asArray(
        boundary.containedObjectIds
      ),

    directContainedObjectIds:
      asArray(
        boundary.directContainedObjectIds
      ),

    evidence: {
      geometryObserved:
        Boolean(
          boundary.bounds
        ),

      labelObserved:
        Boolean(
          cleanText(
            boundary.primaryLabelText
          )
        ),

      hierarchyObserved:
        Boolean(
          boundary.parentBoundaryId ||
          asArray(
            boundary.childBoundaryIds
          ).length
        ),

      originalVisualConfidence:
        boundary.confidence ||
        null,

      originalRoleScores:
        boundary.roleScores ||
        {},
    },

    boundaryTyping: {
      version:
        VISUAL_TYPING_VERSION,

      source:
        'architectureBoundaryTyping',

      notes: [
        'visual_geometry_establishes_group_existence',
        'semantic_type_requires_independent_text_or_context_support',
        'generic_scope_words_do_not_force_deployment_semantics',
        'hierarchy_supports_grouping_but_does_not_prove_deployment',
        'unknown_is_a_valid_semantic_result',
      ],
    },
  };
}

function typeVisualBoundaryList(
  visualBoundaryUnderstanding = {}
) {
  const boundaries =
    asArray(
      visualBoundaryUnderstanding
        .boundaries
    );

  const boundaryById =
    new Map(
      boundaries
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

  return boundaries.map(
    (boundary) =>
      typeVisualBoundary({
        boundary,
        boundaryById,
      })
  );
}

function buildVisualBoundarySemanticSummary(
  visualBoundaryUnderstanding = {}
) {
  const boundaries =
    typeVisualBoundaryList(
      visualBoundaryUnderstanding
    );

  const typeBreakdown =
    boundaries.reduce(
      (acc, boundary) => {
        const type =
          boundary.boundaryType ||
          STABLE_BOUNDARY_TYPES.UNKNOWN;

        acc[type] =
          (acc[type] || 0) +
          1;

        return acc;
      },
      {}
    );

  const subtypeBreakdown =
    boundaries.reduce(
      (acc, boundary) => {
        const subtype =
          boundary.boundarySubtype ||
          'unknown';

        acc[subtype] =
          (acc[subtype] || 0) +
          1;

        return acc;
      },
      {}
    );

  const violations = [];

  const duplicateBoundaryIdCount =
    boundaries.length -
    new Set(
      boundaries
        .map(
          (boundary) =>
            boundary.boundaryId
        )
        .filter(Boolean)
    ).size;

  if (
    duplicateBoundaryIdCount >
    0
  ) {
    violations.push({
      reason:
        'duplicate_boundary_ids',

      count:
        duplicateBoundaryIdCount,
    });
  }

  const missingBoundaryIdCount =
    boundaries.filter(
      (boundary) =>
        !boundary.boundaryId
    ).length;

  if (
    missingBoundaryIdCount >
    0
  ) {
    violations.push({
      reason:
        'missing_boundary_ids',

      count:
        missingBoundaryIdCount,
    });
  }

  return {
    version:
      VISUAL_SUMMARY_VERSION,

    source:
      'architectureBoundaryTyping',

    stats: {
      boundaryCount:
        boundaries.length,

      resolvedBoundaryCount:
        boundaries.filter(
          (boundary) =>
            boundary.boundaryType !==
            STABLE_BOUNDARY_TYPES.UNKNOWN
        ).length,

      unknownBoundaryCount:
        boundaries.filter(
          (boundary) =>
            boundary.boundaryType ===
            STABLE_BOUNDARY_TYPES.UNKNOWN
        ).length,

      ambiguousBoundaryCount:
        boundaries.filter(
          (boundary) =>
            boundary.ambiguous
        ).length,

      highConfidenceCount:
        boundaries.filter(
          (boundary) =>
            boundary.confidence ===
            CONFIDENCE.HIGH
        ).length,

      mediumConfidenceCount:
        boundaries.filter(
          (boundary) =>
            boundary.confidence ===
            CONFIDENCE.MEDIUM
        ).length,

      lowConfidenceCount:
        boundaries.filter(
          (boundary) =>
            boundary.confidence ===
            CONFIDENCE.LOW
        ).length,

      typeBreakdown,

      subtypeBreakdown,

      graphChanged:
        false,

      traversalChanged:
        false,
    },

    boundaries,

    health: {
      version:
        'architecture-visual-boundary-summary-health-v1',

      valid:
        violations.length ===
        0,

      violationCount:
        violations.length,

      duplicateBoundaryIdCount,

      missingBoundaryIdCount,

      violations,
    },

    graphChanged:
      false,

    traversalChanged:
      false,

    notes: [
      'Stable boundary types remain deployment_boundary, logical_group, region_group, or unknown.',
      'Subtype hints are supporting metadata and do not override stable boundary types.',
      'Visual containment proves grouping existence but does not independently prove deployment semantics.',
      'Weak or competing evidence remains unknown.',
      'No architecture graph or traversal mutation occurs in BUG-2C.',
    ],
  };
}

/* ------------------------------------------------------- */
/* Existing summary — preserved for compatibility         */
/* ------------------------------------------------------- */

function buildBoundarySummary(
  architectureEvidence = {}
) {
  const typedBoundaries =
    typeBoundaryEvidenceList(
      architectureEvidence
        .boundaryEvidence ||
      []
    );

  return {
    version:
      'architecture-boundary-summary-v1',

    generatedAt:
      new Date().toISOString(),

    stats: {
      boundaryCount:
        typedBoundaries.length,

      highConfidenceCount:
        typedBoundaries.filter(
          (x) =>
            x.confidence ===
            CONFIDENCE.HIGH
        ).length,

      mediumConfidenceCount:
        typedBoundaries.filter(
          (x) =>
            x.confidence ===
            CONFIDENCE.MEDIUM
        ).length,

      lowConfidenceCount:
        typedBoundaries.filter(
          (x) =>
            x.confidence ===
            CONFIDENCE.LOW
        ).length,

      typeBreakdown:
        typedBoundaries.reduce(
          (acc, item) => {
            acc[
              item.boundaryType ||
              STABLE_BOUNDARY_TYPES.UNKNOWN
            ] =
              (
                acc[
                  item.boundaryType ||
                  STABLE_BOUNDARY_TYPES.UNKNOWN
                ] ||
                0
              ) +
              1;

            return acc;
          },
          {}
        ),
    },

    boundaries:
      typedBoundaries,
  };
}

module.exports = {
  STABLE_BOUNDARY_TYPES,

  typeBoundaryEvidence,
  typeBoundaryEvidenceList,
  findBoundaryForComponent,
  buildBoundarySummary,

  inferBoundarySubtypeHints,
  scoreVisualBoundarySemantics,
  typeVisualBoundary,
  typeVisualBoundaryList,
  buildVisualBoundarySemanticSummary,
};
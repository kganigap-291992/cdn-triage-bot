'use strict';

/**
 * visualBoundaryUnderstandingBuilder.js
 *
 * BUG-2B — Visual Boundary Understanding
 *
 * Borrowed ideas:
 * - PyMuPDF vector paths: preserve physical drawing evidence.
 * - Compound / clustered graph hierarchy: smallest containing parent owns
 *   direct membership while ancestors remain available.
 * - OpenCV RETR_TREE-style hierarchy contract: parent / child / ancestor
 *   representation can later be populated from raster contours.
 *
 * Owns:
 * - geometry normalization
 * - rectangle / closed-path candidate selection
 * - visual role scoring
 * - rectangle → rectangle containment
 * - rectangle → BUG-1 diagram object membership
 * - boundary label association
 * - immediate parent resolution
 * - depth / ancestors / descendants
 * - ambiguity + confidence
 * - raster fallback contract metadata
 *
 * Does NOT:
 * - classify deployment sites / zones
 * - infer architecture component semantics
 * - infer active-active / DR / failover
 * - interpret colors or dash styles semantically
 * - mutate architecture graph
 * - mutate traversal
 * - call an LLM
 */

const fs =
  require('fs');

const path =
  require('path');

const {
  normalizeBounds,
  area,
  aspectRatio,
  center,
  containsBounds,
  containsCenter,
  overlapRatio,
  topEdgeDistance,
  leftEdgeDistance,
} = require('./diagramGeometry');

const BUILDER_VERSION =
  'visual-boundary-understanding-v1';

const HEALTH_VERSION =
  'visual-boundary-understanding-health-v1';

function asArray(value) {
  return Array.isArray(value)
    ? value
    : [];
}

function safeString(value) {
  return String(
    value || ''
  ).trim();
}

function safeLower(value) {
  return safeString(
    value
  ).toLowerCase();
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

function unique(values = []) {
  return [
    ...new Set(
      asArray(values)
        .filter(Boolean)
    ),
  ];
}

function colorPresent(value) {
  return (
    Array.isArray(value) &&
    value.length > 0
  );
}

function isRectangleDrawing(
  drawing = {}
) {
  return (
    drawing.drawingKind ===
      'rectangle' &&
    normalizeBounds(
      drawing
    )
  );
}

function isClosedPathCandidate(
  drawing = {}
) {
  if (
    drawing.drawingKind ===
    'rectangle'
  ) {
    return true;
  }

  if (
    drawing.closePath === true &&
    normalizeBounds(drawing)
  ) {
    return true;
  }

  return false;
}

/* --------------------------------------------------------- */
/* BUG-2B.1 Geometry Normalization                           */
/* --------------------------------------------------------- */

function normalizeDrawingCandidate(
  drawing = {}
) {
  const bounds =
    normalizeBounds(
      drawing
    );

  if (!bounds) {
    return null;
  }

  return {
    sourceDrawingId:
      drawing.id ||
      null,

    page:
      Number(
        drawing.page
      ),

    sourceGeometryType:
      drawing.drawingKind ||
      'unknown',

    sourcePaintType:
      drawing.paintType ||
      null,

    bounds,

    geometry: {
      area:
        area(bounds),

      aspectRatio:
        aspectRatio(
          bounds
        ),

      isDashed:
        Boolean(
          drawing.isDashed
        ),

      strokeObserved:
        colorPresent(
          drawing.strokeColor
        ),

      fillObserved:
        colorPresent(
          drawing.fillColor
        ),

      strokeColor:
        drawing.strokeColor ||
        null,

      fillColor:
        drawing.fillColor ||
        null,

      strokeWidth:
        Number.isFinite(
          Number(
            drawing.strokeWidth
          )
        )
          ? Number(
              drawing.strokeWidth
            )
          : null,

      fillOpacity:
        Number.isFinite(
          Number(
            drawing.fillOpacity
          )
        )
          ? Number(
              drawing.fillOpacity
            )
          : null,

      strokeOpacity:
        Number.isFinite(
          Number(
            drawing.strokeOpacity
          )
        )
          ? Number(
              drawing.strokeOpacity
            )
          : null,

      closePath:
        Boolean(
          drawing.closePath
        ),

      dashPattern:
        drawing.dashPattern ||
        null,
    },

    rawDrawing:
      {
        itemCount:
          drawing.itemCount ||
          0,

        itemTypes:
          asArray(
            drawing.itemTypes
          ),
      },
  };
}

function buildGeometryCandidates(
  pdfLayout = {}
) {
  const candidates = [];

  for (
    const page of
    asArray(
      pdfLayout.pages
    )
  ) {
    for (
      const drawing of
      asArray(
        page.drawings
      )
    ) {
      if (
        !isClosedPathCandidate(
          drawing
        )
      ) {
        continue;
      }

      const candidate =
        normalizeDrawingCandidate(
          drawing
        );

      if (!candidate) {
        continue;
      }

      candidates.push(
        candidate
      );
    }
  }

  return candidates;
}

/* --------------------------------------------------------- */
/* Geometry indexes                                          */
/* --------------------------------------------------------- */

function buildPageIndex(
  items = []
) {
  const byPage =
    new Map();

  for (
    const item of
    asArray(items)
  ) {
    const page =
      Number(item.page);

    if (
      !Number.isFinite(page)
    ) {
      continue;
    }

    if (
      !byPage.has(page)
    ) {
      byPage.set(
        page,
        []
      );
    }

    byPage
      .get(page)
      .push(item);
  }

  return byPage;
}

function stronglyContains(
  containerBounds,
  childBounds
) {
  if (
    containsBounds(
      containerBounds,
      childBounds,
      0.002
    )
  ) {
    return true;
  }

  return (
    overlapRatio(
      containerBounds,
      childBounds
    ) >= 0.96
  );
}

function objectContainedByBoundary(
  boundaryBounds,
  objectBounds
) {
  if (
    containsCenter(
      boundaryBounds,
      objectBounds,
      0.002
    )
  ) {
    return true;
  }

  return (
    overlapRatio(
      boundaryBounds,
      objectBounds
    ) >= 0.8
  );
}

/* --------------------------------------------------------- */
/* BUG-2B.3 Preliminary rectangle → rectangle graph          */
/* --------------------------------------------------------- */

function buildCandidateContainment(
  candidates = []
) {
  const byPage =
    buildPageIndex(
      candidates
    );

  const containsMap =
    new Map();

  const containedByMap =
    new Map();

  for (
    const candidate of
    candidates
  ) {
    containsMap.set(
      candidate.sourceDrawingId,
      []
    );

    containedByMap.set(
      candidate.sourceDrawingId,
      []
    );
  }

  for (
    const pageCandidates of
    byPage.values()
  ) {
    for (
      const parent of
      pageCandidates
    ) {
      for (
        const child of
        pageCandidates
      ) {
        if (
          parent.sourceDrawingId ===
          child.sourceDrawingId
        ) {
          continue;
        }

        const parentArea =
          area(
            parent.bounds
          );

        const childArea =
          area(
            child.bounds
          );

        if (
          parentArea <=
          childArea
        ) {
          continue;
        }

        if (
          !stronglyContains(
            parent.bounds,
            child.bounds
          )
        ) {
          continue;
        }

        containsMap
          .get(
            parent.sourceDrawingId
          )
          .push(
            child.sourceDrawingId
          );

        containedByMap
          .get(
            child.sourceDrawingId
          )
          .push(
            parent.sourceDrawingId
          );
      }
    }
  }

  return {
    containsMap,
    containedByMap,
  };
}

/* --------------------------------------------------------- */
/* BUG-2B.4 Preliminary object membership                    */
/* --------------------------------------------------------- */

function buildCandidateObjectMembership({
  candidates = [],
  diagramObjectRegistry = {},
} = {}) {
  const diagramObjects =
    asArray(
      diagramObjectRegistry
        .objects
    );

  const objectsByPage =
    buildPageIndex(
      diagramObjects
    );

  const membership =
    new Map();

  for (
    const candidate of
    candidates
  ) {
    const pageObjects =
      objectsByPage.get(
        candidate.page
      ) || [];

    const contained =
      pageObjects
        .filter(
          (object) =>
            object.bounds &&
            objectContainedByBoundary(
              candidate.bounds,
              object.bounds
            )
        )
        .map(
          (object) =>
            object.id
        );

    membership.set(
      candidate.sourceDrawingId,
      contained
    );
  }

  return membership;
}

/* --------------------------------------------------------- */
/* BUG-2B.2 Role scoring                                     */
/* --------------------------------------------------------- */

function scoreGeometryRole({
  candidate = {},
  containedDrawingIds = [],
  containedObjectIds = [],
} = {}) {
  const geometry =
    candidate.geometry ||
    {};

  const candidateArea =
    Number(
      geometry.area || 0
    );

  const width =
    Number(
      candidate.bounds
        ?.width || 0
    );

  const height =
    Number(
      candidate.bounds
        ?.height || 0
    );

  const containsDrawingCount =
    asArray(
      containedDrawingIds
    ).length;

  const containsObjectCount =
    asArray(
      containedObjectIds
    ).length;

  const isTiny =
    candidateArea <
    0.0015;

  const isShort =
    height <
    0.022;

  const isCompact =
    candidateArea >=
      0.0015 &&
    candidateArea <=
      0.018 &&
    width <=
      0.18 &&
    height <=
      0.16;

  const isLarge =
    candidateArea >=
    0.03;

  const isVeryLarge =
    candidateArea >=
    0.08;

  const fillOnly =
    geometry
      .fillObserved &&
    !geometry
      .strokeObserved;

  let containerScore = 0;
  let nodeScore = 0;
  let decorationScore = 0;

  if (
    containsDrawingCount >= 1
  ) {
    containerScore += 0.28;
  }

  if (
    containsDrawingCount >= 2
  ) {
    containerScore += 0.18;
  }

  if (
    containsObjectCount >= 2
  ) {
    containerScore += 0.18;
  }

  if (
    containsObjectCount >= 4
  ) {
    containerScore += 0.12;
  }

  if (isLarge) {
    containerScore += 0.12;
  }

  if (isVeryLarge) {
    containerScore += 0.1;
  }

  if (
    geometry.isDashed
  ) {
    containerScore += 0.06;
  }

  if (
    geometry.strokeObserved
  ) {
    containerScore += 0.04;
  }

  if (isCompact) {
    nodeScore += 0.38;
  }

  if (
    containsObjectCount === 1
  ) {
    nodeScore += 0.22;
  }

  if (
    containsDrawingCount === 0
  ) {
    nodeScore += 0.12;
  }

  if (
    geometry.strokeObserved
  ) {
    nodeScore += 0.08;
  }

  if (
    geometry.fillObserved
  ) {
    nodeScore += 0.08;
  }

  if (isTiny) {
    decorationScore += 0.42;
  }

  if (isShort) {
    decorationScore += 0.25;
  }

  if (fillOnly) {
    decorationScore += 0.2;
  }

  if (
    containsDrawingCount === 0 &&
    containsObjectCount === 0
  ) {
    decorationScore += 0.08;
  }

  containerScore =
    roundScore(
      containerScore
    );

  nodeScore =
    roundScore(
      nodeScore
    );

  decorationScore =
    roundScore(
      decorationScore
    );

  const ranked = [
    {
        role:
        'container_candidate',
        score:
        containerScore,
    },

    {
        role:
        'node_candidate',
        score:
        nodeScore,
    },

    {
        role:
        'decoration_candidate',
        score:
        decorationScore,
    },
    ].sort(
    (a, b) =>
        b.score -
        a.score
    );

    const top =
    ranked[0];

    const second =
    ranked[1];

    const margin =
    top.score -
    second.score;

    /*
    * Strong-role rule:
    *
    * Do not force a visual role unless:
    * - the winning score is reasonably strong, AND
    * - it clearly separates from the next-best interpretation.
    *
    * This keeps ambiguous rectangles unresolved instead of
    * prematurely treating them as containers or nodes.
    */

    const strongRole =
    top.score >= 0.65 &&
    margin >= 0.20;

    const ambiguous =
    !strongRole;

    const visualRole =
    strongRole
        ? top.role
        : 'unresolved';

  return {
    visualRole,

    roleScores: {
      container_candidate:
        containerScore,

      node_candidate:
        nodeScore,

      decoration_candidate:
        decorationScore,
    },

    ambiguity: {
      ambiguous,
      topRole:
        top.role,

      topScore:
        top.score,

      secondRole:
        second.role,

      secondScore:
        second.score,

      margin:
        roundScore(
          Math.max(
            0,
            margin
          )
        ),
    },
  };
}

/* --------------------------------------------------------- */
/* Boundary candidate promotion                              */
/* --------------------------------------------------------- */

function isBoundaryCandidate(
  roleResult = {}
) {
  if (
    roleResult.visualRole ===
    'container_candidate'
  ) {
    return true;
  }

  const containerScore =
    Number(
      roleResult
        .roleScores
        ?.container_candidate ||
      0
    );

  const decorationScore =
    Number(
      roleResult
        .roleScores
        ?.decoration_candidate ||
      0
    );

  return (
    containerScore >= 0.45 &&
    decorationScore < 0.5
  );
}

/* --------------------------------------------------------- */
/* BUG-2B.5 Label association                                */
/* --------------------------------------------------------- */

function scoreLabelCandidate({
  boundary = {},
  object = {},
} = {}) {
  if (
    !boundary.bounds ||
    !object.bounds
  ) {
    return null;
  }

  if (
    !objectContainedByBoundary(
      boundary.bounds,
      object.bounds
    )
  ) {
    return null;
  }

  let score = 0.25;

  const overlap =
    overlapRatio(
      boundary.bounds,
      object.bounds
    );

  score +=
    Math.min(
      0.2,
      overlap * 0.2
    );

  const topDistance =
    topEdgeDistance(
      boundary.bounds,
      object.bounds
    );

  const leftDistance =
    leftEdgeDistance(
      boundary.bounds,
      object.bounds
    );

  if (
    topDistance !== null
  ) {
    if (
      topDistance <= 0.015
    ) {
      score += 0.28;
    } else if (
      topDistance <= 0.035
    ) {
      score += 0.18;
    } else if (
      topDistance <= 0.06
    ) {
      score += 0.08;
    }
  }

  if (
    leftDistance !== null
  ) {
    if (
      leftDistance <= 0.02
    ) {
      score += 0.15;
    } else if (
      leftDistance <= 0.05
    ) {
      score += 0.08;
    }
  }

  const objectCenter =
    center(
      object.bounds
    );

  const boundaryCenter =
    center(
      boundary.bounds
    );

  if (
    objectCenter &&
    boundaryCenter &&
    objectCenter.y <=
      boundaryCenter.y
  ) {
    score += 0.05;
  }

  const confidence =
    Number(
      object.confidence
    );

  if (
    Number.isFinite(
      confidence
    )
  ) {
    score +=
      Math.min(
        0.07,
        confidence *
          0.07
      );
  }

  const text =
    safeString(
      object.text
    );

  if (!text) {
    score -= 0.35;
  }

  if (
    text.length > 160
  ) {
    score -= 0.25;
  }

  return {
    objectId:
      object.id,

    text,

    score:
      roundScore(
        score
      ),

    topEdgeDistance:
      topDistance,

    leftEdgeDistance:
      leftDistance,

    overlapRatio:
      roundScore(
        overlap
      ),
  };
}

function associateLabels({
  boundary = {},
  diagramObjectRegistry = {},
} = {}) {
  const objects =
    asArray(
      diagramObjectRegistry
        .objects
    ).filter(
      (object) =>
        Number(
          object.page
        ) ===
        Number(
          boundary.page
        )
    );

  const candidates =
    objects
      .map(
        (object) =>
          scoreLabelCandidate({
            boundary,
            object,
          })
      )
      .filter(Boolean)
      .sort(
        (a, b) =>
          b.score -
          a.score
      )
      .slice(
        0,
        8
      );

  const primary =
    candidates[0] ||
    null;

  const second =
    candidates[1] ||
    null;

  const labelAmbiguous =
    Boolean(
      primary &&
      second &&
      Math.abs(
        primary.score -
        second.score
      ) < 0.08
    );

  return {
    primaryLabelObjectId:
      primary?.objectId ||
      null,

    primaryLabelText:
      primary?.text ||
      null,

    labelCandidates:
      candidates,

    labelAmbiguous,
  };
}

/* --------------------------------------------------------- */
/* BUG-2B.3 + 2B.6 Boundary hierarchy                        */
/* --------------------------------------------------------- */

function chooseImmediateParent({
  boundary,
  candidateParents = [],
} = {}) {
  const containing =
    candidateParents
      .filter(
        (parent) =>
          parent.boundaryId !==
            boundary.boundaryId &&
          Number(parent.page) ===
            Number(boundary.page) &&
          area(parent.bounds) >
            area(boundary.bounds) &&
          stronglyContains(
            parent.bounds,
            boundary.bounds
          )
      )
      .sort(
        (a, b) =>
          area(a.bounds) -
          area(b.bounds)
      );

  return (
    containing[0] ||
    null
  );
}

function resolveBoundaryHierarchy(
  boundaries = []
) {
  const byId =
    new Map(
      boundaries.map(
        (boundary) => [
          boundary.boundaryId,
          boundary,
        ]
      )
    );

  for (
    const boundary of
    boundaries
  ) {
    const parent =
      chooseImmediateParent({
        boundary,
        candidateParents:
          boundaries,
      });

    boundary.parentBoundaryId =
      parent
        ?.boundaryId ||
      null;
  }

  for (
    const boundary of
    boundaries
  ) {
    boundary.childBoundaryIds =
      boundaries
        .filter(
          (candidate) =>
            candidate
              .parentBoundaryId ===
            boundary
              .boundaryId
        )
        .map(
          (candidate) =>
            candidate.boundaryId
        );
  }

  function computeAncestors(
    boundary
  ) {
    const ancestors = [];

    const seen =
      new Set();

    let current =
      boundary;

    while (
      current
        ?.parentBoundaryId
    ) {
      if (
        seen.has(
          current
            .parentBoundaryId
        )
      ) {
        break;
      }

      seen.add(
        current
          .parentBoundaryId
      );

      ancestors.push(
        current
          .parentBoundaryId
      );

      current =
        byId.get(
          current
            .parentBoundaryId
        );
    }

    return ancestors;
  }

  function computeDescendants(
    boundary
  ) {
    const descendants = [];

    const stack = [
      ...asArray(
        boundary
          .childBoundaryIds
      ),
    ];

    const seen =
      new Set();

    while (
      stack.length
    ) {
      const childId =
        stack.shift();

      if (
        seen.has(
          childId
        )
      ) {
        continue;
      }

      seen.add(
        childId
      );

      descendants.push(
        childId
      );

      const child =
        byId.get(
          childId
        );

      stack.push(
        ...asArray(
          child
            ?.childBoundaryIds
        )
      );
    }

    return descendants;
  }

  for (
    const boundary of
    boundaries
  ) {
    const ancestors =
      computeAncestors(
        boundary
      );

    boundary.ancestorBoundaryIds =
      ancestors;

    boundary.depth =
      ancestors.length;

    boundary.rootBoundaryId =
      ancestors.length
        ? ancestors[
            ancestors.length -
            1
          ]
        : boundary
            .boundaryId;

    boundary.descendantBoundaryIds =
      computeDescendants(
        boundary
      );
  }

  return boundaries;
}

/* --------------------------------------------------------- */
/* BUG-2B.4 Direct object ownership                           */
/* --------------------------------------------------------- */

function assignDirectObjectMembership({
  boundaries = [],
  diagramObjectRegistry = {},
} = {}) {
  const objects =
    asArray(
      diagramObjectRegistry
        .objects
    );

  for (
    const boundary of
    boundaries
  ) {
    boundary.containedObjectIds =
      objects
        .filter(
          (object) =>
            Number(
              object.page
            ) ===
              Number(
                boundary.page
              ) &&
            object.bounds &&
            objectContainedByBoundary(
              boundary.bounds,
              object.bounds
            )
        )
        .map(
          (object) =>
            object.id
        );
  }

  for (
    const boundary of
    boundaries
  ) {
    const childBoundaryIds =
      new Set(
        boundary
          .childBoundaryIds ||
        []
      );

    const indirectObjects =
      new Set();

    for (
      const childId of
      childBoundaryIds
    ) {
      const child =
        boundaries.find(
          (candidate) =>
            candidate
              .boundaryId ===
            childId
        );

      for (
        const objectId of
        asArray(
          child
            ?.containedObjectIds
        )
      ) {
        indirectObjects.add(
          objectId
        );
      }
    }

    boundary.directContainedObjectIds =
      boundary
        .containedObjectIds
        .filter(
          (objectId) =>
            !indirectObjects.has(
              objectId
            )
        );
  }

  return boundaries;
}

/* --------------------------------------------------------- */
/* BUG-2B.7 Confidence / ambiguity                            */
/* --------------------------------------------------------- */

function summarizeBoundaryConfidence(
  boundary = {}
) {
  const containerScore =
    Number(
      boundary
        .roleScores
        ?.container_candidate ||
      0
    );

  const primaryLabelScore =
    Number(
      boundary
        .labelCandidates
        ?.[0]
        ?.score ||
      0
    );

  const hasHierarchyEvidence =
    Boolean(
      boundary
        .childBoundaryIds
        ?.length ||
      boundary
        .parentBoundaryId
    );

  const hasObjectEvidence =
    Boolean(
      boundary
        .containedObjectIds
        ?.length
    );

  let score =
    containerScore * 0.5;

  score +=
    Math.min(
      0.25,
      primaryLabelScore *
        0.25
    );

  if (
    hasHierarchyEvidence
  ) {
    score += 0.15;
  }

  if (
    hasObjectEvidence
  ) {
    score += 0.1;
  }

  score =
    roundScore(
      score
    );

  const ambiguity =
    Boolean(
      boundary
        .roleAmbiguity
        ?.ambiguous ||
      boundary
        .labelAmbiguous ||
      score < 0.55
    );

  let confidence =
    'low';

  if (
    score >= 0.8 &&
    !ambiguity
  ) {
    confidence =
      'high';
  } else if (
    score >= 0.6
  ) {
    confidence =
      'medium';
  }

  return {
    score,
    confidence,
    ambiguous:
      ambiguity,
  };
}

/* --------------------------------------------------------- */
/* Build                                                      */
/* --------------------------------------------------------- */

function buildVisualBoundaryUnderstanding({
  pdfLayout = {},
  diagramObjectRegistry = {},
} = {}) {
  const geometryCandidates =
    buildGeometryCandidates(
      pdfLayout
    );

  const {
    containsMap,
    containedByMap,
  } =
    buildCandidateContainment(
      geometryCandidates
    );

  const objectMembership =
    buildCandidateObjectMembership({
      candidates:
        geometryCandidates,

      diagramObjectRegistry,
    });

  const roleResults =
    new Map();

  for (
    const candidate of
    geometryCandidates
  ) {
    roleResults.set(
      candidate
        .sourceDrawingId,

      scoreGeometryRole({
        candidate,

        containedDrawingIds:
          containsMap.get(
            candidate
              .sourceDrawingId
          ) || [],

        containedObjectIds:
          objectMembership.get(
            candidate
              .sourceDrawingId
          ) || [],
      })
    );
  }

  const promoted =
    geometryCandidates.filter(
      (candidate) =>
        isBoundaryCandidate(
          roleResults.get(
            candidate
              .sourceDrawingId
          )
        )
    );

  const boundaries =
    promoted.map(
      (
        candidate,
        index
      ) => {
        const roleResult =
          roleResults.get(
            candidate
              .sourceDrawingId
          );

        const boundary = {
          boundaryId:
            `visual_boundary_p${candidate.page}_` +
            String(
              index + 1
            ).padStart(
              4,
              '0'
            ),

          page:
            candidate.page,

          sourceDrawingId:
            candidate
              .sourceDrawingId,

          sourceGeometryType:
            candidate
              .sourceGeometryType,

          bounds:
            candidate.bounds,

          geometry:
            candidate.geometry,

          visualRole:
            roleResult
              .visualRole,

          roleScores:
            roleResult
              .roleScores,

          roleAmbiguity:
            roleResult
              .ambiguity,

          semanticRole:
            'unresolved',

          parentBoundaryId:
            null,

          childBoundaryIds:
            [],

          ancestorBoundaryIds:
            [],

          descendantBoundaryIds:
            [],

          rootBoundaryId:
            null,

          depth:
            0,

          containedObjectIds:
            [],

          directContainedObjectIds:
            [],

          rawContainedDrawingIds:
            containsMap.get(
              candidate
                .sourceDrawingId
            ) || [],

          rawContainingDrawingIds:
            containedByMap.get(
              candidate
                .sourceDrawingId
            ) || [],
        };

        const labelAssociation =
          associateLabels({
            boundary,
            diagramObjectRegistry,
          });

        return {
          ...boundary,
          ...labelAssociation,
        };
      }
    );

  resolveBoundaryHierarchy(
    boundaries
  );

  assignDirectObjectMembership({
    boundaries,
    diagramObjectRegistry,
  });

  for (
    const boundary of
    boundaries
  ) {
    const confidence =
      summarizeBoundaryConfidence(
        boundary
      );

    boundary.confidenceScore =
      confidence.score;

    boundary.confidence =
      confidence.confidence;

    boundary.ambiguous =
      confidence.ambiguous;
  }

  const ambiguousBoundaries =
    boundaries.filter(
      (boundary) =>
        boundary.ambiguous
    );

  const unlabeledBoundaries =
    boundaries.filter(
      (boundary) =>
        !boundary
          .primaryLabelObjectId
    );

  const orphanBoundaryCount =
    boundaries.filter(
      (boundary) =>
        !boundary
          .parentBoundaryId &&
        boundary.depth !== 0
    ).length;

  const invalidBoundsCount =
    boundaries.filter(
      (boundary) =>
        !normalizeBounds(
          boundary.bounds
        )
    ).length;

  const duplicateBoundaryIds =
    boundaries.length -
    new Set(
      boundaries.map(
        (boundary) =>
          boundary.boundaryId
      )
    ).size;

  const healthViolations = [];

  if (
    invalidBoundsCount > 0
  ) {
    healthViolations.push({
      reason:
        'invalid_boundary_bounds',
      count:
        invalidBoundsCount,
    });
  }

  if (
    duplicateBoundaryIds > 0
  ) {
    healthViolations.push({
      reason:
        'duplicate_boundary_ids',
      count:
        duplicateBoundaryIds,
    });
  }

  if (
    orphanBoundaryCount > 0
  ) {
    healthViolations.push({
      reason:
        'invalid_boundary_hierarchy',
      count:
        orphanBoundaryCount,
    });
  }

  return {
    version:
      BUILDER_VERSION,

    source:
      'visualBoundaryUnderstandingBuilder',

    coordinateSystem:
      'normalized_page',

    geometrySource: {
      primary:
        'pymupdf_vector_drawings',

      fallbackContract:
        'opencv_contour_hierarchy',

      fallbackStatus:
        'not_implemented',

      notes: [
        'Vector and future raster geometry must resolve into the same visual containment contract.',
        'Raster fallback may later use contour parent/child hierarchy without changing downstream consumers.',
      ],
    },

    stats: {
      geometryCandidateCount:
        geometryCandidates.length,

      promotedBoundaryCount:
        boundaries.length,

      highConfidenceBoundaryCount:
        boundaries.filter(
          (boundary) =>
            boundary.confidence ===
            'high'
        ).length,

      mediumConfidenceBoundaryCount:
        boundaries.filter(
          (boundary) =>
            boundary.confidence ===
            'medium'
        ).length,

      lowConfidenceBoundaryCount:
        boundaries.filter(
          (boundary) =>
            boundary.confidence ===
            'low'
        ).length,

      ambiguousBoundaryCount:
        ambiguousBoundaries.length,

      unlabeledBoundaryCount:
        unlabeledBoundaries.length,

      rootBoundaryCount:
        boundaries.filter(
          (boundary) =>
            boundary
              .parentBoundaryId ===
            null
        ).length,

      nestedBoundaryCount:
        boundaries.filter(
          (boundary) =>
            boundary.depth > 0
        ).length,

      boundaryWithChildrenCount:
        boundaries.filter(
          (boundary) =>
            boundary
              .childBoundaryIds
              .length > 0
        ).length,

      boundaryWithObjectsCount:
        boundaries.filter(
          (boundary) =>
            boundary
              .containedObjectIds
              .length > 0
        ).length,

      directMembershipCount:
        boundaries.reduce(
          (
            sum,
            boundary
          ) =>
            sum +
            boundary
              .directContainedObjectIds
              .length,
          0
        ),

      graphChanged:
        false,

      traversalChanged:
        false,
    },

    boundaries,

    health: {
      version:
        HEALTH_VERSION,

      valid:
        healthViolations.length ===
        0,

      violationCount:
        healthViolations.length,

      invalidBoundsCount,

      duplicateBoundaryIdCount:
        duplicateBoundaryIds,

      orphanBoundaryCount,

      violations:
        healthViolations,
    },

    graphChanged:
      false,

    traversalChanged:
      false,

    notes: [
      'Visual boundaries are derived from physical geometry and containment evidence only.',
      'No deployment, logical-group, component, runtime, failover, shared-infrastructure, or traffic semantics are assigned in BUG-2B.',
      'A smallest-containing-parent hierarchy is used for direct boundary ownership.',
      'Labels are ranked spatially; ambiguous labels remain ambiguous.',
      'Dashed, color, fill, and stroke attributes are preserved as evidence but have no semantic meaning at this stage.',
    ],
  };
}

function saveVisualBoundaryUnderstanding(
  jobDir,
  result
) {
  const outputPath =
    path.join(
      jobDir,
      'visual-boundary-understanding.json'
    );

  fs.writeFileSync(
    outputPath,
    JSON.stringify(
      result,
      null,
      2
    ),
    'utf8'
  );

  return outputPath;
}

module.exports = {
  BUILDER_VERSION,

  buildGeometryCandidates,
  buildCandidateContainment,
  buildCandidateObjectMembership,
  scoreGeometryRole,
  scoreLabelCandidate,
  associateLabels,
  resolveBoundaryHierarchy,
  assignDirectObjectMembership,

  buildVisualBoundaryUnderstanding,
  saveVisualBoundaryUnderstanding,
};
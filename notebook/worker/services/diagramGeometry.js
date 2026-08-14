'use strict';

/**
 * diagramGeometry.js
 *
 * Generic normalized-page geometry helpers for diagram understanding.
 *
 * Rules:
 * - Domain-independent.
 * - No architecture semantics.
 * - No traversal mutation.
 * - No graph mutation.
 * - Coordinates are expected in normalized page space [0..1].
 */

function finiteNumber(value) {
  if (
    value === null ||
    value === undefined ||
    value === ''
  ) {
    return null;
  }

  const number = Number(value);

  return Number.isFinite(number)
    ? number
    : null;
}

function normalizeBounds(bounds = {}) {
  const x = finiteNumber(bounds.x);
  const y = finiteNumber(bounds.y);
  const width = finiteNumber(bounds.width);
  const height = finiteNumber(bounds.height);

  if (
    x === null ||
    y === null ||
    width === null ||
    height === null
  ) {
    return null;
  }

  if (
    width < 0 ||
    height < 0
  ) {
    return null;
  }

  return {
    x,
    y,
    width,
    height,
  };
}

function right(bounds = {}) {
  const normalized =
    normalizeBounds(bounds);

  if (!normalized) {
    return null;
  }

  return (
    normalized.x +
    normalized.width
  );
}

function bottom(bounds = {}) {
  const normalized =
    normalizeBounds(bounds);

  if (!normalized) {
    return null;
  }

  return (
    normalized.y +
    normalized.height
  );
}

function area(bounds = {}) {
  const normalized =
    normalizeBounds(bounds);

  if (!normalized) {
    return 0;
  }

  return (
    normalized.width *
    normalized.height
  );
}

function aspectRatio(bounds = {}) {
  const normalized =
    normalizeBounds(bounds);

  if (
    !normalized ||
    normalized.height === 0
  ) {
    return null;
  }

  return (
    normalized.width /
    normalized.height
  );
}

function center(bounds = {}) {
  const normalized =
    normalizeBounds(bounds);

  if (!normalized) {
    return null;
  }

  return {
    x:
      normalized.x +
      normalized.width / 2,

    y:
      normalized.y +
      normalized.height / 2,
  };
}

function containsPoint(
  container = {},
  point = {},
  tolerance = 0
) {
  const normalized =
    normalizeBounds(container);

  const px =
    finiteNumber(point.x);

  const py =
    finiteNumber(point.y);

  if (
    !normalized ||
    px === null ||
    py === null
  ) {
    return false;
  }

  const containerRight =
    right(normalized);

  const containerBottom =
    bottom(normalized);

  return (
    px >= normalized.x - tolerance &&
    px <= containerRight + tolerance &&
    py >= normalized.y - tolerance &&
    py <= containerBottom + tolerance
  );
}

function containsBounds(
  container = {},
  child = {},
  tolerance = 0
) {
  const parentBounds =
    normalizeBounds(container);

  const childBounds =
    normalizeBounds(child);

  if (
    !parentBounds ||
    !childBounds
  ) {
    return false;
  }

  return (
    childBounds.x >=
      parentBounds.x - tolerance &&

    childBounds.y >=
      parentBounds.y - tolerance &&

    right(childBounds) <=
      right(parentBounds) + tolerance &&

    bottom(childBounds) <=
      bottom(parentBounds) + tolerance
  );
}

function containsCenter(
  container = {},
  child = {},
  tolerance = 0
) {
  const childCenter =
    center(child);

  if (!childCenter) {
    return false;
  }

  return containsPoint(
    container,
    childCenter,
    tolerance
  );
}

function intersectionBounds(
  a = {},
  b = {}
) {
  const aBounds =
    normalizeBounds(a);

  const bBounds =
    normalizeBounds(b);

  if (
    !aBounds ||
    !bBounds
  ) {
    return null;
  }

  const x1 =
    Math.max(
      aBounds.x,
      bBounds.x
    );

  const y1 =
    Math.max(
      aBounds.y,
      bBounds.y
    );

  const x2 =
    Math.min(
      right(aBounds),
      right(bBounds)
    );

  const y2 =
    Math.min(
      bottom(aBounds),
      bottom(bBounds)
    );

  if (
    x2 <= x1 ||
    y2 <= y1
  ) {
    return null;
  }

  return {
    x: x1,
    y: y1,
    width: x2 - x1,
    height: y2 - y1,
  };
}

function intersectionArea(
  a = {},
  b = {}
) {
  const intersection =
    intersectionBounds(
      a,
      b
    );

  return intersection
    ? area(intersection)
    : 0;
}

function overlapRatio(
  container = {},
  child = {}
) {
  const childArea =
    area(child);

  if (!childArea) {
    return 0;
  }

  return (
    intersectionArea(
      container,
      child
    ) /
    childArea
  );
}

function intersectionOverUnion(
  a = {},
  b = {}
) {
  const intersection =
    intersectionArea(
      a,
      b
    );

  const union =
    area(a) +
    area(b) -
    intersection;

  if (!union) {
    return 0;
  }

  return (
    intersection /
    union
  );
}

function horizontalDistance(
  a = {},
  b = {}
) {
  const aBounds =
    normalizeBounds(a);

  const bBounds =
    normalizeBounds(b);

  if (
    !aBounds ||
    !bBounds
  ) {
    return null;
  }

  if (
    right(aBounds) < bBounds.x
  ) {
    return (
      bBounds.x -
      right(aBounds)
    );
  }

  if (
    right(bBounds) < aBounds.x
  ) {
    return (
      aBounds.x -
      right(bBounds)
    );
  }

  return 0;
}

function verticalDistance(
  a = {},
  b = {}
) {
  const aBounds =
    normalizeBounds(a);

  const bBounds =
    normalizeBounds(b);

  if (
    !aBounds ||
    !bBounds
  ) {
    return null;
  }

  if (
    bottom(aBounds) < bBounds.y
  ) {
    return (
      bBounds.y -
      bottom(aBounds)
    );
  }

  if (
    bottom(bBounds) < aBounds.y
  ) {
    return (
      aBounds.y -
      bottom(bBounds)
    );
  }

  return 0;
}

function centerDistance(
  a = {},
  b = {}
) {
  const aCenter =
    center(a);

  const bCenter =
    center(b);

  if (
    !aCenter ||
    !bCenter
  ) {
    return null;
  }

  const dx =
    aCenter.x -
    bCenter.x;

  const dy =
    aCenter.y -
    bCenter.y;

  return Math.sqrt(
    dx * dx +
    dy * dy
  );
}

function topEdgeDistance(
  container = {},
  child = {}
) {
  const parentBounds =
    normalizeBounds(container);

  const childBounds =
    normalizeBounds(child);

  if (
    !parentBounds ||
    !childBounds
  ) {
    return null;
  }

  return Math.abs(
    childBounds.y -
    parentBounds.y
  );
}

function leftEdgeDistance(
  container = {},
  child = {}
) {
  const parentBounds =
    normalizeBounds(container);

  const childBounds =
    normalizeBounds(child);

  if (
    !parentBounds ||
    !childBounds
  ) {
    return null;
  }

  return Math.abs(
    childBounds.x -
    parentBounds.x
  );
}

function isNearTopEdge(
  container = {},
  child = {},
  threshold = 0.04
) {
  const distance =
    topEdgeDistance(
      container,
      child
    );

  return (
    distance !== null &&
    distance <= threshold
  );
}

function isNearLeftEdge(
  container = {},
  child = {},
  threshold = 0.05
) {
  const distance =
    leftEdgeDistance(
      container,
      child
    );

  return (
    distance !== null &&
    distance <= threshold
  );
}

function boundsApproximatelyEqual(
  a = {},
  b = {},
  tolerance = 0.005
) {
  const aBounds =
    normalizeBounds(a);

  const bBounds =
    normalizeBounds(b);

  if (
    !aBounds ||
    !bBounds
  ) {
    return false;
  }

  return (
    Math.abs(
      aBounds.x -
      bBounds.x
    ) <= tolerance &&

    Math.abs(
      aBounds.y -
      bBounds.y
    ) <= tolerance &&

    Math.abs(
      aBounds.width -
      bBounds.width
    ) <= tolerance &&

    Math.abs(
      aBounds.height -
      bBounds.height
    ) <= tolerance
  );
}

module.exports = {
  finiteNumber,
  normalizeBounds,

  right,
  bottom,
  area,
  aspectRatio,
  center,

  containsPoint,
  containsBounds,
  containsCenter,

  intersectionBounds,
  intersectionArea,
  overlapRatio,
  intersectionOverUnion,

  horizontalDistance,
  verticalDistance,
  centerDistance,

  topEdgeDistance,
  leftEdgeDistance,

  isNearTopEdge,
  isNearLeftEdge,

  boundsApproximatelyEqual,
};
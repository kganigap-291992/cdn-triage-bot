const fs = require("fs");
const path = require("path");

const VERSION = "diagram-object-registry-v1";

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeText(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function finiteNumber(value) {
  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {
    return null;
  }

  const number =
    Number(value);

  return Number.isFinite(number)
    ? number
    : null;
}

function buildBounds(label = {}) {
  const x = finiteNumber(label.x);
  const y = finiteNumber(label.y);
  const width = finiteNumber(label.width);
  const height = finiteNumber(label.height);

  if (
    x === null ||
    y === null ||
    width === null ||
    height === null
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

function buildObjectId(page, index) {
  return `diagram_object_p${page}_${String(index + 1).padStart(4, "0")}`;
}

function buildDiagramObject(label, page, index) {
  const text = String(label?.text || "").trim();
  const bounds = buildBounds(label);

  return {
    id: buildObjectId(page, index),
    page,

    text,
    normalizedText: normalizeText(text),

    bounds,

    source: label?.source || "spatial_label",
    sourceLabelId: label?.id || null,
    confidence: finiteNumber(label?.confidence),

    visualRole: "unresolved",
    semanticRole: "unresolved",

    observations: [
      {
        source: label?.source || "spatial_label",
        sourceId: label?.id || null,
        confidence: finiteNumber(label?.confidence),
        bounds,
      },
    ],
  };
}

function validateObject(object) {
  const violations = [];

  if (!object.id) {
    violations.push("missing_object_id");
  }

  if (!Number.isInteger(object.page) || object.page < 1) {
    violations.push("invalid_page");
  }

  if (!object.text) {
    violations.push("missing_text");
  }

  if (!object.normalizedText) {
    violations.push("missing_normalized_text");
  }

  if (!object.bounds) {
    violations.push("missing_bounds");
  }

  if (object.confidence === null) {
    violations.push("missing_confidence");
  }

  return violations;
}

function buildDiagramObjectRegistry({
  spatialUnderstanding = {},
} = {}) {
  const objects = [];

  let sourceLabelCount = 0;
  let missingBoundsCount = 0;
  let missingConfidenceCount = 0;
  let emptyTextCount = 0;

  for (
    const pageRecord of
    asArray(
      spatialUnderstanding.pages
    )
  ) {
    const page =
      Number(
        pageRecord?.page
      );

    const labels =
      asArray(
        pageRecord?.labels
      );

    for (
      const [labelIndex, label] of
      labels.entries()
    ) {
      sourceLabelCount += 1;

      const object =
        buildDiagramObject(
          label,
          page,
          labelIndex
        );

      if (!object.text) {
        emptyTextCount += 1;
      }

      if (!object.bounds) {
        missingBoundsCount += 1;
      }

      if (object.confidence === null) {
        missingConfidenceCount += 1;
      }

      objects.push(object);
    }
  }

  const violations = objects.flatMap((object) =>
    validateObject(object).map((reason) => ({
      objectId: object.id,
      reason,
    }))
  );

  const pageCount = new Set(
    objects
      .map((object) => object.page)
      .filter((page) => Number.isInteger(page))
  ).size;

  const uniqueSourceLabelIds = new Set(
    objects
      .map((object) => object.sourceLabelId)
      .filter(Boolean)
  );

    const duplicateSourceLabelCount =
      objects.filter(
        (object) =>
          object.sourceLabelId
      ).length -
      uniqueSourceLabelIds.size;

    const sourceLabelObjectMismatchCount =
    Math.abs(
      sourceLabelCount -
      objects.length
    );

  const health = {
    version: "diagram-object-registry-health-v1",

    valid:
      violations.length === 0 &&
      sourceLabelObjectMismatchCount === 0,

    violationCount:
      violations.length,

    missingBoundsCount,
    missingConfidenceCount,
    emptyTextCount,
    duplicateSourceLabelCount,

    sourceLabelObjectMismatchCount,

    violations,
  };

  return {
    version: VERSION,
    source: "spatialUnderstanding",

    objects,

    stats: {
      pageCount,
      sourceLabelCount,
      objectCount: objects.length,

      unresolvedVisualRoleCount:
        objects.filter(
          (object) => object.visualRole === "unresolved"
        ).length,

      unresolvedSemanticRoleCount:
        objects.filter(
          (object) => object.semanticRole === "unresolved"
        ).length,

      sourceCounts: objects.reduce((acc, object) => {
        const source = object.source || "unknown";
        acc[source] = (acc[source] || 0) + 1;
        return acc;
      }, {}),
    },

    health,

    graphChanged: false,
    traversalChanged: false,

    notes: [
      "Registry preserves spatial labels as neutral diagram-object candidates.",
      "No component, boundary, deployment, annotation, protocol, runtime, or shared-infrastructure semantics are assigned here.",
      "Text-cluster regions are intentionally excluded because spatialUnderstanding regions currently represent OCR phrase proximity rather than detected visual boundaries.",
      "Semantic interpretation is deferred to downstream diagram reasoning phases.",
    ],
  };
}

function saveDiagramObjectRegistry(jobDir, registry) {
  const outputPath = path.join(
    jobDir,
    "diagram-object-registry.json"
  );

  fs.writeFileSync(
    outputPath,
    JSON.stringify(registry, null, 2),
    "utf8"
  );

  return outputPath;
}

module.exports = {
  VERSION,
  buildDiagramObjectRegistry,
  saveDiagramObjectRegistry,
};

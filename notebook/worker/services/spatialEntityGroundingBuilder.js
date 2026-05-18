const VERSION = "spatial-entity-grounding-v1";

const CAMERA_ELIGIBLE_CONFIDENCE = new Set(["high", "medium"]);

const GENERIC_LABELS = new Set([
  "name",
  "type",
  "value",
  "source",
  "status",
  "notes",
  "scope",
  "role",
  "team",
  "only",
  "app",
  "format",
  "content",
  "platform",
  "browsers",
]);

function normalizeText(value) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, " ");
}

function normalizeKey(value) {
  return normalizeText(value).toLowerCase();
}

function getEntityId(entity, index) {
  return (
    entity?.id ||
    entity?.entityId ||
    entity?.key ||
    `entity_${String(index + 1).padStart(3, "0")}`
  );
}

function getEntityLabel(entity) {
  return normalizeText(entity?.label || entity?.name || entity?.text || entity?.title);
}

function isUsefulEntity(entity) {
  const label = normalizeText(entity?.label || entity?.name);

  if (!label) return false;
  if (label.length < 2) return false;
  if (/^\d+$/.test(label)) return false;
  if (GENERIC_LABELS.has(label.toLowerCase())) return false;

  return true;
}

function getDocumentEntities(documentUnderstanding) {
  const entities = Array.isArray(documentUnderstanding?.entities)
    ? documentUnderstanding.entities
    : [];

  return entities
    .map((entity, index) => {
      const label = getEntityLabel(entity);

      if (!label) return null;

      return {
        entityId: getEntityId(entity, index),
        label,
        normalizedLabel: normalizeKey(label),
        source: "document_understanding",
        originalType: entity?.type || entity?.role || "entity",
      };
    })
    .filter(Boolean)
    .filter(isUsefulEntity);
}

function getLayoutBoxes(layoutBoxes) {
  if (Array.isArray(layoutBoxes)) return layoutBoxes;

  if (Array.isArray(layoutBoxes?.boxes)) return layoutBoxes.boxes;
  if (Array.isArray(layoutBoxes?.layoutBoxes)) return layoutBoxes.layoutBoxes;

  if (Array.isArray(layoutBoxes?.pages)) {
    return layoutBoxes.pages.flatMap((page, pageIndex) => {
      const pageNumber =
        page.pageNumber || page.page || page.number || pageIndex + 1;

      return [
        ...(Array.isArray(page.lines) ? page.lines : []),
        ...(Array.isArray(page.blocks) ? page.blocks : []),
        ...(Array.isArray(page.items) ? page.items : []),
        ...(Array.isArray(page.headings) ? page.headings : []),
        ...(Array.isArray(page.sections) ? page.sections : []),
      ].map((item, itemIndex) => ({
        ...item,
        page: item.page || item.pageNumber || pageNumber,
        order: item.order ?? itemIndex,
      }));
    });
  }

  return [];
}


function getSpatialLabels(spatialUnderstanding = {}) {
  const pages = Array.isArray(spatialUnderstanding?.pages)
    ? spatialUnderstanding.pages
    : [];

  return pages.flatMap((page, pageIndex) => {
    const pageNumber = page.page || page.pageNumber || pageIndex + 1;
    const labels = Array.isArray(page.labels) ? page.labels : [];

    return labels.map((label, labelIndex) => ({
      ...label,
      page: label.page || label.pageNumber || pageNumber,
      order: label.order ?? labelIndex,
    }));
  });
}

function getBoxText(box) {
  return normalizeText(box?.text || box?.label || box?.title || box?.heading);
}

function toRegion(box) {
  return {
    page: box?.page ?? box?.pageNumber ?? 1,
    x: box?.x ?? box?.left ?? 0,
    y: box?.y ?? box?.top ?? 0,
    width: box?.width ?? box?.w ?? 1,
    height: box?.height ?? box?.h ?? 1,
  };
}

function getRegionArea(region) {
  if (!region) return 1;
  return Number(region.width || 1) * Number(region.height || 1);
}

function makeCandidate({ entity, source, confidence, reason, box }) {
  const region = box ? toRegion(box) : null;

  return {
    entityId: entity.entityId,
    label: entity.label,
    source,
    confidence,
    cameraEligible: CAMERA_ELIGIBLE_CONFIDENCE.has(confidence),
    reason,
    region,
    score: scoreCandidate({
      confidence,
      source,
      region,
    }),
    evidence: box
      ? {
          text: getBoxText(box),
          page: box?.page ?? box?.pageNumber ?? 1,
        }
      : null,
  };
}

function scoreCandidate({ confidence, source, region }) {
  let score = 0;

  if (confidence === "high") score += 100;
  if (confidence === "medium") score += 70;
  if (confidence === "low") score += 30;

  if (source === "layout_exact_label") score += 30;
  if (source === "ocr_exact_label") score += 25;
  if (source === "spatial_candidate") score += 15;

  const area = getRegionArea(region);

  if (area > 0 && area < 0.03) score += 20;
  if (area >= 0.03 && area < 0.12) score += 10;
  if (area >= 0.2) score -= 20;

  return score;
}

function findLayoutExactCandidates({ entities, layoutBoxes }) {
  const candidates = [];

  for (const entity of entities) {
    for (const box of layoutBoxes) {
      const boxText = getBoxText(box);
      if (!boxText) continue;

      if (normalizeKey(boxText) === entity.normalizedLabel) {
        candidates.push(
          makeCandidate({
            entity,
            source: "layout_exact_label",
            confidence: "high",
            reason: "Exact normalized label match from layout boxes.",
            box,
          })
        );
      }
    }
  }

  return candidates;
}

function findSpatialPhraseCandidates({ entities, spatialLabels }) {
  const candidates = [];

  for (const entity of entities) {
    for (const label of spatialLabels) {
      const labelText = normalizeText(label.text || label.label || label.title);
      const normalizedLabelText = normalizeKey(labelText);

      if (!labelText) continue;

      const exactMatch = normalizedLabelText === entity.normalizedLabel;
      const words = normalizedLabelText.split(/[^a-z0-9]+/);

      const phraseMatch =
        entity.normalizedLabel.length >= 3 &&
        words.includes(entity.normalizedLabel);

      if (!exactMatch && !phraseMatch) continue;

      candidates.push(
        makeCandidate({
          entity,
          source: exactMatch ? "ocr_exact_label" : "spatial_candidate",
          confidence: exactMatch ? "high" : "medium",
          reason: exactMatch
            ? "Exact normalized label match from OCR/spatial labels."
            : "Entity label appears inside OCR/spatial phrase.",
          box: {
            ...label,
            text: labelText,
          },
        })
      );
    }
  }

  return candidates;
}

function getCandidateKey(candidate) {
  const region = candidate.region || {};

  return [
    candidate.entityId,
    candidate.source,
    candidate.evidence?.page || region.page || "unknown",
    normalizeKey(candidate.evidence?.text || candidate.label),
    Number(region.x || 0).toFixed(4),
    Number(region.y || 0).toFixed(4),
  ].join(":");
}

function rankAndDedupeCandidates(candidates = []) {
  const bestByKey = new Map();

  candidates.forEach((candidate) => {
    const key = getCandidateKey(candidate);
    const existing = bestByKey.get(key);

    if (!existing || candidate.score > existing.score) {
      bestByKey.set(key, candidate);
    }
  });

  const groupedByEntity = new Map();

  Array.from(bestByKey.values()).forEach((candidate) => {
    const existing = groupedByEntity.get(candidate.entityId) || [];
    existing.push(candidate);
    groupedByEntity.set(candidate.entityId, existing);
  });

  const cleaned = [];

  groupedByEntity.forEach((entityCandidates) => {
    const ranked = entityCandidates
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);

    cleaned.push(...ranked);
  });

  return cleaned.sort(
    (a, b) =>
      b.score - a.score ||
      String(a.label).localeCompare(String(b.label))
  );
}

function buildBestCandidates(candidates = []) {
  const bestByEntity = {};

  candidates
    .filter((candidate) => candidate.cameraEligible)
    .forEach((candidate) => {
      const existing = bestByEntity[candidate.entityId];

      if (!existing || candidate.score > existing.score) {
        bestByEntity[candidate.entityId] = candidate;
      }
    });

  return bestByEntity;
}

function buildSpatialEntityGrounding({
  documentUnderstanding = {},
  spatialUnderstanding = {},
  layoutBoxes = {},
  documentStructure = {},
} = {}) {
  const entities = getDocumentEntities(documentUnderstanding);
  const normalizedLayoutBoxes = getLayoutBoxes(layoutBoxes);
  const spatialLabels = getSpatialLabels(spatialUnderstanding);

  const rawCandidates = [
    ...findLayoutExactCandidates({
      entities,
      layoutBoxes: normalizedLayoutBoxes,
    }),
    ...findSpatialPhraseCandidates({
      entities,
      spatialLabels,
    }),
  ];

  const candidates = rankAndDedupeCandidates(rawCandidates);

  const bestCandidates = buildBestCandidates(candidates);

  return {
    version: VERSION,
    entities,
    candidates,
    bestCandidates,
    stats: {
      entityCount: entities.length,
      layoutBoxCount: normalizedLayoutBoxes.length,
      spatialLabelCount: spatialLabels.length,
      rawCandidateCount: rawCandidates.length,
      candidateCount: candidates.length,
      bestCandidateCount: Object.keys(bestCandidates).length,
      layoutExactCandidateCount: candidates.filter(
        (candidate) => candidate.source === "layout_exact_label"
      ).length,
      ocrExactCandidateCount: candidates.filter(
        (candidate) => candidate.source === "ocr_exact_label"
      ).length,
      spatialCandidateCount: candidates.filter(
        (candidate) => candidate.source === "spatial_candidate"
      ).length,
      spatialPageCount:
        spatialUnderstanding?.stats?.pageCount ||
        spatialUnderstanding?.pageCount ||
        0,
      documentSectionCount: Array.isArray(documentStructure?.sections)
        ? documentStructure.sections.length
        : 0,
    },
    groundingOrder: [
      "layout_exact_label",
      "ocr_exact_label",
      "spatial_candidate",
      "semantic_fallback",
    ],
    confidencePolicy: {
      cameraEligible: ["high", "medium"],
      debugOnly: ["low"],
    },
  };
}

module.exports = {
  buildSpatialEntityGrounding,
};
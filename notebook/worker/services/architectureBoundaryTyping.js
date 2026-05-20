'use strict';

/**
 * BUG-22E.1 — Architecture Boundary Typing
 *
 * Adds deterministic, domain-independent boundary/group semantics.
 *
 * No traversal or rendering changes yet.
 */

const {
  CONFIDENCE,
  inferBoundaryTypeFromText,
  normalizeText,
} = require('./architectureEvidenceTaxonomy');

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function splitBoundaryPhrase(text = '') {
  const value = cleanText(text);

  if (!value) return [];

  const separators = [
    /\s{2,}/,
    /\s+\|\s+/,
    /\s+\/\s+/,
    /\s+>\s+/,
    /\s+→\s+/,
  ];

  let parts = [value];

  for (const separator of separators) {
    parts = parts.flatMap((part) => part.split(separator));
  }

  // Split merged title-case phrases:
  // "Routing Layer Application Cluster"
  // -> ["Routing Layer", "Application Cluster"]

  const titleChunks =
    value.match(
      /(?:[A-Z][a-z0-9]+(?:\s+[A-Z][a-z0-9]+){0,2})/g
    ) || [];

  if (titleChunks.length >= 2) {
    parts.push(...titleChunks);
  }

  return [...new Set(parts.map(cleanText).filter(Boolean))];
}

function boundaryConfidence(boundaryType, source) {
  if (!boundaryType || boundaryType === 'unknown') return CONFIDENCE.LOW;

  if (
    source === 'group_box_label' ||
    source === 'dotted_box_label' ||
    source === 'spatial_region'
  ) {
    return CONFIDENCE.HIGH;
  }

  return CONFIDENCE.MEDIUM;
}

function typeBoundaryEvidence(item = {}) {
  const rawText = cleanText(item.rawText || item.label || item.text || item.name || '');
  const source = item.source || 'unknown';
  const boundaryType = item.boundaryType || inferBoundaryTypeFromText(rawText);

  return {
    rawText,
    boundaryType,
    source,
    confidence: item.confidence || boundaryConfidence(boundaryType, source),
    page: item.page ?? null,
    evidenceIds: asArray(item.evidenceIds),
    boundaryTyping: {
      version: 'architecture-boundary-typing-v1',
      source: 'architectureBoundaryTyping',
      notes:
        boundaryType === 'unknown'
          ? ['no_boundary_semantics_found']
          : ['typed_from_boundary_text'],
    },
  };
}

function typeBoundaryEvidenceList(boundaryEvidence = []) {
  return asArray(boundaryEvidence)
  .flatMap((item) => {
    const phrases = splitBoundaryPhrase(
      item.rawText || item.label || item.text || ''
    );

    if (!phrases.length) {
      return [typeBoundaryEvidence(item)];
    }

    return phrases.map((phrase) =>
      typeBoundaryEvidence({
        ...item,
        rawText: phrase,
      })
    );
  })
  .filter((item) => item.rawText);
}

function findBoundaryForComponent(component = {}, boundaryEvidence = []) {
  const name = normalizeText(component.name || component.label || '');
  if (!name) return null;

  return (
    asArray(boundaryEvidence).find((boundary) =>
      normalizeText(boundary.rawText || '').includes(name)
    ) || null
  );
}

function buildBoundarySummary(architectureEvidence = {}) {
  const typedBoundaries = typeBoundaryEvidenceList(
    architectureEvidence.boundaryEvidence || []
  );

  return {
    version: 'architecture-boundary-summary-v1',
    generatedAt: new Date().toISOString(),
    stats: {
      boundaryCount: typedBoundaries.length,
      highConfidenceCount: typedBoundaries.filter(
        (x) => x.confidence === CONFIDENCE.HIGH
      ).length,
      mediumConfidenceCount: typedBoundaries.filter(
        (x) => x.confidence === CONFIDENCE.MEDIUM
      ).length,
      lowConfidenceCount: typedBoundaries.filter(
        (x) => x.confidence === CONFIDENCE.LOW
      ).length,
      typeBreakdown: typedBoundaries.reduce((acc, item) => {
        acc[item.boundaryType || 'unknown'] =
          (acc[item.boundaryType || 'unknown'] || 0) + 1;
        return acc;
      }, {}),
    },
    boundaries: typedBoundaries,
  };
}

module.exports = {
  typeBoundaryEvidence,
  typeBoundaryEvidenceList,
  findBoundaryForComponent,
  buildBoundarySummary,
};
'use strict';

/**
 * BUG-22D.1 — Architecture Edge Typing
 *
 * Adds generic, domain-independent edge semantics.
 * No traversal changes yet.
 */

const {
  CONFIDENCE,
  EDGE_STYLES,
  inferEdgeTypeFromText,
  normalizeText,
} = require('./architectureEvidenceTaxonomy');

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractLocalizedEdgePhrase(rel = {}) {
  const evidenceText = cleanText(rel.evidenceText || rel.rawText || rel.text || rel.evidence || '');
  const sourceName = cleanText(rel.sourceName || rel.from || '');
  const targetName = cleanText(rel.targetName || rel.to || '');

  if (!evidenceText) return '';

  const sourcePattern = sourceName ? escapeRegExp(sourceName) : '';
  const targetPattern = targetName ? escapeRegExp(targetName) : '';

  if (sourcePattern && targetPattern) {
    const directPattern = new RegExp(
      `${sourcePattern}.{0,140}${targetPattern}`,
      'i'
    );

    const directMatch = evidenceText.match(directPattern);
    if (directMatch) {
      return cleanText(directMatch[0]).slice(0, 220);
    }

    const reversePattern = new RegExp(
      `${targetPattern}.{0,140}${sourcePattern}`,
      'i'
    );

    const reverseMatch = evidenceText.match(reversePattern);
    if (reverseMatch) {
      return cleanText(reverseMatch[0]).slice(0, 220);
    }
  }

  const sentences = evidenceText
    .split(/(?<=[.!?])\s+|;|\n+/)
    .map(cleanText)
    .filter(Boolean);

  const matchingSentence = sentences.find((sentence) => {
    const lowerSentence = sentence.toLowerCase();
    return (
      sourceName &&
      targetName &&
      lowerSentence.includes(sourceName.toLowerCase()) &&
      lowerSentence.includes(targetName.toLowerCase())
    );
  });

  if (matchingSentence) {
    return matchingSentence.slice(0, 220);
  }

  return evidenceText.slice(0, 220);
}

function extractSemanticActionWindow(text = '') {
  const value = cleanText(text);

  if (!value) return '';

  const patterns = [
    /\b(forwards? cache misses?)\b/i,
    /\b(cache hit[s]?)\b/i,
    /\b(reads? and writes? operational data)\b/i,
    /\b(reads? and writes?)\b/i,
    /\b(validates? authentication)\b/i,
    /\b(distributes? traffic)\b/i,
    /\b(manages? internal service distribution)\b/i,
    /\b(sends? requests?)\b/i,
    /\b(routes? requests?)\b/i,
    /\b(push(?:es)? config(?:uration)?)\b/i,
    /\b(sends? metrics?)\b/i,
    /\b(publishes? manifest[s]?)\b/i,
    /\b(fetch(?:es)? metadata)\b/i,
    /\b(sync(?:s|hronizes)?)\b/i,
    /\b(replicates?)\b/i,
  ];

  for (const pattern of patterns) {
    const match = value.match(pattern);
    if (match) {
      return cleanText(match[0]);
    }
  }

  const sentence = value
    .split(/(?<=[.!?])\s+/)
    .map(cleanText)
    .find(Boolean);

  return sentence ? sentence.slice(0, 120) : value.slice(0, 120);
}

function collectRelationshipText(rel = {}) {
  const localizedPhrase = extractLocalizedEdgePhrase(rel);

  const semanticActionWindow =
  extractSemanticActionWindow(localizedPhrase);

  return [
    semanticActionWindow,
    localizedPhrase,
    rel.edgeLabel,
    rel.label,
    rel.evidenceText,
    rel.rawText,
    rel.text,
    rel.evidence,
    rel.type,
    rel.reason,
    rel.direction,
    rel.sourceName,
    rel.targetName,
    rel.from,
    rel.to,
  ]
    .filter(Boolean)
    .join(' ');
}

function inferEdgeStyleFromText(text) {
  const value = normalizeText(text);

  if (!value) return EDGE_STYLES.UNKNOWN;

  if (/\bdashed\b/.test(value)) return EDGE_STYLES.DASHED;
  if (/\bdotted\b/.test(value)) return EDGE_STYLES.DOTTED;
  if (/\bsolid\b/.test(value)) return EDGE_STYLES.SOLID;
  if (/\bdouble\b/.test(value)) return EDGE_STYLES.DOUBLE_LINE;
  if (/\bthick\b/.test(value)) return EDGE_STYLES.THICK_LINE;
  if (/\bthin\b/.test(value)) return EDGE_STYLES.THIN_LINE;
  if (/\bbi-?directional\b|\btwo way\b|\btwo-way\b/.test(value)) {
    return EDGE_STYLES.BIDIRECTIONAL;
  }

  return EDGE_STYLES.UNKNOWN;
}

function inferEdgeLabel(rel = {}) {
  return cleanText(
    extractSemanticActionWindow(
      extractLocalizedEdgePhrase(rel)
    ) ||
      rel.label ||
      rel.edgeLabel ||
      rel.evidenceText ||
      rel.rawText ||
      rel.text ||
      rel.evidence ||
      ''
  );
}

function typeArchitectureRelationship(rel = {}, architectureEvidence = {}) {
  const relationshipText = collectRelationshipText(rel);
  const edgeLabel = inferEdgeLabel(rel);
  const edgeType = inferEdgeTypeFromText(
    [edgeLabel, relationshipText].filter(Boolean).join(' ')
  );
  const edgeStyle = inferEdgeStyleFromText(relationshipText);

  const confidence =
    edgeType !== 'unknown' || edgeStyle !== 'unknown'
      ? CONFIDENCE.MEDIUM
      : rel.confidence || CONFIDENCE.LOW;

  return {
    ...rel,
    edgeType,
    edgeLabel,
    edgeStyle,
    edgeTyping: {
      version: 'architecture-edge-typing-v1',
      source: 'architectureEdgeTyping',
      confidence,
      relationshipText,
      notes:
        edgeType === 'unknown'
          ? ['no_specific_edge_semantics_found']
          : ['typed_from_relationship_text'],
    },
  };
}

function typeArchitectureRelationships(relationships = [], architectureEvidence = {}) {
  if (!Array.isArray(relationships)) return [];

  return relationships.map((rel) =>
    typeArchitectureRelationship(rel, architectureEvidence)
  );
}

module.exports = {
  typeArchitectureRelationship,
  typeArchitectureRelationships,
  inferEdgeStyleFromText,
  collectRelationshipText,
  extractLocalizedEdgePhrase,
  extractSemanticActionWindow,
};
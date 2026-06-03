'use strict';

/**
 * BUG-22U.1A — Architecture Edge Typing
 *
 * Owns generic, domain-independent edge signal detection.
 *
 * This file detects/tags:
 * - edgeType
 * - edgeLabel
 * - lineStyle
 * - lineStyleConfidence
 * - lineStyleEvidence
 *
 * It does NOT interpret traversal meaning.
 * It does NOT select walkthrough paths.
 * It does NOT touch lesson graph, dialogue, or camera.
 */

const {
  CONFIDENCE,
  inferEdgeTypeFromText,
  normalizeText,
} = require('./architectureEvidenceTaxonomy');

const LINE_STYLES = Object.freeze({
  SOLID: 'solid_line',
  DOTTED: 'dotted_line',
  DASHED: 'dashed_line',
  DOUBLE: 'double_line',
  UNKNOWN: 'unknown_line_style',
});

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractLocalizedEdgePhrase(rel = {}) {
  const evidenceText = cleanText(
    rel.evidenceText || rel.rawText || rel.text || rel.evidence || ''
  );
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
  const semanticActionWindow = extractSemanticActionWindow(localizedPhrase);

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

function inferLineStyleFromText(text) {
  const value = normalizeText(text);
  const lineStyleEvidence = [];

  if (!value) {
    return {
      lineStyle: LINE_STYLES.UNKNOWN,
      lineStyleConfidence: CONFIDENCE.LOW,
      lineStyleEvidence,
    };
  }

  if (/\bdotted\b|\bdot[-\s]?line\b|\bdot[-\s]?dash\b/.test(value)) {
    lineStyleEvidence.push('relationship_text_contains_dotted');
    return {
      lineStyle: LINE_STYLES.DOTTED,
      lineStyleConfidence: CONFIDENCE.MEDIUM,
      lineStyleEvidence,
    };
  }

  if (/\bdashed\b|\bdash[-\s]?line\b/.test(value)) {
    lineStyleEvidence.push('relationship_text_contains_dashed');
    return {
      lineStyle: LINE_STYLES.DASHED,
      lineStyleConfidence: CONFIDENCE.MEDIUM,
      lineStyleEvidence,
    };
  }

  if (/\bdouble\b|\bdouble[-\s]?line\b|\btwo[-\s]?line\b/.test(value)) {
    lineStyleEvidence.push('relationship_text_contains_double_line');
    return {
      lineStyle: LINE_STYLES.DOUBLE,
      lineStyleConfidence: CONFIDENCE.MEDIUM,
      lineStyleEvidence,
    };
  }

  if (/\bsolid\b|\bsolid[-\s]?line\b/.test(value)) {
    lineStyleEvidence.push('relationship_text_contains_solid');
    return {
      lineStyle: LINE_STYLES.SOLID,
      lineStyleConfidence: CONFIDENCE.MEDIUM,
      lineStyleEvidence,
    };
  }

  return {
    lineStyle: LINE_STYLES.UNKNOWN,
    lineStyleConfidence: CONFIDENCE.LOW,
    lineStyleEvidence,
  };
}

/**
 * Backward-compatible wrapper.
 * Older downstream code may still read edgeStyle.
 */
function inferEdgeStyleFromText(text) {
  return inferLineStyleFromText(text).lineStyle;
}

function inferEdgeLabel(rel = {}) {
  return cleanText(
    extractSemanticActionWindow(extractLocalizedEdgePhrase(rel)) ||
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

  const {
    lineStyle,
    lineStyleConfidence,
    lineStyleEvidence,
  } = inferLineStyleFromText(relationshipText);

  const confidence =
    edgeType !== 'unknown' || lineStyle !== LINE_STYLES.UNKNOWN
      ? CONFIDENCE.MEDIUM
      : rel.confidence || CONFIDENCE.LOW;

  return {
    ...rel,
    edgeType,
    edgeLabel,

    // New 22U.1A line-style contract.
    lineStyle,
    lineStyleConfidence,
    lineStyleEvidence,

    // Backward compatibility for older consumers.
    edgeStyle: lineStyle,

    edgeTyping: {
      version: 'architecture-edge-typing-v2-enterprise-arrow-taxonomy',
      source: 'architectureEdgeTyping',
      confidence,
      relationshipText,
      lineStyle,
      lineStyleConfidence,
      lineStyleEvidence,
      notes:
        edgeType === 'unknown' && lineStyle === LINE_STYLES.UNKNOWN
          ? ['no_specific_edge_or_line_semantics_found']
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
  LINE_STYLES,
  typeArchitectureRelationship,
  typeArchitectureRelationships,
  inferLineStyleFromText,
  inferEdgeStyleFromText,
  collectRelationshipText,
  extractLocalizedEdgePhrase,
  extractSemanticActionWindow,
};
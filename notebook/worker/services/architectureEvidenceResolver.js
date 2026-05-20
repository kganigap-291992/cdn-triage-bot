'use strict';

/**
 * BUG-22C — Architecture Evidence Resolver
 *
 * Central deterministic resolver for term meaning.
 *
 * Rule:
 * 1. Document glossary first
 * 2. Legend / evidence records second
 * 3. Public standards allowed only for public terms
 * 4. Internal/private terms stay document-only
 * 5. If weak evidence, return structural fallback instead of guessing
 */

const {
  CONFIDENCE,
  normalizeText,
  isPublicStandardTerm,
  isLikelyInternalTerm,
  shouldAllowPublicEnrichment,
  shouldUseDocumentOnly,
} = require('./architectureEvidenceTaxonomy');

const VERSION = 'architecture-evidence-resolver-v1';

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function sameTerm(a, b) {
  return normalizeText(a) === normalizeText(b);
}

function includesTerm(text, term) {
  const t = normalizeText(text);
  const q = normalizeText(term);

  if (!t || !q) return false;

  return (
    t === q ||
    t.includes(q) ||
    new RegExp(`\\b${escapeRegExp(q)}\\b`, 'i').test(t)
  );
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function findGlossaryMatch(term, architectureEvidence = {}) {
  const glossaryTerms = asArray(architectureEvidence.glossaryTerms);

  return (
    glossaryTerms.find((entry) => sameTerm(entry.term, term)) ||
    glossaryTerms.find((entry) => includesTerm(entry.rawText, term)) ||
    glossaryTerms.find((entry) => includesTerm(entry.meaning, term))
  );
}

function findLegendMatch(term, architectureEvidence = {}) {
  const legendItems = asArray(architectureEvidence.legendItems);

  return legendItems.find((item) => includesTerm(item.rawText, term));
}

function findEvidenceRecordMatch(term, architectureEvidence = {}) {
  const evidenceRecords = asArray(architectureEvidence.evidenceRecords);

  return evidenceRecords.find((record) => includesTerm(record.rawText, term));
}

function findBoundaryMatch(term, architectureEvidence = {}) {
  const boundaryEvidence = asArray(architectureEvidence.boundaryEvidence);

  return boundaryEvidence.find((item) => includesTerm(item.rawText, term));
}

function findPublicTermMatch(term, architectureEvidence = {}) {
  const publicTerms = asArray(architectureEvidence.publicTerms);

  return publicTerms.find((item) => sameTerm(item.term, term));
}

function findInternalTermMatch(term, architectureEvidence = {}) {
  const internalTerms = asArray(architectureEvidence.internalTerms);

  return internalTerms.find((item) => sameTerm(item.term, term));
}

/**
 * Returns a deterministic meaning resolution.
 * It does NOT call the internet.
 * It only marks whether public enrichment is allowed later.
 */
function resolveTermMeaning(term, architectureEvidence = {}, options = {}) {
  const rawTerm = cleanText(term);

  if (!rawTerm) {
    return {
      version: VERSION,
      term: '',
      resolved: false,
      meaning: '',
      source: 'none',
      confidence: CONFIDENCE.UNKNOWN,
      allowPublicEnrichment: false,
      documentOnly: true,
      internalTerm: false,
      publicStandard: false,
      evidenceIds: [],
      notes: ['empty_term'],
    };
  }

  const publicStandard = isPublicStandardTerm(rawTerm);
  const internalTerm = isLikelyInternalTerm(rawTerm);

  const glossary = findGlossaryMatch(rawTerm, architectureEvidence);
  if (glossary) {
    return {
      version: VERSION,
      term: rawTerm,
      resolved: true,
      meaning: cleanText(glossary.meaning || glossary.rawText),
      source: 'glossary',
      confidence: glossary.confidence || CONFIDENCE.HIGH,
      allowPublicEnrichment: publicStandard,
      documentOnly: !publicStandard,
      internalTerm,
      publicStandard,
      evidenceIds: asArray(glossary.evidenceIds),
      rawEvidence: glossary.rawText || '',
      notes: ['resolved_from_document_glossary'],
    };
  }

  const legend = findLegendMatch(rawTerm, architectureEvidence);
  if (legend) {
    return {
      version: VERSION,
      term: rawTerm,
      resolved: true,
      meaning: cleanText(
        legend.inferredEdgeType && legend.inferredEdgeType !== 'unknown'
          ? legend.inferredEdgeType
          : legend.rawText
      ),
      source: 'legend',
      confidence: legend.confidence || CONFIDENCE.MEDIUM,
      allowPublicEnrichment: publicStandard,
      documentOnly: !publicStandard,
      internalTerm,
      publicStandard,
      evidenceIds: asArray(legend.evidenceIds),
      rawEvidence: legend.rawText || '',
      notes: ['resolved_from_diagram_legend'],
    };
  }

  const boundary = findBoundaryMatch(rawTerm, architectureEvidence);
  if (boundary) {
    return {
      version: VERSION,
      term: rawTerm,
      resolved: true,
      meaning: boundary.boundaryType || 'boundary_or_group',
      source: 'boundary_evidence',
      confidence: boundary.confidence || CONFIDENCE.MEDIUM,
      allowPublicEnrichment: publicStandard,
      documentOnly: !publicStandard,
      internalTerm,
      publicStandard,
      evidenceIds: asArray(boundary.evidenceIds),
      rawEvidence: boundary.rawText || '',
      notes: ['resolved_from_boundary_evidence'],
    };
  }

  const record = findEvidenceRecordMatch(rawTerm, architectureEvidence);
  if (record) {
    return {
      version: VERSION,
      term: rawTerm,
      resolved: true,
      meaning: record.normalizedType || record.rawText || '',
      source: record.source || 'evidence_record',
      confidence: record.confidence || CONFIDENCE.MEDIUM,
      allowPublicEnrichment: publicStandard,
      documentOnly: !publicStandard,
      internalTerm,
      publicStandard,
      evidenceIds: asArray(record.evidenceIds),
      rawEvidence: record.rawText || '',
      notes: ['resolved_from_evidence_record'],
    };
  }

  const publicTerm = findPublicTermMatch(rawTerm, architectureEvidence);
  if (publicTerm || publicStandard) {
    return {
      version: VERSION,
      term: rawTerm,
      resolved: false,
      meaning: '',
      source: 'public_standard_candidate',
      confidence: CONFIDENCE.MEDIUM,
      allowPublicEnrichment: true,
      documentOnly: false,
      internalTerm: false,
      publicStandard: true,
      evidenceIds: asArray(publicTerm?.evidenceIds),
      rawEvidence: '',
      notes: ['public_standard_enrichment_allowed_later'],
    };
  }

  const internal = findInternalTermMatch(rawTerm, architectureEvidence);
  if (internal || internalTerm) {
    return {
      version: VERSION,
      term: rawTerm,
      resolved: false,
      meaning: '',
      source: 'internal_term_candidate',
      confidence: internal?.confidence || CONFIDENCE.LOW,
      allowPublicEnrichment: false,
      documentOnly: true,
      internalTerm: true,
      publicStandard: false,
      evidenceIds: asArray(internal?.evidenceIds),
      rawEvidence: '',
      notes: ['internal_term_document_evidence_required'],
    };
  }

  return {
    version: VERSION,
    term: rawTerm,
    resolved: false,
    meaning: '',
    source: 'structural_fallback',
    confidence: CONFIDENCE.LOW,
    allowPublicEnrichment: shouldAllowPublicEnrichment(rawTerm),
    documentOnly: shouldUseDocumentOnly(rawTerm),
    internalTerm,
    publicStandard,
    evidenceIds: [],
    rawEvidence: '',
    notes: ['no_direct_meaning_found'],
  };
}

function resolveTerms(terms = [], architectureEvidence = {}, options = {}) {
  return asArray(terms).map((term) =>
    resolveTermMeaning(term, architectureEvidence, options)
  );
}

function buildTermResolutions(architectureEvidence = {}, options = {}) {
  const terms = new Set();

  for (const item of asArray(architectureEvidence.glossaryTerms)) {
    if (item.term) terms.add(item.term);
  }

  for (const item of asArray(architectureEvidence.publicTerms)) {
    if (item.term) terms.add(item.term);
  }

  for (const item of asArray(architectureEvidence.internalTerms)) {
    if (item.term) terms.add(item.term);
  }

  for (const item of asArray(architectureEvidence.boundaryEvidence)) {
    if (item.rawText) terms.add(item.rawText);
  }

  for (const item of asArray(architectureEvidence.legendItems)) {
    if (item.rawText) terms.add(item.rawText);
  }

  const resolutions = Array.from(terms)
    .map((term) => resolveTermMeaning(term, architectureEvidence, options))
    .sort((a, b) => {
      if (a.resolved !== b.resolved) return a.resolved ? -1 : 1;
      return a.term.localeCompare(b.term);
    });

  return {
    version: 'architecture-term-resolutions-v1',
    generatedAt: new Date().toISOString(),
    stats: {
      termCount: resolutions.length,
      resolvedCount: resolutions.filter((x) => x.resolved).length,
      unresolvedCount: resolutions.filter((x) => !x.resolved).length,
      publicEnrichmentAllowedCount: resolutions.filter(
        (x) => x.allowPublicEnrichment
      ).length,
      documentOnlyCount: resolutions.filter((x) => x.documentOnly).length,
      internalTermCount: resolutions.filter((x) => x.internalTerm).length,
      publicStandardCount: resolutions.filter((x) => x.publicStandard).length,
    },
    resolutions,
  };
}

module.exports = {
  VERSION,
  resolveTermMeaning,
  resolveTerms,
  buildTermResolutions,

  findGlossaryMatch,
  findLegendMatch,
  findBoundaryMatch,
  findEvidenceRecordMatch,
  findPublicTermMatch,
  findInternalTermMatch,
};
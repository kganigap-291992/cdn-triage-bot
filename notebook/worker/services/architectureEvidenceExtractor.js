'use strict';

/**
 * BUG-22B — Architecture Evidence Extractor
 *
 * Extracts glossary, legend, boundary, public-term, and internal-term evidence
 * from the uploaded document artifacts.
 *
 * Rule:
 * Document says what exists.
 * Internet explains public standards later.
 * LLM connects the two later.
 */

const {
  CONFIDENCE,
  EVIDENCE_SOURCES,
  inferEdgeTypeFromText,
  inferBoundaryTypeFromText,
  isPublicStandardTerm,
  isLikelyInternalTerm,
  makeEvidenceRecord,
  normalizeText,
} = require('./architectureEvidenceTaxonomy');

const VERSION = 'architecture-evidence-v1';

const INTERNAL_TERM_STOPWORDS = new Set([
  'generic',
  'distributed',
  'architecture',
  'flow',
  'user',
  'client',
  'edge',
  'gateway',
  'auth',
  'service',
  'routing',
  'layer',
  'application',
  'cluster',
  'database',
  'primary',
  'request',
  'operational',
  'notes',
  'system',
  'systems',
  'platform',
  'config',
  'configuration',
  'metrics',
  'logs',
  'control',
  'processing',
  'worker',
  'storage',
  'network',
  'region',
  'zone',
  'environment',
  'pipeline',
  'api',
  'cdn',
]);

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function splitBoundaryText(text = '') {
  const value = cleanText(text);

  if (!value) return [];

  const parts = new Set();

  const boundaryKeywordMatches =
    value.match(
      /\b(Cluster|Layer|Region|Environment|Zone|Group|Plane|Network|Gateway)\b/g
    ) || [];

  const boundaryKeywordCount = boundaryKeywordMatches.length;

  const looksCompound =
    boundaryKeywordCount >= 2 ||
    /\bLayer\s+Application\s+Cluster\b/i.test(value);

  if (value.length <= 40 && boundaryKeywordCount <= 1 && !looksCompound) {
    parts.add(value);
  }

  const separators = [
    /\s+\|\s+/,
    /\s+\/\s+/,
    /\s+>\s+/,
    /\s+→\s+/,
    /\s+-\s+/,
    /\s{2,}/,
    /,/,
  ];

  for (const separator of separators) {
    const pieces = value.split(separator);

    if (pieces.length <= 1) continue;

    for (const piece of pieces) {
      const cleanPiece = cleanText(piece);

      if (cleanPiece && cleanPiece.length >= 4 && cleanPiece.length <= 80) {
        parts.add(cleanPiece);
      }
    }
  }

  const boundaryPattern =
    /\b([A-Z][a-z0-9]+(?:\s+[A-Z][a-z0-9]+){0,1}\s+(?:Cluster|Layer|Region|Environment|Zone|Group|Plane|Network|Gateway))\b/g;

  const semanticCandidates = value.match(boundaryPattern) || [];

  for (const candidate of semanticCandidates) {
    const cleanCandidate = cleanText(candidate);

    if (!cleanCandidate || cleanCandidate === value) continue;

    parts.add(cleanCandidate);
  }

  return Array.from(parts).filter(Boolean);
}

function uniqBy(items, keyFn) {
  const seen = new Set();
  const out = [];

  for (const item of items) {
    const key = keyFn(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }

  return out;
}

function collectTextChunks(input = {}) {
  const chunks = [];

  function push(text, meta = {}) {
    const value = cleanText(text);
    if (!value) return;

    chunks.push({
      text: value,
      page: meta.page ?? null,
      source: meta.source || 'unknown',
      evidenceId:
        meta.evidenceId ||
        `${meta.source || 'text'}:${meta.page ?? 'na'}:${chunks.length}`,
    });
  }

  const extracted = input.extracted || input.extractedText || {};
  const documentUnderstanding = input.documentUnderstanding || {};
  const documentStructure = input.documentStructure || {};
  const spatialUnderstanding = input.spatialUnderstanding || {};

  if (typeof extracted === 'string') {
    push(extracted, { source: 'extracted_text' });
  }

  for (const page of asArray(extracted.pages)) {
    push(page.text || page.content || '', {
      page: page.page ?? page.pageNumber ?? null,
      source: 'extracted_page',
    });

    for (const line of asArray(page.lines)) {
      push(line.text || line.content || '', {
        page: page.page ?? page.pageNumber ?? line.page ?? null,
        source: 'extracted_line',
      });
    }
  }

  for (const line of asArray(extracted.lines)) {
    push(line.text || line.content || line, {
      page: line.page ?? null,
      source: 'extracted_line',
    });
  }

  for (const section of asArray(documentStructure.sections)) {
    push(section.title || section.heading || '', {
      page: section.page ?? null,
      source: 'section_heading',
    });
    push(section.text || section.content || '', {
      page: section.page ?? null,
      source: 'section_text',
    });
  }

  for (const entity of asArray(documentUnderstanding.entities)) {
    push(entity.name || entity.label || entity.text || '', {
      page: entity.page ?? null,
      source: 'document_entity',
      evidenceId: entity.id || entity.evidenceId,
    });
  }

  for (const rel of asArray(documentUnderstanding.relationships)) {
    push(
      [
        rel.from,
        rel.to,
        rel.label,
        rel.type,
        rel.rawText,
        rel.text,
        rel.evidence,
      ]
        .filter(Boolean)
        .join(' '),
      {
        page: rel.page ?? null,
        source: 'document_relationship',
        evidenceId: rel.id || rel.evidenceId,
      }
    );
  }

  for (const seq of asArray(documentUnderstanding.sequences)) {
    push(seq.text || seq.rawText || seq.description || '', {
      page: seq.page ?? null,
      source: 'document_sequence',
      evidenceId: seq.id || seq.evidenceId,
    });

    for (const step of asArray(seq.steps)) {
      push(step.text || step.label || step.description || step, {
        page: step.page ?? seq.page ?? null,
        source: 'numbered_step',
        evidenceId: step.id || step.evidenceId,
      });
    }
  }

  for (const label of asArray(spatialUnderstanding.labels)) {
    push(label.text || label.label || '', {
      page: label.page ?? null,
      source: 'spatial_label',
      evidenceId: label.id || label.evidenceId,
    });
  }

  for (const region of asArray(spatialUnderstanding.regions)) {
    push(region.label || region.text || region.title || '', {
      page: region.page ?? null,
      source: 'spatial_region',
      evidenceId: region.id || region.evidenceId,
    });
  }

  return chunks;
}

function looksLikeGlossaryLine(text) {
  const t = cleanText(text);

  if (!t || t.length > 260) return false;

  return (
    /^[A-Za-z0-9_.+/#-]{2,40}\s*(=|:|-|–|—)\s*.{3,}$/.test(t) ||
    /^[A-Za-z0-9_.+/#-]{2,40}\s+\(([^)]{3,120})\)/.test(t) ||
    /\b(glossary|acronym|definition|stands for|means|refers to)\b/i.test(t)
  );
}

function parseGlossaryLine(chunk) {
  const text = cleanText(chunk.text);

  let match =
    text.match(/^([A-Za-z0-9_.+/#-]{2,40})\s*(=|:|-|–|—)\s*(.{3,220})$/) ||
    text.match(/^([A-Za-z0-9_.+/#-]{2,40})\s+\(([^)]{3,160})\)/);

  if (!match) {
    const meansMatch = text.match(
      /\b([A-Za-z0-9_.+/#-]{2,40})\b\s+(means|refers to|stands for)\s+(.{3,220})/i
    );
    if (meansMatch) {
      match = [meansMatch[0], meansMatch[1], meansMatch[2], meansMatch[3]];
    }
  }

  if (!match) return null;

  const term = cleanText(match[1]);
  const meaning = cleanText(match[3] || match[2]);

  if (!term || !meaning || term.length > 50 || meaning.length < 3) return null;

  return {
    term,
    meaning,
    source: EVIDENCE_SOURCES.GLOSSARY,
    confidence: CONFIDENCE.HIGH,
    page: chunk.page,
    evidenceIds: [chunk.evidenceId],
    rawText: text,
    publicStandard: isPublicStandardTerm(term),
    internalTerm: isLikelyInternalTerm(term),
  };
}

function looksLikeLegendLine(text) {
  const t = normalizeText(text);

  if (!t || t.length > 260) return false;

  return (
    /\b(legend|solid|dashed|dotted|line|arrow|color|blue|red|green|black)\b/.test(t) &&
    /\b(means|represents|indicates|=|:|-|–|—)\b/.test(t)
  );
}

function parseLegendLine(chunk) {
  const text = cleanText(chunk.text);
  const lower = normalizeText(text);

  if (!looksLikeLegendLine(text)) return null;

  let visualStyle = 'unknown';

  if (/\bdashed\b/.test(lower)) visualStyle = 'dashed';
  else if (/\bdotted\b/.test(lower)) visualStyle = 'dotted';
  else if (/\bsolid\b/.test(lower)) visualStyle = 'solid';
  else if (/\bdouble\b/.test(lower)) visualStyle = 'double_line';
  else if (/\bthick\b/.test(lower)) visualStyle = 'thick_line';
  else if (/\bthin\b/.test(lower)) visualStyle = 'thin_line';
  else if (/\barrow\b/.test(lower)) visualStyle = 'arrow';

  const inferredEdgeType = inferEdgeTypeFromText(text);

  return {
    rawText: text,
    visualStyle,
    inferredEdgeType,
    source: EVIDENCE_SOURCES.LEGEND,
    confidence:
      inferredEdgeType === 'unknown' ? CONFIDENCE.MEDIUM : CONFIDENCE.HIGH,
    page: chunk.page,
    evidenceIds: [chunk.evidenceId],
  };
}

function extractBoundaryEvidence(chunks) {
  const out = [];

  for (const chunk of chunks) {
    const text = cleanText(chunk.text);

    if (!text || text.length > 180) {
      continue;
    }

    // IMPORTANT:
    // only classify extracted candidates,
    // never the entire raw heading.

    const candidates = splitBoundaryText(text);

    for (const candidate of candidates) {
      const boundaryType =
        inferBoundaryTypeFromText(candidate);

      if (boundaryType === 'unknown') {
        continue;
      }

      out.push({
        rawText: candidate,
        boundaryType,
        source:
          chunk.source === 'spatial_region'
            ? EVIDENCE_SOURCES.GROUP_BOX_LABEL
            : EVIDENCE_SOURCES.EXPLICIT_TEXT,
        confidence:
          chunk.source === 'spatial_region'
            ? CONFIDENCE.HIGH
            : CONFIDENCE.MEDIUM,
        page: chunk.page,
        evidenceIds: [chunk.evidenceId],
      });
    }
  }

  return uniqBy(
    out,
    (x) =>
      `${x.boundaryType}:${normalizeText(x.rawText)}`
  );
}

function extractPublicTerms(chunks) {
  const candidates = new Map();

  for (const chunk of chunks) {
    const words = cleanText(chunk.text).match(/[A-Za-z0-9_.+#-]{2,40}/g) || [];

    for (const word of words) {
      if (!isPublicStandardTerm(word)) continue;

      const key = normalizeText(word);
      if (!candidates.has(key)) {
        candidates.set(key, {
          term: word,
          source: 'public_standard_candidate',
          confidence: CONFIDENCE.MEDIUM,
          pages: [],
          evidenceIds: [],
        });
      }

      const item = candidates.get(key);
      if (chunk.page !== null && !item.pages.includes(chunk.page)) {
        item.pages.push(chunk.page);
      }
      item.evidenceIds.push(chunk.evidenceId);
    }
  }

  return Array.from(candidates.values()).map((item) => ({
    ...item,
    evidenceIds: Array.from(new Set(item.evidenceIds)).slice(0, 10),
  }));
}

function extractInternalTerms(chunks) {
  const candidates = new Map();

  for (const chunk of chunks) {
    const words = cleanText(chunk.text).match(/[A-Za-z][A-Za-z0-9_.+#-]{1,40}/g) || [];

    for (const word of words) {
      if (!isLikelyInternalTerm(word)) continue;

      const key = normalizeText(word);
      if (!candidates.has(key)) {
        candidates.set(key, {
          term: word,
          source: 'internal_term_candidate',
          confidence: CONFIDENCE.LOW,
          pages: [],
          evidenceIds: [],
        });
      }

      const item = candidates.get(key);
      if (chunk.page !== null && !item.pages.includes(chunk.page)) {
        item.pages.push(chunk.page);
      }
      item.evidenceIds.push(chunk.evidenceId);
    }
  }

  return Array.from(candidates.values())
    .map((item) => ({
      ...item,
      evidenceIds: Array.from(new Set(item.evidenceIds)).slice(0, 10),
    }))
    .filter((item) => {
      if (item.evidenceIds.length < 1) return false;

      const normalized = normalizeText(item.term);

        if (INTERNAL_TERM_STOPWORDS.has(normalized)) {
        return false;
        }

        if (
        [
            'http',
            'https',    
            'dns',
            'api',
            'cdn',
            'prod',
            'dev',
            'test',
            'qa'
            ].includes(normalized)
        ) {
            return false;
        }

        return true;
     });
}

function extractGlossaryTerms(chunks) {
  return uniqBy(
    chunks
      .filter((chunk) => looksLikeGlossaryLine(chunk.text))
      .map(parseGlossaryLine)
      .filter(Boolean),
    (x) => normalizeText(x.term)
  );
}

function extractLegendItems(chunks) {
  return uniqBy(
    chunks.map(parseLegendLine).filter(Boolean),
    (x) => `${x.visualStyle}:${x.inferredEdgeType}:${normalizeText(x.rawText)}`
  );
}

function buildArchitectureEvidence(input = {}) {
  const chunks = collectTextChunks(input);

  const glossaryTerms = extractGlossaryTerms(chunks);
  const legendItems = extractLegendItems(chunks);
  const boundaryEvidence = extractBoundaryEvidence(chunks);
  const publicTerms = extractPublicTerms(chunks);
  const internalTerms = extractInternalTerms(chunks);

  const evidenceRecords = [
    ...glossaryTerms.map((item) =>
      makeEvidenceRecord({
        rawText: `${item.term}: ${item.meaning}`,
        normalizedType: item.publicStandard
          ? 'public_standard_definition'
          : 'document_definition',
        source: item.source,
        confidence: item.confidence,
        evidenceIds: item.evidenceIds,
      })
    ),
    ...legendItems.map((item) =>
      makeEvidenceRecord({
        rawText: item.rawText,
        normalizedType: item.inferredEdgeType,
        source: item.source,
        confidence: item.confidence,
        evidenceIds: item.evidenceIds,
      })
    ),
    ...boundaryEvidence.map((item) =>
      makeEvidenceRecord({
        rawText: item.rawText,
        normalizedType: item.boundaryType,
        source: item.source,
        confidence: item.confidence,
        evidenceIds: item.evidenceIds,
      })
    ),
  ];

  return {
    version: VERSION,
    generatedAt: new Date().toISOString(),
    stats: {
      textChunkCount: chunks.length,
      glossaryTermCount: glossaryTerms.length,
      legendItemCount: legendItems.length,
      boundaryEvidenceCount: boundaryEvidence.length,
      publicTermCount: publicTerms.length,
      internalTermCount: internalTerms.length,
      evidenceRecordCount: evidenceRecords.length,
    },
    glossaryTerms,
    legendItems,
    boundaryEvidence,
    publicTerms,
    internalTerms,
    evidenceRecords,
  };
}

module.exports = {
  VERSION,
  buildArchitectureEvidence,
  collectTextChunks,
  extractGlossaryTerms,
  extractLegendItems,
  extractBoundaryEvidence,
  extractPublicTerms,
  extractInternalTerms,
};
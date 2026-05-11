// notebook/worker/services/sourceGroundingBuilder.js

/**
 * Phase 8C.3C — Source Grounding Engine
 *
 * Goal:
 * - Ground concepts / commands back to the uploaded document.
 * - Provide sourcePages and approximate focusRegion for teaching units.
 * - Avoid hardcoded page assumptions.
 *
 * Borrowed ideas adapted for Cachey:
 * - Docling: document blocks / page-aware structure.
 * - LlamaIndex: semantic matching between concepts and source text.
 * - tldraw: focus bounds become camera/focus intent later.
 * - PaddleOCR: future exact coordinates; v1 uses text/page heuristics.
 */

function safeString(value) {
  return String(value || "").trim();
}

function safeLower(value) {
  return safeString(value).toLowerCase();
}

function uniq(values) {
  return Array.from(
    new Set(
      values
        .map((value) => safeString(value))
        .filter(Boolean)
    )
  );
}

function normalizeText(value) {
  return safeLower(value)
    .replace(/[`"'()[\]{}<>]/g, " ")
    .replace(/[^a-z0-9./:_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getPageCount({ extractedData = {}, diagramAnalysis = {}, pageImageCount = 0 } = {}) {
  if (pageImageCount > 0) return pageImageCount;

  if (Array.isArray(extractedData.pages)) return extractedData.pages.length;
  if (Array.isArray(extractedData.pageTexts)) return extractedData.pageTexts.length;

  if (Array.isArray(diagramAnalysis.pages)) return diagramAnalysis.pages.length;
  if (Array.isArray(diagramAnalysis.pageAnalyses)) return diagramAnalysis.pageAnalyses.length;

  return Number(diagramAnalysis.pageCount || extractedData.pageCount || 0);
}

function extractPageTexts(extractedData = {}) {
  if (Array.isArray(extractedData.pages)) {
    return extractedData.pages
      .map((page, index) => ({
        page: Number(page.page || page.pageNumber || index + 1),
        text: safeString(
          page.text ||
            page.content ||
            page.markdown ||
            page.rawText ||
            ""
        ),
      }))
      .filter((item) => item.text);
  }

  if (Array.isArray(extractedData.pageTexts)) {
    return extractedData.pageTexts
      .map((page, index) => {
        if (typeof page === "string") {
          return {
            page: index + 1,
            text: page,
          };
        }

        return {
          page: Number(page.page || page.pageNumber || index + 1),
          text: safeString(page.text || page.content || ""),
        };
      })
      .filter((item) => item.text);
  }

  const fullText = safeString(
    extractedData.text ||
      extractedData.fullText ||
      extractedData.content ||
      extractedData.markdown ||
      ""
  );

  if (fullText) {
    return [
      {
        page: 1,
        text: fullText,
      },
    ];
  }

  return [];
}

function getConceptSearchTerms(unit = {}) {
  const terms = [
    unit.title,
    unit.metadata?.topicTitle,
    unit.metadata?.summary,
    ...(Array.isArray(unit.concepts) ? unit.concepts : []),
    ...(Array.isArray(unit.visibleElements) ? unit.visibleElements : []),
    ...(Array.isArray(unit.metadata?.commandDetails)
      ? unit.metadata.commandDetails.flatMap((item) => [
          item.command,
          item.meaning,
          item.whenToUse,
          item.debuggingSignal,
        ])
      : []),
  ];

  return uniq(terms)
    .map(normalizeText)
    .filter((term) => term.length >= 3);
}

function scorePageForTerms(pageText, terms) {
  const normalizedPage = normalizeText(pageText);
  if (!normalizedPage) return 0;

  let score = 0;

  for (const term of terms) {
    if (!term) continue;

    if (normalizedPage.includes(term)) {
      score += Math.min(12, Math.max(4, Math.floor(term.length / 8)));
      continue;
    }

    const words = term
      .split(/\s+/)
      .map((word) => word.trim())
      .filter((word) => word.length >= 3);

    for (const word of words) {
      if (normalizedPage.includes(word)) {
        score += 1;
      }
    }
  }

  return score;
}

function findBestPageForUnit(unit, pageTexts) {
  const terms = getConceptSearchTerms(unit);

  if (!terms.length || !pageTexts.length) {
    return {
      page: null,
      confidence: 0,
      matchedTerms: [],
    };
  }

  const scored = pageTexts
    .map((pageItem) => ({
      page: pageItem.page,
      score: scorePageForTerms(pageItem.text, terms),
      text: pageItem.text,
    }))
    .sort((a, b) => b.score - a.score);

  const best = scored[0];

  if (!best || best.score <= 0) {
    return {
      page: null,
      confidence: 0,
      matchedTerms: [],
    };
  }

  const normalizedBestText = normalizeText(best.text);
  const matchedTerms = terms
    .filter((term) => normalizedBestText.includes(term))
    .slice(0, 8);

  const confidence = Math.min(0.95, Math.max(0.35, best.score / 30));

  return {
    page: best.page,
    confidence,
    matchedTerms,
  };
}

function inferVerticalBandFromText({ unit = {}, pageText = "" } = {}) {
  const normalizedPage = normalizeText(pageText);
  const terms = getConceptSearchTerms(unit);

  if (!normalizedPage || !terms.length) {
    return {
      y: 0.16,
      height: 0.68,
      confidence: "low",
    };
  }

  let bestIndex = -1;
  let bestTerm = "";

  for (const term of terms) {
    const index = normalizedPage.indexOf(term);
    if (index >= 0 && (bestIndex === -1 || index < bestIndex)) {
      bestIndex = index;
      bestTerm = term;
    }
  }

  if (bestIndex < 0) {
    return {
      y: 0.16,
      height: 0.68,
      confidence: "low",
    };
  }

  const ratio = bestIndex / Math.max(1, normalizedPage.length);

  const y = Math.max(0.06, Math.min(0.78, ratio * 0.86));
  const height =
    bestTerm.length > 40 || unit.visibleElements?.length >= 3
      ? 0.28
      : 0.22;

  return {
    y,
    height,
    confidence: "medium",
  };
}

function buildGroundedFocusRegion({ unit, pageText, fallbackFocusRegion }) {
  const band = inferVerticalBandFromText({ unit, pageText });

  return {
    type: "semantic_band",
    source: "sourceGroundingBuilder",
    confidence: band.confidence,
    label:
      unit.focusHint?.label ||
      unit.title ||
      fallbackFocusRegion?.label ||
      "Relevant document area",
    x: fallbackFocusRegion?.x ?? 0.06,
    y: band.y,
    width: fallbackFocusRegion?.width ?? 0.88,
    height: band.height,
  };
}

function groundTeachingUnit(unit, pageTexts) {
  const existingSourcePages = Array.isArray(unit.sourcePages)
    ? unit.sourcePages.filter(Boolean)
    : [];

  const pageMatch = findBestPageForUnit(unit, pageTexts);

  const groundedPage =
    existingSourcePages[0] ||
    pageMatch.page ||
    null;

  const pageText =
    pageTexts.find((item) => item.page === groundedPage)?.text ||
    pageTexts[0]?.text ||
    "";

  const fallbackFocusRegion =
    unit.focusHint?.focusRegion ||
    null;

  const focusRegion = buildGroundedFocusRegion({
    unit,
    pageText,
    fallbackFocusRegion,
  });

  const sourcePages = groundedPage ? [groundedPage] : existingSourcePages;

  return {
    ...unit,
    sourcePages,
    focusHint: unit.focusHint
      ? {
          ...unit.focusHint,
          sourcePages,
          sourceGrounding: {
            version: "source-grounding-v1",
            source: "sourceGroundingBuilder",
            page: groundedPage,
            confidence: pageMatch.confidence,
            matchedTerms: pageMatch.matchedTerms,
          },
          focusRegion: {
            ...focusRegion,
            page: groundedPage,
          },
        }
      : unit.focusHint,
    metadata: {
      ...(unit.metadata || {}),
      sourceGrounding: {
        version: "source-grounding-v1",
        page: groundedPage,
        confidence: pageMatch.confidence,
        matchedTerms: pageMatch.matchedTerms,
      },
    },
  };
}

function buildSourceGrounding({
  teachingUnits = [],
  extractedData = {},
  diagramAnalysis = {},
  pageImageCount = 0,
} = {}) {
  const pageTexts = extractPageTexts(extractedData);
  const pageCount = getPageCount({
    extractedData,
    diagramAnalysis,
    pageImageCount,
  });

  const groundedTeachingUnits = teachingUnits.map((unit) =>
    groundTeachingUnit(unit, pageTexts)
  );

  return {
    version: "source-grounding-v1",
    source: "sourceGroundingBuilder",
    pageCount,
    pageTextCount: pageTexts.length,
    groundedUnitCount: groundedTeachingUnits.filter(
      (unit) => Array.isArray(unit.sourcePages) && unit.sourcePages.length > 0
    ).length,
    teachingUnits: groundedTeachingUnits,
  };
}

module.exports = {
  buildSourceGrounding,
};
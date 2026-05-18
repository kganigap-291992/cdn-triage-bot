// notebook/worker/services/sourceGroundingBuilder.js


const fs = require("fs");
const path = require("path");

const SOURCE_GROUNDING_VERSION = "source-grounding-v2-lite";

const {
  buildLayoutBoxes,
  buildLayoutBoxesFromExtractedData,
} = require("./layoutBoxBuilder");

const DEFAULT_FOCUS_X = 0.06;
const DEFAULT_FOCUS_WIDTH = 0.88;

const PAGE_TOP_SAFE_Y = 0.055;
const PAGE_BOTTOM_SAFE_Y = 0.94;

const LOW_CONFIDENCE_REGION = {
  y: 0.14,
  height: 0.58,
};

const TIGHT_SECTION_HEIGHT = 0.155;
const MEDIUM_SECTION_HEIGHT = 0.185;
const EXPANDED_SECTION_HEIGHT = 0.22;

const MIN_FOCUS_HEIGHT = 0.11;
const MAX_FOCUS_HEIGHT = 0.3;

const SECTION_BOUNDARY_GAP = 0.018;

const BANNED_FOCUS_TERMS = [
  "confidential",
  "copyright",
  "page",
  "proprietary",
  "unauthorized disclosure",
  "strictly prohibited",
  "all rights reserved",
  "do not distribute",
  "estimate for",
  "hour estimate",
];

function isBannedFocusText(value) {
  const text = normalizeText(value);
  if (!text) return false;

  const bannedTerms = BANNED_FOCUS_TERMS.map(normalizeText);

  return bannedTerms.some((term) => text.includes(term));
}

function safeString(value) {
  return String(value || "").trim();
}

function safeLower(value) {
  return safeString(value).toLowerCase();
}

function readSpatialEntityGrounding(jobDir) {
  if (!jobDir) {
    return {
      bestCandidates: {},
    };
  }

  const artifactPath = path.join(
    jobDir,
    "spatial-entity-grounding.json"
  );

  try {
    if (!fs.existsSync(artifactPath)) {
      return {
        bestCandidates: {},
      };
    }

    const parsed = JSON.parse(
      fs.readFileSync(artifactPath, "utf8")
    );

    return {
      ...(parsed || {}),
      bestCandidates: parsed?.bestCandidates || {},
    };
  } catch (error) {
    return {
      bestCandidates: {},
      readError: error.message,
    };
  }
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

function clampNumber(value, min, max) {
  const number = Number(value);

  if (!Number.isFinite(number)) return min;

  return Math.min(max, Math.max(min, number));
}

function normalizeText(value) {
  return safeLower(value)
    .replace(/[`"'()[\]{}<>]/g, " ")
    .replace(/[^a-z0-9./:_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeLine(value) {
  return safeString(value)
    .replace(/\s+/g, " ")
    .trim();
}

function getUnitSceneType(unit = {}) {
  return safeString(
    unit.sceneType ||
      unit.metadata?.sceneType ||
      unit.metadata?.architectureSceneType ||
      ""
  );
}

function getUnitPresentationStyle(unit = {}) {
  return safeString(
    unit.presentationStyle ||
      unit.metadata?.presentationStyle ||
      unit.visualIntent?.presentationStyle ||
      ""
  );
}

function shouldUseBroadVisualRegion(unit = {}) {
  const sceneType = safeLower(getUnitSceneType(unit));
  const presentationStyle = safeLower(getUnitPresentationStyle(unit));
  const title = safeLower(unit.title);
  const label = safeLower(unit.focusHint?.label);
  const intent = safeLower(unit.visualIntent?.intent || unit.sceneIntent || "");

  return (
    sceneType.includes("architecture_overview") ||
    sceneType.includes("overview") ||
    sceneType.includes("recap") ||
    presentationStyle.includes("architecture_full_diagram") ||
    title.includes("architecture overview") ||
    title.includes("recap") ||
    label.includes("architecture overview") ||
    label.includes("recap") ||
    intent.includes("show_full_architecture_diagram") ||
    intent.includes("recap")
  );
}

function isRecapLikeUnit(unit = {}) {
  const sceneType = getUnitSceneType(unit);
  const title = safeLower(unit.title);

  return (
    sceneType === "recap" ||
    title.includes("recap") ||
    title.includes("summary") ||
    title.includes("takeaway")
  );
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
    unit.focusHint?.label,
    unit.focusHint?.target,
    unit.focusHint?.reference,
    unit.visualIntent?.focus,
    unit.visualIntent?.reference,
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

function getRawSearchTerms(unit = {}) {
  const terms = [
    unit.title,
    unit.metadata?.topicTitle,
    unit.focusHint?.label,
    unit.focusHint?.target,
    unit.focusHint?.reference,
    unit.visualIntent?.focus,
    unit.visualIntent?.reference,
    ...(Array.isArray(unit.concepts) ? unit.concepts : []),
    ...(Array.isArray(unit.visibleElements) ? unit.visibleElements : []),
  ];

  return uniq(terms)
    .map(normalizeLine)
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

function looksLikeHeading(line) {
  const text = normalizeLine(line);
  if (!text) return false;

  if (/^#{1,6}\s+/.test(text)) return true;
  if (/^\d+(\.\d+)*[.)]?\s+[A-Z0-9]/.test(text)) return true;
  if (/^[A-Z][A-Za-z0-9 /:_-]{2,70}$/.test(text) && !/[.!?]$/.test(text)) {
    return true;
  }

  const words = text.split(/\s+/).filter(Boolean);

  if (words.length >= 1 && words.length <= 7) {
    const titleishWords = words.filter((word) => /^[A-Z0-9][A-Za-z0-9/_:-]*$/.test(word));
    return titleishWords.length / words.length >= 0.65 && !/[.!?]$/.test(text);
  }

  return false;
}

function buildLineIndex(pageText = "") {
  const rawText = safeString(pageText);
  const lines = rawText.split(/\r?\n/);

  let cursor = 0;

  const indexedLines = lines.map((line, index) => {
    const original = line;
    const normalized = normalizeText(line);
    const start = cursor;
    const end = cursor + line.length;

    cursor = end + 1;

    return {
      index,
      original,
      normalized,
      start,
      end,
      isHeading: looksLikeHeading(original),
    };
  });

  return {
    rawText,
    lines: indexedLines,
    length: Math.max(1, rawText.length),
  };
}

function findBestLineMatch({ unit = {}, pageText = "" } = {}) {
  const lineIndex = buildLineIndex(pageText);
  const terms = getConceptSearchTerms(unit);
  const rawTerms = getRawSearchTerms(unit);

  if (!lineIndex.rawText || !terms.length) {
    return {
      lineIndex,
      line: null,
      term: "",
      score: 0,
      exactHeadingMatch: false,
    };
  }

  let best = null;

  for (const line of lineIndex.lines) {
    if (!line.normalized) continue;
    if (isBannedFocusText(line.original)) continue;

    let score = 0;
    let bestTerm = "";

    for (const term of terms) {
      if (!term) continue;

      if (line.normalized.includes(term)) {
        score += line.isHeading ? 20 : 12;
        score += Math.min(8, Math.floor(term.length / 10));
        bestTerm = term;
        continue;
      }

      const words = term
        .split(/\s+/)
        .map((word) => word.trim())
        .filter((word) => word.length >= 3);

      for (const word of words) {
        if (line.normalized.includes(word)) {
          score += line.isHeading ? 3 : 1;
          bestTerm = bestTerm || word;
        }
      }
    }

    for (const rawTerm of rawTerms) {
      if (
        line.isHeading &&
        normalizeText(line.original) === normalizeText(rawTerm)
      ) {
        score += 18;
        bestTerm = normalizeText(rawTerm);
      }
    }

    if (!best || score > best.score) {
      best = {
        line,
        term: bestTerm,
        score,
        exactHeadingMatch:
          line.isHeading &&
          rawTerms.some(
            (rawTerm) => normalizeText(rawTerm) === normalizeText(line.original)
          ),
      };
    }
  }

  if (!best || best.score <= 0) {
    return {
      lineIndex,
      line: null,
      term: "",
      score: 0,
      exactHeadingMatch: false,
    };
  }

  return {
    lineIndex,
    line: best.line,
    term: best.term,
    score: best.score,
    exactHeadingMatch: best.exactHeadingMatch,
  };
}


function findNearestHeadingBefore(lineIndex, lineNumber) {
  for (let index = lineNumber; index >= 0; index -= 1) {
    const line = lineIndex.lines[index];
    if (line?.isHeading && line.normalized) {
      return line;
    }
  }

  return null;
}

function findNextHeadingAfter(lineIndex, lineNumber) {
  for (let index = lineNumber + 1; index < lineIndex.lines.length; index += 1) {
    const line = lineIndex.lines[index];
    if (line?.isHeading && line.normalized) {
      return line;
    }
  }

  return null;
}

function textOffsetToY(offset, textLength) {
  const ratio = clampNumber(offset / Math.max(1, textLength), 0, 1);

  return clampNumber(PAGE_TOP_SAFE_Y + ratio * 0.86, PAGE_TOP_SAFE_Y, 0.86);
}

function pickBandHeight({ unit = {}, match = {}, sectionSpan = null } = {}) {
  const visibleElementCount = Array.isArray(unit.visibleElements)
    ? unit.visibleElements.length
    : 0;

  const hasCommandDetails =
    Array.isArray(unit.metadata?.commandDetails) &&
    unit.metadata.commandDetails.length > 0;

  let height = TIGHT_SECTION_HEIGHT;

  if (visibleElementCount >= 4 || hasCommandDetails) {
    height = EXPANDED_SECTION_HEIGHT;
  } else if (visibleElementCount >= 2 || match.score < 12) {
    height = MEDIUM_SECTION_HEIGHT;
  }

  if (sectionSpan != null && Number.isFinite(sectionSpan)) {
    height = Math.min(height, Math.max(MIN_FOCUS_HEIGHT, sectionSpan - SECTION_BOUNDARY_GAP));
  }

  return clampNumber(height, MIN_FOCUS_HEIGHT, MAX_FOCUS_HEIGHT);
}

function getConfidenceLabel({ match = {}, pageMatchConfidence = 0 } = {}) {
  if (!match.line) return "low";

  if (match.exactHeadingMatch || match.score >= 22 || pageMatchConfidence >= 0.78) {
    return "high";
  }

  if (match.score >= 8 || pageMatchConfidence >= 0.45) {
    return "medium";
  }

  return "low";
}

function clampFocusBand({ y, height }) {
  const safeHeight = clampNumber(height, MIN_FOCUS_HEIGHT, MAX_FOCUS_HEIGHT);
  const safeY = clampNumber(
    y,
    PAGE_TOP_SAFE_Y,
    Math.max(PAGE_TOP_SAFE_Y, PAGE_BOTTOM_SAFE_Y - safeHeight)
  );

  return {
    y: safeY,
    height: Math.min(safeHeight, PAGE_BOTTOM_SAFE_Y - safeY),
  };
}

function inferVerticalBandFromText({
  unit = {},
  pageText = "",
  pageMatchConfidence = 0,
} = {}) {
  const match = findBestLineMatch({ unit, pageText });

  if (!match.line) {
    return {
      ...LOW_CONFIDENCE_REGION,
      confidence: "low",
      fitMode: "broad_page_section",
      matchedLine: null,
      anchorLine: null,
      nextBoundaryLine: null,
      groundingReason: "no_line_match",
    };
  }

  const anchorHeading =
    match.line.isHeading
      ? match.line
      : findNearestHeadingBefore(match.lineIndex, match.line.index);

  const nextHeading = findNextHeadingAfter(
    match.lineIndex,
    anchorHeading?.index ?? match.line.index
  );

  const anchorLine = anchorHeading || match.line;
  const anchorY = textOffsetToY(anchorLine.start, match.lineIndex.length);

  const nextBoundaryY = nextHeading
    ? textOffsetToY(nextHeading.start, match.lineIndex.length)
    : null;

  const sectionSpan =
    nextBoundaryY != null
      ? Math.max(MIN_FOCUS_HEIGHT, nextBoundaryY - anchorY)
      : null;

  const preferredHeight = pickBandHeight({
    unit,
    match,
    sectionSpan,
  });

  const boundaryAwareHeight =
    nextBoundaryY != null
      ? Math.min(preferredHeight, Math.max(MIN_FOCUS_HEIGHT, nextBoundaryY - anchorY - SECTION_BOUNDARY_GAP))
      : preferredHeight;

  const { y, height } = clampFocusBand({
    y: anchorY,
    height: boundaryAwareHeight,
  });

  const confidence = getConfidenceLabel({
    match,
    pageMatchConfidence,
  });

  return {
    y,
    height,
    confidence,
    fitMode: confidence === "high" ? "tight_heading_section" : "tight_semantic_section",
    matchedLine: normalizeLine(match.line.original),
    anchorLine: normalizeLine(anchorLine.original),
    nextBoundaryLine: nextHeading ? normalizeLine(nextHeading.original) : null,
    groundingReason: anchorHeading
      ? "heading_anchored_semantic_match"
      : "line_anchored_semantic_match",
  };
}

function buildGroundedFocusRegion({
  unit,
  pageText,
  fallbackFocusRegion,
  pageMatchConfidence = 0,
}) {
  const band = inferVerticalBandFromText({
    unit,
    pageText,
    pageMatchConfidence,
  });

  const fallbackX = Number.isFinite(Number(fallbackFocusRegion?.x))
    ? Number(fallbackFocusRegion.x)
    : DEFAULT_FOCUS_X;

  const fallbackWidth = Number.isFinite(Number(fallbackFocusRegion?.width))
    ? Number(fallbackFocusRegion.width)
    : DEFAULT_FOCUS_WIDTH;

  const x = clampNumber(fallbackX, 0.02, 0.28);
  const width = clampNumber(fallbackWidth, 0.5, 0.94);

  return {
    type: "semantic_band",
    source: "sourceGroundingBuilder",
    version: SOURCE_GROUNDING_VERSION,
    confidence: band.confidence,
    label:
      unit.focusHint?.label ||
      unit.title ||
      fallbackFocusRegion?.label ||
      "Relevant document area",
    x,
    y: band.y,
    width: Math.min(width, 0.98 - x),
    height: band.height,

    // BUG-17A-lite metadata for renderPlan/Root.jsx.
    fitMode: band.fitMode,
    padding: band.confidence === "high"
      ? { x: 0.004, y: 0.006 }
      : band.confidence === "medium"
        ? { x: 0.006, y: 0.009 }
        : { x: 0.012, y: 0.018 },
    viewportIntent: "fit_focus_region_with_context",
    grounding: {
      reason: band.groundingReason,
      matchedLine: band.matchedLine,
      anchorLine: band.anchorLine,
      nextBoundaryLine: band.nextBoundaryLine,
    },
  };
}


function getLayoutSearchTerms(unit = {}) {
  return uniq([
    unit.title,
    unit.focusHint?.label,
    unit.visualIntent?.focus,
    ...(Array.isArray(unit.visibleElements)
      ? unit.visibleElements
      : []),
    ...(Array.isArray(unit.concepts)
      ? unit.concepts
      : []),
  ])
    .map(normalizeText)
    .filter(Boolean);
}


function getExactEntityTerms(unit = {}) {
  return uniq([
    unit.focusHint?.target,
    unit.focusHint?.label,
    unit.metadata?.entityId,
    unit.metadata?.entityName,
    unit.semanticTraversal?.teachingFocus?.entityId,
    unit.semanticTraversal?.teachingFocus?.label,
    unit.title,
  ])
    .map(normalizeLine)
    .filter((term) => {
      if (term.length < 2 || term.length > 40) return false;
      if (isBannedFocusText(term)) return false;
      return true;
    });
}

function findBestSpatialEntityCandidate(
  unit,
  spatialEntityGrounding = {}
) {
  const bestCandidates =
    spatialEntityGrounding.bestCandidates || {};

  const terms = getExactEntityTerms(unit)
    .map(normalizeText)
    .filter(Boolean);

  for (const term of terms) {
    const candidate = bestCandidates[term];

    if (!candidate) continue;

    if (candidate.cameraEligible !== true) {
      continue;
    }

    if (
      !["high", "medium"].includes(candidate.confidence)
    ) {
      continue;
    }

    if (!candidate.region) continue;

    return candidate;
  }

  return null;
}


function scoreLayoutBlock(block, terms, unit = {}) {
  const text = normalizeText(block?.text || "");

  if (!text) return 0;

  const title = normalizeText(unit.title || "");

  let score = 0;

  // Strong section-heading anchor
  if (
    block.type === "heading" &&
    title &&
    text.includes(title)
  ) {
    score += 100;
  }

  for (const term of terms) {
    if (!term) continue;

    // Exact phrase match
    if (text.includes(term)) {
      score += block.type === "heading" ? 24 : 10;
      continue;
    }

    const words = term
      .split(/\s+/)
      .filter((word) => word.length >= 3);

    for (const word of words) {
      if (text.includes(word)) {
        score += block.type === "heading" ? 4 : 1;
      }
    }
  }

  // Prefer headings overall
  if (block.type === "heading") {
    score += 8;
  }

  return score;
}

function findBestHeadingBlock(unit, page) {
  const title = normalizeText(unit.title || "");
  if (!title || !page?.blocks?.length) return null;

  let best = null;

  for (const block of page.blocks || []) {
    if (block.type !== "heading") continue;

    const text = normalizeText(block.text || "");
    if (!text) continue;

    let score = 0;

    if (text === title) score += 120;
    else if (text.includes(title) || title.includes(text)) score += 90;

    const titleWords = title.split(/\s+/).filter((word) => word.length >= 3);
    for (const word of titleWords) {
      if (text.includes(word)) score += 8;
    }

    if (!best || score > best.score) {
      best = { block, score };
    }
  }

  return best && best.score > 0 ? best.block : null;
}

function getBlocksOwnedByHeading(page, headingBlock) {
  if (!page?.blocks?.length || !headingBlock) return page?.blocks || [];

  const startY = headingBlock.y;
  const nextHeading = (page.blocks || [])
    .filter((block) =>
      (block.type === "heading" || block.type === "section") &&
      block.y > headingBlock.y + 0.001
    )
    .sort((a, b) => a.y - b.y)[0];

  const endY = nextHeading ? nextHeading.y : 0.96;

  return (page.blocks || []).filter((block) => {
    if (block.page !== headingBlock.page) return false;
    return block.y >= startY && block.y < endY;
  });
}

function findBestLayoutBoxMatch(unit, layoutBoxes, groundedPage) {
  if (!layoutBoxes?.pages?.length) return null;

  const terms = getLayoutSearchTerms(unit);

  const page = layoutBoxes.pages.find(
    (item) => item.page === groundedPage
  );

  if (!page) return null;

  const exactEntityTerms = getExactEntityTerms(unit);

  for (const block of page.blocks || []) {
    if (isBannedFocusText(block.text)) continue;

    const blockText = normalizeText(block.text || "");

    for (const term of exactEntityTerms) {
      const normalizedTerm = normalizeText(term);
      if (!normalizedTerm) continue;

      const escapedTerm = normalizedTerm.replace(
        /[.*+?^${}()|[\]\\]/g,
        "\\$&"
      );

      const exactTokenRegex = new RegExp(
        `(^|\\s)${escapedTerm}(\\s|$)`,
        "i"
      );

      if (
        blockText === normalizedTerm ||
        exactTokenRegex.test(blockText)
      ) {
        return {
          block: {
            ...block,
            matchType: "exact_entity_label",
          },
          score: 2000,
          headingBlock: null,
        };
      }
    }
  }

  const entityLikeTerms = exactEntityTerms.filter((term) => {
    const normalized = normalizeText(term);
    if (!normalized) return false;

    const words = normalized.split(/\s+/).filter(Boolean);

    return (
      words.length === 1 &&
      normalized.length >= 2 &&
      normalized.length <= 40
    );
  });

  if (entityLikeTerms.length > 0) {
    return null;
  }

  let best = null;

  const headingBlock = findBestHeadingBlock(unit, page);

  if (headingBlock && isBannedFocusText(headingBlock.text)) {
    return null;
  }

  const rawCandidateBlocks = headingBlock
    ? getBlocksOwnedByHeading(page, headingBlock)
    : page.blocks || [];

  const candidateBlocks = rawCandidateBlocks.filter(
    (block) => !isBannedFocusText(block.text)
  );

  for (const block of candidateBlocks) {
    const score = scoreLayoutBlock(
      block,
      terms,
      unit
    );

    if (!best || score > best.score) {
      best = {
        block: {
          ...block,
          matchType: "layout_box_match",
        },
        score,
        headingBlock,
      };
    }
  }

  if (!best || best.score <= 0) return null;

  return best;
}
function buildBroadVisualFocusRegion({ unit, groundedPage }) {
  const recapLike = isRecapLikeUnit(unit);

  return {
    type: "broad_visual_region",
    source: "sourceGroundingBuilder",
    version: SOURCE_GROUNDING_VERSION,
    confidence: "medium",
    label:
      unit.focusHint?.label ||
      unit.title ||
      "Relevant document region",
    x: 0.05,
    y: 0.12,
    width: 0.9,
    height: 0.68,
    fitMode: "broad_visual_context_region",
    viewportIntent: "fit_focus_region_with_context",
    padding: {
      x: 0.012,
      y: 0.018,
    },
    grounding: {
      reason: recapLike
        ? "recap_reuses_broad_visual_context"
        : "broad_visual_region_preferred",
      matchedLine: null,
      anchorLine: null,
      nextBoundaryLine: null,
    },
    page: groundedPage,
  };
}

function buildFocusRegionFromLayoutBox({
  unit,
  block,
  fallbackFocusRegion,
}) {
  const fallbackX = Number.isFinite(Number(fallbackFocusRegion?.x))
    ? Number(fallbackFocusRegion.x)
    : DEFAULT_FOCUS_X;

  const fallbackWidth = Number.isFinite(Number(fallbackFocusRegion?.width))
    ? Number(fallbackFocusRegion.width)
    : DEFAULT_FOCUS_WIDTH;

  const x = clampNumber(
    Number.isFinite(block.x) ? block.x : fallbackX,
    0.02,
    0.9
  );

  const width = clampNumber(
    Number.isFinite(block.width)
      ? block.width
      : fallbackWidth,
    0.08,
    0.94
  );

  const y = clampNumber(block.y, PAGE_TOP_SAFE_Y, 0.92);

  const rawHeight = Number.isFinite(Number(block.height))
    ? Number(block.height)
    : block.type === "heading"
        ? 0.045
        : block.type === "section"
          ? 0.095
          : 0.07;

  const height = clampNumber(
    block.type === "heading"
      ? Math.max(rawHeight, 0.045)
      : rawHeight,
    block.type === "heading" ? 0.04 : 0.045,
    block.type === "heading" ? 0.07 : 0.16
  );

  return {
    type: "layout_box_focus",
    source: "layoutBoxBuilder",
    version: SOURCE_GROUNDING_VERSION,
    confidence:
      block.confidence === "estimated"
        ? "medium"
        : "high",
    label:
      unit.focusHint?.label ||
      unit.title ||
      block.text ||
      "Relevant document area",
    x,
    y,
    width: Math.min(width, 0.98 - x),
    height,
    fitMode: "layout_box_match",
    viewportIntent: "fit_focus_region_with_context",
    padding: {
      x: 0.006,
      y: 0.01,
    },
    grounding: {
      reason: block.matchType || "layout_box_match",
      matchedLine: block.text,
      anchorLine: block.text,
      nextBoundaryLine: null,
      blockType: block.type,
      blockSource: block.source,
    },
  };
}

function buildFocusRegionFromSpatialCandidate({
  unit,
  candidate,
}) {
  const region = candidate.region || {};

  return {
    type: "spatial_entity_focus",
    source: "spatialEntityGroundingBuilder",
    version: SOURCE_GROUNDING_VERSION,
    confidence: candidate.confidence,
    label:
      unit.focusHint?.label ||
      unit.title ||
      candidate.label ||
      "Relevant document area",
    x: clampNumber(region.x, 0.02, 0.9),
    y: clampNumber(region.y, PAGE_TOP_SAFE_Y, 0.92),
    width: clampNumber(region.width, 0.08, 0.94),
    height: clampNumber(region.height, 0.045, 0.22),
    fitMode: "spatial_entity_focus",
    viewportIntent: "fit_focus_region_with_context",
    padding: {
      x: 0.01,
      y: 0.014,
    },
    grounding: {
      reason:
        candidate.reason ||
        "spatial_entity_candidate",
      matchedLine:
        candidate.text ||
        candidate.label ||
        null,
      anchorLine:
        candidate.text ||
        candidate.label ||
        null,
      nextBoundaryLine: null,
      candidateSource: candidate.source || null,
    },
  };
}

function groundTeachingUnit(
  unit,
  pageTexts,
  layoutBoxes,
  spatialEntityGrounding
) {
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

  const spatialCandidate = shouldUseBroadVisualRegion(unit)
    ? null
    : findBestSpatialEntityCandidate(
        unit,
        spatialEntityGrounding
      );

  const layoutMatch = shouldUseBroadVisualRegion(unit)
    ? null
    : findBestLayoutBoxMatch(
        unit,
        layoutBoxes,
        groundedPage
      );

  const focusRegion = shouldUseBroadVisualRegion(unit)
    ? buildBroadVisualFocusRegion({
        unit,
        groundedPage,
      })
    : spatialCandidate
      ? buildFocusRegionFromSpatialCandidate({
          unit,
          candidate: spatialCandidate,
        })
      : layoutMatch
        ? buildFocusRegionFromLayoutBox({
            unit,
            block: layoutMatch.block,
            fallbackFocusRegion,
          })
        : buildGroundedFocusRegion({
            unit,
            pageText,
            fallbackFocusRegion,
            pageMatchConfidence: pageMatch.confidence,
          });

  const sourcePages = groundedPage ? [groundedPage] : existingSourcePages;

  const sourceGrounding = {
    version: SOURCE_GROUNDING_VERSION,
    source: focusRegion.source || "sourceGroundingBuilder",
    page: groundedPage,
    confidence: spatialCandidate
      ? spatialCandidate.confidence
      : layoutMatch
        ? layoutMatch.score
        : pageMatch.confidence,
    matchedTerms: pageMatch.matchedTerms,
    focusRegionConfidence: focusRegion.confidence,
    focusRegionFitMode: focusRegion.fitMode,
    groundingReason: focusRegion.grounding?.reason || null,
    anchorLine: focusRegion.grounding?.anchorLine || null,
    nextBoundaryLine: focusRegion.grounding?.nextBoundaryLine || null,
    layoutBoxMatched: Boolean(layoutMatch),
    layoutBoxScore: layoutMatch?.score || 0,
    layoutBoxType: layoutMatch?.block?.type || null,
    spatialEntityMatched: Boolean(spatialCandidate),
    spatialEntityConfidence: spatialCandidate?.confidence || null,
    spatialEntityReason: spatialCandidate?.reason || null,
  };

  return {
    ...unit,
    sourcePages,
    focusHint: unit.focusHint
      ? {
          ...unit.focusHint,
          sourcePages,
          sourceGrounding,
          focusRegion: {
            ...focusRegion,
            page: focusRegion.page || groundedPage,
          },
        }
      : unit.focusHint,
    metadata: {
      ...(unit.metadata || {}),
      sourceGrounding,
    },
  };
}

function buildSourceGrounding({
  teachingUnits = [],
  extractedData = {},
  diagramAnalysis = {},
  pageImageCount = 0,
  jobDir = null,
} = {}) {
  const pageTexts = extractPageTexts(extractedData);

  const layoutBoxes = jobDir
    ? buildLayoutBoxes(jobDir)
    : buildLayoutBoxesFromExtractedData(extractedData);

  const spatialEntityGrounding =
    readSpatialEntityGrounding(jobDir);

  const pageCount = getPageCount({
    extractedData,
    diagramAnalysis,
    pageImageCount,
  });

  const groundedTeachingUnits = teachingUnits.map((unit) =>
    groundTeachingUnit(
      unit,
      pageTexts,
      layoutBoxes,
      spatialEntityGrounding
    )
  );

  return {
    version: SOURCE_GROUNDING_VERSION,
    source: "sourceGroundingBuilder",
    pageCount,
    pageTextCount: pageTexts.length,
    groundedUnitCount: groundedTeachingUnits.filter(
      (unit) => Array.isArray(unit.sourcePages) && unit.sourcePages.length > 0
    ).length,
    focusRegionCount: groundedTeachingUnits.filter(
      (unit) => Boolean(unit.focusHint?.focusRegion)
    ).length,
    highConfidenceFocusRegionCount: groundedTeachingUnits.filter(
      (unit) => unit.focusHint?.focusRegion?.confidence === "high"
    ).length,
    mediumConfidenceFocusRegionCount: groundedTeachingUnits.filter(
      (unit) => unit.focusHint?.focusRegion?.confidence === "medium"
    ).length,
    lowConfidenceFocusRegionCount: groundedTeachingUnits.filter(
      (unit) => unit.focusHint?.focusRegion?.confidence === "low"
    ).length,
    teachingUnits: groundedTeachingUnits,
  };
}

module.exports = {
  buildSourceGrounding,
};
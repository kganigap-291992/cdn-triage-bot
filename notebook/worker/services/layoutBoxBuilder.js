// notebook/worker/services/layoutBoxBuilder.js

const fs = require("fs");
const path = require("path");

const {
  extractPdfLayoutForJob,
} = require("./pdfLayoutExtractor");

const LAYOUT_BOX_VERSION = "layout-boxes-v2-pymupdf-first";

function safeString(value) {
  return String(value || "").trim();
}

function normalizeText(value) {
  return safeString(value)
    .toLowerCase()
    .replace(/[`"'()[\]{}<>]/g, " ")
    .replace(/[^a-z0-9./:_&-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function clamp(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.min(max, Math.max(min, number));
}

function looksLikeHeading(line) {
  const text = safeString(line);
  if (!text) return false;

  if (/^#{1,6}\s+/.test(text)) return true;
  if (/^\d+(\.\d+)*[.)]?\s+[A-Z0-9]/.test(text)) return true;
  if (
    /^[A-Z][A-Za-z0-9 /:_&()!-]{2,90}$/.test(text) &&
    !/[.!?]$/.test(text)
  ) {
    return true;
  }

  const words = text.split(/\s+/).filter(Boolean);

  if (words.length >= 1 && words.length <= 8) {
    const titleishWords = words.filter((word) =>
      /^[A-Z0-9][A-Za-z0-9/_:&-]*$/.test(word)
    );

    return titleishWords.length / words.length >= 0.65 && !/[.!?]$/.test(text);
  }

  return false;
}

function looksLikeCommand(line) {
  const text = safeString(line)
    .replace(/^\d+[.)]?\s+/, "")
    .trim();

  return /^(kubectl|helm|docker|curl|ssh|git|npm|node|python|pip|go|java|terraform|ansible|aws|gcloud|az|sql|psql|mysql)\b/i.test(text);
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

function buildLineBlocksForPage(pageItem) {
  const lines = safeString(pageItem.text)
    .split(/\r?\n/)
    .map((line) => safeString(line))
    .filter(Boolean);

  if (!lines.length) return [];

  const usableTop = 0.08;
  const usableBottom = 0.92;
  const usableHeight = usableBottom - usableTop;

  const lineStep = usableHeight / Math.max(lines.length, 1);

  return lines.map((line, index) => {
    const isHeading = looksLikeHeading(line);
    const isCommand = looksLikeCommand(line);

    const y = clamp(usableTop + index * lineStep, 0.04, 0.96);
    const height = clamp(isHeading ? lineStep * 1.35 : lineStep * 1.05, 0.012, 0.055);

    return {
      id: `p${pageItem.page}-line-${String(index + 1).padStart(3, "0")}`,
      page: pageItem.page,
      type: isHeading ? "heading" : isCommand ? "command" : "line",
      text: line,
      normalizedText: normalizeText(line),
      x: isHeading ? 0.08 : 0.11,
      y,
      width: isHeading ? 0.76 : 0.78,
      height,
      confidence: "estimated",
      source: "layoutBoxBuilder:text-order-estimate",
      lineIndex: index,
    };
  });
}

function buildPdfLineBlocksForPage(pageItem) {
  const lines = Array.isArray(pageItem.lines) ? pageItem.lines : [];

  return lines
    .map((line, index) => {
      const text = safeString(line.text);
      if (!text) return null;

      const isHeading = line.type === "heading" || looksLikeHeading(text);
      const isCommand = looksLikeCommand(text);

      return {
        id: line.id || `p${pageItem.page}-pdf-line-${String(index + 1).padStart(3, "0")}`,
        page: Number(line.page || pageItem.page),
        type: isHeading ? "heading" : isCommand ? "command" : "line",
        text,
        normalizedText: normalizeText(text),
        x: clamp(line.x, 0, 0.98),
        y: clamp(line.y, 0, 0.98),
        width: clamp(line.width, 0.01, 0.98),
        height: clamp(line.height, isHeading ? 0.012 : 0.008, isHeading ? 0.08 : 0.06),
        confidence: line.confidence || "real",
        source: line.source || "pdfLayoutExtractor:pymupdf-line-bbox",
        lineIndex: index,
        fontSize: line.fontSize,
        bbox: line.bbox,
      };
    })
    .filter(Boolean);
}

function buildSectionBlocks(lineBlocks) {
  const headings = lineBlocks.filter((block) => block.type === "heading");

  return headings.map((heading, index) => {
    const nextHeading = headings[index + 1] || null;
    const sectionBottom = nextHeading
      ? Math.max(heading.y + heading.height, nextHeading.y - 0.012)
      : Math.min(0.94, heading.y + 0.14);

    return {
      id: `${heading.id}-section`,
      page: heading.page,
      type: "section",
      text: heading.text,
      normalizedText: heading.normalizedText,
      x: clamp(heading.x, 0.02, 0.92),
      y: clamp(heading.y, 0.02, 0.96),
      width: clamp(Math.max(heading.width, 0.42), 0.08, 0.94),
      height: clamp(sectionBottom - heading.y, 0.045, 0.18),
      confidence: heading.confidence,
      source:
        heading.confidence === "real"
          ? "layoutBoxBuilder:pymupdf-heading-section"
          : "layoutBoxBuilder:heading-section-estimate",
      headingId: heading.id,
      headingText: heading.text,
    };
  });
}

function buildPagesFromLineBlocks(lineBlocksByPage, precision, note) {
  const pages = Array.from(lineBlocksByPage.entries()).map(([pageNumber, lineBlocks]) => {
    const sectionBlocks = buildSectionBlocks(lineBlocks);

    return {
      page: pageNumber,
      width: 1,
      height: 1,
      coordinateSystem: "normalized_page",
      source: "layoutBoxBuilder",
      blocks: [...sectionBlocks, ...lineBlocks],
      stats: {
        blockCount: sectionBlocks.length + lineBlocks.length,
        sectionCount: sectionBlocks.length,
        headingCount: lineBlocks.filter((block) => block.type === "heading").length,
        commandCount: lineBlocks.filter((block) => block.type === "command").length,
        lineCount: lineBlocks.length,
        realBlockCount: lineBlocks.filter((block) => block.confidence === "real").length,
      },
    };
  });

  return {
    version: LAYOUT_BOX_VERSION,
    source: "layoutBoxBuilder",
    coordinateSystem: "normalized_page",
    precision,
    note,
    generatedAt: new Date().toISOString(),
    pageCount: pages.length,
    pages,
    stats: {
      pageCount: pages.length,
      blockCount: pages.reduce((sum, page) => sum + page.stats.blockCount, 0),
      sectionCount: pages.reduce((sum, page) => sum + page.stats.sectionCount, 0),
      headingCount: pages.reduce((sum, page) => sum + page.stats.headingCount, 0),
      commandCount: pages.reduce((sum, page) => sum + page.stats.commandCount, 0),
      lineCount: pages.reduce((sum, page) => sum + page.stats.lineCount, 0),
      realBlockCount: pages.reduce((sum, page) => sum + page.stats.realBlockCount, 0),
    },
  };
}

function buildEstimatedLayoutBoxesFromExtractedData(extractedData = {}) {
  const pageTexts = extractPageTexts(extractedData);
  const lineBlocksByPage = new Map();

  for (const pageItem of pageTexts) {
    lineBlocksByPage.set(
      pageItem.page,
      buildLineBlocksForPage(pageItem)
    );
  }

  return buildPagesFromLineBlocks(
    lineBlocksByPage,
    "estimated_from_extracted_text_order",
    "Fallback layout boxes using extracted text order. These coordinates are approximate and should not be trusted for precise visual focus."
  );
}

function buildRealLayoutBoxesFromPdfLayout(pdfLayout) {
  const lineBlocksByPage = new Map();

  for (const pageItem of pdfLayout.pages || []) {
    const pageNumber = Number(pageItem.page);
    if (!Number.isFinite(pageNumber)) continue;

    const lineBlocks = buildPdfLineBlocksForPage(pageItem);
    lineBlocksByPage.set(pageNumber, lineBlocks);
  }

  return buildPagesFromLineBlocks(
    lineBlocksByPage,
    "real_pymupdf_line_bboxes",
    "Real PDF layout boxes extracted from PyMuPDF line bounding boxes. Preferred for visual focus."
  );
}

function buildLayoutBoxesFromExtractedData(extractedData = {}) {
  return buildEstimatedLayoutBoxesFromExtractedData(extractedData);
}

function getLayoutBoxesPath(jobDir) {
  return path.join(jobDir, "layout-boxes.json");
}

function buildLayoutBoxes(jobDir) {
  const extractedPath = path.join(jobDir, "extracted.json");

  if (!fs.existsSync(extractedPath)) {
    throw new Error(`Missing extracted.json at ${extractedPath}`);
  }

  const extractedData = JSON.parse(fs.readFileSync(extractedPath, "utf8"));

  const pdfLayout = extractPdfLayoutForJob(jobDir);

  if (pdfLayout?.ok && Array.isArray(pdfLayout.pages) && pdfLayout.pages.length > 0) {
    const realLayoutBoxes = buildRealLayoutBoxesFromPdfLayout(pdfLayout);

    return {
      ...realLayoutBoxes,
      pdfLayout: {
        version: pdfLayout.version,
        source: pdfLayout.source,
        ok: true,
        pageCount: pdfLayout.pageCount,
        pdfPath: pdfLayout.pdfPath,
      },
      fallbackAvailable: true,
    };
  }

  const estimatedLayoutBoxes = buildEstimatedLayoutBoxesFromExtractedData(extractedData);

  return {
    ...estimatedLayoutBoxes,
    pdfLayout: {
      version: pdfLayout?.version || null,
      source: pdfLayout?.source || "pdfLayoutExtractor",
      ok: false,
      reason: pdfLayout?.reason || "pdf_layout_unavailable",
      error: pdfLayout?.error || null,
    },
    fallbackAvailable: false,
  };
}

function saveLayoutBoxes(jobDir, layoutBoxes) {
  const outputPath = getLayoutBoxesPath(jobDir);
  fs.writeFileSync(outputPath, JSON.stringify(layoutBoxes, null, 2));
  return outputPath;
}

function buildAndSaveLayoutBoxes(jobDir) {
  const layoutBoxes = buildLayoutBoxes(jobDir);
  const outputPath = saveLayoutBoxes(jobDir, layoutBoxes);

  return {
    layoutBoxes,
    outputPath,
  };
}

module.exports = {
  LAYOUT_BOX_VERSION,
  buildLayoutBoxes,
  buildLayoutBoxesFromExtractedData,
  saveLayoutBoxes,
  buildAndSaveLayoutBoxes,
  getLayoutBoxesPath,
};
// notebook/worker/services/pdfLayoutExtractor.js

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const PDF_LAYOUT_VERSION = "pdf-layout-v1-pymupdf";

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

function looksLikeHeading(text) {
  const line = safeString(text);
  if (!line) return false;
  if (/^\d+(\.\d+)*[.)]?\s+[A-Z0-9]/.test(line)) return true;
  if (/^[A-Z][A-Za-z0-9 /:_&()!-]{2,90}$/.test(line) && !/[.!?]$/.test(line)) {
    return true;
  }

  const words = line.split(/\s+/).filter(Boolean);
  if (words.length >= 1 && words.length <= 8) {
    const titleish = words.filter((word) => /^[A-Z0-9][A-Za-z0-9/_:&-]*$/.test(word));
    return titleish.length / words.length >= 0.65 && !/[.!?]$/.test(line);
  }

  return false;
}

function findPdfPath(jobDir) {
  const candidates = [
    "input.pdf",
    "document.pdf",
    "upload.pdf",
    "uploaded.pdf",
    "source.pdf",
  ].map((name) => path.join(jobDir, name));

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  const pdf = fs
    .readdirSync(jobDir)
    .find((file) => file.toLowerCase().endsWith(".pdf"));

  return pdf ? path.join(jobDir, pdf) : null;
}

function extractPdfLayout(pdfPath) {
  if (!pdfPath || !fs.existsSync(pdfPath)) {
    return {
      version: PDF_LAYOUT_VERSION,
      source: "pdfLayoutExtractor",
      ok: false,
      reason: "missing_pdf",
      pages: [],
    };
  }

  const python = `
import json, sys
import fitz

pdf_path = sys.argv[1]
doc = fitz.open(pdf_path)
pages = []

for page_index, page in enumerate(doc):
    width = float(page.rect.width)
    height = float(page.rect.height)
    raw = page.get_text("dict")

    lines = []
    for block in raw.get("blocks", []):
        if block.get("type") != 0:
            continue

        for line in block.get("lines", []):
            spans = line.get("spans", [])
            text = " ".join([s.get("text", "").strip() for s in spans if s.get("text", "").strip()]).strip()
            if not text:
                continue

            x0, y0, x1, y1 = line.get("bbox", [0, 0, 0, 0])

            font_sizes = [float(s.get("size", 0)) for s in spans if s.get("size")]
            avg_size = sum(font_sizes) / len(font_sizes) if font_sizes else 0

            lines.append({
                "page": page_index + 1,
                "text": text,
                "x": x0 / width if width else 0,
                "y": y0 / height if height else 0,
                "width": (x1 - x0) / width if width else 0,
                "height": (y1 - y0) / height if height else 0,
                "fontSize": avg_size,
                "bbox": [x0, y0, x1, y1],
            })

    pages.append({
        "page": page_index + 1,
        "width": width,
        "height": height,
        "lines": lines,
    })

print(json.dumps({
    "ok": True,
    "pageCount": len(pages),
    "pages": pages,
}))
`;

  const result = spawnSync("python3", ["-c", python, pdfPath], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 20,
  });

  if (result.status !== 0) {
    return {
      version: PDF_LAYOUT_VERSION,
      source: "pdfLayoutExtractor",
      ok: false,
      reason: "pymupdf_failed",
      error: result.stderr || result.stdout,
      pages: [],
    };
  }

  const parsed = JSON.parse(result.stdout);

  return {
    version: PDF_LAYOUT_VERSION,
    source: "pdfLayoutExtractor",
    ok: true,
    pdfPath,
    pageCount: parsed.pageCount || 0,
    pages: (parsed.pages || []).map((page) => ({
      ...page,
      lines: (page.lines || []).map((line, index) => ({
        id: `p${page.page}-pdf-line-${String(index + 1).padStart(3, "0")}`,
        page: line.page,
        type: looksLikeHeading(line.text) ? "heading" : "line",
        text: line.text,
        normalizedText: normalizeText(line.text),
        x: clamp(line.x, 0, 1),
        y: clamp(line.y, 0, 1),
        width: clamp(line.width, 0.01, 1),
        height: clamp(line.height, 0.008, 0.12),
        fontSize: line.fontSize,
        bbox: line.bbox,
        confidence: "real",
        source: "pdfLayoutExtractor:pymupdf-line-bbox",
      })),
    })),
  };
}

function extractPdfLayoutForJob(jobDir) {
  const pdfPath = findPdfPath(jobDir);
  return extractPdfLayout(pdfPath);
}

module.exports = {
  PDF_LAYOUT_VERSION,
  extractPdfLayout,
  extractPdfLayoutForJob,
  findPdfPath,
};
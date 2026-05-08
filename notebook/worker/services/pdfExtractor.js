// notebook/worker/services/pdfExtractor.js

const fs = require("fs");
const path = require("path");

const { PDFParse } = require("pdf-parse");

async function extractPdfText(pdfPath) {
  const pdfBuffer = fs.readFileSync(pdfPath);

  const parser = new PDFParse({ data: pdfBuffer });
  const result = await parser.getText();

  return {
    pageCount: result.total || null,
    info: {},
    metadata: null,
    text: result.text || "",
    extractedAt: new Date().toISOString(),
  };
}

function getExtractedJsonPath(jobDir) {
  return path.join(jobDir, "extracted.json");
}

function saveExtractedText(jobDir, extractedData) {
  const outputPath = getExtractedJsonPath(jobDir);

  fs.writeFileSync(
    outputPath,
    JSON.stringify(extractedData, null, 2)
  );

  return outputPath;
}

module.exports = {
  extractPdfText,
  saveExtractedText,
  getExtractedJsonPath,
};
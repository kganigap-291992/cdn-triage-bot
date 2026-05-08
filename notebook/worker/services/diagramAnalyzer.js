// notebook/worker/services/diagramAnalyzer.js

const fs = require("fs");
const path = require("path");

const { analyzeDiagramImage } = require("./visionClient");

function getDiagramAnalysisPath(jobDir) {
  return path.join(jobDir, "diagram-analysis.json");
}

async function analyzeRenderedPages(jobDir) {
  const pageImageDir = path.join(jobDir, "page-images");

  const pageFiles = fs
    .readdirSync(pageImageDir)
    .filter((file) => file.endsWith(".png"))
    .sort();

  const useVision = Boolean(process.env.OPENAI_API_KEY);

  const analysis = [];

  for (const [index, file] of pageFiles.entries()) {
    const imagePath = path.join(pageImageDir, file);

    let summary =
      "Vision analysis skipped because OPENAI_API_KEY is not configured for the worker.";

    if (useVision) {
      summary = await analyzeDiagramImage(imagePath);
    }

    analysis.push({
      page: index + 1,
      image: file,
      detectedVisuals: [
        "possible_diagram",
        "possible_chart",
      ],
      summary,
      analysisMode: useVision ? "vision" : "placeholder",
    });
  }

  return {
    analyzedAt: new Date().toISOString(),
    totalPagesAnalyzed: analysis.length,
    pages: analysis,
  };
}

function saveDiagramAnalysis(jobDir, analysisData) {
  const outputPath = getDiagramAnalysisPath(jobDir);

  fs.writeFileSync(
    outputPath,
    JSON.stringify(analysisData, null, 2)
  );

  return outputPath;
}

module.exports = {
  analyzeRenderedPages,
  saveDiagramAnalysis,
  getDiagramAnalysisPath,
};
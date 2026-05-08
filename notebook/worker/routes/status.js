// notebook/worker/routes/status.js

const express = require("express");
const fs = require("fs");
const path = require("path");

const { getJobDir } = require("../services/jobManager");

const router = express.Router();

router.get("/:jobId", async (req, res) => {
  try {
    const { jobId } = req.params;

    const jobDir = getJobDir(jobId);

    const inputPdfPath = path.join(jobDir, "input.pdf");

    const extractedJsonPath = path.join(
      jobDir,
      "extracted.json"
    );

    const diagramAnalysisPath = path.join(
      jobDir,
      "diagram-analysis.json"
    );

    const pageImagesDir = path.join(
      jobDir,
      "page-images"
    );

    const hasPdf = fs.existsSync(inputPdfPath);

    const hasExtractedJson =
      fs.existsSync(extractedJsonPath);

    const hasDiagramAnalysis =
      fs.existsSync(diagramAnalysisPath);

    const hasPageImages =
      fs.existsSync(pageImagesDir) &&
      fs
        .readdirSync(pageImagesDir)
        .some((file) => file.endsWith(".png"));

    let extractedPreview = null;
    let diagramPreview = null;

    if (hasExtractedJson) {
      const extractedData = JSON.parse(
        fs.readFileSync(extractedJsonPath, "utf8")
      );

      extractedPreview = extractedData.text
        .slice(0, 1000)
        .trim();
    }

    if (hasDiagramAnalysis) {
      const diagramData = JSON.parse(
        fs.readFileSync(diagramAnalysisPath, "utf8")
      );

      diagramPreview = diagramData.pages.map((page) => ({
        page: page.page,
        detectedVisuals: page.detectedVisuals,
        summary: page.summary,
      }));
    }

    let status = "unknown";

    if (hasDiagramAnalysis) {
      status = "diagrams_analyzed";
    } else if (hasPageImages) {
      status = "pages_rendered";
    } else if (hasExtractedJson) {
      status = "extracted";
    } else if (hasPdf) {
      status = "uploaded";
    }

    res.json({
      ok: true,
      jobId,
      status,
      files: {
        inputPdf: hasPdf,
        extractedJson: hasExtractedJson,
        pageImages: hasPageImages,
        diagramAnalysis: hasDiagramAnalysis,
      },
      extractedPreview,
      diagramPreview,
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error:
        error.message ||
        "Failed to fetch job status",
    });
  }
});

module.exports = router;
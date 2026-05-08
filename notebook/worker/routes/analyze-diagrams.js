// notebook/worker/routes/analyze-diagrams.js

const express = require("express");
const path = require("path");

const { getJobDir } = require("../services/jobManager");
const {
  analyzeRenderedPages,
  saveDiagramAnalysis,
} = require("../services/diagramAnalyzer");

const router = express.Router();

router.post("/:jobId", async (req, res) => {
  try {
    const { jobId } = req.params;

    const jobDir = getJobDir(jobId);

    const analysisData = await analyzeRenderedPages(jobDir);
    const outputPath = saveDiagramAnalysis(jobDir, analysisData);

    res.json({
      ok: true,
      jobId,
      status: "diagrams_analyzed",
      totalPagesAnalyzed: analysisData.totalPagesAnalyzed,
      output: path.basename(outputPath),
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message || "Diagram analysis failed",
    });
  }
});

module.exports = router;
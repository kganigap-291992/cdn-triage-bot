// notebook/worker/routes/extract-concepts.js

const express = require("express");
const path = require("path");

const {
  generateConcepts,
  saveConcepts,
} = require("../services/conceptExtractor");

const router = express.Router();

router.post("/:jobId", async (req, res) => {
  try {
    const { jobId } = req.params;

    if (!jobId) {
      return res.status(400).json({
        ok: false,
        error: "Missing jobId",
      });
    }

    const jobDir = path.join(
      process.env.NOTEBOOK_TEMP_DIR || path.join(__dirname, "../temp"),
      jobId
    );

    const conceptsData = await generateConcepts(jobDir);

    const outputPath = saveConcepts(jobDir, conceptsData);

    return res.json({
      ok: true,
      phase: "concept-extraction",
      version: conceptsData.version,
      source: conceptsData.source,
      model: conceptsData.model,
      detectedDomain: conceptsData.detectedDomain,
      jobId,
      conceptCount: conceptsData.conceptCount,
      output: outputPath,
    });
  } catch (error) {
    console.error("extract-concepts error:", error);

    return res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
});

module.exports = router;
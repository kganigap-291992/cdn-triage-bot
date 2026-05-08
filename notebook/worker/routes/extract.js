// notebook/worker/routes/extract.js

const express = require("express");
const path = require("path");

const { getJobDir } = require("../services/jobManager");
const {
  extractPdfText,
  saveExtractedText,
} = require("../services/pdfExtractor");

const router = express.Router();

router.post("/:jobId", async (req, res) => {
  try {
    const { jobId } = req.params;

    const jobDir = getJobDir(jobId);
    const inputPdfPath = path.join(jobDir, "input.pdf");

    const extractedData = await extractPdfText(inputPdfPath);
    const extractedJsonPath = saveExtractedText(jobDir, extractedData);

    res.json({
      ok: true,
      jobId,
      status: "extracted",
      pageCount: extractedData.pageCount,
      textLength: extractedData.text.length,
      output: path.basename(extractedJsonPath),
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message || "PDF extraction failed",
    });
  }
});

module.exports = router;
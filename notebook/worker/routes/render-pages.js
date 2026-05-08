// notebook/worker/routes/render-pages.js

const express = require("express");
const path = require("path");

const { getJobDir } = require("../services/jobManager");
const { renderPdfPages } = require("../services/pageRenderer");

const router = express.Router();

router.post("/:jobId", async (req, res) => {
  try {
    const { jobId } = req.params;

    const jobDir = getJobDir(jobId);
    const inputPdfPath = path.join(jobDir, "input.pdf");

    const renderedPages = await renderPdfPages(inputPdfPath, jobDir);

    res.json({
      ok: true,
      jobId,
      status: "pages_rendered",
      pageImageCount: renderedPages.length,
      pages: renderedPages.map((page) => page.fileName),
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message || "Failed to render PDF pages",
    });
  }
});

module.exports = router;
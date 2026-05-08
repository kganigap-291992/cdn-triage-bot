const express = require("express");
const path = require("path");

const { renderVideo } = require("../services/videoRenderer");

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

    const result = await renderVideo(jobDir);

    return res.json({
      ok: true,
      phase: "video-render",
      jobId,
      outputPath: result.outputPath,
      totalFrames: result.totalFrames,
      sceneCount: result.sceneCount,
    });
  } catch (error) {
    console.error("[render-video] failed", error);

    return res.status(500).json({
      ok: false,
      error: error.message || "Failed to render video",
    });
  }
});

module.exports = router;
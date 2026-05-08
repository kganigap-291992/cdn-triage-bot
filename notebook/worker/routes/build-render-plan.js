const express = require("express");
const path = require("path");

const { createRenderPlan } = require("../services/renderPlan");

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

    const renderPlan = createRenderPlan(jobDir);

    return res.json({
      ok: true,
      phase: "render-plan",
      version: renderPlan.version,
      sceneCount: renderPlan.sceneCount,
      renderPlanPath: path.join(jobDir, "renderPlan.json"),
      scenes: renderPlan.scenes.map((scene) => ({
        sceneIndex: scene.sceneIndex,
        sectionNumber: scene.sectionNumber,
        visualType: scene.visualType,
        speaker: scene.speaker,
      })),
    });
  } catch (error) {
    console.error(
      "[build-render-plan] failed",
      error
    );

    return res.status(500).json({
      ok: false,
      error: error.message || "Failed to build render plan",
    });
  }
});

module.exports = router;
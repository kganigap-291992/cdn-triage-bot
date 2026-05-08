// notebook/worker/routes/generate-dialogue.js

const express = require("express");
const path = require("path");

const { getJobDir } = require("../services/jobManager");
const {
  generateDialogue,
  saveDialogue,
} = require("../services/dialogueGenerator");

const router = express.Router();

router.post("/:jobId", async (req, res) => {
  try {
    const { jobId } = req.params;

    const jobDir = getJobDir(jobId);

    const dialogueData = generateDialogue(jobDir);
    const outputPath = saveDialogue(jobDir, dialogueData);

    res.json({
      ok: true,
      jobId,
      status: "dialogue_generated",
      sectionCount: dialogueData.sections.length,
      output: path.basename(outputPath),
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message || "Dialogue generation failed",
    });
  }
});

module.exports = router;
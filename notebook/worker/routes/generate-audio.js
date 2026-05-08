// notebook/worker/routes/generate-audio.js

const express = require("express");

const { getJobDir } = require("../services/jobManager");
const {
  generateTtsForDialogue,
} = require("../services/ttsGenerator");

const router = express.Router();

router.post("/:jobId", async (req, res) => {
  try {
    const { jobId } = req.params;

    const jobDir = getJobDir(jobId);

    const audioData =
      await generateTtsForDialogue(jobDir);

    res.json({
      ok: true,
      jobId,
      status: "audio_generated",
      sectionCount: audioData.sectionCount,
      audioFiles: audioData.sections.map(
        (section) => section.fileName
      ),
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error:
        error.message || "Audio generation failed",
    });
  }
});

module.exports = router;
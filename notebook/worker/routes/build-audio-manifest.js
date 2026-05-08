// notebook/worker/routes/build-audio-manifest.js

const express = require("express");
const path = require("path");

const { getJobDir } = require("../services/jobManager");

const {
  buildAudioManifest,
  saveAudioManifest,
} = require("../services/audioManifest");

const router = express.Router();

router.post("/:jobId", async (req, res) => {
  try {
    const { jobId } = req.params;

    const jobDir = getJobDir(jobId);

    const manifestData =
      buildAudioManifest(jobDir);

    const outputPath = saveAudioManifest(
      jobDir,
      manifestData
    );

    res.json({
      ok: true,
      jobId,
      status: "audio_manifest_built",
      sectionCount: manifestData.sectionCount,
      output: path.basename(outputPath),
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error:
        error.message ||
        "Failed to build audio manifest",
    });
  }
});

module.exports = router;
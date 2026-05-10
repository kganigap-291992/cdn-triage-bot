// notebook/worker/routes/generate-audio.js

const express = require("express");
const fs = require("fs");
const path = require("path");

const { getJobDir } = require("../services/jobManager");

const {
  generateTtsForDialogue,
} = require("../services/ttsGenerator");

const {
  buildAudioManifest,
  saveAudioManifest,
} = require("../services/audioManifest");

const router = express.Router();

function cleanupOldAudioArtifacts(jobDir) {
  const audioDir = path.join(jobDir, "audio");
  const audioManifestPath = path.join(jobDir, "audio-manifest.json");

  const removedFiles = [];

  if (fs.existsSync(audioManifestPath)) {
    try {
      fs.unlinkSync(audioManifestPath);
      removedFiles.push("audio-manifest.json");
    } catch (error) {
      console.warn(
        "[audio-cleanup] failed to remove audio-manifest.json",
        error.message
      );
    }
  }

  if (!fs.existsSync(audioDir)) {
    return {
      removedFiles,
    };
  }

  const files = fs.readdirSync(audioDir);

  for (const file of files) {
    const lower = file.toLowerCase();

    const shouldDelete =
      lower.endsWith(".mp3") ||
      lower.endsWith(".wav") ||
      lower.endsWith(".json");

    if (!shouldDelete) continue;

    const fullPath = path.join(audioDir, file);

    try {
      fs.unlinkSync(fullPath);
      removedFiles.push(file);
    } catch (error) {
      console.warn(
        "[audio-cleanup] failed to remove",
        file,
        error.message
      );
    }
  }

  return {
    removedFiles,
  };
}

router.post("/:jobId", async (req, res) => {
  try {
    const { jobId } = req.params;

    const jobDir = getJobDir(jobId);

    const cleanupResult =
      cleanupOldAudioArtifacts(jobDir);

    console.log("[audio-cleanup]", {
      jobId,
      removedFiles: cleanupResult.removedFiles,
    });

    const audioData =
      await generateTtsForDialogue(jobDir);

    const manifestData =
      buildAudioManifest(jobDir);

    const audioManifestPath =
      saveAudioManifest(jobDir, manifestData);

    res.json({
      ok: true,
      jobId,
      status: "audio_generated",
      cleanedOldArtifacts: true,
      removedFiles: cleanupResult.removedFiles,
      sectionCount: audioData.sectionCount,
      manifestSectionCount: manifestData.sectionCount,
      audioManifestPath,
      audioManifestVersion: manifestData.version,
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
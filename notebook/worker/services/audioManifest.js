// notebook/worker/services/audioManifest.js

const fs = require("fs");
const path = require("path");

function getAudioManifestPath(jobDir) {
  return path.join(jobDir, "audio-manifest.json");
}

function buildAudioManifest(jobDir) {
  const dialoguePath = path.join(jobDir, "dialogue.json");
  const audioDir = path.join(jobDir, "audio");

  const dialogueData = JSON.parse(
    fs.readFileSync(dialoguePath, "utf8")
  );

  const sections = dialogueData.sections.map((section, index) => {
    const sectionNumber = String(index + 1).padStart(3, "0");
    const fileName = `section-${sectionNumber}.mp3`;

    return {
      index,
      sectionNumber,
      speaker: section.speaker,
      type: section.type,
      page: section.page || null,
      text: section.text,
      audioFile: fileName,
      audioPath: path.join(audioDir, fileName),
    };
  });

  return {
    generatedAt: new Date().toISOString(),
    sectionCount: sections.length,
    sections,
  };
}

function saveAudioManifest(jobDir, manifestData) {
  const outputPath = getAudioManifestPath(jobDir);

  fs.writeFileSync(
    outputPath,
    JSON.stringify(manifestData, null, 2)
  );

  return outputPath;
}

module.exports = {
  buildAudioManifest,
  saveAudioManifest,
  getAudioManifestPath,
};
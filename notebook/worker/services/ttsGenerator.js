// notebook/worker/services/ttsGenerator.js

const fs = require("fs");
const path = require("path");

const OpenAI = require("openai");

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

function ensureAudioDir(jobDir) {
  const audioDir = path.join(jobDir, "audio");

  if (!fs.existsSync(audioDir)) {
    fs.mkdirSync(audioDir, { recursive: true });
  }

  return audioDir;
}

function getVoiceForSpeaker(speaker) {
  if (speaker === "New Joiner") {
    return "alloy";
  }

  return "verse";
}

async function generateTtsForDialogue(jobDir) {
  const dialoguePath = path.join(jobDir, "dialogue.json");
  const dialogueData = JSON.parse(
    fs.readFileSync(dialoguePath, "utf8")
  );

  const audioDir = ensureAudioDir(jobDir);

  const audioSections = [];

  for (const [index, section] of dialogueData.sections.entries()) {
    const sectionNumber = String(index + 1).padStart(3, "0");
    const outputFileName = `section-${sectionNumber}.mp3`;
    const outputPath = path.join(audioDir, outputFileName);

    const response = await client.audio.speech.create({
      model: "gpt-4o-mini-tts",
      voice: getVoiceForSpeaker(section.speaker),
      input: section.text,
      format: "mp3",
    });

    const buffer = Buffer.from(await response.arrayBuffer());
    fs.writeFileSync(outputPath, buffer);

    audioSections.push({
      sectionIndex: index,
      speaker: section.speaker,
      type: section.type,
      fileName: outputFileName,
      path: outputPath,
    });
  }

  return {
    generatedAt: new Date().toISOString(),
    sectionCount: audioSections.length,
    audioDir,
    sections: audioSections,
  };
}

module.exports = {
  generateTtsForDialogue,
  ensureAudioDir,
};
// notebook/worker/services/audioManifest.js

const fs = require("fs");
const path = require("path");

function getAudioManifestPath(jobDir) {
  return path.join(jobDir, "audio-manifest.json");
}

function assertFileExists(filePath, label) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`${label} does not exist: ${filePath}`);
  }
}

function getFileSizeBytes(filePath) {
  const stat = fs.statSync(filePath);
  return stat.size;
}

/**
 * Lightweight MP3 duration reader.
 *
 * This avoids adding a new dependency for now.
 * It estimates duration from MP3 frame headers.
 * If parsing fails, we return 0 so renderPlan can still use fallback timing.
 */
function getMp3DurationMs(filePath) {
  const buffer = fs.readFileSync(filePath);

  let offset = 0;

  // Skip ID3v2 tag if present.
  if (
    buffer.length >= 10 &&
    buffer.toString("utf8", 0, 3) === "ID3"
  ) {
    const size =
      ((buffer[6] & 0x7f) << 21) |
      ((buffer[7] & 0x7f) << 14) |
      ((buffer[8] & 0x7f) << 7) |
      (buffer[9] & 0x7f);

    offset = 10 + size;
  }

  const bitrateTable = {
    V1L1: [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
    V1L2: [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
    V1L3: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
    V2L1: [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
    V2L2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
    V2L3: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  };

  const sampleRateTable = {
    MPEG1: [44100, 48000, 32000],
    MPEG2: [22050, 24000, 16000],
    MPEG25: [11025, 12000, 8000],
  };

  let totalSamples = 0;
  let firstBitrateKbps = 0;

  while (offset + 4 <= buffer.length) {
    if (buffer[offset] !== 0xff || (buffer[offset + 1] & 0xe0) !== 0xe0) {
      offset += 1;
      continue;
    }

    const header =
      (buffer[offset] << 24) |
      (buffer[offset + 1] << 16) |
      (buffer[offset + 2] << 8) |
      buffer[offset + 3];

    const versionBits = (header >> 19) & 0x3;
    const layerBits = (header >> 17) & 0x3;
    const bitrateIndex = (header >> 12) & 0xf;
    const sampleRateIndex = (header >> 10) & 0x3;
    const paddingBit = (header >> 9) & 0x1;

    if (
      versionBits === 1 ||
      layerBits === 0 ||
      bitrateIndex === 0 ||
      bitrateIndex === 15 ||
      sampleRateIndex === 3
    ) {
      offset += 1;
      continue;
    }

    const version =
      versionBits === 3
        ? "MPEG1"
        : versionBits === 2
          ? "MPEG2"
          : "MPEG25";

    const layer =
      layerBits === 3
        ? "L1"
        : layerBits === 2
          ? "L2"
          : "L3";

    const bitrateKey =
      version === "MPEG1"
        ? `V1${layer}`
        : `V2${layer}`;

    const bitrateKbps = bitrateTable[bitrateKey]?.[bitrateIndex] || 0;
    const sampleRate = sampleRateTable[version]?.[sampleRateIndex] || 0;

    if (!bitrateKbps || !sampleRate) {
      offset += 1;
      continue;
    }

    if (!firstBitrateKbps) {
      firstBitrateKbps = bitrateKbps;
    }

    const samplesPerFrame =
      layer === "L1"
        ? 384
        : version === "MPEG1"
          ? 1152
          : layer === "L3"
            ? 576
            : 1152;

    let frameLength;

    if (layer === "L1") {
      frameLength = Math.floor(
        ((12 * bitrateKbps * 1000) / sampleRate + paddingBit) * 4
      );
    } else {
      const coefficient =
        version === "MPEG1"
          ? 144
          : layer === "L3"
            ? 72
            : 144;

      frameLength = Math.floor(
        (coefficient * bitrateKbps * 1000) / sampleRate + paddingBit
      );
    }

    if (!frameLength || frameLength <= 0) {
      offset += 1;
      continue;
    }

    totalSamples += samplesPerFrame;
    offset += frameLength;
  }

  if (totalSamples > 0) {
    // Use the first valid sample rate from the file by reparsing first frame.
    let probeOffset = 0;

    if (
      buffer.length >= 10 &&
      buffer.toString("utf8", 0, 3) === "ID3"
    ) {
      const size =
        ((buffer[6] & 0x7f) << 21) |
        ((buffer[7] & 0x7f) << 14) |
        ((buffer[8] & 0x7f) << 7) |
        (buffer[9] & 0x7f);

      probeOffset = 10 + size;
    }

    while (probeOffset + 4 <= buffer.length) {
      if (
        buffer[probeOffset] === 0xff &&
        (buffer[probeOffset + 1] & 0xe0) === 0xe0
      ) {
        const header =
          (buffer[probeOffset] << 24) |
          (buffer[probeOffset + 1] << 16) |
          (buffer[probeOffset + 2] << 8) |
          buffer[probeOffset + 3];

        const versionBits = (header >> 19) & 0x3;
        const sampleRateIndex = (header >> 10) & 0x3;

        const version =
          versionBits === 3
            ? "MPEG1"
            : versionBits === 2
              ? "MPEG2"
              : "MPEG25";

        const sampleRate = sampleRateTable[version]?.[sampleRateIndex] || 0;

        if (sampleRate) {
          return Math.round((totalSamples / sampleRate) * 1000);
        }
      }

      probeOffset += 1;
    }
  }

  // Fallback for constant-bitrate files if frame parsing was not enough.
  if (firstBitrateKbps > 0) {
    const durationSec =
      (getFileSizeBytes(filePath) * 8) /
      (firstBitrateKbps * 1000);

    return Math.round(durationSec * 1000);
  }

  return 0;
}

function buildAudioManifest(jobDir) {
  const dialoguePath = path.join(jobDir, "dialogue.json");
  const audioDir = path.join(jobDir, "audio");

  assertFileExists(dialoguePath, "dialogue.json");
  assertFileExists(audioDir, "audio directory");

  const dialogueData = JSON.parse(
    fs.readFileSync(dialoguePath, "utf8")
  );

  const dialogueSections = Array.isArray(dialogueData.sections)
    ? dialogueData.sections
    : [];

  if (!dialogueSections.length) {
    throw new Error(
      "Cannot build audio manifest: dialogue.json has no sections"
    );
  }

  const sections = dialogueSections.map((section, index) => {
    const sectionNumber = String(index + 1).padStart(3, "0");
    const fileName = `section-${sectionNumber}.mp3`;
    const audioPath = path.join(audioDir, fileName);

    assertFileExists(
      audioPath,
      `Missing audio for dialogue section ${sectionNumber}`
    );

    const sizeBytes = getFileSizeBytes(audioPath);

    if (sizeBytes <= 0) {
      throw new Error(
        `Audio file is empty for dialogue section ${sectionNumber}: ${fileName}`
      );
    }

    const durationMs = getMp3DurationMs(audioPath);

    return {
      index,
      sectionNumber,
      speaker: section.speaker,
      type: section.type,
      page: section.page || null,
      text: section.text,
      audioFile: fileName,
      audioPath,
      sizeBytes,
      durationMs,
      estimatedDurationMs: durationMs,
      teachingUnitId: section.teachingUnitId || null,
      teachingMode: section.teachingMode || null,
      targetDurationSec: section.targetDurationSec || null,
    };
  });

  const mp3Files = fs
    .readdirSync(audioDir)
    .filter((file) => file.toLowerCase().endsWith(".mp3"))
    .sort();

  const expectedFiles = new Set(
    sections.map((section) => section.audioFile)
  );

  const extraAudioFiles = mp3Files.filter(
    (file) => !expectedFiles.has(file)
  );

  if (extraAudioFiles.length) {
    throw new Error(
      `Audio manifest mismatch: found stale extra audio files: ${extraAudioFiles.join(", ")}`
    );
  }

  if (mp3Files.length !== dialogueSections.length) {
    throw new Error(
      `Audio manifest mismatch: dialogue has ${dialogueSections.length} sections but audio directory has ${mp3Files.length} mp3 files`
    );
  }

  const allAudioDurationsDetected = sections.every(
    (section) => Number(section.durationMs || 0) > 0
  );

  return {
    generatedAt: new Date().toISOString(),
    version: "audio-manifest-v3-duration",
    dialogueVersion: dialogueData.version || null,
    dialogueSectionCount: dialogueSections.length,
    audioFileCount: mp3Files.length,
    sectionCount: sections.length,
    sections,
    validation: {
      audioMatchesDialogue: true,
      noExtraAudioFiles: true,
      allAudioFilesNonEmpty: true,
      allAudioDurationsDetected,
    },
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
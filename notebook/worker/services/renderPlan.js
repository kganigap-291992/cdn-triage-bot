const fs = require("fs");
const path = require("path");

const REAL_AUDIO_PADDING_MS = 500;
const FALLBACK_AUDIO_PADDING_MS = 3000;

function readJson(filePath, fallback = null) {
  if (!fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function normalizeSectionNumber(value, index) {
  if (value) return String(value).padStart(3, "0");
  return String(index + 1).padStart(3, "0");
}

function estimateDurationMs(text, audioItem) {
  if (audioItem?.estimatedDurationMs) return audioItem.estimatedDurationMs;
  if (audioItem?.durationMs) return audioItem.durationMs;

  const words = String(text || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;

  return Math.max(
    4000,
    Math.round((words / 145) * 60 * 1000)
  );
}

function resolveSceneDurationMs(text, audioItem) {
  if (audioItem?.durationMs) {
    return audioItem.durationMs + REAL_AUDIO_PADDING_MS;
  }

  return estimateDurationMs(text, audioItem) + FALLBACK_AUDIO_PADDING_MS;
}

function resolveVisualType(type, page) {
  if (type === "intro" || type === "closing") return "title_card";
  if (type === "document_summary") return "summary_card";
  if (type === "diagram_walkthrough" && page != null) return "page_preview_card";
  if (type === "question") return "speaker_card";
  return page != null ? "page_preview_card" : "speaker_card";
}

function resolveVisualIntent(section) {
  const visualIntent = section.visualIntent || {};

  return {
    mode: visualIntent.mode || "default",
    focus: visualIntent.focus || null,
    command: visualIntent.command || null,
    reference: visualIntent.reference || null,
    step: visualIntent.step || null,
    totalSteps: visualIntent.totalSteps || null,
  };
}

function resolveVisualTypeFromIntent(type, page, visualIntent) {
  switch (visualIntent.mode) {
    case "architecture_focus":
      return "architecture_focus_scene";
    case "diagram_guided_focus":
      return "diagram_guided_scene";
    case "workflow_progression":
      return "workflow_scene";
    case "command_focus":
      return "command_scene";
    case "analogy_overlay":
      return "analogy_overlay_scene";
    case "warning_callout":
      return "warning_callout_scene";
    case "debugging_focus":
      return "debugging_focus_scene";
    case "recap_summary":
      return "recap_summary_scene";
    case "transition_bridge":
      return "transition_bridge_scene";
    case "lesson_progress":
      return "lesson_progress_scene";
    default:
      return resolveVisualType(type, page);
  }
}

function buildSceneBehavior(visualIntent) {
  switch (visualIntent.mode) {
    case "architecture_focus":
      return {
        cameraMotion: "slow_zoom",
        overlayMode: "focus_highlight",
        preserveFullPage: true,
      };

    case "diagram_guided_focus":
      return {
        cameraMotion: "guided_pan",
        overlayMode: "diagram_callout",
        preserveFullPage: true,
      };

    case "command_focus":
      return {
        cameraMotion: "static",
        overlayMode: "terminal_overlay",
        preserveFullPage: false,
      };

    case "workflow_progression":
      return {
        cameraMotion: "step_focus",
        overlayMode: "workflow_steps",
        preserveFullPage: true,
      };

    case "analogy_overlay":
      return {
        cameraMotion: "soft_focus",
        overlayMode: "analogy_card",
        preserveFullPage: true,
      };

    case "warning_callout":
      return {
        cameraMotion: "static",
        overlayMode: "warning_card",
        preserveFullPage: true,
      };

    case "debugging_focus":
      return {
        cameraMotion: "guided_pan",
        overlayMode: "debugging_callout",
        preserveFullPage: true,
      };

    case "recap_summary":
      return {
        cameraMotion: "static",
        overlayMode: "recap_cards",
        preserveFullPage: false,
      };

    case "transition_bridge":
      return {
        cameraMotion: "soft_pan",
        overlayMode: "transition_card",
        preserveFullPage: true,
      };

    case "lesson_progress":
      return {
        cameraMotion: "static",
        overlayMode: "progress_badge",
        preserveFullPage: true,
      };

    default:
      return {
        cameraMotion: "static",
        overlayMode: "minimal",
        preserveFullPage: true,
      };
  }
}

function findAudioForSection(audioManifest, sectionNumber, index) {
  const items = Array.isArray(audioManifest?.sections)
    ? audioManifest.sections
    : Array.isArray(audioManifest?.items)
      ? audioManifest.items
      : Array.isArray(audioManifest?.audio)
        ? audioManifest.audio
        : Array.isArray(audioManifest?.files)
          ? audioManifest.files
          : [];

  return (
    items.find(
      (item) =>
        String(item.sectionNumber).padStart(3, "0") === sectionNumber
    ) ||
    items.find(
      (item) =>
        item.sectionIndex === index ||
        item.index === index
    ) ||
    items[index] ||
    null
  );
}

function findPageImage(jobDir, page) {
  if (page == null) {
    return { pageImageFile: null, pageImagePath: null };
  }

  const pageImagesDir = path.join(jobDir, "page-images");

  const candidates = [
    `page-${String(page).padStart(3, "0")}.png`,
    `page-${page}.png`,
    `${page}.png`,
  ];

  for (const file of candidates) {
    const fullPath = path.join(pageImagesDir, file);
    if (fs.existsSync(fullPath)) {
      return {
        pageImageFile: file,
        pageImagePath: fullPath,
      };
    }
  }

  return {
    pageImageFile: null,
    pageImagePath: null,
  };
}

function buildCaption(section) {
  const text = String(section.text || "")
    .replace(/\s+/g, " ")
    .trim();

  if (!text) return "";
  if (text.length <= 120) return text;

  return `${text.slice(0, 117).trim()}...`;
}

function normalizeDialogue(dialogue) {
  if (Array.isArray(dialogue)) return dialogue;
  if (Array.isArray(dialogue?.sections)) return dialogue.sections;
  if (Array.isArray(dialogue?.dialogue)) return dialogue.dialogue;
  if (Array.isArray(dialogue?.messages)) return dialogue.messages;
  return [];
}

function createRenderPlan(jobDir) {
  const dialoguePath = path.join(jobDir, "dialogue.json");
  const audioManifestPath = path.join(jobDir, "audio-manifest.json");
  const diagramAnalysisPath = path.join(jobDir, "diagram-analysis.json");
  const renderPlanPath = path.join(jobDir, "renderPlan.json");

  const dialogue = readJson(dialoguePath);
  const audioManifest = readJson(audioManifestPath, {});
  const diagramAnalysis = readJson(diagramAnalysisPath, {});

  if (!dialogue) {
    throw new Error(`Missing dialogue.json at ${dialoguePath}`);
  }

  const sections = normalizeDialogue(dialogue);

  if (!sections.length) {
    throw new Error("dialogue.json did not contain any dialogue sections");
  }

  const scenes = sections.map((section, index) => {
    const sectionNumber = normalizeSectionNumber(
      section.sectionNumber,
      index
    );

    const page = section.page ?? section.pageNumber ?? null;
    const audioItem = findAudioForSection(
      audioManifest,
      sectionNumber,
      index
    );

    const audioFile =
      audioItem?.audioFile ||
      audioItem?.file ||
      audioItem?.filename ||
      `section-${sectionNumber}.mp3`;

    const audioPath =
      audioItem?.audioPath ||
      audioItem?.path ||
      path.join(jobDir, "audio", audioFile);

    const { pageImageFile, pageImagePath } = findPageImage(jobDir, page);
    const type = section.type || "speaker_card";
    const visualIntent = resolveVisualIntent(section);
    const visualType = resolveVisualTypeFromIntent(type, page, visualIntent);

    return {
      sceneIndex: index,
      sectionNumber,
      speaker: section.speaker || "Senior Engineer",
      type,
      text: section.text || "",
      audioFile,
      audioPath,
      estimatedDurationMs: resolveSceneDurationMs(section.text, audioItem),
      page,
      pageImageFile,
      pageImagePath,
      visualType,
      visualIntent,
      sceneBehavior: buildSceneBehavior(visualIntent),
      caption: section.caption || buildCaption(section),
    };
  });

  const renderPlan = {
    generatedAt: new Date().toISOString(),
    version: "render-plan-v2-visual-intent",
    sceneCount: scenes.length,
    scenes,
    metadata: {
      dialogueVersion: dialogue?.version || null,
      hasVisualIntent: scenes.some(
        (scene) => scene.visualIntent?.mode && scene.visualIntent.mode !== "default"
      ),
      hasAudioManifest: fs.existsSync(audioManifestPath),
      hasDiagramAnalysis: fs.existsSync(diagramAnalysisPath),
      hasPageImages: fs.existsSync(path.join(jobDir, "page-images")),
      diagramAnalysisVersion: diagramAnalysis?.version || null,
      realAudioPaddingMs: REAL_AUDIO_PADDING_MS,
      fallbackAudioPaddingMs: FALLBACK_AUDIO_PADDING_MS,
    },
  };

  writeJson(renderPlanPath, renderPlan);

  return renderPlan;
}

module.exports = {
  createRenderPlan,
};
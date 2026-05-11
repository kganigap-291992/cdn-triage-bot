const fs = require("fs");
const path = require("path");

/**
 * Phase 8C.3B — Focus-Guided Render Plan
 *
 * Goal:
 * - Consume lessonGraph/dialogue focusHint metadata.
 * - Convert pedagogical focus intent into renderable scene metadata.
 * - Keep document/page as the primary visual whenever focusHint says so.
 * - Reduce overlay dominance and fake scene variety.
 *
 * Borrowed ideas:
 * - tldraw: focus region / zoom-to-bounds style viewport intent.
 * - Motion Canvas: explicit visual beats and scene choreography.
 *
 * Cachey adaptation:
 * - lessonGraphBuilder owns pedagogy/focus intent.
 * - renderPlan owns cinematic interpretation.
 * - Root.jsx owns visual rendering only.
 */

const REAL_AUDIO_PADDING_MS = 650;
const FALLBACK_AUDIO_PADDING_MS = 1200;

const MIN_SCENE_DURATION_MS = 3200;
const MAX_REAL_AUDIO_TAIL_MS = 900;
const MAX_TARGET_EXTENSION_MS = 1400;

const DEFAULT_TRANSITION_IN_MS = 360;
const DEFAULT_TRANSITION_OUT_MS = 420;
const DEFAULT_TAIL_HOLD_MS = 420;

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

function validateManifestAgainstDialogue(sections, audioManifest) {
  const manifestSections = Array.isArray(audioManifest?.sections)
    ? audioManifest.sections
    : [];

  if (!manifestSections.length) {
    throw new Error("audio-manifest.json does not contain sections");
  }

  if (manifestSections.length !== sections.length) {
    throw new Error(
      `Render plan validation failed: dialogue has ${sections.length} sections but audio manifest has ${manifestSections.length}`
    );
  }

  for (let index = 0; index < sections.length; index += 1) {
    const dialogueSection = sections[index];
    const manifestSection = manifestSections[index];

    const expectedSectionNumber = normalizeSectionNumber(
      dialogueSection.sectionNumber,
      index
    );

    const actualSectionNumber = normalizeSectionNumber(
      manifestSection.sectionNumber,
      index
    );

    if (expectedSectionNumber !== actualSectionNumber) {
      throw new Error(
        `Render plan validation failed: section mismatch at index ${index}. Dialogue=${expectedSectionNumber}, Manifest=${actualSectionNumber}`
      );
    }

    if (!manifestSection.audioPath) {
      throw new Error(
        `Render plan validation failed: missing audioPath for section ${expectedSectionNumber}`
      );
    }

    if (!fs.existsSync(manifestSection.audioPath)) {
      throw new Error(
        `Render plan validation failed: missing audio file ${manifestSection.audioPath}`
      );
    }
  }
}

function estimateDurationMs(text, audioItem) {
  if (audioItem?.estimatedDurationMs) return audioItem.estimatedDurationMs;
  if (audioItem?.durationMs) return audioItem.durationMs;

  const words = String(text || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;

  return Math.max(4000, Math.round((words / 145) * 60 * 1000));
}

function clampNumber(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function getTargetDurationMs(section) {
  if (
    typeof section?.targetDurationSec === "number" &&
    Number.isFinite(section.targetDurationSec)
  ) {
    return Math.round(section.targetDurationSec * 1000);
  }

  return 0;
}

function resolveSceneTiming(section, audioItem) {
  const audioDurationMs =
    typeof audioItem?.durationMs === "number" && Number.isFinite(audioItem.durationMs)
      ? Math.round(audioItem.durationMs)
      : 0;

  const targetDurationMs = getTargetDurationMs(section);
  const estimatedSpeechDurationMs = estimateDurationMs(section?.text || "", audioItem);
  const hasRealAudio = audioDurationMs > 0;

  if (hasRealAudio) {
    const safeAudioDurationMs = audioDurationMs + REAL_AUDIO_PADDING_MS;

    const targetExtensionMs =
      targetDurationMs > safeAudioDurationMs
        ? clampNumber(targetDurationMs - safeAudioDurationMs, 0, MAX_TARGET_EXTENSION_MS)
        : 0;

    const durationMs = Math.max(
      MIN_SCENE_DURATION_MS,
      safeAudioDurationMs + targetExtensionMs
    );

    const tailHoldMs = clampNumber(
      durationMs - audioDurationMs,
      DEFAULT_TAIL_HOLD_MS,
      MAX_REAL_AUDIO_TAIL_MS + targetExtensionMs
    );

    return {
      durationMs,
      audioDurationMs,
      estimatedSpeechDurationMs,
      targetDurationMs,
      hasRealAudio: true,
      timingSource: targetExtensionMs > 0
        ? "audio_duration_plus_limited_target"
        : "audio_duration",
      transitionInMs: DEFAULT_TRANSITION_IN_MS,
      transitionOutMs: DEFAULT_TRANSITION_OUT_MS,
      tailHoldMs,
      motionWindowMs: Math.max(1000, durationMs - DEFAULT_TRANSITION_IN_MS),
    };
  }

  const fallbackDurationMs = Math.max(
    MIN_SCENE_DURATION_MS,
    estimatedSpeechDurationMs + FALLBACK_AUDIO_PADDING_MS,
    targetDurationMs
  );

  return {
    durationMs: fallbackDurationMs,
    audioDurationMs: 0,
    estimatedSpeechDurationMs,
    targetDurationMs,
    hasRealAudio: false,
    timingSource: targetDurationMs > estimatedSpeechDurationMs
      ? "target_duration_fallback"
      : "estimated_duration",
    transitionInMs: DEFAULT_TRANSITION_IN_MS,
    transitionOutMs: DEFAULT_TRANSITION_OUT_MS,
    tailHoldMs: FALLBACK_AUDIO_PADDING_MS,
    motionWindowMs: Math.max(1000, fallbackDurationMs - DEFAULT_TRANSITION_IN_MS),
  };
}

function resolveVisualType(type, page) {
  if (type === "intro" || type === "closing") return "title_card";
  if (type === "document_summary") return "summary_card";
  if (type === "diagram_walkthrough" && page != null) return "page_preview_card";
  if (type === "question") return "speaker_card";
  return page != null ? "page_preview_card" : "speaker_card";
}

function resolveFocusHint(section) {
  const direct =
    section.focusHint ||
    section.visualIntent?.focusHint ||
    section.metadata?.focusHint ||
    null;

  if (direct && typeof direct === "object") {
    return direct;
  }

  return null;
}

function resolveVisualIntent(section) {
  const visualIntent = section.visualIntent || {};
  const focusHint = resolveFocusHint(section);

  return {
    mode: visualIntent.mode || "default",
    focus: visualIntent.focus || focusHint?.label || null,
    command: visualIntent.command || null,
    reference: visualIntent.reference || null,
    step: visualIntent.step || null,
    totalSteps: visualIntent.totalSteps || null,
    presentationStyle: visualIntent.presentationStyle || null,
    sceneIntent: visualIntent.sceneIntent || null,
    focusHint,
    focusRegion: focusHint?.focusRegion || null,
    cameraIntent: focusHint?.cameraIntent || null,
    overlayMode: focusHint?.overlayMode || null,
    keepDocumentPrimary: Boolean(focusHint?.keepDocumentPrimary),
    reduceOverlayDominance: Boolean(focusHint?.reduceOverlayDominance),
    avoidFullSceneReset: Boolean(focusHint?.avoidFullSceneReset),
  };
}

function shouldUseFocusGuidedVisual(page, visualIntent) {
  return Boolean(
    page != null &&
    visualIntent?.focusHint &&
    visualIntent?.keepDocumentPrimary
  );
}

function resolveVisualTypeFromIntent(type, page, visualIntent) {
  if (shouldUseFocusGuidedVisual(page, visualIntent)) {
    return "focus_guided_document_scene";
  }

  switch (visualIntent.presentationStyle) {
    case "command_reference_dominant":
      return "command_reference_scene";

    case "operational_signal_overlay":
      return "operational_signal_scene";

    case "workflow_context_card":
      return "workflow_context_scene";

    case "diagram_dominant":
      return "diagram_dominant_scene";

    case "component_focus":
      return "component_focus_scene";

    case "flow_walkthrough":
      return "flow_walkthrough_scene";

    case "step_reference_dominant":
      return "step_reference_scene";

    case "verification_focus":
      return "verification_focus_scene";

    case "decision_checkpoint":
      return "decision_checkpoint_scene";

    case "recap_summary_card":
      return "recap_summary_scene";

    case "document_reference_dominant":
      return "document_reference_scene";

    case "concept_overlay_support":
      return "concept_overlay_scene";

    default:
      break;
  }

  switch (visualIntent.mode) {
    case "architecture_focus":
      return "architecture_focus_scene";

    case "diagram_guided_focus":
      return "diagram_guided_scene";

    case "workflow_progression":
      return "workflow_scene";

    case "command_focus":
      return "command_scene";

    case "grouped_reference_card":
      return "command_scene";

    case "quick_debugging_flow":
      return "debugging_focus_scene";

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

    case "learner_overlay":
      return "speaker_card";

    default:
      return resolveVisualType(type, page);
  }
}

function getCameraMotionFromFocusHint(focusHint) {
  switch (focusHint?.cameraIntent) {
    case "zoom_top_section":
      return "focus_top";
    case "zoom_upper_middle_section":
      return "focus_upper_middle";
    case "zoom_middle_section":
      return "focus_middle";
    case "zoom_lower_middle_section":
      return "focus_lower_middle";
    case "zoom_lower_section":
      return "focus_lower";
    case "zoom_bottom_section":
      return "focus_bottom";
    case "guided_document_focus":
      return "guided_focus";
    default:
      return "guided_focus";
  }
}

function buildFocusGuidedBehavior(visualIntent) {
  const focusHint = visualIntent.focusHint || {};

  return {
    cameraMotion: getCameraMotionFromFocusHint(focusHint),
    overlayMode: focusHint.overlayMode || "minimal_context_callout",
    preserveFullPage: true,
    visualPriority: "document_primary_focus_guided",
    focusGuided: true,
    focusTarget: focusHint.target || null,
    focusLabel: focusHint.label || visualIntent.focus || null,
    focusRegion: focusHint.focusRegion || null,
    cameraIntent: focusHint.cameraIntent || null,
    keepDocumentPrimary: true,
    reduceOverlayDominance: true,
    avoidFullSceneReset: true,
  };
}

function buildSceneBehavior(visualIntent) {
  if (visualIntent?.focusHint && visualIntent?.keepDocumentPrimary) {
    return buildFocusGuidedBehavior(visualIntent);
  }

  switch (visualIntent.presentationStyle) {
    case "command_reference_dominant":
      return {
        cameraMotion: "soft_focus",
        overlayMode: "minimal_command_callout",
        preserveFullPage: true,
        visualPriority: "document_primary_command_supporting",
        reduceOverlayDominance: true,
      };

    case "operational_signal_overlay":
      return {
        cameraMotion: "slow_focus",
        overlayMode: "small_signal_callout",
        preserveFullPage: true,
        visualPriority: "document_primary_signal_supporting",
        reduceOverlayDominance: true,
      };

    case "workflow_context_card":
      return {
        cameraMotion: "guided_pan",
        overlayMode: "compact_workflow_steps",
        preserveFullPage: true,
        visualPriority: "workflow_context",
        reduceOverlayDominance: true,
      };

    case "diagram_dominant":
      return {
        cameraMotion: "slow_zoom",
        overlayMode: "minimal",
        preserveFullPage: true,
        visualPriority: "diagram_dominate",
      };

    case "component_focus":
      return {
        cameraMotion: "guided_pan",
        overlayMode: "component_callout",
        preserveFullPage: true,
        visualPriority: "focused_component",
      };

    case "flow_walkthrough":
      return {
        cameraMotion: "flow_pan",
        overlayMode: "flow_overlay",
        preserveFullPage: true,
        visualPriority: "flow_sequence",
      };

    case "document_reference_dominant":
      return {
        cameraMotion: "soft_pan",
        overlayMode: "minimal",
        preserveFullPage: true,
        visualPriority: "document_dominate",
      };

    case "concept_overlay_support":
      return {
        cameraMotion: "soft_focus",
        overlayMode: "concept_support",
        preserveFullPage: true,
        visualPriority: "document_primary_overlay_secondary",
      };

    default:
      break;
  }

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
    case "grouped_reference_card":
      return {
        cameraMotion: "soft_focus",
        overlayMode: "minimal_command_callout",
        preserveFullPage: true,
        reduceOverlayDominance: true,
      };

    case "quick_debugging_flow":
      return {
        cameraMotion: "soft_focus",
        overlayMode: "small_signal_callout",
        preserveFullPage: true,
        reduceOverlayDominance: true,
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
        cameraMotion: "soft_focus",
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

    case "learner_overlay":
      return {
        cameraMotion: "static",
        overlayMode: "learner_card",
        preserveFullPage: false,
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


function getAvailablePageCount(jobDir) {
  const pageImagesDir = path.join(jobDir, "page-images");

  if (!fs.existsSync(pageImagesDir)) {
    return 0;
  }

  return fs
    .readdirSync(pageImagesDir)
    .filter((file) => /^page-\d+\.png$/.test(file))
    .length;
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

  validateManifestAgainstDialogue(sections, audioManifest);

  let timelineCursorMs = 0;

  const scenes = sections.map((section, index) => {
    const sectionNumber = normalizeSectionNumber(section.sectionNumber, index);
    const visualIntentForPage = section.visualIntent || {};
    const focusHintForPage =
    section.focusHint ||
    section.visualIntent?.focusHint ||
    section.metadata?.focusHint ||
    null;

    const explicitPage =
    section.page ??
    section.pageNumber ??
    visualIntentForPage.page ??
    focusHintForPage?.sourcePages?.[0] ??
    null;

    const availablePageCount = getAvailablePageCount(jobDir);

    const fallbackPage =
    availablePageCount > 0 ? 1 : null;

    
    const page = explicitPage ?? fallbackPage;

    const audioItem = findAudioForSection(audioManifest, sectionNumber, index);

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
    const sceneBehavior = buildSceneBehavior(visualIntent);
    const timing = resolveSceneTiming(section, audioItem);

    const startMs = timelineCursorMs;
    const endMs = startMs + timing.durationMs;

    timelineCursorMs = endMs;

    return {
      sceneIndex: index,
      sectionNumber,
      speaker: section.speaker || "Senior Engineer",
      type,
      scenePurpose: type,
      teachingUnitId: section.teachingUnitId || null,
      teachingMode: section.teachingMode || null,
      narrationGoals: section.narrationGoals || [],
      avoidNarration: section.avoidNarration || [],
      text: section.text || "",
      audioFile,
      audioPath,
      audioDurationMs: timing.audioDurationMs,
      estimatedSpeechDurationMs: timing.estimatedSpeechDurationMs,
      targetDurationMs: timing.targetDurationMs,
      estimatedDurationMs: timing.durationMs,
      durationMs: timing.durationMs,
      startMs,
      endMs,
      page,
      pageImageFile,
      pageImagePath,
      visualType,
      visualIntent,
      focusHint: visualIntent.focusHint || null,
      focusRegion: visualIntent.focusRegion || sceneBehavior.focusRegion || null,
      cameraIntent: visualIntent.cameraIntent || sceneBehavior.cameraIntent || null,
      overlayMode: visualIntent.overlayMode || sceneBehavior.overlayMode || null,
      sceneBehavior: {
        ...sceneBehavior,
        transitionInMs: timing.transitionInMs,
        transitionOutMs: timing.transitionOutMs,
        tailHoldMs: timing.tailHoldMs,
        motionWindowMs: timing.motionWindowMs,
        timingSource: timing.timingSource,
      },
      transition: {
        type: sceneBehavior.focusGuided ? "focus_guided_soft_fade" : "soft_fade",
        inMs: timing.transitionInMs,
        outMs: timing.transitionOutMs,
        tailHoldMs: timing.tailHoldMs,
      },
      timingSource: timing.timingSource,
      hasRealAudio: timing.hasRealAudio,
      caption: section.caption || buildCaption(section),
    };
  });

  const totalDurationMs = scenes.length
    ? scenes[scenes.length - 1].endMs
    : 0;

  const timingSources = scenes.reduce((acc, scene) => {
    acc[scene.timingSource] = (acc[scene.timingSource] || 0) + 1;
    return acc;
  }, {});

  const renderPlan = {
    generatedAt: new Date().toISOString(),
    version: "render-plan-v7-focus-guided",
    sceneCount: scenes.length,
    totalDurationMs,
    scenes,
    validation: {
      sceneCountMatchesDialogue: scenes.length === sections.length,
      sceneCountMatchesAudioManifest:
        scenes.length === audioManifest.sections.length,
      audioManifestValidated: true,
    },
    metadata: {
      dialogueVersion: dialogue?.version || null,
      audioManifestVersion: audioManifest?.version || null,
      hasLessonGraph: Boolean(dialogue?.lessonGraph),
      hasTeachingUnitMetadata: scenes.some(
        (scene) => Boolean(scene.teachingUnitId)
      ),
      hasVisualIntent: scenes.some(
        (scene) => scene.visualIntent?.mode && scene.visualIntent.mode !== "default"
      ),
      hasPresentationStyles: scenes.some(
        (scene) => Boolean(scene.visualIntent?.presentationStyle)
      ),
      hasSceneIntents: scenes.some(
        (scene) => Boolean(scene.visualIntent?.sceneIntent)
      ),
      hasFocusHints: scenes.some((scene) => Boolean(scene.focusHint)),
      hasFocusRegions: scenes.some((scene) => Boolean(scene.focusRegion)),
      focusGuidedSceneCount: scenes.filter(
        (scene) => Boolean(scene.sceneBehavior?.focusGuided)
      ).length,
      hasAudioManifest: fs.existsSync(audioManifestPath),
      hasDiagramAnalysis: fs.existsSync(diagramAnalysisPath),
      hasPageImages: fs.existsSync(path.join(jobDir, "page-images")),
      diagramAnalysisVersion: diagramAnalysis?.version || null,
      realAudioPaddingMs: REAL_AUDIO_PADDING_MS,
      fallbackAudioPaddingMs: FALLBACK_AUDIO_PADDING_MS,
      minSceneDurationMs: MIN_SCENE_DURATION_MS,
      maxRealAudioTailMs: MAX_REAL_AUDIO_TAIL_MS,
      maxTargetExtensionMs: MAX_TARGET_EXTENSION_MS,
      defaultTransitionInMs: DEFAULT_TRANSITION_IN_MS,
      defaultTransitionOutMs: DEFAULT_TRANSITION_OUT_MS,
      defaultTailHoldMs: DEFAULT_TAIL_HOLD_MS,
      timingSources,
      timelineSource:
        "audioManifest.durationMs primary | lessonGraph.targetDurationSec advisory | estimatedDurationMs fallback",
      borrowedIdeas: [
        "Motion Canvas-inspired timeline pacing translated into Remotion metadata",
        "tldraw-inspired focusRegion/cameraIntent translated into Cachey scene behavior",
      ],
    },
  };

  writeJson(renderPlanPath, renderPlan);

  return renderPlan;
}

module.exports = {
  createRenderPlan,
};
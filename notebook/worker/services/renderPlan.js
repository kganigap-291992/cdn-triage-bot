const fs = require("fs");
const path = require("path");

/**
 * Phase 8D.15 — Render / Camera Alignment
 *
 * Goal:
 * - Translate lessonGraph pedagogical intent into cinematic camera metadata.
 * - Keep Root.jsx dumb: it should execute scene.cameraPlan / scene.sceneBehavior only.
 * - Architecture overview = broad establishing shot.
 * - Middle architecture scenes = flow-aware focus regions.
 * - Recap = return to full architecture context.
 *
 * Borrowed ideas:
 * - tldraw: zoom-to-bounds / viewport framing / confidence-aware camera targets.
 * - Motion Canvas: explicit beats, timing windows, cinematic choreography metadata.
 *
 * Cachey ownership:
 * - lessonGraphBuilder owns pedagogical intent.
 * - renderPlan owns cinematic translation.
 * - Root.jsx owns visual execution only.
 */

const REAL_AUDIO_PADDING_MS = 650;
const FALLBACK_AUDIO_PADDING_MS = 1200;

const MIN_SCENE_DURATION_MS = 3200;
const MAX_REAL_AUDIO_TAIL_MS = 900;
const MAX_TARGET_EXTENSION_MS = 1400;

const DEFAULT_TRANSITION_IN_MS = 360;
const DEFAULT_TRANSITION_OUT_MS = 420;
const DEFAULT_TAIL_HOLD_MS = 420;
const ARCHITECTURE_OVERVIEW_ORIENTATION_MS = 1800;
const ARCHITECTURE_OVERVIEW_MIN_DURATION_MS = 5200;


const CAMERA_CONFIDENCE = {
  HIGH: "high",
  MEDIUM: "medium",
  LOW: "low",
};

const CAMERA_SCOPE = {
  EXACT: "exact_focus",
  FLOW_REGION: "flow_region",
  BROAD: "broad_context",
  FULL_PAGE: "full_page",
  FULL_ARCHITECTURE: "full_architecture",
};

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

function applyArchitectureEstablishTiming(timing, sceneRole) {
  if (sceneRole !== "architecture_overview") {
    return {
      ...timing,
      narrationDelayMs: 0,
      orientationHoldMs: 0,
    };
  }

  const narrationDelayMs = ARCHITECTURE_OVERVIEW_ORIENTATION_MS;
  const durationMs = Math.max(
    ARCHITECTURE_OVERVIEW_MIN_DURATION_MS,
    timing.durationMs + narrationDelayMs
  );

  return {
    ...timing,
    durationMs,
    narrationDelayMs,
    orientationHoldMs: narrationDelayMs,
    motionWindowMs: Math.max(1000, durationMs - timing.transitionInMs),
    timingSource: `${timing.timingSource}_architecture_establish_hold`,
  };
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

function buildCaption(section) {
  const text = String(section.text || "")
    .replace(/\s+/g, " ")
    .trim();

  if (!text) return "";
  if (text.length <= 120) return text;

  return `${text.slice(0, 117).trim()}...`;
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

function resolveVisualType(type, page) {
  if (type === "intro" || type === "closing") return "title_card";
  if (type === "document_summary") return "summary_card";
  if (type === "diagram_walkthrough" && page != null) return "page_preview_card";
  if (type === "question") return "speaker_card";
  return page != null ? "page_preview_card" : "speaker_card";
}

function isArchitectureScene(section, architectureTraversal) {
  return Boolean(
    architectureTraversal?.enabled ||
    section?.documentType === "architecture" ||
    section?.primaryType === "architecture" ||
    section?.teachingMode === "architecture" ||
    section?.teachingUnitType === "architecture" ||
    section?.visualIntent?.mode === "architecture_focus" ||
    section?.visualIntent?.presentationStyle === "flow_walkthrough"
  );
}

function classifyArchitectureSceneRole(section, index, totalSections) {
  const text = String(section?.text || "").toLowerCase();
  const title = String(section?.title || section?.heading || "").toLowerCase();
  const type = String(section?.type || "").toLowerCase();
  const mode = String(section?.visualIntent?.mode || "").toLowerCase();
  const sceneIntent = String(section?.visualIntent?.sceneIntent || "").toLowerCase();
  const teachingUnitId = String(section?.teachingUnitId || "").toLowerCase();

  const haystack = [
    text,
    title,
    type,
    mode,
    sceneIntent,
    teachingUnitId,
  ].join(" ");

  if (
    index === 0 ||
    haystack.includes("overview") ||
    haystack.includes("at a high level") ||
    haystack.includes("architecture overview")
  ) {
    return "architecture_overview";
  }

  if (
    index === totalSections - 1 ||
    haystack.includes("recap") ||
    haystack.includes("putting") ||
    haystack.includes("together") ||
    haystack.includes("full architecture")
  ) {
    return "architecture_recap";
  }

  if (
    haystack.includes("entry") ||
    haystack.includes("boundary") ||
    haystack.includes("ingress")
  ) {
    return "architecture_entry_boundary";
  }

  if (
    haystack.includes("routing") ||
    haystack.includes("control") ||
    haystack.includes("gateway")
  ) {
    return "architecture_control_routing";
  }

  if (
    haystack.includes("state") ||
    haystack.includes("terminal") ||
    haystack.includes("database") ||
    haystack.includes("persistence")
  ) {
    return "architecture_state_terminal";
  }

  return "architecture_flow_segment";
}

function findChoreographyForScene({ choreographyIntent = [], sceneIndex }) {
  return choreographyIntent[sceneIndex] || null;
}

function findTeachingFocusForScene({ teachingFocusSequence = [], sceneIndex }) {
  return teachingFocusSequence[sceneIndex] || null;
}

function normalizeConfidence(value) {
  const confidence = String(value || "").toLowerCase();

  if (confidence === CAMERA_CONFIDENCE.HIGH) return CAMERA_CONFIDENCE.HIGH;
  if (confidence === CAMERA_CONFIDENCE.MEDIUM) return CAMERA_CONFIDENCE.MEDIUM;

  return CAMERA_CONFIDENCE.LOW;
}

function isUsableFocusRegion(focusRegion) {
  if (!focusRegion || typeof focusRegion !== "object") return false;

  const x = Number(focusRegion.x);
  const y = Number(focusRegion.y);
  const width = Number(focusRegion.width);
  const height = Number(focusRegion.height);

  return (
    Number.isFinite(x) &&
    Number.isFinite(y) &&
    Number.isFinite(width) &&
    Number.isFinite(height) &&
    width > 0 &&
    height > 0 &&
    x >= 0 &&
    y >= 0 &&
    x <= 1 &&
    y <= 1
  );
}

function resolveFocusQuality(focusRegion) {
  const confidence = normalizeConfidence(focusRegion?.confidence);

  if (
    confidence === CAMERA_CONFIDENCE.HIGH &&
    focusRegion?.fitMode === "tight_heading_section"
  ) {
    return "tight";
  }

  if (confidence === CAMERA_CONFIDENCE.HIGH) {
    return "exact";
  }

  if (confidence === CAMERA_CONFIDENCE.MEDIUM) {
    return "balanced";
  }

  return "broad";
}

function resolveViewportStyle(focusRegion) {
  const confidence = normalizeConfidence(focusRegion?.confidence);
  const fitMode = focusRegion?.fitMode || "";

  if (confidence === CAMERA_CONFIDENCE.LOW) {
    return "fit_full_context";
  }

  switch (fitMode) {
    case "tight_heading_section":
      return "fit_tight";

    case "tight_semantic_section":
      return "fit_balanced";

    case "architecture_diagram_region":
    case "broad_architecture_region":
      return "fit_architecture_context";

    default:
      return confidence === CAMERA_CONFIDENCE.HIGH
        ? "fit_precise"
        : "fit_contextual";
  }
}

function resolveFocusPadding(focusRegion) {
  if (focusRegion?.padding) {
    return focusRegion.padding;
  }

  const confidence = normalizeConfidence(focusRegion?.confidence);

  switch (confidence) {
    case CAMERA_CONFIDENCE.HIGH:
      return { x: 0.018, y: 0.024 };

    case CAMERA_CONFIDENCE.MEDIUM:
      return { x: 0.04, y: 0.055 };

    default:
      return { x: 0.08, y: 0.1 };
  }
}

function resolveCameraProfile(focusRegion) {
  const quality = resolveFocusQuality(focusRegion);

  switch (quality) {
    case "tight":
    case "exact":
      return "exact_entity_focus";

    case "balanced":
      return "broader_flow_region_focus";

    default:
      return "safe_full_context_focus";
  }
}

function resolveCameraScope(focusRegion, sceneRole) {
  if (
    sceneRole === "architecture_overview" ||
    sceneRole === "architecture_recap"
  ) {
    return CAMERA_SCOPE.FULL_ARCHITECTURE;
  }

  if (!isUsableFocusRegion(focusRegion)) {
    return CAMERA_SCOPE.FULL_PAGE;
  }

  const confidence = normalizeConfidence(focusRegion?.confidence);

  if (confidence === CAMERA_CONFIDENCE.HIGH) {
    return CAMERA_SCOPE.EXACT;
  }

  if (confidence === CAMERA_CONFIDENCE.MEDIUM) {
    return CAMERA_SCOPE.FLOW_REGION;
  }

  return CAMERA_SCOPE.FULL_PAGE;
}

function resolveMotionIntent({ section, sceneRole, teachingFocus, choreography }) {
  if (sceneRole === "architecture_overview") {
    return "establish_full_architecture";
  }

  if (sceneRole === "architecture_recap") {
    return "return_to_full_architecture";
  }

  const explicit =
    choreography?.motionIntent ||
    choreography?.cameraMotion ||
    section?.visualIntent?.motionIntent ||
    section?.visualIntent?.cameraIntent ||
    section?.focusHint?.cameraIntent ||
    section?.visualIntent?.focusHint?.cameraIntent ||
    null;

  if (explicit) return explicit;

  if (teachingFocus?.reason === "flow_entry_point") {
    return "zoom_to_flow_entry";
  }

  if (teachingFocus?.reason === "flow_destination") {
    return "settle_on_flow_destination";
  }

  if (teachingFocus?.reason === "handoff" || teachingFocus?.reason === "flow_transition") {
    return "follow_flow_to_component";
  }

  return "follow_flow_to_component";
}

function resolveCameraStyle({ motionIntent, cameraScope }) {
  if (cameraScope === CAMERA_SCOPE.FULL_ARCHITECTURE) {
    if (motionIntent === "return_to_full_architecture") {
      return "slow_zoom_out_recap";
    }

    return "broad_establishing_hold";
  }

  if (cameraScope === CAMERA_SCOPE.FULL_PAGE) {
    return "safe_full_page_hold";
  }

  switch (motionIntent) {
    case "zoom_to_flow_entry":
      return "gentle_zoom_to_entry";

    case "follow_flow_to_component":
      return "smooth_pan_soft_zoom";

    case "settle_on_flow_destination":
      return "gentle_settle_on_destination";

    default:
      return "soft_contextual_camera_move";
  }
}

function resolveFocusPriority({ sceneRole, teachingFocus, choreography }) {
  if (sceneRole === "architecture_overview") return "system_orientation";
  if (sceneRole === "architecture_recap") return "system_recap";

  return (
    choreography?.focusPriority ||
    teachingFocus?.reason ||
    "handoff"
  );
}

function buildCameraPlan({
  section,
  visualIntent,
  focusRegion,
  sceneRole,
  teachingFocus,
  choreography,
  timing,
}) {
  const confidence = normalizeConfidence(
    focusRegion?.confidence ||
    teachingFocus?.confidence ||
    choreography?.confidence
  );

  const cameraScope = resolveCameraScope(focusRegion, sceneRole);
  const motionIntent = resolveMotionIntent({
    section,
    sceneRole,
    teachingFocus,
    choreography,
  });

  const cameraStyle = resolveCameraStyle({
    motionIntent,
    cameraScope,
  });

  const focusPriority = resolveFocusPriority({
    sceneRole,
    teachingFocus,
    choreography,
  });

  const hasUsableFocusRegion = isUsableFocusRegion(focusRegion);

  return {
    version: "camera-plan-v1-render-aligned",
    enabled: true,

    ownership: {
      pedagogicalIntentSource: "lessonGraph",
      cinematicTranslationOwner: "renderPlan",
      executionOwner: "Root.jsx",
    },

    motionIntent,
    cameraStyle,
    focusPriority,

    confidence,
    cameraScope,
    stabilityRule:
      "high=exact zoom | medium=broad flow region | low=section/full-page fallback",

    target: {
      mode: hasUsableFocusRegion ? "focus_region" : "safe_default",
      focusRegion: hasUsableFocusRegion ? focusRegion : null,
      fallback:
        cameraScope === CAMERA_SCOPE.FULL_ARCHITECTURE
          ? "full_architecture"
          : "full_page",
      label:
        visualIntent?.focus ||
        visualIntent?.focusHint?.label ||
        teachingFocus?.entityId ||
        null,
      entityId: teachingFocus?.entityId || null,
      flowGroupId: teachingFocus?.flowGroupId || null,
    },

    viewport: {
      style: resolveViewportStyle(focusRegion),
      padding: resolveFocusPadding(focusRegion),
      profile: resolveCameraProfile(focusRegion),
      preserveFullPage:
        cameraScope === CAMERA_SCOPE.FULL_ARCHITECTURE ||
        cameraScope === CAMERA_SCOPE.FULL_PAGE,
      avoidConfidentWrongFocus: true,
    },

    beats: buildMotionBeats({
      sceneRole,
      motionIntent,
      cameraStyle,
      cameraScope,
      timing,
    }),
  };
}

function buildMotionBeats({
  sceneRole,
  motionIntent,
  cameraStyle,
  cameraScope,
  timing,
}) {
  const motionWindowMs = timing?.motionWindowMs || 1000;

  if (sceneRole === "architecture_overview") {
  const orientationHoldMs = timing?.orientationHoldMs || ARCHITECTURE_OVERVIEW_ORIENTATION_MS;
  const pushStartMs = Math.min(orientationHoldMs, Math.round(motionWindowMs * 0.45));

  return [
    {
      at: 0,
      durationMs: pushStartMs,
      action: "orientation_hold",
      cameraStyle: "broad_establishing_hold",
      narration: "silent",
    },
    {
      at: pushStartMs,
      durationMs: Math.max(800, motionWindowMs - pushStartMs),
      action: "subtle_push_in",
      cameraStyle: "progressive_semantic_zoom",
      narration: "begin_after_orientation",
    },
  ];
}

  if (sceneRole === "architecture_recap") {
    return [
      {
        at: 0,
        durationMs: Math.round(motionWindowMs * 0.55),
        action: "zoom_out",
        cameraStyle: "slow_zoom_out_recap",
      },
      {
        at: Math.round(motionWindowMs * 0.55),
        durationMs: Math.round(motionWindowMs * 0.45),
        action: "hold_full_system",
        cameraStyle: "broad_establishing_hold",
      },
    ];
  }

  if (cameraScope === CAMERA_SCOPE.FULL_PAGE) {
    return [
      {
        at: 0,
        durationMs: motionWindowMs,
        action: "safe_hold",
        cameraStyle: "safe_full_page_hold",
      },
    ];
  }

  return [
    {
      at: 0,
      durationMs: Math.round(motionWindowMs * 0.3),
      action: "orient",
      cameraStyle: "soft_contextual_camera_move",
    },
    {
      at: Math.round(motionWindowMs * 0.3),
      durationMs: Math.round(motionWindowMs * 0.7),
      action: motionIntent,
      cameraStyle,
    },
  ];
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

function shouldUseFocusGuidedVisual(page, visualIntent) {
  return Boolean(
    page != null &&
    visualIntent?.focusHint &&
    visualIntent?.keepDocumentPrimary
  );
}

function resolveVisualTypeFromIntent(type, page, visualIntent, sceneRole) {
  if (sceneRole === "architecture_overview") {
    return "architecture_overview_scene";
  }

  if (sceneRole === "architecture_recap") {
    return "architecture_recap_scene";
  }

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

function buildSceneBehavior(visualIntent, cameraPlan) {
  if (cameraPlan?.enabled) {
    return {
      cameraMotion: cameraPlan.motionIntent,
      cameraStyle: cameraPlan.cameraStyle,
      cameraScope: cameraPlan.cameraScope,
      overlayMode:
        visualIntent.overlayMode ||
        visualIntent.focusHint?.overlayMode ||
        "minimal_context_callout",
      preserveFullPage: cameraPlan.viewport?.preserveFullPage !== false,
      visualPriority:
        cameraPlan.cameraScope === CAMERA_SCOPE.FULL_ARCHITECTURE
          ? "architecture_full_context"
          : "architecture_flow_aligned",
      focusGuided: cameraPlan.target?.mode === "focus_region",
      focusTarget: cameraPlan.target?.entityId || null,
      focusLabel: cameraPlan.target?.label || null,
      focusRegion: cameraPlan.target?.focusRegion || null,
      cameraIntent: cameraPlan.motionIntent,
      keepDocumentPrimary: true,
      reduceOverlayDominance: true,
      avoidFullSceneReset: true,
      avoidConfidentWrongFocus: true,
    };
  }

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

function resolveSpokenFocus(section) {
  return (
    section.spokenFocus ||
    section.visualIntent?.spokenFocus ||
    null
  );
}

function resolveSpokenFocusTargets(section) {
  if (Array.isArray(section.spokenFocusTargets)) {
    return section.spokenFocusTargets;
  }

  if (Array.isArray(section.visualIntent?.spokenFocusTargets)) {
    return section.visualIntent.spokenFocusTargets;
  }

  return [];
}

function resolvePrimarySpokenFocusTarget(section) {
  const spokenFocus = resolveSpokenFocus(section);

  if (spokenFocus) return spokenFocus;

  const targets = resolveSpokenFocusTargets(section);

  return targets[0] || null;
}

function resolveScenePage({
  section,
  visualIntentForPage,
  focusHintForPage,
  availablePageCount,
}) {
  const explicitPage =
    section.page ??
    section.pageNumber ??
    visualIntentForPage.page ??
    focusHintForPage?.sourcePages?.[0] ??
    null;

  const fallbackPage = availablePageCount > 0 ? 1 : null;

  return explicitPage ?? fallbackPage;
}

function createRenderPlan(jobDir) {
  const dialoguePath = path.join(jobDir, "dialogue.json");
  const audioManifestPath = path.join(jobDir, "audio-manifest.json");
  const diagramAnalysisPath = path.join(jobDir, "diagram-analysis.json");
  const renderPlanPath = path.join(jobDir, "renderPlan.json");

  const dialogue = readJson(dialoguePath);
  const lessonGraph = dialogue?.lessonGraph || {};
  const architectureTraversal = lessonGraph?.architectureTraversal || {};
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

  const availablePageCount = getAvailablePageCount(jobDir);
  let timelineCursorMs = 0;

  const scenes = sections.map((section, index) => {
    const choreographyMetadata = findChoreographyForScene({
      choreographyIntent: architectureTraversal.choreographyIntent || [],
      sceneIndex: index,
    });

    const teachingFocusMetadata = findTeachingFocusForScene({
      teachingFocusSequence: architectureTraversal.teachingFocusSequence || [],
      sceneIndex: index,
    });

    const sectionNumber = normalizeSectionNumber(section.sectionNumber, index);
    const visualIntentForPage = section.visualIntent || {};
    const focusHintForPage =
      section.focusHint ||
      section.visualIntent?.focusHint ||
      section.metadata?.focusHint ||
      null;

    const page = resolveScenePage({
      section,
      visualIntentForPage,
      focusHintForPage,
      availablePageCount,
    });

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

    const architectureScene = isArchitectureScene(section, architectureTraversal);
    const sceneRole = architectureScene
      ? classifyArchitectureSceneRole(section, index, sections.length)
      : "standard_scene";

    const rawFocusRegion =
      visualIntent.focusRegion ||
      section.focusRegion ||
      section.metadata?.focusRegion ||
      choreographyMetadata?.focusRegion ||
      teachingFocusMetadata?.focusRegion ||
      null;

    const baseTiming = resolveSceneTiming(section, audioItem);
    const timing = applyArchitectureEstablishTiming(baseTiming, sceneRole);

    const cameraPlan = architectureScene
      ? buildCameraPlan({
          section,
          visualIntent,
          focusRegion: rawFocusRegion,
          sceneRole,
          teachingFocus: teachingFocusMetadata,
          choreography: choreographyMetadata,
          timing,
        })
      : null;

    const visualType = resolveVisualTypeFromIntent(
      type,
      page,
      visualIntent,
      sceneRole
    );

    const sceneBehavior = buildSceneBehavior(visualIntent, cameraPlan);

    const startMs = timelineCursorMs;
    const endMs = startMs + timing.durationMs;

    timelineCursorMs = endMs;

    const resolvedFocusRegion =
      cameraPlan?.target?.focusRegion ||
      visualIntent.focusRegion ||
      sceneBehavior.focusRegion ||
      null;

    return {
      sceneIndex: index,
      sectionNumber,
      speaker: section.speaker || "Senior Engineer",
      type,
      scenePurpose: type,
      sceneRole,

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
      narrationDelayMs: timing.narrationDelayMs || 0,
      orientationHoldMs: timing.orientationHoldMs || 0,

      page,
      pageImageFile,
      pageImagePath,

      visualType,
      visualIntent,

      semanticTraversal: {
        teachingFocus: teachingFocusMetadata,
        choreography: choreographyMetadata,
      },

      cameraPlan,

      spokenFocus: resolvePrimarySpokenFocusTarget(section),
      spokenFocusTargets: resolveSpokenFocusTargets(section),

      focusHint: visualIntent.focusHint || null,
      focusRegion: resolvedFocusRegion,
      cameraIntent:
        cameraPlan?.motionIntent ||
        visualIntent.cameraIntent ||
        sceneBehavior.cameraIntent ||
        null,
      overlayMode: visualIntent.overlayMode || sceneBehavior.overlayMode || null,

      focusQuality: resolveFocusQuality(resolvedFocusRegion),
      viewportStyle: resolveViewportStyle(resolvedFocusRegion),
      focusPadding: resolveFocusPadding(resolvedFocusRegion),
      cameraProfile: resolveCameraProfile(resolvedFocusRegion),

      sceneBehavior: {
        ...sceneBehavior,
        transitionInMs: timing.transitionInMs,
        transitionOutMs: timing.transitionOutMs,
        tailHoldMs: timing.tailHoldMs,
        motionWindowMs: timing.motionWindowMs,
        timingSource: timing.timingSource,

        narrationDelayMs: timing.narrationDelayMs || 0,
        orientationHoldMs: timing.orientationHoldMs || 0,
      },

      transition: {
        type: cameraPlan?.enabled
          ? "semantic_camera_soft_fade"
          : sceneBehavior.focusGuided
            ? "focus_guided_soft_fade"
            : "soft_fade",
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

  const cameraPlanSceneCount = scenes.filter(
    (scene) => Boolean(scene.cameraPlan?.enabled)
  ).length;

  const architectureSceneCount = scenes.filter(
    (scene) => scene.sceneRole && scene.sceneRole.startsWith("architecture_")
  ).length;

  const renderPlan = {
    generatedAt: new Date().toISOString(),
    version: "render-plan-v9-architecture-camera-alignment",
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

      phase: "8D.15-render-camera-alignment",

      ownership: {
        lessonGraph: "pedagogical intent",
        renderPlan: "cinematic translation",
        rootJsx: "execution only",
      },

      hasLessonGraph: Boolean(dialogue?.lessonGraph),

      hasArchitectureTraversal: Boolean(
        architectureTraversal?.enabled
      ),

      hasChoreographyIntent: Array.isArray(
        architectureTraversal?.choreographyIntent
      ),

      hasTeachingFocusSequence: Array.isArray(
        architectureTraversal?.teachingFocusSequence
      ),

      architectureSceneCount,
      cameraPlanSceneCount,

      cameraAlignmentRules: {
        overview: "broad establishing shot",
        middleScenes: "flow-aware region traversal",
        recap: "return to full architecture",
        confidence:
          "high confidence = exact zoom | medium = broader flow region | low = section/full-page fallback",
        safety: "never let the camera be confidently wrong",
      },

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
      hasSpokenFocusTargets: scenes.some(
        (scene) =>
          Array.isArray(scene.spokenFocusTargets) &&
          scene.spokenFocusTargets.length > 0
      ),
      spokenFocusSceneCount: scenes.filter(
        (scene) => Boolean(scene.spokenFocus)
      ).length,
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
        "Motion Canvas-inspired visual beats and scene choreography translated into renderPlan.cameraPlan.beats",
        "tldraw-inspired zoom-to-bounds / viewport framing translated into renderPlan.cameraPlan.viewport",
        "Cachey confidence contract: high exact zoom, medium broad flow region, low safe fallback",
      ],
    },
  };

  writeJson(renderPlanPath, renderPlan);

  return renderPlan;
}

module.exports = {
  createRenderPlan,
};
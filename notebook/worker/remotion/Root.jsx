const React = require("react");
const {
  AbsoluteFill,
  Audio,
  Img,
  Sequence,
  staticFile,
  useCurrentFrame,
  interpolate,
  Easing,
} = require("remotion");

const FPS = 30;

const VIDEO_WIDTH = 1920;
const VIDEO_HEIGHT = 1080;

const LEFT_RAIL_WIDTH = 320;
const OUTER_PAD = 42;
const TOP_BAR_HEIGHT = 118;
const BOTTOM_BAR_HEIGHT = 74;
const STAGE_GAP = 24;
const PAGE_STAGE_INSET = 18;

const MUTED_TOPICS = new Set([
  "document overview",
  "overview",
  "welcome",
  "recap",
  "key takeaways",
  "wrap up",
  "closing",
]);

function msToFrames(ms) {
  return Math.max(1, Math.round((ms / 1000) * FPS));
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function dedupeKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function getStaticAssetPath(path) {
  if (!path) return null;

  const text = String(path);
  const tempIndex = text.indexOf("/temp/");
  if (tempIndex >= 0) return text.slice(tempIndex + 1);

  const publicIndex = text.indexOf("/public/");
  if (publicIndex >= 0) return text.slice(publicIndex + "/public/".length);

  return text.replace(/^\/+/, "");
}

function safeTitle(value, fallback = "Cachey Notebook") {
  const text = String(value || "").trim();
  return text || fallback;
}

function getSceneDurationFrames(scene) {
  return msToFrames(scene.durationMs || scene.estimatedDurationMs || 4000);
}

function getProgress(durationFrames) {
  const frame = useCurrentFrame();
  if (durationFrames <= 1) return 1;
  return clamp(frame / durationFrames, 0, 1);
}

function getTransitionFrames(scene, durationFrames) {
  const transition = scene.transition || {};
  const behavior = scene.sceneBehavior || {};

  const inMs = transition.inMs || behavior.transitionInMs || 420;
  const outMs = transition.outMs || behavior.transitionOutMs || 520;

  return {
    inFrames: clamp(msToFrames(inMs), 5, Math.max(5, Math.floor(durationFrames / 3))),
    outFrames: clamp(msToFrames(outMs), 5, Math.max(5, Math.floor(durationFrames / 3))),
  };
}

function getSceneOpacity(scene, durationFrames) {
  const frame = useCurrentFrame();
  const { inFrames, outFrames } = getTransitionFrames(scene, durationFrames);

  const fadeInOpacity = interpolate(frame, [0, inFrames], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.cubic),
  });

  const fadeOutOpacity = interpolate(
    frame,
    [Math.max(0, durationFrames - outFrames), durationFrames],
    [1, 0],
    {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
      easing: Easing.in(Easing.cubic),
    }
  );

  return Math.min(fadeInOpacity, fadeOutOpacity);
}

function getSceneEntranceStyle(scene, durationFrames) {
  const frame = useCurrentFrame();
  const { inFrames } = getTransitionFrames(scene, durationFrames);

  const y = interpolate(frame, [0, inFrames], [10, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.cubic),
  });

  const scale = interpolate(frame, [0, durationFrames], [1.006, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.cubic),
  });

  return {
    opacity: getSceneOpacity(scene, durationFrames),
    transform: `translateY(${y}px) scale(${scale})`,
  };
}

function getOverlayEntranceStyle(delayFrames = 5, durationFramesOverride) {
  const frame = useCurrentFrame();
  const durationFrames = durationFramesOverride || 9999;

  const opacityIn = interpolate(frame, [delayFrames, delayFrames + 14], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.cubic),
  });

  const opacityOut = interpolate(
    frame,
    [Math.max(0, durationFrames - 16), durationFrames],
    [1, 0],
    {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
      easing: Easing.in(Easing.cubic),
    }
  );

  const y = interpolate(frame, [delayFrames, delayFrames + 14], [12, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.cubic),
  });

  return {
    opacity: Math.min(opacityIn, opacityOut),
    transform: `translateY(${y}px)`,
  };
}

function getBackgroundMotionStyle(scene) {
  const durationFrames = getSceneDurationFrames(scene || {});
  const progress = Easing.inOut(Easing.cubic)(getProgress(durationFrames));

  const driftX = interpolate(progress, [0, 1], [-8, 8]);
  const driftY = interpolate(progress, [0, 1], [5, -5]);
  const scale = interpolate(progress, [0, 1], [1, 1.014]);

  return {
    transform: `translate(${driftX}px, ${driftY}px) scale(${scale})`,
  };
}

function getSceneTitle(scene) {
  if (scene.title) return scene.title;
  if (scene.focusRegion?.label) return scene.focusRegion.label;
  if (scene.visualIntent?.focus) return scene.visualIntent.focus;
  if (scene.caption) return scene.caption;
  if (scene.type === "intro") return "Welcome";
  if (scene.type === "document_summary") return "Big Picture";
  if (scene.type === "diagram_walkthrough") return "Architecture Walkthrough";
  if (scene.type === "concept_simplification") return "Mental Model";
  if (scene.type === "common_mistake") return "Common Mistake";
  if (scene.type === "recap") return "Key Takeaways";
  if (scene.type === "closing") return "Wrap Up";
  if (scene.type === "command_group_teaching") return "Command Focus";
  if (scene.type === "topic_workflow") return "Operational Flow";
  if (scene.type === "topic_analogy") return "Simple Analogy";
  if (scene.type === "debugging_intuition") return "Debugging Intuition";
  return "Cachey Notebook";
}

function getShortSubtitle(scene) {
  if (scene.subtitle) return scene.subtitle;

  const title = dedupeKey(scene.focusRegion?.label || scene.title || getSceneTitle(scene));

  if (title.includes("cluster") || title.includes("context")) {
    return "Check cluster access and current context";
  }

  if (title.includes("pod")) {
    return "Inspect workload health and runtime status";
  }

  if (title.includes("service")) {
    return "Discover and connect to service endpoints";
  }

  if (title.includes("label") || title.includes("selector")) {
    return "Organize and filter Kubernetes resources";
  }

  if (title.includes("yaml") || title.includes("declarative")) {
    return "Operational deployment workflow";
  }

  if (title.includes("recap")) {
    return "Key operational takeaways";
  }

  if (scene.focusRegion?.confidence === "low") return "Guided overview";
  if (scene.overlayMode === "minimal_command_callout") return "Command reference";
  if (scene.overlayMode === "small_signal_callout") return "Operational signal";
  if (scene.overlayMode === "compact_workflow_steps") return "Workflow pattern";

  return "Document focus";
}

function getReference(scene) {
  return scene?.visualIntent?.reference || "";
}

function getCommand(scene) {
  return scene?.visualIntent?.command || "";
}

function getStageRect() {
  const left = OUTER_PAD + LEFT_RAIL_WIDTH + STAGE_GAP;
  const top = TOP_BAR_HEIGHT;
  const width = VIDEO_WIDTH - left - OUTER_PAD;
  const height = VIDEO_HEIGHT - TOP_BAR_HEIGHT - BOTTOM_BAR_HEIGHT - OUTER_PAD;

  return {
    left,
    top,
    width,
    height,
  };
}

function getContainedImageRect(containerWidth, containerHeight, imageAspectRatio = 8.5 / 11) {
  const containerAspectRatio = containerWidth / containerHeight;

  if (containerAspectRatio > imageAspectRatio) {
    const imageHeight = containerHeight;
    const imageWidth = imageHeight * imageAspectRatio;

    return {
      width: imageWidth,
      height: imageHeight,
      left: (containerWidth - imageWidth) / 2,
      top: 0,
    };
  }

  const imageWidth = containerWidth;
  const imageHeight = imageWidth / imageAspectRatio;

  return {
    width: imageWidth,
    height: imageHeight,
    left: 0,
    top: (containerHeight - imageHeight) / 2,
  };
}

function getFocusRegionStyle(scene, imageRect) {
  const focusRegion = scene?.focusRegion || null;

  if (!focusRegion || !imageRect) return null;

  const viewportStyle = scene?.viewportStyle || "fit_contextual";
  const focusPadding = scene?.focusPadding || null;

  let padX = 0.035;
  let padY = 0.032;

  if (focusPadding) {
    padX = focusPadding.x;
    padY = focusPadding.y;
  } else {
    switch (viewportStyle) {
      case "fit_tight":
        padX = 0.025;
        padY = 0.018;
        break;

      case "fit_balanced":
        padX = 0.006;
        padY = 0.009;
        break;

      default:
        padX = 0.012;
        padY = 0.018;
        break;
    }
  }

  const x = clamp(focusRegion.x - padX, 0, 1);
  const y = clamp(focusRegion.y - padY - 0.012, 0, 1);
  const right = clamp(focusRegion.x + focusRegion.width + padX, 0, 1);
  const bottom = clamp(focusRegion.y + focusRegion.height + padY, 0, 1);

  return {
    left: imageRect.left + x * imageRect.width,
    top: imageRect.top + y * imageRect.height,
    width: Math.max(10, (right - x) * imageRect.width),
    height: Math.max(10, (bottom - y) * imageRect.height),
  };
}

function getVisualFocusRegion(scene) {
  const baseRegion = scene?.focusRegion || null;
  const spokenFocus = scene?.spokenFocus || null;

  if (!baseRegion || !spokenFocus) return baseRegion;

  if (spokenFocus.focusMode !== "line" && spokenFocus.type !== "command") {
    return baseRegion;
  }

  const targets = Array.isArray(scene.spokenFocusTargets)
    ? scene.spokenFocusTargets
    : [];

  const targetIndex = Math.max(
    0,
    targets.findIndex((target) => target?.text === spokenFocus.text)
  );

  const lineHeight = Math.max(0.032, Math.min(0.055, baseRegion.height * 0.18));
  const topPadding = Math.min(0.035, baseRegion.height * 0.16);
  const yOffset = topPadding + targetIndex * lineHeight;

  return {
    ...baseRegion,
    type: "spoken_focus_line",
    source: "Root.jsx/spokenFocus",
    label: spokenFocus.label || spokenFocus.text || baseRegion.label,
    y: clamp(baseRegion.y + yOffset, 0, 0.96),
    height: lineHeight,
    confidence: baseRegion.confidence === "low" ? "medium" : baseRegion.confidence,
  };
}

function getSemanticTraversal(scene) {
  const semanticTraversal = scene?.semanticTraversal || null;

  if (!semanticTraversal || typeof semanticTraversal !== "object") {
    return null;
  }

  return semanticTraversal;
}

function getSemanticTeachingFocus(scene) {
  return getSemanticTraversal(scene)?.teachingFocus || null;
}

function getSemanticChoreography(scene) {
  return getSemanticTraversal(scene)?.choreography || null;
}

function resolveSemanticMotionIntent(scene) {
  const choreography = getSemanticChoreography(scene);
  const motionIntent = choreography?.motionIntent || null;

  switch (motionIntent) {
    case "zoom_to_flow_entry":
      return {
        motionIntent,
        cameraMode: "semantic_flow_entry",
        cameraBehavior: choreography.cameraBehavior || "establish_context_then_zoom",
        overlayBehavior: choreography.overlayBehavior || "minimal_context_label",
      };

    case "follow_flow_to_component":
      return {
        motionIntent,
        cameraMode: "semantic_flow_follow",
        cameraBehavior: choreography.cameraBehavior || "guided_pan",
        overlayBehavior: choreography.overlayBehavior || "minimal_context_label",
      };

    case "settle_on_flow_destination":
      return {
        motionIntent,
        cameraMode: "semantic_flow_destination",
        cameraBehavior: choreography.cameraBehavior || "slow_settle_focus",
        overlayBehavior: choreography.overlayBehavior || "minimal_context_label",
      };

    default:
      return {
        motionIntent: motionIntent || "default_existing_motion",
        cameraMode: "existing_camera_behavior",
        cameraBehavior: choreography?.cameraBehavior || null,
        overlayBehavior: choreography?.overlayBehavior || null,
      };
  }
}

function getSemanticTraversalDebug(scene) {
  const semanticTraversal = getSemanticTraversal(scene);

  if (!semanticTraversal) {
    return {
      hasSemanticTraversal: false,
      motionIntent: null,
      cameraMode: "existing_camera_behavior",
      cameraBehavior: null,
      overlayBehavior: null,
      entityId: null,
      flowGroupId: null,
    };
  }

  const teachingFocus = getSemanticTeachingFocus(scene);
  const choreography = getSemanticChoreography(scene);
  const resolvedMotion = resolveSemanticMotionIntent(scene);

  return {
    hasSemanticTraversal: true,
    motionIntent: resolvedMotion.motionIntent,
    cameraMode: resolvedMotion.cameraMode,
    cameraBehavior: resolvedMotion.cameraBehavior,
    overlayBehavior: resolvedMotion.overlayBehavior,
    entityId: teachingFocus?.entityId || choreography?.entityId || null,
    flowGroupId: teachingFocus?.flowGroupId || choreography?.flowGroupId || null,
    focusId: teachingFocus?.focusId || choreography?.focusId || null,
    confidence: teachingFocus?.confidence || choreography?.confidence || null,
    source: teachingFocus?.source || choreography?.source || null,
  };
}

function maybeLogSemanticTraversal(scene) {
  const debug = getSemanticTraversalDebug(scene);

  if (!debug.hasSemanticTraversal) return;

  const shouldLog = shouldShowSemanticTraversalDebug();

  if (!shouldLog) return;

  // Metadata-only debug hook for Phase 8C.10.
  // This must not change camera behavior or rendering output.
  console.log("[Cachey Notebook] semanticTraversal", {
    sectionNumber: scene?.sectionNumber || null,
    title: scene?.title || scene?.focusRegion?.label || null,
    ...debug,
  });
}

function shouldShowSemanticTraversalDebug() {
  return (
    typeof process !== "undefined" &&
    process.env &&
    process.env.CACHEY_NOTEBOOK_DEBUG_SEMANTIC_TRAVERSAL === "1"
  );
}

function getCameraMotionStyle(scene, dim = false) {
  const durationFrames = getSceneDurationFrames(scene);
  const progress = Easing.inOut(Easing.cubic)(getProgress(durationFrames));

  const behavior = scene?.sceneBehavior || {};
  const focusRegion = scene?.focusRegion || behavior?.focusRegion || null;
  const cameraProfile = scene?.cameraProfile || "broad_context_focus";

    let scale = 1.014;
    let x = 0;
    let y = 0;

    if (focusRegion && focusRegion.confidence !== "low") {
    const regionCenterX = focusRegion.x + focusRegion.width / 2;
    const regionCenterY = focusRegion.y + focusRegion.height / 2;

    // desired viewport center
    const viewportCenterX = 0.5;
    const viewportCenterY = 0.42;

    // move document toward focus region
    const offsetX = (viewportCenterX - regionCenterX) * 70;
    const offsetY = (viewportCenterY - regionCenterY) * 110;

    x = interpolate(progress, [0, 1], [offsetX * 0.15, offsetX], {
        extrapolateLeft: "clamp",
        extrapolateRight: "clamp",
        easing: Easing.out(Easing.cubic),
    });

    y = interpolate(progress, [0, 1], [offsetY * 0.15, offsetY], {
        extrapolateLeft: "clamp",
        extrapolateRight: "clamp",
        easing: Easing.out(Easing.cubic),
    });

    // zoom based on focus area size
    const focusArea = focusRegion.width * focusRegion.height;

   let targetScale = 1.035;

    if (cameraProfile === "tight_section_focus") {
        targetScale += 0.02;
    }

    scale = interpolate(progress, [0, 1], [1.01, targetScale], {
        extrapolateLeft: "clamp",
        extrapolateRight: "clamp",
        easing: Easing.out(Easing.cubic),
    });
    } else {
        const cameraMotion = behavior.cameraMotion || "slow_zoom";

        switch (cameraMotion) {
        case "soft_pan":
            scale = interpolate(progress, [0, 1], [1.002, 1.016]);
            x = interpolate(progress, [0, 1], [-12, 12]);
            break;
        case "guided_pan":
            scale = interpolate(progress, [0, 1], [1.003, 1.018]);
            x = interpolate(progress, [0, 1], [-16, 16]);
            y = interpolate(progress, [0, 1], [8, -8]);
            break;
        case "soft_focus":
        case "slow_focus":
            scale = interpolate(progress, [0, 1], [1.002, 1.016]);
            y = interpolate(progress, [0, 1], [8, -8]);
            break;
        case "slow_zoom":
        default:
            scale = interpolate(progress, [0, 1], [1.001, 1.014]);
            break;
        }
    }

  return {
    transform: `translate(${x}px, ${y}px) scale(${scale})`,
    opacity: dim ? 0.76 : 1,
  };
}

function getTopicsFromRenderPlan(renderPlan) {
  if (Array.isArray(renderPlan?.topics) && renderPlan.topics.length > 0) {
    return renderPlan.topics
      .map((topic, index) => ({
        id: topic.id || topic.title || `topic-${index}`,
        title: safeTitle(topic.title, `Topic ${index + 1}`),
        subtitle: topic.subtitle || "",
        sceneIndex: topic.sceneIndex ?? index,
      }))
      .filter((topic) => !MUTED_TOPICS.has(dedupeKey(topic.title)));
  }

  const seen = new Set();
  const topics = [];

  (renderPlan?.scenes || []).forEach((scene, sceneIndex) => {
    const title = safeTitle(
      scene.focusRegion?.label || scene.title || scene.visualIntent?.focus || getSceneTitle(scene),
      ""
    );

    const key = dedupeKey(title);
    if (!title || MUTED_TOPICS.has(key) || seen.has(key)) return;

    seen.add(key);
    topics.push({
      id: `${scene.sectionNumber || sceneIndex}-${key}`,
      title,
      subtitle: getShortSubtitle(scene),
      sceneIndex,
    });
  });

  return topics;
}

function getActiveTopicIndex(topics, scene, sceneIndex) {
  const activeTitle = dedupeKey(
    scene?.focusRegion?.label || scene?.title || scene?.visualIntent?.focus || getSceneTitle(scene)
  );

  const exactIndex = topics.findIndex((topic) => dedupeKey(topic.title) === activeTitle);
  if (exactIndex >= 0) return exactIndex;

  let nearestIndex = 0;
  topics.forEach((topic, index) => {
    if ((topic.sceneIndex || 0) <= sceneIndex) nearestIndex = index;
  });

  return nearestIndex;
}

function Shell({ scene, children }) {
  const backgroundMotion = getBackgroundMotionStyle(scene || {});

  return (
    <AbsoluteFill
      style={{
        background:
            "radial-gradient(circle at 18% 0%, rgba(37,99,235,0.12), transparent 30%), radial-gradient(circle at 82% 18%, rgba(14,165,233,0.07), transparent 24%), linear-gradient(135deg, #020617 0%, #07111f 48%, #000 100%)",
        color: "white",
        fontFamily:
          "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif",
        overflow: "hidden",
      }}
    >
      <AbsoluteFill
        style={{
          ...backgroundMotion,
          background:
            "linear-gradient(115deg, rgba(59,130,246,0.03), transparent 40%, rgba(20,184,166,0.018))",
            opacity: 0.55,
        }}
      />

      <AbsoluteFill
        style={{
          boxShadow: "inset 0 0 190px rgba(0,0,0,0.74)",
          pointerEvents: "none",
          zIndex: 40,
        }}
      />

      {children}
    </AbsoluteFill>
  );
}

function LeftRail({ topics, activeIndex, durationFrames }) {
  return (
    <div
      style={{
        position: "absolute",
        top: OUTER_PAD,
        left: OUTER_PAD,
        bottom: OUTER_PAD,
        width: LEFT_RAIL_WIDTH,
        borderRadius: 32,
        padding: "26px 22px",
        background:
          "linear-gradient(180deg, rgba(15,23,42,0.74), rgba(2,6,23,0.82))",
        border: "1px solid rgba(148,163,184,0.16)",
        boxShadow: "0 14px 40px rgba(0,0,0,0.28)",
        zIndex: 12,
        ...getOverlayEntranceStyle(4, durationFrames),
      }}
    >
      <div
        style={{
          fontSize: 15,
          letterSpacing: 1.5,
          textTransform: "uppercase",
          color: "rgba(147,197,253,0.78)",
          fontWeight: 900,
          marginBottom: 8,
        }}
      >
        Cachey Notebook
      </div>

      <div
        style={{
          fontSize: 28,
          lineHeight: 1.05,
          fontWeight: 950,
          color: "#f8fafc",
          letterSpacing: -0.8,
          marginBottom: 26,
        }}
      >
        Guided technical walkthrough
      </div>

      <div
        style={{
          height: 1,
          background:
            "linear-gradient(90deg, rgba(96,165,250,0.42), rgba(148,163,184,0.08))",
          marginBottom: 22,
        }}
      />

      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {topics.slice(0, 8).map((topic, index) => {
          const active = index === activeIndex;
          const complete = index < activeIndex;

          return (
            <div
              key={topic.id}
              style={{
                position: "relative",
                borderRadius: 20,
                padding: "14px 14px 14px 18px",
                background: active
                  ? "rgba(37,99,235,0.24)"
                  : complete
                    ? "rgba(15,23,42,0.44)"
                    : "rgba(15,23,42,0.2)",
                border: active
                  ? "1px solid rgba(96,165,250,0.5)"
                  : "1px solid rgba(148,163,184,0.1)",
                boxShadow: active ? "0 18px 50px rgba(37,99,235,0.16)" : "none",
              }}
            >
              <div
                style={{
                  position: "absolute",
                  left: 7,
                  top: 17,
                  bottom: 17,
                  width: 3,
                  borderRadius: 999,
                  background: active
                    ? "#60a5fa"
                    : complete
                      ? "rgba(45,212,191,0.58)"
                      : "rgba(148,163,184,0.18)",
                }}
              />

              <div
                style={{
                  fontSize: active ? 23 : 20,
                  lineHeight: 1.12,
                  fontWeight: active ? 900 : 780,
                  color: active ? "#f8fafc" : complete ? "#cbd5e1" : "#94a3b8",
                  letterSpacing: -0.3,
                }}
              >
                {topic.title}
              </div>

              {active && topic.subtitle ? (
                <div
                  style={{
                    marginTop: 7,
                    fontSize: 14,
                    lineHeight: 1.2,
                    color: "rgba(191,219,254,0.8)",
                    fontWeight: 700,
                  }}
                >
                  {topic.subtitle}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>

      <div
        style={{
          position: "absolute",
          left: 22,
          right: 22,
          bottom: 22,
          borderRadius: 18,
          padding: "14px 16px",
          background: "rgba(2,6,23,0.48)",
          border: "1px solid rgba(148,163,184,0.12)",
          color: "rgba(203,213,225,0.72)",
          fontSize: 14,
          lineHeight: 1.25,
          fontWeight: 700,
        }}
      >
        Document-derived topics. No hardcoded playbook.
      </div>
    </div>
  );
}

function TopContext({ scene, durationFrames }) {
  const title = safeTitle(scene.focusRegion?.label || scene.title || getSceneTitle(scene));
  const subtitle = getShortSubtitle(scene);

  return (
    <div
      style={{
        position: "absolute",
        top: OUTER_PAD + 2,
        left: OUTER_PAD + LEFT_RAIL_WIDTH + STAGE_GAP,
        right: OUTER_PAD,
        height: 76,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        zIndex: 10,
        ...getOverlayEntranceStyle(6, durationFrames),
      }}
    >
      <div>
        <div
          style={{
            fontSize: 17,
            color: "rgba(147,197,253,0.76)",
            letterSpacing: 1.4,
            textTransform: "uppercase",
            fontWeight: 900,
            marginBottom: 7,
          }}
        >
          Technical walkthrough
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "baseline",
            gap: 18,
          }}
        >
          <div
            style={{
              fontSize: 34,
              maxWidth: 760,
              lineHeight: 1,
              fontWeight: 950,
              color: "#f8fafc",
              letterSpacing: -1.2,
            }}
          >
            {title}
          </div>

          <div
            style={{
              fontSize: 19,
              color: "rgba(203,213,225,0.72)",
              fontWeight: 750,
            }}
          >
            {subtitle}
          </div>
        </div>
      </div>

      <div
        style={{
          borderRadius: 999,
            padding: "8px 14px",
            background: "rgba(15,23,42,0.52)",
            border: "1px solid rgba(148,163,184,0.12)",
            color: "rgba(203,213,225,0.72)",
            fontSize: 16,
            fontWeight: 750,
            backdropFilter: "blur(6px)",
            flexShrink: 0,
        }}
      >
        {scene.page != null || scene.pageNumber != null
          ? `Page ${scene.page ?? scene.pageNumber}`
          : "Document focus"}
      </div>
    </div>
  );
}

function SoftFocusOverlay({ focusStyle, confidence, label }) {
  const frame = useCurrentFrame();
  const isLowConfidence = confidence === "low";

  const breath = interpolate(frame % 150, [0, 75, 150], [0, 1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.inOut(Easing.cubic),
  });

  const glowOpacity = isLowConfidence
    ? interpolate(breath, [0, 1], [0.12, 0.2])
    : interpolate(breath, [0, 1], [0.18, 0.3]);

  const glassOpacity = isLowConfidence
    ? interpolate(breath, [0, 1], [0.08, 0.13])
    : interpolate(breath, [0, 1], [0.12, 0.2]);

  const scale = interpolate(breath, [0, 1], [1, 1.012]);
  const radius = isLowConfidence ? 34 : 24;

  return (
    <>
      <div
        style={{
          position: "absolute",
          inset: 0,
          background:
            "radial-gradient(circle at 50% 46%, transparent 38%, rgba(2,6,23,0.018) 74%, rgba(2,6,23,0.045) 100%)",
          pointerEvents: "none",
        }}
      />

      <div
        style={{
          position: "absolute",
          left: focusStyle.left - 24,
          top: focusStyle.top - 24,
          width: focusStyle.width + 48,
          height: focusStyle.height + 48,
          borderRadius: radius + 18,
          background: `radial-gradient(circle at 50% 50%, rgba(96,165,250,${glowOpacity}), rgba(45,212,191,${glowOpacity * 0.34}) 48%, transparent 76%)`,
          filter: "blur(4px)",
          transform: `scale(${scale})`,
          transformOrigin: "center center",
          pointerEvents: "none",
        }}
      />

      <div
        style={{
          position: "absolute",
          left: focusStyle.left,
          top: focusStyle.top,
          width: focusStyle.width,
          height: focusStyle.height,
          borderRadius: radius,
          border: isLowConfidence
            ? "1px solid rgba(191,219,254,0.16)"
            : "1px solid rgba(191,219,254,0.34)",
          background: "rgba(147,197,253,0.05)",
          boxShadow: isLowConfidence
            ? "0 0 52px rgba(96,165,250,0.14), inset 0 1px 0 rgba(255,255,255,0.08)"
            : "0 0 76px rgba(96,165,250,0.24), inset 0 1px 0 rgba(255,255,255,0.12)",
          backdropFilter: "none",
          transform: `scale(${scale})`,
          transformOrigin: "center center",
          pointerEvents: "none",
        }}
      />
    </>
  );
}

function PageImagePanel({ scene, durationFrames, dim = false }) {
  const motionStyle = getCameraMotionStyle(scene, dim);
  const stage = getStageRect();

  const innerWidth = stage.width - PAGE_STAGE_INSET * 2;
  const innerHeight = stage.height - PAGE_STAGE_INSET * 2;

  const imageRect = getContainedImageRect(
    innerWidth,
    innerHeight,
    scene.pageAspectRatio || scene.imageAspectRatio || 8.5 / 11
  );

  const focusStyle = getFocusRegionStyle(scene, imageRect);
  const confidence = scene.focusRegion?.confidence || "medium";

  return (
    <div
      style={{
        position: "absolute",
        top: stage.top,
        left: stage.left,
        width: stage.width,
        height: stage.height,
        borderRadius: 34,
        overflow: "hidden",
        background:
          "linear-gradient(135deg, rgba(15,23,42,0.68), rgba(2,6,23,0.94))",
        border: "1px solid rgba(148,163,184,0.16)",
        boxShadow: "0 20px 60px rgba(0,0,0,0.38)",
        zIndex: 1,
        ...getOverlayEntranceStyle(4, durationFrames),
      }}
    >
      {scene.pageImagePath ? (
        <>
          <div
            style={{
              position: "absolute",
              inset: 0,
              background:
                "radial-gradient(circle at 50% 45%, rgba(59,130,246,0.12), transparent 42%)",
              pointerEvents: "none",
            }}
          />

          <div
            style={{
              position: "absolute",
              inset: PAGE_STAGE_INSET,
              borderRadius: 26,
              overflow: "hidden",
              transform: motionStyle.transform,
              opacity: motionStyle.opacity,
              transformOrigin: "center center",
            }}
          >
            <Img
              src={staticFile(scene.pageImagePath)}
              style={{
                position: "absolute",
                left: imageRect.left,
                top: imageRect.top,
                width: imageRect.width,
                height: imageRect.height,
                objectFit: "contain",
                objectPosition: "center center",
                borderRadius: 22,
                background: "#020617",
                boxShadow: "0 8px 28px rgba(0,0,0,0.22)",
              }}
            />

            {focusStyle ? (
              <>
                <SoftFocusOverlay
                  focusStyle={focusStyle}
                  confidence={confidence}
                  label={scene.focusRegion?.label || "Focus"}
                />
              </>
            ) : null}
          </div>
        </>
      ) : (
        <div
          style={{
            height: "100%",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 38,
            color: "#94a3b8",
            fontWeight: 800,
          }}
        >
          Page preview unavailable
        </div>
      )}
    </div>
  );
}

function ContextHint({ scene, durationFrames }) {
  const command = getCommand(scene);
  const reference = getReference(scene);
  const isCommand =
    scene.visualType === "command_reference_scene" ||
    scene.visualType === "command_scene" ||
    scene.overlayMode === "minimal_command_callout" ||
    command;

  const isWorkflow =
    scene.visualType === "workflow_scene" ||
    scene.visualType === "workflow_context_scene" ||
    scene.overlayMode === "compact_workflow_steps";

  const isWarning =
    scene.visualType === "warning_callout_scene" ||
    scene.visualType === "decision_checkpoint_scene" ||
    scene.type === "common_mistake";

  if (!isCommand && !isWorkflow && !isWarning && !reference) {
    return null;
  }

  const label = isCommand
    ? "Reference"
    : isWorkflow
      ? "Workflow"
      : isWarning
        ? "Watch out"
        : "Context";

  const title = safeTitle(scene.focusRegion?.label || scene.title || getSceneTitle(scene));

  const body =
  isCommand
    ? "Use these commands as the operational anchor for this section. Start with the safest read-only checks, then drill into details when the signal points you there."
    : reference || scene.caption || "Connect the explanation back to the real document.";

  return (
    <div
      style={{
        position: "absolute",
        right: OUTER_PAD + 24,
        top: TOP_BAR_HEIGHT + 30,
        width: 320,
        borderRadius: 28,
        padding: 18,
        background: "rgba(2,6,23,0.72)",
        border: "1px solid rgba(148,163,184,0.18)",
        boxShadow: "0 26px 90px rgba(0,0,0,0.42)",
        backdropFilter: "blur(8px)",
        zIndex: 9,
        ...getOverlayEntranceStyle(18, durationFrames),
      }}
    >
      <div
        style={{
          color: isWarning ? "#fbbf24" : isCommand ? "#86efac" : "#93c5fd",
          fontSize: 15,
          textTransform: "uppercase",
          letterSpacing: 1.5,
          fontWeight: 950,
          marginBottom: 13,
        }}
      >
        {label}
      </div>

      <div
        style={{
          fontSize: isCommand ? 16 : 22,
          lineHeight: 1.15,
          color: "#f8fafc",
          fontWeight: 900,
          marginBottom: 14,
          fontFamily: undefined,
          wordBreak: "break-word",
        }}
      >
        {title}
      </div>

      <div
        style={{
          fontSize: 15,
          lineHeight: 1.28,
          color: "rgba(219,234,254,0.82)",
          fontWeight: 720,
        }}
      >
        {body}
      </div>
    </div>
  );
}

function PlaybackBar({ scene, sceneIndex, sceneCount, durationFrames }) {
  const progress = getProgress(durationFrames);
  const percent = clamp(progress * 100, 0, 100);

  return (
    <div
      style={{
        position: "absolute",
        left: OUTER_PAD + LEFT_RAIL_WIDTH + STAGE_GAP,
        right: OUTER_PAD,
        bottom: OUTER_PAD,
        height: 42,
        borderRadius: 999,
        background: "rgba(2,6,23,0.62)",
        border: "1px solid rgba(148,163,184,0.14)",
        boxShadow: "0 20px 70px rgba(0,0,0,0.34)",
        zIndex: 12,
        display: "flex",
        alignItems: "center",
        gap: 18,
        padding: "0 18px",
        ...getOverlayEntranceStyle(8, durationFrames),
      }}
    >
      <div
        style={{
          fontSize: 15,
          color: "rgba(203,213,225,0.75)",
          fontWeight: 850,
          minWidth: 92,
        }}
      >
        {sceneIndex + 1} / {sceneCount}
      </div>

      <div
        style={{
          position: "relative",
          flex: 1,
          height: 6,
          borderRadius: 999,
          background: "rgba(148,163,184,0.16)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            bottom: 0,
            width: `${percent}%`,
            borderRadius: 999,
            background:
              "linear-gradient(90deg, rgba(96,165,250,0.95), rgba(45,212,191,0.78))",
            boxShadow: "0 0 26px rgba(96,165,250,0.42)",
          }}
        />
      </div>

      <div
        style={{
          fontSize: 15,
          color: "rgba(203,213,225,0.72)",
          fontWeight: 800,
          minWidth: 150,
          textAlign: "right",
        }}
      >
        {safeTitle(scene.focusRegion?.label || scene.title || getSceneTitle(scene), "Focus")}
      </div>
    </div>
  );
}

function SemanticTraversalDebugBadge({ scene, durationFrames }) {
  if (!shouldShowSemanticTraversalDebug()) return null;

  const debug = getSemanticTraversalDebug(scene);

  if (!debug.hasSemanticTraversal) return null;

  const entityLabel = debug.entityId || "unknown-entity";
  const motionLabel = debug.motionIntent || "unknown-motion";
  const cameraLabel = debug.cameraMode || "existing_camera_behavior";

  return (
    <div
      style={{
        position: "absolute",
        right: OUTER_PAD + 18,
        bottom: OUTER_PAD + 54,
        maxWidth: 520,
        borderRadius: 999,
        padding: "7px 11px",
        background: "rgba(2,6,23,0.46)",
        border: "1px solid rgba(148,163,184,0.12)",
        color: "rgba(226,232,240,0.46)",
        fontSize: 11,
        lineHeight: 1.15,
        fontWeight: 750,
        letterSpacing: 0.2,
        zIndex: 60,
        pointerEvents: "none",
        backdropFilter: "blur(6px)",
        ...getOverlayEntranceStyle(10, durationFrames),
      }}
    >
      {entityLabel} · {motionLabel} · {cameraLabel}
    </div>
  );
}

function WorkspaceScene({ scene, renderPlan, sceneIndex, durationFrames }) {
  const topics = getTopicsFromRenderPlan(renderPlan);
  const activeTopicIndex = getActiveTopicIndex(topics, scene, sceneIndex);

  return (
    <Shell scene={scene}>
      <LeftRail topics={topics} activeIndex={activeTopicIndex} durationFrames={durationFrames} />
      <TopContext scene={scene} durationFrames={durationFrames} />
      <PageImagePanel scene={scene} durationFrames={durationFrames} />
      <ContextHint scene={scene} durationFrames={durationFrames} />
      <PlaybackBar
        scene={scene}
        sceneIndex={sceneIndex}
        sceneCount={(renderPlan.scenes || []).length}
        durationFrames={durationFrames}
      />
      <SemanticTraversalDebugBadge scene={scene} durationFrames={durationFrames} />
    </Shell>
  );
}

function FallbackTeachingScene({ scene, renderPlan, sceneIndex, durationFrames }) {
  const topics = getTopicsFromRenderPlan(renderPlan);
  const activeTopicIndex = getActiveTopicIndex(topics, scene, sceneIndex);

  return (
    <Shell scene={scene}>
      <LeftRail topics={topics} activeIndex={activeTopicIndex} durationFrames={durationFrames} />
      <TopContext scene={scene} durationFrames={durationFrames} />

      <div
        style={{
          position: "absolute",
          top: TOP_BAR_HEIGHT,
          left: OUTER_PAD + LEFT_RAIL_WIDTH + STAGE_GAP,
          right: OUTER_PAD,
          bottom: BOTTOM_BAR_HEIGHT + OUTER_PAD,
          borderRadius: 34,
          padding: 54,
          background: "rgba(15,23,42,0.74)",
          border: "1px solid rgba(148,163,184,0.16)",
          boxShadow: "0 42px 145px rgba(0,0,0,0.56)",
          zIndex: 1,
          display: "flex",
          alignItems: "center",
          ...getOverlayEntranceStyle(6, durationFrames),
        }}
      >
        <div>
          <div
            style={{
              fontSize: 68,
              lineHeight: 1.02,
              color: "#f8fafc",
              fontWeight: 950,
              letterSpacing: -2,
              maxWidth: 1100,
              marginBottom: 26,
            }}
          >
            {safeTitle(scene.focusRegion?.label || scene.title || getSceneTitle(scene))}
          </div>

          <div
            style={{
              fontSize: 34,
              lineHeight: 1.22,
              color: "rgba(219,234,254,0.84)",
              fontWeight: 750,
              maxWidth: 1180,
            }}
          >
            {scene.caption || getReference(scene) || "Continue the guided walkthrough."}
          </div>
        </div>
      </div>

      <PlaybackBar
        scene={scene}
        sceneIndex={sceneIndex}
        sceneCount={(renderPlan.scenes || []).length}
        durationFrames={durationFrames}
      />
      <SemanticTraversalDebugBadge scene={scene} durationFrames={durationFrames} />
    </Shell>
  );
}

function CinematicScene({ scene, renderPlan, sceneIndex, durationFrames }) {
  const entranceStyle = getSceneEntranceStyle(scene, durationFrames);
  const hasDocument = Boolean(scene.pageImagePath);

  maybeLogSemanticTraversal(scene);

  return (
    <AbsoluteFill
      style={{
        background: "#020617",
        opacity: entranceStyle.opacity,
        transform: entranceStyle.transform,
        overflow: "hidden",
      }}
    >
      {hasDocument ? (
        <WorkspaceScene
          scene={scene}
          renderPlan={renderPlan}
          sceneIndex={sceneIndex}
          durationFrames={durationFrames}
        />
      ) : (
        <FallbackTeachingScene
          scene={scene}
          renderPlan={renderPlan}
          sceneIndex={sceneIndex}
          durationFrames={durationFrames}
        />
      )}
    </AbsoluteFill>
  );
}

function NotebookVideo({ renderPlan }) {
  const safeRenderPlan = renderPlan || { scenes: [] };
  const scenes = Array.isArray(safeRenderPlan.scenes) ? safeRenderPlan.scenes : [];

  return (
    <AbsoluteFill style={{ background: "#020617" }}>
      {scenes.map((scene, sceneIndex) => {
        const durationFrames = msToFrames(scene.durationMs || scene.estimatedDurationMs || 4000);
        const from = msToFrames(scene.startMs || 0);

        return (
          <Sequence
            key={`${scene.sectionNumber || sceneIndex}-${scene.startMs || from}`}
            from={from}
            durationInFrames={durationFrames}
          >
            <CinematicScene
              scene={scene}
              renderPlan={safeRenderPlan}
              sceneIndex={sceneIndex}
              durationFrames={durationFrames}
            />

            {scene.audioPath ? <Audio src={staticFile(getStaticAssetPath(scene.audioPath))} /> : null}
          </Sequence>
        );
      })}
    </AbsoluteFill>
  );
}

function Root({ renderPlan }) {
  return (
    <NotebookVideo
      renderPlan={
        renderPlan || {
          scenes: [],
        }
      }
    />
  );
}

module.exports = {
  Root,
  FPS,
  msToFrames,
};
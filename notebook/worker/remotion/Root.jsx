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
const PAGE_STAGE_INSET = 18;

function getPageStageRect() {
  return {
    width: VIDEO_WIDTH - 84 - PAGE_STAGE_INSET * 2,
    height: VIDEO_HEIGHT - 214 - PAGE_STAGE_INSET * 2,
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

function getFocusRegionStyle(focusRegion, imageRect) {
  if (!focusRegion || !imageRect) return null;

  return {
    left: imageRect.left + focusRegion.x * imageRect.width,
    top: imageRect.top + focusRegion.y * imageRect.height,
    width: focusRegion.width * imageRect.width,
    height: focusRegion.height * imageRect.height,
  };
}


function msToFrames(ms) {
  return Math.max(1, Math.round((ms / 1000) * FPS));
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function getSceneTitle(scene) {
  if (scene.type === "intro") return "Welcome";
  if (scene.type === "document_summary") return "Big Picture";
  if (scene.type === "diagram_walkthrough") return "Architecture Walkthrough";
  if (scene.type === "concept_simplification") return "Mental Model";
  if (scene.type === "common_mistake") return "Common Mistake";
  if (scene.type === "recap") return "Key Takeaways";
  if (scene.type === "closing") return "Wrap Up";
  if (scene.type === "question") return "New Joiner Question";
  if (scene.type === "command_group_teaching") return "Command Focus";
  if (scene.type === "topic_workflow") return "Operational Flow";
  if (scene.type === "topic_analogy") return "Simple Analogy";
  if (scene.type === "debugging_intuition") return "Debugging Intuition";
  return "Cachey Notebook";
}

function getFocus(scene) {
  return scene?.visualIntent?.focus || scene.caption || getSceneTitle(scene);
}

function getReference(scene) {
  return scene?.visualIntent?.reference || "";
}

function getCommand(scene) {
  return scene?.visualIntent?.command || "";
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

  const y = interpolate(frame, [0, inFrames], [18, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.cubic),
  });

  const scale = interpolate(frame, [0, durationFrames], [1.01, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.cubic),
  });

  return {
    opacity: getSceneOpacity(scene, durationFrames),
    transform: `translateY(${y}px) scale(${scale})`,
  };
}

function getBackgroundMotionStyle(scene) {
  const durationFrames = getSceneDurationFrames(scene);
  const progress = Easing.inOut(Easing.cubic)(getProgress(durationFrames));

  const driftX = interpolate(progress, [0, 1], [-10, 10]);
  const driftY = interpolate(progress, [0, 1], [6, -6]);
  const scale = interpolate(progress, [0, 1], [1, 1.018]);

  return {
    transform: `translate(${driftX}px, ${driftY}px) scale(${scale})`,
  };
}

function getCameraMotionStyle(scene, dim = false) {
  const durationFrames = getSceneDurationFrames(scene);
  const progress = Easing.inOut(Easing.cubic)(getProgress(durationFrames));

  const behavior = scene?.sceneBehavior || {};
  const focusRegion = scene?.focusRegion || behavior?.focusRegion || null;

  let scale = 1.035;
  let x = 0;
  let y = 0;

  if (focusRegion) {
    const regionCenterX = focusRegion.x + focusRegion.width / 2;
    const regionCenterY = focusRegion.y + focusRegion.height / 2;

    const targetX = interpolate(regionCenterX, [0, 1], [90, -90]);
    const targetY = interpolate(regionCenterY, [0, 1], [58, -58]);

    x = interpolate(progress, [0, 1], [0, targetX]);
    y = interpolate(progress, [0, 1], [0, targetY]);

    scale = interpolate(progress, [0, 1], [1.025, 1.13], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
      easing: Easing.out(Easing.cubic),
    });
  } else {
    const cameraMotion = behavior.cameraMotion || "slow_zoom";

    switch (cameraMotion) {
      case "slow_zoom":
        scale = interpolate(progress, [0, 1], [1.02, 1.075]);
        break;
      case "soft_focus":
      case "slow_focus":
        scale = interpolate(progress, [0, 1], [1.02, 1.07]);
        y = interpolate(progress, [0, 1], [10, -10]);
        break;
      case "soft_pan":
        scale = interpolate(progress, [0, 1], [1.02, 1.055]);
        x = interpolate(progress, [0, 1], [-18, 18]);
        break;
      case "guided_pan":
        scale = interpolate(progress, [0, 1], [1.02, 1.08]);
        x = interpolate(progress, [0, 1], [-24, 24]);
        y = interpolate(progress, [0, 1], [10, -10]);
        break;
      default:
        scale = interpolate(progress, [0, 1], [1.02, 1.055]);
        break;
    }
  }

  return {
    transform: `translate(${x}px, ${y}px) scale(${scale})`,
    opacity: dim ? 0.78 : 1,
  };
}

function getOverlayEntranceStyle(delayFrames = 5, durationFramesOverride) {
  const frame = useCurrentFrame();
  const durationFrames = durationFramesOverride || 9999;

  const opacityIn = interpolate(frame, [delayFrames, delayFrames + 16], [0, 1], {
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

  const y = interpolate(frame, [delayFrames, delayFrames + 16], [20, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.cubic),
  });

  const scale = interpolate(frame, [delayFrames, delayFrames + 16], [0.985, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.cubic),
  });

  return {
    opacity: Math.min(opacityIn, opacityOut),
    transform: `translateY(${y}px) scale(${scale})`,
  };
}

function getStepRevealStyle(index, baseDelay = 12) {
  return getOverlayEntranceStyle(baseDelay + index * 7);
}

function Shell({ scene, children }) {
  const backgroundMotion = getBackgroundMotionStyle(scene || {});

  return (
    <AbsoluteFill
      style={{
        background:
          "radial-gradient(circle at 20% 0%, rgba(37,99,235,0.38), transparent 34%), radial-gradient(circle at 80% 20%, rgba(14,165,233,0.18), transparent 28%), linear-gradient(135deg, #020617 0%, #07111f 48%, #000 100%)",
        color: "white",
        fontFamily:
          "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif",
        padding: 56,
        overflow: "hidden",
      }}
    >
      <AbsoluteFill
        style={{
          ...backgroundMotion,
          background:
            "linear-gradient(115deg, rgba(59,130,246,0.08), transparent 36%, rgba(20,184,166,0.06))",
          opacity: 0.9,
        }}
      />

      <AbsoluteFill
        style={{
          boxShadow: "inset 0 0 180px rgba(0,0,0,0.72)",
          pointerEvents: "none",
          zIndex: 30,
        }}
      />

      {children}
    </AbsoluteFill>
  );
}

function SpeakerBadge({ speaker }) {
  const isSenior = speaker === "Senior Engineer";

  return (
    <div
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 12,
        borderRadius: 999,
        padding: "10px 18px",
        background: isSenior ? "rgba(37, 99, 235, 0.22)" : "rgba(20, 184, 166, 0.18)",
        border: isSenior
          ? "1px solid rgba(96, 165, 250, 0.45)"
          : "1px solid rgba(45, 212, 191, 0.38)",
        color: isSenior ? "#bfdbfe" : "#ccfbf1",
        fontSize: 24,
        fontWeight: 700,
      }}
    >
      <span
        style={{
          width: 12,
          height: 12,
          borderRadius: 999,
          background: isSenior ? "#60a5fa" : "#2dd4bf",
          boxShadow: isSenior
            ? "0 0 28px rgba(96,165,250,0.75)"
            : "0 0 28px rgba(45,212,191,0.7)",
        }}
      />
      {speaker}
    </div>
  );
}

function Header({ scene, label }) {
  return (
    <div
      style={{
        position: "absolute",
        top: 48,
        left: 72,
        right: 72,
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        zIndex: 5,
        ...getOverlayEntranceStyle(2),
      }}
    >
      <div>
        <div
          style={{
            fontSize: 14,
            color: "rgba(148,163,184,0.72)",
            letterSpacing: 1.4,
            textTransform: "uppercase",
            fontWeight: 700,
            marginBottom: 6,
          }}
        >
          Notebook
        </div>
        <div
          style={{
            fontSize: 48,
            fontWeight: 900,
            color: "#f8fafc",
          }}
        >
          {label || getSceneTitle(scene)}
        </div>
      </div>

      <div
        style={{
          borderRadius: 999,
          padding: "12px 18px",
          background: "rgba(15,23,42,0.75)",
          border: "1px solid rgba(148,163,184,0.24)",
          color: "#cbd5e1",
          fontSize: 22,
          fontWeight: 700,
        }}
      >
        {scene.page != null ? `Page ${scene.page}` : `Section ${scene.sectionNumber}`}
      </div>
    </div>
  );
}

function CaptionStrip({ scene }) {
  return (
    <div
      style={{
        position: "absolute",
        left: 72,
        right: 72,
        bottom: 58,
        borderRadius: 28,
        padding: "26px 34px",
        background: "rgba(2, 6, 23, 0.82)",
        border: "1px solid rgba(148, 163, 184, 0.25)",
        boxShadow: "0 28px 90px rgba(0,0,0,0.45)",
        zIndex: 12,
        ...getOverlayEntranceStyle(14),
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 24,
          marginBottom: 14,
        }}
      >
        <SpeakerBadge speaker={scene.speaker} />

        <div
          style={{
            fontSize: 21,
            color: "#93c5fd",
            letterSpacing: 1.4,
            textTransform: "uppercase",
            fontWeight: 800,
          }}
        >
          Section {scene.sectionNumber}
        </div>
      </div>

      <div
        style={{
          fontSize: 36,
          lineHeight: 1.22,
          fontWeight: 800,
          color: "#f8fafc",
          maxWidth: 1420,
        }}
      >
        {scene.caption || getSceneTitle(scene)}
      </div>
    </div>
  );
}

function PageImagePanel({ scene, dim = false }) {
  const motionStyle = getCameraMotionStyle(scene, dim);
  const stageRect = getPageStageRect();
  const imageRect = getContainedImageRect(
    stageRect.width,
    stageRect.height,
    scene.pageAspectRatio || scene.imageAspectRatio || 8.5 / 11
  );
  const focusStyle = getFocusRegionStyle(scene.focusRegion, imageRect);

  return (
    <div
      style={{
        position: "absolute",
        top: 92,
        left: 42,
        right: 42,
        bottom: 122,
        borderRadius: 30,
        overflow: "hidden",
        background:
          "linear-gradient(135deg, rgba(15,23,42,0.72), rgba(2,6,23,0.94))",
        border: "1px solid rgba(148, 163, 184, 0.18)",
        boxShadow: "0 42px 140px rgba(0,0,0,0.62)",
        zIndex: 1,
        ...getOverlayEntranceStyle(4),
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
              inset: 18,
              borderRadius: 24,
              overflow: "hidden",
              transform: motionStyle.transform,
              opacity: motionStyle.opacity,
              transformOrigin: "center center",
            }}
          >
            <Img
              src={staticFile(scene.pageImagePath)}
              style={{
                width: "100%",
                height: "100%",
                objectFit: "contain",
                objectPosition: "center center",
                borderRadius: 22,
                background: "#020617",
              }}
            />

            {focusStyle ? (
                <div
                    style={{
                    position: "absolute",
                    left: focusStyle.left,
                    top: focusStyle.top,
                    width: focusStyle.width,
                    height: focusStyle.height,
                    border:
                        scene.focusRegion?.confidence === "low"
                        ? "1px solid rgba(96,165,250,0.18)"
                        : "2px solid rgba(96,165,250,0.88)",
                    borderRadius: scene.focusRegion?.confidence === "low" ? 28 : 16,
                    boxShadow:
                        scene.focusRegion?.confidence === "low"
                        ? "0 0 90px rgba(96,165,250,0.22)"
                        : "0 0 46px rgba(96,165,250,0.42)",
                    background:
                        scene.focusRegion?.confidence === "low"
                        ? "radial-gradient(circle at 50% 50%, rgba(96,165,250,0.16), rgba(96,165,250,0.025) 68%, transparent 100%)"
                        : "rgba(96,165,250,0.07)",
                    pointerEvents: "none",
                    }}
                />
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
            fontSize: 42,
            color: "#94a3b8",
          }}
        >
          Page preview unavailable
        </div>
      )}
    </div>
  );
}

function FloatingTeachingCard({
  label,
  title,
  body,
  tone = "blue",
  right = 96,
  top = 230,
}) {
  const toneMap = {
    blue: {
      border: "rgba(96,165,250,0.5)",
      bg: "rgba(15,23,42,0.88)",
      accent: "#60a5fa",
    },
    teal: {
      border: "rgba(45,212,191,0.5)",
      bg: "rgba(8,47,73,0.84)",
      accent: "#2dd4bf",
    },
    amber: {
      border: "rgba(251,191,36,0.55)",
      bg: "rgba(69,26,3,0.82)",
      accent: "#fbbf24",
    },
    red: {
      border: "rgba(248,113,113,0.55)",
      bg: "rgba(69,10,10,0.84)",
      accent: "#f87171",
    },
  };

  const theme = toneMap[tone] || toneMap.blue;

  return (
    <div
      style={{
        position: "absolute",
        top,
        right,
        width: 420,
        borderRadius: 30,
        padding: 24,
        background: theme.bg,
        border: `1px solid ${theme.border}`,
        boxShadow: "0 28px 90px rgba(0,0,0,0.5)",
        zIndex: 10,
        ...getOverlayEntranceStyle(18),
      }}
    >
      <div
        style={{
          color: theme.accent,
          fontSize: 20,
          textTransform: "uppercase",
          letterSpacing: 1.6,
          fontWeight: 900,
          marginBottom: 18,
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: 30,
          lineHeight: 1.08,
          color: "#f8fafc",
          fontWeight: 950,
          marginBottom: 18,
        }}
      >
        {title}
      </div>
      <div
        style={{
          fontSize: 22,
          lineHeight: 1.26,
          color: "#dbeafe",
          fontWeight: 700,
        }}
      >
        {body}
      </div>
    </div>
  );
}

function PagePreviewScene({ scene }) {
  return (
    <Shell scene={scene}>
      <Header scene={scene} />
      <PageImagePanel scene={scene} />
      <CaptionStrip scene={scene} />
    </Shell>
  );
}

function ArchitectureFocusScene({ scene }) {
  return (
    <Shell scene={scene}>
      <Header scene={scene} label="Architecture Focus" />
      <PageImagePanel scene={scene} />
      <FloatingTeachingCard
        label="Focus"
        title={getFocus(scene)}
        body="Keep the real diagram visible. Use this moment to connect the explanation back to the actual system."
        tone="blue"
      />
      <CaptionStrip scene={scene} />
    </Shell>
  );
}

function DiagramGuidedScene({ scene }) {
  return (
    <Shell scene={scene}>
      <Header scene={scene} label="Guided Diagram Walkthrough" />
      <PageImagePanel scene={scene} />
      <FloatingTeachingCard
        label="Follow the real diagram"
        title={getFocus(scene)}
        body={getReference(scene) || "Trace the real flow before simplifying anything."}
        tone="teal"
      />
      <CaptionStrip scene={scene} />
    </Shell>
  );
}

function AnalogyOverlayScene({ scene }) {
  return (
    <Shell scene={scene}>
      <Header scene={scene} label="Teaching Analogy" />
      <PageImagePanel scene={scene} dim />
      <FloatingTeachingCard
        label="Analogy overlay"
        title={getFocus(scene)}
        body={getReference(scene) || scene.caption}
        tone="teal"
      />
      <CaptionStrip scene={scene} />
    </Shell>
  );
}

function CommandScene({ scene }) {
  const command = getCommand(scene) || scene.caption || "Command focus";

  return (
    <Shell scene={scene}>
      <Header scene={scene} label="Command Focus" />

      {scene.pageImagePath ? <PageImagePanel scene={scene} dim /> : null}

      <div
        style={{
          position: "absolute",
          right: 90,
          top: 220,
          width: 520,
          bottom: 230,
          borderRadius: 36,
          padding: 28,
          background: "rgba(2,6,23,0.9)",
          border: "1px solid rgba(34,197,94,0.42)",
          boxShadow: "0 34px 120px rgba(0,0,0,0.6)",
          zIndex: 10,
          ...getOverlayEntranceStyle(16),
        }}
      >
        <div
          style={{
            color: "#4ade80",
            fontSize: 22,
            fontWeight: 900,
            letterSpacing: 1.6,
            textTransform: "uppercase",
            marginBottom: 26,
          }}
        >
          Reference command
        </div>

        <div
          style={{
            borderRadius: 24,
            padding: "30px 34px",
            background: "rgba(15,23,42,0.96)",
            border: "1px solid rgba(74,222,128,0.32)",
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
            color: "#bbf7d0",
            fontSize: 22,
            lineHeight: 1.25,
            whiteSpace: "pre-line",
            wordBreak: "break-word",
            overflowWrap: "anywhere",
            marginBottom: 36,
          }}
        >
          $ {command}
        </div>

        <div
          style={{
            fontSize: 24,
            lineHeight: 1.18,
            color: "#f8fafc",
            fontWeight: 850,
          }}
        >
          {scene.caption}
        </div>
      </div>

      <CaptionStrip scene={scene} />
    </Shell>
  );
}

function WorkflowScene({ scene }) {
  const steps = String(scene.caption || getFocus(scene))
    .split("→")
    .map((item) => item.trim())
    .filter(Boolean);

  const displaySteps =
    steps.length > 1 ? steps : [getFocus(scene), getReference(scene)].filter(Boolean);

  return (
    <Shell scene={scene}>
      <Header scene={scene} label="Operational Flow" />

      {scene.pageImagePath ? <PageImagePanel scene={scene} dim /> : null}

      <div
        style={{
          position: "absolute",
          top: 245,
          right: 90,
          width: 780,
          bottom: 230,
          borderRadius: 38,
          padding: 40,
          background: "rgba(15,23,42,0.88)",
          border: "1px solid rgba(96,165,250,0.3)",
          boxShadow: "0 34px 120px rgba(0,0,0,0.52)",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          gap: 20,
          zIndex: 10,
          ...getOverlayEntranceStyle(14),
        }}
      >
        {displaySteps.slice(0, 3).map((step, index) => (
          <div
            key={`${step}-${index}`}
            style={{
              borderRadius: 24,
              padding: 24,
              background: "rgba(30,64,175,0.28)",
              border: "1px solid rgba(147,197,253,0.32)",
              ...getStepRevealStyle(index, 18),
            }}
          >
            <div
              style={{
                fontSize: 20,
                color: "#93c5fd",
                fontWeight: 900,
                marginBottom: 10,
                textTransform: "uppercase",
                letterSpacing: 1.2,
              }}
            >
              Context {index + 1}
            </div>
            <div
              style={{
                fontSize: 30,
                lineHeight: 1.15,
                color: "#f8fafc",
                fontWeight: 850,
              }}
            >
              {step}
            </div>
          </div>
        ))}
      </div>

      <CaptionStrip scene={scene} />
    </Shell>
  );
}

function WarningCalloutScene({ scene }) {
  return (
    <Shell scene={scene}>
      <Header scene={scene} label="Common Mistake" />
      {scene.pageImagePath ? <PageImagePanel scene={scene} dim /> : null}
      <FloatingTeachingCard
        label="Watch out"
        title={getFocus(scene)}
        body={getReference(scene) || scene.caption}
        tone="amber"
        right={120}
        top={260}
      />
      <CaptionStrip scene={scene} />
    </Shell>
  );
}

function DebuggingFocusScene({ scene }) {
  return (
    <Shell scene={scene}>
      <Header scene={scene} label="Debugging Focus" />
      {scene.pageImagePath ? <PageImagePanel scene={scene} dim /> : null}
      <FloatingTeachingCard
        label="Troubleshooting signal"
        title={getFocus(scene)}
        body={getReference(scene) || scene.caption}
        tone="blue"
        right={120}
        top={260}
      />
      <CaptionStrip scene={scene} />
    </Shell>
  );
}

function RecapSummaryScene({ scene }) {
  return (
    <Shell scene={scene}>
      <Header scene={scene} label="Key Takeaways" />

      <div
        style={{
          position: "absolute",
          left: 150,
          right: 150,
          top: 250,
          borderRadius: 38,
          padding: 56,
          background: "rgba(15,23,42,0.86)",
          border: "1px solid rgba(148,163,184,0.28)",
          boxShadow: "0 34px 120px rgba(0,0,0,0.55)",
          zIndex: 10,
          ...getOverlayEntranceStyle(8),
        }}
      >
        <div
          style={{
            fontSize: 70,
            lineHeight: 1.02,
            fontWeight: 950,
            color: "#f8fafc",
            marginBottom: 30,
          }}
        >
          Purpose → workflow → details → debugging
        </div>

        <div
          style={{
            fontSize: 36,
            lineHeight: 1.22,
            color: "#dbeafe",
            fontWeight: 750,
          }}
        >
          {scene.caption}
        </div>
      </div>

      <CaptionStrip scene={scene} />
    </Shell>
  );
}

function TeachingCardScene({ scene }) {
  const isQuestion =
    scene.type === "question" ||
    scene.visualType === "speaker_card" ||
    scene.visualIntent?.mode === "speaker_question";

  return (
    <Shell scene={scene}>
      <div
        style={{
          maxWidth: 1360,
          margin: "0 auto",
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          ...getOverlayEntranceStyle(6),
        }}
      >
        <div style={{ width: "100%" }}>
          <div
            style={{
              fontSize: 18,
              color: "#60a5fa",
              letterSpacing: 1.4,
              textTransform: "uppercase",
              fontWeight: 800,
              marginBottom: 16,
            }}
          >
            Notebook · Section {scene.sectionNumber}
          </div>

          <div
            style={{
              borderRadius: 36,
              padding: 54,
              background: isQuestion
                ? "rgba(13, 148, 136, 0.16)"
                : "rgba(15, 23, 42, 0.84)",
              border: isQuestion
                ? "1px solid rgba(45, 212, 191, 0.36)"
                : "1px solid rgba(148, 163, 184, 0.26)",
              boxShadow: "0 34px 120px rgba(0,0,0,0.52)",
            }}
          >
            <SpeakerBadge speaker={scene.speaker} />

            <div
              style={{
                marginTop: 34,
                fontSize: 64,
                fontWeight: 950,
                lineHeight: 1.02,
                letterSpacing: -1.8,
                color: "#f8fafc",
                maxWidth: 1180,
              }}
            >
              {getSceneTitle(scene)}
            </div>

            <div
              style={{
                marginTop: 34,
                fontSize: 42,
                lineHeight: 1.22,
                fontWeight: 750,
                color: isQuestion ? "#ccfbf1" : "#dbeafe",
                maxWidth: 1180,
              }}
            >
              {scene.caption}
            </div>
          </div>
        </div>
      </div>
    </Shell>
  );
}

function SceneCard({ scene }) {
  switch (scene.visualType) {
    case "focus_guided_document_scene":
      return <PagePreviewScene scene={scene} />;

    case "command_reference_scene":
      return <CommandScene scene={scene} />;

    case "operational_signal_scene":
      return <DebuggingFocusScene scene={scene} />;

    case "workflow_context_scene":
      return <WorkflowScene scene={scene} />;

    case "document_reference_scene":
      return <PagePreviewScene scene={scene} />;

    case "concept_overlay_scene":
      return <AnalogyOverlayScene scene={scene} />;

    case "diagram_dominant_scene":
      return <ArchitectureFocusScene scene={scene} />;

    case "component_focus_scene":
      return <DiagramGuidedScene scene={scene} />;

    case "flow_walkthrough_scene":
      return <WorkflowScene scene={scene} />;

    case "step_reference_scene":
      return <WorkflowScene scene={scene} />;

    case "verification_focus_scene":
      return <DebuggingFocusScene scene={scene} />;

    case "decision_checkpoint_scene":
      return <WarningCalloutScene scene={scene} />;

    case "architecture_focus_scene":
      return <ArchitectureFocusScene scene={scene} />;

    case "diagram_guided_scene":
      return <DiagramGuidedScene scene={scene} />;

    case "analogy_overlay_scene":
      return <AnalogyOverlayScene scene={scene} />;

    case "command_scene":
      return <CommandScene scene={scene} />;

    case "workflow_scene":
      return <WorkflowScene scene={scene} />;

    case "warning_callout_scene":
      return <WarningCalloutScene scene={scene} />;

    case "debugging_focus_scene":
      return <DebuggingFocusScene scene={scene} />;

    case "recap_summary_scene":
      return <RecapSummaryScene scene={scene} />;

    case "page_preview_card":
      return <PagePreviewScene scene={scene} />;

    default:
      return <TeachingCardScene scene={scene} />;
  }
}

function CinematicScene({ scene, durationFrames }) {
  const entranceStyle = getSceneEntranceStyle(scene, durationFrames);

  return (
    <AbsoluteFill
      style={{
        background: "#020617",
        opacity: entranceStyle.opacity,
        transform: entranceStyle.transform,
        overflow: "hidden",
      }}
    >
      <SceneCard scene={scene} />
    </AbsoluteFill>
  );
}

function NotebookVideo({ renderPlan }) {
  return (
    <AbsoluteFill style={{ background: "#020617" }}>
      {renderPlan.scenes.map((scene) => {
        const durationFrames = msToFrames(scene.durationMs || scene.estimatedDurationMs || 4000);
        const from = msToFrames(scene.startMs || 0);

        return (
          <Sequence key={scene.sectionNumber} from={from} durationInFrames={durationFrames}>
            <CinematicScene scene={scene} durationFrames={durationFrames} />

            {scene.audioPath ? <Audio src={staticFile(scene.audioPath)} /> : null}
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
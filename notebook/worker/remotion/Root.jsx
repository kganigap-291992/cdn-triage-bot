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

function getTransitionFrames(scene, durationFrames) {
  const transition = scene.transition || {};
  const behavior = scene.sceneBehavior || {};

  const inMs =
    transition.inMs ||
    behavior.transitionInMs ||
    360;

  const outMs =
    transition.outMs ||
    behavior.transitionOutMs ||
    420;

  return {
    inFrames: clamp(msToFrames(inMs), 4, Math.max(4, Math.floor(durationFrames / 3))),
    outFrames: clamp(msToFrames(outMs), 4, Math.max(4, Math.floor(durationFrames / 3))),
  };
}

function getSceneOpacity(scene, durationFrames) {
  const frame = useCurrentFrame();
  const { inFrames, outFrames } = getTransitionFrames(scene, durationFrames);

  const fadeInOpacity = interpolate(
    frame,
    [0, inFrames],
    [0, 1],
    {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
      easing: Easing.out(Easing.cubic),
    }
  );

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

  const y = interpolate(
    frame,
    [0, inFrames],
    [14, 0],
    {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
      easing: Easing.out(Easing.cubic),
    }
  );

  const scale = interpolate(
    frame,
    [0, durationFrames],
    [1.006, 1],
    {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
      easing: Easing.out(Easing.cubic),
    }
  );

  return {
    opacity: getSceneOpacity(scene, durationFrames),
    transform: `translateY(${y}px) scale(${scale})`,
  };
}

function getCameraMotionStyle(scene, dim = false) {
  const frame = useCurrentFrame();
  const durationFrames = msToFrames(scene.durationMs || scene.estimatedDurationMs || 4000);
  const progress = durationFrames <= 1 ? 1 : frame / durationFrames;
  const cameraMotion = scene?.sceneBehavior?.cameraMotion || "static";

  let startScale = 1;
  let endScale = 1.012;
  let startX = 0;
  let endX = 0;
  let startY = 0;
  let endY = 0;

  switch (cameraMotion) {
    case "slow_zoom":
      endScale = 1.035;
      break;

    case "slow_focus":
    case "soft_focus":
      endScale = 1.026;
      startY = 4;
      endY = -4;
      break;

    case "soft_pan":
      endScale = 1.018;
      startX = -8;
      endX = 8;
      break;

    case "guided_pan":
      endScale = 1.028;
      startX = -12;
      endX = 12;
      startY = 4;
      endY = -4;
      break;

    case "flow_pan":
      endScale = 1.03;
      startX = -16;
      endX = 16;
      break;

    case "step_focus":
      endScale = 1.02;
      startY = 6;
      endY = -6;
      break;

    case "static":
    default:
      endScale = 1.008;
      break;
  }

  const easedProgress = Easing.inOut(Easing.cubic)(clamp(progress, 0, 1));

  const scale = startScale + (endScale - startScale) * easedProgress;
  const x = startX + (endX - startX) * easedProgress;
  const y = startY + (endY - startY) * easedProgress;

  return {
    transform: `translate(${x}px, ${y}px) scale(${scale})`,
    opacity: dim ? 0.62 : 1,
  };
}

function getOverlayEntranceStyle(delayFrames = 5) {
  const frame = useCurrentFrame();

  const opacity = interpolate(
    frame,
    [delayFrames, delayFrames + 14],
    [0, 1],
    {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
      easing: Easing.out(Easing.cubic),
    }
  );

  const y = interpolate(
    frame,
    [delayFrames, delayFrames + 14],
    [18, 0],
    {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
      easing: Easing.out(Easing.cubic),
    }
  );

  return {
    opacity,
    transform: `translateY(${y}px)`,
  };
}

function Shell({ children }) {
  return (
    <AbsoluteFill
      style={{
        background:
          "radial-gradient(circle at 20% 0%, rgba(37,99,235,0.38), transparent 34%), radial-gradient(circle at 80% 20%, rgba(14,165,233,0.18), transparent 28%), linear-gradient(135deg, #020617 0%, #07111f 48%, #000 100%)",
        color: "white",
        fontFamily:
          "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif",
        padding: 56,
      }}
    >
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
        background: isSenior
          ? "rgba(37, 99, 235, 0.22)"
          : "rgba(20, 184, 166, 0.18)",
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
        ...getOverlayEntranceStyle(9),
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

  return (
    <div
      style={{
        position: "absolute",
        top: 168,
        left: 72,
        right: 72,
        bottom: 190,
        borderRadius: 34,
        overflow: "hidden",
        background: "rgba(15, 23, 42, 0.78)",
        border: "1px solid rgba(148, 163, 184, 0.26)",
        boxShadow: "0 34px 120px rgba(0,0,0,0.55)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 28,
        ...getOverlayEntranceStyle(4),
      }}
    >
      {scene.pageImagePath ? (
        <Img
          src={staticFile(scene.pageImagePath)}
          style={{
            width: "100%",
            height: "100%",
            objectFit: "contain",
            borderRadius: 22,
            background: "#020617",
            transform: motionStyle.transform,
            opacity: motionStyle.opacity,
          }}
        />
      ) : (
        <div
          style={{
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
        width: 560,
        borderRadius: 30,
        padding: 34,
        background: theme.bg,
        border: `1px solid ${theme.border}`,
        boxShadow: "0 28px 90px rgba(0,0,0,0.5)",
        zIndex: 10,
        ...getOverlayEntranceStyle(12),
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
          fontSize: 38,
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
          fontSize: 28,
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
    <Shell>
      <Header scene={scene} />
      <PageImagePanel scene={scene} />
      <CaptionStrip scene={scene} />
    </Shell>
  );
}

function ArchitectureFocusScene({ scene }) {
  return (
    <Shell>
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
    <Shell>
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
    <Shell>
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
    <Shell>
      <Header scene={scene} label="Command Focus" />

      {scene.pageImagePath ? (
        <PageImagePanel scene={scene} dim />
      ) : null}

      <div
        style={{
          position: "absolute",
          right: 90,
          top: 220,
          width: 760,
          bottom: 230,
          borderRadius: 36,
          padding: 46,
          background: "rgba(2,6,23,0.9)",
          border: "1px solid rgba(34,197,94,0.42)",
          boxShadow: "0 34px 120px rgba(0,0,0,0.6)",
          ...getOverlayEntranceStyle(10),
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
            fontFamily:
              "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
            color: "#bbf7d0",
            fontSize: 30,
            lineHeight: 1.25,
            whiteSpace: "pre-wrap",
            marginBottom: 36,
          }}
        >
          $ {command}
        </div>

        <div
          style={{
            fontSize: 32,
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
    steps.length > 1
      ? steps
      : [getFocus(scene), getReference(scene)].filter(Boolean);

  return (
    <Shell>
      <Header scene={scene} label="Operational Flow" />

      {scene.pageImagePath ? (
        <PageImagePanel scene={scene} dim />
      ) : null}

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
          ...getOverlayEntranceStyle(10),
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
    <Shell>
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
    <Shell>
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
    <Shell>
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
    <AbsoluteFill
      style={{
        background:
          "radial-gradient(circle at top left, rgba(37,99,235,0.35), transparent 34%), radial-gradient(circle at bottom right, rgba(20,184,166,0.16), transparent 30%), linear-gradient(135deg, #020617 0%, #07111f 50%, #000 100%)",
        color: "white",
        fontFamily:
          "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif",
        padding: 72,
        justifyContent: "center",
      }}
    >
      <div
        style={{
          maxWidth: 1360,
          margin: "0 auto",
          width: "100%",
          ...getOverlayEntranceStyle(6),
        }}
      >
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
    </AbsoluteFill>
  );
}

function SceneCard({ scene }) {
  switch (scene.visualType) {
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
      }}
    >
      <SceneCard scene={scene} />
    </AbsoluteFill>
  );
}

function NotebookVideo({ renderPlan }) {
  return (
    <AbsoluteFill>
      {renderPlan.scenes.map((scene) => {
        const durationFrames = msToFrames(
          scene.durationMs || scene.estimatedDurationMs || 4000
        );

        const from = msToFrames(scene.startMs || 0);

        return (
          <Sequence
            key={scene.sectionNumber}
            from={from}
            durationInFrames={durationFrames}
          >
            <CinematicScene
              scene={scene}
              durationFrames={durationFrames}
            />

            {scene.audioPath ? (
              <Audio src={staticFile(scene.audioPath)} />
            ) : null}
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
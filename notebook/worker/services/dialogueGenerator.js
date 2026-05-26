// notebook/worker/services/dialogueGenerator.js

const fs = require("fs");
const path = require("path");

const { buildDocumentIntelligence } = require("./documentIntelligence");
const { buildLessonGraph } = require("./lessonGraphBuilder");

const DIALOGUE_VERSION = "dialogue-v13-natural-architecture-storytelling";

function getDialoguePath(jobDir) {
  return path.join(jobDir, "dialogue.json");
}

function readJsonIfExists(filePath, fallback = {}) {
  if (!fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function cleanText(value, maxLength = 900) {
  if (!value) return "";
  return String(value).replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function sentence(value) {
  const text = cleanText(value, 500);
  if (!text) return "";
  return text.endsWith(".") ? text : `${text}.`;
}

function lowerFirst(value) {
  const text = cleanText(value, 500);
  if (!text) return "";
  return text.charAt(0).toLowerCase() + text.slice(1);
}

function stripTrailingPeriod(value) {
  return cleanText(value, 500).replace(/\.+$/g, "");
}

function buildShortCaption(value, maxLength = 110) {
  const text = cleanText(value, maxLength + 40);
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 3).trim()}...`;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function isArchitectureLesson(documentIntelligence, lessonGraph) {
  return (
    documentIntelligence?.primaryType === "architecture_doc" ||
    lessonGraph?.documentType === "architecture_doc" ||
    lessonGraph?.stats?.architectureTeachingApplied === true
  );
}

function buildVisualIntent(args) {
  return {
    mode: args.mode,
    page: args.page ?? null,
    focus: args.focus ?? null,
    command: args.command ?? null,
    reference: args.reference ?? null,
    step: args.step ?? null,
    totalSteps: args.totalSteps ?? null,
    presentationStyle: args.presentationStyle ?? null,
    sceneIntent: args.sceneIntent ?? null,
    focusHint: args.focusHint ?? null,
    spokenFocus: args.spokenFocus ?? null,
    spokenFocusTargets: args.spokenFocusTargets || [],
    avoidNarration: args.avoidNarration || [],
  };
}

function firstSourcePage(unit) {
  if (!Array.isArray(unit?.sourcePages)) return null;
  return unit.sourcePages.find((page) => typeof page === "number" && Number.isFinite(page)) ?? null;
}

function getVisibleElements(unit) {
  return Array.isArray(unit?.visibleElements)
    ? unit.visibleElements.map((item) => cleanText(item, 180)).filter(Boolean)
    : [];
}

function getConcepts(unit) {
  return Array.isArray(unit?.concepts)
    ? unit.concepts.map((item) => cleanText(item, 220)).filter(Boolean)
    : [];
}

function getCommandDetails(unit) {
  return Array.isArray(unit?.metadata?.commandDetails) ? unit.metadata.commandDetails : [];
}

function normalizeCommandText(value) {
  return cleanText(value, 220).replace(/^`+|`+$/g, "").trim();
}

function isCommandLike(value) {
  const text = normalizeCommandText(value);
  if (!text) return false;
  return /^(kubectl|helm|docker|curl|ssh|git|npm|node|python|go|java|terraform|ansible)\b/i.test(text);
}

function splitCommandBlob(value) {
  const text = cleanText(value, 900);
  if (!text) return [];

  return text
    .replace(/\s+/g, " ")
    .replace(/\s+—\s+/g, " — ")
    .trim()
    .split(/\s+(?=\d+[.)]?\s+(kubectl|helm|docker|curl|ssh|git|npm|node|python|go|java|terraform|ansible)\b)/i)
    .map((item) => item.trim())
    .filter(Boolean)
    .map((chunk) => {
      const cleaned = chunk.replace(/^\d+[.)]?\s+/, "").trim();
      return cleaned.split(/\s+—\s+/)[0]?.trim() || cleaned;
    })
    .filter((command) => {
      if (!isCommandLike(command)) return false;
      if (/^kubectl$/i.test(command)) return false;
      return command.split(/\s+/).length >= 2;
    });
}

function getPreferredVisualMode(unit) {
  const preferred = Array.isArray(unit?.preferredVisuals) ? unit.preferredVisuals : [];

  if (preferred.includes("command_focus")) return "command_focus";
  if (preferred.includes("full_diagram")) return "architecture_full_diagram";
  if (preferred.includes("diagram_region_focus")) return "architecture_region_focus";
  if (preferred.includes("summary_card")) return "recap_summary";
  if (preferred.includes("step_focus")) return "step_focus";
  if (preferred.includes("verification_card")) return "verification_card";
  if (preferred.includes("decision_point")) return "decision_point";

  return "teaching_unit_focus";
}

function normalizeDebuggingSignal(value) {
  return stripTrailingPeriod(lowerFirst(value))
    .replace(/^failure indicates\s+/i, "")
    .replace(/^failures indicate\s+/i, "")
    .replace(/^errors indicate\s+/i, "")
    .replace(/^error indicates\s+/i, "")
    .replace(/^missing\s+/i, "missing ")
    .trim();
}

function buildSpokenFocusTarget({
  type,
  text,
  label,
  reason,
  priority = 1,
  focusMode = "line",
  source = "dialogueGenerator",
}) {
  const cleanTargetText = cleanText(text, 260);
  const cleanLabel = cleanText(label || text, 140);
  if (!cleanTargetText && !cleanLabel) return null;

  return {
    type,
    text: cleanTargetText,
    label: cleanLabel || "Focus",
    reason: cleanText(reason, 260),
    priority,
    focusMode,
    source,
  };
}

function buildCommandSpokenFocusTargets(unit) {
  const commandDetails = getCommandDetails(unit);
  const visibleElements = getVisibleElements(unit);

  const detailTargets = commandDetails
    .flatMap((commandDetail, detailIndex) =>
      splitCommandBlob(commandDetail.command).map((command, commandIndex) =>
        buildSpokenFocusTarget({
          type: "command",
          text: command,
          label: command,
          reason:
            commandDetail.whenToUse ||
            commandDetail.debuggingSignal ||
            commandDetail.meaning ||
            "Command discussed in narration",
          priority: detailIndex * 10 + commandIndex + 1,
          focusMode: "line",
        })
      )
    )
    .filter(Boolean);

  const visibleTargets = visibleElements
    .flatMap((item) => splitCommandBlob(item))
    .slice(0, 8)
    .map((command, index) =>
      buildSpokenFocusTarget({
        type: "command",
        text: command,
        label: command,
        reason: "Visible command referenced by this teaching unit",
        priority: detailTargets.length + index + 1,
        focusMode: "line",
      })
    )
    .filter(Boolean);

  const seen = new Set();
  return [...detailTargets, ...visibleTargets].filter((target) => {
    const key = target.text.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function buildArchitectureSpokenFocusTargets(unit) {
  const metadata = unit?.metadata || {};
  const segments = asArray(metadata.enrichedSegments);

  const segmentTargets = segments
    .map((segment, index) => {
      const fromName = cleanText(segment?.from?.name, 120);
      const toName = cleanText(segment?.to?.name, 120);
      const conceptLabel = cleanText(segment?.teachingContext?.conceptLabel, 120);
      if (!fromName && !toName && !conceptLabel) return null;

      return buildSpokenFocusTarget({
        type: "architecture_handoff",
        text: fromName && toName ? `${fromName} → ${toName}` : conceptLabel,
        label: conceptLabel || `${fromName} to ${toName}`,
        reason:
          segment?.teachingContext?.operationalMeaning ||
          segment?.transitionNarrationHint ||
          "Architecture handoff discussed in this scene",
        priority: index + 1,
        focusMode: "region",
        source: "architectureTeaching",
      });
    })
    .filter(Boolean);

  if (segmentTargets.length) return segmentTargets;

  const title = cleanText(unit.title, 180);
  return [
    buildSpokenFocusTarget({
      type: metadata.role === "architecture_recap" ? "architecture_recap" : "architecture_chapter",
      text: title,
      label: title,
      reason: metadata.operationalMeaning || metadata.recapMentalModel || "Architecture teaching chapter",
      priority: 1,
      focusMode: "region",
      source: "architectureTeaching",
    }),
  ].filter(Boolean);
}

function buildConceptSpokenFocusTargets(unit, documentIntelligence, lessonGraph) {
  if (isArchitectureLesson(documentIntelligence, lessonGraph)) {
    return buildArchitectureSpokenFocusTargets(unit);
  }

  const title = cleanText(unit.title, 180);
  const concepts = getConcepts(unit).filter((item) => item !== title);
  const targets = [];

  if (title) {
    targets.push(
      buildSpokenFocusTarget({
        type: "concept",
        text: title,
        label: title,
        reason: "Primary topic being explained in this scene",
        priority: 1,
        focusMode: "section",
      })
    );
  }

  concepts.slice(0, 2).forEach((concept, index) => {
    targets.push(
      buildSpokenFocusTarget({
        type: "concept",
        text: concept,
        label: concept,
        reason: "Supporting concept mentioned in narration",
        priority: index + 2,
        focusMode: "section",
      })
    );
  });

  return targets.filter(Boolean);
}

function buildSpokenFocusForUnit(unit, documentIntelligence, lessonGraph) {
  const visibleElements = getVisibleElements(unit);
  const hasCommands = visibleElements.length > 0 || unit?.metadata?.hasCommands;

  const commandTargets =
    hasCommands || unit.type === "command_group" || unit.type === "compact_command_group"
      ? buildCommandSpokenFocusTargets(unit)
      : [];

  const conceptTargets = buildConceptSpokenFocusTargets(unit, documentIntelligence, lessonGraph);
  const targets = commandTargets.length ? commandTargets : conceptTargets;

  return {
    spokenFocus: targets[0] || null,
    spokenFocusTargets: targets,
  };
}

function buildCommandAwareText(unit, documentIntelligence) {
  const title = cleanText(unit.title, 180);
  const summary = cleanText(unit?.metadata?.summary, 320);
  const commandDetails = getCommandDetails(unit).slice(0, 2);

  const operationalContext = commandDetails
    .map((commandDetail, index) => {
      const parts = [];

      if (commandDetail.meaning) parts.push(stripTrailingPeriod(commandDetail.meaning));

      if (commandDetail.whenToUse) {
        const usage = stripTrailingPeriod(lowerFirst(commandDetail.whenToUse));
        if (usage) parts.push(index === 0 ? `Usually used ${usage}` : `Often helpful ${usage}`);
      }

      if (commandDetail.debuggingSignal) {
        const signal = normalizeDebuggingSignal(commandDetail.debuggingSignal);
        if (signal) parts.push(`Possible issue: ${signal}`);
      }

      return parts.join(". ");
    })
    .filter(Boolean)
    .join(". ");

  if (documentIntelligence.primaryType === "cheat_sheet") {
    return [
      `${title} is the operational area to use when this part of the system is being checked or connected.`,
      operationalContext,
      summary ? sentence(summary) : "",
    ]
      .filter(Boolean)
      .join(" ");
  }

  return [`${title} focuses on practical operational usage.`, operationalContext, summary ? sentence(summary) : ""]
    .filter(Boolean)
    .join(" ");
}

function getSegmentNames(segments) {
  const firstSegment = segments[0];
  const lastSegment = segments[segments.length - 1];

  return {
    fromName: cleanText(firstSegment?.from?.name, 120),
    toName: cleanText(lastSegment?.to?.name, 120),
  };
}

function getSegmentConceptLabel(segments, fallback) {
  return cleanText(
    segments[0]?.teachingContext?.conceptLabel ||
      segments[0]?.genericConcept ||
      fallback,
    140
  );
}

function getCalmNarration(segment) {
  return cleanText(
    segment?.calmNarration ||
      segment?.narration ||
      segment?.teachingNarration,
    1200
  );
}

function buildCalmNarrationIndex(jobDir) {
  if (!jobDir) return new Map();

  const narrationPath = path.join(jobDir, "calm-explainer-narration.json");
  const payload = readJsonIfExists(narrationPath, {});
  const segments = asArray(payload.segments);

  const index = new Map();

  for (const segment of segments) {
    if (segment.segmentId && segment.narration) {
      index.set(segment.segmentId, segment.narration);
    }

    if (segment.fromName && segment.toName && segment.narration) {
      index.set(`${segment.fromName}→${segment.toName}`, segment.narration);
    }
  }

  return index;
}

function attachCalmNarrationToSegments(segments = [], calmNarrationIndex = new Map()) {
  return asArray(segments).map((segment) => {
    const segmentId = segment.id || segment.sourceSegmentId;
    const calmNarration = calmNarrationIndex.get(segmentId);

    return {
      ...segment,
      calmNarration: calmNarration || segment.calmNarration || null,
    };
  });
}

function buildCalmNarrationTextFromSteps(
  steps = [],
  calmNarrationIndex = new Map(),
  regionAffinity = null
) {
  const cleanSteps = asArray(steps)
    .map((step) => {
      if (typeof step === "string") return cleanText(step, 260);

      return cleanText(
        step.name ||
          step.label ||
          step.title ||
          step.component ||
          step.entity ||
          step.text,
        260
      );
    })
    .filter(Boolean);

  if (!cleanSteps.length) return "";

  const regionHints = {
    traffic_entry: ["User Client→CDN Edge", "CDN Edge→API Gateway"],
    validation: ["API Gateway→Auth Service"],
    routing: ["API Gateway→Routing Layer", "Routing Layer→Application Cluster"],
    persistence: ["Routing Layer→Database", "Application Cluster→Database"],
  };

  const preferredKeys = regionHints[regionAffinity] || [];

  const narrations = [];

  for (const preferredKey of preferredKeys) {
    const narration = calmNarrationIndex.get(preferredKey);
    if (narration) narrations.push(sentence(narration));
  }

  if (narrations.length) {
    return narrations.slice(0, 1).join(" ");
  }
  
  const regionFallbacks = {
    validation:
      "This part of the architecture is about checking requests before they move deeper into the system. In a typical flow, a validation layer helps create a controlled boundary so downstream components only handle traffic that has passed the required checks.",
  };

  return regionFallbacks[regionAffinity] || "";

}


function buildArchitectureTeachingTextFromSegments(segments = []) {
  const usefulSegments = asArray(segments).filter(
    (segment) =>
      getCalmNarration(segment) ||
      segment?.plainEnglish ||
      segment?.whyItMatters ||
      segment?.safeSemantics ||
      segment?.memoryHook
  );

  if (!usefulSegments.length) return "";

  return usefulSegments
    .slice(0, 2)
    .map((segment, index) => {
      const calmNarration = sentence(getCalmNarration(segment));

      if (calmNarration) {
        return calmNarration;
      }

      const prefix = buildFlowTransitionPrefix(index);

      const plainEnglish = sentence(
        prefix
          ? `${prefix}${lowerFirst(segment.plainEnglish)}`
          : segment.plainEnglish
      );

      const flowContext = plainEnglish;
      const componentPurpose = sentence(segment.safeSemantics);
      const operationalImpact = sentence(segment.whyItMatters);
      const mentalModel = sentence(segment.memoryHook);

      const narrationParts = [flowContext, componentPurpose];

      if (operationalImpact) {
        narrationParts.push(operationalImpact);
      } else if (mentalModel) {
        narrationParts.push(mentalModel);
      }

      return narrationParts.filter(Boolean).join(" ");
    })
    .join(" ");
}

function buildNaturalResponsibilityText(conceptLabel, fromName, toName) {
  const key = cleanText(conceptLabel, 140).toLowerCase();

  if (key.includes("ingress") || key.includes("boundary")) {
    return "This is where requests first move from the public-facing edge into more controlled platform systems.";
  }

  if (key.includes("routing") || key.includes("control")) {
    return "At this stage, the platform starts deciding how requests should move through downstream services.";
  }

  if (key.includes("fanout") || key.includes("distribution")) {
    return "Here the flow can branch, allowing requests or work to move toward multiple downstream paths.";
  }

  if (
    key.includes("state") ||
    key.includes("persistence") ||
    key.includes("terminal")
  ) {
    return "This part of the flow reaches systems responsible for longer-lived state or backend processing.";
  }

  if (key.includes("processing") || key.includes("transform")) {
    return "This layer continues the main execution or processing work inside the platform.";
  }

  if (fromName && toName) {
    return `${toName} is the next layer helping handle the request as it moves deeper into the platform.`;
    }

  return "";
}

function buildFlowTransitionPrefix(index) {
  if (index === 0) return "";

  const transitions = [
    "Next, ",
    "Here, ",
    "Further downstream, ",
    "By this point, ",
  ];

  return transitions[(index - 1) % transitions.length];
}

function getFirstArchitectureHandoff(metadata = {}, lessonGraph = {}) {
  const enrichedSegments = asArray(metadata.enrichedSegments);

  if (enrichedSegments.length > 0) {
    return enrichedSegments[0];
  }

  const teachingUnits = asArray(lessonGraph.teachingUnits);

  for (const unit of teachingUnits) {
    const segments = asArray(unit?.metadata?.enrichedSegments);
    if (segments.length > 0) {
      return segments[0];
    }
  }

  return null;
}

function buildArchitectureAwareText(unit, lessonGraph = {}, calmNarrationIndex = new Map()) {
  const metadata = unit?.metadata || {};
  const role = metadata.role;
  const segments = attachCalmNarrationToSegments(
    metadata.enrichedSegments,
    calmNarrationIndex
    );  

  const calmTextFromSteps = buildCalmNarrationTextFromSteps(
    metadata.steps,
    calmNarrationIndex,
    metadata.regionAffinity
  );

  if (calmTextFromSteps) {
    return calmTextFromSteps;
  }  

  const recapMentalModel = cleanText(metadata.recapMentalModel, 520);

  if (role === "architecture_overview") {
    const firstHandoff = getFirstArchitectureHandoff(metadata, lessonGraph);

    const fromName = cleanText(firstHandoff?.from?.name, 120);
    const toName = cleanText(firstHandoff?.to?.name, 120);

    return [
        "This walkthrough follows the request journey one layer at a time.",
        fromName && toName
            ? `The request first reaches ${toName} before moving deeper into the platform.`
            : "",
        "Let’s build a simple mental model of what each layer is doing as the request moves deeper into the platform.",
        ]
        .filter(Boolean)
        .join(" ");
        }

  if (role === "architecture_recap") {
    return [
        "At a high level, the request moves through layers that each handle a different job.",
        "The important mental model is: receive traffic, direct it, process it, and eventually handle longer-lived state or results.",
        ]
        .filter(Boolean)
        .join(" ");
    }

    const teachingText = buildArchitectureTeachingTextFromSegments(segments);
        if (teachingText) return teachingText;

        const { fromName, toName } = getSegmentNames(segments);
        const conceptLabel = getSegmentConceptLabel(segments, unit.title);

        return [
            fromName && toName
            ? `From here, the flow moves from ${fromName} toward ${toName}.`
            : "",
            buildNaturalResponsibilityText(conceptLabel, fromName, toName),
        ]
            .filter(Boolean)
            .join(" ");
}

function buildConceptAwareText(unit, documentIntelligence, lessonGraph) {
  if (isArchitectureLesson(documentIntelligence, lessonGraph)) {
    return buildArchitectureAwareText(unit, lessonGraph);
  }

  const title = cleanText(unit.title, 180);
  const titleKey = title.toLowerCase();

  const concepts = getConcepts(unit).filter((item) => {
    const text = String(item || "").trim().toLowerCase();
    return (
      text &&
      text !== titleKey &&
      text !== "architecture overview" &&
      text !== "primary_architecture_flow" &&
      !text.endsWith("_architecture_flow")
    );
  });

  const summary = cleanText(unit?.metadata?.summary, 420);

  if (unit.type === "purpose") {
    if (documentIntelligence.primaryType === "cheat_sheet") {
      return "This walkthrough groups the most useful commands and operational reference points into a short guided flow.";
    }

    return "This walkthrough focuses on the workflow, concepts, and operational reasoning from the document.";
  }

  if (unit.type === "recap") {
    if (documentIntelligence.primaryType === "cheat_sheet") {
      return "Use the sheet as a fast operational reference and return to the source when exact syntax is needed.";
    }

    return "Focus on understanding the workflow and relationships between the major concepts.";
  }

  if (documentIntelligence.primaryType === "design_doc") {
    return [`${title} represents a design decision or tradeoff.`, summary ? sentence(summary) : ""]
      .filter(Boolean)
      .join(" ");
  }

  if (documentIntelligence.primaryType === "runbook") {
    return [`${title} is part of the operational execution flow.`, summary ? sentence(summary) : ""]
      .filter(Boolean)
      .join(" ");
  }

  return [
    `${title} is the next core concept.`,
    summary ? sentence(summary) : "",
    concepts.length ? `It connects to ${concepts.slice(0, 2).join(" and ")}.` : "",
  ]
    .filter(Boolean)
    .join(" ");
}


function buildTeachingUnitText(unit, documentIntelligence, lessonGraph, calmNarrationIndex = new Map()) {
  if (isArchitectureLesson(documentIntelligence, lessonGraph)) {
    return buildArchitectureAwareText(unit, lessonGraph, calmNarrationIndex);
  }

  const visibleElements = getVisibleElements(unit);
  const hasCommands = visibleElements.length > 0 || unit?.metadata?.hasCommands;

  if (hasCommands || unit.type === "command_group" || unit.type === "compact_command_group") {
    return buildCommandAwareText(unit, documentIntelligence);
  }

  return buildConceptAwareText(unit, documentIntelligence, lessonGraph);
}

function buildSectionFromTeachingUnit(unit, index, totalUnits, documentIntelligence, lessonGraph, calmNarrationIndex = new Map()) {
  const page = firstSourcePage(unit);
  const visibleElements = getVisibleElements(unit);
  const visualMode = getPreferredVisualMode(unit);
  const { spokenFocus, spokenFocusTargets } = buildSpokenFocusForUnit(unit, documentIntelligence, lessonGraph);

  const sectionNumber = String(index + 1).padStart(3, "0");

  return {
    sectionNumber,
    speaker: "Mentor",
    type: `lesson_${unit.type || "teaching_unit"}`,
    page,
    text: buildTeachingUnitText(
        unit,
        documentIntelligence,
        lessonGraph,
        calmNarrationIndex
        ),
    caption: buildShortCaption(unit.title || "Teaching unit"),
    targetDurationSec: unit.targetDurationSec,
    teachingUnitId: unit.id,
    teachingMode: unit.teachingMode,
    narrationGoals: unit.narrationGoals || [],
    avoidNarration: unit.avoidNarration || [],
    spokenFocus,
    spokenFocusTargets,
    visualIntent: buildVisualIntent({
      mode: visualMode,
      page,
      focus: spokenFocus?.label || unit.title,
      command: visibleElements.join(" | "),
      reference:
        unit?.metadata?.operationalMeaning ||
        unit?.metadata?.transitionNarrationHint ||
        unit?.metadata?.summary ||
        null,
      step: index + 1,
      totalSteps: totalUnits,
      presentationStyle: unit.presentationStyle || null,
      sceneIntent: unit.sceneIntent || null,
      focusHint: unit.focusHint || null,
      spokenFocus,
      spokenFocusTargets,
      avoidNarration: unit.avoidNarration || [],
    }),
    metadata: {
      ...(unit.metadata || {}),
      spokenFocus,
      spokenFocusTargets,
      spokenFocusSync: {
        version: "spoken-focus-v3-natural-architecture",
        source: "dialogueGenerator",
        targetCount: spokenFocusTargets.length,
        primaryTargetType: spokenFocus?.type || null,
        primaryTargetText: spokenFocus?.text || null,
      },
    },
  };
}

function buildRareLearnerCheckIn(documentIntelligence, lessonGraph) {
  if (
    documentIntelligence.primaryType === "cheat_sheet" ||
    isArchitectureLesson(documentIntelligence, lessonGraph)
  ) {
    return null;
  }

  return {
    speaker: "New Joiner",
    type: "learner_check_in",
    text: "So I should focus on how the pieces work together, not memorize the page?",
    caption: "Focus on the system",
    spokenFocus: {
      type: "concept",
      text: "learning approach",
      label: "Learning approach",
      reason: "Brief learner clarification",
      priority: 1,
      focusMode: "section",
      source: "dialogueGenerator",
    },
    spokenFocusTargets: [],
    visualIntent: buildVisualIntent({
      mode: "learner_overlay",
      focus: "learning approach",
      presentationStyle: "learner_overlay",
      sceneIntent: "brief_clarifying_interjection",
    }),
  };
}

function buildDialogue({
  extractedData = {},
  extractedText,
  diagramAnalysis,
  conceptsData,
  lessonPlan,
  jobDir = null,
}) {
  const builtDocumentIntelligence = buildDocumentIntelligence({
    extractedText,
    conceptsData,
    diagramAnalysis,
  });

  const lessonGraph =
    lessonPlan?.lessonGraph &&
    Array.isArray(lessonPlan.lessonGraph.teachingUnits)
      ? lessonPlan.lessonGraph
      : buildLessonGraph({
          documentIntelligence: builtDocumentIntelligence,
          conceptsData,
          extractedData,
          diagramAnalysis,
          jobDir,
        });

  const documentIntelligence = {
    ...builtDocumentIntelligence,
    primaryType: lessonGraph?.documentType || builtDocumentIntelligence.primaryType,
    secondaryTypes: lessonGraph?.secondaryTypes || builtDocumentIntelligence.secondaryTypes || [],
  };

  const teachingUnits = Array.isArray(lessonGraph.teachingUnits)
    ? lessonGraph.teachingUnits
    : [];

    const calmNarrationIndex = buildCalmNarrationIndex(jobDir);

    const sections = [];

  for (const [index, unit] of teachingUnits.entries()) {
    sections.push(
        buildSectionFromTeachingUnit(
        unit,
        index,
        teachingUnits.length,
        documentIntelligence,
        lessonGraph,
        calmNarrationIndex
        )
    );

    if (index === 0) {
        const learnerCheckIn = buildRareLearnerCheckIn(
        documentIntelligence,
        lessonGraph
        );
        if (learnerCheckIn) sections.push(learnerCheckIn);
    }
    }

  const architectureLesson = isArchitectureLesson(documentIntelligence, lessonGraph);

  return {
    generatedAt: new Date().toISOString(),
    style: lessonGraph.compactCheatSheet
        ? "compact_instructor_led_operational_reference"
        : architectureLesson
        ? "architecture_mentor_component_purpose_walkthrough"
        : "instructor_led_lesson_graph_walkthrough",
    version: DIALOGUE_VERSION,
    speakers:
        documentIntelligence.primaryType === "cheat_sheet" || architectureLesson
        ? ["Mentor"]
        : ["Mentor", "New Joiner"],
    documentIntelligence,
    lessonGraph,
    pacing: {
      sectionCount: sections.length,
      teachingUnitCount: teachingUnits.length,
      runtimeBudgetMinutes: lessonGraph.runtimeBudgetMinutes,
      requestedRuntimeBudgetMinutes: lessonGraph.requestedRuntimeBudgetMinutes,
      maxRuntimeMinutes: documentIntelligence.maxRuntimeMinutes,
      targetSceneCount: documentIntelligence.targetSceneCount,
      totalTargetDurationSec: lessonGraph.stats?.totalTargetDurationSec,
      averageTargetDurationSec: lessonGraph.stats?.averageTargetDurationSec,
      compactRuntimeCompressionApplied: lessonGraph.stats?.compactRuntimeCompressionApplied,
      presentationGrammar: documentIntelligence.presentationGrammar?.style,
    },
    sourceArtifacts: {
      usesExtractedText: true,
      usesExtractedData: true,
      usesDiagramAnalysis: true,
      usesConcepts: true,
      usesPrimaryTopics: Array.isArray(conceptsData.primaryTopics),
      usesSubConcepts: Array.isArray(conceptsData.primaryTopics)
        ? conceptsData.primaryTopics.some(
            (topic) => Array.isArray(topic.subConcepts) && topic.subConcepts.length > 0
          )
        : false,
      usesLessonPlan: Array.isArray(lessonPlan.lessonStructure),
      usesDocumentIntelligence: true,
      usesLessonGraph: true,
      usesArchitectureTeaching: lessonGraph.stats?.architectureTeachingApplied === true,
      usesCalmExplainerNarration: Boolean(calmNarrationIndex.size),
      usesDocumentStructure:
        Boolean(lessonGraph.documentStructure) ||
        Boolean(lessonGraph.stats?.documentStructureApplied),
    },
    teachingRules: {
      dialogueOwnsWordingOnly: true,
      lessonGraphOwnsPedagogy: true,
      architectureTeachingOwnsMeaning: lessonGraph.stats?.architectureTeachingApplied === true,
      documentIntelligenceOwnsClassificationBudgetAndGrammar: true,
      avoidReadingDocument: true,
      explainWhyItMatters: true,
      teachBeyondVisibleText: true,
      avoidReadingVisibleTextVerbatim: true,
      controlDialoguePacing: true,
      generateVisualIntent: true,
      generateSpokenFocusTargets: true,
      keepRealDocumentPrimary: true,
      useInstructorLedFlow: true,
      learnerInterjectionsAreRare: documentIntelligence.primaryType !== "cheat_sheet" && !architectureLesson,
      avoidEducationalTheater:
        documentIntelligence.documentDensity === "low" ||
        documentIntelligence.primaryType === "cheat_sheet" ||
        architectureLesson,
      primaryTypeDrivesBehavior: true,
      secondaryTypesAreSignalsOnly: true,
      compactRuntimeCompressionApplied: lessonGraph.stats?.compactRuntimeCompressionApplied,
      avoidRepeatedMentorPhrases: true,
      documentStructureGuidesTeachingUnits: true,
      spokenFocusSyncFeedsRenderPlan: true,
      architectureDialogueExplainsComponentPurpose: architectureLesson,
      noInventedArchitectureBehavior: architectureLesson,
      naturalOperationalStorytelling: architectureLesson,
    },
    sections,
  };
}

function generateDialogue(jobDir) {
  const extractedPath = path.join(jobDir, "extracted.json");
  const diagramPath = path.join(jobDir, "diagram-analysis.json");
  const conceptsPath = path.join(jobDir, "concepts.json");
  const lessonPlanPath = path.join(jobDir, "lesson-plan.json");

  const extractedData = readJsonIfExists(extractedPath, {});
  const diagramData = readJsonIfExists(diagramPath, {});
  const conceptsData = readJsonIfExists(conceptsPath, {
    concepts: [],
    primaryTopics: [],
  });
  const lessonPlan = readJsonIfExists(lessonPlanPath, {
    lessonStructure: [],
  });

  return buildDialogue({
    extractedData,
    extractedText:
      extractedData.text ||
      extractedData.fullText ||
      extractedData.content ||
      "",
    diagramAnalysis: diagramData,
    conceptsData,
    lessonPlan,
    jobDir,
  });
}

function saveDialogue(jobDir, dialogueData) {
  const outputPath = getDialoguePath(jobDir);
  fs.writeFileSync(outputPath, JSON.stringify(dialogueData, null, 2));
  return outputPath;
}

module.exports = {
  generateDialogue,
  saveDialogue,
  getDialoguePath,
};
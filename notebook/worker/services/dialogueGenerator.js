// notebook/worker/services/dialogueGenerator.js

const fs = require("fs");
const path = require("path");

const {
  buildDocumentIntelligence,
} = require("./documentIntelligence");

const {
  buildLessonGraph,
} = require("./lessonGraphBuilder");

function getDialoguePath(jobDir) {
  return path.join(jobDir, "dialogue.json");
}

function readJsonIfExists(filePath, fallback = {}) {
  if (!fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function cleanText(value, maxLength = 900) {
  if (!value) return "";

  return String(value)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
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

function buildVisualIntent({
  mode,
  page = null,
  focus = null,
  command = null,
  reference = null,
  step = null,
  totalSteps = null,
  presentationStyle = null,
  sceneIntent = null,
  focusHint = null,
  avoidNarration = [],
}) {
  return {
    mode,
    page,
    focus,
    command,
    reference,
    step,
    totalSteps,
    presentationStyle,
    sceneIntent,
    focusHint,
    avoidNarration,
  };
}

function firstSourcePage(unit) {
  if (!Array.isArray(unit?.sourcePages)) return null;

  const match = unit.sourcePages.find((page) => {
    return typeof page === "number" && Number.isFinite(page);
  });

  return match ?? null;
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

function getPreferredVisualMode(unit) {
  const preferred = Array.isArray(unit?.preferredVisuals)
    ? unit.preferredVisuals
    : [];

  if (preferred.includes("command_focus")) return "command_focus";
  if (preferred.includes("grouped_reference_card")) return "grouped_reference_card";
  if (preferred.includes("quick_debugging_flow")) return "quick_debugging_flow";
  if (preferred.includes("step_focus")) return "step_focus";
  if (preferred.includes("verification_card")) return "verification_card";
  if (preferred.includes("decision_point")) return "decision_point";
  if (preferred.includes("component_focus")) return "component_focus";
  if (preferred.includes("request_flow")) return "request_flow";
  if (preferred.includes("diagram_walkthrough")) return "diagram_guided_focus";
  if (preferred.includes("summary_card")) return "recap_summary";

  return "teaching_unit_focus";
}

function normalizeDebuggingSignal(value) {
  let text = stripTrailingPeriod(lowerFirst(value));

  text = text
    .replace(/^failure indicates\s+/i, "")
    .replace(/^failures indicate\s+/i, "")
    .replace(/^errors indicate\s+/i, "")
    .replace(/^error indicates\s+/i, "")
    .replace(/^missing\s+/i, "missing ")
    .trim();

  return text;
}

function buildCommandAwareText(unit, documentIntelligence) {
  const title = cleanText(unit.title, 180);
  const summary = cleanText(unit?.metadata?.summary, 320);

  const commandDetails = Array.isArray(unit?.metadata?.commandDetails)
    ? unit.metadata.commandDetails
    : [];

  const highlightedCommands = commandDetails.slice(0, 2);

  const operationalContext = highlightedCommands
    .map((commandDetail, index) => {
      const parts = [];

      if (commandDetail.meaning) {
        parts.push(stripTrailingPeriod(commandDetail.meaning));
      }

      if (commandDetail.whenToUse) {
        const usage = stripTrailingPeriod(lowerFirst(commandDetail.whenToUse));

        if (usage) {
          parts.push(
            index === 0
              ? `Usually used ${usage}`
              : `Often helpful ${usage}`
          );
        }
      }

      if (commandDetail.debuggingSignal) {
        const signal = normalizeDebuggingSignal(commandDetail.debuggingSignal);

        if (signal) {
          parts.push(`Possible issue: ${signal}`);
        }
      }

      return parts.join(". ");
    })
    .filter(Boolean)
    .join(". ");

  if (documentIntelligence.primaryType === "cheat_sheet") {
    return [
      `${title} is a quick operational reference section.`,
      operationalContext,
      summary ? sentence(summary) : "",
    ]
      .filter(Boolean)
      .join(" ");
  }

  return [
    `${title} focuses on practical operational usage.`,
    operationalContext,
    summary ? sentence(summary) : "",
  ]
    .filter(Boolean)
    .join(" ");
}

function buildConceptAwareText(unit, documentIntelligence) {
  const title = cleanText(unit.title, 180);
  const concepts = getConcepts(unit).filter((item) => item !== title);
  const summary = cleanText(unit?.metadata?.summary, 420);

  if (unit.type === "purpose") {
    if (documentIntelligence.primaryType === "cheat_sheet") {
      return "This walkthrough groups the most useful commands and operational reference points into a short guided flow.";
    }

    return "This walkthrough focuses on the important workflow, concepts, and operational reasoning from the document.";
  }

  if (unit.type === "recap") {
    if (documentIntelligence.primaryType === "cheat_sheet") {
      return "Use the sheet as a fast operational reference and return to the source when exact syntax is needed.";
    }

    return "Focus on understanding the workflow and relationships between the major concepts.";
  }

  if (documentIntelligence.primaryType === "architecture_doc") {
    return [
      `${title} is an important architecture component.`,
      summary ? sentence(summary) : "",
      concepts.length
        ? `It connects closely with ${concepts.slice(0, 2).join(" and ")}.`
        : "",
    ]
      .filter(Boolean)
      .join(" ");
  }

  if (documentIntelligence.primaryType === "design_doc") {
    return [
      `${title} represents a design decision or tradeoff.`,
      summary ? sentence(summary) : "",
    ]
      .filter(Boolean)
      .join(" ");
  }

  if (documentIntelligence.primaryType === "runbook") {
    return [
      `${title} is part of the operational execution flow.`,
      summary ? sentence(summary) : "",
    ]
      .filter(Boolean)
      .join(" ");
  }

  return [
    `${title} is the next core concept.`,
    summary ? sentence(summary) : "",
  ]
    .filter(Boolean)
    .join(" ");
}

function buildTeachingUnitText(unit, documentIntelligence) {
  const visibleElements = getVisibleElements(unit);
  const hasCommands = visibleElements.length > 0 || unit?.metadata?.hasCommands;

  if (
    hasCommands ||
    unit.type === "command_group" ||
    unit.type === "compact_command_group"
  ) {
    return buildCommandAwareText(unit, documentIntelligence);
  }

  return buildConceptAwareText(unit, documentIntelligence);
}

function buildSectionFromTeachingUnit(unit, index, totalUnits, documentIntelligence) {
  const page = firstSourcePage(unit);
  const visibleElements = getVisibleElements(unit);
  const visualMode = getPreferredVisualMode(unit);

  return {
    speaker: "Senior Engineer",
    type: `lesson_${unit.type || "teaching_unit"}`,
    page,
    text: buildTeachingUnitText(unit, documentIntelligence),
    caption: buildShortCaption(unit.title || "Teaching unit"),
    targetDurationSec: unit.targetDurationSec,
    teachingUnitId: unit.id,
    teachingMode: unit.teachingMode,
    narrationGoals: unit.narrationGoals || [],
    avoidNarration: unit.avoidNarration || [],
    visualIntent: buildVisualIntent({
      mode: visualMode,
      page,
      focus: unit.title,
      command: visibleElements.join(" | "),
      reference: unit?.metadata?.summary || null,
      step: index + 1,
      totalSteps: totalUnits,
      presentationStyle: unit.presentationStyle || null,
      sceneIntent: unit.sceneIntent || null,
      focusHint: unit.focusHint || null,
      avoidNarration: unit.avoidNarration || [],
    }),
  };
}

function buildRareLearnerCheckIn(documentIntelligence) {
  if (documentIntelligence.primaryType === "cheat_sheet") {
    return null;
  }

  return {
    speaker: "New Joiner",
    type: "learner_check_in",
    text: "So I should focus on how the pieces work together, not memorize the page?",
    caption: "Focus on the system",
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
}) {
  const documentIntelligence = buildDocumentIntelligence({
    extractedText,
    conceptsData,
    diagramAnalysis,
  });

  const lessonGraph =
    lessonPlan?.lessonGraph &&
    Array.isArray(lessonPlan.lessonGraph.teachingUnits)
      ? lessonPlan.lessonGraph
      : buildLessonGraph({
          documentIntelligence,
          conceptsData,
          extractedData,
          diagramAnalysis,
        });

  console.log("[notebook] document intelligence", {
    primaryType: documentIntelligence.primaryType,
    secondaryTypes: documentIntelligence.secondaryTypes,
    teachingStrategy: documentIntelligence.teachingStrategy,
    documentDensity: documentIntelligence.documentDensity,
    runtimeBudgetMinutes: documentIntelligence.runtimeBudgetMinutes,
    targetSceneCount: documentIntelligence.targetSceneCount,
    presentationGrammar: documentIntelligence.presentationGrammar?.style,
  });

  console.log("[notebook] lesson graph", {
    version: lessonGraph.version,
    teachingUnitCount: lessonGraph.stats?.teachingUnitCount,
    totalTargetDurationSec: lessonGraph.stats?.totalTargetDurationSec,
    compactRuntimeCompressionApplied:
      lessonGraph.stats?.compactRuntimeCompressionApplied,
    documentStructureApplied:
      lessonGraph.stats?.documentStructureApplied,
  });

  const teachingUnits = Array.isArray(lessonGraph.teachingUnits)
    ? lessonGraph.teachingUnits
    : [];

  const sections = [];

  for (const [index, unit] of teachingUnits.entries()) {
    sections.push(
      buildSectionFromTeachingUnit(
        unit,
        index,
        teachingUnits.length,
        documentIntelligence
      )
    );

    if (index === 0) {
      const learnerCheckIn = buildRareLearnerCheckIn(documentIntelligence);
      if (learnerCheckIn) sections.push(learnerCheckIn);
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    style:
      lessonGraph.compactCheatSheet
        ? "compact_instructor_led_operational_reference"
        : "instructor_led_lesson_graph_walkthrough",
    version: "dialogue-v10-document-structured",
    speakers:
      documentIntelligence.primaryType === "cheat_sheet"
        ? ["Senior Engineer"]
        : ["Senior Engineer", "New Joiner"],
    documentIntelligence,
    lessonGraph,
    pacing: {
      sectionCount: sections.length,
      teachingUnitCount: teachingUnits.length,
      runtimeBudgetMinutes: lessonGraph.runtimeBudgetMinutes,
      requestedRuntimeBudgetMinutes:
        lessonGraph.requestedRuntimeBudgetMinutes,
      maxRuntimeMinutes: documentIntelligence.maxRuntimeMinutes,
      targetSceneCount: documentIntelligence.targetSceneCount,
      totalTargetDurationSec: lessonGraph.stats?.totalTargetDurationSec,
      averageTargetDurationSec: lessonGraph.stats?.averageTargetDurationSec,
      compactRuntimeCompressionApplied:
        lessonGraph.stats?.compactRuntimeCompressionApplied,
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
            (topic) =>
              Array.isArray(topic.subConcepts) &&
              topic.subConcepts.length > 0
          )
        : false,
      usesLessonPlan: Array.isArray(lessonPlan.lessonStructure),
      usesDocumentIntelligence: true,
      usesLessonGraph: true,
      usesDocumentStructure:
        Boolean(lessonGraph.documentStructure) ||
        Boolean(lessonGraph.stats?.documentStructureApplied),
    },
    teachingRules: {
      dialogueOwnsWordingOnly: true,
      lessonGraphOwnsPedagogy: true,
      documentIntelligenceOwnsClassificationBudgetAndGrammar: true,
      avoidReadingDocument: true,
      explainWhyItMatters: true,
      teachBeyondVisibleText: true,
      avoidReadingVisibleTextVerbatim: true,
      controlDialoguePacing: true,
      generateVisualIntent: true,
      keepRealDocumentPrimary: true,
      useInstructorLedFlow: true,
      learnerInterjectionsAreRare:
        documentIntelligence.primaryType !== "cheat_sheet",
      avoidEducationalTheater:
        documentIntelligence.documentDensity === "low" ||
        documentIntelligence.primaryType === "cheat_sheet",
      primaryTypeDrivesBehavior: true,
      secondaryTypesAreSignalsOnly: true,
      compactRuntimeCompressionApplied:
        lessonGraph.stats?.compactRuntimeCompressionApplied,
      avoidRepeatedMentorPhrases: true,
      documentStructureGuidesTeachingUnits: true,
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
  });
}

function saveDialogue(jobDir, dialogueData) {
  const outputPath = getDialoguePath(jobDir);

  fs.writeFileSync(
    outputPath,
    JSON.stringify(dialogueData, null, 2)
  );

  return outputPath;
}

module.exports = {
  generateDialogue,
  saveDialogue,
  getDialoguePath,
};
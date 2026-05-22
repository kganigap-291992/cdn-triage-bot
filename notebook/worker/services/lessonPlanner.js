// notebook/worker/services/lessonPlanner.js

const fs = require("fs");
const path = require("path");
const { buildLessonGraph } = require("./lessonGraphBuilder");

function getLessonPlanPath(jobDir) {
  return path.join(jobDir, "lesson-plan.json");
}

function readJsonIfExists(filePath, fallback = {}) {
  if (!fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function cleanText(value, maxLength = 500) {
  if (!value) return "";

  return String(value)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function countPageImages(jobDir) {
  const pageImagesDir = path.join(jobDir, "page-images");

  if (!fs.existsSync(pageImagesDir)) return 0;

  return fs
    .readdirSync(pageImagesDir)
    .filter((file) => /^page-\d+\.png$/.test(file))
    .length;
}

function inferDocumentIntelligence({
  conceptsData = {},
  extractedData = {},
  pageCount = 0,
} = {}) {
  const text = [JSON.stringify(conceptsData), JSON.stringify(extractedData)]
    .join(" ")
    .toLowerCase();

  const commandSignals = [
    "kubectl",
    "docker",
    "helm",
    "git ",
    "curl ",
    "ssh ",
    "systemctl",
    "command",
    "cheat sheet",
    "cheatsheet",
  ];

  const runbookSignals = [
    "step",
    "rollback",
    "runbook",
    "procedure",
    "verify",
    "pre-check",
    "post-check",
  ];

  const architectureSignals = [
    "architecture",
    "diagram",
    "component",
    "service",
    "flow",
    "request",
    "system",
  ];

  const commandScore = commandSignals.filter((signal) => text.includes(signal)).length;
  const runbookScore = runbookSignals.filter((signal) => text.includes(signal)).length;
  const architectureScore = architectureSignals.filter((signal) => text.includes(signal)).length;

  let primaryType = "unknown";

  if (commandScore >= 2) {
    primaryType = "cheat_sheet";
  } else if (runbookScore >= 2) {
    primaryType = "runbook";
  } else if (architectureScore >= 2) {
    primaryType = "architecture_doc";
  }

  return {
    version: "document-intelligence-fallback-v1",
    source: "lessonPlanner.inferDocumentIntelligence",
    primaryType,
    secondaryTypes: [],
    compactDoc: pageCount > 0 && pageCount <= 3,
    runtimeBudgetMinutes: pageCount > 0 && pageCount <= 3 ? 3 : 5,
    targetSceneCount: pageCount > 0 && pageCount <= 3 ? 5 : 10,
    presentationGrammar: {
      preferredVisuals:
        primaryType === "cheat_sheet"
          ? ["document_focus", "command_focus", "minimal_callout"]
          : ["page_focus", "topic_card"],
      avoid: [
        "inventing headings that are not grounded in the uploaded document",
        "forcing Kubernetes-specific categories onto unrelated documents",
        "over-explaining self-explanatory commands",
      ],
    },
  };
}

function getConceptList(conceptsData) {
  if (Array.isArray(conceptsData.concepts)) {
    return conceptsData.concepts;
  }

  if (Array.isArray(conceptsData.primaryTopics)) {
    return conceptsData.primaryTopics.flatMap((topic, topicIndex) => {
      const topicTitle =
        topic.title ||
        topic.name ||
        topic.topic ||
        `Topic ${topicIndex + 1}`;

      const subConcepts = Array.isArray(topic.subConcepts)
        ? topic.subConcepts
        : [];

      if (!subConcepts.length) {
        return [
          {
            id: topic.id || `topic_${topicIndex + 1}`,
            name: topicTitle,
            page: topic.page || topic.pageNumber || null,
            whyItMatters:
              topic.whyItMatters ||
              topic.summary ||
              topic.description ||
              "",
            teachingPriority: topic.teachingPriority || "medium",
          },
        ];
      }

      return subConcepts.map((subConcept, subIndex) => ({
        id:
          subConcept.id ||
          `topic_${topicIndex + 1}_concept_${subIndex + 1}`,
        name:
          subConcept.title ||
          subConcept.name ||
          subConcept.concept ||
          subConcept.label ||
          `Concept ${subIndex + 1}`,
        page:
          subConcept.page ||
          subConcept.pageNumber ||
          topic.page ||
          topic.pageNumber ||
          null,
        whyItMatters:
          subConcept.whyItMatters ||
          subConcept.summary ||
          subConcept.description ||
          "",
        teachingPriority:
          subConcept.teachingPriority ||
          topic.teachingPriority ||
          "medium",
      }));
    });
  }

  return [];
}

function buildLessonPlan({
  conceptsData = {},
  documentIntelligence = {},
  extractedData = {},
  diagramAnalysis = {},
  architectureUnderstanding = {},
  architectureTeaching = {},
  architectureReasoning = {},
  jobDir = null,
} = {}) {
  const concepts = getConceptList(conceptsData);
  const topConcepts = concepts.slice(0, 5);

  const lessonGraph = buildLessonGraph({
    documentIntelligence,
    conceptsData,
    extractedData,
    diagramAnalysis,
    architectureUnderstanding,
    architectureTeaching,
    architectureReasoning,
    jobDir,
    });

  return {
    generatedAt: new Date().toISOString(),
    version: "lesson-plan-v2-with-lesson-graph",

    lessonStructure: [
      {
        section: "big_picture",
        title: "What This Document Is For",
        teachingGoal:
          "Orient the learner to the document using its actual structure and purpose.",
      },
      {
        section: "document_guided_walkthrough",
        title: "Document-Guided Walkthrough",
        teachingGoal:
          "Teach from the uploaded document instead of forcing a fixed taxonomy.",
      },
      {
        section: "key_teaching_units",
        title: "Key Teaching Units",
        teachingGoal:
          "Use the lesson graph to pick the strongest document-derived teaching moments.",
      },
      {
        section: "operational_context",
        title: "Operational Context",
        teachingGoal:
          "Add explanation only when it helps the learner understand why the content matters.",
      },
      {
        section: "recap",
        title: "Practical Recap",
        teachingGoal:
          "Reinforce the most useful takeaways without repeating the whole document.",
      },
    ],

    lessonGraph,

    prioritizedConcepts: topConcepts.map((concept) => ({
      id: concept.id,
      name: concept.name,
      page: concept.page,
      whyItMatters: cleanText(concept.whyItMatters, 300),
      teachingPriority: concept.teachingPriority || "medium",
    })),

    onboardingFocus: [
      "prefer the uploaded document structure",
      "avoid hardcoded domain-specific teaching categories",
      "adapt narration depth to document type",
      "keep self-explanatory command references concise",
      "use LLM explanation only when simplification adds value",
    ],

    teachingStyle: {
      conversational: true,
      beginnerFriendly: true,
      operationallyFocused: true,
      preserveArchitectureDiagrams: true,
      useMentalModels:
        lessonGraph?.pedagogyProfile?.llmUse === "helpful" ||
        lessonGraph?.pedagogyProfile?.shouldSimplify === true,
      useRecaps: true,
      narrationDensity:
        lessonGraph?.pedagogyProfile?.narrationDensity || "medium",
      visualStrategy:
        lessonGraph?.pedagogyProfile?.visualStrategy || "document_dominant",
      llmUse: lessonGraph?.pedagogyProfile?.llmUse || "bounded",
    },
  };
}

function generateLessonPlan(jobDir) {
  const conceptsPath = path.join(jobDir, "concepts.json");
  const extractedPath = path.join(jobDir, "extracted.json");
  const documentIntelligencePath = path.join(
    jobDir,
    "document-intelligence.json"
  );
  const diagramAnalysisPath = path.join(jobDir, "diagram-analysis.json");

  const architectureUnderstandingPath = path.join(
    jobDir,
    "architecture-understanding.json"
  );

  const architectureTeachingPath = path.join(
    jobDir,
    "architecture-teaching.json"
  );

  const architectureReasoningPath = path.join(
    jobDir,
    "architecture-reasoning.json"
  );

  const conceptsData = readJsonIfExists(conceptsPath, {});
  const extractedData = readJsonIfExists(extractedPath, {});
  const pageImageCount = countPageImages(jobDir);

  const fallbackDocumentIntelligence = inferDocumentIntelligence({
    conceptsData,
    extractedData,
    pageCount: pageImageCount,
  });

  const documentIntelligence = readJsonIfExists(
    documentIntelligencePath,
    fallbackDocumentIntelligence
  );

  const rawDiagramAnalysis = readJsonIfExists(diagramAnalysisPath, {});

  const architectureUnderstanding = readJsonIfExists(
    architectureUnderstandingPath,
    {}
  );

  const architectureTeaching = readJsonIfExists(
    architectureTeachingPath,
    {}
  );

  const architectureReasoning = readJsonIfExists(
    architectureReasoningPath,
    {} 
  );

  const diagramAnalysis = {
    ...rawDiagramAnalysis,
    pageCount:
      Number.isFinite(pageImageCount) && pageImageCount > 0
        ? pageImageCount
        : Number(rawDiagramAnalysis?.pageCount || 0),
  };

  return buildLessonPlan({
    conceptsData,
    documentIntelligence,
    extractedData,
    diagramAnalysis,
    architectureUnderstanding,
    architectureTeaching,
    architectureReasoning,
    jobDir,
    });
}

function saveLessonPlan(jobDir, lessonPlan) {
  const outputPath = getLessonPlanPath(jobDir);

  fs.writeFileSync(outputPath, JSON.stringify(lessonPlan, null, 2));

  return outputPath;
}

module.exports = {
  generateLessonPlan,
  saveLessonPlan,
  getLessonPlanPath,
};
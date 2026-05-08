// notebook/worker/services/lessonPlanner.js

const fs = require("fs");
const path = require("path");

function getLessonPlanPath(jobDir) {
  return path.join(jobDir, "lesson-plan.json");
}

function cleanText(value, maxLength = 500) {
  if (!value) return "";

  return String(value)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function buildLessonPlan(conceptsData) {
  const concepts = Array.isArray(conceptsData.concepts)
    ? conceptsData.concepts
    : [];

  const topConcepts = concepts.slice(0, 5);

  return {
    generatedAt: new Date().toISOString(),
    version: "lesson-plan-v1",

    lessonStructure: [
      {
        section: "big_picture",
        title: "What This System Is",
        teachingGoal:
          "Help the learner understand the purpose of the system before details.",
      },

      {
        section: "mental_model",
        title: "Mental Model",
        teachingGoal:
          "Give the learner a simplified operational understanding.",
      },

      {
        section: "architecture_flow",
        title: "Architecture Flow",
        teachingGoal:
          "Walk through how requests, services, or components connect together.",
      },

      {
        section: "key_concepts",
        title: "Key Concepts",
        teachingGoal:
          "Explain the most important technical concepts progressively.",
      },

      {
        section: "debugging",
        title: "Failure and Debugging",
        teachingGoal:
          "Teach how engineers reason about failures in production.",
      },

      {
        section: "recap",
        title: "Operational Recap",
        teachingGoal:
          "Reinforce the most important onboarding takeaways.",
      },
    ],

    prioritizedConcepts: topConcepts.map((concept) => ({
      id: concept.id,
      name: concept.name,
      page: concept.page,
      whyItMatters: cleanText(
        concept.whyItMatters,
        300
      ),
      teachingPriority:
        concept.teachingPriority || "medium",
    })),

    onboardingFocus: [
      "understand system flow before memorizing details",
      "focus on operational reasoning",
      "learn debugging intuition",
      "avoid jargon overload",
      "connect architecture to production behavior",
    ],

    teachingStyle: {
      conversational: true,
      beginnerFriendly: true,
      operationallyFocused: true,
      preserveArchitectureDiagrams: true,
      useMentalModels: true,
      useRecaps: true,
    },
  };
}

function generateLessonPlan(jobDir) {
  const conceptsPath = path.join(
    jobDir,
    "concepts.json"
  );

  const conceptsData = JSON.parse(
    fs.readFileSync(conceptsPath, "utf8")
  );

  return buildLessonPlan(conceptsData);
}

function saveLessonPlan(jobDir, lessonPlan) {
  const outputPath = getLessonPlanPath(jobDir);

  fs.writeFileSync(
    outputPath,
    JSON.stringify(lessonPlan, null, 2)
  );

  return outputPath;
}

module.exports = {
  generateLessonPlan,
  saveLessonPlan,
  getLessonPlanPath,
};
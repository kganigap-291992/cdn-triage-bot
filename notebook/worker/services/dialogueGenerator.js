// notebook/worker/services/dialogueGenerator.js

const fs = require("fs");
const path = require("path");

const MAX_TOPICS = Number(
  process.env.NOTEBOOK_MAX_DIALOGUE_TOPICS || 5
);

const MAX_SUBCONCEPTS_PER_TOPIC = Number(
  process.env.NOTEBOOK_MAX_DIALOGUE_SUBCONCEPTS || 1
);

const MAX_COMMANDS_PER_SUBCONCEPT = Number(
  process.env.NOTEBOOK_MAX_DIALOGUE_COMMANDS || 2
);

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

function listSentence(items, maxItems = 4) {
  if (!Array.isArray(items) || !items.length) return "";

  const cleaned = items
    .map((item) => cleanText(item, 180))
    .filter(Boolean)
    .slice(0, maxItems);

  if (!cleaned.length) return "";
  if (cleaned.length === 1) return sentence(cleaned[0]);

  return sentence(cleaned.join(" Then, "));
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
}) {
  return {
    mode,
    page,
    focus,
    command,
    reference,
    step,
    totalSteps,
  };
}

function findPageSummary(diagramAnalysis, pageNumber) {
  const pages = Array.isArray(diagramAnalysis.pages)
    ? diagramAnalysis.pages
    : [];

  const match = pages.find(
    (page) => String(page.page) === String(pageNumber)
  );

  return cleanText(match?.summary, 900);
}

function firstEvidencePage(item) {
  const evidence = Array.isArray(item?.evidence) ? item.evidence : [];
  const match = evidence.find((entry) => entry.page != null);
  return match?.page ?? null;
}

function firstEvidenceQuote(item) {
  const evidence = Array.isArray(item?.evidence) ? item.evidence : [];
  return cleanText(evidence[0]?.quote, 500);
}

function resolveTeachingOrder(primaryTopics, recommendedTeachingOrder) {
  if (!Array.isArray(primaryTopics)) return [];

  if (!Array.isArray(recommendedTeachingOrder) || !recommendedTeachingOrder.length) {
    return primaryTopics;
  }

  const byId = new Map(primaryTopics.map((topic) => [topic.id, topic]));
  const byName = new Map(primaryTopics.map((topic) => [topic.name, topic]));

  const ordered = [];

  for (const item of recommendedTeachingOrder) {
    const topic = byId.get(item) || byName.get(item);

    if (topic && !ordered.includes(topic)) {
      ordered.push(topic);
    }
  }

  for (const topic of primaryTopics) {
    if (!ordered.includes(topic)) {
      ordered.push(topic);
    }
  }

  return ordered;
}

function buildCommandTeachingText(command) {
  const commandText = cleanText(command.command, 180);
  const meaning = sentence(command.meaning);
  const whenToUse = sentence(command.whenToUse);
  const debuggingSignal = sentence(command.debuggingSignal);

  if (!commandText) return "";

  return [
    `The command "${commandText}" means this: ${meaning}`,
    whenToUse
      ? `You use it when ${whenToUse.charAt(0).toLowerCase()}${whenToUse.slice(1)}`
      : "",
    debuggingSignal ? `The signal to watch for is: ${debuggingSignal}` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

function pushTopicIntro(sections, topic, index, totalTopics) {
  const page = firstEvidencePage(topic);
  const workflow = listSentence(topic.operationalWorkflow, 4);

  sections.push(
    {
      speaker: "New Joiner",
      type: "topic_question",
      page,
      text:
        index === 0
          ? "Where should we start in this lesson?"
          : "What should I understand next?",
      caption: index === 0 ? "Where do we start?" : "What comes next?",
      visualIntent: buildVisualIntent({
        mode: "speaker_question",
        page,
        focus: topic.name,
      }),
    },
    {
      speaker: "Senior Engineer",
      type: "topic_intro",
      page,
      text:
        index === 0
          ? `We’ll start with ${topic.name}. ${sentence(topic.plainEnglish)} This matters because ${sentence(topic.whyItMatters)}`
          : `Now that we have the previous idea, the next layer is ${topic.name}. ${sentence(topic.plainEnglish)} This matters because ${sentence(topic.whyItMatters)}`,
      caption: buildShortCaption(topic.name),
      visualIntent: buildVisualIntent({
        mode: "architecture_focus",
        page,
        focus: topic.name,
      }),
    }
  );

  if (topic.analogy) {
    sections.push({
      speaker: "Senior Engineer",
      type: "topic_analogy",
      page,
      text: `A simple way to picture it: ${sentence(topic.analogy)}`,
      caption: buildShortCaption(topic.analogy),
      visualIntent: buildVisualIntent({
        mode: "analogy_overlay",
        page,
        focus: topic.name,
        reference: topic.analogy,
      }),
    });
  }

  if (workflow) {
    sections.push({
      speaker: "Senior Engineer",
      type: "topic_workflow",
      page,
      text: `Operationally, think of the workflow like this. ${workflow}`,
      caption: `Workflow: ${buildShortCaption(topic.name, 80)}`,
      visualIntent: buildVisualIntent({
        mode: "workflow_progression",
        page,
        focus: topic.name,
      }),
    });
  }

  if (totalTopics > 1) {
    sections.push({
      speaker: "Senior Engineer",
      type: "teaching_progress",
      page,
      text: `This is topic ${index + 1} of ${totalTopics}. We are building the lesson step by step, so each topic gives the next one more context.`,
      caption: `Topic ${index + 1} of ${totalTopics}`,
      visualIntent: buildVisualIntent({
        mode: "lesson_progress",
        page,
        focus: topic.name,
        step: index + 1,
        totalSteps: totalTopics,
      }),
    });
  }
}

function pushSubConceptTeaching(sections, topic, subConcept, subIndex) {
  const page = firstEvidencePage(subConcept) ?? firstEvidencePage(topic);

  sections.push(
    {
      speaker: "New Joiner",
      type: "subconcept_question",
      page,
      text:
        subIndex === 0
          ? `What is the first practical detail inside ${topic.name}?`
          : "What is another practical detail I should learn here?",
      caption: "Practical detail",
      visualIntent: buildVisualIntent({
        mode: "speaker_question",
        page,
        focus: subConcept.name,
      }),
    },
    {
      speaker: "Senior Engineer",
      type: "subconcept_explanation",
      page,
      text: `${subConcept.name} is the next piece. ${sentence(subConcept.plainEnglish)} It matters because ${sentence(subConcept.whyItMatters)}`,
      caption: buildShortCaption(subConcept.name),
      visualIntent: buildVisualIntent({
        mode: "concept_focus",
        page,
        focus: subConcept.name,
      }),
    }
  );

  const commands = Array.isArray(subConcept.commands)
    ? subConcept.commands.filter((command) => cleanText(command.command))
    : [];

  const selectedCommands = commands
    .slice(0, MAX_COMMANDS_PER_SUBCONCEPT)
    .map(buildCommandTeachingText)
    .filter(Boolean);

  if (selectedCommands.length) {
    sections.push(
      {
        speaker: "New Joiner",
        type: "command_group_question",
        page,
        text: `Which commands matter most for ${subConcept.name}?`,
        caption: "Key commands",
        visualIntent: buildVisualIntent({
          mode: "speaker_question",
          page,
          focus: subConcept.name,
        }),
      },
      {
        speaker: "Senior Engineer",
        type: "command_group_teaching",
        page,
        text: selectedCommands.join(" "),
        caption: `Commands: ${buildShortCaption(subConcept.name, 80)}`,
        visualIntent: buildVisualIntent({
          mode: "command_focus",
          page,
          focus: subConcept.name,
          command: commands
            .slice(0, MAX_COMMANDS_PER_SUBCONCEPT)
            .map((command) => cleanText(command.command, 160))
            .filter(Boolean)
            .join(" | "),
        }),
      }
    );
  }
}

function pushTopicReinforcement(sections, topic) {
  const page = firstEvidencePage(topic);

  const mistakes = Array.isArray(topic.commonMistakes)
    ? topic.commonMistakes.filter(Boolean).slice(0, 3)
    : [];

  const debuggingClues = Array.isArray(topic.debuggingClues)
    ? topic.debuggingClues.filter(Boolean).slice(0, 3)
    : [];

  if (mistakes.length) {
    sections.push(
      {
        speaker: "New Joiner",
        type: "mistake_question",
        page,
        text: "What is the common beginner mistake here?",
        caption: "Common mistake",
        visualIntent: buildVisualIntent({
          mode: "speaker_question",
          page,
          focus: topic.name,
        }),
      },
      {
        speaker: "Senior Engineer",
        type: "common_mistake",
        page,
        text: `The common mistake is this: ${listSentence(mistakes, 3)} A safer habit is to connect the detail back to the workflow before acting on it.`,
        caption: buildShortCaption(mistakes[0]),
        visualIntent: buildVisualIntent({
          mode: "warning_callout",
          page,
          focus: topic.name,
          reference: mistakes[0],
        }),
      }
    );
  }

  if (debuggingClues.length) {
    sections.push(
      {
        speaker: "New Joiner",
        type: "debugging_question",
        page,
        text: "How would I use this during troubleshooting?",
        caption: "Troubleshooting use",
        visualIntent: buildVisualIntent({
          mode: "speaker_question",
          page,
          focus: topic.name,
        }),
      },
      {
        speaker: "Senior Engineer",
        type: "debugging_intuition",
        page,
        text: `Use it as a way to narrow the failure path. ${listSentence(debuggingClues, 3)}`,
        caption: buildShortCaption(debuggingClues[0]),
        visualIntent: buildVisualIntent({
          mode: "debugging_focus",
          page,
          focus: topic.name,
          reference: debuggingClues[0],
        }),
      }
    );
  }
}

function pushDiagramGuidance(sections, conceptsData, diagramAnalysis) {
  const guidance = Array.isArray(conceptsData.diagramGuidance)
    ? conceptsData.diagramGuidance
    : [];

  for (const item of guidance.slice(0, 2)) {
    const page = item.page ?? null;
    const pageSummary = page != null
      ? findPageSummary(diagramAnalysis, page)
      : "";

    sections.push({
      speaker: "Senior Engineer",
      type: "diagram_walkthrough",
      page,
      text: `${sentence(item.howToExplain)} ${sentence(item.whatToPreserve)} ${pageSummary ? sentence(pageSummary) : ""}`,
      caption: page != null
        ? `Page ${page}: guided walkthrough`
        : "Guided walkthrough",
      visualIntent: buildVisualIntent({
        mode: "diagram_guided_focus",
        page,
        focus: "architecture walkthrough",
        reference: item.whatToPreserve,
      }),
    });
  }
}

function buildRecapText(primaryTopics) {
  const names = primaryTopics
    .map((topic) => topic.name)
    .filter(Boolean)
    .slice(0, MAX_TOPICS);

  if (!names.length) {
    return "Remember the purpose first, then the workflow, then the important details. For each detail, ask what it does, why it matters, and what breaks when it fails.";
  }

  return `Here is the short version. You learned ${names.join(", ")}. The pattern is simple: understand the purpose, follow the workflow, learn the important commands or steps, and use debugging clues to narrow problems one layer at a time.`;
}

function buildDialogue({
  extractedText,
  diagramAnalysis,
  conceptsData,
  lessonPlan,
}) {
  const allPrimaryTopics = resolveTeachingOrder(
    Array.isArray(conceptsData.primaryTopics)
      ? conceptsData.primaryTopics
      : Array.isArray(conceptsData.concepts)
        ? conceptsData.concepts
        : [],
    conceptsData.recommendedTeachingOrder
  );

  const primaryTopics = allPrimaryTopics.slice(0, MAX_TOPICS);

  const lessonSections = Array.isArray(lessonPlan.lessonStructure)
    ? lessonPlan.lessonStructure
    : [];

  const textSummary = cleanText(
    extractedText
      .split("\n")
      .filter(Boolean)
      .slice(0, 10)
      .join(" "),
    700
  );

  const detectedDomain = cleanText(conceptsData.detectedDomain, 180);
  const documentSummary = cleanText(conceptsData.summary, 700);

  const sections = [
    {
      speaker: "Senior Engineer",
      type: "intro",
      text:
        detectedDomain
          ? `Welcome to this onboarding walkthrough. We’ll treat this as a lesson in ${detectedDomain}. The goal is not to read the document line by line. The goal is to understand the workflow, the important concepts, and how someone should use this material in real work.`
          : "Welcome to this onboarding walkthrough. The goal is not to read the document line by line. The goal is to understand the workflow, the important concepts, and how someone should use this material in real work.",
      caption: detectedDomain
        ? `Lesson: ${buildShortCaption(detectedDomain, 80)}`
        : "Build the lesson spine",
      visualIntent: buildVisualIntent({
        mode: "title_card",
        focus: detectedDomain || "onboarding walkthrough",
      }),
    },
    {
      speaker: "New Joiner",
      type: "question",
      text:
        "So instead of memorizing everything, I should learn the structure first?",
      caption: "Learn the structure first",
      visualIntent: buildVisualIntent({
        mode: "speaker_question",
        focus: "lesson structure",
      }),
    },
    {
      speaker: "Senior Engineer",
      type: "document_summary",
      text:
        documentSummary
          ? `${sentence(documentSummary)} We’ll use that as the lesson spine.`
          : "Exactly. First understand the purpose, then the workflow, then the details that help you operate or troubleshoot it.",
      caption: "Use the lesson spine",
      visualIntent: buildVisualIntent({
        mode: "lesson_overview",
        focus: detectedDomain || "document summary",
      }),
    },
  ];

  if (lessonSections.length) {
    sections.push({
      speaker: "Senior Engineer",
      type: "lesson_plan",
      text:
        "A good way to learn this is to move through the concepts in order, so each piece builds on the previous one instead of feeling like disconnected notes.",
      caption: "Concepts build in order",
      visualIntent: buildVisualIntent({
        mode: "lesson_plan",
        focus: "teaching order",
      }),
    });
  }

  if (textSummary && !documentSummary) {
    sections.push({
      speaker: "Senior Engineer",
      type: "source_context",
      text:
        "The important details are there to support the bigger picture. As you listen, connect each command, procedure, or component back to the role it plays in the workflow.",
      caption: "Connect details to workflow",
      visualIntent: buildVisualIntent({
        mode: "source_context",
        focus: "workflow context",
      }),
    });
  }

  pushDiagramGuidance(sections, conceptsData, diagramAnalysis);

  for (const [topicIndex, topic] of primaryTopics.entries()) {
    pushTopicIntro(
      sections,
      topic,
      topicIndex,
      primaryTopics.length
    );

    const subConcepts = Array.isArray(topic.subConcepts)
      ? topic.subConcepts.slice(0, MAX_SUBCONCEPTS_PER_TOPIC)
      : [];

    for (const [subIndex, subConcept] of subConcepts.entries()) {
      pushSubConceptTeaching(
        sections,
        topic,
        subConcept,
        subIndex
      );
    }

    if (!subConcepts.length) {
      const evidenceQuote = firstEvidenceQuote(topic);

      if (evidenceQuote) {
        sections.push({
          speaker: "Senior Engineer",
          type: "evidence_anchor",
          page: firstEvidencePage(topic),
          text: `The source evidence for this idea is: ${sentence(evidenceQuote)} Use that as the anchor, then connect it back to the workflow.`,
          caption: "Evidence anchor",
          visualIntent: buildVisualIntent({
            mode: "evidence_anchor",
            page: firstEvidencePage(topic),
            focus: topic.name,
            reference: evidenceQuote,
          }),
        });
      }
    }

    pushTopicReinforcement(sections, topic);

    if (topicIndex < primaryTopics.length - 1) {
      const nextTopic = primaryTopics[topicIndex + 1];

      sections.push({
        speaker: "Senior Engineer",
        type: "transition",
        page: firstEvidencePage(nextTopic),
        text: `Now that ${topic.name} is clear, the next question is ${nextTopic.name}. That next topic builds on this one by showing another part of the workflow.`,
        caption: `Next: ${buildShortCaption(nextTopic.name, 80)}`,
        visualIntent: buildVisualIntent({
          mode: "transition_bridge",
          page: firstEvidencePage(nextTopic),
          focus: nextTopic.name,
          reference: topic.name,
        }),
      });
    }
  }

  sections.push(
    {
      speaker: "New Joiner",
      type: "question",
      text:
        "Can you give me the short version of what I should remember after this walkthrough?",
      caption: "What should I remember?",
      visualIntent: buildVisualIntent({
        mode: "speaker_question",
        focus: "recap",
      }),
    },
    {
      speaker: "Senior Engineer",
      type: "recap",
      text: buildRecapText(primaryTopics),
      caption: "Purpose → workflow → details → debugging",
      visualIntent: buildVisualIntent({
        mode: "recap_summary",
        focus: "lesson recap",
      }),
    },
    {
      speaker: "Senior Engineer",
      type: "closing",
      text:
        "Once that teaching structure is clear, the document becomes much easier to use. You are not just remembering facts; you are learning how to reason through the work.",
      caption: "Reason through the work",
      visualIntent: buildVisualIntent({
        mode: "closing_card",
        focus: "reason through the work",
      }),
    }
  );

  return {
    generatedAt: new Date().toISOString(),
    style: "two_person_teaching_aware_visual_walkthrough",
    version: "dialogue-v6-visual-intent",
    speakers: ["Senior Engineer", "New Joiner"],
    pacing: {
      maxTopics: MAX_TOPICS,
      maxSubConceptsPerTopic: MAX_SUBCONCEPTS_PER_TOPIC,
      maxCommandsPerSubConcept: MAX_COMMANDS_PER_SUBCONCEPT,
      originalTopicCount: allPrimaryTopics.length,
      usedTopicCount: primaryTopics.length,
      sectionCount: sections.length,
    },
    sourceArtifacts: {
      usesExtractedText: true,
      usesDiagramAnalysis: true,
      usesConcepts: primaryTopics.length > 0,
      usesPrimaryTopics: Array.isArray(conceptsData.primaryTopics),
      usesSubConcepts: primaryTopics.some(
        (topic) => Array.isArray(topic.subConcepts) && topic.subConcepts.length > 0
      ),
      usesLessonPlan: lessonSections.length > 0,
    },
    teachingRules: {
      simplifyConcepts: true,
      avoidReadingDocument: true,
      explainWhyItMatters: true,
      preserveFullArchitectureDiagrams: true,
      useShortCaptions: true,
      teachDebuggingIntuition: true,
      useLessonStructure: true,
      useConceptHierarchy: true,
      teachCommandsOperationally: true,
      useTransitionsBetweenTopics: true,
      controlDialoguePacing: true,
      generateVisualIntent: true,
      keepRealArchitecturePrimary: true,
      useGenericAnalogiesOnlyAsOverlays: true,
      preventMetaInstructionLeakage: true,
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
    extractedText: extractedData.text || "",
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
// notebook/worker/services/documentIntelligence.js

const DOCUMENT_TYPES = {
  CHEAT_SHEET: "cheat_sheet",
  ARCHITECTURE_DOC: "architecture_doc",
  DESIGN_DOC: "design_doc",
  RUNBOOK: "runbook",
  INCIDENT_POSTMORTEM: "incident_postmortem",
  TRAINING_SLIDE_DECK: "training_slide_deck",
  WORKFLOW_GUIDE: "workflow_guide",
  REFERENCE_MANUAL: "reference_manual",
};

function safeLower(value) {
  return String(value || "").toLowerCase();
}

function countMatches(text, patterns) {
  return patterns.reduce((count, pattern) => {
    const matches = text.match(pattern);
    return count + (matches ? matches.length : 0);
  }, 0);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function getTopicCount(conceptsData) {
  return Array.isArray(conceptsData?.primaryTopics)
    ? conceptsData.primaryTopics.length
    : 0;
}

function getSubConceptCount(conceptsData) {
  if (!Array.isArray(conceptsData?.primaryTopics)) return 0;

  return conceptsData.primaryTopics.reduce((total, topic) => {
    return total + (Array.isArray(topic.subConcepts) ? topic.subConcepts.length : 0);
  }, 0);
}

function getCommandCount(conceptsData) {
  if (!Array.isArray(conceptsData?.primaryTopics)) return 0;

  let count = 0;

  for (const topic of conceptsData.primaryTopics) {
    if (!Array.isArray(topic.subConcepts)) continue;

    for (const subConcept of topic.subConcepts) {
      if (Array.isArray(subConcept.commands)) {
        count += subConcept.commands.length;
      }

      if (Array.isArray(subConcept.commandMeanings)) {
        count += subConcept.commandMeanings.length;
      }
    }
  }

  return count;
}

function estimatePageCount(diagramAnalysis) {
  if (Array.isArray(diagramAnalysis?.pages)) return diagramAnalysis.pages.length;
  if (Array.isArray(diagramAnalysis?.pageAnalyses)) return diagramAnalysis.pageAnalyses.length;
  if (typeof diagramAnalysis?.pageCount === "number") return diagramAnalysis.pageCount;
  return 0;
}

function scoreDocumentTypes({ text, conceptsData }) {
  const lower = safeLower(text);
  const commandCount = getCommandCount(conceptsData);

  return {
    [DOCUMENT_TYPES.CHEAT_SHEET]:
      countMatches(lower, [
        /\bcheat sheet\b/g,
        /\bquick reference\b/g,
        /\bcommands?\b/g,
        /\bexamples?\b/g,
        /\bsyntax\b/g,
        /\bflags?\b/g,
        /\bcli\b/g,
        /\bkubectl\b/g,
        /\bcurl\b/g,
      ]) + commandCount * 1.35,

    [DOCUMENT_TYPES.ARCHITECTURE_DOC]:
      countMatches(lower, [
        /\barchitecture\b/g,
        /\bcomponent\b/g,
        /\bservice\b/g,
        /\bsystem\b/g,
        /\bflow\b/g,
        /\btopology\b/g,
        /\bdata flow\b/g,
        /\brequest flow\b/g,
        /\bdiagram\b/g,
      ]),

    [DOCUMENT_TYPES.DESIGN_DOC]:
      countMatches(lower, [
        /\bdesign\b/g,
        /\bproposal\b/g,
        /\btrade[- ]?off\b/g,
        /\balternative\b/g,
        /\bdecision\b/g,
        /\bconstraint\b/g,
        /\bapproach\b/g,
        /\bwhy\b/g,
      ]),

    [DOCUMENT_TYPES.RUNBOOK]:
      countMatches(lower, [
        /\brunbook\b/g,
        /\bincident\b/g,
        /\bmitigation\b/g,
        /\brollback\b/g,
        /\bescalat/g,
        /\balert\b/g,
        /\btriage\b/g,
        /\bverify\b/g,
        /\bremediation\b/g,
      ]),

    [DOCUMENT_TYPES.INCIDENT_POSTMORTEM]:
      countMatches(lower, [
        /\bpostmortem\b/g,
        /\broot cause\b/g,
        /\bimpact\b/g,
        /\btimeline\b/g,
        /\baction item\b/g,
        /\bsev\b/g,
        /\boutage\b/g,
        /\bresolved\b/g,
      ]),

    [DOCUMENT_TYPES.TRAINING_SLIDE_DECK]:
      countMatches(lower, [
        /\btraining\b/g,
        /\bonboarding\b/g,
        /\blearning objectives?\b/g,
        /\bagenda\b/g,
        /\bmodule\b/g,
        /\bslide\b/g,
      ]),

    [DOCUMENT_TYPES.WORKFLOW_GUIDE]:
      countMatches(lower, [
        /\bworkflow\b/g,
        /\bstep\b/g,
        /\bprocedure\b/g,
        /\bprocess\b/g,
        /\bfirst\b/g,
        /\bnext\b/g,
        /\bthen\b/g,
        /\bfinally\b/g,
      ]),

    [DOCUMENT_TYPES.REFERENCE_MANUAL]:
      countMatches(lower, [
        /\breference\b/g,
        /\bmanual\b/g,
        /\bappendix\b/g,
        /\bconfiguration\b/g,
        /\bparameters?\b/g,
        /\bfields?\b/g,
        /\boptions?\b/g,
      ]),
  };
}

function pickDocumentTypes(scores) {
  const sorted = Object.entries(scores)
    .sort((a, b) => b[1] - a[1])
    .filter(([, score]) => score > 0);

  const primaryType = sorted[0]?.[0] || DOCUMENT_TYPES.ARCHITECTURE_DOC;

  const secondaryTypes = sorted
    .slice(1)
    .filter(([, score]) => score >= Math.max(2, sorted[0][1] * 0.35))
    .map(([type]) => type)
    .slice(0, 3);

  return {
    primaryType,
    secondaryTypes,
  };
}

function estimateDensity({ text, conceptsData, diagramAnalysis }) {
  const lower = safeLower(text);
  const wordCount = lower.split(/\s+/).filter(Boolean).length;
  const topicCount = getTopicCount(conceptsData);
  const subConceptCount = getSubConceptCount(conceptsData);
  const commandCount = getCommandCount(conceptsData);
  const pageCount = estimatePageCount(diagramAnalysis);

  const workflowMarkerCount = countMatches(lower, [
    /\bstep\b/g,
    /\bfirst\b/g,
    /\bnext\b/g,
    /\bthen\b/g,
    /\bfinally\b/g,
    /\bverify\b/g,
    /\bcheck\b/g,
    /\bdebug\b/g,
    /\btriage\b/g,
  ]);

  const narrativeMarkerCount = countMatches(lower, [
    /\barchitecture\b/g,
    /\bdesign\b/g,
    /\btrade[- ]?off\b/g,
    /\bdecision\b/g,
    /\bconstraint\b/g,
    /\brationale\b/g,
    /\bbecause\b/g,
    /\btherefore\b/g,
    /\broot cause\b/g,
    /\bimpact\b/g,
  ]);

  const operationalDensityScore =
    commandCount * 1.4 +
    workflowMarkerCount * 0.6 +
    Math.min(subConceptCount * 0.4, 8);

  const narrativeDensityScore =
    narrativeMarkerCount * 0.8 +
    topicCount * 1.4 +
    Math.min(wordCount / 450, 18) +
    Math.min(pageCount * 0.4, 6);

  const visualDensityScore =
    Math.min(pageCount * 0.7, 10) +
    Math.min(topicCount * 0.35, 5);

  const densityScore =
    narrativeDensityScore +
    visualDensityScore +
    Math.min(operationalDensityScore * 0.45, 12);

  let documentDensity = "medium";

  if (densityScore < 12) {
    documentDensity = "low";
  } else if (densityScore > 32) {
    documentDensity = "high";
  }

  return {
    documentDensity,
    densityScore: Number(densityScore.toFixed(2)),
    operationalDensityScore: Number(operationalDensityScore.toFixed(2)),
    narrativeDensityScore: Number(narrativeDensityScore.toFixed(2)),
    visualDensityScore: Number(visualDensityScore.toFixed(2)),
    wordCount,
    topicCount,
    subConceptCount,
    commandCount,
    pageCount,
  };
}

function getTeachingStrategy(primaryType) {
  switch (primaryType) {
    case DOCUMENT_TYPES.CHEAT_SHEET:
      return "quick_operational_reference_tour";

    case DOCUMENT_TYPES.ARCHITECTURE_DOC:
      return "architecture_explainer";

    case DOCUMENT_TYPES.DESIGN_DOC:
      return "design_intent_explainer";

    case DOCUMENT_TYPES.RUNBOOK:
      return "operational_runbook_walkthrough";

    case DOCUMENT_TYPES.INCIDENT_POSTMORTEM:
      return "incident_learning_review";

    case DOCUMENT_TYPES.TRAINING_SLIDE_DECK:
      return "guided_training_module";

    case DOCUMENT_TYPES.WORKFLOW_GUIDE:
      return "workflow_walkthrough";

    case DOCUMENT_TYPES.REFERENCE_MANUAL:
      return "structured_reference_guide";

    default:
      return "architecture_explainer";
  }
}

function buildPresentationGrammar(primaryType, density) {
  const compactDoc = density.pageCount > 0 && density.pageCount <= 3;
  const commandHeavy =
    density.commandCount >= 4 ||
    density.operationalDensityScore > density.narrativeDensityScore * 1.25;

  switch (primaryType) {
    case DOCUMENT_TYPES.CHEAT_SHEET:
      return {
        style: "fast_operational_cheatsheet",
        pacing: "fast",
        cinematicLevel: 0.15,
        narrationDensity: compactDoc ? 0.22 : 0.3,
        learnerInterjectionRate: 0.03,
        maxSceneDurationSec: 16,
        preferredVisuals: [
          "command_focus",
          "grouped_reference_card",
          "quick_debugging_flow",
          "minimal_recap",
        ],
        narrationShouldAdd: [
          "when to use the command or rule",
          "why it matters operationally",
          "how it fits into a debugging workflow",
          "common misuse or gotcha when helpful",
        ],
        avoid: [
          "slow_storytelling",
          "architecture_documentary_tone",
          "reading_commands_verbatim",
          "reading_visible_bullets",
          "full_page_repetition",
          "fake_depth",
          "over_explaining_short_docs",
        ],
        commandHeavy,
      };

    case DOCUMENT_TYPES.RUNBOOK:
      return {
        style: "operational_runbook",
        pacing: "steady",
        cinematicLevel: 0.25,
        narrationDensity: 0.45,
        learnerInterjectionRate: 0.06,
        maxSceneDurationSec: 22,
        preferredVisuals: [
          "step_focus",
          "verification_card",
          "decision_point",
          "rollback_or_escalation_card",
        ],
        narrationShouldAdd: [
          "what the operator should verify",
          "why each step exists",
          "what failure signal changes the next action",
        ],
        avoid: [
          "long_theory_sections",
          "reading_steps_verbatim",
          "full_page_repetition",
        ],
        commandHeavy,
      };

    case DOCUMENT_TYPES.WORKFLOW_GUIDE:
      return {
        style: "workflow_walkthrough",
        pacing: "steady",
        cinematicLevel: 0.3,
        narrationDensity: 0.5,
        learnerInterjectionRate: 0.07,
        maxSceneDurationSec: 24,
        preferredVisuals: [
          "flow_step",
          "transition_card",
          "decision_point",
          "summary_path",
        ],
        narrationShouldAdd: [
          "how steps connect",
          "what changes between branches",
          "where users commonly get confused",
        ],
        avoid: [
          "repeating_page_context",
          "reading_visible_bullets",
        ],
        commandHeavy,
      };

    case DOCUMENT_TYPES.ARCHITECTURE_DOC:
      return {
        style: "guided_architecture_explainer",
        pacing: "moderate",
        cinematicLevel: 0.65,
        narrationDensity: 0.65,
        learnerInterjectionRate: 0.08,
        maxSceneDurationSec: 28,
        preferredVisuals: [
          "system_overview",
          "component_focus",
          "request_flow",
          "diagram_walkthrough",
        ],
        narrationShouldAdd: [
          "component responsibility",
          "system flow",
          "why the architecture is shaped this way",
          "operational consequences",
        ],
        avoid: [
          "reading_diagram_labels_verbatim",
          "repeating_same_full_page",
        ],
        commandHeavy,
      };

    case DOCUMENT_TYPES.DESIGN_DOC:
      return {
        style: "design_intent_walkthrough",
        pacing: "moderate",
        cinematicLevel: 0.5,
        narrationDensity: 0.6,
        learnerInterjectionRate: 0.08,
        maxSceneDurationSec: 28,
        preferredVisuals: [
          "problem_context",
          "decision_card",
          "tradeoff_card",
          "constraint_card",
        ],
        narrationShouldAdd: [
          "why a decision was made",
          "what tradeoff matters",
          "what constraint shaped the design",
        ],
        avoid: [
          "reading_paragraphs_verbatim",
          "generic_summary_filler",
        ],
        commandHeavy,
      };

    default:
      return {
        style: "structured_technical_walkthrough",
        pacing: "moderate",
        cinematicLevel: 0.45,
        narrationDensity: 0.5,
        learnerInterjectionRate: 0.07,
        maxSceneDurationSec: 24,
        preferredVisuals: [
          "topic_card",
          "page_focus",
          "summary_card",
        ],
        narrationShouldAdd: [
          "meaning",
          "context",
          "usage",
          "important gotchas",
        ],
        avoid: [
          "reading_visible_text",
          "full_page_repetition",
          "filler_narration",
        ],
        commandHeavy,
      };
  }
}

function buildTeachingSlots(primaryType) {
  const base = {
    purpose: { priority: 1.0 },
    key_concepts: { priority: 0.9 },
    recap: { priority: 0.85 },
  };

  switch (primaryType) {
    case DOCUMENT_TYPES.CHEAT_SHEET:
      return {
        purpose: { priority: 1.0 },
        command_groups: { priority: 0.95 },
        when_to_use: { priority: 0.78 },
        quick_debugging_flow: { priority: 0.58 },
        recap: { priority: 0.72 },
      };

    case DOCUMENT_TYPES.ARCHITECTURE_DOC:
      return {
        purpose: { priority: 1.0 },
        component_roles: { priority: 0.95 },
        request_flow: { priority: 0.9 },
        architecture_diagram_walkthrough: { priority: 0.85 },
        real_world_example: { priority: 0.55 },
        tradeoffs: { priority: 0.45 },
        simplified_analogy: { priority: 0.35 },
        recap: { priority: 0.85 },
      };

    case DOCUMENT_TYPES.DESIGN_DOC:
      return {
        purpose: { priority: 1.0 },
        problem_context: { priority: 0.95 },
        proposed_design: { priority: 0.9 },
        constraints: { priority: 0.75 },
        tradeoffs: { priority: 0.7 },
        alternatives: { priority: 0.55 },
        recap: { priority: 0.85 },
      };

    case DOCUMENT_TYPES.RUNBOOK:
      return {
        purpose: { priority: 1.0 },
        prerequisites: { priority: 0.75 },
        operational_steps: { priority: 0.95 },
        verification: { priority: 0.85 },
        rollback_or_mitigation: { priority: 0.7 },
        escalation: { priority: 0.55 },
        recap: { priority: 0.8 },
      };

    case DOCUMENT_TYPES.INCIDENT_POSTMORTEM:
      return {
        purpose: { priority: 1.0 },
        impact: { priority: 0.95 },
        timeline: { priority: 0.9 },
        root_cause: { priority: 0.9 },
        contributing_factors: { priority: 0.7 },
        action_items: { priority: 0.85 },
        lessons_learned: { priority: 0.8 },
        recap: { priority: 0.75 },
      };

    case DOCUMENT_TYPES.WORKFLOW_GUIDE:
      return {
        purpose: { priority: 1.0 },
        workflow_overview: { priority: 0.95 },
        step_by_step_flow: { priority: 0.95 },
        decision_points: { priority: 0.65 },
        common_variations: { priority: 0.45 },
        recap: { priority: 0.8 },
      };

    case DOCUMENT_TYPES.REFERENCE_MANUAL:
      return {
        purpose: { priority: 1.0 },
        topic_groups: { priority: 0.95 },
        important_fields: { priority: 0.85 },
        usage_patterns: { priority: 0.55 },
        gotchas: { priority: 0.4 },
        recap: { priority: 0.75 },
      };

    case DOCUMENT_TYPES.TRAINING_SLIDE_DECK:
      return {
        purpose: { priority: 1.0 },
        learning_objectives: { priority: 0.95 },
        module_walkthrough: { priority: 0.9 },
        knowledge_checks: { priority: 0.5 },
        recap: { priority: 0.85 },
      };

    default:
      return base;
  }
}

function estimateRuntimeAndScenes({ primaryType, documentDensity, stats }) {
  const pageCount = stats.pageCount || 1;
  const topicCount = stats.topicCount || 1;
  const subConceptCount = stats.subConceptCount || 0;
  const commandCount = stats.commandCount || 0;

  const compactDoc = pageCount <= 3;
  const commandHeavy =
    commandCount >= 4 ||
    stats.operationalDensityScore > stats.narrativeDensityScore * 1.25;

  let baseMinutes;

  switch (primaryType) {
    case DOCUMENT_TYPES.CHEAT_SHEET:
      baseMinutes = compactDoc ? 2.5 : 3.5;
      break;

    case DOCUMENT_TYPES.REFERENCE_MANUAL:
      baseMinutes = 6;
      break;

    case DOCUMENT_TYPES.RUNBOOK:
    case DOCUMENT_TYPES.WORKFLOW_GUIDE:
      baseMinutes = 7;
      break;

    case DOCUMENT_TYPES.DESIGN_DOC:
      baseMinutes = 9;
      break;

    case DOCUMENT_TYPES.ARCHITECTURE_DOC:
      baseMinutes = 10;
      break;

    case DOCUMENT_TYPES.INCIDENT_POSTMORTEM:
      baseMinutes = 8;
      break;

    case DOCUMENT_TYPES.TRAINING_SLIDE_DECK:
      baseMinutes = 9;
      break;

    default:
      baseMinutes = 8;
  }

  const densityModifier =
    documentDensity === "low" ? -1.5 : documentDensity === "high" ? 2 : 0;

  const sizeModifier =
    primaryType === DOCUMENT_TYPES.CHEAT_SHEET
      ? Math.min(1.25, Math.floor(pageCount / 4) * 0.5)
      : Math.min(4, Math.floor(pageCount / 8)) +
        Math.min(3, Math.floor(topicCount / 6));

  const commandCompressionModifier =
    primaryType === DOCUMENT_TYPES.CHEAT_SHEET && commandHeavy ? -0.75 : 0;

  const minRuntime =
    primaryType === DOCUMENT_TYPES.CHEAT_SHEET ? (compactDoc ? 2 : 3) : 5;

  const maxRuntime =
    primaryType === DOCUMENT_TYPES.CHEAT_SHEET
      ? compactDoc
        ? 4
        : 5
      : 16;

  const runtimeBudgetMinutes = clamp(
    baseMinutes + densityModifier + sizeModifier + commandCompressionModifier,
    minRuntime,
    maxRuntime
  );

  const targetSceneCount = clamp(
    primaryType === DOCUMENT_TYPES.CHEAT_SHEET
      ? Math.round(runtimeBudgetMinutes * 4.5 + Math.min(commandCount, 8) * 0.35)
      : Math.round(runtimeBudgetMinutes * 6 + subConceptCount * 0.3),
    primaryType === DOCUMENT_TYPES.CHEAT_SHEET ? 8 : 24,
    primaryType === DOCUMENT_TYPES.CHEAT_SHEET ? (compactDoc ? 16 : 24) : 90
  );

  return {
    runtimeBudgetMinutes: Number(runtimeBudgetMinutes.toFixed(2)),
    targetSceneCount,
    maxRuntimeMinutes: maxRuntime,
    compactDoc,
    commandHeavy,
  };
}

function trimTeachingSlots({ teachingSlots, runtimeBudgetMinutes, documentDensity, primaryType }) {
  let minPriority =
    runtimeBudgetMinutes <= 4 || documentDensity === "low"
      ? 0.75
      : runtimeBudgetMinutes <= 7
        ? 0.55
        : 0.35;

  if (primaryType === DOCUMENT_TYPES.CHEAT_SHEET) {
    minPriority = runtimeBudgetMinutes <= 3 ? 0.78 : 0.58;
  }

  return Object.fromEntries(
    Object.entries(teachingSlots).filter(([, config]) => {
      return Number(config.priority || 0) >= minPriority;
    })
  );
}

function buildDocumentIntelligence({
  extractedText = "",
  conceptsData = {},
  diagramAnalysis = {},
} = {}) {
  const scores = scoreDocumentTypes({
    text: extractedText,
    conceptsData,
  });

  const { primaryType, secondaryTypes } = pickDocumentTypes(scores);

  const density = estimateDensity({
    text: extractedText,
    conceptsData,
    diagramAnalysis,
  });

  const teachingStrategy = getTeachingStrategy(primaryType);
  const presentationGrammar = buildPresentationGrammar(primaryType, density);

  const budget = estimateRuntimeAndScenes({
    primaryType,
    documentDensity: density.documentDensity,
    stats: density,
  });

  const teachingSlots = trimTeachingSlots({
    teachingSlots: buildTeachingSlots(primaryType),
    runtimeBudgetMinutes: budget.runtimeBudgetMinutes,
    documentDensity: density.documentDensity,
    primaryType,
  });

  return {
    version: "document-intelligence-v2",
    primaryType,
    secondaryTypes,
    teachingStrategy,
    presentationGrammar,

    documentDensity: density.documentDensity,
    densityScore: density.densityScore,
    operationalDensityScore: density.operationalDensityScore,
    narrativeDensityScore: density.narrativeDensityScore,
    visualDensityScore: density.visualDensityScore,

    runtimeBudgetMinutes: budget.runtimeBudgetMinutes,
    maxRuntimeMinutes: budget.maxRuntimeMinutes,
    targetSceneCount: budget.targetSceneCount,

    compactDoc: budget.compactDoc,
    commandHeavy: budget.commandHeavy,

    teachingSlots,

    stats: {
      wordCount: density.wordCount,
      pageCount: density.pageCount,
      topicCount: density.topicCount,
      subConceptCount: density.subConceptCount,
      commandCount: density.commandCount,
    },

    typeScores: scores,
  };
}

module.exports = {
  DOCUMENT_TYPES,
  buildDocumentIntelligence,
};
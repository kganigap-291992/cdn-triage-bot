// notebook/worker/services/lessonGraphBuilder.js

/**
 * Phase 8C.3A / 8C.3D — Focus-Guided + Adaptive Pedagogy Infrastructure
 *
 * Goal:
 * - Stop repeated same-page scenes from feeling visually identical.
 * - Make each teaching unit carry a clear focus/camera intent.
 * - Keep PDF/page content as the primary visual actor.
 * - Reduce overlay dominance by giving renderPlan/Root enough intent.
 * - Introduce adaptive pedagogy so different document types are not taught the same way.
 */

const { buildPedagogyProfile } = require("./pedagogyProfileBuilder");
const { buildSourceGrounding } = require("./sourceGroundingBuilder");
const { buildDocumentStructure } = require("./documentStructureBuilder");

function safeString(value) {
  return String(value || "").trim();
}

function safeLower(value) {
  return safeString(value).toLowerCase();
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function slugify(value) {
  return safeLower(value)
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60);
}

function uniq(values) {
  return Array.from(
    new Set(
      values
        .map((value) => safeString(value))
        .filter(Boolean)
    )
  );
}

function getPrimaryTopics(conceptsData) {
  return Array.isArray(conceptsData?.primaryTopics)
    ? conceptsData.primaryTopics
    : [];
}

function getDocumentSections({
  extractedData,
  documentIntelligence,
}) {
  const structure = buildDocumentStructure({
    extractedData,
    documentIntelligence,
  });

  return Array.isArray(structure?.sections)
    ? structure.sections
    : [];
}

function normalizeSectionKey(value) {
  return safeLower(value)
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function findBestSectionForUnit(unit, sections = []) {
  if (!sections.length) return null;

  const unitTerms = [
    unit.title,
    unit.metadata?.summary,
    ...(unit.visibleElements || []),
  ]
    .map((value) => normalizeSectionKey(value))
    .filter(Boolean);

  let bestSection = null;
  let bestScore = 0;

  for (const section of sections) {
    // ---------------------------------------------------
    // Ignore tiny/noisy sections
    // ---------------------------------------------------

    if (
      section.childCount <= 0 ||
      section.title.length < 3
    ) {
      continue;
    }

    // ---------------------------------------------------
    // Penalize command-heavy pseudo-sections
    // ---------------------------------------------------

    const commandDensity =
      (section.commandCount || 0) /
      Math.max(1, section.childCount);

    const looksLikeCommandHeading =
      /^\d+\s+(kubectl|minikube|docker|helm|terraform)/i.test(
        section.title
      );

    if (looksLikeCommandHeading) {
      continue;
    }

    let score = 0;

    const sectionTitle = normalizeSectionKey(section.title);
    const sectionText = normalizeSectionKey(
      section.textPreview || ""
    );

    for (const term of unitTerms) {
      if (!term) continue;

      // ---------------------------------------------
      // Strong preference for semantic title matches
      // ---------------------------------------------

      if (sectionTitle.includes(term)) {
        score += 20;
      }

      // ---------------------------------------------
      // Moderate body match
      // ---------------------------------------------

      else if (sectionText.includes(term)) {
        score += 6;
      }

      const words = term.split(/\s+/).filter(Boolean);

      for (const word of words) {
        if (word.length < 4) continue;

        if (sectionTitle.includes(word)) {
          score += 5;
        } else if (sectionText.includes(word)) {
          score += 1;
        }
      }
    }

    // ---------------------------------------------------
    // Prefer semantically meaningful sections
    // ---------------------------------------------------

    if (
      /(pods|services|workflow|debugging|labels|selectors|golden rules|cluster|context)/i.test(
        section.title
      )
    ) {
      score += 8;
    }

    // ---------------------------------------------------
    // Penalize noisy command-dense sections
    // ---------------------------------------------------

    score -= commandDensity * 10;

    if (score > bestScore) {
      bestScore = score;
      bestSection = section;
    }
  }

  return bestSection;
}

function getPageCount(diagramAnalysis) {
  if (Array.isArray(diagramAnalysis?.pages)) return diagramAnalysis.pages.length;
  if (Array.isArray(diagramAnalysis?.pageAnalyses)) return diagramAnalysis.pageAnalyses.length;
  if (typeof diagramAnalysis?.pageCount === "number") return diagramAnalysis.pageCount;
  return 0;
}

function isCheatSheet(documentIntelligence) {
  return documentIntelligence?.primaryType === "cheat_sheet";
}

function isCompactCheatSheet(documentIntelligence, pageCount) {
  return (
    isCheatSheet(documentIntelligence) &&
    (
      pageCount <= 3 ||
      Boolean(documentIntelligence?.compactDoc) ||
      Number(documentIntelligence?.runtimeBudgetMinutes || 0) <= 4
    )
  );
}

function getEffectiveRuntimeBudgetMinutes(documentIntelligence, pageCount) {
  const requested = Number(documentIntelligence?.runtimeBudgetMinutes || 0);
  const primaryType = documentIntelligence?.primaryType;

  if (isCompactCheatSheet(documentIntelligence, pageCount)) {
    return clamp(requested || 2.75, 2, 3.25);
  }

  if (primaryType === "cheat_sheet") {
    return clamp(requested || 4, 3, 5);
  }

  if (pageCount > 0 && pageCount <= 3) {
    return clamp(requested || 3.5, 2.5, 5);
  }

  return clamp(requested || 5, 3, Number(documentIntelligence?.maxRuntimeMinutes || 8));
}

function getFallbackSourcePages({ documentIntelligence, pageCount }) {
  if (documentIntelligence?.primaryType === "cheat_sheet" && pageCount > 0) {
    return [1];
  }

  return [];
}

function resolveSourcePages({ topic, subConcept, fallbackSourcePages }) {
  const sourcePages = getSourcePages(topic, subConcept);

  return sourcePages.length > 0
    ? sourcePages
    : fallbackSourcePages;
}

function getTopicTitle(topic, index) {
  return (
    safeString(topic?.title) ||
    safeString(topic?.name) ||
    safeString(topic?.topic) ||
    `Topic ${index + 1}`
  );
}

function getSubConceptTitle(subConcept, index) {
  return (
    safeString(subConcept?.title) ||
    safeString(subConcept?.name) ||
    safeString(subConcept?.concept) ||
    safeString(subConcept?.label) ||
    `Concept ${index + 1}`
  );
}

function getSubConceptSummary(subConcept) {
  return (
    safeString(subConcept?.summary) ||
    safeString(subConcept?.description) ||
    safeString(subConcept?.meaning) ||
    safeString(subConcept?.whyItMatters)
  );
}

function normalizeConceptKey(value) {
  return safeLower(value)
    .replace(/[`"'()[\]{}]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function getCommandDetails(subConcept) {
  const commandDetails = [];

  if (Array.isArray(subConcept?.commands)) {
    for (const item of subConcept.commands) {
      if (typeof item === "string") {
        commandDetails.push({
          command: item,
          meaning: "",
          whenToUse: "",
          debuggingSignal: "",
        });
      } else if (item && typeof item === "object") {
        commandDetails.push({
          command: safeString(item.command || item.name || item.text || ""),
          meaning: safeString(item.meaning),
          whenToUse: safeString(item.whenToUse),
          debuggingSignal: safeString(item.debuggingSignal),
        });
      }
    }
  }

  if (Array.isArray(subConcept?.commandMeanings)) {
    for (const item of subConcept.commandMeanings) {
      if (typeof item === "string") {
        commandDetails.push({
          command: item,
          meaning: "",
          whenToUse: "",
          debuggingSignal: "",
        });
      } else if (item && typeof item === "object") {
        commandDetails.push({
          command: safeString(item.command || item.name || item.text || ""),
          meaning: safeString(item.meaning),
          whenToUse: safeString(item.whenToUse),
          debuggingSignal: safeString(item.debuggingSignal),
        });
      }
    }
  }

  const seen = new Set();

  return commandDetails.filter((item) => {
    const key = normalizeConceptKey(item.command);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function getSourcePagesFromObject(value) {
  const pageCandidates = [
    value?.page,
    value?.pageNumber,
    value?.sourcePage,
    value?.source_page,
  ];

  const directPages = pageCandidates
    .filter((page) => typeof page === "number" && Number.isFinite(page))
    .map((page) => page);

  const arrayPages = Array.isArray(value?.pages)
    ? value.pages.filter((page) => typeof page === "number" && Number.isFinite(page))
    : [];

  return uniq([...directPages, ...arrayPages].map(String)).map(Number);
}

function getSourcePages(topic, subConcept) {
  return uniq([
    ...getSourcePagesFromObject(topic),
    ...getSourcePagesFromObject(subConcept),
  ].map(String)).map(Number);
}

function shouldSkipRepeatedConcept({ title, commands, coveredConcepts }) {
  const titleKey = normalizeConceptKey(title);

  if (titleKey && coveredConcepts.has(titleKey)) {
    return true;
  }

  for (const command of commands) {
    const commandKey = normalizeConceptKey(command);

    if (commandKey && coveredConcepts.has(commandKey)) {
      return true;
    }
  }

  return false;
}

function markCoveredConcept({ title, commands, coveredConcepts }) {
  const titleKey = normalizeConceptKey(title);

  if (titleKey) {
    coveredConcepts.add(titleKey);
  }

  for (const command of commands) {
    const commandKey = normalizeConceptKey(command);

    if (commandKey) {
      coveredConcepts.add(commandKey);
    }
  }
}

/**
 * Temporary domain fallback.
 * BUG-35 note:
 * This should only remain as a fallback for compact command-reference docs.
 * It should not be the default topic brain for every PDF.
 */
function getCommandCategory(value) {
  const text = safeLower(value);

  if (
    text.includes("cluster") ||
    text.includes("context") ||
    text.includes("namespace") ||
    text.includes("config")
  ) {
    return {
      key: "cluster_context",
      title: "Cluster and Context",
      rank: 1,
      summary: "Know which cluster and namespace you are operating in before debugging.",
    };
  }

  if (
    text.includes("pod") ||
    text.includes("logs") ||
    text.includes("exec") ||
    text.includes("describe pod")
  ) {
    return {
      key: "pods_status",
      title: "Pods and Runtime Status",
      rank: 2,
      summary: "Use pod commands to see what is running, failing, restarting, or exposing logs.",
    };
  }

  if (
    text.includes("svc") ||
    text.includes("service") ||
    text.includes("endpoint") ||
    text.includes("port-forward")
  ) {
    return {
      key: "services_networking",
      title: "Services and Connectivity",
      rank: 3,
      summary: "Use service and endpoint checks to connect app symptoms to network routing.",
    };
  }

  if (
    text.includes("label") ||
    text.includes("selector") ||
    text.includes("-l ")
  ) {
    return {
      key: "labels_selectors",
      title: "Labels and Selectors",
      rank: 4,
      summary: "Labels and selectors explain which objects belong together.",
    };
  }

  if (
    text.includes("yaml") ||
    text.includes("apply") ||
    text.includes("delete") ||
    text.includes("rollout") ||
    text.includes("restart")
  ) {
    return {
      key: "yaml_workflow",
      title: "YAML and Change Workflow",
      rank: 5,
      summary: "Use YAML workflow commands when changing or checking deployed resources.",
    };
  }

  if (
    text.includes("event") ||
    text.includes("debug") ||
    text.includes("top") ||
    text.includes("watch")
  ) {
    return {
      key: "debugging_flow",
      title: "Debugging Flow",
      rank: 6,
      summary: "Use these commands to move from symptom to evidence quickly.",
    };
  }

  return {
    key: "reference_commands",
    title: "Reference Commands",
    rank: 99,
    summary: "Useful commands to recognize and apply when needed.",
  };
}

function getFocusRegionForCategory(categoryKey) {
  const regions = {
    cluster_context: {
      type: "semantic_band",
      confidence: "low",
      label: "Cluster and context area",
      x: 0.06,
      y: 0.08,
      width: 0.88,
      height: 0.22,
    },
    pods_status: {
      type: "semantic_band",
      confidence: "low",
      label: "Pods and runtime status area",
      x: 0.06,
      y: 0.18,
      width: 0.88,
      height: 0.34,
    },
    services_networking: {
      type: "semantic_band",
      confidence: "low",
      label: "Services and connectivity area",
      x: 0.06,
      y: 0.34,
      width: 0.88,
      height: 0.30,
    },
    labels_selectors: {
      type: "semantic_band",
      confidence: "low",
      label: "Labels and selectors area",
      x: 0.06,
      y: 0.50,
      width: 0.88,
      height: 0.28,
    },
    yaml_workflow: {
      type: "semantic_band",
      confidence: "low",
      label: "YAML and change workflow area",
      x: 0.06,
      y: 0.60,
      width: 0.88,
      height: 0.32,
    },
    debugging_flow: {
      type: "semantic_band",
      confidence: "low",
      label: "Debugging flow area",
      x: 0.06,
      y: 0.72,
      width: 0.88,
      height: 0.24,
    },
  };

  return regions[categoryKey] || {
    type: "semantic_band",
    confidence: "low",
    label: "Relevant document area",
    x: 0.06,
    y: 0.16,
    width: 0.88,
    height: 0.68,
  };
}

function getCameraIntentForCategory(categoryKey) {
  if (categoryKey === "cluster_context") return "zoom_top_section";
  if (categoryKey === "pods_status") return "zoom_upper_middle_section";
  if (categoryKey === "services_networking") return "zoom_middle_section";
  if (categoryKey === "labels_selectors") return "zoom_lower_middle_section";
  if (categoryKey === "yaml_workflow") return "zoom_lower_section";
  if (categoryKey === "debugging_flow") return "zoom_bottom_section";
  return "guided_document_focus";
}

function getOverlayModeForPresentationStyle(presentationStyle) {
  if (presentationStyle === "command_reference_dominant") return "minimal_command_callout";
  if (presentationStyle === "operational_signal_overlay") return "small_signal_callout";
  if (presentationStyle === "workflow_context_card") return "compact_workflow_steps";
  if (presentationStyle === "document_reference_dominant") return "document_first_minimal_caption";
  if (presentationStyle === "recap_summary_card") return "summary_card";
  return "minimal_context_callout";
}

function buildFocusHint({
  title,
  summary,
  commands,
  metadata = {},
  presentationStyle,
  sourcePages,
}) {
  const text = [
    title,
    summary,
    ...(commands || []),
    metadata.categoryKey,
  ].join(" ");

  const category = metadata.categoryKey
  ? { key: metadata.categoryKey, title }
  : {
      key: metadata.semanticRole || slugify(title) || "document_section",
      title: metadata.sourceHeading || title,
    };

  const hasCommands = Array.isArray(commands) && commands.length > 0;
  const focusRegion = getFocusRegionForCategory(category.key);

  return {
    version: "focus-hint-v1",
    source: "lessonGraphBuilder",
    borrowedIdea: "tldraw_zoom_to_bounds_motion_canvas_visual_beat",
    target: metadata.sourceHeading
        ? slugify(metadata.sourceHeading)
        : category.key || slugify(title),
    label: metadata.sourceHeading || title || category.title,
    strategy: hasCommands ? "zoom_to_command_group" : "zoom_to_document_region",
    cameraIntent: getCameraIntentForCategory(category.key),
    overlayMode: getOverlayModeForPresentationStyle(presentationStyle),
    overlayPriority: hasCommands ? "supporting" : "minimal",
    keepDocumentPrimary: true,
    reduceOverlayDominance: true,
    avoidFullSceneReset: true,
    sourcePages,
    focusRegion,
  };
}

function getCompactNarrationGoals({ hasCommands }) {
  if (hasCommands) {
    return [
      "explain the practical use in one or two sentences",
      "group related commands instead of explaining each command line by line",
      "state the production/debugging signal only if it adds new value",
      "do not repeat visible command text unless necessary",
    ];
  }

  return [
    "explain the concept briefly",
    "connect it to the document only if useful",
  ];
}

function getDefaultNarrationGoals({ documentIntelligence, hasCommands }) {
  const grammar = documentIntelligence?.presentationGrammar || {};

  if (isCheatSheet(documentIntelligence)) {
    return getCompactNarrationGoals({ hasCommands });
  }

  if (Array.isArray(grammar.narrationShouldAdd) && grammar.narrationShouldAdd.length > 0) {
    return grammar.narrationShouldAdd;
  }

  if (hasCommands) {
    return [
      "explain when this is useful",
      "explain why it matters operationally",
      "connect it to a real debugging workflow",
    ];
  }

  return [
    "explain the meaning",
    "explain why it matters",
    "connect it to the larger document",
  ];
}

function getDefaultAvoidNarration(documentIntelligence) {
  const grammar = documentIntelligence?.presentationGrammar || {};
  const baseAvoid = [
    "reading visible text verbatim",
    "repeating the same concept",
    "filler narration",
    "meta-teaching phrases like do not memorize this",
    "generic phrases like operational guide or useful move unless they add new information",
    "repeating possible issue in every section",
    "turning every section into the same problem-solution template",
    "inventing headings that are not grounded in the uploaded document",
    "forcing Kubernetes-specific categories onto unrelated documents",
  ];

  if (Array.isArray(grammar.avoid) && grammar.avoid.length > 0) {
    return uniq([...grammar.avoid, ...baseAvoid]);
  }

  return baseAvoid;
}

function getPreferredVisuals(documentIntelligence, hasCommands) {
  const grammar = documentIntelligence?.presentationGrammar || {};

  if (Array.isArray(grammar.preferredVisuals) && grammar.preferredVisuals.length > 0) {
    return grammar.preferredVisuals;
  }

  return hasCommands
    ? ["document_focus", "command_focus", "minimal_callout"]
    : ["page_focus", "topic_card"];
}

function getPresentationStyle({ documentIntelligence, hasCommands, unitIndex = 0 }) {
  const primaryType = documentIntelligence?.primaryType;

  if (primaryType === "cheat_sheet") {
    const commandStyles = [
      "document_reference_dominant",
      "command_reference_dominant",
      "operational_signal_overlay",
      "document_reference_dominant",
      "workflow_context_card",
      "document_reference_dominant",
    ];

    return commandStyles[unitIndex % commandStyles.length];
  }

  if (hasCommands) {
    const commandStyles = [
      "document_reference_dominant",
      "command_reference_dominant",
      "operational_signal_overlay",
      "workflow_context_card",
    ];

    return commandStyles[unitIndex % commandStyles.length];
  }

  if (primaryType === "architecture_doc") {
    const architectureStyles = [
      "diagram_dominant",
      "component_focus",
      "flow_walkthrough",
    ];

    return architectureStyles[unitIndex % architectureStyles.length];
  }

  if (primaryType === "runbook") {
    const runbookStyles = [
      "step_reference_dominant",
      "verification_focus",
      "decision_checkpoint",
    ];

    return runbookStyles[unitIndex % runbookStyles.length];
  }

  return unitIndex % 2 === 0
    ? "document_reference_dominant"
    : "concept_overlay_support";
}

function getSceneIntent({ documentIntelligence, hasCommands }) {
  if (isCheatSheet(documentIntelligence) && hasCommands) {
    return "guide_attention_to_command_group_without_replacing_page";
  }

  return hasCommands
    ? "show_commands_explain_operational_context"
    : "show_document_explain_concept";
}

function getTeachingMode({ documentIntelligence, hasCommands }) {
  const primaryType = documentIntelligence?.primaryType;

  if (primaryType === "cheat_sheet") {
    return "compact_operational_reference_walkthrough";
  }

  if (hasCommands) {
    return "operational_command_walkthrough";
  }

  if (primaryType === "runbook") {
    return "operational_step_walkthrough";
  }

  if (primaryType === "workflow_guide") {
    return "workflow_walkthrough";
  }

  if (primaryType === "architecture_doc") {
    return "architecture_explainer";
  }

  if (primaryType === "design_doc") {
    return "design_intent_explainer";
  }

  return documentIntelligence?.teachingStrategy || "technical_walkthrough";
}

function getUnitType({ documentIntelligence, hasCommands }) {
  const primaryType = documentIntelligence?.primaryType;

  if (primaryType === "cheat_sheet") {
    return "compact_command_group";
  }

  if (hasCommands) {
    return "command_group";
  }

  if (primaryType === "runbook") {
    return "operational_step";
  }

  if (primaryType === "workflow_guide") {
    return "workflow_step";
  }

  if (primaryType === "architecture_doc") {
    return "concept";
  }

  if (primaryType === "design_doc") {
    return "decision_or_tradeoff";
  }

  return "concept";
}

function getMaxTeachingUnits(documentIntelligence, pageCount) {
  const targetSceneCount = Number(documentIntelligence?.targetSceneCount || 0);
  const runtimeBudgetMinutes = Number(documentIntelligence?.runtimeBudgetMinutes || 0);
  const primaryType = documentIntelligence?.primaryType;

  if (isCompactCheatSheet(documentIntelligence, pageCount)) {
    return clamp(targetSceneCount || 5, 4, 6);
  }

  if (primaryType === "cheat_sheet") {
    return clamp(targetSceneCount || 7, 5, 8);
  }

  if (runtimeBudgetMinutes <= 5) {
    return clamp(targetSceneCount || 12, 8, 14);
  }

  return clamp(targetSceneCount || 28, 14, 36);
}

function buildIntroUnit({ documentIntelligence, pageCount }) {
  const primaryType = documentIntelligence?.primaryType || "technical_document";
  const grammar = documentIntelligence?.presentationGrammar || {};
  const compactCheatSheet = isCompactCheatSheet(documentIntelligence, pageCount);
  const presentationStyle = "document_reference_dominant";
  const sourcePages = getFallbackSourcePages({ documentIntelligence, pageCount });

  return {
    id: "intro_purpose",
    type: "purpose",
    title: compactCheatSheet ? "How to use this cheat sheet" : "What this document is for",
    importance: 1,
    teachingMode: compactCheatSheet
      ? "compact_reference_orientation"
      : documentIntelligence?.teachingStrategy || "technical_walkthrough",
    runtimeWeight: compactCheatSheet ? 0.35 : 0.7,
    concepts: [],
    visibleElements: [],
    narrationGoals: compactCheatSheet
      ? [
          "set context in one sentence",
          "explain that the walkthrough will group commands by debugging use",
        ]
      : [
          "set context quickly",
          "explain how to watch this walkthrough",
          "avoid over-explaining obvious visible text",
        ],
    avoidNarration: getDefaultAvoidNarration(documentIntelligence),
    preferredVisuals: grammar.preferredVisuals || ["page_focus", "minimal_callout"],
    presentationStyle,
    sceneIntent: "set_context_without_reading_document",
    sourcePages,
    focusHint: buildFocusHint({
      title: "Document overview",
      summary: "Orient the viewer to the page before focusing on details.",
      commands: [],
      metadata: { categoryKey: "reference_commands" },
      presentationStyle,
      sourcePages,
    }),
    metadata: {
      primaryType,
      role: "intro",
      compactCheatSheet,
    },
  };
}

function buildRecapUnit({ documentIntelligence, pageCount }) {
  const grammar = documentIntelligence?.presentationGrammar || {};
  const compactCheatSheet = isCompactCheatSheet(documentIntelligence, pageCount);
  const presentationStyle = "recap_summary_card";
  const sourcePages = getFallbackSourcePages({ documentIntelligence, pageCount });

  return {
    id: "recap_key_takeaways",
    type: "recap",
    title: compactCheatSheet ? "What to remember" : "Key takeaways",
    importance: 0.82,
    teachingMode: "concise_recap",
    runtimeWeight: compactCheatSheet ? 0.35 : 0.6,
    concepts: [],
    visibleElements: [],
    narrationGoals: compactCheatSheet
      ? [
          "give one practical closing takeaway",
          "do not repeat every section",
        ]
      : [
          "summarize the practical takeaways",
          "avoid repeating the full lesson",
          "end with what the viewer should remember",
        ],
    avoidNarration: getDefaultAvoidNarration(documentIntelligence),
    preferredVisuals: grammar.preferredVisuals || ["summary_card"],
    presentationStyle,
    sceneIntent: "summarize_without_repeating_full_lesson",
    sourcePages,
    focusHint: buildFocusHint({
      title: "Recap",
      summary: "Zoom back out and summarize the lesson.",
      commands: [],
      metadata: { categoryKey: "reference_commands" },
      presentationStyle,
      sourcePages,
    }),
    metadata: {
      role: "recap",
      compactCheatSheet,
    },
  };
}

function makeTeachingUnit({
  documentIntelligence,
  topicTitle,
  title,
  summary,
  commands,
  commandDetails,
  sourcePages,
  unitIndex,
  importance,
  runtimeWeight,
  metadata = {},
}) {
  const hasCommands = commands.length > 0;
  const presentationStyle = getPresentationStyle({
    documentIntelligence,
    hasCommands,
    unitIndex,
  });

  return {
    id: `unit_${slugify(topicTitle)}_${slugify(title) || unitIndex}`,
    type: getUnitType({ documentIntelligence, hasCommands }),
    title,
    importance,
    teachingMode: getTeachingMode({ documentIntelligence, hasCommands }),
    runtimeWeight,
    concepts: uniq([topicTitle, title, summary].filter(Boolean)),
    visibleElements: commands,
    narrationGoals: getDefaultNarrationGoals({
      documentIntelligence,
      hasCommands,
    }),
    avoidNarration: getDefaultAvoidNarration(documentIntelligence),
    preferredVisuals: getPreferredVisuals(documentIntelligence, hasCommands),
    presentationStyle,
    sceneIntent: getSceneIntent({ documentIntelligence, hasCommands }),
    sourcePages,
    focusHint: buildFocusHint({
      title,
      summary,
      commands,
      commandDetails,
      sourcePages,
      unitIndex,
      metadata,
      presentationStyle,
    }),
    metadata: {
      topicTitle,
      summary,
      commandCount: commands.length,
      hasCommands,
      commandDetails,
      ...metadata,
    },
  };
}

function collectRawConceptUnits({
  conceptsData,
  diagramAnalysis,
  documentIntelligence,
}) {
  const topics = getPrimaryTopics(conceptsData);
  const coveredConcepts = new Set();
  const units = [];
  const pageCount = getPageCount(diagramAnalysis);
  const fallbackSourcePages = getFallbackSourcePages({
    documentIntelligence,
    pageCount,
  });

  for (let topicIndex = 0; topicIndex < topics.length; topicIndex += 1) {
    const topic = topics[topicIndex];
    const topicTitle = getTopicTitle(topic, topicIndex);
    const subConcepts = Array.isArray(topic?.subConcepts) ? topic.subConcepts : [];

    if (subConcepts.length === 0) {
      const commandDetails = getCommandDetails(topic);
      const commands = commandDetails.map((item) => item.command);
      const hasCommands = commands.length > 0;
      const title = topicTitle;

      if (shouldSkipRepeatedConcept({ title, commands, coveredConcepts })) {
        continue;
      }

      markCoveredConcept({ title, commands, coveredConcepts });

      units.push(
        makeTeachingUnit({
          documentIntelligence,
          topicTitle,
          title,
          summary: safeString(topic?.summary),
          commands,
          commandDetails,
          sourcePages: resolveSourcePages({
            topic,
            subConcept: null,
            fallbackSourcePages,
          }),
          unitIndex: units.length,
          importance: hasCommands ? 0.86 : 0.72,
          runtimeWeight: hasCommands ? 0.65 : 0.75,
        })
      );

      continue;
    }

    for (let subIndex = 0; subIndex < subConcepts.length; subIndex += 1) {
      const subConcept = subConcepts[subIndex];
      const title = getSubConceptTitle(subConcept, subIndex);
      const summary = getSubConceptSummary(subConcept);
      const commandDetails = getCommandDetails(subConcept);
      const commands = commandDetails.map((item) => item.command);
      const hasCommands = commands.length > 0;

      if (shouldSkipRepeatedConcept({ title, commands, coveredConcepts })) {
        continue;
      }

      markCoveredConcept({ title, commands, coveredConcepts });

      units.push(
        makeTeachingUnit({
          documentIntelligence,
          topicTitle,
          title,
          summary,
          commands,
          commandDetails,
          sourcePages: resolveSourcePages({
            topic,
            subConcept,
            fallbackSourcePages,
          }),
          unitIndex: units.length,
          importance: hasCommands ? 0.9 : 0.7,
          runtimeWeight: hasCommands ? 0.6 : 0.7,
        })
      );
    }
  }

  return units;
}

function buildCompactCheatSheetUnits({
  conceptsData,
  diagramAnalysis,
  documentIntelligence,
  extractedData,
}) {
  const pageCount = getPageCount(diagramAnalysis);
  const fallbackSourcePages = getFallbackSourcePages({
    documentIntelligence,
    pageCount,
  });

  const documentStructure = buildDocumentStructure({
    extractedData,
    documentIntelligence,
  });

  const sections = Array.isArray(documentStructure?.sections)
    ? documentStructure.sections
    : [];

  const structuredSections = sections.filter((section) => {
    const title = safeString(section.title);
    if (!title) return false;
    if (title === "Document overview") return false;
    if (/^\d+\s+(kubectl|minikube|docker|helm|terraform|aws|gcloud|az)\b/i.test(title)) {
      return false;
    }

    const hasUsefulContent =
      Number(section.commandCount || 0) > 0 ||
      Number(section.childCount || 0) > 0 ||
      safeString(section.textPreview);

    return hasUsefulContent;
  });

  if (structuredSections.length > 0) {
    const maxUnits = getMaxTeachingUnits(documentIntelligence, pageCount);

    return structuredSections
      .slice(0, maxUnits)
      .map((section, index) => {
        const commandElements = Array.isArray(section.elements)
          ? section.elements.filter((element) => {
              return (
                element.type === "code_or_command" ||
                /kubectl|minikube|docker|helm|terraform|aws|gcloud|az/i.test(
                  safeString(element.text)
                )
              );
            })
          : [];

        const commands = uniq(
          commandElements
            .map((element) => safeString(element.text))
            .filter(Boolean)
        ).slice(0, 4);

        const commandDetails = commands.map((command) => ({
          command,
          meaning: "",
          whenToUse: "",
          debuggingSignal: "",
        }));

        return makeTeachingUnit({
          documentIntelligence,
          topicTitle: section.title,
          title: section.title,
          summary: safeString(section.textPreview),
          commands,
          commandDetails,
          sourcePages:
            Array.isArray(section.sourcePages) && section.sourcePages.length > 0
              ? section.sourcePages
              : fallbackSourcePages,
          unitIndex: index,
          importance: 0.95 - index * 0.04,
          runtimeWeight: index <= 2 ? 0.75 : 0.55,
          metadata: {
            compactGrouped: true,
            structureFirst: true,
            semanticRole: section.role || "reference",
            sourceHeading: section.title,
            usedFallbackCategory: false,
            fallbackCategoryKey: null,
            sectionElementTypes: section.elementTypes || [],
            sectionCommandCount: section.commandCount || 0,
            sectionChildCount: section.childCount || 0,
          },
        });
      });
  }

  // Fallback path only if document structure extraction fails.
  const rawUnits = collectRawConceptUnits({
    conceptsData,
    diagramAnalysis,
    documentIntelligence,
  });

  const grouped = new Map();

  for (const unit of rawUnits) {
    const fallbackCategory = getCommandCategory([
      unit.title,
      unit.metadata?.summary,
      ...(unit.visibleElements || []),
    ].join(" "));

    if (!grouped.has(fallbackCategory.key)) {
      grouped.set(fallbackCategory.key, {
        category: fallbackCategory,
        commands: [],
        commandDetails: [],
        sourcePages: [],
        sourceTitles: [],
      });
    }

    const bucket = grouped.get(fallbackCategory.key);

    bucket.commands.push(...(unit.visibleElements || []));
    bucket.commandDetails.push(...(unit.metadata?.commandDetails || []));
    bucket.sourcePages.push(...(unit.sourcePages || []));
    bucket.sourceTitles.push(unit.title);
  }

  const groupedUnits = Array.from(grouped.values())
    .sort((a, b) => a.category.rank - b.category.rank)
    .map((bucket, index) => {
      const commands = uniq(bucket.commands).slice(0, 4);
      const commandDetails = bucket.commandDetails
        .filter((item) => commands.includes(item.command))
        .slice(0, 4);

      const sourcePages = uniq(bucket.sourcePages.map(String))
        .map(Number)
        .filter(Boolean);

      return makeTeachingUnit({
        documentIntelligence,
        topicTitle: bucket.category.title,
        title: bucket.category.title,
        summary: bucket.category.summary,
        commands,
        commandDetails,
        sourcePages: sourcePages.length ? sourcePages : fallbackSourcePages,
        unitIndex: index,
        importance: 0.95 - index * 0.04,
        runtimeWeight: index <= 2 ? 0.75 : 0.55,
        metadata: {
          compactGrouped: true,
          structureFirst: false,
          semanticRole: "reference",
          groupedFrom: uniq(bucket.sourceTitles).slice(0, 6),
          usedFallbackCategory: true,
          fallbackCategoryKey: bucket.category.key,
        },
      });
    })
    .filter((unit) => {
      return unit.visibleElements.length > 0 || unit.metadata?.summary;
    });

  const maxUnits = getMaxTeachingUnits(documentIntelligence, pageCount);

  return groupedUnits.slice(0, maxUnits);
}

function buildTeachingUnitsFromConcepts({
  conceptsData,
  diagramAnalysis,
  documentIntelligence,
  extractedData,
}) {
  const pageCount = getPageCount(diagramAnalysis);

  if (isCompactCheatSheet(documentIntelligence, pageCount)) {
    return buildCompactCheatSheetUnits({
      conceptsData,
      diagramAnalysis,
      documentIntelligence,
      extractedData,
    });
  }

  const units = collectRawConceptUnits({
    conceptsData,
    diagramAnalysis,
    documentIntelligence,
  });

  const maxTeachingUnits = getMaxTeachingUnits(documentIntelligence, pageCount);

  return units
    .sort((a, b) => b.importance - a.importance)
    .slice(0, maxTeachingUnits);
}

function allocateRuntime({ units, documentIntelligence, pageCount }) {
  const effectiveRuntimeBudgetMinutes = getEffectiveRuntimeBudgetMinutes(
    documentIntelligence,
    pageCount
  );

  const compactCheatSheet = isCompactCheatSheet(documentIntelligence, pageCount);
  const totalBudgetSec = Math.max(
    compactCheatSheet ? 120 : 150,
    Math.round(effectiveRuntimeBudgetMinutes * 60)
  );

  const weightedUnits = units.map((unit) => ({
    ...unit,
    runtimeWeight: Math.max(0.1, Number(unit.runtimeWeight || 1)),
  }));

  const totalWeight = weightedUnits.reduce((sum, unit) => {
    return sum + unit.runtimeWeight;
  }, 0);

  return weightedUnits.map((unit) => {
    const role = unit.metadata?.role;
    const share = totalWeight > 0
      ? unit.runtimeWeight / totalWeight
      : 1 / Math.max(1, weightedUnits.length);

    let minSceneSec = compactCheatSheet ? 8 : 12;
    let maxSceneSec = compactCheatSheet ? 18 : 28;

    if (role === "intro") {
      minSceneSec = compactCheatSheet ? 7 : 10;
      maxSceneSec = compactCheatSheet ? 12 : 18;
    }

    if (role === "recap") {
      minSceneSec = compactCheatSheet ? 7 : 10;
      maxSceneSec = compactCheatSheet ? 12 : 18;
    }

    const grammarMax = Number(
      documentIntelligence?.presentationGrammar?.maxSceneDurationSec || 0
    );

    if (grammarMax > 0) {
      maxSceneSec = Math.min(maxSceneSec, grammarMax);
    }

    const targetDurationSec = clamp(
      Math.round(totalBudgetSec * share),
      minSceneSec,
      maxSceneSec
    );

    return {
      ...unit,
      targetDurationSec,
    };
  });
}

function buildLessonGraph({
  documentIntelligence = {},
  conceptsData = {},
  extractedData = {},
  diagramAnalysis = {},
} = {}) {
  const pageCount = getPageCount(diagramAnalysis);

  const pedagogyProfile = buildPedagogyProfile({
    documentIntelligence,
    conceptsData,
    diagramAnalysis,
  });

  const compactCheatSheet = isCompactCheatSheet(documentIntelligence, pageCount);
  const effectiveRuntimeBudgetMinutes = getEffectiveRuntimeBudgetMinutes(
    documentIntelligence,
    pageCount
  );

  const documentStructure = buildDocumentStructure({
    extractedData,
    documentIntelligence,
  });

  const coreUnits = buildTeachingUnitsFromConcepts({
    conceptsData,
    diagramAnalysis,
    documentIntelligence,
    extractedData,
  });

  const includeIntro = true;
  const includeRecap =
    compactCheatSheet
      ? coreUnits.length >= 4
      : effectiveRuntimeBudgetMinutes >= 3;

  const orderedUnits = [
    ...(includeIntro ? [buildIntroUnit({ documentIntelligence, pageCount })] : []),
    ...coreUnits,
    ...(includeRecap ? [buildRecapUnit({ documentIntelligence, pageCount })] : []),
  ];

  const runtimeAllocatedUnits = allocateRuntime({
    units: orderedUnits,
    documentIntelligence,
    pageCount,
  });

  const sourceGrounding = buildSourceGrounding({
    teachingUnits: runtimeAllocatedUnits,
    extractedData,
    diagramAnalysis,
    pageImageCount: pageCount,
  });

  const teachingUnits = sourceGrounding.teachingUnits;

  return {
    version: "lesson-graph-v4-document-structured",
    documentType: documentIntelligence?.primaryType || "unknown",
    secondaryTypes: documentIntelligence?.secondaryTypes || [],
    teachingStrategy:
      compactCheatSheet
        ? "compact_high_density_operational_focus_walkthrough"
        : documentIntelligence?.teachingStrategy || "technical_walkthrough",
    presentationGrammar: documentIntelligence?.presentationGrammar || {},
    pedagogyProfile,
    documentStructure: {
      version: documentStructure.version,
      sectionCount: documentStructure.sectionCount,
      elementCount: documentStructure.elementCount,
      stats: documentStructure.stats,
      borrowedIdeas: documentStructure.borrowedIdeas,
    },
    runtimeBudgetMinutes: effectiveRuntimeBudgetMinutes,
    requestedRuntimeBudgetMinutes: documentIntelligence?.runtimeBudgetMinutes || null,
    maxRuntimeMinutes: documentIntelligence?.maxRuntimeMinutes,
    targetSceneCount: documentIntelligence?.targetSceneCount,
    pageCount,
    compactCheatSheet,
    sourceGrounding: {
      version: sourceGrounding.version,
      groundedUnitCount: sourceGrounding.groundedUnitCount,
      pageTextCount: sourceGrounding.pageTextCount,
    },
    focusGuidance: {
      version: "focus-guidance-v1",
      borrowedIdeas: ["tldraw_zoom_to_bounds", "motion_canvas_visual_beats"],
      rule: "Scenes should represent a new focus, not just a new card.",
      keepDocumentPrimary: true,
      reduceOverlayDominance: true,
    },
    teachingUnits,
    stats: {
      teachingUnitCount: teachingUnits.length,
      conceptUnitCount: coreUnits.length,
      totalTargetDurationSec: teachingUnits.reduce((sum, unit) => {
        return sum + Number(unit.targetDurationSec || 0);
      }, 0),
      averageTargetDurationSec: teachingUnits.length
        ? Math.round(
            teachingUnits.reduce((sum, unit) => {
              return sum + Number(unit.targetDurationSec || 0);
            }, 0) / teachingUnits.length
          )
        : 0,
      compactRuntimeCompressionApplied: compactCheatSheet,
      focusGuidanceApplied: true,
      documentStructureApplied: true,
    },
  };
}

module.exports = {
  buildLessonGraph,
};
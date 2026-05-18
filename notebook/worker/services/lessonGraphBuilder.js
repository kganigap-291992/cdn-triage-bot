// notebook/worker/services/lessonGraphBuilder.js

/**
 * Lesson Graph Builder
 *
 * Current ownership:
 * - lessonGraphBuilder owns teaching order, pacing, scene intent, traversal, and recap shape.
 * - architectureTeaching owns architecture meaning.
 * - dialogueGenerator owns final wording.
 * - renderPlan owns choreography.
 * - Root.jsx renders only.
 *
 * Borrowed ideas:
 * - LangGraph: explicit traversal state / graph progression ownership.
 * - Motion Canvas: semantic beats instead of tiny node dumps.
 * - tldraw: zoom-to-bounds style focus intent.
 * - Observable: explain-while-showing, not abstract summary cards.
 * - NotebookLM: calm guided chapter continuity and mental-model recap.
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
  return Array.from(new Set(values.map((value) => safeString(value)).filter(Boolean)));
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function getPrimaryTopics(conceptsData) {
  return Array.isArray(conceptsData?.primaryTopics) ? conceptsData.primaryTopics : [];
}

function normalizeSectionKey(value) {
  return safeLower(value).replace(/[^a-z0-9]+/g, " ").trim();
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

function isArchitectureDocument(documentIntelligence) {
  return documentIntelligence?.primaryType === "architecture_doc";
}

function isCompactCheatSheet(documentIntelligence, pageCount) {
  return (
    isCheatSheet(documentIntelligence) &&
    (pageCount <= 3 ||
      Boolean(documentIntelligence?.compactDoc) ||
      Number(documentIntelligence?.runtimeBudgetMinutes || 0) <= 4)
  );
}

function hasUsableArchitectureTeaching({ documentIntelligence, architectureTeaching }) {
  return (
    isArchitectureDocument(documentIntelligence) &&
    Array.isArray(architectureTeaching?.enrichedChapters) &&
    architectureTeaching.enrichedChapters.length > 0
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
  if (documentIntelligence?.primaryType === "cheat_sheet" && pageCount > 0) return [1];
  return [];
}

function getSourcePagesFromObject(value) {
  const pageCandidates = [value?.page, value?.pageNumber, value?.sourcePage, value?.source_page];

  const directPages = pageCandidates
    .filter((page) => typeof page === "number" && Number.isFinite(page))
    .map((page) => page);

  const arrayPages = Array.isArray(value?.pages)
    ? value.pages.filter((page) => typeof page === "number" && Number.isFinite(page))
    : [];

  return uniq([...directPages, ...arrayPages].map(String)).map(Number);
}

function getSourcePages(topic, subConcept) {
  return uniq([...getSourcePagesFromObject(topic), ...getSourcePagesFromObject(subConcept)].map(String)).map(Number);
}

function resolveSourcePages({ topic, subConcept, fallbackSourcePages }) {
  const sourcePages = getSourcePages(topic, subConcept);
  return sourcePages.length > 0 ? sourcePages : fallbackSourcePages;
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

  for (const source of [subConcept?.commands, subConcept?.commandMeanings]) {
    if (!Array.isArray(source)) continue;

    for (const item of source) {
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

function shouldSkipRepeatedConcept({ title, commands, coveredConcepts }) {
  const titleKey = normalizeConceptKey(title);
  if (titleKey && coveredConcepts.has(titleKey)) return true;

  for (const command of commands) {
    const commandKey = normalizeConceptKey(command);
    if (commandKey && coveredConcepts.has(commandKey)) return true;
  }

  return false;
}

function markCoveredConcept({ title, commands, coveredConcepts }) {
  const titleKey = normalizeConceptKey(title);
  if (titleKey) coveredConcepts.add(titleKey);

  for (const command of commands) {
    const commandKey = normalizeConceptKey(command);
    if (commandKey) coveredConcepts.add(commandKey);
  }
}

/**
 * Temporary fallback only for compact command-reference docs.
 * This must not become the default topic brain for every PDF.
 */
function getCommandCategory(value) {
  const text = safeLower(value);

  if (text.includes("cluster") || text.includes("context") || text.includes("namespace") || text.includes("config")) {
    return {
      key: "cluster_context",
      title: "Cluster and Context",
      rank: 1,
      summary: "Know which cluster and namespace you are operating in before debugging.",
    };
  }

  if (text.includes("pod") || text.includes("logs") || text.includes("exec") || text.includes("describe pod")) {
    return {
      key: "pods_status",
      title: "Pods and Runtime Status",
      rank: 2,
      summary: "Use pod commands to see what is running, failing, restarting, or exposing logs.",
    };
  }

  if (text.includes("svc") || text.includes("service") || text.includes("endpoint") || text.includes("port-forward")) {
    return {
      key: "services_networking",
      title: "Services and Connectivity",
      rank: 3,
      summary: "Use service and endpoint checks to connect app symptoms to network routing.",
    };
  }

  if (text.includes("label") || text.includes("selector") || text.includes("-l ")) {
    return {
      key: "labels_selectors",
      title: "Labels and Selectors",
      rank: 4,
      summary: "Labels and selectors explain which objects belong together.",
    };
  }

  if (text.includes("yaml") || text.includes("apply") || text.includes("delete") || text.includes("rollout") || text.includes("restart")) {
    return {
      key: "yaml_workflow",
      title: "YAML and Change Workflow",
      rank: 5,
      summary: "Use YAML workflow commands when changing or checking deployed resources.",
    };
  }

  if (text.includes("event") || text.includes("debug") || text.includes("top") || text.includes("watch")) {
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
    cluster_context: { type: "semantic_band", confidence: "low", label: "Cluster and context area", x: 0.06, y: 0.08, width: 0.88, height: 0.22 },
    pods_status: { type: "semantic_band", confidence: "low", label: "Pods and runtime status area", x: 0.06, y: 0.18, width: 0.88, height: 0.34 },
    services_networking: { type: "semantic_band", confidence: "low", label: "Services and connectivity area", x: 0.06, y: 0.34, width: 0.88, height: 0.3 },
    labels_selectors: { type: "semantic_band", confidence: "low", label: "Labels and selectors area", x: 0.06, y: 0.5, width: 0.88, height: 0.28 },
    yaml_workflow: { type: "semantic_band", confidence: "low", label: "YAML and change workflow area", x: 0.06, y: 0.6, width: 0.88, height: 0.32 },
    debugging_flow: { type: "semantic_band", confidence: "low", label: "Debugging flow area", x: 0.06, y: 0.72, width: 0.88, height: 0.24 },
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
  if (presentationStyle === "architecture_full_diagram") return "architecture_overview_caption";
  if (presentationStyle === "architecture_semantic_chapter") return "architecture_chapter_caption";
  if (presentationStyle === "architecture_flow_recap") return "architecture_recap_caption";
  return "minimal_context_callout";
}

function buildFocusHint({ title, summary, commands, metadata = {}, presentationStyle, sourcePages }) {
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
    target: metadata.sourceHeading ? slugify(metadata.sourceHeading) : category.key || slugify(title),
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

  return ["explain the concept briefly", "connect it to the document only if useful"];
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

  return ["explain the meaning", "explain why it matters", "connect it to the larger document"];
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

  return hasCommands ? ["document_focus", "command_focus", "minimal_callout"] : ["page_focus", "topic_card"];
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
    const architectureStyles = ["diagram_dominant", "component_focus", "flow_walkthrough"];
    return architectureStyles[unitIndex % architectureStyles.length];
  }

  if (primaryType === "runbook") {
    const runbookStyles = ["step_reference_dominant", "verification_focus", "decision_checkpoint"];
    return runbookStyles[unitIndex % runbookStyles.length];
  }

  return unitIndex % 2 === 0 ? "document_reference_dominant" : "concept_overlay_support";
}

function getSceneIntent({ documentIntelligence, hasCommands }) {
  if (isCheatSheet(documentIntelligence) && hasCommands) {
    return "guide_attention_to_command_group_without_replacing_page";
  }

  return hasCommands ? "show_commands_explain_operational_context" : "show_document_explain_concept";
}

function getTeachingMode({ documentIntelligence, hasCommands }) {
  const primaryType = documentIntelligence?.primaryType;

  if (primaryType === "cheat_sheet") return "compact_operational_reference_walkthrough";
  if (hasCommands) return "operational_command_walkthrough";
  if (primaryType === "runbook") return "operational_step_walkthrough";
  if (primaryType === "workflow_guide") return "workflow_walkthrough";
  if (primaryType === "architecture_doc") return "architecture_explainer";
  if (primaryType === "design_doc") return "design_intent_explainer";

  return documentIntelligence?.teachingStrategy || "technical_walkthrough";
}

function getUnitType({ documentIntelligence, hasCommands }) {
  const primaryType = documentIntelligence?.primaryType;

  if (primaryType === "cheat_sheet") return "compact_command_group";
  if (hasCommands) return "command_group";
  if (primaryType === "runbook") return "operational_step";
  if (primaryType === "workflow_guide") return "workflow_step";
  if (primaryType === "architecture_doc") return "concept";
  if (primaryType === "design_doc") return "decision_or_tradeoff";

  return "concept";
}

function getMaxTeachingUnits(documentIntelligence, pageCount) {
  const targetSceneCount = Number(documentIntelligence?.targetSceneCount || 0);
  const runtimeBudgetMinutes = Number(documentIntelligence?.runtimeBudgetMinutes || 0);
  const primaryType = documentIntelligence?.primaryType;

  if (isCompactCheatSheet(documentIntelligence, pageCount)) return clamp(targetSceneCount || 5, 4, 6);
  if (primaryType === "cheat_sheet") return clamp(targetSceneCount || 7, 5, 8);
  if (runtimeBudgetMinutes <= 5) return clamp(targetSceneCount || 12, 8, 14);

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
    teachingMode: compactCheatSheet ? "compact_reference_orientation" : documentIntelligence?.teachingStrategy || "technical_walkthrough",
    runtimeWeight: compactCheatSheet ? 0.35 : 0.7,
    concepts: [],
    visibleElements: [],
    narrationGoals: compactCheatSheet
      ? ["set context in one sentence", "explain that the walkthrough will group commands by debugging use"]
      : ["set context quickly", "explain how to watch this walkthrough", "avoid over-explaining obvious visible text"],
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
  const isArchitecture = isArchitectureDocument(documentIntelligence);
  const presentationStyle = isArchitecture ? "architecture_flow_recap" : "recap_summary_card";
  const sourcePages = getFallbackSourcePages({ documentIntelligence, pageCount });

  return {
    id: isArchitecture ? "architecture_putting_it_together" : "recap_key_takeaways",
    type: isArchitecture ? "architecture_recap" : "recap",
    title: isArchitecture
      ? "Putting the architecture together"
      : compactCheatSheet
        ? "What to remember"
        : "Key takeaways",
    importance: isArchitecture ? 0.9 : 0.82,
    teachingMode: isArchitecture ? "architecture_flow_mental_model_recap" : "concise_recap",
    runtimeWeight: compactCheatSheet ? 0.35 : isArchitecture ? 0.5 : 0.6,
    concepts: [],
    visibleElements: [],
    narrationGoals: isArchitecture
      ? [
          "reconstruct the end-to-end architecture flow",
          "summarize responsibility transitions rather than listing components",
          "reuse only concepts already established in the walkthrough",
          "end by zooming back out to the real architecture",
        ]
      : compactCheatSheet
        ? ["give one practical closing takeaway", "do not repeat every section"]
        : ["summarize the practical takeaways", "avoid repeating the full lesson", "end with what the viewer should remember"],
    avoidNarration: getDefaultAvoidNarration(documentIntelligence),
    preferredVisuals: grammar.preferredVisuals || (isArchitecture ? ["full_diagram", "summary_card"] : ["summary_card"]),
    presentationStyle,
    sceneIntent: isArchitecture ? "reconstruct_architecture_mental_model" : "summarize_without_repeating_full_lesson",
    sourcePages,
    focusHint: buildFocusHint({
      title: isArchitecture ? "Putting the architecture together" : "Recap",
      summary: isArchitecture ? "Zoom back out and reconstruct the architecture flow." : "Zoom back out and summarize the lesson.",
      commands: [],
      metadata: { categoryKey: "reference_commands" },
      presentationStyle,
      sourcePages,
    }),
    metadata: {
      role: "recap",
      compactCheatSheet,
      architectureRecap: isArchitecture,
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
  const presentationStyle = getPresentationStyle({ documentIntelligence, hasCommands, unitIndex });

  return {
    id: `unit_${slugify(topicTitle)}_${slugify(title) || unitIndex}`,
    type: getUnitType({ documentIntelligence, hasCommands }),
    title,
    importance,
    teachingMode: getTeachingMode({ documentIntelligence, hasCommands }),
    runtimeWeight,
    concepts: uniq([topicTitle, title, summary].filter(Boolean)),
    visibleElements: commands,
    narrationGoals: getDefaultNarrationGoals({ documentIntelligence, hasCommands }),
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

function collectRawConceptUnits({ conceptsData, diagramAnalysis, documentIntelligence }) {
  const topics = getPrimaryTopics(conceptsData);
  const coveredConcepts = new Set();
  const units = [];
  const pageCount = getPageCount(diagramAnalysis);
  const fallbackSourcePages = getFallbackSourcePages({ documentIntelligence, pageCount });

  for (let topicIndex = 0; topicIndex < topics.length; topicIndex += 1) {
    const topic = topics[topicIndex];
    const topicTitle = getTopicTitle(topic, topicIndex);
    const subConcepts = Array.isArray(topic?.subConcepts) ? topic.subConcepts : [];

    if (subConcepts.length === 0) {
      const commandDetails = getCommandDetails(topic);
      const commands = commandDetails.map((item) => item.command);
      const hasCommands = commands.length > 0;
      const title = topicTitle;

      if (shouldSkipRepeatedConcept({ title, commands, coveredConcepts })) continue;

      markCoveredConcept({ title, commands, coveredConcepts });

      units.push(
        makeTeachingUnit({
          documentIntelligence,
          topicTitle,
          title,
          summary: safeString(topic?.summary),
          commands,
          commandDetails,
          sourcePages: resolveSourcePages({ topic, subConcept: null, fallbackSourcePages }),
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

      if (shouldSkipRepeatedConcept({ title, commands, coveredConcepts })) continue;

      markCoveredConcept({ title, commands, coveredConcepts });

      units.push(
        makeTeachingUnit({
          documentIntelligence,
          topicTitle,
          title,
          summary,
          commands,
          commandDetails,
          sourcePages: resolveSourcePages({ topic, subConcept, fallbackSourcePages }),
          unitIndex: units.length,
          importance: hasCommands ? 0.9 : 0.7,
          runtimeWeight: hasCommands ? 0.6 : 0.7,
        })
      );
    }
  }

  return units;
}

function buildCompactCheatSheetUnits({ conceptsData, diagramAnalysis, documentIntelligence, extractedData }) {
  const pageCount = getPageCount(diagramAnalysis);
  const fallbackSourcePages = getFallbackSourcePages({ documentIntelligence, pageCount });

  const documentStructure = buildDocumentStructure({ extractedData, documentIntelligence });
  const sections = Array.isArray(documentStructure?.sections) ? documentStructure.sections : [];

  const structuredSections = sections.filter((section) => {
    const title = safeString(section.title);
    if (!title) return false;
    if (title === "Document overview") return false;
    if (/^\d+\s+(kubectl|minikube|docker|helm|terraform|aws|gcloud|az)\b/i.test(title)) return false;

    return Number(section.commandCount || 0) > 0 || Number(section.childCount || 0) > 0 || safeString(section.textPreview);
  });

  if (structuredSections.length > 0) {
    const maxUnits = getMaxTeachingUnits(documentIntelligence, pageCount);

    return structuredSections.slice(0, maxUnits).map((section, index) => {
      const commandElements = Array.isArray(section.elements)
        ? section.elements.filter((element) => {
            return (
              element.type === "code_or_command" ||
              /kubectl|minikube|docker|helm|terraform|aws|gcloud|az/i.test(safeString(element.text))
            );
          })
        : [];

      const commands = uniq(commandElements.map((element) => safeString(element.text)).filter(Boolean)).slice(0, 4);

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
        sourcePages: Array.isArray(section.sourcePages) && section.sourcePages.length > 0 ? section.sourcePages : fallbackSourcePages,
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

  const rawUnits = collectRawConceptUnits({ conceptsData, diagramAnalysis, documentIntelligence });
  const grouped = new Map();

  for (const unit of rawUnits) {
    const fallbackCategory = getCommandCategory([unit.title, unit.metadata?.summary, ...(unit.visibleElements || [])].join(" "));

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
      const commandDetails = bucket.commandDetails.filter((item) => commands.includes(item.command)).slice(0, 4);
      const sourcePages = uniq(bucket.sourcePages.map(String)).map(Number).filter(Boolean);

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
    .filter((unit) => unit.visibleElements.length > 0 || unit.metadata?.summary);

  const maxUnits = getMaxTeachingUnits(documentIntelligence, pageCount);
  return groupedUnits.slice(0, maxUnits);
}

function getArchitectureAvoidNarration(documentIntelligence) {
  return uniq([
    ...getDefaultAvoidNarration(documentIntelligence),
    "saying this is an important part of the architecture in every scene",
    "saying this is an important step in the document",
    "generic document-summary narration",
    "excessive junior engineer questions",
    "unnecessary real-world analogies",
    "explaining topics instead of walking the visible architecture flow",
    "replacing the diagram with abstract topic summaries",
    "listing isolated components instead of teaching handoffs",
    "adding implementation behavior not present in the document evidence",
  ]);
}

function getArchitectureSourcePages({ diagramAnalysis, architectureUnderstanding, architectureTeaching }) {
  const teachingPages = asArray(architectureTeaching?.enrichedChapters)
    .flatMap((chapter) => [
      ...getSourcePagesFromObject(chapter),
      ...asArray(chapter.enrichedSegments).flatMap((segment) => [
        ...getSourcePagesFromObject(segment),
        ...getSourcePagesFromObject(segment.from),
        ...getSourcePagesFromObject(segment.to),
      ]),
    ])
    .filter(Boolean);

  const flowPages = asArray(architectureUnderstanding?.deterministicGraph?.flows)
    .flatMap((flow) => getSourcePagesFromObject(flow))
    .filter(Boolean);

  const componentPages = asArray(architectureUnderstanding?.deterministicGraph?.components)
    .flatMap((component) => getSourcePagesFromObject(component))
    .filter(Boolean);

  const normalized = uniq([...teachingPages, ...flowPages, ...componentPages].map(String))
    .map(Number)
    .filter((page) => Number.isFinite(page) && page > 0);

  if (normalized.length > 0) return normalized;

  const pageCount = getPageCount(diagramAnalysis);
  return pageCount > 0 ? [1] : [];
}

function getFullPageFocusRegion(label = "Architecture diagram") {
  return {
    type: "full_page_region",
    confidence: "medium",
    label,
    x: 0.03,
    y: 0.03,
    width: 0.94,
    height: 0.9,
  };
}

function getArchitectureBroadFocusRegion(index, total, label = "Architecture flow region") {
  if (total <= 1) return getFullPageFocusRegion(label);

  const progress = total > 1 ? index / (total - 1) : 0;

  return {
    type: "architecture_broad_region",
    confidence: "medium",
    label,
    x: clamp(0.08 + progress * 0.38, 0.04, 0.58),
    y: 0.12,
    width: 0.38,
    height: 0.68,
  };
}

function buildArchitectureFocusHint({ title, sourcePages, presentationStyle, focusRegion, cameraIntent = "architecture_diagram_region_focus" }) {
  return {
    version: "focus-hint-v1",
    source: "lessonGraphBuilder",
    borrowedIdea: "diagram_first_tldraw_zoom_to_bounds_motion_canvas_visual_beat",
    target: slugify(title),
    label: title,
    strategy: "zoom_to_architecture_region",
    cameraIntent,
    overlayMode: getOverlayModeForPresentationStyle(presentationStyle),
    overlayPriority: "minimal",
    keepDocumentPrimary: true,
    reduceOverlayDominance: true,
    avoidFullSceneReset: true,
    sourcePages,
    focusRegion,
  };
}

function getArchitectureChapterTitle(chapter) {
  if (chapter?.type === "architecture_recap") return "Putting the architecture together";
  if (chapter?.type === "architecture_overview") return "Architecture overview";
  return safeString(chapter?.title) || "Architecture flow";
}

function getArchitectureChapterSceneIntent(chapter) {
  if (chapter?.type === "architecture_overview") return "show_full_architecture_diagram_before_details";
  if (chapter?.type === "architecture_recap") return "reconstruct_architecture_mental_model";
  return "teach_architecture_handoff_group";
}

function getArchitectureChapterPresentationStyle(chapter) {
  if (chapter?.type === "architecture_overview") return "architecture_full_diagram";
  if (chapter?.type === "architecture_recap") return "architecture_flow_recap";
  return "architecture_semantic_chapter";
}

function getArchitectureMotionIntent(chapter, index) {
  if (chapter?.type === "architecture_overview") return "zoom_to_flow_entry";
  if (chapter?.type === "architecture_recap") return "settle_on_flow_destination";
  if (index <= 1) return "zoom_to_flow_entry";
  return "follow_flow_to_component";
}

function buildVisibleArchitectureElements(chapter) {
  return uniq(
    asArray(chapter?.enrichedSegments)
      .flatMap((segment) => [
        segment.from?.name,
        segment.to?.name,
        segment.teachingContext?.conceptLabel,
      ])
      .filter(Boolean)
  ).slice(0, 6);
}

function buildArchitectureNarrationGoals(chapter) {
  if (chapter?.type === "architecture_overview") {
    return [
      "show the real architecture first",
      "establish the documented system boundary and major flow",
      "avoid explaining isolated labels before the viewer has the big picture",
      "do not invent behavior not shown by the source document",
    ];
  }

  if (chapter?.type === "architecture_recap") {
    return [
      "reconstruct the end-to-end flow",
      "summarize responsibility transitions, not component definitions",
      "reuse the mental model already established",
      "do not introduce new claims in the recap",
    ];
  }

  return [
    "teach this as a grouped architecture handoff",
    "explain what responsibility changes across the handoff",
    "use architectureTeaching evidence and confidence language",
    "avoid node-by-node label narration",
    "keep the real diagram or page as visual truth",
  ];
}

function buildArchitectureTeachingUnitFromChapter({
  chapter,
  chapterIndex,
  totalChapters,
  sourcePages,
  documentIntelligence,
}) {
  const title = getArchitectureChapterTitle(chapter);
  const presentationStyle = getArchitectureChapterPresentationStyle(chapter);
  const sceneIntent = getArchitectureChapterSceneIntent(chapter);
  const motionIntent = getArchitectureMotionIntent(chapter, chapterIndex);
  const isOverview = chapter?.type === "architecture_overview";
  const isRecap = chapter?.type === "architecture_recap";

  return {
    id: `architecture_teaching_${slugify(chapter?.id || title || chapterIndex)}`,
    type: chapter?.type || "architecture_semantic_chapter",
    title,
    importance: isOverview ? 0.99 : isRecap ? 0.88 : Number((0.96 - chapterIndex * 0.04).toFixed(2)),
    teachingMode: isRecap ? "architecture_flow_mental_model_recap" : "architecture_handoff_walkthrough",
    runtimeWeight: isOverview ? 0.9 : isRecap ? 0.55 : 0.78,
    concepts: uniq([
      title,
      chapter?.teachingContext?.operationalMeaning,
      ...asArray(chapter?.teachingProgression?.introducedConcepts).map((item) => item.label),
    ]),
    visibleElements: buildVisibleArchitectureElements(chapter),
    narrationGoals: buildArchitectureNarrationGoals(chapter),
    avoidNarration: getArchitectureAvoidNarration(documentIntelligence),
    preferredVisuals: isRecap ? ["full_diagram", "summary_card"] : ["full_diagram", "diagram_region_focus", "document_focus"],
    presentationStyle,
    sceneIntent,
    sourcePages,
    focusHint: buildArchitectureFocusHint({
      title,
      sourcePages,
      presentationStyle,
      cameraIntent: motionIntent,
      focusRegion: isOverview || isRecap
        ? getFullPageFocusRegion(isRecap ? "Architecture recap region" : "Architecture diagram")
        : getArchitectureBroadFocusRegion(chapterIndex, totalChapters, title),
    }),
    metadata: {
      role: isOverview ? "architecture_overview" : isRecap ? "architecture_recap" : "architecture_semantic_chapter",
      architectureFirst: true,
      source: "architecture_teaching",
      architectureTeachingChapterId: chapter?.id || null,
      sourceChapterId: chapter?.sourceChapterId || null,
      chapterType: chapter?.type || null,
      confidence: chapter?.confidence || "unknown",
      confidenceLanguage: chapter?.confidenceLanguage || null,
      operationalMeaning: chapter?.teachingContext?.operationalMeaning || null,
      transitionNarrationHint: chapter?.teachingContext?.transitionNarrationHint || chapter?.teachingContext?.suggestedNarrationHint || null,
      recapMentalModel: chapter?.recapMentalModel || null,
      enrichedSegments: asArray(chapter?.enrichedSegments),
      safetyFlags: asArray(chapter?.safetyFlags),
      borrowedIdeas: [
        "langgraph_traversal_state",
        "motion_canvas_semantic_beats",
        "tldraw_zoom_to_bounds_focus",
        "observable_explain_while_showing",
        "notebooklm_guided_recap",
      ],
    },
  };
}

function buildTeachingUnitsFromArchitectureTeaching({
  documentIntelligence,
  diagramAnalysis,
  architectureUnderstanding,
  architectureTeaching,
}) {
  const sourcePages = getArchitectureSourcePages({
    diagramAnalysis,
    architectureUnderstanding,
    architectureTeaching,
  });

  const chapters = asArray(architectureTeaching?.enrichedChapters);
  const usableChapters = chapters.filter((chapter) => {
    if (!chapter) return false;
    if (chapter.type === "architecture_recap") return true;
    if (chapter.type === "architecture_overview") return true;

    const segments = asArray(chapter.enrichedSegments);
    return segments.some((segment) => segment.canNarrateAsFact !== false);
  });

  return usableChapters.map((chapter, index) =>
    buildArchitectureTeachingUnitFromChapter({
      chapter,
      chapterIndex: index,
      totalChapters: usableChapters.length,
      sourcePages,
      documentIntelligence,
    })
  );
}

function buildTeachingUnitsFromConcepts({ conceptsData, diagramAnalysis, documentIntelligence, extractedData }) {
  const pageCount = getPageCount(diagramAnalysis);

  if (isCompactCheatSheet(documentIntelligence, pageCount)) {
    return buildCompactCheatSheetUnits({
      conceptsData,
      diagramAnalysis,
      documentIntelligence,
      extractedData,
    });
  }

  const units = collectRawConceptUnits({ conceptsData, diagramAnalysis, documentIntelligence });
  const maxTeachingUnits = getMaxTeachingUnits(documentIntelligence, pageCount);

  return units.sort((a, b) => b.importance - a.importance).slice(0, maxTeachingUnits);
}

function buildCoreTeachingUnits({
  conceptsData,
  diagramAnalysis,
  documentIntelligence,
  extractedData,
  architectureUnderstanding,
  architectureTeaching,
}) {
  if (hasUsableArchitectureTeaching({ documentIntelligence, architectureTeaching })) {
    return buildTeachingUnitsFromArchitectureTeaching({
      documentIntelligence,
      diagramAnalysis,
      architectureUnderstanding,
      architectureTeaching,
    });
  }

  return buildTeachingUnitsFromConcepts({
    conceptsData,
    diagramAnalysis,
    documentIntelligence,
    extractedData,
  });
}

function allocateRuntime({ units, documentIntelligence, pageCount }) {
  const effectiveRuntimeBudgetMinutes = getEffectiveRuntimeBudgetMinutes(documentIntelligence, pageCount);
  const compactCheatSheet = isCompactCheatSheet(documentIntelligence, pageCount);

  const totalBudgetSec = Math.max(compactCheatSheet ? 120 : 150, Math.round(effectiveRuntimeBudgetMinutes * 60));

  const weightedUnits = units.map((unit) => ({
    ...unit,
    runtimeWeight: Math.max(0.1, Number(unit.runtimeWeight || 1)),
  }));

  const totalWeight = weightedUnits.reduce((sum, unit) => sum + unit.runtimeWeight, 0);

  return weightedUnits.map((unit) => {
    const role = unit.metadata?.role;
    const share = totalWeight > 0 ? unit.runtimeWeight / totalWeight : 1 / Math.max(1, weightedUnits.length);

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

    if (role === "architecture_overview") {
      minSceneSec = 12;
      maxSceneSec = 24;
    }

    if (role === "architecture_semantic_chapter") {
      minSceneSec = 14;
      maxSceneSec = 28;
    }

    if (role === "architecture_recap") {
      minSceneSec = 10;
      maxSceneSec = 20;
    }

    const grammarMax = Number(documentIntelligence?.presentationGrammar?.maxSceneDurationSec || 0);
    if (grammarMax > 0) maxSceneSec = Math.min(maxSceneSec, grammarMax);

    const targetDurationSec = clamp(Math.round(totalBudgetSec * share), minSceneSec, maxSceneSec);

    return {
      ...unit,
      targetDurationSec,
    };
  });
}

function orderFlowNodes(relationships = []) {
  const edges = relationships
    .filter((item) => item.from && item.to)
    .map((item) => ({ from: item.from, to: item.to }));

  if (edges.length === 0) return [];

  const toSet = new Set(edges.map((edge) => edge.to));
  const start = edges.find((edge) => !toSet.has(edge.from))?.from || edges[0].from;

  const ordered = [];
  const visited = new Set();
  let current = start;

  while (current && !visited.has(current)) {
    ordered.push(current);
    visited.add(current);

    const nextEdge = edges.find((edge) => edge.from === current && !visited.has(edge.to));
    current = nextEdge?.to || null;
  }

  for (const edge of edges) {
    if (!visited.has(edge.from)) {
      ordered.push(edge.from);
      visited.add(edge.from);
    }

    if (!visited.has(edge.to)) {
      ordered.push(edge.to);
      visited.add(edge.to);
    }
  }

  return ordered;
}

function buildArchitectureFlowGroups(architectureUnderstanding = {}) {
  const deterministicRelationships = architectureUnderstanding?.deterministicGraph?.relationships || [];
  const spatialCandidates = architectureUnderstanding?.spatialRelationshipCandidates || [];

  const traversalEligible = [
    ...deterministicRelationships
      .filter((relationship) => {
        return (
          relationship?.confidence === "deterministic" ||
          relationship?.confidence === "high" ||
          relationship?.reason === "explicit_flow"
        );
      })
      .map((relationship, index) => ({
        id: relationship.id || `deterministic_flow_${index + 1}`,
        source: "deterministic_graph",
        confidence: relationship.confidence || "deterministic",
        type: relationship.type || "relationship",
        from: relationship.from || relationship.source || relationship.sourceId || null,
        to: relationship.to || relationship.target || relationship.targetId || null,
        label: relationship.label || relationship.reason || "deterministic relationship",
        reason: relationship.reason || "deterministic_flow",
      })),

    ...spatialCandidates
      .filter((candidate) => {
        const from = candidate.from || candidate.source || candidate.sourceId || null;
        const to = candidate.to || candidate.target || candidate.targetId || null;
        return candidate?.confidence === "high" && from && to;
      })
      .map((candidate, index) => ({
        id: candidate.id || `spatial_flow_${index + 1}`,
        source: "spatial_relationship_candidate",
        confidence: candidate.confidence,
        type: candidate.type || "candidate_flow",
        from: candidate.from || candidate.source || candidate.sourceId || null,
        to: candidate.to || candidate.target || candidate.targetId || null,
        label: candidate.label || candidate.reason || "high-confidence spatial flow",
        reason: candidate.reason || "high_confidence_spatial_flow",
      })),
  ];

  if (traversalEligible.length === 0) return [];

  return [
    {
      flowGroupId: "primary_architecture_flow",
      flowType: "architecture_flow",
      confidence: traversalEligible.some((item) => item.confidence === "deterministic") ? "deterministic" : "high",
      source: "lessonGraphBuilder",
      nodes: orderFlowNodes(traversalEligible),
      relationships: traversalEligible,
      traversalRule: "Teach this as one coherent architecture subtopic before moving to unrelated document sections.",
    },
  ];
}

function buildTeachingFocusSequenceFromTeachingUnits({ teachingUnits = [] } = {}) {
  return teachingUnits
    .filter((unit) => unit?.metadata?.architectureFirst)
    .map((unit, index) => {
      const role = unit.metadata?.role;
      let reason = "flow_intermediate_component";

      if (role === "architecture_overview") reason = "flow_entry_point";
      if (role === "architecture_recap") reason = "flow_destination";

      return {
        focusId: `${unit.id}_focus`,
        entityId: unit.metadata?.architectureTeachingChapterId || unit.id,
        flowGroupId: "architecture_teaching_progression",
        reason,
        priority: Number((0.96 - index * 0.04).toFixed(2)),
        durationWeight: role === "architecture_overview" ? 0.85 : role === "architecture_recap" ? 0.65 : 0.75,
        confidence: unit.metadata?.confidence || "medium",
        source: "lessonGraphBuilder",
      };
    });
}

function buildTeachingFocusSequence({ flowGroups = [] } = {}) {
  const sequence = [];

  for (const flowGroup of flowGroups) {
    const orderedNodes = Array.isArray(flowGroup.nodes) ? flowGroup.nodes : [];

    orderedNodes.forEach((nodeId, index) => {
      sequence.push({
        focusId: `${flowGroup.flowGroupId}_focus_${index + 1}`,
        entityId: nodeId,
        flowGroupId: flowGroup.flowGroupId,
        reason:
          index === 0
            ? "flow_entry_point"
            : index === orderedNodes.length - 1
              ? "flow_destination"
              : "flow_intermediate_component",
        priority: Number((0.95 - index * 0.05).toFixed(2)),
        durationWeight: index === 0 ? 0.8 : 0.7,
        confidence: flowGroup.confidence || "medium",
        source: "lessonGraphBuilder",
      });
    });
  }

  return sequence;
}

function buildChoreographyIntent({ teachingFocusSequence = [] } = {}) {
  return teachingFocusSequence.map((focus, index) => {
    let motionIntent = "guided_focus";

    if (focus.reason === "flow_entry_point") {
      motionIntent = "zoom_to_flow_entry";
    } else if (focus.reason === "flow_intermediate_component") {
      motionIntent = "follow_flow_to_component";
    } else if (focus.reason === "flow_destination") {
      motionIntent = "settle_on_flow_destination";
    }

    return {
      choreographyId: `${focus.focusId}_choreography`,
      focusId: focus.focusId,
      entityId: focus.entityId,
      flowGroupId: focus.flowGroupId,
      sequenceIndex: index,
      motionIntent,
      cameraBehavior: index === 0 ? "establish_context_then_zoom" : "smooth_pan_or_zoom_from_previous_focus",
      overlayBehavior: "minimal_context_label",
      pacing: focus.durationWeight >= 0.8 ? "slower_establishing_beat" : "steady_flow_beat",
      confidence: focus.confidence,
      source: "lessonGraphBuilder",
      borrowedIdeas: ["tldraw_zoom_to_bounds", "motion_canvas_timeline_choreography"],
    };
  });
}

function buildLessonGraph({
  documentIntelligence = {},
  conceptsData = {},
  extractedData = {},
  diagramAnalysis = {},
  architectureUnderstanding = {},
  architectureTeaching = {},
  jobDir = null,
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

  const usingArchitectureTeaching = hasUsableArchitectureTeaching({
    documentIntelligence,
    architectureTeaching,
  });

  const architectureFlowGroups = buildArchitectureFlowGroups(architectureUnderstanding);

  const coreUnits = buildCoreTeachingUnits({
    conceptsData,
    diagramAnalysis,
    documentIntelligence,
    extractedData,
    architectureUnderstanding,
    architectureTeaching,
  });

  const includeIntro = !usingArchitectureTeaching;
  const includeRecap =
    !usingArchitectureTeaching &&
    (compactCheatSheet ? coreUnits.length >= 4 : effectiveRuntimeBudgetMinutes >= 3);

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
    jobDir,
  });

  const teachingUnits = sourceGrounding.teachingUnits;

  const teachingFocusSequence = usingArchitectureTeaching
    ? buildTeachingFocusSequenceFromTeachingUnits({ teachingUnits })
    : buildTeachingFocusSequence({ flowGroups: architectureFlowGroups });

  const choreographyIntent = buildChoreographyIntent({
    teachingFocusSequence,
  });

  const architectureTraversal = {
    version: usingArchitectureTeaching
      ? "architecture-traversal-v2-teaching-driven"
      : "architecture-traversal-v1",
    enabled: documentIntelligence?.primaryType === "architecture_doc",
    ownership: "lessonGraphBuilder",
    rule: usingArchitectureTeaching
      ? "Lesson graph consumes architectureTeaching for semantic chapters; architectureTeaching owns meaning."
      : "Lesson graph decides traversal; spatial and architecture layers provide evidence only.",
    priorityHierarchy: [
      "pedagogical_priority",
      "architecture_teaching",
      "deterministic_flow",
      "high_confidence_spatial_flow",
      "semantic_importance",
      "spatial_adjacency",
      "reading_order",
    ],
    confidenceContract: {
      deterministic: "can_drive_traversal",
      high: "can_drive_traversal",
      medium: "limited_supporting_signal",
      low: "narration_only_never_camera_authority",
    },
    componentCount: architectureUnderstanding?.deterministicGraph?.components?.length || 0,
    deterministicRelationshipCount: architectureUnderstanding?.deterministicGraph?.relationships?.length || 0,
    explicitFlowCount:
      architectureUnderstanding?.flows?.length ||
      architectureUnderstanding?.deterministicGraph?.flows?.length ||
      0,
    spatialCandidateCount: architectureUnderstanding?.spatialRelationshipCandidates?.length || 0,
    flowGroupCount: architectureFlowGroups.length,
    flowGroups: architectureFlowGroups,
    architectureTeachingApplied: usingArchitectureTeaching,
    architectureTeachingVersion: architectureTeaching?.schemaVersion || null,
    teachingFocusSequenceCount: teachingFocusSequence.length,
    teachingFocusSequence,
    choreographyIntentCount: choreographyIntent.length,
    choreographyIntent,
    borrowedIdeas: [
      "langgraph_traversal_state",
      "motion_canvas_semantic_beats",
      "tldraw_zoom_to_bounds",
      "observable_explain_while_showing",
      "notebooklm_guided_mental_model_recap",
    ],
  };

  return {
    version: usingArchitectureTeaching
      ? "lesson-graph-v5-architecture-teaching-driven"
      : "lesson-graph-v4-document-structured",
    documentType: documentIntelligence?.primaryType || "unknown",
    secondaryTypes: documentIntelligence?.secondaryTypes || [],
    teachingStrategy: compactCheatSheet
      ? "compact_high_density_operational_focus_walkthrough"
      : usingArchitectureTeaching
        ? "architecture_teaching_handoff_first_walkthrough"
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
    architectureTraversal,
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
      architectureTeachingApplied: usingArchitectureTeaching,
      architectureFirstApplied:
        usingArchitectureTeaching ||
        (isArchitectureDocument(documentIntelligence) && architectureFlowGroups.length > 0),
    },
  };
}

module.exports = {
  buildLessonGraph,
};
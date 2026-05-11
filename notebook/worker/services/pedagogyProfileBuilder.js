// notebook/worker/services/pedagogyProfileBuilder.js


function safeString(value) {
  return String(value || "").trim();
}

function safeLower(value) {
  return safeString(value).toLowerCase();
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function normalizePrimaryType(documentIntelligence = {}) {
  const type = safeLower(documentIntelligence.primaryType);

  if (type.includes("cheat")) return "cheat_sheet";
  if (type.includes("command")) return "cheat_sheet";
  if (type.includes("reference")) return "cheat_sheet";
  if (type.includes("runbook")) return "runbook";
  if (type.includes("procedure")) return "runbook";
  if (type.includes("architecture")) return "architecture_doc";
  if (type.includes("diagram")) return "architecture_doc";
  if (type.includes("postmortem")) return "postmortem";
  if (type.includes("incident")) return "postmortem";
  if (type.includes("rca")) return "postmortem";
  if (type.includes("design")) return "design_doc";
  if (type.includes("rfc")) return "design_doc";

  return documentIntelligence.primaryType || "unknown";
}

function inferDensity(documentIntelligence = {}, pageCount = 0) {
  const explicitDensity = safeLower(documentIntelligence.density);
  if (["low", "medium", "high"].includes(explicitDensity)) {
    return explicitDensity;
  }

  const runtimeBudgetMinutes = Number(documentIntelligence.runtimeBudgetMinutes || 0);
  const targetSceneCount = Number(documentIntelligence.targetSceneCount || 0);

  if (pageCount <= 2 && runtimeBudgetMinutes <= 4) return "high";
  if (targetSceneCount >= 12 || pageCount >= 8) return "medium";
  if (pageCount >= 15) return "high";

  return "medium";
}

function isCompactDocument(documentIntelligence = {}, pageCount = 0) {
  return Boolean(
    documentIntelligence.compactDoc ||
      pageCount <= 3 ||
      Number(documentIntelligence.runtimeBudgetMinutes || 0) <= 4
  );
}

function buildBaseProfile({ documentIntelligence = {}, pageCount = 0 }) {
  const documentType = normalizePrimaryType(documentIntelligence);
  const density = inferDensity(documentIntelligence, pageCount);
  const compact = isCompactDocument(documentIntelligence, pageCount);

  return {
    version: "pedagogy-profile-v1",
    source: "pedagogyProfileBuilder",
    documentType,
    secondaryTypes: Array.isArray(documentIntelligence.secondaryTypes)
      ? documentIntelligence.secondaryTypes
      : [],
    density,
    compact,
    pageCount,
    narrationDensity: "medium",
    explanationStyle: "technical_walkthrough",
    visualStrategy: "document_dominant",
    llmUse: "bounded",
    shouldSimplify: true,
    shouldPreserveOrder: false,
    shouldPreferDocumentHeadings: true,
    shouldUseHardcodedDomainTaxonomy: false,
    shouldUseCommandGroupingFallback: false,
    maxCommandsPerUnit: 4,
    maxSceneDurationSec: compact ? 18 : 28,
    minSceneDurationSec: compact ? 8 : 12,
    teachingRules: [],
    avoidNarration: [
      "reading visible text verbatim",
      "over-explaining self-explanatory commands",
      "inventing headings that are not grounded in the uploaded document",
      "forcing Kubernetes-specific categories onto unrelated documents",
      "repeating the same problem-solution pattern in every scene",
      "using filler phrases",
    ],
  };
}

function applyCheatSheetProfile(profile) {
  return {
    ...profile,
    narrationDensity: "low",
    explanationStyle: "operational_hint",
    visualStrategy: "document_dominant",
    llmUse: "minimal",
    shouldSimplify: false,
    shouldPreserveOrder: true,
    shouldPreferDocumentHeadings: true,
    shouldUseCommandGroupingFallback: true,
    maxCommandsPerUnit: 4,
    maxSceneDurationSec: 16,
    minSceneDurationSec: 7,
    teachingRules: [
      "keep commands visually dominant",
      "explain only the operational purpose when it adds value",
      "group related commands instead of explaining every line",
      "move quickly through self-explanatory reference material",
      "prefer real document headings or extracted command groups",
    ],
  };
}

function applyRunbookProfile(profile) {
  return {
    ...profile,
    narrationDensity: "medium",
    explanationStyle: "step_by_step",
    visualStrategy: "sequence_dominant",
    llmUse: "bounded",
    shouldSimplify: true,
    shouldPreserveOrder: true,
    shouldPreferDocumentHeadings: true,
    shouldUseCommandGroupingFallback: false,
    maxCommandsPerUnit: 3,
    maxSceneDurationSec: 24,
    minSceneDurationSec: 10,
    teachingRules: [
      "preserve procedural order",
      "explain why each step matters operationally",
      "call out checks, warnings, and rollback points",
      "avoid turning the runbook into generic theory",
    ],
  };
}

function applyArchitectureProfile(profile) {
  return {
    ...profile,
    narrationDensity: "high",
    explanationStyle: "conceptual_walkthrough",
    visualStrategy: "diagram_dominant",
    llmUse: "helpful",
    shouldSimplify: true,
    shouldPreserveOrder: false,
    shouldPreferDocumentHeadings: true,
    shouldUseCommandGroupingFallback: false,
    maxCommandsPerUnit: 2,
    maxSceneDurationSec: 30,
    minSceneDurationSec: 12,
    teachingRules: [
      "explain relationships between components",
      "prefer diagrams and visual flow",
      "use analogies only when they simplify a complex concept",
      "connect each concept back to the real document",
    ],
  };
}

function applyPostmortemProfile(profile) {
  return {
    ...profile,
    narrationDensity: "medium",
    explanationStyle: "timeline_causal",
    visualStrategy: "timeline_dominant",
    llmUse: "bounded",
    shouldSimplify: true,
    shouldPreserveOrder: true,
    shouldPreferDocumentHeadings: true,
    shouldUseCommandGroupingFallback: false,
    maxCommandsPerUnit: 2,
    maxSceneDurationSec: 26,
    minSceneDurationSec: 10,
    teachingRules: [
      "preserve incident chronology",
      "explain cause and effect",
      "highlight detection, impact, mitigation, and prevention",
      "avoid over-dramatizing the incident",
    ],
  };
}

function applyDesignDocProfile(profile) {
  return {
    ...profile,
    narrationDensity: "medium",
    explanationStyle: "decision_tradeoff",
    visualStrategy: "concept_dominant",
    llmUse: "helpful",
    shouldSimplify: true,
    shouldPreserveOrder: false,
    shouldPreferDocumentHeadings: true,
    shouldUseCommandGroupingFallback: false,
    maxCommandsPerUnit: 2,
    maxSceneDurationSec: 28,
    minSceneDurationSec: 12,
    teachingRules: [
      "explain decisions and tradeoffs",
      "separate context, proposal, alternatives, and risks",
      "simplify dense sections only when needed",
      "avoid pretending unresolved questions are settled facts",
    ],
  };
}

function applyUnknownProfile(profile) {
  return {
    ...profile,
    narrationDensity: profile.compact ? "low" : "medium",
    explanationStyle: profile.compact ? "document_overview" : "technical_walkthrough",
    visualStrategy: "document_dominant",
    llmUse: "bounded",
    shouldSimplify: !profile.compact,
    shouldPreserveOrder: true,
    shouldPreferDocumentHeadings: true,
    shouldUseHardcodedDomainTaxonomy: false,
    shouldUseCommandGroupingFallback: false,
    maxCommandsPerUnit: 3,
    maxSceneDurationSec: profile.compact ? 18 : 26,
    minSceneDurationSec: profile.compact ? 8 : 12,
    teachingRules: [
      "prefer the uploaded document structure",
      "do not invent domain-specific categories",
      "summarize only when the source text is dense or unclear",
      "keep the document visible as the source of truth",
    ],
  };
}

function applyDensityAdjustments(profile) {
  if (profile.density === "high" && profile.documentType === "cheat_sheet") {
    return {
      ...profile,
      narrationDensity: "low",
      maxSceneDurationSec: Math.min(profile.maxSceneDurationSec, 14),
      teachingRules: [
        ...profile.teachingRules,
        "because density is high, explain less and show more",
      ],
    };
  }

  if (profile.density === "high") {
    return {
      ...profile,
      maxSceneDurationSec: Math.min(profile.maxSceneDurationSec, 24),
      teachingRules: [
        ...profile.teachingRules,
        "because density is high, choose fewer stronger teaching moments",
      ],
    };
  }

  if (profile.density === "low") {
    return {
      ...profile,
      maxSceneDurationSec: Math.min(profile.maxSceneDurationSec + 4, 32),
      teachingRules: [
        ...profile.teachingRules,
        "because density is low, add explanation only if it helps context",
      ],
    };
  }

  return profile;
}

function buildPedagogyProfile({
  documentIntelligence = {},
  diagramAnalysis = {},
  conceptsData = {},
} = {}) {
  const pageCount =
    Array.isArray(diagramAnalysis.pages)
      ? diagramAnalysis.pages.length
      : Array.isArray(diagramAnalysis.pageAnalyses)
        ? diagramAnalysis.pageAnalyses.length
        : Number(diagramAnalysis.pageCount || 0);

  const baseProfile = buildBaseProfile({
    documentIntelligence,
    pageCount,
  });

  let profile;

  switch (baseProfile.documentType) {
    case "cheat_sheet":
      profile = applyCheatSheetProfile(baseProfile);
      break;

    case "runbook":
      profile = applyRunbookProfile(baseProfile);
      break;

    case "architecture_doc":
      profile = applyArchitectureProfile(baseProfile);
      break;

    case "postmortem":
      profile = applyPostmortemProfile(baseProfile);
      break;

    case "design_doc":
      profile = applyDesignDocProfile(baseProfile);
      break;

    default:
      profile = applyUnknownProfile(baseProfile);
      break;
  }

  const adjustedProfile = applyDensityAdjustments(profile);

  return {
    ...adjustedProfile,
    stats: {
      primaryTopicCount: Array.isArray(conceptsData.primaryTopics)
        ? conceptsData.primaryTopics.length
        : 0,
      hasPresentationGrammar: Boolean(documentIntelligence.presentationGrammar),
      hasSecondaryTypes: adjustedProfile.secondaryTypes.length > 0,
    },
  };
}

module.exports = {
  buildPedagogyProfile,
};
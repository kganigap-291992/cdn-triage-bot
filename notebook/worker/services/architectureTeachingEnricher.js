/**
 * architectureTeachingEnricher.js
 *
 * Adds safe, domain-independent teaching meaning to architecture flow chapters.
 *
 * Core rule:
 * - Teach handoffs/segments first.
 * - Components are supporting context.
 * - Use document evidence first.
 * - Enrich only with universal architecture concepts.
 * - Never invent hidden implementation behavior.
 */


const fs = require("fs");
const path = require("path");

const CONFIDENCE_ORDER = {
  deterministic: 4,
  high: 3,
  medium: 2,
  low: 1,
  unknown: 0,
};

const CONFIDENCE_LANGUAGE = {
  deterministic: {
    prefix: "The document shows",
    factuality: "evidence_backed",
    canNarrateAsFact: true,
  },
  high: {
    prefix: "The flow indicates",
    factuality: "strongly_supported",
    canNarrateAsFact: true,
  },
  medium: {
    prefix: "This appears to",
    factuality: "cautious_interpretation",
    canNarrateAsFact: true,
  },
  low: {
    prefix: "This may suggest",
    factuality: "debug_only",
    canNarrateAsFact: false,
  },
  unknown: {
    prefix: "The available evidence is limited",
    factuality: "unknown",
    canNarrateAsFact: false,
  },
};

const SAFE_GENERIC_CONCEPTS = {
  ingress_boundary: {
    label: "Ingress / Boundary",
    operationalMeaning:
      "This handoff helps establish where the documented flow enters or crosses a system boundary.",
    allowedHint:
      "Explain the boundary crossing without assuming protocol, auth method, or infrastructure details.",
  },
  routing_control: {
    label: "Routing / Control",
    operationalMeaning:
      "This handoff helps explain where traffic or work is routed, checked, coordinated, or directed.",
    allowedHint:
      "Explain control flow generally. Do not invent policies, algorithms, or authorization mechanisms.",
  },
  validation_checkpoint: {
    label: "Validation / Checkpoint",
    operationalMeaning:
      "This handoff appears to represent a point where the flow is checked, validated, or gated.",
    allowedHint:
      "Explain checkpoint behavior only at a generic level unless the document gives specifics.",
  },
  processing_transform: {
    label: "Processing / Transform",
    operationalMeaning:
      "This handoff represents work moving through an internal processing or execution path.",
    allowedHint:
      "Explain that work continues through the system without inventing transformation logic.",
  },
  persistence_state: {
    label: "Persistence / State",
    operationalMeaning:
      "This handoff helps explain where the documented flow reaches state, storage, or a terminal destination.",
    allowedHint:
      "Explain state/persistence only generically unless the document names the exact storage behavior.",
  },
  fanout_distribution: {
    label: "Fanout / Distribution",
    operationalMeaning:
      "This handoff suggests work may branch, distribute, or move toward multiple downstream paths.",
    allowedHint:
      "Explain branching generally. Do not invent queues, retries, async behavior, or delivery guarantees.",
  },
  generic_handoff: {
    label: "Documented Handoff",
    operationalMeaning:
      "This handoff connects two documented parts of the architecture.",
    allowedHint:
      "Explain the connection conservatively using the available evidence.",
  },
};

const SAFETY_POLICY = {
  allowedGenericConcepts: Object.keys(SAFE_GENERIC_CONCEPTS),
  disallowedUnlessExplicitlyDocumented: [
    "OAuth or JWT behavior",
    "Kafka, SQS, Pub/Sub, or queue semantics",
    "cache behavior",
    "replication behavior",
    "encryption behavior",
    "database type",
    "transport protocol specifics",
    "async guarantees",
    "retry behavior",
    "failover behavior",
    "autoscaling behavior",
    "hidden service responsibilities",
  ],
  lowConfidenceRule:
    "Low-confidence relationships must not be narrated as facts. They may be used only for debug or conservative fallback context.",
  ownership:
    "architectureTeaching owns operational meaning but must not override architectureUnderstanding truth or architectureFlow traversal.",
};

function normalizeText(value) {
  return String(value || "").trim();
}

function normalizeKey(value) {
  return normalizeText(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function confidenceScore(confidence) {
  return CONFIDENCE_ORDER[confidence] ?? CONFIDENCE_ORDER.unknown;
}

function summarizeConfidence(confidences = []) {
  const scores = confidences.map(confidenceScore).filter((score) => score > 0);

  if (!scores.length) return "unknown";

  const min = Math.min(...scores);

  if (min >= CONFIDENCE_ORDER.high) return "high";
  if (min >= CONFIDENCE_ORDER.medium) return "medium";
  if (min >= CONFIDENCE_ORDER.low) return "low";
  return "unknown";
}

function getConfidenceLanguage(confidence) {
  return CONFIDENCE_LANGUAGE[confidence] || CONFIDENCE_LANGUAGE.unknown;
}

function uniqueBy(items, getKey) {
  const seen = new Set();
  const out = [];

  for (const item of items || []) {
    const key = getKey(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }

  return out;
}

function collectTextHints(...values) {
  return values
    .flatMap((value) => {
      if (Array.isArray(value)) return value;
      if (value && typeof value === "object") return Object.values(value);
      return [value];
    })
    .map(normalizeText)
    .filter(Boolean)
    .join(" ");
}

function compactText(value, maxLength = 420) {
  const text = normalizeText(value).replace(/\s+/g, " ");
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1).trim()}…`;
}


function parseJsonObject(value) {
  try {
    if (!value) return null;
    if (typeof value === "object") return value;

    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function isValidLlmTeaching(value) {
  return Boolean(
    value &&
      normalizeText(value.plainEnglish) &&
      normalizeText(value.safeSemantics) &&
      normalizeText(value.whyItMatters) &&
      normalizeText(value.memoryHook)
  );
}

function buildGlossaryIndex(architectureUnderstanding = {}) {
  const glossary = asArray(
    architectureUnderstanding.glossary ||
      architectureUnderstanding.extractedGlossary ||
      architectureUnderstanding.definitions
  );

  const byKey = new Map();

  for (const entry of glossary) {
    const term = normalizeText(entry.term || entry.name || entry.label);
    if (!term) continue;

    byKey.set(normalizeKey(term), {
      term,
      definition: normalizeText(entry.definition || entry.text || entry.description),
      source: entry.source || "document_glossary",
    });
  }

  return byKey;
}

function findGlossaryMatches(segment = {}, glossaryIndex) {
  return uniqueBy(
    [segment.from?.name, segment.to?.name, segment.structuralHandoff]
      .map((value) => glossaryIndex.get(normalizeKey(value)))
      .filter(Boolean),
    (item) => normalizeKey(item.term)
  );
}

function buildDeterministicTeachingFields({
  segment,
  evidenceSummary,
  genericConcept,
  glossaryMatches,
}) {
  const concept =
    SAFE_GENERIC_CONCEPTS[genericConcept] || SAFE_GENERIC_CONCEPTS.generic_handoff;

  const fromName = segment.from?.name || "the upstream component";
  const toName = segment.to?.name || "the downstream component";
  const handoff = `${fromName} → ${toName}`;

  return {
    documentSays: evidenceSummary.text,
    plainEnglish: `${handoff} is a documented handoff in the architecture flow.`,
    safeSemantics: concept.operationalMeaning,
    whyItMatters:
      "This helps the learner understand where responsibility moves from one documented part of the system to another.",
    memoryHook: `Remember this as: ${fromName} hands off responsibility to ${toName}.`,
    glossaryMatches,
    usedGlossary: glossaryMatches.length > 0,
    usedEvidenceOnly: true,
    confidenceMode: segment.confidence || "unknown",
  };
}


async function enrichTeachingWithLlm({
  deterministicTeaching,
  segment,
  llmClient,
}) {
  if (!llmClient) {
    return {
      ...deterministicTeaching,
      llmUsed: false,
      llmValid: false,
      fallbackUsed: true,
    };
  }

  try {
    const raw = await llmClient({
      segmentId: segment.id,
      from: segment.from?.name,
      to: segment.to?.name,
      documentSays: deterministicTeaching.documentSays,
      glossaryMatches: deterministicTeaching.glossaryMatches,
      fallback: deterministicTeaching,
    });

    const parsed = parseJsonObject(raw);

    if (!isValidLlmTeaching(parsed)) {
      throw new Error("Invalid LLM teaching JSON");
    }

    return {
      ...deterministicTeaching,
      plainEnglish: normalizeText(parsed.plainEnglish),
      safeSemantics: normalizeText(parsed.safeSemantics),
      whyItMatters: normalizeText(parsed.whyItMatters),
      memoryHook: normalizeText(parsed.memoryHook),
      llmUsed: true,
      llmValid: true,
      fallbackUsed: false,
    };
  } catch {
    return {
      ...deterministicTeaching,
      llmUsed: true,
      llmValid: false,
      fallbackUsed: true,
    };
  }
}

function buildEvidenceIndex(architectureUnderstanding = {}) {
  const evidence = asArray(architectureUnderstanding.evidence);
  const deterministicRelationships = asArray(
    architectureUnderstanding.deterministicGraph?.relationships
  );

  const relationshipEvidence = deterministicRelationships.flatMap((relationship) => {
    const evidenceText = normalizeText(relationship.evidenceText);

    if (!evidenceText) return [];

    return {
      id: `relationship_evidence_${relationship.id || normalizeKey(evidenceText)}`,
      source: "architecture_relationship",
      text: evidenceText,
      relationshipId: relationship.id,
      evidenceIds: asArray(relationship.evidenceIds),
    };
  });

  const byId = new Map();

  for (const item of [...evidence, ...relationshipEvidence]) {
    if (item?.id) byId.set(item.id, item);
  }

  return {
    evidence: [...evidence, ...relationshipEvidence],
    byId,
  };
}

function resolveEvidenceSummary(segment = {}, evidenceIndex) {
  const evidenceIds = asArray(segment.evidenceIds);
  const directEvidence = evidenceIds
    .map((id) => evidenceIndex.byId.get(id))
    .filter(Boolean)
    .map((item) => normalizeText(item.text || item.content || item.label));

  const directText = directEvidence.filter(Boolean).join(" ");

  if (directText) {
    return {
      source: "document_evidence",
      text: compactText(directText),
      hasDocumentExplanation: true,
    };
  }

  return {
    source: "flow_segment",
    text: compactText(
      `${segment.from?.name || "Source"} hands off to ${segment.to?.name || "target"}.`
    ),
    hasDocumentExplanation: false,
  };
}

function inferGenericConcept(segment = {}) {
  const handoff = normalizeKey(segment.structuralHandoff);
  const purpose = normalizeKey(segment.teachingPurpose);
  const fromRole = normalizeKey(segment.from?.structuralRole || segment.from?.role);
  const toRole = normalizeKey(segment.to?.structuralRole || segment.to?.role);

  const text = `${handoff} ${purpose} ${fromRole} ${toRole}`;

  if (
    text.includes("source_node") ||
    text.includes("boundary_node") ||
    text.includes("entry") ||
    text.includes("boundary") ||
    text.includes("ingress")
  ) {
    return "ingress_boundary";
  }

  if (
    text.includes("control_node") ||
    text.includes("fanout_node") ||
    text.includes("routing") ||
    text.includes("control") ||
    text.includes("decision")
  ) {
    return text.includes("fanout_node") ? "fanout_distribution" : "routing_control";
  }

  if (
    text.includes("validate") ||
    text.includes("validation") ||
    text.includes("auth") ||
    text.includes("checkpoint") ||
    text.includes("check")
  ) {
    return "validation_checkpoint";
  }

  if (
    text.includes("state_node") ||
    text.includes("terminal_node") ||
    text.includes("state") ||
    text.includes("persistence") ||
    text.includes("destination")
  ) {
    return "persistence_state";
  }

  if (
    text.includes("processing_node") ||
    text.includes("processing") ||
    text.includes("execution") ||
    text.includes("service_handoff")
  ) {
    return "processing_transform";
  }

  return "generic_handoff";
}

function buildSegmentTeachingNarrationHint({
  segment,
  evidenceSummary,
  confidence,
  genericConcept,
}) {
  const language = getConfidenceLanguage(confidence);
  const concept = SAFE_GENERIC_CONCEPTS[genericConcept] || SAFE_GENERIC_CONCEPTS.generic_handoff;

  const fromName = segment.from?.name || "the upstream component";
  const toName = segment.to?.name || "the downstream component";

  if (!language.canNarrateAsFact) {
    return {
      canNarrate: false,
      hint:
        "Do not narrate this handoff as a fact. Keep it as debug/supporting context only.",
    };
  }

  if (evidenceSummary.hasDocumentExplanation) {
    return {
      canNarrate: true,
      hint: `${language.prefix} a handoff from ${fromName} to ${toName}. Use the document evidence first, then explain its operational meaning as ${concept.label}.`,
    };
  }

  return {
    canNarrate: true,
    hint: `${language.prefix} a handoff from ${fromName} to ${toName}. Explain it conservatively as ${concept.label}; avoid implementation details the document does not state.`,
  };
}

async function enrichSegment(segment = {}, index, evidenceIndex, glossaryIndex, llmClient) {
  const confidence = segment.confidence || "unknown";
  const confidenceLanguage = getConfidenceLanguage(confidence);
  const genericConcept = inferGenericConcept(segment);
  const concept = SAFE_GENERIC_CONCEPTS[genericConcept] || SAFE_GENERIC_CONCEPTS.generic_handoff;
  const evidenceSummary = resolveEvidenceSummary(segment, evidenceIndex);
  const glossaryMatches = findGlossaryMatches(segment, glossaryIndex);

    const deterministicTeaching = buildDeterministicTeachingFields({
        segment,
        evidenceSummary,
        genericConcept,
        glossaryMatches,
    });

    const teaching = await enrichTeachingWithLlm({
        deterministicTeaching,
        segment,
        llmClient,
    });

  const narrationHint = buildSegmentTeachingNarrationHint({
    segment,
    evidenceSummary,
    confidence,
    genericConcept,
  });

  return {
    id: segment.id || `enriched_segment_${index + 1}`,
    sourceSegmentId: segment.id || null,

    from: segment.from || null,
    to: segment.to || null,

    relationshipType: segment.relationshipType || "architecture_handoff",
    structuralHandoff: segment.structuralHandoff || null,
    teachingPurpose: segment.teachingPurpose || "explain_documented_component_handoff",

    confidence,
    confidenceLanguage,

    teachingUnitType: "handoff_segment",
    primaryTeachingFocus: "relationship_handoff",
    supportingContext: {
      nodes: [segment.from, segment.to].filter(Boolean),
      nodeRole:
        "Nodes provide context. The handoff between them is the primary teaching unit.",
    },

    genericConcept,
    teachingContext: {
      conceptLabel: concept.label,
      operationalMeaning: concept.operationalMeaning,
      allowedHint: concept.allowedHint,
    },

    evidenceSummary,

    documentSays: teaching.documentSays,
    plainEnglish: teaching.plainEnglish,
    safeSemantics: teaching.safeSemantics,
    whyItMatters: teaching.whyItMatters,
    memoryHook: teaching.memoryHook,
    glossaryMatches: teaching.glossaryMatches,
    usedGlossary: teaching.usedGlossary,
    usedEvidenceOnly: teaching.usedEvidenceOnly,
    confidenceMode: teaching.confidenceMode,
    llmUsed: teaching.llmUsed,
    llmValid: teaching.llmValid,
    fallbackUsed: teaching.fallbackUsed,

    transitionNarrationHint: narrationHint.hint,

    canNarrateAsFact: confidenceLanguage.canNarrateAsFact,

    safetyFlags: buildSegmentSafetyFlags({
      segment,
      confidence,
      evidenceSummary,
      narrationHint,
    }),
  };
}

function buildSegmentSafetyFlags({ confidence, evidenceSummary, narrationHint }) {
  const flags = [];

  if (!evidenceSummary.hasDocumentExplanation) {
    flags.push({
      code: "NO_DIRECT_DOCUMENT_EXPLANATION",
      severity: "info",
      instruction:
        "Use only safe generic architecture language. Do not invent component responsibilities.",
    });
  }

  if (!narrationHint.canNarrate) {
    flags.push({
      code: "DO_NOT_NARRATE_AS_FACT",
      severity: "warning",
      instruction:
        "This segment is below narration confidence threshold and should not be spoken as factual architecture behavior.",
    });
  }

  if (confidence === "medium") {
    flags.push({
      code: "USE_CAUTION_LANGUAGE",
      severity: "info",
      instruction:
        "Use phrases like 'appears to' or 'based on the documented flow'.",
    });
  }

  return flags;
}

function enrichOverviewChapter(chapter = {}, enrichedSegments = []) {
  const entities = asArray(chapter.primaryEntities);
  const entityNames = entities.map((entity) => entity.name).filter(Boolean);

  return {
    id: chapter.id || "architecture_chapter_0_overview",
    sourceChapterId: chapter.id || null,
    type: chapter.type || "architecture_overview",
    title: chapter.title || "Full Architecture Overview",
    purpose:
      chapter.purpose ||
      "Establish the system before walking through individual handoffs.",

    confidence: chapter.confidence || "unknown",
    confidenceLanguage: getConfidenceLanguage(chapter.confidence || "unknown"),

    teachingUnitType: "overview",
    teachingStrategy:
      "Start broad. Establish the major documented components and prepare the learner for the flow walkthrough.",

    primaryEntities: entities,

    teachingContext: {
      operationalMeaning:
        "This chapter gives the learner a safe mental map before zooming into handoffs.",
      suggestedNarrationHint: entityNames.length
        ? `Introduce the architecture using the documented components: ${entityNames
            .slice(0, 6)
            .join(", ")}. Do not explain hidden behavior.`
        : "Introduce the architecture conservatively. The available component list is limited.",
    },

    relatedSegmentIds: enrichedSegments.map((segment) => segment.id),
    safetyFlags: [],
  };
}

function enrichRecapChapter(chapter = {}, enrichedSegments = []) {
  const reliableSegments = enrichedSegments.filter((segment) => segment.canNarrateAsFact);

  return {
    id: chapter.id || "architecture_chapter_recap",
    sourceChapterId: chapter.id || null,
    type: chapter.type || "architecture_recap",
    title: chapter.title || "Architecture Recap",
    purpose:
      chapter.purpose ||
      "Summarize the architecture as a simple evidence-backed mental model.",

    confidence: chapter.confidence || summarizeConfidence(reliableSegments.map((s) => s.confidence)),
    confidenceLanguage: getConfidenceLanguage(
      chapter.confidence || summarizeConfidence(reliableSegments.map((s) => s.confidence))
    ),

    teachingUnitType: "recap",
    teachingStrategy:
      "Summarize the flow as a mental model. Reuse established concepts instead of introducing new claims.",

    primaryEntities: asArray(chapter.primaryEntities),

    recapMentalModel:
      chapter.recapMentalModel || buildRecapMentalModelFromSegments(reliableSegments),

    relatedSegmentIds: reliableSegments.map((segment) => segment.id),

    teachingContext: {
      operationalMeaning:
        "The recap should help the learner remember how responsibility moves through the documented system.",
      suggestedNarrationHint:
        "Recap the flow using only the handoffs already established. Do not add new architecture behavior in the recap.",
    },

    safetyFlags: [],
  };
}

function buildRecapMentalModelFromSegments(segments = []) {
  const concepts = uniqueBy(
    segments.map((segment) => ({
      key: segment.genericConcept,
      label: segment.teachingContext?.conceptLabel,
    })),
    (item) => item.key
  )
    .map((item) => item.label)
    .filter(Boolean);

  if (!concepts.length) {
    return "Remember the architecture as documented components connected by evidence-backed handoffs.";
  }

  return `Remember the architecture as: ${concepts.join(" → ")}.`;
}

async function enrichFlowChapter(chapter = {}, chapterIndex, evidenceIndex, glossaryIndex, llmClient) {
  const enrichedSegments = [];

  for (const [index, segment] of asArray(chapter.segments).entries()) {
    enrichedSegments.push(
      await enrichSegment(segment, index, evidenceIndex, glossaryIndex, llmClient)
    );
  }

  const confidence = chapter.confidence || summarizeConfidence(enrichedSegments.map((s) => s.confidence));

  const reliableSegments = enrichedSegments.filter((segment) => segment.canNarrateAsFact);

  return {
    id: chapter.id || `enriched_architecture_chapter_${chapterIndex + 1}`,
    sourceChapterId: chapter.id || null,
    type: chapter.type || "architecture_flow_chapter",
    title: chapter.title || "Architecture Flow",
    purpose: chapter.purpose || "Teach a documented architecture flow.",

    confidence,
    confidenceLanguage: getConfidenceLanguage(confidence),

    teachingUnitType: "semantic_flow_group",
    primaryTeachingFocus: "handoff_sequence",

    enrichedSegments,

    primaryEntities: asArray(chapter.primaryEntities),

    teachingContext: {
      operationalMeaning: buildChapterOperationalMeaning(chapter, reliableSegments),
      transitionNarrationHint: buildChapterTransitionHint(chapter, reliableSegments),
      chapterTeachingStrategy:
        "Teach the grouped handoffs as one coherent architecture concept, not as isolated labels.",
    },

    teachingProgression: {
      introducedConcepts: uniqueBy(
        reliableSegments.map((segment) => ({
          concept: segment.genericConcept,
          label: segment.teachingContext?.conceptLabel,
        })),
        (item) => item.concept
      ),
      establishedEntities: uniqueBy(
        reliableSegments.flatMap((segment) => [segment.from, segment.to].filter(Boolean)),
        (entity) => entity.id
      ),
    },

    safetyFlags: buildChapterSafetyFlags(chapter, enrichedSegments),
  };
}

function buildChapterOperationalMeaning(chapter, reliableSegments) {
  if (!reliableSegments.length) {
    return "The available evidence is limited, so this chapter should stay conservative.";
  }

  const concepts = uniqueBy(
    reliableSegments.map((segment) => segment.teachingContext?.conceptLabel).filter(Boolean),
    (label) => label
  );

  if (concepts.length) {
    return `This chapter explains ${concepts.join(", ")} through documented architecture handoffs.`;
  }

  return chapter.purpose || "This chapter explains a documented part of the architecture flow.";
}

function buildChapterTransitionHint(chapter, reliableSegments) {
  if (!reliableSegments.length) {
    return "Transition carefully. Say that the document has limited evidence for this part of the flow.";
  }

  const first = reliableSegments[0];
  const last = reliableSegments[reliableSegments.length - 1];

  return `Walk from ${first.from?.name || "the upstream side"} toward ${
    last.to?.name || "the downstream side"
  }, explaining what responsibility changes at each handoff.`;
}

function buildChapterSafetyFlags(chapter, enrichedSegments) {
  const flags = [];

  const nonNarratable = enrichedSegments.filter((segment) => !segment.canNarrateAsFact);

  if (nonNarratable.length) {
    flags.push({
      code: "CONTAINS_NON_NARRATABLE_SEGMENTS",
      severity: "warning",
      count: nonNarratable.length,
      instruction:
        "Do not turn low-confidence segments into spoken facts. Use only reliable segments for narration.",
    });
  }

  if (!asArray(chapter.segments).length) {
    flags.push({
      code: "NO_SEGMENTS",
      severity: "info",
      instruction:
        "This chapter should be treated as overview/recap or broad context, not as a handoff walkthrough.",
    });
  }

  return flags;
}

async function enrichChapter(chapter = {}, index, evidenceIndex, glossaryIndex, llmClient) {
  if (chapter.type === "architecture_overview") {
    return enrichOverviewChapter(chapter);
  }

  if (chapter.type === "architecture_recap") {
    return enrichRecapChapter(chapter);
  }

  return enrichFlowChapter(chapter, index, evidenceIndex, glossaryIndex, llmClient);
}

function attachOverviewAndRecapContext(enrichedChapters = []) {
  const allSegments = enrichedChapters.flatMap((chapter) => asArray(chapter.enrichedSegments));

  return enrichedChapters.map((chapter) => {
    if (chapter.type === "architecture_overview") {
      return enrichOverviewChapter(chapter, allSegments);
    }

    if (chapter.type === "architecture_recap") {
      return enrichRecapChapter(chapter, allSegments);
    }

    return chapter;
  });
}

function buildTeachingProgressionState(enrichedChapters = []) {
  const establishedConcepts = [];
  const knownRoles = [];
  const previouslyExplainedEntities = [];

  for (const chapter of enrichedChapters) {
    for (const concept of asArray(chapter.teachingProgression?.introducedConcepts)) {
      establishedConcepts.push({
        concept: concept.concept,
        label: concept.label,
        introducedInChapterId: chapter.id,
      });
    }

    for (const entity of asArray(chapter.teachingProgression?.establishedEntities)) {
      previouslyExplainedEntities.push({
        id: entity.id,
        name: entity.name,
        role: entity.role || entity.structuralRole,
        introducedInChapterId: chapter.id,
      });

      if (entity.role || entity.structuralRole) {
        knownRoles.push({
          entityId: entity.id,
          entityName: entity.name,
          role: entity.role || entity.structuralRole,
          sourceChapterId: chapter.id,
        });
      }
    }
  }

  return {
    establishedConcepts: uniqueBy(establishedConcepts, (item) => item.concept),
    knownRoles: uniqueBy(knownRoles, (item) => `${item.entityId}:${item.role}`),
    previouslyExplainedEntities: uniqueBy(previouslyExplainedEntities, (item) => item.id),
    progressionRule:
      "Later chapters should build on established concepts instead of re-explaining every component label.",
  };
}

function buildGlobalWarnings(architectureUnderstanding = {}, architectureFlow = {}, enrichedChapters = []) {
  const warnings = [];

  const flowWarnings = asArray(architectureFlow.warnings);
  warnings.push(...flowWarnings);

  const lowConfidenceSegments = enrichedChapters
    .flatMap((chapter) => asArray(chapter.enrichedSegments))
    .filter((segment) => !segment.canNarrateAsFact);

  if (lowConfidenceSegments.length) {
    warnings.push({
      code: "LOW_CONFIDENCE_SEGMENTS_PRESENT",
      severity: "warning",
      count: lowConfidenceSegments.length,
      message:
        "Some segments are not safe to narrate as facts. Dialogue generation must skip or soften them.",
    });
  }

  const spatialCandidateCount =
    architectureUnderstanding.stats?.spatialRelationshipCandidateCount ||
    asArray(architectureUnderstanding.spatialRelationshipCandidates).length;

  if (!spatialCandidateCount) {
    warnings.push({
      code: "NO_SPATIAL_RELATIONSHIP_CANDIDATES",
      severity: "info",
      message:
        "Architecture teaching can proceed semantically, but camera grounding may need broad/fallback regions.",
    });
  }

  return warnings;
}

function buildStats(enrichedChapters = []) {
  const segments = enrichedChapters.flatMap((chapter) => asArray(chapter.enrichedSegments));

  return {
    chapterCount: enrichedChapters.length,
    segmentCount: segments.length,
    narratableSegmentCount: segments.filter((segment) => segment.canNarrateAsFact).length,
    nonNarratableSegmentCount: segments.filter((segment) => !segment.canNarrateAsFact).length,
    conceptBreakdown: segments.reduce((acc, segment) => {
      const key = segment.genericConcept || "unknown";
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {}),
    confidenceBreakdown: segments.reduce((acc, segment) => {
      const key = segment.confidence || "unknown";
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {}),
  };
}

function writeArchitectureTeachingDebugArtifact(options = {}, enrichedSegments = []) {
  if (!options.outputDir) return;

  const debugPath = path.join(
    options.outputDir,
    "architecture-teaching-enrichment.json"
  );

  const payload = {
    schemaVersion: "architecture-teaching-enrichment-debug-v1",
    generatedAt: new Date().toISOString(),
    segments: enrichedSegments.map((segment) => ({
      segmentId: segment.sourceSegmentId || segment.id,
      from: segment.from?.name || null,
      to: segment.to?.name || null,
      documentSays: segment.documentSays,
      glossaryMatches: segment.glossaryMatches || [],
      llmUsed: segment.llmUsed,
      llmValid: segment.llmValid,
      fallbackUsed: segment.fallbackUsed,
      enrichment: {
        plainEnglish: segment.plainEnglish,
        safeSemantics: segment.safeSemantics,
        whyItMatters: segment.whyItMatters,
        memoryHook: segment.memoryHook,
      },
    })),
  };

  fs.mkdirSync(options.outputDir, { recursive: true });
  fs.writeFileSync(debugPath, JSON.stringify(payload, null, 2), "utf8");
}

async function buildArchitectureTeaching(
  architectureUnderstanding = {},
  architectureFlow = {},
  options = {}
) {
  const evidenceIndex = buildEvidenceIndex(architectureUnderstanding);
  const glossaryIndex = buildGlossaryIndex(architectureUnderstanding);

    const preliminaryChapters = [];

    for (const [index, chapter] of asArray(architectureFlow.chapters).entries()) {
        preliminaryChapters.push(
        await enrichChapter(
            chapter,
            index,
            evidenceIndex,
            glossaryIndex,
            options.llmClient
        )
        );
    }

  const enrichedChapters = attachOverviewAndRecapContext(preliminaryChapters);
  const enrichedSegments = enrichedChapters.flatMap((chapter) =>
    asArray(chapter.enrichedSegments)
  );

  writeArchitectureTeachingDebugArtifact(options, enrichedSegments);

  return {
    schemaVersion: "architecture-teaching-v1-handoff-first",
    generatedAt: new Date().toISOString(),
    source: "architectureTeachingEnricher",

    strategy: {
      teachingUnit: "handoff_or_relationship_first",
      nodeRole: "supporting_context",
      enrichmentPolicy: "document_evidence_first_then_safe_generic_architecture_context",
      domainPolicy: "domain_independent_no_product_specific_logic",
      confidencePolicy:
        "strict_confidence_language_low_confidence_never_narrated_as_fact",
      ownership:
        "architectureTeaching owns meaning; lessonGraph owns order; dialogueGenerator owns wording.",
    },

    safetyPolicy: SAFETY_POLICY,
    confidenceLanguage: CONFIDENCE_LANGUAGE,

    enrichedSegments,
    enrichedChapters,

    teachingProgressionState: buildTeachingProgressionState(enrichedChapters),

    narrationGuidance: {
      globalRule:
        "Narration should explain operational meaning of documented handoffs, not read component labels.",
      useEvidenceFirst:
        "When evidenceSummary.hasDocumentExplanation is true, use that evidence before generic explanation.",
      avoid:
        SAFETY_POLICY.disallowedUnlessExplicitlyDocumented,
    },

    warnings: buildGlobalWarnings(
      architectureUnderstanding,
      architectureFlow,
      enrichedChapters
    ),

    stats: buildStats(enrichedChapters),

    debug: options.includeDebug
      ? {
          architectureFlowStats: architectureFlow.stats || null,
          architectureUnderstandingStats: architectureUnderstanding.stats || null,
        }
      : undefined,
  };
}

module.exports = {
  buildArchitectureTeaching,
  CONFIDENCE_LANGUAGE,
  SAFE_GENERIC_CONCEPTS,
  SAFETY_POLICY,
};
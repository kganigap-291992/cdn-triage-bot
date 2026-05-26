/**
 * calmExplainerNarrationBuilder.js
 *
 * BUG-22O.2
 *
 * Owns natural NotebookLM-style narration.
 *
 * Does:
 * - turn deterministic architectureTeaching into calm spoken narration
 * - preserve evidence/confidence boundaries
 * - reduce template-y engineering narration
 * - avoid fake podcast/Q&A energy
 *
 * Does NOT:
 * - invent architecture truth
 * - change traversal order
 * - decide camera/rendering
 * - perform RCA
 */

const fs = require("fs");
const path = require("path");

const BUILDER_VERSION = "calm-explainer-narration-v1";

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function safeString(value) {
  return String(value || "").trim();
}

function compactText(value, maxLength = 700) {
  const text = safeString(value).replace(/\s+/g, " ");
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1).trim()}…`;
}

function getConfidencePrefix(confidenceLanguage = {}, confidence = "unknown") {
  if (confidenceLanguage?.canNarrateAsFact === false) {
    return "The evidence is limited here, so";
  }

  if (confidence === "medium") {
    return "Based on the documented flow,";
  }

  return "";
}

function getSegmentNames(segment = {}) {
  return {
    fromName: segment.from?.name || "the previous part of the system",
    toName: segment.to?.name || "the next part of the system",
  };
}

function getConceptLabel(segment = {}) {
  return (
    segment.teachingContext?.conceptLabel ||
    segment.genericConcept ||
    "architecture handoff"
  );
}

function buildCalmNarrationFallback(segment = {}, index = 0) {
  const confidence = segment.confidence || "unknown";
  const confidencePrefix = getConfidencePrefix(
    segment.confidenceLanguage,
    confidence
  );

  const { fromName, toName } = getSegmentNames(segment);
  const conceptLabel = getConceptLabel(segment);
  const safeSemantics = safeString(segment.safeSemantics);
  const whyItMatters = safeString(segment.whyItMatters);

  const concept = safeString(segment.genericConcept);

  const narrationByConcept = {
    ingress_boundary:
      "The useful thing to notice is that the system is starting to take responsibility for incoming activity.",

    routing_control:
      "The useful thing to notice is that this part is organizing where work should go next, before anything deeper can handle it.",

    validation_checkpoint:
      "The useful thing to notice is that the request is being checked before downstream parts of the system take over.",

    processing_transform:
      "The useful thing to notice is that the walkthrough is moving from coordination into the part of the system that does the work.",

    persistence_state:
      "The useful thing to notice is that the architecture is reaching the durable side of the system, where state or longer-lived information lives.",

    fanout_distribution:
      "The useful thing to notice is that the documented path starts opening into more than one downstream direction.",

    generic_handoff:
      "The useful thing to notice is the responsibility shift between these two documented parts of the system.",
  };

  const base =
    narrationByConcept[concept] ||
    narrationByConcept.generic_handoff;

  if (confidencePrefix) {
    return compactText(`${confidencePrefix} ${base.charAt(0).toLowerCase()}${base.slice(1)}`);
  }

  return compactText(base || safeSemantics || whyItMatters || `${fromName} connects to ${toName} as a documented ${conceptLabel}.`);
}

function buildSegmentNarrationInput(segment = {}, index = 0) {
  const { fromName, toName } = getSegmentNames(segment);

  return {
    segmentId: segment.id || `segment_${index + 1}`,
    index,
    fromName,
    toName,
    confidence: segment.confidence || "unknown",
    canNarrateAsFact: Boolean(segment.canNarrateAsFact),
    documentSays: safeString(segment.documentSays),
    evidenceSummary: segment.evidenceSummary || null,
    genericConcept: segment.genericConcept || "generic_handoff",
    conceptLabel: getConceptLabel(segment),
    operationalMeaning: safeString(segment.teachingContext?.operationalMeaning),
    safeSemantics: safeString(segment.safeSemantics),
    whyItMatters: safeString(segment.whyItMatters),
    safetyFlags: asArray(segment.safetyFlags),
  };
}

function buildStyleContract() {
  return {
    version: "calm-explainer-style-contract-v1",
    targetStyle: "notebooklm_style_calm_explainer",
    voice: "single_primary_explainer",
    secondaryVoicePolicy: {
      allowed: true,
      frequency: "rare",
      maxShareOfScenes: 0.1,
      purpose: "brief_clarification_only",
      avoidQuestionSpam: true,
    },
    narrationRules: [
      "sound like a calm guided walkthrough",
      "avoid fake podcast banter",
      "avoid repeated question-answer framing",
      "avoid saying 'this is important' repeatedly",
      "avoid literal topology narration unless needed",
      "explain responsibility, not just arrows",
      "do not invent implementation details",
      "label uncertainty when confidence is not high",
    ],
    borrowedIdeas: [
      "NotebookLM calm explainer cadence",
      "RAGFlow evidence-grounded generation contract",
      "LlamaIndex source-bounded synthesis",
      "Motion Canvas narration beat rhythm",
    ],
  };
}

async function generateCalmNarrationWithLlm({
  input,
  llmClient,
  fallbackNarration,
}) {
  if (!llmClient) {
    return {
      narration: fallbackNarration,
      llmUsed: false,
      llmValid: false,
      fallbackUsed: true,
    };
  }

  try {
    const raw = await llmClient({
      task: "calm_explainer_narration",
      style: buildStyleContract(),
      input,
      requiredJsonShape: {
        narration: "string",
      },
    });

    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    const narration = compactText(parsed?.narration);

    if (!narration) {
      throw new Error("Missing narration");
    }

    return {
      narration,
      llmUsed: true,
      llmValid: true,
      fallbackUsed: false,
    };
  } catch {
    return {
      narration: fallbackNarration,
      llmUsed: true,
      llmValid: false,
      fallbackUsed: true,
    };
  }
}

async function buildCalmExplainerNarration({
  architectureTeaching = {},
  llmClient = null,
  outputDir = null,
} = {}) {
  const segments = asArray(architectureTeaching.enrichedSegments);

  const narratedSegments = [];

  for (const [index, segment] of segments.entries()) {
    const input = buildSegmentNarrationInput(segment, index);
    const fallbackNarration = buildCalmNarrationFallback(segment, index);

    const result = await generateCalmNarrationWithLlm({
      input,
      llmClient,
      fallbackNarration,
    });

    narratedSegments.push({
      segmentId: input.segmentId,
      index,
      fromName: input.fromName,
      toName: input.toName,
      confidence: input.confidence,
      canNarrateAsFact: input.canNarrateAsFact,
      genericConcept: input.genericConcept,
      conceptLabel: input.conceptLabel,
      documentSays: input.documentSays,
      narration: result.narration,
      llmUsed: result.llmUsed,
      llmValid: result.llmValid,
      fallbackUsed: result.fallbackUsed,
      safetyFlags: input.safetyFlags,
    });
  }

  const payload = {
    version: BUILDER_VERSION,
    source: "calmExplainerNarrationBuilder",
    purpose:
      "Produce NotebookLM-style calm explainer narration from deterministic architecture teaching facts.",
    styleContract: buildStyleContract(),
    segmentCount: narratedSegments.length,
    segments: narratedSegments,
    stats: {
      llmUsedCount: narratedSegments.filter((s) => s.llmUsed).length,
      llmValidCount: narratedSegments.filter((s) => s.llmValid).length,
      fallbackUsedCount: narratedSegments.filter((s) => s.fallbackUsed).length,
      narratableCount: narratedSegments.filter((s) => s.canNarrateAsFact).length,
    },
  };

  if (outputDir) {
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(
      path.join(outputDir, "calm-explainer-narration.json"),
      JSON.stringify(payload, null, 2),
      "utf8"
    );

    // Keep requested legacy/debug name too.
    fs.writeFileSync(
      path.join(outputDir, "mentor-narration.json"),
      JSON.stringify(payload, null, 2),
      "utf8"
    );
  }

  return payload;
}

module.exports = {
  buildCalmExplainerNarration,
  buildCalmNarrationFallback,
  buildStyleContract,
};
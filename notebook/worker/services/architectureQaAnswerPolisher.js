/**
 * architectureQaAnswerPolisher.js
 *
 * BUG-9G — LLM Answer Polish
 *
 * Owns:
 * - rewrite deterministic QA answer text into friendly explanation
 *
 * Does NOT:
 * - create facts
 * - change supporting facts
 * - classify questions
 * - mutate traversal
 */

const POLISHER_VERSION =
  "architecture-qa-answer-polisher-v1";

function safeString(value) {
  return String(value || "").trim();
}

function compactText(value, maxLength = 1200) {
  const text = safeString(value).replace(/\s+/g, " ");
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1).trim()}…`;
}

function buildFallbackPolishedAnswer(answer = {}) {
  return {
    ...answer,
    polishedAnswerText:
      answer.answerText || null,
    polish: {
      version: POLISHER_VERSION,
      llmUsed: false,
      llmValid: false,
      fallbackUsed: true,
      reason: "No LLM client provided.",
    },
  };
}

async function polishArchitectureQaAnswer({
  question = "",
  answer = {},
  classification = {},
  llmClient = null,
} = {}) {
  if (!answer.answered || !answer.answerText) {
    return {
      ...answer,
      polishedAnswerText:
        answer.answerText || null,
      polish: {
        version: POLISHER_VERSION,
        llmUsed: false,
        llmValid: false,
        fallbackUsed: false,
        reason: "Answer was not polishable.",
      },
    };
  }

  if (!llmClient) {
    return buildFallbackPolishedAnswer(answer);
  }

  try {
    const raw = await llmClient({
      task: "architecture_qa_answer_polish",
      style: {
        version: "architecture-qa-polish-style-v1",
        rules: [
          "Rewrite only the deterministic answerText into a clear user-facing answer.",
          "Do not add facts not present in answer.supportingFacts.",
          "Do not invent implementation behavior.",
          "Do not invent protocols, auth logic, cache behavior, database behavior, failover, scaling, or vendor details.",
          "Preserve source artifact meaning.",
          "Keep answer concise.",
          "If the answer says cannotAnswerReason, do not guess.",
        ],
      },
      input: {
        question,
        intent: classification.intent,
        answerText: answer.answerText,
        confidence: answer.confidence,
        supportingFacts: answer.supportingFacts,
        sourceArtifacts: answer.sourceArtifacts,
      },
      requiredJsonShape: {
        polishedAnswerText: "string",
      },
    });

    const parsed =
      typeof raw === "string"
        ? JSON.parse(raw)
        : raw;

    const polished =
      compactText(parsed?.polishedAnswerText);

    if (!polished || polished.length < 20) {
      throw new Error("Invalid polished answer");
    }

    return {
      ...answer,
      polishedAnswerText:
        polished,
      polish: {
        version: POLISHER_VERSION,
        llmUsed: true,
        llmValid: true,
        fallbackUsed: false,
      },
    };
  } catch {
    return {
      ...answer,
      polishedAnswerText:
        answer.answerText,
      polish: {
        version: POLISHER_VERSION,
        llmUsed: true,
        llmValid: false,
        fallbackUsed: true,
        reason:
          "LLM polish failed; deterministic answerText was preserved.",
      },
    };
  }
}

module.exports = {
  POLISHER_VERSION,
  polishArchitectureQaAnswer,
};
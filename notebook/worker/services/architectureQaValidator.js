/**
 * architectureQaValidator.js
 *
 * BUG-9F.2 / BUG-10E / BUG-11E — Architecture QA Validator
 *
 * Owns:
 * - validate deterministic Q&A answer objects before API response
 * - validate hop continuity metadata for journey-hop answers
 * - validate component continuity metadata for component-role answers
 *
 * Does NOT:
 * - classify questions
 * - build answers
 * - call LLM
 * - mutate traversal
 */

const VALIDATOR_VERSION =
  "architecture-qa-validator-v1";

const QA_VALIDATION_TYPES = {
  UNSUPPORTED_ANSWER:
    "unsupported_answer",

  MISSING_SOURCE_ARTIFACT:
    "missing_source_artifact",

  EMPTY_SUPPORTING_FACTS:
    "empty_supporting_facts",

  FORBIDDEN_TRAVERSAL_MUTATION:
    "forbidden_traversal_mutation",

  LOW_CONFIDENCE_ANSWERED:
    "low_confidence_answered",

  MISSING_HOP_CONTINUITY:
    "missing_hop_continuity",

  MISSING_COMPONENT_CONTINUITY:
    "missing_component_continuity",
};

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function validateJourneyHopContinuity({
  answer = {},
  violations = [],
} = {}) {
  if (
    answer.answered !== true ||
    answer.intent !== "journey_hops"
  ) {
    return;
  }

  const journeyHopFacts =
    asArray(answer.supportingFacts).filter(
      (fact) => fact.type === "journey_hops"
    );

  for (const fact of journeyHopFacts) {
    const hopIds = asArray(fact.hopIds);
    const hopContinuity =
      asArray(fact.hopContinuity);

    if (
      hopIds.length > 0 &&
      hopContinuity.length !== hopIds.length
    ) {
      violations.push({
        type:
          QA_VALIDATION_TYPES.MISSING_HOP_CONTINUITY,
        severity: "medium",
        reason:
          "Journey hops answer must include continuity metadata for each hop.",
      });
      continue;
    }

    const missingContinuity =
      hopContinuity.filter(
        (item) =>
          !item ||
          !item.hopId ||
          !item.status
      );

    if (missingContinuity.length > 0) {
      violations.push({
        type:
          QA_VALIDATION_TYPES.MISSING_HOP_CONTINUITY,
        severity: "medium",
        reason:
          "Journey hop continuity metadata must include hopId and status.",
      });
    }
  }
}

function validateComponentContinuity({
  answer = {},
  violations = [],
} = {}) {
  if (
    answer.answered !== true ||
    answer.intent !== "component_role"
  ) {
    return;
  }

  const componentRoleFacts =
    asArray(answer.supportingFacts).filter(
      (fact) => fact.type === "component_role"
    );

  for (const fact of componentRoleFacts) {
    const continuity =
      fact.componentContinuity;

    if (
      !continuity ||
      !continuity.status ||
      typeof continuity.alreadyExplained !== "boolean"
    ) {
      violations.push({
        type:
          QA_VALIDATION_TYPES.MISSING_COMPONENT_CONTINUITY,
        severity: "medium",
        reason:
          "Component role answer must include component continuity metadata.",
      });
    }
  }
}

function countByType(violations = [], type) {
  return violations.filter(
    (item) => item.type === type
  ).length;
}

function validateArchitectureQaAnswer({
  answer = {},
} = {}) {
  const violations = [];

  if (answer.answered === true) {
    if (!answer.answerText) {
      violations.push({
        type:
          QA_VALIDATION_TYPES.UNSUPPORTED_ANSWER,
        severity: "high",
        reason:
          "Answered QA response is missing answerText.",
      });
    }

    if (!asArray(answer.sourceArtifacts).length) {
      violations.push({
        type:
          QA_VALIDATION_TYPES.MISSING_SOURCE_ARTIFACT,
        severity: "high",
        reason:
          "Answered QA response has no source artifacts.",
      });
    }

    if (!asArray(answer.supportingFacts).length) {
      violations.push({
        type:
          QA_VALIDATION_TYPES.EMPTY_SUPPORTING_FACTS,
        severity: "medium",
        reason:
          "Answered QA response has no supporting facts.",
      });
    }

    if (answer.confidence === "low") {
      violations.push({
        type:
          QA_VALIDATION_TYPES.LOW_CONFIDENCE_ANSWERED,
        severity: "medium",
        reason:
          "Answered QA response should not be low confidence.",
      });
    }
  }

  validateJourneyHopContinuity({
    answer,
    violations,
  });

  validateComponentContinuity({
    answer,
    violations,
  });

  if (
    answer.traversalChanged === true ||
    answer.mutatedTraversal === true
  ) {
    violations.push({
      type:
        QA_VALIDATION_TYPES.FORBIDDEN_TRAVERSAL_MUTATION,
      severity: "high",
      reason:
        "Architecture Q&A must not mutate traversal.",
    });
  }

  return {
    version: VALIDATOR_VERSION,
    valid: violations.length === 0,
    violationCount: violations.length,
    violations,
    stats: {
      unsupportedAnswerCount:
        countByType(
          violations,
          QA_VALIDATION_TYPES.UNSUPPORTED_ANSWER
        ),

      missingSourceArtifactCount:
        countByType(
          violations,
          QA_VALIDATION_TYPES.MISSING_SOURCE_ARTIFACT
        ),

      emptySupportingFactsCount:
        countByType(
          violations,
          QA_VALIDATION_TYPES.EMPTY_SUPPORTING_FACTS
        ),

      forbiddenTraversalMutationCount:
        countByType(
          violations,
          QA_VALIDATION_TYPES.FORBIDDEN_TRAVERSAL_MUTATION
        ),

      lowConfidenceAnsweredCount:
        countByType(
          violations,
          QA_VALIDATION_TYPES.LOW_CONFIDENCE_ANSWERED
        ),

      missingHopContinuityCount:
        countByType(
          violations,
          QA_VALIDATION_TYPES.MISSING_HOP_CONTINUITY
        ),

      missingComponentContinuityCount:
        countByType(
          violations,
          QA_VALIDATION_TYPES.MISSING_COMPONENT_CONTINUITY
        ),
    },
  };
}

module.exports = {
  VALIDATOR_VERSION,
  QA_VALIDATION_TYPES,
  validateArchitectureQaAnswer,
};
/**
 * architectureQaContract.js
 *
 * BUG-9A — Enterprise Architecture Q&A Contract
 *
 * Owns:
 * - allowed architecture Q&A intents
 * - allowed answer scopes
 * - safety rules for enterprise architecture answers
 *
 * Does NOT:
 * - classify questions
 * - build answers
 * - call LLM
 * - mutate traversal
 */

const QA_CONTRACT_VERSION = "architecture-qa-contract-v1";

const QA_INTENTS = {
  JOURNEY_OVERVIEW: "journey_overview",
  JOURNEY_SUPPORT: "journey_support",
  JOURNEY_HOPS: "journey_hops",
  COMPONENT_ROLE: "component_role",
  SHARED_NODE: "shared_node",
  RESPONSIBILITY_HANDOFF: "responsibility_handoff",
  EVIDENCE_SUPPORT: "evidence_support",
  UNKNOWN: "unknown",
};

const QA_ALLOWED_SCOPES = [
  "journey identity",
  "rail membership",
  "hop membership",
  "component role",
  "shared node participation",
  "responsibility transition",
  "evidence-backed support",
];

const QA_FORBIDDEN_CLAIMS = [
  "invent internal component behavior",
  "invent protocols",
  "invent auth logic",
  "invent cache behavior",
  "invent database behavior",
  "invent failover behavior",
  "invent scaling behavior",
  "change traversal",
  "create hops",
  "create rails",
  "reclassify journeys with LLM",
];

const QA_REQUIRED_ARTIFACTS = [
  "journeyUnderstanding",
  "componentUnderstanding",
  "responsibilityUnderstanding",
  "sharedNodeUnderstanding",
  "multiRailUnderstanding",
  "architectureEvidence",
  "evidenceTeachingSupport",
];

function buildArchitectureQaContract() {
  return {
    version: QA_CONTRACT_VERSION,
    source: "architectureQaContract",

    purpose:
      "Define safe, deterministic enterprise architecture Q&A boundaries over existing cognition artifacts.",

    intents: QA_INTENTS,

    allowedScopes: QA_ALLOWED_SCOPES,

    forbiddenClaims: QA_FORBIDDEN_CLAIMS,

    requiredArtifacts: QA_REQUIRED_ARTIFACTS,

    rules: {
      traversalMutation: "forbidden",
      journeyRediscovery: "forbidden",
      llmFactCreation: "forbidden",
      deterministicFirst: true,
      unknownQuestionBehavior:
        "return cannotAnswerReason instead of guessing",
      evidenceBoundary:
        "answers must be grounded in supplied architecture artifacts",
    },
  };
}

module.exports = {
  QA_CONTRACT_VERSION,
  QA_INTENTS,
  QA_ALLOWED_SCOPES,
  QA_FORBIDDEN_CLAIMS,
  QA_REQUIRED_ARTIFACTS,
  buildArchitectureQaContract,
};
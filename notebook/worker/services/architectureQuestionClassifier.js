/**
 * architectureQuestionClassifier.js
 *
 * BUG-9C — Architecture Question Classifier
 *
 * Owns:
 * - deterministic question intent classification
 * - lightweight entity hints from user question
 *
 * Does NOT:
 * - answer questions
 * - call LLM
 * - mutate traversal
 */

const {
  QA_INTENTS,
} = require("./architectureQaContract");

const CLASSIFIER_VERSION =
  "architecture-question-classifier-v1";

function safeString(value) {
  return String(value || "").trim();
}

function normalizeText(value) {
  return safeString(value)
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function classifyArchitectureQuestion(question = "") {
  const text = normalizeText(question);

  if (!text) {
    return {
      version: CLASSIFIER_VERSION,
      intent: QA_INTENTS.UNKNOWN,
      confidence: "low",
      entities: {},
      reason: "No question text was provided.",
    };
  }

  if (
    /\bwhat supports\b|\bsupporting journeys?\b|\bsupporting rails?\b|\bsupports the request\b/.test(
        text
    )
    ) {
    return {
        version: CLASSIFIER_VERSION,
        intent: QA_INTENTS.JOURNEY_SUPPORT,
        confidence: "high",
        entities: {
        journeyType: text.includes("request")
            ? "request_journey"
            : inferJourneyType(text),
        },
        reason:
        "Question asks which rails or journeys support another journey.",
    };
    }

    if (
    /\bevidence\b|\bsource\b|\bwhy do we know\b|\bwhat supports (cdn|api|database|routing layer|application cluster|component)\b/.test(
        text
    )
    ) {
    return {
        version: CLASSIFIER_VERSION,
        intent: QA_INTENTS.EVIDENCE_SUPPORT,
        confidence: "medium",
        entities: {
        componentName: inferComponentName(question),
        },
        reason:
        "Question asks for evidence or source support.",
    };
    }

    if (
    /\bshared\b|\breused\b|\bacross rails\b|\bacross journeys\b/.test(
        text
    )
    ) {
    return {
      version: CLASSIFIER_VERSION,
      intent: QA_INTENTS.SHARED_NODE,
      confidence: "medium",
      entities: {},
      reason:
        "Question asks about shared or reused nodes.",
    };
  }

  if (
    /\bresponsibility\b|\bhandoff\b|\btransfer\b|\btransfers\b/.test(
      text
    )
  ) {
    return {
      version: CLASSIFIER_VERSION,
      intent: QA_INTENTS.RESPONSIBILITY_HANDOFF,
      confidence: "medium",
      entities: {},
      reason:
        "Question asks about responsibility or handoff transitions.",
    };
  }

  if (
    /\bwhat supports\b|\bsupporting journeys?\b|\bsupporting rails?\b|\bsupports the request\b/.test(
      text
    )
  ) {
    return {
      version: CLASSIFIER_VERSION,
      intent: QA_INTENTS.JOURNEY_SUPPORT,
      confidence: "high",
      entities: {
        journeyType: text.includes("request")
          ? "request_journey"
          : null,
      },
      reason:
        "Question asks which rails or journeys support another journey.",
    };
  }

  if (
    /\bhops?\b|\bsteps?\b|\bpath\b|\bsequence\b/.test(text) &&
    /\bjourney\b|\brail\b|\brequest\b|\bcontent\b|\bvalidation\b|\bcontrol\b|\bstate\b/.test(
      text
    )
  ) {
    return {
      version: CLASSIFIER_VERSION,
      intent: QA_INTENTS.JOURNEY_HOPS,
      confidence: "medium",
      entities: {
        journeyType: inferJourneyType(text),
      },
      reason:
        "Question asks about hops, steps, path, or sequence in a journey.",
    };
  }

  if (
    /\brole\b|\bwhat does\b|\bwhere does\b|\bcomponent\b|\bcdn\b|\bapi\b|\bdatabase\b|\brouting layer\b|\bapplication cluster\b/.test(
      text
    )
  ) {
    return {
      version: CLASSIFIER_VERSION,
      intent: QA_INTENTS.COMPONENT_ROLE,
      confidence: "medium",
      entities: {
        componentName: inferComponentName(question),
      },
      reason:
        "Question appears to ask about a component role or placement.",
    };
  }

  if (
    /\brequest journey\b|\bcontent delivery journey\b|\bvalidation journey\b|\bcontrol journey\b|\bstate journey\b|\bwhat is .*journey\b|\bexplain .*journey\b/.test(
      text
    )
  ) {
    return {
      version: CLASSIFIER_VERSION,
      intent: QA_INTENTS.JOURNEY_OVERVIEW,
      confidence: "medium",
      entities: {
        journeyType: inferJourneyType(text),
      },
      reason:
        "Question asks for a journey overview.",
    };
  }

  return {
    version: CLASSIFIER_VERSION,
    intent: QA_INTENTS.UNKNOWN,
    confidence: "low",
    entities: {},
    reason:
      "Question did not match a supported deterministic architecture Q&A intent.",
  };
}

function inferJourneyType(text = "") {
  const normalized = normalizeText(text);

  if (/\brequest\b/.test(normalized)) {
    return "request_journey";
  }

  if (/\bcontent\b|\bdelivery\b|\bcache\b|\bpayload\b/.test(normalized)) {
    return "content_delivery_journey";
  }

  if (/\bvalidation\b|\bauth\b|\bpolicy\b/.test(normalized)) {
    return "validation_journey";
  }

  if (/\bcontrol\b|\bconfig\b|\brouting\b/.test(normalized)) {
    return "control_journey";
  }

  if (/\bstate\b|\bdatabase\b|\bstorage\b|\bsync\b/.test(normalized)) {
    return "state_journey";
  }

  if (/\bobservability\b|\btelemetry\b|\bmetrics\b|\blogs\b/.test(normalized)) {
    return "observability_journey";
  }

  return null;
}

function inferComponentName(question = "") {
  const original = safeString(question);
  const text = normalizeText(question);

  const known = [
    "User Client",
    "CDN",
    "API",
    "Routing Layer",
    "Application Cluster",
    "Database",
  ];

  for (const name of known) {
    if (text.includes(name.toLowerCase())) {
      return name;
    }
  }

  const quoted =
    original.match(/["'`](.+?)["'`]/);

  return quoted ? quoted[1] : null;
}

module.exports = {
  CLASSIFIER_VERSION,
  classifyArchitectureQuestion,
  inferJourneyType,
  inferComponentName,
};
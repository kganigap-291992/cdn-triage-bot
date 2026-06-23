/**
 * architectureQuestionAnswerBuilder.js
 *
 * BUG-9D — Deterministic Architecture Answer Builder
 *
 * Owns:
 * - answer supported architecture Q&A intents from QA context
 * - return grounded answer objects
 *
 * Does NOT:
 * - call LLM
 * - invent missing facts
 * - mutate traversal
 */

const {
  QA_INTENTS,
} = require("./architectureQaContract");

const ANSWER_BUILDER_VERSION =
  "architecture-question-answer-builder-v1";

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function safeString(value) {
  return String(value || "").trim();
}

function titleCaseJourneyType(journeyType = "") {
  return safeString(journeyType)
    .replace(/_journey$/, "")
    .replace(/_/g, " ");
}

function getHopContinuity({
  qaContext = {},
  hopId,
} = {}) {
  return (
    qaContext.indexes?.hopContinuityByHopId?.[hopId] ||
    null
  );
}

function getComponentContinuity({
  qaContext = {},
  componentName,
} = {}) {
  const key = safeString(componentName)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

  return (
    qaContext.indexes?.componentContinuityByName?.[
      key
    ] || null
  );
}

function buildCannotAnswer({
  classification = {},
  reason = "The available architecture artifacts do not contain enough deterministic context to answer this question.",
} = {}) {
  return {
    version: ANSWER_BUILDER_VERSION,
    intent:
      classification.intent || QA_INTENTS.UNKNOWN,

    answered:
      false,

    answerText:
      null,

    supportingFacts:
      [],

    sourceArtifacts:
      [],

    confidence:
      "low",

    cannotAnswerReason:
      reason,
  };
}

function buildJourneySupportAnswer({
  qaContext = {},
  classification = {},
} = {}) {
  const journeyType =
    classification.entities?.journeyType ||
    "request_journey";

  const journey =
    qaContext.indexes?.journeysByType?.[journeyType];

  if (!journey) {
    return buildCannotAnswer({
      classification,
      reason:
        `No deterministic journey was found for ${journeyType}.`,
    });
  }

  const secondaryRails =
    asArray(journey.secondarySourceRailIds);

  if (!secondaryRails.length) {
    return {
      version: ANSWER_BUILDER_VERSION,
      intent: classification.intent,
      answered: true,
      answerText:
        `The ${titleCaseJourneyType(journeyType)} journey has no secondary supporting rails identified by the deterministic journey model.`,
      supportingFacts: [
        {
          type: "journey",
          journeyId: journey.journeyId,
          journeyType: journey.journeyType,
          sourceRailIds: journey.sourceRailIds || [],
          secondarySourceRailIds: [],
        },
      ],
      sourceArtifacts: [
        "journey-understanding.json",
      ],
      confidence: "medium",
      cannotAnswerReason: null,
    };
  }

  return {
    version: ANSWER_BUILDER_VERSION,
    intent: classification.intent,
    answered: true,
    answerText:
      `The ${titleCaseJourneyType(journeyType)} journey is primarily represented by ${asArray(journey.sourceRailIds).join(", ")}. It is also supported by ${secondaryRails.join(", ")}.`,
    supportingFacts: [
      {
        type: "journey",
        journeyId: journey.journeyId,
        journeyType: journey.journeyType,
        sourceRailIds: journey.sourceRailIds || [],
        secondarySourceRailIds:
          journey.secondarySourceRailIds || [],
        allRelatedRailIds:
          journey.allRelatedRailIds || [],
      },
    ],
    sourceArtifacts: [
      "journey-understanding.json",
    ],
    confidence: "high",
    cannotAnswerReason: null,
  };
}

function buildJourneyHopsAnswer({
  qaContext = {},
  classification = {},
} = {}) {
  const journeyType =
    classification.entities?.journeyType;

  if (!journeyType) {
    return buildCannotAnswer({
      classification,
      reason:
        "The question asks about journey hops, but no journey type could be identified.",
    });
  }

  const journey =
    qaContext.indexes?.journeysByType?.[journeyType];

  if (!journey) {
    return buildCannotAnswer({
      classification,
      reason:
        `No deterministic journey was found for ${journeyType}.`,
    });
  }

  const hopIds =
    asArray(journey.hopIds);

    const introducedCount =
    hopIds.filter(
        (hopId) =>
        getHopContinuity({
            qaContext,
            hopId,
        })?.alreadyExplained === true
    ).length;

    const continuityNote =
    introducedCount > 0
        ? ` ${introducedCount} of these hop(s) were already introduced earlier, so follow-up teaching should refer back instead of restarting them.`
        : "";

    return {
    version: ANSWER_BUILDER_VERSION,
    intent: classification.intent,
    answered: true,

    answerText:
        hopIds.length
        ? `The ${titleCaseJourneyType(journeyType)} journey includes these primary hops: ${hopIds.join(", ")}.${continuityNote}`
        : `The ${titleCaseJourneyType(journeyType)} journey was identified, but no primary hops were available in the journey artifact.`,

    supportingFacts: [
        {
        type: "journey_hops",

        journeyId:
            journey.journeyId,

        journeyType:
            journey.journeyType,

        hopIds,

        hopContinuity:
            hopIds.map((hopId) => {
            const continuity =
                getHopContinuity({
                qaContext,
                hopId,
                });

            return {
                hopId,

                status:
                continuity?.status ||
                "unknown",

                alreadyExplained:
                continuity?.alreadyExplained ||
                false,

                firstExplainedInRailTitle:
                continuity?.firstExplainedInRailTitle ||
                null,

                firstExplainedInJourneyType:
                continuity?.firstExplainedInJourneyType ||
                null,

                label:
                continuity?.label ||
                null,

                roleTransitionText:
                continuity?.roleTransitionText ||
                null,

                revisitGuidance:
                continuity?.revisitGuidance ||
                null,
            };
            }),

        secondaryHopIds:
            journey.secondaryHopIds || [],

        allRelatedHopIds:
            journey.allRelatedHopIds || [],
        },
    ],
    sourceArtifacts: [
      "journey-understanding.json",
    ],
    confidence:
      hopIds.length ? "high" : "medium",
    cannotAnswerReason:
      null,
  };
}

function buildComponentRoleAnswer({
  qaContext = {},
  classification = {},
} = {}) {
  const componentName =
    classification.entities?.componentName;

  if (!componentName) {
    return buildCannotAnswer({
      classification,
      reason:
        "The question appears to ask about a component, but no component name could be identified.",
    });
  }

  const key =
    componentName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "");

  const component =
    qaContext.indexes?.componentsByName?.[key];

  if (!component) {
    return buildCannotAnswer({
      classification,
      reason:
        `No deterministic component understanding was found for ${componentName}.`,
    });
  }

  const role =
    component.primaryJourneyRole ||
    component.journeyRole ||
    "unknown";

  const position =
    component.primaryJourneyPosition ||
    component.journeyPosition ||
    null;

  const componentMemory =
  getComponentContinuity({
    qaContext,
    componentName:
      component.componentName ||
      componentName,
  });  

  return {
    version: ANSWER_BUILDER_VERSION,
    intent: classification.intent,
    answered: true,
    answerText:
    componentMemory?.alreadyExplained
        ? position
        ? `${component.componentName || componentName} was already introduced in ${componentMemory.firstExplainedInJourneyType}. It is classified with the ${role} role around journey position ${position}.`
        : `${component.componentName || componentName} was already introduced in ${componentMemory.firstExplainedInJourneyType}. It is classified with the ${role} role.`
        : position
        ? `${component.componentName || componentName} is classified with the ${role} role around journey position ${position}.`
        : `${component.componentName || componentName} is classified with the ${role} role.`,
    supportingFacts: [
      {
        type: "component_role",
        componentName:
          component.componentName || componentName,
        role,
        position,
        knowledgeType:
          component.knowledgeType || "unknown",
        documentDefinition:
          component.documentDefinition || null,

        componentContinuity: {
        status:
            componentMemory?.status || "unknown",

        alreadyExplained:
            componentMemory?.alreadyExplained || false,

        firstExplainedInJourneyType:
            componentMemory?.firstExplainedInJourneyType ||
            null,

        firstExplainedInRailTitle:
            componentMemory?.firstExplainedInRailTitle ||
            null,

        revisitGuidance:
            componentMemory?.revisitGuidance ||
            null,
        },
      },
    ],
    sourceArtifacts: [
      "component-understanding.json",
    ],
    confidence:
      role !== "unknown" ? "high" : "medium",
    cannotAnswerReason:
      null,
  };
}

function buildSharedNodeAnswer({
  qaContext = {},
  classification = {},
} = {}) {
  const sharedNodes =
    Object.values(
      qaContext.indexes?.sharedNodesByName || {}
    ).filter(Boolean);

  const uniqueNodes =
    Array.from(
      new Map(
        sharedNodes.map((node) => [
          node.nodeName || node.nodeId,
          node,
        ])
      ).values()
    );

  if (!uniqueNodes.length) {
    return buildCannotAnswer({
      classification,
      reason:
        "No shared node understanding was available in the current architecture artifacts.",
    });
  }

  return {
    version: ANSWER_BUILDER_VERSION,
    intent: classification.intent,
    answered: true,
    answerText:
      `The deterministic shared-node model identified these shared nodes: ${uniqueNodes
        .map((node) => node.nodeName || node.nodeId)
        .filter(Boolean)
        .join(", ")}.`,
    supportingFacts:
      uniqueNodes.map((node) => ({
        type: "shared_node",
        nodeName:
          node.nodeName || null,
        nodeId:
          node.nodeId || null,
        classification:
          node.classification || null,
        participatingLaneTypes:
          node.participatingLaneTypes || [],
        railRoleProfiles:
          node.railRoleProfiles || [],
      })),
    sourceArtifacts: [
      "shared-node-understanding.json",
    ],
    confidence: "medium",
    cannotAnswerReason: null,
  };
}

function buildEvidenceSupportAnswer({
  qaContext = {},
  classification = {},
} = {}) {
  const componentName =
    classification.entities?.componentName;

  if (!componentName) {
    return buildCannotAnswer({
      classification,
      reason:
        "The question asks for evidence, but no component name or evidence target could be identified.",
    });
  }

  const needle =
    componentName.toLowerCase();

  const evidenceRecords =
    Object.values(
      qaContext.indexes?.evidenceById || {}
    ).filter((record) =>
      JSON.stringify(record)
        .toLowerCase()
        .includes(needle)
    );

  const teachingSupport =
    qaContext.artifacts?.evidenceTeachingSupport || {};

    const normalizeName = (value) =>
    safeString(value)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "");

    const targetKey =
    normalizeName(componentName);

    const teachingMatches =
    [
        ...asArray(teachingSupport.components),
        ...asArray(teachingSupport.handoffs),
        ...asArray(teachingSupport.artifacts),
    ].filter((item) => {
        const names = [
        item.subjectName,
        item.componentName,
        item.fromComponentName,
        item.toComponentName,
        item.artifactName,
        ]
        .map(normalizeName)
        .filter(Boolean);

        return names.includes(targetKey);
    });

    if (!evidenceRecords.length && !teachingMatches.length) {
    return buildCannotAnswer({
        classification,
        reason:
        `No deterministic evidence or teaching-support item mentioned ${componentName}.`,
    });
    }

    return {
    version: ANSWER_BUILDER_VERSION,
    intent: classification.intent,
    answered: true,
    answerText:
        `The architecture evidence contains ${evidenceRecords.length} raw record(s) and ${teachingMatches.length} teaching-support item(s) mentioning ${componentName}.`,
    supportingFacts: [
        ...evidenceRecords.slice(0, 5).map((record) => ({
        type: "raw_evidence",
        evidenceId:
            record.evidenceId || null,
        evidenceType:
            record.evidenceType ||
            record.normalizedType ||
            null,
        text:
            record.text ||
            record.rawText ||
            record.content ||
            null,
        })),
        ...teachingMatches.slice(0, 5).map((item) => ({
        type: "teaching_support",
        componentName:
            item.subjectName ||
            item.componentName ||
            null,
        hopId:
            item.hopId || null,
        supportedClaims:
            item.supportedClaims || [],
        supportedTeaching:
            item.supportedTeaching || [],
        evidenceIds:
            item.evidenceIds || [],
        text:
            item.teachingSentence ||
            item.summary ||
            item.whatChanged ||
            item.whyMatters ||
            null,
        })),
    ],
    sourceArtifacts: [
        "architecture-evidence.json",
        "evidence-teaching-support.json",
    ],
    confidence:
        teachingMatches.length ? "high" : "medium",
    cannotAnswerReason: null,
    };
}

function buildArchitectureQuestionAnswer({
  qaContext = {},
  classification = {},
} = {}) {
  switch (classification.intent) {
    case QA_INTENTS.JOURNEY_SUPPORT:
      return buildJourneySupportAnswer({
        qaContext,
        classification,
      });

    case QA_INTENTS.JOURNEY_HOPS:
      return buildJourneyHopsAnswer({
        qaContext,
        classification,
      });

    case QA_INTENTS.COMPONENT_ROLE:
      return buildComponentRoleAnswer({
        qaContext,
        classification,
      });

    case QA_INTENTS.SHARED_NODE:
      return buildSharedNodeAnswer({
        qaContext,
        classification,
      });

    case QA_INTENTS.EVIDENCE_SUPPORT:
      return buildEvidenceSupportAnswer({
        qaContext,
        classification,
      });

    default:
      return buildCannotAnswer({
        classification,
        reason:
          "This question intent is not yet supported by the deterministic architecture Q&A builder.",
      });
  }
}

module.exports = {
  ANSWER_BUILDER_VERSION,
  buildArchitectureQuestionAnswer,
};
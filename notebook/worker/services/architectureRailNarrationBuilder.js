// notebook/worker/services/architectureRailNarrationBuilder.js

/**
 * architectureRailNarrationBuilder.js
 *
 * BUG-22U.11C
 *
 * Owns rail-level mentor narration.
 *
 * Does:
 * - turn deterministic rail groups into natural senior-engineer narration
 * - preserve hop order, evidence, confidence, and safety boundaries
 * - produce fallback narration if LLM is unavailable/invalid
 *
 * Does NOT:
 * - decide traversal order
 * - create or remove hops
 * - infer architecture truth
 * - decide camera/rendering
 */

const fs = require("fs");
const path = require("path");

const {
  validateRailNarration,
} = require("./architectureNarrationValidator");

const BUILDER_VERSION = "architecture-rail-narration-v1";

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function safeString(value) {
  return String(value || "").trim();
}

function compactText(value, maxLength = 1400) {
  const text = safeString(value).replace(/\s+/g, " ");
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1).trim()}…`;
}

function compactList(items = [], limit = 8) {
  return Array.from(
    new Set(asArray(items).map(safeString).filter(Boolean))
  ).slice(0, limit);
}

function buildEvidenceClaimSentence(claims = []) {
  const allowed = asArray(claims);

    const claim = [
    "request_flow",
    "routing",
    "validation",
    "cache_delivery",
    "state",
    "processing",
    ].find((item) => allowed.includes(item));

  const text = {
    request_flow:
      "The document supports reading this hop as part of the primary request flow.",

    routing:
      "The document supports reading this hop as a routing or distribution step.",

    validation:
      "The document supports reading this hop as a validation or policy step.",

    cache_delivery:
      "The document supports reading this hop as a cache or payload delivery step.",

    state:
      "The document supports reading this hop as a state or persistence step.",

    processing:
      "The document supports reading this hop as a processing-stage step.",
  };

  return claim ? text[claim] : null;
}

function sanitizeForRailNarration(value) {
  return safeString(value)
    .replace(/\brequest originator\b/gi, "upstream side")
    .replace(/\brouting receiver\b/gi, "downstream side")
    .replace(/\bstate receiver\b/gi, "downstream side")
    .replace(/\bcontrol source\b/gi, "upstream side")
    .replace(/\bprocessing receiver\b/gi, "downstream side")
    .replace(/\bvalidation receiver\b/gi, "downstream side")
    .replace(/\bhelps? decide where traffic should go next\b/gi, "appears before the next documented stage")
    .replace(/\bdecide where traffic should go next\b/gi, "appear before the next documented stage")
    .replace(/\btraffic is directed appropriately\b/gi, "the documented flow continues in order")
    .replace(/\bdirected appropriately\b/gi, "shown in the documented order")
    .replace(/\bprevents? traffic from being sent blindly\b/gi, "keeps the explanation tied to the documented order")
    .replace(/\bdo the core work\b/gi, "appear after earlier stages")
    .replace(/\bcore work\b/gi, "later-stage position")
    .replace(/\bapplication or service processing\b/gi, "the next documented stage")
    .replace(/\bapplication\/service processing\b/gi, "the next documented stage")
    .replace(/\bdurable state, records, or stored results\b/gi, "a later documented stage")
    .replace(/\bimportant state\b/gi, "later documented context")
    .replace(/\bpreserve important state\b/gi, "preserve the documented journey context")
    .replace(/\bfacilitates?\b/gi, "supports")
    .replace(/\bentry responsibility\b/gi, "earlier documented stage")
    .replace(/\bunknown responsibility\b/gi, "next documented stage")
    .replace(/\bcontrol responsibility\b/gi, "middle documented stage")
    .replace(/\bprocessing responsibility\b/gi, "later documented stage")
    .replace(/\bstate responsibility\b/gi, "later documented stage")
    .replace(/\bstate management\b/gi, "later documented stage")
    .replace(/\brouting or control decisions?\b/gi, "the next documented stage")
    .replace(/\bcontrol decisions?\b/gi, "the next documented stage")
    .replace(/\bhandle the next steps?\b/gi, "continue the documented journey")
    .replace(
    /\bfacilitating further processing\b/gi,
    "before the next documented stage continues"
    )
    .replace(
    /\bfurther processing\b/gi,
    "the next documented stage"
    )
    .replace(/\binitiates? the process\b/gi, "appears at the start of the documented journey")
    .replace(/\bmoves? the request\b/gi, "continues the documented flow")
    .replace(/\bpasses? the request\b/gi, "continues the documented flow")
    .replace(/\btraffic\b/gi, "the documented flow")
    .replace(/\brequests?\b/gi, "the documented flow");
}

function formatRailPath(hops = []) {
  return asArray(hops)
    .map((hop, index) => {
      const from = safeString(hop?.from?.name);
      const to = safeString(hop?.to?.name);
      if (!from || !to) return null;
      return index === 0 ? `${from} → ${to}` : `→ ${to}`;
    })
    .filter(Boolean)
    .join(" ");
}


function normalizeKey(value) {
  return safeString(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function buildComponentContextLookup({
  componentUnderstanding = {},
  architectureIndustryKnowledge = {},
  whyHereTeaching = {},
} = {}) {
  const lookup = new Map();

  const componentIndex = new Map();

  for (const component of asArray(componentUnderstanding.components)) {
    componentIndex.set(
      normalizeKey(component.componentName),
      component
    );
  }

  const industryIndex = new Map();
  const whyHereIndex =
  buildWhyHereLookup(whyHereTeaching);

  for (const context of asArray(
    architectureIndustryKnowledge.contexts
  )) {
    industryIndex.set(
      normalizeKey(context.componentName),
      context
    );
  }

  for (const [key, component] of componentIndex.entries()) {
    lookup.set(key, {
    component,

    industryKnowledge:
        industryIndex.get(key) || null,

    whyHere:
        whyHereIndex.get(key) || null,
    });
  }

  return lookup;
}

function buildWhyHereLookup(whyHereTeaching = {}) {
  const lookup = new Map();

  for (const item of asArray(whyHereTeaching.components)) {
    if (item.componentName) {
      lookup.set(normalizeKey(item.componentName), item);
    }

    if (item.componentId) {
      lookup.set(normalizeKey(item.componentId), item);
    }
  }

  return lookup;
}

function buildHandoffTeachingLookup(
  evidenceTeachingSupport = {}
) {
  const lookup = new Map();

  for (const handoff of asArray(
    evidenceTeachingSupport.handoffs
  )) {
    lookup.set(handoff.hopId, handoff);
  }

  return lookup;
}


function buildResponsibilityLookup(
  responsibilityUnderstanding = {}
) {
  const lookup = new Map();

  for (const hop of asArray(
    responsibilityUnderstanding.hops
  )) {
    lookup.set(hop.hopId, hop);
  }

  return lookup;
}

function buildSharedNodeLookup(
  sharedNodeUnderstanding = {}
) {
  const lookup = new Map();

  for (const node of asArray(
    sharedNodeUnderstanding.nodes
  )) {
    if (node.nodeName) {
      lookup.set(
        normalizeKey(node.nodeName),
        node
      );
    }

    if (node.nodeId) {
      lookup.set(
        normalizeKey(node.nodeId),
        node
      );
    }
  }

  return lookup;
}

function buildMultiRailLookup(
  multiRailUnderstanding = {}
) {
  const lookup = new Map();

  for (const rail of asArray(
    multiRailUnderstanding.rails
  )) {
    if (rail.flowLaneId) {
      lookup.set(rail.flowLaneId, rail);
    }
  }

  return lookup;
}

function buildBidirectionalLookup(
  bidirectionalRailUnderstanding = {}
) {
  const lookup = new Map();

  for (const hop of asArray(
    bidirectionalRailUnderstanding.hopDirections
  )) {
    if (hop.hopId) {
      lookup.set(hop.hopId, hop);
    }
  }

  return lookup;
}

function buildJourneyLookup(journeyUnderstanding = {}) {
  const journeyByType = new Map();

  for (const journey of asArray(journeyUnderstanding.journeys)) {
    if (journey.journeyType) {
      journeyByType.set(journey.journeyType, journey);
    }
  }

  const lookup = new Map();

  for (const rail of asArray(journeyUnderstanding.rails)) {
    const primaryJourney =
      journeyByType.get(rail.primaryJourneyType) || null;

    const enrichedRail = {
      ...rail,

      primaryJourney:
        primaryJourney
          ? {
              journeyId: primaryJourney.journeyId,
              journeyType: primaryJourney.journeyType,
              sourceRailIds: primaryJourney.sourceRailIds || [],
              secondarySourceRailIds:
                primaryJourney.secondarySourceRailIds || [],
              allRelatedRailIds:
                primaryJourney.allRelatedRailIds || [],
              hopIds: primaryJourney.hopIds || [],
              secondaryHopIds:
                primaryJourney.secondaryHopIds || [],
              allRelatedHopIds:
                primaryJourney.allRelatedHopIds || [],
            }
          : null,
    };

    if (rail.railId) {
      lookup.set(rail.railId, enrichedRail);
    }

    if (rail.flowLaneId) {
      lookup.set(rail.flowLaneId, enrichedRail);
    }
  }

  return lookup;
}

function buildMultiRailInstruction(
  multiRailContext = {}
) {
  const relationship =
    safeString(
      multiRailContext.railRelationship
    );

  if (relationship === "primary") {
    return "This rail is the canonical/main walkthrough.";
    }

    if (relationship === "parallel") {
    return "This rail is taught alongside the canonical journey.";
    }

    if (relationship === "supports") {
    return "This rail supports the canonical journey and is not the primary walkthrough.";
    }

  return null;
}

function buildJourneyInstruction(
  journeyContext = {}
) {
  const primaryJourneyType =
    safeString(journeyContext.primaryJourneyType);

  const secondaryJourneyTypes =
    asArray(journeyContext.secondaryJourneyTypes);

  const supportsRequestJourney =
    journeyContext.enterpriseMembership
      ?.supportsRequestJourney === true ||
    secondaryJourneyTypes.includes("request_journey");

  if (primaryJourneyType === "request_journey") {
    return "This rail is part of the request journey.";
  }

  if (primaryJourneyType === "content_delivery_journey") {
    return supportsRequestJourney
      ? "This rail is a content delivery journey that also supports the broader request journey."
      : "This rail is a content delivery journey.";
  }

  if (primaryJourneyType === "validation_journey") {
    return "This rail is a validation journey that supports the broader request journey.";
  }

  if (primaryJourneyType === "control_journey") {
    return "This rail is a control journey that supports the broader request journey.";
  }

  if (primaryJourneyType === "state_journey") {
    return "This rail is a state journey that supports the broader request journey.";
  }

  if (primaryJourneyType === "observability_journey") {
    return "This rail is an observability journey that provides supporting operational context.";
  }

  if (primaryJourneyType === "retrieval_journey") {
    return "This rail is a retrieval journey.";
  }

  if (primaryJourneyType === "configuration_journey") {
    return "This rail is a configuration journey.";
  }

  if (primaryJourneyType === "replication_or_sync_journey") {
    return "This rail is a replication or synchronization journey using only documented direction context.";
  }

  if (primaryJourneyType === "unknown_journey") {
    return "A supporting journey was detected, but deterministic evidence is not strong enough to classify its purpose. Keep the teaching minimal.";
  }

  return null;
}

function buildDirectionInstruction(
  compactNarrationContext = []
) {
  const bidirectionalHop =
    asArray(compactNarrationContext).find(
      (hop) =>
        hop.directionContext
          ?.directionTeachingContext
          ?.teachingBoundary ===
        "observed_forward_reverse_possible"
    );

  if (!bidirectionalHop) return null;

  return [
    bidirectionalHop.directionContext
      .directionTeachingContext
      .forwardTeachingSentence,

    bidirectionalHop.directionContext
      .directionTeachingContext
      .reverseTeachingSentence,
  ]
    .filter(Boolean)
    .join(" ");
}


function buildArtifactHandoffLookup(
  artifactUnderstanding = {}
) {
  const lookup = new Map();

  for (const handoff of asArray(
    artifactUnderstanding.handoffArtifacts
  )) {
    lookup.set(handoff.hopId, handoff);
  }

  return lookup;
}

function resolveComponentContext(
  componentName,
  lookup
) {
  if (!componentName) return null;

  return (
    lookup.get(
      normalizeKey(componentName)
    ) || null
  );
}


function buildComponentTeachingContext(
  componentName,
  componentContext
) {
  if (!componentName) return null;

  const component = componentContext?.component || null;
  const industryKnowledge =
    componentContext?.industryKnowledge || null;

  const whyHere =
    componentContext?.whyHere || null;

  if (!component) {
    return {
      componentName,
      found: false,
      knowledgeType: "unknown",
      industryConcept: null,
      industryExplanation: null,
      journeyRole: "unknown",
      journeyPosition: null,
      safeToExplainIndustry: false,
      documentDefinition: null,
      safety: {
        canInferInternalBehavior: false,
      },
    };
  }

  return {
    componentName:
      component.componentName || componentName,

    found: true,

    knowledgeType:
      component.knowledgeType || "unknown",

    industryConcept:
      component.industryConcept || null,

    industryExplanation:
      industryKnowledge?.explanation || null,

    journeyRole:
      component.primaryJourneyRole || "unknown",

    journeyPosition:
      component.primaryJourneyPosition || null,

    safeToExplainIndustry:
      component.safety?.canExplainIndustryContext === true &&
      Boolean(industryKnowledge?.explanation),

    documentDefinition:
      component.documentDefinition || null,

    primaryRailContext:
      component.primaryRailContext || null,
    
    whyHere:
        whyHere?.whyHere || [],

    nextStageBenefit:
        whyHere?.nextStageBenefit || [],

    allowedEvidenceClaims:
        asArray(whyHere?.supportedClaims),


    safety: {
      canInferInternalBehavior:
        component.safety?.canInferInternalBehavior === true,

      requiresEvidenceForPrivateMeaning:
        component.safety?.requiresEvidenceForPrivateMeaning === true,

      industryContextAllowed:
        industryKnowledge?.industryContextAllowed === true,
    },
  };
}

function buildHopTeachingContext(
  hop,
  componentContextLookup
) {
  const fromContext =
    resolveComponentContext(
      hop.from,
      componentContextLookup
    );

  const toContext =
    resolveComponentContext(
      hop.to,
      componentContextLookup
    );

  return {
    hopId: hop.hopId,
    from:
      buildComponentTeachingContext(
        hop.from,
        fromContext
      ),
    to:
      buildComponentTeachingContext(
        hop.to,
        toContext
      ),
  };
}

function compactComponentNarrationContext(component = {}) {
  if (!component) return null;

  return {
    componentName:
      component.componentName || null,

    knowledgeType:
      component.knowledgeType || "unknown",

    documentDefinition:
      component.documentDefinition || null,

    whyHere:
      asArray(component.whyHere)
        .slice(0, 1)
        .map(sanitizeForRailNarration),

    nextStageBenefit:
      asArray(component.nextStageBenefit)
        .slice(0, 1)
        .map(sanitizeForRailNarration),

    safeToExplainIndustry:
      component.safeToExplainIndustry === true,

    canInferInternalBehavior:
      component.safety?.canInferInternalBehavior === true,
  };
}

function buildCompactNarrationContext(hopTeachingContext = []) {
  return asArray(hopTeachingContext).map((hop) => ({
    hopId: hop.hopId,

    from: compactComponentNarrationContext(hop.from),

    to: compactComponentNarrationContext(hop.to),

    responsibilityTransition:
        hop.responsibility
            ? {
                fromRole:
                    hop.responsibility.from?.responsibility?.role || null,

                toRole:
                    hop.responsibility.to?.responsibility?.role || null,

                handoffType:
                    hop.responsibility
                        ?.handoffResponsibility
                        ?.handoffType || null,

                roleTransitionText:
                    `${
                        hop.responsibility.from?.responsibility?.role || "unknown"
                    } → ${
                        hop.responsibility.to?.responsibility?.role || "unknown"
                    }`,

                teachingSentence:
                `Responsibility transfers from ${
                    hop.responsibility.from?.responsibility?.role || "one role"
                } to ${
                    hop.responsibility.to?.responsibility?.role || "the next role"
                } as a ${
                    hop.responsibility.handoffResponsibility?.handoffType || "handoff"
                }.`,
            }
            : null,

    sharedNodeHints: {
    from:
        hop.sharedNodeContext?.from
        ? {
            classification:
                hop.sharedNodeContext.from.classification,
            teachingHint:
                hop.sharedNodeContext.from.teachingHint,
            participatingLaneTypes:
                hop.sharedNodeContext.from.participatingLaneTypes,
            perHopRoles:
                hop.sharedNodeContext.from.perHopRoles,
            railRoleClassification:
                hop.sharedNodeContext.from.railRoleClassification,
            hasRailSpecificRoleDifference:
                hop.sharedNodeContext.from.hasRailSpecificRoleDifference,
            railRoleProfiles:
                hop.sharedNodeContext.from.railRoleProfiles,
            }
        : null,

    to:
        hop.sharedNodeContext?.to
        ? {
            classification:
                hop.sharedNodeContext.to.classification,
            teachingHint:
                hop.sharedNodeContext.to.teachingHint,
            participatingLaneTypes:
                hop.sharedNodeContext.to.participatingLaneTypes,
            perHopRoles:
                hop.sharedNodeContext.to.perHopRoles,
            railRoleClassification:
                hop.sharedNodeContext.to.railRoleClassification,
            hasRailSpecificRoleDifference:
                hop.sharedNodeContext.to.hasRailSpecificRoleDifference,
            railRoleProfiles:
                hop.sharedNodeContext.to.railRoleProfiles,
            }
        : null,
    },

directionContext:
  hop.directionContext
    ? {
        observedDirection:
          hop.directionContext.observedDirection,

        directionType:
          hop.directionContext.directionType,

        forwardTeachingFrame:
          hop.directionContext.forwardTeachingFrame,

        reverseTeachingFrame:
          hop.directionContext.reverseTeachingFrame,

        directionTeachingContext:
          hop.directionContext.directionTeachingContext,
      }
    : null,

allowedEvidenceClaims:
  compactList(
    asArray(hop.handoffTeaching?.supportedClaims),
    8
  ),

    artifactTeachingHints:
      asArray(hop.artifactTeaching?.artifacts)
        .slice(0, 2)
        .map((artifact) => ({
          artifactName: artifact.artifactName,
          artifactType: artifact.artifactClass,
          meaning: artifact.meaning || null,
          teachingSentence:
            `The document identifies ${artifact.artifactName} as a ${artifact.artifactClass} artifact associated with this handoff.`,
        })),

    railTeachingHints: {
      placement:
        hop.responsibility
            ? compactText(
                `Responsibility transfers from ${
                hop.responsibility.from?.responsibility?.role || "one role"
                } to ${
                hop.responsibility.to?.responsibility?.role || "the next role"
                }.`,
              220
            )
          : compactText(
              `${hop.from?.componentName || "This stage"} connects to ${
                hop.to?.componentName || "the next stage"
              } in the documented journey.`,
              220
            ),

      progression:
        `${hop.from?.componentName || "This stage"} → ${hop.to?.componentName || "next stage"}`,

      handoffMeaning:
        hop.responsibility
          ? compactText(
              `${
                hop.responsibility.handoffResponsibility?.handoffType || "handoff"
              }: ${
                hop.responsibility.from?.responsibility?.role || "upstream"
              } → ${
                hop.responsibility.to?.responsibility?.role || "downstream"
              }`,
              220
            )
          : compactText(
              `${hop.from?.componentName || "This stage"} connects to ${
                hop.to?.componentName || "the next stage"
              } in the documented journey.`,
              220
            ),

      allowedTeachingClaims:
        compactList(
          asArray(hop.handoffTeaching?.supportedClaims),
          8
        ),

      evidenceClaimSentence:
        buildEvidenceClaimSentence(
          hop.handoffTeaching?.supportedClaims
        ),
    },
  }));
}

function buildSharedNodeNarrationHints(
  compactNarrationContext = []
) {
  return asArray(compactNarrationContext)
    .flatMap((hop) => [
      {
        side: "from",
        componentName: hop.from?.componentName,
        hint: hop.sharedNodeHints?.from,
      },
      {
        side: "to",
        componentName: hop.to?.componentName,
        hint: hop.sharedNodeHints?.to,
      },
    ])
    .filter(
      (item) =>
        item.componentName &&
        item.hint &&
        item.hint.classification !== "single_role_shared"
    )
    .filter(
      (item, index, list) =>
        list.findIndex(
          (other) =>
            other.componentName === item.componentName
        ) === index
    )
    .slice(0, 4)
    .map((item) => ({
    componentName: item.componentName,
    classification: item.hint.classification,

    railRoleClassification:
        item.hint.railRoleClassification || null,

    hasRailSpecificRoleDifference:
        item.hint.hasRailSpecificRoleDifference === true,

    teachingHint: item.hint.teachingHint,

    participatingLaneTypes:
        item.hint.participatingLaneTypes || [],

    perHopRoles:
        item.hint.perHopRoles || [],

    railRoleProfiles:
        item.hint.railRoleProfiles || [],
    }));
}

function buildRailNarrationInput(rail = {}, index = 0) {
  const hops = asArray(rail.hops).length
    ? asArray(rail.hops)
    : asArray(rail.selectedHops);

  return {
    railId:
      rail.id ||
      rail.flowLaneId ||
      `rail_${index + 1}`,

    index,

    title:
      safeString(rail.title) ||
      "Architecture rail",

    flowLaneId:
      rail.flowLaneId || null,

    flowLaneType: null,

    flowLaneLabel:
    rail.flowLaneType || null,

    primaryRailType:
      rail.primaryRailType || null,

    promotionReason:
      rail.promotionReason || null,

    pathText:
      safeString(rail.pathText) ||
      formatRailPath(hops),

    hopCount:
      hops.length,

    allowedNarrationScope: [
    "hop order",
    "component names",
    "architectural position",
    "ownership progression",
    ],

    disallowedInferences: [
    "cache behavior",
    "api processing behavior",
    "routing behavior",
    "application business logic",
    "database storage behavior",
    "synchronization behavior",
    ],  

    hops: hops.map((hop, hopIndex) => ({
      hopId: hop.hopId || `hop_${hopIndex + 1}`,
      canonicalOrder: hop.canonicalOrder ?? hopIndex + 1,
      from: hop.from?.name || null,
      to: hop.to?.name || null,
      flowLaneId: hop.flowLaneId || null,
      flowLaneType: null,
      flowLaneLabel:
        hop.flowLaneType || null,
      confidence: hop.confidence || rail.confidence || "unknown",
      evidenceTypes: asArray(hop.evidenceTypes),
      inferred: hop?.safety?.inferred === true,
    })),
  };
}

function buildRailNarrationFallback({
  rail = {},
  compactNarrationContext = [],
} = {}) {
  const title = safeString(rail.title) || "Architecture rail";
  const flowLaneType = safeString(rail.flowLaneType);
  const primaryRailType = safeString(rail.primaryRailType);
  const multiRailContext = rail.multiRailContext || {};

  const journeyContext = rail.journeyContext || {};
  const journeyInstruction =
    safeString(rail.journeyInstruction);

    const railRelationship =
    safeString(multiRailContext.railRelationship);

    const railRelationshipTeachingHint =
    safeString(multiRailContext.railRelationshipTeachingHint);

  const hops = asArray(rail.hops);
  const pathText = safeString(rail.pathText) || formatRailPath(hops);

  const intro =
    primaryRailType === "canonical_primary"
      ? `${title} is the main walkthrough path through the architecture.`
      : `${title} is a supporting walkthrough rail in the architecture.`;

  const laneContext = flowLaneType
    ? `It is classified as ${flowLaneType.replace(/_/g, " ")}.`
    : "";

  const multiRailStory =
  railRelationshipTeachingHint ||
  (
    railRelationship === "parallel"
      ? "This rail should be taught alongside the canonical journey."
      : railRelationship === "supports"
        ? "This rail provides supporting context for the canonical journey."
        : ""
  );

  const roles = Array.from(
    new Set(
      asArray(compactNarrationContext)
        .flatMap((hop) => [
          hop?.from?.journeyRole,
          hop?.to?.journeyRole,
        ])
        .filter((role) => role && role !== "unknown")
    )
  );

  const publicComponents = asArray(compactNarrationContext)
    .flatMap((hop) => [hop?.from, hop?.to])
    .filter(
      (component) =>
        component?.safeToExplainIndustry === true &&
        component?.componentName &&
        component?.journeyRole &&
        component.journeyRole !== "unknown"
        )
    .filter(
      (component, index, list) =>
        list.findIndex(
          (item) => item.componentName === component.componentName
        ) === index
    )
    .slice(0, 2);

  const internalComponents = asArray(compactNarrationContext)
    .flatMap((hop) => [hop?.from, hop?.to])
    .filter(
      (component) =>
        component?.knowledgeType === "internal_unresolved" &&
        component?.componentName &&
        component?.journeyRole &&
        component.journeyRole !== "unknown"
    )
    .filter(
      (component, index, list) =>
        list.findIndex(
          (item) => item.componentName === component.componentName
        ) === index
    )
    .slice(0, 2);

  const roleStory = roles.length
    ? `Read this as a journey through ${roles.join(", ")} responsibilities.`
    : "Read this as one coherent responsibility story, not as isolated arrows.";

  const publicStory = publicComponents.length
    ? `${publicComponents
        .map(
          (component) =>
            `${component.componentName} can be explained using general industry context in the ${component.journeyRole} part of the journey`
        )
        .join("; ")}.`
    : "";

  const internalStory = internalComponents.length
        ? `${internalComponents
            .map(
            (component) =>
                `${component.componentName} appears in the ${component.journeyRole} part of the journey, but the document does not define its internal behavior`
            )
            .join("; ")}.`
        : "";

    const whyHereItems = asArray(compactNarrationContext)
    .flatMap((hop) => [hop?.from, hop?.to])
    .filter(Boolean)
    .filter(
        (component, index, list) =>
        component.componentName &&
        list.findIndex(
            (item) =>
            item.componentName === component.componentName
        ) === index
    )
    .flatMap((component) =>
        asArray(component.whyHere)
        .slice(0, 1)
        .map(
            (why) =>
            `${component.componentName}: ${why}`
        )
    )
    .slice(0, 3);

    const whyHereStory =
    whyHereItems.length
        ? `Why these pieces appear here: ${whyHereItems.join(" ")}`
        : "";

    const responsibilityStory = asArray(compactNarrationContext)
    .map((hop) => {
        const transition = hop.responsibilityTransition;

        if (!transition?.fromRole || !transition?.toRole) {
        return null;
        }

        return `${transition.fromRole} → ${transition.toRole}`;
    })
    .filter(Boolean)
    .slice(0, 6)
    .join(", ");

    return compactText(
        [
            intro,
            pathText ? `The path is ${pathText}.` : "",
            laneContext,
            multiRailStory,
            journeyInstruction,
            roleStory,

            responsibilityStory
                ? `Responsibility progression: ${responsibilityStory}.`
                : "",

            whyHereStory,
        ]
                    .filter(Boolean)
            .join(" ")
        );
}

function buildRailStyleContract() {
  return {
    version: "architecture-rail-narration-style-contract-v1",
    targetStyle: "senior_engineer_architecture_walkthrough",
    voice: "single_primary_mentor",
    narrationRules: [
    "explain the rail as one coherent architecture journey",
    "preserve the exact hop order",
    "do not add, remove, or reorder hops",
    "use responsibilityTransition.teachingSentence as the preferred wording when present",
    "use responsibilityTransition.teachingSentence verbatim when available",
    "use input.hopResponsibilitySentences as the ordered backbone of the narration",
    "write exactly one responsibility sentence per supplied hop",
    "do not create additional responsibility transitions",
    "use input.multiRailContext when available",
    "use input.multiRailInstruction verbatim when present",
    "use input.journeyInstruction verbatim when present",
    "use input.journeyContext to identify the rail's journey type",
    "describe request_journey as the request journey",
    "describe content_delivery_journey as a content delivery journey",
    "describe validation_journey as a validation journey, not as content delivery",
    "describe control_journey as a control journey, not as content delivery",
    "describe state_journey as a state journey, not as the primary request journey",
    "if secondaryJourneyTypes includes request_journey, explain that the rail supports the broader request journey",
    "do not describe every rail as the request journey",
    "do not use allRelatedHopIds to create extra hops or extra transitions",
    "if railRelationship is primary, describe it as the main walkthrough",
    "if railRelationship is parallel, describe it as a rail taught alongside the canonical journey",
    "if railRelationship is supports, describe it as supporting context rather than the primary journey",
    "do not describe supporting rails as the canonical walkthrough",
    "do not repeat a hop unless it appears multiple times in input.hops",
    "each responsibility sentence must correspond to one supplied hopId",
    "use sharedNodeNarrationHints only as cautionary context",
    "for shared nodes, describe the role in this handoff instead of assuming one global behavior",
    "mention each shared node at most once in the rail narration",
    "do not expand shared-node hints into extra hops or extra transitions",
    "describe handoffs as role transitions such as entry to processing, processing to delivery, or delivery to entry",
    "when describing a responsibility transition, the words before and after 'from' and 'to' refer to roles, not component names",
    "do not write phrases such as 'from CDN to unknown' or 'from API to control'",
    "component movement and role transition must be described separately",
    "use responsibilityTransition.roleTransitionText when explaining responsibility progression",
    "avoid saying only appears before or appears after when responsibilityTransition is available",
    "never say a component appears before itself",
    "if sharedNodeNarrationHints has railRoleClassification multi_rail_same_role, it is safe to say the component appears across rails with the same detected role",
    "if sharedNodeNarrationHints has railRoleClassification multi_rail_different_role, explain that the component role depends on the current rail or handoff",
    "never use railRoleProfiles to create extra hops or extra role transitions",
    "current hop responsibilityTransition remains the source of truth for narration",
    "explain responsibility transitions, not isolated arrows",
    "do not invent protocols, auth behavior, cache behavior, retries, failover, replication, autoscaling, encryption, or vendor-specific details",
    "use cautious language when confidence is limited",
    "avoid repeated phrases like documented handoff, responsibility shift, or flow moves",
    "sound natural and calm, not corporate or preachy",
    "responsibility belongs to roles, never component names",
    "do not write phrases like 'CDN transfers responsibility' or 'API transfers responsibility'",
    "components participate in handoffs, roles receive responsibility",
    ],
    borrowedIdeas: [
      "NotebookLM chapter-level explanation",
      "OpenTelemetry trace-level narration",
      "RAGFlow evidence-bounded generation",
      "LlamaIndex source-grounded synthesis",
    ],
  };
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

function isValidRailNarration(value) {
  return Boolean(
    value &&
      typeof value.narration === "string" &&
      safeString(value.narration).length >= 40
  );
}

async function generateRailNarrationWithLlm({
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
      task: "rail_narration",
      style: buildRailStyleContract(),
      input,
      requiredJsonShape: {
        narration: "string",
      },
    });

    const parsed = parseJsonObject(raw);

    if (!isValidRailNarration(parsed)) {
      throw new Error("Invalid rail narration JSON");
    }

    const prefix = [
    input.multiRailInstruction,
    input.journeyInstruction,
    input.directionInstruction,
    ]
    .filter(Boolean)
    .join(" ");

    return {
    
    narration: compactText(
        `${prefix} ${parsed.narration}`,
        1800
        ),
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

async function buildArchitectureRailNarration({
  rails = [],
  llmClient = null,
  outputDir = null,
  componentUnderstanding = {},
  responsibilityUnderstanding = {},
  sharedNodeUnderstanding = {},
  multiRailUnderstanding = {},
    bidirectionalRailUnderstanding = {},
    journeyUnderstanding = {},
    architectureIndustryKnowledge = {},
  evidenceTeachingSupport = {},
  whyHereTeaching = {},
  artifactUnderstanding = {},
} = {}) {
  const railNarrations = [];

    const componentContextLookup =
    buildComponentContextLookup({
        componentUnderstanding,
        architectureIndustryKnowledge,
        whyHereTeaching,
    });

    const multiRailLookup =
    buildMultiRailLookup(
        multiRailUnderstanding
    );

    const bidirectionalLookup =
        buildBidirectionalLookup(
            bidirectionalRailUnderstanding
        );
    const journeyLookup =
        buildJourneyLookup(
            journeyUnderstanding
        );

    for (const [index, rail] of asArray(rails).entries()) {
    const input = buildRailNarrationInput(
    rail,
    index
    );

    const railUnderstanding =
    multiRailLookup.get(
        rail.flowLaneId
    ) || null;

    input.multiRailContext =
    railUnderstanding
        ? {
            railCategory:
            railUnderstanding.railCategory,

            railRelationship:
            railUnderstanding.railRelationship,

            relatedTo:
            railUnderstanding.relatedTo,

            railRelationshipTeachingHint:
            railUnderstanding.railRelationshipTeachingHint,

            primaryRailType:
            railUnderstanding.primaryRailType,
        }
        : null;

    input.multiRailInstruction =
        buildMultiRailInstruction(
            input.multiRailContext
        );

    const journeyRail =
        journeyLookup.get(rail.flowLaneId) ||
        journeyLookup.get(rail.id) ||
        null;

    input.journeyContext =
        journeyRail
            ? {
                primaryJourneyType:
                    journeyRail.primaryJourneyType,

                secondaryJourneyTypes:
                    journeyRail.secondaryJourneyTypes || [],

                teachingPurpose:
                    journeyRail.teachingPurpose || null,

                classificationSource:
                    journeyRail.classificationSource,

                traversalChanged:
                    journeyRail.traversalChanged === true,

                enterpriseMembership: {
                    supportsRequestJourney:
                        (journeyRail.secondaryJourneyTypes || []).includes(
                            "request_journey"
                        ),

                    hasSecondaryJourneys:
                        (journeyRail.secondaryJourneyTypes || []).length > 0,

                    sourceRailIds:
                        journeyRail.primaryJourney?.sourceRailIds || [],

                    secondarySourceRailIds:
                        journeyRail.primaryJourney?.secondarySourceRailIds || [],

                    allRelatedRailIds:
                        journeyRail.primaryJourney?.allRelatedRailIds || [],

                    primaryHopIds:
                        journeyRail.primaryJourney?.hopIds || [],

                    secondaryHopIds:
                        journeyRail.primaryJourney?.secondaryHopIds || [],

                    allRelatedHopIds:
                        journeyRail.primaryJourney?.allRelatedHopIds || [],
                },
            }
            : null;

    input.journeyInstruction =
        buildJourneyInstruction(
            input.journeyContext
        );

        const handoffTeachingLookup =
        buildHandoffTeachingLookup(
            evidenceTeachingSupport
        );

        const artifactHandoffLookup =
        buildArtifactHandoffLookup(
            artifactUnderstanding
        );

        const responsibilityLookup =
        buildResponsibilityLookup(
            responsibilityUnderstanding
        );

        const sharedNodeLookup =
        buildSharedNodeLookup(
            sharedNodeUnderstanding
        );

        input.hopTeachingContext = input.hops.map((hop) => {
        const baseContext = buildHopTeachingContext(
            hop,
            componentContextLookup
        );

        return {
            ...baseContext,

            sharedNodeContext: {
            from:
                sharedNodeLookup.get(
                normalizeKey(hop.from)
                ) || null,

            to:
                sharedNodeLookup.get(
                normalizeKey(hop.to)
                ) || null,
            },

            responsibility:
            responsibilityLookup.get(hop.hopId) || null,

            handoffTeaching:
            handoffTeachingLookup.get(hop.hopId) || null,

            artifactTeaching:
            artifactHandoffLookup.get(hop.hopId) || null,

            directionContext:
            bidirectionalLookup.get(
                hop.hopId
            ) || null,
        };
        });

        input.compactNarrationContext =
            buildCompactNarrationContext(
                input.hopTeachingContext
            );

            const journeyType =
            input.journeyContext?.primaryJourneyType;

            input.directionInstruction =
            (
                journeyType === "state_journey" ||
                journeyType === "replication_or_sync_journey"
            )
                ? buildDirectionInstruction(
                    input.compactNarrationContext
                )
                : null;

            input.sharedNodeNarrationHints =
            buildSharedNodeNarrationHints(
                input.compactNarrationContext
            );

            input.hopResponsibilitySentences =
            input.compactNarrationContext
                .map(
                (hop) =>
                    hop.responsibilityTransition
                    ?.teachingSentence
                )
                .filter(Boolean);

            const fallbackNarration = buildRailNarrationFallback({
            rail: {
                ...rail,
                multiRailContext:
                input.multiRailContext,

                journeyContext:
                input.journeyContext,

                journeyInstruction:
                input.journeyInstruction,
            },
            compactNarrationContext:
                input.compactNarrationContext,
            });

    const result = await generateRailNarrationWithLlm({
    input,
    llmClient,
    fallbackNarration,
    });

    let validation =
    validateRailNarration({
        narration: result.narration,
        railInput: input,
        compactNarrationContext:
        input.compactNarrationContext,
    });

    if (!validation.valid) {
        result.narration = fallbackNarration;
        result.llmValid = false;
        result.fallbackUsed = true;

        validation =
        validateRailNarration({
            narration: fallbackNarration,
            railInput: input,
            compactNarrationContext:
            input.compactNarrationContext,
        });
    }

    railNarrations.push({
      railId: input.railId,
      index,
      title: input.title,
      flowLaneId: input.flowLaneId,
      flowLaneType: input.flowLaneType,
      flowLaneLabel: input.flowLaneLabel,
      primaryRailType: input.primaryRailType,
        promotionReason: input.promotionReason,

        multiRailContext:
        input.multiRailContext,

        multiRailInstruction:
        input.multiRailInstruction,

        journeyContext:
        input.journeyContext,

        journeyInstruction:
        input.journeyInstruction,

        directionInstruction:
        input.directionInstruction,

        pathText: input.pathText,
      hopCount: input.hopCount,
      hopIds: input.hops.map((hop) => hop.hopId),

        hopTeachingContext:
            input.hopTeachingContext,

            compactNarrationContext:
            input.compactNarrationContext,

            sharedNodeNarrationHints:
            input.sharedNodeNarrationHints || [],

            hopResponsibilitySentences:
            input.hopResponsibilitySentences || [],

            narration: result.narration,

            validation,

            llmUsed: result.llmUsed,
            llmValid: result.llmValid,
            fallbackUsed: result.fallbackUsed,
    });
  }

  const payload = {
    version: BUILDER_VERSION,
    source: "architectureRailNarrationBuilder",
    purpose:
      "Produce rail-level mentor narration from deterministic canonical traversal rails.",
    styleContract: buildRailStyleContract(),
    railCount: railNarrations.length,
    rails: railNarrations,
    stats: {
      llmUsedCount: railNarrations.filter((rail) => rail.llmUsed).length,
      llmValidCount: railNarrations.filter((rail) => rail.llmValid).length,
      fallbackUsedCount: railNarrations.filter((rail) => rail.fallbackUsed).length,
    },
  };

  if (outputDir) {
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(
      path.join(outputDir, "architecture-rail-narration.json"),
      JSON.stringify(payload, null, 2),
      "utf8"
    );
  }

  return payload;
}

module.exports = {
  BUILDER_VERSION,
  buildRailNarrationFallback,
  buildRailNarrationInput,
  buildRailStyleContract,
  generateRailNarrationWithLlm,
  buildArchitectureRailNarration,
};
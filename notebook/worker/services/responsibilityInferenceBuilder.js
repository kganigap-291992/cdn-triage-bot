// notebook/worker/services/responsibilityInferenceBuilder.js

const RESPONSIBILITY_ROLES = {
  INGRESS_BOUNDARY: "ingress_boundary",
  CACHE_OR_ACCELERATION: "cache_or_acceleration",
  VALIDATION_OR_POLICY: "validation_or_policy",
  ORCHESTRATION_OR_ROUTING: "orchestration_or_routing",
  PROCESSING_OR_EXECUTION: "processing_or_execution",
  PERSISTENCE_OR_STATE: "persistence_or_state",
  DISTRIBUTION_OR_FANOUT: "distribution_or_fanout",
  OBSERVABILITY_OR_CONTROL: "observability_or_control",
  TRANSFORMATION_OR_TRANSLATION:
    "transformation_or_translation",
  AGGREGATION_OR_COMPOSITION:
    "aggregation_or_composition",
  UNKNOWN_COMPONENT: "unknown_component",
};

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .trim();
}

function collectEvidence(entity = {}) {
  const evidence = [];

  if (entity.name) {
    evidence.push(entity.name);
  }

  if (entity.label) {
    evidence.push(entity.label);
  }

  if (Array.isArray(entity.evidence)) {
    for (const item of entity.evidence) {
      if (typeof item === "string") {
        evidence.push(item);
      }

      if (item?.text) {
        evidence.push(item.text);
      }
    }
  }

  if (Array.isArray(entity.aliases)) {
    evidence.push(...entity.aliases);
  }

  return evidence
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function scoreResponsibilityRole({
  entity,
  evidenceText,
  incomingCount,
  outgoingCount,
}) {
  const scores = {};

  const addScore = (role, value, reason) => {
    if (!scores[role]) {
      scores[role] = {
        score: 0,
        reasons: [],
      };
    }

    scores[role].score += value;

    if (reason) {
      scores[role].reasons.push(reason);
    }
  };


  const name = normalizeText(entity?.name);


  const role = normalizeText(entity?.role || entity?.structuralRole);

    if (
    role.includes("external_actor") ||
    name.includes("user client") ||
    name === "client" ||
    name === "user"
    ) {
    return {
        [RESPONSIBILITY_ROLES.UNKNOWN_COMPONENT]: {
        score: 0,
        reasons: ["external actor is outside system responsibility inference"],
        },
    };
    }

  // ingress / edge / boundary
  if (
    name.includes("edge") ||
    name.includes("ingress") ||
    name.includes("entry") ||
    name.includes("boundary") ||
    evidenceText.includes("incoming traffic")
  ) {
    addScore(
      RESPONSIBILITY_ROLES.INGRESS_BOUNDARY,
      4,
      "boundary-oriented naming or evidence"
    );
  }

  // cache / acceleration
  if (
    name.includes("cache") ||
    name.includes("cdn") ||
    evidenceText.includes("reduce downstream") ||
    evidenceText.includes("repeat work")
  ) {
    addScore(
      RESPONSIBILITY_ROLES.CACHE_OR_ACCELERATION,
      4,
      "acceleration-oriented naming or evidence"
    );
  }

  // validation / policy
  if (
    name.includes("auth") ||
    name.includes("policy") ||
    name.includes("gateway") ||
    evidenceText.includes("validation") ||
    evidenceText.includes("enforcement")
  ) {
    addScore(
      RESPONSIBILITY_ROLES.VALIDATION_OR_POLICY,
      4,
      "policy or validation signals"
    );
  }

  // orchestration / routing
    if (
    name.includes("router") ||
    name.includes("routing") ||
    name.includes("orchestr") ||
    outgoingCount >= 2 ||
    incomingCount >= 3
    ) {
    addScore(
        RESPONSIBILITY_ROLES.ORCHESTRATION_OR_ROUTING,
        4,
        "routing topology or orchestration signals"
    );
    }

  // processing / execution
    if (
    name.includes("worker") ||
    name.includes("processor") ||
    name.includes("engine") ||
    name.includes("service") ||
    name.includes("cluster")
    ) {
    addScore(
      RESPONSIBILITY_ROLES.PROCESSING_OR_EXECUTION,
      2,
      "processing-oriented naming"
    );
  }

  // persistence / state
  if (
    name.includes("db") ||
    name.includes("database") ||
    name.includes("store") ||
    name.includes("state")
  ) {
    addScore(
      RESPONSIBILITY_ROLES.PERSISTENCE_OR_STATE,
      5,
      "state or persistence signals"
    );
  }

  // observability / control
  if (
    name.includes("monitor") ||
    name.includes("metrics") ||
    name.includes("control") ||
    name.includes("telemetry")
  ) {
    addScore(
      RESPONSIBILITY_ROLES.OBSERVABILITY_OR_CONTROL,
      4,
      "control or telemetry signals"
    );
  }

  // transformation / translation
  if (
    name.includes("transform") ||
    name.includes("adapter") ||
    name.includes("translator")
  ) {
    addScore(
      RESPONSIBILITY_ROLES.TRANSFORMATION_OR_TRANSLATION,
      3,
      "transformation-oriented naming"
    );
  }

  // aggregation
  if (
    name.includes("aggregator") ||
    name.includes("composer") ||
    incomingCount >= 3
  ) {
    addScore(
      RESPONSIBILITY_ROLES.AGGREGATION_OR_COMPOSITION,
      2,
      "aggregation topology signals"
    );
  }

  return scores;
}

function selectBestRole(scores = {}) {
  const entries = Object.entries(scores);

  if (!entries.length) {
    return {
      role: RESPONSIBILITY_ROLES.UNKNOWN_COMPONENT,
      confidence: "unknown",
      reasons: [],
      score: 0,
    };
  }

  entries.sort((a, b) => b[1].score - a[1].score);

  const [role, metadata] = entries[0];

  if (metadata.score <= 0) {
    return {
        role: RESPONSIBILITY_ROLES.UNKNOWN_COMPONENT,
        confidence: "unknown",
        reasons: metadata.reasons || [],
        score: 0,
    };
    }

  let confidence = "low";

  if (metadata.score >= 7) {
    confidence = "high";
  } else if (metadata.score >= 4) {
    confidence = "medium";
  }

  return {
    role,
    confidence,
    reasons: metadata.reasons || [],
    score: metadata.score || 0,
  };
}

function buildRelationshipCounts(relationships = []) {
  const counts = {};

  for (const relationship of relationships) {
    const from =
        relationship?.sourceId ||
        relationship?.from ||
        relationship?.source ||
        relationship?.fromEntityId;

        const to =
        relationship?.targetId ||
        relationship?.to ||
        relationship?.target ||
        relationship?.toEntityId;

    if (from) {
      if (!counts[from]) {
        counts[from] = {
          incoming: 0,
          outgoing: 0,
        };
      }

      counts[from].outgoing += 1;
    }

    if (to) {
      if (!counts[to]) {
        counts[to] = {
          incoming: 0,
          outgoing: 0,
        };
      }

      counts[to].incoming += 1;
    }
  }

  return counts;
}


function buildSegmentResponsibilityExplanation(contextualRoles = {}) {
  const fromRole =
    contextualRoles.fromRoleInHandoff ||
    contextualRoles.sourceRole ||
    "unknown_contextual_role";

  const toRole =
    contextualRoles.toRoleInHandoff ||
    contextualRoles.targetRole ||
    "unknown_contextual_role";

  return `Responsibility moves from ${fromRole} toward ${toRole}.`;
}

function buildSegmentResponsibilities(relationships = []) {
  return relationships
    .filter((relationship) => relationship?.contextualRoles)
    .map((relationship) => {
      const contextualRoles = relationship.contextualRoles;

      return {
        relationshipId: relationship.id || null,

        from: {
          id: relationship.sourceId || null,
          name: relationship.sourceName || null,
        },

        to: {
          id: relationship.targetId || null,
          name: relationship.targetName || null,
        },

        handoffRole: contextualRoles.handoffRole || null,

        fromRoleInHandoff:
          contextualRoles.fromRoleInHandoff ||
          contextualRoles.sourceRole ||
          null,

        toRoleInHandoff:
          contextualRoles.toRoleInHandoff ||
          contextualRoles.targetRole ||
          null,

        confidence: contextualRoles.confidence || "unknown",

        interactionMode:
          contextualRoles.interactionMode ||
          relationship.interactionMode ||
          relationship.mappedInteractionMode ||
          null,

        flowPriority:
          contextualRoles.flowPriority ||
          relationship.flowPriority ||
          null,

        safeExplanation:
          buildSegmentResponsibilityExplanation(contextualRoles),

        roleEvidence:
          contextualRoles.roleEvidence || [],
      };
    });
}

function buildResponsibilityInference({
  architectureUnderstanding = {},
  architectureFlow = {},
  architectureTeaching = {},
  documentUnderstanding = {},
} = {}) {
  const entities = Array.isArray(
    architectureUnderstanding?.deterministicGraph?.components
    )
    ? architectureUnderstanding.deterministicGraph.components
    : Array.isArray(architectureUnderstanding?.components)
    ? architectureUnderstanding.components
    : Array.isArray(architectureUnderstanding?.entities)
    ? architectureUnderstanding.entities
    : [];

    const relationships = Array.isArray(
    architectureUnderstanding?.deterministicGraph?.relationships
    )
    ? architectureUnderstanding.deterministicGraph.relationships
    : Array.isArray(architectureUnderstanding?.relationships)
    ? architectureUnderstanding.relationships
    : [];

  const relationshipCounts =
    buildRelationshipCounts(relationships);

  const componentResponsibilities = [];
  const responsibilityMap = {};

  const segmentResponsibilities =
    buildSegmentResponsibilities(relationships);

  for (const entity of entities) {
    const entityId =
      entity.id ||
      entity.entityId ||
      entity.name;

    const relationshipMetrics =
      relationshipCounts[entityId] || {
        incoming: 0,
        outgoing: 0,
      };

    const evidenceText =
      collectEvidence(entity);

    const scores =
      scoreResponsibilityRole({
        entity,
        evidenceText,
        incomingCount:
          relationshipMetrics.incoming,
        outgoingCount:
          relationshipMetrics.outgoing,
      });

    const bestRole =
      selectBestRole(scores);

    const result = {
      entityId,
      entityName:
        entity.name ||
        entity.label ||
        entityId,

      responsibilityRole:
        bestRole.role,

      confidence:
        bestRole.confidence,

      score:
        bestRole.score,

      incomingCount:
        relationshipMetrics.incoming,

      outgoingCount:
        relationshipMetrics.outgoing,

      reasons:
        bestRole.reasons,

      safeExplanation:
        buildSafeExplanation(
          bestRole.role
        ),

      evidencePreview:
        evidenceText.slice(0, 240),
    };

    componentResponsibilities.push(
      result
    );

    responsibilityMap[entityId] =
      result;
  }

  return {
    version:
      "responsibility-inference-v1",

    componentResponsibilities,

    segmentResponsibilities,

    responsibilityMap,

    stats: {
      componentCount:
        componentResponsibilities.length,

      relationshipCount:
        relationships.length,

      segmentResponsibilityCount:
        segmentResponsibilities.length,
    },
  };
}

function buildSafeExplanation(role) {
  switch (role) {
    case RESPONSIBILITY_ROLES.INGRESS_BOUNDARY:
      return "This component appears positioned near the entry side of the system and likely manages how traffic first enters deeper flows.";

    case RESPONSIBILITY_ROLES.CACHE_OR_ACCELERATION:
      return "This component appears focused on reducing repeated downstream work and improving how traffic moves through the system.";

    case RESPONSIBILITY_ROLES.VALIDATION_OR_POLICY:
      return "This component appears to apply validation, policy, or governance behavior before traffic continues deeper.";

    case RESPONSIBILITY_ROLES.ORCHESTRATION_OR_ROUTING:
      return "This component appears to coordinate or route requests between multiple downstream paths.";

    case RESPONSIBILITY_ROLES.PROCESSING_OR_EXECUTION:
      return "This component appears responsible for executing or processing core system behavior.";

    case RESPONSIBILITY_ROLES.PERSISTENCE_OR_STATE:
      return "This component appears associated with state management or longer-lived system data.";

    case RESPONSIBILITY_ROLES.DISTRIBUTION_OR_FANOUT:
      return "This component appears to distribute work or coordinate multiple downstream destinations.";

    case RESPONSIBILITY_ROLES.OBSERVABILITY_OR_CONTROL:
      return "This component appears associated with visibility, monitoring, or operational control behavior.";

    case RESPONSIBILITY_ROLES.TRANSFORMATION_OR_TRANSLATION:
      return "This component appears to adapt, transform, or translate information between system boundaries.";

    case RESPONSIBILITY_ROLES.AGGREGATION_OR_COMPOSITION:
      return "This component appears to combine or organize information flowing from multiple sources.";

    default:
      return "The document does not provide enough evidence to confidently infer this component’s operational responsibility.";
  }
}

module.exports = {
  RESPONSIBILITY_ROLES,
  buildResponsibilityInference,
};
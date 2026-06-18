/**
 * responsibilityUnderstandingBuilder.js
 *
 * Owns responsibility understanding.
 *
 * Does:
 * - infer component-level default responsibility roles
 * - infer handoff-specific per-hop responsibility roles
 * - attach evidence ids / confidence / source text
 * - preserve traversal order without changing it
 *
 * Does NOT:
 * - choose traversal
 * - reorder hops
 * - call LLM
 * - narrate
 * - infer private implementation behavior
 */

const fs = require("fs");
const path = require("path");

const BUILDER_VERSION = "responsibility-understanding-v1";

const RESPONSIBILITY_ROLES = {
  ENTRY: "entry",
  CONTROL: "control",
  PROCESSING: "processing",
  STATE: "state",
  DELIVERY: "delivery",
  AUTH: "auth",
  OBSERVABILITY: "observability",
  UNKNOWN: "unknown",
};


const RESPONSIBILITY_ELIGIBLE_ARCHITECTURE_ROLES = new Set([
  "system_component",
  "external_actor",
  "interface",
  "data_store",
  "process_step",
]);

const RESPONSIBILITY_BLOCKED_ARCHITECTURE_ROLES = new Set([
  "data_object",
  "protocol_or_standard",
  "document_section",
  "configuration_or_value",
  "person_or_team",
  "unknown",
]);

const RESPONSIBILITY_NAME_BLOCKLIST = new Set([
  "glossary",
  "mpeg",
  "mpeg_transport_stream",
  "narration",
  "rail",
  "canonical",
  "component",
  "generic_service",
  "generic_service_",
  "dash_manifest",
  "dash_manifest_https",
]);


const ROLE_PRIORITY = {
  [RESPONSIBILITY_ROLES.ENTRY]: 100,
  [RESPONSIBILITY_ROLES.DELIVERY]: 90,
  [RESPONSIBILITY_ROLES.AUTH]: 80,
  [RESPONSIBILITY_ROLES.CONTROL]: 70,
  [RESPONSIBILITY_ROLES.PROCESSING]: 60,
  [RESPONSIBILITY_ROLES.STATE]: 50,
  [RESPONSIBILITY_ROLES.OBSERVABILITY]: 40,
  [RESPONSIBILITY_ROLES.UNKNOWN]: 1,
};

const ROLE_PATTERNS = [
  {
    role: RESPONSIBILITY_ROLES.AUTH,
    source: "responsibility_keyword_auth",
    pattern:
      /\b(auth|authentication|authorization|authorize|validates?|validation|verifies?|policy|token|credential|access check|permission)\b/i,
  },
  {
    role: RESPONSIBILITY_ROLES.CONTROL,
    source: "responsibility_keyword_control",
    pattern:
      /\b(gateway|router|routing|routes?|forwards?|distributes?|directs?|control|orchestrates?|load balancer|traffic director|dispatch)\b/i,
  },
  {
    role: RESPONSIBILITY_ROLES.STATE,
    source: "responsibility_keyword_state",
    pattern:
      /\b(database|db|store|stores?|stored|storage|persist|persists?|persistence|state|record|repository|cache)\b/i,
  },
  {
    role: RESPONSIBILITY_ROLES.OBSERVABILITY,
    source: "responsibility_keyword_observability",
    pattern:
      /\b(metric|metrics|telemetry|observability|monitoring|logs?|health|traces?|reports?|emits?|collects?)\b/i,
  },
  {
    role: RESPONSIBILITY_ROLES.DELIVERY,
    source: "responsibility_keyword_delivery",
    pattern:
      /\b(cdn|edge|origin|delivery|deliver|delivers|serves?|content|payload|asset|manifest|mpd|dash|hls|packag(?:e|es|ing))\b/i,
  },
  {
    role: RESPONSIBILITY_ROLES.PROCESSING,
    source: "responsibility_keyword_processing",
    pattern:
      /\b(app|application|service|processor|processing|worker|engine|cluster|transcoder|transcodes?|packager|packages?|generates?|creates?|prepares?|transforms?)\b/i,
  },
  {
    role: RESPONSIBILITY_ROLES.ENTRY,
    source: "responsibility_keyword_entry",
    pattern:
      /\b(user|client|browser|consumer|viewer|source|provider|external|ingress|entry|edge)\b/i,
  },
];

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function safeString(value) {
  return String(value || "").trim();
}

function normalizeKey(value) {
  return safeString(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function isResponsibilityCandidate(component = {}) {
  const name = component.componentName || component.name || component.label;
  const key = normalizeKey(name);

  if (!key) return false;

  if (RESPONSIBILITY_NAME_BLOCKLIST.has(key)) {
    return false;
  }

  const architectureRole = safeString(
    component.architectureRole || component.role
  );

  if (!architectureRole) {
    return false;
  }

  if (RESPONSIBILITY_BLOCKED_ARCHITECTURE_ROLES.has(architectureRole)) {
    return false;
  }

  return RESPONSIBILITY_ELIGIBLE_ARCHITECTURE_ROLES.has(architectureRole);
}

function classifyRoleFromComponentName(componentName = "") {
  const name = safeString(componentName);

  if (/\b(provider source|source|client|user|viewer|player app|external)\b/i.test(name)) {
    return {
      role: RESPONSIBILITY_ROLES.ENTRY,
      source: "component_name_entry",
      matchedText: name,
      confidence: "medium",
    };
  }

  if (/\b(delivery|cdn|edge|origin)\b/i.test(name)) {
    return {
      role: RESPONSIBILITY_ROLES.DELIVERY,
      source: "component_name_delivery",
      matchedText: name,
      confidence: "medium",
    };
  }

  if (/\b(auth|policy|token|validation)\b/i.test(name)) {
    return {
      role: RESPONSIBILITY_ROLES.AUTH,
      source: "component_name_auth",
      matchedText: name,
      confidence: "medium",
    };
  }

  if (/\b(gateway|router|routing|traffic director|controller)\b/i.test(name)) {
    return {
      role: RESPONSIBILITY_ROLES.CONTROL,
      source: "component_name_control",
      matchedText: name,
      confidence: "medium",
    };
  }

  if (/\b(transcoder|packager|processor|worker|application|app|cluster|engine)\b/i.test(name)) {
    return {
      role: RESPONSIBILITY_ROLES.PROCESSING,
      source: "component_name_processing",
      matchedText: name,
      confidence: "medium",
    };
  }

  if (/\b(database|db|store|storage|repository)\b/i.test(name)) {
    return {
      role: RESPONSIBILITY_ROLES.STATE,
      source: "component_name_state",
      matchedText: name,
      confidence: "medium",
    };
  }

  if (/\b(metric|telemetry|monitor|observability|log|health)\b/i.test(name)) {
    return {
      role: RESPONSIBILITY_ROLES.OBSERVABILITY,
      source: "component_name_observability",
      matchedText: name,
      confidence: "medium",
    };
  }

  return {
    role: RESPONSIBILITY_ROLES.UNKNOWN,
    source: "component_name_no_match",
    matchedText: name,
    confidence: "low",
  };
}

function inferRoleFromArchitectureRole(architectureRole = "") {
  const role = safeString(architectureRole);

  if (role === "external_actor") {
    return {
      role: RESPONSIBILITY_ROLES.ENTRY,
      source: "architecture_role_external_actor",
      confidence: "medium",
      matchedText: role,
    };
  }

  if (role === "data_store") {
    return {
      role: RESPONSIBILITY_ROLES.STATE,
      source: "architecture_role_data_store",
      confidence: "medium",
      matchedText: role,
    };
  }

  if (role === "process_step") {
    return {
      role: RESPONSIBILITY_ROLES.PROCESSING,
      source: "architecture_role_process_step",
      confidence: "medium",
      matchedText: role,
    };
  }

  if (role === "interface") {
    return {
      role: RESPONSIBILITY_ROLES.CONTROL,
      source: "architecture_role_interface",
      confidence: "low",
      matchedText: role,
    };
  }

  return {
    role: RESPONSIBILITY_ROLES.UNKNOWN,
    source: "architecture_role_no_match",
    confidence: "low",
    matchedText: role || null,
  };
}

function uniqueBy(items = [], keyFn) {
  const seen = new Set();
  const out = [];

  for (const item of items) {
    const key = keyFn(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }

  return out;
}

function getEvidenceText(record = {}) {
  return safeString(
    record.text ||
      record.content ||
      record.summary ||
      record.value ||
      record.label ||
      record.evidenceText ||
      ""
  );
}

function getRelationshipText(relationship = {}) {
  return safeString(
    relationship.evidenceText ||
      relationship.edgeLabel ||
      relationship.label ||
      relationship.operationalIntent ||
      relationship.semanticFlowType ||
      relationship.interactionMode ||
      relationship.reason ||
      ""
  );
}

function buildEvidenceIndex(architectureEvidence = {}) {
  const index = new Map();

  for (const record of asArray(architectureEvidence.evidenceRecords)) {
    const id = record.evidenceId || record.id;
    if (!id) continue;

    index.set(id, {
      evidenceId: id,
      text: getEvidenceText(record),
      type: record.type || record.evidenceType || null,
      source: record.source || null,
      page: record.page || null,
    });
  }

  return index;
}

function collectEvidenceTextByIds(evidenceIds = [], evidenceIndex = new Map()) {
  return asArray(evidenceIds)
    .map((id) => evidenceIndex.get(id))
    .filter(Boolean)
    .map((item) => item.text)
    .filter(Boolean)
    .join(" ");
}

function findComponentUnderstanding(componentName, componentUnderstanding = {}) {
  const key = normalizeKey(componentName);

  return asArray(componentUnderstanding.components).find(
    (component) =>
      normalizeKey(component.componentName) === key ||
      normalizeKey(component.normalizedName) === key ||
      normalizeKey(component.componentId) === key
  );
}

function findComponentFromArchitecture(componentName, architectureUnderstanding = {}) {
  const key = normalizeKey(componentName);

  return asArray(architectureUnderstanding?.deterministicGraph?.components).find(
    (component) =>
      normalizeKey(component.name) === key ||
      normalizeKey(component.id) === key
  );
}

function collectRelationshipsForComponent(componentName, architectureUnderstanding = {}) {
  const key = normalizeKey(componentName);

  return asArray(architectureUnderstanding?.deterministicGraph?.relationships).filter(
    (relationship) =>
      normalizeKey(relationship.sourceName) === key ||
      normalizeKey(relationship.targetName) === key ||
      normalizeKey(relationship.sourceId) === key ||
      normalizeKey(relationship.targetId) === key
  );
}

function findRelationshipForHop(hop = {}, architectureUnderstanding = {}) {
  if (hop.sourceRelationshipId) {
    const byId = asArray(
      architectureUnderstanding?.deterministicGraph?.relationships
    ).find((relationship) => relationship.id === hop.sourceRelationshipId);

    if (byId) return byId;
  }

  const fromKey = normalizeKey(hop?.from?.name || hop?.from?.id);
  const toKey = normalizeKey(hop?.to?.name || hop?.to?.id);

  return asArray(architectureUnderstanding?.deterministicGraph?.relationships).find(
    (relationship) => {
      const sourceMatches =
        normalizeKey(relationship.sourceName) === fromKey ||
        normalizeKey(relationship.sourceId) === fromKey;

      const targetMatches =
        normalizeKey(relationship.targetName) === toKey ||
        normalizeKey(relationship.targetId) === toKey;

      return sourceMatches && targetMatches;
    }
  );
}

function classifyRoleFromText(text = "") {
  const value = safeString(text);
  if (!value) {
    return {
      role: RESPONSIBILITY_ROLES.UNKNOWN,
      source: "no_evidence",
      matchedText: null,
      confidence: "low",
    };
  }

  for (const item of ROLE_PATTERNS) {
    if (item.pattern.test(value)) {
      return {
        role: item.role,
        source: item.source,
        matchedText: value.slice(0, 500),
        confidence: "medium",
      };
    }
  }

  return {
    role: RESPONSIBILITY_ROLES.UNKNOWN,
    source: "no_role_pattern_match",
    matchedText: value.slice(0, 500),
    confidence: "low",
  };
}

function normalizeExistingJourneyRole(role = "") {
  const value = safeString(role).toLowerCase();

  if (value === "validation") return RESPONSIBILITY_ROLES.AUTH;
  if (value === "configuration") return RESPONSIBILITY_ROLES.CONTROL;

  if (
    Object.values(RESPONSIBILITY_ROLES).includes(value)
  ) {
    return value;
  }

  return RESPONSIBILITY_ROLES.UNKNOWN;
}

function inferRoleFromFlowMetadata({
  flowLaneType,
  interactionMode,
  semanticFlowType,
  operationalIntent,
} = {}) {
  const text = [
    flowLaneType,
    interactionMode,
    semanticFlowType,
    operationalIntent,
  ]
    .filter(Boolean)
    .join(" ");

  return classifyRoleFromText(text);
}

function chooseBestRole(candidates = []) {
  const clean = asArray(candidates).filter(Boolean);

  if (!clean.length) {
    return {
      role: RESPONSIBILITY_ROLES.UNKNOWN,
      source: "no_candidates",
      confidence: "low",
      evidenceIds: [],
      evidenceText: [],
    };
  }

  function sourceRank(source = "") {
    if (safeString(source).startsWith("component_understanding_primary_journey_role")) return 50;
    if (safeString(source).startsWith("component_name_")) return 40;
    if (safeString(source).startsWith("hop_contextual_role")) return 35;
    if (safeString(source).startsWith("architecture_role_")) return 25;
    if (safeString(source).startsWith("relationship_metadata_")) return 15;
    if (safeString(source).startsWith("evidence_fallback_")) return 5;
    return 1;
    }

    const sorted = clean.sort((a, b) => {
    const sourceDelta = sourceRank(b.source) - sourceRank(a.source);
    if (sourceDelta !== 0) return sourceDelta;

    const confidenceRank = {
        high: 3,
        medium: 2,
        low: 1,
    };

    const confidenceDelta =
        (confidenceRank[b.confidence] || 0) -
        (confidenceRank[a.confidence] || 0);

    if (confidenceDelta !== 0) return confidenceDelta;

    return (ROLE_PRIORITY[b.role] || 0) - (ROLE_PRIORITY[a.role] || 0);
    });

  const best = sorted[0];

  return {
    role: best.role || RESPONSIBILITY_ROLES.UNKNOWN,
    source: best.source || "selected_best_candidate",
    confidence: best.confidence || "low",
    evidenceIds: uniqueBy(
      clean.flatMap((item) => asArray(item.evidenceIds)),
      (id) => id
    ),
    evidenceText: uniqueBy(
      clean.flatMap((item) => asArray(item.evidenceText || item.matchedText)),
      (text) => safeString(text).toLowerCase()
    )
      .filter(Boolean)
      .slice(0, 5),
  };
}

function inferGlobalRoleForComponent({
  component,
  componentUnderstanding = {},
  architectureUnderstanding = {},
  evidenceIndex = new Map(),
} = {}) {
  const componentName = component.componentName || component.name;
  const architectureComponent =
    findComponentFromArchitecture(componentName, architectureUnderstanding) || {};

  const understanding =
    findComponentUnderstanding(componentName, componentUnderstanding) || {};

  const relationships = collectRelationshipsForComponent(
    componentName,
    architectureUnderstanding
  );

  const relationshipEvidenceIds = relationships.flatMap((relationship) =>
    asArray(relationship.evidenceIds)
  );

  const evidenceText = [
    componentName,
    architectureComponent.role,
    understanding.documentDefinition,
    understanding.industryConcept,
    understanding.primaryJourneyRole,
    understanding.primaryRailContext?.flowLaneType,
    understanding.primaryRailContext?.journeyRole,
    collectEvidenceTextByIds(
      [
        ...asArray(architectureComponent.evidenceIds),
        ...relationshipEvidenceIds,
      ],
      evidenceIndex
    ),
    relationships.map(getRelationshipText).join(" "),
  ]
    .filter(Boolean)
    .join(" ");

  const explicitJourneyRole = normalizeExistingJourneyRole(
    understanding.primaryJourneyRole
  );

  const candidates = [];

    if (explicitJourneyRole !== RESPONSIBILITY_ROLES.UNKNOWN) {
    candidates.push({
        role: explicitJourneyRole,
        source: "component_understanding_primary_journey_role",
        confidence: "medium",
        evidenceIds: [
        ...asArray(architectureComponent.evidenceIds),
        ...relationshipEvidenceIds,
        ],
        evidenceText: [evidenceText.slice(0, 500)],
    });
    }

    const architectureRole = inferRoleFromArchitectureRole(
    architectureComponent.role
    );

    if (architectureRole.role !== RESPONSIBILITY_ROLES.UNKNOWN) {
    candidates.push({
        ...architectureRole,
        evidenceIds: asArray(architectureComponent.evidenceIds),
        evidenceText: [architectureRole.matchedText].filter(Boolean),
    });
    }

    const nameRole = classifyRoleFromComponentName(componentName);

    if (nameRole.role !== RESPONSIBILITY_ROLES.UNKNOWN) {
    candidates.push({
        ...nameRole,
        evidenceIds: asArray(architectureComponent.evidenceIds),
        evidenceText: [nameRole.matchedText].filter(Boolean),
    });
    }

    const relationshipMetadataRole = classifyRoleFromText(
    relationships
        .map((relationship) =>
        [
            relationship.semanticFlowType,
            relationship.operationalIntent,
            relationship.interactionMode,
            relationship.flowPriority,
            relationship.reason,
            getRelationshipText(relationship),
        ]
            .filter(Boolean)
            .join(" ")
        )
        .join(" ")
    );

    if (relationshipMetadataRole.role !== RESPONSIBILITY_ROLES.UNKNOWN) {
    candidates.push({
        ...relationshipMetadataRole,
        source: `relationship_metadata_${relationshipMetadataRole.source}`,
        evidenceIds: relationshipEvidenceIds,
        evidenceText: [relationshipMetadataRole.matchedText].filter(Boolean),
    });
    }

const evidenceFallbackRole = classifyRoleFromText(
  collectEvidenceTextByIds(
    [
      ...asArray(architectureComponent.evidenceIds),
      ...relationshipEvidenceIds,
    ],
    evidenceIndex
  )
);

if (evidenceFallbackRole.role !== RESPONSIBILITY_ROLES.UNKNOWN) {
  candidates.push({
    ...evidenceFallbackRole,
    source: `evidence_fallback_${evidenceFallbackRole.source}`,
    confidence: "low",
    evidenceIds: [
      ...asArray(architectureComponent.evidenceIds),
      ...relationshipEvidenceIds,
    ],
    evidenceText: [evidenceFallbackRole.matchedText].filter(Boolean),
  });
}

  const selected = chooseBestRole(candidates);

  return {
    componentId:
      component.componentId ||
      component.id ||
      architectureComponent.id ||
      normalizeKey(componentName),

    componentName,

    defaultRole: selected.role,
    roleSource: selected.source,
    confidence: selected.confidence,

    evidenceIds: selected.evidenceIds,
    evidenceText: selected.evidenceText,

    safety: {
      isDefaultOnly: true,
      perHopRoleWins: true,
      canInferPrivateImplementation: false,
    },
  };
}

function inferEndpointRoleForHop({
  hop = {},
  endpoint,
  relationship = {},
  componentUnderstanding = {},
  evidenceIndex = new Map(),
} = {}) {
  const endpointData = hop[endpoint] || {};
  const componentName = endpointData.name;

  const contextualRole =
    endpoint === "from"
      ? hop?.contextualRoles?.fromRoleInHandoff
      : hop?.contextualRoles?.toRoleInHandoff;

  const component =
    findComponentUnderstanding(componentName, componentUnderstanding) || {};

  const relationshipEvidenceText = collectEvidenceTextByIds(
    [
      ...asArray(hop.evidenceIds),
      ...asArray(relationship.evidenceIds),
    ],
    evidenceIndex
  );

  const flowRole = inferRoleFromFlowMetadata({
    flowLaneType: hop.flowLaneType || relationship.flowLaneType,
    interactionMode: hop.interactionMode || relationship.interactionMode,
    semanticFlowType: relationship.semanticFlowType,
    operationalIntent: relationship.operationalIntent,
  });

  const contextualRoleNormalized =
    normalizeExistingJourneyRole(contextualRole);

  const componentPrimaryRole =
    normalizeExistingJourneyRole(component.primaryJourneyRole);

  const text = [
    componentName,
    endpoint,
    contextualRole,
    endpointData.globalRole,
    component.documentDefinition,
    component.industryConcept,
    hop.flowLaneType,
    hop.interactionMode,
    hop.relationshipType,
    relationship.semanticFlowType,
    relationship.operationalIntent,
    relationship.reason,
    getRelationshipText(relationship),
    relationshipEvidenceText,
  ]
    .filter(Boolean)
    .join(" ");

  const textRole = classifyRoleFromText(text);

  const candidates = [];

  const nameRole = classifyRoleFromComponentName(componentName);

    if (nameRole.role !== RESPONSIBILITY_ROLES.UNKNOWN) {
        candidates.push({
            ...nameRole,
            evidenceIds: [
            ...asArray(hop.evidenceIds),
            ...asArray(relationship.evidenceIds),
            ],
            evidenceText: [nameRole.matchedText].filter(Boolean),
        });
    }

    if (contextualRoleNormalized !== RESPONSIBILITY_ROLES.UNKNOWN) {
        candidates.push({
        role: contextualRoleNormalized,
        source: "hop_contextual_role",
        confidence: "medium",
        evidenceIds: [
            ...asArray(hop.evidenceIds),
            ...asArray(relationship.evidenceIds),
        ],
        evidenceText: [text.slice(0, 500)],
        });
  }

  if (flowRole.role !== RESPONSIBILITY_ROLES.UNKNOWN) {
    candidates.push({
      ...flowRole,
      source: `flow_metadata_${flowRole.source}`,
      evidenceIds: [
        ...asArray(hop.evidenceIds),
        ...asArray(relationship.evidenceIds),
      ],
      evidenceText: [flowRole.matchedText].filter(Boolean),
    });
  }

  if (textRole.role !== RESPONSIBILITY_ROLES.UNKNOWN) {
    candidates.push({
      ...textRole,
      evidenceIds: [
        ...asArray(hop.evidenceIds),
        ...asArray(relationship.evidenceIds),
      ],
      evidenceText: [textRole.matchedText].filter(Boolean),
    });
  }

  if (componentPrimaryRole !== RESPONSIBILITY_ROLES.UNKNOWN) {
    candidates.push({
      role: componentPrimaryRole,
      source: "component_default_role_hint",
      confidence: "low",
      evidenceIds: [],
      evidenceText: [],
    });
  }

  const selected = chooseBestRole(candidates);

  return {
    componentId: endpointData.id || component.componentId || normalizeKey(componentName),
    componentName,

    endpoint,
    role: selected.role,
    roleSource: selected.source,
    confidence: selected.confidence,

    evidenceIds: selected.evidenceIds,
    evidenceText: selected.evidenceText,

    safety: {
      perHopRole: true,
      overridesGlobalRole: true,
      canInferPrivateImplementation: false,
    },
  };
}

function inferHandoffResponsibility({
  fromRole,
  toRole,
  hop = {},
  relationship = {},
} = {}) {
  const pair = `${fromRole.role}->${toRole.role}`;
  const text = [
    hop.flowLaneType,
    hop.interactionMode,
    relationship.semanticFlowType,
    relationship.operationalIntent,
    relationship.reason,
    getRelationshipText(relationship),
  ]
    .filter(Boolean)
    .join(" ");

  const evidenceIds = uniqueBy(
    [
      ...asArray(fromRole.evidenceIds),
      ...asArray(toRole.evidenceIds),
      ...asArray(hop.evidenceIds),
      ...asArray(relationship.evidenceIds),
    ],
    (id) => id
  );

  const handoffType = (() => {
    if (toRole.role === RESPONSIBILITY_ROLES.AUTH) return "auth_validation_handoff";
    if (toRole.role === RESPONSIBILITY_ROLES.CONTROL) return "control_handoff";
    if (toRole.role === RESPONSIBILITY_ROLES.PROCESSING) return "processing_handoff";
    if (toRole.role === RESPONSIBILITY_ROLES.STATE) return "state_handoff";
    if (toRole.role === RESPONSIBILITY_ROLES.DELIVERY) return "delivery_handoff";
    if (toRole.role === RESPONSIBILITY_ROLES.OBSERVABILITY) return "observability_handoff";
    if (fromRole.role === RESPONSIBILITY_ROLES.ENTRY) return "entry_handoff";

    if (
        fromRole.role === RESPONSIBILITY_ROLES.DELIVERY &&
        toRole.role === RESPONSIBILITY_ROLES.ENTRY
        ) {
        return "delivery_to_consumer_handoff";
        }

    const textRole = classifyRoleFromText(text);
    if (textRole.role !== RESPONSIBILITY_ROLES.UNKNOWN) {
      return `${textRole.role}_handoff`;
    }

    return "unknown_handoff";
  })();

  return {
    handoffType,
    rolePair: pair,
    confidence:
      fromRole.confidence === "medium" || toRole.confidence === "medium"
        ? "medium"
        : "low",
    evidenceIds,
    evidenceText: uniqueBy(
      [
        ...asArray(fromRole.evidenceText),
        ...asArray(toRole.evidenceText),
        getRelationshipText(relationship),
      ],
      (item) => safeString(item).toLowerCase()
    )
      .filter(Boolean)
      .slice(0, 5),
  };
}

function buildPerHopResponsibility({
  hop = {},
  index = 0,
  architectureUnderstanding = {},
  componentUnderstanding = {},
  evidenceIndex = new Map(),
} = {}) {
  const relationship = findRelationshipForHop(
    hop,
    architectureUnderstanding
  ) || {};

  const fromResponsibility = inferEndpointRoleForHop({
    hop,
    endpoint: "from",
    relationship,
    componentUnderstanding,
    evidenceIndex,
  });

  const toResponsibility = inferEndpointRoleForHop({
    hop,
    endpoint: "to",
    relationship,
    componentUnderstanding,
    evidenceIndex,
  });

  const handoffResponsibility = inferHandoffResponsibility({
    fromRole: fromResponsibility,
    toRole: toResponsibility,
    hop,
    relationship,
  });

  return {
    hopId: hop.hopId || `hop_${index + 1}`,
    canonicalOrder: hop.canonicalOrder ?? index + 1,
    flowLaneId: hop.flowLaneId || null,
    flowLaneType: hop.flowLaneType || null,

    from: {
      id: hop?.from?.id || null,
      name: hop?.from?.name || null,
      responsibility: fromResponsibility,
    },

    to: {
      id: hop?.to?.id || null,
      name: hop?.to?.name || null,
      responsibility: toResponsibility,
    },

    handoffResponsibility,

    relationship: {
      relationshipId:
        hop.sourceRelationshipId ||
        relationship.id ||
        null,
      relationshipType:
        hop.relationshipType ||
        relationship.type ||
        null,
      interactionMode:
        hop.interactionMode ||
        relationship.interactionMode ||
        null,
      evidenceIds: uniqueBy(
        [
          ...asArray(hop.evidenceIds),
          ...asArray(relationship.evidenceIds),
        ],
        (id) => id
      ),
    },

    safety: {
      traversalUnchanged: true,
      roleEnrichmentOnly: true,
      evidenceSupported:
        handoffResponsibility.evidenceIds.length > 0 ||
        fromResponsibility.roleSource !== "no_evidence" ||
        toResponsibility.roleSource !== "no_evidence",
    },
  };
}

function collectComponentCandidates({
  componentUnderstanding = {},
  architectureUnderstanding = {},
  canonicalTraversalRail = {},
} = {}) {
  const candidates = new Map();

  const architectureComponentIndex = new Map();

  for (const component of asArray(
    architectureUnderstanding?.deterministicGraph?.components
  )) {
    const key = normalizeKey(component.name || component.id);
    if (!key) continue;
    architectureComponentIndex.set(key, component);
  }

  function add(component = {}, options = {}) {
    const name = component.componentName || component.name || component.label;
    const key = normalizeKey(name);
    if (!key) return;

    const architectureComponent =
      architectureComponentIndex.get(key) || null;

    const candidate = {
      componentId:
        component.componentId ||
        component.id ||
        architectureComponent?.id ||
        key,

      componentName: safeString(name),

      architectureRole:
        architectureComponent?.role ||
        component.architectureRole ||
        component.role ||
        null,

      fromTraversal:
        options.fromTraversal === true,

      fromArchitectureGraph:
        Boolean(architectureComponent),
    };

    if (!candidate.fromTraversal && !isResponsibilityCandidate(candidate)) {
      return;
    }

    if (!candidates.has(key)) {
      candidates.set(key, candidate);
    }
  }

  for (const component of asArray(
    architectureUnderstanding?.deterministicGraph?.components
  )) {
    add(component);
  }

  for (const component of asArray(componentUnderstanding.components)) {
    add(component);
  }

  for (const hop of asArray(canonicalTraversalRail.hops)) {
    add(hop.from || {}, { fromTraversal: true });
    add(hop.to || {}, { fromTraversal: true });
  }

  return Array.from(candidates.values());
}

function buildResponsibilityUnderstanding({
  architectureUnderstanding = {},
  canonicalTraversalRail = {},
  componentUnderstanding = {},
  architectureEvidence = {},
  outputDir = null,
} = {}) {
  const evidenceIndex = buildEvidenceIndex(architectureEvidence);

  const componentCandidates = collectComponentCandidates({
    componentUnderstanding,
    architectureUnderstanding,
    canonicalTraversalRail,
  });

  const components = componentCandidates.map((component) =>
    inferGlobalRoleForComponent({
      component,
      componentUnderstanding,
      architectureUnderstanding,
      evidenceIndex,
    })
  );

  const hops = asArray(canonicalTraversalRail.hops).map((hop, index) =>
    buildPerHopResponsibility({
      hop,
      index,
      architectureUnderstanding,
      componentUnderstanding,
      evidenceIndex,
    })
  );

  const roleBreakdown = components.reduce((acc, component) => {
    acc[component.defaultRole] = (acc[component.defaultRole] || 0) + 1;
    return acc;
  }, {});

  const perHopRoleBreakdown = hops.reduce((acc, hop) => {
    for (const role of [
      hop.from.responsibility.role,
      hop.to.responsibility.role,
    ]) {
      acc[role] = (acc[role] || 0) + 1;
    }

    return acc;
  }, {});

  const payload = {
    version: BUILDER_VERSION,
    source: "responsibilityUnderstandingBuilder",
    purpose:
      "Infer global and per-hop architecture responsibility roles without changing traversal selection or rail ordering.",

    roleEnum: Object.values(RESPONSIBILITY_ROLES),

    rules: {
      globalRole: "component-level default role",
      perHopRole: "handoff-specific role; always wins during teaching and narration",
      traversalMutation: "forbidden",
      privateImplementationInference: "forbidden",
    },

    componentCount: components.length,
    hopCount: hops.length,

    components,
    hops,

    stats: {
      componentCount: components.length,
      hopCount: hops.length,

      knownGlobalRoleCount: components.filter(
        (component) => component.defaultRole !== RESPONSIBILITY_ROLES.UNKNOWN
      ).length,

      unknownGlobalRoleCount: components.filter(
        (component) => component.defaultRole === RESPONSIBILITY_ROLES.UNKNOWN
      ).length,

      evidenceBackedHopRoleCount: hops.filter(
        (hop) => hop.safety.evidenceSupported === true
      ).length,

      roleBreakdown,
      perHopRoleBreakdown,

      traversalChanged: false,
    },
  };

  if (outputDir) {
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(
      path.join(outputDir, "responsibility-understanding.json"),
      JSON.stringify(payload, null, 2),
      "utf8"
    );
  }

  return payload;
}

module.exports = {
  BUILDER_VERSION,
  RESPONSIBILITY_ROLES,
  buildResponsibilityUnderstanding,
};
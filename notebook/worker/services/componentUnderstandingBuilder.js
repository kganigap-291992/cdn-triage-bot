/**
 * componentUnderstandingBuilder.js
 *
 * BUG-22P.2A / 22P.2C
 *
 * Owns component understanding contract.
 *
 * Does:
 * - classify component names into safe teaching categories
 * - preserve document definitions from glossary / bullets / captions / parentheses
 * - decide whether industry expansion is allowed later
 * - attach rail-aware journey context for multi-rail teaching
 *
 * Does NOT:
 * - call LLM
 * - narrate
 * - choose traversal
 * - infer hidden internal behavior
 */

const fs = require("fs");
const path = require("path");

const BUILDER_VERSION = "component-understanding-v2-rail-aware";

const KNOWLEDGE_TYPES = {
  INDUSTRY_KNOWN: "industry_known",
  DOCUMENT_DEFINED: "document_defined",
  INTERNAL_UNRESOLVED: "internal_unresolved",
};

const DEFINITION_SOURCES = {
  PARENTHETICAL: "parenthetical",
  GLOSSARY: "glossary",
  EVIDENCE: "evidence",
  NONE: null,
};

const JOURNEY_ROLES = {
  ENTRY: "entry",
  VALIDATION: "validation",
  CONTROL: "control",
  PROCESSING: "processing",
  STATE: "state",
  DELIVERY: "delivery",
  OBSERVABILITY: "observability",
  CONFIGURATION: "configuration",
  UNKNOWN: "unknown",
};

const INDUSTRY_TERM_PATTERNS = [
  { pattern: /\bcdn\b/i, concept: "cdn" },
  { pattern: /\bnginx\b/i, concept: "nginx" },
  { pattern: /\bapi gateway\b/i, concept: "api_gateway" },
  { pattern: /\bapi\b/i, concept: "api" },
  { pattern: /\bgateway\b/i, concept: "gateway" },
  { pattern: /\bload balancer\b/i, concept: "load_balancer" },
  { pattern: /\bdatabase\b|\bdb\b/i, concept: "database" },
  { pattern: /\bdns\b/i, concept: "dns" },
  { pattern: /\bkafka\b/i, concept: "kafka" },
  { pattern: /\bredis\b/i, concept: "redis" },
  { pattern: /\bkubernetes\b|\bk8s\b/i, concept: "kubernetes" },
];

const PUBLIC_INDUSTRY_ACRONYMS = new Set([
  "api",
  "cdn",
  "db",
  "dns",
  "http",
  "https",
  "ip",
  "k8s",
  "sql",
  "tls",
]);

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

function isLikelyInternalName(name = "") {
  const value = safeString(name);
  if (!value) return false;

  const compact = value.replace(/[^A-Za-z0-9]/g, "");
  const lowerCompact = compact.toLowerCase();

  if (PUBLIC_INDUSTRY_ACRONYMS.has(lowerCompact)) {
    return false;
  }

  return (
    compact.length >= 3 &&
    compact.length <= 12 &&
    compact === compact.toUpperCase() &&
    /[A-Z]/.test(compact)
  );
}

function extractParentheticalDefinition(name = "") {
  const value = safeString(name);
  const match = value.match(/^(.+?)\s*\((.+?)\)\s*$/);

  if (!match) return null;

  const componentName = safeString(match[1]);
  const definition = safeString(match[2]);

  if (!componentName || !definition) return null;

  return {
    componentName,
    documentDefinition: definition,
    definitionSource: DEFINITION_SOURCES.PARENTHETICAL,
  };
}


function findIndustryConcept(value = "") {
  const text = safeString(value);

  for (const item of INDUSTRY_TERM_PATTERNS) {
    if (item.pattern.test(text)) {
      return item.concept;
    }
  }

  return null;
}

function isPublicIndustryTerm(componentName = "") {
  return Boolean(findIndustryConcept(componentName));
}

function buildGlossaryIndex(glossaryTerms = []) {
  const index = new Map();

  for (const item of asArray(glossaryTerms)) {
    const term = item.term || item.name || item.key || item.label;
    const definition =
      item.definition || item.description || item.value || item.meaning;

    const key = normalizeKey(term);

    if (key && safeString(definition)) {
      index.set(key, {
        definition: safeString(definition),
        source: DEFINITION_SOURCES.GLOSSARY,
      });
    }
  }

  return index;
}

function findEvidenceDefinition(componentName = "", evidenceRecords = []) {
  const normalizedName = normalizeKey(componentName);
  if (!normalizedName) return null;

  for (const record of asArray(evidenceRecords)) {
    const text =
      record.text ||
      record.content ||
      record.summary ||
      record.value ||
      "";

    const cleanText = safeString(text);
    if (!cleanText) continue;

    const lower = cleanText.toLowerCase();
    const nameLower = safeString(componentName).toLowerCase();

    if (!lower.includes(nameLower)) continue;

    const escapedName = componentName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    const definitionPatterns = [
      new RegExp(`${escapedName}\\s+is\\s+(.+?)(\\.|$)`, "i"),
      new RegExp(`${escapedName}\\s*=\\s*(.+?)(\\.|$)`, "i"),
      new RegExp(`${escapedName}\\s*:\\s*(.+?)(\\.|$)`, "i"),
    ];

    for (const pattern of definitionPatterns) {
      const match = cleanText.match(pattern);
      if (match?.[1]) {
        return {
          definition: safeString(match[1]),
          source: DEFINITION_SOURCES.EVIDENCE,
          evidenceId: record.evidenceId || record.id || null,
        };
      }
    }
  }

  return null;
}

function getRailTitle(rail = {}) {
  const labels = {
    canonical_request_journey: "Canonical Request Journey",
    primary_request_flow: "Primary Request Flow",
    cache_or_payload_delivery_flow: "Cache Delivery Flow",
    auth_validation_flow: "Auth / Validation Flow",
    bidirectional_sync_flow: "State / Synchronization Flow",
    observability_signal_flow: "Observability Flow",
    configuration_flow: "Configuration Flow",
    config_control_flow: "Configuration Flow",
  };

  return (
    rail.title ||
    labels[rail.flowLaneType] ||
    labels[rail.primaryRailType] ||
    "Architecture Rail"
  );
}

function getHopName(hop = {}, endpoint) {
  return safeString(hop?.[endpoint]?.name);
}

function getHopId(hop = {}, fallbackIndex = 0) {
  return hop.hopId || `hop_${fallbackIndex + 1}`;
}

function inferJourneyRoleFromText(text = "") {
  const value = safeString(text).toLowerCase();

  if (/\b(client|user|edge|cdn|ingress|entry|boundary)\b/.test(value)) {
    return JOURNEY_ROLES.ENTRY;
  }

  if (/\b(auth|authentication|authorization|validate|validation|policy)\b/.test(value)) {
    return JOURNEY_ROLES.VALIDATION;
  }

  if (/\b(gateway|router|routing|control|orchestrat)\b/.test(value)) {
    return JOURNEY_ROLES.CONTROL;
  }

  if (/\b(app|application|service|processor|worker|engine|cluster)\b/.test(value)) {
    return JOURNEY_ROLES.PROCESSING;
  }

  if (/\b(database|db|storage|store|state|persistence|cache)\b/.test(value)) {
    return JOURNEY_ROLES.STATE;
  }

  if (/\b(delivery|payload|asset|content|manifest)\b/.test(value)) {
    return JOURNEY_ROLES.DELIVERY;
  }

  if (/\b(metric|metrics|telemetry|monitor|observability|log|health)\b/.test(value)) {
    return JOURNEY_ROLES.OBSERVABILITY;
  }

  if (/\b(config|configuration|settings|rules)\b/.test(value)) {
    return JOURNEY_ROLES.CONFIGURATION;
  }

  return JOURNEY_ROLES.UNKNOWN;
}

function inferJourneyRoleFromHop({ componentName, hop = {}, endpoint }) {
  const contextualRole =
    endpoint === "from"
      ? hop?.contextualRoles?.fromRoleInHandoff
      : hop?.contextualRoles?.toRoleInHandoff;

  const text = [
    componentName,
    endpoint,
    contextualRole,
    hop.flowLaneType,
    hop.interactionMode,
    hop.flowPriority,
    hop.relationshipType,
    hop.from?.globalRole,
    hop.to?.globalRole,
  ]
    .filter(Boolean)
    .join(" ");

  return inferJourneyRoleFromText(text);
}

function rankJourneyRole(role) {
  const order = {
    [JOURNEY_ROLES.ENTRY]: 9,
    [JOURNEY_ROLES.VALIDATION]: 8,
    [JOURNEY_ROLES.CONTROL]: 7,
    [JOURNEY_ROLES.PROCESSING]: 6,
    [JOURNEY_ROLES.STATE]: 5,
    [JOURNEY_ROLES.DELIVERY]: 4,
    [JOURNEY_ROLES.OBSERVABILITY]: 3,
    [JOURNEY_ROLES.CONFIGURATION]: 2,
    [JOURNEY_ROLES.UNKNOWN]: 1,
  };

  return order[role] || 0;
}

function selectBestJourneyRole(roles = []) {
  const cleanRoles = roles.filter(Boolean);
  if (!cleanRoles.length) return JOURNEY_ROLES.UNKNOWN;

  return cleanRoles.sort((a, b) => rankJourneyRole(b) - rankJourneyRole(a))[0];
}

function selectPrimaryRailContext(railContexts = []) {
  const contexts = asArray(railContexts);

  return (
    contexts.find((context) => context.railId === "selected_canonical_walkthrough") ||
    contexts.find((context) => context.selectedForPrimaryWalkthrough === true) ||
    contexts[0] ||
    null
  );
}

function buildRailsForContext(canonicalTraversalRail = {}) {
  const hops = asArray(canonicalTraversalRail.hops);
  const byHopId = new Map(hops.map((hop, index) => [hop.hopId, { hop, index }]));

  const rails = [];

  if (canonicalTraversalRail.selectedWalkthrough) {
    rails.push({
      ...canonicalTraversalRail.selectedWalkthrough,
      railId: "selected_canonical_walkthrough",
      railTitle: "Canonical Request Journey",
      flowLaneId:
        canonicalTraversalRail.selectedWalkthrough.primaryFlowLaneId ||
        canonicalTraversalRail.selectedFlowLaneId ||
        "canonical_request_journey",
      flowLaneType: "canonical_request_journey",
      primaryRailType: "canonical_primary",
      selectedForPrimaryWalkthrough: true,
    });
  }

  for (const rail of asArray(canonicalTraversalRail.selectedPrimaryWalkthroughs)) {
    rails.push({
      ...rail,
      railId:
        rail.id ||
        rail.flowLaneId ||
        `${rail.flowLaneType || "rail"}_${rails.length + 1}`,
      railTitle: getRailTitle(rail),
      selectedForPrimaryWalkthrough:
        rail.selectedForPrimaryWalkthrough === true ||
        rail.primaryRailType === "canonical_primary",
    });
  }

  return uniqueBy(rails, (rail) =>
    [
      rail.railId,
      rail.flowLaneType,
      asArray(rail.selectedHopIds).join("|"),
    ].join(":")
  ).map((rail) => {
    const railHops = asArray(rail.selectedHopIds)
      .map((hopId) => byHopId.get(hopId)?.hop)
      .filter(Boolean);

    return {
      ...rail,
      railTitle: rail.railTitle || getRailTitle(rail),
      hops: rail.hops || railHops,
    };
  });
}

function buildRailContextForComponent({
  componentName,
  rail,
}) {
  const hops = asArray(rail.hops);
  const normalizedComponent = normalizeKey(componentName);

  const matching = [];

  hops.forEach((hop, index) => {
    const fromName = getHopName(hop, "from");
    const toName = getHopName(hop, "to");

    if (normalizeKey(fromName) === normalizedComponent) {
      matching.push({
        hop,
        hopIndex: index,
        endpoint: "from",
      });
    }

    if (normalizeKey(toName) === normalizedComponent) {
      matching.push({
        hop,
        hopIndex: index,
        endpoint: "to",
      });
    }
  });

  if (!matching.length) return null;

  const first = matching[0];
  const firstSeenOrder = first.hopIndex + 1;

  const upstreamComponents = uniqueBy(
    matching
      .map((item) =>
        item.endpoint === "to"
          ? getHopName(item.hop, "from")
          : null
      )
      .filter(Boolean),
    (item) => normalizeKey(item)
  );

  const downstreamComponents = uniqueBy(
    matching
      .map((item) =>
        item.endpoint === "from"
          ? getHopName(item.hop, "to")
          : null
      )
      .filter(Boolean),
    (item) => normalizeKey(item)
  );

  const journeyRoles = matching.map((item) =>
    inferJourneyRoleFromHop({
      componentName,
      hop: item.hop,
      endpoint: item.endpoint,
    })
  );

  return {
    railId:
      rail.railId ||
      rail.id ||
      rail.flowLaneId ||
      "unknown_rail",

    railTitle:
      rail.railTitle ||
      getRailTitle(rail),

    flowLaneId:
      rail.flowLaneId || null,

    flowLaneType:
      rail.flowLaneType || null,

    primaryRailType:
      rail.primaryRailType || null,

    selectedForPrimaryWalkthrough:
      rail.selectedForPrimaryWalkthrough === true,

    firstSeenOrder,

    journeyRole:
      selectBestJourneyRole(journeyRoles),

    upstreamComponents,

    downstreamComponents,

    hopIds: uniqueBy(
      matching.map((item) => getHopId(item.hop, item.hopIndex)),
      (item) => item
    ),

    endpoints: uniqueBy(
      matching.map((item) => item.endpoint),
      (item) => item
    ),
  };
}

function buildRailContextsForComponent({
  componentName,
  canonicalTraversalRail = {},
}) {
  const rails = buildRailsForContext(canonicalTraversalRail);

  return rails
    .map((rail) =>
      buildRailContextForComponent({
        componentName,
        rail,
      })
    )
    .filter(Boolean);
}

function collectComponentCandidates({
  components = [],
  canonicalTraversalRail = {},
  architectureUnderstanding = {},
} = {}) {
  const candidates = new Map();

  function addComponent(name, id = null) {
    const cleanName = safeString(name);
    if (!cleanName) return;

    const parsed = extractParentheticalDefinition(cleanName);
    const displayName = parsed?.componentName || cleanName;
    const key = normalizeKey(displayName);

    if (!key) return;

    const existing = candidates.get(key) || {
      componentId: id || key,
      componentName: displayName,
      rawNames: [],
      parentheticalDefinition: parsed || null,
    };

    existing.rawNames.push(cleanName);

    if (!existing.parentheticalDefinition && parsed) {
      existing.parentheticalDefinition = parsed;
    }

    candidates.set(key, existing);
  }

  for (const component of asArray(components)) {
    addComponent(component.name || component.label || component.id, component.id);
  }

  for (const component of asArray(architectureUnderstanding.components)) {
    addComponent(component.name || component.label || component.id, component.id);
  }

  for (const component of asArray(architectureUnderstanding?.deterministicGraph?.components)) {
    addComponent(component.name || component.label || component.id, component.id);
  }

  for (const hop of asArray(canonicalTraversalRail.hops)) {
    addComponent(hop?.from?.name, hop?.from?.id);
    addComponent(hop?.to?.name, hop?.to?.id);
  }

  return Array.from(candidates.values());
}

function buildComponentUnderstandingEntry({
  candidate,
  glossaryIndex,
  evidenceRecords,
  canonicalTraversalRail,
} = {}) {
  const componentName = safeString(candidate.componentName);
  const componentKey = normalizeKey(componentName);

  const parenthetical = candidate.parentheticalDefinition;
  const glossaryMatch = glossaryIndex.get(componentKey);
  const evidenceMatch = findEvidenceDefinition(componentName, evidenceRecords);

  const documentDefinition =
    parenthetical?.documentDefinition ||
    glossaryMatch?.definition ||
    evidenceMatch?.definition ||
    "";

  const definitionSource =
    parenthetical?.definitionSource ||
    glossaryMatch?.source ||
    evidenceMatch?.source ||
    DEFINITION_SOURCES.NONE;

  const industryConcept =
    findIndustryConcept(documentDefinition) ||
    findIndustryConcept(componentName);

  const hasDocumentDefinition = Boolean(documentDefinition);
  const likelyInternal =
    isLikelyInternalName(componentName) &&
    !isPublicIndustryTerm(componentName);

  let knowledgeType = KNOWLEDGE_TYPES.INTERNAL_UNRESOLVED;

  if (hasDocumentDefinition) {
    knowledgeType = KNOWLEDGE_TYPES.DOCUMENT_DEFINED;
  } else if (industryConcept && !likelyInternal) {
    knowledgeType = KNOWLEDGE_TYPES.INDUSTRY_KNOWN;
  }

  const industryExpansionAllowed =
    knowledgeType === KNOWLEDGE_TYPES.INDUSTRY_KNOWN ||
    knowledgeType === KNOWLEDGE_TYPES.DOCUMENT_DEFINED;

  const confidence = hasDocumentDefinition
    ? "high"
    : knowledgeType === KNOWLEDGE_TYPES.INDUSTRY_KNOWN
      ? "medium"
      : "low";

const railContexts = buildRailContextsForComponent({
  componentName,
  canonicalTraversalRail,
});

const primaryRailContext = selectPrimaryRailContext(railContexts);

return {
  componentId: candidate.componentId || componentKey,
  componentName,
  normalizedName: componentKey,
  rawNames: Array.from(new Set(candidate.rawNames || [componentName])),

  knowledgeType,

    documentDefinition: documentDefinition || null,
    definitionSource,
    definitionEvidenceId: evidenceMatch?.evidenceId || null,

    industryConcept: industryConcept || null,
    industryExpansionAllowed,

    railContexts,

    primaryJourneyRole:
        primaryRailContext?.journeyRole || JOURNEY_ROLES.UNKNOWN,

        primaryJourneyPosition:
        primaryRailContext?.firstSeenOrder || null,

        primaryRailContext:
        primaryRailContext || null,

    internalNameLikely: likelyInternal,
    confidence,

    safety: {
      canExplainIndustryContext: industryExpansionAllowed,
      canInferInternalBehavior: false,
      requiresEvidenceForPrivateMeaning: likelyInternal,
    },
  };
}

function buildComponentUnderstanding({
  components = [],
  canonicalTraversalRail = {},
  architectureUnderstanding = {},
  glossaryTerms = [],
  evidenceRecords = [],
  outputDir = null,
} = {}) {
  const glossaryIndex = buildGlossaryIndex(glossaryTerms);

  const candidates = collectComponentCandidates({
    components,
    canonicalTraversalRail,
    architectureUnderstanding,
  });

  const entries = candidates.map((candidate) =>
    buildComponentUnderstandingEntry({
      candidate,
      glossaryIndex,
      evidenceRecords,
      canonicalTraversalRail,
    })
  );

  const payload = {
    version: BUILDER_VERSION,
    source: "componentUnderstandingBuilder",
    purpose:
      "Classify architecture components before narration so known technologies can be explained, unresolved internal names are not guessed, and rail-aware journey context is available.",
    componentCount: entries.length,
    components: entries,
    stats: {
      industryKnownCount: entries.filter(
        (entry) => entry.knowledgeType === KNOWLEDGE_TYPES.INDUSTRY_KNOWN
      ).length,
      documentDefinedCount: entries.filter(
        (entry) => entry.knowledgeType === KNOWLEDGE_TYPES.DOCUMENT_DEFINED
      ).length,
      internalUnresolvedCount: entries.filter(
        (entry) => entry.knowledgeType === KNOWLEDGE_TYPES.INTERNAL_UNRESOLVED
      ).length,
      componentWithRailContextCount: entries.filter(
        (entry) => entry.railContexts.length > 0
      ).length,
      railContextCount: entries.reduce(
        (sum, entry) => sum + entry.railContexts.length,
        0
      ),
    },
  };

  if (outputDir) {
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(
      path.join(outputDir, "component-understanding.json"),
      JSON.stringify(payload, null, 2),
      "utf8"
    );
  }

  return payload;
}

module.exports = {
  BUILDER_VERSION,
  KNOWLEDGE_TYPES,
  DEFINITION_SOURCES,
  JOURNEY_ROLES,
  buildComponentUnderstanding,
  buildComponentUnderstandingEntry,
  collectComponentCandidates,
  extractParentheticalDefinition,
  findIndustryConcept,
  isLikelyInternalName,
};
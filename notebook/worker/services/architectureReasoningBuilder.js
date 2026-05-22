'use strict';

const VERSION = 'architecture-reasoning-v1';

const REASONING_MODES = {
  INGRESS: 'ingress_path',
  CONTROL: 'control_path',
  PERSISTENCE: 'persistence_path',
  VALIDATION: 'validation_path',
  ASYNC: 'async_path',
  ORCHESTRATION: 'orchestration_path',
};

function buildArchitectureReasoning({
  architectureUnderstanding = {},
  architectureFlow = {},
  documentUnderstanding = {},
  architectureEvidence = {},
} = {}) {
  const relationships = collectRelationships(architectureUnderstanding, architectureFlow);
  const components = collectComponents(architectureUnderstanding);
  const selectedTraversal = architectureFlow?.selectedPrimaryTraversal || null;
    const explicitDocumentFlows = collectExplicitDocumentFlows({
    documentUnderstanding,
    architectureUnderstanding,
    architectureEvidence,
    });

    const componentNeighborhoods = buildComponentNeighborhoodMap(
    components,
    relationships,
    selectedTraversal
    );

    const reasoningModes = inferReasoningModes(
    relationships,
    selectedTraversal,
    componentNeighborhoods,
    explicitDocumentFlows
    );

    const primaryLayers = inferPrimaryLayers(
    components,
    relationships,
    componentNeighborhoods
    );

    const pathSummaries = buildPathSummaries(
    reasoningModes,
    selectedTraversal,
    relationships
    );

    const reasonedFlowSummaries = buildReasonedFlowSummaries(
    explicitDocumentFlows,
    reasoningModes
    );

    const componentRoleExplanations = buildComponentRoleExplanations(
    components,
    relationships,
    componentNeighborhoods
    );

    const directionalInteractions = buildDirectionalInteractions({
    relationships,
    });

  return {
    version: VERSION,
    reasoningModes,
    primaryLayers,
    documentExplainedFlows: explicitDocumentFlows,
    pathSummaries,
    reasonedFlowSummaries,
    componentRoleExplanations,
    directionalInteractions,
    warnings: buildWarnings({ components, relationships, selectedTraversal }),
    stats: {
      componentCount: components.length,
      relationshipCount: relationships.length,
      reasoningModeCount: reasoningModes.length,
        primaryLayerCount: primaryLayers.length,
        explicitDocumentFlowCount: explicitDocumentFlows.length,
        reasonedFlowSummaryCount: reasonedFlowSummaries.length,
        directionalInteractionCount: directionalInteractions.length,
        hasSelectedTraversal: Boolean(selectedTraversal),
    },
  };
}

function collectComponents(architectureUnderstanding = {}) {
  const candidates = [
    architectureUnderstanding.components,
    architectureUnderstanding.architectureGraph?.components,
    architectureUnderstanding.deterministicGraph?.components,
    architectureUnderstanding.nodes,
  ];

  return candidates.find(Array.isArray) || [];
}

function collectRelationships(architectureUnderstanding = {}, architectureFlow = {}) {
  const candidates = [
    architectureFlow.relationships,
    architectureFlow.edges,
    architectureFlow.selectedPrimaryTraversal?.relationships,
    architectureFlow.selectedPrimaryTraversal?.edges,
    architectureUnderstanding.relationships,
    architectureUnderstanding.architectureGraph?.relationships,
    architectureUnderstanding.deterministicGraph?.relationships,
    architectureUnderstanding.edges,
  ];

  return candidates.find(Array.isArray) || [];
}

function collectExplicitDocumentFlows({
  documentUnderstanding = {},
  architectureUnderstanding = {},
  architectureEvidence = {},
} = {}) {
  const flows = [];

  const sequences = [
    ...(Array.isArray(documentUnderstanding.sequences)
      ? documentUnderstanding.sequences
      : []),
    ...(Array.isArray(architectureUnderstanding.explicitSequences)
      ? architectureUnderstanding.explicitSequences
      : []),
  ];

  for (const sequence of sequences) {
    const items = sequence.items || sequence.steps || sequence.nodes || [];

    const normalizedItems = items
    .map((item) =>
        typeof item === "string"
        ? item
        : item.name || item.label || item.text || item.id
    )
    .filter(Boolean);

    if (!Array.isArray(items) || items.length < 2) continue;

    if (!isUsefulFlowSequence(normalizedItems)) continue;

    flows.push({
      source: "ordered_sequence",
      confidence: normalizeConfidence(sequence.confidence, "high"),
      documentSays:
        sequence.text ||
        sequence.summary ||
        sequence.description ||
        normalizedItems.join(" "),
      steps: normalizedItems,
      evidence: [
        sequence.text,
        sequence.summary,
        sequence.description,
        sequence.reason,
      ].filter(Boolean),
    });
  }

  const evidenceRecords = Array.isArray(architectureEvidence.evidenceRecords)
    ? architectureEvidence.evidenceRecords
    : [];

  for (const record of evidenceRecords) {
    const text = record.text || record.summary || record.description || "";

    if (!looksLikeFlowExplanation(text)) continue;

    flows.push({
      source: "explicit_document_flow",
      confidence: normalizeConfidence(record.confidence, "medium"),
      documentSays: text,
      steps: extractFlowStepsFromText(text),
      evidence: [text],
    });
  }

  return flows;
}

function looksLikeFlowExplanation(text = "") {
  const value = normalize(text);

  return includesAny(value, [
    "flows to",
    "forwards to",
    "routes to",
    "sends to",
    "calls",
    "connects to",
    "hands off",
    "then",
    "request moves",
    "request flows",
  ]);
}

function isUsefulFlowSequence(items = []) {
  if (!Array.isArray(items) || items.length < 2) return false;

  const joined = normalize(items.join(" "));

  if (
    includesAny(joined, [
      "generic distributed architecture flow",
      "primary request flow",
      "operational notes",
    ]) &&
    !includesAny(joined, [
      "sends requests",
      "forwards",
      "validates",
      "distributes",
      "reads",
      "writes",
      "routes",
    ])
  ) {
    return false;
  }

  return includesAny(joined, [
    "sends",
    "forwards",
    "validates",
    "distributes",
    "reads",
    "writes",
    "routes",
    "connects",
    "calls",
    "flows",
  ]);
}

function extractFlowStepsFromText(text = "") {
  return String(text)
    .split(/→|->|=>|then|to|calls|forwards|routes|sends|hands off/i)
    .map((part) => part.trim())
    .filter((part) => part.length > 1)
    .slice(0, 12);
}

function buildComponentNeighborhoodMap(
  components = [],
  relationships = [],
  selectedTraversal = null
) {
  const map = new Map();

  for (const component of components) {
    const name = getComponentName(component);
    if (!name) continue;

    map.set(normalize(name), {
      component: name,
      incoming: [],
      outgoing: [],
      connected: [],
      traversalIndex: null,
      traversalEvidence: [],
    });
  }

  for (const rel of relationships) {
    const from = rel.from || rel.source || rel.sourceId;
    const to = rel.to || rel.target || rel.targetId;

    const fromKey = normalize(from);
    const toKey = normalize(to);

    if (map.has(fromKey)) {
      map.get(fromKey).outgoing.push(rel);
      map.get(fromKey).connected.push(to);
    }

    if (map.has(toKey)) {
      map.get(toKey).incoming.push(rel);
      map.get(toKey).connected.push(from);
    }
  }

  const traversalNodes = extractTraversalNodes(selectedTraversal);

  traversalNodes.forEach((node, index) => {
    const key = normalize(node);
    if (!map.has(key)) return;

    map.get(key).traversalIndex = index;
    map.get(key).traversalEvidence.push(
      `Appears at traversal position ${index + 1}`
    );
  });

  return map;
}

function extractTraversalNodes(selectedTraversal = null) {
  if (!selectedTraversal) return [];

  const candidates = [
    selectedTraversal.nodes,
    selectedTraversal.path,
    selectedTraversal.components,
  ];

  const direct = candidates.find(Array.isArray);
  if (direct) {
    return direct.map((item) =>
      typeof item === 'string'
        ? item
        : item.name || item.label || item.id || item.componentId
    ).filter(Boolean);
  }

  const edges = selectedTraversal.relationships || selectedTraversal.edges || [];
  const nodes = [];

  for (const edge of edges) {
    const from = edge.from || edge.source || edge.sourceId;
    const to = edge.to || edge.target || edge.targetId;

    if (from) nodes.push(from);
    if (to) nodes.push(to);
  }

  return unique(nodes);
}

function inferReasoningModes(
  relationships = [],
  selectedTraversal = null,
  componentNeighborhoods = new Map(),
  explicitDocumentFlows = []
) {
  const modeMap = new Map();

  for (const flow of explicitDocumentFlows) {
    addModesFromExplicitFlow(modeMap, flow);
    }

  for (const rel of relationships) {
    const type = normalize(rel.type || rel.relationshipType || rel.flowType || rel.edgeType);
    const label = normalize(`${rel.label || ''} ${rel.description || ''} ${rel.from || ''} ${rel.to || ''}`);

    addModeFromRelationship(modeMap, rel, type, label);
  }

  if (selectedTraversal) {
    addMode(modeMap, REASONING_MODES.INGRESS, {
      confidence: 'medium',
      evidence: ['selectedPrimaryTraversal exists'],
      reason: 'Primary traversal indicates an end-to-end path through the architecture.',
    });
  }

  return Array.from(modeMap.values());
}

function addModesFromExplicitFlow(modeMap, flow) {
  const text = normalize(
    `${flow.documentSays || ""} ${(flow.steps || []).join(" ")}`
  );

  const basePayload = {
    confidence: flow.confidence || "high",
    evidence: unique([
      `${flow.source}: ${flow.documentSays}`,
      ...(flow.evidence || []),
    ]),
  };

  if (includesAny(text, ["client", "edge", "cdn", "ingress", "entry", "request"])) {
    addMode(modeMap, REASONING_MODES.INGRESS, {
      ...basePayload,
      reason: "Document explicitly describes traffic entering or moving through the architecture.",
    });
  }

  if (includesAny(text, ["auth", "authentication", "authorization", "validate", "validation"])) {
    addMode(modeMap, REASONING_MODES.VALIDATION, {
      ...basePayload,
      reason: "Document explicitly describes validation or access-control behavior.",
    });
  }

  if (includesAny(text, ["routing", "route", "gateway", "control", "configuration"])) {
    addMode(modeMap, REASONING_MODES.CONTROL, {
      ...basePayload,
      reason: "Document explicitly describes routing, control, or decision-making behavior.",
    });
  }

  if (includesAny(text, ["database", "db", "storage", "store", "state", "persistence", "cache"])) {
    addMode(modeMap, REASONING_MODES.PERSISTENCE, {
      ...basePayload,
      reason: "Document explicitly describes state, storage, caching, or persistence behavior.",
    });
  }

  if (includesAny(text, ["queue", "event", "async", "stream", "worker", "message"])) {
    addMode(modeMap, REASONING_MODES.ASYNC, {
      ...basePayload,
      reason: "Document explicitly describes asynchronous or message-driven behavior.",
    });
  }

  if (includesAny(text, ["orchestrator", "workflow", "scheduler", "coordinator", "pipeline"])) {
    addMode(modeMap, REASONING_MODES.ORCHESTRATION, {
      ...basePayload,
      reason: "Document explicitly describes orchestration or coordination behavior.",
    });
  }
}

function addModeFromRelationship(modeMap, rel, type, label) {
  if (
    includesAny(type, ['request_response', 'payload_delivery', 'traffic_distribution']) ||
    includesAny(label, ['client', 'edge', 'gateway', 'ingress', 'entry', 'request'])
  ) {
    addMode(modeMap, REASONING_MODES.INGRESS, {
      confidence: confidenceFromRelationship(rel),
      evidence: relationshipEvidence(rel),
      reason: 'Relationship appears to describe how traffic enters or moves through the system.',
    });
  }

  if (
    includesAny(type, ['configuration_flow', 'control', 'routing']) ||
    includesAny(label, ['routing', 'control', 'gateway', 'router', 'configuration'])
  ) {
    addMode(modeMap, REASONING_MODES.CONTROL, {
      confidence: confidenceFromRelationship(rel),
      evidence: relationshipEvidence(rel),
      reason: 'Relationship appears to describe routing, control, or decision-making behavior.',
    });
  }

  if (
    includesAny(type, ['auth_validation']) ||
    includesAny(label, ['auth', 'authentication', 'authorization', 'validate', 'validation'])
  ) {
    addMode(modeMap, REASONING_MODES.VALIDATION, {
      confidence: confidenceFromRelationship(rel),
      evidence: relationshipEvidence(rel),
      reason: 'Relationship appears to describe validation or access-control behavior.',
    });
  }

  if (
    includesAny(label, ['database', 'db', 'storage', 'store', 'state', 'persistence', 'cache'])
  ) {
    addMode(modeMap, REASONING_MODES.PERSISTENCE, {
      confidence: confidenceFromRelationship(rel),
      evidence: relationshipEvidence(rel),
      reason: 'Relationship appears to touch a stateful or persistence responsibility.',
    });
  }

  if (
    includesAny(label, ['queue', 'event', 'async', 'stream', 'worker', 'message'])
  ) {
    addMode(modeMap, REASONING_MODES.ASYNC, {
      confidence: confidenceFromRelationship(rel),
      evidence: relationshipEvidence(rel),
      reason: 'Relationship appears to describe asynchronous or message-driven behavior.',
    });
  }

  if (
    includesAny(label, ['orchestrator', 'workflow', 'scheduler', 'coordinator', 'pipeline'])
  ) {
    addMode(modeMap, REASONING_MODES.ORCHESTRATION, {
      confidence: confidenceFromRelationship(rel),
      evidence: relationshipEvidence(rel),
      reason: 'Relationship appears to describe coordination or orchestration behavior.',
    });
  }
}

function addMode(modeMap, mode, payload) {
  const existing = modeMap.get(mode);

  if (!existing) {
    modeMap.set(mode, {
      mode,
      confidence: payload.confidence || 'medium',
      reason: payload.reason,
      evidence: payload.evidence || [],
    });
    return;
  }

  existing.evidence = unique([...(existing.evidence || []), ...(payload.evidence || [])]);
  existing.confidence = strongestConfidence(existing.confidence, payload.confidence);
}

function inferPrimaryLayers(
  components = [],
  relationships = [],
  componentNeighborhoods = new Map()
) {
  const layers = new Map();

  for (const component of components) {
    const name = getComponentName(component);
    const text = normalize(`${name} ${component.type || ''} ${component.role || ''} ${component.description || ''}`);

    const layer = classifyLayer(text);
    if (!layer) continue;

    const existing = layers.get(layer.layerId) || {
      ...layer,
      components: [],
      evidence: [],
    };

    existing.components.push(name);
    existing.evidence.push(`Component matched layer pattern: ${name}`);
    layers.set(layer.layerId, existing);
  }

  for (const rel of relationships) {
    const text = normalize(`${rel.from || ''} ${rel.to || ''} ${rel.label || ''} ${rel.description || ''}`);
    const layer = classifyLayer(text);
    if (!layer) continue;

    const existing = layers.get(layer.layerId) || {
      ...layer,
      components: [],
      evidence: [],
    };

    existing.evidence.push(...relationshipEvidence(rel));
    layers.set(layer.layerId, existing);
  }

  return Array.from(layers.values()).map((layer) => ({
    ...layer,
    components: unique(layer.components).filter(Boolean),
    evidence: unique(layer.evidence),
  }));
}

function classifyLayer(text) {
  if (includesAny(text, ['client', 'edge', 'cdn', 'gateway', 'ingress', 'entry'])) {
    return {
      layerId: 'entry_and_ingress',
      label: 'Entry and ingress',
      confidence: 'medium',
      purpose: 'Represents where external traffic enters or begins moving through the system.',
    };
  }

  if (includesAny(text, ['router', 'routing', 'gateway', 'control', 'configuration'])) {
    return {
      layerId: 'routing_and_control',
      label: 'Routing and control',
      confidence: 'medium',
      purpose: 'Represents decision points that route, direct, or control traffic.',
    };
  }

  if (includesAny(text, ['auth', 'validation', 'validate', 'authorization', 'authentication'])) {
    return {
      layerId: 'validation_and_access',
      label: 'Validation and access',
      confidence: 'medium',
      purpose: 'Represents checks that validate access, identity, or request eligibility.',
    };
  }

  if (includesAny(text, ['service', 'application', 'worker', 'processor', 'compute'])) {
    return {
      layerId: 'processing',
      label: 'Processing',
      confidence: 'medium',
      purpose: 'Represents components that perform application or business processing.',
    };
  }

  if (includesAny(text, ['database', 'db', 'storage', 'store', 'state', 'persistence', 'cache'])) {
    return {
      layerId: 'state_and_persistence',
      label: 'State and persistence',
      confidence: 'medium',
      purpose: 'Represents components that hold data, state, or reusable responses.',
    };
  }

  return null;
}

function buildPathSummaries(reasoningModes = [], selectedTraversal = null, relationships = []) {
  return reasoningModes.map((mode) => ({
    mode: mode.mode,
    confidence: mode.confidence,
    summary: summaryForMode(mode.mode),
    evidence: mode.evidence,
    selectedTraversalUsed: Boolean(selectedTraversal),
    relationshipCount: relationships.length,
  }));
}

function buildReasonedFlowSummaries(
  explicitDocumentFlows = [],
  reasoningModes = []
) {
  const summaries = [];

  for (const flow of explicitDocumentFlows) {
    const joined = normalize(
      `${flow.documentSays || ""} ${(flow.steps || []).join(" ")}`
    );

    const matchedModes = reasoningModes
      .filter((mode) => matchesReasoningMode(joined, mode.mode))
      .map((mode) => mode.mode);

    if (!matchedModes.length) continue;

    for (const mode of matchedModes) {
      summaries.push({
        mode,
        source: flow.source || "explicit_document_flow",
        confidence: flow.confidence || "medium",
        documentSays: flow.documentSays,
        steps: flow.steps || [],
        reasonedMeaning: inferReasonedMeaning(mode, flow),
        evidence: unique([
          ...(flow.evidence || []),
          flow.documentSays,
        ]),
      });
    }
  }

  return summaries;
}

function matchesReasoningMode(text, mode) {
  switch (mode) {
    case REASONING_MODES.INGRESS:
      return includesAny(text, [
        "client",
        "edge",
        "cdn",
        "gateway",
        "request",
        "ingress",
      ]);

    case REASONING_MODES.VALIDATION:
      return includesAny(text, [
        "auth",
        "authentication",
        "authorization",
        "validate",
        "validation",
      ]);

    case REASONING_MODES.CONTROL:
      return includesAny(text, [
        "routing",
        "route",
        "gateway",
        "control",
        "distribution",
      ]);

    case REASONING_MODES.PERSISTENCE:
      return includesAny(text, [
        "database",
        "storage",
        "reads",
        "writes",
        "persistent",
      ]);

    case REASONING_MODES.ASYNC:
      return includesAny(text, [
        "queue",
        "event",
        "stream",
        "worker",
        "async",
      ]);

    case REASONING_MODES.ORCHESTRATION:
      return includesAny(text, [
        "workflow",
        "pipeline",
        "scheduler",
        "orchestrator",
      ]);

    default:
      return false;
  }
}

function inferReasonedMeaning(mode, flow) {
  switch (mode) {
    case REASONING_MODES.INGRESS:
      return "Traffic enters the architecture through boundary and routing layers before reaching internal services.";

    case REASONING_MODES.VALIDATION:
      return "Validation and access checks occur before protected application processing.";

    case REASONING_MODES.CONTROL:
      return "Routing and control layers distribute requests toward internal processing systems.";

    case REASONING_MODES.PERSISTENCE:
      return "Application processing eventually interacts with persistent state or storage systems.";

    case REASONING_MODES.ASYNC:
      return "The architecture includes asynchronous or message-driven processing behavior.";

    case REASONING_MODES.ORCHESTRATION:
      return "The architecture coordinates multi-stage workflows or orchestration behavior.";

    default:
      return "The architecture demonstrates a recognizable system responsibility pattern.";
  }
}

function buildComponentRoleExplanations(
  components = [],
  relationships = [],
  componentNeighborhoods = new Map()
) {
  return components.map((component) => {
    const name = getComponentName(component);
    const neighborhood = componentNeighborhoods.get(normalize(name));

    const related = neighborhood
      ? [...neighborhood.incoming, ...neighborhood.outgoing]
      : relationships.filter((rel) =>
          [rel.from, rel.to, rel.source, rel.target].some((value) =>
            normalize(value) === normalize(name)
          )
        );

    const roleResult = inferComponentRole(component, related, neighborhood);

    return {
      component: name,
      inferredRole: roleResult.role,
      confidence: roleResult.confidence,
      evidence: unique([
        ...(roleResult.evidence || []),
        ...(neighborhood?.traversalEvidence || []),
        ...(related.length
          ? related.flatMap(relationshipEvidence)
          : [`Component appears in architecture graph: ${name}`]),
      ]),
      graphContext: neighborhood
        ? {
            incomingCount: neighborhood.incoming.length,
            outgoingCount: neighborhood.outgoing.length,
            connectedComponents: unique(neighborhood.connected),
            traversalIndex: neighborhood.traversalIndex,
          }
        : undefined,
    };
  }).filter((item) => item.component);
}

function inferComponentRole(component, relationships = [], neighborhood = null) {
  const componentText = normalize(
    `${getComponentName(component)} ${component.type || ''} ${component.role || ''} ${component.description || ''}`
  );

  const relationshipText = normalize(
    relationships
      .map((rel) =>
        `${rel.type || ''} ${rel.relationshipType || ''} ${rel.flowType || ''} ${rel.edgeType || ''} ${rel.label || ''} ${rel.description || ''} ${rel.from || ''} ${rel.to || ''}`
      )
      .join(' ')
  );

  const combinedText = `${componentText} ${relationshipText}`;

  if (includesAny(combinedText, ['auth', 'authentication', 'authorization', 'validate', 'validation'])) {
    return {
      role: 'Validation and access',
      confidence: neighborhoodHasEdges(neighborhood) ? 'high' : 'medium',
      evidence: ['Component or nearby relationships contain validation/access semantics.'],
    };
  }

  if (includesAny(combinedText, ['database', 'db', 'storage', 'store', 'state', 'persistence'])) {
    return {
      role: 'State and persistence',
      confidence: neighborhoodHasEdges(neighborhood) ? 'high' : 'medium',
      evidence: ['Component or nearby relationships contain persistence/state semantics.'],
    };
  }

  if (includesAny(combinedText, ['queue', 'event', 'async', 'stream', 'worker', 'message'])) {
    return {
      role: 'Async or event processing',
      confidence: neighborhoodHasEdges(neighborhood) ? 'high' : 'medium',
      evidence: ['Component or nearby relationships contain async/message semantics.'],
    };
  }

  if (includesAny(combinedText, ['orchestrator', 'workflow', 'scheduler', 'coordinator', 'pipeline'])) {
    return {
      role: 'Orchestration and coordination',
      confidence: neighborhoodHasEdges(neighborhood) ? 'high' : 'medium',
      evidence: ['Component or nearby relationships contain orchestration semantics.'],
    };
  }

  if (includesAny(combinedText, ['router', 'routing', 'gateway', 'control', 'configuration'])) {
    return {
      role: 'Routing and control',
      confidence: neighborhoodHasEdges(neighborhood) ? 'high' : 'medium',
      evidence: ['Component or nearby relationships contain routing/control semantics.'],
    };
  }

  if (includesAny(combinedText, ['client', 'edge', 'cdn', 'ingress', 'entry'])) {
    return {
      role: 'Entry and ingress',
      confidence: neighborhoodHasEdges(neighborhood) ? 'high' : 'medium',
      evidence: ['Component or nearby relationships contain entry/ingress semantics.'],
    };
  }

  const layer = classifyLayer(componentText);
  if (layer) {
    return {
      role: layer.label,
      confidence: 'medium',
      evidence: [`Component matched layer pattern: ${getComponentName(component)}`],
    };
  }

  return {
    role: 'Architecture component',
    confidence: neighborhoodHasEdges(neighborhood) ? 'medium' : 'low',
    evidence: ['No stronger deterministic role pattern matched.'],
  };
}

function neighborhoodHasEdges(neighborhood) {
  if (!neighborhood) return false;
  return neighborhood.incoming.length > 0 || neighborhood.outgoing.length > 0;
}

function buildWarnings({ components, relationships, selectedTraversal }) {
  const warnings = [];

  if (!components.length) {
    warnings.push({
      code: 'NO_COMPONENTS_FOUND',
      message: 'No architecture components were available for reasoning.',
      severity: 'medium',
    });
  }

  if (!relationships.length) {
    warnings.push({
      code: 'NO_RELATIONSHIPS_FOUND',
      message: 'No architecture relationships were available for reasoning.',
      severity: 'medium',
    });
  }

  if (!selectedTraversal) {
    warnings.push({
      code: 'NO_SELECTED_PRIMARY_TRAVERSAL',
      message: 'Reasoning proceeded without selectedPrimaryTraversal.',
      severity: 'low',
    });
  }

  return warnings;
}

function relationshipEvidence(rel) {
  const from = rel.from || rel.source || rel.sourceId;
  const to = rel.to || rel.target || rel.targetId;
  const label = rel.label || rel.description || rel.type || rel.relationshipType;

  return [
    from && to ? `Relationship: ${from} → ${to}` : null,
    label ? `Relationship evidence: ${label}` : null,
  ].filter(Boolean);
}

function confidenceFromRelationship(rel) {
  return rel.confidence || rel.confidenceLevel || 'medium';
}

function normalizeConfidence(value, fallback = "medium") {
  if (value === "deterministic") return "deterministic";
  if (value === "high") return "high";
  if (value === "medium") return "medium";
  if (value === "low") return "low";
  if (value === "unknown") return "unknown";

  if (typeof value === "number") {
    if (value >= 0.9) return "high";
    if (value >= 0.6) return "medium";
    if (value > 0) return "low";
  }

  return fallback;
}

function buildDirectionalInteractions({ relationships = [] } = {}) {
  return relationships
    .map((rel) => {
      const from = rel.from || rel.source || rel.sourceId;
      const to = rel.to || rel.target || rel.targetId;

      if (!from || !to) return null;

      const label =
        rel.label ||
        rel.description ||
        rel.type ||
        rel.relationshipType ||
        rel.flowType ||
        rel.edgeType ||
        '';

      const classification = classifyDirectionalInteraction({
        from,
        to,
        label,
        rawType: rel.type || rel.relationshipType || rel.flowType || rel.edgeType || '',
        relationship: rel,
        });

        return {
        from,
        to,
        directionality: 'directed',
        interactionType: classification.interactionType,
        forwardMeaning: classification.forwardMeaning,
        reverseMeaning: classification.reverseMeaning,
        source: classification.source,
        confidence: classification.confidence || confidenceFromRelationship(rel),
        evidence: unique([
            ...relationshipEvidence(rel),
            ...(classification.evidence || []),
        ]),
        rawType: rel.type || rel.relationshipType || rel.flowType || rel.edgeType || null,
        rawLabel: label || null,
        };
    })
    .filter(Boolean);
}

function classifyDirectionalInteraction({
  from = '',
  to = '',
  label = '',
  rawType = '',
  relationship = {},
} = {}) {
  const explicitText = normalize(
    `${label} ${relationship.description || ''}`
    );

    const structuralText = normalize(
    `${rawType}`
    );

    const endpointText = normalize(
    `${from} ${to}`
    );

    const text = `${explicitText} ${structuralText} ${endpointText}`;

    if (
    includesAny(explicitText, ['auth', 'authentication', 'authorization', 'validate', 'validation']) ||
    includesAny(structuralText, ['auth_validation'])
    ) {
    return {
      interactionType: 'validation_request',
      forwardMeaning: 'The source asks the target to validate access, identity, or request eligibility.',
      reverseMeaning: 'unknown',
      source: 'relationship_semantics',
      confidence: confidenceFromRelationship(relationship),
      evidence: ['Relationship contains validation/access semantics.'],
    };
  }

  if (includesAny(text, ['reads and writes', 'read and write', 'reads', 'writes'])) {
    return {
      interactionType: 'read_write_request',
      forwardMeaning: 'The source reads from or writes to the target stateful system.',
      reverseMeaning: 'unknown',
      source: 'relationship_semantics',
      confidence: confidenceFromRelationship(relationship),
      evidence: ['Relationship contains read/write persistence semantics.'],
    };
  }

  if (includesAny(text, ['database', 'db', 'storage', 'store', 'state', 'persistence'])) {
    return {
      interactionType: 'persistence_request',
      forwardMeaning: 'The source interacts with the target as a stateful or persistence system.',
      reverseMeaning: 'unknown',
      source: 'relationship_semantics',
      confidence: confidenceFromRelationship(relationship),
      evidence: ['Relationship touches state, storage, or persistence semantics.'],
    };
  }

  if (
    includesAny(explicitText, ['routes', 'routing', 'distributes', 'distribution']) ||
    includesAny(structuralText, ['configuration_flow', 'routing'])
    ) {
    return {
      interactionType: 'routing_handoff',
      forwardMeaning: 'The source routes or distributes traffic toward the target.',
      reverseMeaning: 'unknown',
      source: 'relationship_semantics',
      confidence: confidenceFromRelationship(relationship),
      evidence: ['Relationship contains routing/distribution semantics.'],
    };
  }

  if (
    includesAny(explicitText, ['forwards', 'sends', 'request', 'traffic']) ||
    includesAny(structuralText, ['request_response', 'payload_delivery', 'traffic_distribution'])
    ) {
    return {
      interactionType: 'traffic_forward',
      forwardMeaning: 'The source forwards traffic or a request toward the target.',
      reverseMeaning: 'unknown',
      source: 'relationship_semantics',
      confidence: confidenceFromRelationship(relationship),
      evidence: ['Relationship contains request/traffic movement semantics.'],
    };
  }

  if (includesAny(text, ['queue', 'event', 'async', 'stream', 'message'])) {
    return {
      interactionType: 'async_event',
      forwardMeaning: 'The source appears to emit or hand off asynchronous work toward the target.',
      reverseMeaning: 'unknown',
      source: 'relationship_semantics',
      confidence: confidenceFromRelationship(relationship),
      evidence: ['Relationship contains async/event semantics.'],
    };
  }

  if (includesAny(text, ['health', 'check', 'poll', 'monitor'])) {
    return {
      interactionType: 'health_check',
      forwardMeaning: 'The source appears to check health, status, or availability of the target.',
      reverseMeaning: 'unknown',
      source: 'relationship_semantics',
      confidence: confidenceFromRelationship(relationship),
      evidence: ['Relationship contains health-check or monitoring semantics.'],
    };
  }

  if (includesAny(endpointText, ['auth', 'authentication', 'authorization'])) {
    return {
        interactionType: 'validation_request',
        forwardMeaning: 'The source appears connected to a validation or access component.',
        reverseMeaning: 'unknown',
        source: 'endpoint_semantics',
        confidence: 'low',
        evidence: ['Endpoint names contain validation/access semantics.'],
    };
    }

    if (includesAny(structuralText, ['explicit_flow'])) {
    return {
        interactionType: 'traffic_forward',
        forwardMeaning: 'The source participates in an explicitly documented flow toward the target.',
        reverseMeaning: 'unknown',
        source: 'structural_semantics',
        confidence:
            confidenceFromRelationship(relationship) === 'high'
                ? 'medium'
                : confidenceFromRelationship(relationship),
        evidence: ['Relationship is part of an explicit documented flow.'],
    };
    }

    return {
    interactionType: 'unknown',
    forwardMeaning: 'unknown',
    reverseMeaning: 'unknown',
    source: 'relationship',
    confidence: confidenceFromRelationship(relationship),
    evidence: [],
    };
}


function strongestConfidence(a = 'low', b = 'low') {
  const order = { unknown: 0, low: 1, medium: 2, high: 3, deterministic: 4 };
  return order[b] > order[a] ? b : a;
}

function getComponentName(component) {
  if (typeof component === 'string') return component;
  return component.name || component.label || component.id || component.componentId || '';
}

function normalize(value) {
  return String(value || '').toLowerCase().trim();
}

function includesAny(text, terms) {
  return terms.some((term) => text.includes(term));
}

function unique(items) {
  return Array.from(new Set(items.filter(Boolean)));
}

function summaryForMode(mode) {
  switch (mode) {
    case REASONING_MODES.INGRESS:
      return 'This path describes how traffic enters or begins moving through the architecture.';
    case REASONING_MODES.CONTROL:
      return 'This path describes where routing, control, or decision-making appears to happen.';
    case REASONING_MODES.PERSISTENCE:
      return 'This path describes where state, storage, caching, or persistence appears in the architecture.';
    case REASONING_MODES.VALIDATION:
      return 'This path describes where validation, authentication, authorization, or access checks appear.';
    case REASONING_MODES.ASYNC:
      return 'This path describes asynchronous, queued, event-driven, or worker-style behavior.';
    case REASONING_MODES.ORCHESTRATION:
      return 'This path describes coordination, workflow, scheduling, or orchestration behavior.';
    default:
      return 'This path describes a recognizable architecture responsibility.';
  }
}

module.exports = {
  buildArchitectureReasoning,
  REASONING_MODES,
};
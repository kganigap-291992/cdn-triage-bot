/**
 * architectureFlowBuilder.js
 *
 * Converts architectureUnderstanding into teachable architecture walkthroughs.
 *
 * Design:
 * - Architecture docs are flow documents, not section documents.
 * - Keep internal graph fine-grained.
 * - Group video teaching into coarse walkthrough chapters.
 * - Stay deterministic and domain-neutral.
 * - Do not invent architecture facts.
 *
 * Core rule:
 * - Classify by graph behavior + evidence, not technology/product names.
 *
 * Examples:
 * - source_node: starts a flow
 * - boundary_node: first meaningful handoff into the system
 * - control_node: routes/funnels/connects
 * - processing_node: internal execution / middle path
 * - fanout_node: one-to-many branch point
 * - terminal_node: flow ending
 * - state_node: terminal-ish node with evidence of state/storage/persistence
 */

const DEFAULT_CONFIDENCE_ORDER = {
  deterministic: 4,
  high: 3,
  medium: 2,
  low: 1,
  unknown: 0,
};

const STRUCTURAL_ROLES = {
  SOURCE: "source_node",
  BOUNDARY: "boundary_node",
  CONTROL: "control_node",
  PROCESSING: "processing_node",
  FANOUT: "fanout_node",
  TERMINAL: "terminal_node",
  STATE: "state_node",
  ISOLATED: "isolated_node",
};

const CHAPTER_TYPES = {
  OVERVIEW: "architecture_overview",
  ENTRY_BOUNDARY: "entry_and_boundary_flow",
  CONTROL_ROUTING: "control_and_routing_flow",
  PROCESSING: "processing_path_flow",
  STATE_TERMINAL: "state_or_terminal_destination_flow",
  RECAP: "architecture_recap",
};

function normalizeText(value) {
  return String(value || "").trim();
}

function normalizeKey(value) {
  return normalizeText(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function confidenceScore(confidence) {
  return DEFAULT_CONFIDENCE_ORDER[confidence] ?? DEFAULT_CONFIDENCE_ORDER.unknown;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function uniqueBy(items, getKey) {
  const seen = new Set();
  const out = [];

  for (const item of items || []) {
    const key = getKey(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }

  return out;
}

function getComponentId(component) {
  return (
    component?.id ||
    component?.componentId ||
    component?.entityId ||
    normalizeKey(component?.name || component?.label)
  );
}

function getComponentName(component) {
  return normalizeText(
    component?.name ||
      component?.label ||
      component?.title ||
      getComponentId(component)
  );
}

function getRelationshipSource(rel) {
  return normalizeText(
    rel?.source ||
      rel?.sourceId ||
      rel?.from ||
      rel?.fromId ||
      rel?.sourceEntityId ||
      rel?.sourceComponentId
  );
}

function getRelationshipTarget(rel) {
  return normalizeText(
    rel?.target ||
      rel?.targetId ||
      rel?.to ||
      rel?.toId ||
      rel?.targetEntityId ||
      rel?.targetComponentId
  );
}

function getRelationshipType(rel) {
  return normalizeText(
    rel?.type || rel?.relationshipType || rel?.kind || "connects_to"
  );
}

function getRelationshipConfidence(rel) {
  return rel?.confidence || rel?.confidenceTier || "unknown";
}

function collectTextHints(...values) {
  return values
    .flatMap((value) => {
      if (Array.isArray(value)) return value;
      if (value && typeof value === "object") return Object.values(value);
      return [value];
    })
    .map(normalizeText)
    .filter(Boolean)
    .join(" ");
}

function containsAny(text, terms) {
  const key = normalizeKey(text);
  return terms.some((term) => key.includes(normalizeKey(term)));
}

function buildComponentIndex(architectureUnderstanding = {}) {
  const candidates = [
    ...asArray(architectureUnderstanding.components),
    ...asArray(architectureUnderstanding.nodes),
    ...asArray(architectureUnderstanding.entities),
    ...asArray(architectureUnderstanding.deterministicGraph?.components),
    ...asArray(architectureUnderstanding.deterministicGraph?.nodes),
  ];

  const components = uniqueBy(candidates, getComponentId).map((component) => {
    const id = getComponentId(component);

    return {
      ...component,
      id,
      name: getComponentName(component),
      declaredRole:
        component?.role || component?.componentRole || component?.type || "unknown",
      page: component?.page ?? component?.pageNumber ?? null,
      confidence: component?.confidence || component?.confidenceTier || "unknown",
      evidenceIds: asArray(component?.evidenceIds),
      evidenceText: collectTextHints(
        component?.description,
        component?.summary,
        component?.notes,
        component?.evidenceText,
        component?.text,
        component?.raw
      ),
    };
  });

  const byId = new Map();
  const byNameKey = new Map();

  for (const component of components) {
    byId.set(component.id, component);
    byNameKey.set(normalizeKey(component.name), component);
  }

  return {
    components,
    byId,
    byNameKey,
  };
}

function resolveComponentRef(ref, componentIndex) {
  if (!ref) return null;

  const direct = componentIndex.byId.get(ref);
  if (direct) return direct;

  const normalized = normalizeKey(ref);
  return componentIndex.byId.get(normalized) || componentIndex.byNameKey.get(normalized) || null;
}

function buildRelationshipList(architectureUnderstanding = {}, componentIndex) {
  const candidates = [
    ...asArray(architectureUnderstanding.relationships),
    ...asArray(architectureUnderstanding.flows),
    ...asArray(architectureUnderstanding.deterministicGraph?.relationships),
    ...asArray(architectureUnderstanding.deterministicGraph?.edges),
    ...asArray(architectureUnderstanding.semanticGraph?.relationships),
    ...asArray(architectureUnderstanding.semanticGraph?.edges),
  ];

  return uniqueBy(candidates, (rel) => {
    const source = getRelationshipSource(rel);
    const target = getRelationshipTarget(rel);
    const type = getRelationshipType(rel);
    return `${source}->${target}:${type}`;
  })
    .map((rel, index) => {
      const sourceRef = getRelationshipSource(rel);
      const targetRef = getRelationshipTarget(rel);

      const sourceComponent = resolveComponentRef(sourceRef, componentIndex);
      const targetComponent = resolveComponentRef(targetRef, componentIndex);

      if (!sourceComponent || !targetComponent) return null;

      const confidence = getRelationshipConfidence(rel);

      return {
        id: rel?.id || `architecture_edge_${index + 1}`,
        sourceId: sourceComponent.id,
        targetId: targetComponent.id,
        sourceName: sourceComponent.name,
        targetName: targetComponent.name,
        type: getRelationshipType(rel),
        confidence,
        confidenceScore: confidenceScore(confidence),
        evidenceIds: asArray(rel?.evidenceIds),
        evidenceText: collectTextHints(
          rel?.description,
          rel?.summary,
          rel?.notes,
          rel?.evidenceText,
          rel?.text,
          rel?.reason,
          rel?.raw
        ),
        source:
          rel?.source ||
          rel?.sourceType ||
          rel?.evidenceSource ||
          "architecture_understanding",
        raw: rel,
      };
    })
    .filter(Boolean)
    .filter((rel) => rel.confidenceScore >= confidenceScore("medium"));
}

function buildAdjacency(relationships) {
  const outgoing = new Map();
  const incoming = new Map();

  for (const rel of relationships) {
    if (!outgoing.has(rel.sourceId)) outgoing.set(rel.sourceId, []);
    if (!incoming.has(rel.targetId)) incoming.set(rel.targetId, []);

    outgoing.get(rel.sourceId).push(rel);
    incoming.get(rel.targetId).push(rel);
  }

  for (const rels of outgoing.values()) {
    rels.sort((a, b) => {
      const confidenceDelta = b.confidenceScore - a.confidenceScore;
      if (confidenceDelta !== 0) return confidenceDelta;
      return a.targetName.localeCompare(b.targetName);
    });
  }

  return { outgoing, incoming };
}

function computeGraphMetrics(componentIndex, relationships, adjacency) {
  const metricsById = new Map();

  for (const component of componentIndex.components) {
    const incoming = asArray(adjacency.incoming.get(component.id));
    const outgoing = asArray(adjacency.outgoing.get(component.id));

    metricsById.set(component.id, {
      componentId: component.id,
      incomingCount: incoming.length,
      outgoingCount: outgoing.length,
      degree: incoming.length + outgoing.length,
      hasIncoming: incoming.length > 0,
      hasOutgoing: outgoing.length > 0,
      incomingConfidenceMax: maxConfidence(incoming),
      outgoingConfidenceMax: maxConfidence(outgoing),
      incomingRelationshipTypes: uniqueBy(incoming, (rel) => rel.type).map(
        (rel) => rel.type
      ),
      outgoingRelationshipTypes: uniqueBy(outgoing, (rel) => rel.type).map(
        (rel) => rel.type
      ),
      evidenceText: collectTextHints(
        component.evidenceText,
        incoming.map((rel) => rel.evidenceText),
        outgoing.map((rel) => rel.evidenceText),
        incoming.map((rel) => rel.type),
        outgoing.map((rel) => rel.type)
      ),
    });
  }

  return metricsById;
}

function maxConfidence(rels) {
  if (!rels.length) return "unknown";

  const best = rels
    .slice()
    .sort((a, b) => b.confidenceScore - a.confidenceScore)[0];

  return best?.confidence || "unknown";
}

function classifyStructuralRole(component, metrics) {
  const text = collectTextHints(
    component?.declaredRole,
    component?.evidenceText,
    metrics?.evidenceText
  );

  const incoming = metrics?.incomingCount || 0;
  const outgoing = metrics?.outgoingCount || 0;

  const hasStateEvidence = containsAny(text, [
    "state",
    "store",
    "stored",
    "storage",
    "persist",
    "persistence",
    "record",
    "records",
    "read",
    "write",
    "database",
    "data",
    "cache",
    "index",
    "queue",
    "bucket",
  ]);

  const hasControlEvidence = containsAny(text, [
    "route",
    "routing",
    "policy",
    "control",
    "auth",
    "authorize",
    "authenticate",
    "validate",
    "validation",
    "check",
    "gateway",
    "proxy",
    "broker",
    "dispatch",
    "orchestrate",
    "load balance",
    "fanout",
  ]);

  const hasBoundaryEvidence = containsAny(text, [
    "entry",
    "ingress",
    "external",
    "client",
    "user",
    "edge",
    "boundary",
    "front door",
    "public",
    "interface",
  ]);

  if (incoming === 0 && outgoing === 0) {
    return STRUCTURAL_ROLES.ISOLATED;
  }

  if (hasStateEvidence && incoming > 0 && outgoing <= 1) {
    return STRUCTURAL_ROLES.STATE;
  }

  if (outgoing === 0 && incoming > 0) {
    return hasStateEvidence ? STRUCTURAL_ROLES.STATE : STRUCTURAL_ROLES.TERMINAL;
  }

  if (incoming === 0 && outgoing > 0) {
    return STRUCTURAL_ROLES.SOURCE;
  }

  if (outgoing > 1) {
    return STRUCTURAL_ROLES.FANOUT;
  }

  if (hasControlEvidence && incoming > 0 && outgoing > 0) {
    return STRUCTURAL_ROLES.CONTROL;
  }

  if (hasBoundaryEvidence && incoming <= 1 && outgoing > 0) {
    return STRUCTURAL_ROLES.BOUNDARY;
  }

  if (incoming > 0 && outgoing > 0) {
    return STRUCTURAL_ROLES.PROCESSING;
  }

  return STRUCTURAL_ROLES.PROCESSING;
}

function annotateComponentsWithStructuralRoles(componentIndex, relationships, adjacency) {
  const graphMetrics = computeGraphMetrics(componentIndex, relationships, adjacency);

  const components = componentIndex.components.map((component) => {
    const metrics = graphMetrics.get(component.id);
    const structuralRole = classifyStructuralRole(component, metrics);

    return {
      ...component,
      role: structuralRole,
      declaredRole: component.declaredRole,
      structuralRole,
      graphMetrics: metrics,
    };
  });

  const byId = new Map();
  const byNameKey = new Map();

  for (const component of components) {
    byId.set(component.id, component);
    byNameKey.set(normalizeKey(component.name), component);
  }

  return {
    components,
    byId,
    byNameKey,
    graphMetrics,
  };
}

function choosePrimaryEntryComponent(componentIndex, adjacency) {
  const scored = componentIndex.components.map((component) => {
    const metrics = component.graphMetrics || {};
    let score = 0;

    if (component.structuralRole === STRUCTURAL_ROLES.SOURCE) score += 6;
    if (component.structuralRole === STRUCTURAL_ROLES.BOUNDARY) score += 4;
    if ((metrics.incomingCount || 0) === 0) score += 3;
    if ((metrics.outgoingCount || 0) > 0) score += 3;

    score += Math.min(confidenceScore(component.confidence), 3) * 0.25;

    return { component, score };
  });

  const best = scored
    .filter((item) => item.score > 0 && adjacency.outgoing.has(item.component.id))
    .sort((a, b) => b.score - a.score)[0];

  return best?.component || null;
}

function rankCandidatePaths(paths) {
  return paths.sort((a, b) => {
    const lengthDelta = b.segments.length - a.segments.length;
    if (lengthDelta !== 0) return lengthDelta;

    const confidenceDelta = b.averageConfidenceScore - a.averageConfidenceScore;
    if (confidenceDelta !== 0) return confidenceDelta;

    return a.entryComponent.name.localeCompare(b.entryComponent.name);
  });
}

function buildCandidatePath(entryComponent, componentIndex, adjacency, maxDepth = 12) {
  const segments = [];
  const visited = new Set();

  let current = entryComponent;
  let depth = 0;

  while (current && depth < maxDepth) {
    visited.add(current.id);

    const nextEdges = asArray(adjacency.outgoing.get(current.id))
      .filter((edge) => !visited.has(edge.targetId))
      .sort((a, b) => {
        const confidenceDelta = b.confidenceScore - a.confidenceScore;
        if (confidenceDelta !== 0) return confidenceDelta;

        const targetA = componentIndex.byId.get(a.targetId);
        const targetB = componentIndex.byId.get(b.targetId);

        return structuralRolePriority(targetB?.structuralRole) -
          structuralRolePriority(targetA?.structuralRole);
      });

    if (!nextEdges.length) break;

    const edge = nextEdges[0];
    const nextComponent = componentIndex.byId.get(edge.targetId);

    if (!nextComponent) break;

    segments.push(buildSegment(segments.length, current, nextComponent, edge));

    current = nextComponent;
    depth += 1;
  }

  const totalConfidence = segments.reduce(
    (sum, segment) => sum + confidenceScore(segment.confidence),
    0
  );

  return {
    entryComponent,
    segments,
    averageConfidenceScore: segments.length
      ? totalConfidence / segments.length
      : 0,
  };
}

function structuralRolePriority(role) {
  switch (role) {
    case STRUCTURAL_ROLES.BOUNDARY:
      return 7;
    case STRUCTURAL_ROLES.CONTROL:
      return 6;
    case STRUCTURAL_ROLES.FANOUT:
      return 5;
    case STRUCTURAL_ROLES.PROCESSING:
      return 4;
    case STRUCTURAL_ROLES.STATE:
      return 3;
    case STRUCTURAL_ROLES.TERMINAL:
      return 2;
    case STRUCTURAL_ROLES.SOURCE:
      return 1;
    default:
      return 0;
  }
}

function buildSegment(index, fromComponent, toComponent, edge) {
  return {
    id: `segment_${index + 1}_${normalizeKey(fromComponent.name)}_to_${normalizeKey(
      toComponent.name
    )}`,
    from: serializeComponentForFlow(fromComponent),
    to: serializeComponentForFlow(toComponent),
    relationshipType: edge.type,
    confidence: edge.confidence,
    evidenceIds: edge.evidenceIds,
    structuralHandoff: inferStructuralHandoff(fromComponent, toComponent, edge),
    teachingPurpose: inferTeachingPurpose(fromComponent, toComponent, edge),
  };
}

function serializeComponentForFlow(component) {
  return {
    id: component.id,
    name: component.name,
    role: component.structuralRole || component.role,
    declaredRole: component.declaredRole,
    structuralRole: component.structuralRole || component.role,
    page: component.page,
  };
}

function inferStructuralHandoff(fromComponent, toComponent) {
  const fromRole = fromComponent?.structuralRole || fromComponent?.role;
  const toRole = toComponent?.structuralRole || toComponent?.role;

  return `${fromRole}_to_${toRole}`;
}

function inferTeachingPurpose(fromComponent, toComponent) {
  const fromRole = fromComponent?.structuralRole || fromComponent?.role;
  const toRole = toComponent?.structuralRole || toComponent?.role;

  if (fromRole === STRUCTURAL_ROLES.SOURCE || toRole === STRUCTURAL_ROLES.BOUNDARY) {
    return "explain_how_the_flow_enters_or_crosses_the_system_boundary";
  }

  if (
    toRole === STRUCTURAL_ROLES.CONTROL ||
    toRole === STRUCTURAL_ROLES.FANOUT
  ) {
    return "explain_control_routing_or_decision_point";
  }

  if (toRole === STRUCTURAL_ROLES.PROCESSING) {
    return "explain_internal_processing_or_service_handoff";
  }

  if (
    toRole === STRUCTURAL_ROLES.STATE ||
    toRole === STRUCTURAL_ROLES.TERMINAL
  ) {
    return "explain_final_destination_state_or_terminal_outcome";
  }

  return "explain_documented_component_handoff";
}

function buildPrimaryArchitectureFlow(componentIndex, adjacency) {
  const primaryEntry = choosePrimaryEntryComponent(componentIndex, adjacency);

  const entryCandidates = uniqueBy(
    [
      primaryEntry,
      ...componentIndex.components.filter(
        (component) =>
          component.structuralRole === STRUCTURAL_ROLES.SOURCE ||
          component.structuralRole === STRUCTURAL_ROLES.BOUNDARY
      ),
    ].filter(Boolean),
    (component) => component.id
  );

  const candidatePaths = entryCandidates
    .map((entryComponent) => buildCandidatePath(entryComponent, componentIndex, adjacency))
    .filter((path) => path.segments.length > 0);

  const ranked = rankCandidatePaths(candidatePaths);
  const primary = ranked[0] || null;

  if (!primary) return [];

  return [
    {
      flowGroupId: `architecture_primary_flow_${normalizeKey(
        primary.entryComponent.name
      )}`,
      flowType: "primary_architecture_walkthrough",
      entryComponent: serializeComponentForFlow(primary.entryComponent),
      confidence: summarizeConfidence(
        primary.segments.map((segment) => segment.confidence)
      ),
      segments: primary.segments,
      isPrimary: true,
    },
  ];
}


function buildFlowGroupsFromExplicitSequences(
  architectureUnderstanding = {},
  componentIndex
) {
  const explicitSequences =
    architectureUnderstanding?.explicitSequences ||
    architectureUnderstanding?.traversalInputs?.explicitSequences ||
    [];

  if (!explicitSequences.length) return [];

  return explicitSequences.map((sequence, sequenceIndex) => {
    const items = sequence.items || [];
    const segments = [];

    for (let i = 0; i < items.length - 1; i += 1) {
      const current = items[i];
      const next = items[i + 1];

      const currentEntities = current.entities || [];
      const nextEntities = next.entities || [];

      const currentEntity =
        currentEntities[currentEntities.length - 1];

      let nextEntity =
        nextEntities[0];

      if (
        currentEntity &&
        nextEntity &&
        currentEntity.id === nextEntity.id
        ) {
        nextEntity =
            nextEntities.find(
            (candidate) => candidate.id !== currentEntity.id
            ) || nextEntity;
        }

      if (!currentEntity || !nextEntity) continue;

      const fromComponent =
        componentIndex.byId.get(currentEntity.id) || {
          id: currentEntity.id,
          name: currentEntity.name,
          structuralRole: currentEntity.role,
          role: currentEntity.role,
        };

      const toComponent =
        componentIndex.byId.get(nextEntity.id) || {
            id: nextEntity.id,
            name: nextEntity.name,
            structuralRole: nextEntity.role,
            role: nextEntity.role,
        };

        if (fromComponent.id === toComponent.id) {
        continue;
        }

        segments.push({
        id: `explicit_sequence_segment_${sequenceIndex + 1}_${i + 1}`,
        from: serializeComponentForFlow(fromComponent),
        to: serializeComponentForFlow(toComponent),
        relationshipType: "explicit_document_sequence",
        confidence: sequence.confidence || "deterministic",
        evidenceIds: [current.evidenceId, next.evidenceId].filter(Boolean),
        structuralHandoff: inferStructuralHandoff(
          fromComponent,
          toComponent
        ),
        teachingPurpose: inferTeachingPurpose(
          fromComponent,
          toComponent
        ),
        source: "explicit_document_sequence",
      });
    }

    return {
      flowGroupId:
        sequence.id ||
        `explicit_sequence_flow_${sequenceIndex + 1}`,
      flowType: "explicit_document_sequence",
      title: sequence.title || `Sequence ${sequenceIndex + 1}`,
      confidence: sequence.confidence || "deterministic",
      segments,
      isPrimary: sequenceIndex === 0,
      source: sequence.source || "document_sequence",
    };
  });
}

function classifySegmentChapter(segment) {
  const fromRole = segment?.from?.structuralRole || segment?.from?.role;
  const toRole = segment?.to?.structuralRole || segment?.to?.role;

  if (
    fromRole === STRUCTURAL_ROLES.SOURCE ||
    toRole === STRUCTURAL_ROLES.BOUNDARY
  ) {
    return CHAPTER_TYPES.ENTRY_BOUNDARY;
  }

  if (
    toRole === STRUCTURAL_ROLES.CONTROL ||
    toRole === STRUCTURAL_ROLES.FANOUT ||
    fromRole === STRUCTURAL_ROLES.CONTROL ||
    fromRole === STRUCTURAL_ROLES.FANOUT
  ) {
    return CHAPTER_TYPES.CONTROL_ROUTING;
  }

  if (
    toRole === STRUCTURAL_ROLES.STATE ||
    toRole === STRUCTURAL_ROLES.TERMINAL
  ) {
    return CHAPTER_TYPES.STATE_TERMINAL;
  }

  return CHAPTER_TYPES.PROCESSING;
}

function groupSegmentsIntoChapters(segments) {
  const buckets = new Map();

  for (const segment of segments) {
    const chapterType = classifySegmentChapter(segment);
    if (!buckets.has(chapterType)) buckets.set(chapterType, []);
    buckets.get(chapterType).push(segment);
  }

  const chapterOrder = [
    CHAPTER_TYPES.ENTRY_BOUNDARY,
    CHAPTER_TYPES.CONTROL_ROUTING,
    CHAPTER_TYPES.PROCESSING,
    CHAPTER_TYPES.STATE_TERMINAL,
  ];

  return chapterOrder
    .filter((chapterType) => asArray(buckets.get(chapterType)).length > 0)
    .map((chapterType, index) => {
      const chapterSegments = buckets.get(chapterType);

      return {
        id: `architecture_chapter_${index + 1}_${chapterType}`,
        type: chapterType,
        title: getChapterTitle(chapterType),
        purpose: getChapterPurpose(chapterType),
        segments: chapterSegments,
        confidence: summarizeConfidence(
          chapterSegments.map((segment) => segment.confidence)
        ),
        primaryEntities: uniqueBy(
          chapterSegments.flatMap((segment) => [segment.from, segment.to]),
          (entity) => entity.id
        ),
      };
    });
}

function getChapterTitle(chapterType) {
  switch (chapterType) {
    case CHAPTER_TYPES.ENTRY_BOUNDARY:
      return "Entry and Boundary";
    case CHAPTER_TYPES.CONTROL_ROUTING:
      return "Control and Routing";
    case CHAPTER_TYPES.PROCESSING:
      return "Processing Path";
    case CHAPTER_TYPES.STATE_TERMINAL:
      return "State or Terminal Destination";
    case CHAPTER_TYPES.RECAP:
      return "Architecture Recap";
    case CHAPTER_TYPES.OVERVIEW:
    default:
      return "Full Architecture Overview";
  }
}

function getChapterPurpose(chapterType) {
  switch (chapterType) {
    case CHAPTER_TYPES.ENTRY_BOUNDARY:
      return "Teach where the documented flow starts and how it enters the system.";
    case CHAPTER_TYPES.CONTROL_ROUTING:
      return "Teach where the flow is routed, checked, split, or coordinated.";
    case CHAPTER_TYPES.PROCESSING:
      return "Teach how work moves through internal execution or service handoffs.";
    case CHAPTER_TYPES.STATE_TERMINAL:
      return "Teach where the flow reaches state, persistence, or its terminal outcome.";
    case CHAPTER_TYPES.RECAP:
      return "Summarize the architecture as a simple mental model.";
    case CHAPTER_TYPES.OVERVIEW:
    default:
      return "Establish the system before walking through individual flows.";
  }
}

function summarizeConfidence(confidences) {
  const scores = confidences.map(confidenceScore).filter(Number.isFinite);

  if (!scores.length) return "unknown";

  const min = Math.min(...scores);

  if (min >= confidenceScore("high")) return "high";
  if (min >= confidenceScore("medium")) return "medium";
  if (min >= confidenceScore("low")) return "low";
  return "unknown";
}

function buildOverviewChapter(componentIndex, relationships) {
  const primaryEntities = componentIndex.components
    .slice()
    .sort((a, b) => {
      const degreeDelta =
        (b.graphMetrics?.degree || 0) - (a.graphMetrics?.degree || 0);
      if (degreeDelta !== 0) return degreeDelta;

      const confidenceDelta =
        confidenceScore(b.confidence) - confidenceScore(a.confidence);
      if (confidenceDelta !== 0) return confidenceDelta;

      return getComponentName(a).localeCompare(getComponentName(b));
    })
    .slice(0, 8)
    .map(serializeComponentForFlow);

  return {
    id: "architecture_chapter_0_overview",
    type: CHAPTER_TYPES.OVERVIEW,
    title: "Full Architecture Overview",
    purpose: getChapterPurpose(CHAPTER_TYPES.OVERVIEW),
    segments: [],
    confidence: relationships.some(
      (rel) => rel.confidenceScore >= confidenceScore("high")
    )
      ? "high"
      : "medium",
    primaryEntities,
  };
}

function buildRecapChapter(flowChapters) {
  const recapEntities = uniqueBy(
    flowChapters.flatMap((chapter) => chapter.primaryEntities || []),
    (entity) => entity.id
  ).slice(0, 8);

  return {
    id: "architecture_chapter_recap",
    type: CHAPTER_TYPES.RECAP,
    title: "Architecture Recap",
    purpose: getChapterPurpose(CHAPTER_TYPES.RECAP),
    segments: [],
    confidence: summarizeConfidence(flowChapters.map((chapter) => chapter.confidence)),
    primaryEntities: recapEntities,
    recapMentalModel: buildRecapMentalModel(flowChapters),
  };
}

function buildRecapMentalModel(flowChapters) {
  const hasEntry = flowChapters.some(
    (chapter) => chapter.type === CHAPTER_TYPES.ENTRY_BOUNDARY
  );
  const hasControl = flowChapters.some(
    (chapter) => chapter.type === CHAPTER_TYPES.CONTROL_ROUTING
  );
  const hasProcessing = flowChapters.some(
    (chapter) => chapter.type === CHAPTER_TYPES.PROCESSING
  );
  const hasTerminal = flowChapters.some(
    (chapter) => chapter.type === CHAPTER_TYPES.STATE_TERMINAL
  );

  const parts = [];

  if (hasEntry) parts.push("entry or boundary");
  if (hasControl) parts.push("control or routing point");
  if (hasProcessing) parts.push("processing path");
  if (hasTerminal) parts.push("state or terminal destination");

  if (!parts.length) {
    return "Remember the architecture as connected components with documented handoffs between them.";
  }

  return `Remember the architecture as: ${parts.join(" → ")}.`;
}

function flattenFlowSegments(flowGroups) {
  return uniqueBy(
    flowGroups.flatMap((group) => group.segments || []),
    (segment) => `${segment.from.id}->${segment.to.id}:${segment.relationshipType}`
  );
}

function buildWarnings(componentIndex, relationships, flowGroups, chapters) {
  const warnings = [];

  if (!componentIndex.components.length) {
    warnings.push({
      code: "NO_COMPONENTS",
      message: "No architecture components were available to build a walkthrough.",
    });
  }

  if (!relationships.length) {
    warnings.push({
      code: "NO_USABLE_RELATIONSHIPS",
      message:
        "No medium-or-higher confidence relationships were available for flow traversal.",
    });
  }

  if (!flowGroups.length) {
    warnings.push({
      code: "NO_FLOW_GROUPS",
      message:
        "No architecture flow groups were created. Lesson graph should use overview fallback.",
    });
  }

  if (chapters.length <= 2) {
    warnings.push({
      code: "LIMITED_ARCHITECTURE_CHAPTERS",
      message:
        "Only overview/recap or limited chapters were created. Narration should stay conservative.",
    });
  }

  return warnings;
}

function buildArchitectureFlow(architectureUnderstanding = {}, options = {}) {
  const rawComponentIndex = buildComponentIndex(architectureUnderstanding);
  const rawRelationships = buildRelationshipList(
    architectureUnderstanding,
    rawComponentIndex
  );
  const rawAdjacency = buildAdjacency(rawRelationships);

  const componentIndex = annotateComponentsWithStructuralRoles(
    rawComponentIndex,
    rawRelationships,
    rawAdjacency
  );

  const relationships = buildRelationshipList(
    architectureUnderstanding,
    componentIndex
  );
  const adjacency = buildAdjacency(relationships);

  
  let flowGroups = buildFlowGroupsFromExplicitSequences(
    architectureUnderstanding,
    componentIndex
    );

    if (!flowGroups.length) {
    flowGroups = buildPrimaryArchitectureFlow(
        componentIndex,
        adjacency
    );
 }
  const allSegments = flattenFlowSegments(flowGroups);
  const flowChapters = groupSegmentsIntoChapters(allSegments);

  const overviewChapter = buildOverviewChapter(componentIndex, relationships);
  const recapChapter = buildRecapChapter(flowChapters);

  const chapters = [overviewChapter, ...flowChapters, recapChapter];

  return {
    schemaVersion: "architecture-flow-v2-structural-roles",
    generatedAt: new Date().toISOString(),
    source: "architectureFlowBuilder",
    strategy: {
      roleClassification: "domain_independent_graph_behavior_plus_evidence",
      internalGranularity: "fine_grained_graph_segments",
      pedagogicalGranularity: "coarse_walkthrough_chapters",
      renderingSafety: "page_by_page_safe_v1",
      recapStyle: "simplified_big_picture_mental_model",
      canonicalFlow: "single_primary_walkthrough_v1",
    },
    stats: {
      componentCount: componentIndex.components.length,
      relationshipCount: relationships.length,
      flowGroupCount: flowGroups.length,
      segmentCount: allSegments.length,
      chapterCount: chapters.length,
      structuralRoleBreakdown: buildStructuralRoleBreakdown(componentIndex.components),
    },
    flowGroups,
    chapters,
    warnings: buildWarnings(componentIndex, relationships, flowGroups, chapters),
    debug: options.includeDebug
      ? {
          components: componentIndex.components,
          relationships,
        }
      : undefined,
  };
}

function buildStructuralRoleBreakdown(components) {
  return components.reduce((acc, component) => {
    const role = component.structuralRole || component.role || "unknown";
    acc[role] = (acc[role] || 0) + 1;
    return acc;
  }, {});
}

module.exports = {
  buildArchitectureFlow,
  CHAPTER_TYPES,
  STRUCTURAL_ROLES,
};
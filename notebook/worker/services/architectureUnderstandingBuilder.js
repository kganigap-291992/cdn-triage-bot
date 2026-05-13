const RELATIONSHIP_CONFIDENCE = {
  explicit_definition: "high",
  explicit_flow: "high",
  same_section_co_mention: "medium",
  repeated_cross_page_co_mention: "medium_low",
  diagram_adjacency_only: "low",
};

const GRAPH_ELIGIBLE_ROLES = new Set([
  "system_component",
  "external_actor",
  "interface",
  "data_store",
  "process_step",
  "data_object",
  "protocol_or_standard",
]);

function normalizeText(value) {
  return String(value || "").trim();
}

function lower(value) {
  return normalizeText(value).toLowerCase();
}

function uniqueBy(items, keyFn) {
  const seen = new Set();
  const out = [];

  for (const item of items || []) {
    const key = keyFn(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }

  return out;
}

function getEvidenceText(evidence) {
  return normalizeText(evidence?.text || evidence?.content || evidence?.label || "");
}

function getEvidenceForComponent(component, evidence = []) {
  const ids = new Set(component.evidenceIds || []);
  const name = lower(component.name);

  return evidence.filter((item) => {
    if (ids.has(item.id)) return true;
    return lower(getEvidenceText(item)).includes(name);
  });
}

function getEvidenceStructuralWeight(item = {}) {
  const type = lower(item.type);
  const source = lower(item.source);
  const text = lower(getEvidenceText(item));

  if (source.includes("diagram") || type.includes("diagram")) return 1.0;
  if (type.includes("figure") || text.includes("diagram")) return 0.9;
  if (type.includes("caption")) return 0.8;
  if (type.includes("heading") || type.includes("section")) return 0.35;
  if (type.includes("table_header") || text === "type" || text === "value" || text === "format") return 0.15;
  if (type.includes("metadata")) return 0.1;

  return 0.5;
}

function computeComponentStructuralScore(component, evidenceItems = []) {
  const weights = evidenceItems.map(getEvidenceStructuralWeight);
  const totalWeight = weights.reduce((sum, value) => sum + value, 0);

  const name = lower(component.name);
  const labelPenalty =
    /^(type|value|format|architecture|overview|production|notes|source|content)$/i.test(component.name)
      ? 0.75
      : 0;

  const longValuePenalty =
    component.name.length > 48 || /[0-9]{8,}/.test(component.name)
      ? 0.5
      : 0;

  return Math.max(0, Number((totalWeight - labelPenalty - longValuePenalty).toFixed(2)));
}

function isLikelyJunkArchitectureCandidate(component) {
  const name = normalizeText(component.name);

  if (!name) return true;

  // Full sentences should not become graph nodes.
  if (/[.!?]$/.test(name) && name.split(/\s+/).length > 4) return true;

  // Issue paths / URLs / ticket-ish references should not become architecture components.
  if (/\/issues\/\d+/i.test(name)) return true;
  if (/https?:\/\//i.test(name)) return true;

  // Generic table/header/meta labels.
    if (/^(item|type|value|values|format|source|content|application|only|team|production|qa|fqdn|id)$/i.test(name)) {
        return true;
    }

  // Partial/generated fragment labels.
    if (/^(new|old)\s+/i.test(name) && name.split(/\s+/).length <= 5) {
         return true;
    }

  // Very long generated IDs are usually values, not teachable components.
  if (name.length > 42 && /[0-9_-]{6,}/.test(name)) return true;

  return false;
}

function looksLikeArchitectureCandidate(value) {
  const text = normalizeText(value);
  if (!text || text.length < 2 || text.length > 120) return false;
  if (/^\d+$/.test(text)) return false;
  if (/^(page|section|figure|table)\s+\d+$/i.test(text)) return false;

  const hasLetters = /[a-zA-Z]/.test(text);
  if (!hasLetters) return false;

  const namedLabel =
    /^[A-Z][A-Za-z0-9_ ()/#.-]{2,}$/.test(text) ||
    /^[A-Z0-9]{2,16}$/.test(text) ||
    /^[a-zA-Z0-9]+[-_/#][a-zA-Z0-9_/#.-]+$/.test(text);

  const genericArchitectureWords =
    /\b(system|service|client|server|gateway|proxy|api|database|store|queue|worker|processor|controller|engine|platform|module|component|cluster|node|layer|pipeline|router|broker|adapter|connector|provider|consumer|source|sink|endpoint|application|app|interface|workflow|process|job|task)\b/i;

  return namedLabel || genericArchitectureWords.test(text);
}

function classifyArchitectureRole(component, evidenceItems = []) {
  const name = normalizeText(component.name);
  const text = lower(name);
  const sourceType = lower(component.type);
  const evidenceText = lower(evidenceItems.map(getEvidenceText).join(" "));

  const personLike = /^[A-Z][a-z]+ [A-Z][a-z]+/.test(name);
  if (personLike) return "person_or_team";

  const documentSectionSignals =
    /\b(overview|notes|possible|future|resource|wiki|ownership|configuration|details|expectations|table of contents|agenda|introduction|summary|examples|appendix|version|history)\b/i;

  if (sourceType === "section" && documentSectionSignals.test(name)) {
    return "document_section";
  }

  const looksLikeLongValue =
    name.length > 48 ||
    /[0-9]{8,}/.test(name) ||
    /https?:\/\//i.test(name) ||
    /[?&=]/.test(name);

  if (looksLikeLongValue) return "configuration_or_value";

  if (/\b(api|endpoint|request|response|interface|contract|url|uri|path)\b/i.test(`${name} ${evidenceText}`)) {
    return "interface";
  }

  if (/\b(store|stored|persist|database|table|bucket|blob|volume|repository)\b/i.test(evidenceText)) {
    return "data_store";
  }

  if (/\b(input|output|payload|message|event|file|manifest|object|record|sample|asset|token|id)\b/i.test(`${name} ${evidenceText}`)) {
    return "data_object";
  }

  if (/\b(protocol|standard|format|codec|transport|over|via)\b/i.test(evidenceText)) {
    return "protocol_or_standard";
  }

  if (/\b(step|stage|workflow|process|job|task|operation|action|generate|create|ingest|publish|deploy|validate)\b/i.test(`${name} ${evidenceText}`)) {
    return "process_step";
  }

  if (/\b(client|consumer|user|provider|external|source|sink|upstream|downstream)\b/i.test(`${name} ${evidenceText}`)) {
    return "external_actor";
  }

  if (/\b(service|server|gateway|proxy|controller|worker|processor|engine|component|module|platform|application|app|cluster|node|layer|system)\b/i.test(`${name} ${evidenceText}`)) {
    return "system_component";
  }

  if (/^[A-Z0-9]{2,12}$/.test(name)) return "system_component";
  if (/^[A-Za-z0-9]+[-_/#][A-Za-z0-9_/#.-]+$/.test(name)) return "system_component";

  return "unknown";
}

function isGraphEligibleRole(role) {
  return GRAPH_ELIGIBLE_ROLES.has(role);
}

function extractComponents(documentUnderstanding = {}) {
  const entities = documentUnderstanding.entities || [];
  const evidence = documentUnderstanding.evidence || [];

  const fromEntities = entities
    .map((entity) => ({
      id: entity.id,
      name: normalizeText(entity.name || entity.label || entity.text),
      source: "entity",
      type: entity.type || "component",
      evidenceIds: entity.evidenceIds || [entity.evidenceId].filter(Boolean),
      confidence: entity.confidence || "medium",
    }))
    .filter((component) => looksLikeArchitectureCandidate(component.name));

  const fromEvidence = evidence
    .map((item) => ({
      id: null,
      name: getEvidenceText(item),
      source: "evidence",
      type: item.type || "component",
      evidenceIds: [item.id].filter(Boolean),
      confidence: item.confidence || "medium_low",
    }))
    .filter((component) => looksLikeArchitectureCandidate(component.name));

  return uniqueBy([...fromEntities, ...fromEvidence], (component) => lower(component.name))
    .map((component, index) => {
      const componentEvidence = getEvidenceForComponent(component, evidence);
      const role = classifyArchitectureRole(component, componentEvidence);
      const structuralScore = computeComponentStructuralScore(component, componentEvidence);

      return {
        id: component.id || `arch_component_${index + 1}`,
        name: component.name,
        type: component.type || "component",
        role,
        graphEligible:
            isGraphEligibleRole(role) &&
            structuralScore >= 0.5 &&
            !isLikelyJunkArchitectureCandidate(component),
        structuralScore,
        source: component.source,
        evidenceIds: component.evidenceIds || [],
        confidence: component.confidence || "medium",
      };
    })
    .filter((component) => component.graphEligible);
}

function evidenceMentionsComponent(evidence, component) {
  return lower(getEvidenceText(evidence)).includes(lower(component.name));
}

function makeRelationship({
  source,
  target,
  type,
  reason,
  evidenceIds,
  inferred,
  direction = "unknown",
}) {
  return {
    id: `arch_rel_${source.id}_${target.id}_${reason}`.replace(/[^a-zA-Z0-9_]/g, "_"),
    sourceId: source.id,
    sourceName: source.name,
    sourceRole: source.role,
    targetId: target.id,
    targetName: target.name,
    targetRole: target.role,
    type,
    direction,
    inferred: Boolean(inferred),
    confidence: RELATIONSHIP_CONFIDENCE[reason] || "low",
    reason,
    evidenceIds: uniqueBy(evidenceIds || [], (id) => id),
  };
}

function extractExplicitRelationships(documentUnderstanding = {}, components = []) {
  const relationships = [];
  const sourceRelationships = documentUnderstanding.relationships || [];

  for (const relationship of sourceRelationships) {
    const sourceName = normalizeText(
      relationship.sourceName ||
        relationship.source ||
        relationship.from ||
        relationship.subject
    );

    const targetName = normalizeText(
      relationship.targetName ||
        relationship.target ||
        relationship.to ||
        relationship.object
    );

    if (!sourceName || !targetName) continue;

    const source = components.find((component) => lower(component.name) === lower(sourceName));
    const target = components.find((component) => lower(component.name) === lower(targetName));

    if (!source || !target) continue;

    const relationshipType = lower(relationship.type || relationship.relationship || "");

    const isFlow =
      relationshipType.includes("flow") ||
      relationshipType.includes("connect") ||
      relationshipType.includes("route") ||
      relationshipType.includes("send") ||
      relationshipType.includes("arrow");

    const isOnlyCoMention = relationshipType.includes("co_mentions");

    relationships.push(
      makeRelationship({
        source,
        target,
        type: isFlow ? "explicit_flow" : "architecture_association",
        reason: isFlow
          ? "explicit_flow"
          : isOnlyCoMention
            ? "same_section_co_mention"
            : "explicit_definition",
        evidenceIds: relationship.evidenceIds || [relationship.evidenceId].filter(Boolean),
        inferred: !isFlow && isOnlyCoMention,
        direction: isFlow ? "directed_or_implied" : "defined_association",
      })
    );
  }

  return relationships;
}

function extractSameSectionRelationships(documentUnderstanding = {}, components = []) {
  const relationships = [];
  const evidence = documentUnderstanding.evidence || [];
  const bySection = new Map();

  for (const item of evidence) {
    const sectionKey =
      item.sectionId ||
      item.sectionTitle ||
      item.heading ||
      `page_${item.page || "unknown"}`;

    if (!bySection.has(sectionKey)) bySection.set(sectionKey, []);
    bySection.get(sectionKey).push(item);
  }

  for (const sectionItems of bySection.values()) {
    const mentioned = components.filter((component) =>
      sectionItems.some((item) => evidenceMentionsComponent(item, component))
    );

    if (mentioned.length < 2 || mentioned.length > 6) continue;

    const evidenceIds = sectionItems.map((item) => item.id).filter(Boolean);

    for (let i = 0; i < mentioned.length; i += 1) {
      for (let j = i + 1; j < mentioned.length; j += 1) {
        relationships.push(
          makeRelationship({
            source: mentioned[i],
            target: mentioned[j],
            type: "architecture_association",
            reason: "same_section_co_mention",
            evidenceIds,
            inferred: true,
            direction: "undirected",
          })
        );
      }
    }
  }

  return relationships;
}

function extractCrossPageRelationships(documentUnderstanding = {}, components = []) {
  const evidence = documentUnderstanding.evidence || [];
  const pairMap = new Map();

  for (const item of evidence) {
    const mentioned = components.filter((component) => evidenceMentionsComponent(item, component));
    if (mentioned.length < 2 || mentioned.length > 8) continue;

    for (let i = 0; i < mentioned.length; i += 1) {
      for (let j = i + 1; j < mentioned.length; j += 1) {
        const names = [lower(mentioned[i].name), lower(mentioned[j].name)].sort();
        const key = `${names[0]}::${names[1]}`;

        if (!pairMap.has(key)) {
          pairMap.set(key, {
            source: mentioned[i],
            target: mentioned[j],
            pages: new Set(),
            evidenceIds: [],
          });
        }

        const pair = pairMap.get(key);
        pair.pages.add(item.page || "unknown");
        if (item.id) pair.evidenceIds.push(item.id);
      }
    }
  }

  return [...pairMap.values()]
    .filter((pair) => pair.pages.size >= 2)
    .map((pair) =>
      makeRelationship({
        source: pair.source,
        target: pair.target,
        type: "architecture_association",
        reason: "repeated_cross_page_co_mention",
        evidenceIds: pair.evidenceIds,
        inferred: true,
        direction: "undirected",
      })
    );
}


function extractDirectionalFlowRelationships(documentUnderstanding = {}, components = []) {
  const evidence = documentUnderstanding.evidence || [];
  const relationships = [];

  const flowPattern =
    /\b(provides|sends|passes|routes|connects|publishes|delivers|forwards|pushes|calls|writes|reads|ingests|feeds|uses)\b/i;

  for (const item of evidence) {
    const text = getEvidenceText(item);
    if (!text) continue;

    const hasArrow = /→|->|=>/.test(text);
    const hasFlowWord = flowPattern.test(text);

    if (!hasArrow && !hasFlowWord) continue;

    const mentioned = components
      .map((component) => ({
        component,
        index: lower(text).indexOf(lower(component.name)),
      }))
      .filter((entry) => entry.index >= 0)
      .sort((a, b) => a.index - b.index);

    if (mentioned.length < 2 || mentioned.length > 6) continue;

    for (let i = 0; i < mentioned.length - 1; i += 1) {
      const source = mentioned[i].component;
      const target = mentioned[i + 1].component;

      relationships.push(
        makeRelationship({
          source,
          target,
          type: "explicit_flow",
          reason: "explicit_flow",
          evidenceIds: [item.id].filter(Boolean),
          inferred: false,
          direction: hasArrow ? "arrow_text_order" : "verb_text_order",
        })
      );
    }
  }

  return relationships;
}

function dedupeRelationships(relationships = []) {
  const priority = {
    explicit_flow: 5,
    explicit_definition: 5,
    same_section_co_mention: 3,
    repeated_cross_page_co_mention: 2,
    diagram_adjacency_only: 1,
  };

  const byPair = new Map();

  for (const relationship of relationships) {
    const key = [lower(relationship.sourceName), lower(relationship.targetName)].sort().join("::");
    const existing = byPair.get(key);

    if (!existing || (priority[relationship.reason] || 0) > (priority[existing.reason] || 0)) {
      byPair.set(key, relationship);
    } else {
      byPair.set(key, {
        ...existing,
        evidenceIds: uniqueBy(
          [...(existing.evidenceIds || []), ...(relationship.evidenceIds || [])],
          (id) => id
        ),
      });
    }
  }

  return [...byPair.values()];
}

function buildNarrationHints(relationships = []) {
  const highConfidenceCount = relationships.filter((item) => item.confidence === "high").length;
  const lowConfidenceCount = relationships.filter((item) => item.confidence === "low").length;

  return {
    cautiousLanguageRequired: lowConfidenceCount > 0,
    allowedAnalogies:
      highConfidenceCount > 0
        ? [
            {
              rule: "Analogies and real-world examples are allowed only for high-confidence explicit relationships.",
              minConfidence: "high",
            },
          ]
        : [],
    forbiddenBehavior: [
      "Do not invent component responsibilities.",
      "Do not turn low-confidence inferred edges into facts.",
      "Do not use real-world analogies for low-confidence relationships.",
    ],
  };
}


function collectSpatialRelationshipCandidates(spatialUnderstanding) {
  if (!spatialUnderstanding || !Array.isArray(spatialUnderstanding.pages)) {
    return [];
  }

  return spatialUnderstanding.pages.flatMap((page) => {
    return (page.relationships || []).map((relationship) => ({
      id: relationship.id,
      page: relationship.page,
      regionId: relationship.regionId,
      connectorId: relationship.connectorId,
      type: relationship.type,
      source: relationship.source,
      confidence: relationship.confidence,
      signalCount: relationship.signalCount,
      signals: relationship.signals,
      evidenceText: relationship.evidenceText,
      bounds: relationship.bounds,
      derivedFrom: relationship.derivedFrom || [],
      architectureUse: "candidate_only",
    }));
  });
}

function buildArchitectureUnderstanding(
  documentUnderstanding = {},
  spatialUnderstanding = {}
) {
  const components = extractComponents(documentUnderstanding);

  const spatialRelationshipCandidates =
    collectSpatialRelationshipCandidates(spatialUnderstanding);

  const relationships = dedupeRelationships([
  ...extractExplicitRelationships(documentUnderstanding, components),
  ...extractDirectionalFlowRelationships(documentUnderstanding, components),
  ...extractSameSectionRelationships(documentUnderstanding, components),
  ...extractCrossPageRelationships(documentUnderstanding, components),
]);

  const flows = relationships.filter((relationship) => relationship.type === "explicit_flow");

  return {
    version: "architecture-understanding-v1-domain-neutral",
    sourceVersion: documentUnderstanding.version || null,

    deterministicGraph: {
    components,
    relationships,
    flows,
    },

    spatialRelationshipCandidates,

    semanticEnrichment: {
      hypotheses: [],
      note: "Future LLM hypotheses live here. They must never overwrite deterministicGraph.",
    },

    traversalInputs: {
      trafficFlow: flows,
      graphTopology: relationships.map((relationship) => ({
        sourceId: relationship.sourceId,
        targetId: relationship.targetId,
        sourceRole: relationship.sourceRole,
        targetRole: relationship.targetRole,
        confidence: relationship.confidence,
        inferred: relationship.inferred,
        reason: relationship.reason,
      })),
      readingOrder: components.map((component) => component.id),
      importance: components.map((component) => ({
        componentId: component.id,
        role: component.role,
        score: component.evidenceIds?.length || 1,
      })),
      confidence: relationships.map((relationship) => ({
        relationshipId: relationship.id,
        confidence: relationship.confidence,
        reason: relationship.reason,
      })),
      owner: "lessonGraphBuilder",
    },

    narrationHints: buildNarrationHints(relationships),

    stats: {
        componentCount: components.length,
        relationshipCount: relationships.length,
        flowCount: flows.length,

        spatialRelationshipCandidateCount:
            spatialRelationshipCandidates.length,

      inferredRelationshipCount: relationships.filter((item) => item.inferred).length,
      explicitRelationshipCount: relationships.filter((item) => !item.inferred).length,
      roleBreakdown: components.reduce((acc, item) => {
        acc[item.role] = (acc[item.role] || 0) + 1;
        return acc;
      }, {}),
      confidenceBreakdown: relationships.reduce((acc, item) => {
        acc[item.confidence] = (acc[item.confidence] || 0) + 1;
        return acc;
      }, {}),
      reasonBreakdown: relationships.reduce((acc, item) => {
        acc[item.reason] = (acc[item.reason] || 0) + 1;
        return acc;
      }, {}),
    },
  };
}

module.exports = {
  buildArchitectureUnderstanding,
  RELATIONSHIP_CONFIDENCE,
};
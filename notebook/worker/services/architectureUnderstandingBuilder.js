const RELATIONSHIP_CONFIDENCE = {
  explicit_definition: "high",
  explicit_flow: "high",
  directional_flow_text: "high",
  ordered_sequence: "medium",
  same_sentence_flow_context: "medium",
  same_section_flow_context: "medium",
  same_section_co_mention: "medium",
  continuity_repair: "medium",
  repeated_cross_page_co_mention: "medium",
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

const FLOW_VERBS = [
  "sends",
  "send",
  "passes",
  "pass",
  "routes",
  "route",
  "connects",
  "connect",
  "publishes",
  "publish",
  "delivers",
  "deliver",
  "forwards",
  "forward",
  "pushes",
  "push",
  "calls",
  "call",
  "writes",
  "write",
  "reads",
  "read",
  "ingests",
  "ingest",
  "feeds",
  "feed",
  "uses",
  "use",
  "returns",
  "return",
  "receives",
  "receive",
  "validates",
  "validate",
  "authenticates",
  "authenticate",
  "stores",
  "store",
  "persists",
  "persist",
  "hands off",
  "handoff",
  "flows",
  "flow",
];

function normalizeText(value) {
  return String(value || "").trim();
}

function lower(value) {
  return normalizeText(value).toLowerCase();
}

function normalizeKey(value) {
  return lower(value)
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
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
  if (
    type.includes("table_header") ||
    text === "type" ||
    text === "value" ||
    text === "format"
  ) {
    return 0.15;
  }
  if (type.includes("metadata")) return 0.1;

  return 0.5;
}

function computeComponentStructuralScore(component, evidenceItems = []) {
  const weights = evidenceItems.map(getEvidenceStructuralWeight);
  const totalWeight = weights.reduce((sum, value) => sum + value, 0);

  const labelPenalty =
    /^(type|value|format|architecture|overview|production|notes|source|content)$/i.test(
      component.name
    )
      ? 0.75
      : 0;

  const longValuePenalty =
    component.name.length > 48 || /[0-9]{8,}/.test(component.name) ? 0.5 : 0;

  return Math.max(0, Number((totalWeight - labelPenalty - longValuePenalty).toFixed(2)));
}

function isLikelyJunkArchitectureCandidate(component) {
  const name = normalizeText(component.name);

  if (!name) return true;
  if (/[.!?]$/.test(name) && name.split(/\s+/).length > 4) return true;
  if (/\/issues\/\d+/i.test(name)) return true;
  if (/https?:\/\//i.test(name)) return true;

  if (
    /^(item|type|value|values|format|source|content|application|only|team|production|qa|fqdn|id)$/i.test(
      name
    )
  ) {
    return true;
  }

  if (/^(new|old)\s+/i.test(name) && name.split(/\s+/).length <= 5) return true;
  if (name.length > 42 && /[0-9_-]{6,}/.test(name)) return true;

  return false;
}

function looksLikeArchitectureCandidate(value) {
  const text = normalizeText(value);
  if (!text || text.length < 2 || text.length > 160) return false;
  if (/^\d+$/.test(text)) return false;
  if (/^(page|section|figure|table)\s+\d+$/i.test(text)) return false;
  if (!/[a-zA-Z]/.test(text)) return false;

  const namedLabel =
    /^[A-Z][A-Za-z0-9_ ()/#.-]{2,}$/.test(text) ||
    /^[A-Z0-9]{2,16}$/.test(text) ||
    /^[a-zA-Z0-9]+[-_/#][a-zA-Z0-9_/#.-]+$/.test(text);

  const genericDocumentWords =
    /\b(system|service|client|server|gateway|proxy|api|database|store|queue|worker|processor|controller|engine|platform|module|component|cluster|node|layer|pipeline|router|broker|adapter|connector|provider|consumer|source|sink|endpoint|application|app|interface|workflow|process|job|task|step|stage|phase|procedure|protocol|policy|control|check|validation|review|approval|diagnosis|treatment|medication|symptom|condition|risk|mitigation|impact|cause|incident|timeline|handoff|owner|team|role|record|document|case|event|action|operation)\b/i;

  return namedLabel || genericDocumentWords.test(text);
}

function classifyArchitectureRole(component, evidenceItems = []) {
  const name = normalizeText(component.name);
  const text = lower(name);
  const sourceType = lower(component.type);
  const evidenceText = lower(evidenceItems.map(getEvidenceText).join(" "));

  if (/^[A-Z][a-z]+ [A-Z][a-z]+/.test(name)) return "person_or_team";

  const documentSectionSignals =
    /\b(overview|notes|possible|future|resource|wiki|ownership|configuration|details|expectations|table of contents|agenda|introduction|summary|examples|appendix|version|history)\b/i;

  if (sourceType === "section" && documentSectionSignals.test(name)) {
    return "document_section";
  }

  if (
    name.length > 48 ||
    /[0-9]{8,}/.test(name) ||
    /https?:\/\//i.test(name) ||
    /[?&=]/.test(name)
  ) {
    return "configuration_or_value";
  }

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
      confidence: item.confidence || "medium",
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

function findMentionedComponents(text, components = []) {
  const textLower = lower(text);

  return components
    .map((component) => ({
      component,
      index: textLower.indexOf(lower(component.name)),
      length: lower(component.name).length,
    }))
    .filter((entry) => entry.index >= 0)
    .sort((a, b) => {
      if (a.index !== b.index) return a.index - b.index;
      return b.length - a.length;
    })
    .filter((entry, index, entries) => {
      return !entries.some((other, otherIndex) => {
        if (otherIndex === index) return false;

        const entryStart = entry.index;
        const entryEnd = entry.index + entry.length;
        const otherStart = other.index;
        const otherEnd = other.index + other.length;

        const isInsideOther =
          entryStart >= otherStart &&
          entryEnd <= otherEnd &&
          other.length > entry.length;

        return isInsideOther;
      });
    });
}

function hasFlowLanguage(text) {
  const textLower = lower(text);
  return FLOW_VERBS.some((verb) => textLower.includes(verb));
}

function hasArrowSyntax(text) {
  return /→|->|=>|⇒|⟶/.test(text);
}

function hasSequenceMarker(text) {
  return /^\s*(step\s*)?\d+[\).:-]/i.test(text) || /^\s*[-*]\s+/i.test(text);
}

function splitIntoClauses(text) {
  return normalizeText(text)
    .split(/(?<=[.!?])\s+|;|\n+/)
    .map(normalizeText)
    .filter(Boolean);
}

function inferSequenceSource(text) {
  if (/^\s*(step\s*)?\d+[\).:-]/i.test(text)) return "numbered_list";
  if (/^\s*[-*]\s+/i.test(text)) return "bulleted_list";
  return "ordered_text";
}

function cleanSequenceText(text) {
  return normalizeText(text)
    .replace(/^\s*(step\s*)?\d+[\).:-]\s*/i, "")
    .replace(/^\s*[-*]\s+/, "")
    .trim();
}

function extractTitleCasePhrases(text) {
  const matches = normalizeText(text).match(
    /\b[A-Z][A-Za-z0-9]*(?:\s+[A-Z][A-Za-z0-9]*){1,5}\b/g
  );

  return uniqueBy(matches || [], (item) => lower(item))
    .filter((phrase) => {
      const wordCount = phrase.split(/\s+/).length;

      if (wordCount < 2) return false;
      if (phrase.length > 80) return false;

      return true;
    });
}

function buildFallbackSequenceEntities(text) {
  const phrases = extractTitleCasePhrases(text);

  if (phrases.length > 0) {
    return phrases.map((phrase) => ({
      component: {
        id: `sequence_entity_${normalizeKey(phrase).slice(0, 40)}`,
        name: phrase,
        role: "document_sequence_entity",
      },
    }));
  }

  return [
    {
      component: {
        id: `sequence_entity_${normalizeKey(text).slice(0, 40)}`,
        name: text,
        role: "document_sequence_entity",
      },
    },
  ];
}

function extractSequencePromotedComponents(explicitSequences = [], existingComponents = []) {
  const existingIds = new Set(existingComponents.map((component) => component.id));
  const promoted = [];

  for (const sequence of explicitSequences) {
    for (const item of sequence.items || []) {
      for (const entity of item.entities || []) {
        if (!entity?.id || !entity?.name) continue;
        if (existingIds.has(entity.id)) continue;
        if (entity.role !== "document_sequence_entity") continue;

        promoted.push({
          id: entity.id,
          name: entity.name,
          type: "sequence_entity",
          role: "process_step",
          graphEligible: true,
          structuralScore: 1,
          source: "explicit_sequence",
          evidenceIds: [item.evidenceId].filter(Boolean),
          confidence: sequence.confidence || "deterministic",
        });

        existingIds.add(entity.id);
      }
    }
  }

  return promoted;
}

function extractExplicitSequences(documentUnderstanding = {}, components = []) {
  const evidence = documentUnderstanding.evidence || [];
  const bySection = groupEvidenceBySection(evidence);
  const sequences = [];

  let sequenceIndex = 1;

  for (const [sectionKey, sectionItems] of bySection.entries()) {
    const orderedItems = sectionItems
        .filter((item) => hasSequenceMarker(getEvidenceText(item)))
        .map((item, index) => {
            const rawText = getEvidenceText(item);
            const text = cleanSequenceText(rawText);
            let mentioned = findMentionedComponents(text, components);

            if (mentioned.length === 0) {
            mentioned = buildFallbackSequenceEntities(text);
            }

            return {
            order: index + 1,
            text,
            rawText,
            source: inferSequenceSource(rawText),
            sequenceSource: inferSequenceSource(rawText),
            evidenceId: item.id || null,
            page: item.page || null,
            entities: mentioned.map((entry) => ({
                id: entry.component.id,
                name: entry.component.name,
                role: entry.component.role,
            })),
            };
        })
        .filter((item) => item.text && item.entities.length > 0);

        if (orderedItems.length < 2) continue;

        const groupsBySource = orderedItems.reduce((acc, item) => {
        const key = item.sequenceSource || item.source || "ordered_text";

        if (!acc.has(key)) {
            acc.set(key, []);
        }

        acc.get(key).push(item);

        return acc;
        }, new Map());

        for (const [source, sourceItems] of groupsBySource.entries()) {
        if (sourceItems.length < 2) continue;

        sequences.push({
            id: `explicit_sequence_${sequenceIndex}`,
            title: normalizeText(sectionKey),
            type: "ordered_sequence",
            source,
            confidence: "deterministic",
            itemCount: sourceItems.length,
            items: sourceItems.map((item, itemIndex) => ({
            ...item,
            order: itemIndex + 1,
            })),
        });

        sequenceIndex += 1;
        }
  }

  return sequences;
}

function makeRelationship({
  source,
  target,
  type,
  reason,
  evidenceIds,
  evidenceText,
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
    evidenceText: normalizeText(evidenceText),
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
    const evidenceText = normalizeText(
      relationship.evidenceText || relationship.text || relationship.reason || ""
    );

    const isFlow =
      relationshipType.includes("flow") ||
      relationshipType.includes("connect") ||
      relationshipType.includes("route") ||
      relationshipType.includes("send") ||
      relationshipType.includes("arrow") ||
      hasArrowSyntax(evidenceText) ||
      hasFlowLanguage(evidenceText);

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
        evidenceText,
        inferred: !isFlow && isOnlyCoMention,
        direction: isFlow ? "directed_or_implied" : "defined_association",
      })
    );
  }

  return relationships;
}

function extractDirectionalFlowRelationships(documentUnderstanding = {}, components = []) {
  const evidence = documentUnderstanding.evidence || [];
  const relationships = [];

  for (const item of evidence) {
    const text = getEvidenceText(item);
    if (!text) continue;

    const isDirectional = hasArrowSyntax(text) || hasFlowLanguage(text);
    if (!isDirectional) continue;

    const mentioned = findMentionedComponents(text, components);
    if (mentioned.length < 2 || mentioned.length > 8) continue;

    for (let i = 0; i < mentioned.length - 1; i += 1) {
      relationships.push(
        makeRelationship({
          source: mentioned[i].component,
          target: mentioned[i + 1].component,
          type: "explicit_flow",
          reason: hasArrowSyntax(text) ? "explicit_flow" : "directional_flow_text",
          evidenceIds: [item.id].filter(Boolean),
          evidenceText: text,
          inferred: false,
          direction: hasArrowSyntax(text) ? "arrow_text_order" : "verb_text_order",
        })
      );
    }
  }

  return relationships;
}

function extractSameSentenceFlowRelationships(documentUnderstanding = {}, components = []) {
  const evidence = documentUnderstanding.evidence || [];
  const relationships = [];

  for (const item of evidence) {
    const text = getEvidenceText(item);
    if (!text || !hasFlowLanguage(text)) continue;

    for (const clause of splitIntoClauses(text)) {
      if (!hasFlowLanguage(clause)) continue;

      const mentioned = findMentionedComponents(clause, components);
      if (mentioned.length < 2 || mentioned.length > 5) continue;

      for (let i = 0; i < mentioned.length - 1; i += 1) {
        relationships.push(
          makeRelationship({
            source: mentioned[i].component,
            target: mentioned[i + 1].component,
            type: "explicit_flow",
            reason: "same_sentence_flow_context",
            evidenceIds: [item.id].filter(Boolean),
            evidenceText: clause,
            inferred: false,
            direction: "clause_order_with_flow_language",
          })
        );
      }
    }
  }

  return relationships;
}

function groupEvidenceBySection(evidence = []) {
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

  return bySection;
}

function extractOrderedSequenceRelationships(documentUnderstanding = {}, components = []) {
  const relationships = [];
  const explicitSequences = extractExplicitSequences(documentUnderstanding, components);

  const reverseFlowTerms =
    /\b(return|returns|response|responds|back|rollback|fallback|revert|cleanup|tear down|teardown)\b/i;

  for (const sequence of explicitSequences) {
    const ordered = sequence.items || [];

    for (let i = 0; i < ordered.length - 1; i += 1) {
      const current = ordered[i];
      const next = ordered[i + 1];

      if (reverseFlowTerms.test(current.text) || reverseFlowTerms.test(next.text)) continue;

      const sourceEntity = current.entities[current.entities.length - 1];
      const targetEntity = next.entities[0];

      if (!sourceEntity || !targetEntity) continue;
      if (sourceEntity.id === targetEntity.id) continue;

      const source = components.find((component) => component.id === sourceEntity.id);
      const target = components.find((component) => component.id === targetEntity.id);

      if (!source || !target) continue;

      relationships.push(
        makeRelationship({
          source,
          target,
          type: "explicit_flow",
          reason: "ordered_sequence",
          evidenceIds: [current.evidenceId, next.evidenceId].filter(Boolean),
          evidenceText: `${current.text} ${next.text}`.slice(0, 700),
          inferred: false,
          direction: "explicit_document_sequence_order",
        })
      );
    }
  }

  return relationships;
}

function extractSameSectionRelationships(documentUnderstanding = {}, components = []) {
  const relationships = [];
  const evidence = documentUnderstanding.evidence || [];
  const bySection = groupEvidenceBySection(evidence);
  const WINDOW_SIZE = 1;
  const MAX_DISTANCE = 250;

  for (const sectionItems of bySection.values()) {
    const sectionText = sectionItems.map(getEvidenceText).join(" ");
    const sectionTextLower = lower(sectionText);

    const mentioned = components
      .map((component) => {
        const firstMentionIndex = sectionTextLower.indexOf(lower(component.name));

        return {
          component,
          index: firstMentionIndex,
        };
      })
      .filter((entry) => entry.index >= 0)
      .sort((a, b) => a.index - b.index);

    if (mentioned.length < 2 || mentioned.length > 8) continue;

    const evidenceIds = sectionItems.map((item) => item.id).filter(Boolean);
    const reason = hasFlowLanguage(sectionText)
      ? "same_section_flow_context"
      : "same_section_co_mention";

    for (let i = 0; i < mentioned.length; i += 1) {
      for (
        let offset = 1;
        offset <= WINDOW_SIZE && i + offset < mentioned.length;
        offset += 1
      ) {
        const sourceEntry = mentioned[i];
        const targetEntry = mentioned[i + offset];

        const source = sourceEntry.component;
        const target = targetEntry.component;

        if (!source || !target) continue;
        if (source.id === target.id) continue;

        const distance = Math.abs(targetEntry.index - sourceEntry.index);
        if (distance > MAX_DISTANCE) continue;

        const localTextStart = Math.max(0, sourceEntry.index - 80);
        const localTextEnd = Math.min(
          sectionText.length,
          targetEntry.index + target.name.length + 80
        );
        const localText = sectionText.slice(localTextStart, localTextEnd);

        const localHasFlowLanguage = hasFlowLanguage(localText) || hasArrowSyntax(localText);

        if (reason === "same_section_flow_context" && !localHasFlowLanguage) {
          continue;
        }

        relationships.push(
          makeRelationship({
            source,
            target,
            type:
              reason === "same_section_flow_context"
                ? "explicit_flow"
                : "architecture_association",
            reason,
            evidenceIds,
            evidenceText: localText.slice(0, 500),
            inferred: true,
            direction:
              reason === "same_section_flow_context"
                ? "local_section_order_implied"
                : "undirected",
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
            evidenceText: [],
          });
        }

        const pair = pairMap.get(key);
        pair.pages.add(item.page || "unknown");
        if (item.id) pair.evidenceIds.push(item.id);
        pair.evidenceText.push(getEvidenceText(item));
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
        evidenceText: pair.evidenceText.join(" ").slice(0, 500),
        inferred: true,
        direction: "undirected",
      })
    );
}

function extractContinuityRepairRelationships(relationships = [], components = []) {
  const existingDirected = new Set(
    relationships.map((rel) => `${rel.sourceId}->${rel.targetId}`)
  );

  const incoming = new Map();
  const outgoing = new Map();

  for (const rel of relationships.filter((item) => item.type === "explicit_flow")) {
    if (!outgoing.has(rel.sourceId)) outgoing.set(rel.sourceId, []);
    if (!incoming.has(rel.targetId)) incoming.set(rel.targetId, []);

    outgoing.get(rel.sourceId).push(rel);
    incoming.get(rel.targetId).push(rel);
  }

  const repaired = [];

  for (const component of components) {
    const inEdges = incoming.get(component.id) || [];
    const outEdges = outgoing.get(component.id) || [];

    if (inEdges.length !== 1 || outEdges.length !== 1) continue;

    const prev = inEdges[0];
    const next = outEdges[0];

    if (prev.sourceId === next.targetId) continue;
    if (existingDirected.has(`${prev.sourceId}->${next.targetId}`)) continue;

    repaired.push(
      makeRelationship({
        source: {
          id: prev.sourceId,
          name: prev.sourceName,
          role: prev.sourceRole,
        },
        target: {
          id: next.targetId,
          name: next.targetName,
          role: next.targetRole,
        },
        type: "explicit_flow",
        reason: "continuity_repair",
        evidenceIds: [...(prev.evidenceIds || []), ...(next.evidenceIds || [])],
        evidenceText: `${prev.evidenceText || ""} ${next.evidenceText || ""}`.trim(),
        inferred: true,
        direction: "repaired_from_adjacent_flow_edges",
      })
    );
  }

  return repaired;
}

function confidenceWeight(confidence) {
  switch (confidence) {
    case "high":
      return 3;
    case "medium":
      return 2;
    case "low":
      return 1;
    default:
      return 0;
  }
}

function dedupeRelationships(relationships = []) {
  const priority = {
    explicit_flow: 7,
    directional_flow_text: 6,
    explicit_definition: 5,
    same_sentence_flow_context: 5,
    ordered_sequence: 4,
    same_section_flow_context: 3,
    same_section_co_mention: 2,
    repeated_cross_page_co_mention: 1,
    continuity_repair: 1,
    diagram_adjacency_only: 1,
  };

  const byPair = new Map();

  for (const relationship of relationships) {
    const directed =
      relationship.type === "explicit_flow" ||
      relationship.direction !== "undirected";

    const key = directed
      ? `${relationship.sourceId}->${relationship.targetId}`
      : [relationship.sourceId, relationship.targetId].sort().join("::");

    const existing = byPair.get(key);

    if (
      !existing ||
      (priority[relationship.reason] || 0) > (priority[existing.reason] || 0)
    ) {
      byPair.set(key, relationship);
    } else {
      byPair.set(key, {
        ...existing,
        evidenceIds: uniqueBy(
          [...(existing.evidenceIds || []), ...(relationship.evidenceIds || [])],
          (id) => id
        ),
        evidenceText: normalizeText(
          `${existing.evidenceText || ""} ${relationship.evidenceText || ""}`
        ).slice(0, 700),
      });
    }
  }

  const finalRelationships = [];

  for (const relationship of byPair.values()) {
    const reverseKey = `${relationship.targetId}->${relationship.sourceId}`;
    const reverse = byPair.get(reverseKey);

    if (!reverse) {
      finalRelationships.push(relationship);
      continue;
    }

    const currentScore =
      (priority[relationship.reason] || 0) +
      confidenceWeight(relationship.confidence);

    const reverseScore =
      (priority[reverse.reason] || 0) +
      confidenceWeight(reverse.confidence);

    if (currentScore >= reverseScore) {
      finalRelationships.push(relationship);
    }
  }

  return uniqueBy(
    finalRelationships,
    (relationship) =>
      `${relationship.sourceId}->${relationship.targetId}:${relationship.reason}`
  );
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
  if (!spatialUnderstanding || !Array.isArray(spatialUnderstanding.pages)) return [];

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

function buildArchitectureUnderstanding(documentUnderstanding = {}, spatialUnderstanding = {}) {
  const baseComponents = extractComponents(documentUnderstanding);
  const explicitSequences = extractExplicitSequences(documentUnderstanding, baseComponents);
  const promotedComponents = extractSequencePromotedComponents(
    explicitSequences,
    baseComponents
  );
  const components = uniqueBy(
    [...baseComponents, ...promotedComponents],
    (component) => component.id
  );

  const spatialRelationshipCandidates =
    collectSpatialRelationshipCandidates(spatialUnderstanding);

  const initialRelationships = dedupeRelationships([
    ...extractExplicitRelationships(documentUnderstanding, components),
    ...extractDirectionalFlowRelationships(documentUnderstanding, components),
    ...extractSameSentenceFlowRelationships(documentUnderstanding, components),
    ...extractOrderedSequenceRelationships(documentUnderstanding, components),
    ...extractSameSectionRelationships(documentUnderstanding, components),
    ...extractCrossPageRelationships(documentUnderstanding, components),
  ]);

  const relationships = dedupeRelationships([
    ...initialRelationships,
    ...extractContinuityRepairRelationships(initialRelationships, components),
  ]);

  const flows = relationships.filter((relationship) => relationship.type === "explicit_flow");

  return {
    version: "architecture-understanding-v4-sequence-entity-promotion",
    sourceVersion: documentUnderstanding.version || null,

    explicitSequences,

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
      explicitSequences,
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
      explicitSequenceCount: explicitSequences.length,
      explicitSequenceItemCount: explicitSequences.reduce(
        (sum, sequence) => sum + (sequence.items?.length || 0),
        0
      ),
      relationshipCount: relationships.length,
      flowCount: flows.length,
      spatialRelationshipCandidateCount: spatialRelationshipCandidates.length,
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
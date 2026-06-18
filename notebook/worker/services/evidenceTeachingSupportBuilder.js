'use strict';

/**
 * BUG-1A — Evidence Teaching Support Builder
 *
 * Borrowed ideas:
 * - RAGFlow: evidence-backed teaching records
 * - LangGraph: stable state IDs for components/handoffs
 * - Mermaid: from → to edge identity
 * - NetworkX: simple confidence scoring, no dependency
 *
 * Owns:
 * - converting document evidence into teachable support records
 *
 * Does NOT own:
 * - traversal
 * - narration
 * - LLM
 * - rendering
 * - hidden implementation guesses
 */

const fs = require('fs');
const path = require('path');

const VERSION = 'evidence-teaching-support-v1';

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeKey(value) {
  return cleanText(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);
}

function unique(items = []) {
  return Array.from(new Set(items.filter(Boolean)));
}

function compactList(items = [], limit = 5) {
  return unique(items.map(cleanText).filter(Boolean)).slice(0, limit);
}

function confidenceRank(confidence) {
  const order = {
    deterministic: 4,
    high: 3,
    medium: 2,
    low: 1,
    unknown: 0,
  };

  return order[confidence] ?? 0;
}

function summarizeConfidence(values = []) {
  const ranks = values.map(confidenceRank).filter((x) => x > 0);

  if (!ranks.length) return 'low';

  const best = Math.max(...ranks);

  if (best >= 4) return 'deterministic';
  if (best >= 3) return 'high';
  if (best >= 2) return 'medium';
  return 'low';
}

function buildEvidenceLookup({
  architectureEvidence = {},
  documentUnderstanding = {},
} = {}) {
  const lookup = new Map();

  function addEvidence(id, record = {}) {
    const evidenceId = cleanText(id || record.evidenceId || record.id);
    if (!evidenceId) return;

    if (!lookup.has(evidenceId)) {
      lookup.set(evidenceId, {
        evidenceId,
        rawText: cleanText(
          record.rawText ||
            record.text ||
            record.content ||
            record.summary ||
            record.value
        ),
        source: record.source || 'unknown',
        confidence: record.confidence || 'medium',
        normalizedType: record.normalizedType || record.type || null,
        page: record.page ?? null,
      });
    }
  }

  for (const record of asArray(architectureEvidence.evidenceRecords)) {
    const ids = asArray(record.evidenceIds);

    if (record.id || record.evidenceId) {
      addEvidence(record.id || record.evidenceId, record);
    }

    ids.forEach((id) => addEvidence(id, record));
  }

  for (const item of asArray(architectureEvidence.glossaryTerms)) {
    asArray(item.evidenceIds).forEach((id) =>
      addEvidence(id, {
        ...item,
        rawText: `${item.term}: ${item.meaning}`,
        source: 'glossary',
      })
    );
  }

  for (const item of asArray(architectureEvidence.legendItems)) {
    asArray(item.evidenceIds).forEach((id) =>
      addEvidence(id, {
        ...item,
        source: 'legend',
      })
    );
  }

  for (const item of asArray(architectureEvidence.boundaryEvidence)) {
    asArray(item.evidenceIds).forEach((id) =>
      addEvidence(id, {
        ...item,
        source: item.source || 'boundary_evidence',
      })
    );
  }

  for (const seq of asArray(documentUnderstanding.sequences)) {
    if (seq.id || seq.evidenceId) {
      addEvidence(seq.id || seq.evidenceId, {
        rawText: seq.text || seq.rawText || seq.description,
        source: 'document_sequence',
        confidence: seq.confidence || 'high',
        page: seq.page ?? null,
      });
    }

    for (const step of asArray(seq.steps)) {
      addEvidence(step.id || step.evidenceId, {
        rawText: step.text || step.label || step.description || step,
        source: 'numbered_step',
        confidence: step.confidence || 'high',
        page: step.page ?? seq.page ?? null,
      });
    }
  }

    for (const entity of asArray(documentUnderstanding.entities)) {
    addEvidence(entity.id || entity.evidenceId, {
        rawText:
        entity.rawText ||
        entity.text ||
        entity.name ||
        entity.label,
        source: "document_entity",
        confidence: entity.confidence || "medium",
        page: entity.page ?? null,
    });
    }

    for (const relationship of asArray(documentUnderstanding.relationships)) {
    addEvidence(relationship.id || relationship.evidenceId, {
        rawText: [
        relationship.rawText,
        relationship.text,
        relationship.label,
        relationship.description,
        relationship.from,
        relationship.to,
        relationship.type,
        ]
        .filter(Boolean)
        .join(" "),
        source: "document_relationship",
        confidence: relationship.confidence || "medium",
        page: relationship.page ?? null,
    });
    }

    for (const evidence of asArray(documentUnderstanding.evidence)) {
    addEvidence(evidence.id || evidence.evidenceId, {
        rawText:
        evidence.rawText ||
        evidence.text ||
        evidence.content ||
        evidence.summary,
        source: evidence.source || "document_evidence",
        confidence: evidence.confidence || "medium",
        page: evidence.page ?? null,
    });
    }

    for (const note of asArray(documentUnderstanding.operationalNotes)) {
    addEvidence(note.id || note.evidenceId, {
        rawText:
        note.rawText ||
        note.text ||
        note.content ||
        note.summary ||
        note.note,
        source: "operational_note",
        confidence: note.confidence || "medium",
        page: note.page ?? null,
    });
    }

    return lookup;
}

function findEvidenceForIds(evidenceIds = [], evidenceLookup = new Map()) {
  return compactList(
    asArray(evidenceIds)
      .map((id) => evidenceLookup.get(id)?.rawText)
      .filter(Boolean),
    8
  );
}

function findEvidenceContainingName(name, evidenceLookup = new Map()) {
  const key = normalizeKey(name);
  if (!key) return [];

  const out = [];

  for (const record of evidenceLookup.values()) {
    const raw = cleanText(record.rawText);
    const rawKey = normalizeKey(raw);

    if (rawKey.includes(key)) {
      out.push(raw);
    }
  }

  return compactList(out, 6);
}

function inferSupportedBehaviorFromText(texts = []) {
  const joined = cleanText(texts.join(' ')).toLowerCase();
  const out = [];

  if (/\breduc(es|e)?\b.*\blatency\b|\blatency\b/.test(joined)) {
    out.push('helps reduce latency or improve response time');
  }

  if (/\breduc(es|e)?\b.*\borigin\b|\borigin load\b/.test(joined)) {
    out.push('helps reduce direct load on the origin or upstream service');
  }

  if (/\brout(es|ing|e)\b|\bdistribut(es|ion|e)\b/.test(joined)) {
    out.push('helps route or distribute traffic to the next service');
  }

  if (/\bpolicy\b|\bauth\b|\bauthentication\b|\bauthorization\b|\bvalidat(es|ion|e)\b/.test(joined)) {
    out.push('helps enforce policy, authentication, or validation before traffic moves deeper');
  }

  if (/\bscale(s|d)?\b|\bhorizontal\b|\btraffic spike\b/.test(joined)) {
    out.push('helps the system handle more traffic or scale under load');
  }

  if (/\bpersist(ent|ence)?\b|\brecord\b|\bsystem of record\b|\bdatabase\b|\bstorage\b/.test(joined)) {
    out.push('keeps durable state or persistent records for the system');
  }

  if (/\btransform(s|ation)?\b|\bpackage(r|s|ing)?\b|\btranscod(e|er|ing)\b|\bmanifest\b/.test(joined)) {
    out.push('helps transform or prepare artifacts for downstream delivery');
  }

  if (/\bmonitor(s|ing)?\b|\bmetrics\b|\btelemetry\b|\blog(s)?\b|\bhealth\b/.test(joined)) {
    out.push('helps expose operational signals for monitoring or diagnosis');
  }

  return compactList(out, 4);
}

function inferSupportedClaimsFromText(texts = []) {
  const joined = cleanText(texts.join(' ')).toLowerCase();
  const claims = [];

  if (/\brout(es|ing|e)\b|\bdistribut(es|ion|e)\b|\bdirects?\b/.test(joined)) {
    claims.push('routing');
  }

  if (/\bpolicy\b|\bauth\b|\bauthentication\b|\bauthorization\b|\bvalidat(es|ion|e)\b/.test(joined)) {
    claims.push('validation');
  }

  if (
    /\bapplication\b|\bprocess(es|ing)?\b|\bapplication cluster\b|\bcore work\b|\bexecutes?\b/.test(
        joined
    )
    ) {
    claims.push('processing');
    }

  if (/\bpersist(ent|ence)?\b|\brecord\b|\bsystem of record\b|\bdatabase\b|\bstorage\b|\bstate\b/.test(joined)) {
    claims.push('state');
  }

  if (/\bcache\b|\bcached\b|\bcontent\b|\bpayload\b|\bdelivery\b|\bartifact\b/.test(joined)) {
    claims.push('cache_delivery');
  }

  return compactList(claims, 8);
}

function inferTeachingFromComponent(component = {}, evidenceTexts = []) {
  const out = [];

  if (component.documentDefinition) {
    out.push(`${component.componentName} is document-defined as ${component.documentDefinition}.`);
  }

  if (component.knowledgeType === 'industry_known' && component.industryConcept) {
    out.push(`${component.componentName} can be explained using safe general ${component.industryConcept.replace(/_/g, ' ')} context.`);
  }

  if (component.knowledgeType === 'internal_unresolved') {
    out.push(`${component.componentName} should be taught only by its position in the documented journey unless the document defines it.`);
  }

  const role = component.primaryJourneyRole;
  if (role && role !== 'unknown') {
    out.push(`${component.componentName} appears in the ${role} part of the architecture journey.`);
  }

  for (const behavior of inferSupportedBehaviorFromText(evidenceTexts)) {
    out.push(`${component.componentName} ${behavior}.`);
  }

  return compactList(out, 5);
}

function inferWhyNeededFromRole(role, name) {
  const label = cleanText(name) || 'This component';

  const templates = {
    entry: `${label} exists near the start so external or upstream traffic has a clear entry point.`,
    validation: `${label} exists here so checks can happen before traffic reaches deeper services.`,
    control: `${label} exists here to help decide where traffic should go next.`,
    processing: `${label} exists here to do the core work after traffic has passed entry and control layers.`,
    state: `${label} exists here because later stages need durable state, records, or stored results.`,
    delivery: `${label} exists here to prepare or deliver content to the next consumer.`,
    observability: `${label} exists here so the system can expose health, metrics, or operational signals.`,
    configuration: `${label} exists here to provide control or configuration input to the rest of the system.`,
  };

  return templates[role] ? [templates[role]] : [];
}

function inferProblemSolved(component = {}, evidenceTexts = []) {
  const joined = cleanText(evidenceTexts.join(' ')).toLowerCase();
  const out = [];

  if (/\blatency\b/.test(joined)) {
    out.push('reduces user-facing delay or response time');
  }

  if (/\borigin load\b|\breduce.*origin\b/.test(joined)) {
    out.push('protects upstream/origin systems from unnecessary load');
  }

  if (/\brouting\b|\bdistribution\b|\bdirects?\b/.test(joined)) {
    out.push('prevents traffic from being sent blindly without a routing decision');
  }

  if (/\bauth\b|\bpolicy\b|\bvalidation\b/.test(joined)) {
    out.push('prevents unchecked requests from moving deeper into the platform');
  }

  if (/\bscale\b|\btraffic spike\b/.test(joined)) {
    out.push('helps absorb traffic growth or spikes');
  }

  if (/\bpersistent\b|\bsystem of record\b|\bdatabase\b/.test(joined)) {
    out.push('keeps the architecture from losing important state');
  }

  return compactList(out, 4);
}

function inferNextStageBenefitForHop(hop = {}, toComponentSupport = null) {
  const toName = hop?.to?.name || 'the next component';
  const role = toComponentSupport?.journeyRole;

  if (role === 'validation') {
    return [`The next stage receives traffic ready for validation or policy checks at ${toName}.`];
  }

  if (role === 'control') {
    return [`The next stage can make a routing or control decision at ${toName}.`];
  }

  if (role === 'processing') {
    return [`The next stage can focus on application or service processing at ${toName}.`];
  }

  if (role === 'state') {
    return [`The next stage can read or write durable state at ${toName}.`];
  }

  if (role === 'delivery') {
    return [`The next stage can prepare or deliver the requested artifact through ${toName}.`];
  }

  return [`The next stage receives the handoff at ${toName} with the documented architecture context preserved.`];
}

function buildComponentSupportRecord({
  component,
  evidenceLookup,
  resolvedMeaning = null,
} = {}) {
  const evidenceTexts = compactList([
    component.documentDefinition,
    ...findEvidenceContainingName(component.componentName, evidenceLookup),
  ]);

  const evidenceIds = compactList([
    component.definitionEvidenceId,
    ...asArray(component.primaryRailContext?.hopIds),
  ]);

  const supportedBehavior = inferSupportedBehaviorFromText(evidenceTexts);
  const supportedClaims = inferSupportedClaimsFromText(evidenceTexts);
  const supportedTeaching = inferTeachingFromComponent(component, evidenceTexts);

    if (resolvedMeaning?.meaning) {
    supportedTeaching.unshift(
        `${component.componentName} means ${resolvedMeaning.meaning}.`
    );
}
  const whyNeeded = inferWhyNeededFromRole(
    component.primaryJourneyRole,
    component.componentName
  );
  const problemSolved = inferProblemSolved(component, evidenceTexts);

  return {
    id: `component_support_${normalizeKey(component.componentId || component.componentName)}`,
    subjectType: 'component',
    subjectId: component.componentId || normalizeKey(component.componentName),
    subjectName: component.componentName,

    journeyRole: component.primaryJourneyRole || 'unknown',
    journeyPosition: component.primaryJourneyPosition || null,
    knowledgeType: component.knowledgeType || 'unknown',

    meaning: resolvedMeaning?.meaning || '',
    meaningSource: resolvedMeaning?.meaningSource || null,
    meaningConfidence: resolvedMeaning?.confidence || null,
    meaningResolved: resolvedMeaning?.resolved === true,

    documentTruth: compactList(evidenceTexts),
    supportedBehavior,
    supportedClaims,
    supportedTeaching,
    whyNeeded,
    problemSolved,
    nextStageBenefit: [],

    evidenceIds,
    confidence: summarizeConfidence([
    component.confidence,
    resolvedMeaning?.confidence,
    component.documentDefinition ? 'high' : null,
    supportedBehavior.length ? 'medium' : null,
    ]),

    safety: {
      documentOnly:
        component.safety?.requiresEvidenceForPrivateMeaning === true,
      canUseIndustryTeaching:
        component.safety?.canExplainIndustryContext === true,
      canInferInternalBehavior: false,
      unsupportedImplementationDetailsBlocked: true,
    },
  };
}

function buildComponentSupportIndex(componentRecords = []) {
  const index = new Map();

  for (const record of asArray(componentRecords)) {
    index.set(normalizeKey(record.subjectName), record);
    index.set(normalizeKey(record.subjectId), record);
  }

  return index;
}

function buildMeaningLookup(componentMeaningResolution = {}) {
  const lookup = new Map();

  for (const component of asArray(componentMeaningResolution.components)) {
    lookup.set(normalizeKey(component.componentName), component);
    lookup.set(normalizeKey(component.componentId), component);
  }

  return lookup;
}


function roleLabel(role) {
  return cleanText(String(role || '').replace(/_/g, ' '));
}

function inferResponsibilityShift({ fromName, toName, hop, fromSupport, toSupport }) {
  const fromRole =
    roleLabel(hop.contextualRoles?.fromRoleInHandoff) ||
    roleLabel(fromSupport?.journeyRole);

  const toRole =
    roleLabel(hop.contextualRoles?.toRoleInHandoff) ||
    roleLabel(toSupport?.journeyRole);

  if (fromRole && toRole) {
    return `${fromName} is acting as ${fromRole}, then ${toName} takes over as ${toRole}.`;
  }

  return `${fromName} hands responsibility to ${toName}.`;
}

function inferWhatChanged({ fromName, toName, hop, fromSupport, toSupport }) {
  const fromRole = fromSupport?.journeyRole || '';
  const toRole = toSupport?.journeyRole || '';
  const lane = hop.flowLaneType || '';

  if (fromRole && toRole && fromRole !== toRole) {
    return `The architecture moves from ${roleLabel(fromRole)} responsibility to ${roleLabel(toRole)} responsibility.`;
  }

  if (lane) {
    return `The handoff moves work along the ${roleLabel(lane)} lane from ${fromName} to ${toName}.`;
  }

  return `The handoff moves the request or responsibility from ${fromName} to ${toName}.`;
}

function inferWhyHandoffExists({ fromName, toName, hop, toSupport }) {
  if (toSupport?.whyNeeded?.length) {
    return toSupport.whyNeeded[0];
  }

  if (hop.interactionMode && hop.interactionMode !== 'unknown') {
    return `${fromName} hands off to ${toName} because this stage represents a ${roleLabel(hop.interactionMode)} step in the architecture.`;
  }

  return `${fromName} hands off to ${toName} so the next architecture responsibility can happen in the right place.`;
}

function inferTeachingFrame({ hop, fromName, toName }) {
  const lane = roleLabel(hop.flowLaneType);
  const interaction = roleLabel(hop.interactionMode);

  if (lane && interaction) {
    return `Teach ${fromName} → ${toName} as a ${interaction} transition inside the ${lane} lane.`;
  }

  if (lane) {
    return `Teach ${fromName} → ${toName} as a transition inside the ${lane} lane.`;
  }

  return `Teach ${fromName} → ${toName} as a responsibility transition.`;
}

function buildHandoffSupportRecord({
  hop,
  evidenceLookup,
  componentSupportIndex,
} = {}) {
  const fromName = hop?.from?.name || 'Upstream';
  const toName = hop?.to?.name || 'Downstream';

  const directEvidenceTexts = findEvidenceForIds(
    hop.evidenceIds,
    evidenceLookup
  );

  const fallbackEvidenceTexts = compactList([
    ...findEvidenceContainingName(fromName, evidenceLookup),
    ...findEvidenceContainingName(toName, evidenceLookup),
  ]);

  const evidenceTexts = compactList([
    ...directEvidenceTexts,
    ...fallbackEvidenceTexts,
  ]);

  const fromSupport = componentSupportIndex.get(normalizeKey(fromName));
  const toSupport = componentSupportIndex.get(normalizeKey(toName));

  const documentTruth = compactList([
    ...evidenceTexts,
    `${fromName} → ${toName}`,
  ]);

  const supportedBehavior = compactList([
    ...inferSupportedBehaviorFromText(evidenceTexts),
    hop.interactionMode && hop.interactionMode !== 'unknown'
        ? `represents a ${String(hop.interactionMode).replace(/_/g, ' ')} handoff`
        : '',
    ]);

    const supportedClaims = compactList([
    ...inferSupportedClaimsFromText(directEvidenceTexts),
    hop.interactionMode === 'traffic_distribution' ? 'routing' : '',
    hop.interactionMode === 'auth_validation' ? 'validation' : '',
    hop.interactionMode === 'bidirectional_sync' ? 'state' : '',
    hop.interactionMode === 'payload_delivery' ? 'cache_delivery' : '',
    hop.flowLaneType === 'primary_request_flow' ? 'request_flow' : '',
    ], 8);

  const supportedTeaching = compactList([
    `Teach this as the responsibility handoff from ${fromName} to ${toName}.`,
    hop.flowLaneType
      ? `This handoff belongs to the ${String(hop.flowLaneType).replace(/_/g, ' ')} lane.`
      : '',
    hop.contextualRoles?.fromRoleInHandoff
      ? `${fromName} is acting as ${String(hop.contextualRoles.fromRoleInHandoff).replace(/_/g, ' ')}.`
      : '',
    hop.contextualRoles?.toRoleInHandoff
      ? `${toName} is acting as ${String(hop.contextualRoles.toRoleInHandoff).replace(/_/g, ' ')}.`
      : '',
  ]);

  const whyNeeded = compactList([
    `${fromName} hands off to ${toName} so the architecture can move from one responsibility boundary to the next.`,
    ...asArray(toSupport?.whyNeeded),
  ]);

  const problemSolved = compactList([
    ...inferProblemSolved({}, evidenceTexts),
    ...asArray(toSupport?.problemSolved),
  ]);

  const nextStageBenefit = inferNextStageBenefitForHop(
    hop,
    toSupport
    );

    const responsibilityShift = inferResponsibilityShift({
    fromName,
    toName,
    hop,
    fromSupport,
    toSupport,
    });

    const whatChanged = inferWhatChanged({
    fromName,
    toName,
    hop,
    fromSupport,
    toSupport,
    });

    const whyHandoffExists = inferWhyHandoffExists({
    fromName,
    toName,
    hop,
    toSupport,
    });

    const teachingFrame = inferTeachingFrame({
    hop,
    fromName,
    toName,
    });

  return {
    id: `handoff_support_${normalizeKey(hop.hopId)}`,
    subjectType: 'handoff',
    subjectId: hop.hopId,
    subjectName: `${fromName} → ${toName}`,

    hopId: hop.hopId,
    canonicalOrder: hop.canonicalOrder,
    flowLaneId: hop.flowLaneId || null,
    flowLaneType: hop.flowLaneType || null,
    stepId: hop.stepId || null,

    from: hop.from || null,
    to: hop.to || null,
    relationshipType: hop.relationshipType || null,
    interactionMode: hop.interactionMode || null,
    contextualRoles: hop.contextualRoles || {},

    documentTruth,
    supportedBehavior,
    supportedClaims,
    supportedTeaching,

    whatChanged,
    responsibilityShift,
    whyHandoffExists,
    upstreamResponsibility:
    fromSupport?.journeyRole || hop.contextualRoles?.fromRoleInHandoff || null,
    downstreamResponsibility:
    toSupport?.journeyRole || hop.contextualRoles?.toRoleInHandoff || null,
    teachingFrame,

    whyNeeded,
    problemSolved,
    nextStageBenefit,

    evidenceIds: compactList([
      ...asArray(hop.evidenceIds),
      hop.stepId,
      hop.sourceRelationshipId,
    ]),

    confidence: summarizeConfidence([
      hop.confidence,
      directEvidenceTexts.length ? 'high' : null,
      fallbackEvidenceTexts.length ? 'medium' : null,
    ]),

    safety: {
      narratableAsFact:
        hop.safety?.inferred !== true &&
        hop.safety?.topologyOnly !== true &&
        evidenceTexts.length > 0,
      topologyOnly: hop.safety?.topologyOnly === true,
      inferred: hop.safety?.inferred === true,
      documentOnly: true,
      unsupportedImplementationDetailsBlocked: true,
    },
  };
}

function classifyArtifact(term) {
  const value = String(term || '').toLowerCase();

  if (['https', 'http', 'grpc', 'tcp', 'udp', 'tls', 'mtls'].includes(value)) {
    return 'protocol';
  }

  if (['mpd', 'mpeg-dash', 'dash', 'm3u8', 'hls'].includes(value)) {
    return 'manifest';
  }

  if (['ts', '.ts', 'mpeg-ts'].includes(value)) {
    return 'media_segment';
  }

  return 'artifact';
}

function safeArtifactMeaning(term) {
  const value = String(term || '').toLowerCase();

  switch (value) {
    case 'https':
      return 'HTTPS is a documented transport protocol.';
    case 'http':
      return 'HTTP is a documented transport protocol.';
    case 'tcp':
      return 'TCP is a documented transport protocol.';
    case 'udp':
      return 'UDP is a documented transport protocol.';
    case 'tls':
    case 'mtls':
      return `${String(term).toUpperCase()} is a documented transport security term.`;
    case 'mpd':
    case 'mpeg-dash':
    case 'dash':
      return 'MPD/DASH is a documented streaming manifest artifact.';
    case 'm3u8':
    case 'hls':
      return 'HLS/M3U8 is a documented streaming playlist artifact.';
    case 'ts':
    case '.ts':
    case 'mpeg-ts':
      return 'MPEG-TS is a documented media segment format.';
    default:
      return '';
  }
}

function buildArtifactSupportRecords({
  architectureEvidence = {},
  evidenceLookup,
} = {}) {
  const publicTerms = asArray(architectureEvidence.publicTerms);
  const glossaryTerms = asArray(architectureEvidence.glossaryTerms);

  const candidateTerms = [
    ...publicTerms.map((term) => ({
        term: term.term,
        source: term.source || 'public_standard_candidate',
        confidence: term.confidence || 'medium',
        evidenceIds: asArray(term.evidenceIds),
        publicStandard: true,
    })),
    ...glossaryTerms
        .filter((term) => term.publicStandard)
        .map((term) => ({
        term: term.term,
        source: term.source || 'glossary',
        confidence: term.confidence || 'high',
        evidenceIds: asArray(term.evidenceIds),
        publicStandard: true,
        })),
    ];

    const terms = candidateTerms.filter((term) =>
    ['protocol', 'manifest', 'media_segment'].includes(
        classifyArtifact(term.term)
    )
    );

  const uniqueTerms = new Map();

  for (const term of terms) {
    const key = normalizeKey(term.term);
    if (!key || uniqueTerms.has(key)) continue;
    uniqueTerms.set(key, term);
  }

  return Array.from(uniqueTerms.values()).map((term) => {
    const evidenceTexts = findEvidenceForIds(term.evidenceIds, evidenceLookup);

    return {
      id: `artifact_support_${normalizeKey(term.term)}`,
      subjectType: 'artifact',
        subjectId: normalizeKey(term.term),
        subjectName: term.term,

        artifactType: classifyArtifact(term.term),
        meaning: safeArtifactMeaning(term.term),

        documentTruth: evidenceTexts,
      supportedBehavior: [],
      supportedTeaching: [
        `${term.term} appears in document evidence and may be explained using safe public industry context.`,
        ],

        whyNeeded: [
        `${term.term} appears because the document associates this artifact or protocol with a documented handoff.`,
        ],

        problemSolved: [
        `helps identify how information moves between documented stages.`,
        ],

        nextStageBenefit: [
        `the next stage receives information through the documented artifact or protocol.`,
        ],

      evidenceIds: compactList(term.evidenceIds),
      confidence: term.confidence || 'medium',

      safety: {
        documentOnly: false,
        canUseIndustryTeaching: true,
        canInferInternalBehavior: false,
        unsupportedImplementationDetailsBlocked: true,
      },
    };
  });
}

function buildEvidenceTeachingSupport({
  architectureEvidence = {},
  architectureTermResolutions = {},
  componentUnderstanding = {},
  componentMeaningResolution = {},
  canonicalTraversalRail = {},
  documentUnderstanding = {},
  outputDir = null,
} = {}) {
  const evidenceLookup = buildEvidenceLookup({
    architectureEvidence,
    documentUnderstanding,
  });

  const meaningLookup = buildMeaningLookup(componentMeaningResolution);

  const components = asArray(componentUnderstanding.components).map((component) =>
    buildComponentSupportRecord({
        component,
        evidenceLookup,
        resolvedMeaning:
        meaningLookup.get(normalizeKey(component.componentName)) ||
        meaningLookup.get(normalizeKey(component.componentId)),
    })
 );

  const componentSupportIndex = buildComponentSupportIndex(components);

  const handoffs = asArray(canonicalTraversalRail.hops).map((hop) =>
    buildHandoffSupportRecord({
      hop,
      evidenceLookup,
      componentSupportIndex,
    })
  );

  const artifacts = buildArtifactSupportRecords({
    architectureEvidence,
    evidenceLookup,
  });

  const payload = {
    version: VERSION,
    generatedAt: new Date().toISOString(),
    source: 'evidenceTeachingSupportBuilder',
    purpose:
      'Convert deterministic document evidence, component understanding, and canonical traversal hops into teachable support records for later narration.',
    borrowedIdeas: [
      'RAGFlow evidence-backed support records',
      'LangGraph stable IDs and state handoff identity',
      'Mermaid from-to edge identity',
      'NetworkX-style simple confidence scoring without dependency',
    ],
    strategy: {
      traversalPolicy: 'consume_canonical_traversal_do_not_rebuild',
      evidencePolicy: 'document_evidence_before_industry_teaching',
      internalTermPolicy:
        'internal_terms_require_document_evidence_before behavior claims',
      narrationPolicy:
        'produce support facts only; narration builders decide final wording',
    },
    components,
    handoffs,
    artifacts,
    stats: {
      componentSupportCount: components.length,
      handoffSupportCount: handoffs.length,
      artifactSupportCount: artifacts.length,
      evidenceRecordCount: evidenceLookup.size,
      highConfidenceComponentCount: components.filter((x) =>
        ['deterministic', 'high'].includes(x.confidence)
      ).length,
      highConfidenceHandoffCount: handoffs.filter((x) =>
        ['deterministic', 'high'].includes(x.confidence)
      ).length,
      narratableHandoffCount: handoffs.filter(
        (x) => x.safety?.narratableAsFact === true
      ).length,
      topologyOnlyHandoffCount: handoffs.filter(
        (x) => x.safety?.topologyOnly === true
      ).length,
      documentOnlyComponentCount: components.filter(
        (x) => x.safety?.documentOnly === true
      ).length,
      industryTeachingAllowedCount:
        components.filter((x) => x.safety?.canUseIndustryTeaching).length +
        artifacts.filter((x) => x.safety?.canUseIndustryTeaching).length,
    },
    inputs: {
      architectureEvidenceVersion: architectureEvidence.version || null,
      architectureTermResolutionsVersion:
        architectureTermResolutions.version || null,
      componentUnderstandingVersion: componentUnderstanding.version || null,
        componentMeaningResolutionVersion: componentMeaningResolution.version || null,
        canonicalTraversalRailVersion: canonicalTraversalRail.version || null,
      documentUnderstandingVersion: documentUnderstanding.version || null,
    },
  };

  if (outputDir) {
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(
      path.join(outputDir, 'evidence-teaching-support.json'),
      JSON.stringify(payload, null, 2),
      'utf8'
    );
  }

  return payload;
}

module.exports = {
  VERSION,
  buildEvidenceTeachingSupport,

  // exported for small unit/debug tests
  buildEvidenceLookup,
  buildMeaningLookup,
  buildComponentSupportRecord, 
  buildHandoffSupportRecord,
  buildArtifactSupportRecords,
};
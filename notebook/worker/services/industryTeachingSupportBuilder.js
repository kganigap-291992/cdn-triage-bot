'use strict';

/**
 * BUG-1D — Industry Teaching Support Builder
 *
 * Borrowed ideas:
 * - RAGFlow: keep teaching grounded to evidence buckets
 * - LlamaIndex: enrich nodes without changing source truth
 * - NotebookLM: explain generally, but preserve document boundaries
 * - OpenTelemetry semantic conventions: separate observed fact from interpretation
 *
 * Owns:
 * - separating Document Truth vs Industry Teaching vs Implementation Details
 *
 * Does NOT own:
 * - traversal
 * - narration wording
 * - LLM calls
 * - hidden implementation guesses
 */

const fs = require('fs');
const path = require('path');

const VERSION = 'industry-teaching-support-v1';

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
    .slice(0, 100);
}

function compactList(items = [], limit = 8) {
  return Array.from(
    new Set(items.map(cleanText).filter(Boolean))
  ).slice(0, limit);
}

function buildIndustryContextLookup(architectureIndustryKnowledge = {}) {
  const lookup = new Map();

  for (const context of asArray(architectureIndustryKnowledge.contexts)) {
    lookup.set(normalizeKey(context.componentName), context);
    lookup.set(normalizeKey(context.componentId), context);
  }

  return lookup;
}

function isIndustryTeachingAllowed(componentSupport = {}, industryContext = null) {
  return Boolean(
    componentSupport?.safety?.canUseIndustryTeaching === true ||
      industryContext?.industryContextAllowed === true ||
      componentSupport?.meaningSource === 'safe_industry_concept'
  );
}

function inferBlockedImplementationDetails({
  subjectName,
  industryConcept,
  subjectType,
} = {}) {
  const base = [
    `Do not claim hidden implementation details for ${subjectName}.`,
    `Do not claim vendor, product, deployment, scaling, retry, failover, encryption, cache policy, timeout, or storage behavior unless the document states it.`,
  ];

  const concept = cleanText(industryConcept).toLowerCase();

  if (concept === 'cdn') {
    base.push(
      'Do not claim CDN vendor, TTL, cache key, cache invalidation, stale response, geo-routing, POP behavior, or origin shielding unless documented.'
    );
  }

  if (concept === 'api_gateway' || concept === 'gateway' || concept === 'api') {
    base.push(
      'Do not claim rate limiting, JWT validation, OAuth, request transformation, service mesh, retries, or timeout behavior unless documented.'
    );
  }

  if (concept === 'database') {
    base.push(
      'Do not claim schema, replication, consistency model, backup, sharding, indexing, or transaction behavior unless documented.'
    );
  }

  if (concept === 'redis' || concept === 'cache') {
    base.push(
      'Do not claim cache TTL, eviction policy, key structure, replication, persistence mode, or pub/sub behavior unless documented.'
    );
  }

  if (concept === 'kafka') {
    base.push(
      'Do not claim topic names, partitions, consumer groups, ordering guarantees, retention, or exactly-once semantics unless documented.'
    );
  }

  if (subjectType === 'handoff') {
    base.push(
      'Do not claim protocol, payload format, transformation, authentication method, or synchronous/asynchronous behavior unless the handoff evidence supports it.'
    );
  }

  return compactList(base, 8);
}

function buildComponentIndustryTeachingRecord({
  componentSupport = {},
  industryContext = null,
} = {}) {
  const subjectName = componentSupport.subjectName;
  const industryTeachingAllowed = isIndustryTeachingAllowed(
    componentSupport,
    industryContext
  );

  const industryTeaching = compactList([
    industryTeachingAllowed ? industryContext?.explanation : '',
    industryTeachingAllowed && componentSupport.meaning
      ? `${subjectName} can be taught as ${componentSupport.meaning}, but only at a general architecture level unless the document gives more detail.`
      : '',
    ...asArray(componentSupport.supportedBehavior).map(
      (behavior) =>
        `${subjectName} ${behavior}.`
    ),
  ]);

  return {
    id: `industry_component_${normalizeKey(componentSupport.subjectId || subjectName)}`,
    subjectType: 'component',
    subjectId: componentSupport.subjectId || normalizeKey(subjectName),
    subjectName,

    documentTruth: compactList(componentSupport.documentTruth, 8),

    industryTeaching,

    implementationDetails: [],

    blockedImplementationDetails: inferBlockedImplementationDetails({
      subjectName,
      industryConcept:
        componentSupport.meaningSource === 'safe_industry_concept'
          ? componentSupport.meaning
          : componentSupport.knowledgeType === 'industry_known'
            ? componentSupport.meaning
            : '',
      subjectType: 'component',
    }),

    evidenceIds: compactList(componentSupport.evidenceIds, 8),

    confidence: componentSupport.confidence || 'low',

    safety: {
      industryTeachingAllowed,
      documentOnly: componentSupport.safety?.documentOnly === true,
      canInferInternalBehavior: false,
      implementationDetailsBlocked: true,
      unsupportedImplementationDetailsBlocked: true,
      sourceConfidence: componentSupport.confidence || 'low',
    },

    sources: {
      evidenceTeachingSupportId: componentSupport.id || null,
      industryContextAllowed:
        industryContext?.industryContextAllowed === true,
      industryContextFallbackUsed:
        industryContext?.fallbackUsed === true,
      industryContextLlmValid:
        industryContext?.llmValid === true,
      meaningSource: componentSupport.meaningSource || null,
    },
  };
}

function buildHandoffIndustryTeachingRecord({
  handoffSupport = {},
  componentIndustryIndex = new Map(),
} = {}) {
  const subjectName = handoffSupport.subjectName;
  const fromName = handoffSupport.from?.name;
  const toName = handoffSupport.to?.name;

  const fromComponent = componentIndustryIndex.get(normalizeKey(fromName));
  const toComponent = componentIndustryIndex.get(normalizeKey(toName));

  const industryTeaching = compactList([
    handoffSupport.whatChanged,
    handoffSupport.responsibilityShift,
    handoffSupport.whyHandoffExists,
    handoffSupport.teachingFrame,
    ...asArray(handoffSupport.problemSolved).map(
      (item) => `This handoff can be taught as solving: ${item}.`
    ),
    ...asArray(handoffSupport.nextStageBenefit),
  ], 10);

  return {
    id: `industry_handoff_${normalizeKey(handoffSupport.hopId || subjectName)}`,
    subjectType: 'handoff',
    subjectId: handoffSupport.hopId || normalizeKey(subjectName),
    subjectName,

    hopId: handoffSupport.hopId || null,
    canonicalOrder: handoffSupport.canonicalOrder || null,
    flowLaneId: handoffSupport.flowLaneId || null,
    flowLaneType: handoffSupport.flowLaneType || null,

    from: handoffSupport.from || null,
    to: handoffSupport.to || null,

    documentTruth: compactList(handoffSupport.documentTruth, 8),

    industryTeaching,

    implementationDetails: [],

    blockedImplementationDetails: inferBlockedImplementationDetails({
      subjectName,
      subjectType: 'handoff',
    }),

    evidenceIds: compactList(handoffSupport.evidenceIds, 8),

    confidence: handoffSupport.confidence || 'low',

    safety: {
      industryTeachingAllowed:
        handoffSupport.safety?.narratableAsFact === true,
      documentOnly: true,
      canInferInternalBehavior: false,
      implementationDetailsBlocked: true,
      unsupportedImplementationDetailsBlocked: true,
      sourceConfidence: handoffSupport.confidence || 'low',
    },

    teachingBridge: {
      upstreamComponentTeaching:
        fromComponent?.industryTeaching?.[0] || null,
      downstreamComponentTeaching:
        toComponent?.industryTeaching?.[0] || null,
      whatChanged: handoffSupport.whatChanged || null,
      whyHandoffExists: handoffSupport.whyHandoffExists || null,
      nextStageBenefit: handoffSupport.nextStageBenefit || [],
    },

    sources: {
      evidenceTeachingSupportId: handoffSupport.id || null,
      hopId: handoffSupport.hopId || null,
    },
  };
}

function buildComponentIndustryIndex(componentRecords = []) {
  const index = new Map();

  for (const record of asArray(componentRecords)) {
    index.set(normalizeKey(record.subjectName), record);
    index.set(normalizeKey(record.subjectId), record);
  }

  return index;
}

function buildIndustryTeachingSupport({
  evidenceTeachingSupport = {},
  architectureIndustryKnowledge = {},
  outputDir = null,
} = {}) {
  const industryContextLookup = buildIndustryContextLookup(
    architectureIndustryKnowledge
  );

  const components = asArray(evidenceTeachingSupport.components).map(
    (componentSupport) =>
      buildComponentIndustryTeachingRecord({
        componentSupport,
        industryContext:
          industryContextLookup.get(normalizeKey(componentSupport.subjectName)) ||
          industryContextLookup.get(normalizeKey(componentSupport.subjectId)),
      })
  );

  const componentIndustryIndex = buildComponentIndustryIndex(components);

  const seenHandoffIds = new Set();

    const handoffs = asArray(evidenceTeachingSupport.handoffs)
    .filter((handoffSupport) => {
        const key =
        handoffSupport.hopId ||
        handoffSupport.subjectId ||
        handoffSupport.subjectName;

        if (!key) return false;
        if (seenHandoffIds.has(key)) return false;

        seenHandoffIds.add(key);
        return true;
    })
    .map((handoffSupport) =>
        buildHandoffIndustryTeachingRecord({
        handoffSupport,
        componentIndustryIndex,
        })
    );

  const payload = {
    version: VERSION,
    generatedAt: new Date().toISOString(),
    source: 'industryTeachingSupportBuilder',
    purpose:
      'Separate document truth, safe industry teaching, and blocked implementation details before narration.',
    borrowedIdeas: [
      'RAGFlow evidence-grounded teaching buckets',
      'LlamaIndex metadata enrichment without changing source truth',
      'NotebookLM-style bounded explanation',
      'OpenTelemetry-style observed fact versus semantic interpretation',
    ],
    strategy: {
      documentTruthPolicy:
        'only facts directly supported by extracted/evidence support records',
      industryTeachingPolicy:
        'general teaching is allowed only when component/handoff safety permits it',
      implementationDetailPolicy:
        'implementation details remain empty unless explicitly added by document-backed future phases',
      internalBehaviorPolicy:
        'never infer internal behavior from public concept names alone',
    },
    components,
    handoffs,
    stats: {
      componentCount: components.length,
      handoffCount: handoffs.length,
      componentIndustryTeachingAllowedCount: components.filter(
        (x) => x.safety?.industryTeachingAllowed === true
      ).length,
      handoffIndustryTeachingAllowedCount: handoffs.filter(
        (x) => x.safety?.industryTeachingAllowed === true
      ).length,
      implementationDetailsBlockedCount:
        components.filter((x) => x.safety?.implementationDetailsBlocked).length +
        handoffs.filter((x) => x.safety?.implementationDetailsBlocked).length,
      documentOnlyCount:
        components.filter((x) => x.safety?.documentOnly === true).length +
        handoffs.filter((x) => x.safety?.documentOnly === true).length,
    },
    inputs: {
      evidenceTeachingSupportVersion:
        evidenceTeachingSupport.version || null,
      architectureIndustryKnowledgeVersion:
        architectureIndustryKnowledge.version || null,
    },
  };

  if (outputDir) {
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(
      path.join(outputDir, 'industry-teaching-support.json'),
      JSON.stringify(payload, null, 2),
      'utf8'
    );
  }

  return payload;
}

module.exports = {
  VERSION,
  buildIndustryTeachingSupport,
  buildIndustryContextLookup,
  buildComponentIndustryTeachingRecord,
  buildHandoffIndustryTeachingRecord,
};
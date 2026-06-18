'use strict';

/**
 * BUG-1F — Why-Here Teaching Builder
 *
 * Owns:
 * - why this component exists at this stage
 * - what problem it solves
 * - what the next stage gains
 *
 * Hybrid rule:
 * - deterministic code decides WHY
 * - LLM only rewrites explanation
 */

const fs = require('fs');
const path = require('path');

const VERSION = 'why-here-teaching-v1';

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
  return Array.from(new Set(items.map(cleanText).filter(Boolean))).slice(
    0,
    limit
  );
}

function filterTeachingEvidence(items = []) {
  return asArray(items).filter((text) => {
    const value = cleanText(text);
    if (!value) return false;
    if (/co_mentions/i.test(value)) return false;
    if (/_co_mention/i.test(value)) return false;
    return true;
  });
}

function filterProblemSolvedByRole(items = [], role = 'unknown') {
  const allowedByRole = {
    entry: [/front door/i, /entry/i, /latency/i, /origin load/i],
    validation: [/unchecked/i, /invalid/i, /auth/i, /validation/i, /policy/i],
    control: [/routing/i, /route/i, /decision/i, /direct/i, /sent blindly/i],
    processing: [/main work/i, /core work/i, /processing/i, /handled/i],
    state: [/state/i, /records/i, /stored/i, /durable/i, /lost/i],
    delivery: [/delivery/i, /artifact/i, /content/i, /payload/i],
    observability: [/visibility/i, /health/i, /signals/i, /monitor/i],
    configuration: [/configuration/i, /control input/i, /settings/i],
  };

  const patterns = allowedByRole[role];

  if (!patterns) {
    return [];
  }

  return asArray(items).filter((item) =>
    patterns.some((pattern) => pattern.test(cleanText(item)))
  );
}

function parseJsonObject(value) {
  try {
    if (!value) return null;
    if (typeof value === 'object') return value;
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function buildComponentLookup(items = [], nameKey = 'componentName') {
  const lookup = new Map();

  for (const item of asArray(items)) {
    const name = item[nameKey] || item.subjectName;
    const id = item.componentId || item.subjectId;

    if (name) lookup.set(normalizeKey(name), item);
    if (id) lookup.set(normalizeKey(id), item);
  }

  return lookup;
}

function buildIndustryLookup(architectureIndustryKnowledge = {}) {
  const lookup = new Map();

  for (const context of asArray(architectureIndustryKnowledge.contexts)) {
    if (context.componentName) {
      lookup.set(normalizeKey(context.componentName), context);
    }

    if (context.componentId) {
      lookup.set(normalizeKey(context.componentId), context);
    }
  }

  return lookup;
}

function buildHandoffLookup(evidenceTeachingSupport = {}) {
  const byComponent = new Map();

  for (const handoff of asArray(evidenceTeachingSupport.handoffs)) {
    const names = [handoff.from?.name, handoff.to?.name];

    for (const name of names) {
      const key = normalizeKey(name);
      if (!key) continue;

      if (!byComponent.has(key)) byComponent.set(key, []);
      byComponent.get(key).push(handoff);
    }
  }

  return byComponent;
}

function inferWhyHereFromRole({ componentName, role, position }) {
  const label = componentName || 'This component';

  const templates = {
    entry: `${label} appears near the start of the documented journey.`,
    validation: `${label} appears before later documented stages continue.`,
    control: `${label} appears between earlier and later stages of the documented journey.`,
    processing: `${label} appears after earlier stages in the documented journey and before later stages continue.`,
    state: `${label} appears near later stages of the documented journey.`,
    delivery: `${label} appears as part of a documented delivery handoff before the next stage.`,
    observability: `${label} appears as a supporting stage connected to the documented journey.`,
    configuration: `${label} appears as a documented supporting input around this stage of the journey.`,
  };

  const base =
    templates[role] ||
    `${label} appears at this point because the documented journey places it in this stage of the flow.`;

  return position
    ? `${base} It appears around journey position ${position}.`
    : base;
}

function inferProblemSolvedFromRole({ componentName, role, evidenceTexts }) {
  const joined = cleanText(evidenceTexts.join(' ')).toLowerCase();
  const out = [];

  if (role === 'entry') {
    if (/\blatency\b/.test(joined)) {
      out.push('marks the starting side of the documented journey');
    }

    if (/\borigin load\b|\breduce.*origin\b/.test(joined)) {
      out.push('marks an early documented boundary before later stages');
    }
  }

  if (role === 'validation') {
    if (/\bauth|authentication|authorization|validat|policy\b/.test(joined)) {
      out.push('marks a documented checkpoint before later stages');
    }
  }

  if (role === 'control') {
    if (/\brout|routing|distribut|direct\b/.test(joined)) {
      out.push('marks a transition point between earlier and later stages');
    }
  }

  if (role === 'processing') {
    if (/\bapplication|process|service|cluster|work\b/.test(joined)) {
      out.push('marks a later stage in the documented journey');
    }
  }

  if (role === 'state') {
    if (/\bpersist|database|system of record|state|storage|record\b/.test(joined)) {
      out.push('marks a stage reached near the end of the documented journey');
    }
  }

  if (role === 'delivery') {
    if (/\bdeliver|payload|artifact|content|manifest|segment\b/.test(joined)) {
      out.push('marks a documented delivery transition');
    }
  }

  const roleFallbacks = {
    entry: 'marks the beginning of the documented journey',
    validation: 'marks a documented checkpoint before later stages',
    control: 'creates a documented transition before later stages',
    processing: 'marks the next stage in the documented journey',
    state: 'marks a later stage in the documented journey',
    delivery: 'marks a documented delivery transition',
    observability: 'marks a supporting visibility stage in the documented journey',
    configuration: 'marks a supporting configuration stage in the documented journey',
  };

  if (!out.length && roleFallbacks[role]) out.push(roleFallbacks[role]);

  return compactList(out, 4);
}

function inferNextStageBenefit({ componentName, role, handoffs }) {
  const downstream = compactList(
    asArray(handoffs)
      .filter((handoff) => normalizeKey(handoff.from?.name) === normalizeKey(componentName))
      .map((handoff) => handoff.to?.name),
    3
  );

  if (downstream.length) {
    return [
      `The next stage receives a cleaner handoff toward ${downstream.join(', ')}.`,
    ];
  }

  const templates = {
    entry: 'The next stage receives the documented journey after this starting point.',
    validation: 'The next stage receives a documented handoff.',
    control: 'The next stage receives a documented handoff.',
    processing: 'The next stage receives the documented continuation of the journey.',
    state: 'The documented journey reaches a later stage.',
    delivery: 'The next stage receives a documented delivery handoff.',
    observability: 'The documented journey keeps this as supporting context.',
    configuration: 'The documented journey keeps this as supporting input.',
  };

  return compactList([templates[role]], 3);
}

function buildForbiddenClaims(componentName) {
  return [
    `Do not claim hidden implementation behavior for ${componentName}.`,
    'Do not claim vendors, protocols, auth methods, JWT/OAuth, cache policy, retry behavior, failover, replication, encryption, schema, indexing, queues, or autoscaling unless the document explicitly says it.',
    'Do not infer private/company-specific behavior from the component name alone.',
  ];
}

function deterministicFallback(record) {
  return cleanText(
    [
      record.whyHere?.[0],
      record.problemSolved?.length
        ? `It helps ${record.problemSolved[0]}.`
        : '',
      record.nextStageBenefit?.[0] || '',
    ]
      .filter(Boolean)
      .join(' ')
  );
}

function isValidLlmWhyHere(value) {
  return Boolean(
    value &&
      cleanText(value.plainEnglishWhyHere).length >= 30 &&
      cleanText(value.mentorExplanation).length >= 40 &&
      cleanText(value.memoryHook).length >= 10
  );
}

function containsForbiddenClaim(text = '') {
  const value = cleanText(text).toLowerCase();

  return /\boauth\b|\bjwt\b|\bredis\b|\bkafka\b|\bsqs\b|\bpub\/sub\b|\bttl\b|\bcache invalidation\b|\breplication\b|\bfailover\b|\bautoscal/i.test(
    value
  );
}

async function enrichWhyHereWithLlm({ record, llmClient = null } = {}) {
  const fallback = deterministicFallback(record);

  if (!llmClient) {
    return {
      plainEnglishWhyHere: fallback,
      mentorExplanation: fallback,
      memoryHook: `Remember ${record.componentName} by why it appears here, not just by its label.`,
      llmUsed: false,
      llmValid: false,
      fallbackUsed: true,
    };
  }

  try {
    const raw = await llmClient({
      task: 'why_here_teaching',
      input: {
        componentName: record.componentName,
        documentTruth: record.documentTruth,
        meaning: record.meaning,
        journeyRole: record.journeyRole,
        journeyPosition: record.journeyPosition,
        upstreamComponents: record.upstreamComponents,
        downstreamComponents: record.downstreamComponents,
        whyHere: record.whyHere,
        problemSolved: record.problemSolved,
        nextStageBenefit: record.nextStageBenefit,
        confidence: record.confidence,
        forbiddenClaims: record.forbiddenClaims,
      },
      requiredJsonShape: {
        plainEnglishWhyHere: 'string',
        mentorExplanation: 'string',
        memoryHook: 'string',
      },
    });

    const parsed = parseJsonObject(raw);

    if (!isValidLlmWhyHere(parsed)) {
      throw new Error('Invalid why-here LLM JSON');
    }

    const combined = [
      parsed.plainEnglishWhyHere,
      parsed.mentorExplanation,
      parsed.memoryHook,
    ].join(' ');

    if (containsForbiddenClaim(combined)) {
      throw new Error('Unsupported claim detected');
    }

    return {
      plainEnglishWhyHere: cleanText(parsed.plainEnglishWhyHere),
      mentorExplanation: cleanText(parsed.mentorExplanation),
      memoryHook: cleanText(parsed.memoryHook),
      llmUsed: true,
      llmValid: true,
      fallbackUsed: false,
    };
  } catch {
    return {
      plainEnglishWhyHere: fallback,
      mentorExplanation: fallback,
      memoryHook: `Remember ${record.componentName} by why it appears here, not just by its label.`,
      llmUsed: true,
      llmValid: false,
      fallbackUsed: true,
    };
  }
}

function buildWhyHereRecord({
  component,
  meaning,
  support,
  industryContext,
  handoffs,
} = {}) {
  const componentName = component.componentName;
  const role =
    component.primaryJourneyRole ||
    meaning?.journeyRole ||
    support?.journeyRole ||
    'unknown';

  const journeyPosition =
    component.primaryJourneyPosition ||
    meaning?.journeyPosition ||
    support?.journeyPosition ||
    null;

  const documentTruth = compactList(
    filterTeachingEvidence([
      component.documentDefinition,
      meaning?.rawEvidence,
      ...asArray(support?.documentTruth),
    ]),
    8
  );

  const evidenceTexts = compactList(
    filterTeachingEvidence([
      ...documentTruth,
      ...asArray(support?.supportedBehavior),
      ...asArray(support?.supportedTeaching),
    ]),
    12
  );

  const upstreamComponents = compactList(
    asArray(component.primaryRailContext?.upstreamComponents),
    5
  );

  const downstreamComponents = compactList(
    asArray(component.primaryRailContext?.downstreamComponents),
    5
  );

  const whyHere = compactList([
    inferWhyHereFromRole({
        componentName,
        role,
        position: journeyPosition,
    }),
    ], 4);

  const problemSolved = compactList([
    ...inferProblemSolvedFromRole({
        componentName,
        role,
        evidenceTexts,
    }),
    ], 4);

  const nextStageBenefit = compactList([
    ...asArray(support?.nextStageBenefit),
    ...inferNextStageBenefit({
      componentName,
      role,
      handoffs,
    }),
  ], 4);

  const confidence =
    documentTruth.length ? 'high' :
    role && role !== 'unknown' ? 'medium' :
    'low';

  return {
    id: `why_here_${normalizeKey(component.componentId || componentName)}`,
    componentId: component.componentId || normalizeKey(componentName),
    componentName,

    meaning: meaning?.meaning || support?.meaning || '',
    meaningSource: meaning?.meaningSource || support?.meaningSource || null,

    knowledgeType: component.knowledgeType || meaning?.knowledgeType || 'unknown',
    journeyRole: role,
    journeyPosition,

    upstreamComponents,
    downstreamComponents,

    documentTruth,
    whyHere,
    problemSolved,
    nextStageBenefit,

    industryContext:
      industryContext?.industryContextAllowed === true
        ? industryContext.explanation
        : null,

    evidenceIds: compactList([
      component.definitionEvidenceId,
      ...asArray(meaning?.evidenceIds),
      ...asArray(support?.evidenceIds),
    ], 10),

    confidence,

    forbiddenClaims: buildForbiddenClaims(componentName),

    safety: {
      documentOnly:
        component.safety?.requiresEvidenceForPrivateMeaning === true ||
        meaning?.safety?.documentOnly === true,
      canUseIndustryTeaching:
        component.safety?.canExplainIndustryContext === true ||
        meaning?.safety?.canUseIndustryTeaching === true,
      canInferInternalBehavior: false,
      implementationDetailsBlocked: true,
      unsupportedImplementationDetailsBlocked: true,
    },
  };
}

async function buildWhyHereTeaching({
  componentUnderstanding = {},
  componentMeaningResolution = {},
  evidenceTeachingSupport = {},
  architectureIndustryKnowledge = {},
  canonicalTraversalRail = {},
  llmClient = null,
  outputDir = null,
} = {}) {
  const meaningLookup = buildComponentLookup(
    componentMeaningResolution.components,
    'componentName'
  );

  const supportLookup = buildComponentLookup(
    evidenceTeachingSupport.components,
    'subjectName'
  );

  const industryLookup = buildIndustryLookup(architectureIndustryKnowledge);

  const handoffLookup = buildHandoffLookup(evidenceTeachingSupport);

  const components = [];

  for (const component of asArray(componentUnderstanding.components)) {
    const key = normalizeKey(component.componentName);

    const record = buildWhyHereRecord({
      component,
      meaning:
        meaningLookup.get(key) ||
        meaningLookup.get(normalizeKey(component.componentId)),
      support:
        supportLookup.get(key) ||
        supportLookup.get(normalizeKey(component.componentId)),
      industryContext:
        industryLookup.get(key) ||
        industryLookup.get(normalizeKey(component.componentId)),
      handoffs: handoffLookup.get(key) || [],
    });

    const llm = await enrichWhyHereWithLlm({
      record,
      llmClient,
    });

    components.push({
      ...record,
      plainEnglishWhyHere: llm.plainEnglishWhyHere,
      mentorExplanation: llm.mentorExplanation,
      memoryHook: llm.memoryHook,
      llmUsed: llm.llmUsed,
      llmValid: llm.llmValid,
      fallbackUsed: llm.fallbackUsed,
    });
  }

  const payload = {
    version: VERSION,
    generatedAt: new Date().toISOString(),
    source: 'whyHereTeachingBuilder',
    purpose:
      'Explain why each component appears at its stage of the architecture journey using deterministic evidence first and optional bounded LLM wording second.',
    strategy: {
      deterministicPolicy:
        'code decides whyHere, problemSolved, nextStageBenefit, confidence, and forbidden claims',
      llmPolicy:
        'LLM rewrites only plainEnglishWhyHere, mentorExplanation, and memoryHook',
      fallbackPolicy:
        'invalid JSON or unsupported claims fall back to deterministic text',
      implementationDetailPolicy:
        'hidden implementation behavior remains blocked unless explicitly documented',
    },
    components,
    stats: {
      componentCount: components.length,
      highConfidenceCount: components.filter((x) =>
        ['deterministic', 'high'].includes(x.confidence)
      ).length,
      mediumConfidenceCount: components.filter((x) => x.confidence === 'medium')
        .length,
      lowConfidenceCount: components.filter((x) => x.confidence === 'low')
        .length,
      llmUsedCount: components.filter((x) => x.llmUsed).length,
      llmValidCount: components.filter((x) => x.llmValid).length,
      fallbackUsedCount: components.filter((x) => x.fallbackUsed).length,
      documentOnlyCount: components.filter((x) => x.safety?.documentOnly)
        .length,
    },
    inputs: {
      componentUnderstandingVersion: componentUnderstanding.version || null,
      componentMeaningResolutionVersion:
        componentMeaningResolution.version || null,
      evidenceTeachingSupportVersion: evidenceTeachingSupport.version || null,
      architectureIndustryKnowledgeVersion:
        architectureIndustryKnowledge.version || null,
      canonicalTraversalRailVersion: canonicalTraversalRail.version || null,
    },
  };

  if (outputDir) {
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(
      path.join(outputDir, 'why-here-teaching.json'),
      JSON.stringify(payload, null, 2),
      'utf8'
    );
  }

  return payload;
}

module.exports = {
  VERSION,
  buildWhyHereTeaching,
  buildWhyHereRecord,
  enrichWhyHereWithLlm,
};
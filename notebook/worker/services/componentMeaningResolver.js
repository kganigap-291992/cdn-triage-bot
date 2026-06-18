'use strict';

/**
 * BUG-1B — Component Meaning Resolver
 *
 * Borrowed ideas:
 * - RAGFlow: meaning must be evidence-backed
 * - LlamaIndex: enrich component node metadata
 * - LangGraph: stable component meaning state
 * - OpenTelemetry semantic attributes: separate role from meaning
 *
 * Owns:
 * - resolving component meaning from document evidence
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

const {
  resolveTermMeaning,
} = require('./architectureEvidenceResolver');

const VERSION = 'component-meaning-resolution-v1';

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

function compactList(items = [], limit = 8) {
  return Array.from(
    new Set(items.map(cleanText).filter(Boolean))
  ).slice(0, limit);
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

function pickHigherConfidence(a, b) {
  return confidenceRank(a) >= confidenceRank(b) ? a : b;
}

function roleFallbackMeaning(role) {
  const map = {
    entry: 'entry point in the documented architecture journey',
    validation: 'validation or policy checkpoint in the documented journey',
    control: 'routing or control point in the documented journey',
    processing: 'processing stage in the documented journey',
    state: 'state or persistence stage in the documented journey',
    delivery: 'delivery or artifact handoff stage in the documented journey',
    observability: 'observability or health-signal stage in the documented journey',
    configuration: 'configuration or control-input stage in the documented journey',
  };

  return map[role] || '';
}

function safeIndustryMeaning(component = {}) {
  if (!component.industryConcept) return '';

  return `general ${String(component.industryConcept).replace(/_/g, ' ')} component`;
}

function resolveComponentMeaning({
  component = {},
  architectureEvidence = {},
} = {}) {
  const componentName = cleanText(component.componentName);
  const componentId =
    component.componentId || normalizeKey(componentName);

  const termResolution = resolveTermMeaning(
    componentName,
    architectureEvidence
  );

  const documentDefinition = cleanText(component.documentDefinition);
  const industryMeaning = safeIndustryMeaning(component);
  const fallbackRoleMeaning = roleFallbackMeaning(
    component.primaryJourneyRole
  );

  if (termResolution.resolved && cleanText(termResolution.meaning)) {
    return {
      componentId,
      componentName,
      normalizedName: normalizeKey(componentName),

      resolved: true,
      meaning: cleanText(termResolution.meaning),
      meaningSource: termResolution.source || 'architecture_evidence_resolver',
      evidenceIds: compactList(termResolution.evidenceIds),
      rawEvidence: termResolution.rawEvidence || '',

      knowledgeType: component.knowledgeType || 'unknown',
      journeyRole: component.primaryJourneyRole || 'unknown',
      journeyPosition: component.primaryJourneyPosition || null,

      confidence: termResolution.confidence || 'medium',

      safety: {
        documentOnly: termResolution.documentOnly === true,
        canUseIndustryTeaching:
          termResolution.allowPublicEnrichment === true ||
          component.safety?.canExplainIndustryContext === true,
        canInferInternalBehavior: false,
        internalTerm: termResolution.internalTerm === true,
        publicStandard: termResolution.publicStandard === true,
        unsupportedImplementationDetailsBlocked: true,
      },

      notes: compactList([
        ...asArray(termResolution.notes),
        'resolved_by_architecture_evidence_resolver',
      ]),
    };
  }

  if (documentDefinition) {
    return {
      componentId,
      componentName,
      normalizedName: normalizeKey(componentName),

      resolved: true,
      meaning: documentDefinition,
      meaningSource: component.definitionSource || 'component_document_definition',
      evidenceIds: compactList([
        component.definitionEvidenceId,
        ...asArray(termResolution.evidenceIds),
      ]),
      rawEvidence: documentDefinition,

      knowledgeType: component.knowledgeType || 'document_defined',
      journeyRole: component.primaryJourneyRole || 'unknown',
      journeyPosition: component.primaryJourneyPosition || null,

      confidence: pickHigherConfidence(component.confidence, 'high'),

      safety: {
        documentOnly:
          component.safety?.requiresEvidenceForPrivateMeaning === true,
        canUseIndustryTeaching:
          component.safety?.canExplainIndustryContext === true,
        canInferInternalBehavior: false,
        internalTerm:
          component.internalNameLikely === true ||
          termResolution.internalTerm === true,
        publicStandard: termResolution.publicStandard === true,
        unsupportedImplementationDetailsBlocked: true,
      },

      notes: compactList([
        'resolved_from_component_document_definition',
        ...asArray(termResolution.notes),
      ]),
    };
  }

  if (
    component.knowledgeType === 'industry_known' &&
    component.safety?.canExplainIndustryContext === true &&
    industryMeaning
  ) {
    return {
      componentId,
      componentName,
      normalizedName: normalizeKey(componentName),

      resolved: true,
      meaning: industryMeaning,
      meaningSource: 'safe_industry_concept',
      evidenceIds: compactList(termResolution.evidenceIds),
      rawEvidence: '',

      knowledgeType: component.knowledgeType || 'industry_known',
      journeyRole: component.primaryJourneyRole || 'unknown',
      journeyPosition: component.primaryJourneyPosition || null,

      confidence: pickHigherConfidence(component.confidence, 'medium'),

      safety: {
        documentOnly: false,
        canUseIndustryTeaching: true,
        canInferInternalBehavior: false,
        internalTerm: false,
        publicStandard: termResolution.publicStandard === true,
        unsupportedImplementationDetailsBlocked: true,
      },

      notes: compactList([
        'resolved_from_safe_industry_concept',
        'implementation_details_not_inferred',
        ...asArray(termResolution.notes),
      ]),
    };
  }

  if (fallbackRoleMeaning) {
    return {
      componentId,
      componentName,
      normalizedName: normalizeKey(componentName),

      resolved: false,
      meaning: fallbackRoleMeaning,
      meaningSource: 'journey_role_structural_fallback',
      evidenceIds: compactList(termResolution.evidenceIds),
      rawEvidence: '',

      knowledgeType: component.knowledgeType || 'unknown',
      journeyRole: component.primaryJourneyRole || 'unknown',
      journeyPosition: component.primaryJourneyPosition || null,

      confidence: 'low',

      safety: {
        documentOnly: true,
        canUseIndustryTeaching: false,
        canInferInternalBehavior: false,
        internalTerm:
          component.internalNameLikely === true ||
          termResolution.internalTerm === true,
        publicStandard: termResolution.publicStandard === true,
        unsupportedImplementationDetailsBlocked: true,
      },

      notes: compactList([
        'structural_role_only_no_component_behavior_claim',
        ...asArray(termResolution.notes),
      ]),
    };
  }

  return {
    componentId,
    componentName,
    normalizedName: normalizeKey(componentName),

    resolved: false,
    meaning: '',
    meaningSource: 'unresolved',
    evidenceIds: compactList(termResolution.evidenceIds),
    rawEvidence: '',

    knowledgeType: component.knowledgeType || 'unknown',
    journeyRole: component.primaryJourneyRole || 'unknown',
    journeyPosition: component.primaryJourneyPosition || null,

    confidence: 'low',

    safety: {
      documentOnly: true,
      canUseIndustryTeaching: false,
      canInferInternalBehavior: false,
      internalTerm:
        component.internalNameLikely === true ||
        termResolution.internalTerm === true,
      publicStandard: termResolution.publicStandard === true,
      unsupportedImplementationDetailsBlocked: true,
    },

    notes: compactList([
      'unresolved_component_meaning',
      ...asArray(termResolution.notes),
    ]),
  };
}

function buildComponentMeaningResolution({
  componentUnderstanding = {},
  architectureEvidence = {},
  outputDir = null,
} = {}) {
  const components = asArray(componentUnderstanding.components).map((component) =>
    resolveComponentMeaning({
      component,
      architectureEvidence,
    })
  );

  const payload = {
    version: VERSION,
    generatedAt: new Date().toISOString(),
    source: 'componentMeaningResolver',
    purpose:
      'Resolve component meanings from document evidence before teaching support and narration.',
    borrowedIdeas: [
      'RAGFlow evidence-backed meaning records',
      'LlamaIndex node metadata enrichment',
      'LangGraph stable component meaning state',
      'OpenTelemetry-style separation of semantic role and meaning',
    ],
    strategy: {
      meaningPriority:
        'glossary_then_evidence_then_component_definition_then_safe_industry_then_structural_role',
      internalTermPolicy:
        'unresolved_internal_terms_remain_document_only_and_do_not_get_behavior_claims',
      publicTermPolicy:
        'public_terms_may_use_safe_industry_teaching_but_not_implementation_details',
      downstreamRule:
        'evidenceTeachingSupportBuilder_should_consume_componentMeaningResolution_before_narration',
    },
    componentCount: components.length,
    components,
    stats: {
      componentCount: components.length,
      resolvedCount: components.filter((x) => x.resolved).length,
      unresolvedCount: components.filter((x) => !x.resolved).length,
      glossaryResolvedCount: components.filter(
        (x) => x.meaningSource === 'glossary'
      ).length,
      evidenceResolvedCount: components.filter(
        (x) =>
          x.meaningSource === 'evidence_record' ||
          x.meaningSource === 'explicit_text' ||
          x.meaningSource === 'document_evidence'
      ).length,
      documentDefinitionResolvedCount: components.filter(
        (x) => x.meaningSource === 'component_document_definition'
      ).length,
      industryResolvedCount: components.filter(
        (x) => x.meaningSource === 'safe_industry_concept'
      ).length,
      structuralFallbackCount: components.filter(
        (x) => x.meaningSource === 'journey_role_structural_fallback'
      ).length,
      documentOnlyCount: components.filter(
        (x) => x.safety?.documentOnly === true
      ).length,
      industryTeachingAllowedCount: components.filter(
        (x) => x.safety?.canUseIndustryTeaching === true
      ).length,
      internalTermCount: components.filter(
        (x) => x.safety?.internalTerm === true
      ).length,
      highConfidenceCount: components.filter((x) =>
        ['deterministic', 'high'].includes(x.confidence)
      ).length,
    },
    inputs: {
      componentUnderstandingVersion: componentUnderstanding.version || null,
      architectureEvidenceVersion: architectureEvidence.version || null,
    },
  };

  if (outputDir) {
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(
      path.join(outputDir, 'component-meaning-resolution.json'),
      JSON.stringify(payload, null, 2),
      'utf8'
    );
  }

  return payload;
}

module.exports = {
  VERSION,
  buildComponentMeaningResolution,
  resolveComponentMeaning,
};
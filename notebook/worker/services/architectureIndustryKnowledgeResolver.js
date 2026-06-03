/**
 * architectureIndustryKnowledgeResolver.js
 *
 * BUG-22P.2B
 *
 * Owns bounded industry-context explanations for public / document-defined concepts.
 *
 * Does:
 * - use LLM to explain known public architecture concepts
 * - require componentUnderstanding to allow expansion
 * - return short safe educational context
 *
 * Does NOT:
 * - classify private/internal names as public
 * - override document definitions
 * - choose traversal
 * - narrate the rail
 * - infer company-specific behavior
 */

const fs = require("fs");
const path = require("path");

const RESOLVER_VERSION = "architecture-industry-knowledge-resolver-v1";

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function safeString(value) {
  return String(value || "").trim();
}

function compactText(value, maxLength = 900) {
  const text = safeString(value).replace(/\s+/g, " ");
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1).trim()}…`;
}

function parseJsonObject(value) {
  try {
    if (!value) return null;
    if (typeof value === "object") return value;
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function canResolveIndustryContext(component = {}) {
  return Boolean(
    component &&
      component.industryExpansionAllowed === true &&
      component.knowledgeType !== "internal_unresolved"
  );
}

function buildIndustryKnowledgeFallback(component = {}) {
  if (!canResolveIndustryContext(component)) {
    return null;
  }

  const name = safeString(component.componentName);
  const definition = safeString(component.documentDefinition);
  const concept = safeString(component.industryConcept);

  if (definition) {
    return compactText(
      `${name} is defined in the document as ${definition}. Use that document definition as the anchor; any broader explanation should stay general and avoid assuming hidden company-specific behavior.`
    );
  }

  if (concept) {
    return compactText(
      `${name} is a commonly used architecture concept. Explain it only in general terms and avoid claiming this specific system performs behavior that the document did not define.`
    );
  }

  return null;
}

function isValidIndustryKnowledge(value) {
  return Boolean(
    value &&
      typeof value.explanation === "string" &&
      safeString(value.explanation).length >= 40
  );
}

async function resolveIndustryKnowledgeForComponent({
  component,
  llmClient = null,
} = {}) {
  if (!canResolveIndustryContext(component)) {
    return {
      componentId: component?.componentId || null,
      componentName: component?.componentName || null,
      industryContextAllowed: false,
      llmUsed: false,
      llmValid: false,
      fallbackUsed: false,
      explanation: null,
      safety: {
        reason: "industry expansion not allowed for unresolved internal component",
      },
    };
  }

  const fallback = buildIndustryKnowledgeFallback(component);

  if (!llmClient) {
    return {
      componentId: component.componentId,
      componentName: component.componentName,
      industryContextAllowed: true,
      llmUsed: false,
      llmValid: false,
      fallbackUsed: true,
      explanation: fallback,
      safety: {
        reason: "missing llm client",
      },
    };
  }

  try {
    const raw = await llmClient({
      task: "industry_knowledge",
      input: {
        componentName: component.componentName,
        knowledgeType: component.knowledgeType,
        documentDefinition: component.documentDefinition,
        definitionSource: component.definitionSource,
        industryConcept: component.industryConcept,
        confidence: component.confidence,
        safety: component.safety,
      },
      requiredJsonShape: {
        explanation: "string",
      },
    });

    const parsed = parseJsonObject(raw);

    if (!isValidIndustryKnowledge(parsed)) {
      throw new Error("Invalid industry knowledge JSON");
    }

    return {
      componentId: component.componentId,
      componentName: component.componentName,
      industryContextAllowed: true,
      llmUsed: true,
      llmValid: true,
      fallbackUsed: false,
      explanation: compactText(parsed.explanation, 900),
      safety: {
        reason: "bounded industry explanation",
      },
    };
  } catch {
    return {
      componentId: component.componentId,
      componentName: component.componentName,
      industryContextAllowed: true,
      llmUsed: true,
      llmValid: false,
      fallbackUsed: true,
      explanation: fallback,
      safety: {
        reason: "invalid llm output; used fallback",
      },
    };
  }
}

async function buildArchitectureIndustryKnowledge({
  componentUnderstanding = {},
  llmClient = null,
  outputDir = null,
} = {}) {
  const components = asArray(componentUnderstanding.components);
  const results = [];

  for (const component of components) {
    const result = await resolveIndustryKnowledgeForComponent({
      component,
      llmClient,
    });

    results.push(result);
  }

  const payload = {
    version: RESOLVER_VERSION,
    source: "architectureIndustryKnowledgeResolver",
    purpose:
      "Provide bounded general industry explanations only for components where component understanding allows expansion.",
    componentCount: results.length,
    contexts: results,
    stats: {
      allowedCount: results.filter((item) => item.industryContextAllowed).length,
      blockedCount: results.filter((item) => !item.industryContextAllowed).length,
      llmUsedCount: results.filter((item) => item.llmUsed).length,
      llmValidCount: results.filter((item) => item.llmValid).length,
      fallbackUsedCount: results.filter((item) => item.fallbackUsed).length,
    },
  };

  if (outputDir) {
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(
      path.join(outputDir, "architecture-industry-knowledge.json"),
      JSON.stringify(payload, null, 2),
      "utf8"
    );
  }

  return payload;
}

module.exports = {
  RESOLVER_VERSION,
  buildArchitectureIndustryKnowledge,
  resolveIndustryKnowledgeForComponent,
  buildIndustryKnowledgeFallback,
  canResolveIndustryContext,
};
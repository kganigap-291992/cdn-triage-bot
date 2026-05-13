const fs = require("fs");
const path = require("path");

const { buildLayoutBoxes } = require("./layoutBoxBuilder");
const { buildDocumentStructure } = require("./documentStructureBuilder");
const { buildSourceGrounding } = require("./sourceGroundingBuilder");
const { buildDocumentIntelligence } = require("./documentIntelligence");

const VERSION = "document-understanding-v1";

function safeReadJson(filePath, fallback = null) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function normalizeText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function slugify(value) {
  return normalizeText(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
}

function unique(values = []) {
  return Array.from(new Set(values.filter(Boolean)));
}

function getPageNumber(value, fallback = 1) {
  const page = Number(value);
  return Number.isFinite(page) && page > 0 ? page : fallback;
}

function collectLayoutEvidence(layoutBoxes = {}) {
  const evidence = [];

  const pages = Array.isArray(layoutBoxes.pages) ? layoutBoxes.pages : [];

  pages.forEach((page, pageIndex) => {
    const pageNumber = getPageNumber(
      page.pageNumber || page.page || page.number,
      pageIndex + 1
    );

    const candidates = [
      ...(Array.isArray(page.lines) ? page.lines : []),
      ...(Array.isArray(page.blocks) ? page.blocks : []),
      ...(Array.isArray(page.items) ? page.items : []),
      ...(Array.isArray(page.headings) ? page.headings : []),
      ...(Array.isArray(page.sections) ? page.sections : []),
    ];

    candidates.forEach((item, itemIndex) => {
      const text = normalizeText(
        item.text ||
            item.content ||
            item.value ||
            item.title ||
            item.heading
        );

        if (!text) return;

        // filter numeric-only layout fragments like "1", "2", "3"
        if (/^\d+$/.test(text)) return;

        // filter tiny accidental layout fragments
        if (text.length <= 1) return;

      evidence.push({
        id: `ev_layout_${String(evidence.length + 1).padStart(4, "0")}`,
        page: pageNumber,
        text,
        type: item.type || item.kind || "layout_text",
        source: item.source || "layoutBoxBuilder",
        bbox: item.bbox || item.box || item.focusRegion || null,
        sectionId: item.sectionId || null,
        order: item.order ?? itemIndex,
        confidence: item.confidence || layoutBoxes.pdfLayout?.ok ? "high" : "medium",
      });
    });
  });

  return evidence;
}

function collectStructureEvidence(documentStructure = {}) {
  const evidence = [];

  const sections = Array.isArray(documentStructure.sections)
    ? documentStructure.sections
    : [];

  sections.forEach((section, index) => {
    const title = normalizeText(
      section.title || section.heading || section.text
    );

    if (!title) return;

    // filter garbage numeric headings like "1", "2", "3"
    if (/^\d+$/.test(title)) return;

    // filter extremely tiny accidental headings
    if (title.length <= 1) return;

    evidence.push({
      id: `ev_section_${String(index + 1).padStart(4, "0")}`,
      page: section.page || section.pageNumber || null,
      text: title,
      type: "section",
      source: "documentStructureBuilder",
      bbox: section.bbox || section.focusRegion || null,
      sectionId: section.id || slugify(title),
      order: section.order ?? index,
      confidence: "medium",
    });
  });

  const elements = Array.isArray(documentStructure.elements)
    ? documentStructure.elements
    : [];

  elements.forEach((element, index) => {
    const text = normalizeText(
      element.text || element.content || element.value
    );

    if (!text) return;

    // avoid tiny numeric-only structure noise
    if (/^\d+$/.test(text)) return;

    if (text.length <= 1) return;

    evidence.push({
      id: `ev_element_${String(index + 1).padStart(4, "0")}`,
      page: element.page || element.pageNumber || null,
      text,
      type: element.type || "document_element",
      source: "documentStructureBuilder",
      bbox: element.bbox || element.focusRegion || null,
      sectionId: element.sectionId || null,
      order: element.order ?? index,
      confidence:
        element.type === "heading" ||
        element.type === "code_or_command"
          ? "high"
          : "medium",
    });
  });

  return evidence;
}

function collectFallbackEvidence(extractedData = {}) {
  const text = normalizeText(extractedData.text);
  if (!text) return [];

  const chunks = text
    .split(/(?<=[.!?])\s+|\n+/)
    .map(normalizeText)
    .filter(Boolean);

  return chunks.slice(0, 250).map((chunk, index) => ({
    id: `ev_fallback_${String(index + 1).padStart(4, "0")}`,
    page: 1,
    text: chunk,
    type: "fallback_text",
    source: "extracted_fallback",
    bbox: null,
    sectionId: null,
    order: index,
    confidence: "low",
  }));
}

function mergeEvidence(...groups) {
  const seen = new Set();
  const merged = [];

  groups.flat().forEach((item) => {
    const text = normalizeText(item.text);
    if (!text) return;

    const key = `${item.page || "unknown"}:${text.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);

    merged.push({
      ...item,
      id: `ev_${String(merged.length + 1).padStart(4, "0")}`,
      text,
    });
  });

  return merged.slice(0, 600);
}

function extractConceptEntities(conceptsData = {}) {
  const conceptSources = [
    conceptsData.primaryTopics,
    conceptsData.recommendedTeachingOrder,
    conceptsData.concepts,
    conceptsData.items,
    conceptsData.semanticConcepts,
    conceptsData.localExtractionSummaries,
  ];

  const entities = [];

  conceptSources.flat().filter(Boolean).forEach((concept) => {
    if (typeof concept === "string") {
      entities.push({
        name: concept,
        type: "concept",
        source: "conceptExtractor",
        confidence: 0.74,
      });
      return;
    }

    if (typeof concept !== "object") return;

    const name =
      concept.name ||
      concept.title ||
      concept.topic ||
      concept.label ||
      concept.concept;

    if (!name) return;

    entities.push({
      name,
      type: concept.type || "concept",
      source: "conceptExtractor",
      confidence: 0.74,
    });
  });

  return entities;
}

function extractStructureEntities(documentStructure = {}) {
  const entities = [];

  const sections = Array.isArray(documentStructure.sections)
    ? documentStructure.sections
    : [];

  sections.forEach((section) => {
    const name = normalizeText(section.title || section.heading || section.text);
    if (!name) return;

    entities.push({
      name,
      type: "section",
      page: section.page || section.pageNumber || null,
      sectionId: section.id || slugify(name),
      source: "documentStructureBuilder",
      confidence: 0.7,
    });
  });

  const elements = Array.isArray(documentStructure.elements)
    ? documentStructure.elements
    : [];

  elements.forEach((element) => {
    const text = normalizeText(element.text || element.content || element.value);
    if (!text) return;

    if (element.type === "heading") {
      entities.push({
        name: text,
        type: "heading",
        page: element.page || element.pageNumber || null,
        sectionId: element.sectionId || null,
        source: "documentStructureBuilder",
        confidence: 0.78,
      });
    }

    if (element.type === "code_or_command") {
      const command = text.split("—")[0].trim();

      entities.push({
        name: command,
        type: "command",
        page: element.page || element.pageNumber || null,
        sectionId: element.sectionId || null,
        source: "documentStructureBuilder",
        confidence: 0.82,
      });
    }
  });

  return entities;
}

function extractTextMentionEntities(evidence = []) {
  const stopWords = new Set([
    "The",
    "This",
    "That",
    "When",
    "Where",
    "If",
    "Then",
    "For",
    "And",
    "But",
    "With",
    "Without",
    "Use",
    "View",
    "Show",
    "Check",
    "List",
    "Delete",
    "Inspect",
    "Access",
    "Detailed",
    "Modern",
    "Reliable",
    "Golden",
    "Rules",
    "Remember",
    "Beginner",
    "Friendly",
  ]);

  const entities = [];

  evidence.forEach((ev) => {
    const text = ev.text;

    const commandMatches =
      text.match(/\bkubectl\s+[a-z0-9-]+(?:\s+[a-z0-9_./:=*'"-]+){0,8}/gi) ||
      [];

    commandMatches.forEach((command) => {
      entities.push({
        name: normalizeText(command),
        type: "command",
        page: ev.page,
        source: "command_mentions",
        confidence: 0.8,
      });
    });

    const codeTerms = text.match(/\b[A-Z][A-Z0-9_-]{2,}\b/g) || [];
    codeTerms.forEach((term) => {
      entities.push({
        name: term,
        type: "component_or_code",
        page: ev.page,
        source: "repeated_mentions",
        confidence: 0.56,
      });
    });

    const properTerms =
      text.match(/\b[A-Z][a-zA-Z0-9_-]{2,}(?:\s+[A-Z][a-zA-Z0-9_-]{2,}){0,3}\b/g) ||
      [];

    properTerms.forEach((term) => {
      if (stopWords.has(term)) return;

      entities.push({
        name: term,
        type: "named_thing",
        page: ev.page,
        source: "text_mentions",
        confidence: 0.46,
      });
    });
  });

  return entities;
}

function mergeEntities(rawEntities = [], evidence = []) {
  const entityMap = new Map();

  rawEntities.forEach((entity) => {
    const name = normalizeText(entity.name);
    if (!name || name.length < 2) return;

    const id = slugify(name);
    if (!id) return;

    const existing = entityMap.get(id) || {
      id,
      name,
      type: entity.type || "term",
      aliases: [],
      mentions: 0,
      pages: [],
      sectionIds: [],
      evidenceIds: [],
      confidence: entity.confidence || 0.45,
      sources: [],
    };

    existing.mentions += 1;

    if (entity.page && !existing.pages.includes(entity.page)) {
      existing.pages.push(entity.page);
    }

    if (entity.sectionId && !existing.sectionIds.includes(entity.sectionId)) {
      existing.sectionIds.push(entity.sectionId);
    }

    if (entity.source && !existing.sources.includes(entity.source)) {
      existing.sources.push(entity.source);
    }

    existing.confidence = Math.max(existing.confidence, entity.confidence || 0.45);
    entityMap.set(id, existing);
  });

  const entities = Array.from(entityMap.values());

  return entities
    .map((entity) => {
      const lower = entity.name.toLowerCase();

      const matches = evidence
        .filter((ev) => ev.text.toLowerCase().includes(lower))
        .slice(0, 8)
        .map((ev) => ev.id);

      const pages = unique([
        ...entity.pages,
        ...evidence
          .filter((ev) => ev.text.toLowerCase().includes(lower))
          .map((ev) => ev.page),
      ]);

      return {
        ...entity,
        pages,
        evidenceIds: matches,
        confidence: Number(entity.confidence.toFixed(2)),
      };
    })
    .filter((entity) => entity.evidenceIds.length > 0 || entity.sources.includes("conceptExtractor"))
    .sort((a, b) => b.confidence - a.confidence || b.mentions - a.mentions)
    .slice(0, 200);
}

function extractRelationships(entities = [], evidence = []) {
  const relationships = [];
  const entityRefs = entities.map((entity) => ({
    id: entity.id,
    name: entity.name,
    lower: entity.name.toLowerCase(),
  }));

  const relationshipPatterns = [
    {
      type: "flows_to",
      regex: /\b(.+?)\s+(routes to|connects to|calls|sends to|forwards to|flows to|then)\s+(.+?)\b/i,
      confidence: 0.64,
    },
    {
      type: "depends_on",
      regex: /\b(.+?)\s+(depends on|uses|runs on|backs|powers)\s+(.+?)\b/i,
      confidence: 0.62,
    },
    {
      type: "defined_as",
      regex: /\b(.+?)\s+(is|acts as|serves as|means)\s+(.+?)\b/i,
      confidence: 0.58,
    },
    {
      type: "connects",
      regex: /\b(.+?)\s+(connects|links|maps)\s+(.+?)\b/i,
      confidence: 0.58,
    },
  ];

  evidence.forEach((ev) => {
    const lower = ev.text.toLowerCase();
    const mentioned = entityRefs
      .filter((entity) => lower.includes(entity.lower))
      .slice(0, 8);

    relationshipPatterns.forEach((pattern) => {
      const match = ev.text.match(pattern.regex);
      if (!match) return;

      const from = mentioned.find((entity) =>
        match[1].toLowerCase().includes(entity.lower)
      );
      const to = mentioned.find((entity) =>
        match[3].toLowerCase().includes(entity.lower)
      );

      if (from && to && from.id !== to.id) {
        relationships.push({
          id: `rel_${relationships.length + 1}`,
          from: from.id,
          to: to.id,
          type: pattern.type,
          evidenceIds: [ev.id],
          confidence: pattern.confidence,
        });
      }
    });

    if (mentioned.length >= 2) {
      for (let index = 0; index < mentioned.length - 1; index += 1) {
        relationships.push({
          id: `rel_${relationships.length + 1}`,
          from: mentioned[index].id,
          to: mentioned[index + 1].id,
          type: "co_mentions",
          evidenceIds: [ev.id],
          confidence: 0.38,
        });
      }
    }
  });

  const seen = new Set();

  return relationships
    .filter((relationship) => {
      const key = `${relationship.from}:${relationship.to}:${relationship.type}:${relationship.evidenceIds.join(",")}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 160);
}

function extractSequences(evidence = [], documentStructure = {}) {
  const sequenceEvidence = evidence.filter((ev) =>
    /\b(step\s*\d+|\d+\.|first|next|then|finally|after|before|rollback|validate|escalate|debugging flow)\b/i.test(
      ev.text
    )
  );

  const sectionSequences = Array.isArray(documentStructure.sections)
    ? documentStructure.sections
        .filter((section) => normalizeText(section.title || section.heading || section.text))
        .map((section, index) => ({
          order: index + 1,
          sectionId: section.id || slugify(section.title || section.heading || section.text),
          page: section.page || section.pageNumber || null,
          text: normalizeText(section.title || section.heading || section.text),
        }))
    : [];

  const sequences = [];

  if (sectionSequences.length > 0) {
    sequences.push({
      id: "seq_sections",
      type: "section_order",
      title: "Document section order",
      steps: sectionSequences.slice(0, 60),
      confidence: sectionSequences.length >= 3 ? 0.72 : 0.5,
    });
  }

  if (sequenceEvidence.length > 0) {
    sequences.push({
      id: "seq_detected_steps",
      type: "detected_steps",
      title: "Detected ordered steps",
      steps: sequenceEvidence.slice(0, 80).map((ev, index) => ({
        order: index + 1,
        evidenceId: ev.id,
        page: ev.page,
        text: ev.text,
      })),
      confidence: sequenceEvidence.length >= 3 ? 0.68 : 0.45,
    });
  }

  return sequences;
}

function summarizeGrounding(sourceGrounding = {}) {
  return {
    version: sourceGrounding.version || null,
    pageCount: sourceGrounding.pageCount || 0,
    pageTextCount: sourceGrounding.pageTextCount || 0,
    groundedUnitCount: sourceGrounding.groundedUnitCount || 0,
    focusRegionCount: sourceGrounding.focusRegionCount || 0,
    highConfidenceFocusRegionCount:
      sourceGrounding.highConfidenceFocusRegionCount || 0,
    mediumConfidenceFocusRegionCount:
      sourceGrounding.mediumConfidenceFocusRegionCount || 0,
    lowConfidenceFocusRegionCount:
      sourceGrounding.lowConfidenceFocusRegionCount || 0,
  };
}

function buildDocumentUnderstanding({
  jobDir,
  extractedPath,
  conceptsPath,
  diagramAnalysisPath,
} = {}) {
  if (!jobDir) {
    throw new Error("buildDocumentUnderstanding requires jobDir");
  }

  const extractedData = safeReadJson(
    extractedPath || path.join(jobDir, "extracted.json"),
    {}
  );

  const conceptsData = safeReadJson(
    conceptsPath || path.join(jobDir, "concepts.json"),
    {}
  );

  const diagramAnalysis = safeReadJson(
    diagramAnalysisPath || path.join(jobDir, "diagram-analysis.json"),
    {}
  );

  const extractedText = normalizeText(extractedData.text);

  const documentIntelligence = buildDocumentIntelligence({
    extractedText,
    conceptsData,
    diagramAnalysis,
  });

  const layoutBoxes = buildLayoutBoxes(jobDir);

  const documentStructure = buildDocumentStructure({
    extractedData,
    documentIntelligence,
  });

  const sourceGrounding = buildSourceGrounding({
    teachingUnits: [],
    extractedData,
    diagramAnalysis,
    pageImageCount: Array.isArray(diagramAnalysis.pages)
      ? diagramAnalysis.pages.length
      : 0,
    jobDir,
  });

  const evidence = mergeEvidence(
    collectLayoutEvidence(layoutBoxes),
    collectStructureEvidence(documentStructure),
    collectFallbackEvidence(extractedData)
  );

  const rawEntities = [
    ...extractConceptEntities(conceptsData),
    ...extractStructureEntities(documentStructure),
    ...extractTextMentionEntities(evidence),
  ];

  const entities = mergeEntities(rawEntities, evidence);
  const relationships = extractRelationships(entities, evidence);
  const sequences = extractSequences(evidence, documentStructure);

  const artifact = {
    version: VERSION,
    entities,
    relationships,
    sequences,
    evidence,
    confidence: {
      overall:
        entities.length > 0 && evidence.length > 0
          ? relationships.length > 0 || sequences.length > 0
            ? "medium"
            : "low_medium"
          : "low",
      deterministic: true,
      llmUsed: false,
      layoutBacked: Boolean(layoutBoxes?.pdfLayout?.ok),
      sourceGrounded: Boolean(sourceGrounding?.version),
      notes:
        evidence.some((item) => item.bbox)
          ? ["PyMuPDF/layout-backed evidence is available."]
          : [
              "No bbox-backed evidence found. Falling back to extracted text and document structure.",
            ],
    },
    stats: {
      documentType: documentIntelligence.primaryType || "unknown",
      secondaryTypes: documentIntelligence.secondaryTypes || [],
      textItemCount: evidence.length,
      evidenceCount: evidence.length,
      entityCount: entities.length,
      relationshipCount: relationships.length,
      sequenceCount: sequences.length,
      layoutPageCount: Array.isArray(layoutBoxes.pages)
        ? layoutBoxes.pages.length
        : 0,
      layoutBacked: Boolean(layoutBoxes?.pdfLayout?.ok),
      documentStructure: {
        elementCount: documentStructure.elementCount || 0,
        sectionCount: documentStructure.sectionCount || 0,
        stats: documentStructure.stats || {},
      },
      sourceGrounding: summarizeGrounding(sourceGrounding),
    },
    debug: {
      borrowedIdeas: [
        "docling_structured_document_objects",
        "ragflow_evidence_backed_document_context",
        "tldraw_bbox_focus_reference_model",
        "motion_canvas_scene_choreography_ready_graph",
      ],
      generatedFilesExpectedNext: [
        "architecture-understanding.json",
        "runbook-understanding.json",
        "aar-understanding.json",
      ],
    },
  };

  ensureDir(jobDir);

  fs.writeFileSync(
    path.join(jobDir, "document-understanding.json"),
    JSON.stringify(artifact, null, 2)
  );

  fs.writeFileSync(
    path.join(jobDir, "document-intelligence.json"),
    JSON.stringify(documentIntelligence, null, 2)
  );

  fs.writeFileSync(
    path.join(jobDir, "layout-boxes.json"),
    JSON.stringify(layoutBoxes, null, 2)
  );

  fs.writeFileSync(
    path.join(jobDir, "document-structure.json"),
    JSON.stringify(documentStructure, null, 2)
  );

  fs.writeFileSync(
    path.join(jobDir, "source-grounding.json"),
    JSON.stringify(sourceGrounding, null, 2)
  );

  return artifact;
}

module.exports = {
  buildDocumentUnderstanding,
};
const fs = require("fs");
const path = require("path");

const { buildLayoutBoxes } = require("./layoutBoxBuilder");
const { buildDocumentStructure } = require("./documentStructureBuilder");
const {
  buildComponentHeadingUnderstanding,
} = require(
  "./componentHeadingUnderstandingBuilder"
);
const { buildSourceGrounding } = require("./sourceGroundingBuilder");
const { buildDocumentIntelligence } = require("./documentIntelligence");

const VERSION =
  "document-understanding-v5-component-heading-identity";

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

function getEligibility(value = {}) {
  return value?.eligibility &&
    typeof value.eligibility === "object"
    ? value.eligibility
    : {};
}

function isEligibleFor(value = {}, target) {
  const eligibility = getEligibility(value);

  /*
   * Backward compatibility:
   * old artifacts without an eligibility contract retain
   * their existing behavior.
   */
  if (!(target in eligibility)) {
    return true;
  }

  return eligibility[target] !== false;
}

function isStructuralContainer(value = {}) {
  return (
    value.architectureContainer === true ||
    value.structuralRole === "architecture_container" ||
    value.structuralRole === "document_container"
  );
}

function extractProperTerms(value) {
  const text = normalizeText(value);

  if (!text) {
    return [];
  }

  return (
    text.match(
      /\b[A-Z][a-zA-Z0-9_-]{2,}(?:\s+[A-Z][a-zA-Z0-9_-]{2,}){0,3}\b/g
    ) || []
  )
    .map(normalizeText)
    .filter(Boolean);
}

function buildEntityIneligibleNameSet(
  evidence = []
) {
  const names = new Set();

  evidence
    .filter(
      (ev) => !isEligibleFor(ev, "entity")
    )
    .forEach((ev) => {
      const fullText =
        normalizeText(ev.text).toLowerCase();

      if (fullText) {
        names.add(fullText);
      }

      extractProperTerms(ev.text).forEach(
        (term) => {
          const normalizedTerm =
            normalizeText(term);

          /*
          * Derived aliases must resemble structural phrases.
          * Single-word terms such as OIDC, HTTPS, SFTP and GET
          * may be legitimate architecture entities.
          *
          * Exact full structural text is already protected above.
          */
          if (!normalizedTerm.includes(" ")) {
            return;
          }

          names.add(
            normalizedTerm.toLowerCase()
          );
        }
      );
    });

  return names;
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
        confidence:
          item.confidence ||
          (layoutBoxes.pdfLayout?.ok ? "high" : "medium"),

        headingKind:
          item.headingKind || null,

        architectureContainer:
          item.architectureContainer === true,

        structuralRole:
          item.structuralRole || null,

        eligibility: {
          ...(item.eligibility || {}),
        },
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

      page:
        section.page ||
        section.pageNumber ||
        null,

      text: title,

      type:
        "section",

      source:
        "documentStructureBuilder",

      bbox:
        section.bbox ||
        section.focusRegion ||
        null,

      sectionId:
        section.id ||
        slugify(title),

      parentSectionId:
        section.parentSectionId ||
        null,

      sectionOrder:
        section.sectionOrder ??
        index + 1,

      orderWithinSection:
        0,

      sectionDepth:
        section.sectionDepth ??
        (
          section.parentSectionId
            ? 1
            : 0
        ),

      order:
        section.order ??
        section.sectionOrder ??
        index,

      confidence:
        "medium",

      headingKind:
        section.headingKind ||
        null,

      architectureContainer:
        section.architectureContainer === true,

      structuralRole:
        section.structuralRole ||
        "document_container",

      eligibility: {
        ...(section.eligibility || {
          entity: false,
          component: false,
          relationship: false,
          sequence: false,
          evidenceContext: true,
        }),
      },
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

      page:
        element.page ||
        element.pageNumber ||
        null,

      text,

      type:
        element.type ||
        "document_element",

      source:
        "documentStructureBuilder",

      bbox:
        element.bbox ||
        element.focusRegion ||
        null,

      sectionId:
        element.sectionId ||
        null,

      parentSectionId:
        element.parentSectionId ||
        null,

      sectionOrder:
        element.sectionOrder ??
        null,

      orderWithinSection:
        element.orderWithinSection ??
        null,

      sectionDepth:
        element.sectionDepth ??
        (
          element.parentSectionId
            ? 1
            : 0
        ),

      order:
        element.order ??
        element.orderWithinSection ??
        index,

      confidence:
        element.type === "heading" ||
        element.type === "code_or_command"
          ? "high"
          : "medium",

      headingKind:
        element.headingKind ||
        null,

      architectureContainer:
        element.architectureContainer === true,

      structuralRole:
        element.structuralRole ||
        null,

      eligibility: {
        ...(element.eligibility || {}),
      },
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
  const indexByKey = new Map();
  const merged = [];

  groups.flat().forEach((item) => {
    const text = normalizeText(item.text);
    if (!text) return;

    const key = `${item.page || "unknown"}:${text.toLowerCase()}`;
    const existingIndex = indexByKey.get(key);

    if (existingIndex !== undefined) {
      const existing = merged[existingIndex];

      merged[existingIndex] = {
        ...existing,

        sources:
          unique([
            ...(existing.sources || [
              existing.source,
            ]),

            ...(item.sources || [
              item.source,
            ]),
          ]),

        /*
        * BUG-6 — Provenance-preserving evidence merge.
              *
        * Layout evidence usually owns geometry.
        * Document-structure evidence owns section identity.
        * Preserve both instead of allowing merge order to
        * erase structural lineage.
        */

        bbox:
          existing.bbox ||
          item.bbox ||
          null,

        sectionId:
          item.sectionId ||
          existing.sectionId ||
          null,

        parentSectionId:
          item.parentSectionId ??
          existing.parentSectionId ??
          null,

        sectionOrder:
          item.sectionOrder ??
          existing.sectionOrder ??
          null,

        orderWithinSection:
          item.orderWithinSection ??
          existing.orderWithinSection ??
          null,

        sectionDepth:
          item.sectionDepth ??
          existing.sectionDepth ??
          null,

        headingKind:
          item.headingKind ||
          existing.headingKind ||
          null,

        architectureContainer:
          existing.architectureContainer === true ||
          item.architectureContainer === true,

        structuralRole:
          item.structuralRole ||
          existing.structuralRole ||
          null,

        eligibility: {
          ...(existing.eligibility || {}),
          ...(item.eligibility || {}),
        },
      };

      return;
    }

    indexByKey.set(key, merged.length);

    merged.push({
      ...item,

      sources:
        unique([
          ...(item.sources || []),
          item.source,
        ]),

      id:
        `ev_${String(
          merged.length + 1
        ).padStart(4, "0")}`,

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
    const name = normalizeText(
      section.title ||
      section.heading ||
      section.text
    );

    if (!name) return;

    /*
    * Sections are structural context. They remain in
    * documentStructure and evidence, but must not become
    * architecture entities.
    */
    if (
      isStructuralContainer(section) ||
      !isEligibleFor(section, "entity")
    ) {
      return;
    }

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

    if (
      element.type === "heading" &&
      isEligibleFor(element, "entity") &&
      !isStructuralContainer(element)
    ) {
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
  const entityIneligibleNames =
  buildEntityIneligibleNameSet(
    evidence
  );

  const audit = {
    entityIneligibleNameCount:
      entityIneligibleNames.size,

    ineligibleEvidenceSkippedCount: 0,
    structuralTextMentionSuppressedCount: 0,
  };

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
    if (!isEligibleFor(ev, "entity")) {
      audit.ineligibleEvidenceSkippedCount += 1;
      return;
    }

    const text = ev.text;

    const commandMatches =
      text.match(/\bkubectl\s+[a-z0-9-]+(?:\s+[a-z0-9_./:=*'"-]+){0,8}/gi) ||
      [];

    commandMatches.forEach((command) => {
      entities.push({
        name: normalizeText(command),
        type: "command",

        page:
          ev.page,

        sectionId:
          ev.sectionId ||
          null,

        parentSectionId:
          ev.parentSectionId ||
          null,

        headingKind:
          ev.headingKind ||
          null,

        source:
          "command_mentions",

        confidence:
          0.8,
        });
    });

    const codeTerms = text.match(/\b[A-Z][A-Z0-9_-]{2,}\b/g) || [];
    codeTerms.forEach((term) => {
      entities.push({
        name: term,
        type: "component_or_code",

        page:
          ev.page,

        sectionId:
          ev.sectionId ||
          null,

        parentSectionId:
          ev.parentSectionId ||
          null,

        headingKind:
          ev.headingKind ||
          null,

        source:
          "repeated_mentions",

        confidence:
          0.56,
      });
    });

    const properTerms =
      extractProperTerms(text);

    properTerms.forEach((term) => {
      const normalizedTerm =
        normalizeText(term);

      if (!normalizedTerm) return;
      if (stopWords.has(normalizedTerm)) return;

      /*
      * Prevent concatenated structural headings from
      * becoming entities.
      *
      * Examples:
      * Component Definitions Orion Provider
      * Numbered System Journeys Journey
      * Deployment Topology Availability Zone
      */
      const concatenatedStructuralPrefixPattern =
        /^(Component Definitions|Numbered System Journeys|Deployment Topology|Shared Platform Services|Deployment and Evidence Notes)\s+/i;

      if (
        concatenatedStructuralPrefixPattern.test(
          normalizedTerm
        )
      ) {
        audit.structuralTextMentionSuppressedCount += 1;
        return;
      }

      /*
      * Prevent structural headings from being rediscovered
      * through another evidence source.
      */
      if (
        entityIneligibleNames.has(
          normalizedTerm.toLowerCase()
        )
      ) {
        audit.structuralTextMentionSuppressedCount += 1;
        return;
      }

      entities.push({
        name: normalizedTerm,
        type: "named_thing",

        page:
          ev.page,

        sectionId:
          ev.sectionId ||
          null,

        parentSectionId:
          ev.parentSectionId ||
          null,

        headingKind:
          ev.headingKind ||
          null,

        source:
          "text_mentions",

        confidence:
          0.46,
      });
    });
   
  });

  return {
      entities,
      audit,
    };
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

      type:
        entity.type ||
        "term",

      aliases: [],

      mentions:
        0,

      pages: [],

      sectionIds: [],

      parentSectionIds: [],

      headingKinds: [],

      evidenceIds: [],

      confidence:
        entity.confidence ||
        0.45,

      sources: [],
    };

    existing.mentions += 1;

    if (entity.page && !existing.pages.includes(entity.page)) {
      existing.pages.push(entity.page);
    }

    if (entity.sectionId && !existing.sectionIds.includes(entity.sectionId)) {
      existing.sectionIds.push(entity.sectionId);
    }

    if (
      entity.parentSectionId &&
      !existing.parentSectionIds.includes(
        entity.parentSectionId
      )
    ) {
      existing.parentSectionIds.push(
        entity.parentSectionId
      );
    }

    if (
      entity.headingKind &&
      !existing.headingKinds.includes(
        entity.headingKind
      )
    ) {
      existing.headingKinds.push(
        entity.headingKind
      );
    }

    if (entity.source && !existing.sources.includes(entity.source)) {
      existing.sources.push(entity.source);
    }

    existing.confidence = Math.max(
      existing.confidence,
      entity.confidence || 0.45
    );

    entityMap.set(id, existing);
  });

  const entities = Array.from(entityMap.values());

  return entities
    .map((entity) => {
      const lower = entity.name.toLowerCase();

      const matchingEvidence = evidence
        .filter((ev) =>
          ev.text
            .toLowerCase()
            .includes(lower)
        )
        .slice(0, 8);

      const matches =
        matchingEvidence.map(
          (ev) => ev.id
        );

      const pages = unique([
        ...entity.pages,

        ...matchingEvidence.map(
          (ev) => ev.page
        ),
      ]);

      const sectionIds = unique([
        ...entity.sectionIds,

        ...matchingEvidence.map(
          (ev) => ev.sectionId
        ),
      ]);

      const parentSectionIds = unique([
        ...entity.parentSectionIds,

        ...matchingEvidence.map(
          (ev) => ev.parentSectionId
        ),
      ]);

      const headingKinds = unique([
        ...entity.headingKinds,

        ...matchingEvidence.map(
          (ev) => ev.headingKind
        ),
      ]);

      return {
        ...entity,

        pages,
        sectionIds,
        parentSectionIds,
        headingKinds,

        evidenceIds:
          matches,

        confidence:
          Number(
            entity.confidence.toFixed(2)
          ),
      };
    })
    .filter(
      (entity) =>
        entity.evidenceIds.length > 0 ||
        entity.sources.includes("conceptExtractor")
    )
    .sort(
      (a, b) =>
        b.confidence - a.confidence ||
        b.mentions - a.mentions
    )
    .slice(0, 200);
}

function buildCanonicalComponents(
  entities = [],
  evidence = [],
  componentHeadingUnderstanding = {}
) {
  /*
   * BUG-3.1 — Canonical Component Promotion
   *
   * This helper does not rediscover entities.
   * It conservatively promotes existing entities that have
   * deterministic evidence of representing architecture objects.
   *
   * Generic concepts, actions, protocols and document words remain
   * available in entities[], but are not promoted to components.
   */

  const genericNames = new Set([
    "api",
    "apis",
    "authentication",
    "canonical",
    "client",
    "deployment",
    "distributed",
    "document-defined",
    "enterprise",
    "epg",
    "expected",
    "explicit",
    "failure",
    "fixture",
    "guide",
    "identity",
    "internal",
    "journey",
    "manual",
    "metadata",
    "metrics",
    "multiple",
    "numbered",
    "object",
    "page",
    "partner",
    "provider",
    "purpose",
    "raw",
    "regression",
    "relationship",
    "replicated",
    "safety",
    "schedule",
    "search",
    "shared",
    "synthetic",
    "system",
    "three",
    "topology",
    "update",
    "validation",
    "zones",
  ]);

  const protocolOrOperationNames = new Set([
    "get",
    "http",
    "https",
    "oidc",
    "sftp",
  ]);

  const actionNames = new Set([
    "accepts",
    "checks",
    "distributes",
    "joins",
    "persists",
    "preserve",
    "routes",
    "successful",
  ]);

  const architectureNouns = [
    "api",
    "app",
    "apps",
    "authentication",
    "broker",
    "cache",
    "canonical",
    "client",
    "cluster",
    "console",
    "database",
    "db",
    "distributed",
    "edge",
    "export",
    "gateway",
    "hub",
    "identity",
    "index",
    "metadata",
    "object",
    "origin",
    "packager",
    "provider",
    "queue",
    "router",
    "search",
    "service",
    "stack",
    "store",
    "telemetry",
    "validation",
    "vault",
  ];

  const contextualTailTokens = new Set([
    "downstream",
    "failed",
    "manual",
    "metrics",
    "raw",
    "schedule",
    "stb",
    "synthetic",
  ]);

  function tokenize(value) {
    return normalizeText(value)
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean);
  }

  function hasArchitectureNoun(name) {
    const tokens = tokenize(name);

    return tokens.some((token) =>
      architectureNouns.includes(token)
    );
  }


  function inferCanonicalComponentKind(
    entity,
    evidence = []
  ) {
    const entityName =
      normalizeText(entity.name);

    
    const matchingEvidence = (
      entity.evidenceIds || []
    )
      .map((id) =>
        evidence.find((ev) => ev.id === id)
      )
      .filter(Boolean);

    const focusedEvidence =
      matchingEvidence.filter((ev) => {
        const text = normalizeText(ev.text);

        return (
          text.length <= 400 &&
          (
            ev.type === "fallback_text" ||
            text
              .toLowerCase()
              .includes(
                entityName.toLowerCase()
              )
          )
        );
      });

    const evidenceText = unique(
      (
        focusedEvidence.length > 0
          ? focusedEvidence
          : matchingEvidence.filter(
              (ev) =>
                normalizeText(ev.text).length <= 400
            )
      ).map((ev) => normalizeText(ev.text))
    ).join(" ");

    const value = (
      entityName +
      " " +
      evidenceText
    ).toLowerCase();

    if (!value.trim()) {
      return "unknown";
    }

    if (
      /\b(database|db|cache|store|storage|vault|repository|metadata\s+store|object\s+storage|read\s+cache)\b/i.test(
        value
      )
    ) {
      return "data_store";
    }

    if (
      /\b(worker|processor|orchestrator|job|task|workflow|process|validation\s+(?:and\s+canonical\s+)?normalization\s+service|normalization\s+service|enrichment\s+(?:and\s+channel-mapping\s+)?service)\b/i.test(
        value
      )
    ) {
      return "process";
    }

    if (
      /\b(service|application|app|cluster|broker|queue|event\s+bus|origin|packager|hub|identity|authentication|telemetry|stack|configuration|publication|observability\s+platform)\b/i.test(
        value
      )
    ) {
      return "system_component";
    }

    if (
      /\b(api|gateway|router|routing|proxy|reverse[- ]proxy|ingress|endpoint|console|interface)\b/i.test(
        value
      )
    ) {
      return "interface";
    }

    if (
      /\b(client|provider|partner|consumer|user|browser|player|device|source|sink)\b/i.test(
        value
      )
    ) {
      return "external_actor";
    }

    if (
      /\b(file|manifest|payload|artifact|document)\b/i.test(
        value
      )
    ) {
      return "artifact";
    }

    return "unknown";
  }

  function hasDocumentDefinedNameShape(name) {
    const normalizedName = normalizeText(name);
    const tokens = tokenize(normalizedName);

    if (tokens.length < 2) {
      return false;
    }

    /*
     * Synthetic enterprise fixtures intentionally use labels such as:
     * Super8 Shared
     * RelayOne Shared
     * ConfigHub Shared
     *
     * The first token must contain a digit, internal capitalization,
     * or a sufficiently specific proper-name shape.
     */
    const firstToken =
          normalizedName.split(/\s+/)[0] || "";

        const hasDigit =
      /\d/.test(firstToken);

    const hasInternalCapital =
      /[a-z][A-Z]/.test(firstToken);

    const looksLikeSpecificProperName =
      /^[A-Z][a-z]{3,}$/.test(firstToken);

    const looksLikeUppercaseAcronym =
      /^[A-Z][A-Z0-9]{2,}$/.test(firstToken);

    const endsWithShared =
      /\sShared$/i.test(normalizedName);

    return (
      endsWithShared &&
      (
        hasDigit ||
        hasInternalCapital ||
        looksLikeSpecificProperName ||
        looksLikeUppercaseAcronym
      )
    );
  }

    function hasContextualTail(entity) {
    const tokens = tokenize(entity.name);

    if (tokens.length < 3) {
      return false;
    }

    const lastToken =
      tokens[tokens.length - 1];

    return (
      (entity.mentions || 0) <= 1 &&
      contextualTailTokens.has(lastToken)
    );
  }

  function containsStrongerCanonicalEntity(
    entity,
    allEntities = []
  ) {
    const candidateName =
      normalizeText(entity.name).toLowerCase();

    if (!candidateName) {
      return false;
    }

    return allEntities.some((other) => {
      if (!other || other.id === entity.id) {
        return false;
      }

      if ((other.mentions || 0) < 2) {
        return false;
      }

      const otherName =
        normalizeText(other.name).toLowerCase();

      if (!otherName) {
        return false;
      }

      if (otherName.length >= candidateName.length) {
        return false;
      }

      const otherTokens = tokenize(otherName);

      const containsCanonicalName =
        otherTokens.length === 1
          ? candidateName.startsWith(
              `${otherName} `
            )
          : candidateName.includes(
              otherName
            );

      if (!containsCanonicalName) {
        return false;
      }

      return hasArchitectureNoun(other.name);
    });
  }

  const trailingIdentityQualifierPattern =
    /\s+(shared|distributed|canonical|validation|metadata|provider|object|search)$/i;

  function findCleanerCanonicalEntity(
    promotedEntity,
    allEntities = []
  ) {
    const promotedName =
      normalizeText(promotedEntity.name);

    const strippedName =
      promotedName
        .replace(
          trailingIdentityQualifierPattern,
          ""
        )
        .trim();

    if (
      !strippedName ||
      strippedName === promotedName ||
      strippedName.length < 3
    ) {
      return null;
    }

    const strippedLower =
      strippedName.toLowerCase();

    /*
    * Never promote a generic word, operation, or protocol
    * into a canonical component identity.
    */
    if (
      genericNames.has(strippedLower) ||
      protocolOrOperationNames.has(strippedLower) ||
      actionNames.has(strippedLower)
    ) {
      return null;
    }

    const cleanerEntity =
      allEntities.find(
        (candidate) =>
          candidate.id !== promotedEntity.id &&
          normalizeText(
            candidate.name
          ).toLowerCase() === strippedLower
      );

    if (
      cleanerEntity &&
      Array.isArray(
        cleanerEntity.evidenceIds
      ) &&
      cleanerEntity.evidenceIds.length > 0
    ) {
      const promotedEvidenceIds =
        new Set(
          promotedEntity.evidenceIds || []
        );

      const sharedEvidenceCount =
        (
          cleanerEntity.evidenceIds ||
          []
        )
          .filter((evidenceId) =>
            promotedEvidenceIds.has(
              evidenceId
            )
          )
          .length;

      /*
      * Existing clean identity is accepted only when
      * both entities are backed by the same evidence.
      *
      * Broad section overlap alone is not sufficient.
      */
      if (sharedEvidenceCount > 0) {
        return {
          entity:
            cleanerEntity,

          derived:
            false,
        };
      }
    }

    /*
    * A clean standalone entity may not exist because PDF text
    * extraction can join the component name with its descriptive
    * qualifier.
    *
    * Derive the clean identity only from repeated,
    * definition-section-backed evidence.
    */
    const definitionBacked =
      (
        promotedEntity.sectionIds ||
        []
      )
        .some((sectionId) =>
          /component[_ -]?definitions?/i.test(
            String(
              sectionId ||
              ""
            )
          )
        );

    const repeatedEvidence =
      (promotedEntity.mentions || 0) >= 2 &&
      (
        promotedEntity.evidenceIds ||
        []
      ).length >= 2;

    if (
      !definitionBacked ||
      !repeatedEvidence
    ) {
      return null;
    }

    return {
      entity: {
        ...promotedEntity,

        id:
          slugify(
            strippedName
          ),

        name:
          strippedName,
      },

      derived:
        true,
    };
  }

  function findDocumentSiblingIdentities({
    promotedEntity,
    canonicalEntity,
    allEntities = [],
    evidence = [],
  } = {}) {
    const identityIds =
      new Set([
        promotedEntity?.id,
        canonicalEntity?.id,
      ].filter(Boolean));

    const identityNames =
      new Set([
        normalizeText(
          promotedEntity?.name
        ),
        normalizeText(
          canonicalEntity?.name
        ),
      ].filter(Boolean));

    const identityEvidenceIds =
      new Set([
        ...(
          promotedEntity?.evidenceIds ||
          []
        ),
        ...(
          canonicalEntity?.evidenceIds ||
          []
        ),
      ]);

    /*
    * Preserve another document-defined identity only when
    * structural evidence ties it to the same component context.
    *
    * This deliberately does not use semantic similarity,
    * product knowledge, or fuzzy name matching.
    */
    const promotedEvidence =
      [...identityEvidenceIds]
        .map((evidenceId) =>
          evidence.find(
            (item) =>
              item.id === evidenceId
          )
        )
        .filter(Boolean);

    for (const candidate of allEntities) {
      if (
        !candidate?.id ||
        identityIds.has(candidate.id)
      ) {
        continue;
      }

      const candidateName =
        normalizeText(
          candidate.name
        );

      if (
        !candidateName ||
        candidateName.length < 3
      ) {
        continue;
      }

      /*
      * Alternate identities must still look like
      * architecture objects.
      */
      if (
        !hasArchitectureNoun(
          candidateName
        )
      ) {
        continue;
      }

      /*
      * Require direct structural adjacency.
      * Same broad section alone is not enough.
      */
      const candidateEvidence =
        (candidate.evidenceIds || [])
          .map((evidenceId) =>
            evidence.find(
              (item) =>
                item.id === evidenceId
            )
          )
          .filter(Boolean);

      const structurallyAdjacent =
        candidateEvidence.some(
          (candidateEv) =>
            promotedEvidence.some(
              (sourceEv) => {
                /*
                * Both pieces of evidence must belong
                * to the same explicit component context.
                */
                if (
                  !sourceEv.sectionId ||
                  !candidateEv.sectionId ||
                  sourceEv.sectionId !==
                    candidateEv.sectionId
                ) {
                  return false;
                }

                /*
                * They must also occur on the same page.
                */
                if (
                  sourceEv.page !==
                  candidateEv.page
                ) {
                  return false;
                }

                const sourceOrder =
                  Number(
                    sourceEv.order
                  );

                const candidateOrder =
                  Number(
                    candidateEv.order
                  );

                /*
                * And they must be directly adjacent
                * in document order.
                */
                return (
                  Number.isFinite(
                    sourceOrder
                  ) &&
                  Number.isFinite(
                    candidateOrder
                  ) &&
                  Math.abs(
                    sourceOrder -
                    candidateOrder
                  ) <= 1
                );
              }
            )
        );

      if (!structurallyAdjacent) {
        continue;
      }

      /*
      * Do not merge generic words, operations,
      * protocols, or document vocabulary.
      */
      const lowerName =
        candidateName.toLowerCase();

      if (
        genericNames.has(lowerName) ||
        protocolOrOperationNames.has(
          lowerName
        ) ||
        actionNames.has(lowerName)
      ) {
        continue;
      }

      identityIds.add(
        candidate.id
      );

      identityNames.add(
        candidateName
      );

      for (
        const evidenceId of
        candidate.evidenceIds || []
      ) {
        identityEvidenceIds.add(
          evidenceId
        );
      }
    }

    return {
      ids:
        [...identityIds],

      names:
        [...identityNames],

      evidenceIds:
        [...identityEvidenceIds],
    };
    }

    function isOwnedDescriptiveEntity(
      entity
    ) {
      const entityName =
        normalizeText(
          entity?.name
        );

      if (!entityName) {
        return false;
      }

      const componentHeadings =
        componentHeadingUnderstanding
          ?.componentHeadings ||
        [];

      return componentHeadings.some(
        (heading) => {
          const headingName =
            normalizeText(
              heading.headingText
            );

          if (
            !headingName ||
            headingName.toLowerCase() ===
              entityName.toLowerCase()
          ) {
            return false;
          }

          const headingSectionId =
            heading.headingId;

          const escapedName =
            entityName.replace(
              /[.*+?^${}()|[\]\\]/g,
              "\\$&"
            );

          const ownedPrefixMatch =
            (
              heading.ownedContent ||
              []
            ).some((item) => {
              const text =
                normalizeText(
                  item.text
                );

              if (!text) {
                return false;
              }

              return new RegExp(
                `^${escapedName}(?:\\b|\\s|:|[-–—])`,
                "i"
              ).test(text);
            });

          if (!ownedPrefixMatch) {
            return false;
          }

          const externalEvidence =
            (
              entity.evidenceIds ||
              []
            )
              .map((evidenceId) =>
                evidence.find(
                  (item) =>
                    item.id === evidenceId
                )
              )
              .filter(Boolean)
              .filter(
                (item) =>
                  item.sectionId !==
                  headingSectionId
              );

          return (
            externalEvidence.length === 0
          );
        }
      );
    }

    const promotedComponents =
      entities
        .filter((entity) => {
          const name =
            normalizeText(entity.name);

          const lowerName =
            name.toLowerCase();

          if (!name) {
            return false;
          }

          /*
          * BUG-1A
          *
          * Narrative owned by a component-bearing heading
          * must not replace that heading as canonical identity.
          */
          if (
            isOwnedDescriptiveEntity(
              entity
            )
          ) {
            return false;
          }

          if (genericNames.has(lowerName)) {
          return false;
        }

        if (
          protocolOrOperationNames.has(
            lowerName
          )
        ) {
          return false;
        }

        if (actionNames.has(lowerName)) {
          return false;
        }

        if (
          !Array.isArray(
            entity.evidenceIds
          ) ||
          entity.evidenceIds.length === 0
        ) {
          return false;
        }

        if (hasContextualTail(entity)) {
          return false;
        }

        if (
          containsStrongerCanonicalEntity(
            entity,
            entities
          )
        ) {
          return false;
        }

        const architectureSignal =
          hasArchitectureNoun(name);

        const documentDefinedSignal =
          hasDocumentDefinedNameShape(name);

        const hasDefinitionSection =
          (entity.sectionIds || []).some(
            (sectionId) =>
              /component[_ -]?definitions?/i.test(
                String(sectionId || "")
              )
          );

        const extractedFallbackOnly =
          (entity.evidenceIds || []).every(
            (evidenceId) => {
              const ev = evidence.find(
                (item) => item.id === evidenceId
              );

              return (
                ev &&
                ev.source === "extracted_fallback"
              );
            }
          );

        if (
          architectureSignal &&
          !documentDefinedSignal &&
          !hasDefinitionSection &&
          extractedFallbackOnly
        ) {
          return false;
        }

        return (
          architectureSignal ||
          documentDefinedSignal
        );
              })
              .map((entity) => {
                const architectureNounSignal =
                  hasArchitectureNoun(
                    entity.name
                  );

        const documentDefinedNameSignal =
          hasDocumentDefinedNameShape(
            entity.name
          );

        const promotionReasons = [];

        if (architectureNounSignal) {
          promotionReasons.push(
            "architecture_noun"
          );
        }

        if (documentDefinedNameSignal) {
          promotionReasons.push(
            "document_defined_name_shape"
          );
        }

        const confidence =
          architectureNounSignal &&
          documentDefinedNameSignal
            ? 0.82
            : architectureNounSignal
              ? 0.76
              : 0.68;

        const cleanIdentityResolution =
          findCleanerCanonicalEntity(
            entity,
            entities
          );

        const canonicalEntity =
            cleanIdentityResolution?.entity ||
            entity;

          if (cleanIdentityResolution) {
            promotionReasons.push(
              cleanIdentityResolution.derived
                ? "derived_clean_document_identity"
                : "clean_document_identity"
            );
          }

          const siblingIdentities =
            findDocumentSiblingIdentities({
              promotedEntity:
                entity,

              canonicalEntity,

              allEntities:
                entities,

              evidence,
            });

          const baseIdentityNames =
            new Set(
              [
                entity.name,
                canonicalEntity.name,
              ]
                .map(normalizeText)
                .filter(Boolean)
            );

          const hasSiblingIdentity =
            siblingIdentities.names.some(
              (name) =>
                !baseIdentityNames.has(
                  normalizeText(name)
                )
            );

          if (hasSiblingIdentity) {
            promotionReasons.push(
              "document_structural_identity_alias"
            );
          }

          const combinedEvidenceIds =
            unique([
              ...(entity.evidenceIds || []),

              ...(
                canonicalEntity.evidenceIds ||
                []
              ),

              ...(
                siblingIdentities.evidenceIds ||
                []
              ),
            ]);

        const componentEvidence =
          combinedEvidenceIds
            .map((evidenceId) =>
              evidence.find(
                (item) =>
                  item.id === evidenceId
              )
            )
            .filter(Boolean);

        return {
          id:
            canonicalEntity.id,

          title:
            canonicalEntity.name,

          kind:
            inferCanonicalComponentKind(
              {
                ...canonicalEntity,
                evidenceIds:
                  combinedEvidenceIds,
              },
              evidence
            ),

          entityId:
            entity.id,

          canonicalIdentitySource:
            cleanIdentityResolution?.derived
              ? "derived_from_definition_label"
              : cleanIdentityResolution
                ? "existing_clean_entity"
                : "original_entity",

          evidenceIds:
            combinedEvidenceIds,

          pages:
            unique([
              ...(entity.pages || []),

              ...(
                canonicalEntity.pages ||
                []
              ),

              ...componentEvidence.map(
                (item) =>
                  item.page
              ),
            ]),

          sectionIds:
            unique([
              ...(entity.sectionIds || []),

              ...(
                canonicalEntity.sectionIds ||
                []
              ),

              ...componentEvidence.map(
                (item) =>
                  item.sectionId
              ),
            ]),

          parentSectionIds:
            unique([
              ...(
                entity.parentSectionIds ||
                []
              ),

              ...(
                canonicalEntity.parentSectionIds ||
                []
              ),

              ...componentEvidence.map(
                (item) =>
                  item.parentSectionId
              ),
            ]),

          headingKinds:
            unique([
              ...(entity.headingKinds || []),

              ...(
                canonicalEntity.headingKinds ||
                []
              ),

              ...componentEvidence.map(
                (item) =>
                  item.headingKind
              ),
            ]),

          mentions:
            Math.max(
              entity.mentions || 0,
              canonicalEntity.mentions || 0
            ),

          confidence:
            Number(
              confidence.toFixed(2)
            ),

          promotionReasons:
            unique(
              promotionReasons
            ),

          rawIdentityIds:
            unique([
              entity.id,
              canonicalEntity.id,
              ...siblingIdentities.ids,
            ]),

          rawIdentityNames:
            unique([
              entity.name,
              canonicalEntity.name,
              ...siblingIdentities.names,
            ]),
        };
      });

  /*
   * Multiple decorated candidates may resolve to the same
   * clean component identity. Merge them into one registry
   * entry instead of emitting duplicates.
   */
  const registryById =
    new Map();

    /*
   * BUG-1A — Component-bearing headings seed canonical
   * component identity directly.
   *
   * They do NOT enter entities[] and therefore do not
   * weaken the structural eligibility firewall.
   */
  const headingPromotedComponents =
    (
      componentHeadingUnderstanding
        ?.componentHeadings ||
      []
    )
      .map((heading) => {
        const title =
          normalizeText(
            heading.headingText
          );

        if (!title) {
          return null;
        }

        const headingEvidenceIds =
          unique(
            heading.evidenceIds ||
            []
          );

        const headingEvidence =
          headingEvidenceIds
            .map((evidenceId) =>
              evidence.find(
                (item) =>
                  item.id ===
                  evidenceId
              )
            )
            .filter(Boolean);

        const pseudoEntity = {
          id:
            slugify(title),

          name:
            title,

          evidenceIds:
            headingEvidenceIds,

          pages:
            unique([
              heading.page,

              ...headingEvidence.map(
                (item) =>
                  item.page
              ),
            ]),

          sectionIds:
            unique([
              heading.headingId,

              ...headingEvidence.map(
                (item) =>
                  item.sectionId
              ),
            ]),

          parentSectionIds:
            unique([
              heading.parentSectionId,

              ...headingEvidence.map(
                (item) =>
                  item.parentSectionId
              ),
            ]),

          headingKinds:
            unique([
              heading.headingKind,

              ...headingEvidence.map(
                (item) =>
                  item.headingKind
              ),
            ]),
        };

        return {
          id:
            pseudoEntity.id,

          title,

          kind:
            inferCanonicalComponentKind(
              pseudoEntity,
              evidence
            ),

          entityId:
            null,

          canonicalIdentitySource:
            "component_bearing_heading",

          evidenceIds:
            headingEvidenceIds,

          pages:
            pseudoEntity.pages,

          sectionIds:
            pseudoEntity.sectionIds,

          parentSectionIds:
            pseudoEntity
              .parentSectionIds,

          headingKinds:
            pseudoEntity
              .headingKinds,

          mentions:
            Math.max(
              1,
              Number(
                heading
                  .externalReferenceCount ||
                0
              )
            ),

          confidence:
            heading.confidence ===
              "high"
              ? 0.9
              : 0.8,

          promotionReasons: [
            "component_bearing_heading",
            ...(
              heading.basis ||
              []
            ),
          ],

          rawIdentityIds: [
            pseudoEntity.id,
          ],

          rawIdentityNames: [
            title,
          ],

          componentHeadingId:
            heading.headingId,

          ownedContent:
            heading.ownedContent ||
            [],
        };
      })
      .filter(Boolean);  

        [
        ...headingPromotedComponents,
        ...promotedComponents,
      ]
      .forEach(
        (component) => {
          const existing =
            registryById.get(
              component.id
            );

      if (!existing) {
        registryById.set(
          component.id,
          component
        );

        return;
      }

      registryById.set(
        component.id,
        {
          ...existing,

          evidenceIds:
            unique([
              ...(
                existing.evidenceIds ||
                []
              ),

              ...(
                component.evidenceIds ||
                []
              ),
            ]),

          pages:
            unique([
              ...(existing.pages || []),
              ...(component.pages || []),
            ]),

          sectionIds:
            unique([
              ...(
                existing.sectionIds ||
                []
              ),

              ...(
                component.sectionIds ||
                []
              ),
            ]),

          parentSectionIds:
            unique([
              ...(
                existing.parentSectionIds ||
                []
              ),

              ...(
                component.parentSectionIds ||
                []
              ),
            ]),

          headingKinds:
            unique([
              ...(
                existing.headingKinds ||
                []
              ),

              ...(
                component.headingKinds ||
                []
              ),
            ]),

          promotionReasons:
            unique([
              ...(
                existing.promotionReasons ||
                []
              ),

              ...(
                component.promotionReasons ||
                []
              ),
            ]),

          rawIdentityIds:
            unique([
              ...(
                existing.rawIdentityIds ||
                []
              ),

              ...(
                component.rawIdentityIds ||
                []
              ),
            ]),

          rawIdentityNames:
            unique([
              ...(
                existing.rawIdentityNames ||
                []
              ),

              ...(
                component.rawIdentityNames ||
                []
              ),
            ]),

          mentions:
            Math.max(
              existing.mentions || 0,
              component.mentions || 0
            ),

          confidence:
            Math.max(
              existing.confidence || 0,
              component.confidence || 0
            ),
        }
      );
    }
  );

  return Array
    .from(
      registryById.values()
    )
    .sort(
      (a, b) =>
        b.confidence - a.confidence ||
        b.mentions - a.mentions ||
        a.title.localeCompare(
          b.title
        )
    );
}

function extractRelationships(
  canonicalComponents = [],
  evidence = []
) {
  const relationships = [];
  const seen = new Set();

  function escapeRegExp(value) {
    return String(value || "")
      .replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function normalizeAlias(value) {
    return normalizeText(value).toLowerCase();
  }

  const trailingQualifierPattern =
    /\s+(shared|distributed|canonical|validation|metadata|authentication|provider|object)$/i;

  /*
   * Build deterministic aliases.
   *
   * Atlas Validation       -> Atlas Validation, Atlas
   * Raw Vault Object       -> Raw Vault Object, Raw Vault
   * Schedule Export Shared -> Schedule Export Shared, Schedule Export
   */
  const componentRefs = canonicalComponents
    .map((component) => {
      const title = normalizeText(component.title);

      if (!component.id || !title) {
        return null;
      }

      const aliases = new Set([title]);

      const strippedTitle = title
        .replace(trailingQualifierPattern, "")
        .trim();

      if (strippedTitle.length >= 3) {
        aliases.add(strippedTitle);
      }

      const firstToken =
        title.split(/\s+/)[0] || "";

      if (
        firstToken.length >= 4 &&
        !/^(dead|raw|read|schedule)$/i.test(firstToken)
      ) {
        aliases.add(firstToken);
      }

      return {
        id: component.id,
        title,
        aliases: [...aliases],
      };
    })
    .filter(Boolean);

  /*
   * Reject ambiguous aliases.
   *
   * OIDC Authentication and OIDC Shared both produce OIDC,
   * so the alias OIDC must not choose either component.
   */
  const aliasOwners = new Map();

  componentRefs.forEach((component) => {
    component.aliases.forEach((alias) => {
      const key = normalizeAlias(alias);

      if (!aliasOwners.has(key)) {
        aliasOwners.set(key, new Set());
      }

      aliasOwners
        .get(key)
        .add(component.id);
    });
  });

  componentRefs.forEach((component) => {
    component.aliases =
      component.aliases.filter((alias) => {
        const owners =
          aliasOwners.get(
            normalizeAlias(alias)
          );

        return owners?.size === 1;
      });
  });

  const relationshipPatterns = [
    {
      type: "flows_to",
      regex:
        /\b(routes|forwards|sends|delivers|passes|returns)\b[\s\S]{0,120}?\bto\b/gi,
      matchedVerbGroup: 1,
      confidence: 0.82,
    },
    {
      type: "publishes_to",
      regex:
        /\b(publishes|emits|distributes)\b[\s\S]{0,120}?\bto\b/gi,
      matchedVerbGroup: 1,
      confidence: 0.84,
    },
    {
      type: "writes_to",
      regex:
        /\b(writes|commits|persists)\b[\s\S]{0,120}?\bto\b/gi,
      matchedVerbGroup: 1,
      confidence: 0.84,
    },
    {
      type: "writes_to",
      regex:
        /\b(stores|archives|saves)\b[\s\S]{0,120}?\b(?:in|to)\b/gi,
      matchedVerbGroup: 1,
      confidence: 0.82,
    },
    {
      type: "reads_from",
      regex:
        /\b(reads|loads|retrieves|fetches)\b[\s\S]{0,120}?\bfrom\b/gi,
      matchedVerbGroup: 1,
      confidence: 0.84,
    },
    {
      type: "calls",
      regex:
        /\b(calls|invokes|queries|checks)\b/gi,
      matchedVerbGroup: 1,
      confidence: 0.8,
    },
    {
      type: "depends_on",
      regex:
        /\b(depends\s+on|relies\s+on|uses)\b/gi,
      matchedVerbGroup: 1,
      confidence: 0.74,
    },
    {
      type: "connects_to",
      regex:
        /\b(connects\s+to|links\s+to)\b/gi,
      matchedVerbGroup: 1,
      confidence: 0.72,
    },
  ];

  function findComponentMentions(text) {
    const mentions = [];

    componentRefs.forEach((component) => {
      component.aliases.forEach((alias) => {
        const regex = new RegExp(
          `(^|[^a-z0-9])(${escapeRegExp(alias)})(?=$|[^a-z0-9])`,
          "gi"
        );

        let match;

        while ((match = regex.exec(text)) !== null) {
          const boundaryLength =
            match[1]?.length || 0;

          const start =
            match.index + boundaryLength;

          const end =
            start + match[2].length;

          mentions.push({
            component,
            alias: match[2],
            start,
            end,
          });

          if (regex.lastIndex === match.index) {
            regex.lastIndex += 1;
          }
        }
      });
    });

    /*
     * Prefer longer aliases beginning at the same position.
     */
    return mentions
      .sort(
        (a, b) =>
          a.start - b.start ||
          b.alias.length - a.alias.length
      )
      .filter(
        (mention, index, all) =>
          !all.some(
            (other, otherIndex) =>
              otherIndex < index &&
              other.start === mention.start &&
              other.end >= mention.end
          )
      );
  }

  function splitRelationshipClauses(text) {
    return normalizeText(text)
      /*
       * Split numbered journeys:
       * "1. X ... 2. Y ... 3. Z ..."
       */
      .replace(/\s+(?=\d+\.\s+)/g, "\n")
      .split(/\n+|(?<=[.!?])\s+|;/)
      .map(normalizeText)
      .filter(Boolean);
  }

  function addRelationship({
    from,
    to,
    type,
    evidenceItem,
    confidence,
    matchedVerb,
  }) {
    const evidenceId =
      evidenceItem?.id ||
      null;
    if (
      !from?.id ||
      !to?.id ||
      from.id === to.id ||
      !evidenceId
    ) {
      return;
    }

    const key = [
      from.id,
      type,
      to.id,
    ].join(":");

    const existing =
      relationships.find(
        (relationship) =>
          relationship.from === from.id &&
          relationship.type === type &&
          relationship.to === to.id
      );

    if (existing) {
      if (
        !existing.evidenceIds.includes(
          evidenceId
        )
      ) {
        existing.evidenceIds.push(
          evidenceId
        );
      }

      existing.pages =
        unique([
          ...(existing.pages || []),
          evidenceItem?.page,
        ]);

      existing.sectionIds =
        unique([
          ...(existing.sectionIds || []),
          evidenceItem?.sectionId,
        ]);

      existing.parentSectionIds =
        unique([
          ...(existing.parentSectionIds || []),
          evidenceItem?.parentSectionId,
        ]);

      existing.headingKinds =
        unique([
          ...(existing.headingKinds || []),
          evidenceItem?.headingKind,
        ]);

      if (
        !existing.matchedVerbs.includes(
          matchedVerb
        )
      ) {
        existing.matchedVerbs.push(
          matchedVerb
        );
      }

      existing.confidence = Math.max(
        existing.confidence,
        confidence
      );

      return;
    }

    seen.add(key);

    relationships.push({
      id:
        `rel_${String(
          relationships.length + 1
        ).padStart(4, "0")}`,

      from:
        from.id,

      to:
        to.id,

      type,

      evidenceIds: [
        evidenceId,
      ],

      pages:
        unique([
          evidenceItem?.page,
        ]),

      sectionIds:
        unique([
          evidenceItem?.sectionId,
        ]),

      parentSectionIds:
        unique([
          evidenceItem?.parentSectionId,
        ]),

      headingKinds:
        unique([
          evidenceItem?.headingKind,
        ]),

      confidence,

      basis:
        "explicit_relationship_language",

      matchedVerb,

      matchedVerbs: [
        matchedVerb,
      ],
    });
  }

  evidence.forEach((ev) => {
    if (!isEligibleFor(ev, "relationship")) {
      return;
    }

    const text = normalizeText(ev.text);

    if (!text || !ev.id) {
      return;
    }

    splitRelationshipClauses(text)
      .forEach((clause) => {
        const mentions =
          findComponentMentions(clause);

        if (mentions.length < 2) {
          return;
        }

        relationshipPatterns.forEach(
          (pattern) => {
            pattern.regex.lastIndex = 0;

            let match;

            while (
              (match =
                pattern.regex.exec(clause)) !==
              null
            ) {
              const verbStart = match.index;
              const verbEnd =
                match.index + match[0].length;

              const beforeVerb =
                mentions.filter(
                  (mention) =>
                    mention.end <= verbStart
                );

              const afterVerb =
                mentions.filter(
                  (mention) =>
                    mention.start >= verbEnd
                );

              /*
               * Usually the closest preceding mention is
               * the subject.
               *
               * When a clause starts with a component and
               * contains coordinated verbs, preserve that
               * opening component as the subject:
               *
               * Atlas archives ... Raw Vault and publishes ... RelayOne
               */
              const openingMention =
                beforeVerb.find(
                  (mention) =>
                    mention.start <= 12
                );

              const fromMention =
                openingMention ||
                beforeVerb[
                  beforeVerb.length - 1
                ];

              const toMention =
                afterVerb[0];

              if (
                !fromMention ||
                !toMention
              ) {
                continue;
              }

              addRelationship({
                from:
                  fromMention.component,

                to:
                  toMention.component,

                type:
                  pattern.type,

                evidenceItem:
                  ev,

                confidence:
                  pattern.confidence,

                matchedVerb:
                  match[
                    pattern.matchedVerbGroup
                  ] || match[0],
              });

              if (
                pattern.regex.lastIndex ===
                match.index
              ) {
                pattern.regex.lastIndex += 1;
              }
            }
          }
        );
      });
  });

  return relationships;
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
          order:
            index + 1,

          sectionId:
            section.id ||
            slugify(
              section.title ||
              section.heading ||
              section.text
            ),

          parentSectionId:
            section.parentSectionId ||
            null,

          sectionOrder:
            section.sectionOrder ??
            index + 1,

          sectionDepth:
            section.sectionDepth ??
            (
              section.parentSectionId
                ? 1
                : 0
            ),

          headingKind:
            section.headingKind ||
            null,

          page:
            section.page ||
            section.pageNumber ||
            null,

          text:
            normalizeText(
              section.title ||
              section.heading ||
              section.text
            ),
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
      steps:
      sequenceEvidence
        .slice(0, 80)
        .map((ev, index) => ({
          order:
            index + 1,

          evidenceId:
            ev.id,

          page:
            ev.page,

          sectionId:
            ev.sectionId ||
            null,

          parentSectionId:
            ev.parentSectionId ||
            null,

          sectionOrder:
            ev.sectionOrder ??
            null,

          sectionDepth:
            ev.sectionDepth ??
            null,

          headingKind:
            ev.headingKind ||
            null,

          text:
            ev.text,
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

  const documentStructure =
    buildDocumentStructure({
      extractedData,
      documentIntelligence,
      layoutBoxes,
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
    collectLayoutEvidence(
      layoutBoxes
    ),
    collectStructureEvidence(
      documentStructure
    ),
    collectFallbackEvidence(
      extractedData
    )
  );

  /*
  * BUG-1A — Component-Bearing Heading Identity
  *
  * Consume the hierarchy already established by
  * documentStructureBuilder without weakening the
  * structural entity firewall.
  */
  const componentHeadingUnderstanding =
    buildComponentHeadingUnderstanding({
      documentStructure,
      evidence,
      outputDir:
        jobDir,
    });

  const textMentionExtraction =
    extractTextMentionEntities(
      evidence
    );

  const rawEntities = [
    ...extractConceptEntities(conceptsData),
    ...extractStructureEntities(documentStructure),
    ...textMentionExtraction.entities,
  ];

  const entities = mergeEntities(
    rawEntities,
    evidence
  );

  const canonicalComponents =
    buildCanonicalComponents(
      entities,
      evidence,
      componentHeadingUnderstanding
    );

  const entityIneligibleNames =
    buildEntityIneligibleNameSet(
      evidence
    );

  const ineligibleEntityLeaks = entities.filter(
    (entity) =>
      entityIneligibleNames.has(
        normalizeText(entity.name).toLowerCase()
      )
  );

  const ineligibleEntityLeakCount =
    ineligibleEntityLeaks.length;

  const relationships = extractRelationships(canonicalComponents, evidence);
  const sequences = extractSequences(evidence, documentStructure);

  const structureEvidence =
    evidence.filter(
      (item) =>
        item.source ===
          "documentStructureBuilder" ||
        (
          Array.isArray(item.sources) &&
          item.sources.includes(
            "documentStructureBuilder"
          )
        )
    );

  const structureEvidenceWithoutSectionIdCount =
    structureEvidence.filter(
      (item) =>
        !item.sectionId
    ).length;

  const canonicalComponentWithoutSectionContextCount =
    canonicalComponents.filter(
      (component) =>
        !Array.isArray(
          component.sectionIds
        ) ||
        component.sectionIds.length === 0
    ).length;

  const relationshipWithoutSectionContextCount =
    relationships.filter(
      (relationship) =>
        !Array.isArray(
          relationship.sectionIds
        ) ||
        relationship.sectionIds.length === 0
    ).length;

  const contextPropagationHealth = {
    version:
      "document-context-propagation-health-v1",

    valid:
      structureEvidenceWithoutSectionIdCount === 0,

    warningCount:
      canonicalComponentWithoutSectionContextCount +
      relationshipWithoutSectionContextCount,

    structureEvidenceCount:
      structureEvidence.length,

    structureEvidenceWithoutSectionIdCount,

    canonicalComponentCount:
      canonicalComponents.length,

    canonicalComponentWithoutSectionContextCount,

    relationshipCount:
      relationships.length,

    relationshipWithoutSectionContextCount,
  };

  const structuralItems = [
    ...(Array.isArray(documentStructure.sections)
      ? documentStructure.sections
      : []),

    ...(Array.isArray(documentStructure.elements)
      ? documentStructure.elements
      : []),
  ];

  const structuralContainerCount =
    structuralItems.filter((item) =>
      isStructuralContainer(item)
    ).length;

  const structuralEntityLeakCount =
    entities.filter((entity) =>
      entity.sources?.includes(
        "documentStructureBuilder"
      ) &&
      (
        entity.type === "heading" ||
        entity.type === "section"
      )
    ).length;

      const structuralEligibilityHealth = {
      version: "structural-eligibility-health-v1",

      valid:
        structuralEntityLeakCount === 0 &&
        ineligibleEntityLeakCount === 0,

      structuralEntityLeakCount,
      ineligibleEntityLeakCount,

      entityIneligibleNameCount:
        textMentionExtraction.audit
          .entityIneligibleNameCount,

      ineligibleEvidenceSkippedCount:
        textMentionExtraction.audit
          .ineligibleEvidenceSkippedCount,

      structuralTextMentionSuppressedCount:
        textMentionExtraction.audit
          .structuralTextMentionSuppressedCount,

      leakedEntityIds:
        ineligibleEntityLeaks.map(
          (entity) => entity.id
        ),
    };

  const artifact = {
    version: VERSION,
    layoutBoxes,
    documentStructure,
    componentHeadingUnderstanding,
    entities,
    canonicalComponents,
    relationships,
    sequences,
    evidence,
    health: {
      structuralEligibility:
        structuralEligibilityHealth,

      contextPropagation:
        contextPropagationHealth,

      componentHeading:
        componentHeadingUnderstanding
          .health,
    },

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
      documentType:
        documentIntelligence.primaryType ||
        "unknown",

      secondaryTypes:
        documentIntelligence.secondaryTypes ||
        [],

      textItemCount: evidence.length,
      evidenceCount: evidence.length,
      entityCount: entities.length,

      componentHeadingCount:
        componentHeadingUnderstanding
          .stats
          .headingCount,

      componentBearingHeadingCount:
        componentHeadingUnderstanding
          .stats
          .componentBearingHeadingCount,

      componentHeadingRejectedCount:
        componentHeadingUnderstanding
          .stats
          .rejectedHeadingCount,

      componentHeadingHealthValid:
        componentHeadingUnderstanding
          .health
          .valid,

      canonicalComponentCount:
        canonicalComponents.length,

      canonicalComponentArchitectureNounCount:
        canonicalComponents.filter(
          (component) =>
            component.promotionReasons.includes(
              "architecture_noun"
            )
        ).length,

      canonicalComponentDocumentDefinedNameCount:
        canonicalComponents.filter(
          (component) =>
            component.promotionReasons.includes(
              "document_defined_name_shape"
            )
        ).length,

      relationshipCount: relationships.length,
      sequenceCount: sequences.length,

      contextPropagationValid:
        contextPropagationHealth.valid,

      structureEvidenceWithoutSectionIdCount:
        contextPropagationHealth
          .structureEvidenceWithoutSectionIdCount,

      canonicalComponentWithoutSectionContextCount:
        contextPropagationHealth
          .canonicalComponentWithoutSectionContextCount,

      relationshipWithoutSectionContextCount:
        contextPropagationHealth
          .relationshipWithoutSectionContextCount,

      structuralContainerCount,
      structuralEntityLeakCount,
            structuralEligibilityValid:
        structuralEligibilityHealth.valid,

      entityIneligibleNameCount:
        structuralEligibilityHealth
          .entityIneligibleNameCount,

      ineligibleEvidenceSkippedCount:
        structuralEligibilityHealth
          .ineligibleEvidenceSkippedCount,

      structuralTextMentionSuppressedCount:
        structuralEligibilityHealth
          .structuralTextMentionSuppressedCount,

      ineligibleEntityLeakCount:
        structuralEligibilityHealth
          .ineligibleEntityLeakCount,

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
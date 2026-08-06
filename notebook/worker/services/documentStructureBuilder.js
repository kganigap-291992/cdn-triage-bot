// notebook/worker/services/documentStructureBuilder.js

/**
 * Phase 8C.3D — Document Structure Builder
 *
 * Goal:
 * - Create a generic document structure layer before lessonGraphBuilder.
 * - Borrow ideas from Marker, Unstructured.io, and LlamaIndex without adding dependencies yet.
 *
 * Borrowed ideas adapted for Cachey:
 * - Marker: preserve headings, code blocks, tables, and markdown-ish structure.
 * - Unstructured.io: normalize content into document elements.
 * - LlamaIndex: build section → child element hierarchy.
 *
 * This file is intentionally dependency-free for v1.
 * It should work with extracted.json shapes we already use:
 * - extractedData.pages[]
 * - extractedData.pageTexts[]
 * - extractedData.text / fullText / content / markdown
 */


const HEADING_KINDS = {
  JOURNEY: "journey",
  COMPONENT_DEFINITIONS: "component_definitions",
  DEPLOYMENT: "deployment",
  SHARED_INFRASTRUCTURE: "shared_infrastructure",
  ARCHITECTURE: "architecture",
  GLOSSARY: "glossary",
  LEGEND: "legend",
  VALIDATION: "validation",
  DOCUMENTATION: "documentation",
  GENERIC: "generic",
};

const STRUCTURAL_ROLES = {
  ARCHITECTURE_CONTAINER: "architecture_container",
  DOCUMENT_CONTAINER: "document_container",
  CONTENT: "content",
};

const STRUCTURAL_CONTAINER_ELIGIBILITY = Object.freeze({
  entity: false,
  component: false,
  relationship: false,
  sequence: false,
  evidenceContext: true,
});



function safeString(value) {
  return String(value || "").trim();
}

function safeLower(value) {
  return safeString(value).toLowerCase();
}

function uniq(values) {
  return Array.from(
    new Set(
      values
        .map((value) => safeString(value))
        .filter(Boolean)
    )
  );
}

function normalizeWhitespace(value) {
  return safeString(value)
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function normalizeHeadingText(value) {
  return safeString(value)
    .replace(/^#+\s*/, "")
    .replace(/[:：]\s*$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function classifyHeadingKind(value) {
  const text = normalizeHeadingText(value);

  if (!text) {
    return HEADING_KINDS.GENERIC;
  }

  if (
    /^journey\s+\d+\b/i.test(text) ||
    /^system journey\s+\d+\b/i.test(text) ||
    /^numbered system journeys?\b/i.test(text)
  ) {
    return HEADING_KINDS.JOURNEY;
  }

  if (
    /\b(component|service|system)\s+definitions?\b/i.test(text) ||
    /^(definitions?|defined components?)$/i.test(text)
  ) {
    return HEADING_KINDS.COMPONENT_DEFINITIONS;
  }

  if (/\b(glossary|acronyms?|terminology)\b/i.test(text)) {
    return HEADING_KINDS.GLOSSARY;
  }

  if (/\b(legend|diagram key|visual key)\b/i.test(text)) {
    return HEADING_KINDS.LEGEND;
  }

  if (
    /\b(shared infrastructure|shared platform|shared services?|global services?)\b/i.test(
      text
    )
  ) {
    return HEADING_KINDS.SHARED_INFRASTRUCTURE;
  }

  if (
    /\b(deployment|availability zones?|regions?|data centers?|datacenters?|sites?)\b/i.test(
      text
    )
  ) {
    return HEADING_KINDS.DEPLOYMENT;
  }

  if (
    /\b(architecture|topology|system diagram|component diagram)\b/i.test(
      text
    )
  ) {
    return HEADING_KINDS.ARCHITECTURE;
  }

  if (
    /\b(validation|conformance|regression|expected results?|acceptance criteria|health checks?)\b/i.test(
      text
    )
  ) {
    return HEADING_KINDS.VALIDATION;
  }

  if (
    /\b(overview|introduction|purpose|background|notes?|recommendations?|design goals?|safety rules?|appendix|summary|recap)\b/i.test(
      text
    )
  ) {
    return HEADING_KINDS.DOCUMENTATION;
  }

  return HEADING_KINDS.GENERIC;
}

function isArchitectureContainerHeadingKind(headingKind) {
  return [
    HEADING_KINDS.JOURNEY,
    HEADING_KINDS.COMPONENT_DEFINITIONS,
    HEADING_KINDS.DEPLOYMENT,
    HEADING_KINDS.SHARED_INFRASTRUCTURE,
    HEADING_KINDS.ARCHITECTURE,
    HEADING_KINDS.GLOSSARY,
    HEADING_KINDS.LEGEND,
  ].includes(headingKind);
}

function buildElementEligibility({
  type,
  architectureContainer = false,
} = {}) {
  if (type === "heading") {
    return {
      structuralRole: architectureContainer
        ? STRUCTURAL_ROLES.ARCHITECTURE_CONTAINER
        : STRUCTURAL_ROLES.DOCUMENT_CONTAINER,

      eligibility: {
        ...STRUCTURAL_CONTAINER_ELIGIBILITY,
      },
    };
  }

  return {
    structuralRole: STRUCTURAL_ROLES.CONTENT,

    eligibility: {
      entity: true,
      component: false,
      relationship: true,
      sequence:
        type === "list_item" ||
        type === "narrative_text",
      evidenceContext: true,
    },
  };
}

function slugify(value) {
  return safeLower(value)
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
}

function normalizeHeadingMatchKey(value) {
  return safeLower(
    normalizeHeadingText(value)
  )
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildLayoutHeadingPageIndex(
  layoutBoxes = {}
) {
  const headingPageIndex = new Map();

  const pages = Array.isArray(
    layoutBoxes.pages
  )
    ? layoutBoxes.pages
    : [];

  pages
    .slice()
    .sort(
      (a, b) =>
        Number(a.page || 0) -
        Number(b.page || 0)
    )
    .forEach((page, pageIndex) => {
      const pageNumber = Number(
        page.page ||
        page.pageNumber ||
        pageIndex + 1
      );

      const blocks = Array.isArray(
        page.blocks
      )
        ? page.blocks
        : [];

      blocks
        .filter(
          (block) =>
            block.type === "heading"
        )
        .slice()
        .sort(
          (a, b) =>
            Number(a.y || 0) -
            Number(b.y || 0)
        )
        .forEach((block) => {
          const key =
            normalizeHeadingMatchKey(
              block.text
            );

          if (!key) return;

          if (
            !headingPageIndex.has(key)
          ) {
            headingPageIndex.set(
              key,
              []
            );
          }

          headingPageIndex
            .get(key)
            .push({
              page: pageNumber,
              blockId:
                block.id || null,
              y:
                Number(block.y) || null,
            });
        });
    });

  return headingPageIndex;
}

function attributeElementPagesFromLayout(
  elements = [],
  layoutBoxes = {}
) {
  const layoutPages =
    Array.isArray(layoutBoxes.pages)
      ? layoutBoxes.pages
      : [];

  const existingPages = new Set(
    elements
      .map((element) =>
        Number(element.page)
      )
      .filter(
        (page) =>
          Number.isFinite(page) &&
          page > 0
      )
  );

  /*
   * Preserve already-correct multi-page
   * extraction. BUG-4 only repairs the
   * collapsed full-text fallback.
   */
  const shouldAttribute =
    layoutPages.length > 1 &&
    existingPages.size <= 1;

  const audit = {
    attempted: shouldAttribute,
    matchedHeadingCount: 0,
    unmatchedHeadingCount: 0,
    attributedElementCount: 0,
  };

  if (!shouldAttribute) {
    return audit;
  }

  const headingPageIndex =
    buildLayoutHeadingPageIndex(
      layoutBoxes
    );

  let activePage = null;

  elements.forEach((element) => {
    if (element.type === "heading") {
      const key =
        normalizeHeadingMatchKey(
          element.text
        );

      const candidates =
        headingPageIndex.get(key) || [];

      const match =
        candidates.shift() || null;

      if (match) {
        activePage = match.page;

        element.page =
          match.page;

        element.pageSource =
          "layout_heading_match";

        element.layoutHeadingBlockId =
          match.blockId;

        audit.matchedHeadingCount += 1;
      } else {
        audit.unmatchedHeadingCount += 1;

        if (activePage) {
          element.page = activePage;
          element.pageSource =
            "previous_layout_heading";
        }
      }

      return;
    }

    if (activePage) {
      element.page = activePage;
      element.pageSource =
        "layout_section_inheritance";

      audit.attributedElementCount += 1;
    }
  });

  return audit;
}

function createUniqueSectionId({
  title,
  fallbackIndex,
  usedSectionIds,
}) {
  const baseId =
    `section_${
      slugify(title) ||
      fallbackIndex
    }`;

  let sectionId = baseId;
  let suffix = 2;

  while (
    usedSectionIds.has(sectionId)
  ) {
    sectionId =
      `${baseId}_${suffix}`;

    suffix += 1;
  }

  usedSectionIds.add(sectionId);

  return sectionId;
}

function getPageTexts(extractedData = {}) {
  if (Array.isArray(extractedData.pages)) {
    return extractedData.pages
      .map((page, index) => ({
        page: Number(page.page || page.pageNumber || index + 1),
        text: normalizeWhitespace(
          page.text ||
            page.content ||
            page.markdown ||
            page.rawText ||
            ""
        ),
      }))
      .filter((item) => item.text);
  }

  if (Array.isArray(extractedData.pageTexts)) {
    return extractedData.pageTexts
      .map((page, index) => {
        if (typeof page === "string") {
          return {
            page: index + 1,
            text: normalizeWhitespace(page),
          };
        }

        return {
          page: Number(page.page || page.pageNumber || index + 1),
          text: normalizeWhitespace(
            page.text ||
              page.content ||
              page.markdown ||
              ""
          ),
        };
      })
      .filter((item) => item.text);
  }

  const fullText = normalizeWhitespace(
    extractedData.text ||
      extractedData.fullText ||
      extractedData.content ||
      extractedData.markdown ||
      ""
  );

  if (!fullText) return [];

  return [
    {
      page: 1,
      text: fullText,
    },
  ];
}

function looksLikeCommand(line) {
  const text = safeString(line);

  if (!text) return false;

  return Boolean(
    /^[$>#]\s+/.test(text) ||
      /^(kubectl|minikube|docker|git|npm|yarn|pnpm|terraform|helm|aws|gcloud|az|curl|ssh|scp|systemctl|journalctl)\b/i.test(
        text
      ) ||
      /^[a-z0-9._/-]+\s+(get|describe|apply|delete|create|start|stop|restart|logs|exec|build|run|test|deploy)\b/i.test(
        text
      )
  );
}

function looksLikeTableLine(line) {
  const text = safeString(line);

  if (!text) return false;

  return (
    text.includes("|") ||
    (/\s{2,}/.test(text) &&
      text.split(/\s{2,}/).length >= 3)
  );
}

function looksLikeListItem(line) {
  return /^(\s*[-*•]\s+|\s*\d+[.)]\s+)/.test(
    String(line || "")
  );
}

function looksLikeMarkdownHeading(line) {
  return /^#{1,6}\s+\S/.test(String(line || ""));
}

function looksLikeShortHeading(line) {
  const text = safeString(line);

  if (!text) return false;

  // ---------------------------------------------------
  // Hard blockers
  // ---------------------------------------------------

  if (text.length > 90) return false;

  // Numbered operational commands should NEVER become headings.
  // Example:
  // 1 kubectl get pods — List pods
  if (
    /^\d+\s+(kubectl|minikube|docker|helm|terraform|aws|gcloud|az)\b/i.test(
      text
    )
  ) {
    return false;
  }

  // Generic command-like rows should not become headings.
  if (looksLikeCommand(text)) return false;

  if (looksLikeListItem(text)) return false;

  if (looksLikeTableLine(text)) return false;

  const lower = text.toLowerCase();

  if (
    lower.endsWith(".") ||
    lower.endsWith(",") ||
    lower.includes("://")
  ) {
    return false;
  }

  // Reject incomplete extracted sentence fragments.
  // Examples:
  // - Shared reverse proxy and
  // - Shared configuration and
  if (
    /\b(and|or|with|for|to|from|via|through|of|in|on|by)\s*$/i.test(
      text
    )
  ) {
    return false;
  }

  // ---------------------------------------------------
  // Heading heuristics
  // ---------------------------------------------------

  const words = text
    .split(/\s+/)
    .filter(Boolean);

  if (words.length > 8) return false;

  const semanticHeadingHints = [
    "overview",
    "architecture",
    "workflow",
    "troubleshooting",
    "rollback",
    "verification",
    "warning",
    "notes",
    "services",
    "networking",
    "cluster",
    "context",
    "storage",
    "security",
    "deployment",
    "monitoring",
  ];

  if (
    semanticHeadingHints.some(
      (hint) =>
        lower === hint ||
        lower === `${hint}s`
    )
  ) {
    return true;
  }

  const startsTitleCase =
    /^[A-Z][A-Za-z0-9&/_ -]+$/.test(text);

  const mostlyTitleCase =
    words.length <= 5 &&
    words.filter((word) =>
      /^[A-Z0-9]/.test(word)
    ).length >= Math.ceil(words.length / 2);

  const commandDensity =
    words.filter((word) =>
      /^(kubectl|minikube|docker|helm|terraform|aws|gcloud|az)$/i.test(
        word
      )
    ).length / Math.max(1, words.length);

  if (commandDensity > 0.4) {
    return false;
  }

  return startsTitleCase || mostlyTitleCase;
}

function classifyLine(line) {
  const text = safeString(line);

  if (!text) return "blank";
  if (looksLikeMarkdownHeading(text)) return "heading";
  if (looksLikeShortHeading(text)) return "heading";
  if (looksLikeCommand(text)) return "code_or_command";
  if (looksLikeTableLine(text)) return "table_row";
  if (looksLikeListItem(text)) return "list_item";

  return "narrative_text";
}

function semanticRoleFromText({
  title = "",
  text = "",
  elementTypes = [],
} = {}) {
  const combined = safeLower(
    [title, text].join(" ")
  );

  if (elementTypes.includes("code_or_command")) {
    if (
      /(start|setup|install|init|env|config|context|namespace)/.test(
        combined
      )
    ) {
      return "setup_reference";
    }

    if (
      /(get|describe|inspect|logs|top|watch|status)/.test(
        combined
      )
    ) {
      return "inspection";
    }

    if (
      /(apply|create|delete|rollout|restart|deploy)/.test(
        combined
      )
    ) {
      return "change_execution";
    }

    if (
      /(debug|troubleshoot|error|fail|recover|rollback)/.test(
        combined
      )
    ) {
      return "debugging";
    }

    return "reference";
  }

  if (
    /(warning|caution|risk|danger|red flag|contraindication)/.test(
      combined
    )
  ) {
    return "warning";
  }

  if (
    /(step|procedure|runbook|workflow|process)/.test(
      combined
    )
  ) {
    return "workflow_step";
  }

  if (
    /(verify|validation|check|confirm|test)/.test(
      combined
    )
  ) {
    return "verification";
  }

  if (
    /(architecture|diagram|component|flow|system|service)/.test(
      combined
    )
  ) {
    return "architecture_explanation";
  }

  if (
    /(decision|tradeoff|alternative|proposal|rfc)/.test(
      combined
    )
  ) {
    return "decision";
  }

  if (
    /(summary|recap|takeaway|remember)/.test(
      combined
    )
  ) {
    return "recap";
  }

  if (
    /(overview|introduction|purpose|background)/.test(
      combined
    )
  ) {
    return "overview";
  }

  return "reference";
}

function buildElementsFromPage({ page, text }) {
  const lines = normalizeWhitespace(text)
    .split("\n")
    .map((line) => line.trimEnd());

  const elements = [];
  let paragraphBuffer = [];

  function flushParagraph() {
    const paragraph = normalizeWhitespace(
      paragraphBuffer.join(" ")
    );

    if (!paragraph) {
      paragraphBuffer = [];
      return;
    }

    const structuralMetadata =
      buildElementEligibility({
        type: "narrative_text",
        architectureContainer: false,
      });

    elements.push({
      type: "narrative_text",
      text: paragraph,
      page,

      structuralRole:
        structuralMetadata.structuralRole,

      eligibility:
        structuralMetadata.eligibility,
    });

    paragraphBuffer = [];
  }

  for (const rawLine of lines) {
    const line = safeString(rawLine);
    const type = classifyLine(line);

    if (type === "blank") {
      flushParagraph();
      continue;
    }

    if (type === "narrative_text") {
      paragraphBuffer.push(line);
      continue;
    }

    flushParagraph();

    const normalizedElementText =
      type === "heading"
        ? normalizeHeadingText(line)
        : line
            .replace(/^[$>#]\s+/, "")
            .trim();

    const headingKind =
      type === "heading"
        ? classifyHeadingKind(normalizedElementText)
        : null;

    const architectureContainer =
      type === "heading" &&
      isArchitectureContainerHeadingKind(headingKind);

    const structuralMetadata =
      buildElementEligibility({
        type,
        headingKind,
        architectureContainer,
      });

    elements.push({
      type,
      text: normalizedElementText,
      rawText: line,
      page,
      headingKind,
      architectureContainer,

      structuralRole:
        structuralMetadata.structuralRole,

      eligibility:
        structuralMetadata.eligibility,
    });
  }

  flushParagraph();

  return elements;
}

function buildFlatElements(extractedData = {}) {
  const pageTexts = getPageTexts(extractedData);

  return pageTexts.flatMap((pageItem) =>
    buildElementsFromPage({
      page: pageItem.page,
      text: pageItem.text,
    })
  );
}

function shouldStartNewSection(element) {
  return element?.type === "heading";
}

/*
 * BUG-5 — Section Identity and Parentage
 *
 * Only broad structural headings establish parent scope.
 * Specific headings such as "Journey 1", "Atlas Validation",
 * or "Availability Zone 1" remain child sections.
 *
 * This deliberately avoids guessing hierarchy from page position
 * or typography alone.
 */
function isBroadContainerHeading({
  title = "",
  headingKind = HEADING_KINDS.GENERIC,
} = {}) {
  const text = normalizeHeadingText(title);

  if (!text) {
    return false;
  }

  if (
    /^(component|service|system)\s+definitions?$/i.test(text)
  ) {
    return true;
  }

  if (
    /^(numbered\s+)?system journeys?$/i.test(text) ||
    /^documented journeys?$/i.test(text)
  ) {
    return true;
  }

  if (
    /^(deployment topology|deployment model|deployment architecture)(?:\s*[-–—:]\s*.+)?$/i.test(
      text
    )
  ) {
    return true;
  }

  if (
    /^(shared platform services?|shared infrastructure|shared services?)$/i.test(
      text
    )
  ) {
    return true;
  }

  if (
    /^(architecture reference|architecture overview|system architecture|system topology)$/i.test(
      text
    )
  ) {
    return true;
  }

  if (
    /^(glossary|terminology|acronyms?|legend|diagram key|visual key)$/i.test(
      text
    )
  ) {
    return true;
  }

  return false;
}

function clearsParentSectionScope({
  title = "",
  headingKind = HEADING_KINDS.GENERIC,
  architectureContainer = false,
} = {}) {
  const text =
    normalizeHeadingText(title);

  const explicitDocumentationHeading =
    /\b(notes?|appendix|summary|recap|recommendations?|evidence notes?)\b/i.test(
      text
    );

  if (explicitDocumentationHeading) {
    return true;
  }

  return (
    architectureContainer !== true &&
    (
      headingKind === HEADING_KINDS.DOCUMENTATION ||
      headingKind === HEADING_KINDS.VALIDATION
    )
  );
}

function createUntitledSection(page = 1) {
  return {
    id: "section_document_overview",
    parentSectionId: null,
    sectionOrder: 1,
    sectionDepth: 0,
    title: "Document overview",
    sourceTitle: "Document overview",
    page,
    sourcePages: [page].filter(Boolean),
    headingKind: HEADING_KINDS.DOCUMENTATION,
    architectureContainer: false,

    structuralRole:
      STRUCTURAL_ROLES.DOCUMENT_CONTAINER,

    eligibility: {
      ...STRUCTURAL_CONTAINER_ELIGIBILITY,
    },

    role: "overview",
    confidence: "low",
    elements: [],
    childCount: 0,
    textPreview: "",
  };
}

function finalizeSection(section) {
  const elements = Array.isArray(section.elements)
    ? section.elements
    : [];

  const elementTypes = uniq(
    elements.map((item) => item.type)
  );

  const text = elements
    .map((item) => item.text)
    .join("\n");

  const role = semanticRoleFromText({
    title: section.title,
    text,
    elementTypes,
  });

  const sourcePages = uniq([
    ...(section.sourcePages || []),
    ...elements.map((item) => item.page),
  ])
    .map(Number)
    .filter(Boolean);

  return {
    ...section,
    sourcePages,
    role,
    elementTypes,
    childCount: elements.length,
    commandCount: elements.filter(
      (item) =>
        item.type === "code_or_command"
    ).length,
    tableRowCount: elements.filter(
      (item) =>
        item.type === "table_row"
    ).length,
    listItemCount: elements.filter(
      (item) =>
        item.type === "list_item"
    ).length,
    textPreview: normalizeWhitespace(text).slice(
      0,
      700
    ),
  };
}

function buildSections(elements = []) {
  const sections = [];
  const usedSectionIds = new Set();

  let current = null;
  let activeParentSectionId = null;

  function pushCurrent() {
    if (!current) {
      return;
    }

    sections.push(
      finalizeSection(current)
    );

    current = null;
  }

  for (const element of elements) {
    if (shouldStartNewSection(element)) {
      pushCurrent();

      const title =
        normalizeHeadingText(
          element.text
        );

      const headingKind =
        element.headingKind ||
        classifyHeadingKind(title);

      const sectionOrder =
        sections.length + 1;

      const sectionId =
        createUniqueSectionId({
          title,
          fallbackIndex: sectionOrder,
          usedSectionIds,
        });

      const startsParentScope =
        isBroadContainerHeading({
          title,
          headingKind,
        });

      const clearsParentScope =
        clearsParentSectionScope({
          title,
          headingKind,
          architectureContainer:
            element.architectureContainer === true,
        });

      const parentSectionId =
      startsParentScope ||
      clearsParentScope
        ? null
        : activeParentSectionId;

    const sectionDepth =
      parentSectionId
        ? 1
        : 0;

      element.sectionId =
        sectionId;

      element.parentSectionId =
        parentSectionId;

      element.sectionOrder =
        sectionOrder;

      element.orderWithinSection =
        0;

      element.sectionDepth =
        sectionDepth;

      current = {
        id: sectionId,

        parentSectionId,

        sectionOrder,

        sectionDepth,

        title:
          title ||
          `Section ${sectionOrder}`,

        sourceTitle:
          title || "",

        page:
          element.page,

        sourcePages:
          [element.page].filter(Boolean),

        headingKind,

        architectureContainer:
          element.architectureContainer === true,

        structuralRole:
          element.structuralRole ||
          (
            element.architectureContainer === true
              ? STRUCTURAL_ROLES.ARCHITECTURE_CONTAINER
              : STRUCTURAL_ROLES.DOCUMENT_CONTAINER
          ),

        eligibility: {
          ...(element.eligibility ||
            STRUCTURAL_CONTAINER_ELIGIBILITY),
        },

        role:
          semanticRoleFromText({
            title,
          }),

        confidence:
          "medium",

        headingElement:
          element,

        elements:
          [],
      };

      if (startsParentScope) {
        activeParentSectionId =
          sectionId;
      } else if (clearsParentScope) {
        activeParentSectionId =
          null;
      }

      continue;
    }

    if (!current) {
    current =
      createUntitledSection(
        element.page
      );

    usedSectionIds.add(
      current.id
    );

    activeParentSectionId =
      null;
  }

    element.sectionId =
      current.id;

    element.parentSectionId =
      current.parentSectionId ||
      null;

    element.sectionOrder =
      current.sectionOrder ||
      sections.length + 1;

    element.orderWithinSection =
      current.elements.length + 1;

    element.sectionDepth =
      current.sectionDepth || 0;

    current.elements.push(
      element
    );
  }

  pushCurrent();

  return sections.filter(
    (section) =>
      section.title ||
      section.childCount > 0 ||
      section.textPreview
  );
}

function buildHierarchy(sections = []) {
  const sectionNodes = new Map();

  function buildElementNode({
    section,
    element,
    index,
  }) {
    return {
      id:
        `${section.id}_element_${index + 1}`,

      type:
        element.type,

      text:
        element.text,

      page:
        element.page,

      sectionId:
        element.sectionId ||
        section.id,

      parentSectionId:
        element.parentSectionId ||
        null,

      sectionOrder:
        element.sectionOrder ||
        section.sectionOrder ||
        null,

      orderWithinSection:
        element.orderWithinSection ??
        index + 1,

      sectionDepth:
        element.sectionDepth ??
        section.sectionDepth ??
        0,

      headingKind:
        element.headingKind ||
        null,

      architectureContainer:
        element.architectureContainer ===
        true,

      structuralRole:
        element.structuralRole ||
        STRUCTURAL_ROLES.CONTENT,

      eligibility: {
        ...(element.eligibility ||
          buildElementEligibility({
            type:
              element.type,

            architectureContainer:
              element.architectureContainer ===
              true,
          }).eligibility),
      },
    };
  }

  for (const section of sections) {
    sectionNodes.set(
      section.id,
      {
        id:
          section.id,

        type:
          "section",

        title:
          section.title,

        role:
          section.role,

        parentSectionId:
          section.parentSectionId ||
          null,

        sectionOrder:
          section.sectionOrder ||
          null,

        sectionDepth:
          section.sectionDepth ||
          0,

        headingKind:
          section.headingKind ||
          HEADING_KINDS.GENERIC,

        architectureContainer:
          section.architectureContainer ===
          true,

        structuralRole:
          section.structuralRole ||
          STRUCTURAL_ROLES.DOCUMENT_CONTAINER,

        eligibility: {
          ...(section.eligibility ||
            STRUCTURAL_CONTAINER_ELIGIBILITY),
        },

        page:
          section.page,

        sourcePages:
          section.sourcePages,

        childCount:
          section.childCount,

        sectionChildren:
          [],

        children:
          section.elements.map(
            (element, index) =>
              buildElementNode({
                section,
                element,
                index,
              })
          ),
      }
    );
  }

  const rootSections = [];

  for (const section of sections) {
    const node =
      sectionNodes.get(
        section.id
      );

    const parentNode =
      section.parentSectionId
        ? sectionNodes.get(
            section.parentSectionId
          )
        : null;

    if (
      parentNode &&
      parentNode.id !== node.id
    ) {
      parentNode.sectionChildren.push(
        node
      );
    } else {
      rootSections.push(
        node
      );
    }
  }

  return {
    type:
      "document",

    title:
      "Document",

    children:
      rootSections,
  };
}

function buildDocumentStructure({
  extractedData = {},
  documentIntelligence = {},
  layoutBoxes = {},
} = {}) {
  const elements =
    buildFlatElements(extractedData);

  const pageAttribution =
    attributeElementPagesFromLayout(
      elements,
      layoutBoxes
    );

  const sections =
    buildSections(elements);

  const hierarchy =
    buildHierarchy(sections);

  /*
   * BUG-5 — Section identity and parentage health.
   *
   * Validate that:
   * - every parent section exists
   * - no section points to itself
   * - element parentage matches its owning section
   */
  const sectionIds =
    new Set(
      sections
        .map((section) => section.id)
        .filter(Boolean)
    );

  const invalidParentSectionReferenceCount =
    sections.filter(
      (section) =>
        section.parentSectionId &&
        !sectionIds.has(
          section.parentSectionId
        )
    ).length;

  const selfParentSectionCount =
    sections.filter(
      (section) =>
        section.parentSectionId &&
        section.parentSectionId ===
          section.id
    ).length;

  const childSectionCount =
    sections.filter(
      (section) =>
        Boolean(
          section.parentSectionId
        )
    ).length;

  const rootSectionCount =
    sections.length -
    childSectionCount;

  const sectionById =
    new Map(
      sections.map((section) => [
        section.id,
        section,
      ])
    );

  const elementWithoutSectionIdCount =
    elements.filter(
      (element) =>
        !element.sectionId
    ).length;

  const invalidElementSectionReferenceCount =
    elements.filter(
      (element) =>
        element.sectionId &&
        !sectionById.has(
          element.sectionId
        )
    ).length;

  const elementSectionParentMismatchCount =
    elements.filter((element) => {
      if (!element.sectionId) {
        return true;
      }

      const owningSection =
        sectionById.get(
          element.sectionId
        );

      if (!owningSection) {
        return true;
      }

      return (
        (
          element.parentSectionId ||
          null
        ) !==
        (
          owningSection.parentSectionId ||
          null
        )
      );
    }).length;

  const duplicateSectionIdCount =
    sections.length -
    sectionIds.size;

  const sectionIdentityHealth = {
    version:
      "section-identity-health-v1",

    valid:
      invalidParentSectionReferenceCount === 0 &&
      selfParentSectionCount === 0 &&
      duplicateSectionIdCount === 0 &&
      elementWithoutSectionIdCount === 0 &&
      invalidElementSectionReferenceCount === 0 &&
      elementSectionParentMismatchCount === 0,

    rootSectionCount,
    childSectionCount,

    duplicateSectionIdCount,

    invalidParentSectionReferenceCount,
    selfParentSectionCount,

    elementWithoutSectionIdCount,
    invalidElementSectionReferenceCount,
    elementSectionParentMismatchCount,
  };

  const headingKindBreakdown =
    elements
      .filter(
        (item) =>
          item.type === "heading"
      )
      .reduce((acc, item) => {
        const headingKind =
          item.headingKind ||
          HEADING_KINDS.GENERIC;

        acc[headingKind] =
          (acc[headingKind] || 0) + 1;

        return acc;
      }, {});

  const architectureContainerHeadingCount =
    elements.filter(
      (item) =>
        item.type === "heading" &&
        item.architectureContainer === true
    ).length;

  return {
    version:
      "document-structure-v5-section-parentage",

    source:
      "documentStructureBuilder",

    borrowedIdeas: [
      "marker_structured_markdown",
      "unstructured_document_elements",
      "llamaindex_hierarchical_nodes",
      "compiler_ast_parent_child_scope",
      "html_document_outline_active_parent",
    ],

    documentType:
      documentIntelligence?.primaryType ||
      "unknown",

    elementCount:
      elements.length,

    sectionCount:
      sections.length,

    elements,
    sections,
    hierarchy,

    health: {
      sectionIdentity:
        sectionIdentityHealth,
    },

    stats: {
      headingCount:
        elements.filter(
          (item) =>
            item.type === "heading"
        ).length,

      headingKindBreakdown,

      pageAttribution,

      rootSectionCount,
      childSectionCount,

      duplicateSectionIdCount,

      invalidParentSectionReferenceCount,
      selfParentSectionCount,

      elementWithoutSectionIdCount,
      invalidElementSectionReferenceCount,
      elementSectionParentMismatchCount,

      architectureContainerHeadingCount,

      structuralContainerCount:
        elements.filter(
          (item) =>
            item.structuralRole ===
              STRUCTURAL_ROLES.ARCHITECTURE_CONTAINER ||
            item.structuralRole ===
              STRUCTURAL_ROLES.DOCUMENT_CONTAINER
        ).length,

      entityIneligibleHeadingCount:
        elements.filter(
          (item) =>
            item.type === "heading" &&
            item.eligibility?.entity === false
        ).length,

      componentIneligibleHeadingCount:
        elements.filter(
          (item) =>
            item.type === "heading" &&
            item.eligibility?.component === false
        ).length,

      sequenceIneligibleHeadingCount:
        elements.filter(
          (item) =>
            item.type === "heading" &&
            item.eligibility?.sequence === false
        ).length,

      commandCount:
        elements.filter(
          (item) =>
            item.type ===
            "code_or_command"
        ).length,

      tableRowCount:
        elements.filter(
          (item) =>
            item.type ===
            "table_row"
        ).length,

      listItemCount:
        elements.filter(
          (item) =>
            item.type ===
            "list_item"
        ).length,

      narrativeTextCount:
        elements.filter(
          (item) =>
            item.type ===
            "narrative_text"
        ).length,
    },
  };
}

module.exports = {
  HEADING_KINDS,
  STRUCTURAL_ROLES,
  STRUCTURAL_CONTAINER_ELIGIBILITY,
  buildDocumentStructure,
  buildElementEligibility,
  classifyHeadingKind,
  isArchitectureContainerHeadingKind,
};
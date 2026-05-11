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

function slugify(value) {
  return safeLower(value)
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
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
          text: normalizeWhitespace(page.text || page.content || page.markdown || ""),
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
      /^(kubectl|minikube|docker|git|npm|yarn|pnpm|terraform|helm|aws|gcloud|az|curl|ssh|scp|systemctl|journalctl)\b/i.test(text) ||
      /^[a-z0-9._/-]+\s+(get|describe|apply|delete|create|start|stop|restart|logs|exec|build|run|test|deploy)\b/i.test(text)
  );
}

function looksLikeTableLine(line) {
  const text = safeString(line);
  if (!text) return false;

  return (
    text.includes("|") ||
    /\s{2,}/.test(text) && text.split(/\s{2,}/).length >= 3
  );
}

function looksLikeListItem(line) {
  return /^(\s*[-*•]\s+|\s*\d+[.)]\s+)/.test(String(line || ""));
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

  // Numbered operational commands should NEVER become headings
  // Example:
  // 1 kubectl get pods — List pods
  if (
    /^\d+\s+(kubectl|minikube|docker|helm|terraform|aws|gcloud|az)\b/i.test(text)
  ) {
    return false;
  }

  // Generic command-like rows should not become headings
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

  // ---------------------------------------------------
  // Heading heuristics
  // ---------------------------------------------------

  const words = text.split(/\s+/).filter(Boolean);

  if (words.length > 8) return false;

  // Strong semantic section titles
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

  // Exact semantic headings
  if (
    semanticHeadingHints.some(
      (hint) => lower === hint || lower === `${hint}s`
    )
  ) {
    return true;
  }

  // Title-case semantic section
  const startsTitleCase =
    /^[A-Z][A-Za-z0-9&/_ -]+$/.test(text);

  const mostlyTitleCase =
    words.length <= 5 &&
    words.filter((word) => /^[A-Z0-9]/.test(word)).length >=
      Math.ceil(words.length / 2);

  // Avoid command-heavy headings
  const commandDensity =
    words.filter((word) =>
      /^(kubectl|minikube|docker|helm|terraform|aws|gcloud|az)$/i.test(word)
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

function semanticRoleFromText({ title = "", text = "", elementTypes = [] } = {}) {
  const combined = safeLower([title, text].join(" "));

  if (elementTypes.includes("code_or_command")) {
    if (/(start|setup|install|init|env|config|context|namespace)/.test(combined)) {
      return "setup_reference";
    }

    if (/(get|describe|inspect|logs|top|watch|status)/.test(combined)) {
      return "inspection";
    }

    if (/(apply|create|delete|rollout|restart|deploy)/.test(combined)) {
      return "change_execution";
    }

    if (/(debug|troubleshoot|error|fail|recover|rollback)/.test(combined)) {
      return "debugging";
    }

    return "reference";
  }

  if (/(warning|caution|risk|danger|red flag|contraindication)/.test(combined)) {
    return "warning";
  }

  if (/(step|procedure|runbook|workflow|process)/.test(combined)) {
    return "workflow_step";
  }

  if (/(verify|validation|check|confirm|test)/.test(combined)) {
    return "verification";
  }

  if (/(architecture|diagram|component|flow|system|service)/.test(combined)) {
    return "architecture_explanation";
  }

  if (/(decision|tradeoff|alternative|proposal|rfc)/.test(combined)) {
    return "decision";
  }

  if (/(summary|recap|takeaway|remember)/.test(combined)) {
    return "recap";
  }

  if (/(overview|introduction|purpose|background)/.test(combined)) {
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
    const paragraph = normalizeWhitespace(paragraphBuffer.join(" "));
    if (!paragraph) {
      paragraphBuffer = [];
      return;
    }

    elements.push({
      type: "narrative_text",
      text: paragraph,
      page,
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

    elements.push({
      type,
      text:
        type === "heading"
          ? normalizeHeadingText(line)
          : line.replace(/^[$>#]\s+/, "").trim(),
      rawText: line,
      page,
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

function createUntitledSection(page = 1) {
  return {
    id: "section_document_overview",
    title: "Document overview",
    sourceTitle: "Document overview",
    page,
    sourcePages: [page].filter(Boolean),
    role: "overview",
    confidence: "low",
    elements: [],
    childCount: 0,
    textPreview: "",
  };
}

function finalizeSection(section) {
  const elements = Array.isArray(section.elements) ? section.elements : [];
  const elementTypes = uniq(elements.map((item) => item.type));
  const text = elements.map((item) => item.text).join("\n");

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
    commandCount: elements.filter((item) => item.type === "code_or_command").length,
    tableRowCount: elements.filter((item) => item.type === "table_row").length,
    listItemCount: elements.filter((item) => item.type === "list_item").length,
    textPreview: normalizeWhitespace(text).slice(0, 700),
  };
}

function buildSections(elements = []) {
  const sections = [];
  let current = null;

  for (const element of elements) {
    if (shouldStartNewSection(element)) {
      if (current) sections.push(finalizeSection(current));

      const title = normalizeHeadingText(element.text);

      current = {
        id: `section_${slugify(title) || sections.length + 1}`,
        title: title || `Section ${sections.length + 1}`,
        sourceTitle: title || "",
        page: element.page,
        sourcePages: [element.page].filter(Boolean),
        role: semanticRoleFromText({ title }),
        confidence: "medium",
        headingElement: element,
        elements: [],
      };

      continue;
    }

    if (!current) {
      current = createUntitledSection(element.page);
    }

    current.elements.push(element);
  }

  if (current) sections.push(finalizeSection(current));

  return sections.filter((section) => {
    return section.title || section.childCount > 0 || section.textPreview;
  });
}

function buildHierarchy(sections = []) {
  return {
    type: "document",
    title: "Document",
    children: sections.map((section) => ({
      id: section.id,
      type: "section",
      title: section.title,
      role: section.role,
      page: section.page,
      sourcePages: section.sourcePages,
      childCount: section.childCount,
      children: section.elements.map((element, index) => ({
        id: `${section.id}_element_${index + 1}`,
        type: element.type,
        text: element.text,
        page: element.page,
      })),
    })),
  };
}

function buildDocumentStructure({ extractedData = {}, documentIntelligence = {} } = {}) {
  const elements = buildFlatElements(extractedData);
  const sections = buildSections(elements);
  const hierarchy = buildHierarchy(sections);

  return {
    version: "document-structure-v1",
    source: "documentStructureBuilder",
    borrowedIdeas: [
      "marker_structured_markdown",
      "unstructured_document_elements",
      "llamaindex_hierarchical_nodes",
    ],
    documentType: documentIntelligence?.primaryType || "unknown",
    elementCount: elements.length,
    sectionCount: sections.length,
    elements,
    sections,
    hierarchy,
    stats: {
      headingCount: elements.filter((item) => item.type === "heading").length,
      commandCount: elements.filter((item) => item.type === "code_or_command").length,
      tableRowCount: elements.filter((item) => item.type === "table_row").length,
      listItemCount: elements.filter((item) => item.type === "list_item").length,
      narrativeTextCount: elements.filter((item) => item.type === "narrative_text").length,
    },
  };
}

module.exports = {
  buildDocumentStructure,
};
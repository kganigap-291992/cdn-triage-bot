// notebook/worker/services/conceptExtractor.js

const fs = require("fs");
const path = require("path");
const OpenAI = require("openai");

const CONCEPT_MODEL = process.env.NOTEBOOK_CONCEPT_MODEL || "gpt-4.1-mini";
const MAX_TEXT_CHARS = Number(process.env.NOTEBOOK_CONCEPT_MAX_TEXT_CHARS || 45000);
const CHUNK_SIZE = Number(process.env.NOTEBOOK_CONCEPT_CHUNK_SIZE || 12000);
const CHUNK_OVERLAP = Number(process.env.NOTEBOOK_CONCEPT_CHUNK_OVERLAP || 1200);

function getConceptsPath(jobDir) {
  return path.join(jobDir, "concepts.json");
}

function cleanText(value, maxLength = 1200) {
  if (!value) return "";

  return String(value)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function safeJsonParse(value) {
  if (!value) return null;

  const text = String(value).trim();

  try {
    return JSON.parse(text);
  } catch {
    const fencedMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);

    if (fencedMatch?.[1]) {
      try {
        return JSON.parse(fencedMatch[1].trim());
      } catch {
        return null;
      }
    }

    return null;
  }
}

function readJsonIfExists(filePath, fallback = {}) {
  if (!fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function compactDiagramAnalysis(diagramAnalysis) {
  const pages = Array.isArray(diagramAnalysis.pages)
    ? diagramAnalysis.pages
    : [];

  return pages.slice(0, 20).map((page) => ({
    page: page.page ?? null,
    summary: cleanText(page.summary, 1000),
    visualType: page.visualType || page.type || null,
    importantText: cleanText(
      Array.isArray(page.importantText)
        ? page.importantText.join(" ")
        : page.importantText,
      1000
    ),
  }));
}

function chunkText(extractedText) {
  const cleaned = cleanText(extractedText, MAX_TEXT_CHARS);

  if (!cleaned) return [];

  if (cleaned.length <= CHUNK_SIZE) {
    return [cleaned];
  }

  const chunks = [];
  let start = 0;

  while (start < cleaned.length) {
    const end = Math.min(start + CHUNK_SIZE, cleaned.length);
    const chunk = cleaned.slice(start, end).trim();

    if (chunk) {
      chunks.push(chunk);
    }

    if (end >= cleaned.length) break;

    start = Math.max(0, end - CHUNK_OVERLAP);
  }

  return chunks;
}

function buildChunkPrompt({
  chunk,
  chunkIndex,
  chunkCount,
  diagramAnalysis,
}) {
  const diagrams = compactDiagramAnalysis(diagramAnalysis);

  return `
You are analyzing one chunk of an internal training document.

This is chunk ${chunkIndex + 1} of ${chunkCount}.

Your job:
Extract LOCAL semantic teaching material from this chunk only.

Important:
- Do not build the final document hierarchy yet.
- Do not summarize the whole document unless the chunk clearly contains that summary.
- Extract concrete concepts, commands, procedures, workflows, evidence, mistakes, and debugging clues found in this chunk.
- Infer the domain from evidence, but mark it as a hint, not final truth.
- Be domain-agnostic. The document may be technical, operational, business-process oriented, support-oriented, architecture-oriented, or something else.
- If commands appear, explain what they help someone inspect, configure, verify, operate, or debug.
- If procedures appear, explain the workflow and why the order matters.
- If diagrams are relevant, preserve full diagram meaning. Do not suggest cropping architecture diagrams into tiny pieces.
- Avoid vague concepts like "system map", "architecture flow", "source material", "mental model", or "technical concept".

Return STRICT JSON only.
No markdown.
No commentary outside JSON.

JSON shape:
{
  "chunkIndex": number,
  "chunkSummary": string,
  "domainHints": string[],
  "localTopics": [
    {
      "name": string,
      "plainEnglish": string,
      "whyItMatters": string,
      "workflow": string[],
      "commonMistakes": string[],
      "debuggingClues": string[],
      "commands": [
        {
          "command": string,
          "meaning": string,
          "whenToUse": string,
          "debuggingSignal": string
        }
      ],
      "evidence": [
        {
          "page": number | null,
          "quote": string,
          "whyRelevant": string
        }
      ]
    }
  ],
  "procedures": [
    {
      "name": string,
      "steps": string[],
      "whyOrderMatters": string,
      "beginnerPitfalls": string[]
    }
  ],
  "diagramNotes": [
    {
      "page": number | null,
      "howToExplain": string,
      "whatToPreserve": string
    }
  ]
}

Chunk text:
${chunk}

Diagram/page analysis:
${JSON.stringify(diagrams, null, 2)}
`.trim();
}

function buildMergePrompt({
  localExtractions,
  diagramAnalysis,
}) {
  const diagrams = compactDiagramAnalysis(diagramAnalysis);

  return `
You are synthesizing local concept extractions into a final onboarding concept hierarchy.

Your job:
Merge local chunk extractions into a clean global teaching structure.

Core rules:
- First infer the final detected domain from all evidence.
- Be domain-agnostic. Do not force Kubernetes, CDN, networking, databases, APIs, observability, security, video delivery, or any fixed domain.
- Merge duplicate local concepts.
- Prefer 1 to 5 strong parent topics instead of many flat buckets.
- Put detailed concepts under subConcepts.
- Preserve command meanings under the most relevant subConcept.
- Preserve page-local evidence where useful.
- Build a beginner-friendly teaching progression.
- Preserve full diagrams conceptually. Do not recommend cropping architecture diagrams into tiny pieces.
- Do not hallucinate commands, tools, systems, or procedures not supported by the local extractions.
- Avoid vague concepts like "system map", "architecture flow", "source material", "mental model", or "technical concept".

Make the output suitable for:
- onboarding
- training
- two-person narrated walkthroughs
- operational understanding
- beginner explanation

Return STRICT JSON only.
No markdown.
No commentary outside JSON.

JSON shape:
{
  "documentTitle": string | null,
  "detectedDomain": string,
  "summary": string,
  "audienceLevel": "beginner" | "intermediate" | "advanced",
  "primaryTopics": [
    {
      "id": "topic-001",
      "name": string,
      "plainEnglish": string,
      "whyItMatters": string,
      "analogy": string,
      "operationalWorkflow": string[],
      "commonMistakes": string[],
      "debuggingClues": string[],
      "evidence": [
        {
          "page": number | null,
          "quote": string,
          "whyRelevant": string
        }
      ],
      "subConcepts": [
        {
          "id": "topic-001-sub-001",
          "name": string,
          "plainEnglish": string,
          "whyItMatters": string,
          "commands": [
            {
              "command": string,
              "meaning": string,
              "whenToUse": string,
              "debuggingSignal": string
            }
          ],
          "evidence": [
            {
              "page": number | null,
              "quote": string,
              "whyRelevant": string
            }
          ]
        }
      ]
    }
  ],
  "recommendedTeachingOrder": string[],
  "diagramGuidance": [
    {
      "page": number | null,
      "howToExplain": string,
      "whatToPreserve": string
    }
  ]
}

Local chunk extractions:
${JSON.stringify(localExtractions, null, 2)}

Diagram/page analysis:
${JSON.stringify(diagrams, null, 2)}
`.trim();
}

function normalizeLocalExtraction(raw, chunkIndex) {
  return {
    chunkIndex,
    chunkSummary: raw.chunkSummary || "",
    domainHints: Array.isArray(raw.domainHints) ? raw.domainHints : [],
    localTopics: Array.isArray(raw.localTopics) ? raw.localTopics : [],
    procedures: Array.isArray(raw.procedures) ? raw.procedures : [],
    diagramNotes: Array.isArray(raw.diagramNotes) ? raw.diagramNotes : [],
  };
}

function normalizeSemanticConcepts(raw, metadata = {}) {
  const primaryTopics = Array.isArray(raw.primaryTopics)
    ? raw.primaryTopics
    : [];

  if (!primaryTopics.length) {
    throw new Error("OpenAI returned no primaryTopics");
  }

  return {
    generatedAt: new Date().toISOString(),
    version: "concepts-v3-semantic-chunked",
    source: "openai-semantic-chunked-extraction",
    model: CONCEPT_MODEL,
    extractionStrategy: "chunk-then-merge",
    chunkCount: metadata.chunkCount || 0,
    documentTitle: raw.documentTitle || null,
    detectedDomain: raw.detectedDomain || "unknown",
    summary: raw.summary || "Semantic concept extraction completed.",
    audienceLevel: raw.audienceLevel || "beginner",
    conceptCount: primaryTopics.length,
    primaryTopics,
    recommendedTeachingOrder: Array.isArray(raw.recommendedTeachingOrder)
      ? raw.recommendedTeachingOrder
      : primaryTopics.map((topic) => topic.name).filter(Boolean),
    diagramGuidance: Array.isArray(raw.diagramGuidance)
      ? raw.diagramGuidance
      : [],
    localExtractionSummaries: Array.isArray(metadata.localExtractions)
      ? metadata.localExtractions.map((item) => ({
          chunkIndex: item.chunkIndex,
          chunkSummary: item.chunkSummary,
          domainHints: item.domainHints,
          localTopicCount: Array.isArray(item.localTopics)
            ? item.localTopics.length
            : 0,
        }))
      : [],
  };
}

function buildFallbackConcepts({ extractedText, diagramAnalysis, error }) {
  const pages = Array.isArray(diagramAnalysis.pages)
    ? diagramAnalysis.pages
    : [];

  const evidence = pages.slice(0, 5).map((page) => ({
    page: page.page ?? null,
    quote: cleanText(page.summary, 260),
    whyRelevant:
      "This page appears to contain material that should be explained during onboarding.",
  }));

  return {
    generatedAt: new Date().toISOString(),
    version: "concepts-v3-semantic-chunked-fallback",
    source: "local-fallback-after-openai-failure",
    model: CONCEPT_MODEL,
    extractionStrategy: "fallback",
    error: error ? String(error.message || error) : null,
    documentTitle: null,
    detectedDomain: "unknown",
    summary:
      "The system could not complete AI semantic chunking and merge, so it generated a safe fallback concept from the available document text and diagram summaries.",
    audienceLevel: "beginner",
    conceptCount: 1,
    primaryTopics: [
      {
        id: "topic-001",
        name: "Document training walkthrough",
        plainEnglish:
          "This document should be taught as a guided walkthrough: first explain what the material is for, then explain the key concepts, procedures, commands, diagrams, and decision points.",
        whyItMatters:
          "New learners need to understand how to use the document in real work, not just read it line by line.",
        analogy:
          "Think of it like learning a control room: first understand the main panels and flows, then learn which switch, command, dashboard, or step matters when something goes wrong.",
        operationalWorkflow: [
          "Identify the main system, process, workflow, or topic described by the document.",
          "Explain the important concepts, commands, components, diagrams, or decision points.",
          "Connect each detail to what someone would inspect, configure, verify, operate, or debug.",
          "Use diagrams as full visual maps, not as cropped fragments.",
        ],
        commonMistakes: [
          "Reading details without understanding when to use them.",
          "Treating diagrams as decoration instead of guided maps.",
          "Jumping into steps before understanding the overall workflow.",
        ],
        debuggingClues: [
          "Look for commands, components, process steps, request paths, service names, logs, metrics, error states, approvals, handoffs, and failure indicators.",
        ],
        evidence,
        subConcepts: [
          {
            id: "topic-001-sub-001",
            name: "Training meaning extraction",
            plainEnglish:
              "Important details should be converted into what a learner needs to understand or do in practice.",
            whyItMatters:
              "This turns a static document into onboarding material.",
            commands: [],
            evidence: extractedText
              ? [
                  {
                    page: null,
                    quote: cleanText(extractedText, 300),
                    whyRelevant:
                      "This text was used as fallback evidence for the document walkthrough.",
                  },
                ]
              : [],
          },
        ],
      },
    ],
    recommendedTeachingOrder: ["Document training walkthrough"],
    diagramGuidance: evidence.map((item) => ({
      page: item.page,
      howToExplain:
        "Show the full diagram or page and guide the learner through the flow step by step.",
      whatToPreserve:
        "Preserve the full architecture/context view. Do not crop into tiny isolated pieces.",
    })),
    localExtractionSummaries: [],
  };
}

async function callOpenAiJson(client, prompt, systemMessage) {
  const response = await client.responses.create({
    model: CONCEPT_MODEL,
    input: [
      {
        role: "system",
        content: systemMessage,
      },
      {
        role: "user",
        content: prompt,
      },
    ],
    temperature: 0.2,
  });

  const outputText = response.output_text || "";
  const parsed = safeJsonParse(outputText);

  if (!parsed) {
    throw new Error("OpenAI returned non-JSON concept output");
  }

  return parsed;
}

async function extractLocalConcepts({
  client,
  chunks,
  diagramAnalysis,
}) {
  const localExtractions = [];

  for (const [index, chunk] of chunks.entries()) {
    const prompt = buildChunkPrompt({
      chunk,
      chunkIndex: index,
      chunkCount: chunks.length,
      diagramAnalysis,
    });

    const parsed = await callOpenAiJson(
      client,
      prompt,
      "You are a senior instructor extracting local teaching concepts from one chunk of an internal training document. Return strict JSON only."
    );

    localExtractions.push(normalizeLocalExtraction(parsed, index));
  }

  return localExtractions;
}

async function mergeLocalConcepts({
  client,
  localExtractions,
  diagramAnalysis,
}) {
  const prompt = buildMergePrompt({
    localExtractions,
    diagramAnalysis,
  });

  const parsed = await callOpenAiJson(
    client,
    prompt,
    "You are a senior instructor merging local document concepts into a final domain-agnostic onboarding hierarchy. Return strict JSON only."
  );

  return normalizeSemanticConcepts(parsed, {
    chunkCount: localExtractions.length,
    localExtractions,
  });
}

async function extractConcepts({ extractedText, diagramAnalysis }) {
  if (!process.env.OPENAI_API_KEY) {
    return buildFallbackConcepts({
      extractedText,
      diagramAnalysis,
      error: new Error("OPENAI_API_KEY is not set"),
    });
  }

  const client = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  });

  try {
    const chunks = chunkText(extractedText);

    if (!chunks.length) {
      throw new Error("No extracted text available for semantic concept extraction");
    }

    const localExtractions = await extractLocalConcepts({
      client,
      chunks,
      diagramAnalysis,
    });

    return mergeLocalConcepts({
      client,
      localExtractions,
      diagramAnalysis,
    });
  } catch (error) {
    console.error("[conceptExtractor] Semantic chunked extraction failed:", error);

    return buildFallbackConcepts({
      extractedText,
      diagramAnalysis,
      error,
    });
  }
}

async function generateConcepts(jobDir) {
  const extractedPath = path.join(jobDir, "extracted.json");
  const diagramPath = path.join(jobDir, "diagram-analysis.json");

  const extractedData = readJsonIfExists(extractedPath, {});
  const diagramData = readJsonIfExists(diagramPath, {});

  return extractConcepts({
    extractedText: extractedData.text || "",
    diagramAnalysis: diagramData,
  });
}

function saveConcepts(jobDir, conceptsData) {
  const outputPath = getConceptsPath(jobDir);

  fs.writeFileSync(outputPath, JSON.stringify(conceptsData, null, 2));

  return outputPath;
}

module.exports = {
  generateConcepts,
  saveConcepts,
  getConceptsPath,
};
// notebook/worker/services/architectureTeachingLlmClient.js

/**
 * architectureTeachingLlmClient.js
 *
 * Bounded GPT-4.1 nano client for architecture teaching enrichment.
 *
 * Owns ONLY:
 * - OpenAI request
 * - strict prompt
 * - JSON-only response
 *
 * Must NOT own:
 * - document truth
 * - architecture interpretation
 * - flow ordering
 * - evidence selection
 * - fallback behavior
 */

const OpenAI = require("openai");

const DEFAULT_MODEL =
  process.env.OPENAI_ARCHITECTURE_TEACHING_MODEL ||
  process.env.OPENAI_MODEL ||
  "gpt-4.1-nano";

function hasOpenAiKey() {
  return Boolean(process.env.OPENAI_API_KEY);
}

function createArchitectureTeachingPrompt(input = {}) {
  return [
    {
      role: "system",
      content: `
You are a careful senior engineer teaching a new teammate how to understand an architecture handoff.

You are NOT discovering architecture truth.
The deterministic system already did that.

Your job is ONLY to turn the provided evidence-backed handoff into concise onboarding teaching.

Teach the responsibility transition:
- What changes as the flow moves from the source component to the target component?
- What should the learner pay attention to at this boundary?
- Why is this handoff useful for understanding the system?

Hard safety rules:
- Preserve exact component names.
- Start from documentSays.
- Do not simply repeat the fallback text.
- Do not invent hidden implementation details.
- Do not infer vendors, protocols, queues, databases, auth methods, cache behavior, retries, failover, scaling, encryption, or infrastructure.
- Use glossary matches only when provided.
- If confidence is limited, use cautious language.
- Keep each field one short sentence.
- Return JSON only.
- No markdown.
- No extra keys.

Output style:
- plainEnglish: explain the handoff in natural language, not as a template.
- safeSemantics: explain the generic architecture meaning without guessing implementation.
- whyItMatters: explain the operational/onboarding value of knowing this boundary.
- memoryHook: short memorable phrase that helps someone retain the transition.

Good style example:
{
  "plainEnglish": "CDN Edge is where the request leaves the edge-facing layer and enters API Gateway for centralized handling.",
  "safeSemantics": "This is a boundary handoff from a delivery-facing component into a routing or coordination point.",
  "whyItMatters": "It tells the learner where fast edge handling ends and deeper platform control begins.",
  "memoryHook": "Edge gets it close; Gateway takes control."
}

Bad style example:
{
  "plainEnglish": "CDN Edge → API Gateway is a documented handoff in the architecture flow.",
  "safeSemantics": "This handoff suggests work may branch, distribute, or move toward multiple downstream paths.",
  "whyItMatters": "This helps the learner understand where responsibility moves.",
  "memoryHook": "Remember this as: CDN Edge hands off responsibility to API Gateway."
}

Return exactly:
{
  "plainEnglish": "...",
  "safeSemantics": "...",
  "whyItMatters": "...",
  "memoryHook": "..."
}
`.trim(),
    },
    {
      role: "user",
      content: JSON.stringify(
        {
          segmentId: input.segmentId || null,
          from: input.from || null,
          to: input.to || null,
          documentSays: input.documentSays || "",
          glossaryMatches: input.glossaryMatches || [],
          fallback: input.fallback || {},
        },
        null,
        2
      ),
    },
  ];
}

function extractTextFromResponse(response) {
  return response?.choices?.[0]?.message?.content || "";
}

function createArchitectureTeachingLlmClient(options = {}) {
  if (!hasOpenAiKey()) {
    return null;
  }

  const client = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  });

  const model = options.model || DEFAULT_MODEL;

  return async function architectureTeachingLlmClient(input = {}) {
    const response = await client.chat.completions.create({
      model,
      temperature: 0.2,
      response_format: {
        type: "json_object",
      },
      messages: createArchitectureTeachingPrompt(input),
    });

    return extractTextFromResponse(response);
  };
}

module.exports = {
  createArchitectureTeachingLlmClient,
  createArchitectureTeachingPrompt,
};
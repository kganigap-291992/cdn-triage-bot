import { NextResponse } from "next/server";
import OpenAI from "openai";

import type {
  NarrationApiResponse,
  NarrationOutput,
  NarrationPayload,
} from "@/lib/llm/narrationTypes";

export const runtime = "nodejs";

const MODEL = process.env.OPENAI_NARRATION_MODEL || "gpt-4.1-nano";
const MAX_CALLS_PER_SESSION = 500;

let narrationCallCount = 0;

const SYSTEM_PROMPT = `
You are Cachey, a CDN incident narrator for leadership and CDN engineers.

Use ONLY the provided evidence.
Do NOT repeat the deterministic summary.
Do NOT invent metrics, causes, SQL, schema, regions, hosts, POPs, or root causes.

Return ONLY valid JSON in this exact shape:
{"leadershipSummary":"...","engineerRead":"...","nextChecks":["..."]}

General rules:
- Be concise, calm, direct, and practical.
- Mention only signals supported by evidence.
- Do NOT list every KPI.
- Do NOT use vague phrases like "overall", "some degradation", "focus should be", "appears to", or "may slightly".

Triage and explain card rules:
- leadershipSummary is for a non-technical business user.
- Use 1-2 short sentences only.
- Avoid CDN jargon like "cache efficiency".
- Explain:
  1) what changed
  2) business implication
  3) customer experience status
- Prefer wording like:
  "Cache performance is below normal (~73% hit rate), increasing backend load and cost. Customer experience remains stable with normal latency and traffic."

- engineerRead is for a CDN/SRE engineer.
- Use 1-2 short sentences only.
- Be directive, not explanatory.
- Identify the strongest operational signal.
- Tell the engineer where to start investigating.
- Prefer wording like:
  "Cache degradation is the primary signal. Start with worst region and worst POP to isolate where the low hit rate is concentrated."
- Do not mention host unless host-level evidence/actions are explicitly provided. Prefer POP when the action is POP-level.

Compare card rules:
If cardType is "compare":
- leadershipSummary should describe ONLY what changed vs the previous window.
- Focus on deltas: increased, decreased, stable, improved, worsened.
- Do NOT explain the full system state again.
- Do NOT repeat baseline metrics unless needed for clarity.
- Use 1-2 short sentences only.
- Prefer wording like:
  "Cache hit rate decreased slightly compared with the previous window, while latency and error rates stayed stable."

If cardType is "compare":
- engineerRead should highlight the most important change and whether it looks meaningful or minor.
- Suggest where to investigate only if the change needs follow-up.
- Prefer wording like:
  "The change is concentrated in cache behavior. Check worst region or POP if the drop continues."

nextChecks rules:
- Use only the provided allowedNextActions.
- Rephrase lightly if needed.
- Return max 3 items.
`.trim();

function safeString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function fallbackNarration(payload: NarrationPayload): NarrationOutput {
  return {
    leadershipSummary:
      payload.deterministicSummary ||
      "Cachey completed the deterministic analysis, but narration is unavailable.",
    engineerRead:
      "Use the deterministic summary and evidence sections for first-level triage.",
    nextChecks: payload.allowedNextActions?.slice(0, 3) ?? [],
  };
}

function buildPrompt(payload: NarrationPayload): string {
  return JSON.stringify(
    {
      userQuestion: payload.userQuestion,
      cardType: payload.cardType,
      parsedIntent: payload.parsedIntent,
      activeScope: payload.activeScope,
      timeWindow: payload.timeWindow,
      confidence: payload.confidence,
      deterministicSummary: payload.deterministicSummary,
      keyFindings: payload.keyFindings?.slice(0, 8),
      agentOutputs: payload.agentOutputs,
      importantMetrics: payload.importantMetrics,
      evidenceUsed: payload.evidenceUsed?.slice(0, 8),
      allowedNextActions: payload.allowedNextActions?.slice(0, 5),
    },
    null,
    2
  );
}

function extractJson(raw: string): any | null {
  const cleaned = raw.trim();

  try {
    return JSON.parse(cleaned);
  } catch {}

  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) return null;

  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

function parseNarrationOutput(
  raw: string,
  payload: NarrationPayload
): NarrationOutput {
  const parsed = extractJson(raw);

  if (parsed && typeof parsed === "object") {
    return {
      leadershipSummary:
        safeString(parsed.leadershipSummary) ||
        payload.deterministicSummary ||
        "Cachey completed the deterministic analysis.",

      engineerRead:
        safeString(parsed.engineerRead) ||
        "Use the deterministic summary and evidence sections for first-level triage.",

      nextChecks: Array.isArray(parsed.nextChecks)
        ? parsed.nextChecks.map(String).slice(0, 3)
        : payload.allowedNextActions?.slice(0, 3) ?? [],
    };
  }

  return fallbackNarration(payload);
}

export async function POST(req: Request) {
  try {
    const payload = (await req.json()) as NarrationPayload;

    if (!payload || !payload.cardType) {
      const response: NarrationApiResponse = {
        success: false,
        error: "Missing narration payload.",
      };

      return NextResponse.json(response, { status: 400 });
    }

    if (narrationCallCount >= MAX_CALLS_PER_SESSION) {
      const response: NarrationApiResponse = {
        success: true,
        data: fallbackNarration(payload),
      };

      return NextResponse.json(response);
    }

    const apiKey = process.env.OPENAI_API_KEY;

    if (!apiKey) {
      const response: NarrationApiResponse = {
        success: true,
        data: fallbackNarration(payload),
      };

      return NextResponse.json(response);
    }

    narrationCallCount += 1;

    console.log("USING LLM:", true, {
      model: MODEL,
      narrationCallCount,
      max: MAX_CALLS_PER_SESSION,
      cardType: payload.cardType,
    });

    const openai = new OpenAI({ apiKey });

    const result = await openai.responses.create({
      model: MODEL,
      max_output_tokens: 220,
      input: [
        {
          role: "system",
          content: SYSTEM_PROMPT,
        },
        {
          role: "user",
          content: buildPrompt(payload),
        },
      ],
    });

    const raw = result.output_text ?? "";
    const narration = parseNarrationOutput(raw, payload);

    const response: NarrationApiResponse = {
      success: true,
      data: narration,
    };

    return NextResponse.json(response);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Narration failed.";

    const response: NarrationApiResponse = {
      success: false,
      error: message,
    };

    return NextResponse.json(response, { status: 500 });
  }
}
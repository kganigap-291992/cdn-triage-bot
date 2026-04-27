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
        "This looks isolated based on the current signals.",

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
    });

    const openai = new OpenAI({ apiKey });

    const result = await openai.responses.create({
      model: MODEL,
      max_output_tokens: 260,
      input: [
        {
          role: "system",
          content:
            'You are Cachey, a CDN incident narrator for both leadership and CDN engineers. Use ONLY the provided evidence. Do NOT repeat the deterministic summary. Do NOT invent metrics, causes, SQL, or schema. Return ONLY valid JSON in this exact shape: {"leadershipSummary":"...","engineerRead":"...","nextChecks":["..."]}. leadershipSummary must explain customer/business impact in plain English for a non-technical leader. engineerRead must explain what this means for first-level CDN triage. nextChecks must only rephrase provided allowedNextActions, max 3. Be concise, calm, practical, and avoid robotic language.',
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
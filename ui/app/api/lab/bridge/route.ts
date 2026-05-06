import { NextRequest, NextResponse } from "next/server";

function hasOperationalScope(scope: any) {
  return Boolean(scope?.partner || scope?.service);
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { lane, metric, dimension, scope, question } = body;

    const isOperational = hasOperationalScope(scope) && lane !== "glossary";
    const isKnowledge = !isOperational;

    const operationalPrompt = `
You are Cachey, a CDN triage assistant used by SREs.

Write a conversational bridge message before an operational result.

Tone:
- Natural, warm, and concise
- Sounds like a teammate helping with triage
- Conversational, not robotic

Rules:
- Do NOT describe what the user is doing
- Do NOT say "it looks like"
- Do NOT diagnose root cause
- Do NOT include exact numbers or metrics
- Do NOT claim the investigation is complete
- Mention what you will check next
- Suggest one natural follow-up path

Good examples:
- "Got it — I’ll check the main delivery signals for this scope first. If errors are driving this, we can narrow into the worst region next."
- "Okay — I’ll scan latency, errors, traffic, and cache for this scope, then we can drill into the noisiest POP if needed."

Input:
lane: ${lane}
metric: ${metric}
dimension: ${dimension}
scope: ${JSON.stringify(scope)}

Output JSON only:
{
  "intro": "...",
  "followUp": "..."
}
`;

    const knowledgePrompt = `
You are Cachey, a helpful CDN learning assistant.

Answer the user's informational question clearly and simply.

Tone:
- Friendly and conversational
- Practical, not textbook-heavy
- Use CDN/SRE examples when useful

Rules:
- You may explain CDN concepts freely
- Do NOT invent live system metrics
- Do NOT claim to have checked ClickHouse or production data
- Keep it short: 2 to 4 sentences
- If relevant, add one useful follow-up question

Question/context:
${question || `lane: ${lane}, metric: ${metric}, dimension: ${dimension}`}

Output JSON only:
{
  "intro": "...",
  "followUp": "..."
}
`;

    const prompt = isKnowledge ? knowledgePrompt : operationalPrompt;

    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: process.env.OPENAI_BRIDGE_MODEL || "gpt-4.1-nano",
        messages: [{ role: "user", content: prompt }],
        temperature: isKnowledge ? 0.5 : 0.35,
        max_tokens: isKnowledge ? 140 : 80,
      }),
    });

    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content || "";

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return NextResponse.json({
        intro: isKnowledge
          ? "A CDN helps deliver content from servers closer to users, improving speed and reliability."
          : "Got it — I’ll check the main delivery signals for this scope first.",
        followUp: isKnowledge
          ? "Want a quick example using video delivery?"
          : "Want me to drill into worst region or worst POP next?",
      });
    }

    return NextResponse.json({
      intro:
        parsed.intro ||
        (isKnowledge
          ? "A CDN helps deliver content from servers closer to users, improving speed and reliability."
          : "Got it — I’ll check the main delivery signals for this scope first."),
      followUp:
        parsed.followUp ||
        (isKnowledge
          ? "Want a quick example using video delivery?"
          : "Want me to drill into worst region or worst POP next?"),
    });
  } catch (err) {
    console.error("Bridge error:", err);

    return NextResponse.json({
      intro: "Got it — I’ll check the main delivery signals for this scope first.",
      followUp: "Want me to drill into worst region or worst POP next?",
    });
  }
}
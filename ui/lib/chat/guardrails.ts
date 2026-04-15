export type ActiveScope = {
  partner: string;
  service: string;
};

export type GuardrailInput = {
  rawText: string;
  hasActiveInvestigation: boolean;
  activeScope: ActiveScope | null;
  detectedPartner?: string | null;
  detectedService?: string | null;
};

export type GuardrailResult =
  | { ok: true }
  | {
      ok: false;
      code:
        | "NO_ACTIVE_INVESTIGATION"
        | "PARTNER_CHANGE_BLOCKED"
        | "SERVICE_CHANGE_BLOCKED";
      message: string;
    };

function normalizeText(text: string): string {
  return String(text || "").trim().toLowerCase();
}

export function evaluateGuardrails(input: GuardrailInput): GuardrailResult {
  const text = normalizeText(input.rawText);

  if (!text) {
    return {
      ok: false,
      code: "NO_ACTIVE_INVESTIGATION",
      message: "Ask about traffic, latency, errors, or cache in the current scope.",
    };
  }

  // If there is no active investigation yet, block follow-up style chat actions.
  // We keep this simple in v1 and let the launcher / Run Triage establish scope first.
  if (!input.hasActiveInvestigation) {
    return {
      ok: false,
      code: "NO_ACTIVE_INVESTIGATION",
      message:
        "Start an investigation first by choosing partner and service, then run triage.",
    };
  }

  const activePartner = input.activeScope?.partner?.trim().toLowerCase() || "";
  const activeService = input.activeScope?.service?.trim().toLowerCase() || "";

  const detectedPartner =
    input.detectedPartner?.trim().toLowerCase() || null;
  const detectedService =
    input.detectedService?.trim().toLowerCase() || null;

  if (detectedPartner && activePartner && detectedPartner !== activePartner) {
    return {
      ok: false,
      code: "PARTNER_CHANGE_BLOCKED",
      message: "Use Change scope to switch partner.",
    };
  }

  if (detectedService && activeService && detectedService !== activeService) {
    return {
      ok: false,
      code: "SERVICE_CHANGE_BLOCKED",
      message: "Use Change scope to switch service.",
    };
  }

  return { ok: true };
}
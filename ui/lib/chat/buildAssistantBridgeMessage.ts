type BridgeInput = {
  lane: "triage" | "compare" | "drill" | "exploration" | "explain" | "glossary";
  metric?: string | null;
  dimension?: string | null;
  scope?: {
    partner?: string | null;
    service?: string | null;
    region?: string | null;
    pop?: string | null;
    contentType?: string | null;
    uaFamily?: string | null;
    windowMinutes?: number | null;
  } | null;
};

type BridgeOutput = {
  intro: string;
};

function pick(arr: string[]): string {
  return arr[Math.floor(Math.random() * arr.length)];
}

function label(value?: string | null, fallback = "this") {
  const cleaned = String(value || "").trim();
  return cleaned ? cleaned.replace(/_/g, " ") : fallback;
}

function scopeLabel(scope?: BridgeInput["scope"]) {
  if (!scope) return "the current scope";

  const parts = [
    scope.partner,
    scope.service,
    scope.region && scope.region !== "all" ? scope.region : null,
    scope.pop && scope.pop !== "all" ? scope.pop : null,
    scope.contentType && scope.contentType !== "all" ? scope.contentType : null,
    scope.uaFamily && scope.uaFamily !== "all" ? scope.uaFamily : null,
    scope.windowMinutes ? `last ${scope.windowMinutes}m` : null,
  ]
    .filter(Boolean)
    .map((x) => String(x).replace(/_/g, " "));

  return parts.length ? parts.join(" • ") : "the current scope";
}

export function buildAssistantBridgeMessage(input: BridgeInput): BridgeOutput {
  const metric = label(input.metric, "this signal");
  const dimension = label(input.dimension, "results");
  const scope = scopeLabel(input.scope);

  const intros: Record<BridgeInput["lane"], string[]> = {
    compare: [
      `Alright — comparing ${metric} against the previous window.`,
      `Got it — checking how ${metric} changed vs the last window.`,
      `Let’s line up current vs previous for ${metric}.`,
      `I’ll compare ${metric} with the prior window now.`,
      `Okay — looking at the ${metric} delta.`,
      `Let’s see what actually moved in ${metric}.`,
      `Checking whether ${metric} changed meaningfully.`,
      `I’ll put current and previous ${metric} side by side.`,
      `Let’s inspect the previous-window comparison for ${metric}.`,
      `Got it — pulling the ${metric} comparison.`,
    ],

    drill: [
      `Sure — ranking ${dimension} by current impact for ${scope}.`,
      `Got it — narrowing ${scope} down by ${dimension}.`,
      `Let’s find the most impacted ${dimension} in ${scope}.`,
      `I’ll pull the current ${dimension} ranking for ${scope}.`,
      `Okay — checking where impact is concentrated in ${scope}.`,
      `Let’s drill into the current hotspots for ${scope}.`,
      `I’ll look for the worst offenders in ${scope}.`,
      `Checking which ${dimension} stands out in ${scope}.`,
      `Let’s break ${scope} down by ${dimension}.`,
      `Got it — finding the top impacted ${dimension} for ${scope}.`,
    ],

    exploration: [
      `Got it — showing ${metric} for the current scope.`,
      `Here’s ${metric} for this investigation scope.`,
      `Let’s look at ${metric} over the selected window.`,
      `I’ll pull the ${metric} view now.`,
      `Okay — plotting ${metric} for the current scope.`,
      `Let’s inspect how ${metric} is behaving.`,
      `Showing the ${metric} signal now.`,
      `I’ll bring up the ${metric} trend.`,
      `Here’s the current ${metric} view.`,
      `Got it — checking ${metric} in this scope.`,
    ],

    triage: [
      `Running a full triage on ${scope}.`,
      `Got it — starting a full investigation for ${scope}.`,
      `Let’s analyze ${scope}.`,
      `I’ll check the main signals for ${scope}.`,
      `Okay — running the full triage pass on ${scope}.`,
      `Starting triage across traffic, latency, errors, and cache for ${scope}.`,
      `Let’s see what ${scope} is showing.`,
      `I’ll inspect the current operational signals for ${scope}.`,
      `Running deterministic triage on ${scope}.`,
      `Got it — checking health signals for ${scope}.`,
    ],

    explain: [""],
    glossary: [""],
  };

  return {
    intro: pick(intros[input.lane] || [""]),
  };
}
// notebook/worker/services/narrationContinuityBuilder.js

function normalizeText(value) {
  return String(value || "").trim();
}

function normalizeKey(value) {
  return normalizeText(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function uniq(values = []) {
  return [...new Set(values.filter(Boolean))];
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function getRegion(unit = {}) {
  return (
    unit.region ||
    unit.regionKey ||
    unit.regionAffinity ||
    unit.metadata?.region ||
    unit.metadata?.regionKey ||
    unit.metadata?.regionAffinity ||
    unit.metadata?.architectureRegion ||
    unit.metadata?.semanticRegion ||
    "unknown_region"
  );
}

function getTitle(unit = {}, index = 0) {
  return normalizeText(unit.title || unit.name || unit.label || `Scene ${index + 1}`);
}

function getPossibleStepArrays(unit = {}) {
  return [
    unit.steps,
    unit.flowSteps,
    unit.architectureSteps,
    unit.reasoningSteps,
    unit.pathSteps,
    unit.segments,
    unit.relationships,
    unit.metadata?.steps,
    unit.metadata?.flowSteps,
    unit.metadata?.architectureSteps,
    unit.metadata?.reasoningSteps,
    unit.metadata?.pathSteps,
    unit.metadata?.segments,
    unit.metadata?.relationships,
    unit.metadata?.flow?.steps,
    unit.metadata?.flow?.segments,
    unit.metadata?.architectureFlow?.steps,
    unit.metadata?.architectureFlow?.segments,
  ].filter(Array.isArray);
}

function flattenSteps(unit = {}) {
  return getPossibleStepArrays(unit).flat();
}

function readName(value) {
  if (!value) return "";

  if (typeof value === "string") return normalizeText(value);

  return normalizeText(
    value.name ||
      value.label ||
      value.title ||
      value.id ||
      value.componentName ||
      value.entityName
  );
}

function readFrom(step = {}) {
  return normalizeText(
    step.fromName ||
      step.sourceName ||
      step.sourceLabel ||
      step.fromLabel ||
      step.source ||
      step.from ||
      readName(step.fromComponent) ||
      readName(step.sourceComponent) ||
      readName(step.sourceEntity) ||
      readName(step.start)
  );
}

function readTo(step = {}) {
  return normalizeText(
    step.toName ||
      step.targetName ||
      step.targetLabel ||
      step.toLabel ||
      step.target ||
      step.to ||
      readName(step.toComponent) ||
      readName(step.targetComponent) ||
      readName(step.targetEntity) ||
      readName(step.end)
  );
}

function collectStepNames(unit = {}) {
  const steps = flattenSteps(unit);
  const names = [];

  steps.forEach((step) => {
    let from = readFrom(step);
    let to = readTo(step);

    if ((!from || !to) && typeof step === "string") {
      const parsed = parseStringStep(step);

      if (parsed) {
        from = parsed.from;
        to = parsed.to;
      }
    }

    if (from) names.push(from);
    if (to) names.push(to);

    if (typeof step === "object" && step !== null) {
      [
        step.name,
        step.entityName,
        step.componentName,
        step.label,
        step.title,
        step.primaryEntity,
        step.service,
        step.system,
        step.node,
      ].forEach((value) => {
        const name = readName(value);

        if (name) names.push(name);
      });
    }
  });

  

  [
    unit.primaryEntity,
    unit.componentName,
    unit.entityName,
    unit.metadata?.primaryEntity,
    unit.metadata?.componentName,
    unit.metadata?.entityName,
    unit.metadata?.teachingFocus?.entityName,
    unit.metadata?.teachingFocus?.componentName,
  ].forEach((value) => {
    const name = readName(value);
    if (name) names.push(name);
  });

  return uniq(names.map(normalizeText));
}


function parseStringStep(stepText = "") {
  const text = normalizeText(stepText);

  const patterns = [
    /(.*?) sends requests to (.*?)[.]?$/i,
    /(.*?) forwards .*? to (.*?)[.]?$/i,
    /(.*?) validates .*? through (.*?)[.]?$/i,
    /(.*?) distributes .*? to (.*?)[.]?$/i,
    /(.*?) reads and writes .*? from (.*?)[.]?$/i,
    /(.*?) connects to (.*?)[.]?$/i,
    /(.*?) routes .*? to (.*?)[.]?$/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);

    if (match) {
      return {
        from: normalizeText(match[1]),
        to: normalizeText(match[2]),
      };
    }
  }

  return null;
}

function collectHandoffs(unit = {}) {
  const steps = flattenSteps(unit);

  return steps
    .map((step) => {
      let from = readFrom(step);
        let to = readTo(step);

        if ((!from || !to) && typeof step === "string") {
        const parsed = parseStringStep(step);

        if (parsed) {
            from = parsed.from;
            to = parsed.to;
        }
        }

      if (!from || !to || from === to) return null;

      return {
        from,
        to,
        key: `${normalizeKey(from)}__to__${normalizeKey(to)}`,
        label: `${from} → ${to}`,
        relationshipType:
          step.relationshipType ||
          step.type ||
          step.edgeType ||
          step.flowType ||
          "unknown",
        confidence: step.confidence || step.weightedConfidence || "unknown",
      };
    })
    .filter(Boolean);
}

function inferConcepts(unit = {}) {
  const text = [
    unit.title,
    unit.name,
    unit.label,
    unit.summary,
    unit.description,
    unit.narration,
    unit.region,
    unit.regionAffinity,
    unit.metadata?.region,
    unit.metadata?.regionAffinity,
    unit.metadata?.teachingFocus,
    unit.metadata?.source,
  ]
    .map((value) =>
      typeof value === "object" ? JSON.stringify(value || {}) : normalizeText(value)
    )
    .join(" ")
    .toLowerCase();

  const concepts = [];

  const conceptRules = [
    ["entry_layer", ["entry", "ingress", "client", "edge", "traffic entry"]],
    ["routing_control", ["routing", "gateway", "control", "route"]],
    [
      "validation_checkpoint",
      ["validation", "auth", "authentication", "authorization", "access"],
    ],
    ["processing_layer", ["processing", "service", "application", "compute"]],
    ["state_persistence", ["state", "database", "persistence", "storage", "db"]],
    ["observability", ["monitoring", "metrics", "logs", "health", "telemetry"]],
    ["configuration_control", ["configuration", "config", "control plane"]],
  ];

  conceptRules.forEach(([concept, terms]) => {
    if (terms.some((term) => text.includes(term))) {
      concepts.push(concept);
    }
  });

  return uniq(concepts);
}

function findMatchingReasoningChapter(unit = {}, architectureReasoning = {}) {
  const titleKey = normalizeKey(getTitle(unit));
  const regionKey = normalizeKey(getRegion(unit));

  return asArray(architectureReasoning.chapters).find((chapter) => {
    const chapterTitleKey = normalizeKey(chapter.title || chapter.name);
    const chapterRegionKey = normalizeKey(
      chapter.region ||
        chapter.regionKey ||
        chapter.regionAffinity ||
        chapter.metadata?.regionAffinity
    );

    return (
      chapterTitleKey === titleKey ||
      chapterRegionKey === regionKey ||
      chapterTitleKey.includes(titleKey) ||
      titleKey.includes(chapterTitleKey)
    );
  });
}

function mergeUnitWithReasoning(unit = {}, architectureReasoning = {}) {
  const matchingChapter = findMatchingReasoningChapter(unit, architectureReasoning);

  if (!matchingChapter) return unit;

  return {
    ...matchingChapter,
    ...unit,
    metadata: {
      ...(matchingChapter.metadata || {}),
      ...(unit.metadata || {}),
      steps: [
        ...flattenSteps(matchingChapter),
        ...flattenSteps(unit),
      ],
    },
  };
}

function getCanonicalRail(unit = {}) {
  return (
    unit.metadata?.canonicalRailSummary ||
    unit.metadata?.enrichedSegments?.[0]?.canonicalTraversal ||
    null
  );
}

function getCanonicalHop(unit = {}) {
  const segment = unit.metadata?.enrichedSegments?.[0];
  const canonicalTraversal = segment?.canonicalTraversal;

  if (!canonicalTraversal) return null;

  return {
    ...canonicalTraversal,
    from: segment.from || canonicalTraversal.from || null,
    to: segment.to || canonicalTraversal.to || null,
  };
}


function buildCanonicalRailTransition({
  previousHop,
  currentHop,
  canonicalRail,
  currentTitle,
}) {
  if (
    !currentHop &&
    canonicalRail?.pathText &&
    /putting|recap/i.test(currentTitle)
    ) {
    return {
        type: "canonical_recap",
        text: `Recap the same canonical flow: ${canonicalRail.pathText}.`,
    };
    }

    if (!currentHop) return null;

  const from = normalizeText(currentHop?.from?.name);
  const to = normalizeText(currentHop?.to?.name);

  if (!from || !to) return null;

  if (!previousHop) {
    return {
      type: "canonical_opening",
      text: `Start the walkthrough by following the documented handoff from ${from} toward ${to}.`,
    };
  }

  const previousTo = normalizeText(previousHop?.to?.name);

  if (previousTo && previousTo === from) {
    return {
      type: "canonical_continuation",
      text: `Continue the walkthrough naturally from ${from} toward ${to} without restarting the architecture explanation.`,
      handoff: {
        from,
        to,
        label: `${from} → ${to}`,
      },
    };
  }

  return {
    type: "canonical_transition",
    text: `Move the walkthrough from ${from} toward ${to}, explaining why the responsibility changes at this stage of the flow.`,
    handoff: {
      from,
      to,
      label: `${from} → ${to}`,
    },
  };
}


function buildTransitionHint({
  previousRegion,
  currentRegion,
  previousPrimaryEntity,
  currentPrimaryEntity,
  currentTitle,
  handoffs = [],
}) {
  if (!previousRegion) {
    return {
      type: "opening",
      text: `Start by orienting the learner around ${currentTitle}.`,
    };
  }

  if (handoffs.length > 0) {
    return {
      type: "handoff_transition",
      text: `Continue through the next handoff, especially ${handoffs[0].label}, without restarting the whole architecture.`,
      handoff: handoffs[0],
    };
  }

  if (previousRegion === currentRegion) {
    return {
      type: "same_region_continuation",
      text: `Continue from ${previousPrimaryEntity || "the previous part"} into ${
        currentPrimaryEntity || currentTitle
      } without reintroducing the whole architecture.`,
    };
  }

  return {
    type: "region_transition",
    text: `Connect the previous region to ${currentTitle} and explain why the walkthrough is moving there now.`,
  };
}

function buildNarrationContinuity({
  lessonGraph = {},
  architectureReasoning = {},
  calmExplainerNarration = {},
} = {}) {
  const teachingUnits =
    lessonGraph?.teachingUnits ||
    lessonGraph?.lessonGraph?.teachingUnits ||
    architectureReasoning?.chapters ||
    [];

  const scenes = [];

  const explainedRegions = [];
  const explainedConcepts = [];
  const explainedComponents = [];
  const explainedHandoffs = [];

  let previousRegion = null;
  let previousPrimaryEntity = null;
  let previousCanonicalHop = null;

  teachingUnits.forEach((rawUnit, index) => {
    const unit = mergeUnitWithReasoning(rawUnit, architectureReasoning);

    const title = getTitle(unit, index);
    const region = getRegion(unit);
    const components = collectStepNames(unit);
    const handoffs = collectHandoffs(unit);
    const concepts = inferConcepts(unit);
    const canonicalRail = getCanonicalRail(unit);
    const canonicalHop = getCanonicalHop(unit);

    const primaryEntity =
      components[0] ||
      readName(unit.metadata?.primaryEntity) ||
      readName(unit.metadata?.teachingFocus?.entityName) ||
      title;

    const transitionHint =
    buildCanonicalRailTransition({
        previousHop: previousCanonicalHop,
        currentHop: canonicalHop,
        canonicalRail,
        currentTitle: title,
    }) ||
    buildTransitionHint({
        previousRegion,
        currentRegion: region,
        previousPrimaryEntity,
        currentPrimaryEntity: primaryEntity,
        currentTitle: title,
        handoffs,
    });

    const sceneContinuity = {
      sceneIndex: index,
      title,
      region,
      primaryEntity,
      concepts,
      components,
      handoffs,
      canonicalRail,
      canonicalHop,
      alreadyExplainedBeforeScene: {
        regions: uniq(explainedRegions),
        concepts: uniq(explainedConcepts),
        components: uniq(explainedComponents),
        handoffs: uniq(explainedHandoffs),
      },
      transitionHint,
      openingStyle:
        index === 0
          ? "orientation"
          : handoffs.length > 0
            ? "handoff_continuation"
            : previousRegion === region
              ? "continuation"
              : "region_transition",
      narrationGuidance: {
        avoidFullReset: index > 0,
        avoidRepeatingKnownConcepts: index > 0,
        preferCallbackToPreviousScene: index > 0,
        explainOnlyNewRoleOrResponsibility: index > 0,
        preferConcreteHandoffLanguage: handoffs.length > 0,
      },
    };

    scenes.push(sceneContinuity);

    explainedRegions.push(region);
    explainedConcepts.push(...concepts);
    explainedComponents.push(...components);
    explainedHandoffs.push(...handoffs.map((handoff) => handoff.label));

    previousRegion = region;
    previousPrimaryEntity = primaryEntity;

    if (canonicalHop) {
    previousCanonicalHop = canonicalHop;
    }
  });

  return {
    version: "narration-continuity-v2-step-aware",
    enabled: true,
    source: "deterministic",
    sceneCount: scenes.length,
    explainedRegions: uniq(explainedRegions),
    explainedConcepts: uniq(explainedConcepts),
    explainedComponents: uniq(explainedComponents),
    explainedHandoffs: uniq(explainedHandoffs),
    scenes,
    stats: {
      regionCount: uniq(explainedRegions).length,
      conceptCount: uniq(explainedConcepts).length,
      componentCount: uniq(explainedComponents).length,
      handoffCount: uniq(explainedHandoffs).length,
    },
    notes: [
      "V2 reads multiple step shapes from lessonGraph and architectureReasoning.",
      "This artifact is still deterministic only.",
      "LLM should not decide continuity state.",
    ],
  };
}

module.exports = {
  buildNarrationContinuity,
};
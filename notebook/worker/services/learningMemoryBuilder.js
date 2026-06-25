/**
 * learningMemoryBuilder.js
 *
 * BUG-12A — Learning Memory
 *
 * Owns:
 * - deterministic learner-state snapshot
 * - aggregate already introduced hops, components, journeys, and roles
 * - identify simple reinforcement candidates
 *
 * Does NOT:
 * - call LLM
 * - infer user mastery
 * - schedule spaced repetition
 * - mutate traversal
 * - narrate
 */

const fs = require("fs");
const path = require("path");

const BUILDER_VERSION =
  "learning-memory-v1";

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function safeString(value) {
  return String(value || "").trim();
}

function normalizeKey(value) {
  return safeString(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function uniq(values = []) {
  return Array.from(
    new Set(asArray(values).map(safeString).filter(Boolean))
  );
}

function countOccurrences(values = []) {
  return asArray(values).reduce((acc, value) => {
    const key = safeString(value);
    if (!key) return acc;
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
}

function collectIntroducedHops(hopContinuityMemory = {}) {
  return asArray(hopContinuityMemory.hops)
    .filter((hop) => hop.alreadyExplained === true)
    .map((hop) => ({
      hopId: hop.hopId,
      label: hop.label || null,
      status: hop.status || "introduced",
      firstExplainedInRailTitle:
        hop.firstExplainedInRailTitle || null,
      firstExplainedInJourneyType:
        hop.firstExplainedInJourneyType || null,
      journeyTypes:
        asArray(hop.journeyTypes),
      roleTransitionText:
        hop.roleTransitionText || null,
    }));
}

function collectAvailableHops(hopContinuityMemory = {}) {
  return asArray(hopContinuityMemory.hops)
    .filter((hop) => hop.alreadyExplained !== true)
    .map((hop) => ({
      hopId: hop.hopId,
      label: hop.label || null,
      status: hop.status || "available",
      journeyTypes:
        asArray(hop.journeyTypes),
      roleTransitionText:
        hop.roleTransitionText || null,
    }));
}

function collectIntroducedComponents(componentContinuityMemory = {}) {
  return asArray(componentContinuityMemory.components)
    .filter(
      (component) =>
        component.alreadyExplained === true
    )
    .map((component) => ({
      componentName:
        component.componentName,
      normalizedName:
        component.normalizedName ||
        normalizeKey(component.componentName),
      status:
        component.status || "introduced",
      firstExplainedInJourneyType:
        component.firstExplainedInJourneyType || null,
      firstExplainedInRailTitle:
        component.firstExplainedInRailTitle || null,
      primaryJourneyRole:
        component.primaryJourneyRole || "unknown",
      journeyTypes:
        asArray(component.journeyTypes),
      journeyRoles:
        asArray(component.journeyRoles),
      supportingHopIds:
        asArray(component.supportingHopIds),
    }));
}

function collectAvailableComponents(componentContinuityMemory = {}) {
  return asArray(componentContinuityMemory.components)
    .filter(
      (component) =>
        component.alreadyExplained !== true
    )
    .map((component) => ({
      componentName:
        component.componentName,
      normalizedName:
        component.normalizedName ||
        normalizeKey(component.componentName),
      status:
        component.status || "available",
      primaryJourneyRole:
        component.primaryJourneyRole || "unknown",
      journeyTypes:
        asArray(component.journeyTypes),
      journeyRoles:
        asArray(component.journeyRoles),
      supportingHopIds:
        asArray(component.supportingHopIds),
    }));
}

function collectKnownJourneys({
  journeyUnderstanding = {},
  introducedHops = [],
  introducedComponents = [],
} = {}) {
  const journeyTypes = [
    ...asArray(journeyUnderstanding.journeys).map(
      (journey) => journey.journeyType
    ),
    ...asArray(introducedHops).flatMap(
      (hop) => hop.journeyTypes
    ),
    ...asArray(introducedComponents).flatMap(
      (component) => component.journeyTypes
    ),
  ];

  return uniq(journeyTypes);
}

function collectKnownRoles({
  responsibilityUnderstanding = {},
  introducedHops = [],
  introducedComponents = [],
} = {}) {
  const fromResponsibilities =
    asArray(responsibilityUnderstanding.hops).flatMap(
      (hop) => [
        hop.from?.responsibility?.role,
        hop.to?.responsibility?.role,
        hop.handoffResponsibility?.fromRole,
        hop.handoffResponsibility?.toRole,
      ]
    );

  const fromHopTransitions =
    asArray(introducedHops).flatMap((hop) =>
      safeString(hop.roleTransitionText)
        .split("→")
        .map((part) => part.trim())
    );

  const fromComponents =
    asArray(introducedComponents).flatMap(
      (component) => [
        component.primaryJourneyRole,
        ...asArray(component.journeyRoles),
      ]
    );

  return uniq([
    ...fromResponsibilities,
    ...fromHopTransitions,
    ...fromComponents,
  ]).filter((role) => role !== "unknown");
}

function buildReinforcementCandidates({
  introducedComponents = [],
  introducedHops = [],
} = {}) {
  const componentJourneyCounts =
    asArray(introducedComponents).map((component) => ({
      type: "component",
      name: component.componentName,
      normalizedName: component.normalizedName,
      reason:
        "component appears in multiple journey contexts",
      count:
        uniq(component.journeyTypes).length,
    }));

  const componentHopCounts =
    asArray(introducedComponents).map((component) => ({
      type: "component",
      name: component.componentName,
      normalizedName: component.normalizedName,
      reason:
        "component participates in multiple supporting hops",
      count:
        uniq(component.supportingHopIds).length,
    }));

  const hopJourneyCounts =
    asArray(introducedHops).map((hop) => ({
      type: "hop",
      name: hop.label || hop.hopId,
      hopId: hop.hopId,
      reason:
        "hop appears in multiple journey contexts",
      count:
        uniq(hop.journeyTypes).length,
    }));

  return [
    ...componentJourneyCounts,
    ...componentHopCounts,
    ...hopJourneyCounts,
  ]
    .filter((item) => item.count > 1)
    .map((item) => ({
      ...item,
      reinforcementStatus:
        "candidate",
    }));
}

function buildLearningMemory({
  hopContinuityMemory = {},
  componentContinuityMemory = {},
  journeyUnderstanding = {},
  responsibilityUnderstanding = {},
  outputDir = null,
} = {}) {
  const introducedHops =
    collectIntroducedHops(hopContinuityMemory);

  const availableHops =
    collectAvailableHops(hopContinuityMemory);

  const introducedComponents =
    collectIntroducedComponents(
      componentContinuityMemory
    );

  const availableComponents =
    collectAvailableComponents(
      componentContinuityMemory
    );

  const introducedJourneyTypes =
    collectKnownJourneys({
      journeyUnderstanding,
      introducedHops,
      introducedComponents,
    });

  const introducedRoles =
    collectKnownRoles({
      responsibilityUnderstanding,
      introducedHops,
      introducedComponents,
    });

  const reinforcementCandidates =
    buildReinforcementCandidates({
      introducedComponents,
      introducedHops,
    });

  const payload = {
    version: BUILDER_VERSION,
    source: "learningMemoryBuilder",
    purpose:
      "Aggregate deterministic hop and component continuity into one learning-state snapshot for later recaps and teaching decisions.",

    rules: {
      traversalMutation: "forbidden",
      llmGeneratedMemory: "forbidden",
      masteryInference: "forbidden",
      memoryOnly: true,
    },

    introducedHopIds:
      introducedHops.map((hop) => hop.hopId),

    introducedComponentNames:
      introducedComponents.map(
        (component) => component.componentName
      ),

    introducedJourneyTypes,

    introducedRoles,

    introducedHops,
    availableHops,

    introducedComponents,
    availableComponents,

    reinforcementCandidates,

    stats: {
      introducedHopCount:
        introducedHops.length,

      availableHopCount:
        availableHops.length,

      introducedComponentCount:
        introducedComponents.length,

      availableComponentCount:
        availableComponents.length,

      introducedJourneyTypeCount:
        introducedJourneyTypes.length,

      introducedRoleCount:
        introducedRoles.length,

      reinforcementCandidateCount:
        reinforcementCandidates.length,

      traversalChanged:
        false,
    },
  };

  if (outputDir) {
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(
      path.join(outputDir, "learning-memory.json"),
      JSON.stringify(payload, null, 2),
      "utf8"
    );
  }

  return payload;
}

module.exports = {
  BUILDER_VERSION,
  buildLearningMemory,
};
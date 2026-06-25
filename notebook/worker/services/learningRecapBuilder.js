/**
 * learningRecapBuilder.js
 *
 * BUG-13A — Learning Recap
 *
 * Owns:
 * - deterministic recap generation from learning memory
 * - component, hop, journey, role, and reinforcement recap
 *
 * Does NOT:
 * - call LLM
 * - infer mastery
 * - narrate
 * - mutate traversal
 */

const fs = require("fs");
const path = require("path");

const BUILDER_VERSION =
  "learning-recap-v1";

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function safeString(value) {
  return String(value || "").trim();
}

function uniq(values = []) {
  return Array.from(
    new Set(asArray(values).map(safeString).filter(Boolean))
  );
}

function isJourneyType(value) {
  return /_journey$/.test(safeString(value));
}

function buildComponentRecap(learningMemory = {}) {
  return asArray(learningMemory.introducedComponents).map(
    (component) => ({
      componentName: component.componentName,
      normalizedName: component.normalizedName || null,
      primaryJourneyRole:
        component.primaryJourneyRole || "unknown",
      firstExplainedInJourneyType:
        component.firstExplainedInJourneyType || null,
      firstExplainedInRailTitle:
        component.firstExplainedInRailTitle || null,
      journeyTypes:
        asArray(component.journeyTypes),
      supportingHopIds:
        asArray(component.supportingHopIds),
    })
  );
}

function buildHopRecap(learningMemory = {}) {
  return asArray(learningMemory.introducedHops).map(
    (hop) => ({
      hopId: hop.hopId,
      label: hop.label || null,
      firstExplainedInJourneyType:
        hop.firstExplainedInJourneyType || null,
      firstExplainedInRailTitle:
        hop.firstExplainedInRailTitle || null,
      journeyTypes:
        asArray(hop.journeyTypes),
      roleTransitionText:
        hop.roleTransitionText || null,
    })
  );
}

function buildJourneyRecap({
  learningMemory = {},
  journeyUnderstanding = {},
} = {}) {
  const introducedJourneyTypes =
    uniq(
      asArray(learningMemory.introducedJourneyTypes)
        .filter(isJourneyType)
    );

  const journeyByType = new Map(
    asArray(journeyUnderstanding.journeys).map(
      (journey) => [journey.journeyType, journey]
    )
  );

  return introducedJourneyTypes.map((journeyType) => {
    const journey = journeyByType.get(journeyType) || {};

    return {
      journeyType,
      journeyId:
        journey.journeyId || null,
      teachingPurpose:
        journey.teachingPurpose || null,
      sourceRailIds:
        asArray(journey.sourceRailIds),
      secondarySourceRailIds:
        asArray(journey.secondarySourceRailIds),
      hopIds:
        asArray(journey.hopIds),
      secondaryHopIds:
        asArray(journey.secondaryHopIds),
      allRelatedHopIds:
        asArray(journey.allRelatedHopIds),
    };
  });
}

function buildRoleRecap({
  learningMemory = {},
  responsibilityUnderstanding = {},
} = {}) {
  const introducedRoles =
    uniq(learningMemory.introducedRoles);

  const roleBreakdown =
    responsibilityUnderstanding.stats?.roleBreakdown || {};

  const perHopRoleBreakdown =
    responsibilityUnderstanding.stats?.perHopRoleBreakdown || {};

  return introducedRoles.map((role) => ({
    role,
    globalCount:
      roleBreakdown[role] || 0,
    perHopCount:
      perHopRoleBreakdown[role] || 0,
  }));
}

function buildReinforcementRecap(learningMemory = {}) {
  const candidates =
    asArray(learningMemory.reinforcementCandidates);

  return {
    components:
      candidates.filter(
        (item) => item.type === "component"
      ),

    hops:
      candidates.filter(
        (item) => item.type === "hop"
      ),
  };
}

function buildLearningRecap({
  learningMemory = {},
  journeyUnderstanding = {},
  responsibilityUnderstanding = {},
  outputDir = null,
} = {}) {
  const components =
    buildComponentRecap(learningMemory);

  const hops =
    buildHopRecap(learningMemory);

  const journeys =
    buildJourneyRecap({
      learningMemory,
      journeyUnderstanding,
    });

  const roles =
    buildRoleRecap({
      learningMemory,
      responsibilityUnderstanding,
    });

  const reinforcement =
    buildReinforcementRecap(learningMemory);

  const payload = {
    version: BUILDER_VERSION,
    source: "learningRecapBuilder",
    purpose:
      "Create a deterministic recap of what the learner has already been introduced to in the architecture walkthrough.",

    rules: {
      traversalMutation: "forbidden",
      llmGeneratedRecap: "forbidden",
      masteryInference: "forbidden",
      memoryOnly: true,
    },

    summary: {
      introducedComponentCount:
        components.length,

      introducedHopCount:
        hops.length,

      introducedJourneyCount:
        journeys.length,

      introducedRoleCount:
        roles.length,

      reinforcementCandidateCount:
        reinforcement.components.length +
        reinforcement.hops.length,
    },

    recap: {
      componentNames:
        components.map(
          (component) => component.componentName
        ),

      hopLabels:
        hops.map((hop) => hop.label).filter(Boolean),

      journeyTypes:
        journeys.map(
          (journey) => journey.journeyType
        ),

      roles:
        roles.map((item) => item.role),
    },

    components,
    hops,
    journeys,
    roles,
    reinforcement,

    stats: {
      introducedComponentCount:
        components.length,

      introducedHopCount:
        hops.length,

      introducedJourneyCount:
        journeys.length,

      introducedRoleCount:
        roles.length,

      reinforcementComponentCount:
        reinforcement.components.length,

      reinforcementHopCount:
        reinforcement.hops.length,

      traversalChanged:
        false,
    },
  };

  if (outputDir) {
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(
      path.join(outputDir, "learning-recap.json"),
      JSON.stringify(payload, null, 2),
      "utf8"
    );
  }

  return payload;
}

module.exports = {
  BUILDER_VERSION,
  buildLearningRecap,
};
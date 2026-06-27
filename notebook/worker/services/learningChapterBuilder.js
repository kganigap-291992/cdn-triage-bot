/**
 * learningChapterBuilder.js
 *
 * BUG-16A — Learning Chapters
 *
 * Owns:
 * - deterministic chapter grouping from BUG-15 learning traversal
 * - one-focus-to-one-chapter assignment health
 * - chapter metadata for future rendering
 *
 * Does NOT:
 * - call LLM
 * - narrate
 * - render
 * - mutate traversal
 * - rebuild teaching focus order
 */

const fs = require("fs");
const path = require("path");

const BUILDER_VERSION = "learning-chapters-v1";

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function safeString(value) {
  return String(value || "").trim();
}

function safeLower(value) {
  return safeString(value).toLowerCase();
}

function slugify(value) {
  return safeLower(value)
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
}

function uniq(values = []) {
  return Array.from(
    new Set(asArray(values).map(safeString).filter(Boolean))
  );
}

function titleFromJourneyType(journeyType) {
  const labels = {
    request_journey: "Request Journey",
    content_delivery_journey: "Content Delivery Journey",
    validation_journey: "Validation Journey",
    control_journey: "Control Journey",
    state_journey: "State Journey",
    observability_journey: "Observability Journey",
    retrieval_journey: "Retrieval Journey",
    configuration_journey: "Configuration Journey",
    background_journey: "Background Journey",
    supporting_journey: "Supporting Journey",
  };

  return labels[journeyType] || safeString(journeyType)
    .replace(/_/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function estimateTimeSec(chapterType, focusCount) {
  if (chapterType === "overview") return 60;
  if (chapterType === "journey") return 90;
  if (chapterType === "recap") return 60;

  const base = 60;
  const scaled = base + Math.max(0, focusCount - 1) * 15;

  return Math.min(120, Math.max(60, scaled));
}

function makeChapter({
  chapterId,
  chapterType,
  title,
  teachingGoal,
  focusIds = [],
  journeyTypes = [],
  roles = [],
  components = [],
  hopIds = [],
  source = "learningChapterBuilder",
} = {}) {
  return {
    chapterId,
    chapterType,
    title,
    teachingGoal,

    focusIds: uniq(focusIds),
    journeyTypes: uniq(journeyTypes),
    roles: uniq(roles),
    components: uniq(components),
    hopIds: uniq(hopIds),

    estimatedTimeSec:
      estimateTimeSec(chapterType, uniq(focusIds).length),

    source,
    traversalChanged: false,
  };
}

function getFocusChapterKey(focus = {}) {
  const type = focus.focusEntityType;

  if (type === "journey") {
    return `journey:${focus.journeyType || focus.label}`;
  }

  if (type === "role") {
    return "responsibilities";
  }

  if (type === "component") {
    return "components";
  }

  if (type === "hop") {
    return "handoffs";
  }

  return "overview";
}

function collectChapterMetadata(focuses = []) {
  return {
    focusIds: focuses.map((focus) => focus.focusId),
    journeyTypes: focuses.flatMap((focus) => [
      focus.journeyType,
      focus.focusEntityType === "journey" ? focus.label : null,
    ]),
    roles: focuses.flatMap((focus) => [
      focus.role,
      focus.focusEntityType === "role" ? focus.label : null,
    ]),
    components: focuses.flatMap((focus) => [
      focus.component,
      focus.focusEntityType === "component" ? focus.label : null,
    ]),
    hopIds: focuses.flatMap((focus) => [
      focus.hopId,
      focus.focusEntityType === "hop" ? focus.entityId : null,
    ]),
  };
}

function buildOverviewChapter() {
  return makeChapter({
    chapterId: "chapter_001_architecture_overview",
    chapterType: "overview",
    title: "Architecture Overview",
    teachingGoal:
      "Orient the learner to the architecture before entering journey, responsibility, component, and handoff detail.",
  });
}

function buildJourneyChapters({ focusBuckets = new Map() } = {}) {
  const journeyEntries = Array.from(focusBuckets.entries())
    .filter(([key]) => key.startsWith("journey:"))
    .sort(([a], [b]) => {
      const priority = {
        "journey:request_journey": 1,
        "journey:content_delivery_journey": 2,
        "journey:validation_journey": 3,
        "journey:control_journey": 4,
        "journey:state_journey": 5,
      };

      return (priority[a] || 99) - (priority[b] || 99) ||
        a.localeCompare(b);
    });

  return journeyEntries.map(([key, focuses], index) => {
    const journeyType = key.replace(/^journey:/, "");
    const metadata = collectChapterMetadata(focuses);

    return makeChapter({
      chapterId:
        `chapter_${String(index + 2).padStart(3, "0")}_${slugify(journeyType)}`,
      chapterType: "journey",
      title: titleFromJourneyType(journeyType),
      teachingGoal:
        `Teach the ${titleFromJourneyType(journeyType).toLowerCase()} as a coherent learning chapter before moving into responsibilities and details.`,
      ...metadata,
      journeyTypes: [journeyType, ...metadata.journeyTypes],
    });
  });
}

function buildResponsibilityChapter({ focusBuckets = new Map(), chapterIndex }) {
  const focuses = focusBuckets.get("responsibilities") || [];
  const metadata = collectChapterMetadata(focuses);

  return makeChapter({
    chapterId:
      `chapter_${String(chapterIndex).padStart(3, "0")}_responsibilities`,
    chapterType: "responsibility",
    title: "Responsibilities",
    teachingGoal:
      "Teach the major responsibility roles after journey context is established.",
    ...metadata,
  });
}

function buildComponentChapter({ focusBuckets = new Map(), chapterIndex }) {
  const focuses = focusBuckets.get("components") || [];
  const metadata = collectChapterMetadata(focuses);

  return makeChapter({
    chapterId:
      `chapter_${String(chapterIndex).padStart(3, "0")}_components`,
    chapterType: "component",
    title: "Component Deep Dive",
    teachingGoal:
      "Inspect components after their journeys and responsibilities are already established.",
    ...metadata,
  });
}

function buildHandoffChapter({ focusBuckets = new Map(), chapterIndex }) {
  const focuses = focusBuckets.get("handoffs") || [];
  const metadata = collectChapterMetadata(focuses);

  return makeChapter({
    chapterId:
      `chapter_${String(chapterIndex).padStart(3, "0")}_handoffs`,
    chapterType: "hop",
    title: "Important Handoffs",
    teachingGoal:
      "Follow architecture handoffs after the learner understands journeys, roles, and components.",
    ...metadata,
  });
}

function buildRecapChapter({ learningRecap = {}, chapterIndex }) {
  return makeChapter({
    chapterId:
      `chapter_${String(chapterIndex).padStart(3, "0")}_architecture_recap`,
    chapterType: "recap",
    title: "Architecture Recap",
    teachingGoal:
      "Recap only what learningRecap says was already introduced, without adding new inference.",
    journeyTypes: asArray(learningRecap.recap?.journeyTypes),
    roles: asArray(learningRecap.recap?.roles),
    components: asArray(learningRecap.recap?.componentNames),
    hopIds: asArray(learningRecap.hops).map((hop) => hop.hopId),
  });
}

function buildChapterHealth({
  chapters = [],
  teachingFocusSequence = [],
  learningTraversal = {},
} = {}) {
  const allFocusIds = asArray(teachingFocusSequence)
    .map((focus) => focus.focusId)
    .filter(Boolean);

  const assignedFocusIds = chapters.flatMap((chapter) =>
    asArray(chapter.focusIds)
  );

  const assignmentCounts = assignedFocusIds.reduce((acc, focusId) => {
    acc[focusId] = (acc[focusId] || 0) + 1;
    return acc;
  }, {});

  const duplicateFocusIds = Object.entries(assignmentCounts)
    .filter(([, count]) => count > 1)
    .map(([focusId]) => focusId);

  const assignedSet = new Set(assignedFocusIds);

  const unassignedFocusIds = allFocusIds.filter(
    (focusId) => !assignedSet.has(focusId)
  );

  const knownFocusSet = new Set(allFocusIds);

  const orphanAssignedFocusIds = assignedFocusIds.filter(
    (focusId) => !knownFocusSet.has(focusId)
  );

  const expectedOrder = [
    "overview",
    "journey",
    "responsibility",
    "component",
    "hop",
    "recap",
  ];

  const chapterTypes = chapters.map(
    (chapter) => chapter.chapterType
    );

    const missingRequiredChapterTypes = expectedOrder.filter(
    (type) => !chapterTypes.includes(type)
    );

  const orderRanks = expectedOrder.reduce((acc, type, index) => {
    acc[type] = index + 1;
    return acc;
  }, {});

  const orderViolations = [];

  chapters.forEach((chapter, index) => {
    const currentRank = orderRanks[chapter.chapterType] || 99;
    const previous = chapters[index - 1];

    if (!previous) return;

    const previousRank = orderRanks[previous.chapterType] || 99;

    if (currentRank < previousRank) {
      orderViolations.push({
        type: "chapter_order_violation",
        previousChapterId: previous.chapterId,
        currentChapterId: chapter.chapterId,
        previousChapterType: previous.chapterType,
        currentChapterType: chapter.chapterType,
      });
    }
  });

  const violations = [
    ...missingRequiredChapterTypes.map((chapterType) => ({
        type: "missing_required_chapter",
        chapterType,
    })),

    ...duplicateFocusIds.map((focusId) => ({
        type: "duplicate_focus_assignment",
        focusId,
    })),

    ...unassignedFocusIds.map((focusId) => ({
        type: "unassigned_focus",
        focusId,
    })),

    ...orphanAssignedFocusIds.map((focusId) => ({
        type: "orphan_assigned_focus",
        focusId,
    })),

    ...orderViolations,
    ];

  return {
    version: "learning-chapter-health-v1",
    valid:
      violations.length === 0 &&
      learningTraversal?.traversalChanged !== true,

    violationCount: violations.length,
    duplicateFocusAssignmentCount: duplicateFocusIds.length,
    unassignedFocusCount: unassignedFocusIds.length,
    orphanAssignedFocusCount: orphanAssignedFocusIds.length,
    missingRequiredChapterCount:
        missingRequiredChapterTypes.length,
    orderViolationCount: orderViolations.length,
    traversalChanged:
      learningTraversal?.traversalChanged === true,

    violations,

    samples: {
      duplicateFocusIds: duplicateFocusIds.slice(0, 5),
      unassignedFocusIds: unassignedFocusIds.slice(0, 5),
      orphanAssignedFocusIds: orphanAssignedFocusIds.slice(0, 5),
      missingRequiredChapterTypes: missingRequiredChapterTypes.slice(0, 5),
      orderViolations: orderViolations.slice(0, 5),
    },
  };
}

function buildLearningChapters({
  teachingFocusSequence = [],
  learningTraversal = {},
  architectureLearningGraph = {},
  learningRecap = {},
  journeyUnderstanding = {},
  outputDir = null,
} = {}) {
  const focuses = asArray(teachingFocusSequence)
    .filter((focus) => focus?.focusId);

  const focusBuckets = new Map();

  for (const focus of focuses) {
    const key = getFocusChapterKey(focus);

    if (!focusBuckets.has(key)) {
      focusBuckets.set(key, []);
    }

    focusBuckets.get(key).push(focus);
  }

  const chapters = [];

  chapters.push(buildOverviewChapter());

  chapters.push(
    ...buildJourneyChapters({
      focusBuckets,
      journeyUnderstanding,
    })
  );

  let chapterIndex = chapters.length + 1;

  if ((focusBuckets.get("responsibilities") || []).length > 0) {
    chapters.push(
      buildResponsibilityChapter({
        focusBuckets,
        chapterIndex,
      })
    );
    chapterIndex += 1;
  }

  if ((focusBuckets.get("components") || []).length > 0) {
    chapters.push(
      buildComponentChapter({
        focusBuckets,
        chapterIndex,
      })
    );
    chapterIndex += 1;
  }

  if ((focusBuckets.get("handoffs") || []).length > 0) {
    chapters.push(
      buildHandoffChapter({
        focusBuckets,
        chapterIndex,
      })
    );
    chapterIndex += 1;
  }

  chapters.push(
    buildRecapChapter({
      learningRecap,
      chapterIndex,
    })
  );

  const health = buildChapterHealth({
    chapters,
    teachingFocusSequence: focuses,
    learningTraversal,
  });

  const assignedFocusCount = chapters.reduce(
    (sum, chapter) => sum + asArray(chapter.focusIds).length,
    0
  );

  const payload = {
    version: BUILDER_VERSION,
    source: "learningChapterBuilder",
    purpose:
      "Group BUG-15 teaching focus sequence into deterministic learning chapters for future rendering and lesson organization.",

    borrowedIdeas: [
      "notebooklm_guided_chapter_progression",
      "intelligent_tutoring_prerequisite_grouping",
      "motion_canvas_semantic_beats",
    ],

    rules: {
      traversalMutation: "forbidden",
      llmGeneratedChapters: "forbidden",
      renderingChanges: "forbidden",
      narrationGeneration: "forbidden",
      oneFocusPerChapter: true,
      sourceOfTruth: "architectureTraversal.teachingFocusSequence",
    },

    inputs: {
      teachingFocusCount: focuses.length,
      learningTraversalEnabled:
        learningTraversal?.enabled === true,
      architectureLearningNodeCount:
        architectureLearningGraph?.stats?.nodeCount || 0,
      learningRecapVersion:
        learningRecap?.version || null,
      journeyCount:
        asArray(journeyUnderstanding.journeys).length,
    },

    chapters,
    health,

    stats: {
      chapterCount: chapters.length,
      assignedFocusCount,
      duplicateFocusAssignmentCount:
        health.duplicateFocusAssignmentCount,
      unassignedFocusCount:
        health.unassignedFocusCount,
      traversalChanged: false,
    },
  };

  if (outputDir) {
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(
      path.join(outputDir, "learning-chapters.json"),
      JSON.stringify(payload, null, 2),
      "utf8"
    );
  }

  return payload;
}

module.exports = {
  BUILDER_VERSION,
  buildLearningChapters,
};
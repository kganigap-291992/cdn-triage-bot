const path = require("path");
const fs = require("fs");

const {
  buildRegionTraversalTeaching,
} = require("../../../services/regionTraversalTeachingBuilder");

const JOB_ID = process.env.JOB_ID;

if (!JOB_ID) {
  throw new Error("JOB_ID is required");
}

const jobDir = path.join(process.cwd(), "temp", JOB_ID);

function readJson(name) {
  return JSON.parse(
    fs.readFileSync(path.join(jobDir, name), "utf8")
  );
}

const lessonPlan = readJson("lesson-plan.json");
const learningChapters = readJson("learning-chapters.json");
const narrationContinuity = readJson("narration-continuity.json");

const regionTraversal = buildRegionTraversalTeaching({
  lessonGraph: lessonPlan.lessonGraph,
  learningChapters,
  narrationContinuity,
  outputDir: jobDir,
});

console.log(JSON.stringify({
  stats: regionTraversal.stats,
  health: regionTraversal.health,
  regions: regionTraversal.regions.map((region) => ({
    title: region.title,
    sceneIndexes: region.sceneIndexes,
    teachingUnitIds: region.teachingUnitIds,
  })),
  transitions: regionTraversal.transitions.map((transition) => ({
    from: transition.fromRegion,
    to: transition.toRegion,
    type: transition.transitionType,
  })),
}, null, 2));

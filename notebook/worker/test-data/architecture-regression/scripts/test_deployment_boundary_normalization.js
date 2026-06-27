const path = require("path");
const fs = require("fs");

const {
  buildDeploymentBoundaryNormalization,
} = require("../../../services/deploymentBoundaryNormalizationBuilder");

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

const normalized =
  buildDeploymentBoundaryNormalization({
    architectureUnderstanding: readJson("architecture-understanding.json"),
    regionTraversal: readJson("region-traversal.json"),
    outputDir: jobDir,
  });

console.log(JSON.stringify({
  stats: normalized.stats,
  health: normalized.health,
  normalizedBoundaries: normalized.normalizedBoundaries.map((boundary) => ({
    normalizedLabel: boundary.normalizedLabel,
    rawTexts: boundary.rawTexts,
    componentNames: boundary.componentNames,
    sceneIndexes: boundary.sceneIndexes,
  })),
}, null, 2));

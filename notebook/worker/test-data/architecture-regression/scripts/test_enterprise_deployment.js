const path = require("path");
const fs = require("fs");

const {
  buildDeploymentBoundaryNormalization,
} = require("../../../services/deploymentBoundaryNormalizationBuilder");

const {
  buildEnterpriseDeploymentUnderstanding,
} = require("../../../services/enterpriseDeploymentUnderstandingBuilder");

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

const architectureUnderstanding =
  readJson("architecture-understanding.json");

const regionTraversal =
  readJson("region-traversal.json");

const deploymentBoundaryNormalization =
  buildDeploymentBoundaryNormalization({
    architectureUnderstanding,
    regionTraversal,
    outputDir: jobDir,
  });

const enterpriseDeployment =
  buildEnterpriseDeploymentUnderstanding({
    architectureUnderstanding,
    regionTraversal,
    deploymentBoundaryNormalization,
    sharedNodeUnderstanding: readJson("shared-node-understanding.json"),
    multiRailUnderstanding: readJson("multi-rail-understanding.json"),
    bidirectionalRailUnderstanding: readJson("bidirectional-rail-understanding.json"),
    outputDir: jobDir,
  });

console.log(JSON.stringify({
  normalizationVersion: deploymentBoundaryNormalization.version,
  normalizationStats: deploymentBoundaryNormalization.stats,
  stats: enterpriseDeployment.stats,
  health: enterpriseDeployment.health,
  regions: enterpriseDeployment.regions.map((region) => ({
    title: region.title,
    sourceBoundaries: region.sourceBoundaries,
    componentNames: region.componentNames,
  })),
  replicatedRegionCandidates: enterpriseDeployment.replicatedRegionCandidates,
  deploymentPattern: enterpriseDeployment.deploymentPattern,
}, null, 2));
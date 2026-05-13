// notebook/worker/routes/build-lesson-plan.js

const express = require("express");
const path = require("path");
const fs = require("fs");

const {
  buildDocumentUnderstanding,
} = require("../services/documentUnderstandingBuilder");

const {
  buildSpatialUnderstanding,
  saveSpatialUnderstanding,
} = require("../services/spatialUnderstandingBuilder");

const {
  buildArchitectureUnderstanding,
} = require("../services/architectureUnderstandingBuilder");

const {
  generateLessonPlan,
  saveLessonPlan,
} = require("../services/lessonPlanner");

const router = express.Router();

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
  return filePath;
}

router.post("/:jobId", async (req, res) => {
  try {
    const { jobId } = req.params;

    if (!jobId) {
      return res.status(400).json({
        ok: false,
        error: "Missing jobId",
      });
    }

    const jobDir = path.join(
      process.env.NOTEBOOK_TEMP_DIR || path.join(__dirname, "../temp"),
      jobId
    );

    const documentUnderstanding = buildDocumentUnderstanding({
      jobDir,
    });

    console.log("[document-understanding]", {
      entities: documentUnderstanding.stats.entityCount,
      relationships: documentUnderstanding.stats.relationshipCount,
      sequences: documentUnderstanding.stats.sequenceCount,
    });

    const spatialUnderstanding = buildSpatialUnderstanding({
      jobDir,
    });

    const spatialUnderstandingPath = saveSpatialUnderstanding(
      jobDir,
      spatialUnderstanding
    );

    console.log("[spatial-understanding]", spatialUnderstanding.stats);

    const architectureUnderstanding =
      buildArchitectureUnderstanding(documentUnderstanding);

    const architectureUnderstandingPath = writeJson(
      path.join(jobDir, "architecture-understanding.json"),
      architectureUnderstanding
    );

    console.log("[architecture-understanding]", {
      components: architectureUnderstanding.stats.componentCount,
      relationships: architectureUnderstanding.stats.relationshipCount,
      flows: architectureUnderstanding.stats.flowCount,
      inferred: architectureUnderstanding.stats.inferredRelationshipCount,
      explicit: architectureUnderstanding.stats.explicitRelationshipCount,
    });

    const lessonPlan = generateLessonPlan(jobDir);

    const outputPath = saveLessonPlan(
      jobDir,
      lessonPlan
    );

    return res.json({
      ok: true,
      phase: "lesson-plan",
      version: lessonPlan.version,
      jobId,
      documentUnderstanding: {
        version: documentUnderstanding.version,
        stats: documentUnderstanding.stats,
        confidence: documentUnderstanding.confidence,
      },
      spatialUnderstanding: {
        version: spatialUnderstanding.version,
        stats: spatialUnderstanding.stats,
        output: spatialUnderstandingPath,
      },
      architectureUnderstanding: {
        version: architectureUnderstanding.version,
        stats: architectureUnderstanding.stats,
        output: architectureUnderstandingPath,
      },
      sectionCount: lessonPlan.lessonStructure.length,
      conceptCount: lessonPlan.prioritizedConcepts.length,
      output: outputPath,
    });
  } catch (error) {
    console.error("build-lesson-plan error:", error);

    return res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
});

module.exports = router;
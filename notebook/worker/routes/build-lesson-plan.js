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
  buildSpatialEntityGrounding,
} = require("../services/spatialEntityGroundingBuilder");

const {
  buildArchitectureUnderstanding,
} = require("../services/architectureUnderstandingBuilder");

const {
  buildArchitectureFlow,
} = require("../services/architectureFlowBuilder");

const {
  buildArchitectureTeaching,
} = require("../services/architectureTeachingEnricher");

const {
  createArchitectureTeachingLlmClient,
} = require("../services/architectureTeachingLlmClient");

const {
  generateLessonPlan,
  saveLessonPlan,
} = require("../services/lessonPlanner");

const router = express.Router();

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
  return filePath;
}

function readJson(filePath, fallback = {}) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
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

    const layoutBoxes = readJson(path.join(jobDir, "layout-boxes.json"), {});
    const documentStructure = readJson(
      path.join(jobDir, "document-structure.json"),
      {}
    );

    const spatialUnderstanding = buildSpatialUnderstanding({
      jobDir,
    });

    const spatialUnderstandingPath = saveSpatialUnderstanding(
      jobDir,
      spatialUnderstanding
    );

    console.log("[spatial-understanding]", spatialUnderstanding.stats);

    const spatialEntityGrounding = buildSpatialEntityGrounding({
      documentUnderstanding,
      spatialUnderstanding,
      layoutBoxes,
      documentStructure,
    });

    const spatialEntityGroundingPath = writeJson(
      path.join(jobDir, "spatial-entity-grounding.json"),
      spatialEntityGrounding
    );

    console.log("[spatial-entity-grounding]", spatialEntityGrounding.stats);

    const architectureUnderstanding = buildArchitectureUnderstanding(
      documentUnderstanding,
      spatialUnderstanding
    );

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

    const architectureFlow = buildArchitectureFlow(architectureUnderstanding, {
      includeDebug: true,
    });

    const architectureFlowPath = writeJson(
      path.join(jobDir, "architecture-flow.json"),
      architectureFlow
    );

    console.log("[architecture-flow]", {
      components: architectureFlow.stats.componentCount,
      relationships: architectureFlow.stats.relationshipCount,
      flowGroups: architectureFlow.stats.flowGroupCount,
      segments: architectureFlow.stats.segmentCount,
      chapters: architectureFlow.stats.chapterCount,
    });

    const architectureTeachingLlmClient = createArchitectureTeachingLlmClient();

    const architectureTeaching = await buildArchitectureTeaching(
    architectureUnderstanding,
    architectureFlow,
    {
        includeDebug: true,
        outputDir: jobDir,
        llmClient: architectureTeachingLlmClient,
    }
    );

    const architectureTeachingPath = writeJson(
      path.join(jobDir, "architecture-teaching.json"),
      architectureTeaching
    );

    console.log("[architecture-teaching]", {
      chapters: architectureTeaching.stats.chapterCount,
      segments: architectureTeaching.stats.segmentCount,
      narratableSegments: architectureTeaching.stats.narratableSegmentCount,
      nonNarratableSegments: architectureTeaching.stats.nonNarratableSegmentCount,
    });

    const lessonPlan = generateLessonPlan(jobDir);

    const outputPath = saveLessonPlan(jobDir, lessonPlan);

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
      spatialEntityGrounding: {
        version: spatialEntityGrounding.version,
        stats: spatialEntityGrounding.stats,
        output: spatialEntityGroundingPath,
      },
      architectureUnderstanding: {
        version: architectureUnderstanding.version,
        stats: architectureUnderstanding.stats,
        output: architectureUnderstandingPath,
      },
      architectureFlow: {
        version: architectureFlow.schemaVersion,
        stats: architectureFlow.stats,
        output: architectureFlowPath,
      },
      architectureTeaching: {
        version: architectureTeaching.schemaVersion,
        stats: architectureTeaching.stats,
        output: architectureTeachingPath,
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
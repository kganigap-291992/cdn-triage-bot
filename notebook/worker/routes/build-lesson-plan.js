// notebook/worker/routes/build-lesson-plan.js

const express = require("express");
const path = require("path");

const {
  buildDocumentUnderstanding,
} = require("../services/documentUnderstandingBuilder");

const {
  generateLessonPlan,
  saveLessonPlan,
} = require("../services/lessonPlanner");

const router = express.Router();

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
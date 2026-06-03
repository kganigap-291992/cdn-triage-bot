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
  buildArchitectureEvidence,
} = require("../services/architectureEvidenceExtractor");

const {
  buildTermResolutions,
} = require("../services/architectureEvidenceResolver");

const {
  buildBoundarySummary,
} = require("../services/architectureBoundaryTyping");

const {
  buildArchitectureUnderstanding,
} = require("../services/architectureUnderstandingBuilder");

const {
  buildArchitectureFlow,
} = require("../services/architectureFlowBuilder");

const {
  buildCanonicalTraversalRail,
} = require("../services/architectureCanonicalTraversalRailBuilder");

const {
  buildComponentUnderstanding,
} = require("../services/componentUnderstandingBuilder");

const {
  buildArchitectureIndustryKnowledge,
} = require("../services/architectureIndustryKnowledgeResolver");

const {
  buildArchitectureReasoning,
} = require("../services/architectureReasoningBuilder");

const {
  buildResponsibilityInference,
} = require("../services/responsibilityInferenceBuilder");

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

const {
  buildCalmExplainerNarration,
} = require("../services/calmExplainerNarrationBuilder");

const {
  buildArchitectureRailNarration,
} = require("../services/architectureRailNarrationBuilder");

const {
  buildNarrationContinuity,
} = require("../services/narrationContinuityBuilder");

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

function getRailNarrationTitle(rail = {}) {
  const labels = {
    primary_request_flow: "Primary Request Flow",
    cache_or_payload_delivery_flow: "Cache Delivery Flow",
    auth_validation_flow: "Auth / Validation Flow",
    bidirectional_sync_flow: "State / Synchronization Flow",
    observability_signal_flow: "Observability Flow",
    configuration_flow: "Configuration Flow",
  };

  return (
    rail.title ||
    labels[rail.flowLaneType] ||
    "Architecture Rail"
  );
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

    const extracted = readJson(path.join(jobDir, "extracted.json"), {});

    const documentUnderstanding = buildDocumentUnderstanding({ jobDir });

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

    const spatialUnderstanding = buildSpatialUnderstanding({ jobDir });

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

    const architectureEvidence = buildArchitectureEvidence({
      extracted,
      documentUnderstanding,
      documentStructure,
      spatialUnderstanding,
      spatialEntityGrounding,
      layoutBoxes,
    });

    const architectureEvidencePath = writeJson(
      path.join(jobDir, "architecture-evidence.json"),
      architectureEvidence
    );

    console.log("[architecture-evidence]", {
      glossaryTerms: architectureEvidence.stats.glossaryTermCount,
      legendItems: architectureEvidence.stats.legendItemCount,
      boundaryEvidence: architectureEvidence.stats.boundaryEvidenceCount,
      publicTerms: architectureEvidence.stats.publicTermCount,
      internalTerms: architectureEvidence.stats.internalTermCount,
      evidenceRecords: architectureEvidence.stats.evidenceRecordCount,
    });

    const architectureTermResolutions =
      buildTermResolutions(architectureEvidence);

    const architectureTermResolutionsPath = writeJson(
      path.join(jobDir, "architecture-term-resolutions.json"),
      architectureTermResolutions
    );

    console.log(
      "[architecture-term-resolutions]",
      architectureTermResolutions.stats
    );

    const architectureBoundaries = buildBoundarySummary(architectureEvidence);

    const architectureBoundariesPath = writeJson(
      path.join(jobDir, "architecture-boundaries.json"),
      architectureBoundaries
    );

    console.log("[architecture-boundaries]", architectureBoundaries.stats);

    const architectureUnderstanding = buildArchitectureUnderstanding(
      documentUnderstanding,
      spatialUnderstanding,
      {
        architectureEvidence,
        architectureTermResolutions,
      }
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
      architectureEvidence,
      architectureTermResolutions,
    });

    const architectureFlowPath = writeJson(
      path.join(jobDir, "architecture-flow.json"),
      architectureFlow
    );


    const canonicalTraversalRail = buildCanonicalTraversalRail({
      architectureUnderstanding,
      architectureFlow,
      architectureEvidence,
      architectureTermResolutions,
    });

    const canonicalTraversalRailPath = writeJson(
      path.join(jobDir, "canonical-traversal-rail.json"),
      canonicalTraversalRail
    );

    console.log("[canonical-traversal-rail]", {
      hops: canonicalTraversalRail.stats?.hopCount,
      selectedHops: canonicalTraversalRail.stats?.selectedHopCount,
      flowLanes: canonicalTraversalRail.stats?.flowLaneCount,
      sharedNodes: canonicalTraversalRail.stats?.sharedNodeCount,
      selectedFlowLaneId: canonicalTraversalRail.selectedFlowLaneId,
    });

    console.log("[architecture-flow]", {
      components: architectureFlow.stats.componentCount,
      relationships: architectureFlow.stats.relationshipCount,
      flowGroups: architectureFlow.stats.flowGroupCount,
      segments: architectureFlow.stats.segmentCount,
      chapters: architectureFlow.stats.chapterCount,
    });

    const architectureTeachingLlmClient = createArchitectureTeachingLlmClient();

    const componentUnderstanding = buildComponentUnderstanding({
      architectureUnderstanding,
      canonicalTraversalRail,
      glossaryTerms: architectureEvidence.glossaryTerms || [],
      evidenceRecords: architectureEvidence.evidenceRecords || [],
      outputDir: jobDir,
    });

    const componentUnderstandingPath = path.join(
      jobDir,
      "component-understanding.json"
    );

    console.log("[component-understanding]", componentUnderstanding.stats);

    const architectureIndustryKnowledge =
      await buildArchitectureIndustryKnowledge({
        componentUnderstanding,
        llmClient: architectureTeachingLlmClient,
        outputDir: jobDir,
      });

    const architectureIndustryKnowledgePath = path.join(
      jobDir,
      "architecture-industry-knowledge.json"
    );

    console.log("[architecture-industry-knowledge]", {
      allowed: architectureIndustryKnowledge.stats.allowedCount,
      blocked: architectureIndustryKnowledge.stats.blockedCount,
      llmValid: architectureIndustryKnowledge.stats.llmValidCount,
      fallback: architectureIndustryKnowledge.stats.fallbackUsedCount,
    });

    const architectureReasoning = buildArchitectureReasoning({
      architectureUnderstanding,
      architectureFlow,
      documentUnderstanding,
      architectureEvidence,
    });

    const architectureReasoningPath = writeJson(
      path.join(jobDir, "architecture-reasoning.json"),
      architectureReasoning
    );

    console.log("[architecture-reasoning]", {
      reasoningModes: architectureReasoning.reasoningModes.length,
      primaryLayers: architectureReasoning.primaryLayers.length,
      pathSummaries: architectureReasoning.pathSummaries.length,
      componentRoles: architectureReasoning.componentRoleExplanations.length,
    });

    const responsibilityInference = buildResponsibilityInference({
      architectureUnderstanding,
      architectureFlow,
      documentUnderstanding,
      architectureEvidence,
      architectureTermResolutions,
    });

    const responsibilityInferencePath = writeJson(
      path.join(jobDir, "responsibility-inference.json"),
      responsibilityInference
    );

    console.log("[responsibility-inference]", {
      components: responsibilityInference.stats.componentCount,
      relationships: responsibilityInference.stats.relationshipCount,
      segments: responsibilityInference.stats.segmentCount,
      known: responsibilityInference.stats.knownResponsibilityCount,
      unknown: responsibilityInference.stats.unknownResponsibilityCount,
    });


    const architectureTeaching = await buildArchitectureTeaching(
      architectureUnderstanding,
      architectureFlow,
      {
        includeDebug: true,
        outputDir: jobDir,
        llmClient: architectureTeachingLlmClient,
        responsibilityInference,
        architectureEvidence,
        architectureTermResolutions,
      }
    );

    const architectureTeachingPath = writeJson(
      path.join(jobDir, "architecture-teaching.json"),
      architectureTeaching
    );

    const calmExplainerNarration = await buildCalmExplainerNarration({
      architectureTeaching,
      llmClient: architectureTeachingLlmClient,
      outputDir: jobDir,
    });

    const railNarrationInputs = [
      canonicalTraversalRail.selectedWalkthrough
        ? {
            ...canonicalTraversalRail.selectedWalkthrough,
            id: "selected_canonical_walkthrough",
            title: "Canonical Request Journey",
            flowLaneId:
              canonicalTraversalRail.selectedWalkthrough.primaryFlowLaneId ||
              canonicalTraversalRail.selectedFlowLaneId ||
              "canonical_request_journey",
            flowLaneType: "canonical_request_journey",
            primaryRailType: "canonical_primary",
            promotionReason: "selected_canonical_request_journey",
            hops: (canonicalTraversalRail.hops || []).filter((hop) =>
              (canonicalTraversalRail.selectedWalkthrough.selectedHopIds || []).includes(
                hop.hopId
              )
            ),
          }
        : null,

      ...(canonicalTraversalRail.selectedPrimaryWalkthroughs || []).map(
        (rail) => ({
          ...rail,
          title: getRailNarrationTitle(rail),
        })
      ),
    ].filter(Boolean);

    const seenRailKeys = new Set();

    const dedupedRailNarrationInputs = railNarrationInputs.filter((rail) => {
      const key = [
        rail.flowLaneType,
        (rail.selectedHopIds || rail.hops?.map((hop) => hop.hopId) || []).join("|"),
      ].join(":");

      if (seenRailKeys.has(key)) return false;
      seenRailKeys.add(key);
      return true;
    });

    const architectureRailNarration =
      await buildArchitectureRailNarration({
        rails: dedupedRailNarrationInputs,
        llmClient: architectureTeachingLlmClient,
        outputDir: jobDir,
        componentUnderstanding,
        architectureIndustryKnowledge,
      });

    const architectureRailNarrationPath = path.join(
      jobDir,
      "architecture-rail-narration.json"
    );

    const calmExplainerNarrationPath = writeJson(
      path.join(jobDir, "calm-explainer-narration.json"),
      calmExplainerNarration
    );

    console.log("[architecture-teaching]", {
      chapters: architectureTeaching.stats.chapterCount,
      segments: architectureTeaching.stats.segmentCount,
      narratableSegments: architectureTeaching.stats.narratableSegmentCount,
      nonNarratableSegments:
        architectureTeaching.stats.nonNarratableSegmentCount,
    });

    console.log("[architecture-rail-narration]", {
      rails: architectureRailNarration.railCount,
      fallbackUsed:
        architectureRailNarration.stats.fallbackUsedCount,
      llmValid:
        architectureRailNarration.stats.llmValidCount,
    });

    const lessonPlan = generateLessonPlan(jobDir);

    const outputPath = saveLessonPlan(jobDir, lessonPlan);

    const narrationContinuity = buildNarrationContinuity({
      lessonGraph: lessonPlan?.lessonGraph,
      architectureReasoning,
      calmExplainerNarration,
    });

    const narrationContinuityPath = writeJson(
      path.join(jobDir, "narration-continuity.json"),
      narrationContinuity
    );

    console.log("[narration-continuity]", {
      scenes: narrationContinuity.sceneCount,
      regions: narrationContinuity.stats.regionCount,
      concepts: narrationContinuity.stats.conceptCount,
      handoffs: narrationContinuity.stats.handoffCount,
    });

    const architectureTeachingRegions = Array.isArray(
      lessonPlan?.lessonGraph?.architectureTeachingRegions
    )
      ? lessonPlan.lessonGraph.architectureTeachingRegions
      : [];

    const regionTeachingPath = writeJson(
      path.join(jobDir, "region-teaching.json"),
      {
        version: "region-teaching-v1",
        source: "lessonGraphBuilder",
        regionCount: architectureTeachingRegions.length,
        regions: architectureTeachingRegions,
      }
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
      spatialEntityGrounding: {
        version: spatialEntityGrounding.version,
        stats: spatialEntityGrounding.stats,
        output: spatialEntityGroundingPath,
      },
      architectureEvidence: {
        version: architectureEvidence.version,
        stats: architectureEvidence.stats,
        output: architectureEvidencePath,
      },
      architectureTermResolutions: {
        version: architectureTermResolutions.version,
        stats: architectureTermResolutions.stats,
        output: architectureTermResolutionsPath,
      },
      architectureBoundaries: {
        version: architectureBoundaries.version,
        stats: architectureBoundaries.stats,
        output: architectureBoundariesPath,
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

      canonicalTraversalRail: {
        version: canonicalTraversalRail.version,
        stats: canonicalTraversalRail.stats,
        output: canonicalTraversalRailPath,
      },

      componentUnderstanding: {
        version: componentUnderstanding.version,
        stats: componentUnderstanding.stats,
        output: componentUnderstandingPath,
      },

      architectureIndustryKnowledge: {
        version: architectureIndustryKnowledge.version,
        stats: architectureIndustryKnowledge.stats,
        output: architectureIndustryKnowledgePath,
      },

      architectureReasoning: {
        version: architectureReasoning.version,
        stats: architectureReasoning.stats,
        output: architectureReasoningPath,
      },
      responsibilityInference: {
        version: responsibilityInference.version,
        stats: responsibilityInference.stats,
        output: responsibilityInferencePath,
      },
      architectureTeaching: {
        version: architectureTeaching.schemaVersion,
        stats: architectureTeaching.stats,
        output: architectureTeachingPath,
      },
      calmExplainerNarration: {
        version: calmExplainerNarration.version,
        stats: calmExplainerNarration.stats,
        output: calmExplainerNarrationPath,
      },

      architectureRailNarration: {
        version: architectureRailNarration.version,
        stats: architectureRailNarration.stats,
        output: architectureRailNarrationPath,
      },

      narrationContinuity: {
        version: narrationContinuity.version,
        stats: narrationContinuity.stats,
        output: narrationContinuityPath,
      },
      sectionCount: lessonPlan.lessonStructure.length,
      conceptCount: lessonPlan.prioritizedConcepts.length,
      output: outputPath,
      regionTeachingOutput: regionTeachingPath,
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
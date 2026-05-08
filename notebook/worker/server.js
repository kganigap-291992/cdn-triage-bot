// notebook/worker/server.js

require("dotenv").config();

const express = require("express");

const uploadRouter = require("./routes/upload");
const extractRouter = require("./routes/extract");
const statusRouter = require("./routes/status");
const renderPagesRouter = require("./routes/render-pages");
const analyzeDiagramsRouter = require("./routes/analyze-diagrams");
const extractConceptsRouter = require("./routes/extract-concepts");
const buildLessonPlanRouter = require("./routes/build-lesson-plan");
const generateDialogueRouter = require("./routes/generate-dialogue");
const generateAudioRouter = require("./routes/generate-audio");
const buildAudioManifestRouter = require("./routes/build-audio-manifest");
const buildRenderPlanRouter = require("./routes/build-render-plan");
const renderVideoRouter = require("./routes/render-video");

const app = express();

const PORT = process.env.PORT || 4001;

app.use(express.json());

app.use("/training-api/upload", uploadRouter);

app.use("/training-api/extract", extractRouter);

app.use("/training-api/status", statusRouter);

app.use("/training-api/render-pages", renderPagesRouter);

app.use(
  "/training-api/analyze-diagrams",
  analyzeDiagramsRouter
);

app.use(
  "/training-api/extract-concepts",
  extractConceptsRouter
);

app.use(
  "/training-api/build-lesson-plan",
  buildLessonPlanRouter
);

app.use(
  "/training-api/generate-dialogue",
  generateDialogueRouter
);

app.use(
  "/training-api/generate-audio",
  generateAudioRouter
);

app.use(
  "/training-api/build-audio-manifest",
  buildAudioManifestRouter
);

app.use(
  "/training-api/build-render-plan",
  buildRenderPlanRouter
);

app.use(
  "/training-api/render-video",
  renderVideoRouter
);

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "cachey-notebook-worker",
    status: "healthy",
    timestamp: new Date().toISOString(),
  });
});

app.listen(PORT, () => {
  console.log(
    `Cachey Notebook Worker running on port ${PORT}`
  );
});
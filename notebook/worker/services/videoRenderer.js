const path = require("path");
const fs = require("fs");

const { bundle } = require("@remotion/bundler");

const {
  renderMedia,
  selectComposition,
} = require("@remotion/renderer");

const FPS = 30;

function msToFrames(ms) {
  return Math.max(1, Math.round((ms / 1000) * FPS));
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function copyIfExists(sourcePath, targetPath) {
  if (!sourcePath || !fs.existsSync(sourcePath)) return null;

  ensureDir(path.dirname(targetPath));
  fs.copyFileSync(sourcePath, targetPath);

  return targetPath;
}

function preparePublicAssets(jobDir, renderPlan) {
  const jobId = path.basename(jobDir);

  const publicJobDir = path.join(
    __dirname,
    "../remotion/public/jobs",
    jobId
  );

  const audioPublicDir = path.join(publicJobDir, "audio");
  const pageImagesPublicDir = path.join(publicJobDir, "page-images");

  return {
    ...renderPlan,
    scenes: renderPlan.scenes.map((scene) => {
      let audioPath = null;
      let pageImagePath = null;

      if (scene.audioPath) {
        const sourceAudioPath = path.resolve(scene.audioPath);
        const audioFile = scene.audioFile || path.basename(sourceAudioPath);
        const targetAudioPath = path.join(audioPublicDir, audioFile);

        copyIfExists(sourceAudioPath, targetAudioPath);

        audioPath = `jobs/${jobId}/audio/${audioFile}`;
      }

      if (scene.pageImagePath) {
        const sourceImagePath = path.resolve(scene.pageImagePath);
        const pageImageFile =
          scene.pageImageFile || path.basename(sourceImagePath);
        const targetImagePath = path.join(
          pageImagesPublicDir,
          pageImageFile
        );

        copyIfExists(sourceImagePath, targetImagePath);

        pageImagePath = `jobs/${jobId}/page-images/${pageImageFile}`;
      }

      return {
        ...scene,
        audioPath,
        pageImagePath,
      };
    }),
  };
}

async function renderVideo(jobDir) {
  const renderPlanPath = path.join(
    jobDir,
    "renderPlan.json"
  );

  if (!fs.existsSync(renderPlanPath)) {
    throw new Error(
      `Missing renderPlan.json at ${renderPlanPath}`
    );
  }

  const rawRenderPlan = JSON.parse(
    fs.readFileSync(renderPlanPath, "utf8")
  );

  const renderPlan = preparePublicAssets(
    jobDir,
    rawRenderPlan
  );

  const totalFrames = renderPlan.scenes.reduce(
    (sum, scene) =>
      sum + msToFrames(scene.estimatedDurationMs),
    0
  );

  const bundled = await bundle({
    entryPoint: path.join(
      __dirname,
      "../remotion/index.js"
    ),
    publicDir: path.join(__dirname, "../remotion/public"),
  });

  const composition = await selectComposition({
    serveUrl: bundled,
    id: "CacheyNotebookVideo",
    inputProps: {
      renderPlan,
      totalFrames,
    },
  });

  const outputPath = path.join(
    jobDir,
    "notebook-video.mp4"
  );

  await renderMedia({
    composition: {
      ...composition,
      durationInFrames: totalFrames,
      fps: FPS,
    },
    serveUrl: bundled,
    codec: "h264",
    outputLocation: outputPath,
    inputProps: {
      renderPlan,
      totalFrames,
    },
  });

  return {
    outputPath,
    totalFrames,
    sceneCount: renderPlan.scenes.length,
  };
}

module.exports = {
  renderVideo,
};
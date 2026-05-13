const fs = require("fs");
const path = require("path");

function listPageImages(jobDir) {
  const pageImagesDir = path.join(jobDir, "page-images");

  if (!fs.existsSync(pageImagesDir)) {
    return [];
  }

  return fs
    .readdirSync(pageImagesDir)
    .filter((fileName) => /\.(png|jpg|jpeg|webp)$/i.test(fileName))
    .sort()
    .map((fileName, index) => ({
      page: index + 1,
      fileName,
      path: path.join(pageImagesDir, fileName),
    }));
}

function buildSpatialUnderstanding({ jobDir }) {
  const pageImages = listPageImages(jobDir);

  const pages = pageImages.map((pageImage) => ({
    page: pageImage.page,
    imageFileName: pageImage.fileName,
    imagePath: pageImage.path,

    labels: [],
    regions: [],
    connectors: [],
    readingOrder: [],
    focusCandidates: [],
    relationships: [],
  }));

  return {
    version: "spatial-understanding-v1",
    source: "page-images",
    ocrUsed: false,
    layoutModelUsed: false,
    pages,
    stats: {
      pageCount: pages.length,
      labelCount: 0,
      regionCount: 0,
      connectorCount: 0,
      relationshipCount: 0,
      focusCandidateCount: 0,
    },
    notes: [
      "V1 scaffold only. Future versions may populate labels/regions/connectors using OCR and layout analysis.",
    ],
  };
}

function saveSpatialUnderstanding(jobDir, spatialUnderstanding) {
  const outputPath = path.join(jobDir, "spatial-understanding.json");
  fs.writeFileSync(outputPath, JSON.stringify(spatialUnderstanding, null, 2), "utf8");
  return outputPath;
}

module.exports = {
  buildSpatialUnderstanding,
  saveSpatialUnderstanding,
};
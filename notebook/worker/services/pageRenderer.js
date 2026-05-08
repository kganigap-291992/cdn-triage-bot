// notebook/worker/services/pageRenderer.js

const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);

function ensurePageImageDir(jobDir) {
  const pageImageDir = path.join(jobDir, "page-images");

  if (!fs.existsSync(pageImageDir)) {
    fs.mkdirSync(pageImageDir, { recursive: true });
  }

  return pageImageDir;
}

function getPageImagePath(jobDir, pageNumber) {
  const pageImageDir = ensurePageImageDir(jobDir);

  return path.join(pageImageDir, `page-${pageNumber}.png`);
}

async function renderPdfPages(pdfPath, jobDir) {
  const outputDir = ensurePageImageDir(jobDir);
  const outputPrefix = path.join(outputDir, "page");

  await execFileAsync("pdftoppm", [
    "-png",
    "-r",
    "144",
    pdfPath,
    outputPrefix,
  ]);

  const renderedFiles = fs
    .readdirSync(outputDir)
    .filter((file) => file.endsWith(".png"))
    .sort();

  return renderedFiles.map((file) => ({
    fileName: file,
    path: path.join(outputDir, file),
  }));
}

module.exports = {
  ensurePageImageDir,
  getPageImagePath,
  renderPdfPages,
};
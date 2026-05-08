// notebook/worker/services/jobManager.js

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const TEMP_ROOT = path.join(__dirname, "..", "temp");

function ensureTempRoot() {
  if (!fs.existsSync(TEMP_ROOT)) {
    fs.mkdirSync(TEMP_ROOT, { recursive: true });
  }
}

function createJob() {
  ensureTempRoot();

  const jobId = `job_${crypto.randomUUID()}`;
  const jobDir = path.join(TEMP_ROOT, jobId);

  fs.mkdirSync(jobDir, { recursive: true });

  return {
    jobId,
    jobDir,
    inputPdfPath: path.join(jobDir, "input.pdf"),
  };
}

function getJobDir(jobId) {
  return path.join(TEMP_ROOT, jobId);
}

module.exports = {
  TEMP_ROOT,
  createJob,
  getJobDir,
};
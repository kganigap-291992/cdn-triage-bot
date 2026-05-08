// notebook/worker/routes/upload.js

const express = require("express");
const multer = require("multer");

const { createJob } = require("../services/jobManager");

const router = express.Router();

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      const job = createJob();
      _req.cacheyNotebookJob = job;
      cb(null, job.jobDir);
    },
    filename: (_req, _file, cb) => {
      cb(null, "input.pdf");
    },
  }),
  fileFilter: (_req, file, cb) => {
    if (file.mimetype !== "application/pdf") {
      cb(new Error("Only PDF uploads are supported"));
      return;
    }

    cb(null, true);
  },
  limits: {
    fileSize: 25 * 1024 * 1024,
  },
});

router.post("/", upload.single("file"), (req, res) => {
  const job = req.cacheyNotebookJob;

  if (!req.file || !job) {
    return res.status(400).json({
      ok: false,
      error: "No PDF file uploaded",
    });
  }

  res.json({
    ok: true,
    jobId: job.jobId,
    fileName: req.file.originalname,
    storedAs: "input.pdf",
    status: "uploaded",
  });
});

module.exports = router;
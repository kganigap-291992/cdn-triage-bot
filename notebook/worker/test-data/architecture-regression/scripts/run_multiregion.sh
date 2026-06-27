#!/usr/bin/env bash
set -euo pipefail

JOB_ID="${1:-regression_multiregion_01}"
PDF="test-data/architecture-regression/multiregion/cachey_multiregion_architecture_sample_02.pdf"

mkdir -p "temp/$JOB_ID"
cp "$PDF" "temp/$JOB_ID/input.pdf"

echo "JOB_ID=$JOB_ID"
echo "PDF copied to temp/$JOB_ID/input.pdf"

echo "Now run your normal PDF ingestion/extraction flow for this JOB_ID."
echo "After extraction, run:"
echo "curl -s -X POST http://localhost:4001/training-api/build-lesson-plan/$JOB_ID > /tmp/build.out"
echo "cat temp/$JOB_ID/learning-chapters.json | jq '.stats,.health'"

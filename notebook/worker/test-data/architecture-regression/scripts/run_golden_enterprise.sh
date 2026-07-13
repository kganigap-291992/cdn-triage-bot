#!/usr/bin/env bash
set -euo pipefail

JOB_ID="${1:-golden_enterprise_v1}"
PDF="test-data/architecture-regression/golden-enterprise/cachey_golden_enterprise_architecture_v1.pdf"

mkdir -p "temp/$JOB_ID"
cp "$PDF" "temp/$JOB_ID/input.pdf"

echo "JOB_ID=$JOB_ID"
echo "PDF copied to temp/$JOB_ID/input.pdf"

echo "Now run your normal PDF ingestion/extraction flow for this JOB_ID."
echo "After extraction, run:"
echo "curl -s -X POST http://localhost:4001/training-api/build-lesson-plan/$JOB_ID > /tmp/build.out"
echo "cat temp/$JOB_ID/enterprise-topology.json | jq '.stats,.health,.deploymentPatternCandidates'"

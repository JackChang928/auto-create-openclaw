#!/usr/bin/env bash
# create-deployment.sh — Register a GitHub Deployment, emit deployment_id to GITHUB_OUTPUT
set -euo pipefail

ENVIRONMENT="${1}"
REF="${2:-${GITHUB_REF_NAME:-main}}"
DESCRIPTION="${3:-Deployment}"
REPO="${GITHUB_REPOSITORY}"

DEPLOYMENT_ID=$(gh api "repos/${REPO}/deployments" \
  --field "environment=${ENVIRONMENT}" \
  --field "description=${DESCRIPTION}" \
  --field "ref=${REF}" \
  --field "auto_merge=false" \
  --jq '.id')

echo "deployment_id=${DEPLOYMENT_ID}" >> "$GITHUB_OUTPUT"

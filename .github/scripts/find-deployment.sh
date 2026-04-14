#!/usr/bin/env bash
# find-deployment.sh — Find the most recent deployment ID for a given environment and ref
set -euo pipefail

ENVIRONMENT="${1}"
TARGET_REF="${2:-${GITHUB_REF:-}}"
REPO="${GITHUB_REPOSITORY}"

# Escape special characters in TARGET_REF for jq
ESCAPED_REF="${TARGET_REF//\//\\\/}"

DEPLOYMENT_ID=$(gh api "repos/${REPO}/deployments" \
  --environment "${ENVIRONMENT}" \
  --jq ".[] | select(.ref == \"${ESCAPED_REF}\") | .id" 2>/dev/null | head -1 || true)

if [ -z "${DEPLOYMENT_ID}" ]; then
  # Fallback: get most recent deployment for this environment
  DEPLOYMENT_ID=$(gh api "repos/${REPO}/deployments" \
    --environment "${ENVIRONMENT}" \
    --jq '.[0].id' 2>/dev/null || true)
fi

echo "deployment_id=${DEPLOYMENT_ID:-}"
[ -n "${DEPLOYMENT_ID}" ] && echo "deployment_id=${DEPLOYMENT_ID}" >> "$GITHUB_OUTPUT"

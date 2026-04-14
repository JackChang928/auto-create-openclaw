#!/usr/bin/env bash
# update-deployment-status.sh — Update a GitHub Deployment status
set -euo pipefail

DEPLOYMENT_ID="${1}"
STATE="${2}"            # error | failure | inactive | in_progress | pending | queued | success | waiting
ENVIRONMENT_URL="${3:-}"
DESCRIPTION="${4:-}"

REPO="${GITHUB_REPOSITORY}"

CMD=(gh api "repos/${REPO}/deployments/${DEPLOYMENT_ID}/statuses" --field "state=${STATE}")
[ -n "${ENVIRONMENT_URL}" ] && CMD+=(--field "environment_url=${ENVIRONMENT_URL}")
[ -n "${DESCRIPTION}" ]    && CMD+=(--field "description=${DESCRIPTION}")

"${CMD[@]}"

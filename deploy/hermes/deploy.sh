#!/usr/bin/env bash
# deploy/hermes/deploy.sh — Hermes Agent 部署腳本
# 用於將 Hermes Agent 部署到生產/ staging 環境
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
IMAGE_TAG="${1:-latest}"
ENV_FILE="${2:-${SCRIPT_DIR}/.env.hermes.prod}"

echo "============================================"
echo "  Hermes Agent Deploy — v${IMAGE_TAG}"
echo "============================================"
echo "Image: ghcr.io/jackchang928/auto-create-openclaw-hermes:${IMAGE_TAG}"
echo "Env:   ${ENV_FILE}"
echo ""

# ── Pre-flight checks ─────────────────────────────────────────
if [ ! -f "${ENV_FILE}" ]; then
    echo "ERROR: Environment file not found: ${ENV_FILE}"
    echo "Please copy .env.hermes.prod.example to .env.hermes.prod and configure it."
    exit 1
fi

# ── Load environment ──────────────────────────────────────────
set -a
source "${ENV_FILE}"
set +a

# ── Image build（本地開發時使用）───────────────────────────────
build_local() {
    echo ">> Building Hermes Docker image locally..."
    docker build \
        -t "ghcr.io/jackchang928/auto-create-openclaw-hermes:${IMAGE_TAG}" \
        -f "${SCRIPT_DIR}/Dockerfile" \
        "${SCRIPT_DIR}"
    echo ">> Build complete"
}

# ── Pull from GHCR ────────────────────────────────────────────
pull_remote() {
    echo ">> Pulling image from GHCR..."
    echo "${GITHUB_TOKEN}" | docker login ghcr.io -u="${GITHUB_ACTOR}" --password-stdin
    docker pull "ghcr.io/jackchang928/auto-create-openclaw-hermes:${IMAGE_TAG}"
    echo ">> Pull complete"
}

# ── Deploy via docker compose ─────────────────────────────────
deploy() {
    local COMPOSE_FILE="${SCRIPT_DIR}/docker-compose.hermes.yml"
    local COMPOSE_CMD="docker compose -f ${COMPOSE_FILE}"

    if [ -t 0 ]; then
        # Interactive terminal — use detach
        ${COMPOSE_CMD} up -d --pull always
    else
        # CI/non-interactive — explicit pull first
        pull_remote || build_local
        ${COMPOSE_CMD} up -d
    fi

    echo ""
    echo ">> Hermes Agent deployed!"
    echo ">> Gateway: http://localhost:${HERMES_PORT:-18790}"
    echo ">> Health:  http://localhost:${HERMES_PORT:-18790}/health"
    echo ""
    docker compose -f "${COMPOSE_FILE}" ps
}

# ── Health check ───────────────────────────────────────────────
health_check() {
    local PORT="${HERMES_PORT:-18790}"
    local MAX_RETRIES=30
    local RETRY_INTERVAL=5

    echo ">> Waiting for Hermes to be ready (port ${PORT})..."
    for i in $(seq 1 ${MAX_RETRIES}); do
        if curl -sf "http://localhost:${PORT}/health" > /dev/null 2>&1; then
            echo "✅ Hermes Agent is healthy!"
            return 0
        fi
        echo "   Attempt ${i}/${MAX_RETRIES} — not ready yet..."
        sleep ${RETRY_INTERVAL}
    done

    echo "❌ Hermes Agent health check failed after ${MAX_RETRIES} attempts"
    echo ">> Container logs:"
    docker compose -f "${SCRIPT_DIR}/docker-compose.hermes.yml" logs --tail=30
    return 1
}

# ── Main ───────────────────────────────────────────────────────
case "${1:-deploy}" in
    build)
        build_local
        ;;
    pull)
        pull_remote
        ;;
    deploy|up)
        deploy
        health_check
        ;;
    down|stop)
        docker compose -f "${SCRIPT_DIR}/docker-compose.hermes.yml" down
        ;;
    restart)
        docker compose -f "${SCRIPT_DIR}/docker-compose.hermes.yml" restart
        health_check
        ;;
    logs)
        docker compose -f "${SCRIPT_DIR}/docker-compose.hermes.yml" logs -f --tail=50
        ;;
    status)
        docker compose -f "${SCRIPT_DIR}/docker-compose.hermes.yml" ps
        ;;
    *)
        echo "Usage: $0 {deploy|build|pull|down|restart|logs|status} [image_tag] [.env file]"
        echo ""
        echo "Examples:"
        echo "  $0 deploy                        # Deploy latest, using default .env"
        echo "  $0 deploy v1.2.3                 # Deploy specific tag"
        echo "  $0 deploy latest /path/to/.env    # Custom env file"
        exit 1
        ;;
esac

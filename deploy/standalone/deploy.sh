#!/usr/usr/bin/env bash
# deploy.sh — One-click standalone deployment for OpenClaw or Hermes Agent
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# ── Colors ────────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
info()  { echo -e "${CYAN}ℹ${NC}  $*"; }
ok()    { echo -e "${GREEN}✅${NC} $*"; }
warn()  { echo -e "${YELLOW}⚠${NC}  $*"; }
fail()  { echo -e "${RED}❌${NC} $*"; exit 1; }

# ── Parse arguments ───────────────────────────────────────────────────────────
AGENT_TYPE="openclaw"
while [[ $# -gt 0 ]]; do
    case "$1" in
        --hermes|-h)
            AGENT_TYPE="hermes"; shift ;;
        --openclaw|-o)
            AGENT_TYPE="openclaw"; shift ;;
        --help)
            echo "Usage: $0 [--hermes|--openclaw] [.env file]"
            echo ""
            echo "  --hermes, -h     Deploy Hermes Agent instead of OpenClaw"
            echo "  --openclaw, -o   Deploy OpenClaw (default)"
            echo "  .env file        Custom env file (default: .env or .env.example)"
            exit 0 ;;
        *)
            ENV_FILE="$1"; shift ;;
    esac
done

# ── Docker check ─────────────────────────────────────────────────────────────
if ! command -v docker &>/dev/null; then
    fail "找不到 docker 指令，請先安裝 Docker"
fi

# ── OpenClaw Deployment ───────────────────────────────────────────────────────
deploy_openclaw() {
    info "部署 OpenClaw 獨立版..."

    if [ ! -f .env ]; then
        if [ -f .env.example ]; then
            cp .env.example .env
            warn ".env 不存在，已從 .env.example 複製。請編輯 .env 後重新執行。"
            exit 1
        fi
    fi

    source .env 2>/dev/null || true

    if [ -z "${OPENAI_API_KEY:-}" ] || [ "$OPENAI_API_KEY" = "sk-xxxx-xxxx-xxxx" ]; then
        warn "請在 .env 中填入真實的 OPENAI_API_KEY。"
        exit 1
    fi

    docker compose up -d --build 2>&1 | tail -5
    sleep 5

    CONTAINER="openclaw-standalone"
    if docker ps --format '{{.Names}}' | grep -q "^${CONTAINER}$"; then
        ok "容器已啟動 (${CONTAINER})"
    else
        warn "容器未就緒，請執行 'docker compose logs -f' 排查問題"
    fi

    echo ""
    echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    ok "OpenClaw 部署完成！"
    echo "查看日誌：  docker compose logs -f"
    echo "停止服務：  docker compose down"
    echo "重啟服務：  docker compose restart"
    echo ""
    echo "OpenClaw Gateway：http://localhost:${HOST_PORT:-18789}"
    echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
}

# ── Hermes Deployment ─────────────────────────────────────────────────────────
deploy_hermes() {
    info "部署 Hermes Agent..."

    local HERMES_DIR="$(cd "${SCRIPT_DIR}/../hermes" && pwd)"

    if [ ! -f "${HERMES_DIR}/.env.hermes.prod" ]; then
        if [ -f "${HERMES_DIR}/.env.hermes.prod.example" ]; then
            cp "${HERMES_DIR}/.env.hermes.prod.example" "${HERMES_DIR}/.env.hermes.prod"
            warn ".env.hermes.prod 不存在，已從範例複製。請編輯後重新執行。"
            exit 1
        fi
    fi

    source "${HERMES_DIR}/.env.hermes.prod" 2>/dev/null || true

    docker compose -f "${HERMES_DIR}/docker-compose.hermes.yml" up -d 2>&1 | tail -5
    sleep 5

    CONTAINER="hermes-agent"
    if docker ps --format '{{.Names}}' | grep -q "^${CONTAINER}$"; then
        ok "容器已啟動 (${CONTAINER})"
    else
        warn "容器未就緒，請執行 'docker compose -f ${HERMES_DIR}/docker-compose.hermes.yml logs -f' 排查"
    fi

    echo ""
    echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    ok "Hermes Agent 部署完成！"
    echo "查看日誌：  docker compose -f ${HERMES_DIR}/docker-compose.hermes.yml logs -f"
    echo "停止服務：  docker compose -f ${HERMES_DIR}/docker-compose.hermes.yml down"
    echo "重啟服務：  docker compose -f ${HERMES_DIR}/docker-compose.hermes.yml restart"
    echo ""
    echo "Hermes Gateway：http://localhost:${HERMES_PORT:-18790}"
    echo "Hermes Health： http://localhost:${HERMES_PORT:-18790}/health"
    echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
}

# ── Main ─────────────────────────────────────────────────────────────────────
case "${AGENT_TYPE}" in
    hermes)   deploy_hermes ;;
    openclaw) deploy_openclaw ;;
esac

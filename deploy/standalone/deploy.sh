#!/usr/bin/env bash
# deploy.sh — One-click standalone deployment for OpenClaw
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# ── Colors ────────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
info()  { echo -e "${CYAN}ℹ${NC}  $*"; }
ok()    { echo -e "${GREEN}✅${NC} $*"; }
warn()  { echo -e "${YELLOW}⚠${NC}  $*"; }
fail()  { echo -e "${RED}❌${NC} $*"; exit 1; }

# ── Pre-flight: .env ─────────────────────────────────────────────────────────
if [ ! -f .env ]; then
  if [ -f .env.example ]; then
    cp .env.example .env
    warn ".env 不存在，已從 .env.example 複製。請編輯 .env 填入真實的 API Key 後重新執行。"
    exit 1
  else
    fail "找不到 .env 或 .env.example，請先建立 .env 檔案。"
  fi
fi

source .env 2>/dev/null || true

# ── Validate required variables ───────────────────────────────────────────────
if [ -z "${OPENAI_API_KEY:-}" ] || [ "$OPENAI_API_KEY" = "sk-xxxx-xxxx-xxxx" ]; then
  warn "請在 .env 中填入真實的 OPENAI_API_KEY 後重新執行。"
  exit 1
fi

ok ".env 檢查通過"

# ── Docker check ─────────────────────────────────────────────────────────────
if ! command -v docker &>/dev/null; then
  fail "找不到 docker 指令，請先安裝 Docker (https://docs.docker.com/get-docker/)"
fi

# ── Build & Start ────────────────────────────────────────────────────────────
info "建置並啟動 OpenClaw 獨立版容器..."
docker compose up -d --build 2>&1 | tail -5

# ── Wait for container to initialise ─────────────────────────────────────────
info "等待容器啟動..."
sleep 5

CONTAINER="openclaw-standalone"
if docker ps --format '{{.Names}}' | grep -q "^${CONTAINER}$"; then
  ok "容器已啟動 (${CONTAINER})"
else
  warn "容器未就緒，請執行 'docker compose logs -f' 排查問題"
fi

# ── Status ───────────────────────────────────────────────────────────────────
echo ""
echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
ok "部署完成！"
echo ""
echo "查看日誌：  docker compose logs -f"
echo "停止服務：  docker compose down"
echo "重啟服務：  docker compose restart"
echo ""
echo "OpenClaw Gateway 預設運行於：http://localhost:${HOST_PORT:-18789}"
echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"

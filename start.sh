#!/usr/bin/env bash
# start.sh — One-click startup for Auto-Create OpenClaw (WSL/Linux)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# ── Colors ──────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
info()  { echo -e "${CYAN}ℹ${NC}  $*"; }
ok()    { echo -e "${GREEN}✅${NC} $*"; }
warn()  { echo -e "${YELLOW}⚠${NC}  $*"; }
fail()  { echo -e "${RED}❌${NC} $*"; exit 1; }

# ── 1. Check .env ──────────────────────────────────────────────────────────
if [ ! -f .env ]; then
  if [ -f .env.example ]; then
    cp .env.example .env
    warn ".env 不存在，已從 .env.example 複製。請編輯 .env 填入真實的 API Key 後重新執行此腳本。"
    exit 1
  else
    fail "找不到 .env 或 .env.example，請先建立 .env 檔案。"
  fi
fi

# Quick sanity check: OPENAI_API_KEY should not be the placeholder
source .env 2>/dev/null || true
if [ "${OPENAI_API_KEY:-}" = "your-openai-key-here" ] || [ -z "${OPENAI_API_KEY:-}" ]; then
  warn "請在 .env 中填入真實的 OPENAI_API_KEY 後重新執行。"
  exit 1
fi

ok ".env 檢查通過"

# ── 2. npm install ─────────────────────────────────────────────────────────
info "安裝 Node.js 依賴..."
npm install --no-fund --no-audit
ok "npm install 完成"

# ── 3. Docker Compose ──────────────────────────────────────────────────────
if ! command -v docker &>/dev/null; then
  fail "找不到 docker 指令，請先安裝 Docker。"
fi

info "建置 OpenClaw 自訂基礎映像檔 (包含 uv, python, ffmpeg)..."
docker build -t auto-create-openclaw-base:latest -f Dockerfile.openclaw .
ok "基礎映像檔建置完成"

info "啟動基礎設施 (docker-compose up -d --build)..."
docker compose up -d 2>&1 | tail -5
ok "Docker Compose 啟動完成"

# ── 4. Wait for services ──────────────────────────────────────────────────


# ── 5. Start Provisioner (server.js) ──────────────────────────────────────
echo ""
info "啟動 Provisioner (server.js)..."
echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
exec node server.js

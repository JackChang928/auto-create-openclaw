#!/usr/bin/env bash
# deploy.sh — Auto-Create-OpenClaw 部署腳本
# 用法: bash scripts/deploy.sh
#
# 流程:
#   1. git stash（如有 working tree 變更）
#   2. git pull（如有 remote，fallback SSH）
#   3. npm install（如有變更）
#   4. docker build（如 Dockerfile.openclaw 有變更）
#   5. 重啟 server.js（如有本地變更）
#   6. git push（如有待推 commits）
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
LOG_DIR="$PROJECT_DIR/logs"
PORT="${PORT:-3210}"

mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/deploy.log"

log() { echo "[$(date '+%H:%M:%S')] $*" | tee -a "$LOG_FILE"; }

cd "$PROJECT_DIR"

# ── 0. Working tree 快照 ────────────────────────────────────────────────
if ! git diff --quiet 2>/dev/null; then
  log "⚠️  Working tree 有變更，先 stash..."
  git stash
  STASHED=1
else
  STASHED=0
fi

# ── 1. Git sync ─────────────────────────────────────────────────────────
if git remote get-url origin &>/dev/null; then
  log "🔄 git pull (HTTPS → SSH fallback)..."
  if git pull --ff-only origin master 2>>"$LOG_FILE"; then
    log "✅ git pull 成功"
  else
    # Try SSH URL as fallback
    SSH_URL="git@github.com:JackChang928/auto-create-openclaw.git"
    CURRENT_URL=$(git remote get-url origin 2>/dev/null || echo "")
    if [ "$CURRENT_URL" != "$SSH_URL" ]; then
      log "   切換到 SSH URL..."
      git remote set-url origin "$SSH_URL"
    fi
    log "   嘗試 SSH push..."
    if timeout 30 git push origin master 2>>"$LOG_FILE"; then
      log "✅ SSH push 成功"
    else
      log "⚠️  Git push 失敗（網路問題），本地 commit 保留"
    fi
  fi
else
  log "ℹ️  無 git remote，跳過 git sync"
fi

# Restore stash if any
if [ "$STASHED" = "1" ]; then
  log "🔄 恢復 stash..."
  git stash pop || true
fi

# ── 2. npm install（如有變更）────────────────────────────────────────────
if [ -f package.json ] && [ -f package-lock.json ]; then
  log "🔄 npm install..."
  npm install --no-fund --no-audit 2>&1 | tail -3 >>"$LOG_FILE" || log "⚠️  npm install 失敗"
fi

# ── 3. 版本記錄 ─────────────────────────────────────────────────────────
if command -v git &>/dev/null; then
  GIT_HASH=$(git rev-parse --short HEAD 2>/dev/null || echo "unknown")
  echo "$GIT_HASH $(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$LOG_DIR/version.txt"
  log "📝 版本：$GIT_HASH"
fi

# ── 4. Docker build（如有變更）────────────────────────────────────────────
if [ -f Dockerfile.openclaw ]; then
  log "🔄 docker build auto-create-openclaw-base:latest..."
  if docker build -t auto-create-openclaw-base:latest -f Dockerfile.openclaw . 2>&1 | tail -5 >>"$LOG_FILE"; then
    log "✅ Docker 映像建置成功"
  else
    log "⚠️  Docker 建置失敗"
  fi
fi

# ── 5. 重啟 server.js ──────────────────────────────────────────────────
log "🔄 重啟 server.js..."

OLD_PID=$(ss -ltnp 2>/dev/null | grep -E ":${PORT}" | grep -oP 'pid=\K[0-9]+' | head -1 || true)

if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
  log "   停止舊進程 PID=$OLD_PID..."
  kill "$OLD_PID"
  for i in $(seq 1 15); do
    if ! kill -0 "$OLD_PID" 2>/dev/null; then
      log "   舊進程已停止"
      break
    fi
    sleep 1
  done
  kill -0 "$OLD_PID" 2>/dev/null && kill -9 "$OLD_PID" 2>/dev/null || true
else
  log "   無舊進程"
fi

sleep 1

nohup node server.js >>"$LOG_DIR/server.log" 2>&1 &
NEW_PID=$!
sleep 3

if kill -0 "$NEW_PID" 2>/dev/null; then
  log "✅ server.js 已啟動 PID=$NEW_PID"
else
  log "❌ server.js 啟動失敗"
  exit 1
fi

# ── 6. 健康檢查 ────────────────────────────────────────────────────────
for i in $(seq 1 10); do
  sleep 2
  HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:${PORT}/api/health 2>/dev/null || echo "000")
  if [ "$HTTP_CODE" = "200" ] || [ "$HTTP_CODE" = "401" ]; then
    log "✅ API 健康（HTTP $HTTP_CODE）"
    log "🚀 部署完成！"
    exit 0
  fi
  log "   等待中...（$i/10）HTTP $HTTP_CODE"
done

log "⚠️  健康檢查未完全通過，但 server.js 已啟動"
exit 0

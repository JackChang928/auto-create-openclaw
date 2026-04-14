#!/bin/bash
# backup-volumes.sh — Docker Volume 備份腳本
# 備份目標:
#   1. litellm_pgdata（LiteLLM PostgreSQL 資料庫 volume）
#   2. data/instances/（用戶 workspace 目錄快照）
# 用法: ./backup-volumes.sh [--output-dir DIR]
# 環境變數: BACKUP_DIR（預設 ./backups）

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$(dirname "$(dirname "$SCRIPT_DIR")")" && pwd)"
BACKUP_DIR="${BACKUP_DIR:-${REPO_ROOT}/backups}"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
DEST_DIR="${BACKUP_DIR}/volumes"

# 解析參數
while [[ $# -gt 0 ]]; do
  case $1 in
    --output-dir)
      DEST_DIR="$2/backups/volumes"
      shift 2
      ;;
    *)
      echo "未知參數: $1"
      echo "用法: $0 [--output-dir DIR]"
      exit 1
      ;;
  esac
done

mkdir -p "$DEST_DIR"

# ============================================================
# 協助函式：使用 alpine 臨時容器備份 named volume
# ============================================================
backup_named_volume() {
  local VOL_NAME="$1"
  local FNAME="$2"
  local ARCHIVE="${DEST_DIR}/${FNAME}_${TIMESTAMP}.tar.gz"

  # 檢查 volume 是否存在
  if ! docker volume inspect "$VOL_NAME" > /dev/null 2>&1; then
    echo "   ⚠️  Volume '$VOL_NAME' 不存在，跳過"
    return 0
  fi

  # 檢查 volume 是否真的有資料（避免備份空 volume）
  local VOL_CHECK=$(docker run --rm -v "${VOL_NAME}:/data" alpine \
    sh -c 'find /data -type f 2>/dev/null | head -1' 2>/dev/null || echo "")
  if [ -z "$VOL_CHECK" ]; then
    echo "   ⚠️  Volume '$VOL_NAME' 為空，跳過"
    return 0
  fi

  echo "   📦 打包 $VOL_NAME..."
  if docker run --rm \
    -v "${VOL_NAME}:/data:ro" \
    -v "${DEST_DIR}:/backup:rw" \
    alpine \
    tar czf "/backup/$(basename "$ARCHIVE")" -C /data . 2>/dev/null; then
    local SIZE=$(du -h "$ARCHIVE" | cut -f1 || echo "?")
    echo "   ✅ $VOL_NAME → $(basename "$ARCHIVE") ($SIZE)"
    return 0
  else
    echo "   ❌ $VOL_NAME 備份失敗"
    return 1
  fi
}

# ============================================================
# 主程式
# ============================================================
echo "============================================"
echo "  Docker Volume 備份 — $(date '+%Y-%m-%d %H:%M:%S')"
echo "============================================"

SUCCESS=0
FAILED=0
SKIPPED=0

# ----------------------------------------------------------
# 1. Named Docker Volumes
# ----------------------------------------------------------
echo ""
echo "--- Named Docker Volumes ---"

# litellm_pgdata
if backup_named_volume "auto-create-openclaw_litellm_pgdata" "litellm_pgdata"; then
  ((SUCCESS++)) || true
else
  ((FAILED++)) || true
fi

# 嘗試其他常見 volume 前綴（docker-compose 專案名可能不同）
for PREFIX in "" "openclaw-" "auto-create-openclaw_"; do
  VOL="${PREFIX}litellm_pgdata"
  # 跳過已處理的主要 volume
  [ "$VOL" = "auto-create-openclaw_litellm_pgdata" ] && continue
  if docker volume inspect "$VOL" > /dev/null 2>&1; then
    FNAME=$(echo "$VOL" | tr '/:' '__')
    if backup_named_volume "$VOL" "$FNAME"; then
      ((SUCCESS++)) || true
    else
      ((FAILED++)) || true
    fi
  fi
done

# ----------------------------------------------------------
# 2. 用戶 workspace instances 目錄快照
# ----------------------------------------------------------
echo ""
echo "--- User Instances 快照 ---"

INSTANCES_DIR="${REPO_ROOT}/data/instances"
if [ -d "$INSTANCES_DIR" ]; then
  INSTANCE_COUNT=$(find "$INSTANCES_DIR" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l)

  if [ "$INSTANCE_COUNT" -gt 0 ]; then
    FNAME="instances_${TIMESTAMP}.tar.gz"
    ARCHIVE="${DEST_DIR}/${FNAME}"

    echo "   📦 打包 ${INSTANCE_COUNT} 個用戶 workspace..."
    # 使用 tar 並保留相對路徑，排除常見不需要的目錄
    if tar czf "$ARCHIVE" \
      --exclude='.cache' \
      --exclude='node_modules' \
      --exclude='.npm' \
      --exclude='__pycache__' \
      -C "$INSTANCES_DIR" . 2>/dev/null; then
      local SIZE=$(du -h "$ARCHIVE" | cut -f1 || echo "?")
      echo "   ✅ instances → $FNAME ($SIZE)"
      ((SUCCESS++)) || true
    else
      echo "   ❌ instances 目錄備份失敗"
      ((FAILED++)) || true
    fi
  else
    echo "   ⚠️  用戶 workspace 為空，跳過"
    ((SKIPPED++)) || true
  fi
else
  echo "   ⚠️  instances 目錄不存在: $INSTANCES_DIR"
  ((SKIPPED++)) || true
fi

# ----------------------------------------------------------
# 3. 清理舊備份（保留策略：每個 volume 4 份）
# ----------------------------------------------------------
echo ""
echo "--- 清理舊備份（保留每個 volume 最近 4 份）---"

for archive in "${DEST_DIR}"/*.tar.gz; do
  [ -e "$archive" ] || continue
  BASENAME=$(basename "$archive" | sed "s/_${TIMESTAMP}//")
  # 取得同一 volume 的所有備份
  OTHER_ARCHIVES=$(ls -1t "${DEST_DIR}"/${BASENAME}*.tar.gz 2>/dev/null || true)
  COUNT=$(echo "$OTHER_ARCHIVES" | wc -l)
  if [ "$COUNT" -gt 4 ]; then
    EXCESS=$(($COUNT - 4))
    echo "   🗑️  清理 $BASENAME：刪除 $EXCESS 份舊備份"
    echo "$OTHER_ARCHIVES" | tail -n +5 | xargs rm -f 2>/dev/null || true
  fi
done

echo ""
echo "============================================"
echo "  備份完成"
echo "  ✅ 成功: ${SUCCESS}"
echo "  ❌ 失敗: ${FAILED}"
echo "  ⚠️  跳過: ${SKIPPED}"
echo "============================================"

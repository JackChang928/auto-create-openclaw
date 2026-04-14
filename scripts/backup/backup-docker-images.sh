#!/bin/bash
# backup-docker-images.sh — Docker images 備份腳本
# 用法: ./backup-docker-images.sh [--output-dir DIR]
# 環境變數: BACKUP_DIR（預設 ./backups）

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$(dirname "$(dirname "$SCRIPT_DIR")")" && pwd)"
BACKUP_DIR="${BACKUP_DIR:-${REPO_ROOT}/backups}"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
DEST_DIR="${BACKUP_DIR}/docker-images"
DEST="${DEST_DIR}/docker-images_${TIMESTAMP}"

# 解析參數
while [[ $# -gt 0 ]]; do
  case $1 in
    --output-dir)
      DEST_DIR="$2/backups/docker-images"
      DEST="${DEST_DIR}/docker-images_${TIMESTAMP}"
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

# 從 docker-compose.yml + provisioner.js 識別的所有 images
# 格式: "image_name|source"
IMAGES="
ghcr.io/berriai/litellm:main-latest|compose
postgres:15-alpine|compose
redis:7-alpine|compose
cr.fluentbit.io/fluent/fluent-bit:3.0.7|compose
auto-create-openclaw-base:latest|provisioner
"

# 追蹤結果
SUCCESS=0
FAILED=0
SKIPPED=0

echo "============================================"
echo "  Docker Images 備份 — $(date '+%Y-%m-%d %H:%M:%S')"
echo "============================================"

for entry in $IMAGES; do
  IMG=$(echo "$entry" | cut -d'|' -f1)
  SRC=$(echo "$entry" | cut -d'|' -f2)
  # 產生安全檔名：取代 / : 為 _
  FNAME=$(echo "$IMG" | tr '/:' '__')

  # 檢查 image 是否存在於本地
  if ! docker image inspect "$IMG" > /dev/null 2>&1; then
    echo "⚠️  [${SRC}] $IMG — 本地不存在，跳過"
    ((SKIPPED++)) || true
    continue
  fi

  ARCHIVE="${DEST_DIR}/${FNAME}_${TIMESTAMP}.tar.gz"
  echo ""
  echo "📦 備份 [$SRC]: $IMG"

  if docker save "$IMG" 2>/dev/null | gzip > "$ARCHIVE"; then
    SIZE=$(du -h "$ARCHIVE" | cut -f1 || echo "?")
    echo "   ✅ 成功 — $ARCHIVE ($SIZE)"
    ((SUCCESS++)) || true
  else
    echo "   ❌ 失敗 — $IMG"
    ((FAILED++)) || true
  fi
done

# 自建服務：嘗試從 local build context 打包（如果 Dockerfile 存在）
echo ""
echo "--- 自建服務 (local build context) ---"

for SERVICE in billing-service auth-service; do
  DOCKERFILE="${REPO_ROOT}/${SERVICE}/Dockerfile"
  if [ -f "$DOCKERFILE" ]; then
    IMG="openclaw-${SERVICE}:latest"
    FNAME=$(echo "$IMG" | tr '/:' '__')
    ARCHIVE="${DEST_DIR}/${FNAME}_${TIMESTAMP}.tar.gz"

    # 先確保 image 存在（從 build context build）
    if ! docker image inspect "$IMG" > /dev/null 2>&1; then
      echo "   🔨 Build $IMG..."
      if ! docker build -t "$IMG" "${REPO_ROOT}/${SERVICE}" > /dev/null 2>&1; then
        echo "   ⚠️  Build 失敗，跳過 $SERVICE"
        ((SKIPPED++)) || true
        continue
      fi
    fi

    echo "   📦 備份 [local]: $IMG"
    if docker save "$IMG" 2>/dev/null | gzip > "$ARCHIVE"; then
      SIZE=$(du -h "$ARCHIVE" | cut -f1 || echo "?")
      echo "   ✅ 成功 — $ARCHIVE ($SIZE)"
      ((SUCCESS++)) || true
    else
      echo "   ❌ 失敗 — $IMG"
      ((FAILED++)) || true
    fi
  else
    echo "   ⚠️  $SERVICE/Dockerfile 不存在，跳過"
    ((SKIPPED++)) || true
  fi
done

# 清理超過 4 週的舊備份（只留每週最後一份）
echo ""
echo "--- 清理舊備份（保留每個 image 最近 4 份）---"
for archive in "${DEST_DIR}"/*.tar.gz; do
  [ -e "$archive" ] || continue
  IMG_BASENAME=$(basename "$archive" | sed "s/_${TIMESTAMP}//")
  # 取得同一 image 的所有備份，按時間排序
  OTHER_ARCHIVES=$(ls -1t "${DEST_DIR}"/${IMG_BASENAME}*.tar.gz 2>/dev/null || true)
  COUNT=$(echo "$OTHER_ARCHIVES" | wc -l)
  if [ "$COUNT" -gt 4 ]; then
    EXCESS=$(($COUNT - 4))
    echo "   🗑️  清理 $IMG_BASENAME：刪除 $EXCESS 份舊備份"
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

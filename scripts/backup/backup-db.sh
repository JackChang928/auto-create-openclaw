#!/bin/bash
# backup-db.sh — SQLite 資料庫備份腳本
# 用法: ./backup-db.sh [--output-dir DIR]
# 環境變數: BACKUP_DIR（預設 ./backups）

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$(dirname "$(dirname "$SCRIPT_DIR")")" && pwd)"
BACKUP_DIR="${BACKUP_DIR:-${REPO_ROOT}/backups}"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
DB_PATH="${REPO_ROOT}/data/openclaw_users.db"
DEST_DIR="${BACKUP_DIR}/db"
DEST="${DEST_DIR}/openclaw_users_${TIMESTAMP}.db.gz"

# 解析參數
while [[ $# -gt 0 ]]; do
  case $1 in
    --output-dir)
      DEST_DIR="$2/backups/db"
      DEST="${DEST_DIR}/openclaw_users_${TIMESTAMP}.db.gz"
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

if [ ! -f "$DB_PATH" ]; then
  echo "❌ 資料庫不存在: $DB_PATH"
  exit 1
fi

# 複製並壓縮
if ! gzip -c "$DB_PATH" > "$DEST" 2>/dev/null; then
  echo "❌ 壓縮失敗: $DB_PATH"
  exit 1
fi

echo "✅ 資料庫已備份: $DEST"
SIZE=$(du -h "$DEST" | cut -f1)
echo "   備份大小: $SIZE"

# 保留最近 14 份（14 天每日備份）
BACKUP_COUNT=$(ls -1t "${DEST_DIR}"/openclaw_users_*.db.gz 2>/dev/null | wc -l)
if [ "$BACKUP_COUNT" -gt 14 ]; then
  EXCESS=$(($BACKUP_COUNT - 14))
  echo "   清理舊備份（保留最近 14 份）..."
  ls -1t "${DEST_DIR}"/openclaw_users_*.db.gz 2>/dev/null | tail -n +15 | xargs rm -f 2>/dev/null || true
  echo "   已刪除 $EXCESS 份舊備份"
fi

echo "✅ 備份完成，現有備份數量: $(ls -1t "${DEST_DIR}"/openclaw_users_*.db.gz 2>/dev/null | wc -l)"

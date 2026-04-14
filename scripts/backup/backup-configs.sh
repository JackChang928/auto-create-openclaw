#!/bin/bash
# backup-configs.sh — 設定檔備份腳本（T6）
# 備份 litellm_config.yaml、fluent-bit 設定、Docker Compose、.env 等重要設定檔
# 用法: ./backup-configs.sh [--output-dir DIR]
# 環境變數: BACKUP_DIR（預設 ./backups）

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$(dirname "$(dirname "$SCRIPT_DIR")")" && pwd)"
BACKUP_DIR="${BACKUP_DIR:-${REPO_ROOT}/backups}"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
DEST_DIR="${BACKUP_DIR}/configs"
DEST="${DEST_DIR}/configs_${TIMESTAMP}"

# 解析參數
while [[ $# -gt 0 ]]; do
  case $1 in
    --output-dir)
      DEST_DIR="$2/backups/configs"
      DEST="${DEST_DIR}/configs_${TIMESTAMP}"
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

echo "===== T6: 設定檔備份 ====="
echo "時間戳: ${TIMESTAMP}"
echo "目標目錄: ${DEST}"
echo ""

# ===== 步驟 1：定義需備份的設定檔清單 =====
# 格式: "SOURCE_PATH|RELATIVE_NAME|MASK_SENSITIVE"
# MASK_SENSITIVE: yes=對 .env/.env.example 脫敏，no=完整複製

CONFIG_FILES=(
  "${REPO_ROOT}/litellm_config.yaml|litellm/litellm_config.yaml|no"
  "${REPO_ROOT}/fluent-bit/fluent-bit.conf|fluent-bit/fluent-bit.conf|no"
  "${REPO_ROOT}/fluent-bit/parsers.conf|fluent-bit/parsers.conf|no"
  "${REPO_ROOT}/docker-compose.yml|docker-compose.yml|no"
  "${REPO_ROOT}/.env|.env|yes"
  "${REPO_ROOT}/.env.example|.env.example|yes"
  "${REPO_ROOT}/openapi.yaml|openapi.yaml|no"
  "${REPO_ROOT}/deploy/standalone/docker-compose.yml|deploy/standalone/docker-compose.yml|no"
  "${REPO_ROOT}/deploy/standalone/.env.example|deploy/standalone/.env.example|yes"
)

# ===== 步驟 2：脫敏函數 =====
# 遮蔽常見敏感資訊（API keys、密碼、URL 等）
mask_sensitive() {
  local file="$1"
  sed -E \
    -e "s/(LITELLM_MASTER_KEY[[:space:]]*=[[:space:]]*)[^[:space:]]*/\1【已遮蔽】/g" \
    -e "s/(OPENAI_API_KEY[[:space:]]*=[[:space:]]*)[^[:space:]]*/\1【已遮蔽】/g" \
    -e "s/(MINIMAX_API_KEY[[:space:]]*=[[:space:]]*)[^[:space:]]*/\1【已遮蔽】/g" \
    -e "s/(API_KEY[[:space:]]*=[[:space:]]*)[^[:space:]]*/\1【已遮蔽】/g" \
    -e "s/(DATABASE_URL[[:space:]]*=[[:space:]]*)[^[:space:]]*/\1【已遮蔽】/g" \
    -e "s/(POSTGRES_PASSWORD[[:space:]]*=[[:space:]]*)[^[:space:]]*/\1【已遮蔽】/g" \
    -e "s/(POSTGRES_USER[[:space:]]*=[[:space:]]*)[^[:space:]]*/\1【已遮蔽】/g" \
    -e "s/(REDIS_PASSWORD[[:space:]]*=[[:space:]]*)[^[:space:]]*/\1【已遮蔽】/g" \
    -e "s/(REDIS_HOST[[:space:]]*=[[:space:]]*)[^[:space:]]*/\1【已遮蔽】/g" \
    -e "s/(OPENAI_BASE_URL[[:space:]]*=[[:space:]]*)[^[:space:]]*/\1【已遮蔽】/g" \
    -e "s/(OLLAMA_BASE_URL[[:space:]]*=[[:space:]]*)[^[:space:]]*/\1【已遮蔽】/g" \
    -e "s/(AZURE_API_KEY[[:space:]]*=[[:space:]]*)[^[:space:]]*/\1【已遮蔽】/g" \
    -e "s/(ANTHROPIC_API_KEY[[:space:]]*=[[:space:]]*)[^[:space:]]*/\1【已遮蔽】/g" \
    -e "s/(GOOGLE_API_KEY[[:space:]]*=[[:space:]]*)[^[:space:]]*/\1【已遮蔽】/g" \
    -e "s/(HF_TOKEN[[:space:]]*=[[:space:]]*)[^[:space:]]*/\1【已遮蔽】/g" \
    -e "s/(S3_BUCKET[[:space:]]*=[[:space:]]*)[^[:space:]]*/\1【已遮蔽】/g" \
    -e "s/(AWS_ACCESS_KEY_ID[[:space:]]*=[[:space:]]*)[^[:space:]]*/\1【已遮蔽】/g" \
    -e "s/(AWS_SECRET_ACCESS_KEY[[:space:]]*=[[:space:]]*)[^[:space:]]*/\1【已遮蔽】/g" \
    -e "s/(JWT_SECRET[[:space:]]*=[[:space:]]*)[^[:space:]]*/\1【已遮蔽】/g" \
    -e "s/(BILLING_MASTER_KEY[[:space:]]*=[[:space:]]*)[^[:space:]]*/\1【已遮蔽】/g" \
    -e "s/(SERVICE_KEY[[:space:]]*=[[:space:]]*)[^[:space:]]*/\1【已遮蔽】/g" \
    -e "s/(token[[:space:]]*=[[:space:]]*)[^[:space:]]*/\1【已遮蔽】/g" \
    -e "s/(secret[[:space:]]*=[[:space:]]*)[^[:space:]]*/\1【已遮蔽】/g" \
    -e "s/(password[[:space:]]*=[[:space:]]*)[^[:space:]]*/\1【已遮蔽】/g" \
    "$file" 2>/dev/null || cat "$file"
}

# ===== 步驟 3：備份單一設定檔 =====
backup_config_file() {
  local src="$1"
  local rel_path="$2"
  local mask="$3"

  local dest_file="${DEST}/${rel_path}"
  local dest_subdir
  dest_subdir="$(dirname "$dest_file")"

  if [[ ! -f "$src" ]]; then
    echo "  ⚠️  跳過（檔案不存在）: ${rel_path}"
    return 0
  fi

  mkdir -p "$dest_subdir"

  if [[ "$mask" == "yes" ]]; then
    # 脫敏備份（同時保留原始副本）
    mask_sensitive "$src" > "$dest_file"
    # 原始檔案備份（.orig 後綴）
    cp "$src" "${dest_file}.orig"
    echo "  ✅ ${rel_path}（已脫敏 + 原始副本）"
  else
    cp "$src" "$dest_file"
    echo "  ✅ ${rel_path}"
  fi
}

# ===== 步驟 4：執行備份 =====
echo "📋 設定檔備份清單:"
echo ""

SUCCESS_COUNT=0
SKIP_COUNT=0

for entry in "${CONFIG_FILES[@]}"; do
  IFS='|' read -r src rel_path mask <<< "$entry"
  if [[ -f "$src" ]]; then
    backup_config_file "$src" "$rel_path" "$mask"
    ((SUCCESS_COUNT++)) || true
  else
    echo "  ⚠️  跳過（檔案不存在）: ${rel_path}"
    ((SKIP_COUNT++)) || true
  fi
done

echo ""

# ===== 步驟 5：產出備份摘要 JSON =====
SUMMARY_FILE="${DEST_DIR}/configs_summary.json"
SUMMARY_TIMESTAMP=$(date -Iseconds)

cat > "$SUMMARY_FILE" << EOF
{
  "timestamp": "${SUMMARY_TIMESTAMP}",
  "backup_version": "1.0",
  "task": "T6",
  "backup_type": "configs",
  "destination": "${DEST}",
  "files_backed_up": ${SUCCESS_COUNT},
  "files_skipped": ${SKIP_COUNT},
  "files": [
$(for entry in "${CONFIG_FILES[@]}"; do
  IFS='|' read -r src rel_path mask <<< "$entry"
  if [[ -f "$src" ]]; then
    echo "    {\"path\": \"${rel_path}\", \"status\": \"backed_up\", \"masked\": ${mask}}}"
  else
    echo "    {\"path\": \"${rel_path}\", \"status\": \"skipped_not_found\"}"
  fi
done | paste -sd ',' -)
  ]
}
EOF

# ===== 步驟 6：更新鶴（latest）連結 =====
ln -sfn "${DEST}" "${DEST_DIR}/latest"
echo "🔗 最新備份連結: ${DEST_DIR}/latest"

# ===== 步驟 7：計算並顯示備份大小 =====
BACKUP_SIZE=$(du -sh "$DEST" 2>/dev/null | cut -f1)
echo ""
echo "📦 備份大小: ${BACKUP_SIZE}"
echo "===== T6 完成 ====="
echo ""

#!/bin/bash
# backup-containers.sh — Docker Container 配置導出腳本（T4）
# 使用 docker inspect 導出所有容器配置（含環境變數、掛載、網路、資源限制等）
# 用法: ./backup-containers.sh [--output-dir DIR]
# 環境變數: BACKUP_DIR（預設 ./backups）

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$(dirname "$(dirname "$SCRIPT_DIR")")" && pwd)"
BACKUP_DIR="${BACKUP_DIR:-${REPO_ROOT}/backups}"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
DEST_DIR="${BACKUP_DIR}/containers"
DEST="${DEST_DIR}/containers_${TIMESTAMP}"

# 解析參數
while [[ $# -gt 0 ]]; do
  case $1 in
    --output-dir)
      DEST_DIR="$2/backups/containers"
      DEST="${DEST_DIR}/containers_${TIMESTAMP}"
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

# ===== 步驟 1：識別所有需備份的容器 =====
# 系統容器（docker-compose 管理）
SYSTEM_CONTAINERS="litellm-proxy litellm-postgres openclaw-redis fluent-bit openclaw-billing"

# 動態偵測所有以 "openclaw-" 或 "auto-create-" 前綴的容器（含用戶容器）
USER_CONTAINERS=$(docker ps --format '{{.Names}}' 2>/dev/null | \
  grep -E '^(openclaw-|auto-create-|cc-)' | \
  grep -v -E '^(litellm-proxy|litellm-postgres|openclaw-redis|fluent-bit|openclaw-billing)$' || true)

ALL_CONTAINERS="$SYSTEM_CONTAINERS $USER_CONTAINERS"

# ===== 步驟 2：導出容器配置 =====
echo "============================================"
echo "  Docker Container 配置導出 — $(date '+%Y-%m-%d %H:%M:%S')"
echo "============================================"

SUCCESS=0
FAILED=0
SKIPPED=0

# 建立本批次的容器列表檔
CONTAINER_LIST="${DEST_DIR}/container-list_${TIMESTAMP}.txt"
echo "# 容器配置備份列表 — ${TIMESTAMP}" > "$CONTAINER_LIST"
echo "# 格式: container_name|status|image|created" >> "$CONTAINER_LIST"

# 建立本批次的彙總 JSON（包含所有容器的 inspect 資料）
OVERVIEW_JSON="${DEST_DIR}/containers-overview_${TIMESTAMP}.json"
echo "{" > "$OVERVIEW_JSON"
echo '  "backup_timestamp": "'"${TIMESTAMP}"'",' >> "$OVERVIEW_JSON"
echo '  "backup_time_iso": "'"$(date -Iseconds)"'",' >> "$OVERVIEW_JSON"
echo '  "containers": [' >> "$OVERVIEW_JSON"

FIRST=true

for CNAME in $ALL_CONTAINERS; do
  # 檢查容器是否存在
  if ! docker inspect "$CNAME" > /dev/null 2>&1; then
    echo "⚠️  $CNAME — 容器不存在，跳過"
    ((SKIPPED++)) || true
    continue
  fi

  # 取得容器基本資訊（用於列表檔）
  STATUS=$(docker inspect --format '{{.State.Status}}' "$CNAME" 2>/dev/null || echo "unknown")
  IMAGE=$(docker inspect --format '{{.Config.Image}}' "$CNAME" 2>/dev/null || echo "unknown")
  CREATED=$(docker inspect --format '{{.Created}}' "$CNAME" 2>/dev/null | cut -d'.' -f1 || echo "unknown")
  echo "${CNAME}|${STATUS}|${IMAGE}|${CREATED}" >> "$CONTAINER_LIST"

  # ===== 導出完整配置 =====
  # 檔名：容器名稱 + 時間戳
  SAFE_NAME=$(echo "$CNAME" | tr -c '[:alnum:]_-' '_')
  OUT_FILE="${DEST_DIR}/${SAFE_NAME}_config_${TIMESTAMP}.json"

  echo ""
  echo "📋 導出配置: $CNAME (status=$STATUS)"

  # 使用 docker inspect 導出完整配置
  # 包含：Config, HostConfig, NetworkSettings, Mounts, LogPath, etc.
  if docker inspect "$CNAME" > "$OUT_FILE" 2>&1; then
    # 額外導出有用資訊：環境變數（脫敏版）
    ENV_FILE="${DEST_DIR}/${SAFE_NAME}_env_${TIMESTAMP}.sh"
    # 脫敏處理：遮蔽敏感變數
    docker inspect --format '{{range .Config.Env}}{{.}} {{end}}' "$CNAME" 2>/dev/null | \
      sed -e 's/\(LITELLM_MASTER_KEY=\)[^ ]*/\1[REDACTED]/g' \
          -e 's/\(OPENAI_API_KEY=\)[^ ]*/\1[REDACTED]/g' \
          -e 's/\(MINIMAX_API_KEY=\)[^ ]*/\1[REDACTED]/g' \
          -e 's/\(DATABASE_URL=\)[^ ]*/\1[REDACTED]/g' \
          -e 's/\(POSTGRES_PASSWORD=\)[^ ]*/\1[REDACTED]/g' \
          -e 's/\(REDIS_PASSWORD=\)[^ ]*/\1[REDACTED]/g' \
          -e 's/\(SECRET=\)[^ ]*/\1[REDACTED]/g' \
          -e 's/\(TOKEN=\)[^ ]*/\1[REDACTED]/g' \
          -e 's/\(PASSWORD=\)[^ ]*/\1[REDACTED]/g' \
          -e 's/\(API_KEY=\)[^ ]*/\1[REDACTED]/g' \
      > "$ENV_FILE" 2>/dev/null || true

    # 導出端口映射
    PORTS_FILE="${DEST_DIR}/${SAFE_NAME}_ports_${TIMESTAMP}.txt"
    docker inspect --format '{{json .NetworkSettings.Ports}}' "$CNAME" 2>/dev/null | \
      python3 -m json.tool > "$PORTS_FILE" 2>/dev/null || \
      echo "# 無端口映射" > "$PORTS_FILE"

    # 導出掛載點（不含密碼）
    MOUNTS_FILE="${DEST_DIR}/${SAFE_NAME}_mounts_${TIMESTAMP}.txt"
    docker inspect --format '{{range .Mounts}}{{.Source}}|{{.Destination}}|{{.Mode}}|{{.RW}}\n{{end}}' "$CNAME" 2>/dev/null > "$MOUNTS_FILE" || \
      echo "# 無掛載" > "$MOUNTS_FILE"

    SIZE=$(du -h "$OUT_FILE" | cut -f1 || echo "?")
    echo "   ✅ 成功 — $OUT_FILE ($SIZE)"

    # 追加到 overview JSON
    if [ "$FIRST" = true ]; then
      FIRST=false
    else
      echo "," >> "$OVERVIEW_JSON"
    fi
    # 輸出簡化摘要（避免 overview 過大）
    INSPECTOR=$(docker inspect --format '{{json .}}' "$CNAME" 2>/dev/null | \
      python3 -c "
import json,sys
d=json.load(sys.stdin)
# 脫敏並精簡
safe={k:v for k,v in d[0].items() if k in [
  'Name','State','Config','HostConfig','NetworkSettings','Mounts','Created'
]}
# 脫敏敏感欄位
for env in safe.get('Config',{}).get('Env',[]):
  for prefix in ['LITELLM_MASTER_KEY','OPENAI_API_KEY','MINIMAX_API_KEY','DATABASE_URL','POSTGRES_PASSWORD','REDIS_PASSWORD','SECRET','TOKEN','PASSWORD','API_KEY']:
    if env.startswith(prefix+'='):
      safe['Config']['Env'] = [e if not e.startswith(prefix+'=') else prefix+'=[REDACTED]' for e in safe['Config']['Env']]
      break
print(json.dumps(safe, indent=2))
" 2>/dev/null || echo "{}")
    printf '    %s' "$INSPECTOR" >> "$OVERVIEW_JSON"

    ((SUCCESS++)) || true
  else
    echo "   ❌ 失敗 — $CNAME"
    ((FAILED++)) || true
  fi
done

echo "" >> "$OVERVIEW_JSON"
echo '  ]' >> "$OVERVIEW_JSON"
echo '}' >> "$OVERVIEW_JSON"

echo ""
echo "--- 容器快照（docker ps）---"
PS_FILE="${DEST_DIR}/docker-ps_${TIMESTAMP}.txt"
docker ps --format "table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}" > "$PS_FILE" 2>/dev/null || true
cat "$PS_FILE"

# ===== 步驟 3：保留策略（每個容器配置最多 4 份）====
echo ""
echo "--- 清理舊備份（保留每個容器最近 4 份配置）---"
for config_file in "${DEST_DIR}"/*_config_*.json; do
  [ -e "$config_file" ] || continue
  BASE=$(basename "$config_file" | sed "s/_config_.*//")
  ALL_BACKUPS=$(ls -1t "${DEST_DIR}"/${BASE}_config_*.json 2>/dev/null || true)
  COUNT=$(echo "$ALL_BACKUPS" | wc -l)
  if [ "$COUNT" -gt 4 ]; then
    EXCESS=$(($COUNT - 4))
    echo "   🗑️  清理 $BASE：刪除 $EXCESS 份舊配置"
    echo "$ALL_BACKUPS" | tail -n +5 | xargs rm -f 2>/dev/null || true
  fi
done

# 清理 container-list 和 overview 舊檔（保留 4 份）
for suffix in container-list docker-ps containers-overview; do
  ALL_FILES=$(ls -1t "${DEST_DIR}"/${suffix}_*.txt "${DEST_DIR}"/${suffix}_*.json 2>/dev/null || true)
  COUNT=$(echo "$ALL_FILES" | wc -l)
  if [ "$COUNT" -gt 4 ]; then
    EXCESS=$(($COUNT - 4))
    echo "   🗑️  清理 ${suffix}：刪除 $EXCESS 份"
    echo "$ALL_FILES" | tail -n +5 | xargs rm -f 2>/dev/null || true
  fi
done

echo ""
echo "============================================"
echo "  容器配置導出完成"
echo "  ✅ 成功: ${SUCCESS}"
echo "  ❌ 失敗: ${FAILED}"
echo "  ⚠️  跳過: ${SKIPPED}"
echo "  📁 輸出目錄: ${DEST_DIR}"
echo "============================================"

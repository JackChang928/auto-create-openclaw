#!/bin/bash
# backup-all.sh — 統一備份主控腳本（T7）
# 整合所有備份子腳本，執行完整系統備份並統一管理保留策略
# 用法: ./backup-all.sh [--backup-dir DIR] [--skip SCOPE] [--dry-run] [--diff]
#   SCOPE: images|containers|volumes|db|configs 或 all（預設 all）
#   --dry-run: 只顯示將會執行的操作，不實際備份
#   --diff:    執行差異備份（相對於完整備份的變動項目，T8）
# 環境變數:
#   BACKUP_DIR       備份根目錄（預設 REPO_ROOT/backups）
#   RETENTION_IMAGES  images/containers/configs/volumes 保留份數（預設 4）
#   RETENTION_DB      db 保留份數（預設 14）
#   REMOTE_DEST      同步到遠程（可選，rsync 格式）
#   LOG_FILE         日誌檔路徑（預設 BACKUP_DIR/backup-all_TIMESTAMP.log）

set -euo pipefail

# ============================================================
# 路徑初始化
# ============================================================
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$(dirname "$(dirname "$SCRIPT_DIR")")" && pwd)"
SCRIPT_NAME="$(basename "$0")"

# 備份根目錄
BACKUP_DIR="${BACKUP_DIR:-${REPO_ROOT}/backups}"

# 保留策略（可透過環境變數覆寫）
RETENTION_IMAGES="${RETENTION_IMAGES:-4}"
RETENTION_CONTAINERS="${RETENTION_IMAGES:-4}"
RETENTION_CONFIGS="${RETENTION_IMAGES:-4}"
RETENTION_VOLUMES="${RETENTION_IMAGES:-4}"
RETENTION_DB="${RETENTION_DB:-14}"

# 解析參數
SKIP_SCOPES=()
DRY_RUN=false
DIFF_MODE=false
while [[ $# -gt 0 ]]; do
  case $1 in
    --skip)
      SKIP_SCOPES+=("$2")
      shift 2
      ;;
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    --backup-dir)
      BACKUP_DIR="$2"
      shift 2
      ;;
    --diff)
      DIFF_MODE=true
      shift
      ;;
    *)
      echo "未知參數: $1"
      echo "用法: $0 [--backup-dir DIR] [--skip SCOPE] [--dry-run] [--diff]"
      echo "  SCOPE: images|containers|volumes|db|configs|all"
      echo "  --diff: 執行差異備份（相對於完整備份的變動項目）"
      exit 1
      ;;
  esac
done

# 檢查是否跳過某個範圍
should_skip() {
  local scope="$1"
  for s in "${SKIP_SCOPES[@]}"; do
    [ "$s" = "$scope" ] && return 0
    [ "$s" = "all" ] && return 0
  done
  return 1
}

# ============================================================
# 時間戳與目錄
# ============================================================
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
LOG_DIR="${BACKUP_DIR}/logs"
mkdir -p "$LOG_DIR"
LOG_FILE="${LOG_DIR}/backup-all_${TIMESTAMP}.log"

# 子目錄
SUBDIRS=(docker-images containers configs volumes db)
for d in "${SUBDIRS[@]}"; do
  mkdir -p "${BACKUP_DIR}/${d}"
done

# ============================================================
# 日誌函式
# ============================================================
log() {
  local msg="[$(date '+%H:%M:%S')] $*"
  echo "$msg" | tee -a "$LOG_FILE"
}

log_section() {
  log ""
  log "============================================"
  log "  $*"
  log "============================================"
}

# ============================================================
# dry-run 模擬函式
# ============================================================
run_cmd() {
  if $DRY_RUN; then
    log "[DRY-RUN] $*"
  else
    log "$*"
    eval "$@" >> "$LOG_FILE" 2>&1
  fi
}

# ============================================================
# 保留策略統一執行（整合所有子腳本的清理邏輯）
# ============================================================

# 清理超過保留份數的舊備份
# 用法: purge_old_backups DIR PATTERN RETENTION_COUNT
# PATTERN: glob pattern 如 "*.tar.gz" 或 prefix 如 "container-name"
purge_old_backups() {
  local dir="$1"
  local pattern="$2"
  local keep="$3"
  local description="${4:-archive}"

  [ -d "$dir" ] || return 0
  [ -n "$(ls -1 "${dir}/${pattern}" 2>/dev/null)" ] || return 0

  # 找出所有符合 pattern 的檔案，按時間排序（新的在前）
  IFS=$'\n'
  local files=($(ls -1t "${dir}/${pattern}" 2>/dev/null))
  unset IFS

  local count=${#files[@]}
  if [ "$count" -gt "$keep" ]; then
    local excess=$((count - keep))
    log "  🗑️  清理 ${description}：刪除 ${excess} 份舊備份（保留 ${keep} 份，共 ${count} 份）"
    if $DRY_RUN; then
      for f in "${files[@]:$keep}"; do
        log "  [DRY-RUN] 會刪除: $f"
      done
    else
      for f in "${files[@]:$keep}"; do
        rm -f "$f"
      done
    fi
  else
    log "  ✅ ${description}：${count} 份（無需清理，低於保留上限 ${keep}）"
  fi
}

# 清理空目錄
cleanup_empty_dirs() {
  local dir="$1"
  find "$dir" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | while read -r subdir; do
    if [ -d "$subdir" ] && [ -z "$(ls -A "$subdir" 2>/dev/null)" ]; then
      log "  🗑️  移除空目錄: $subdir"
      rmdir "$subdir" 2>/dev/null || true
    fi
  done
}

# ============================================================
# 執行個體備份子腳本
# ============================================================
run_backup_script() {
  local script_name="$1"
  local scope="$2"
  local script_path="${SCRIPT_DIR}/${script_name}"

  if should_skip "$scope"; then
    log "⏭️  跳過（--skip）: $scope"
    return 0
  fi

  if [ ! -f "$script_path" ]; then
    log "⚠️  腳本不存在: $script_path，跳過"
    return 1
  fi

  log ""
  log "🚀 執行: $script_name"

  if $DRY_RUN; then
    log "[DRY-RUN] BACKUP_DIR=${BACKUP_DIR} bash $script_path"
    return 0
  fi

  # 執行子腳本：透過 BACKUP_DIR 環境變數控制輸出位置
  # （子腳本預設會輸出到 REPO_ROOT/backups，但 BACKUP_DIR 覆寫之）
  if BACKUP_DIR="${BACKUP_DIR}" bash "$script_path" >> "$LOG_FILE" 2>&1; then
    log "✅ $script_name 完成"
    return 0
  else
    log "⚠️  $script_name 執行有警告（見日誌）"
    return 1
  fi
}

# ============================================================
# 統一保留策略清理（子腳本各自清理後再次統一清理一次）
# ============================================================
apply_unified_retention() {
  log_section "統一保留策略清理"

  log "保留策略設定:"
  log "  images/containers/configs/volumes: 各保留 ${RETENTION_IMAGES} 份"
  log "  db: 保留 ${RETENTION_DB} 份"

  # --- docker-images ---
  log ""
  log "--- Docker Images ---"
  local dimg_dir="${BACKUP_DIR}/docker-images"
  if [ -d "$dimg_dir" ]; then
    # 找出所有 image archive，按 image 名稱分組，每組保留 N 份
    # 檔名格式: ghcr.io_berriai_litellm_main-latest_TIMESTAMP.tar.gz
    local images
    images=$(ls -1t "${dimg_dir}"/*.tar.gz 2>/dev/null | sed 's/_[0-9]\{8\}_[0-9]\{6\}//' | sort -u)
    for img_base in $images; do
      purge_old_backups "$dimg_dir" "$(basename "$img_base")"*.tar.gz "$RETENTION_IMAGES" "image: $(basename "$img_base")"
    done
  fi

  # --- containers ---
  log ""
  log "--- Container Configs ---"
  local ctn_dir="${BACKUP_DIR}/containers"
  if [ -d "$ctn_dir" ]; then
    # 清理 *_config_* JSON 檔
    purge_old_backups "$ctn_dir" "*_config_*.json" "$RETENTION_CONTAINERS" "container config"
    # 清理 *_env_* sh 檔
    purge_old_backups "$ctn_dir" "*_env_*.sh" "$RETENTION_CONTAINERS" "container env"
    # 清理 *_ports_* txt 檔
    purge_old_backups "$ctn_dir" "*_ports_*.txt" "$RETENTION_CONTAINERS" "container ports"
    # 清理 *_mounts_* txt 檔
    purge_old_backups "$ctn_dir" "*_mounts_*.txt" "$RETENTION_CONTAINERS" "container mounts"
    # 清理 container-list / docker-ps / containers-overview 附屬檔
    purge_old_backups "$ctn_dir" "container-list_*.txt" "$RETENTION_CONTAINERS" "container-list"
    purge_old_backups "$ctn_dir" "docker-ps_*.txt" "$RETENTION_CONTAINERS" "docker-ps"
    purge_old_backups "$ctn_dir" "containers-overview_*.json" "$RETENTION_CONTAINERS" "containers-overview"
  fi

  # --- configs ---
  log ""
  log "--- Config Files ---"
  local cfg_dir="${BACKUP_DIR}/configs"
  if [ -d "$cfg_dir" ]; then
    # configs/latest 是 symlink，清理舊的 configs_TIMESTAMP 目錄
    purge_old_backups "$cfg_dir" "configs_*" "$RETENTION_CONFIGS" "configs snapshot"
    purge_old_backups "$cfg_dir" "configs_summary.json" "$RETENTION_CONFIGS" "configs summary"
    cleanup_empty_dirs "$cfg_dir"
  fi

  # --- volumes ---
  log ""
  log "--- Docker Volumes ---"
  purge_old_backups "${BACKUP_DIR}/volumes" "*.tar.gz" "$RETENTION_VOLUMES" "volume archive"

  # --- db ---
  log ""
  log "--- Database ---"
  purge_old_backups "${BACKUP_DIR}/db" "openclaw_users_*.db.gz" "$RETENTION_DB" "database backup"

  log ""
  log "✅ 統一保留策略完成"
}

# ============================================================
# 備份大小統計
# ============================================================
show_backup_summary() {
  log_section "備份大小統計"

  local total_size=0
  for subdir in "${SUBDIRS[@]}"; do
    local dir="${BACKUP_DIR}/${subdir}"
    if [ -d "$dir" ]; then
      local size
      size=$(du -sh "$dir" 2>/dev/null | cut -f1 || echo "0")
      local count
      count=$(find "$dir" -type f 2>/dev/null | wc -l)
      log "  ${subdir}: ${size}（${count} 個檔案）"
    fi
  done

  total_size=$(du -sh "$BACKUP_DIR" 2>/dev/null | cut -f1 || echo "?")
  log ""
  log "  📦 備份總大小: ${total_size}"
  log "  📁 備份目錄: ${BACKUP_DIR}"
  log "  📝 日誌檔: ${LOG_FILE}"
}

# ============================================================
# 遠程同步（可選）
# ============================================================
sync_remote() {
  [ -n "${REMOTE_DEST:-}" ] || return 0

  log_section "遠程同步"
  log "同步目標: ${REMOTE_DEST}"

  if $DRY_RUN; then
    log "[DRY-RUN] rsync -av --delete ${BACKUP_DIR}/ ${REMOTE_DEST}/"
    return 0
  fi

  if command -v rsync >/dev/null 2>&1; then
    if rsync -av --delete "${BACKUP_DIR}/" "${REMOTE_DEST}/" >> "$LOG_FILE" 2>&1; then
      log "✅ 遠程同步完成"
    else
      log "⚠️  遠程同步失敗（rsync error，見日誌）"
    fi
  else
    log "⚠️  rsync 未安裝，跳過遠程同步"
  fi
}

# ============================================================
# 產出統一的備份報告 JSON
# ============================================================
generate_report() {
  local report_file="${BACKUP_DIR}/backup-report_latest.json"
  local ts_iso
  ts_iso=$(date -Iseconds)

  log_section "產出備份報告"

  # 計算各目錄大小與檔案數
  local images_size images_count containers_size containers_count
  local configs_size configs_count volumes_size volumes_count
  local db_size db_count

  images_size=$(du -sh "${BACKUP_DIR}/docker-images" 2>/dev/null | cut -f1 || echo "0")
  images_count=$(find "${BACKUP_DIR}/docker-images" -type f 2>/dev/null | wc -l)
  containers_size=$(du -sh "${BACKUP_DIR}/containers" 2>/dev/null | cut -f1 || echo "0")
  containers_count=$(find "${BACKUP_DIR}/containers" -type f 2>/dev/null | wc -l)
  configs_size=$(du -sh "${BACKUP_DIR}/configs" 2>/dev/null | cut -f1 || echo "0")
  configs_count=$(find "${BACKUP_DIR}/configs" -type f 2>/dev/null | wc -l)
  volumes_size=$(du -sh "${BACKUP_DIR}/volumes" 2>/dev/null | cut -f1 || echo "0")
  volumes_count=$(find "${BACKUP_DIR}/volumes" -type f 2>/dev/null | wc -l)
  db_size=$(du -sh "${BACKUP_DIR}/db" 2>/dev/null | cut -f1 || echo "0")
  db_count=$(find "${BACKUP_DIR}/db" -type f 2>/dev/null | wc -l)

  local total_size
  total_size=$(du -sh "$BACKUP_DIR" 2>/dev/null | cut -f1 || echo "?")

  # 各子系統最新備份時間
  local latest_dimg latest_ctn latest_cfg latest_vol latest_db
  latest_dimg=$(ls -1t "${BACKUP_DIR}/docker-images"/*.tar.gz 2>/dev/null | head -1 | xargs -I{} basename {} 2>/dev/null | grep -oP '\d{8}_\d{6}' | head -1 || echo "none")
  latest_ctn=$(ls -1t "${BACKUP_DIR}/containers"/*_config_*.json 2>/dev/null | head -1 | xargs -I{} basename {} | grep -oP '\d{8}_\d{6}' | head -1 || echo "none")
  latest_db=$(ls -1t "${BACKUP_DIR}/db"/openclaw_users_*.db.gz 2>/dev/null | head -1 | xargs -I{} basename {} | sed 's/openclaw_users_//' | sed 's/.db.gz//' || echo "none")

  cat > "$report_file" << EOF
{
  "report_timestamp": "${ts_iso}",
  "backup_root": "${BACKUP_DIR}",
  "log_file": "${LOG_FILE}",
  "retention_policy": {
    "images_containers_configs_volumes": ${RETENTION_IMAGES},
    "db": ${RETENTION_DB}
  },
  "scopes": {
    "docker_images": {
      "size": "${images_size}",
      "file_count": ${images_count},
      "latest_timestamp": "${latest_dimg}",
      "retention": ${RETENTION_IMAGES}
    },
    "containers": {
      "size": "${containers_size}",
      "file_count": ${containers_count},
      "latest_timestamp": "${latest_ctn}",
      "retention": ${RETENTION_CONTAINERS}
    },
    "configs": {
      "size": "${configs_size}",
      "file_count": ${configs_count},
      "retention": ${RETENTION_CONFIGS}
    },
    "volumes": {
      "size": "${volumes_size}",
      "file_count": ${volumes_count},
      "retention": ${RETENTION_VOLUMES}
    },
    "db": {
      "size": "${db_size}",
      "file_count": ${db_count},
      "latest_timestamp": "${latest_db}",
      "retention": ${RETENTION_DB}
    }
  },
  "total_size": "${total_size}"
}
EOF

  log "✅ 報告已寫入: $report_file"
}

# ============================================================
# 主程式
# ============================================================
main() {
  echo "" | tee "$LOG_FILE"
  log_section "統一備份啟動 — ${TIMESTAMP}"
  log "備份根目錄: ${BACKUP_DIR}"
  log "保留策略: images/containers/configs/volumes = ${RETENTION_IMAGES} 份, db = ${RETENTION_DB} 份"
  if $DRY_RUN; then
    log "⚠️  DRY-RUN 模式：只顯示，不實際執行"
  fi
  if $DIFF_MODE; then
    log "🔄 差異備份模式：只備份自上次完整備份以來有變動的項目"
  fi
  log ""

  # 差異備份模式（直接跳至 backup-diff.sh）
  if $DIFF_MODE; then
    local diff_script="${SCRIPT_DIR}/backup-diff.sh"
    if [ ! -f "$diff_script" ]; then
      log "⚠️  backup-diff.sh 不存在，請先執行 T8 建置"
      exit 1
    fi
    log ""
    log "🚀 執行差異備份: backup-diff.sh"
    if $DRY_RUN; then
      log "[DRY-RUN] BACKUP_DIR=${BACKUP_DIR} bash $diff_script --dry-run"
    else
      if BACKUP_DIR="${BACKUP_DIR}" bash "$diff_script" >> "$LOG_FILE" 2>&1; then
        log "✅ 差異備份完成"
      else
        log "⚠️  差異備份執行有警告（見日誌）"
      fi
    fi
    show_backup_summary
    generate_report
    log_section "備份完成"
    log "完成時間: $(date '+%Y-%m-%d %H:%M:%S')"
    log "日誌檔: ${LOG_FILE}"
    return 0
  fi

  # 執行各類備份
  run_backup_script "backup-docker-images.sh" "images"
  run_backup_script "backup-containers.sh" "containers"
  run_backup_script "backup-configs.sh" "configs"
  run_backup_script "backup-volumes.sh" "volumes"
  run_backup_script "backup-db.sh" "db"

  # 統一保留策略清理
  apply_unified_retention

  # 統計
  show_backup_summary

  # 報告
  generate_report

  # 遠程同步（可選）
  sync_remote

  log_section "備份完成"
  log "完成時間: $(date '+%Y-%m-%d %H:%M:%S')"
  log "日誌檔: ${LOG_FILE}"

  if $DRY_RUN; then
    log ""
    log "=== DRY-RUN 完成，以上為預執行操作 ==="
  fi
}

main

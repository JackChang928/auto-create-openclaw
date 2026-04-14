#!/bin/bash
# backup-diff.sh — 差異備份腳本（T8）
# 僅備份自上次完整備份以來有變動的項目
# 策略：
#   - configs:   比對檔案修改時間與 SHA256 checksum
#   - volumes:    比對 docker volume 最後更新時間（相對於上次完整備份）
#   - containers: 比對容器 config hash（litellm-proxy 等系統容器）
#   - db:        始終備份（小檔案，每天備份合理）
#   - images:    跳過（差異無意義，每次 pull 差異不同）
# 用法: ./backup-diff.sh [--backup-dir DIR] [--dry-run] [--force]
# 環境變數:
#   BACKUP_DIR        備份根目錄
#   DIFF_MANIFEST     差異比對基準清單（預設 BACKUP_DIR/.diff-manifest.json）
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$(dirname "$(dirname "$SCRIPT_DIR")")" && pwd)"
BACKUP_DIR="${BACKUP_DIR:-${REPO_ROOT}/backups}"
DIFF_MANIFEST="${DIFF_MANIFEST:-${BACKUP_DIR}/.diff-manifest.json}"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
LOG_FILE="${BACKUP_DIR}/logs/backup-diff_${TIMESTAMP}.log"
DRY_RUN=false
FORCE_FULL=false

mkdir -p "${BACKUP_DIR}/logs"

# ============================================================
# 幫助函式
# ============================================================
log() {
  local msg="[$(date '+%H:%M:%S')] $*"
  echo "$msg" | tee -a "$LOG_FILE" >&2
}

log_section() {
  log ""
  log "============================================"
  log "  $*"
  log "============================================"
}

run_cmd() {
  if $DRY_RUN; then
    log "[DRY-RUN] $*"
  else
    log "$*"
    eval "$@" >> "$LOG_FILE" 2>&1
  fi
}

# ============================================================
# 解析參數
# ============================================================
while [[ $# -gt 0 ]]; do
  case $1 in
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    --force)
      FORCE_FULL=true
      shift
      ;;
    --backup-dir)
      BACKUP_DIR="$2"
      shift 2
      ;;
    *)
      echo "未知參數: $1"
      exit 1
      ;;
  esac
done

# ============================================================
# 步驟 1: 建立本次差異比對用的暫存清單（current state）
# ============================================================
build_current_state() {
  local STATE_FILE="${BACKUP_DIR}/.current-state-${TIMESTAMP}.tmp"
  local TS_EPOCH
  TS_EPOCH=$(date +%s)

  {
    echo "{"
    echo "  \"scan_epoch\": ${TS_EPOCH},"
    echo "  \"timestamp\": \"$(date -Iseconds)\","
    echo "  \"configs\": {"

    # --- configs ---
    local CONFIG_FILES=(
      "${REPO_ROOT}/litellm_config.yaml:litellm/litellm_config.yaml"
      "${REPO_ROOT}/fluent-bit/fluent-bit.conf:fluent-bit/fluent-bit.conf"
      "${REPO_ROOT}/fluent-bit/parsers.conf:fluent-bit/parsers.conf"
      "${REPO_ROOT}/docker-compose.yml:docker-compose.yml"
      "${REPO_ROOT}/.env:.env"
      "${REPO_ROOT}/.env.example:.env.example"
      "${REPO_ROOT}/openapi.yaml:openapi.yaml"
    )

    local first=1
    for entry in "${CONFIG_FILES[@]}"; do
      IFS=':' read -r src rel <<< "$entry"
      if [[ -f "$src" ]]; then
        local mtime size hash
        mtime=$(stat -c %Y "$src" 2>/dev/null || stat -f %m "$src" 2>/dev/null)
        size=$(stat -c %s "$src" 2>/dev/null || stat -f %z "$src" 2>/dev/null)
        hash=$(sha256sum "$src" 2>/dev/null | cut -d' ' -f1 || shasum -a 256 "$src" 2>/dev/null | cut -d' ' -f1)
        local comma=""
        [[ $first -eq 1 ]] && first=0 || comma=","
        echo "  ${comma}\"${rel}\": {\"mtime\": ${mtime}, \"size\": ${size}, \"hash\": \"${hash}\"}"
      fi
    done

    echo "  },"
    echo "  \"volumes\": {"

    # --- volumes ---
    first=1
    while IFS= read -r vol; do
      [ -z "$vol" ] && continue
      local updated
      updated=$(docker volume inspect "$vol" --format '{{.UpdatedAt}}' 2>/dev/null | head -1 || echo "")
      local comma=""
      [[ $first -eq 1 ]] && first=0 || comma=","
      echo "  ${comma}\"${vol}\": {\"updated\": \"${updated}\"}"
    done < <(docker volume ls --format '{{.Name}}' 2>/dev/null | grep -E 'litellm|openclaw|auto-create' | head -20)
    echo "  },"

    # --- containers ---
    echo "  \"containers\": {"
    first=1
    while IFS= read -r line; do
      [ -z "$line" ] && continue
      IFS=$'\t' read -r cname cid <<< "$line"
      [ -z "$cname" ] && continue
      local chash
      chash=$(docker inspect "$cid" --format '{{.Config}}' 2>/dev/null | sha256sum | cut -d' ' -f1 || echo "unknown")
      local comma=""
      [[ $first -eq 1 ]] && first=0 || comma=","
      echo "  ${comma}\"${cname}\": {\"id\": \"${cid}\", \"config_hash\": \"${chash}\"}"
    done < <(docker ps --format '{{.Names}}	{{.ID}}' 2>/dev/null | grep -E 'litellm|openclaw|auto-create|fluent|redis|postgres|billing|auth' | head -20)
    echo "  }"

    echo "}"
  } > "$STATE_FILE"

  # Only echo the file path to stdout (not logs) so command substitution captures it cleanly
  echo "$STATE_FILE"
}

# ============================================================
# 步驟 2: 比對並找出差異
# ============================================================
compute_diff() {
  local current_state="$1"
  local manifest="$2"

  log_section "比對差異"

  # 如果沒有上次的 manifest，視為首次執行，全部視為差異
  if [[ ! -f "$manifest" ]]; then
    log "⚠️  無上次備份 manifest（${manifest}），將執行完整差異掃描"
    $FORCE_FULL && log "⚠️  --force 模式：跳過 image 以外的 所有項目"
    return 0
  fi

  # 用 python3 做 JSON diff（更可靠）
  python3 - "$current_state" "$manifest" "$FORCE_FULL" << 'PYEOF'
import sys, json, subprocess, os

current_file = sys.argv[1]
manifest_file = sys.argv[2]
force = sys.argv[3].lower() == 'true'

try:
    with open(current_file) as f:
        current = json.load(f)
except:
    print("ERROR: 無法讀取 current state")
    sys.exit(1)

try:
    with open(manifest_file) as f:
        manifest = json.load(f)
except:
    print("NO_MANIFEST")
    sys.exit(0)

manifest_epoch = manifest.get("scan_epoch", 0)
current_epoch = current.get("scan_epoch", 0)

diff_result = {
    "configs": [],
    "volumes": [],
    "containers": [],
    "force": force
}

# --- configs diff ---
cur_configs = current.get("configs", {})
man_configs = manifest.get("configs", {})
for rel_path, info in cur_configs.items():
    man_info = man_configs.get(rel_path, {})
    man_hash = man_info.get("hash", "")
    cur_hash = info.get("hash", "")
    if man_hash != cur_hash:
        diff_result["configs"].append(rel_path)
        print(f"  📝 差異配置: {rel_path} (hash changed)")

# --- volumes diff (compare UpdatedAt timestamps) ---
# Docker UpdatedAt is in ISO8601 format, compare raw strings
cur_vols = current.get("volumes", {})
man_vols = manifest.get("volumes", {})
for vol_name, info in cur_vols.items():
    cur_updated = info.get("updated", "")
    man_updated = man_vols.get(vol_name, {}).get("updated", "")
    if cur_updated != man_updated and cur_updated:
        diff_result["volumes"].append(vol_name)
        print(f"  📦 差異Volume: {vol_name} (updated)")

# --- containers diff ---
cur_ctns = current.get("containers", {})
man_ctns = manifest.get("containers", {})
for cname, info in cur_ctns.items():
    cur_hash = info.get("config_hash", "")
    man_hash = man_ctns.get(cname, {}).get("config_hash", "")
    if cur_hash != man_hash:
        diff_result["containers"].append(cname)
        print(f"  🐳 差異容器: {cname} (config changed)")

# Always include db in diff
diff_result["db"] = True

print(f"\n  差異摘要: configs={len(diff_result['configs'])}, volumes={len(diff_result['volumes'])}, containers={len(diff_result['containers'])}")

# Save diff result
with open(os.path.join(os.environ.get("BACKUP_DIR", "."), f".diff-result-{os.environ.get('TIMESTAMP','unknown')}.json"), "w") as f:
    json.dump(diff_result, f, indent=2)
PYEOF
}

# ============================================================
# 步驟 3: 執行差異備份
# ============================================================
do_diff_backup() {
  local diff_result_file="$1"
  local current_state="$2"

  log_section "執行差異備份"
  mkdir -p "${BACKUP_DIR}/configs" "${BACKUP_DIR}/volumes" "${BACKUP_DIR}/containers" "${BACKUP_DIR}/db"

  # --- configs ---
  log ""
  log "--- Configs 差異備份 ---"
  python3 - "$diff_result_file" "$REPO_ROOT" "$BACKUP_DIR" "$TIMESTAMP" << 'PYEOF'
import sys, json, os, subprocess

diff_file = sys.argv[1]
repo_root = sys.argv[2]
backup_dir = sys.argv[3]
timestamp = sys.argv[4]

try:
    with open(diff_file) as f:
        diff = json.load(f)
except Exception as e:
    print(f"ERROR reading diff: {e}")
    sys.exit(1)

configs = diff.get("configs", [])
if not configs:
    print("  ✅ configs: 無變動")
else:
    dest_dir = f"{backup_dir}/configs/configs_diff_{timestamp}"
    os.makedirs(dest_dir, exist_ok=True)

    CONFIG_MAP = {
        "litellm/litellm_config.yaml": f"{repo_root}/litellm_config.yaml",
        "fluent-bit/fluent-bit.conf": f"{repo_root}/fluent-bit/fluent-bit.conf",
        "fluent-bit/parsers.conf": f"{repo_root}/fluent-bit/parsers.conf",
        "docker-compose.yml": f"{repo_root}/docker-compose.yml",
        ".env": f"{repo_root}/.env",
        ".env.example": f"{repo_root}/.env.example",
        "openapi.yaml": f"{repo_root}/openapi.yaml",
    }

    import re
    def mask_sensitive(text):
        patterns = [
            (r'(LITELLM_MASTER_KEY[[:space:]]*=[[:space:]]*)[^\s]+', r'\1【已遮蔽】'),
            (r'(OPENAI_API_KEY[[:space:]]*=[[:space:]]*)[^\s]+', r'\1【已遮蔽】'),
            (r'(MINIMAX_API_KEY[[:space:]]*=[[:space:]]*)[^\s]+', r'\1【已遮蔽】'),
            (r'(DATABASE_URL[[:space:]]*=[[:space:]]*)[^\s]+', r'\1【已遮蔽】'),
            (r'(POSTGRES_PASSWORD[[:space:]]*=[[:space:]]*)[^\s]+', r'\1【已遮蔽】'),
            (r'(REDIS_PASSWORD[[:space:]]*=[[:space:]]*)[^\s]+', r'\1【已遮蔽】'),
            (r'(OPENAI_API_KEY[[:space:]]*=[[:space:]]*)[^\s]+', r'\1【已遮蔽】'),
            (r'(API_KEY[[:space:]]*=[[:space:]]*)[^\s]+', r'\1【已遮蔽】'),
            (r'(JWT_SECRET[[:space:]]*=[[:space:]]*)[^\s]+', r'\1【已遮蔽】'),
            (r'(secret[[:space:]]*=[[:space:]]*)[^\s]+', r'\1【已遮蔽】'),
            (r'(password[[:space:]]*=[[:space:]]*)[^\s]+', r'\1【已遮蔽】'),
        ]
        for pat, repl in patterns:
            text = re.sub(pat, repl, text)
        return text

    for rel_path in configs:
        src = CONFIG_MAP.get(rel_path)
        if not src or not os.path.exists(src):
            print(f"  ⚠️  跳過（不存在）: {rel_path}")
            continue
        dest_file = os.path.join(dest_dir, rel_path)
        os.makedirs(os.path.dirname(dest_file), exist_ok=True)
        # Always backup with mask
        with open(src) as f:
            content = f.read()
        masked = mask_sensitive(content)
        with open(dest_file, "w") as f:
            f.write(masked)
        # Also copy original
        import shutil
        shutil.copy2(src, dest_file + ".orig")
        print(f"  ✅ {rel_path}")

    print(f"  📦 configs 差異備份大小: $(du -sh {dest_dir} 2>/dev/null | cut -f1 || echo '?')")
PYEOF

  # --- volumes diff ---
  log ""
  log "--- Volumes 差異備份 ---"
  python3 - "$diff_result_file" "$BACKUP_DIR" "$TIMESTAMP" << 'PYEOF'
import sys, json, os, subprocess

diff_file = sys.argv[1]
backup_dir = sys.argv[2]
timestamp = sys.argv[3]

try:
    with open(diff_file) as f:
        diff = json.load(f)
except:
    print("ERROR reading diff")
    sys.exit(1)

vols = diff.get("volumes", [])
force = diff.get("force", False)
dest_dir = f"{backup_dir}/volumes"

if not vols and not force:
    print("  ✅ volumes: 無變動")
else:
    for vol in vols:
        print(f"  📦 差異備份 volume: {vol}")
        out_file = f"{dest_dir}/{vol.replace('/','_')}_diff_{timestamp}.tar.gz"
        try:
            result = subprocess.run(
                ["docker", "run", "--rm",
                 "-v", f"{vol}:/data:ro",
                 "-v", f"{dest_dir}:/backup:rw",
                 "alpine",
                 "tar", "czf", f"/backup/{os.path.basename(out_file)}", "-C", "/data", "."],
                capture_output=True, text=True, timeout=300
            )
            if result.returncode == 0 and os.path.exists(out_file):
                size = subprocess.run(["du","-sh",out_file], capture_output=True, text=True).stdout.split()[0]
                print(f"  ✅ {vol} → {os.path.basename(out_file)} ({size})")
            else:
                print(f"  ❌ {vol} 備份失敗: {result.stderr[:100]}")
        except Exception as e:
            print(f"  ❌ {vol} exception: {e}")
PYEOF

  # --- containers diff ---
  log ""
  log "--- Containers 差異備份 ---"
  python3 - "$diff_result_file" "$BACKUP_DIR" "$TIMESTAMP" "$REPO_ROOT" << 'PYEOF'
import sys, json, os, subprocess

diff_file = sys.argv[1]
backup_dir = sys.argv[2]
timestamp = sys.argv[3]
repo_root = sys.argv[4]

try:
    with open(diff_file) as f:
        diff = json.load(f)
except:
    print("ERROR reading diff")
    sys.exit(1)

ctns = diff.get("containers", [])
force = diff.get("force", False)
dest_dir = f"{backup_dir}/containers"
os.makedirs(dest_dir, exist_ok=True)

if not ctns and not force:
    print("  ✅ containers: 無變動")
else:
    for cname in ctns:
        cid_result = subprocess.run(
            ["docker", "ps", "-q", "--filter", f"name=^{cname}$"],
            capture_output=True, text=True
        )
        cid = cid_result.stdout.strip()
        if not cid:
            print(f"  ⚠️  容器不存在: {cname}")
            continue

        # Export container config
        config_file = f"{dest_dir}/{cname}_diff_config_{timestamp}.json"
        env_file = f"{dest_dir}/{cname}_diff_env_{timestamp}.sh"
        ports_file = f"{dest_dir}/{cname}_diff_ports_{timestamp}.txt"

        # Config JSON
        with open(config_file, "w") as f:
            subprocess.run(["docker", "inspect", cid], stdout=f, text=True)
        print(f"  ✅ {cname} config → {os.path.basename(config_file)}")

        # Env vars (desensitized)
        ev_result = subprocess.run(
            ["docker", "exec", cid, "env"],
            capture_output=True, text=True, timeout=10
        )
        if ev_result.returncode == 0:
            import re
            lines = ev_result.stdout.splitlines()
            masked_lines = []
            for line in lines:
                masked = re.sub(
                    r'(LITELLM_MASTER_KEY|OPENAI_API_KEY|MINIMAX_API_KEY|DATABASE_URL|POSTGRES_PASSWORD|REDIS_PASSWORD|API_KEY|JWT_SECRET)=[^\s]*',
                    r'\1=【已遮蔽】', line
                )
                masked_lines.append(masked)
            with open(env_file, "w") as f:
                f.write("#!/bin/bash\n")
                f.write("\n".join(masked_lines) + "\n")
            print(f"  ✅ {cname} env → {os.path.basename(env_file)}")

        # Ports
        ps_result = subprocess.run(
            ["docker", "port", cid],
            capture_output=True, text=True
        )
        if ps_result.returncode == 0:
            with open(ports_file, "w") as f:
                f.write(ps_result.stdout)
            print(f"  ✅ {cname} ports → {os.path.basename(ports_file)}")
PYEOF

  # --- db (always diff backup - small file) ---
  log ""
  log "--- Database 差異備份 ---"
  DB_PATH="${REPO_ROOT}/data/openclaw_users.db"
  if [[ -f "$DB_PATH" ]]; then
    local DB_DEST="${BACKUP_DIR}/db/openclaw_users_diff_${TIMESTAMP}.db.gz"
    if $DRY_RUN; then
      log "[DRY-RUN] gzip -c \"$DB_PATH\" > \"$DB_DEST\""
    else
      if gzip -c "$DB_PATH" > "$DB_DEST" 2>/dev/null; then
        local DB_SIZE
        DB_SIZE=$(du -h "$DB_DEST" | cut -f1)
        log "✅ db diff → openclaw_users_diff_${TIMESTAMP}.db.gz ($DB_SIZE)"
      else
        log "❌ db 備份失敗"
      fi
    fi
  else
    log "⚠️  db 檔案不存在: $DB_PATH"
  fi
}

# ============================================================
# 步驟 4: 更新 manifest（寫入本次快照作為下次基準）
# ============================================================
update_manifest() {
  local current_state="$1"
  local new_manifest="${BACKUP_DIR}/.diff-manifest.json"

  log_section "更新差異基準清單"

  if $DRY_RUN; then
    log "[DRY-RUN] cp \"$current_state\" \"$new_manifest\""
  else
    if cp "$current_state" "$new_manifest"; then
      log "✅ manifest 已更新: $new_manifest"
    else
      log "❌ manifest 更新失敗"
    fi
  fi
}

# ============================================================
# 步驟 5: 差異清理（只保留最近 N 份差異）
# ============================================================
purge_diff_archives() {
  log_section "差異備份清理"

  local RETENTION=7

  _purge_type() {
    local label="$1"
    local pattern="$2"
    local dir
    dir=$(dirname "$pattern")
    local base
    base=$(basename "$pattern" | sed 's/\*/%s/g')
    local count
    count=$(find "$dir" -name "$(printf "$base" '*')" -type f 2>/dev/null | wc -l)
    count=${count:-0}
    count=$(( count + 0 ))  # coerce to int, handle blank
    if [[ "$count" -gt "$RETENTION" ]]; then
      local excess=$((count - RETENTION))
      log "🗑️  清理 ${label}: 刪除 $excess 份（保留 $RETENTION 份，共 $count 份）"
      if ! $DRY_RUN; then
        find "$dir" -name "$(printf "$base" '*')" -type f -printf '%T+\t%p\n' 2>/dev/null \
          | sort -r | cut -f2 | tail -n +$((RETENTION + 1)) | xargs rm -f 2>/dev/null || true
      fi
    else
      log "✅ ${label}: ${count} 份（無需清理）"
    fi
  }

  _purge_type "configs diff" "${BACKUP_DIR}/configs/configs_diff_*.tar.gz"
  _purge_type "volumes diff" "${BACKUP_DIR}/volumes/*_diff_*.tar.gz"
  _purge_type "containers diff" "${BACKUP_DIR}/containers/*_diff_config_*.json"
  _purge_type "db diff" "${BACKUP_DIR}/db/openclaw_users_diff_*.db.gz"
}

# ============================================================
# 步驟 6: 產出報告
# ============================================================
generate_report() {
  local report_file="${BACKUP_DIR}/backup-diff-report_latest.json"
  local ts_iso
  ts_iso=$(date -Iseconds)

  local configs_size="0" configs_count=0
  local volumes_size="0" volumes_count=0
  local containers_size="0" containers_count=0
  local db_size="0" db_count=0

  configs_size=$(du -sh "${BACKUP_DIR}/configs" 2>/dev/null | cut -f1 || echo "0")
  configs_count=$(find "${BACKUP_DIR}/configs" -name "configs_diff_*" -type f 2>/dev/null | wc -l)
  volumes_size=$(du -sh "${BACKUP_DIR}/volumes" 2>/dev/null | cut -f1 || echo "0")
  volumes_count=$(find "${BACKUP_DIR}/volumes" -name "*_diff_*.tar.gz" -type f 2>/dev/null | wc -l)
  containers_count=$(find "${BACKUP_DIR}/containers" -name "*_diff_config_*.json" -type f 2>/dev/null | wc -l)
  db_size=$(du -sh "${BACKUP_DIR}/db" 2>/dev/null | cut -f1 || echo "0")
  db_count=$(find "${BACKUP_DIR}/db" -name "openclaw_users_diff_*.db.gz" -type f 2>/dev/null | wc -l)

  cat > "$report_file" << EOF
{
  "report_timestamp": "${ts_iso}",
  "backup_type": "differential",
  "backup_root": "${BACKUP_DIR}",
  "manifest": "${DIFF_MANIFEST}",
  "scopes": {
    "configs": { "size": "${configs_size}", "diff_archives": ${configs_count} },
    "volumes": { "size": "${volumes_size}", "diff_archives": ${volumes_count} },
    "containers": { "diff_archives": ${containers_count} },
    "db": { "size": "${db_size}", "diff_archives": ${db_count} }
  }
}
EOF

  log "✅ 報告已寫入: $report_file"
}

# ============================================================
# 主程式
# ============================================================
main() {
  echo "" | tee "$LOG_FILE"
  log_section "差異備份啟動 — ${TIMESTAMP}"
  log "備份根目錄: ${BACKUP_DIR}"
  log "Manifest: ${DIFF_MANIFEST}"
  $DRY_RUN && log "⚠️  DRY-RUN 模式"
  $FORCE_FULL && log "⚠️  FORCE 模式：備份所有有變動的項目"
  log ""

  # 步驟 1: 掃描現有狀態
  CURRENT_STATE=$(build_current_state)
  log_section "掃描現有狀態"
  log "✅ 現有狀態已掃描: $(wc -l < "$CURRENT_STATE") 行"
  log "   檔案: $CURRENT_STATE"

  # 步驟 2: 比對差異
  log_section "比對差異"
  # compute_diff writes results to .diff-result-*.json and prints summary to stdout
  compute_diff "$CURRENT_STATE" "$DIFF_MANIFEST" | while IFS= read -r line; do
    log "$line"
  done

  # 步驟 3: 執行差異備份
  DIFF_RESULT_FILE=$(ls -1 "${BACKUP_DIR}"/.diff-result-*.json 2>/dev/null | head -1 || echo "")
  if [[ -z "$DIFF_RESULT_FILE" ]]; then
    DIFF_RESULT_FILE="${BACKUP_DIR}/.diff-result-${TIMESTAMP}.json"
    echo '{"configs":[],"volumes":[],"containers":[],"db":true}' > "$DIFF_RESULT_FILE"
  fi

  do_diff_backup "$DIFF_RESULT_FILE" "$CURRENT_STATE"

  # 步驟 4: 更新 manifest
  update_manifest "$CURRENT_STATE"

  # 步驟 5: 清理舊差異
  purge_diff_archives

  # 步驟 6: 報告
  generate_report

  # 清理暫存
  rm -f "$CURRENT_STATE" "${BACKUP_DIR}"/.diff-result-*.json 2>/dev/null || true

  log_section "差異備份完成"
  log "完成時間: $(date '+%Y-%m-%d %H:%M:%S')"
  log "日誌檔: ${LOG_FILE}"
}

main

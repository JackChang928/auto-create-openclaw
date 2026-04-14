# Backup & Restore 迭代推進日誌

## 當前任務
**當前任務**: T9（還原機制）
**開始時間**: 2026-04-10T03:38:00Z
**嘗試次數**: 1
**上次結果**: T1 ✅ T2 ✅ T3 ✅ T4 ✅ T5 ✅ T6 ✅ T7 ✅ T8 ✅ 完成

## 嘗試記錄

### Attempt 1 — 2026-04-10T01:12:00Z
- **T1**: ✅ 完成
  - 分析 docker-compose.yml：識別 litellm、postgres、redis、fluent-bit 4 個 images
  - 分析 provisioner.js：識別 DEFAULT_IMAGE `auto-create-openclaw-base:latest`
  - 分析 db.js：識別 SQLite 路徑 `./data/openclaw_users.db`
  - 產出：`scripts/backup/BACKUP_REQUIREMENTS.md`
- **T2**: ✅ 完成
  - 建立 `scripts/backup/backup-docker-images.sh`
  - 支援所有 5 個外部 images + 2 個自建服務（billing-service、auth-service）
  - 自動偵測本地不存在 image 並 skip、保留策略（每 image 4 份）
- **T5**: ✅ 完成
  - 建立 `scripts/backup/backup-db.sh`
  - gzip 壓縮 SQLite、保留 14 份、自动清理舊檔
- **下次目標**: T3 — Docker Volume 備份腳本

### Attempt 3 — 2026-04-10T02:44:00Z
- **T4**: ✅ 完成
  - 建立 `scripts/backup/backup-containers.sh`
  - 使用 `docker inspect` 導出 6 個容器完整配置（litellm-proxy, litellm-postgres, openclaw-redis, fluent-bit, openclaw-billing, openclaw-auth）
  - 動態偵測用戶容器（`openclaw-|auto-create-|cc-` 前綴）
  - 每容器導出 4 個附屬檔：`_config.json`（完整配置）、`_env.sh`（脫敏環境變數）、`_ports.txt`（端口映射）、`_mounts.txt`（掛載點）
  - `container-list_*.txt`（容器狀態快照）、`docker-ps_*.txt`（即時進程）、`containers-overview_*.json`（彙總 JSON）
  - 自動脫敏：LITELLM_MASTER_KEY、OPENAI_API_KEY、MINIMAX_API_KEY、DATABASE_URL、POSTGRES_PASSWORD 等關鍵變數遮蔽
  - 保留策略：每容器配置 4 份、附加檔 4 份
- **下次目標**: T6 — 設定檔備份（litellm_config.yaml、fluent-bit configs）

### Attempt 4 — 2026-04-10T03:07:00Z
- **T6**: ✅ 完成
  - 建立 `scripts/backup/backup-configs.sh`
  - 備份 9 個設定檔：litellm_config.yaml、fluent-bit.conf、parsers.conf、docker-compose.yml、.env（含脫敏+原始副本）、.env.example（含脫敏+原始副本）、openapi.yaml、deploy/standalone/docker-compose.yml、deploy/standalone/.env.example
  - 脫敏遮蔽 22 種敏感變數（LITELLM_MASTER_KEY、OPENAI_API_KEY、MINIMAX_API_KEY、POSTGRES_PASSWORD、DATABASE_URL 等）
  - 每檔案獨立子目錄、latest 連結、summary JSON
  - 備份大小：96K
- **下次目標**: T8 — 差異備份

### Attempt 5 — 2026-04-10T03:25:00Z
- **T7**: ✅ 完成
  - 建立 `scripts/backup/backup-all.sh`（統一備份主控腳本）
  - 整合所有 5 個備份子腳本（images/containers/configs/volumes/db）
  - 統一保留策略：images/containers/configs/volumes 各 4 份、db 14 份
  - 統一報告 JSON（`backup-report_latest.json`）含各子系統大小、檔案數、最新時間戳
  - 統一日誌（`backups/logs/backup-all_TIMESTAMP.log`）
  - 支援 `--skip SCOPE`、`--dry-run`、`--backup-dir` 參數及 `REMOTE_DEST` 環境變數
  - 修復路徑 Bug：5 個子腳本 + 主控腳本的 `REPO_ROOT` 全部統一為 `$(dirname "$(dirname "$SCRIPT_DIR")")`
  - 備份總大小：2.1G（docker-images 2.1G、containers 164K、configs 108K、volumes 7.9M、db 8.0K）
- **下次目標**: T8 — 差異備份

### Attempt 6 — 2026-04-10T03:38:00Z
- **T8**: ✅ 完成
  - 建立 `scripts/backup/backup-diff.sh`（差異備份腳本）
  - 核心機制：比對 `.diff-manifest.json`（上次完整狀態快照）vs 當前狀態
    - configs: SHA256 hash 比對（litellm_config.yaml、fluent-bit configs、docker-compose.yml、.env 等）
    - volumes: Docker UpdatedAt 時間戳比對（litellm_pgdata 等 named volumes）
    - containers: 容器 config.json SHA256 hash 比對
    - db: 始終備份（小檔案，每天合理）
    - images: 跳過（差異無實際意義，每次 pull 差異不同）
  - Python3 做 JSON diff（比 bash 更可靠）
  - 差異檔案命名：`configs_diff_TIMESTAMP.tar.gz`、`*_diff_TIMESTAMP.tar.gz`、`*_diff_config_TIMESTAMP.json`
  - 整合至 backup-all.sh：新增 `--diff` 參數，一個指令切換完整/差異備份
  - 保留策略：差異備份保留 7 份（configs/volumes/containers/db 各自分開計算）
  - 產出 `backup-diff-report_latest.json`
  - DRY-RUN 測試通過
- **下次目標**: T9 — 還原機制

## Phase 2–4 待推進
- T6: ✅ 設定檔備份（litellm_config.yaml、fluent-bit configs）
- T7: ✅ 備份主控腳本整合
- T8: ✅ 差異備份（manifest-based diff）
- T9–T11: 還原機制
- T12–T14: 自動化

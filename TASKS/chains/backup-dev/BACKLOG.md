# Backup & Restore Dev Task Chain

## Phase 1: Docker 實體管理
- [x] **T1**: 識別所有需要備份的 Docker 實體（images、volumes、containers） — ✅ 完成
  - 分析 docker-compose.yml：識別 4 個 Compose images + 2 個自建服務
  - 分析 provisioner.js：識別 DEFAULT_IMAGE `auto-create-openclaw-base:latest`
  - 分析 db.js：識別 SQLite 路徑 `./data/openclaw_users.db`
  - 產出：`scripts/backup/BACKUP_REQUIREMENTS.md`
- [x] **T2**: 實現 Docker image 備份腳本（docker save/load） — ✅ 完成
  - `scripts/backup/backup-docker-images.sh`：支援所有 5 個外部 images + 2 個自建服務
  - 自動偵測本地不存在的 image 並 skip
  - 自動清理（每 image 保留 4 份）
- [ ] **T3**: 實現 Docker volume 備份腳本（docker run --rm -v）
- [ ] **T4**: 實現 Docker container config 導出（docker inspect）

## Phase 2: 用戶資料備份
- [x] **T5**: 實現 SQLite 資料庫備份腳本（.db 複製 + gzip） — ✅ 完成
  - `scripts/backup/backup-db.sh`：gzip 壓縮、保留 14 份、自动清理
- [ ] **T6**: 實現配置檔備份（gateway tokens、openclaw configs）
- [ ] **T7**: 建立備份保留策略（保留最近 N 份）
- [ ] **T8**: 實現差異備份（只備份變更的部分）

## Phase 3: 還原機制
- [ ] **T9**: 實現完整還原腳本（停止服務 → 還原 → 重啟）
- [ ] **T10**: 實現單一用戶資料還原（不影響其他用戶）
- [ ] **T11**: 建立災難復原 SOP 文檔

## Phase 4: 自動化
- [ ] **T12**: 建立每日自動備份 cron job 腳本
- [ ] **T13**: 建立備份驗證機制（定期測試還原）
- [ ] **T14**: 建立異地備份機制（SCP/USB 同步）

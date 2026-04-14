# CI/CD Dev Task Chain

## Phase 1: 基礎 CI
- [x] **T1**: 建立 GitHub Actions workflow 進行 lint + type check
- [ ] **T2**: 建立 GitHub Actions workflow 進行 build
- [ ] **T3**: 建立 GitHub Actions workflow 進行測試

## Phase 2: CD 自動化
- [x] **T4**: 實現 `main` 分支 push 自動部署到 staging 環境
- [x] **T5**: 實現 release tag 自動部署到 production
- [x] **T6**: 實現 Docker image 自動 build 並 push 到 registry

## Phase 3: 監控與報警
- [ ] **T7**: 建立 GitHub Actions 監控 deployment 狀態
- [ ] **T8**: 實現部署失敗時的 GitHub 通知

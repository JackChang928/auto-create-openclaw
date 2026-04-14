# Testing Dev Task Chain

## Phase 1: 測試框架搭建
- [✅] **T1**: 為 server.js 建立基礎單元測試（使用 jest 或 node:test）
- [✅] **T2**: 為 provisioner.js 建立 mock Docker 環境的單元測試
- [✅] **T3**: 建立 auth-service 的單元測試
- [✅] **T4**: 建立 billing-service 的單元測試

## Phase 2: API 整合測試
- [✅] **T5**: 實現 `/api/register` 的整合測試（真實 DB）
- [ ] **T6**: 實現 `/api/instances` 的整合測試
- [ ] **T7**: 實現 `/api/instance/:id/activate` 整合測試（實際創建容器）

## Phase 3: CI 集成
- [ ] **T8**: 在 GitHub Actions 建立測試 workflow
- [ ] **T9**: 實現每次 PR 必須通過所有測試才能合併

## Phase 3: CI 集成
- [ ] **T7**: 在 GitHub Actions 建立測試 workflow
- [ ] **T8**: 實現每次 PR 必須通過所有測試才能合併

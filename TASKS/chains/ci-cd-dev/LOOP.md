# ci-cd-dev 迭代推進日誌

## 當前任務
**當前任務**: T7
**開始時間**: 2026-04-10T19:14:00Z
**嘗試次數**: 0
**上次結果**: T5 ✅ 完成（deploy-staging + deploy-production jobs added; staging deploys on main push, production deploys on tag push; docker-compose.prod.yml + README updated）

## 嘗試記錄
- **T1** (2026-04-10T17:15Z): ✅ 完成
  - 安裝 ESLint v10 + globals
  - 建立 `eslint.config.js`（ESM flat config）
  - 修復 `test-syntax.js` 語法錯誤
  - 建立 `.github/workflows/ci.yml`（lint + typecheck job）
  - 新增 `lint` / `typecheck` script 到 package.json
  - 本地驗證：lint ✅（0 errors, 8 warnings），typecheck ✅

- **T2** (2026-04-10T18:22Z): ✅ 完成
  - 新增 `build` job（依賴 `lint-and-typecheck` needs）
  - 運行 `npm run test`：vitest 77 tests across 2 files
  - 本地驗證：✅ 2 test files, 77 passed, 588ms

- **T3** (2026-04-10T18:41Z): ✅ 完成
  - 新增 `docker-build` job 到 `.github/workflows/ci.yml`（依賴 `build` needs）
  - Job 條件：仅在 push 到 main 或 tag 时运行（跳过 PR）
  - 使用 Docker Buildx + GHCR（GitHub Container Registry）
  - 建置并推送 3 个 image：main app、auth-service、billing-service
  - 建立 `Dockerfile`（root level），使用 node:20-alpine + non-root user
  - 本地驗證：3 个 Docker image 全部 build 成功 ✅

- **T4** (2026-04-10T18:59Z): ✅ 完成
  - 将 `docker-build` job 重命名为 `Docker Build & Scan`
  - 在 job 内集成 Trivy vulnerability scan（docker push 后立即執行）
  - 掃描 3 個 images：auto-create-openclaw、auth-service、billing-service
  - 過濾 CRITICAL + HIGH 漏洞，生成 SARIF 格式報告
  - 透過 `github/codeql-action/upload-sarif` 上傳到 GitHub Security tab
  - Job 權限增加 `security-events: write`
  - 本地驗證：Trivy v0.69.3 成功 scan `auto-create-openclaw-base:latest`（發現 HIGH severity CVEs in node-tar/vite）✅

- **T5** (2026-04-10T19:14Z): ✅ 完成
  - Workflow trigger 新增 `push: tags: - 'v*'` 偵測 release tag
  - 新增 `deploy-staging` job：依賴 docker-build，條件 `github.ref == 'refs/heads/main'`
    - 使用 `appleboy/ssh-action` SSH 到 staging server
    - GHCR login → pull SHA-tagged image → sed 替換 docker-compose.prod.yml → `docker compose up -d --pull always`
  - 新增 `deploy-production` job：依賴 docker-build，條件 `startsWith(github.ref, 'refs/tags/')`
    - 先用 `Set production tag name` step 解析 `refs/tags/v1.2.3` → `TAG=v1.2.3`
    - SSH 到 production server → GHCR login → pull tagged image → 滾動更新
  - 兩 job 均設定 `permissions: packages: read`，並綁定 GitHub Environments（staging/production）
  - YAML 驗證：5 jobs，觸發邏輯正確 ✅

- **T6** (2026-04-10T19:14Z): ✅ 完成（與 T5 同步實作）
  - `docker-build` job 已在 T3/T4 完成，並具備完整 multi-image build + push 能力
  - 新增 `docker-compose.prod.yml`（deploy/standalone/）供部署腳本使用
  - 新增 `.env.prod.example` 供 production 環境變數參考
  - 更新 `deploy/standalone/README.md`：說明 GitHub Actions 部署流程、Variables/Secrets 設定方式

# Docker Dev Task Chain

## Phase 1: 容器化完整性
- [x] **T1**: 驗證 Dockerfile.openclaw 構建成功 ✅
- [x] **T2**: 驗證 docker-compose.yml 網路設定（openclaw_shared_net）✅
- [x] **T3**: 驗證所有服務的 healthcheck 配置 ✅（redis 缺少 healthcheck，見思考筆記）
- [x] **T4**: 驗證 LiteLLM proxy 容器啟動依賴（需要 Postgres ready）
- [x] **T5**: 驗證 Auth Service 容器啟動依賴（需要 Redis ready）

## Phase 2: 部署腳本
- [x] **T6**: 驗證 `start.sh` 完整性 ⚠️（Section 4 空白，建議修補）
- [x] **T7**: 驗證 `.env.example` 包含所有必要變數 ✅
- [x] **T8**: 實現 `deploy/standalone/` 的一鍵部署腳本 ✅（新建 deploy.sh）

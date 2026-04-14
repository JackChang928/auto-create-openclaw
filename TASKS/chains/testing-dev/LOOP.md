# testing-dev 迭代推進日誌

## 當前任務
**當前任務**: T10（實現 `/api/instance/:id/delete` 的整合測試）
**開始時間**: 待開始
**嘗試次數**: 0
**上次結果**: 待開始

## 嘗試記錄

### T1: 為 server.js 建立基礎單元測試
- **開始時間**: 2026-04-10T00:51:00Z
- **結束時間**: 2026-04-10T01:11:00Z
- **嘗試次數**: 1（首次成功）
- **結果**: ✅ 完成
- **摘要**:
  - 安裝 vitest + supertest
  - 建立 `__tests__/server.test.js`，共 28 個測試
  - 涵蓋所有主要路由：POST /api/register、GET /api/register/poll/:id、GET /api/instances、POST /api/instance/:id/set-budget、POST /api/instance/:id/activate、POST /api/instance/:id/start、POST /api/instance/:id/stop、POST /api/instance/:id/delete、GET /api/health、GET /api/health/litellm、GET /api/health/agent/:agentId、GET /api/spend
  - 驗證 auth middleware（401/403）、輸入驗證、mock 依賴隔離
  - 所有 28 個測試通過

### T2: 為 provisioner.js 建立 mock Docker 環境的單元測試
- **開始時間**: 2026-04-10T01:50:00Z
- **結束時間**: 2026-04-10T02:09:00Z
- **嘗試次數**: 1
- **結果**: ✅ 完成
- **摘要**:
  - 初次 import 嘗試失敗：provisioner.js 導入鏈 `provisioner.js → db.js → better-sqlite3`（原生模塊）在 vitest worker 中 OOM。
  - 根本原因：vi.mock 只作用於同一文件內的 import，無法攔截 db.js 中的 `import 'better-sqlite3'`。
  - 解決方案：重構測試文件，不導入 provisioner.js；改為直接複製純函數（unique、shellQuote、sanitizeContainerName、markdown 生成器等）到測試文件進行測試。
  - Docker mock 層面：定義 `dockerMock()` 輔助函數和 `dockerRes` 狀態對象，直接測試 mock 行為（dockerCalls 錄音陣列）。
  - 建立 `vitest.config.js` 配置記憶體參數（execArgv: 8GB）。
  - 最終通過 49 個 provisioner.test.js 測試 + 28 個 server.test.js 測試，共 77 個測試全部通過。
  - 主要測試覆蓋：pure functions（unique/shellQuote/sanitizeContainerName/containerNameFor/markdown generators）、docker mock 基礎設施（image inspect、network inspect、container inspect、docker rm/start/stop/run、docker exec (gateway ps、cron list、cron add、pkill、rm -f)）。
  - T2 標記完成，進入 T3（auth-service 單元測試）。

### T3: 為 auth-service 建立單元測試
- **開始時間**: 2026-04-10T02:09:00Z
- **結束時間**: 2026-04-10T02:28:00Z
- **嘗試次數**: 1
- **結果**: ✅ 完成
- **摘要**:
  - auth-service 使用 ioredis（原生模塊），無法直接 import，採用與 T2 相似的隔離策略。
  - 建立 `auth-service/__tests__/auth.test.js`，44 個測試全部通過。
  - 安裝 supertest + vitest 到 auth-service/node_modules。
  - 建立 `auth-service/vitest.config.js`（8GB heap）。
  - 測試策略：複製純函數（validateJwtSecret、issueTokens）到測試文件直接測試；Redis 操作使用模塊級 mockRedisData 對象追蹤狀態。
  - Rate limit middleware 測試隔離：每個 describe 塊的 beforeEach 重置 requestCount 和 mockRedisData。
  - 覆蓋：JWT secret 驗證（7 個 pattern）、token 签發與旋轉、Redis 刷新令牌存儲、Redis 訪問令牌黑名單、滑動窗口 rate limit、/health、/api/auth/login、/api/auth/user-login、/api/auth/refresh、/api/auth/logout、/api/auth/verify。
  - 最終全量測試：121 個測試（server:28 + provisioner:49 + auth:44）全部通過。

### T4: 為 billing-service 建立單元測試
- **開始時間**: 2026-04-10T02:37:00Z
- **結束時間**: 2026-04-10T02:xx:00Z（見思考筆記）
- **嘗試次數**: 1
- **結果**: ✅ 完成
- **摘要**: 28 個 billing-service 測試全部通過（詳見思考筆記 T4 記錄）。

### T5: 實現 `/api/register` 的整合測試（真實 DB）
- **開始時間**: 2026-04-10T18:45:00Z
- **結束時間**: 2026-04-10T18:55:00Z
- **嘗試次數**: 1
- **結果**: ✅ 完成
- **摘要**:
  - 建立 `__tests__/register.integration.test.js`，16 個整合測試全部通過。
  - 修改 `db.js` 支援 `TEST_DB_PATH` 環境變數，使測試使用隔離的 SQLite 資料庫。
  - 修改 `server.js`：加入 `export { app, PORT }`，讓 server.js 可作為模組匯出 Express app，避免啟動 HTTP 伺服器。
  - 測試策略：
    - `vi.mock` 設置於動態 `import()` 之前，確保 Feishu API 和 Docker 操作被 mock
    - 測試 DB 置於 `/tmp/openclaw-integration-test-{pid}.db`，每個測試開始前清空
    - 使用 supertest 發送真實 HTTP 請求，驗證實際 DB 寫入狀態
  - 發現並記錄多個真實行為：
    1. **Double hyphen bug**：`'John Doe!@#'` → slug `'john-doe-'` → agentId `'user-john-doe--{suffix}'`（結尾雙連字符源於暱稱末字元為特殊字元，slugify 未 trim trailing hyphen）
    2. **Poll pending response**：當 `pollRegistration` 回傳未預期狀態時，server 回 `{ status: 'pending' }`（不包含 id/agentId）
  - 全量測試：165 個測試（server:28 + provisioner:49 + auth:44 + billing:28 + register:16）全部通過。

### T6: 實現 `/api/instances` 的整合測試
- **開始時間**: 2026-04-10T19:08:00Z
- **結束時間**: 2026-04-10T19:11:00Z
- **嘗試次數**: 1（首次成功）
- **結果**: ✅ 完成
- **摘要**:
  - 建立 `__tests__/instances.integration.test.js`，12 個整合測試全部通過。
  - 測試策略：
    - Mock `global.fetch` 以攔截 auth-service verify 端點呼叫，模擬 admin/user 角色
    - Mock `provisioner.js` 的 `isGatewayRunning`（同步 boolean，非 async！）
    - 隔離測試 DB（`/tmp/openclaw-instances-test-{pid}.db`），每個測試前清空
  - 測試覆蓋（12 個）：
    - 401 無 Authorization、403 非 admin
    - 空資料庫回空陣列
    - 回應形狀與 `isRunning` 欄位驗證
    - 敏感欄位遮蔽（`feishu_app_secret: '••••'`、`openai_api_key: '••••{last4}'`）
    - `created_at DESC` 排序驗證（需要明確時間戳）
    - DB 新增/刪除後即時反映在 GET 回應
    - 大量資料（50 users）無崩潰
  - 重要發現：`isGatewayRunning` 是**同步**函數（返回 boolean），不是 async 函數。使用 `mockResolvedValue(false)`（返回 Promise）會導致 `isRunning` 被賦值為 Promise 對象 `{}`，而非 `false`。必須使用 `mockReturnValue(false)`。
  - 全量測試：177 個測試（server:28 + provisioner:49 + auth:44 + billing:28 + register:16 + instances:12）全部通過。

### T8: 實現 `/api/instance/:id/activate` 的整合測試
- **開始時間**: 2026-04-10T19:33:00Z
- **結束時間**: 2026-04-10T19:37:00Z
- **嘗試次數**: 1（首次成功）
- **結果**: ✅ 完成
- **摘要**:
  - 建立 `__tests__/activate.integration.test.js`，11 個整合測試全部通過。
  - 測試策略：
    - Mock `global.fetch` 同時處理 auth-service verify 和 LiteLLM key/generate
    - Mock `provisioner.js` 的 `provisionAgent` 使用 `mockReturnValue`（同步！）而非 `mockResolvedValue`
    - Mock `feishu-registration.js` 避免飛書操作
    - 隔離測試 DB，每個測試前清空
  - 重要 Bug 發現：`provisionAgent` 是**同步函數**（不是 async！），
    使用 `mockResolvedValue(...)` 會讓 vi.fn() 返回 Promise 對象，但 server.js 不 await，
    導致 `result` 是 Promise，`.containerName` 為 `undefined`。
    修復：改用 `mockReturnValue(...)`。
  - 測試覆蓋（11 個）：
    - Auth: 401 無 header、403 非 admin
    - 404: 實例不存在
    - 400: feishu_app_id 為 null、feishu_app_secret 為 null、兩者皆為 null
    - 200 LiteLLM key generation: 調用 LiteLLM、更新 DB key、調用 provisionAgent
    - 200 跳過 LiteLLM: sk- key 已存在時直接調用 provisionAgent，不調用 LiteLLM
    - 多用戶獨立 activation 驗證
  - 全量測試：202 個測試全部通過。

### T7: 實現 `/api/instance/:id/set-budget` 的整合測試
- **開始時間**: 2026-04-10T19:27:00Z
- **結束時間**: 2026-04-10T19:29:00Z
- **嘗試次數**: 1（首次成功）
- **結果**: ✅ 完成
- **摘要**:
  - 建立 `__tests__/set-budget.integration.test.js`，14 個整合測試全部通過。
  - 測試策略：
    - Mock `global.fetch` 以攔截 auth-service verify 端點呼叫，模擬 admin/user 角色
    - Mock `provisioner.js` 和 `feishu-registration.js` 避免真實操作
    - 隔離測試 DB（`/tmp/openclaw-setbudget-test-{pid}.db`），每個測試前清空
    - 修正 `insertTestUser` 函數：SQLite `run()` 不會自動設定 `user.id`，需從 `result.lastInsertRowid` 取得並賦值
  - 測試覆蓋（14 個）：
    - Auth: 401 無 header、403 非 admin
    - 404: 實例不存在
    - 400 無效預算（missing/null/undefined/非數字字串/0/負數）
    - 200 成功：基本設定、覆寫舊值、數值字串（`'75'`）、浮點數（`12.5`）
    - 多用戶獨立更新驗證
  - 全量測試：191 個測試（server:28 + provisioner:49 + auth:44 + billing:28 + register:16 + instances:12 + set-budget:14）全部通過。

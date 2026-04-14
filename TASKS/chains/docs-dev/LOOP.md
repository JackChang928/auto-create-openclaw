# docs-dev 迭代推進日誌

## 當前任務
**當前任務**: T8
**開始時間**: 2026-04-10T19:48:00Z
**嘗試次數**: 0
**上次結果**: 待開始

## 嘗試記錄

---

## 2026-04-10T19:48 UTC — docs-dev Chain

### T7 完成 ✅

**任務**：編寫「管理員操作手冊」

**變更內容**：
新建 `docs/ADMIN_MANUAL.md`，提供完整的管理員操作指南：

**涵蓋內容（9 個章節）**：

1. **管理員身份驗證** — Admin JWT 取得方式（直接登入、管理面板）、Header 格式
2. **實例管理** — 列表、設定預算、激活、啟動、停止、刪除（含 API 路徑、請求/響應範例）
3. **健康監控** — 系統總健康、指定實例存活檢查、LiteLLM Proxy、花費查詢
4. **容器直接運維** — `docker exec` 進入容器、查看日誌、手動重啟、資源監控、停止/啟動/刪除
5. **調整預設工作區內容** — `provisioner.js` 各函式對應的預設檔案說明
6. **重新打包 Base Image** — `docker build` 流程與環境變數設定
7. **實例生命週期狀態圖** — `pending_scan → pending_activation → running → stopped/error/deleted`
8. **常見情境 Standard Operations** — 機器人無回應、回答慢、不再需要服務、全面監控 cron
9. **API 快速參考表** — 11 個管理 API 一覽（誰需要 JWT、GET/POST、方法路徑）

**預算修改行為說明：** 修改預算不影響已存在金鑰，需重新激活才生效，並提供停機 → 重新激活的彌補做法。

**檔案變更**：
- `docs/ADMIN_MANUAL.md` — 新建（7,647 bytes）
- `BACKLOG.md` — T7 `[ ]` → `[✅]`
- `LOOP.md` — 推進至 T8

**下一任務**：T8 — 編寫「故障排除指南」

---

---

## 2026-04-10T19:29 UTC — docs-dev Chain

### T6 完成 ✅

**任務**：編寫「快速開始指南」（5 分鐘內啟動服務）

**變更內容**：
新建 `QUICKSTART.md`，提供新手友好的 5 分鐘快速啟動指南：

**前置需求**：
- Docker 20.10+、Node.js 18+、Bash 相容 shell
- Windows 用戶建議 WSL2

**四大步驟**：
1. 取得程式碼（`git clone`）
2. 設定環境變數（`.env` 填入 `OPENAI_API_KEY`、`LITELLM_MASTER_KEY`、`JWT_SECRET` 等）
3. 一鍵啟動（`bash start.sh`）
4. 驗證服務正常（`docker ps`、開啟 Swagger UI、health check）

**JWT_SECRET 產生方式**：
```bash
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
```

**常見 Q&A（5 個問題覆蓋常見阻礙）**：
- 預設 `OPENAI_API_KEY` 未替換
- Docker 容器啟動失敗
- 埠口被占用
- LiteLLM 403 Forbidden
- 查看服務日志

**目標讀者**：新用戶 / 初次部署者（對比 README.md 為完整架構說明）

**檔案變更**：
- `QUICKSTART.md` — 新建（2,836 bytes）
- `BACKLOG.md` — T6 `[ ]` → `[✅]`
- `LOOP.md` — 推進至 T7

**下一任務**：T7 — 編寫「管理員操作手冊」

---

## 2026-04-10T19:12 UTC — docs-dev Chain

### T5 完成 ✅

**任務**：實現 API 文檔的線上展示（Swagger UI）

**變更內容**：
新增互動式 Swagger UI 文檔，透過 `swagger-ui-express` 整合 `openapi.yaml`：

| 路由 | 方法 | 說明 |
|---|---|---|
| `/docs` | GET | Swagger UI 互動式 API 文件頁面 |
| `/openapi.yaml` | GET | 原始 OpenAPI 3.0 YAML 規格 |

**實作細節**：
- `package.json` — 新增依賴 `swagger-ui-express@^5`
- `server.js` — 新增 2 個路由（`/docs`、`/openapi.yaml`），啟動時輸出 `API Docs` URL
- Swagger UI 配置：`persistAuthorization`、`displayRequestDuration`、`docExpansion: 'list'`
- 自訂 CSS：隱藏 topbar、加大標題間距、scheme 區塊灰底
- `openapi.yaml` 作為靜態檔案由 Express 直接提供（`/openapi.yaml` → 讀取磁碟）
- `node --check server.js` ✅ 語法正確

**檔案變更**：
- `package.json` — 新增 `swagger-ui-express@^5`
- `server.js` — 新增 `swagger-ui-express` import、2 個 JSDoc 路由、啟動訊息更新
- `BACKLOG.md` — T5 `[ ]` → `[✅]`
- `LOOP.md` — 推進至 T6

**下一任務**：T6 — 編寫「快速開始指南」（5 分鐘內啟動服務）

---

## 2026-04-10T18:56 UTC — docs-dev Chain

### T4 完成 ✅

**任務**：為所有 API 端點編寫 OpenAPI/Swagger 規格

**變更內容**：
新建 `openapi.yaml`（OpenAPI 3.0.0），完整覆蓋所有 13 個 API 端點：

| 端點 | 方法 | 標籤 |
|---|---|---|
| `/api/register` | POST | 公開端點 |
| `/api/register/poll/{id}` | GET | 公開端點 |
| `/api/user/me` | GET | 用戶端點 |
| `/api/instances` | GET | 管理員端點 |
| `/api/instance/{id}/set-budget` | POST | 管理員端點 |
| `/api/instance/{id}/activate` | POST | 管理員端點 |
| `/api/instance/{id}/start` | POST | 管理員端點 |
| `/api/instance/{id}/stop` | POST | 管理員端點 |
| `/api/instance/{id}/delete` | POST | 管理員端點 |
| `/api/health/agent/{agentId}` | GET | 管理員端點 |
| `/api/health/litellm` | GET | 管理員端點 |
| `/api/health` | GET | 管理員端點 |
| `/api/spend` | GET | 管理員端點 |

**規格內容**：
- `info` — 標題、版本、認證說明
- `servers` — 本機 `http://localhost:3210`
- `security` — 全域 JWT Bearer 認證
- `tags` — 公開 / 用戶 / 管理員 三組
- `components.schemas` — 14 個 Schema（`InstanceStatus`、`InstanceSummary`、`UserMeResponse`、`RegisterRequest/Response`、`PollResponse`、`SetBudgetRequest`、`ContainerOperationResponse`、`ActivateResponse`、`HealthResponse`、`AgentLivenessResponse`、`LiteLLMHealthResponse`、`SpendResponse`、`Error`）
- `components.parameters` — 4 個 Path/Query 參數（`instanceId`、`agentId`、`registrationId`、`userIdQuery`）
- `components.responses` — 5 個標準錯誤響應（`Unauthorized`、`Forbidden`、`NotFound`、`BadRequest`、`ServerError`）
- 所有端點含 `operationId`、`summary`、`description`、`examples`、`$ref` 鏈接

**YAML 驗證**：`python3 -c "import yaml; yaml.safe_load(...)"` ✅ 語法正確

**檔案變更**：
- `openapi.yaml` — 新建（27,696 bytes）
- `BACKLOG.md` — T4 `[ ]` → `[✅]`
- `LOOP.md` — 推進至 T5

**下一任務**：T5 — 實現 API 文檔的線上展示（Swagger UI）

---

## 2026-04-10T18:38 UTC — docs-dev Chain

### T3 完成 ✅

**任務**：為 `server.js` 編寫 JSDoc 注釋

**變更內容**：
為 `server.js` 中所有 16 個路由處理函式及中介層新增標準 JSDoc 注釋：

| 函式 / 路由 | JSDoc 內容 |
|---|---|
| `requireAdmin` | `@param` req/res/next、`@returns`（透過 next 傳遞）|
| `requireUser` | `@param` req/res/next（含 `req.user` 附加說明）、`@returns` |
| `GET /admin` | `@name`、`@route` |
| `GET /api/user/me` | `@name`、`@route`、`@middleware`、`@returns`、`@throws` |
| `POST /api/register` | `@name`、`@route`、`@param`（userNickname/botNickname）、`@returns`、`@throws`、`@example` |
| `GET /api/register/poll/:id` | `@name`、`@route`、`@param`、`@returns`、`@throws`、`@example` |
| `GET /api/instances` | `@name`、`@route`、`@middleware`、`@returns`、`@throws` |
| `POST /api/instance/:id/set-budget` | `@name`、`@route`、`@middleware`、`@param`、`@returns`、`@throws`、`@example` |
| `POST /api/instance/:id/activate` | `@name`、`@route`、`@middleware`、`@param`、`@returns`、`@throws`、`@example` |
| `POST /api/instance/:id/start` | `@name`、`@route`、`@middleware`、`@param`、`@returns`、`@throws`、`@example` |
| `POST /api/instance/:id/stop` | `@name`、`@route`、`@middleware`、`@param`、`@returns`、`@throws`、`@example` |
| `POST /api/instance/:id/delete` | `@name`、`@route`、`@middleware`、`@param`、`@returns`、`@throws`、`@example` |
| `GET /api/health/agent/:agentId` | `@name`、`@route`、`@middleware`、`@param`、`@returns`、`@throws`、`@example` |
| `GET /api/health/litellm` | `@name`、`@route`、`@middleware`、`@returns`、`@throws`、`@example` |
| `GET /api/health` | `@name`、`@route`、`@middleware`、`@returns`、`@throws`、`@example` |
| `GET /api/spend` | `@name`、`@route`、`@middleware`、`@param`（user_id query）、`@returns`、`@throws`、`@example` |
| `app.listen` | `@listens`、`@fires` |

所有路由皆使用 `@name`（JSDoc 命名）、`@route`（route 命名）、`@middleware`、`@param`/`@returns`/`@throws`、`@example` 等標準標籤，支援 VS Code  IntelliSense 與 JSDoc 工具鏈。

**檔案變更**：
- `server.js` — 新增 16 個路由處理函式及 2 個中介層的 JSDoc
- `BACKLOG.md` — T3 `[ ]` → `[✅]`
- `LOOP.md` — 推進至 T4

**下一任務**：T4 — 為所有 API 端點編寫 OpenAPI/Swagger 規格



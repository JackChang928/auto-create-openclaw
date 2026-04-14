# Auto-Create OpenClaw Service

這個專案是一個自動化配置並管理 OpenClaw 實例的平台，採用現代化的 **微服務架構 (Microservices)** 與 **事件驅動 (Event-Driven)** 設計。

## 架構概覽 (Architecture)

整個系統由多個獨立、無狀態的元件組成，並透過 Docker 與共享虛擬網路進行通訊：

1. **Agent Provisioner (核心服務)**
   - 負責監聽管理端指令，透過 Node.js 腳本動態建立、啟動與銷毀個別用戶的 OpenClaw Docker 容器。
   - 採用 SQLite 記錄用戶資料與狀態。
2. **LiteLLM Proxy (LLM Gateway)**
   - 負責統一管理 OpenAI 金鑰。透過 Postgres 資料庫記錄每把虛擬金鑰的預算，並強制執行花費上限 (Hard Cap)。
3. **Auth Service (授權微服務)**
   - 獨立的身份驗證中心。
   - 負責核發與驗證 Stateless JWT，未來可擴充支援飛書 SSO 登入。
   - 當發生登入或異常行為時，會發送事件到 Redis。
4. **Redis (Pub/Sub)**
   - 擔任系統的 Message Broker，用於服務間的非同步事件傳遞 (Event-Driven)。

## 部署與啟動指南

### 快速啟動 (一鍵腳本)

```bash
# 1. 複製環境變數範本並填入實際 Key
cp .env.example .env
# 編輯 .env，填入 OPENAI_API_KEY、MINIMAX_API_KEY、ADMIN_PASSWORD 等

# 2. 一鍵啟動
bash start.sh
```

`start.sh` 會自動執行：檢查 `.env` → `npm install` → `docker compose up -d --build` → 等待 LiteLLM 與 Auth Service 健康檢查 → 啟動 `node server.js`。

### 手動啟動

```bash
cp .env.example .env   # 編輯 .env
npm install
docker compose up -d --build
node server.js
```

> **注意：** Provisioner 服務會透過 Docker 指令將新產生的 OpenClaw 容器自動加入 `openclaw_shared_net` 網路中，讓它們能夠直接解析 `litellm-proxy` 與 `redis` 的位址。

## 支援模型

| 模型名稱 (LiteLLM) | 實際模型 | 用途 |
|---|---|---|
| `openai/gpt-5.4` | gpt-5.4 | 主要模型 |
| `openai/gpt-4.1-mini` | gpt-4o-mini | 輕量模型 |
| `minimax-cn/MiniMax-M2.7` | MiniMax-M2.7 | 測試用低成本模型 |

模型定義於 `litellm_config.yaml`，虛擬金鑰允許的模型列表在 `server.js` 的 activate 路由中設定。

## API 端點參考

所有 API 均託管於 `http://localhost:3210`，管理路由需攜帶 `Authorization: Bearer <admin_token>` 標頭。

---

### 公開路由

#### `POST /api/register` — 申請新實例（觸發飛書掃碼）

建立用戶記錄並啟動飛書機器人註冊流程。

**請求 body：**
```json
{
  "userNickname": "小明",
  "botNickname": "小明專屬助手"
}
```

**成功響應（200）：**
```json
{
  "success": true,
  "id": 3,
  "agentId": "user-xiaoming-a1b2c3",
  "qrDataUrl": "data:image/png;base64,...",
  "verificationUrl": "https://...",
  "expireIn": 300
}
```

**可能狀態：** `pending_scan` → `pending_activation` → `running` 或 `denied` / `expired`

---

#### `GET /api/register/poll/:id` — 查詢飛書掃碼狀態

輪詢用戶是否已完成飛書授權。

**路徑參數：** `id` — 申請時返回的用戶 ID

**響應（pending）：**
```json
{ "status": "pending" }
```

**響應（完成）：**
```json
{
  "status": "completed",
  "feishuAppId": "cli_xxx",
  "feishuAppSecret": "xxx",
  "message": "飛書機器人建立成功！等待管理員激活。"
}
```

---

### 用戶路由

#### `GET /api/user/me` — 取得目前登入用戶的實例資訊

需 `Authorization: Bearer <user_token>`（由 Auth Service 核發）。

**響應：**
```json
{
  "id": 3,
  "agentId": "user-xiaoming-a1b2c3",
  "userNickname": "小明",
  "botNickname": "小明專屬助手",
  "status": "running",
  "budget": 20,
  "isRunning": true
}
```

---

### 管理路由（需 Admin JWT）

#### `GET /api/instances` — 列出所有實例

**響應：** `User[]`（陣列），各實例包含 `isRunning`、`feishu_app_secret` 顯示為 `••••`。

---

#### `POST /api/instance/:id/set-budget` — 設定花費上限

**路徑參數：** `id` — 實例 ID

**請求 body：**
```json
{ "budget": 50 }
```

**響應：** `{ "success": true }`

---

#### `POST /api/instance/:id/activate` — 激活實例（佈建並啟動容器）

**路徑參數：** `id` — 實例 ID

**說明：** 若用戶尚無有效 OpenAI 金鑰，自動向 LiteLLM 請求虛擬金鑰（`max_budget` 為設定之預算）。接著調用 `provisioner.js` 建立 Docker 容器並啟動 Gateway。

**響應：**
```json
{
  "success": true,
  "status": "running",
  "containerName": "auto-openclaw-user-xiaoming-a1b2c3",
  "containerId": "abc123...",
  "imageName": "auto-create-openclaw-base:latest"
}
```

---

#### `POST /api/instance/:id/start` — 啟動已停止的 Gateway

**響應：**
```json
{ "success": true, "containerName": "...", "containerId": "..." }
```

---

#### `POST /api/instance/:id/stop` — 停止 Gateway

**響應：** `{ "success": true, "containerName": "..." }`

---

#### `POST /api/instance/:id/delete` — 刪除實例

刪除 Docker 容器、釋放埠口、移除資料目錄，並從資料庫刪除記錄。

**響應：** `{ "success": true, "containerName": "..." }`

---

### 健康檢查路由（需 Admin JWT）

#### `GET /api/health` — 系統總健康狀態

同時查詢 LiteLLM 健康狀態與可用模型清單。

**響應：**
```json
{
  "litellm": { "healthy": true, "statusCode": 200, "error": null },
  "models": ["openai/gpt-5.4", "openai/gpt-4.1-mini", "minimax-cn/MiniMax-M2.7"],
  "modelCount": 3,
  "modelError": null,
  "timestamp": "2026-04-10T00:00:00.000Z"
}
```

---

#### `GET /api/health/agent/:agentId` — 指定容器存活檢查

**路徑參數：** `agentId`

**響應：**
```json
{
  "agentId": "user-xiaoming-a1b2c3",
  "alive": true,
  "containerRunning": true,
  "gatewayProcessPresent": true,
  "gatewayResponding": true,
  "timestamp": "2026-04-10T00:00:00.000Z"
}
```

---

#### `GET /api/health/litellm` — LiteLLM Proxy 健康檢查

**響應：**
```json
{
  "url": "http://litellm-proxy:4000/health",
  "healthy": true,
  "statusCode": 200,
  "body": "...",
  "timestamp": "2026-04-10T00:00:00.000Z"
}
```

---

#### `GET /api/spend?user_id=<agentId>` — 用戶花費查詢

**查詢參數：** `user_id`（必填）— 即 `agentId`

**響應：**
```json
{
  "user_id": "user-xiaoming-a1b2c3",
  "totalSpend": 1.23,
  "statusCode": 200,
  "timestamp": "2026-04-10T00:00:00.000Z"
}
```

---

## 容器管理

### 進入用戶容器

```bash
# 列出所有 OpenClaw 容器
docker ps --filter "name=auto-openclaw"

# 進入容器
docker exec -it <container_name> bash

# 常用診斷指令 (在容器內)
cat ~/.openclaw/gateway.log          # 查看 gateway log
openclaw health                      # 健康檢查
openclaw cron list                   # 查看排程任務
openclaw models status               # 查看模型狀態
ls ~/.openclaw/workspace/            # 查看 workspace 檔案
```

### 調整預設工作區設定

如需修改未來新容器的預設工作區文件（如 `BOOTSTRAP.md`、`MEMORY.md`），請編輯 `provisioner.js` 中的 `seedWorkspaceDefaults` 函式：

```
provisioner.js
├── seedWorkspaceDefaults()     ← 工作區文件 (BOOTSTRAP.md, MEMORY.md, ...)
├── patchOpenClawDefaultsForDocker()  ← openclaw.json 設定 (模型、gateway、工具)
└── identityMarkdown()          ← IDENTITY.md (bot 名稱與行為準則)
```

### 重新打包 Base Image

若調整涉及系統層級依賴（如安裝 Python 套件或系統指令），需更新 Dockerfile 並重新打包：

```bash
# 修改 Dockerfile 後
docker build -t my-openclaw:custom .
# 設定環境變數讓 provisioner 使用新 image
export OPENCLAW_DOCKER_IMAGE=my-openclaw:custom
```

## 後續擴充計畫

1. **保護 Provisioner API**：修改 `server.js`，讓敏感的 `/api/instance/*` 路由必須驗證由 Auth Service 發出的 JWT。
2. **事件稽核 (Audit)**：建立一個新的 Worker 服務，訂閱 Redis 的 `auth_events` 頻道，將所有登入事件寫入資料庫或外部日誌系統。
3. **用戶自助平台**：整合飛書 OAuth，讓一般用戶登入查看自己的 OpenClaw 狀態。


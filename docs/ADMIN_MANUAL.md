# 管理員操作手冊

> 本手冊提供平台管理員所需的一切操作指引，涵蓋實例管理、健康監控、容器運維及常見問題處理。
> 所有管理 API 均需持有 **Admin JWT**，由 Auth Service 核發。

---

## 1. 管理員身份驗證

### 1.1 取得 Admin JWT

管理員 JWT 由 Auth Service 核發。透過以下方式之一取得：

**方式一：直接登入（本地開發）**
```bash
curl -X POST http://localhost:3001/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username": "admin", "password": "'$ADMIN_PASSWORD'"}'
```

**方式二：透過管理面板**
直接訪問 `http://localhost:3210/admin`，使用管理員帳密登入，系統會自動取得並維護 JWT。

### 1.2 所有 API 請求的 Header 格式

```http
Authorization: Bearer <your_admin_jwt_here>
Content-Type: application/json
```

---

## 2. 實例（Instance）管理

### 2.1 列出所有實例

```
GET /api/instances
```

**說明：** 列出平台所有已註冊的用戶實例，包含運行狀態、預算、容器是否存活等資訊。敏感資訊（`feishu_app_secret`、`openai_api_key`）已自動遮蔽。

**響應範例：**
```json
[
  {
    "id": 1,
    "agent_id": "user-alice-3f4a2b",
    "user_nickname": "Alice",
    "bot_nickname": "小愛同學",
    "status": "running",
    "budget": 50,
    "isRunning": true,
    "feishu_app_secret": "••••",
    "openai_api_key": "••••sk-xxxx"
  }
]
```

---

### 2.2 設定用戶預算（花費上限）

```
POST /api/instance/:id/set-budget
```

**說明：** 設定 LiteLLM 虛擬金鑰的最大可消費金額。用戶用量達到此上限後，LiteLLM 會阻擋該金鑰的進一步請求。

**請求：**
```json
{ "budget": 50 }
```

**響應：**
```json
{ "success": true }
```

**注意：** 修改預算不會影響已存在的 LiteLLM 金鑰，只在下次激活或重新申請金鑰時生效。如需立即生效，建議搭配「停機 → 重新激活」流程。

---

### 2.3 激活實例（佈建 + 啟動容器）

```
POST /api/instance/:id/activate
```

**說明：** 這是讓新用戶正式上線的核心操作。流程如下：

1. 若用戶尚無有效 OpenAI API Key，自動向 LiteLLM 申請虛擬金鑰（`max_budget` = 預算）
2. 建立 Docker 容器
3. 設定工作區預設檔案（BOOTSTRAP.md、MEMORY.md 等）
4. 安裝飛書插件
5. 啟動 Gateway
6. 設定每日記憶維護 cron job
7. 狀態更新為 `running`

**響應：**
```json
{
  "success": true,
  "status": "running",
  "containerName": "auto-openclaw-user-alice-3f4a2b",
  "containerId": "abc123def456...",
  "imageName": "auto-create-openclaw-base:latest"
}
```

**失敗時：** 實例狀態會被標記為 `error`，詳見伺服器日誌。

---

### 2.4 啟動已停止的 Gateway

```
POST /api/instance/:id/start
```

**說明：** 若容器已存在但 Gateway 进程已停止，可使用此 API 重啟 Gateway（不改變容器狀態）。

**響應：**
```json
{
  "success": true,
  "containerName": "auto-openclaw-user-alice-3f4a2b",
  "containerId": "abc123def456..."
}
```

---

### 2.5 停止 Gateway

```
POST /api/instance/:id/stop
```

**說明：** 停止 Gateway 进程並暫停 Docker 容器。用戶的聊天紀錄和設定不會遺失。

**響應：**
```json
{
  "success": true,
  "containerName": "auto-openclaw-user-alice-3f4a2b"
}
```

---

### 2.6 刪除實例

```
POST /api/instance/:id/delete
```

**說明：** 永久刪除實例，包含以下步驟：

1. 停止並移除 Docker 容器
2. 刪除工作區資料目錄
3. 釋放分配的埠口
4. 刪除資料庫記錄

**⚠️ 警告：此操作不可逆，所有用戶資料將被永久刪除。**

**響應：**
```json
{
  "success": true,
  "containerName": "auto-openclaw-user-alice-3f4a2b"
}
```

---

## 3. 健康監控

### 3.1 系統總健康狀態

```
GET /api/health
```

**說明：** 同時查詢 LiteLLM Proxy 健康狀態與可用模型清單。

**響應：**
```json
{
  "litellm": {
    "healthy": true,
    "statusCode": 200,
    "error": null
  },
  "models": [
    "openai/gpt-5.4",
    "openai/gpt-4.1-mini",
    "minimax-cn/MiniMax-M2.7"
  ],
  "modelCount": 3,
  "modelError": null,
  "timestamp": "2026-04-10T00:00:00.000Z"
}
```

**何時使用：** 日常巡檢、自動化監控告警的前哨檢查。

---

### 3.2 指定實例存活檢查

```
GET /api/health/agent/:agentId
```

**說明：** 檢測特定用戶 Gateway 容器的運行狀態，會同時檢查：
- 容器是否運行中（Docker）
- Gateway 进程是否存在
- Gateway HTTP 服務是否正常響應

**響應：**
```json
{
  "agentId": "user-alice-3f4a2b",
  "alive": true,
  "containerRunning": true,
  "gatewayProcessPresent": true,
  "gatewayResponding": true,
  "timestamp": "2026-04-10T00:00:00.000Z"
}
```

| `alive` 值 | 意義 |
|---|---|
| `true` | 三項檢查全部通過 |
| `false` | 至少一項失敗 |

---

### 3.3 LiteLLM Proxy 健康檢查

```
GET /api/health/litellm
```

**說明：** 直接查詢 LiteLLM Proxy 的 `/health` 端點，確認 LLM 閘道服務是否正常。

**響應：**
```json
{
  "url": "http://litellm-proxy:4000/health",
  "healthy": true,
  "statusCode": 200,
  "error": null,
  "timestamp": "2026-04-10T00:00:00.000Z"
}
```

---

### 3.4 用戶花費查詢

```
GET /api/spend?user_id=<agentId>
```

**說明：** 向 LiteLLM 查詢指定用戶的累計 API 消費金額。

**響應：**
```json
{
  "user_id": "user-alice-3f4a2b",
  "totalSpend": 12.34,
  "statusCode": 200,
  "timestamp": "2026-04-10T00:00:00.000Z"
}
```

**⚠️ 注意：** `user_id` 參數即 `agentId`（非資料庫 ID）。

---

## 4. 容器直接運維

有時需要直接操作 Docker 容器而不透過 API。以下是常用指令：

### 4.1 列出所有 OpenClaw 容器

```bash
docker ps --filter "name=auto-openclaw"
```

### 4.2 進入容器內部

```bash
docker exec -it <container_name> bash
```

### 4.3 查看 Gateway 日誌

```bash
# 即時 tail
docker exec <container_name> tail -f /home/node/.openclaw/gateway.log

# 完整日誌
docker exec <container_name> cat /home/node/.openclaw/gateway.log
```

### 4.4 手動重啟 Gateway 进程

```bash
docker exec <container_name> bash -lc 'pkill -f openclaw-gateway; openclaw gateway run --allow-unconfigured --port 18789 >/home/node/.openclaw/gateway.log 2>&1 &'
```

### 4.5 查看容器健康狀態

```bash
# 容器是否運行
docker inspect -f '{{.State.Running}}' <container_name>

# 容器 IP（用於網路診斷）
docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' <container_name>

# 容器資源使用
docker stats <container_name> --no-stream
```

### 4.6 手動停止 / 啟動容器

```bash
# 停止（相當於 API /stop）
docker stop <container_name>

# 啟動（相當於 API /start）
docker start <container_name>

# 完全刪除（慎用，相當於 API /delete）
docker rm -f <container_name>
```

---

## 5. 調整預設工作區內容

若需修改未來新實例的預設工作區文件（如 BIFF BOOTSTRAP.md、預設 Agent 提示詞等），請編輯 `provisioner.js` 中的以下函式：

| 函式 | 用途 | 產出檔案 |
|---|---|---|
| `seedWorkspaceDefaults()` | 工作區標配文件 | `BOOTSTRAP.md`、`MEMORY.md`、`HEARTBEAT.md`、`TOOLS.md`、`USER.md` |
| `identityMarkdown()` | 機器人身份描述 | `IDENTITY.md` |
| `patchOpenClawDefaultsForDocker()` | OpenClaw 設定 | `openclaw.json`（模型、gateway 設定） |

編輯後，**不會**影響已存在的實例，只對新激活的實例生效。

---

## 6. 重新打包 Base Image

若調整涉及系統層級依賴（如安裝新系統套件、新 CLI 工具），需更新 Dockerfile 並重新打包：

```bash
# 1. 編輯 Dockerfile
vim Dockerfile

# 2. 重新 build
docker build -t auto-create-openclaw-base:latest .

# 3. 確認新 image 可用
docker images auto-create-openclaw-base:latest

# 4. 設定環境變數（可寫入 .env）
export OPENCLAW_DOCKER_IMAGE=auto-create-openclaw-base:latest
```

> 已存在的容器不會自動更新 image。如需對現有容器應用新 image，必須刪除後重新激活。

---

## 7. 實例生命週期狀態圖

```
pending_scan
    ↓（用戶完成飛書掃碼）
pending_activation
    ↓（管理員激活）
running
    ├─→ stop API ──→ stopped
    ├─→ start API ──→ running
    ├─→ delete API ──→ deleted（終態）
    └─→ 錯誤 ──→ error
```

---

## 8. 常見情境 Standard Operations

### 情境 A：用戶反應「機器人沒有回應」

1. 查詢實例狀態：`GET /api/health/agent/:agentId`
2. 若 `alive: false`，登入伺服器檢查容器
   ```bash
   docker ps | grep <agentId>
   docker logs <container_name> --tail 50
   ```
3. 若容器未運行，嘗試重啟：`POST /api/instance/:id/start`
4. 若仍失敗，查看 `gateway.log` 是否有錯誤

### 情境 B：用戶反映「回答變得很慢」

1. 檢查 LiteLLM 健康：`GET /api/health/litellm`
2. 檢查用戶花費是否接近預算上限：`GET /api/spend?user_id=:agentId`
3. 若預算即將用盡，與用戶溝通加碼後使用 `POST /api/instance/:id/set-budget`

### 情境 C：用戶不再需要服務

1. 停機：`POST /api/instance/:id/stop`
2. 確認資料無誤後刪除：`POST /api/instance/:id/delete`

### 情境 D：系統全面監控（cron 自動化建議）

建議設定定時任務，每 5 分鐘輪詢一次所有實例的存活狀態：

```bash
# 列出所有實例
curl -s http://localhost:3210/api/instances \
  -H "Authorization: Bearer $ADMIN_JWT" | \
  jq -r '.[].agent_id' | \
  while read agentId; do
    curl -s "http://localhost:3210/api/health/agent/$agentId" \
      -H "Authorization: Bearer $ADMIN_JWT"
  done
```

---

## 9. API 快速參考表

| 操作 | 方法 | 路徑 | 需 Admin JWT |
|---|---|---|---|
| 列出所有實例 | GET | `/api/instances` | ✅ |
| 設定預算 | POST | `/api/instance/:id/set-budget` | ✅ |
| 激活實例 | POST | `/api/instance/:id/activate` | ✅ |
| 啟動 Gateway | POST | `/api/instance/:id/start` | ✅ |
| 停止 Gateway | POST | `/api/instance/:id/stop` | ✅ |
| 刪除實例 | POST | `/api/instance/:id/delete` | ✅ |
| 系統健康檢查 | GET | `/api/health` | ✅ |
| 實例存活檢查 | GET | `/api/health/agent/:agentId` | ✅ |
| LiteLLM 健康 | GET | `/api/health/litellm` | ✅ |
| 用戶花費查詢 | GET | `/api/spend?user_id=:agentId` | ✅ |
| 互動式 API 文件 | GET | `/docs` | ❌ |
| OpenAPI 規格 | GET | `/openapi.yaml` | ❌ |

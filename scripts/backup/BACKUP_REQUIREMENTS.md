# OpenClaw 備份需求報告

## 備份目標分析

### 1. Docker Images（需備份）

| Image Name | 用途 | 來源 |
|---|---|---|
| `ghcr.io/berriai/litellm:main-latest` | LiteLLM Proxy | docker-compose.yml |
| `postgres:15-alpine` | PostgreSQL（LiteLLM 資料庫）| docker-compose.yml |
| `redis:7-alpine` | Redis 快取 | docker-compose.yml |
| `cr.fluentbit.io/fluent/fluent-bit:3.0.7` | 日誌收集 | docker-compose.yml |
| `auto-create-openclaw-base:latest` | OpenClaw 用戶容器基底鏡像 | provisioner.js DEFAULT_IMAGE |

**自建服務（需 build context）：**
- `billing-service` — 從 `./billing-service` build
- `auth-service` — 從 `./auth-service` build

### 2. Docker Volumes（需備份）

| Volume Name | 掛載點 | 用途 |
|---|---|---|
| `litellm_pgdata` | `/var/lib/postgresql/data` | LiteLLM PostgreSQL 資料庫 |
| （用戶 containers 各有 volume） | OpenClaw 用戶 workspace | `data/instances/{agentId}/openclaw-home/` |

### 3. 路徑（需備份）

| 路徑 | 用途 |
|---|---|
| `./data/openclaw_users.db` | SQLite 主資料庫（用戶、容器、Port Pool） |
| `./data/instances/` | 所有 OpenClaw 用戶 workspace 目錄 |
| `./litellm_config.yaml` | LiteLLM 設定檔 |
| `./fluent-bit/fluent-bit.conf` | Fluent Bit 設定檔 |
| `./fluent-bit/parsers.conf` | Fluent Bit 解析設定 |
| `./billing-service/` | 帳務服務程式碼 |
| `./auth-service/` | 認證服務程式碼 |
| `./.env`（如存在）| 環境變數（含 API keys）|

### 4. SQLite Schema（db.js）

```
users — 主用戶表（id, user_nickname, bot_nickname, agent_id, port, 
              workspace_dir, agent_dir, container_name, container_id,
              image_name, gateway_token, feishu_app_id/secret, openai_api_key, status 等）
port_pool — Port Pool 表（19100-19199）
```

---

## 備份頻率建議

| 項目 | 頻率 | 保留份數 | 理由 |
|---|---|---|---|
| SQLite DB | 每日 1 次 | 14 份（14 天）| 用戶註冊、容器分配資料 |
| Docker Images | 每週 1 次 | 4 份（1 個月）| 減少重複拉取 |
| Docker Volumes | 每週 1 次 | 4 份 | LiteLLM 用量資料 |
| 設定檔 | 每次改動後 | 7 份 | config.yaml 可能頻繁變更 |
| 自建服務 tar | 每週 1 次 | 4 份 | billing-service/auth-service |
| 完整 instance 快照 | 每週 1 次 | 4 份 | 災難還原用 |

---

## 災難還原優先順序

1. **RTO < 1 小時**：LiteLLM Proxy、PostgreSQL、Redis（影響所有用戶）
2. **RTO < 4 小時**：認證服務、帳務服務
3. **RTO < 24 小時**：用戶 workspace（可逐個還原）

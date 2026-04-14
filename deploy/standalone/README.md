# OpenClaw Standalone Deployment

這份指引可以協助您不需要透過伺服器後台（Express Provisioner），就能在任意主機（例如樹莓派、開發機、邊緣伺服器）上透過 Docker 快速部署單一 OpenClaw 助理。

## 目錄結構
- `docker-compose.yml`：Docker Compose 服務配置
- `Dockerfile`：包裝原版鏡像並注入 `entrypoint.sh` 的自訂鏡像
- `entrypoint.sh`：負責在啟動時自動產生 Workspace 檔案、調整 Config 並安裝飛書插件的初始化腳本
- `.env.example`：環境變數範例檔

## 部署教學

1. **準備環境變數**
   ```bash
   cp .env.example .env
   ```

2. **編輯 `.env`**
   打開 `.env` 檔案填入必要的資源：
   - `OPENAI_API_KEY`：這台機器人專用的 OpenAI Token。
   - `USER_NICKNAME`與`BOT_NICKNAME`：這是 AI 的認知與稱呼設定。
   - `FEISHU_APP_ID`與`FEISHU_APP_SECRET`：如果您想讓這個 AI 連接飛書，請在這裡填寫您的自建機器人憑證。

3. **啟動容器**
   ```bash
   docker compose up -d
   ```
   *附註：第一次啟動時，Docker 自動建構（build）映像檔需要花費一點時間。*

4. **查看日誌與驗證**
   如果一切順利，您可以透過日誌查看 Gateway 是否已經跑起來了：
   ```bash
   docker compose logs -f
   ```
   若有配置飛書憑證，日誌裡應該會看到 `@larksuite/openclaw-lark` 安裝成功的提示。

## 獨立版與自動化服務版 (auto-create-openclaw) 的差異
- **自動化服務版** 會將所有使用者的設定、金鑰存於 SQLite 資料庫，並共用同一個 Fluent-bit 日誌紀錄與 LiteLLM Token 管理。
- **獨立部署版 (Standalone)** 所有的設定值完全綁定於當前目錄下 `.env` 以及自動產生的 Volume (`openclaw_standalone_data`)，適合部署為邊緣節點 (Edge Node) 或是獨立專案。

---

## GitHub Actions 生產部署（CI/CD）

### 第一次設定

在 GitHub repository 設定以下 Variables 和 Secrets：

| 類型 | 名稱 | 範例值 |
|------|------|--------|
| Variable | `STAGING_HOST` | `staging.example.com` |
| Variable | `STAGING_SSH_USER` | `ubuntu` |
| Variable | `STAGING_SSH_PORT` | `22` |
| Variable | `PRODUCTION_HOST` | `prod.example.com` |
| Variable | `PRODUCTION_SSH_USER` | `ubuntu` |
| Variable | `PRODUCTION_SSH_PORT` | `22` |
| Secret | `STAGING_SSH_PRIVATE_KEY` | `-----BEGIN OPENSSH PRIVATE KEY-----\n...` |
| Secret | `PRODUCTION_SSH_PRIVATE_KEY` | `-----BEGIN OPENSSH PRIVATE KEY-----\n...` |

### 部署流程

- **Staging**（main branch push）：`deploy-staging` job 自動 SSH 到 staging server，拉取 `main-<sha>` 映像，執行 `docker compose -f docker-compose.prod.yml up -d --pull always`
- **Production**（tag push，如 `v1.2.3`）：`deploy-production` job 自動 SSH 到 production server，拉取 `auto-create-openclaw:v1.2.3` 映像，執行滾動更新

### 第一次設定生產伺服器

在 production server 建立部署目錄：
```bash
mkdir -p ~/auto-create-openclaw-prod
cd ~/auto-create-openclaw-prod

# 放置 docker-compose.prod.yml（從本專案 deploy/standalone/ 目錄複製）
cp /path/to/auto-create-openclaw/deploy/standalone/docker-compose.prod.yml .

# 放置環境變數
cp .env.prod.example .env
nano .env  # 填入真實值

# 測試本地部署
docker compose -f docker-compose.prod.yml pull
docker compose -f docker-compose.prod.yml up -d
docker compose -f docker-compose.prod.yml ps
```

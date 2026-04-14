# 🚀 快速開始指南

**目標：5 分鐘內啟動 Auto-Create OpenClaw 服務**

---

## 前置需求

| 軟體 | 最低版本 | 檢查指令 |
|------|---------|---------|
| [Docker](https://docs.docker.com/get-docker/) | 20.10+ | `docker --version` |
| [Node.js](https://nodejs.org/) | 18+ | `node --version` |
| Bash 相容 shell | — | WSL2 / Linux 原生 terminal |

> 💡 **Windows 用戶**：建議使用 WSL2 + Ubuntu，或使用 Docker Desktop 內建的 Linux 容器模式。

---

## 第一步：取得程式碼

```bash
git clone <repo-url>
cd auto-create-openclaw
```

---

## 第二步：設定環境變數

```bash
cp .env.example .env
```

用文字編輯器開啟 `.env`，填入以下必要資訊：

```env
# 必填：你的 OpenAI API Key（從 https://platform.openai.com/api-keys 取得）
OPENAI_API_KEY=sk-proj-xxxxxxxxxxxxxxxxxxxx

# 必填：LiteLLM 主金鑰（任意亂數字串，用於代理認證）
LITELLM_MASTER_KEY=sk-任意隨機字串

# 必填：JWT 密鑰（產生方式見下方）
JWT_SECRET=（執行以下指令產生）
#   node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"

# 必填：管理員帳號密碼
ADMIN_USERNAME=admin
ADMIN_PASSWORD=你的強密碼

# 選填：MiniMax API Key（用於低成本模型）
MINIMAX_API_KEY=

# 選填：Gemini API Key
GEMINI_API_KEY=
```

> ⚠️ **安全提醒**：`ADMIN_PASSWORD` 預設為 `admin123`，**正式環境請務必更改**。

---

## 第三步：一鍵啟動

```bash
bash start.sh
```

腳本會自動完成：
1. ✅ 檢查 `.env` 設定
2. ✅ 安裝 Node.js 依賴 (`npm install`)
3. ✅ 建置自訂 OpenClaw 基礎映像檔（Docker）
4. ✅ 啟動基礎設施（LiteLLM Proxy、Auth Service、Redis、Postgres）
5. ✅ 啟動 Provisioner API 服務

---

## 第四步：驗證服務正常

### 查看服務狀態

```bash
# 查看所有容器是否正常運行
docker ps --filter "name=auto-create-openclaw"
```

正常輸出應包含：`litellm-proxy`、`auth-service`、`redis`、`postgres`、`auto-create-openclaw-server`

### 開啟互動式 API 文件

在瀏覽器打開：
```
http://localhost:3210/docs
```

可在此頁面試玩所有 API 端點。

### 健康檢查

```bash
curl http://localhost:3210/api/health \
  -H "Authorization: Bearer <你的 ADMIN_PASSWORD>"
```

正常響應：
```json
{
  "litellm": { "healthy": true },
  "models": ["openai/gpt-5.4", "openai/gpt-4.1-mini", "minimax-cn/MiniMax-M2.7"],
  "modelCount": 3
}
```

---

## 常見問題

### Q1：啟動腳本停在「請在 .env 中填入真實的 OPENAI_API_KEY」
**原因**：`.env` 中的 `OPENAI_API_KEY` 仍是預設值。  
**解決**：編輯 `.env`，將 `OPENAI_API_KEY=your-openai-key-here` 替換為真實金鑰，儲存後重新執行 `bash start.sh`。

### Q2：Docker 容器啟動失敗
**解決**：
```bash
# 查看詳細錯誤
docker compose logs

# 確認 Docker daemon 正在運行
sudo systemctl start docker   # Linux
# 或重啟 Docker Desktop      # Windows/macOS
```

### Q3：埠口 3210 / 4000 被占用
**解決**：編輯 `docker-compose.yml` 或 `server.js` 中的 `PORTS` 設定，使用其他埠口。

### Q4：LiteLLM 回應 403 Forbidden
**原因**：`LITELLM_MASTER_KEY` 與 `.env` 中設定的不一致。  
**解決**：確認 `docker-compose.yml` 中 `LITELLM_MASTER_KEY` 環境變數與 `.env` 一致。

### Q5：如何查看服務日志？
```bash
# 即時查看所有容器日志
docker compose logs -f

# 只看 Provisioner (server.js)
docker compose logs -f app

# 看特定容器
docker compose logs -f litellm-proxy
```

---

## 下一步

- 📖 完整 API 文件：http://localhost:3210/docs
- 📋 管理員操作手冊：見 `docs/ADMIN.md`（即將提供）
- 🔧 故障排除：見 `docs/TROUBLESHOOTING.md`（即將提供）
- 🧑‍💻 進入用戶容器：`docker exec -it <container_name> bash`

---

*服務於 `http://localhost:3210` 啟動完成！🎉*

# OpenClaw WSL 開發與測試接棒計畫

本計畫文件旨在交棒給下一個 Agent，於 WSL (Ubuntu) 環境中接續進行 Auto-Create OpenClaw 系統的開發、測試與優化。

## 當前系統狀態 (已完成)
- **架構優化**：修復了 `server.js` 在 Windows 下的路徑崩潰問題 (`db.js`)，並補上了 CORS，使其能跨網域與前端對接。
- **認證機制**：`auth-service` 已實作 `/api/auth/login` (管理員) 與 `/api/auth/user-login` (一般用戶)，並會簽發無狀態 JWT。
- **前端串接**：`public/index.html` 已實作真實 API 登入並動態獲取用戶儀表板資料 (`GET /api/user/me`)。`public/admin.html` 也已補上管理員登入 Modal。
- **微服務通訊**：`server.js` 中的管理員與用戶路由已加上 `requireAdmin` 及 `requireUser` 中介軟體，並會呼叫 `auth-service` 進行 Token 驗證。

## 下一步行動清單 (TODO)

### 任務 1：一鍵啟動與全流程驗證
- **1-1：建立一鍵啟動腳本**
  - 建立 `start.sh` (Linux/WSL) 腳本。
  - 腳本內容需包含：檢查 `.env`、執行 `npm install`、執行 `docker-compose up -d` 啟動基礎設施，最後啟動 `node server.js`。
- **1-2：端到端 (E2E) 測試**
  - 在 WSL 中執行 `start.sh`。
  - 開啟本地瀏覽器訪問 `http://localhost:3210/`。
  - 測試**前端註冊流程**：填寫稱呼 $\rightarrow$ 獲取飛書授權 QR Code $\rightarrow$ 手機掃碼授權 $\rightarrow$ 確認前端跳轉至「等待分配算力」。
  - 測試**管理員激活流程**：訪問 `http://localhost:3210/admin` $\rightarrow$ 登入管理員 $\rightarrow$ 點擊「Activate」按鈕，確認能成功呼叫 Docker API 建立並啟動該用戶專屬的 OpenClaw 容器。

### 任務 2：整合 MiniMax 模型 (測試專用)
目前預設模型是 OpenAI (`gpt-4.1-mini` 等)，因為有便宜的 MiniMax API Key 可以測試，需要將其加入系統。
- **2-1：修改 LiteLLM 網關配置**
  - 更新 `./litellm_config.yaml` 或在 `provisioner.js` 生成虛擬 Key 的邏輯中（`models` 陣列），加入對 `minimax-cn/MiniMax-M2.7` 的支援。
- **2-2：修改 Provisioner 模型預設值**
  - 在 `provisioner.js` 中的 `seedWorkspaceDefaults` 函式，修改寫入 `BOOTSTRAP.md` 或其他相關設定檔的預設模型為 `minimax-cn/MiniMax-M2.7`。
  - 確保環境變數（如果 MiniMax 需要特定的 Base URL 或 Header，需一併透過 LiteLLM 處理好）。

### 任務 3：Agent 容器設定調整與 Base Image 重新打包
用戶（管理員）會手動進入啟動後的 OpenClaw 容器內部，進行設定檔調整與預設 Skill 的安裝測試。
- **3-1：提供進入容器的指令指引**
  - Agent 需輔助列出進入容器的指令：`docker exec -it <container_name> bash`。
- **3-2：協助測試與調整**
  - 根據用戶在容器內的測試反饋，Agent 需協助調整對應的啟動參數或環境變數配置。
- **3-3：更新 Seed 流程或重新打包 Base Image**
  - **選項 A (推薦)**：如果調整的是工作區配置（如安裝特定 Skill、修改 `HEARTBEAT.md`），則更新 `provisioner.js` 裡的 `seedWorkspaceDefaults` 函式，讓未來新建立的實例都能自動套用這些設定。
  - **選項 B**：如果調整涉及系統層級依賴（如安裝新的 Python 套件或系統指令），則需協助撰寫或更新 `Dockerfile`，並重新打包成新的 Base Image，供後續 `provisioner.js` 呼叫。
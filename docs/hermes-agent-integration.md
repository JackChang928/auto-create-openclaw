# Hermes Agent 整合分析

> **文檔狀態**：調研完成，待實現
> **調研時間**：2026-04-15
> **依據**：Hermes Agent Docker 文檔 + 現有 provisioner.js 分析

---

## 一、Hermes Agent 概述

Hermes Agent 是 [NousResearch](https://github.com/nousresearch/hermes-agent) 開發的現代化 AI Agent，專注於多頻道支援（ Telegram / Discord / Slack / WhatsApp / Email / Signal）。

**與 auto-create-openclaw 的定位差異**：

| 維度 | auto-create-openclaw | Hermes Agent |
|------|---------------------|--------------|
| 架構 | Node.js 微服務工廠 | Python CLI + Gateway |
| 目標用戶 | 多租戶商業平台 | 單人/團隊助手 |
| 頻道支援 | 需手動適配 | 內建多頻道 |
| 更新頻率 | NousResearch 活躍維護 | 活躍 |

---

## 二、Docker 部署要點

### 官方 Image
```
nousresearch/hermes-agent:latest
```

### 核心差異（ vs OpenClaw）

| 項目 | OpenClaw | Hermes Agent |
|------|----------|--------------|
| 數據目錄 | 分散（workspace/ + config） | 統一：`/opt/data` → host `~/.hermes/` |
| 狀態儲存 | SQLite + 文件 | 全部在 `/opt/data` |
| 啟動命令 | `openclaw gateway` | `gateway run` |
| API Keys | 環境變數 | `.env` 文件 |
| 內建技能 | OpenClaw Skills | Hermes Skills |
| 記憶系統 | SOUL.md + memory/ | SOUL.md + memories/ |

### /opt/data 目錄結構
```
.env           — API keys 和 secrets
config.yaml    — 所有 Hermes 配置
SOUL.md        — Agent 人格/身份
sessions/      — 對話歷史
memories/      — 持久化記憶
skills/        — 已安裝技能
cron/          — 排程任務定義
hooks/         — 事件鉤子
logs/          — 運行日誌
skins/         — CLI 自訂外觀
```

### 運行模式
```bash
# 互動式設定精靈（首次）
docker run -it --rm -v ~/.hermes:/opt/data nousresearch/hermes-agent setup

# Gateway 模式（後台運行，多頻道）
docker run -d \
  --name hermes \
  --restart unless-stopped \
  -v ~/.hermes:/opt/data \
  nousresearch/hermes-agent gateway run
```

### 資源需求
| 資源 | 最小 | 推薦 |
|------|------|------|
| Memory | 1 GB | 2–4 GB |
| CPU | 1 core | 2 cores |
| Disk | 500 MB | 2+ GB |

> ⚠️ Browser 自動化（Playwright/Chromium）是最耗記憶的功能。如不需要，1 GB 足夠；需要時建議 2 GB+。

---

## 三、整合方案設計

### 3.1 整合理念

將 Hermes Agent 作為 **Agent 類型選項**，用戶在建立實例時可以選擇：

```
選擇 Agent 類型：
  [ ] OpenClaw 標準助手（飛書/Telegram/Discord）
  [x] Hermes Agent（更現代，預設多頻道）
```

### 3.2 架構差異

```
OpenClaw 實例：
  openclaw-{userId}-{shortId}/
    ├── workspace/       ← 用戶 workspace
    └── openclaw.json    ← channel config

Hermes 實例：
  hermes-{userId}-{shortId}/   ← 對應 ~/.hermes
    ├── .env
    ├── config.yaml
    ├── SOUL.md
    ├── sessions/
    ├── memories/
    ├── skills/
    └── ...
```

### 3.3 需要的程式碼變更

#### A. `provisioner.js` — 新增 `agentType: 'hermes'` 支援

**需修改 `createContainer()` 函數**：
```javascript
// 新增參數
function createContainer({ containerName, port, imageName, openclawHome, 
  openaiApiKey, gatewayToken, geminiApiKey, minimaxApiKey, agentType }) {
  
  removeContainer(containerName);
  
  const isHermes = agentType === 'hermes';
  const dataVolume = isHermes 
    ? `${openclawHome}/hermes_data:/opt/data`  // mount ~/.hermes/ 目錄
    : null;
  
  const args = [
    'docker', 'run', '-d',
    '--name', containerName,
    '--restart', 'unless-stopped',
    '--memory', isHermes ? '4g' : '2g',
    '--cpus', isHermes ? '2' : '1',
  ];
  
  if (isHermes) {
    args.push('-v', `${openclawHome}/hermes_data:/opt/data`);
    if (needsBrowserTools) args.push('--shm-size=1g');
  }
  
  // ... port mapping, env vars ...
  
  args.push(imageName);
  if (isHermes) {
    args.push('gateway', 'run');
  }
  
  run('docker', args, { stdio: 'inherit' });
}
```

**新增 `bootstrapHermesAgent()` 函數**：
```javascript
async function bootstrapHermesAgent(containerName, openclawHome, options = {}) {
  const { openaiApiKey, anthropicApiKey, telegramBotToken, discordBotToken } = options;
  
  // 1. 確保數據目錄存在
  const dataDir = `${openclawHome}/hermes_data`;
  fs.mkdirSync(dataDir, { recursive: true });
  
  // 2. 生成 .env 文件
  const envContent = [
    `OPENAI_API_KEY=${openaiApiKey || ''}`,
    `ANTHROPIC_API_KEY=${anthropicApiKey || ''}`,
    telegramBotToken ? `TELEGRAM_BOT_TOKEN=${telegramBotToken}` : '',
    discordBotToken ? `DISCORD_BOT_TOKEN=${discordBotToken}` : '',
  ].filter(Boolean).join('\n');
  
  fs.writeFileSync(`${dataDir}/.env`, envContent);
  
  // 3. 複製預設 config.yaml
  // ...
  
  // 4. 啟動容器（如果尚未運行）
  ensureContainerStarted(containerName);
}
```

#### B. `server.js` — 新增 Hermes 建立 API

```javascript
// POST /api/instance/hermes (新建 Hermes 實例)
app.post('/api/instance/hermes', async (req, res) => {
  const { userId, agentId, openaiApiKey, anthropicApiKey, 
          telegramBotToken, discordBotToken } = req.body;
  
  // 驗證參數...
  const containerName = `hermes-${userId}-${shortId()}`;
  
  // 建立數據目錄 + .env
  await bootstrapHermesAgent(containerName, openclawHome, {
    openaiApiKey, anthropicApiKey, telegramBotToken, discordBotToken
  });
  
  // 建立容器
  createContainer({
    containerName,
    imageName: 'nousresearch/hermes-agent:latest',
    agentType: 'hermes'
  });
  
  // 寫入 DB
  await db.createInstance({ userId, agentId, containerName, agentType: 'hermes', ... });
  
  res.json({ success: true, containerName });
});
```

#### C. `src/opstools.js` — 新增 `hermes` 子命令

```javascript
// 新增命令
case 'hermes':
  if (!args[0]) return console.log('Usage: opstools.js hermes <containerName> [logs|stats|restart]');
  return runHermesCommand(args[0], args[1]);

case 'hermes-list':
  return listHermesInstances();  // 列出所有 Hermes 實例
```

### 3.4 差異化 UI 設計

**實例卡片差異**：

| 欄位 | OpenClaw 實例 | Hermes 實例 |
|------|--------------|-------------|
| Agent 類型 | 🖥️ OpenClaw | 🤖 Hermes |
| 容器 Image | `openclaw/openclaw:latest` | `nousresearch/hermes-agent:latest` |
| 預設端口 | 191XX | 無（Gateway 模式） |
| 狀態監控 | `container-stats` | `hermes stats` |
| 配置方式 | Channel config JSON | `.env` + `config.yaml` |

---

## 四、實現評估

### 工作量估算

| 工作項 | 預估時間 |
|--------|---------|
| provisioner.js 新增 `agentType: 'hermes'` | 2-3 小時 |
| server.js 新增 `/api/instance/hermes` 路由 | 1 小時 |
| 數據目錄初始化邏輯 | 1 小時 |
| `opstools.js` hermes 子命令 | 1 小時 |
| 測試（docker run + 驗證） | 2 小時 |
| **總計** | **7-8 小時** |

### 風險評估

| 風險 | 等級 | 緩解措施 |
|------|------|---------|
| Hermes 更新導致不相容 | 中 | 鎖定 image tag，定期評估更新 |
| 雙實例數據目錄競爭 | 高 | `container_name` 唯一 + 文檔警告 |
| Browser tools 記憶體爆滿 | 中 | 預設 4GB memory limit |
| Python 環境依賴問題 | 低 | 官方 image 已包好 |

---

## 五、决策事項（待主人裁決）

1. **是否要實現 Phase 3？** 目前平台已具備足夠功能，Hermes 是差異化選項
2. **Hermes API Key 由誰提供？** 用戶自帶 vs 平台代管
3. **是否要支持 Hermes 的 browser tools？** 記憶體需求較高
4. **定價差異？** Hermes 資源需求更高，是否要額外收費

---

## 六、參考文檔

- [Hermes Agent Docker 文檔](https://hermes-agent.nousresearch.com/docs/user-guide/docker/)
- [Hermes Agent GitHub](https://github.com/nousresearch/hermes-agent)
- [Hermes Telegram 整合](https://hermes-agent.nousresearch.com/docs/user-guide/messaging/telegram)
- [Hermes Discord 整合](https://hermes-agent.nousresearch.com/docs/user-guide/messaging/discord)

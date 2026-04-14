# 多頻道擴展提案：auto-create-openclaw 的頻道矩陣化

> **提案狀態**：背景研究中，待主人裁決
> **調研時間**：2026-04-13 12:58 起 background 研究
> **依據**：OpenClaw 文檔 + Hermes Agent 文檔 + 現有原始碼分析

---

## 1. 現況診斷

### 1.1 auto-create-openclaw 現有頻道支援

| 頻道 | 支援狀態 | 實現方式 |
|------|---------|---------|
| 飛書 | ✅ 完全 | OAuth device code flow → 掃碼建立機器人 → 拿 client_id/secret |
| Telegram | ❌ 未支援 | 只有 OpenClaw 層面的 token 設定，無自動化工廠 |
| Discord | ❌ 未支援 | 同上 |
| WhatsApp | ❌ 未支援 | 同上 |

**現有 `feishu-registration.js` 的核心模式**（可複用）：
```
init() → begin() → [顯示 QR/URL] → poll() → [回傳 credentials]
```

**`provisioner.js` 關鍵發現**：
- `patchFeishuPostInstall()` 是關鍵：它在用戶完成飛書掃碼後，把 `domain` + `openId` 寫入 `openclaw.json` 的 `config.channels.feishu`
- 容器重啟後，新頻道自動生效
- **這就是多頻道擴展的切入點**：`patchChannelPostInstall(channel, credentials)` 函數

### 1.2 OpenClaw 內建支援的頻道（20+）

```
bluebubbles, discord, feishu, googlechat, imessage, irc, line,
matrix, mattermost, msteams, nextcloud-talk, nostr, openclaw-weixin,
signal, slack, synology-chat, telegram, twitch, whatsapp, zalo, zalouser
```

---

## 2. 頻道價值分析

### 2.1 候選頻道評估矩陣

| 頻道 | 用戶滲透 | 開發難度 | 營收潛力 | 策略價值 | 優先級 |
|------|---------|---------|---------|---------|--------|
| **Telegram** | 🌏全球, 中國大陸易取得 | ⭐ 低（BotFather 極簡）| ⭐⭐⭐ 潛力高 | ⭐⭐⭐ 默認助手頻道 | **P0** |
| **Discord** | 🌏全球, 開發者社區 | ⭐⭐ 中（OAuth + Bot Portal）| ⭐⭐⭐ 潛力高 | ⭐⭐⭐ 社群運營核心 | **P1** |
| **WhatsApp** | 🌏全球, 東南亞/台灣 | ⭐⭐⭐ 高（QR綁定+電話需求）| ⭐⭐⭐ 潛力高 | ⭐⭐ 個人助理 | P2 |
| LINE | 台灣/日本 | ⭐⭐⭐ 高（官方審核機制）| ⭐⭐⭐ 潛力高 | ⭐⭐ 台灣市場 | P2 |
| Slack | 企業市場 | ⭐⭐ 中 | ⭐⭐⭐ 企業方案 | ⭐⭐ 企業核心 | P1 |

### 2.2 為何優先做 Telegram

**理由一：開發者進入門檻最低**
- 只需跟 @BotFather 拿 token，5 分鐘完成
- 不需要企業審核 / 電話號碼 / QR 掃描

**理由二：用戶體驗最流暢**
- 對話框 / 命令列 / 家庭作業 bot 的默認形象
- pairing 機制 already 内建于 OpenClaw

**理由三：市場定位**
- 技術用戶的主要入口
- 與飛書互補（Telegram 面向個人，飛書面向企業）

---

## 3. 技術實現方案

### 3.1 核心切入點：patchChannelPostInstall

現有的 `patchFeishuPostInstall()` 模式：

```javascript
// provisioner.js 中的 patchFeishuPostInstall（已存在）
function patchFeishuPostInstall(openclawHome, { domain, openId }) {
  const config = readConfig(openclawHome);
  config.channels.feishu.domain = domain;
  config.channels.feishu.allowFrom = [...prev.allowFrom, openId];
  writeConfig(openclawHome, config);
}
```

**推廣為通用版本**：

```javascript
// 新增：patchChannelPostInstall
function patchChannelPostInstall(openclawHome, channel, credentials) {
  const config = readConfig(openclawHome);
  if (!config.channels) config.channels = {};
  
  switch (channel) {
    case 'telegram':
      config.channels.telegram = {
        enabled: true,
        botToken: credentials.botToken,
        dmPolicy: 'pairing',   // 或 'allowlist' + allowFrom
        groups: { '*': { requireMention: true } }
      };
      break;
    case 'discord':
      config.channels.discord = {
        enabled: true,
        token: credentials.botToken,
        dmPolicy: 'pairing',
        // intents 等
      };
      break;
  }
  writeConfig(openclawHome, config);
}
```

### 3.2 Telegram Adapter 實現路徑

**Step 1: Bot Token 獲取（無需 OAuth，用户自行到 BotFather 建立）**
```
用戶輸入：BotFather @username / bot token
系統調用：https://api.telegram.org/bot<token>/getMe 驗證
```

**Step 2: Token 有效性校驗 + 寫入配置**
```javascript
// src/channels/telegram-adapter.js
export async function validateAndSetupTelegram(token, openclawHome) {
  // 1. 驗證 token
  const res = await fetch(`https://api.telegram.org/bot${token}/getMe`);
  const data = await res.json();
  if (!data.ok) throw new Error('Invalid Telegram bot token');
  
  // 2. 嘗試發送測試訊息給管理員
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    body: JSON.stringify({ chat_id: ADMIN_TELEGRAM_ID, text: '✅ Token 驗證成功' })
  });
  
  // 3. 寫入 openclaw.json
  patchChannelPostInstall(openclawHome, 'telegram', { botToken: token });
  
  return { success: true, botUsername: data.result.username };
}
```

**Step 3: 容器重啟生效**
```javascript
// 在 provisioner.js 的 activate 流程中新增
stopGateway({ agentId });
startGateway({ agentId });
```

### 3.3 Discord Adapter 實現路徑

Discord 比較麻煩，需要 OAuth 流程：

```
1. 用戶在 Discord Developer Portal 建立 Application + Bot
2. 系統生成 OAuth URL → 用戶點擊 → 同意添加 Bot 到 Server
3. 用戶拿 Bot Token（Discord Developer Portal）貼入系統
4. 系統校驗 + 寫入配置
```

**OAuth URL 生成**：
```javascript
function generateDiscordOAuthUrl(appId, redirectUri) {
  const PERMISSIONS = '36766784'; // 視圖、發消息、讀消息歷史...
  return `https://discord.com/api/oauth2/authorize?client_id=${appId}&permissions=${PERMISSIONS}&scope=bot`;
}
```

### 3.4 Hermes Agent 對比

| 維度 | auto-create-openclaw | Hermes Agent |
|------|---------------------|-------------|
| 架構 | Node.js 微服務 + Docker | Python CLI + Gateway |
| 頻道支援 | 20+（需手動適配）| Telegram/Discord/Slack/WhatsApp/Signal/Email |
| 機器人建立 | 自家工廠流程 | 用戶自行在平台建立 |
| 部署方式 | Docker Compose（全托管）| Docker/SSH/Modal/Daytona |
| 設計理念 | 多租戶工廠 | 單人/團隊助手 |
| 更新頻率 | NousResearch 2天前還在更新 | 活躍 |

**核心結論**：Hermes Agent 是**更現代的單一助手方案**，而 auto-create-openclaw 是**多租戶工廠**。

**僕人建議**：將 Hermes Agent 作為「Agent 類型」選項：
```
用戶選擇：
  [ ] OpenClaw 標準助手（飛書/Telegram/Discord）
  [ ] Hermes Agent（更現代，默認多頻道）
```

---

## 4. API 路由設計

### 4.1 新增 REST 端點

```javascript
// POST /api/channel/telegram/setup
// Body: { agentId, botToken }
// 流程：校驗 token → 寫入 openclaw.json → 重啟容器

// POST /api/channel/discord/setup  
// Body: { agentId, botToken, appId }
// 流程：生成 OAuth URL → 用戶確認 → 回調

// GET /api/channel/discord/oauth-url?agentId=xxx
// 回傳：{ oauthUrl: 'https://discord.com/api/oauth2/authorize?... ' }

// POST /api/channel/discord/callback
// OAuth 回調，標記 Bot 已添加到 Server

// DELETE /api/channel/:channel
// 移除頻道：刪除配置 → 重啟容器
```

---

## 5. 實施路線圖

### Phase 1: Telegram 工廠化（P0，預估 2-3 小時）
- [ ] 建立 `src/channels/telegram-adapter.js`
- [ ] 在 `server.js` 加入 `POST /api/channel/telegram/setup` 路由
- [ ] 在 `provisioner.js` 加入 `patchChannelPostInstall()` 
- [ ] 單元測試：token 有效性校驗

### Phase 2: Discord 支援（P1，預估 4-6 小時）
- [ ] 建立 `src/channels/discord-adapter.js`
- [ ] OAuth 邀請連結生成 + 回調處理的完整 flow
- [ ] Discord API 校驗 Bot 是否已添加到 Server

### Phase 3: Hermes Agent 整合（P1，預估 6-8 小時）
- [ ] 研究 Hermes Agent Docker 部署參數
- [ ] 在 provisioner.js 加入 `agentType: 'hermes'` 選項
- [ ] 差異化 UI：容器鏡像差異、端口差異

### Phase 4: 其他頻道（P2，按需）
- WhatsApp（需要電話 + QR，難度最高）
- LINE（需要官方審核）

---

## 6. 關鍵風險與對策

| 風險 | 影響 | 對策 |
|------|------|------|
| Discord OAuth 需要用戶在瀏覽器操作 | UX 割裂 | 提供明確步驟指引 + 截圖教程 |
| WhatsApp 需要穩定電話號碼 | 部署限制 | 僅對有明確需求用戶開放 |
| Hermes Agent 為外部項目，更新不受控 | 整合風險 | Docker image tag 锁定 + 定期更新評估 |
| 容器重啟造成服務中斷 | 用戶體驗 | 提供「排程維護」時段，或支援熱更新 |

---

## 7. 待裁決事項（主人決定）

1. **Phase 1 瞄準哪個頻道？** Telegram / Discord / 兩者同時？
2. **Hermes Agent 是否納入考量？**（作為另一種 Agent 類型選項）
3. **頻道 credential 储存位置？** 目前 SQLite，是否升級？
4. **是否要支持「一個實例多頻道」？**（vs 每頻道獨立實例）
5. **Discord OAuth 流程**：是否需要完整的 callback 伺服器，還是簡化為「用戶自行貼 token」？

---

## 8. 實作細節

### 8.1 現有 Feishu 設定檔結構（實例）

```json
{
  "channels": {
    "feishu": {
      "enabled": true,
      "appId": "cli_xxx",
      "appSecret": { "source": "file", "provider": "lark-secrets", "id": "/lark/appSecret" },
      "domain": "feishu",
      "connectionMode": "websocket",
      "dmPolicy": "allowlist",
      "allowFrom": ["ou_xxx"],
      "groupPolicy": "open"
    }
  }
}
```

### 8.2 預期的 Telegram 設定檔結構

```json
{
  "channels": {
    "telegram": {
      "enabled": true,
      "botToken": "123456:ABCdefGHI...",
      "dmPolicy": "pairing",
      "groups": { "*": { "requireMention": true } }
    }
  }
}
```

### 8.3 預期的 Discord 設定檔結構

```json
{
  "channels": {
    "discord": {
      "enabled": true,
      "token": "Bot xxx",
      "dmPolicy": "pairing",
      "intents": ["GUILDS", "GUILD_MESSAGES", "DIRECT_MESSAGES"]
    }
  }
}
```

### 8.4 新檔案結構

```
auto-create-openclaw/
├── src/
│   └── channels/
│       ├── telegram-adapter.js   # Telegram token 校驗 + 設定寫入
│       ├── discord-adapter.js    # Discord OAuth + token 校驗
│       └── index.js              # Adapter factory
├── server.js                     # 新增 /api/channel/* 路由
└── provisioner.js                # 新增 patchChannelPostInstall()
```

### 8.5 Gateway 熱重啟（不需要重啟容器）

```javascript
// 現有架構：startGatewayProcess() 可以在 running container 內重啟 gateway
// 因此頻道新增/修改不需要 docker restart，祇需要：

import { stopGateway, startGateway } from './provisioner.js';

// 頻道設定更新流程：
// 1. patchChannelPostInstall(openclawHome, channel, credentials)
// 2. stopGateway({ id, agentId })   // 祇殺 gateway process
// 3. startGateway({ id, agentId, port })  // 重啟 gateway process（已讀取新配置）
```

---

## 9. 參考資料

- OpenClaw Telegram 文檔：https://docs.openclaw.ai/channels/telegram
- OpenClaw Discord 文檔：https://docs.openclaw.ai/channels/discord
- OpenClaw 頻道列表：https://docs.openclaw.ai/channels/pairing
- Hermes Agent Docker：https://hermes-agent.nousresearch.com/docs/user-guide/docker/
- Hermes Agent Telegram：https://hermes-agent.nousresearch.com/docs/user-guide/messaging/telegram

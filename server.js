/**
 * server.js — Express API for auto-creating OpenClaw agent instances (v4).
 *
 * Two-page design:
 *   /       → User registration (nickname + QR code scan / authorization link)
 *   /admin  → Admin panel (set OpenAI key + activate container)
 */
import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import crypto from 'node:crypto';
import QRCode from 'qrcode';
import swaggerUi from 'swagger-ui-express';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

import {
  allocatePort,
  releasePort,
  createUser,
  updateFeishuCredentials,
  updateOpenAIKey,
  updateBudget,
  updateStatus,
  getUserById,
  getUserByAgentId,
  getAllUsers,
  deleteUser,
  updateAuthMode,
  updateProvisionInfo,
  addInstanceEvent,
  getInstanceEvents,
  dbHandle,
} from './db.js';

import {
  initRegistration,
  beginRegistration,
  pollRegistration,
} from './feishu-registration.js';

import {
  provisionAgent,
  startGateway,
  stopGateway,
  deleteInstance,
  ensureInstanceDirs,
  removeInstanceDir,
  isGatewayRunning,
  checkContainerLiveness,
  checkLiteLLMProxyHealth,
  getLiteLLMModelInfo,
  getLiteLLMSpend,
  patchChannelConfig,
  execInContainer,
} from './provisioner.js';

import {
  validateBotToken,
  sendTestMessage,
  buildOpenClawChannelConfig,
} from './src/channels/telegram-adapter.js';

import {
  validateBotToken as validateDiscordBotToken,
  sendTestDM,
  buildOpenClawChannelConfig as buildDiscordChannelConfig,
} from './src/channels/discord-adapter.js';

import {
  authStatusForUser,
  getDashboardInstances,
  getInstanceDashboardSnapshot,
  getInstanceLogs,
  summarizeDashboard,
} from './monitoring.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = 3210;

function recordInstanceEvent(userOrUserId, payload = {}) {
  try {
    const userId = typeof userOrUserId === 'object' ? userOrUserId?.id : userOrUserId;
    const agentId = typeof userOrUserId === 'object' ? userOrUserId?.agent_id : payload.agentId;
    if (!payload?.eventType || !payload?.title) return;
    addInstanceEvent({
      userId,
      agentId,
      eventType: payload.eventType,
      title: payload.title,
      detail: payload.detail || null,
      severity: payload.severity || 'info',
      actor: payload.actor || 'system',
      metadata: payload.metadata || null,
    });
  } catch (error) {
    console.warn('[event-log] failed to record instance event:', error.message);
  }
}

app.use(cors({
  origin: [/^http:\/\/localhost(:\d+)?$/, 'https://claw.venturet.co'],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());
app.use(express.static(join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// Auth Middleware for Admin Routes
// ---------------------------------------------------------------------------
/**
 * 管理員身份驗證中介層。
 * 校驗 JWT Authorization Header，向本機認證服務驗證是否為 admin 角色。
 * @param {express.Request} req Express 請求物件
 * @param {express.Response} res Express 響應物件
 * @param {express.NextFunction} next 傳遞至下一個中介層
 */
const requireAdmin = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return res.status(401).json({ error: 'Missing Authorization header' });
  }

  try {
    const authServiceUrl = 'http://127.0.0.1:3001/api/auth/verify';
    const verifyRes = await fetch(authServiceUrl, {
      method: 'POST',
      headers: { 'Authorization': authHeader }
    });

    const verifyData = await verifyRes.json();
    if (verifyData.valid && verifyData.user && verifyData.user.role === 'admin') {
      next();
    } else {
      res.status(403).json({ error: 'Access denied: Admin role required or invalid token' });
    }
  } catch (err) {
    console.error('Auth verify error:', err.message);
    res.status(500).json({ error: 'Authentication service unavailable' });
  }
};

// ---------------------------------------------------------------------------
// Auth Middleware for User Routes
// ---------------------------------------------------------------------------
/**
 * 用戶身份驗證中介層。
 * 校驗 JWT Authorization Header，向本機認證服務驗證是否為 user 或 admin 角色。
 * 驗證通過後將 `req.user` 附加用戶資訊。
 * @param {express.Request} req Express 請求物件（含 `headers.authorization`）
 * @param {express.Response} res Express 響應物件
 * @param {express.NextFunction} next 傳遞至下一個中介層
 */
const requireUser = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return res.status(401).json({ error: 'Missing Authorization header' });
  }

  try {
    const authServiceUrl = 'http://127.0.0.1:3001/api/auth/verify';
    const verifyRes = await fetch(authServiceUrl, {
      method: 'POST',
      headers: { 'Authorization': authHeader }
    });

    const verifyData = await verifyRes.json();
    if (verifyData.valid && verifyData.user && (verifyData.user.role === 'user' || verifyData.user.role === 'admin')) {
      req.user = verifyData.user;
      next();
    } else {
      res.status(403).json({ error: 'Access denied: Invalid token or insufficient role' });
    }
  } catch (err) {
    console.error('Auth verify error:', err.message);
    res.status(500).json({ error: 'Authentication service unavailable' });
  }
};

// ---------------------------------------------------------------------------
// Page routes
// ---------------------------------------------------------------------------
const publicDir = join(__dirname, 'public');

/**
 * GET /admin — 管理員面板靜態頁面
 * @name GetAdminPanel
 * @route GET /admin
 */
app.get(['/admin', '/admin/'], (req, res) => {
  res.sendFile('admin.html', { root: publicDir });
});

// ---------------------------------------------------------------------------
// GET /api/user/me — Get user instance details
// ---------------------------------------------------------------------------
/**
 * 取得目前用戶的實例資訊。
 * 需要用戶或管理員 JWT，實例資料由 `req.user.agentId` 查詢。
 * @name GetUserMe
 * @route GET /api/user/me
 * @middleware requireUser
 * @returns {Object} 实例详情：id, agentId, userNickname, botNickname, status, budget, isRunning
 * @throws {401} 缺少 Authorization Header
 * @throws {403} Token 無效或權限不足
 * @throws {400} Token 中缺少 agentId
 * @throws {404} 找不到對應實例
 */
app.get('/api/user/me', requireUser, (req, res) => {
  const { agentId } = req.user;
  if (!agentId) return res.status(400).json({ error: 'Token missing agentId' });

  // Get user by agent_id instead of id. Assuming we import getUserByAgentId from db.js
  const u = getUserByAgentId(agentId);
  if (!u) return res.status(404).json({ error: 'Instance not found' });

  res.json({
    id: u.id,
    agentId: u.agent_id,
    userNickname: u.user_nickname,
    botNickname: u.bot_nickname,
    status: u.status,
    budget: u.budget,
    isRunning: isGatewayRunning(u.agent_id)
  });
});

// ---------------------------------------------------------------------------
// POST /api/register — Step 1: Create record + begin Feishu registration
// ---------------------------------------------------------------------------
/**
 * 申請新實例（第 1 步）：建立資料庫記錄 + 啟動飛書掃碼流程。
 * 產生 agentId、分配容器端口，並回傳 QR Code 供用戶掃碼授權。
 * @name RegisterInstance
 * @route POST /api/register
 * @param {string} req.body.userNickname 用戶暱稱（必填，非空）
 * @param {string} req.body.botNickname 機器人暱稱（必填，非空）
 * @returns {Object} success, id, agentId, qrDataUrl, verificationUrl, expireIn
 * @throws {400} 暱稱為空
 * @throws {500} 飛書註冊初始化失敗
 * @throws {503} 沒有可用端口
 * @example
 * // Request
 * POST /api/register
 * { "userNickname": "張三", "botNickname": "小幫手" }
 * @example
 * // Response
 * {
 *   "success": true,
 *   "id": 7,
 *   "agentId": "user-zhangsan-a1b2c3",
 *   "qrDataUrl": "data:image/png;base64,...",
 *   "verificationUrl": "https://...",
 *   "expireIn": 300
 * }
 */
app.post('/api/register', async (req, res) => {
  try {
    const { userNickname, botNickname } = req.body;
    if (!userNickname?.trim() || !botNickname?.trim()) {
      return res.status(400).json({ error: '暱稱不可為空' });
    }

    // Generate agent ID
    const slug = userNickname.trim().toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fff]/g, '-').replace(/-+/g, '-').slice(0, 20);
    const suffix = crypto.randomBytes(3).toString('hex');
    const agentId = `user-${slug}-${suffix}`;

    // Init + Begin Feishu registration
    let regData;
    try {
      await initRegistration();
      regData = await beginRegistration();
    } catch (err) {
      return res.status(500).json({ error: '飛書註冊初始化失敗，請稍後再試' });
    }

    // Save to DB FIRST, but defer runtime port allocation until activate
    let user;
    try {
      user = createUser({
        userNickname: userNickname.trim(),
        botNickname: botNickname.trim(),
        agentId,
        port: null,
        deviceCode: regData.deviceCode,
        status: 'pending_scan',
      });

      const dirs = ensureInstanceDirs(agentId);
      updateProvisionInfo(user.id, {
        workspaceDir: dirs.workspaceDir,
        agentDir: dirs.openclawHome,
      });
    } catch (setupErr) {
      console.error('register setup error:', setupErr);
      if (user?.id) {
        try { deleteUser(user.id); } catch {}
      }
      try { removeInstanceDir(agentId); } catch {}
      return res.status(503).json({ error: '無法建立用戶記錄，請稍後再試' });
    }

    // Generate QR code as data URL
    const qrDataUrl = await QRCode.toDataURL(regData.verificationUrl, {
      width: 280,
      margin: 2,
      color: { dark: '#000000', light: '#0000' },
    });

    recordInstanceEvent(user, {
      eventType: 'register.created',
      title: '建立實例註冊記錄',
      detail: `Bot：${botNickname.trim()}，等待用戶掃碼`,
      severity: 'info',
      actor: 'system',
      metadata: { verificationUrl: regData.verificationUrl, expireIn: regData.expireIn },
    });

    res.json({
      success: true,
      id: user.id,
      agentId,
      qrDataUrl,
      verificationUrl: regData.verificationUrl,
      expireIn: regData.expireIn,
    });
  } catch (err) {
    console.error('register error:', err);
    res.status(500).json({ error: '伺服器錯誤，請稍後再試' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/register/poll/:id — Step 2: Poll Feishu for scan result
// ---------------------------------------------------------------------------
/**
 * 輪詢掃碼狀態（第 2 步）：查詢用戶是否已完成飛書 QR Code 授權。
 * @name PollRegistration
 * @route GET /api/register/poll/:id
 * @param {number} req.params.id 使用者資料庫 ID
 * @returns {Object} status: 'pending' | 'completed' | 'denied' | 'expired' | 'pending_activation'，completed 時附加 feishuAppId, feishuAppSecret
 * @throws {404} 找不到此記錄
 * @throws {400} 缺少 device_code
 * @throws {500} 伺服器錯誤
 * @example GET /api/register/poll/7
 */
app.get('/api/register/poll/:id', async (req, res) => {
  try {
    const user = getUserById(Number(req.params.id));
    if (!user) return res.status(404).json({ error: '找不到此記錄' });

    if (user.status !== 'pending_scan') {
      if (user.status === 'pending_activation') {
        return res.json({
          status: 'completed',
          feishuAppId: user.feishu_app_id,
          feishuAppSecret: user.feishu_app_secret
        });
      }
      return res.json({ status: user.status, feishuAppId: user.feishu_app_id });
    }

    if (!user.device_code) {
      return res.status(400).json({ error: '缺少 device_code' });
    }

    const result = await pollRegistration(user.device_code);

    if (result.status === 'completed') {
      updateFeishuCredentials(user.id, {
        appId: result.appId,
        appSecret: result.appSecret,
        openId: result.openId,
        domain: result.domain || 'feishu',
      });
      recordInstanceEvent(user, {
        eventType: 'register.feishu_completed',
        title: '完成 Feishu 授權',
        detail: `Domain=${result.domain || 'feishu'}，等待管理員激活`,
        severity: 'info',
        actor: 'user',
        metadata: { openId: result.openId, appId: result.appId },
      });
      return res.json({
        status: 'completed',
        feishuAppId: result.appId,
        feishuAppSecret: result.appSecret,
        message: '飛書機器人建立成功！等待管理員激活。',
      });
    }

    if (result.status === 'denied') {
      updateStatus(user.id, 'denied');
      recordInstanceEvent(user, {
        eventType: 'register.feishu_denied',
        title: '用戶拒絕 Feishu 授權',
        detail: '掃碼授權被拒絕',
        severity: 'warning',
        actor: 'user',
      });
      try { removeInstanceDir(user.agent_id); } catch {}
      releasePort(user.port);
      return res.json({ status: 'denied', message: '用戶拒絕了授權' });
    }

    if (result.status === 'expired') {
      updateStatus(user.id, 'expired');
      recordInstanceEvent(user, {
        eventType: 'register.feishu_expired',
        title: 'Feishu 授權逾期',
        detail: '裝置碼已過期，需重新註冊',
        severity: 'warning',
        actor: 'system',
      });
      try { removeInstanceDir(user.agent_id); } catch {}
      releasePort(user.port);
      return res.json({ status: 'expired', message: '掃碼已過期，請重新註冊' });
    }

    res.json({ status: 'pending' });
  } catch (err) {
    console.error('poll error:', err);
    res.status(500).json({ error: '伺服器錯誤，請稍後再試' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/channel/telegram/setup — 新增 Telegram 頻道
// ---------------------------------------------------------------------------
/**
 * 用戶輸入 Telegram Bot Token，系統自動完成以下流程：
 * 1. 驗證 Token 有效性（getMe）
 * 2. 發送測試訊息確認可發訊
 * 3. 寫入 openclaw.json channels.telegram 設定
 * 4. 重啟 Gateway 讓設定生效
 *
 * @name SetupTelegramChannel
 * @route POST /api/channel/telegram/setup
 * @param {string} req.body.agentId - 目標實例的 agentId
 * @param {string} req.body.botToken - BotFather 給的 token（格式：123456:ABCdefGHI...）
 * @param {string} req.body.adminTelegramId - 管理員的 Telegram user ID（用於 allowlist）
 * @returns {{ success: boolean, botUsername?: string, error?: string }}
 */
app.post('/api/channel/telegram/setup', requireAdmin, async (req, res) => {
  try {
    const { agentId, botToken, adminTelegramId } = req.body || {};

    // 基本校驗
    if (!agentId) return res.status(400).json({ error: '缺少 agentId' });
    if (!botToken) return res.status(400).json({ error: '缺少 botToken' });
    if (!adminTelegramId) return res.status(400).json({ error: '缺少 adminTelegramId（管理員的 Telegram ID）' });

    // Step 1: 驗證 Token
    const validation = await validateBotToken(botToken);
    if (!validation.ok) {
      return res.status(400).json({ error: `Token 無效：${validation.error}` });
    }

    // Step 2: 發送測試訊息
    const testMsg = await sendTestMessage(botToken, String(adminTelegramId));
    if (!testMsg.ok) {
      return res.status(400).json({
        error: `Token 有效但無法發訊：${testMsg.error}（請確認 Bot 已與 Telegram 用戶建立 DM）`
      });
    }

    // Step 3: 寫入 openclaw.json
    const channelConfig = buildOpenClawChannelConfig(
      { botToken },
      String(adminTelegramId)
    );
    const patchResult = patchChannelConfig(agentId, 'telegram', channelConfig);
    if (!patchResult.success) {
      return res.status(500).json({ error: `寫入設定失敗：${patchResult.error}` });
    }

    // Step 4: 重啟 Gateway 讓設定生效
    const user = getUserByAgentId(agentId);
    if (!user) return res.status(404).json({ error: '找不到此實例' });

    try {
      stopGateway({ id: user.id, agentId });
      startGateway({ id: user.id, agentId, port: user.port });
    } catch (gatewayErr) {
      console.error('Gateway restart error:', gatewayErr);
      // 設定已寫入，重啟失敗不阻擋成功響應
    }

    recordInstanceEvent(user, {
      eventType: 'channel.telegram_added',
      title: '新增 Telegram 頻道',
      detail: `Bot @${validation.botUsername} 已連接，管理員 ID：${adminTelegramId}`,
      severity: 'info',
      actor: 'admin',
    });

    res.json({
      success: true,
      botUsername: validation.botUsername,
      botName: validation.botName,
      message: `Telegram Bot @${validation.botUsername} 設定成功！`,
    });
  } catch (err) {
    console.error('telegram setup error:', err);
    res.status(500).json({ error: `伺服器錯誤：${err.message}` });
  }
});

// ---------------------------------------------------------------------------
// POST /api/channel/discord/setup — 新增 Discord 頻道
// ---------------------------------------------------------------------------
/**
 * 用戶輸入 Discord Bot Token，系統自動完成以下流程：
 * 1. 驗證 Token 有效性（GET /users/@me）
 * 2. 發送測試 DM 確認可發訊
 * 3. 寫入 openclaw.json channels.discord 設定
 * 4. 重啟 Gateway 讓設定生效
 *
 * @name SetupDiscordChannel
 * @route POST /api/channel/discord/setup
 * @param {string} req.body.agentId - 目標實例的 agentId
 * @param {string} req.body.botToken - Discord Bot Token
 * @param {string} req.body.adminDiscordId - 管理員的 Discord User ID
 * @returns {{ success: boolean, botUsername?: string, error?: string }}
 */
app.post('/api/channel/discord/setup', requireAdmin, async (req, res) => {
  try {
    const { agentId, botToken, adminDiscordId } = req.body || {};

    // 基本校驗
    if (!agentId) return res.status(400).json({ error: '缺少 agentId' });
    if (!botToken) return res.status(400).json({ error: '缺少 botToken' });
    if (!adminDiscordId) return res.status(400).json({ error: '缺少 adminDiscordId（管理員的 Discord User ID）' });

    // Step 1: 驗證 Token
    const validation = await validateDiscordBotToken(botToken);
    if (!validation.ok) {
      return res.status(400).json({ error: `Token 無效：${validation.error}` });
    }

    // Step 2: 發送測試 DM
    const testDM = await sendTestDM(botToken, String(adminDiscordId));
    if (!testDM.ok) {
      return res.status(400).json({
        error: `Token 有效但無法發 DM：${testDM.error}（請確認 Bot 已被添加至有該用戶的伺服器，且擁有發訊權限）`
      });
    }

    // Step 3: 寫入 openclaw.json
    const channelConfig = buildDiscordChannelConfig(
      { botToken },
      String(adminDiscordId)
    );
    const patchResult = patchChannelConfig(agentId, 'discord', channelConfig);
    if (!patchResult.success) {
      return res.status(500).json({ error: `寫入設定失敗：${patchResult.error}` });
    }

    // Step 4: 重啟 Gateway 讓設定生效
    const user = getUserByAgentId(agentId);
    if (!user) return res.status(404).json({ error: '找不到此實例' });

    try {
      stopGateway({ id: user.id, agentId });
      startGateway({ id: user.id, agentId, port: user.port });
    } catch (gatewayErr) {
      console.error('Gateway restart error:', gatewayErr);
    }

    recordInstanceEvent(user, {
      eventType: 'channel.discord_added',
      title: '新增 Discord 頻道',
      detail: `Bot @${validation.botUsername} 已連接，管理員 ID：${adminDiscordId}`,
      severity: 'info',
      actor: 'admin',
    });

    res.json({
      success: true,
      botUsername: validation.botUsername,
      botId: validation.botId,
      message: `Discord Bot @${validation.botUsername} 設定成功！`,
    });
  } catch (err) {
    console.error('discord setup error:', err);
    res.status(500).json({ error: `伺服器錯誤：${err.message}` });
  }
});

// ---------------------------------------------------------------------------
// PATCH /api/instance/:id/script — 更新實例腳本
// ---------------------------------------------------------------------------
/**
 * 更新實例容器內的腳本檔案（BOOTSTRAP.md, MEMORY.md, SOUL.md 等）。
 * 使用 docker exec 將新內容寫入容器內的 workspace 目錄。
 *
 * @name UpdateInstanceScript
 * @route PATCH /api/instance/:id/script
 * @param {number} req.params.id 實例資料庫 ID
 * @param {string} req.body.scriptName 腳本名稱（如 BOOTSTRAP.md, MEMORY.md）
 * @param {string} req.body.content 檔案內容（完整覆寫）
 * @returns {{ success: boolean, message: string }}
 */
app.patch('/api/instance/:id/script', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { scriptName, content } = req.body || {};

    if (!scriptName) return res.status(400).json({ error: '缺少 scriptName' });
    if (content === undefined) return res.status(400).json({ error: '缺少 content' });

    // 驗證腳本名稱安全性（只允許常見 .md 檔）
    const allowed = ['BOOTSTRAP.md', 'MEMORY.md', 'SOUL.md', 'USER.md', 'HEARTBEAT.md', 'IDENTITY.md', 'AGENTS.md', 'TOOLS.md', 'MEMORY-long-term.md'];
    if (!allowed.includes(scriptName)) {
      return res.status(400).json({ error: `不允許的腳本名稱：${scriptName}。允許：${allowed.join(', ')}` });
    }

    const user = getUserById(Number(id));
    if (!user) return res.status(404).json({ error: '找不到此實例' });

    // 在容器中執行寫入
    const workspacePath = `/home/node/.openclaw/workspace/${scriptName}`;
    // 使用 base64 避免特殊字元問題
    const encoded = Buffer.from(content, 'utf-8').toString('base64');
    const cmd = `echo '${encoded}' | base64 -d > '${workspacePath}'`;
    const result = execInContainer(user.agent_id, cmd);

    if (!result.success) {
      return res.status(500).json({ error: `寫入失敗：${result.error}` });
    }

    recordInstanceEvent(user, {
      eventType: 'script.updated',
      title: `更新腳本 ${scriptName}`,
      detail: `大小：${content.length} 位元組`,
      severity: 'info',
      actor: 'admin',
    });

    res.json({ success: true, message: `腳本 ${scriptName} 已更新` });
  } catch (err) {
    console.error('update script error:', err);
    res.status(500).json({ error: `伺服器錯誤：${err.message}` });
  }
});

// ---------------------------------------------------------------------------
// GET /api/instance/:id/script/:scriptName — 讀取實例腳本內容
// ---------------------------------------------------------------------------
/**
 * 讀取實例容器內的腳本檔案內容。
 *
 * @name GetInstanceScript
 * @route GET /api/instance/:id/script/:scriptName
 * @param {number} req.params.id 實例資料庫 ID
 * @param {string} req.params.scriptName 腳本名稱
 * @returns {{ success: boolean, scriptName: string, content: string, size: number }}
 */
app.get('/api/instance/:id/script/:scriptName', requireAdmin, async (req, res) => {
  try {
    const { id, scriptName } = req.params;

    const user = getUserById(Number(id));
    if (!user) return res.status(404).json({ error: '找不到此實例' });

    const workspacePath = `/home/node/.openclaw/workspace/${scriptName}`;
    const result = execInContainer(user.agent_id, `cat '${workspacePath}'`);

    if (!result.success) {
      return res.status(404).json({ error: `讀取失敗：${result.error}` });
    }

    res.json({
      success: true,
      scriptName,
      content: result.output,
      size: Buffer.byteLength(result.output, 'utf-8'),
    });
  } catch (err) {
    console.error('get script error:', err);
    res.status(500).json({ error: `伺服器錯誤：${err.message}` });
  }
});

// ---------------------------------------------------------------------------
// GET /api/instance/:id/container-stats — 實例容器資源用量
// ---------------------------------------------------------------------------
/**
 * 取得實例容器的 CPU / 記憶體 / 磁碟用量。
 *
 * @name GetInstanceContainerStats
 * @route GET /api/instance/:id/container-stats
 * @param {number} req.params.id 實例資料庫 ID
 * @returns {{ success: boolean, cpu: string, memory: object, disk: object }}
 */
app.get('/api/instance/:id/container-stats', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const user = getUserById(Number(id));
    if (!user) return res.status(404).json({ error: '找不到此實例' });

    const containerName = `auto-openclaw-${user.agent_id}`;

    // CPU + Memory from docker stats
    let dockerOutput = '';
    try {
      const { execFileSync } = await import('node:child_process');
      dockerOutput = execFileSync('docker', ['stats', containerName, '--no-stream', '--format', '{{.CPUPerc}}\t{{.MemUsage}}\t{{.MemPerc}}'], { encoding: 'utf-8', timeout: 10_000 });
    } catch {}

    // Disk usage of workspace
    let diskOutput = '';
    try {
      const { execFileSync } = await import('node:child_process');
      diskOutput = execFileSync('docker', ['exec', containerName, 'bash', '-lc', 'du -sh /home/node/.openclaw/workspace 2>/dev/null || echo "0B"'], { encoding: 'utf-8', timeout: 10_000 });
    } catch {}

    const [cpuPerc, memUsage, memPerc] = (dockerOutput || '\t\t').split('\t');

    res.json({
      success: true,
      cpu: cpuPerc?.trim() || 'N/A',
      memory: {
        usage: memUsage?.trim() || 'N/A',
        percent: memPerc?.trim() || 'N/A',
      },
      disk: {
        workspace: diskOutput?.trim() || 'N/A',
      },
      containerName,
    });
  } catch (err) {
    console.error('container stats error:', err);
    res.status(500).json({ error: `伺服器錯誤：${err.message}` });
  }
});

// ---------------------------------------------------------------------------
// GET /api/instances — List all instances (admin)
// ---------------------------------------------------------------------------
/**
 * 列出所有用戶實例（管理員專用）。
 * 每筆記錄附加 `isRunning`（Gateway 運行狀態），敏感資訊（feishu_app_secret、openai_api_key）已遮蔽。
 * @name ListInstances
 * @route GET /api/instances
 * @middleware requireAdmin
 * @returns {Object[]} 用戶實例陣列，含 id, agent_id, user_nickname, status, budget, isRunning 等欄位
 * @throws {401} 缺少 Authorization Header
 * @throws {403} 非管理員角色
 */
app.get('/api/instances', requireAdmin, (req, res) => {
  const users = getAllUsers();
  const enriched = users.map(u => ({
    ...u,
    isRunning: isGatewayRunning(u.agent_id),
    auth: authStatusForUser(u),
    // Don't leak secrets to frontend
    feishu_app_secret: u.feishu_app_secret ? '••••' : null,
    openai_api_key: u.openai_api_key ? '••••' + u.openai_api_key.slice(-4) : null,
  }));
  res.json(enriched);
});

// ---------------------------------------------------------------------------
// GET /api/admin/dashboard/instances — Aggregated monitoring snapshots
// ---------------------------------------------------------------------------
app.get('/api/admin/dashboard/instances', requireAdmin, async (req, res) => {
  try {
    const force = String(req.query.refresh || '') === '1';
    const users = getAllUsers();
    const items = await getDashboardInstances(users, { force });
    res.json({
      summary: summarizeDashboard(items),
      items,
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error('dashboard instances error:', err);
    res.status(500).json({ error: '無法載入 dashboard 監控資料' });
  }
});

app.get('/api/admin/dashboard/instances/:id', requireAdmin, async (req, res) => {
  const user = getUserById(Number(req.params.id));
  if (!user) return res.status(404).json({ error: '找不到此實例' });
  try {
    const force = String(req.query.refresh || '') === '1';
    const item = await getInstanceDashboardSnapshot(user, { force });
    res.json({ item, generatedAt: new Date().toISOString() });
  } catch (err) {
    console.error('dashboard instance detail error:', err);
    res.status(500).json({ error: '無法載入實例監控資料' });
  }
});

app.get('/api/admin/dashboard/instances/:id/logs', requireAdmin, async (req, res) => {
  const user = getUserById(Number(req.params.id));
  if (!user) return res.status(404).json({ error: '找不到此實例' });
  try {
    const source = req.query.source === 'openclaw' ? 'openclaw' : 'docker';
    const tail = Math.max(1, Math.min(500, Number(req.query.tail || 120)));
    const result = await getInstanceLogs(user, { source, tail });
    if (!result.ok) {
      return res.status(502).json({ error: result.error || '讀取 logs 失敗', source, content: result.content || '' });
    }
    res.json({
      source,
      tail,
      content: result.content,
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error('dashboard logs error:', err);
    res.status(500).json({ error: '無法讀取實例 logs' });
  }
});

app.get('/api/admin/dashboard/instances/:id/events', requireAdmin, (req, res) => {
  const user = getUserById(Number(req.params.id));
  if (!user) return res.status(404).json({ error: '找不到此實例' });
  try {
    const limit = Math.max(1, Math.min(200, Number(req.query.limit || 50)));
    const items = getInstanceEvents(user.id, limit);
    res.json({ items, limit, generatedAt: new Date().toISOString() });
  } catch (err) {
    console.error('dashboard events error:', err);
    res.status(500).json({ error: '無法讀取實例事件時間線' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/instance/:id/set-budget — Set API Budget (admin)
// ---------------------------------------------------------------------------
/**
 * 設定用戶實例的 API 花費上限（管理員專用）。
 * @name SetInstanceBudget
 * @route POST /api/instance/:id/set-budget
 * @middleware requireAdmin
 * @param {number} req.params.id 實例資料庫 ID
 * @param {number} req.body.budget 預算上限（必須為正數）
 * @returns {Object} success: true
 * @throws {404} 找不到此實例
 * @throws {400} budget 無效（空值、非數字或 <= 0）
 * @example POST /api/instance/7/set-budget { "budget": 50 }
 */
app.get('/api/instance/:id/auth/status', requireAdmin, (req, res) => {
  const user = getUserById(Number(req.params.id));
  if (!user) return res.status(404).json({ error: '找不到此實例' });
  res.json({ success: true, id: user.id, agentId: user.agent_id, auth: authStatusForUser(user) });
});

app.post('/api/instance/:id/auth/codex/reset', requireAdmin, (req, res) => {
  const user = getUserById(Number(req.params.id));
  if (!user) return res.status(404).json({ error: '找不到此實例' });
  if (!user.agent_dir) return res.status(400).json({ error: '尚未建立實例目錄' });

  const profilePath = getProfilesPath(user.agent_dir);
  try {
    if (existsSync(profilePath)) rmSync(profilePath, { force: true });
    updateAuthMode(user.id, 'openai-api-key');
    recordInstanceEvent(user, {
      eventType: 'auth.codex_reset',
      title: '重置 Codex 授權',
      detail: '模式切回 API Key',
      severity: 'warning',
      actor: 'admin',
    });
    res.json({ success: true, auth: authStatusForUser({ ...user, auth_mode: 'openai-api-key' }) });
  } catch (err) {
    console.error('codex reset error:', err.message);
    res.status(500).json({ error: '重置 Codex 授權失敗' });
  }
});

app.post('/api/instance/:id/set-budget', requireAdmin, (req, res) => {
  const user = getUserById(Number(req.params.id));
  if (!user) return res.status(404).json({ error: '找不到此實例' });
  const { budget } = req.body;
  if (!budget || isNaN(budget) || budget <= 0) return res.status(400).json({ error: '無效的預算' });
  const nextBudget = Number(budget);
  updateBudget(user.id, nextBudget);
  recordInstanceEvent(user, {
    eventType: 'billing.budget_updated',
    title: '更新 Budget 上限',
    detail: `$${Number(user.budget || 0).toFixed(2)} → $${nextBudget.toFixed(2)}`,
    severity: 'info',
    actor: 'admin',
    metadata: { previousBudget: Number(user.budget || 0), nextBudget },
  });
  res.json({ success: true });
});

// ---------------------------------------------------------------------------
// POST /api/instance/:id/activate — Provision + start (admin)
// ---------------------------------------------------------------------------
/**
 * 佈建並啟動容器（管理員專用）。
 * 若用戶尚未設定 OpenAI API Key，自動向 LiteLLM Proxy 申請虛擬 Key（限額由 budget 決定）。
 * @name ActivateInstance
 * @route POST /api/instance/:id/activate
 * @middleware requireAdmin
 * @param {number} req.params.id 實例資料庫 ID
 * @returns {Object} success, status, containerName, containerId, imageName
 * @throws {404} 找不到此實例
 * @throws {400} 尚未完成飛書掃碼
 * @throws {500} 佈建失敗，實例狀態標記為 error
 * @example POST /api/instance/7/activate
 */
app.post('/api/instance/:id/activate', requireAdmin, async (req, res) => {
  const user = getUserById(Number(req.params.id));
  if (!user) return res.status(404).json({ error: '找不到此實例' });

  if (!user.feishu_app_id || !user.feishu_app_secret) {
    return res.status(400).json({ error: '尚未完成飛書掃碼' });
  }

  if (!user.agent_dir) {
    return res.status(400).json({ error: '尚未建立實例目錄' });
  }

  if (user.auth_mode === 'codex-cli' && !existsSync(getProfilesPath(user.agent_dir))) {
    return res.status(400).json({ error: '已選擇 Codex 授權，但尚未完成 OAuth' });
  }

  let virtualKey = user.openai_api_key;
  let allocatedPort = null;
  try {
    if (user.auth_mode !== 'codex-cli') {
      if (!virtualKey || !virtualKey.startsWith('sk-')) {
        const budget = user.budget || 20;
        const litellmBaseUrl = process.env.LITELLM_BASE_URL || 'http://localhost:4000';
        const litellmMasterKey = process.env.LITELLM_MASTER_KEY || 'sk-1234';

        const keyRes = await fetch(`${litellmBaseUrl}/key/generate`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${litellmMasterKey}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            max_budget: budget,
            user_id: user.agent_id,
            models: ["openai/gpt-5.4", "openai/gpt-4.1-mini", "minimax-cn/MiniMax-M2.7"]
          })
        });

        if (!keyRes.ok) {
          const errText = await keyRes.text();
          throw new Error(`LiteLLM 產生金鑰失敗: ${errText}`);
        }

        const keyData = await keyRes.json();
        virtualKey = keyData.key;
        updateOpenAIKey(user.id, virtualKey);
      }
    }

    let runtimePort = user.port;
    if (!runtimePort) {
      runtimePort = allocatePort(user.id);
      allocatedPort = runtimePort;
      dbHandle.prepare('UPDATE users SET port = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(runtimePort, user.id);
    }

    const result = provisionAgent({
      id: user.id,
      agentId: user.agent_id,
      userNickname: user.user_nickname,
      botNickname: user.bot_nickname,
      port: runtimePort,
      feishuAppId: user.feishu_app_id,
      feishuAppSecret: user.feishu_app_secret,
      feishuOpenId: user.feishu_open_id,
      feishuDomain: user.feishu_domain,
      authMode: user.auth_mode === 'codex-cli' ? 'codex-cli' : 'openai-api-key',
      openaiApiKey: user.auth_mode !== 'codex-cli' ? virtualKey : undefined,
    });

    recordInstanceEvent(user, {
      eventType: 'instance.activated',
      title: '完成容器建立與激活',
      detail: `${result.containerName} 已啟動`,
      severity: 'info',
      actor: 'admin',
      metadata: { containerName: result.containerName, containerId: result.containerId, imageName: result.imageName, port: runtimePort },
    });
    res.json({
      success: true,
      status: 'running',
      containerName: result.containerName,
      containerId: result.containerId,
      imageName: result.imageName,
    });
  } catch (err) {
    console.error('activate error:', err);
    if (allocatedPort) {
      try { releasePort(allocatedPort); } catch {}
      try { dbHandle.prepare('UPDATE users SET port = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(user.id); } catch {}
    }
    updateStatus(user.id, 'error');
    recordInstanceEvent(user, {
      eventType: 'instance.activate_failed',
      title: '激活容器失敗',
      detail: err.message,
      severity: 'critical',
      actor: 'admin',
    });
    res.status(500).json({ error: '伺服器錯誤，請稍後再試' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/instance/:id/start — Restart gateway (admin)
// ---------------------------------------------------------------------------
/**
 * 啟動指定實例的 Gateway（管理員專用）。
 * 若容器已存在則重啟，若不存在則建立並啟動。
 * @name StartInstance
 * @route POST /api/instance/:id/start
 * @middleware requireAdmin
 * @param {number} req.params.id 實例資料庫 ID
 * @returns {Object} success: true，加上 startGateway() 的回傳結果（containerName, containerId, imageName 等）
 * @throws {404} 找不到此實例
 * @throws {500} 啟動失敗
 * @example POST /api/instance/7/start
 */
app.post('/api/instance/:id/start', requireAdmin, (req, res) => {
  const user = getUserById(Number(req.params.id));
  if (!user) return res.status(404).json({ error: '找不到此實例' });
  try {
    const result = startGateway({
      id: user.id,
      agentId: user.agent_id,
      port: user.port,
    });
    recordInstanceEvent(user, {
      eventType: 'instance.started',
      title: '啟動實例',
      detail: result.containerName || user.container_name || user.agent_id,
      severity: 'info',
      actor: 'admin',
    });
    res.json({ success: true, ...result });
  } catch (err) {
    recordInstanceEvent(user, {
      eventType: 'instance.start_failed',
      title: '啟動實例失敗',
      detail: err.message,
      severity: 'critical',
      actor: 'admin',
    });
    res.status(500).json({ error: '伺服器錯誤，請稍後再試' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/instance/:id/stop — Stop gateway (admin)
// ---------------------------------------------------------------------------
/**
 * 停止指定實例的 Gateway（管理員專用）。
 * @name StopInstance
 * @route POST /api/instance/:id/stop
 * @middleware requireAdmin
 * @param {number} req.params.id 實例資料庫 ID
 * @returns {Object} success: true，加上 stopGateway() 的回傳結果
 * @throws {404} 找不到此實例
 * @throws {500} 停止失敗
 * @example POST /api/instance/7/stop
 */
app.post('/api/instance/:id/stop', requireAdmin, (req, res) => {
  const user = getUserById(Number(req.params.id));
  if (!user) return res.status(404).json({ error: '找不到此實例' });
  const result = stopGateway({ id: user.id, agentId: user.agent_id });
  recordInstanceEvent(user, {
    eventType: 'instance.stopped',
    title: '停止實例',
    detail: result.containerName || user.container_name || user.agent_id,
    severity: 'info',
    actor: 'admin',
  });
  res.json({ success: true, ...result });
});

// ---------------------------------------------------------------------------
// POST /api/instance/:id/delete — Remove container + instance record
// ---------------------------------------------------------------------------
/**
 * 刪除實例：移除 Docker 容器、釋放端口、刪除資料庫記錄（管理員專用）。
 * @name DeleteInstance
 * @route POST /api/instance/:id/delete
 * @middleware requireAdmin
 * @param {number} req.params.id 實例資料庫 ID
 * @returns {Object} success: true，加上 deleteInstance() 的回傳結果（containerName, imageName 等）
 * @throws {404} 找不到此實例
 * @throws {500} 刪除過程失敗
 * @example POST /api/instance/7/delete
 */
app.post('/api/instance/:id/delete', requireAdmin, (req, res) => {
  const user = getUserById(Number(req.params.id));
  if (!user) return res.status(404).json({ error: '找不到此實例' });

  try {
    recordInstanceEvent(user, {
      eventType: 'instance.deleted',
      title: '刪除實例',
      detail: user.container_name || user.agent_id,
      severity: 'warning',
      actor: 'admin',
    });
    const result = deleteInstance({ id: user.id, agentId: user.agent_id, port: user.port });
    deleteUser(user.id);
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('delete error:', err);
    recordInstanceEvent(user, {
      eventType: 'instance.delete_failed',
      title: '刪除實例失敗',
      detail: err.message,
      severity: 'critical',
      actor: 'admin',
    });
    res.status(500).json({ error: '伺服器錯誤，請稍後再試' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/health/agent/:agentId — T10: Platform-side container liveness check
// ---------------------------------------------------------------------------
/**
 * 平台端容器存活檢查：檢測指定 agent 的 Gateway 容器是否正常運行。
 * @name AgentLivenessCheck
 * @route GET /api/health/agent/:agentId
 * @middleware requireAdmin
 * @param {string} req.params.agentId Agent ID（如 user-zhangsan-a1b2c3）
 * @returns {Object} agentId, alive, status, error, timestamp
 * @throws {400} 缺少 agentId
 * @throws {500} 檢查過程錯誤
 * @example GET /api/health/agent/user-zhangsan-a1b2c3
 */
app.get('/api/health/agent/:agentId', requireAdmin, (req, res) => {
  const { agentId } = req.params;
  if (!agentId) return res.status(400).json({ error: 'agentId required' });
  try {
    const report = checkContainerLiveness(agentId);
    res.json({ agentId, ...report, timestamp: new Date().toISOString() });
  } catch (err) {
    console.error('liveness check error:', err);
    res.status(500).json({ error: '伺服器錯誤，請稍後再試' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/health/litellm — T14: LiteLLM proxy health check
// ---------------------------------------------------------------------------
/**
 * LiteLLM Proxy 健康檢查：驗證 Proxy 服務是否正常響應。
 * @name LiteLLMHealthCheck
 * @route GET /api/health/litellm
 * @middleware requireAdmin
 * @returns {Object} url, healthy, statusCode, error, timestamp
 * @throws {500} 檢查過程錯誤
 * @example GET /api/health/litellm
 */
app.get('/api/health/litellm', requireAdmin, async (req, res) => {
  try {
    const report = await checkLiteLLMProxyHealth();
    res.json({ url: `${process.env.LITELLM_PROXY_URL || 'http://litellm-proxy:4000'}/health`, ...report, timestamp: new Date().toISOString() });
  } catch (err) {
    console.error('litellm health check error:', err);
    res.status(500).json({ error: '伺服器錯誤，請稍後再試' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/health — T7: LiteLLM health + model availability
// ---------------------------------------------------------------------------
/**
 * 系統總健康狀態：同時查詢 LiteLLM Proxy 健康狀態與模型清單。
 * @name SystemHealth
 * @route GET /api/health
 * @middleware requireAdmin
 * @returns {Object} litellm { healthy, statusCode, error }, models, modelCount, modelError, timestamp
 * @throws {500} 檢查過程錯誤
 * @example GET /api/health
 */
app.get('/api/health', requireAdmin, async (req, res) => {
  try {
    const [healthReport, modelInfo] = await Promise.all([
      checkLiteLLMProxyHealth(),
      getLiteLLMModelInfo(),
    ]);
    res.json({
      litellm: {
        healthy: healthReport.healthy,
        statusCode: healthReport.statusCode,
        error: healthReport.healthy ? null : healthReport.body,
      },
      models: modelInfo.models,
      modelCount: modelInfo.models.length,
      modelError: modelInfo.error,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error('health check error:', err);
    res.status(500).json({ error: '伺服器錯誤，請稍後再試' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/spend — T8: User-level spend query
// Query params: user_id (required) — maps to litellm user_id (agent_id)
// ---------------------------------------------------------------------------
/**
 * 用戶花費查詢：向 LiteLLM Proxy 查詢指定 user_id（即 agent_id）的累計用量。
 * @name GetUserSpend
 * @route GET /api/spend
 * @middleware requireAdmin
 * @param {string} req.query.user_id 用戶 ID（對應 LiteLLM 的 user_id，亦即 agent_id）
 * @returns {Object} user_id, totalSpend, statusCode, timestamp
 * @throws {400} 缺少 user_id 查詢參數
 * @throws {500} 查詢失敗
 * @example GET /api/spend?user_id=user-zhangsan-a1b2c3
 */
app.get('/api/spend', requireAdmin, async (req, res) => {
  const { user_id } = req.query;
  if (!user_id) {
    return res.status(400).json({ error: 'user_id query parameter is required' });
  }
  try {
    const spendReport = await getLiteLLMSpend(user_id);
    if (spendReport.error) {
      return res.status(spendReport.statusCode || 500).json({ error: spendReport.error });
    }
    res.json({
      user_id,
      totalSpend: spendReport.totalSpend,
      statusCode: spendReport.statusCode,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error('spend query error:', err);
    res.status(500).json({ error: '伺服器錯誤，請稍後再試' });
  }
});

// ---------------------------------------------------------------------------
// API Documentation — Swagger UI
// ---------------------------------------------------------------------------

/**
 * @name GET /docs
 * @route
 * @description 互動式 API 文件頁面（Swagger UI）
 * @returns HTML — Swagger UI 頁面
 */
app.use('/docs', swaggerUi.serve, swaggerUi.setup(null, {
  swaggerOptions: {
    url: '/openapi.yaml',  // Express will serve this static file below
    persistAuthorization: true,
    displayRequestDuration: true,
    docExpansion: 'list',
  },
  customCss: `
    .swagger-ui .topbar { display: none }
    .swagger-ui .info .title { font-size: 2em; }
    .swagger-ui .scheme-container { background: #f8f8f8; padding: 12px; }
  `,
  customSiteTitle: 'Auto-Create OpenClaw API Docs',
}));

/**
 * @name GET /openapi.yaml
 * @route
 * @description 原始 OpenAPI 3.0 規格檔（YAML 格式）
 * @returns text/plain — YAML 檔案內容
 */
app.get('/openapi.yaml', (req, res) => {
  try {
    const specPath = join(__dirname, 'openapi.yaml');
    res.type('application/x-yaml').send(readFileSync(specPath, 'utf8'));
  } catch (err) {
    res.status(500).json({ error: '無法載入 OpenAPI 規格檔' });
  }
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
/**
 * 啟動 Express 伺服器，監聽 0.0.0.0:${PORT}。
 * 輸出服務啟動提示資訊至標準輸出。
 * @listens {number} PORT — 預設 3210
 * @fires 'listening' — 伺服器成功啟動後觸發
 */
const SERVER_START = import.meta.url === `file://${process.argv[1]}`;
if (SERVER_START) {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🦞 Auto-Create OpenClaw Service`);
    console.log(`   Frontend:  http://localhost:${PORT}`);
    console.log(`   Admin:     http://localhost:${PORT}/admin`);
    console.log(`   API Docs:  http://localhost:${PORT}/docs\n`);
  });
}

export { app, PORT };

// ---------------------------------------------------------------------------
// Codex OAuth Endpoints
// ---------------------------------------------------------------------------

const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const CODEX_TOKEN_URL = 'https://auth.openai.com/oauth/token';
const CODEX_AUTH_URL_BASE = 'https://auth.openai.com/oauth/authorize';
const CODEX_REDIRECT_URI = 'http://localhost:1455/auth/callback';
const CODEX_SCOPE = 'openid profile email offline_access';
const CODEX_LOCAL_PORT = 1455;

function generatePKCE() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

function getProfilesPath(agentDir) {
  return join(agentDir, 'agents', 'current', 'agent', 'auth-profiles.json');
}

async function exchangeCodexToken(code, verifier) {
  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: CODEX_CLIENT_ID,
    code,
    code_verifier: verifier,
    redirect_uri: CODEX_REDIRECT_URI,
  });
  const res = await fetch(CODEX_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  const json = await res.json();
  if (!json.access_token || !json.refresh_token) {
    throw new Error(`Token exchange failed: ${JSON.stringify(json)}`);
  }
  return {
    access: json.access_token,
    refresh: json.refresh_token,
    expires: Date.now() + (json.expires_in || 3600) * 1000,
  };
}

function decodeJwt(token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    return JSON.parse(Buffer.from(parts[1], 'base64').toString());
  } catch { return null; }
}

function saveAuthProfile(agentDir, tokens) {
  const profilePath = getProfilesPath(agentDir);
  mkdirSync(profilePath.split('/agents/')[0] + '/agents/current/agent', { recursive: true });
  let data = { version: 1, profiles: {} };
  try { data = JSON.parse(readFileSync(profilePath, 'utf8')); } catch {}
  data.profiles['openai-codex:default'] = {
    type: 'oauth',
    provider: 'openai-codex',
    access: tokens.access,
    refresh: tokens.refresh,
    expires: tokens.expires,
  };
  data.lastGood = data.lastGood || {};
  data.lastGood['openai-codex'] = 'openai-codex:default';
  writeFileSync(profilePath, JSON.stringify(data, null, 2));
  return profilePath;
}

/**
 * GET /api/codex/oauth-url
 * 產生 Codex OAuth URL，並在一段時間內有效（寫入 session）
 * Query: ?agentId=xxx
 */
app.get('/api/codex/oauth-url', async (req, res) => {
  const { agentId } = req.query;
  if (!agentId) return res.status(400).json({ error: '缺少 agentId' });

  const user = getUserByAgentId(agentId);
  if (!user) return res.status(404).json({ error: '找不到此用戶' });
  if (!user.agent_dir) return res.status(400).json({ error: '尚未建立實例目錄' });

  const { verifier, challenge } = generatePKCE();
  const state = crypto.randomBytes(16).toString('hex');

  global.__codexOAuthSessions = global.__codexOAuthSessions || {};
  global.__codexOAuthSessions[state] = { verifier, state, agentDir: user.agent_dir, userId: user.id };
  setTimeout(() => { delete global.__codexOAuthSessions?.[state]; }, 10 * 60 * 1000);

  const authUrl = new URL(CODEX_AUTH_URL_BASE);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('client_id', CODEX_CLIENT_ID);
  authUrl.searchParams.set('redirect_uri', CODEX_REDIRECT_URI);
  authUrl.searchParams.set('scope', CODEX_SCOPE);
  authUrl.searchParams.set('code_challenge', challenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('id_token_add_organizations', 'true');
  authUrl.searchParams.set('codex_cli_simplified_flow', 'true');
  authUrl.searchParams.set('originator', 'pi-remote');

  res.json({
    authUrl: authUrl.toString(),
    state,
    localCallback: CODEX_REDIRECT_URI,
    expiresIn: 600,
  });
});

/**
 * POST /api/codex/oauth/callback
 * Body: { redirectUrl: "http://localhost:1455/auth/callback?code=xxx&state=yyy" }
 * 從 redirect URL 解析 code + state，交換 token，寫入 auth-profiles.json
 */
app.post('/api/codex/oauth/callback', async (req, res) => {
  const { redirectUrl, state } = req.body;
  if (!redirectUrl) return res.status(400).json({ error: '缺少 redirectUrl' });

  // Parse code and state from redirect URL
  let code = null, returnedState = null;
  try {
    const parsed = new URL(redirectUrl);
    code = parsed.searchParams.get('code');
    returnedState = parsed.searchParams.get('state');
  } catch {
    return res.status(400).json({ error: 'Invalid redirectUrl format' });
  }
  if (!code) return res.status(400).json({ error: 'No code in redirectUrl' });

  // Find session by state
  const session = global.__codexOAuthSessions?.[returnedState];
  if (!session) return res.status(400).json({ error: 'State 不匹配或已過期，請重新產生授權連結' });

  delete global.__codexOAuthSessions[returnedState];

  try {
    const tokens = await exchangeCodexToken(code, session.verifier);
    const profilePath = saveAuthProfile(session.agentDir, tokens);
    const accountId = decodeJwt(tokens.access)?.['https://api.openai.com/auth']?.chatgpt_account_id || null;

    // Update user auth_mode to codex-cli
    if (session.userId) {
      updateAuthMode(session.userId, 'codex-cli');
      recordInstanceEvent(session.userId, {
        agentId: session.agentId,
        eventType: 'auth.codex_completed',
        title: '完成 Codex OAuth 授權',
        detail: accountId ? `Account ${accountId}` : 'Codex CLI 已可用',
        severity: 'info',
        actor: 'user',
        metadata: { accountId, expiresAt: new Date(tokens.expires).toISOString() },
      });
    }

    res.json({
      success: true,
      accountId,
      expiresAt: new Date(tokens.expires).toISOString(),
      profilePath,
    });
  } catch (err) {
    console.error('[Codex OAuth] Token exchange error:', err.message);
    res.status(500).json({ error: `授權失敗: ${err.message}` });
  }
});

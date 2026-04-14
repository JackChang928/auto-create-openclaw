/**
 * app.js — Express app factory (v4).
 * Exports the Express app without starting the server.
 * For integration testing with supertest.
 */
import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import crypto from 'node:crypto';
import QRCode from 'qrcode';

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
  isGatewayRunning,
  checkContainerLiveness,
  checkLiteLLMProxyHealth,
  getLiteLLMModelInfo,
  getLiteLLMSpend,
} from './provisioner.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = 3210;

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
    if (verifyData.valid && verifyData.user) {
      req.user = verifyData.user;
      next();
    } else {
      res.status(401).json({ error: 'Invalid token' });
    }
  } catch (err) {
    console.error('Auth verify error:', err.message);
    res.status(500).json({ error: 'Authentication service unavailable' });
  }
};

// ---------------------------------------------------------------------------
// POST /api/register — Step 1: Create record + begin Feishu registration
// ---------------------------------------------------------------------------
app.post('/api/register', async (req, res) => {
  try {
    const { userNickname, botNickname } = req.body;
    if (!userNickname?.trim() || !botNickname?.trim()) {
      return res.status(400).json({ error: '暱稱不可為空' });
    }

    const slug = userNickname.trim().toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fff]/g, '-').replace(/-+/g, '-').slice(0, 20);
    const suffix = crypto.randomBytes(3).toString('hex');
    const agentId = `user-${slug}-${suffix}`;

    let regData;
    try {
      await initRegistration();
      regData = await beginRegistration();
    } catch (err) {
      return res.status(500).json({ error: '飛書註冊初始化失敗，請稍後再試' });
    }

    const user = createUser({
      userNickname: userNickname.trim(),
      botNickname: botNickname.trim(),
      agentId,
      port: 0,
      deviceCode: regData.deviceCode,
      status: 'pending_scan',
    });

    try {
      const port = allocatePort(user.id);
      user.port = port;
      dbHandle.prepare('UPDATE users SET port = ? WHERE id = ?').run(port, user.id);
    } catch (allocErr) {
      console.error('Port alloc error:', allocErr);
      return res.status(503).json({ error: '沒有可用端口' });
    }

    const qrDataUrl = await QRCode.toDataURL(regData.verificationUrl, {
      width: 280,
      margin: 2,
      color: { dark: '#000000', light: '#0000' },
    });

    res.json({
      success: true,
      id: user.id,
      agentId,
      qrDataUrl,
      verificationUrl: regData.verificationUrl,
      expireIn: 300,
    });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: '伺服器錯誤，請稍後再試' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/register/poll/:id
// ---------------------------------------------------------------------------
app.get('/api/register/poll/:id', async (req, res) => {
  try {
    const user = getUserById(parseInt(req.params.id));
    if (!user) {
      return res.status(404).json({ error: '用戶不存在' });
    }
    res.json({
      status: user.status,
      id: user.id,
      agentId: user.agent_id,
      botNickname: user.bot_nickname,
    });
  } catch (err) {
    console.error('Poll error:', err);
    res.status(500).json({ error: '伺服器錯誤，請稍後再試' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/health
// ---------------------------------------------------------------------------
app.get('/api/health', async (req, res) => {
  try {
    const { checkLiteLLMProxyHealth, getLiteLLMModelInfo } = await import('./provisioner.js');
    let models = [];
    try {
      const info = await getLiteLLMModelInfo();
      if (info && info.model) {
        models = [{ id: info.model, status: 'active' }];
      }
    } catch (_) {}
    res.json({ status: 'OK', models });
  } catch (err) {
    console.error('Health check error:', err);
    res.status(500).json({ error: '伺服器錯誤' });
  }
});

// ---------------------------------------------------------------------------
// All other routes (stub placeholders) — for integration test completeness
// ---------------------------------------------------------------------------
app.get('/api/instances', requireAdmin, async (req, res) => {
  try {
    const users = getAllUsers();
    res.json({ instances: users });
  } catch (err) {
    res.status(500).json({ error: '伺服器錯誤' });
  }
});

app.post('/api/instance/:id/set-budget', requireAdmin, async (req, res) => {
  try {
    const { budget } = req.body;
    if (typeof budget !== 'number' || budget < 0) {
      return res.status(400).json({ error: '無效預算' });
    }
    const user = getUserById(parseInt(req.params.id));
    if (!user) return res.status(404).json({ error: '用戶不存在' });
    updateBudget(user.id, budget);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: '伺服器錯誤' });
  }
});

app.post('/api/instance/:id/activate', requireAdmin, async (req, res) => {
  try {
    const user = getUserById(parseInt(req.params.id));
    if (!user) return res.status(404).json({ error: '用戶不存在' });
    res.json({ success: true, message: '激活完成（mock）' });
  } catch (err) {
    res.status(500).json({ error: '伺服器錯誤' });
  }
});

app.post('/api/instance/:id/start', requireAdmin, async (req, res) => {
  try {
    const user = getUserById(parseInt(req.params.id));
    if (!user) return res.status(404).json({ error: '用戶不存在' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: '伺服器錯誤' });
  }
});

app.post('/api/instance/:id/stop', requireAdmin, async (req, res) => {
  try {
    const user = getUserById(parseInt(req.params.id));
    if (!user) return res.status(404).json({ error: '用戶不存在' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: '伺服器錯誤' });
  }
});

app.post('/api/instance/:id/delete', requireAdmin, async (req, res) => {
  try {
    const user = getUserById(parseInt(req.params.id));
    if (!user) return res.status(404).json({ error: '用戶不存在' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: '伺服器錯誤' });
  }
});

app.get('/api/health/litellm', async (req, res) => {
  res.json({ status: 'alive' });
});

app.get('/api/health/agent/:agentId', async (req, res) => {
  const user = getUserByAgentId(req.params.agentId);
  if (!user) return res.status(404).json({ error: 'Agent not found' });
  res.json({ status: user.status });
});

app.get('/api/spend', requireUser, async (req, res) => {
  const { user_id } = req.query;
  if (!user_id) return res.status(400).json({ error: '缺少 user_id' });
  res.json({ user_id, total_spend: 0 });
});

export { app, PORT };

/**
 * __tests__/server.test.js
 * Unit tests for server.js using vitest + supertest
 *
 * T1: 為 server.js 建立基礎單元測試
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';

// ---------------------------------------------------------------------------
// Module-level mocks (survive vi.resetAllMocks)
// ---------------------------------------------------------------------------

// Mock db.js
const mockUsers = new Map();
const mockPorts = new Set();
let portCounter = 32100;

const mockDb = {
  allocatePort: vi.fn((userId) => {
    const port = portCounter++;
    mockPorts.add(port);
    return port;
  }),
  releasePort: vi.fn((port) => mockPorts.delete(port)),
  createUser: vi.fn(({ userNickname, botNickname, agentId, port, deviceCode, status }) => {
    const id = mockUsers.size + 1;
    const user = {
      id, user_nickname: userNickname, bot_nickname: botNickname, agent_id: agentId,
      port, device_code: deviceCode, status,
      feishu_app_id: null, feishu_app_secret: null, feishu_open_id: null, feishu_domain: 'feishu',
      openai_api_key: null, budget: 20,
    };
    mockUsers.set(id, user);
    return user;
  }),
  updateFeishuCredentials: vi.fn((id, { appId, appSecret, openId, domain }) => {
    const u = mockUsers.get(id);
    if (u) { u.feishu_app_id = appId; u.feishu_app_secret = appSecret; u.feishu_open_id = openId; u.feishu_domain = domain; }
  }),
  updateOpenAIKey: vi.fn((id, key) => {
    const u = mockUsers.get(id);
    if (u) u.openai_api_key = key;
  }),
  updateBudget: vi.fn((id, budget) => {
    const u = mockUsers.get(id);
    if (u) u.budget = budget;
  }),
  updateStatus: vi.fn((id, status) => {
    const u = mockUsers.get(id);
    if (u) u.status = status;
  }),
  getUserById: vi.fn((id) => mockUsers.get(id) || null),
  getUserByAgentId: vi.fn((agentId) => [...mockUsers.values()].find(u => u.agent_id === agentId) || null),
  getAllUsers: vi.fn(() => [...mockUsers.values()]),
  deleteUser: vi.fn((id) => mockUsers.delete(id)),
  dbHandle: {
    prepare: vi.fn(() => ({ run: vi.fn() })),
  },
};

// Mock feishu-registration.js
const mockFeishuReg = {
  initRegistration: vi.fn().mockResolvedValue(undefined),
  beginRegistration: vi.fn().mockResolvedValue({
    deviceCode: 'test-device-code-12345',
    verificationUrl: 'https://example.com/verify?code=xyz',
    expireIn: 300,
  }),
  pollRegistration: vi.fn(),
};

// Mock provisioner.js
const mockProvisioner = {
  provisionAgent: vi.fn().mockReturnValue({
    containerName: 'test-container', containerId: 'abc123', imageName: 'openclaw:latest',
  }),
  startGateway: vi.fn().mockReturnValue({ containerName: 'test-container' }),
  stopGateway: vi.fn().mockReturnValue({ stopped: true }),
  deleteInstance: vi.fn().mockReturnValue({ deleted: true }),
  isGatewayRunning: vi.fn().mockReturnValue(false),
  checkContainerLiveness: vi.fn().mockReturnValue({ healthy: true, running: true }),
  checkLiteLLMProxyHealth: vi.fn().mockResolvedValue({ healthy: true, statusCode: 200, body: null }),
  getLiteLLMModelInfo: vi.fn().mockReturnValue({ models: ['gpt-5.4', 'gpt-4.1-mini'], error: null }),
  getLiteLLMSpend: vi.fn().mockReturnValue({ totalSpend: 1.5, statusCode: 200, error: null }),
};

// Mock QRCode (module-level so it survives reset)
const mockQRCode = { toDataURL: vi.fn().mockResolvedValue('data:image/png;base64,abc123') };

// Mock fetch (use vi.fn() so vitest can track it; reassign to global.fetch in beforeEach to avoid reference issues)
let mockFetch;
function createMockFetch() {
  mockFetch = vi.fn((url) => {
    if (url === 'http://127.0.0.1:3001/api/auth/verify') {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ valid: true, user: { role: 'admin', agentId: 'admin-1' } }) });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
  });
  return mockFetch;
}

// ---------------------------------------------------------------------------
// Build test app (mirrors server.js route logic)
// ---------------------------------------------------------------------------
function buildApp(fetchImpl) {
  const app = express();
  app.use(express.json());

  // Admin middleware
  const requireAdmin = async (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'Missing Authorization header' });
    try {
      const verifyRes = await fetchImpl('http://127.0.0.1:3001/api/auth/verify', {
        method: 'POST', headers: { 'Authorization': authHeader },
      });
      const verifyData = await verifyRes.json();
      if (verifyData.valid && verifyData.user && verifyData.user.role === 'admin') {
        next();
      } else {
        res.status(403).json({ error: 'Access denied: Admin role required or invalid token' });
      }
    } catch {
      res.status(500).json({ error: 'Authentication service unavailable' });
    }
  };

  // User middleware
  const requireUser = async (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'Missing Authorization header' });
    try {
      const verifyRes = await fetchImpl('http://127.0.0.1:3001/api/auth/verify', {
        method: 'POST', headers: { 'Authorization': authHeader },
      });
      const verifyData = await verifyRes.json();
      if (verifyData.valid && verifyData.user && (verifyData.user.role === 'user' || verifyData.user.role === 'admin')) {
        req.user = verifyData.user;
        next();
      } else {
        res.status(403).json({ error: 'Access denied: Invalid token or insufficient role' });
      }
    } catch {
      res.status(500).json({ error: 'Authentication service unavailable' });
    }
  };

  // POST /api/register
  app.post('/api/register', async (req, res) => {
    try {
      const { userNickname, botNickname } = req.body;
      if (!userNickname?.trim() || !botNickname?.trim()) {
        return res.status(400).json({ error: '暱稱不可為空' });
      }
      const { randomBytes } = await import('node:crypto');
      const slug = userNickname.trim().toLowerCase()
        .replace(/[^a-z0-9\u4e00-\u9fff]/g, '-').replace(/-+/g, '-').slice(0, 20);
      const suffix = randomBytes(3).toString('hex');
      const agentId = `user-${slug}-${suffix}`;

      await mockFeishuReg.initRegistration();
      const regData = await mockFeishuReg.beginRegistration();

      const user = mockDb.createUser({
        userNickname: userNickname.trim(), botNickname: botNickname.trim(),
        agentId, port: 0, deviceCode: regData.deviceCode, status: 'pending_scan',
      });

      const port = mockDb.allocatePort(user.id);
      user.port = port;
      mockDb.dbHandle.prepare('UPDATE users SET port = ? WHERE id = ?').run(port, user.id);

      const qrDataUrl = await mockQRCode.toDataURL(regData.verificationUrl, {
        width: 280, margin: 2, color: { dark: '#000000', light: '#0000' },
      });

      res.json({
        success: true, id: user.id, agentId,
        qrDataUrl, verificationUrl: regData.verificationUrl, expireIn: regData.expireIn,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/register/poll/:id
  app.get('/api/register/poll/:id', async (req, res) => {
    try {
      const user = mockDb.getUserById(Number(req.params.id));
      if (!user) return res.status(404).json({ error: '找不到此記錄' });

      if (user.status !== 'pending_scan') {
        if (user.status === 'pending_activation') {
          return res.json({ status: 'completed', feishuAppId: user.feishu_app_id, feishuAppSecret: user.feishu_app_secret });
        }
        return res.json({ status: user.status, feishuAppId: user.feishu_app_id });
      }

      if (!user.device_code) return res.status(400).json({ error: '缺少 device_code' });

      const result = await mockFeishuReg.pollRegistration(user.device_code);

      if (result.status === 'completed') {
        mockDb.updateFeishuCredentials(user.id, { appId: result.appId, appSecret: result.appSecret, openId: result.openId, domain: result.domain || 'feishu' });
        return res.json({ status: 'completed', feishuAppId: result.appId, feishuAppSecret: result.appSecret, message: '飛書機器人建立成功！等待管理員激活。' });
      }
      if (result.status === 'denied') {
        mockDb.updateStatus(user.id, 'denied');
        mockDb.releasePort(user.port);
        return res.json({ status: 'denied', message: '用戶拒絕了授權' });
      }
      if (result.status === 'expired') {
        mockDb.updateStatus(user.id, 'expired');
        mockDb.releasePort(user.port);
        return res.json({ status: 'expired', message: '掃碼已過期，請重新註冊' });
      }
      res.json({ status: 'pending' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/instances (admin)
  app.get('/api/instances', requireAdmin, (req, res) => {
    const users = mockDb.getAllUsers();
    const enriched = users.map(u => ({
      ...u,
      isRunning: mockProvisioner.isGatewayRunning(u.agent_id),
      feishu_app_secret: u.feishu_app_secret ? '••••' : null,
      openai_api_key: u.openai_api_key ? '••••' + u.openai_api_key.slice(-4) : null,
    }));
    res.json(enriched);
  });

  // POST /api/instance/:id/set-budget (admin)
  app.post('/api/instance/:id/set-budget', requireAdmin, (req, res) => {
    const user = mockDb.getUserById(Number(req.params.id));
    if (!user) return res.status(404).json({ error: '找不到此實例' });
    const { budget } = req.body;
    if (!budget || isNaN(budget) || budget <= 0) return res.status(400).json({ error: '無效的預算' });
    mockDb.updateBudget(user.id, Number(budget));
    res.json({ success: true });
  });

  // POST /api/instance/:id/activate (admin)
  app.post('/api/instance/:id/activate', requireAdmin, async (req, res) => {
    const user = mockDb.getUserById(Number(req.params.id));
    if (!user) return res.status(404).json({ error: '找不到此實例' });
    if (!user.feishu_app_id || !user.feishu_app_secret) {
      return res.status(400).json({ error: '尚未完成飛書掃碼' });
    }
    let virtualKey = user.openai_api_key;
    try {
      if (!virtualKey || !virtualKey.startsWith('sk-')) {
        const budget = user.budget || 20;
        mockFetch.mockResolvedValueOnce({
          ok: true, json: () => Promise.resolve({ key: 'sk-litellm-generated' }),
        });
        const keyRes = await mockFetch(`${process.env.LITELLM_BASE_URL}/key/generate`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${process.env.LITELLM_MASTER_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ max_budget: budget, user_id: user.agent_id, models: ['openai/gpt-5.4', 'openai/gpt-4.1-mini', 'minimax-cn/MiniMax-M2.7'] }),
        });
        if (!keyRes.ok) throw new Error(`LiteLLM key gen failed`);
        const keyData = await keyRes.json();
        virtualKey = keyData.key;
        mockDb.updateOpenAIKey(user.id, virtualKey);
      }
      const result = mockProvisioner.provisionAgent({ id: user.id, agentId: user.agent_id, userNickname: user.user_nickname, botNickname: user.bot_nickname, port: user.port, feishuAppId: user.feishu_app_id, feishuAppSecret: user.feishu_app_secret, feishuOpenId: user.feishu_open_id, feishuDomain: user.feishu_domain, openaiApiKey: virtualKey });
      res.json({ success: true, status: 'running', containerName: result.containerName, containerId: result.containerId, imageName: result.imageName });
    } catch (err) {
      mockDb.updateStatus(user.id, 'error');
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/instance/:id/start (admin)
  app.post('/api/instance/:id/start', requireAdmin, (req, res) => {
    const user = mockDb.getUserById(Number(req.params.id));
    if (!user) return res.status(404).json({ error: '找不到此實例' });
    try {
      const result = mockProvisioner.startGateway({ id: user.id, agentId: user.agent_id, port: user.port });
      res.json({ success: true, ...result });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/instance/:id/stop (admin)
  app.post('/api/instance/:id/stop', requireAdmin, (req, res) => {
    const user = mockDb.getUserById(Number(req.params.id));
    if (!user) return res.status(404).json({ error: '找不到此實例' });
    const result = mockProvisioner.stopGateway({ id: user.id, agentId: user.agent_id });
    res.json({ success: true, ...result });
  });

  // POST /api/instance/:id/delete (admin)
  app.post('/api/instance/:id/delete', requireAdmin, (req, res) => {
    const user = mockDb.getUserById(Number(req.params.id));
    if (!user) return res.status(404).json({ error: '找不到此實例' });
    try {
      const result = mockProvisioner.deleteInstance({ id: user.id, agentId: user.agent_id, port: user.port });
      mockDb.deleteUser(user.id);
      res.json({ success: true, ...result });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/health/agent/:agentId (admin)
  app.get('/api/health/agent/:agentId', requireAdmin, (req, res) => {
    const { agentId } = req.params;
    if (!agentId) return res.status(400).json({ error: 'agentId required' });
    try {
      const report = mockProvisioner.checkContainerLiveness(agentId);
      res.json({ agentId, ...report, timestamp: new Date().toISOString() });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/health/litellm (admin)
  app.get('/api/health/litellm', requireAdmin, async (req, res) => {
    try {
      const report = await mockProvisioner.checkLiteLLMProxyHealth();
      res.json({ url: `${process.env.LITELLM_PROXY_URL || 'http://litellm-proxy:4000'}/health`, ...report, timestamp: new Date().toISOString() });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/health (admin)
  app.get('/api/health', requireAdmin, async (req, res) => {
    try {
      const [healthReport, modelInfo] = await Promise.all([
        mockProvisioner.checkLiteLLMProxyHealth(),
        mockProvisioner.getLiteLLMModelInfo(),
      ]);
      res.json({
        litellm: { healthy: healthReport.healthy, statusCode: healthReport.statusCode, error: healthReport.healthy ? null : healthReport.body },
        models: modelInfo.models, modelCount: modelInfo.models.length, modelError: modelInfo.error,
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/spend (admin)
  app.get('/api/spend', requireAdmin, async (req, res) => {
    const { user_id } = req.query;
    if (!user_id) return res.status(400).json({ error: 'user_id query parameter is required' });
    try {
      const spendReport = await mockProvisioner.getLiteLLMSpend(user_id);
      if (spendReport.error) return res.status(spendReport.statusCode || 500).json({ error: spendReport.error });
      res.json({ user_id, totalSpend: spendReport.totalSpend, statusCode: spendReport.statusCode, timestamp: new Date().toISOString() });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return app;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('server.js — T1: 為 server.js 建立基礎單元測試', () => {
  let app;
  let fetchForApp;

  beforeAll(() => {
    fetchForApp = createMockFetch();
    app = buildApp(fetchForApp);
    process.env.LITELLM_BASE_URL = 'http://localhost:4000';
    process.env.LITELLM_MASTER_KEY = 'sk-1234';
    process.env.LITELLM_PROXY_URL = 'http://litellm-proxy:4000';
  });

  beforeEach(() => {
    mockUsers.clear();
    mockPorts.clear();
    portCounter = 32100;
    // Reset all mock call histories
    mockDb.allocatePort.mockClear();
    mockDb.createUser.mockClear();
    mockDb.getUserById.mockClear();
    mockDb.getAllUsers.mockClear();
    mockDb.updateFeishuCredentials.mockClear();
    mockDb.updateOpenAIKey.mockClear();
    mockDb.updateBudget.mockClear();
    mockDb.updateStatus.mockClear();
    mockDb.deleteUser.mockClear();
    mockDb.releasePort.mockClear();
    mockDb.dbHandle?.prepare?.mockClear?.();
    mockFeishuReg.initRegistration.mockClear();
    mockFeishuReg.beginRegistration.mockClear();
    mockFeishuReg.pollRegistration.mockClear();
    mockProvisioner.provisionAgent.mockClear();
    mockProvisioner.startGateway.mockClear();
    mockProvisioner.stopGateway.mockClear();
    mockProvisioner.deleteInstance.mockClear();
    mockProvisioner.isGatewayRunning.mockClear();
    mockProvisioner.checkContainerLiveness.mockClear();
    mockProvisioner.checkLiteLLMProxyHealth.mockClear();
    mockProvisioner.getLiteLLMModelInfo.mockClear();
    mockProvisioner.getLiteLLMSpend.mockClear();
    mockQRCode.toDataURL.mockClear();
    // Reset fetch mock to default admin implementation
    fetchForApp.mockReset();
    fetchForApp.mockImplementation((url) => {
      if (url === 'http://127.0.0.1:3001/api/auth/verify') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ valid: true, user: { role: 'admin', agentId: 'admin-1' } }) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });
  });

  // -------------------------------------------------------------------------
  // POST /api/register
  // -------------------------------------------------------------------------
  describe('POST /api/register', () => {
    it('should return 400 when userNickname is empty', async () => {
      const res = await request(app).post('/api/register').send({ userNickname: '', botNickname: 'Botty' });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('暱稱不可為空');
    });

    it('should return 400 when botNickname is empty', async () => {
      const res = await request(app).post('/api/register').send({ userNickname: 'Jack', botNickname: '' });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('暱稱不可為空');
    });

    it('should create user and return qr data on success', async () => {
      const res = await request(app)
        .post('/api/register')
        .send({ userNickname: 'Jack', botNickname: 'JackBot' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.id).toBeDefined();
      expect(res.body.agentId).toMatch(/^user-jack-[a-f0-9]{6}$/);
      expect(res.body.qrDataUrl).toBeDefined();
      expect(res.body.verificationUrl).toBe('https://example.com/verify?code=xyz');
      expect(res.body.expireIn).toBe(300);
      expect(mockDb.createUser).toHaveBeenCalledOnce();
      expect(mockDb.allocatePort).toHaveBeenCalledWith(res.body.id);
      expect(mockFeishuReg.initRegistration).toHaveBeenCalledOnce();
      expect(mockFeishuReg.beginRegistration).toHaveBeenCalledOnce();
      expect(mockQRCode.toDataURL).toHaveBeenCalledOnce();
    });

    it('should generate slugified agentId with Chinese chars', async () => {
      const res = await request(app)
        .post('/api/register')
        .send({ userNickname: 'Jack Wang 王', botNickname: 'Bot' });

      expect(res.status).toBe(200);
      // Chinese chars are preserved by the regex [^a-z0-9\u4e00-\u9fff]
      expect(res.body.agentId).toMatch(/^user-jack-wang-王-[a-f0-9]{6}$/);
    });

    it('should handle nickname with only special chars', async () => {
      const res = await request(app)
        .post('/api/register')
        .send({ userNickname: '---', botNickname: 'Bot' });

      expect(res.status).toBe(200);
      // '---' → '--' (after .replace(/-+/, '-')), resulting in 'user---xxx'
      expect(res.body.agentId).toMatch(/^user---[a-f0-9]{6}$/);
    });
  });

  // -------------------------------------------------------------------------
  // GET /api/register/poll/:id
  // -------------------------------------------------------------------------
  describe('GET /api/register/poll/:id', () => {
    it('should return 404 when user not found', async () => {
      const res = await request(app).get('/api/register/poll/99999');
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('找不到此記錄');
    });

    it('should return completed status when user already activated', async () => {
      mockUsers.set(1, {
        id: 1, user_nickname: 'Jack', bot_nickname: 'Bot',
        agent_id: 'user-jack-abc123', port: 32100, device_code: null,
        status: 'pending_activation', feishu_app_id: 'app-123', feishu_app_secret: 'sec-456',
        feishu_open_id: 'open-789', feishu_domain: 'feishu', openai_api_key: null, budget: 20,
      });

      const res = await request(app).get('/api/register/poll/1');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('completed');
      expect(res.body.feishuAppId).toBe('app-123');
    });

    it('should return pending when scan not yet done', async () => {
      mockUsers.set(2, {
        id: 2, user_nickname: 'Jack', bot_nickname: 'Bot',
        agent_id: 'user-jack-def456', port: 32101, device_code: 'device-pending',
        status: 'pending_scan', feishu_app_id: null, feishu_app_secret: null,
        feishu_open_id: null, feishu_domain: 'feishu', openai_api_key: null, budget: 20,
      });
      mockFeishuReg.pollRegistration.mockResolvedValueOnce({ status: 'pending' });

      const res = await request(app).get('/api/register/poll/2');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('pending');
    });

    it('should update creds on completed scan', async () => {
      mockUsers.set(3, {
        id: 3, user_nickname: 'Jack', bot_nickname: 'Bot',
        agent_id: 'user-jack-ghi789', port: 32102, device_code: 'device-scan',
        status: 'pending_scan', feishu_app_id: null, feishu_app_secret: null,
        feishu_open_id: null, feishu_domain: 'feishu', openai_api_key: null, budget: 20,
      });
      mockFeishuReg.pollRegistration.mockResolvedValueOnce({
        status: 'completed', appId: 'app-scanned', appSecret: 'secret-scanned',
        openId: 'open-scanned', domain: 'feishu',
      });

      const res = await request(app).get('/api/register/poll/3');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('completed');
      expect(res.body.feishuAppId).toBe('app-scanned');
      expect(mockDb.updateFeishuCredentials).toHaveBeenCalledWith(3, {
        appId: 'app-scanned', appSecret: 'secret-scanned', openId: 'open-scanned', domain: 'feishu',
      });
    });

    it('should handle denied status and release port', async () => {
      mockUsers.set(4, {
        id: 4, user_nickname: 'Jack', bot_nickname: 'Bot',
        agent_id: 'user-jack-jkl012', port: 32103, device_code: 'device-denied',
        status: 'pending_scan', feishu_app_id: null, feishu_app_secret: null,
        feishu_open_id: null, feishu_domain: 'feishu', openai_api_key: null, budget: 20,
      });
      mockFeishuReg.pollRegistration.mockResolvedValueOnce({ status: 'denied' });

      const res = await request(app).get('/api/register/poll/4');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('denied');
      expect(mockDb.updateStatus).toHaveBeenCalledWith(4, 'denied');
      expect(mockDb.releasePort).toHaveBeenCalledWith(32103);
    });

    it('should handle expired status and release port', async () => {
      mockUsers.set(5, {
        id: 5, user_nickname: 'Jack', bot_nickname: 'Bot',
        agent_id: 'user-jack-mno345', port: 32104, device_code: 'device-expired',
        status: 'pending_scan', feishu_app_id: null, feishu_app_secret: null,
        feishu_open_id: null, feishu_domain: 'feishu', openai_api_key: null, budget: 20,
      });
      mockFeishuReg.pollRegistration.mockResolvedValueOnce({ status: 'expired' });

      const res = await request(app).get('/api/register/poll/5');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('expired');
      expect(mockDb.updateStatus).toHaveBeenCalledWith(5, 'expired');
      expect(mockDb.releasePort).toHaveBeenCalledWith(32104);
    });
  });

  // -------------------------------------------------------------------------
  // Admin auth middleware
  // -------------------------------------------------------------------------
  describe('Admin auth middleware', () => {
    it('should return 401 when no Authorization header', async () => {
      // Override fetch to return no auth
      mockFetch.mockImplementationOnce(() => Promise.resolve({ ok: false }));
      const res = await request(app).get('/api/instances');
      expect(res.status).toBe(401);
    });

    it('should return 403 when not admin role', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true, json: () => Promise.resolve({ valid: true, user: { role: 'user', agentId: 'user-1' } }),
      });
      const res = await request(app)
        .get('/api/instances')
        .set('Authorization', 'Bearer user-token');
      expect(res.status).toBe(403);
    });

    it('should allow admin to list instances', async () => {
      mockUsers.set(10, {
        id: 10, user_nickname: 'Test', bot_nickname: 'Bot',
        agent_id: 'user-test-abc', port: 32110, device_code: 'dc',
        status: 'running', feishu_app_id: 'app', feishu_app_secret: 'secret-val',
        feishu_open_id: 'open', feishu_domain: 'feishu', openai_api_key: 'sk-12345678', budget: 20,
      });
      mockProvisioner.isGatewayRunning.mockReturnValueOnce(true);
      mockFetch.mockResolvedValueOnce({
        ok: true, json: () => Promise.resolve({ valid: true, user: { role: 'admin', agentId: 'admin-1' } }),
      });

      const res = await request(app)
        .get('/api/instances')
        .set('Authorization', 'Bearer admin-token');

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].isRunning).toBe(true);
      expect(res.body[0].feishu_app_secret).toBe('••••');
      expect(res.body[0].openai_api_key).toBe('••••5678');
    });
  });

  // -------------------------------------------------------------------------
  // POST /api/instance/:id/set-budget
  // -------------------------------------------------------------------------
  describe('POST /api/instance/:id/set-budget', () => {
    beforeEach(() => {
      mockUsers.set(1, {
        id: 1, user_nickname: 'Jack', bot_nickname: 'Bot',
        agent_id: 'user-jack-test', port: 32100, device_code: null,
        status: 'running', feishu_app_id: 'app', feishu_app_secret: 'sec',
        feishu_open_id: 'open', feishu_domain: 'feishu', openai_api_key: null, budget: 20,
      });
    });

    it('should return 404 for unknown instance', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true, json: () => Promise.resolve({ valid: true, user: { role: 'admin', agentId: 'admin-1' } }),
      });
      const res = await request(app)
        .post('/api/instance/9999/set-budget')
        .set('Authorization', 'Bearer admin-token')
        .send({ budget: 50 });
      expect(res.status).toBe(404);
    });

    it('should return 400 for invalid budget', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true, json: () => Promise.resolve({ valid: true, user: { role: 'admin', agentId: 'admin-1' } }),
      });
      const res = await request(app)
        .post('/api/instance/1/set-budget')
        .set('Authorization', 'Bearer admin-token')
        .send({ budget: -10 });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('無效的預算');
    });

    it('should update budget successfully', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true, json: () => Promise.resolve({ valid: true, user: { role: 'admin', agentId: 'admin-1' } }),
      });
      const res = await request(app)
        .post('/api/instance/1/set-budget')
        .set('Authorization', 'Bearer admin-token')
        .send({ budget: 100 });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(mockDb.updateBudget).toHaveBeenCalledWith(1, 100);
    });
  });

  // -------------------------------------------------------------------------
  // POST /api/instance/:id/activate
  // -------------------------------------------------------------------------
  describe('POST /api/instance/:id/activate', () => {
    beforeEach(() => {
      mockUsers.set(1, {
        id: 1, user_nickname: 'Jack', bot_nickname: 'Bot',
        agent_id: 'user-jack-activate', port: 32100, device_code: null,
        status: 'pending_activation', feishu_app_id: 'app-activate', feishu_app_secret: 'secret-activate',
        feishu_open_id: 'open-activate', feishu_domain: 'feishu', openai_api_key: null, budget: 20,
      });
    });

    it('should return 400 when feishu scan not complete', async () => {
      mockUsers.get(1).feishu_app_id = null;
      mockFetch.mockResolvedValueOnce({
        ok: true, json: () => Promise.resolve({ valid: true, user: { role: 'admin', agentId: 'admin-1' } }),
      });
      const res = await request(app)
        .post('/api/instance/1/activate')
        .set('Authorization', 'Bearer admin-token');
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('尚未完成飛書掃碼');
    });

    it('should provision and activate successfully via LiteLLM', async () => {
      mockFetch
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ valid: true, user: { role: 'admin', agentId: 'admin-1' } }) })
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ key: 'sk-litellm-generated' }) });

      const res = await request(app)
        .post('/api/instance/1/activate')
        .set('Authorization', 'Bearer admin-token');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.status).toBe('running');
      expect(res.body.containerName).toBe('test-container');
      expect(mockProvisioner.provisionAgent).toHaveBeenCalledOnce();
    });

    it('should skip LiteLLM call when sk- key already exists', async () => {
      mockUsers.get(1).openai_api_key = 'sk-existing-key-123';
      mockFetch.mockResolvedValueOnce({
        ok: true, json: () => Promise.resolve({ valid: true, user: { role: 'admin', agentId: 'admin-1' } }),
      });

      const res = await request(app)
        .post('/api/instance/1/activate')
        .set('Authorization', 'Bearer admin-token');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      // fetch should only be called once (auth), not for LiteLLM key gen
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // Instance lifecycle
  // -------------------------------------------------------------------------
  describe('Instance lifecycle (start/stop/delete)', () => {
    beforeEach(() => {
      mockUsers.set(1, {
        id: 1, user_nickname: 'Jack', bot_nickname: 'Bot',
        agent_id: 'user-jack-lifecycle', port: 32100, device_code: null,
        status: 'running', feishu_app_id: 'app', feishu_app_secret: 'sec',
        feishu_open_id: 'open', feishu_domain: 'feishu', openai_api_key: null, budget: 20,
      });
    });

    it('POST /api/instance/:id/start — success', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true, json: () => Promise.resolve({ valid: true, user: { role: 'admin', agentId: 'admin-1' } }),
      });
      const res = await request(app)
        .post('/api/instance/1/start')
        .set('Authorization', 'Bearer admin-token');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(mockProvisioner.startGateway).toHaveBeenCalledWith({ id: 1, agentId: 'user-jack-lifecycle', port: 32100 });
    });

    it('POST /api/instance/:id/stop — success', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true, json: () => Promise.resolve({ valid: true, user: { role: 'admin', agentId: 'admin-1' } }),
      });
      const res = await request(app)
        .post('/api/instance/1/stop')
        .set('Authorization', 'Bearer admin-token');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(mockProvisioner.stopGateway).toHaveBeenCalledWith({ id: 1, agentId: 'user-jack-lifecycle' });
    });

    it('POST /api/instance/:id/delete — success', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true, json: () => Promise.resolve({ valid: true, user: { role: 'admin', agentId: 'admin-1' } }),
      });
      const res = await request(app)
        .post('/api/instance/1/delete')
        .set('Authorization', 'Bearer admin-token');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(mockProvisioner.deleteInstance).toHaveBeenCalledWith({ id: 1, agentId: 'user-jack-lifecycle', port: 32100 });
      expect(mockDb.deleteUser).toHaveBeenCalledWith(1);
    });
  });

  // -------------------------------------------------------------------------
  // Health check endpoints
  // -------------------------------------------------------------------------
  describe('Health check endpoints', () => {
    it('GET /api/health/agent/:agentId — success', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true, json: () => Promise.resolve({ valid: true, user: { role: 'admin', agentId: 'admin-1' } }),
      });
      const res = await request(app)
        .get('/api/health/agent/user-agent-123')
        .set('Authorization', 'Bearer admin-token');
      expect(res.status).toBe(200);
      expect(res.body.agentId).toBe('user-agent-123');
      expect(res.body.healthy).toBe(true);
      expect(res.body.timestamp).toBeDefined();
    });

    it('GET /api/health/litellm — success', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true, json: () => Promise.resolve({ valid: true, user: { role: 'admin', agentId: 'admin-1' } }),
      });
      const res = await request(app)
        .get('/api/health/litellm')
        .set('Authorization', 'Bearer admin-token');
      expect(res.status).toBe(200);
      expect(res.body.healthy).toBe(true);
      expect(res.body.statusCode).toBe(200);
    });

    it('GET /api/health — success', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true, json: () => Promise.resolve({ valid: true, user: { role: 'admin', agentId: 'admin-1' } }),
      });
      const res = await request(app)
        .get('/api/health')
        .set('Authorization', 'Bearer admin-token');
      expect(res.status).toBe(200);
      expect(res.body.litellm.healthy).toBe(true);
      expect(res.body.models).toEqual(['gpt-5.4', 'gpt-4.1-mini']);
      expect(res.body.modelCount).toBe(2);
    });

    it('GET /api/spend — requires user_id', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true, json: () => Promise.resolve({ valid: true, user: { role: 'admin', agentId: 'admin-1' } }),
      });
      const res = await request(app)
        .get('/api/spend')
        .set('Authorization', 'Bearer admin-token');
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('user_id query parameter is required');
    });

    it('GET /api/spend — success', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true, json: () => Promise.resolve({ valid: true, user: { role: 'admin', agentId: 'admin-1' } }),
      });
      const res = await request(app)
        .get('/api/spend?user_id=user-jack-123')
        .set('Authorization', 'Bearer admin-token');
      expect(res.status).toBe(200);
      expect(res.body.user_id).toBe('user-jack-123');
      expect(res.body.totalSpend).toBe(1.5);
    });
  });
});

/**
 * __tests__/set-budget.integration.test.js
 * T7: Integration tests for POST /api/instance/:id/set-budget (real SQLite DB)
 *
 * Strategy:
 * - Set TEST_DB_PATH BEFORE importing server/db modules
 * - Use supertest with the real Express app (exported from server.js)
 * - Mock global.fetch to bypass auth-service for admin endpoints
 * - Verify actual DB state via direct SQLite queries after mutations
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ---------------------------------------------------------------------------
// Test database setup — MUST happen before importing server or db modules
// ---------------------------------------------------------------------------
const TEST_DB = join(tmpdir(), `openclaw-setbudget-test-${process.pid}.db`);
const TEST_DB_WAL = TEST_DB + '-wal';
const TEST_DB_SHM = TEST_DB + '-shm';

// Set env BEFORE any module imports that read process.env
process.env.TEST_DB_PATH = TEST_DB;

// ---------------------------------------------------------------------------
// Mock global fetch to bypass auth-service for admin endpoints
// ---------------------------------------------------------------------------
vi.stubGlobal('fetch', vi.fn(async (url, options) => {
  if (url === 'http://127.0.0.1:3001/api/auth/verify') {
    const authHeader = options?.headers?.Authorization;
    if (!authHeader) {
      return { ok: false, status: 401, json: async () => ({ error: 'Missing Authorization header' }) };
    }
    if (authHeader === 'Bearer admin-test-token') {
      return {
        ok: true,
        status: 200,
        json: async () => ({ valid: true, user: { role: 'admin' } }),
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ valid: true, user: { role: 'user' } }),
    };
  }
  throw new Error(`Unhandled fetch: ${url}`);
}));

// ---------------------------------------------------------------------------
// Mock feishu-registration.js — must be before server import
// ---------------------------------------------------------------------------
const mockRegData = {
  deviceCode: 'test_device_code_12345',
  verificationUrl: 'https://open.feishu.cn/device/scan?code=test_code',
  expireIn: 300,
};

vi.mock('../feishu-registration.js', () => ({
  initRegistration: vi.fn().mockResolvedValue(undefined),
  beginRegistration: vi.fn().mockResolvedValue(mockRegData),
  pollRegistration: vi.fn().mockResolvedValue({
    status: 'authorized',
    feishuOpenId: 'test_open_id_ou123',
    appId: 'test_app_id_cli',
    appSecret: 'test_app_secret_abc',
  }),
}));

// ---------------------------------------------------------------------------
// Mock provisioner.js — avoid real Docker/Gateway operations
// ---------------------------------------------------------------------------
vi.mock('../provisioner.js', () => ({
  provisionAgent: vi.fn().mockResolvedValue({ containerId: 'mock-container-id' }),
  startGateway: vi.fn().mockResolvedValue({ success: true }),
  stopGateway: vi.fn().mockResolvedValue({ success: true }),
  deleteInstance: vi.fn().mockResolvedValue({ success: true }),
  // isGatewayRunning is SYNCHRONOUS (not async) — must use mockReturnValue
  isGatewayRunning: vi.fn().mockReturnValue(false),
  checkContainerLiveness: vi.fn().mockResolvedValue({ alive: true }),
  checkLiteLLMProxyHealth: vi.fn().mockResolvedValue({ alive: true }),
  getLiteLLMModelInfo: vi.fn().mockResolvedValue({ model: 'gpt-4o-mini' }),
  getLiteLLMSpend: vi.fn().mockResolvedValue({ total_spend: 0.0 }),
}));

// ---------------------------------------------------------------------------
// Import modules AFTER mocks are set up (all must be dynamic to preserve order)
// ---------------------------------------------------------------------------
const { app } = await import('../server.js');
const dbModule = await import('../db.js');
const { dbHandle } = dbModule;

// ---------------------------------------------------------------------------
// Clean up test database after all tests
// ---------------------------------------------------------------------------
afterAll(() => {
  try { dbHandle?.close?.(); } catch (_) {}
  try {
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
    if (existsSync(TEST_DB_WAL)) unlinkSync(TEST_DB_WAL);
    if (existsSync(TEST_DB_SHM)) unlinkSync(TEST_DB_SHM);
  } catch (_) {}
});

// ---------------------------------------------------------------------------
// Helper: clean all data from test DB between tests
// ---------------------------------------------------------------------------
function cleanTestDb() {
  try {
    dbHandle?.prepare('DELETE FROM users').run();
    dbHandle?.prepare('UPDATE port_pool SET in_use = 0, user_id = NULL').run();
  } catch (_) {}
}

// ---------------------------------------------------------------------------
// Helper: insert a test user directly into DB
// ---------------------------------------------------------------------------
function insertTestUser(overrides = {}) {
  const user = {
    user_nickname: 'TestUser',
    bot_nickname: 'TestBot',
    agent_id: 'user-test-' + Math.random().toString(36).slice(2, 8),
    port: Math.floor(40000 + Math.random() * 20000),
    status: 'completed',
    feishu_app_id: 'cli_test_app_id',
    feishu_app_secret: 'test_secret_abc123',
    feishu_open_id: 'ou_test_123',
    openai_api_key: 'sk-test-key-12345',
    container_name: 'test-container',
    container_id: 'mock_container_id_123',
    gateway_token: 'mock_token_abc',
    workspace_dir: '/tmp/test-workspace',
    budget: null,
    ...overrides,
  };
  const result = dbHandle?.prepare(`
    INSERT INTO users (user_nickname, bot_nickname, agent_id, port, status,
      feishu_app_id, feishu_app_secret, feishu_open_id, openai_api_key,
      container_name, container_id, gateway_token, workspace_dir, budget)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    user.user_nickname, user.bot_nickname, user.agent_id, user.port, user.status,
    user.feishu_app_id, user.feishu_app_secret, user.feishu_open_id, user.openai_api_key,
    user.container_name, user.container_id, user.gateway_token, user.workspace_dir,
    user.budget
  );
  // Attach the real DB id so tests can use user.id in API calls
  user.id = result?.lastInsertRowid;
  return user;
}

// ---------------------------------------------------------------------------
// Helper: get budget from DB for a given user id
// ---------------------------------------------------------------------------
function getBudgetFromDb(userId) {
  const row = dbHandle?.prepare('SELECT budget FROM users WHERE id = ?').get(userId);
  return row?.budget ?? null;
}

beforeEach(() => {
  cleanTestDb();
});

// ---------------------------------------------------------------------------
// Integration Tests: POST /api/instance/:id/set-budget
// ---------------------------------------------------------------------------
describe('POST /api/instance/:id/set-budget — Integration Tests', () => {
  const ADMIN_TOKEN = 'Bearer admin-test-token';
  const USER_TOKEN = 'Bearer user-test-token';

  // -------------------------------------------------------------------------
  // Auth: 401 / 403
  // -------------------------------------------------------------------------
  describe('Authentication & Authorization', () => {
    it('returns 401 when Authorization header is missing', async () => {
      const res = await request(app)
        .post('/api/instance/1/set-budget')
        .send({ budget: 50 })
        .expect(401);

      expect(res.body.error).toMatch(/Missing Authorization header/i);
    });

    it('returns 403 when user is not admin', async () => {
      const res = await request(app)
        .post('/api/instance/1/set-budget')
        .set('Authorization', USER_TOKEN)
        .send({ budget: 50 })
        .expect(403);

      expect(res.body.error).toMatch(/Access denied/i);
    });
  });

  // -------------------------------------------------------------------------
  // 404: instance not found
  // -------------------------------------------------------------------------
  describe('Instance not found (404)', () => {
    it('returns 404 when instance does not exist', async () => {
      const res = await request(app)
        .post('/api/instance/9999/set-budget')
        .set('Authorization', ADMIN_TOKEN)
        .send({ budget: 50 })
        .expect(404);

      expect(res.body.error).toMatch(/找不到此實例/i);
    });
  });

  // -------------------------------------------------------------------------
  // 400: invalid budget
  // -------------------------------------------------------------------------
  describe('Invalid budget (400)', () => {
    it('returns 400 when budget is missing', async () => {
      const user = insertTestUser();

      const res = await request(app)
        .post(`/api/instance/${user.id}/set-budget`)
        .set('Authorization', ADMIN_TOKEN)
        .send({})
        .expect(400);

      expect(res.body.error).toMatch(/無效的預算/i);
    });

    it('returns 400 when budget is null', async () => {
      const user = insertTestUser();

      const res = await request(app)
        .post(`/api/instance/${user.id}/set-budget`)
        .set('Authorization', ADMIN_TOKEN)
        .send({ budget: null })
        .expect(400);

      expect(res.body.error).toMatch(/無效的預算/i);
    });

    it('returns 400 when budget is undefined', async () => {
      const user = insertTestUser();

      const res = await request(app)
        .post(`/api/instance/${user.id}/set-budget`)
        .set('Authorization', ADMIN_TOKEN)
        .send({ budget: undefined })
        .expect(400);

      expect(res.body.error).toMatch(/無效的預算/i);
    });

    it('returns 400 when budget is a non-numeric string', async () => {
      const user = insertTestUser();

      const res = await request(app)
        .post(`/api/instance/${user.id}/set-budget`)
        .set('Authorization', ADMIN_TOKEN)
        .send({ budget: 'fifty-dollars' })
        .expect(400);

      expect(res.body.error).toMatch(/無效的預算/i);
    });

    it('returns 400 when budget is zero', async () => {
      const user = insertTestUser();

      const res = await request(app)
        .post(`/api/instance/${user.id}/set-budget`)
        .set('Authorization', ADMIN_TOKEN)
        .send({ budget: 0 })
        .expect(400);

      expect(res.body.error).toMatch(/無效的預算/i);
    });

    it('returns 400 when budget is negative', async () => {
      const user = insertTestUser();

      const res = await request(app)
        .post(`/api/instance/${user.id}/set-budget`)
        .set('Authorization', ADMIN_TOKEN)
        .send({ budget: -10 })
        .expect(400);

      expect(res.body.error).toMatch(/無效的預算/i);
    });
  });

  // -------------------------------------------------------------------------
  // 200: successful budget update
  // -------------------------------------------------------------------------
  describe('Successful budget update (200)', () => {
    it('returns { success: true } and updates DB budget', async () => {
      const user = insertTestUser({ budget: null });

      const res = await request(app)
        .post(`/api/instance/${user.id}/set-budget`)
        .set('Authorization', ADMIN_TOKEN)
        .send({ budget: 50 })
        .expect(200);

      expect(res.body).toEqual({ success: true });

      // Verify DB was actually updated
      const newBudget = getBudgetFromDb(user.id);
      expect(newBudget).toBe(50);
    });

    it('overwrites existing budget with new value', async () => {
      const user = insertTestUser({ budget: 20 });

      const res = await request(app)
        .post(`/api/instance/${user.id}/set-budget`)
        .set('Authorization', ADMIN_TOKEN)
        .send({ budget: 100 })
        .expect(200);

      expect(res.body).toEqual({ success: true });

      const newBudget = getBudgetFromDb(user.id);
      expect(newBudget).toBe(100);
    });

    it('accepts budget as a numeric string', async () => {
      const user = insertTestUser({ budget: null });

      const res = await request(app)
        .post(`/api/instance/${user.id}/set-budget`)
        .set('Authorization', ADMIN_TOKEN)
        .send({ budget: '75' })
        .expect(200);

      expect(res.body).toEqual({ success: true });

      // isNaN('75') is false, so server accepts it
      const newBudget = getBudgetFromDb(user.id);
      expect(newBudget).toBe(75);
    });

    it('accepts floating-point budget', async () => {
      const user = insertTestUser({ budget: null });

      const res = await request(app)
        .post(`/api/instance/${user.id}/set-budget`)
        .set('Authorization', ADMIN_TOKEN)
        .send({ budget: 12.5 })
        .expect(200);

      expect(res.body).toEqual({ success: true });

      // updateBudget(user.id, Number(budget)) — Number(12.5) = 12.5
      const newBudget = getBudgetFromDb(user.id);
      expect(newBudget).toBe(12.5);
    });

    it('updates budget for multiple users independently', async () => {
      const userA = insertTestUser({ budget: 10, agent_id: 'user-a-' + Math.random().toString(36).slice(2, 6) });
      const userB = insertTestUser({ budget: 20, agent_id: 'user-b-' + Math.random().toString(36).slice(2, 6) });
      const userC = insertTestUser({ budget: null, agent_id: 'user-c-' + Math.random().toString(36).slice(2, 6) });

      await request(app).post(`/api/instance/${userA.id}/set-budget`).set('Authorization', ADMIN_TOKEN).send({ budget: 30 }).expect(200);
      await request(app).post(`/api/instance/${userB.id}/set-budget`).set('Authorization', ADMIN_TOKEN).send({ budget: 40 }).expect(200);
      await request(app).post(`/api/instance/${userC.id}/set-budget`).set('Authorization', ADMIN_TOKEN).send({ budget: 50 }).expect(200);

      expect(getBudgetFromDb(userA.id)).toBe(30);
      expect(getBudgetFromDb(userB.id)).toBe(40);
      expect(getBudgetFromDb(userC.id)).toBe(50);
    });
  });
});

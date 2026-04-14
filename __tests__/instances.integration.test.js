/**
 * __tests__/instances.integration.test.js
 * T6: Integration tests for GET /api/instances (real SQLite DB)
 *
 * Strategy:
 * - Set TEST_DB_PATH BEFORE importing server/db modules
 * - Use supertest with the real Express app (exported from server.js)
 * - Mock feishu-registration.js to avoid real Feishu API calls
 * - Mock provisioner.js to avoid real Docker/Gateway operations
 * - Mock global.fetch to bypass auth-service for admin endpoints
 * - Verify actual DB state and response shape via direct SQLite queries
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ---------------------------------------------------------------------------
// Test database setup — MUST happen before importing server or db modules
// ---------------------------------------------------------------------------
const TEST_DB = join(tmpdir(), `openclaw-instances-test-${process.pid}.db`);
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
    ...overrides,
  };
  dbHandle?.prepare(`
    INSERT INTO users (user_nickname, bot_nickname, agent_id, port, status,
      feishu_app_id, feishu_app_secret, feishu_open_id, openai_api_key,
      container_name, container_id, gateway_token, workspace_dir)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    user.user_nickname, user.bot_nickname, user.agent_id, user.port, user.status,
    user.feishu_app_id, user.feishu_app_secret, user.feishu_open_id, user.openai_api_key,
    user.container_name, user.container_id, user.gateway_token, user.workspace_dir
  );
  return user;
}

beforeEach(() => {
  cleanTestDb();
});

// ---------------------------------------------------------------------------
// Integration Tests: GET /api/instances
// ---------------------------------------------------------------------------
describe('GET /api/instances — Integration Tests', () => {
  const ADMIN_TOKEN = 'Bearer admin-test-token';
  const USER_TOKEN = 'Bearer user-test-token';

  // -------------------------------------------------------------------------
  // Auth: 401 / 403
  // -------------------------------------------------------------------------
  describe('Authentication & Authorization', () => {
    it('returns 401 when Authorization header is missing', async () => {
      const res = await request(app)
        .get('/api/instances')
        .expect(401);

      expect(res.body.error).toMatch(/Missing Authorization header/i);
    });

    it('returns 403 when user is not admin', async () => {
      const res = await request(app)
        .get('/api/instances')
        .set('Authorization', USER_TOKEN)
        .expect(403);

      expect(res.body.error).toMatch(/Access denied/i);
    });
  });

  // -------------------------------------------------------------------------
  // Empty state
  // -------------------------------------------------------------------------
  describe('Empty database', () => {
    it('returns empty array when no users exist', async () => {
      const res = await request(app)
        .get('/api/instances')
        .set('Authorization', ADMIN_TOKEN)
        .expect(200);

      expect(res.body).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // Response shape & secret masking
  // -------------------------------------------------------------------------
  describe('Response shape & field masking', () => {
    it('returns user records with isRunning field and masked secrets', async () => {
      const user = insertTestUser({
        user_nickname: 'Alice',
        bot_nickname: 'AliceBot',
        agent_id: 'user-alice-abc123',
        openai_api_key: 'sk-abcdefghij1234567890',
        feishu_app_secret: 'super_secret_feishu_xyz',
      });

      const res = await request(app)
        .get('/api/instances')
        .set('Authorization', ADMIN_TOKEN)
        .expect(200);

      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBe(1);

      const record = res.body[0];
      expect(record.user_nickname).toBe('Alice');
      expect(record.bot_nickname).toBe('AliceBot');
      expect(record.agent_id).toBe('user-alice-abc123');
      expect(record.status).toBe('completed');
      expect(record.isRunning).toBe(false); // isGatewayRunning is mocked to false

      // Secret masking
      expect(record.feishu_app_secret).toBe('••••');
      expect(record.openai_api_key).toBe('••••7890'); // last 4 chars of sk-abcdefghij1234567890

      // Original secret must NOT be present
      expect(record.feishu_app_secret).not.toBe('super_secret_feishu_xyz');
      expect(record.openai_api_key).not.toBe('sk-abcdefghij1234567890');
    });

    it('returns null for feishu_app_secret when user has none', async () => {
      insertTestUser({
        feishu_app_secret: null,
        openai_api_key: null,
      });

      const res = await request(app)
        .get('/api/instances')
        .set('Authorization', ADMIN_TOKEN)
        .expect(200);

      expect(res.body[0].feishu_app_secret).toBeNull();
      expect(res.body[0].openai_api_key).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Ordering: newest first (created_at DESC)
  // -------------------------------------------------------------------------
  describe('Ordering (newest first)', () => {
    it('returns users ordered by created_at DESC', async () => {
      // Use explicit timestamps to ensure ordering
      dbHandle?.prepare(
        `INSERT INTO users (user_nickname, bot_nickname, agent_id, port, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run('UserA', 'BotA', 'user-a-001', 46100, 'completed', '2026-01-01 10:00:00');
      dbHandle?.prepare(
        `INSERT INTO users (user_nickname, bot_nickname, agent_id, port, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run('UserB', 'BotB', 'user-b-002', 46101, 'completed', '2026-01-02 10:00:00');
      dbHandle?.prepare(
        `INSERT INTO users (user_nickname, bot_nickname, agent_id, port, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run('UserC', 'BotC', 'user-c-003', 46102, 'completed', '2026-01-03 10:00:00');

      const res = await request(app)
        .get('/api/instances')
        .set('Authorization', ADMIN_TOKEN)
        .expect(200);

      expect(res.body.length).toBe(3);
      const nicknames = res.body.map(u => u.user_nickname);
      // Newest first (UserC created 2026-01-03, then UserB, then UserA)
      expect(nicknames).toEqual(['UserC', 'UserB', 'UserA']);
    });
  });

  // -------------------------------------------------------------------------
  // isRunning reflects gateway status
  // -------------------------------------------------------------------------
  describe('isRunning field', () => {
    it('reports isRunning=false when gateway is not running', async () => {
      insertTestUser({ user_nickname: 'OfflineUser', agent_id: 'user-offline-xyz' });

      const res = await request(app)
        .get('/api/instances')
        .set('Authorization', ADMIN_TOKEN)
        .expect(200);

      expect(res.body[0].isRunning).toBe(false);
    });

    it('returns multiple users with correct isRunning for each', async () => {
      // We'll have both users report false since isGatewayRunning is mocked globally
      insertTestUser({ user_nickname: 'User1', agent_id: 'user-1-abc' });
      insertTestUser({ user_nickname: 'User2', agent_id: 'user-2-def' });

      const res = await request(app)
        .get('/api/instances')
        .set('Authorization', ADMIN_TOKEN)
        .expect(200);

      expect(res.body.length).toBe(2);
      res.body.forEach(user => {
        expect(user.isRunning).toBe(false);
      });
    });
  });

  // -------------------------------------------------------------------------
  // Multiple users with all fields populated
  // -------------------------------------------------------------------------
  describe('Multiple users with complete data', () => {
    it('returns all fields correctly for each user', async () => {
      insertTestUser({
        user_nickname: 'Bob',
        bot_nickname: 'BobHelper',
        agent_id: 'user-bob-xyz',
        port: 45000,
        status: 'completed',
        feishu_app_id: 'cli_bob_app',
        feishu_open_id: 'ou_bob_456',
        container_name: 'bob-container',
        container_id: 'bob_container_id',
        gateway_token: 'bob_token',
        workspace_dir: '/workspaces/bob',
      });

      insertTestUser({
        user_nickname: 'Carol',
        bot_nickname: 'CarolBot',
        agent_id: 'user-carol-uvw',
        port: 45001,
        status: 'pending_scan',
        feishu_app_id: null,
        feishu_app_secret: null,
        feishu_open_id: null,
        openai_api_key: null,
        container_name: null,
        container_id: null,
        gateway_token: null,
        workspace_dir: null,
      });

      const res = await request(app)
        .get('/api/instances')
        .set('Authorization', ADMIN_TOKEN)
        .expect(200);

      expect(res.body.length).toBe(2);

      const bob = res.body.find(u => u.user_nickname === 'Bob');
      expect(bob).toBeDefined();
      expect(bob.bot_nickname).toBe('BobHelper');
      expect(bob.agent_id).toBe('user-bob-xyz');
      expect(bob.port).toBe(45000);
      expect(bob.status).toBe('completed');
      expect(bob.feishu_app_id).toBe('cli_bob_app');
      expect(bob.feishu_open_id).toBe('ou_bob_456');
      expect(bob.container_name).toBe('bob-container');
      expect(bob.gateway_token).toBe('bob_token');
      expect(bob.workspace_dir).toBe('/workspaces/bob');
      expect(bob.feishu_app_secret).toBe('••••'); // masked
      // Bob's openai_api_key defaults to 'sk-test-key-12345' → masked to '••••2345'
      expect(bob.openai_api_key).toBe('••••2345');

      const carol = res.body.find(u => u.user_nickname === 'Carol');
      expect(carol).toBeDefined();
      expect(carol.status).toBe('pending_scan');
      expect(carol.feishu_app_id).toBeNull();
      expect(carol.feishu_app_secret).toBeNull();
      expect(carol.openai_api_key).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // DB mutation: adding user reflects in GET /api/instances
  // -------------------------------------------------------------------------
  describe('DB mutation reflected in response', () => {
    it('newly inserted user appears in /api/instances immediately', async () => {
      // Before: empty
      let res = await request(app)
        .get('/api/instances')
        .set('Authorization', ADMIN_TOKEN)
        .expect(200);
      expect(res.body.length).toBe(0);

      // Insert a new user
      insertTestUser({ user_nickname: 'Dave', agent_id: 'user-dave-new' });

      // After: should show the new user
      res = await request(app)
        .get('/api/instances')
        .set('Authorization', ADMIN_TOKEN)
        .expect(200);
      expect(res.body.length).toBe(1);
      expect(res.body[0].user_nickname).toBe('Dave');
    });

    it('deleted user disappears from /api/instances', async () => {
      // Insert two users
      insertTestUser({ user_nickname: 'Eve', agent_id: 'user-eve-first' });
      insertTestUser({ user_nickname: 'Frank', agent_id: 'user-frank-second' });

      let res = await request(app)
        .get('/api/instances')
        .set('Authorization', ADMIN_TOKEN)
        .expect(200);
      expect(res.body.length).toBe(2);

      // Delete the first user from DB
      dbHandle?.prepare('DELETE FROM users WHERE user_nickname = ?').run('Eve');

      res = await request(app)
        .get('/api/instances')
        .set('Authorization', ADMIN_TOKEN)
        .expect(200);
      expect(res.body.length).toBe(1);
      expect(res.body[0].user_nickname).toBe('Frank');
    });
  });

  // -------------------------------------------------------------------------
  // Large dataset
  // -------------------------------------------------------------------------
  describe('Large dataset', () => {
    it('handles many users without crashing', async () => {
      // Insert 50 users
      for (let i = 0; i < 50; i++) {
        insertTestUser({
          user_nickname: `BulkUser${i}`,
          agent_id: `user-bulk-${i.toString().padStart(3, '0')}`,
          port: 50000 + i,
        });
      }

      const res = await request(app)
        .get('/api/instances')
        .set('Authorization', ADMIN_TOKEN)
        .expect(200);

      expect(res.body.length).toBe(50);
      expect(res.body.every(u => u.isRunning === false)).toBe(true);
      expect(res.body.every(u => typeof u.user_nickname === 'string')).toBe(true);
    });
  });
});

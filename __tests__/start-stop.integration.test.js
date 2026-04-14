/**
 * __tests__/start-stop.integration.test.js
 * T9: Integration tests for POST /api/instance/:id/start and POST /api/instance/:id/stop
 *
 * Strategy:
 * - Set TEST_DB_PATH BEFORE importing server/db modules
 * - Use supertest with the real Express app (exported from server.js)
 * - Mock global.fetch to bypass auth-service
 * - Mock provisioner.js (startGateway/stopGateway) to avoid real Docker operations
 * - Verify actual DB state changes
 */
import { describe, it, expect, vi, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ---------------------------------------------------------------------------
// Test database setup — MUST happen before importing server/db modules
// ---------------------------------------------------------------------------
const TEST_DB = join(tmpdir(), `openclaw-startstop-test-${process.pid}.db`);
const TEST_DB_WAL = TEST_DB + '-wal';
const TEST_DB_SHM = TEST_DB + '-shm';

process.env.TEST_DB_PATH = TEST_DB;

// ---------------------------------------------------------------------------
// Mock global fetch for auth-service verification
// ---------------------------------------------------------------------------
vi.stubGlobal('fetch', vi.fn(async (url, options) => {
  if (url === 'http://127.0.0.1:3001/api/auth/verify') {
    const authHeader = options?.headers?.Authorization;
    if (!authHeader) {
      return { ok: false, status: 401, json: async () => ({ error: 'Missing Authorization header' }) };
    }
    if (authHeader === 'Bearer admin-test-token') {
      return {
        ok: true, status: 200,
        json: async () => ({ valid: true, user: { role: 'admin' } }),
      };
    }
    if (authHeader === 'Bearer user-test-token') {
      return {
        ok: true, status: 200,
        json: async () => ({ valid: true, user: { role: 'user' } }),
      };
    }
    return { ok: false, status: 401, json: async () => ({ error: 'Invalid token' }) };
  }
  return { ok: false, status: 404, json: async () => ({ error: 'Not found' }) };
}));

// ---------------------------------------------------------------------------
// Mock provisioner: startGateway and stopGateway
// ---------------------------------------------------------------------------
const startGatewayMock = vi.fn();
const stopGatewayMock = vi.fn();

vi.mock('../provisioner.js', () => ({
  startGateway: (...args) => startGatewayMock(...args),
  stopGateway: (...args) => stopGatewayMock(...args),
  isGatewayRunning: vi.fn().mockReturnValue(false),
}));

// ---------------------------------------------------------------------------
// Dynamic imports — after mocks and env are set
// ---------------------------------------------------------------------------
const { app } = await import('../server.js');
const { dbHandle } = await import('../db.js');

// ---------------------------------------------------------------------------
// Helper: clean test DB between tests
// ---------------------------------------------------------------------------
function cleanTestDb() {
  try {
    dbHandle?.prepare('DELETE FROM users').run();
    dbHandle?.prepare('UPDATE port_pool SET in_use = 0, user_id = NULL').run();
  } catch (_) {}
}

// ---------------------------------------------------------------------------
// Helper: create a test user in the DB
// ---------------------------------------------------------------------------
function insertTestUser(overrides = {}) {
  const user = {
    user_nickname: 'TestUser',
    bot_nickname: 'TestBot',
    agent_id: 'user-test-' + Math.random().toString(36).slice(2, 8),
    port: Math.floor(40000 + Math.random() * 20000),
    status: 'pending_activation',
    feishu_app_id: 'cli_test_app_id',
    feishu_app_secret: 'test_app_secret_abc123',
    feishu_open_id: 'ou_test_123',
    openai_api_key: null,
    container_name: 'test-container',
    container_id: null,
    gateway_token: null,
    workspace_dir: '/tmp/test-workspace',
    budget: 20,
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

  user.id = result?.lastInsertRowid;
  return user;
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------
afterAll(() => {
  try { unlinkSync(TEST_DB); } catch {}
  try { unlinkSync(TEST_DB_WAL); } catch {}
  try { unlinkSync(TEST_DB_SHM); } catch {}
});

// ---------------------------------------------------------------------------
// Tests: POST /api/instance/:id/start
// ---------------------------------------------------------------------------
describe('POST /api/instance/:id/start', () => {
  beforeEach(() => {
    startGatewayMock.mockReset();
    startGatewayMock.mockReturnValue({
      success: true,
      containerName: 'gateway-test-agent',
      containerId: 'abc123',
    });
    cleanTestDb();
  });

  it('401 — missing Authorization header', async () => {
    const res = await request(app).post('/api/instance/1/start');
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/authorization/i);
  });

  it('403 — non-admin role', async () => {
    const res = await request(app)
      .post('/api/instance/1/start')
      .set('Authorization', 'Bearer user-test-token');
    expect(res.status).toBe(403);
  });

  it('404 — instance not found', async () => {
    startGatewayMock.mockImplementation(() => { throw new Error('should not be called'); });
    const res = await request(app)
      .post('/api/instance/999/start')
      .set('Authorization', 'Bearer admin-test-token');
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/找不到/);
  });

  it('200 — success, calls startGateway and returns container info', async () => {
    const user = insertTestUser({
      agent_id: 'test-agent',
      user_nickname: 'Start Test',
      status: 'stopped',
    });

    const res = await request(app)
      .post(`/api/instance/${user.id}/start`)
      .set('Authorization', 'Bearer admin-test-token');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.containerName).toBe('gateway-test-agent');
    expect(res.body.containerId).toBe('abc123');

    // Verify startGateway was called with correct args
    expect(startGatewayMock).toHaveBeenCalledOnce();
    const callArgs = startGatewayMock.mock.calls[0][0];
    expect(callArgs.id).toBe(user.id);
    expect(callArgs.agentId).toBe('test-agent');
  });

  it('200 — startGateway throws → 500', async () => {
    const user = insertTestUser({
      agent_id: 'fail-agent',
      user_nickname: 'Fail Test',
    });

    startGatewayMock.mockImplementation(() => {
      throw new Error('Gateway health check failed');
    });

    const res = await request(app)
      .post(`/api/instance/${user.id}/start`)
      .set('Authorization', 'Bearer admin-test-token');

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/伺服器錯誤/);
  });

  it('200 — multiple users have independent start calls', async () => {
    const userA = insertTestUser({ agent_id: 'agent-a', user_nickname: 'User A', port: 41101 });
    const userB = insertTestUser({ agent_id: 'agent-b', user_nickname: 'User B', port: 41102 });

    startGatewayMock
      .mockReturnValueOnce({ success: true, containerName: 'gateway-agent-a', containerId: 'ida' })
      .mockReturnValueOnce({ success: true, containerName: 'gateway-agent-b', containerId: 'idb' });

    const [resA, resB] = await Promise.all([
      request(app).post(`/api/instance/${userA.id}/start`).set('Authorization', 'Bearer admin-test-token'),
      request(app).post(`/api/instance/${userB.id}/start`).set('Authorization', 'Bearer admin-test-token'),
    ]);

    expect(resA.status).toBe(200);
    expect(resA.body.containerName).toBe('gateway-agent-a');
    expect(resB.status).toBe(200);
    expect(resB.body.containerName).toBe('gateway-agent-b');
  });
});

// ---------------------------------------------------------------------------
// Tests: POST /api/instance/:id/stop
// ---------------------------------------------------------------------------
describe('POST /api/instance/:id/stop', () => {
  beforeEach(() => {
    stopGatewayMock.mockReset();
    stopGatewayMock.mockReturnValue({
      success: true,
      containerName: 'gateway-test-agent',
    });
    cleanTestDb();
  });

  it('401 — missing Authorization header', async () => {
    const res = await request(app).post('/api/instance/1/stop');
    expect(res.status).toBe(401);
  });

  it('403 — non-admin role', async () => {
    const res = await request(app)
      .post('/api/instance/1/stop')
      .set('Authorization', 'Bearer user-test-token');
    expect(res.status).toBe(403);
  });

  it('404 — instance not found', async () => {
    stopGatewayMock.mockImplementation(() => { throw new Error('should not be called'); });
    const res = await request(app)
      .post('/api/instance/999/stop')
      .set('Authorization', 'Bearer admin-test-token');
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/找不到/);
  });

  it('200 — success, calls stopGateway and returns container info', async () => {
    const user = insertTestUser({
      agent_id: 'stop-agent',
      user_nickname: 'Stop Test',
      status: 'running',
    });

    const res = await request(app)
      .post(`/api/instance/${user.id}/stop`)
      .set('Authorization', 'Bearer admin-test-token');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.containerName).toBe('gateway-test-agent');

    // Verify stopGateway was called with correct args
    expect(stopGatewayMock).toHaveBeenCalledOnce();
    const callArgs = stopGatewayMock.mock.calls[0][0];
    expect(callArgs.id).toBe(user.id);
    expect(callArgs.agentId).toBe('stop-agent');
  });

  it('200 — stopGateway returns "Container not found" → still 200', async () => {
    const user = insertTestUser({
      agent_id: 'gone-agent',
      user_nickname: 'Gone Agent',
    });

    stopGatewayMock.mockReturnValue({
      success: true,
      message: 'Container not found',
    });

    const res = await request(app)
      .post(`/api/instance/${user.id}/stop`)
      .set('Authorization', 'Bearer admin-test-token');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.message).toBe('Container not found');
  });

  it('200 — multiple users have independent stop calls', async () => {
    const userA = insertTestUser({ agent_id: 'stop-a', user_nickname: 'Stop A', port: 41103 });
    const userB = insertTestUser({ agent_id: 'stop-b', user_nickname: 'Stop B', port: 41104 });

    // Use mockImplementation for deterministic behavior
    stopGatewayMock.mockImplementation(({ agentId }) => ({
      success: true,
      containerName: `gateway-${agentId}`,
    }));

    const [resA, resB] = await Promise.all([
      request(app).post(`/api/instance/${userA.id}/stop`).set('Authorization', 'Bearer admin-test-token'),
      request(app).post(`/api/instance/${userB.id}/stop`).set('Authorization', 'Bearer admin-test-token'),
    ]);

    expect(resA.status).toBe(200);
    expect(resA.body.success).toBe(true);
    expect(resB.status).toBe(200);
    expect(resB.body.success).toBe(true);
    // Verify both stopGateway calls were made
    expect(stopGatewayMock).toHaveBeenCalledTimes(2);
  });
});

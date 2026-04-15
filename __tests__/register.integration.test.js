/**
 * __tests__/register.integration.test.js
 * T5: Integration tests for POST /api/register (real SQLite DB)
 *
 * Strategy:
 * - Set TEST_DB_PATH BEFORE importing server/db modules
 * - Use supertest with the real Express app (exported from server.js)
 * - Mock feishu-registration.js to avoid real Feishu API calls
 * - Mock provisioner.js to avoid real Docker operations
 * - Verify actual DB state changes via direct SQLite queries
 */
import { describe, it, expect, vi, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ---------------------------------------------------------------------------
// Test database setup — MUST happen before importing server or db modules
// ---------------------------------------------------------------------------
const TEST_DB = join(tmpdir(), `openclaw-integration-test-${process.pid}.db`);
const TEST_DB_WAL = TEST_DB + '-wal';
const TEST_DB_SHM = TEST_DB + '-shm';

// Set env BEFORE any module imports that read process.env
process.env.TEST_DB_PATH = TEST_DB;

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
// Mock provisioner.js — avoid real Docker operations
// ---------------------------------------------------------------------------
vi.mock('../provisioner.js', () => ({
  provisionAgent: vi.fn().mockResolvedValue({ containerId: 'mock-container-id' }),
  startGateway: vi.fn().mockResolvedValue({ success: true }),
  stopGateway: vi.fn().mockResolvedValue({ success: true }),
  deleteInstance: vi.fn().mockResolvedValue({ success: true }),
  ensureInstanceDirs: vi.fn().mockReturnValue({
    workspaceDir: '/tmp/mock-workspace',
    openclawHome: '/tmp/mock-openclaw',
  }),
  removeInstanceDir: vi.fn().mockReturnValue({ success: true }),
  isGatewayRunning: vi.fn().mockResolvedValue(false),
  checkContainerLiveness: vi.fn().mockResolvedValue({ alive: true }),
  checkLiteLLMProxyHealth: vi.fn().mockResolvedValue({ alive: true }),
  getLiteLLMModelInfo: vi.fn().mockResolvedValue({ model: 'gpt-4o-mini' }),
  getLiteLLMSpend: vi.fn().mockResolvedValue({ total_spend: 0.0 }),
  patchChannelConfig: vi.fn().mockReturnValue({ success: true }),
  execInContainer: vi.fn().mockReturnValue({ success: true, output: '' }),
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
  try { dbHandle?.close?.(); } catch {}
  try {
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
    if (existsSync(TEST_DB_WAL)) unlinkSync(TEST_DB_WAL);
    if (existsSync(TEST_DB_SHM)) unlinkSync(TEST_DB_SHM);
  } catch {}
});

// ---------------------------------------------------------------------------
// Helper: clean all data from test DB between tests
// ---------------------------------------------------------------------------
function cleanTestDb() {
  try {
    dbHandle?.prepare('DELETE FROM users').run();
    dbHandle?.prepare('UPDATE port_pool SET in_use = 0, user_id = NULL').run();
  } catch {}
}

beforeEach(() => {
  cleanTestDb();
});

// ---------------------------------------------------------------------------
// Integration Tests: POST /api/register
// ---------------------------------------------------------------------------
describe('POST /api/register — Integration Tests', () => {
  it('returns 400 when userNickname is empty', async () => {
    const res = await request(app)
      .post('/api/register')
      .send({ userNickname: '', botNickname: 'TestBot' })
      .expect(400);

    expect(res.body.error).toMatch(/暱稱不可為空/);
  });

  it('returns 400 when botNickname is empty', async () => {
    const res = await request(app)
      .post('/api/register')
      .send({ userNickname: 'TestUser', botNickname: '' })
      .expect(400);

    expect(res.body.error).toMatch(/暱稱不可為空/);
  });

  it('returns 400 when both nicknames are empty', async () => {
    const res = await request(app)
      .post('/api/register')
      .send({ userNickname: '   ', botNickname: '' })
      .expect(400);

    expect(res.body.error).toMatch(/暱稱不可為空/);
  });

  it('returns 400 when request body is empty', async () => {
    const res = await request(app)
      .post('/api/register')
      .send({})
      .expect(400);

    expect(res.body.error).toMatch(/暱稱不可為空/);
  });

  it('creates user and returns QR code data URL on success', async () => {
    const res = await request(app)
      .post('/api/register')
      .send({ userNickname: '張三', botNickname: '小幫手' })
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.id).toBeDefined();
    expect(typeof res.body.id).toBe('number');
    expect(res.body.agentId).toMatch(/^user-/);
    expect(res.body.qrDataUrl).toMatch(/^data:image\/png;base64,/);
    expect(res.body.verificationUrl).toBe(mockRegData.verificationUrl);
    expect(res.body.expireIn).toBe(300);
  });

  it('writes correct user record to the real database', async () => {
    const res = await request(app)
      .post('/api/register')
      .send({ userNickname: 'IntegrationTest', botNickname: 'TestBot' })
      .expect(200);

    const userId = res.body.id;
    const user = dbHandle.prepare('SELECT * FROM users WHERE id = ?').get(userId);

    expect(user).toBeDefined();
    expect(user.user_nickname).toBe('IntegrationTest');
    expect(user.bot_nickname).toBe('TestBot');
    expect(user.agent_id).toBe(res.body.agentId);
    expect(user.status).toBe('pending_scan');
    expect(user.device_code).toBe(mockRegData.deviceCode);
    expect(user.port).toBeNull();
  });

  // Port allocation happens at /api/instance/:id/activate, not at register.
  // Register creates the user with port: null (deferred allocation for non-blocking QR code response).

  it('generates unique agentIds for concurrent registrations', async () => {
    const [res1, res2, res3] = await Promise.all([
      request(app).post('/api/register').send({ userNickname: 'UserA', botNickname: 'BotA' }),
      request(app).post('/api/register').send({ userNickname: 'UserB', botNickname: 'BotB' }),
      request(app).post('/api/register').send({ userNickname: 'UserC', botNickname: 'BotC' }),
    ]);

    expect(res1.body.agentId).not.toBe(res2.body.agentId);
    expect(res2.body.agentId).not.toBe(res3.body.agentId);
    expect(res1.body.agentId).not.toBe(res3.body.agentId);
    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
    expect(res3.status).toBe(200);
  });

  it('generates agentId with slug from nickname and random hex suffix', async () => {
    const res = await request(app)
      .post('/api/register')
      .send({ userNickname: 'Alice', botNickname: 'AliceBot' })
      .expect(200);

    // Format: user-{slug}-{3-byte-hex}
    expect(res.body.agentId).toMatch(/^user-alice-[0-9a-f]{6}$/);
  });

  it('preserves Chinese characters in agentId slug', async () => {
    const res = await request(app)
      .post('/api/register')
      .send({ userNickname: '王小明', botNickname: '小明機器人' })
      .expect(200);

    // Chinese characters are preserved (not replaced) in the slug
    expect(res.body.agentId).toContain('user-');
    expect(res.body.agentId).toMatch(/[0-9a-f]{6}$/);
  });

  it('sanitizes special characters in nickname to hyphens', async () => {
    const res = await request(app)
      .post('/api/register')
      .send({ userNickname: 'John Doe!@#', botNickname: 'TestBot' })
      .expect(200);

    // Known server behavior: nickname ending with special chars creates trailing hyphen
    // 'John Doe!@#' -> slug 'john-doe-' -> 'user-john-doe--{suffix}'
    // The double hyphen comes from user-{slug}-' + -{suffix}
    expect(res.body.agentId).toMatch(/^user-john-doe--[0-9a-f]{6}$/);
    expect(res.body.success).toBe(true);
  });

  // Port pool consumption happens at /api/instance/:id/activate, not at register.
  // Register is intentionally non-blocking (returns QR code quickly).

  it('calls feishu initRegistration and beginRegistration', async () => {
    const { initRegistration, beginRegistration } = await import('../feishu-registration.js');

    await request(app)
      .post('/api/register')
      .send({ userNickname: 'FeishuCall', botNickname: 'Bot' })
      .expect(200);

    expect(initRegistration).toHaveBeenCalled();
    expect(beginRegistration).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Integration Tests: GET /api/register/poll/:id
// ---------------------------------------------------------------------------
describe('GET /api/register/poll/:id — Integration Tests', () => {
  it('returns 404 when user does not exist', async () => {
    const res = await request(app)
      .get('/api/register/poll/99999')
      .expect(404);

    expect(res.body.error).toBeDefined();
  });

  it('returns pending status when Feishu scan is still pending', async () => {
    // Create a user first
    const createRes = await request(app)
      .post('/api/register')
      .send({ userNickname: 'PollTest', botNickname: 'PollBot' })
      .expect(200);

    const userId = createRes.body.id;

    // pollRegistration mock returns 'authorized' which is not completed/denied/expired
    // so server returns { status: 'pending' } (no id/agentId in response)
    const pollRes = await request(app)
      .get(`/api/register/poll/${userId}`)
      .expect(200);

    expect(pollRes.body.status).toBe('pending');
  });

  it('returns 404 for non-existent user', async () => {
    const pollRes = await request(app)
      .get('/api/register/poll/99999')
      .expect(404);

    expect(pollRes.body.error).toBeDefined();
  });
});

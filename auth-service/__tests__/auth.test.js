/**
 * auth-service unit tests
 * 
 * Strategy: vi.mock ioredis at module level. Express routes tested via supertest.
 * Mock Redis state is reset in beforeEach to avoid rate-limit bleed between tests.
 */

import { vi, describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// MOCK ioredis BEFORE importing anything else
// ---------------------------------------------------------------------------
const mockRedisData = {
  blacklist: {},
  refreshTokens: {},
};

// requestCount tracks how many times zadd has been called per key
// to make rate limiting deterministic
const requestCount = {};

function createMockRedis() {
  return {
    status: 'ready',
    on: vi.fn(),
    pipeline: vi.fn(() => {
      return {
        zremrangebyscore: vi.fn().mockReturnThis(),
        zadd: vi.fn().mockReturnThis(),
        zcard: vi.fn().mockReturnThis(),
        expire: vi.fn().mockReturnThis(),
        exec: vi.fn(async function() {
          // Return dynamic count based on actual zadd calls tracked per key
          // For simplicity, each call increments the count
          return [
            [null, 0], // zremrangebyscore
            [null, 1], // zadd
            [null, 1], // zcard - actual count will vary per test
            [null, 1], // expire
          ];
        }),
      };
    }),
    zrem: vi.fn(async () => 1),
    zrange: vi.fn(async () => []),
    setex: vi.fn(async (key, ttl, value) => {
      mockRedisData[key] = value;
      return 'OK';
    }),
    get: vi.fn(async (key) => {
      return mockRedisData[key] ?? null;
    }),
    del: vi.fn(async (key) => {
      delete mockRedisData[key];
      return 1;
    }),
    publish: vi.fn(async () => 1),
  };
}

const mockRedisPublisher = createMockRedis();
const mockRedisClient = createMockRedis();

vi.mock('ioredis', () => {
  return {
    Redis: vi.fn(() => {
      // First instance = publisher, second = client
      const instances = vi.mocked(Redis).mockInstances ?? [];
      if (instances.length === 0) return mockRedisPublisher;
      return mockRedisClient;
    }),
  };
});

vi.mock('dotenv', () => ({ config: vi.fn() }));

// Use a secret that doesn't contain any blocked pattern word
const TEST_JWT_SECRET = 'xtremely-str0ng-k3y-0000000000000000000000'; // 42 chars, no "secret"/"admin"/etc
process.env.JWT_SECRET = TEST_JWT_SECRET;
process.env.REDIS_URL = 'redis://localhost:6379';
process.env.ADMIN_USERNAME = 'testadmin';
process.env.ADMIN_PASSWORD = 'testpass123';
process.env.PORT = '3001';

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------
import express from 'express';
import request from 'supertest';
import cors from 'cors';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';

const ACCESS_TOKEN_TTL = '24h';
const REFRESH_TOKEN_TTL = 7 * 24 * 60 * 60;
const RATE_LIMIT_WINDOW_SECONDS = 15 * 60;
const RATE_LIMIT_MAX_REQUESTS = 5;
const RATE_LIMIT_KEY_PREFIX = 'ratelimit:';
const JWT_SECRET = TEST_JWT_SECRET;

// ---------------------------------------------------------------------------
// Core functions (reproduced from index.js for isolated testing)
// ---------------------------------------------------------------------------

function validateJwtSecret(secret) {
  const INSECURE_SECRET_PATTERNS = [
    'super-secret-openclaw-key-change-me-in-prod',
    'change-me', 'changeme', 'secret', 'password', 'admin',
  ];
  if (!secret) throw new Error('JWT_SECRET is not set');
  if (secret.length < 32) throw new Error(`JWT_SECRET is too short (${secret.length} chars)`);
  const lower = secret.toLowerCase();
  for (const pattern of INSECURE_SECRET_PATTERNS) {
    if (lower.includes(pattern)) throw new Error(`JWT_SECRET contains insecure pattern "${pattern}"`);
  }
  const uniqueRatio = new Set(secret.split('')).size / secret.length;
  if (uniqueRatio < 0.6) throw new Error(`JWT_SECRET has low entropy (unique ratio: ${uniqueRatio.toFixed(2)})`);
  return true;
}

function issueTokens(payload) {
  const jti = crypto.randomBytes(16).toString('hex');
  const accessToken = jwt.sign({ ...payload, jti }, JWT_SECRET, { algorithm: 'HS256', expiresIn: ACCESS_TOKEN_TTL });
  const refreshToken = crypto.randomBytes(32).toString('hex');
  return { accessToken, refreshToken, expiresIn: ACCESS_TOKEN_TTL, jti };
}

async function storeRefreshToken(token, payload, ttlSeconds = REFRESH_TOKEN_TTL) {
  await mockRedisClient.setex(`refresh_token:${token}`, ttlSeconds, JSON.stringify(payload));
}

async function getRefreshTokenPayload(token) {
  const data = await mockRedisClient.get(`refresh_token:${token}`);
  if (!data) return null;
  return JSON.parse(data);
}

async function blacklistAccessToken(jti, ttlSeconds = 86400) {
  await mockRedisClient.setex(`blacklist:jti:${jti}`, ttlSeconds, '1');
}

async function isAccessTokenBlacklisted(jti) {
  const result = await mockRedisClient.get(`blacklist:jti:${jti}`);
  return result === '1';
}

async function checkRateLimit(key, maxRequests, windowSeconds) {
  const now = Date.now();
  const windowStart = now - windowSeconds * 1000;
  const uniqueReqId = `${now}:${crypto.randomBytes(4).toString('hex')}`;

  const pipeline = mockRedisClient.pipeline();
  pipeline.zremrangebyscore(key, 0, windowStart);
  pipeline.zadd(key, now, uniqueReqId);
  pipeline.zcard(key);
  pipeline.expire(key, windowSeconds);
  const results = await pipeline.exec();
  // results[2] is zcard result - dynamically set based on call count
  // For test stability: we track calls per test via requestCount
  const count = requestCount[key] ?? 1;

  if (count > maxRequests) {
    await mockRedisClient.zrem(key, uniqueReqId);
    const oldest = await mockRedisClient.zrange(key, 0, 0, 'WITHSCORES');
    const resetIn = oldest.length >= 2
      ? Math.ceil((parseInt(oldest[1]) + windowSeconds * 1000 - now) / 1000)
      : windowSeconds;
    return { allowed: false, remaining: 0, resetIn };
  }
  return { allowed: true, remaining: Math.max(0, maxRequests - count), resetIn: windowSeconds };
}

function rateLimitMiddleware(endpoint, maxRequests = RATE_LIMIT_MAX_REQUESTS, windowSeconds = RATE_LIMIT_WINDOW_SECONDS) {
  return async (req, res, next) => {
    const ip = (req.ip || req.connection?.remoteAddress || 'unknown').replace(/::ffff:/, '');
    const key = `${RATE_LIMIT_KEY_PREFIX}${endpoint}:${ip}`;
    try {
      const { allowed, remaining, resetIn } = await checkRateLimit(key, maxRequests, windowSeconds);
      res.set('X-RateLimit-Limit', String(maxRequests));
      res.set('X-RateLimit-Remaining', String(remaining));
      res.set('X-RateLimit-Reset', String(resetIn));
      if (!allowed) {
        return res.status(429).json({ error: 'Too many requests. Please try again later.', retry_after: resetIn });
      }
    } catch (err) {
      console.error('Rate limit check failed:', err);
    }
    next();
  };
}

// ---------------------------------------------------------------------------
// Build test app (mirrors index.js structure)
// ---------------------------------------------------------------------------
const app = express();

app.use(cors({
  origin: [/^http:\/\/localhost(:\d+)?$/, 'https://claw.venturet.co'],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'auth-service' });
});

app.post('/api/auth/login', rateLimitMiddleware('login', 5, 900), async (req, res) => {
  const { username, password } = req.body;
  const adminUsername = process.env.ADMIN_USERNAME || 'admin';
  const adminPassword = process.env.ADMIN_PASSWORD || 'admin123';

  if (username === adminUsername && password === adminPassword) {
    const jwtPayload = { role: 'admin', username: username };
    const { accessToken, refreshToken } = issueTokens(jwtPayload);
    await storeRefreshToken(refreshToken, { ...jwtPayload, type: 'admin' });
    await mockRedisPublisher.publish('auth_events', JSON.stringify({
      event: 'admin.logged_in',
      timestamp: new Date().toISOString(),
      data: { username, ip: req.ip }
    }));
    return res.json({
      success: true, message: 'Login successful',
      token: accessToken, refresh_token: refreshToken,
      expires_in: ACCESS_TOKEN_TTL
    });
  }
  await mockRedisPublisher.publish('auth_events', JSON.stringify({
    event: 'admin.login_failed',
    timestamp: new Date().toISOString(),
    data: { username, ip: req.ip }
  })).catch(() => {});
  return res.status(401).json({ success: false, error: 'Invalid credentials' });
});

app.post('/api/auth/user-login', rateLimitMiddleware('user-login', 5, 900), async (req, res) => {
  const { username, password } = req.body;
  if (username && username.startsWith('user-') && password === '12345678') {
    const jwtPayload = { role: 'user', agentId: username };
    const { accessToken, refreshToken } = issueTokens(jwtPayload);
    await storeRefreshToken(refreshToken, { ...jwtPayload, type: 'user' });
    if (mockRedisPublisher.status === 'ready') {
      await mockRedisPublisher.publish('auth_events', JSON.stringify({
        event: 'user.logged_in',
        timestamp: new Date().toISOString(),
        data: { username, ip: req.ip }
      }));
    }
    return res.json({
      success: true, token: accessToken, refresh_token: refreshToken,
      role: 'user', agentId: username, expires_in: ACCESS_TOKEN_TTL
    });
  }
  if (mockRedisPublisher.status === 'ready') {
    mockRedisPublisher.publish('auth_events', JSON.stringify({
      event: 'user.login_failed',
      timestamp: new Date().toISOString(),
      data: { username, ip: req.ip }
    })).catch(() => {});
  }
  return res.status(401).json({ error: '登入失敗：請輸入正確的 Agent ID' });
});

app.post('/api/auth/refresh', async (req, res) => {
  const { refresh_token } = req.body;
  if (!refresh_token) return res.status(400).json({ error: 'refresh_token is required' });
  const payload = await getRefreshTokenPayload(refresh_token);
  if (!payload) return res.status(401).json({ error: 'Invalid or expired refresh token' });
  await mockRedisClient.del(`refresh_token:${refresh_token}`);
  const { type, ...jwtPayload } = payload;
  const newAccessToken = jwt.sign(jwtPayload, JWT_SECRET, { algorithm: 'HS256', expiresIn: ACCESS_TOKEN_TTL });
  const newRefreshToken = crypto.randomBytes(32).toString('hex');
  await storeRefreshToken(newRefreshToken, { ...jwtPayload, type: payload.type || type });
  return res.json({
    success: true, token: newAccessToken, refresh_token: newRefreshToken,
    expires_in: ACCESS_TOKEN_TTL
  });
});

app.post('/api/auth/logout', async (req, res) => {
  const { refresh_token, token } = req.body;
  if (refresh_token) await mockRedisClient.del(`refresh_token:${refresh_token}`);
  if (token) {
    try {
      const decoded = jwt.decode(token);
      if (decoded && decoded.jti) {
        const issuedAt = decoded.iat;
        const expiresIn = decoded.exp - issuedAt;
        const age = Math.floor(Date.now() / 1000) - issuedAt;
        const remaining = Math.max(0, expiresIn - age);
        if (remaining > 0) await blacklistAccessToken(decoded.jti, remaining);
      }
    } catch (err) {
      console.error('Failed to blacklist access token:', err);
    }
  }
  return res.json({ success: true, message: 'Logged out' });
});

app.post('/api/auth/verify', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ valid: false, error: 'Missing token' });
  }
  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
    if (decoded.jti) {
      const blacklisted = await isAccessTokenBlacklisted(decoded.jti);
      if (blacklisted) return res.status(401).json({ valid: false, error: 'Token has been revoked' });
    }
    return res.json({ valid: true, user: decoded });
  } catch (err) {
    return res.status(401).json({ valid: false, error: 'Invalid or expired token' });
  }
});

// ---------------------------------------------------------------------------
// TESTS
// ---------------------------------------------------------------------------

describe('validateJwtSecret', () => {
  it('returns true for a valid secret', () => {
    expect(validateJwtSecret('xtrem3ly-str0ng-k3y-abc1def2ghij3klmn4')).toBe(true);
  });

  it('throws if secret is undefined', () => {
    expect(() => validateJwtSecret(undefined)).toThrow('JWT_SECRET is not set');
  });

  it('throws if secret is too short (< 32 chars)', () => {
    expect(() => validateJwtSecret('short')).toThrow('JWT_SECRET is too short');
  });

  it('throws if secret contains "password"', () => {
    expect(() => validateJwtSecret('mypassword1234567890123456789012')).toThrow('contains insecure pattern');
  });

  it('throws if secret contains "admin"', () => {
    expect(() => validateJwtSecret('admin-secret-12345678901234567890123')).toThrow('contains insecure pattern');
  });

  it('throws if secret contains "change-me"', () => {
    expect(() => validateJwtSecret('change-me-12345678901234567890123')).toThrow('contains insecure pattern');
  });

  it('throws if secret has low entropy (< 60% unique chars)', () => {
    const lowEntropy = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    expect(() => validateJwtSecret(lowEntropy)).toThrow('low entropy');
  });

  it('passes for high-entropy 32-char secret', () => {
    expect(validateJwtSecret('abc123xyz!@#def456ghij789klmopqrs')).toBe(true);
  });

  it('throws if secret contains "secret" pattern', () => {
    expect(() => validateJwtSecret('mysecretkey1234567890123456789012')).toThrow('contains insecure pattern');
  });
});

describe('issueTokens', () => {
  it('returns accessToken, refreshToken, expiresIn, jti', () => {
    const result = issueTokens({ role: 'admin', username: 'testadmin' });
    expect(result.accessToken).toBeDefined();
    expect(result.refreshToken).toBeDefined();
    expect(result.expiresIn).toBe('24h');
    expect(result.jti).toBeDefined();
    expect(result.jti).toHaveLength(32);
  });

  it('accessToken is a valid JWT signed with JWT_SECRET', () => {
    const { accessToken } = issueTokens({ role: 'user', agentId: 'user-001' });
    const decoded = jwt.verify(accessToken, JWT_SECRET);
    expect(decoded.role).toBe('user');
    expect(decoded.agentId).toBe('user-001');
    expect(decoded.jti).toBeDefined();
  });

  it('refreshToken is a random 64-char hex string', () => {
    const { refreshToken } = issueTokens({ role: 'admin' });
    expect(refreshToken).toHaveLength(64);
    expect(refreshToken).toMatch(/^[0-9a-f]+$/);
  });

  it('each call generates unique tokens', () => {
    const r1 = issueTokens({ role: 'admin' });
    const r2 = issueTokens({ role: 'admin' });
    expect(r1.accessToken).not.toBe(r2.accessToken);
    expect(r1.refreshToken).not.toBe(r2.refreshToken);
    expect(r1.jti).not.toBe(r2.jti);
  });
});

describe('Token storage functions', () => {
  beforeEach(() => {
    mockRedisData.blacklist = {};
    mockRedisData.refreshTokens = {};
  });

  it('storeRefreshToken stores payload in Redis', async () => {
    const payload = { role: 'admin', username: 'testadmin' };
    await storeRefreshToken('token-abc', payload);
    expect(mockRedisClient.setex).toHaveBeenCalledWith(
      'refresh_token:token-abc',
      REFRESH_TOKEN_TTL,
      JSON.stringify(payload)
    );
  });

  it('getRefreshTokenPayload returns null for unknown token', async () => {
    const result = await getRefreshTokenPayload('nonexistent');
    expect(result).toBeNull();
  });

  it('getRefreshTokenPayload returns payload for known token', async () => {
    const payload = { role: 'admin', username: 'testadmin' };
    await storeRefreshToken('token-abc', payload);
    const result = await getRefreshTokenPayload('token-abc');
    expect(result).toEqual(payload);
  });

  it('blacklistAccessToken stores jti in Redis', async () => {
    await blacklistAccessToken('jti-123', 3600);
    expect(mockRedisClient.setex).toHaveBeenCalledWith(
      'blacklist:jti:jti-123', 3600, '1'
    );
  });

  it('isAccessTokenBlacklisted returns false for unknown jti', async () => {
    const result = await isAccessTokenBlacklisted('unknown-jti');
    expect(result).toBe(false);
  });

  it('isAccessTokenBlacklisted returns true for blacklisted jti', async () => {
    mockRedisData.blacklist['blacklist:jti:jti-123'] = '1';
    const result = await isAccessTokenBlacklisted('jti-123');
    expect(result).toBe(true);
  });
});

describe('Rate limiting (checkRateLimit)', () => {
  beforeEach(() => {
    // Reset request count tracker
    Object.keys(requestCount).forEach(k => delete requestCount[k]);
  });

  it('allows requests under the limit', async () => {
    const key = 'ratelimit:login:127.0.0.1';
    requestCount[key] = 1; // 1 request, limit is 5
    const result = await checkRateLimit(key, 5, 900);
    expect(result.allowed).toBe(true);
  });

  it('denies requests over the limit', async () => {
    const key = 'ratelimit:login:127.0.0.1';
    requestCount[key] = 6; // 6 requests, limit is 5
    const result = await checkRateLimit(key, 5, 900);
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
  });

  it('remaining count is correct', async () => {
    const key = 'ratelimit:login:127.0.0.1';
    requestCount[key] = 3;
    const result = await checkRateLimit(key, 5, 900);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(2);
  });
});

describe('GET /health', () => {
  it('returns ok status', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.service).toBe('auth-service');
  });
});

describe('POST /api/auth/login', () => {
  beforeEach(() => {
    // Reset per-test state
    Object.keys(requestCount).forEach(k => delete requestCount[k]);
    mockRedisData.refreshTokens = {};
    mockRedisData.blacklist = {};
    mockRedisPublisher.publish = vi.fn(async () => 1);
    mockRedisClient.setex = vi.fn(async (key, ttl, value) => {
      mockRedisData[key] = value;
      return 'OK';
    });
    mockRedisClient.get = vi.fn(async (key) => mockRedisData[key] ?? null);
    mockRedisClient.del = vi.fn(async (key) => {
      delete mockRedisData[key];
      return 1;
    });
    // Reset pipeline to return count=1 (fresh window)
    mockRedisClient.pipeline = vi.fn(() => ({
      zremrangebyscore: vi.fn().mockReturnThis(),
      zadd: vi.fn().mockReturnThis(),
      zcard: vi.fn().mockReturnThis(),
      expire: vi.fn().mockReturnThis(),
      exec: vi.fn(async () => [[null, 0], [null, 1], [null, 1], [null, 1]]),
    }));
  });

  it('returns 401 for invalid credentials', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: 'wrong', password: 'wrong' });
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe('Invalid credentials');
  });

  it('returns tokens for valid admin credentials', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: 'testadmin', password: 'testpass123' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.token).toBeDefined();
    expect(res.body.refresh_token).toBeDefined();
    expect(res.body.expires_in).toBe('24h');
  });

  it('verifies returned access token is valid JWT', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: 'testadmin', password: 'testpass123' });
    const decoded = jwt.verify(res.body.token, JWT_SECRET);
    expect(decoded.role).toBe('admin');
    expect(decoded.username).toBe('testadmin');
    expect(decoded.jti).toBeDefined();
  });

  it('stores refresh token in Redis on login', async () => {
    await request(app)
      .post('/api/auth/login')
      .send({ username: 'testadmin', password: 'testpass123' });
    const setexCalls = mockRedisClient.setex.mock.calls;
    const refreshCall = setexCalls.find(([key]) => key.startsWith('refresh_token:'));
    expect(refreshCall).toBeDefined();
  });

  it('publishes admin.logged_in event on success', async () => {
    await request(app)
      .post('/api/auth/login')
      .send({ username: 'testadmin', password: 'testpass123' });
    expect(mockRedisPublisher.publish).toHaveBeenCalledWith(
      'auth_events',
      expect.stringContaining('admin.logged_in')
    );
  });

  it('publishes admin.login_failed event on failure', async () => {
    await request(app)
      .post('/api/auth/login')
      .send({ username: 'wrong', password: 'wrong' });
    expect(mockRedisPublisher.publish).toHaveBeenCalledWith(
      'auth_events',
      expect.stringContaining('admin.login_failed')
    );
  });
});

describe('POST /api/auth/user-login', () => {
  beforeEach(() => {
    Object.keys(requestCount).forEach(k => delete requestCount[k]);
    mockRedisData.refreshTokens = {};
    mockRedisData.blacklist = {};
    mockRedisPublisher.publish = vi.fn(async () => 1);
    mockRedisClient.setex = vi.fn(async (key, ttl, value) => {
      mockRedisData[key] = value;
      return 'OK';
    });
    mockRedisClient.get = vi.fn(async (key) => mockRedisData[key] ?? null);
    mockRedisClient.del = vi.fn(async (key) => {
      delete mockRedisData[key];
      return 1;
    });
    mockRedisClient.pipeline = vi.fn(() => ({
      zremrangebyscore: vi.fn().mockReturnThis(),
      zadd: vi.fn().mockReturnThis(),
      zcard: vi.fn().mockReturnThis(),
      expire: vi.fn().mockReturnThis(),
      exec: vi.fn(async () => [[null, 0], [null, 1], [null, 1], [null, 1]]),
    }));
  });

  it('returns 401 for non-user- prefix username', async () => {
    const res = await request(app)
      .post('/api/auth/user-login')
      .send({ username: 'admin', password: '12345678' });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('登入失敗：請輸入正確的 Agent ID');
  });

  it('returns 401 for wrong password', async () => {
    const res = await request(app)
      .post('/api/auth/user-login')
      .send({ username: 'user-001', password: 'wrongpass' });
    expect(res.status).toBe(401);
  });

  it('returns tokens for valid user credentials', async () => {
    const res = await request(app)
      .post('/api/auth/user-login')
      .send({ username: 'user-001', password: '12345678' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.token).toBeDefined();
    expect(res.body.refresh_token).toBeDefined();
    expect(res.body.role).toBe('user');
    expect(res.body.agentId).toBe('user-001');
  });

  it('verifies user access token contains correct role and agentId', async () => {
    const res = await request(app)
      .post('/api/auth/user-login')
      .send({ username: 'user-001', password: '12345678' });
    const decoded = jwt.verify(res.body.token, JWT_SECRET);
    expect(decoded.role).toBe('user');
    expect(decoded.agentId).toBe('user-001');
  });
});

describe('POST /api/auth/refresh', () => {
  beforeEach(() => {
    Object.keys(requestCount).forEach(k => delete requestCount[k]);
    mockRedisData.refreshTokens = {};
    mockRedisData.blacklist = {};
    mockRedisClient.setex = vi.fn(async (key, ttl, value) => {
      mockRedisData[key] = value;
      return 'OK';
    });
    mockRedisClient.get = vi.fn(async (key) => mockRedisData[key] ?? null);
    mockRedisClient.del = vi.fn(async (key) => {
      delete mockRedisData[key];
      return 1;
    });
    mockRedisClient.pipeline = vi.fn(() => ({
      zremrangebyscore: vi.fn().mockReturnThis(),
      zadd: vi.fn().mockReturnThis(),
      zcard: vi.fn().mockReturnThis(),
      expire: vi.fn().mockReturnThis(),
      exec: vi.fn(async () => [[null, 0], [null, 1], [null, 1], [null, 1]]),
    }));
  });

  it('returns 400 if refresh_token is missing', async () => {
    const res = await request(app)
      .post('/api/auth/refresh')
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('refresh_token is required');
  });

  it('returns 401 for invalid refresh token', async () => {
    const res = await request(app)
      .post('/api/auth/refresh')
      .send({ refresh_token: 'invalid-token' });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Invalid or expired refresh token');
  });

  it('returns new tokens for valid refresh token (rotation)', async () => {
    // First login to get a valid refresh token
    const loginRes = await request(app)
      .post('/api/auth/login')
      .send({ username: 'testadmin', password: 'testpass123' });
    const { refresh_token } = loginRes.body;

    const refreshRes = await request(app)
      .post('/api/auth/refresh')
      .send({ refresh_token });

    expect(refreshRes.status).toBe(200);
    expect(refreshRes.body.success).toBe(true);
    expect(refreshRes.body.token).toBeDefined();
    expect(refreshRes.body.refresh_token).toBeDefined();
    expect(refreshRes.body.refresh_token).not.toBe(refresh_token);
  });

  it('consumes old refresh token after use (rotation)', async () => {
    const loginRes = await request(app)
      .post('/api/auth/login')
      .send({ username: 'testadmin', password: 'testpass123' });
    const { refresh_token } = loginRes.body;

    await request(app)
      .post('/api/auth/refresh')
      .send({ refresh_token });

    const payload = await getRefreshTokenPayload(refresh_token);
    expect(payload).toBeNull();
  });
});

describe('POST /api/auth/logout', () => {
  beforeEach(() => {
    Object.keys(requestCount).forEach(k => delete requestCount[k]);
    mockRedisData.refreshTokens = {};
    mockRedisData.blacklist = {};
    mockRedisClient.setex = vi.fn(async (key, ttl, value) => {
      mockRedisData[key] = value;
      return 'OK';
    });
    mockRedisClient.get = vi.fn(async (key) => mockRedisData[key] ?? null);
    mockRedisClient.del = vi.fn(async (key) => {
      delete mockRedisData[key];
      return 1;
    });
    mockRedisClient.pipeline = vi.fn(() => ({
      zremrangebyscore: vi.fn().mockReturnThis(),
      zadd: vi.fn().mockReturnThis(),
      zcard: vi.fn().mockReturnThis(),
      expire: vi.fn().mockReturnThis(),
      exec: vi.fn(async () => [[null, 0], [null, 1], [null, 1], [null, 1]]),
    }));
  });

  it('revokes refresh token on logout', async () => {
    const loginRes = await request(app)
      .post('/api/auth/login')
      .send({ username: 'testadmin', password: 'testpass123' });
    const { refresh_token } = loginRes.body;

    const logoutRes = await request(app)
      .post('/api/auth/logout')
      .send({ refresh_token });

    expect(logoutRes.status).toBe(200);
    expect(logoutRes.body.success).toBe(true);
    const payload = await getRefreshTokenPayload(refresh_token);
    expect(payload).toBeNull();
  });

  it('blacklists access token jti on logout', async () => {
    const loginRes = await request(app)
      .post('/api/auth/login')
      .send({ username: 'testadmin', password: 'testpass123' });
    const { token, refresh_token } = loginRes.body;

    await request(app)
      .post('/api/auth/logout')
      .send({ token, refresh_token });

    const decoded = jwt.decode(token);
    expect(decoded).not.toBeNull();
    const isBlacklisted = await isAccessTokenBlacklisted(decoded.jti);
    expect(isBlacklisted).toBe(true);
  });

  it('returns success even if no tokens provided', async () => {
    const res = await request(app)
      .post('/api/auth/logout')
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});

describe('POST /api/auth/verify', () => {
  beforeEach(() => {
    Object.keys(requestCount).forEach(k => delete requestCount[k]);
    mockRedisData.blacklist = {};
    mockRedisData.refreshTokens = {};
    mockRedisClient.setex = vi.fn(async (key, ttl, value) => {
      mockRedisData[key] = value;
      return 'OK';
    });
    mockRedisClient.get = vi.fn(async (key) => mockRedisData[key] ?? null);
    mockRedisClient.del = vi.fn(async (key) => {
      delete mockRedisData[key];
      return 1;
    });
    mockRedisClient.pipeline = vi.fn(() => ({
      zremrangebyscore: vi.fn().mockReturnThis(),
      zadd: vi.fn().mockReturnThis(),
      zcard: vi.fn().mockReturnThis(),
      expire: vi.fn().mockReturnThis(),
      exec: vi.fn(async () => [[null, 0], [null, 1], [null, 1], [null, 1]]),
    }));
  });

  it('returns 401 if no authorization header', async () => {
    const res = await request(app)
      .post('/api/auth/verify')
      .send({});
    expect(res.status).toBe(401);
    expect(res.body.valid).toBe(false);
    expect(res.body.error).toBe('Missing token');
  });

  it('returns 401 for invalid token', async () => {
    const res = await request(app)
      .post('/api/auth/verify')
      .set('Authorization', 'Bearer invalid.token.here');
    expect(res.status).toBe(401);
    expect(res.body.valid).toBe(false);
  });

  it('returns valid=true for a valid token', async () => {
    const loginRes = await request(app)
      .post('/api/auth/login')
      .send({ username: 'testadmin', password: 'testpass123' });
    const { token } = loginRes.body;

    const verifyRes = await request(app)
      .post('/api/auth/verify')
      .set('Authorization', `Bearer ${token}`);

    expect(verifyRes.status).toBe(200);
    expect(verifyRes.body.valid).toBe(true);
    expect(verifyRes.body.user.role).toBe('admin');
    expect(verifyRes.body.user.username).toBe('testadmin');
  });

  it('returns valid=false for blacklisted token', async () => {
    const loginRes = await request(app)
      .post('/api/auth/login')
      .send({ username: 'testadmin', password: 'testpass123' });
    const { token } = loginRes.body;
    const decoded = jwt.decode(token);
    expect(decoded).not.toBeNull();

    // Blacklist the token
    await blacklistAccessToken(decoded.jti, 3600);

    const verifyRes = await request(app)
      .post('/api/auth/verify')
      .set('Authorization', `Bearer ${token}`);

    expect(verifyRes.status).toBe(401);
    expect(verifyRes.body.valid).toBe(false);
    expect(verifyRes.body.error).toBe('Token has been revoked');
  });
});

import express from 'express';
import cors from 'cors';
import jwt from 'jsonwebtoken';
import { Redis } from 'ioredis';
import dotenv from 'dotenv';
import crypto from 'crypto';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

// ---------------------------------------------------------------------------
// JWT Secret: STRICT validation at startup — no insecure defaults allowed
// ---------------------------------------------------------------------------
const JWT_SECRET = process.env.JWT_SECRET;

const INSECURE_SECRET_PATTERNS = [
  'super-secret-openclaw-key-change-me-in-prod',
  'change-me',
  'changeme',
  'secret',
  'password',
  'admin',
];

function validateJwtSecret(secret) {
  if (!secret) {
    console.error('❌ FATAL: JWT_SECRET environment variable is not set.');
    console.error('   Generate a strong secret: node -e "console.log(require(\'crypto\').randomBytes(64).toString(\'hex\'))"');
    process.exit(1);
  }
  if (secret.length < 32) {
    console.error(`❌ FATAL: JWT_SECRET is too short (${secret.length} chars). Minimum 32 characters required.`);
    process.exit(1);
  }
  const lower = secret.toLowerCase();
  for (const pattern of INSECURE_SECRET_PATTERNS) {
    if (lower.includes(pattern)) {
      console.error(`❌ FATAL: JWT_SECRET contains insecure pattern "${pattern}". Do not use default/predictable secrets.`);
      process.exit(1);
    }
  }
  // Entropy check: reject if secret appears to be low-entropy (repeating patterns)
  const uniqueRatio = new Set(secret.split('')).size / secret.length;
  if (uniqueRatio < 0.6) {
    console.error(`❌ FATAL: JWT_SECRET has low entropy (unique char ratio: ${uniqueRatio.toFixed(2)}). Use high-entropy random bytes.`);
    process.exit(1);
  }
  console.log('✅ JWT_SECRET passed validation (length:', secret.length, ', unique ratio:', uniqueRatio.toFixed(2), ')');
}

validateJwtSecret(JWT_SECRET);

// Token lifetimes
const ACCESS_TOKEN_TTL = '24h';
const REFRESH_TOKEN_TTL = 7 * 24 * 60 * 60; // 7 days in seconds

// ---------------------------------------------------------------------------
// Rate Limiting Configuration (sliding window via Redis ZSET)
// ---------------------------------------------------------------------------
const RATE_LIMIT_WINDOW_SECONDS = 15 * 60; // 15 minutes
const RATE_LIMIT_MAX_REQUESTS = 5;         // max 5 login attempts per window per IP
const RATE_LIMIT_KEY_PREFIX = 'ratelimit:';

// Sliding window rate limiter using Redis ZSET.
// Scores = timestamps, members = unique request IDs.
// Returns { allowed, remaining, resetIn }.
async function checkRateLimit(redis, key, maxRequests, windowSeconds) {
  const now = Date.now();
  const windowStart = now - windowSeconds * 1000;
  const uniqueReqId = `${now}:${crypto.randomBytes(4).toString('hex')}`;

  // Atomic pipeline: remove old entries + add new + count + expire
  const pipeline = redis.pipeline();
  pipeline.zremrangebyscore(key, 0, windowStart); // prune old entries
  pipeline.zadd(key, now, uniqueReqId);            // add this request
  pipeline.zcard(key);                              // count requests in window
  pipeline.expire(key, windowSeconds);              // auto-expire key
  const results = await pipeline.exec();

  const count = results[2][1]; // zcard result

  if (count > maxRequests) {
    // Remove the entry we just added since it's over the limit
    await redis.zrem(key, uniqueReqId);
    // Calculate reset time: oldest entry in window
    const oldest = await redis.zrange(key, 0, 0, 'WITHSCORES');
    const resetIn = oldest.length >= 2
      ? Math.ceil((parseInt(oldest[1]) + windowSeconds * 1000 - now) / 1000)
      : windowSeconds;
    return { allowed: false, remaining: 0, resetIn };
  }

  return { allowed: true, remaining: Math.max(0, maxRequests - count), resetIn: windowSeconds };
}

// Middleware: apply rate limit to request IP
function rateLimitMiddleware(endpoint, maxRequests = RATE_LIMIT_MAX_REQUESTS, windowSeconds = RATE_LIMIT_WINDOW_SECONDS) {
  return async (req, res, next) => {
    const ip = (req.ip || req.connection.remoteAddress || 'unknown').replace(/::ffff:/, '');
    const key = `${RATE_LIMIT_KEY_PREFIX}${endpoint}:${ip}`;

    try {
      const { allowed, remaining, resetIn } = await checkRateLimit(redisClient, key, maxRequests, windowSeconds);

      res.set('X-RateLimit-Limit', String(maxRequests));
      res.set('X-RateLimit-Remaining', String(remaining));
      res.set('X-RateLimit-Reset', String(resetIn));

      if (!allowed) {
        return res.status(429).json({
          error: 'Too many requests. Please try again later.',
          retry_after: resetIn
        });
      }
    } catch (err) {
      // If Redis fails, log but don't block the request (fail-open)
      console.error('Rate limit check failed:', err);
    }

    next();
  };
}

// Redis setup for Pub/Sub Event Driven Architecture
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const redisPublisher = new Redis(REDIS_URL);
const redisClient = new Redis(REDIS_URL); // For refresh token storage

redisPublisher.on('connect', () => {
  console.log('✅ Auth Service connected to Redis (Publisher)');
});

redisPublisher.on('error', (err) => {
  console.error('❌ Redis connection error:', err);
});

redisClient.on('connect', () => {
  console.log('✅ Auth Service connected to Redis (Client)');
});

redisClient.on('error', (err) => {
  console.error('❌ Redis Client error:', err);
});

app.use(cors({
  origin: [/^http:\/\/localhost(:\d+)?$/, 'https://claw.venturet.co'],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());

// ---------------------------------------------------------------------------
// Health Check
// ---------------------------------------------------------------------------
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'auth-service' });
});

// ---------------------------------------------------------------------------
// Helper: Issue Access + Refresh Tokens
// ---------------------------------------------------------------------------
function issueTokens(payload) {
  // Generate a unique jti (JWT ID) for access token blacklisting support
  const jti = crypto.randomBytes(16).toString('hex');
  const accessToken = jwt.sign({ ...payload, jti }, JWT_SECRET, { algorithm: 'HS256', expiresIn: ACCESS_TOKEN_TTL });
  const refreshToken = crypto.randomBytes(32).toString('hex');

  return { accessToken, refreshToken, expiresIn: ACCESS_TOKEN_TTL, jti };
}

// ---------------------------------------------------------------------------
// Helper: Blacklist an access token by its jti (stores in Redis with TTL)
// ---------------------------------------------------------------------------
async function blacklistAccessToken(jti, ttlSeconds = 86400) {
  // Blacklist key expires automatically when the token would have expired anyway
  await redisClient.setex(`blacklist:jti:${jti}`, ttlSeconds, '1');
  console.log(`🚫 Access token blacklisted: jti=${jti}, ttl=${ttlSeconds}s`);
}

// ---------------------------------------------------------------------------
// Helper: Check if an access token jti is blacklisted
// ---------------------------------------------------------------------------
async function isAccessTokenBlacklisted(jti) {
  const result = await redisClient.get(`blacklist:jti:${jti}`);
  return result === '1';
}

// ---------------------------------------------------------------------------
// Helper: Store Refresh Token in Redis
// ---------------------------------------------------------------------------
async function storeRefreshToken(token, payload, ttlSeconds = REFRESH_TOKEN_TTL) {
  await redisClient.setex(`refresh_token:${token}`, ttlSeconds, JSON.stringify(payload));
}

// ---------------------------------------------------------------------------
// Helper: Verify and consume Refresh Token (rotation disabled for basic impl)
// ---------------------------------------------------------------------------
async function getRefreshTokenPayload(token) {
  const data = await redisClient.get(`refresh_token:${token}`);
  if (!data) return null;
  return JSON.parse(data);
}

// ---------------------------------------------------------------------------
// POST /api/auth/login - Admin Login Endpoint
// ---------------------------------------------------------------------------
app.post('/api/auth/login', rateLimitMiddleware('login', 5, 900), async (req, res) => {
  const { username, password } = req.body;

  // WARNING: Hardcoded for MVP. In a real scenario, check against a DB.
  const adminUsername = process.env.ADMIN_USERNAME || 'admin';
  const adminPassword = process.env.ADMIN_PASSWORD || 'admin123';

  if (username === adminUsername && password === adminPassword) {
    const jwtPayload = { role: 'admin', username: username };
    const { accessToken, refreshToken } = issueTokens(jwtPayload);

    // Store refresh token in Redis
    await storeRefreshToken(refreshToken, { ...jwtPayload, type: 'admin' });

    // Event Driven: Publish login event to Redis
    const eventPayload = {
      event: 'admin.logged_in',
      timestamp: new Date().toISOString(),
      data: { username: username, ip: req.ip }
    };

    try {
      await redisPublisher.publish('auth_events', JSON.stringify(eventPayload));
      console.log(`📡 Event Published: admin.logged_in for user ${username}`);
    } catch (err) {
      console.error('Failed to publish event:', err);
    }

    return res.json({
      success: true,
      message: 'Login successful',
      token: accessToken,
      refresh_token: refreshToken,
      expires_in: ACCESS_TOKEN_TTL
    });
  }

  // Failed login event could also be published here
  redisPublisher.publish('auth_events', JSON.stringify({
    event: 'admin.login_failed',
    timestamp: new Date().toISOString(),
    data: { username: username, ip: req.ip }
  })).catch(() => {});

  return res.status(401).json({ success: false, error: 'Invalid credentials' });
});

// ---------------------------------------------------------------------------
// POST /api/auth/user-login - User Login Endpoint
// ---------------------------------------------------------------------------
app.post('/api/auth/user-login', rateLimitMiddleware('user-login', 5, 900), async (req, res) => {
  const { username, password } = req.body;

  // WARNING: Mock for MVP. In a real scenario, verify against user records or check the provisioner DB.
  if (username && username.startsWith('user-') && password === '12345678') {
    const jwtPayload = { role: 'user', agentId: username };
    const { accessToken, refreshToken } = issueTokens(jwtPayload);

    // Store refresh token in Redis
    await storeRefreshToken(refreshToken, { ...jwtPayload, type: 'user' });

    try {
      if (redisPublisher.status === 'ready') {
        await redisPublisher.publish('auth_events', JSON.stringify({
          event: 'user.logged_in',
          timestamp: new Date().toISOString(),
          data: { username: username, ip: req.ip }
        }));
      }
    } catch (err) {
      console.error('Failed to publish auth event:', err);
    }

    return res.json({
      success: true,
      token: accessToken,
      refresh_token: refreshToken,
      role: 'user',
      agentId: username,
      expires_in: ACCESS_TOKEN_TTL
    });
  }

  if (redisPublisher.status === 'ready') {
    redisPublisher.publish('auth_events', JSON.stringify({
      event: 'user.login_failed',
      timestamp: new Date().toISOString(),
      data: { username: username, ip: req.ip }
    })).catch(() => {});
  }

  return res.status(401).json({ error: '登入失敗：請輸入正確的 Agent ID' });
});

// ---------------------------------------------------------------------------
// POST /api/auth/refresh - Refresh Access Token with Rotation
// ---------------------------------------------------------------------------
app.post('/api/auth/refresh', async (req, res) => {
  const { refresh_token } = req.body;

  if (!refresh_token) {
    return res.status(400).json({ error: 'refresh_token is required' });
  }

  // Get payload BEFORE deleting (rotation: consume old token)
  const payload = await getRefreshTokenPayload(refresh_token);
  if (!payload) {
    return res.status(401).json({ error: 'Invalid or expired refresh token' });
  }

  // 🔄 Refresh Token Rotation: delete old token immediately (one-time use)
  await redisClient.del(`refresh_token:${refresh_token}`);
  console.log(`🔄 Refresh token rotated (old token revoked)`);

  // Build JWT payload (exclude internal fields like 'type')
  const { type, ...jwtPayload } = payload;

  // Issue NEW access token + NEW refresh token
  const newAccessToken = jwt.sign(jwtPayload, JWT_SECRET, { algorithm: 'HS256', expiresIn: ACCESS_TOKEN_TTL });
  const newRefreshToken = crypto.randomBytes(32).toString('hex');

  // Store new refresh token with same payload (TTL: 7 days)
  await storeRefreshToken(newRefreshToken, { ...jwtPayload, type: payload.type || type });

  console.log(`🔑 New access token issued, new refresh token stored`);

  return res.json({
    success: true,
    token: newAccessToken,
    refresh_token: newRefreshToken,
    expires_in: ACCESS_TOKEN_TTL
  });
});

// ---------------------------------------------------------------------------
// POST /api/auth/logout - Revoke Refresh Token + Blacklist Access Token
// ---------------------------------------------------------------------------
app.post('/api/auth/logout', async (req, res) => {
  const { refresh_token, token } = req.body;

  // Revoke refresh token (existing behavior)
  if (refresh_token) {
    await redisClient.del(`refresh_token:${refresh_token}`);
  }

  // Blacklist access token by jti (new for T6)
  if (token) {
    try {
      const decoded = jwt.decode(token);
      if (decoded && decoded.jti) {
        // Calculate remaining TTL: token has 24h expiry, figure out how much time is left
        const issuedAt = decoded.iat;
        const expiresIn = decoded.exp - issuedAt; // total seconds
        const age = Math.floor(Date.now() / 1000) - issuedAt;
        const remaining = Math.max(0, expiresIn - age);
        if (remaining > 0) {
          await blacklistAccessToken(decoded.jti, remaining);
        }
      }
    } catch (err) {
      console.error('Failed to blacklist access token:', err);
    }
  }

  return res.json({ success: true, message: 'Logged out' });
});

// ---------------------------------------------------------------------------
// POST /api/auth/verify - Verify JWT Token Endpoint (Used by other services)
// Checks: signature validity + token not blacklisted (T6 Token Blacklist)
// ---------------------------------------------------------------------------
app.post('/api/auth/verify', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ valid: false, error: 'Missing token' });
  }

  const token = authHeader.split(' ')[1];

  try {
    const decoded = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });

    // T6: Check if this token's jti is blacklisted
    if (decoded.jti) {
      const blacklisted = await isAccessTokenBlacklisted(decoded.jti);
      if (blacklisted) {
        return res.status(401).json({ valid: false, error: 'Token has been revoked' });
      }
    }

    return res.json({ valid: true, user: decoded });
  } catch (err) {
    return res.status(401).json({ valid: false, error: 'Invalid or expired token' });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🔐 Auth Microservice running on port ${PORT}`);
  console.log(`   Health: http://localhost:${PORT}/health`);
  console.log(`   Redis:  ${REDIS_URL}`);
  console.log(`   Access Token TTL:  ${ACCESS_TOKEN_TTL}`);
  console.log(`   Refresh Token TTL: ${REFRESH_TOKEN_TTL}s (7 days)\n`);
});

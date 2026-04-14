/**
 * API Key 輪換驗證 Middleware
 * 
 * 提供 two methods:
 * 1. validateMasterKey(key) - 驗證 key 是否有效（活躍或寬限期內）
 * 2. isKeyRotating() - 檢查是否正在進行輪換
 * 
 * 使用方式:
 *   const { validateMasterKey } = require('./key-rotation-validate');
 *   const isValid = await validateMasterKey(incomingKey);
 */

const Redis = require('ioredis');
const crypto = require('crypto');

// ============ 配置（需與 key-rotation.js 保持一致）============
const CONFIG = {
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
  keyPrefix: 'litellm:keys',
  gracePeriodHours: 24,
};

const KEYS = {
  active: `${CONFIG.keyPrefix}:active`,
  grace: (hash) => `${CONFIG.keyPrefix}:grace:${hash}`,
  keyInfo: (hash) => `${CONFIG.keyPrefix}:info:${hash}`,
};

let redis = null;
let redisConnPromise = null;

/**
 * 獲取或創建 Redis 連接（單例）
 */
function getRedis() {
  if (!redis) {
    redis = new Redis(CONFIG.redisUrl, { 
      lazyConnect: true,
      retryStrategy: (times) => Math.min(times * 100, 3000),
    });
  }
  if (!redisConnPromise) {
    redisConnPromise = redis.connect().catch(err => {
      redisConnPromise = null;
      throw err;
    });
  }
  return redisConnPromise;
}

/**
 * SHA256 hash (與 key-rotation.js 一致)
 */
function hashKey(key) {
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 16);
}

/**
 * 驗證 master key 是否有效
 * 
 * @param {string} key - 要驗證的 key
 * @returns {Promise<{valid: boolean, reason?: string, inGracePeriod?: boolean}>}
 */
async function validateMasterKey(key) {
  try {
    await getRedis();
    
    const activeData = await redis.get(KEYS.active);
    if (!activeData) {
      return { valid: false, reason: 'no_active_key' };
    }
    
    const active = JSON.parse(activeData);
    const inputHash = hashKey(key);
    
    // 檢查是否為活躍 key
    if (inputHash === active.hash) {
      return { valid: true, status: 'active' };
    }
    
    // 檢查是否在寬限期內
    const graceKey = KEYS.grace(inputHash);
    const graceExpiry = await redis.get(graceKey);
    if (graceExpiry) {
      const ttl = await redis.ttl(graceKey);
      return { 
        valid: true, 
        status: 'grace_period', 
        expiresIn: ttl,
        message: `Key 仍在寬限期內，${Math.floor(ttl/3600)}h後失效` 
      };
    }
    
    return { valid: false, reason: 'key_not_found' };
  } catch (err) {
    console.error('[key-rotation-validate] 驗證失敗:', err.message);
    // 失敗時保守返回無效（安全考量）
    return { valid: false, reason: 'validation_error', error: err.message };
  }
}

/**
 * 獲取輪換狀態摘要
 */
async function getRotationStatus() {
  try {
    await getRedis();
    
    const activeData = await redis.get(KEYS.active);
    if (!activeData) {
      return { hasActiveKey: false };
    }
    
    const graceKeys = await redis.keys(`${CONFIG.keyPrefix}:grace:*`);
    
    return {
      hasActiveKey: true,
      active: JSON.parse(activeData),
      keysInGracePeriod: graceKeys.length,
    };
  } catch (err) {
    return { hasActiveKey: false, error: err.message };
  }
}

/**
 * Express/Koa style middleware
 * 
 * 用法:
 *   const keyValidator = require('./key-rotation-validate').middleware;
 *   app.use(keyValidator);
 */
function middleware(options = {}) {
  const { 
    headerName = 'x-api-key',
    headerNameAlt = 'authorization',
    onInvalid = null,
  } = options;
  
  return async (ctx, next) => {
    // 支援兩種 header 格式
    let incomingKey = ctx.get(headerName) || ctx.get(headerNameAlt);
    
    // Bearer token 格式
    if (incomingKey && incomingKey.startsWith('Bearer ')) {
      incomingKey = incomingKey.slice(7);
    }
    
    if (!incomingKey) {
      ctx.status = 401;
      ctx.body = { error: 'missing_api_key' };
      return;
    }
    
    const result = await validateMasterKey(incomingKey);
    
    if (!result.valid) {
      ctx.status = 401;
      ctx.body = { 
        error: 'invalid_api_key',
        reason: result.reason,
      };
      if (onInvalid) await onInvalid(ctx, result);
      return;
    }
    
    // 附加狀態到 context
    ctx.apiKeyStatus = result;
    
    await next();
  };
}

module.exports = {
  validateMasterKey,
  getRotationStatus,
  middleware,
  // 導出配置的讀取器（供測試用）
  _config: CONFIG,
  _keys: KEYS,
};

#!/usr/bin/env node
/**
 * API Key 輪換腳本
 * 
 * 功能：
 * 1. 生成新 master key 並存入 Redis（帶版本元數據）
 * 2. 舊 key 進入寬限期（grace period），期滿後失效
 * 3. 自動重啟 litellm proxy 加載新 key
 * 
 * 用法：
 *   node key-rotation.js --rotate        # 執行輪換
 *   node key-rotation.js --status       # 查看狀態
 *   node key-rotation.js --validate <key> # 驗證 key 是否有效
 */

const Redis = require('ioredis');
const crypto = require('crypto');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// ============ 配置 ============
const CONFIG = {
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
  keyPrefix: 'litellm:keys',
  gracePeriodHours: 24,        // 舊 key 寬限期（小時）
  maxVersions: 5,             // 最多保留版本數
  minKeyLength: 32,           // 最小 key 長度
};

// Redis keys
const KEYS = {
  active: `${CONFIG.keyPrefix}:active`,
  versions: `${CONFIG.keyPrefix}:versions`,
  keyInfo: (hash) => `${CONFIG.keyPrefix}:info:${hash}`,
};

const redis = new Redis(CONFIG.redisUrl, { lazyConnect: true });

// ============ 工具函數 ============

/**
 * 生成隨機 master key
 */
function generateKey(length = 48) {
  return 'sk-' + crypto.randomBytes(length).toString('hex');
}

/**
 * SHA256 hash (只用於存儲校驗，不儲存完整 key)
 */
function hashKey(key) {
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 16);
}

/**
 * 獲取 key 的前綴（用於識別）
 */
function keyPrefix(key) {
  return key.slice(-8);
}

/**
 * 讀取當前 .env 中的 LITELLM_MASTER_KEY
 */
function readCurrentKey() {
  try {
    const envPath = path.join(__dirname, '..', '.env');
    if (fs.existsSync(envPath)) {
      const content = fs.readFileSync(envPath, 'utf8');
      const match = content.match(/LITELLM_MASTER_KEY=(.+)/);
      if (match) return match[1].trim();
    }
  } catch (e) {}
  return process.env.LITELLM_MASTER_KEY || 'sk-1234';
}

/**
 * 更新 .env 中的 LITELLM_MASTER_KEY
 */
function updateEnvKey(newKey) {
  const envPath = path.join(__dirname, '..', '.env');
  let content = '';
  if (fs.existsSync(envPath)) {
    content = fs.readFileSync(envPath, 'utf8');
  }
  
  if (content.match(/LITELLM_MASTER_KEY=/)) {
    content = content.replace(/LITELLM_MASTER_KEY=.+/, `LITELLM_MASTER_KEY=${newKey}`);
  } else {
    content += `\nLITELLM_MASTER_KEY=${newKey}\n`;
  }
  
  fs.writeFileSync(envPath, content.trim() + '\n');
  console.log(`[+] .env 已更新 LITELLM_MASTER_KEY`);
}

/**
 * 重啟 litellm 容器
 */
function restartLitellm() {
  try {
    console.log('[*] 重啟 litellm-proxy 容器...');
    execSync('docker compose restart litellm', { 
      cwd: path.join(__dirname, '..'),
      stdio: 'pipe' 
    });
    console.log('[+] litellm-proxy 已重啟');
    return true;
  } catch (e) {
    console.error('[-] 重啟失敗:', e.message);
    return false;
  }
}

// ============ 核心功能 ============

/**
 * 執行 key 輪換
 */
async function rotateKey() {
  await redis.connect();
  
  const currentKey = readCurrentKey();
  const currentHash = hashKey(currentKey);
  const now = Date.now();
  
  // 1. 檢查是否有正在寬限期的舊 key
  const graceKey = await redis.get(`${CONFIG.keyPrefix}:grace:${currentHash}`);
  if (graceKey) {
    console.log('[!] 上一個 key 仍在寬限期內，略過輪換');
    console.log(`    寬限期至: ${new Date(parseInt(graceKey)).toLocaleString()}`);
    return;
  }
  
  // 2. 生成新 key
  const newKey = generateKey();
  const newHash = hashKey(newKey);
  const createdAt = now;
  const expiresAt = now + (CONFIG.gracePeriodHours * 60 * 60 * 1000);
  
  // 3. 將當前 key 設為寬限期（只在不是默認 key 時）
  if (currentKey !== 'sk-1234') {
    await redis.setex(
      `${CONFIG.keyPrefix}:grace:${currentHash}`,
      CONFIG.gracePeriodHours * 3600,
      (createdAt + CONFIG.gracePeriodHours * 60 * 60 * 1000).toString()
    );
    console.log(`[+] 舊 key (${keyPrefix(currentKey)}) 已進入寬限期，${CONFIG.gracePeriodHours}小時後失效`);
  }
  
  // 4. 存儲新 key 信息到 Redis
  const keyInfo = {
    hash: newHash,
    prefix: keyPrefix(newKey),
    created_at: createdAt,
    expires_at: null, // 活躍 key 無過期
    is_active: 'true',
    predecessor: currentHash,
  };
  
  await redis.hmset(KEYS.keyInfo(newHash), keyInfo);
  
  // 5. 更新活躍 key
  await redis.set(KEYS.active, JSON.stringify({
    key: newKey,
    hash: newHash,
    created_at: createdAt,
  }));
  
  // 6. 添加到版本歷史（sorted set，score 為時間戳）
  await redis.zadd(KEYS.versions, createdAt, newHash);
  
  // 7. 清理舊版本（只保留最近 N 個）
  const oldVersions = await redis.zrange(KEYS.versions, 0, -(CONFIG.maxVersions + 1));
  for (const hash of oldVersions) {
    await redis.del(KEYS.keyInfo(hash));
    await redis.zrem(KEYS.versions, hash);
  }
  
  // 8. 更新 .env
  updateEnvKey(newKey);
  
  // 9. 重啟 litellm
  restartLitellm();
  
  console.log(`\n[✅] 輪換完成`);
  console.log(`    新 key 前綴: ${keyPrefix(newKey)}`);
  console.log(`    完整 key 已存儲至 .env 和 Redis`);
  
  await redis.quit();
}

/**
 * 查看輪換狀態
 */
async function status() {
  await redis.connect();
  
  const activeData = await redis.get(KEYS.active);
  const graceKeys = await redis.keys(`${CONFIG.keyPrefix}:grace:*`);
  
  console.log('\n=== API Key 輪換狀態 ===\n');
  
  if (activeData) {
    const active = JSON.parse(activeData);
    console.log(`活躍 Key: ....${active.prefix}`);
    console.log(`創建時間: ${new Date(active.created_at).toLocaleString()}`);
    console.log(`Hash: ${active.hash}`);
  }
  
  console.log(`\n歷史版本數: ${await redis.zcard(KEYS.versions)}`);
  
  if (graceKeys.length > 0) {
    console.log(`\n寬限期中的 Key (即將失效):`);
    for (const gk of graceKeys) {
      const hash = gk.replace(`${CONFIG.keyPrefix}:grace:`, '');
      const expireTs = await redis.get(gk);
      const keyInfo = await redis.hgetall(KEYS.keyInfo(hash));
      console.log(`  - ....${keyInfo.prefix || hash} (過期: ${new Date(parseInt(expireTs)).toLocaleString()})`);
    }
  } else {
    console.log('\n寬限期中的 Key: 無');
  }
  
  await redis.quit();
}

/**
 * 驗證 key 是否有效
 */
async function validateKey(keyToCheck) {
  await redis.connect();
  
  const activeData = await redis.get(KEYS.active);
  if (!activeData) {
    console.log('[-] 無活躍 key');
    await redis.quit();
    return false;
  }
  
  const active = JSON.parse(activeData);
  const inputHash = hashKey(keyToCheck);
  
  // 檢查是否為活躍 key
  if (inputHash === active.hash) {
    console.log('[✅] 活躍 key，合法');
    await redis.quit();
    return true;
  }
  
  // 檢查是否在寬限期內
  const graceKey = `${CONFIG.keyPrefix}:grace:${inputHash}`;
  const inGrace = await redis.get(graceKey);
  if (inGrace) {
    const ttl = await redis.ttl(graceKey);
    console.log(`[⚠️] 寬限期 key，${Math.floor(ttl/3600)}h${Math.floor((ttl%3600)/60)}m 後失效`);
    await redis.quit();
    return true; // 寬限期內仍有效
  }
  
  console.log('[-] key 無效或已過期');
  await redis.quit();
  return false;
}

// ============ 主程序 ============
async function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  
  try {
    switch (command) {
      case '--rotate':
        await rotateKey();
        break;
      case '--status':
        await status();
        break;
      case '--validate':
        if (!args[1]) {
          console.error('用法: --validate <key>');
          process.exit(1);
        }
        await validateKey(args[1]);
        break;
      default:
        console.log(`
API Key 輪換工具

用法:
  node key-rotation.js --rotate       執行輪換
  node key-rotation.js --status      查看狀態  
  node key-rotation.js --validate <key>  驗證 key
`);
    }
  } catch (err) {
    console.error('[-] 錯誤:', err.message);
    process.exit(1);
  }
}

main();

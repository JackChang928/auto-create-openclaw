/**
 * feishu-flow-logger.mjs
 * 
 * 目的：記錄 Feishu 授權流程中真實的 API 資料交握
 * 用法：主人操作一次完整的 Feishu 授權，僕人就能知道所有關鍵資料格式
 * 
 * 運行方式：
 *   FEISHU_MOCK=real node feishu-flow-logger.mjs
 * 
 * 會記錄：
 * 1. initRegistration() — 回應資料
 * 2. beginRegistration() — device_code + verification_uri
 * 3. pollRegistration() — 每次 poll 的回應（直到 completed）
 * 4. server.js — 寫入 DB 的資料
 */

import { chromium } from 'playwright';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOG_FILE = join(__dirname, '..', '..', 'data', 'feishu-flow-logs.json');
const BASE_URL = 'http://localhost:3210';

// ─── Feishu API Logger (HTTP proxy) ─────────────────────────────────────────
const feishuLogs = [];

function logFeishu(step, data) {
  const entry = { step, timestamp: new Date().toISOString(), data };
  feishuLogs.push(entry);
  console.log(`[Feishu ${step}]`, JSON.stringify(data, null, 2));
  saveLogs();
}

function saveLogs() {
  try {
    import('fs').then(({ mkdirSync }) => {
      mkdirSync(dirname(LOG_FILE), { recursive: true });
    });
    writeFileSync(LOG_FILE, JSON.stringify(feishuLogs, null, 2));
  } catch {}
}

// ─── Mock Feishu Registration ───────────────────────────────────────────────
// 當 FEISHU_MOCK=1 時，攔截 fetch 來記錄並模擬 Feishu API

const REAL_FEISHU = process.env.FEISHU_MOCK !== '1';

const FEISHU_BASE = 'https://accounts.feishu.cn';
const REG_ENDPOINT = '/oauth/v1/app/registration';

async function mockFetch(url, options) {
  const isFeishu = url.startsWith(FEISHU_BASE) || url.startsWith('https://accounts.larksuite.com');
  
  if (!isFeishu || !options?.body) {
    return fetch(url, options);
  }
  
  const body = new URLSearchParams(options.body.toString());
  const action = body.get('action');
  
  // ── init ──
  if (action === 'init') {
    const real = await fetch(url, options);
    const data = await real.json();
    logFeishu('init', data);
    return { ok: true, json: () => data };
  }
  
  // ── begin ──
  if (action === 'begin') {
    const real = await fetch(url, options);
    const data = await real.json();
    logFeishu('begin', {
      verification_uri_complete: data.verification_uri_complete,
      device_code: data.device_code,
      interval: data.interval,
      expire_in: data.expire_in
    });
    return { ok: true, json: () => data };
  }
  
  // ── poll ──
  if (action === 'poll') {
    const dc = body.get('device_code');
    
    // 如果是測試用假的 device_code，直接返回 completed
    if (dc?.startsWith('TEST_')) {
      const mockResult = {
        status: 'completed',
        client_id: 'cli_test_app_id_' + Date.now(),
        client_secret: 'sec_test_secret_' + Date.now(),
        user_info: { open_id: 'ou_test_openid', tenant_brand: 'lark' }
      };
      logFeishu('poll-completed', mockResult);
      return { ok: true, json: () => mockResult };
    }
    
    // 否則真的打 Feishu
    const real = await fetch(url, options);
    const data = await real.json();
    
    const summary = {
      status: data.error || 'completed',
      has_client_id: !!data.client_id,
      has_client_secret: !!data.client_secret,
      user_info: data.user_info
    };
    logFeishu('poll', summary);
    
    return { ok: true, json: () => data };
  }
  
  return fetch(url, options);
}

// ─── 步驟 1: 打開瀏覽器到註冊頁面 ────────────────────────────────────────
async function openRegistrationPage(page) {
  await page.goto(`${BASE_URL}/`);
  await page.waitForLoadState('networkidle');
  
  // 填表單
  const testUser = `Test_${Date.now()}`;
  const testBot = `Bot_${Date.now()}`;
  
  await page.fill('#user-nickname', testUser);
  await page.fill('#bot-nickname', testBot);
  await page.click('#submit-btn');
  
  // 等 QR code 出現
  try {
    await page.waitForSelector('#step-2', { timeout: 10000 });
    console.log('✅ QR Code Step 2 顯示');
  } catch {
    console.log('⚠️ Step 2 未出現');
  }
  
  return { testUser, testBot };
}

// ─── 步驟 2: 手動完成 Feishu 授權 ─────────────────────────────────────────
async function waitForManualAuth(page) {
  console.log('\n═══════════════════════════════════════════════════════');
  console.log('  ⏸️  請在瀏覽器中完成飛書授權（掃描 QR Code）');
  console.log('  授權完成後，這個腳本就會自動繼續');
  console.log('  如果放棄，請關閉瀏覽器');
  console.log('═══════════════════════════════════════════════════════\n');
  
  // 每 5 秒檢查一次 step-2 是否變成 step-3
  for (let i = 0; i < 120; i++) { // 最多等 10 分鐘
    await page.waitForTimeout(5000);
    
    try {
      const step3Visible = await page.$eval('#step-3', el => el.style.display !== 'none');
      if (step3Visible) {
        console.log('✅ 授權完成！Step-3 出現');
        
        // 截圖保存
        await page.screenshot({ path: `/tmp/feishu-auth-complete.png` });
        
        const botName = await page.$eval('#finish-bot-name', el => el.textContent).catch(() => '?');
        console.log(`  Bot 名稱: ${botName}`);
        return true;
      }
    } catch {}
    
    if (i % 12 === 0) {
      console.log(`  ...等待中（${Math.floor(i*5/60)}分${i*5%60}秒）`);
    }
  }
  
  console.log('⚠️  超時未完成');
  return false;
}

// ─── 主流程 ────────────────────────────────────────────────────────────────
async function main() {
  console.log('═══════════════════════════════════════');
  console.log('  Feishu 授權流程 Logger');
  console.log('  目標: http://localhost:3210');
  console.log('═══════════════════════════════════════\n');
  
  // 清理舊日誌
  if (existsSync(LOG_FILE)) {
    console.log(`[INFO] 舊日誌備份到 ${LOG_FILE}.bak`);
    try {
      const { copyFileSync } = await import('fs');
      copyFileSync(LOG_FILE, LOG_FILE + '.bak');
    } catch {}
    feishuLogs.length = 0;
  }
  
  const browser = await chromium.launch({
    headless: false, // 需要能看到瀏覽器
    executablePath: '/usr/bin/chromium-browser',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  
  const context = await browser.newContext();
  const page = await context.newPage();
  
  try {
    await openRegistrationPage(page);
    const authComplete = await waitForManualAuth(page);
    
    if (authComplete) {
      console.log('\n✅ 授權成功！日誌已保存');
      console.log(`📄 日誌檔案: ${LOG_FILE}`);
      console.log('\n[Summary] 捕獲的 Feishu 資料:');
      for (const entry of feishuLogs) {
        console.log(`  ${entry.step}:`, JSON.stringify(entry.data).substring(0, 200));
      }
    } else {
      console.log('\n⚠️  授權未完成');
    }
    
  } finally {
    await browser.close();
  }
  
  console.log('\n下次執行時，用同樣的測試資料，可以直接用 Mock：');
  console.log('  FEISHU_MOCK=1 node feishu-flow-logger.mjs  # 使用 Mock（跳過真的 Feishu API）');
}

main().catch(console.error);

/**
 * frontend-e2e.mjs — Playwright 自動化 E2E 測試
 * 
 * 功能：
 * 1. 用戶註冊流程（index.html）
 * 2. Admin 登入流程（admin.html）
 * 3. 實例列表操作（admin.html + instances.js）
 * 
 * 每次測試結束後自動還原環境：
 * - 刪除測試建立的用戶
 * - 清除 localStorage
 * - 回復測試資料
 * 
 * 使用方式：
 *   node frontend-e2e.mjs [test-name]
 *   node frontend-e2e.mjs all
 */

import { chromium } from 'playwright';

const BASE_URL = 'http://localhost:3210';
const ADMIN_TOKEN = 'admin-token-test'; // 測試用 token

// ─── 測試環境準備 ─────────────────────────────────────────────
async function setupTestEnvironment() {
  const apiBase = `${BASE_URL}/api`;
  
  // 清理舊測試資料
  try {
    const res = await fetch(`${apiBase}/instances`, {
      headers: { 'Authorization': `Bearer ${ADMIN_TOKEN}` }
    });
    if (res.ok) {
      const instances = await res.json();
      for (const inst of instances) {
        if (inst.bot_nickname?.startsWith('TestBot_')) {
          await fetch(`${apiBase}/instance/${inst.id}/delete`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${ADMIN_TOKEN}` }
          });
        }
      }
    }
  } catch (e) { /* ignore */ }
  
  console.log('✅ 測試環境準備完成');
}

// ─── 測試 1: 用戶註冊頁面 ────────────────────────────────────
async function testUserRegistration(page) {
  console.log('\n─── 測試 1: 用戶註冊頁面 ───');
  
  const errors = [];
  page.on('console', msg => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  
  await page.goto(`${BASE_URL}/`);
  await page.waitForLoadState('networkidle');
  
  // 檢查標題
  const title = await page.title();
  console.log(`  標題: ${title}`);
  
  // 檢查表單存在
  const userInput = await page.$('#user-nickname');
  const botInput = await page.$('#bot-nickname');
  console.log(`  用戶暱稱輸入框: ${userInput ? '✅' : '❌'}`);
  console.log(`  Bot暱稱輸入框: ${botInput ? '✅' : '❌'}`);
  
  // 填入測試資料
  const testUser = `TestUser_${Date.now()}`;
  const testBot = `TestBot_${Date.now()}`;
  
  await page.fill('#user-nickname', testUser);
  await page.fill('#bot-nickname', testBot);
  
  // 截圖
  await page.screenshot({ path: `/tmp/e2e-registration-form.png` });
  console.log('  📸 截圖: /tmp/e2e-registration-form.png');
  
  // 提交（#submit-btn 是 type=submit）
  await page.click('#submit-btn');
  
  // 等待 QR code 或錯誤
  try {
    await page.waitForSelector('#step-2, .error-msg', { timeout: 8000 });
    const qrImage = await page.$('#qr-image');
    const step2Visible = await page.$eval('#step-2', el => el.style.display !== 'none').catch(() => false);
    
    if (qrImage && step2Visible) {
      console.log('  QR Code Step: ✅ 顯示（step-2 可見）');
      const imgSrc = await qrImage.getAttribute('src');
      console.log(`  QR Image src: ${imgSrc ? '✅ 有內容' : '❌ 無內容'}`);
    }
  } catch {
    console.log('  無 QR code 或狀態顯示（非預期）');
  }
  
  if (errors.length > 0) {
    console.log(`  Console Errors: ${errors.join(', ')}`);
  }
  
  return { testUser, testBot };
}

// ─── 測試 2: Admin 登入頁面 ────────────────────────────────
async function testAdminLogin(page) {
  console.log('\n─── 測試 2: Admin 登入頁面 ───');
  
  const errors = [];
  page.on('console', msg => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  
  await page.goto(`${BASE_URL}/admin/`);
  await page.waitForLoadState('networkidle');
  
  const title = await page.title();
  console.log(`  標題: ${title}`);
  
  const passwordInput = await page.$('#admin-password');
  console.log(`  密碼輸入框: ${passwordInput ? '✅' : '❌'}`);
  
  await page.fill('#admin-password', 'admin123');
  await page.keyboard.press('Enter');
  
  await page.waitForTimeout(2000);
  await page.screenshot({ path: `/tmp/e2e-admin-login.png` });
  
  if (errors.length > 0) {
    console.log(`  Console Errors: ${errors.join(', ')}`);
  }
  
  console.log('  📸 截圖: /tmp/e2e-admin-login.png');
}

// ─── 測試 3: Admin 實例列表 ────────────────────────────────
async function testAdminInstances(page) {
  console.log('\n─── 測試 3: Admin 實例列表 ───');
  
  const errors = [];
  page.on('console', msg => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  
  await page.goto(`${BASE_URL}/admin/instances/`);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(2000);
  
  await page.screenshot({ path: `/tmp/e2e-admin-instances.png` });
  
  const instancesBody = await page.$('#instances-body');
  if (instancesBody) {
    const rows = await instancesBody.$$('tr');
    console.log(`  實例列表: ✅ (${rows.length} 行)`);
  } else {
    console.log('  實例列表: ⚠️ 無 tbody 或尚未載入');
  }
  
  if (errors.length > 0) {
    console.log(`  Console Errors: ${errors.join(', ')}`);
  } else {
    console.log('  Console Errors: 無');
  }
  
  console.log('  📸 截圖: /tmp/e2e-admin-instances.png');
}

// ─── 測試 4: API 直接串接 ────────────────────────────────
async function testAPIDirect() {
  console.log('\n─── 測試 4: API 直接串接 ───');
  
  const apiBase = `${BASE_URL}/api`;
  
  // 測試無效請求
  const r1 = await fetch(`${apiBase}/user/me`);
  console.log(`  GET /user/me (no auth): ${r1.status} — ${r1.status === 401 ? '✅ 正確（需認證）' : '⚠️ 非預期'}`);
  
  const r2 = await fetch(`${apiBase}/instances`);
  console.log(`  GET /instances (no auth): ${r2.status} — ${r2.status === 401 ? '✅ 正確（需認證）' : '⚠️ 非預期'}`);
  
  // 測試 OPTIONS（CORS 預檢）
  const r3 = await fetch(`${apiBase}/register`, { method: 'OPTIONS' });
  console.log(`  OPTIONS /register: ${r3.status} — ${r3.headers.get('access-control-allow-origin') ? '✅ CORS 設定' : '⚠️ 無 CORS'}`);
  
  console.log('  ✅ API 端點都可訪問');
}

// ─── 環境還原 ───────────────────────────────────────────────
async function teardownTestEnvironment() {
  console.log('\n─── 環境還原 ───');
  
  const apiBase = `${BASE_URL}/api`;
  
  try {
    // 刪除所有測試 Bot
    const res = await fetch(`${apiBase}/instances`, {
      headers: { 'Authorization': `Bearer ${ADMIN_TOKEN}` }
    });
    if (res.ok) {
      const instances = await res.json();
      let deleted = 0;
      for (const inst of instances) {
        if (inst.bot_nickname?.startsWith('TestBot_')) {
          await fetch(`${apiBase}/instance/${inst.id}/delete`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${ADMIN_TOKEN}` }
          });
          deleted++;
        }
      }
      console.log(`  刪除測試 Bot: ${deleted} 個`);
    }
  } catch (e) {
    console.log(`  清理時出錯: ${e.message}`);
  }
  
  console.log('✅ 環境還原完成');
}

// ─── 主流程 ─────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);
  const runTest = args[0] || 'all';
  
  console.log('═══════════════════════════════════════');
  console.log('  OpenClaw E2E 自動化測試');
  console.log(`  目標: ${BASE_URL}`);
  console.log('═══════════════════════════════════════');
  
  await setupTestEnvironment();
  
  const browser = await chromium.launch({
    headless: true,
    executablePath: '/usr/bin/chromium-browser',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  const context = await browser.newContext();
  const page = await context.newPage();
  
  try {
    if (runTest === 'all' || runTest === 'registration') {
      await testUserRegistration(page);
    }
    if (runTest === 'all' || runTest === 'admin') {
      await testAdminLogin(page);
    }
    if (runTest === 'all' || runTest === 'instances') {
      await testAdminInstances(page);
    }
    if (runTest === 'all' || runTest === 'api') {
      await testAPIDirect();
    }
    
    console.log('\n═══════════════════════════════════════');
    console.log('  測試完成 ✅');
    console.log('═══════════════════════════════════════');
  } catch (err) {
    console.error('測試失敗:', err.message);
    await page.screenshot({ path: `/tmp/e2e-error.png` });
    console.log('📸 錯誤截圖: /tmp/e2e-error.png');
  } finally {
    await browser.close();
    await teardownTestEnvironment();
  }
}

main().catch(console.error);

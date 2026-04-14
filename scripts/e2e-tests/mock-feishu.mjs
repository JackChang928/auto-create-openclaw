/**
 * mock-feishu.mjs — Mock Feishu OAuth Proxy
 * 
 * 攔截 server.js 對 accounts.feishu.cn 的 OAuth 請求
 * 使用方式：
 *   FEISHU_PROXY=http://localhost:3333 node server.js
 *   
 * 或直接讓 feishu-registration.js 使用測試模式：
 *   TEST_FEISHU=1 node server.js
 */

import http from 'http';
import https from 'https';
import { writeFileSync, mkdirSync } from 'fs';

const PORT = 3333;
const LOG_FILE = './data/feishu-mock-log.json';
const logs = [];

function log(type, data) {
  logs.push({ type, timestamp: Date.now(), data });
  const msg = `[${type}] ${JSON.stringify(data).substring(0, 120)}`;
  console.log(msg);
  try {
    mkdirSync('./data', { recursive: true });
    writeFileSync(LOG_FILE, JSON.stringify(logs, null, 2));
  } catch {}
}

const MOCK_APP_ID = 'cli_a1b2c3d4e5f6g7h8';
const MOCK_APP_SECRET = 'sec_x9y8z7w6v5u4t3s2';
const MOCK_OPEN_ID = 'ou_test_openid_123456';

function createMockResponse(res, statusCode, data) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(data));
}

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS' });
    res.end();
    return;
  }

  let body = '';
  req.on('data', c => body += c);
  req.on('end', () => {
    const url = `https://accounts.feishu.cn${req.url}`;
    log('→ incoming', { url, body: body.substring(0, 80) });

    // Parse action
    const params = new URLSearchParams(body);
    const action = params.get('action');
    const deviceCode = params.get('device_code') || '';

    // ── INIT ──
    if (action === 'init') {
      log('init', {});
      createMockResponse(res, 200, {
        supported_auth_methods: ['client_secret'],
        supported_archetypes: ['PersonalAgent']
      });
      return;
    }

    // ── BEGIN ──
    if (action === 'begin') {
      const mockDeviceCode = 'TEST_' + Math.random().toString(36).substring(2, 14);
      log('begin', { device_code: mockDeviceCode });
      createMockResponse(res, 200, {
        verification_uri_complete: `https://accounts.feishu.cn/device?code=${mockDeviceCode}`,
        device_code: mockDeviceCode,
        interval: 2,
        expire_in: 600
      });
      return;
    }

    // ── POLL ──
    if (action === 'poll') {
      // TEST_ 前綴 = 直接 mock 完成
      if (deviceCode.startsWith('TEST_')) {
        log('poll:MOCK_COMPLETE', { device_code: deviceCode });
        createMockResponse(res, 200, {
          client_id: MOCK_APP_ID,
          client_secret: MOCK_APP_SECRET,
          user_info: { open_id: MOCK_OPEN_ID, tenant_brand: 'lark' }
        });
        return;
      }

      // 真實 device_code = 轉發給真的 Feishu
      log('poll:REAL', { device_code: deviceCode.substring(0, 20) });
      const options = {
        hostname: 'accounts.feishu.cn',
        port: 443,
        path: '/oauth/v1/app/registration',
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
      };

      const req2 = https.request(options, (res2) => {
        let data2 = '';
        res2.on('data', c => data2 += c);
        res2.on('end', () => {
          try {
            const json = JSON.parse(data2);
            log('poll:REAL_RESPONSE', json);
            res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
            res.end(data2);
          } catch {
            res.writeHead(502);
            res.end('Bad response from Feishu');
          }
        });
      });
      req2.on('error', (e) => {
        log('poll:ERROR', e.message);
        res.writeHead(502);
        res.end('Proxy error: ' + e.message);
      });
      req2.write(body);
      req2.end();
      return;
    }

    res.writeHead(400);
    res.end('Unknown action: ' + action);
  });
});

server.listen(PORT, () => {
  console.log(`═══════════════════════════════════════`);
  console.log(`  Mock Feishu Proxy 啟動`);
  console.log(`  監聽: http://localhost:${PORT}`);
  console.log(`  環境變數:`);
  console.log(`    FEISHU_PROXY=http://localhost:${PORT}`);
  console.log(`    (或) TEST_FEISHU=1 (在 server.js 内部繞過)`);
  console.log(`═══════════════════════════════════════`);
});

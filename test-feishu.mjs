import sqlite3 from 'sqlite3';
import fetch from 'node-fetch'; // if needed, wait node 18+ has native fetch

const db = new sqlite3.Database('./data/openclaw_users.db');
db.get('SELECT feishu_app_id, feishu_app_secret FROM users WHERE feishu_app_id IS NOT NULL ORDER BY id DESC LIMIT 1', async (err, row) => {
  if (err || !row) return console.error('No bot found', err);
  console.log('Testing with AppID:', row.feishu_app_id);
  const tokenRes = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: row.feishu_app_id, app_secret: row.feishu_app_secret })
  });
  const tokenData = await tokenRes.json();
  const token = tokenData.tenant_access_token;
  console.log('Token:', token ? 'OK' : 'FAIL');
  
  if (token) {
    const menuRes = await fetch('https://open.feishu.cn/open-apis/application/v6/app/bot/menu', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({
        menu: {
          language: 'zh_cn',
          menu_items: [
            { name: '指令狀態 (/status)', type: 'event', event: { event_type: '/status' } },
            { name: '深度思考 (/think)', type: 'event', event: { event_type: '/think' } },
            { name: '切換模型 (/model)', type: 'event', event: { event_type: '/model' } },
            { name: '新對話 (/new)', type: 'event', event: { event_type: '/new' } }
          ]
        }
      })
    });
    console.log('Menu Config Response:', await menuRes.json());
  }
});

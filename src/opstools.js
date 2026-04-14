/**
 * src/opstools.js — OpenClaw 運維 CLI 工具集
 *
 * 提供給 AI Agent（Arrodes）使用的 ops 工具包，
 * 包裝 admin API，讓僕人能夠：
 *   1. 查看所有實例狀態
 *   2. 查看實例健康狀況（CPU/記憶體/磁碟）
 *   3. 查看/更新實例腳本（BOOTSTRAP, MEMORY, SOUL, USER, HEARTBEAT, IDENTITY 等）
 *   4. 重啟/停止/啟動實例容器
 *   5. 查看實例日誌
 *   6. 查看系統整體健康
 *
 * 用法：
 *   node src/opstools.js list
 *   node src/opstools.js status <agentId>
 *   node src/opstools.js scripts <agentId>
 *   node src/opstools.js update-script <agentId> <scriptName> <content>
 *   node src/opstools.js restart <agentId>
 *   node src/opstools.js logs <agentId> [--lines N]
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// 讀取環境變數
function loadEnv() {
  const envPath = join(__dirname, '..', '.env');
  try {
    const content = readFileSync(envPath, 'utf-8');
    const env = {};
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx < 0) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const value = trimmed.slice(eqIdx + 1).trim();
      env[key] = value;
    }
    return env;
  } catch {
    return {};
  }
}

const env = loadEnv();
const BASE_URL = process.env.OPENCLAW_API_URL || 'http://localhost:3210';
const AUTH_URL = process.env.AUTH_SERVICE_URL || 'http://localhost:3001';
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || env.ADMIN_PASSWORD || 'admin123';

let adminToken = null;

// 登入取得 Admin JWT
async function getAdminToken() {
  if (adminToken) return adminToken;
  const res = await fetch(`${AUTH_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: ADMIN_USER, password: ADMIN_PASS }),
  });
  const data = await res.json();
  if (!res.ok || !data.token) {
    throw new Error(`登入失敗：${JSON.stringify(data)}`);
  }
  adminToken = data.token;
  return adminToken;
}

// 封裝 admin API 請求
async function adminApi(path, options = {}) {
  const token = await getAdminToken();
  const res = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`API 錯誤 ${res.status} ${path}: ${JSON.stringify(data)}`);
  }
  return data;
}

// ─── Commands ────────────────────────────────────────────────────────────────

// 1. list — 列出所有實例
async function cmdList() {
  const instances = await adminApi('/api/instances');
  console.log(`\n📋 OpenClaw 實例列表（共 ${instances.length} 個）\n`);
  console.log('ID | Agent ID              | 暱稱    | 狀態     | 運行中 | 預算  | 端口');
  console.log('---|----------------------|---------|---------|--------|------|------');
  for (const inst of instances) {
    console.log(
      `${String(inst.id).padEnd(3)} | ${inst.agent_id.padEnd(21)} | ${(inst.user_nickname || '').padEnd(7)} | ${inst.status.padEnd(8)} | ${inst.isRunning ? '✅' : '❌'}     | $${inst.budget || 0}    | ${inst.port || '-'}`
    );
  }
  console.log();
}

// 2. status — 查看實例健康狀態
async function cmdStatus(agentId) {
  if (!agentId) throw new Error('缺少 agentId');
  const data = await adminApi(`/api/health/agent/${encodeURIComponent(agentId)}`);
  console.log(`\n🔍 實例狀態：${agentId}\n`);
  console.log(`  容器運行：${data.containerRunning ? '✅' : '❌'}`);
  console.log(`  Gateway 進程：${data.gatewayProcessPresent ? '✅' : '❌'}`);
  console.log(`  Gateway 回應：${data.gatewayResponding ? '✅' : '❌'}`);
  console.log(`  存活：${data.alive ? '✅' : '❌'}`);
  if (data.error) console.log(`  錯誤：${data.error}`);
  console.log(`  時間：${data.timestamp}`);
  console.log();
}

// 3. system — 查看系統整體健康
async function cmdSystem() {
  const [health, litellm, instances] = await Promise.all([
    adminApi('/api/health').catch(e => ({ error: e.message, statusCode: 0, models: [] })),
    adminApi('/api/health/litellm').catch(e => ({ error: e.message, statusCode: 0 })),
    adminApi('/api/instances').catch(() => []),
  ]);
  // Langfuse 健康檢查
  let langfuseStatus = '⚠️ 未部署';
  try {
    const lfRes = await fetch('http://localhost:3002/api/public/health', { method: 'GET' });
    if (lfRes.ok) {
      const lfData = await lfRes.json();
      langfuseStatus = `✅ v${lfData.version || '?'}`;
    } else if (lfRes.status === 404) {
      langfuseStatus = '⚠️ 端點未找到';
    } else {
      langfuseStatus = `❌ HTTP ${lfRes.status}`;
    }
  } catch { langfuseStatus = '⚠️ 無法連接'; }

  const running = instances.filter(i => i.isRunning).length;
  console.log(`\n🏥 OpenClaw 系統健康\n`);
  console.log(`  API 伺服器：✅ (${BASE_URL})`);
  const litellmStatus = litellm.statusCode === 401 ? '⚠️ 需認證' : litellm.healthy ? '✅ 健康' : `❌ 異常(${litellm.statusCode})`;
  console.log(`  LiteLLM：${litellmStatus}`);
  if (litellm.error) console.log(`    錯誤：${litellm.error}`);
  console.log(`  Langfuse：${langfuseStatus}`);
  console.log(`  可用模型：${(health.models || []).join(', ') || '無法取得'}`);
  console.log(`  實例：${running} 運行中 / ${instances.length} 總計`);
  console.log(`  時間：${health.timestamp || new Date().toISOString()}`);
  console.log();
}

// 4. budget — 用戶預算與 LiteLLM 花費查詢
async function cmdBudget(agentId) {
  const instances = await adminApi('/api/instances');
  if (agentId) {
    const instance = instances.find(i => i.agent_id === agentId);
    if (!instance) { console.error(`❌ 找不到實例：${agentId}`); process.exit(1); }
    const userId = instance.id;
    try {
      const spend = await adminApi(`/api/spend?user_id=${userId}`);
      console.log(`\n💰 ${instance.user_nickname || agentId} 預算報告`);
      console.log(`   預算上限：$${instance.budget ?? 0}`);
      console.log(`   累計花費：$${(spend.totalSpend ?? 0).toFixed(4)}`);
      if (spend.error) console.log(`   查詢狀態：⚠️ ${spend.error}`); else console.log(`   查詢狀態：✅ 正常`);
    } catch (e) {
      console.log(`\n💰 ${instance.user_nickname || agentId}`);
      console.log(`   預算上限：$${instance.budget ?? 0}`);
      console.log(`   ⚠️ 花費查詢失敗：${e.message}`);
    }
  } else {
    console.log(`\n💰 所有實例預算與花費（共 ${instances.length} 個）\n`);
    console.log('Agent ID              | 暱稱    | 預算   | 花費       | 狀態');
    console.log('---|---------|-------|----------|------');
    for (const inst of instances) {
      const userId = inst.id;
      let spendStr = '—', status = '✅';
      try {
        const r = await adminApi(`/api/spend?user_id=${userId}`);
        spendStr = `$${(r.totalSpend ?? 0).toFixed(4)}`;
        if (r.error) status = `⚠️ ${r.error.slice(0, 15)}`;
      } catch { spendStr = '⚠️ N/A'; status = '❌'; }
      const budgetStr = `$${inst.budget ?? 0}`;
      console.log(`${inst.agent_id} | ${(inst.user_nickname || '?').padEnd(7)} | ${budgetStr.padEnd(5)} | ${spendStr.padEnd(9)} | ${status}`);
    }
  }
}

// 5. litellm — 詳細 LiteLLM 狀態（模型可用性 + OTEL 追蹤配置）
async function cmdLitellm() {
  const LITELLM_KEY = process.env.LITELLM_MASTER_KEY || 'sk-1234';
  const LITELLM_URL = 'http://localhost:4000';

  console.log(`\n🔧 LiteLLM Proxy 詳細狀態\n`);

  // 1. 健康檢查
  let healthOk = false;
  try {
    const res = await fetch(`${LITELLM_URL}/health`, {
      headers: { 'Authorization': `Bearer ${LITELLM_KEY}` },
    });
    if (res.ok) {
      const data = await res.json();
      const healthy = (data.healthy_endpoints || []).length;
      const unhealthy = (data.unhealthy_endpoints || []).length;
      healthOk = healthy > 0;
      console.log(`  健康狀態：${healthy > 0 ? '✅ ' + healthy + ' 个端点正常' : '⚠️ 无健康端点'}`);
      if (unhealthy > 0) {
        console.log(`  异常端点：⚠️ ${unhealthy} 个（API Key 错误或服务商不可达）`);
        // 顯示第一個異常的錯誤摘要
        const firstErr = data.unhealthy_endpoints[0];
        if (firstErr?.metadata?.error_information?.error_message) {
          const msg = firstErr.metadata.error_information.error_message;
          // 脫敏關鍵資訊
          const masked = msg.replace(/sk-[a-zA-Z0-9]{20,}/g, 'sk-***').replace(/os\.ENV\/OPENAI_API_KEY/gi, 'OPENAI_API_KEY');
          console.log(`  最新錯誤：${masked.slice(0, 120)}`);
        }
      }
    } else {
      console.log(`  健康狀態：❌ HTTP ${res.status}`);
    }
  } catch (e) {
    console.log(`  健康狀態：❌ 無法連接（${e.message}）`);
  }

  // 2. 模型清單
  try {
    const res = await fetch(`${LITELLM_URL}/model/info`, {
      headers: { 'Authorization': `Bearer ${LITELLM_KEY}` },
    });
    if (res.ok) {
      const data = await res.json();
      const models = data.data || [];
      console.log(`\n  可用模型（${models.length} 個）：`);
      for (const m of models) {
        const name = m.model_name;
        const info = m.model_info || {};
        const inputCost = info.input_cost_per_token != null ? `$${info.input_cost_per_token}/tok` : '?';
        console.log(`    - ${name} (max ${info.max_input_tokens?.toLocaleString() || '?'} tok, ${inputCost})`);
      }
    }
  } catch (e) {
    console.log(`  模型清單：❌ ${e.message}`);
  }

  // 3. OTEL 追蹤配置狀態
  try {
    const lfRes = await fetch('http://localhost:3002/api/public/health', { method: 'GET' });
    if (lfRes.ok) {
      const lfData = await lfRes.json();
      console.log(`\n  Langfuse OTEL：✅ 可達（v${lfData.version || '?'}）`);
      console.log(`  OTEL 端點：http://langfuse:3000/api/public/otel`);
    } else {
      console.log(`\n  Langfuse OTEL：⚠️ HTTP ${lfRes.status}`);
    }
  } catch (e) {
    console.log(`\n  Langfuse OTEL：❌ 無法連接（${e.message}）`);
  }

  // 4. 環境變數關鍵配置（docker exec litellm env 提取）
  console.log(`\n  環境配置狀態：`);
  try {
    const { stdout } = await new Promise((resolve) => {
      const { execSync } = require('child_process');
      try {
        const out = execSync("docker exec litellm-proxy env | grep -E 'OTEL|LITELLM_MASTER|DATABASE_URL' 2>/dev/null", { encoding: 'utf-8' });
        resolve({ stdout: out });
      } catch {
        resolve({ stdout: '' });
      }
    });
    if (stdout) {
      for (const line of stdout.trim().split('\n')) {
        const [key, ...vals] = line.split('=');
        if (!key || !vals.length) continue;
        if (key === 'OTEL_EXPORTER_OTLP_HEADERS') {
          console.log(`    ${key}=[BASIC_AUTH_CONFIGURED]`);
        } else {
          const val = vals.join('=');
          const masked = val.includes('sk-') || val.includes('pk-')
            ? val.slice(0, 6) + '***' + val.slice(-4)
            : val;
          console.log(`    ${key}=${masked}`);
        }
      }
    } else {
      console.log(`    (無法讀取，請手動執行：docker exec litellm-proxy env)`);
    }
  } catch {
    console.log(`    (無法讀取容器環境變數)`);
  }

  // 5. 最新花費日誌（驗證追蹤是否流動）
  try {
    const res = await fetch(`${LITELLM_URL}/spend/logs?limit=3`, {
      headers: { 'Authorization': `Bearer ${LITELLM_KEY}` },
    });
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data) && data.length > 0) {
        const latest = data[0];
        const status = latest.metadata?.status || '?';
        const model = latest.model || latest.model_group || '?';
        const err = latest.metadata?.error_information?.error_class || '';
        console.log(`\n  最近請求：`);
        console.log(`    模型：${model}`);
        console.log(`    狀態：${status === 'success' ? '✅ 成功' : '❌ ' + status + (err ? ' (' + err + ')' : '')}`);
        console.log(`    花費：$${(latest.spend || 0).toFixed(6)}`);
        if (err) {
          const msg = (latest.metadata.error_information.error_message || '').replace(/sk-[a-zA-Z0-9]{20,}/g, 'sk-***');
          console.log(`    錯誤：${msg.slice(0, 100)}`);
        }
      } else {
        console.log(`\n  最近請求：無`);
      }
    }
  } catch (e) {
    console.log(`  最近請求：❌ ${e.message}`);
  }

  console.log();
  if (!healthOk) {
    console.log(`  ⚠️  注意：LiteLLM 所有端點均異常（通常是 API Key 無效或網路不可達）`);
    console.log(`  檢查：.env 中 OPENAI_API_KEY / MINIMAX_API_KEY 是否正確`);
    console.log();
  }
}

// 6. user-add — 新增用戶
async function cmdUserAdd(userNickname, botNickname) {
  if (!userNickname || !botNickname) {
    console.error('❌ 需要：node opstools.js user-add <用戶暱稱> <Bot暱稱>');
    process.exit(1);
  }
  try {
    const data = await adminApi('/api/register', {
      method: 'POST',
      body: JSON.stringify({ userNickname, botNickname }),
    });
    if (data.error) { console.error(`❌ 註冊失敗：${data.error}`); process.exit(1); }
    console.log(`\n✅ 用戶創建成功！`);
    console.log(`   暱稱：${data.userNickname}`);
    console.log(`   Bot：${data.botNickname}`);
    console.log(`   Agent ID：${data.agentId}`);
    console.log(`   驗證網址：${data.verificationUri || data.verification_url || 'N/A'}`);
    console.log(`\n📝 請將驗證網址發送給用戶完成飛書授權。`);
  } catch (e) {
    console.error(`❌ 錯誤：${e.message}`);
    process.exit(1);
  }
}

// 4. scripts — 查看實例的腳本檔案列表
async function cmdScripts(agentId) {
  if (!agentId) throw new Error('缺少 agentId');
  const userRes = await fetch(`${BASE_URL}/api/instances`);
  const userData = await userRes.json();
  const user = userData.find(u => u.agent_id === agentId);
  if (!user) throw new Error(`找不到實例：${agentId}`);
  if (!user.port) throw new Error(`實例 ${agentId} 未運行（無端口）`);

  // 嘗試從 gateway 取得 workspace 檔案列表
  // Gateway token 在 instance 的 hidden 欄位，這裡用 Docker exec 代替
  console.log(`\n📁 實例腳本：${agentId}\n`);
  console.log('  提示：使用 update-script <agentId> <scriptName> <content> 更新腳本');
  console.log('  可用腳本：BOOTSTRAP.md, MEMORY.md, SOUL.md, USER.md, HEARTBEAT.md, IDENTITY.md, AGENTS.md, TOOLS.md');
  console.log();
}

// 5. update-script — 更新實例腳本
async function cmdUpdateScript(agentId, scriptName, content) {
  if (!agentId || !scriptName) {
    throw new Error('用法：update-script <agentId> <scriptName> <content>');
  }
  // 找實例資料庫 ID
  const instances = await adminApi('/api/instances');
  const user = instances.find(u => u.agent_id === agentId);
  if (!user) throw new Error(`找不到實例：${agentId}`);

  const result = await adminApi(`/api/instance/${user.id}/script`, {
    method: 'PATCH',
    body: JSON.stringify({ scriptName, content }),
  });
  if (!result.success) throw new Error(result.error || '更新失敗');
  console.log(`✅ 腳本 ${scriptName} 已更新到 ${agentId}`);
}

// 6. read-script — 讀取實例腳本內容
async function cmdReadScript(agentId, scriptName) {
  if (!agentId || !scriptName) {
    throw new Error('用法：read-script <agentId> <scriptName>');
  }
  const instances = await adminApi('/api/instances');
  const user = instances.find(u => u.agent_id === agentId);
  if (!user) throw new Error(`找不到實例：${agentId}`);

  const result = await adminApi(`/api/instance/${user.id}/script/${encodeURIComponent(scriptName)}`);
  console.log(`\n📄 ${agentId} / ${scriptName} (${result.size} bytes)\n`);
  console.log(result.content);
  console.log();
}

// 7. container-stats — 查看實例容器資源用量
async function cmdContainerStats(agentId) {
  if (!agentId) throw new Error('缺少 agentId');
  const instances = await adminApi('/api/instances');
  const user = instances.find(u => u.agent_id === agentId);
  if (!user) throw new Error(`找不到實例：${agentId}`);

  const stats = await adminApi(`/api/instance/${user.id}/container-stats`);
  console.log(`\n📊 ${agentId} 容器資源用量\n`);
  console.log(`  CPU：${stats.cpu}`);
  console.log(`  記憶體：${stats.memory.usage} (${stats.memory.percent})`);
  console.log(`  磁碟（workspace）：${stats.disk.workspace}`);
  console.log();
}

// 6. restart — 重啟實例 Gateway
async function cmdRestart(agentId) {
  if (!agentId) throw new Error('缺少 agentId');
  const instances = await adminApi('/api/instances');
  const user = instances.find(u => u.agent_id === agentId);
  if (!user) throw new Error(`找不到實例：${agentId}`);
  const id = user.id;

  // 找實例真實 ID
  const dashboard = await adminApi('/api/instances');
  const instance = dashboard.find(u => u.agent_id === agentId);
  if (!instance) throw new Error(`找不到實例：${agentId}`);

  await adminApi(`/api/instance/${instance.id}/stop`, { method: 'POST' });
  await new Promise(r => setTimeout(r, 1000));
  await adminApi(`/api/instance/${instance.id}/start`, { method: 'POST' });
  console.log(`✅ 實例 ${agentId} 已重啟`);
}

// 7. logs — 查看實例日誌
async function cmdLogs(agentId, lines = 50) {
  if (!agentId) throw new Error('缺少 agentId');
  const instances = await adminApi('/api/instances');
  const instance = instances.find(u => u.agent_id === agentId);
  if (!instance) throw new Error(`找不到實例：${agentId}`);

  const logs = await adminApi(`/api/admin/dashboard/instances/${instance.id}/logs?lines=${lines}`);
  console.log(`\n📜 ${agentId} 日誌（最近 ${lines} 行）\n`);
  console.log(logs.logs || logs.error || '（無日誌）');
  console.log();
}

// 8. activate — 激活新實例（admin 功能）
async function cmdActivate(agentId) {
  if (!agentId) throw new Error('缺少 agentId');
  const instances = await adminApi('/api/instances');
  const instance = instances.find(u => u.agent_id === agentId);
  if (!instance) throw new Error(`找不到實例：${agentId}`);
  const result = await adminApi(`/api/instance/${instance.id}/activate`, { method: 'POST' });
  console.log(`✅ 實例 ${agentId} 激活成功`);
  console.log(JSON.stringify(result, null, 2));
}

// 9. events — 查看實例事件
async function cmdEvents(agentId, lines = 20) {
  if (!agentId) throw new Error('缺少 agentId');
  const instances = await adminApi('/api/instances');
  const instance = instances.find(u => u.agent_id === agentId);
  if (!instance) throw new Error(`找不到實例：${agentId}`);
  const events = await adminApi(`/api/admin/dashboard/instances/${instance.id}/events?limit=${lines}`);
  console.log(`\n📋 ${agentId} 事件（最近 ${lines} 筆）\n`);
  for (const ev of (events.events || [])) {
    const ts = new Date(ev.createdAt).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });
    console.log(`[${ts}] [${ev.severity}] ${ev.title}`);
    if (ev.detail) console.log(`  ${ev.detail}`);
  }
  console.log();
}

// 10. orphans — 列出未在平台註冊的 orphan Docker 容器
async function cmdOrphans() {
  // 取得平台所有實例的 container_name
  const instances = await adminApi('/api/instances');
  const managedContainers = new Set(instances.map(u => u.container_name).filter(Boolean));

  // 取得所有 auto-openclaw-* 容器
  const { execSync } = require('child_process');
  let dockerContainers = [];
  try {
    const out = execSync('docker ps -a --format "{{.Names}}"', { encoding: 'utf-8' });
    dockerContainers = out.trim().split('\n').filter(Boolean);
  } catch {
    console.log('⚠️ 無法取得 Docker 容器列表');
    return;
  }

  const orphans = dockerContainers.filter(name => {
    // 只看 auto-openclaw-user-*  pattern
    if (!name.startsWith('auto-openclaw-user-')) return false;
    // 排除平台有記錄的
    if (managedContainers.has(name)) return false;
    return true;
  });

  if (orphans.length === 0) {
    console.log('✅ 沒有發現 orphan 容器');
    return;
  }

  console.log(`⚠️  發現 ${orphans.length} 個 orphan 容器（存在於 Docker 但未在平台註冊）：\n`);
  for (const name of orphans) {
    const info = execSync(`docker inspect ${name} --format "{{.State.Status}} | {{.State.Health}}" 2>/dev/null`, { encoding: 'utf-8' }).trim();
    console.log(`  🗑️  ${name}  (${info || '狀態未知'})`);
  }
  console.log('\n可用指令清理：');
  console.log('  docker rm -f <container_name>   # 強制刪除容器');
  console.log('  node src/opstools.js delete <agentId>  # 刪除平台已註冊的實例');
}

// 11. delete — 刪除實例（停止容器、移除容器、清除資料、目錄、釋放連接埠）
async function cmdDelete(agentId) {
  if (!agentId) throw new Error('缺少 agentId（格式如 user-jack-2223f9）');
  const instances = await adminApi('/api/instances');
  const instance = instances.find(u => u.agent_id === agentId);
  if (!instance) throw new Error(`找不到實例：${agentId}（可用 node opstools.js list 確認）`);

  console.log(`⚠️  即将删除實例：${agentId}`);
  console.log(`   容器：${instance.container_name}`);
  console.log(`   端口：${instance.port}`);
  console.log('');

  const result = await adminApi(`/api/instance/${instance.id}/delete`, { method: 'POST' });
  console.log(`✅ 實例 ${agentId} 已刪除`);
  if (result.success) {
    console.log(`   容器已移除：${result.containerName}`);
  }
}

// ─── CLI Entry Point ────────────────────────────────────────────────────────

const [cmd, arg1, arg2, arg3] = process.argv.slice(2);

async function main() {
  try {
    switch (cmd) {
      case 'list':
        await cmdList();
        break;
      case 'status':
        await cmdStatus(arg1);
        break;
      case 'system':
        await cmdSystem();
        break;
      case 'budget':
        await cmdBudget(arg1);
        break;
      case 'litellm':
        await cmdLitellm();
        break;
      case 'user-add':
        await cmdUserAdd(arg1, arg2);
        break;
      case 'scripts':
        await cmdScripts(arg1);
        break;
      case 'update-script':
        await cmdUpdateScript(arg1, arg2, arg3 || '');
        break;
      case 'read-script':
        await cmdReadScript(arg1, arg2);
        break;
      case 'container-stats':
        await cmdContainerStats(arg1);
        break;
      case 'restart':
        await cmdRestart(arg1);
        break;
      case 'logs':
        await cmdLogs(arg1, parseInt(arg2) || 50);
        break;
      case 'activate':
        await cmdActivate(arg1);
        break;
      case 'events':
        await cmdEvents(arg1, parseInt(arg2) || 20);
        break;
      case 'orphans':
        await cmdOrphans();
        break;
      case 'delete':
        await cmdDelete(arg1);
        break;
      case 'help':
        printHelp();
        break;
      default:
        if (!cmd) {
          await cmdSystem();
          await cmdList();
        } else {
          console.error(`未知命令：${cmd}`);
          printHelp();
          process.exit(1);
        }
    }
  } catch (err) {
    console.error(`\n❌ 錯誤：${err.message}\n`);
    process.exit(1);
  }
}

function printHelp() {
  console.log(`
🏗️  OpenClaw Ops CLI — 運維工具（給 AI Agent 使用）

用法：
  node src/opstools.js <command> [args]

命令：
  list                        列出所有實例
  system                      系統整體健康狀態
  status <agentId>            實例健康狀態（Gateway 是否正常）
  container-stats <agentId>   實例容器 CPU/記憶體/磁碟用量
  budget [agentId]            查看用戶 LiteLLM 花費（可指定或全部）
  litellm                      詳細 LiteLLM 狀態（模型可用性 + OTEL 追蹤配置）
  user-add <nickname> <bot>   新增用戶並獲取飛書驗證連結
  scripts <agentId>           查看可用腳本列表
  read-script <agentId> <scriptName>
                             讀取實例腳本內容
  update-script <agentId> <scriptName> <content>
                             更新實例腳本（完整覆寫）
  restart <agentId>            重啟實例 Gateway
  logs <agentId> [lines]       查看實例日誌（默認50行）
  activate <agentId>          激活實例（建立並啟動容器）
  delete <agentId>            刪除實例（停止+移除容器+清除資料）
  orphans                     列出orphan容器（Docker有但平台無記錄）
  events <agentId> [lines]     查看實例事件（默認20筆）
  help                        顯示本說明

可用腳本名稱：
  BOOTSTRAP.md  MEMORY.md  SOUL.md  USER.md
  HEARTBEAT.md  IDENTITY.md  AGENTS.md  TOOLS.md

範例：
  node src/opstools.js list
  node src/opstools.js status user-jack-2223f9
  node src/opstools.js container-stats user-jack-2223f9
  node src/opstools.js budget user-jack-2223f9
  node src/opstools.js budget
  node src/opstools.js litellm
  node src/opstools.js user-add alice alice-bot
  node src/opstools.js read-script user-jack-2223f9 BOOTSTRAP.md
  node src/opstools.js logs user-jack-2223f9 100

環境變數：
  OPENCLAW_API_URL  API 基礎 URL（默認 http://localhost:3210）
  ADMIN_USER        管理員帳號（默認 admin）
  ADMIN_PASS        管理員密碼（默認讀取 .env 的 ADMIN_PASSWORD）
`);
}

main();

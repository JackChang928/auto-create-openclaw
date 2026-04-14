/**
 * provisioner.js — Dockerized OpenClaw instance lifecycle management (v5).
 * @version 5
 *
 * MVP goal:
 * - one container per user instance
 * - platform-side Feishu onboarding (QR / verification URL)
 * - container-side official silent install via @larksuite/openclaw-lark
 * - Docker-aware gateway start/stop/delete lifecycle
 */
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import { writeFileSync, readFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { updateStatus, updateProvisionInfo, releasePort } from './db.js';

const REPO_ROOT = fileURLToPath(new URL('.', import.meta.url));
const INSTANCES_BASE = join(REPO_ROOT, 'data', 'instances');
const INTERNAL_GATEWAY_PORT = 18789;
const DEFAULT_IMAGE = process.env.OPENCLAW_DOCKER_IMAGE || 'auto-create-openclaw-base:latest';
const CONTAINER_PREFIX = process.env.OPENCLAW_CONTAINER_PREFIX || 'auto-openclaw';
const DEFAULT_TIMEZONE = process.env.OPENCLAW_DEFAULT_TZ || 'Asia/Taipei';
const DAILY_MEMORY_JOB_NAME = 'Daily memory maintenance';
const DAILY_MEMORY_CRON = '0 2 * * *';
// Host-side auto-create service runs outside Docker, so the safe default must be localhost.
// Keep LITELLM_PROXY_URL overrideable, but fall back to LITELLM_BASE_URL for legacy envs.
const LITELLM_PROXY_URL = process.env.LITELLM_PROXY_URL || process.env.LITELLM_BASE_URL || 'http://localhost:4000';
const SHARED_NETWORK = 'openclaw_shared_net';
const DEFAULT_DOCKER_TIMEOUT_MS = 120_000; // 2 min for docker pull / run
const DAILY_MEMORY_MESSAGE = `Run the daily memory maintenance routine.

1. Read MEMORY.md.
2. Read today's memory/YYYY-MM-DD.md and yesterday's file if it exists.
3. Distill durable rules, preferences, and decisions into MEMORY.md.
4. Keep markdown files as canonical memory. Do not store secrets or credentials.
5. If nothing needs promotion, append a short maintenance note to today's daily log.
6. Prefer concise, audit-friendly updates over long prose.`;

function run(command, args, options = {}) {
  const { timeout = 0, ...rest } = options;
  const execOptions = {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...rest,
  };
  if (timeout > 0) execOptions.timeout = timeout;
  try {
    return execFileSync(command, args, execOptions).trim();
  } catch (error) {
    const stderr = error.stderr?.toString?.() || '';
    const stdout = error.stdout?.toString?.() || '';
    const timed = error.message?.includes('ENOTTY') || error.message?.includes('ETIMEDOUT') || error.message?.includes('ETIMEDOUT') ? ' (timed out)' : '';
    throw new Error(`${command} ${args.join(' ')} failed${timed}: ${stderr || stdout || error.message}`.trim());
  }
}

function tryRun(command, args, options = {}) {
  try {
    return run(command, args, options);
  } catch {
    return null;
  }
}

function unique(values = []) {
  return [...new Set(values.filter(Boolean))];
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function sanitizeContainerName(agentId) {
  return `${CONTAINER_PREFIX}-${agentId}`
    .toLowerCase()
    .replace(/[^a-z0-9_.-]/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 63);
}

function identityMarkdown({ botNickname, userNickname }) {
  return `# ${botNickname}

你是 **${botNickname}**，一位智慧 AI 助手。

## 用戶資訊
- **用戶暱稱**: ${userNickname}
- 請稱呼用戶為「${userNickname}」

## 行為準則
- 友善、專業、有幫助
- 使用用戶偏好的語言回覆
- 善用飛書工具協助用戶完成各種任務
- 做資料整理、表格、文件產出時，**優先用 Python 處理**，需要套件時優先使用 **uv** 工作流
- 若需求有歧義（格式、目標位置、欄位、輸出型態），**先主動釐清再執行**
- 一旦承諾「開始處理 / 會幫你做」，就必須真的執行；若失敗、卡住或缺資料，**要主動回報目前進度、阻塞點與下一步需要什麼**
- 不要只回「我在處理」或「快好了」卻沒有實際產出
`;
}

function userMarkdown({ userNickname, botNickname }) {
  return `# USER.md - About Your Human

- **Name:** ${userNickname}
- **What to call them:** ${userNickname}
- **Timezone:** Asia/Taipei
- **Notes:**
  - This workspace was provisioned for ${botNickname}.
  - Update this file over time as durable, user-approved preferences become clear.
`;
}

function bootstrapMarkdown() {
  return `# BOOTSTRAP.md

This workspace is product-seeded for the Dockerized OpenClaw deployment.

## Important
- Keep the OpenClaw-generated scaffold files unless explicitly asked to replace them.
- **Do not overwrite AGENTS.md** with custom product text; treat it as canonical scaffold guidance.
- HEARTBEAT is disabled by config for this product. Background maintenance should use cron jobs instead.
- Daily memory maintenance is expected to run via cron with **openai/gpt-5.4**.
- MEMORY.md + memory/YYYY-MM-DD.md are the canonical markdown memory layer.
- Do not store API keys, bot secrets, or credentials in workspace memory files.

## Product Execution Rules
- For document generation, spreadsheets, exports, parsing, and data cleaning: **default to Python-first execution**.
- For Python package workflows: prefer **uv** over ad-hoc pip usage when possible.
- If the user intent is ambiguous, **clarify the target format / destination / fields before executing**.
- If you say you will execute something, you must either: 1) deliver the result, or 2) proactively report the exact blocker / failure and the next step needed.
- Do not stall with vague progress messages such as “processing” or “almost done” without real execution progress.

After first-run orientation, this file may be deleted.
`;
}

function memoryMarkdown() {
  return `# MEMORY.md

> Canonical long-term memory for this deployed agent.

## Memory Rules
- Use \`memory/YYYY-MM-DD.md\` for daily logs.
- Use this file only for durable rules, preferences, decisions, and reusable context.
- Prefer markdown files as the source of truth over transient recall.
- Never store secrets, tokens, raw API keys, or credentials here.

## Daily Maintenance Policy
- Heartbeat is disabled by default.
- Daily memory maintenance should be scheduled via cron, not heartbeat.
- Daily memory maintenance should use **openai/gpt-5.4** for quality and consistency.
- Gemini is not the default production path for memory optimization in this deployment.

## Product Working Rules
- Data processing and file generation should default to **Python-first execution**.
- Python package workflows should prefer **uv**.
- Ambiguous requests should be clarified before execution.
- Execution promises require follow-through: either deliver, or proactively report the blocker/failure and what is needed next.
`;
}

function heartbeatMarkdown() {
  return `# HEARTBEAT.md

# Heartbeat is intentionally disabled for this product by default.
# Use cron for daily memory maintenance and other exact scheduled tasks.
`;
}

function toolsMarkdown() {
  return `# TOOLS.md

## Product Notes
- OpenClaw bundled skill \`openai-image-gen\` is expected to be available when \`OPENAI_API_KEY\` is configured.
- Daily memory maintenance is configured via cron and should use \`openai/gpt-5.4\`.
- For spreadsheets, exports, OCR post-processing, and structured data work, prefer **Python** tools over pure model-only generation.
- For Python package management and disposable package execution, prefer **uv** workflows.
- Keep environment-specific notes here (hosts, paths, deployment caveats).
`;
}

function memoryReadmeMarkdown() {
  return `# memory/

Use this directory for daily memory logs and topic notes.

## Conventions
- Daily file: \`memory/YYYY-MM-DD.md\`
- Long-term curated memory: workspace root \`MEMORY.md\`
- Do not store secrets in these files.
`;
}

function writeIfMissing(filePath, content) {
  if (!existsSync(filePath)) {
    writeFileSync(filePath, content, 'utf-8');
  }
}

function seedWorkspaceDefaults({ workspaceDir, userNickname, botNickname }) {
  const memoryDir = join(workspaceDir, 'memory');
  mkdirSync(memoryDir, { recursive: true });

  writeIfMissing(join(workspaceDir, 'BOOTSTRAP.md'), bootstrapMarkdown());
  writeIfMissing(join(workspaceDir, 'MEMORY.md'), memoryMarkdown());
  writeIfMissing(join(workspaceDir, 'HEARTBEAT.md'), heartbeatMarkdown());
  writeIfMissing(join(workspaceDir, 'TOOLS.md'), toolsMarkdown());
  writeIfMissing(join(workspaceDir, 'USER.md'), userMarkdown({ userNickname, botNickname }));
  writeIfMissing(join(memoryDir, 'README.md'), memoryReadmeMarkdown());
}

export function ensureInstanceDirs(agentId) {
  const instanceDir = join(INSTANCES_BASE, agentId);
  const openclawHome = join(instanceDir, 'openclaw-home');
  const workspaceDir = join(openclawHome, 'workspace');
  const logsDir = join(instanceDir, 'logs');
  mkdirSync(workspaceDir, { recursive: true });
  mkdirSync(logsDir, { recursive: true });
  return { instanceDir, openclawHome, workspaceDir, logsDir };
}

export function removeInstanceDir(agentId) {
  const instanceDir = join(INSTANCES_BASE, agentId);
  if (existsSync(instanceDir)) {
    rmSync(instanceDir, { recursive: true, force: true });
  }
}

function configPath(openclawHome) {
  return join(openclawHome, 'openclaw.json');
}

function readConfig(openclawHome) {
  const path = configPath(openclawHome);
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, 'utf-8'));
}

function writeConfig(openclawHome, config) {
  writeFileSync(configPath(openclawHome), JSON.stringify(config, null, 2), 'utf-8');
}

function patchOpenClawDefaultsForDocker(openclawHome, authMode = 'openai-api-key') {
  const config = readConfig(openclawHome);

  if (!config.gateway) config.gateway = {};
  config.gateway.mode = config.gateway.mode || 'local';
  config.gateway.bind = 'lan';
  config.gateway.port = INTERNAL_GATEWAY_PORT;

  if (!config.agents) config.agents = {};
  if (!config.agents.defaults) config.agents.defaults = {};

  config.agents.defaults.heartbeat = {
    ...(config.agents.defaults.heartbeat || {}),
    every: '0m',
  };

  const primaryModel = authMode === 'codex-cli' ? 'openai-codex/gpt-5.4' : 'openai/gpt-5.4';
  config.agents.defaults.model = {
    ...(typeof config.agents.defaults.model === 'object' && config.agents.defaults.model ? config.agents.defaults.model : {}),
    primary: primaryModel,
  };

  config.agents.defaults.models = {
    ...(config.agents.defaults.models || {}),
    'openai/gpt-4.1-mini': {
      ...(config.agents.defaults.models?.['openai/gpt-4.1-mini'] || {}),
      alias: 'Mini',
    },
    'openai/gpt-5.4': {
      ...(config.agents.defaults.models?.['openai/gpt-5.4'] || {}),
      alias: 'GPT 5.4',
    },
    'openai-codex/gpt-5.4': {
      ...(config.agents.defaults.models?.['openai-codex/gpt-5.4'] || {}),
      alias: 'Codex GPT 5.4',
    },
    'minimax-cn/MiniMax-M2.7': {
      ...(config.agents.defaults.models?.['minimax-cn/MiniMax-M2.7'] || {}),
      alias: 'MiniMax M2.7',
    },
  };

  if (!config.tools || typeof config.tools !== 'object') config.tools = {};
  config.tools.profile = 'full';
  delete config.tools.allow;
  delete config.tools.deny;

  if (process.env.GEMINI_API_KEY) {
    if (!config.tools.web || typeof config.tools.web !== 'object') config.tools.web = {};
    if (!config.tools.web.search || typeof config.tools.web.search !== 'object') config.tools.web.search = {};
    config.tools.web.search.provider = 'gemini';
    config.tools.web.search.enabled = true;
    if (!config.tools.web.search.gemini || typeof config.tools.web.search.gemini !== 'object') {
      config.tools.web.search.gemini = {};
    }
    config.tools.web.search.gemini.model = config.tools.web.search.gemini.model || 'gemini-2.5-flash';
  }

  writeConfig(openclawHome, config);
}

function resetFeishuPluginFlagsBeforeInstall(openclawHome) {
  const config = readConfig(openclawHome);
  if (!config || typeof config !== 'object') return;

  if (config.plugins?.allow && Array.isArray(config.plugins.allow)) {
    config.plugins.allow = config.plugins.allow.filter((name) => name !== 'openclaw-lark');
  }
  if (config.plugins?.entries?.['openclaw-lark']) {
    delete config.plugins.entries['openclaw-lark'];
  }

  writeConfig(openclawHome, config);
}

function patchFeishuPostInstall(openclawHome, { domain, openId }) {
  const config = readConfig(openclawHome);
  if (!config.channels || !config.channels.feishu) return;

  const prev = config.channels.feishu;
  config.channels.feishu.domain = domain || prev.domain || 'feishu';

  if (openId) {
    config.channels.feishu.dmPolicy = 'allowlist';
    config.channels.feishu.allowFrom = unique([...(prev.allowFrom || []), openId]);

    config.channels.feishu.groupPolicy = prev.groupPolicy || 'allowlist';
    config.channels.feishu.groupAllowFrom = unique([...(prev.groupAllowFrom || []), openId]);
    if (!config.channels.feishu.groups) {
      config.channels.feishu.groups = { '*': { enabled: true } };
    }
  }

  writeConfig(openclawHome, config);
}

/**
 * 通用頻道設定寫入函數（patchFeishuPostInstall 的推廣版本）
 * 將頻道 credentials 寫入 openclaw.json 的 channels 區塊
 *
 * @param {string} openclawHome - 實例的 openclaw-home 目錄
 * @param {string} channel - 頻道名稱 'telegram' | 'discord' | ...
 * @param {object} channelConfig - 完整頻道設定物件
 */
function patchChannelPostInstall(openclawHome, channel, channelConfig) {
  const config = readConfig(openclawHome);
  if (!config.channels) config.channels = {};
  config.channels[channel] = channelConfig;
  writeConfig(openclawHome, config);
}

function dockerImagePresent(imageName) {
  return !!tryRun('docker', ['image', 'inspect', imageName]);
}

function ensureDockerImage(imageName) {
  if (!dockerImagePresent(imageName)) {
    run('docker', ['pull', imageName], { stdio: 'inherit', timeout: DEFAULT_DOCKER_TIMEOUT_MS });
  }
}

function networkExists(networkName) {
  return !!tryRun('docker', ['network', 'inspect', networkName]);
}

function ensureSharedNetwork() {
  if (!networkExists(SHARED_NETWORK)) {
    run('docker', ['network', 'create', SHARED_NETWORK], { timeout: 10_000 });
  }
}

function containerExists(containerName) {
  return !!tryRun('docker', ['inspect', containerName]);
}

function containerRunning(containerName) {
  const out = tryRun('docker', ['inspect', '-f', '{{.State.Running}}', containerName]);
  return out === 'true';
}

function getContainerId(containerName) {
  return tryRun('docker', ['inspect', '-f', '{{.Id}}', containerName]);
}

function removeContainer(containerName) {
  if (containerExists(containerName)) {
    run('docker', ['rm', '-f', containerName]);
  }
}

function isTcpEndpointReachable(host, port) {
  const script = `const net = require('net');
const socket = net.createConnection({ host: ${JSON.stringify(host)}, port: ${Number(port)} }, () => { socket.end(); process.exit(0); });
socket.on('error', () => process.exit(1));
setTimeout(() => process.exit(2), 1000);`;
  return !!tryRun('node', ['-e', script], { timeout: 2_000 });
}

function createContainer({ containerName, port, imageName, openclawHome, openaiApiKey, gatewayToken, geminiApiKey, minimaxApiKey }) {
  ensureSharedNetwork();
  removeContainer(containerName);
  const args = [
    'run', '-d',
    '--name', containerName,
    '--restart', 'unless-stopped',
    '--network', SHARED_NETWORK,
  ];

  if (isTcpEndpointReachable('127.0.0.1', 24224)) {
    args.push('--log-driver', 'fluentd', '--log-opt', 'fluentd-address=127.0.0.1:24224');
  }

  args.push(
    '-p', `127.0.0.1:${port}:${INTERNAL_GATEWAY_PORT}`,
    '-e', `OPENAI_API_KEY=${openaiApiKey}`,
    '-e', `OPENAI_BASE_URL=${LITELLM_PROXY_URL}`,
    '-e', `OPENCLAW_GATEWAY_TOKEN=${gatewayToken}`,
  );
  if (geminiApiKey) {
    args.push('-e', `GEMINI_API_KEY=${geminiApiKey}`);
  }
  if (minimaxApiKey) {
    args.push('-e', `MINIMAX_API_KEY=${minimaxApiKey}`);
  }
  args.push(
    '-v', `${openclawHome}:/home/node/.openclaw`,
    '-w', '/home/node',
    imageName,
    'bash', '-lc', 'sleep infinity',
  );
  return run('docker', args, { timeout: 30_000 });
}

function dockerExec(containerName, script, env = {}) {
  const args = ['exec'];
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && value !== null) {
      args.push('-e', `${key}=${value}`);
    }
  }
  args.push(containerName, 'bash', '-lc', script);
  return run('docker', args);
}

function dockerExecDetached(containerName, script, env = {}) {
  const args = ['exec', '-d'];
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && value !== null) {
      args.push('-e', `${key}=${value}`);
    }
  }
  args.push(containerName, 'bash', '-lc', script);
  return run('docker', args);
}

function ensureContainerStarted(containerName) {
  if (!containerExists(containerName)) {
    throw new Error(`Container ${containerName} does not exist`);
  }
  if (!containerRunning(containerName)) {
    run('docker', ['start', containerName]);
  }
}

function gatewayProcessPresent(containerName) {
  const out = tryRun('docker', [
    'exec', containerName, 'bash', '-lc',
    'ps -ef | grep -E "openclaw-gateway|openclaw gateway" | grep -v grep | head -1',
  ]);
  return !!out;
}

function stopGatewayProcess(containerName) {
  if (!containerExists(containerName)) return;
  if (!containerRunning(containerName)) return;
  tryRun('docker', ['exec', containerName, 'bash', '-lc', 'pkill -f openclaw-gateway >/dev/null 2>&1 || true; pkill -f "openclaw gateway" >/dev/null 2>&1 || true']);
}

function waitForTcpPort(hostPort, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const script = `const net = require('net');
const socket = net.createConnection({ host: '127.0.0.1', port: ${hostPort} }, () => { console.log('ok'); socket.end(); process.exit(0); });
socket.on('error', () => process.exit(1));
setTimeout(() => process.exit(2), 1500);`;
    try {
      run('node', ['-e', script]);
      return true;
    } catch {
      sleep(1000);
    }
  }
  return false;
}

function waitForGateway(containerName, hostPort, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  let sawProcess = false;
  let sawPort = false;

  while (Date.now() < deadline) {
    sawProcess = gatewayProcessPresent(containerName) || sawProcess;
    sawPort = waitForTcpPort(hostPort, 1500) || sawPort;
    if (sawProcess && sawPort) {
      return true;
    }
    sleep(1000);
  }

  // Final grace probe: if the process exists and the mapped port is open by the end,
  // treat it as started even if the two signals did not align in the same second.
  return gatewayProcessPresent(containerName) && waitForTcpPort(hostPort, 3000);
}

function ensureOpenClawBootstrapped(containerName, authMode = 'openai-api-key') {
  if (authMode === 'codex-cli') {
    // Codex mode: OAuth is already persisted in auth-profiles.json.
    // For automated container bring-up, create the base config non-interactively with auth-choice=skip,
    // then let patchOpenClawDefaultsForDocker select the openai-codex model.
    const script = [
      'set -e',
      'if [ ! -f /home/node/.openclaw/openclaw.json ]; then',
      '  openclaw onboard --non-interactive --mode local --auth-choice skip --gateway-auth token --gateway-token-ref-env OPENCLAW_GATEWAY_TOKEN --accept-risk --skip-health',
      'fi',
    ].join('\n');
    dockerExec(containerName, script);
  } else {
    // API key mode: inject key via environment
    const script = [
      'set -e',
      'if [ ! -f /home/node/.openclaw/openclaw.json ]; then',
      '  openclaw onboard --non-interactive --mode local --auth-choice openai-api-key --secret-input-mode ref --gateway-auth token --gateway-token-ref-env OPENCLAW_GATEWAY_TOKEN --accept-risk --skip-health',
      'fi',
    ].join('\n');
    dockerExec(containerName, script);
  }
}

function installFeishuPlugin(containerName, appId, appSecret) {
  const appCredentials = `${appId}:${appSecret}`;
  dockerExec(
    containerName,
    `set -e\nnpx -y @larksuite/openclaw-lark install --app ${shellQuote(appCredentials)} --skip-version-check`,
  );
}

function startGatewayProcess(containerName) {
  stopGatewayProcess(containerName);
  tryRun('docker', ['exec', containerName, 'bash', '-lc', 'rm -f /tmp/manual-gateway.log /home/node/.openclaw/gateway.log']);
  // Important: let `docker exec -d` own the long-running foreground process directly.
  // Previous approach (`docker exec -d bash -lc "nohup ... &"`) could exit before the
  // child stabilized, causing false-negative startup detection and requiring manual rescue.
  run('docker', [
    'exec', '-d',
    containerName,
    'bash', '-lc',
    `exec openclaw gateway run --allow-unconfigured --port ${INTERNAL_GATEWAY_PORT} >/home/node/.openclaw/gateway.log 2>&1`,
  ]);
}

function containerNameFor(agentId) {
  return sanitizeContainerName(agentId);
}

function getCronJobs(containerName) {
  const raw = dockerExec(containerName, 'openclaw cron list --json');
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed : (parsed.jobs || []);
}

function ensureDailyMemoryMaintenanceJob(containerName) {
  const jobs = getCronJobs(containerName);
  const existing = jobs.find((job) => job.name === DAILY_MEMORY_JOB_NAME);
  if (existing) return existing.jobId || existing.id || null;

  const raw = dockerExec(containerName, [
    'openclaw cron add',
    `--name ${shellQuote(DAILY_MEMORY_JOB_NAME)}`,
    `--cron ${shellQuote(DAILY_MEMORY_CRON)}`,
    `--tz ${shellQuote(DEFAULT_TIMEZONE)}`,
    '--exact',
    '--session isolated',
    `--message ${shellQuote(DAILY_MEMORY_MESSAGE)}`,
    '--model openai/gpt-5.4',
    '--thinking high',
    '--no-deliver',
    '--json',
  ].join(' '));
  const parsed = JSON.parse(raw);
  return parsed.jobId || parsed.id || null;
}

function finalizeDockerizedConfig(openclawHome, { domain, openId, authMode = 'openai-api-key' }) {
  patchOpenClawDefaultsForDocker(openclawHome, authMode);
  patchFeishuPostInstall(openclawHome, { domain, openId });
}

/**
 * Provisions a new Dockerized OpenClaw agent instance.
 *
 * @param {object} params - Provisioning parameters.
 * @param {string} params.id - Platform instance record ID.
 * @param {string} params.agentId - Unique agent identifier.
 * @param {string} params.userNickname - Display name of the owning user.
 * @param {string} params.botNickname - Display name for the bot.
 * @param {number} params.port - Host port mapped to the gateway (maps to container port 18789).
 * @param {string} params.feishuAppId - Feishu app ID for the Lark plugin.
 * @param {string} params.feishuAppSecret - Feishu app secret.
 * @param {string} params.feishuOpenId - Feishu open_id of the owning user.
 * @param {string} [params.feishuDomain='feishu'] - Feishu domain / environment.
 * @param {string} params.openaiApiKey - OpenAI API key passed into the container.
 *
 * @returns {{ workspaceDir: string, agentDir: string, containerName: string, containerId: string, imageName: string, gatewayToken: string }}
 *
 * @throws {Error} If OpenAI API key is missing, Docker image pull fails, or Gateway fails to start within the timeout.
 *
 * @example
 * const result = await provisionAgent({
 *   id: 'inst_001',
 *   agentId: 'user_alice',
 *   userNickname: 'Alice',
 *   botNickname: 'Arrodes',
 *   port: 30001,
 *   feishuAppId: 'cli_xxx',
 *   feishuAppSecret: 'xxx',
 *   feishuOpenId: 'ou_xxx',
 *   feishuDomain: 'feishu',
 *   authMode: 'codex-cli',       // 'codex-cli' | 'openai-api-key'
 *   openaiApiKey: 'sk-xxx',      // required only if authMode='openai-api-key'
 * });
 */
export function provisionAgent({ id, agentId, userNickname, botNickname, port, feishuAppId, feishuAppSecret, feishuOpenId, feishuDomain, authMode = 'openai-api-key', openaiApiKey }) {
  if (authMode === 'openai-api-key' && !openaiApiKey) {
    throw new Error('缺少 OpenAI API Key，無法建立容器');
  }

  const { openclawHome, workspaceDir } = ensureInstanceDirs(agentId);
  const containerName = containerNameFor(agentId);
  const imageName = DEFAULT_IMAGE;
  const gatewayToken = crypto.randomBytes(24).toString('hex');
  const geminiApiKey = process.env.GEMINI_API_KEY || '';
  const minimaxApiKey = process.env.MINIMAX_API_KEY || '';

  seedWorkspaceDefaults({ workspaceDir, userNickname, botNickname });
  writeIfMissing(join(workspaceDir, 'IDENTITY.md'), identityMarkdown({ botNickname, userNickname }));

  ensureDockerImage(imageName);
  const containerId = createContainer({
    containerName,
    port,
    imageName,
    openclawHome,
    openaiApiKey,
    gatewayToken,
    geminiApiKey,
    minimaxApiKey,
  });

  updateProvisionInfo(id, {
    workspaceDir,
    agentDir: openclawHome,
    containerName,
    containerId,
    imageName,
    gatewayToken,
  });

  ensureContainerStarted(containerName);
  ensureOpenClawBootstrapped(containerName, authMode);
  patchOpenClawDefaultsForDocker(openclawHome, authMode);
  resetFeishuPluginFlagsBeforeInstall(openclawHome);
  installFeishuPlugin(containerName, feishuAppId, feishuAppSecret);
  finalizeDockerizedConfig(openclawHome, {
    domain: feishuDomain,
    openId: feishuOpenId,
    authMode,
  });
  startGatewayProcess(containerName);

  if (!waitForGateway(containerName, port)) {
    updateStatus(id, 'error');
    throw new Error('Gateway 未在預期時間內啟動成功');
  }

  try {
    ensureDailyMemoryMaintenanceJob(containerName);
  } catch (error) {
    console.warn(`[provisioner] warning: failed to ensure daily memory cron for ${containerName}: ${error.message}`);
  }

  updateStatus(id, 'running');

  return { workspaceDir, agentDir: openclawHome, containerName, containerId, imageName, gatewayToken };
}

/**
 * Starts the OpenClaw gateway inside an already-provisioned container.
 *
 * @param {object} params
 * @param {string} params.id - Platform instance record ID.
 * @param {string} params.agentId - Unique agent identifier.
 * @param {number} params.port - Host port mapped to the gateway.
 *
 * @returns {{ success: boolean, containerName: string, containerId: string }}
 *
 * @throws {Error} If the container does not exist or the gateway fails the health check after starting.
 */
export function startGateway({ id, agentId, port }) {
  const containerName = containerNameFor(agentId);
  ensureContainerStarted(containerName);
  startGatewayProcess(containerName);

  if (!waitForGateway(containerName, port)) {
    updateStatus(id, 'error');
    throw new Error('Gateway 啟動後健康檢查失敗');
  }

  try {
    ensureDailyMemoryMaintenanceJob(containerName);
  } catch (error) {
    console.warn(`[provisioner] warning: failed to ensure daily memory cron for ${containerName}: ${error.message}`);
  }

  updateStatus(id, 'running');
  return { success: true, containerName, containerId: getContainerId(containerName) };
}

/**
 * Stops the OpenClaw gateway and pauses the Docker container.
 *
 * @param {object} params
 * @param {string} params.id - Platform instance record ID.
 * @param {string} params.agentId - Unique agent identifier.
 *
 * @returns {{ success: boolean, message?: string, containerName: string }}
 *
 * @example
 * stopGateway({ id: 'inst_001', agentId: 'user_alice' });
 */
export function stopGateway({ id, agentId }) {
  const containerName = containerNameFor(agentId);
  if (!containerExists(containerName)) {
    updateStatus(id, 'stopped');
    return { success: true, message: 'Container not found' };
  }

  stopGatewayProcess(containerName);
  run('docker', ['stop', containerName]);
  updateStatus(id, 'stopped');
  return { success: true, containerName };
}

/**
 * Permanently deletes an agent instance: stops the gateway, removes the Docker container,
 * wipes the instance directory, and releases the allocated port.
 *
 * @param {object} params
 * @param {string} params.id - Platform instance record ID.
 * @param {string} params.agentId - Unique agent identifier.
 * @param {number} params.port - Host port previously allocated to this instance.
 *
 * @returns {{ success: boolean, containerName: string }}
 *
 * @example
 * deleteInstance({ id: 'inst_001', agentId: 'user_alice', port: 30001 });
 */
export function deleteInstance({ id, agentId, port }) {
  const containerName = containerNameFor(agentId);
  stopGatewayProcess(containerName);
  removeContainer(containerName);
  removeInstanceDir(agentId);
  releasePort(port);
  updateStatus(id, 'deleted');
  return { success: true, containerName };
}

/**
 * Checks whether the OpenClaw gateway process is currently running inside a container.
 *
 * @param {string} agentId - Unique agent identifier.
 * @returns {boolean} True if the container exists, is running, and the gateway process is present.
 *
 * @example
 * const running = isGatewayRunning('user_alice');
 */
export function isGatewayRunning(agentId) {
  const containerName = containerNameFor(agentId);
  if (!containerExists(containerName) || !containerRunning(containerName)) {
    return false;
  }
  return gatewayProcessPresent(containerName);
}

/**
 * T10 — Platform-side container liveness check.
 * Returns { alive, containerRunning, gatewayResponding } for a given agent.
 * The platform can call this via a cron or an admin /health endpoint.
 */
export function checkContainerLiveness(agentId) {
  const containerName = containerNameFor(agentId);
  const exists = containerExists(containerName);
  const running = exists ? containerRunning(containerName) : false;
  const gatewayProc = running ? gatewayProcessPresent(containerName) : false;

  // Probe the gateway via docker exec + curl inside the container.
  // This is more reliable than TCP socket to container IP — the gateway
  // binds to localhost inside the container, not the container's external IP.
  let gatewayResponding = false;
  if (running) {
    try {
      const result = tryRun('docker', [
        'exec', containerName,
        'sh', '-c',
        `curl -s --connect-timeout 3 http://127.0.0.1:${INTERNAL_GATEWAY_PORT}/health || true`,
      ], { timeout: 8000 });
      gatewayResponding = result && (result.includes('"ok"') || result.includes('"live"'));
    } catch (_) {
      gatewayResponding = false;
    }
  }

  const alive = running && gatewayProc && gatewayResponding;
  return { alive, containerRunning: running, gatewayProcessPresent: gatewayProc, gatewayResponding };
}

/**
 * Probes the LiteLLM proxy health endpoint (GET /health).
 *
 * @returns {Promise<{ healthy: boolean, statusCode: number, body: string }>}
 * @example
 * const { healthy, statusCode } = await checkLiteLLMProxyHealth();
 */
export async function checkLiteLLMProxyHealth() {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    const res = await fetch(`${LITELLM_PROXY_URL}/health`, {
      signal: controller.signal,
    });
    clearTimeout(timer);
    let body = '';
    try { body = await res.text(); } catch { /* ignore */ }
    const healthy = res.ok;
    return { healthy, statusCode: res.status, body };
  } catch (err) {
    return { healthy: false, statusCode: 0, body: err.message };
  }
}

/**
 * Retrieves the list of available models from the LiteLLM proxy (GET /model/info).
 * Uses the `LITELLM_MASTER_KEY` environment variable for Bearer authentication.
 *
 * @returns {Promise<{ models: string[], statusCode: number, error: string|null }>}
 * @example
 * const { models } = await getLiteLLMModelInfo();
 */
export async function getLiteLLMModelInfo() {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    const masterKey = process.env.LITELLM_MASTER_KEY || 'sk-1234';
    const res = await fetch(`${LITELLM_PROXY_URL}/model/info`, {
      signal: controller.signal,
      headers: { Authorization: `Bearer ${masterKey}` },
    });
    clearTimeout(timer);
    let body = {};
    try { body = JSON.parse(await res.text()); } catch { /* ignore */ }
    if (!res.ok) {
      return { models: [], statusCode: res.status, error: body?.error || res.statusText };
    }
    // litellm /model/info returns { data: [{ model_name, ... }, ...] }
    const models = Array.isArray(body.data) ? body.data.map(m => m.model_name) : [];
    return { models, statusCode: res.status, error: null };
  } catch (err) {
    return { models: [], statusCode: 0, error: err.message };
  }
}

/**
 * Queries the LiteLLM proxy for a user's total spend (GET /spend?user_id=...).
 *
 * @param {string} userId - The LiteLLM user identifier to query spending for.
 * @returns {Promise<{ totalSpend: number, statusCode: number, error: string|null, details: object }>}
 * @example
 * const { totalSpend } = await getLiteLLMSpend('user_alice');
 */
export async function getLiteLLMSpend(userId) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    const masterKey = process.env.LITELLM_MASTER_KEY || 'sk-1234';
    const url = new URL(`${LITELLM_PROXY_URL}/spend`);
    url.searchParams.set('user_id', userId);
    const res = await fetch(url.toString(), {
      signal: controller.signal,
      headers: { Authorization: `Bearer ${masterKey}` },
    });
    clearTimeout(timer);
    let body = {};
    try { body = JSON.parse(await res.text()); } catch { /* ignore */ }
    if (!res.ok) {
      return { totalSpend: 0, statusCode: res.status, error: body?.error || res.statusText };
    }
    // litellm /spend returns { total_spend: ..., spend_per_model: {...}, ... }
    const totalSpend = typeof body.total_spend === 'number' ? body.total_spend : 0;
    return { totalSpend, statusCode: res.status, error: null, details: body };
  } catch (err) {
    return { totalSpend: 0, statusCode: 0, error: err.message };
  }
}

/**
 * 寫入頻道設定到 openclaw.json（通用版本，供 server.js 調用）
 * @param {string} agentId
 * @param {string} channel - 頻道名 'telegram' | 'discord' | ...
 * @param {object} channelConfig - 完整頻道設定物件
 * @returns {{ success: boolean, error?: string }}
 */
export function patchChannelConfig(agentId, channel, channelConfig) {
  try {
    const dirs = ensureInstanceDirs(agentId);
    const config = readConfig(dirs.openclawHome);
    if (!config.channels) config.channels = {};
    config.channels[channel] = channelConfig;
    writeConfig(dirs.openclawHome, config);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * 在指定實例的容器中執行 bash 命令
 * @param {string} agentId
 * @param {string} command - 要執行的 bash 命令
 * @returns {{ success: boolean, output?: string, error?: string }}
 */
export function execInContainer(agentId, command) {
  try {
    const containerName = `auto-openclaw-${agentId}`;
    const output = execFileSync(
      'docker',
      ['exec', containerName, 'bash', '-lc', command],
      { encoding: 'utf-8', timeout: 30_000, maxBuffer: 1024 * 1024 }
    );
    return { success: true, output: output || '' };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

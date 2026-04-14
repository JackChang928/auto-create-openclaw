import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { checkContainerLiveness, getLiteLLMSpend } from './provisioner.js';

const execFileAsync = promisify(execFile);
const SNAPSHOT_TTL_MS = 10_000;
const snapshotCache = new Map();

function getProfilesPath(agentDir) {
  return join(agentDir, 'agents', 'current', 'agent', 'auth-profiles.json');
}

export function authStatusForUser(user) {
  const hasAgentDir = !!user.agent_dir;
  const profilePath = hasAgentDir ? getProfilesPath(user.agent_dir) : null;
  const hasCodexProfile = !!(profilePath && existsSync(profilePath));
  const mode = user.auth_mode || 'openai-api-key';
  const ready = mode === 'codex-cli' ? hasCodexProfile : !!user.openai_api_key;
  const summary = mode === 'codex-cli'
    ? (hasCodexProfile ? 'Codex 已授權' : 'Codex 未完成')
    : (user.openai_api_key ? 'API Key 已就緒' : '啟用時自動配置 API Key');
  return {
    mode,
    hasAgentDir,
    hasCodexProfile,
    ready,
    summary,
    profilePath,
  };
}

async function runCommand(command, args, { timeout = 8_000 } = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      encoding: 'utf-8',
      timeout,
      maxBuffer: 1024 * 1024,
    });
    return { ok: true, stdout: stdout?.trim?.() || '', stderr: stderr?.trim?.() || '' };
  } catch (error) {
    return {
      ok: false,
      stdout: error.stdout?.toString?.().trim?.() || '',
      stderr: error.stderr?.toString?.().trim?.() || '',
      error: error.message,
      code: error.code ?? null,
    };
  }
}

function parseMaybeJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function runDocker(args, options) {
  return runCommand('docker', args, options);
}

async function runOpenClawInContainer(containerName, args, options) {
  return runCommand('openclaw', ['--container', containerName, ...args], options);
}

function parseDockerState(inspect) {
  const state = inspect?.State || {};
  const ports = inspect?.NetworkSettings?.Ports || {};
  return {
    exists: !!inspect,
    running: !!state.Running,
    status: state.Status || null,
    startedAt: state.StartedAt || null,
    finishedAt: state.FinishedAt || null,
    restartCount: Number(state.RestartCount || 0),
    exitCode: state.ExitCode ?? null,
    error: state.Error || null,
    healthStatus: state.Health?.Status || null,
    ports,
  };
}

function parseStatsValue(value) {
  if (!value || typeof value !== 'string') return null;
  const m = value.trim().match(/^([0-9.]+)\s*([kmgtpe]?i?b)$/i);
  if (!m) return null;
  const num = Number(m[1]);
  const unit = m[2].toLowerCase();
  const map = {
    b: 1,
    kb: 1e3,
    mb: 1e6,
    gb: 1e9,
    tb: 1e12,
    pb: 1e15,
    kib: 1024,
    mib: 1024 ** 2,
    gib: 1024 ** 3,
    tib: 1024 ** 4,
    pib: 1024 ** 5,
  };
  return Math.round(num * (map[unit] || 1));
}

function parseDockerStats(stats) {
  if (!stats) {
    return {
      cpuPercent: null,
      memUsageText: null,
      memUsageBytes: null,
      memLimitBytes: null,
      memPercent: null,
      netIO: null,
      blockIO: null,
      pids: null,
      raw: null,
    };
  }

  const memParts = String(stats.MemUsage || '').split('/').map((s) => s.trim());
  const cpuPercent = stats.CPUPerc ? Number(String(stats.CPUPerc).replace('%', '').trim()) : null;
  const memPercent = stats.MemPerc ? Number(String(stats.MemPerc).replace('%', '').trim()) : null;
  return {
    cpuPercent: Number.isFinite(cpuPercent) ? cpuPercent : null,
    memUsageText: stats.MemUsage || null,
    memUsageBytes: memParts[0] ? parseStatsValue(memParts[0]) : null,
    memLimitBytes: memParts[1] ? parseStatsValue(memParts[1]) : null,
    memPercent: Number.isFinite(memPercent) ? memPercent : null,
    netIO: stats.NetIO || null,
    blockIO: stats.BlockIO || null,
    pids: stats.PIDs || null,
    raw: stats,
  };
}

function asArray(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.items)) return data.items;
  if (Array.isArray(data?.sessions)) return data.sessions;
  if (Array.isArray(data?.data)) return data.data;
  if (Array.isArray(data?.rows)) return data.rows;
  return [];
}

function firstDefined(...values) {
  return values.find((v) => v != null) ?? null;
}

function newestTimestampFromItems(items = []) {
  let best = null;
  for (const item of items) {
    const candidate = firstDefined(
      item?.updatedAt,
      item?.updated_at,
      item?.lastMessageAt,
      item?.last_message_at,
      item?.lastActiveAt,
      item?.last_active_at,
      item?.timestamp,
      item?.time,
      item?.createdAt,
      item?.created_at,
    );
    if (!candidate) continue;
    const date = new Date(candidate);
    if (Number.isNaN(date.getTime())) continue;
    if (!best || date > best) best = date;
  }
  return best ? best.toISOString() : null;
}

function extractCronCounts(data) {
  const jobs = asArray(data);
  if (!jobs.length) return { total: 0, enabled: 0, disabled: 0, healthy: null, items: jobs };
  let enabled = 0;
  let disabled = 0;
  for (const job of jobs) {
    const isEnabled = firstDefined(job?.enabled, job?.isEnabled, job?.active, job?.disabled === false);
    if (isEnabled === false) disabled += 1;
    else enabled += 1;
  }
  return {
    total: jobs.length,
    enabled,
    disabled,
    healthy: enabled > 0,
    items: jobs,
  };
}

function extractOpenClawHealth(data, commandOk, commandError) {
  const explicit = firstDefined(data?.healthy, data?.ok, data?.success, data?.gateway?.healthy);
  return {
    healthy: typeof explicit === 'boolean' ? explicit : !!commandOk,
    raw: data,
    error: commandOk ? null : commandError,
  };
}

function normalizeSpend(user, spendReport) {
  const budget = Number(user.budget || 0);
  const spend = Number(spendReport?.totalSpend || 0);
  const ratio = budget > 0 ? spend / budget : null;
  return {
    budget,
    spend,
    ratio,
    statusCode: spendReport?.statusCode ?? null,
    error: spendReport?.error ?? null,
  };
}

function computeOverallHealth({ lifecycle, runtime, auth, billing }) {
  if (lifecycle === 'error') return 'critical';
  if (lifecycle === 'pending_scan' || lifecycle === 'pending_activation') return 'pending';
  if (lifecycle === 'stopped' || lifecycle === 'provisioned') return 'idle';
  if (lifecycle === 'running' && (!runtime.containerRunning || !runtime.gatewayResponding || !runtime.gatewayProcessPresent)) return 'critical';
  if (billing.ratio != null && billing.ratio >= 1) return 'critical';
  if (!auth.ready || (billing.ratio != null && billing.ratio >= 0.8)) return 'warning';
  return 'healthy';
}

function buildHealthBadges({ lifecycle, runtime, auth, billing, cron }) {
  return {
    docker: runtime.containerRunning ? 'healthy' : (lifecycle === 'running' ? 'critical' : 'idle'),
    gateway: runtime.gatewayResponding ? 'healthy' : (lifecycle === 'running' ? 'critical' : 'idle'),
    auth: auth.ready ? 'healthy' : 'warning',
    billing: billing.ratio != null && billing.ratio >= 1 ? 'critical' : billing.ratio != null && billing.ratio >= 0.8 ? 'warning' : 'healthy',
    cron: cron.healthy == null ? 'unknown' : cron.healthy ? 'healthy' : 'warning',
  };
}

async function collectDockerRuntime(user) {
  if (!user.container_name) {
    return {
      exists: false,
      running: false,
      status: null,
      startedAt: null,
      finishedAt: null,
      restartCount: 0,
      exitCode: null,
      error: null,
      healthStatus: null,
      ports: null,
      cpuPercent: null,
      memUsageText: null,
      memUsageBytes: null,
      memLimitBytes: null,
      memPercent: null,
      netIO: null,
      blockIO: null,
      pids: null,
      rawStats: null,
    };
  }

  const [inspectRes, statsRes] = await Promise.all([
    runDocker(['inspect', user.container_name]),
    runDocker(['stats', '--no-stream', '--format', '{{json .}}', user.container_name]),
  ]);

  const inspectJson = parseMaybeJson(inspectRes.stdout);
  const inspect = Array.isArray(inspectJson) ? inspectJson[0] : null;
  const state = parseDockerState(inspect);
  const stats = parseDockerStats(parseMaybeJson(statsRes.stdout));
  return {
    ...state,
    ...stats,
    rawStats: stats.raw,
  };
}

async function collectOpenClawState(user) {
  if (!user.container_name) {
    return {
      health: { healthy: false, raw: null, error: 'container not provisioned' },
      status: { raw: null, error: 'container not provisioned' },
      sessions: { count24h: 0, lastActivityAt: null, items: [], error: null },
      cron: { total: 0, enabled: 0, disabled: 0, healthy: null, items: [], error: null },
    };
  }

  const [healthRes, statusRes, sessionsRes, cronRes] = await Promise.all([
    runOpenClawInContainer(user.container_name, ['health', '--json', '--timeout', '5000']),
    runOpenClawInContainer(user.container_name, ['status', '--json', '--timeout', '5000']),
    runOpenClawInContainer(user.container_name, ['sessions', '--json', '--active', '1440']),
    runOpenClawInContainer(user.container_name, ['cron', 'list', '--json', '--all', '--timeout', '5000']),
  ]);

  const healthData = parseMaybeJson(healthRes.stdout);
  const statusData = parseMaybeJson(statusRes.stdout);
  const sessionsData = parseMaybeJson(sessionsRes.stdout);
  const cronData = parseMaybeJson(cronRes.stdout);
  const sessions = asArray(sessionsData);
  const cron = extractCronCounts(cronData);

  return {
    health: extractOpenClawHealth(healthData, healthRes.ok, healthRes.error || healthRes.stderr),
    status: { raw: statusData, error: statusRes.ok ? null : statusRes.error || statusRes.stderr },
    sessions: {
      count24h: sessions.length,
      lastActivityAt: newestTimestampFromItems(sessions),
      items: sessions,
      error: sessionsRes.ok ? null : sessionsRes.error || sessionsRes.stderr,
    },
    cron: {
      ...cron,
      error: cronRes.ok ? null : cronRes.error || cronRes.stderr,
    },
  };
}

async function buildSnapshot(user) {
  const auth = authStatusForUser(user);
  const [runtime, dockerRuntime, openclawState, spendReport] = await Promise.all([
    Promise.resolve(user.agent_id ? checkContainerLiveness(user.agent_id) : { alive: false, containerRunning: false, gatewayProcessPresent: false, gatewayResponding: false }),
    collectDockerRuntime(user),
    collectOpenClawState(user),
    user.agent_id ? getLiteLLMSpend(user.agent_id) : Promise.resolve({ totalSpend: 0, statusCode: null, error: null }),
  ]);

  const billing = normalizeSpend(user, spendReport);
  const lifecycle = user.status;
  const activity = {
    updatedAt: user.updated_at,
    createdAt: user.created_at,
    lastSessionAt: openclawState.sessions.lastActivityAt,
    lastSeenAt: openclawState.sessions.lastActivityAt || user.updated_at,
  };

  const runtimeSummary = {
    alive: runtime.alive,
    containerRunning: runtime.containerRunning,
    gatewayProcessPresent: runtime.gatewayProcessPresent,
    gatewayResponding: runtime.gatewayResponding,
    containerExists: dockerRuntime.exists,
    status: dockerRuntime.status,
    startedAt: dockerRuntime.startedAt,
    finishedAt: dockerRuntime.finishedAt,
    restartCount: dockerRuntime.restartCount,
    exitCode: dockerRuntime.exitCode,
    error: dockerRuntime.error,
    healthStatus: dockerRuntime.healthStatus,
    cpuPercent: dockerRuntime.cpuPercent,
    memUsageText: dockerRuntime.memUsageText,
    memUsageBytes: dockerRuntime.memUsageBytes,
    memLimitBytes: dockerRuntime.memLimitBytes,
    memPercent: dockerRuntime.memPercent,
    netIO: dockerRuntime.netIO,
    blockIO: dockerRuntime.blockIO,
    pids: dockerRuntime.pids,
    ports: dockerRuntime.ports,
  };

  const snapshot = {
    id: user.id,
    agentId: user.agent_id,
    userNickname: user.user_nickname,
    botNickname: user.bot_nickname,
    lifecycle,
    port: user.port,
    containerName: user.container_name,
    containerId: user.container_id,
    imageName: user.image_name,
    feishu: {
      ready: !!(user.feishu_app_id && user.feishu_app_secret),
      appId: user.feishu_app_id || null,
      openId: user.feishu_open_id || null,
      domain: user.feishu_domain || null,
    },
    auth,
    billing,
    runtime: runtimeSummary,
    openclaw: openclawState,
    activity,
    cron: openclawState.cron,
    db: {
      createdAt: user.created_at,
      updatedAt: user.updated_at,
      workspaceDir: user.workspace_dir,
      agentDir: user.agent_dir,
    },
  };

  snapshot.health = {
    overall: computeOverallHealth(snapshot),
    badges: buildHealthBadges(snapshot),
  };

  return snapshot;
}

function getCachedSnapshot(user) {
  const cached = snapshotCache.get(user.id);
  if (!cached) return null;
  if (Date.now() - cached.at > SNAPSHOT_TTL_MS) {
    snapshotCache.delete(user.id);
    return null;
  }
  return cached.value;
}

function setCachedSnapshot(userId, value) {
  snapshotCache.set(userId, { at: Date.now(), value });
}

export async function getInstanceDashboardSnapshot(user, { force = false } = {}) {
  if (!force) {
    const cached = getCachedSnapshot(user);
    if (cached) return cached;
  }
  const snapshot = await buildSnapshot(user);
  setCachedSnapshot(user.id, snapshot);
  return snapshot;
}

function healthRank(level) {
  return {
    critical: 0,
    warning: 1,
    pending: 2,
    healthy: 3,
    idle: 4,
    unknown: 5,
  }[level] ?? 99;
}

export async function getDashboardInstances(users, { force = false } = {}) {
  const items = await Promise.all(users.map((user) => getInstanceDashboardSnapshot(user, { force })));
  items.sort((a, b) => {
    const rankDiff = healthRank(a.health.overall) - healthRank(b.health.overall);
    if (rankDiff !== 0) return rankDiff;
    return String(b.activity.lastSeenAt || '').localeCompare(String(a.activity.lastSeenAt || ''));
  });
  return items;
}

function alertSeverityRank(level) {
  return { critical: 0, warning: 1, info: 2 }[level] ?? 99;
}

export function buildDashboardAlerts(items, { limit = 12 } = {}) {
  const alerts = [];

  for (const item of items) {
    if (item.lifecycle === 'error') {
      alerts.push({ severity: 'critical', code: 'instance-error', instanceId: item.id, agentId: item.agentId, title: '實例處於 error 狀態', detail: `${item.userNickname} / ${item.botNickname}` });
    }
    if (item.lifecycle === 'running' && !item.runtime?.containerRunning) {
      alerts.push({ severity: 'critical', code: 'container-down', instanceId: item.id, agentId: item.agentId, title: '標記 running 但 Docker 未運行', detail: item.containerName || item.agentId });
    }
    if (item.lifecycle === 'running' && item.runtime?.containerRunning && !item.runtime?.gatewayResponding) {
      alerts.push({ severity: 'critical', code: 'gateway-down', instanceId: item.id, agentId: item.agentId, title: 'Gateway 無回應', detail: item.containerName || item.agentId });
    }
    if (!item.auth?.ready) {
      alerts.push({ severity: 'warning', code: 'auth-not-ready', instanceId: item.id, agentId: item.agentId, title: '授權尚未就緒', detail: item.auth?.summary || item.agentId });
    }
    if (item.billing?.ratio != null && item.billing.ratio >= 1) {
      alerts.push({ severity: 'critical', code: 'budget-exceeded', instanceId: item.id, agentId: item.agentId, title: 'Budget 已超限', detail: `${item.userNickname} 已使用 ${Math.round(item.billing.ratio * 100)}%` });
    } else if (item.billing?.ratio != null && item.billing.ratio >= 0.8) {
      alerts.push({ severity: 'warning', code: 'budget-warning', instanceId: item.id, agentId: item.agentId, title: 'Budget 接近上限', detail: `${item.userNickname} 已使用 ${Math.round(item.billing.ratio * 100)}%` });
    }
    if (item.openclaw?.cron?.healthy === false) {
      alerts.push({ severity: 'warning', code: 'cron-warning', instanceId: item.id, agentId: item.agentId, title: 'Cron 可能異常', detail: `${item.openclaw?.cron?.enabled ?? 0}/${item.openclaw?.cron?.total ?? 0} enabled` });
    }
    if (item.feishu?.ready === false && item.lifecycle !== 'pending_scan') {
      alerts.push({ severity: 'warning', code: 'feishu-missing', instanceId: item.id, agentId: item.agentId, title: '缺少 Feishu 授權', detail: `${item.userNickname} / ${item.botNickname}` });
    }
  }

  alerts.sort((a, b) => {
    const severityDiff = alertSeverityRank(a.severity) - alertSeverityRank(b.severity);
    if (severityDiff !== 0) return severityDiff;
    return String(a.agentId || '').localeCompare(String(b.agentId || ''));
  });
  return alerts.slice(0, limit);
}

export function summarizeDashboard(items) {
  const summary = {
    total: items.length,
    byLifecycle: {
      pending_scan: 0,
      pending_activation: 0,
      provisioned: 0,
      running: 0,
      stopped: 0,
      error: 0,
    },
    byHealth: {
      critical: 0,
      warning: 0,
      pending: 0,
      healthy: 0,
      idle: 0,
    },
    authNotReady: 0,
    budgetWarning: 0,
    runningAlive: 0,
  };

  for (const item of items) {
    if (summary.byLifecycle[item.lifecycle] != null) summary.byLifecycle[item.lifecycle] += 1;
    if (summary.byHealth[item.health.overall] != null) summary.byHealth[item.health.overall] += 1;
    if (!item.auth.ready) summary.authNotReady += 1;
    if (item.billing.ratio != null && item.billing.ratio >= 0.8) summary.budgetWarning += 1;
    if (item.runtime.alive) summary.runningAlive += 1;
  }

  summary.alerts = buildDashboardAlerts(items);
  summary.alertCount = summary.alerts.length;
  return summary;
}

export async function getInstanceLogs(user, { source = 'docker', tail = 200 } = {}) {
  if (!user.container_name) {
    return { source, ok: false, content: '', error: '實例尚未建立容器' };
  }

  if (source === 'openclaw') {
    const res = await runOpenClawInContainer(user.container_name, ['logs', '--plain', '--limit', String(tail), '--timeout', '5000']);
    return {
      source,
      ok: res.ok,
      content: res.stdout || res.stderr || '',
      error: res.ok ? null : res.error || res.stderr || '讀取 OpenClaw logs 失敗',
    };
  }

  const res = await runDocker(['logs', '--tail', String(tail), user.container_name], { timeout: 8_000 });
  return {
    source: 'docker',
    ok: res.ok,
    content: res.stdout || res.stderr || '',
    error: res.ok ? null : res.error || res.stderr || '讀取 Docker logs 失敗',
  };
}

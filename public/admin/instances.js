/**
 * admin/instances.js — Admin Monitoring Dashboard
 */

const STATUS_MAP = {
  pending_scan: { label: '等待掃碼', dotClass: 'bg-muted' },
  pending_activation: { label: '等待激活', dotClass: 'bg-warning' },
  provisioned: { label: '已部署 (未啟動)', dotClass: 'bg-blue' },
  running: { label: '運行中', dotClass: 'bg-success pulse' },
  stopped: { label: '已停止', dotClass: 'bg-muted' },
  error: { label: '錯誤', dotClass: 'bg-error' },
};

let _adminApi = null;
let _refreshInterval = null;
let _dashboardItems = [];
let _dashboardSummary = null;


async function initAdminPanel() {
  if (!getAdminAPI().isLoggedIn()) {
    showLoginModal();
    return;
  }
  await loadDashboard();
  startAutoRefresh();
}

function getAdminAPI() {
  if (!_adminApi) _adminApi = new OpenClawAdminAPI();
  return _adminApi;
}

function getFilters() {
  return {
    q: document.getElementById('search-input')?.value?.trim()?.toLowerCase() || '',
    lifecycle: document.getElementById('filter-lifecycle')?.value || '',
    health: document.getElementById('filter-health')?.value || '',
    auth: document.getElementById('filter-auth')?.value || '',
    sortBy: document.getElementById('sort-by')?.value || 'severity',
  };
}

function healthRank(level) {
  return { critical: 0, warning: 1, pending: 2, healthy: 3, idle: 4, unknown: 5 }[level] ?? 99;
}

function applyFilters(items) {
  const filters = getFilters();
  const filtered = items.filter((item) => {
    const haystack = [
      item.userNickname,
      item.botNickname,
      item.agentId,
      item.containerName,
      item.imageName,
    ].filter(Boolean).join(' ').toLowerCase();

    if (filters.q && !haystack.includes(filters.q)) return false;
    if (filters.lifecycle && item.lifecycle !== filters.lifecycle) return false;
    if (filters.health && item.health?.overall !== filters.health) return false;
    if (filters.auth === 'not-ready' && item.auth?.ready) return false;
    if (filters.auth && filters.auth !== 'not-ready' && item.auth?.mode !== filters.auth) return false;
    return true;
  });

  filtered.sort((a, b) => {
    switch (filters.sortBy) {
      case 'activity':
        return String(b.activity?.lastSeenAt || '').localeCompare(String(a.activity?.lastSeenAt || ''));
      case 'spend':
        return (b.billing?.ratio ?? -1) - (a.billing?.ratio ?? -1);
      case 'cpu':
        return (b.runtime?.cpuPercent ?? -1) - (a.runtime?.cpuPercent ?? -1);
      case 'sessions':
        return (b.openclaw?.sessions?.count24h ?? -1) - (a.openclaw?.sessions?.count24h ?? -1);
      case 'severity':
      default: {
        const rankDiff = healthRank(a.health?.overall) - healthRank(b.health?.overall);
        if (rankDiff !== 0) return rankDiff;
        return String(b.activity?.lastSeenAt || '').localeCompare(String(a.activity?.lastSeenAt || ''));
      }
    }
  });

  return filtered;
}

async function loadDashboard(force = false) {
  const tbody = document.getElementById('instances-body');
  if (tbody) {
    tbody.innerHTML = `<tr><td colspan="6" style="text-align:center; color:var(--text-muted); padding:32px;">載入中...</td></tr>`;
  }

  try {
    const api = getAdminAPI();
    const data = await api.getDashboardInstances(force);
    _dashboardItems = Array.isArray(data.items) ? data.items : [];
    _dashboardSummary = data.summary || null;
    renderSummary(_dashboardSummary);
    renderAlerts(_dashboardSummary?.alerts || []);
    renderGeneratedAt(data.generatedAt);
    renderTable();
  } catch (err) {
    if (tbody) {
      tbody.innerHTML = `<tr><td colspan="6" style="color:var(--error); text-align:center; padding:32px;">${window.OpenClawApp.escHtml(err.message)}</td></tr>`;
    }
  }
}

function renderGeneratedAt(ts) {
  const el = document.getElementById('generated-at');
  if (!el) return;
  el.textContent = ts ? `快照：${formatDateTime(ts)}` : '尚未更新';
}

function renderSummary(summary) {
  const root = document.getElementById('summary-grid');
  if (!root) return;

  const safe = summary || {
    total: 0,
    byLifecycle: {},
    byHealth: {},
    authNotReady: 0,
    budgetWarning: 0,
    runningAlive: 0,
    alertCount: 0,
  };

  const cards = [
    ['總實例數', safe.total, '所有資料庫內實例'],
    ['運行且健康', safe.runningAlive || 0, `${safe.byLifecycle?.running || 0} 台標記為 running`],
    ['Critical', safe.byHealth?.critical || 0, '需要立刻處理'],
    ['Warning', safe.byHealth?.warning || 0, '授權 / 成本 / cron 注意'],
    ['待激活', safe.byLifecycle?.pending_activation || 0, '已掃碼，等待管理員'],
    ['待掃碼', safe.byLifecycle?.pending_scan || 0, '尚未完成 onboarding'],
    ['Auth 未就緒', safe.authNotReady || 0, 'Codex / API Key 尚未完成'],
    ['告警數', safe.alertCount || 0, '上方警示清單'],
  ];

  root.innerHTML = cards.map(([label, value, sub]) => `
    <div class="summary-card">
      <div class="summary-label">${window.OpenClawApp.escHtml(label)}</div>
      <div class="summary-value">${window.OpenClawApp.escHtml(value)}</div>
      <div class="summary-sub">${window.OpenClawApp.escHtml(sub)}</div>
    </div>
  `).join('');
}

function renderAlerts(alerts) {
  const root = document.getElementById('alerts-list');
  const meta = document.getElementById('alerts-meta');
  if (!root) return;

  if (!alerts.length) {
    root.innerHTML = `<div class="alerts-empty">目前沒有高優先級告警。</div>`;
    if (meta) meta.textContent = '系統目前看起來平穩';
    return;
  }

  if (meta) meta.textContent = `顯示 ${alerts.length} 條最高優先告警`;
  root.innerHTML = alerts.map((alert) => `
    <div class="alert-item">
      ${healthBadge(alert.severity, alert.severity.toUpperCase())}
      <div>
        <div class="alert-title">${window.OpenClawApp.escHtml(alert.title)}</div>
        <div class="alert-detail">${window.OpenClawApp.escHtml(alert.detail || alert.agentId || '')}</div>
      </div>
      ${alert.instanceId ? `<a class="btn-sm btn-secondary" href="/admin/instance.html?id=${alert.instanceId}">查看</a>` : ''}
    </div>
  `).join('');
}

function renderTable() {
  const tbody = document.getElementById('instances-body');
  if (!tbody) return;

  const items = applyFilters(_dashboardItems);
  if (!items.length) {
    tbody.innerHTML = `<tr><td colspan="6" style="text-align:center; color:var(--text-muted); padding:32px;">沒有符合條件的實例</td></tr>`;
    return;
  }

  tbody.innerHTML = items.map(renderInstanceRow).join('');
}

function renderInstanceRow(item) {
  const status = STATUS_MAP[item.lifecycle] || { label: item.lifecycle, dotClass: 'bg-muted' };
  const budgetRatio = item.billing?.ratio == null ? 0 : Math.max(0, Math.min(1, item.billing.ratio));
  const progressClass = item.billing?.ratio >= 1 ? 'critical' : item.billing?.ratio >= 0.8 ? 'warn' : '';
  const activityLabel = item.activity?.lastSessionAt ? `最後 session：${formatDateTime(item.activity.lastSessionAt)}` : `資料更新：${formatDateTime(item.activity?.updatedAt)}`;

  return `
    <tr data-instance-id="${item.id}">
      <td data-label="實例">
        <div style="font-weight:600; color:inherit;">${window.OpenClawApp.escHtml(item.userNickname)} <span style="color:var(--text-muted);font-weight:400;font-size:0.9em;">/ ${window.OpenClawApp.escHtml(item.botNickname)}</span></div>
        <div class="meta-text mono">${window.OpenClawApp.escHtml(item.agentId)}</div>
        ${item.containerName ? `<div class="meta-text mono">${window.OpenClawApp.escHtml(item.containerName)}</div>` : ''}
        ${item.port ? `<div class="meta-text">Port: ${window.OpenClawApp.escHtml(item.port)}</div>` : ''}
      </td>

      <td data-label="生命週期 / Runtime">
        <div class="status-text"><span class="status-dot ${status.dotClass}"></span>${window.OpenClawApp.escHtml(status.label)}</div>
        <div class="meta-text">Docker：${item.runtime?.containerRunning ? 'running' : 'stopped'}</div>
        <div class="meta-text">Gateway：${item.runtime?.gatewayResponding ? 'responding' : 'down'}</div>
        ${item.runtime?.cpuPercent != null ? `<div class="meta-text">CPU ${window.OpenClawApp.escHtml(item.runtime.cpuPercent)}%</div>` : ''}
        ${item.runtime?.memUsageText ? `<div class="meta-text">Mem ${window.OpenClawApp.escHtml(item.runtime.memUsageText)}</div>` : ''}
      </td>

      <td data-label="健康訊號">
        <div class="health-stack">
          ${healthBadge(item.health?.overall, `Overall · ${item.health?.overall || 'unknown'}`)}
          ${healthBadge(item.health?.badges?.docker, 'Docker')}
          ${healthBadge(item.health?.badges?.gateway, 'Gateway')}
          ${healthBadge(item.health?.badges?.auth, 'Auth')}
          ${healthBadge(item.health?.badges?.billing, 'Budget')}
          ${healthBadge(item.health?.badges?.cron, 'Cron')}
        </div>
      </td>

      <td data-label="授權 / 成本">
        <div class="signal-stack" style="margin-bottom:10px;">
          ${healthBadge(item.auth?.ready ? 'healthy' : 'warning', item.auth?.mode === 'codex-cli' ? 'Codex CLI' : 'API Key')}
          ${item.feishu?.ready ? healthBadge('healthy', 'Feishu') : healthBadge('warning', 'Feishu缺失')}
        </div>
        <div class="progress-wrap">
          <div class="progress-label">
            <span>${window.OpenClawApp.escHtml(formatCurrency(item.billing?.spend || 0))}</span>
            <span>/ ${window.OpenClawApp.escHtml(formatCurrency(item.billing?.budget || 0))}</span>
          </div>
          <div class="progress-bar"><div class="progress-fill ${progressClass}" style="width:${budgetRatio * 100}%"></div></div>
          <div class="meta-text">${item.billing?.ratio == null ? '—' : `${Math.round(item.billing.ratio * 100)}% 已使用`}</div>
          <div style="display:flex; gap:8px; margin-top:10px; flex-wrap:wrap;">
            <input type="number" class="key-input" id="budget-${item.id}" value="${item.billing?.budget ?? 20}" step="1" min="1" style="width:92px;">
            <button class="btn-sm btn-secondary" onclick="AdminInstances.saveBudget(${item.id})">儲存</button>
          </div>
        </div>
      </td>

      <td data-label="活動">
        <div>${window.OpenClawApp.escHtml(activityLabel)}</div>
        <div class="meta-text">Cron：${item.openclaw?.cron?.enabled ?? 0}/${item.openclaw?.cron?.total ?? 0} enabled</div>
        <div class="meta-text">24h sessions：${item.openclaw?.sessions?.count24h ?? 0}</div>
        ${item.runtime?.restartCount != null ? `<div class="meta-text">Restarts：${window.OpenClawApp.escHtml(item.runtime.restartCount)}</div>` : ''}
      </td>

      <td data-label="操作">
        <div class="action-group">
          <a class="btn-sm btn-secondary" href="/admin/instance.html?id=${item.id}">詳情</a>
          ${buildActionButtons(item)}
          <button class="btn-sm btn-secondary" onclick="AdminInstances.showAuthStatus(${item.id})">Auth</button>
          ${item.auth?.mode === 'codex-cli' ? `<button class="btn-sm btn-secondary" onclick="AdminInstances.resetCodex(${item.id})">Reset Codex</button>` : ''}
          <button class="btn-sm btn-stop" onclick="AdminInstances.deleteInstance(${item.id}, '${window.OpenClawApp.escHtml(item.botNickname).replace(/'/g, "\\'")}')">🗑 刪除</button>
        </div>
      </td>
    </tr>
  `;
}

function buildActionButtons(item) {
  if (item.lifecycle === 'pending_scan') return `<span class="meta-text">等待用戶掃碼中...</span>`;
  if (item.lifecycle === 'pending_activation') return `<button class="btn-sm btn-primary" onclick="AdminInstances.activate(${item.id}, this)">🚀 建立容器</button>`;
  if (item.lifecycle === 'provisioned' || item.lifecycle === 'stopped' || item.lifecycle === 'error') {
    return `<button class="btn-sm btn-start" onclick="AdminInstances.start(${item.id}, this)">▶ 啟動</button>`;
  }
  if (item.lifecycle === 'running') {
    return `<button class="btn-sm btn-stop" onclick="AdminInstances.stop(${item.id}, this)">⏸ 停用</button>`;
  }
  return '';
}

function healthBadge(level, label) {
  const normalized = level || 'unknown';
  return `<span class="badge badge-${normalized}">${window.OpenClawApp.escHtml(label)}</span>`;
}

function formatCurrency(value) {
  return `$${Number(value || 0).toFixed(2)}`;
}

function formatDateTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString('zh-TW', { hour12: false });
}

const AdminInstances = {
  async saveBudget(id) {
    const input = document.getElementById(`budget-${id}`);
    if (!input) return;
    const val = parseFloat(input.value);
    if (isNaN(val) || val < 1) return window.OpenClawApp.showToast('請輸入有效的預算金額（≥ 1）');
    try {
      await getAdminAPI().setBudget(id, val);
      window.OpenClawApp.showToast('預算已更新');
      await loadDashboard(true);
    } catch (err) {
      window.OpenClawApp.showToast(err.message);
    }
  },

  async activate(id, btn) {
    await withBusyButton(btn, '處理中...', async () => {
      await getAdminAPI().activate(id);
      window.OpenClawApp.showToast('容器建立成功');
      await loadDashboard(true);
    }, '🚀 建立容器');
  },

  async start(id, btn) {
    await withBusyButton(btn, '啟動中...', async () => {
      await getAdminAPI().start(id);
      window.OpenClawApp.showToast('啟動成功');
      await loadDashboard(true);
    }, '▶ 啟動');
  },

  async stop(id, btn) {
    await withBusyButton(btn, '停用中...', async () => {
      await getAdminAPI().stop(id);
      window.OpenClawApp.showToast('已停用');
      await loadDashboard(true);
    }, '⏸ 停用');
  },

  async showAuthStatus(id) {
    try {
      const res = await getAdminAPI().getAuthStatus(id);
      const auth = res.auth || {};
      alert(
        `授權模式：${auth.mode || 'unknown'}\n` +
        `是否就緒：${auth.ready ? '是' : '否'}\n` +
        `實例目錄：${auth.hasAgentDir ? '已建立' : '未建立'}\n` +
        `Codex Profile：${auth.hasCodexProfile ? '存在' : '不存在'}\n\n` +
        `${auth.summary || ''}`
      );
    } catch (err) {
      window.OpenClawApp.showToast(err.message);
    }
  },

  async resetCodex(id) {
    const ok = confirm('確定要重置 Codex 授權嗎？\n\n這會刪除 auth-profiles.json，並把模式切回 API Key。');
    if (!ok) return;
    try {
      await getAdminAPI().resetCodexAuth(id);
      window.OpenClawApp.showToast('Codex 授權已重置');
      await loadDashboard(true);
    } catch (err) {
      window.OpenClawApp.showToast(err.message);
    }
  },

  async deleteInstance(id, botName) {
    const ok = confirm(`確定要刪除「${botName}」嗎？\n\n這會移除容器、釋放 port、刪除資料。此操作無法撤銷。`);
    if (!ok) return;
    try {
      await getAdminAPI().deleteInstance(id);
      window.OpenClawApp.showToast('實例已刪除');
      await loadDashboard(true);
    } catch (err) {
      window.OpenClawApp.showToast(err.message);
    }
  },
};

window.AdminInstances = AdminInstances;
window.loadDashboard = loadDashboard;
window.submitAdminLogin = submitAdminLogin;

async function withBusyButton(btn, busyText, fn, doneText) {
  if (btn) { btn.disabled = true; btn.dataset.original = btn.textContent; btn.textContent = busyText; }
  try {
    await fn();
  } catch (err) {
    window.OpenClawApp.showToast(err.message);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = doneText || btn.dataset.original || '完成'; }
  }
}

function startAutoRefresh(intervalMs = 10_000) {
  stopAutoRefresh();
  _refreshInterval = setInterval(() => loadDashboard(false), intervalMs);
}

function stopAutoRefresh() {
  if (_refreshInterval) clearInterval(_refreshInterval);
  _refreshInterval = null;
}

async function submitAdminLogin(password) {
  const errEl = document.getElementById('login-error');
  if (errEl) errEl.style.display = 'none';
  if (!password) {
    if (errEl) { errEl.textContent = '請輸入密碼'; errEl.style.display = 'block'; }
    return;
  }

  try {
    const loginUrl = `${window.location.protocol}//${window.location.hostname}:3001/api/auth/login`;
    const res = await fetch(loginUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password }),
    });
    const data = await res.json();
    if (!data.token) throw new Error(data.error || '登入失敗');
    getAdminAPI().setTokenFromLogin(data.token);
    hideLoginModal();
    document.getElementById('admin-password').value = '';
    await initAdminPanel();
  } catch (err) {
    if (errEl) { errEl.textContent = err.message; errEl.style.display = 'block'; }
  }
}

function showLoginModal() {
  const modal = document.getElementById('login-modal');
  if (modal) modal.style.display = 'flex';
}

function hideLoginModal() {
  const modal = document.getElementById('login-modal');
  if (modal) modal.style.display = 'none';
}

window.addEventListener('DOMContentLoaded', () => {
  const pwdInput = document.getElementById('admin-password');
  if (pwdInput) {
    pwdInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submitAdminLogin(pwdInput.value);
    });
  }

  document.getElementById('search-input')?.addEventListener('input', renderTable);
  document.getElementById('filter-lifecycle')?.addEventListener('change', renderTable);
  document.getElementById('filter-health')?.addEventListener('change', renderTable);
  document.getElementById('filter-auth')?.addEventListener('change', renderTable);
  document.getElementById('sort-by')?.addEventListener('change', renderTable);
  document.querySelector('[data-refresh-btn]')?.addEventListener('click', () => loadDashboard(true));

  if (getAdminAPI().isLoggedIn()) initAdminPanel();
  else showLoginModal();
});

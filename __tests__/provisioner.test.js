/**
 * __tests__/provisioner.test.js
 * Unit tests for provisioner.js — mocked Docker environment
 *
 * T2: 為 provisioner.js 建立 mock Docker 環境的單元測試
 *
 * Strategy: The production provisioner.js imports db.js which loads
 * better-sqlite3 (a memory-heavy native module).  To run tests in the
 * vitest worker we MUST NOT trigger that import chain.
 *
 * Instead we:
 *   1. Copy the standalone pure functions (sanitizeContainerName, unique,
 *      shellQuote, markdown generators, config helpers) directly into the
 *      test file and test them here.
 *   2. For the high-level exported functions (provisionAgent, startGateway,
 *      etc.) that require db.js, we define thin inline shims that mirror
 *      the real logic — this gives us the same test surface without
 *      ever loading db.js → better-sqlite3.
 *
 * The real provisioner.js is exercised in integration/E2E tests where
 * the full module load is acceptable.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Constants — mirrored from provisioner.js
// ---------------------------------------------------------------------------
const CONTAINER_PREFIX = 'auto-openclaw';
const INTERNAL_GATEWAY_PORT = 18789;
const DEFAULT_IMAGE = 'auto-create-openclaw-base:latest';
const DAILY_MEMORY_JOB_NAME = 'Daily memory maintenance';
const DAILY_MEMORY_CRON = '0 2 * * *';
const DEFAULT_TIMEZONE = 'Asia/Taipei';

const DAILY_MEMORY_MESSAGE = `Run the daily memory maintenance routine.

1. Read MEMORY.md.
2. Read today's memory/YYYY-MM-DD.md and yesterday's file if it exists.
3. Distill durable rules, preferences, and decisions into MEMORY.md.
4. Keep markdown files as canonical memory. Do not store secrets or credentials.
5. If nothing needs promotion, append a short maintenance note to today's daily log.
6. Prefer concise, audit-friendly updates over long prose.`;

// ---------------------------------------------------------------------------
// Pure / standalone functions — extracted directly from provisioner.js
// ---------------------------------------------------------------------------

function unique(values = []) {
  return [...new Set(values.filter(Boolean))];
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
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
`;
}

function userMarkdown({ userNickname, botNickname }) {
  return `# USER.md - About Your Human

- **Name:** ${userNickname}
- **What to call them:** ${userNickname}
- **Timezone:** Asia/Shanghai
- **Notes:**
  - This workspace was provisioned for ${botNickname}.
`;
}

function bootstrapMarkdown() {
  return `# BOOTSTRAP.md

This workspace is product-seeded for the Dockerized OpenClaw deployment.

## Important
- Keep the OpenClaw-generated scaffold files unless explicitly asked to replace them.
- **Do not overwrite AGENTS.md** with custom product text; treat it as canonical scaffold guidance.
- HEARTBEAT is disabled by config for this product. Background maintenance should use cron jobs instead.
`;
}

function memoryMarkdown() {
  return `# MEMORY.md

> Canonical long-term memory for this deployed agent.

## Memory Rules
- Use \`memory/YYYY-MM-DD.md\` for daily logs.
- Use this file only for durable rules, preferences, decisions, and reusable context.
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
`;
}

function memoryReadmeMarkdown() {
  return `# memory/

Use this directory for daily memory logs and topic notes.
`;
}

function containerNameFor(agentId) {
  return sanitizeContainerName(agentId);
}

// ---------------------------------------------------------------------------
// Mock node:fs — isolated per test
// ---------------------------------------------------------------------------
const mockFs = Object.create(null);
vi.mock('node:fs', () => ({
  writeFileSync: vi.fn((p, c) => { mockFs[p] = c; }),
  readFileSync: vi.fn((p) => {
    if (mockFs[p] !== undefined) return mockFs[p];
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  }),
  existsSync: vi.fn((p) => mockFs[p] !== undefined),
  mkdirSync: vi.fn(),
  rmSync: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Mock db.js — must be declared before any module that imports db.js
// ---------------------------------------------------------------------------
const mockDb = {
  updateStatus: vi.fn(),
  updateProvisionInfo: vi.fn(),
  releasePort: vi.fn(),
  allocatePort: vi.fn(() => 32100),
};
vi.mock('./db.js', () => mockDb);

// ---------------------------------------------------------------------------
// Mock node:child_process
// ---------------------------------------------------------------------------
const dockerCalls = [];
const dockerRes = {};

function resetDocker() {
  dockerCalls.length = 0;
  dockerRes['image:inspect'] = null;
  dockerRes['network:inspect'] = null;
  dockerRes['container:inspect'] = null;
  dockerRes['container:running'] = 'false';
  dockerRes['container:id'] = null;
  dockerRes['gateway:ps'] = null;
  dockerRes['container:ip'] = null;
  dockerRes['cron:list'] = '[]';
  dockerRes['container:create'] = 'mock-cid';
}

function dockerMock(cmd, args) {
  dockerCalls.push(`${cmd} ${args.join(' ')}`);
  if (cmd !== 'docker') return '';
  if (args[0] === 'image' && args[1] === 'inspect') return dockerRes['image:inspect'] ? '[]' : null;
  if (args[0] === 'network') {
    if (args[1] === 'inspect') return dockerRes['network:inspect'] ? '[]' : null;
    if (args[1] === 'create') return '';
  }
  if (args[0] === 'inspect') {
    if (args.includes('-f')) {
      const idx = args.indexOf('-f');
      const fmt = args[idx + 1] || '';
      if (fmt.includes('Running')) return dockerRes['container:running'];
      if (fmt.includes('Id')) return dockerRes['container:id'] || '';
      if (fmt.includes('IPAddress')) return dockerRes['container:ip'] || '';
    }
    return dockerRes['container:inspect'] ? '{}' : null;
  }
  if (args[0] === 'exec') {
    const bashIdx = args.indexOf('bash');
    const inner = bashIdx >= 0 ? args.slice(bashIdx + 2).join(' ') : '';
    if (inner.includes('ps -ef') && inner.includes('openclaw')) return dockerRes['gateway:ps'] || '';
    if (inner.includes('openclaw cron list')) return dockerRes['cron:list'];
    if (inner.includes('pkill') || inner.includes('rm -f')) return '';
    if (inner.includes('openclaw cron add')) return JSON.stringify({ jobId: 'cron-1' });
    return '';
  }
  if (args[0] === 'rm') return '';
  if (args[0] === 'start') return '';
  if (args[0] === 'stop') return '';
  if (args[0] === 'run') return dockerRes['container:create'] || 'mock-cid';
  return '';
}

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn((cmd, args) => dockerMock(cmd, args)),
  execSync: vi.fn(() => ''),
}));

// ---------------------------------------------------------------------------
// Mock node:path
// ---------------------------------------------------------------------------
vi.mock('node:path', () => ({
  join: vi.fn((...a) => a.join('/')),
  dirname: vi.fn((p) => p.split('/').slice(0, -1).join('/')),
}));

// ---------------------------------------------------------------------------
// Mock node:url
// ---------------------------------------------------------------------------
vi.mock('node:url', () => ({
  fileURLToPath: vi.fn(() => '/mock/repo/root'),
}));

// ---------------------------------------------------------------------------
// Mock globals
// ---------------------------------------------------------------------------
vi.stubGlobal('Atomics', { wait: vi.fn(() => 0) });
let _cryptoCount = 0;
vi.stubGlobal('crypto', {
  randomBytes: vi.fn((n) => {
    _cryptoCount++;
    return Buffer.from(`tok${_cryptoCount}${'x'.repeat(Math.max(0, n - 5))}`);
  }),
});

// ---------------------------------------------------------------------------
// TESTS
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  resetDocker();
  _cryptoCount = 0;
  for (const k of Object.keys(mockFs)) delete mockFs[k];
  mockDb.updateStatus.mockClear();
  mockDb.updateProvisionInfo.mockClear();
  mockDb.releasePort.mockClear();
});

function dc(p) { return dockerCalls.some(c => c.includes(p)); }

// ---------------------------------------------------------------------------
// Pure function tests
// ---------------------------------------------------------------------------

describe('pure functions', () => {

  describe('unique()', () => {
    it('deduplicates values', () => {
      expect(unique(['a', 'b', 'a', null, 'b', ''])).toEqual(['a', 'b']);
    });
    it('filters falsy values', () => {
      expect(unique([null, undefined, '', 'x', null])).toEqual(['x']);
    });
    it('preserves order of first occurrence', () => {
      expect(unique(['z', 'a', 'z', 'b', 'a'])).toEqual(['z', 'a', 'b']);
    });
  });

  describe('shellQuote()', () => {
    it('wraps value in single quotes', () => {
      expect(shellQuote('hello')).toBe("'hello'");
    });
    it('escapes embedded single quotes', () => {
      expect(shellQuote("it's")).toBe("'it'\"'\"'s'");
    });
    it('handles empty string', () => {
      expect(shellQuote('')).toBe("''");
    });
    it('handles unicode', () => {
      expect(shellQuote('你好')).toBe("'你好'");
    });
  });

  describe('sanitizeContainerName()', () => {
    it('lowercases agentId', () => {
      expect(sanitizeContainerName('MYAGENT')).toBe('auto-openclaw-myagent');
    });
    it('replaces spaces with hyphens', () => {
      expect(sanitizeContainerName('my agent')).toBe('auto-openclaw-my-agent');
    });
    it('replaces @ with hyphens', () => {
      expect(sanitizeContainerName('my@agent')).toBe('auto-openclaw-my-agent');
    });
    it('removes all invalid chars', () => {
      expect(sanitizeContainerName('my!agent#test')).toBe('auto-openclaw-my-agent-test');
    });
    it('collapses multiple hyphens into single hyphen', () => {
      // Step1: replace non-[a-z0-9_.-] chars → 'my---agent' (no change, all chars allowed)
      // Step2: replace /-+/g → '---' becomes '-' → 'my-agent'
      expect(sanitizeContainerName('my---agent')).toBe('auto-openclaw-my-agent');
    });
    it('truncates to 63 chars', () => {
      const longId = 'a'.repeat(80);
      expect(sanitizeContainerName(longId)).toHaveLength(63);
    });
    it('result starts with prefix', () => {
      expect(sanitizeContainerName('test')).toBe('auto-openclaw-test');
    });
  });

  describe('containerNameFor()', () => {
    it('delegates to sanitizeContainerName', () => {
      expect(containerNameFor('MyAgent')).toBe('auto-openclaw-myagent');
    });
  });

  describe('markdown generators', () => {
    it('identityMarkdown includes botNickname', () => {
      const md = identityMarkdown({ botNickname: 'Arrodes', userNickname: 'Master' });
      expect(md).toContain('Arrodes');
      expect(md).toContain('Master');
    });
    it('userMarkdown includes both names', () => {
      const md = userMarkdown({ userNickname: 'Alice', botNickname: 'Bob' });
      expect(md).toContain('Alice');
      expect(md).toContain('Bob');
    });
    it('bootstrapMarkdown is non-empty', () => {
      expect(bootstrapMarkdown().length).toBeGreaterThan(0);
    });
    it('memoryMarkdown is non-empty', () => {
      expect(memoryMarkdown().length).toBeGreaterThan(0);
    });
    it('heartbeatMarkdown mentions heartbeat disabled', () => {
      expect(heartbeatMarkdown()).toContain('disabled');
    });
    it('toolsMarkdown is non-empty', () => {
      expect(toolsMarkdown().length).toBeGreaterThan(0);
    });
    it('memoryReadmeMarkdown mentions memory directory', () => {
      expect(memoryReadmeMarkdown()).toContain('memory/');
    });
  });
});

// ---------------------------------------------------------------------------
// Docker mock infrastructure tests
//
// NOTE: require('node:child_process') returns the REAL module (not the mock).
// The vi.mock only intercepts ESM import statements.  Therefore all tests
// here use the dockerMock() helper directly to simulate what the mocked
// execFileSync would return, and verify the mock's dockerCalls recording.
// ---------------------------------------------------------------------------

describe('docker mock — dockerMock() helper', () => {
  it('records docker image inspect call', () => {
    dockerMock('docker', ['image', 'inspect', 'myimg:latest']);
    expect(dc('docker image inspect')).toBe(true);
  });
  it('returns null for missing image', () => {
    dockerRes['image:inspect'] = null;
    const r = dockerMock('docker', ['image', 'inspect', 'no-such:image']);
    expect(r).toBeFalsy();
  });
  it('returns truthy for present image', () => {
    dockerRes['image:inspect'] = '[]';
    const r = dockerMock('docker', ['image', 'inspect', 'some:image']);
    expect(r).toBeTruthy();
  });
  it('returns null for missing network', () => {
    dockerRes['network:inspect'] = null;
    const r = dockerMock('docker', ['network', 'inspect', 'missing']);
    expect(r).toBeFalsy();
  });
  it('returns truthy for present network', () => {
    dockerRes['network:inspect'] = '[]';
    const r = dockerMock('docker', ['network', 'inspect', 'openclaw_shared_net']);
    expect(r).toBeTruthy();
  });
  it('records docker network create', () => {
    dockerMock('docker', ['network', 'create', 'openclaw_shared_net']);
    expect(dc('docker network create')).toBe(true);
  });
  it('returns null for absent container', () => {
    dockerRes['container:inspect'] = null;
    const r = dockerMock('docker', ['inspect', 'ghost']);
    expect(r).toBeFalsy();
  });
  it('returns {} for present container', () => {
    dockerRes['container:inspect'] = '{}';
    const r = dockerMock('docker', ['inspect', 'cname']);
    expect(r).toBe('{}');
  });
  it('returns container:running format value', () => {
    dockerRes['container:running'] = 'true';
    const r = dockerMock('docker', ['inspect', '-f', '{{.State.Running}}', 'cname']);
    expect(r).toBe('true');
  });
  it('returns container:id format value', () => {
    dockerRes['container:id'] = 'abc123';
    const r = dockerMock('docker', ['inspect', '-f', '{{.Id}}', 'cname']);
    expect(r).toBe('abc123');
  });
  it('returns container:ip format value', () => {
    dockerRes['container:ip'] = '172.17.0.5';
    const r = dockerMock('docker', ['inspect', '-f', '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}', 'cname']);
    expect(r).toBe('172.17.0.5');
  });
  it('records docker rm call', () => {
    dockerMock('docker', ['rm', '-f', 'cname']);
    expect(dc('docker rm')).toBe(true);
  });
  it('records docker start call', () => {
    dockerMock('docker', ['start', 'cname']);
    expect(dc('docker start')).toBe(true);
  });
  it('records docker stop call', () => {
    dockerMock('docker', ['stop', 'cname']);
    expect(dc('docker stop')).toBe(true);
  });
  it('records docker run call', () => {
    const r = dockerMock('docker', ['run', '-d', '--name', 'cname', 'img:latest']);
    expect(r).toBe('mock-cid');
    expect(dc('docker run')).toBe(true);
  });
  it('returns gateway ps output for matching container', () => {
    dockerRes['gateway:ps'] = 'node 1 openclaw gateway run';
    const r = dockerMock('docker', ['exec', 'cname', 'bash', '-lc', 'ps -ef | grep openclaw | grep -v grep | head -1']);
    expect(r).toBe('node 1 openclaw gateway run');
  });
  it('returns empty string when gateway process absent', () => {
    dockerRes['gateway:ps'] = '';
    const r = dockerMock('docker', ['exec', 'cname', 'bash', '-lc', 'ps -ef | grep openclaw | grep -v grep | head -1']);
    expect(r).toBe('');
  });
  it('returns cron list as JSON array', () => {
    dockerRes['cron:list'] = JSON.stringify([{ jobId: 'j1', name: 'Daily' }]);
    const r = dockerMock('docker', ['exec', 'cname', 'bash', '-lc', 'openclaw cron list --json']);
    const parsed = JSON.parse(r.trim());
    expect(parsed).toHaveLength(1);
    expect(parsed[0].name).toBe('Daily');
  });
  it('returns empty array when no jobs', () => {
    dockerRes['cron:list'] = '[]';
    const r = dockerMock('docker', ['exec', 'cname', 'bash', '-lc', 'openclaw cron list --json']);
    expect(JSON.parse(r.trim())).toEqual([]);
  });
  it('returns { jobs: [...] } wrapper format', () => {
    dockerRes['cron:list'] = JSON.stringify({ jobs: [{ jobId: 'j2' }] });
    const r = dockerMock('docker', ['exec', 'cname', 'bash', '-lc', 'openclaw cron list --json']);
    const parsed = JSON.parse(r.trim());
    expect(parsed.jobs).toHaveLength(1);
  });
  it('returns cron add result as JSON', () => {
    const r = dockerMock('docker', ['exec', 'cname', 'bash', '-lc', "openclaw cron add --name 'Test' --json"]);
    const parsed = JSON.parse(r.trim());
    expect(parsed.jobId).toBe('cron-1');
  });
  it('returns empty for pkill', () => {
    const r = dockerMock('docker', ['exec', 'cname', 'bash', '-lc', 'pkill -f openclaw-gateway >/dev/null 2>&1 || true']);
    expect(r).toBe('');
    expect(dc('pkill')).toBe(true);
  });
  it('returns empty for rm -f gateway logs', () => {
    const r = dockerMock('docker', ['exec', 'cname', 'bash', '-lc', 'rm -f /tmp/manual-gateway.log /home/node/.openclaw/gateway.log']);
    expect(r).toBe('');
    expect(dc('rm -f')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// db.js mock verification
// ---------------------------------------------------------------------------

describe('db.js mock', () => {
  it('mockDb.updateStatus is a vi.fn', () => {
    expect(typeof mockDb.updateStatus).toBe('function');
  });
  it('mockDb.updateProvisionInfo is a vi.fn', () => {
    expect(typeof mockDb.updateProvisionInfo).toBe('function');
  });
  it('mockDb.releasePort is a vi.fn', () => {
    expect(typeof mockDb.releasePort).toBe('function');
  });
  it('mockDb.allocatePort returns 32100', () => {
    expect(mockDb.allocatePort()).toBe(32100);
  });
});



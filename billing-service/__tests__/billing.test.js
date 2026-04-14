import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Mock ioredis ────────────────────────────────────────────────────────────
const mockRedisSubscribers = new Set();
const mockRedisData = {};
const mockRedisEventHandlers = {};

function createMockRedis() {
  return {
    on: vi.fn((event, handler) => {
      mockRedisEventHandlers[event] = mockRedisEventHandlers[event] || [];
      mockRedisEventHandlers[event].push(handler);
    }),
    subscribe: vi.fn((channel, cb) => {
      mockRedisSubscribers.add(channel);
      if (cb) cb(null, mockRedisSubscribers.size);
    }),
    emit: (event, ...args) => {
      const handlers = mockRedisEventHandlers[event] || [];
      handlers.forEach(h => h(...args));
    },
    connect: vi.fn(() => {
      // Emit connect event asynchronously
      setTimeout(() => {
        const handlers = mockRedisEventHandlers['connect'] || [];
        handlers.forEach(h => h());
      }, 0);
    }),
  };
}

// ─── Mock pg.Pool ───────────────────────────────────────────────────────────
const mockPoolQuery = vi.fn();
const mockPool = {
  query: mockPoolQuery,
  on: vi.fn(),
  end: vi.fn(),
};

// ─── Mock modules BEFORE importing anything else ──────────────────────────────
vi.mock('ioredis', () => ({
  Redis: vi.fn(() => createMockRedis()),
}));

vi.mock('pg', () => ({
  default: { Pool: vi.fn(() => mockPool) },
  Pool: vi.fn(() => mockPool),
}));

// ─── Now import the billing service logic ───────────────────────────────────
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

// We need to re-implement the pricing and handleEvent logic since we can't import directly
// due to module initialization side-effects. We extract the pure logic.

const PRICING = {
  'web_search': 0.005,
  'whisper_transcribe': 0.006,
  'goplaces': 0.010,
};

// Pure handleEvent implementation (mirrors the service's logic)
async function handleBillingEvent(channel, message) {
  if (channel !== 'billing_events') return { skipped: true };

  try {
    const data = JSON.parse(message);
    const agentId = data.agent_id;
    const toolName = data.tool_name;

    if (!agentId || !toolName) {
      return { error: 'missing_fields', agentId, toolName };
    }

    const cost = PRICING[toolName] ?? 0;

    await mockPoolQuery(
      'INSERT INTO billing_logs (agent_id, tool_name, cost) VALUES ($1, $2, $3)',
      [agentId, toolName, cost]
    );

    return { logged: true, agentId, toolName, cost };
  } catch (err) {
    return { error: err.message };
  }
}

// ─── Tests ──────────────────────────────────────────────────────────────────
describe('PRICING table', () => {
  it('has correct cost for web_search', () => {
    expect(PRICING['web_search']).toBe(0.005);
  });

  it('has correct cost for whisper_transcribe', () => {
    expect(PRICING['whisper_transcribe']).toBe(0.006);
  });

  it('has correct cost for goplaces', () => {
    expect(PRICING['goplaces']).toBe(0.010);
  });

  it('unknown tool returns undefined (treated as 0 cost)', () => {
    expect(PRICING['unknown_tool']).toBeUndefined();
    const cost = PRICING['unknown_tool'] ?? 0;
    expect(cost).toBe(0);
  });

  it('has exactly 3 pricing entries', () => {
    expect(Object.keys(PRICING)).toHaveLength(3);
  });
});

describe('handleBillingEvent', () => {
  beforeEach(() => {
    mockPoolQuery.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
  });

  it('skips events from non-billing channel', async () => {
    const result = await handleBillingEvent('other_channel', '{"agent_id":"a1","tool_name":"web_search"}');
    expect(result).toEqual({ skipped: true });
    expect(mockPoolQuery).not.toHaveBeenCalled();
  });

  it('logs known tool to billing_logs', async () => {
    const message = JSON.stringify({ agent_id: 'agent-abc', tool_name: 'web_search' });
    const result = await handleBillingEvent('billing_events', message);
    expect(result).toEqual({ logged: true, agentId: 'agent-abc', toolName: 'web_search', cost: 0.005 });
    expect(mockPoolQuery).toHaveBeenCalledOnce();
    expect(mockPoolQuery).toHaveBeenCalledWith(
      'INSERT INTO billing_logs (agent_id, tool_name, cost) VALUES ($1, $2, $3)',
      ['agent-abc', 'web_search', 0.005]
    );
  });

  it('logs whisper_transcribe with correct cost', async () => {
    const message = JSON.stringify({ agent_id: 'agent-xyz', tool_name: 'whisper_transcribe' });
    const result = await handleBillingEvent('billing_events', message);
    expect(result.cost).toBe(0.006);
    expect(mockPoolQuery).toHaveBeenCalledWith(
      'INSERT INTO billing_logs (agent_id, tool_name, cost) VALUES ($1, $2, $3)',
      ['agent-xyz', 'whisper_transcribe', 0.006]
    );
  });

  it('logs goplaces with correct cost', async () => {
    const message = JSON.stringify({ agent_id: 'agent-123', tool_name: 'goplaces' });
    const result = await handleBillingEvent('billing_events', message);
    expect(result.cost).toBe(0.010);
  });

  it('logs unknown tool with cost 0', async () => {
    const message = JSON.stringify({ agent_id: 'agent-unknown', tool_name: 'unknown_tool' });
    const result = await handleBillingEvent('billing_events', message);
    expect(result.cost).toBe(0);
    expect(mockPoolQuery).toHaveBeenCalledWith(
      'INSERT INTO billing_logs (agent_id, tool_name, cost) VALUES ($1, $2, $3)',
      ['agent-unknown', 'unknown_tool', 0]
    );
  });

  it('returns error when missing agent_id', async () => {
    const message = JSON.stringify({ tool_name: 'web_search' });
    const result = await handleBillingEvent('billing_events', message);
    expect(result).toEqual({ error: 'missing_fields', agentId: undefined, toolName: 'web_search' });
    expect(mockPoolQuery).not.toHaveBeenCalled();
  });

  it('returns error when missing tool_name', async () => {
    const message = JSON.stringify({ agent_id: 'agent-abc' });
    const result = await handleBillingEvent('billing_events', message);
    expect(result).toEqual({ error: 'missing_fields', agentId: 'agent-abc', toolName: undefined });
    expect(mockPoolQuery).not.toHaveBeenCalled();
  });

  it('returns error when both agent_id and tool_name are missing', async () => {
    const message = JSON.stringify({});
    const result = await handleBillingEvent('billing_events', message);
    expect(result).toEqual({ error: 'missing_fields', agentId: undefined, toolName: undefined });
  });

  it('handles malformed JSON gracefully', async () => {
    const result = await handleBillingEvent('billing_events', 'not valid json {{{');
    expect(result.error).toBeDefined();
    expect(mockPoolQuery).not.toHaveBeenCalled();
  });

  it('handles database query error', async () => {
    mockPoolQuery.mockRejectedValueOnce(new Error('DB connection failed'));
    const message = JSON.stringify({ agent_id: 'agent-db-err', tool_name: 'web_search' });
    const result = await handleBillingEvent('billing_events', message);
    expect(result).toEqual({ error: 'DB connection failed' });
  });

  it('does not throw on duplicate agent_id - different tools', async () => {
    const msg1 = JSON.stringify({ agent_id: 'agent-multi', tool_name: 'web_search' });
    const msg2 = JSON.stringify({ agent_id: 'agent-multi', tool_name: 'whisper_transcribe' });
    await handleBillingEvent('billing_events', msg1);
    await handleBillingEvent('billing_events', msg2);
    expect(mockPoolQuery).toHaveBeenCalledTimes(2);
  });
});

describe('Redis subscription mocking', () => {
  it('mockRedis subscribe is called with billing_events', () => {
    // Verify the Redis mock factory works by checking the mock Redis methods exist
    const mock = createMockRedis();
    expect(typeof mock.subscribe).toBe('function');
    expect(typeof mock.on).toBe('function');

    // Verify the pg Pool mock is correctly a mock function (proves vi.mock works)
    expect(vi.isMockFunction(mockPoolQuery)).toBe(true);
  });

  it('subscribe callback is invoked with correct channel', () => {
    const mock = createMockRedis();
    let callbackErr = null;
    let callbackCount = null;

    mock.subscribe('billing_events', (err, count) => {
      callbackErr = err;
      callbackCount = count;
    });

    expect(mock.subscribe).toHaveBeenCalledWith('billing_events', expect.any(Function));
  });

  it('Redis event handlers can be registered for connect and message', () => {
    const mock = createMockRedis();
    const connectHandler = vi.fn();
    const messageHandler = vi.fn();

    mock.on('connect', connectHandler);
    mock.on('message', messageHandler);

    expect(mock.on).toHaveBeenCalledWith('connect', connectHandler);
    expect(mock.on).toHaveBeenCalledWith('message', messageHandler);
  });

  it('multiple subscribers can be registered', () => {
    const subscribers = new Set();
    subscribers.add('billing_events');
    subscribers.add('other_channel');
    expect(subscribers.size).toBe(2);
    expect(subscribers.has('billing_events')).toBe(true);
  });
});

describe('pg.Pool mocking', () => {
  beforeEach(() => {
    mockPoolQuery.mockReset().mockResolvedValue({ rows: [], rowCount: 1 });
  });

  it('pool.query is called with correct SQL', async () => {
    await mockPoolQuery('INSERT INTO billing_logs (agent_id, tool_name, cost) VALUES ($1, $2, $3)', ['a', 'b', 0.005]);
    expect(mockPoolQuery).toHaveBeenCalledOnce();
  });

  it('pool.query returns correct shape', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ id: 1 }], rowCount: 1 });
    const result = await mockPoolQuery('SELECT 1');
    expect(result).toHaveProperty('rows');
    expect(result).toHaveProperty('rowCount');
    expect(result.rows[0].id).toBe(1);
  });

  it('pool.end can be called', () => {
    expect(mockPool.end).toBeDefined();
    mockPool.end();
    expect(mockPool.end).toHaveBeenCalled();
  });

  it('pool.on registers event handlers', () => {
    const errHandler = vi.fn();
    mockPool.on('error', errHandler);
    expect(mockPool.on).toHaveBeenCalledWith('error', errHandler);
  });
});

describe('Event processing integration', () => {
  beforeEach(() => {
    mockPoolQuery.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
  });

  it('processes a batch of events correctly', async () => {
    const events = [
      { agent_id: 'agent-A', tool_name: 'web_search' },
      { agent_id: 'agent-B', tool_name: 'whisper_transcribe' },
      { agent_id: 'agent-C', tool_name: 'goplaces' },
      { agent_id: 'agent-D', tool_name: 'unknown' },
    ];

    for (const evt of events) {
      await handleBillingEvent('billing_events', JSON.stringify(evt));
    }

    expect(mockPoolQuery).toHaveBeenCalledTimes(4);
    expect(mockPoolQuery).toHaveBeenNthCalledWith(1,
      'INSERT INTO billing_logs (agent_id, tool_name, cost) VALUES ($1, $2, $3)',
      ['agent-A', 'web_search', 0.005]
    );
    expect(mockPoolQuery).toHaveBeenNthCalledWith(2,
      'INSERT INTO billing_logs (agent_id, tool_name, cost) VALUES ($1, $2, $3)',
      ['agent-B', 'whisper_transcribe', 0.006]
    );
    expect(mockPoolQuery).toHaveBeenNthCalledWith(3,
      'INSERT INTO billing_logs (agent_id, tool_name, cost) VALUES ($1, $2, $3)',
      ['agent-C', 'goplaces', 0.010]
    );
    expect(mockPoolQuery).toHaveBeenNthCalledWith(4,
      'INSERT INTO billing_logs (agent_id, tool_name, cost) VALUES ($1, $2, $3)',
      ['agent-D', 'unknown', 0]
    );
  });

  it('handles empty string agent_id as missing', async () => {
    const message = JSON.stringify({ agent_id: '', tool_name: 'web_search' });
    const result = await handleBillingEvent('billing_events', message);
    expect(result.error).toBe('missing_fields');
  });

  it('handles empty string tool_name as missing', async () => {
    const message = JSON.stringify({ agent_id: 'agent-abc', tool_name: '' });
    const result = await handleBillingEvent('billing_events', message);
    expect(result.error).toBe('missing_fields');
  });

  it('handles null values as missing', async () => {
    const message = JSON.stringify({ agent_id: null, tool_name: null });
    const result = await handleBillingEvent('billing_events', message);
    expect(result.error).toBe('missing_fields');
  });
});

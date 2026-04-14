import { Redis } from 'ioredis';
import pkg from 'pg';
const { Pool } = pkg;
import dotenv from 'dotenv';

dotenv.config();

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://litellm:litellm_pass@localhost:5432/litellm';

const redisSubscriber = new Redis(REDIS_URL);
const pool = new Pool({ connectionString: DATABASE_URL });

// Static pricing table (in a real app, this might come from a DB or Config API)
const PRICING = {
  'web_search': 0.005,
  'whisper_transcribe': 0.006,
  'goplaces': 0.010,
};

async function initDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS billing_logs (
        id SERIAL PRIMARY KEY,
        agent_id VARCHAR(255) NOT NULL,
        tool_name VARCHAR(100) NOT NULL,
        cost NUMERIC(10, 5) NOT NULL,
        timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log('✅ Billing DB initialized.');
  } catch (err) {
    console.error('❌ Failed to initialize DB:', err);
  }
}

async function handleEvent(channel, message) {
  if (channel !== 'billing_events') return;

  try {
    const data = JSON.parse(message);
    const agentId = data.agent_id;
    const toolName = data.tool_name;

    if (!agentId || !toolName) return;

    const cost = PRICING[toolName] || 0;
    
    // Even if cost is 0, we log it for audit purposes
    await pool.query(
      'INSERT INTO billing_logs (agent_id, tool_name, cost) VALUES ($1, $2, $3)',
      [agentId, toolName, cost]
    );
    console.log(`💰 Logged: ${agentId} used ${toolName} (Cost: $${cost})`);

  } catch (err) {
    console.error('❌ Error processing event:', err);
  }
}

redisSubscriber.on('connect', () => {
  console.log('✅ Billing Service connected to Redis (Subscriber)');
  redisSubscriber.subscribe('billing_events', (err, count) => {
    if (err) {
      console.error('Failed to subscribe: %s', err.message);
    } else {
      console.log(`Subscribed successfully! This client is currently subscribed to ${count} channels.`);
    }
  });
});

redisSubscriber.on('message', handleEvent);

redisSubscriber.on('error', (err) => {
  console.error('❌ Redis connection error:', err);
});

// Startup
console.log('🚀 Starting Billing Service...');
initDB();

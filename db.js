/**
 * db.js — SQLite database layer (v4).
 *
 * Schema supports: per-user Feishu bot credentials, admin-managed OpenAI keys,
 * Docker container metadata, port pool, and instance lifecycle states.
 */
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// TEST_DB_PATH env var enables integration test mode with isolated DB file
const DB_PATH = process.env.TEST_DB_PATH ?? join(__dirname, 'data', 'openclaw_users.db');
mkdirSync(dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    user_nickname     TEXT    NOT NULL,
    bot_nickname      TEXT    NOT NULL,
    agent_id          TEXT    UNIQUE NOT NULL,
    port              INTEGER UNIQUE,
    workspace_dir     TEXT,
    agent_dir         TEXT,
    container_name    TEXT,
    container_id      TEXT,
    image_name        TEXT,
    gateway_token     TEXT,
    feishu_app_id     TEXT,
    feishu_app_secret TEXT,
    feishu_open_id    TEXT,
    feishu_domain     TEXT    DEFAULT 'feishu',
    device_code       TEXT,
    openai_api_key    TEXT,
    status            TEXT    DEFAULT 'pending_scan',
    pid               INTEGER,
    created_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
    auth_mode         TEXT    DEFAULT 'openai-api-key',
    budget            REAL    DEFAULT 20.0
  );

  CREATE TABLE IF NOT EXISTS port_pool (
    port    INTEGER PRIMARY KEY,
    in_use  INTEGER DEFAULT 0,
    user_id INTEGER REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS instance_events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER,
    agent_id   TEXT,
    event_type TEXT NOT NULL,
    title      TEXT NOT NULL,
    detail     TEXT,
    severity   TEXT DEFAULT 'info',
    actor      TEXT DEFAULT 'system',
    metadata   TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

function ensureColumn(table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some((col) => col.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

ensureColumn('users', 'container_name', 'TEXT');
ensureColumn('users', 'container_id', 'TEXT');
ensureColumn('users', 'image_name', 'TEXT');
ensureColumn('users', 'gateway_token', 'TEXT');
ensureColumn('users', 'auth_mode', 'TEXT DEFAULT "openai-api-key"');
ensureColumn('users', 'budget', 'REAL DEFAULT 20.0');

function migrateUsersPortNullable() {
  const columns = db.prepare('PRAGMA table_info(users)').all();
  const portCol = columns.find((col) => col.name === 'port');
  if (!portCol || portCol.notnull === 0) return;

  db.pragma('foreign_keys = OFF');
  try {
    db.exec(`
      ALTER TABLE users RENAME TO users_old;

      CREATE TABLE users (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        user_nickname     TEXT    NOT NULL,
        bot_nickname      TEXT    NOT NULL,
        agent_id          TEXT    UNIQUE NOT NULL,
        port              INTEGER UNIQUE,
        workspace_dir     TEXT,
        agent_dir         TEXT,
        container_name    TEXT,
        container_id      TEXT,
        image_name        TEXT,
        gateway_token     TEXT,
        feishu_app_id     TEXT,
        feishu_app_secret TEXT,
        feishu_open_id    TEXT,
        feishu_domain     TEXT    DEFAULT 'feishu',
        device_code       TEXT,
        openai_api_key    TEXT,
        status            TEXT    DEFAULT 'pending_scan',
        pid               INTEGER,
        created_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
        auth_mode         TEXT    DEFAULT 'openai-api-key',
        budget            REAL    DEFAULT 20.0
      );

      INSERT INTO users (
        id, user_nickname, bot_nickname, agent_id, port, workspace_dir, agent_dir,
        container_name, container_id, image_name, gateway_token,
        feishu_app_id, feishu_app_secret, feishu_open_id, feishu_domain,
        device_code, openai_api_key, status, pid, created_at, updated_at,
        auth_mode, budget
      )
      SELECT
        id, user_nickname, bot_nickname, agent_id,
        CASE WHEN port = 0 THEN NULL ELSE port END,
        workspace_dir, agent_dir, container_name, container_id, image_name, gateway_token,
        feishu_app_id, feishu_app_secret, feishu_open_id, feishu_domain,
        device_code, openai_api_key, status, pid, created_at, updated_at,
        COALESCE(auth_mode, 'openai-api-key'), COALESCE(budget, 20.0)
      FROM users_old;

      DROP TABLE users_old;
    `);

    db.exec(`
      UPDATE port_pool
      SET in_use = 0, user_id = NULL
      WHERE user_id IS NOT NULL
        AND user_id NOT IN (SELECT id FROM users);
    `);
  } finally {
    db.pragma('foreign_keys = ON');
  }
}

migrateUsersPortNullable();

function migratePortPoolForeignKey() {
  const fk = db.prepare('PRAGMA foreign_key_list(port_pool)').all();
  if (!fk.length || fk.every((row) => row.table === 'users')) return;

  db.pragma('foreign_keys = OFF');
  try {
    db.exec(`
      ALTER TABLE port_pool RENAME TO port_pool_old;
      CREATE TABLE port_pool (
        port    INTEGER PRIMARY KEY,
        in_use  INTEGER DEFAULT 0,
        user_id INTEGER REFERENCES users(id)
      );
      INSERT INTO port_pool (port, in_use, user_id)
      SELECT port, in_use, user_id FROM port_pool_old;
      DROP TABLE port_pool_old;
    `);
  } finally {
    db.pragma('foreign_keys = ON');
  }
}

migratePortPoolForeignKey();

// ---------------------------------------------------------------------------
// Port pool — seed 19100-19199
// ---------------------------------------------------------------------------
const PORT_START = 19100;
const PORT_END = 19199;

const poolCount = db.prepare('SELECT COUNT(*) AS cnt FROM port_pool').get();
if (poolCount.cnt === 0) {
  const insert = db.prepare('INSERT INTO port_pool (port) VALUES (?)');
  const tx = db.transaction(() => {
    for (let p = PORT_START; p <= PORT_END; p++) insert.run(p);
  });
  tx();
}

// ---------------------------------------------------------------------------
// Port helpers
// ---------------------------------------------------------------------------
export function allocatePort(userId) {
  return db.transaction(() => {
    const row = db.prepare('SELECT port FROM port_pool WHERE in_use = 0 ORDER BY port LIMIT 1').get();
    if (!row) throw new Error('No available ports');
    db.prepare('UPDATE port_pool SET in_use = 1, user_id = ? WHERE port = ?').run(userId, row.port);
    return row.port;
  })();
}

export function releasePort(port) {
  if (!port) return;
  db.prepare('UPDATE port_pool SET in_use = 0, user_id = NULL WHERE port = ?').run(port);
}

// ---------------------------------------------------------------------------
// User CRUD
// ---------------------------------------------------------------------------
export function createUser(data) {
  const info = db.prepare(`
    INSERT INTO users (user_nickname, bot_nickname, agent_id, port, device_code, status)
    VALUES (@userNickname, @botNickname, @agentId, @port, @deviceCode, @status)
  `).run({
    ...data,
    port: data.port ?? null,
  });
  return { id: info.lastInsertRowid, ...data, port: data.port ?? null };
}

export function updateFeishuCredentials(id, { appId, appSecret, openId, domain }) {
  db.prepare(`
    UPDATE users SET feishu_app_id = ?, feishu_app_secret = ?, feishu_open_id = ?,
    feishu_domain = ?, device_code = NULL, status = 'pending_activation', updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(appId, appSecret, openId, domain, id);
}

export function updateOpenAIKey(id, key) {
  db.prepare('UPDATE users SET openai_api_key = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(key, id);
}

export function updateBudget(id, budget) {
  db.prepare('UPDATE users SET budget = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(budget, id);
}

export function updateStatus(id, status) {
  db.prepare('UPDATE users SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(status, id);
}

export function updateProvisionInfo(id, { workspaceDir, agentDir, containerName, containerId, imageName, gatewayToken }) {
  db.prepare(`
    UPDATE users
    SET workspace_dir = ?,
        agent_dir = ?,
        container_name = ?,
        container_id = ?,
        image_name = ?,
        gateway_token = ?,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(
    workspaceDir ?? null,
    agentDir ?? null,
    containerName ?? null,
    containerId ?? null,
    imageName ?? null,
    gatewayToken ?? null,
    id,
  );
}

export function updatePid(id, pid, status) {
  db.prepare('UPDATE users SET pid = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(pid, status, id);
}

export function updateContainerInfo(id, { containerId, containerName, imageName }) {
  db.prepare(`
    UPDATE users
    SET container_id = COALESCE(?, container_id),
        container_name = COALESCE(?, container_name),
        image_name = COALESCE(?, image_name),
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(containerId ?? null, containerName ?? null, imageName ?? null, id);
}

export function getUserById(id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

export function getUserByAgentId(agentId) {
  return db.prepare('SELECT * FROM users WHERE agent_id = ?').get(agentId);
}

export function deleteUser(id) {
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
}

export function getAllUsers() {
  return db.prepare('SELECT * FROM users ORDER BY created_at DESC').all();
}

export function updateAuthMode(id, authMode) {
  return db.prepare('UPDATE users SET auth_mode = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(authMode, id);
}

export function addInstanceEvent({ userId = null, agentId = null, eventType, title, detail = null, severity = 'info', actor = 'system', metadata = null }) {
  const metadataText = metadata == null ? null : JSON.stringify(metadata);
  const info = db.prepare(`
    INSERT INTO instance_events (user_id, agent_id, event_type, title, detail, severity, actor, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(userId, agentId, eventType, title, detail, severity, actor, metadataText);
  return { id: info.lastInsertRowid, userId, agentId, eventType, title, detail, severity, actor, metadata };
}

export function getInstanceEvents(userId, limit = 100) {
  const rows = db.prepare(`
    SELECT * FROM instance_events
    WHERE user_id = ?
    ORDER BY datetime(created_at) DESC, id DESC
    LIMIT ?
  `).all(userId, limit);
  return rows.map((row) => ({
    ...row,
    metadata: row.metadata ? (() => { try { return JSON.parse(row.metadata); } catch { return null; } })() : null,
  }));
}

export const dbHandle = db;
export default db;

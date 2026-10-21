// Storage for accounts + each user's saved state.
//  * DATABASE_URL set (Railway / Neon / Supabase Postgres)  -> Postgres (survives redeploys, handles many users)
//  * otherwise                                              -> the old JSON files under server/data (fine for running locally)
// Every function is async so the rest of the server does not care which one is active.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATABASE_URL = process.env.DATABASE_URL || '';
export const dbMode = DATABASE_URL ? 'postgres' : 'files';

let pool = null;
let ready = null;
async function pg() {
  if (!pool) {
    const { default: pgmod } = await import('pg');
    const local = /localhost|127\.0\.0\.1/.test(DATABASE_URL);
    pool = new pgmod.Pool({ connectionString: DATABASE_URL, max: 10, ssl: local || process.env.PGSSL === 'disable' ? false : { rejectUnauthorized: false } });
    pool.on('error', (e) => console.warn('[db] pool error:', e.message));
  }
  if (!ready) {
    ready = pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id text PRIMARY KEY,
        email text UNIQUE NOT NULL,
        password_hash text NOT NULL,
        created_at bigint NOT NULL
      );
      CREATE TABLE IF NOT EXISTS user_state (
        user_id text PRIMARY KEY,
        state jsonb NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now()
      );`).catch((e) => { ready = null; throw e; });
  }
  await ready;
  return pool;
}
const rowToUser = (r) => (r ? { id: r.id, email: r.email, passwordHash: r.password_hash, createdAt: Number(r.created_at) } : null);

// ---------------- file mode ----------------
const DATA_DIR = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const LEGACY_USERS_FILE = path.join(__dirname, 'users.json');
if (dbMode === 'files') {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(USERS_FILE)) {
    if (fs.existsSync(LEGACY_USERS_FILE)) fs.copyFileSync(LEGACY_USERS_FILE, USERS_FILE);
    else fs.writeFileSync(USERS_FILE, '[]', 'utf8');
  }
}
function readUsers() {
  try { const parsed = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); return Array.isArray(parsed) ? parsed : []; } catch { return []; }
}
const writeUsers = (users) => fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), 'utf8');
const stateFilePath = (userId) => path.join(DATA_DIR, `${userId}.json`);

// ---------------- public API ----------------
export async function findUserByEmail(email) {
  const normalized = email.trim().toLowerCase();
  if (dbMode === 'postgres') return rowToUser((await (await pg()).query('SELECT * FROM users WHERE email = $1', [normalized])).rows[0]);
  return readUsers().find((u) => u.email === normalized) || null;
}

export async function findUserById(id) {
  if (dbMode === 'postgres') return rowToUser((await (await pg()).query('SELECT * FROM users WHERE id = $1', [id])).rows[0]);
  return readUsers().find((u) => u.id === id) || null;
}

export async function createUser({ id, email, passwordHash, createdAt }) {
  const e = email.trim().toLowerCase();
  if (dbMode === 'postgres') {
    try { await (await pg()).query('INSERT INTO users (id, email, password_hash, created_at) VALUES ($1,$2,$3,$4)', [id, e, passwordHash, createdAt]); }
    catch (err) { if (err.code === '23505') { const dup = new Error('duplicate email'); dup.code = 'DUP'; throw dup; } throw err; }
    return { id, email: e, passwordHash, createdAt };
  }
  const users = readUsers();
  const user = { id, email: e, passwordHash, createdAt };
  users.push(user);
  writeUsers(users);
  return user;
}

export async function readState(userId) {
  if (dbMode === 'postgres') return (await (await pg()).query('SELECT state FROM user_state WHERE user_id = $1', [userId])).rows[0]?.state ?? null;
  const file = stateFilePath(userId);
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

export async function writeState(userId, state) {
  if (dbMode === 'postgres') {
    await (await pg()).query('INSERT INTO user_state (user_id, state, updated_at) VALUES ($1,$2,now()) ON CONFLICT (user_id) DO UPDATE SET state = EXCLUDED.state, updated_at = now()', [userId, JSON.stringify(state)]);
    return;
  }
  fs.writeFileSync(stateFilePath(userId), JSON.stringify(state), 'utf8');
}

// Optional: copy the existing local files into Postgres (run once:  DATABASE_URL=... node migrate-to-postgres.js)
export async function _pgForMigration() { return pg(); }

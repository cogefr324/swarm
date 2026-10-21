// One-time: copy the accounts + saved states from the local JSON files (server/data) into Postgres.
//   DATABASE_URL=postgres://... node migrate-to-postgres.js
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { _pgForMigration } from './db.js';

if (!process.env.DATABASE_URL) { console.error('Set DATABASE_URL first.'); process.exit(1); }
const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data');
const pool = await _pgForMigration();
let users = [];
try { users = JSON.parse(fs.readFileSync(path.join(DIR, 'users.json'), 'utf8')); } catch { /* none */ }
let u = 0, st = 0;
for (const x of users) {
  await pool.query('INSERT INTO users (id, email, password_hash, created_at) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING', [x.id, x.email, x.passwordHash, x.createdAt || Date.now()]);
  u++;
  const f = path.join(DIR, `${x.id}.json`);
  if (fs.existsSync(f)) { await pool.query('INSERT INTO user_state (user_id, state) VALUES ($1,$2) ON CONFLICT (user_id) DO NOTHING', [x.id, fs.readFileSync(f, 'utf8')]); st++; }
}
console.log(`Copied ${u} accounts and ${st} saved states.`);
await pool.end();

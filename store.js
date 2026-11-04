// Persistence: Postgres when DATABASE_URL is set (e.g. Neon free tier), otherwise a local JSON file.
// The whole ledger is small, so it is kept as one JSON document.
'use strict';
const fs = require('fs');
const path = require('path');

module.exports = async function makeStore() {
  const url = process.env.DATABASE_URL;
  if (url) {
    const { Pool } = require('pg');
    const local = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
    const pool = new Pool({ connectionString: url, ssl: local ? false : { rejectUnauthorized: false }, max: 3, idleTimeoutMillis: 30000 });
    pool.on('error', e => console.error('[db] idle client error:', e.message));
    await pool.query('create table if not exists holdem_kv (k text primary key, v jsonb not null, updated_at timestamptz not null default now())');
    return {
      kind: 'postgres',
      async load() { const r = await pool.query("select v from holdem_kv where k = 'main'"); return r.rows[0] ? r.rows[0].v : null; },
      async save(obj) {
        await pool.query("insert into holdem_kv (k, v) values ('main', $1::jsonb) on conflict (k) do update set v = excluded.v, updated_at = now()", [JSON.stringify(obj)]);
      },
    };
  }
  const file = process.env.DATA_FILE || path.join(__dirname, 'data.json');
  return {
    kind: 'file:' + file,
    async load() { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } },
    async save(obj) { const tmp = file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(obj)); fs.renameSync(tmp, file); },
  };
};

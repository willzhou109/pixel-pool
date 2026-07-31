/* User storage for Pixel Pool Online.
 *
 * Uses Node's built-in SQLite (node:sqlite) so there is no native dependency to
 * compile or install — the whole backend runs on Node built-ins alone. The DB
 * file lives in server/data/ (gitignored). Only password *hashes* are ever
 * stored here; plaintext passwords never touch the disk.
 */
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'pool.db'));
db.exec('PRAGMA journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

// Google-linked accounts (added after the table above shipped). SQLite has no
// ADD COLUMN IF NOT EXISTS, so probe first — this makes the migration safe to
// run against both brand-new and already-deployed databases. Google accounts
// still get a password_hash (a random, unusable one — see auth.js), so this
// column stays the only schema change: no NOT NULL constraint to relax.
const userCols = db.prepare('PRAGMA table_info(users)').all();
if (!userCols.some(c => c.name === 'google_id')) {
  db.exec('ALTER TABLE users ADD COLUMN google_id TEXT');
}
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google_id ON users(google_id) WHERE google_id IS NOT NULL');

// Prepared statements — parameterized, so user input can never be interpolated
// into SQL (no injection surface).
const insertUser = db.prepare(
  'INSERT INTO users (username, password_hash) VALUES (?, ?)'
);
const selectByName = db.prepare(
  'SELECT id, username, password_hash, created_at FROM users WHERE username = ?'
);
const selectByGoogleId = db.prepare(
  'SELECT id, username, password_hash, created_at, google_id FROM users WHERE google_id = ?'
);
const insertGoogleUser = db.prepare(
  'INSERT INTO users (username, password_hash, google_id) VALUES (?, ?, ?)'
);

module.exports = {
  /** Insert a new user. Throws if the username already exists (UNIQUE). */
  createUser(username, passwordHash) {
    return insertUser.run(username, passwordHash);
  },
  /** Look a user up by name (case-insensitive). Returns undefined if none. */
  findUser(username) {
    return selectByName.get(username);
  },
  /** Look a user up by their linked Google account id (the JWT's `sub`). */
  findUserByGoogleId(googleId) {
    return selectByGoogleId.get(googleId);
  },
  /** Create a user provisioned from Google sign-in. `passwordHash` is a
   * random, never-typed placeholder — see auth.js's googleLogin. */
  createGoogleUser(username, passwordHash, googleId) {
    return insertGoogleUser.run(username, passwordHash, googleId);
  },
  /** Raw handle so feature modules (e.g. history.js) can own their own tables. */
  db,
};

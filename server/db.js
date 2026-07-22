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

// Prepared statements — parameterized, so user input can never be interpolated
// into SQL (no injection surface).
const insertUser = db.prepare(
  'INSERT INTO users (username, password_hash) VALUES (?, ?)'
);
const selectByName = db.prepare(
  'SELECT id, username, password_hash, created_at FROM users WHERE username = ?'
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
};

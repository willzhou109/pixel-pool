/* Profile avatars for Pixel Pool Online.
 *
 * An avatar is just an emoji on a colored tile — no file uploads, so nothing to
 * store on disk, validate as an image, or moderate: each choice is a tiny pair
 * of strings picked from fixed server-side allowlists. Owns the `avatars` table
 * (username -> {emoji, color}); unset players fall back to DEFAULT.
 *
 * server.js routes:
 *   GET  /api/avatar/options  -> the pickable emojis + colors (no auth; static)
 *   POST /api/avatar          -> set the signed-in player's avatar { emoji, color }
 * and composes getAvatar() into GET /api/me so every client can render it.
 *
 * The client picker (js/avatarpicker.js) fetches /api/avatar/options rather than
 * hard-coding the palette, so the allowlists here stay the single source of truth.
 */
'use strict';

const { db } = require('./db');
const { verifyToken } = require('./auth');

// Pickable palette — the ONLY values a stored avatar may hold. Keep these as the
// single source of truth (the client fetches them via /api/avatar/options).
const EMOJIS = [
  '🎱', '🎯', '🏆', '🔥', '⚡', '🌟', '💎', '🎮',
  '🐱', '🐶', '🦊', '🐸', '🐼', '🐯', '🦁', '🐨',
  '🦈', '🐲', '🤖', '👾', '👽', '😎', '😈', '👑',
  '🍄', '🌈', '🚀', '💀',
];
const COLORS = [
  '#2f6f47', '#2a5ca8', '#7a5230', '#c0392b',
  '#8e44ad', '#d68910', '#16a085', '#34404f',
];
const DEFAULT = { emoji: EMOJIS[0], color: COLORS[0] };

db.exec(`
  CREATE TABLE IF NOT EXISTS avatars (
    username   TEXT PRIMARY KEY COLLATE NOCASE,
    emoji      TEXT NOT NULL,
    color      TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

const selAvatar = db.prepare('SELECT emoji, color FROM avatars WHERE username = ?');
const upsertAvatar = db.prepare(`
  INSERT INTO avatars (username, emoji, color, updated_at)
  VALUES (?, ?, ?, datetime('now'))
  ON CONFLICT(username) DO UPDATE SET
    emoji = excluded.emoji, color = excluded.color, updated_at = datetime('now')
`);

/** The stored avatar for `username`, or DEFAULT if they've never set one. */
function getAvatar(username) {
  const row = selAvatar.get(username);
  return row ? { emoji: row.emoji, color: row.color } : { ...DEFAULT };
}

/** The pickable palette — served to the client so it never hard-codes it. */
function options() {
  return { status: 200, body: { emojis: EMOJIS, colors: COLORS, default: DEFAULT } };
}

/** Set the signed-in player's avatar. Rejects anything off the allowlists. */
function set(token, body) {
  const username = verifyToken(token);
  if (!username) return { status: 401, body: { error: 'Not signed in.' } };
  const emoji = body && body.emoji;
  const color = body && body.color;
  if (!EMOJIS.includes(emoji) || !COLORS.includes(color)) {
    return { status: 400, body: { error: 'Pick an emoji and color from the options.' } };
  }
  upsertAvatar.run(username, emoji, color);
  return { status: 200, body: { avatar: { emoji, color } } };
}

module.exports = { getAvatar, options, set, DEFAULT };

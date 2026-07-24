/* Direct-message chat storage for Pixel Pool Online.
 *
 * Owns the `messages` table: one row per DM between two users. Messages are
 * delivered live over Socket.IO (see social.js) and persisted here so a
 * conversation survives reconnects and reloads; server.js routes the history
 * read (GET /api/messages/:username) to conversation() below.
 *
 * saveMessage() is called from the socket 'dm' handler and returns the stored
 * row (with its id + timestamp) so the same object can be echoed to both
 * parties — no separate read needed.
 */
'use strict';

const { db } = require('./db');
const { verifyToken } = require('./auth');
const { areFriends } = require('./friends');

db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    sender     TEXT NOT NULL COLLATE NOCASE,
    recipient  TEXT NOT NULL COLLATE NOCASE,
    body       TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);
// Conversations are read by (sender, recipient) pairs both ways, ordered by id.
db.exec('CREATE INDEX IF NOT EXISTS idx_messages_pair ON messages (sender, recipient, id)');

const insMsg = db.prepare(
  'INSERT INTO messages (sender, recipient, body) VALUES (?, ?, ?)'
);
const selById = db.prepare(
  'SELECT id, sender, recipient, body, created_at FROM messages WHERE id = ?'
);
const selConversation = db.prepare(
  `SELECT id, sender, recipient, body, created_at FROM messages
   WHERE (sender = ? AND recipient = ?) OR (sender = ? AND recipient = ?)
   ORDER BY id ASC LIMIT 300`
);

const MAX_BODY = 500;

function toDto(r) {
  return { id: r.id, from: r.sender, to: r.recipient, text: r.body, at: r.created_at };
}

/** Persist a DM and return its stored form. Body is trimmed/capped by caller. */
function saveMessage(from, to, body) {
  const text = String(body || '').slice(0, MAX_BODY);
  const { lastInsertRowid } = insMsg.run(from, to, text);
  return toDto(selById.get(lastInsertRowid));
}

/* ------------------------------ REST handler ----------------------------- */
// GET /api/messages/:username — the signed-in player's conversation with that
// user, oldest first. Only friends can hold a conversation, matching the DM
// send rule in social.js, so history for a non-friend comes back empty.
function conversation(token, other) {
  const me = verifyToken(token);
  if (!me) return { status: 401, body: { error: 'Not signed in.' } };
  const name = String(other || '').trim();
  if (!name) return { status: 400, body: { error: 'Missing user.' } };
  if (!areFriends(me, name)) return { status: 200, body: { messages: [] } };
  const messages = selConversation.all(me, name, name, me).map(toDto);
  return { status: 200, body: { messages } };
}

module.exports = { saveMessage, conversation, MAX_BODY };

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
 *
 * Each row also carries a `read` flag (0/1) from the recipient's point of view,
 * so unread counts survive being offline: a message sent while the recipient is
 * away stays read=0 until they open that conversation, and unreadCounts() lets
 * the client light its Messages badge on next login (not just for live DMs).
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
    read       INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);
// Migrate DBs created before `read` existed. Add the column with default 0 (so
// new messages arrive unread), then backfill every existing row to read=1 as a
// one-time step, so the upgrade doesn't resurface old conversations as unread.
if (!db.prepare('PRAGMA table_info(messages)').all().some(c => c.name === 'read')) {
  db.exec('ALTER TABLE messages ADD COLUMN read INTEGER NOT NULL DEFAULT 0');
  db.exec('UPDATE messages SET read = 1');
}
// Conversations are read by (sender, recipient) pairs both ways, ordered by id.
db.exec('CREATE INDEX IF NOT EXISTS idx_messages_pair ON messages (sender, recipient, id)');
// Unread lookups scan a recipient's still-unread rows grouped by sender.
db.exec('CREATE INDEX IF NOT EXISTS idx_messages_unread ON messages (recipient, read)');

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
// Mark every message the recipient received from `other` as read.
const markReadStmt = db.prepare(
  'UPDATE messages SET read = 1 WHERE recipient = ? AND sender = ? AND read = 0'
);
// Unread counts for a recipient, grouped by who sent them.
const selUnread = db.prepare(
  `SELECT sender AS peer, COUNT(*) AS n FROM messages
   WHERE recipient = ? AND read = 0 GROUP BY sender`
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

/** Mark `me`'s conversation with `other` as read (called when they open it). */
function markRead(me, other) {
  markReadStmt.run(me, other);
}

/** Per-sender unread counts for `me`: { peerUsername: count, … }. */
function unreadByUser(me) {
  const counts = {};
  for (const r of selUnread.all(me)) counts[r.peer] = r.n;
  return counts;
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
  // Opening the conversation is the natural read receipt — clear its unread rows.
  markRead(me, name);
  return { status: 200, body: { messages } };
}

// GET /api/unread — per-sender unread counts for the signed-in player, so the
// client can seed its Messages badge on load (covering DMs received while it
// was offline, not just ones that arrive live this session).
function unread(token) {
  const me = verifyToken(token);
  if (!me) return { status: 401, body: { error: 'Not signed in.' } };
  return { status: 200, body: { counts: unreadByUser(me) } };
}

module.exports = { saveMessage, conversation, unread, markRead, MAX_BODY };

/* Friendships for Pixel Pool Online.
 *
 * Owns the `friendships` table and everything about it: the REST endpoints
 * server.js routes here, plus small helpers the social/chat layers use
 * (areFriends, friendUsernames).
 *
 * A friendship is one undirected edge stored as a single row:
 *   requester → addressee, status 'pending' until the addressee accepts, then
 *   'accepted'. Because it's undirected, every lookup checks BOTH orderings of
 *   the pair. Declining or removing just deletes the row, so the same request
 *   can be re-sent later.
 *
 * Real-time nicety: when a request/accept lands and the other party is online,
 * we push them a socket event via presence.emitToUser so their UI updates
 * without a refresh. The REST call still returns the authoritative result.
 */
'use strict';

const { db, findUser } = require('./db');
const { verifyToken } = require('./auth');
const presence = require('./presence');

db.exec(`
  CREATE TABLE IF NOT EXISTS friendships (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    requester  TEXT NOT NULL COLLATE NOCASE,   -- who sent the request
    addressee  TEXT NOT NULL COLLATE NOCASE,   -- who received it
    status     TEXT NOT NULL DEFAULT 'pending',-- 'pending' | 'accepted'
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (requester, addressee)
  )
`);

// Every relation query checks both orderings (friendship is undirected).
const selRelation = db.prepare(
  `SELECT requester, addressee, status FROM friendships
   WHERE (requester = ? AND addressee = ?) OR (requester = ? AND addressee = ?)`
);
const selForUser = db.prepare(
  `SELECT requester, addressee, status FROM friendships
   WHERE requester = ? COLLATE NOCASE OR addressee = ? COLLATE NOCASE`
);
const insReq   = db.prepare('INSERT INTO friendships (requester, addressee) VALUES (?, ?)');
const setAccepted = db.prepare(
  `UPDATE friendships SET status = 'accepted'
   WHERE requester = ? AND addressee = ? AND status = 'pending'`
);
const delEdge = db.prepare(
  `DELETE FROM friendships
   WHERE (requester = ? AND addressee = ?) OR (requester = ? AND addressee = ?)`
);
const searchUsersStmt = db.prepare(
  `SELECT username FROM users WHERE username LIKE ? ESCAPE '\\' COLLATE NOCASE
   ORDER BY username LIMIT 12`
);

/* ------------------------------- helpers -------------------------------- */

function relation(a, b) { return selRelation.get(a, b, b, a); }

/** Accepted-friend usernames of `user` (canonical case from the stored rows). */
function friendUsernames(user) {
  const lower = user.toLowerCase();
  const out = [];
  for (const r of selForUser.all(user, user)) {
    if (r.status !== 'accepted') continue;
    out.push(r.requester.toLowerCase() === lower ? r.addressee : r.requester);
  }
  return out;
}

function areFriends(a, b) {
  const r = relation(a, b);
  return !!(r && r.status === 'accepted');
}

/* ------------------------------ REST: read ------------------------------ */
// list() shape: { friends:[{username,online}], incoming:[{username}],
// outgoing:[{username}] }. incoming = pending requests awaiting MY response.
function list(token) {
  const me = verifyToken(token);
  if (!me) return { status: 401, body: { error: 'Not signed in.' } };
  const lower = me.toLowerCase();
  const friends = [], incoming = [], outgoing = [];
  for (const r of selForUser.all(me, me)) {
    const iAmRequester = r.requester.toLowerCase() === lower;
    const other = iAmRequester ? r.addressee : r.requester;
    if (r.status === 'accepted') friends.push({ username: other, online: presence.isOnline(other) });
    else if (iAmRequester) outgoing.push({ username: other });
    else incoming.push({ username: other });
  }
  friends.sort((a, b) => (b.online - a.online) || a.username.localeCompare(b.username));
  return { status: 200, body: { friends, incoming, outgoing } };
}

// Another player's friends, each annotated with MY relationship to them so the
// UI can show friends I share vs. people I could add. `state` mirrors search():
// 'self' | 'friends' | 'outgoing' | 'incoming' | 'none'. Any signed-in viewer
// may read this (it's a public-profile view); the target need not be them.
function friendsOf(token, name) {
  const me = verifyToken(token);
  if (!me) return { status: 401, body: { error: 'Not signed in.' } };
  const target = findUser(String(name || '').trim());
  if (!target) return { status: 404, body: { error: 'No player with that name.' } };
  const lower = me.toLowerCase();
  const friends = friendUsernames(target.username).map(u => {
    let state;
    if (u.toLowerCase() === lower) state = 'self';
    else {
      const rel = relation(me, u);
      state = !rel ? 'none'
        : rel.status === 'accepted' ? 'friends'
        : rel.requester.toLowerCase() === lower ? 'outgoing' : 'incoming';
    }
    return { username: u, online: presence.isOnline(u), state };
  });
  friends.sort((a, b) => (b.online - a.online) || a.username.localeCompare(b.username));
  return { status: 200, body: { owner: target.username, friends } };
}

function search(token, q) {
  const me = verifyToken(token);
  if (!me) return { status: 401, body: { error: 'Not signed in.' } };
  const term = String(q || '').trim();
  if (term.length < 1) return { status: 200, body: { results: [] } };
  const lower = me.toLowerCase();
  // Escape LIKE wildcards in user input, then substring-match.
  const esc = term.replace(/[\\%_]/g, c => '\\' + c);
  const rows = searchUsersStmt.all('%' + esc + '%');
  const results = rows
    .filter(r => r.username.toLowerCase() !== lower)
    .map(r => {
      const rel = relation(me, r.username);
      let state = 'none';
      if (rel) {
        state = rel.status === 'accepted' ? 'friends'
          : rel.requester.toLowerCase() === lower ? 'outgoing' : 'incoming';
      }
      return { username: r.username, state };
    });
  return { status: 200, body: { results } };
}

/* ----------------------------- REST: write ------------------------------ */

function request(token, body) {
  const me = verifyToken(token);
  if (!me) return { status: 401, body: { error: 'Not signed in.' } };
  const target = findUser(String((body && body.username) || '').trim());
  if (!target) return { status: 404, body: { error: 'No player with that name.' } };
  if (target.username.toLowerCase() === me.toLowerCase()) {
    return { status: 400, body: { error: 'You can’t add yourself.' } };
  }
  const rel = relation(me, target.username);
  if (rel && rel.status === 'accepted') return { status: 409, body: { error: 'You’re already friends.' } };
  if (rel && rel.requester.toLowerCase() === me.toLowerCase()) {
    return { status: 409, body: { error: 'Request already sent.' } };
  }
  // They already requested us → accept instead of stacking a reverse request.
  if (rel) return accept(token, { username: target.username });

  insReq.run(me, target.username);
  presence.emitToUser(target.username, 'friend-request', { username: me });
  return { status: 201, body: { ok: true, username: target.username } };
}

function accept(token, body) {
  const me = verifyToken(token);
  if (!me) return { status: 401, body: { error: 'Not signed in.' } };
  const target = findUser(String((body && body.username) || '').trim());
  if (!target) return { status: 404, body: { error: 'No player with that name.' } };
  // A pending request must exist with THEM as requester and ME as addressee.
  const changed = setAccepted.run(target.username, me);
  if (!changed.changes) return { status: 404, body: { error: 'No pending request from that player.' } };
  presence.emitToUser(target.username, 'friend-accepted', { username: me });
  return { status: 200, body: { ok: true, username: target.username } };
}

// Decline an incoming request OR cancel one you sent — both just drop the edge.
function decline(token, body) {
  const me = verifyToken(token);
  if (!me) return { status: 401, body: { error: 'Not signed in.' } };
  const name = String((body && body.username) || '').trim();
  if (!name) return { status: 400, body: { error: 'Missing username.' } };
  delEdge.run(me, name, name, me);
  presence.emitToUser(name, 'friend-removed', { username: me });
  return { status: 200, body: { ok: true, username: name } };
}

function remove(token, body) { return decline(token, body); } // same effect: drop the edge

module.exports = { list, search, friendsOf, request, accept, decline, remove, areFriends, friendUsernames };

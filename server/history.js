/* Online match history for Pixel Pool.
 *
 * Owns the `matches` table and everything about it: recording finished games
 * (called from realtime.js when the authoritative end-of-game 'state' message
 * passes through the relay) and the two read endpoints server.js routes here:
 *
 *   GET /api/history    -> the signed-in player's games, newest first,
 *                          personalized (opponent name + won/lost per row)
 *   GET /api/match/:id  -> one full match: names, result, duration and the
 *                          stats snapshot (per-seat tallies + play-by-play
 *                          log, exactly what js/stats.js snapshot() produces)
 *                          — only visible to the two participants.
 *
 * Recording happens server-side rather than via a client POST so neither
 * client has to be trusted to report (or double-report) results: the same
 * end 'state' message both clients already agree on is what gets stored.
 */
'use strict';

const { db } = require('./db');
const { verifyToken } = require('./auth');

db.exec(`
  CREATE TABLE IF NOT EXISTS matches (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    p0        TEXT NOT NULL,               -- seat 0 (breaker) username
    p1        TEXT NOT NULL,               -- seat 1 username
    winner    INTEGER NOT NULL,            -- winning seat: 0 or 1
    reason    TEXT,                        -- end-of-game reason line
    duration  INTEGER,                     -- seconds, measured server-side
    stats     TEXT,                        -- JSON: {seats:[...], log:[...]} (js/stats.js snapshot)
    played_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

const insertMatch = db.prepare(
  'INSERT INTO matches (p0, p1, winner, reason, duration, stats) VALUES (?, ?, ?, ?, ?, ?)'
);
const selectForUser = db.prepare(
  `SELECT id, p0, p1, winner, reason, played_at FROM matches
   WHERE p0 = ? COLLATE NOCASE OR p1 = ? COLLATE NOCASE
   ORDER BY id DESC LIMIT 100`
);
const selectById = db.prepare(
  'SELECT id, p0, p1, winner, reason, duration, stats, played_at FROM matches WHERE id = ?'
);

// The stats snapshot includes the play-by-play log (two full ball layouts per
// stroke) — bounded in practice, but cap it so a hostile client can't bloat
// the DB. Over the cap the per-seat tallies are kept and just the log dropped.
const MAX_STATS_BYTES = 400_000;

/** Store a finished match. names = [seat0Username, seat1Username]. */
function recordMatch(names, winner, reason, durationSec, stats) {
  if (winner !== 0 && winner !== 1) return;
  let statsJson = null;
  if (stats && Array.isArray(stats.seats)) {
    statsJson = JSON.stringify(stats);
    if (statsJson.length > MAX_STATS_BYTES) statsJson = JSON.stringify({ seats: stats.seats });
  }
  insertMatch.run(names[0], names[1], winner,
    String(reason || '').slice(0, 300), Math.max(0, durationSec | 0), statsJson);
}

/* ------------------------------ API handlers ------------------------------ */
// Both take the bearer token and return { status, body } like auth.js does,
// so server.js stays a dumb transport.

// One player's game list (newest first), personalized to their seat — no auth
// (callers decide who may see it; the list itself is not sensitive, but match
// *detail* stays participant-only via matchDetail below).
function listFor(username) {
  const lower = username.toLowerCase();
  return selectForUser.all(username, username).map(r => {
    const seat = r.p0.toLowerCase() === lower ? 0 : 1;
    return {
      id: r.id,
      opponent: seat === 0 ? r.p1 : r.p0,
      won: r.winner === seat,
      reason: r.reason,
      playedAt: r.played_at,
    };
  });
}

function history(token) {
  const username = verifyToken(token);
  if (!username) return { status: 401, body: { error: 'Not signed in.' } };
  return { status: 200, body: { matches: listFor(username) } };
}

// One match's full detail, seen from `username`'s seat — no auth (callers gate
// access). `username` MUST be one of the two players: the recap is rendered
// from their perspective (mySeat), and requiring participation keeps the same
// 404 whether the match is missing or `username` wasn't in it.
function detailFor(username, id) {
  const row = selectById.get(id);
  const lower = username.toLowerCase();
  const seat = row && (row.p0.toLowerCase() === lower ? 0 : row.p1.toLowerCase() === lower ? 1 : -1);
  if (!row || seat === -1) return { status: 404, body: { error: 'Match not found.' } };
  let stats = null;
  try { stats = row.stats ? JSON.parse(row.stats) : null; } catch { /* corrupt row — show without stats */ }
  return {
    status: 200,
    body: {
      id: row.id,
      names: [row.p0, row.p1],
      mySeat: seat,
      winner: row.winner,
      reason: row.reason,
      duration: row.duration,
      playedAt: row.played_at,
      stats,
    },
  };
}

function matchDetail(token, id) {
  const username = verifyToken(token);
  if (!username) return { status: 401, body: { error: 'Not signed in.' } };
  // Same 404 whether the match doesn't exist or belongs to other players —
  // don't leak which ids are real.
  return detailFor(username, id);
}

module.exports = { recordMatch, history, matchDetail, listFor, detailFor };

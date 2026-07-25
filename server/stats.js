/* Career (lifetime) statistics for Pixel Pool Online.
 *
 * Aggregates a signed-in player's per-game stats — the same tallies js/stats.js
 * records and the recap shows (shots, balls pocketed, fouls by type, defensive
 * shots, best streak) — summed across every online game they've played, plus a
 * win/loss/win-rate record.
 *
 * The numbers come straight from the `matches` table history.js already owns:
 * each row stores the game's stats snapshot as JSON ({seats:[...], log:[...]})
 * and the winning seat, so we just walk the player's games, pick out their
 * seat's tally, and add it up. Server-side so we never ship a player's whole
 * match archive (with play-by-play logs) to the client just to total it.
 *
 * server.js routes GET /api/stats here.
 */
'use strict';

const { db } = require('./db');
const { verifyToken } = require('./auth');

const selMatches = db.prepare(
  `SELECT p0, p1, winner, stats FROM matches
   WHERE p0 = ? COLLATE NOCASE OR p1 = ? COLLATE NOCASE`
);

// Summable per-seat counters from js/stats.js's blank(). `streak` (the running
// count) is per-game and meaningless in aggregate; `bestStreak` is a max, not a
// sum, so both are handled separately below.
const SUM_KEYS = ['shots', 'pots', 'potShots', 'scratches', 'noContact', 'wrongBall', 'defensive'];

// Aggregate one player's lifetime stats by username — no auth (callers decide
// who may see it: career() gates on the token being that player; the public
// profile endpoint (server/profiles.js) gates on the viewer being signed in).
function careerTotals(username) {
  const lower = username.toLowerCase();

  const totals = Object.fromEntries(SUM_KEYS.map(k => [k, 0]));
  totals.bestStreak = 0;
  let games = 0, wins = 0, losses = 0;

  for (const r of selMatches.all(username, username)) {
    const seat = r.p0.toLowerCase() === lower ? 0 : 1;
    games++;
    if (r.winner === seat) wins++; else losses++;

    if (!r.stats) continue; // result still counts; just no stat snapshot to add
    let parsed;
    try { parsed = JSON.parse(r.stats); } catch { continue; }
    const s = parsed && Array.isArray(parsed.seats) && parsed.seats[seat];
    if (!s) continue;
    for (const k of SUM_KEYS) totals[k] += s[k] | 0;
    if ((s.bestStreak | 0) > totals.bestStreak) totals.bestStreak = s.bestStreak | 0;
  }

  const winrate = games ? Math.round((100 * wins) / games) : 0;
  return { games, wins, losses, winrate, totals };
}

function career(token) {
  const username = verifyToken(token);
  if (!username) return { status: 401, body: { error: 'Not signed in.' } };
  return { status: 200, body: careerTotals(username) };
}

module.exports = { career, careerTotals };

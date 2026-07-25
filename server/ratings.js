/* Elo ratings for Pixel Pool Online.
 *
 * Owns the `ratings` table and the Elo math. Every online match is between two
 * signed-in accounts (the socket layer rejects tokenless connections), so every
 * recorded game has two real usernames to rate — realtime.js calls applyResult
 * once, server-side, from the same authoritative end-of-game 'state' that
 * history.js records, so neither client can spoof a rating change.
 *
 * Standard Elo:
 *   Expected score  E_a = 1 / (1 + 10^((R_b - R_a) / 400))
 *   New rating      R'_a = round(R_a + K * (S_a - E_a))     S = 1 win, 0 loss
 * with a fixed K-factor of 32. New accounts have no row and are treated as the
 * base 1500 until their first game creates one (lazy default — no signup hook).
 */
'use strict';

const { db } = require('./db');

const BASE_RATING = 1500;
const K = 32;

db.exec(`
  CREATE TABLE IF NOT EXISTS ratings (
    username   TEXT PRIMARY KEY COLLATE NOCASE,
    rating     INTEGER NOT NULL DEFAULT ${BASE_RATING},
    games      INTEGER NOT NULL DEFAULT 0,
    wins       INTEGER NOT NULL DEFAULT 0,
    losses     INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

const selRating = db.prepare(
  'SELECT username, rating, games, wins, losses FROM ratings WHERE username = ?'
);
// Upsert: create the row at BASE on first sight, otherwise apply the new rating
// and increment the win/loss tallies.
const upsertRating = db.prepare(`
  INSERT INTO ratings (username, rating, games, wins, losses, updated_at)
  VALUES (?, ?, 1, ?, ?, datetime('now'))
  ON CONFLICT(username) DO UPDATE SET
    rating     = excluded.rating,
    games      = ratings.games + 1,
    wins       = ratings.wins + excluded.wins,
    losses     = ratings.losses + excluded.losses,
    updated_at = datetime('now')
`);

/** Current rating record for `username`; the base 1500 default if unrated. */
function getRating(username) {
  const row = selRating.get(username);
  return row || { username, rating: BASE_RATING, games: 0, wins: 0, losses: 0 };
}

/** Probability `a` (rated ra) beats `b` (rated rb) — the Elo expected score. */
function expected(ra, rb) {
  return 1 / (1 + Math.pow(10, (rb - ra) / 400));
}

/**
 * Apply one decisive result to both players' ratings and persist it.
 * Returns { winner, loser } where each is
 *   { username, before, after, delta } (delta = after - before).
 */
function applyResult(winnerName, loserName) {
  const w = getRating(winnerName);
  const l = getRating(loserName);

  const eWin = expected(w.rating, l.rating);
  const winnerAfter = Math.round(w.rating + K * (1 - eWin));
  const loserAfter = Math.round(l.rating + K * (0 - (1 - eWin)));

  upsertRating.run(winnerName, winnerAfter, 1, 0); // +1 game, +1 win
  upsertRating.run(loserName, loserAfter, 0, 1);   // +1 game, +1 loss

  return {
    winner: { username: winnerName, before: w.rating, after: winnerAfter, delta: winnerAfter - w.rating },
    loser: { username: loserName, before: l.rating, after: loserAfter, delta: loserAfter - l.rating },
  };
}

module.exports = { getRating, applyResult, BASE_RATING };

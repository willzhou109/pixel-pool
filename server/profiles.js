/* Public player profiles for Pixel Pool Online.
 *
 * Lets a signed-in player view *another* user's profile — the same header +
 * STATS + GAME HISTORY the profile page shows for yourself, but for someone
 * else. Read-only and composed from the feature modules that already own each
 * piece: db (join date), ratings (Elo + W/L), avatar (emoji tile), stats
 * (career totals) and history (game list).
 *
 * server.js routes here:
 *   GET /api/users/:username/summary  -> header: name, joined, rating, W/L, avatar
 *   GET /api/users/:username/stats    -> lifetime career totals
 *   GET /api/users/:username/history  -> the player's game list (list only)
 *
 * All three require the *viewer* to be signed in (any account), not to be that
 * user. Match detail is deliberately NOT exposed here — history.matchDetail
 * stays participant-only, so another player's game list isn't drillable.
 */
'use strict';

const { findUser } = require('./db');
const { verifyToken } = require('./auth');
const ratings = require('./ratings');
const avatar = require('./avatar');
const stats = require('./stats');
const history = require('./history');

// Resolve the request: the viewer must be signed in, and the target must exist.
// Returns { user } on success or { error: {status, body} } to send back.
function resolve(token, name) {
  if (!verifyToken(token)) return { error: { status: 401, body: { error: 'Not signed in.' } } };
  const user = findUser(String(name || '').trim());
  if (!user) return { error: { status: 404, body: { error: 'No player with that name.' } } };
  return { user };
}

function summary(token, name) {
  const { user, error } = resolve(token, name);
  if (error) return error;
  const r = ratings.getRating(user.username);
  return {
    status: 200,
    body: {
      username: user.username,
      createdAt: user.created_at,
      rating: r.rating,
      games: r.games,
      wins: r.wins,
      losses: r.losses,
      avatar: avatar.getAvatar(user.username),
    },
  };
}

function statsFor(token, name) {
  const { user, error } = resolve(token, name);
  if (error) return error;
  return { status: 200, body: stats.careerTotals(user.username) };
}

function historyFor(token, name) {
  const { user, error } = resolve(token, name);
  if (error) return error;
  return { status: 200, body: { matches: history.listFor(user.username) } };
}

module.exports = { summary, stats: statsFor, history: historyFor };

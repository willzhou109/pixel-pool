/* On-demand match recap — POST /api/commentary.
 *
 * The stored-match path (index.js) only covers ONLINE games, because only
 * those produce a row in `matches`. Offline games (hot-seat and vs-computer)
 * never touch the server, so their recap has to be generated from the stats
 * snapshot the client is holding, and returned straight back — nothing is
 * persisted.
 *
 * Guests can use this — most offline players never sign in, so gating it on an
 * account would hide the feature from the default path. The API key itself is
 * never exposed (it stays server-side), but every call costs real money, so
 * the SPENDING is what has to be defended. Three layers do that:
 *
 *   1. Per-identity rate limit — signed-in users are tracked by username,
 *      guests by IP, with guests on a tighter allowance.
 *   2. A hard global daily cap. This is the actual backstop: per-IP limits
 *      are defeatable by rotating addresses, so the only guarantee that a
 *      determined abuser can't run up an unbounded bill is a ceiling on
 *      total generations per day. Worst case, the cap is exhausted and
 *      recaps go quiet until midnight UTC — your bill stays bounded.
 *   3. The client-supplied payload is validated and clamped before it can
 *      reach a prompt — it is untrusted input, not a trusted stats blob.
 *
 * Both limits are tunable from the environment (see .env.example).
 */
'use strict';

const { verifyToken } = require('../auth');
const { summarize } = require('./summarize');
const { generate } = require('./generate');

const ENABLED = !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);

// A game takes minutes to play, so these are generous for real use while
// capping what any one player (or one address) can spend.
const WINDOW_MS = 60 * 60 * 1000;
const MAX_PER_USER = Number(process.env.PP_RECAP_USER_HOURLY) || 20;
const MAX_PER_GUEST = Number(process.env.PP_RECAP_GUEST_HOURLY) || 5;
// Total generations allowed per UTC day, across everyone. At roughly a cent
// each, the default bounds the worst case to a few dollars a day.
const MAX_PER_DAY = Number(process.env.PP_RECAP_DAILY_MAX) || 300;

const hits = new Map(); // identity -> timestamps
let dayKey = '';
let dayCount = 0;

function rateLimited(identity, max) {
  const now = Date.now();
  const recent = (hits.get(identity) || []).filter(t => now - t < WINDOW_MS);
  recent.push(now);
  hits.set(identity, recent);
  return recent.length > max;
}

/** True when today's global budget is already spent. Counts on success only —
 * see recap() — so failed calls don't eat the cap. */
function dayExhausted() {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== dayKey) { dayKey = today; dayCount = 0; }
  return dayCount >= MAX_PER_DAY;
}

// Keep the map from growing without bound on a long-lived server.
setInterval(() => {
  const now = Date.now();
  for (const [id, times] of hits) {
    const recent = times.filter(t => now - t < WINDOW_MS);
    if (recent.length) hits.set(id, recent); else hits.delete(id);
  }
}, WINDOW_MS).unref();

/* ------------------------------ validation ------------------------------- */
// Hard caps on anything that reaches the prompt. A hostile client could
// otherwise send 10k strokes or a megabyte of names.
const MAX_STROKES = 200;
const MAX_NAME = 20;
const FOULS = new Set(['scratch', 'noContact', 'wrongBall', 'noRail', 'wrongPot']);

const str = (v, max) => typeof v === 'string' ? v.slice(0, max) : '';
const int = (v, lo, hi) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : 0;
};

function cleanSeat(s) {
  if (!s || typeof s !== 'object') return null;
  const out = {};
  for (const k of ['shots', 'pots', 'potShots', 'scratches', 'noContact',
                   'wrongBall', 'noRail', 'defensive', 'bestStreak']) {
    out[k] = int(s[k], 0, 10000);
  }
  return out;
}

function cleanStroke(e) {
  if (!e || typeof e !== 'object') return null;
  return {
    shooter: int(e.shooter, 0, 1),
    foul: FOULS.has(e.foul) ? e.foul : null,
    potted: Array.isArray(e.potted)
      ? e.potted.map(n => int(n, 0, 21)).slice(0, 22)
      : [],
  };
}

/** Shape an untrusted request body into the object summarize() expects. */
function clean(body) {
  const b = body || {};
  const names = Array.isArray(b.names) ? b.names : [];
  const log = Array.isArray(b.stats && b.stats.log) ? b.stats.log : [];
  const seats = Array.isArray(b.stats && b.stats.seats) ? b.stats.seats : [];
  return {
    // Anything but a rule set we actually ship is treated as 8-ball, so a junk
    // value can't invent one in the prompt.
    game: (b.game === '9ball' || b.game === 'snooker') ? b.game : '8ball',
    names: [str(names[0], MAX_NAME) || 'Player 1', str(names[1], MAX_NAME) || 'Player 2'],
    winner: int(b.winner, 0, 1),
    reason: str(b.reason, 300),
    duration: int(b.duration, 0, 86400),
    stats: {
      seats: [cleanSeat(seats[0]), cleanSeat(seats[1])],
      log: log.slice(0, MAX_STROKES).map(cleanStroke).filter(Boolean),
    },
  };
}

/* -------------------------------- handler -------------------------------- */

/** POST /api/commentary — { status, body } like the other modules.
 * `ip` identifies guests for rate-limiting; signed-in callers use their name. */
async function recap(token, body, ip) {
  if (!ENABLED) return { status: 501, body: { error: 'AI recaps are not configured on this server.' } };

  // Guests are welcome — offline play doesn't require an account — they just
  // get a smaller hourly allowance than a signed-in player.
  const username = verifyToken(token);
  const identity = username || `ip:${ip || 'unknown'}`;
  const max = username ? MAX_PER_USER : MAX_PER_GUEST;

  if (rateLimited(identity, max)) {
    return { status: 429, body: { error: 'Too many recaps in the last hour. Try again later.' } };
  }
  if (dayExhausted()) {
    return { status: 429, body: { error: 'Recaps have hit today’s limit. Try again tomorrow.' } };
  }
  const match = clean(body);
  if (!match.stats.log.length && !match.stats.seats[0]) {
    return { status: 400, body: { error: 'Nothing to write about.' } };
  }
  try {
    const text = await generate(summarize(match));
    dayCount++;   // only successful generations count against the daily budget
    return { status: 200, body: { commentary: text } };
  } catch (e) {
    console.error('[commentary] live recap failed:', e.message);
    return { status: 502, body: { error: 'Could not write the recap. Try again.' } };
  }
}

module.exports = { recap };

/* Turns a stored match into a compact text digest for the commentary model.
 *
 * The stats blob js/stats.js produces is built for the replay viewer, not for
 * reading: `log` carries two FULL ball layouts per stroke ([id, x, z, potted]
 * for all 16 balls, before and after). Feeding that raw to an LLM would be
 * mostly meaningless coordinates and would blow up the prompt on a long match.
 *
 * So this module does the interpretation in plain JS first — diffing each
 * stroke's before/after layouts to name the balls that actually dropped — and
 * emits a handful of short lines. Deterministic, dependency-free and cheap to
 * test on its own; generate.js never sees a coordinate.
 */
'use strict';

// A stroke log can be long (a scrappy game runs 40+ strokes). Past this many
// we keep the opening and closing strokes and collapse the middle, so the
// prompt stays bounded no matter how the match went.
const MAX_STROKE_LINES = 40;
const HEAD_LINES = 22;   // strokes kept from the start when collapsing
const TAIL_LINES = 16;   // strokes kept from the end when collapsing

const FOUL_TEXT = {
  scratch: 'fouls (scratched the cue ball)',
  noContact: 'fouls (hit nothing)',
  wrongBall: 'fouls (hit the wrong ball first)',
  noRail: 'fouls (no ball reached a rail)',
  wrongPot: 'fouls (potted a ball that wasn\'t on)',
};

/** Snooker's colours, ids 16-21 — see js/snooker.js, which owns the mapping. */
const SNOOKER_COLOURS = {
  16: 'the yellow', 17: 'the green', 18: 'the brown',
  19: 'the blue', 20: 'the pink', 21: 'the black',
};

/** Human name for a ball id. In the pool games: 0 = cue, 8 = the 8, 1-7 solids,
 * 9-15 stripes. In snooker the same ids 1-15 are the reds and 16-21 the
 * colours, so the rule set has to be passed in to tell them apart. */
function ballName(id, game) {
  if (id === 0) return 'the cue ball';
  if (game === 'snooker') return id <= 15 ? 'a red' : (SNOOKER_COLOURS[id] || 'a ball');
  if (id === 8) return 'the 8';
  return `the ${id}`;
}

/** Ball ids that went from on-table to potted across one stroke. Returns []
 * when either layout is missing (older rows stored tallies only). */
function pottedIds(before, after) {
  if (!Array.isArray(before) || !Array.isArray(after)) return [];
  const wasPotted = new Map();
  for (const row of before) if (Array.isArray(row)) wasPotted.set(row[0], !!row[3]);
  const out = [];
  for (const row of after) {
    if (!Array.isArray(row)) continue;
    const [id, , , potted] = row;
    if (potted && wasPotted.get(id) === false) out.push(id);
  }
  return out.sort((a, b) => a - b);
}

/** Ball ids potted on a stroke, from either log shape:
 *  - stored matches carry full `before`/`after` layouts (diff them)
 *  - live recaps POST a compact `potted: [ids]` instead, to keep the request
 *    small (js/stats.js compactLog)
 * The cue ball is never counted as a pot — a scratch is a foul, not a pot. */
function strokePots(entry) {
  const ids = Array.isArray(entry.potted)
    ? entry.potted.filter(n => Number.isInteger(n) && n >= 0 && n <= 21)
    : pottedIds(entry.before, entry.after);
  return ids.filter(id => id !== 0);
}

/** One readable line per stroke, e.g. "12. Bob pots the 3 and the 5." `game`
 * is the rule set, which decides what the ball ids are called. */
function strokeLine(entry, index, names, game) {
  const who = names[entry.shooter] || `Seat ${entry.shooter}`;
  const dropped = strokePots(entry);
  const parts = [];

  if (dropped.length) {
    const list = dropped.map(id => ballName(id, game));
    const phrase = list.length === 1
      ? list[0]
      : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
    parts.push(`pots ${phrase}`);
  } else if (!entry.foul) {
    parts.push('misses');
  }
  if (entry.foul) parts.push(FOUL_TEXT[entry.foul] || 'fouls');

  // A stroke with no pot info at all (pre-layout rows) still reports its tally.
  if (!parts.length) parts.push(entry.pots > 0 ? `pots ${entry.pots}` : 'misses');
  return `${index}. ${who} ${parts.join(', ')}.`;
}

/** Per-seat tallies as one line each. */
function seatLine(seat, name) {
  if (!seat) return `${name}: no stats recorded.`;
  const fouls = (seat.scratches || 0) + (seat.noContact || 0) + (seat.wrongBall || 0) + (seat.noRail || 0);
  const acc = seat.shots ? Math.round((seat.potShots / seat.shots) * 100) : 0;
  return `${name}: ${plural(seat.shots || 0, 'shot')}, ${plural(seat.pots || 0, 'ball')} potted, ` +
    `${acc}% of shots produced a pot, best run ${seat.bestStreak || 0}, ` +
    `${plural(fouls, 'foul')} (${seat.scratches || 0} scratch), ` +
    `${plural(seat.defensive || 0, 'defensive shot')}.`;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function fmtDuration(seconds) {
  const s = Math.max(0, seconds | 0);
  const m = Math.floor(s / 60);
  return m ? `${m}m ${s % 60}s` : `${s}s`;
}

/**
 * Build the digest.
 * @param {object} match - a row from server/history.js: { game, names:[p0,p1],
 *   winner, reason, duration, stats:{ seats, log } }
 * @returns {string} plain text, safe to drop straight into a prompt.
 */
function summarize(match) {
  const names = Array.isArray(match.names) ? match.names : ['Player 1', 'Player 2'];
  const stats = match.stats || {};
  const seats = Array.isArray(stats.seats) ? stats.seats : [];
  const log = Array.isArray(stats.log) ? stats.log : [];

  const lines = [];
  // Stored matches predate this field, and online play is 8-ball only, so an
  // absent game means 8-ball. Stated first: it changes what the shot list means.
  lines.push(match.game === '9ball'
    ? 'Game: 9-ball (rotation — lowest ball first, pot the 9 to win; the 8 is an ordinary ball).'
    : match.game === 'snooker'
      ? 'Game: snooker (a red worth 1, then a nominated colour, over and over; '
        + 'once the reds are gone the colours go in order — yellow 2, green 3, '
        + 'brown 4, blue 5, pink 6, black 7. Fouls concede 4 or more. Highest '
        + 'score on the black wins the frame).'
      : 'Game: 8-ball (clear your group, then the 8 in a called pocket).');
  lines.push(`Players: ${names[0]} (broke) vs ${names[1]}.`);
  const reason = String(match.reason || 'game over').replace(/\.\s*$/, '');
  lines.push(`Winner: ${names[match.winner]} — ${reason}.`);
  if (match.duration) lines.push(`Length: ${fmtDuration(match.duration)}, ${plural(log.length, 'stroke')}.`);
  lines.push('');
  lines.push('Totals:');
  lines.push(seatLine(seats[0], names[0]));
  lines.push(seatLine(seats[1], names[1]));

  if (log.length) {
    lines.push('');
    lines.push('Shot by shot:');
    if (log.length <= MAX_STROKE_LINES) {
      log.forEach((e, i) => lines.push(strokeLine(e, i + 1, names, match.game)));
    } else {
      log.slice(0, HEAD_LINES).forEach((e, i) => lines.push(strokeLine(e, i + 1, names, match.game)));
      lines.push(`… ${log.length - HEAD_LINES - TAIL_LINES} strokes omitted …`);
      const tailStart = log.length - TAIL_LINES;
      log.slice(tailStart).forEach((e, i) => lines.push(strokeLine(e, tailStart + i + 1, names, match.game)));
    }
  }
  return lines.join('\n');
}

module.exports = { summarize, pottedIds, strokePots, ballName };

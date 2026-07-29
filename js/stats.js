/* Per-match statistics for Pixel Pool — the end-of-game "GAME RECAP" panel.
 *
 * game.js reports every resolved stroke via window.MatchStats.recordShot()
 * (shooter seat, own-group balls pocketed, foul type) and this module keeps a
 * per-seat tally: shots, pots, potting accuracy, fouls by type and defensive
 * shots. It also keeps a per-stroke play-by-play log (pre/post table layouts +
 * shot direction) that js/playbyplay.js renders as the recap's LAYOUT tab.
 * A defensive shot is credited to a player whenever the OPPONENT's
 * stroke fails to contact a legal ball (no contact / wrong ball first) —
 * scratches don't count, since the cue found a pocket, not a snooker.
 *
 * Works identically offline and online. Online, only the shooter's client
 * resolves a stroke, so the running tally rides along on every authoritative
 * 'state' message (game.js: serializeState() -> snapshot(), applyState() ->
 * applyRemote()); both clients therefore converge on the same table and the
 * watcher can open the same recap at game end.
 *
 * The recap panel (#recapPanel) lives inside #endOverlay as a sibling of
 * #endPanel; the GAME RECAP / BACK buttons just swap the two. finalize()
 * re-arms the overlay so it always reopens on the result panel.
 *
 * Later (online career stats): finalize() is the natural hook to POST
 * snapshot() + the result to the server for lifetime persistence.
 */
(function () {
  'use strict';

  const $ = id => document.getElementById(id);

  const blank = () => ({
    shots: 0, pots: 0, potShots: 0, scratches: 0, noContact: 0, wrongBall: 0, defensive: 0,
    streak: 0, bestStreak: 0,   // current / longest run of consecutive potting shots
  });
  let seats = [blank(), blank()];
  let names = ['Player 1', 'Player 2'];
  let startMs = 0;
  let result = null;   // {winner, reason, seconds}

  // Play-by-play shot log for the recap's LAYOUT tab (js/playbyplay.js).
  // One entry per resolved stroke: {shooter, pots, foul, dir, before, after}
  // where before/after are compact ball layouts ([id, x, z, potted] rows from
  // game.js statsLayout()) and dir is the unit shot direction {x, z}.
  let log = [];
  let pendingShot = null; // {before, dir} captured at cue strike, paired at resolve

  function begin(playerNames) {
    seats = [blank(), blank()];
    if (playerNames) names = playerNames.slice(0, 2);
    startMs = performance.now();
    result = null;
    log = [];
    pendingShot = null;
  }

  // Called from game.js fire(): the table as it stood when the cue was struck,
  // plus the shot direction — the "before" board of the play-by-play.
  function beginShot(before, dir) { pendingShot = { before, dir }; }

  // One resolved stroke. pots = own-group balls sunk this stroke (game.js
  // excludes the cue, counts every object ball while the table is still open,
  // and adds the 8 on the stroke that legally wins).
  // foul: null | 'scratch' | 'noContact' | 'wrongBall'.
  // after = the settled post-shot layout (see beginShot for the shape).
  function recordShot(shooter, pots, foul, after) {
    const s = seats[shooter];
    if (!s) return;
    log.push({
      shooter, pots, foul,
      dir: pendingShot ? pendingShot.dir : null,
      before: pendingShot ? pendingShot.before : null,
      after: after || null,
    });
    pendingShot = null;
    s.shots++;
    s.pots += pots;
    if (pots > 0) {
      s.potShots++;
      s.streak++;
      if (s.streak > s.bestStreak) s.bestStreak = s.streak;
    } else {
      s.streak = 0;
    }
    if (foul === 'scratch') s.scratches++;
    else if (foul === 'noContact') { s.noContact++; seats[1 - shooter].defensive++; }
    else if (foul === 'wrongBall') { s.wrongBall++; seats[1 - shooter].defensive++; }
  }

  /* ------------------------- online sync (game.js) ------------------------ */
  // The full table travels on every 'state' message; the watcher replaces its
  // copy wholesale. Only the resolving client ever mutates the tally, so the
  // latest message is always the complete truth for both seats.
  function snapshot() { return { seats: [Object.assign({}, seats[0]), Object.assign({}, seats[1])], log }; }
  function applyRemote(snap) {
    if (!snap || !Array.isArray(snap.seats)) return;
    seats = [Object.assign(blank(), snap.seats[0]), Object.assign(blank(), snap.seats[1])];
    if (Array.isArray(snap.log)) log = snap.log;
  }

  /* ------------------------------- recap UI ------------------------------- */
  const endPanel = $('endPanel');
  const recapPanel = $('recapPanel');
  const recapBtn = $('recapBtn');
  const backBtn = $('recapBackBtn');

  function finalize(winner, reason) {
    result = { winner, reason, seconds: Math.floor((performance.now() - startMs) / 1000) };
    // Re-arm the overlay: the next game end always opens on the result panel,
    // not wherever the recap was left showing last game.
    if (endPanel) endPanel.classList.remove('hidden');
    if (recapPanel) recapPanel.classList.add('hidden');
  }

  function fmtDur(sec) {
    return Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0');
  }

  const fouls = s => s.scratches + s.noContact + s.wrongBall;
  // Clamped at 100%: these are "shots that did X out of shots taken", so the
  // ratio is <= 1 by construction — but the same renderer also shows stored
  // career/history records, and a malformed one must never read as 130%.
  const rate = (n, d) => d ? Math.min(100, Math.round(100 * n / d)) + '%' : '—';

  // [label, value-for-seat, isSubRow] — sub-rows are the per-type foul
  // breakdown indented under the FOULS total.
  const ROWS = [
    ['SHOTS TAKEN',      s => s.shots],
    ['BALLS POCKETED',   s => s.pots],
    ['ACCURACY',         s => rate(s.potShots, s.shots)],
    ['LONGEST STREAK',   s => s.bestStreak],
    ['FOULS',            fouls],
    ['SCRATCHES',        s => s.scratches, true],
    ['NO CONTACT',       s => s.noContact, true],
    ['WRONG BALL FIRST', s => s.wrongBall, true],
    ['FOUL RATE',        s => rate(fouls(s), s.shots)],
    ['DEFENSIVE SHOTS',  s => s.defensive],
  ];

  function cell(cls, text) {
    const d = document.createElement('div');
    d.className = cls;
    d.textContent = text;
    return d;
  }

  // Fill any element styled as a .statTable grid with the per-seat stat rows.
  // Also used by js/history.js to show a stored match's stats on the profile
  // page — seatData there comes from the server, so blank-fill defensively.
  function renderStatsTable(tableEl, seatData, seatNames) {
    const sd = [Object.assign(blank(), seatData && seatData[0]),
                Object.assign(blank(), seatData && seatData[1])];
    tableEl.innerHTML = '';
    tableEl.appendChild(cell('recapLabel', ''));
    tableEl.appendChild(cell('recapHead', seatNames[0]));
    tableEl.appendChild(cell('recapHead', seatNames[1]));
    for (const [label, get, sub] of ROWS) {
      tableEl.appendChild(cell('recapLabel' + (sub ? ' recapSub' : ''), label));
      tableEl.appendChild(cell('recapVal', String(get(sd[0]))));
      tableEl.appendChild(cell('recapVal', String(get(sd[1]))));
    }
  }

  function render() {
    const winnerEl = $('recapWinner'), reasonEl = $('recapReason'),
          tableEl = $('recapTable'), durEl = $('recapDuration');
    if (!tableEl) return;

    if (winnerEl) {
      winnerEl.textContent = 'WINNER: ';
      const span = document.createElement('span');
      span.textContent = result ? (names[result.winner] || '?') : '—';
      winnerEl.appendChild(span);
    }
    if (reasonEl) reasonEl.textContent = result && result.reason ? '' + result.reason + '' : '';
    if (durEl) durEl.textContent = result ? 'GAME LENGTH ' + fmtDur(result.seconds) : '';

    renderStatsTable(tableEl, seats, names);
  }

  if (recapBtn && endPanel && recapPanel) {
    recapBtn.addEventListener('click', () => {
      render();
      endPanel.classList.add('hidden');
      recapPanel.classList.remove('hidden');
    });
    if (backBtn) backBtn.addEventListener('click', () => {
      recapPanel.classList.add('hidden');
      endPanel.classList.remove('hidden');
    });
  }

  // playByPlay: read-only view of the shot log for js/playbyplay.js.
  // renderStatsTable / fmtDur: shared with js/history.js so a stored match's
  // stats render identically to the live end-of-game recap.
  window.MatchStats = {
    begin, beginShot, recordShot, snapshot, applyRemote, finalize,
    playByPlay: () => ({ log, names }),
    renderStatsTable, fmtDur,
  };
})();

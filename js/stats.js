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

  // noRail is 9-ball's drive-to-rail foul; it stays 0 in 8-ball, and its recap
  // row is hidden unless somebody actually committed one.
  const blank = () => ({
    shots: 0, pots: 0, potShots: 0, scratches: 0, noContact: 0, wrongBall: 0, noRail: 0,
    defensive: 0,
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
    // A legal hit that died without reaching a rail is a foul, but it isn't the
    // opponent's doing — no defensive credit.
    else if (foul === 'noRail') s.noRail++;
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
    // Drop the previous game's recap so it can't be mistaken for this one's.
    recapRequested = false;
    recapToken++;
    showCommentary(null);
  }

  function fmtDur(sec) {
    return Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0');
  }

  const fouls = s => s.scratches + s.noContact + s.wrongBall + (s.noRail | 0);
  // Clamped at 100%: these are "shots that did X out of shots taken", so the
  // ratio is <= 1 by construction — but the same renderer also shows stored
  // career/history records, and a malformed one must never read as 130%.
  const rate = (n, d) => d ? Math.min(100, Math.round(100 * n / d)) + '%' : '—';

  // [label, value-for-seat, isSubRow, showIf] — sub-rows are the per-type foul
  // breakdown indented under the FOULS total. A row with a showIf predicate is
  // only drawn when it has something to say (NO RAIL can't happen in 8-ball).
  const ROWS = [
    ['SHOTS TAKEN',      s => s.shots],
    ['BALLS POCKETED',   s => s.pots],
    ['ACCURACY',         s => rate(s.potShots, s.shots)],
    ['LONGEST STREAK',   s => s.bestStreak],
    ['FOULS',            fouls],
    ['SCRATCHES',        s => s.scratches, true],
    ['NO CONTACT',       s => s.noContact, true],
    ['WRONG BALL FIRST', s => s.wrongBall, true],
    ['NO RAIL',          s => s.noRail | 0, true, sd => sd[0].noRail || sd[1].noRail],
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
    for (const [label, get, sub, showIf] of ROWS) {
      if (showIf && !showIf(sd)) continue;
      tableEl.appendChild(cell('recapLabel' + (sub ? ' recapSub' : ''), label));
      tableEl.appendChild(cell('recapVal', String(get(sd[0]))));
      tableEl.appendChild(cell('recapVal', String(get(sd[1]))));
    }
  }

  /* ----------------------------- AI recap -------------------------------- */
  // Offline games (hot-seat, vs-computer) never reach the server, so there's no
  // stored match to hang a recap off — POST the snapshot to /api/commentary and
  // render what comes back. Online games get the same treatment here; their
  // persistent copy is generated separately (server/commentary/index.js) and
  // shows up in the profile's GAME HISTORY.
  //
  // Guests get recaps too (offline play needs no account); the server just
  // gives them a smaller hourly allowance. See server/commentary/live.js.
  const commentaryEl = $('recapCommentary');
  let recapToken = 0;       // pins a response to the game that asked for it
  let recapRequested = false; // one generation per finished game

  // Full layouts are far too big to POST. Diff each stroke down to the ball
  // ids that dropped — the shape server/commentary/summarize.js accepts.
  function compactLog() {
    return log.map(e => {
      const wasPotted = new Map();
      for (const row of (e.before || [])) wasPotted.set(row[0], !!row[3]);
      const potted = [];
      for (const row of (e.after || [])) {
        if (row[3] && wasPotted.get(row[0]) === false) potted.push(row[0]);
      }
      return { shooter: e.shooter, foul: e.foul, potted };
    });
  }

  function showCommentary(text, waiting) {
    if (!commentaryEl) return;
    if (!text) { commentaryEl.classList.add('hidden'); return; }
    commentaryEl.classList.remove('hidden');
    commentaryEl.classList.toggle('cmWaiting', !!waiting);
    commentaryEl.innerHTML = '';
    const tag = document.createElement('span');
    tag.className = 'cmTag';
    tag.textContent = 'MATCH RECAP';
    commentaryEl.appendChild(tag);
    commentaryEl.appendChild(document.createTextNode(text));
  }

  async function requestCommentary() {
    if (!commentaryEl || !result) return;
    // Signed in? Send the token so the player gets the higher allowance.
    // Signed out is fine — the server treats it as a guest, not an error.
    const token = (() => { try { return sessionStorage.getItem('pp_token'); } catch { return null; } })();
    const mine = ++recapToken;
    showCommentary('Writing the recap…', true);
    try {
      const res = await fetch('/api/commentary', {
        method: 'POST',
        headers: Object.assign(
          { 'Content-Type': 'application/json' },
          token ? { Authorization: `Bearer ${token}` } : {}),
        body: JSON.stringify({
          // The rule set decides how the shot list reads (in 9-ball the 9 is
          // the ball that wins), so the recap has to be told which was played.
          game: window.PoolMatch ? window.PoolMatch.game() : '8ball',
          names, winner: result.winner, reason: result.reason,
          duration: result.seconds,
          stats: { seats, log: compactLog() },
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (mine !== recapToken) return;              // a newer game superseded this
      // Any failure (not configured, rate limited, API down) just hides the
      // block — the recap is a bonus, never something to apologise for.
      showCommentary(res.ok ? data.commentary : null);
    } catch {
      if (mine === recapToken) showCommentary(null);
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
      // Ask once per game — reopening the recap shouldn't pay for it again.
      if (!recapRequested) { recapRequested = true; requestCommentary(); }
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

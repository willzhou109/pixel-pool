/* STATS tab of the profile page — a player's lifetime (career) statistics.
 *
 * Fetches GET /api/stats (server/stats.js aggregates every online game the
 * signed-in player has played) and renders it inside #statsView on #profileMain:
 *
 *   - A record row: WINS / LOSSES / WIN RATE tiles (plus games played).
 *   - A career stat table listing the same tallies the end-of-game recap shows
 *     (shots, balls pocketed, accuracy, longest streak, fouls by type, foul
 *     rate, defensive shots) — summed across all games rather than one match.
 *
 * profile.js owns the tab buttons and calls open()/hide(); this module owns
 * everything inside #statsView. Only online games count toward these totals
 * (offline hot-seat games are never sent to the server).
 */
(function () {
  'use strict';

  const $ = id => document.getElementById(id);
  const view = $('statsView');
  const recordEl = $('careerRecord');
  const tableEl = $('careerTable');
  const emptyEl = $('careerEmpty');
  if (!view || !recordEl || !tableEl) { console.warn('CareerStats: elements missing'); return; }

  // Same per-tab session key as js/auth.js.
  const getToken = () => { try { return sessionStorage.getItem('pp_token'); } catch { return null; } };

  const rate = (n, d) => (d ? Math.round((100 * n) / d) + '%' : '—');
  const fouls = t => (t.scratches | 0) + (t.noContact | 0) + (t.wrongBall | 0);

  // [label, value(totals), isSubRow] — mirrors the per-game recap's ROWS
  // (js/stats.js), but single-value and with rates recomputed from the summed
  // totals. Sub-rows indent the per-type foul breakdown under FOULS.
  const ROWS = [
    ['SHOTS TAKEN',      t => t.shots | 0],
    ['BALLS POCKETED',   t => t.pots | 0],
    ['ACCURACY',         t => rate(t.potShots, t.shots)],
    ['LONGEST STREAK',   t => t.bestStreak | 0],
    ['FOULS',            t => fouls(t)],
    ['SCRATCHES',        t => t.scratches | 0, true],
    ['NO CONTACT',       t => t.noContact | 0, true],
    ['WRONG BALL FIRST', t => t.wrongBall | 0, true],
    ['FOUL RATE',        t => rate(fouls(t), t.shots)],
    ['DEFENSIVE SHOTS',  t => t.defensive | 0],
  ];

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function tile(cls, num, label) {
    const t = el('div', 'recordTile ' + cls);
    t.appendChild(el('div', 'recordNum', String(num)));
    t.appendChild(el('div', 'recordLabel', label));
    return t;
  }

  function renderRecord(data) {
    recordEl.innerHTML = '';
    recordEl.appendChild(tile('rWin', data.wins | 0, 'WINS'));
    recordEl.appendChild(tile('rLoss', data.losses | 0, 'LOSSES'));
    recordEl.appendChild(tile('rRate', (data.winrate | 0) + '%', 'WIN RATE'));
    recordEl.appendChild(tile('rGames', data.games | 0, 'GAMES'));
  }

  function renderTable(totals) {
    tableEl.innerHTML = '';
    for (const [label, get, sub] of ROWS) {
      tableEl.appendChild(el('div', 'recapLabel' + (sub ? ' recapSub' : ''), label));
      tableEl.appendChild(el('div', 'recapVal', String(get(totals))));
    }
  }

  // open() with no argument shows the signed-in player's own career stats; pass
  // a username to show another player's (via the public profile endpoint).
  async function open(username) {
    const other = username || null;
    view.classList.remove('hidden');
    recordEl.innerHTML = '';
    tableEl.innerHTML = '';
    if (emptyEl) { emptyEl.classList.add('hidden'); emptyEl.textContent = ''; }
    recordEl.appendChild(el('div', 'histEmpty', 'Loading…'));

    const path = other ? '/api/users/' + encodeURIComponent(other) + '/stats' : '/api/stats';
    let data;
    try {
      const res = await fetch(path, { headers: { Authorization: `Bearer ${getToken()}` } });
      data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Request failed.');
    } catch (e) {
      recordEl.innerHTML = '';
      if (emptyEl) { emptyEl.textContent = 'Couldn’t load stats. Is the server running?'; emptyEl.classList.remove('hidden'); }
      return;
    }

    renderRecord(data);
    if (!data.games) {
      tableEl.innerHTML = '';
      if (emptyEl) {
        emptyEl.textContent = other ? 'No online games yet.'
          : 'No online games yet — play a match to start building your stats!';
        emptyEl.classList.remove('hidden');
      }
      return;
    }
    renderTable(data.totals || {});
  }

  function hide() { view.classList.add('hidden'); }

  window.PoolCareerStats = { open, hide };
})();

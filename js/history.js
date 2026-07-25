/* GAME HISTORY tab of the profile page.
 *
 * Renders the signed-in player's past online games (recorded server-side by
 * server/history.js as matches end) inside #historyView on #profileMain:
 *
 *   - open(): fetch GET /api/history and show the match list — one row per
 *     game (date · VS OPPONENT · W/L), newest first. Clicking a row fetches
 *     GET /api/match/:id and swaps in the detail view.
 *   - Detail view: the same result row + the end-of-game reason, then the
 *     familiar STATS / LAYOUT tab pair — rendered by the exact same code as
 *     the end-of-game recap (MatchStats.renderStatsTable / PlayByPlay
 *     .renderLog), so a stored game reads identically to a live one.
 *
 * profile.js owns the tab buttons and calls open()/hide(); this module owns
 * everything inside #historyView. Only online games appear here — offline
 * hot-seat games are never sent to the server.
 */
(function () {
  'use strict';

  const $ = id => document.getElementById(id);
  const view = $('historyView');
  const listEl = $('historyList');
  const detailEl = $('historyDetail');
  const detailRow = $('histDetailRow');
  const reasonEl = $('histReason');
  const tabStats = $('histTabStats'), tabLayout = $('histTabLayout');
  const statsEl = $('histStats'), layoutEl = $('histLayout');
  const backBtn = $('historyBackBtn');
  if (!view || !listEl || !detailEl) { console.warn('History: elements missing'); return; }

  // Same per-tab session key as js/auth.js.
  const getToken = () => { try { return sessionStorage.getItem('pp_token'); } catch { return null; } };

  let current = null;  // the match detail currently shown, for the LAYOUT tab
  let viewUser = null; // whose history this is: null = me, else another player

  function fmtDate(playedAt) {
    if (!playedAt) return '—';
    // SQLite datetime('now'): "YYYY-MM-DD HH:MM:SS" (UTC, no zone marker).
    const d = new Date(playedAt.replace(' ', 'T') + 'Z');
    if (isNaN(d.getTime())) return '—';
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  }

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function fillRow(row, date, opponent, won) {
    row.innerHTML = '';
    row.appendChild(el('span', 'histDate', date));
    row.appendChild(el('span', 'histVs', 'VS ' + String(opponent || '?').toUpperCase()));
    row.appendChild(el('span', 'histRes ' + (won ? 'win' : 'loss'), won ? 'W' : 'L'));
  }

  async function fetchJson(path) {
    const res = await fetch(path, { headers: { Authorization: `Bearer ${getToken()}` } });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Request failed.');
    return data;
  }

  /* --------------------------------- list --------------------------------- */

  // open() with no argument shows the signed-in player's own history; pass a
  // username to show another player's. Either way the rows drill into the recap
  // (own games via /api/match/:id, another player's via /api/users/:u/match/:id).
  async function open(username) {
    viewUser = username || null;
    view.classList.remove('hidden');
    detailEl.classList.add('hidden');
    listEl.classList.remove('hidden');
    listEl.innerHTML = '';
    listEl.appendChild(el('div', 'histEmpty', 'Loading…'));
    const path = viewUser ? '/api/users/' + encodeURIComponent(viewUser) + '/history' : '/api/history';
    let matches;
    try {
      ({ matches } = await fetchJson(path));
    } catch (e) {
      listEl.innerHTML = '';
      listEl.appendChild(el('div', 'histEmpty', 'Couldn’t load game history. Is the server running?'));
      return;
    }
    listEl.innerHTML = '';
    if (!matches || !matches.length) {
      listEl.appendChild(el('div', 'histEmpty', viewUser
        ? 'No online games yet.'
        : 'No online games yet — play a match to start your history!'));
      return;
    }
    for (const m of matches) {
      const row = el('button', 'histRow');
      row.type = 'button';
      row.addEventListener('click', () => openDetail(m.id));
      fillRow(row, fmtDate(m.playedAt), m.opponent, m.won);
      listEl.appendChild(row);
    }
  }

  function hide() {
    view.classList.add('hidden');
  }

  /* -------------------------------- detail -------------------------------- */

  async function openDetail(id) {
    // Own match via /api/match/:id; another player's via the profile-scoped
    // endpoint, which shows the detail from THAT player's seat perspective.
    const path = viewUser
      ? '/api/users/' + encodeURIComponent(viewUser) + '/match/' + id
      : '/api/match/' + id;
    let match;
    try {
      match = await fetchJson(path);
    } catch (e) {
      return; // row stays; nothing to show
    }
    current = match;
    const opponent = match.names[1 - match.mySeat];
    fillRow(detailRow, fmtDate(match.playedAt), opponent, match.winner === match.mySeat);
    reasonEl.textContent = (match.reason || '') +
      (match.duration ? '  ·  GAME LENGTH ' + window.MatchStats.fmtDur(match.duration) : '');
    showTab(false); // always land on STATS, like the recap
    if (window.MatchStats) {
      window.MatchStats.renderStatsTable(statsEl, match.stats && match.stats.seats, match.names);
    }
    listEl.classList.add('hidden');
    detailEl.classList.remove('hidden');
  }

  function showTab(layout) {
    // Lock the LAYOUT pane to the STATS table's height (measured while STATS
    // is still visible) so the detail view doesn't resize when switching tabs.
    if (layout && statsEl.offsetHeight) layoutEl.style.height = statsEl.offsetHeight + 'px';
    tabStats.classList.toggle('recapTabOn', !layout);
    tabLayout.classList.toggle('recapTabOn', layout);
    statsEl.classList.toggle('hidden', layout);
    layoutEl.classList.toggle('hidden', !layout);
    if (layout && window.PlayByPlay && current) {
      const log = (current.stats && current.stats.log) || [];
      window.PlayByPlay.renderLog(layoutEl, log, current.names);
    }
  }

  function backToList() {
    detailEl.classList.add('hidden');
    listEl.classList.remove('hidden');
  }

  tabStats.addEventListener('click', () => showTab(false));
  tabLayout.addEventListener('click', () => showTab(true));
  backBtn.addEventListener('click', backToList);
  // Clicking the game's own row again (the header of its detail) returns to the
  // list — the same row you clicked to open it toggles you back.
  detailRow.addEventListener('click', backToList);

  window.PoolHistory = { open, hide };
})();

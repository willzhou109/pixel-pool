/* Lobby + matchmaking UI for Pixel Pool Online.
 *
 * Owns the lobby overlay's states (idle → searching → matched) and the socket
 * lifecycle while the player is in the lobby. auth.js hands off here once the
 * player is authenticated: activate(username, token) opens the connection,
 * deactivate() tears it down (logout). All server talk goes through net.js.
 *
 * Actual online gameplay isn't built yet — a found match currently just shows
 * who you're playing and who breaks. The shot-sync layer plugs in here next.
 */
(function () {
  'use strict';

  const $ = id => document.getElementById(id);
  const el = {
    status: $('lobbyStatus'),
    idle: $('lobbyIdle'), searching: $('lobbySearching'), matched: $('lobbyMatched'),
    findBtn: $('findMatchBtn'), cancelBtn: $('cancelMatchBtn'), leaveBtn: $('leaveMatchBtn'),
    matchInfo: $('matchInfo'),
  };
  const Net = window.PixelPoolNet;
  if (!el.idle || !Net) { console.warn('Lobby: missing deps'); return; }

  /* --------------------------------- state ------------------------------- */
  function showState(name) {
    el.idle.classList.toggle('hidden', name !== 'idle');
    el.searching.classList.toggle('hidden', name !== 'searching');
    el.matched.classList.toggle('hidden', name !== 'matched');
  }

  const STATUS_TEXT = {
    connecting: 'Connecting to server…',
    connected: '● Connected',
    disconnected: '○ Disconnected',
    error: 'Connection failed',
  };
  function setStatus(kind, detail) {
    if (el.status) el.status.textContent =
      (STATUS_TEXT[kind] || kind) + (kind === 'error' && detail ? ` (${detail})` : '');
    if (el.findBtn) el.findBtn.disabled = kind !== 'connected';
    // Losing the connection while searching/matched drops us back to idle.
    if (kind === 'disconnected' || kind === 'error') showState('idle');
  }

  /* ------------------------------ net events ----------------------------- */
  // Matchmaking status + the "searching" spinner live here. The actual match
  // hand-off (match-found → launch game) and opponent-left are owned by
  // online.js, which hides this overlay and starts the game.
  Net.on('status', setStatus);
  Net.on('waiting', () => showState('searching'));
  Net.on('match-found', () => showState('matched'));

  /* ------------------------------ ui buttons ----------------------------- */
  el.findBtn.addEventListener('click', () => { Net.findMatch(); showState('searching'); });
  el.cancelBtn.addEventListener('click', () => { Net.cancelMatch(); showState('idle'); });
  el.leaveBtn.addEventListener('click', () => { Net.leaveMatch(); showState('idle'); });

  /* ------------------------------ lifecycle ------------------------------ */
  function activate(username, token) {
    showState('idle');
    if (el.findBtn) el.findBtn.disabled = true;  // enabled once 'connected' arrives
    Net.connect(token);
  }
  function deactivate() {
    Net.cancelMatch();
    Net.leaveMatch();
    Net.disconnect();
    showState('idle');
  }
  // Called by online.js when a match ends/drops: re-show the lobby (still
  // connected) in its idle state, with an optional one-off note.
  function backToIdle(note) {
    showState('idle');
    document.getElementById('lobbyOverlay').classList.remove('hidden');
    if (note && el.status) el.status.textContent = note;
  }

  window.PixelPoolLobby = { activate, deactivate, backToIdle };
})();

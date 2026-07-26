/* Lobby + matchmaking UI for Pixel Pool Online.
 *
 * Owns the ONLINE panel's states (idle → searching → matched). That panel now
 * lives inline on the home screen (#homeOnline), shown when the player toggles
 * ONLINE — there's no separate lobby overlay anymore. The socket is opened at
 * login (auth.js) and lives for the whole session; enter() makes sure it's up
 * when ONLINE is selected, suspend() leaves matchmaking without dropping it
 * (toggling back to OFFLINE / leaving home), and deactivate() tears it down
 * (logout). All server talk goes through net.js.
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
  // ONLINE was just selected on the home screen: reset to idle and make sure
  // the socket is up (it usually already is, from login — connect() reuses the
  // live one and re-fires 'connected', which enables FIND MATCH).
  function enter(token) {
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
  // Toggling back to OFFLINE (or leaving the home screen): leave matchmaking but
  // keep the socket — the player stays connected for their whole session; only
  // logout disconnects.
  function suspend() {
    Net.cancelMatch();
    Net.leaveMatch();
    showState('idle');
  }
  // Called by online.js when a match ends/drops: return to the home screen's
  // ONLINE panel (still connected) in its idle state, with an optional one-off
  // note in place of the status line.
  function backToIdle(note) {
    showState('idle');
    if (window.PixelPoolMode) window.PixelPoolMode.showHome('online');
    if (note && el.status) el.status.textContent = note;
    else setStatus(Net.connected ? 'connected' : 'disconnected');
  }

  window.PixelPoolLobby = { enter, deactivate, suspend, backToIdle };
})();

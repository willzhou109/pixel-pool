/* Home screen for Pixel Pool — shown after LOG IN or CONTINUE AS GUEST.
 *
 * landing.js hands off here via window.PixelPoolMode.enter(username, isGuest).
 * Full-bleed layout over the dimmed, spinning table: pick a game (8-ball,
 * 9-ball and snooker are playable; the rest are "coming soon"), then toggle
 * OFFLINE or ONLINE.
 * The two live inline on this screen — no page navigation: OFFLINE shows the
 * local two-player setup (#homeOffline, players + PLAY, owned by game.js) and
 * ONLINE shows matchmaking (#homeOnline, owned by lobby.js). This module just
 * swaps which panel is visible and tells lobby.js to enter/suspend.
 * Guests can't go online — the multiplayer server rejects sockets without a
 * real session token — so ONLINE just tells them to log in.
 *
 * #modeOverlay also hosts the profile panel (#profileMain, owned by
 * js/profile.js) as a sibling of #homeMain — only one is shown at a time, but
 * both live inside the same overlay as the user menu (#userMenu) and chat bar
 * (#homeChat), so those two persist across home <-> profile navigation
 * instead of being torn down and rebuilt.
 *
 * The top-right user menu (avatar + name) drops down two actions: VIEW PROFILE
 * opens the profile page (js/profile.js) — whose FRIEND LIST tab is where
 * friends live — and LOG OUT ends the session.
 */
(function () {
  'use strict';

  const $ = id => document.getElementById(id);
  const overlay = $('modeOverlay');
  const welcome = $('modeWelcome');
  const note = $('modeNote');
  const offlineBtn = $('offlineBtn');
  const onlineBtn = $('onlineBtn');
  const homeOffline = $('homeOffline');
  const homeOnline = $('homeOnline');
  const profileBtn = $('profileBtn');
  const logoutBtn = $('modeLogoutBtn');
  const userMenu = $('userMenu');
  const userMenuBtn = $('userMenuBtn');
  const userMenuDrop = $('userMenuDrop');
  const userMenuName = $('userMenuName');
  const homeMain = $('homeMain');
  const profileMain = $('profileMain');
  const tabs = Array.from(document.querySelectorAll('.gameTab'));
  if (!overlay || !offlineBtn || !onlineBtn || !homeOffline || !homeOnline) {
    console.warn('Home: elements missing');
    return;
  }
  const Lobby = () => window.PixelPoolLobby;
  const authToken = () => (window.PixelPoolAuth ? window.PixelPoolAuth.getToken() : null);

  const GAME_NAMES = { '8ball': '8-BALL', '9ball': '9-BALL', '10ball': '10-BALL', snooker: 'SNOOKER' };
  // Games with rules behind them (game.js + js/nineball.js + js/snooker.js).
  // The rest of the tabs are placeholders that just say "coming soon".
  const PLAYABLE = { '8ball': true, '9ball': true, snooker: true };
  // 9-ball and snooker are local two-player only so far: matchmaking has no
  // game type on the wire, and the computer opponent only knows 8-ball.
  const ONLINE_GAMES = { '8ball': true };

  let guest = false;
  let currentUsername = null;
  let mode = 'offline'; // 'offline' | 'online' — what PLAY will launch
  let game = '8ball';   // which rule set the tabs have selected

  // Visual toggle only — swaps the highlighted button and the inline panel
  // shown below (offline setup vs. online matchmaking). Activating/suspending
  // the matchmaking socket is done by the click handlers and backToIdle, so
  // this can be reused to reflect state (e.g. returning from a match) without
  // resetting the lobby's status line.
  function setMode(m) {
    mode = m;
    offlineBtn.classList.toggle('sel', m === 'offline');
    onlineBtn.classList.toggle('sel', m === 'online');
    homeOffline.classList.toggle('hidden', m !== 'offline');
    homeOnline.classList.toggle('hidden', m !== 'online');
  }

  function enter(username, isGuest) {
    guest = !!isGuest;
    currentUsername = username;
    // Usernames keep their real case; GUEST/PLAYER are generic placeholders.
    const name = guest ? 'GUEST' : (username || 'PLAYER');
    if (welcome) welcome.textContent = 'WELCOME, ' + name + '!';
    if (userMenuName) userMenuName.textContent = name;
    // Paint the player's chosen avatar into the user menu + profile (js/avatarpicker.js).
    if (window.PoolAvatar) window.PoolAvatar.loadMine();
    setMenuOpen(false);
    if (note) note.textContent = '';
    // Land on the OFFLINE panel; ONLINE is a click away and activates the lobby.
    setMode('offline');
    [$('landingOverlay'), $('loginOverlay'), $('signupOverlay')]
      .forEach(o => o && o.classList.add('hidden'));
    // Always land on the home panel, not wherever profile was left showing.
    if (profileMain) profileMain.classList.add('hidden');
    if (homeMain) homeMain.classList.remove('hidden');
    overlay.classList.remove('hidden');
  }

  // Return to the home panel from elsewhere (e.g. the in-game QUIT button, or
  // lobby.js after a match ends) without re-running enter()'s welcome/profile
  // setup. An optional mode selects which inline panel to show; omitted, the
  // current selection is kept. This is visual only — it never re-activates the
  // lobby, so a status note set by the caller (e.g. "Opponent left") survives.
  function showHome(forceMode) {
    [$('landingOverlay'), $('loginOverlay'), $('signupOverlay')]
      .forEach(o => o && o.classList.add('hidden'));
    if (profileMain) profileMain.classList.add('hidden');
    if (homeMain) homeMain.classList.remove('hidden');
    overlay.classList.remove('hidden');
    if (forceMode) setMode(forceMode);
  }

  /* ------------------------------ game tabs ------------------------------ */
  // The games in PLAYABLE are live; the rest flash a "coming soon" note and
  // leave the selection where it was. Picking a game tells game.js which rule
  // set the next match runs (and re-racks the showcase table behind the menu).
  function setGame(id) {
    game = id;
    tabs.forEach(t => t.classList.toggle('sel', t.dataset.game === id));
    if (window.PoolMatch && window.PoolMatch.setGame) window.PoolMatch.setGame(id);
  }

  tabs.forEach(tab => tab.addEventListener('click', () => {
    const id = tab.dataset.game;
    if (!PLAYABLE[id]) {
      if (note) note.textContent = GAME_NAMES[id] + ' IS COMING SOON!';
      return;
    }
    setGame(id);
    if (!note) return;
    // Selecting a game that can't go online yet: drop back to the offline
    // panel rather than leaving a dead ONLINE selection showing.
    if (!ONLINE_GAMES[id]) {
      note.textContent = '';
      if (mode === 'online') {
        setMode('offline');
        if (Lobby()) Lobby().suspend();
      }
    } else {
      note.textContent = '';
    }
  }));

  /* --------------------------- offline / online --------------------------- */
  // Switching modes just swaps the inline panel — no page navigation. OFFLINE
  // leaves matchmaking (keeping the socket); ONLINE enters the lobby, which
  // reflects the live connection and enables FIND MATCH once connected.
  offlineBtn.addEventListener('click', () => {
    if (note) note.textContent = '';
    setMode('offline');
    if (Lobby()) Lobby().suspend();
  });
  onlineBtn.addEventListener('click', () => {
    if (guest) {
      if (note) note.textContent = 'Online play requires an account — please log in.';
      return;
    }
    if (!ONLINE_GAMES[game]) {
      if (note) note.textContent = GAME_NAMES[game] + ' ONLINE IS COMING SOON — PICK 8-BALL TO PLAY ONLINE.';
      return;
    }
    if (note) note.textContent = '';
    setMode('online');
    if (Lobby()) Lobby().enter(authToken());
  });

  /* ------------------------------ user menu ------------------------------ */
  // Top-right avatar+name button drops down VIEW PROFILE / LOG OUT.
  function setMenuOpen(open) {
    if (!userMenuDrop || !userMenuBtn) return;
    userMenuDrop.classList.toggle('hidden', !open);
    userMenuBtn.classList.toggle('open', open);
    userMenuBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
  }
  if (userMenuBtn && userMenuDrop) userMenuBtn.addEventListener('click', e => {
    e.stopPropagation();
    setMenuOpen(userMenuDrop.classList.contains('hidden'));
  });
  // Click-away and Escape close the menu.
  document.addEventListener('click', e => {
    if (userMenu && !userMenu.contains(e.target)) setMenuOpen(false);
  });
  window.addEventListener('keydown', e => { if (e.key === 'Escape') setMenuOpen(false); });

  if (profileBtn) profileBtn.addEventListener('click', () => {
    setMenuOpen(false);
    if (window.PixelPoolProfile) window.PixelPoolProfile.show(currentUsername, guest);
  });
  logoutBtn.addEventListener('click', () => {
    setMenuOpen(false);
    if (window.PixelPoolAuth) window.PixelPoolAuth.logout();
    if (window.PixelPoolLanding) window.PixelPoolLanding.show();
  });

  // The home chat bar is a real DM messenger now, owned by js/homechat.js.

  window.PixelPoolMode = { enter, showHome };
})();

/* Home screen for Pixel Pool — shown after LOG IN or CONTINUE AS GUEST.
 *
 * landing.js hands off here via window.PixelPoolMode.enter(username, isGuest).
 * Full-bleed layout over the dimmed, spinning table: pick a game (only 8-ball
 * exists — the other tabs are "coming soon"), pick OFFLINE or ONLINE, then hit
 * PLAY. Offline reveals the existing local two-player setup overlay (game.js
 * owns everything from there); online hands off to the lobby via auth.js.
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
  const setupOverlay = $('setupOverlay');
  const welcome = $('modeWelcome');
  const note = $('modeNote');
  const offlineBtn = $('offlineBtn');
  const onlineBtn = $('onlineBtn');
  const playBtn = $('playBtn');
  const profileBtn = $('profileBtn');
  const logoutBtn = $('modeLogoutBtn');
  const userMenu = $('userMenu');
  const userMenuBtn = $('userMenuBtn');
  const userMenuDrop = $('userMenuDrop');
  const userMenuName = $('userMenuName');
  const homeMain = $('homeMain');
  const profileMain = $('profileMain');
  const tabs = Array.from(document.querySelectorAll('.gameTab'));
  if (!overlay || !setupOverlay || !offlineBtn || !onlineBtn || !playBtn) {
    console.warn('Home: elements missing');
    return;
  }

  const GAME_NAMES = { '9ball': '9-BALL', '10ball': '10-BALL', snooker: 'SNOOKER' };

  let guest = false;
  let currentUsername = null;
  let mode = 'offline'; // 'offline' | 'online' — what PLAY will launch

  function setMode(m) {
    mode = m;
    offlineBtn.classList.toggle('sel', m === 'offline');
    onlineBtn.classList.toggle('sel', m === 'online');
  }

  function enter(username, isGuest) {
    guest = !!isGuest;
    currentUsername = username;
    const name = guest ? 'GUEST' : (username || 'PLAYER').toUpperCase();
    if (welcome) welcome.textContent = 'WELCOME, ' + name + '!';
    if (userMenuName) userMenuName.textContent = name;
    // Paint the player's chosen avatar into the user menu + profile (js/avatarpicker.js).
    if (window.PoolAvatar) window.PoolAvatar.loadMine();
    setMenuOpen(false);
    if (note) note.textContent = '';
    setMode(guest ? 'offline' : 'online'); // guests can't play online
    [$('landingOverlay'), $('loginOverlay'), $('signupOverlay'), $('lobbyOverlay')]
      .forEach(o => o && o.classList.add('hidden'));
    // Always land on the home panel, not wherever profile was left showing.
    if (profileMain) profileMain.classList.add('hidden');
    if (homeMain) homeMain.classList.remove('hidden');
    overlay.classList.remove('hidden');
  }

  // Return to the home panel from elsewhere (e.g. the in-game QUIT button)
  // without re-running enter()'s welcome/profile setup, which is already in
  // place from login.
  function showHome() {
    [$('landingOverlay'), $('loginOverlay'), $('signupOverlay'), $('lobbyOverlay'), setupOverlay]
      .forEach(o => o && o.classList.add('hidden'));
    if (profileMain) profileMain.classList.add('hidden');
    if (homeMain) homeMain.classList.remove('hidden');
    overlay.classList.remove('hidden');
  }

  /* ------------------------------ game tabs ------------------------------ */
  // Only 8-ball is playable; the rest flash a "coming soon" note and leave the
  // selection on 8-ball.
  tabs.forEach(tab => tab.addEventListener('click', () => {
    if (!note) return;
    const game = tab.dataset.game;
    note.textContent = game === '8ball' ? '' : GAME_NAMES[game] + ' IS COMING SOON!';
  }));

  /* --------------------------- offline / online --------------------------- */
  offlineBtn.addEventListener('click', () => {
    if (note) note.textContent = '';
    setMode('offline');
  });
  onlineBtn.addEventListener('click', () => {
    if (guest) {
      if (note) note.textContent = 'Online play requires an account — please log in.';
      return;
    }
    if (note) note.textContent = '';
    setMode('online');
  });

  /* --------------------------------- play -------------------------------- */
  playBtn.addEventListener('click', () => {
    if (mode === 'online') {
      if (window.PixelPoolAuth) window.PixelPoolAuth.openOnline();
      else if (note) note.textContent = 'Online is unavailable — auth.js failed to load.';
      return;
    }
    overlay.classList.add('hidden');
    setupOverlay.classList.remove('hidden');
  });

  const setupBackBtn = $('setupBackBtn');
  if (setupBackBtn) setupBackBtn.addEventListener('click', () => {
    setupOverlay.classList.add('hidden');
    overlay.classList.remove('hidden');
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

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
 * The right sidebar (profile / friends / chat / notifications) is placeholder
 * UI for features that aren't built yet; only LOG OUT does anything.
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
  const tabs = Array.from(document.querySelectorAll('.gameTab'));
  if (!overlay || !setupOverlay || !offlineBtn || !onlineBtn || !playBtn) {
    console.warn('Home: elements missing');
    return;
  }

  const GAME_NAMES = { '9ball': '9-BALL', '10ball': '10-BALL', snooker: 'SNOOKER' };

  let guest = false;
  let mode = 'offline'; // 'offline' | 'online' — what PLAY will launch

  function setMode(m) {
    mode = m;
    offlineBtn.classList.toggle('sel', m === 'offline');
    onlineBtn.classList.toggle('sel', m === 'online');
  }

  function enter(username, isGuest) {
    guest = !!isGuest;
    const name = guest ? 'GUEST' : (username || 'PLAYER').toUpperCase();
    if (welcome) welcome.textContent = 'WELCOME, ' + name + '!';
    if (profileBtn) profileBtn.textContent = name;
    if (note) note.textContent = '';
    setMode(guest ? 'offline' : 'online'); // guests can't play online
    [$('landingOverlay'), $('loginOverlay'), $('signupOverlay'), $('lobbyOverlay')]
      .forEach(o => o && o.classList.add('hidden'));
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

  /* -------------------------------- sidebar ------------------------------- */
  // profile / friends / chat / notifications are intentionally inert for now.
  logoutBtn.addEventListener('click', () => {
    if (window.PixelPoolAuth) window.PixelPoolAuth.logout();
    if (window.PixelPoolLanding) window.PixelPoolLanding.show();
  });

  window.PixelPoolMode = { enter };
})();

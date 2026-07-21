/* Home screen for Pixel Pool — shown after LOG IN or CONTINUE AS GUEST.
 *
 * landing.js hands off here via window.PixelPoolMode.enter(username, isGuest)
 * once the player is identified. OFFLINE reveals the existing local two-player
 * setup overlay; game.js owns everything from there. ONLINE hands off to the
 * account flow in auth.js — guests don't have an account, so ONLINE just
 * explains that and stops (the multiplayer backend requires a real session
 * token). LOG OUT clears any session and returns to the landing screen.
 */
(function () {
  'use strict';

  const modeOverlay = document.getElementById('modeOverlay');
  const setupOverlay = document.getElementById('setupOverlay');
  const welcome = document.getElementById('modeWelcome');
  const offlineBtn = document.getElementById('offlineBtn');
  const onlineBtn = document.getElementById('onlineBtn');
  const logoutBtn = document.getElementById('modeLogoutBtn');
  const note = document.getElementById('modeNote');
  if (!modeOverlay || !setupOverlay || !offlineBtn || !onlineBtn) {
    console.warn('Home: elements missing');
    return;
  }

  let guest = false;

  function enter(username, isGuest) {
    guest = !!isGuest;
    if (welcome) welcome.textContent = 'WELCOME, ' + (guest ? 'GUEST' : (username || 'PLAYER').toUpperCase()) + '!';
    if (note) note.textContent = '';
    [document.getElementById('landingOverlay'), document.getElementById('loginOverlay'),
     document.getElementById('signupOverlay'), document.getElementById('lobbyOverlay')]
      .forEach(o => o && o.classList.add('hidden'));
    modeOverlay.classList.remove('hidden');
  }

  offlineBtn.addEventListener('click', () => {
    modeOverlay.classList.add('hidden');
    setupOverlay.classList.remove('hidden');
  });

  // Hand off to the online account flow (lobby) in auth.js. Guests have no
  // account/session token, and the multiplayer server rejects sockets without
  // one, so send them to log in instead of attempting a connection.
  onlineBtn.addEventListener('click', () => {
    if (guest) {
      if (note) note.textContent = 'Online play requires an account — please log in.';
      return;
    }
    if (window.PixelPoolAuth) window.PixelPoolAuth.openOnline();
    else if (note) note.textContent = 'Online is unavailable — auth.js failed to load.';
  });

  logoutBtn.addEventListener('click', () => {
    if (window.PixelPoolAuth) window.PixelPoolAuth.logout();
    if (window.PixelPoolLanding) window.PixelPoolLanding.show();
  });

  window.PixelPoolMode = { enter };
})();

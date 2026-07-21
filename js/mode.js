/* Mode-select screen for Pixel Pool.
 *
 * The first thing the player sees. OFFLINE is the existing local two-player
 * game — picking it just reveals the normal setup overlay, and game.js owns
 * everything from there. ONLINE hands off to the account flow in auth.js
 * (login / signup); the actual multiplayer match isn't built yet.
 */
(function () {
  'use strict';

  const modeOverlay = document.getElementById('modeOverlay');
  const setupOverlay = document.getElementById('setupOverlay');
  const offlineBtn = document.getElementById('offlineBtn');
  const onlineBtn = document.getElementById('onlineBtn');
  const note = document.getElementById('modeNote');
  if (!modeOverlay || !setupOverlay || !offlineBtn || !onlineBtn) {
    console.warn('ModeSelect: elements missing');
    return;
  }

  offlineBtn.addEventListener('click', () => {
    modeOverlay.classList.add('hidden');
    setupOverlay.classList.remove('hidden');
  });

  // Hand off to the online account flow (login / signup) in auth.js.
  onlineBtn.addEventListener('click', () => {
    if (window.PixelPoolAuth) window.PixelPoolAuth.openOnline();
    else if (note) note.textContent = 'Online is unavailable — auth.js failed to load.';
  });
})();

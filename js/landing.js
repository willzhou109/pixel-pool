/* Landing screen for Pixel Pool — the first thing the player sees.
 *
 * Offers LOG IN (hands off to the account flow in auth.js) or CONTINUE AS
 * GUEST (skips straight to the home screen in mode.js with no account).
 */
(function () {
  'use strict';

  const overlay = document.getElementById('landingOverlay');
  const loginBtn = document.getElementById('landingLoginBtn');
  const guestBtn = document.getElementById('landingGuestBtn');
  if (!overlay || !loginBtn || !guestBtn) {
    console.warn('Landing: elements missing');
    return;
  }

  function show() {
    [document.getElementById('modeOverlay'), document.getElementById('loginOverlay'),
     document.getElementById('signupOverlay'), document.getElementById('lobbyOverlay')]
      .forEach(o => o && o.classList.add('hidden'));
    overlay.classList.remove('hidden');
  }

  loginBtn.addEventListener('click', () => {
    if (window.PixelPoolAuth) window.PixelPoolAuth.showLogin();
  });

  guestBtn.addEventListener('click', () => {
    overlay.classList.add('hidden');
    if (window.PixelPoolMode) window.PixelPoolMode.enter(null, true);
  });

  window.PixelPoolLanding = { show };
})();

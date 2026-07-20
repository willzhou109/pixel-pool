/* Keyboard controls for Pixel Pool.
 *
 * Complements the mouse controls in game.js. Drives the game only through the
 * window.PoolControls API that game.js exposes, so all key handling lives here.
 *
 *   Camera : Arrow keys / WASD to orbit, Q / E to zoom in / out
 *   Shot   : hold SPACE to build power (the meter rises), release to shoot
 *   Cancel : ESC to cancel a charge
 *   Help   : H to toggle the on-screen controls
 */
(function () {
  'use strict';

  const C = window.PoolControls;
  if (!C) { console.warn('PoolControls API not found — keyboard disabled'); return; }

  const ORBIT_SPEED = 1.7;   // radians / second
  const ZOOM_RATE   = 1.9;   // exponential zoom factor per second
  const POWER_RATE  = 0.85;  // fraction of full power gained per second while charging

  const keys = new Set();    // currently-held keys (lower-cased e.key)
  let spaceHeld = false;

  // Don't hijack keys while the player is typing in a form field or on a button.
  function typingTarget(e) {
    const t = e.target;
    return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' ||
                 t.tagName === 'BUTTON' || t.tagName === 'SELECT');
  }

  const CAMERA_KEYS = new Set([
    'arrowleft', 'arrowright', 'arrowup', 'arrowdown',
    'a', 'd', 'w', 's', 'q', 'e',
  ]);

  window.addEventListener('keydown', e => {
    if (typingTarget(e)) return;
    const k = e.key.toLowerCase();
    const isSpace = e.code === 'Space' || k === ' ';

    if (k === 'h') { e.preventDefault(); C.toggleHelp(); return; }
    if (k === 'escape') { C.cancelCharge(); return; }

    if (isSpace) {
      e.preventDefault();
      if (!spaceHeld) {              // first frame of the press
        spaceHeld = true;
        if (C.canAim()) C.startCharge();
      }
      return;
    }

    if (CAMERA_KEYS.has(k)) {
      e.preventDefault();            // stop arrow keys from scrolling the page
      keys.add(k);
    }
  });

  window.addEventListener('keyup', e => {
    const k = e.key.toLowerCase();
    if (e.code === 'Space' || k === ' ') {
      spaceHeld = false;
      C.shoot();                     // release to take the shot (no-op unless charging)
      return;
    }
    keys.delete(k);
  });

  // Losing focus (e.g. alt-tab) should release everything so keys don't "stick".
  window.addEventListener('blur', () => { keys.clear(); spaceHeld = false; });

  let last = performance.now();
  function loop(now) {
    requestAnimationFrame(loop);
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (!C.inPlay()) return;

    // Aim/orbit the camera — locked while charging so the aim can't drift.
    if (!C.isCharging()) {
      let dyaw = 0, dpitch = 0;
      if (keys.has('arrowleft')  || keys.has('a')) dyaw += ORBIT_SPEED * dt;
      if (keys.has('arrowright') || keys.has('d')) dyaw -= ORBIT_SPEED * dt;
      if (keys.has('arrowup')    || keys.has('w')) dpitch += ORBIT_SPEED * dt;
      if (keys.has('arrowdown')  || keys.has('s')) dpitch -= ORBIT_SPEED * dt;
      if (dyaw || dpitch) C.orbit(dyaw, dpitch);

      if (keys.has('q')) C.zoom(Math.exp(-ZOOM_RATE * dt)); // zoom in
      if (keys.has('e')) C.zoom(Math.exp(ZOOM_RATE * dt));  // zoom out
    }

    // Build power while SPACE is held during a charge.
    if (spaceHeld && C.isCharging()) C.adjustPower(POWER_RATE * dt);
  }
  requestAnimationFrame(loop);
})();

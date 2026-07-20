/* In-game settings panel for Pixel Pool.
 *
 * Consolidates the live controls — table style, aim assist and keyboard
 * sensitivity — into a single panel toggled from a gear button in the
 * bottom-right corner, replacing the three separate floating bars.
 *
 * The individual controls still build themselves into their own containers
 * (#styleSwitch via game.js, #aimSwitch via aimassist.js, #sensSwitch via
 * sensitivity.js). This module only owns the panel's open/close behaviour and
 * its visibility during a match, exposed to game.js as window.SettingsPanel.
 */
(function () {
  'use strict';

  const btn = document.getElementById('settingsBtn');
  const panel = document.getElementById('settingsPanel');
  if (!btn || !panel) { console.warn('SettingsPanel: elements missing'); return; }

  let open = false;

  function setOpen(v) {
    open = v;
    panel.classList.toggle('hidden', !open);
    btn.classList.toggle('open', open);
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  btn.addEventListener('click', e => { e.stopPropagation(); setOpen(!open); });

  // Clicking anywhere outside the panel (and off the button) closes it.
  document.addEventListener('click', e => {
    if (!open || panel.contains(e.target) || btn.contains(e.target)) return;
    setOpen(false);
  });

  // ESC closes the panel (keyboard.js separately uses ESC to cancel a charge).
  window.addEventListener('keydown', e => {
    if (e.key === 'Escape' && open) setOpen(false);
  });

  // Shown when a match starts, hidden (and force-closed) between matches.
  window.SettingsPanel = {
    show() { btn.classList.remove('hidden'); },
    hide() { setOpen(false); btn.classList.add('hidden'); },
  };
})();

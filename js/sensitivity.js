/* Keyboard sensitivity control for Pixel Pool.
 *
 * Owns a single multiplier applied to every keyboard-driven action in
 * keyboard.js — camera orbit (arrows / WASD), zoom (Q / E) and the SPACE power
 * build. 100% is today's original tuned rate and also the ceiling — anything
 * faster is overkill. Defaults to 25%; lower feels slower/finer, down to 1%.
 *
 * Built into the in-game switcher (#sensSwitch), offering a slider plus a
 * number box for entering an exact percentage. The chosen value persists
 * across sessions. keyboard.js reads it via window.KeyboardSensitivity.
 */
(function () {
  'use strict';

  const MIN = 0.01, MAX = 1.0, DEFAULT = 0.25;   // 1%..100% — 100% is today's tuned rate
  const STORE_KEY = 'pixelpool.kbdSensitivity';
  // One-time forced reset to the new default, even for players with an old
  // saved value — bump this key whenever DEFAULT changes and should override
  // everyone's existing setting. After this runs once, a player's own choice
  // (via apply()) persists normally again.
  const RESET_KEY = 'pixelpool.kbdSensitivity.resetV2';

  const clamp = v => Math.max(MIN, Math.min(MAX, v));
  const pct = v => Math.round(v * 100);

  let value = DEFAULT;
  try {
    if (!localStorage.getItem(RESET_KEY)) {
      localStorage.removeItem(STORE_KEY);
      localStorage.setItem(RESET_KEY, '1');
    }
    const saved = parseFloat(localStorage.getItem(STORE_KEY));
    if (isFinite(saved)) value = clamp(saved);
  } catch (e) { /* storage unavailable — fall back to default */ }

  const sliders = [];  // range inputs, all kept in sync
  const numbers = [];  // number inputs (percent), all kept in sync

  // Set the sensitivity and reflect it in every copy of the control.
  function apply(v) {
    if (!isFinite(v)) return;
    value = clamp(v);
    try { localStorage.setItem(STORE_KEY, String(value)); } catch (e) { /* ignore */ }
    const p = pct(value);
    for (const s of sliders) s.value = String(p);
    for (const n of numbers) n.value = String(p);
  }

  function buildInto(container) {
    if (!container) return;

    const slider = document.createElement('input');
    slider.type = 'range';
    slider.className = 'sensSlider';
    slider.min = String(pct(MIN)); slider.max = String(pct(MAX)); slider.step = '1';
    slider.value = String(pct(value));
    slider.setAttribute('aria-label', 'Keyboard sensitivity');
    slider.addEventListener('input', () => apply(parseFloat(slider.value) / 100));

    const num = document.createElement('input');
    num.type = 'number';
    num.className = 'sensNum';
    num.min = String(pct(MIN)); num.max = String(pct(MAX)); num.step = '1';
    num.value = String(pct(value));
    num.setAttribute('aria-label', 'Keyboard sensitivity percent');
    // Commit on change/blur (not each keystroke) so typing an exact value works.
    const commit = () => apply(parseFloat(num.value) / 100);
    num.addEventListener('change', commit);
    num.addEventListener('blur', commit);

    const box = document.createElement('span');
    box.className = 'sensPctWrap';
    box.appendChild(num);
    const sign = document.createElement('span');
    sign.textContent = '%';
    box.appendChild(sign);

    container.appendChild(slider);
    container.appendChild(box);
    sliders.push(slider);
    numbers.push(num);
  }

  buildInto(document.getElementById('sensSwitch'));  // in-game switcher

  window.KeyboardSensitivity = { value() { return value; } };
})();

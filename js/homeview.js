/* "Change view" control for the home & profile screens.
 *
 * A bottom-center button that opens a collapsible panel (same look and
 * open/close behaviour as the in-game settings panel, js/settings.js) letting
 * the player cycle the same table style and background used in a match
 * (window.PoolTableStyles from js/game.js, window.PoolBackgrounds from
 * js/backgrounds.js) while just looking at the home screen's spinning table.
 *
 * Lives as a direct sibling of #homeMain / #profileMain inside #modeOverlay
 * (like #homeSide and #homeChat), so it persists across home <-> profile
 * navigation instead of being torn down and rebuilt.
 */
(function () {
  'use strict';

  const btn = document.getElementById('homeViewBtn');
  const panel = document.getElementById('homeViewPanel');
  if (!btn || !panel) { console.warn('HomeView: elements missing'); return; }

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

  window.addEventListener('keydown', e => {
    if (e.key === 'Escape' && open) setOpen(false);
  });

  const stylePrev = document.getElementById('homeStylePrev');
  const styleNext = document.getElementById('homeStyleNext');
  if (stylePrev) stylePrev.addEventListener('click', () => { if (window.PoolTableStyles) window.PoolTableStyles.prev(); });
  if (styleNext) styleNext.addEventListener('click', () => { if (window.PoolTableStyles) window.PoolTableStyles.next(); });

  const bgPrev = document.getElementById('homeBgPrev');
  const bgNext = document.getElementById('homeBgNext');
  if (bgPrev) bgPrev.addEventListener('click', () => {
    if (window.PoolBackgrounds) window.PoolBackgrounds.apply(window.PoolBackgrounds.current() - 1, true);
  });
  if (bgNext) bgNext.addEventListener('click', () => {
    if (window.PoolBackgrounds) window.PoolBackgrounds.apply(window.PoolBackgrounds.current() + 1, true);
  });
})();

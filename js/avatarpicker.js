/* Profile-picture picker for Pixel Pool — an emoji on a colored tile.
 *
 * The signed-in player's avatar shows in two always-present spots: the top-right
 * user-menu button (#userAvatar) and the profile page (#profileAvatar). This
 * module owns rendering an avatar into any element (apply), keeping those two in
 * sync with the player's current choice (loadMine / applyMine), and the picker
 * modal (#avatarOverlay) where they change it.
 *
 * The pickable palette is fetched from the server (GET /api/avatar/options) so
 * it's never hard-coded here; the server (server/avatar.js) is the single source
 * of truth and re-validates any saved choice. Guests have no server-side avatar,
 * so the picker is a no-op for them and they just see the DEFAULT.
 */
(function () {
  'use strict';

  const $ = id => document.getElementById(id);
  // Same per-tab session key as js/auth.js.
  const getToken = () => { try { return sessionStorage.getItem('pp_token'); } catch { return null; } };

  const overlay = $('avatarOverlay');
  const preview = $('avatarPreview');
  const emojiGrid = $('avatarEmojiGrid');
  const colorRow = $('avatarColorRow');
  const errEl = $('avatarErr');
  const saveBtn = $('avatarSaveBtn');
  const cancelBtn = $('avatarCancelBtn');

  // Kept in step with server/avatar.js DEFAULT (first emoji + first color).
  const DEFAULT = { emoji: '🎱', color: '#2f6f47' };
  let mine = { ...DEFAULT };   // the signed-in player's current avatar (cache)
  let opts = null;             // {emojis, colors} fetched once from the server
  let sel = { ...DEFAULT };    // the in-picker selection
  let onSaved = null;          // optional callback after a successful save

  /* ----------------------------- rendering ------------------------------- */
  // Render an avatar into any element: emoji as centered text on a color tile.
  function apply(el, av) {
    if (!el || !av) return;
    el.classList.add('avatarEmoji');
    el.style.backgroundImage = 'none';   // drop the default SVG the CSS set
    el.style.backgroundColor = av.color;
    el.textContent = av.emoji;
  }
  const displayEls = () => [$('userAvatar'), $('profileAvatar')].filter(Boolean);
  function applyMine() { displayEls().forEach(el => apply(el, mine)); }

  /* ------------------------------- loading ------------------------------- */
  // Pull the signed-in player's avatar from /api/me and paint the display spots.
  // Guests (no token) just get the DEFAULT.
  async function loadMine() {
    const token = getToken();
    if (!token) { mine = { ...DEFAULT }; applyMine(); return mine; }
    try {
      const res = await fetch('/api/me', { headers: { Authorization: 'Bearer ' + token } });
      const data = await res.json();
      if (res.ok && data.avatar && data.avatar.emoji) {
        mine = { emoji: data.avatar.emoji, color: data.avatar.color };
      }
    } catch { /* leave the current cache; applyMine paints whatever we have */ }
    applyMine();
    return mine;
  }

  async function fetchOptions() {
    if (opts) return opts;
    try {
      const res = await fetch('/api/avatar/options');
      const data = await res.json();
      if (res.ok && Array.isArray(data.emojis)) opts = { emojis: data.emojis, colors: data.colors || [] };
    } catch { /* fall through to a minimal default palette */ }
    if (!opts) opts = { emojis: [DEFAULT.emoji], colors: [DEFAULT.color] };
    return opts;
  }

  /* -------------------------------- picker ------------------------------- */
  function renderGrid() {
    emojiGrid.innerHTML = '';
    for (const em of opts.emojis) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'avatarEmojiOpt';
      b.dataset.emoji = em;
      b.textContent = em;
      b.addEventListener('click', () => { sel = { ...sel, emoji: em }; syncSel(); });
      emojiGrid.appendChild(b);
    }
    colorRow.innerHTML = '';
    for (const col of opts.colors) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'swatch avatarColorSw';
      b.dataset.color = col;
      b.style.background = col;
      b.addEventListener('click', () => { sel = { ...sel, color: col }; syncSel(); });
      colorRow.appendChild(b);
    }
  }

  // Reflect the current selection: highlight the chosen emoji/color and preview.
  function syncSel() {
    for (const b of emojiGrid.children) b.classList.toggle('sel', b.dataset.emoji === sel.emoji);
    for (const b of colorRow.children) b.classList.toggle('sel', b.dataset.color === sel.color);
    apply(preview, sel);
    if (errEl) errEl.textContent = '';
  }

  async function open(onSavedCb) {
    if (!overlay || !getToken()) return; // guests can't save an avatar
    onSaved = onSavedCb || null;
    sel = { ...mine };
    if (errEl) errEl.textContent = '';
    overlay.classList.remove('hidden');
    await fetchOptions();
    renderGrid();
    syncSel();
  }
  function close() { if (overlay) overlay.classList.add('hidden'); }

  async function save() {
    const token = getToken();
    if (!token) return;
    if (saveBtn) saveBtn.disabled = true;
    try {
      const res = await fetch('/api/avatar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify(sel),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { if (errEl) errEl.textContent = data.error || 'Couldn’t save. Try again.'; return; }
      mine = { emoji: data.avatar.emoji, color: data.avatar.color };
      applyMine();
      close();
      if (onSaved) onSaved(mine);
    } catch {
      if (errEl) errEl.textContent = 'Couldn’t save — is the server running?';
    } finally {
      if (saveBtn) saveBtn.disabled = false;
    }
  }

  if (saveBtn) saveBtn.addEventListener('click', save);
  if (cancelBtn) cancelBtn.addEventListener('click', close);
  // Backdrop click + Escape close the picker.
  if (overlay) overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
  window.addEventListener('keydown', e => {
    if (e.key === 'Escape' && overlay && !overlay.classList.contains('hidden')) close();
  });

  window.PoolAvatar = { apply, applyMine, loadMine, open, get mine() { return mine; } };
})();

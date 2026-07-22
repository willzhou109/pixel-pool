/* Profile page for Pixel Pool — reached by clicking the name button on the
 * home screen's sidebar.
 *
 * Lives inside #modeOverlay as a second full-bleed panel (#profileMain),
 * swapped in for #homeMain rather than shown in its own overlay — that way
 * the sidebar and chat bar (also direct children of #modeOverlay) never
 * unmount when navigating between home and profile; they persist across both.
 *
 * Everything except the username and join date is a placeholder: avatar and
 * country flag are blank boxes, rating is unrated (no rating system yet),
 * friends is hard-coded to 0 (no friends feature yet), and GAME HISTORY /
 * STATS / FRIEND LIST are dummy buttons. The join date is real — fetched
 * from /api/me, which now returns the account's created_at.
 *
 * show(username, isGuest) only supports the signed-in player's own profile
 * for now (there's no way yet to browse to another user), but takes a
 * username so a future "view other profiles" entry point can reuse it.
 */
(function () {
  'use strict';

  const $ = id => document.getElementById(id);
  const modeOverlay = $('modeOverlay');
  const homeMain = $('homeMain');
  const profileMain = $('profileMain');
  const nameEl = $('profileName');
  const joinedEl = $('profileJoined');
  const note = $('profileNote');
  const logoBtn = $('profileLogo');
  const tabBtns = [$('gameHistoryBtn'), $('statsBtn'), $('friendListBtn')];
  if (!modeOverlay || !homeMain || !profileMain || !nameEl || !joinedEl || !logoBtn) {
    console.warn('Profile: elements missing');
    return;
  }

  // Same sessionStorage key auth.js uses for the token (see js/auth.js —
  // per-tab on purpose, not shared via localStorage).
  const getToken = () => { try { return sessionStorage.getItem('pp_token'); } catch { return null; } };

  function formatJoined(createdAt) {
    if (!createdAt) return 'Joined —';
    // SQLite's datetime('now') returns "YYYY-MM-DD HH:MM:SS" (UTC, no zone).
    const d = new Date(createdAt.replace(' ', 'T') + 'Z');
    if (isNaN(d.getTime())) return 'Joined —';
    return 'Joined ' + d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  }

  async function show(username, isGuest) {
    nameEl.textContent = (isGuest ? 'GUEST' : (username || 'PLAYER')).toUpperCase();
    joinedEl.textContent = isGuest ? 'No account' : 'Joined …';
    note.textContent = '';
    homeMain.classList.add('hidden');
    profileMain.classList.remove('hidden');
    modeOverlay.classList.remove('hidden'); // should already be visible — just in case

    if (isGuest) return;
    const token = getToken();
    if (!token) { joinedEl.textContent = 'Joined —'; return; }
    try {
      const res = await fetch('/api/me', { headers: { Authorization: `Bearer ${token}` } });
      const data = await res.json();
      joinedEl.textContent = res.ok ? formatJoined(data.createdAt) : 'Joined —';
    } catch {
      joinedEl.textContent = 'Joined —';
    }
  }

  function back() {
    profileMain.classList.add('hidden');
    homeMain.classList.remove('hidden');
  }

  // GAME HISTORY / STATS / FRIEND LIST are intentionally inert for now.
  tabBtns.forEach(btn => btn && btn.addEventListener('click', () => {
    note.textContent = 'Coming soon!';
  }));
  // The logo doubles as the back button, same spot as on the home screen.
  logoBtn.addEventListener('click', back);

  window.PixelPoolProfile = { show };
})();

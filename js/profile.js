/* Profile page for Pixel Pool — reached by clicking the name button on the
 * home screen's sidebar.
 *
 * Lives inside #modeOverlay as a second full-bleed panel (#profileMain),
 * swapped in for #homeMain rather than shown in its own overlay — that way
 * the sidebar and chat bar (also direct children of #modeOverlay) never
 * unmount when navigating between home and profile; they persist across both.
 *
 * The username, join date (from /api/me) and the GAME HISTORY tab (delegated
 * to js/history.js, opened by default for signed-in players) are real.
 * Everything else is a placeholder: avatar and country flag are blank boxes,
 * rating is unrated (no rating system yet), friends is hard-coded to 0 (no
 * friends feature yet), and STATS / FRIEND LIST are dummy buttons.
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

  let guest = false; // set by show(); guests have no server-side history

  // Tab strip: GAME HISTORY (js/history.js) and FRIEND LIST (js/friends.js) are
  // real; STATS is still a placeholder. `which` is 'history' | 'friends' | null.
  function selectTab(which) {
    if (tabBtns[0]) tabBtns[0].classList.toggle('sel', which === 'history');
    if (tabBtns[1]) tabBtns[1].classList.remove('sel');
    if (tabBtns[2]) tabBtns[2].classList.toggle('sel', which === 'friends');
    if (window.PoolHistory) (which === 'history' ? window.PoolHistory.open() : window.PoolHistory.hide());
    if (window.PixelPoolFriends) (which === 'friends' ? window.PixelPoolFriends.open() : window.PixelPoolFriends.hide());
  }

  function formatJoined(createdAt) {
    if (!createdAt) return 'Joined —';
    // SQLite's datetime('now') returns "YYYY-MM-DD HH:MM:SS" (UTC, no zone).
    const d = new Date(createdAt.replace(' ', 'T') + 'Z');
    if (isNaN(d.getTime())) return 'Joined —';
    return 'Joined ' + d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  }

  async function show(username, isGuest, tab) {
    guest = !!isGuest;
    nameEl.textContent = (isGuest ? 'GUEST' : (username || 'PLAYER')).toUpperCase();
    joinedEl.textContent = isGuest ? 'No account' : 'Joined …';
    note.textContent = '';
    homeMain.classList.add('hidden');
    profileMain.classList.remove('hidden');
    modeOverlay.classList.remove('hidden'); // should already be visible — just in case
    // Land on GAME HISTORY when signed in, unless a caller asked for a tab
    // (e.g. the FRIENDS sidebar button opens straight to the friend list).
    selectTab(isGuest ? null : (tab || 'history'));

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

  // GAME HISTORY and FRIEND LIST are live; STATS is still a stub.
  if (tabBtns[0]) tabBtns[0].addEventListener('click', () => {
    if (guest) { note.textContent = 'Game history needs an account — log in to track your games.'; return; }
    note.textContent = '';
    selectTab('history');
  });
  if (tabBtns[2]) tabBtns[2].addEventListener('click', () => {
    if (guest) { note.textContent = 'Friends need an account — log in to add friends.'; return; }
    note.textContent = '';
    selectTab('friends');
  });
  if (tabBtns[1]) tabBtns[1].addEventListener('click', () => {
    note.textContent = 'Coming soon!';
    selectTab(null);
  });
  // The logo doubles as the back button, same spot as on the home screen.
  logoBtn.addEventListener('click', back);

  window.PixelPoolProfile = { show };
})();

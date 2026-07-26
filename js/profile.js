/* Profile page for Pixel Pool — reached by clicking the name button on the
 * home screen's sidebar.
 *
 * Lives inside #modeOverlay as a second full-bleed panel (#profileMain),
 * swapped in for #homeMain rather than shown in its own overlay — that way
 * the sidebar and chat bar (also direct children of #modeOverlay) never
 * unmount when navigating between home and profile; they persist across both.
 *
 * The username, join date, Elo rating, friend count (all from /api/me), the
 * clickable avatar (js/avatarpicker.js) and the GAME HISTORY (js/history.js),
 * STATS (js/careerstats.js) and FRIEND LIST (js/friends.js) tabs are all real.
 *
 * show(username, isGuest) renders your own profile; showUser(username) renders
 * ANOTHER player's — the same page and all three tabs, but their public data
 * (header from /api/users/:u/summary; GAME HISTORY, STATS and FRIEND LIST from
 * the matching /api/users/:u/* endpoints). Their friend list is read-only, each
 * person tagged by YOUR relationship to them (js/friends.js openOther).
 *
 * Navigation is a stack (navStack), so profile-to-profile hops (me -> dan ->
 * dan's friend erin) let BACK step back one page at a time — restoring the tab
 * you left each on — while the top PIXEL POOL logo always jumps home.
 */
(function () {
  'use strict';

  const $ = id => document.getElementById(id);
  const modeOverlay = $('modeOverlay');
  const homeMain = $('homeMain');
  const profileMain = $('profileMain');
  const nameEl = $('profileName');
  const ratingEl = $('profileRating');
  const joinedEl = $('profileJoined');
  const friendsMetaEl = $('profileFriends');
  const avatarEl = $('profileAvatar');
  const note = $('profileNote');
  const logoBtn = $('profileLogo');
  const backBtn = $('profileBack');
  const tabBtns = [$('gameHistoryBtn'), $('statsBtn'), $('friendListBtn')];
  if (!modeOverlay || !homeMain || !profileMain || !nameEl || !joinedEl || !logoBtn) {
    console.warn('Profile: elements missing');
    return;
  }

  // Same sessionStorage key auth.js uses for the token (see js/auth.js —
  // per-tab on purpose, not shared via localStorage).
  const getToken = () => { try { return sessionStorage.getItem('pp_token'); } catch { return null; } };

  let guest = false;          // set by show(); guests have no server-side history
  let viewingSelf = true;     // false while viewing another player's profile
  let currentUser = null;     // the username currently displayed
  let selfUsername = null;    // the signed-in player (captured by show())
  let selfGuest = false;      // remembered so navigation can re-open your own profile

  // Navigation stack of pages to return to, so BACK works through a chain of
  // profile-to-profile hops (e.g. me -> dan -> dan's friend erin -> BACK -> dan).
  // Each entry is { home:true } or a page descriptor { username, isGuest, self }.
  // The active page's tab is tracked on `currentPage` so BACK restores it too.
  const navStack = [];
  let currentPage = { home: true };

  // Tab strip: GAME HISTORY (js/history.js), STATS (js/careerstats.js) and
  // FRIEND LIST (js/friends.js). On another player's profile each sub-module is
  // pointed at their public data (open(username) / openOther(username)).
  // `which` is 'history' | 'stats' | 'friends' | null.
  function selectTab(which) {
    const viewName = viewingSelf ? null : currentUser; // null => own endpoints
    if (which && currentPage && !currentPage.home) currentPage.tab = which; // remembered for BACK
    if (tabBtns[0]) tabBtns[0].classList.toggle('sel', which === 'history');
    if (tabBtns[1]) tabBtns[1].classList.toggle('sel', which === 'stats');
    if (tabBtns[2]) tabBtns[2].classList.toggle('sel', which === 'friends');
    if (window.PoolHistory) (which === 'history' ? window.PoolHistory.open(viewName) : window.PoolHistory.hide());
    if (window.PoolCareerStats) (which === 'stats' ? window.PoolCareerStats.open(viewName) : window.PoolCareerStats.hide());
    if (window.PixelPoolFriends) {
      if (which !== 'friends') window.PixelPoolFriends.hide();
      else if (viewingSelf) window.PixelPoolFriends.open();
      else window.PixelPoolFriends.openOther(currentUser);
    }
  }

  function formatJoined(createdAt) {
    if (!createdAt) return 'Joined —';
    // SQLite's datetime('now') returns "YYYY-MM-DD HH:MM:SS" (UTC, no zone).
    const d = new Date(createdAt.replace(' ', 'T') + 'Z');
    if (isNaN(d.getTime())) return 'Joined —';
    return 'Joined ' + d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  }

  // Revert the avatar tile to the neutral CSS default (used briefly while
  // another player's avatar loads, so we never flash your own on their profile).
  function resetAvatar() {
    if (!avatarEl) return;
    avatarEl.classList.remove('avatarEmoji');
    avatarEl.style.backgroundColor = '';
    avatarEl.style.backgroundImage = '';
    avatarEl.textContent = '';
  }

  // Enter your own profile (from the home user menu). Resets the nav stack with
  // home as the only place BACK can return to.
  function show(username, isGuest, tab) {
    selfUsername = username;
    selfGuest = !!isGuest;
    navStack.length = 0;
    navStack.push({ home: true });
    currentPage = { username, isGuest: !!isGuest, self: true, tab: tab || 'history' };
    return renderProfile(currentPage);
  }

  // Navigate to another player's profile (from a "View Profile" link), pushing
  // the current page so BACK returns here. If the name is you, shows your own.
  function showUser(username) {
    if (!username) return;
    const isMe = selfUsername && username.toLowerCase() === selfUsername.toLowerCase();
    navStack.push(currentPage);
    currentPage = isMe
      ? { username: selfUsername, isGuest: selfGuest, self: true, tab: 'history' }
      : { username, isGuest: false, self: false, tab: 'history' };
    return renderProfile(currentPage);
  }

  const formatFriends = n => n + (n === 1 ? ' FRIEND' : ' FRIENDS');

  async function renderProfile({ username, isGuest, self, tab }) {
    guest = !!isGuest;
    viewingSelf = self;
    currentUser = username;
    // Show the username in its real case (GUEST/PLAYER are generic placeholders);
    // the fetch below refines it to the server's canonical spelling.
    nameEl.textContent = isGuest ? 'GUEST' : (username || 'PLAYER');
    if (tabBtns[2]) tabBtns[2].classList.remove('hidden'); // friend list works for anyone now
    // Only your own picture is editable (shows the pencil badge).
    if (avatarEl) avatarEl.classList.toggle('editable', self && !isGuest);
    if (self) {
      if (window.PoolAvatar) window.PoolAvatar.applyMine(); // repaint from the cache
    } else {
      resetAvatar(); // painted from their summary below
    }
    ratingEl.textContent = isGuest ? 'RATING: UNRATED' : 'RATING: …';
    joinedEl.textContent = isGuest ? 'No account' : 'Joined …';
    if (friendsMetaEl) friendsMetaEl.textContent = isGuest ? '0 FRIENDS' : '… FRIENDS';
    note.textContent = '';
    homeMain.classList.add('hidden');
    profileMain.classList.remove('hidden');
    modeOverlay.classList.remove('hidden'); // should already be visible — just in case
    // Land on the requested tab (GAME HISTORY by default).
    selectTab(isGuest ? null : (tab || 'history'));

    if (isGuest) return;
    const token = getToken();
    if (!token) { joinedEl.textContent = 'Joined —'; ratingEl.textContent = 'RATING: UNRATED'; return; }
    try {
      const path = self ? '/api/me' : '/api/users/' + encodeURIComponent(username) + '/summary';
      const res = await fetch(path, { headers: { Authorization: `Bearer ${token}` } });
      const data = await res.json();
      // A newer navigation may have superseded this fetch — don't overwrite it.
      if (currentUser !== username) return;
      if (res.ok) {
        if (data.username) nameEl.textContent = data.username; // canonical case
        joinedEl.textContent = formatJoined(data.createdAt);
        ratingEl.textContent = formatRating(data);
        if (friendsMetaEl) friendsMetaEl.textContent = formatFriends(data.friendCount || 0);
        if (!self && window.PoolAvatar && data.avatar) window.PoolAvatar.apply(avatarEl, data.avatar);
      } else {
        joinedEl.textContent = 'Joined —';
        ratingEl.textContent = 'RATING: UNRATED';
        if (friendsMetaEl) friendsMetaEl.textContent = '0 FRIENDS';
      }
    } catch {
      joinedEl.textContent = 'Joined —';
      ratingEl.textContent = 'RATING: UNRATED';
      if (friendsMetaEl) friendsMetaEl.textContent = '0 FRIENDS';
    }
  }

  // "RATING: 1500". The W–L record lives on the STATS tab, not in the header.
  function formatRating(data) {
    if (typeof data.rating !== 'number') return 'RATING: UNRATED';
    return 'RATING: ' + data.rating;
  }

  // The top PIXEL POOL logo always returns to the home screen (and clears the
  // navigation stack — a fresh profile visit starts over).
  function goHome() {
    profileMain.classList.add('hidden');
    homeMain.classList.remove('hidden');
    navStack.length = 0;
    currentPage = { home: true };
  }

  // BACK returns to the previous page on the stack: an earlier profile (with the
  // tab you left it on), or home.
  function back() {
    const prev = navStack.pop();
    if (!prev || prev.home) { goHome(); return; }
    currentPage = prev;
    renderProfile(prev);
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
    if (guest) { note.textContent = 'Stats need an account — log in to track your games.'; return; }
    note.textContent = '';
    selectTab('stats');
  });
  // Click your own avatar to change your picture (js/avatarpicker.js). Another
  // player's avatar isn't editable.
  if (avatarEl) avatarEl.addEventListener('click', () => {
    if (!viewingSelf) return;
    if (guest) { note.textContent = 'Avatars need an account — log in to customize yours.'; return; }
    note.textContent = '';
    if (window.PoolAvatar) window.PoolAvatar.open();
  });

  // The logo always goes home; the BACK button goes to the previous page.
  logoBtn.addEventListener('click', goHome);
  if (backBtn) backBtn.addEventListener('click', back);

  window.PixelPoolProfile = { show, showUser };
})();

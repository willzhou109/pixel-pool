/* Profile page for Pixel Pool — reached by clicking the name button on the
 * home screen's sidebar.
 *
 * Lives inside #modeOverlay as a second full-bleed panel (#profileMain),
 * swapped in for #homeMain rather than shown in its own overlay — that way
 * the sidebar and chat bar (also direct children of #modeOverlay) never
 * unmount when navigating between home and profile; they persist across both.
 *
 * The username, join date, Elo rating + W/L record (all from /api/me), the
 * clickable avatar (js/avatarpicker.js) and the GAME HISTORY (js/history.js),
 * STATS (js/careerstats.js) and FRIEND LIST (js/friends.js) tabs are all real.
 * Remaining placeholders: the country flag is a blank box, and the friends count
 * in the meta row is hard-coded to 0.
 *
 * show(username, isGuest) renders your own profile; showUser(username) renders
 * ANOTHER player's — the same page, but their header (name, avatar, rating,
 * record from /api/users/:u/summary) with the STATS + GAME HISTORY tabs showing
 * their public data and the FRIEND LIST tab hidden. From another player's
 * profile, BACK returns to your own friend list (where you clicked in).
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
  let selfGuest = false;      // remembered so BACK can re-open your own profile

  // Tab strip: GAME HISTORY (js/history.js), STATS (js/careerstats.js) and
  // FRIEND LIST (js/friends.js). On another player's profile the sub-modules are
  // pointed at their public data (open(username)); FRIEND LIST is self-only.
  // `which` is 'history' | 'stats' | 'friends' | null.
  function selectTab(which) {
    const viewName = viewingSelf ? null : currentUser; // null => own endpoints
    if (tabBtns[0]) tabBtns[0].classList.toggle('sel', which === 'history');
    if (tabBtns[1]) tabBtns[1].classList.toggle('sel', which === 'stats');
    if (tabBtns[2]) tabBtns[2].classList.toggle('sel', which === 'friends');
    if (window.PoolHistory) (which === 'history' ? window.PoolHistory.open(viewName) : window.PoolHistory.hide());
    if (window.PoolCareerStats) (which === 'stats' ? window.PoolCareerStats.open(viewName) : window.PoolCareerStats.hide());
    if (window.PixelPoolFriends) (which === 'friends' ? window.PixelPoolFriends.open() : window.PixelPoolFriends.hide());
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

  // Render your own profile.
  function show(username, isGuest, tab) {
    selfUsername = username;
    selfGuest = !!isGuest;
    return renderProfile({ username, isGuest, self: true, tab });
  }

  // Render another player's profile (from a friend-list "View Profile"). Falls
  // back to your own if the name is you.
  function showUser(username) {
    if (!username) return;
    if (selfUsername && username.toLowerCase() === selfUsername.toLowerCase()) {
      return show(selfUsername, selfGuest, 'history');
    }
    return renderProfile({ username, isGuest: false, self: false, tab: 'history' });
  }

  async function renderProfile({ username, isGuest, self, tab }) {
    guest = !!isGuest;
    viewingSelf = self;
    currentUser = username;
    nameEl.textContent = (isGuest ? 'GUEST' : (username || 'PLAYER')).toUpperCase();
    // FRIEND LIST only makes sense on your own profile.
    if (tabBtns[2]) tabBtns[2].classList.toggle('hidden', !self);
    // Only your own picture is editable (shows the pencil badge).
    if (avatarEl) avatarEl.classList.toggle('editable', self && !isGuest);
    if (self) {
      if (window.PoolAvatar) window.PoolAvatar.applyMine(); // repaint from the cache
    } else {
      resetAvatar(); // painted from their summary below
    }
    ratingEl.textContent = isGuest ? 'RATING: UNRATED' : 'RATING: …';
    joinedEl.textContent = isGuest ? 'No account' : 'Joined …';
    note.textContent = '';
    homeMain.classList.add('hidden');
    profileMain.classList.remove('hidden');
    modeOverlay.classList.remove('hidden'); // should already be visible — just in case
    // Land on GAME HISTORY, unless a caller asked for a tab (e.g. the FRIENDS
    // sidebar button opens straight to the friend list on your own profile).
    selectTab(isGuest ? null : (tab || 'history'));

    if (isGuest) return;
    const token = getToken();
    if (!token) { joinedEl.textContent = 'Joined —'; ratingEl.textContent = 'RATING: UNRATED'; return; }
    try {
      const path = self ? '/api/me' : '/api/users/' + encodeURIComponent(username) + '/summary';
      const res = await fetch(path, { headers: { Authorization: `Bearer ${token}` } });
      const data = await res.json();
      if (res.ok) {
        joinedEl.textContent = formatJoined(data.createdAt);
        ratingEl.textContent = formatRating(data);
        if (!self && window.PoolAvatar && data.avatar) window.PoolAvatar.apply(avatarEl, data.avatar);
      } else {
        joinedEl.textContent = 'Joined —';
        ratingEl.textContent = 'RATING: UNRATED';
      }
    } catch {
      joinedEl.textContent = 'Joined —';
      ratingEl.textContent = 'RATING: UNRATED';
    }
  }

  // "RATING: 1500" plus a W–L record once the player has games behind them.
  function formatRating(data) {
    if (typeof data.rating !== 'number') return 'RATING: UNRATED';
    let s = 'RATING: ' + data.rating;
    if (data.games) s += '   ·   ' + (data.wins || 0) + 'W ' + (data.losses || 0) + 'L';
    return s;
  }

  // The top PIXEL POOL logo always returns to the home screen.
  function goHome() {
    profileMain.classList.add('hidden');
    homeMain.classList.remove('hidden');
  }

  // BACK returns to the previous page: from another player's profile that's your
  // own friend list (where the "View Profile" link was); from your own, home.
  function back() {
    if (!viewingSelf && selfUsername) {
      show(selfUsername, selfGuest, 'friends');
      return;
    }
    goHome();
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

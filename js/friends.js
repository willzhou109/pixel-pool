/* Friends for Pixel Pool — the client-side store + the FRIEND LIST tab UI.
 *
 * Two jobs in one module:
 *   1. A small in-memory store of the signed-in player's friends, pending
 *      requests, and who's online. It's the single source of truth the rest of
 *      the UI reads (the FRIEND LIST tab here, and the home chat messenger in
 *      js/homechat.js). It's seeded from GET /api/friends and kept live by the
 *      real-time events net.js forwards (presence + friend-request/accepted/
 *      removed). Subscribers are notified via onChange().
 *   2. The FRIEND LIST tab on the profile page (#friendsView): add-by-search,
 *      accept/decline incoming requests, cancel sent ones, and the friends list
 *      with online dots, a MESSAGE shortcut (opens the home chat) and REMOVE.
 *
 * profile.js owns the tab button and calls open()/hide(); everything inside
 * #friendsView is owned here. The store lives regardless of whether the tab is
 * open, so the notifications dot and the chat messenger stay current in the
 * background.
 */
(function () {
  'use strict';

  const Net = window.PixelPoolNet;
  const $ = id => document.getElementById(id);
  const getToken = () => { try { return sessionStorage.getItem('pp_token'); } catch { return null; } };

  /* --------------------------------- store -------------------------------- */
  const store = {
    friends: [],   // [{ username, online }]
    incoming: [],  // [{ username }] — requests awaiting my response
    outgoing: [],  // [{ username }] — requests I've sent
    invites: [],   // [{ username }] — game invites awaiting my response (ephemeral)
  };
  const subs = new Set();
  const notify = () => { updateNotifDot(); subs.forEach(fn => { try { fn(store); } catch (e) { console.error(e); } }); };

  // When the FRIEND LIST tab is showing ANOTHER player's friends, this holds
  // their username; null means it's showing my own. In "other" mode the store
  // still updates in the background (for the notif dot), but the my-friends
  // renderer is suppressed so it can't clobber the other player's list.
  let otherTarget = null;

  const lower = s => String(s || '').toLowerCase();
  const findFriend = name => store.friends.find(f => lower(f.username) === lower(name));
  const isOnline = name => { const f = findFriend(name); return !!(f && f.online); };
  const isFriend = name => !!findFriend(name);

  async function fetchJson(path, opts) {
    const res = await fetch(path, Object.assign({
      headers: { Authorization: `Bearer ${getToken()}`, 'Content-Type': 'application/json' },
    }, opts));
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Request failed.');
    return data;
  }

  // Pull the authoritative list from the server and re-render everything.
  async function refresh() {
    if (!getToken()) return;
    try {
      const data = await fetchJson('/api/friends');
      store.friends = data.friends || [];
      store.incoming = data.incoming || [];
      store.outgoing = data.outgoing || [];
      notify();
      if (!otherTarget && !view.classList.contains('hidden')) render();
    } catch { /* server unreachable — keep whatever we had */ }
  }

  /* ---------------------------- realtime patches -------------------------- */
  if (Net) {
    // First populate as soon as we're connected, so the dot + chat are ready
    // even before the player opens the FRIEND LIST tab.
    Net.on('welcome', () => refresh());
    Net.on('presence', data => {
      const set = new Set((data && data.online || []).map(lower));
      store.friends.forEach(f => { f.online = set.has(lower(f.username)); });
      notify(); if (!otherTarget && !view.classList.contains('hidden')) render();
    });
    Net.on('friend-online', d => setOnline(d && d.username, true));
    Net.on('friend-offline', d => setOnline(d && d.username, false));
    // A relationship changed under us — simplest correct move is a full refetch.
    Net.on('friend-request', refresh);
    Net.on('friend-accepted', refresh);
    Net.on('friend-removed', refresh);

    // Game invites (ephemeral, held only in the store — never refetched).
    Net.on('game-invite', d => addInvite(d && d.from));
    Net.on('invite-cancelled', d => removeInvite(d && d.from));
    Net.on('match-found', clearInvites); // entering a game consumes any invites
    Net.on('invite-declined', d => inviteNote((d && d.by || 'They') + ' declined your invite.'));
    Net.on('invite-sent', d => inviteNote('Invite sent to ' + (d && d.to) + '.'));
    Net.on('invite-error', d => inviteNote((d && d.message) || 'Couldn’t send the invite.'));
  }

  /* ------------------------------ game invites ---------------------------- */
  function addInvite(from) {
    if (!from || store.invites.some(i => lower(i.username) === lower(from))) return;
    store.invites.push({ username: from });
    notify();
    if (!otherTarget && !view.classList.contains('hidden')) render();
  }
  function removeInvite(from) {
    const n = store.invites.length;
    store.invites = store.invites.filter(i => lower(i.username) !== lower(from));
    if (store.invites.length !== n) {
      notify();
      if (!otherTarget && !view.classList.contains('hidden')) render();
    }
  }
  function clearInvites() {
    if (!store.invites.length) return;
    store.invites = [];
    notify();
    if (!otherTarget && !view.classList.contains('hidden')) render();
  }
  // Short feedback line, shown in the friends view's note area if it's open.
  function inviteNote(msg) {
    if (addNote && !otherTarget && !view.classList.contains('hidden')) addNote.textContent = msg;
  }

  function setOnline(name, on) {
    const f = findFriend(name);
    if (!f) return;
    f.online = on;
    notify();
    if (!otherTarget && !view.classList.contains('hidden')) render();
  }

  /* ------------------------------- notif dot ------------------------------ */
  // Two red dots flag things awaiting my response — pending friend requests OR
  // game invites: one on the user-menu button (#notifDot), one on the FRIEND
  // LIST tab (#friendReqDot).
  const notifDot = $('notifDot');
  const friendReqDot = $('friendReqDot');
  // The #profileFriends meta count is owned by js/profile.js now (it must reflect
  // whichever profile is open — yours or another player's — from that profile's
  // summary, not always your own count).
  function updateNotifDot() {
    const has = store.incoming.length > 0 || store.invites.length > 0;
    if (notifDot) notifDot.classList.toggle('show', has);
    if (friendReqDot) friendReqDot.classList.toggle('show', has);
  }

  /* ------------------------------- tab UI --------------------------------- */
  const view    = $('friendsView');
  const addForm = $('friendAddForm');
  const addInput = $('friendAddInput');
  const addNote = $('friendAddNote');
  const searchResults = $('friendSearchResults');
  const inviteSec = $('gameInviteSec'), inviteList = $('gameInviteList');
  const reqInSec = $('friendReqIn'), reqInList = $('friendReqInList');
  const reqOutSec = $('friendReqOut'), reqOutList = $('friendReqOutList');
  const friendCount = $('friendCount');
  const friendRows = $('friendListRows');
  const missing = !view || !addForm || !friendRows;
  if (missing) console.warn('Friends: tab elements missing (store still active)');

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  // One friend row: online dot + name, then INVITE / VIEW PROFILE / MESSAGE /
  // REMOVE actions. INVITE asks them to play right now (online friends only).
  function friendRow(f) {
    const row = el('div', 'friendRow');
    const left = el('div', 'friendWho');
    left.appendChild(el('span', 'presDot' + (f.online ? ' on' : '')));
    left.appendChild(el('span', 'friendName', f.username));
    row.appendChild(left);
    const acts = el('div', 'friendActs');

    const invite = el('button', 'friendMini' + (f.online ? '' : ' soon'), 'INVITE'); invite.type = 'button';
    invite.addEventListener('click', () => {
      if (!f.online) { if (addNote) addNote.textContent = f.username + ' is offline — invites only work when they’re online.'; return; }
      if (Net) Net.sendGameInvite(f.username); // feedback arrives via invite-sent / invite-error
    });
    const prof = el('button', 'friendMini', 'VIEW PROFILE'); prof.type = 'button';
    prof.addEventListener('click', () => {
      if (window.PixelPoolProfile) window.PixelPoolProfile.showUser(f.username);
    });
    const msg = el('button', 'friendMini', 'MESSAGE'); msg.type = 'button';
    msg.addEventListener('click', () => {
      if (window.PixelPoolHomeChat) window.PixelPoolHomeChat.openWith(f.username);
    });
    const rm = el('button', 'friendMini danger', 'REMOVE'); rm.type = 'button';
    rm.addEventListener('click', () => act('/api/friends/remove', f.username));

    acts.appendChild(invite); acts.appendChild(prof); acts.appendChild(msg); acts.appendChild(rm);
    row.appendChild(acts);
    return row;
  }

  // A pending-request row. `dir` is 'in' (Accept/Decline) or 'out' (Cancel).
  function reqRow(name, dir) {
    const row = el('div', 'friendRow');
    row.appendChild(el('span', 'friendName', name));
    const acts = el('div', 'friendActs');
    if (dir === 'in') {
      const ok = el('button', 'friendMini good', 'ACCEPT'); ok.type = 'button';
      ok.addEventListener('click', () => act('/api/friends/accept', name));
      const no = el('button', 'friendMini danger', 'DECLINE'); no.type = 'button';
      no.addEventListener('click', () => act('/api/friends/decline', name));
      acts.appendChild(ok); acts.appendChild(no);
    } else {
      const cancel = el('button', 'friendMini', 'CANCEL'); cancel.type = 'button';
      cancel.addEventListener('click', () => act('/api/friends/decline', name));
      acts.appendChild(cancel);
    }
    row.appendChild(acts);
    return row;
  }

  // A game-invite row: name + ACCEPT (join the game now) / REJECT.
  function inviteRow(name) {
    const row = el('div', 'friendRow');
    row.appendChild(el('span', 'friendName', name));
    const acts = el('div', 'friendActs');
    const ok = el('button', 'friendMini good', 'ACCEPT'); ok.type = 'button';
    ok.addEventListener('click', () => { if (Net) Net.acceptGameInvite(name); });
    const no = el('button', 'friendMini danger', 'REJECT'); no.type = 'button';
    no.addEventListener('click', () => { removeInvite(name); if (Net) Net.rejectGameInvite(name); });
    acts.appendChild(ok); acts.appendChild(no);
    row.appendChild(acts);
    return row;
  }

  function render() {
    if (missing || otherTarget) return; // in "other" mode renderOther() draws the list
    // Game invites (time-sensitive — shown first)
    if (inviteList) {
      inviteList.innerHTML = '';
      store.invites.forEach(iv => inviteList.appendChild(inviteRow(iv.username)));
      if (inviteSec) inviteSec.classList.toggle('hidden', store.invites.length === 0);
    }
    // Incoming requests
    reqInList.innerHTML = '';
    store.incoming.forEach(r => reqInList.appendChild(reqRow(r.username, 'in')));
    reqInSec.classList.toggle('hidden', store.incoming.length === 0);
    // Outgoing requests
    reqOutList.innerHTML = '';
    store.outgoing.forEach(r => reqOutList.appendChild(reqRow(r.username, 'out')));
    reqOutSec.classList.toggle('hidden', store.outgoing.length === 0);
    // Friends
    friendRows.innerHTML = '';
    if (!store.friends.length) {
      friendRows.appendChild(el('div', 'friendEmpty', 'No friends yet — add someone above!'));
    } else {
      store.friends.forEach(f => friendRows.appendChild(friendRow(f)));
    }
    if (friendCount) friendCount.textContent = store.friends.length ? '(' + store.friends.length + ')' : '';
  }

  // POST a friend action, then refresh from the server (authoritative).
  async function act(path, username) {
    try {
      await fetchJson(path, { method: 'POST', body: JSON.stringify({ username }) });
    } catch (e) {
      if (addNote) addNote.textContent = e.message;
    }
    refresh();
  }

  /* --------------------------- add / search box --------------------------- */
  let searchTimer = null;

  function stateLabel(state) {
    return state === 'friends' ? 'FRIENDS'
      : state === 'outgoing' ? 'SENT'
      : state === 'incoming' ? 'WANTS TO ADD YOU' : '';
  }

  async function runSearch(q) {
    if (!searchResults) return;
    if (!q || q.length < 1) { searchResults.innerHTML = ''; searchResults.classList.add('hidden'); return; }
    let results;
    try { ({ results } = await fetchJson('/api/users/search?q=' + encodeURIComponent(q))); }
    catch { return; }
    searchResults.innerHTML = '';
    if (!results.length) {
      searchResults.appendChild(el('div', 'friendEmpty', 'No players found.'));
    } else {
      results.forEach(r => {
        const row = el('div', 'friendRow');
        row.appendChild(el('span', 'friendName', r.username));
        const acts = el('div', 'friendActs');
        if (r.state === 'none') {
          const add = el('button', 'friendMini good', 'ADD'); add.type = 'button';
          add.addEventListener('click', async () => {
            await act('/api/friends/request', r.username);
            addInput.value = ''; searchResults.classList.add('hidden');
            if (addNote) addNote.textContent = 'Request sent to ' + r.username + '.';
          });
          acts.appendChild(add);
        } else {
          acts.appendChild(el('span', 'friendStat', stateLabel(r.state)));
        }
        row.appendChild(acts);
        searchResults.appendChild(row);
      });
    }
    searchResults.classList.remove('hidden');
  }

  if (!missing) {
    addInput.addEventListener('input', () => {
      if (addNote) addNote.textContent = '';
      clearTimeout(searchTimer);
      const q = addInput.value.trim();
      searchTimer = setTimeout(() => runSearch(q), 220);
    });
    // Enter sends a request to the exact name typed (handy if search is slow).
    addForm.addEventListener('submit', async e => {
      e.preventDefault();
      const name = addInput.value.trim();
      if (!name) return;
      await act('/api/friends/request', name);
      if (addNote && !addNote.textContent) addNote.textContent = 'Request sent to ' + name + '.';
      addInput.value = '';
      if (searchResults) searchResults.classList.add('hidden');
    });
  }

  /* --------------------- another player's friend list --------------------- */
  // The add box + request sections are "my account" management — hidden when
  // browsing someone else's friends (there we show their friends, read-only,
  // each tagged by MY relationship to them).
  function setMyControls(visible) {
    if (addForm) addForm.classList.toggle('hidden', !visible);
    if (!visible) {
      if (searchResults) { searchResults.innerHTML = ''; searchResults.classList.add('hidden'); }
      if (addNote) addNote.textContent = '';
      if (inviteSec) inviteSec.classList.add('hidden'); // my invites, not theirs
      if (reqInSec) reqInSec.classList.add('hidden');
      if (reqOutSec) reqOutSec.classList.add('hidden');
    }
  }

  const OTHER_TAG = { friends: 'FRIENDS', outgoing: 'SENT', incoming: 'WANTS TO ADD YOU', self: 'YOU' };

  // A row in another player's friend list: online dot + name, then a control
  // that differs by whether I've added them — ADD (none), ACCEPT (they've asked
  // me), or a tag (already friends / request sent / that's me). Always a VIEW
  // PROFILE shortcut so you can keep browsing.
  function otherFriendRow(f) {
    const row = el('div', 'friendRow');
    const left = el('div', 'friendWho');
    left.appendChild(el('span', 'presDot' + (f.online ? ' on' : '')));
    left.appendChild(el('span', 'friendName', f.username));
    row.appendChild(left);

    const acts = el('div', 'friendActs');
    const prof = el('button', 'friendMini', 'VIEW PROFILE'); prof.type = 'button';
    prof.addEventListener('click', () => {
      if (window.PixelPoolProfile) window.PixelPoolProfile.showUser(f.username);
    });
    if (f.state === 'none') {
      const add = el('button', 'friendMini good', 'ADD'); add.type = 'button';
      add.addEventListener('click', () => actOther('/api/friends/request', f.username));
      acts.appendChild(add);
    } else if (f.state === 'incoming') {
      const ok = el('button', 'friendMini good', 'ACCEPT'); ok.type = 'button';
      ok.addEventListener('click', () => actOther('/api/friends/accept', f.username));
      acts.appendChild(ok);
    } else {
      const tagCls = f.state === 'friends' ? 'friendTag isFriend' : 'friendTag';
      acts.appendChild(el('span', tagCls, OTHER_TAG[f.state] || ''));
    }
    acts.appendChild(prof);
    row.appendChild(acts);
    return row;
  }

  // A friend action taken from another player's list: send/accept, then refresh
  // both my own store (for the notif dot) and the annotated list I'm viewing.
  async function actOther(path, username) {
    try { await fetchJson(path, { method: 'POST', body: JSON.stringify({ username }) }); }
    catch { /* transient — the re-fetch below re-syncs state either way */ }
    refresh(); // updates my store + dot in the background (render() is suppressed)
    if (otherTarget) openOther(otherTarget);
  }

  function renderOther(friends) {
    friendRows.innerHTML = '';
    if (!friends.length) {
      friendRows.appendChild(el('div', 'friendEmpty', 'No friends yet.'));
    } else {
      friends.forEach(f => friendRows.appendChild(otherFriendRow(f)));
    }
    if (friendCount) friendCount.textContent = friends.length ? '(' + friends.length + ')' : '';
  }

  /* ------------------------------ public API ------------------------------ */
  function open() {
    otherTarget = null;
    if (view) view.classList.remove('hidden');
    setMyControls(true);
    if (addInput) addInput.value = '';
    render();
    refresh();
  }

  // Show another player's friend list (read-only, annotated for me).
  async function openOther(username) {
    if (missing || !username) return;
    otherTarget = username;
    if (view) view.classList.remove('hidden');
    setMyControls(false);
    friendRows.innerHTML = '';
    friendRows.appendChild(el('div', 'friendEmpty', 'Loading…'));
    if (friendCount) friendCount.textContent = '';
    let data;
    try {
      data = await fetchJson('/api/users/' + encodeURIComponent(username) + '/friends');
    } catch {
      if (otherTarget === username) { friendRows.innerHTML = ''; friendRows.appendChild(el('div', 'friendEmpty', 'Couldn’t load friends.')); }
      return;
    }
    if (otherTarget !== username) return; // tab/profile switched while fetching
    renderOther(data.friends || []);
  }

  function hide() { if (view) view.classList.add('hidden'); }

  window.PixelPoolFriends = {
    open, openOther, hide, refresh,
    getFriends: () => store.friends.slice(),
    isOnline, isFriend,
    hasIncoming: () => store.incoming.length > 0,
    onChange(cb) { subs.add(cb); return () => subs.delete(cb); },
  };
})();

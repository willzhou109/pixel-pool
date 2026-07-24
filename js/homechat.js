/* Home-screen chat — a mini DM messenger for the friends feature.
 *
 * Lives in #homeChat (a persistent sibling of #homeMain / #profileMain, so it
 * stays put across home <-> profile) and has two modes sharing one box:
 *   - list: a picker of your friends (online first, unread badge), from
 *     js/friends.js's store; click one to open the conversation.
 *   - conversation: the message history (GET /api/messages/:name) plus live
 *     messages, with the header showing the friend's name + online dot and a
 *     back arrow to the picker.
 *
 * Sending goes over the socket (Net.sendDm); we do NOT echo optimistically —
 * the server persists the message and delivers it back to us (and the friend),
 * so ordering and ids stay authoritative and every tab agrees. Incoming
 * messages for a conversation you aren't looking at raise an unread badge.
 *
 * This replaces the placeholder home-chat that used to live in js/mode.js.
 */
(function () {
  'use strict';

  const Net = window.PixelPoolNet;
  const Friends = window.PixelPoolFriends;
  const $ = id => document.getElementById(id);
  const getToken = () => { try { return sessionStorage.getItem('pp_token'); } catch { return null; } };

  const box = $('homeChat');
  const backBtn = $('homeChatBack');
  const titleEl = $('homeChatTitle');
  const presEl = $('homeChatPres');
  const toggle = $('homeChatToggle');
  const dotEl = $('homeChatDot');
  const listEl = $('homeChatList');
  const logEl = $('homeChatLog');
  const formEl = $('homeChatForm');
  const inputEl = $('homeChatInput');
  if (!box || !listEl || !logEl || !formEl) { console.warn('HomeChat: elements missing'); return; }

  let myName = null;                 // learned from the socket 'welcome'
  let active = null;                 // username of the open conversation, or null
  let collapsed = false;
  const unread = new Map();          // usernameLower -> count
  const lower = s => String(s || '').toLowerCase();

  if (Net) Net.on('welcome', d => { myName = d && d.username; });

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  /* -------------------------------- list mode ----------------------------- */
  function showList() {
    active = null;
    if (backBtn) backBtn.classList.add('hidden');
    if (titleEl) titleEl.textContent = 'MESSAGES';
    if (presEl) presEl.classList.add('hidden');
    listEl.classList.remove('hidden');
    logEl.classList.add('hidden');
    formEl.classList.add('hidden');
    renderList();
  }

  function renderList() {
    const friends = Friends ? Friends.getFriends() : [];
    listEl.innerHTML = '';
    if (!friends.length) {
      listEl.appendChild(el('div', 'cempty', 'Add friends to start chatting…'));
      return;
    }
    friends.forEach(f => {
      const row = el('button', 'chatFriend'); row.type = 'button';
      row.appendChild(el('span', 'presDot' + (f.online ? ' on' : '')));
      row.appendChild(el('span', 'chatFriendName', f.username));
      const n = unread.get(lower(f.username)) || 0;
      if (n) row.appendChild(el('span', 'chatUnread', String(n)));
      row.addEventListener('click', () => openWith(f.username));
      listEl.appendChild(row);
    });
  }

  /* ---------------------------- conversation mode ------------------------- */
  function append(msg) {
    const mine = lower(msg.from) === lower(myName);
    const row = el('div', 'cmsg' + (mine ? '' : ' them'));
    row.appendChild(el('span', 'who', (mine ? 'You' : msg.from) + ': '));
    row.appendChild(el('span', 'txt', msg.text)); // textContent — never inject remote HTML
    logEl.appendChild(row);
    logEl.scrollTop = logEl.scrollHeight;
  }

  async function openWith(username) {
    if (!username) return;
    active = username;
    unread.delete(lower(username)); // opening a convo clears its unread badge
    updateMsgDot();
    // Header
    if (backBtn) backBtn.classList.remove('hidden');
    if (titleEl) titleEl.textContent = username;
    if (presEl) {
      presEl.classList.remove('hidden');
      presEl.classList.toggle('on', Friends && Friends.isOnline(username));
    }
    // Panes
    listEl.classList.add('hidden');
    logEl.classList.remove('hidden');
    formEl.classList.remove('hidden');
    // Uncollapse + surface the box.
    if (collapsed) setCollapsed(false);
    logEl.innerHTML = '';
    logEl.appendChild(el('div', 'cempty', 'Loading…'));
    let messages = [];
    try {
      const res = await fetch('/api/messages/' + encodeURIComponent(username),
        { headers: { Authorization: `Bearer ${getToken()}` } });
      ({ messages } = await res.json().catch(() => ({ messages: [] })));
    } catch { /* offline — show empty */ }
    if (active !== username) return; // switched away while loading
    logEl.innerHTML = '';
    if (!messages || !messages.length) {
      logEl.appendChild(el('div', 'cempty', 'Say hi to ' + username + '…'));
    } else {
      messages.forEach(append);
    }
    inputEl.focus();
  }

  // True when the player is actively looking at `username`'s conversation —
  // i.e. it's open, uncollapsed, and the home/profile overlay is on screen (not
  // mid-match). Otherwise an incoming message counts as unread (raises the dot).
  const modeOverlay = $('modeOverlay');
  const onScreen = () => !box.classList.contains('hidden') && (!modeOverlay || !modeOverlay.classList.contains('hidden'));
  const viewing = username =>
    active && lower(active) === lower(username) && !collapsed && onScreen();

  /* -------------------------------- inbound ------------------------------- */
  if (Net) Net.on('dm', msg => {
    if (!msg || !msg.from) return;
    // The other party of this message from my perspective.
    const mine = lower(msg.from) === lower(myName);
    const other = mine ? msg.to : msg.from;
    if (active && lower(other) === lower(active)) {
      // Drop the "say hi / loading" placeholder if it's still there.
      const ph = logEl.querySelector('.cempty');
      if (ph) ph.remove();
      append(msg);
      if (!viewing(other)) bump(other); // arrived while collapsed/hidden
    } else if (!mine) {
      bump(other);
    }
  });

  function bump(username) {
    unread.set(lower(username), (unread.get(lower(username)) || 0) + 1);
    if (!active) renderList();
    updateMsgDot();
  }

  // Red dot on the Messages header whenever any conversation has unread messages
  // — the same treatment as the friend-request dots (.reqDot). Per-conversation
  // counts still show as badges in the friend picker (renderList).
  function updateMsgDot() {
    let total = 0; unread.forEach(n => total += n);
    if (dotEl) dotEl.classList.toggle('show', total > 0);
  }

  /* --------------------------------- chrome ------------------------------- */
  function setCollapsed(v) {
    collapsed = v;
    box.classList.toggle('collapsed', collapsed);
    if (toggle) toggle.innerHTML = collapsed ? '&#9650;' : '&#9660;';
    if (!collapsed && active) { unread.delete(lower(active)); updateMsgDot(); }
  }

  if (toggle) toggle.addEventListener('click', () => setCollapsed(!collapsed));
  if (backBtn) backBtn.addEventListener('click', showList);

  formEl.addEventListener('submit', e => {
    e.preventDefault();
    const text = inputEl.value.trim();
    if (!text || !active) return;
    inputEl.value = '';
    if (Net) Net.sendDm(active, text); // server echoes it back → append() runs then
  });

  // Keep the picker's presence dots + roster live as the store changes.
  if (Friends) Friends.onChange(() => {
    if (!active) renderList();
    else if (presEl) presEl.classList.toggle('on', Friends.isOnline(active));
  });

  showList();

  window.PixelPoolHomeChat = { openWith };
})();

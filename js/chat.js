/* In-match text chat for Pixel Pool Online.
 *
 * Self-contained UI + wiring. Chat messages ride the existing 'game' relay
 * channel (see net.js / server realtime), tagged { t: 'chat', text }, so no
 * server changes are needed — the server already forwards any 'game' payload to
 * the other seat in the room. game.js's apply() ignores unknown message types,
 * so chat traffic is harmless there.
 *
 * The bridge (online.js) drives show()/hide() around a match and forwards
 * inbound chat via receive(); everything else lives here.
 */
(function () {
  'use strict';

  const Net = window.PixelPoolNet;

  const root    = document.getElementById('chat');
  const oppEl   = document.getElementById('chatOpp');
  const logEl   = document.getElementById('chatLog');
  const formEl  = document.getElementById('chatForm');
  const inputEl = document.getElementById('chatInput');
  const toggle  = document.getElementById('chatToggle');
  if (!root) return;

  let oppName = 'Opponent';
  let empty = true;

  function clearLog() {
    logEl.innerHTML = '<div class="cempty">Say hi to your opponent&hellip;</div>';
    empty = true;
  }

  // Render one message. `who` is a display name; `mine` styles it as our own.
  function append(who, text, mine) {
    if (empty) { logEl.innerHTML = ''; empty = false; }
    const row = document.createElement('div');
    row.className = 'cmsg' + (mine ? '' : ' them');
    const w = document.createElement('span');
    w.className = 'who';
    w.textContent = who + ': ';
    const t = document.createElement('span');
    t.className = 'txt';
    t.textContent = text;           // textContent — never inject remote HTML
    row.appendChild(w);
    row.appendChild(t);
    logEl.appendChild(row);
    logEl.scrollTop = logEl.scrollHeight;
  }

  formEl.addEventListener('submit', e => {
    e.preventDefault();
    const text = inputEl.value.trim();
    if (!text) return;
    inputEl.value = '';
    if (Net) Net.sendGame({ t: 'chat', text });
    append('You', text, true);
  });

  toggle.addEventListener('click', () => {
    const collapsed = root.classList.toggle('collapsed');
    toggle.innerHTML = collapsed ? '&#9650;' : '&#9660;';
  });

  window.PixelPoolChat = {
    show(name) {
      oppName = name || 'Opponent';
      oppEl.textContent = 'vs ' + oppName;
      clearLog();
      root.classList.remove('hidden', 'collapsed');
      toggle.innerHTML = '&#9660;';
    },
    hide() {
      root.classList.add('hidden');
      inputEl.value = '';
      inputEl.blur();
    },
    receive(text) {
      if (typeof text === 'string' && text.trim()) append(oppName, text, false);
    },
  };
})();

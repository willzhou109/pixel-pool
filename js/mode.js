/* Home screen for Pixel Pool — shown after LOG IN or CONTINUE AS GUEST.
 *
 * landing.js hands off here via window.PixelPoolMode.enter(username, isGuest).
 * Full-bleed layout over the dimmed, spinning table: pick a game (only 8-ball
 * exists — the other tabs are "coming soon"), pick OFFLINE or ONLINE, then hit
 * PLAY. Offline reveals the existing local two-player setup overlay (game.js
 * owns everything from there); online hands off to the lobby via auth.js.
 * Guests can't go online — the multiplayer server rejects sockets without a
 * real session token — so ONLINE just tells them to log in.
 *
 * #modeOverlay also hosts the profile panel (#profileMain, owned by
 * js/profile.js) as a sibling of #homeMain — only one is shown at a time, but
 * both live inside the same overlay as the sidebar (#homeSide) and chat bar
 * (#homeChat), so those two persist across home <-> profile navigation
 * instead of being torn down and rebuilt.
 *
 * The right sidebar (profile / friends / notifications) is placeholder UI for
 * features that aren't built yet, except the name button, which opens the
 * profile page (js/profile.js), and LOG OUT.
 */
(function () {
  'use strict';

  const $ = id => document.getElementById(id);
  const overlay = $('modeOverlay');
  const setupOverlay = $('setupOverlay');
  const welcome = $('modeWelcome');
  const note = $('modeNote');
  const offlineBtn = $('offlineBtn');
  const onlineBtn = $('onlineBtn');
  const playBtn = $('playBtn');
  const profileBtn = $('profileBtn');
  const logoutBtn = $('modeLogoutBtn');
  const homeSide = $('homeSide');
  const sideToggleBtn = $('sideToggleBtn');
  const homeMain = $('homeMain');
  const profileMain = $('profileMain');
  const tabs = Array.from(document.querySelectorAll('.gameTab'));
  if (!overlay || !setupOverlay || !offlineBtn || !onlineBtn || !playBtn) {
    console.warn('Home: elements missing');
    return;
  }

  const GAME_NAMES = { '9ball': '9-BALL', '10ball': '10-BALL', snooker: 'SNOOKER' };

  let guest = false;
  let currentUsername = null;
  let mode = 'offline'; // 'offline' | 'online' — what PLAY will launch

  function setMode(m) {
    mode = m;
    offlineBtn.classList.toggle('sel', m === 'offline');
    onlineBtn.classList.toggle('sel', m === 'online');
  }

  function enter(username, isGuest) {
    guest = !!isGuest;
    currentUsername = username;
    const name = guest ? 'GUEST' : (username || 'PLAYER').toUpperCase();
    if (welcome) welcome.textContent = 'WELCOME, ' + name + '!';
    if (profileBtn) profileBtn.textContent = name;
    if (note) note.textContent = '';
    setMode(guest ? 'offline' : 'online'); // guests can't play online
    [$('landingOverlay'), $('loginOverlay'), $('signupOverlay'), $('lobbyOverlay')]
      .forEach(o => o && o.classList.add('hidden'));
    // Always land on the home panel, not wherever profile was left showing.
    if (profileMain) profileMain.classList.add('hidden');
    if (homeMain) homeMain.classList.remove('hidden');
    overlay.classList.remove('hidden');
  }

  /* ------------------------------ game tabs ------------------------------ */
  // Only 8-ball is playable; the rest flash a "coming soon" note and leave the
  // selection on 8-ball.
  tabs.forEach(tab => tab.addEventListener('click', () => {
    if (!note) return;
    const game = tab.dataset.game;
    note.textContent = game === '8ball' ? '' : GAME_NAMES[game] + ' IS COMING SOON!';
  }));

  /* --------------------------- offline / online --------------------------- */
  offlineBtn.addEventListener('click', () => {
    if (note) note.textContent = '';
    setMode('offline');
  });
  onlineBtn.addEventListener('click', () => {
    if (guest) {
      if (note) note.textContent = 'Online play requires an account — please log in.';
      return;
    }
    if (note) note.textContent = '';
    setMode('online');
  });

  /* --------------------------------- play -------------------------------- */
  playBtn.addEventListener('click', () => {
    if (mode === 'online') {
      if (window.PixelPoolAuth) window.PixelPoolAuth.openOnline();
      else if (note) note.textContent = 'Online is unavailable — auth.js failed to load.';
      return;
    }
    overlay.classList.add('hidden');
    setupOverlay.classList.remove('hidden');
  });

  const setupBackBtn = $('setupBackBtn');
  if (setupBackBtn) setupBackBtn.addEventListener('click', () => {
    setupOverlay.classList.add('hidden');
    overlay.classList.remove('hidden');
  });

  /* -------------------------------- sidebar ------------------------------- */
  // friends / notifications are intentionally inert for now.
  if (profileBtn) profileBtn.addEventListener('click', () => {
    if (window.PixelPoolProfile) window.PixelPoolProfile.show(currentUsername, guest);
  });
  logoutBtn.addEventListener('click', () => {
    if (window.PixelPoolAuth) window.PixelPoolAuth.logout();
    if (window.PixelPoolLanding) window.PixelPoolLanding.show();
  });

  // Collapse toggle: the panel folds away entirely and the same button keeps
  // floating in the top-right corner (it lives outside #homeSide) to bring it
  // back. State isn't reset on enter() — it stays how the player left it.
  if (homeSide && sideToggleBtn) sideToggleBtn.addEventListener('click', () => {
    const collapsed = homeSide.classList.toggle('collapsed');
    sideToggleBtn.innerHTML = collapsed ? '&#9664;' : '&#9654;';
    sideToggleBtn.setAttribute('aria-expanded', String(!collapsed));
  });

  /* ------------------------------- home chat ------------------------------ */
  // Placeholder until the friends feature exists: same look as the in-match
  // chat, collapsible, but sending goes nowhere (there's nobody to send to).
  const homeChat = $('homeChat');
  const homeChatForm = $('homeChatForm');
  const homeChatInput = $('homeChatInput');
  const homeChatToggle = $('homeChatToggle');
  if (homeChatForm) homeChatForm.addEventListener('submit', e => {
    e.preventDefault();
    if (homeChatInput) homeChatInput.value = '';
  });
  if (homeChat && homeChatToggle) homeChatToggle.addEventListener('click', () => {
    const collapsed = homeChat.classList.toggle('collapsed');
    homeChatToggle.innerHTML = collapsed ? '&#9650;' : '&#9660;';
  });

  window.PixelPoolMode = { enter };
})();

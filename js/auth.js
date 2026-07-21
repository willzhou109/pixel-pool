/* Online account flow for Pixel Pool — login / signup / lobby.
 *
 * Owns the ONLINE overlays and talks to the backend (server/) over its JSON
 * API. game.js and mode.js don't know about accounts; mode.js just calls
 * window.PixelPoolAuth.openOnline() when the ONLINE button is pressed.
 *
 * The auth API is same-origin (fetch('/api/...')), so the game must be opened
 * through the server (http://localhost:3000), not from a file:// path. If the
 * server isn't reachable, every action fails gracefully with a clear message.
 */
(function () {
  'use strict';

  const $ = id => document.getElementById(id);
  const el = {
    mode: $('modeOverlay'),
    login: $('loginOverlay'),
    signup: $('signupOverlay'),
    lobby: $('lobbyOverlay'),
    loginForm: $('loginForm'), loginUser: $('loginUser'), loginPass: $('loginPass'),
    loginBtn: $('loginBtn'), loginErr: $('loginErr'),
    signupForm: $('signupForm'), signupUser: $('signupUser'), signupPass: $('signupPass'),
    signupBtn: $('signupBtn'), signupErr: $('signupErr'),
    toSignup: $('toSignup'), toLogin: $('toLogin'),
    loginBack: $('loginBack'), signupBack: $('signupBack'),
    lobbyUser: $('lobbyUser'), logoutBtn: $('logoutBtn'),
  };
  if (!el.login || !el.signup) { console.warn('Auth: overlays missing'); return; }

  // sessionStorage (not localStorage!) — scoped per tab, not shared across every
  // tab of the origin. Testing two accounts side by side means two tabs each
  // logged into someone different; localStorage would let the second login
  // silently overwrite the first tab's session (last writer wins).
  const TOKEN_KEY = 'pp_token', USER_KEY = 'pp_user';
  const getToken = () => { try { return sessionStorage.getItem(TOKEN_KEY); } catch { return null; } };
  const setSession = (token, username) => {
    try { sessionStorage.setItem(TOKEN_KEY, token); sessionStorage.setItem(USER_KEY, username); } catch {}
  };
  const clearSession = () => {
    try { sessionStorage.removeItem(TOKEN_KEY); sessionStorage.removeItem(USER_KEY); } catch {}
  };

  /* ------------------------------ navigation ----------------------------- */
  const only = elm => {
    [el.login, el.signup, el.lobby].forEach(o => o && o.classList.add('hidden'));
    document.getElementById('landingOverlay').classList.add('hidden');
    document.getElementById('modeOverlay').classList.add('hidden');
    if (elm) elm.classList.remove('hidden');
  };
  const clearErrors = () => { el.loginErr.textContent = ''; el.signupErr.textContent = ''; };

  function showLogin()  { only(el.login);  clearErrors(); el.loginUser.focus(); }
  function showSignup() { only(el.signup); clearErrors(); el.signupUser.focus(); }
  // Back out of login/signup to the very first screen.
  function showLanding() {
    if (window.PixelPoolLanding) window.PixelPoolLanding.show();
  }
  function showHome(username) {
    if (window.PixelPoolMode) window.PixelPoolMode.enter(username, false);
  }
  function showLobby(username) {
    el.lobbyUser.textContent = (username || 'PLAYER').toUpperCase();
    only(el.lobby);
    // Hand the lobby (matchmaking + socket lifecycle) off to lobby.js.
    if (window.PixelPoolLobby) window.PixelPoolLobby.activate(username, getToken());
  }

  // Entry point used by mode.js's ONLINE button. We only get here once
  // already logged in (guests are turned away before this is called), so a
  // valid session should already exist; fall back to the login form if it
  // somehow doesn't (e.g. the token expired since the home screen loaded).
  async function openOnline() {
    const token = getToken();
    if (!token) return showLogin();
    try {
      const res = await fetch('/api/me', { headers: { Authorization: `Bearer ${token}` } });
      if (res.ok) { const data = await res.json(); return showLobby(data.username); }
    } catch { /* server unreachable — fall through to the login form */ }
    clearSession();
    showLogin();
  }

  function logout() {
    if (window.PixelPoolLobby) window.PixelPoolLobby.deactivate();
    clearSession();
  }

  /* -------------------------------- requests ----------------------------- */
  async function post(path, body) {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    let data = {};
    try { data = await res.json(); } catch {}
    return { ok: res.ok, data };
  }

  function busy(btn, on, label) {
    btn.disabled = on;
    btn.textContent = on ? 'PLEASE WAIT…' : label;
  }

  async function submit({ userEl, passEl, errEl, btn, label, path }) {
    errEl.textContent = '';
    const username = userEl.value.trim();
    const password = passEl.value;
    if (!username || !password) { errEl.textContent = 'Enter a username and password.'; return; }
    busy(btn, true, label);
    try {
      const { ok, data } = await post(path, { username, password });
      if (!ok) { errEl.textContent = data.error || 'Something went wrong.'; return; }
      setSession(data.token, data.username);
      passEl.value = '';
      showHome(data.username);
    } catch {
      errEl.textContent = 'Can\'t reach the server. Is it running (localhost:3000)?';
    } finally {
      busy(btn, false, label);
    }
  }

  /* ------------------------------- listeners ----------------------------- */
  el.loginForm.addEventListener('submit', e => {
    e.preventDefault();
    submit({ userEl: el.loginUser, passEl: el.loginPass, errEl: el.loginErr,
             btn: el.loginBtn, label: 'LOG IN', path: '/api/login' });
  });
  el.signupForm.addEventListener('submit', e => {
    e.preventDefault();
    submit({ userEl: el.signupUser, passEl: el.signupPass, errEl: el.signupErr,
             btn: el.signupBtn, label: 'SIGN UP', path: '/api/signup' });
  });

  el.toSignup.addEventListener('click', showSignup);
  el.toLogin.addEventListener('click', showLogin);
  el.loginBack.addEventListener('click', showLanding);
  el.signupBack.addEventListener('click', showLanding);
  // Lobby "LOG OUT": drop the socket + session and return to the landing screen.
  el.logoutBtn.addEventListener('click', () => {
    logout();
    showLanding();
  });

  window.PixelPoolAuth = { openOnline, showLogin, logout };
})();

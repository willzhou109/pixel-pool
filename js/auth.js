/* Online account flow for Pixel Pool — login / signup.
 *
 * Owns the LOG IN / SIGN UP overlays and talks to the backend (server/) over
 * its JSON API. On success it opens the realtime socket and hands off to the
 * home screen (mode.js), where the inline ONLINE panel (lobby.js) takes over
 * matchmaking. game.js and mode.js don't know about accounts; they read the
 * session token through window.PixelPoolAuth.getToken().
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
    loginForm: $('loginForm'), loginUser: $('loginUser'), loginPass: $('loginPass'),
    loginBtn: $('loginBtn'), loginErr: $('loginErr'),
    signupForm: $('signupForm'), signupUser: $('signupUser'), signupPass: $('signupPass'),
    signupBtn: $('signupBtn'), signupErr: $('signupErr'),
    toSignup: $('toSignup'), toLogin: $('toLogin'),
    loginBack: $('loginBack'), signupBack: $('signupBack'),
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
    [el.login, el.signup].forEach(o => o && o.classList.add('hidden'));
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
      // Open the realtime connection right away — the player is connected for
      // their whole session from the moment they log in, so entering the
      // lobby later is instant. Only logout disconnects.
      if (window.PixelPoolNet) window.PixelPoolNet.connect(data.token);
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

  window.PixelPoolAuth = { showLogin, logout, getToken };
})();

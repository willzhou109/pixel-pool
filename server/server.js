/* Pixel Pool Online — backend server.
 *
 * Zero third-party dependencies: Node's built-in http serves both the static
 * game (index.html + js/ + lib/, one directory up) and a small JSON auth API
 * under /api/. Serving the game and the API from the same origin means the
 * front-end can just fetch('/api/...') with no CORS setup.
 *
 *   Run:  node server/server.js        (or: cd server && npm start)
 *   Then: open http://localhost:3000
 */
'use strict';

// node:sqlite is still flagged "experimental" and prints a startup warning.
// It's stable enough for this; silence just that one warning to keep logs clean.
const _emit = process.emit;
process.emit = function (name, data, ...rest) {
  if (name === 'warning' && data && data.name === 'ExperimentalWarning' &&
      /SQLite/i.test(String(data.message))) return false;
  return _emit.call(this, name, data, ...rest);
};

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const auth = require('./auth');
const history = require('./history');
const stats = require('./stats');
const avatar = require('./avatar');
const profiles = require('./profiles');
const friends = require('./friends');
const chat = require('./chat');

const PORT = process.env.PORT || 3000;
const ROOT = path.resolve(__dirname, '..'); // project root holds index.html, js/, lib/

/* ------------------------------ static files ----------------------------- */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.md': 'text/plain; charset=utf-8',
};

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const filePath = path.join(ROOT, rel);
  // Path-traversal guard: the resolved path must stay inside ROOT.
  if (filePath !== ROOT && !filePath.startsWith(ROOT + path.sep)) {
    res.writeHead(403); return res.end('Forbidden');
  }
  fs.readFile(filePath, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream' });
    res.end(buf);
  });
}

/* -------------------------------- helpers -------------------------------- */
function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 10_000) { reject(new Error('Body too large')); req.destroy(); }
    });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

// Very small in-memory rate limiter: caps auth attempts per IP per minute to
// blunt brute-forcing. Not a substitute for production protection, but a
// sensible floor for a dev server.
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now(), WINDOW = 60_000, MAX = 30;
  const recent = (hits.get(ip) || []).filter(t => now - t < WINDOW);
  recent.push(now);
  hits.set(ip, recent);
  return recent.length > MAX;
}

/* --------------------------------- routes -------------------------------- */
const bearer = req => (req.headers.authorization || '').replace(/^Bearer\s+/i, '');

async function handleApi(req, res, pathname, searchParams) {
  const ip = req.socket.remoteAddress || 'unknown';

  if (pathname === '/api/me' && req.method === 'GET') {
    const { status, body } = auth.me(bearer(req));
    // Compose the avatar in here (rather than in auth.js) so avatar.js can keep
    // requiring auth for its write endpoint without a circular dependency.
    if (status === 200 && body.username) body.avatar = avatar.getAvatar(body.username);
    return sendJson(res, status, body);
  }

  // Avatars (server/avatar.js): the pickable emoji+color palette (no auth), and
  // setting the signed-in player's avatar.
  if (req.method === 'GET' && pathname === '/api/avatar/options') {
    const { status, body } = avatar.options();
    return sendJson(res, status, body);
  }
  if (req.method === 'POST' && pathname === '/api/avatar') {
    let body;
    try { body = await readJsonBody(req); }
    catch { return sendJson(res, 400, { error: 'Bad request.' }); }
    const { status, body: out } = avatar.set(bearer(req), body);
    return sendJson(res, status, out);
  }

  // Match history (server/history.js): the signed-in player's game list, and
  // one full match (stats + play-by-play) by id.
  if (req.method === 'GET' && (pathname === '/api/history' || /^\/api\/match\/\d+$/.test(pathname))) {
    const { status, body } = pathname === '/api/history'
      ? history.history(bearer(req))
      : history.matchDetail(bearer(req), Number(pathname.slice('/api/match/'.length)));
    return sendJson(res, status, body);
  }

  // Career stats (server/stats.js): the signed-in player's lifetime tallies
  // (shots, pots, fouls, streak) summed across all games, plus W/L/win-rate.
  if (req.method === 'GET' && pathname === '/api/stats') {
    const { status, body } = stats.career(bearer(req));
    return sendJson(res, status, body);
  }

  // Public profiles (server/profiles.js): view ANOTHER player's header / stats /
  // history. Any signed-in viewer may read these; the target need not be them.
  const profileRoute = /^\/api\/users\/([A-Za-z0-9_]{3,20})\/(summary|stats|history)$/.exec(pathname);
  if (req.method === 'GET' && profileRoute) {
    const name = profileRoute[1], kind = profileRoute[2];
    const handler = kind === 'summary' ? profiles.summary
      : kind === 'stats' ? profiles.stats : profiles.history;
    const { status, body } = handler(bearer(req), name);
    return sendJson(res, status, body);
  }

  // Friends (server/friends.js): the signed-in player's friends + pending
  // requests, a user search for adding people, and one conversation's history.
  if (req.method === 'GET' && pathname === '/api/friends') {
    const { status, body } = friends.list(bearer(req));
    return sendJson(res, status, body);
  }
  if (req.method === 'GET' && pathname === '/api/users/search') {
    const { status, body } = friends.search(bearer(req), searchParams.get('q'));
    return sendJson(res, status, body);
  }
  if (req.method === 'GET' && /^\/api\/messages\/[A-Za-z0-9_]{3,20}$/.test(pathname)) {
    const other = decodeURIComponent(pathname.slice('/api/messages/'.length));
    const { status, body } = chat.conversation(bearer(req), other);
    return sendJson(res, status, body);
  }

  // Friend actions — request / accept / decline / remove — all take { username }.
  const friendAction = /^\/api\/friends\/(request|accept|decline|remove)$/.exec(pathname);
  if (req.method === 'POST' && friendAction) {
    let body;
    try { body = await readJsonBody(req); }
    catch { return sendJson(res, 400, { error: 'Bad request.' }); }
    const { status, body: out } = friends[friendAction[1]](bearer(req), body);
    return sendJson(res, status, out);
  }

  if ((pathname === '/api/signup' || pathname === '/api/login') && req.method === 'POST') {
    if (rateLimited(ip)) return sendJson(res, 429, { error: 'Too many attempts. Wait a minute and try again.' });
    let body;
    try { body = await readJsonBody(req); }
    catch { return sendJson(res, 400, { error: 'Bad request.' }); }
    const handler = pathname === '/api/signup' ? auth.signup : auth.login;
    try {
      const { status, body: out } = await handler(body);
      return sendJson(res, status, out);
    } catch (e) {
      console.error('[api] handler error:', e);
      return sendJson(res, 500, { error: 'Server error. Try again.' });
    }
  }

  return sendJson(res, 404, { error: 'Not found.' });
}

/* -------------------------------- server --------------------------------- */
const server = http.createServer((req, res) => {
  const { pathname, searchParams } = new URL(req.url, 'http://localhost');
  if (pathname.startsWith('/api/')) return handleApi(req, res, pathname, searchParams);
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end('Method not allowed'); }
  return serveStatic(req, res, pathname);
});

// Attach the Socket.IO real-time layer to this same server. Done AFTER
// http.createServer (so our request handler above is registered first —
// Socket.IO preserves it for non-/socket.io/ requests) and before listen().
require('./realtime').initRealtime(server);

server.listen(PORT, () => {
  console.log(`Pixel Pool Online running at http://localhost:${PORT}`);
});

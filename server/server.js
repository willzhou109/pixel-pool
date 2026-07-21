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
async function handleApi(req, res, pathname) {
  const ip = req.socket.remoteAddress || 'unknown';

  if (pathname === '/api/me' && req.method === 'GET') {
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const { status, body } = auth.me(token);
    return sendJson(res, status, body);
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
  const { pathname } = new URL(req.url, 'http://localhost');
  if (pathname.startsWith('/api/')) return handleApi(req, res, pathname);
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

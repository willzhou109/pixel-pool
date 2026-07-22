/* Authentication logic for Pixel Pool Online.
 *
 * Pure functions over Node's crypto primitives — no third-party libraries:
 *   - Passwords are hashed with scrypt (memory-hard, salted per user).
 *   - Session tokens are HMAC-signed, JWT-style payloads (no jsonwebtoken dep).
 *
 * The exported signup/login handlers take a parsed body and return
 * { status, body } so the transport layer (server.js) stays dumb.
 */
'use strict';

const crypto = require('node:crypto');
const { createUser, findUser } = require('./db');

/* --------------------------------- secret -------------------------------- */
// Signing secret for session tokens. Set PP_SECRET in the environment for a
// stable secret across restarts; otherwise a random one is generated per run
// (fine for local dev — you just re-log-in after a restart).
const SECRET = process.env.PP_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.PP_SECRET) {
  console.warn('[auth] PP_SECRET not set — using a random dev secret (tokens reset on restart).');
}
const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/* ------------------------------ password hash ---------------------------- */
const SCRYPT_KEYLEN = 64;

function hashPassword(password) {
  return new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(16);
    crypto.scrypt(password, salt, SCRYPT_KEYLEN, (err, derived) => {
      if (err) return reject(err);
      resolve(`${salt.toString('hex')}:${derived.toString('hex')}`);
    });
  });
}

function verifyPassword(password, stored) {
  return new Promise(resolve => {
    const [saltHex, hashHex] = String(stored).split(':');
    if (!saltHex || !hashHex) return resolve(false);
    const salt = Buffer.from(saltHex, 'hex');
    const expected = Buffer.from(hashHex, 'hex');
    crypto.scrypt(password, salt, expected.length, (err, derived) => {
      if (err) return resolve(false);
      // Constant-time compare to avoid leaking timing information.
      resolve(derived.length === expected.length && crypto.timingSafeEqual(derived, expected));
    });
  });
}

/* -------------------------------- tokens --------------------------------- */
const b64url = buf => Buffer.from(buf).toString('base64url');

function signToken(username) {
  const payload = b64url(JSON.stringify({ sub: username, exp: Date.now() + TOKEN_TTL_MS }));
  const sig = b64url(crypto.createHmac('sha256', SECRET).update(payload).digest());
  return `${payload}.${sig}`;
}

function verifyToken(token) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [payload, sig] = token.split('.');
  const expected = b64url(crypto.createHmac('sha256', SECRET).update(payload).digest());
  // Length-check first so timingSafeEqual can't throw on mismatched buffers.
  if (sig.length !== expected.length ||
      !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (!data.exp || Date.now() > data.exp) return null;
    return data.sub;
  } catch {
    return null;
  }
}

/* ------------------------------ validation ------------------------------- */
const USERNAME_RE = /^[A-Za-z0-9_]{3,20}$/;

function validate(username, password) {
  if (typeof username !== 'string' || typeof password !== 'string') return 'Missing username or password.';
  if (!USERNAME_RE.test(username)) return 'Username must be 3–20 letters, numbers, or underscores.';
  if (password.length < 8) return 'Password must be at least 8 characters.';
  if (password.length > 200) return 'Password is too long.';
  return null;
}

/* ------------------------------- handlers -------------------------------- */
async function signup(body) {
  const { username, password } = body || {};
  const err = validate(username, password);
  if (err) return { status: 400, body: { error: err } };

  const hash = await hashPassword(password);
  try {
    createUser(username, hash);
  } catch (e) {
    // UNIQUE constraint (or any insert failure) — treat as name taken.
    return { status: 409, body: { error: 'That username is already taken.' } };
  }
  const user = findUser(username);
  return { status: 201, body: { token: signToken(username), username, createdAt: user.created_at } };
}

async function login(body) {
  const { username, password } = body || {};
  if (typeof username !== 'string' || typeof password !== 'string' || !username || !password) {
    return { status: 400, body: { error: 'Enter your username and password.' } };
  }
  const user = findUser(username);
  // Always run a verify to keep timing similar whether or not the user exists.
  const ok = user
    ? await verifyPassword(password, user.password_hash)
    : await verifyPassword(password, `${'0'.repeat(32)}:${'0'.repeat(128)}`);
  if (!user || !ok) {
    // Generic message — never reveal which field was wrong.
    return { status: 401, body: { error: 'Invalid username or password.' } };
  }
  return { status: 200, body: { token: signToken(user.username), username: user.username, createdAt: user.created_at } };
}

function me(token) {
  const username = verifyToken(token);
  if (!username) return { status: 401, body: { error: 'Not signed in.' } };
  const user = findUser(username);
  return { status: 200, body: { username, createdAt: user ? user.created_at : null } };
}

module.exports = { signup, login, me, verifyToken };

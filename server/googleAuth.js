/* Verifies Google "Sign in with Google" ID tokens — no third-party dependency.
 *
 * The browser (Google Identity Services script) hands us a signed JWT
 * asserting the user's Google account. We verify it ourselves against
 * Google's public signing keys rather than trusting the client:
 *   1. fetch Google's current JWKS (cached — they rotate keys periodically)
 *   2. find the key matching the token's `kid`
 *   3. verify the RS256 signature over header.payload with that key
 *   4. check issuer, audience (our client id) and expiry
 *
 * Only Node built-ins are used: global fetch (Node 18+) and node:crypto's
 * JWK import, which can verify RS256 signatures directly.
 */
'use strict';

const crypto = require('node:crypto');

const JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const JWKS_TTL_MS = 6 * 60 * 60 * 1000; // Google rotates keys every few hours

let jwksCache = null;
let jwksFetchedAt = 0;

async function getJwks(forceRefresh) {
  if (!forceRefresh && jwksCache && Date.now() - jwksFetchedAt < JWKS_TTL_MS) return jwksCache;
  const res = await fetch(JWKS_URL);
  if (!res.ok) throw new Error('Could not fetch Google public keys');
  const data = await res.json();
  jwksCache = data.keys || [];
  jwksFetchedAt = Date.now();
  return jwksCache;
}

const b64urlJson = str => JSON.parse(Buffer.from(str, 'base64url').toString('utf8'));

/** Verify a Google ID token (JWT). Returns the decoded payload (sub, email,
 * email_verified, name, picture, ...) or throws with a human-readable reason. */
async function verifyIdToken(idToken, clientId) {
  if (!clientId) throw new Error('Google sign-in is not configured on this server.');
  if (typeof idToken !== 'string') throw new Error('Missing credential.');
  const parts = idToken.split('.');
  if (parts.length !== 3) throw new Error('Malformed token.');
  const [headerB64, payloadB64, sigB64] = parts;

  let header, payload;
  try {
    header = b64urlJson(headerB64);
    payload = b64urlJson(payloadB64);
  } catch {
    throw new Error('Malformed token.');
  }
  if (header.alg !== 'RS256') throw new Error('Unexpected token algorithm.');

  let keys = await getJwks(false);
  let jwk = keys.find(k => k.kid === header.kid);
  if (!jwk) {
    // Key rotated since our last fetch — refresh once and retry.
    keys = await getJwks(true);
    jwk = keys.find(k => k.kid === header.kid);
  }
  if (!jwk) throw new Error('Unknown signing key.');

  const publicKey = crypto.createPublicKey({ key: jwk, format: 'jwk' });
  const signedData = Buffer.from(`${headerB64}.${payloadB64}`);
  const signature = Buffer.from(sigB64, 'base64url');
  const validSig = crypto.verify(
    'RSA-SHA256', signedData,
    { key: publicKey, padding: crypto.constants.RSA_PKCS1_PADDING },
    signature
  );
  if (!validSig) throw new Error('Invalid token signature.');

  if (payload.iss !== 'https://accounts.google.com' && payload.iss !== 'accounts.google.com') {
    throw new Error('Invalid token issuer.');
  }
  if (payload.aud !== clientId) throw new Error('Token was not issued for this app.');
  if (!payload.exp || Date.now() / 1000 > payload.exp) throw new Error('Token expired.');

  return payload;
}

module.exports = { verifyIdToken };

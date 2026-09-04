/* Loads server/../.env into process.env, if the file exists.
 *
 * Uses Node's built-in process.loadEnvFile() (Node 20.12+), so there's no
 * dotenv dependency — consistent with the rest of the backend running on
 * built-ins alone.
 *
 * Real environment variables always win: loadEnvFile does not overwrite a
 * variable that is already set, so a .env on your laptop can never override
 * what Railway injects in production.
 *
 * Require this FIRST, before any module that reads process.env at load time
 * (server/auth.js and server/commentary/index.js both do).
 */
'use strict';

const path = require('node:path');
const fs = require('node:fs');

const ENV_PATH = path.resolve(__dirname, '..', '.env');

if (fs.existsSync(ENV_PATH)) {
  try {
    process.loadEnvFile(ENV_PATH);
  } catch (e) {
    // A malformed .env shouldn't take the server down — the process env (or
    // the feature's own "not configured" path) still applies.
    console.warn('[env] could not read .env:', e.message);
  }
}

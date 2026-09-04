/* Prove the hand-written forward pass in js/potmodel.js matches the Keras model
 * it was exported from. A tensor library never ships to the browser, so this is
 * the only thing standing between a weights file and silently wrong pot odds.
 *
 * Reads the fixture tools/train_pot.py writes at export time.
 *   node tools/check-potmodel.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const M = require('../js/potmodel.js');

const root = path.join(__dirname, '..');
M.use(JSON.parse(fs.readFileSync(path.join(root, 'js', 'potmodel.json'), 'utf8')));
const fx = JSON.parse(fs.readFileSync(path.join(root, 'data', 'potmodel-check.json'), 'utf8'));

let worstM = 0, worstW = 0, n = 0;
for (let i = 0; i < fx.rows.length; i++) {
  const f = {};
  fx.features.forEach((name, j) => { f[name] = fx.rows[i][j]; });
  const got = M.predict(f);
  if (!got) { console.error('predict() returned null on row ' + i); process.exit(1); }
  worstM = Math.max(worstM, Math.abs(got.makeable - fx.makeable[i]));
  // Compare the window in log space: it spans orders of magnitude, so an
  // absolute difference on a hanger says nothing about a thin cut.
  worstW = Math.max(worstW, Math.abs(Math.log(got.w) - Math.log(fx.w[i])));
  n++;
}

// float32 weights read back through JSON and summed in float64 — agreement is
// to within accumulation noise, not to the bit.
const TOL = 1e-5;
console.log(`checked ${n} rows against Keras`);
console.log(`  makeable: largest difference ${worstM.toExponential(2)}`);
console.log(`  log w   : largest difference ${worstW.toExponential(2)}`);

// And the piece the bot actually calls, end to end.
const f0 = {};
fx.features.forEach((name, j) => { f0[name] = fx.rows[0][j]; });
for (const sigma of [0.0005, 0.002, 0.01]) {
  console.log(`  P(pot | sigma=${sigma}) = ${M.potProbability(f0, sigma).toFixed(4)}`);
}

const ok = worstM < TOL && worstW < TOL;
console.log(ok ? '\nPASS' : `\nFAIL — the JS forward pass disagrees with Keras (tol ${TOL})`);
process.exit(ok ? 0 : 1);

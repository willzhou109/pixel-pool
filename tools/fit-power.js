/* Fit js/bot.js's powerFor() against the simulator.
 *
 * powerFor answers "how hard do I hit this to pot it?" — enough to reach the
 * ghost-ball contact point, plus enough left over to drive the object ball to
 * the pocket, with extra on a thin cut where little energy transfers:
 *
 *     p = A + B*dCue + C*(dObj / max(cosCut, 0.35))
 *
 * A, B and C are cloth-dependent. Change the friction and they are wrong: a
 * stroke that used to just reach now sails, the cue ball runs miles past where
 * the position planner wanted it, and the bot's shape play quietly degrades
 * even though it still pots fine.
 *
 * So this measures the truth instead of guessing it. For a few thousand random
 * candidate pots it binary-searches the MINIMUM power that actually drops the
 * ball, then least-squares fits the coefficients to those minima and scales
 * them by a safety margin (a stroke at exactly p_min only just arrives; the
 * ball has to be potted, not dribbled at the jaws).
 *
 * Usage:  node tools/fit-power.js [--game=8ball] [--n=1500] [--seed=1]
 *                                 [--margin=1.25]
 */
'use strict';

const fs = require('fs');
const path = require('path');

global.window = global;
require('../js/banks.js');
require('../js/position.js');
require('../js/bot.js');
const PHYS = require('../js/physics.js');
const BOT = global.PoolBot;

const arg = (k, d) => {
  const hit = process.argv.find(a => a.startsWith(`--${k}=`));
  return hit ? hit.slice(k.length + 3) : d;
};
const GAME = arg('game', '8ball');
const WANT = +arg('n', 1500);
// Margin over the measured minimum. 2.25 is not arbitrary: tools/eval-position.js
// sweeps it and this is where rail-endings bottom out without costing pots. A
// stroke at exactly p_min only just arrives, and powerFor is both the centre of
// planShot's POWER_TRIES search and the raw fallback when that search is skipped.
const MARGIN = +arg('margin', 2.25);
const CFG = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'data', `physics-${GAME}.json`), 'utf8'));

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(+arg('seed', 1) | 0);
const between = (lo, hi) => lo + rnd() * (hi - lo);

const T = {
  R: CFG.R, PW: CFG.PW, PH: CFG.PH, LIMX: CFG.LIMX, LIMZ: CFG.LIMZ,
  CORNER_GAP: CFG.CORNER_GAP, SIDE_GAP: CFG.SIDE_GAP, POCKETS: CFG.POCKETS,
  REST_BALL: CFG.REST_BALL, REST_CUSH: CFG.REST_CUSH, CUSH_GRIP: CFG.CUSH_GRIP,
  FRIC_C: CFG.FRIC_C, FRIC_L: CFG.FRIC_L, STOP_V: CFG.STOP_V,
};
const ctxBase = Object.assign({}, T, {
  REST: CFG.REST_CUSH, GRIP: CFG.CUSH_GRIP, MAX_V: CFG.MAX_V, PHYS_H: CFG.PHYS_H,
});
const OBJECT_IDS = GAME === 'snooker' ? Array.from({ length: 21 }, (_, i) => i + 1)
  : GAME === '9ball' ? [1, 2, 3, 4, 5, 6, 7, 8, 9]
    : Array.from({ length: 15 }, (_, i) => i + 1);

function scatter(n) {
  const balls = [], R = CFG.R;
  const place = id => {
    for (let t = 0; t < 200; t++) {
      const x = between(-CFG.LIMX, CFG.LIMX), z = between(-CFG.LIMZ, CFG.LIMZ);
      let ok = true;
      for (const b of balls) if ((b.x - x) ** 2 + (b.z - z) ** 2 < (2 * R * 1.06) ** 2) { ok = false; break; }
      if (ok) for (const p of CFG.POCKETS) if ((p.x - x) ** 2 + (p.z - z) ** 2 < (p.r + R) ** 2) { ok = false; break; }
      if (ok) { balls.push({ id, x, z }); return; }
    }
  };
  place(0);
  const pool = OBJECT_IDS.slice();
  for (let i = 0; i < n && pool.length; i++) place(pool.splice((rnd() * pool.length) | 0, 1)[0]);
  return balls;
}

function pots(layout, cand, power) {
  const balls = layout.map(b => ({ id: b.id, x: b.x, z: b.z, vx: 0, vz: 0, potted: false }));
  balls[0].vx = cand.dir.x * power * CFG.MAX_V;
  balls[0].vz = cand.dir.z * power * CFG.MAX_V;
  const ev = PHYS.newEvents();
  let hit = false, steps = 0;
  do {
    const es = PHYS.step(T, balls, CFG.PHYS_H, ev);
    if (es) for (const e of es) {
      if (e.type === 'pot' && e.id === cand.target && e.pocket === cand.pocket) hit = true;
    }
    steps++;
  } while (PHYS.anyMoving(balls) && steps < 20000);
  return hit;
}

// Smallest power that still drops it. Potting is monotone in power over the
// range that matters — too soft never arrives — so a bisection is safe once a
// working upper bound is found.
function minPower(layout, cand) {
  let hi = null;
  for (const p of [0.24, 0.35, 0.5, 0.7, 0.9]) if (pots(layout, cand, p)) { hi = p; break; }
  if (hi === null) return null;
  let lo = 0.02;
  for (let i = 0; i < 14; i++) {
    const mid = (lo + hi) / 2;
    if (pots(layout, cand, mid)) hi = mid; else lo = mid;
  }
  return hi;
}

/* ------------------------------- collect -------------------------------- */

const rows = [];
let tried = 0;
const t0 = Date.now();
while (rows.length < WANT && tried < WANT * 40) {
  tried++;
  const layout = scatter(2 + ((rnd() * 10) | 0));
  const cue = layout[0], objs = layout.slice(1);
  if (!objs.length) continue;
  const ctx = Object.assign({}, ctxBase, { balls: objs, cue: { x: cue.x, z: cue.z } });
  const cands = BOT.potCandidates(ctx, cue, objs, objs);
  if (!cands.length) continue;
  const cand = cands[(rnd() * cands.length) | 0];
  const p = minPower(layout, cand);
  if (p === null) continue;
  rows.push({
    dCue: cand.dCue,
    cutBoost: cand.dObj / Math.max(cand.cosCut, 0.35),
    p,
    old: BOT.powerFor(cand),
  });
  if (rows.length % 100 === 0) {
    process.stdout.write(`\r  ${rows.length}/${WANT} shots measured`);
  }
}
process.stdout.write('\n');

/* --------------------------------- fit ---------------------------------- */
// Ordinary least squares on [1, dCue, cutBoost] -> p_min, by normal equations.
// Three unknowns; a 3x3 Gaussian elimination is the whole of it.
function fit(rows) {
  const X = rows.map(r => [1, r.dCue, r.cutBoost]);
  const y = rows.map(r => r.p);
  const A = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
  for (let i = 0; i < X.length; i++) {
    for (let a = 0; a < 3; a++) {
      for (let b = 0; b < 3; b++) A[a][b] += X[i][a] * X[i][b];
      A[a][3] += X[i][a] * y[i];
    }
  }
  for (let c = 0; c < 3; c++) {
    let piv = c;
    for (let r = c + 1; r < 3; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
    [A[c], A[piv]] = [A[piv], A[c]];
    for (let r = 0; r < 3; r++) {
      if (r === c) continue;
      const f = A[r][c] / A[c][c];
      for (let k = c; k < 4; k++) A[r][k] -= f * A[c][k];
    }
  }
  return [A[0][3] / A[0][0], A[1][3] / A[1][1], A[2][3] / A[2][2]];
}

const [a, b, c] = fit(rows);
const secs = (Date.now() - t0) / 1000;

console.log(`\n${rows.length} shots, ${secs.toFixed(1)}s ` +
  `(friction FRIC_C=${CFG.FRIC_C}, FRIC_L=${CFG.FRIC_L})\n`);
console.log('minimum power that pots the ball, fitted:');
console.log(`  p_min = ${a.toFixed(4)} + ${b.toFixed(4)}*dCue + ${c.toFixed(4)}*cutBoost`);
console.log(`\nwith a x${MARGIN} margin, powerFor should be:`);
console.log(`  p = ${(a * MARGIN).toFixed(2)} + ${(b * MARGIN).toFixed(2)}*dCue + ` +
  `${(c * MARGIN).toFixed(2)}*cutBoost`);
console.log('\n  js/bot.js currently has: p = 0.30 + 0.16*dCue + 0.26*cutBoost');

// How badly is the shipped formula overshooting right now?
const ratio = rows.map(r => r.old / r.p).sort((x, y) => x - y);
const q = p => ratio[Math.floor(p * (ratio.length - 1))];
console.log(`\ncurrent powerFor vs the true minimum (ratio):`);
console.log(`  p25 ${q(0.25).toFixed(2)}x   median ${q(0.5).toFixed(2)}x   p75 ${q(0.75).toFixed(2)}x`);
console.log(`  ${(100 * ratio.filter(r => r > 2).length / ratio.length).toFixed(0)}% of shots ` +
  `are struck at more than TWICE the power needed`);

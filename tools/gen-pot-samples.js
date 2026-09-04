/* Generate training data for the shot-outcome model.
 *
 * WHAT IT LEARNS. js/bot.js scores a pot with a hand-tuned line,
 *     hardness = (1 - cosCut) * 2.4 + (dCue + dObj) * 0.55 + railHug
 * and separately guesses its own aim error with another hand-tuned line
 * (aimSigma). Both are standing in for one thing nobody measured: how much the
 * aim can be wrong and still pot the ball. game.js DOES compute that exactly —
 * its FAN/STEP fan search walks out from the nominal aim and bisects for the
 * edges of the make window — but at a few hundred raycasts a shot it is far too
 * slow to call inside the bot's position lookahead, which is why the cheap
 * proxy exists at all.
 *
 * So the label here is the make window itself: the half-width, in radians, of
 * the band of aim errors that still sends the target into the intended pocket,
 * measured against the real simulator. That is a purely GEOMETRIC property —
 * it says nothing about how steady the shooter's cue is — which is what makes
 * it the right thing to learn:
 *     P(pot) = erf(w / (sigma * sqrt(2)))   for Gaussian aim error sigma
 * Skill stays a separate knob, so difficulty can be retuned without retraining,
 * and the label is a dense real number rather than a noisy coin flip.
 *
 * Features come from js/bot.js's own potCandidates(), never from a copy, so the
 * model is trained on exactly the numbers the bot will feed it at run time.
 *
 * Usage:
 *   node tools/gen-pot-samples.js [--game=8ball] [--n=20000] [--out=FILE]
 *                                 [--seed=1] [--jobs=1] [--job=0]
 */
'use strict';

const fs = require('fs');
const path = require('path');

global.window = global;                       // the browser modules assign onto this
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
const WANT = +arg('n', 20000);
const JOBS = +arg('jobs', 1);
const JOB = +arg('job', 0);
const OUT = arg('out', path.join(__dirname, '..', 'data', `pot-samples-${GAME}${JOBS > 1 ? '.' + JOB : ''}.jsonl`));

const CFG = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'data', `physics-${GAME}.json`), 'utf8'));

/* Deterministic RNG, so a dataset can be regenerated exactly. */
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32((+arg('seed', 1) | 0) + JOB * 7919);
const between = (lo, hi) => lo + rnd() * (hi - lo);
// Box-Muller, for the odd place a normal is wanted.
const gauss = () => Math.sqrt(-2 * Math.log(1 - rnd())) * Math.cos(2 * Math.PI * rnd());

/* ------------------------------- the table ------------------------------- */

const T = {                                   // what js/physics.js runs on
  R: CFG.R, PW: CFG.PW, PH: CFG.PH, LIMX: CFG.LIMX, LIMZ: CFG.LIMZ,
  CORNER_GAP: CFG.CORNER_GAP, SIDE_GAP: CFG.SIDE_GAP, POCKETS: CFG.POCKETS,
  REST_BALL: CFG.REST_BALL, REST_CUSH: CFG.REST_CUSH, CUSH_GRIP: CFG.CUSH_GRIP,
  FRIC_C: CFG.FRIC_C, FRIC_L: CFG.FRIC_L, STOP_V: CFG.STOP_V,
};
// What js/bot.js's potCandidates() reads. Same numbers, the names it expects.
const ctxBase = {
  R: CFG.R, PW: CFG.PW, PH: CFG.PH, LIMX: CFG.LIMX, LIMZ: CFG.LIMZ,
  CORNER_GAP: CFG.CORNER_GAP, SIDE_GAP: CFG.SIDE_GAP, POCKETS: CFG.POCKETS,
  REST: CFG.REST_CUSH, GRIP: CFG.CUSH_GRIP, REST_BALL: CFG.REST_BALL,
  FRIC_C: CFG.FRIC_C, FRIC_L: CFG.FRIC_L, STOP_V: CFG.STOP_V,
  MAX_V: CFG.MAX_V, PHYS_H: CFG.PHYS_H,
};

const OBJECT_IDS = GAME === 'snooker'
  ? Array.from({ length: 21 }, (_, i) => i + 1)
  : GAME === '9ball' ? [1, 2, 3, 4, 5, 6, 7, 8, 9]
    : Array.from({ length: 15 }, (_, i) => i + 1);

/* --------------------------- layout generation --------------------------- */

// A random legal scatter. Random layouts beat replaying real frames here: real
// play concentrates on the positions the bot already reaches, and the model has
// to be right about the shots it currently misjudges — which are exactly the
// ones it rarely takes.
function scatter(n) {
  const balls = [];
  const R = CFG.R;
  const place = id => {
    for (let tries = 0; tries < 200; tries++) {
      const x = between(-CFG.LIMX, CFG.LIMX), z = between(-CFG.LIMZ, CFG.LIMZ);
      let ok = true;
      for (const b of balls) {
        if ((b.x - x) ** 2 + (b.z - z) ** 2 < (2 * R * 1.06) ** 2) { ok = false; break; }
      }
      if (ok) for (const p of CFG.POCKETS) {
        if ((p.x - x) ** 2 + (p.z - z) ** 2 < (p.r + R) ** 2) { ok = false; break; }
      }
      if (ok) { balls.push({ id, x, z }); return true; }
    }
    return false;
  };
  place(0);                                   // cue ball
  const pool = OBJECT_IDS.slice();
  for (let i = 0; i < n && pool.length; i++) {
    place(pool.splice((rnd() * pool.length) | 0, 1)[0]);
  }
  return balls;
}

/* ------------------------------ simulation ------------------------------- */

const MAX_STEPS = 20000;

// Play one stroke out to rest. Returns which balls dropped and where the cue
// finished — the same core the browser runs, so an outcome measured here is the
// outcome a player would see.
function simulate(layout, dir, speed) {
  const balls = layout.map(b => ({ id: b.id, x: b.x, z: b.z, vx: 0, vz: 0, potted: false }));
  balls[0].vx = dir.x * speed;
  balls[0].vz = dir.z * speed;
  const ev = PHYS.newEvents();
  const pots = [];
  let steps = 0;
  do {
    const events = PHYS.step(T, balls, CFG.PHYS_H, ev);
    if (events) for (const e of events) if (e.type === 'pot') pots.push({ id: e.id, pocket: e.pocket });
    steps++;
  } while (PHYS.anyMoving(balls) && steps < MAX_STEPS);
  return { balls, ev, pots, steps };
}

const yawTo = dir => Math.atan2(-dir.x, -dir.z);   // matches game.js's aimDir()
const dirOf = yaw => ({ x: -Math.sin(yaw), z: -Math.cos(yaw) });

/* Measure the make window: how far the aim can stray either way and still send
   `target` into `pocket`. Mirrors game.js's own edge-finding (walk out in steps,
   then bisect) but against the real simulator instead of the geometric
   predictor, so throw, clipped neighbours and speed all count.
   Returns { w, lo, hi, nominal, sims } — w is the half-width in radians. */
const FAN = 0.10, STEP = 0.002, BISECT = 10;

function makeWindow(layout, cand, speed) {
  let sims = 0;
  const nominalYaw = yawTo(cand.dir);
  const makes = off => {
    sims++;
    const r = simulate(layout, dirOf(nominalYaw + off), speed);
    return r.pots.some(p => p.id === cand.target && p.pocket === cand.pocket);
  };

  // Find any aim that pots it. The geometric nominal usually does; if it does
  // not, this shot may still be on at a small offset (throw, or a neighbour the
  // predictor ignored), so sweep before giving up.
  let seed = null;
  if (makes(0)) seed = 0;
  else {
    for (let off = STEP; off <= FAN && seed === null; off += STEP) {
      if (makes(off)) seed = off;
      else if (makes(-off)) seed = -off;
    }
  }
  if (seed === null) return { w: 0, lo: 0, hi: 0, nominal: false, sims };

  const edge = dir => {
    let inside = seed, outside = seed + dir * STEP, guard = 0;
    while (makes(outside) && guard++ < 120) { inside = outside; outside += dir * STEP; }
    for (let i = 0; i < BISECT; i++) {
      const mid = (inside + outside) / 2;
      if (makes(mid)) inside = mid; else outside = mid;
    }
    return inside;
  };
  const lo = edge(-1), hi = edge(1);
  return { w: (hi - lo) / 2, lo, hi, nominal: seed === 0, sims };
}

/* -------------------------------- driver --------------------------------- */

const out = fs.createWriteStream(OUT);
let written = 0, sims = 0, skipped = 0;
const t0 = Date.now();

while (written < WANT) {
  const layout = scatter(2 + ((rnd() * 12) | 0));
  const cue = layout[0];
  const objs = layout.slice(1);
  if (!objs.length) continue;

  const ctx = Object.assign({}, ctxBase, { balls: objs, cue: { x: cue.x, z: cue.z } });
  const cands = BOT.potCandidates(ctx, cue, objs, objs);
  if (!cands.length) { skipped++; continue; }

  // One candidate per layout: samples from the same layout share most of their
  // geometry, and correlated rows buy far less than fresh ones.
  const cand = cands[(rnd() * cands.length) | 0];

  // Spread the stroke around what the bot would actually play, so the model
  // sees the speed range the bot explores (POWER_TRIES) rather than one point.
  const power = Math.max(0.24, Math.min(0.95, BOT.powerFor(cand) * between(0.8, 1.7)));
  const speed = power * CFG.MAX_V;

  const win = makeWindow(layout, cand, speed);
  sims += win.sims;

  // Nearest neighbour to the two shot lines: how much traffic the shot has to
  // thread. potCandidates already rejects fully blocked paths, so what is left
  // is the margin, and that is what decides whether a near-miss still drops.
  const clearance = minClearance(layout, cue, cand);

  out.write(JSON.stringify({
    // features — all of them available to the bot at decision time
    cosCut: r6(cand.cosCut), dCue: r6(cand.dCue), dObj: r6(cand.dObj),
    power: r6(power), side: cand.pocket >= 4 ? 1 : 0,
    railT: r6(railDist(cand.from)), railC: r6(railDist(cue)),
    clearCue: r6(clearance.cue), clearObj: r6(clearance.obj),
    // labels
    w: r6(win.w), potted: win.w > 0 ? 1 : 0,
    // kept for reference / later models, not fed to this one
    hardness: r6(cand.hardness), pocket: cand.pocket,
  }) + '\n');
  written++;
  if (written % 250 === 0) {
    const rate = written / ((Date.now() - t0) / 1000);
    process.stdout.write(`\r  ${written}/${WANT} samples  ${sims} sims  ${rate.toFixed(0)}/s`);
  }
}

out.end();
const secs = (Date.now() - t0) / 1000;
process.stdout.write('\n');
console.log(`wrote ${written} samples to ${path.relative(process.cwd(), OUT)}`);
console.log(`  ${sims} shot simulations in ${secs.toFixed(1)}s (${(sims / secs).toFixed(0)}/s), ` +
  `${skipped} layouts had no pot on`);

/* --------------------------------- utils --------------------------------- */

function r6(v) { return Math.round(v * 1e6) / 1e6; }

// Distance from a ball to the nearest cushion, in ball radii — the bot's
// `railHug` is a step function of this, so give the model the real number.
function railDist(p) {
  return Math.min(CFG.LIMX - Math.abs(p.x), CFG.LIMZ - Math.abs(p.z)) / CFG.R;
}

// Tightest gap any other ball leaves against the cue's line to the ghost and
// the object's line to the pocket, in ball radii (capped — past a few radii it
// stops mattering).
function minClearance(layout, cue, cand) {
  const R = CFG.R, P = CFG.POCKETS[cand.pocket];
  // The ghost-ball centre: one ball diameter back from the object along the
  // line to the pocket — where the cue ball has to arrive. Same construction
  // potCandidates uses.
  const ol = Math.hypot(P.x - cand.from.x, P.z - cand.from.z) || 1;
  const g = {
    x: cand.from.x - (P.x - cand.from.x) / ol * 2 * R,
    z: cand.from.z - (P.z - cand.from.z) / ol * 2 * R,
  };
  const gap = (a, b, skip) => {
    let m = Infinity;
    const dx = b.x - a.x, dz = b.z - a.z, len = Math.hypot(dx, dz) || 1;
    const ux = dx / len, uz = dz / len;
    for (const o of layout) {
      if (skip.includes(o.id)) continue;
      const t = (o.x - a.x) * ux + (o.z - a.z) * uz;
      if (t <= 0 || t >= len) continue;
      m = Math.min(m, Math.hypot(o.x - (a.x + ux * t), o.z - (a.z + uz * t)));
    }
    return Math.min(m / R, 8);                // 8 radii clear is as good as infinite
  };
  return { cue: gap(cue, g, [0, cand.target]), obj: gap(cand.from, P, [cand.target, 0]) };
}

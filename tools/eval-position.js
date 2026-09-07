/* Does the bot still play good position?
 *
 * Potting is easy to measure and easy to keep. Position — where the cue ball
 * finishes, and whether there is anything on from there — is what actually
 * separates a bot that runs out from one that pots a ball and then has nothing,
 * and it is the thing a friction change quietly wrecks: the cloth decides how
 * far a stroke carries, so a power model fitted to the old cloth sends the cue
 * sailing past where the planner wanted it.
 *
 * So this plays the bot's own chosen shot for real and scores the result:
 *   potted     did the intended ball drop
 *   scratched  did the cue ball go down with it
 *   nextCost   the bot's own easiestPot() from wherever the cue finished —
 *              its verdict on "what have I got now?", low is good
 *   railEnd    finished within two ball-widths of a cushion (awkward bridge)
 *
 * Any A/B here has to hold the LAYOUTS fixed and vary only the setting, or the
 * comparison is measuring luck. Pass --fit to try a candidate power fit against
 * the shipped one.
 *
 * Usage:
 *   node tools/eval-position.js [--game=8ball] [--n=400] [--seed=7]
 *   node tools/eval-position.js --fit=0.034,0.135,0.223   # A/B vs shipped
 */
'use strict';

const fs = require('fs');
const path = require('path');

global.window = global;
require('../js/banks.js');
require('../js/position.js');
const M = require('../js/potmodel.js');
require('../js/bot.js');
const PHYS = require('../js/physics.js');
const BOT = global.PoolBot;

const arg = (k, d) => {
  const hit = process.argv.find(a => a.startsWith(`--${k}=`));
  return hit ? hit.slice(k.length + 3) : d;
};
const GAME = arg('game', '8ball');
const N = +arg('n', 400);
const root = path.join(__dirname, '..');
const CFG = JSON.parse(fs.readFileSync(path.join(root, 'data', `physics-${GAME}.json`), 'utf8'));

// The shot-outcome model is part of the shipped bot, so evaluate with it on.
const modelPath = path.join(root, 'js', 'potmodel.json');
if (fs.existsSync(modelPath)) M.use(JSON.parse(fs.readFileSync(modelPath, 'utf8')));

const T = {
  R: CFG.R, PW: CFG.PW, PH: CFG.PH, LIMX: CFG.LIMX, LIMZ: CFG.LIMZ,
  CORNER_GAP: CFG.CORNER_GAP, SIDE_GAP: CFG.SIDE_GAP, POCKETS: CFG.POCKETS,
  REST_BALL: CFG.REST_BALL, REST_CUSH: CFG.REST_CUSH, CUSH_GRIP: CFG.CUSH_GRIP,
  FRIC_C: CFG.FRIC_C, FRIC_L: CFG.FRIC_L, STOP_V: CFG.STOP_V,
};
const ctxBase = Object.assign({}, T, {
  REST: CFG.REST_CUSH, GRIP: CFG.CUSH_GRIP, MAX_V: CFG.MAX_V, PHYS_H: CFG.PHYS_H,
});

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const OBJECT_IDS = GAME === 'snooker' ? Array.from({ length: 21 }, (_, i) => i + 1)
  : GAME === '9ball' ? [1, 2, 3, 4, 5, 6, 7, 8, 9]
    : Array.from({ length: 15 }, (_, i) => i + 1);

// Fixed layouts, generated once from a fixed seed, so every arm of the A/B sees
// exactly the same tables.
function layouts(count, seed) {
  const rnd = mulberry32(seed);
  const between = (lo, hi) => lo + rnd() * (hi - lo);
  const out = [];
  while (out.length < count) {
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
    const n = 3 + ((rnd() * 8) | 0);
    for (let i = 0; i < n && pool.length; i++) place(pool.splice((rnd() * pool.length) | 0, 1)[0]);
    if (balls.length >= 4) out.push(balls);
  }
  return out;
}

function playShot(layout, yaw, power) {
  const balls = layout.map(b => ({ id: b.id, x: b.x, z: b.z, vx: 0, vz: 0, potted: false }));
  const dir = { x: -Math.sin(yaw), z: -Math.cos(yaw) };
  balls[0].vx = dir.x * power * CFG.MAX_V;
  balls[0].vz = dir.z * power * CFG.MAX_V;
  const ev = PHYS.newEvents();
  const pots = [];
  let steps = 0;
  do {
    const es = PHYS.step(T, balls, CFG.PHYS_H, ev);
    if (es) for (const e of es) if (e.type === 'pot') pots.push(e);
    steps++;
  } while (PHYS.anyMoving(balls) && steps < 40000);
  return { balls, pots, ev, steps };
}

function run(label, fit) {
  const saved = Object.assign({}, BOT.POWER_FIT);
  if (fit) Object.assign(BOT.POWER_FIT, fit);

  let potted = 0, scratched = 0, railEnd = 0, played = 0, longRoll = 0;
  let nextCostSum = 0, nextCostN = 0, powerSum = 0;

  for (const layout of LAYOUTS) {
    const cue = layout[0], objs = layout.slice(1);
    const ctx = Object.assign({}, ctxBase, {
      balls: objs.map(b => ({ id: b.id, x: b.x, z: b.z })),
      cue: { x: cue.x, z: cue.z },
      group: null, onEight: false, lowestId: null, phase: 'aim', breakShot: false,
    });
    const d = BOT.chooseShot(ctx);
    if (!d || d.safe || d.pocket == null) continue;
    played++;
    powerSum += d.power;

    const r = playShot(layout, d.yaw, d.power);
    const dropped = r.pots.some(p => p.id === d.target && p.pocket === d.pocket);
    if (dropped) potted++;
    if (r.ev.scratch) scratched++;
    // js/position.js caps a roll-out at 6000 substeps; anything past that is a
    // shot the bot's own planner could not have seen to the end.
    if (r.steps > 6000) longRoll++;

    const q = r.balls[0];
    if (!q.potted) {
      if (Math.abs(q.x) > CFG.LIMX - 2 * CFG.R || Math.abs(q.z) > CFG.LIMZ - 2 * CFG.R) railEnd++;
      // What the bot itself thinks it has from here — its own easiestPot.
      const rest = r.balls.filter(b => !b.potted && b.id !== 0).map(b => ({ id: b.id, x: b.x, z: b.z }));
      if (rest.length) {
        const c2 = Object.assign({}, ctxBase, { balls: rest, cue: { x: q.x, z: q.z } });
        const cands = BOT.potCandidates(c2, q, rest, rest);
        let best = 6.0;
        for (const c of cands) if (c.hardness < best) best = c.hardness;
        nextCostSum += best; nextCostN++;
      }
    }
  }

  Object.assign(BOT.POWER_FIT, saved);
  const pct = v => `${(100 * v / played).toFixed(1)}%`;
  return {
    label, played,
    pot: pct(potted), scratch: pct(scratched), rail: pct(railEnd),
    next: (nextCostSum / Math.max(1, nextCostN)).toFixed(3),
    power: (powerSum / Math.max(1, played)).toFixed(3),
    long: pct(longRoll),
  };
}

const LAYOUTS = layouts(N, +arg('seed', 7) | 0);
console.log(`${LAYOUTS.length} fixed layouts, friction ${CFG.FRIC_C}/${CFG.FRIC_L}, ` +
  `model ${M.ready() ? 'on' : 'off'}\n`);

const arms = [['shipped POWER_FIT', null]];
const custom = arg('fit', null);
if (custom) {
  const [base, cue, cut] = custom.split(',').map(Number);
  arms.push([`fit ${base}/${cue}/${cut}`, { base, cue, cut }]);
}
// The pre-change formula, as the reference point for what the bot used to do.
arms.push(['legacy 0.30/0.16/0.26', { base: 0.30, cue: 0.16, cut: 0.26 }]);

const rows = arms.map(([l, f]) => run(l, f));
const w = Math.max(...rows.map(r => r.label.length));
console.log(`${'setting'.padEnd(w)} | shots | potted | scratch |  rail | next cost | avg power | >cap`);
for (const r of rows) {
  console.log(`${r.label.padEnd(w)} | ${String(r.played).padStart(5)} | ` +
    `${r.pot.padStart(6)} | ${r.scratch.padStart(7)} | ${r.rail.padStart(5)} | ` +
    `${r.next.padStart(9)} | ${r.power.padStart(9)} | ${r.long.padStart(5)}`);
}
console.log('\nnext cost = the bot\'s own easiestPot() from where the cue finished; lower is better.');

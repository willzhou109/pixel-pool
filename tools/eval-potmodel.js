/* Held-out evaluation of the shot-outcome model on REAL game positions.
 *
 * The model is trained on random scatters, because those cover the table far
 * better than real play does — the bot only ever reaches the positions its
 * current judgement takes it to. That leaves an obvious question: does it still
 * work on the layouts that actually come up? This answers it, using the
 * browser-recorded layouts in data/shots-*.json, which the model never saw.
 *
 * For every candidate pot in those layouts it measures the true make window by
 * simulation and compares two ways of ranking shots:
 *   geoHardness  the hand-tuned line js/bot.js has always used
 *   model        js/potmodel.json, mapped onto the same scale
 *
 * The decision-relevant number is TOP-1: how often the shot a method ranks
 * best really is the widest window on the table. That is the choice the bot
 * makes on every visit.
 *
 * Usage:  node tools/eval-potmodel.js [--game=8ball] [--layouts=60]
 */
'use strict';

const fs = require('fs');
const path = require('path');

global.window = global;
require('../js/banks.js');
require('../js/position.js');
const M = require('../js/potmodel.js');
require('../js/bot.js');                       // reads window.PoolPotModel
const PHYS = require('../js/physics.js');
const BOT = global.PoolBot;

const arg = (k, d) => {
  const hit = process.argv.find(a => a.startsWith(`--${k}=`));
  return hit ? hit.slice(k.length + 3) : d;
};
const GAME = arg('game', '8ball');
const MAX_LAYOUTS = +arg('layouts', 60);
const root = path.join(__dirname, '..');

const CFG = JSON.parse(fs.readFileSync(path.join(root, 'data', `physics-${GAME}.json`), 'utf8'));
M.use(JSON.parse(fs.readFileSync(path.join(root, 'js', 'potmodel.json'), 'utf8')));

const T = {
  R: CFG.R, PW: CFG.PW, PH: CFG.PH, LIMX: CFG.LIMX, LIMZ: CFG.LIMZ,
  CORNER_GAP: CFG.CORNER_GAP, SIDE_GAP: CFG.SIDE_GAP, POCKETS: CFG.POCKETS,
  REST_BALL: CFG.REST_BALL, REST_CUSH: CFG.REST_CUSH, CUSH_GRIP: CFG.CUSH_GRIP,
  FRIC_C: CFG.FRIC_C, FRIC_L: CFG.FRIC_L, STOP_V: CFG.STOP_V,
};
const ctxBase = Object.assign({}, T, {
  REST: CFG.REST_CUSH, GRIP: CFG.CUSH_GRIP, MAX_V: CFG.MAX_V, PHYS_H: CFG.PHYS_H,
});

function simulate(layout, dir, speed) {
  const balls = layout.map(b => ({ id: b.id, x: b.x, z: b.z, vx: 0, vz: 0, potted: false }));
  balls[0].vx = dir.x * speed; balls[0].vz = dir.z * speed;
  const ev = PHYS.newEvents();
  const pots = [];
  let steps = 0;
  do {
    const es = PHYS.step(T, balls, CFG.PHYS_H, ev);
    if (es) for (const e of es) if (e.type === 'pot') pots.push(e);
    steps++;
  } while (PHYS.anyMoving(balls) && steps < 20000);
  return pots;
}

const dirOf = yaw => ({ x: -Math.sin(yaw), z: -Math.cos(yaw) });
const FAN = 0.10, STEP = 0.002, BISECT = 10;

// Same measurement the training labels used, so the comparison is like for like.
function trueWindow(layout, cand, speed) {
  const nominal = Math.atan2(-cand.dir.x, -cand.dir.z);
  const makes = off => simulate(layout, dirOf(nominal + off), speed)
    .some(p => p.id === cand.target && p.pocket === cand.pocket);
  let seed = null;
  if (makes(0)) seed = 0;
  else for (let off = STEP; off <= FAN && seed === null; off += STEP) {
    if (makes(off)) seed = off; else if (makes(-off)) seed = -off;
  }
  if (seed === null) return 0;
  const edge = d => {
    let inside = seed, outside = seed + d * STEP, guard = 0;
    while (makes(outside) && guard++ < 120) { inside = outside; outside += d * STEP; }
    for (let i = 0; i < BISECT; i++) {
      const mid = (inside + outside) / 2;
      if (makes(mid)) inside = mid; else outside = mid;
    }
    return inside;
  };
  return (edge(1) - edge(-1)) / 2;
}

function spearman(a, b) {
  const rank = v => {
    const idx = v.map((x, i) => i).sort((i, j) => v[i] - v[j]);
    const r = new Array(v.length);
    idx.forEach((id, k) => { r[id] = k; });
    return r;
  };
  const ra = rank(a), rb = rank(b), n = a.length;
  const ma = (n - 1) / 2;
  let sa = 0, sb = 0, sab = 0;
  for (let i = 0; i < n; i++) {
    const da = ra[i] - ma, db = rb[i] - ma;
    sa += da * da; sb += db * db; sab += da * db;
  }
  return sab / Math.sqrt(sa * sb);
}

/* ---------------------------------------------------------------- run ---- */

const file = path.join(root, 'data', `shots-${GAME}.json`);
if (!fs.existsSync(file)) {
  console.error(`no ${path.relative(process.cwd(), file)} — run tools/record-shots.js first`);
  process.exit(2);
}
const { shots } = JSON.parse(fs.readFileSync(file, 'utf8'));
// Both ends of every recorded stroke are real positions the game reached, so
// take each as its own held-out layout.
const positions = [];
for (const s of shots) {
  positions.push(s.start);
  if (s.end) positions.push(s.end);
}

const trueW = [], modelH = [], geoH = [];
let top1model = 0, top1geo = 0, top1rand = 0, layouts = 0, cands = 0;

for (const snap of positions.slice(0, MAX_LAYOUTS)) {
  const live = snap.filter(b => !b.potted).map(b => ({ id: b.id, x: b.x, z: b.z }));
  const cue = live.find(b => b.id === 0);
  const objs = live.filter(b => b.id !== 0);
  if (!cue || objs.length < 2) continue;

  const ctx = Object.assign({}, ctxBase, { balls: objs, cue: { x: cue.x, z: cue.z } });
  const list = BOT.potCandidates(ctx, cue, objs, objs);
  if (list.length < 2) continue;
  layouts++;

  const rows = list.map(c => ({
    c, w: trueWindow(live, c, BOT.powerFor(c) * CFG.MAX_V),
  }));
  for (const r of rows) {
    trueW.push(r.w); modelH.push(r.c.hardness); geoH.push(r.c.geoHardness); cands++;
  }
  // Which candidate does each method put first, and is it really the easiest?
  const best = rows.reduce((a, b) => (b.w > a.w ? b : a));
  const pick = key => rows.reduce((a, b) => (b.c[key] < a.c[key] ? b : a));
  if (pick('hardness').w === best.w) top1model++;
  if (pick('geoHardness').w === best.w) top1geo++;
  if (rows[(Math.random() * rows.length) | 0].w === best.w) top1rand++;
  process.stdout.write(`\r  ${layouts} layouts, ${cands} candidates`);
}
process.stdout.write('\n');

// Rank correlations are computed over makeable candidates: an unmakeable shot
// has no window to be right or wrong about the size of.
const on = trueW.map((w, i) => (w > 0 ? i : -1)).filter(i => i >= 0);
const lw = on.map(i => Math.log(trueW[i]));
const sm = spearman(on.map(i => -modelH[i]), lw);
const sg = spearman(on.map(i => -geoH[i]), lw);

console.log(`\nheld-out: ${layouts} real layouts, ${cands} candidates ` +
  `(${on.length} makeable)\n`);
console.log('ranking shot difficulty (Spearman vs log true window):');
console.log(`  model        ${sm.toFixed(3)}`);
console.log(`  geoHardness  ${sg.toFixed(3)}`);
console.log('\npicks the widest window on the table (top-1):');
const pct = n => `${(100 * n / layouts).toFixed(1)}%`;
console.log(`  model        ${pct(top1model)}  (${top1model}/${layouts})`);
console.log(`  geoHardness  ${pct(top1geo)}  (${top1geo}/${layouts})`);
console.log(`  random       ${pct(top1rand)}  (${top1rand}/${layouts})`);

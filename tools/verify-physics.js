/* Replay browser-recorded shots through js/physics.js in Node and prove the two
 * agree. This is the gate on the whole extraction: if Node and the browser
 * diverge, every self-play position and every training label produced headlessly
 * is describing a game nobody is playing.
 *
 * A shot is a pure function of (start state, table, substep) — game.js drives
 * the core with a fixed PHYS_H and simply runs it until nothing is moving — so
 * the replay here is just that loop with no rendering attached.
 *
 * The bar is EXACT. Both engines are V8 doing IEEE-754 arithmetic in the same
 * order over the same doubles, so positions should match to the bit; the
 * tolerance below exists to report how far off a failure is, not to excuse one.
 * (js/physics.js uses Math.sqrt rather than Math.hypot for exactly this reason:
 * sqrt is required to be correctly rounded, hypot is not.)
 *
 * Usage:  node tools/verify-physics.js [data/shots-8ball.json ...]
 */
'use strict';

const fs = require('fs');
const path = require('path');
const P = require('../js/physics.js');

const TOL = 1e-12;                 // report threshold; real agreement is exact
const MAX_STEPS = 200000;

function replay(shot) {
  const balls = shot.start.map(b => ({ ...b }));
  const ev = {
    potted: shot.ev.potted.slice(), scratch: shot.ev.scratch,
    firstHit: shot.ev.firstHit, cushion: shot.ev.cushion,
  };
  let steps = 0;
  do {
    P.step(shot.table, balls, shot.h, ev);
    steps++;
  } while (P.anyMoving(balls) && steps < MAX_STEPS);
  return { balls, ev, steps };
}

function compare(shot, got) {
  const problems = [];
  if (got.steps !== shot.steps) {
    problems.push(`substeps ${got.steps} vs browser ${shot.steps}`);
  }
  let worst = 0, worstId = -1;
  for (let i = 0; i < shot.end.length; i++) {
    const want = shot.end[i], have = got.balls[i];
    if (want.id !== have.id) { problems.push(`ball order diverged at ${i}`); break; }
    if (!!want.potted !== !!have.potted) {
      problems.push(`ball ${want.id} potted=${have.potted}, browser said ${want.potted}`);
      continue;
    }
    if (want.potted) continue;                     // a pocketed ball's resting spot is moot
    const d = Math.max(Math.abs(want.x - have.x), Math.abs(want.z - have.z));
    if (d > worst) { worst = d; worstId = want.id; }
  }
  if (worst > TOL) problems.push(`ball ${worstId} off by ${worst.toExponential(3)}`);

  const a = shot.endEv, b = got.ev;
  if (a.potted.join() !== b.potted.join()) problems.push(`potted [${b.potted}] vs [${a.potted}]`);
  if (a.scratch !== b.scratch) problems.push(`scratch ${b.scratch} vs ${a.scratch}`);
  if (a.firstHit !== b.firstHit) problems.push(`firstHit ${b.firstHit} vs ${a.firstHit}`);
  if (a.cushion !== b.cushion) problems.push(`cushion ${b.cushion} vs ${a.cushion}`);
  return { problems, worst };
}

const files = process.argv.slice(2).filter(a => !a.startsWith('--'));
if (!files.length) {
  const dir = path.join(__dirname, '..', 'data');
  if (fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir)) if (/^shots-.*\.json$/.test(f)) files.push(path.join(dir, f));
  }
}
if (!files.length) {
  console.error('no shot recordings found — run tools/record-shots.js first');
  process.exit(2);
}

let total = 0, failed = 0, worstOverall = 0, exact = 0;
const t0 = Date.now();
let substeps = 0;

for (const file of files) {
  const { game, shots } = JSON.parse(fs.readFileSync(file, 'utf8'));
  console.log(`\n${path.basename(file)} — ${shots.length} shots (${game})`);
  let bad = 0;
  for (let i = 0; i < shots.length; i++) {
    const shot = shots[i];
    const got = replay(shot);
    substeps += got.steps;
    const { problems, worst } = compare(shot, got);
    if (worst > worstOverall) worstOverall = worst;
    if (worst === 0 && !problems.length) exact++;
    total++;
    if (problems.length) {
      bad++; failed++;
      if (bad <= 5) console.log(`  shot ${i}: ` + problems.join('; '));
    }
  }
  console.log(`  ${shots.length - bad}/${shots.length} reproduced`);
}

const ms = Date.now() - t0;
console.log(`\n${total - failed}/${total} shots reproduced (${exact} bit-for-bit identical)`);
console.log(`largest position difference: ${worstOverall === 0 ? '0 (exact)' : worstOverall.toExponential(3)}`);
console.log(`replayed ${substeps} substeps in ${ms}ms — ${(substeps / (ms / 1000) / 1e6).toFixed(2)}M substeps/sec`);
console.log(failed ? '\nFAIL — the extracted core does not match the browser' : '\nPASS');
process.exit(failed ? 1 : 0);

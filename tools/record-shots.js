/* Record real shots from the browser, for tools/verify-physics.js to replay.
 *
 * The extracted core (js/physics.js) is only worth anything if Node reproduces
 * the browser exactly — otherwise every training label generated from it is
 * quietly wrong. This captures the ground truth to check that against.
 *
 * It works by wrapping window.PoolPhysics.step in the page, so it records the
 * REAL simulation as the real game drives it — no reimplementation of the frame
 * loop, nothing to keep in sync. For each shot it stores:
 *   table  the descriptor the core was called with (the bed can change per game)
 *   h      the substep, and the number of substeps the browser took to settle
 *   start  every ball the instant before the first substep of the roll
 *   end    every ball once the table has settled, BEFORE the rules layer gets a
 *          chance to re-spot anything
 *   ev     the stroke accumulator at both ends (pots, scratch, first contact)
 *
 * Usage:  node tools/record-shots.js [--game=8ball] [--shots=40] [--out=FILE]
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { connect, send, evalJS, sleep, watchErrors } = require('./cdp.js');

const arg = (k, d) => {
  const hit = process.argv.find(a => a.startsWith(`--${k}=`));
  return hit ? hit.slice(k.length + 3) : d;
};
const GAME = arg('game', '8ball');
const WANT = +arg('shots', 40);
const PORT = +arg('port', 8099);
const OUT = arg('out', path.join(__dirname, '..', 'data', `shots-${GAME}.json`));

/* Injected into the page: wrap the physics core and capture whole shots. */
const RECORDER = `
window.__rec = { shots: [], armed: false, cur: null };
(function () {
  const P = window.PoolPhysics, orig = P.step;
  if (P.__wrapped) return;
  P.__wrapped = true;
  const snap = bs => bs.map(b => ({
    id: b.id, x: b.x, z: b.z, vx: b.vx, vz: b.vz, potted: !!b.potted,
  }));
  const evSnap = ev => ({
    potted: ev.potted.slice(), scratch: ev.scratch,
    firstHit: ev.firstHit, cushion: ev.cushion,
  });
  P.step = function (t, balls, h, ev) {
    const r = window.__rec;
    // The roll starts at the first substep where the cue ball actually carries
    // velocity: game.js can run a few no-op substeps between S.ROLLING and the
    // strike animation delivering the impulse, and those must not be the start.
    if (r.armed && (balls[0].vx !== 0 || balls[0].vz !== 0)) {
      r.armed = false;
      r.cur = {
        h, steps: 0,
        table: Object.assign({}, t, { POCKETS: t.POCKETS.map(p => ({ x: p.x, z: p.z, r: p.r })) }),
        start: snap(balls),
        ev: evSnap(ev),
      };
    }
    const out = orig.call(this, t, balls, h, ev);
    if (r.cur) {
      r.cur.steps++;
      // Something re-launched the cue ball mid-roll and reset the accumulator
      // with it (launchCue does that). Whatever this roll is, it isn't one
      // stroke, so it can't be used as ground truth.
      if (r.cur.sawHit && ev.firstHit === null) r.cur.dirty = true;
      if (ev.firstHit !== null) r.cur.sawHit = true;
      if (!P.anyMoving(balls)) {
        r.cur.end = snap(balls);
        r.cur.endEv = evSnap(ev);
        if (!r.cur.dirty) r.shots.push(r.cur);
        r.cur = null;
      }
    }
    return out;
  };
})();
return 1;
`;

/* Aim solver, so the recorder plays real pots rather than flailing — the shots
   worth checking are the ones with contact, cushions and pots in them. */
const AIM = `
window.__aim = (function () {
  const H = window.PoolAimHooks;
  function blocked(a, b, skip) {
    const R = H.R, dx = b.x - a.x, dz = b.z - a.z, len = Math.hypot(dx, dz);
    if (len < 1e-9) return false;
    const ux = dx / len, uz = dz / len;
    for (const o of H.balls) {
      if (o.potted || skip.indexOf(o.id) >= 0) continue;
      const t = (o.x - a.x) * ux + (o.z - a.z) * uz;
      if (t <= 0 || t >= len) continue;
      const px = a.x + ux * t, pz = a.z + uz * t;
      if (Math.hypot(o.x - px, o.z - pz) < 2 * R * 1.02) return true;
    }
    return false;
  }
  return { best(ids) {
    const R = H.R, cue = H.balls[0];
    let out = null;
    for (const id of ids) {
      const b = H.balls[id];
      if (!b || b.potted) continue;
      for (const p of H.POCKETS) {
        const ux = p.x - b.x, uz = p.z - b.z, ul = Math.hypot(ux, uz);
        if (ul < 1e-6) continue;
        const gx = b.x - 2 * R * ux / ul, gz = b.z - 2 * R * uz / ul;
        const dx = gx - cue.x, dz = gz - cue.z, dl = Math.hypot(dx, dz);
        if (dl < 1e-6) continue;
        const cos = (dx / dl) * (ux / ul) + (dz / dl) * (uz / ul);
        if (cos < 0.35) continue;
        if (blocked(cue, { x: gx, z: gz }, [0, id])) continue;
        if (blocked(b, p, [id, 0])) continue;
        const score = dl + ul * 1.2 + (1 - cos) * 4;
        if (!out || score < out.score) out = { id, gx, gz, dist: dl + ul, score };
      }
    }
    return out;
  } };
})();
return 1;
`;

const dump = () => evalJS('return window.__poolTest.dump()');

// Wait for the table to stop. Returns null rather than throwing if it never
// does — the caller starts a fresh frame instead of losing the whole run.
async function settle() {
  for (let i = 0; i < 600; i++) {
    const d = await dump();
    if (d.state !== 3 && d.state !== 2 && !d.moving) return d;
    await sleep(40);
  }
  return null;
}

(async () => {
  const errors = [];
  await connect(9222);
  await send('Runtime.enable');
  await send('Log.enable');
  watchErrors(errors);

  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/?autostart&dbg&nocpu&game=${GAME}` });
  await sleep(3400);
  await evalJS(RECORDER);
  await evalJS(AIM);

  const geo = await evalJS(`const H = window.PoolAimHooks;
    return { R: H.R, PW: window.PoolScene.PW, PH: window.PoolScene.PH };`);

  // Shots accumulate HERE, not in the page: a frame ends by reloading, which
  // takes window.__rec with it. Drain before every reload.
  const all = [];
  const drain = async () => {
    const got = await evalJS('const s = window.__rec.shots; window.__rec.shots = []; return s;');
    all.push(...got);
    process.stdout.write(`\r  recorded ${all.length}/${WANT} shots`);
  };
  const freshFrame = async () => {
    await drain();
    await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/?autostart&dbg&nocpu&game=${GAME}` });
    await sleep(3400);
    await evalJS(RECORDER);                     // a reload drops both injections
    await evalJS(AIM);
  };

  let guard = 0;
  while (all.length < WANT && guard++ < WANT * 8) {
    let d = await settle();
    if (!d) { await freshFrame(); continue; }   // wedged: cut the frame loose

    // Frame over, or 8-ball's pocket call (no scripted hook): start another.
    if (d.state === 5 || d.state === 6) { await freshFrame(); continue; }
    if (d.state === 4) {                        // ball in hand
      const inD = d.game === 'snooker';
      const L = inD ? await evalJS(`return window.PoolSnooker.layout(
        {PW:window.PoolScene.PW,PH:window.PoolScene.PH,R:window.PoolAimHooks.R})`) : null;
      const x = inD ? L.baulkX - L.dR * 0.4 : -geo.PW * 0.5 + Math.random() * 0.4;
      const z = inD ? L.dR * (Math.random() - 0.5) : (Math.random() - 0.5) * geo.PH;
      await evalJS(`return window.__poolTest.place(${x}, ${z})`);
      d = await dump();
    }
    if (d.state === 7) {                        // snooker: nominate a colour
      const live = [16, 17, 18, 19, 20, 21].filter(id => d.pos.some(p => p[0] === id));
      const s = await evalJS(`return window.__aim.best(${JSON.stringify(live)})`);
      await evalJS(`return window.__poolTest.nominate(${s ? s.id : live[live.length - 1]})`);
      d = await dump();
    }
    if (d.state !== 1) { await sleep(120); continue; }

    let targets;
    if (d.game === 'snooker') targets = d.snooker.onIds.filter(id => d.pos.some(p => p[0] === id));
    else if (d.game === '9ball') targets = d.target ? [d.target] : [];
    else targets = d.pos.filter(p => p[0] > 0).map(p => p[0]);
    if (!targets.length) { await freshFrame(); continue; }

    const shot = await evalJS(`return window.__aim.best(${JSON.stringify(targets)})`);
    await evalJS('window.__rec.armed = true; return 1');
    if (shot) {
      await evalJS(`window.__poolTest.aimAt(${shot.gx}, ${shot.gz});
        window.__poolTest.shoot(${Math.min(0.95, 0.3 + shot.dist * 0.3)}); return 1`);
    } else {
      const tp = d.pos.find(p => p[0] === targets[0]);
      await evalJS(`window.__poolTest.aimAt(${tp[1]}, ${tp[2]});
        window.__poolTest.shoot(${0.35 + Math.random() * 0.4}); return 1`);
    }
    await sleep(200);
    if (!(await settle())) { await freshFrame(); continue; }
    await drain();
  }

  await drain();
  const shots = all.slice(0, WANT);
  process.stdout.write('\n');
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({ game: GAME, geo, shots }, null, 0));
  console.log(`wrote ${shots.length} shots to ${OUT}`);
  const withPots = shots.filter(s => s.endEv.potted.length).length;
  const steps = shots.reduce((a, s) => a + s.steps, 0);
  console.log(`  ${withPots} shots pot something; ${steps} substeps total`);
  if (errors.length) { console.log('page errors:'); errors.slice(0, 5).forEach(e => console.log('  ' + e)); }
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });

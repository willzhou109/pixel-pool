/* Ball physics for Pixel Pool — the pure simulation core.
 *
 * This is game.js's physicsStep with every side effect lifted out: no scene, no
 * meshes, no audio, no DOM, no network. It owns exactly one thing — advancing a
 * set of balls by one substep — and reports what happened so the caller can
 * decide what that means (a sound, a sinking animation, a pot notification).
 *
 * WHY IT'S SEPARATE. Two callers need the same arithmetic:
 *   • game.js, which renders and plays sounds off the back of it, and
 *   • a headless driver in Node (tools/), which plays thousands of frames with
 *     no browser at all — self-play data for training, and a test suite that
 *     runs in seconds instead of at 1x real time.
 * A copy of the physics in each would drift, and every training label generated
 * against a drifted copy would be quietly wrong. So there is one implementation
 * and both load it. Same reason js/position.js takes its constants in a table
 * descriptor rather than copying them: one source of truth.
 *
 * DETERMINISM. Two engines must agree bit for bit, or a shot recorded in the
 * browser won't replay in Node. IEEE-754 arithmetic is exact and the operation
 * ORDER here is load-bearing (integrate, then rails and pockets in array order,
 * then collisions by ascending index pair, then the crawl cutoff) — do not
 * reorder any of it. Note Math.sqrt is used rather than Math.hypot: sqrt is
 * required to be correctly rounded, while hypot is only "implementation
 * approximated" and may differ in the last bit between engine versions.
 *
 * step(t, balls, h, ev) -> events | null
 *   t:      table descriptor, all of game.js's CONFIG that physics reads —
 *           { R, PW, PH, LIMX, LIMZ, CORNER_GAP, SIDE_GAP, POCKETS,
 *             REST_BALL, REST_CUSH, CUSH_GRIP, FRIC_C, FRIC_L, STOP_V }
 *   balls:  [{ id, x, z, vx, vz, potted }] — mutated in place. Extra fields are
 *           ignored, so game.js passes its own ball objects (meshes and all)
 *           straight in without copying.
 *   h:      substep seconds (game.js's PHYS_H)
 *   ev:     the stroke accumulator, { potted:[], scratch, firstHit, cushion }.
 *           Rules modules read this; see resolveShot* in game.js. Deliberately
 *           NOT including 8-ball's `eightPocket` — which pocket the 8 found is a
 *           rules question, and the caller can read it off the pot event.
 *   returns null when nothing audible/visible happened (the common case, so the
 *           hot path allocates nothing), else an array of:
 *             { type: 'pot',     id, pocket }
 *             { type: 'cushion', id, speed }
 *             { type: 'clack',   id, other, speed }
 */
(function (root, factory) {
  const api = factory();
  root.PoolPhysics = api;                                    // browser
  if (typeof module === 'object' && module.exports) module.exports = api; // Node
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const hyp = (x, z) => Math.sqrt(x * x + z * z);

  // Is any ball still rolling? The shot is over when this goes false.
  function anyMoving(balls) {
    for (const b of balls) if (!b.potted && (b.vx !== 0 || b.vz !== 0)) return true;
    return false;
  }

  // Take a ball off the table. Pure bookkeeping — the sinking animation, the
  // sound and the pot popup are the caller's business, driven by the returned
  // event.
  function sink(b, ev) {
    b.potted = true;
    b.vx = 0; b.vz = 0;
    if (b.id === 0) ev.scratch = true;
    else ev.potted.push(b.id);
  }

  function step(t, balls, h, ev) {
    const { R, PW, PH, LIMX, LIMZ, CORNER_GAP, SIDE_GAP, POCKETS } = t;
    let events = null;
    const emit = e => { (events || (events = [])).push(e); };

    // integrate + friction
    for (const b of balls) {
      if (b.potted) continue;
      let sp = hyp(b.vx, b.vz);
      if (sp > 0) {
        const dec = (t.FRIC_C + t.FRIC_L * sp) * h;
        const ns = sp - dec;
        if (ns <= t.STOP_V * 0.5) { b.vx = 0; b.vz = 0; sp = 0; }
        else { const k = ns / sp; b.vx *= k; b.vz *= k; sp = ns; }
      }
      b.x += b.vx * h;
      b.z += b.vz * h;
    }

    // cushions + pockets
    for (const b of balls) {
      if (b.potted) continue;

      // pocket capture. Side pockets (index 4-5) sit behind the long rail, past
      // z = ±LIMZ — same threshold the cushion below bounces at — so their
      // capture circle (drawn wide for a forgiving mouth) doesn't bulge onto the
      // felt and snag a ball merely gliding along the rail. Corner pockets don't
      // need this gate: their mouth sits in the existing CORNER_GAP cushion
      // cut-back, which already keeps the felt clear right up to the corner.
      let captured = false;
      for (let pi = 0; pi < POCKETS.length; pi++) {
        const p = POCKETS[pi];
        if (pi >= 4 && Math.abs(b.z) < LIMZ) continue;
        const dx = b.x - p.x, dz = b.z - p.z;
        if (dx * dx + dz * dz < p.r * p.r) {
          sink(b, ev);
          emit({ type: 'pot', id: b.id, pocket: pi });
          captured = true;
          break;
        }
      }
      if (captured) continue;

      // long rails (z = ±PH): cushion present unless in a pocket mouth
      if (Math.abs(b.z) > LIMZ) {
        const inCorner = Math.abs(b.x) > PW - CORNER_GAP;
        const inSide = Math.abs(b.x) < SIDE_GAP;
        if (!inCorner && !inSide) {
          const s = Math.sign(b.z);
          if (b.vz * s > 0) {
            b.z = s * LIMZ;
            b.vz = -b.vz * t.REST_CUSH;
            b.vx *= (1 - t.CUSH_GRIP);
            emit({ type: 'cushion', id: b.id, speed: Math.abs(b.vz) });
            if (ev.firstHit !== null) ev.cushion = true;
          }
        }
      }
      // short rails (x = ±PW)
      if (Math.abs(b.x) > LIMX) {
        const inCorner = Math.abs(b.z) > PH - CORNER_GAP;
        if (!inCorner) {
          const s = Math.sign(b.x);
          if (b.vx * s > 0) {
            b.x = s * LIMX;
            b.vx = -b.vx * t.REST_CUSH;
            b.vz *= (1 - t.CUSH_GRIP);
            emit({ type: 'cushion', id: b.id, speed: Math.abs(b.vx) });
            if (ev.firstHit !== null) ev.cushion = true;
          }
        }
      }
      // escaped through a mouth but missed the cup — drop into nearest pocket
      if (Math.abs(b.x) > PW + 0.02 || Math.abs(b.z) > PH + 0.04) {
        let best = 0, bd = Infinity;
        for (let pi = 0; pi < POCKETS.length; pi++) {
          const d2 = (b.x - POCKETS[pi].x) ** 2 + (b.z - POCKETS[pi].z) ** 2;
          if (d2 < bd) { bd = d2; best = pi; }
        }
        b.x = POCKETS[best].x; b.z = POCKETS[best].z;
        sink(b, ev);
        emit({ type: 'pot', id: b.id, pocket: best });
      }
    }

    // ball-ball collisions
    const D = 2 * R;
    for (let i = 0; i < balls.length; i++) {
      const a = balls[i];
      if (a.potted) continue;
      for (let j = i + 1; j < balls.length; j++) {
        const b = balls[j];
        if (b.potted) continue;
        let nx = b.x - a.x, nz = b.z - a.z;
        const d2 = nx * nx + nz * nz;
        if (d2 >= D * D || d2 === 0) continue;
        const d = Math.sqrt(d2);
        nx /= d; nz /= d;
        // positional correction
        const pen = (D - d) / 2;
        a.x -= nx * pen; a.z -= nz * pen;
        b.x += nx * pen; b.z += nz * pen;
        // impulse (equal masses)
        const rvn = (b.vx - a.vx) * nx + (b.vz - a.vz) * nz;
        if (rvn < 0) {
          const jimp = -(1 + t.REST_BALL) * rvn / 2;
          a.vx -= jimp * nx; a.vz -= jimp * nz;
          b.vx += jimp * nx; b.vz += jimp * nz;
          emit({ type: 'clack', id: a.id, other: b.id, speed: Math.abs(rvn) });
          // record which object ball the cue ball strikes first this shot
          if (ev.firstHit === null && (a.id === 0 || b.id === 0)) {
            ev.firstHit = a.id === 0 ? b.id : a.id;
          }
        }
      }
    }

    // stop crawling balls
    for (const b of balls) {
      if (b.potted) continue;
      if (b.vx !== 0 || b.vz !== 0) {
        if (hyp(b.vx, b.vz) < t.STOP_V) { b.vx = 0; b.vz = 0; }
      }
    }

    return events;
  }

  // A fresh stroke accumulator. game.js adds its own 8-ball field to this.
  function newEvents() {
    return { potted: [], scratch: false, firstHit: null, cushion: false };
  }

  return { step, anyMoving, newEvents };
});

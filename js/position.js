/* Ball roll-out prediction for Pixel Pool — "where does the white end up?"
 *
 * js/bot.js can already tell which pots are ON. What it could never tell is what
 * the table looks like AFTERWARDS, so it played the easiest shot in front of it
 * and let the cue ball finish wherever it liked — the difference between a
 * player who runs out and one who pots a ball and then has nothing.
 *
 * This module answers the missing question by replaying game.js's own
 * physicsStep for a SINGLE ball: same friction, same cushion gaps, same pocket
 * capture, same equal-mass impulse. Constants arrive in the table descriptor
 * rather than being copied here, so there is one source of truth (game.js's
 * CONFIG block) and this can't silently drift out of sync with the real physics.
 *
 * The one deliberate simplification: only the rolled ball is simulated. A ball
 * it runs into is treated as a full stop (flagged `cluttered`) rather than
 * kicking off an n-body cascade — after a collision in traffic the outcome is
 * not predictable enough to plan around anyway, which is exactly what the flag
 * tells the caller.
 *
 * roll(t, start, dir, speed, balls, passId) -> { x, z, pocket, transfer, cluttered }
 *   t:        { R, PW, PH, LIMX, LIMZ, CORNER_GAP, SIDE_GAP, POCKETS,
 *               REST, GRIP, REST_BALL, FRIC_C, FRIC_L, STOP_V, PHYS_H }
 *   balls:    other balls on the table, [{id,x,z}] — the rolled one is not in it
 *   passId:   id of a ball to STRIKE and roll on past (the cue's intended
 *             target); any other contact ends the roll. -1 for none.
 *   pocket:   index the ball dropped into, or -1 if it came to rest on the felt
 *   transfer: { speed, dir } handed to passId at contact — feed it straight back
 *             into roll() to find out whether the object ball actually drops
 *   cluttered:true if the roll ended by running into an unintended ball
 */
(function () {
  'use strict';

  const MAX_STEPS = 6000;   // ~12.5s at PHYS_H: far longer than any real roll

  function roll(t, start, dir, speed, balls, passId) {
    const h = t.PHYS_H, D = 2 * t.R, DD = D * D;
    let x = start.x, z = start.z;
    let vx = dir.x * speed, vz = dir.z * speed;
    let transfer = null, passed = false;
    const done = (pocket, cluttered) => ({ x, z, pocket, transfer, cluttered: !!cluttered });

    for (let s = 0; s < MAX_STEPS; s++) {
      // friction + integrate (physicsStep's first loop)
      const sp = Math.hypot(vx, vz);
      if (sp === 0) break;
      const ns = sp - (t.FRIC_C + t.FRIC_L * sp) * h;
      if (ns <= t.STOP_V * 0.5) break;
      const k = ns / sp; vx *= k; vz *= k;
      x += vx * h; z += vz * h;

      // pocket capture — side pockets only past the long rail, as in physicsStep
      for (let pi = 0; pi < t.POCKETS.length; pi++) {
        const p = t.POCKETS[pi];
        if (pi >= 4 && Math.abs(z) < t.LIMZ) continue;
        const dx = x - p.x, dz = z - p.z;
        if (dx * dx + dz * dz < p.r * p.r) return done(pi);
      }

      // long rails (z = ±PH): cushion unless in a pocket mouth
      if (Math.abs(z) > t.LIMZ) {
        const inCorner = Math.abs(x) > t.PW - t.CORNER_GAP;
        const inSide = Math.abs(x) < t.SIDE_GAP;
        if (!inCorner && !inSide) {
          const sg = Math.sign(z);
          if (vz * sg > 0) { z = sg * t.LIMZ; vz = -vz * t.REST; vx *= (1 - t.GRIP); }
        }
      }
      // short rails (x = ±PW)
      if (Math.abs(x) > t.LIMX) {
        const inCorner = Math.abs(z) > t.PH - t.CORNER_GAP;
        if (!inCorner) {
          const sg = Math.sign(x);
          if (vx * sg > 0) { x = sg * t.LIMX; vx = -vx * t.REST; vz *= (1 - t.GRIP); }
        }
      }
      // through a mouth but past the cup: physicsStep drops it in the nearest one
      if (Math.abs(x) > t.PW + 0.02 || Math.abs(z) > t.PH + 0.04) {
        let best = 0, bd = Infinity;
        for (let pi = 0; pi < t.POCKETS.length; pi++) {
          const d2 = (x - t.POCKETS[pi].x) ** 2 + (z - t.POCKETS[pi].z) ** 2;
          if (d2 < bd) { bd = d2; best = pi; }
        }
        return done(best);
      }

      // ball contact
      for (let i = 0; i < balls.length; i++) {
        const o = balls[i];
        if (passed && o.id === passId) continue;   // already struck: rolling past it
        const mx = o.x - x, mz = o.z - z;
        const d2 = mx * mx + mz * mz;
        if (d2 >= DD || d2 === 0) continue;
        if (o.id !== passId) return done(-1, true); // ran into traffic
        const d = Math.sqrt(d2), nx = mx / d, nz = mz / d;
        x -= nx * (D - d) / 2; z -= nz * (D - d) / 2;   // positional correction
        // Equal-mass impulse, transcribed from physicsStep. The struck ball is at
        // rest, so the roller keeps its whole TANGENTIAL component and only
        // (1−REST_BALL)/2 of the normal one — real pool's 90° tangent line, and
        // the reason a dead-straight pot stuns the cue ball to a standstill.
        const vn = vx * nx + vz * nz;
        if (vn > 0) {
          const jimp = (1 + t.REST_BALL) * vn / 2;
          vx -= jimp * nx; vz -= jimp * nz;
          transfer = { speed: jimp, dir: { x: nx, z: nz } };
        }
        passed = true;
        break;
      }

      if (Math.hypot(vx, vz) < t.STOP_V) break;    // physicsStep's crawl cutoff
    }
    return done(-1);
  }

  window.PoolPos = { roll };
})();

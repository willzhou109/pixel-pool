/* One-rail bank & kick geometry for Pixel Pool.
 *
 * A "bank" sends the OBJECT ball off a cushion into a pocket; a "kick" sends the
 * CUE ball off a cushion into a legal target (the way out of a snooker, so the
 * computer makes a legal hit instead of fouling). Both reduce to one question:
 * given a start, a destination and a rail, where on that rail must the ball land?
 *
 * Cushions here are NOT mirrors. physicsStep damps the normal component by REST
 * (REST_CUSH, 0.72) and the tangential one by 1-GRIP (CUSH_GRIP, 0.14), so a
 * rebound leaves FLATTER than it arrived, by the constant
 *   k = (1 - GRIP) / REST  ≈ 1.19.
 * Every function here carries that k, so aim points match the real physics
 * rather than the textbook mirror (which would miss wide at shallow angles).
 * With k = 1 the aim-point formula collapses to the familiar mirror point.
 *
 * Pure geometry — no Three.js, no globals, no module state. Each call takes a
 * table descriptor, so js/bot.js (choosing a shot) and js/game.js (fine-tuning
 * the aim) share one implementation:
 *   t: { R, LIMX, LIMZ, PW, PH, CORNER_GAP, SIDE_GAP, POCKETS, REST, GRIP }
 */
(function () {
  'use strict';

  const norm = v => { const l = Math.hypot(v.x, v.z) || 1; return { x: v.x / l, z: v.z / l }; };

  // The four cushion planes, as ball-CENTRE limits (matching physicsStep).
  function rails(t) {
    return [
      { axis: 'z', at:  t.LIMZ },
      { axis: 'z', at: -t.LIMZ },
      { axis: 'x', at:  t.LIMX },
      { axis: 'x', at: -t.LIMX },
    ];
  }

  // Is (x,z) on real cushion rather than a pocket mouth? Mirrors the gaps
  // physicsStep uses to decide whether a rail bounces at all, inset by a ball
  // radius so the bot never banks off the very lip of a mouth.
  function onCushion(t, rail, x, z) {
    if (rail.axis === 'z') {
      const ax = Math.abs(x);
      return ax >= t.SIDE_GAP + t.R && ax <= t.PW - t.CORNER_GAP - t.R;
    }
    return Math.abs(z) <= t.PH - t.CORNER_GAP - t.R;
  }

  /* Where on `rail` must a ball from `from` land to arrive at `to` after the
     bounce? Returns the point, or null when the geometry is impossible (the two
     ends straddle the rail, i.e. the destination is behind it). */
  function aimPoint(t, from, to, rail) {
    const k = (1 - t.GRIP) / t.REST;
    const along = rail.axis === 'z' ? 'x' : 'z';
    const a = rail.at - from[rail.axis];
    const b = rail.at - to[rail.axis];
    if (a * b <= 0) return null;            // opposite sides: no bounce path
    const da = Math.abs(a), db = Math.abs(b);
    if (da < 1e-6 || db < 1e-6) return null;
    // Normal-distance-weighted split of the run, skewed by k for the flatter
    // rebound. k = 1 would give the plain mirror point.
    const p = (da * to[along] + k * db * from[along]) / (da + k * db);
    return rail.axis === 'z' ? { x: p, z: rail.at } : { x: rail.at, z: p };
  }

  // Outgoing direction after bouncing off `rail` (normalized).
  function reflect(t, rail, d) {
    return norm(rail.axis === 'z'
      ? { x: d.x * (1 - t.GRIP), z: -d.z * t.REST }
      : { x: -d.x * t.REST, z: d.z * (1 - t.GRIP) });
  }

  // First cushion plane a ray from `from` along `d` reaches: {rail,x,z,dist}.
  function firstRail(t, from, d) {
    let best = null;
    for (const rail of rails(t)) {
      const dd = rail.axis === 'z' ? d.z : d.x;
      if (Math.abs(dd) < 1e-9) continue;
      const dist = (rail.at - from[rail.axis]) / dd;
      if (dist <= 1e-6) continue;
      if (!best || dist < best.dist) {
        best = { rail, x: from.x + d.x * dist, z: from.z + d.z * dist, dist };
      }
    }
    return best;
  }

  /* First ball a ray from `from` along `d` would contact within `maxDist`
     (centre-to-centre 2R), or null. Same test as game.js's castAim. */
  function firstBall(t, from, d, balls, maxDist, ignoreId) {
    const D = 2 * t.R, DD = D * D;
    let best = null, bestT = Infinity;
    for (const o of balls) {
      if (o.id === ignoreId) continue;
      const mx = o.x - from.x, mz = o.z - from.z;
      const proj = mx * d.x + mz * d.z;
      if (proj <= 0) continue;
      const perp2 = mx * mx + mz * mz - proj * proj;
      if (perp2 > DD) continue;
      const hitT = proj - Math.sqrt(Math.max(0, DD - perp2));
      if (hitT <= 1e-6 || hitT >= maxDist) continue;
      if (hitT < bestT) { bestT = hitT; best = o; }
    }
    return best;
  }

  /* A BANKED ball must enter a side pocket close to square. The slot test below
     is exact for a known heading, but a banked heading is only an ESTIMATE —
     reflect() models the cushion with two constants, and the real rebound
     scatters around that. A shallow approach turns a small heading error into a
     large miss at the mouth (the error at the rail plane scales as 1/cos of the
     entry angle), so the flatter the line, the less the prediction is worth.
     Restricting banks to a 90° window centred on the mouth's normal (±45°) keeps
     only the approaches where the estimate still means something. Measured
     against a replica of physicsStep, this lifts side-pocket bank predictions
     from 80.6% correct to 86.3% and proposes a third fewer of them.

     Direct shots don't get this limit: their heading is exact, and measurement
     shows the window would reject ~20% of side pots that genuinely drop while
     leaving precision flat (97.9% -> 97.2%). */
  const BANK_ENTRY_COS = Math.cos(Math.PI / 4);

  /* Can a ball at `from` heading `d` physically GET INTO pocket `pi`?
     Corner pockets open onto a wide cut-back in the cushion, so pointing at one
     is enough. The SIDE pockets don't: they sit behind the long rail and are
     reached only through the SIDE_GAP slot in it. Miss that slot and the jaw
     turns the ball away, however squarely the line happened to point at the cup.
     Distance-to-centre alone can't see this — a shallow line passes close to the
     cup yet crosses the rail far from the slot — which is what made side pockets
     read as makeable when they were not.

     The test mirrors physicsStep's own `inSide` condition (the ball's centre
     must be within SIDE_GAP of the middle as it crosses the rail plane), so it
     agrees with the physics by construction. Measured against a replica of that
     physics: this turns side-pocket predictions from 61% correct into 100%
     correct, while still admitting 98.6% of the genuinely makeable shots.

     `minEntryCos` optionally also demands the crossing be within that cosine of
     the mouth's normal — see BANK_ENTRY_COS, which pocketAfterBank passes. */
  function reachable(t, from, d, pi, minEntryCos) {
    if (pi < 4) return true;                       // corner: no slot to thread
    const side = Math.sign(t.POCKETS[pi].z);
    const n = norm(d);
    if (n.z * side <= 0) return false;             // not heading at that rail
    if (minEntryCos && n.z * side < minEntryCos) return false; // too flat to trust
    const cross = (side * t.LIMZ - from.z) / n.z;
    if (cross < 0) return false;                   // rail plane already behind us
    return Math.abs(from.x + n.x * cross) <= t.SIDE_GAP;
  }

  /* Which pocket a ball leaving `from` along `d` drops into after exactly one
     cushion, or -1. Acceptance matches the direct predictor in js/aimassist.js
     (within 0.82 pocket radii, path clear, and reachable() for side pockets),
     tightened by BANK_ENTRY_COS because the post-cushion heading is estimated. */
  function pocketAfterBank(t, from, d, balls, ignoreId) {
    const hit = firstRail(t, from, d);
    if (!hit) return -1;
    if (!onCushion(t, hit.rail, hit.x, hit.z)) return -1;   // heads into a mouth, not a bank
    if (balls && firstBall(t, from, d, balls, hit.dist, ignoreId)) return -1;

    const H = { x: hit.x, z: hit.z };
    const o = reflect(t, hit.rail, d);
    let best = -1, bestPerp = Infinity;
    for (let i = 0; i < t.POCKETS.length; i++) {
      const p = t.POCKETS[i];
      const mx = p.x - H.x, mz = p.z - H.z;
      const proj = mx * o.x + mz * o.z;
      if (proj <= 0) continue;
      const perp = Math.sqrt(Math.max(0, mx * mx + mz * mz - proj * proj));
      if (perp > p.r * 0.82) continue;
      // side pockets: through the slot, and square enough that the estimated
      // rebound heading is still worth something
      if (!reachable(t, H, o, i, BANK_ENTRY_COS)) continue;
      if (balls && firstBall(t, H, o, balls, proj, ignoreId)) continue;
      if (perp < bestPerp) { bestPerp = perp; best = i; }
    }
    return best;
  }

  /* First ball the CUE contacts after exactly one cushion, or null — the kick
     oracle. Anything struck before the rail means it was never a kick. */
  function ballAfterKick(t, from, d, balls) {
    const hit = firstRail(t, from, d);
    if (!hit) return null;
    if (!onCushion(t, hit.rail, hit.x, hit.z)) return null;
    if (firstBall(t, from, d, balls, hit.dist)) return null;
    const H = { x: hit.x, z: hit.z };
    return firstBall(t, H, reflect(t, hit.rail, d), balls, Infinity);
  }

  // rails/onCushion/aimPoint let a caller PLAN a one-rail shot; the two
  // *After* predicates VERIFY one (js/game.js tunes the aim against them).
  // reachable() is shared with the direct predictor in js/aimassist.js so both
  // hold side pockets to the same physical standard.
  window.PoolBanks = {
    rails, onCushion, aimPoint, firstBall, reachable, pocketAfterBank, ballAfterKick,
  };
})();

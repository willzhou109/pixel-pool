/* Computer opponent for Pixel Pool's offline "vs Computer" mode.
 *
 * Pure geometry + heuristics. game.js owns execution and the ghost-cue
 * animation; this module only *decides* a shot from a plain snapshot of the
 * table. The classic ghost-ball method aims the cue so the object ball is driven
 * along the target→pocket line: for a target T and pocket P, the cue-ball centre
 * at contact (the "ghost") sits 2R behind T along P→T, and the cue is aimed from
 * its current spot at that ghost. Every legal (target, pocket) pair is scored by
 * cut angle, distance and whether the two ball paths are clear; the easiest is
 * chosen. A small aim error — scaled by how hard the shot is — makes the bot
 * miss believably instead of playing perfectly.
 *
 * One-rail bank and kick shots (js/banks.js) extend that when the direct line
 * fails: a BANK drives the object off a cushion into a pocket, a KICK sends the
 * cue off a cushion to reach a legal ball that nothing can reach straight —
 * which is the difference between a legal hit and a foul on a crowded table.
 * Direct pots always win when one is available; banks/kicks are the fallback.
 *
 * chooseShot(ctx) -> { yaw, sigma, power, pocket?, place?, safe?, via?, target? }
 *   ctx: { R, PW, PH, LIMX, LIMZ, CORNER_GAP, SIDE_GAP, REST, GRIP, POCKETS,
 *          cue:{x,z}, balls:[{id,x,z}], group:'solid'|'stripe'|null,
 *          onEight:bool, phase:'aim'|'place', breakShot:bool }
 *   via:    'bank' | 'kick' when the shot goes via a cushion (game.js picks the
 *           matching aim-tuning oracle); absent for a direct shot.
 *   target: id of the ball the shot is meant to strike — on every shot type,
 *           so js/bottalk.js can narrate what the computer is attempting.
 *   yaw:    NOMINAL cue heading (no aim error) so game.js's aimDir() points the
 *           shot. game.js fine-tunes it to the aim-assist's green-pocket signal,
 *           then adds the skill wobble.
 *   sigma:  aim-error 1σ (radians) game.js applies as the bot's "skill" wobble.
 *   power:  0..1 stroke strength.
 *   pocket: the pocket this shot is aimed at (index into POCKETS) — game.js uses
 *           it to verify the green aim, and nominates it as the called pocket
 *           when the shot is on the 8-ball.
 *   place:  {x,z} cue-ball spot (only for ball-in-hand, phase 'place').
 *   safe:   true for a no-pot safety (game.js won't green-tune it).
 *   callPocket: on the 8-ball only, and only when the shot has no `pocket` of
 *           its own (a kick or safety) — the pocket the rules oblige it to
 *           nominate anyway. Never an aim point.
 */
(function () {
  'use strict';

  // Skill knobs. Aim noise (true 1σ, radians) is dominated by the cut angle —
  // thin cuts and long shots wobble more, near-straight ones are reliable — so
  // the bot makes easy pots and scatters on hard ones. A shot past MAX_HARDNESS
  // isn't worth attempting (play safe instead) — except on the 8, always try.
  // The bot's aiming precision is a roughly CONSTANT small angular error — the
  // difficulty of a shot is carried by how wide its make-window is (game.js
  // measures that by simulation), not by inflating the aim error. So these stay
  // small: a wide-window easy pot is made almost always, a thin one often missed.
  const AIM_BASE = 0.005;        // base aim noise (~0.3°)
  const AIM_CUT = 0.035;         // a little more on thin cuts (per 1 − cos(cut))
  const AIM_DIST = 0.004;        // a little more on long shots (per unit travel)
  const MAX_HARDNESS = 4.2;      // above this, prefer a safety over a low-odds pot
  // Banks are a fallback, only weighed once no direct pot qualifies: BANK_COST
  // keeps a marginal bank from looking as good as a real pot, and the ceiling is
  // a little higher because the alternative is usually a do-nothing safety.
  const BANK_COST = 0.8;
  const MAX_BANK_HARDNESS = 5.0;
  const MIN_BANK_CUT = 0.30;     // banks need a fuller hit than direct pots

  const sub = (a, b) => ({ x: a.x - b.x, z: a.z - b.z });
  const len = v => Math.hypot(v.x, v.z);
  const norm = v => { const l = len(v) || 1; return { x: v.x / l, z: v.z / l }; };
  const dot = (a, b) => a.x * b.x + a.z * b.z;

  // yaw that makes game.js's aimDir() = (-sin,−cos) equal `dir`.
  const yawFor = dir => Math.atan2(-dir.x, -dir.z);

  // Distance from point p to segment a→b.
  function distToSeg(p, a, b) {
    const abx = b.x - a.x, abz = b.z - a.z;
    const l2 = abx * abx + abz * abz || 1;
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * abx + (p.z - a.z) * abz) / l2));
    return Math.hypot(p.x - (a.x + abx * t), p.z - (a.z + abz * t));
  }

  // Is any ball (other than ids in `ignore`) within `clear` of segment a→b?
  function pathBlocked(a, b, balls, ignore, clear) {
    for (const o of balls) {
      if (ignore.indexOf(o.id) !== -1) continue;
      if (distToSeg(o, a, b) < clear) return true;
    }
    return false;
  }

  // Which balls the bot may legally strike first.
  function legalTargets(ctx) {
    const { balls, group, onEight } = ctx;
    if (onEight) return balls.filter(b => b.id === 8);
    if (!group) return balls.filter(b => b.id !== 8);           // open table
    const solid = group === 'solid';
    return balls.filter(b => b.id !== 8 && (solid ? b.id < 8 : b.id > 8));
  }

  // Best straight-ish pot from a given cue position. Returns the top candidate
  // { pocket(index), dir, yaw, hardness, dObj, dCue, cosCut } or null.
  function bestPot(ctx, cuePos) {
    const B = window.PoolBanks, t = tableOf(ctx);
    const { balls, POCKETS, R, LIMX, LIMZ } = ctx;
    const targets = legalTargets(ctx);
    const clear = 2 * R * 0.98;
    let best = null;
    for (const T of targets) {
      for (let pi = 0; pi < POCKETS.length; pi++) {
        const P = POCKETS[pi];
        const toPocket = norm(sub(P, T));               // dir the object must go
        // Side pockets are only reachable through their cushion slot — the same
        // gate the green-pocket predictor applies, so the planner never proposes
        // a side pot that game.js's verifier will then refuse to tune.
        if (B && !B.reachable(t, T, toPocket, pi)) continue;
        const ghost = { x: T.x - toPocket.x * 2 * R, z: T.z - toPocket.z * 2 * R };
        if (Math.abs(ghost.x) > LIMX || Math.abs(ghost.z) > LIMZ) continue; // behind a rail
        const toGhost = sub(ghost, cuePos);
        const dir = norm(toGhost);
        const cosCut = dot(dir, toPocket);
        if (cosCut < 0.15) continue;                    // cut thinner than ~81°: skip
        const dCue = len(toGhost);
        const dObj = len(sub(P, T));
        if (pathBlocked(cuePos, ghost, balls, [T.id], clear)) continue; // cue path
        if (pathBlocked(T, P, balls, [T.id], clear)) continue;          // object path
        const railHug = (Math.abs(T.z) > LIMZ - 3 * R || Math.abs(T.x) > LIMX - 3 * R) ? 0.3 : 0;
        const hardness = (1 - cosCut) * 2.4 + (dCue + dObj) * 0.55 + railHug;
        if (!best || hardness < best.hardness) {
          best = { pocket: pi, dir, yaw: yawFor(dir), hardness, dObj, dCue, cosCut, target: T.id };
        }
      }
    }
    return best;
  }

  // Stroke strength: reach the ghost (dCue) and drive the object to the pocket
  // (dObj), with extra on thin cuts, where less energy transfers to the object.
  // A banked ball also loses speed at the cushion (the normal component is cut
  // to REST), so it needs a firmer stroke over its longer path.
  function powerFor(shot, viaRail) {
    const cutBoost = shot.dObj / Math.max(shot.cosCut, 0.35);
    let p = 0.30 + 0.16 * shot.dCue + 0.26 * cutBoost;
    if (viaRail) p *= 1.3;
    return Math.max(0.24, Math.min(viaRail ? 1 : 0.9, p));
  }

  // The banks.js table descriptor, built from the snapshot game.js hands us.
  function tableOf(ctx) {
    return {
      R: ctx.R, PW: ctx.PW, PH: ctx.PH, LIMX: ctx.LIMX, LIMZ: ctx.LIMZ,
      CORNER_GAP: ctx.CORNER_GAP, SIDE_GAP: ctx.SIDE_GAP,
      POCKETS: ctx.POCKETS, REST: ctx.REST, GRIP: ctx.GRIP,
    };
  }

  /* Best one-rail BANK: drive a legal ball off a cushion into a pocket. Same
     ghost-ball aiming as bestPot, except the object is sent at the rail's aim
     point rather than straight at the pocket. */
  function bestBank(ctx, cuePos) {
    const B = window.PoolBanks;
    if (!B) return null;
    const t = tableOf(ctx);
    const { balls, POCKETS, R, LIMX, LIMZ } = ctx;
    const clear = 2 * R * 0.98;
    let best = null;
    for (const T of legalTargets(ctx)) {
      for (let pi = 0; pi < POCKETS.length; pi++) {
        const P = POCKETS[pi];
        for (const rail of B.rails(t)) {
          const H = B.aimPoint(t, T, P, rail);
          if (!H || !B.onCushion(t, rail, H.x, H.z)) continue;
          // Aim the cue so the object departs toward the rail's aim point.
          const toRail = norm(sub(H, T));
          // Confirm the whole banked path against the very predicate game.js
          // will tune this shot against. Reflection geometry alone will happily
          // propose a side-pocket bank that can't thread the cushion slot — this
          // keeps the planner from ever choosing a shot the verifier rejects.
          if (B.pocketAfterBank(t, T, toRail, balls, T.id) !== pi) continue;
          const ghost = { x: T.x - toRail.x * 2 * R, z: T.z - toRail.z * 2 * R };
          if (Math.abs(ghost.x) > LIMX || Math.abs(ghost.z) > LIMZ) continue;
          const toGhost = sub(ghost, cuePos);
          const dir = norm(toGhost);
          const cosCut = dot(dir, toRail);
          if (cosCut < MIN_BANK_CUT) continue;
          if (pathBlocked(cuePos, ghost, balls, [T.id], clear)) continue;
          const dCue = len(toGhost);
          const dObj = len(sub(H, T)) + len(sub(P, H));
          const hardness = BANK_COST + (1 - cosCut) * 2.4 + (dCue + dObj) * 0.55;
          if (!best || hardness < best.hardness) {
            best = { pocket: pi, dir, yaw: yawFor(dir), hardness, dObj, dCue, cosCut, target: T.id };
          }
        }
      }
    }
    return best;
  }

  // Can the cue reach ANY legal ball in a straight line? When it can't, playing
  // a direct "safety" just fouls — that's when a kick is worth searching for.
  function hasDirectContact(ctx, cuePos) {
    const clear = 2 * ctx.R * 0.98;
    return legalTargets(ctx).some(T => !pathBlocked(cuePos, T, ctx.balls, [T.id], clear));
  }

  /* Best one-rail KICK: bounce the cue off a cushion into a legal ball, so a
     snookered table produces a legal hit instead of a foul. Aims for the
     shortest such path; potting is a bonus, not the goal. */
  function bestKick(ctx, cuePos) {
    const B = window.PoolBanks;
    if (!B) return null;
    const t = tableOf(ctx);
    const clear = 2 * ctx.R * 0.98;
    let best = null;
    for (const T of legalTargets(ctx)) {
      for (const rail of B.rails(t)) {
        const H = B.aimPoint(t, cuePos, T, rail);
        if (!H || !B.onCushion(t, rail, H.x, H.z)) continue;
        if (pathBlocked(cuePos, H, ctx.balls, [T.id], clear)) continue; // cue -> rail
        if (pathBlocked(H, T, ctx.balls, [T.id], clear)) continue;      // rail -> ball
        const dist = len(sub(H, cuePos)) + len(sub(T, H));
        if (!best || dist < best.dist) {
          best = { yaw: yawFor(norm(sub(H, cuePos))), dist, target: T.id };
        }
      }
    }
    if (!best) return null;
    return {
      yaw: best.yaw, sigma: AIM_BASE + AIM_DIST * best.dist,
      // Firm enough to still be moving after the cushion takes its cut.
      power: Math.max(0.4, Math.min(1, 0.34 + 0.26 * best.dist)),
      via: 'kick', target: best.target,
    };
  }

  // Aim noise (true 1σ) for a shot: mostly its cut angle, plus a little for the
  // total distance the balls travel. game.js applies this as the bot's wobble.
  function aimSigma(cosCut, dCue, dObj) {
    return AIM_BASE + AIM_CUT * (1 - cosCut) + AIM_DIST * (dCue + dObj);
  }

  // No makeable pot: just make a legal contact softly (avoid a foul). Hit the
  // nearest legal ball with a clear line, or failing that aim at any legal ball.
  function safeShot(ctx, cuePos) {
    const targets = legalTargets(ctx);
    const clear = 2 * ctx.R * 0.98;
    let pick = null, best = Infinity;
    for (const T of targets) {
      const d = len(sub(T, cuePos));
      if (d < best && !pathBlocked(cuePos, T, ctx.balls, [T.id], clear)) { best = d; pick = T; }
    }
    if (!pick) pick = targets[0];
    if (!pick) return { yaw: yawFor({ x: 1, z: 0 }), sigma: 0.03, power: 0.3, safe: true };
    const dir = norm(sub(pick, cuePos));
    return { yaw: yawFor(dir), sigma: 0.03, power: 0.34, safe: true, target: pick.id };
  }

  /* Decide a shot from a fixed cue position, best option first:
       1. a direct pot,
       2. a one-rail bank (pot something the straight line can't reach),
       3. a one-rail kick, but only when NOTHING is reachable straight — that's
          the case where a plain safety would foul,
       4. a safety. */
  function aimFrom(ctx, cuePos) {
    const shot = bestPot(ctx, cuePos);
    if (shot && (shot.hardness < MAX_HARDNESS || ctx.onEight)) {
      return {
        yaw: shot.yaw, sigma: aimSigma(shot.cosCut, shot.dCue, shot.dObj),
        power: powerFor(shot), pocket: shot.pocket, target: shot.target,
      };
    }

    const bank = bestBank(ctx, cuePos);
    if (bank && (bank.hardness < MAX_BANK_HARDNESS || ctx.onEight)) {
      return {
        yaw: bank.yaw, sigma: aimSigma(bank.cosCut, bank.dCue, bank.dObj),
        power: powerFor(bank, true), pocket: bank.pocket,
        via: 'bank', target: bank.target,
      };
    }

    if (!hasDirectContact(ctx, cuePos)) {
      const kick = bestKick(ctx, cuePos);
      if (kick) return kick;
    }

    return safeShot(ctx, cuePos);
  }

  // Ball-in-hand: place the cue for the easiest dead-straight pot (cue, ghost,
  // object and pocket all colinear). Returns a shot with `place`, or null.
  function placeShot(ctx) {
    const { balls, POCKETS, R, LIMX, LIMZ } = ctx;
    const targets = legalTargets(ctx);
    const STAND = 0.32; // cue standoff behind the ghost along the shot line
    const clear = 2 * R * 0.98;
    let best = null;
    for (const T of targets) {
      for (let pi = 0; pi < POCKETS.length; pi++) {
        const P = POCKETS[pi];
        const toPocket = norm(sub(P, T));
        const ghost = { x: T.x - toPocket.x * 2 * R, z: T.z - toPocket.z * 2 * R };
        const cuePos = { x: ghost.x - toPocket.x * STAND, z: ghost.z - toPocket.z * STAND };
        if (Math.abs(cuePos.x) > LIMX || Math.abs(cuePos.z) > LIMZ) continue;
        if (balls.some(b => Math.hypot(b.x - cuePos.x, b.z - cuePos.z) < 2 * R * 1.05)) continue;
        if (pathBlocked(cuePos, ghost, balls, [T.id], clear)) continue;
        if (pathBlocked(T, P, balls, [T.id], clear)) continue;
        const dObj = len(sub(P, T));
        if (!best || dObj < best.dObj) {
          best = { place: cuePos, pocket: pi, dObj, cosCut: 1, dCue: STAND + 2 * R, yaw: yawFor(toPocket), target: T.id };
        }
      }
    }
    if (!best) return null;
    return {
      place: best.place, yaw: best.yaw, sigma: aimSigma(1, best.dCue, best.dObj),
      power: powerFor(best), pocket: best.pocket, target: best.target,
    };
  }

  // Opening break: smash straight into the rack (aim at the nearest racked ball)
  // at full power. `safe` so game.js doesn't green-tune it (there's no pot to aim
  // for on a fresh rack) and doesn't nominate a called pocket.
  function openingBreak(ctx) {
    let near = null, nd = Infinity;
    for (const b of ctx.balls) {
      const d = len(sub(b, ctx.cue));
      if (d < nd) { nd = d; near = b; }
    }
    const dir = near ? norm(sub(near, ctx.cue)) : { x: 1, z: 0 };
    return { yaw: yawFor(dir), sigma: 0.012, power: 1, safe: true };
  }

  /* The pocket to nominate for an 8-ball shot that isn't aimed at one — the bot
     is snookered and playing a kick or safety, but the rules still demand a
     call. Picks the most plausible: nearest to the 8, preferring one it could
     actually reach in a straight line. Missing a called pocket is only a miss,
     so this costs nothing; what it prevents is winning on a fluke. */
  function nominateFor8(ctx) {
    const eight = ctx.balls.find(b => b.id === 8);
    if (!eight) return -1;
    const B = window.PoolBanks;
    const t = tableOf(ctx);
    const clear = 2 * ctx.R * 0.98;
    let best = -1, bestScore = Infinity;
    for (let pi = 0; pi < ctx.POCKETS.length; pi++) {
      const P = ctx.POCKETS[pi];
      const blocked = pathBlocked(eight, P, ctx.balls, [8], clear);
      const reaches = !B || B.reachable(t, eight, norm(sub(P, eight)), pi);
      const score = len(sub(P, eight)) + (blocked ? 10 : 0) + (reaches ? 0 : 5);
      if (score < bestScore) { bestScore = score; best = pi; }
    }
    return best;
  }

  function chooseShot(ctx) {
    if (ctx.breakShot) return openingBreak(ctx);

    let shot;
    if (ctx.phase === 'place') {
      shot = placeShot(ctx);
      if (!shot) {
        // No clean straight placement — drop the cue on the break spot and aim.
        const cuePos = { x: -ctx.PW * 0.5, z: 0 };
        shot = aimFrom(ctx, cuePos);
        shot.place = cuePos;
      }
    } else {
      shot = aimFrom(ctx, ctx.cue);
    }

    // On the 8, a pocket must ALWAYS be called — the human is forced to, so the
    // bot doesn't get to duck it by playing a shot with no pot in mind. Kept in
    // `callPocket` rather than `pocket` so it can't be mistaken for an aim point
    // by game.js's shot tuning.
    if (ctx.onEight && (shot.pocket == null || shot.pocket < 0)) {
      shot.callPocket = nominateFor8(ctx);
    }
    return shot;
  }

  window.PoolBot = { chooseShot };
})();

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
 *          onEight:bool, lowestId:number|null, phase:'aim'|'place',
 *          breakShot:bool }
 *   lowestId: set ONLY in 9-ball, to the lowest ball still on the table — the one
 *          ball the cue must strike first. Its presence is what switches the
 *          rules hooks (legal targets, lookahead, the called-pocket rule) from
 *          8-ball's suits to rotation; every other decision is rule-agnostic.
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

  // Position play (js/position.js). The bot rolls the cue ball out to where it
  // would actually stop and asks what it would have NEXT, then adds that to the
  // shot's own hardness at POS_WEIGHT. Kept well under 1 on purpose: potting is
  // still the job, and a bot that passes up a hanger to play shape is worse than
  // one that doesn't, not better. The costs below are in `hardness` units, whose
  // useful range is ~0..4 (MAX_HARDNESS is 4.2).
  const POS_WEIGHT = 0.45;
  const PLAN_WIDTH = 6;          // easiest N pots get a roll-out; the rest can't win
  const NO_SHOT = 6.0;           // left with nothing on
  const SCRATCH_COST = 14.0;     // cue ball down: hands over ball-in-hand, avoid hard
  const RAIL_COST = 0.8;         // finished tight on a cushion: awkward next bridge
  const CLUTTER_COST = 1.2;      // finished in traffic, where the roll-out gave up
  // Stroke speeds tried per shot, as multipliers of powerFor's baseline. The
  // soft end is what buys position (a stunned cue ball stays put); every option
  // is verified to still sink the ball before it's allowed to win.
  const POWER_TRIES = [0.85, 1, 1.25, 1.6];

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
  // Tightest gap any ball leaves against the segment a->b. pathBlocked is just
  // this with a threshold, but the shot-outcome model wants the margin itself —
  // how much traffic a shot threads decides whether a near-miss still drops —
  // so both come out of a single walk rather than two.
  function pathGap(a, b, balls, ignore) {
    let m = Infinity;
    for (const o of balls) {
      if (ignore.indexOf(o.id) !== -1) continue;
      const d = distToSeg(o, a, b);
      if (d < m) m = d;
    }
    return m;
  }

  function pathBlocked(a, b, balls, ignore, clear) {
    return pathGap(a, b, balls, ignore) < clear;
  }

  // Distance from a point to the nearest cushion, in ball radii. `railHug` is a
  // step function of this; the model gets the real number.
  function railDist(ctx, p) {
    return Math.min(ctx.LIMX - Math.abs(p.x), ctx.LIMZ - Math.abs(p.z)) / ctx.R;
  }

  /* ------------------------- shot-outcome model -------------------------- */
  // js/potmodel.js, when it has loaded. Everything here falls back to the
  // hand-tuned `hardness` line without it — which is also how the offline tools
  // run, since tools/gen-pot-samples.js loads this file with no model present.
  function model() {
    const M = typeof window !== 'undefined' && window.PoolPotModel;
    return M && M.ready() ? M : null;
  }

  // The feature vector js/potmodel.json was trained on. Built HERE, and called
  // by tools/gen-pot-samples.js through the export below, so the numbers the
  // model is trained on and the numbers it is asked about cannot drift apart.
  // `gapCue`/`gapObj` are the raw world-unit clearances potCandidates already
  // measured; the model wants them in ball radii, capped where more room stops
  // making any difference.
  function potFeatures(ctx, cuePos, cand, power, gapCue, gapObj) {
    const cap = g => Math.min(g / ctx.R, 8);
    return {
      cosCut: cand.cosCut, dCue: cand.dCue, dObj: cand.dObj,
      power, side: cand.pocket >= 4 ? 1 : 0,
      railT: railDist(ctx, cand.from), railC: railDist(ctx, cuePos),
      clearCue: cap(gapCue), clearObj: cap(gapObj),
    };
  }

  // The model's verdict, expressed on the SAME scale as the hand-tuned
  // `hardness` so every constant tuned against it (MAX_HARDNESS, NO_SHOT,
  // BANK_COST, POS_WEIGHT) keeps its meaning. tools/train_pot.py fits that
  // mapping from the training set and ships it in the blob.
  //
  // The effective window folds in the chance the shot is potable at all:
  // P(pot) is proportional to makeable * w for the tight windows where the
  // choice is actually difficult, so makeable*w is the right thing to rank on.
  function modelHardness(M, ctx, cuePos, cand, gapCue, gapObj) {
    const scale = M.hardnessScale && M.hardnessScale();
    if (!scale) return null;
    const p = M.predict(potFeatures(ctx, cuePos, cand, powerFor(cand), gapCue, gapObj));
    if (!p) return null;
    const wEff = p.makeable * p.w;
    if (!(wEff > 0)) return NO_SHOT;
    const h = scale.a + scale.b * Math.log(wEff);
    return Math.max(0, Math.min(NO_SHOT, h));
  }

  /* Is this shot for the match? The 8 in 8-ball, the 9 in 9-ball. Nothing to
     play position FOR on a game ball, and it's always worth attempting however
     hard it is, so the shot picker treats both the same way. */
  function onGameBall(ctx) {
    return ctx.lowestId != null ? ctx.lowestId === 9 : !!ctx.onEight;
  }

  // Which balls the bot may legally strike first.
  function legalTargets(ctx) {
    const { balls, group, onEight, lowestId } = ctx;
    if (lowestId != null) return balls.filter(b => b.id === lowestId); // 9-ball: lowest only
    if (onEight) return balls.filter(b => b.id === 8);
    if (!group) return balls.filter(b => b.id !== 8);           // open table
    const solid = group === 'solid';
    return balls.filter(b => b.id !== 8 && (solid ? b.id < 8 : b.id > 8));
  }

  /* Every legal (target, pocket) pot available from `cuePos`, scored on pure
     shot-making geometry — no judgement about what the cue ball leaves behind.
     `balls` and `targets` are explicit rather than read off ctx so the position
     planner can re-run this on a HYPOTHETICAL table (the one that exists after
     a pot drops) to see what the next shot would be. */
  function potCandidates(ctx, cuePos, balls, targets) {
    const B = window.PoolBanks, t = tableOf(ctx);
    const { POCKETS, R, LIMX, LIMZ } = ctx;
    const clear = 2 * R * 0.98;
    const out = [];
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
        const gapCue = pathGap(cuePos, ghost, balls, [T.id]);
        if (gapCue < clear) continue;                                   // cue path
        const gapObj = pathGap(T, P, balls, [T.id]);
        if (gapObj < clear) continue;                                   // object path
        const railHug = (Math.abs(T.z) > LIMZ - 3 * R || Math.abs(T.x) > LIMX - 3 * R) ? 0.3 : 0;
        // The original hand-tuned line. Kept unconditionally: it is the
        // fallback when no model is loaded, and tools/gen-pot-samples.js
        // records it as the baseline the model has to beat.
        const geoHardness = (1 - cosCut) * 2.4 + (dCue + dObj) * 0.55 + railHug;
        const cand = {
          pocket: pi, dir, yaw: yawFor(dir), hardness: geoHardness, geoHardness,
          dObj, dCue, cosCut, gapCue, gapObj,
          target: T.id, from: { x: T.x, z: T.z },
        };
        // With a model loaded, `hardness` becomes its calibrated estimate of the
        // same thing the line was guessing at. Everything downstream — the sort,
        // easiestPot, the MAX_HARDNESS gate, bestPot's scoring — then runs on the
        // better number without knowing anything changed.
        const M = model();
        if (M) {
          const h = modelHardness(M, ctx, cuePos, cand, gapCue, gapObj);
          if (h !== null) cand.hardness = h;
        }
        out.push(cand);
      }
    }
    return out;
  }

  // Cheapest pot on the table, ignoring position — the lookahead's verdict on
  // "what would I have next?". NO_SHOT when the layout leaves nothing on.
  function easiestPot(ctx, cuePos, balls, targets) {
    let h = NO_SHOT;
    for (const c of potCandidates(ctx, cuePos, balls, targets)) {
      if (c.hardness < h) h = c.hardness;
    }
    return h;
  }

  /* Which balls the bot would be shooting at NEXT if `potId` drops. 8-ball: its
     own group minus that ball, or the 8 once the group is cleared — and on an
     open table the pot itself decides the group, so the ball's own suit is used.
     9-ball: whatever the lowest ball becomes, which is the whole point of
     playing shape in rotation. */
  function nextTargets(ctx, restBalls, potId) {
    if (ctx.lowestId != null) {                          // 9-ball: always the new lowest
      if (!restBalls.length) return [];
      const min = Math.min(...restBalls.map(b => b.id));
      return restBalls.filter(b => b.id === min);
    }
    const solid = ctx.group ? ctx.group === 'solid' : potId < 8;
    const mine = restBalls.filter(b => b.id !== 8 && (solid ? b.id < 8 : b.id > 8));
    return mine.length ? mine : restBalls.filter(b => b.id === 8);
  }

  /* How bad is the table this shot leaves? Lower is better, and it's measured
     in the same units as `hardness` so the two can simply be added. */
  function positionCost(ctx, rest, restBalls, nextT) {
    if (rest.pocket >= 0) return SCRATCH_COST;           // cue ball went down
    const Q = { x: rest.x, z: rest.z };
    let cost = Math.min(easiestPot(ctx, Q, restBalls, nextT), NO_SHOT);
    // Frozen on a cushion: awkward bridge, and the aim-assist can't help either.
    if (Math.abs(Q.x) > ctx.LIMX - 2 * ctx.R || Math.abs(Q.z) > ctx.LIMZ - 2 * ctx.R) cost += RAIL_COST;
    if (rest.cluttered) cost += CLUTTER_COST;            // finished in traffic
    return cost;
  }

  /* Plan the stroke for one candidate pot: try a spread of speeds, keep only the
     ones that still actually sink the ball (checked by rolling the object ball
     out, which also rules out the coming-up-short that pure geometry can't see),
     and pick whichever leaves the best next shot. Returns { cost, power }. */
  function planShot(ctx, cuePos, shot) {
    const P = window.PoolPos, t = tableOf(ctx);
    const restBalls = ctx.balls.filter(b => b.id !== shot.target);
    const nextT = nextTargets(ctx, restBalls, shot.target);
    const base = powerFor(shot);
    let best = null;
    for (const mul of POWER_TRIES) {
      const power = Math.max(0.24, Math.min(0.9, base * mul));
      const cue = P.roll(t, cuePos, shot.dir, power * ctx.MAX_V, ctx.balls, shot.target);
      if (!cue.transfer) continue;            // never even reached the object ball
      const obj = P.roll(t, shot.from, cue.transfer.dir, cue.transfer.speed, restBalls, -1);
      if (obj.pocket !== shot.pocket) continue; // too soft / wrong pocket at this speed
      const cost = positionCost(ctx, cue, restBalls, nextT);
      if (!best || cost < best.cost) best = { cost, power };
    }
    return best;
  }

  /* Best pot from a given cue position — the easiest shot that also leaves the
     cue ball somewhere useful. Shot-making still leads: `hardness` is weighted
     full and the follow-on only at POS_WEIGHT, so position breaks ties between
     comparable pots rather than talking the bot into a low-percentage one. Only
     the PLAN_WIDTH easiest are planned, because rolling out the rest costs time
     to rank shots that were never going to be chosen. */
  function bestPot(ctx, cuePos) {
    const cands = potCandidates(ctx, cuePos, ctx.balls, legalTargets(ctx));
    if (!cands.length) return null;
    cands.sort((a, b) => a.hardness - b.hardness);
    // Nothing to play position FOR when the shot ends the game — and without the
    // roll-out module this degrades to the old "just take the easiest pot".
    if (onGameBall(ctx) || !window.PoolPos) return cands[0];

    let best = null;
    for (let i = 0; i < cands.length && i < PLAN_WIDTH; i++) {
      const c = cands[i];
      const plan = planShot(ctx, cuePos, c);
      if (!plan) continue;                    // no speed makes this one drop
      const score = c.hardness + POS_WEIGHT * plan.cost;
      if (!best || score < best.score) best = Object.assign({}, c, { score, power: plan.power });
    }
    // Every candidate failed its roll-out (all too fine to survive the sim):
    // fall back to the geometric pick rather than passing up the shot.
    return best || cands[0];
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

  // The table descriptor js/banks.js and js/position.js both take. The trailing
  // physics constants are only used by position.js's roll-out.
  function tableOf(ctx) {
    return {
      R: ctx.R, PW: ctx.PW, PH: ctx.PH, LIMX: ctx.LIMX, LIMZ: ctx.LIMZ,
      CORNER_GAP: ctx.CORNER_GAP, SIDE_GAP: ctx.SIDE_GAP,
      POCKETS: ctx.POCKETS, REST: ctx.REST, GRIP: ctx.GRIP,
      REST_BALL: ctx.REST_BALL, FRIC_C: ctx.FRIC_C, FRIC_L: ctx.FRIC_L,
      STOP_V: ctx.STOP_V, PHYS_H: ctx.PHYS_H,
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
    if (shot && (shot.hardness < MAX_HARDNESS || onGameBall(ctx))) {
      return {
        yaw: shot.yaw, sigma: aimSigma(shot.cosCut, shot.dCue, shot.dObj),
        // the speed the position planner settled on, if it got to run
        power: shot.power != null ? shot.power : powerFor(shot),
        pocket: shot.pocket, target: shot.target,
      };
    }

    const bank = bestBank(ctx, cuePos);
    if (bank && (bank.hardness < MAX_BANK_HARDNESS || onGameBall(ctx))) {
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

  /* Ball-in-hand: place the cue for a dead-straight pot (cue, ghost, object and
     pocket all colinear). Among those, prefer the one that also leaves the next
     ball on — free placement is the best chance the bot ever gets to play shape,
     and a straight pot stuns the cue to a near-standstill at the ghost, so which
     ball and pocket it picks decides where it shoots from next. Returns a shot
     with `place`, or null. */
  function placeShot(ctx) {
    const { balls, POCKETS, R, LIMX, LIMZ } = ctx;
    const targets = legalTargets(ctx);
    const STAND = 0.32; // cue standoff behind the ghost along the shot line
    const clear = 2 * R * 0.98;
    const cands = [];
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
        cands.push({
          place: cuePos, pocket: pi, dObj: len(sub(P, T)), cosCut: 1,
          dCue: STAND + 2 * R, yaw: yawFor(toPocket), dir: toPocket,
          target: T.id, from: { x: T.x, z: T.z },
        });
      }
    }
    if (!cands.length) return null;
    cands.sort((a, b) => a.dObj - b.dObj);

    let best = cands[0];
    if (!onGameBall(ctx) && window.PoolPos) {
      let bestScore = Infinity;
      for (let i = 0; i < cands.length && i < PLAN_WIDTH; i++) {
        const c = cands[i];
        const plan = planShot(ctx, c.place, c);
        if (!plan) continue;
        // Distance still counts (a long straight pot is a worse bet than a short
        // one), but position is what separates otherwise-equivalent placements.
        const score = c.dObj * 0.55 + POS_WEIGHT * plan.cost;
        if (score < bestScore) { bestScore = score; best = Object.assign({}, c, { power: plan.power }); }
      }
    }
    return {
      place: best.place, yaw: best.yaw, sigma: aimSigma(1, best.dCue, best.dObj),
      power: best.power != null ? best.power : powerFor(best),
      pocket: best.pocket, target: best.target,
    };
  }

  /* Where to drop the cue ball when NO dead-straight placement exists — every
     line to a legal ball is blocked, or the only pot left is behind traffic.
     Sweeps the table on a coarse grid and keeps the spot with the easiest pot
     from it, falling back to the openest square when nothing is on at all.
     This matters most in 9-ball, where only one ball is ever legal to hit, so
     placeShot() comes up empty far more often than it does in 8-ball. */
  const GRID_X = 13, GRID_Z = 7;
  function fallbackPlace(ctx) {
    const { balls, R, LIMX, LIMZ } = ctx;
    const targets = legalTargets(ctx);
    const clear = 2 * R * 0.98;
    let best = null, bestScore = Infinity;
    for (let i = 0; i < GRID_X; i++) {
      for (let j = 0; j < GRID_Z; j++) {
        // Inset a ball's width from the rails: a cue frozen on a cushion is
        // an awkward bridge and gives up most of the point of ball-in-hand.
        const x = -LIMX + R + (2 * (LIMX - R)) * (i / (GRID_X - 1));
        const z = -LIMZ + R + (2 * (LIMZ - R)) * (j / (GRID_Z - 1));
        const p = { x, z };
        if (balls.some(b => Math.hypot(b.x - x, b.z - z) < 2 * R * 1.15)) continue;
        // Prefer a spot with a pot on; failing that, one that can at least see a
        // legal ball, so the stroke is a legal hit rather than a foul.
        let score = easiestPot(ctx, p, balls, targets);
        if (score >= NO_SHOT) {
          const sees = targets.some(T => !pathBlocked(p, T, balls, [T.id], clear));
          score = NO_SHOT + (sees ? 0 : 1);
        }
        if (score < bestScore) { bestScore = score; best = p; }
      }
    }
    return best;
  }

  // Opening break: smash straight into the rack (aim at the nearest racked ball)
  // at full power. `safe` so game.js doesn't green-tune it (there's no pot to aim
  // for on a fresh rack) and doesn't nominate a called pocket.
  function openingBreak() {
    // Break exactly straight at full power, along the table's centerline (z=0).
    // Aim at a point far along the x-axis so any floating-point error in the
    // yaw is negligible; the cue ball will travel perfectly parallel to the
    // table's length.
    const dir = norm({ x: 1, z: 0 });
    return { yaw: yawFor(dir), sigma: 0, power: 1, safe: true };
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
        // No clean straight placement — sweep for the best spot going and aim
        // from there. Never the break spot: that sits ON the end cushion.
        const cuePos = fallbackPlace(ctx) || { x: -ctx.LIMX + ctx.R, z: 0 };
        shot = aimFrom(ctx, cuePos);
        shot.place = cuePos;
      }
    } else {
      shot = aimFrom(ctx, ctx.cue);
    }

    // On the 8, a pocket must ALWAYS be called — the human is forced to, so the
    // bot doesn't get to duck it by playing a shot with no pot in mind. Kept in
    // `callPocket` rather than `pocket` so it can't be mistaken for an aim point
    // by game.js's shot tuning. 9-ball calls nothing: the 9 wins in any pocket,
    // so there's nothing to nominate.
    if (ctx.lowestId == null && ctx.onEight && (shot.pocket == null || shot.pocket < 0)) {
      shot.callPocket = nominateFor8(ctx);
    }
    return shot;
  }

  // chooseShot is the bot's whole job. The rest is exposed for the offline
  // tools in tools/: a shot-outcome model has to be trained on EXACTLY the
  // features the bot will feed it at run time, so the generator calls the same
  // candidate enumeration rather than reimplementing the geometry and drifting.
  // Pull the weights in the background, in a page. Until they land — or if they
  // never do, for anyone serving the game without the blob — every path above
  // falls back to the hand-tuned line. The offline tools in tools/ hand the
  // blob over with PoolPotModel.use() instead, so they must not fetch here.
  if (typeof document !== 'undefined' && typeof fetch === 'function'
      && window.PoolPotModel) window.PoolPotModel.load();

  window.PoolBot = {
    chooseShot,
    potCandidates, legalTargets, powerFor, aimSigma,
    // Feature construction, for tools/gen-pot-samples.js — same code path the
    // bot uses, so training data and inference can't describe different things.
    potFeatures, railDist, pathGap,
  };
})();

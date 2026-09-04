/* Snooker rules for Pixel Pool.
 *
 * A pure rules module, the same shape as js/nineball.js: it owns the ball
 * values, the spot geometry, the "which ball is on" question and the stroke
 * verdict, and touches no scene, DOM or match state. game.js feeds it what a
 * stroke did and applies the verdict it hands back (see resolveShotSnooker),
 * so 8-ball's and 9-ball's resolution paths are untouched.
 *
 * BALL IDS. Snooker needs 22 balls, so it borrows the pool ids and extends
 * them: 0 is the cue ball, 1-15 are the fifteen reds (exactly the object-ball
 * ids 8-ball already uses) and 16-21 are the six colours in ascending value.
 * The colours sit out the pool games the way 10-15 sit out 9-ball — racked as
 * already-potted, a state every consumer already skips.
 *
 * The rules implemented (WPBSA, minus the referee's-judgement parts — see the
 * list of omissions at the bottom of this comment):
 *   • Reds are worth 1; yellow 2, green 3, brown 4, blue 5, pink 6, black 7.
 *   • A visit opens "on a red": the cue ball must strike a red first and only
 *     reds may drop. Pot one (or several — they all count) and the striker
 *     stays at the table, now on a COLOUR of their choice, which they nominate.
 *   • Pot the nominated colour and it is re-spotted; the striker is back on a
 *     red. Reds are never re-spotted.
 *   • Once the reds are gone the striker who potted the last red still gets one
 *     free-choice colour (re-spotted as usual). After that the colours must be
 *     taken in ascending order and stay down.
 *   • Every foul scores the OPPONENT the penalty: 4 points minimum, or the
 *     value of the ball on / the ball wrongly struck / the ball wrongly potted,
 *     whichever is highest. Colours potted on a foul are re-spotted; reds are
 *     not. The striker scores nothing on a foul stroke.
 *   • Once only the black is left, the first score or foul ends the frame. The
 *     higher score wins; level scores re-spot the black (game.js handles the
 *     toss and the ball-in-hand that follows).
 *
 * NOT implemented (all need a referee or snooker detection): the free ball, the
 * miss rule, the "play again / play from where it lies" option the incoming
 * player gets after a foul (here they always play from where the cue ball
 * stopped), push shots, touching balls and concessions.
 */
(function () {
  'use strict';

  /* ------------------------------- the balls ------------------------------ */

  const REDS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
  const YELLOW = 16, GREEN = 17, BROWN = 18, BLUE = 19, PINK = 20, BLACK = 21;
  // Ascending value — this IS the order the endgame sequence runs in.
  const COLOURS = [YELLOW, GREEN, BROWN, BLUE, PINK, BLACK];
  // Every object ball in the frame, for the callers that iterate the table.
  const OBJECT_BALLS = REDS.concat(COLOURS);

  const COLOUR_VALUE = {
    [YELLOW]: 2, [GREEN]: 3, [BROWN]: 4, [BLUE]: 5, [PINK]: 6, [BLACK]: 7,
  };
  const COLOUR_NAME = {
    [YELLOW]: 'YELLOW', [GREEN]: 'GREEN', [BROWN]: 'BROWN',
    [BLUE]: 'BLUE', [PINK]: 'PINK', [BLACK]: 'BLACK',
  };
  // Cloth-side colours, picked to stay legible as 8px HUD chips as well as on
  // the 3D ball. game.js paints both from here so they can never drift apart.
  const COLOUR_HEX = {
    [YELLOW]: '#f0c419', [GREEN]: '#12703c', [BROWN]: '#7a4a1e',
    [BLUE]: '#1553bd', [PINK]: '#ef8098', [BLACK]: '#14141c',
  };
  const RED_HEX = '#c8202a';

  const isRed = id => id >= 1 && id <= 15;
  // Point value of any object ball. Reds are all worth 1, so their ids don't
  // need a table of their own.
  const value = id => (isRed(id) ? 1 : (COLOUR_VALUE[id] || 0));
  const name = id => (isRed(id) ? 'RED' : (COLOUR_NAME[id] || 'BALL'));
  const hex = id => (isRed(id) ? RED_HEX : (COLOUR_HEX[id] || '#ffffff'));

  /* ------------------------------- geometry ------------------------------- */
  //
  // Every distance below is expressed as a FRACTION of the playing area, taken
  // from the WPBSA standard table (playing area 3569 x 1778 mm, i.e. 11ft 8.5in
  // by 5ft 10in), so the layout is right whatever size bed game.js hands us:
  //
  //   baulk line   737 mm from the face of the baulk cushion  -> 0.2065 of length
  //   D radius     292 mm                                     -> 0.1642 of width
  //   black spot   324 mm from the face of the top cushion    -> 0.0908 of length
  //   blue spot    the centre of the table
  //   pink spot    midway between the centre spot and the top cushion
  //   brown spot   the middle of the baulk line, with green and yellow on the
  //                two corners of the D
  //
  // The ball is to scale too: game.js gives snooker a bed of its own
  // (TABLE_PROFILES) whose ball is sized so the table runs the real 68 ball
  // diameters long and 34 wide, rather than the ~44 of the pool games. That is
  // why this function takes R rather than assuming one — the pack spacing below
  // has to follow whatever ball it is handed.
  const BAULK_F = 737 / 3569;   // baulk line, from the baulk cushion
  const D_F = 292 / 1778;       // radius of the D, across the width
  const BLACK_F = 324 / 3569;   // black spot, from the top cushion

  // In this engine's world axes the baulk end is -x (where the cue ball starts
  // in the pool games) and the top cushion is +x; z runs across the table.
  // Facing up the table from baulk, +z is the striker's right, which is where
  // the yellow lives.
  //
  // geo is {PW, PH} — the HALF-length and HALF-width of the playing area — plus
  // the ball radius R. Returns every fixed point of the frame in world units.
  function layout(geo) {
    const { PW, PH, R } = geo;
    const L = 2 * PW, W = 2 * PH;
    const baulkX = -PW + BAULK_F * L;
    const dR = D_F * W;
    const pinkX = PW / 2;              // halfway from the centre spot to the top cushion
    const spots = {
      [YELLOW]: { x: baulkX, z: dR },
      [GREEN]: { x: baulkX, z: -dR },
      [BROWN]: { x: baulkX, z: 0 },
      [BLUE]: { x: 0, z: 0 },
      [PINK]: { x: pinkX, z: 0 },
      [BLACK]: { x: PW - BLACK_F * L, z: 0 },
    };
    // The pack: apex red as close to the pink as it can sit without touching,
    // rows of 1-2-3-4-5 widening toward the top cushion. Spacing matches the
    // pool racks in game.js (a hair over 2R within a row, rows at d*sqrt(3)/2)
    // so every neighbour just touches and the pack splits cleanly.
    const d = 2 * R * 1.0006, dx = d * Math.sqrt(3) / 2;
    const reds = [];
    let next = 0;
    for (let row = 0; row < 5; row++) {
      for (let i = 0; i <= row; i++) {
        reds.push({
          id: REDS[next++],
          x: pinkX + 2 * R * 1.02 + row * dx,
          z: (i - row / 2) * d,
        });
      }
    }
    return { baulkX, dR, spots, reds };
  }

  // Is (x, z) a legal spot for a ball in hand? The D is the half-disc behind
  // the baulk line, so: on or behind the line, and within its radius of brown.
  // A hair of tolerance on the radius keeps the line itself placeable.
  function inD(geo, x, z) {
    const { baulkX, dR } = layout(geo);
    if (x > baulkX) return false;
    return (x - baulkX) ** 2 + z * z <= (dR * 1.001) ** 2;
  }

  // Where a potted colour goes back. Its own spot first; if that is covered,
  // the highest-value spot that is free; if every spot is covered the caller
  // falls back to "as near as possible to its own spot" (game.js walks up the
  // centre line from `home`). `free(x, z)` reports whether a point is clear.
  // Returns {x, z, onOwnSpot} — onOwnSpot false means the caller may still have
  // to nudge it if even the chosen spot turns out to be blocked.
  function respotSpot(geo, id, free) {
    const { spots } = layout(geo);
    const home = spots[id];
    if (free(home.x, home.z)) return { x: home.x, z: home.z, ownSpot: true };
    // Highest value first: black, pink, blue, brown, green, yellow.
    for (let i = COLOURS.length - 1; i >= 0; i--) {
      const s = spots[COLOURS[i]];
      if (free(s.x, s.z)) return { x: s.x, z: s.z, ownSpot: false };
    }
    return { x: home.x, z: home.z, ownSpot: false };
  }

  /* ------------------------------ the ball on ----------------------------- */

  // The frame's targeting state, owned by game.js and passed back in:
  //   { phase: 'red' | 'colour' | 'sequence', nominated: <colour id or 0> }
  // 'red'      — a fresh visit with reds still on the table
  // 'colour'   — a red has just gone down; the striker names a colour
  // 'sequence' — the reds are gone; the colours go in ascending order
  function opening(isDown) {
    return { phase: REDS.some(id => !isDown(id)) ? 'red' : 'sequence', nominated: 0 };
  }

  // What the striker is on, given the targeting state and a view of which balls
  // are down. `ids` is every ball the cue ball may legally strike first (and the
  // only balls that may legally drop); `value` is the ball on's point value,
  // which also sets the floor on a foul penalty.
  function ballOn(st, isDown) {
    if (st.phase === 'red') {
      return {
        kind: 'red', ids: REDS.filter(id => !isDown(id)),
        value: 1, label: 'RED',
      };
    }
    if (st.phase === 'colour') {
      const id = st.nominated;
      return {
        kind: 'colour', ids: id ? [id] : [],
        value: id ? value(id) : 0, label: id ? name(id) : 'COLOUR',
      };
    }
    const id = COLOURS.find(c => !isDown(c)) || 0;
    return {
      kind: 'sequence', ids: id ? [id] : [],
      value: id ? value(id) : 0, label: id ? name(id) : 'NONE',
    };
  }

  /* ------------------------------- verdict -------------------------------- */

  // Judge one settled stroke. `ev` is what the table did:
  //   potted    — object-ball ids pocketed this stroke (never the cue ball)
  //   scratch   — the cue ball found a pocket
  //   firstHit  — first object ball the cue ball touched, or null for none
  //   on        — the ball on BEFORE the stroke, from ballOn()
  //   redsAfter — reds still on the table once this stroke's pots are counted
  //               (reds never come back, foul or not)
  // Note there is no drive-to-rail requirement in snooker: a legal contact with
  // nothing else happening is simply a miss, not a foul.
  function resolve(ev) {
    const potted = ev.potted || [];
    const on = ev.on;
    const onIds = on.ids || [];
    const isOn = id => onIds.indexOf(id) >= 0;

    const legalPots = potted.filter(isOn);
    const illegalPots = potted.filter(id => !isOn(id));
    const legalHit = ev.firstHit !== null && isOn(ev.firstHit);

    // Fouls, in the order the rules test them.
    const foulKind =
      ev.scratch ? 'scratch'
        : ev.firstHit === null ? 'noContact'
          : !legalHit ? 'wrongBall'
            : illegalPots.length ? 'wrongPot'
              : null;
    const foul = foulKind !== null;

    // Penalty: four points, or the value of the ball on, or of any ball wrongly
    // struck or wrongly potted — whichever is highest.
    let penalty = 0;
    if (foul) {
      penalty = Math.max(4, on.value);
      if (ev.firstHit !== null && !legalHit) penalty = Math.max(penalty, value(ev.firstHit));
      for (const id of illegalPots) penalty = Math.max(penalty, value(id));
    }

    // The striker scores nothing on a foul, even for balls that dropped legally
    // alongside the offence.
    const points = foul ? 0 : legalPots.reduce((s, id) => s + value(id), 0);

    // What goes back on the table. Colours potted on a foul always come back;
    // a legally potted colour comes back only while it is the "free choice"
    // colour taken between reds — in the endgame sequence it stays down. Reds
    // never come back.
    const respot = foul
      ? potted.filter(id => !isRed(id))
      : on.kind === 'colour' ? legalPots.slice() : [];

    const keepTurn = !foul && legalPots.length > 0;

    // Where the next stroke starts. A change of turn always resets to reds (or
    // to the sequence if they are gone) — the free-choice colour belongs only
    // to the striker who just potted the last red, on their very next stroke.
    const next = (keepTurn && on.kind === 'red')
      ? { phase: 'colour', nominated: 0 }
      : { phase: ev.redsAfter > 0 ? 'red' : 'sequence', nominated: 0 };

    // Once only the black is left, the first score or foul settles the frame.
    // (`sequence` with the black on means every other ball is already down.)
    const onFinalBlack = on.kind === 'sequence' && onIds[0] === BLACK;
    const frameOver = onFinalBlack && (foul || legalPots.length > 0);

    return {
      foul, foulKind, penalty, points, respot, keepTurn, next, frameOver,
      potted: legalPots, illegalPots,
      // For the stats recorder, which counts balls pocketed rather than points.
      credited: foul ? 0 : legalPots.length,
    };
  }

  // Sentence describing a foul, for the toast that hands over the table. `on`
  // is the ball on the striker should have been playing; the caller adds the
  // penalty and who it goes to.
  function foulText(kind, on) {
    switch (kind) {
      case 'scratch': return 'In off!';
      case 'noContact': return 'Foul — the cue ball hit nothing.';
      case 'wrongBall': return `Foul — ${on.label} was the ball on.`;
      case 'wrongPot': return 'Foul — potted a ball that wasn\'t on.';
      default: return 'Foul.';
    }
  }

  window.PoolSnooker = {
    REDS, COLOURS, OBJECT_BALLS,
    YELLOW, GREEN, BROWN, BLUE, PINK, BLACK,
    isRed, value, name, hex, RED_HEX,
    layout, inD, respotSpot,
    opening, ballOn, resolve, foulText,
  };
})();

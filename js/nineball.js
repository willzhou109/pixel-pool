/* 9-ball rules for Pixel Pool.
 *
 * A pure rules module: it owns the rack layout, the "which ball is legal to hit"
 * question and the stroke verdict, and touches no scene, DOM or match state.
 * game.js feeds it what a stroke did and applies the outcome it hands back
 * (see resolveShotNine there), the same way js/banks.js is pure geometry for
 * the bot. Keeping it separate means 8-ball's resolution path is untouched.
 *
 * The rules implemented (WPA rotation, minus the push-out option):
 *   • Balls 1-9 only. The 8 is an ordinary ball here — 10-15 sit the game out.
 *   • The cue ball must strike the LOWEST-numbered ball on the table first.
 *   • After that contact, some ball must be pocketed or reach a cushion.
 *   • Pocketing any ball on a legal stroke keeps the table; order doesn't
 *     matter, so a carom that drops the 9 off the 3 wins on the spot.
 *   • Pocketing the 9 legally wins — including on the break.
 *   • Every foul is ball-in-hand anywhere for the opponent. Balls potted on a
 *     foul stay down, except the 9, which is spotted back onto the table.
 */
(function () {
  'use strict';

  // The object balls in play, in rotation order. The 8 is nothing special in
  // 9-ball; 10-15 are racked away by game.js (IDLE_BALLS).
  const OBJECT_BALLS = [1, 2, 3, 4, 5, 6, 7, 8, 9];
  const IDLE_BALLS = [10, 11, 12, 13, 14, 15];

  /* -------------------------------- rack --------------------------------- */

  // The nine-ball diamond: rows of 1-2-3-2-1 marching up the table from the
  // foot spot, 1-ball at the apex, 9-ball dead centre, the rest shuffled.
  // Spacing mirrors game.js's 8-ball rack (a hair over 2R, rows at d·√3/2) so
  // every neighbour just touches and the break transfers its energy cleanly.
  // Returns [{id, x, z}] in world units; the caller owns the balls themselves.
  function rack(geo) {
    const { PW, R, shuffle } = geo;
    const d = 2 * R * 1.0006, dx = d * Math.sqrt(3) / 2;
    const rest = shuffle([2, 3, 4, 5, 6, 7, 8]);
    const rows = [1, 2, 3, 2, 1];
    const out = [];
    for (let row = 0; row < rows.length; row++) {
      const n = rows[row];
      for (let i = 0; i < n; i++) {
        const id = row === 0 ? 1 : (row === 2 && i === 1) ? 9 : rest.pop();
        out.push({ id, x: PW / 2 + row * dx, z: (i - (n - 1) / 2) * d });
      }
    }
    return out;
  }

  // The foot spot, where an illegally pocketed 9 comes back. game.js nudges
  // this along the table if another ball is already sitting there.
  function spot(geo) { return { x: geo.PW / 2, z: 0 }; }

  /* ------------------------------- targeting ------------------------------ */

  // The ball that must be struck first: the lowest one still on the table.
  // `isDown(id)` reports whether a ball is pocketed — the caller decides which
  // moment that means (game.js passes a pre-stroke view when judging a shot,
  // and the live table when labelling the HUD). 0 = nothing left to shoot at.
  function lowest(isDown) {
    for (const id of OBJECT_BALLS) if (!isDown(id)) return id;
    return 0;
  }

  /* ------------------------------- verdict -------------------------------- */

  // Judge one settled stroke. `ev` is what the table did:
  //   potted   — object-ball ids pocketed this stroke (never the cue ball)
  //   scratch  — the cue ball found a pocket
  //   firstHit — first object ball the cue ball touched, or null for none
  //   cushion  — did any ball reach a cushion AFTER that first contact?
  //   target   — the lowest ball as it stood before the stroke (from lowest())
  // Returns the verdict; game.js turns it into toasts, turns and end screens.
  function resolve(ev) {
    const potted = ev.potted || [];
    const nineDown = potted.indexOf(9) >= 0;

    // Foul, in the order the rules test them: cue ball pocketed, then contact
    // legality, then the drive-to-rail requirement (which only applies once a
    // legal contact has happened at all).
    const foulKind =
      ev.scratch ? 'scratch'
        : ev.firstHit === null ? 'noContact'
          : ev.firstHit !== ev.target ? 'wrongBall'
            : (potted.length === 0 && !ev.cushion) ? 'noRail'
              : null;
    const foul = foulKind !== null;
    const spotNine = nineDown && foul; // comes back up; it isn't a pot

    return {
      foul, foulKind,
      win: nineDown && !foul,
      spotNine,
      keepTurn: !foul && potted.length > 0,
      // Every ball is the shooter's in 9-ball, so all of them count — except a
      // 9 that's being spotted back, which never actually stayed down.
      credited: potted.length - (spotNine ? 1 : 0),
    };
  }

  // Sentence describing a foul, for the ball-in-hand prompt. `target` is the
  // ball that should have been hit first.
  function foulText(kind, target) {
    switch (kind) {
      case 'scratch': return 'Scratch!';
      case 'noContact': return 'Foul — no contact!';
      case 'wrongBall': return `Foul — the ${target}-ball had to be hit first!`;
      case 'noRail': return 'Foul — no ball reached a rail!';
      default: return 'Foul!';
    }
  }

  window.PoolNineBall = {
    OBJECT_BALLS, IDLE_BALLS,
    rack, spot, lowest, resolve, foulText,
  };
})();

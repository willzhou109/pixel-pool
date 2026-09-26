/* Pocket and rail-opening geometry for Pixel Pool.
 *
 * A pocket is TWO different circles, and conflating them is what made the table
 * look wrong:
 *
 *   • the CAPTURE circle — game.js's POCKETS. Invisible, gameplay-tuned, and
 *     what js/physics.js, js/bot.js and the trained pot model are all fitted
 *     against. Nothing in here touches it.
 *   • the VISUAL circle — the hole you actually see. It has to read as a full
 *     circle cut clean through the cloth AND the wooden rail, and for the side
 *     pockets it has to stay entirely behind the cushion nose. A side pocket
 *     whose mouth bulges past the nose is a black smear lying on the playing
 *     surface, which is exactly what it looked like before.
 *
 * This module owns the second circle, plus the two flat outlines that let
 * buildTable() cut a real hole instead of painting a dark disc over the rail:
 *
 *   railOpening() — the rail plate's inner boundary: the rectangle behind the
 *                   cushions, with every pocket biting OUTWARD into the wood.
 *   bedOutline()  — the cloth's boundary: the same rectangle, with the same
 *                   pockets biting INWARD out of the felt.
 *
 * Both come out of one walk around that rectangle, so they share their crossing
 * points exactly: wood and cloth meet edge to edge around every pocket, with no
 * overlap to z-fight and no gap to see through.
 *
 * It is all plain 2D (x, z) arithmetic — no THREE, no scene, no DOM — so the
 * numbers can be checked in Node without a browser.
 */
(function (root, factory) {
  const api = factory();
  root.PoolPockets = api;                                    // browser
  if (typeof module === 'object' && module.exports) module.exports = api; // Node
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const TAU = Math.PI * 2;

  /* --------------------------- the visible holes -------------------------- */

  /* The six pocket mouths, in POCKETS index order (0-3 corners, then the two
     sides) — see game.js, where that order is load-bearing.

     t: { PH, R, SIDE_GAP, cushDepth, POCKETS } */
  function circles(t) {
    const { PH, R, SIDE_GAP, cushDepth, POCKETS } = t;

    /* Side pockets. Two conditions pin the circle down exactly:
         · tangent to the playing line z = ±PH, so the centre sits at PH + r
         · through the cushion's back corner (±SIDE_GAP, ±(PH + cushDepth)),
           where the rail's cut-out for the pocket actually begins
       Solving the pair for r gives the line below. The tangency is the
       load-bearing half: it is what tucks the whole mouth behind the cushion
       nose and under the rail, instead of letting it poke onto the cloth.
       Note r >= cushDepth always (AM-GM), so the centre is always past the back
       of the cushion and the bulk of the circle is genuinely in the woodwork. */
    const sr = (SIDE_GAP * SIDE_GAP + cushDepth * cushDepth) / (2 * cushDepth);

    /* Corner pockets get the SAME mouth as the sides, so a ball fills the same
       fraction of either and the two read as one set of pockets rather than two
       sizes. What is left is where to put it, and the sides answer that too:
       their tangency means a ball's leading edge is exactly on the rim at the
       instant the core catches it. Sliding the corner mouth out along the
       diagonal by `slide` puts it the same way round a ball —

           caught at POCKETS[i].r from the cup, so the leading edge sits at
           (POCKETS[i].r + slide - R) from the mouth's centre; set that to cr

       — which is what makes a corner pot look and time like a side pot. It also
       pulls the mouth clear of the cushion rectangle's corner, so it still
       genuinely breaks the rail line rather than hiding inside the cloth. */
    const cr = sr;
    const slide = (cr + R - POCKETS[0].r) / Math.SQRT2; // per axis, on the 45°

    const out = [];
    for (let i = 0; i < 4; i++) out.push({
      x: POCKETS[i].x + Math.sign(POCKETS[i].x) * slide,
      z: POCKETS[i].z + Math.sign(POCKETS[i].z) * slide,
      r: cr,
    });
    out.push({ x: 0, z: -(PH + sr), r: sr });
    out.push({ x: 0, z:  (PH + sr), r: sr });
    return out;
  }

  /* ------------------ rectangle combined with the circles ----------------- */

  /* The rail opening and the cloth are the same boolean run with opposite
     signs, so one walk produces both.

     The rectangle's perimeter is parameterised by t in [0, 4): the whole number
     picks the edge, the fraction the distance along it, counter-clockwise from
     the (+A, +B) corner. Each pocket circle crosses that perimeter exactly
     twice, and between the two crossings the straight edge is replaced by an
     arc — the outside arc for 'add' (the pocket eats into the wood), the inside
     one for 'cut' (it eats into the cloth). */
  function outline(A, B, cs, mode) {
    const P = [[A, B], [-A, B], [-A, -B], [A, -B]];
    const at = t => {
      const i = Math.floor(t) % 4, u = t - Math.floor(t);
      const a = P[i], b = P[(i + 1) % 4];
      return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u];
    };

    const spans = [];
    for (const c of cs) {
      const hits = [];
      for (let i = 0; i < 4; i++) {
        const a = P[i], b = P[(i + 1) % 4];
        const dx = b[0] - a[0], dz = b[1] - a[1];
        const fx = a[0] - c.x, fz = a[1] - c.z;
        const qa = dx * dx + dz * dz;
        const qb = 2 * (fx * dx + fz * dz);
        const qc = fx * fx + fz * fz - c.r * c.r;
        const disc = qb * qb - 4 * qa * qc;
        if (disc <= 0) continue;
        const s = Math.sqrt(disc);
        for (const u of [(-qb - s) / (2 * qa), (-qb + s) / (2 * qa)])
          if (u >= 0 && u < 1) hits.push(i + u);
      }
      // Two crossings is the only case a sane table produces. A circle that
      // misses the rectangle entirely, or swallows a whole side of it, means a
      // mis-tuned profile — leave it out rather than paper over it.
      if (hits.length !== 2) continue;
      hits.sort((p, q) => p - q);
      // Of the two arcs of perimeter between the crossings, the covered one is
      // whichever has its midpoint inside the circle.
      const mid = at((hits[0] + hits[1]) / 2);
      const fwd = Math.hypot(mid[0] - c.x, mid[1] - c.z) < c.r;
      const tIn = fwd ? hits[0] : hits[1], tOut = fwd ? hits[1] : hits[0];
      spans.push({ c, tIn, tOut, pIn: at(tIn), pOut: at(tOut) });
    }

    const nodes = [];
    for (let i = 0; i < 4; i++) nodes.push({ t: i, corner: P[i] });
    for (const s of spans) {
      nodes.push({ t: s.tIn, s, enter: true });
      nodes.push({ t: s.tOut, s });
    }
    nodes.sort((a, b) => a.t - b.t);

    // A span whose exit comes before its entry wraps past t = 0 — the corner
    // pockets all do, since they swallow the rectangle's corner — so the walk
    // starts already inside it. Its arc is emitted at that early exit node and
    // its entry point lands at the very end of the list, which is the same
    // thing once the ring closes.
    let open = spans.find(s => s.tIn > s.tOut) || null;
    const path = [], arcs = [];
    for (const n of nodes) {
      if (n.corner) { if (!open) path.push(n.corner); }
      else if (n.enter) { open = n.s; path.push(n.s.pIn); }
      else { arcs.push(sweepArc(path, n.s, mode)); path.push(n.s.pOut); open = null; }
    }
    return { path, arcs };
  }

  /* Walk one pocket's arc from where the perimeter entered the circle to where
     it leaves, appending the interior points to `path`. Returns the sweep too,
     so a rim can be drawn along the same stretch of the same circle. */
  function sweepArc(path, s, mode) {
    const c = s.c;
    const a0 = Math.atan2(s.pIn[1] - c.z, s.pIn[0] - c.x);
    const a1 = Math.atan2(s.pOut[1] - c.z, s.pOut[0] - c.x);
    let sweep = a1 - a0;
    // 'add' rounds outward, so the arc runs the same way as the walk (CCW);
    // 'cut' takes the complementary arc, back through the rectangle.
    if (mode === 'add') { while (sweep <= 0) sweep += TAU; }
    else { while (sweep >= 0) sweep -= TAU; }
    const n = Math.max(6, Math.ceil(Math.abs(sweep) / 0.12));
    for (let i = 1; i < n; i++) {
      const a = a0 + sweep * (i / n);
      path.push([c.x + c.r * Math.cos(a), c.z + c.r * Math.sin(a)]);
    }
    return { x: c.x, z: c.z, r: c.r, a0, sweep };
  }

  /* Inner edge of the rail: the rectangle with every pocket biting outward into
     the wood. `arcs` is the stretch of each pocket circle that lies in the
     wood, which is also the only stretch a rim can be fitted to — anything
     drawn on the cloth side of a side pocket would cross the cushion nose and
     end up lying on the playing surface, which is exactly what this whole
     module exists to prevent. */
  const railOpening = (A, B, cs) => outline(A, B, cs, 'add');

  /* Edge of the cloth: the same rectangle with the pockets bitten out of it. */
  const bedOutline = (A, B, cs) => outline(A, B, cs, 'cut').path;

  /* Outside edge of the rail, as a closed CCW point list. Real tables put a
     radius on the outer corners rather than a mitred point. */
  function outerFrame(A, B, rad) {
    // (corner-arc centre, angle the arc starts at), counter-clockwise from the
    // +x +z corner. Each quarter turn joins onto the next along a straight side.
    const quads = [
      [A - rad, B - rad, 0],
      [rad - A, B - rad, Math.PI / 2],
      [rad - A, rad - B, Math.PI],
      [A - rad, rad - B, -Math.PI / 2],
    ];
    const pts = [];
    for (const [cx, cz, a0] of quads)
      for (let i = 0; i <= 6; i++) {
        const a = a0 + (Math.PI / 2) * (i / 6);
        pts.push([cx + rad * Math.cos(a), cz + rad * Math.sin(a)]);
      }
    return pts;
  }

  /* Half the chord a pocket circle cuts on a line — z = `at` for axis 'z', x =
     `at` for axis 'x'. This is where a cushion's back edge has to end for its
     corner to sit on the rim: the jaws are drawn from that point. Zero when the
     line misses the circle. */
  function halfChord(c, axis, at) {
    const d = axis === 'z' ? at - c.z : at - c.x;
    return Math.sqrt(Math.max(0, c.r * c.r - d * d));
  }

  return { circles, railOpening, bedOutline, outerFrame, halfChord };
});

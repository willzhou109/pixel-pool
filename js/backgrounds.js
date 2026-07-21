/* Play-space backgrounds for Pixel Pool.
 *
 * A selectable environment surrounding the table — chosen on the setup screen
 * (#bgRow) and swappable live from the settings panel (#bgSwitch), exactly like
 * the table-style picker.
 *
 * CRITICAL: backgrounds are pure decoration. Every scenery mesh is built with
 * castShadow = false and no background adds/moves/removes a light, so switching
 * scenes never changes the lighting or shadows on the pool table. Only each
 * scene's ground plane sets receiveShadow, so the table's own cast shadow still
 * lands on the floor exactly as before. game.js hands us what we need through
 * window.PoolScene.
 */
(function () {
  'use strict';

  const S = window.PoolScene;
  if (!S) { console.warn('Backgrounds: PoolScene missing'); return; }
  const THREE = window.THREE;
  const { scene } = S;

  /* ------------------------------ helpers -------------------------------- */

  // Flat-shaded lit material (picks up the existing light rig, like the table).
  function sm(color, opts) {
    return new THREE.MeshStandardMaterial(Object.assign(
      { color, flatShading: true, roughness: 0.9, metalness: 0.0 }, opts));
  }
  // Unlit material for glowing / far-away things (screens, stars, the ocean),
  // independent of the scene lights so they read as self-luminous.
  function bmat(color, opts) {
    return new THREE.MeshBasicMaterial(Object.assign({ color, fog: false, side: THREE.DoubleSide }, opts));
  }
  // Any scenery mesh — never casts a shadow onto the table.
  function M(geo, material, x, y, z) {
    const m = new THREE.Mesh(geo, material);
    if (x !== undefined) m.position.set(x, y, z);
    m.castShadow = false;
    m.receiveShadow = false;
    return m;
  }
  function bx(w, h, d, color, opts) { return M(new THREE.BoxGeometry(w, h, d), sm(color, opts)); }
  // Put a mesh at a position (and optional Y-rotation) into a parent, chainably.
  function put(parent, m, x, y, z, ry) {
    m.position.set(x || 0, y || 0, z || 0);
    if (ry) m.rotation.y = ry;
    parent.add(m);
    return m;
  }
  // Ground plane that receives the table's shadow, so shadows look unchanged.
  function ground(color, opts) {
    const g = M(new THREE.PlaneGeometry(80, 80), sm(color, opts), 0, 0, 0);
    g.rotation.x = -Math.PI / 2;
    g.receiveShadow = true;
    return g;
  }

  /* ============================ OUTER SPACE ============================== */

  function buildSpace() {
    const g = new THREE.Group();

    // No floor — the table floats free in space. Its own felt / rail / ball
    // shadows still render on the table itself; there is simply no ground plane
    // to catch a cast shadow, which is exactly the floating look we want.

    // Full-sphere starfield wrapping the scene in every direction.
    const N = 1500, pos = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
      const r = 34 + Math.random() * 18;
      const th = Math.random() * Math.PI * 2;
      const ph = Math.acos(2 * Math.random() - 1);
      pos[i * 3]     = r * Math.sin(ph) * Math.cos(th);
      pos[i * 3 + 1] = r * Math.cos(ph);
      pos[i * 3 + 2] = r * Math.sin(ph) * Math.sin(th);
    }
    const starGeo = new THREE.BufferGeometry();
    starGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const stars = new THREE.Points(starGeo, new THREE.PointsMaterial({ color: '#ffffff', size: 0.18, sizeAttenuation: true, fog: false }));
    stars.castShadow = false;
    g.add(stars);

    // Planets — unlit + a touch of emissive so both hemispheres stay visible.
    function planet(x, y, z, r, color, ringColor) {
      g.add(M(new THREE.SphereGeometry(r, 14, 12), sm(color, { emissive: color, emissiveIntensity: 0.4 }), x, y, z));
      if (ringColor) {
        const rg = M(new THREE.TorusGeometry(r * 1.8, r * 0.16, 2, 28), bmat(ringColor), x, y, z);
        rg.rotation.x = Math.PI / 2.2; rg.rotation.z = 0.35;
        g.add(rg);
      }
    }
    planet(-16, 9, -15, 2.7, '#c87a45', '#e8c48a');   // ringed gas giant
    planet(15, 12, -18, 3.6, '#3f6fb0');              // distant blue world
    planet(18, -6, 8, 3.0, '#4a8f6a');                // green world, below the horizon
    planet(-14, -9, 11, 2.2, '#9c6fb0');              // purple world, underfoot
    planet(9, 5.5, 16, 1.3, '#b6553f');               // small red moon
    planet(-11, 6, 14, 0.8, '#8f9bb0');               // grey moon
    planet(3, -15, -7, 1.7, '#c9a24a');               // amber moon far below
    planet(-6, 15, 9, 1.0, '#d0d6e2');                // pale moon overhead

    // A crescent "sun" glow far off.
    g.add(M(new THREE.SphereGeometry(1.1, 16, 12), bmat('#fff0c0'), 20, 16, 6));

    // Low-poly asteroids drifting nearby.
    function asteroid(x, y, z, r) {
      const a = M(new THREE.IcosahedronGeometry(r, 0), sm('#6a6f7d', { flatShading: true }), x, y, z);
      a.rotation.set(Math.random() * 3, Math.random() * 3, Math.random() * 3);
      g.add(a);
    }
    asteroid(-6, 3.4, -5, 0.35);
    asteroid(6.5, 4.2, -4, 0.5);
    asteroid(-5.5, -3, 5.5, 0.28);
    asteroid(4, -5, -3, 0.4);
    asteroid(-8, -6.5, -6, 0.55);

    // Spaceships — small low-poly craft with glowing cockpits and engines.
    function ship(x, y, z, scale, ry) {
      const s = new THREE.Group();
      put(s, bx(0.95, 0.22, 0.34, '#9aa6bd', { metalness: 0.6, roughness: 0.4 }), 0, 0, 0);
      const nose = M(new THREE.ConeGeometry(0.17, 0.5, 4), sm('#c6cfe0', { metalness: 0.6 }), 0.62, 0, 0);
      nose.rotation.z = -Math.PI / 2; s.add(nose);
      put(s, M(new THREE.SphereGeometry(0.12, 10, 8), bmat('#7ae6ff'), 0.2, 0.11, 0));   // cockpit
      put(s, bx(0.34, 0.04, 0.95, '#7f8aa0'), -0.12, 0, 0);                              // wings
      put(s, bx(0.05, 0.24, 0.05, '#8f9ab0'), -0.1, 0.16, 0);                            // tail fin
      put(s, M(new THREE.BoxGeometry(0.1, 0.16, 0.24), bmat('#ff9b3d'), -0.52, 0, 0));   // engine glow
      s.scale.setScalar(scale);
      s.traverse(o => { o.castShadow = false; });
      put(g, s, x, y, z, ry);
    }
    ship(-4.5, 4.2, -3, 1.0, 0.5);
    ship(5.5, 5.6, 1.5, 1.4, -2.1);
    ship(1.5, 6.8, -7, 0.8, 1.2);
    ship(-5, -4, 3, 1.1, -0.8);
    ship(4.5, -3.5, 5, 0.9, 2.4);

    return g;
  }

  /* ============================ CRUISE SHIP ============================= */

  function buildCruise() {
    const g = new THREE.Group();

    // Room half-extents and height, sized well past the camera's max orbit reach
    // (~5.5 out, ~6.2 up) so you can never zoom outside the walls or ceiling.
    const WX = 7.0, WZ = 6.6, CEIL = 6.6, WIN_TOP = 2.6;
    const wallC = '#c9b89b', wallDark = '#b09a78', trimC = '#efe7d4';

    // Warm wood-plank floor (receives the table's shadow) + plank seams + rug.
    g.add(ground('#6d4c30', { roughness: 1 }));
    for (let i = -8; i <= 8; i++) put(g, M(new THREE.BoxGeometry(2 * WX, 0.004, 0.03), sm('#573b25'), 0, 0.012, 0), 0, 0.012, i * 0.82);
    const rug = M(new THREE.CircleGeometry(2.4, 24), sm('#355a72', { roughness: 1 }), 0, 0.02, 0);
    rug.rotation.x = -Math.PI / 2; rug.receiveShadow = true; g.add(rug);

    // Ceiling (down-facing) with recessed light panels — encloses the room without
    // shadowing the table (castShadow is off, so it blocks no sunlight).
    const ceil = M(new THREE.PlaneGeometry(2 * WX, 2 * WZ), sm('#d8cbb2'), 0, CEIL, 0);
    ceil.rotation.x = Math.PI / 2; g.add(ceil);
    for (const cx of [-4, 0, 4]) put(g, M(new THREE.PlaneGeometry(1.6, 1.2), bmat('#fff6df'), cx, CEIL - 0.01, 0), cx, CEIL - 0.01, 0).rotation.x = Math.PI / 2;

    // -------- ocean view, behind the long +Z window --------
    // Bright, unlit backdrop planes so daylight reads regardless of interior light.
    put(g, M(new THREE.PlaneGeometry(60, 30), bmat('#8fd2f2'), 0, 8, 18), 0, 8, 18);         // sky
    put(g, M(new THREE.PlaneGeometry(60, 9), bmat('#1f74ab'), 0, -2.8, 17.4), 0, -2.8, 17.4); // sea (top edge = horizon y≈1.3)
    for (const wz of [15.5, 14.2, 13]) put(g, M(new THREE.PlaneGeometry(60, 0.06), bmat('#4f9ecb'), 0, 1.0 + (17 - wz) * 0.03, wz), 0, 1.0 + (17 - wz) * 0.03, wz); // wave streaks
    put(g, M(new THREE.CircleGeometry(1.3, 20), bmat('#fff4c4'), -8, 6.5, 17), -8, 6.5, 17);   // sun
    // fluffy clouds
    for (const c of [[6, 6.5, -1.8], [11, 7.4, 2.2], [-13, 5.6, 0]]) {
      const [cx, cy, cs] = c;
      put(g, M(new THREE.SphereGeometry(1.0 + cs * 0.1, 8, 6), bmat('#ffffff'), cx, cy, 16.5), cx, cy, 16.5);
      put(g, M(new THREE.SphereGeometry(0.7, 8, 6), bmat('#f2f7fb'), cx + 1.1, cy - 0.2, 16.5), cx + 1.1, cy - 0.2, 16.5);
    }
    // tropical islands sitting on the horizon, with little palm trees
    function island(x, z, r) {
      put(g, M(new THREE.SphereGeometry(r, 10, 6), bmat('#e8d59a'), x, 1.3, z), x, 1.3, z).scale.set(1, 0.35, 1);  // sandy hump
      for (let t = 0; t < 2; t++) {
        const px = x + (t ? r * 0.6 : -r * 0.5);
        put(g, M(new THREE.CylinderGeometry(0.05, 0.07, r * 1.6, 5), bmat('#7a5230'), px, 1.3 + r * 0.8, z), px, 1.3 + r * 0.8, z);
        for (let f = 0; f < 5; f++) {
          const fr = M(new THREE.ConeGeometry(0.12, r * 0.9, 4), bmat('#2f8f47'), px, 1.3 + r * 1.6, z);
          fr.rotation.z = Math.PI / 2.4; fr.rotation.y = (f / 5) * Math.PI * 2;
          g.add(fr);
        }
      }
    }
    island(-3, 12.5, 1.4);
    island(4.5, 14, 1.9);

    // -------- walls --------
    // +Z long wall = a window band: wainscot below, glass with mullions, and a
    // solid wall above it up to the ceiling.
    put(g, bx(2 * WX, 0.9, 0.16, wallDark), 0, 0.45, WZ);                              // wainscot (0..0.9)
    put(g, bx(2 * WX, CEIL - WIN_TOP, 0.16, wallC), 0, (CEIL + WIN_TOP) / 2, WZ);      // wall above the window
    put(g, bx(0.16, WIN_TOP - 0.9, 0.18, trimC), -WX + 0.08, (WIN_TOP + 0.9) / 2, WZ); // left post
    put(g, bx(0.16, WIN_TOP - 0.9, 0.18, trimC), WX - 0.08, (WIN_TOP + 0.9) / 2, WZ);  // right post
    for (let mx = -WX + 1.4; mx < WX - 0.5; mx += 1.4) put(g, bx(0.09, WIN_TOP - 1.0, 0.14, trimC), mx, (WIN_TOP + 0.9) / 2, WZ);  // mullions
    put(g, bx(2 * WX, 0.1, 0.14, trimC), 0, 0.9, WZ);                                  // sill cap
    put(g, bx(2 * WX, 0.1, 0.14, trimC), 0, WIN_TOP, WZ);                              // header cap

    // The other three walls, solid, full height.
    put(g, bx(2 * WX, CEIL, 0.16, wallC), 0, CEIL / 2, -WZ);              // back (-Z)
    put(g, bx(0.16, CEIL, 2 * WZ, wallC), -WX, CEIL / 2, 0);             // left (-X)
    put(g, bx(0.16, CEIL, 2 * WZ, wallC), WX, CEIL / 2, 0);             // right (+X)
    // dado rail + baseboard trim on the solid walls
    for (const [w, h, d, x, z] of [[2 * WX, 0.06, 0.18, 0, -WZ], [0.18, 0.06, 2 * WZ, -WX, 0], [0.18, 0.06, 2 * WZ, WX, 0]])
      put(g, bx(w, h, d, trimC), x, 1.0, z);

    // -------- door to the deck (set into the -X wall), solid wood --------
    const door = new THREE.Group();
    put(door, bx(0.14, 2.25, 1.25, trimC), 0, 1.12, 0);                                          // frame
    put(door, bx(0.06, 2.0, 1.0, '#7a5230'), 0.06, 1.05, 0);                                     // door panel (one consistent colour)
    put(door, M(new THREE.CircleGeometry(0.17, 16), bmat('#bfe6f2'), 0, 0, 0), 0.1, 1.55, 0).rotation.y = Math.PI / 2;   // porthole glass
    put(door, M(new THREE.TorusGeometry(0.17, 0.03, 6, 16), sm('#caa94a', { metalness: 0.5 }), 0, 0, 0), 0.1, 1.55, 0).rotation.y = Math.PI / 2;  // porthole ring
    put(door, bx(0.06, 0.12, 0.1, '#d9b24a'), 0.11, 0.95, 0.34);                                 // handle
    put(g, door, -WX + 0.02, 0, -1.6);                                                           // flush in the -X wall

    // -------- vending machine (against the -Z wall) --------
    const vend = new THREE.Group();
    put(vend, bx(0.75, 1.8, 0.5, '#2f3b55'), 0, 0.9, 0);
    put(vend, M(new THREE.PlaneGeometry(0.56, 1.2), bmat('#57e0d0'), 0, 1.15, 0), 0, 1.15, 0.26);   // lit glass
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++)                                          // snack rows
      put(vend, bx(0.12, 0.1, 0.02, ['#e2483c', '#f2c00e', '#3fa9e0', '#7bd151'][(r + c) % 4]), -0.18 + c * 0.18, 1.55 - r * 0.32, 0.27);
    put(vend, bx(0.5, 0.16, 0.04, '#12161f'), 0, 0.4, 0.26);                                         // delivery slot
    put(vend, bx(0.2, 0.5, 0.04, '#1a2233'), 0.24, 1.15, 0.27);                                      // keypad column
    put(g, vend, 2.2, 0, -WZ + 0.3);

    // -------- foosball table (on the -X side) --------
    const foos = new THREE.Group();
    put(foos, bx(1.1, 0.08, 0.64, '#1f7a3f'), 0, 0.62, 0);          // green playfield
    for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]])    // legs
      put(foos, bx(0.07, 0.62, 0.07, '#3a2a1a'), sx * 0.5, 0.31, sz * 0.28);
    for (const sx of [-1, 1]) put(foos, bx(0.06, 0.16, 0.7, '#151a24'), sx * 0.57, 0.66, 0);  // end rails
    for (let r = 0; r < 4; r++) {                                   // rods with players
      const rx = -0.42 + r * 0.28;
      put(foos, M(new THREE.CylinderGeometry(0.015, 0.015, 0.78, 6), sm('#c9cdd6', { metalness: 0.7 }), rx, 0.72, 0), rx, 0.72, 0).rotation.x = Math.PI / 2;
      for (let p = -1; p <= 1; p++) put(foos, bx(0.05, 0.12, 0.05, r % 2 ? '#d83b3b' : '#2f6fd8'), rx, 0.68, p * 0.2);
    }
    put(g, foos, -4.6, 0, 2.6, 0.3);

    // -------- grand piano (on the +X side) --------
    const piano = new THREE.Group();
    const body = '#0d0f14';
    put(piano, bx(1.0, 0.24, 1.25, body, { roughness: 0.35, metalness: 0.2 }), 0, 0.78, 0);   // case
    put(piano, M(new THREE.CylinderGeometry(0.62, 0.62, 0.24, 20, 1, false, -Math.PI / 2, Math.PI), sm(body, { roughness: 0.35, metalness: 0.2 }), 0, 0.78, 0.62), 0, 0.78, 0.62); // curved tail
    for (const [lx, lz] of [[-0.42, -0.55], [0.42, -0.55], [0, 0.7]]) put(piano, bx(0.07, 0.78, 0.07, body), lx, 0.39, lz);  // legs
    put(piano, bx(1.0, 0.26, 0.3, body, { roughness: 0.35, metalness: 0.2 }), 0, 0.66, -0.68);   // key-bed beneath the keys
    put(piano, bx(0.98, 0.06, 0.24, '#f4efe6'), 0, 0.78, -0.72);                                  // white keys (mid-height of the case)
    for (let k = -6; k <= 6; k++) put(piano, bx(0.03, 0.05, 0.14, '#101014'), k * 0.07, 0.82, -0.74);  // black keys
    const lid = M(new THREE.BoxGeometry(1.02, 0.03, 1.2), sm(body, { roughness: 0.3, metalness: 0.3 }), 0, 1.15, 0.05);
    lid.rotation.x = -0.5; piano.add(lid);                                                     // raised lid
    put(piano, M(new THREE.CylinderGeometry(0.015, 0.015, 0.55, 6), sm('#caa94a', { metalness: 0.6 }), 0.35, 1.15, -0.35), 0.35, 1.15, -0.35).rotation.z = 0.25; // prop stick
    put(piano, bx(0.5, 0.32, 0.28, '#4a2f1c'), 0, 0.24, -1.05);                                 // bench
    put(g, piano, 4.3, 0, -2.4, -0.55);

    // -------- artistic extras: potted palm + life ring on the wall --------
    const palm = new THREE.Group();
    put(palm, M(new THREE.CylinderGeometry(0.18, 0.24, 0.32, 8), sm('#b5532e'), 0, 0.16, 0), 0, 0.16, 0);
    put(palm, M(new THREE.CylinderGeometry(0.05, 0.08, 1.2, 6), sm('#7a5230'), 0, 0.9, 0), 0, 0.9, 0);
    for (let f = 0; f < 6; f++) {
      const fr = M(new THREE.ConeGeometry(0.16, 1.0, 4), sm('#2f8f47', { flatShading: true }), 0, 1.5, 0);
      fr.rotation.z = Math.PI / 2.6; fr.rotation.y = (f / 6) * Math.PI * 2;
      palm.add(fr);
    }
    put(g, palm, -WX + 0.6, 0, WZ - 0.6);

    const ringGrp = new THREE.Group();
    put(ringGrp, M(new THREE.TorusGeometry(0.32, 0.11, 8, 20), sm('#e2483c')), 0, 0, 0);                 // red base
    for (const q of [0, 2]) put(ringGrp, M(new THREE.TorusGeometry(0.325, 0.113, 8, 6, Math.PI / 2), sm('#f4efe6')), 0, 0, 0.002).rotation.z = q * Math.PI / 2;  // white quarters
    put(g, ringGrp, 0, 2.0, -WZ + 0.12);

    return g;
  }

  /* ============================ ROOFTOP NIGHT =========================== */

  function buildRooftop() {
    const g = new THREE.Group();

    const RX = 4.6, RZ = 4.0;   // rooftop half-extents

    // Bounded rooftop deck (receives the table's shadow), kept to the roof's own
    // footprint so beyond the parapet you see open night sky — not a lit ground
    // plane stretching out to a grey horizon.
    const deck = M(new THREE.PlaneGeometry(2 * RX + 0.4, 2 * RZ + 0.4), sm('#20242e', { roughness: 1 }), 0, 0, 0);
    deck.rotation.x = -Math.PI / 2; deck.receiveShadow = true; g.add(deck);
    for (let i = -4; i <= 4; i++) put(g, M(new THREE.BoxGeometry(2 * RX, 0.004, 0.03), sm('#191c24'), 0, 0, 0), 0, 0.012, i * 0.9);
    const mat = M(new THREE.CircleGeometry(2.3, 24), sm('#243040', { roughness: 1 }), 0, 0.02, 0);
    mat.rotation.x = -Math.PI / 2; mat.receiveShadow = true; g.add(mat);

    // Low parapet wall ringing the roof edge, with a lighter coping cap.
    const pC = '#2c3038', capC = '#3a3f49';
    for (const zs of [-1, 1]) {
      put(g, bx(2 * RX + 0.3, 0.5, 0.16, pC), 0, 0.25, zs * RZ);
      put(g, bx(2 * RX + 0.3, 0.06, 0.22, capC), 0, 0.52, zs * RZ);
    }
    for (const xs of [-1, 1]) {
      put(g, bx(0.16, 0.5, 2 * RZ, pC), xs * RX, 0.25, 0);
      put(g, bx(0.22, 0.06, 2 * RZ + 0.22, capC), xs * RX, 0.52, 0);
    }

    // Distant skyline — dark blocks whose window grids face the table. The bodies
    // are lit/fogged so they recede; the lit windows glow through unfogged.
    const winLit = bmat('#ffd98a'), winOff = bmat('#39414f');
    const BASEY = -13;   // buildings drop far below the roofline, like a city seen from above
    function building(x, z, w, h, d) {
      const b = new THREE.Group();
      const bodyH = h - BASEY;
      put(b, bx(w, bodyH, d, '#12161f', { roughness: 1 }), 0, (h + BASEY) / 2, 0);
      const cols = Math.max(2, Math.round(w / 0.85));
      const rows = Math.max(4, Math.round(bodyH / 1.3));
      const top = h - 0.4, bot = BASEY + 0.4;                    // windows span the full drop to the ground
      for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
        if (Math.random() < 0.45) continue;                      // gaps between lit windows
        const win = M(new THREE.PlaneGeometry(0.18, 0.28), Math.random() < 0.6 ? winLit : winOff,
          -w / 2 + 0.3 + c * (w - 0.6) / Math.max(1, cols - 1),
          bot + r * (top - bot) / Math.max(1, rows - 1),
          d / 2 + 0.01);
        b.add(win);
      }
      b.position.set(x, 0, z);
      b.rotation.y = Math.atan2(-x, -z);                         // window face toward the table
      b.traverse(o => { o.castShadow = false; });
      g.add(b);
    }
    for (const [x, z, w, h, d] of [
      [-13, -16, 5, 9, 5], [-4, -21, 6, 12, 5], [7, -18, 5, 7, 6], [16, -12, 6, 14, 6],
      [20, 2, 5, 9, 6], [16, 13, 6, 11, 6], [5, 20, 6, 8, 6], [-8, 21, 5, 13, 5],
      [-17, 12, 6, 10, 6], [-21, 0, 5, 15, 5],
    ]) building(x, z, w, h, d);

    // A calm moon low on the horizon.
    g.add(M(new THREE.SphereGeometry(1.4, 18, 14), bmat('#f2f2e0'), -15, 11, -11));

    // Corner poles strung with sagging warm bulbs, overhead.
    for (const [px, pz] of [[-RX + 0.2, -RZ + 0.2], [RX - 0.2, -RZ + 0.2], [RX - 0.2, RZ - 0.2], [-RX + 0.2, RZ - 0.2]])
      put(g, bx(0.08, 2.6, 0.08, '#2a2e37'), px, 1.3, pz);
    function stringLights(x0, z0, x1, z1, y, sag, n) {
      for (let i = 0; i <= n; i++) {
        const t = i / n, sy = y - Math.sin(t * Math.PI) * sag;
        put(g, M(new THREE.SphereGeometry(0.05, 6, 5), bmat('#ffdf9c'), 0, 0, 0), x0 + (x1 - x0) * t, sy, z0 + (z1 - z0) * t);
      }
    }
    stringLights(-RX + 0.2, -RZ + 0.2, RX - 0.2, -RZ + 0.2, 2.5, 0.5, 10);
    stringLights(RX - 0.2, RZ - 0.2, -RX + 0.2, RZ - 0.2, 2.5, 0.5, 10);
    stringLights(-RX + 0.2, -RZ + 0.2, -RX + 0.2, RZ - 0.2, 2.5, 0.5, 9);
    stringLights(RX - 0.2, -RZ + 0.2, RX - 0.2, RZ - 0.2, 2.5, 0.5, 9);

    // A rooftop AC unit and a potted plant for character.
    const ac = new THREE.Group();
    put(ac, bx(0.7, 0.5, 0.7, '#4a4f59', { metalness: 0.3, roughness: 0.7 }), 0, 0.25, 0);
    put(ac, M(new THREE.CylinderGeometry(0.22, 0.22, 0.06, 12), sm('#2c3038'), 0, 0, 0), 0, 0.53, 0);
    put(g, ac, RX - 1.0, 0, -RZ + 1.0);

    const plant = new THREE.Group();
    put(plant, M(new THREE.CylinderGeometry(0.16, 0.2, 0.34, 8), sm('#6a4a34'), 0, 0, 0), 0, 0.17, 0);
    for (let f = 0; f < 6; f++) {
      const fr = M(new THREE.ConeGeometry(0.14, 0.8, 4), sm('#2f6f3f', { flatShading: true }), 0, 0.7, 0);
      fr.rotation.z = Math.PI / 2.6; fr.rotation.y = (f / 6) * Math.PI * 2;
      plant.add(fr);
    }
    put(g, plant, -RX + 0.7, 0, RZ - 0.7);

    return g;
  }

  /* =========================== SAHARA DESERT ============================ */

  function buildSahara() {
    const g = new THREE.Group();

    // Flat sand to the horizon — the hazy fog blends it softly into the sky.
    g.add(ground('#dcc084', { roughness: 1 }));

    // Distant low dune swells for a little horizon profile (kept far + subtle so
    // the play area still reads as flat sand).
    function dune(x, z, r, c) {
      const d = M(new THREE.SphereGeometry(r, 12, 8), sm(c, { roughness: 1 }), x, 0, z);
      d.scale.set(1, 0.14, 1); g.add(d);
    }
    dune(-20, -14, 9, '#d3b678');
    dune(22, -10, 11, '#d8bc80');
    dune(-14, 20, 8, '#d3b678');
    dune(16, 22, 10, '#cdb072');
    dune(0, -26, 14, '#d8bc80');

    // Bright sun with a soft halo, high and a little behind.
    g.add(M(new THREE.SphereGeometry(1.7, 20, 16), bmat('#fff7d6'), -10, 15, -22));
    g.add(M(new THREE.SphereGeometry(2.7, 20, 16), bmat('#fdeeb0', { transparent: true, opacity: 0.3 }), -10, 15, -22));

    // A few saguaro cacti.
    function cactus(x, z, s) {
      const c = new THREE.Group();
      const green = sm('#3f7d43', { flatShading: true });
      c.add(M(new THREE.CylinderGeometry(0.16, 0.2, 1.7, 8), green, 0, 0.85, 0));      // trunk
      put(c, M(new THREE.SphereGeometry(0.16, 8, 6), green, 0, 0, 0), 0, 1.7, 0);      // rounded top
      function arm(side, y) {
        const a = new THREE.Group();
        const horiz = M(new THREE.CylinderGeometry(0.1, 0.11, 0.42, 8), green, side * 0.28, 0, 0);
        horiz.rotation.z = Math.PI / 2;
        a.add(horiz);
        put(a, M(new THREE.CylinderGeometry(0.1, 0.11, 0.55, 8), green, 0, 0, 0), side * 0.48, 0.32, 0);  // upturn
        put(a, M(new THREE.SphereGeometry(0.1, 8, 6), green, 0, 0, 0), side * 0.48, 0.6, 0);              // tip
        a.position.y = y; c.add(a);
      }
      arm(1, 0.75); arm(-1, 1.05);
      c.scale.setScalar(s);
      c.traverse(o => { o.castShadow = false; });
      put(g, c, x, 0, z);
    }
    cactus(-5, 3.5, 1.0);
    cactus(6, 2, 1.3);
    cactus(4.5, -5, 0.9);
    cactus(-7, -4, 1.1);

    // Scattered desert rocks.
    function rock(x, z, r) {
      const k = M(new THREE.IcosahedronGeometry(r, 0), sm('#b39a6a', { flatShading: true }), x, r * 0.4, z);
      k.rotation.set(Math.random() * 3, Math.random() * 3, Math.random() * 3);
      k.scale.y = 0.6; g.add(k);
    }
    rock(3, 4, 0.3); rock(-4.5, 5.5, 0.25); rock(7, -2.5, 0.35);

    return g;
  }

  /* =========================== CLASSIC POOL HALL ======================== */

  function buildPoolHall() {
    const g = new THREE.Group();

    // Room is sized well beyond the camera's reach (orbit radius maxes at 5.5, so
    // horizontal reach ~5.5 and height ~6.2) so you can't zoom outside the walls.
    const WX = 7.0, WZ = 6.6, CEIL = 6.6;
    const wallC = '#20402e', woodC = '#4a3320', trimC = '#3a2a1a';

    // Dim wood-plank floor + a burgundy rug under the table.
    g.add(ground(woodC, { roughness: 1 }));
    for (let i = -8; i <= 8; i++) put(g, M(new THREE.BoxGeometry(2 * WX, 0.004, 0.03), sm('#3c2917'), 0, 0, 0), 0, 0.012, i * 0.8);
    const rug = M(new THREE.CircleGeometry(2.5, 28), sm('#5a2530', { roughness: 1 }), 0, 0.02, 0);
    rug.rotation.x = -Math.PI / 2; rug.receiveShadow = true; g.add(rug);
    const rugRing = M(new THREE.RingGeometry(2.2, 2.45, 28), sm('#7a3a44'), 0, 0.021, 0);
    rugRing.rotation.x = -Math.PI / 2; g.add(rugRing);

    // Dark green walls with wood wainscot + chair rail, and a warm dim ceiling.
    for (const zs of [-1, 1]) {
      put(g, bx(2 * WX, CEIL, 0.2, wallC), 0, CEIL / 2, zs * WZ);
      put(g, bx(2 * WX, 0.9, 0.22, woodC), 0, 0.45, zs * WZ);
      put(g, bx(2 * WX, 0.08, 0.24, trimC), 0, 0.92, zs * WZ);
    }
    for (const xs of [-1, 1]) {
      put(g, bx(0.2, CEIL, 2 * WZ, wallC), xs * WX, CEIL / 2, 0);
      put(g, bx(0.22, 0.9, 2 * WZ, woodC), xs * WX, 0.45, 0);
      put(g, bx(0.24, 0.08, 2 * WZ, trimC), xs * WX, 0.92, 0);
    }
    const ceil = M(new THREE.PlaneGeometry(2 * WX, 2 * WZ), sm('#241a10'), 0, CEIL, 0);
    ceil.rotation.x = Math.PI / 2; g.add(ceil);

    // Framed pictures (lit, so they stay dim and unobtrusive).
    function picture(x, y, z, ry, w, h, art) {
      const p = new THREE.Group();
      put(p, bx(w + 0.12, h + 0.12, 0.06, '#5a4326'), 0, 0, 0);            // frame
      put(p, bx(w, h, 0.02, '#c9a25a'), 0, 0, 0.04);                       // mount
      put(p, M(new THREE.PlaneGeometry(w - 0.14, h - 0.14), sm(art), 0, 0, 0), 0, 0, 0.055);  // art
      put(g, p, x, y, z, ry);
    }
    picture(-2.4, 2.6, -WZ + 0.11, 0, 1.0, 0.7, '#355a7a');
    picture(2.4, 2.5, -WZ + 0.11, 0, 0.8, 1.0, '#6a4030');
    picture(-WX + 0.11, 2.7, 1.6, Math.PI / 2, 1.1, 0.75, '#3a5a3a');

    // Round wall clock on the +Z wall.
    const clock = new THREE.Group();
    const disc = M(new THREE.CylinderGeometry(0.42, 0.42, 0.06, 20), sm('#2a1c10'), 0, 0, 0);
    disc.rotation.x = Math.PI / 2; clock.add(disc);
    put(clock, M(new THREE.CircleGeometry(0.36, 20), sm('#f2ead2'), 0, 0, 0.035), 0, 0, 0.035);
    put(clock, bx(0.03, 0.26, 0.015, '#20140a'), 0, 0.06, 0.06);
    put(clock, bx(0.02, 0.34, 0.015, '#20140a'), 0.08, 0.0, 0.06).rotation.z = -1.1;
    clock.position.set(-2.6, 3.2, WZ - 0.12); clock.rotation.y = Math.PI; g.add(clock);

    // Hanging Tiffany-style lamp over the table (decorative — adds no real light).
    const lamp = new THREE.Group();
    put(lamp, bx(0.02, CEIL - 2.6, 0.02, '#1a140c'), 0, (CEIL + 2.6) / 2, 0);   // cord to ceiling
    const shade = new THREE.Group();
    const band = (rt, rb, h, y, color) => shade.add(M(new THREE.CylinderGeometry(rt, rb, h, 12, 1, true),
      sm(color, { emissive: color, emissiveIntensity: 0.3, side: THREE.DoubleSide, flatShading: true }), 0, y, 0));
    band(0.1, 0.3, 0.2, 0.2, '#d98a2b');    // amber top
    band(0.3, 0.48, 0.16, 0.02, '#c23f30'); // red middle
    band(0.48, 0.6, 0.12, -0.12, '#2f7a4a'); // green rim
    put(shade, M(new THREE.CylinderGeometry(0.08, 0.1, 0.06, 10), sm('#2a1c10'), 0, 0, 0), 0, 0.32, 0);  // cap
    shade.position.y = 2.4; lamp.add(shade);
    put(lamp, M(new THREE.SphereGeometry(0.11, 8, 6), bmat('#fff2c0'), 0, 0, 0), 0, 2.24, 0);  // glowing bulb
    g.add(lamp);

    return g;
  }

  /* ------------------------------ registry ------------------------------- */

  const BACKGROUNDS = [
    { name: 'Pool Hall',     sky: '#141810', fog: null,                build: buildPoolHall },
    { name: 'Cruise Ship',   sky: '#8fd2f2', fog: ['#a9d9f0', 16, 40], build: buildCruise },
    { name: 'Outer Space',   sky: '#05060e', fog: null,                build: buildSpace },
    { name: 'Rooftop Night', sky: '#0a0e1a', fog: ['#0a0e1a', 18, 46], build: buildRooftop },
    { name: 'Sahara Desert', sky: '#79c4e6', fog: ['#cfe1e6', 24, 72], build: buildSahara },
  ];

  let current = 0;
  let group = null;
  let changeCb = null;   // notified on user-driven changes (for online sync)

  function dispose(gr) {
    gr.traverse(o => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => m.dispose());
    });
  }

  // fromNet: true when applied from an opponent's sync message — suppresses the
  // change callback so it isn't echoed back over the network.
  function apply(i, announce, fromNet) {
    current = ((i % BACKGROUNDS.length) + BACKGROUNDS.length) % BACKGROUNDS.length;
    const B = BACKGROUNDS[current];
    if (group) { scene.remove(group); dispose(group); }
    group = B.build();
    scene.add(group);
    S.setSky(B.sky);
    if (B.fog) S.setFog(B.fog[0], B.fog[1], B.fog[2]); else S.clearFog();

    const nameEl = document.getElementById('bgName');
    if (nameEl) nameEl.textContent = B.name.toUpperCase();
    const row = document.getElementById('bgRow');
    if (row) Array.from(row.children).forEach((c, idx) => c.classList.toggle('sel', idx === current));
    if (announce) S.toast(`Background: ${B.name}`);
    if (!fromNet && changeCb) changeCb(current);
  }

  /* --------------------------------- UI ---------------------------------- */

  const row = document.getElementById('bgRow');
  if (row) {
    row.innerHTML = '';
    BACKGROUNDS.forEach((B, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'hatBtn' + (i === current ? ' sel' : '');
      b.textContent = B.name.toUpperCase();
      b.addEventListener('click', () => apply(i, false));
      row.appendChild(b);
    });
  }
  const prev = document.getElementById('bgPrev');
  const next = document.getElementById('bgNext');
  if (prev) prev.addEventListener('click', () => apply(current - 1, true));
  if (next) next.addEventListener('click', () => apply(current + 1, true));

  apply(0, false);   // establish the default environment on load

  // Small surface for online sync (js/game.js): read/set the scene and be
  // notified of user-driven changes.
  window.PoolBackgrounds = {
    apply,
    current: () => current,
    count: () => BACKGROUNDS.length,
    setOnChange: fn => { changeCb = fn; },
  };
})();

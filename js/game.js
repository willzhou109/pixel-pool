/* Low-Poly Billiards — Three.js + custom physics. No external assets. */
(function () {
'use strict';

/* ================================ CONFIG ================================ */

const TABLE_Y = 0.80;         // felt surface height

/* ---------------------------- table profiles ----------------------------
 * A pool table and a snooker table are not the same table with different
 * markings: what separates them is how many BALL WIDTHS across they are. A
 * 9-foot pool table is about 44 ball-diameters long; a full-size snooker table
 * is 68. Racking snooker's 21 object balls on pool proportions gives you a
 * cramped, absurdly easy table, so snooker gets a bed of its own.
 *
 * Both profiles keep the same world footprint (PW is unchanged), so the camera
 * rig, the lighting, the shadow bounds and every background scene stay exactly
 * as tuned — what changes is the size of the ball on it, and the pockets and
 * cushion cut-backs that scale with the ball.
 *
 * The snooker numbers come from the WPBSA standard table: a 3569 x 1778 mm
 * playing area with 52.5 mm balls. So, holding the bed's length at 2*PW:
 *     ball diameter = 2*PW * 52.5/3569     -> 68 diameters along the table
 *     half-width PH = PW  * 1778/3569      -> the true 2.0073:1 bed, not 2:1
 * Everything sized off the ball (pockets, cut-backs, pocket insets) is scaled
 * by the same ratio, which keeps potting exactly as forgiving, ball-for-ball,
 * as it is in the pool games — while the table being half again as long in ball
 * widths is what makes snooker play long, the way it should.
 */
const SNOOKER_BALL_F = 52.5 / 3569;   // ball diameter as a fraction of the length
const SNOOKER_BED_F = 1778 / 3569;    // width as a fraction of the length

const TABLE_PROFILES = {
  // The pool bed, unchanged: a 2:1 field with 57 mm-equivalent balls.
  pool: {
    PW: 1.27, PH: 0.635, R: 0.0286,
    cornerR: 0.075, sideR: 0.066,     // pocket capture radii
    cornerGap: 0.085,                 // cushion cut-back near corner pockets
    sideGap: 0.058,                   // half-width of the side pocket mouth
    cornerInset: 0.012, sideInset: 0.024, // how far each cup sits past the rail
    startRadius: 0.95,                // camera distance for the shot view
    ballScale: 1,                     // this profile's ball vs the pool ball
  },
  snooker: (() => {
    const PW = 1.27;
    const R = PW * SNOOKER_BALL_F;    // (2*PW * f) / 2
    const k = R / 0.0286;             // everything ball-sized shrinks with it
    return {
      PW, PH: PW * SNOOKER_BED_F, R,
      cornerR: 0.075 * k, sideR: 0.066 * k,
      cornerGap: 0.085 * k, sideGap: 0.058 * k,
      cornerInset: 0.012 * k, sideInset: 0.024 * k,
      // Pull the shot view in with the ball, or a snooker ball reads as a speck
      // from pool's camera distance. Not the full ball ratio — that would bury
      // the camera in the cloth — but enough to keep the cue ball readable.
      startRadius: 0.95 * (0.5 + 0.5 * k),
      ballScale: k,
    };
  })(),
};

// The live table geometry, rewritten by applyTableProfile(). These are `let`
// rather than `const` because snooker plays on its own bed; everything that
// reads them does so at run time.
let PW, PH, R, BALL_Y, LIMX, LIMZ, CORNER_GAP, SIDE_GAP, START_RADIUS;
// The current profile's ball size relative to the pool ball. buildTable() sizes
// the cushions, rails and sight diamonds off this: leave them absolute and a
// snooker ball — barely two thirds the size — would sit lower than the cushion
// nose and vanish behind the rails from the shooting camera.
let BALL_SCALE = 1;
// Pocket cups: indices 0-3 are the corners, 4-5 the sides — physicsStep gates
// side-pocket capture on `pi >= 4`, and 8-ball's called pocket travels over the
// wire as an index, so the ORDER here is load-bearing. Rewritten in place so
// modules that captured the array (js/aimassist.js) keep pointing at it.
const POCKETS = [];
let tableProfile = '';
// The descriptor handed to js/physics.js, rebuilt lazily: the bed changes with
// the rule set, and POCKETS is rewritten in place rather than replaced.
let physT = null;

// Switch the bed to a profile. Returns true if anything actually changed, which
// is the caller's cue to rebuild the ball geometry and the table mesh — this
// function only touches the numbers.
function applyTableProfile(name) {
  if (tableProfile === name) return false;
  const p = TABLE_PROFILES[name] || TABLE_PROFILES.pool;
  tableProfile = name;
  PW = p.PW; PH = p.PH; R = p.R;
  BALL_Y = TABLE_Y + R;               // ball center height
  LIMX = PW - R; LIMZ = PH - R;       // cushion planes for ball centers
  CORNER_GAP = p.cornerGap;
  SIDE_GAP = p.sideGap;
  START_RADIUS = p.startRadius;
  BALL_SCALE = p.ballScale;
  physT = null;                       // the core's descriptor is now stale
  const ci = p.cornerInset, si = p.sideInset;
  POCKETS.length = 0;
  POCKETS.push(
    { x: -PW - ci, z: -PH - ci, r: p.cornerR },
    { x:  PW + ci, z: -PH - ci, r: p.cornerR },
    { x: -PW - ci, z:  PH + ci, r: p.cornerR },
    { x:  PW + ci, z:  PH + ci, r: p.cornerR },
    { x: 0,        z: -PH - si, r: p.sideR },
    { x: 0,        z:  PH + si, r: p.sideR }
  );
  return true;
}
applyTableProfile('pool');            // 8-ball is the default game

// Which bed a rule set plays on.
function profileFor(game) { return game === 'snooker' ? 'snooker' : 'pool'; }

const REST_BALL = 0.95;       // ball-ball restitution
const REST_CUSH = 0.72;       // cushion restitution
const CUSH_GRIP = 0.14;       // tangential speed loss on cushion contact
const FRIC_C = 0.30;          // constant rolling deceleration (u/s^2)
const FRIC_L = 0.30;          // linear (speed-proportional) drag (1/s)
const STOP_V = 0.018;         // below this, a ball is stopped
const MAX_V  = 5.0;           // full-power cue-ball speed
const BREAK_BOOST = 1.9;      // extra cue speed on the opening break
const MAX_PULL = 0.34;        // world-units of cue pull-back at full power
const PHYS_H = 1 / 480;       // physics substep

const BALL_COLORS = {
  1: '#f2b705', 2: '#1d5fbf', 3: '#d0342c', 4: '#6a2d9c',
  5: '#e8720c', 6: '#1a8a4f', 7: '#8a2033', 8: '#181820',
};

// The snooker rules module (js/snooker.js) — ball values, spot geometry and the
// stroke verdict. Aliased once here because it's referenced from the rack, the
// resolve path and the HUD alike.
const SNK = window.PoolSnooker;
// The simulation core (js/physics.js). Shared verbatim with the headless driver
// in tools/, so a shot plays out identically in Node and in the browser.
const PHYS = window.PoolPhysics;

/* =============================== RENDERER =============================== */

const canvas = document.getElementById('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false });
renderer.setPixelRatio(1); // pixel-art: render low-res, upscale with nearest-neighbor
const PIXEL = 3.2;          // device pixels per rendered pixel
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
scene.background = new THREE.Color('#171d2b');
scene.fog = new THREE.Fog('#171d2b', 7, 16);

const camera = new THREE.PerspectiveCamera(55, 1, 0.05, 60);

/* camera orbit state */
const START_PITCH = 0.34; // the low first-person shot view (START_RADIUS is per-profile)
// Bird's-eye "survey" pose — shown while the local player must make a
// decision that benefits from seeing the whole table: placing the cue ball
// after a foul (S.PLACING) or nominating a pocket on the 8-ball (S.CALLING).
// Yaw 0 puts the table's long axis (world X, PW=1.27) horizontal on screen
// and the short axis (Z, PH=0.635) into the depth — see updateCamera()'s
// spherical layout, where screen-right tracks cos(yaw) and screen-up tracks
// -sin(pitch) at high pitch, so yaw=0 keeps X purely horizontal.
const SURVEY_YAW = 0, SURVEY_PITCH = 1.56, SURVEY_RADIUS = 1.9;
let yawBeforeSurvey = null; // stashed cam.yaw while surveying; null = not surveying
const cam = {
  yaw: Math.PI * 0.5, pitch: 0.72, radius: 3.4,
  target: new THREE.Vector3(0, TABLE_Y, 0),
  goal: new THREE.Vector3(0, TABLE_Y, 0),
};

function updateCamera() {
  cam.pitch = Math.max(0.10, Math.min(1.56, cam.pitch));
  cam.radius = Math.max(0.30, Math.min(5.5, cam.radius));
  cam.target.lerp(cam.goal, 0.10);
  const cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch);
  camera.position.set(
    cam.target.x + Math.sin(cam.yaw) * cp * cam.radius,
    cam.target.y + sp * cam.radius,
    cam.target.z + Math.cos(cam.yaw) * cp * cam.radius
  );
  camera.lookAt(cam.target);
}

/* aim direction: horizontal camera forward */
function aimDir() {
  return new THREE.Vector2(-Math.sin(cam.yaw), -Math.cos(cam.yaw));
}

// Some background scenes hang decorative fixtures directly above the table
// (e.g. the Pool Hall's pendant lamp, js/backgrounds.js) — from straight
// overhead those loom over most of the frame, so the survey camera hides
// anything tagged userData.hideOnSurveyCam for as long as it's active.
function setOverheadFixturesVisible(visible) {
  scene.traverse(o => { if (o.userData && o.userData.hideOnSurveyCam) o.visible = visible; });
}

// Enter the bird's-eye survey pose (see SURVEY_* above). Idempotent — placing
// the cue ball while on the 8-ball chains PLACING straight into CALLING, and
// the second call must not clobber the originally-stashed yaw with 0.
function enterSurveyCam() {
  if (yawBeforeSurvey !== null) return;
  yawBeforeSurvey = cam.yaw;
  cam.yaw = SURVEY_YAW; cam.pitch = SURVEY_PITCH; cam.radius = SURVEY_RADIUS;
  setOverheadFixturesVisible(false);
}
// Leave the survey pose once the decision is made (ball placed, pocket
// called) — restores the yaw the player had been aiming from and drops
// pitch/radius to the standard low shot POV via resetZoom(). A no-op unless
// a survey is actually active, so it's safe to call after every ordinary shot.
function exitSurveyCam() {
  if (yawBeforeSurvey === null) return;
  cam.yaw = yawBeforeSurvey;
  yawBeforeSurvey = null;
  setOverheadFixturesVisible(true);
  resetZoom();
}

/* =============================== LIGHTING =============================== */

scene.add(new THREE.HemisphereLight('#b8c4e0', '#2a2118', 0.55));

const sun = new THREE.DirectionalLight('#fff4e0', 1.6);
sun.position.set(2.2, 5, 1.4);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = -2.6; sun.shadow.camera.right = 2.6;
sun.shadow.camera.top = 2.6;  sun.shadow.camera.bottom = -2.6;
sun.shadow.camera.far = 12;
sun.shadow.bias = -0.0004;
scene.add(sun);

const fill = new THREE.DirectionalLight('#c0d0ff', 0.35);
fill.position.set(-3, 4, -2);
scene.add(fill);

/* ================================ HELPERS =============================== */

function mat(color, opts) {
  return new THREE.MeshStandardMaterial(Object.assign(
    { color, flatShading: true, roughness: 0.85, metalness: 0.0 }, opts));
}
function box(w, h, d, color, opts) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat(color, opts));
  m.castShadow = true; m.receiveShadow = true;
  return m;
}
// Pick an ivory or charcoal sight-diamond color that reads against the rail.
function diamondColor(frameHex) {
  const n = parseInt(frameHex.slice(1), 16);
  const lum = 0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255);
  return lum > 140 ? '#2c2620' : '#ece3c8';
}
// Rack RNG. Defaults to Math.random (offline); online play swaps in a seeded
// generator (mulberry32) so both clients build the identical starting rack.
let rng = Math.random;
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = (rng() * (i + 1)) | 0;
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/* ================================= ROOM ================================= */

// The environment surrounding the table (floor, walls, scenery) is a selectable
// "background" owned by js/backgrounds.js — it swaps this out live. Backgrounds
// are pure decoration: their meshes never cast shadows and add no lights, so the
// pool table's own lighting and shadows stay identical whichever scene is
// chosen. game.js exposes window.PoolScene (below) for that module to hook into.

/* ================================= TABLE ================================ */

const LEG_TOP = TABLE_Y - 0.18; // legs rise from the floor to the apron underside

function metalMat(color) {
  return new THREE.MeshStandardMaterial({ color, flatShading: true, roughness: 0.38, metalness: 0.65 });
}

// A box connecting two 3D points (its local +Y aligned along the span) — used
// for angled/crossed/splayed legs. `taper` gives a narrower bottom (0..1).
function strut(x0, y0, z0, x1, y1, z1, w, m, taper) {
  const dx = x1 - x0, dy = y1 - y0, dz = z1 - z0;
  const len = Math.hypot(dx, dy, dz);
  let geo;
  if (taper != null) geo = new THREE.CylinderGeometry(w, w * taper, len, 4);
  else geo = new THREE.BoxGeometry(w, len, w);
  const mesh = new THREE.Mesh(geo, m);
  if (taper != null) mesh.rotation.y = Math.PI / 4;
  mesh.position.set((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
  mesh.quaternion.multiplyQuaternions(
    new THREE.Quaternion().setFromUnitVectors(
      new THREE.Vector3(0, 1, 0),
      new THREE.Vector3(dx, dy, dz).normalize()),
    mesh.quaternion);
  mesh.castShadow = true; mesh.receiveShadow = true;
  return mesh;
}

/* --------------------------- table leg / base styles -------------------- */

// Antique billiard: six flared square pedestal legs, three down each long rail.
function baseClassic(table, C) {
  const bm = mat(C.frame), dm = mat(C.frameDark), am = mat(C.accent);
  function leg() {
    const g = new THREE.Group();
    const H = LEG_TOP, rot = Math.PI / 4;
    const seg = (rt, rb, h, y, m) => {
      const s = new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, 4), m);
      s.rotation.y = rot; s.position.y = y; s.castShadow = s.receiveShadow = true;
      g.add(s);
    };
    const shaftH = H - 0.26;
    seg(0.08, 0.125, 0.13, 0.065, bm);
    seg(0.098, 0.08, shaftH, 0.13 + shaftH / 2, dm);
    seg(0.106, 0.098, 0.13, H - 0.065, bm);
    const capY = H - 0.065, off = 0.072;
    for (const s of [-1, 1]) {
      const iz = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.08, 0.006), am); iz.position.set(0, capY, s * off); g.add(iz);
      const ix = new THREE.Mesh(new THREE.BoxGeometry(0.006, 0.08, 0.05), am); ix.position.set(s * off, capY, 0); g.add(ix);
    }
    return g;
  }
  for (const zs of [-1, 1]) for (const lx of [-(PW - 0.05), 0, PW - 0.05]) {
    const l = leg(); l.position.set(lx, 0, zs * (PH - 0.005)); table.add(l);
  }
}

// Modern: matte-black crossed X pedestals at each end.
function baseModern(table, C) {
  const m = metalMat(C.frame);
  const zw = PH - 0.04, H = LEG_TOP;
  for (const xs of [-1, 1]) {
    const x = xs * (PW - 0.28);
    table.add(strut(x, H, -zw, x, 0.03, zw, 0.07, m));
    table.add(strut(x, H, zw, x, 0.03, -zw, 0.07, m));
    // feet
    for (const zs of [-1, 1]) {
      const f = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.04, 0.16), m);
      f.position.set(x, 0.02, zs * zw); f.castShadow = f.receiveShadow = true; table.add(f);
    }
  }
  // central spine tying the two X's together
  const spine = new THREE.Mesh(new THREE.BoxGeometry(2 * (PW - 0.28), 0.06, 0.08), m);
  spine.position.set(0, H * 0.5, 0); spine.castShadow = true; table.add(spine);
}

// Mid-century modern: four slim tapered round legs splayed outward.
function baseMidCentury(table, C) {
  const m = mat(C.frame);
  const H = LEG_TOP;
  for (const xs of [-1, 1]) for (const zs of [-1, 1]) {
    const tx = xs * (PW - 0.32), tz = zs * (PH - 0.18);   // top (inset)
    const bx = xs * (PW - 0.12), bz = zs * (PH + 0.02);   // foot (splayed out)
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.02, 1, 8), m);
    const dx = bx - tx, dy = -H, dz = bz - tz, len = Math.hypot(dx, dy, dz);
    leg.scale.y = len;
    leg.position.set((tx + bx) / 2, H / 2, (tz + bz) / 2);
    leg.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(dx, dy, dz).normalize());
    leg.castShadow = leg.receiveShadow = true;
    table.add(leg);
  }
}

// Farmhouse: two chunky weathered-wood plank trestles + a low stretcher.
function baseFarmhouse(table, C) {
  const bm = mat(C.frame), dm = mat(C.frameDark);
  const H = LEG_TOP;
  for (const xs of [-1, 1]) {
    const x = xs * (PW - 0.34);
    const panel = new THREE.Mesh(new THREE.BoxGeometry(0.10, H, 2 * (PH - 0.06)), bm);
    panel.position.set(x, H / 2, 0); panel.castShadow = panel.receiveShadow = true; table.add(panel);
    // foot rail under the panel
    const foot = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.09, 2 * (PH - 0.02)), dm);
    foot.position.set(x, 0.045, 0); foot.castShadow = foot.receiveShadow = true; table.add(foot);
  }
  const stretch = new THREE.Mesh(new THREE.BoxGeometry(2 * (PW - 0.34), 0.10, 0.12), dm);
  stretch.position.set(0, H * 0.42, 0); stretch.castShadow = true; table.add(stretch);
}

// Industrial: black iron A-frame trestles, cross beam, and a decorative gear.
function baseIndustrial(table, C) {
  const m = metalMat(C.frameDark);
  const zw = PH - 0.05, H = LEG_TOP;
  for (const xs of [-1, 1]) {
    const x = xs * (PW - 0.3);
    table.add(strut(x, H, 0, x, 0.03, zw, 0.05, m));
    table.add(strut(x, H, 0, x, 0.03, -zw, 0.05, m));
    for (const zs of [-1, 1]) {
      const f = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.04, 0.14), m);
      f.position.set(x, 0.02, zs * zw); f.castShadow = true; table.add(f);
    }
  }
  const beam = new THREE.Mesh(new THREE.BoxGeometry(2 * (PW - 0.3), 0.06, 0.06), m);
  beam.position.set(0, H * 0.55, 0); beam.castShadow = true; table.add(beam);
  // Vertical posts tie the central beam up to each A-frame apex, so it reads as
  // connected structure instead of floating between the splayed legs.
  for (const xs of [-1, 1]) {
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.055, H - H * 0.55, 0.055), m);
    post.position.set(xs * (PW - 0.3), (H + H * 0.55) / 2, 0);
    post.castShadow = true; table.add(post);
  }
}

// Outdoor: four straight square aluminium posts with leveling feet.
function baseOutdoor(table, C) {
  const m = metalMat(C.frame), fm = metalMat(C.frameDark);
  const H = LEG_TOP;
  for (const xs of [-1, 1]) for (const zs of [-1, 1]) {
    const x = xs * (PW - 0.08), z = zs * (PH - 0.02);
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.09, H - 0.03, 0.09), m);
    post.position.set(x, (H - 0.03) / 2 + 0.03, z); post.castShadow = post.receiveShadow = true; table.add(post);
    const foot = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.06, 0.03, 10), fm);
    foot.position.set(x, 0.015, z); foot.castShadow = true; table.add(foot);
  }
}

// Dining: walnut X-crossed trestles at each end joined by a stretcher.
function baseDining(table, C) {
  const bm = mat(C.frame), dm = mat(C.frameDark);
  const zw = PH - 0.06, H = LEG_TOP;
  for (const xs of [-1, 1]) {
    const x = xs * (PW - 0.26);
    table.add(strut(x, H, -zw, x, 0.04, zw, 0.08, bm));
    table.add(strut(x, H, zw, x, 0.04, -zw, 0.08, bm));
    for (const zs of [-1, 1]) {
      const f = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.06, 0.18), dm);
      f.position.set(x, 0.03, zs * zw); f.castShadow = f.receiveShadow = true; table.add(f);
    }
  }
  const stretch = new THREE.Mesh(new THREE.BoxGeometry(2 * (PW - 0.26), 0.09, 0.09), dm);
  stretch.position.set(0, H * 0.5, 0); stretch.castShadow = true; table.add(stretch);
}

const TABLE_STYLES = [
  { name: 'Classic',      felt: '#2e7d4f', feltDark: '#276b44', frame: '#5e3016', frameDark: '#301608', accent: '#c19a5e', inlays: true,  metal: false, base: baseClassic },
  { name: 'Modern',       felt: '#2f6f47', feltDark: '#28603d', frame: '#17181c', frameDark: '#0e0e12', accent: '#17181c', inlays: false, metal: true,  base: baseModern },
  { name: 'Mid-century',  felt: '#8b9099', feltDark: '#7d828b', frame: '#7a5230', frameDark: '#5a3c22', accent: '#7a5230', inlays: false, metal: false, base: baseMidCentury },
  { name: 'Farmhouse',    felt: '#8f96a0', feltDark: '#828892', frame: '#9c8d76', frameDark: '#77694f', accent: '#b7ab95', inlays: false, metal: false, base: baseFarmhouse },
  { name: 'Industrial',   felt: '#3b424b', feltDark: '#343a42', frame: '#7a5638', frameDark: '#26262b', accent: '#26262b', inlays: false, metal: false, base: baseIndustrial },
  { name: 'Outdoor',      felt: '#2a5ca8', feltDark: '#254f90', frame: '#d6dadf', frameDark: '#b3b8be', accent: '#d6dadf', inlays: false, metal: true,  base: baseOutdoor },
  { name: 'Dining',       felt: '#274a86', feltDark: '#213f73', frame: '#7a5230', frameDark: '#573a20', accent: '#a07a4e', inlays: false, metal: false, base: baseDining },
];

let tableGroup = null;
let currentTableStyle = 0;
let pocketMats = []; // one material per pocket, so the aim-assist can glow them

function disposeGroup(g) {
  g.traverse(o => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => m.dispose());
  });
}

// The pool table's two felt spots, refreshed on every buildTable() so
// setSnookerMarkings can hide them without digging through the scene graph.
const poolSpots = [];

function buildTable(C) {
  const table = new THREE.Group();
  const frameMat = C.metal ? metalMat(C.frame) : mat(C.frame);
  const apronMat = C.metal ? metalMat(C.frameDark) : mat(C.frameDark);

  // slate / felt bed
  const bed = new THREE.Mesh(new THREE.BoxGeometry(2 * PW + 0.06, 0.06, 2 * PH + 0.06), mat(C.felt));
  bed.position.y = TABLE_Y - 0.03; bed.castShadow = bed.receiveShadow = true;
  table.add(bed);

  // felt markings — the head and foot spots of a pool table. Snooker chalks a
  // different set entirely (see buildSnookerMarks), so they're kept in a list
  // and hidden while that game is up.
  poolSpots.length = 0;
  const spotGeo = new THREE.CircleGeometry(0.012 * BALL_SCALE, 8);
  for (const sx of [-PW / 2, PW / 2]) {
    const s = new THREE.Mesh(spotGeo, mat('#cfe3d5'));
    s.rotation.x = -Math.PI / 2; s.position.set(sx, TABLE_Y + 0.0008, 0);
    table.add(s);
    poolSpots.push(s);
  }

  // cushions. Sized off the ball (BALL_SCALE), so the nose always sits at the
  // same fraction of a ball's height whichever bed is up.
  const cushH = 0.045 * BALL_SCALE, cushDepth = 0.052 * BALL_SCALE;
  const cushCut = 0.035 * BALL_SCALE;
  const cushMat = mat(C.feltDark);
  function cushion(len, cut) {
    const half = len / 2;
    const s = new THREE.Shape();
    s.moveTo(-half, 0); s.lineTo(half, 0);
    s.lineTo(half - cut, cushDepth); s.lineTo(-half + cut, cushDepth); s.closePath();
    const g = new THREE.ExtrudeGeometry(s, { depth: cushH, bevelEnabled: false });
    g.rotateX(-Math.PI / 2);
    const m = new THREE.Mesh(g, cushMat);
    m.castShadow = true; m.receiveShadow = true;
    return m;
  }
  const longLen = PW - CORNER_GAP - SIDE_GAP;
  const longCx = (PW - CORNER_GAP + SIDE_GAP) / 2;
  for (const zs of [-1, 1]) for (const xs of [-1, 1]) {
    const c = cushion(longLen, cushCut);
    if (zs < 0) c.rotation.y = Math.PI;
    c.position.set(xs * longCx, TABLE_Y, zs * (PH + cushDepth));
    table.add(c);
  }
  const shortLen = 2 * (PH - CORNER_GAP);
  for (const xs of [-1, 1]) {
    const c = cushion(shortLen, cushCut);
    c.rotation.y = xs > 0 ? Math.PI / 2 : -Math.PI / 2;
    c.position.set(xs * (PW + cushDepth), TABLE_Y, 0);
    table.add(c);
  }

  // rail frame — also ball-scaled, so the rail top stays just under the top of
  // a ball and never hides one from a low camera.
  const railW = 0.11 * BALL_SCALE, railH = 0.09 * BALL_SCALE;
  const frameX = PW + cushDepth + railW / 2;
  const frameZ = PH + cushDepth + railW / 2;
  for (const zs of [-1, 1]) {
    const r = new THREE.Mesh(new THREE.BoxGeometry(2 * (PW + cushDepth + railW), railH, railW), frameMat);
    r.position.set(0, TABLE_Y + 0.005, zs * frameZ); r.castShadow = r.receiveShadow = true; table.add(r);
  }
  for (const xs of [-1, 1]) {
    const r = new THREE.Mesh(new THREE.BoxGeometry(railW, railH, 2 * (PH + cushDepth)), frameMat);
    r.position.set(xs * frameX, TABLE_Y + 0.005, 0); r.castShadow = r.receiveShadow = true; table.add(r);
  }

  // rail sight diamonds: three evenly spaced along every rail segment between
  // adjacent pockets — 6 per long rail (split by the side pocket), 3 per short.
  const diaGeo = new THREE.CircleGeometry(0.014 * BALL_SCALE, 4);
  const diaMat = mat(diamondColor(C.frame), { roughness: 0.5 });
  const diaY = TABLE_Y + 0.005 + railH / 2 + 0.001;
  // `long` = the world axis the diamond is stretched along; we point it toward
  // the table (perpendicular to the rail it sits on).
  function diamond(x, z, long) {
    const d = new THREE.Mesh(diaGeo, diaMat);
    d.rotation.x = -Math.PI / 2;
    d.scale.set(long === 'x' ? 1.7 : 1, long === 'z' ? 1.7 : 1, 1);
    d.position.set(x, diaY, z); d.receiveShadow = true;
    table.add(d);
  }
  for (const zs of [-1, 1]) for (const f of [-0.75, -0.5, -0.25, 0.25, 0.5, 0.75])
    diamond(f * PW, zs * frameZ, 'z'); // long rails → point inward along z
  for (const xs of [-1, 1]) for (const f of [-0.5, 0, 0.5])
    diamond(xs * frameX, f * PH, 'x'); // short rails → point inward along x

  // pockets (flush dark mouths + recess; polygonOffset avoids z-fighting).
  // Each pocket gets its own material so the aim-assist can glow it green.
  pocketMats = [];
  for (const p of POCKETS) {
    const pm = new THREE.MeshStandardMaterial({
      color: '#0a0a0f', emissive: '#000000', flatShading: true, roughness: 0.95, metalness: 0.0,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    });
    pocketMats.push(pm);
    const mouth = new THREE.Mesh(new THREE.CircleGeometry(p.r * 1.12, 18), pm);
    mouth.rotation.x = -Math.PI / 2; mouth.position.set(p.x, TABLE_Y + 0.0015, p.z);
    mouth.receiveShadow = true; table.add(mouth);
    const cup = new THREE.Mesh(new THREE.CylinderGeometry(p.r * 1.05, p.r * 0.8, 0.08, 12), pm);
    cup.position.set(p.x, TABLE_Y - 0.045, p.z); table.add(cup);
  }

  // apron skirt
  const apron = new THREE.Mesh(new THREE.BoxGeometry(2 * PW + 0.16, 0.12, 2 * PH + 0.16), apronMat);
  apron.position.y = TABLE_Y - 0.12; apron.castShadow = apron.receiveShadow = true;
  table.add(apron);
  if (C.inlays) {
    const am = mat(C.accent), apronZ = PH + 0.08 + 0.003;
    for (const zs of [-1, 1]) for (const fx of [-0.66, -0.22, 0.22, 0.66]) {
      const inlay = new THREE.Mesh(new THREE.BoxGeometry(0.075, 0.075, 0.006), am);
      inlay.position.set(fx * PW, TABLE_Y - 0.12, zs * apronZ); table.add(inlay);
    }
  }

  // style-specific legs / base
  C.base(table, C);
  return table;
}

function setTableStyle(i) {
  currentTableStyle = ((i % TABLE_STYLES.length) + TABLE_STYLES.length) % TABLE_STYLES.length;
  if (tableGroup) { scene.remove(tableGroup); disposeGroup(tableGroup); }
  tableGroup = buildTable(TABLE_STYLES[currentTableStyle]);
  scene.add(tableGroup);
  // The felt spots were just rebuilt, so re-assert whichever set this game wants.
  setSnookerMarkings(!!snookerMarks && snookerMarks.visible);
  // pocket materials were just rebuilt fresh (dark); drop any stale glow state
  if (window.AimAssist) window.AimAssist.clear();
}

/* --------------------------- snooker markings --------------------------- */
// The baulk line, the D and the six colour spots, chalked onto the felt when
// snooker is the selected game. Kept in a group of their own rather than inside
// buildTable(), so changing table style (which rebuilds tableGroup from
// scratch) can't wipe them and they don't have to be redrawn per style.
let snookerMarks = null;

function buildSnookerMarks() {
  const L = SNK.layout({ PW, PH, R });
  const g = new THREE.Group();
  const chalk = mat('#cfe3d5', { roughness: 0.9 });
  const y = TABLE_Y + 0.0010; // a hair above the felt, and above the pool spots
  const flat = (mesh, x, z) => {
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(x, y, z);
    g.add(mesh);
  };
  // Baulk line, straight across the table.
  flat(new THREE.Mesh(new THREE.PlaneGeometry(0.004, 2 * PH), chalk), L.baulkX, 0);
  // The D, bulging back toward the baulk cushion. After the -90° x-rotation a
  // ring's angle 0 points along world +x and 90° along world -z, so the half
  // that opens toward -x is the sweep from 90° to 270°.
  // Drawn a touch heavier than the straight line: the renderer downsamples hard
  // (PIXEL = 3.2), and a hairline curve breaks up into dots where a straight
  // one stays solid.
  flat(new THREE.Mesh(
    new THREE.RingGeometry(L.dR - 0.0035, L.dR + 0.0035, 64, 1, Math.PI / 2, Math.PI),
    chalk), L.baulkX, 0);
  // The six spots.
  const dot = new THREE.CircleGeometry(0.010, 10);
  for (const id of SNK.COLOURS) flat(new THREE.Mesh(dot, chalk), L.spots[id].x, L.spots[id].z);
  return g;
}

// Throw away the chalked markings so the next setSnookerMarkings(true) re-cuts
// them. Needed after a table-profile change, since the baulk line, the D and the
// spots are all sized off the bed they were built for.
function dropSnookerMarks() {
  if (!snookerMarks) return;
  scene.remove(snookerMarks);
  disposeGroup(snookerMarks);
  snookerMarks = null;
}

// Show or hide the snooker markings; built lazily the first time snooker is
// picked, so the pool games never pay for geometry they don't draw.
function setSnookerMarkings(on) {
  if (on && !snookerMarks) { snookerMarks = buildSnookerMarks(); scene.add(snookerMarks); }
  if (snookerMarks) snookerMarks.visible = !!on;
  // A snooker table has no head or foot spot — its pink happens to sit where
  // the foot spot is, but the head spot would just be a stray mark.
  for (const sp of poolSpots) sp.visible = !on;
}

setTableStyle(0);

/* ================================= BALLS ================================ */

function ballTexture(num) {
  const cv = document.createElement('canvas');
  cv.width = 256; cv.height = 128;
  const g = cv.getContext('2d');
  const color = num === 0 ? '#f4f1e8' : BALL_COLORS[num > 8 ? num - 8 : num];
  if (num === 0) {
    g.fillStyle = color; g.fillRect(0, 0, 256, 128);
  } else if (num <= 8) {
    g.fillStyle = color; g.fillRect(0, 0, 256, 128);
  } else {
    g.fillStyle = '#f4f1e8'; g.fillRect(0, 0, 256, 128);
    g.fillStyle = color; g.fillRect(0, 30, 256, 68);
  }
  if (num > 0) {
    for (const cx of [64, 192]) {
      g.fillStyle = '#f4f1e8';
      g.beginPath(); g.arc(cx, 64, 21, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#15151c';
      g.font = 'bold 27px sans-serif';
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(String(num), cx, 66);
    }
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  return tex;
}

// Rebuilt whenever the table profile changes — snooker's ball is a different
// size, and every ball mesh plus the ball-in-hand ghost shares this one geometry.
let ballGeo = new THREE.SphereGeometry(R, 14, 10);

// Snooker needs 22 balls (cue + 15 reds + 6 colours) where pool needs 16, so
// the array is always built to the larger size and the pool games park ids
// 16-21 the way 9-ball parks 10-15 (see parkBalls). Each ball carries a
// material for each look — the numbered pool ball, or the plain snooker one —
// because a mesh's texture can't depend on a rule set that's picked later;
// rackBalls swaps them via applyBallLook().
const balls = []; // {id, mesh, poolMat, snkMat, x, z, vx, vz, potted, sink}

for (let id = 0; id <= 21; id++) {
  // Snooker balls carry no number and no stripe, so they need no texture at
  // all — a flat-shaded colour is the whole look.
  const snkMat = new THREE.MeshStandardMaterial({
    color: id === 0 ? '#f4f1e8' : SNK.hex(id),
    flatShading: true, roughness: 0.32, metalness: 0.05,
  });
  const poolMat = id <= 15 ? new THREE.MeshStandardMaterial({
    map: ballTexture(id), flatShading: true, roughness: 0.32, metalness: 0.05,
  }) : null;
  const m = new THREE.Mesh(ballGeo, poolMat || snkMat);
  m.castShadow = true; m.receiveShadow = true;
  scene.add(m);
  balls.push({ id, mesh: m, poolMat, snkMat, x: 0, z: 0, vx: 0, vz: 0, potted: false, sink: 0 });
}
const cue = balls[0];

// Point every ball at the look the current rule set wants. Cheap enough to run
// on every rack, and the only place the two material sets are ever chosen
// between, so a ball can't end up wearing the wrong game's skin.
function applyBallLook() {
  const snk = gameMode === 'snooker';
  for (const b of balls) b.mesh.material = snk ? b.snkMat : (b.poolMat || b.snkMat);
}

/* Data + controls the aim-assist module (js/aimassist.js) needs. Kept as a
   small explicit surface so that feature can live in its own file. */
window.PoolAimHooks = {
  // POCKETS and balls are arrays game.js mutates in place, so a module may hold
  // on to them. The scalars are getters instead: they change with the table
  // profile (snooker plays a smaller ball on its own bed), and a value captured
  // at load would silently go stale.
  scene, POCKETS, balls, TABLE_Y,
  // LIMZ + SIDE_GAP: the long-rail plane and its side-pocket slot, so the assist
  // can test whether a ball can actually thread into a side pocket.
  get R() { return R; },
  get LIMZ() { return LIMZ; },
  get SIDE_GAP() { return SIDE_GAP; },
  get BALL_Y() { return BALL_Y; },
  // Turn a pocket's black void green (and glowing) or back to normal. Reads the
  // live pocketMats so it keeps working after a table-style rebuild.
  setPocketGlow(i, on) {
    const m = pocketMats[i];
    if (!m) return;
    if (on) { m.color.set('#2ecc71'); m.emissive.set('#1f8f4d'); m.emissiveIntensity = 1; }
    else { m.color.set('#0a0a0f'); m.emissive.set('#000000'); }
  },
};

// Re-cut everything sized off the ball radius and hand it to the meshes that
// use it: the balls themselves, the ball-in-hand ghost, the ghost-ball contact
// ring in the aim guide, and the ring drawn around the ball that's on. Cheap
// (a few small primitives), and the only place ball size is ever changed, so
// nothing can be left at the previous table's scale.
function rebuildBallGeometry() {
  const sphere = new THREE.SphereGeometry(R, 14, 10);
  ballGeo.dispose();
  ballGeo = sphere;
  for (const b of balls) b.mesh.geometry = ballGeo;
  placeGhost.geometry = ballGeo;

  ghostRing.geometry.dispose();
  ghostRing.geometry = new THREE.RingGeometry(R * 0.7, R, 16);
  targetRing.geometry.dispose();
  targetRing.geometry = new THREE.RingGeometry(R * 1.3, R * 1.75, 22);

  // Both cues are modelled from the tip along +Z, so scaling the group shrinks
  // them about the contact point and leaves every aiming transform untouched.
  // A real cue is much the same length whatever the game, but a snooker ball is
  // two thirds the size — so on this bed the cue comes down with it, or it
  // reads as a telegraph pole lying across the table.
  stick.scale.setScalar(BALL_SCALE);
  ghostStick.scale.setScalar(BALL_SCALE);
}

// Hook for js/backgrounds.js: enough of the scene to hang decoration off of and
// tint the sky/fog. Deliberately exposes no lights — backgrounds must not touch
// the lighting rig, so the table's shading is identical in every environment.
window.PoolScene = {
  scene, TABLE_Y,
  get PW() { return PW; },
  get PH() { return PH; },
  setSky(color) { scene.background = new THREE.Color(color); },
  setFog(color, near, far) { scene.fog = new THREE.Fog(color, near, far); },
  clearFog() { scene.fog = null; },
  toast(text) { toast(text); },
};

function rackBalls() {
  for (const b of balls) {
    b.potted = false; b.sink = 0; b.vx = 0; b.vz = 0;
    b.mesh.visible = true; b.mesh.scale.setScalar(1);
    b.mesh.quaternion.identity();
  }
  cue.x = -PW / 2; cue.z = 0;
  applyBallLook();
  if (gameMode === 'snooker') rackSnooker();
  else if (gameMode === '9ball') rackNine();
  else rackEight();
  breakShot = true; // next shot is the opening break
  syncBallMeshes(0);
}

// Park the balls a rule set doesn't use: flagged potted and hidden, which is
// exactly the state physics, the aim assist, the bot's context and the recap
// boards already skip. 9-ball parks 10-15; both pool games park the six
// snooker colours (16-21).
function parkBalls(ids) {
  for (const id of ids) {
    const b = balls[id];
    b.potted = true; b.sink = 0; b.mesh.visible = false;
  }
}

// Snooker: fifteen reds in a triangle behind the pink, the six colours on their
// spots. js/snooker.js owns every one of those positions — see the table
// fractions in its geometry section. The frame opens in hand from the D, so the
// cue ball here is only where the placing ghost starts out.
function rackSnooker() {
  const L = SNK.layout({ PW, PH, R });
  for (const { id, x, z } of L.reds) { balls[id].x = x; balls[id].z = z; }
  for (const id of SNK.COLOURS) {
    balls[id].x = L.spots[id].x; balls[id].z = L.spots[id].z;
  }
  cue.x = L.baulkX - L.dR * 0.35; cue.z = L.dR * 0.55;
  // Scores belong to the match, not the rack (resetSceneAfterGame re-racks
  // behind the end screen and must not wipe the final score) — startMatch owns
  // them. Only the targeting state resets here.
  snooker.st = SNK.opening(id => balls[id].potted);
}

// 9-ball: the nine-ball diamond (js/nineball.js owns the layout). Balls 10-15
// sit the game out — parked as already-potted, which is exactly the state every
// consumer already skips: physics, the aim assist and the recap boards alike.
function rackNine() {
  const N = window.PoolNineBall;
  for (const { id, x, z } of N.rack({ PW, R, shuffle })) {
    balls[id].x = x; balls[id].z = z;
  }
  parkBalls(N.IDLE_BALLS.concat(SNK.COLOURS));
}

function rackEight() {
  parkBalls(SNK.COLOURS);
  const solids = shuffle([1, 2, 3, 4, 5, 6, 7]);
  const stripes = shuffle([9, 10, 11, 12, 13, 14, 15]);
  const cornerA = solids.pop(), cornerB = stripes.pop();
  const rest = shuffle(solids.concat(stripes));

  // Tight triangular rack: within-row spacing d ≈ 2R (a hair over, to avoid
  // start-of-frame overlap), row spacing d·√3/2 so every neighbour just touches.
  // A gap-free rack transfers the break's energy cleanly and scatters the pack.
  const d = 2 * R * 1.0006, dx = d * Math.sqrt(3) / 2;
  for (let row = 0; row < 5; row++) {
    for (let i = 0; i <= row; i++) {
      let id;
      if (row === 2 && i === 1) id = 8;
      else if (row === 4 && i === 0) id = cornerA;
      else if (row === 4 && i === 4) id = cornerB;
      else id = rest.pop();
      const b = balls[id];
      b.x = PW / 2 + row * dx;
      b.z = (i - row / 2) * d;
    }
  }
}

// Bring a ball back onto the table: 9-ball spots an illegally pocketed 9, and
// snooker re-spots colours constantly. The destination is the ball's own spot —
// in snooker, or failing that the highest-value spot still free, which is the
// rule js/snooker.js resolves. If even that is covered the ball walks up the
// table to the first clear gap, so spotting can never bury it inside another.
function spotBall(id) {
  const b = balls[id];
  const home = gameMode === 'snooker'
    ? SNK.respotSpot({ PW, PH, R }, id, (x, z) => spotClear(x, z, id))
    : window.PoolNineBall.spot({ PW, R });
  const step = 2 * R * 1.06;
  let x = home.x;
  for (let k = 0; k < 60; k++) {
    const cand = Math.min(LIMX, home.x + k * step);
    if (spotClear(cand, home.z, id)) { x = cand; break; }
    x = cand;
  }
  // Snooker's last resort is "as near as possible to its own spot on the centre
  // line, toward the top cushion" — which is what the walk above just did.
  b.potted = false; b.sink = 0; b.vx = 0; b.vz = 0;
  b.x = x; b.z = home.z;
  b.mesh.visible = true; b.mesh.scale.setScalar(1);
  b.mesh.position.set(b.x, BALL_Y, b.z);
}

// Is (x, z) free of every live ball but `skipId`, and clear of the pockets?
function spotClear(x, z, skipId) {
  for (const b of balls) {
    if (b.id === skipId || b.potted) continue;
    if ((b.x - x) ** 2 + (b.z - z) ** 2 < (2 * R * 1.02) ** 2) return false;
  }
  for (const p of POCKETS) {
    if ((p.x - x) ** 2 + (p.z - z) ** 2 < (p.r + R) ** 2) return false;
  }
  return true;
}

function syncBallMeshes(dt) {
  const axis = new THREE.Vector3();
  for (const b of balls) {
    if (b.potted) {
      if (b.sink > 0) {
        b.sink -= dt;
        const t = Math.max(0, b.sink / 0.25);
        b.mesh.position.y = BALL_Y - (1 - t) * 0.09;
        b.mesh.scale.setScalar(Math.max(0.01, t));
        if (b.sink <= 0) b.mesh.visible = false;
      }
      continue;
    }
    b.mesh.position.set(b.x, BALL_Y, b.z);
    const sp = Math.hypot(b.vx, b.vz);
    if (sp > 1e-4 && dt > 0) {
      axis.set(b.vz, 0, -b.vx).normalize(); // up × v: rolling axis
      b.mesh.rotateOnWorldAxis(axis, sp * dt / R);
    }
  }
}

/* ================================ PHYSICS =============================== */

// What the current stroke has done so far. `cushion` records a rail contact
// made AFTER the cue ball found an object ball — 9-ball's drive-to-rail rule
// (js/nineball.js) turns on exactly that ordering, so it's gated on firstHit.
let shotEvents = { potted: [], scratch: false, firstHit: null, cushion: false, eightPocket: -1 };

function anyMoving() { return PHYS.anyMoving(balls); }

// Everything js/physics.js needs from the CONFIG block above. Cached, because
// this is read 480 times a second, and invalidated by applyTableProfile.
function physTable() {
  return physT || (physT = {
    R, PW, PH, LIMX, LIMZ, CORNER_GAP, SIDE_GAP, POCKETS,
    REST_BALL, REST_CUSH, CUSH_GRIP, FRIC_C, FRIC_L, STOP_V,
  });
}

// Fire a top-right "pocketed" popup for the current shooter. Runs on the
// shooter's own client here; the watcher fires the same from applyPot().
function announcePot(id) {
  if (!window.PoolNotify) return;
  const who = players[turn].cfg.name;
  // Snooker balls have names, not numbers, and a plain disc for a chip.
  if (gameMode === 'snooker') {
    return window.PoolNotify.pocket(who, id, id === 0 ? null : SNK.hex(id),
      id === 0 ? 'cue ball' : SNK.name(id).toLowerCase());
  }
  const color = id === 0 ? null : BALL_COLORS[id > 8 ? id - 8 : id];
  window.PoolNotify.pocket(who, id, color);
}

// Advance the table one substep, then act on what the core reports. Every side
// effect the old physicsStep had inline lives here now — the sinking animation,
// the sounds, the pot popup, the watcher's early "sink it now" message — which
// is what lets js/physics.js stay pure enough to run in Node.
function physicsStep(h) {
  const events = PHYS.step(physTable(), balls, h, shotEvents);
  if (!events) return;
  for (const e of events) {
    if (e.type === 'cushion') { sfx.cushion(e.speed); continue; }
    if (e.type === 'clack') { sfx.clack(e.speed); continue; }
    const b = balls[e.id];
    b.sink = 0.25;
    b.mesh.position.set(b.x, BALL_Y, b.z);
    // Which pocket the 8 found, for 8-ball's called-shot check. That's a rules
    // question, so the core just reports the pocket and this decides it means.
    if (e.id === 8) shotEvents.eightPocket = e.pocket;
    sfx.pocket();
    announcePot(e.id);
    // Tell the watcher to sink this ball now, instead of leaving it stranded at
    // its last streamed spot until the shot's authoritative state arrives.
    if (onlineMode && myTurn()) netSend({ t: 'pot', id: e.id, x: round4(b.x), z: round4(b.z) });
  }
}

/* ================================= AUDIO ================================ */

const sfx = (function () {
  let ctx = null, noise = null, lastT = {};
  const rnd = (lo, hi) => lo + Math.random() * (hi - lo);
  const samples = {}; // name -> decoded AudioBuffer, filled in once ctx exists
  function loadSample(name) {
    fetch(`sounds/${name}.mp3`)
      .then(r => r.arrayBuffer())
      .then(buf => ctx.decodeAudioData(buf))
      .then(ab => { samples[name] = ab; })
      .catch(() => {}); // missing/blocked file: caller falls back to synthesis
  }
  function playSample(name, vol, rate) {
    const ab = samples[name];
    if (!ab) return false;
    const now = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = ab;
    src.playbackRate.value = rate || 1;
    const g = ctx.createGain();
    g.gain.value = Math.min(1, vol);
    src.connect(g).connect(ctx.destination);
    src.start(now);
    return true;
  }
  function ensure() {
    if (ctx) return true;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    ctx = new AC();
    const len = ctx.sampleRate * 0.2 | 0;
    noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const ch = noise.getChannelData(0);
    for (let i = 0; i < len; i++) ch[i] = Math.random() * 2 - 1;
    loadSample('clack');
    loadSample('strike');
    return true;
  }
  // A short slice of the noise buffer through a filter, its own gain envelope.
  function noiseBurst(dest, vol, freq, q, dur, type, delay) {
    const now = ctx.currentTime + (delay || 0);
    const src = ctx.createBufferSource();
    src.buffer = noise;
    const f = ctx.createBiquadFilter();
    f.type = type || 'bandpass'; f.frequency.value = freq; f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(Math.min(1, vol), now + 0.001);
    g.gain.exponentialRampToValueAtTime(0.001, now + dur);
    src.connect(f).connect(g).connect(dest);
    src.start(now); src.stop(now + dur);
  }
  // A pure tone "ring" — ivory/phenolic balls have a resonant pitch under the click.
  function ping(dest, vol, freq, dur, delay) {
    const now = ctx.currentTime + (delay || 0);
    const o = ctx.createOscillator();
    o.type = 'sine'; o.frequency.setValueAtTime(freq, now);
    o.frequency.exponentialRampToValueAtTime(freq * 0.9, now + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, now);
    g.gain.exponentialRampToValueAtTime(0.001, now + dur);
    o.connect(g).connect(dest);
    o.start(now); o.stop(now + dur);
  }
  function throttled(key) {
    if (!ctx || ctx.state !== 'running') return false;
    const now = ctx.currentTime;
    if (key && lastT[key] && now - lastT[key] < 0.03) return false;
    if (key) lastT[key] = now;
    return true;
  }
  return {
    unlock() { if (ensure() && ctx.state === 'suspended') ctx.resume(); },
    // Ball-on-ball: a hard, very short transient click plus a brief resonant
    // ring whose pitch and length track impact speed (harder hits ring higher
    // and slightly longer, the way phenolic balls do), with per-hit jitter so
    // repeated shots don't sound identical.
    clack(imp) {
      if (!throttled('c')) return;
      const n = Math.max(0, Math.min(1, imp / MAX_V));   // 0 = bare tap, 1 = hardest hit
      const vol = (0.14 + n * 0.86) * 0.8;
      const rate = rnd(0.94, 1.06) + n * 0.08;           // harder hits ring a touch brighter
      if (playSample('clack', vol, rate)) return;
      // fallback while sounds/clack.mp3 hasn't loaded (or failed to)
      noiseBurst(ctx.destination, 0.05 + n * 0.4, rnd(2800, 3600), rnd(4, 7), rnd(0.012, 0.02), 'bandpass');
      ping(ctx.destination, (0.05 + n * 0.4) * 0.35, rnd(1800, 2200) + n * 500, rnd(0.03, 0.05) + n * 0.02);
    },
    // Cushion: cushions are rubber under cloth, so the strike is duller and
    // longer than a ball click — lowpassed, lower-pitched, slower decay, with
    // a soft sub-thump from the rail flexing.
    cushion(imp) {
      if (!throttled('w')) return;
      const vol = 0.09 + imp * 0.16;
      noiseBurst(ctx.destination, vol, rnd(280, 380), rnd(0.8, 1.3), rnd(0.06, 0.09), 'lowpass');
      noiseBurst(ctx.destination, vol * 0.4, 90, 0.9, 0.1, 'lowpass');
    },
    pocket() {
      if (!throttled('p')) return;
      noiseBurst(ctx.destination, 0.5, 190, 1.0, 0.28);
      noiseBurst(ctx.destination, 0.25, 900, 2, 0.1);
    },
    // Cue strike: tip-on-ball compression — brighter and shorter than a
    // ball-ball clack (leather tip, not phenolic), plus a felt low-end thump
    // that scales with how hard the shot is hit.
    strike(pow) {
      if (!throttled('s')) return;
      const n = Math.max(0, Math.min(1, pow));           // 0 = softest tap, 1 = full power
      const vol = (0.14 + n * 0.86) * 0.8;
      const rate = rnd(0.94, 1.06) + n * 0.06;           // harder strikes a touch brighter
      if (playSample('strike', vol, rate)) return;
      // fallback while sounds/strike.mp3 hasn't loaded (or failed to)
      noiseBurst(ctx.destination, 0.05 + n * 0.45, rnd(2000, 2400), 2.5, rnd(0.02, 0.03));
      noiseBurst(ctx.destination, 0.02 + n * 0.25, 140, 1.0, 0.05, 'lowpass');
    },
  };
})();

/* ============================ CUE STICK & GUIDE ========================= */

// Gap between the cue tip and the ball at rest. Ball-sized, like the stick
// itself — see rebuildBallGeometry, which scales both cues by BALL_SCALE.
function cueRest() { return 0.035 * BALL_SCALE; }

const stick = new THREE.Group();
{
  const len = 1.42;
  const shaft = new THREE.Mesh(
    new THREE.CylinderGeometry(0.0075, 0.017, len, 9),
    mat('#c89a5e', { roughness: 0.5 })
  );
  shaft.rotation.x = -Math.PI / 2;       // length along +Z (butt behind)
  shaft.position.z = len / 2;
  // no castShadow: the cue must not paint a shadow line on the felt
  const tip = new THREE.Mesh(new THREE.CylinderGeometry(0.0075, 0.0075, 0.025, 9), mat('#3a6ea8'));
  tip.rotation.x = -Math.PI / 2;
  tip.position.z = 0.0125;
  const butt = new THREE.Mesh(new THREE.CylinderGeometry(0.017, 0.015, 0.3, 9), mat('#2e2018', { roughness: 0.5 }));
  butt.rotation.x = -Math.PI / 2;
  butt.position.z = len - 0.15;
  stick.add(shaft, tip, butt);
}
stick.visible = false;
scene.add(stick);

// Opponent's floating cue for online play — a translucent, tinted copy of the
// stick shown from the remote player's streamed aim. Purely visual (no shadow).
const ghostStick = new THREE.Group();
{
  const len = 1.42;
  const gm = c => new THREE.MeshStandardMaterial({ color: c, transparent: true, opacity: 0.5, flatShading: true, roughness: 0.5 });
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.0075, 0.017, len, 9), gm('#7fd0ff'));
  shaft.rotation.x = -Math.PI / 2; shaft.position.z = len / 2;
  const tip = new THREE.Mesh(new THREE.CylinderGeometry(0.0075, 0.0075, 0.025, 9), gm('#ffffff'));
  tip.rotation.x = -Math.PI / 2; tip.position.z = 0.0125;
  ghostStick.add(shaft, tip);
}
ghostStick.visible = false;
scene.add(ghostStick);

const guideMat = new THREE.LineDashedMaterial({ color: '#ffffff', dashSize: 0.035, gapSize: 0.025, transparent: true, opacity: 0.75 });
const guideLine = new THREE.Line(new THREE.BufferGeometry(), guideMat);
guideLine.frustumCulled = false;
const objLine = new THREE.Line(new THREE.BufferGeometry(),
  new THREE.LineBasicMaterial({ color: '#f1c40f', transparent: true, opacity: 0.85 }));
objLine.frustumCulled = false;
const ghostRing = new THREE.Mesh(
  new THREE.RingGeometry(R * 0.7, R, 16),
  new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.55, side: THREE.DoubleSide })
);
ghostRing.rotation.x = -Math.PI / 2;
scene.add(guideLine, objLine, ghostRing);

const placeGhost = new THREE.Mesh(ballGeo,
  new THREE.MeshStandardMaterial({ color: '#ffffff', transparent: true, opacity: 0.5, flatShading: true }));
placeGhost.visible = false;
scene.add(placeGhost);

// Gold ring that marks the pocket called for an 8-ball shot. Lives on the scene
// (not the table group) so it survives table-style rebuilds.
const callMarker = new THREE.Mesh(
  new THREE.TorusGeometry(0.066, 0.012, 8, 22),
  new THREE.MeshStandardMaterial({ color: '#f5c518', emissive: '#f5c518', emissiveIntensity: 0.75, flatShading: true }));
callMarker.rotation.x = -Math.PI / 2;
callMarker.visible = false;
scene.add(callMarker);

// Cyan ring around the ball that must be struck first — 9-ball only, where the
// target changes every time one drops and the numbers on the balls are hard to
// read from the low shooting camera.
const targetRing = new THREE.Mesh(
  new THREE.RingGeometry(R * 1.3, R * 1.75, 22),
  new THREE.MeshBasicMaterial({ color: '#3fd0e0', transparent: true, opacity: 0.85, side: THREE.DoubleSide })
);
targetRing.rotation.x = -Math.PI / 2;
targetRing.visible = false;
scene.add(targetRing);

/* aim ray: first hit against balls (ghost-ball contact) or cushion planes */
function castAim(px, pz, dx, dz) {
  let bestT = Infinity, hitBall = null;
  const D = 2 * R;
  for (const b of balls) {
    if (b.id === 0 || b.potted) continue;
    const mx = b.x - px, mz = b.z - pz;
    const proj = mx * dx + mz * dz;
    if (proj <= 0) continue;
    const perp2 = mx * mx + mz * mz - proj * proj;
    if (perp2 > D * D) continue;
    const t = proj - Math.sqrt(D * D - perp2);
    if (t > 0 && t < bestT) { bestT = t; hitBall = b; }
  }
  // cushion planes
  let wallT = Infinity;
  if (dx > 1e-9) wallT = Math.min(wallT, (LIMX - px) / dx);
  if (dx < -1e-9) wallT = Math.min(wallT, (-LIMX - px) / dx);
  if (dz > 1e-9) wallT = Math.min(wallT, (LIMZ - pz) / dz);
  if (dz < -1e-9) wallT = Math.min(wallT, (-LIMZ - pz) / dz);
  if (wallT < bestT) return { t: wallT, ball: null };
  return { t: bestT, ball: hitBall };
}

// Ring the ball the striker is on while somebody is lining up: 9-ball's lowest
// ball, or snooker's nominated/sequence colour. Snooker's reds are never ringed
// — any of them is legal, so a ring on one would read as an instruction.
// Hidden mid-shot, so it never chases a ball that's still rolling.
function updateTargetRing() {
  const lining = state === S.AIM || state === S.CHARGE || state === S.PLACING;
  let id = 0;
  if (lining && gameMode === '9ball') id = lowestBall();
  else if (lining && gameMode === 'snooker') {
    const on = snookerOn();
    if (on.kind !== 'red' && on.ids.length === 1) id = on.ids[0];
  }
  targetRing.visible = id > 0 && !balls[id].potted;
  if (targetRing.visible) targetRing.position.set(balls[id].x, TABLE_Y + 0.003, balls[id].z);
}

function updateAimVisuals() {
  updateGhostCue(); // opponent's floating cue (online watcher)
  updateTargetRing(); // 9-ball: which ball has to be hit first
  const aiming = (state === S.AIM || state === S.CHARGE) && !cue.potted && myTurn();
  const AA = window.AimAssist;
  // "Lines" assist toggles the guide/object/ghost visuals; the cue stick and
  // pocket-preview are independent of it.
  const linesOn = aiming && (!AA || AA.showLines());
  // The real stick shows only for the local player's own stroke; the bot's
  // stroke uses the ghost stick (botStrike), so gate `striking` on myTurn().
  stick.visible = aiming || (striking && myTurn());
  if (!aiming) { // while striking, fire()'s animation drives the stick
    guideLine.visible = objLine.visible = ghostRing.visible = false;
    if (AA) AA.clear();
    return;
  }

  const d = aimDir();
  const hit = castAim(cue.x, cue.z, d.x, d.y);
  const t = Math.min(hit.t, 6);
  const gx = cue.x + d.x * t, gz = cue.z + d.y * t;

  guideLine.visible = ghostRing.visible = linesOn;
  if (linesOn) {
    guideLine.geometry.setFromPoints([
      new THREE.Vector3(cue.x, BALL_Y, cue.z),
      new THREE.Vector3(gx, BALL_Y, gz),
    ]);
    guideLine.computeLineDistances();
    ghostRing.position.set(gx, TABLE_Y + 0.002, gz);

    if (hit.ball) {
      let ox = hit.ball.x - gx, oz = hit.ball.z - gz;
      const ol = Math.hypot(ox, oz) || 1;
      ox /= ol; oz /= ol;
      objLine.geometry.setFromPoints([
        new THREE.Vector3(hit.ball.x, BALL_Y, hit.ball.z),
        new THREE.Vector3(hit.ball.x + ox * 0.28, BALL_Y, hit.ball.z + oz * 0.28),
      ]);
      objLine.visible = true;
    } else {
      objLine.visible = false;
    }
  } else {
    objLine.visible = false;
  }

  // pocket preview: green when the struck ball is lined up to drop
  if (AA) AA.updateAim(hit, gx, gz);

  // stick: behind the ball, opposite aim dir, slightly elevated, pulled by charge
  const pull = state === S.CHARGE ? chargePull : 0;
  const back = new THREE.Vector3(-d.x, 0.14, -d.y).normalize();
  const base = new THREE.Vector3(cue.x, BALL_Y, cue.z);
  stick.position.copy(base).addScaledVector(back, cueRest() + pull);
  stick.lookAt(base.clone().addScaledVector(back, 5));
}

/* ============================== GAME STATE ============================== */

// NOMINATE is snooker's "name your colour" step, the sibling of 8-ball's
// CALLING: the striker has potted a red and must say which colour they're on
// before they may shoot.
const S = { SETUP: 0, AIM: 1, CHARGE: 2, ROLLING: 3, PLACING: 4, END: 5, CALLING: 6, NOMINATE: 7 };
let state = S.SETUP;
// Which rule set this match runs: '8ball' (the default), '9ball' or 'snooker'.
// Picked on the home screen's game tabs and locked in for the match — see
// setGame(). Only the rack, the stroke verdict and the HUD differ; everything
// else (the physics, the camera, the recap) is shared.
let gameMode = '8ball';
// Snooker's frame state. `scores` are the running point totals per seat and
// `st` is the targeting state js/snooker.js reasons over ({phase, nominated}).
// Meaningless — and untouched — in the pool games.
const snooker = { scores: [0, 0], st: { phase: 'red', nominated: 0 } };
let turn = 0;
let breakShot = false;        // true until the opening break has been resolved
let calledPocket = -1;        // pocket index nominated for an 8-ball shot (-1 = none)
let chargePull = 0;
let striking = false;      // strike animation in progress
let placeValid = false;

const players = [
  { cfg: { name: 'Player 1' }, group: null },
  { cfg: { name: 'Player 2' }, group: null },
];

/* ------------------------------- online -------------------------------- */
// Online play is client-authoritative: on your turn you run the real game and
// stream it out (aim → shoot → ball snapshots → authoritative post-shot state);
// on the opponent's turn you run no physics and just render what they send.
let onlineMode = false;
let offlineNames = null;        // players' offline names, stashed while online so
                               // they're restored (not left as the opponent's) after
let mySeat = 0;                 // which players[] index is me
let netSink = null;            // (msg) => send to opponent (set by online.js)
let netExit = null;           // () => return to lobby (set by online.js)
let remoteAim = null;         // {yaw, pull, cx, cz} while watching the opponent aim
const RENDER_DELAY = 0.10;    // s of interpolation delay for opponent snapshots
let snapBuf = [];             // [{t, pos:{id:[x,z]}}] recent opponent snapshots
let lastSnapT = 0;            // throttle: last outbound snapshot time (ms)
let lastAimT = 0;            // throttle: last outbound aim time (ms)
let lastAimKey = '';          // throttle: last outbound aim, to skip duplicates
let lastEnd = null;           // {winner, reason} captured by endGame for the net
let lastFoul = '';            // last ball-in-hand reason, mirrored to the watcher
let watcherStriking = false;  // ghost-cue strike animation in progress (mirrors `striking`)
let applyingRemoteSetup = false; // guard: suppress re-broadcast while applying a synced scene
let bgSyncHooked = false;     // whether the background change hook is registered yet

/* ------------------------- vs computer (offline) ----------------------- */
// A local match against the built-in AI (js/bot.js). Reuses the online ghost-cue
// POV: on the human's turn they aim normally; on the computer's turn the human
// watches a floating ghost cue line up and strike, but — unlike online — all the
// physics runs locally. mySeat stays the human (0); botSeat is the computer (1).
let botMode = false;
let botSeat = 1;
// How long the computer's stated plan sits on screen before it draws the cue
// back — long enough to read the line and find the ball/pocket it named.
const BOT_READ_MS = 2600;
// Aim wobble as a fraction of a pot's make-window half-width (see runBotTurn).
// ~0.3 ⇒ most easy pots drop, thin cuts miss often — the "easy shots + legal
// play" bar, without the bot being an aimbot.
const BOT_SKILL = 0.001;
let botAim = null;            // {yaw, pull} driving the ghost cue on the bot's turn
let botStriking = false;      // bot's ghost-cue strike animation in progress
let botTimer = null;          // pending "thinking" delay before the bot acts
let vsCPU = true;             // setup toggle: next offline match is vs the computer
let forceBotBreak = false;    // test override (?botbreak): make the computer break
let bothBotSeats = false;     // test override (?botvbot): the computer plays BOTH seats,
                              // for headless self-play stats — see isBotSeat().

// True when I control the cue right now (offline hot-seat, or my seat's turn).
function myTurn() { return (onlineMode || botMode) ? turn === mySeat : true; }
// True when I'm watching the online opponent shoot (their turn). Network only —
// the bot runs physics locally, so it must NOT gate physics/resolve like this.
function watching() { return onlineMode && turn !== mySeat; }
// Is `seat` computer-controlled? Normally just botSeat; ?botvbot makes both.
function isBotSeat(seat) { return botMode && (seat === botSeat || bothBotSeats); }
// True while the computer is taking its turn (bot mode). Drives the ghost cue +
// input lock, but not the physics (which runs locally).
function botTurn() { return isBotSeat(turn) && state !== S.END; }
// The human is a spectator right now: online watcher, or watching the bot shoot.
function spectating() { return watching() || botTurn(); }
function netSend(msg) { if (onlineMode && netSink) netSink(msg); }
function clearBotTimer() { if (botTimer) { clearTimeout(botTimer); botTimer = null; } }

// ---- perspective-aware messaging (say "You" from the local player's view) ----
// Online or vs-CPU: true if `seat` is the local human. Offline hot-seat (two
// humans sharing the screen) has no single "you", so nobody is.
function isMe(seat) { return (onlineMode || botMode) && seat === mySeat; }
function endTitleFor(winner) {
  if (!onlineMode && !botMode) return `🏆 ${players[winner].cfg.name} wins!`;
  return winner === mySeat ? '🏆 YOU WON!' : '😞 YOU LOST';
}

function remaining(group) {
  const lo = group === 'solid' ? 1 : 9, hi = group === 'solid' ? 7 : 15;
  let n = 0;
  for (let i = lo; i <= hi; i++) if (!balls[i].potted) n++;
  return n;
}

function groupOf(id) { return id < 8 ? 'solid' : 'stripe'; }

// 9-ball: the lowest-numbered ball still on the table right now (0 = none).
function lowestBall() {
  return window.PoolNineBall.lowest(id => balls[id].potted);
}

// Snooker: what the striker is on right now, as the live table stands. Used by
// the HUD and the target ring; the resolve path builds its own from the
// PRE-stroke table instead (see resolveShotSnooker).
function snookerOn() {
  return SNK.ballOn(snooker.st, id => balls[id].potted);
}

// A seat is "on the 8" once its group is cleared and the 8 is still on the table.
function isOnEight(seat) {
  const g = players[seat].group;
  return !!g && remaining(g) === 0 && !balls[8].potted;
}
// Show/hide the gold ring on the called pocket (or clear with -1).
function setCalledPocket(i) {
  calledPocket = i;
  if (i >= 0) {
    const p = POCKETS[i];
    callMarker.position.set(p.x, TABLE_Y + 0.02, p.z);
    callMarker.visible = true;
  } else {
    callMarker.visible = false;
  }
}
// Open the shooter's turn: nominate a pocket first if they're on the 8-ball,
// otherwise go straight to aiming. Resets any previous pocket call.
function enterAim() {
  hidePlaceGhost(); // never carry a ball-in-hand preview into a shot
  setCalledPocket(-1);
  // Snooker: a red has just gone down, so the striker names the colour they're
  // on before they may shoot. Unlike 8-ball's pocket call this needs no survey
  // camera — the choice is a ball, not a spot on the felt, so the player is
  // better off staying in their aiming view.
  if (myTurn() && gameMode === 'snooker' && snooker.st.phase === 'colour'
      && !snooker.st.nominated) {
    state = S.NOMINATE;
    showNominate(true);
    exitSurveyCam();
  } else if (myTurn() && gameMode === '8ball' && isOnEight(turn)) {
    state = S.CALLING;
    enterSurveyCam(); // bird's-eye view to survey every pocket
  } else {
    showNominate(false);
    state = S.AIM;
    exitSurveyCam(); // no-op unless we were surveying (e.g. leaving CALLING/PLACING)
  }
}

/* ------------------------------- shooting ------------------------------ */

// Launch the cue ball once a stroke's thrust completes. Shared by the human's
// fire() (real stick) and the computer's botStrike() (ghost stick), so the
// stroke-end behaviour (reset shot events, apply velocity, sfx) stays identical.
function launchCue(dx, dz, power) {
  striking = false;
  shotEvents = { potted: [], scratch: false, firstHit: null, cushion: false, eightPocket: -1 };
  // Snooker has no smash break — the opening stroke is an ordinary shot into
  // the side of the pack, so it gets no boost.
  const boost = breakShot && gameMode !== 'snooker' ? BREAK_BOOST : 1;
  const speed = power * MAX_V * boost;
  cue.vx = dx * speed;
  cue.vz = dz * speed;
  sfx.strike(power);
}

function fire(power) {
  const d = aimDir();
  // Play-by-play: freeze the pre-shot layout + shot direction for the recap's
  // LAYOUT tab (js/stats.js pairs this with the post-shot layout at resolve).
  if (window.MatchStats) window.MatchStats.beginShot(statsLayout(), { x: round4(d.x), z: round4(d.y) });
  const pull0 = chargePull;
  chargePull = 0;
  state = S.ROLLING;
  striking = true;
  // Tell the opponent the shot is happening (they'll animate + await snapshots).
  netSend({ t: 'shoot', yaw: cam.yaw, power });
  lastSnapT = 0; // force an immediate snapshot once the ball starts moving
  const back = new THREE.Vector3(-d.x, 0.14, -d.y).normalize();
  const start = performance.now();
  const dur = 70;
  (function anim() {
    const t = (performance.now() - start) / dur;
    if (t >= 1) {
      stick.visible = false;
      launchCue(d.x, d.y, power);
      return;
    }
    stick.position.set(cue.x, BALL_Y, cue.z)
      .addScaledVector(back, cueRest() + pull0 * (1 - t));
    requestAnimationFrame(anim);
  })();
}

/* ---------------------------- vs computer AI --------------------------- */

// Fine-tune a nominal aim by searching for the band of headings that actually
// produce the intended outcome, and shooting at its centre. `works(yaw)` is the
// oracle — for a direct pot it's the aim-assist's own green-pocket predictor
// (the same signal the human sees glow); banks and kicks pass their own (see
// botAimTest). Returns { yaw, width }: the heading, and the band width (rad).
//
// The band for a real pot is TINY — predictPocket accepts a line only within
// ~0.82 pocket-radii of the cup, which for a mid-range ball is on the order of
// 0.1°. A fixed-step sweep coarse enough to cover the search fan steps straight
// over that window and finds nothing, so we do it in two passes:
//   1. coarse scan to find any sample that works (brackets the window),
//   2. bisection outward from that seed to the window's true edges.
// Aiming at the centre of the resolved band leaves the maximum margin for the
// skill wobble the caller adds on top.
function tuneAim(nominalYaw, works) {
  const greens = works;

  // 1. Coarse scan for a seed inside the window. Steps must be fine enough not
  // to skip a narrow band: 0.02° over a ±3.4° fan.
  const FAN = 0.06, STEP = 0.00035;
  let seed = null;
  if (greens(nominalYaw)) seed = 0; // the geometric aim usually lands in it
  else {
    for (let off = STEP; off <= FAN && seed === null; off += STEP) {
      if (greens(nominalYaw + off)) seed = off;
      else if (greens(nominalYaw - off)) seed = -off;
    }
  }
  if (seed === null) return { yaw: nominalYaw, width: 0 }; // no pot line at all

  // 2. Walk each way from the seed until the band stops, then bisect the last
  // step to land on the true edge.
  const edge = dir => {
    let inside = seed, outside = seed + dir * STEP, steps = 0;
    while (greens(nominalYaw + outside) && steps++ < 400) {
      inside = outside; outside += dir * STEP;
    }
    for (let i = 0; i < 12; i++) {
      const mid = (inside + outside) / 2;
      if (greens(nominalYaw + mid)) inside = mid; else outside = mid;
    }
    return inside;
  };
  const lo = edge(-1), hi = edge(1);
  return { yaw: nominalYaw + (lo + hi) / 2, width: Math.abs(hi - lo) };
}

// The banks.js table descriptor for this table's geometry + cushion physics.
function bankTable() {
  return {
    R, PW, PH, LIMX, LIMZ, CORNER_GAP, SIDE_GAP, POCKETS,
    REST: REST_CUSH, GRIP: CUSH_GRIP,
  };
}
const liveBalls = () => balls.filter(b => b.id !== 0 && !b.potted);

/* The oracle tuneAim searches with, chosen by how the shot gets there:
     direct — the aim-assist's green-pocket predictor,
     bank   — the object still has to reach that pocket, but off one cushion,
     kick   — no pot at all: the cue just has to contact the intended ball
              first after one cushion (a legal hit instead of a foul).
   Returns null when there's nothing meaningful to tune against. */
function botAimTest(decision) {
  const AA = window.AimAssist, B = window.PoolBanks;
  const aimAt = yaw => {
    const dx = -Math.sin(yaw), dz = -Math.cos(yaw);
    return { dx, dz, hit: castAim(cue.x, cue.z, dx, dz) };
  };

  if (decision.via === 'kick') {
    if (!B || decision.target == null) return null;
    return yaw => {
      const { dx, dz } = aimAt(yaw);
      const b = B.ballAfterKick(bankTable(), { x: cue.x, z: cue.z }, { x: dx, z: dz }, liveBalls());
      return !!b && b.id === decision.target;
    };
  }

  if (decision.pocket == null) return null;

  if (decision.via === 'bank') {
    if (!B) return null;
    return yaw => {
      const { dx, dz, hit } = aimAt(yaw);
      if (!hit.ball || hit.ball.id !== decision.target) return false;
      // The object leaves along contact-point -> its centre, same as the direct
      // predictor, then has to survive one cushion to reach the pocket.
      const gx = cue.x + dx * hit.t, gz = cue.z + dz * hit.t;
      let ox = hit.ball.x - gx, oz = hit.ball.z - gz;
      const ol = Math.hypot(ox, oz) || 1;
      const from = { x: hit.ball.x, z: hit.ball.z };
      const p = B.pocketAfterBank(bankTable(), from, { x: ox / ol, z: oz / ol },
        liveBalls(), hit.ball.id);
      return p === decision.pocket;
    };
  }

  if (!AA || !AA.predictPocket) return null;
  return yaw => {
    const { dx, dz, hit } = aimAt(yaw);
    if (!hit.ball) return false;
    // The tuned aim has to still strike the ball the shot was planned on. Left
    // open, tuning could slide onto a neighbour that happens to reach the same
    // pocket — a foul in 9-ball, where only the lowest ball is legal to hit.
    if (decision.target != null && hit.ball.id !== decision.target) return false;
    return AA.predictPocket(hit, cue.x + dx * hit.t, cue.z + dz * hit.t) === decision.pocket;
  };
}

// Kick off the computer's turn after a short "thinking" pause. Called after
// every resolved shot in bot mode when the table has passed to the computer.
function scheduleBotTurn() {
  clearBotTimer();
  // Long enough to read the computer's reaction to the previous shot before it
  // starts talking about the next one.
  botTimer = setTimeout(runBotTurn, 1100);
}

// Build the plain snapshot js/bot.js reasons over (no Three.js objects).
function botContext(phase) {
  return {
    R, PW, PH, LIMX, LIMZ, POCKETS,
    // Cushion gaps + restitution, so js/banks.js can work out one-rail paths.
    CORNER_GAP, SIDE_GAP, REST: REST_CUSH, GRIP: CUSH_GRIP,
    // The rest of the physics, so js/position.js can replay physicsStep for one
    // ball and tell the bot where the cue will finish. Passed rather than copied
    // so there stays exactly one source of truth for these.
    REST_BALL, FRIC_C, FRIC_L, STOP_V, MAX_V, PHYS_H,
    cue: { x: cue.x, z: cue.z },
    balls: balls.filter(b => b.id !== 0 && !b.potted).map(b => ({ id: b.id, x: b.x, z: b.z })),
    group: players[turn].group,
    onEight: gameMode === '8ball' && isOnEight(turn),
    // In 9-ball the only legal target is the lowest ball on the table; passing it
    // is what switches bot.js off 8-ball's suits and onto rotation. Null (not 0)
    // in 8-ball, where suits decide instead.
    lowestId: gameMode === '9ball' ? lowestBall() : null,
    phase,
    breakShot,
  };
}

// The computer decides and plays its shot: place the cue if it has ball-in-hand,
// nominate a pocket if it's on the 8, then line up the ghost cue and strike.
function runBotTurn() {
  botTimer = null;
  if (!isBotSeat(turn) || state === S.END) return;

  const placing = state === S.PLACING;
  let decision;
  try { decision = window.PoolBot && window.PoolBot.chooseShot(botContext(placing ? 'place' : 'aim')); }
  catch (e) { console.error('Bot decision failed:', e); }
  if (!decision) decision = { yaw: cam.yaw, sigma: 0, power: 0.4 }; // defensive fallback

  if (placing) {
    if (decision.place) {
      cue.x = decision.place.x; cue.z = decision.place.z;
      cue.vx = cue.vz = 0; cue.potted = false; cue.sink = 0;
      setBallVisual(cue);
    }
    hidePlaceGhost();
    unpinToast();
  }
  state = S.AIM;
  exitSurveyCam();

  // Fine-tune the nominal aim against whichever oracle fits this shot (green
  // pocket / bank / kick), then apply the skill wobble on top.
  let aimYaw = decision.yaw;
  let sigma = decision.sigma || 0;
  const works = decision.safe ? null : botAimTest(decision);
  if (works) {
    const { yaw, width } = tuneAim(decision.yaw, works);
    aimYaw = yaw;
    // Scale the wobble to the pot's make-window. Unclamped, the skill noise
    // (~0.2-0.6°) dwarfs a typical window and every shot is a coin flip
    // regardless of difficulty. Tying sigma to the half-window keeps the miss
    // rate roughly constant in "fraction of the window" terms, so difficulty
    // comes from the geometry: a wide-window pot is reliable, a thin one is
    // genuinely missable. BOT_SKILL is the fraction of the half-window that is
    // 1σ — smaller means a stronger bot. This REPLACES the geometric sigma
    // rather than capping it: the window already encodes the shot's difficulty,
    // so keeping the larger raw value on wide-window pots would just reintroduce
    // misses on the easy shots the bot is meant to make.
    if (width > 0) sigma = (width / 2) * BOT_SKILL;
  }
  aimYaw = gaussianYaw(aimYaw, sigma);

  // On the 8-ball the computer nominates a pocket (the same gold call marker the
  // human uses) so resolveShot judges it as a called shot. It must call even when
  // snookered — the shot itself may be a kick or safety with no pot in mind, and
  // bot.js supplies `callPocket` for exactly that case. Without it a fluked 8
  // would count as an uncalled "clean finish" win the human could never get.
  // 9-ball calls nothing — the 9 wins in any pocket — so this is 8-ball only.
  let forcedCall = null;   // a call made without a pot in mind (snookered on the 8)
  if (gameMode === '8ball' && isOnEight(turn)) {
    const aimed = decision.pocket != null && decision.pocket >= 0;
    const call = aimed ? decision.pocket : decision.callPocket;
    if (call != null && call >= 0) {
      setCalledPocket(call);
      if (!aimed) forcedCall = call;
    }
  }

  // Announce the plan, then hold before drawing the cue back so there's time to
  // read it and look at the table the computer is describing.
  botSay(window.PoolBotTalk && window.PoolBotTalk.intent(decision, {
    game: gameMode, breakShot, onEight: gameMode === '8ball' && isOnEight(turn),
    ballInHand: placing, forcedCall,
  }));
  clearBotTimer();
  botTimer = setTimeout(() => {
    botTimer = null;
    if (!isBotSeat(turn) || state === S.END) return;
    botAimTo(aimYaw, () => botStrike(decision.power, aimYaw));
  }, BOT_READ_MS);
}

// Put a line from the computer in the in-match chat box (js/chat.js), which
// vs-CPU opens read-only as a commentary feed.
function botSay(text) {
  if (!botMode || !text || !window.PixelPoolChat) return;
  window.PixelPoolChat.receive(text);
}

// Add ~N(0, sigma) aim noise (sum of three uniforms ≈ normal) — the bot's skill.
function gaussianYaw(yaw, sigma) {
  if (!sigma) return yaw;
  const n = (Math.random() + Math.random() + Math.random() - 1.5) / 0.5;
  return yaw + n * sigma;
}

// Smoothly swing the ghost cue from wherever it was to the chosen heading, then
// run `done` (the strike). Renders via updateGhostCue reading botAim.
function botAimTo(targetYaw, done) {
  const startYaw = botAim ? botAim.yaw : targetYaw - 0.55;
  botAim = { yaw: startYaw, pull: 0 };
  const start = performance.now(), dur = 750;
  (function anim() {
    if (!isBotSeat(turn) || state === S.END) { botAim = null; return; }
    const t = Math.min(1, (performance.now() - start) / dur);
    const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; // easeInOutQuad
    botAim.yaw = lerpAngle(startYaw, targetYaw, e);
    if (t >= 1) { done(); return; }
    requestAnimationFrame(anim);
  })();
}

// The computer's stroke: draw the ghost cue back, thrust, then launch the cue
// ball and hand off to the shared local physics (no network in bot mode).
function botStrike(power, yaw) {
  if (!isBotSeat(turn) || state === S.END) return;
  const d = new THREE.Vector2(-Math.sin(yaw), -Math.cos(yaw));
  if (window.MatchStats) window.MatchStats.beginShot(statsLayout(), { x: round4(d.x), z: round4(d.y) });
  botAim = { yaw, pull: 0 };
  botStriking = true; // owns the ghost stick; keep state S.AIM so the cam stays low
  striking = true;    // gate resolveShot until the ball is actually launched
  const back = new THREE.Vector3(-d.x, 0.14, -d.y).normalize();
  const base = new THREE.Vector3(cue.x, BALL_Y, cue.z);
  const pull0 = 0.05 + power * MAX_PULL;
  const drawMs = 300, hitMs = 70, start = performance.now();
  (function anim() {
    if (state === S.END) { botStriking = false; ghostStick.visible = false; return; }
    const el = performance.now() - start;
    let pull;
    if (el < drawMs) pull = pull0 * (el / drawMs);              // draw back
    else if (el < drawMs + hitMs) pull = pull0 * (1 - (el - drawMs) / hitMs); // thrust
    else {                                                       // contact
      botStriking = false;
      ghostStick.visible = false;
      state = S.ROLLING;
      launchCue(d.x, d.y, power);
      return;
    }
    ghostStick.position.copy(base).addScaledVector(back, cueRest() + pull);
    ghostStick.lookAt(base.clone().addScaledVector(back, 5));
    ghostStick.visible = true;
    requestAnimationFrame(anim);
  })();
}

// Shortest-arc interpolation between two angles (radians).
function lerpAngle(a, b, t) {
  let d = (b - a) % (2 * Math.PI);
  if (d > Math.PI) d -= 2 * Math.PI;
  if (d < -Math.PI) d += 2 * Math.PI;
  return a + d * t;
}

/* ---------------------------- shot resolution --------------------------- */

// Compact table layout for the recap play-by-play (js/stats.js): one row per
// ball, same shape as serializeState()'s ball list.
function statsLayout() {
  return balls.map(b => [b.id, round4(b.x), round4(b.z), b.potted ? 1 : 0]);
}

/* --------------------------- snooker: nominate -------------------------- */
// After a red goes down the striker names the colour they're on, which fixes
// both the legal first contact and the value of a foul. The sibling of 8-ball's
// pocket call (S.CALLING), and the picker is built once from the rules module
// so its swatches and values can never drift from the balls themselves.
const nomPanel = document.getElementById('nominate');

function buildNominate() {
  const row = document.getElementById('nomRow');
  if (!row || row.children.length) return;
  for (const id of SNK.COLOURS) {
    const b = document.createElement('button');
    b.className = 'nomBtn';
    b.innerHTML = '<span class="nomBall"></span><span class="nomName"></span><b></b>';
    b.querySelector('.nomBall').style.background = SNK.hex(id);
    b.querySelector('.nomName').textContent = SNK.name(id);
    b.querySelector('b').textContent = SNK.value(id);
    b.addEventListener('click', () => nominate(id));
    row.appendChild(b);
  }
}

function showNominate(on) {
  if (nomPanel) nomPanel.classList.toggle('hidden', !on);
}

function nominate(id) {
  if (state !== S.NOMINATE || balls[id].potted) return;
  snooker.st.nominated = id;
  showNominate(false);
  state = S.AIM;
  unpinToast();
  toast(`On the ${SNK.name(id)} — worth ${SNK.value(id)}`);
  updateHUD();
}

/* -------------------------- snooker: ball in hand ----------------------- */
// The cue ball goes back in the D — the only place snooker ever lets a player
// put it (the frame's opening stroke, an in-off, or a re-spotted black). Reuses
// S.PLACING; updatePlaceGhost is what actually enforces the D.
function beginInHand(msg) {
  const L = SNK.layout({ PW, PH, R });
  cue.potted = true;            // off the table until the player places it
  cue.sink = 0; cue.vx = 0; cue.vz = 0;
  cue.x = L.baulkX - L.dR * 0.35; cue.z = L.dR * 0.55;
  cue.mesh.visible = false;
  showNominate(false);
  state = S.PLACING;
  lastFoul = msg;
  pinToast(msg);
  enterSurveyCam();             // bird's-eye, so the whole D is in view
}

/* --------------------------- snooker resolution ------------------------- */
// Snooker's stroke resolution. The rules themselves live in js/snooker.js; this
// feeds it the stroke, banks the points, puts back whatever has to come back,
// and reuses the pool games' turn-passing and end-screen machinery unchanged.
function resolveShotSnooker() {
  const shooter = turn;
  const me = players[shooter];
  breakShot = false;

  // The ball on as it stood BEFORE the stroke — take this stroke's own pots
  // back out, exactly as 9-ball does, or potting the ball on would drop it out
  // of the legal set and the pot would read as a foul.
  const on = SNK.ballOn(snooker.st,
    id => balls[id].potted && shotEvents.potted.indexOf(id) < 0);
  // Reds never come back, foul or not, so the live count is already the final one.
  const redsAfter = SNK.REDS.reduce((k, id) => k + (balls[id].potted ? 0 : 1), 0);

  const out = SNK.resolve({
    potted: shotEvents.potted,
    scratch: shotEvents.scratch,
    firstHit: shotEvents.firstHit,
    on, redsAfter,
  });

  snooker.scores[shooter] += out.points;
  snooker.scores[1 - shooter] += out.penalty;

  // Log the stroke BEFORE anything is re-spotted: the recap's LAYOUT tab works
  // out what dropped by diffing the before/after boards, so a colour put back
  // in the same breath would erase the pot from the log.
  if (window.MatchStats) {
    window.MatchStats.recordShot(shooter, out.credited, out.foulKind, statsLayout());
  }

  // Colours that have to come back go highest-value first, so a high ball is
  // never shoved off its own spot by a lower one queued ahead of it.
  for (const id of out.respot.slice().sort((a, b) => SNK.value(b) - SNK.value(a))) {
    spotBall(id);
  }

  snooker.st = out.next;
  if (out.frameOver) return finishFrame();

  if (out.foul) {
    turn = 1 - shooter;
    cue.vx = 0; cue.vz = 0;
    const line = `${SNK.foulText(out.foulKind, on)} ${out.penalty} to ${players[turn].cfg.name}.`;
    // Snooker has no ball in hand: the incoming player plays from wherever the
    // cue ball stopped. Only an in-off puts it back in the D.
    if (shotEvents.scratch) beginInHand(`${line} Place the cue ball in the D.`);
    else { toast(line, 3600); enterAim(); }
  } else if (out.keepTurn) {
    enterAim();  // S.NOMINATE if a red just went down, else straight to aiming
    const scored = `${isMe(shooter) ? 'You score' : me.cfg.name + ' scores'} ${out.points}`;
    if (state === S.NOMINATE) {
      pinToast(`${scored} — now nominate a colour.`);
    } else {
      toast(`${scored} — ${snooker.scores[shooter]} on the board.`);
    }
  } else {
    turn = 1 - shooter;
    enterAim();
    toast(isMe(turn) ? 'Your visit' : `${players[turn].cfg.name} to play`);
  }
  updateHUD();
}

// The frame is decided: once only the black is left, the first score or foul
// settles it. Level scores are the one case where "frame over" isn't — the
// black goes back up and play continues.
function finishFrame() {
  const [a, b] = snooker.scores;
  const line = `${players[0].cfg.name} ${a} — ${b} ${players[1].cfg.name}.`;
  if (a !== b) return endGame(a > b ? 0 : 1, `Frame decided on the black. ${line}`);
  // Re-spotted black: the rules call for a toss to decide who plays from in
  // hand, and the next score or foul ends the frame.
  if (balls[SNK.BLACK].potted) spotBall(SNK.BLACK);
  snooker.st = { phase: 'sequence', nominated: 0 };
  turn = Math.random() < 0.5 ? 0 : 1;
  beginInHand(`Scores level at ${a} — black re-spotted. ${players[turn].cfg.name} plays from the D.`);
  updateHUD();
}

// 9-ball's stroke resolution. The rules themselves live in js/nineball.js;
// this just feeds it the stroke and applies the verdict, reusing 8-ball's
// ball-in-hand, turn-passing and end-screen machinery unchanged.
function resolveShotNine() {
  const N = window.PoolNineBall;
  const me = players[turn];
  const wasBreak = breakShot; breakShot = false;

  // The target is the lowest ball as it stood BEFORE the stroke — take this
  // shot's own pots back out, or sinking the target would retarget the
  // legality check onto the next ball up and read as a wrong-ball foul.
  const target = N.lowest(id => balls[id].potted && shotEvents.potted.indexOf(id) < 0);
  const out = N.resolve({
    potted: shotEvents.potted,
    scratch: shotEvents.scratch,
    firstHit: shotEvents.firstHit,
    cushion: shotEvents.cushion,
    target,
  });

  if (window.MatchStats) {
    window.MatchStats.recordShot(turn, out.credited, out.foulKind, statsLayout());
  }

  // The computer's take on how that went — before the win return below, so it
  // still gets the last word on the shot that decides the match. There's no
  // `lost` case in 9-ball: an illegally pocketed 9 is spotted, not a loss.
  if (isBotSeat(turn) && window.PoolBotTalk) {
    botSay(window.PoolBotTalk.reaction({
      potted: out.credited, foul: out.foul, scratch: out.foulKind === 'scratch',
      won: out.win, spotNine: out.spotNine,
    }));
  }

  if (out.win) {
    return endGame(turn, wasBreak
      ? `${me.cfg.name} sank the 9-ball on the break!`
      : `${me.cfg.name} sank the 9-ball.`);
  }
  // A 9 pocketed on a foul was never really potted — put it straight back.
  if (out.spotNine) spotBall(9);

  if (out.foul) {
    turn = 1 - turn;
    cue.vx = 0; cue.vz = 0;
    lastFoul = `${N.foulText(out.foulKind, target)} ${players[turn].cfg.name}: ball in hand`;
    if (myTurn()) { pinToast(lastFoul); enterSurveyCam(); } else toast(lastFoul);
    state = S.PLACING;
  } else {
    if (!out.keepTurn) turn = 1 - turn;
    enterAim();
    if (out.keepTurn) toast(isMe(turn) ? 'You shoot again' : `${me.cfg.name} shoots again`);
  }
  updateHUD();
}

function resolveShot() {
  if (gameMode === 'snooker') return resolveShotSnooker();
  if (gameMode === '9ball') return resolveShotNine();
  const me = players[turn], opp = players[1 - turn];
  const potted = shotEvents.potted;
  const scratch = shotEvents.scratch;
  const potted8 = potted.includes(8);
  const wasBreak = breakShot; breakShot = false;

  // Contact legality, classified up front (before the game-ending early
  // returns below) so the stats recorder sees every stroke. The cue ball's
  // first strike must be a ball of the shooter's group — any ball but the 8 on
  // an open table, or the 8 itself once the group is cleared. Touching nothing
  // at all is a foul too.
  // Note: groupOf(8) reports 'stripe', so the 8 must be excluded explicitly —
  // otherwise hitting it first would look legal to the stripes player.
  const first = shotEvents.firstHit;
  // Was the shooter already down to just the 8 BEFORE this shot? Use the pre-shot
  // count (add back this shot's own-group pots), otherwise sinking the last group
  // ball drops remaining() to 0 and the legal hit reads as an illegal 8-first.
  const ownPotted = me.group ? potted.filter(id => id !== 8 && groupOf(id) === me.group).length : 0;
  const wasOnEight = me.group && remaining(me.group) + ownPotted === 0;
  const legalContact = first !== null && (
    wasOnEight ? first === 8
      : me.group ? (first !== 8 && groupOf(first) === me.group)
        : first !== 8);
  const foul = scratch || !legalContact;

  // Did this stroke sink the 8 LEGALLY — i.e. is it the shot that wins? Mirrors
  // the win conditions below exactly: no scratch, and either it found the pocket
  // the shooter nominated, or (uncalled) their group was cleared. Sinking the 8
  // early, or in the wrong pocket, loses the game and is no one's "pot".
  const clearedOwn = !!me.group && remaining(me.group) === 0;
  const legal8 = potted8 && !scratch && (calledPocket >= 0
    ? shotEvents.eightPocket === calledPocket
    : clearedOwn);

  // Stats: log the stroke. "Balls pocketed" counts the shooter's own group
  // (every object ball but the 8 while the table is still open), plus the 8
  // itself on the winning stroke — clearing the table is 8 balls, not 7.
  const credited = (me.group ? ownPotted : potted.filter(id => id !== 8).length) + (legal8 ? 1 : 0);
  if (window.MatchStats) window.MatchStats.recordShot(turn, credited,
    scratch ? 'scratch' : first === null ? 'noContact' : !legalContact ? 'wrongBall' : null,
    statsLayout());

  // The computer's take on how that went. Runs before the game-ending returns
  // below, so it still gets the last word on the shot that decides the match.
  if (isBotSeat(turn) && window.PoolBotTalk) {
    botSay(window.PoolBotTalk.reaction({
      potted: credited, foul, scratch, legal8,
      won: legal8,
      lost: potted8 && !legal8,   // sank the 8 early / in the wrong pocket
    }));
  }

  // A called 8-ball shot (the shooter was on the 8 and nominated a pocket).
  if (calledPocket >= 0) {
    // Pocketing the cue ball and the 8 on the same stroke loses, whichever
    // pocket the 8 found. But a scratch with the 8 left standing is NOT a loss
    // under WPA rules — it's just a foul: play continues and the opponent gets
    // ball-in-hand, so it falls through to the foul handling below.
    if (scratch && potted8) return endGame(1 - turn, `${me.cfg.name} pocketed the cue ball with the 8.`);
    if (potted8) {
      return shotEvents.eightPocket === calledPocket
        ? endGame(turn, `${me.cfg.name} sank the 8-ball in the called pocket.`)
        : endGame(1 - turn, `${me.cfg.name} sank the 8-ball in the wrong pocket.`);
    }
    // 8 stayed up: a scratch becomes a ball-in-hand foul, a clean miss just
    // passes the turn — both handled below.
  } else if (potted8) {
    // 8 dropped while balls of the group remained, or on the very shot the group
    // cleared (`clearedOwn`, hoisted above for the stats credit). Same-shot clear
    // counts as a clean finish; otherwise it's a loss.
    if (clearedOwn && !scratch) {
      return endGame(turn, `${me.cfg.name} sank the 8-ball. Clean finish!`);
    }
    const why = scratch ? 'scratched while sinking the 8-ball' : 'sank the 8-ball too early';
    return endGame(1 - turn, `${me.cfg.name} ${why}.`);
  }

  // Group assignment. The table stays open through the break, and a set is
  // assigned only when every object ball dropped on a single legal shot belongs
  // to the same group (the 8 never counts). Sink a solid AND a stripe together —
  // or pot anything on the break — and both players stay "no group yet" until
  // someone sinks from just one group.
  if (!me.group && !foul && !wasBreak) {
    const objectPots = potted.filter(id => id !== 8);
    const hasSolid = objectPots.some(id => id < 8);
    const hasStripe = objectPots.some(id => id > 8);
    if (hasSolid !== hasStripe) { // exactly one group present
      me.group = hasSolid ? 'solid' : 'stripe';
      opp.group = me.group === 'solid' ? 'stripe' : 'solid';
      const grp = me.group === 'solid' ? 'SOLIDS' : 'STRIPES';
      toast(isMe(turn) ? `You're ${grp}` : `${me.cfg.name} is ${grp}`);
    }
  }

  const pottedOwn = potted.some(id => me.group ? groupOf(id) === me.group : true);
  const keepTurn = !foul && potted.length > 0 && pottedOwn;

  if (foul) {
    turn = 1 - turn;
    cue.vx = 0; cue.vz = 0;
    setCalledPocket(-1); // clear any stale 8-ball call from the fouling player
    lastFoul = scratch
      ? `Scratch! ${players[turn].cfg.name}: place the cue ball`
      : `Foul — ${first === null ? 'no contact' : 'incorrect first contact'}! ${players[turn].cfg.name}: ball in hand`;
    if (myTurn()) { pinToast(lastFoul); enterSurveyCam(); } else toast(lastFoul);
    state = S.PLACING;
  } else {
    if (!keepTurn) turn = 1 - turn;
    enterAim(); // S.CALLING if the next shooter is on the 8-ball, else S.AIM
    if (state === S.CALLING) {
      const callMsg = isMe(turn)
        ? `Only the 8-ball left — tap the pocket you'll call`
        : `Only the 8-ball left — ${players[turn].cfg.name}: tap the pocket you'll call`;
      if (myTurn()) pinToast(callMsg); else toast(callMsg, 30000);
    } else if (keepTurn) {
      toast(isMe(turn) ? 'You shoot again' : `${me.cfg.name} shoots again`);
    }
  }
  updateHUD();
}

// Clear the finished match's leftover ball layout so the scene behind the
// end-of-game overlay shows a fresh rack, not whatever state the last shot
// left on the felt. Table style and background are left as the players chose.
function resetSceneAfterGame() {
  rackBalls();
  hidePlaceGhost();
  setCalledPocket(-1); // hide the 8-ball call ring
  showNominate(false); // and snooker's colour picker
  document.getElementById('help').classList.add('hidden');
  exitSurveyCam(); // don't leave the bird's-eye view stuck if the match ended mid-decision (forfeit)
}

function endGame(winner, reason) {
  state = S.END;
  clearBotTimer(); // stop any pending computer turn
  lastEnd = { winner, reason };
  if (window.MatchStats) window.MatchStats.finalize(winner, reason);
  document.getElementById('endTitle').textContent = endTitleFor(winner);
  document.getElementById('endReason').textContent = reason;
  document.getElementById('endOverlay').classList.remove('hidden');
  resetSceneAfterGame();
  updateHUD();
}

// Concede the match (the FORFEIT button in the settings panel, js/settings.js).
// Offline the current shooter concedes — it's hot-seat, so whoever holds the
// table gives it up; online it's always the local seat, and the result rides
// the usual authoritative 'state' message so the opponent's client shows the
// same end screen (see applyState's 'end' phase).
function forfeit() {
  if (state === S.SETUP || state === S.END) return;
  // Online or vs-CPU, the local human concedes; hot-seat, whoever holds the table.
  const loser = (onlineMode || botMode) ? mySeat : turn;
  for (const b of balls) { b.vx = 0; b.vz = 0; } // halt any mid-shot motion
  unpinToast(); // release any "place the cue ball" / "call a pocket" prompt
  endGame(1 - loser, `${players[loser].cfg.name} forfeited the match.`);
  if (onlineMode) netSend(serializeState('end'));
}
// Pick the rule set for the NEXT match ('8ball' | '9ball'), from the home
// screen's game tabs (js/mode.js). A match already underway keeps its own
// rules; on the home screen the showcase table re-racks so the player can see
// which game they picked. The computer opponent plays both games, so the
// offline setup toggle carries over untouched.
function setGame(id) {
  if (!GAME_HELP[id] || id === gameMode) return;
  // Only between matches. The rule set now brings its own BED with it, and a
  // rack laid out on one is meaningless on the other — an 8-ball rack sits
  // wider than snooker's cushions, so switching under a live match would strand
  // balls off the table. The game tabs are only reachable from the home screen,
  // where QUIT has already put us back in S.SETUP, so this costs nothing.
  if (state !== S.SETUP) return;
  gameMode = id;
  // Snooker plays on its own bed (see TABLE_PROFILES). Changing it invalidates
  // the ball geometry, the table mesh and the chalked markings alike, so all
  // three are re-cut before anything reads the new numbers.
  if (applyTableProfile(profileFor(id))) {
    rebuildBallGeometry();
    dropSnookerMarks();
    setTableStyle(currentTableStyle);
  }
  setSnookerMarkings(id === 'snooker');
  // Snooker is two-player only for now — the computer opponent (js/bot.js)
  // reasons about suits and rotation, not about reds, colours and nominations —
  // so the OFFLINE setup toggle is forced back to hot-seat and locked there.
  const cpuBtn = document.getElementById('vsCpuBtn');
  if (cpuBtn) cpuBtn.classList.toggle('locked', id === 'snooker');
  if (id === 'snooker' && vsCPU) setVsCPU(false);
  rackBalls();     // the showcase table behind the menu shows the chosen game
  updateHUD();
}

window.PoolMatch = {
  forfeit, setGame, game: () => gameMode,
  // The live physics constants, for the headless tools in tools/. They rebuild
  // the descriptor js/physics.js runs on plus the stroke constants, so a shot
  // simulated offline uses the same numbers the game just used.
  physics: () => Object.assign({}, physTable(), {
    POCKETS: POCKETS.map(p => ({ x: p.x, z: p.z, r: p.r })),
    MAX_V, PHYS_H, BREAK_BOOST, BALL_SCALE,
  }),
};

// Headline the help card with the rules of the game being played, so a player
// opening 9-ball for the first time doesn't have to guess the win condition.
const GAME_HELP = {
  '8ball': ['8-BALL', 'Pot your group, then the 8 in a pocket you call.'],
  '9ball': ['9-BALL', 'Hit the lowest ball first. Pot the 9 — any time — to win.'],
  snooker: ['SNOOKER', 'Red (1) then a colour you nominate, over and over. '
    + 'When the reds run out, take the colours in order: yellow 2, green 3, '
    + 'brown 4, blue 5, pink 6, black 7. Fouls give away 4 or more. Highest '
    + 'score when the black goes down wins the frame.'],
};
function showGameHelp() {
  const [title, rules] = GAME_HELP[gameMode];
  const headEl = document.getElementById('helpGameHead');
  const textEl = document.getElementById('helpGame');
  if (headEl) headEl.textContent = title;
  if (textEl) textEl.textContent = rules;
}

function startMatch() {
  onlineMode = false;          // local match: full control, random rack
  // Snooker has no computer opponent yet, so it is always hot-seat.
  botMode = vsCPU && gameMode !== 'snooker';
  mySeat = 0; botSeat = 1;     // the human is seat 0
  clearBotTimer(); botAim = null; botStriking = false;
  rng = Math.random;
  players[0].group = null;
  players[1].group = null;
  snooker.scores = [0, 0]; // a fresh frame; rackBalls resets the targeting state
  if (botMode) players[1].cfg.name = 'Computer';
  // Vs-CPU: a 50/50 coin flip decides who breaks each game. Hot-seat and online
  // keep player 1 / the breaker seat as before.
  if (!botMode) turn = 0;
  else if (forceBotBreak) turn = botSeat;                 // test override
  else turn = Math.random() < 0.5 ? mySeat : botSeat;
  if (window.MatchStats) window.MatchStats.begin([players[0].cfg.name, players[1].cfg.name]);
  rackBalls();
  shotEvents = { potted: [], scratch: false, firstHit: null, cushion: false, eightPocket: -1 };
  setCalledPocket(-1);
  pinnedMsg = null; // clear any prompt pinned from a previous game
  hidePlaceGhost(); // and any ball-in-hand preview from the last one
  showRating(null); // clear any Elo swing left from a previous online match
  state = S.AIM;
  cam.yaw = -Math.PI / 2; cam.pitch = START_PITCH; cam.radius = START_RADIUS; // first-person: low, just behind the cue ball
  yawBeforeSurvey = null; // a fresh match starts clean, never mid-survey
  document.getElementById('hud').classList.remove('hidden');
  document.getElementById('help').classList.remove('hidden');
  if (window.SettingsPanel) window.SettingsPanel.show();
  document.getElementById('styleName').textContent = TABLE_STYLES[currentTableStyle].name.toUpperCase();
  showGameHelp();
  // Snooker opens with the cue ball in hand from the D, as every frame does.
  if (gameMode === 'snooker') {
    beginInHand(`${players[turn].cfg.name} breaks — place the cue ball in the D.`);
  } else {
    toast(isMe(turn) ? `You break. Drag back from the cue ball to shoot.`
      : botMode ? `${players[turn].cfg.name} breaks…`
        : `${players[turn].cfg.name} breaks. Drag back from the cue ball to shoot.`);
  }
  updateHUD();
  // Vs-CPU borrows the online match chat as a one-way commentary feed: the
  // computer narrates each shot (js/bottalk.js), so the composer stays hidden.
  if (window.PixelPoolChat) {
    if (botMode) window.PixelPoolChat.show('Computer', {
      readOnly: true, placeholder: 'The computer will talk you through its shots…',
    });
    else window.PixelPoolChat.hide();
  }
  if (isBotSeat(turn)) scheduleBotTurn(); // the computer breaks
}

/* ============================== ONLINE PLAY ============================= */
// See the "online" state block above. game.js owns all game logic (including
// the opponent-snapshot interpolation); js/online.js is just the relay to the
// socket. Messages: aim, shoot, snap (mid-shot), state (authoritative result).

const round4 = v => Math.round(v * 1e4) / 1e4;
const nowSec = () => performance.now() / 1000;

function setBallVisual(b) {
  if (b.potted) { b.mesh.visible = false; b.sink = 0; }
  else {
    b.mesh.visible = true; b.mesh.scale.setScalar(1);
    b.mesh.position.set(b.x, BALL_Y, b.z);
  }
}

// ---- outbound (my turn) ----
function maybeSendAim() {
  const nowMs = performance.now();
  if (nowMs - lastAimT < 40) return; // cap ~25 Hz
  const pull = state === S.CHARGE ? chargePull : 0;
  const key = cam.yaw.toFixed(3) + ',' + pull.toFixed(3) + ',' + cue.x.toFixed(3) + ',' + cue.z.toFixed(3);
  if (key === lastAimKey) return;
  lastAimT = nowMs; lastAimKey = key;
  netSend({ t: 'aim', yaw: cam.yaw, pull, cx: round4(cue.x), cz: round4(cue.z) });
}
function maybeSendSnap(nowMs) {
  if (nowMs - lastSnapT < 50) return; // ~20 Hz
  lastSnapT = nowMs;
  netSend({ t: 'snap', b: balls.filter(b => !b.potted).map(b => [b.id, round4(b.x), round4(b.z)]) });
}
function serializeState(phase) {
  const msg = {
    t: 'state', phase, turn,
    groups: [players[0].group, players[1].group],
    b: balls.map(b => [b.id, round4(b.x), round4(b.z), b.potted ? 1 : 0]),
  };
  // Running match-stats tally rides along so the watcher's recap stays in sync
  // (only the resolving client mutates it — see js/stats.js).
  if (window.MatchStats) msg.stats = window.MatchStats.snapshot();
  if (phase === 'end' && lastEnd) { msg.winner = lastEnd.winner; msg.reason = lastEnd.reason; }
  if (phase === 'place') msg.foul = lastFoul;
  return msg;
}
// Called right after resolveShot() on the shooter's client.
function onlineAfterResolve() {
  const phase = state === S.END ? 'end' : (state === S.PLACING ? 'place' : 'aim');
  netSend(serializeState(phase));
  lastAimKey = '';
  if (state !== S.END && !myTurn()) {
    // Turn passed to the opponent — I become the watcher.
    state = S.AIM;
    remoteAim = null; ghostStick.visible = false; watcherStriking = false; snapBuf = [];
  }
}

// ---- inbound (opponent's turn) ----
function apply(msg) {
  if (!onlineMode || !msg) return;
  if (msg.t === 'aim') applyAim(msg);
  else if (msg.t === 'shoot') applyShoot(msg);
  else if (msg.t === 'snap') applySnap(msg);
  else if (msg.t === 'pot') applyPot(msg);
  else if (msg.t === 'setup') applySetup(msg);
  else if (msg.t === 'call') applyCall(msg);
  else if (msg.t === 'state') applyState(msg);
}
// Opponent nominated a pocket for their 8-ball shot — show the same marker.
function applyCall(msg) {
  setCalledPocket(msg.p);
  toast(`${players[turn].cfg.name} called a pocket for the 8-ball.`);
}
function applyAim(msg) {
  remoteAim = { yaw: msg.yaw, pull: msg.pull || 0, cx: msg.cx, cz: msg.cz };
  if (msg.cx != null) { // reflect cue position (covers ball-in-hand placement)
    cue.x = msg.cx; cue.z = msg.cz; cue.vx = cue.vz = 0;
    cue.potted = false; cue.sink = 0; setBallVisual(cue);
  }
  if (state !== S.ROLLING) state = S.AIM;
}
function applyShoot(msg) {
  remoteAim = null;
  state = S.ROLLING;
  // seed the interpolation buffer with the current layout as the first frame
  snapBuf = [{ t: nowSec(), pos: ballPosMap() }];

  // Mirror fire()'s quick thrust animation on the ghost cue, so the watcher
  // sees an actual strike instead of the ball just starting to move on its
  // own. The ~100ms render delay in interpSample() means ball motion won't be
  // visible yet anyway, giving this plenty of room to play out first.
  watcherStriking = true;
  const yaw = msg.yaw;
  const pull0 = (msg.power || 0) * MAX_PULL;
  const d = new THREE.Vector2(-Math.sin(yaw), -Math.cos(yaw));
  const back = new THREE.Vector3(-d.x, 0.14, -d.y).normalize();
  const base = new THREE.Vector3(cue.x, BALL_Y, cue.z);
  const start = performance.now();
  const dur = 70;
  (function anim() {
    const t = (performance.now() - start) / dur;
    if (t >= 1) { watcherStriking = false; ghostStick.visible = false; return; }
    ghostStick.position.copy(base).addScaledVector(back, cueRest() + pull0 * (1 - t));
    ghostStick.lookAt(base.clone().addScaledVector(back, 5));
    ghostStick.visible = true;
    requestAnimationFrame(anim);
  })();
  sfx.strike(msg.power || 0);
}
function applySnap(msg) {
  const pos = {};
  for (const [id, x, z] of msg.b) pos[id] = [x, z];
  snapBuf.push({ t: nowSec(), pos });
  if (snapBuf.length > 24) snapBuf.shift();
}
// Opponent potted a ball — snap it to the pocket and play the sink animation
// (driven by syncBallMeshes), same as the shooter sees.
function applyPot(msg) {
  const b = balls[msg.id];
  if (!b || b.potted) return;
  if (msg.x != null) { b.x = msg.x; b.z = msg.z; b.mesh.position.set(b.x, BALL_Y, b.z); }
  b.potted = true; b.sink = 0.25; b.vx = b.vz = 0;
  sfx.pocket();
  announcePot(msg.id);
}
function applyState(msg) {
  for (const [id, x, z, potted] of msg.b) {
    const b = balls[id];
    b.x = x; b.z = z; b.vx = b.vz = 0; b.potted = !!potted; b.sink = 0;
    setBallVisual(b);
  }
  turn = msg.turn;
  players[0].group = msg.groups[0];
  players[1].group = msg.groups[1];
  if (msg.stats && window.MatchStats) window.MatchStats.applyRemote(msg.stats);
  remoteAim = null; ghostStick.visible = false; watcherStriking = false; snapBuf = [];
  striking = false; stick.visible = false; wasMoving = false; lastAimKey = '';
  hidePlaceGhost();    // a 'place' phase re-arms it on the next mouse move
  setCalledPocket(-1); // a new shot begins; any previous 8-ball call is cleared
  breakShot = false;   // the opponent has resolved a shot, so the break is over
  updateHUD();

  if (msg.phase === 'end') {
    state = S.END; lastEnd = { winner: msg.winner, reason: msg.reason };
    if (window.MatchStats) window.MatchStats.finalize(msg.winner, msg.reason);
    document.getElementById('endTitle').textContent = endTitleFor(msg.winner);
    document.getElementById('endReason').textContent = msg.reason || '';
    document.getElementById('endOverlay').classList.remove('hidden');
    resetSceneAfterGame();
  } else if (msg.phase === 'place') {
    state = S.PLACING;
    if (myTurn()) { pinToast('Ball in hand — place the cue ball'); enterSurveyCam(); }
    else toast(msg.foul || `${players[turn].cfg.name} fouled`);
  } else if (myTurn() && isOnEight(turn)) {
    state = S.CALLING;
    enterSurveyCam();
    pinToast(`Only the 8-ball left — tap the pocket you'll call`);
  } else {
    state = S.AIM;
    exitSurveyCam(); // defensive: no-op unless a survey was left running
    toast(myTurn() ? 'Your turn' : `${players[turn].cfg.name}'s turn`);
  }
}

function ballPosMap() {
  const pos = {};
  for (const b of balls) if (!b.potted) pos[b.id] = [b.x, b.z];
  return pos;
}

// ---- scene sync (table style + background) ----
// Broadcast this client's current table + background so the opponent's scene
// matches. Called by the breaker at match start and by either player on a
// mid-match change.
function sendSetup() {
  if (!onlineMode || applyingRemoteSetup) return;
  const bg = window.PoolBackgrounds ? window.PoolBackgrounds.current() : 0;
  netSend({ t: 'setup', table: currentTableStyle, bg });
}
function applySetup(msg) {
  applyingRemoteSetup = true;
  if (typeof msg.table === 'number') selectTableStyle(msg.table, false);
  if (typeof msg.bg === 'number' && window.PoolBackgrounds) window.PoolBackgrounds.apply(msg.bg, false, true);
  applyingRemoteSetup = false;
}
// Interpolate opponent ball positions from the snapshot buffer (a render-delay
// behind real time) for smooth motion despite ~20 Hz, jittery updates.
function interpSample() {
  if (snapBuf.length === 0) return;
  const renderT = nowSec() - RENDER_DELAY;
  let older = snapBuf[0], newer = snapBuf[snapBuf.length - 1];
  for (let i = 0; i < snapBuf.length - 1; i++) {
    if (snapBuf[i].t <= renderT && snapBuf[i + 1].t >= renderT) {
      older = snapBuf[i]; newer = snapBuf[i + 1]; break;
    }
  }
  const span = newer.t - older.t;
  const a = span > 1e-4 ? Math.max(0, Math.min(1, (renderT - older.t) / span)) : 1;
  for (const b of balls) {
    if (b.potted) continue;
    const o = older.pos[b.id], n = newer.pos[b.id];
    if (o && n) { b.x = o[0] + (n[0] - o[0]) * a; b.z = o[1] + (n[1] - o[1]) * a; }
    else if (n) { b.x = n[0]; b.z = n[1]; }
  }
}

// The floating cue shown while the local player spectates — driven by the online
// opponent's streamed aim, or by the computer's aim in vs-CPU mode. Both share
// the same ghost stick and POV; a strike animation temporarily owns the stick.
function updateGhostCue() {
  if (watcherStriking || botStriking) return; // a strike animation owns the stick now
  const aim = watching() ? remoteAim : (botTurn() ? botAim : null);
  if (aim && !cue.potted && state !== S.ROLLING) {
    const yaw = aim.yaw;
    const d = new THREE.Vector2(-Math.sin(yaw), -Math.cos(yaw));
    const back = new THREE.Vector3(-d.x, 0.14, -d.y).normalize();
    const base = new THREE.Vector3(cue.x, BALL_Y, cue.z);
    ghostStick.position.copy(base).addScaledVector(back, cueRest() + (aim.pull || 0));
    ghostStick.lookAt(base.clone().addScaledVector(back, 5));
    ghostStick.visible = true;
  } else {
    ghostStick.visible = false;
  }
}

function startOnline(opts) {
  // Stash the offline names before overwriting them with the online usernames,
  // so returning to a local game restores them instead of showing the opponent.
  // Guard so a back-to-back online match doesn't stash the previous opponent's.
  if (!onlineMode) offlineNames = [players[0].cfg.name, players[1].cfg.name];
  onlineMode = true;
  gameMode = '8ball';              // matchmaking is 8-ball only for now
  botMode = false; clearBotTimer(); botAim = null; botStriking = false; // never both at once
  mySeat = opts.mySeat | 0;
  rng = mulberry32(opts.seed >>> 0);
  players[0].cfg.name = opts.names[0];
  players[1].cfg.name = opts.names[1];
  players[0].cfg.avatar = opts.avatars ? opts.avatars[0] : null;
  players[1].cfg.avatar = opts.avatars ? opts.avatars[1] : null;
  players[0].group = players[1].group = null;
  turn = 0;                        // seat 0 = breaker
  if (window.MatchStats) window.MatchStats.begin([players[0].cfg.name, players[1].cfg.name]);
  rackBalls();
  shotEvents = { potted: [], scratch: false, firstHit: null, cushion: false, eightPocket: -1 };
  remoteAim = null; ghostStick.visible = false; watcherStriking = false; snapBuf = [];
  striking = false; stick.visible = false; lastEnd = null; lastAimKey = '';
  setCalledPocket(-1);
  pinnedMsg = null; // clear any prompt pinned from a previous game
  showRating(null); // clear any Elo swing left from a previous match
  state = S.AIM; wasMoving = false;
  cam.yaw = -Math.PI / 2; cam.pitch = START_PITCH; cam.radius = START_RADIUS;
  yawBeforeSurvey = null; // a fresh match starts clean, never mid-survey

  ['landingOverlay', 'modeOverlay', 'loginOverlay', 'signupOverlay', 'endOverlay']
    .forEach(id => { const e = document.getElementById(id); if (e) e.classList.add('hidden'); });
  document.getElementById('hud').classList.remove('hidden');
  document.getElementById('help').classList.remove('hidden');
  if (window.SettingsPanel) window.SettingsPanel.show();
  document.getElementById('styleName').textContent = TABLE_STYLES[currentTableStyle].name.toUpperCase();
  showGameHelp();
  updateHUD();

  // Keep both scenes in sync. Register the background-change hook once (lazily,
  // since backgrounds.js loads after this file), then let the breaker push its
  // current table + background as the authoritative scene for the match.
  if (!bgSyncHooked && window.PoolBackgrounds) {
    window.PoolBackgrounds.setOnChange(() => sendSetup());
    bgSyncHooked = true;
  }
  if (mySeat === 0) sendSetup();

  toast(myTurn()
    ? `You break! Drag back from the cue ball to shoot.`
    : `${players[turn].cfg.name} breaks — watch for your turn.`);
}

function endOnline() {
  onlineMode = false; rng = Math.random;
  // Restore the offline player names the online usernames replaced.
  if (offlineNames) {
    players[0].cfg.name = offlineNames[0];
    players[1].cfg.name = offlineNames[1];
    offlineNames = null;
  }
  players[0].cfg.avatar = players[1].cfg.avatar = null;
  remoteAim = null; ghostStick.visible = false; watcherStriking = false; snapBuf = [];
  striking = false; stick.visible = false;
  document.getElementById('endOverlay').classList.add('hidden');
  setCalledPocket(-1);
  document.getElementById('hud').classList.add('hidden');
  document.getElementById('help').classList.add('hidden');
  if (window.SettingsPanel) window.SettingsPanel.hide();
  state = S.SETUP;
  cam.goal.set(0, TABLE_Y, 0); cam.radius = 3.2; cam.pitch = 0.5;
}

// Show the local player's Elo swing on the end screen. Called by online.js when
// the server's authoritative 'rating' event arrives (shortly after game end).
// `info` is { rating, delta } for THIS player, or null to clear.
function showRating(info) {
  const el = document.getElementById('endRating');
  if (!el) return;
  if (!info || typeof info.delta !== 'number') { el.classList.add('hidden'); el.innerHTML = ''; return; }
  const up = info.delta >= 0;
  const sign = up ? '+' : '';
  el.innerHTML =
    `RATING <span class="eloNew">${info.rating}</span> ` +
    `<span class="eloDelta ${up ? 'eloUp' : 'eloDown'}">(${sign}${info.delta})</span>`;
  el.classList.remove('hidden');
}

window.PoolNetGame = {
  startOnline, endOnline, apply,
  isOnline: () => onlineMode,
  isOver: () => state === S.END,
  setSink(fn) { netSink = fn; },
  onExit(fn) { netExit = fn; },
  showRating,
};

/* ================================== UI ================================== */

const msgEl = document.getElementById('msg');
let msgTimer = null;
let pinnedMsg = null; // a prompt that must stay up until the player acts (place/call)

function toast(text, ms = 2600) {
  msgEl.textContent = text;
  msgEl.classList.add('show');
  clearTimeout(msgTimer);
  msgTimer = setTimeout(() => {
    // A transient toast shown on top of a pinned prompt restores it on expiry,
    // so the "place the cue ball" / "call a pocket" instruction never vanishes
    // while the player still owes that action.
    if (pinnedMsg !== null) msgEl.textContent = pinnedMsg;
    else msgEl.classList.remove('show');
  }, ms);
}

// Pin an instruction that stays visible until the player performs the required
// action. unpinToast() releases it (and lets the current text fade normally).
function pinToast(text) {
  pinnedMsg = text;
  msgEl.textContent = text;
  msgEl.classList.add('show');
  clearTimeout(msgTimer);
}

function unpinToast() {
  if (pinnedMsg === null) return;
  pinnedMsg = null;
  clearTimeout(msgTimer);
  msgTimer = setTimeout(() => msgEl.classList.remove('show'), 2600);
}

// One ball chip for the HUD's remaining-balls strip: a full-colour disc for
// 1-8, a white disc with a coloured band for 9-15 (the CSS reads --dc).
// The 8 is near-black on a near-black panel, so it gets a white centre pip to
// pick it out of the row — CSS draws it, hence no inline background here (an
// inline one would win over the rule and paint the pip out).
function ballDot(id) {
  const d = document.createElement('div');
  // Snooker balls are plain colours, so the chip is just the ball's colour —
  // except the black, which borrows the 8's white centre pip to stay visible
  // against the near-black HUD panel.
  if (gameMode === 'snooker') {
    const c = SNK.hex(id);
    d.className = 'dot' + (id === SNK.BLACK ? ' eight' : '');
    d.style.background = id === SNK.BLACK ? '' : c;
    d.style.setProperty('--dc', c);
    return d;
  }
  const striped = id > 8;
  const c = BALL_COLORS[striped ? id - 8 : id];
  const styled = striped || id === 8;   // background comes from the stylesheet
  d.className = 'dot' + (striped ? ' striped' : id === 8 ? ' eight' : '');
  d.style.background = styled ? '' : c;
  d.style.setProperty('--dc', c);
  return d;
}

// Snooker's remaining-balls strip: one red chip carrying the count (fifteen
// separate chips would swamp the card), then whichever colours are still up.
function snookerDots(dots) {
  const reds = SNK.REDS.reduce((k, id) => k + (balls[id].potted ? 0 : 1), 0);
  if (reds > 0) {
    const wrap = document.createElement('div');
    wrap.className = 'redsLeft';
    wrap.appendChild(ballDot(SNK.REDS[0]));
    const nEl = document.createElement('span');
    nEl.textContent = '\u00d7' + reds;
    wrap.appendChild(nEl);
    dots.appendChild(wrap);
  }
  for (const id of SNK.COLOURS) if (!balls[id].potted) dots.appendChild(ballDot(id));
}

function updateHUD() {
  // Snooker's cards are taller (they carry a frame score), so the toast below
  // them has to drop or the two collide — see body.snookerHud in index.html.
  document.body.classList.toggle('snookerHud', gameMode === 'snooker');
  // 9-ball has no groups: both players share one rotation, so both cards show
  // the same target and the same balls left on the table.
  const nineTarget = gameMode === '9ball' ? lowestBall() : 0;
  // Snooker: the ball on belongs to whoever is at the table, so it's shown on
  // the active card only. Suppressed once the frame is over, when the striker's
  // target is no longer a thing that exists.
  const snookerOnBall = gameMode === 'snooker' && state !== S.END ? snookerOn() : null;
  for (let i = 0; i < 2; i++) {
    const card = document.getElementById('card' + i);
    const p = players[i];
    card.querySelector('.pname').textContent = p.cfg.name;
    const avEl = card.querySelector('.hudAvatar');
    if (avEl) {
      if (p.cfg.avatar && window.PoolAvatar) {
        window.PoolAvatar.apply(avEl, p.cfg.avatar);
      } else if (avEl.classList.contains('avatarEmoji')) {
        avEl.classList.remove('avatarEmoji');
        avEl.style.backgroundColor = '';
        avEl.textContent = '';
      }
    }
    card.classList.toggle('active', i === turn && state !== S.END);
    const dots = card.querySelector('.dots');
    dots.innerHTML = '';
    const scoreEl = card.querySelector('.pscore');

    // The score line is snooker's alone; the pool games leave it hidden.
    if (scoreEl) {
      scoreEl.classList.toggle('hidden', gameMode !== 'snooker');
      if (gameMode === 'snooker') scoreEl.textContent = snooker.scores[i];
    }

    if (gameMode === 'snooker') {
      card.querySelector('.pgroup').textContent =
        (i === turn && snookerOnBall) ? 'ON: ' + snookerOnBall.label : '';
      snookerDots(dots);
      continue;
    }

    if (gameMode === '9ball') {
      card.querySelector('.pgroup').textContent =
        nineTarget ? `Next: ${nineTarget} ball` : 'Rack clear';
      for (const id of window.PoolNineBall.OBJECT_BALLS) {
        if (!balls[id].potted) dots.appendChild(ballDot(id));
      }
      continue;
    }

    card.querySelector('.pgroup').textContent =
      p.group ? (p.group === 'solid' ? 'Solids' : 'Stripes') : 'No group yet';
    if (p.group) {
      const lo = p.group === 'solid' ? 1 : 9, hi = p.group === 'solid' ? 7 : 15;
      for (let id = lo; id <= hi; id++) {
        if (!balls[id].potted) dots.appendChild(ballDot(id));
      }
      if (remaining(p.group) === 0) {
        const d = document.createElement('div');
        d.textContent = '→ 8 ball';
        d.style.fontSize = '10px';
        d.style.color = '#f1c40f';
        dots.appendChild(d);
      }
    }
  }
  document.getElementById('turnBadge').textContent =
    state === S.END ? 'Game over'
      : isMe(turn) ? 'Your turn'
        : `${players[turn].cfg.name}'s turn`;
}

const powerWrap = document.getElementById('powerWrap');
const powerFill = document.getElementById('powerFill');

// Reset the camera zoom + height to the opening shot view (keeping the current
// facing direction so the player's aim isn't spun around).
function resetZoom() {
  cam.pitch = START_PITCH;
  cam.radius = START_RADIUS;
}
document.getElementById('resetZoomBtn').addEventListener('click', resetZoom);
document.getElementById('helpClose').addEventListener('click', () => document.getElementById('help').classList.add('hidden'));

/* ----------------------------- setup screen ---------------------------- */

function buildSetupUI() {
  const row = document.getElementById('playersRow');
  row.innerHTML = '';
  players.forEach((p, i) => {
    const card = document.createElement('div');
    card.className = 'playerCard';
    const isBot = vsCPU && i === 1; // seat 1 is the computer in vs-CPU mode

    if (isBot) {
      p.cfg.name = 'Computer';
      card.innerHTML = `<h2>Computer</h2><div class="cpuBadge">🤖 CPU opponent</div>`;
      row.appendChild(card);
      return;
    }

    // Restore a default name if toggling back from a previous vs-CPU selection.
    if (p.cfg.name === 'Computer') p.cfg.name = `Player ${i + 1}`;
    card.innerHTML = `<h2>Player ${i + 1}</h2><label>Name</label>`;
    const nameIn = document.createElement('input');
    nameIn.type = 'text'; nameIn.maxLength = 14; nameIn.value = p.cfg.name;
    nameIn.addEventListener('input', () => {
      p.cfg.name = nameIn.value.trim() || `Player ${i + 1}`;
    });
    card.appendChild(nameIn);
    row.appendChild(card);
  });
}

// OFFLINE setup toggle: 2-player hot-seat vs. the computer opponent. Re-renders
// the player cards (seat 2 becomes the CPU) and is read by startMatch().
function setVsCPU(on) {
  if (on && gameMode === 'snooker') return; // no computer opponent in snooker yet
  vsCPU = on;
  const pBtn = document.getElementById('vsPlayerBtn'), cBtn = document.getElementById('vsCpuBtn');
  if (pBtn) pBtn.classList.toggle('sel', !on);
  if (cBtn) cBtn.classList.toggle('sel', on);
  buildSetupUI();
}
{
  const pBtn = document.getElementById('vsPlayerBtn'), cBtn = document.getElementById('vsCpuBtn');
  if (pBtn) pBtn.addEventListener('click', () => setVsCPU(false));
  if (cBtn) cBtn.addEventListener('click', () => setVsCPU(true));
}

function selectTableStyle(i, announce) {
  setTableStyle(i);
  const name = TABLE_STYLES[currentTableStyle].name;
  const nameEl = document.getElementById('styleName');
  if (nameEl) nameEl.textContent = name.toUpperCase();
  const homeNameEl = document.getElementById('homeStyleName');
  if (homeNameEl) homeNameEl.textContent = name.toUpperCase();
  if (announce) toast(`Table style: ${name}`);
  sendSetup(); // online: keep the opponent's table in sync (no-op offline / when applying a remote setup)
}

document.getElementById('startBtn').addEventListener('click', () => {
  sfx.unlock();
  // The OFFLINE setup is inline on the home screen now, so hide the whole
  // home overlay (not a separate setup overlay) before the match begins.
  document.getElementById('modeOverlay').classList.add('hidden');
  startMatch();
});
document.getElementById('rematchBtn').addEventListener('click', () => {
  document.getElementById('endOverlay').classList.add('hidden');
  if (onlineMode) { if (netExit) netExit(); return; } // online: back to lobby
  startMatch();
});
document.getElementById('quitBtn').addEventListener('click', () => {
  document.getElementById('endOverlay').classList.add('hidden');
  if (onlineMode) {
    if (netExit) netExit(); // leaves the match; endOnline() handles hud/settings/camera
  } else {
    document.getElementById('hud').classList.add('hidden');
    if (window.SettingsPanel) window.SettingsPanel.hide();
    // Stop the computer mid-thought and close its commentary feed.
    clearBotTimer(); botMode = false; botAim = null; botStriking = false;
    if (window.PixelPoolChat) window.PixelPoolChat.hide();
    state = S.SETUP;
    cam.goal.set(0, TABLE_Y, 0);
    cam.radius = 3.2; cam.pitch = 0.5;
  }
  if (window.PixelPoolMode) window.PixelPoolMode.showHome();
});

document.getElementById('stylePrev').addEventListener('click', () => selectTableStyle(currentTableStyle - 1, true));
document.getElementById('styleNext').addEventListener('click', () => selectTableStyle(currentTableStyle + 1, true));

// Surface for the home/profile screens' own view panel (js/homeview.js) to
// cycle the same table style shown in-game, without reaching into game.js's
// closed-over state directly.
window.PoolTableStyles = {
  next: () => selectTableStyle(currentTableStyle + 1, true),
  prev: () => selectTableStyle(currentTableStyle - 1, true),
};

/* ================================= INPUT ================================ */

const ptr = { down: false, mode: null, x: 0, y: 0, id: null, moved: 0 };

function screenPosOfCue() {
  const v = new THREE.Vector3(cue.x, BALL_Y, cue.z).project(camera);
  return {
    x: (v.x + 1) / 2 * canvas.clientWidth,
    y: (-v.y + 1) / 2 * canvas.clientHeight,
  };
}

canvas.addEventListener('pointerdown', e => {
  sfx.unlock();
  if (state === S.SETUP || state === S.END) return;
  canvas.setPointerCapture(e.pointerId);
  ptr.down = true; ptr.id = e.pointerId; ptr.moved = 0;
  ptr.x = e.clientX; ptr.y = e.clientY;

  // While spectating (online opponent, or the computer's turn), the camera still
  // orbits but the cue is locked out of the human's control.
  if (spectating()) { ptr.mode = 'orbit'; return; }

  if (state === S.PLACING) {
    ptr.mode = 'place'; // tap places the ball; dragging orbits the camera
    updatePlaceGhost(e.clientX, e.clientY);
    return;
  }
  if (state === S.CALLING) {
    ptr.mode = 'call'; // tap a pocket to nominate it; dragging orbits the camera
    return;
  }
  if (state === S.AIM) {
    const sp = screenPosOfCue();
    const dist = Math.hypot(e.clientX - sp.x, e.clientY - sp.y);
    if (dist < 46) {
      ptr.mode = 'charge';
      state = S.CHARGE;
      chargePull = 0;
      canvas.classList.add('charging');
      powerWrap.classList.add('show');
      return;
    }
  }
  ptr.mode = 'orbit';
});

canvas.addEventListener('pointermove', e => {
  // Only preview a placement the local player is actually allowed to make.
  // Without the spectating() guard, moving the mouse while the computer (or an
  // online opponent) held ball-in-hand summoned the ghost, and their placement
  // path never hid it again — leaving a translucent cue ball on the felt.
  if (state === S.PLACING && !ptr.down && !spectating()) updatePlaceGhost(e.clientX, e.clientY);
  if (!ptr.down || e.pointerId !== ptr.id) return;
  const dx = e.clientX - ptr.x, dy = e.clientY - ptr.y;

  if (ptr.mode === 'orbit') {
    ptr.moved += Math.abs(dx) + Math.abs(dy);
    cam.yaw -= dx * 0.005;
    cam.pitch += dy * 0.005;
    ptr.x = e.clientX; ptr.y = e.clientY;
  } else if (ptr.mode === 'place') {
    ptr.moved += Math.abs(dx) + Math.abs(dy);
    if (ptr.moved > 8) { // it's a drag: orbit instead
      cam.yaw -= dx * 0.005;
      cam.pitch += dy * 0.005;
    }
    ptr.x = e.clientX; ptr.y = e.clientY;
    updatePlaceGhost(e.clientX, e.clientY);
  } else if (ptr.mode === 'call') {
    ptr.moved += Math.abs(dx) + Math.abs(dy);
    if (ptr.moved > 8) { // it's a drag: orbit the camera to survey the table
      cam.yaw -= dx * 0.005;
      cam.pitch += dy * 0.005;
    }
    ptr.x = e.clientX; ptr.y = e.clientY;
  } else if (ptr.mode === 'charge') {
    // pull = drag along the screen-space "backward" direction of the aim
    const d = aimDir();
    const p0 = new THREE.Vector3(cue.x, BALL_Y, cue.z).project(camera);
    const p1 = new THREE.Vector3(cue.x + d.x * 0.3, BALL_Y, cue.z + d.y * 0.3).project(camera);
    let ax = (p1.x - p0.x) * canvas.clientWidth, ay = -(p1.y - p0.y) * canvas.clientHeight;
    const al = Math.hypot(ax, ay);
    let px;
    if (al > 2) { ax /= al; ay /= al; px = -(dx * ax + dy * ay); }
    else px = dy; // aiming straight down the camera: pull = drag down
    chargePull = Math.max(0, Math.min(MAX_PULL, px / 260 * MAX_PULL));
    powerFill.style.width = (chargePull / MAX_PULL * 100).toFixed(1) + '%';
  }
});

canvas.addEventListener('pointerup', e => {
  if (!ptr.down || e.pointerId !== ptr.id) return;
  ptr.down = false;

  if (ptr.mode === 'charge') {
    canvas.classList.remove('charging');
    powerWrap.classList.remove('show');
    const power = chargePull / MAX_PULL;
    if (power > 0.04) fire(power);
    else { chargePull = 0; state = S.AIM; }
  } else if (ptr.mode === 'place') {
    if (ptr.moved > 8) { ptr.mode = null; return; } // was an orbit drag, not a tap
    updatePlaceGhost(e.clientX, e.clientY);
    if (placeValid) {
      cue.x = placeGhost.position.x;
      cue.z = placeGhost.position.z;
      cue.potted = false; cue.sink = 0;
      cue.mesh.visible = true; cue.mesh.scale.setScalar(1);
      hidePlaceGhost();
      enterAim();
      unpinToast(); // the ball is placed; release the "place the cue ball" prompt
      // If the shooter is down to the 8-ball, placing hands straight over to the
      // pocket-call, which is itself a pinned prompt.
      if (state === S.CALLING) pinToast(`Only the 8-ball left — tap the pocket you'll call`);
      else if (state === S.NOMINATE) pinToast('Nominate the colour you’re on');
      else toast(`${players[turn].cfg.name}'s shot`);
    } else {
      toast(gameMode === 'snooker'
        ? 'The cue ball has to go inside the D'
        : 'Can’t place there — pick an open spot on the felt');
    }
  } else if (ptr.mode === 'call') {
    if (ptr.moved > 8) { ptr.mode = null; return; } // was an orbit drag, not a tap
    const pi = pocketAtPointer(e.clientX, e.clientY);
    if (pi >= 0) {
      setCalledPocket(pi);
      state = S.AIM;
      exitSurveyCam(); // drop from the bird's-eye survey back to the low first-person shot POV
      unpinToast(); // the pocket is chosen; release the "call a pocket" prompt
      toast('Pocket called — sink the 8-ball there.');
      if (onlineMode) netSend({ t: 'call', p: pi });
    } else {
      toast('Tap directly on a pocket to call your shot.');
    }
  } else if (ptr.mode === 'orbit' && ptr.moved <= 8 && state === S.AIM && myTurn() && isOnEight(turn)) {
    // A tap (not a drag) on a pocket while aiming the 8-ball re-nominates it.
    const pi = pocketAtPointer(e.clientX, e.clientY);
    if (pi >= 0 && pi !== calledPocket) {
      setCalledPocket(pi);
      toast('Pocket re-called.');
      if (onlineMode) netSend({ t: 'call', p: pi });
    }
  }
  ptr.mode = null;
});

canvas.addEventListener('pointercancel', () => {
  ptr.down = false; ptr.mode = null;
  canvas.classList.remove('charging');
  powerWrap.classList.remove('show');
  if (state === S.CHARGE) { chargePull = 0; state = S.AIM; }
});

canvas.addEventListener('wheel', e => {
  e.preventDefault();
  cam.radius *= Math.exp(e.deltaY * 0.0012);
}, { passive: false });

/* Control surface exposed to the keyboard module (js/keyboard.js). Everything
   the keyboard needs to drive the game goes through here so input handling can
   live in its own file rather than being wired directly into this closure. */
window.PoolControls = {
  inPlay()     { return state !== S.SETUP && state !== S.END; },
  canAim()     { return state === S.AIM && !cue.potted && myTurn(); },
  isCharging() { return state === S.CHARGE; },

  orbit(dyaw, dpitch) { cam.yaw += dyaw; cam.pitch += dpitch; },
  zoom(factor)        { cam.radius *= factor; },

  startCharge() {
    if (state !== S.AIM || cue.potted || !myTurn()) return;
    state = S.CHARGE; chargePull = 0;
    canvas.classList.add('charging');
    powerWrap.classList.add('show');
  },
  adjustPower(delta) {
    if (state !== S.CHARGE) return;
    chargePull = Math.max(0, Math.min(MAX_PULL, chargePull + delta * MAX_PULL));
    powerFill.style.width = (chargePull / MAX_PULL * 100).toFixed(1) + '%';
  },
  power() { return chargePull / MAX_PULL; },
  shoot() {
    if (state !== S.CHARGE) return;
    canvas.classList.remove('charging');
    powerWrap.classList.remove('show');
    const p = chargePull / MAX_PULL;
    if (p > 0.04) fire(p);
    else { chargePull = 0; state = S.AIM; }
  },
  cancelCharge() {
    if (state !== S.CHARGE) return;
    canvas.classList.remove('charging');
    powerWrap.classList.remove('show');
    chargePull = 0; state = S.AIM;
  },
  toggleHelp() { document.getElementById('help').classList.toggle('hidden'); },
};

canvas.addEventListener('contextmenu', e => e.preventDefault());

/* ball-in-hand ghost placement */
const rc = new THREE.Raycaster();
const tablePlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -BALL_Y);

// Which pocket a screen tap lands on for the 8-ball call, or -1 if the tap
// wasn't close enough to any pocket.
function pocketAtPointer(cx, cy) {
  const ndc = new THREE.Vector2(
    (cx / canvas.clientWidth) * 2 - 1,
    -(cy / canvas.clientHeight) * 2 + 1
  );
  rc.setFromCamera(ndc, camera);
  const hit = new THREE.Vector3();
  if (!rc.ray.intersectPlane(tablePlane, hit)) return -1;
  let best = -1, bd = Infinity;
  for (let i = 0; i < POCKETS.length; i++) {
    const d2 = (hit.x - POCKETS[i].x) ** 2 + (hit.z - POCKETS[i].z) ** 2;
    if (d2 < bd) { bd = d2; best = i; }
  }
  return bd < 0.18 * 0.18 ? best : -1;
}

// Take down the ball-in-hand preview (mesh + placing cursor). Safe to call at
// any time; every exit from S.PLACING goes through here so a ghost can't be
// left behind by a path that didn't create it.
function hidePlaceGhost() {
  placeGhost.visible = false;
  canvas.classList.remove('placing');
}

function updatePlaceGhost(cx, cy) {
  const ndc = new THREE.Vector2(
    (cx / canvas.clientWidth) * 2 - 1,
    -(cy / canvas.clientHeight) * 2 + 1
  );
  rc.setFromCamera(ndc, camera);
  const hit = new THREE.Vector3();
  if (!rc.ray.intersectPlane(tablePlane, hit)) return;
  const x = Math.max(-LIMX, Math.min(LIMX, hit.x));
  const z = Math.max(-LIMZ, Math.min(LIMZ, hit.z));
  placeGhost.position.set(x, BALL_Y, z);
  placeGhost.visible = true;
  canvas.classList.add('placing');
  // Snooker never gives ball in hand anywhere on the table: the cue ball goes
  // in the D, whether that's the frame's first stroke, an in-off or a
  // re-spotted black.
  placeValid = gameMode !== 'snooker' || SNK.inD({ PW, PH, R }, x, z);
  for (const b of balls) {
    if (b.id === 0 || b.potted) continue;
    if ((b.x - x) ** 2 + (b.z - z) ** 2 < (2 * R * 1.05) ** 2) { placeValid = false; break; }
  }
  for (const p of POCKETS) {
    if ((p.x - x) ** 2 + (p.z - z) ** 2 < (p.r + R) ** 2) { placeValid = false; break; }
  }
  placeGhost.material.color.set(placeValid ? '#ffffff' : '#e74c3c');
  placeGhost.material.opacity = placeValid ? 0.5 : 0.4;
}

/* ================================ MAIN LOOP ============================= */

let physAcc = 0;
let lastFrame = performance.now();
let wasMoving = false;

function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, (now - lastFrame) / 1000);
  lastFrame = now;

  // physics — skipped entirely while watching the opponent (their client is
  // authoritative; our ball motion comes from their snapshots instead).
  if (!watching() && (state === S.ROLLING || anyMoving())) {
    physAcc += dt;
    while (physAcc >= PHYS_H) {
      physicsStep(PHYS_H);
      physAcc -= PHYS_H;
    }
    if (onlineMode && myTurn()) maybeSendSnap(now);
  }

  const moving = anyMoving();
  if (!watching() && state === S.ROLLING && wasMoving && !moving && !striking) {
    resolveShot();
    if (onlineMode) onlineAfterResolve(); // broadcast the authoritative result
    else if (isBotSeat(turn) && state !== S.END) scheduleBotTurn();
  }
  wasMoving = moving;

  // online streaming (my turn) / interpolation (watching)
  if (onlineMode) {
    if (myTurn() && (state === S.AIM || state === S.CHARGE)) maybeSendAim();
    if (watching() && state === S.ROLLING) interpSample();
  }

  // camera focus
  if (state === S.AIM || state === S.CHARGE) {
    cam.goal.set(cue.x, BALL_Y, cue.z);
  } else if (state === S.SETUP) {
    cam.goal.set(0, TABLE_Y + 0.15, 0);
    cam.yaw += dt * 0.12; // slow showcase spin
  } else {
    cam.goal.set(0, TABLE_Y, 0);
  }
  updateCamera();

  syncBallMeshes(dt);
  updateAimVisuals();
  renderer.render(scene, camera);
}

function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(Math.round(w / PIXEL), Math.round(h / PIXEL), false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);

/* ================================= BOOT ================================= */

resize();
buildSetupUI();
buildNominate();
rackBalls();
updateHUD();
requestAnimationFrame(frame);

// One snapshot of everything a test harness needs to drive and check the game.
// Fed to both the #dbg element and window.__poolTest.dump().
function dumpState() {
  return {
    state, turn, game: gameMode,
    target: gameMode === '9ball' ? lowestBall() : 0,
    snooker: gameMode === 'snooker'
      ? { scores: snooker.scores.slice(), phase: snooker.st.phase,
          nominated: snooker.st.nominated,
          on: snookerOn().label, onIds: snookerOn().ids }
      : null,
    moving: anyMoving(),
    potted: balls.filter(b => b.potted).map(b => b.id),
    pos: balls.filter(b => !b.potted).map(b => [b.id, +b.x.toFixed(3), +b.z.toFixed(3)]),
  };
}

/* headless-test hooks: ?autostart skips setup, ?autoshot=0.9 fires the break,
   ?game=9ball picks the rule set, ?cpu makes seat 2 the computer (vs-CPU mode),
   ?botbreak lets it break, ?botvbot gives the computer BOTH seats (self-play,
   for measuring its pot rate), ?dbg exposes a live state dump (#dbg) without
   auto-firing. */
const q = new URLSearchParams(location.search);
if (q.has('game')) setGame(q.get('game'));
if (q.has('autostart')) {
  document.getElementById('landingOverlay').classList.add('hidden');
  document.getElementById('modeOverlay').classList.add('hidden');
  if (q.has('cpu')) vsCPU = true;
  // ?nocpu: hot-seat both seats. A harness driving strokes from outside has to
  // be the only thing holding the cue — the computer firing its own stroke into
  // a roll already underway re-launches the cue ball mid-shot and resets
  // shotEvents with it (see launchCue), which corrupts any recording of it.
  if (q.has('nocpu')) vsCPU = false;
  if (q.has('botbreak')) forceBotBreak = true; // test: force the computer to break
  if (q.has('botvbot')) bothBotSeats = true; // test: computer plays both seats (self-play stats)
  startMatch();
  if (q.has('autoshot') || q.has('dbg')) {
    const dbg = document.createElement('div');
    dbg.id = 'dbg';
    dbg.style.display = 'none';
    document.body.appendChild(dbg);
    if (q.has('autoshot')) setTimeout(() => fire(Math.min(1, parseFloat(q.get('autoshot')) || 0.9)), 500);
    // Scripted play, for driving whole racks from a test harness: point the cue
    // at a table position, drop the ball in hand, and shoot. Same entry points
    // the human's input uses, so it exercises the real resolve path.
    window.__poolTest = {
      aimAt(x, z) { cam.yaw = Math.atan2(-(x - cue.x), -(z - cue.z)); },
      shoot(power) { if (state === S.AIM) fire(Math.max(0.05, Math.min(1, power))); },
      // A live snapshot of the match, for a harness driving the game from
      // outside. Same payload as the #dbg element below, but read on demand so
      // a caller never acts on a state a poll interval out of date.
      dump: () => dumpState(),
      place(x, z) {
        if (state !== S.PLACING) return false;
        cue.x = x; cue.z = z; cue.vx = cue.vz = 0;
        cue.potted = false; cue.sink = 0; setBallVisual(cue);
        unpinToast(); enterAim();
        return true;
      },
      // Snooker: answer the colour picker (S.NOMINATE) without a click.
      nominate(id) {
        if (state !== S.NOMINATE) return false;
        nominate(id);
        return state === S.AIM;
      },
    };
    setInterval(() => { dbg.textContent = JSON.stringify(dumpState()); }, 250);
  }
}

})();

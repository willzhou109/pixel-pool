/* Low-Poly Billiards — Three.js + custom physics. No external assets. */
(function () {
'use strict';

/* ================================ CONFIG ================================ */

const PW = 1.27;              // half-length of play field (x)
const PH = 0.635;             // half-width of play field (z)
const R  = 0.0286;            // ball radius
const TABLE_Y = 0.80;         // felt surface height
const BALL_Y  = TABLE_Y + R;  // ball center height

const LIMX = PW - R;          // cushion planes for ball centers
const LIMZ = PH - R;
const CORNER_GAP = 0.085;     // cushion cut-back near corner pockets
const SIDE_GAP   = 0.058;     // half-width of side pocket mouth

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

const POCKETS = [
  { x: -PW - 0.012, z: -PH - 0.012, r: 0.075 },
  { x:  PW + 0.012, z: -PH - 0.012, r: 0.075 },
  { x: -PW - 0.012, z:  PH + 0.012, r: 0.075 },
  { x:  PW + 0.012, z:  PH + 0.012, r: 0.075 },
  { x: 0,           z: -PH - 0.024, r: 0.066 },
  { x: 0,           z:  PH + 0.024, r: 0.066 },
];

const BALL_COLORS = {
  1: '#f2b705', 2: '#1d5fbf', 3: '#d0342c', 4: '#6a2d9c',
  5: '#e8720c', 6: '#1a8a4f', 7: '#8a2033', 8: '#181820',
};

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
const START_PITCH = 0.34, START_RADIUS = 0.95; // the low first-person shot view
const cam = {
  yaw: Math.PI * 0.5, pitch: 0.72, radius: 3.4,
  target: new THREE.Vector3(0, TABLE_Y, 0),
  goal: new THREE.Vector3(0, TABLE_Y, 0),
};

function updateCamera() {
  cam.pitch = Math.max(0.10, Math.min(1.40, cam.pitch));
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

function buildTable(C) {
  const table = new THREE.Group();
  const frameMat = C.metal ? metalMat(C.frame) : mat(C.frame);
  const apronMat = C.metal ? metalMat(C.frameDark) : mat(C.frameDark);

  // slate / felt bed
  const bed = new THREE.Mesh(new THREE.BoxGeometry(2 * PW + 0.06, 0.06, 2 * PH + 0.06), mat(C.felt));
  bed.position.y = TABLE_Y - 0.03; bed.castShadow = bed.receiveShadow = true;
  table.add(bed);

  // felt markings
  const spotGeo = new THREE.CircleGeometry(0.012, 8);
  for (const sx of [-PW / 2, PW / 2]) {
    const s = new THREE.Mesh(spotGeo, mat('#cfe3d5'));
    s.rotation.x = -Math.PI / 2; s.position.set(sx, TABLE_Y + 0.0008, 0);
    table.add(s);
  }

  // cushions
  const cushH = 0.045, cushDepth = 0.052;
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
    const c = cushion(longLen, 0.035);
    if (zs < 0) c.rotation.y = Math.PI;
    c.position.set(xs * longCx, TABLE_Y, zs * (PH + cushDepth));
    table.add(c);
  }
  const shortLen = 2 * (PH - CORNER_GAP);
  for (const xs of [-1, 1]) {
    const c = cushion(shortLen, 0.035);
    c.rotation.y = xs > 0 ? Math.PI / 2 : -Math.PI / 2;
    c.position.set(xs * (PW + cushDepth), TABLE_Y, 0);
    table.add(c);
  }

  // rail frame
  const railW = 0.11, railH = 0.09;
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
  const diaGeo = new THREE.CircleGeometry(0.014, 4);
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
  // pocket materials were just rebuilt fresh (dark); drop any stale glow state
  if (window.AimAssist) window.AimAssist.clear();
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

const ballGeo = new THREE.SphereGeometry(R, 14, 10);
const balls = []; // {id, mesh, x, z, vx, vz, potted, sinking}

for (let id = 0; id <= 15; id++) {
  const m = new THREE.Mesh(ballGeo, new THREE.MeshStandardMaterial({
    map: ballTexture(id), flatShading: true, roughness: 0.32, metalness: 0.05,
  }));
  m.castShadow = true; m.receiveShadow = true;
  scene.add(m);
  balls.push({ id, mesh: m, x: 0, z: 0, vx: 0, vz: 0, potted: false, sink: 0 });
}
const cue = balls[0];

/* Data + controls the aim-assist module (js/aimassist.js) needs. Kept as a
   small explicit surface so that feature can live in its own file. */
window.PoolAimHooks = {
  scene, POCKETS, R, BALL_Y, TABLE_Y, balls,
  // Turn a pocket's black void green (and glowing) or back to normal. Reads the
  // live pocketMats so it keeps working after a table-style rebuild.
  setPocketGlow(i, on) {
    const m = pocketMats[i];
    if (!m) return;
    if (on) { m.color.set('#2ecc71'); m.emissive.set('#1f8f4d'); m.emissiveIntensity = 1; }
    else { m.color.set('#0a0a0f'); m.emissive.set('#000000'); }
  },
};

// Hook for js/backgrounds.js: enough of the scene to hang decoration off of and
// tint the sky/fog. Deliberately exposes no lights — backgrounds must not touch
// the lighting rig, so the table's shading is identical in every environment.
window.PoolScene = {
  scene, TABLE_Y, PW, PH,
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

  const solids = shuffle([1, 2, 3, 4, 5, 6, 7]);
  const stripes = shuffle([9, 10, 11, 12, 13, 14, 15]);
  const cornerA = solids.pop(), cornerB = stripes.pop();
  const rest = shuffle(solids.concat(stripes));

  // Tight triangular rack: within-row spacing d ≈ 2R (a hair over, to avoid
  // start-of-frame overlap), row spacing d·√3/2 so every neighbour just touches.
  // A gap-free rack transfers the break's energy cleanly and scatters the pack.
  const d = 2 * R * 1.0006, dx = d * Math.sqrt(3) / 2;
  let slot = 0;
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
      slot++;
    }
  }
  breakShot = true; // next shot is the opening break
  syncBallMeshes(0);
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

let shotEvents = { potted: [], scratch: false, firstHit: null, eightPocket: -1 };

function anyMoving() {
  for (const b of balls) if (!b.potted && (b.vx !== 0 || b.vz !== 0)) return true;
  return false;
}

function potBall(b, pocketIndex) {
  b.potted = true; b.sink = 0.25;
  b.vx = 0; b.vz = 0;
  b.mesh.position.set(b.x, BALL_Y, b.z);
  if (b.id === 0) shotEvents.scratch = true;
  else {
    shotEvents.potted.push(b.id);
    if (b.id === 8) shotEvents.eightPocket = pocketIndex; // for the called-shot check
  }
  sfx.pocket();
  announcePot(b.id);
  // Tell the watcher to sink this ball now, instead of leaving it stranded at
  // its last streamed spot until the shot's authoritative state arrives.
  if (onlineMode && myTurn()) netSend({ t: 'pot', id: b.id, x: round4(b.x), z: round4(b.z) });
}

// Fire a top-right "pocketed" popup for the current shooter. Runs on the
// shooter's own client here; the watcher fires the same from applyPot().
function announcePot(id) {
  if (!window.PoolNotify) return;
  const color = id === 0 ? null : BALL_COLORS[id > 8 ? id - 8 : id];
  window.PoolNotify.pocket(players[turn].cfg.name, id, color);
}

function physicsStep(h) {
  // integrate + friction
  for (const b of balls) {
    if (b.potted) continue;
    let sp = Math.hypot(b.vx, b.vz);
    if (sp > 0) {
      const dec = (FRIC_C + FRIC_L * sp) * h;
      const ns = sp - dec;
      if (ns <= STOP_V * 0.5) { b.vx = 0; b.vz = 0; sp = 0; }
      else { const k = ns / sp; b.vx *= k; b.vz *= k; sp = ns; }
    }
    b.x += b.vx * h;
    b.z += b.vz * h;
  }

  // cushions + pockets
  for (const b of balls) {
    if (b.potted) continue;

    // pocket capture
    let captured = false;
    for (let pi = 0; pi < POCKETS.length; pi++) {
      const p = POCKETS[pi];
      const dx = b.x - p.x, dz = b.z - p.z;
      if (dx * dx + dz * dz < p.r * p.r) { potBall(b, pi); captured = true; break; }
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
          b.vz = -b.vz * REST_CUSH;
          b.vx *= (1 - CUSH_GRIP);
          sfx.cushion(Math.abs(b.vz));
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
          b.vx = -b.vx * REST_CUSH;
          b.vz *= (1 - CUSH_GRIP);
          sfx.cushion(Math.abs(b.vx));
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
      potBall(b, best);
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
        const jimp = -(1 + REST_BALL) * rvn / 2;
        a.vx -= jimp * nx; a.vz -= jimp * nz;
        b.vx += jimp * nx; b.vz += jimp * nz;
        sfx.clack(Math.abs(rvn));
        // record which object ball the cue ball strikes first this shot
        if (shotEvents.firstHit === null && (a.id === 0 || b.id === 0)) {
          shotEvents.firstHit = a.id === 0 ? b.id : a.id;
        }
      }
    }
  }

  // stop crawling balls
  for (const b of balls) {
    if (b.potted) continue;
    if (b.vx !== 0 || b.vz !== 0) {
      if (Math.hypot(b.vx, b.vz) < STOP_V) { b.vx = 0; b.vz = 0; }
    }
  }
}

/* ================================= AUDIO ================================ */

const sfx = (function () {
  let ctx = null, noise = null, lastT = {};
  function ensure() {
    if (ctx) return true;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    ctx = new AC();
    const len = ctx.sampleRate * 0.2 | 0;
    noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const ch = noise.getChannelData(0);
    for (let i = 0; i < len; i++) ch[i] = Math.random() * 2 - 1;
    return true;
  }
  function burst(vol, freq, q, dur, key) {
    if (!ctx || ctx.state !== 'running') return;
    const now = ctx.currentTime;
    if (key && lastT[key] && now - lastT[key] < 0.03) return;
    if (key) lastT[key] = now;
    const src = ctx.createBufferSource();
    src.buffer = noise;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = freq; bp.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(Math.min(1, vol), now);
    g.gain.exponentialRampToValueAtTime(0.001, now + dur);
    src.connect(bp).connect(g).connect(ctx.destination);
    src.start(now); src.stop(now + dur);
  }
  return {
    unlock() { if (ensure() && ctx.state === 'suspended') ctx.resume(); },
    clack(imp) { burst(0.15 + imp * 0.22, 2600, 1.5, 0.07, 'c'); },
    cushion(imp) { burst(0.08 + imp * 0.12, 420, 1.2, 0.10, 'w'); },
    pocket() { burst(0.5, 190, 1.0, 0.28, 'p'); burst(0.25, 900, 2, 0.1); },
    strike(pow) { burst(0.2 + pow * 0.5, 1600, 1.2, 0.08); },
  };
})();

/* ============================ CUE STICK & GUIDE ========================= */

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

function updateAimVisuals() {
  updateGhostCue(); // opponent's floating cue (online watcher)
  const aiming = (state === S.AIM || state === S.CHARGE) && !cue.potted && myTurn();
  const AA = window.AimAssist;
  // "Lines" assist toggles the guide/object/ghost visuals; the cue stick and
  // pocket-preview are independent of it.
  const linesOn = aiming && (!AA || AA.showLines());
  stick.visible = aiming || striking;
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
  stick.position.copy(base).addScaledVector(back, 0.035 + pull);
  stick.lookAt(base.clone().addScaledVector(back, 5));
}

/* ============================== GAME STATE ============================== */

const S = { SETUP: 0, AIM: 1, CHARGE: 2, ROLLING: 3, PLACING: 4, END: 5, CALLING: 6 };
let state = S.SETUP;
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

// True when I control the cue right now (offline, or my turn online).
function myTurn() { return !onlineMode || turn === mySeat; }
// True when I'm watching the opponent shoot (online, their turn).
function watching() { return onlineMode && turn !== mySeat; }
function netSend(msg) { if (onlineMode && netSink) netSink(msg); }

// ---- online-aware messaging (say "You" from each client's perspective) ----
// Online: true if `seat` is the local player. Offline (hotseat) is never "you".
function isMe(seat) { return onlineMode && seat === mySeat; }
function endTitleFor(winner) {
  if (!onlineMode) return `🏆 ${players[winner].cfg.name} wins!`;
  return winner === mySeat ? '🏆 YOU WON!' : '😞 YOU LOST';
}

function remaining(group) {
  const lo = group === 'solid' ? 1 : 9, hi = group === 'solid' ? 7 : 15;
  let n = 0;
  for (let i = lo; i <= hi; i++) if (!balls[i].potted) n++;
  return n;
}

function groupOf(id) { return id < 8 ? 'solid' : 'stripe'; }

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
  setCalledPocket(-1);
  if (myTurn() && isOnEight(turn)) {
    state = S.CALLING;
    cam.radius = 2.2; cam.pitch = 0.85; // pull back so every pocket is easy to tap
  } else {
    state = S.AIM;
  }
}

/* ------------------------------- shooting ------------------------------ */

function fire(power) {
  const d = aimDir();
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
      striking = false;
      stick.visible = false;
      shotEvents = { potted: [], scratch: false, firstHit: null, eightPocket: -1 };
      const speed = power * MAX_V * (breakShot ? BREAK_BOOST : 1);
      cue.vx = d.x * speed;
      cue.vz = d.y * speed;
      sfx.strike(power);
      return;
    }
    stick.position.set(cue.x, BALL_Y, cue.z)
      .addScaledVector(back, 0.035 + pull0 * (1 - t));
    requestAnimationFrame(anim);
  })();
}

/* ---------------------------- shot resolution --------------------------- */

function resolveShot() {
  const me = players[turn], opp = players[1 - turn];
  const potted = shotEvents.potted;
  const scratch = shotEvents.scratch;
  const potted8 = potted.includes(8);
  const wasBreak = breakShot; breakShot = false;

  // A called 8-ball shot (the shooter was on the 8 and nominated a pocket).
  if (calledPocket >= 0) {
    // Pocketing the cue ball and the 8 on the same stroke loses, whichever
    // pocket the 8 found. But a scratch with the 8 left standing is NOT a loss
    // under WPA rules — it's just a foul: play continues and the opponent gets
    // ball-in-hand, so it falls through to the foul handling below.
    if (scratch && potted8) return endGame(1 - turn, `${me.cfg.name} pocketed the cue ball with the 8.`);
    if (potted8) {
      return shotEvents.eightPocket === calledPocket
        ? endGame(turn, `${me.cfg.name} sank the 8-ball in the called pocket!`)
        : endGame(1 - turn, `${me.cfg.name} sank the 8-ball in the wrong pocket.`);
    }
    // 8 stayed up: a scratch becomes a ball-in-hand foul, a clean miss just
    // passes the turn — both handled below.
  } else if (potted8) {
    // 8 dropped while balls of the group remained, or on the very shot the group
    // cleared. Same-shot clear counts as a clean finish; otherwise it's a loss.
    const clearedOwn = me.group && remaining(me.group) === 0;
    if (clearedOwn && !scratch) {
      return endGame(turn, `${me.cfg.name} sank the 8-ball. Clean finish!`);
    }
    const why = scratch ? 'scratched while sinking the 8-ball' : 'sank the 8-ball too early';
    return endGame(1 - turn, `${me.cfg.name} ${why}.`);
  }

  // Illegal-first-contact foul. The cue ball's first strike must be a ball of
  // the shooter's group — any ball but the 8 on an open table, or the 8 itself
  // once the group is cleared. Touching nothing at all is a foul too.
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
    if (myTurn()) pinToast(lastFoul); else toast(lastFoul);
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

function endGame(winner, reason) {
  state = S.END;
  lastEnd = { winner, reason };
  document.getElementById('endTitle').textContent = endTitleFor(winner);
  document.getElementById('endReason').textContent = reason;
  document.getElementById('endOverlay').classList.remove('hidden');
  updateHUD();
}

function startMatch() {
  onlineMode = false;          // local match: full control, random rack
  rng = Math.random;
  players[0].group = null;
  players[1].group = null;
  turn = 0;
  rackBalls();
  shotEvents = { potted: [], scratch: false, firstHit: null, eightPocket: -1 };
  setCalledPocket(-1);
  pinnedMsg = null; // clear any prompt pinned from a previous game
  state = S.AIM;
  cam.yaw = -Math.PI / 2; cam.pitch = START_PITCH; cam.radius = START_RADIUS; // first-person: low, just behind the cue ball
  document.getElementById('hud').classList.remove('hidden');
  document.getElementById('help').classList.remove('hidden');
  if (window.SettingsPanel) window.SettingsPanel.show();
  document.getElementById('styleName').textContent = TABLE_STYLES[currentTableStyle].name.toUpperCase();
  toast(`${players[turn].cfg.name} breaks. Drag back from the cue ball to shoot.`);
  updateHUD();
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
    ghostStick.position.copy(base).addScaledVector(back, 0.035 + pull0 * (1 - t));
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
  remoteAim = null; ghostStick.visible = false; watcherStriking = false; snapBuf = [];
  striking = false; stick.visible = false; wasMoving = false; lastAimKey = '';
  setCalledPocket(-1); // a new shot begins; any previous 8-ball call is cleared
  breakShot = false;   // the opponent has resolved a shot, so the break is over
  updateHUD();

  if (msg.phase === 'end') {
    state = S.END; lastEnd = { winner: msg.winner, reason: msg.reason };
    document.getElementById('endTitle').textContent = endTitleFor(msg.winner);
    document.getElementById('endReason').textContent = msg.reason || '';
    document.getElementById('endOverlay').classList.remove('hidden');
  } else if (msg.phase === 'place') {
    state = S.PLACING;
    if (myTurn()) pinToast('Ball in hand — place the cue ball');
    else toast(msg.foul || `${players[turn].cfg.name} fouled`);
  } else if (myTurn() && isOnEight(turn)) {
    state = S.CALLING;
    cam.radius = 2.2; cam.pitch = 0.85;
    pinToast(`Only the 8-ball left — tap the pocket you'll call`);
  } else {
    state = S.AIM;
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

// Opponent's floating cue, positioned from their streamed aim.
function updateGhostCue() {
  if (watcherStriking) return; // the strike animation in applyShoot() owns it for now
  if (watching() && remoteAim && !cue.potted && state !== S.ROLLING) {
    const yaw = remoteAim.yaw;
    const d = new THREE.Vector2(-Math.sin(yaw), -Math.cos(yaw));
    const back = new THREE.Vector3(-d.x, 0.14, -d.y).normalize();
    const base = new THREE.Vector3(cue.x, BALL_Y, cue.z);
    ghostStick.position.copy(base).addScaledVector(back, 0.035 + (remoteAim.pull || 0));
    ghostStick.lookAt(base.clone().addScaledVector(back, 5));
    ghostStick.visible = true;
  } else {
    ghostStick.visible = false;
  }
}

function startOnline(opts) {
  onlineMode = true;
  mySeat = opts.mySeat | 0;
  rng = mulberry32(opts.seed >>> 0);
  players[0].cfg.name = opts.names[0];
  players[1].cfg.name = opts.names[1];
  players[0].group = players[1].group = null;
  turn = 0;                        // seat 0 = breaker
  rackBalls();
  shotEvents = { potted: [], scratch: false, firstHit: null, eightPocket: -1 };
  remoteAim = null; ghostStick.visible = false; watcherStriking = false; snapBuf = [];
  striking = false; stick.visible = false; lastEnd = null; lastAimKey = '';
  setCalledPocket(-1);
  pinnedMsg = null; // clear any prompt pinned from a previous game
  state = S.AIM; wasMoving = false;
  cam.yaw = -Math.PI / 2; cam.pitch = START_PITCH; cam.radius = START_RADIUS;

  ['landingOverlay', 'modeOverlay', 'loginOverlay', 'signupOverlay', 'lobbyOverlay', 'setupOverlay', 'endOverlay']
    .forEach(id => { const e = document.getElementById(id); if (e) e.classList.add('hidden'); });
  document.getElementById('hud').classList.remove('hidden');
  document.getElementById('help').classList.remove('hidden');
  if (window.SettingsPanel) window.SettingsPanel.show();
  document.getElementById('styleName').textContent = TABLE_STYLES[currentTableStyle].name.toUpperCase();
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

window.PoolNetGame = {
  startOnline, endOnline, apply,
  isOnline: () => onlineMode,
  setSink(fn) { netSink = fn; },
  onExit(fn) { netExit = fn; },
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

function updateHUD() {
  for (let i = 0; i < 2; i++) {
    const card = document.getElementById('card' + i);
    const p = players[i];
    card.querySelector('.pname').textContent = p.cfg.name;
    card.querySelector('.pgroup').textContent =
      p.group ? (p.group === 'solid' ? 'Solids' : 'Stripes') : 'No group yet';
    card.classList.toggle('active', i === turn && state !== S.END);
    const dots = card.querySelector('.dots');
    dots.innerHTML = '';
    if (p.group) {
      const lo = p.group === 'solid' ? 1 : 9, hi = p.group === 'solid' ? 7 : 15;
      for (let id = lo; id <= hi; id++) {
        if (balls[id].potted) continue;
        const d = document.createElement('div');
        d.className = 'dot' + (p.group === 'stripe' ? ' striped' : '');
        const c = BALL_COLORS[id > 8 ? id - 8 : id];
        d.style.background = p.group === 'stripe' ? '' : c;
        d.style.setProperty('--dc', c);
        dots.appendChild(d);
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

/* ----------------------------- setup screen ---------------------------- */

function buildSetupUI() {
  const row = document.getElementById('playersRow');
  row.innerHTML = '';
  players.forEach((p, i) => {
    const card = document.createElement('div');
    card.className = 'playerCard';
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
  document.getElementById('setupOverlay').classList.add('hidden');
  startMatch();
});
document.getElementById('rematchBtn').addEventListener('click', () => {
  document.getElementById('endOverlay').classList.add('hidden');
  if (onlineMode) { if (netExit) netExit(); return; } // online: back to lobby
  startMatch();
});
document.getElementById('changeBtn').addEventListener('click', () => {
  document.getElementById('endOverlay').classList.add('hidden');
  if (onlineMode) { if (netExit) netExit(); return; } // online: back to lobby
  document.getElementById('hud').classList.add('hidden');
  if (window.SettingsPanel) window.SettingsPanel.hide();
  buildSetupUI();
  document.getElementById('setupOverlay').classList.remove('hidden');
  state = S.SETUP;
  cam.goal.set(0, TABLE_Y, 0);
  cam.radius = 3.2; cam.pitch = 0.5;
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

  // While watching the opponent, the camera still orbits but the cue is locked.
  if (watching()) { ptr.mode = 'orbit'; return; }

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
  if (state === S.PLACING && !ptr.down) updatePlaceGhost(e.clientX, e.clientY);
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
      placeGhost.visible = false;
      canvas.classList.remove('placing');
      enterAim();
      unpinToast(); // the ball is placed; release the "place the cue ball" prompt
      // If the shooter is down to the 8-ball, placing hands straight over to the
      // pocket-call, which is itself a pinned prompt.
      if (state === S.CALLING) pinToast(`Only the 8-ball left — tap the pocket you'll call`);
      else toast(`${players[turn].cfg.name}'s shot`);
    } else {
      toast('Can’t place there — pick an open spot on the felt');
    }
  } else if (ptr.mode === 'call') {
    if (ptr.moved > 8) { ptr.mode = null; return; } // was an orbit drag, not a tap
    const pi = pocketAtPointer(e.clientX, e.clientY);
    if (pi >= 0) {
      setCalledPocket(pi);
      state = S.AIM;
      resetZoom(); // drop from the survey view back to the low first-person shot POV
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
  placeValid = true;
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
rackBalls();
updateHUD();
requestAnimationFrame(frame);

/* headless-test hooks: ?autostart skips setup, ?autoshot=0.9 fires the break */
const q = new URLSearchParams(location.search);
if (q.has('autostart')) {
  document.getElementById('landingOverlay').classList.add('hidden');
  document.getElementById('modeOverlay').classList.add('hidden');
  document.getElementById('setupOverlay').classList.add('hidden');
  startMatch();
  if (q.has('autoshot')) {
    const dbg = document.createElement('div');
    dbg.id = 'dbg';
    dbg.style.display = 'none';
    document.body.appendChild(dbg);
    setTimeout(() => fire(Math.min(1, parseFloat(q.get('autoshot')) || 0.9)), 500);
    setInterval(() => {
      dbg.textContent = JSON.stringify({
        state, turn,
        moving: anyMoving(),
        potted: balls.filter(b => b.potted).map(b => b.id),
        pos: balls.filter(b => !b.potted).map(b => [b.id, +b.x.toFixed(3), +b.z.toFixed(3)]),
      });
    }, 250);
  }
}

})();

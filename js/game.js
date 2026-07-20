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
function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = (Math.random() * (i + 1)) | 0;
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/* ================================= ROOM ================================= */

{
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(30, 30),
    mat('#232836', { roughness: 1 })
  );
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);

  // low-poly rug under the table
  const rug = new THREE.Mesh(new THREE.CircleGeometry(2.6, 10), mat('#57324a', { roughness: 1 }));
  rug.rotation.x = -Math.PI / 2;
  rug.position.y = 0.005;
  rug.receiveShadow = true;
  scene.add(rug);

  // hanging lamp (decor)
  const lampGrp = new THREE.Group();
  const cord = box(0.015, 1.6, 0.015, '#0d0f14');
  cord.position.y = 2.8;
  cord.castShadow = false; // thin cord otherwise streaks a line across the felt
  const shade = new THREE.Mesh(new THREE.ConeGeometry(0.42, 0.3, 8, 1, true), mat('#1e5c46', { side: THREE.DoubleSide }));
  shade.position.y = 2.0;
  const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.06, 8, 6),
    new THREE.MeshBasicMaterial({ color: '#fff2c0' }));
  bulb.position.y = 1.92;
  lampGrp.add(cord, shade, bulb);
  scene.add(lampGrp);
}

/* ================================= TABLE ================================ */

const FELT = '#2e7d4f';
const FELT_DARK = '#276b44';
const WOOD = '#5a3a24';
const WOOD_DARK = '#462c1a';

{
  const table = new THREE.Group();

  // slate / felt bed
  const bed = box(2 * PW + 0.06, 0.06, 2 * PH + 0.06, FELT);
  bed.position.y = TABLE_Y - 0.03;
  table.add(bed);

  // felt markings: head string spot + foot spot
  const spotGeo = new THREE.CircleGeometry(0.012, 8);
  for (const sx of [-PW / 2, PW / 2]) {
    const s = new THREE.Mesh(spotGeo, mat('#cfe3d5'));
    s.rotation.x = -Math.PI / 2;
    s.position.set(sx, TABLE_Y + 0.0008, 0);
    table.add(s);
  }

  // cushions: extruded trapezoids with angled ends near pocket mouths.
  // Shape lives in (x, y); after geometry.rotateX(-PI/2): length along x,
  // nose (shape +y) points toward -z, extrusion (height) points up.
  const cushH = 0.045, cushDepth = 0.052;
  function cushion(len, cut) {
    const half = len / 2;
    const s = new THREE.Shape();
    s.moveTo(-half, 0);
    s.lineTo(half, 0);
    s.lineTo(half - cut, cushDepth);
    s.lineTo(-half + cut, cushDepth);
    s.closePath();
    const g = new THREE.ExtrudeGeometry(s, { depth: cushH, bevelEnabled: false });
    g.rotateX(-Math.PI / 2);
    const m = new THREE.Mesh(g, mat(FELT_DARK));
    m.castShadow = true; m.receiveShadow = true;
    return m;
  }
  // long rails (z = ±PH): two segments each, split by the side pocket.
  // Nose face must land exactly on z = ±PH so bounce visuals match physics.
  const longLen = PW - CORNER_GAP - SIDE_GAP;
  const longCx = (PW - CORNER_GAP + SIDE_GAP) / 2;
  for (const zs of [-1, 1]) {
    for (const xs of [-1, 1]) {
      const c = cushion(longLen, 0.035);
      if (zs < 0) c.rotation.y = Math.PI;
      c.position.set(xs * longCx, TABLE_Y, zs * (PH + cushDepth));
      table.add(c);
    }
  }
  // short rails (x = ±PW)
  const shortLen = 2 * (PH - CORNER_GAP);
  for (const xs of [-1, 1]) {
    const c = cushion(shortLen, 0.035);
    c.rotation.y = xs > 0 ? Math.PI / 2 : -Math.PI / 2;
    c.position.set(xs * (PW + cushDepth), TABLE_Y, 0);
    table.add(c);
  }

  // wooden frame
  const railW = 0.11, railH = 0.09;
  const frameX = PW + cushDepth + railW / 2;
  const frameZ = PH + cushDepth + railW / 2;
  const fx = box(2 * (PW + cushDepth + railW), railH, railW, WOOD);
  for (const zs of [-1, 1]) {
    const r = fx.clone();
    r.position.set(0, TABLE_Y + 0.005, zs * frameZ);
    table.add(r);
  }
  const fz = box(railW, railH, 2 * (PH + cushDepth), WOOD);
  for (const xs of [-1, 1]) {
    const r = fz.clone();
    r.position.set(xs * frameX, TABLE_Y + 0.005, 0);
    table.add(r);
  }

  // Pockets: a flat dark "mouth" that reads as an opening flush with the cloth,
  // plus a shallow recess below for depth. The mouth uses polygonOffset so it
  // always wins the depth test against the coplanar felt (no z-fighting), which
  // is what caused the green/brown flicker when the rim sat level with the felt.
  const pocketMat = new THREE.MeshStandardMaterial({
    color: '#0a0a0f', flatShading: true, roughness: 0.95, metalness: 0.0,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  });
  for (const p of POCKETS) {
    const mouth = new THREE.Mesh(new THREE.CircleGeometry(p.r * 1.12, 18), pocketMat);
    mouth.rotation.x = -Math.PI / 2;
    mouth.position.set(p.x, TABLE_Y + 0.0015, p.z); // flush decal on the felt
    mouth.receiveShadow = true;
    table.add(mouth);
    // recess below (top kept just under the felt so it never coplanar-fights)
    const cup = new THREE.Mesh(
      new THREE.CylinderGeometry(p.r * 1.05, p.r * 0.8, 0.08, 12),
      pocketMat
    );
    cup.position.set(p.x, TABLE_Y - 0.045, p.z);
    table.add(cup);
  }

  // apron + legs
  const apron = box(2 * PW + 0.16, 0.12, 2 * PH + 0.16, WOOD_DARK);
  apron.position.y = TABLE_Y - 0.115;
  table.add(apron);
  for (const xs of [-1, 1]) for (const zs of [-1, 1]) {
    const leg = box(0.11, TABLE_Y - 0.16, 0.11, WOOD_DARK);
    leg.position.set(xs * (PW - 0.06), (TABLE_Y - 0.16) / 2, zs * (PH - 0.02));
    table.add(leg);
  }

  scene.add(table);
}

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

  const d = 2 * R * 1.005, dx = d * Math.SQRT1_2 * 1.24; // row spacing (~d*√3/2)
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

let shotEvents = { potted: [], scratch: false };

function anyMoving() {
  for (const b of balls) if (!b.potted && (b.vx !== 0 || b.vz !== 0)) return true;
  return false;
}

function potBall(b) {
  b.potted = true; b.sink = 0.25;
  b.vx = 0; b.vz = 0;
  b.mesh.position.set(b.x, BALL_Y, b.z);
  if (b.id === 0) shotEvents.scratch = true;
  else shotEvents.potted.push(b.id);
  sfx.pocket();
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
    for (const p of POCKETS) {
      const dx = b.x - p.x, dz = b.z - p.z;
      if (dx * dx + dz * dz < p.r * p.r) { potBall(b); captured = true; break; }
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
      let best = POCKETS[0], bd = Infinity;
      for (const p of POCKETS) {
        const d2 = (b.x - p.x) ** 2 + (b.z - p.z) ** 2;
        if (d2 < bd) { bd = d2; best = p; }
      }
      b.x = best.x; b.z = best.z;
      potBall(b);
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
  const aiming = (state === S.AIM || state === S.CHARGE) && !cue.potted;
  guideLine.visible = objLine.visible = ghostRing.visible = aiming;
  stick.visible = aiming || striking;
  if (!aiming) return; // while striking, fire()'s animation drives the stick

  const d = aimDir();
  const hit = castAim(cue.x, cue.z, d.x, d.y);
  const t = Math.min(hit.t, 6);
  const gx = cue.x + d.x * t, gz = cue.z + d.y * t;

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

  // stick: behind the ball, opposite aim dir, slightly elevated, pulled by charge
  const pull = state === S.CHARGE ? chargePull : 0;
  const back = new THREE.Vector3(-d.x, 0.14, -d.y).normalize();
  const base = new THREE.Vector3(cue.x, BALL_Y, cue.z);
  stick.position.copy(base).addScaledVector(back, 0.035 + pull);
  stick.lookAt(base.clone().addScaledVector(back, 5));
}

/* ============================== GAME STATE ============================== */

const S = { SETUP: 0, AIM: 1, CHARGE: 2, ROLLING: 3, PLACING: 4, END: 5 };
let state = S.SETUP;
let turn = 0;
let chargePull = 0;
let striking = false;      // strike animation in progress
let placeValid = false;

const players = [
  { cfg: { name: 'Player 1' }, group: null },
  { cfg: { name: 'Player 2' }, group: null },
];

function remaining(group) {
  const lo = group === 'solid' ? 1 : 9, hi = group === 'solid' ? 7 : 15;
  let n = 0;
  for (let i = lo; i <= hi; i++) if (!balls[i].potted) n++;
  return n;
}

function groupOf(id) { return id < 8 ? 'solid' : 'stripe'; }

/* ------------------------------- shooting ------------------------------ */

function fire(power) {
  const d = aimDir();
  const pull0 = chargePull;
  chargePull = 0;
  state = S.ROLLING;
  striking = true;
  const back = new THREE.Vector3(-d.x, 0.14, -d.y).normalize();
  const start = performance.now();
  const dur = 70;
  (function anim() {
    const t = (performance.now() - start) / dur;
    if (t >= 1) {
      striking = false;
      stick.visible = false;
      shotEvents = { potted: [], scratch: false };
      cue.vx = d.x * power * MAX_V;
      cue.vz = d.y * power * MAX_V;
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

  if (potted8) {
    // count remaining BEFORE this shot isn't needed: if group cleared now, 8 was last
    const clearedOwn = me.group && remaining(me.group) === 0;
    if (clearedOwn && !scratch) {
      return endGame(turn, `${me.cfg.name} sank the 8-ball. Clean finish!`);
    }
    const why = scratch ? 'scratched while sinking the 8-ball' : 'sank the 8-ball too early';
    return endGame(1 - turn, `${me.cfg.name} ${why}.`);
  }

  // group assignment on first legal pot
  if (!me.group && !scratch) {
    const first = potted.find(id => id !== 8);
    if (first != null) {
      me.group = groupOf(first);
      opp.group = me.group === 'solid' ? 'stripe' : 'solid';
      toast(`${me.cfg.name} is ${me.group === 'solid' ? 'SOLIDS' : 'STRIPES'}`);
    }
  }

  const pottedOwn = potted.some(id => me.group ? groupOf(id) === me.group : true);
  const keepTurn = !scratch && potted.length > 0 && pottedOwn;

  if (scratch) {
    turn = 1 - turn;
    toast(`Scratch! ${players[turn].cfg.name}: place the cue ball`);
    cue.vx = 0; cue.vz = 0;
    state = S.PLACING;
  } else {
    if (!keepTurn) turn = 1 - turn;
    else toast(`${me.cfg.name} shoots again`);
    state = S.AIM;
  }
  updateHUD();
}

function endGame(winner, reason) {
  state = S.END;
  document.getElementById('endTitle').textContent = `🏆 ${players[winner].cfg.name} wins!`;
  document.getElementById('endReason').textContent = reason;
  document.getElementById('endOverlay').classList.remove('hidden');
  updateHUD();
}

function startMatch() {
  players[0].group = null;
  players[1].group = null;
  turn = 0;
  rackBalls();
  shotEvents = { potted: [], scratch: false };
  state = S.AIM;
  cam.yaw = -Math.PI / 2; cam.pitch = 0.34; cam.radius = 0.95; // first-person: low, just behind the cue ball
  document.getElementById('hud').classList.remove('hidden');
  document.getElementById('help').classList.remove('hidden');
  toast(`${players[turn].cfg.name} breaks. Drag back from the cue ball to shoot.`);
  updateHUD();
}

/* ================================== UI ================================== */

const msgEl = document.getElementById('msg');
let msgTimer = null;
function toast(text, ms = 2600) {
  msgEl.textContent = text;
  msgEl.classList.add('show');
  clearTimeout(msgTimer);
  msgTimer = setTimeout(() => msgEl.classList.remove('show'), ms);
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
    state === S.END ? 'Game over' : `${players[turn].cfg.name}'s turn`;
}

const powerWrap = document.getElementById('powerWrap');
const powerFill = document.getElementById('powerFill');

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

document.getElementById('startBtn').addEventListener('click', () => {
  sfx.unlock();
  document.getElementById('setupOverlay').classList.add('hidden');
  startMatch();
});
document.getElementById('rematchBtn').addEventListener('click', () => {
  document.getElementById('endOverlay').classList.add('hidden');
  startMatch();
});
document.getElementById('changeBtn').addEventListener('click', () => {
  document.getElementById('endOverlay').classList.add('hidden');
  document.getElementById('hud').classList.add('hidden');
  buildSetupUI();
  document.getElementById('setupOverlay').classList.remove('hidden');
  state = S.SETUP;
  cam.goal.set(0, TABLE_Y, 0);
  cam.radius = 3.2; cam.pitch = 0.5;
});

window.addEventListener('keydown', e => {
  if (e.key === 'h' || e.key === 'H') document.getElementById('help').classList.toggle('hidden');
});

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

  if (state === S.PLACING) {
    ptr.mode = 'place'; // tap places the ball; dragging orbits the camera
    updatePlaceGhost(e.clientX, e.clientY);
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
      state = S.AIM;
      toast(`${players[turn].cfg.name}'s shot`);
    } else {
      toast('Can’t place there — pick an open spot on the felt');
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

canvas.addEventListener('contextmenu', e => e.preventDefault());

/* ball-in-hand ghost placement */
const rc = new THREE.Raycaster();
const tablePlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -BALL_Y);
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

  // physics
  if (state === S.ROLLING || anyMoving()) {
    physAcc += dt;
    while (physAcc >= PHYS_H) {
      physicsStep(PHYS_H);
      physAcc -= PHYS_H;
    }
  }

  const moving = anyMoving();
  if (state === S.ROLLING && wasMoving && !moving && !striking) {
    resolveShot();
  }
  wasMoving = moving;

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

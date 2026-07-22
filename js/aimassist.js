/* Aim assist — selectable guides for the shooter. Two independent options that
   can be combined, used separately, or both turned off ("no aim assist"):

     • lines   — the dashed cue guide, ghost-ball ring and object-ball line.
     • pockets — a pocket glows transparent green when the ball currently being
                 aimed at is lined up to drop into it.

   Toggleable live during a game, from the in-game settings panel. All the
   rendering, prediction and UI for this feature lives here; game.js only
   exposes the geometry it needs (window.PoolAimHooks) and asks this module
   whether lines are on / to refresh the pocket preview each frame. */
(function () {
'use strict';

const hooks = window.PoolAimHooks;
if (!hooks) { console.warn('AimAssist: PoolAimHooks missing'); return; }
const { POCKETS, R, balls } = hooks;

const settings = { lines: true, pockets: true }; // default: both aids on

/* --------------------------- pocket glow control ------------------------ */

let litPocket = -1; // which pocket's void is currently glowing green (-1 = none)

// Glow exactly one pocket (or none for -1), avoiding redundant material writes.
function lightPocket(i) {
  if (i === litPocket) return;
  if (litPocket >= 0) hooks.setPocketGlow(litPocket, false);
  if (i >= 0) hooks.setPocketGlow(i, true);
  litPocket = i;
}

function hideGlow() { lightPocket(-1); }

/* Is the path from the object ball to a pocket blocked by another ball? */
function pathBlocked(obj, dx, dz, dist) {
  const DD = (2 * R) * (2 * R);
  for (const o of balls) {
    if (o === obj || o.id === 0 || o.potted) continue;
    const mx = o.x - obj.x, mz = o.z - obj.z;
    const proj = mx * dx + mz * dz;
    if (proj <= 0 || proj >= dist) continue;
    if (mx * mx + mz * mz - proj * proj < DD) return true;
  }
  return false;
}

/* Given the aim's ghost-contact point (gx,gz) and the ball it strikes, light up
   the pocket the object ball is lined up to fall into (if any). */
function updateAim(hit, gx, gz) {
  if (!settings.pockets || !hit || !hit.ball) { hideGlow(); return; }

  const b = hit.ball;
  // Object ball leaves along the line from the contact point through its center.
  let dx = b.x - gx, dz = b.z - gz;
  const dl = Math.hypot(dx, dz) || 1;
  dx /= dl; dz /= dl;

  let best = -1, bestPerp = Infinity;
  for (let i = 0; i < POCKETS.length; i++) {
    const p = POCKETS[i];
    const mx = p.x - b.x, mz = p.z - b.z;
    const proj = mx * dx + mz * dz;
    if (proj <= 0) continue;                       // pocket is behind the ball
    const perp = Math.sqrt(Math.max(0, mx * mx + mz * mz - proj * proj));
    if (perp > p.r * 0.82) continue;               // would rattle / miss
    if (pathBlocked(b, dx, dz, proj)) continue;    // another ball is in the way
    if (perp < bestPerp) { bestPerp = perp; best = i; }
  }
  lightPocket(best);
}

/* --------------------------------- UI ----------------------------------- */

const OPTIONS = [
  { key: 'lines',   short: 'LINES' },
  { key: 'pockets', short: 'POCKETS' },
];
const buttons = []; // {key, el}

function refresh() {
  for (const b of buttons) b.el.classList.toggle('on', settings[b.key]);
}

function toggle(key) {
  settings[key] = !settings[key];
  if (!settings.pockets) hideGlow();
  refresh();
}

function buildInto(container) {
  if (!container) return;
  for (const opt of OPTIONS) {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'aimTgl';
    el.textContent = opt.short;
    el.addEventListener('click', () => toggle(opt.key));
    container.appendChild(el);
    buttons.push({ key: opt.key, el });
  }
}

buildInto(document.getElementById('aimSwitch'));      // in-game switcher
refresh();

/* ------------------------------- exports -------------------------------- */

window.AimAssist = {
  showLines() { return settings.lines; },
  showPockets() { return settings.pockets; },
  updateAim,
  clear: hideGlow,
};

})();

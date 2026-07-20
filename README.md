# 🎱 Low-Poly Billiards

A low-poly 3D 8-ball game for two players at one screen. Three.js rendering,
custom physics, no build step, no network needed.

## Run it

Just open `index.html` in a browser (double-click it). Everything is local —
`lib/three.min.js` is vendored and all textures are generated at runtime.

## How to play

1. **Setup** — each player picks a name, skin tone, shirt color, and hat.
   The avatars stand at the table and update live as you customize.
2. **Aim** — drag anywhere to orbit the camera around the cue ball;
   scroll (or pinch) to zoom. Your shot always goes where the camera faces —
   the dashed line shows the cue ball's path, the yellow line shows where the
   struck ball will go.
3. **Shoot** — press on the cue ball and drag backwards to pull the cue back
   (the power bar fills), then release to strike.
4. **Rules** — standard simplified 8-ball:
   - First potted ball assigns your group (solids or stripes).
   - Pot one of your own balls to keep your turn.
   - Potting the cue ball is a scratch: opponent gets ball-in-hand
     (tap the felt to place it; drag still orbits).
   - Clear your group, then pot the 8-ball to **win**.
   - Potting the 8-ball early — or scratching while sinking it — **loses**.

Press **H** to toggle the controls help.

## Tech notes

- **Physics** (`js/game.js`): fixed 1/480 s substeps; ball–ball collisions are
  equal-mass elastic impulses with restitution 0.95 and positional correction;
  cushions reflect with restitution 0.72 plus tangential grip loss, so bounce
  angles flatten realistically; friction is a constant + linear rolling drag.
- **Pockets**: six capture circles with cushion cut-backs at each mouth, so
  balls can be rattled in off the jaws.
- **Debug hooks**: `index.html?autostart` skips setup;
  `?autostart&autoshot=0.9` auto-fires the break (used for headless testing).

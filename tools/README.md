# Pixel Pool — offline tools

Everything here runs outside the game: headless simulation, training-data
generation, and the model training that produces `js/potmodel.json`.

## Why any of this exists

`js/bot.js` scores a pot with a hand-tuned line:

```js
hardness = (1 - cosCut) * 2.4 + (dCue + dObj) * 0.55 + railHug
```

standing in for something measurable: the **make window**, the half-width in
radians of the band of aim errors that still drops the ball.

`game.js` already computes that window *exactly* — `tuneAim`'s `FAN`/`STEP` fan
search, which is what sets the bot's wobble — but only for the one shot it has
already committed to. What it cannot do is compute it for the hundreds of
candidates weighed while **choosing**: a few hundred raycasts each is far too
slow inside the position lookahead. So the model's job is to **distil an
expensive exact computation into a cheap closed form**, and its value is in shot
selection, not in execution accuracy.

The window is pure geometry, which keeps skill out of the model:

```
P(pot) = P(makeable) · erf( w / (σ · √2) )
```

`σ` is the shooter's aim error, so difficulty is a knob rather than a
retraining job.

Note what is *not* used: the `matches` table. It holds ~11 games, and
`js/stats.js` logs shot direction but not power. **All training data comes from
the simulator**, which is unlimited and fully labelled.

## The pieces

| File | Does |
|------|------|
| `cdp.js` | Chrome DevTools Protocol driver (Node 22's global `WebSocket`, no dependency) |
| `record-shots.js` | Records real browser shots by wrapping `PoolPhysics.step` in the page |
| `verify-physics.js` | Replays those in Node and demands an exact match — **the gate on `js/physics.js`** |
| `dump-config.js` | Writes the live physics constants per game to `data/physics-<game>.json` |
| `gen-pot-samples.js` | Measures make windows by bisection against the simulator → JSONL |
| `train_pot.py` | Two-head Keras model → `js/potmodel.json` |
| `check-potmodel.js` | Proves the hand-written JS forward pass matches Keras |
| `eval-potmodel.js` | Scores model vs heuristic on held-out **real** layouts |

## Run it

Needs the game served locally and headless Chrome on port 9222:

```bash
npm start                                    # serve on :8099 (PORT=8099)
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless=new --remote-debugging-port=9222 --disable-gpu \
  --use-angle=swiftshader --no-first-run --user-data-dir=/tmp/ppchrome
```

```bash
# 1. confirm the extracted physics core still matches the browser exactly
node tools/record-shots.js --game=8ball --shots=30
node tools/verify-physics.js

# 2. capture the live constants, then generate labelled shots
node tools/dump-config.js
node tools/gen-pot-samples.js --game=8ball --n=20000 --seed=1

# 3. train, then check the JS forward pass agrees with Keras
python3 -m venv .venv && .venv/bin/pip install tensorflow numpy
.venv/bin/python tools/train_pot.py --data data/pot-samples-8ball.jsonl
node tools/check-potmodel.js

# 4. score it against the heuristic on real layouts it was never trained on
node tools/eval-potmodel.js --game=8ball --layouts=200
```

`.venv/` and the generated data are gitignored; the trained weights
(`js/potmodel.json`) are committed, because they ship to the browser.

## Two traps

**Anything driving the game from outside must be the only thing holding the
cue.** `?autostart` defaults to vs-CPU, and the bot firing its own stroke into a
roll already underway re-launches the cue ball mid-shot *and resets
`shotEvents` with it* (see `launchCue`). Use `?nocpu`. The tell is an
end-of-shot accumulator reading `firstHit: null` after a long roll.

**Features must come from the code that will consume them.** `potCandidates`,
`legalTargets`, `powerFor` and `aimSigma` are exported from `js/bot.js` purely
so `gen-pot-samples.js` calls the same geometry rather than reimplementing it
and drifting.

## Where it stands

**Wired in.** `potCandidates` in `js/bot.js` now overwrites `hardness` with the
model's estimate when the weights have loaded, so the sort, `easiestPot`, the
`MAX_HARDNESS` gate and `bestPot`'s scoring all run on the better number without
knowing anything changed. `geoHardness` keeps the original line alongside it, as
the fallback and as the baseline these tools measure against.

The model's output is mapped onto the legacy `hardness` scale by a fit shipped
in the blob (`hardnessScale`), matched on **distribution** rather than
conditional mean — so `MAX_HARDNESS` still rejects the same fraction of shots
(0.0% → 0.3%) and every constant tuned against that scale keeps its meaning.
The change is in the *ranking*, not in how often the bot bails to a safety.

| | learned | hand-tuned `hardness` |
|---|---|---|
| ranks difficulty, random scatters (Spearman vs log w) | **0.855** | 0.636 |
| ranks difficulty, **held-out real layouts** | **0.775** | 0.600 |
| picks the widest window on the table (top-1) | **75.5%** | 62.3% |
| "is it makeable" (AUC) | **0.900** | 0.863 |

Held-out numbers come from `tools/eval-potmodel.js`, run on browser-recorded
layouts the model never saw — random scatters cover the table, but the bot only
ever reaches the positions its own judgement takes it to, so generalisation had
to be checked separately. Cost is in the noise: the forward pass is ~1,400
multiply-adds against roll-out simulations that dominate every decision.

`js/physics.js` reproduces the browser **bit-for-bit on 80/80 recorded shots**
across all three beds, and the JS forward pass matches Keras to 1.4e-7.

**Still not shown: that any of this wins more games.** Better shot ranking is
necessary but not sufficient — proving it needs a headless match driver, and the
turn/resolve loop still lives inside `game.js`'s IIFE. Judge that on **win rate,
not pot rate**: a calibrated model can make the bot worse by making thin cuts
look quantifiably viable. The top-1 margin above (40/53 vs 33/53) is suggestive,
not decisive, at that sample size.

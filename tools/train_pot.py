"""Train the shot-outcome model for Pixel Pool.

Input is the JSONL written by tools/gen-pot-samples.js: one row per candidate
pot, with the geometry js/bot.js already computes and, as the label, the make
window measured against the real simulator — the half-width in radians of the
band of aim errors that still drops the ball.

The model has two heads, because the label really is two questions:

    makeable   is there ANY aim that pots this?  (some candidates survive
               potCandidates' filters but cannot actually be potted at the
               chosen speed)
    log w      given that there is, how wide is the window?

which the bot combines at decision time into the only number it wants:

    P(pot) = P(makeable) * erf( w / (sigma * sqrt(2)) )

with sigma the shooter's aim error. Keeping skill OUT of the model is the whole
point: difficulty becomes a knob rather than a retraining job.

log w, not w — the window spans three orders of magnitude, from a hanger you
could hit with your eyes shut to a cut that needs a thousandth of a radian.

Output is js/potmodel.json: normalisation stats plus dense weights, small enough
for a hand-written forward pass in the browser (see js/potmodel.js). No
TensorFlow ships to the client.

Usage:
    .venv/bin/python tools/train_pot.py [--data data/pot-samples-8ball.jsonl]
                                        [--out js/potmodel.json] [--epochs 60]
"""

import argparse
import json
import math
import os
import sys

import numpy as np
import tensorflow as tf
from tensorflow import keras

# The feature vector, in the order the JS forward pass will build it. Changing
# this list means regenerating the samples AND updating js/potmodel.js.
FEATURES = [
    "cosCut",    # cos of the cut angle: 1 is straight in, 0 is a 90-degree cut
    "dCue",      # cue ball to ghost-ball contact point, world units
    "dObj",      # object ball to pocket, world units
    "power",     # stroke power, 0..1 (the bot picks this before asking)
    "side",      # 1 for a side pocket, 0 for a corner
    "railT",     # target's distance to the nearest cushion, in ball radii
    "railC",     # cue ball's distance to the nearest cushion, in ball radii
    "clearCue",  # tightest gap on the cue's line, in ball radii (capped at 8)
    "clearObj",  # tightest gap on the object's line, in ball radii
]
# Floor for log w, so the regression head has a finite target everywhere. Well
# below the tightest window the simulator ever measures.
LOG_W_FLOOR = math.log(1e-5)


def load(path):
    rows = []
    with open(path) as fh:
        for line in fh:
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    if not rows:
        sys.exit(f"no samples in {path}")
    x = np.array([[r[f] for f in FEATURES] for r in rows], dtype=np.float32)
    w = np.array([r["w"] for r in rows], dtype=np.float32)
    makeable = (w > 0).astype(np.float32)
    logw = np.where(w > 0, np.log(np.maximum(w, 1e-9)), LOG_W_FLOOR).astype(np.float32)
    hardness = np.array([r["hardness"] for r in rows], dtype=np.float32)
    return x, makeable, logw, hardness


def spearman(a, b):
    ra = np.argsort(np.argsort(a)).astype(np.float64)
    rb = np.argsort(np.argsort(b)).astype(np.float64)
    ra -= ra.mean(); rb -= rb.mean()
    return float((ra * rb).sum() / math.sqrt((ra * ra).sum() * (rb * rb).sum()))


def auc(labels, scores):
    """Rank-based AUC, no sklearn needed."""
    order = np.argsort(scores)
    ranks = np.empty(len(scores), dtype=np.float64)
    ranks[order] = np.arange(1, len(scores) + 1)
    pos, neg = labels.sum(), (1 - labels).sum()
    if pos == 0 or neg == 0:
        return float("nan")
    return float((ranks[labels == 1].sum() - pos * (pos + 1) / 2) / (pos * neg))


def build(n_features):
    inp = keras.Input(shape=(n_features,), name="features")
    h = keras.layers.Dense(32, activation="relu")(inp)
    h = keras.layers.Dense(32, activation="relu")(h)
    makeable = keras.layers.Dense(1, activation="sigmoid", name="makeable")(h)
    logw = keras.layers.Dense(1, name="logw")(h)
    return keras.Model(inp, [makeable, logw])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default="data/pot-samples-8ball.jsonl")
    ap.add_argument("--out", default="js/potmodel.json")
    ap.add_argument("--epochs", type=int, default=60)
    ap.add_argument("--batch", type=int, default=256)
    ap.add_argument("--seed", type=int, default=0)
    args = ap.parse_args()

    keras.utils.set_random_seed(args.seed)
    x, makeable, logw, hardness = load(args.data)
    print(f"{len(x)} samples, {int(makeable.sum())} makeable "
          f"({100 * makeable.mean():.1f}%)")

    # Split before normalising, so validation statistics stay honest.
    idx = np.random.default_rng(args.seed).permutation(len(x))
    cut = int(len(x) * 0.85)
    tr, va = idx[:cut], idx[cut:]

    mean = x[tr].mean(axis=0)
    std = x[tr].std(axis=0)
    std[std < 1e-6] = 1.0
    xn = (x - mean) / std

    # The regression head only has a meaningful target where the shot is on at
    # all, so unmakeable rows are weighted out of its loss rather than dragged
    # to the floor value.
    # Outputs are positional, not keyed: Keras 3 resolves per-output losses and
    # sample weights for a list-output model by index.
    model = build(x.shape[1])
    model.compile(
        optimizer=keras.optimizers.Adam(1e-3),
        loss=["binary_crossentropy", "mse"],
        loss_weights=[1.0, 0.5],
    )
    model.fit(
        xn[tr], [makeable[tr], logw[tr]],
        sample_weight=[np.ones(len(tr), np.float32), makeable[tr]],
        validation_data=(
            xn[va], [makeable[va], logw[va]],
            [np.ones(len(va), np.float32), makeable[va]],
        ),
        epochs=args.epochs, batch_size=args.batch, verbose=2,
        callbacks=[keras.callbacks.EarlyStopping(
            monitor="val_loss", patience=8, restore_best_weights=True)],
    )

    # ---------------------------------------------------------------- report
    pm, pl = model.predict(xn[va], verbose=0)
    pm, pl = pm.ravel(), pl.ravel()
    on = makeable[va] == 1

    print("\n--- validation ---")
    print(f"makeable head : AUC {auc(makeable[va], pm):.4f}")
    resid = pl[on] - logw[va][on]
    var = logw[va][on].var()
    print(f"log-w head    : MAE {np.abs(resid).mean():.3f} nats, "
          f"R2 {1 - resid.var() / var:.3f}, "
          f"Spearman {spearman(pl[on], logw[va][on]):.3f}")

    # The bar to clear: the hand-tuned heuristic the bot uses today. Lower
    # hardness is meant to mean an easier shot, hence the negation.
    print(f"\nbaseline `hardness`: AUC {auc(makeable[va], -hardness[va]):.4f}, "
          f"Spearman {spearman(-hardness[va][on], logw[va][on]):.3f}")

    # Calibration of the makeable head, which is the half a probability has to
    # be honest about.
    print("\nmakeable calibration (predicted -> actual):")
    edges = np.linspace(0, 1, 6)
    for lo, hi in zip(edges[:-1], edges[1:]):
        sel = (pm >= lo) & (pm < hi)
        if sel.sum() >= 10:
            print(f"  {lo:.1f}-{hi:.1f}: predicted {pm[sel].mean():.3f}  "
                  f"actual {makeable[va][sel].mean():.3f}  (n={int(sel.sum())})")

    # ---------------------------------------------------------------- export
    dense = [l for l in model.layers if isinstance(l, keras.layers.Dense)]
    blob = {
        "_comment": "Trained by tools/train_pot.py. Evaluated by js/potmodel.js.",
        "features": FEATURES,
        "mean": mean.tolist(),
        "std": std.tolist(),
        "logWFloor": LOG_W_FLOOR,
        "layers": [
            {
                "name": l.name,
                "activation": keras.activations.serialize(l.activation),
                "w": l.get_weights()[0].tolist(),   # [in][out]
                "b": l.get_weights()[1].tolist(),
            }
            for l in dense
        ],
    }
    os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
    with open(args.out, "w") as fh:
        json.dump(blob, fh)

    # Parity fixture: a hand-written forward pass ships to the browser, so it
    # has to be checked against Keras rather than assumed. tools/check-potmodel.js
    # replays these rows through js/potmodel.js and compares.
    n = min(500, len(va))
    check = {
        "features": FEATURES,
        "rows": x[va][:n].tolist(),
        "makeable": pm[:n].tolist(),
        "w": np.exp(pl[:n]).tolist(),
    }
    with open("data/potmodel-check.json", "w") as fh:
        json.dump(check, fh)
    print(f"wrote data/potmodel-check.json — {n} rows for the JS parity check")
    n_params = sum(np.prod(l.get_weights()[0].shape) + l.get_weights()[1].shape[0]
                   for l in dense)
    print(f"\nwrote {args.out} — {int(n_params)} parameters, "
          f"{os.path.getsize(args.out) / 1024:.0f} KB")


if __name__ == "__main__":
    main()

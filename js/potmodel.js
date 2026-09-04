/* Shot-outcome model for Pixel Pool — "how likely is this pot?"
 *
 * js/bot.js scores a pot with a hand-tuned line (`hardness`) standing in for
 * something measurable: the MAKE WINDOW, the half-width in radians of the band
 * of aim errors that still drops the ball. This module carries a small network
 * trained on that window as measured against the real simulator.
 *
 * game.js already computes the window EXACTLY for the one shot the bot commits
 * to — tuneAim's fan search, which is what sets the bot's wobble. What it
 * cannot do is compute it for the hundreds of candidates weighed while
 * CHOOSING a shot: a few hundred raycasts each is far too slow inside the
 * position lookahead. So this is a distillation — the expensive exact answer,
 * made cheap enough to ask everywhere.
 *
 * Two heads, because the label is two questions:
 *     makeable  is there any aim at all that pots this at this speed?
 *     w         given there is, how wide is the window?
 * which combine into the only number the caller wants:
 *     P(pot) = P(makeable) * erf( w / (sigma * sqrt(2)) )
 * `sigma` is the shooter's aim error, and it is deliberately NOT part of the
 * model: the window is pure geometry, so difficulty stays a knob rather than a
 * retraining job, and the same weights serve every skill level.
 *
 * The weights live in js/potmodel.json (a few KB, written by
 * tools/train_pot.py). The forward pass is hand-written below — two dense
 * layers is a few hundred multiply-adds, far cheaper than the dispatch overhead
 * of a tensor library, and it keeps the page free of a second WebGL context
 * competing with the renderer.
 *
 * Everything degrades gracefully: until the weights land, ready() is false and
 * callers fall back to the heuristic they used before.
 */
(function (root, factory) {
  const api = factory();
  root.PoolPotModel = api;
  if (typeof module === 'object' && module.exports) module.exports = api; // tools/
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  let net = null;        // the loaded blob
  let loading = null;    // in-flight fetch, so concurrent load() calls share one

  /* Abramowitz & Stegun 7.1.26 — max error 1.5e-7, which is far below the
     accuracy of anything downstream of it here. */
  function erf(x) {
    const s = x < 0 ? -1 : 1;
    x = Math.abs(x);
    const t = 1 / (1 + 0.3275911 * x);
    const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t
      - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
    return s * y;
  }

  function ready() { return net !== null; }

  /* Fetch the weights. Safe to call more than once; failure is not fatal — the
     caller simply keeps using its own heuristic. */
  function load(url) {
    if (net) return Promise.resolve(net);
    if (loading) return loading;
    loading = fetch(url || 'js/potmodel.json')
      .then(r => (r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status))))
      .then(blob => {
        if (!blob || !Array.isArray(blob.layers) || !Array.isArray(blob.features)) {
          throw new Error('malformed model blob');
        }
        net = blob;
        return net;
      })
      .catch(err => {
        console.warn('PotModel: no shot-outcome model loaded —', err.message);
        loading = null;
        return null;
      });
    return loading;
  }

  // Adopt an already-parsed blob (Node tooling, tests) instead of fetching.
  function use(blob) { net = blob; return net; }

  /* The map from log(effective window) onto js/bot.js's legacy `hardness`
     scale, fitted at training time. Lets the bot swap in a calibrated number
     without any of its tuned thresholds changing meaning. */
  function hardnessScale() { return net ? net.hardnessScale : null; }

  /* One dense layer: y = act(x . W + b), W stored as [in][out]. */
  function dense(x, layer) {
    const W = layer.w, b = layer.b, out = new Array(b.length);
    for (let j = 0; j < b.length; j++) {
      let s = b[j];
      for (let i = 0; i < x.length; i++) s += x[i] * W[i][j];
      out[j] = layer.activation === 'relu' ? (s > 0 ? s : 0)
        : layer.activation === 'sigmoid' ? 1 / (1 + Math.exp(-s))
          : s;
    }
    return out;
  }

  /* Run the net. `f` is a plain object keyed by the feature names in the blob,
     so the caller can't silently get the order wrong. Returns
     { makeable, w } — a probability and a window half-width in radians. */
  function predict(f) {
    if (!net) return null;
    const names = net.features;
    const x = new Array(names.length);
    for (let i = 0; i < names.length; i++) {
      const v = f[names[i]];
      if (typeof v !== 'number' || !isFinite(v)) return null;
      x[i] = (v - net.mean[i]) / net.std[i];
    }
    // Shared trunk, then the two heads read off the last hidden layer.
    const L = net.layers;
    let h = x;
    for (let i = 0; i < L.length - 2; i++) h = dense(h, L[i]);
    const makeable = dense(h, L[L.length - 2])[0];
    const logw = dense(h, L[L.length - 1])[0];
    return { makeable, w: Math.exp(logw) };
  }

  /* The number the bot actually wants: the chance this pot drops, for a shooter
     whose aim error has standard deviation `sigma` radians. Returns null when
     no model is loaded, so callers can tell "no model" from "no chance". */
  function potProbability(f, sigma) {
    const p = predict(f);
    if (!p) return null;
    if (!(sigma > 0)) return p.makeable;          // a perfect cue never misses
    return p.makeable * erf(p.w / (sigma * Math.SQRT2));
  }

  return { load, use, ready, predict, potProbability, hardnessScale, erf };
});

/* runstats.js - summary statistics and convergence curves over several independent runs.
 * Pure functions (no DOM), usable in the browser (window.RunStats) and in Node (tests).
 *
 * A run's history is a list of [iteration, best cost so far, active time in ms] sorted by iteration; the best-so-far
 * curve is a step function, extended by its last value after the run has ended.  The standard deviation is the
 * sample standard deviation (n - 1); it is 0 for a single run. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RunStats = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const mean = a => a.reduce((s, x) => s + x, 0) / a.length;
  const sd = a => {
    if (a.length < 2) return 0;
    const m = mean(a); let s = 0;
    for (const x of a) s += (x - m) * (x - m);
    return Math.sqrt(s / (a.length - 1));
  };
  const median = a => {
    const b = a.slice().sort((p, q) => p - q), h = b.length >> 1;
    return b.length % 2 ? b[h] : (b[h - 1] + b[h]) / 2;
  };
  function summary(values) {
    if (!values.length) return null;
    return { n: values.length, min: Math.min(...values), max: Math.max(...values), mean: mean(values), sd: sd(values), median: median(values) };
  }
  const gapPct = (cost, ref) => 100 * (cost / ref - 1);

  /* value of a step-function history at coordinate x (xi = 0: iteration, 2: time in ms); before the first entry
   * the first value applies */
  function valueAt(hist, xi, x) {
    let lo = 0, hi = hist.length - 1;
    if (x < hist[0][xi]) return hist[0][1];
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (hist[mid][xi] <= x) lo = mid; else hi = mid - 1; }
    return hist[lo][1];
  }

  /* runs: [{hist, ...}], axis: 'iter' | 'time', points: grid size.  Returns the grid and, for every grid point, the
   * mean / sd / min / max over runs plus each run's own curve.  `xmax` defaults to the largest coordinate reached. */
  function curves(runs, axis, points, xmax) {
    const xi = axis === 'time' ? 2 : 0;
    let top = 0;
    for (const r of runs) top = Math.max(top, r.end != null ? r.end : r.hist[r.hist.length - 1][xi]);
    if (xmax != null) top = xmax;
    if (!(top > 0)) top = 1;
    const grid = [], each = runs.map(() => []), m = [], s = [], lo = [], hi = [];
    for (let k = 0; k < points; k++) {
      const x = top * k / (points - 1); grid.push(x);
      const vals = runs.map((r, i) => { const v = valueAt(r.hist, xi, x); each[i].push(v); return v; });
      m.push(mean(vals)); s.push(sd(vals)); lo.push(Math.min(...vals)); hi.push(Math.max(...vals));
    }
    return { grid, each, mean: m, sd: s, min: lo, max: hi, xmax: top };
  }

  /* "nice" axis ticks covering [lo, hi] */
  function ticks(lo, hi, count) {
    if (!(hi > lo)) return [lo];
    const raw = (hi - lo) / Math.max(1, count), pow = Math.pow(10, Math.floor(Math.log10(raw))), f = raw / pow;
    const step = (f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10) * pow, out = [];
    for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(+v.toPrecision(12));
    return out;
  }

  return { mean, sd, median, summary, gapPct, valueAt, curves, ticks };
});

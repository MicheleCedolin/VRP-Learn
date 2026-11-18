// Unit tests for the browser-side logic that runs in Node: statistics (runstats.js), the sliced job runner
// (VRP.createJob) and the history format used by the Solver page.  Exit code 0 = all passed, 77 = skipped (no data).
const fs = require('fs'), path = require('path'), assert = require('assert');
const root = [path.join(__dirname, '..'), path.join(__dirname, '..', '..')].find(r => fs.existsSync(path.join(r, 'docs', 'assets', 'vrp.js')));
const V = require(path.join(root, 'docs', 'assets', 'vrp.js'));
const R = require(path.join(root, 'docs', 'assets', 'runstats.js'));
let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log('[ ok ] ' + name); };
const near = (a, b, e = 1e-9) => assert.ok(Math.abs(a - b) <= e, `${a} vs ${b}`);

test('summary: mean, sample sd, median', () => {
  const s = R.summary([2, 4, 4, 4, 5, 5, 7, 9]);
  near(s.mean, 5); near(s.sd, Math.sqrt(32 / 7)); near(s.median, 4.5); assert.strictEqual(s.min, 2); assert.strictEqual(s.max, 9);
  assert.strictEqual(R.sd([3]), 0); assert.strictEqual(R.summary([]), null);
});
test('valueAt is a right-continuous step function', () => {
  const h = [[0, 100, 0], [10, 90, 5], [50, 80, 20]];
  assert.strictEqual(R.valueAt(h, 0, -1), 100); assert.strictEqual(R.valueAt(h, 0, 0), 100); assert.strictEqual(R.valueAt(h, 0, 9.9), 100);
  assert.strictEqual(R.valueAt(h, 0, 10), 90); assert.strictEqual(R.valueAt(h, 0, 1e9), 80); assert.strictEqual(R.valueAt(h, 2, 19), 90);
});
test('curves: mean and sd over runs on a common grid', () => {
  const runs = [{ hist: [[0, 100, 0], [10, 90, 5], [50, 80, 20]] }, { hist: [[0, 100, 0], [20, 70, 8]] }];
  const c = R.curves(runs, 'iter', 6);
  assert.deepStrictEqual(c.grid, [0, 10, 20, 30, 40, 50]); assert.deepStrictEqual(c.mean, [100, 95, 80, 80, 80, 75]);
  near(c.sd[1], Math.sqrt(50)); near(c.sd[0], 0); assert.deepStrictEqual(c.min, [100, 90, 70, 70, 70, 70]);
});
test('ticks cover the range with round values', () => {
  const t = R.ticks(27500, 28900, 5); assert.ok(t[0] >= 27500 && t[t.length - 1] <= 28900 && t.length >= 3);
  const step = t[1] - t[0]; t.forEach((v, i) => near(v, t[0] + i * step, 1e-6));
});

const file = path.join(root, 'docs', 'data', 'cvrp', 'X-n101-k25.vrp');
if (!fs.existsSync(file)) { console.log('SKIP: docs/data/cvrp/X-n101-k25.vrp missing'); console.log(passed + ' passed, benchmark tests skipped'); process.exit(passed ? 77 : 1); }
const I = V.parseInstance(fs.readFileSync(file, 'utf8'), 'X-n101-k25');
const cfg = { construct: 'savings', mode: 'sisr', iters: 4000, seed: 7, ops: V.PRESETS.full, k: 12 };
function runJob(cfg, ms) { const J = V.createJob(I, cfg); const msgs = []; let m; do { m = J.poll(ms); msgs.push(m); } while (!m.done); return { msgs, res: J.result(false) }; }

test('createJob is deterministic and independent of the slice length', () => {
  const a = runJob(cfg, 5), b = runJob(cfg, 1e9);
  assert.strictEqual(a.res.cost, b.res.cost); assert.deepStrictEqual(a.res.sol, b.res.sol);
  assert.deepStrictEqual(a.res.hist.map(p => p.slice(0, 2)), b.res.hist.map(p => p.slice(0, 2)));
});
test('different seeds give different runs; every result is feasible and re-costs correctly', () => {
  const r1 = runJob(cfg, 50).res, r2 = runJob(Object.assign({}, cfg, { seed: 8 }), 50).res;
  assert.notStrictEqual(r1.cost, r2.cost);
  for (const r of [r1, r2]) { assert.deepStrictEqual(r.violations, []); near(r.cost, V.solCost(I, r.sol), 1e-6); }
});
test('history: starts at iteration 0, non-increasing cost, non-decreasing iteration and time', () => {
  const { res, msgs } = runJob(cfg, 5), h = res.hist;
  assert.strictEqual(h[0][0], 0); near(h[0][1], res.initCost, 1e-6);
  for (let i = 1; i < h.length; i++) { assert.ok(h[i][0] > h[i - 1][0]); assert.ok(h[i][1] < h[i - 1][1]); assert.ok(h[i][2] >= h[i - 1][2]); }
  near(h[h.length - 1][1], res.cost, 1e-6);
  const streamed = [].concat(...msgs.map(m => m.hist)); assert.deepStrictEqual(streamed, h);          // progress tails add up to the full history
  assert.ok(res.seconds > 0 && res.iter === cfg.iters);
});
test('stopping early returns the best solution so far, flagged as stopped', () => {
  const J = V.createJob(I, Object.assign({}, cfg, { iters: 1e7 })); J.poll(30);
  const r = J.result(true); assert.strictEqual(r.stopped, true); assert.ok(r.iter > 0 && r.iter < 1e7); assert.deepStrictEqual(r.violations, []);
});
test('ILS jobs and the other starting solutions run to a feasible result', () => {
  for (const [construct, mode, iters] of [['sweep', 'ils', 60], ['nn', 'sisr', 2000]]) {
    const r = runJob({ construct, mode, iters, seed: 3, ops: V.PRESETS.standard, k: 12 }, 50).res;
    assert.deepStrictEqual(r.violations, []); assert.ok(r.cost <= r.initCost + 1e-6);
  }
});

// ---- trace hooks used by the animations on the Learn page
test('savings trace replays to exactly the solution of VRP.savings', () => {
  for (const [n, seed] of [[12, 1], [20, 2], [30, 3]]) {
    const J = V.generate(n, 1, seed, { routeSize: 5 });
    const tr = []; const sol = V.savings(J, tr), plain = V.savings(J);
    assert.deepStrictEqual(sol, plain);                                           // tracing does not change the result
    let routes = []; for (let c = 0; c < J.n; c++) routes.push([c]);
    for (const e of tr.filter(e => e.ok)) {
      routes = routes.filter(r => !r.includes(e.i) && !r.includes(e.j)); routes.push(e.M);
    }
    const key = rs => rs.map(r => r.join(',')).sort().join('|');
    assert.strictEqual(key(routes), key(sol.routes.map(r => r.nodes)));
    assert.ok(tr.every(e => e.ok || ['same', 'ends', 'limit'].includes(e.why)));
  }
});
test('sweep trace lists every customer once, in angular order, and matches the route structure', () => {
  const J = V.generate(25, 1, 4, { routeSize: 6 }), tr = {};
  const sol = V.sweep(J, tr);
  assert.deepStrictEqual(sol, V.sweep(J));
  assert.strictEqual(tr.events.length, J.n); assert.strictEqual(new Set(tr.events.map(e => e.c)).size, J.n);
  for (let k = 1; k < tr.events.length; k++) assert.ok(tr.events[k].ang >= tr.events[k - 1].ang - 1e-12);
  assert.strictEqual(tr.events.filter(e => e.newRoute).length, sol.routes.length);
});
test('search lastMove reports the ruined customers, the candidate and the acceptance', () => {
  const J = V.generate(30, 2, 5), init = V.savings(J);
  const S = V.createSearch(J, init, { mode: 'sisr', iters: 200, seed: 3, trace: true });
  assert.strictEqual(S.lastMove, null);
  let accepted = 0;
  for (let k = 0; k < 200; k++) {
    const before = V.solCost(J, S.current); S.step(1); const m = S.lastMove;
    assert.strictEqual(m.iter, k + 1); assert.ok(m.removed.length > 0);
    const seen = new Set(); m.cand.forEach(r => r.nodes.forEach(c => seen.add(c))); assert.strictEqual(seen.size, J.n);   // recreate keeps a partition
    if (m.accepted) { accepted++; near(V.solCost(J, S.current), m.candCost, 1e-6); } else near(V.solCost(J, S.current), before, 1e-6);
  }
  assert.ok(accepted > 0 && accepted < 200);
  const plain = V.createSearch(J, init, { mode: 'sisr', iters: 200, seed: 3 }); plain.step(1e9);
  const traced = V.createSearch(J, init, { mode: 'sisr', iters: 200, seed: 3, trace: true }); traced.step(1e9);
  assert.strictEqual(plain.bestCost, traced.bestCost);                           // tracing does not change the search
});
console.log(passed + ' passed (with trace hooks)');

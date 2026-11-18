// Tests of the 20 methods of the browser Solver (docs/assets/methods.js + vrp.js) and of the primitives they share.
// Exit code 0 = all passed, 77 = skipped (benchmark data missing).
const fs = require('fs'), path = require('path'), assert = require('assert');
const root = [path.join(__dirname, '..'), path.join(__dirname, '..', '..')].find(r => fs.existsSync(path.join(r, 'docs', 'assets', 'vrp.js')));
const V = require(path.join(root, 'docs', 'assets', 'vrp.js'));
require(path.join(root, 'docs', 'assets', 'methods.js'));
const M = V.methodsInternals, { LS, rCost } = V.internals;
let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log('[ ok ] ' + name); };
const near = (a, b, e = 1e-6) => assert.ok(Math.abs(a - b) <= e, `${a} vs ${b}`);
const IDS = Object.keys(V.METHODS);

test('catalogue: 20 methods, every engine documented, every field present', () => {
  assert.strictEqual(IDS.length, 20);
  for (const id of Object.keys(V.engines)) assert.ok(V.METHODS[id], 'engine without catalogue entry: ' + id);
  for (const id of IDS) {
    const m = V.METHODS[id];
    assert.ok(id === 'sisr' || id === 'ils' || V.engines[id], 'catalogue entry without engine: ' + id);
    for (const f of ['label', 'groupName', 'unit', 'desc', 'params']) assert.ok(typeof m[f] === 'string' && m[f].length > 2, id + '.' + f);
    assert.ok(Array.isArray(m.refs) && (m.refs.length > 0 || id === 'rkrs'), id + '.refs');
    assert.ok(V.METHOD_GROUPS[m.group], id + ' group');
  }
});

const smallCvrp = V.generate(30, 1, 11, { routeSize: 6 }), smallMd = V.generate(36, 3, 12, { routeSize: 6 }), smallClu = V.generate(30, 2, 13, { routeSize: 5, clustered: true });
const ITERS = { sisr: 1500, ils: 20, sa: 6000, ta: 6000, rtr: 6000, tabu: 800, vns: 25, grasp: 6, msls: 6, alns: 150, lns: 150, ig: 200, ga: 40, aco: 25, grasppr: 8, scatter: 30, brkga: 150, pso: 150, de: 150, rkrs: 150 };
const make = (J, id, seed, extra) => V.createSearch(J, V.savings(J), Object.assign({ mode: id, iters: ITERS[id], seed, ops: V.PRESETS.full, k: 12 }, extra));
const runAll = S => { while (!S.step(7)); return S; };

for (const id of IDS) {
  test(`${id}: feasible on CVRP / MDVRP / clustered MDVRP, never worse than the start, history monotone`, () => {
    for (const J of [smallCvrp, smallMd, smallClu]) {
      const init = V.savings(J), S = runAll(make(J, id, 3)), h = S.hist;
      assert.deepStrictEqual(V.violations(J, S.best), []);
      near(S.bestCost, V.solCost(J, S.best)); assert.ok(S.bestCost <= V.solCost(J, init) + 1e-6);
      assert.strictEqual(S.iter, ITERS[id]); assert.strictEqual(h[0][0], 0); if (id === 'ils') assert.ok(h[0][1] <= V.solCost(J, init) + 1e-6); else near(h[0][1], V.solCost(J, init));      // ILS starts with a descent of the start
      for (let i = 1; i < h.length; i++) { assert.ok(h[i][0] > h[i - 1][0] && h[i][1] < h[i - 1][1] && h[i][2] >= h[i - 1][2]); }
      near(h[h.length - 1][1], S.bestCost);
    }
  });
  test(`${id}: deterministic per seed and independent of the slicing`, () => {
    const a = runAll(make(smallMd, id, 5)), b = make(smallMd, id, 5); while (!b.step(1000));
    assert.strictEqual(a.bestCost, b.bestCost); assert.deepStrictEqual(a.best, b.best);
    assert.deepStrictEqual(a.hist.map(p => p.slice(0, 2)), b.hist.map(p => p.slice(0, 2)));
    if (id !== 'rkrs') {                                         // rkrs never beats the savings start on a small instance: all seeds coincide
      // small instances are often solved to the same optimum by every seed, so compare the search trajectories (when and how it improved), not only the end cost
      const traj = [1, 2, 3, 4].map(sd => JSON.stringify(runAll(make(smallMd, id, sd)).hist.map(p => p.slice(0, 2))));
      assert.ok(new Set(traj).size > 1, 'seeds give identical trajectories');
    }
  });
}

test('createJob runs, streams its history, stops early and reports engine statistics', () => {
  for (const id of ['alns', 'ga', 'brkga']) {
    const J = V.createJob(smallMd, { construct: 'savings', mode: id, iters: ITERS[id], seed: 2 }), msgs = []; let m;
    do { m = J.poll(20); msgs.push(m); } while (!m.done);
    const r = J.result(false); assert.deepStrictEqual(r.violations, []); assert.strictEqual(r.iter, ITERS[id]);
    assert.deepStrictEqual([].concat(...msgs.map(x => x.hist)), r.hist);
    const L = V.createJob(smallMd, { construct: 'savings', mode: id, iters: 1e8, seed: 2 }); L.poll(40);
    const q = L.result(true); assert.strictEqual(q.stopped, true); assert.ok(q.iter > 0 && q.iter < 1e8); assert.deepStrictEqual(q.violations, []);
  }
  const a = V.createJob(smallMd, { construct: 'savings', mode: 'alns', iters: 300, seed: 2 }); while (!a.poll(50).done);
  const st = a.result(false).stats; assert.ok(st['d:random'] + st['d:worst'] + st['d:related'] === 300 && st['r:greedy'] + st['r:regret2'] === 300);
});
test('unknown method names are rejected with a clear message', () => {
  assert.throws(() => V.createSearch(smallCvrp, V.savings(smallCvrp), { mode: 'nope', iters: 10, seed: 1 }), /unknown method/);
});

// ---- shared primitives
test('splitTour is optimal: equals exhaustive enumeration of all cut sets (capacity and duration)', () => {
  for (const [n, seed, rs] of [[7, 1, 3], [8, 2, 4], [9, 3, 3], [10, 4, 5]]) {
    const J = V.generate(n, 1, seed, { routeSize: rs }); J.Dmax[0] = 1.6 * Math.max(...Array.from({ length: n }, (_, c) => J.D[c * J.N + n])) * 2;     // a binding duration limit
    const rand = V.mulberry32(seed), tour = M.shuffle(Array.from({ length: n }, (_, i) => i), rand), sp = M.splitTour(J, 0, tour);
    const got = sp.reduce((s, r) => s + rCost(J, 0, r.nodes), 0);
    assert.deepStrictEqual([].concat(...sp.map(r => r.nodes)), tour);                               // the order is kept
    let best = Infinity;
    for (let mask = 0; mask < 1 << (n - 1); mask++) {
      const parts = []; let cur = [tour[0]];
      for (let i = 1; i < n; i++) { if (mask >> (i - 1) & 1) { parts.push(cur); cur = []; } cur.push(tour[i]); } parts.push(cur);
      let ok = true, cost = 0;
      for (const p of parts) { let q = 0, sv = 0; p.forEach(c => { q += J.dem[c]; sv += J.srv[c]; }); const c = rCost(J, 0, p); if (q > J.Q[0] + 1e-9 || (p.length > 1 && c + sv > J.Dmax[0] + 1e-9)) ok = false; cost += c; }
      if (ok && cost < best) best = cost;
    }
    near(got, best);
  }
});
test('decodeKeys / decodeTour / giantTour produce complete feasible partitions', () => {
  for (const J of [smallCvrp, smallMd]) {
    const ctx = M.ctxOf(J, {}), rand = V.mulberry32(9);
    for (let k = 0; k < 20; k++) {
      const sols = [M.decodeKeys(J, ctx, M.randomKeys(J, rand)), M.decodeTour(J, ctx, M.shuffle(Array.from({ length: J.n }, (_, i) => i), rand)), M.graspConstruct(J, ctx, rand, 0.3)];
      for (const s of sols) assert.deepStrictEqual(V.violations(J, s), []);
    }
    const g = M.giantTour(J, V.savings(J)); assert.deepStrictEqual(g.slice().sort((a, b) => a - b), Array.from({ length: J.n }, (_, i) => i));
    assert.strictEqual(M.keyLen(J), J.t > 1 ? 2 * J.n : J.n);
  }
});
test('random moves: reported delta equals the real cost change and the solution stays feasible', () => {
  for (const J of [smallCvrp, smallMd]) {
    const ctx = M.ctxOf(J, {}), rand = V.mulberry32(21), ls = new LS(J, V.savings(J), ctx.nb); const seen = new Set(); let applied = 0;
    for (let i = 0; i < 4000; i++) {
      const m = ls.randomMove(rand, M.KINDS_NEW); if (!m) continue;
      const before = V.solCost(J, ls.solution()); ls.apply(m); applied++; seen.add(m.name);
      near(V.solCost(J, ls.solution()) - before, m.delta);
      if (i % 50 === 0) assert.deepStrictEqual(V.violations(J, ls.solution()), []);
    }
    assert.deepStrictEqual(V.violations(J, ls.solution()), []); assert.ok(applied > 300);
    for (const k of M.KINDS_NEW) assert.ok(seen.has(k) || (J.t === 1 && k === 'newroute' && false) || seen.has(k), 'operator never applied: ' + k);
  }
});
test('destroy & repair keeps a feasible partition for all 3 x 2 operator pairs', () => {
  for (const J of [smallCvrp, smallMd]) {
    const ctx = M.ctxOf(J, {}), rand = V.mulberry32(4), base = V.savings(J);
    for (const d of Object.keys(M.DESTROY)) for (const r of Object.keys(M.REPAIR)) for (let k = 0; k < 6; k++) {
      const s = M.destroyRepair(J, ctx, rand, base, d, r, 3 + k * 2); assert.deepStrictEqual(V.violations(J, s), [], d + '/' + r);
    }
  }
});
test('order crossover gives permutations; path relinking walks from one tour towards the other', () => {
  const rand = V.mulberry32(8), n = 25, id = Array.from({ length: n }, (_, i) => i), a = M.shuffle(id.slice(), rand), b = M.shuffle(id.slice(), rand);
  for (let k = 0; k < 30; k++) assert.deepStrictEqual(M.orderCrossover(a, b, rand).slice().sort((x, y) => x - y), id);
  const ham = (p, q) => p.reduce((s, c, i) => s + (c !== q[i] ? 1 : 0), 0), mids = M.relink(a, b, [0.25, 0.5, 0.75]);
  assert.strictEqual(mids.length, 3);
  mids.forEach(t => assert.deepStrictEqual(t.slice().sort((x, y) => x - y), id));
  assert.ok(ham(mids[0], b) > ham(mids[1], b) && ham(mids[1], b) > ham(mids[2], b) && ham(mids[2], b) > 0 && ham(mids[0], b) < ham(a, b));       // monotone approach to b
  assert.deepStrictEqual(M.relink(a, a, [0.5]), []);                                                // identical tours: nothing to relink
  assert.strictEqual(M.brokenPairs(a, a), 0); assert.ok(M.brokenPairs(a, b) > 0 && M.brokenPairs(a, b) <= n - 1);
  assert.strictEqual(M.brokenPairs(a, a.slice().reverse()), 0);                                    // a reversed tour has the same adjacencies
});
test('calibrate returns a positive budget that grows with the target time', () => {
  const a = V.calibrate(smallMd, 'sa', 0.2, { probeMs: 80 }), b = V.calibrate(smallMd, 'sa', 1.6, { probeMs: 80 });
  assert.ok(Number.isInteger(a) && a >= 20 && b > a, a + ' ' + b);
});

// ---- benchmark instances
const file = path.join(root, 'docs', 'data', 'cvrp', 'X-n101-k25.vrp');
if (!fs.existsSync(file)) { console.log('SKIP: docs/data/cvrp/X-n101-k25.vrp missing'); console.log(passed + ' passed, benchmark tests skipped'); process.exit(77); }
test('X-n101-k25: every method is feasible, improves on savings, and none goes below the best-known value', () => {
  const X = V.parseInstance(fs.readFileSync(file, 'utf8'), 'X-n101-k25'), init = V.savings(X), c0 = V.solCost(X, init), bks = 27591;
  const iters = { sisr: 6000, ils: 40, sa: 150000, ta: 150000, rtr: 150000, tabu: 8000, vns: 30, grasp: 25, msls: 25, alns: 600, lns: 600, ig: 1500, ga: 40, aco: 40, grasppr: 12, scatter: 30, brkga: 600, pso: 600, de: 600, rkrs: 600 };
  for (const id of IDS) {
    const S = V.createSearch(X, init, { mode: id, iters: iters[id], seed: 1, ops: V.PRESETS.full, k: 12 }); while (!S.step(50));
    assert.deepStrictEqual(V.violations(X, S.best), [], id); assert.ok(S.bestCost >= bks - 0.5, id + ' below BKS'); assert.ok(S.bestCost <= c0 + 1e-6, id);
    if (id !== 'rkrs') assert.ok(S.bestCost < c0 - 1, id + ' did not improve the savings solution');
  }
});
console.log(passed + ' passed');

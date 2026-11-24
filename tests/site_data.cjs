// Site data and the CSV table reader of the Solver (docs/assets/vrp.js):
//  - every example listed in instances.js is bundled under docs/ and parses to a sane instance (no third-party hosts);
//  - CSV tables: separators, decimal comma, depot detection, capacity rules, clear errors; a solved CSV instance is feasible.
const fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('assert');
const root = [path.join(__dirname, '..'), path.join(__dirname, '..', '..')].find(r => fs.existsSync(path.join(r, 'docs', 'assets', 'vrp.js')));
const V = require(path.join(root, 'docs', 'assets', 'vrp.js'));
require(path.join(root, 'docs', 'assets', 'methods.js'));
let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log('[ ok ] ' + name); };

test('all examples are bundled and parse', () => {
  const sb = { window: {} };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'docs', 'assets', 'instances.js'), 'utf8'), sb);
  const list = sb.window.VRP_INSTANCES;
  assert.strictEqual(list.length, 167);
  const sets = {}; list.forEach(e => { sets[e.set] = (sets[e.set] || 0) + 1; });
  assert.deepStrictEqual(sets, { x: 100, cmt: 14, golden: 20, cordeau: 33 });
  for (const e of list) {
    assert.ok(!/^https?:/.test(e.url), e.name + ' is not local: ' + e.url);
    assert.ok(/^https:\/\//.test(e.source), e.name + ' has no source URL');
    const I = V.parseInstance(fs.readFileSync(path.join(root, 'docs', e.url), 'utf8'), e.name);
    assert.ok(I.n >= 40 && I.t >= 1 && I.dem.length === I.n && I.dem.every(q => q > 0), e.name);
    assert.strictEqual(I.t > 1, e.kind === 'mdvrp', e.name + ' kind');
    assert.strictEqual(I.n, e.n, e.name + ' size in the list'); assert.strictEqual(isFinite(I.Dmax[0]), e.limit, e.name + ' limit flag');
    if (e.kind === 'cvrp') assert.ok(e.bks > 0 && e.bksStatus === 'verified', e.name + ' best-known value');
  }
});

const R = V.mulberry32(7);
const table = (sep, dec, n, depots) => {
  const f = v => String(v).replace('.', dec);
  let s = ['id', 'x', 'y', 'demand'].join(sep) + '\n';
  depots.forEach((d, i) => { s += ['D' + i, f(d[0]), f(d[1]), 0].join(sep) + '\n'; });
  for (let i = 0; i < n; i++) s += ['c' + i, f((R() * 100).toFixed(1)), f((R() * 100).toFixed(1)), 1 + Math.floor(R() * 9)].join(sep) + '\n';
  return s;
};

test('CSV: comma, semicolon with decimal comma, and tab give the same kind of instance', () => {
  for (const [sep, dec] of [[',', '.'], [';', ','], ['\t', '.']]) {
    const I = V.parseInstance(table(sep, dec, 20, [[50.5, 50]]), 'a.csv');
    assert.strictEqual(I.n, 20); assert.strictEqual(I.t, 1); assert.strictEqual(I.x[20], 50.5);
    assert.ok(I.meta.autoCapacity && I.Q[0] >= Math.max(...I.dem));
    assert.ok(I.dem.reduce((a, b) => a + b, 0) / I.Q[0] > 1, 'automatic capacity must need more than one route');
  }
});

test('CSV: depots by zero demand, by type column, or first row; capacity option', () => {
  let I = V.parseInstance(table(',', '.', 15, [[10, 10], [90, 90]]), 'b.csv', { capacity: 30 });
  assert.strictEqual(I.t, 2); assert.deepStrictEqual(Array.from(I.Q), [30, 30]); assert.ok(!I.meta.autoCapacity);
  I = V.parseInstance('X,Y,Demand,Type\n1,1,5,customer\n2,2,,DEPOT\n3,3,4,customer\n4,4,2,customer\n', 'c.csv');
  assert.strictEqual(I.t, 1); assert.strictEqual(I.n, 3); assert.strictEqual(I.x[3], 2);
  I = V.parseInstance('x,y,demand\n5,5,3\n1,1,5\n3,3,4\n4,4,2\n', 'd.csv');
  assert.strictEqual(I.n, 3); assert.strictEqual(I.x[3], 5, 'first row becomes the depot when none is marked');
  I = V.parseInstance('﻿x,y,demand\n# comment\n0,0,0\n1,1,5\n3,3,4\n', 'no-extension');
  assert.strictEqual(I.n, 2, 'a header with letters is recognised as a table without the .csv extension');
});

test('CSV: clear errors', () => {
  const bad = (text, re, o) => assert.throws(() => V.parseInstance(text, 'bad.csv', o), re);
  bad('x,y\n1,2\n3,4\n', /"demand" column/);
  bad('a,b,demand\n1,2,3\n', /columns "x" and "y"/);
  bad('x,y,demand\n0,0,0\n1,2,abc\n3,3,1\n', /line 3: demand "abc" is not a number/);
  bad('x,y,demand\n0,0,0\n1,2,-4\n3,3,1\n', /line 3: the demand cannot be negative/);
  bad('x,y,demand\n0,0,0\n1,2,4\n', /at least two customers/);
  bad('x,y,demand\n0,0,0\n1,1,5\n2,2,50\n', /more than the vehicle capacity 10/, { capacity: 10 });
  bad('x,y,demand\n', /header row and at least one data row/);
});

test('CSV instances are solved feasibly by different methods', () => {
  for (const [dep, cap] of [[[[50, 50]], 0], [[[20, 20], [80, 80], [50, 90]], 25]]) {
    const I = V.parseInstance(table(',', '.', 40, dep), 'e.csv', { capacity: cap });
    for (const mode of ['sisr', 'alns', 'ga', 'tabu']) {
      const s0 = V.savings(I), S = V.createSearch(I, s0, { mode, iters: mode === 'ga' ? 60 : 1500, seed: 1, ops: V.PRESETS.full, k: 12 });
      S.step(1e9);
      assert.deepStrictEqual(V.violations(I, S.best), [], mode);
      assert.ok(S.bestCost <= V.solCost(I, s0) + 1e-9, mode + ' must not be worse than its start');
    }
  }
});

test('Cordeau and CVRPLIB files are still recognised', () => {
  assert.strictEqual(V.parseInstance(fs.readFileSync(path.join(root, 'docs/data/mdvrp/p01'), 'utf8'), 'p01').t, 4);
  assert.strictEqual(V.parseInstance(fs.readFileSync(path.join(root, 'docs/data/cvrp/X-n101-k25.vrp'), 'utf8'), 'x').n, 100);
});

test('CVRPLIB reader: duration limit, service time and rounding rule', () => {
  const rd = f => V.parseInstance(fs.readFileSync(path.join(root, 'docs/data/cvrp', f + '.vrp'), 'utf8'), f);
  let I = rd('CMT6');
  assert.strictEqual(I.Dmax[0], 200); assert.ok(I.srv.every(s => s === 10)); assert.strictEqual(I.rounded, false);
  I = rd('CMT1'); assert.strictEqual(I.Dmax[0], Infinity); assert.ok(I.srv.every(s => s === 0)); assert.strictEqual(I.rounded, false);
  I = rd('Golden_1'); assert.strictEqual(I.Dmax[0], 650); assert.strictEqual(I.rounded, false);
  I = rd('X-n101-k25'); assert.strictEqual(I.rounded, true); assert.strictEqual(I.Dmax[0], Infinity);
  assert.throws(() => V.parseInstance('NAME : a\nNODE_COORD_SECTION\n1 0 0\n2 1 1\n3 2 1\nDEMAND_SECTION\n1 0\n2 1\n3 1\nEOF\n', 'a.vrp'), /no CAPACITY/);
});

test('CVRPLIB reader agrees with the reference C++ implementation (cost and feasibility of fixed solutions)', () => {
  const fx = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'reader_parity.json'), 'utf8')).solutions;
  assert.strictEqual(Object.keys(fx).length, 6);
  for (const [name, f] of Object.entries(fx)) {
    const I = V.parseInstance(fs.readFileSync(path.join(root, 'docs/data/cvrp', name + '.vrp'), 'utf8'), name);
    const s = { routes: f.routes.map(r => ({ d: 0, nodes: r.map(c => c - 1) })) };
    assert.deepStrictEqual(V.violations(I, s), [], name);
    assert.ok(Math.abs(V.solCost(I, s) - f.cost) < 1e-5, name + ': ' + V.solCost(I, s) + ' vs ' + f.cost);
  }
});

test('an instance with a duration limit is solved within the limit', () => {
  const I = V.parseInstance(fs.readFileSync(path.join(root, 'docs/data/cvrp/CMT6.vrp'), 'utf8'), 'CMT6');
  for (const mode of ['sisr', 'alns', 'tabu', 'ga']) {
    const S = V.createSearch(I, V.savings(I), { mode, iters: mode === 'ga' ? 60 : 3000, seed: 1, ops: V.PRESETS.full, k: 12 });
    S.step(1e9);
    assert.deepStrictEqual(V.violations(I, S.best), [], mode);
    assert.ok(S.bestCost >= 555.43 - 1e-6 && S.bestCost < 1.1 * 555.43, mode + ' cost ' + S.bestCost);
  }
});

/* ---- distance matrices and latitude / longitude ---- */
const pts = (n, seed) => { const r = V.mulberry32(seed), p = []; for (let i = 0; i < n; i++) p.push([Math.round(r() * 1000) / 10, Math.round(r() * 1000) / 10]); return p; };
const dist = p => p.map(a => p.map(b => Math.hypot(a[0] - b[0], a[1] - b[1])));
const tableOf = (p, withXY) => (withXY ? 'name,x,y,demand\n' : 'name,demand\n') + p.map((q, i) => ['L' + i].concat(withXY ? q : [], [i === 0 ? 0 : 1 + i % 7]).join(',')).join('\n') + '\n';
const sameD = (A, B, tol) => { assert.strictEqual(A.D.length, B.D.length); for (let i = 0; i < A.D.length; i++) assert.ok(Math.abs(A.D[i] - B.D[i]) <= (tol || 1e-9), 'distance ' + i + ': ' + A.D[i] + ' vs ' + B.D[i]); };

test('matrix upload: a table with its distance matrix gives the same instance as the coordinates', () => {
  const p = pts(25, 3), M = dist(p), ref = V.parseInstance(tableOf(p, true), 'a.csv', { capacity: 20 });
  const forms = {
    comma: M.map(r => r.join(',')).join('\n'),
    semicolonDecimalComma: M.map(r => r.map(v => String(v).replace('.', ',')).join(';')).join('\n'),
    blanks: M.map(r => r.join('  ')).join('\n'),
    labelled: ',' + p.map((_, i) => 'L' + i).join(',') + '\n' + M.map((r, i) => 'L' + i + ',' + r.join(',')).join('\n')
  };
  for (const [k, text] of Object.entries(forms)) {
    const I = V.parseInstance(tableOf(p, true), 'a.csv', { capacity: 20, matrix: text });
    sameD(I, ref, 1e-9); assert.ok(I.meta.matrix && !I.meta.layout, k);
  }
  const J = V.parseInstance(tableOf(p, false), 'b.csv', { capacity: 20, matrix: forms.comma });      // no coordinates at all
  sameD(J, ref, 1e-9); assert.strictEqual(J.meta.layout, 'computed');
  // the computed map reproduces a planar configuration: all pairwise distances of the layout match the matrix
  for (let i = 0; i < J.N; i++) for (let j = 0; j < J.N; j++) assert.ok(Math.abs(Math.hypot(J.x[i] - J.x[j], J.y[i] - J.y[j]) - J.D[i * J.N + j]) < 1e-6, 'layout');
  for (const mode of ['sisr', 'tabu', 'ga']) {                                                             // same search, same result
    const run = I => { const S = V.createSearch(I, V.savings(I), { mode, iters: mode === 'ga' ? 40 : 1500, seed: 5, ops: V.PRESETS.full, k: 10 }); S.step(1e9); assert.deepStrictEqual(V.violations(I, S.best), []); return S.bestCost; };
    assert.ok(Math.abs(run(V.parseInstance(tableOf(p, true), 'a.csv', { capacity: 20, matrix: forms.comma })) - run(ref)) < 1e-6, mode);
  }
});

test('matrix upload: clear errors (size, text, negative, diagonal, asymmetric)', () => {
  const p = pts(6, 4), M = dist(p), bad = (edit, re) => { const m = M.map(r => r.slice()); const rows = edit(m) || m; assert.throws(() => V.parseInstance(tableOf(p, true), 'a.csv', { matrix: rows.map(r => r.join(',')).join('\n') }), re); };
  bad(m => m.slice(1), /has 5 rows, but there are 6 locations/);
  bad(m => { m[2].pop(); }, /line 3: 5 values instead of 6/);
  bad(m => { m[1][3] = 'far'; }, /line 2, column 4: "far" is not a number/);
  bad(m => { m[1][3] = m[3][1] = -2; }, /line 2, column 4: the distance -2 is negative/);
  bad(m => { m[4][4] = 3; }, /line 5, column 5: the distance from a location to itself must be 0/);
  bad(m => { m[1][3] = 10; m[3][1] = 14; }, /not symmetric: line 2, column 4 is 10 but line 4, column 2 is 14.*not supported/);
  const m = M.map(r => r.slice()); m[1][3] *= 1 + 1e-9;                                              // rounding noise is accepted
  assert.ok(V.parseInstance(tableOf(p, true), 'a.csv', { matrix: m.map(r => r.join(',')).join('\n') }).meta.matrix);
  assert.throws(() => V.parseInstance(tableOf(p, false), 'a.csv'), /columns "x" and "y"/);
});

test('CVRPLIB EXPLICIT: all matrix formats give the same instance; display coordinates are optional', () => {
  const p = pts(12, 9), M = dist(p).map(r => r.map(v => Math.round(v))), N = p.length;
  const body = { FULL_MATRIX: [], LOWER_ROW: [], LOWER_DIAG_ROW: [], UPPER_ROW: [], UPPER_DIAG_ROW: [], LOWER_COL: [], UPPER_COL: [], LOWER_DIAG_COL: [], UPPER_DIAG_COL: [] };
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
    body.FULL_MATRIX.push(M[i][j]);
    if (j < i) { body.LOWER_ROW.push(M[i][j]); body.UPPER_COL.push(M[j][i]); } if (j <= i) { body.LOWER_DIAG_ROW.push(M[i][j]); body.UPPER_DIAG_COL.push(M[j][i]); }
    if (j > i) { body.UPPER_ROW.push(M[i][j]); body.LOWER_COL.push(M[j][i]); } if (j >= i) { body.UPPER_DIAG_ROW.push(M[i][j]); body.LOWER_DIAG_COL.push(M[j][i]); }
  }
  const file = (fmt, disp, depot) => 'NAME : ex\nTYPE : CVRP\nDIMENSION : ' + N + '\nEDGE_WEIGHT_TYPE : EXPLICIT\nEDGE_WEIGHT_FORMAT : ' + fmt + '\nCAPACITY : 15\nEDGE_WEIGHT_SECTION\n' +
    body[fmt].join(' ').replace(/((?:\S+ ){7}\S+) /g, '$1\n') + '\n' + (disp ? 'DISPLAY_DATA_SECTION\n' + p.map((q, i) => (i + 1) + ' ' + q[0] + ' ' + q[1]).join('\n') + '\n' : '') +
    'DEMAND_SECTION\n' + p.map((_, i) => (i + 1) + ' ' + (i + 1 === depot ? 0 : 3)).join('\n') + '\nDEPOT_SECTION\n' + depot + '\n-1\nEOF\n';
  const ref = V.parseInstance(file('FULL_MATRIX', true, 1), 'ex.vrp');
  assert.strictEqual(ref.n, N - 1); assert.strictEqual(ref.rounded, false); assert.ok(ref.meta.matrix && !ref.meta.layout);
  for (let i = 0; i < N - 1; i++) assert.strictEqual(ref.D[i * N + N - 1], M[i + 1][0], 'customer ' + i + ' to depot');
  for (const fmt of Object.keys(body)) sameD(V.parseInstance(file(fmt, true, 1), 'ex.vrp'), ref);
  const noDisp = V.parseInstance(file('LOWER_ROW', false, 1), 'ex.vrp'); sameD(noDisp, ref); assert.strictEqual(noDisp.meta.layout, 'computed'); assert.ok(noDisp.x.every(isFinite));
  const d5 = V.parseInstance(file('FULL_MATRIX', true, 5), 'ex.vrp');                                 // depot in the middle of the list
  assert.strictEqual(d5.D[0 * N + N - 1], M[0][4]); assert.strictEqual(d5.D[4 * N + N - 1], M[5][4]);
  assert.throws(() => V.parseInstance(file('FULL_MATRIX', true, 1).replace('FULL_MATRIX', 'FUNCTION'), 'ex.vrp'), /EDGE_WEIGHT_FORMAT FUNCTION is not supported/);
  assert.throws(() => V.parseInstance(file('LOWER_ROW', true, 1).replace('EDGE_WEIGHT_SECTION\n', 'EDGE_WEIGHT_SECTION\n7 '), 'ex.vrp'), /has 67 numbers; LOWER_ROW with 12 nodes needs 66/);
  assert.throws(() => V.parseInstance('NAME : g\nEDGE_WEIGHT_TYPE : GEO\nCAPACITY : 5\nNODE_COORD_SECTION\n1 0 0\n2 1 1\n3 2 2\nDEMAND_SECTION\n1 0\n2 1\n3 1\nEOF\n', 'g.vrp'), /GEO is not supported/);
  const S = V.createSearch(noDisp, V.savings(noDisp), { mode: 'alns', iters: 800, seed: 2, ops: V.PRESETS.full, k: 8 }); S.step(1e9);
  assert.deepStrictEqual(V.violations(noDisp, S.best), []);
});

test('latitude / longitude tables use great-circle distances in kilometres', () => {
  assert.ok(Math.abs(V.haversineKm(48.8566, 2.3522, 51.5074, -0.1278) - 343.56) < 0.5, 'Paris to London');
  assert.ok(Math.abs(V.haversineKm(0, 0, 0, 180) - Math.PI * 6371.0088) < 1e-6, 'half the equator');
  const I = V.parseInstance('name,lat,lon,demand\nDepot,45.4642,9.19,0\nA,45.0703,7.6869,4\nB,44.4949,11.3426,3\nC,43.7696,11.2558,5\n', 'it.csv');
  assert.ok(I.meta.geo && I.n === 3 && I.t === 1);
  assert.ok(Math.abs(I.D[0 * 4 + 3] - 125.9) < 1.5, 'Turin to Milan is about 126 km, got ' + I.D[3]);
  assert.strictEqual(I.D[1 * 4 + 2], I.D[2 * 4 + 1]);
  assert.throws(() => V.parseInstance('lat,lon,demand\n95,9,0\n45,7,4\n44,11,3\n', 'bad.csv'), /line 2: latitude must be between -90 and 90/);
  const J = V.parseInstance('Latitude;Longitude;Demand\n45,4642;9,19;0\n45,0703;7,6869;4\n44,4949;11,3426;3\n', 'it2.csv');
  assert.ok(Math.abs(J.D[0 * 3 + 2] - I.D[0 * 4 + 3]) < 1e-9, 'decimal comma');
});

test('tight fleets: the start is repaired, and every method ends feasible on all pr instances', () => {
  const need = [];
  for (let k = 1; k <= 10; k++) {
    const f = 'pr' + String(k).padStart(2, '0'), I = V.parseInstance(fs.readFileSync(path.join(root, 'docs/data/mdvrp', f), 'utf8'), f);
    const raw = V.violations(I, V.savings(I)).length, a = V.commonStart(I, 'savings'), b = V.commonStart(I, 'savings');
    assert.deepStrictEqual(V.violations(I, a.sol), [], f + ' start'); assert.strictEqual(a.repaired, raw > 0, f);
    assert.strictEqual(V.solCost(I, a.sol), V.solCost(I, b.sol), f + ' same start for every run');
    if (!raw) assert.ok(Math.abs(V.solCost(I, a.sol) - V.solCost(I, V.savings(I))) < 1e-9, f + ' feasible start unchanged');
    else need.push(f);
    for (const m of Object.keys(V.METHODS)) {
      const pop = ['ga', 'aco', 'grasppr', 'scatter', 'brkga', 'pso', 'de', 'grasp', 'msls'].includes(m);
      const job = V.createJob(I, { mode: m, iters: pop ? 6 : 150, seed: 1, construct: 'savings', ops: V.PRESETS.full, k: 12 });
      let p; do { p = job.poll(1000); } while (!p.done);
      const r = job.result(false);
      assert.deepStrictEqual(r.violations, [], f + ' ' + m); assert.strictEqual(r.startRepaired, raw > 0);
    }
  }
  assert.deepStrictEqual(need, ['pr05', 'pr10']);
});
console.log(passed + ' passed');

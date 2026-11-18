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
  assert.ok(list.length >= 36);
  for (const e of list) {
    assert.ok(!/^https?:/.test(e.url), e.name + ' is not local: ' + e.url);
    assert.ok(/^https:\/\//.test(e.source), e.name + ' has no source URL');
    const I = V.parseInstance(fs.readFileSync(path.join(root, 'docs', e.url), 'utf8'), e.name);
    assert.ok(I.n >= 40 && I.t >= 1 && I.dem.length === I.n && I.dem.every(q => q > 0), e.name);
    assert.strictEqual(I.t > 1, e.kind === 'mdvrp', e.name + ' kind');
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
console.log(passed + ' passed');

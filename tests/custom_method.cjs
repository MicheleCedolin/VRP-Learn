// Custom methods of the Solver ("Your own method"): contract, checks by the engine, and the worker that runs the code.
const fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('assert');
const root = path.join(__dirname, '..');
const V = require(path.join(root, 'docs', 'assets', 'vrp.js'));
require(path.join(root, 'docs', 'assets', 'methods.js'));
let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log('[ ok ] ' + name); };
const inst = (dir, f) => V.parseInstance(fs.readFileSync(path.join(root, 'docs', 'data', dir, f), 'utf8'), f);
const template = fs.readFileSync(path.join(root, 'docs', 'data', 'custom-method-template.js'), 'utf8');
const run = (I, code, iters, seed) => { V.setCustom(code); const S = V.createSearch(I, V.savings(I), { mode: 'custom', iters, seed: seed || 1 }); S.step(1e9); return S; };

test('template: feasible, better than the start, repeatable by seed (duration limit, rounded distances, several depots)', () => {
  for (const [dir, f] of [['cvrp', 'CMT6.vrp'], ['cvrp', 'X-n101-k25.vrp'], ['mdvrp', 'p08'], ['mdvrp', 'pr01']]) {
    const I = inst(dir, f), start = V.solCost(I, V.savings(I)), a = run(I, template, 1500, 3), b = run(I, template, 1500, 3), c = run(I, template, 1500, 4);
    assert.deepStrictEqual(V.violations(I, a.best), [], f);
    assert.ok(a.bestCost < start - 1e-9, f + ' did not improve');
    assert.strictEqual(a.bestCost, b.bestCost, f + ' same seed');
    assert.ok(a.hist.length > 1 && a.hist.every((h, i) => i === 0 || h[1] < a.hist[i - 1][1]), f + ' trace decreases');
    assert.ok(isFinite(c.bestCost));
  }
});

test('the job interface used by the page reports cost and violations computed by the engine', () => {
  const I = inst('cvrp', 'CMT1.vrp'); V.setCustom(template);
  const job = V.createJob(I, { mode: 'custom', iters: 400, seed: 2, construct: 'savings' });
  let m; do { m = job.poll(50); } while (!m.done);
  const r = job.result(false);
  assert.deepStrictEqual(r.violations, []); assert.ok(Math.abs(r.cost - V.solCost(I, r.sol)) < 1e-9); assert.strictEqual(r.iter, 400);
  assert.ok(V.calibrate(I, 'custom', 1) >= 20);
});

test('code that does not follow the contract is refused with a clear message', () => {
  const I = inst('cvrp', 'CMT1.vrp'), bad = (code, re) => assert.throws(() => run(I, code, 5), re);
  bad('', /custom method is empty/);
  bad('function customMethod(api, start) {', /does not compile/);
  bad('const x = 1;', /must define\s+function customMethod/);
  bad('function customMethod(api, start) { return 5; }', /must return a function/);
  bad('function customMethod(api, start) { return () => api.report({ routes: [{ d: 0, nodes: [999] }] }); }', /customer index 999 is not in 0\.\.49/);
  bad('function customMethod(api, start) { return () => api.report({ routes: [{ d: 3, nodes: [1] }] }); }', /depot index 3 is not in 0\.\.0/);
  bad('function customMethod(api, start) { return () => api.report(42); }', /needs a solution/);
  bad('function customMethod(api, start) { return () => { throw new Error("my bug"); }; }', /my bug/);
  bad('function customMethod(api, start) { api.instance.demand[0] = 0; return () => {}; }', /read only|Cannot assign|object is not extensible/i);
  bad('function customMethod(api, start) { return () => api.localSearch({ routes: [] }); }', /needs a feasible solution/);
});

test('a method cannot claim a better result than it has: infeasible reports are refused, the best stays feasible', () => {
  const I = inst('cvrp', 'CMT6.vrp'), start = V.savings(I), c0 = V.solCost(I, start);
  const cheats = {
    dropCustomers: 'function customMethod(api, start) { return () => { const s = api.copy(start); s.routes = s.routes.slice(1); if (api.report(s)) throw new Error("accepted"); }; }',
    oneBigRoute: 'function customMethod(api, start) { const all = []; for (let c = 0; c < api.instance.customers; c++) all.push(c); return () => { if (api.report({ routes: [{ d: 0, nodes: all }] })) throw new Error("accepted"); }; }',
    duplicate: 'function customMethod(api, start) { return () => { const s = api.copy(start); s.routes.push({ d: 0, nodes: [0] }); if (api.report(s)) throw new Error("accepted"); }; }',
    doNothing: 'function customMethod(api, start) { return function () {}; }'
  };
  for (const [k, code] of Object.entries(cheats)) {
    const S = run(I, code, 20);
    assert.deepStrictEqual(V.violations(I, S.best), [], k); assert.ok(Math.abs(S.bestCost - c0) < 1e-9, k);
    if (k !== 'doNothing') assert.strictEqual(S.stats.rejectedReports, 20, k);
  }
  const S = run(I, 'function customMethod(api, start) { let s = api.localSearch(start); api.report(s); return { step() { api.report(s); } }; }', 5);     // object form, helper
  assert.ok(S.bestCost <= c0 + 1e-9); assert.deepStrictEqual(V.violations(I, S.best), []);
  // the instance of the engine is not reachable through the api
  run(I, 'function customMethod(api, start) { try { api.instance.dist = () => 0; } catch (e) {} return () => {}; }', 2);
  assert.ok(Math.abs(V.solCost(I, start) - c0) < 1e-12);
});

test('worker: custom code is compiled in the worker, without network interfaces and without access to its internals', () => {
  const sent = [], timers = [];
  const sb = { performance, setTimeout: f => timers.push(f), console,                 // a worker-like global of its own: the engine is loaded inside it, as importScripts does
    fetch: () => { throw new Error('network used'); }, XMLHttpRequest: function () {}, WebSocket: function () {}, importScripts: () => { throw new Error('importScripts used'); } };
  sb.self = sb; sb.postMessage = m => sent.push(m);
  vm.createContext(sb);
  for (const f of ['vrp.js', 'methods.js']) vm.runInContext(fs.readFileSync(path.join(root, 'docs', 'assets', f), 'utf8'), sb);
  vm.runInContext(fs.readFileSync(path.join(root, 'docs', 'assets', 'worker.js'), 'utf8'), sb);
  const I = inst('cvrp', 'CMT1.vrp');
  const probe = 'function customMethod(api, start) { throw new Error([typeof fetch, typeof XMLHttpRequest, typeof WebSocket, typeof importScripts, typeof postMessage, typeof calI, typeof customCode].join(",")); }';
  sb.onmessage({ data: { type: 'job', jobId: 7, I, cfg: { mode: 'custom', code: probe, iters: 10, seed: 1 } } });
  assert.strictEqual(sent.length, 1); assert.strictEqual(sent[0].type, 'error'); assert.strictEqual(sent[0].jobId, 7);
  assert.strictEqual(sent[0].message, 'undefined,undefined,undefined,undefined,undefined,undefined,undefined');
  sb.onmessage({ data: { type: 'job', jobId: 8, I, cfg: { mode: 'custom', code: template, iters: 300, seed: 1 } } });
  for (let k = 0; k < 10000 && timers.length; k++) timers.shift()();
  const done = sent.find(m => m.type === 'done' && m.jobId === 8);
  assert.ok(done && done.violations.length === 0 && done.cost < V.solCost(I, V.savings(I)));
  sb.onmessage({ data: { type: 'calibrate', reqId: 3, I, mode: 'custom', code: template, seconds: 1 } });
  assert.ok(sent.some(m => m.type === 'calibrated' && m.reqId === 3 && m.iters >= 20));
  sb.onmessage({ data: { type: 'job', jobId: 9, I, cfg: { mode: 'sisr', iters: 200, seed: 1 } } });                 // built-in methods still run in the same worker
  for (let k = 0; k < 10000 && timers.length; k++) timers.shift()();
  assert.ok(sent.some(m => m.type === 'done' && m.jobId === 9));
});

test('page: policy and wiring', () => {
  const html = fs.readFileSync(path.join(root, 'docs', 'index.html'), 'utf8'), js = fs.readFileSync(path.join(root, 'docs', 'assets', 'solver.js'), 'utf8');
  const csp = /http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html)[1];
  assert.ok(/connect-src 'self'(;|$)/.test(csp) && /default-src 'self'/.test(csp) && /worker-src 'self' blob:/.test(csp));
  assert.ok(!/https?:/.test(csp), 'no third-party host in the policy');
  assert.ok(!/<script(?![^>]*\ssrc=)[^>]*>/.test(html), 'no inline script');
  assert.ok(!/\beval\(|new Function/.test(js), 'the page itself never compiles code');
  const writes = js.split('\n').filter(l => /customCode'\)\.value\s*=[^=]/.test(l));                     // code enters only from the example or a chosen file
  assert.strictEqual(writes.length, 2); assert.ok(writes.every(l => !/q\.get|location|URLSearchParams/.test(l)), 'code is never taken from the address of the page');
  for (const id of ['customBox', 'customCode', 'customFile', 'customExample']) assert.ok(html.includes('id="' + id + '"'), id);
});
console.log(passed + ' passed');

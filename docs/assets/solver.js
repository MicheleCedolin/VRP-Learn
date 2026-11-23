/* Solver page: instance selection, several independent runs (Web Workers, with an in-page fallback), live and final
 * charts (routes of the best / selected run, convergence of every run with mean ± sd, final-cost dispersion). */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  const fmt = (x, d = 1) => (isFinite(x) ? x.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }) : '–');
  const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
  const OPNAMES = {
    relocate: 'Relocate (1 node, also opens new routes)', oropt: 'Or-opt (segments of 2–3)', swap: 'Swap (1–1)',
    twoopt: '2-opt (intra-route)', twooptstar: '2-opt* (route tails)', routedepot: 'Route → other depot', depotswap: 'Depot swap (2 routes)',
  };
  const EFFORT_S = { quick: 2, standard: 6, long: 25 };             // compute seconds per run; the iteration budget is calibrated to it (VRP.calibrate)
  const GROUPS = ['A', 'B', 'C', 'D', 'E'], CORE = ['sisr', 'sa', 'tabu', 'vns', 'alns', 'ga'], MIDS = Object.keys(VRP.METHODS), REF = VRP.REF_SHORT || {};
  const MCOL = i => css('--c' + (i % 6 + 1)), MDASH = [[], [7, 3], [2, 3]];          // colour and dash style of the i-th compared method (6 colours x 3 dashes)
  const catalogue = window.VRP_INSTANCES || [];

  let I = null, entry = null;                       // loaded instance and its catalogue entry (for the reference value)
  let runs = [], viewIdx = -1, runner = null, solving = false, tStart = 0, axis = 'iter', src = 'bench', raf = 0;
  let cmpMode = false, cmpIds = [], hiMethod = null, session = 0, calW = null, calReq = 0, calSent = null;     // compare mode: methods of the current session, highlighted method, calibration worker

  /* ------------------------------------------------------------------ controls */
  const opsBox = $('ops');
  Object.keys(OPNAMES).forEach(k => {
    const l = document.createElement('label');
    l.innerHTML = '<input type="checkbox" data-op="' + k + '"> ' + OPNAMES[k];
    opsBox.appendChild(l);
  });
  const opChecks = () => [...opsBox.querySelectorAll('input')];
  function applyPreset() {
    const p = $('preset').value; if (p === 'custom') return;
    const set = new Set(VRP.PRESETS[p]); opChecks().forEach(c => { c.checked = set.has(c.dataset.op); });
  }
  const selectedOps = () => { const o = opChecks().filter(c => c.checked).map(c => c.dataset.op); return o.length ? o : VRP.PRESETS.standard; };
  $('preset').addEventListener('change', applyPreset);
  opsBox.addEventListener('change', () => { $('preset').value = 'custom'; });
  applyPreset();

  /* ---- methods: grouped list, description, compare mode */
  GROUPS.forEach(g => {
    const og = document.createElement('optgroup'); og.label = VRP.METHOD_GROUPS[g];
    MIDS.filter(id => VRP.METHODS[id].group === g).forEach(id => { const o = document.createElement('option'); o.value = id; o.textContent = VRP.METHODS[id].label; og.appendChild(o); });
    $('method').appendChild(og);
  });
  $('method').value = 'sisr';
  GROUPS.forEach(g => {
    const box = document.createElement('div'); box.className = 'cmpgrp'; box.innerHTML = '<b>' + VRP.METHOD_GROUPS[g] + '</b>';
    MIDS.filter(id => VRP.METHODS[id].group === g).forEach(id => {
      const l = document.createElement('label'); l.className = 'chk'; l.innerHTML = '<input type="checkbox" data-m="' + id + '"> ' + VRP.METHODS[id].label; box.appendChild(l);
    });
    $('cmpList').appendChild(box);
  });
  const cmpChecks = () => [...$('cmpList').querySelectorAll('input')];
  const cmpSelected = () => MIDS.filter(id => cmpChecks().some(c => c.dataset.m === id && c.checked));
  const setCmp = ids => { const set = new Set(ids); cmpChecks().forEach(c => { c.checked = set.has(c.dataset.m); }); updateEst(); };
  function describeMethod() {
    const m = VRP.METHODS[$('method').value];
    const refs = m.refs.map(k => '<a href="learn.html#ref-' + k + '">' + (REF[k] || k) + '</a>').join('; ');
    $('methodDesc').innerHTML = m.desc + ' <i>One iteration = ' + m.unit + '.</i> Defaults: ' + m.params + '. ' + (refs ? '<span class="refs">' + refs + '</span>' : '<span class="refs">Control baseline, not a published method.</span>');
  }
  function updateEst() {
    const cmp = $('compare').checked, ms = cmp ? cmpSelected().length : 1, R = clamp(Math.round(+$('runs').value) || 1, 1, 50), W = clamp(Math.round(+$('workers').value) || 1, 1, 16), secs = EFFORT_S[$('effort').value];
    const jobs = ms * R, conc = Math.min(W, Math.max(1, jobs));
    if (!secs || !ms) { $('est').textContent = ''; return; }
    const total = jobs * secs / conc + ms * 0.6;
    $('est').textContent = 'Expected: ' + jobs + (jobs === 1 ? ' run' : ' runs') + ' of about ' + secs + ' s on ' + conc + (conc === 1 ? ' worker' : ' workers') + ', roughly ' + (total < 90 ? Math.round(total) + ' s' : fmt(total / 60, 1) + ' min') + ' in total' + (conc > 1 ? ' (parallel runs share the CPU, so real times can be longer)' : '') + '.';
  }
  function setMode() {
    const cmp = $('compare').checked;
    $('cmpBox').hidden = !cmp; $('method').disabled = cmp;
    $('effort').querySelector('option[value=custom]').disabled = cmp;
    if (cmp && $('effort').value === 'custom') $('effort').value = 'standard';
    $('iters').disabled = cmp; $('itersNote').textContent = cmp ? '(set per method)' : '';
    if (cmp && !cmpSelected().length) setCmp(CORE);
    updateEst();
  }
  $('method').addEventListener('change', describeMethod);
  $('compare').addEventListener('change', setMode);
  $('cmpAll').addEventListener('click', () => setCmp(MIDS));
  $('cmpCore').addEventListener('click', () => setCmp(CORE));
  $('cmpNone').addEventListener('click', () => setCmp([]));
  $('cmpList').addEventListener('change', updateEst);
  $('effort').addEventListener('change', updateEst);
  $('runs').addEventListener('input', updateEst);
  $('workers').addEventListener('input', updateEst);
  $('iters').addEventListener('input', () => { $('effort').value = 'custom'; updateEst(); });
  describeMethod();
  $('workers').value = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1));

  /* benchmark list: grouped by set and size; the files are fetched only when an instance is loaded */
  const groups = [
    ['X set (Uchoa et al. 2017), 100 to 199 customers', e => e.set === 'x' && e.n < 200],
    ['X set, 200 to 299 customers', e => e.set === 'x' && e.n >= 200 && e.n < 300],
    ['X set, 300 to 499 customers', e => e.set === 'x' && e.n >= 300 && e.n < 500],
    ['X set, 500 to 1000 customers (slow in the browser)', e => e.set === 'x' && e.n >= 500],
    ['CMT (Christofides, Mingozzi and Toth 1979), 50 to 199 customers', e => e.set === 'cmt'],
    ['Golden et al. (1998), 200 to 483 customers', e => e.set === 'golden'],
    ['Cordeau et al. (1997), multi-depot, 48 to 360 customers', e => e.kind === 'mdvrp'],
    ['Other', e => e.kind !== 'mdvrp' && !['x', 'cmt', 'golden'].includes(e.set)]
  ];
  groups.forEach(([label, pick]) => {
    const list = catalogue.filter(pick); if (!list.length) return;
    const og = document.createElement('optgroup'); og.label = label;
    list.forEach(e => {
      const o = document.createElement('option'); o.value = e.name;
      o.textContent = e.name + (e.set === 'x' ? '' : '  ·  n = ' + e.n) + (e.limit ? '  ·  duration limit' : '') +
        (e.bksStatus === 'verified' ? '  ·  BKS ' + fmt(e.bks, Number.isInteger(e.bks) ? 0 : 2) : '');
      og.appendChild(o);
    });
    $('bench').appendChild(og);
  });

  document.querySelectorAll('.seg [data-src]').forEach(b => b.addEventListener('click', () => {
    src = b.dataset.src;
    document.querySelectorAll('.seg [data-src]').forEach(x => x.classList.toggle('on', x === b));
    $('boxBench').hidden = src !== 'bench'; $('boxRandom').hidden = src !== 'random'; $('boxFile').hidden = src !== 'file';
  }));
  document.querySelectorAll('#axisSeg [data-axis]').forEach(b => b.addEventListener('click', () => {
    axis = b.dataset.axis;
    document.querySelectorAll('#axisSeg [data-axis]').forEach(x => x.classList.toggle('on', x === b)); drawConv();
  }));
  $('zoom').addEventListener('change', drawConv);

  const status = msg => { $('status').textContent = msg; };

  /* ------------------------------------------------------------------ instance */
  async function loadInstance() {
    stopSolve(true);
    try {
      status('Loading…');
      if (src === 'bench') {
        const e = catalogue.find(x => x.name === $('bench').value);
        const r = await fetch(e.url); if (!r.ok) throw new Error('HTTP ' + r.status + ' from ' + new URL(e.url).host);
        I = VRP.parseInstance(await r.text(), e.name); entry = e;
      } else if (src === 'file') {
        const f = $('file').files[0]; if (!f) { status('Choose a file first.'); return; }
        I = VRP.parseInstance(await f.text(), f.name, { capacity: +$('csvQ').value }); entry = null;
      } else {
        const t = Math.max(1, +$('t').value);
        I = VRP.generate(clamp(+$('n').value, 10, 400), t, +$('gseed').value, { routeSize: +$('rs').value, clustered: $('clustered').checked }); entry = null;
      }
      runs = []; viewIdx = -1; cmpMode = false; hiMethod = null; setTableMode(); showInfo(); drawAll(); $('solve').disabled = false;
      status('Loaded ' + I.name + ' (' + I.n + ' customers, ' + I.t + (I.t === 1 ? ' depot' : ' depots') + (I.meta && I.meta.autoCapacity ? ', vehicle capacity set automatically to ' + I.Q[0] : '') + '). Press Solve.' +
        (I.n > 500 ? ' Large instance: the browser engine is slow beyond about 500 customers, so start with the quick effort.' : ''));
    } catch (e) { status('Could not load the instance: ' + e.message + (src === 'bench' ? ' (examples need the page to be opened from the website, not from a saved file)' : src === 'file' ? '. Check the file against the template.' : '')); }
  }
  $('load').addEventListener('click', loadInstance);

  function showInfo() {
    const n = I.n; let dem = 0; for (let c = 0; c < n; c++) dem += I.dem[c];
    const same = a => Array.from(a).every(v => v === a[0]);
    const Q = same(I.Q) ? fmt(I.Q[0], 0) : 'varies by depot';
    const fleet = same(I.fleet) ? (I.fleet[0] >= 1e5 ? 'unlimited' : I.fleet[0]) : 'varies by depot';
    const dm = same(I.Dmax) ? (isFinite(I.Dmax[0]) ? fmt(I.Dmax[0], 0) : 'none') : 'varies by depot';
    const lb = Math.ceil(dem / Math.max(...I.Q) - 1e-9);
    let ref = '–';
    if (entry && entry.bks != null) {
      ref = fmt(entry.bks, Number.isInteger(entry.bks) ? 0 : 2) + ' <span class="badge ' + entry.bksStatus + '" title="' + entry.bksNote.replace(/"/g, '&quot;') + '">' +
        (entry.bksStatus === 'verified' ? 'verified' : 'secondary, sanity reference only') + '</span>';
    } else if (entry) ref = 'not verified here <span class="small">(see CVRPLib / NEO)</span>';
    const rows = [['Customers', n], ['Depots', I.t], ['Capacity Q', Q], ['Vehicles / depot', fleet], ['Max. route duration', dm], ['LB #routes ⌈Σq/Q⌉', lb], ['Best known value', ref]];
    $('info').innerHTML = rows.map(r => '<dt>' + r[0] + '</dt><dd>' + r[1] + '</dd>').join('');
  }

  /* ------------------------------------------------------------------ runs */
  const fmtGap = g => fmt(Math.abs(g) < 0.005 ? 0 : g, 2);          // no "-0.00"
  const refGap = cost => (entry && entry.bks != null && entry.bksStatus !== 'unverified' ? RunStats.gapPct(cost, entry.bks) : NaN);
  const finalStatus = r => r.status === 'done' || r.status === 'stopped' || r.status === 'skipped' || r.status === 'error';
  const nRoutes = r => (r.sol ? r.sol.routes.filter(q => q.nodes.length).length : 0);
  const isFeasible = r => !!r.violations && r.violations.length === 0;
  const finished = () => runs.filter(r => (r.status === 'done' || r.status === 'stopped') && r.sol);
  const statRuns = () => { const f = finished(), full = f.filter(r => r.status === 'done'); return full.length ? full : f; };
  function bestRun(list) {
    let b = null;
    for (const r of list) {
      if (!r.sol || !isFinite(r.cost)) continue;
      if (!b || (isFeasible(r) && !isFeasible(b)) || (isFeasible(r) === isFeasible(b) && r.cost < b.cost - 1e-9)) b = r;
    }
    return b;
  }
  const shownRun = () => (viewIdx >= 0 && runs[viewIdx] && runs[viewIdx].sol ? runs[viewIdx] : bestRun(solving ? runs : statRuns()));

  /* iterations whose run takes about `secs` of compute: a short timing run of the method itself, in a worker (inline when workers are unavailable) */
  function calibrate(id, secs, base) {
    return new Promise((resolve, reject) => {
      const inline = () => { try { resolve(VRP.calibrate(I, id, secs, { ops: base.ops, k: base.k })); } catch (e) { reject(e); } };
      if (calW === null) { try { calW = new Worker('assets/worker.js'); } catch (e) { calW = false; } }
      if (!calW) { setTimeout(inline, 0); return; }
      const reqId = ++calReq, w = calW;
      w.onmessage = ev => { const m = ev.data; if (m.reqId !== reqId) return; if (m.type === 'calibrated') resolve(m.iters); else reject(new Error(m.message)); };
      w.onerror = ev => { if (ev.preventDefault) ev.preventDefault(); try { w.terminate(); } catch (e) { /* ignore */ } if (calW === w) calW = false; inline(); };
      w.postMessage({ type: 'calibrate', reqId, I: calSent === w ? undefined : I, mode: id, seconds: secs, ops: base.ops, k: base.k }); calSent = w;     // the instance travels once per worker
    });
  }
  function dropCalWorker() { if (calW) { try { calW.terminate(); } catch (e) { /* ignore */ } } calW = null; calSent = null; }
  const setTableMode = () => { $('runsCard').style.gridColumn = cmpMode ? '1 / -1' : ''; $('runTable').classList.toggle('single', !cmpMode); $('rankCard').hidden = !cmpMode; $('axisSeg').hidden = cmpMode; };

  async function solve() {
    if (!I || solving) return;
    const R = clamp(Math.round(+$('runs').value) || 1, 1, 50), seed0 = Math.round(+$('seed').value) || 0;
    const cmp = $('compare').checked, methods = cmp ? cmpSelected() : [$('method').value];
    if (!methods.length) { status('Select at least one method to compare.'); return; }
    const effort = $('effort').value, base = { construct: $('construct').value, ops: selectedOps(), k: clamp(+$('k').value || 12, 3, 40) };
    const my = ++session;
    solving = true; cmpMode = methods.length > 1; cmpIds = methods.slice(); hiMethod = null; runs = []; viewIdx = -1; tStart = performance.now();
    $('solve').disabled = true; $('stop').disabled = false; $('prog').hidden = true;
    ['dlSol', 'dlCsv', 'dlMap', 'dlConv'].forEach(id => { $(id).disabled = true; });
    if (cmpMode) $('zoom').checked = true;                      // compare curves are easier to read zoomed on the converged part (can be switched off)
    setTableMode(); schedule();
    const iters = {};
    try {
      if (effort === 'custom') iters[methods[0]] = Math.max(50, Math.round(+$('iters').value) || 50);
      else {
        const secs = EFFORT_S[effort] || EFFORT_S.standard;
        for (let i = 0; i < methods.length; i++) {
          status('Sizing the budget of ' + methods[i] + ' to about ' + secs + ' s per run (' + (i + 1) + '/' + methods.length + ')…');
          iters[methods[i]] = await calibrate(methods[i], secs, base);
          if (my !== session) return;
        }
        if (!cmpMode) $('iters').value = iters[methods[0]];
      }
    } catch (e) {
      if (my === session) { solving = false; $('solve').disabled = false; $('stop').disabled = true; status('Could not size the budget: ' + e.message); }
      return;
    }
    if (my !== session) return;
    dropCalWorker();
    let idx = 0;
    methods.forEach(m => { for (let i = 0; i < R; i++) runs.push({ idx: idx++, k: i + 1, method: m, seed: seed0 + i, status: 'queued', hist: [], iter: 0, total: iters[m], iters: iters[m], cost: NaN, sol: null, seconds: 0 }); });
    const total = runs.length;
    $('prog').hidden = false; $('prog').max = total; $('prog').value = 0;
    const jobs = runs.slice().sort((a, b) => a.k - b.k || a.idx - b.idx).map(r => ({ id: r.idx, cfg: Object.assign({}, base, { mode: r.method, iters: r.iters, seed: r.seed }) }));   // run 1 of every method first, so a stopped session still compares all methods
    const conc = clamp(Math.round(+$('workers').value) || 1, 1, Math.min(16, total));
    runner = startRunner(I, jobs, conc, {
      onStart: id => { runs[id].status = 'running'; schedule(); },
      onProgress: (id, m) => {
        const r = runs[id]; r.status = 'running'; r.hist = r.hist.concat(m.hist); r.iter = m.iter; r.total = m.total; r.seconds = m.seconds; r.cost = m.cost; r.initCost = m.initCost;
        if (m.sol) r.sol = m.sol; schedule();
      },
      onDone: (id, m) => {
        const r = runs[id]; r.status = m.stopped ? 'stopped' : 'done'; r.sol = m.sol; r.cost = m.cost; r.violations = m.violations; r.iter = m.iter; r.total = m.total;
        r.seconds = m.seconds; r.hist = m.hist; r.stats = m.stats; r.initCost = m.initCost; r.toBest = m.hist[m.hist.length - 1][2] / 1000; checkAllDone(); schedule();
      },
      onError: (id, msg) => { runs[id].status = 'error'; runs[id].error = msg; checkAllDone(); schedule(); },
    });
    status('Running ' + total + (total === 1 ? ' run' : ' runs') + (cmpMode ? ' (' + methods.length + ' methods × ' + R + ')' : '') + ' on ' + conc + (conc === 1 ? ' worker…' : ' workers…'));
    if (window.matchMedia && window.matchMedia('(max-width: 900px)').matches) $('kpis').scrollIntoView({ behavior: 'smooth', block: 'start' });   // single column: show the results
    schedule();
  }
  function checkAllDone() {
    $('prog').value = runs.filter(finalStatus).length;
    if (!runs.every(finalStatus)) return;
    solving = false; $('solve').disabled = false; $('stop').disabled = true; $('prog').hidden = true;
    if (runner) { runner.terminate(); runner = null; }
    const f = statRuns(); const el = (performance.now() - tStart) / 1000;
    const cut = runs.some(r => r.status === 'stopped' || r.status === 'skipped');
    const what = f.length + (f.length === 1 ? ' run' : ' runs') + (cmpMode ? ' of ' + new Set(f.map(r => r.method)).size + ' methods' : '');
    status(f.length ? (cut ? 'Stopped after ' + fmt(el, 1) + ' s; ' + what + ' reported (stopped runs are partial and left out of the mean ± sd when complete runs exist).' : 'Done: ' + what + ' in ' + fmt(el, 1) + ' s wall time.' + (cmpMode ? ' Ranking and charts below.' : '')) : 'No run finished.');
    $('dlSol').disabled = !f.length; $('dlCsv').disabled = !f.length; $('dlMap').disabled = !f.length; $('dlConv').disabled = !f.length;
  }
  function stopSolve(silent) {
    if (!solving) return;
    session++; dropCalWorker();
    if (runner) runner.stop();
    runs.forEach(r => { if (r.status === 'queued') r.status = 'skipped'; });
    if (!silent) status('Stopping…');
    if (silent || !runner) {
      if (runner) runner.terminate();
      runner = null; solving = false; $('solve').disabled = !I; $('stop').disabled = true; $('prog').hidden = true;
      if (!silent) { status(runs.some(r => r.sol) ? 'Stopped.' : 'Stopped before the runs started.'); schedule(); }
    } else checkAllDone();
  }
  $('solve').addEventListener('click', solve);
  $('stop').addEventListener('click', () => stopSolve(false));

  /* ------------------------------------------------------------------ runner: Web Workers, or in-page time slices */
  function startRunner(I, jobs, conc, h) {
    let pending = jobs.slice(), alive = true, workers = [], inline = false, cur = null;
    const inflight = new Map(), seen = new Set();
    function runInline() {
      inline = true; workers.forEach(w => w.terminate()); workers = [];
      pending = Array.from(inflight.values()).concat(pending); inflight.clear();
      const tick = () => {
        if (!alive) return;
        if (!cur) { const j = pending.shift(); if (!j) return; cur = { id: j.id, job: VRP.createJob(I, j.cfg) }; h.onStart(j.id); }
        const m = cur.job.poll(40);
        if (m.done) { const id = cur.id, res = cur.job.result(false); cur = null; h.onDone(id, res); } else h.onProgress(cur.id, m);
        setTimeout(tick, 0);
      };
      tick();
    }
    function feed(w) {
      if (!alive) { w.terminate(); workers = workers.filter(x => x !== w); return; }
      const j = pending.shift();
      if (!j) { w.terminate(); workers = workers.filter(x => x !== w); return; }
      inflight.set(j.id, j); h.onStart(j.id);
      w.postMessage({ type: 'job', jobId: j.id, I, cfg: j.cfg });
    }
    function spawn() {
      let w; try { w = new Worker('assets/worker.js'); } catch (e) { return false; }
      w.onmessage = ev => {
        const m = ev.data; seen.add(m.jobId);
        if (m.type === 'progress') h.onProgress(m.jobId, m);
        else if (m.type === 'done') { inflight.delete(m.jobId); h.onDone(m.jobId, m); feed(w); }
        else if (m.type === 'error') { inflight.delete(m.jobId); h.onError(m.jobId, m.message); feed(w); }
      };
      w.onerror = ev => { if (ev.preventDefault) ev.preventDefault(); if (!inline && !seen.size && alive) runInline(); };
      workers.push(w); return true;
    }
    for (let i = 0; i < conc; i++) { if (!spawn()) break; }
    if (!workers.length) runInline(); else workers.slice().forEach(feed);
    return {
      stop() {
        alive = false; pending = [];
        workers.forEach(w => w.postMessage({ type: 'stop' }));
        if (inline && cur) { const id = cur.id, res = cur.job.result(true); cur = null; h.onDone(id, res); }
      },
      terminate() { alive = false; workers.forEach(w => w.terminate()); workers = []; },
    };
  }

  const tdc = (v, c) => '<td' + (c ? ' class="' + c + '"' : '') + '>' + v + '</td>';

  /* ------------------------------------------------------------------ drawing */
  function schedule() { if (!raf) raf = requestAnimationFrame(() => { raf = 0; drawAll(); }); }
  function fit(canvas, ratio) {
    const dpr = window.devicePixelRatio || 1, w = canvas.clientWidth || 600, h = Math.round(w * ratio);
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
    canvas.style.height = h + 'px';
    const g = canvas.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, h); return [g, w, h];
  }
  function plot(cv, ratio, xr, yr, xt, yt, xlabel) {
    const [g, W, H] = fit(cv, ratio), L = 64, Rr = 14, T = 12, B = 38, w = W - L - Rr, h = H - T - B;
    const X = x => L + w * (x - xr[0]) / ((xr[1] - xr[0]) || 1), Y = y => T + h * (1 - (y - yr[0]) / ((yr[1] - yr[0]) || 1));
    g.font = '11px ' + css('--font'); g.lineWidth = 1;
    g.strokeStyle = css('--line'); g.fillStyle = css('--muted');
    g.textAlign = 'right'; g.textBaseline = 'middle';
    yt.forEach(v => { const y = Math.round(Y(v)) + .5; g.beginPath(); g.moveTo(L, y); g.lineTo(L + w, y); g.stroke(); g.fillText(fmt(v, Math.abs(v) < 100 ? 1 : 0), L - 6, y); });
    g.textAlign = 'center'; g.textBaseline = 'top';
    (xt || []).forEach(v => { const x = Math.round(X(v)) + .5; g.beginPath(); g.moveTo(x, T + h); g.lineTo(x, T + h + 4); g.stroke(); g.fillText(v >= 1000 ? fmt(v / 1000, 0) + 'k' : String(+v.toPrecision(4)), x, T + h + 6); });
    g.strokeRect(L + .5, T + .5, w, h);
    if (xlabel) { g.textAlign = 'center'; g.textBaseline = 'alphabetic'; g.fillText(xlabel, L + w / 2, H - 4); }
    g.save(); g.beginPath(); g.rect(L, T, w, h); g.clip();
    return { g, X, Y, L, T, w, h, W, H, end() { g.restore(); } };
  }
  function note(cv, ratio, text) {
    const [g, W] = fit(cv, ratio); g.fillStyle = css('--muted'); g.font = '13px ' + css('--font'); g.textBaseline = 'top';
    const words = text.split(' '); let line = '', y = 14;
    words.forEach(wd => { const t = line ? line + ' ' + wd : wd; if (g.measureText(t).width > W - 28 && line) { g.fillText(line, 14, y); y += 18; line = wd; } else line = t; });
    g.fillText(line, 14, y);
  }

  function drawAll() { drawMap(); drawConv(); drawDisp(); updateTable(); updateRank(); updateKpis(); }

  const depotColor = d => css('--c' + (d % 6 + 1));
  function drawMap() {
    const cv = $('map');
    if (!I) { note(cv, 0.85, 'Load an instance to see it here.'); return; }
    const [g, W, H] = fit(cv, 0.85), pad = 20, xs = I.x, ys = I.y;
    let minx = Infinity, maxx = -Infinity, miny = Infinity, maxy = -Infinity;
    for (let i = 0; i < I.N; i++) { minx = Math.min(minx, xs[i]); maxx = Math.max(maxx, xs[i]); miny = Math.min(miny, ys[i]); maxy = Math.max(maxy, ys[i]); }
    const sc = Math.min((W - 2 * pad) / (maxx - minx || 1), (H - 2 * pad) / (maxy - miny || 1));
    const ox = (W - sc * (maxx - minx)) / 2, oy = (H - sc * (maxy - miny)) / 2;
    const X = v => ox + (xs[v] - minx) * sc, Y = v => H - oy - (ys[v] - miny) * sc;
    const run = shownRun(), sol = run && run.sol;
    if (sol) {
      const per = new Array(I.t).fill(0);
      sol.routes.forEach((r, k) => {
        if (!r.nodes.length) return;
        const idx = per[r.d]++;
        g.strokeStyle = I.t === 1 ? css('--c' + (k % 6 + 1)) : depotColor(r.d);
        g.globalAlpha = I.t === 1 ? 1 : 0.95 - 0.35 * ((idx % 4) / 3);
        g.lineWidth = 1.6; g.beginPath(); g.moveTo(X(I.n + r.d), Y(I.n + r.d));
        r.nodes.forEach(c => g.lineTo(X(c), Y(c))); g.lineTo(X(I.n + r.d), Y(I.n + r.d)); g.stroke();
      });
      g.globalAlpha = 1;
    }
    const owner = new Int32Array(I.n).fill(-1);
    if (sol) sol.routes.forEach(r => r.nodes.forEach(c => { owner[c] = r.d; }));
    const rad = I.n > 200 ? 2.2 : 3;
    for (let c = 0; c < I.n; c++) { g.fillStyle = owner[c] >= 0 && I.t > 1 ? depotColor(owner[c]) : css('--muted'); g.beginPath(); g.arc(X(c), Y(c), rad, 0, 6.2832); g.fill(); }
    for (let d = 0; d < I.t; d++) { const v = I.n + d; g.fillStyle = css('--ink'); g.fillRect(X(v) - 6, Y(v) - 6, 12, 12); g.fillStyle = depotColor(d); g.fillRect(X(v) - 4, Y(v) - 4, 8, 8); }
    $('mapCap').textContent = run ? '· ' + (cmpMode ? run.method + ' ' : '') + 'run ' + run.k + (run === bestRun(solving ? runs : statRuns()) ? (solving ? ' (best so far)' : ' (best)') : '') + ' · cost ' + fmt(run.cost, 1) : '· ' + I.name;
    $('mapLegend').innerHTML = I.t === 1 ? '<span>depot ■, customers ●, one colour per route</span>' :
      Array.from({ length: I.t }, (_, d) => '<span><i style="background:' + depotColor(d) + '"></i>depot ' + (d + 1) + '</span>').join('');
  }

  function drawConv() { if (cmpMode) drawConvCompare(); else drawConvSingle(); }
  function drawConvSingle() {
    const cv = $('conv'), withHist = runs.filter(r => r.hist.length);
    if (!withHist.length) { note(cv, 0.58, I ? 'Press Solve: the best cost so far of every run appears here.' : 'Load an instance first.'); $('convLegend').innerHTML = ''; return; }
    const xi = axis === 'time' ? 2 : 0, sx = axis === 'time' ? 1 / 1000 : 1;
    const xmax = Math.max(...withHist.map(r => (axis === 'time' ? Math.max(r.hist[r.hist.length - 1][2], r.seconds * 1000) : r.iter) || r.hist[r.hist.length - 1][xi]), 1);
    let lo = Infinity, hi = -Infinity;
    withHist.forEach(r => { lo = Math.min(lo, r.hist[r.hist.length - 1][1]); hi = Math.max(hi, r.hist[0][1]); });
    const showRef = entry && entry.bks != null && entry.bksStatus !== 'unverified';
    if (showRef) lo = Math.min(lo, entry.bks);
    if ($('zoom').checked) { let h2 = -Infinity; withHist.forEach(r => { h2 = Math.max(h2, RunStats.valueAt(r.hist, xi, xmax * 0.08)); }); hi = Math.max(lo + 1e-6, Math.min(hi, h2)); }
    const padY = (hi - lo) * 0.05 || 1; const yr = [lo - padY, hi + padY];
    const P = plot(cv, 0.58, [0, xmax * sx], yr, RunStats.ticks(0, xmax * sx, 5), RunStats.ticks(yr[0], yr[1], 5), axis === 'time' ? 'time (s of compute per run)' : 'iterations');
    const g = P.g, best = bestRun(solving ? runs : statRuns());
    const line = (r, color, w, alpha) => {
      g.strokeStyle = color; g.lineWidth = w; g.globalAlpha = alpha; g.beginPath();
      let prev = null;
      r.hist.forEach((p, i) => { const x = P.X(p[xi] * sx), y = P.Y(p[1]); if (i === 0) g.moveTo(x, y); else { g.lineTo(x, prev); g.lineTo(x, y); } prev = y; });
      const endX = P.X((axis === 'time' ? (r.status === 'running' ? r.seconds * 1000 : Math.max(r.seconds * 1000, r.hist[r.hist.length - 1][2])) : r.iter) * sx);
      g.lineTo(Math.max(endX, P.X(r.hist[r.hist.length - 1][xi] * sx)), prev); g.stroke(); g.globalAlpha = 1;
    };
    const done = runs.filter(r => (r.status === 'done') && r.hist.length);
    const bandOk = !solving && done.length >= 2;
    if (bandOk) {
      const c = RunStats.curves(done, axis, 160, axis === 'time' ? xmax : xmax);
      g.fillStyle = css('--c2'); g.globalAlpha = 0.18; g.beginPath();
      c.grid.forEach((x, k) => { const px = P.X(x * sx), py = P.Y(c.mean[k] + c.sd[k]); if (k) g.lineTo(px, py); else g.moveTo(px, py); });
      for (let k = c.grid.length - 1; k >= 0; k--) g.lineTo(P.X(c.grid[k] * sx), P.Y(c.mean[k] - c.sd[k]));
      g.closePath(); g.fill(); g.globalAlpha = 1;
    }
    runs.forEach(r => { if (r.hist.length && r !== best) line(r, css('--accent'), 1, runs.length > 12 ? 0.25 : 0.4); });
    if (bandOk) {
      const c = RunStats.curves(done, axis, 160, xmax);
      g.strokeStyle = css('--c2'); g.lineWidth = 2; g.beginPath(); c.grid.forEach((x, k) => { const px = P.X(x * sx), py = P.Y(c.mean[k]); if (k) g.lineTo(px, py); else g.moveTo(px, py); }); g.stroke();
    }
    if (best && best.hist.length) line(best, css('--accent'), 2.2, 1);
    if (showRef) { const y = P.Y(entry.bks); g.strokeStyle = css('--ok'); g.lineWidth = 1.2; g.setLineDash([6, 4]); g.beginPath(); g.moveTo(P.L, y); g.lineTo(P.L + P.w, y); g.stroke(); g.setLineDash([]); }
    P.end();
    $('convLegend').innerHTML = '<span><i style="background:' + css('--accent') + '"></i>runs (thick: best)</span>' +
      (bandOk ? '<span><i style="background:' + css('--c2') + '"></i>mean ± sd over ' + done.length + ' runs</span>' : (runs.length > 1 ? '<span class="small">mean ± sd appears when all runs have finished</span>' : '')) +
      (showRef ? '<span><i style="background:' + css('--ok') + '"></i>' + (entry.bksStatus === 'verified' ? 'best known' : 'reference') + ' ' + fmt(entry.bks, Number.isInteger(entry.bks) ? 0 : 2) + '</span>' : '');
  }

  function drawDisp() { if (cmpMode) drawDispCompare(); else drawDispSingle(); }
  function drawDispSingle() {
    const cv = $('disp'), rs = statRuns();
    if (!rs.length) { note(cv, 0.58, solving ? 'Final costs appear as runs finish.' : 'Final cost of every run, with the mean and ± one standard deviation.'); $('dispNote').textContent = ''; return; }
    const vals = rs.map(r => r.cost), S = RunStats.summary(vals), n = rs.length;
    const showRef = entry && entry.bks != null && entry.bksStatus !== 'unverified';
    let lo = Math.min(...vals, S.mean - S.sd), hi = Math.max(...vals, S.mean + S.sd);
    if (showRef) { lo = Math.min(lo, entry.bks); hi = Math.max(hi, entry.bks); }
    const padY = (hi - lo) * 0.12 || Math.max(1, Math.abs(hi) * 0.001); const yr = [lo - padY, hi + padY];
    const xr = [0, n + 2.6], P = plot(cv, 0.58, xr, yr, [], RunStats.ticks(yr[0], yr[1], 5), '');
    const g = P.g;
    g.fillStyle = css('--c2'); g.globalAlpha = 0.14; g.fillRect(P.X(0), P.Y(S.mean + S.sd), P.X(n + 0.5) - P.X(0), P.Y(S.mean - S.sd) - P.Y(S.mean + S.sd)); g.globalAlpha = 1;
    g.strokeStyle = css('--c2'); g.lineWidth = 1.5; g.setLineDash([5, 4]); g.beginPath(); g.moveTo(P.X(0), P.Y(S.mean)); g.lineTo(P.X(n + 0.5), P.Y(S.mean)); g.stroke(); g.setLineDash([]);
    if (showRef) { const y = P.Y(entry.bks); g.strokeStyle = css('--ok'); g.lineWidth = 1.2; g.setLineDash([6, 4]); g.beginPath(); g.moveTo(P.L, y); g.lineTo(P.L + P.w, y); g.stroke(); g.setLineDash([]); }
    const bst = bestRun(rs);
    rs.forEach((r, i) => { g.fillStyle = r === bst ? css('--ok') : css('--accent'); g.beginPath(); g.arc(P.X(i + 1), P.Y(r.cost), r === bst ? 5 : 3.5, 0, 6.2832); g.fill(); });
    const mx = P.X(n + 1.7); g.strokeStyle = css('--c2'); g.fillStyle = css('--c2'); g.lineWidth = 2;
    g.beginPath(); g.moveTo(mx, P.Y(S.mean + S.sd)); g.lineTo(mx, P.Y(S.mean - S.sd)); g.moveTo(mx - 6, P.Y(S.mean + S.sd)); g.lineTo(mx + 6, P.Y(S.mean + S.sd)); g.moveTo(mx - 6, P.Y(S.mean - S.sd)); g.lineTo(mx + 6, P.Y(S.mean - S.sd)); g.stroke();
    g.beginPath(); g.arc(mx, P.Y(S.mean), 5, 0, 6.2832); g.fill();
    P.end();
    const gg = P.g; gg.fillStyle = css('--muted'); gg.font = '11px ' + css('--font'); gg.textAlign = 'center'; gg.textBaseline = 'top';
    const stepL = Math.max(1, Math.ceil(n / 12));
    rs.forEach((r, i) => { if (i % stepL === 0) gg.fillText(String(r.idx + 1), P.X(i + 1), P.T + P.h + 6); });
    gg.fillText('mean ± sd', mx, P.T + P.h + 6); gg.textBaseline = 'alphabetic'; gg.fillText('run #', P.L + P.w * (n / 2 + 0.5) / xr[1], P.H - 4);
    $('dispNote').textContent = 'n = ' + n + (n === 1 ? ' run' : ' runs') + ': mean ' + fmt(S.mean, 1) + (n > 1 ? ', sd ' + fmt(S.sd, 1) + ' (' + fmt(100 * S.sd / S.mean, 2) + ' % of the mean)' : '') +
      ', best ' + fmt(S.min, 1) + ', worst ' + fmt(S.max, 1) + (n > 1 ? ', median ' + fmt(S.median, 1) : '') + '.' + (n === 1 ? ' Run at least two seeds to see a spread.' : '');
  }


  /* ------------------------------------------------------------------ compare mode: several methods, same seeds */
  function methodGroups() {
    return cmpIds.map((id, ci) => {
      const all = runs.filter(r => r.method === id), full = all.filter(r => r.status === 'done' && r.sol), part = all.filter(r => r.status === 'stopped' && r.sol), use = full.length ? full : part;
      return { id, ci, all, runs: use, S: use.length ? RunStats.summary(use.map(r => r.cost)) : null, best: bestRun(use), complete: all.length > 0 && all.every(r => r.status === 'done') };
    });
  }
  function drawConvCompare() {
    const cv = $('conv'), gs = methodGroups().filter(g => g.all.some(r => r.hist.length));
    if (!gs.length) { note(cv, 0.58, I ? 'Press Solve: the mean best-so-far curve of every method appears here.' : 'Load an instance first.'); $('convLegend').innerHTML = ''; return; }
    const withH = runs.filter(r => r.hist.length);
    const xmax = Math.max(...withH.map(r => Math.max(r.hist[r.hist.length - 1][2], r.seconds * 1000)), 1);
    let lo = Infinity, hi = -Infinity;
    withH.forEach(r => { lo = Math.min(lo, r.hist[r.hist.length - 1][1]); hi = Math.max(hi, r.hist[0][1]); });
    const showRef = entry && entry.bks != null && entry.bksStatus !== 'unverified';
    if (showRef) lo = Math.min(lo, entry.bks);
    if ($('zoom').checked) { let h2 = -Infinity; withH.forEach(r => { h2 = Math.max(h2, RunStats.valueAt(r.hist, 2, xmax * 0.08)); }); hi = Math.max(lo + 1e-6, Math.min(hi, h2)); }
    const padY = (hi - lo) * 0.05 || 1, yr = [lo - padY, hi + padY];
    const P = plot(cv, 0.58, [0, xmax / 1000], yr, RunStats.ticks(0, xmax / 1000, 5), RunStats.ticks(yr[0], yr[1], 5), 'compute time per run (s)'), g = P.g;
    const style = (m, alpha, w) => { g.strokeStyle = MCOL(m.ci); g.setLineDash(MDASH[Math.floor(m.ci / 6) % 3]); g.lineWidth = w; g.globalAlpha = hiMethod && hiMethod !== m.id ? Math.min(alpha, 0.18) : alpha; };
    gs.slice().sort((a, b) => (a.id === hiMethod) - (b.id === hiMethod)).forEach(m => {
      const done = m.runs.filter(r => r.hist.length && r.status === 'done');
      if (m.complete && done.length) {
        const c = RunStats.curves(done, 'time', 140, xmax);
        if (done.length >= 2 && m.id === hiMethod) {
          g.setLineDash([]); g.fillStyle = MCOL(m.ci); g.globalAlpha = 0.18; g.beginPath();
          c.grid.forEach((x, k) => { const px = P.X(x / 1000), py = P.Y(c.mean[k] + c.sd[k]); if (k) g.lineTo(px, py); else g.moveTo(px, py); });
          for (let k = c.grid.length - 1; k >= 0; k--) g.lineTo(P.X(c.grid[k] / 1000), P.Y(c.mean[k] - c.sd[k]));
          g.closePath(); g.fill();
        }
        style(m, 1, m.id === hiMethod ? 2.8 : 1.8); g.beginPath();
        c.grid.forEach((x, k) => { const px = P.X(x / 1000), py = P.Y(c.mean[k]); if (k) g.lineTo(px, py); else g.moveTo(px, py); }); g.stroke();
      } else {
        m.all.filter(r => r.hist.length).forEach(r => {
          style(m, 0.55, 1.2); g.beginPath(); let prev = null;
          r.hist.forEach((p, i) => { const x = P.X(p[2] / 1000), y = P.Y(p[1]); if (i === 0) g.moveTo(x, y); else { g.lineTo(x, prev); g.lineTo(x, y); } prev = y; });
          g.lineTo(P.X((r.status === 'running' ? r.seconds * 1000 : Math.max(r.seconds * 1000, r.hist[r.hist.length - 1][2])) / 1000), prev); g.stroke();
        });
      }
      g.setLineDash([]); g.globalAlpha = 1;
    });
    if (showRef) { const y = P.Y(entry.bks); g.strokeStyle = css('--ok'); g.lineWidth = 1.2; g.setLineDash([6, 4]); g.beginPath(); g.moveTo(P.L, y); g.lineTo(P.L + P.w, y); g.stroke(); g.setLineDash([]); }
    P.end();
    $('convLegend').innerHTML = cmpIds.map((id, ci) => {
      const dash = MDASH[Math.floor(ci / 6) % 3].join(',');
      return '<span class="lg' + (hiMethod === id ? ' on' : '') + '" data-m="' + id + '" title="' + VRP.METHODS[id].label + '"><svg width="24" height="8" aria-hidden="true"><line x1="0" y1="4" x2="24" y2="4" stroke="' + MCOL(ci) + '" stroke-width="2.6"' + (dash ? ' stroke-dasharray="' + dash + '"' : '') + '/></svg>' + id + '</span>';
    }).join('') + (showRef ? '<span><i style="background:' + css('--ok') + '"></i>' + (entry.bksStatus === 'verified' ? 'best known' : 'reference') + ' ' + fmt(entry.bks, Number.isInteger(entry.bks) ? 0 : 2) + '</span>' : '') +
      '<span class="small">' + (solving ? 'thin lines: runs so far; ' : 'lines: mean over runs; ') + 'click a method to highlight it (sd band) and draw its best run</span>';
  }
  function drawDispCompare() {
    const cv = $('disp'), gs = methodGroups().filter(g => g.S).sort((a, b) => a.S.mean - b.S.mean);
    if (!gs.length) { note(cv, 0.58, solving ? 'Final costs appear as runs finish.' : 'Final cost of every run of every method, with mean ± sd.'); $('dispNote').textContent = ''; return; }
    let lo = Infinity, hi = -Infinity;
    gs.forEach(g => { g.runs.forEach(r => { lo = Math.min(lo, r.cost); hi = Math.max(hi, r.cost); }); lo = Math.min(lo, g.S.mean - g.S.sd); hi = Math.max(hi, g.S.mean + g.S.sd); });
    const showRef = entry && entry.bks != null && entry.bksStatus !== 'unverified';
    if (showRef) { lo = Math.min(lo, entry.bks); hi = Math.max(hi, entry.bks); }
    const padY = (hi - lo) * 0.1 || Math.max(1, Math.abs(hi) * 0.001), yr = [lo - padY, hi + padY], n = gs.length;
    const P = plot(cv, 0.58, [0.4, n + 0.6], yr, [], RunStats.ticks(yr[0], yr[1], 5), ''), g = P.g;
    if (showRef) { const y = P.Y(entry.bks); g.strokeStyle = css('--ok'); g.lineWidth = 1.2; g.setLineDash([6, 4]); g.beginPath(); g.moveTo(P.L, y); g.lineTo(P.L + P.w, y); g.stroke(); g.setLineDash([]); }
    gs.forEach((m, i) => {
      const x0 = P.X(i + 1), k = m.runs.length, hot = m.id === hiMethod;
      g.globalAlpha = hiMethod && !hot ? 0.35 : 1; g.fillStyle = MCOL(m.ci);
      m.runs.forEach((r, j) => { const dx = k > 1 ? (j / (k - 1) - 0.5) * 0.5 * (P.X(2) - P.X(1)) : 0; g.beginPath(); g.arc(x0 + dx, P.Y(r.cost), hot ? 4 : 3, 0, 6.2832); g.fill(); });
      const a = P.Y(m.S.mean + m.S.sd), b = P.Y(m.S.mean - m.S.sd);
      g.strokeStyle = css('--ink'); g.fillStyle = css('--ink'); g.lineWidth = 2;
      g.beginPath(); g.moveTo(x0, a); g.lineTo(x0, b); g.moveTo(x0 - 5, a); g.lineTo(x0 + 5, a); g.moveTo(x0 - 5, b); g.lineTo(x0 + 5, b); g.stroke();
      g.fillRect(x0 - 6, P.Y(m.S.mean) - 1.5, 12, 3); g.globalAlpha = 1;
    });
    P.end();
    g.fillStyle = css('--muted'); g.font = '11px ' + css('--font'); g.textAlign = 'center'; g.textBaseline = 'top';
    gs.forEach((m, i) => g.fillText(m.id, P.X(i + 1), P.T + P.h + 6 + (n > 9 && i % 2 ? 12 : 0)));
    const w = gs[0];
    $('dispNote').textContent = 'Methods sorted by mean final cost; each dot is one run, the bar is the mean ± one sample sd. Best mean: ' + w.id + ' (' + fmt(w.S.mean, 1) + (w.S.n > 1 ? ' ± ' + fmt(w.S.sd, 1) : '') + ', n = ' + w.S.n + ').';
  }
  function updateRank() {
    if (!cmpMode) return;
    const gs = methodGroups().filter(g => g.S).sort((a, b) => a.S.mean - b.S.mean), tb = $('rankTable').tBodies[0];
    tb.innerHTML = gs.map((m, i) => {
      const gap = refGap(m.S.mean);
      return '<tr data-m="' + m.id + '" class="' + (i === 0 ? 'best ' : '') + (m.id === hiMethod ? 'sel' : '') + '">' + tdc(i + 1, 'num') +
        '<td title="' + VRP.METHODS[m.id].label + '"><b>' + m.id + '</b> <span class="small">' + VRP.METHODS[m.id].label + '</span></td>' + tdc(fmt(m.S.mean, 1), 'num') + tdc(m.S.n > 1 ? fmt(m.S.sd, 1) : '–', 'num') + tdc(fmt(m.S.min, 1), 'num') +
        tdc(isNaN(gap) ? '–' : fmtGap(gap), 'num') + tdc(fmt(RunStats.mean(m.runs.map(r => r.seconds)), 2), 'num') + tdc(m.runs[0].iters.toLocaleString('en-US'), 'num') + tdc(m.S.n + (m.complete ? '' : ' (' + m.all.length + ')'), 'num') + '</tr>';
    }).join('');
    $('rankNote').textContent = 'Ranked by the mean final cost over runs that use the same seeds. sd is the sample standard deviation. With few runs the ranking is only indicative: a difference of means below about one sd is no evidence that one method is better. Iterations were sized so that one run takes about the same compute time; check the time column.';
  }
  $('rankTable').tBodies[0].addEventListener('click', e => {
    const tr = e.target.closest('tr'); if (!tr) return;
    hiMethod = tr.dataset.m; const g = methodGroups().find(x => x.id === hiMethod); if (g && g.best) viewIdx = g.best.idx; schedule();
  });
  $('convLegend').addEventListener('click', e => {
    const sp = e.target.closest('[data-m]'); if (!sp || !cmpMode) return;
    hiMethod = hiMethod === sp.dataset.m ? null : sp.dataset.m;
    const g = methodGroups().find(x => x.id === hiMethod); viewIdx = g && g.best ? g.best.idx : -1; schedule();
  });

  function updateTable() {
    const tb = $('runTable').tBodies[0], best = bestRun(solving ? runs : statRuns()), shown = shownRun();
    const td = tdc;
    tb.innerHTML = runs.map(r => {
      const fin = r.status === 'done' || r.status === 'stopped', cls = (r === best ? 'best ' : '') + (r === shown ? 'sel' : '');
      let cells;
      if (!fin) {
        const pct = r.total ? Math.round(100 * r.iter / r.total) : 0;
        cells = td(r.method, 'mcol') + td(r.k) + td(r.seed) + td(r.sol ? fmt(r.cost, 1) : '–', 'num') + td('–', 'num') + td('–', 'num') + td(r.seconds ? fmt(r.seconds, 2) : '–', 'num') + td('–', 'num') +
          td(r.status === 'running' ? pct + ' %' : r.status);
      } else {
        const gap = refGap(r.cost), ok = isFeasible(r);
        cells = td(r.method, 'mcol') + td(r.k) + td(r.seed) + td(fmt(r.cost, 1), 'num') + td(isNaN(gap) ? '–' : fmtGap(gap), 'num') + td(nRoutes(r), 'num') + td(fmt(r.seconds, 2), 'num') + td(fmt(r.toBest, 2), 'num') +
          '<td class="' + (ok ? 'feas-ok' : 'feas-bad') + '" title="' + (r.violations || []).slice(0, 5).join(' / ').replace(/"/g, '') + '">' + (ok ? '✓' : '✗') +
          (r.status === 'stopped' ? ' <span class="small">stopped at ' + fmt(100 * r.iter / r.total, 0) + ' %</span>' : '') + '</td>';
      }
      return '<tr data-i="' + r.idx + '" class="' + cls + '">' + cells + '</tr>';
    }).join('');
  }
  $('runTable').tBodies[0].addEventListener('click', e => {
    const tr = e.target.closest('tr'); if (!tr) return;
    const r = runs[+tr.dataset.i]; if (r && r.sol) { viewIdx = r.idx; if (cmpMode) hiMethod = r.method; schedule(); }
  });

  function updateKpis() {
    const rs = statRuns(), live = solving ? bestRun(runs) : null, best = live || bestRun(rs), shown = shownRun();
    $('kBest').textContent = best ? fmt(best.cost, 1) : '–';
    const gap = best ? refGap(best.cost) : NaN;
    $('kGap').textContent = isNaN(gap) ? '–' : fmtGap(gap) + ' %';
    $('kGapLbl').textContent = !entry ? 'gap (no reference for this instance)' : entry.bksStatus === 'verified' ? 'gap to best known (verified)' : entry.bksStatus === 'secondary' ? 'gap to reference (secondary)' : 'gap (no verified reference)';
    $('kBest').title = best && cmpMode ? 'found by ' + best.method : '';
    if (rs.length) {
      let S, lbl = 'mean ± sd over runs';
      if (cmpMode) { const g0 = methodGroups().filter(g => g.S).sort((a, b) => a.S.mean - b.S.mean)[0]; S = g0.S; lbl = 'mean ± sd of the best-mean method (' + g0.id + ')'; } else S = RunStats.summary(rs.map(r => r.cost));
      $('kMeanLbl').textContent = lbl;
      $('kMean').textContent = S.n > 1 ? fmt(S.mean, 1) + ' ± ' + fmt(S.sd, 1) : fmt(S.mean, 1);
      $('kTime').textContent = fmt(RunStats.mean(rs.map(r => r.seconds)), 2) + ' s';
    } else { $('kMean').textContent = '–'; $('kTime').textContent = solving ? '…' : '–'; }
    if (shown && shown.sol) {
      const per = new Array(I.t).fill(0); shown.sol.routes.forEach(r => { if (r.nodes.length) per[r.d]++; });
      $('kRoutes').textContent = per.reduce((a, b) => a + b, 0) + (I.t > 1 ? ' (' + per.join('/') + ')' : '');
    } else $('kRoutes').textContent = '–';
    const f = $('kFeas');
    if (shown && shown.violations) { f.textContent = shown.violations.length ? 'violated' : 'feasible'; f.className = shown.violations.length ? 'feas-bad' : 'feas-ok'; f.title = shown.violations.slice(0, 5).join('\n'); }
    else { f.textContent = shown && solving ? 'running' : '–'; f.className = ''; f.title = ''; }
  }

  /* ------------------------------------------------------------------ downloads */
  function download(name, text, type) {
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type: type || 'text/plain' })); a.download = name;
    document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }
  $('dlSol').addEventListener('click', () => {
    const r = bestRun(statRuns()); if (!r) return;
    const lines = r.sol.routes.filter(q => q.nodes.length).map((q, k) => 'Route #' + (k + 1) + ' (depot ' + (q.d + 1) + '): ' + q.nodes.map(v => v + 1).join(' '));
    download(I.name.replace(/[^\w.-]+/g, '_') + '.best.sol', lines.join('\n') + '\nCost ' + r.cost.toFixed(4) + '\n');
  });
  $('dlCsv').addEventListener('click', () => {
    const rows = ['method,run,seed,cost,gap_pct,routes,seconds,seconds_to_best,iterations,feasible,status'];
    runs.filter(r => r.sol).forEach(r => rows.push([r.method, r.k, r.seed, r.cost, isNaN(refGap(r.cost)) ? '' : refGap(r.cost).toFixed(4), nRoutes(r), r.seconds.toFixed(3), (r.toBest || 0).toFixed(3), r.iter, isFeasible(r), r.status].join(',')));
    download(I.name.replace(/[^\w.-]+/g, '_') + '.runs.csv', rows.join('\n') + '\n', 'text/csv');
  });

  /* PNG of a chart canvas on the page background (the canvases themselves are transparent) */
  function downloadPng(canvas, name) {
    const c = document.createElement('canvas'); c.width = canvas.width; c.height = canvas.height;
    const g = c.getContext('2d'); g.fillStyle = css('--panel') || '#ffffff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(canvas, 0, 0);
    c.toBlob(b => { const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = name; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500); }, 'image/png');
  }
  const baseName = () => (I ? I.name.replace(/[^\w.-]+/g, '_') : 'vrp');
  $('dlMap').addEventListener('click', () => downloadPng($('map'), baseName() + '.routes.png'));
  $('dlConv').addEventListener('click', () => downloadPng($('conv'), baseName() + '.convergence.png'));
  $('dlTemplate').addEventListener('click', ev => {
    ev.preventDefault();
    download('vrp-template.csv', 'name,x,y,demand\nDepot,50,50,0\nCustomer 1,20,70,4\nCustomer 2,35,90,7\nCustomer 3,80,75,3\nCustomer 4,90,40,6\nCustomer 5,65,15,5\nCustomer 6,30,20,2\nCustomer 7,10,45,8\nCustomer 8,55,80,4\n', 'text/csv');
  });

  /* Simple / Expert: Simple hides the settings a first-time user does not need (class "adv"); the hidden controls keep their defaults. */
  function setUiMode(m) {
    document.body.classList.toggle('simple', m !== 'expert');
    document.querySelectorAll('#modeSeg [data-mode]').forEach(x => x.classList.toggle('on', x.dataset.mode === (m === 'expert' ? 'expert' : 'simple')));
    if (m !== 'expert' && !solving) {
      if ($('compare').checked) { $('compare').checked = false; setMode(); }
      if ($('effort').value === 'custom') { $('effort').value = 'standard'; updateEst(); }
    }
    try { localStorage.setItem('vrp-ui-mode', m); } catch (e) { /* private browsing */ }
  }
  document.querySelectorAll('#modeSeg [data-mode]').forEach(b => b.addEventListener('click', () => setUiMode(b.dataset.mode)));
  $('guide').addEventListener('toggle', () => { try { localStorage.setItem('vrp-guide', $('guide').open ? 'open' : 'closed'); } catch (e) { /* ignore */ } });

  window.addEventListener('resize', schedule);

  /* ------------------------------------------------------------------ start-up; optional URL parameters:
   * ?inst=p01 (benchmark) &method=<id> &effort=quick|standard|long &iters=N (custom) &compare=all|core|id,id,… &runs=N &seed=N &workers=N &solve=1 */
  (async function init() {
    const q = new URLSearchParams(location.search);
    const expertParams = ['method', 'iters', 'compare', 'seed', 'workers'].some(k => q.get(k));
    let savedMode = null, savedGuide = null;
    try { savedMode = localStorage.getItem('vrp-ui-mode'); savedGuide = localStorage.getItem('vrp-guide'); } catch (e) { /* ignore */ }
    setUiMode(q.get('mode') === 'expert' || q.get('mode') === 'simple' ? q.get('mode') : expertParams ? 'expert' : savedMode || 'simple');
    $('guide').open = savedGuide !== 'closed';
    if (q.get('method') && VRP.METHODS[q.get('method')]) $('method').value = q.get('method');
    describeMethod();
    if (['quick', 'standard', 'long'].includes(q.get('effort'))) $('effort').value = q.get('effort');
    if (q.get('iters')) { $('iters').value = q.get('iters'); $('effort').value = 'custom'; }
    if (q.get('compare')) {
      const c = q.get('compare'); $('compare').checked = true; setMode();
      setCmp(c === 'all' ? MIDS : c === 'core' || c === '1' ? CORE : c.split(',').filter(x => VRP.METHODS[x]));
    }
    if (q.get('runs')) $('runs').value = q.get('runs');
    if (q.get('seed')) $('seed').value = q.get('seed');
    if (q.get('workers')) $('workers').value = q.get('workers');
    updateEst();
    const want = q.get('inst') && catalogue.some(e => e.name === q.get('inst')) ? q.get('inst') : 'X-n101-k25';
    if (catalogue.length) $('bench').value = want;
    drawAll();
    await loadInstance();
    if (!I) {                                         // offline: fall back to a generated instance
      document.querySelector('[data-src="random"]').click(); await loadInstance();
      status('Benchmark download failed; using a random instance instead. ' + $('status').textContent);
    }
    if (q.get('solve') === '1' && I) solve();
  })();
})();

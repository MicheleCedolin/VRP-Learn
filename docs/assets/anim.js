/* Algorithm animations for learn.html.  All three run the real code of vrp.js (the browser solver) on small toy
 * instances; they illustrate how the algorithms work and are not benchmark results.
 *   [data-anim=savings]  Clarke-Wright savings, replayed from VRP.savings(I, trace)
 *   [data-anim=sweep]    sweep construction, replayed from VRP.sweep(I, trace)
 *   [data-anim=rr]       ruin & recreate + simulated annealing, stepped live with VRP.createSearch(..., {trace:true}) */
(function () {
  'use strict';
  const V = window.VRP, Z = window.VRPViz;
  if (!V || !Z) return;
  const W = 360, H = 300;

  function geom(I, pad) {
    const xs = [], ys = []; for (let i = 0; i < I.N; i++) { xs.push(I.x[i]); ys.push(I.y[i]); }
    const f = Z.fitter(xs, ys, W, H, pad || 22);
    const P = new Array(I.N); for (let i = 0; i < I.N; i++) P[i] = [f.X(I.x[i]), f.Y(I.y[i])];
    return { f, P };
  }
  const load = (I, nodes) => nodes.reduce((a, c) => a + I.dem[c], 0);
  const cost = (I, rs) => rs.reduce((a, r) => a + V.rCost(I, 0, r), 0);

  /* ---------------------------------------------------------------- savings */
  function savingsDemo(root) {
    const I = V.generate(12, 1, 7, { grid: 100, capacity: 60 }), Q = I.Q[0], g = geom(I), dep = g.P[I.n];
    const tr = []; V.savings(I, tr);
    const frames = []; let gap = [];                         // accepted merges + the first capacity rejection before each merge
    for (const e of tr) {
      if (e.ok) { if (gap.length) frames.push({ type: 'rej', e: gap[0], more: gap.length - 1 }); gap = []; frames.push({ type: 'merge', e }); }
      else if (e.why === 'limit') gap.push(e);
    }
    if (gap.length) frames.push({ type: 'rej', e: gap[0], more: gap.length - 1 });
    const key = r => r.join(',');
    const routesAt = k => {
      let rs = []; for (let c = 0; c < I.n; c++) rs.push([c]);
      for (let q = 0; q < k; q++) {
        const f = frames[q]; if (f.type !== 'merge') continue;
        const a = key(f.e.A), b = key(f.e.B);
        rs = rs.filter(r => { const s = key(r); return s !== a && s !== b; }); rs.push(f.e.M.slice());
      }
      return rs;
    };
    const nm = c => String(c + 1);
    function frame(k) {
      const rs = routesAt(k), f = k ? frames[k - 1] : null;
      const multi = rs.filter(r => r.length > 1).sort((a, b) => Math.min.apply(null, a) - Math.min.apply(null, b));
      const cen = multi.map(r => [r.reduce((a, c) => a + g.P[c][0], 0) / r.length, r.reduce((a, c) => a + g.P[c][1], 0) / r.length]);
      const rank = Z.colourRank(cen, dep[0], dep[1]);
      let s = '';
      rs.filter(r => r.length === 1).forEach(r => { s += Z.seg(dep, g.P[r[0]], 'stroke:var(--muted);stroke-width:1;opacity:.7'); });
      multi.forEach((r, q) => { s += Z.poly([dep].concat(r.map(c => g.P[c]), [dep]), 'stroke:' + Z.col(rank[q]) + ';stroke-width:2.2'); });
      if (f && f.type === 'merge') s += Z.seg(g.P[f.e.i], g.P[f.e.j], 'stroke:var(--ok);stroke-width:4;opacity:.55');
      if (f && f.type === 'rej') s += Z.seg(g.P[f.e.i], g.P[f.e.j], 'stroke:var(--bad);stroke-width:2.4;stroke-dasharray:5 4');
      for (let c = 0; c < I.n; c++) s += Z.dot(g.P[c], 5.5) + Z.label(g.P[c], nm(c) + ' (' + I.dem[c] + ')', 7, -7, 'fill:var(--ink)');
      if (f) [f.e.i, f.e.j].forEach(c => { s += Z.ring(g.P[c], 9, f.type === 'merge' ? 'var(--ok)' : 'var(--bad)'); });
      s += Z.depotMark(dep, 6, 'depot');
      let cap;
      if (!f) cap = 'Start: every customer has its own round trip from the depot (grey spokes). Numbers show customer (demand); capacity Q = ' + Q + '. Press Play or Step.';
      else {
        const sav = f.e.s.toFixed(1), ij = nm(f.e.i) + ',' + nm(f.e.j);
        if (f.type === 'merge') cap = 'Link (' + ij + ') has the largest remaining saving s = c(0,' + nm(f.e.i) + ') + c(0,' + nm(f.e.j) + ') − c(' + ij + ') = ' + sav +
          '. The two routes can be joined at their ends; merged load ' + load(I, f.e.M) + ' ≤ ' + Q + ', so the link is accepted.';
        else cap = 'Link (' + ij + ') saves ' + sav + ' but the merged route would carry ' + load(I, f.e.M) + ' > ' + Q + ', so it is rejected' +
          (f.more ? ' (as are ' + f.more + ' more links before the next merge).' : '.');
      }
      return { svg: s, cap, stat: 'routes ' + rs.length + ' · total distance ' + cost(I, rs).toFixed(1) + (k === frames.length ? ' · no feasible link left, construction finished' : '') };
    }
    Z.player(root, { n: frames.length, W, H, ms: 850, alt: 'Clarke–Wright savings algorithm on a 12-customer toy instance', label: 'Savings step', frame });
  }

  /* ---------------------------------------------------------------- sweep */
  function sweepDemo(root) {
    const I = V.generate(12, 1, 7, { grid: 100, capacity: 60 }), Q = I.Q[0], g = geom(I), dep = g.P[I.n];
    const tr = {}; V.sweep(I, tr);
    const ev = tr.events, start = tr.start, R = 70 * 1.0;
    const nm = c => String(c + 1);
    function frame(k) {
      const groups = [];
      for (let q = 0; q < k; q++) { if (ev[q].newRoute) groups.push([]); groups[groups.length - 1].push(ev[q].c); }
      const theta = start + (k ? ev[k - 1].ang : 0);
      const tip = [g.f.X(I.x[I.n] + R * Math.cos(theta)), g.f.Y(I.y[I.n] + R * Math.sin(theta))];
      const swept = new Map(); groups.forEach((r, q) => r.forEach(c => swept.set(c, q)));
      let s = Z.seg(dep, tip, 'stroke:var(--accent);stroke-width:1.6;stroke-dasharray:6 4');
      groups.forEach((r, q) => {
        const open = q === groups.length - 1 && k < ev.length;
        s += Z.poly([dep].concat(r.map(c => g.P[c]), open ? [] : [dep]), 'stroke:' + Z.col(q) + ';stroke-width:2.2');
        if (open) s += Z.seg(g.P[r[r.length - 1]], dep, 'stroke:' + Z.col(q) + ';stroke-width:1.2;stroke-dasharray:3 4;opacity:.7');
      });
      for (let c = 0; c < I.n; c++) {
        const q = swept.get(c);
        s += Z.dot(g.P[c], 5.5, q === undefined ? 'var(--panel)' : Z.col(q)) + Z.label(g.P[c], nm(c) + ' (' + I.dem[c] + ')', 7, -7, 'fill:var(--ink)');
      }
      if (k) s += Z.ring(g.P[ev[k - 1].c], 9, 'var(--accent)');
      s += Z.depotMark(dep, 6, 'depot');
      const deg = a => Math.round(a * 180 / Math.PI);
      let cap;
      if (!k) cap = 'Start: a ray from the depot at the starting angle (' + deg(start) + '°, measured counter-clockwise from east). The ray turns counter-clockwise; customers are visited in the order it meets them, and a route is closed when the next customer no longer fits (Q = ' + Q + ').';
      else {
        const e = ev[k - 1], last = groups[groups.length - 1], prev = groups[groups.length - 2];
        cap = 'Customer ' + nm(e.c) + ' at ' + deg(e.ang) + '° from the start: ' + (e.newRoute
          ? (k === 1 ? 'first route opened.' : 'adding it to route ' + (groups.length - 1) + ' would exceed Q (load ' + load(I, prev) + ' + ' + I.dem[e.c] + ' > ' + Q + '), so that route is closed and a new one is opened.')
          : 'added to the current route (load ' + load(I, last) + ' ≤ ' + Q + ').');
      }
      return { svg: s, cap, stat: groups.length + ' route' + (groups.length === 1 ? '' : 's') + ' so far' + (k === ev.length ? ' · all customers swept; the solver tries 12 start angles and keeps the cheapest result' : '') };
    }
    Z.player(root, { n: ev.length, W, H, ms: 700, alt: 'Sweep construction on a 12-customer toy instance', label: 'Sweep step', frame });
  }

  /* ---------------------------------------------------------------- live ruin & recreate */
  function rrDemo(root) {
    const I = V.generate(32, 1, 5, { grid: 100, routeSize: 6 }), g = geom(I, 18), dep = g.P[I.n];
    const init = V.savings(I), ITERS = 4000;
    root.classList.add('anim');
    root.innerHTML = '<div class="figctl animctl"><button type="button" class="secondary" data-a="reset">↺ Reset</button><button type="button" class="secondary" data-a="step">Step ▸</button>' +
      '<button type="button" data-a="play">▶ Play</button><label class="small">speed <select data-a="speed" aria-label="Speed"><option value="slow">slow</option><option value="normal" selected>normal</option><option value="fast">fast</option><option value="turbo">turbo</option></select></label></div>' +
      '<svg class="main" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Live ruin and recreate on a 32-customer toy instance"></svg>' +
      '<p class="animcap"></p><svg class="spark" viewBox="0 0 ' + W + ' 80" role="img" aria-label="Current and best cost per iteration"></svg><p class="animstat small"></p>';
    const svg = root.querySelector('svg.main'), spark = root.querySelector('svg.spark'), cap = root.querySelector('.animcap'), stat = root.querySelector('.animstat'),
      play = root.querySelector('[data-a=play]'), speed = root.querySelector('[data-a=speed]');
    let S, cur, best, phase, before, mv, timer = null;

    function reset() {
      pause(); S = V.createSearch(I, init, { mode: 'sisr', iters: ITERS, seed: 3, trace: true });
      const c0 = V.solCost(I, init); cur = [c0]; best = [c0]; phase = 'start'; before = null; mv = null; draw();
    }
    function iterate() {
      before = V.copySol(S.current); const c0 = V.solCost(I, before); S.step(1); mv = S.lastMove; mv.c0 = c0;
      cur.push(V.solCost(I, S.current)); best.push(S.bestCost);
    }
    function routesSvg(routes, gone, ringCol, dashed) {
      const cen = routes.map(r => [r.nodes.reduce((a, c) => a + g.P[c][0], 0) / r.nodes.length, r.nodes.reduce((a, c) => a + g.P[c][1], 0) / r.nodes.length]);
      const rank = Z.colourRank(cen, dep[0], dep[1]);
      let s = '';
      routes.forEach((r, q) => {
        const seq = [I.n].concat(r.nodes, [I.n]);
        for (let a = 0; a + 1 < seq.length; a++) {
          const bad = dashed && gone && (gone.has(seq[a]) || gone.has(seq[a + 1]));
          s += Z.seg(g.P[seq[a]], g.P[seq[a + 1]], bad ? 'stroke:var(--bad);stroke-width:1.4;stroke-dasharray:4 3;opacity:.85' : 'stroke:' + Z.col(rank[q]) + ';stroke-width:2');
        }
      });
      for (let c = 0; c < I.n; c++) s += Z.dot(g.P[c], 3.6);
      if (gone) gone.forEach(c => { s += Z.ring(g.P[c], 7.5, ringCol); });
      return s + Z.depotMark(dep, 5.5);
    }
    function sparkSvg() {
      const n = cur.length, all = cur.concat(best), lo = Math.min.apply(null, all), hi = Math.max.apply(null, all), pad = 8, h = 80, w = W;
      const X = i => pad + (w - 2 * pad) * i / ITERS, Y = v => h - pad - (h - 2 * pad) * (v - lo) / Math.max(1e-9, hi - lo);
      const stepN = Math.max(1, Math.floor(n / 360)), pc = [], pb = [];
      for (let i = 0; i < n; i += stepN) { pc.push([X(i), Y(cur[i])]); pb.push([X(i), Y(best[i])]); }
      pc.push([X(n - 1), Y(cur[n - 1])]); pb.push([X(n - 1), Y(best[n - 1])]);
      return '<line x1="' + pad + '" y1="' + (h - pad) + '" x2="' + (w - pad) + '" y2="' + (h - pad) + '" style="stroke:var(--line)"/>' +
        Z.poly(pc, 'stroke:var(--muted);stroke-width:1;opacity:.7') + Z.poly(pb, 'stroke:var(--accent);stroke-width:2') +
        '<text x="' + pad + '" y="11" style="font-size:9.5px;fill:var(--muted)">cost per iteration: current (grey), best (blue); axis = 0…' + ITERS + ' iterations</text>';
    }
    function draw() {
      const done = S.iter >= ITERS;
      let s, c;
      if (phase === 'start') { s = routesSvg(S.current.routes); c = 'Start: the savings solution. Each iteration (1) removes several strings of adjacent customers (ruin), (2) greedily reinserts them with random "blinks" (recreate) and (3) accepts the result by a simulated-annealing rule. Toy instance, 32 customers; this is an illustration, not a benchmark.'; }
      else if (phase === 'ruin') { s = routesSvg(before.routes, new Set(mv.removed), 'var(--bad)', true); c = 'Iteration ' + mv.iter + ' · ruin: ' + mv.removed.length + ' customers (red rings) are removed; their edges are shown dashed.'; }
      else if (phase === 'recreate') {
        const d = mv.candCost - mv.c0;
        s = routesSvg(mv.cand, new Set(mv.removed), mv.accepted ? 'var(--ok)' : 'var(--bad)', false);
        c = 'Iteration ' + mv.iter + ' · recreate: the removed customers are reinserted (ringed). Candidate ' + mv.candCost.toFixed(1) + ' vs current ' + mv.c0.toFixed(1) + ' (Δ = ' + (d >= 0 ? '+' : '−') + Math.abs(d).toFixed(1) + ') → ' +
          (mv.accepted ? 'accepted' : 'rejected') + ' (temperature ' + mv.T.toFixed(2) + (mv.accepted && d > 0 ? '; a worse solution can be accepted while T is high' : '') + ').';
      } else { s = routesSvg(S.current.routes); c = 'Fast mode: only the current solution is drawn.'; }
      svg.innerHTML = s; cap.textContent = done ? 'Iteration budget (' + ITERS + ') used up. Press Reset to start again.' : c; spark.innerHTML = sparkSvg();
      stat.textContent = 'iteration ' + S.iter + ' / ' + ITERS + ' · current ' + cur[cur.length - 1].toFixed(1) + ' · best ' + best[best.length - 1].toFixed(1);
      play.textContent = timer ? '❚❚ Pause' : '▶ Play';
    }
    function advance() {                                     // one visual phase; returns the delay before the next one
      const sp = speed.value;
      if (S.iter >= ITERS) { pause(); return 0; }
      if (sp === 'turbo') { for (let q = 0; q < 25 && S.iter < ITERS; q++) iterate(); phase = 'plain'; draw(); return 60; }
      if (sp === 'fast') { iterate(); phase = 'recreate'; draw(); return 140; }
      if (phase === 'ruin') { phase = 'recreate'; draw(); return sp === 'slow' ? 1300 : 700; }
      iterate(); phase = 'ruin'; draw(); return sp === 'slow' ? 1300 : 700;
    }
    function loop() { const d = advance(); if (timer && d) timer = setTimeout(loop, d); }
    function pause() { if (timer) { clearTimeout(timer); timer = null; } play.textContent = '▶ Play'; }
    play.addEventListener('click', () => { if (timer) { pause(); return; } if (S.iter >= ITERS) reset(); timer = setTimeout(loop, 0); play.textContent = '❚❚ Pause'; });
    root.querySelector('[data-a=step]').addEventListener('click', () => { pause(); if (S.iter >= ITERS) reset(); if (phase === 'ruin') { phase = 'recreate'; draw(); } else { iterate(); phase = 'ruin'; draw(); } });
    root.querySelector('[data-a=reset]').addEventListener('click', reset);
    reset();
    root._demo = { reset, pause, get S() { return S; }, get phase() { return phase; } };
  }

  document.querySelectorAll('[data-anim]').forEach(el => {
    const t = el.dataset.anim;
    if (t === 'savings') savingsDemo(el); else if (t === 'sweep') sweepDemo(el); else if (t === 'rr') rrDemo(el);
  });
})();

/* Animated before/after diagrams of the local-search operators.
 *
 * The "after" route lists are written out from each operator's definition (the e2e test checks that every figure
 * keeps each customer exactly once and that only the intended edges change).  One SVG shows the edges of both solutions; a time
 * parameter t in [0,1] morphs between them:
 *   0.00-0.12  current routes
 *   0.12-0.32  the edges the move removes turn red (dashed)
 *   0.32-0.52  they fade out
 *   0.55-0.83  the edges the move adds are drawn (green)
 *   0.88-1.00  they take the colour of their new route
 * Route 1 = blue, route 2 = orange, customers = gold, depots = black squares, ringed = customers whose edges change.
 * Controls: play / pause / replay, and a slider to scrub. Autoplays once when scrolled into view (not with
 * prefers-reduced-motion). */
(function () {
  'use strict';
  const SD = { D1: [26, 85],
    a1: [78, 38], a2: [128, 28], a3: [178, 40], a4: [228, 30], a5: [276, 46],
    b1: [78, 132], b2: [128, 142], b3: [178, 130], b4: [228, 140], b5: [276, 124] };
  const MD = { D1: [160, 14], D2: [160, 156],
    a1: [50, 50], a2: [105, 42], a3: [160, 60], a4: [215, 42], a5: [270, 50],
    b1: [50, 120], b2: [105, 128], b3: [160, 108], b4: [215, 128], b5: [270, 120] };
  const A = ['a1', 'a2', 'a3', 'a4', 'a5'], B = ['b1', 'b2', 'b3', 'b4', 'b5'];
  const R = (d, nodes, cls) => ({ d, nodes, cls });
  const sdBase = () => [R('D1', A.slice(), 'r1'), R('D1', B.slice(), 'r2')];
  const mdBase = () => [R('D1', A.slice(), 'r1'), R('D2', B.slice(), 'r2')];
  const ins = (arr, i, items) => arr.slice(0, i).concat(items, arr.slice(i));

  const FIGS = {
    relocate: { pos: SD, over: { a3: [178, 84] }, before: sdBase,
      after: r => [R('D1', ['a1', 'a2', 'a4', 'a5'], 'r1'), R('D1', ins(B, 3, ['a3']), 'r2')] },
    oropt: { pos: SD, over: { a2: [120, 84], a3: [150, 86] }, before: sdBase,
      after: r => [R('D1', ['a1', 'a4', 'a5'], 'r1'), R('D1', ins(B, 3, ['a3', 'a2']), 'r2')] },   // segment (a2,a3) reversed
    swap: { pos: SD, over: { a3: [178, 70], b3: [178, 100] }, before: sdBase,
      after: r => [R('D1', ['a1', 'a2', 'b3', 'a4', 'a5'], 'r1'), R('D1', ['b1', 'b2', 'a3', 'b4', 'b5'], 'r2')] },
    cross: { pos: SD, over: { a2: [150, 68], a3: [200, 68], b3: [150, 102], b4: [200, 102] }, before: sdBase,
      after: r => [R('D1', ['a1', 'b3', 'b4', 'a4', 'a5'], 'r1'), R('D1', ['b1', 'b2', 'a2', 'a3', 'b5'], 'r2')] },
    // the route before the move crosses itself; reversing the segment a4..a2 removes the crossing
    twoopt: { pos: SD, before: () => [R('D1', ['a1', 'a4', 'a3', 'a2', 'a5'], 'r1')],
      after: r => [R('D1', ['a1', 'a2', 'a3', 'a4', 'a5'], 'r1')] },
    twooptstar: { pos: SD, before: sdBase,
      after: r => [R('D1', ['a1', 'a2', 'a3', 'b4', 'b5'], 'r1'), R('D1', ['b1', 'b2', 'b3', 'a4', 'a5'], 'r2')] },
    twooptstarrev: { pos: SD, before: sdBase,
      after: r => [R('D1', ['a1', 'a2', 'a3', 'b3', 'b2', 'b1'], 'r1'), R('D1', ['a5', 'a4', 'b4', 'b5'], 'r2')] },
    swapstar: { pos: SD, over: { a3: [178, 68], b3: [178, 100] }, before: sdBase,
      after: r => [R('D1', ['a1', 'b3', 'a2', 'a4', 'a5'], 'r1'), R('D1', ['b1', 'b2', 'b4', 'a3', 'b5'], 'r2')] },
    mdrelocate: { pos: MD, over: { a3: [160, 84] }, before: mdBase,
      after: r => [R('D1', ['a1', 'a2', 'a4', 'a5'], 'r1'), R('D2', ins(B, 3, ['a3']), 'r2')] },
    routedepot: { pos: MD, over: { a1: [60, 96], a2: [110, 92], a3: [160, 98], a4: [210, 92], a5: [260, 96] }, before: mdBase,
      after: r => [R('D2', A.slice(), 'r1'), R('D2', B.slice(), 'r2')] },
    depotswap: { pos: MD, over: { a1: [60, 54], a2: [110, 66], a3: [160, 70], a4: [210, 66], a5: [260, 54], b1: [60, 116], b2: [110, 104], b3: [160, 100], b4: [210, 104], b5: [260, 116] },
      before: mdBase, after: r => [R('D2', A.slice(), 'r1'), R('D1', B.slice(), 'r2')] },
    newroute: { pos: MD, over: { a3: [160, 104], b1: [50, 126], b2: [105, 134], b4: [215, 134], b5: [270, 126] },
      before: () => [R('D1', A.slice(), 'r1'), R('D2', ['b1', 'b2', 'b4', 'b5'], 'r2')],
      after: r => [R('D1', ['a1', 'a2', 'a4', 'a5'], 'r1'), R('D2', ['b1', 'b2', 'b4', 'b5'], 'r2'), R('D2', ['a3'], 'r2')] },
  };

  const edgeKey = (a, b) => (a < b ? a + '|' + b : b + '|' + a);
  function edgeMap(routes) {
    const m = new Map();
    routes.forEach(r => {
      const q = [r.d].concat(r.nodes, [r.d]);
      for (let i = 0; i + 1 < q.length; i++) { const k = edgeKey(q[i], q[i + 1]); if (!m.has(k)) m.set(k, { a: q[i], b: q[i + 1], cls: r.cls }); }
    });
    return m;
  }
  const clamp01 = x => Math.max(0, Math.min(1, x));
  const reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const CAPS = [[0.12, 'current routes'], [0.32, 'the move removes these edges'], [0.55, 'removed'], [0.88, 'and adds these edges'], [1.01, 'resulting routes']];

  function build(el) {
    const f = FIGS[el.dataset.fig]; if (!f) return;
    const pos = Object.assign({}, f.pos, f.over || {});
    const b = f.before(), a = f.after(b), eb = edgeMap(b), ea = edgeMap(a);
    const used = new Set(); b.concat(a).forEach(r => { used.add(r.d); r.nodes.forEach(n => used.add(n)); });
    const edges = [];
    eb.forEach((v, k) => edges.push({ a: v.a, b: v.b, cls: v.cls, kind: ea.has(k) ? 'keep' : 'gone' }));
    ea.forEach((v, k) => { if (!eb.has(k)) edges.push({ a: v.a, b: v.b, cls: v.cls, kind: 'new' }); });
    const order = { keep: 0, gone: 1, new: 2 }; edges.sort((p, q) => order[p.kind] - order[q.kind]);
    const moved = new Set(); edges.forEach(e => { if (e.kind !== 'keep') [e.a, e.b].forEach(n => { if (n[0] !== 'D') moved.add(n); }); });

    let svg = '<svg viewBox="0 0 330 172" role="img" aria-label="Animated before and after diagram of the move">';
    edges.forEach((e, i) => {
      const p = pos[e.a], q = pos[e.b];
      svg += '<line data-e="' + i + '" class="' + e.cls + '" x1="' + p[0] + '" y1="' + p[1] + '" x2="' + q[0] + '" y2="' + q[1] + '" stroke-width="' + (e.kind === 'keep' ? 1.8 : 2.6) + '" stroke-linecap="round"' + (e.kind === 'new' ? ' opacity="0"' : '') + '/>';
    });
    Object.keys(pos).forEach(k => {
      if (!used.has(k)) return;
      const p = pos[k];
      if (k[0] === 'D') svg += '<rect class="depot" x="' + (p[0] - 6) + '" y="' + (p[1] - 6) + '" width="12" height="12"/><text x="' + (p[0] + 9) + '" y="' + (p[1] + 4) + '">' + k + '</text>';
      else svg += (moved.has(k) ? '<circle data-ring="1" class="ring" cx="' + p[0] + '" cy="' + p[1] + '" r="9" opacity="0"/>' : '') + '<circle class="cust" cx="' + p[0] + '" cy="' + p[1] + '" r="5"/><text x="' + (p[0] - 6) + '" y="' + (p[1] - 9) + '" style="font-size:9px">' + k + '</text>';
    });
    svg += '</svg>';
    el.innerHTML = '<div class="figctl"><button type="button" class="play secondary" aria-label="Play animation">▶ Play</button>' +
      '<input type="range" min="0" max="1000" value="0" aria-label="Animation position"><span class="cap small">current routes</span></div>' + svg;

    const lines = [...el.querySelectorAll('line')], rings = [...el.querySelectorAll('[data-ring]')];
    const lens = edges.map(e => Math.hypot(pos[e.a][0] - pos[e.b][0], pos[e.a][1] - pos[e.b][1]));
    const btn = el.querySelector('.play'), rng = el.querySelector('input'), cap = el.querySelector('.cap');
    let t = 0, running = false, t0 = 0;
    const DUR = 4200;

    function setT(x) {
      t = clamp01(x); rng.value = Math.round(t * 1000);
      const fade = clamp01((t - 0.32) / 0.2), draw = clamp01((t - 0.55) / 0.28), settle = t >= 0.9;
      edges.forEach((e, i) => {
        const ln = lines[i];
        if (e.kind === 'gone') {
          ln.setAttribute('class', t < 0.12 ? e.cls : 'gone'); ln.setAttribute('opacity', String(1 - fade)); ln.setAttribute('stroke-width', t < 0.12 ? '1.8' : '2.6');
        } else if (e.kind === 'new') {
          ln.setAttribute('class', settle ? e.cls : 'fresh'); ln.setAttribute('opacity', draw > 0 ? '1' : '0');
          ln.setAttribute('stroke-dasharray', draw < 1 ? lens[i] + ' ' + lens[i] : 'none'); ln.setAttribute('stroke-dashoffset', String(lens[i] * (1 - draw)));
        }
      });
      rings.forEach(c => c.setAttribute('opacity', t > 0.08 && t < 0.9 ? '1' : '0'));
      cap.textContent = CAPS.find(c => t < c[0])[1];
      btn.textContent = running ? '❚❚ Pause' : t >= 1 ? '↺ Replay' : '▶ Play';
    }
    function frame(now) {
      if (!running) return;
      setT((now - t0) / DUR);
      if (t >= 1) { running = false; setT(1); return; }
      requestAnimationFrame(frame);
    }
    function play() { if (t >= 1) t = 0; running = true; t0 = performance.now() - t * DUR; requestAnimationFrame(frame); setT(t); }
    function pause() { running = false; setT(t); }
    btn.addEventListener('click', () => (running ? pause() : play()));
    rng.addEventListener('input', () => { running = false; setT(rng.value / 1000); });
    setT(0);
    if (!reduced && 'IntersectionObserver' in window) {
      const io = new IntersectionObserver(es => { if (es.some(x => x.isIntersecting)) { io.disconnect(); play(); } }, { threshold: 0.7 });
      io.observe(el);
    }
    el._figure = { setT, play, pause, edges, before: b, after: a, get t() { return t; } };
  }
  document.querySelectorAll('.fig').forEach(build);
})();

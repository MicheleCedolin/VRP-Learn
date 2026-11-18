/* Interactive explorers of the two mathematical models of learn.html (sections 1.1 and 3.1).
 * Each view highlights one family of constraints on a small fixed instance, so that a reader can see what the
 * formula says.  The instances are tiny and hand-made; nothing here is a computational result. */
(function () {
  'use strict';
  const Z = window.VRPViz; if (!Z) return;
  const W = 360, H = 300;
  const OK = 'var(--ok)', BAD = 'var(--bad)', MUT = 'var(--muted)';
  const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const tag = (txt, color) => '<span style="color:' + color + ';font-weight:600">' + txt + '</span>';
  // plain-text captions use x_ij / x_{3,7} notation; render the subscripts
  const subs = t => t.replace(/([A-Za-z])_\{([^}]+)\}/g, '$1<sub>$2</sub>').replace(/([A-Za-z])_([a-z0-9]{1,2})\b/g, '$1<sub>$2</sub>');

  function shell(root, views, alt) {
    root.classList.add('anim', 'explorer');
    root.innerHTML = '<div class="seg small" role="group" aria-label="View">' + views.map(v => '<button type="button" data-v="' + v.id + '">' + v.label + '</button>').join('') + '</div>' +
      '<div class="expctl"></div><svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + alt + '"></svg><p class="animcap"></p><p class="formula"></p>';
    const api = { svg: root.querySelector('svg'), ctl: root.querySelector('.expctl'), cap: root.querySelector('.animcap'), fml: root.querySelector('.formula'), view: null, raf: 0, st: {} };
    api.out = (svg, cap, fml) => { api.svg.innerHTML = svg; api.cap.innerHTML = subs(cap); api.fml.innerHTML = fml; };
    api.stop = () => { if (api.raf) { cancelAnimationFrame(api.raf); api.raf = 0; } };
    api.slider = (id, text, min, max, val, on) => {             // adds a labelled range input to the control row
      const l = document.createElement('label'); l.className = 'small sl';
      l.innerHTML = text + ' <input type="range" min="' + min + '" max="' + max + '" value="' + val + '" aria-label="' + id + '"> <output>' + val + '</output>';
      const inp = l.querySelector('input'), o = l.querySelector('output');
      inp.addEventListener('input', () => { o.textContent = inp.value; on(+inp.value); }); api.ctl.appendChild(l); return inp;
    };
    api.buttons = (items, cur, on, cls) => {
      const d = document.createElement('div'); d.className = 'seg small ' + (cls || '');
      d.innerHTML = items.map(it => '<button type="button" data-k="' + it[0] + '"' + (it[0] === cur ? ' class="on"' : '') + '>' + it[1] + '</button>').join('');
      d.addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; d.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b)); on(b.dataset.k); });
      api.ctl.appendChild(d); return d;
    };
    function setView(id) {
      api.stop(); api.view = id; api.ctl.innerHTML = '';
      root.querySelectorAll('.seg > button[data-v]').forEach(b => b.classList.toggle('on', b.dataset.v === id));
      views.find(v => v.id === id).init(api);
    }
    root.querySelector('.seg').addEventListener('click', e => { const b = e.target.closest('button[data-v]'); if (b) setView(b.dataset.v); });
    api.setView = setView; setView(views[0].id);
    root._explorer = api; return api;
  }

  /* ================================================================ CVRP (section 1.1) */
  function cvrpExplorer(root) {
    const cust = [[20, 70, 8], [35, 88, 6], [15, 45, 7], [30, 22, 9], [60, 15, 5], [82, 35, 7], [88, 66, 6], [66, 82, 8]], dep = [50, 52];
    const routes = [[2, 0, 1], [3, 4], [5, 6, 7]], Q0 = 22, K = routes.length;
    const xs = cust.map(c => c[0]).concat([dep[0]]), ys = cust.map(c => c[1]).concat([dep[1]]);
    const mk = (hh, pad) => { const f = Z.fitter(xs, ys, W, hh, pad); return { c: cust.map(c => [f.X(c[0]), f.Y(c[1])]), d: [f.X(dep[0]), f.Y(dep[1])] }; };
    const PF = mk(H, 28), PT = mk(205, 24);
    const dpos = i => (i < 0 ? dep : cust[i]), dist = (a, b) => Math.round(Math.hypot(dpos(a)[0] - dpos(b)[0], dpos(a)[1] - dpos(b)[1]));
    const pp = (P, i) => (i < 0 ? P.d : P.c[i]), nm = i => (i < 0 ? '0' : String(i + 1));
    const seq = r => [-1].concat(r, [-1]);
    const arcs = rs => { const a = []; rs.forEach((r, q) => { const s = seq(r); for (let i = 0; i + 1 < s.length; i++) a.push({ a: s[i], b: s[i + 1], r: q }); }); return a; };
    const nodes = (P, o) => {
      o = o || {}; let s = '';
      cust.forEach((c, i) => { const p = P.c[i]; s += Z.dot(p, 6, o.fill ? o.fill(i) : null) + Z.label(p, String(i + 1), 8, -8, 'font-weight:600;fill:var(--ink)') + (o.q ? Z.label(p, 'q=' + c[2], 8, 11, 'fill:var(--muted);font-size:8.5px') : ''); if (o.ring && o.ring.has(i)) s += Z.ring(p, 10, o.ringCol || 'var(--accent)'); });
      return s + Z.depotMark(P.d, 6, '0');
    };
    const baseArcs = (P, rs, f) => arcs(rs).map(a => { const st = f ? f(a) : { color: Z.col(a.r), w: 2 }; return Z.arrow(pp(P, a.a), pp(P, a.b), st.color, st.w, st.dash); }).join('');
    const mid = (P, a, b, dy) => { const p = pp(P, a), q = pp(P, b); return [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2 + (dy || 0)]; };
    const routeLoad = r => r.reduce((a, i) => a + cust[i][2], 0);
    const total = rs => arcs(rs).reduce((a, x) => a + dist(x.a, x.b), 0);

    const views = [
      { id: 'obj', label: 'Objective', init(api) {
        const a = arcs(routes); let s = baseArcs(PF, routes);
        a.forEach(x => { const m = mid(PF, x.a, x.b, -3); s += '<rect x="' + (m[0] - 9) + '" y="' + (m[1] - 8) + '" width="18" height="12" rx="3" style="fill:var(--panel);opacity:.9"/>' + Z.label(m, String(dist(x.a, x.b)), -6, 1, 'fill:var(--ink);font-size:9px'); });
        const per = routes.map(r => total([r]));
        api.out(s + nodes(PF), 'Every arc that is used (x_ij = 1) contributes its cost c_ij, written on the arc; the objective is the sum over all arcs, including the arcs that leave and enter the depot 0.',
          'Σ c' + '<sub>ij</sub>' + ' x' + '<sub>ij</sub>' + ' = ' + per.map((v, q) => 'route ' + (q + 1) + ': ' + v).join(' + ') + ' = <b>' + per.reduce((x, y) => x + y, 0) + '</b>');
      } },
      { id: 'inout', label: 'One in, one out', init(api) {
        const draw = c => {
          const s0 = routes.find(r => r.includes(c)), ix = s0.indexOf(c), pred = ix === 0 ? -1 : s0[ix - 1], succ = ix === s0.length - 1 ? -1 : s0[ix + 1];
          const s = baseArcs(PF, routes, a => (a.a === pred && a.b === c ? { color: OK, w: 3.6 } : a.a === c && a.b === succ ? { color: 'var(--c2)', w: 3.6 } : { color: MUT, w: 1.2, dash: '3 3' })) + nodes(PF, { ring: new Set([c]) });
          api.out(s, 'Customer ' + (c + 1) + ' is entered by exactly one arc (green) and left by exactly one arc (orange). Choose another customer to see the same for it. The depot is the only node that may have several outgoing arcs (next view).',
            'Σ<sub>j</sub> x<sub>' + (c + 1) + ',j</sub> = x<sub>' + (c + 1) + ',' + nm(succ) + '</sub> = 1   (one successor)<br>Σ<sub>i</sub> x<sub>i,' + (c + 1) + '</sub> = x<sub>' + nm(pred) + ',' + (c + 1) + '</sub> = 1   (one predecessor)');
        };
        api.buttons(cust.map((c, i) => [String(i), String(i + 1)]), '1', k => draw(+k)); draw(1);
      } },
      { id: 'fleet', label: 'Fleet size', init(api) {
        const draw = m => {
          const ok = K <= m, out = routes.map(r => r[0]);
          const s = baseArcs(PF, routes, a => (a.a === -1 ? { color: ok ? OK : BAD, w: 3.6 } : { color: MUT, w: 1.2, dash: '3 3' })) + nodes(PF);
          api.out(s, 'Each route leaves the depot exactly once, so the number of routes equals the number of arcs leaving the depot (thick). With m vehicles at most m routes may be used' + (ok ? '.' : '; this solution needs ' + K + ', so it is infeasible for m = ' + m + '.'),
            'Σ<sub>j</sub> x<sub>0j</sub> = ' + out.length + ' ' + (ok ? tag('≤ m = ' + m + ' ✓', OK) : tag('> m = ' + m + ' ✗', BAD)));
        };
        api.slider('m', 'fleet size m', 1, 5, K, draw); draw(K);
      } },
      { id: 'load', label: 'Load & capacity', init(api) {
        const st = api.st; st.route = st.route || 0; st.Q = Q0;
        const draw = (prog) => {
          const r = routes[st.route], s0 = seq(r), cum = []; let u = 0; r.forEach(i => { u += cust[i][2]; cum.push(u); });
          const bad = cum.some(v => v > st.Q), col = Z.col(st.route);
          let s = baseArcs(PT, routes, a => (a.r === st.route ? { color: bad ? BAD : col, w: 3 } : { color: MUT, w: 1, dash: '3 3' })) + nodes(PT, { q: true, ring: new Set(r), ringCol: bad ? BAD : col });
          // truck
          const pts = s0.map(i => pp(PT, i)), L = [0]; for (let i = 1; i < pts.length; i++) L.push(L[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
          const dpos2 = prog * L[L.length - 1]; let seg = 1; while (seg < L.length - 1 && L[seg] < dpos2) seg++;
          const t = (dpos2 - L[seg - 1]) / Math.max(1e-9, L[seg] - L[seg - 1]), tp = [pts[seg - 1][0] + (pts[seg][0] - pts[seg - 1][0]) * t, pts[seg - 1][1] + (pts[seg][1] - pts[seg - 1][1]) * t];
          const reached = Math.max(0, Math.min(r.length, seg - 1 + (t > 0.98 ? 1 : 0)));        // customers already served
          const onboard = reached ? cum[reached - 1] : 0;
          s += '<rect x="' + (tp[0] - 7) + '" y="' + (tp[1] - 5) + '" width="14" height="10" rx="2" style="fill:var(--accent);stroke:var(--ink);stroke-width:.8"/>' + Z.label(tp, 'u=' + onboard, -10, -9, 'fill:var(--accent);font-weight:700;font-size:10px');
          // bars u_i versus Q
          const y0 = 280, sc = 50 / 30, bw = 38, x0 = 40;
          s += '<line x1="30" y1="' + y0 + '" x2="' + (W - 20) + '" y2="' + y0 + '" style="stroke:var(--line)"/>';
          r.forEach((i, q) => { const h = cum[q] * sc, x = x0 + q * (bw + 22), over = cum[q] > st.Q; s += '<rect x="' + x + '" y="' + (y0 - h) + '" width="' + bw + '" height="' + h + '" style="fill:' + (over ? BAD : col) + ';opacity:' + (q < reached ? 1 : .35) + '"/>' + Z.label([x, y0 - h], 'u' + (i + 1) + ' = ' + cum[q], 2, -3, 'fill:var(--ink);font-size:9.5px') + Z.label([x, y0], 'customer ' + (i + 1), 2, 10, 'fill:var(--muted);font-size:8.5px'); });
          s += '<line x1="30" y1="' + (y0 - st.Q * sc) + '" x2="' + (W - 20) + '" y2="' + (y0 - st.Q * sc) + '" style="stroke:var(--ink);stroke-dasharray:5 3"/>' + Z.label([W - 20, y0 - st.Q * sc], 'Q = ' + st.Q, -48, -4, 'fill:var(--ink);font-weight:700');
          api.svg.innerHTML = s;
          api.cap.innerHTML = subs('The truck serves route ' + (st.route + 1) + ' and its load u rises by q_i at every customer (bars: cumulative load after customer i). The capacity constraint q_i ≤ u_i ≤ Q holds only while no bar crosses the dashed line' + (bad ? ' — here it is violated.' : '.'));
          api.fml.innerHTML = 'u<sub>j</sub> ≥ u<sub>i</sub> + q<sub>j</sub> − Q(1 − x<sub>ij</sub>) ⇒ u = ' + cum.join(', ') + ' &nbsp; ' + (bad ? tag('max u = ' + Math.max.apply(null, cum) + ' > Q = ' + st.Q + ' ✗', BAD) : tag('max u = ' + Math.max.apply(null, cum) + ' ≤ Q = ' + st.Q + ' ✓', OK));
        };
        let p = 0, last = 0; const loop = now => { if (!last) last = now; p = (p + (now - last) / 6000) % 1; last = now; draw(p); api.raf = requestAnimationFrame(loop); };
        const redraw = () => { if (!api.raf) draw(p); };
        api.buttons(routes.map((r, q) => [String(q), 'Route ' + (q + 1)]), String(st.route), k => { st.route = +k; p = 0; redraw(); });
        api.slider('Q', 'capacity Q', 14, 30, Q0, v => { st.Q = v; redraw(); });
        const pl = document.createElement('button'); pl.type = 'button'; pl.className = 'secondary'; pl.textContent = reduce ? '▶ Animate truck' : '❚❚ Pause truck';
        pl.addEventListener('click', () => { if (api.raf) { api.stop(); pl.textContent = '▶ Animate truck'; last = 0; } else { last = 0; api.raf = requestAnimationFrame(loop); pl.textContent = '❚❚ Pause truck'; } });
        api.ctl.appendChild(pl);
        draw(reduce ? 0.999 : 0); if (!reduce) api.raf = requestAnimationFrame(loop);
      } },
      { id: 'subtour', label: 'Sub-tours', init(api) {
        const cyc = [5, 6, 7], good = routes, badr = [routes[0], routes[1]];
        const draw = k => {
          if (k === 'ok') { api.out(baseArcs(PF, good) + nodes(PF), 'A valid solution: every route starts and ends at the depot.', 'x satisfies all constraints ' + tag('✓', OK)); return; }
          let s = baseArcs(PF, badr);
          for (let i = 0; i < 3; i++) s += Z.arrow(PF.c[cyc[i]], PF.c[cyc[(i + 1) % 3]], BAD, 3);
          api.out(s + nodes(PF, { ring: new Set(cyc), ringCol: BAD }),
            'Every customer still has exactly one successor and one predecessor, but customers 6, 7, 8 form a cycle that never touches the depot. The load inequalities rule this out: adding them around the cycle gives 0 ≥ q6 + q7 + q8, which is impossible.',
            'u<sub>7</sub> ≥ u<sub>6</sub> + ' + cust[6][2] + ', &nbsp; u<sub>8</sub> ≥ u<sub>7</sub> + ' + cust[7][2] + ', &nbsp; u<sub>6</sub> ≥ u<sub>8</sub> + ' + cust[5][2] + ' ⇒ 0 ≥ ' + (cust[5][2] + cust[6][2] + cust[7][2]) + ' ' + tag('✗ (sub-tour cut off)', BAD));
        };
        api.buttons([['ok', 'Valid solution'], ['bad', 'With a sub-tour']], 'ok', draw); draw('ok');
      } },
    ];
    shell(root, views, 'Interactive explorer of the capacitated VRP model on an 8-customer toy instance');
  }

  /* ================================================================ MDVRP (section 3.1) */
  function mdExplorer(root) {
    const dps = [[24, 50], [76, 50]];
    const cust = [[12, 25, 6], [28, 14, 8], [38, 32, 5], [12, 74, 7], [28, 86, 6], [40, 66, 9], [64, 30, 7], [80, 14, 6], [90, 34, 8], [66, 72, 6], [86, 82, 7]];
    const routes = [{ d: 0, r: [0, 1, 2] }, { d: 0, r: [3, 4, 5] }, { d: 1, r: [6, 7, 8] }, { d: 1, r: [9, 10] }];
    const xs = cust.map(c => c[0]).concat(dps.map(d => d[0])), ys = cust.map(c => c[1]).concat(dps.map(d => d[1]));
    const f = Z.fitter(xs, ys, W, H, 26), PC = cust.map(c => [f.X(c[0]), f.Y(c[1])]), PD = dps.map(d => [f.X(d[0]), f.Y(d[1])]);
    const DC = ['var(--c1)', 'var(--c2)'];
    const dist = (p, q) => Math.round(Math.hypot(p[0] - q[0], p[1] - q[1]));
    const depotOf = new Map(); routes.forEach(R => R.r.forEach(c => depotOf.set(c, R.d)));
    const routeArcs = (R, endD) => { const s = [{ p: PD[R.d], q: PC[R.r[0]], kind: 'y', c: R.r[0] }]; for (let i = 0; i + 1 < R.r.length; i++) s.push({ p: PC[R.r[i]], q: PC[R.r[i + 1]], kind: 'x' }); s.push({ p: PC[R.r[R.r.length - 1]], q: PD[endD === undefined ? R.d : endD], kind: 'z', c: R.r[R.r.length - 1] }); return s; };
    const nodes = o => {
      o = o || {}; let s = '';
      cust.forEach((c, i) => { s += Z.dot(PC[i], 6, o.fill ? o.fill(i) : null) + Z.label(PC[i], String(i + 1), 8, -8, 'font-weight:600;fill:var(--ink)') + (o.q ? Z.label(PC[i], 'q=' + c[2], 8, 11, 'fill:var(--muted);font-size:8.5px') : ''); if (o.ring && o.ring.has(i)) s += Z.ring(PC[i], 10, o.ringCol || 'var(--accent)'); });
      dps.forEach((d, q) => { s += Z.depotMark(PD[q], 7, 'D' + (q + 1)); });
      return s;
    };
    const views = [
      { id: 'assign', label: 'Depot assignment', init(api) {
        const draw = c => {
          const dd = depotOf.get(c); let s = '';
          routes.forEach(R => routeArcs(R).forEach(a => { s += Z.arrow(a.p, a.q, DC[R.d], 1.6, null); }));
          api.out(s + nodes({ fill: i => DC[depotOf.get(i)], ring: new Set([c]) }), 'Every customer is assigned to exactly one depot (a_id = 1 for its colour, 0 for the other). In a single-depot model this whole layer of decisions does not exist.',
            'a<sub>' + (c + 1) + ',' + (dd + 1) + '</sub> = 1, &nbsp; a<sub>' + (c + 1) + ',' + (2 - dd) + '</sub> = 0 &nbsp;⇒&nbsp; Σ<sub>d</sub> a<sub>' + (c + 1) + 'd</sub> = 1');
        };
        api.buttons(cust.map((c, i) => [String(i), String(i + 1)]), '3', k => draw(+k), 'wrap'); draw(3);
      } },
      { id: 'fleet', label: 'Fleet & capacity per depot', init(api) {
        const st = api.st; st.m = [2, 2]; st.Q = [22, 22];
        const draw = () => {
          let s = '', info = [];
          routes.forEach(R => {
            const ld = R.r.reduce((a, c) => a + cust[c][2], 0), over = ld > st.Q[R.d];
            routeArcs(R).forEach(a => { s += Z.arrow(a.p, a.q, over ? BAD : DC[R.d], a.kind === 'x' ? 2 : 3.2); });
            const mp = R.r.map(c => PC[c]).concat([PD[R.d]]), cx = mp.reduce((a, p) => a + p[0], 0) / mp.length, cy = mp.reduce((a, p) => a + p[1], 0) / mp.length;
            s += '<rect x="' + (cx - 25) + '" y="' + (cy - 7) + '" width="50" height="14" rx="3" style="fill:var(--panel);opacity:.92;stroke:' + (over ? BAD : DC[R.d]) + '"/>' + Z.label([cx, cy], 'load ' + ld + '/' + st.Q[R.d], -22, 3, 'fill:' + (over ? BAD : 'var(--ink)') + ';font-size:9px;font-weight:600');
          });
          const cnt = [0, 1].map(d => routes.filter(R => R.d === d).length), okF = cnt.map((v, d) => v <= st.m[d]), okQ = routes.every(R => R.r.reduce((a, c) => a + cust[c][2], 0) <= st.Q[R.d]);
          api.out(s + nodes(), 'The depot arcs y_dj (leaving, thick) are counted per depot against the fleet m_d, and the load of every route is compared with the capacity Q_d of the depot it belongs to. Change m_d and Q_d below.',
            [0, 1].map(d => 'Σ<sub>j</sub> y<sub>' + (d + 1) + ',j</sub> = ' + cnt[d] + ' ' + (okF[d] ? tag('≤ m' + '<sub>' + (d + 1) + '</sub> = ' + st.m[d] + ' ✓', OK) : tag('> m<sub>' + (d + 1) + '</sub> = ' + st.m[d] + ' ✗', BAD))).join(' &nbsp; ') +
            '<br>route loads ≤ Q<sub>d</sub> of their depot: ' + (okQ ? tag('✓', OK) : tag('✗ (red routes)', BAD)));
        };
        api.slider('m1', 'm<sub>1</sub>', 1, 3, 2, v => { st.m[0] = v; draw(); }); api.slider('m2', 'm<sub>2</sub>', 1, 3, 2, v => { st.m[1] = v; draw(); });
        api.slider('Q1', 'Q<sub>1</sub>', 14, 30, 22, v => { st.Q[0] = v; draw(); }); api.slider('Q2', 'Q<sub>2</sub>', 14, 30, 22, v => { st.Q[1] = v; draw(); });
        draw();
      } },
      { id: 'same', label: 'Same depot at both ends', init(api) {
        const draw = k => {
          let s = '';
          if (k === 'ok') {
            routes.forEach(R => routeArcs(R).forEach(a => { s += Z.arrow(a.p, a.q, DC[R.d], a.kind === 'x' ? 1.8 : 2.8); }));
            api.out(s + nodes({ fill: i => DC[depotOf.get(i)] }), 'Each route leaves and re-enters the same depot, and all its customers belong to that depot.', 'a<sub>jd</sub> ≥ a<sub>id</sub> + x<sub>ij</sub> − 1 ,  y<sub>dj</sub> ≤ a<sub>jd</sub> ,  z<sub>jd</sub> ≤ a<sub>jd</sub> ' + tag('✓', OK));
            return;
          }
          const keep = [routes[0], routes[1], routes[2], routes[3]].filter((R, q) => q !== 0 && q !== 2);
          keep.forEach(R => routeArcs(R).forEach(a => { s += Z.arrow(a.p, a.q, DC[R.d], 1.8); }));
          const R1 = { d: 0, r: [0, 1] }, R3 = { d: 1, r: [7, 8] };
          [R1, R3].forEach(R => routeArcs(R).forEach(a => { s += Z.arrow(a.p, a.q, DC[R.d], 1.8); }));
          s += Z.arrow(PD[0], PC[2], BAD, 3.2) + Z.arrow(PC[2], PC[6], BAD, 3.2) + Z.arrow(PC[6], PD[1], BAD, 3.2);
          api.out(s + nodes({ ring: new Set([2, 6]), ringCol: BAD }), 'This route leaves depot D1, serves customers 3 and 7 and returns to D2. Customer 3 is tied to D1 by y, customer 7 is tied to D2 by z, and x_{3,7} = 1 forces them to share one depot — impossible. Single-depot models never face this coupling.',
            'y<sub>1,3</sub> = 1 ⇒ a<sub>3,1</sub> = 1; &nbsp; x<sub>3,7</sub> = 1 ⇒ a<sub>7,1</sub> ≥ 1; &nbsp; z<sub>7,2</sub> = 1 ⇒ a<sub>7,2</sub> = 1 ⇒ Σ<sub>d</sub> a<sub>7d</sub> = 2 ' + tag('✗', BAD));
        };
        api.buttons([['ok', 'Valid routes'], ['bad', 'Route ending at the other depot']], 'ok', draw); draw('ok');
      } },
    ];
    shell(root, views, 'Interactive explorer of the multi-depot VRP model on an 11-customer toy instance');
  }

  document.querySelectorAll('[data-explorer]').forEach(el => { if (el.dataset.explorer === 'cvrp') cvrpExplorer(el); else if (el.dataset.explorer === 'md') mdExplorer(el); });
})();

/* Small SVG helpers shared by anim.js and explorers.js (no dependencies). */
(function (g) {
  'use strict';
  const COL = ['var(--c1)', 'var(--c2)', 'var(--c3)', 'var(--c4)', 'var(--c5)', 'var(--c6)'];
  const col = i => COL[((i % COL.length) + COL.length) % COL.length];
  const n1 = v => (+v).toFixed(1);
  const r1 = v => Math.round(v * 10) / 10;

  /* map data coordinates to an SVG box of W x H (uniform scale, y axis pointing up) */
  function fitter(xs, ys, W, H, pad) {
    const x0 = Math.min.apply(null, xs), x1 = Math.max.apply(null, xs), y0 = Math.min.apply(null, ys), y1 = Math.max.apply(null, ys);
    const s = Math.min((W - 2 * pad) / Math.max(1e-9, x1 - x0), (H - 2 * pad) / Math.max(1e-9, y1 - y0));
    const ox = (W - s * (x1 - x0)) / 2, oy = (H - s * (y1 - y0)) / 2;
    return { s, X: x => ox + s * (x - x0), Y: y => H - (oy + s * (y - y0)) };
  }
  const seg = (p, q, st) => '<line x1="' + n1(p[0]) + '" y1="' + n1(p[1]) + '" x2="' + n1(q[0]) + '" y2="' + n1(q[1]) + '" style="' + st + '" stroke-linecap="round"/>';
  function poly(pts, st) { return '<polyline points="' + pts.map(p => n1(p[0]) + ',' + n1(p[1])).join(' ') + '" fill="none" style="' + st + '" stroke-linejoin="round" stroke-linecap="round"/>'; }
  function arrow(p, q, color, w, dash) {                       // directed edge: line + head at 62 % of the way
    const dx = q[0] - p[0], dy = q[1] - p[1], len = Math.hypot(dx, dy) || 1, ux = dx / len, uy = dy / len;
    const t = [p[0] + dx * 0.62, p[1] + dy * 0.62], h = 4.5 + w;
    const a = [t[0] + ux * h, t[1] + uy * h], b = [t[0] - ux * h - uy * h * 0.75, t[1] - uy * h + ux * h * 0.75], c = [t[0] - ux * h + uy * h * 0.75, t[1] - uy * h - ux * h * 0.75];
    return seg(p, q, 'stroke:' + color + ';stroke-width:' + w + (dash ? ';stroke-dasharray:' + dash : '')) +
      '<polygon points="' + [a, b, c].map(v => n1(v[0]) + ',' + n1(v[1])).join(' ') + '" style="fill:' + color + '"/>';
  }
  const dot = (p, r, fill, extra) => '<circle class="cust" cx="' + n1(p[0]) + '" cy="' + n1(p[1]) + '" r="' + r + '"' + (fill ? ' style="fill:' + fill + '"' : '') + (extra || '') + '/>';
  const ring = (p, r, color, w) => '<circle cx="' + n1(p[0]) + '" cy="' + n1(p[1]) + '" r="' + r + '" style="fill:none;stroke:' + color + ';stroke-width:' + (w || 1.8) + '"/>';
  const depotMark = (p, s, label) => '<rect class="depot" x="' + n1(p[0] - s) + '" y="' + n1(p[1] - s) + '" width="' + 2 * s + '" height="' + 2 * s + '"/>' +
    (label ? '<text x="' + n1(p[0] + s + 3) + '" y="' + n1(p[1] + 4) + '" style="font-size:10px;font-weight:600">' + label + '</text>' : '');
  const label = (p, s, dx, dy, st) => '<text x="' + n1(p[0] + (dx === undefined ? -4 : dx)) + '" y="' + n1(p[1] + (dy === undefined ? -8 : dy)) + '" style="font-size:9.5px;' + (st || '') + '">' + s + '</text>';

  /* colour index of every route: rank of the angle of its centroid around (cx, cy), so that neighbouring routes differ */
  function colourRank(centroids, cx, cy) {
    const idx = centroids.map((c, i) => [Math.atan2(c[1] - cy, c[0] - cx), i]).sort((a, b) => a[0] - b[0]);
    const out = new Array(centroids.length); idx.forEach((v, k) => { out[v[1]] = k; }); return out;
  }

  /* step player: controls + svg + caption.  o = {n, W, H, alt, ms, frame(k) -> {svg, cap, stat}} */
  function player(root, o) {
    root.classList.add('anim');
    root.innerHTML = '<div class="figctl animctl"><button type="button" class="secondary" data-a="reset">↺ Reset</button><button type="button" class="secondary" data-a="step">Step ▸</button>' +
      '<button type="button" data-a="play">▶ Play</button><input type="range" min="0" max="' + o.n + '" value="0" aria-label="' + (o.label || 'Step') + '"></div>' +
      '<svg viewBox="0 0 ' + o.W + ' ' + o.H + '" role="img" aria-label="' + o.alt + '"></svg><p class="animcap"></p><p class="animstat small"></p>';
    const svg = root.querySelector('svg'), cap = root.querySelector('.animcap'), stat = root.querySelector('.animstat'),
      rng = root.querySelector('input'), play = root.querySelector('[data-a=play]');
    let k = 0, timer = null;
    function show(i) {
      k = Math.max(0, Math.min(o.n, i)); rng.value = k;
      const f = o.frame(k); svg.innerHTML = f.svg; cap.textContent = f.cap || ''; stat.textContent = f.stat || '';
      play.textContent = timer ? '❚❚ Pause' : '▶ Play';
    }
    function pause() { if (timer) { clearInterval(timer); timer = null; } play.textContent = '▶ Play'; }
    function run() { if (k >= o.n) show(0); timer = setInterval(() => { if (k >= o.n) { pause(); return; } show(k + 1); if (k >= o.n) pause(); }, o.ms || 800); play.textContent = '❚❚ Pause'; }
    play.addEventListener('click', () => (timer ? pause() : run()));
    root.querySelector('[data-a=step]').addEventListener('click', () => { pause(); show(k >= o.n ? 0 : k + 1); });
    root.querySelector('[data-a=reset]').addEventListener('click', () => { pause(); show(0); });
    rng.addEventListener('input', () => { pause(); show(+rng.value); });
    show(0);
    return { show, pause, run, get k() { return k; }, root };
  }

  g.VRPViz = { COL, col, n1, r1, fitter, seg, poly, arrow, dot, ring, depotMark, label, colourRank, player };
})(typeof window !== 'undefined' ? window : globalThis);

/* vrp.js - CVRP / MDVRP engine for the browser (and Node, for testing).
 *
 * Node convention: customers 0..n-1, depots n..n+t-1; single depot = t == 1.
 * Educational implementation: operators are evaluated by rebuilding the (at most two)
 * affected routes - simple and easy to verify.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.VRP = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const EPS = 1e-9, INF = Infinity, BIG_FLEET = 1e6, PEN = 1e6;

  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* ------------------------------------------------------------------ instances */
  /* Dgiven (optional): N x N distances in engine order (customers, then depots); coordinates are then used for the map only. */
  function finish(name, n, t, x, y, dem, srv, Q, Dmax, fleet, rounded, meta, Dgiven) {
    const N = n + t, D = Dgiven || new Float64Array(N * N);
    if (!Dgiven) for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
      let d = Math.hypot(x[i] - x[j], y[i] - y[j]);
      if (rounded) d = Math.floor(d + 0.5);
      D[i * N + j] = d;
    }
    return { name, n, t, N, x, y, dem, srv, Q, Dmax, fleet, D, rounded: !!rounded, meta: meta || {} };
  }

  /* ---- explicit distance matrices -------------------------------------------------------------------------------
   * The engine needs symmetric distances (2-opt and 2-opt* reverse route segments), so an asymmetric matrix is rejected.
   * rows: array of numeric arrays (file order); line(i): text used in messages for row i. Returns a flat Float64Array. */
  function checkMatrix(rows, N, where) {
    where = where || (i => 'row ' + (i + 1));
    if (rows.length !== N) throw new Error('the distance matrix has ' + rows.length + ' rows, but there are ' + N + ' locations (depots and customers)');
    const M = new Float64Array(N * N);
    for (let i = 0; i < N; i++) {
      if (rows[i].length !== N) throw new Error('distance matrix, ' + where(i) + ': ' + rows[i].length + ' values instead of ' + N);
      for (let j = 0; j < N; j++) {
        const v = rows[i][j];
        if (!isFinite(v)) throw new Error('distance matrix, ' + where(i) + ', column ' + (j + 1) + ': not a number');
        if (v < 0) throw new Error('distance matrix, ' + where(i) + ', column ' + (j + 1) + ': the distance ' + v + ' is negative');
        M[i * N + j] = v;
      }
    }
    let worst = 0, wi = -1, wj = -1, top = 0;
    for (let i = 0; i < N; i++) {
      if (M[i * N + i] !== 0) throw new Error('distance matrix, ' + where(i) + ', column ' + (i + 1) + ': the distance from a location to itself must be 0 (found ' + M[i * N + i] + ')');
      for (let j = i + 1; j < N; j++) {
        const a = M[i * N + j], b = M[j * N + i], d = Math.abs(a - b) / Math.max(1, Math.abs(a), Math.abs(b));
        if (d > worst) { worst = d; wi = i; wj = j; }
        if (a > top) top = a;
      }
    }
    if (worst > 1e-6) throw new Error('the distance matrix is not symmetric: ' + where(wi) + ', column ' + (wj + 1) + ' is ' + M[wi * N + wj] + ' but ' + where(wj) + ', column ' + (wi + 1) + ' is ' + M[wj * N + wi] +
      '. One-way (asymmetric) distances are not supported; make the matrix symmetric first, for example with the average of the two directions');
    if (!(top > 0)) throw new Error('all distances in the matrix are 0');
    for (let i = 0; i < N; i++) for (let j = i + 1; j < N; j++) { const m = (M[i * N + j] + M[j * N + i]) / 2; M[i * N + j] = M[j * N + i] = m; }   // remove rounding noise
    return M;
  }

  /* square table of distances: comma, semicolon, tab or blanks; an optional header row and label column are skipped */
  function parseMatrixTable(text) {
    const lines = [];
    text.replace(/^\uFEFF/, '').split(/\r?\n/).forEach((l, i) => { const s = l.trim(); if (s && !s.startsWith('#')) lines.push([s, i + 1]); });
    if (!lines.length) throw new Error('the distance matrix file is empty');
    const f = lines[0][0], sep = f.includes('\t') ? '\t' : f.includes(';') ? ';' : f.includes(',') ? ',' : null;
    const cells = l => (sep ? l.split(sep) : l.split(/\s+/)).map(c => c.trim().replace(/^"(.*)"$/, '$1'));
    const isNum = c => c !== '' && isFinite(Number(sep === ';' ? c.replace(',', '.') : c));
    let rows = lines.map(([l, ln]) => ({ c: cells(l), ln }));
    if (!rows[0].c.slice(1).every(isNum)) rows = rows.slice(1);                    // header row with names
    if (!rows.length) throw new Error('the distance matrix file has no numbers');
    const labelled = rows.every(r => r.c.length === rows.length + 1) || !isNum(rows[0].c[0]);
    const ln = rows.map(r => r.ln);
    const out = rows.map(r => (labelled ? r.c.slice(1) : r.c).map((c, j) => {
      if (!isNum(c)) throw new Error('distance matrix, line ' + r.ln + ', column ' + (j + 1) + ': "' + c + '" is not a number');
      return Number(sep === ';' ? c.replace(',', '.') : c);
    }));
    return { rows: out, where: i => 'line ' + ln[i] };
  }

  /* map positions for an instance that has distances but no coordinates: classical multidimensional scaling
   * (two leading eigenvectors of the double-centred squared distances, by power iteration). Approximate by nature. */
  function layoutFromMatrix(M, N) {
    const B = new Float64Array(N * N), rm = new Float64Array(N); let tot = 0;
    for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) { const v = M[i * N + j] * M[i * N + j]; rm[i] += v / N; tot += v / (N * N); }
    for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) B[i * N + j] = -0.5 * (M[i * N + j] * M[i * N + j] - rm[i] - rm[j] + tot);
    // subspace iteration with two vectors, then a 2 x 2 Rayleigh-Ritz step (exact for points that lie in a plane)
    const R = mulberry32(12345); let u = new Float64Array(N), v = new Float64Array(N);
    for (let i = 0; i < N; i++) { u[i] = R() - 0.5; v[i] = R() - 0.5; }
    const mul = q => { const w = new Float64Array(N); for (let i = 0; i < N; i++) { let z = 0; const o = i * N; for (let j = 0; j < N; j++) z += B[o + j] * q[j]; w[i] = z; } return w; };
    const dot = (p, q) => { let z = 0; for (let i = 0; i < N; i++) z += p[i] * q[i]; return z; };
    const orth = () => {
      let nu = Math.sqrt(dot(u, u)) || 1; for (let i = 0; i < N; i++) u[i] /= nu;
      const d = dot(u, v); for (let i = 0; i < N; i++) v[i] -= d * u[i];
      let nv = Math.sqrt(dot(v, v)) || 1; for (let i = 0; i < N; i++) v[i] /= nv;
    };
    orth();
    for (let it = 0; it < 40; it++) { u = mul(u); v = mul(v); orth(); }
    const Bu = mul(u), Bv = mul(v), a = dot(u, Bu), b = dot(u, Bv), c = dot(v, Bv);
    const th = 0.5 * Math.atan2(2 * b, a - c), cs = Math.cos(th), sn = Math.sin(th);
    const l1 = a * cs * cs + 2 * b * cs * sn + c * sn * sn, l2 = a * sn * sn - 2 * b * cs * sn + c * cs * cs;
    const e1 = new Float64Array(N), e2 = new Float64Array(N);
    for (let i = 0; i < N; i++) { e1[i] = cs * u[i] + sn * v[i]; e2[i] = -sn * u[i] + cs * v[i]; }
    const axes = [{ v: e1, s: Math.sqrt(Math.max(l1, 0)) }, { v: e2, s: Math.sqrt(Math.max(l2, 0)) }];
    const x = new Array(N), y = new Array(N);
    for (let i = 0; i < N; i++) { x[i] = axes[0].v[i] * axes[0].s; y[i] = axes[1].v[i] * axes[1].s; }
    if (!(axes[0].s > 0) && !(axes[1].s > 0)) for (let i = 0; i < N; i++) { x[i] = Math.cos(2 * Math.PI * i / N); y[i] = Math.sin(2 * Math.PI * i / N); }
    return [x, y];
  }

  const EARTH_KM = 6371.0088;                                                       // mean Earth radius
  function haversineKm(lat1, lon1, lat2, lon2) {
    const r = Math.PI / 180, a = Math.sin((lat2 - lat1) * r / 2), b = Math.sin((lon2 - lon1) * r / 2);
    const h = a * a + Math.cos(lat1 * r) * Math.cos(lat2 * r) * b * b;
    return 2 * EARTH_KM * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  function parseCordeau(text, name) {            // types 0 (VRP) and 2 (MDVRP)
    const rows = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean).map(s => s.split(/\s+/));
    const [typ, m, n, t] = rows[0].slice(0, 4).map(Number);
    if (typ !== 0 && typ !== 2) throw new Error('Cordeau type ' + typ + ' not supported (0 = VRP, 2 = MDVRP)');
    const Dmax = [], Q = [];
    for (let d = 0; d < t; d++) { const r = rows[1 + d].map(Number); Dmax.push(r[0] > 0 ? r[0] : INF); Q.push(r[1]); }
    const body = rows.slice(1 + t, 1 + t + n + t);
    const x = [], y = [], srv = [], dem = [];
    for (let i = 0; i < n; i++) { const r = body[i].map(Number); x.push(r[1]); y.push(r[2]); srv.push(r[3]); dem.push(r[4]); }
    for (let d = 0; d < t; d++) { const r = body[n + d].map(Number); x.push(r[1]); y.push(r[2]); }
    return finish(name || 'instance', n, t, x, y, dem, srv, Q, Dmax, new Array(t).fill(m), false);
  }

  function parseVRPLIB(text, name) {             // single-depot .vrp (CVRPLIB)
    const header = {}, coords = new Map(), demand = new Map(), depots = [], weights = [];
    let section = null;
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line === 'EOF') continue;
      if (/^[A-Z_]+\s*:/.test(line)) { const k = line.split(':')[0].trim(); header[k] = line.slice(line.indexOf(':') + 1).trim(); section = null; continue; }
      if (/SECTION$/.test(line)) { section = line; continue; }
      const p = line.split(/\s+/);
      if (section === 'EDGE_WEIGHT_SECTION') { for (const v of p) weights.push(Number(v)); continue; }
      if (section === 'NODE_COORD_SECTION' || (section === 'DISPLAY_DATA_SECTION' && !coords.has(+p[0]))) coords.set(+p[0], [+p[1], +p[2]]);
      else if (section === 'DEMAND_SECTION') demand.set(+p[0], +p[1]);
      else if (section === 'DEPOT_SECTION' && +p[0] !== -1) depots.push(+p[0]);
    }
    const depot = depots.length ? depots[0] : 1;
    if (depots.length > 1) throw new Error('the file lists ' + depots.length + ' depots; .vrp files with one depot are supported (use a table or the Cordeau format for several depots)');
    const ewt = header.EDGE_WEIGHT_TYPE || 'EUC_2D', explicit = ewt === 'EXPLICIT';
    if (!explicit && !/^(EUC_2D|EXACT_2D|FLOAT_2D)$/.test(ewt)) throw new Error('EDGE_WEIGHT_TYPE ' + ewt + ' is not supported (supported: EUC_2D and EXPLICIT)');
    const all = (explicit ? Array.from({ length: +header.DIMENSION || demand.size }, (_, i) => i + 1) : [...coords.keys()]).sort((a, b) => a - b);
    if (all.length < 3) throw new Error('the file has fewer than two customers');
    if (!all.includes(depot)) throw new Error('the depot ' + depot + ' is not among the nodes');
    const ids = all.filter(i => i !== depot), order = ids.concat([depot]);
    const dem = ids.map(i => demand.get(i));
    if (dem.some(q => !(q >= 0))) throw new Error('DEMAND_SECTION does not give a demand for every customer');
    let Dgiven = null, x, y, meta = {};
    if (explicit) {
      const N = all.length, fmtW = header.EDGE_WEIGHT_FORMAT || 'FULL_MATRIX', full = all.map(() => new Array(N).fill(0));
      const tri = { LOWER_ROW: [1, 0], LOWER_DIAG_ROW: [1, 1], UPPER_ROW: [0, 0], UPPER_DIAG_ROW: [0, 1], LOWER_COL: [0, 0], UPPER_COL: [1, 0], LOWER_DIAG_COL: [0, 1], UPPER_DIAG_COL: [1, 1] }[fmtW];
      const need = fmtW === 'FULL_MATRIX' ? N * N : tri ? N * (N - 1) / 2 + (tri[1] ? N : 0) : -1;
      if (need < 0) throw new Error('EDGE_WEIGHT_FORMAT ' + fmtW + ' is not supported (supported: FULL_MATRIX and the LOWER / UPPER triangular formats)');
      if (weights.length !== need) throw new Error('EDGE_WEIGHT_SECTION has ' + weights.length + ' numbers; ' + fmtW + ' with ' + N + ' nodes needs ' + need);
      let k = 0;
      if (fmtW === 'FULL_MATRIX') for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) full[i][j] = weights[k++];
      else if (tri[0]) for (let i = 0; i < N; i++) for (let j = 0; j < i + tri[1]; j++) { full[i][j] = weights[k]; full[j][i] = weights[k++]; }
      else for (let i = 0; i < N; i++) for (let j = i + 1 - tri[1]; j < N; j++) { full[i][j] = weights[k]; full[j][i] = weights[k++]; }
      const pos = order.map(id => all.indexOf(id));                          // engine order: customers, then the depot
      Dgiven = checkMatrix(pos.map(i => pos.map(j => full[i][j])), N, i => 'node ' + order[i]);
      meta.matrix = true;
      if (order.every(id => coords.has(id))) { x = order.map(id => coords.get(id)[0]); y = order.map(id => coords.get(id)[1]); }
      else { [x, y] = layoutFromMatrix(Dgiven, N); meta.layout = 'computed'; }
    } else {
      x = order.map(i => coords.get(i)[0]); y = order.map(i => coords.get(i)[1]);
    }
    if (!(+header.CAPACITY > 0)) throw new Error('the file has no CAPACITY line');
    const nm = header.NAME || name || 'instance';
    /* CVRPLIB convention: EUC_2D distances are rounded to the nearest integer (sets A, B, E, F, M, P, X ...), except in the
     * sets that are always used with real distances (CMT, Golden, Li, tai).  DISTANCE is the route-duration limit and
     * SERVICE_TIME a uniform service time: travel plus service of a route must not exceed the limit (CMT6-10, 13, 14, Golden_1-8). */
    const realSet = /^(CMT|Golden|Li_|tai)/.test(nm);
    const rounded = ewt === 'EUC_2D' && !realSet;
    const srv = header.SERVICE_TIME !== undefined ? +header.SERVICE_TIME : 0;
    const lim = header.DISTANCE !== undefined ? +header.DISTANCE : INF;
    if (!isFinite(srv) || srv < 0 || !(lim > 0)) throw new Error('SERVICE_TIME or DISTANCE is not a valid number');
    return finish(nm, ids.length, 1, x, y, dem, new Array(ids.length).fill(srv),
      [+header.CAPACITY], [lim], [BIG_FLEET], rounded, meta, Dgiven);
  }

  /* Simple table format for people who do not have a benchmark file: one row per location, with a header row.
   *   columns (any order, case-insensitive): x, y, demand; optional: type (depot | customer), name / id (ignored)
   *   separators: comma, semicolon or tab; with semicolons a decimal comma is accepted.
   *   depots: rows whose type is "depot"; without a type column, rows with an empty or zero demand; if there are none, the first row.
   *   o.capacity: vehicle capacity (default: about 8 average customers per route, at least two routes); the fleet is unlimited. */
  function parseCSV(text, name, o) {
    o = o || {};
    const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'));
    if (lines.length < 2) throw new Error('the table needs a header row and at least one data row');
    const sep = lines[0].includes('\t') ? '\t' : lines[0].includes(';') ? ';' : ',';
    const cells = l => l.split(sep).map(c => c.trim().replace(/^"(.*)"$/, '$1'));
    const head = cells(lines[0]).map(h => h.toLowerCase());
    const col = (...names) => head.findIndex(h => names.includes(h));
    const cd = col('demand', 'q', 'quantity'), ct = col('type', 'kind', 'role');
    const clat = col('lat', 'latitude'), clon = col('lon', 'lng', 'long', 'longitude');
    const geo = clat >= 0 && clon >= 0, hasM = typeof o.matrix === 'string' && o.matrix.trim() !== '';
    const cx = geo ? clon : col('x'), cy = geo ? clat : col('y'), noXY = cx < 0 || cy < 0;
    if (noXY && !hasM) throw new Error('the header row must name the columns "x" and "y" (or "lat" and "lon"; found: ' + head.join(', ') + ')');
    if (cd < 0) throw new Error('the header row must have a "demand" column');
    const num = (v, what, ln) => {
      const f = Number(sep === ';' ? String(v).replace(',', '.') : v);
      if (v === undefined || v === '' || !isFinite(f)) throw new Error('line ' + ln + ': ' + what + ' "' + (v === undefined ? '' : v) + '" is not a number');
      return f;
    };
    const cust = [], dep = [];
    lines.slice(1).forEach((l, i) => {
      const c = cells(l), ln = i + 2;
      const p = { row: i, x: noXY ? 0 : num(c[cx], geo ? 'longitude' : 'x', ln), y: noXY ? 0 : num(c[cy], geo ? 'latitude' : 'y', ln), q: c[cd] === undefined || c[cd] === '' ? 0 : num(c[cd], 'demand', ln) };
      if (p.q < 0) throw new Error('line ' + ln + ': the demand cannot be negative');
      if (geo && !noXY && (Math.abs(p.y) > 90 || Math.abs(p.x) > 180)) throw new Error('line ' + ln + ': latitude must be between -90 and 90 and longitude between -180 and 180');
      const isDepot = ct >= 0 ? /^d/i.test(c[ct] || '') : p.q === 0;
      (isDepot ? dep : cust).push(p);
    });
    if (!dep.length) dep.push(cust.shift());                       // no depot marked: the first row is the depot
    if (cust.length < 2) throw new Error('at least two customers (rows with a positive demand) are needed');
    if (dep.length > 20) throw new Error(dep.length + ' depots found (rows with no demand); at most 20 are supported. Add a "type" column to mark depots explicitly.');
    const dem = cust.map(p => p.q), total = dem.reduce((u, v) => u + v, 0), maxd = Math.max(...dem);
    if (total <= 0) throw new Error('all demands are zero');
    let Q = Number(o.capacity);
    const auto = !(Q > 0);
    if (auto) Q = Math.max(maxd, Math.ceil(total / Math.max(2, cust.length / 8)));   // about 8 customers per route, at least two routes
    if (maxd > Q) throw new Error('a customer demands ' + maxd + ', more than the vehicle capacity ' + Q);
    const t = dep.length, all = cust.concat(dep), N = all.length, meta = { csv: true, autoCapacity: auto };
    let x = all.map(p => p.x), y = all.map(p => p.y), Dgiven = null;
    if (hasM) {                                                        // matrix rows and columns follow the rows of the table
      const m = parseMatrixTable(o.matrix), full = checkMatrix(m.rows, N, m.where);
      Dgiven = new Float64Array(N * N);
      for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) Dgiven[i * N + j] = full[all[i].row * N + all[j].row];
      meta.matrix = true;
      if (noXY) { [x, y] = layoutFromMatrix(Dgiven, N); meta.layout = 'computed'; }
    } else if (geo) {                                                  // great-circle distances in kilometres
      Dgiven = new Float64Array(N * N);
      for (let i = 0; i < N; i++) for (let j = i + 1; j < N; j++) Dgiven[i * N + j] = Dgiven[j * N + i] = haversineKm(all[i].y, all[i].x, all[j].y, all[j].x);
      meta.geo = true;
    }
    if (geo && !noXY) { const k = Math.cos(all.reduce((u, p) => u + p.y, 0) / N * Math.PI / 180); x = x.map(v => v * k); }   // map: equirectangular
    return finish((name || 'table').replace(/\.(csv|tsv|txt)$/i, ''), cust.length, t, x, y, dem, new Array(cust.length).fill(0),
      new Array(t).fill(Q), new Array(t).fill(INF), new Array(t).fill(BIG_FLEET), false, meta, Dgiven);
  }

  function parseInstance(text, name, o) {
    if (/NODE_COORD_SECTION|EDGE_WEIGHT_SECTION/.test(text)) return parseVRPLIB(text, name);
    const first = (text.replace(/^\uFEFF/, '').split(/\r?\n/).find(l => l.trim() && !l.trim().startsWith('#')) || '');
    if (/\.(csv|tsv)$/i.test(name || '') || /[a-df-zA-DF-Z]/.test(first)) return parseCSV(text, name, o);
    return parseCordeau(text, name);
  }

  function generate(n, t, seed, o) {
    o = o || {};
    const R = mulberry32(seed), G = o.grid || 1000, avg = o.routeSize || 8;
    const x = [], y = [], dem = [], srv = [];
    const cl = o.clustered ? Math.max(3, Math.round(n / 15)) : 0, cen = [];
    for (let c = 0; c < cl; c++) cen.push([R() * G, R() * G]);
    const clamp = v => Math.min(G, Math.max(0, v));
    const gauss = () => Math.sqrt(-2 * Math.log(1 - R())) * Math.cos(2 * Math.PI * R());
    for (let i = 0; i < n; i++) {
      if (cl) { const c = cen[Math.floor(R() * cl)]; x.push(clamp(Math.round(c[0] + gauss() * G * 0.06))); y.push(clamp(Math.round(c[1] + gauss() * G * 0.06))); }
      else { x.push(Math.floor(R() * (G + 1))); y.push(Math.floor(R() * (G + 1))); }
      dem.push(1 + Math.floor(R() * 30)); srv.push(0);
    }
    for (let d = 0; d < t; d++) {
      if (t === 1) { x.push(G / 2); y.push(G / 2); }
      else { const ang = 2 * Math.PI * d / t + 0.4; x.push(Math.round(G / 2 + 0.28 * G * Math.cos(ang))); y.push(Math.round(G / 2 + 0.28 * G * Math.sin(ang))); }
    }
    const Qv = o.capacity || Math.max(...dem, Math.ceil(avg * dem.reduce((a, b) => a + b, 0) / n));
    const need = Math.ceil(dem.reduce((a, b) => a + b, 0) / Qv);
    const m = Math.ceil(1.6 * need / t) + 1;
    return finish('random-n' + n + '-t' + t + '-s' + seed, n, t, x, y, dem, srv, new Array(t).fill(Qv),
      new Array(t).fill(o.maxDuration || INF), new Array(t).fill(m), false);
  }

  /* ------------------------------------------------------------------ solutions */
  const copySol = s => ({ routes: s.routes.map(r => ({ d: r.d, nodes: r.nodes.slice() })) });
  function rCost(I, d, nodes) {
    if (!nodes.length) return 0;
    const N = I.N, D = I.D, dn = I.n + d;
    let c = D[dn * N + nodes[0]];
    for (let k = 1; k < nodes.length; k++) c += D[nodes[k - 1] * N + nodes[k]];
    return c + D[nodes[nodes.length - 1] * N + dn];
  }
  function solCost(I, s) { let c = 0; for (const r of s.routes) c += rCost(I, r.d, r.nodes); return c; }

  /* independent checker: partition, capacity, duration, fleet.  Returns [] if feasible. */
  function violations(I, s) {
    const v = [], seen = new Uint8Array(I.n), used = new Array(I.t).fill(0);
    for (const r of s.routes) {
      if (!r.nodes.length) continue;
      used[r.d]++;
      let q = 0, sv = 0;
      for (const c of r.nodes) { if (c < 0 || c >= I.n) v.push('bad node ' + c); else { seen[c]++; q += I.dem[c]; sv += I.srv[c]; } }
      if (q > I.Q[r.d] + 1e-9) v.push('capacity: load ' + q + ' > ' + I.Q[r.d] + ' (depot ' + r.d + ')');
      if (rCost(I, r.d, r.nodes) + sv > I.Dmax[r.d] + 1e-9) v.push('duration exceeded (depot ' + r.d + ')');
    }
    for (let c = 0; c < I.n; c++) if (seen[c] !== 1) v.push('customer ' + c + ' visited ' + seen[c] + ' times');
    for (let d = 0; d < I.t; d++) if (used[d] > I.fleet[d]) v.push('depot ' + d + ': ' + used[d] + ' routes > fleet ' + I.fleet[d]);
    return v;
  }

  function nearestDepot(I, c) {
    let b = 0, bd = INF;
    for (let d = 0; d < I.t; d++) { const x = I.D[c * I.N + I.n + d]; if (x < bd) { bd = x; b = d; } }
    return b;
  }
  const feasibleRoute = (I, d, nodes) => {
    let q = 0, sv = 0;
    for (const c of nodes) { q += I.dem[c]; sv += I.srv[c]; }
    return q <= I.Q[d] + EPS && rCost(I, d, nodes) + sv <= I.Dmax[d] + EPS;
  };

  /* ------------------------------------------------------------------ construction */
  /* trace (optional array) receives one event per examined pair in decreasing order of saving:
   * {d, i, j, s, ok, why, A, B, M}; why = 'same' | 'ends' | 'limit' when the merge is rejected. */
  function savings(I, trace) {
    const routes = [];
    for (let d = 0; d < I.t; d++) {
      const cust = []; for (let c = 0; c < I.n; c++) if (nearestDepot(I, c) === d) cust.push(c);
      const dn = I.n + d, N = I.N, D = I.D;
      const rt = new Map(); cust.forEach(c => rt.set(c, [c]));
      const sav = [];
      for (let a = 0; a < cust.length; a++) for (let b = a + 1; b < cust.length; b++) {
        const i = cust[a], j = cust[b];
        sav.push([D[dn * N + i] + D[dn * N + j] - D[i * N + j], i, j]);
      }
      sav.sort((p, q) => q[0] - p[0]);
      for (const [s, i, j] of sav) {
        if (s <= 0) break;
        const A = rt.get(i), B = rt.get(j);
        if (A === B) { if (trace) trace.push({ d, i, j, s, ok: false, why: 'same' }); continue; }
        const iEnd = A[A.length - 1] === i, iStart = A[0] === i, jEnd = B[B.length - 1] === j, jStart = B[0] === j;
        let M = null;
        if (iEnd && jStart) M = A.concat(B);
        else if (iStart && jEnd) M = B.concat(A);
        else if (iEnd && jEnd) M = A.concat(B.slice().reverse());
        else if (iStart && jStart) M = A.slice().reverse().concat(B);
        if (!M) { if (trace) trace.push({ d, i, j, s, ok: false, why: 'ends' }); continue; }
        if (!feasibleRoute(I, d, M)) { if (trace) trace.push({ d, i, j, s, ok: false, why: 'limit', A: A.slice(), B: B.slice(), M: M.slice() }); continue; }
        if (trace) trace.push({ d, i, j, s, ok: true, A: A.slice(), B: B.slice(), M: M.slice() });
        for (const c of M) rt.set(c, M);
      }
      for (const r of new Set(rt.values())) routes.push({ d, nodes: r.slice() });
    }
    return repairFleet(I, { routes });
  }

  /* trace (optional object) receives {start, events: [{d, c, ang, newRoute}]} of the best rotation */
  function sweep(I, trace) {
    let best = null, bc = INF;
    for (let s = 0; s < 12; s++) {
      const start = 2 * Math.PI * s / 12, routes = [], events = [];
      for (let d = 0; d < I.t; d++) {
        const dn = I.n + d, cx = I.x[dn], cy = I.y[dn];
        const cust = []; for (let c = 0; c < I.n; c++) if (nearestDepot(I, c) === d) cust.push(c);
        const ang = c => ((Math.atan2(I.y[c] - cy, I.x[c] - cx) - start) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
        cust.sort((a, b) => ang(a) - ang(b));
        let cur = [];
        for (const c of cust) {
          let nr = cur.length === 0;
          if (cur.length && !feasibleRoute(I, d, cur.concat([c]))) { routes.push({ d, nodes: cur }); cur = []; nr = true; }
          cur.push(c); events.push({ d, c, ang: ang(c), newRoute: nr });
        }
        if (cur.length) routes.push({ d, nodes: cur });
      }
      const sol = repairFleet(I, { routes }), c = solCost(I, sol) + PEN * excess(I, sol);
      if (c < bc) { bc = c; best = sol; if (trace) { trace.start = start; trace.events = events; } }
    }
    return best;
  }

  function nearestNeighbour(I) {
    const routes = [], N = I.N, D = I.D;
    for (let d = 0; d < I.t; d++) {
      const todo = new Set(); for (let c = 0; c < I.n; c++) if (nearestDepot(I, c) === d) todo.add(c);
      const dn = I.n + d;
      while (todo.size) {
        const cur = []; let load = 0, pos = dn, dur = 0;
        for (;;) {
          let b = -1, bd = INF;
          for (const c of todo) {
            if (load + I.dem[c] > I.Q[d] + EPS) continue;
            if (dur + D[pos * N + c] + I.srv[c] + D[c * N + dn] > I.Dmax[d] + EPS) continue;
            if (D[pos * N + c] < bd) { bd = D[pos * N + c]; b = c; }
          }
          if (b < 0) break;
          cur.push(b); todo.delete(b); load += I.dem[b]; dur += D[pos * N + b] + I.srv[b]; pos = b;
        }
        if (!cur.length) { const c = todo.values().next().value; todo.delete(c); cur.push(c); }
        routes.push({ d, nodes: cur });
      }
    }
    return repairFleet(I, { routes });
  }

  const excess = (I, s) => {
    const cnt = new Array(I.t).fill(0); for (const r of s.routes) if (r.nodes.length) cnt[r.d]++;
    let e = 0; for (let d = 0; d < I.t; d++) e += Math.max(0, cnt[d] - I.fleet[d]); return e;
  };

  function repairFleet(I, sol) {               // dissolve smallest routes of over-used depots (all-or-nothing)
    sol.routes = sol.routes.filter(r => r.nodes.length);
    for (let guard = 0; guard < 4 * I.n; guard++) {
      const cnt = new Array(I.t).fill(0); sol.routes.forEach(r => cnt[r.d]++);
      const d0 = cnt.findIndex((c, d) => c > I.fleet[d]); if (d0 < 0) break;
      const cand = sol.routes.map((r, i) => i).filter(i => sol.routes[i].d === d0)
        .sort((a, b) => load(I, sol.routes[a].nodes) - load(I, sol.routes[b].nodes));
      let ok = false;
      for (const r0 of cand) {
        const rs = sol.routes.map(r => r.nodes.slice());
        let fail = false;
        for (const c of sol.routes[r0].nodes) {
          let best = null, bd = INF;
          for (let r = 0; r < rs.length; r++) {
            if (r === r0 || !rs[r].length) continue;
            const d = sol.routes[r].d;
            for (let p = 0; p <= rs[r].length; p++) {
              const t = rs[r].slice(0, p).concat([c], rs[r].slice(p));
              if (!feasibleRoute(I, d, t)) continue;
              const dl = rCost(I, d, t) - rCost(I, d, rs[r]);
              if (dl < bd) { bd = dl; best = [r, p]; }
            }
          }
          if (!best) { fail = true; break; }
          rs[best[0]].splice(best[1], 0, c);
        }
        if (!fail) { rs[r0] = []; sol.routes.forEach((r, i) => { r.nodes = rs[i]; }); sol.routes = sol.routes.filter(r => r.nodes.length); ok = true; break; }
      }
      if (!ok) break;
    }
    return sol;
  }
  const load = (I, nodes) => nodes.reduce((a, c) => a + I.dem[c], 0);

  /* ------------------------------------------------------------------ local search */
  const OPS = ['relocate', 'oropt', 'swap', 'twoopt', 'twooptstar', 'routedepot', 'depotswap'];
  const PRESETS = {
    basic: ['relocate', 'swap', 'twoopt', 'twooptstar'],
    standard: ['relocate', 'oropt', 'swap', 'twoopt', 'twooptstar'],
    full: OPS.slice(),
  };

  function neighbours(I, k) {
    const nb = [];
    for (let u = 0; u < I.n; u++) {
      const a = []; for (let v = 0; v < I.n; v++) if (v !== u) a.push(v);
      a.sort((p, q) => I.D[u * I.N + p] - I.D[u * I.N + q]);
      nb.push(a.slice(0, Math.min(k, a.length)));
    }
    return nb;
  }

  class LS {
    constructor(I, sol, nb) {
      this.I = I; this.nb = nb;
      this.R = []; this.where = new Int32Array(I.n).fill(-1); this.pos = new Int32Array(I.n);
      this.cnt = new Array(I.t).fill(0);
      this.stats = {};
      for (const r of sol.routes) if (r.nodes.length) this.addRoute(r.d, r.nodes.slice());
    }
    addRoute(d, nodes) {
      const R = { d, nodes: [], cost: 0, load: 0, dur: 0 };
      this.R.push(R); this.setNodes(this.R.length - 1, nodes); return this.R.length - 1;
    }
    setNodes(ri, nodes) {
      const I = this.I, R = this.R[ri], was = R.nodes.length > 0;
      R.nodes = nodes; let q = 0, s = 0;
      for (let k = 0; k < nodes.length; k++) { const v = nodes[k]; q += I.dem[v]; s += I.srv[v]; this.where[v] = ri; this.pos[v] = k; }
      R.load = q; R.cost = rCost(I, R.d, nodes); R.dur = R.cost + s;
      const now = nodes.length > 0;
      if (was && !now) this.cnt[R.d]--; else if (!was && now) this.cnt[R.d]++;
    }
    /* cost change of replacing routes (ra, nodesA) and (rb, nodesB); null if infeasible */
    pair(ra, na, rb, nb) {
      const I = this.I, A = this.R[ra], B = rb === null ? null : this.R[rb];
      let qa = 0, sa = 0; for (const c of na) { qa += I.dem[c]; sa += I.srv[c]; }
      const ca = rCost(I, A.d, na);
      if (qa > I.Q[A.d] + EPS || ca + sa > I.Dmax[A.d] + EPS) return null;
      let delta = ca - A.cost;
      if (B) {
        let qb = 0, sb = 0; for (const c of nb) { qb += I.dem[c]; sb += I.srv[c]; }
        const cb = rCost(I, B.d, nb);
        if (qb > I.Q[B.d] + EPS || cb + sb > I.Dmax[B.d] + EPS) return null;
        delta += cb - B.cost;
        if (!B.nodes.length && nb.length && this.cnt[B.d] >= I.fleet[B.d]) return null;   // would open a route beyond the fleet
      }
      return delta;
    }
    run(ops, rand, dirty, maxSteps) {
      const I = this.I, n = I.n, nbl = this.nb;
      const queue = dirty ? dirty.slice() : Array.from({ length: n }, (_, i) => i);
      for (let i = queue.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [queue[i], queue[j]] = [queue[j], queue[i]]; }
      const inq = new Uint8Array(n); queue.forEach(c => { inq[c] = 1; });
      let steps = 0; const cap = maxSteps || 50 * n;
      const push = ri => { for (const w of this.R[ri].nodes) if (!inq[w]) { inq[w] = 1; queue.push(w); } };
      while (steps < cap) {
        while (queue.length && steps < cap) {
          steps++;
          const u = queue.pop(); inq[u] = 0;
          const best = this.bestMove(u, nbl[u], ops);
          if (best) {
            this.stats[best.name] = (this.stats[best.name] || 0) + 1;
            const touched = this.apply(best);
            touched.forEach(push);
            if (!inq[u]) { inq[u] = 1; queue.push(u); }
          }
        }
        if (ops.has('routedepot') || ops.has('depotswap')) {
          const t = this.depotPass(ops); if (t.length) { t.forEach(push); continue; }
        }
        if (!queue.length) break;
      }
      return this;
    }
    apply(m) {
      const out = [];
      if (m.kind === 'new') { const nr = this.addRoute(m.d, m.nb); this.setNodes(m.ra, m.na); out.push(m.ra, nr); return out; }
      this.setNodes(m.ra, m.na); out.push(m.ra);
      if (m.rb !== null && m.rb !== m.ra) { this.setNodes(m.rb, m.nb); out.push(m.rb); }
      return out;
    }
    bestMove(u, neigh, ops) {
      const I = this.I, ra = this.where[u], A = this.R[ra], an = A.nodes, i = this.pos[u], LA = an.length;
      let best = null, bd = -1e-7;
      const cons = (name, delta, rb, na, nb, extra) => { if (delta !== null && delta < bd) { bd = delta; best = Object.assign({ name, delta, ra, rb, na, nb }, extra); } };
      for (const v of neigh) {
        const rb = this.where[v], B = this.R[rb], bn = B.nodes, j = this.pos[v], LB = bn.length;
        if (rb === ra) {
          if (ops.has('twoopt') && i !== j) {
            const lo = Math.min(i, j), hi = Math.max(i, j);
            if (hi - lo >= 2) { const na = an.slice(0, lo + 1).concat(an.slice(lo + 1, hi + 1).reverse(), an.slice(hi + 1)); cons('twoopt', this.pair(ra, na, null, null), null, na, null); }
          }
          const lens = []; if (ops.has('relocate')) lens.push(1); if (ops.has('oropt')) lens.push(2, 3);
          for (const l of lens) {
            if (i + l > LA || (j >= i && j < i + l)) continue;
            const seg = an.slice(i, i + l), rest = an.slice(0, i).concat(an.slice(i + l));
            const jj = j > i ? j - l : j;
            for (const rev of (l > 1 ? [false, true] : [false])) for (const p of [jj, jj + 1]) {
              const s = rev ? seg.slice().reverse() : seg, na = rest.slice(0, p).concat(s, rest.slice(p));
              cons(l === 1 ? 'relocate' : 'oropt', this.pair(ra, na, null, null), null, na, null);
            }
          }
          continue;
        }
        const lens = []; if (ops.has('relocate')) lens.push(1); if (ops.has('oropt')) lens.push(2, 3);
        for (const l of lens) {
          if (i + l > LA) continue;
          const seg = an.slice(i, i + l), na = an.slice(0, i).concat(an.slice(i + l));
          for (const rev of (l > 1 ? [false, true] : [false])) for (const p of [j, j + 1]) {
            const s = rev ? seg.slice().reverse() : seg, nb = bn.slice(0, p).concat(s, bn.slice(p));
            cons(l === 1 ? 'relocate' : 'oropt', this.pair(ra, na, rb, nb), rb, na, nb);
          }
        }
        if (ops.has('swap')) {
          const na = an.slice(), nb = bn.slice(); na[i] = v; nb[j] = u;
          cons('swap', this.pair(ra, na, rb, nb), rb, na, nb);
        }
        if (ops.has('twooptstar')) {
          let na = an.slice(0, i + 1).concat(bn.slice(j + 1)), nb = bn.slice(0, j + 1).concat(an.slice(i + 1));
          cons('twooptstar', this.pair(ra, na, rb, nb), rb, na, nb);
          if (A.d === B.d) {                                    // reversed-heads variant: only valid for a common depot
            na = an.slice(0, i + 1).concat(bn.slice(0, j + 1).reverse());
            nb = an.slice(i + 1).reverse().concat(bn.slice(j + 1));
            cons('twooptstar', this.pair(ra, na, rb, nb), rb, na, nb);
          }
        }
      }
      if (ops.has('relocate')) {                                // open a new route at one of the two nearest depots
        const order = []; for (let d = 0; d < I.t; d++) order.push(d);
        order.sort((a, b) => I.D[u * I.N + I.n + a] - I.D[u * I.N + I.n + b]);
        for (const d of order.slice(0, 2)) {
          if (this.cnt[d] >= I.fleet[d] || LA < 2) continue;
          const na = an.slice(0, i).concat(an.slice(i + 1)), nb = [u];
          const ca = rCost(I, A.d, na), cb = rCost(I, d, nb);
          if (ca + (A.dur - A.cost) - I.srv[u] > I.Dmax[A.d] + EPS) continue;
          if (cb + I.srv[u] > I.Dmax[d] + EPS || I.dem[u] > I.Q[d] + EPS) continue;
          const delta = ca + cb - A.cost;
          if (delta < bd) { bd = delta; best = { name: 'relocate', kind: 'new', delta, ra, rb: null, na, nb, d }; }
        }
      }
      return best;
    }
    depotPass(ops) {
      const I = this.I, touched = [];
      if (I.t < 2) return touched;
      const live = this.R.map((R, k) => k).filter(k => this.R[k].nodes.length);
      if (ops.has('routedepot')) for (const k of live) {
        const R = this.R[k]; let bd = -1e-7, bdp = -1;
        for (let d2 = 0; d2 < I.t; d2++) {
          if (d2 === R.d || R.load > I.Q[d2] + EPS || this.cnt[d2] >= I.fleet[d2]) continue;
          const c2 = rCost(I, d2, R.nodes); if (c2 + (R.dur - R.cost) > I.Dmax[d2] + EPS) continue;
          if (c2 - R.cost < bd) { bd = c2 - R.cost; bdp = d2; }
        }
        if (bdp >= 0) { const sv = R.dur - R.cost; this.cnt[R.d]--; this.cnt[bdp]++; R.d = bdp; R.cost = rCost(I, bdp, R.nodes); R.dur = R.cost + sv; this.stats.routedepot = (this.stats.routedepot || 0) + 1; touched.push(k); }
      }
      if (ops.has('depotswap')) for (let a = 0; a < live.length; a++) for (let b = a + 1; b < live.length; b++) {
        const A = this.R[live[a]], B = this.R[live[b]];
        if (!A.nodes.length || !B.nodes.length || A.d === B.d) continue;
        if (A.load > I.Q[B.d] + EPS || B.load > I.Q[A.d] + EPS) continue;
        const c1 = rCost(I, B.d, A.nodes), c2 = rCost(I, A.d, B.nodes);
        if (c1 + (A.dur - A.cost) > I.Dmax[B.d] + EPS || c2 + (B.dur - B.cost) > I.Dmax[A.d] + EPS) continue;
        if (c1 + c2 - A.cost - B.cost < -1e-7) {
          const sa = A.dur - A.cost, sb = B.dur - B.cost;
          const t = A.d; A.d = B.d; B.d = t; A.cost = c1; B.cost = c2; A.dur = c1 + sa; B.dur = c2 + sb;
          this.stats.depotswap = (this.stats.depotswap || 0) + 1; touched.push(live[a], live[b]);
        }
      }
      return touched;
    }
    solution() { return { routes: this.R.filter(r => r.nodes.length).map(r => ({ d: r.d, nodes: r.nodes.slice() })) }; }
  }

  function localSearch(I, sol, o) {
    o = o || {};
    const ops = new Set(o.ops || PRESETS.standard), rand = o.rand || mulberry32(o.seed || 1);
    const ls = new LS(I, sol, o.nb || neighbours(I, o.k || 12));
    ls.run(ops, rand, o.dirty);
    return { sol: ls.solution(), stats: ls.stats };
  }

  /* ------------------------------------------------------------------ ruin & recreate (SISR-style) */
  function ruinRecreate(I, S, rand, p, adj) {
    const n = I.n, N = I.N, D = I.D;
    let routes = S.routes.filter(r => r.nodes.length).map(r => ({ d: r.d, nodes: r.nodes.slice() }));
    const rid = new Int32Array(n).fill(-1);
    routes.forEach((r, k) => r.nodes.forEach(c => { rid[c] = k; }));
    const live = routes.length; let tot = 0; routes.forEach(r => { tot += r.nodes.length; });
    const lsMax = Math.min(p.lmax, tot / live), ksMax = 4 * p.cbar / (1 + lsMax) - 1;
    const ks = Math.floor(1 + rand() * ksMax);
    const seed = Math.floor(rand() * n), removed = [], gone = new Set(), ruined = new Set();
    for (const c of adj[seed]) {
      if (ruined.size >= ks) break;
      if (gone.has(c)) continue;
      const r = rid[c]; if (r < 0 || ruined.has(r)) continue;
      const route = routes[r].nodes, L = route.length, ltMax = Math.min(L, lsMax);
      const lt = Math.max(1, Math.floor(1 + rand() * ltMax)), pos = route.indexOf(c);
      let take;
      if (lt === L || rand() < 0.5) {
        const lo = Math.max(0, pos - lt + 1), hi = Math.min(pos, L - lt), s = lo + Math.floor(rand() * (hi - lo + 1));
        take = route.slice(s, s + lt); routes[r].nodes = route.slice(0, s).concat(route.slice(s + lt));
      } else {
        let m = 1; while (m < L - lt && rand() > p.alpha) m++;
        const w = lt + m, lo = Math.max(0, pos - w + 1), hi = Math.min(pos, L - w), s = lo + Math.floor(rand() * (hi - lo + 1));
        const win = route.slice(s, s + w), off = Math.floor(rand() * (lt + 1));
        take = win.slice(0, off).concat(win.slice(off + m));
        routes[r].nodes = route.slice(0, s).concat(win.slice(off, off + m), route.slice(s + w));
      }
      ruined.add(r); take.forEach(c2 => { removed.push(c2); gone.add(c2); });
    }
    routes = routes.filter(r => r.nodes.length);
    routes.forEach(r => { r.cost = rCost(I, r.d, r.nodes); r.load = load(I, r.nodes); r.sv = r.nodes.reduce((a, c) => a + I.srv[c], 0); });
    const cnt = new Array(I.t).fill(0); routes.forEach(r => cnt[r.d]++);
    // recreate
    const mode = (() => { const x = rand() * 11; return x < 4 ? 0 : x < 8 ? 1 : x < 10 ? 2 : 3; })();
    const nd = c => { let b = INF; for (let d = 0; d < I.t; d++) b = Math.min(b, D[c * N + n + d]); return b; };
    if (mode === 0) { for (let i = removed.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [removed[i], removed[j]] = [removed[j], removed[i]]; } }
    else if (mode === 1) removed.sort((a, b) => I.dem[b] - I.dem[a]);
    else if (mode === 2) removed.sort((a, b) => nd(b) - nd(a));
    else removed.sort((a, b) => nd(a) - nd(b));
    for (const c of removed) {
      let bestR = -1, bestP = -1, bd = INF;
      for (let r = 0; r < routes.length; r++) {
        const R = routes[r], d = R.d; if (R.load + I.dem[c] > I.Q[d] + EPS) continue;
        const nodes = R.nodes, L = nodes.length, dn = n + d; let prev = dn;
        for (let q = 0; q <= L; q++) {
          const nxt = q < L ? nodes[q] : dn;
          if (rand() >= p.blink) {
            const dl = D[prev * N + c] + D[c * N + nxt] - D[prev * N + nxt];
            if (dl < bd && R.cost + dl + R.sv + I.srv[c] <= I.Dmax[d] + EPS) { bd = dl; bestR = r; bestP = q; }
          }
          prev = nxt;
        }
      }
      if (bestR >= 0) { const R = routes[bestR]; R.nodes.splice(bestP, 0, c); R.cost += bd; R.load += I.dem[c]; R.sv += I.srv[c]; }
      else {
        const cand = []; for (let d = 0; d < I.t; d++) cand.push(d);
        cand.sort((a, b) => D[c * N + n + a] - D[c * N + n + b]);
        const d = cand.find(x => cnt[x] < I.fleet[x]); const dd = d === undefined ? cand[0] : d;
        routes.push({ d: dd, nodes: [c], cost: 2 * D[c * N + n + dd], load: I.dem[c], sv: I.srv[c] }); cnt[dd]++;
      }
    }
    return { routes: routes.map(r => ({ d: r.d, nodes: r.nodes })), removed };
  }

  /* resumable search: SISR-style (R&R + SA) or ILS (R&R + local search + SA) */
  function createSearch(I, init, cfg) {
    cfg = cfg || {};
    if (cfg.mode && cfg.mode !== 'sisr' && cfg.mode !== 'ils') {
      if (!engines[cfg.mode]) throw new Error('unknown method "' + cfg.mode + '" (is methods.js loaded?)');
      return createEngineSearch(I, init, cfg, engines[cfg.mode]);
    }
    const rand = mulberry32(cfg.seed || 1), mode = cfg.mode || 'sisr';
    const nb = neighbours(I, cfg.k || 12);
    const adj = []; for (let u = 0; u < I.n; u++) { const a = []; for (let v = 0; v < I.n; v++) a.push(v); a.sort((p, q) => I.D[u * I.N + p] - I.D[u * I.N + q]); adj.push(a); }
    const ops = new Set(cfg.ops || PRESETS.standard), iters = cfg.iters || 20000;
    const p = mode === 'sisr' ? { cbar: 10, lmax: 10, alpha: 0.01, blink: 0.01 } : { cbar: 6, lmax: 6, alpha: 0.01, blink: 0.01 };
    const obj = s => solCost(I, s) + PEN * excess(I, s);
    let cur = copySol(init);
    const stats = {};
    if (mode === 'ils') { const r = localSearch(I, cur, { ops, nb, rand }); cur = r.sol; for (const k in r.stats) stats[k] = (stats[k] || 0) + r.stats[k]; }
    let curO = obj(cur), best = copySol(cur), bestO = curO;
    const avg = solCost(I, cur) / (I.n + cur.routes.length);
    const T0 = (mode === 'sisr' ? 0.45 : 0.05) * avg, Tf = (mode === 'sisr' ? 0.0045 : 0.001) * avg;
    const cool = Math.pow(Tf / T0, 1 / iters);
    // hist entries: [iteration, best cost so far, active compute time in ms].  Time counts only the time spent inside
    // step()/stepFor(), so it is not inflated by the page being idle between slices.
    let T = T0, it = 0, active = 0, lastMove = null; const traceMoves = !!cfg.trace; const hist = [[0, solCost(I, best), 0]];
    return {
      get iter() { return it; }, get total() { return iters; }, get best() { return best; }, get current() { return cur; }, hist, stats,
      get bestCost() { return solCost(I, best); }, get seconds() { return active / 1000; }, get lastMove() { return lastMove; },
      stepFor(ms) {                                  // run steps for about ms milliseconds; true when finished
        const t0 = now(); let done = it >= iters; const chunk = mode === 'ils' ? 1 : 10;
        while (!done && now() - t0 < ms) done = this.step(chunk);
        return done;
      },
      step(k) {
        const t0 = now();
        for (let q = 0; q < k && it < iters; q++) {
          it++;
          const rr = ruinRecreate(I, cur, rand, p, adj);
          let cand = { routes: rr.routes };
          if (mode === 'ils') {
            const dirty = new Set(rr.removed);
            cand.routes.forEach(r => { if (r.nodes.some(c => dirty.has(c))) r.nodes.forEach(c => dirty.add(c)); });
            const r = localSearch(I, cand, { ops, nb, rand, dirty: [...dirty] });
            cand = r.sol; for (const kk in r.stats) stats[kk] = (stats[kk] || 0) + r.stats[kk];
          }
          const o = obj(cand);
          const acc = o < curO - T * Math.log(1 - rand());
          if (traceMoves) lastMove = { iter: it, removed: rr.removed.slice(), cand: cand.routes, candCost: solCost(I, cand), accepted: acc, T };
          if (acc) {
            cur = cand; curO = o;
            if (o < bestO - EPS) { best = copySol(cand); bestO = o; hist.push([it, solCost(I, best), active + (now() - t0)]); }
          }
          T *= cool;
        }
        active += now() - t0;
        return it >= iters;
      },
    };
  }

  const now = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());

  /* ---- generic engine wrapper used by every method registered in methods.js.
   * A method is a factory  (env, init) -> {one(), current}  where one() performs ONE iteration of the method
   * (one candidate solution / one individual / one move: see METHODS[id].unit) and reports improvements with
   * env.offer(sol[, objective]).  The wrapper provides the same resumable interface as createSearch
   * (iter, total, best, hist [iteration, best cost, active ms], seconds, step, stepFor), so Workers, the Solver page and
   * the tests treat all methods alike.  The search starts from the incumbent init, so best-so-far never exceeds it. */
  const engines = {};
  function createEngineSearch(I, init, cfg, factory) {
    const iters = cfg.iters || 20000, rand = mulberry32(cfg.seed || 1), stats = {};
    const obj = s => solCost(I, s) + PEN * excess(I, s);
    let it = 0, active = 0, t0 = now(), best = copySol(init), bestO = obj(best);
    const hist = [[0, solCost(I, best), 0]];
    const env = {
      I, rand, cfg, iters, obj, stats, params: cfg.params || {},
      get it() { return it; }, get bestO() { return bestO; }, get bestSol() { return best; },
      offer(sol, o) {
        if (o === undefined) o = obj(sol);
        if (o < bestO - EPS) {
          best = copySol(sol); bestO = o; const pt = [it, solCost(I, best), active + (now() - t0)];
          if (hist.length > 1 && hist[hist.length - 1][0] === it) hist[hist.length - 1] = pt; else hist.push(pt);        // one point per iteration (a method may improve twice in one)
          return true;
        }
        return false;
      },
    };
    const body = factory(env, copySol(init));
    return {
      get iter() { return it; }, get total() { return iters; }, get best() { return best; }, hist, stats,
      get current() { return body.current ? body.current : best; },
      get bestCost() { return solCost(I, best); }, get seconds() { return active / 1000; }, get lastMove() { return null; },
      stepFor(ms) {
        const a = now(); let done = it >= iters; const chunk = cfg.chunk || 10;
        while (!done && now() - a < ms) done = this.step(chunk);
        return done;
      },
      step(k) {
        t0 = now();
        for (let q = 0; q < k && it < iters; q++) { it++; body.one(); }
        active += now() - t0;
        return it >= iters;
      },
    };
  }

  /* One independent run (construction + metaheuristic) that can be advanced in time slices, so that a Web Worker or the
   * page itself can interleave it with message handling.  cfg: {construct: 'savings'|'sweep'|'nn', mode: 'sisr'|'ils',
   * iters, seed, ops, k}.  poll(ms) returns a progress message; result() the final one. */
  /* ---- custom methods ---------------------------------------------------------------------------------------------
   * A visitor's own method: JavaScript text that defines
   *     function customMethod(api, start) { ...; return function step() { ... }; }
   * customMethod is called once per run with a feasible start solution; the returned function performs one iteration and
   * is called until the budget ends.  Solutions are { routes: [ { d: depot index, nodes: [customer indices] }, ... ] } with
   * customers 0..n-1 and depots 0..t-1.  The method tells the engine about solutions with api.report(solution); the engine
   * checks every reported solution itself and keeps the best feasible one, so a wrong cost cannot be claimed.
   * The code is compiled only here; the page runs it in a Web Worker without network access (see worker.js and solver.js). */
  function compileCustom(code) {
    if (typeof code !== 'string' || !code.trim()) throw new Error('the custom method is empty');
    if (code.length > 200000) throw new Error('the custom method is longer than 200 000 characters');
    let make;
    try { make = new Function('"use strict";\n' + code + '\n;return typeof customMethod === "function" ? customMethod : null;')(); }
    catch (e) { throw new Error('custom method does not compile: ' + (e && e.message || e)); }
    if (!make) throw new Error('custom method: the code must define  function customMethod(api, start)');
    return function (env, init) {
      const I = env.I, N = I.N, n = I.n, t = I.t;
      const norm = (sol, what) => {                                    // structural check; returns a clean copy
        if (!sol || !Array.isArray(sol.routes)) throw new Error('custom method: ' + what + ' needs a solution { routes: [ { d, nodes: [...] } ] }');
        const routes = [];
        for (const r of sol.routes) {
          if (!r || !Array.isArray(r.nodes)) throw new Error('custom method: ' + what + ': every route needs a nodes array');
          const d = r.d === undefined ? 0 : r.d;
          if (!Number.isInteger(d) || d < 0 || d >= t) throw new Error('custom method: ' + what + ': depot index ' + d + ' is not in 0..' + (t - 1));
          for (const c of r.nodes) if (!Number.isInteger(c) || c < 0 || c >= n) throw new Error('custom method: ' + what + ': customer index ' + c + ' is not in 0..' + (n - 1));
          if (r.nodes.length) routes.push({ d, nodes: r.nodes.slice() });
        }
        return { routes };
      };
      const nodesOf = (d, nodes, what) => norm({ routes: [{ d, nodes }] }, what).routes[0] || { d, nodes: [] };
      const ops = (env.cfg.ops && env.cfg.ops.length ? env.cfg.ops : PRESETS.full).filter(o => t > 1 || (o !== 'routedepot' && o !== 'depotswap'));
      let nb = null;
      const arr = a => Object.freeze(Array.from(a));
      const instance = Object.freeze({
        name: I.name, customers: n, depots: t, demand: arr(I.dem), service: arr(I.srv), capacity: arr(I.Q), maxDuration: arr(I.Dmax), fleet: arr(I.fleet),
        x: arr(I.x), y: arr(I.y),                                      // customers first, then depots
        dist: (i, j) => I.D[i * N + j],                                // nodes: customers 0..n-1, depot d is node n + d
        depotNode: d => n + d
      });
      const api = Object.freeze({
        instance, iterations: env.iters,
        get iteration() { return env.it; },
        random: env.rand,
        randomInt: k => Math.floor(env.rand() * k),
        copy: sol => norm(sol, 'copy()'),
        cost: sol => solCost(I, norm(sol, 'cost()')),
        violations: sol => violations(I, norm(sol, 'violations()')),
        feasible: sol => violations(I, norm(sol, 'feasible()')).length === 0,
        routeCost: (d, nodes) => { const r = nodesOf(d, nodes, 'routeCost()'); return rCost(I, r.d, r.nodes); },
        routeFeasible: (d, nodes) => { const r = nodesOf(d, nodes, 'routeFeasible()'); return feasibleRoute(I, r.d, r.nodes); },
        nearestDepot: c => nearestDepot(I, nodesOf(0, [c], 'nearestDepot()').nodes[0]),
        savings: () => copySol(savings(I)),
        localSearch: sol => {
          const s = norm(sol, 'localSearch()');
          if (violations(I, s).length) throw new Error('custom method: localSearch() needs a feasible solution');
          return localSearch(I, s, { ops, nb: nb || (nb = neighbours(I, env.cfg.k || 12)), rand: env.rand }).sol;
        },
        report: sol => {
          const s = norm(sol, 'report()');
          if (violations(I, s).length) { env.stats.rejectedReports = (env.stats.rejectedReports || 0) + 1; return false; }
          return env.offer(s, solCost(I, s));
        },
        best: () => copySol(env.bestSol),
        bestCost: () => solCost(I, env.bestSol)
      });
      const body = make(api, copySol(init));
      const step = typeof body === 'function' ? body : body && typeof body.step === 'function' ? () => body.step() : null;
      if (!step) throw new Error('custom method: customMethod must return a function that performs one iteration (or an object with a step function)');
      return { one: step };
    };
  }
  function setCustom(code) { engines.custom = compileCustom(code); }

  /* Common start of a run. A construction can exceed the fleet of a depot when the fleet is tight (Cordeau pr instances), and
   * several methods never leave such a start. As in the reference C++ driver, the start is then repaired once, deterministically,
   * by short penalised ruin-and-recreate runs with a fixed seed, and every method starts from the repaired solution.
   * A feasible construction is returned unchanged (the usual case). The repair is not part of the time budget. */
  const startCache = new Map();
  function commonStart(I, construct) {
    const init = construct === 'sweep' ? sweep(I) : construct === 'nn' ? nearestNeighbour(I) : savings(I);
    if (!violations(I, init).length) return { sol: init, repaired: false };
    let h = 0; for (let i = 0; i < I.N; i++) h += I.D[i] * (i + 1);                           // same name, another file: another key
    const key = [I.name, I.n, I.t, construct || 'savings', I.fleet.join('.'), I.Q.join('.'), I.Dmax.join('.'), h].join('|');
    if (startCache.has(key)) return { sol: copySol(startCache.get(key)), repaired: true };
    for (const iters of [20000, 80000, 320000]) {
      const S = createSearch(I, init, { mode: 'sisr', iters, seed: 987654321, ops: PRESETS.full, k: 12 }); S.step(Infinity);
      if (!violations(I, S.best).length) {
        if (startCache.size > 8) startCache.clear();
        startCache.set(key, copySol(S.best)); return { sol: copySol(S.best), repaired: true };
      }
    }
    return { sol: init, repaired: false };
  }

  function createJob(I, cfg) {
    const start = commonStart(I, cfg.construct), init = start.sol;
    const initCost = solCost(I, init) + PEN * excess(I, init);
    const S = createSearch(I, init, { mode: cfg.mode, iters: cfg.iters, seed: cfg.seed, ops: cfg.ops, k: cfg.k, params: cfg.params, chunk: cfg.mode === 'custom' ? 1 : undefined });
    let sent = 0, sentBest = Infinity;
    const progress = done => {
      const m = { iter: S.iter, total: S.total, seconds: S.seconds, cost: S.bestCost, initCost, hist: S.hist.slice(sent), done };
      sent = S.hist.length;
      if (S.bestCost < sentBest - EPS) { sentBest = S.bestCost; m.sol = copySol(S.best); }
      return m;
    };
    return {
      poll(ms) { return progress(S.stepFor(ms)); },
      result(stopped) {
        const best = copySol(S.best), v = violations(I, best);
        return { sol: best, cost: solCost(I, best), violations: v, iter: S.iter, total: S.total, seconds: S.seconds, initCost,
          stats: Object.assign({}, S.stats), hist: S.hist.slice(), stopped: !!stopped, startRepaired: start.repaired };
      },
    };
  }

  return { mulberry32, parseInstance, parseCordeau, parseVRPLIB, parseCSV, parseMatrixTable, checkMatrix, layoutFromMatrix, haversineKm, generate, finish, solCost, rCost, violations, savings, sweep, nearestNeighbour,
    localSearch, neighbours, createSearch, createJob, commonStart, compileCustom, setCustom, copySol, OPS, PRESETS, excess, repairFleet, engines, METHODS: {},
    internals: { LS, rCost, solCost, excess, copySol, feasibleRoute, neighbours, localSearch, repairFleet, nearestDepot, mulberry32, load, now, PEN, EPS, INF, PRESETS, ruinRecreate } };
});

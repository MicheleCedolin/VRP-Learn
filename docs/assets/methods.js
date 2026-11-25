/* methods.js - the metaheuristics of the browser Solver (all sharing the engine of vrp.js).
 *
 * Every method is a factory registered in VRP.engines:  (env, init) -> { one(), current }.  one() performs one iteration
 * (the unit of work is stated in VRP.METHODS[id].unit); env.offer(sol) reports a candidate for the best-so-far.  The
 * wrapper of vrp.js supplies seeds, history, time accounting and resumable stepping, so all methods are used alike.
 *
 * Methods (families as in the Learn page):
 *   trajectory   sa  ta  rtr  tabu  vns            (random single-customer / route-pair moves, 5 operators)
 *   multi-start  grasp  msls
 *   destroy/rep. alns  lns  ig                      (random / worst / related removal, greedy / regret-2 insertion)
 *   population   ga  aco  grasppr  scatter
 *   random-key   brkga  pso  de  rkrs               (keys -> priorities -> giant tours -> optimal split)
 *   (sisr and ils live in vrp.js)
 * All are teaching-grade, written from the cited literature. Seven of them (sisr, ta, rtr, grasp, lns, aco, pso) run with
 * parameters tuned with irace (VRP.TUNED_PARAMS in vrp.js); the others use the values of the cited papers.
 * Operators work on the same solution model as the local search of vrp.js (any depot may serve any customer).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./vrp.js'));
  else factory(root.VRP);
})(typeof self !== 'undefined' ? self : this, function (V) {
  'use strict';
  const { LS, rCost, solCost, copySol, repairFleet, neighbours, localSearch, PRESETS, EPS, INF } = V.internals;
  const E = V.engines;
  const rint = (rand, n) => Math.floor(rand() * n);
  const shuffle = (a, rand) => { for (let i = a.length - 1; i > 0; i--) { const j = rint(rand, i + 1); const t = a[i]; a[i] = a[j]; a[j] = t; } return a; };

  /* ------------------------------------------------------------------ shared context (per instance) */
  const ctxCache = new WeakMap();
  function ctxOf(I, cfg) {
    const k = (cfg && cfg.k) || 12; let c = ctxCache.get(I);
    if (c && c.k === k) return c;
    const adj = []; for (let u = 0; u < I.n; u++) { const a = []; for (let v = 0; v < I.n; v++) if (v !== u) a.push(v); a.sort((p, q) => I.D[u * I.N + p] - I.D[u * I.N + q]); adj.push(a); }
    const depotOrder = []; for (let c2 = 0; c2 < I.n; c2++) { const o = []; for (let d = 0; d < I.t; d++) o.push(d); o.sort((a, b) => I.D[c2 * I.N + I.n + a] - I.D[c2 * I.N + I.n + b]); depotOrder.push(o); }
    c = { k, nb: neighbours(I, k), adj, depotOrder }; ctxCache.set(I, c); return c;
  }
  const opsFor = (I, cfg) => (cfg && cfg.ops && cfg.ops.length ? cfg.ops.filter(o => I.t > 1 || (o !== 'routedepot' && o !== 'depotswap')) : (I.t > 1 ? PRESETS.full : PRESETS.standard));     // the operators chosen on the Solver page, else a default
  const descend = (I, ctx, env, sol, dirty) => localSearch(I, sol, { ops: opsFor(I, env.cfg), nb: ctx.nb, rand: env.rand, dirty }).sol;

  /* ------------------------------------------------------------------ random moves on the local-search state */
  const KINDS = ['relocate', 'oropt', 'swap', 'twoopt', 'twooptstar'];
  const KINDS_NEW = KINDS.concat(['newroute']);
  /* one random move between a random customer u and a random granular neighbour v; null if infeasible/degenerate.
   * Result: {name, delta, ra, rb, na, nb, [kind, d], puts: [[customer, destination route]], leaves: [[customer, origin route]]} */
  LS.prototype.randomMove = function (rand, kinds) {
    const I = this.I, u = rint(rand, I.n), ra = this.where[u], A = this.R[ra], an = A.nodes, i = this.pos[u], LA = an.length;
    const kind = kinds[rint(rand, kinds.length)];
    if (kind === 'newroute') {                                   // open a new route at one of the two nearest depots
      if (LA < 2) return null;
      const order = []; for (let d = 0; d < I.t; d++) order.push(d);
      order.sort((a, b) => I.D[u * I.N + I.n + a] - I.D[u * I.N + I.n + b]);
      const d = order[rint(rand, Math.min(2, order.length))];
      if (this.cnt[d] >= I.fleet[d]) return null;
      const na = an.slice(0, i).concat(an.slice(i + 1)), nb = [u], ca = rCost(I, A.d, na), cb = rCost(I, d, nb);
      if (ca + (A.dur - A.cost) - I.srv[u] > I.Dmax[A.d] + EPS) return null;
      if (cb + I.srv[u] > I.Dmax[d] + EPS || I.dem[u] > I.Q[d] + EPS) return null;
      return { name: 'newroute', kind: 'new', delta: ca + cb - A.cost, ra, rb: null, na, nb, d, puts: [[u, -1]], leaves: [[u, ra]] };
    }
    const neigh = this.nb[u]; if (!neigh.length) return null;
    const v = neigh[rint(rand, neigh.length)], rb = this.where[v], B = this.R[rb], bn = B.nodes, j = this.pos[v];
    let na, nb = null, rbOut = rb, puts = [], leaves = [];
    if (kind === 'relocate' || kind === 'oropt') {
      const l = kind === 'relocate' ? 1 : 2 + rint(rand, 2);
      if (i + l > LA) return null;
      const seg = an.slice(i, i + l), s = (l > 1 && rand() < 0.5) ? seg.slice().reverse() : seg, after = rand() < 0.5 ? 1 : 0;
      if (rb === ra) {
        if (j >= i && j < i + l) return null;
        const rest = an.slice(0, i).concat(an.slice(i + l)), jj = j > i ? j - l : j, p = jj + after;
        na = rest.slice(0, p).concat(s, rest.slice(p)); rbOut = null;
      } else {
        na = an.slice(0, i).concat(an.slice(i + l)); const p = j + after; nb = bn.slice(0, p).concat(s, bn.slice(p));
        puts = seg.map(c => [c, rb]); leaves = seg.map(c => [c, ra]);
      }
    } else if (kind === 'swap') {
      if (rb === ra) { if (i === j) return null; na = an.slice(); na[i] = v; na[j] = u; rbOut = null; }
      else { na = an.slice(); nb = bn.slice(); na[i] = v; nb[j] = u; puts = [[u, rb], [v, ra]]; leaves = [[u, ra], [v, rb]]; }
    } else if (kind === 'twoopt') {
      if (rb !== ra || i === j) return null;
      const lo = Math.min(i, j), hi = Math.max(i, j); if (hi - lo < 2) return null;
      na = an.slice(0, lo + 1).concat(an.slice(lo + 1, hi + 1).reverse(), an.slice(hi + 1)); rbOut = null;
    } else {                                                     // twooptstar (tail exchange; reversed variant only for a common depot)
      if (rb === ra) return null;
      if (A.d === B.d && rand() < 0.5) { na = an.slice(0, i + 1).concat(bn.slice(0, j + 1).reverse()); nb = an.slice(i + 1).reverse().concat(bn.slice(j + 1)); }
      else { na = an.slice(0, i + 1).concat(bn.slice(j + 1)); nb = bn.slice(0, j + 1).concat(an.slice(i + 1)); }
    }
    const delta = this.pair(ra, na, rbOut, nb);
    if (delta === null) return null;
    return { name: kind, delta, ra, rb: rbOut, na, nb, puts, leaves };
  };
  /* apply s random feasible moves regardless of their cost (shaking); returns the touched customers */
  function shake(ls, s, rand, kinds) {
    const touched = new Set(); let done = 0, tries = 0;
    while (done < s && tries < 30 * s) {
      tries++; const m = ls.randomMove(rand, kinds); if (!m) continue;
      ls.apply(m); done++; m.na.forEach(c => touched.add(c)); if (m.nb) m.nb.forEach(c => touched.add(c));
    }
    return touched;
  }

  /* ------------------------------------------------------------------ giant tours, optimal split, random-key decoder */
  /* optimal split of a giant tour for depot d (Prins 2004): shortest path over tour positions, capacity and duration respected */
  function splitTour(I, d, tour) {
    const m = tour.length, dn = I.n + d, D = I.D, N = I.N, Q = I.Q[d], Dm = I.Dmax[d];
    const f = new Float64Array(m + 1).fill(INF), pred = new Int32Array(m + 1).fill(-1); f[0] = 0;
    for (let i = 0; i < m; i++) {
      if (f[i] === INF) continue;
      let q = 0, sv = 0, c = 0;
      for (let j = i; j < m; j++) {
        const v = tour[j];
        q += I.dem[v]; sv += I.srv[v]; c += j === i ? D[dn * N + v] : D[tour[j - 1] * N + v];
        if (q > Q + EPS) break;
        const full = c + D[v * N + dn];
        if (full + sv > Dm + EPS && j > i) break;
        if (f[i] + full < f[j + 1]) { f[j + 1] = f[i] + full; pred[j + 1] = i; }
      }
    }
    const routes = []; let j = m;
    if (f[m] === INF) { tour.forEach(c => routes.push({ d, nodes: [c] })); return routes; }
    while (j > 0) { const i = pred[j]; routes.push({ d, nodes: tour.slice(i, j) }); j = i; }
    return routes.reverse();
  }
  /* keys: n customer priorities, then (if several depots) n depot keys; a customer goes to its nearest depot unless its depot key is >= 0.75 (second nearest) */
  function decodeKeys(I, ctx, keys) {
    const n = I.n, per = []; for (let d = 0; d < I.t; d++) per.push([]);
    for (let c = 0; c < n; c++) { const o = ctx.depotOrder[c]; per[I.t > 1 && o.length > 1 && keys[n + c] >= 0.75 ? o[1] : o[0]].push(c); }
    const routes = [];
    for (let d = 0; d < I.t; d++) if (per[d].length) { per[d].sort((a, b) => keys[a] - keys[b]); splitTour(I, d, per[d]).forEach(r => routes.push(r)); }
    return repairFleet(I, { routes });
  }
  const keyLen = I => (I.t > 1 ? 2 * I.n : I.n);
  const randomKeys = (I, rand) => { const k = new Float64Array(keyLen(I)); for (let i = 0; i < k.length; i++) k[i] = rand(); return k; };
  /* a permutation of all customers -> solution (nearest depot, optimal split) */
  function decodeTour(I, ctx, tour) { const keys = new Float64Array(keyLen(I)); tour.forEach((c, p) => { keys[c] = p; }); return decodeKeys(I, ctx, keys); }
  /* solution -> giant tour: routes ordered by depot, then by the polar angle of their centroid around the depot */
  function giantTour(I, sol) {
    const rs = sol.routes.filter(r => r.nodes.length).map(r => {
      const dn = I.n + r.d; let sx = 0, sy = 0; r.nodes.forEach(c => { sx += I.x[c]; sy += I.y[c]; });
      return { r, ang: Math.atan2(sy / r.nodes.length - I.y[dn], sx / r.nodes.length - I.x[dn]) };
    });
    rs.sort((a, b) => a.r.d - b.r.d || a.ang - b.ang);
    const t = []; rs.forEach(x => x.r.nodes.forEach(c => t.push(c))); return t;
  }
  const orderCrossover = (a, b, rand) => {                       // OX on permutations
    const n = a.length; let i = rint(rand, n), j = rint(rand, n); if (i > j) { const t = i; i = j; j = t; }
    const child = new Array(n).fill(-1), used = new Uint8Array(n);
    for (let k = i; k <= j; k++) { child[k] = a[k]; used[a[k]] = 1; }
    let p = (j + 1) % n; for (let q = 0; q < n; q++) { const c = b[(j + 1 + q) % n]; if (!used[c]) { child[p] = c; p = (p + 1) % n; } }
    return child;
  };

  /* ------------------------------------------------------------------ randomised greedy construction (GRASP) */
  function graspConstruct(I, ctx, rand, alpha) {
    const N = I.N, D = I.D, routes = [], todo = []; for (let d = 0; d < I.t; d++) todo.push([]);
    for (let c = 0; c < I.n; c++) todo[ctx.depotOrder[c][0]].push(c);
    for (let d = 0; d < I.t; d++) {
      const dn = I.n + d, left = todo[d];
      while (left.length) {
        const cur = []; let q = 0, pos = dn, dur = 0;
        for (;;) {
          const cand = [];
          for (let k = 0; k < left.length; k++) {
            const c = left[k];
            if (q + I.dem[c] > I.Q[d] + EPS || dur + D[pos * N + c] + I.srv[c] + D[c * N + dn] > I.Dmax[d] + EPS) continue;
            cand.push([D[pos * N + c], k]);
          }
          if (!cand.length) break;
          cand.sort((a, b) => a[0] - b[0]);
          const pick = cand[rint(rand, Math.max(1, Math.ceil(alpha * cand.length)))], c = left[pick[1]];
          left.splice(pick[1], 1); cur.push(c); q += I.dem[c]; dur += D[pos * N + c] + I.srv[c]; pos = c;
        }
        if (!cur.length) cur.push(left.pop());
        routes.push({ d, nodes: cur });
      }
    }
    return repairFleet(I, { routes });
  }

  /* ------------------------------------------------------------------ destroy / repair on route lists */
  function mkPart(I, sol) {
    const P = { I, routes: sol.routes.filter(r => r.nodes.length).map(r => ({ d: r.d, nodes: r.nodes.slice() })), cnt: new Array(I.t).fill(0), where: new Int32Array(I.n).fill(-1) };
    P.routes.forEach((r, k) => { fixRoute(I, r); P.cnt[r.d]++; r.nodes.forEach(c => { P.where[c] = k; }); });
    return P;
  }
  function fixRoute(I, r) { r.cost = rCost(I, r.d, r.nodes); let q = 0, s = 0; for (const c of r.nodes) { q += I.dem[c]; s += I.srv[c]; } r.load = q; r.sv = s; }
  function compact(P) {
    P.routes = P.routes.filter(r => r.nodes.length); P.cnt.fill(0);
    P.routes.forEach((r, k) => { P.cnt[r.d]++; r.nodes.forEach(c => { P.where[c] = k; }); });
  }
  const partSol = P => ({ routes: P.routes.filter(r => r.nodes.length).map(r => ({ d: r.d, nodes: r.nodes })) });
  function removeCust(P, c) {
    const R = P.routes[P.where[c]]; R.nodes.splice(R.nodes.indexOf(c), 1); fixRoute(P.I, R); P.where[c] = -1;
  }
  function removalGain(P, R, i) {
    const I = P.I, N = I.N, D = I.D, dn = I.n + R.d, c = R.nodes[i], pv = i ? R.nodes[i - 1] : dn, nx = i + 1 < R.nodes.length ? R.nodes[i + 1] : dn;
    return D[pv * N + c] + D[c * N + nx] - D[pv * N + nx];
  }
  const DESTROY = {
    random(P, q, rand) { const all = []; for (let c = 0; c < P.I.n; c++) all.push(c); shuffle(all, rand); const rm = all.slice(0, q); rm.forEach(c => removeCust(P, c)); return rm; },
    worst(P, q, rand) {                                          // Ropke & Pisinger: remove customers with the largest removal gain, with randomisation p = 3
      const rm = [];
      for (let k = 0; k < q; k++) {
        const cand = []; P.routes.forEach(R => R.nodes.forEach((c, i) => cand.push([removalGain(P, R, i), c])));
        if (!cand.length) break; cand.sort((a, b) => b[0] - a[0]);
        const c = cand[Math.floor(Math.pow(rand(), 3) * cand.length)][1]; removeCust(P, c); rm.push(c);
      }
      return rm;
    },
    related(P, q, rand, ctx) {                                   // Shaw removal by distance relatedness, randomisation p = 3
      const rm = [rint(rand, P.I.n)], gone = new Uint8Array(P.I.n); gone[rm[0]] = 1;
      while (rm.length < q) {
        const r = rm[rint(rand, rm.length)], cand = [];
        for (const c of ctx.adj[r]) { if (!gone[c]) { cand.push(c); if (cand.length >= 24) break; } }
        if (!cand.length) break;
        const c = cand[Math.floor(Math.pow(rand(), 3) * cand.length)]; gone[c] = 1; rm.push(c);
      }
      rm.forEach(c => removeCust(P, c)); return rm;
    },
  };
  /* cheapest feasible insertion of c into route R: {delta, p} or null */
  function bestPos(P, R, c) {
    const I = P.I, N = I.N, D = I.D, d = R.d, dn = I.n + d;
    if (R.load + I.dem[c] > I.Q[d] + EPS) return null;
    const nodes = R.nodes, L = nodes.length; let prev = dn, bd = INF, bp = -1;
    for (let p = 0; p <= L; p++) {
      const nx = p < L ? nodes[p] : dn, dl = D[prev * N + c] + D[c * N + nx] - D[prev * N + nx];
      if (dl < bd && R.cost + dl + R.sv + I.srv[c] <= I.Dmax[d] + EPS) { bd = dl; bp = p; }
      prev = nx;
    }
    return bp < 0 ? null : { delta: bd, p: bp };
  }
  function openRoute(P, c) {                                     // new route at the nearest depot that still has fleet
    const I = P.I, o = []; for (let d = 0; d < I.t; d++) o.push(d);
    o.sort((a, b) => I.D[c * I.N + I.n + a] - I.D[c * I.N + I.n + b]);
    const d = o.find(x => P.cnt[x] < I.fleet[x]), dd = d === undefined ? o[0] : d;
    const R = { d: dd, nodes: [c] }; fixRoute(I, R); P.routes.push(R); P.cnt[dd]++; P.where[c] = P.routes.length - 1; return R;
  }
  function insertAt(P, R, p, c) { R.nodes.splice(p, 0, c); fixRoute(P.I, R); P.where[c] = P.routes.indexOf(R); }
  const REPAIR = {
    greedy(P, rm, rand) {                                        // random order, cheapest feasible insertion over all routes of all depots
      shuffle(rm, rand);
      for (const c of rm) {
        let bR = null, bp = -1, bd = INF;
        for (const R of P.routes) { const x = bestPos(P, R, c); if (x && x.delta < bd) { bd = x.delta; bR = R; bp = x.p; } }
        if (bR) insertAt(P, bR, bp, c); else openRoute(P, c);
      }
    },
    regret2(P, rm) {                                             // insert the customer with the largest difference between its best and second-best route
      const left = rm.slice();
      while (left.length) {
        let pc = -1, pR = null, pp = -1, pr = -INF;
        for (let k = 0; k < left.length; k++) {
          const c = left[k]; let b1 = INF, b2 = INF, R1 = null, p1 = -1;
          for (const R of P.routes) { const x = bestPos(P, R, c); if (!x) continue; if (x.delta < b1) { b2 = b1; b1 = x.delta; R1 = R; p1 = x.p; } else if (x.delta < b2) b2 = x.delta; }
          const reg = R1 ? (b2 === INF ? 1e9 - b1 : b2 - b1) : -INF + 1;
          if (R1 && reg > pr) { pr = reg; pc = k; pR = R1; pp = p1; }
          else if (!R1 && pc < 0) { pc = k; pR = null; }          // nothing feasible: handled below
        }
        const c = left.splice(pc, 1)[0];
        if (pR) insertAt(P, pR, pp, c); else openRoute(P, c);
      }
    },
  };
  function destroyRepair(I, ctx, rand, sol, dName, rName, q) {
    const P = mkPart(I, sol), rm = DESTROY[dName](P, q, rand, ctx); compact(P);
    REPAIR[rName](P, rm.slice(), rand); compact(P);
    return partSol(P);
  }
  const qRange = (I, lo, hi) => [Math.max(2, Math.ceil(lo * I.n)), Math.max(3, Math.min(60, Math.ceil(hi * I.n)))];

  V.methodsInternals = { ctxOf, decodeKeys, decodeTour, giantTour, splitTour, graspConstruct, destroyRepair, DESTROY, REPAIR, shake, randomKeys, keyLen, orderCrossover, descend, opsFor, KINDS, KINDS_NEW, mkPart, rint, shuffle, qRange };
    const M = V.methodsInternals;

  /* ================================================================== trajectory methods */
  /* common skeleton of sa / ta / rtr: random move, accept by a rule, keep the best */
  function walker(accept) {
    return (env, init) => {
      const I = env.I, rand = env.rand, ctx = ctxOf(I, env.cfg), ls = new LS(I, init, ctx.nb), kinds = KINDS_NEW;
      let cur = solCost(I, init); const avg = cur / (I.n + init.routes.length);
      const rule = accept(env, avg);
      return {
        one() {
          const m = ls.randomMove(rand, kinds); if (!m) return;
          if (rule(m.delta, cur, env.it)) {
            ls.apply(m); cur += m.delta;
            if (cur < env.bestO - 1e-7) { const sol = ls.solution(); env.offer(sol); cur = solCost(I, sol); }
          }
        },
        get current() { return ls.solution(); },
      };
    };
  }

  /* sa: simulated annealing (Kirkpatrick et al. 1983) on random feasible moves; geometric cooling in `cycles` cycles, each restarting
   * (reheating) at reheat x the previous start temperature.  Temperatures are relative to the mean edge length. */
  E.sa = walker((env, avg) => {
    const P = Object.assign({ t0: 0.1, tf: 0.002, cycles: 3, reheat: 0.5 }, env.params), len = Math.ceil(env.iters / P.cycles);
    return (delta, cur, it) => {
      const c = Math.floor((it - 1) / len), k = (it - 1) - c * len, T0 = P.t0 * avg * Math.pow(P.reheat, c), Tf = Math.min(P.tf * avg, T0 * 0.05);
      const T = T0 * Math.pow(Tf / T0, k / len);
      return delta <= 0 || env.rand() < Math.exp(-delta / T);
    };
  });
  /* ta: threshold accepting (Dueck & Scheuer 1990): accept every move that worsens the cost by less than a threshold that shrinks linearly to 0 */
  E.ta = walker((env, avg) => {
    const P = Object.assign({ th0: 0.05 }, env.params);
    return (delta, cur, it) => delta <= P.th0 * avg * (1 - (it - 1) / env.iters);
  });
  /* rtr: record-to-record travel (Dueck 1993): accept a move if the new cost stays within (1 + dev) of the best cost found (the record); dev shrinks linearly */
  E.rtr = walker((env) => {
    const P = Object.assign({ dev0: 0.02 }, env.params);
    return (delta, cur, it) => cur + delta <= env.bestO * (1 + P.dev0 * (1 - (it - 1) / env.iters)) + 1e-9;
  });
  /* tabu: tabu search (Glover 1989) with a randomised candidate list: one iteration samples cs random moves and applies the best one that is
   * not tabu (or that beats the best solution, aspiration).  Attribute: a customer that left route r may not re-enter r for `tenure` iterations. */
  E.tabu = (env, init) => {
    const I = env.I, rand = env.rand, ctx = ctxOf(I, env.cfg), P = Object.assign({ cs: 30, tenure: 8, spread: 8 }, env.params);
    const ls = new LS(I, init, ctx.nb), tabu = new Map(); let cur = solCost(I, init);
    const key = (c, r) => c * 1000003 + r;
    return {
      one() {
        let best = null;
        for (let q = 0; q < P.cs; q++) {
          const m = ls.randomMove(rand, KINDS_NEW); if (!m) continue;
          let isTabu = false;
          for (const pr of m.puts) { const e = tabu.get(key(pr[0], pr[1])); if (e !== undefined && e > env.it) { isTabu = true; break; } }
          if (isTabu && !(cur + m.delta < env.bestO - EPS)) continue;
          if (!best || m.delta < best.delta) best = m;
        }
        if (!best) return;
        ls.apply(best); cur += best.delta;
        for (const lv of best.leaves) tabu.set(key(lv[0], lv[1]), env.it + P.tenure + rint(rand, P.spread + 1));
        if (tabu.size > 60000) for (const [k, e] of tabu) if (e <= env.it) tabu.delete(k);
        if (cur < env.bestO - 1e-7) { const sol = ls.solution(); env.offer(sol); cur = solCost(I, sol); }
      },
      get current() { return ls.solution(); },
    };
  };
  /* vns: basic variable neighbourhood search (Mladenovic & Hansen 1997): shake with 2k random moves (k = 1..kmax), local search, move if better, else k + 1 */
  E.vns = (env, init) => {
    const I = env.I, rand = env.rand, ctx = ctxOf(I, env.cfg), P = Object.assign({ kmax: 5 }, env.params), ops = new Set(M.opsFor(I, env.cfg));
    let cur = copySol(init), curO = env.obj(cur), k = 1;
    return {
      one() {
        const ls = new LS(I, cur, ctx.nb), touched = M.shake(ls, 2 * k, rand, KINDS);
        ls.run(ops, rand, [...touched]);
        const cand = ls.solution(), o = env.obj(cand);
        if (o < curO - EPS) { cur = cand; curO = o; k = 1; env.offer(cand, o); } else k = k % P.kmax + 1;
      },
      get current() { return cur; },
    };
  };

  /* ================================================================== multi-start methods */
  /* grasp: greedy randomised adaptive search (Feo & Resende 1995): randomised nearest-neighbour construction (restricted candidate list alpha) + local search */
  E.grasp = (env, init) => {
    const I = env.I, ctx = ctxOf(I, env.cfg), P = Object.assign({ alpha: 0.2 }, env.params); let last = null;
    return { one() { last = M.descend(I, ctx, env, M.graspConstruct(I, ctx, env.rand, P.alpha)); env.offer(last); }, get current() { return last || env.bestSol; } };
  };
  /* msls: multi-start local search from random-key decodes (random priorities -> giant tour -> optimal split) */
  E.msls = (env, init) => {
    const I = env.I, ctx = ctxOf(I, env.cfg); let last = null;
    return { one() { last = M.descend(I, ctx, env, M.decodeKeys(I, ctx, M.randomKeys(I, env.rand))); env.offer(last); }, get current() { return last || env.bestSol; } };
  };

  /* ================================================================== destroy & repair methods */
  const D_NAMES = ['random', 'worst', 'related'], R_NAMES = ['greedy', 'regret2'];
  /* alns: adaptive large neighbourhood search (Ropke & Pisinger 2006): 3 destroy and 2 repair operators chosen by roulette wheel on weights adapted
   * every `seg` iterations from the scores (new best / better / accepted worse); simulated-annealing acceptance */
  E.alns = (env, init) => {
    const I = env.I, rand = env.rand, ctx = ctxOf(I, env.cfg), P = Object.assign({ t0: 0.1, tf: 0.001, seg: 100, rho: 0.1, s1: 33, s2: 9, s3: 3, qlo: 0.05, qhi: 0.2 }, env.params);
    const [qa, qb] = M.qRange(I, P.qlo, P.qhi);
    let cur = copySol(init), curO = env.obj(cur); const avg = solCost(I, cur) / (I.n + cur.routes.length);
    const T0 = P.t0 * avg, Tf = P.tf * avg, cool = Math.pow(Tf / T0, 1 / env.iters); let T = T0;
    const w = { d: [1, 1, 1], r: [1, 1] }, sc = { d: [0, 0, 0], r: [0, 0] }, us = { d: [0, 0, 0], r: [0, 0] };
    const roulette = ws => { let s = 0; ws.forEach(x => { s += x; }); let x = rand() * s; for (let i = 0; i < ws.length; i++) { x -= ws[i]; if (x <= 0) return i; } return ws.length - 1; };
    return {
      one() {
        const di = roulette(w.d), ri = roulette(w.r), q = qa + rint(rand, qb - qa + 1);
        const cand = M.destroyRepair(I, ctx, rand, cur, D_NAMES[di], R_NAMES[ri], q), o = env.obj(cand);
        let score = 0;
        if (o < curO - T * Math.log(1 - rand())) {
          if (o < env.bestO - EPS) { score = P.s1; env.offer(cand, o); } else if (o < curO - EPS) score = P.s2; else score = P.s3;
          cur = cand; curO = o;
        }
        sc.d[di] += score; sc.r[ri] += score; us.d[di]++; us.r[ri]++;
        env.stats['d:' + D_NAMES[di]] = (env.stats['d:' + D_NAMES[di]] || 0) + 1; env.stats['r:' + R_NAMES[ri]] = (env.stats['r:' + R_NAMES[ri]] || 0) + 1;
        if (env.it % P.seg === 0) for (const g of ['d', 'r']) for (let i = 0; i < w[g].length; i++) { if (us[g][i]) w[g][i] = Math.max(0.05, (1 - P.rho) * w[g][i] + P.rho * sc[g][i] / us[g][i]); sc[g][i] = 0; us[g][i] = 0; }
        T *= cool;
      },
      get current() { return cur; },
    };
  };
  /* lns: large neighbourhood search (Shaw 1998): the same operators chosen uniformly, only non-worsening solutions are accepted */
  E.lns = (env, init) => {
    const I = env.I, rand = env.rand, ctx = ctxOf(I, env.cfg), P = Object.assign({ qlo: 0.05, qhi: 0.2 }, env.params), [qa, qb] = M.qRange(I, P.qlo, P.qhi);
    let cur = copySol(init), curO = env.obj(cur);
    return {
      one() {
        const cand = M.destroyRepair(I, ctx, rand, cur, D_NAMES[rint(rand, 3)], R_NAMES[rint(rand, 2)], qa + rint(rand, qb - qa + 1)), o = env.obj(cand);
        if (o <= curO + 1e-9) { cur = cand; curO = o; env.offer(cand, o); }
      },
      get current() { return cur; },
    };
  };
  /* ig: iterated greedy (Ruiz & Stutzle 2007, here for routing): remove a fixed fraction of random customers, reinsert greedily, accept within an acceptance band */
  E.ig = (env, init) => {
    const I = env.I, rand = env.rand, ctx = ctxOf(I, env.cfg), P = Object.assign({ frac: 0.1, band: 0.002 }, env.params), q = Math.max(2, Math.round(P.frac * I.n));
    let cur = copySol(init), curO = env.obj(cur);
    return {
      one() {
        const cand = M.destroyRepair(I, ctx, rand, cur, 'random', 'greedy', q), o = env.obj(cand);
        if (o <= curO * (1 + P.band) + 1e-9) { cur = cand; curO = o; env.offer(cand, o); }
      },
      get current() { return cur; },
    };
  };

  
  /* ================================================================== population methods */
  /* chromosome helpers: giant tour (permutation) + depot genes (0 = nearest depot, 1 = second nearest) */
  const depGenes = (I, ctx, sol) => {
    const g = new Uint8Array(I.n);
    if (I.t > 1) sol.routes.forEach(r => r.nodes.forEach(c => { g[c] = ctx.depotOrder[c][1] === r.d ? 1 : 0; }));
    return g;
  };
  const decodeChrom = (I, ctx, tour, dep) => {
    const keys = new Float64Array(M.keyLen(I)); tour.forEach((c, p) => { keys[c] = p; });
    if (I.t > 1) for (let c = 0; c < I.n; c++) keys[I.n + c] = dep[c] ? 0.9 : 0.1;
    return M.decodeKeys(I, ctx, keys);
  };
  const mkInd = (I, ctx, env, sol) => ({ sol, o: env.obj(sol), tour: M.giantTour(I, sol), dep: depGenes(I, ctx, sol) });
  const randomStart = (I, ctx, env) => M.descend(I, ctx, env, M.decodeKeys(I, ctx, M.randomKeys(I, env.rand)));
  /* broken-pairs distance between two giant tours = adjacent pairs of a that are not adjacent in b */
  function brokenPairs(a, b) {
    const n = b.length, l = new Int32Array(n).fill(-1), r = new Int32Array(n).fill(-1);
    for (let i = 0; i < n; i++) { if (i) l[b[i]] = b[i - 1]; if (i + 1 < n) r[b[i]] = b[i + 1]; }
    let d = 0; for (let i = 0; i + 1 < a.length; i++) { const x = a[i], y = a[i + 1]; if (l[x] !== y && r[x] !== y) d++; }
    return d;
  }
  /* path relinking on permutations: move a towards b by position swaps; returns the tours at the given fractions of the path */
  function relink(a, b, fracs) {
    const n = a.length, cur = a.slice(), pos = new Int32Array(n); for (let p = 0; p < n; p++) pos[cur[p]] = p;
    const sw = [];
    for (let i = 0; i < n; i++) if (cur[i] !== b[i]) { const j = pos[b[i]], x = cur[i]; cur[i] = cur[j]; cur[j] = x; pos[cur[i]] = i; pos[cur[j]] = j; sw.push(i, j); }
    const S = sw.length / 2, out = []; if (S < 2) return out;
    for (const f of fracs) {
      const k = Math.max(1, Math.min(S - 1, Math.round(f * S))), t = a.slice();
      for (let s = 0; s < k; s++) { const i = sw[2 * s], j = sw[2 * s + 1], x = t[i]; t[i] = t[j]; t[j] = x; }
      out.push(t);
    }
    return out;
  }

  /* ga: memetic genetic algorithm (steady state).  Chromosome = giant tour + depot genes; binary tournament, order crossover (OX) on the tour,
   * uniform crossover on the depot genes, swap mutation, optimal split decoding, descent on every child; a child replaces the worst individual
   * if it is better and not a duplicate (Prins 2004 style memetic algorithm; depot genes as in MJL16/Z24 for the multi-depot case). */
  E.ga = (env, init) => {
    const I = env.I, rand = env.rand, ctx = ctxOf(I, env.cfg), P = Object.assign({ pop: 20, tourn: 2, pmut: 0.1, pls: 1 }, env.params);
    const pop = [mkInd(I, ctx, env, copySol(init))]; let last = null;
    const pick = () => { let b = pop[rint(rand, pop.length)]; for (let k = 1; k < P.tourn; k++) { const c = pop[rint(rand, pop.length)]; if (c.o < b.o) b = c; } return b; };
    return {
      one() {
        if (pop.length < P.pop) { last = randomStart(I, ctx, env); env.offer(last); pop.push(mkInd(I, ctx, env, last)); return; }
        const p1 = pick(); let p2 = pick(); for (let t = 0; t < 5 && p2 === p1; t++) p2 = pick();
        const tour = M.orderCrossover(p1.tour, p2.tour, rand), dep = new Uint8Array(I.n);
        for (let c = 0; c < I.n; c++) dep[c] = rand() < 0.5 ? p1.dep[c] : p2.dep[c];
        if (rand() < P.pmut) { const i = rint(rand, I.n), j = rint(rand, I.n), x = tour[i]; tour[i] = tour[j]; tour[j] = x; if (I.t > 1) dep[tour[i]] ^= 1; }
        let s = decodeChrom(I, ctx, tour, dep);
        if (rand() < P.pls) s = M.descend(I, ctx, env, s);
        env.offer(s); last = s;
        const ind = mkInd(I, ctx, env, s); let w = 0; for (let i = 1; i < pop.length; i++) if (pop[i].o > pop[w].o) w = i;
        if (ind.o < pop[w].o - EPS && !pop.some(x => Math.abs(x.o - ind.o) < 1e-7)) pop[w] = ind;
      },
      get current() { return last || env.bestSol; },
    };
  };

  /* aco: MAX-MIN ant system (Stuetzle & Hoos 2000) with arc pheromones for routing (Bullnheimer, Hartl & Strauss 1999).  One iteration = one ant:
   * probabilistic nearest-neighbour construction (weights tau^alpha * (1/d)^beta over the unrouted feasible customers among the k nearest), then descent.
   * Every `ants` ants the pheromone evaporates and the colony-best (every 5th cycle: the global-best) solution deposits 1/cost; tau is kept in [tmin, tmax]. */
  E.aco = (env, init) => {
    const I = env.I, rand = env.rand, ctx = ctxOf(I, env.cfg), N = I.N, D = I.D, P = Object.assign({ alpha: 1, beta: 3, rho: 0.1, ants: 10, k: 20 }, env.params);
    const tau = new Float32Array(N * N); let glob = { s: copySol(init), o: env.obj(init) };
    let tmax = 1 / (P.rho * glob.o), tmin = tmax / (2 * I.n), colony = [], cycle = 0, last = null; tau.fill(tmax);
    const grp = new Int32Array(I.n), groups = []; for (let d = 0; d < I.t; d++) groups.push([]);
    for (let c = 0; c < I.n; c++) { grp[c] = ctx.depotOrder[c][0]; groups[grp[c]].push(c); }
    const deposit = (sol, amt) => { for (const r of sol.routes) { let a = I.n + r.d; for (const c of r.nodes) { tau[a * N + c] += amt; tau[c * N + a] += amt; a = c; } const e = I.n + r.d; tau[a * N + e] += amt; tau[e * N + a] += amt; } };
    function construct() {
      const un = new Uint8Array(I.n).fill(1), routes = [];
      for (let d = 0; d < I.t; d++) {
        const dn = I.n + d, G = groups[d]; let remaining = G.length;
        while (remaining > 0) {
          const cur = []; let pos = dn, q = 0, dur = 0;
          for (;;) {
            const cand = [], w = []; let tot = 0;
            const scan = c => {
              if (!un[c] || grp[c] !== d) return;
              if (q + I.dem[c] > I.Q[d] + EPS || dur + D[pos * N + c] + I.srv[c] + D[c * N + dn] > I.Dmax[d] + EPS) return;
              const x = Math.pow(tau[pos * N + c], P.alpha) * Math.pow(1 / (D[pos * N + c] + 1e-9), P.beta); cand.push(c); w.push(x); tot += x;
            };
            if (pos !== dn) { const a = ctx.adj[pos], m = Math.min(P.k, a.length); for (let i = 0; i < m; i++) scan(a[i]); }
            if (!cand.length) for (const c of G) scan(c);
            if (!cand.length) break;
            let x = rand() * tot, pi = cand.length - 1; for (let i = 0; i < cand.length; i++) { x -= w[i]; if (x <= 0) { pi = i; break; } }
            const c = cand[pi]; un[c] = 0; remaining--; cur.push(c); q += I.dem[c]; dur += D[pos * N + c] + I.srv[c]; pos = c;
          }
          if (!cur.length) { const c = G.find(x => un[x]); un[c] = 0; remaining--; cur.push(c); }
          routes.push({ d, nodes: cur });
        }
      }
      return repairFleet(I, { routes });
    }
    return {
      one() {
        const s = M.descend(I, ctx, env, construct()), o = env.obj(s); env.offer(s, o); last = s; colony.push({ s, o });
        if (colony.length >= P.ants) {
          let b = colony[0]; for (const x of colony) if (x.o < b.o) b = x;
          if (b.o < glob.o) glob = b;
          cycle++; for (let i = 0; i < tau.length; i++) tau[i] *= 1 - P.rho;
          const dep = (cycle % 5 === 0 ? glob : b); deposit(dep.s, 1 / dep.o);
          tmax = 1 / (P.rho * glob.o); tmin = tmax / (2 * I.n);
          for (let i = 0; i < tau.length; i++) { if (tau[i] > tmax) tau[i] = tmax; else if (tau[i] < tmin) tau[i] = tmin; }
          colony = [];
        }
      },
      get current() { return last || env.bestSol; },
    };
  };

  /* grasppr: GRASP with path relinking and an elite pool (Resende & Ribeiro; Prins, Prodhon & Wolfler Calvo 2006).  One iteration = one randomised
   * construction + descent, then a forward relinking of the local optimum towards a random elite solution on giant tours (positions swapped one by
   * one); the intermediate tours at 25/50/75 % of the path are split optimally, the best one is improved by descent and offered to the elite pool. */
  E.grasppr = (env, init) => {
    const I = env.I, rand = env.rand, ctx = ctxOf(I, env.cfg), P = Object.assign({ alpha: 0.2, elite: 8 }, env.params);
    const elite = [mkInd(I, ctx, env, copySol(init))]; let last = null;
    const add = ind => {
      if (elite.some(x => Math.abs(x.o - ind.o) < 1e-7)) return;
      if (elite.length < P.elite) { elite.push(ind); return; }
      let w = 0; for (let i = 1; i < elite.length; i++) if (elite[i].o > elite[w].o) w = i;
      if (ind.o < elite[w].o - EPS) elite[w] = ind;
    };
    return {
      one() {
        const x = M.descend(I, ctx, env, M.graspConstruct(I, ctx, rand, P.alpha)); env.offer(x); last = x;
        const X = mkInd(I, ctx, env, x), Y = elite[rint(rand, elite.length)];
        const mids = relink(X.tour, Y.tour, [0.25, 0.5, 0.75]);
        let bs = null, bo = INF;
        for (const t of mids) { const s = M.decodeTour(I, ctx, t), o = env.obj(s); if (o < bo) { bo = o; bs = s; } }
        add(X);
        if (bs) { const s = M.descend(I, ctx, env, bs); env.offer(s); last = s; add(mkInd(I, ctx, env, s)); }
      },
      get current() { return last || env.bestSol; },
    };
  };

  /* scatter: scatter search (Glover 1998; Martí, Laguna & Glover 2006).  Diversified pool of random-decode local optima -> reference set of b1 best + b2 most
   * distant (broken-pairs distance) -> every pair is combined by path relinking (midpoint of the path in a random direction) -> descent -> the reference set is rebuilt
   * from the old set plus the children; when it no longer changes, the b2 diverse members are regenerated.  One iteration = one combination or one new pool member. */
  E.scatter = (env, init) => {
    const I = env.I, rand = env.rand, ctx = ctxOf(I, env.cfg), P = Object.assign({ b1: 6, b2: 4, pool: 16 }, env.params);
    let pool = [mkInd(I, ctx, env, copySol(init))], ref = [], queue = [], cands = [], phase = 'init', regen = 0, last = null;
    const select = set => {
      const sorted = set.slice().sort((a, b) => a.o - b.o), out = [];
      for (const x of sorted) { if (out.length >= P.b1) break; if (!out.some(y => Math.abs(y.o - x.o) < 1e-7)) out.push(x); }
      let rest = sorted.filter(x => !out.includes(x));
      while (out.length < P.b1 + P.b2 && rest.length) {
        let bi = 0, bd = -1; rest.forEach((x, i) => { let m = INF; for (const y of out) m = Math.min(m, brokenPairs(x.tour, y.tour)); if (m > bd) { bd = m; bi = i; } });
        out.push(rest[bi]); rest = rest.filter((_, i) => i !== bi);
      }
      return out;
    };
    const makeQueue = () => { queue = []; for (let i = 0; i < ref.length; i++) for (let j = i + 1; j < ref.length; j++) if (ref[i].isNew || ref[j].isNew) queue.push([ref[i], ref[j]]); shuffleQ(queue); };
    const shuffleQ = q => M.shuffle(q, rand);
    return {
      one() {
        if (phase === 'init') {
          const s = randomStart(I, ctx, env); env.offer(s); last = s; pool.push(mkInd(I, ctx, env, s));
          if (pool.length >= P.pool) { ref = select(pool); ref.forEach(x => { x.isNew = true; }); makeQueue(); phase = 'comb'; }
          return;
        }
        if (phase === 'regen') {
          const s = randomStart(I, ctx, env); env.offer(s); last = s; const ind = mkInd(I, ctx, env, s); ind.isNew = true; ref.push(ind);
          if (++regen >= P.b2) { ref = select(ref); makeQueue(); phase = 'comb'; }
          return;
        }
        if (!queue.length) {                                        // reference-set update
          const old = new Set(ref), merged = ref.concat(cands); cands = [];
          const next = select(merged); let changed = false;
          next.forEach(x => { if (!old.has(x)) { x.isNew = true; changed = true; } else x.isNew = false; });
          ref.forEach(x => { if (!next.includes(x)) x.isNew = false; });
          ref = next;
          if (changed) { makeQueue(); } else { ref = ref.slice(0, P.b1); ref.forEach(x => { x.isNew = false; }); regen = 0; phase = 'regen'; }
          if (!queue.length && phase === 'comb') { ref.forEach(x => { x.isNew = true; }); makeQueue(); }
          return;
        }
        const pair = queue.pop(), fwd = rand() < 0.5, A = fwd ? pair[0] : pair[1], B = fwd ? pair[1] : pair[0];
        const mid = relink(A.tour, B.tour, [0.5]);
        const tour = mid.length ? mid[0] : M.orderCrossover(A.tour, B.tour, rand);
        const s = M.descend(I, ctx, env, M.decodeTour(I, ctx, tour)); env.offer(s); last = s; cands.push(mkInd(I, ctx, env, s));
      },
      get current() { return last || env.bestSol; },
    };
  };

  /* ================================================================== random-key methods */
  /* A key vector in [0,1]^n (and a second block of n depot keys for several depots) is decoded: customers sorted by key form a giant tour per depot,
   * split optimally into routes (M.decodeKeys).  All four methods share this decoder; their fitness is the decoded objective, the optional descent
   * (probability pls, default 0.05) only improves the reported solution (Baldwinian use: the keys are not changed). */
  function keyEval(env, ctx, pls) {
    const I = env.I;
    return keys => {
      const s = M.decodeKeys(I, ctx, keys), o = env.obj(s); env.offer(s, o);
      if (pls > 0 && env.rand() < pls) env.offer(M.descend(I, ctx, env, s));
      return o;
    };
  }
  const seedKeys = (I, ctx, sol) => {                           // encode a solution as keys (position in the giant tour / n; depot keys by nearest / second nearest)
    const k = new Float64Array(M.keyLen(I)), t = M.giantTour(I, sol), g = depGenes(I, ctx, sol);
    t.forEach((c, p) => { k[c] = (p + 0.5) / I.n; });
    if (I.t > 1) for (let c = 0; c < I.n; c++) k[I.n + c] = g[c] ? 0.9 : 0.1;
    return k;
  };

  /* brkga: biased random-key GA (Goncalves & Resende 2011): population p, elite fraction pe, mutant fraction pm, each child gene taken from an elite parent with probability rho.
   * One iteration = one decoded individual (the elite is copied for free into the next generation). */
  E.brkga = (env, init) => {
    const I = env.I, rand = env.rand, ctx = ctxOf(I, env.cfg), P = Object.assign({ pop: 30, pe: 0.2, pm: 0.15, rho: 0.7, pls: 0.05 }, env.params);
    const dim = M.keyLen(I), ne = Math.max(1, Math.round(P.pe * P.pop)), nm = Math.round(P.pm * P.pop), ev = keyEval(env, ctx, P.pls);
    let cur = [], nxt = null, last = null;
    const mk = k => ({ keys: k, o: ev(k) }), sortCur = () => cur.sort((a, b) => a.o - b.o);
    return {
      one() {
        if (!nxt) {
          cur.push(mk(cur.length === 0 ? seedKeys(I, ctx, init) : M.randomKeys(I, rand)));
          if (cur.length >= P.pop) { sortCur(); nxt = cur.slice(0, ne); }
          return;
        }
        const idx = nxt.length - ne, nOff = P.pop - ne; let k;
        if (idx >= nOff - nm) k = M.randomKeys(I, rand);
        else { const e = cur[rint(rand, ne)], o = cur[ne + rint(rand, P.pop - ne)]; k = new Float64Array(dim); for (let i = 0; i < dim; i++) k[i] = rand() < P.rho ? e.keys[i] : o.keys[i]; }
        nxt.push(mk(k));
        if (nxt.length >= P.pop) { cur = nxt; sortCur(); nxt = cur.slice(0, ne); }
      },
      get current() { return env.bestSol; },
    };
  };
  /* pso: random-key particle swarm (Eberhart & Kennedy 1995; the coding of Tasgetiren et al. 2007): inertia w from 0.9 to 0.4, c1 = c2 = 1.5, velocity clamped to +-0.5, positions wrapped modulo 1. */
  E.pso = (env, init) => {
    const I = env.I, rand = env.rand, ctx = ctxOf(I, env.cfg), P = Object.assign({ swarm: 20, w0: 0.9, w1: 0.4, c1: 1.5, c2: 1.5, vmax: 0.5, pls: 0.05 }, env.params);
    const dim = M.keyLen(I), ev = keyEval(env, ctx, P.pls), sw = []; let gb = null;
    return {
      one() {
        if (sw.length < P.swarm) {
          const x = sw.length === 0 ? seedKeys(I, ctx, init) : M.randomKeys(I, rand), v = new Float64Array(dim); for (let i = 0; i < dim; i++) v[i] = (rand() - 0.5) * P.vmax;
          const o = ev(x), p = { x, v, pb: x.slice(), po: o }; sw.push(p); if (!gb || o < gb.o) gb = { k: x.slice(), o };
          return;
        }
        const p = sw[(env.it - 1) % P.swarm], w = P.w0 + (P.w1 - P.w0) * Math.min(1, env.it / env.iters);
        for (let i = 0; i < dim; i++) {
          let v = w * p.v[i] + P.c1 * rand() * (p.pb[i] - p.x[i]) + P.c2 * rand() * (gb.k[i] - p.x[i]);
          v = Math.max(-P.vmax, Math.min(P.vmax, v)); p.v[i] = v; const x = p.x[i] + v; p.x[i] = x - Math.floor(x);
        }
        const o = ev(p.x);
        if (o < p.po) { p.po = o; p.pb = p.x.slice(); }
        if (o < gb.o) gb = { k: p.x.slice(), o };
      },
      get current() { return env.bestSol; },
    };
  };
  /* de: differential evolution DE/rand/1/bin (Storn & Price 1997) on the keys, F = 0.5, CR = 0.9, mutant keys wrapped modulo 1; one iteration = one trial vector. */
  E.de = (env, init) => {
    const I = env.I, rand = env.rand, ctx = ctxOf(I, env.cfg), P = Object.assign({ np: 20, F: 0.5, CR: 0.9, pls: 0.05 }, env.params);
    const dim = M.keyLen(I), ev = keyEval(env, ctx, P.pls), pop = []; let tgt = 0;
    return {
      one() {
        if (pop.length < P.np) { const x = pop.length === 0 ? seedKeys(I, ctx, init) : M.randomKeys(I, rand); pop.push({ x, o: ev(x) }); return; }
        const i = tgt; tgt = (tgt + 1) % P.np;
        let a, b, c; do { a = rint(rand, P.np); } while (a === i); do { b = rint(rand, P.np); } while (b === i || b === a); do { c = rint(rand, P.np); } while (c === i || c === a || c === b);
        const jr = rint(rand, dim), t = new Float64Array(dim);
        for (let j = 0; j < dim; j++) {
          if (rand() < P.CR || j === jr) { const v = pop[a].x[j] + P.F * (pop[b].x[j] - pop[c].x[j]); t[j] = v - Math.floor(v); } else t[j] = pop[i].x[j];
        }
        const o = ev(t); if (o <= pop[i].o) pop[i] = { x: t, o };
      },
      get current() { return env.bestSol; },
    };
  };
  /* rkrs: random-key random search - the control baseline of the random-key family: every iteration draws a fresh uniform key vector, decodes it and keeps the best; no evolution, no descent. */
  E.rkrs = (env, init) => {
    const I = env.I, ctx = ctxOf(I, env.cfg), ev = keyEval(env, ctx, 0);
    return { one() { ev(M.randomKeys(I, env.rand)); }, get current() { return env.bestSol; } };
  };

  
  /* ================================================================== catalogue (used by the Solver and checked by the tests) */
  const G = { A: 'Trajectory methods', B: 'Multi-start', C: 'Destroy & repair', D: 'Population & elite pool', E: 'Random-key search' };
  const META = [
    ['sisr', 'C', 'Ruin & recreate + SA (SISR-style)', 'one ruin-and-recreate step', 'Removes adjacent strings of customers from a few routes (Christiaens & Vanden Berghe), reinserts them with a blink-greedy rule and accepts by simulated annealing.', 'mean removed customers 17.0, string length up to 17, split depth 0.0024, blink rate 0.025, temperature 1.26 -> 0.0103 (x mean edge) (tuned with irace)', ['christiaens2020']],
    ['ils', 'A', 'Iterated local search', 'one perturbation + local search', 'Perturbs the incumbent by ruin & recreate, repairs it with the local-search operators selected below and keeps it if it is not worse.', 'operators, granular size k', ['lourenco2003']],
    ['sa', 'A', 'Simulated annealing', 'one random move', 'Random relocate / Or-opt / swap / 2-opt / 2-opt* / new-route moves; a worse move is accepted with probability exp(-delta/T), T cooled geometrically in 3 cycles with reheating.', 't0 = 0.1, tf = 0.002 (x mean edge), 3 cycles, reheat 0.5', ['kirkpatrick1983', 'osman1993']],
    ['ta', 'A', 'Threshold accepting', 'one random move', 'Accepts every random move whose cost increase stays below a threshold that shrinks linearly to zero: deterministic, no random acceptance draw.', 'initial threshold 0.589 x mean edge (tuned with irace)', ['dueck1990', 'tarantilis2002']],
    ['rtr', 'A', 'Record-to-record travel', 'one random move', 'Accepts a move if the new cost stays within a band of the best cost found so far (the record); the band shrinks linearly from 2 % to 0.', 'initial deviation 1.06 % (tuned with irace)', ['dueck1993', 'li2005']],
    ['tabu', 'A', 'Tabu search', 'one best-of-30 random move', 'Samples 30 random moves, applies the best one that is not tabu (or that beats the best solution); a customer that left a route may not return to it for 8-16 iterations.', 'candidates 30, tenure 8 + U(0..8)', ['glover1989', 'gendreau1994']],
    ['vns', 'A', 'Variable neighbourhood search', 'one shake + local search', 'Shakes the incumbent with 2k random moves (k = 1..5), repairs it with the local search, moves if better and otherwise increases k.', 'kmax = 5', ['mladenovic1997', 'kytojoki2007']],
    ['grasp', 'B', 'GRASP', 'one construction + local search', 'Randomised nearest-neighbour construction (restricted candidate list of the best 20 %) followed by the local search, repeated.', 'alpha = 0.056 (tuned with irace)', ['feo1995', 'prins2006']],
    ['msls', 'B', 'Multi-start local search', 'one random decode + local search', 'Local search from solutions decoded from random priority keys (optimal split), repeated.', 'none', ['marti2013', 'prins2004']],
    ['alns', 'C', 'Adaptive large neighbourhood search', 'one destroy + repair', 'Random, worst and related (Shaw) removal with greedy and regret-2 insertion, chosen by roulette wheel; weights adapted every 100 iterations; annealing acceptance.', 'removal 5-20 % of n, segment 100, reaction 0.1, scores 33/9/3', ['ropke2006', 'pisinger2007']],
    ['lns', 'C', 'Large neighbourhood search', 'one destroy + repair', 'The same destroy and repair operators as ALNS chosen uniformly at random; only non-worsening solutions are accepted.', 'removal 14-25 % of n (tuned with irace)', ['shaw1998']],
    ['ig', 'C', 'Iterated greedy (LNS variant)', 'one destroy + repair', 'A fixed large-neighbourhood search in the iterated-greedy style: removes 10 % random customers, reinserts them greedily (cheapest feasible insertion) and accepts within a small acceptance band.', 'removal 10 %, band 0.2 %', ['shaw1998', 'ruiz2007']],
    ['ga', 'D', 'Memetic genetic algorithm', 'one child', 'Giant-tour chromosomes (+ depot genes), binary tournament, order crossover, optimal split decoding, local search on every child; steady-state replacement of the worst.', 'population 20, mutation 10 %', ['prins2004', 'vidal2012']],
    ['aco', 'D', 'Ant colony (MAX-MIN)', 'one ant + local search', 'Ants build routes by probabilistic nearest-neighbour steps weighted by pheromone and 1/distance, then the local search; the colony best (every 5th cycle the global best) reinforces its arcs.', '11 ants, alpha 3.55, beta 6.08, rho 0.268 (tuned with irace)', ['bullnheimer1999', 'stutzle2000']],
    ['grasppr', 'D', 'GRASP + path relinking', 'one GRASP + one relinking', 'Each GRASP local optimum is relinked towards a random elite solution on giant tours; the best intermediate tour is improved and offered to the elite pool.', 'elite 8, relink at 25/50/75 %', ['resende2005', 'prins2006', 'sorensen2013']],
    ['scatter', 'D', 'Scatter search', 'one combination', 'Diversified pool -> reference set (6 best + 4 most distant) -> every pair combined by path relinking and improved -> reference set updated; diverse members regenerated when it stalls.', 'b1 = 6, b2 = 4, pool 16', ['glover1998', 'marti2006', 'russell2006']],
    ['brkga', 'E', 'Biased random-key GA', 'one decoded individual', 'Key vectors decoded to routes; elite 20 %, mutants 15 %, each child gene inherited from an elite parent with probability 0.7.', 'population 30', ['goncalves2011', 'bean1994']],
    ['pso', 'E', 'Particle swarm (random keys)', 'one particle move', 'Particles move in key space with inertia 0.9 -> 0.4, c1 = c2 = 1.5, velocity clamp 0.5, positions wrapped modulo 1.', 'swarm 42, inertia 0.743 -> 0.310, c1 1.30, c2 2.10, vmax 0.197 (tuned with irace)', ['kennedy1995', 'ai2009']],
    ['de', 'E', 'Differential evolution (rand/1/bin)', 'one trial vector', 'Mutant = x1 + F (x2 - x3), binomial crossover, greedy one-to-one replacement.', 'NP 20, F 0.5, CR 0.9', ['storn1997', 'teoh2015']],
    ['rkrs', 'E', 'Random-key random search (control)', 'one random decode', 'Draws a fresh random key vector each iteration and keeps the best decode: the control baseline of the random-key family, not a published method.', 'none', []],
  ];
  META.forEach(m => { V.METHODS[m[0]] = { id: m[0], group: m[1], groupName: G[m[1]], label: m[2], unit: m[3], desc: m[4], params: m[5], refs: m[6] }; });
  V.METHOD_GROUPS = G;

  /* short citation labels; the full entries (checked against Crossref / the publishers) are in the reference list of learn.html (ids ref-<key>) */
  V.REF_SHORT = {
    christiaens2020: 'Christiaens & Vanden Berghe (2020)', lourenco2003: 'Lourenço, Martin & Stützle (2003)', kirkpatrick1983: 'Kirkpatrick et al. (1983)', osman1993: 'Osman (1993)',
    dueck1990: 'Dueck & Scheuer (1990)', dueck1993: 'Dueck (1993)', glover1989: 'Glover (1989)', gendreau1994: 'Gendreau, Hertz & Laporte (1994)', mladenovic1997: 'Mladenović & Hansen (1997)',
    kytojoki2007: 'Kytöjoki et al. (2007)', feo1995: 'Feo & Resende (1995)', prins2006: 'Prins, Prodhon & Wolfler Calvo (2006)', marti2013: 'Martí, Resende & Ribeiro (2013)',
    prins2004: 'Prins (2004)', ropke2006: 'Ropke & Pisinger (2006)', pisinger2007: 'Pisinger & Ropke (2007)', shaw1998: 'Shaw (1998)', ruiz2007: 'Ruiz & Stützle (2007)',
    vidal2012: 'Vidal et al. (2012)', bullnheimer1999: 'Bullnheimer, Hartl & Strauss (1999)', stutzle2000: 'Stützle & Hoos (2000)', resende2005: 'Resende & Ribeiro (2005)',
    glover1998: 'Glover (1998)', marti2006: 'Martí, Laguna & Glover (2006)', goncalves2011: 'Gonçalves & Resende (2011)', bean1994: 'Bean (1994)',
    lopezibanez2016: 'López-Ibáñez et al. (2016)', kennedy1995: 'Kennedy & Eberhart (1995)', ai2009: 'Ai & Kachitvichyanukul (2009)', storn1997: 'Storn & Price (1997)', tarantilis2002: 'Tarantilis, Kiranoudis & Vassiliadis (2002)', li2005: 'Li, Golden & Wasil (2005)',
    sorensen2013: 'Sörensen & Schittekat (2013)', russell2006: 'Russell & Chiang (2006)', teoh2015: 'Teoh, Ponnambalam & Kanagaraj (2015)',
  };
  /* the reference-set size etc. are fixed in the code above; the numbers in `params` are the values a run uses: tuned values for the
   * seven methods of VRP.TUNED_PARAMS, the values of the cited papers for the others */

  /* iterations that make one run of `id` take about `seconds` of compute on instance I: times a short probe run of the real method (which also
   * covers the start-up cost of population methods).  Used for equal-time budgets; the probe is deterministic in everything but the clock. */
  const initCache = new WeakMap();                                  // the savings start of an instance, shared by the timing runs of all methods
  V.calibrate = function (I, id, seconds, opts) {
    const o = opts || {}, init = initCache.has(I) ? initCache.get(I) : (initCache.set(I, V.savings(I)), initCache.get(I)), probeMs = Math.max(80, Math.min(o.probeMs || 400, seconds * 250));
    const S = V.createSearch(I, init, { mode: id, iters: 1e9, seed: 12345, ops: o.ops, k: o.k, params: o.params, defaults: o.defaults });
    S.stepFor(probeMs * 0.4); const it1 = S.iter, s1 = S.seconds;      // warm-up (JIT, population start-up) is left out of the rate
    S.stepFor(probeMs * 0.6);
    const d = S.iter - it1, per = d >= 5 ? (S.seconds - s1) / d : Math.max(S.seconds, 1e-4) / Math.max(S.iter, 1);
    return Math.max(20, Math.round(seconds / Math.max(per, 1e-7)));
  };
  Object.assign(V.methodsInternals, { relink, brokenPairs, depGenes, decodeChrom });
  /*__METHODS__*/
  return V;
});

/* VRP-Learn: template of a custom search method (JavaScript).
 *
 * Paste this text into "Your own method" on the Solver page (Expert mode), or load the file there, then choose
 * "Custom (your code)" as the method. You can compare it with the built-in methods at the same compute time.
 *
 * Contract
 *   function customMethod(api, start)   is called once per run. `start` is a feasible solution.
 *   It returns a function that performs ONE iteration; the Solver calls it until the budget ends.
 *   Keep one iteration short (well under a second): the page stops a method that does not answer for 15 seconds.
 *
 * Solutions
 *   { routes: [ { d: 0, nodes: [4, 7, 1] }, ... ] }     d = depot index (0 .. depots-1), nodes = customers in visiting order
 *   Customers are numbered 0 .. customers-1.
 *
 * api
 *   api.instance      customers, depots, demand[c], service[c], capacity[d], maxDuration[d], fleet[d], x[], y[],
 *                     dist(i, j) with node numbers: customer c is node c, depot d is node depotNode(d)
 *   api.random()      random number in [0, 1) from the seed of the run (use it instead of Math.random, so that runs can be repeated)
 *   api.randomInt(k)  random integer 0 .. k-1
 *   api.copy(s)  api.cost(s)  api.feasible(s)  api.violations(s)
 *   api.routeCost(d, nodes)  api.routeFeasible(d, nodes)  api.nearestDepot(c)
 *   api.savings()     Clarke and Wright solution          api.localSearch(s)   local search of the Solver on a feasible solution
 *   api.report(s)     tell the Solver about a solution. It checks the solution itself, keeps the best feasible one and
 *                     returns true if `s` is a new best. Infeasible solutions are refused (returns false).
 *   api.best()  api.bestCost()  api.iteration  api.iterations
 *
 * The example below: remove a few random customers, put each back at its cheapest feasible position,
 * and keep the result if it is not worse than the current solution.
 */
function customMethod(api, start) {
  const inst = api.instance;
  let current = api.copy(start), currentCost = api.cost(current);
  api.report(current);

  function insertCheapest(sol, c) {
    let best = null;
    for (const r of sol.routes) {
      const base = api.routeCost(r.d, r.nodes);
      for (let p = 0; p <= r.nodes.length; p++) {
        const nodes = r.nodes.slice(0, p).concat([c], r.nodes.slice(p));
        if (!api.routeFeasible(r.d, nodes)) continue;
        const extra = api.routeCost(r.d, nodes) - base;
        if (!best || extra < best.extra) best = { r, nodes, extra };
      }
    }
    if (best) best.r.nodes = best.nodes;
    else sol.routes.push({ d: api.nearestDepot(c), nodes: [c] });      // no room anywhere: open a new route
  }

  return function step() {
    const cand = api.copy(current);
    const k = 2 + api.randomInt(4), removed = [];
    for (let q = 0; q < k; q++) {
      const routes = cand.routes.filter(r => r.nodes.length);
      if (!routes.length) break;
      const r = routes[api.randomInt(routes.length)];
      removed.push(r.nodes.splice(api.randomInt(r.nodes.length), 1)[0]);
    }
    cand.routes = cand.routes.filter(r => r.nodes.length);
    for (const c of removed) insertCheapest(cand, c);
    if (!api.feasible(cand)) return;                                   // for example more routes than vehicles
    const cost = api.cost(cand);
    if (cost <= currentCost) { current = cand; currentCost = cost; api.report(cand); }
  };
}

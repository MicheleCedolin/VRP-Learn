#!/usr/bin/env node
// Renders the mathematical models of docs/learn.html with KaTeX at build time (HTML + MathML, no JavaScript in the page).
// The TeX source of the models lives in this file; the output replaces the text between
//   <!-- math:NAME -->  and  <!-- /math:NAME -->   in docs/learn.html.
//   npm install && node scripts/render_math.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import katex from 'katex';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tex = (s, display) => katex.renderToString(s, { displayMode: !!display, throwOnError: true, output: 'htmlAndMathml', strict: 'error' });
const inline = s => s.replace(/\$([^$]+)\$/g, (_, t) => tex(t, false));          // $...$ inside prose
const defs = (title, items) => `<div class="mdefs"><h4>${title}</h4><dl>` + items.map(([s, d]) => `<dt>${tex(s)}</dt><dd>${inline(d)}</dd>`).join('') + '</dl></div>';
// one model = objective + constraints; every row: [TeX, quantifier TeX or '', plain-language meaning]
function model(prefix, rows) {
  return '<div class="mmodel">' + rows.map(([eq, forall, note], k) =>
    `<div class="mrow" id="eq-${prefix}${k + 1}"><div class="meq">${tex(eq, true)}</div><div class="mq">${forall ? tex(forall) : ''}</div><div class="mno">(${prefix}${k + 1})</div><div class="mnote">${inline(note)}</div></div>`).join('\n') + '</div>';
}

const BLOCKS = {
  cvrp: () =>
    '<div class="mgrid">' +
    defs('Sets and parameters', [
      ['N = \\{1,\\dots,n\\}', 'customers'],
      ['V = N \\cup \\{0\\}', 'all locations; node $0$ is the depot'],
      ['c_{ij} \\ge 0', 'travel cost from $i$ to $j$'],
      ['q_i > 0', 'demand of customer $i$'],
      ['Q', 'vehicle capacity ($q_i \\le Q$)'],
      ['m', 'number of vehicles'],
    ]) +
    defs('Decision variables', [
      ['x_{ij} \\in \\{0,1\\}', '$1$ if a vehicle drives directly from $i$ to $j$'],
      ['u_i \\ge 0', 'load of the vehicle after it has served customer $i$'],
    ]) + '</div>' +
    model('', [
      ['\\min \\; \\sum_{i \\in V} \\sum_{\\substack{j \\in V \\\\ j \\ne i}} c_{ij}\\, x_{ij}', '', 'total travel cost'],
      ['\\sum_{\\substack{j \\in V \\\\ j \\ne i}} x_{ij} = 1', '\\forall\\, i \\in N', 'every customer is left exactly once'],
      ['\\sum_{\\substack{i \\in V \\\\ i \\ne j}} x_{ij} = 1', '\\forall\\, j \\in N', 'every customer is entered exactly once'],
      ['\\sum_{j \\in N} x_{0j} \\le m', '', 'at most $m$ routes leave the depot'],
      ['u_j \\ge u_i + q_j - Q\\,(1 - x_{ij})', '\\forall\\, i, j \\in N,\\; i \\ne j', 'the load grows along a route, which also forbids sub-tours'],
      ['q_i \\le u_i \\le Q', '\\forall\\, i \\in N', 'capacity'],
      ['x_{ij} \\in \\{0,1\\}', '\\forall\\, i, j \\in V,\\; i \\ne j', 'binary arc variables'],
    ]),

  sp: () =>
    '<div class="mgrid">' +
    defs('Sets and parameters', [
      ['\\Omega', 'all feasible routes (each respects the capacity)'],
      ['c_r', 'cost of route $r$'],
      ['a_{ir} \\in \\{0,1\\}', '$1$ if route $r$ visits customer $i$'],
    ]) +
    defs('Decision variables', [
      ['\\lambda_r \\in \\{0,1\\}', '$1$ if route $r$ is used'],
    ]) + '</div>' +
    model('SP', [
      ['\\min \\; \\sum_{r \\in \\Omega} c_r\\, \\lambda_r', '', 'total cost of the selected routes'],
      ['\\sum_{r \\in \\Omega} a_{ir}\\, \\lambda_r = 1', '\\forall\\, i \\in N', 'every customer is on exactly one selected route'],
      ['\\sum_{r \\in \\Omega} \\lambda_r \\le m', '', 'fleet size'],
      ['\\lambda_r \\in \\{0,1\\}', '\\forall\\, r \\in \\Omega', 'a route is used or not'],
    ]),

  md: () =>
    '<div class="mgrid">' +
    defs('Sets and parameters', [
      ['N = \\{1,\\dots,n\\}', 'customers'],
      ['D = \\{1,\\dots,t\\}', 'depots'],
      ['c_{ij},\\; c_{dj},\\; c_{id}', 'travel cost customer to customer, depot to customer, customer to depot'],
      ['q_i > 0', 'demand of customer $i$'],
      ['Q_d,\\; m_d', 'vehicle capacity and number of vehicles at depot $d$'],
      ['Q_{\\max} = \\max_{d \\in D} Q_d', 'largest capacity'],
    ]) +
    defs('Decision variables', [
      ['x_{ij} \\in \\{0,1\\}', '$1$ if a vehicle drives directly from customer $i$ to customer $j$'],
      ['y_{dj} \\in \\{0,1\\}', '$1$ if a route leaves depot $d$ for its first customer $j$'],
      ['z_{id} \\in \\{0,1\\}', '$1$ if a route returns from its last customer $i$ to depot $d$'],
      ['a_{id} \\in \\{0,1\\}', '$1$ if customer $i$ is served from depot $d$'],
      ['u_i \\ge 0', 'load of the vehicle after it has served customer $i$'],
    ]) + '</div>' +
    model('MD', [
      ['\\min \\; \\sum_{i \\in N} \\sum_{\\substack{j \\in N \\\\ j \\ne i}} c_{ij}\\, x_{ij} \\;+\\; \\sum_{d \\in D} \\sum_{j \\in N} c_{dj}\\, y_{dj} \\;+\\; \\sum_{i \\in N} \\sum_{d \\in D} c_{id}\\, z_{id}', '', 'total travel cost, including the first and the last leg of every route'],
      ['\\sum_{\\substack{i \\in N \\\\ i \\ne j}} x_{ij} + \\sum_{d \\in D} y_{dj} = 1', '\\forall\\, j \\in N', 'every customer is entered exactly once, from a customer or from a depot'],
      ['\\sum_{\\substack{j \\in N \\\\ j \\ne i}} x_{ij} + \\sum_{d \\in D} z_{id} = 1', '\\forall\\, i \\in N', 'every customer is left exactly once, to a customer or to a depot'],
      ['\\sum_{d \\in D} a_{id} = 1', '\\forall\\, i \\in N', 'every customer belongs to one depot'],
      ['y_{dj} \\le a_{jd}, \\qquad z_{jd} \\le a_{jd}', '\\forall\\, j \\in N,\\; d \\in D', 'a route may start and end only at the depot of its customers'],
      ['a_{jd} \\ge a_{id} + x_{ij} - 1', '\\forall\\, i, j \\in N,\\; i \\ne j,\\; d \\in D', 'consecutive customers share the depot'],
      ['\\sum_{j \\in N} y_{dj} \\le m_d', '\\forall\\, d \\in D', 'fleet size of each depot'],
      ['u_j \\ge u_i + q_j - Q_{\\max}\\,(1 - x_{ij})', '\\forall\\, i, j \\in N,\\; i \\ne j', 'the load grows along a route (no sub-tours)'],
      ['q_i \\le u_i \\le \\sum_{d \\in D} Q_d\\, a_{id}', '\\forall\\, i \\in N', 'capacity of the vehicles of the assigned depot'],
      ['x_{ij},\\; y_{dj},\\; z_{id},\\; a_{id} \\in \\{0,1\\}', '', 'binary variables'],
    ]),
};

const file = path.join(ROOT, 'docs', 'learn.html');
let html = fs.readFileSync(file, 'utf8');
for (const [name, make] of Object.entries(BLOCKS)) {
  const open = `<!-- math:${name} -->`, close = `<!-- /math:${name} -->`;
  const a = html.indexOf(open), b = html.indexOf(close);
  if (a < 0 || b < a) throw new Error('markers for "' + name + '" not found in docs/learn.html');
  html = html.slice(0, a + open.length) + '\n' + make() + '\n' + html.slice(b);
}
fs.writeFileSync(file, html);
console.log('rendered', Object.keys(BLOCKS).join(', '));

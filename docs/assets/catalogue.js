/* catalogue.js - renders the table of the 20 search methods of the Solver on the Learn page.
 * Source of truth: VRP.METHODS / VRP.METHOD_GROUPS / VRP.REF_SHORT (methods.js), so the Learn page and the
 * Solver can never disagree.  Reference links point to the entries with id="ref-<key>" in learn.html. */
(function () {
  'use strict';
  const V = window.VRP, host = document.getElementById('method-catalogue');
  if (!host || !V || !V.METHODS) return;
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const REF = V.REF_SHORT || {};
  const groups = Object.keys(V.METHOD_GROUPS);
  let html = '';
  groups.forEach((g, gi) => {
    const rows = Object.values(V.METHODS).filter(m => m.group === g);
    if (!rows.length) return;
    html += '<h4>E.' + (gi + 1) + ' ' + esc(V.METHOD_GROUPS[g]) + '</h4>';
    html += '<table class="mtable"><thead><tr><th>Method</th><th>One step</th><th>How it works here</th><th>Parameters</th><th>Literature</th></tr></thead><tbody>';
    rows.forEach(m => {
      const refs = m.refs.length
        ? m.refs.map(k => '<a href="#ref-' + esc(k) + '">' + esc(REF[k] || k) + '</a>').join('; ')
        : '<span class="small">none: control baseline</span>';
      html += '<tr id="m-' + esc(m.id) + '"><td><b>' + esc(m.label) + '</b></td><td>' + esc(m.unit) + '</td><td>' + esc(m.desc) + '</td><td>' +
        esc(m.params) + '</td><td>' + refs + '</td></tr>';
    });
    html += '</tbody></table>';
  });
  host.innerHTML = html;
})();

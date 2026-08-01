// Regressions for the comparison radar. The one that matters: an unpublished
// value must score null, never zero -- plotting 'unknown cycle life' at the
// centre draws it identically to 'measured at zero cycles'.

import { CELLS, cellById } from '../js/cells.js';
import { AXES, cellScores, missingNotes } from '../js/radar.js';
let f=0; const ok=(c,m)=>{ if(!c){console.log('FAIL',m);f++} };
ok(AXES.length===7,'seven axes');
ok(AXES.every(a=>a.short && a.label && a.unit),'every axis has short, label, unit');
// An unpublished value must be null, never 0.
const noLife = CELLS.filter(c=>c.cycleLife==null);
ok(noLife.length>0,'there are cells with no published cycle life');
for (const c of noLife) {
  const r = cellScores(c).find(x=>x.axis.key==='life');
  ok(r.score===null, `${c.id}: unknown life scores null, not 0`);
}
// Scores are bounded and absolute, not set-relative.
for (const c of CELLS) for (const r of cellScores(c))
  ok(r.score===null || (r.score>=0 && r.score<=1), `${c.id}/${r.axis.key} in 0..1`);
// Value points outward when $/kWh is LOW.
const cheap = cellScores(cellById('eve-lf280k')).find(r=>r.axis.key==='value');
const dear  = cellScores(cellById('molicel-inr21700-p42a')).find(r=>r.axis.key==='value');
ok(cheap.score>dear.score, `cheaper $/kWh scores higher (${cheap.raw.toFixed(0)} vs ${dear.raw.toFixed(0)})`);
// Missing notes name the cell and the axis.
const n = missingNotes([cellById('toshiba-scib-2-9ah')]);
ok(n.length===1 && /not published/.test(n[0]), 'gaps are reported: '+n[0]);
console.log(f?`${f} FAILURES`:'radar checks pass');
process.exit(f?1:0);

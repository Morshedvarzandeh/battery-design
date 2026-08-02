// Radar — the comparison chart. The one that matters: an unpublished value
// must score null, never zero — plotting "unknown cycle life" at the centre
// draws it identically to "measured at zero cycles".
import { test } from 'node:test';
import { ok } from './helpers.mjs';
import { CELLS, cellById } from '../js/cells.js';
import { AXES, cellScores, missingNotes } from '../js/radar.js';

test('axes are complete', () => {
  ok(AXES.length === 7, 'seven axes');
  ok(AXES.every((a) => a.short && a.label && a.unit), 'every axis has short, label, unit');
});

test('an unpublished value scores null, never zero', () => {
  const noLife = CELLS.filter((c) => c.cycleLife == null);
  ok(noLife.length > 0, 'there are cells with no published cycle life');
  for (const c of noLife) {
    const r = cellScores(c).find((x) => x.axis.key === 'life');
    ok(r.score === null, `${c.id}: unknown life scores null, not 0`);
  }
});

test('scores are bounded and absolute, not set-relative', () => {
  for (const c of CELLS) for (const r of cellScores(c)) {
    ok(r.score === null || (r.score >= 0 && r.score <= 1), `${c.id}/${r.axis.key} in 0..1`);
  }
});

test('value axis points outward when $/kWh is LOW, and gaps are reported', () => {
  const cheap = cellScores(cellById('eve-lf280k')).find((r) => r.axis.key === 'value');
  const dear = cellScores(cellById('molicel-inr21700-p42a')).find((r) => r.axis.key === 'value');
  ok(cheap.score > dear.score, `cheaper $/kWh scores higher (${cheap.raw.toFixed(0)} vs ${dear.raw.toFixed(0)})`);
  const n = missingNotes([cellById('toshiba-scib-2-9ah')]);
  ok(n.length === 1 && /not published/.test(n[0]), 'gaps are reported: ' + n[0]);
});

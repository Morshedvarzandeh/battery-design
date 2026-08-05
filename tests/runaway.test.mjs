// Runaway propagation — and knowing what the model may not be used for.
//
// This module was nearly shipped saying the opposite of the truth twice. The
// first cut let a barrier REPLACE the gap rather than sit in it, which made a
// 0.5 mm mica sheet look worse than a 1 mm air gap and would have advised
// removing barriers. The second used one thermal node per cell, which averages
// arriving heat over about seven times the mass that actually reaches onset.
//
// Both are fixed, and both are pinned here — along with the harder lesson: the
// model under-predicts propagation so badly that its "does not spread" answer
// carries no information. These tests hold it to comparing options and forbid
// it from ever clearing one.
import { test } from 'node:test';
import { ok } from './helpers.mjs';
import {
  BARRIERS, SPACERS, RELEASE_MULTIPLE, releaseMultiple, neighbours,
  propagation, propagationStudy,
} from '../js/runaway.js';
import { layoutPack } from '../js/pack-engine.js';
import { runawayOnsetC } from '../js/shortcircuit.js';
import { cellById } from '../js/cells.js';

const CELL = () => cellById('lg-inr18650-mj1');
const lay = (spacingMm = 1, p = 8) => layoutPack(CELL(), 13, p, { spacingMm });

test('neighbours come from the geometry, not from an assumed grid', () => {
  const layout = lay();
  const nb = neighbours(layout.positions, CELL().dims.d);
  // Hex packing gives six neighbours to an interior cell and fewer at an edge.
  const counts = nb.map((l) => l.length);
  ok(Math.max(...counts) === 6, `an interior cell has six neighbours (max ${Math.max(...counts)})`);
  ok(Math.min(...counts) < 6, 'and an edge cell has fewer, which is why edges are safer');
  // Adjacency is symmetric, or heat would flow one way only.
  for (let i = 0; i < nb.length; i++) {
    for (const n of nb[i]) {
      ok(nb[n.index].some((m) => m.index === i), `${i}<->${n.index} is mutual`);
    }
  }
  ok(neighbours([], 18).length === 0, 'no cells, no neighbours');
});

test('a barrier sits INSIDE the gap, it does not replace it', () => {
  // The bug this pins: treating a 0.5 mm sheet as the whole gap made mica
  // conduct twenty times more per millimetre than the air it displaced, and
  // the tool would have recommended taking it out.
  const layout = lay(1);
  const air = propagation({ layout, cell: CELL(), barrier: 'none' });
  const mica = propagation({ layout, cell: CELL(), barrier: 'mica', barrierThicknessMm: 0.5 });
  ok(Math.abs(air.coupling.gapMm - mica.coupling.gapMm) < 1e-6,
    'both see the same geometric gap, because the gap is a fact of the layout');
  ok(mica.coupling.barrierMm === 0.5 && mica.coupling.airMm > 0.4,
    'the sheet occupies part of it and air fills the rest');
  ok(mica.coupling.conductionWK > air.coupling.conductionWK,
    'so mica really does conduct more than the air it displaced');
  ok(!mica.coupling.radiates && air.coupling.radiates,
    'but it blocks the radiation that air lets through');
  ok(mica.marginK > air.marginK,
    'and that trade is worth more than the extra conduction — the whole reason mica is used');
  // A barrier thicker than the gap cannot exist.
  const fat = propagation({ layout, cell: CELL(), barrier: 'mica', barrierThicknessMm: 99 });
  ok(fat.coupling.barrierMm <= fat.coupling.gapMm + 1e-9, 'a sheet cannot be thicker than the gap it sits in');
});

test('two nodes per cell, because one cannot propagate correctly', () => {
  const layout = lay();
  // A thin shell reaches onset while the core is still cool. Make the shell
  // heavier and the neighbour heats less, which is the effect being modelled.
  const thin = propagation({ layout, cell: CELL(), barrier: 'none', surfaceFrac: 0.10 });
  const thick = propagation({ layout, cell: CELL(), barrier: 'none', surfaceFrac: 0.40 });
  ok(thin.peakNeighbourC > thick.peakNeighbourC,
    'a thinner shell gets hotter on the same arriving heat');
  // The trigger cell must get much hotter than its neighbours, or nothing is
  // being modelled at all.
  ok(thin.peakC > thin.peakNeighbourC + 200, 'the cell that went is far hotter than the ones that did not');
});

test('the cell spacer is a separate parallel heat bridge, not hidden in the gap', () => {
  const layout = lay(1);
  const none = propagation({ layout, cell: CELL(), barrier: 'mica', spacer: 'none' });
  const holder = propagation({ layout, cell: CELL(), barrier: 'mica', spacer: 'pp-holder' });
  const bonded = propagation({ layout, cell: CELL(), barrier: 'mica', spacer: 'structural-adhesive' });
  ok(none.coupling.spacerWK === 0, 'the thermal reference has no structural bridge');
  ok(holder.coupling.spacerWK > 0, 'a PP holder conducts through its contact ribs');
  ok(bonded.coupling.spacerWK > holder.coupling.spacerWK, 'a full-area direct bond is a much larger heat bridge');
  ok(Math.abs(holder.coupling.conductionWK
      - holder.coupling.gapWK - holder.coupling.spacerWK - holder.coupling.interconnectWK) < 1e-12,
  'air/barrier, spacer and interconnect conductances add as parallel paths');
  ok(bonded.marginK < holder.marginK, 'the stronger spacer bridge heats the neighbour more');
  ok(/G_spacer/.test(holder.equations.spacer) && /G_gap \+ G_spacer \+ G_interconnect/.test(holder.equations.totalConduction),
    'the returned evidence states both equations explicitly');

  const study = propagationStudy({ layout, cell: CELL(), barrier: 'mica', spacer: 'pp-holder' });
  ok(study.spacerRanked.length === Object.keys(SPACERS).length, 'every approved spacer path is compared');
  for (let i = 1; i < study.spacerRanked.length; i++) {
    ok(study.spacerRanked[i].marginK <= study.spacerRanked[i - 1].marginK, 'spacers rank by comparison margin');
  }
});

test('the physical levers move the answer the way physics says', () => {
  const cell = CELL();
  const wide = propagation({ layout: lay(3), cell, barrier: 'none' });
  const tight = propagation({ layout: lay(0.5), cell, barrier: 'none' });
  ok(wide.marginK > tight.marginK, 'more space is more margin');

  const full = propagation({ layout: lay(), cell, barrier: 'none', soc: 1 });
  const low = propagation({ layout: lay(), cell, barrier: 'none', soc: 0.3 });
  ok(low.marginK > full.marginK, 'a cell at 30% has far less to give');
  ok(low.energy.perCellJ < full.energy.perCellJ * 0.4, 'and releases proportionally less energy');

  const bridge = propagation({ layout: lay(), cell, barrier: 'none', interconnectWK: 0.5 });
  ok(bridge.marginK < full.marginK, 'a fat interconnect is a heat bridge, whoever designed it as a conductor');

  // Chemistry: LFP starts later and releases less.
  ok(runawayOnsetC('LFP') > runawayOnsetC('NMC'), 'LFP onset is higher');
  ok(releaseMultiple('LFP') < releaseMultiple('NMC'), 'and it releases less of its stored energy');
  for (const [chem, m] of Object.entries(RELEASE_MULTIPLE)) {
    ok(m > 0 && m < 5, `${chem} release multiple is physically plausible`);
  }
});

test('it ranks options and refuses to clear any of them', () => {
  const study = propagationStudy({ layout: lay(), cell: CELL() });
  ok(study.verdict === 'unproven', 'the best verdict available is unproven, never workable');
  ok(study.ranked.length >= 4, 'every barrier option is tried on the same geometry');
  for (let i = 1; i < study.ranked.length; i++) {
    ok(study.ranked[i].marginK <= study.ranked[i - 1].marginK, 'ranked best-first');
  }
  // The ordering that matters, and that the first version got backwards.
  const by = Object.fromEntries(study.ranked.map((r) => [r.barrier, r.marginK]));
  ok(by.aerogel > by.mica, 'aerogel beats mica');
  ok(by.mica > by.none, 'and mica beats a bare air gap');
  ok(/ORDERING is the usable result/.test(study.headline),
    'the headline says the ranking is the answer and the magnitudes are not');
});

test('the containment energy is the number that does not depend on the model', () => {
  const study = propagationStudy({ layout: lay(), cell: CELL() });
  const c = study.containment;
  const cell = CELL();
  const storedMJ = (cell.nominalV * cell.capacityAh * 3600) / 1e6;
  ok(c.perCellMJ > storedMJ, 'a cell releases more than it stores electrically');
  ok(c.perCellMJ < storedMJ * 4, 'but not absurdly more');
  ok(c.moduleMJ > c.perCellMJ, 'and a module holds many cells worth');
  ok(/does not depend on/.test(c.note), 'and it says why this figure is the trustworthy one');
  ok(study.findings.some((f) => /Plan to contain/.test(f.title)), 'it is raised as a finding, not buried');
});

test('it never claims safety, and says why its "no" means little', () => {
  const study = propagationStudy({ layout: lay(3), cell: CELL() });
  ok(study.verdict !== 'workable' && study.verdict !== 'workable-with-costs',
    'a wide-spaced design still does not get a pass');
  const all = study.assumptions.join(' ');
  ok(/NOT modelled/.test(all), 'the omitted mechanisms are named in capitals');
  ok(/under-predicts|BELOW onset/i.test(all), 'and it admits the direction of the error');
  ok(/rank options, never to clear one/i.test(all), 'and states what it may be used for');
  ok(/9540A/.test(all) && /38031/.test(all), 'pointing at the tests that actually settle it');
  ok(!/safety margin/i.test(study.headline) || /NOT a safety margin/i.test(study.headline),
    'the margin is never presented as a safety margin');
  ok(propagation({ layout: null, cell: CELL() }) === null, 'no layout, no answer');
  ok(propagation({ layout: lay(), cell: null }) === null, 'no cell, no answer');
});

test('every barrier is complete and usable', () => {
  for (const [id, b] of Object.entries(BARRIERS)) {
    ok(b.kWmK > 0 && typeof b.blocksRadiation === 'boolean' && b.name && b.what,
      `${id} is a complete barrier`);
    const r = propagation({ layout: lay(), cell: CELL(), barrier: id, barrierThicknessMm: 0.5 });
    ok(r && isFinite(r.marginK), `${id} produces a finite answer`);
  }
});

test('every spacer heat path is explicit and finite', () => {
  for (const [id, spacer] of Object.entries(SPACERS)) {
    ok(spacer.name && spacer.what && spacer.kWmK >= 0
      && spacer.contactFraction >= 0 && spacer.contactFraction <= 1
      && spacer.pathLengthMm > 0, `${id} is a complete heat-path definition`);
    const result = propagation({ layout: lay(), cell: CELL(), barrier: 'mica', spacer: id });
    ok(Number.isFinite(result.coupling.spacerWK), `${id} produces a finite spacer conductance`);
  }
});

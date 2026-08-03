// Topology, materials and the bill of materials.
//
// These three were built together and before the features that need them,
// because wiring, grounding, corrosion, runaway propagation and LCA are all
// views of the same connection graph and the same material properties. The
// tests guard the shared shape, so the features that follow do not reshape it.
import { test } from 'node:test';
import { ok, near } from './helpers.mjs';
import {
  MATERIALS, materialById, resistivityAt, conductorResistance, conductorMassKg,
  galvanicRisk, validateMaterials, GALVANIC_LIMITS,
} from '../js/materials.js';
import { buildTopology, jointCompatibility, materialBreakdown, billOfMaterials } from '../js/topology.js';
import { designFromSpec } from '../js/api.js';
import { cellById } from '../js/cells.js';

test('every material is complete and physically sane', () => {
  ok(validateMaterials().length === 0, `the table is consistent: ${validateMaterials().join('; ')}`);
  // Copper is the reference everything else is judged against.
  const cu = materialById('copper');
  near(cu.resistivityOhmM, 1.72e-8, 1e-10, 'copper resistivity is the textbook value');
  ok(materialById('aluminium').resistivityOhmM > cu.resistivityOhmM, 'aluminium conducts worse than copper');
  ok(materialById('aluminium').densityKgM3 < cu.densityKgM3 / 3, 'and is under a third of the mass');
  ok(materialById('nickel').resistivityOhmM > cu.resistivityOhmM * 3,
    'nickel strip is several times the resistance of copper — the reason undersized strip cooks packs');
  ok(materialById('stainless-304').resistivityOhmM > cu.resistivityOhmM * 20, 'stainless is never a current path');
});

test('conductor maths is Ohm and Archimedes, not a fudge', () => {
  // 1 m of 1 mm² copper is ρ/A = 1.72e-8 / 1e-6 = 17.2 mΩ.
  near(conductorResistance({ materialId: 'copper', lengthM: 1, areaMm2: 1 }), 0.0172, 1e-6, 'R = ρL/A');
  // Double the area, half the resistance.
  near(conductorResistance({ materialId: 'copper', lengthM: 1, areaMm2: 2 }), 0.0086, 1e-6, 'area halves resistance');
  // Mass is density × volume.
  near(conductorMassKg({ materialId: 'copper', lengthM: 1, areaMm2: 100 }), 8960 * 1 * 100e-6, 1e-9, 'm = ρ·V');
  // Hot copper has more resistance, by the stated coefficient.
  ok(resistivityAt('copper', 100) > resistivityAt('copper', 20) * 1.3, 'resistivity climbs with temperature');
  ok(conductorResistance({ materialId: 'copper', lengthM: 1, areaMm2: 0 }) === null, 'null-safe');
});

test('the galvanic check names which metal dissolves', () => {
  const bad = galvanicRisk('copper', 'aluminium', 'harsh');
  ok(!bad.ok && bad.sacrificial === 'aluminium', 'aluminium is the side that corrodes against copper');
  ok(/aluminium/.test(bad.why) && /corrodes/.test(bad.why), 'and the answer says so, actionably');
  ok(/tin|bimetallic|seal/.test(bad.why), 'with the accepted fixes named');
  // The environment is what decides, because corrosion needs an electrolyte.
  ok(galvanicRisk('copper', 'tin', 'harsh').ok === false, 'copper against tin fails in salt spray');
  ok(galvanicRisk('copper', 'tin', 'dry').ok === true, 'and passes in a sealed dry enclosure');
  ok(GALVANIC_LIMITS.harsh.maxDeltaV < GALVANIC_LIMITS.dry.maxDeltaV, 'harsh environments allow less');
  ok(galvanicRisk('copper', 'copper').deltaV === 0, 'a metal against itself is no couple at all');
  ok(galvanicRisk('copper', 'nonsense') === null, 'an unknown material is refused, not guessed');
});

test('the connection graph is built from the design, and marks its estimates', () => {
  const d = designFromSpec({ application: 'ev', energyWh: 60000 });
  const cell = cellById(d.cell.id);
  const t = buildTopology({ summary: d.pack, partition: d.architecture.partition, cellForm: cell.form });
  ok(t.nodes.length > 10 && t.edges.length > 10 && t.joints.length > 10, 'it has real structure');
  ok(t.nodes.some((n) => n.kind === 'pack-terminal') && t.nodes.some((n) => n.kind === 'chassis'),
    'including the terminals and the chassis the isolation is measured against');
  ok(t.totals.interconnectMOhm > 0 && t.totals.dropAtContV > 0 && t.totals.lossAtContW > 0,
    'and produces resistance, voltage drop and loss at continuous current');
  ok(t.totals.conductorMassKg > 0, 'and a conductor mass');
  ok(t.estimated && t.notes.some((n) => /estimated/i.test(n)),
    'run lengths are estimated from the envelope, and it says so rather than implying measurement');
  // Given real lengths, it stops estimating.
  const measured = buildTopology({
    summary: d.pack, partition: d.architecture.partition, cellForm: cell.form,
    lengths: { groupPitchMm: 40, moduleRunMm: 120, packRunMm: 300 },
  });
  ok(!measured.estimated, 'measured lengths are used as given');
  ok(measured.totals.interconnectMOhm !== t.totals.interconnectMOhm, 'and they change the answer');
});

test('a plated joint is judged on the surfaces that actually meet', () => {
  const d = designFromSpec({ application: 'ev', energyWh: 60000 });
  const cell = cellById(d.cell.id);
  const good = buildTopology({ summary: d.pack, partition: d.architecture.partition, cellForm: cell.form });
  const failing = jointCompatibility(good, 'harsh').filter((j) => !j.risk.ok);
  ok(failing.length <= 2,
    `a sound design is quiet: ${failing.length} joint(s) flagged out of ${good.joints.length}`);
  // Bolting bare aluminium to copper is the classic mistake, and it must shout.
  const bad = buildTopology({
    summary: d.pack, partition: d.architecture.partition, cellForm: 'prismatic',
    busbarMaterial: 'aluminium', plating: 'copper',
  });
  const badJoints = jointCompatibility(bad, 'harsh').filter((j) => !j.risk.ok);
  ok(badJoints.length > 50, `and a bad one is loud: ${badJoints.length} joints flagged`);
});

test('the bill of materials is what the customer receives, gaps admitted', () => {
  const d = designFromSpec({ application: 'ev', energyWh: 60000 });
  const cell = cellById(d.cell.id);
  const t = buildTopology({ summary: d.pack, partition: d.architecture.partition, cellForm: cell.form });
  const bom = billOfMaterials({ topology: t, summary: d.pack, cell, selection: {} });
  ok(bom.lines.length >= 3, 'it has lines');
  ok(bom.lines.some((l) => l.group === 'Cells' && l.qty === d.pack.cellCount), 'the cells, counted');
  ok(bom.lines.some((l) => l.group === 'Conductors'), 'the conductors, by material');
  ok(bom.lines.some((l) => l.group === 'Joints'), 'and the joints, because every one is a galvanic couple');
  ok(bom.totals.massKg > d.pack.massKg * 0.5, 'the mass is real, not a placeholder');
  ok(bom.totals.knownCost > 0 && bom.totals.unpricedLines > 0, 'some lines are priced and some are not');
  ok(/treat the cost total as the priced subset/.test(bom.note),
    'and the total admits it covers only the priced subset — a BOM with silent gaps is worse than one that owns them');
  const mats = materialBreakdown(t);
  ok(mats.length > 0 && mats[0].massKg >= mats[mats.length - 1].massKg, 'materials ranked by mass');
  ok(mats.every((m) => m.co2Kg > 0), 'each carrying its embodied carbon, ready for the LCA that follows');
});

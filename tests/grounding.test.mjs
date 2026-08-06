// Grounding and bonding — the half of electrical safety nobody asks about.
//
// Isolation gets the attention because it has a number everyone quotes.
// Bonding is what decides the outcome once isolation has already failed, and
// these tests hold the three things it has to get right: continuity, touch
// voltage, and whether the strap survives the fault it exists for. Plus the
// two ways the question itself is wrong — a surface that does not conduct,
// and a machine that is deliberately not grounded at all.
import { test } from 'node:test';
import { ok, near } from './helpers.mjs';
import {
  BONDING_LIMIT, TOUCH_VOLTAGE_LIMIT_V, SURFACE_FINISHES, BOND_METHODS,
  assessBond, groundingStudy, faultFromShortCircuit,
} from '../js/grounding.js';
import { adiabaticK, conductorResistance } from '../js/materials.js';
import { K_ADIABATIC } from '../js/shortcircuit.js';
import { buildTopology } from '../js/topology.js';
import { designFromSpec } from '../js/api.js';
import { cellById } from '../js/cells.js';
import { buildArchitecture } from '../js/architecture.js';

const bond = (over = {}) => ({
  id: 'b1', materialId: 'copper', lengthMm: 250, areaMm2: 16, ...over,
});

const evTopo = () => {
  const d = designFromSpec({ application: 'ev', energyWh: 60000 });
  return {
    d,
    topo: buildTopology({ summary: d.pack, partition: d.architecture.partition, cellForm: cellById(d.cell.id).form }),
  };
};

test('the adiabatic constant is derived, and reproduces the published copper values', () => {
  // This is the proof the derivation is right rather than merely plausible:
  // the handbook numbers for copper fall out of the material properties.
  near(adiabaticK('copper', { initialC: 70, finalC: 160 }), K_ADIABATIC['pvc-insulated'], 1, 'PVC-insulated copper is 115');
  near(adiabaticK('copper', { initialC: 90, finalC: 250 }), K_ADIABATIC['xlpe-insulated'], 1, 'XLPE-insulated copper is 143');
  near(adiabaticK('copper', { initialC: 30, finalC: 500 }), 228, 2, 'bare copper is ~226-228');
  // Bare aluminium is the other value handbooks publish, and it lands too.
  near(adiabaticK('aluminium', { initialC: 30, finalC: 500 }), 148, 3, 'bare aluminium is ~148');
  // Which is the point: a non-copper bond is judged as itself.
  ok(adiabaticK('stainless-304') < adiabaticK('copper') / 4,
    'stainless is several times weaker than copper against the same fault');
  ok(adiabaticK('nickel') < adiabaticK('copper'), 'nickel is weaker too');
  ok(adiabaticK('nope') === null && adiabaticK('copper', { initialC: 500, finalC: 30 }) === null, 'null-safe');
});

test('a bond is checked on continuity, and the limit is the sourced one', () => {
  const b = assessBond(bond());
  near(b.resistanceOhm, conductorResistance({ materialId: 'copper', lengthM: 0.25, areaMm2: 16 }), 1e-12,
    'the resistance is R = rho L/A, same as everywhere else');
  ok(b.limitOhm === 0.1 && BONDING_LIMIT.testCurrentA === 0.2,
    'the limit is 0.1 ohm measured at 0.2 A, and the test current is carried with it');
  ok(BONDING_LIMIT.source.includes('6469') && BONDING_LIMIT.source.includes('R100'),
    'and it names the standards it comes from');
  ok(b.verdict === 'workable', 'a 250 mm 16 mm2 copper strap passes');

  // Worth knowing where the limit actually bites: 3 m of 1 mm2 copper is
  // only 52 mOhm, still inside it. For copper the continuity rule is very
  // hard to fail, which is exactly why the checks that matter are the
  // surface, the metal and the fault — not this one.
  const slender = assessBond(bond({ lengthMm: 3000, areaMm2: 1 }));
  ok(slender.resistanceOhm < BONDING_LIMIT.maxOhm,
    `even 3 m of 1 mm2 copper is inside the limit (${(slender.resistanceOhm * 1000).toFixed(0)} mOhm)`);

  // A stainless bracket pressed into service as the bond does fail it — the
  // realistic version of this mistake.
  const bracket = assessBond(bond({ materialId: 'stainless-304', lengthMm: 500, areaMm2: 2 }));
  ok(bracket.resistanceOhm > BONDING_LIMIT.maxOhm, 'a 500 mm stainless bracket at 2 mm2 is over it');
  ok(bracket.verdict === 'workable-with-costs', 'at under 3x the limit it is marginal rather than refused');
  ok(/needs about/.test(bracket.why), 'with the section it would need');
  // Far enough over and it stops being a margin problem.
  ok(assessBond(bond({ materialId: 'stainless-304', lengthMm: 500, areaMm2: 1 })).verdict === 'not-workable',
    'half the section is refused outright');
});

test('a surface that does not conduct is not a bonding path, whatever the strap measures', () => {
  const b = assessBond(bond({ finish: 'anodised', method: 'bolt-plain' }));
  ok(b.finishBlocks && b.verdict === 'not-workable', 'anodised under a plain bolt is refused');
  ok(b.resistanceOhm < BONDING_LIMIT.maxOhm, 'even though the strap itself is well inside the limit');
  ok(/irrelevant/.test(b.why), 'and the reason says the strap resistance is beside the point');

  // The two ways through a coating both work.
  ok(assessBond(bond({ finish: 'anodised', method: 'bolt-serrated' })).verdict === 'workable',
    'a serrated washer cuts through the oxide');
  ok(assessBond(bond({ finish: 'painted', method: 'welded' })).verdict === 'workable',
    'and a weld has no coating between the metals at all');
  ok(assessBond(bond({ finish: 'conversion-coated', method: 'bolt-plain' })).verdict === 'workable',
    'a conversion coating is specified precisely because it conducts');

  // Every declared finish and method is complete and usable.
  for (const [id, s] of Object.entries(SURFACE_FINISHES)) {
    ok(typeof s.conducts === 'boolean' && s.name && s.what, `${id} is a complete finish`);
    ok(assessBond(bond({ finish: id })) != null, `${id} produces an answer`);
  }
  for (const [id, m] of Object.entries(BOND_METHODS)) {
    ok(typeof m.cutsFinish === 'boolean' && m.name && m.what, `${id} is a complete method`);
  }
});

test('continuity alone is not enough — touch voltage and fault survival both bite', () => {
  // Inside the continuity limit, but the fault puts the case over 60 V.
  const shocking = assessBond(bond({ materialId: 'stainless-304', faultA: 6000, clearingS: 0.2 }));
  ok(shocking.resistanceOhm < BONDING_LIMIT.maxOhm, 'the bond passes on continuity');
  ok(shocking.touchV > TOUCH_VOLTAGE_LIMIT_V, `and still puts ${shocking.touchV.toFixed(0)} V on the case`);
  ok(shocking.verdict === 'not-workable', 'so it is refused');

  // A superb bond that burns open during the fault it exists for.
  const burns = assessBond(bond({ areaMm2: 6, faultA: 6000, clearingS: 0.2 }));
  ok(burns.resistanceOhm < BONDING_LIMIT.maxOhm && burns.touchV < TOUCH_VOLTAGE_LIMIT_V,
    'it passes continuity and touch voltage');
  ok(burns.survivesFault === false, 'but not the adiabatic check');
  ok(burns.verdict === 'not-workable', 'and that alone refuses it');
  ok(burns.needAreaMm2 > 6, 'with the section that would survive');
  // And the recommended section really does survive.
  const fixed = assessBond(bond({ areaMm2: burns.needAreaMm2 * 1.001, faultA: 6000, clearingS: 0.2 }));
  ok(fixed.survivesFault === true, 'the recommended section holds');
});

test('a bond judged on its own metal, not on copper borrowed from a handbook', () => {
  const steel = assessBond(bond({ materialId: 'stainless-304', faultA: 2000, clearingS: 0.05 }));
  const copper = assessBond(bond({ faultA: 2000, clearingS: 0.05 }));
  ok(steel.adiabaticK < copper.adiabaticK / 4, 'stainless carries far less fault current than copper');
  ok(steel.i2tLimit < copper.i2tLimit, 'so its limit is lower for the same section');
  // It still passes here — the continuity limit is generous — and that is
  // exactly why the tool has to say something about it anyway.
  ok(steel.verdict === 'workable', 'a stainless bond can pass the letter of the rule');
  ok(steel.structural && /structural material/.test(steel.why),
    'and the answer says it is a structural metal chosen for corrosion, not conduction');
  ok(copper.structural === null, 'a copper bond gets no such caveat');
});

test('the fault current comes from the short-circuit study, framed as the second fault', () => {
  const { d } = evTopo();
  const f = faultFromShortCircuit(d.shortCircuit);
  ok(f.faultA > 1000, `a real prospective current (${(f.faultA / 1000).toFixed(1)} kA)`);
  ok(f.clearingS > 0, 'and a clearing time');
  // The framing matters more than the number: a floating pack's FIRST
  // isolation fault draws nothing, which is a trap for anyone sizing a bond.
  ok(/second/i.test(f.basis) && /float/i.test(f.basis),
    'the basis explains that this is the second-fault case on a floating pack');
  ok(faultFromShortCircuit(null) === null && faultFromShortCircuit({}) === null, 'null-safe');
});

test('an ungrounded machine is told the question does not apply, not graded against it', () => {
  const { d, topo } = evTopo();
  const marineArchitecture = buildArchitecture({
    cell: cellById(d.cell.id), s: d.pack.s, p: d.pack.p, summary: d.pack,
    options: { appId: 'marine' },
  });
  const g = groundingStudy({
    topology: topo, application: 'marine', packVMax: 400,
    isolation: marineArchitecture.isolationReview,
    isolationMonitoring: marineArchitecture.isolationMonitoring,
    faultA: 6000, clearingS: 0.2,
  });
  ok(g.ungrounded, 'marine is flagged as conventionally ungrounded');
  ok(g.verdict === 'unproven', 'so the verdict is not a pass or a fail');
  const warn = g.findings.find((f) => /ungrounded/i.test(f.title));
  ok(warn && /corrosion/i.test(warn.detail), 'the reason is the galvanic one, not a hand-wave');
  ok(/insulation monitoring/i.test(warn.detail), 'and it names what IS required instead');
  ok(/completeness/i.test(g.headline), 'and the headline captions the numbers rather than grading them');
  ok(g.isolationMonitoring.status === 'required-first-fault-monitoring'
    && g.ontologyRuleId === 'bd:rule/un-r100-isolation',
  'grounding study consumes the architecture monitoring decision and preserves ontology lineage');
  ok(!g.findings.some((f) => /not active in the architecture/i.test(f.title)),
    'a consistent marine architecture creates no monitoring mismatch');

  const mismatch = groundingStudy({
    topology: topo, application: 'marine', packVMax: 400,
    isolationMonitoring: { status: 'not-required', required: false },
  });
  ok(mismatch.findings.some((f) => /not active in the architecture/i.test(f.title)),
    'an inconsistent first-fault monitoring state is surfaced for review');

  // Having said the rule does not govern, it must not then report failures
  // against that rule as failures — even when a path genuinely fails it.
  const failing = groundingStudy({
    topology: topo, application: 'marine', packVMax: 400,
    faultA: 6000, clearingS: 0.2, bonds: [bond({ areaMm2: 6 })],
  });
  ok(failing.totals.failing === 1, 'the path does fail the automotive rule');
  ok(!failing.findings.some((f) => f.severity === 'fail'),
    'but no hard failure is raised against a rule that was just said not to apply');
  ok(failing.findings.some((f) => /completeness/i.test(f.detail)), 'the number is captioned instead');

  // A road vehicle is chassis-referenced, and IS graded.
  const ev = groundingStudy({ topology: topo, application: 'ev', packVMax: 400, faultA: 6000, clearingS: 0.2, bonds: [bond({ areaMm2: 6 })] });
  ok(!ev.ungrounded && ev.verdict === 'not-workable', 'the same bond on a road vehicle is refused');
});

test('below 60 V there is no shock hazard to bond against, and it says so', () => {
  const { topo } = evTopo();
  const g = groundingStudy({ topology: topo, application: 'ebike', packVMax: 54.6 });
  ok(g.lowVoltage, 'a 54.6 V pack is under the boundary');
  const note = g.findings.find((f) => /no shock hazard/i.test(f.title));
  ok(note, 'and the study says so rather than demanding a bond');
  ok(/EMC|static|charger/i.test(note.detail), 'while naming the reasons one might still be wanted');
  ok(!groundingStudy({ topology: topo, application: 'ev', packVMax: 400 }).lowVoltage,
    'a 400 V pack is not');
});

test('an assumed bonding scheme is never passed off as a described one', () => {
  const { topo } = evTopo();
  const assumed = groundingStudy({ topology: topo, application: 'ev', packVMax: 400 });
  ok(assumed.estimated, 'with no bonds given, the scheme is assumed');
  ok(assumed.findings.some((f) => /assumed, not described/i.test(f.title)), 'and that is a finding');
  ok(assumed.totals.unproven > 0, 'fault survival is unproven with no fault current');
  ok(assumed.verdict === 'unproven', 'so the verdict is unproven rather than a pass');

  const described = groundingStudy({
    topology: topo, application: 'ev', packVMax: 400, faultA: 5000, clearingS: 0.02,
    bonds: [bond(), bond({ id: 'b2', lengthMm: 400, areaMm2: 25 })],
  });
  ok(!described.estimated, 'given bonds are not flagged as assumed');
  ok(described.totals.pathsChecked === 2, 'and every one is checked');
  ok(described.verdict === 'workable', 'two good bonds pass outright');
});

test('the study states what it assumes, including what it does NOT cover', () => {
  const { topo } = evTopo();
  const g = groundingStudy({ topology: topo, application: 'ev', packVMax: 400, faultA: 5000, clearingS: 0.02 });
  ok(g.assumptions.some((a) => /contact resistance/i.test(a)),
    'that a real joint adds contact resistance this does not model');
  ok(g.assumptions.some((a) => /Isolation and bonding are separate/i.test(a)),
    'and that passing here says nothing about the isolation floor');
  ok(g.assumptions.some((a) => /0\.2 A/.test(a)), 'the test current is stated with the limit');
  ok(['workable', 'workable-with-costs', 'not-workable', 'unproven'].includes(g.verdict),
    'the verdict is house vocabulary');
  ok(groundingStudy({ topology: null }) === null, 'no topology gives no answer');
  ok(assessBond(bond({ areaMm2: 0 })) === null && assessBond(bond({ materialId: 'nope' })) === null, 'null-safe');
});

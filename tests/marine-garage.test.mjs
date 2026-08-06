// Vessel Twin — the marine adapter over the shared swap/compare engine.
//
// The important contract is not a second marine configurator. Vessel, voyage,
// PMS, cells and hardware all travel through the same immutable applySwap →
// designFromSpec path, so the result shown here is the result exported by the
// API and report.
import { test } from 'node:test';
import { eq, near, ok } from './helpers.mjs';
import {
  METRICS, applySwap, compare, partValue, partsBin,
} from '../js/garage.js';
import { workspaceCopy } from '../js/garage-ui.js';
import { designFromSpec } from '../js/api.js';
import { VESSEL_MODELS } from '../js/vessels.js';

const MILLIAMPERE = {
  application: 'marine',
  marine: { vesselId: 'ntnu-milliampere1' },
};

test('Vessel Twin exposes exactly the two governed NTNU vessels and marine controls', () => {
  const bin = partsBin('marine');
  const ids = bin.map((part) => part.id);
  const vessel = bin.find((part) => part.id === 'marine:vesselId');
  const pms = bin.find((part) => part.id === 'pms:policyId');

  ok(vessel?.kind === 'choice', 'vessel selection is a real choice control');
  eq(vessel.options.map((option) => option.value), VESSEL_MODELS.map((model) => model.id),
    'the selector is generated from the two complete vessel models');
  ok(vessel.options.length === 2, 'milliAmpere1 and Gunnerus are the only declared vessel choices');
  ok(vessel.options.every((option) => /^NTNU /.test(option.label) && option.hint),
    'each vessel is named and carries its evidence-bounded model context');

  ok(pms?.options.length === 7, 'all seven marine PMS studies are available');
  ok(pms.options.every((option) => option.value.startsWith('marine-') && /Sizing focus:/.test(option.hint)),
    'PMS choices say what they size rather than masquerading as measured demand');
  for (const id of [
    'marine:serviceSpeedKn', 'marine:durationH', 'marine:payloadKg',
    'marine:headCurrentKn', 'marine:headwindKn', 'marine:hotelW', 'marine:seaState',
  ]) ok(ids.includes(id), `${id} is available in the voyage controls`);

  ok(!ids.includes('terrain') && !ids.includes('driveMode') && !ids.includes('gradePct'),
    'the vessel is not offered road controls');
});

test('changing vessel atomically changes its voyage basis and PMS without inheriting evidence', () => {
  const original = {
    application: 'marine',
    vesselId: 'ntnu-milliampere1',
    policyId: 'marine-boost',
    marine: {
      vesselId: 'ntnu-milliampere1', serviceSpeedKn: 4.2,
      twinEvidence: { powerBasis: 'dc-bus-trace', calibrationTrialId: 'trial-a' },
      replaySamples: [{ tS: 0 }],
    },
    twinShip: { readiness: { assetId: 'milliampere-physical-1' } },
  };
  const next = applySwap(original, { part: 'marine:vesselId', value: 'ntnu-gunnerus' });

  ok(original.marine.vesselId === 'ntnu-milliampere1' && original.marine.serviceSpeedKn === 4.2,
    'the source spec is not mutated');
  ok(next.marine.vesselId === 'ntnu-gunnerus', 'the nested vessel id is authoritative');
  ok(next.vesselId === 'ntnu-gunnerus', 'an existing top-level compatibility alias stays in sync');
  near(next.marine.serviceSpeedKn, 10, 1e-12, 'Gunnerus starts from its published cruise point');
  near(next.marine.propulsionAtDesignW, 1000000, 1e-12, 'Gunnerus receives its published propulsion point');
  ok(next.policyId === 'marine-load-levelling', 'the vessel changes to its intended default PMS study');
  ok(next.marine.twinEvidence === undefined && next.marine.replaySamples === undefined && next.twinShip === undefined,
    'asset-specific trials and replay never cross-bind to a different vessel');

  const same = applySwap(original, { part: 'marine:vesselId', value: 'ntnu-milliampere1' });
  near(same.marine.serviceSpeedKn, 4.2, 1e-12, 'reselecting the same vessel preserves the customer voyage');
  ok(same.policyId === 'marine-boost' && same.marine.twinEvidence.calibrationTrialId === 'trial-a',
    'reselecting the same asset does not erase its PMS or evidence');
});

test('voyage and PMS controls use their real nested engine paths', () => {
  let spec = MILLIAMPERE;
  spec = applySwap(spec, { part: 'marine:serviceSpeedKn', value: 4 });
  spec = applySwap(spec, { part: 'marine:headCurrentKn', value: 1.2 });
  spec = applySwap(spec, { part: 'marine:seaState', value: 'rough' });
  spec = applySwap(spec, { part: 'pms:policyId', value: 'marine-peak-shaving' });

  ok(spec.marine.serviceSpeedKn === 4 && spec.marine.headCurrentKn === 1.2,
    'numeric voyage inputs stay inside the marine mission');
  ok(spec.marine.seaState === 'rough' && spec.policyId === 'marine-peak-shaving',
    'sea state is nested while the shared sizing engine receives policyId');
  ok(spec['marine:serviceSpeedKn'] === undefined && spec['pms:policyId'] === undefined,
    'no inert colon-named keys are written');
  ok(partValue(spec, 'marine:serviceSpeedKn') === 4
    && partValue(spec, 'marine:seaState') === 'rough'
    && partValue(spec, 'pms:policyId') === 'marine-peak-shaving',
  'the UI reads the same authoritative paths it writes');

  const design = designFromSpec(spec);
  ok(design.marine.inputs.serviceSpeedKn === 4 && design.marine.inputs.headCurrentKn === 1.2,
    'the marine physics received the displayed voyage values');
  ok(design.spec.resolved.sizing.policyId === 'marine-peak-shaving',
    'the selected PMS generated the battery trace used by simulation');
});

test('marine comparisons expose voyage demand, efficiency and mission feasibility', () => {
  const baseline = designFromSpec(MILLIAMPERE);
  const fasterSpec = applySwap(MILLIAMPERE, { part: 'marine:serviceSpeedKn', value: 4 });
  const faster = designFromSpec(fasterSpec);
  const comparison = compare(baseline, faster, { label: '4 kn service speed' });
  const changed = new Set(comparison.changes.map((change) => change.id));

  ok(faster.marine.metrics.propulsionW > baseline.marine.metrics.propulsionW,
    'the cubic hull screening relation responds to service speed');
  ok(faster.marine.energyPerNmWh > baseline.marine.energyPerNmWh,
    'the customer sees that faster operation costs more energy per nautical mile');
  for (const id of ['voyageDistanceNm', 'voyageEnergyWh', 'energyPerNmWh', 'propulsionW', 'voyagePeakW']) {
    ok(changed.has(id), `${id} appears in the shared before/after comparison`);
  }

  const marineMetrics = METRICS.filter((metric) => metric.group === 'voyage');
  ok(marineMetrics.length >= 7 && marineMetrics.every((metric) => metric.get(baseline) != null),
    'voyage, SoC, temperature and unserved-energy metrics all resolve on the marine result');
  ok(compare(baseline, baseline).verdict === 'no-change',
    'zero unserved energy remains unchanged rather than creating a false 0 → 0 delta');
  const road = designFromSpec({ application: 'ev', energyWh: 60000 });
  ok(marineMetrics.every((metric) => metric.get(road) == null),
    'marine metrics do not alter the generic automotive comparison surface');
});

test('marine customer copy is Vessel Twin and never the automotive product name', () => {
  const marine = workspaceCopy('marine');
  ok(marine.title === 'Vessel Twin', 'the customer-facing marine name is exact');
  ok(!/garage/i.test(JSON.stringify(marine)), 'no marine title, introduction or empty state says Garage');
  ok(workspaceCopy('ev').title === 'The garage', 'the established automotive name remains unchanged');
});

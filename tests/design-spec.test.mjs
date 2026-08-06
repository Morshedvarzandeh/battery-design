import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DESIGN_SPEC_FORMAT,
  DESIGN_SPEC_SCHEMA,
  DESIGN_SPEC_SCHEMA_VERSION,
  DesignSpecValidationError,
  normalizeDesignSpec,
  validateDesignSpec,
} from '../js/design-spec.js';
import { designFromSpec } from '../js/api.js';

test('legacy and grouped DesignSpec inputs normalize into one versioned contract', () => {
  const input = {
    application: 'solar-ess',
    requirements: {
      energyWh: 25_000,
      contPowerW: 4_000,
      peakPowerW: 8_000,
      chargeRateC: 0.4,
      cyclesPerYear: 300,
      targetYears: 12,
      ambientC: [-10, 45],
    },
    architecture: { topology: 'wireless', channelsPerIc: 12 },
    thermal: { loopOverride: 'liquid' },
    charging: { obcOverride: 'auto' },
  };
  const normalized = normalizeDesignSpec(input);
  assert.equal(normalized.schemaVersion, DESIGN_SPEC_SCHEMA_VERSION);
  assert.equal(normalized.energyWh, 25_000);
  assert.equal(normalized.contPowerW, 4_000);
  assert.equal(normalized.peakPowerW, 8_000);
  assert.equal(normalized.chargeRateC, 0.4);
  assert.deepEqual(normalized.ambientC, [-10, 45]);
  assert.equal(normalized.thermalOverride, 'liquid');
  assert.equal(normalized.obcOverride, 'auto');
  assert.ok(Object.isFrozen(normalized) && Object.isFrozen(normalized.requirements));

  // A persisted canonical spec is itself a complete replay input.
  const first = designFromSpec(normalized);
  const replayed = designFromSpec(JSON.parse(JSON.stringify(first.spec)));
  assert.equal(replayed.binding.designChecksum, first.binding.designChecksum);
  assert.equal(replayed.binding.specChecksum, first.binding.specChecksum);
});

test('physical multipliers fail closed before reaching engineering models', () => {
  for (const invalid of [0, -0.1, 1.01, Number.NaN, Infinity, '0.8']) {
    const checked = validateDesignSpec({ application: 'ebike', dod: invalid });
    assert.equal(checked.valid, false);
    assert.equal(checked.normalized.dod, 0.8);
    assert.ok(checked.errors.some((entry) => entry.code === 'DOD_OUT_OF_RANGE'));
    const design = designFromSpec({ application: 'ebike', dod: invalid });
    assert.equal(design.spec.resolved.dod, 0.8);
    assert.ok(design.warnings.some((warning) => /depth of discharge/i.test(warning)));
  }
  assert.throws(
    () => normalizeDesignSpec({ dod: 0 }, { strict: true }),
    DesignSpecValidationError,
  );
});

test('runtime validation executes the exported schema, not only the DoD rule', () => {
  for (const [spec, path] of [
    [{ s: 'ninety-six' }, '$.s'],
    [{ layout: { spacingMm: -1 } }, '$.layout.spacingMm'],
    [{ efficiency: { chargeEff: 1.2 } }, '$.efficiency.chargeEff'],
    [{ profileTrace: { id: 'trace', dtS: 1, p: [0, 2], scaleW: 1000 } }, '$.profileTrace.p[1]'],
    [{ regulatory: { evaluationDate: '2026-02-30' } }, '$.regulatory.evaluationDate'],
  ]) {
    const checked = validateDesignSpec(spec);
    assert.equal(checked.valid, false, `invalid contract rejected: ${path}`);
    assert.ok(checked.errors.some((entry) => entry.path === path), `error identifies ${path}`);
    assert.throws(() => normalizeDesignSpec(spec, { strict: true }), DesignSpecValidationError);
  }
  assert.equal(validateDesignSpec({
    schemaVersion: DESIGN_SPEC_SCHEMA_VERSION,
    application: 'ev', s: 96, p: 4, dod: 0.8,
    layout: { spacingMm: 1, nx: 0, nz: 1 },
    regulatory: { batteryCategory: 'ev', evaluationDate: '2027-02-18' },
  }).valid, true);
});

test('architecture and thermal choices are consumed by the canonical engine run', () => {
  const design = designFromSpec({
    application: 'ebike',
    architecture: {
      topology: 'wireless',
      channelsPerIc: 12,
      cellsPerTempSensor: 4,
      interconnectMOhm: 8,
    },
    thermal: { loopOverride: 'liquid' },
  });
  assert.equal(design.architecture.bms.topology, 'wireless');
  assert.equal(design.architecture.bms.channelsPerIc, 12);
  assert.equal(design.architecture.resistance.interconnectMOhm, 8);
  assert.equal(design.thermal.loop.id, 'liquid');
});

test('the whole design result and its semantic binding are deeply immutable', () => {
  const spec = {
    application: 'solar-ess',
    policyId: 'grid-peak-shaving',
    requirements: { energyWh: 20_000, peakPowerW: 8_000 },
    mission: { passes: 2, startSoC: 0.9 },
    compareCellIds: ['lg-inr18650-mj1'],
  };
  const design = designFromSpec(spec, { includeTraces: true });
  for (const value of [
    design, design.spec, design.spec.resolved, design.pack, design.pack.dims,
    design.architecture, design.thermal, design.simulation, design.simulation?.trace,
    design.semantics, design.semantics.graph, design.binding,
  ].filter(Boolean)) assert.ok(Object.isFrozen(value));

  assert.equal(design.binding.format, 'battery-design/result-binding/v1');
  assert.equal(design.binding.specSchemaVersion, DESIGN_SPEC_SCHEMA_VERSION);
  assert.equal(design.binding.semanticChecksum, design.semantics.graph.checksum);
  for (const key of ['specChecksum', 'semanticChecksum', 'designChecksum']) {
    assert.match(design.binding[key], /^[a-f0-9]{64}$/);
  }
  assert.throws(() => { design.pack.dims.x = 0; }, TypeError);
  assert.throws(() => { design.findings.push({ severity: 'pass' }); }, TypeError);

  const second = designFromSpec(spec, { includeTraces: true });
  assert.equal(second.binding.designChecksum, design.binding.designChecksum);
  assert.equal(second.binding.semanticChecksum, design.binding.semanticChecksum);
});

test('the exported schema identifies and freezes the full DesignSpec contract', () => {
  assert.equal(DESIGN_SPEC_SCHEMA.$id, `${DESIGN_SPEC_FORMAT}/${DESIGN_SPEC_SCHEMA_VERSION}`);
  assert.ok(Object.isFrozen(DESIGN_SPEC_SCHEMA));
  for (const key of [
    'requirements', 'climate', 'architecture', 'thermal', 'charging', 'vehicle', 'route',
    'profileTrace', 'mission', 'components', 'layout', 'market', 'diagnostics',
    'conditionMonitoring', 'electricalProtection', 'marine', 'twinShip', 'flight',
    'efficiency', 'compareCellIds',
  ]) assert.ok(DESIGN_SPEC_SCHEMA.properties[key], `schema documents ${key}`);
  for (const key of [
    'topology', 'channelsPerIc', 'linkCapUF', 'prechargeTimeS', 'prechargesPerHour',
    'cellsPerTempSensor', 'racksOverride', 'lvBusV', 'auxPowerW', 'interconnectMOhm',
  ]) assert.ok(DESIGN_SPEC_SCHEMA.properties.architecture.properties[key], `schema documents architecture.${key}`);
  for (const group of ['precharge', 'shunt', 'fast']) {
    assert.ok(DESIGN_SPEC_SCHEMA.properties.electricalProtection.properties[group]);
  }
});

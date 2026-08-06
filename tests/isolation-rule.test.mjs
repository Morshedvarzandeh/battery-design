import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ISOLATION_CONTEXTS,
  resolveIsolationRule,
  UN_R100_ISOLATION_SOURCE,
} from '../js/isolation-rule.js';
import {
  buildArchitecture,
  isolationRequirement,
  ISOLATION_STANDARDS,
} from '../js/architecture.js';
import { analyze } from '../js/engineering.js';
import { runChecks } from '../js/standards.js';
import { cellById } from '../js/cells.js';
import { layoutPack, summarize } from '../js/pack-engine.js';

const road = { workingVoltageV: 400, applicationContext: 'road-vehicle' };

const governedTopologyCases = [
  ['un-r100-separate-dc', 'none', 100],
  ['un-r100-separate-ac', 'none', 500],
  ['un-r100-connected-ac-dc', 'none', 500],
  ['un-r100-connected-ac-dc-protected', 'double-or-more-solid-insulation', 100],
];

function hvDesignContext() {
  const cell = cellById('samsung-inr21700-50e');
  const s = 96;
  const p = 2;
  const layout = layoutPack(cell, s, p, {});
  const summary = summarize(cell, s, p, layout);
  return {
    cell,
    s,
    p,
    pack: summary,
    layout: { ...layout, spacingMm: 1, arrangement: 'grid', wallMm: 2 },
    selection: {},
    usage: { application: 'ev' },
  };
}

test('UN R100 separate DC bus resolves to 100 ohm/V', () => {
  const result = resolveIsolationRule({
    ...road,
    busType: 'dc',
    topology: 'galvanically-separated',
  });
  assert.equal(result.ohmsPerVolt, 100);
  assert.equal(result.floorKOhm, 40);
  assert.equal(result.clause, '5.1.3.1');
  assert.equal(result.contextId, 'un-r100-separate-dc');
});

test('UN R100 separate AC bus resolves to 500 ohm/V', () => {
  const result = resolveIsolationRule({
    ...road,
    busType: 'ac',
    topology: 'galvanically-separated',
  });
  assert.equal(result.ohmsPerVolt, 500);
  assert.equal(result.floorKOhm, 200);
  assert.equal(result.clause, '5.1.3.1');
  assert.equal(result.contextId, 'un-r100-separate-ac');
});

test('UN R100 galvanically connected AC/DC baseline resolves to 500 ohm/V', () => {
  const result = resolveIsolationRule({
    ...road,
    busType: 'ac-dc',
    topology: 'galvanically-connected',
  });
  assert.equal(result.ohmsPerVolt, 500);
  assert.equal(result.floorKOhm, 200);
  assert.equal(result.clause, '5.1.3.2');
  assert.equal(result.contextId, 'un-r100-connected-ac-dc');
});

test('isolation calculation coefficients come only from the matched ontology criterion', () => {
  for (const [contextId, acProtection, officialCoefficient] of governedTopologyCases) {
    assert.equal(
      Object.hasOwn(ISOLATION_CONTEXTS[contextId], 'ohmsPerVolt'),
      false,
      `${contextId} metadata must not own a duplicate numeric coefficient`
    );
    const result = resolveIsolationRule({
      ...road,
      contextId,
      acProtection,
    });
    const governedCoefficient = result.ontologyRule?.criterion?.coefficient;
    assert.deepEqual(governedCoefficient, {
      numericValue: officialCoefficient,
      unit: 'OhmPerV',
    });
    assert.equal(result.ontologyRule.applies, true);
    assert.equal(result.ontologyRule.complete, true);
    assert.deepEqual(result.ontologyRule.missingFacts, []);
    assert.equal(result.ohmsPerVolt, governedCoefficient.numericValue);
    assert.equal(result.floorOhm, road.workingVoltageV * governedCoefficient.numericValue);
    assert.equal(ISOLATION_STANDARDS[contextId].ohmsPerVolt, governedCoefficient.numericValue);
  }
});

test('governed isolation calculation refuses voltages outside the ontology rule scope', () => {
  for (const workingVoltageV of [48, 1601]) {
    assert.throws(
      () => resolveIsolationRule({
        workingVoltageV,
        applicationContext: 'road-vehicle',
        contextId: 'un-r100-separate-dc',
      }),
      /governed UN R100 ontology rule does not apply/i
    );
  }
});

test('missing vehicle bus topology refuses to invent or average a floor', () => {
  assert.throws(
    () => resolveIsolationRule(road),
    /contextId|busType\/topology|must not be averaged/i
  );
  assert.throws(
    () => resolveIsolationRule({ ...road, busType: 'dc' }),
    /topology|must not be averaged/i
  );
  assert.throws(
    () => isolationRequirement(400),
    /explicit UN R100 bus context|no topology may be guessed/i
  );
});

test('connected-bus 100 ohm/V exception requires the named AC protection evidence', () => {
  assert.throws(
    () => resolveIsolationRule({
      ...road,
      contextId: 'un-r100-connected-ac-dc-protected',
    }),
    /requires evidence.*every AC bus/i
  );
  const protectedResult = resolveIsolationRule({
    ...road,
    contextId: 'un-r100-connected-ac-dc-protected',
    acProtection: 'double-or-more-solid-insulation',
  });
  assert.equal(protectedResult.ohmsPerVolt, 100);
  assert.equal(protectedResult.acProtection, 'double-or-more-solid-insulation');
});

test('legacy selectors are reproducible aliases for explicit topology cases', () => {
  const connected = isolationRequirement(400, 'ece-r100');
  assert.equal(connected.contextId, 'un-r100-connected-ac-dc');
  assert.equal(connected.ohmsPerVolt, 500);
  assert.equal(connected.legacyAlias, 'ece-r100');

  const dc = isolationRequirement(400, 'iso-6469-dc');
  assert.equal(dc.contextId, 'un-r100-separate-dc');
  assert.equal(dc.ohmsPerVolt, 100);
  assert.equal(dc.legacyAlias, 'iso-6469-dc');
});

test('marine IT context refuses to reuse the road-vehicle chassis floor', () => {
  const result = resolveIsolationRule({
    workingVoltageV: 800,
    applicationContext: 'marine-it',
  });
  assert.equal(result.applies, false);
  assert.equal(result.status, 'review-required');
  assert.equal(result.floorKOhm, null);
  assert.match(result.basis, /class rules and flag-state requirements/i);
  assert.match(result.groundingNote, /intentionally unearthed|marine IT/i);

  const ctx = hvDesignContext();
  const architecture = buildArchitecture({
    cell: ctx.cell,
    s: ctx.s,
    p: ctx.p,
    summary: ctx.pack,
    options: { appId: 'marine', isolationStandard: 'ece-r100' },
  });
  assert.equal(architecture.isolation, null, 'marine architecture exposes no road-vehicle numeric floor');
  assert.equal(architecture.isolationReview?.status, 'review-required');
  assert.match(architecture.isolationReview?.basis || '', /class rules and flag-state requirements/i);
});

test('conflicting context fields are rejected instead of choosing one silently', () => {
  assert.throws(
    () => resolveIsolationRule({
      ...road,
      contextId: 'un-r100-separate-dc',
      busType: 'ac',
      topology: 'galvanically-separated',
    }),
    /conflicts with context/i
  );
  assert.throws(
    () => resolveIsolationRule({
      workingVoltageV: 800,
      applicationContext: 'marine-it',
      contextId: 'not-a-real-context',
    }),
    /Unknown isolation context/i
  );
});

test('results retain the primary source identity and exact clauses', () => {
  assert.equal(UN_R100_ISOLATION_SOURCE.code, 'UN R100 Rev. 3');
  assert.deepEqual(UN_R100_ISOLATION_SOURCE.clauses, ['5.1.3.1', '5.1.3.2']);
  assert.match(UN_R100_ISOLATION_SOURCE.url, /^https:\/\/unece\.org\//);
});

test('engineering and standards consumers refuse a number when context is missing', () => {
  const ctx = hvDesignContext();
  const engineering = analyze(ctx).perspectives.electrical;
  const isolationFinding = engineering.find((finding) => finding.id === 'hv-isolation-context');
  assert.ok(isolationFinding);
  assert.equal(isolationFinding.severity, 'warn');
  assert.match(isolationFinding.detail, /No numeric isolation floor is asserted/i);

  const standards = runChecks(ctx);
  const voltageClass = standards.find((finding) => finding.id === 'voltage-class');
  assert.ok(voltageClass);
  assert.match(voltageClass.detail, /No numeric isolation floor is asserted/i);
});

test('engineering and standards consumers use the same resolved topology case', () => {
  const ctx = {
    ...hvDesignContext(),
    isolationContext: {
      applicationContext: 'road-vehicle',
      busType: 'dc',
      topology: 'galvanically-separated',
    },
  };
  const engineering = analyze(ctx).perspectives.electrical;
  const isolationFinding = engineering.find((finding) => finding.id === 'hv-isolation');
  assert.ok(isolationFinding);
  assert.match(isolationFinding.detail, /100 Ω\/V/);
  assert.match(isolationFinding.detail, /§5\.1\.3\.1/);

  const standards = runChecks(ctx);
  const voltageClass = standards.find((finding) => finding.id === 'voltage-class');
  assert.ok(voltageClass);
  assert.match(voltageClass.detail, /resolves to 100 Ω\/V/);
  assert.match(voltageClass.detail, /§5\.1\.3\.1/);
});

test('orchestrated consumers use one immutable resolution even if a stale context disagrees', () => {
  const ctx = hvDesignContext();
  const resolved = isolationRequirement(ctx.pack.vMax, 'un-r100-separate-dc', {
    applicationContext: 'road-vehicle',
  });
  assert.equal(Object.isFrozen(resolved), true);
  assert.equal(Object.isFrozen(resolved.ontologyRule), true);
  assert.equal(resolved.workingVoltageV, ctx.pack.vMax);

  const orchestrated = {
    ...ctx,
    isolationResolution: resolved,
    // Deliberately contradictory fallback input: it must never be evaluated
    // once the orchestrator supplies the authoritative result.
    isolationContext: {
      applicationContext: 'road-vehicle',
      contextId: 'un-r100-connected-ac-dc',
    },
  };
  const engineering = analyze(orchestrated).perspectives.electrical;
  const isolationFinding = engineering.find((finding) => finding.id === 'hv-isolation');
  assert.match(isolationFinding.detail, /100 Ω\/V/);
  assert.doesNotMatch(isolationFinding.detail, /500 Ω\/V/);

  const standards = runChecks(orchestrated);
  const voltageClass = standards.find((finding) => finding.id === 'voltage-class');
  assert.match(voltageClass.detail, /resolves to 100 Ω\/V/);
  assert.doesNotMatch(voltageClass.detail, /resolves to 500 Ω\/V/);
});

test('a stale immutable resolution is rejected rather than applied at another voltage', () => {
  const ctx = hvDesignContext();
  const stale = isolationRequirement(400, 'un-r100-separate-dc', {
    applicationContext: 'road-vehicle',
  });
  assert.notEqual(stale.workingVoltageV, ctx.pack.vMax);
  const supplied = { ...ctx, isolationResolution: stale };

  const engineering = analyze(supplied).perspectives.electrical;
  assert.ok(engineering.find((finding) => finding.id === 'hv-isolation-context'));
  assert.equal(engineering.some((finding) => finding.id === 'hv-isolation'), false);

  const voltageClass = runChecks(supplied).find((finding) => finding.id === 'voltage-class');
  assert.match(voltageClass.detail, /No numeric isolation floor is asserted/i);
});

test('marine consumers keep the IT topology and class-rule caveat', () => {
  const ctx = hvDesignContext();
  ctx.usage.application = 'marine';

  const engineering = analyze(ctx).perspectives.electrical;
  const isolationFinding = engineering.find((finding) => finding.id === 'hv-isolation-context');
  assert.ok(isolationFinding);
  assert.match(isolationFinding.title, /Marine isolation basis requires review/i);
  assert.match(isolationFinding.detail, /class rules and flag-state requirements/i);

  const standards = runChecks(ctx);
  const voltageClass = standards.find((finding) => finding.id === 'voltage-class');
  assert.ok(voltageClass);
  assert.equal(voltageClass.title, 'High-voltage safety basis required');
  assert.doesNotMatch(voltageClass.detail, /is voltage class B under ECE R100/i);
  assert.match(voltageClass.ref, /marine class \/ flag-state/i);
});

test('a low-voltage marine pack is not labelled by the road-vehicle rule', () => {
  const ctx = hvDesignContext();
  ctx.usage.application = 'marine';
  ctx.pack = { ...ctx.pack, vMax: 48 };
  ctx.isolationResolution = null;
  const voltageClass = runChecks(ctx).find((finding) => finding.id === 'voltage-class');
  assert.ok(voltageClass);
  assert.equal(voltageClass.severity, 'info');
  assert.match(voltageClass.title, /marine basis still required/i);
  assert.doesNotMatch(voltageClass.detail, /so it is voltage class A/i);
  assert.match(voltageClass.detail, /first-fault monitoring/i);
});

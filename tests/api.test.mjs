// API — the designer without a browser, and the MCP surface an AI drives it
// through. The point of these tests is that the headless engine is the SAME
// designer: same modules, same numbers, no second implementation to drift.
import { test } from 'node:test';
import { ok, near } from './helpers.mjs';
import {
  buildDesignSemanticGraph, designFromSpec, briefFromDesign, describeOntology, listApplications, listCells, listVessels,
  resolveMarineSizing, SPEC_FIELDS, API_VERSION,
} from '../js/api.js';
import { handleMessage } from '../desktop/mcp-server.mjs';
import { PRESETS } from '../js/presets.js';
import { CELLS, cellById } from '../js/cells.js';
import { summarize, layoutPack, defaultArrangement } from '../js/pack-engine.js';
import { costModel } from '../js/optimizer.js';
import { analyze } from '../js/engineering.js';
import { DEFAULTS_BY_FORM, componentById } from '../js/components.js';
import { replayDatasetSha256 } from '../js/marine-workspace.js';

const governedShoreConnection = () => ({
  mode: 'ac', voltageV: 400, phases: 3, frequencyHz: 50, powerFactor: 0.9,
  ratedPowerKW: 100, ratedCurrentA: 100000 / (Math.sqrt(3) * 400 * 0.9), efficiency: 0.95,
  outputVoltageMinV: 400, outputVoltageMaxV: 1000,
  connector: { id: 'project-marine-inlet-01', name: 'Project marine inlet 01' },
  earthing: { declared: true, scheme: 'Project drawing E-04 earthing scheme' },
  isolation: { declared: true, method: 'Project-declared isolated conversion equipment' },
  interlock: { declared: true, description: 'Project PLC connection permissive' },
  emergencyDisconnect: { declared: true, description: 'Project emergency disconnect chain' },
  evidence: { kind: 'project', source: 'Project drawing E-04', revision: 'Rev C', date: '2026-07-01' },
});

test('a one-field specification produces a complete, honest design', () => {
  const d = designFromSpec({ application: 'ev' });
  ok(d.apiVersion === API_VERSION, 'the answer says which API produced it');
  ok(d.pack.cellCount > 0 && d.pack.energyWh > 0, 'a real pack came out');
  ok(d.spec.resolved.cell && d.spec.resolved.s > 0 && d.spec.resolved.p > 0,
    'every default it chose is recorded, so the answer is reproducible');
  for (const part of ['architecture', 'thermal', 'sensors', 'charging', 'v2x', 'cost', 'co2', 'checklist']) {
    ok(d[part] != null, `${part} is present`);
  }
  ok(d.findings.length > 5, 'the audit ran');
  ok(Array.isArray(d.concepts) && d.concepts.includes('hv-chain'), 'the knowledge graph travels with it');
  ok(d.checklist.rules.some((rule) => rule.code === 'ONTOLOGY-CONFORMANCE' && rule.scope === 'pass'),
    'the release checklist has an explicit architecture-ontology conformance gate');
  ok(d.warnings.length === 0, 'a valid spec produces no warnings');
});

test('semantic claims are generated, never accepted from the caller', () => {
  const d = designFromSpec({
    application: 'ev',
    ontology: { version: 'attacker-version', checksum: 'trusted-by-caller' },
    semantics: { conforms: true, feasibility: 'pass', evidenceMaturity: 'approved' },
  });
  ok(d.spec.ontology === undefined && d.spec.semantics === undefined,
    'caller ontology and semantic fields are stripped from the portable resolved specification');
  ok(d.semantics.ontology.version !== 'attacker-version'
    && d.semantics.ontology.checksum !== 'trusted-by-caller',
  'the returned snapshot is generated from the versioned architecture ontology');
  ok(d.semantics.graph.validation.conforms === d.semantics.conforms,
    'the compact status is an exact projection of the authoritative generated graph');
  ok(d.warnings.some((warning) => /caller-supplied ontology or semantics were ignored/i.test(warning)),
    'the refusal is visible rather than silently accepting or echoing a claim');
  const rebuilt = buildDesignSemanticGraph(d);
  ok(rebuilt.checksum === d.semantics.graph.checksum,
    'the returned authoritative graph is the checksum-stable graph of the final checklist and findings');
});

test('the headless engine agrees with the modules the UI uses', () => {
  const d = designFromSpec({ application: 'ebike', cell: 'samsung-inr21700-50e', s: 13, p: 4 });
  const c = cellById('samsung-inr21700-50e');
  const layout = layoutPack(c, 13, 4, {
    arrangement: defaultArrangement(c), spacingMm: 1, wallMm: 2, headroomMm: 8,
  });
  const direct = summarize(c, 13, 4, layout);
  near(d.pack.energyWh, direct.energyWh, 1e-9, 'same energy as calling the pack engine directly');
  near(d.pack.massCellsKg, direct.massCellsKg, 1e-9, 'same cell mass');
  near(d.pack.nominalV, direct.nominalV, 1e-9, 'same voltage');

  // Pack mass deliberately does NOT match summarize()'s figure, and that
  // difference is the agreement being checked. summarize() carries a
  // placeholder — 8% on the cells plus an aluminium box — because it runs
  // before any part has been chosen. Once the engine has fitted real busbars,
  // holders and an enclosure it uses their masses, exactly as the components
  // tab does. What must hold is that it is analyze()'s number, not a third one.
  const fitted = Object.fromEntries(Object.entries(DEFAULTS_BY_FORM[c.form])
    .map(([k, id]) => [k, componentById(k, id)]));
  const a = analyze({
    cell: c, s: 13, p: 4, pack: direct, selection: fitted,
    layout: {
      arrangement: defaultArrangement(c), orientation: 'upright', spacingMm: 1, wallMm: 2,
      inner: layout.inner, outer: layout.outer, nx: layout.nx, ny: layout.ny, nz: layout.nz,
    },
    usage: { dod: 0.8, cyclesPerYear: null, targetYears: null },
  });
  near(d.pack.massKg, a.totals.packMassWithComponentsKg, 5e-3,
    'mass comes from the parts actually fitted, via analyze(), not a re-derivation');
  ok(Math.abs(d.pack.massKg - direct.massKg) > 1e-6,
    'and it is not the pre-selection placeholder — that would mean no component was ever fitted');
  const cost = costModel(c, direct.cellCount, direct.energyWh, { dod: 0.8, cyclesPerYear: d.spec.resolved ? null : null });
  near(d.cost.upfrontUSD, cost.upfrontUSD, 1e-9, 'and the same cost model, not a re-derivation');
});

test('the result is plain data — it survives JSON without loss', () => {
  const d = designFromSpec({ application: 'ev', energyWh: 60000, profileId: 'vehicle', v2xPolicy: 'v2g' });
  const round = JSON.parse(JSON.stringify(d));
  near(round.pack.energyWh, d.pack.energyWh, 1e-9, 'energy survives');
  near(round.vehicle.drive.whPerKm, d.vehicle.drive.whPerKm, 1e-9, 'consumption survives');
  ok(round.v2x.parts.length === d.v2x.parts.length, 'the V2X parts list survives');
  ok(d.semantics.counts.nodes < 300 && d.semantics.counts.edges < 500,
    'the complete architecture graph remains structurally bounded');
  ok(d.simulation?.trace === undefined && d.spec.profileTrace === undefined,
    'raw/full traces are not copied into the portable result');
  ok(d.vehicle.drive.w === undefined, 'the second-by-second watt trace is deliberately left out of the summary');
});

test('EU passport applicability is one governed result across API, findings and ontology', () => {
  const design = designFromSpec({
    application: 'solar-ess', energyWh: 10_000,
    batteryCategory: 'industrial', evaluationDate: '2027-02-18',
  });
  ok(design.eu.batteryCategory === 'industrial'
    && design.eu.evaluationDate === '2027-02-18',
  'the declared category and deterministic assessment date reach the API result');
  ok(design.eu.findings.some((finding) => finding.ontologyRuleId === 'bd:rule/eu-battery-passport'
    && /passport applies/i.test(finding.title)),
  'the regulatory evaluator returns the same rule identity as the customer finding');
  ok(design.findings.some((finding) => finding.ontologyRuleId === 'bd:rule/eu-battery-passport'),
    'the governed result participates in the shared audit rather than a browser-only panel');
  ok(/EU assessment: category industrial · 2027-02-18 · Battery passport applies/i.test(briefFromDesign(design)),
    'the governed category, date and decision reach human API, CLI and MCP output as well as JSON');
  const ruleNode = design.semantics.graph.nodes.find((node) =>
    node.properties?.key === 'eu-battery-passport');
  ok(ruleNode && design.semantics.graph.edges.some((edge) =>
    edge.type === 'bd:appliesRule' && edge.to === ruleNode.id),
  'the exact evaluated rule is linked from the generated design graph');

  const unresolved = designFromSpec({
    application: 'solar-ess', energyWh: 10_000,
    batteryCategory: 'industral', evaluationDate: '2027-02-18',
  });
  ok(unresolved.eu.batteryCategory === 'industral'
    && unresolved.eu.findings.some((finding) => /needs a declared battery category/i.test(finding.title)),
  'an unknown category fails to review instead of becoming not applicable');
});

test('unknown inputs are corrected in the open, never silently', () => {
  const d = designFromSpec({ application: 'flying-carpet', cell: 'unobtainium' });
  ok(d.warnings.length === 2, 'both unknowns are reported');
  ok(d.warnings.some((w) => /flying-carpet/.test(w) && /listApplications/.test(w)),
    'and each says how to find the real ids');
  ok(d.pack.cellCount > 0, 'while still returning something usable');
});

test('every application designs without throwing', () => {
  for (const pr of PRESETS) {
    const d = designFromSpec({ application: pr.id });
    ok(d.pack.energyWh > 0, `${pr.id}: produced a pack`);
    ok(!/undefined|NaN/.test(briefFromDesign(d)), `${pr.id}: the brief has no leaks`);
    // Road machines get a vehicle model; the rest must NOT invent one.
    const drives = ['ev', 'ebus', 'ebike', 'escooter', 'robot'].includes(pr.id);
    ok(!!d.vehicle === drives, `${pr.id}: vehicle model present exactly when it should be`);
  }
});

test('the brief answers the questions a customer actually asks', () => {
  const d = designFromSpec({ application: 'ev', energyWh: 60000, profileId: 'vehicle', v2xPolicy: 'v2g' });
  const b = briefFromDesign(d);
  ok(/kWh/.test(b) && /cells/.test(b) && /kg/.test(b), 'what the pack is');
  ok(/Wh\/km/.test(b) && /range/.test(b), 'what it consumes and how far it goes');
  ok(/20→80%/.test(b) || /Charges via/.test(b), 'how it charges');
  ok(/per kWh delivered/.test(b), 'what it costs over its life, not just to buy');
  ok(/Audit: \d+ fail/.test(b), 'and what is wrong with it');
  // A tiny pack is reported in Wh and grams, not "0.00 kWh".
  const w = briefFromDesign(designFromSpec({ application: 'wearable' }));
  ok(/ Wh ·/.test(w) && / g ·/.test(w), 'small designs get sensible units');
});

test('listings are complete and self-describing', () => {
  const apps = listApplications();
  ok(apps.length === PRESETS.length, 'every preset is listed');
  ok(apps.every((a) => a.id && a.class && a.concepts.length), 'each with its class and its concepts');
  ok(apps.every((a) => a.sizing?.decision && Array.isArray(a.sizing.profileIds)),
    'software clients receive the knowledge-graph sizing choices');
  ok(listCells().length === CELLS.length, 'every cell is listed');
  ok(listCells({ chemistry: 'LFP' }).every((c) => c.chemistry === 'LFP'), 'chemistry filter works');
  ok(listCells().every((c) => c.dataQuality), 'and every record carries its data quality');
  ok(Object.keys(SPEC_FIELDS).length >= 10, 'the spec documents itself');
});

test('software clients can select a policy without losing profileId compatibility', () => {
  const grid = designFromSpec({ application: 'solar-ess', policyId: 'grid-peak-shaving' });
  ok(grid.spec.resolved.sizing.policyId === 'grid-peak-shaving', 'resolved spec records the policy');
  ok(grid.simulation.profile.kind === 'policy-output', 'simulation records that the trace was generated by policy');
  ok(grid.simulation.profile.sourceProfileId === 'grid-site-net-day', 'source demand remains traceable');
  const legacy = designFromSpec({ application: 'solar-ess', profileId: 'ess-daily' });
  ok(legacy.simulation.profile.id === 'ess-daily', 'existing profileId integrations still work');
  const wrong = designFromSpec({ application: 'ev', policyId: 'grid-peak-shaving' });
  ok(wrong.warnings.some((w) => /not available/.test(w)), 'cross-application policy is rejected openly');
});

test('headless marine output identifies both vessels and keeps TwinShip evidence honest', () => {
  const vessels = listVessels();
  ok(vessels.length === 2, 'the two evidenced NTNU vessels are discoverable');
  ok(vessels.map((v) => v.id).join('|') === 'ntnu-milliampere1|ntnu-gunnerus',
    'stable vessel ids distinguish the ferry prototype from the research vessel');
  ok(vessels.every((v) => v.evidence?.url && v.boundary),
    'each software-visible vessel carries its source and interpretation boundary');
  ok(vessels.find((v) => v.id === 'ntnu-milliampere1').policyId === 'marine-full-electric'
    && vessels.find((v) => v.id === 'ntnu-gunnerus').policyId === 'marine-load-levelling',
  'each vessel advertises the PMS policy the model will actually use by default');

  const ferry = designFromSpec({
    application: 'marine',
    marine: { vesselId: 'ntnu-milliampere1' },
  });
  ok(ferry.apiVersion === '1.3', 'the architecture-wide ontology is versioned in the API contract');
  ok(ferry.spec.resolved.sizing.policyId === 'marine-full-electric',
    'the ferry resolves its own full-electric default');
  ok(ferry.spec.resolved.vesselId === 'ntnu-milliampere1'
    && ferry.marine.vessel.id === 'ntnu-milliampere1', 'selected vessel identity reaches resolved and calculated output');
  ok(ferry.twinShip.architecture.vessel.id === 'ntnu-milliampere1',
    'the TwinShip architecture is bound to the same vessel');
  ok(ferry.twinShip.readiness.maturity === 'screening'
    && ferry.twinShip.readiness.missing.includes('Measured or supplied vessel power basis'),
  'no evidence is not upgraded into a calibrated model');
  ok(ferry.twinShip.replay.status === 'unproven'
    && /samples are required/i.test(ferry.twinShip.replay.diagnostics[0].detail),
  'missing replay data is explicit, not a clean residual result');
  ok(/lead-acid|VRLA/i.test(ferry.marine.vessel.boundary),
    'the ferry result says a lithium design is a replacement study');

  const replaySamples = Array.from({ length: 12 }, (_, index) => ({
    tS: index * 10,
    actualSpeedKn: 9.8 + index * 0.01, predictedSpeedKn: 9.7 + index * 0.01,
    actualCourseDeg: 5 + index * 0.1, predictedCourseDeg: 4 + index * 0.1,
    actualPowerW: 620000 + index * 1000, predictedPowerW: 610000 + index * 1000,
  }));
  const now = Date.now();
  const ago = (days) => new Date(now - days * 86400000).toISOString();
  const hash = {
    asset: 'a'.repeat(64), model: 'b'.repeat(64), calibration: 'c'.repeat(64),
    validation: 'd'.repeat(64),
  };
  const twinEvidence = {
    powerBasis: 'dc-bus-trace',
    assetEvidence: {
      assetId: 'private-api-asset-01', vesselId: 'ntnu-gunnerus',
      evidenceId: 'private-api-asset-record', revision: 'private-api-revision-3',
      issuedAt: ago(30), sha256: hash.asset,
    },
    modelEvidence: {
      artifactId: 'private-api-model-artifact', version: '4.2.0',
      vesselId: 'ntnu-gunnerus', assetId: 'private-api-asset-01', sha256: hash.model,
    },
    calibrationEvidence: {
      trialId: 'private-api-calibration-trial', vesselId: 'ntnu-gunnerus',
      assetId: 'private-api-asset-01', datasetSha256: hash.calibration,
      modelArtifactSha256: hash.model, completedAt: ago(20),
    },
    validationEvidence: {
      trialId: 'private-api-validation-trial', vesselId: 'ntnu-gunnerus',
      assetId: 'private-api-asset-01', datasetSha256: hash.validation,
      modelArtifactSha256: hash.model, completedAt: ago(10), result: 'pass',
      metrics: { speedRmsKn: 0.12, courseRmsDeg: 1.8, powerRmsFraction: 0.04 },
      limits: { speedRmsKn: 0.5, courseRmsDeg: 10, powerRmsFraction: 0.15 },
    },
    replayEvidence: {
      replayId: 'private-api-replay-record', vesselId: 'ntnu-gunnerus',
      assetId: 'private-api-asset-01', datasetSha256: replayDatasetSha256(replaySamples),
      modelArtifactSha256: hash.model, recordedAt: ago(1),
      maxAgeDays: 7, minSamples: 10, minDurationS: 60,
    },
  };
  const gunnerus = designFromSpec({
    application: 'marine',
    marine: {
      vesselId: 'ntnu-gunnerus',
      twinEvidence,
      replaySamples,
      replayOptions: { speedKn: 0.5, courseDeg: 10, powerFraction: 0.15, consecutive: 2 },
    },
    compareCellIds: ['catl-302ah-lfp'],
  });
  ok(gunnerus.spec.resolved.vesselId === 'ntnu-gunnerus'
    && gunnerus.twinShip.architecture.vessel.id === 'ntnu-gunnerus', 'the second vessel stays distinct end to end');
  ok(gunnerus.twinShip.readiness.maturity === 'digital-twin'
    && /class or safety approval remains separate/i.test(gunnerus.twinShip.readiness.statement),
  'complete declared evidence reaches the top software maturity without becoming class approval');
  ok(gunnerus.twinShip.replay.status === 'within-declared-thresholds'
    && gunnerus.twinShip.replay.samples === replaySamples.length,
  'aligned replay data returns measured residual evidence');
  ok(gunnerus.marine.metrics.massCorrectionApplied === false
    && /did not publish a production battery retrofit/i.test(gunnerus.marine.vessel.boundary),
  'Gunnerus deadweight is not substituted for vessel mass and its retrofit remains a scenario');
  ok(gunnerus.spec.resolved.sizing.policyId === 'marine-load-levelling',
    'Gunnerus resolves its vessel-specific load-levelling PMS instead of the ferry default');
  ok(gunnerus.marine.policyId === 'marine-load-levelling',
    'the marine result carries the same PMS for browser, desktop and report consumers');
  near(gunnerus.comparison.mission.scaleW, gunnerus.simulation.stats.peakW, 1e-9,
    'cell comparison uses the exact selected voyage/PMS power scale');
  near(gunnerus.comparison.mission.targetEnergyWh, gunnerus.pack.energyWh, 1e-9,
    'cell comparison sizes every candidate to the selected design energy');
  ok(gunnerus.comparison.mission.scaleW > 100000,
    'the Gunnerus study cannot fall back to the generic 4.88 kW ferry preset');
  ok(gunnerus.marine.inputs.replaySamples === undefined && gunnerus.marine.inputs.twinEvidence === undefined,
    'evidence payloads are not mistaken for voyage-physics inputs');
  const portable = JSON.stringify(gunnerus);
  for (const secret of [
    'private-api-asset-01', 'private-api-asset-record', 'private-api-model-artifact',
    'private-api-calibration-trial', 'private-api-validation-trial', 'private-api-replay-record',
  ]) {
    ok(!portable.includes(secret), `portable API output omits sensitive evidence identifier ${secret}`);
  }
  const bindings = gunnerus.twinShip.readiness.evidenceBindings;
  ok(bindings.asset.revision === 'private-api-revision-3' && bindings.asset.issuedAt,
    'portable evidence keeps the safe asset-record revision and timestamp without record or asset identity');
  ok(bindings.model.revision === '4.2.0' && bindings.calibration.issuedAt,
    'model version and calibration completion time use the uniform safe metadata projection');
  ok(bindings.validation.result === 'pass' && bindings.validation.issuedAt
    && bindings.replay.result === 'within-declared-thresholds' && bindings.replay.issuedAt,
  'validation and replay evidence retain only normalized result and issuance time metadata');
  ok(Object.values(gunnerus.twinShip.readiness.evidenceAccepted).every(Boolean),
    'machine output retains accepted evidence categories without the private references');
  ok(gunnerus.spec.marine.twinEvidence === undefined
    && gunnerus.spec.marine.replaySamples === undefined,
  'resolved API specs retain voyage inputs without copying raw evidence or replay samples');

  const noReplay = designFromSpec({
    application: 'marine',
    marine: {
      vesselId: 'ntnu-gunnerus',
      twinEvidence: {
        ...twinEvidence,
        replayResult: gunnerus.twinShip.replay,
      },
    },
  });
  ok(noReplay.twinShip.replay.status === 'unproven'
    && noReplay.twinShip.readiness.maturity !== 'digital-twin',
  'caller-supplied readiness replay claims cannot override the replay actually evaluated by the API');

  const road = designFromSpec({ application: 'ev', vesselId: 'ntnu-gunnerus' });
  ok(road.twinShip === null && road.spec.resolved.vesselId === null,
    'vessel inputs cannot smuggle marine twin claims into a road design');

  const unrelated = designFromSpec({
    application: 'ev',
    diagnostics: { assetId: 'battery-bench-rig', modelVersion: '2.3.0' },
  });
  ok(unrelated.spec.diagnostics.assetId === 'battery-bench-rig'
    && unrelated.spec.diagnostics.modelVersion === '2.3.0',
  'redaction is scoped to TwinShip evidence branches and does not erase identifiers owned by other modules');
});

test('one canonical marine policy trace owns energy, S/P and trace identity', () => {
  const spec = {
    application: 'marine',
    marine: { vesselId: 'ntnu-gunnerus', durationH: 1 },
    compareCellIds: ['catl-302ah-lfp'],
  };
  const resolved = resolveMarineSizing(spec);
  const design = designFromSpec(spec);
  const sizing = design.spec.resolved.sizing;
  const selectedCell = cellById(design.cell.id);
  const expectedP = Math.max(1, Math.ceil(resolved.requiredEnergyWh
    / (design.pack.s * selectedCell.nominalV * selectedCell.capacityAh)));

  ok(sizing.policyId === 'marine-load-levelling'
    && sizing.profileId === 'marine-load-levelling',
  'Gunnerus resolves one vessel-bound policy/profile pair');
  near(sizing.energyWindowWh, resolved.energyWindowWh, 1e-9,
    'the resolved cumulative policy-trace energy reaches the design contract');
  near(sizing.requiredEnergyWh, resolved.requiredEnergyWh, 1e-9,
    'usable-DoD reserve is applied before pack derivation');
  ok(design.pack.p === expectedP && sizing.autoSizedFromTrace === true,
    'parallel count is derived from the policy trace rather than the 24 kWh ferry preset');
  ok(design.pack.energyWh >= sizing.requiredEnergyWh && sizing.traceSizingStatus === 'met',
    'whole-cell rounding cannot undersize the governed minimum energy');
  ok(JSON.stringify(sizing.traceIdentity) === JSON.stringify(design.marine.traceIdentity)
    && JSON.stringify(sizing.traceIdentity) === JSON.stringify(design.simulation.profile.traceIdentity)
    && JSON.stringify(sizing.traceIdentity) === JSON.stringify(design.comparison?.mission?.traceIdentity),
  'marine result, simulation and comparison carry the same content-addressed trace identity');
  near(sizing.scaleW, resolved.scaleW, 1e-9,
    'the selected trace scale is serialized alongside its content identity');

  const seriesOnly = designFromSpec({ ...spec, s: 10 });
  const seriesExpectedP = Math.max(1, Math.ceil(resolved.requiredEnergyWh
    / (10 * selectedCell.nominalV * selectedCell.capacityAh)));
  ok(seriesOnly.pack.s === 10 && seriesOnly.pack.p === seriesExpectedP
    && seriesOnly.spec.resolved.sizing.autoSizedFromTrace === true,
  'an explicit series count does not disable voyage-energy sizing of parallel count');

  const parallelOverride = designFromSpec({ ...spec, p: 3 });
  ok(parallelOverride.pack.p === 3 && parallelOverride.spec.resolved.sizing.autoSizedFromTrace === false,
    'an explicit parallel count remains authoritative');
  const energyOverride = designFromSpec({ ...spec, energyWh: 50000 });
  ok(energyOverride.spec.resolved.sizing.autoSizedFromTrace === false
    && energyOverride.pack.energyWh < design.pack.energyWh,
  'an explicit energy target remains authoritative');

  const capped = designFromSpec({
    application: 'marine', marine: { vesselId: 'ntnu-gunnerus', durationH: 24 },
  });
  ok(capped.pack.p === 5000 && capped.spec.resolved.sizing.autoSizedFromTrace === false
    && capped.spec.resolved.sizing.traceSizingStatus === 'unmet-bounded-pack'
    && capped.findings.some((finding) => finding.id === 'MARINE_TRACE_ENERGY_UNMET' && finding.severity === 'fail')
    && capped.warnings.some((warning) => /automatic trace sizing is unmet/i.test(warning)),
  'a guard-rail-capped pack cannot claim that automatic mission sizing succeeded');
});

test('marine shore equipment is governed identically by the headless API contract', () => {
  const withoutEquipment = designFromSpec({
    application: 'marine', marine: { vesselId: 'ntnu-gunnerus', durationH: 1 },
  });
  ok(withoutEquipment.charging.shoreConnection.status === 'review'
    && withoutEquipment.charging.t2080 === null,
  'an undeclared marine source cannot produce a turnaround time');

  const shoreConnection = governedShoreConnection();
  const design = designFromSpec({
    application: 'marine', s: 200,
    marine: { vesselId: 'ntnu-gunnerus', durationH: 1, shoreConnection },
  });
  ok(design.charging.shoreConnection.status === 'pass' && design.charging.t2080?.hours > 0,
    'a complete governed contract reaches the shared charging calculation');
  ok(design.spec.marine.shoreConnection.evidence.revision === shoreConnection.evidence.revision
    && design.charging.shoreConnection.normalized.connector.id === shoreConnection.connector.id,
  'the portable spec and result preserve the controlled equipment/evidence identity');
});

test('governed custom marine traces survive the API and foreign policies are refused', () => {
  const profileTrace = {
    id: 'customer-harbor-cycle', name: 'Customer harbor cycle', revision: 'trial-7',
    dtS: 60, p: [0.5, 1, -0.25, 0.5], scaleW: 200000,
  };
  const custom = designFromSpec({
    application: 'marine', marine: { vesselId: 'ntnu-gunnerus' },
    profileId: profileTrace.id, profileTrace,
  });
  const sizing = custom.spec.resolved.sizing;
  ok(sizing.policyId === null && sizing.profileId === profileTrace.id,
    'a governed custom battery trace does not inherit a stale PMS policy');
  ok(custom.spec.profileTrace === undefined,
    'raw custom trace samples stay with the caller rather than entering every portable result');
  ok(sizing.traceIdentity.checksum.length === 64
    && sizing.traceIdentity.checksum === custom.simulation.profile.traceIdentity.checksum,
  'the custom trace is content-addressed consistently');
  const portableCustom = JSON.stringify(custom);
  ok(!portableCustom.includes('trial-7') && !portableCustom.includes('[0.5,1,-0.25,0.5]'),
    'portable output carries only the resolved trace identity, not raw samples or source revision');

  const changed = designFromSpec({
    application: 'marine', marine: { vesselId: 'ntnu-gunnerus' },
    profileId: profileTrace.id,
    profileTrace: { ...profileTrace, p: [0.5, -1, 0.25, 0.5] },
  });
  ok(changed.spec.resolved.sizing.traceIdentity.checksum !== sizing.traceIdentity.checksum,
    'changing trace content changes its identity even when the display id is unchanged');

  const foreign = designFromSpec({
    application: 'marine', marine: { vesselId: 'ntnu-gunnerus' },
    profileId: 'grid-peak-shaving',
  });
  ok(foreign.spec.resolved.sizing.policyId === 'marine-load-levelling'
    && foreign.warnings.some((warning) => /belongs to solar-ess.*refused/i.test(warning)),
  'a foreign policy-output profile is refused and cannot execute as a marine trace');

  const badPolicyWithCustom = designFromSpec({
    application: 'marine', marine: { vesselId: 'ntnu-gunnerus' },
    policyId: 'grid-peak-shaving', profileTrace,
  });
  ok(badPolicyWithCustom.spec.resolved.sizing.profileId === profileTrace.id
    && badPolicyWithCustom.spec.resolved.sizing.policyId === null
    && badPolicyWithCustom.warnings.some((warning) => /using profile "customer-harbor-cycle" without that policy/i.test(warning)),
  'an invalid policy is refused without contradicting the custom-trace precedence actually used');
});

test('bus sizing includes passenger load and a client-supplied route', () => {
  const points = [
    { lat: 50.8503, lon: 4.3517, eleM: 20, tS: 0 },
    { lat: 50.8550, lon: 4.3600, eleM: 28, tS: 90 },
    { lat: 50.8600, lon: 4.3700, eleM: 36, tS: 180 },
  ];
  const empty = designFromSpec({
    application: 'ebus', profileId: 'vehicle', vehicle: { payloadKg: 0 },
    route: { name: 'Operator route', points },
  });
  const full = designFromSpec({
    application: 'ebus', profileId: 'vehicle', vehicle: { payloadKg: 6000 },
    route: { name: 'Operator route', points },
  });
  ok(empty.vehicle.route?.name === 'Operator route', 'the selected route reaches the vehicle result');
  ok(empty.vehicle.trace.id === 'route' && empty.simulation.profile.id === 'vehicle',
    'route is converted through the existing vehicle-to-battery profile seam');
  ok(full.vehicle.drive.whPerKm > empty.vehicle.drive.whPerKm,
    'a full passenger load increases the sizing demand');
  const bus = listApplications().find((a) => a.id === 'ebus');
  ok(bus.sizing.inputs.includes('route') && bus.sizing.inputs.includes('payload'),
    'software clients are told that route and passenger load are sizing inputs');
});

test('the MCP server speaks the protocol and returns real answers', () => {
  const init = handleMessage({ id: 1, method: 'initialize', params: {} });
  ok(init.protocolVersion && init.serverInfo.name === 'battery-design', 'initialize handshake');
  ok(/not from a language model/.test(init.instructions),
    'the assistant is told where the numbers come from');
  const tools = handleMessage({ id: 2, method: 'tools/list' }).tools;
  // Named rather than counted: a count breaks every time a tool is added,
  // which teaches people to bump the number instead of checking the list.
  // What matters is that every tool an agent relies on is still there.
  const names = tools.map((t) => t.name);
  for (const n of ['list_applications', 'list_cells', 'list_vessels', 'get_ontology_schema', 'query_ontology', 'design_pack', 'run_mission',
    'compare_cells', 'explain_v2x', 'explain_concept', 'review_design']) {
    ok(names.includes(n), `${n} is exposed`);
  }
  ok(new Set(names).size === names.length, 'no tool is declared twice');
  for (const t of tools) {
    ok(t.name && t.description.length > 60 && t.inputSchema.type === 'object',
      `${t.name}: named, described and schema'd`);
  }
  const designSchema = tools.find((tool) => tool.name === 'design_pack').inputSchema.properties;
  ok(designSchema.vesselId && designSchema.marine && designSchema.twinShip
    && designSchema.batteryCategory && designSchema.evaluationDate,
  'desktop agents can discover vessel, voyage, evidence and governed EU assessment inputs from the schema');
  ok(designSchema.marine.additionalProperties === false
    && designSchema.marine.properties.twinEvidence.properties.assetEvidence
    && designSchema.marine.properties.replaySamples.items.properties.actualPowerW
    && designSchema.marine.properties.shoreConnection.required.includes('evidence')
    && designSchema.marine.properties.shoreConnection.properties.connector.required.includes('id'),
  'the MCP contract describes structured evidence and aligned replay fields instead of accepting an opaque object');
  ok(designSchema.profileTrace?.required?.includes('scaleW')
    && designSchema.profileTrace.properties.p.maxItems === 500,
  'desktop agents can discover the bounded governed custom-trace contract');
  const call = (name, args) => handleMessage({ id: 3, method: 'tools/call', params: { name, arguments: args } });
  const vessels = call('list_vessels', {});
  ok(/ntnu-milliampere1/.test(vessels.content[0].text) && /ntnu-gunnerus/.test(vessels.content[0].text),
    'list_vessels exposes both selected boat models');
  ok(/marine-full-electric/.test(vessels.content[0].text)
    && /marine-load-levelling/.test(vessels.content[0].text),
  'list_vessels exposes the default PMS policy for each model');
  const ontologySchema = call('get_ontology_schema', {});
  const ontologyCatalog = JSON.parse(ontologySchema.content[0].text);
  ok(ontologyCatalog.ontology?.version && ontologyCatalog.classes?.length
    && ontologyCatalog.relations?.length && ontologyCatalog.productSurfaces?.length
    && ontologyCatalog.architectureModules?.length === 22,
  'get_ontology_schema returns the versioned architecture catalog without generating a design');
  const ontology = call('query_ontology', { type: 'bd:DomainModule' });
  const ontologyText = ontology.content[0].text;
  const architectureModules = describeOntology().architectureModules;
  ok(architectureModules.length === 22 && /query matched 22 entities/.test(ontologyText)
    && architectureModules.every((module) => ontologyText.includes(module.label)),
  'query_ontology exposes all 22 architecture modules, with charging as one peer domain');
  const design = call('design_pack', { application: 'ev', energyWh: 60000 });
  ok(!design.isError && /kWh/.test(design.content[0].text), 'design_pack answers');
  const euDesign = call('design_pack', {
    application: 'solar-ess', energyWh: 10000,
    batteryCategory: 'industrial', evaluationDate: '2027-02-18',
  });
  ok(/EU assessment: category industrial · 2027-02-18 · Battery passport applies/i.test(euDesign.content[0].text),
    'MCP returns the same governed EU passport decision instead of merely accepting hidden inputs');
  const mission = call('run_mission', { application: 'ebus', energyWh: 250000, passes: 2 });
  ok(/SoC/.test(mission.content[0].text) && /Assumptions/.test(mission.content[0].text),
    'run_mission answers and states its assumptions');
  const marine = call('design_pack', {
    application: 'marine', vesselId: 'ntnu-gunnerus',
    marine: { vesselId: 'ntnu-gunnerus', serviceSpeedKn: 8, durationH: 2 },
  });
  ok(/NTNU R\/V Gunnerus/.test(marine.content[0].text) && /TwinShip evidence/.test(marine.content[0].text),
    'desktop design output identifies the selected vessel and its readiness boundary');
  ok(/PMS marine-load-levelling/.test(marine.content[0].text),
    'desktop design output reports the same vessel-specific PMS as the browser model');
  const shoreMarine = call('design_pack', {
    application: 'marine', s: 200,
    marine: { vesselId: 'ntnu-gunnerus', shoreConnection: governedShoreConnection() },
  });
  ok(!shoreMarine.isError && /20→80%/.test(shoreMarine.content[0].text),
    'MCP passes the declared shore contract through the same turnaround calculation');
  const privateMarker = 'PRIVATE-MCP-ASSET-DO-NOT-ECHO';
  const privateMarine = call('design_pack', {
    application: 'marine',
    marine: {
      vesselId: 'ntnu-gunnerus',
      twinEvidence: {
        powerBasis: 'dc-bus-trace',
        assetEvidence: {
          assetId: privateMarker, vesselId: 'ntnu-gunnerus',
          evidenceId: 'PRIVATE-MCP-EVIDENCE-DO-NOT-ECHO', revision: 'rev-private',
          issuedAt: new Date(Date.now() - 86400000).toISOString(), sha256: 'a'.repeat(64),
        },
      },
    },
  });
  ok(!privateMarine.content[0].text.includes(privateMarker)
    && !/PRIVATE-MCP-EVIDENCE-DO-NOT-ECHO|rev-private/.test(privateMarine.content[0].text),
  'MCP can evaluate governed evidence without echoing private asset or record identity');
  const marineMission = call('run_mission', {
    application: 'marine', vesselId: 'ntnu-gunnerus', passes: 1,
  });
  ok(/Vessel: NTNU R\/V Gunnerus; PMS marine-load-levelling/.test(marineMission.content[0].text)
    && /kW battery-profile peak/.test(marineMission.content[0].text),
  'MCP mission output identifies its vessel, PMS and computed mission scale');
  const customMarineMission = call('run_mission', {
    application: 'marine', vesselId: 'ntnu-gunnerus', profileId: 'mcp-harbor-cycle',
    profileTrace: {
      id: 'mcp-harbor-cycle', name: 'MCP harbor cycle', revision: 'rev-2',
      dtS: 30, p: [0.25, 1, -0.5, 0.25], scaleW: 180000,
    },
    passes: 1,
  });
  ok(!customMarineMission.isError && /MCP harbor cycle/.test(customMarineMission.content[0].text),
    'MCP executes the governed custom trace rather than resolving it through a static profile registry');
  const cmp = call('compare_cells', { application: 'ebike', chemistry: 'LFP' });
  ok(/kWh delivered/.test(cmp.content[0].text), 'compare_cells ranks by delivered cost');
  const v2x = call('explain_v2x', { application: 'ev', energyWh: 60000, v2xPolicy: 'v2g' });
  ok(/Revenue-grade metering/.test(v2x.content[0].text) && /Wear floor/.test(v2x.content[0].text),
    'explain_v2x names the parts and the wear floor');
  const notApplicable = call('explain_v2x', { application: 'wearable' });
  ok(/Not applicable/.test(notApplicable.content[0].text), 'and says no when the answer is no');
  const concept = call('explain_concept', { concept: 'hv-chain', application: 'wearable' });
  ok(/does NOT need/.test(concept.content[0].text),
    'explain_concept defends the empty space as a decision, not an omission');
});

test('the MCP server fails safely', () => {
  // An isolation standard the module refuses to guess at genuinely throws —
  // unlike a nonsense S/P count, which is clamped WITH a warning.
  const bad = handleMessage({ id: 4, method: 'tools/call', params: { name: 'design_pack', arguments: { application: 'ev', isolationStandard: 'no-such-standard' } } });
  ok(bad.isError === true && /could not be completed/.test(bad.content[0].text),
    'a failed design is reported as tool output the agent can read, not a silent crash');
  const clamped = handleMessage({ id: 5, method: 'tools/call', params: { name: 'design_pack', arguments: { application: 'ev', s: -5 } } });
  ok(!clamped.isError, 'a correctable input still produces a design');
  let threw = false;
  try { handleMessage({ id: 5, method: 'tools/call', params: { name: 'no-such-tool' } }); } catch (e) { threw = e.code === -32601; }
  ok(threw, 'an unknown tool is a protocol error with the right code');
  let threw2 = false;
  try { handleMessage({ id: 6, method: 'no/such/method' }); } catch (e) { threw2 = e.code === -32601; }
  ok(threw2, 'an unknown method likewise');
  ok(handleMessage({ id: 7, method: 'ping' }) != null, 'ping is answered');
});

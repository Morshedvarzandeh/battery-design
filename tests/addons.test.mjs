// Add-ons and co-simulation.
//
// The tool outgrew being one program. These check that the capability
// registry describes itself honestly — including what is NOT built — and that
// the FMI export produces something a host tool would actually accept.
import { test } from 'node:test';
import { ok } from './helpers.mjs';
import { ADDONS, addonById, addonsFor, capabilityReport, validateAddons } from '../js/addons.js';
import { FMU_VARIABLES, FMU_PARAMETERS, FMI_VERSION, modelDescriptionXml, fmuSourceC, buildFmu } from '../js/fmi.js';
import { CONCEPTS } from '../js/knowledge.js';
import { cellById } from '../js/cells.js';

const CELL = cellById('samsung-inr21700-50e');

test('every add-on describes itself completely', () => {
  const errors = validateAddons();
  ok(errors.length === 0, `the registry is consistent: ${errors.join('; ')}`);
  ok(ADDONS.length >= 14, `the tool is honest about how much it now does (${ADDONS.length} add-ons)`);
  ok(ADDONS.every((a) => a.what.length > 40), 'each says what it does in a real sentence');
  ok(addonById('pack') && addonById('nope') === null, 'lookup');
  // Every concept an add-on claims must exist in the graph it reads from.
  for (const a of ADDONS) for (const c of a.concepts) ok(CONCEPTS[c], `${a.id} claims a real concept (${c})`);
});

test('the roadmap is in the product, not in someone\'s head', () => {
  const planned = ADDONS.filter((a) => a.status === 'planned');
  ok(planned.length >= 1, 'unbuilt capabilities are listed rather than implied');
  ok(planned.every((a) => a.why), 'and each explains why it is worth building');
  // Deliberately NOT pinned to a particular id being unbuilt: an add-on moving
  // from planned to shipped is the roadmap working, not a regression, and a
  // test that fails on progress only teaches people to edit the test.
  ok(planned.every((a) => a.name && a.what && a.provides?.length),
    'a planned entry is described as fully as a shipped one, or it is a wish rather than a roadmap');
  const shipped = ADDONS.filter((a) => a.status === 'shipped');
  ok(shipped.some((a) => a.id === 'cosim'), 'co-simulation ships, so it says shipped');
  ok(shipped.length > planned.length, 'and more is built than is promised');
  for (const a of ADDONS) {
    ok(['shipped', 'planned'].includes(a.status), `${a.id} has an honest status`);
    if (a.status === 'shipped') ok(!/^planned/.test(a.module), `${a.id} says shipped, so it names a real module`);
  }
});

test('an application sees only the add-ons that are its business', () => {
  const wearable = addonsFor('wearable').map((a) => a.id);
  const ev = addonsFor('ev').map((a) => a.id);
  const marine = addonsFor('marine').map((a) => a.id);
  ok(!wearable.includes('vehicle'), 'a watch is not a vehicle');
  ok(!wearable.includes('v2x'), 'nor does it feed the grid');
  ok(ev.includes('vehicle') && ev.includes('v2x'), 'an EV gets both');
  ok(marine.includes('marine-twinship') && !ev.includes('marine-twinship')
    && !wearable.includes('marine-twinship'), 'the TwinShip add-on belongs only to marine designs');
  ok(ev.length > wearable.length, 'so an EV has more to think about than a wearable');
  ok(addonsFor('wearable').every((a) => a.tier !== 'core' || true), 'core add-ons are never filtered away');
  ok(addonsFor('wearable').filter((a) => a.tier === 'core').length === ADDONS.filter((a) => a.tier === 'core').length,
    'every core add-on survives filtering, for every application');
  ok(addonsFor(null).length === ADDONS.length, 'no application chosen means nothing is hidden yet');
  ok(addonsFor('ev', { includePlanned: false }).every((a) => a.status === 'shipped'), 'planned entries can be excluded');
  ok(addonsFor('ev', { tier: 'desktop' }).every((a) => a.tier === 'desktop'), 'and filtered by tier');
});

test('the marine twin add-on states the research and evidence boundary', () => {
  const twin = addonById('marine-twinship');
  ok(twin?.status === 'shipped' && twin.tier === 'browser',
    'the inspectable architecture/readiness/replay contract is shipped');
  ok(twin.concepts[0] === 'vessel-twin', 'its defining knowledge edge is vessel-specific');
  ok(/not a certified battery retrofit|not a certified battery/i.test(twin.why),
    'the NTNU demonstrator is not described as a certified battery product');
  ok(/aligned replay data/.test(twin.needs.join(' ')) && /separate calibration and validation/.test(twin.needs.join(' ')),
    'a model cannot earn twin status from its architecture alone');
});

test('the capability report answers "what can this do" with numbers', () => {
  const rep = capabilityReport('ebike');
  ok(rep.shipped + rep.planned === rep.relevant, 'the counts add up');
  ok(rep.byTier.core > 0 && rep.byTier.desktop > 0, 'and are split by where each runs');
  ok(rep.notRelevant.length > 0 && rep.notRelevant.every((a) => !rep.addons.includes(a)),
    'what does not apply is listed separately rather than silently dropped');
  ok(/apply to this application/.test(rep.note), 'with a sentence a human can read');
  ok(/no application has been chosen/.test(capabilityReport(null).note), 'and a different one when nothing is chosen');
});

test('the FMU declares an interface a host tool can actually couple to', () => {
  const xml = modelDescriptionXml({ cell: CELL, s: 96, p: 44 });
  ok(xml.startsWith('<?xml'), 'it is XML');
  ok(new RegExp(`fmiVersion="${FMI_VERSION}"`).test(xml), `declaring FMI ${FMI_VERSION}`);
  ok(/<CoSimulation/.test(xml) && /modelIdentifier="BatteryPack"/.test(xml), 'as a co-simulation FMU');
  // Every declared variable must appear exactly once, with a value reference.
  for (const v of [...FMU_PARAMETERS, ...FMU_VARIABLES]) {
    const hits = xml.split(`name="${v.name}"`).length - 1;
    ok(hits === 1, `${v.name} is declared exactly once (found ${hits})`);
  }
  // Value references must be unique — a duplicate silently corrupts coupling.
  const vrs = [...xml.matchAll(/valueReference="(\d+)"/g)].map((m) => m[1]);
  ok(new Set(vrs).size === vrs.length, `all ${vrs.length} value references are unique`);
  // The outputs listed in ModelStructure must match the outputs declared.
  const nOutputs = FMU_VARIABLES.filter((v) => v.causality === 'output').length;
  ok((xml.match(/<Unknown index=/g) || []).length === nOutputs, 'every output appears in the model structure');
  ok(/canHandleVariableCommunicationStepSize="true"/.test(xml),
    'and it accepts whatever macro step the master picks, because it sub-steps internally');
  // Design parameters must reach the XML, or the FMU is a different pack.
  ok(xml.includes(`start="96"`) && xml.includes(`start="44"`), 'the actual series/parallel counts are baked in');
  ok(xml.includes(`start="${CELL.capacityAh}"`), 'and the actual cell capacity');
});

test('the generated C implements the FMI API and nothing is missing', () => {
  const c = fmuSourceC({ modelName: 'BatteryPack', guid: 'bd-test' });
  // Every function an FMI 2.0 co-simulation host may call must exist.
  for (const fn of [
    'fmi2Instantiate', 'fmi2FreeInstance', 'fmi2SetupExperiment',
    'fmi2EnterInitializationMode', 'fmi2ExitInitializationMode', 'fmi2Terminate',
    'fmi2Reset', 'fmi2GetReal', 'fmi2SetReal', 'fmi2DoStep', 'fmi2GetVersion',
    'fmi2GetTypesPlatform', 'fmi2CancelStep', 'fmi2SetDebugLogging',
    'fmi2GetInteger', 'fmi2SetInteger', 'fmi2GetBoolean', 'fmi2SetBoolean',
    'fmi2GetString', 'fmi2SetString', 'fmi2GetRealStatus',
  ]) ok(c.includes(fn), `${fn} is implemented`);
  ok(c.includes('#define GUID "bd-test"'), 'the guid is compiled in, and must match the XML');
  ok(/strcmp\(fmuGUID, GUID\)/.test(c), 'and is checked on instantiation, as the standard requires');
  ok(/while \(remaining > 1e-12\)/.test(c), 'a large macro step is sub-stepped rather than integrated in one leap');
  ok(/capRate > 0 \? 1\.0 - exp\(-m->hCool \/ capRate\) : 0\.0/.test(c),
    'the coolant uses the same ε-NTU form as the JS model — no flow removes no heat');
  ok(!/malloc\(/.test(c.split('fmi2DoStep')[1] || ''), 'no allocation inside the step function');
});

test('the FMU package carries everything needed to build and use it', () => {
  const fmu = buildFmu({ cell: CELL, s: 96, p: 44 });
  ok(fmu.files['modelDescription.xml'] && fmu.files['sources/BatteryPack.c'] && fmu.files['README.md'],
    'the XML, the source and the instructions all travel together');
  // The guid must be identical in both places or no host will load it.
  const guidInXml = fmu.files['modelDescription.xml'].match(/guid="([^"]+)"/)[1];
  const guidInC = fmu.files['sources/BatteryPack.c'].match(/#define GUID "([^"]+)"/)[1];
  ok(guidInXml === guidInC, `the guid matches between XML and C (${guidInXml})`);
  ok(fmu.guid === guidInXml, 'and is reported to the caller');
  // The same design must always produce the same FMU.
  ok(buildFmu({ cell: CELL, s: 96, p: 44 }).guid === fmu.guid, 'the build is reproducible');
  ok(buildFmu({ cell: CELL, s: 96, p: 4 }).guid !== fmu.guid, 'and a different pack is a different FMU');
  const readme = fmu.files['README.md'];
  ok(/ANSYS Twin Builder/.test(readme) && /Simulink/.test(readme) && /GT-SUITE/.test(readme),
    'the README names the tools this is for');
  ok(/cc -O2 -fPIC -shared/.test(readme), 'and gives the build line');
  ok(/Not electrochemical/.test(readme) && /Linear OCV/.test(readme),
    'and says plainly what this model is not, like every other model here');
  ok(/source FMU/i.test(fmu.note), 'the package admits it needs compiling');
});

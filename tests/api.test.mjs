// API — the designer without a browser, and the MCP surface an AI drives it
// through. The point of these tests is that the headless engine is the SAME
// designer: same modules, same numbers, no second implementation to drift.
import { test } from 'node:test';
import { ok, near } from './helpers.mjs';
import {
  designFromSpec, briefFromDesign, listApplications, listCells, SPEC_FIELDS, API_VERSION,
} from '../js/api.js';
import { handleMessage } from '../desktop/mcp-server.mjs';
import { PRESETS } from '../js/presets.js';
import { CELLS, cellById } from '../js/cells.js';
import { summarize, layoutPack, defaultArrangement } from '../js/pack-engine.js';
import { costModel } from '../js/optimizer.js';

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
  ok(d.warnings.length === 0, 'a valid spec produces no warnings');
});

test('the headless engine agrees with the modules the UI uses', () => {
  const d = designFromSpec({ application: 'ebike', cell: 'samsung-inr21700-50e', s: 13, p: 4 });
  const c = cellById('samsung-inr21700-50e');
  const direct = summarize(c, 13, 4, layoutPack(c, 13, 4, {
    arrangement: defaultArrangement(c), spacingMm: 1, wallMm: 2, headroomMm: 8,
  }));
  near(d.pack.energyWh, direct.energyWh, 1e-9, 'same energy as calling the pack engine directly');
  near(d.pack.massKg, direct.massKg, 1e-9, 'same mass');
  near(d.pack.nominalV, direct.nominalV, 1e-9, 'same voltage');
  const cost = costModel(c, direct.cellCount, direct.energyWh, { dod: 0.8, cyclesPerYear: d.spec.resolved ? null : null });
  near(d.cost.upfrontUSD, cost.upfrontUSD, 1e-9, 'and the same cost model, not a re-derivation');
});

test('the result is plain data — it survives JSON without loss', () => {
  const d = designFromSpec({ application: 'ev', energyWh: 60000, profileId: 'vehicle', v2xPolicy: 'v2g' });
  const round = JSON.parse(JSON.stringify(d));
  near(round.pack.energyWh, d.pack.energyWh, 1e-9, 'energy survives');
  near(round.vehicle.drive.whPerKm, d.vehicle.drive.whPerKm, 1e-9, 'consumption survives');
  ok(round.v2x.parts.length === d.v2x.parts.length, 'the V2X parts list survives');
  ok(JSON.stringify(d).length < 400_000, 'and it stays a sane size — the raw traces are not shipped');
  ok(d.vehicle.drive.w === undefined, 'the second-by-second watt trace is deliberately left out of the summary');
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
  ok(listCells().length === CELLS.length, 'every cell is listed');
  ok(listCells({ chemistry: 'LFP' }).every((c) => c.chemistry === 'LFP'), 'chemistry filter works');
  ok(listCells().every((c) => c.dataQuality), 'and every record carries its data quality');
  ok(Object.keys(SPEC_FIELDS).length >= 10, 'the spec documents itself');
});

test('the MCP server speaks the protocol and returns real answers', () => {
  const init = handleMessage({ id: 1, method: 'initialize', params: {} });
  ok(init.protocolVersion && init.serverInfo.name === 'battery-design', 'initialize handshake');
  ok(/not from a language model/.test(init.instructions),
    'the assistant is told where the numbers come from');
  const tools = handleMessage({ id: 2, method: 'tools/list' }).tools;
  ok(tools.length === 7, `seven tools exposed (${tools.length})`);
  for (const t of tools) {
    ok(t.name && t.description.length > 60 && t.inputSchema.type === 'object',
      `${t.name}: named, described and schema'd`);
  }
  const call = (name, args) => handleMessage({ id: 3, method: 'tools/call', params: { name, arguments: args } });
  const design = call('design_pack', { application: 'ev', energyWh: 60000 });
  ok(!design.isError && /kWh/.test(design.content[0].text), 'design_pack answers');
  const mission = call('run_mission', { application: 'ebus', energyWh: 250000, passes: 2 });
  ok(/SoC/.test(mission.content[0].text) && /Assumptions/.test(mission.content[0].text),
    'run_mission answers and states its assumptions');
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
  const bad = handleMessage({ id: 4, method: 'tools/call', params: { name: 'design_pack', arguments: { application: 'ev', s: -5 } } });
  ok(bad.isError === true && /could not be completed/.test(bad.content[0].text),
    'a failed design is reported as tool output the agent can read, not a silent crash');
  let threw = false;
  try { handleMessage({ id: 5, method: 'tools/call', params: { name: 'no-such-tool' } }); } catch (e) { threw = e.code === -32601; }
  ok(threw, 'an unknown tool is a protocol error with the right code');
  let threw2 = false;
  try { handleMessage({ id: 6, method: 'no/such/method' }); } catch (e) { threw2 = e.code === -32601; }
  ok(threw2, 'an unknown method likewise');
  ok(handleMessage({ id: 7, method: 'ping' }) != null, 'ping is answered');
});

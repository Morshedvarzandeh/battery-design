// Knowledge — the who-needs-what layer and the deliverables that hang off
// it: the graph that decides which concepts each application meets (a
// wearable customer NEVER sees rack stacks in training), the component
// classes, the layered architecture HTML report, and the engineer's
// workbook with live formulas and no hardcoded contact address in source.
import { test } from 'node:test';
import { readFileSync } from 'fs';
import { ok } from './helpers.mjs';
import { cellById } from '../js/cells.js';
import { layoutPack, summarize } from '../js/pack-engine.js';
import {
  CONCEPTS, NEEDS, needed, appNeeds, stepsFor, validateGraph,
} from '../js/knowledge.js';
import { TRAINING_TRACKS } from '../js/training.js';
import { COMPONENT_CATEGORIES, COMPONENT_CLASSES } from '../js/components.js';
import {
  buildArchitecture, assessBmsTopology, assessEmsArchitecture,
} from '../js/architecture.js';
import { buildThermalSystem } from '../js/btms.js';
import { buildSensorPlan } from '../js/sensors.js';
import { co2Model, buildArchReportHTML } from '../js/report.js';
import { costModel } from '../js/optimizer.js';
import { buildWorkbookXml, workbookFilename } from '../js/excel.js';

test('the graph itself validates', () => {
  const errs = validateGraph();
  ok(errs.length === 0, `graph validates (${errs.join(' | ')})`);
  ok(Object.keys(CONCEPTS).length >= 14, 'concept nodes present');
  ok(Object.keys(NEEDS).length === Object.keys(CONCEPTS).length, 'every concept has an edge');
});

test('who needs what: the wearable is the acid test', () => {
  ok(!needed('wearable', 'stacks-racks'), 'wearable does NOT need stacks/racks');
  ok(!needed('wearable', 'ems-arch'), 'wearable does NOT need EMS architecture');
  ok(!needed('wearable', 'btms-loop'), 'wearable does NOT need a thermal loop');
  ok(!needed('wearable', 'module-tier'), 'wearable does NOT need the module tier');
  ok(needed('wearable', 'seasons') && needed('wearable', 'report'), 'wearable keeps universals');
  ok(needed('solar-ess', 'stacks-racks') && needed('solar-ess', 'ems-arch'),
    'storage plant needs stacks and EMS');
  ok(needed('robot', 'stacks-racks'), 'fleet (robot) reaches stacks via the app override');
  ok(!needed('ebike', 'ems-arch'), 'e-bike has no EMS');
  ok(needed(null, 'stacks-racks'), 'no application chosen -> nothing hidden yet');
  ok(!appNeeds('wearable').includes('stacks-racks'), 'appNeeds traces the same answer');
});

test('training steps filter through the graph', () => {
  for (const track of Object.values(TRAINING_TRACKS)) {
    for (const st of track.steps) {
      if (st.concept) ok(CONCEPTS[st.concept], `step "${st.title}" tags a known concept (${st.concept})`);
    }
  }
  const advAll = TRAINING_TRACKS.advanced.steps.length;
  const wAdv = stepsFor(TRAINING_TRACKS.advanced, 'wearable');
  ok(wAdv.length < advAll, `wearable advanced track is SHORTER (${wAdv.length} < ${advAll})`);
  ok(!wAdv.some((st) => ['stacks-racks', 'ems-arch', 'btms-loop'].includes(st.concept)),
    'wearable never meets stacks/EMS/thermal-loop steps');
  wAdv.forEach((st, i) => ok(st.index === i + 1 && st.of === wAdv.length,
    `wearable numbering stays consecutive (${st.index}/${st.of})`));
  ok(stepsFor(TRAINING_TRACKS.advanced, 'solar-ess').length === advAll,
    'storage plant keeps the full advanced track');
  ok(stepsFor(TRAINING_TRACKS.simple, 'wearable').length === TRAINING_TRACKS.simple.steps.length,
    'the simple track is universal');
});

test('component classes: complete and mapped', () => {
  const ids = new Set(COMPONENT_CLASSES.map((k) => k.id));
  for (const want of ['thermal', 'electrical', 'control', 'safety', 'mechanical']) {
    ok(ids.has(want), `component class ${want} exists`);
  }
  for (const { key, cls } of COMPONENT_CATEGORIES) {
    ok(ids.has(cls), `category ${key} maps to a real class (${cls})`);
  }
  const thermal = COMPONENT_CLASSES.find((k) => k.id === 'thermal');
  ok(thermal.concept === 'btms-loop', 'thermal class gates on the btms-loop edge');
});

// A real EV design end to end — the fixture the report and workbook build on.
const c = cellById('samsung-inr21700-50e');
const layout = layoutPack(c, 96, 2, { spacingMm: 1 });
const summary = summarize(c, 96, 2, layout);
const A = buildArchitecture({
  cell: c, s: 96, p: 2, summary,
  options: { appId: 'ev', isolationStandard: 'ece-r100' },
});
const T = buildThermalSystem({ heatContW: 1500, ambientC: [-5, 35], cell: c, appId: 'ev' });
const sensors = buildSensorPlan({
  cell: c, s: 96, p: 2, summary, partition: A.partition, bms: A.bms, therm: T, selection: {},
});
const usage = { cyclesPerYear: 250, targetYears: 8, dod: 0.8 };
const R = {
  date: '2026-08-02', application: 'ev', cell: c, summary,
  cost: costModel(c, summary.cellCount, summary.energyWh, usage),
  co2: co2Model({ cell: c, energyWh: summary.energyWh, cyclesPerYear: 250, targetYears: 8, gridGPerKWh: 440, dod: 0.8 }),
  usage,
  architecture: A,
  archAssess: {
    topo: assessBmsTopology({ topology: A.bms.topology, s: 96, afeTotal: A.bms.afeTotal, nModules: A.partition.nModules }),
    ems: A.emsArch ? assessEmsArchitecture(A.emsArch) : null,
  },
  archPng: null, bmsPng: null, thermPng: null,
  thermal: T, sensors,
  disclaimer: 'test disclaimer',
};

test('the layered architecture report', () => {
  const html = buildArchReportHTML(R);
  ok(html.startsWith('<!doctype html>'), 'standalone document');
  for (const id of ['L-system', 'L-pack', 'L-module', 'L-cell', 'L-control', 'L-thermal', 'L-sensors']) {
    ok(html.includes(`id="${id}"`), `layer ${id} present`);
  }
  ok(/nav>/.test(html) && html.includes('open all'), 'layer selector nav present');
  ok(html.includes('<details'), 'layers are selectable (details/summary)');
  ok(!/undefined|NaN/.test(html), 'no undefined/NaN leaks');
  ok(!/src="http/.test(html), 'self-contained — no remote assets');
  ok(html.includes(A.bms.topologyInfo.name), 'BMS topology named');
  ok(html.includes(T.loop.name), 'thermal loop named');
  ok(html.includes('Precharge'), 'HV chain layer carries precharge');
  ok(html.includes('Sensor plan') && html.includes('Cell level'), 'sensor layers carried');
  // A wearable-class report (no HV chain, no thermal system) still builds.
  const wHtml = buildArchReportHTML({ ...R, thermal: null, sensors: { groups: [], notes: [] } });
  ok(wHtml.startsWith('<!doctype html>') && !wHtml.includes('L-thermal'),
    'no thermal layer when there is no thermal system');
});

test('the engineer\'s workbook: live formulas, feedback loop, well-formed XML', () => {
  const xml = buildWorkbookXml(R, { feedbackEmail: 'owner@example.com' });
  ok(xml.includes('<?mso-application progid="Excel.Sheet"?>'), 'Excel XML preamble');
  const namedRanges = (xml.match(/<NamedRange /g) || []).length;
  ok(namedRanges >= 15, `named input cells defined (${namedRanges})`);
  // The chains engineers will check, as LIVE formulas:
  ok(xml.includes('=SCount*PCount*VNom*CapAh'), 'energy formula is live');
  ok(xml.includes('CEILING(CyclesYr*Years/CycleLife,1)'), 'replacement-pack formula is live');
  ok(xml.includes('=(CellPrice*SCount*PCount)/(CycleLife*(SCount*PCount*VNom*CapAh)*DoD/1000)'),
    'cost-per-kWh-delivered formula is live');
  ok(xml.includes('=(HeatW/1000)/(CpKJ*RhoKgL*DTK)*60'), 'coolant flow formula is live');
  ok(xml.includes('Your value'), 'the reader gets a column to disagree in');
  ok(xml.includes('mailto:owner@example.com'), 'feedback address embedded at runtime');
  ok(xml.includes('github.com/Morshedvarzandeh/battery-design/issues'), 'issues link present');
  // Well-formedness: every opened tag closes (self-closing tags excluded).
  const tags = {};
  for (const m of xml.matchAll(/<(\/?)([A-Za-z][\w:]*)((?:"[^"]*"|[^">])*?)(\/?)>/g)) {
    const [, close, name, , self] = m;
    if (self === '/' || name.startsWith('?')) continue;
    tags[name] = (tags[name] || 0) + (close ? -1 : 1);
  }
  for (const [name, bal] of Object.entries(tags)) ok(bal === 0, `XML balanced for <${name}> (${bal})`);
  // Paired sanity: sheets present.
  for (const sh of ['Inputs', 'Pack', 'Economics', 'CO2', 'Thermal', 'Feedback']) {
    ok(xml.includes(`ss:Name="${sh}"`), `sheet ${sh} present`);
  }
  // No feedback email -> no mailto at all.
  ok(!buildWorkbookXml(R).includes('mailto:'), 'no address unless provided at runtime');
  // A wearable-class design (no liquid loop) drops the Thermal sheet.
  const w = buildWorkbookXml({ ...R, thermal: null });
  ok(!w.includes('ss:Name="Thermal"'), 'no Thermal sheet without a thermal system');
  ok(workbookFilename(R).endsWith('.xls'), 'workbook filename');
});

test('privacy: no hardcoded contact address in excel.js source', () => {
  // The address is assembled at runtime (mycells.js pattern) and passed in.
  // (The public app/repo URLs are fine — it is the email that stays out.)
  const src = readFileSync(new URL('../js/excel.js', import.meta.url), 'utf8');
  ok(!/gmail|morshed\.varzandeh|mailto:[^$]/i.test(src.replace(/mailto:\$\{/g, '')),
    'no hardcoded contact address in excel.js source');
});

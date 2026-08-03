// The briefing layer — fifteen modules, one voice.
//
// Every module grew its own shape for an answer, and that is fine until
// something wants to read all of them. These tests hold the translation:
// nothing upstream changed, everything downstream sees one shape, and the
// two things the layer adds — an order that puts safety first, and an honest
// list of what the tool is guessing — actually work.
import { test } from 'node:test';
import { ok } from './helpers.mjs';
import { designBrief, openQuestions, CATEGORY_WEIGHT } from '../js/brief.js';
import { buildTopology } from '../js/topology.js';
import { wiringStudy } from '../js/wiring.js';
import { groundingStudy, faultFromShortCircuit } from '../js/grounding.js';
import { designFromSpec } from '../js/api.js';
import { cellById } from '../js/cells.js';

function full(spec = { application: 'ev', energyWh: 60000 }, lengths = {}) {
  const d = designFromSpec(spec);
  const topo = buildTopology({
    summary: d.pack, partition: d.architecture.partition,
    cellForm: cellById(d.cell.id).form, lengths,
  });
  const wiring = wiringStudy({ topology: topo, packV: d.pack.nominalV, maxTempC: 60 });
  const f = faultFromShortCircuit(d.shortCircuit) || {};
  const grounding = groundingStudy({
    topology: topo, application: spec.application, packVMax: d.pack.vMax,
    faultA: f.faultA, clearingS: f.clearingS,
  });
  return { d, topo, wiring, grounding, brief: designBrief(d, { wiring, grounding }) };
}

test('every module reaches the brief, whatever shape it answers in', () => {
  const { brief } = full();
  const ids = brief.sections.map((s) => s.id);
  // Three different upstream shapes, all present: the audit's findings array,
  // the studies' {verdict, headline, findings}, and the plain note lists.
  for (const id of ['audit', 'fault', 'wiring', 'grounding', 'thermal', 'charging', 'sensors', 'v2x']) {
    ok(ids.includes(id), `${id} is in the brief`);
  }
  // And they all come out normalised, whatever they went in as.
  for (const f of brief.findings) {
    ok(f.id && f.title && typeof f.detail === 'string', 'every finding has an id, a title and a detail');
    ok(['fail', 'warn', 'info', 'pass'].includes(f.severity), `${f.id} has a house severity`);
    ok(Array.isArray(f.sources) && f.sources.length, `${f.id} names where it came from`);
  }
  ok(brief.counts.total === brief.findings.length, 'the counts match the list');
});

test('the order puts what could hurt someone before what costs money', () => {
  const { brief } = full();
  const sev = brief.findings.map((f) => f.severity);
  const rank = { fail: 0, warn: 1, info: 2, pass: 3 };
  for (let i = 1; i < sev.length; i++) {
    ok(rank[sev[i]] >= rank[sev[i - 1]], 'severity never goes backwards down the list');
  }
  // Within one severity, safety leads.
  const fails = brief.findings.filter((f) => f.severity === 'fail');
  for (let i = 1; i < fails.length; i++) {
    ok((CATEGORY_WEIGHT[fails[i].category] ?? 9) >= (CATEGORY_WEIGHT[fails[i - 1].category] ?? 9),
      'and within a severity the category order holds');
  }
  ok(CATEGORY_WEIGHT.safety < CATEGORY_WEIGHT.economics, 'safety outranks economics');
  ok(fails.length && fails[0].category === 'safety', 'so the loudest thing here is a safety failure');
});

test('one problem found twice is reported once, naming both finders', () => {
  const { brief } = full();
  // The audit and the fault study both reach the internal-short conclusion,
  // because both are entitled to. The brief must not say it twice.
  const merged = brief.findings.find((f) => f.sources.length > 1);
  ok(merged, 'at least one finding was reached by two modules');
  ok(merged.sources.includes('audit') && merged.sources.includes('fault'),
    'and it names both rather than silently dropping one');
  const titles = brief.findings.map((f) => `${f.severity}|${f.title.toLowerCase()}`);
  ok(new Set(titles).size === titles.length, 'no title appears twice at the same severity');
});

test('the headline leads with the actionable number and names the loudest thing', () => {
  const { brief } = full();
  ok(brief.verdict === 'not-workable', 'this design has failures');
  ok(brief.headline.includes(String(brief.counts.fail)), 'the headline carries the count');
  ok(/must change/.test(brief.headline), 'and says they must change');
  ok(brief.headline.toLowerCase().includes(brief.findings[0].title.toLowerCase().slice(0, 20)),
    'and names the first thing on the list');

  // A design with nothing wrong says so plainly rather than inventing concern.
  const clean = designBrief({ pack: { s: 1, p: 1, cellCount: 1, energyWh: 10 }, findings: [] });
  ok(clean.verdict === 'workable' && /Nothing/.test(clean.headline), 'a clean design gets a clean headline');
});

test('the open questions are what the tool is guessing, ranked by leverage', () => {
  const { brief } = full();
  ok(brief.questions.length > 0, 'this design rests on estimates');
  for (let i = 1; i < brief.questions.length; i++) {
    ok(brief.questions[i].weight <= brief.questions[i - 1].weight, 'ranked by how much they would move');
  }
  // Run lengths lead, because nothing else the tool guesses has that reach.
  ok(brief.questions[0].id === 'run-lengths', 'run lengths are the question worth asking first');
  for (const q of brief.questions) {
    ok(/\?$/.test(q.asks), `"${q.id}" is phrased as a question someone can answer`);
    ok(q.why && q.how, 'with why it matters and how to answer it');
  }
});

test('answering a question makes it go away, which is the whole point', () => {
  const guessed = full();
  ok(guessed.brief.questions.some((q) => q.id === 'run-lengths'), 'estimated lengths raise the question');

  const measured = full({ application: 'ev', energyWh: 60000 },
    { groupPitchMm: 25, moduleRunMm: 300, packRunMm: 400 });
  ok(!measured.brief.questions.some((q) => q.id === 'run-lengths'),
    'real lengths retire it');
  // And the answer genuinely changed, not just the question list.
  ok(measured.brief.counts.fail < guessed.brief.counts.fail,
    'with real routing the design has fewer failures than the estimate suggested');
});

test('a cell with no price or cycle life is asked about, one with both is not', () => {
  const priced = openQuestions({ cell: { name: 'X', priceUSD: 5, cycleLife: 500 } });
  ok(!priced.some((q) => q.id === 'cell-commercials'), 'a complete cell raises nothing');
  const bare = openQuestions({ cell: { name: 'X', priceUSD: null, cycleLife: null } });
  const q = bare.find((x) => x.id === 'cell-commercials');
  ok(q && /pay/.test(q.asks), 'a cell with no commercials is asked about');
  ok(/wear floor|cost per kWh/i.test(q.why), 'naming what cannot be answered without it');
});

test('the brief says what it did NOT check, not only what it did', () => {
  const { brief } = full();
  ok(brief.notChecked.length > 0, 'there is always something out of scope');
  ok(brief.notChecked.some((n) => /runaway|life-cycle|structural/i.test(n)),
    'the unmodelled physics is named');
  // Without the desktop studies, their absence is stated rather than implied.
  const thin = designBrief(designFromSpec({ application: 'ev', energyWh: 60000 }));
  ok(thin.notChecked.some((n) => /Conductor sizing/i.test(n)), 'no wiring study is said out loud');
  ok(thin.notChecked.some((n) => /Grounding/i.test(n)), 'and so is no grounding study');
  ok(brief.notChecked.length < thin.notChecked.length,
    'running the studies shortens the list of what was skipped');
});

test('it holds together for a small design and for no design at all', () => {
  const { brief } = full({ application: 'ebike' });
  ok(brief.pack.s > 0 && brief.pack.cell, 'an e-bike briefs too');
  ok(['workable', 'workable-with-costs', 'not-workable'].includes(brief.verdict), 'house vocabulary');
  ok(brief.assumptions.length > 0, 'and the assumptions of every study are gathered');
  ok(new Set(brief.assumptions).size === brief.assumptions.length, 'without repeating the shared ones');
  ok(designBrief(null) === null, 'no design, no brief');
});

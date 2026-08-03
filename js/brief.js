// brief.js — everything the tool knows about one design, in one voice.
//
// Fifteen modules answer fifteen questions, and each of them grew its own
// shape for the answer. The audit returns `findings`. The wiring, grounding
// and fault studies return `{verdict, headline, findings, assumptions}`. The
// thermal, charging, sensor and V2X models return `notes`, or an `assessment`,
// or a `policyNote`. Every one of those is reasonable on its own and none of
// them agree.
//
// That is fine while a person reads them one tab at a time. It stops being
// fine the moment anything wants to read ALL of them: a report, a CLI
// summary, or an assistant asked "what is wrong with my design?". Each of
// those would otherwise grow its own adapter for each module, and there would
// be three copies of the same translation drifting apart.
//
// So the translation happens once, here. Every module keeps the shape it has
// — nothing upstream changes, no test moves — and this reads all of them into
// one normalised, prioritised list.
//
// Two things come out of it that did not exist before:
//
//   WHAT MATTERS, IN ORDER. Safety before cost, failures before warnings,
//   and the loudest thing first — rather than whatever tab you happened to
//   open.
//
//   WHAT THE TOOL DOES NOT KNOW. Every estimate that would change the answer
//   if it were replaced by a real number, ranked by how much it would change
//   it. This is the half a report usually leaves out, and it is what makes a
//   conversation with a person useful instead of decorative: the tool can ask
//   the three questions worth asking rather than presenting a confident
//   answer built on guesses.
//
// Pure data, no DOM.

import { appClassOf } from './markets.js';

// Safety first, then the things that stop the machine working, then the ones
// that cost money. Within a severity this decides the order, because "your
// bonding is inadequate" and "your cost per kWh is high" are not equally
// urgent even when both are warnings.
export const CATEGORY_WEIGHT = {
  safety: 0, protection: 1, thermal: 2, electrical: 3, mechanical: 4,
  transport: 5, application: 6, simulation: 7, economics: 8, '': 9,
};

const SEVERITY_WEIGHT = { fail: 0, warn: 1, info: 2, pass: 3 };

const normalise = (f, source) => ({
  id: f.id || `${source}-${(f.title || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40)}`,
  severity: f.severity || 'info',
  category: f.category || '',
  source,
  title: f.title || '',
  detail: f.detail || '',
  ref: f.ref || null,
});

// A module that reports {verdict, headline, findings} contributes all three:
// the findings themselves, and the headline as context when there is nothing
// else to say about it.
function fromStudy(study, source, title) {
  if (!study) return null;
  return {
    id: source, title,
    verdict: study.verdict || null,
    headline: study.headline || null,
    findings: (study.findings || []).map((f) => normalise(f, source)),
    assumptions: study.assumptions || [],
  };
}

// A module that reports free-text notes contributes them as info findings.
// Notes are not nothing — they are usually the caveat that matters — they
// just never had a severity attached.
function fromNotes(notes, source, title, { verdict = null, headline = null, category = '' } = {}) {
  const list = (Array.isArray(notes) ? notes : notes ? [notes] : []).filter(Boolean);
  if (!list.length && !headline) return null;
  return {
    id: source, title, verdict, headline,
    findings: list.map((n, i) => normalise({
      id: `${source}-note-${i}`, severity: 'info', category,
      title: `${title}: what to know`, detail: n,
    }, source)),
    assumptions: [],
  };
}

/**
 * Everything the tool does not know about this design that would change the
 * answer if it did.
 *
 * Ranked by how much it would move, not by how easy it is to supply — the
 * point is to ask the question worth asking first. Each one is phrased as a
 * question a person can actually answer, because "interconnect resistance is
 * estimated" is a status and "how long are the runs between modules?" is
 * something someone can go and measure.
 */
export function openQuestions(design, { wiring = null, grounding = null } = {}) {
  const q = [];
  const cell = design?.cell;

  // Run lengths move every wiring number at once, and the same pack passes
  // or fails on them. Nothing else the tool guesses has that leverage.
  if (wiring?.runs?.some((r) => r.estimated)) {
    q.push({
      id: 'run-lengths', weight: 100, asks: 'How long are the conductor runs?',
      why: 'Every wiring number scales with length — resistance, heat, voltage drop and conductor mass. The lengths here were estimated from the pack envelope, which is deliberately conservative: a pack can show a dozen undersized conductors on estimates and none once the real routing is given.',
      how: 'Measure group pitch, the module busbar run and the main cable run on the layout.',
    });
  }
  if (wiring && !wiring.runs?.length) {
    q.push({
      id: 'installation', weight: 60, asks: 'How are the conductors installed — open, loomed, potted, or on a cold plate?',
      why: 'It changes the temperature more than almost anything else: the same busbar reaches 91 °C in free air, 145 °C in a loom and 42 °C bonded to a cold plate.',
      how: 'Pick the one that matches the build.',
    });
  }
  if (grounding?.estimated) {
    q.push({
      id: 'bonding-scheme', weight: 80, asks: 'What are the actual bonding paths, and what surface do they land on?',
      why: 'The bonding scheme here is a single assumed strap. Real machines have several, and the one that fails is usually the one nobody drew — most often because it lands on an anodised or painted surface that does not conduct at all.',
      how: 'List each bond: what it joins, its material and section, and the finish of the face it bolts to.',
    });
  }
  // A cell without a price or a cycle life leaves the whole economic answer
  // null, and it is the single easiest thing for a customer to supply.
  if (cell && (cell.priceUSD == null || cell.cycleLife == null)) {
    q.push({
      id: 'cell-commercials', weight: 70,
      asks: `What do you actually pay for the ${cell.name}, and what cycle life does your supplier quote?`,
      why: 'Without both, cost per kWh delivered, the replacement schedule and the V2G wear floor are all unanswerable. These are quotation-dependent, so no library value can stand in for yours.',
      how: 'Take them from your quote and your supplier\'s cycling data.',
    });
  }
  if (design?.simulation && cell?.dcirMOhm == null) {
    q.push({
      id: 'cell-dcir', weight: 50, asks: 'What is the cell\'s DC internal resistance?',
      why: 'It sets voltage sag under load and most of the heat the pack makes. Most datasheets omit it, so it was estimated — and the mission simulation rests on it.',
      how: 'A pulse test at your own current gives it directly, and calibrate() will fit the rest of the model to the same data.',
    });
  }
  // The fault study needs a real fuse curve; without one it guesses.
  if (design?.shortCircuit?.fuse?.assumed) {
    q.push({
      id: 'fuse-curve', weight: 65, asks: 'What is the fuse\'s melting I²t, from its datasheet?',
      why: 'Whether the pack clears a fault before the busbar fails is decided by this number, and it was assumed from a rule of thumb rather than read from a curve.',
      how: 'The manufacturer publishes it as an I²t value or a time-current curve.',
    });
  }
  const unpriced = design?.cost?.unpriced?.length || 0;
  if (unpriced > 0) {
    q.push({
      id: 'component-prices', weight: 30, asks: `What do the ${unpriced} unpriced items cost you?`,
      why: 'The bill of materials totals only the priced subset. The mass is real; the cost is partial until these are filled in.',
      how: 'Drop your quoted prices in — conductors are usually sold by the kilogram against a quote.',
    });
  }
  return q.sort((a, b) => b.weight - a.weight);
}

/**
 * The whole design as one prioritised briefing.
 *
 * `extras` is where the studies that are not part of designFromSpec() — the
 * wiring and grounding studies, which need a topology — are folded in, so the
 * desktop tier gets a fuller briefing than the browser without either of them
 * needing a different reader.
 */
export function designBrief(design, { wiring = null, grounding = null } = {}) {
  if (!design) return null;
  const sections = [];

  // The audit is already in the house shape, and it is the largest single
  // source, so it leads.
  if (design.findings?.length) {
    sections.push({
      id: 'audit', title: 'Engineering & standards audit',
      verdict: design.findings.some((f) => f.severity === 'fail') ? 'not-workable'
        : design.findings.some((f) => f.severity === 'warn') ? 'workable-with-costs' : 'workable',
      headline: null,
      findings: design.findings.map((f) => normalise(f, 'audit')),
      assumptions: [],
    });
  }

  sections.push(
    fromStudy(design.shortCircuit, 'fault', 'Short-circuit & fault study'),
    fromStudy(wiring, 'wiring', 'Conductor sizing'),
    fromStudy(grounding, 'grounding', 'Grounding & bonding'),
    fromNotes(design.thermal?.notes, 'thermal', 'Thermal system', {
      verdict: design.thermal?.assessment?.verdict || null,
      headline: design.thermal?.assessment?.why || null,
      category: 'thermal',
    }),
    fromNotes(design.charging?.notes, 'charging', 'Charging', { category: 'electrical' }),
    fromNotes(design.sensors?.notes, 'sensors', 'Sensor plan', { category: 'electrical' }),
    fromNotes(design.v2x?.policyNote, 'v2x', 'Feed-back policy', {
      headline: design.v2x?.why || null, category: 'application',
    }),
    fromNotes(design.warnings, 'spec', 'How the specification was read', { category: '' }),
  );

  const live = sections.filter(Boolean);
  // Two modules can reach the same conclusion — the audit and the fault study
  // both report the internal cell short, because both are entitled to.
  // Listing it twice is noise, and dropping one silently hides that two
  // independent checks agreed. So they merge, and the merged entry names both.
  const byTitle = new Map();
  for (const f of live.flatMap((s) => s.findings)) {
    const key = `${f.severity}|${f.title.toLowerCase()}`;
    const seen = byTitle.get(key);
    if (seen) { if (!seen.sources.includes(f.source)) seen.sources.push(f.source); continue; }
    byTitle.set(key, { ...f, sources: [f.source] });
  }
  const findings = [...byTitle.values()]
    .sort((a, b) => (SEVERITY_WEIGHT[a.severity] ?? 9) - (SEVERITY_WEIGHT[b.severity] ?? 9)
      || (CATEGORY_WEIGHT[a.category] ?? 9) - (CATEGORY_WEIGHT[b.category] ?? 9));

  const fails = findings.filter((f) => f.severity === 'fail');
  const warns = findings.filter((f) => f.severity === 'warn');
  const verdict = fails.length ? 'not-workable' : warns.length ? 'workable-with-costs' : 'workable';
  const questions = openQuestions(design, { wiring, grounding });

  // The one sentence someone gets if they read nothing else. It leads with
  // the failure count because that is the actionable number, and it names the
  // single loudest thing rather than summarising in the abstract.
  const top = fails[0] || warns[0] || null;
  const headline = fails.length
    ? `${fails.length} thing${fails.length === 1 ? '' : 's'} must change before this design is buildable — starting with ${top.title.toLowerCase()}.`
    : warns.length
      ? `Nothing blocks this design, but ${warns.length} thing${warns.length === 1 ? ' carries' : 's carry'} a cost worth knowing about — starting with ${top.title.toLowerCase()}.`
      : 'Nothing in the checks run so far blocks this design.';

  return {
    verdict, headline,
    pack: design.pack ? {
      s: design.pack.s, p: design.pack.p, cellCount: design.pack.cellCount,
      nominalV: design.pack.nominalV, energyWh: design.pack.energyWh,
      massKg: design.pack.massKg, cell: design.cell?.name || null,
      application: design.application?.name || null,
      applicationClass: design.spec?.application ? appClassOf(design.spec.application) : null,
    } : null,
    sections: live,
    findings,
    counts: {
      fail: fails.length, warn: warns.length,
      info: findings.filter((f) => f.severity === 'info').length,
      pass: findings.filter((f) => f.severity === 'pass').length,
      total: findings.length,
    },
    questions,
    assumptions: [...new Set(live.flatMap((s) => s.assumptions))],
    // What is NOT covered. A briefing that lists what it checked without
    // listing what it did not is the more dangerous of the two omissions.
    notChecked: [
      ...(wiring ? [] : ['Conductor sizing — no wiring study was run, so no conductor has been checked against the current it carries.']),
      ...(grounding ? [] : ['Grounding and bonding — no bonding path has been checked for continuity, touch voltage or fault survival.']),
      ...(design.simulation ? [] : ['Mission simulation — the design has not been driven through its duty cycle in time.']),
      'Thermal runaway propagation, life-cycle assessment and structural analysis are not modelled at all.',
    ],
  };
}

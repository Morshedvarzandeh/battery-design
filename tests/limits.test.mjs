// Limits — the tool must not freeze, and must not die.
//
// Every case here was found by fuzzing the engine with hostile input, not
// imagined. Two of them used to run forever: a 100000S100000P design and a
// ten-million-pass mission. On a modest machine a frozen application is
// indistinguishable from a crash, and it costs whoever was using it their
// work — so these are regression tests for the thing users actually feel.
import { test } from 'node:test';
import { ok } from './helpers.mjs';
import {
  MAX_CELLS, MAX_SIM_STEPS, MAX_SERIES, MAX_PARALLEL,
  clampPack, clampSteps, attempt, renderGuard,
} from '../js/limits.js';
import { designFromSpec } from '../js/api.js';
import { simulateMission } from '../js/sim1d.js';
import { cellById } from '../js/cells.js';

const CELL = cellById('samsung-inr21700-50e');
// Anything slower than this on the test machine is a freeze, not a delay.
const BUDGET_MS = 4000;
const timed = (fn) => { const t0 = Date.now(); const v = fn(); return { ms: Date.now() - t0, value: v }; };

test('a slipped keystroke cannot become ten billion cells', () => {
  // The original hang: this ran forever, laying out 10,000,000,000 cells.
  const { ms, value } = timed(() => designFromSpec({ application: 'ev', s: 100000, p: 100000 }));
  ok(ms < BUDGET_MS, `it answers in ${ms} ms instead of never`);
  ok(value.pack.cellCount <= MAX_CELLS, `and the pack is bounded (${value.pack.cellCount.toLocaleString()} cells)`);
  ok(value.warnings.some((w) => /past the/.test(w) && /limit/.test(w)),
    'the customer is told it was capped, and why');
  ok(value.warnings.some((w) => /stacks-and-racks/.test(w)),
    'and pointed at the right way to model a system that big');
});

test('no mission may run forever', () => {
  // The other original hang: ten million passes of a 60-step profile.
  const { ms, value } = timed(() => simulateMission({
    cell: CELL, s: 96, p: 4, profile: { dtS: 1, p: Array(60).fill(0.5) }, scaleW: 5000, passes: 1e7,
  }));
  ok(ms < BUDGET_MS, `it completes in ${ms} ms`);
  ok(value.assumptions.some((a) => /integration steps/.test(a) && /desktop runner/.test(a)),
    'and says both that it was shortened and where to go for the longer study');
});

test('the caps are generous enough that no honest design meets them', () => {
  ok(MAX_CELLS >= 250_000, 'a quarter of a million cells is past any single pack the tool models');
  ok(MAX_SIM_STEPS >= 2_000_000, 'and two million steps is fifty times a long WLTP study');
  // A real e-bus pack — about 30,000 cells — must pass through untouched.
  const bus = clampPack(186, 163);
  ok(bus.s === 186 && bus.p === 163 && bus.notes.length === 0, 'a 30,000-cell e-bus pack is not clamped at all');
  const ev = clampPack(96, 44);
  ok(ev.s === 96 && ev.p === 44 && ev.notes.length === 0, 'nor an EV pack');
});

test('clamping keeps the voltage and gives up the capacity, and says so', () => {
  const r = clampPack(500, 5000);
  ok(r.s === 500, 'series is kept — it sets the voltage, which is usually the deliberate choice');
  ok(r.s * r.p <= MAX_CELLS, 'the total is brought inside the limit');
  ok(r.notes.length > 0, 'every correction is reported');
  ok(clampPack(1e9, 1).s === MAX_SERIES, 'an absurd series count is capped');
  ok(clampPack(1, 1e9).p <= MAX_PARALLEL, 'and an absurd parallel count');
  // Nonsense rather than merely large.
  for (const [s, p] of [[NaN, 4], [0, 0], [-5, -5], ['x', 'y'], [Infinity, 1], [null, undefined]]) {
    const c = clampPack(s, p);
    ok(c.s >= 1 && c.p >= 1 && Number.isFinite(c.s * c.p), `${s}S${p}P becomes something buildable`);
    ok(c.notes.length > 0, 'and is not corrected silently');
  }
});

test('step budgeting scales passes to what can actually be run', () => {
  const small = clampSteps({ profileLength: 100, passes: 5 });
  ok(small.passes === 5 && small.notes.length === 0, 'a normal run is untouched');
  const big = clampSteps({ profileLength: 1000, passes: 1e6 });
  ok(big.steps <= MAX_SIM_STEPS, 'a huge one is brought inside the budget');
  ok(big.passes >= 1, 'but always runs at least once — an answer beats a refusal');
  ok(big.notes[0].includes('desktop runner'), 'and names where the longer study belongs');
  ok(clampSteps({ profileLength: 0, passes: 1 }).passes >= 1, 'an empty profile does not divide by zero');
  ok(clampSteps({ profileLength: 10, passes: -3 }).passes === 1, 'a negative pass count becomes one');
});

test('a failure is contained and explained, not swallowed', () => {
  const good = attempt('maths', () => 6 * 7);
  ok(good.ok && good.value === 42 && good.error === null, 'success passes through untouched');
  const bad = attempt('maths', () => { throw new Error('divide by cucumber'); }, 'fallback');
  ok(!bad.ok && bad.value === 'fallback', 'a failure returns the fallback rather than propagating');
  ok(bad.error === 'divide by cucumber', 'and keeps the reason, so it can be SHOWN');
  ok(bad.label === 'maths', 'labelled with what failed');
});

test('one broken panel does not take the page down', () => {
  // The DOM stand-in a render guard writes into.
  const el = { innerHTML: '' };
  const orderOfEvents = [];
  const okRender = renderGuard('Panel A', el, () => { orderOfEvents.push('A'); });
  const badRender = renderGuard('Panel B', el, () => { throw new Error('no cell selected'); });
  const afterRender = renderGuard('Panel C', el, () => { orderOfEvents.push('C'); });
  ok(okRender === true && afterRender === true, 'the panels either side of the failure still render');
  ok(orderOfEvents.join('') === 'AC', 'and rendering continued past the broken one');
  ok(badRender === false, 'the failure is reported to the caller');
  ok(/could not be calculated/.test(el.innerHTML), 'the panel says so where the user is looking');
  ok(/no cell selected/.test(el.innerHTML), 'including the actual reason');
  ok(/rest of the design is unaffected/.test(el.innerHTML), 'and reassures them the rest still stands');
  // A guard with nowhere to write must still not throw.
  ok(renderGuard('Panel D', null, () => { throw new Error('boom'); }) === false,
    'a guard with no element to write to still contains the failure');
  // And it must not be fooled into injecting markup.
  const evil = { innerHTML: '' };
  renderGuard('<img src=x onerror=alert(1)>', evil, () => { throw new Error('<script>bad</script>'); });
  ok(!/<img|<script>/.test(evil.innerHTML) && /&lt;/.test(evil.innerHTML),
    'error text is escaped — a crash must not become an injection');
});

test('hostile input across the whole engine returns, every time', () => {
  const hostile = [
    ['null spec', null], ['a string', 'not a spec'], ['a number', 42],
    ['empty', {}], ['NaN energy', { application: 'ev', energyWh: NaN }],
    ['Infinity energy', { application: 'ev', energyWh: Infinity }],
    ['negative energy', { application: 'ev', energyWh: -5000 }],
    ['zero S and P', { application: 'ev', s: 0, p: 0 }],
    ['text counts', { application: 'ev', s: 'abc', p: 'def' }],
    ['unknown everything', { application: 'zzz', cell: 'zzz', market: 'zzz', v2xPolicy: 'zzz' }],
    ['dod out of range', { application: 'ev', dod: 99 }],
    ['huge vehicle', { application: 'ev', vehicle: { curbKg: 1e9 } }],
  ];
  for (const [name, spec] of hostile) {
    const { ms, value } = timed(() => designFromSpec(spec));
    ok(ms < BUDGET_MS, `${name}: answers in ${ms} ms`);
    ok(value?.pack?.cellCount > 0, `${name}: still produces a usable design`);
    ok(Number.isFinite(value.pack.energyWh), `${name}: with real numbers, not NaN`);
  }
});

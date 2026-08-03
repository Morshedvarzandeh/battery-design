// Mobile — the layout rules a phone depends on.
//
// These tests exist because of a bug that was invisible to every other test:
// the page HAD a `@media (max-width:760px){ .stage{min-height:380px} }` rule,
// but a later plain `.stage{min-height:0}` overrode it — media queries add no
// specificity, so source order decides. The result was a stage of zero height:
// on every phone the 2D/3D view vanished entirely and its floating controls
// fell on top of the panel text underneath.
//
// Nothing in a headless unit test renders CSS, so these check the invariant
// that made the bug possible instead: the phone rules must come LAST, and the
// specific overrides a phone needs must be present.
import { test } from 'node:test';
import { readFileSync } from 'fs';
import { ok } from './helpers.mjs';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
// Comments stripped first: this file explains the bug it fixes by quoting the
// broken rule, and a test that reads prose as CSS would fail on the comment.
const css = html.slice(html.indexOf('<style>'), html.indexOf('</style>'))
  .replace(/\/\*[\s\S]*?\*\//g, '');
const PHONE = '@media (max-width:760px)';
const phoneAt = css.indexOf(PHONE);
// Everything from the phone block to the end of the stylesheet.
const phoneBlock = css.slice(phoneAt);

test('the page declares itself for a phone at all', () => {
  ok(/<meta name="viewport" content="width=device-width/.test(html),
    'the viewport meta is present — without it a phone renders a 980px desktop page and zooms out');
  ok(phoneAt > 0, 'a phone breakpoint exists');
});

// The invariant that the original bug broke. Any plain rule for these
// selectors that appears AFTER the phone block silently wins on a phone.
test('the phone rules come last, so nothing later can quietly override them', () => {
  for (const selector of ['.stage{', '.panel{', 'html,body{', '#viewport{', '.stage-ui{', '#tabs{']) {
    const lastPlain = css.lastIndexOf(`\n${selector}`);
    ok(lastPlain < phoneAt,
      `"${selector}" is last declared before the phone block (a later rule would beat it: `
      + `media queries carry no extra specificity)`);
  }
});

test('the stage keeps a real height on a phone', () => {
  // The whole point of the tool is seeing the pack. A collapsed stage is not
  // a cosmetic problem — it is the product disappearing.
  const stageRule = phoneBlock.match(/\.stage\{[^}]*\}/)?.[0] || '';
  ok(/height:\s*\d+vh/.test(stageRule), `the stage is given a viewport-relative height (${stageRule.slice(0, 60)}…)`);
  ok(/min-height:\s*\d+vh/.test(stageRule), 'and a min-height, so a flex parent cannot squeeze it to nothing');
  ok(/order:\s*1/.test(stageRule), 'and it comes first — a visitor sees the pack before the controls');
});

test('a phone gets one scrolling document, not three nested scroll panes', () => {
  // Desktop pins the app to the viewport and scrolls each column inside it.
  // On a phone that squeezed 1200px of controls into a 135px window.
  ok(/html,body\{height:auto/.test(phoneBlock.replace(/\s+/g, '')),
    'the viewport-height lock is released');
  const panelRule = phoneBlock.match(/\.panel\{[^}]*\}/)?.[0] || '';
  ok(/max-height:\s*none!important/.test(panelRule) && /overflow:\s*visible!important/.test(panelRule),
    'and the panel flows at its natural height instead of scrolling inside itself');
  ok(/#tabs\{[^}]*position:sticky/.test(phoneBlock),
    'the tab bar sticks, so navigation is reachable however far down you scroll');
});

test('the floating stage controls do not cover the drawing they belong to', () => {
  // The viewers size themselves from clientHeight, so the fix has to shorten
  // the viewport box — merely styling the toolbar would leave the drawing
  // rendering underneath it.
  ok(/#viewport,#viewport2d\{bottom:\d+px\}/.test(phoneBlock.replace(/\s+/g, '')),
    'the viewport boxes stop above the toolbar strip');
  const uiRule = phoneBlock.match(/\.stage-ui\{[^}]*\}/)?.[0] || '';
  ok(/height:\s*\d+px/.test(uiRule), 'the toolbar has a known height to reserve');
  ok(/overflow-x:\s*auto/.test(uiRule), 'and scrolls sideways rather than wrapping over the view');
  ok(/\.stage-stats\{display:none!important\}/.test(phoneBlock.replace(/\s+/g, '')),
    'the big stats overlay is hidden — those numbers are already in the header on a phone');
});

test('controls are big enough to hit with a finger', () => {
  const flat = phoneBlock.replace(/\s+/g, '');
  ok(/min-height:40px/.test(flat), 'buttons, selects and number inputs get a 40px target');
  ok(/\.preset\{min-height:64px\}/.test(flat), 'application presets are properly tappable cards');
});

test('narrow screens get their own arrangement, not a squeezed wide one', () => {
  ok(/@media \(max-width:400px\)/.test(css), 'very small phones have a breakpoint of their own');
  ok(/@media \(max-width:900px\) and \(orientation:landscape\)/.test(css),
    'landscape phones are treated as short rather than narrow');
  const flat = css.replace(/\s+/g, '');
  ok(/\.preset-grid,\.wz-grid\{grid-template-columns:1fr\}/.test(flat),
    'the preset grid drops to one column when three would not fit');
  ok(/\.wz-card,\.diag-card\{max-width:96vw!important;max-height:88vh!important;overflow-y:auto\}/.test(flat),
    'modals stay scrollable on a short screen — a dialog you cannot scroll is a dead end');
});

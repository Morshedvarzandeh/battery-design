import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('../cosim.html', import.meta.url), 'utf8');
const css = await readFile(new URL('../cosim.css', import.meta.url), 'utf8');
const studio = await readFile(new URL('../js/cosim-studio.js', import.meta.url), 'utf8');
const index = await readFile(new URL('../index.html', import.meta.url), 'utf8');

test('the engineering workbench links to one focused co-simulation studio', () => {
  assert.match(index, /href="\.\/cosim\.html"[^>]*>Co-Simulation Studio/);
  assert.match(html, /Rust-authoritative equation runs/);
  assert.match(html, /Start with the result, not the blocks/);
});

test('guided, manual and automatic modes have visible human meanings', () => {
  assert.match(html, /value="guided" checked/);
  assert.match(html, /value="manual"/);
  assert.match(html, /value="automatic"/);
  assert.match(html, /AI drafts; human approves/);
  assert.match(studio, /applyApprovedGraphProposal/);
});

test('the visual graph is semantic, keyboard reachable and responsive', () => {
  assert.match(html, /id="graphCanvas"[^>]*tabindex="0"/);
  assert.match(html, /<svg id="wireLayer"/);
  assert.match(html, /aria-label="Visual block workspace"/);
  assert.match(css, /@media \(max-width:760px\)/);
  assert.match(css.replace(/\s+/g, ''), /main\{display:flex;flex-direction:column/);
  assert.match(studio, /event\.key === 'Delete'/);
});

test('live playback and hard real-time are never conflated', () => {
  assert.match(html, /Run live playback/);
  assert.match(html, /not deterministic HIL real-time/);
  assert.match(studio, /requestAnimationFrame\(step\)/);
});

test('runaway propagation is visible with a non-certification boundary', () => {
  assert.match(html, /Runaway propagation/);
  assert.match(html, /comparative screening model and never certifies safety/);
  assert.match(studio, /Unproven — never a safety pass/);
  assert.match(studio, /containment case/);
  assert.match(studio, /Chemistry behavior on the same design/);
  assert.match(studio, /NMC demands the earliest intervention/);
  assert.match(studio, /None is a safety approval/);
  assert.match(studio, /Calculated heat paths between cells/);
  assert.match(studio, /Cell spacer \/ holder/);
  assert.match(studio, /Show the propagation equations/);
});

test('vent sizing and loop verification are separate and plainly bounded', () => {
  assert.match(studio, /Emergency vent sizing/);
  assert.match(studio, /Gas low \(L\/cell\)/);
  assert.match(studio, /Conditional vent-area screen/);
  assert.match(studio, /not NFPA 68 deflagration sizing/);
  assert.match(studio, /Supplier vent and market constraint/);
  assert.match(studio, /Human-screened discharge faces/);
  assert.match(studio, /Provisional vent coordinates/);
  assert.match(studio, /Required quantity/);
  assert.match(html, /Software-in-the-Loop/);
  assert.match(html, /Hardware-in-the-Loop/);
  assert.match(html, /Only measured target evidence can pass it/);
  assert.match(studio, /createSilTestPlan/);
  assert.match(studio, /createHilTestContract/);
});

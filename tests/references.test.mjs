// References — the citation index must not drift from the code. A reference
// file that quietly falls behind is worse than no reference file: it looks
// authoritative while being wrong. So every standard the tool cites to a
// customer has to appear in REFERENCES.md, and the licence/attribution files
// have to say what they claim to say.
import { test } from 'node:test';
import { readFileSync } from 'fs';
import { ok } from './helpers.mjs';
import { STANDARDS_INFO } from '../js/standards.js';
import { MARKETS, releaseChecklist } from '../js/markets.js';
import { PRESETS } from '../js/presets.js';
import { PATENT_LANDSCAPE } from '../js/patents.js';

const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const REFS = read('REFERENCES.md');
const README = read('README.md');

// A code cited as "UL 9540A" must be findable in the references. Normalise
// whitespace so a line break in the table never fails a real citation.
const flat = REFS.replace(/\s+/g, ' ');
const cited = (code) => flat.includes(code);

test('every standard in the reference list is cited in REFERENCES.md', () => {
  ok(STANDARDS_INFO.length >= 15, `standards catalogue populated (${STANDARDS_INFO.length})`);
  for (const s of STANDARDS_INFO) {
    // The IATA entry is cited by its packing instruction, not its catalogue name.
    const code = s.id === 'iata-dgr' ? 'PI 965' : s.code;
    ok(cited(code), `${s.code} appears in REFERENCES.md`);
  }
});

test('every standard the release checklist shows a customer is cited', () => {
  const missing = new Set();
  for (const pr of PRESETS) {
    for (const m of MARKETS) {
      const cl = releaseChecklist({
        market: m.id, application: pr.id, chemistry: pr.preferredChemistries[0],
      });
      for (const item of cl.items) {
        // Checklist codes can carry a qualifier ("GB 38031-2025", "ISO 6469-1/-3");
        // cite-checking the stem is enough to prove the source is documented.
        const stem = item.code.split(/[/(]/)[0].trim().replace(/[-:]20\d\d$/, '');
        if (stem && !cited(stem)) missing.add(`${stem} (${pr.id}×${m.id})`);
      }
    }
  }
  ok(missing.size === 0, `uncited standards shown to customers: ${[...missing].join(', ')}`);
});

test('the honest-assumptions register exists and names the real estimates', () => {
  ok(/Assumptions with no public source/i.test(REFS), 'section 8 present');
  for (const claim of [
    'DCIR', 'interconnect', 'Contactor mass', 'COP', 'OCV', 'swelling',
    'Wall thickness', 'aisy-chain node limit', 'CO', // CO2 footprint row
  ]) {
    ok(flat.includes(claim), `assumptions register names "${claim}"`);
  }
  // The wall-thickness row must keep saying no standard prescribes a number —
  // that is the project's position and it is easy to lose in an edit.
  ok(/not prescribed/i.test(flat) && /ECE R100 Annex 4/.test(flat),
    'wall thickness stays "tests prescribe outcomes, not millimetres"');
});

test('patent landscape is cited as landscape, never as freedom-to-operate', () => {
  ok(PATENT_LANDSCAPE.length > 0, 'patent families exist');
  ok(/freedom-to-operate/i.test(flat), 'REFERENCES.md carries the FTO disclaimer');
  ok(/Google Patents/.test(flat), 'the links policy is stated');
});

test('the validation anchor and its number are documented', () => {
  ok(/Model 3/.test(flat) && /4,?416/.test(flat), 'the production-pack anchor is named');
  ok(/35%/.test(flat) && /integration allowance/i.test(flat),
    'the integration allowance is traced to that anchor');
});

test('licence and attribution files are present and consistent', () => {
  const lic = read('LICENSE'), notice = read('NOTICE'), cff = read('CITATION.cff');
  ok(/Apache License/.test(lic) && /Version 2\.0/.test(lic), 'LICENSE is Apache 2.0');
  ok(/Grant of Patent License/.test(lic), 'the patent grant clause is intact');
  ok(/Morshed Varzandeh/.test(lic), 'copyright holder named in the appendix');
  ok(/three\.js/i.test(notice) && /MIT/.test(notice), 'NOTICE attributes the vendored three.js');
  ok(/never leaves the user's device|never leaves/.test(notice.replace(/[’']/g, "'")),
    'NOTICE keeps the customer-data privacy statement');
  ok(/license: Apache-2\.0/.test(cff), 'CITATION.cff matches the licence');
  ok(/Apache/.test(README) && /REFERENCES\.md/.test(README),
    'README points at both the licence and the references');
});

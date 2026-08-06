// References — the citation index must not drift from the code. A reference
// file that quietly falls behind is worse than no reference file: it looks
// authoritative while being wrong. So every standard the tool cites to a
// customer has to appear in REFERENCES.md, and the licence/attribution files
// have to say what they claim to say.
import { test } from 'node:test';
import { readFileSync, existsSync } from 'fs';
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
      // Including the items a grid-facing feed-back policy adds — those are
      // shown to customers too, so they are held to the same citation rule.
      const cl = releaseChecklist({
        market: m.id, application: pr.id, chemistry: pr.preferredChemistries[0], v2x: 'v2g',
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

test('the marine TwinShip basis cites primary NTNU evidence without overstating it', () => {
  for (const required of [
    'intelligentsystemslab.org.ntnu.no/project/twinship.html',
    'MIC-2020-4-2.pdf',
    'R/V Gunnerus technical specifications',
    'milliAmpere: An Autonomous Ferry Prototype',
  ]) ok(flat.includes(required), `marine evidence names ${required}`);
  ok(/architecture and research-demonstrator reference/i.test(flat),
    'TwinShip is identified as an architecture/research reference');
  ok(/does not supply.*certified marine battery model/i.test(flat)
    && /class approval remains outside/i.test(flat),
  'the references refuse certification and class-approval claims');
  ok(/deadweight is not silently treated as displacement/i.test(flat),
    'the Gunnerus mass evidence boundary is documented');
});

test('the page describes itself for link previews and search', () => {
  const html = read('index.html');
  ok(/<meta name="description"/.test(html), 'meta description present');
  ok(/property="og:title"/.test(html) && /property="og:description"/.test(html),
    'Open Graph title and description present');
  const og = html.match(/property="og:image" content="([^"]+)"/);
  ok(og && og[1].startsWith('https://'),
    'og:image is an absolute URL (relative ones do not resolve for crawlers)');
  // ...and it must actually exist in the repo. A tag pointing at a missing
  // file is worse than no tag: the preview silently renders blank. (.gitignore
  // once swallowed this very file.)
  const rel = og[1].replace(/^https:\/\/[^/]+\/[^/]+\//, '');
  ok(existsSync(new URL(`../${rel}`, import.meta.url)),
    `og:image target is committed to the repo (${rel})`);
  ok(/twitter:card" content="summary_large_image"/.test(html), 'large-image card declared');
  // The footer must keep pointing at the sources and the licence.
  ok(/REFERENCES\.md/.test(html) && /AGPL/.test(html),
    'footer links to the sources and states the licence');
});

test('licence and attribution files are present and consistent', () => {
  const lic = read('LICENSE'), notice = read('NOTICE'), cff = read('CITATION.cff');
  ok(/GNU AFFERO GENERAL PUBLIC LICENSE/.test(lic) && /Version 3, 19 November 2007/.test(lic),
    'LICENSE is the AGPL-3.0');
  // Section 13 is the entire reason to choose this licence over the GPL for a
  // tool that is deployed as a web page: without it, someone can run a
  // modified version as a service and owe nobody anything.
  ok(/13\. Remote Network Interaction/.test(lic), 'the network-use clause is intact');
  ok(/11\. Patents/.test(lic), 'and the patent section');
  // The FSF's terms are that the licence text is used VERBATIM. The copyright
  // holder goes in the notices, not into the licence body — filling in the
  // appendix template would be modifying the licence.
  ok(!/Morshed Varzandeh/.test(lic), 'the licence text is unmodified');
  ok(/Morshed Varzandeh/.test(notice), 'the copyright holder is named in NOTICE instead');

  ok(/three\.js/i.test(notice) && /MIT/.test(notice), 'NOTICE attributes the vendored three.js');
  // The 3D garage embeds Godot's runtime, which is MIT and stays MIT. An AGPL
  // project may include MIT code; it may not relicense it, and a NOTICE that
  // failed to say so would be claiming someone else's engine.
  ok(/Godot/i.test(notice), 'NOTICE attributes the Godot runtime in the 3D build');
  ok(/never leaves the user's device|never leaves/.test(notice.replace(/[’']/g, "'")),
    'NOTICE keeps the customer-data privacy statement');

  ok(/license: AGPL-3\.0-or-later/.test(cff), 'CITATION.cff matches the licence');
  ok(/AGPL/.test(README) && /REFERENCES\.md/.test(README),
    'README points at both the licence and the references');
  // Relicensing is not retroactive and saying otherwise would be a false claim
  // about code other people already hold.
  ok(/Apache/.test(notice) && /not retroactive|remains true of those releases/.test(notice),
    'NOTICE says plainly that earlier Apache-2.0 releases stay Apache-2.0');
});

// export-profiles.mjs — move the built-in profiles out of code and into data.
//
// They were written as JavaScript because they are generated: a few helper
// calls produce eighty samples. That was fine while there were sixteen. It
// stops being fine when the library is meant to grow, because every new
// profile then needs a code change, a review and a release — and the people
// with the best profiles are customers with telematics exports, not people
// who will open a pull request.
//
// So the shapes become data. This writes each one out once; after that the
// folder is the library and this tool is only history.
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LOAD_PROFILES } from '../js/loadprofiles.js';

const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'profiles');
mkdirSync(OUT, { recursive: true });

const index = [];
for (const p of LOAD_PROFILES) {
  const record = {
    id: p.id, name: p.name, appIds: p.appIds, dtS: p.dtS,
    note: p.note,
    source: 'built-in',
    // Rounded: these are class-representative shapes, and sixteen digits of
    // float precision would imply a measurement nobody took.
    p: p.p.map((v) => Math.round(v * 1000) / 1000),
  };
  writeFileSync(path.join(OUT, `${p.id}.json`), `${JSON.stringify(record, null, 2)}\n`);
  index.push({ id: p.id, name: p.name, appIds: p.appIds, file: `${p.id}.json` });
}

writeFileSync(path.join(OUT, 'index.json'), `${JSON.stringify({
  note: 'The load-profile library. Drop a .json file in this folder and add it here to make it available — no code change. A browser cannot list a directory, so this manifest is what both the page and the desktop runner read.',
  schema: {
    id: 'unique id', name: 'what a customer sees', appIds: 'applications it suits, [] for any',
    dtS: 'seconds per sample', p: 'normalised power, +1 = peak discharge, negative = charge/regen',
    note: 'what it represents and where it came from', source: 'built-in | contributed | measured',
    terrain: 'optional: tarmac | gravel | sand | mud | rock | snow',
  },
  profiles: index,
}, null, 2)}\n`);

console.log(`exported ${index.length} profiles to profiles/`);

// prepare.mjs — stage the app for packaging.
//
// The web app has no build step, and adding one for the desktop package would
// be the wrong trade: a bundler is a second thing that can disagree with what
// the page does. So this copies, and nothing else.
//
// It produces one directory, `runner/`, which is both:
//
//   · what the window falls back to if the local compute never starts, and
//   · what `bd.mjs serve` serves, because bd.mjs resolves its root as the
//     parent of its own directory — so `runner/desktop/bd.mjs` sees
//     `runner/` and finds index.html, js/ and vendor/ exactly where it
//     expects them.
//
// One staged copy, used twice, with no path rewriting anywhere.

import { cpSync, mkdirSync, rmSync, existsSync, writeFileSync, statSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const OUT = path.join(HERE, 'runner');

// Exactly what the application needs at runtime. Tests, tools and the
// contrib data are not shipped — they are how the tool is built, not how it
// is used, and shipping them makes the download bigger for no one's benefit.
const INCLUDE = ['index.html', 'js', 'vendor', 'assets', 'desktop', 'REFERENCES.md', 'LICENSE', 'NOTICE'];

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

for (const entry of INCLUDE) {
  const from = path.join(ROOT, entry);
  if (!existsSync(from)) {
    console.error(`prepare: missing ${entry} — the package would be broken, so this is fatal.`);
    process.exit(1);
  }
  cpSync(from, path.join(OUT, entry), { recursive: true });
}

// The desktop-app directory must not copy itself into itself.
rmSync(path.join(OUT, 'desktop', 'node_modules'), { recursive: true, force: true });

const bytes = (dir) => readdirSync(dir, { withFileTypes: true }).reduce((sum, e) => {
  const p = path.join(dir, e.name);
  return sum + (e.isDirectory() ? bytes(p) : statSync(p).size);
}, 0);

writeFileSync(path.join(OUT, 'PACKAGED.json'), JSON.stringify({
  packagedFrom: 'battery-design',
  note: 'Staged by desktop-app/prepare.mjs. No bundler, no transform — these are the same files the web app serves.',
}, null, 2));

console.log(`prepare: staged ${INCLUDE.length} entries into runner/ (${(bytes(OUT) / 1e6).toFixed(1)} MB)`);

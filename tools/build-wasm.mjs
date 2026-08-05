// Build the dependency-free Rust core into the public asset consumed by both
// GitHub Pages and the Tauri package. No wasm-bindgen glue is required because
// the crate exposes a deliberately tiny C ABI.

import { copyFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = path.join(root, 'rust-core', 'Cargo.toml');
// Pages uploads the repository directory as its site. Keeping Cargo's target
// tree outside it prevents intermediate object files from becoming public or
// inflating the deployment artifact.
const targetDir = process.env.CARGO_TARGET_DIR
  ? path.resolve(process.env.CARGO_TARGET_DIR)
  : path.join(tmpdir(), 'battery-design-rust-target');
const built = path.join(targetDir, 'wasm32-unknown-unknown', 'release', 'battery_design_core.wasm');
const outputDir = path.join(root, 'wasm');
const output = path.join(outputDir, 'battery_design_core.wasm');

const run = spawnSync('cargo', [
  'build', '--locked', '--release', '--target', 'wasm32-unknown-unknown',
  '--manifest-path', manifest,
], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, CARGO_TARGET_DIR: targetDir },
});

if (run.error) {
  console.error(`Could not start Cargo: ${run.error.message}`);
  process.exit(1);
}
if (run.status !== 0) process.exit(run.status ?? 1);

mkdirSync(outputDir, { recursive: true });
copyFileSync(built, output);
console.log(`Rust/Wasm core: ${path.relative(root, output)}`);

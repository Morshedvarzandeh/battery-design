#!/usr/bin/env node
// Reproducible FMI 2.0 native build and archive assembly.
//
// Source generation stays in js/fmi.js / desktop/bd.mjs. This tool consumes
// that one canonical tree, compiles its declared source files with the pinned
// standard headers, verifies the ABI, and writes a deterministic .fmu ZIP.

import { createHash } from 'node:crypto';
import {
  copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import {
  basename, dirname, extname, join, relative, resolve, sep,
} from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  FMI2_REQUIRED_CO_SIMULATION_SYMBOLS, FMI_STANDARD_VERSION, FMU_MODEL_REVISION,
} from '../js/fmi.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STANDARD_ROOT = join(REPO_ROOT, 'third_party', `fmi-${FMI_STANDARD_VERSION}`);
const STANDARD_HEADERS = join(STANDARD_ROOT, 'headers');
const MAX_FILES = 256;
const MAX_FILE_BYTES = 128 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;

export const FMI2_NATIVE_PLATFORMS = Object.freeze({
  linux64: Object.freeze({ os: 'linux', nodeArchitecture: 'x64', extension: '.so', architecture: 'x86-64' }),
  win64: Object.freeze({ os: 'win32', nodeArchitecture: 'x64', extension: '.dll', architecture: 'x64' }),
  darwin64: Object.freeze({ os: 'darwin', nodeArchitecture: 'x64', extension: '.dylib', architecture: 'x86_64' }),
});

const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const xmlUnescape = (value) => value.replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

function requireRegularFile(path, label = path) {
  if (!existsSync(path)) throw new Error(`Missing ${label}: ${path}`);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular file: ${path}`);
  if (stat.size <= 0 || stat.size > MAX_FILE_BYTES) throw new Error(`${label} has an invalid size: ${stat.size}`);
  return stat;
}

function safeRelativePath(value, label) {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.startsWith('/')) {
    throw new Error(`Unsafe ${label}: ${value}`);
  }
  const parts = value.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..' || part.startsWith('.'))) {
    throw new Error(`Unsafe ${label}: ${value}`);
  }
  return value;
}

function platformContract(platform) {
  const contract = FMI2_NATIVE_PLATFORMS[platform];
  if (!contract) throw new Error(`Unsupported FMI 2.0 platform "${platform}".`);
  return contract;
}

export function readFmuContract(tree) {
  const root = resolve(tree);
  const xmlPath = join(root, 'modelDescription.xml');
  requireRegularFile(xmlPath, 'modelDescription.xml');
  const xml = readFileSync(xmlPath, 'utf8');
  if (!/\bfmiVersion="2\.0"/.test(xml)) throw new Error('modelDescription.xml is not FMI 2.0.');
  const coSimulation = /<CoSimulation\b([^>]*)>([\s\S]*?)<\/CoSimulation>/.exec(xml);
  if (!coSimulation) throw new Error('modelDescription.xml has no non-empty CoSimulation declaration.');
  const modelMatch = /\bmodelIdentifier="([^"]+)"/.exec(coSimulation[1]);
  const guidMatch = /<fmiModelDescription\b[^>]*\bguid="([^"]+)"/.exec(xml);
  if (!modelMatch || !guidMatch) throw new Error('modelDescription.xml is missing modelIdentifier or guid.');
  const modelIdentifier = xmlUnescape(modelMatch[1]);
  const guid = xmlUnescape(guidMatch[1]);
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(modelIdentifier)) {
    throw new Error(`Invalid FMI modelIdentifier: ${modelIdentifier}`);
  }
  const sourceFiles = [...coSimulation[2].matchAll(/<File\s+name="([^"]+)"\s*\/>/g)]
    .map((match) => safeRelativePath(xmlUnescape(match[1]), 'SourceFiles entry'));
  if (!sourceFiles.length || new Set(sourceFiles).size !== sourceFiles.length) {
    throw new Error('CoSimulation SourceFiles must be present and unique.');
  }
  const sourcePaths = sourceFiles.map((name) => {
    const path = join(root, 'sources', ...name.split('/'));
    requireRegularFile(path, `declared source ${name}`);
    return path;
  });
  return Object.freeze({ root, xmlPath, xml, modelIdentifier, guid, sourceFiles, sourcePaths });
}

function runChecked(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: 'utf8',
    env: options.env || process.env,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    const rendered = [command, ...args].join(' ');
    throw new Error(`Command failed (${result.status ?? 'spawn'}): ${rendered}\n${result.stdout || ''}${result.stderr || ''}`);
  }
  return `${result.stdout || ''}${result.stderr || ''}`;
}

function compileOnce({ contract, platform, compiler, outputPath, buildDirectory }) {
  const target = platformContract(platform);
  mkdirSync(dirname(outputPath), { recursive: true });
  mkdirSync(buildDirectory, { recursive: true });
  if (target.os === 'win32') {
    const args = [
      '/nologo', '/std:c11', '/O2', '/W4', '/WX', '/MT', '/LD',
      '/DFMI2_OVERRIDE_FUNCTION_PREFIX', `/I${STANDARD_HEADERS}`,
      ...contract.sourcePaths,
      '/link', '/Brepro', `/OUT:${outputPath}`,
      `/IMPLIB:${join(buildDirectory, `${contract.modelIdentifier}.lib`)}`,
    ];
    runChecked(compiler || 'cl.exe', args, { cwd: buildDirectory });
    return;
  }

  const common = [
    '-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', '-fPIC', '-fvisibility=hidden',
    '-shared', '-DFMI2_OVERRIDE_FUNCTION_PREFIX', `-I${STANDARD_HEADERS}`,
    ...(target.os === 'darwin' ? ['-arch', 'x86_64'] : []),
    ...contract.sourcePaths,
  ];
  const linker = target.os === 'linux'
    ? ['-Wl,--no-undefined', '-Wl,-z,defs', '-Wl,--build-id=none']
    : ['-Wl,-undefined,error', '-Wl,-no_uuid', '-mmacosx-version-min=11.0'];
  runChecked(compiler || process.env.CC || 'cc', [...common, ...linker, '-o', outputPath, '-lm'], {
    cwd: buildDirectory,
    env: target.os === 'darwin' ? { ...process.env, MACOSX_DEPLOYMENT_TARGET: '11.0' } : process.env,
  });
}

function exportedSymbols(binaryPath, platform) {
  const target = platformContract(platform);
  let output;
  if (target.os === 'win32') output = runChecked('dumpbin.exe', ['/exports', binaryPath]);
  else if (target.os === 'darwin') output = runChecked('nm', ['-gU', binaryPath]);
  else output = runChecked('nm', ['-D', '--defined-only', binaryPath]);
  const symbols = new Set();
  for (const line of output.split(/\r?\n/)) {
    const token = line.trim().split(/\s+/).at(-1) || '';
    const normalized = target.os === 'darwin' && token.startsWith('_') ? token.slice(1) : token;
    if (/^fmi2[A-Za-z0-9_]+$/.test(normalized)) symbols.add(normalized);
  }
  return symbols;
}

function compareDottedVersions(a, b) {
  const left = String(a).split('.').map(Number);
  const right = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const difference = (left[i] || 0) - (right[i] || 0);
    if (difference) return difference;
  }
  return 0;
}

export function inspectNativeBinary({ tree, platform, maxGlibc = null }) {
  const contract = readFmuContract(tree);
  const target = platformContract(platform);
  if (maxGlibc && !/^\d+\.\d+(?:\.\d+)*$/.test(maxGlibc)) {
    throw new Error(`Invalid GLIBC ceiling: ${maxGlibc}`);
  }
  const binaryPath = join(contract.root, 'binaries', platform,
    `${contract.modelIdentifier}${target.extension}`);
  const stat = requireRegularFile(binaryPath, `${platform} FMI binary`);
  const platformDirectory = dirname(binaryPath);
  const entries = readdirSync(platformDirectory, { withFileTypes: true });
  if (entries.length !== 1 || !entries[0].isFile() || entries[0].name !== basename(binaryPath)) {
    throw new Error(`${platform} binary directory must contain only ${basename(binaryPath)}.`);
  }
  const symbols = exportedSymbols(binaryPath, platform);
  const missing = FMI2_REQUIRED_CO_SIMULATION_SYMBOLS.filter((symbol) => !symbols.has(symbol));
  if (missing.length) throw new Error(`${platform} binary is missing FMI symbols: ${missing.join(', ')}`);
  let runtime = null;

  if (target.os === 'win32') {
    const headers = runChecked('dumpbin.exe', ['/headers', binaryPath]);
    if (!/machine \(x64\)/i.test(headers)) throw new Error('win64 FMU binary is not PE x64.');
    const dependencies = runChecked('dumpbin.exe', ['/dependents', binaryPath]);
    const imported = [...dependencies.matchAll(/^\s+([A-Za-z0-9._-]+\.dll)\s*$/gmi)]
      .map((match) => match[1].toUpperCase());
    const unexpected = imported.filter((name) => name !== 'KERNEL32.DLL');
    if (unexpected.length) throw new Error(`win64 FMU binary has unexpected dependencies: ${unexpected.join(', ')}`);
    runtime = Object.freeze({ dependencies: Object.freeze(imported.sort()) });
  } else {
    const identity = runChecked('file', [binaryPath]);
    if (target.os === 'linux' && !/ELF 64-bit.*x86-64/i.test(identity)) {
      throw new Error(`linux64 FMU binary has the wrong architecture: ${identity.trim()}`);
    }
    if (target.os === 'darwin' && !new RegExp(`Mach-O 64-bit.*${target.architecture}`, 'i').test(identity)) {
      throw new Error(`${platform} FMU binary has the wrong architecture: ${identity.trim()}`);
    }
    if (target.os === 'linux') {
      const dependencies = runChecked('ldd', [binaryPath]);
      if (/not found/i.test(dependencies)) throw new Error(`linux64 FMU binary has unresolved dependencies:\n${dependencies}`);
      const versionInfo = runChecked('readelf', ['--version-info', binaryPath]);
      const glibcVersions = [...new Set(
        [...versionInfo.matchAll(/\bGLIBC_(\d+(?:\.\d+)+)\b/g)].map((match) => match[1]),
      )].sort(compareDottedVersions);
      const glibcMax = glibcVersions.at(-1) || null;
      if (maxGlibc && glibcMax && compareDottedVersions(glibcMax, maxGlibc) > 0) {
        throw new Error(`linux64 FMU requires GLIBC_${glibcMax}; ceiling is GLIBC_${maxGlibc}.`);
      }
      const imported = [...new Set(dependencies.trim().split(/\r?\n/).map((line) => {
        const name = line.trim().split(/\s+=>\s+|\s+\(/)[0];
        return name.startsWith('/') ? basename(name) : name;
      }).filter(Boolean))].sort();
      runtime = Object.freeze({
        dependencies: Object.freeze(imported),
        glibcVersions: Object.freeze(glibcVersions),
        glibcMax,
        enforcedGlibcCeiling: maxGlibc || null,
      });
    } else if (target.os === 'darwin') {
      const dependencies = runChecked('otool', ['-L', binaryPath]);
      const imported = dependencies.split(/\r?\n/).slice(1)
        .map((line) => line.trim().split(/\s+/)[0]).filter(Boolean);
      const unexpected = imported.filter((path) => !path.startsWith('/usr/lib/') && !path.startsWith('/System/Library/'));
      if (unexpected.length) throw new Error(`darwin64 FMU binary has unexpected dependencies: ${unexpected.join(', ')}`);
      runtime = Object.freeze({ dependencies: Object.freeze(imported) });
    }
  }
  return Object.freeze({
    platform,
    binaryPath,
    size: stat.size,
    sha256: sha256(readFileSync(binaryPath)),
    symbols: Object.freeze([...symbols].sort()),
    runtime,
  });
}

export function compileNativeBinary({
  tree, platform, compiler = null, reproducible = false, maxGlibc = null,
}) {
  const contract = readFmuContract(tree);
  const target = platformContract(platform);
  if (target.os !== process.platform) {
    throw new Error(`${platform} must be compiled on ${target.os}; this runner is ${process.platform}.`);
  }
  if (target.nodeArchitecture !== process.arch) {
    throw new Error(`${platform} must be compiled on ${target.nodeArchitecture}; this runner is ${process.arch}.`);
  }
  // Validate the source tree before creating build directories, and provide
  // the standards-defined resource location passed to fmi2Instantiate.
  walkFiles(contract.root);
  mkdirSync(join(contract.root, 'resources'), { recursive: true });
  const binaryPath = join(contract.root, 'binaries', platform,
    `${contract.modelIdentifier}${target.extension}`);
  const buildRoot = join(contract.root, '.fmu-build', platform);
  compileOnce({ contract, platform, compiler, outputPath: binaryPath, buildDirectory: join(buildRoot, 'primary') });
  const result = inspectNativeBinary({ tree: contract.root, platform, maxGlibc });
  if (reproducible) {
    const secondPath = join(buildRoot, 'repro', `${contract.modelIdentifier}${target.extension}`);
    compileOnce({ contract, platform, compiler, outputPath: secondPath, buildDirectory: join(buildRoot, 'repro') });
    const secondHash = sha256(readFileSync(secondPath));
    if (secondHash !== result.sha256) {
      throw new Error(`${platform} native build is not reproducible: ${result.sha256} != ${secondHash}`);
    }
  }
  writeInspectionRecord(contract, result);
  return result;
}

function inspectionRecordPath(root, platform) {
  return join(root, '.fmu-build', 'inspections', `${platform}.json`);
}

function writeInspectionRecord(contract, result) {
  const path = inspectionRecordPath(contract.root, result.platform);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({
    format: 'battery-design/fmi-native-inspection@1',
    fmiVersion: '2.0',
    modelIdentifier: contract.modelIdentifier,
    guid: contract.guid,
    platform: result.platform,
    size: result.size,
    sha256: result.sha256,
    requiredSymbols: FMI2_REQUIRED_CO_SIMULATION_SYMBOLS,
    exportedSymbols: result.symbols,
    runtime: result.runtime,
  }, null, 2)}\n`);
}

export function recordNativeInspection({ tree, platform, maxGlibc = null }) {
  const contract = readFmuContract(tree);
  const result = inspectNativeBinary({ tree: contract.root, platform, maxGlibc });
  writeInspectionRecord(contract, result);
  return result;
}

function verifiedPackagedBinaries(contract, { requiredPlatforms = [], maxGlibc = null } = {}) {
  const required = [...new Set(requiredPlatforms)];
  for (const platform of required) platformContract(platform);
  if (maxGlibc && !/^\d+\.\d+(?:\.\d+)*$/.test(maxGlibc)) {
    throw new Error(`Invalid GLIBC ceiling: ${maxGlibc}`);
  }
  const binaries = [];
  for (const [platform, target] of Object.entries(FMI2_NATIVE_PLATFORMS)) {
    const rel = `binaries/${platform}/${contract.modelIdentifier}${target.extension}`;
    const binaryPath = join(contract.root, ...rel.split('/'));
    if (!existsSync(binaryPath)) continue;
    requireRegularFile(binaryPath, `${platform} FMI binary`);
    const recordPath = inspectionRecordPath(contract.root, platform);
    requireRegularFile(recordPath, `${platform} native inspection record`);
    let record;
    try {
      record = JSON.parse(readFileSync(recordPath, 'utf8'));
    } catch (error) {
      throw new Error(`Invalid ${platform} native inspection record: ${error.message}`);
    }
    const digest = sha256(readFileSync(binaryPath));
    const expectedSymbols = [...FMI2_REQUIRED_CO_SIMULATION_SYMBOLS].sort();
    const recordedSymbols = Array.isArray(record.exportedSymbols) ? [...record.exportedSymbols].sort() : [];
    const recordedRequired = Array.isArray(record.requiredSymbols) ? [...record.requiredSymbols].sort() : [];
    if (record.format !== 'battery-design/fmi-native-inspection@1'
        || record.fmiVersion !== '2.0'
        || record.modelIdentifier !== contract.modelIdentifier
        || record.guid !== contract.guid
        || record.platform !== platform
        || record.size !== lstatSync(binaryPath).size
        || record.sha256 !== digest
        || JSON.stringify(recordedRequired) !== JSON.stringify(expectedSymbols)
        || JSON.stringify(recordedSymbols) !== JSON.stringify(expectedSymbols)) {
      throw new Error(`${platform} FMI binary does not match its native inspection record.`);
    }
    if (platform === 'linux64' && maxGlibc) {
      const observed = record.runtime?.glibcMax;
      const enforced = record.runtime?.enforcedGlibcCeiling;
      if (!observed || enforced !== maxGlibc || compareDottedVersions(observed, maxGlibc) > 0) {
        throw new Error(`linux64 FMI binary lacks a verified GLIBC_${maxGlibc} compatibility ceiling.`);
      }
    }
    if (target.os === process.platform && target.nodeArchitecture === process.arch) {
      const recordedCeiling = record.runtime?.enforcedGlibcCeiling || null;
      const inspected = inspectNativeBinary({
        tree: contract.root, platform, maxGlibc: recordedCeiling,
      });
      if (inspected.sha256 !== digest || JSON.stringify(inspected.runtime) !== JSON.stringify(record.runtime)) {
        throw new Error(`${platform} FMI binary changed or its runtime inspection record is inaccurate.`);
      }
    }
    binaries.push({
      platform,
      path: rel,
      sha256: digest,
      exportedSymbols: recordedSymbols,
      runtime: record.runtime || null,
    });
  }
  binaries.sort((a, b) => a.platform.localeCompare(b.platform, 'en'));
  if (!binaries.length) throw new Error('Cannot package a compiled FMU without a verified native binary.');
  const present = new Set(binaries.map((binary) => binary.platform));
  const missing = required.filter((platform) => !present.has(platform));
  if (missing.length) throw new Error(`FMU is missing required native platforms: ${missing.join(', ')}`);
  return binaries;
}

function walkFiles(root, current = root, out = []) {
  for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    const path = join(current, entry.name);
    const rel = relative(root, path).split(sep).join('/');
    if (entry.isDirectory() && (rel === '.fmu-build' || rel.startsWith('.fmu-build/'))) continue;
    safeRelativePath(rel, 'FMU archive path');
    if (entry.isSymbolicLink()) throw new Error(`FMU tree contains a symlink: ${rel}`);
    if (entry.isDirectory()) {
      walkFiles(root, path, out);
    } else if (entry.isFile()) {
      const stat = requireRegularFile(path, rel);
      out.push({ path, rel, stat });
    } else {
      throw new Error(`FMU tree contains a non-file entry: ${rel}`);
    }
  }
  return out;
}

function ensurePackageMetadata(contract, binaries) {
  const sourceRevision = process.env.BATTERY_DESIGN_SOURCE_REVISION || null;
  if (sourceRevision && !/^[a-f0-9]{40}$/.test(sourceRevision)) {
    throw new Error('BATTERY_DESIGN_SOURCE_REVISION must be a full lowercase Git SHA-1.');
  }
  const licenseDir = join(contract.root, 'documentation', 'licenses');
  mkdirSync(licenseDir, { recursive: true });
  copyFileSync(join(REPO_ROOT, 'LICENSE'), join(licenseDir, 'battery-design-AGPL-3.0.txt'));
  copyFileSync(join(REPO_ROOT, 'NOTICE'), join(licenseDir, 'battery-design-NOTICE.txt'));
  copyFileSync(join(STANDARD_ROOT, 'LICENSE-BSD-2-Clause.txt'),
    join(licenseDir, 'FMI-2.0.5-BSD-2-Clause.txt'));

  const sources = contract.sourceFiles.map((name, index) => ({
    path: `sources/${name}`,
    sha256: sha256(readFileSync(contract.sourcePaths[index])),
  }));
  const sourceGuide = join(contract.root, 'documentation', 'source-build.md');
  if (!existsSync(sourceGuide)) copyFileSync(join(contract.root, 'README.md'), sourceGuide);
  const platformList = binaries.map((binary) => `\`${binary.platform}\``).join(', ');
  writeFileSync(join(contract.root, 'README.md'), `# ${contract.modelIdentifier} — FMI 2.0 Co-Simulation FMU

This is a loadable battery-design FMU with native binaries for ${platformList}.
Import this \`.fmu\` file directly; an FMU is already a ZIP archive and does
not need an additional \`.zip\` suffix.

The component is a reduced system-level battery plant: linear OCV, R0, one RC
polarisation branch, Arrhenius resistance, reversible/irreversible heat and a
single lumped thermal node. Its exact scalar Real parameters, inputs, outputs,
units and defaults are declared in \`modelDescription.xml\`. The compiled
defaults and XML starts share the content GUID \`${contract.guid}\`.

Open-source ABI and lifecycle validation does not certify behavior inside a
specific proprietary product/version. Record an actual import-and-step check
before claiming acceptance in Twin Builder, Simulink or GT-SUITE. Source build
instructions are retained in \`documentation/source-build.md\`; license terms
are under \`documentation/licenses/\`.
`);
  const manifest = {
    format: 'battery-design/fmi-build-manifest@1',
    artifactKind: 'compiled-fmu',
    fmiVersion: '2.0',
    fmiStandardPatch: FMI_STANDARD_VERSION,
    modelRevision: FMU_MODEL_REVISION,
    sourceRevision,
    modelIdentifier: contract.modelIdentifier,
    guid: contract.guid,
    modelDescriptionSha256: sha256(readFileSync(contract.xmlPath)),
    sources,
    binaries,
  };
  const resources = join(contract.root, 'resources');
  mkdirSync(resources, { recursive: true });
  writeFileSync(join(resources, 'battery-design-build.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

export function auditFmuTree(tree, { requireBinaries = true } = {}) {
  const contract = readFmuContract(tree);
  const files = walkFiles(contract.root);
  if (files.length > MAX_FILES) throw new Error(`FMU has ${files.length} files; limit is ${MAX_FILES}.`);
  const total = files.reduce((sum, file) => sum + file.stat.size, 0);
  if (total > MAX_ARCHIVE_BYTES) throw new Error(`FMU tree is too large: ${total} bytes.`);
  const paths = new Set(files.map((file) => file.rel));
  const declared = new Set(contract.sourceFiles.map((name) => `sources/${name}`));
  const shippedC = [...paths].filter((path) => path.startsWith('sources/') && extname(path) === '.c');
  if (shippedC.length !== declared.size || shippedC.some((path) => !declared.has(path))) {
    throw new Error('Shipped C sources do not exactly match CoSimulation/SourceFiles.');
  }
  const binaries = [];
  for (const path of paths) {
    if (!path.startsWith('binaries/')) continue;
    const match = /^binaries\/([^/]+)\/([^/]+)$/.exec(path);
    if (!match) throw new Error(`Unexpected binary path: ${path}`);
    const target = platformContract(match[1]);
    const expected = `${contract.modelIdentifier}${target.extension}`;
    if (match[2] !== expected) throw new Error(`Binary/modelIdentifier mismatch: ${path}; expected ${expected}.`);
    binaries.push(match[1]);
  }
  if (requireBinaries && !binaries.length) throw new Error('A loadable FMU must contain at least one native binary.');
  for (const required of [
    'documentation/licenses/battery-design-AGPL-3.0.txt',
    'documentation/licenses/battery-design-NOTICE.txt',
    'documentation/licenses/FMI-2.0.5-BSD-2-Clause.txt',
    'resources/battery-design-build.json',
  ]) {
    if (!paths.has(required)) throw new Error(`FMU package metadata is missing ${required}.`);
  }
  return Object.freeze({
    ...contract,
    files: Object.freeze(files.map((file) => file.rel)),
    binaries: Object.freeze(binaries.sort()),
    totalBytes: total,
  });
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function deterministicZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.rel, 'utf8');
    const data = readFileSync(entry.path);
    if (data.length > 0xffffffff || offset > 0xffffffff) throw new Error('FMU exceeds ZIP32 limits.');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x0021, 12); // 1980-01-01, the ZIP epoch
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x0021, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(((entry.rel.startsWith('binaries/') ? 0o100755 : 0o100644) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, ...centralParts, end]);
}

export function packageFmu({ tree, output, requiredPlatforms = [], maxGlibc = null }) {
  const root = resolve(tree);
  const outputPath = resolve(output);
  if (outputPath === root || outputPath.startsWith(`${root}${sep}`)) {
    throw new Error('Write the .fmu outside its source tree so it cannot package itself.');
  }
  const contract = readFmuContract(root);
  // Reject symlinks and unsafe tree entries before creating or copying any
  // metadata, then bind every binary to a native-runner inspection record.
  walkFiles(root);
  const binaries = verifiedPackagedBinaries(contract, { requiredPlatforms, maxGlibc });
  ensurePackageMetadata(contract, binaries);
  const audit = auditFmuTree(root);
  const entries = walkFiles(root).sort((a, b) => Buffer.from(a.rel).compare(Buffer.from(b.rel)));
  const archive = deterministicZip(entries);
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, archive);
  return Object.freeze({
    outputPath,
    size: archive.length,
    sha256: sha256(archive),
    files: audit.files,
    binaries: audit.binaries,
    modelIdentifier: audit.modelIdentifier,
    guid: audit.guid,
  });
}

function parseCli(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    if (!token.startsWith('--')) throw new Error(`Unexpected argument: ${token}`);
    const key = token.slice(2);
    if (key === 'reproducible' || key === 'record') options[key] = true;
    else {
      if (i + 1 >= rest.length || rest[i + 1].startsWith('--')) throw new Error(`Missing value for ${token}.`);
      options[key] = rest[++i];
    }
  }
  return { command, options };
}

async function main() {
  const { command, options } = parseCli(process.argv.slice(2));
  if (command === 'compile') {
    if (!options.tree || !options.platform) throw new Error('Usage: fmu-build.mjs compile --tree DIR --platform linux64 [--compiler cc] [--max-glibc 2.17] [--reproducible]');
    console.log(JSON.stringify(compileNativeBinary({
      tree: options.tree,
      platform: options.platform,
      compiler: options.compiler || null,
      reproducible: Boolean(options.reproducible),
      maxGlibc: options['max-glibc'] || null,
    }), null, 2));
    return;
  }
  if (command === 'package') {
    if (!options.tree || !options.output) throw new Error('Usage: fmu-build.mjs package --tree DIR --output battery-design-ev.fmu [--require-platforms linux64,win64] [--max-glibc 2.17]');
    const requiredPlatforms = options['require-platforms']
      ? options['require-platforms'].split(',').filter(Boolean) : [];
    console.log(JSON.stringify(packageFmu({
      tree: options.tree,
      output: options.output,
      requiredPlatforms,
      maxGlibc: options['max-glibc'] || null,
    }), null, 2));
    return;
  }
  if (command === 'inspect') {
    if (!options.tree || !options.platform) throw new Error('Usage: fmu-build.mjs inspect --tree DIR --platform linux64 [--max-glibc 2.17] [--record]');
    const inspection = {
      tree: options.tree,
      platform: options.platform,
      maxGlibc: options['max-glibc'] || null,
    };
    console.log(JSON.stringify(options.record
      ? recordNativeInspection(inspection)
      : inspectNativeBinary(inspection), null, 2));
    return;
  }
  throw new Error('Usage: fmu-build.mjs <compile|package|inspect> ...');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`FMU build failed: ${error.message}`);
    process.exitCode = 1;
  });
}

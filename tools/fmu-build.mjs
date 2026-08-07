#!/usr/bin/env node
// Reproducible FMI 2.0 native build and archive assembly.
//
// Source generation stays in js/fmi.js / desktop/bd.mjs. This tool consumes
// that one canonical tree, compiles its declared source files with the pinned
// standard headers, verifies the ABI, and writes a deterministic .fmu ZIP.

import { createHash } from 'node:crypto';
import {
  existsSync, lstatSync, mkdirSync, readFileSync, readdirSync,
  realpathSync, writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import {
  basename, dirname, extname, join, relative, resolve, sep,
} from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  fmuGuid, fmuSourceC, modelDescriptionXml,
  FMI2_REQUIRED_CO_SIMULATION_SYMBOLS, FMI_IO_CONTRACT, FMI_IO_CONTRACT_CHECKSUM,
  FMI_IO_CONTRACT_FORMAT, FMI_IO_CONTRACT_VERSION, FMI_STANDARD_VERSION,
  FMI_UNIT_DEFINITIONS, FMI_VERSION, FMU_MODEL_REVISION, materializeFmiIoMap,
} from '../js/fmi.js';
import {
  FMI_DESIGN_RESOURCE_FORMAT, verifyFmiDesignResource,
} from '../js/fmi-export-snapshot.js';
import { canonicalJson } from '../js/ontology.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STANDARD_ROOT = join(REPO_ROOT, 'third_party', `fmi-${FMI_STANDARD_VERSION}`);
const STANDARD_HEADERS = join(STANDARD_ROOT, 'headers');
const MAX_FILES = 256;
const MAX_FILE_BYTES = 128 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;
const DESIGN_RESOURCE_PATH = 'resources/battery-design-design.json';
const IO_MAP_PATH = 'resources/battery-design-io-map.json';
const BUILD_MANIFEST_PATH = 'resources/battery-design-build.json';
const NATIVE_INSPECTION_FORMAT = 'battery-design/fmi-native-inspection@1';
const NATIVE_CONTRACT_EVIDENCE_FORMAT = 'battery-design/fmi-native-contract-evidence@1';

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

function assertExactKeys(value, keys, label) {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} fields are not exact: ${actual.join(', ')}.`);
  }
}

function sameCanonical(actual, expected) {
  return canonicalJson(actual) === canonicalJson(expected);
}

function sourceRevisionFromEnvironment() {
  const sourceRevision = process.env.BATTERY_DESIGN_SOURCE_REVISION || null;
  if (sourceRevision && !/^[a-f0-9]{40}$/.test(sourceRevision)) {
    throw new Error('BATTERY_DESIGN_SOURCE_REVISION must be a full lowercase Git SHA-1.');
  }
  return sourceRevision;
}

function validateSourceRevision(value, label) {
  if (value !== null && (typeof value !== 'string' || !/^[a-f0-9]{40}$/.test(value))) {
    throw new Error(`${label} must be null or a full lowercase Git SHA-1.`);
  }
  return value;
}

function sourceRevisionTrust(manifestValue, expectedSourceRevision, requireVerified) {
  const value = validateSourceRevision(manifestValue, 'FMU build manifest sourceRevision');
  let expected;
  let basis;
  if (expectedSourceRevision !== undefined) {
    expected = validateSourceRevision(expectedSourceRevision, 'expectedSourceRevision');
    basis = 'explicit-expected';
  } else if (process.env.BATTERY_DESIGN_SOURCE_REVISION) {
    expected = sourceRevisionFromEnvironment();
    basis = 'environment';
  } else {
    const trust = Object.freeze({
      value,
      verified: false,
      basis: value == null ? 'no-claim' : 'unverified-manifest-claim',
    });
    if (requireVerified) {
      throw new Error('FMU sourceRevision verification requires expectedSourceRevision or BATTERY_DESIGN_SOURCE_REVISION.');
    }
    return trust;
  }
  if (value !== expected) {
    throw new Error(`FMU build manifest sourceRevision does not match ${basis}.`);
  }
  if (expected == null) {
    if (requireVerified) {
      throw new Error('A null sourceRevision is no provenance claim and cannot satisfy verified source revision policy.');
    }
    return Object.freeze({ value: null, verified: false, basis: 'no-claim' });
  }
  return Object.freeze({ value, verified: true, basis });
}

function projectedRealPath(path) {
  let cursor = path;
  const suffix = [];
  while (!existsSync(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor) break;
    suffix.unshift(basename(cursor));
    cursor = parent;
  }
  return resolve(realpathSync(cursor), ...suffix);
}

function assertSafeOutputPath(root, outputPath) {
  const realRoot = realpathSync(root);
  let outputStat = null;
  try {
    outputStat = lstatSync(outputPath);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  if (outputStat?.isSymbolicLink()) {
    throw new Error('FMU output must not be a symbolic link.');
  }
  if (outputStat && !outputStat.isFile()) {
    throw new Error('Existing FMU output must be a regular file.');
  }
  if (outputStat && outputStat.nlink > 1) {
    throw new Error('FMU output must not be a hard-linked file.');
  }
  const realOutput = projectedRealPath(outputPath);
  if (realOutput === realRoot || realOutput.startsWith(`${realRoot}${sep}`)) {
    throw new Error('Write the .fmu outside its source tree so it cannot package itself.');
  }
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

const xmlAttributes = (text) => Object.fromEntries(
  [...text.matchAll(/([A-Za-z_][A-Za-z0-9_.:-]*)="([^"]*)"/g)]
    .map((match) => [match[1], xmlUnescape(match[2])]),
);

const sameAttributes = (actual, expected) => {
  const sorted = (value) => Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b, 'en')));
  return JSON.stringify(sorted(actual)) === JSON.stringify(sorted(expected));
};

function readPackagedIoMap(contract) {
  const path = join(contract.root, ...IO_MAP_PATH.split('/'));
  requireRegularFile(path, 'FMI I/O map');
  let ioMap;
  try {
    ioMap = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`Invalid FMI I/O map JSON: ${error.message}`);
  }
  if (ioMap.format !== FMI_IO_CONTRACT_FORMAT
      || ioMap.version !== FMI_IO_CONTRACT_VERSION
      || ioMap.fmiVersion !== '2.0'
      || ioMap.fmiStandardPatch !== FMI_STANDARD_VERSION
      || ioMap.contractChecksum !== FMI_IO_CONTRACT_CHECKSUM
      || ioMap.modelName !== contract.modelIdentifier
      || ioMap.modelIdentifier !== contract.modelIdentifier
      || ioMap.modelRevision !== FMU_MODEL_REVISION
      || ioMap.guid !== contract.guid
      || JSON.stringify(ioMap.unitDefinitions) !== JSON.stringify(FMI_UNIT_DEFINITIONS)
      || !Array.isArray(ioMap.variables)
      || ioMap.variables.length !== FMI_IO_CONTRACT.length) {
    throw new Error('FMI I/O map identity does not match the modelDescription contract.');
  }

  const parameterValues = Object.fromEntries(FMI_IO_CONTRACT
    .filter(({ causality }) => causality === 'parameter')
    .map(({ name }) => [name, ioMap.variables.find((variable) => variable?.name === name)?.start]));
  let expectedMap;
  try {
    expectedMap = materializeFmiIoMap({
      parameterValues,
      modelName: contract.modelIdentifier,
      modelRevision: FMU_MODEL_REVISION,
      guid: contract.guid,
      fmiStandardVersion: FMI_STANDARD_VERSION,
    });
  } catch (error) {
    throw new Error(`FMI I/O map cannot be materialized from its parameter starts: ${error.message}`);
  }
  if (JSON.stringify(ioMap) !== JSON.stringify(expectedMap)) {
    throw new Error('FMI I/O map is not the exact canonical materialization for this component.');
  }

  const unitSection = /<UnitDefinitions>([\s\S]*?)<\/UnitDefinitions>/.exec(contract.xml)?.[1] ?? '';
  const unitPattern = /<Unit\b([^>]*)>([\s\S]*?)<\/Unit>/g;
  const unitBlocks = [...unitSection.matchAll(unitPattern)];
  if (unitBlocks.length !== FMI_UNIT_DEFINITIONS.length
      || unitSection.replace(unitPattern, '').trim()) {
    throw new Error('modelDescription.xml UnitDefinitions do not match the FMI I/O map.');
  }
  for (let index = 0; index < FMI_UNIT_DEFINITIONS.length; index++) {
    const expectedUnit = FMI_UNIT_DEFINITIONS[index];
    const [, unitAttributes, unitBody] = unitBlocks[index];
    const base = /<BaseUnit\b([^>]*)\/>/.exec(unitBody);
    const displayPattern = /<DisplayUnit\b([^>]*)\/>/g;
    const displays = [...unitBody.matchAll(displayPattern)].map((match) => xmlAttributes(match[1]));
    const expectedDisplays = expectedUnit.displayUnits.map((display) => Object.fromEntries(
      Object.entries(display).map(([key, value]) => [key, String(value)]),
    ));
    const bodyRemainder = unitBody
      .replace(/<BaseUnit\b[^>]*\/>/, '')
      .replace(displayPattern, '').trim();
    const expectedBase = Object.fromEntries(Object.entries(expectedUnit.baseUnit)
      .map(([key, value]) => [key, String(value)]));
    if (!base || bodyRemainder
        || !sameAttributes(xmlAttributes(unitAttributes), { name: expectedUnit.name })
        || !sameAttributes(xmlAttributes(base[1]), expectedBase)
        || JSON.stringify(displays) !== JSON.stringify(expectedDisplays)) {
      throw new Error(`modelDescription.xml unit ${expectedUnit.name} does not match the FMI I/O map.`);
    }
  }

  const scalarBlocks = [...contract.xml.matchAll(/<ScalarVariable\b([^>]*)>([\s\S]*?)<\/ScalarVariable>/g)];
  if (scalarBlocks.length !== FMI_IO_CONTRACT.length) {
    throw new Error('modelDescription.xml scalar count does not match the FMI I/O map.');
  }
  for (let index = 0; index < FMI_IO_CONTRACT.length; index++) {
    const canonical = FMI_IO_CONTRACT[index];
    const mapped = ioMap.variables[index];
    const [, scalarAttributes, body] = scalarBlocks[index];
    const real = /^\s*<Real\b([^>]*)\/>\s*$/.exec(body);
    const expectedScalarAttributes = {
      name: canonical.name,
      valueReference: String(canonical.valueReference),
      causality: canonical.causality,
      variability: canonical.variability,
      ...(canonical.initial == null ? {} : { initial: canonical.initial }),
      description: canonical.description,
    };
    const expectedRealAttributes = {
      ...(canonical.causality === 'output' ? {} : { start: String(mapped.start) }),
      unit: canonical.unit,
      ...(canonical.displayUnit == null ? {} : { displayUnit: canonical.displayUnit }),
      quantity: canonical.quantity,
      ...(canonical.min == null ? {} : { min: String(canonical.min) }),
      ...(canonical.max == null ? {} : { max: String(canonical.max) }),
      ...(canonical.nominal == null ? {} : { nominal: String(canonical.nominal) }),
    };
    if (!real
        || !sameAttributes(xmlAttributes(scalarAttributes), expectedScalarAttributes)
        || !sameAttributes(xmlAttributes(real[1]), expectedRealAttributes)) {
      throw new Error(`modelDescription.xml variable ${index + 1} does not match the FMI I/O map.`);
    }
  }

  const expectedOutputIndices = FMI_IO_CONTRACT
    .map((variable, index) => ({ variable, index: index + 1 }))
    .filter(({ variable }) => variable.causality === 'output')
    .map(({ index }) => String(index));
  for (const section of ['Outputs', 'InitialUnknowns']) {
    const block = new RegExp(`<${section}>([\\s\\S]*?)<\\/${section}>`).exec(contract.xml)?.[1] ?? '';
    const indices = [...block.matchAll(/<Unknown\s+index="(\d+)"\s*\/>/g)].map((match) => match[1]);
    if (JSON.stringify(indices) !== JSON.stringify(expectedOutputIndices)
        || block.replace(/<Unknown\s+index="\d+"\s*\/>/g, '').trim()) {
      throw new Error(`modelDescription.xml ${section} do not match the FMI I/O map.`);
    }
  }
  const generationDates = [...contract.xml.matchAll(/\bgenerationDateAndTime="([^"]*)"/g)];
  if (generationDates.length !== 1) {
    throw new Error('modelDescription.xml must declare exactly one generationDateAndTime.');
  }
  const generatedOn = xmlUnescape(generationDates[0][1]);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(generatedOn)
      || !Number.isFinite(Date.parse(generatedOn))) {
    throw new Error('modelDescription.xml generationDateAndTime must be a valid ISO 8601 timestamp.');
  }
  const expectedXml = modelDescriptionXml({
    defaults: parameterValues,
    modelName: contract.modelIdentifier,
    guid: contract.guid,
    generatedOn,
  });
  if (contract.xml !== expectedXml) {
    throw new Error('modelDescription.xml is not the exact canonical FMI contract generated for this component.');
  }
  return Object.freeze({ path, sha256: sha256(readFileSync(path)), map: ioMap });
}

function parameterDefaultsFromIoMap(ioContract) {
  return Object.freeze(Object.fromEntries(ioContract.map.variables
    .filter(({ causality }) => causality === 'parameter')
    .map(({ name, start }) => [name, start])));
}

function contractStartsFromIoMap(ioContract) {
  return Object.freeze(ioContract.map.variables
    .filter(({ causality, start }) => ['parameter', 'input'].includes(causality) && start != null)
    .map(({ name, valueReference, causality, start }) => Object.freeze({
      name, valueReference, causality, start,
    })));
}

function readPackagedSourceContract(contract, ioContract) {
  const expectedFiles = [`${contract.modelIdentifier}.c`];
  if (JSON.stringify(contract.sourceFiles) !== JSON.stringify(expectedFiles)) {
    throw new Error(`CoSimulation SourceFiles must exactly declare ${expectedFiles[0]}.`);
  }
  const defaults = parameterDefaultsFromIoMap(ioContract);
  const expected = fmuSourceC({
    modelName: contract.modelIdentifier,
    guid: contract.guid,
    defaults,
  });
  const actual = readFileSync(contract.sourcePaths[0], 'utf8');
  if (actual !== expected) {
    throw new Error('Generated FMI C source does not exactly match the XML GUID, I/O defaults, and canonical source contract.');
  }
  const sources = Object.freeze([Object.freeze({
    path: `sources/${expectedFiles[0]}`,
    sha256: sha256(Buffer.from(actual)),
  })]);
  return Object.freeze({
    defaults,
    sources,
    checksum: sha256(canonicalJson({
      modelIdentifier: contract.modelIdentifier,
      guid: contract.guid,
      sources,
    })),
  });
}

function designResourceManifestEntry(resource, digest) {
  const binding = resource.snapshot.source.binding;
  return {
    path: DESIGN_RESOURCE_PATH,
    format: FMI_DESIGN_RESOURCE_FORMAT,
    snapshotChecksum: resource.snapshotChecksum,
    sha256: digest,
    complete: resource.snapshot.source.complete,
    binding: binding == null ? null : Object.freeze({
      format: binding.format,
      specSchemaVersion: binding.specSchemaVersion,
      specChecksum: binding.specChecksum,
      semanticChecksum: binding.semanticChecksum,
      designChecksum: binding.designChecksum,
    }),
  };
}

function readPackagedDesignResource(contract, ioContract, { requireComplete = false } = {}) {
  const path = join(contract.root, ...DESIGN_RESOURCE_PATH.split('/'));
  requireRegularFile(path, 'FMI design resource');
  const bytes = readFileSync(path);
  let parsed;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    throw new Error(`Invalid FMI design resource JSON: ${error.message}`);
  }
  const defaults = parameterDefaultsFromIoMap(ioContract);
  let resource;
  try {
    resource = verifyFmiDesignResource(parsed, {
      guid: contract.guid,
      modelIdentifier: contract.modelIdentifier,
      ioContractChecksum: FMI_IO_CONTRACT_CHECKSUM,
      modelRevision: FMU_MODEL_REVISION,
      fmiVersion: FMI_VERSION,
      fmiStandardVersion: FMI_STANDARD_VERSION,
      defaults,
      requireComplete,
    });
  } catch (error) {
    throw new Error(`Invalid FMI design resource contract: ${error.message}`);
  }
  const expectedGuid = fmuGuid({
    cell: resource.snapshot.cell.id == null ? null : { id: resource.snapshot.cell.id },
    defaults,
    modelName: contract.modelIdentifier,
    designSnapshotChecksum: resource.snapshotChecksum,
  });
  if (expectedGuid !== contract.guid) {
    throw new Error('FMI design resource snapshot does not reproduce the component GUID.');
  }
  const digest = sha256(bytes);
  return Object.freeze({
    path,
    sha256: digest,
    resource,
    manifestEntry: Object.freeze(designResourceManifestEntry(resource, digest)),
  });
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

function nativeTargetIsCurrent(platform) {
  const target = platformContract(platform);
  return target.os === process.platform && target.nodeArchitecture === process.arch;
}

function expectedNativeContractEvidence({ contract, platform, result, ioContract, sourceContract }) {
  const starts = contractStartsFromIoMap(ioContract);
  const body = {
    format: NATIVE_CONTRACT_EVIDENCE_FORMAT,
    fmiVersion: '2.0',
    modelIdentifier: contract.modelIdentifier,
    guid: contract.guid,
    platform,
    binarySha256: result.sha256,
    sourceContractChecksum: sourceContract.checksum,
    ioContractChecksum: ioContract.map.contractChecksum,
    starts,
    startsChecksum: sha256(canonicalJson(starts)),
    contractStartsChecked: starts.length,
  };
  return Object.freeze({
    ...body,
    evidenceChecksum: sha256(canonicalJson(body)),
  });
}

function runNativeContractProbe({ contract, platform, result, ioContract, sourceContract }) {
  if (!nativeTargetIsCurrent(platform)) {
    throw new Error(`${platform} native contract evidence must be recorded on its target runner.`);
  }
  const python = process.env.BATTERY_DESIGN_PYTHON
    || (process.platform === 'win32' ? 'python' : 'python3');
  const probe = spawnSync(python, [
    join(REPO_ROOT, 'tools', 'fmu-smoke.py'), contract.root, '--platform', platform,
  ], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
  if (probe.error || probe.status !== 0) {
    throw new Error(`Native FMI GUID/default probe failed for ${platform}:\n${probe.stdout || ''}${probe.stderr || probe.error?.message || ''}`);
  }
  let observed;
  try {
    observed = JSON.parse(probe.stdout);
  } catch (error) {
    throw new Error(`Native FMI GUID/default probe returned invalid JSON for ${platform}: ${error.message}`);
  }
  const expectedStarts = contractStartsFromIoMap(ioContract);
  if (observed.modelIdentifier !== contract.modelIdentifier
      || observed.guid !== contract.guid
      || observed.platform !== platform
      || observed.contractStartsChecked !== expectedStarts.length) {
    throw new Error(`${platform} native contract probe does not match the XML/I/O contract.`);
  }
  return expectedNativeContractEvidence({ contract, platform, result, ioContract, sourceContract });
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
  assertSafeInternalBuildTree(contract.root);
  const ioContract = readPackagedIoMap(contract);
  const sourceContract = readPackagedSourceContract(contract, ioContract);
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
  const contractEvidence = runNativeContractProbe({
    contract, platform, result, ioContract, sourceContract,
  });
  writeInspectionRecord(contract, result, contractEvidence);
  return result;
}

function inspectionRecordPath(root, platform) {
  return join(root, '.fmu-build', 'inspections', `${platform}.json`);
}

function writeInspectionRecord(contract, result, contractEvidence) {
  assertSafeInternalBuildTree(contract.root);
  const path = inspectionRecordPath(contract.root, result.platform);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({
    format: NATIVE_INSPECTION_FORMAT,
    fmiVersion: '2.0',
    modelIdentifier: contract.modelIdentifier,
    guid: contract.guid,
    platform: result.platform,
    size: result.size,
    sha256: result.sha256,
    requiredSymbols: FMI2_REQUIRED_CO_SIMULATION_SYMBOLS,
    exportedSymbols: result.symbols,
    runtime: result.runtime,
    contractEvidence,
  }, null, 2)}\n`);
}

export function recordNativeInspection({ tree, platform, maxGlibc = null }) {
  const contract = readFmuContract(tree);
  assertSafeInternalBuildTree(contract.root);
  const ioContract = readPackagedIoMap(contract);
  const sourceContract = readPackagedSourceContract(contract, ioContract);
  const result = inspectNativeBinary({ tree: contract.root, platform, maxGlibc });
  const contractEvidence = runNativeContractProbe({
    contract, platform, result, ioContract, sourceContract,
  });
  writeInspectionRecord(contract, result, contractEvidence);
  return result;
}

function validateRecordedRuntime(platform, runtime) {
  if (runtime == null || typeof runtime !== 'object' || Array.isArray(runtime)) {
    throw new Error(`${platform} native inspection runtime evidence must be an object.`);
  }
  if (platform === 'linux64') {
    assertExactKeys(runtime, [
      'dependencies', 'glibcVersions', 'glibcMax', 'enforcedGlibcCeiling',
    ], `${platform} native inspection runtime`);
    if (!Array.isArray(runtime.dependencies) || !Array.isArray(runtime.glibcVersions)
        || (runtime.glibcMax != null && typeof runtime.glibcMax !== 'string')
        || (runtime.enforcedGlibcCeiling != null && typeof runtime.enforcedGlibcCeiling !== 'string')) {
      throw new Error(`${platform} native inspection runtime evidence is malformed.`);
    }
  } else {
    assertExactKeys(runtime, ['dependencies'], `${platform} native inspection runtime`);
    if (!Array.isArray(runtime.dependencies)) {
      throw new Error(`${platform} native inspection dependencies must be an array.`);
    }
  }
}

function verifiedPackagedBinaries(contract, {
  ioContract, sourceContract, requiredPlatforms = [], maxGlibc = null,
} = {}) {
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
    assertExactKeys(record, [
      'format', 'fmiVersion', 'modelIdentifier', 'guid', 'platform', 'size', 'sha256',
      'requiredSymbols', 'exportedSymbols', 'runtime', 'contractEvidence',
    ], `${platform} native inspection record`);
    validateRecordedRuntime(platform, record.runtime);
    const evidenceExpected = expectedNativeContractEvidence({
      contract,
      platform,
      result: { sha256: digest },
      ioContract,
      sourceContract,
    });
    if (record.format !== NATIVE_INSPECTION_FORMAT
        || record.fmiVersion !== '2.0'
        || record.modelIdentifier !== contract.modelIdentifier
        || record.guid !== contract.guid
        || record.platform !== platform
        || record.size !== lstatSync(binaryPath).size
        || record.sha256 !== digest
        || JSON.stringify(record.requiredSymbols) !== JSON.stringify(FMI2_REQUIRED_CO_SIMULATION_SYMBOLS)
        || JSON.stringify(record.exportedSymbols) !== JSON.stringify(expectedSymbols)
        || !sameCanonical(record.contractEvidence, evidenceExpected)) {
      throw new Error(`${platform} FMI binary does not match its native inspection record.`);
    }
    if (platform === 'linux64' && maxGlibc) {
      const observed = record.runtime?.glibcMax;
      const enforced = record.runtime?.enforcedGlibcCeiling;
      if (!observed || enforced !== maxGlibc || compareDottedVersions(observed, maxGlibc) > 0) {
        throw new Error(`linux64 FMI binary lacks a verified GLIBC_${maxGlibc} compatibility ceiling.`);
      }
    }
    if (nativeTargetIsCurrent(platform)) {
      const recordedCeiling = record.runtime?.enforcedGlibcCeiling || null;
      const inspected = inspectNativeBinary({
        tree: contract.root, platform, maxGlibc: recordedCeiling,
      });
      if (inspected.sha256 !== digest || JSON.stringify(inspected.runtime) !== JSON.stringify(record.runtime)) {
        throw new Error(`${platform} FMI binary changed or its runtime inspection record is inaccurate.`);
      }
      const observedEvidence = runNativeContractProbe({
        contract, platform, result: inspected, ioContract, sourceContract,
      });
      if (!sameCanonical(observedEvidence, record.contractEvidence)) {
        throw new Error(`${platform} FMI binary GUID/default evidence does not match its inspection record.`);
      }
    }
    binaries.push({
      platform,
      path: rel,
      sha256: digest,
      exportedSymbols: record.exportedSymbols,
      runtime: record.runtime,
      contractEvidence: record.contractEvidence,
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
      if (stat.nlink > 1) throw new Error(`FMU tree contains a hard-linked file: ${rel}`);
      out.push({ path, rel, stat });
    } else {
      throw new Error(`FMU tree contains a non-file entry: ${rel}`);
    }
  }
  return out;
}

function assertSafeInternalBuildTree(root, current = join(root, '.fmu-build')) {
  let currentStat;
  try {
    currentStat = lstatSync(current);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  if (currentStat.isSymbolicLink() || !currentStat.isDirectory()) {
    throw new Error(`Internal FMU build path must be a real directory: ${current}`);
  }
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const path = join(current, entry.name);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error(`Internal FMU build tree contains a symlink: ${path}`);
    if (stat.isDirectory()) {
      assertSafeInternalBuildTree(root, path);
    } else if (!stat.isFile()) {
      throw new Error(`Internal FMU build tree contains a non-file entry: ${path}`);
    } else if (stat.nlink > 1) {
      throw new Error(`Internal FMU build tree contains a hard-linked file: ${path}`);
    }
  }
}

function discoverPackagedBinaries(contract, files) {
  const binaries = [];
  for (const file of files) {
    if (!file.rel.startsWith('binaries/')) continue;
    const match = /^binaries\/([^/]+)\/([^/]+)$/.exec(file.rel);
    if (!match) throw new Error(`Unexpected binary path: ${file.rel}`);
    const target = platformContract(match[1]);
    const expectedName = `${contract.modelIdentifier}${target.extension}`;
    if (match[2] !== expectedName) {
      throw new Error(`Binary/modelIdentifier mismatch: ${file.rel}; expected ${expectedName}.`);
    }
    binaries.push(Object.freeze({ platform: match[1], path: file.rel }));
  }
  binaries.sort((a, b) => Buffer.from(a.path).compare(Buffer.from(b.path)));
  return Object.freeze(binaries);
}

function expectedCorePaths(contract, binaries) {
  return Object.freeze([
    'README.md',
    'modelDescription.xml',
    ...contract.sourceFiles.map((name) => `sources/${name}`),
    IO_MAP_PATH,
    DESIGN_RESOURCE_PATH,
    ...binaries.map(({ path }) => path),
  ]);
}

function expectedFinalPaths(contract, binaries) {
  return Object.freeze([
    ...expectedCorePaths(contract, binaries),
    'documentation/source-build.md',
    'documentation/licenses/battery-design-AGPL-3.0.txt',
    'documentation/licenses/battery-design-NOTICE.txt',
    'documentation/licenses/FMI-2.0.5-BSD-2-Clause.txt',
    BUILD_MANIFEST_PATH,
  ]);
}

function assertExactArchivePaths(files, expectedPaths, label) {
  const actual = new Set(files.map(({ rel }) => rel));
  const expected = new Set(expectedPaths);
  const unexpected = [...actual].filter((path) => !expected.has(path)).sort();
  const missing = [...expected].filter((path) => !actual.has(path)).sort();
  if (unexpected.length || missing.length) {
    throw new Error(`${label} path set is not exact; unexpected: ${unexpected.join(', ') || 'none'}; missing: ${missing.join(', ') || 'none'}.`);
  }
}

function packageFileInventory(files) {
  return Object.freeze(files
    .filter(({ rel }) => rel !== BUILD_MANIFEST_PATH)
    .sort((a, b) => Buffer.from(a.rel).compare(Buffer.from(b.rel)))
    .map(({ path, rel, stat }) => Object.freeze({
      path: rel,
      size: stat.size,
      sha256: sha256(readFileSync(path)),
    })));
}

function buildManifestFor({
  contract, sourceRevision, ioContract, designResource, sourceContract, binaries, packageFiles,
}) {
  return {
    format: 'battery-design/fmi-build-manifest@1',
    artifactKind: 'compiled-fmu',
    fmiVersion: '2.0',
    fmiStandardPatch: FMI_STANDARD_VERSION,
    modelRevision: FMU_MODEL_REVISION,
    sourceRevision,
    modelIdentifier: contract.modelIdentifier,
    guid: contract.guid,
    ioContract: {
      path: IO_MAP_PATH,
      version: ioContract.map.version,
      checksum: ioContract.map.contractChecksum,
      sha256: ioContract.sha256,
    },
    designResource: designResource.manifestEntry,
    modelDescriptionSha256: sha256(readFileSync(contract.xmlPath)),
    sources: sourceContract.sources,
    binaries,
    packageFiles,
  };
}

function preparePackageMetadata({
  contract, sourceRevision, ioContract, designResource, sourceContract, binaries,
}) {
  const sourceGuide = join(contract.root, 'documentation', 'source-build.md');
  const sourceGuideContent = existsSync(sourceGuide)
    ? null : readFileSync(join(contract.root, 'README.md'));
  const platformList = binaries.map((binary) => `\`${binary.platform}\``).join(', ');
  const readme = `# ${contract.modelIdentifier} — FMI 2.0 Co-Simulation FMU

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
are under \`documentation/licenses/\`. The versioned, machine-readable port
contract is \`resources/battery-design-io-map.json\`.
The immutable physical/layout provenance bound to this component is
\`${DESIGN_RESOURCE_PATH}\`.
`;
  return Object.freeze({
    sourceGuide,
    sourceGuideContent,
    readme,
    manifestInputs: Object.freeze({
      contract, sourceRevision, ioContract, designResource, sourceContract, binaries,
    }),
    licenses: Object.freeze({
      'battery-design-AGPL-3.0.txt': readFileSync(join(REPO_ROOT, 'LICENSE')),
      'battery-design-NOTICE.txt': readFileSync(join(REPO_ROOT, 'NOTICE')),
      'FMI-2.0.5-BSD-2-Clause.txt': readFileSync(join(STANDARD_ROOT, 'LICENSE-BSD-2-Clause.txt')),
    }),
  });
}

function writePackageMetadata(contract, prepared) {
  const licenseDir = join(contract.root, 'documentation', 'licenses');
  mkdirSync(licenseDir, { recursive: true });
  for (const [name, bytes] of Object.entries(prepared.licenses)) {
    writeFileSync(join(licenseDir, name), bytes);
  }
  if (prepared.sourceGuideContent != null) {
    mkdirSync(dirname(prepared.sourceGuide), { recursive: true });
    writeFileSync(prepared.sourceGuide, prepared.sourceGuideContent);
  }
  writeFileSync(join(contract.root, 'README.md'), prepared.readme);
  const resources = join(contract.root, 'resources');
  mkdirSync(resources, { recursive: true });
  const packageFiles = packageFileInventory(walkFiles(contract.root));
  const manifest = buildManifestFor({ ...prepared.manifestInputs, packageFiles });
  writeFileSync(join(contract.root, ...BUILD_MANIFEST_PATH.split('/')),
    `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

export function auditFmuTree(tree, {
  requireBinaries = true,
  requireCompleteDesign = false,
  expectedSourceRevision = undefined,
  requireVerifiedSourceRevision = false,
} = {}) {
  const contract = readFmuContract(tree);
  assertSafeInternalBuildTree(contract.root);
  const ioContract = readPackagedIoMap(contract);
  const designResource = readPackagedDesignResource(contract, ioContract, {
    requireComplete: requireCompleteDesign,
  });
  const sourceContract = readPackagedSourceContract(contract, ioContract);
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
  const binaryEntries = discoverPackagedBinaries(contract, files);
  const binaryPlatforms = binaryEntries.map(({ platform }) => platform);
  if (requireBinaries && !binaryPlatforms.length) throw new Error('A loadable FMU must contain at least one native binary.');
  assertExactArchivePaths(files, expectedFinalPaths(contract, binaryEntries), 'FMU package');
  let buildManifest;
  let buildManifestText;
  try {
    buildManifestText = readFileSync(join(contract.root, ...BUILD_MANIFEST_PATH.split('/')), 'utf8');
    buildManifest = JSON.parse(buildManifestText);
  } catch (error) {
    throw new Error(`Invalid FMU build manifest: ${error.message}`);
  }
  const sourceRevision = buildManifest?.sourceRevision;
  const revisionTrust = sourceRevisionTrust(
    sourceRevision, expectedSourceRevision, requireVerifiedSourceRevision,
  );
  const verifiedBinaries = binaryPlatforms.length ? verifiedPackagedBinaries(contract, {
    ioContract,
    sourceContract,
    requiredPlatforms: binaryPlatforms,
  }) : [];
  const expectedManifest = buildManifestFor({
    contract,
    sourceRevision,
    ioContract,
    designResource,
    sourceContract,
    binaries: verifiedBinaries,
    packageFiles: packageFileInventory(files),
  });
  if (!sameCanonical(buildManifest, expectedManifest)
      || buildManifestText !== `${JSON.stringify(expectedManifest, null, 2)}\n`) {
    throw new Error('FMU build manifest does not bind the model and I/O contract exactly, including the design resource.');
  }
  return Object.freeze({
    ...contract,
    files: Object.freeze(files.map((file) => file.rel)),
    binaries: Object.freeze(binaryPlatforms.sort()),
    ioContract: Object.freeze({ checksum: ioContract.map.contractChecksum, sha256: ioContract.sha256 }),
    designResource: designResource.manifestEntry,
    sourceRevision: revisionTrust,
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

export function packageFmu({
  tree,
  output,
  requiredPlatforms = [],
  maxGlibc = null,
  requireCompleteDesign = false,
  requireSourceRevision = false,
}) {
  const root = resolve(tree);
  const outputPath = resolve(output);
  const contract = readFmuContract(root);
  assertSafeOutputPath(contract.root, outputPath);
  assertSafeInternalBuildTree(contract.root);
  // Reject symlinks and unsafe tree entries before creating or copying any
  // metadata, then bind every binary to a native-runner inspection record.
  const sourceRevision = sourceRevisionFromEnvironment();
  const sourceRevisionAuditOptions = sourceRevision == null ? {
    expectedSourceRevision: undefined,
    requireVerifiedSourceRevision: requireSourceRevision,
  } : {
    expectedSourceRevision: sourceRevision,
    requireVerifiedSourceRevision: true,
  };
  const initialFiles = walkFiles(root);
  const initialBinaries = discoverPackagedBinaries(contract, initialFiles);
  if (initialFiles.some(({ rel }) => rel === BUILD_MANIFEST_PATH)) {
    auditFmuTree(root, {
      requireCompleteDesign,
      ...sourceRevisionAuditOptions,
    });
  } else {
    assertExactArchivePaths(initialFiles, expectedCorePaths(contract, initialBinaries), 'FMU source tree');
  }
  const ioContract = readPackagedIoMap(contract);
  const designResource = readPackagedDesignResource(contract, ioContract, {
    requireComplete: requireCompleteDesign,
  });
  const sourceContract = readPackagedSourceContract(contract, ioContract);
  if (requireSourceRevision && sourceRevision == null) {
    throw new Error('Verified FMU packaging requires BATTERY_DESIGN_SOURCE_REVISION.');
  }
  const binaries = verifiedPackagedBinaries(contract, {
    ioContract, sourceContract, requiredPlatforms, maxGlibc,
  });
  const prepared = preparePackageMetadata({
    contract, sourceRevision, ioContract, designResource, sourceContract, binaries,
  });
  writePackageMetadata(contract, prepared);
  const audit = auditFmuTree(root, {
    requireCompleteDesign,
    ...sourceRevisionAuditOptions,
  });
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
    designResource: audit.designResource,
  });
}

const CLI_OPTION_SCHEMAS = Object.freeze({
  compile: Object.freeze({
    flags: Object.freeze(new Set(['reproducible'])),
    values: Object.freeze(new Set(['tree', 'platform', 'compiler', 'max-glibc'])),
  }),
  package: Object.freeze({
    flags: Object.freeze(new Set(['require-complete-design', 'require-source-revision'])),
    values: Object.freeze(new Set(['tree', 'output', 'require-platforms', 'max-glibc'])),
  }),
  inspect: Object.freeze({
    flags: Object.freeze(new Set(['record'])),
    values: Object.freeze(new Set(['tree', 'platform', 'max-glibc'])),
  }),
});

function parseCli(argv) {
  const [command, ...rest] = argv;
  const schema = CLI_OPTION_SCHEMAS[command];
  if (!schema) return { command, options: {} };
  const options = {};
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    if (!/^--[a-z][a-z0-9-]*$/.test(token)) throw new Error(`Unexpected argument: ${token}`);
    const key = token.slice(2);
    if (Object.hasOwn(options, key)) throw new Error(`Duplicate option: ${token}`);
    if (schema.flags.has(key)) options[key] = true;
    else if (schema.values.has(key)) {
      if (i + 1 >= rest.length || rest[i + 1].startsWith('--')) throw new Error(`Missing value for ${token}.`);
      options[key] = rest[++i];
    } else {
      throw new Error(`Unknown option for ${command}: ${token}`);
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
    if (!options.tree || !options.output) throw new Error('Usage: fmu-build.mjs package --tree DIR --output battery-design-ev.fmu [--require-platforms linux64,win64] [--max-glibc 2.17] [--require-complete-design] [--require-source-revision]');
    const requiredPlatforms = options['require-platforms']
      ? options['require-platforms'].split(',').filter(Boolean) : [];
    console.log(JSON.stringify(packageFmu({
      tree: options.tree,
      output: options.output,
      requiredPlatforms,
      maxGlibc: options['max-glibc'] || null,
      requireCompleteDesign: Boolean(options['require-complete-design']),
      requireSourceRevision: Boolean(options['require-source-revision']),
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

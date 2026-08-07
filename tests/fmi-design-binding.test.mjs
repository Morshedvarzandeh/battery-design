import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { designFromSpec } from '../js/api.js';
import { cellById } from '../js/cells.js';
import { immutableSnapshot, normalizeDesignSpec } from '../js/design-spec.js';
import {
  buildFmu, FMI_IO_CONTRACT_CHECKSUM,
  FMI_STANDARD_VERSION,
  FMI_VERSION,
  FMU_MODEL_REVISION,
  fmuGuid, fmuParameterValues,
} from '../js/fmi.js';
import {
  createFmiExportSnapshot,
  FMI_DESIGN_RESOURCE_FORMAT,
  FMI_EXPORT_SNAPSHOT_FORMAT,
  materializeFmiDesignResource,
  verifyFmiDesignResource,
} from '../js/fmi-export-snapshot.js';
import { semanticDigest } from '../js/ontology.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RELEASE_SPEC_PATH = join(ROOT, 'fmi', 'battery-design-ev.design-spec.json');
const GUID = '{01234567-89ab-cdef-0123-456789abcdef}';

function contractForDesign(design) {
  const cell = cellById(design.spec.resolved.cell);
  assert.ok(cell, 'test design resolves a catalog cell');
  const defaults = fmuParameterValues({ cell, s: design.pack.s, p: design.pack.p });
  return {
    defaults,
    options: {
      design,
      modelName: 'BatteryPack',
      defaults,
      ioContractChecksum: FMI_IO_CONTRACT_CHECKSUM,
      modelRevision: FMU_MODEL_REVISION,
      fmiVersion: FMI_VERSION,
      fmiStandardVersion: FMI_STANDARD_VERSION,
    },
  };
}

function materializeDesign(design) {
  const { defaults, options } = contractForDesign(design);
  const draft = createFmiExportSnapshot(options);
  const resource = materializeFmiDesignResource({ ...draft, guid: GUID });
  return { defaults, draft, resource };
}

function assertDeepFrozen(value, seen = new WeakSet()) {
  if (value == null || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  assert.ok(Object.isFrozen(value), 'every resource container is immutable');
  for (const child of Object.values(value)) assertDeepFrozen(child, seen);
}

test('the strict checked-in release DesignSpec becomes one complete immutable FMU snapshot', () => {
  const raw = JSON.parse(readFileSync(RELEASE_SPEC_PATH, 'utf8'));
  const strict = normalizeDesignSpec(raw, { strict: true });
  const design = designFromSpec(strict);
  assert.deepEqual(design.warnings, []);
  assert.equal(design.pack.s, 110);
  assert.equal(design.pack.p, 43);

  const { defaults, draft, resource } = materializeDesign(design);
  assert.equal(resource.format, FMI_DESIGN_RESOURCE_FORMAT);
  assert.equal(resource.snapshot.format, FMI_EXPORT_SNAPSHOT_FORMAT);
  assert.equal(resource.snapshotChecksum, semanticDigest(resource.snapshot));
  assert.equal(resource.snapshot.source.kind, 'design-result');
  assert.equal(resource.snapshot.source.complete, true);
  assert.deepEqual(resource.snapshot.source.binding, design.binding);
  assert.equal(resource.snapshot.source.configuration.schemaVersion, '1.0.0');
  assert.equal(resource.snapshot.source.configuration.cellId, 'lg-inr18650-mj1');

  assert.deepEqual(resource.snapshot.cell.dimensionsMm, { diameterMm: 18.4, heightMm: 65 });
  assert.equal(resource.snapshot.cell.massKg, 0.049);
  assert.equal(resource.snapshot.pack.seriesCells, 110);
  assert.equal(resource.snapshot.pack.parallelCells, 43);
  assert.equal(resource.snapshot.pack.cellCount, 4730);
  assert.equal(resource.snapshot.pack.energyWh, design.pack.energyWh);
  assert.deepEqual(resource.snapshot.pack.dimensionsMm, design.pack.dims);
  assert.equal(resource.snapshot.pack.totalMassKg, design.pack.massKg);
  assert.deepEqual(resource.snapshot.architecture.modulePartition, {
    seriesCellsPerModule: 11,
    parallelCellsPerModule: 43,
    moduleCount: 10,
    virtual: false,
    cellsPerModule: 473,
    nominalVoltagePerModuleV: 39.985,
    maximumVoltagePerModuleV: 46.2,
    energyPerModuleWh: 6017.742499999999,
    cellMassPerModuleKg: 23.177,
  });
  assert.equal(resource.snapshot.layout.arrangement, 'hex');
  assert.equal(resource.snapshot.layout.columns, 64);
  assert.equal(resource.snapshot.layout.layers, 1);
  assert.deepEqual(resource.snapshot.layout.outerDimensionsMm, design.pack.dims);
  assert.deepEqual(resource.snapshot.components, design.spec.resolved.components);
  assert.deepEqual(resource.snapshot.fmi.parameterDefaults, defaults);
  assert.equal(resource.snapshot.fmi.ioContractChecksum, FMI_IO_CONTRACT_CHECKSUM);

  const json = JSON.stringify(resource);
  assert.doesNotMatch(json, /"positions"/);
  assert.ok(json.length < 10_000, 'the resource is a compact manifest, not a per-cell geometry dump');
  assertDeepFrozen(draft);
  assertDeepFrozen(resource);
  assert.throws(() => { resource.snapshot.pack.energyWh = 0; }, TypeError);

  const verified = verifyFmiDesignResource(JSON.parse(json), {
    guid: GUID,
    modelIdentifier: 'BatteryPack',
    defaults,
    ioContractChecksum: FMI_IO_CONTRACT_CHECKSUM,
    modelRevision: FMU_MODEL_REVISION,
    fmiVersion: FMI_VERSION,
    fmiStandardVersion: FMI_STANDARD_VERSION,
    requireComplete: true,
  });
  assertDeepFrozen(verified);
  assert.deepEqual(verified, resource);

  const built = buildFmu({ design });
  assert.equal(built.designComplete, true);
  assert.equal(built.designSnapshotChecksum, draft.snapshotChecksum);
  assert.deepEqual(built.designBinding, design.binding);
  assert.deepEqual(built.designResource.snapshot, resource.snapshot);
  assert.equal(built.designResource.guid, built.guid);
  assert.deepEqual(
    JSON.parse(built.files['resources/battery-design-design.json']),
    built.designResource,
  );
  assert.equal(built.guid, fmuGuid({
    cell: cellById(design.cell.id),
    s: design.pack.s,
    p: design.pack.p,
    defaults: built.defaults,
    designSnapshotChecksum: built.designSnapshotChecksum,
  }));
});

test('layout changes alter the bound component identity without changing FMI parameter starts', () => {
  const baseSpec = {
    application: 'ev', cell: 'lg-inr18650-mj1', s: 110, p: 43, energyWh: 60_000,
    layout: { arrangement: 'hex', orientation: 'upright', spacingMm: 1, nx: 64, nz: 1 },
  };
  const firstDesign = designFromSpec(baseSpec);
  const secondDesign = designFromSpec({
    ...baseSpec,
    layout: { ...baseSpec.layout, spacingMm: 2, nx: 63 },
  });
  const first = materializeDesign(firstDesign);
  const repeated = materializeDesign(designFromSpec(baseSpec));
  const second = materializeDesign(secondDesign);

  assert.equal(first.draft.snapshotChecksum, repeated.draft.snapshotChecksum);
  assert.deepEqual(first.resource, repeated.resource);
  assert.notEqual(firstDesign.binding.designChecksum, secondDesign.binding.designChecksum);
  assert.notEqual(first.draft.snapshotChecksum, second.draft.snapshotChecksum);
  assert.notDeepEqual(first.resource.snapshot.layout.outerDimensionsMm, second.resource.snapshot.layout.outerDimensionsMm);
  assert.deepEqual(first.defaults, second.defaults,
    'static geometry does not silently change the existing FMI equations or starts');
  assert.equal(first.resource.snapshot.fmi.ioContractChecksum, second.resource.snapshot.fmi.ioContractChecksum);
  const firstBuild = buildFmu({ design: firstDesign });
  const secondBuild = buildFmu({ design: secondDesign });
  assert.notEqual(firstBuild.guid, secondBuild.guid,
    'a host must reimport a layout-bound component even when its 23 scalar starts are unchanged');
  assert.deepEqual(firstBuild.defaults, secondBuild.defaults);
  assert.deepEqual(firstBuild.ioMap.variables, secondBuild.ioMap.variables);
});

test('mixed, mismatched and tampered inputs fail before a resource is accepted', () => {
  const design = designFromSpec({ application: 'ev', energyWh: 60_000 });
  const { defaults, options } = contractForDesign(design);
  const cell = cellById(design.cell.id);

  assert.throws(
    () => createFmiExportSnapshot({ ...options, cell, s: design.pack.s, p: design.pack.p }),
    /mutually exclusive/,
  );
  assert.throws(
    () => buildFmu({ design, cell, s: design.pack.s, p: design.pack.p }),
    /either one complete design or legacy cell\/s\/p inputs/,
  );
  assert.throws(
    () => buildFmu({ design, params: { r0Ref: -1 } }),
    /parameter overrides require repair/,
    'a governed design export cannot silently clamp a calibration override',
  );
  for (const params of [
    { typo: 1 },
    { rc2R: 123 },
    { r0SocRise: 2 },
    { r0ref: 20 },
  ]) {
    assert.throws(
      () => buildFmu({ design, params }),
      /not represented by the reduced one-RC component/,
      'a governed export rejects unknown and valid-but-unmapped sim2 calibration keys',
    );
  }
  assert.throws(
    () => createFmiExportSnapshot({
      ...options,
      defaults: { ...defaults, cells_series: defaults.cells_series + 1 },
    }),
    /cells_series does not match/,
  );

  const changed = JSON.parse(JSON.stringify(design));
  changed.pack.energyWh += 1;
  const frozenTamper = immutableSnapshot(changed);
  assert.throws(
    () => createFmiExportSnapshot({ ...options, design: frozenTamper }),
    /design result facts do not reproduce the semantic graph recorded by its binding/,
  );

  const alternatePartition = JSON.parse(JSON.stringify(design));
  Object.assign(alternatePartition.architecture.partition, {
    sMod: 22,
    pMod: 43,
    nModules: 5,
    virtual: false,
    cellsPerModule: 946,
    moduleVoltageNomV: 22 * cell.nominalV,
    moduleVoltageMaxV: 22 * cell.vMax,
    moduleEnergyWh: 946 * cell.nominalV * cell.capacityAh,
    moduleMassCellsKg: (946 * cell.massG) / 1000,
  });
  assert.throws(
    () => createFmiExportSnapshot({
      ...options, design: immutableSnapshot(alternatePartition),
    }),
    /design result facts do not reproduce the semantic graph recorded by its binding|does not match the module topology resolved from the bound DesignSpec/,
    'an internally coherent alternate module topology cannot retain the original design binding',
  );

  const { resource } = materializeDesign(design);
  const contentTamper = JSON.parse(JSON.stringify(resource));
  contentTamper.snapshot.pack.energyWh += 1;
  assert.throws(
    () => verifyFmiDesignResource(contentTamper),
    /snapshot\.pack\.energyWh does not match the bound cell and pack topology/,
  );

  const shapeTamper = JSON.parse(JSON.stringify(resource));
  shapeTamper.snapshot.layout.positions = [{ x: 0, y: 0, z: 0 }];
  shapeTamper.snapshotChecksum = semanticDigest(shapeTamper.snapshot);
  assert.throws(
    () => verifyFmiDesignResource(shapeTamper),
    /unsupported field\(s\): positions|positions are not allowed/,
  );

  const missingField = JSON.parse(JSON.stringify(resource));
  delete missingField.snapshot.cell.manufacturer;
  missingField.snapshotChecksum = semanticDigest(missingField.snapshot);
  assert.throws(
    () => verifyFmiDesignResource(missingField),
    /snapshot\.cell is missing required field\(s\): manufacturer/,
    'a checksum-valid resource still has one exact schema shape',
  );

  const identityTamper = JSON.parse(JSON.stringify(resource));
  identityTamper.snapshot.source.configuration.cellId = 'another-cell';
  identityTamper.snapshotChecksum = semanticDigest(identityTamper.snapshot);
  assert.throws(
    () => verifyFmiDesignResource(identityTamper),
    /snapshot cell id does not match its configuration identity/,
  );

  const moduleTamper = JSON.parse(JSON.stringify(resource));
  moduleTamper.snapshot.architecture.modulePartition.cellsPerModule = 1;
  moduleTamper.snapshotChecksum = semanticDigest(moduleTamper.snapshot);
  assert.throws(
    () => verifyFmiDesignResource(moduleTamper),
    /cellsPerModule does not match the bound cell and pack topology/,
  );

  const envelopeTamper = JSON.parse(JSON.stringify(resource));
  envelopeTamper.snapshot.layout.volumeL += 1;
  envelopeTamper.snapshotChecksum = semanticDigest(envelopeTamper.snapshot);
  assert.throws(
    () => verifyFmiDesignResource(envelopeTamper),
    /snapshot\.layout\.volumeL does not match the bound cell and pack topology/,
  );
  assert.throws(
    () => verifyFmiDesignResource(resource, { modelIdentifier: 'AnotherModel' }),
    /modelIdentifier does not match/,
  );
  assert.throws(
    () => materializeFmiDesignResource({
      snapshot: resource.snapshot,
      snapshotChecksum: '0'.repeat(64),
      guid: GUID,
    }),
    /checksum does not match/,
  );
});

test('legacy cell/S/P exports remain numerical but explicitly incomplete', () => {
  const cell = cellById('lg-inr18650-mj1');
  const s = 96;
  const p = 44;
  const defaults = fmuParameterValues({ cell, s, p });
  const draft = createFmiExportSnapshot({
    cell, s, p,
    modelName: 'BatteryPack',
    defaults,
    ioContractChecksum: FMI_IO_CONTRACT_CHECKSUM,
    modelRevision: FMU_MODEL_REVISION,
    fmiVersion: FMI_VERSION,
    fmiStandardVersion: FMI_STANDARD_VERSION,
  });
  const resource = materializeFmiDesignResource({ ...draft, guid: GUID });

  assert.equal(resource.snapshot.source.kind, 'legacy-cell-sp');
  assert.equal(resource.snapshot.source.complete, false);
  assert.equal(resource.snapshot.source.binding, null);
  assert.equal(resource.snapshot.application, null);
  assert.equal(resource.snapshot.layout, null);
  assert.equal(resource.snapshot.components, null);
  assert.equal(resource.snapshot.architecture.modulePartition, null);
  assert.equal(resource.snapshot.pack.seriesCells, s);
  assert.equal(resource.snapshot.pack.parallelCells, p);
  assert.equal(resource.snapshot.pack.energyWh, s * p * cell.nominalV * cell.capacityAh);
  assert.equal(resource.snapshot.fmi.parameterDefaults.cells_series, s);
  const built = buildFmu({ cell, s, p, params: { r0Ref: -1 } });
  assert.equal(built.designComplete, false);
  assert.equal(built.designBinding, null);
  assert.ok(built.parameterWarnings.length > 0,
    'legacy repair remains compatible but is visible instead of silently discarded');
  const ignored = buildFmu({ cell, s, p, params: { rc2R: 123, typo: 1 } });
  assert.match(ignored.parameterWarnings.join('\n'), /rc2R: ignored/);
  assert.match(ignored.parameterWarnings.join('\n'), /typo: ignored/);
  assert.equal(ignored.guid, buildFmu({ cell, s, p }).guid,
    'ignored legacy-only keys stay explicit without changing component identity');
  assert.deepEqual(JSON.parse(built.files['resources/battery-design-design.json']), built.designResource);
  assert.doesNotThrow(() => verifyFmiDesignResource(resource, { defaults }));
  const falseLegacyIdentity = JSON.parse(JSON.stringify(resource));
  falseLegacyIdentity.snapshot.source.configuration.market = 'eu';
  falseLegacyIdentity.snapshotChecksum = semanticDigest(falseLegacyIdentity.snapshot);
  assert.throws(
    () => verifyFmiDesignResource(falseLegacyIdentity),
    /legacy snapshot configuration market must be null/,
    'legacy provenance cannot acquire a partial full-design identity',
  );
  assert.throws(
    () => verifyFmiDesignResource(resource, { requireComplete: true }),
    /complete design-bound resource is required/,
  );
});

test('FMU provenance keeps resolved facts and checksums without copying private raw evidence', () => {
  const marker = 'PRIVATE-TRACE-MARKER-7f4e214c';
  const design = designFromSpec({
    application: 'ev',
    energyWh: 20_000,
    privateEvidenceMarker: marker,
    profileTrace: {
      id: 'private-trace', dtS: 1, p: [0, 0.5, 1], scaleW: 10_000, note: marker,
    },
    diagnostics: { assetId: marker },
    marine: {
      replaySamples: [{ tS: 0, operatingMode: marker }],
      replayOptions: { privateMarker: marker },
      twinEvidence: { privateMarker: marker },
    },
  });
  assert.match(JSON.stringify(design), new RegExp(marker),
    'the test marker really reaches caller-owned design data outside the sanitized projection');

  const { resource } = materializeDesign(design);
  const serialized = JSON.stringify(resource);
  assert.doesNotMatch(serialized, new RegExp(marker));
  assert.doesNotMatch(serialized, /profileTrace|replaySamples|replayOptions|twinEvidence|assetId/);
  assert.equal(resource.snapshot.source.binding.specChecksum, design.binding.specChecksum);
  assert.equal(resource.snapshot.source.configuration.cellId, design.spec.resolved.cell);
  assert.equal(resource.snapshot.pack.energyWh, design.pack.energyWh);

  const implementation = readFileSync(join(ROOT, 'js', 'fmi-export-snapshot.js'), 'utf8');
  assert.doesNotMatch(implementation, /from ['"]\.\/api\.js['"]/,
    'package verification stays independent of design reconstruction');
});

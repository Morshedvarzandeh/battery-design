// fmi-export-snapshot.js — immutable design provenance for an FMI export.
//
// The executable FMI contract lives in fmi.js / fmi-signal-map.js. This file
// binds that contract to one resolved battery design without turning static
// layout facts into runtime signals. It deliberately does not import api.js:
// release tooling can verify a packaged resource without rebuilding a design.

import { cellById } from './cells.js';
import { modulePartition } from './architecture.js';
import { immutableSnapshot } from './design-spec.js';
import { buildDesignSemanticGraph, canonicalJson, semanticDigest } from './ontology.js';

export const FMI_EXPORT_SNAPSHOT_FORMAT = 'battery-design/fmi-export-snapshot@1';
export const FMI_DESIGN_RESOURCE_FORMAT = 'battery-design/fmi-design-resource@1';

const SHA256 = /^[a-f0-9]{64}$/;
const GUID = /^\{[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\}$/;
const MODEL_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const COMPONENT_KEYS = Object.freeze(['busbar', 'spacer', 'vent', 'cooling', 'tim', 'housing']);

const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const record = (value) => value != null && typeof value === 'object' && !Array.isArray(value);
const finite = (value) => typeof value === 'number' && Number.isFinite(value);

function fail(message) {
  throw new TypeError(`FMI design resource: ${message}`);
}

function requireRecord(value, label) {
  if (!record(value)) fail(`${label} must be an object.`);
  return value;
}

function requireString(value, label) {
  if (typeof value !== 'string' || !value) fail(`${label} must be a non-empty string.`);
  return value;
}

function requireSha(value, label) {
  if (typeof value !== 'string' || !SHA256.test(value)) fail(`${label} must be a lowercase SHA-256 digest.`);
  return value;
}

function requireFinite(value, label, { positive = false, nonNegative = false } = {}) {
  if (!finite(value)) fail(`${label} must be finite.`);
  if (positive && value <= 0) fail(`${label} must be greater than zero.`);
  if (nonNegative && value < 0) fail(`${label} must not be negative.`);
  return value;
}

function requireInteger(value, label, { positive = false } = {}) {
  if (!Number.isInteger(value) || (positive && value < 1)) {
    fail(`${label} must be ${positive ? 'a positive' : 'an'} integer.`);
  }
  return value;
}

function finiteOrNull(value, label, options = {}) {
  return value == null ? null : requireFinite(value, label, options);
}

function assertOnlyKeys(value, allowed, label) {
  const extra = Object.keys(requireRecord(value, label)).filter((key) => !allowed.includes(key));
  if (extra.length) fail(`${label} contains unsupported field(s): ${extra.join(', ')}.`);
}

function assertExactKeys(value, expected, label) {
  assertOnlyKeys(value, expected, label);
  const missing = expected.filter((key) => !own(value, key));
  if (missing.length) fail(`${label} is missing required field(s): ${missing.join(', ')}.`);
}

function sameNumber(actual, expected) {
  return finite(actual) && finite(expected)
    && Math.abs(actual - expected) <= 1e-12 * Math.max(1, Math.abs(actual), Math.abs(expected));
}

function sortedFiniteDefaults(defaults) {
  requireRecord(defaults, 'defaults');
  const names = Object.keys(defaults).sort();
  if (!names.length) fail('defaults must declare at least one FMI parameter start.');
  return Object.fromEntries(names.map((name) => [
    name,
    requireFinite(defaults[name], `defaults.${name}`),
  ]));
}

function modelContract({
  modelName, defaults, ioContractChecksum, modelRevision, fmiVersion, fmiStandardVersion,
}) {
  if (typeof modelName !== 'string' || !MODEL_IDENTIFIER.test(modelName)) {
    fail('modelName is not a portable FMI modelIdentifier.');
  }
  return {
    version: requireString(fmiVersion, 'fmiVersion'),
    standardPatch: requireString(fmiStandardVersion, 'fmiStandardVersion'),
    modelRevision: requireString(modelRevision, 'modelRevision'),
    modelIdentifier: modelName,
    ioContractChecksum: requireSha(ioContractChecksum, 'ioContractChecksum'),
    parameterDefaults: sortedFiniteDefaults(defaults),
  };
}

function cellDimensionsMm(cell) {
  if (!record(cell?.dims)) return null;
  if (cell.form === 'cylindrical') {
    return {
      diameterMm: requireFinite(cell.dims.d, 'cell.dims.d', { positive: true }),
      heightMm: requireFinite(cell.dims.h, 'cell.dims.h', { positive: true }),
    };
  }
  if (['prismatic', 'pouch'].includes(cell.form)) {
    return {
      widthMm: requireFinite(cell.dims.w, 'cell.dims.w', { positive: true }),
      thicknessMm: requireFinite(cell.dims.t, 'cell.dims.t', { positive: true }),
      heightMm: requireFinite(cell.dims.h, 'cell.dims.h', { positive: true }),
    };
  }
  return null;
}

function cellFacts(cell, { complete }) {
  requireRecord(cell, 'cell');
  const fact = {
    id: typeof cell.id === 'string' && cell.id ? cell.id : null,
    name: typeof cell.name === 'string' && cell.name ? cell.name : null,
    manufacturer: typeof cell.manufacturer === 'string' && cell.manufacturer ? cell.manufacturer : null,
    model: typeof cell.model === 'string' && cell.model ? cell.model : null,
    chemistry: typeof cell.chemistry === 'string' && cell.chemistry ? cell.chemistry : null,
    form: typeof cell.form === 'string' && cell.form ? cell.form : null,
    formFactor: typeof cell.formFactor === 'string' && cell.formFactor ? cell.formFactor : null,
    dimensionsMm: cellDimensionsMm(cell),
    nominalVoltageV: finiteOrNull(cell.nominalV, 'cell.nominalV', { positive: true }),
    minimumVoltageV: requireFinite(cell.vMin, 'cell.vMin', { positive: true }),
    maximumVoltageV: requireFinite(cell.vMax, 'cell.vMax', { positive: true }),
    capacityAh: requireFinite(cell.capacityAh, 'cell.capacityAh', { positive: true }),
    massKg: requireFinite(cell.massG, 'cell.massG', { positive: true }) / 1000,
    dcResistanceMOhm: finiteOrNull(cell.dcirMOhm, 'cell.dcirMOhm', { nonNegative: true }),
  };
  if (!(fact.maximumVoltageV > fact.minimumVoltageV)) fail('cell voltage window is not ordered.');
  if (complete && (!fact.id || !fact.name || !fact.chemistry || !fact.form || !fact.dimensionsMm
      || fact.nominalVoltageV == null)) {
    fail('a complete design requires identified cell geometry and electrical facts.');
  }
  return fact;
}

function validateDefaultsForCellAndPack(defaults, cell, s, p) {
  for (const name of ['cells_series', 'cells_parallel', 'capacity_Ah', 'ocv_min', 'ocv_max', 'mass_cell_kg']) {
    if (!own(defaults, name)) fail(`defaults.${name} is required to bind the design.`);
  }
  const expected = {
    cells_series: s,
    cells_parallel: p,
    capacity_Ah: cell.capacityAh,
    ocv_min: cell.vMin,
    ocv_max: cell.vMax,
    mass_cell_kg: cell.massG / 1000,
  };
  for (const [name, value] of Object.entries(expected)) {
    if (!sameNumber(defaults[name], value)) {
      fail(`defaults.${name} does not match the selected design (${defaults[name]} != ${value}).`);
    }
  }
}

function validateBinding(design) {
  if (!Object.isFrozen(design) || !Object.isFrozen(design.spec)
      || !Object.isFrozen(design.pack) || !Object.isFrozen(design.binding)) {
    fail('design must be the deeply immutable result returned by designFromSpec().');
  }
  const binding = requireRecord(design.binding, 'design.binding');
  assertExactKeys(binding, [
    'format', 'specSchemaVersion', 'specChecksum', 'semanticChecksum', 'designChecksum',
  ], 'design.binding');
  if (binding.format !== 'battery-design/result-binding/v1') fail('design.binding format is unsupported.');
  if (binding.specSchemaVersion !== design.spec.schemaVersion) {
    fail('design.binding specSchemaVersion does not match design.spec.');
  }
  requireSha(binding.specChecksum, 'design.binding.specChecksum');
  requireSha(binding.semanticChecksum, 'design.binding.semanticChecksum');
  requireSha(binding.designChecksum, 'design.binding.designChecksum');
  if (semanticDigest(design.spec) !== binding.specChecksum) fail('design.spec has been changed after binding.');
  const semanticChecksum = design.semantics?.graph?.checksum;
  if (semanticChecksum !== binding.semanticChecksum) fail('design semantic graph does not match its binding.');
  const rebuiltSemanticChecksum = buildDesignSemanticGraph(design).checksum;
  if (rebuiltSemanticChecksum !== binding.semanticChecksum) {
    fail('design result facts do not reproduce the semantic graph recorded by its binding.');
  }
  const calculatedDesignChecksum = semanticDigest({
    spec: design.spec,
    pack: design.pack,
    semanticChecksum,
  });
  if (calculatedDesignChecksum !== binding.designChecksum) fail('design pack has been changed after binding.');
  return binding;
}

function fullPackFacts(pack, s, p) {
  requireRecord(pack, 'design.pack');
  if (pack.s !== s || pack.p !== p) fail('design.pack series/parallel counts do not match design.spec.resolved.');
  if (pack.cellCount !== s * p) fail('design.pack cellCount does not equal series multiplied by parallel.');
  const dimensions = requireRecord(pack.dims, 'design.pack.dims');
  return {
    seriesCells: s,
    parallelCells: p,
    cellCount: pack.cellCount,
    nominalVoltageV: requireFinite(pack.nominalV, 'design.pack.nominalV', { positive: true }),
    minimumVoltageV: requireFinite(pack.vMin, 'design.pack.vMin', { positive: true }),
    maximumVoltageV: requireFinite(pack.vMax, 'design.pack.vMax', { positive: true }),
    capacityAh: requireFinite(pack.capacityAh, 'design.pack.capacityAh', { positive: true }),
    energyWh: requireFinite(pack.energyWh, 'design.pack.energyWh', { positive: true }),
    cellMassKg: requireFinite(pack.massCellsKg, 'design.pack.massCellsKg', { positive: true }),
    totalMassKg: requireFinite(pack.massKg, 'design.pack.massKg', { positive: true }),
    dimensionsMm: {
      x: requireFinite(dimensions.x, 'design.pack.dims.x', { positive: true }),
      y: requireFinite(dimensions.y, 'design.pack.dims.y', { positive: true }),
      z: requireFinite(dimensions.z, 'design.pack.dims.z', { positive: true }),
    },
    volumeL: requireFinite(pack.volumeL, 'design.pack.volumeL', { positive: true }),
    maximumContinuousDischargeCurrentA: requireFinite(
      pack.maxContCurrentA, 'design.pack.maxContCurrentA', { nonNegative: true },
    ),
    maximumPulseDischargeCurrentA: finiteOrNull(
      pack.maxPulseCurrentA, 'design.pack.maxPulseCurrentA', { nonNegative: true },
    ),
    maximumContinuousChargeCurrentA: requireFinite(
      pack.maxChargeCurrentA, 'design.pack.maxChargeCurrentA', { nonNegative: true },
    ),
    maximumContinuousPowerW: requireFinite(pack.maxContPowerW, 'design.pack.maxContPowerW', { nonNegative: true }),
    maximumContinuousPowerAtMinimumVoltageW: requireFinite(
      pack.maxContPowerAtVMinW, 'design.pack.maxContPowerAtVMinW', { nonNegative: true },
    ),
    cellsOnlyResistanceMOhm: finiteOrNull(pack.dcirMOhm, 'design.pack.dcirMOhm', { nonNegative: true }),
    voltageSagAtMaximumContinuousCurrentV: finiteOrNull(
      pack.sagVAtMaxCont, 'design.pack.sagVAtMaxCont', { nonNegative: true },
    ),
    packingEfficiency: requireFinite(pack.packingEfficiency, 'design.pack.packingEfficiency', { positive: true }),
  };
}

function legacyPackFacts(cell, s, p) {
  const cellCount = s * p;
  const nominalVoltageV = finite(cell.nominalV) ? s * cell.nominalV : null;
  const maximumContinuousDischargeCurrentA = finite(cell.maxContDischargeA)
    ? p * cell.maxContDischargeA : null;
  const resistance = finite(cell.dcirMOhm) ? (cell.dcirMOhm * s) / p : null;
  return {
    seriesCells: s,
    parallelCells: p,
    cellCount,
    nominalVoltageV,
    minimumVoltageV: s * cell.vMin,
    maximumVoltageV: s * cell.vMax,
    capacityAh: p * cell.capacityAh,
    energyWh: nominalVoltageV == null ? null : nominalVoltageV * p * cell.capacityAh,
    cellMassKg: (cellCount * cell.massG) / 1000,
    totalMassKg: null,
    dimensionsMm: null,
    volumeL: null,
    maximumContinuousDischargeCurrentA,
    maximumPulseDischargeCurrentA: finite(cell.maxPulseDischargeA) ? p * cell.maxPulseDischargeA : null,
    maximumContinuousChargeCurrentA: finite(cell.maxContChargeA) ? p * cell.maxContChargeA : null,
    maximumContinuousPowerW: nominalVoltageV == null || maximumContinuousDischargeCurrentA == null
      ? null : nominalVoltageV * maximumContinuousDischargeCurrentA,
    maximumContinuousPowerAtMinimumVoltageW: maximumContinuousDischargeCurrentA == null
      ? null : s * cell.vMin * maximumContinuousDischargeCurrentA,
    cellsOnlyResistanceMOhm: resistance,
    voltageSagAtMaximumContinuousCurrentV: resistance == null || maximumContinuousDischargeCurrentA == null
      ? null : (resistance * maximumContinuousDischargeCurrentA) / 1000,
    packingEfficiency: null,
  };
}

function projectedModuleFacts(part, label = 'design.architecture.partition') {
  requireRecord(part, label);
  if (typeof part.virtual !== 'boolean') fail(`${label}.virtual must be boolean.`);
  return {
    seriesCellsPerModule: requireInteger(part.sMod, `${label}.sMod`, { positive: true }),
    parallelCellsPerModule: requireInteger(part.pMod, `${label}.pMod`, { positive: true }),
    moduleCount: requireInteger(part.nModules, `${label}.nModules`, { positive: true }),
    virtual: part.virtual,
    cellsPerModule: requireInteger(part.cellsPerModule, `${label}.cellsPerModule`, { positive: true }),
    nominalVoltagePerModuleV: requireFinite(
      part.moduleVoltageNomV, `${label}.moduleVoltageNomV`, { positive: true },
    ),
    maximumVoltagePerModuleV: requireFinite(
      part.moduleVoltageMaxV, `${label}.moduleVoltageMaxV`, { positive: true },
    ),
    energyPerModuleWh: requireFinite(
      part.moduleEnergyWh, `${label}.moduleEnergyWh`, { positive: true },
    ),
    cellMassPerModuleKg: requireFinite(
      part.moduleMassCellsKg, `${label}.moduleMassCellsKg`, { positive: true },
    ),
  };
}

function validateModuleFacts(module, pack, cell, label = 'snapshot.architecture.modulePartition') {
  const sMod = module.seriesCellsPerModule;
  const pMod = module.parallelCellsPerModule;
  if (pack.seriesCells % sMod !== 0 || pack.parallelCells % pMod !== 0) {
    fail(`${label} does not tile the pack topology exactly.`);
  }
  const expectedModules = (pack.seriesCells / sMod) * (pack.parallelCells / pMod);
  const expectedCells = sMod * pMod;
  const expected = {
    moduleCount: expectedModules,
    cellsPerModule: expectedCells,
    nominalVoltagePerModuleV: sMod * cell.nominalVoltageV,
    maximumVoltagePerModuleV: sMod * cell.maximumVoltageV,
    energyPerModuleWh: expectedCells * cell.nominalVoltageV * cell.capacityAh,
    cellMassPerModuleKg: expectedCells * cell.massKg,
  };
  for (const [key, value] of Object.entries(expected)) {
    if (!sameNumber(module[key], value)) {
      fail(`${label}.${key} does not match the bound cell and pack topology.`);
    }
  }
  if (module.moduleCount * module.cellsPerModule !== pack.cellCount) {
    fail(`${label} does not account for every pack cell exactly once.`);
  }
  if (module.virtual && (sMod !== pack.seriesCells || pMod !== pack.parallelCells
      || module.moduleCount !== 1)) {
    fail(`${label} claims a virtual whole-pack group but does not span the whole pack.`);
  }
}

function moduleFacts(design, cell, pack) {
  const part = requireRecord(design.architecture?.partition, 'design.architecture.partition');
  const projected = projectedModuleFacts(part);
  validateModuleFacts(projected, pack, {
    nominalVoltageV: cell.nominalV,
    maximumVoltageV: cell.vMax,
    capacityAh: cell.capacityAh,
    massKg: cell.massG / 1000,
  }, 'design.architecture.partition');

  // Algebra alone cannot distinguish two internally coherent partitions.
  // Recompute the partition from the DesignSpec fields already covered by
  // design.binding so an alternate module topology cannot retain an old
  // result binding.
  const architecture = record(design.spec?.architecture) ? design.spec.architecture : {};
  const expected = projectedModuleFacts(modulePartition(
    pack.seriesCells,
    pack.parallelCells,
    cell,
    {
      channelsPerIc: architecture.channelsPerIc,
      sModOverride: architecture.sModOverride ?? null,
    },
  ), 'expected module partition');
  if (canonicalJson(projected) !== canonicalJson(expected)) {
    fail('design.architecture.partition does not match the module topology resolved from the bound DesignSpec.');
  }
  return projected;
}

function sanitizeBay(bay) {
  if (bay == null) return null;
  requireRecord(bay, 'design.spec.resolved.layout.bay');
  switch (bay.kind) {
    case 'box': return { kind: 'box', xMm: requireFinite(bay.x, 'bay.x', { positive: true }), yMm: requireFinite(bay.y, 'bay.y', { positive: true }), zMm: requireFinite(bay.z, 'bay.z', { positive: true }) };
    case 'round': return { kind: 'round', diameterMm: requireFinite(bay.d, 'bay.d', { positive: true }), zMm: requireFinite(bay.z, 'bay.z', { positive: true }) };
    case 'lshape': return {
      kind: 'lshape', xMm: requireFinite(bay.x, 'bay.x', { positive: true }), yMm: requireFinite(bay.y, 'bay.y', { positive: true }),
      cutXmm: requireFinite(bay.cutX, 'bay.cutX', { positive: true }), cutYmm: requireFinite(bay.cutY, 'bay.cutY', { positive: true }),
      zMm: requireFinite(bay.z, 'bay.z', { positive: true }),
    };
    case 'stepped': return {
      kind: 'stepped', xAmm: requireFinite(bay.xA, 'bay.xA', { positive: true }), zAmm: requireFinite(bay.zA, 'bay.zA', { positive: true }),
      xBmm: requireFinite(bay.xB, 'bay.xB', { positive: true }), zBmm: requireFinite(bay.zB, 'bay.zB', { positive: true }),
      yMm: requireFinite(bay.y, 'bay.y', { positive: true }),
    };
    case 'poly': {
      if (!Array.isArray(bay.points) || bay.points.length < 3) fail('polygon bay needs at least three points.');
      return {
        kind: 'poly',
        pointsMm: bay.points.map((point, index) => {
          if (!Array.isArray(point) || point.length !== 2) fail(`bay.points[${index}] must be an [x, y] pair.`);
          return [requireFinite(point[0], `bay.points[${index}][0]`), requireFinite(point[1], `bay.points[${index}][1]`)];
        }),
        zMm: requireFinite(bay.z, 'bay.z', { positive: true }),
      };
    }
    default: fail(`unsupported resolved bay kind ${String(bay.kind)}.`);
  }
}

function componentFacts(components) {
  requireRecord(components, 'design.spec.resolved.components');
  return Object.fromEntries(COMPONENT_KEYS.map((key) => {
    const value = components[key];
    if (value != null && typeof value !== 'string') fail(`resolved component ${key} must be an id or null.`);
    return [key, value || null];
  }));
}

function layoutFacts(design) {
  const layout = requireRecord(design.spec?.resolved?.layout, 'design.spec.resolved.layout');
  return {
    arrangement: requireString(layout.arrangement, 'design.spec.resolved.layout.arrangement'),
    orientation: requireString(layout.orientation, 'design.spec.resolved.layout.orientation'),
    spacingMm: requireFinite(layout.spacingMm, 'layout.spacingMm', { nonNegative: true }),
    layerGapMm: requireFinite(layout.layerGapMm, 'layout.layerGapMm', { nonNegative: true }),
    wallMm: requireFinite(layout.wallMm, 'layout.wallMm', { nonNegative: true }),
    headroomMm: requireFinite(layout.headroomMm, 'layout.headroomMm', { nonNegative: true }),
    underMm: requireFinite(layout.underMm, 'layout.underMm', { nonNegative: true }),
    rowExtraMm: requireFinite(layout.rowExtraMm, 'layout.rowExtraMm', { nonNegative: true }),
    columns: requireInteger(layout.nx, 'layout.nx', { positive: true }),
    layers: requireInteger(layout.nz, 'layout.nz', { positive: true }),
    bay: sanitizeBay(layout.bay),
    outerDimensionsMm: {
      x: design.pack.dims.x,
      y: design.pack.dims.y,
      z: design.pack.dims.z,
    },
    volumeL: design.pack.volumeL,
    packingEfficiency: design.pack.packingEfficiency,
  };
}

function sanitizedConfiguration(design) {
  const resolved = requireRecord(design.spec?.resolved, 'design.spec.resolved');
  const traceChecksum = resolved.sizing?.traceIdentity?.checksum ?? null;
  if (traceChecksum != null) requireSha(traceChecksum, 'design.spec.resolved.sizing.traceIdentity.checksum');
  return {
    schemaVersion: requireString(design.spec.schemaVersion, 'design.spec.schemaVersion'),
    applicationId: requireString(resolved.application, 'design.spec.resolved.application'),
    cellId: requireString(resolved.cell, 'design.spec.resolved.cell'),
    seriesCells: requireInteger(resolved.s, 'design.spec.resolved.s', { positive: true }),
    parallelCells: requireInteger(resolved.p, 'design.spec.resolved.p', { positive: true }),
    market: typeof resolved.market === 'string' ? resolved.market : null,
    depthOfDischarge: finiteOrNull(resolved.dod, 'design.spec.resolved.dod', { positive: true }),
    isolationContext: typeof resolved.isolationContext === 'string' ? resolved.isolationContext : null,
    isolationStatus: typeof resolved.isolationStatus === 'string' ? resolved.isolationStatus : null,
    sizingDecision: typeof resolved.sizing?.decision === 'string' ? resolved.sizing.decision : null,
    traceChecksum,
  };
}

function fullSnapshot(design, fmi) {
  requireRecord(design, 'design');
  const binding = validateBinding(design);
  const configuration = sanitizedConfiguration(design);
  if (design.cell?.id !== configuration.cellId) fail('design.cell does not match the resolved cell id.');
  if (design.application?.id != null && design.application.id !== configuration.applicationId) {
    fail('design.application does not match the resolved application id.');
  }
  const cell = cellById(configuration.cellId);
  if (!cell) fail(`resolved cell ${configuration.cellId} is not in the current cell catalog.`);
  validateDefaultsForCellAndPack(fmi.parameterDefaults, cell, configuration.seriesCells, configuration.parallelCells);
  const pack = fullPackFacts(design.pack, configuration.seriesCells, configuration.parallelCells);
  const components = componentFacts(design.spec.resolved.components);
  const layout = layoutFacts(design);
  if (canonicalJson(layout.outerDimensionsMm) !== canonicalJson(pack.dimensionsMm)
      || layout.volumeL !== pack.volumeL || layout.packingEfficiency !== pack.packingEfficiency) {
    fail('resolved layout envelope does not match the bound pack facts.');
  }
  return {
    format: FMI_EXPORT_SNAPSHOT_FORMAT,
    fmi,
    source: {
      kind: 'design-result',
      complete: true,
      apiVersion: requireString(design.apiVersion, 'design.apiVersion'),
      binding,
      configuration,
    },
    application: {
      id: configuration.applicationId,
      name: typeof design.application?.name === 'string' ? design.application.name : null,
      class: typeof design.application?.class === 'string' ? design.application.class : null,
    },
    cell: cellFacts(cell, { complete: true }),
    pack,
    architecture: { modulePartition: moduleFacts(design, cell, pack) },
    layout,
    components,
  };
}

function legacySnapshot(cell, s, p, fmi) {
  requireRecord(cell, 'cell');
  requireInteger(s, 's', { positive: true });
  requireInteger(p, 'p', { positive: true });
  validateDefaultsForCellAndPack(fmi.parameterDefaults, cell, s, p);
  const facts = cellFacts(cell, { complete: false });
  return {
    format: FMI_EXPORT_SNAPSHOT_FORMAT,
    fmi,
    source: {
      kind: 'legacy-cell-sp',
      complete: false,
      apiVersion: null,
      binding: null,
      configuration: {
        schemaVersion: null,
        applicationId: null,
        cellId: facts.id,
        seriesCells: s,
        parallelCells: p,
        market: null,
        depthOfDischarge: null,
        isolationContext: null,
        isolationStatus: null,
        sizingDecision: null,
        traceChecksum: null,
      },
    },
    application: null,
    cell: facts,
    pack: legacyPackFacts(cell, s, p),
    architecture: { modulePartition: null },
    layout: null,
    components: null,
  };
}

/**
 * Create the GUID-independent immutable snapshot that an FMU export binds.
 * Supply either a complete designFromSpec() result or all legacy cell/s/p
 * fields. The latter is retained for compatibility and is marked incomplete.
 */
export function createFmiExportSnapshot({
  design = null,
  cell = null,
  s = null,
  p = null,
  modelName,
  defaults,
  ioContractChecksum,
  modelRevision,
  fmiVersion,
  fmiStandardVersion,
} = {}) {
  const hasDesign = design != null;
  const hasAnyLegacy = cell != null || s != null || p != null;
  if (hasDesign && hasAnyLegacy) fail('design and legacy cell/s/p inputs are mutually exclusive.');
  if (!hasDesign && !(cell != null && s != null && p != null)) {
    fail('provide a complete design or all legacy cell/s/p inputs.');
  }
  const fmi = modelContract({
    modelName, defaults, ioContractChecksum, modelRevision, fmiVersion, fmiStandardVersion,
  });
  const snapshot = hasDesign ? fullSnapshot(design, fmi) : legacySnapshot(cell, s, p, fmi);
  const frozenSnapshot = immutableSnapshot(snapshot);
  return immutableSnapshot({
    snapshotChecksum: semanticDigest(frozenSnapshot),
    snapshot: frozenSnapshot,
  });
}

function validateBindingShape(binding) {
  assertExactKeys(binding, [
    'format', 'specSchemaVersion', 'specChecksum', 'semanticChecksum', 'designChecksum',
  ], 'snapshot.source.binding');
  if (binding.format !== 'battery-design/result-binding/v1') fail('snapshot binding format is unsupported.');
  requireString(binding.specSchemaVersion, 'snapshot.source.binding.specSchemaVersion');
  requireSha(binding.specChecksum, 'snapshot.source.binding.specChecksum');
  requireSha(binding.semanticChecksum, 'snapshot.source.binding.semanticChecksum');
  requireSha(binding.designChecksum, 'snapshot.source.binding.designChecksum');
}

function validateNullableString(value, label) {
  if (value != null && typeof value !== 'string') fail(`${label} must be a string or null.`);
}

function validateDimensionsShape(dimensions, label, { nullable = false } = {}) {
  if (dimensions == null && nullable) return;
  requireRecord(dimensions, label);
  const forms = [
    ['diameterMm', 'heightMm'],
    ['widthMm', 'thicknessMm', 'heightMm'],
    ['x', 'y', 'z'],
  ];
  const allowed = forms.find((keys) => keys.length === Object.keys(dimensions).length
    && keys.every((key) => own(dimensions, key)));
  if (!allowed) fail(`${label} has an unsupported dimension shape.`);
  for (const key of allowed) requireFinite(dimensions[key], `${label}.${key}`, { positive: true });
}

function validateBayShape(bay) {
  if (bay == null) return;
  requireRecord(bay, 'snapshot.layout.bay');
  const shapes = {
    box: ['kind', 'xMm', 'yMm', 'zMm'],
    round: ['kind', 'diameterMm', 'zMm'],
    lshape: ['kind', 'xMm', 'yMm', 'cutXmm', 'cutYmm', 'zMm'],
    stepped: ['kind', 'xAmm', 'zAmm', 'xBmm', 'zBmm', 'yMm'],
    poly: ['kind', 'pointsMm', 'zMm'],
  };
  const keys = shapes[bay.kind];
  if (!keys) fail('snapshot.layout.bay kind is unsupported.');
  assertExactKeys(bay, keys, 'snapshot.layout.bay');
  if (bay.kind === 'poly') {
    if (!Array.isArray(bay.pointsMm) || bay.pointsMm.length < 3) {
      fail('snapshot.layout.bay polygon needs at least three points.');
    }
    bay.pointsMm.forEach((point, index) => {
      if (!Array.isArray(point) || point.length !== 2) fail(`snapshot.layout.bay.pointsMm[${index}] must be an [x, y] pair.`);
      point.forEach((coordinate, axis) => requireFinite(
        coordinate, `snapshot.layout.bay.pointsMm[${index}][${axis}]`,
      ));
    });
  }
  for (const key of keys.filter((key) => key !== 'kind' && key !== 'pointsMm')) {
    requireFinite(bay[key], `snapshot.layout.bay.${key}`, { positive: true });
  }
}

function requireSameNumber(actual, expected, label) {
  if (expected == null) {
    if (actual !== null) fail(`${label} must be null when its source fact is unavailable.`);
    return;
  }
  if (!sameNumber(actual, expected)) fail(`${label} does not match the bound cell and pack topology.`);
}

function validateConfigurationIdentity(snapshot) {
  const configuration = snapshot.source.configuration;
  for (const key of [
    'schemaVersion', 'applicationId', 'cellId', 'market', 'isolationContext',
    'isolationStatus', 'sizingDecision',
  ]) validateNullableString(configuration[key], `snapshot.source.configuration.${key}`);
  finiteOrNull(configuration.depthOfDischarge, 'snapshot.source.configuration.depthOfDischarge', { positive: true });

  if (snapshot.source.complete) {
    for (const key of ['schemaVersion', 'applicationId', 'cellId', 'market', 'sizingDecision']) {
      requireString(configuration[key], `snapshot.source.configuration.${key}`);
    }
    if (configuration.depthOfDischarge == null || configuration.depthOfDischarge > 1) {
      fail('snapshot.source.configuration.depthOfDischarge must be a fraction in (0, 1].');
    }
    if (snapshot.source.binding.specSchemaVersion !== configuration.schemaVersion) {
      fail('snapshot binding schema version does not match its configuration identity.');
    }
    if (snapshot.application.id !== configuration.applicationId) {
      fail('snapshot application id does not match its configuration identity.');
    }
    if (snapshot.cell.id !== configuration.cellId) {
      fail('snapshot cell id does not match its configuration identity.');
    }
  } else {
    for (const key of [
      'schemaVersion', 'applicationId', 'market', 'depthOfDischarge', 'isolationContext',
      'isolationStatus', 'sizingDecision', 'traceChecksum',
    ]) {
      if (configuration[key] !== null) {
        fail(`legacy snapshot configuration ${key} must be null.`);
      }
    }
    if (configuration.cellId !== snapshot.cell.id) {
      fail('legacy snapshot cell id does not match its projected cell facts.');
    }
  }
}

function validatePackArithmetic(snapshot) {
  const { cell, pack } = snapshot;
  const cellCount = pack.seriesCells * pack.parallelCells;
  const nominalVoltage = cell.nominalVoltageV == null
    ? null : pack.seriesCells * cell.nominalVoltageV;
  const expected = {
    cellCount,
    nominalVoltageV: nominalVoltage,
    minimumVoltageV: pack.seriesCells * cell.minimumVoltageV,
    maximumVoltageV: pack.seriesCells * cell.maximumVoltageV,
    capacityAh: pack.parallelCells * cell.capacityAh,
    energyWh: nominalVoltage == null ? null : nominalVoltage * pack.parallelCells * cell.capacityAh,
    cellMassKg: cellCount * cell.massKg,
    cellsOnlyResistanceMOhm: cell.dcResistanceMOhm == null
      ? null : (cell.dcResistanceMOhm * pack.seriesCells) / pack.parallelCells,
  };
  for (const [key, value] of Object.entries(expected)) {
    requireSameNumber(pack[key], value, `snapshot.pack.${key}`);
  }
  if (!(pack.maximumVoltageV > pack.minimumVoltageV)) fail('snapshot pack voltage window is not ordered.');

  requireSameNumber(
    pack.maximumContinuousPowerW,
    nominalVoltage == null || pack.maximumContinuousDischargeCurrentA == null
      ? null : nominalVoltage * pack.maximumContinuousDischargeCurrentA,
    'snapshot.pack.maximumContinuousPowerW',
  );
  requireSameNumber(
    pack.maximumContinuousPowerAtMinimumVoltageW,
    pack.maximumContinuousDischargeCurrentA == null
      ? null : pack.minimumVoltageV * pack.maximumContinuousDischargeCurrentA,
    'snapshot.pack.maximumContinuousPowerAtMinimumVoltageW',
  );
  requireSameNumber(
    pack.voltageSagAtMaximumContinuousCurrentV,
    pack.cellsOnlyResistanceMOhm == null || pack.maximumContinuousDischargeCurrentA == null
      ? null : (pack.cellsOnlyResistanceMOhm * pack.maximumContinuousDischargeCurrentA) / 1000,
    'snapshot.pack.voltageSagAtMaximumContinuousCurrentV',
  );

  if (snapshot.source.complete) {
    for (const key of ['id', 'name', 'chemistry', 'form']) {
      requireString(cell[key], `snapshot.cell.${key}`);
    }
    if (cell.nominalVoltageV == null || cell.dimensionsMm == null) {
      fail('a complete snapshot requires nominal voltage and physical cell dimensions.');
    }
    for (const key of [
      'totalMassKg', 'volumeL', 'maximumContinuousDischargeCurrentA',
      'maximumContinuousChargeCurrentA', 'maximumContinuousPowerW',
      'maximumContinuousPowerAtMinimumVoltageW', 'packingEfficiency',
    ]) requireFinite(pack[key], `snapshot.pack.${key}`, { positive: true });
    if (pack.dimensionsMm == null) fail('a complete snapshot requires pack dimensions.');
    if (pack.packingEfficiency > 1) fail('snapshot.pack.packingEfficiency must not exceed one.');

    validateModuleFacts(snapshot.architecture.modulePartition, pack, cell);
    for (const axis of ['x', 'y', 'z']) {
      requireSameNumber(
        snapshot.layout.outerDimensionsMm[axis], pack.dimensionsMm[axis],
        `snapshot.layout.outerDimensionsMm.${axis}`,
      );
    }
    requireSameNumber(snapshot.layout.volumeL, pack.volumeL, 'snapshot.layout.volumeL');
    requireSameNumber(
      snapshot.layout.packingEfficiency, pack.packingEfficiency,
      'snapshot.layout.packingEfficiency',
    );
  } else {
    for (const key of ['totalMassKg', 'dimensionsMm', 'volumeL', 'packingEfficiency']) {
      if (pack[key] !== null) fail(`legacy snapshot pack ${key} must be null.`);
    }
  }
}

function validateProjectedFacts(snapshot) {
  assertExactKeys(snapshot.architecture, ['modulePartition'], 'snapshot.architecture');
  assertExactKeys(snapshot.cell, [
    'id', 'name', 'manufacturer', 'model', 'chemistry', 'form', 'formFactor', 'dimensionsMm',
    'nominalVoltageV', 'minimumVoltageV', 'maximumVoltageV', 'capacityAh', 'massKg',
    'dcResistanceMOhm',
  ], 'snapshot.cell');
  for (const key of ['id', 'name', 'manufacturer', 'model', 'chemistry', 'form', 'formFactor']) {
    validateNullableString(snapshot.cell[key], `snapshot.cell.${key}`);
  }
  validateDimensionsShape(snapshot.cell.dimensionsMm, 'snapshot.cell.dimensionsMm', { nullable: true });
  finiteOrNull(snapshot.cell.nominalVoltageV, 'snapshot.cell.nominalVoltageV', { positive: true });
  requireFinite(snapshot.cell.minimumVoltageV, 'snapshot.cell.minimumVoltageV', { positive: true });
  requireFinite(snapshot.cell.maximumVoltageV, 'snapshot.cell.maximumVoltageV', { positive: true });
  requireFinite(snapshot.cell.capacityAh, 'snapshot.cell.capacityAh', { positive: true });
  requireFinite(snapshot.cell.massKg, 'snapshot.cell.massKg', { positive: true });
  finiteOrNull(snapshot.cell.dcResistanceMOhm, 'snapshot.cell.dcResistanceMOhm', { nonNegative: true });
  if (!(snapshot.cell.maximumVoltageV > snapshot.cell.minimumVoltageV)) fail('snapshot cell voltage window is not ordered.');

  assertExactKeys(snapshot.pack, [
    'seriesCells', 'parallelCells', 'cellCount', 'nominalVoltageV', 'minimumVoltageV',
    'maximumVoltageV', 'capacityAh', 'energyWh', 'cellMassKg', 'totalMassKg', 'dimensionsMm',
    'volumeL', 'maximumContinuousDischargeCurrentA', 'maximumPulseDischargeCurrentA',
    'maximumContinuousChargeCurrentA', 'maximumContinuousPowerW',
    'maximumContinuousPowerAtMinimumVoltageW', 'cellsOnlyResistanceMOhm',
    'voltageSagAtMaximumContinuousCurrentV', 'packingEfficiency',
  ], 'snapshot.pack');
  for (const key of ['seriesCells', 'parallelCells', 'cellCount']) {
    requireInteger(snapshot.pack[key], `snapshot.pack.${key}`, { positive: true });
  }
  for (const key of ['minimumVoltageV', 'maximumVoltageV', 'capacityAh', 'cellMassKg']) {
    requireFinite(snapshot.pack[key], `snapshot.pack.${key}`, { positive: true });
  }
  for (const key of [
    'nominalVoltageV', 'energyWh', 'totalMassKg', 'volumeL',
    'maximumContinuousDischargeCurrentA', 'maximumPulseDischargeCurrentA',
    'maximumContinuousChargeCurrentA', 'maximumContinuousPowerW',
    'maximumContinuousPowerAtMinimumVoltageW', 'cellsOnlyResistanceMOhm',
    'voltageSagAtMaximumContinuousCurrentV', 'packingEfficiency',
  ]) finiteOrNull(snapshot.pack[key], `snapshot.pack.${key}`, { nonNegative: true });
  validateDimensionsShape(snapshot.pack.dimensionsMm, 'snapshot.pack.dimensionsMm', { nullable: true });

  if (snapshot.source.complete) {
    assertExactKeys(snapshot.application, ['id', 'name', 'class'], 'snapshot.application');
    requireString(snapshot.application.id, 'snapshot.application.id');
    validateNullableString(snapshot.application.name, 'snapshot.application.name');
    validateNullableString(snapshot.application.class, 'snapshot.application.class');
    const module = snapshot.architecture.modulePartition;
    assertExactKeys(module, [
      'seriesCellsPerModule', 'parallelCellsPerModule', 'moduleCount', 'virtual', 'cellsPerModule',
      'nominalVoltagePerModuleV', 'maximumVoltagePerModuleV', 'energyPerModuleWh',
      'cellMassPerModuleKg',
    ], 'snapshot.architecture.modulePartition');
    for (const key of ['seriesCellsPerModule', 'parallelCellsPerModule', 'moduleCount', 'cellsPerModule']) {
      requireInteger(module[key], `snapshot.architecture.modulePartition.${key}`, { positive: true });
    }
    if (typeof module.virtual !== 'boolean') fail('snapshot module virtual flag must be boolean.');
    for (const key of [
      'nominalVoltagePerModuleV', 'maximumVoltagePerModuleV', 'energyPerModuleWh', 'cellMassPerModuleKg',
    ]) requireFinite(module[key], `snapshot.architecture.modulePartition.${key}`, { positive: true });

    assertExactKeys(snapshot.layout, [
      'arrangement', 'orientation', 'spacingMm', 'layerGapMm', 'wallMm', 'headroomMm',
      'underMm', 'rowExtraMm', 'columns', 'layers', 'bay', 'outerDimensionsMm', 'volumeL',
      'packingEfficiency',
    ], 'snapshot.layout');
    requireString(snapshot.layout.arrangement, 'snapshot.layout.arrangement');
    requireString(snapshot.layout.orientation, 'snapshot.layout.orientation');
    for (const key of ['spacingMm', 'layerGapMm', 'wallMm', 'headroomMm', 'underMm', 'rowExtraMm']) {
      requireFinite(snapshot.layout[key], `snapshot.layout.${key}`, { nonNegative: true });
    }
    requireInteger(snapshot.layout.columns, 'snapshot.layout.columns', { positive: true });
    requireInteger(snapshot.layout.layers, 'snapshot.layout.layers', { positive: true });
    validateBayShape(snapshot.layout.bay);
    validateDimensionsShape(snapshot.layout.outerDimensionsMm, 'snapshot.layout.outerDimensionsMm');
    requireFinite(snapshot.layout.volumeL, 'snapshot.layout.volumeL', { positive: true });
    requireFinite(snapshot.layout.packingEfficiency, 'snapshot.layout.packingEfficiency', { positive: true });
    assertExactKeys(snapshot.components, COMPONENT_KEYS, 'snapshot.components');
    for (const key of COMPONENT_KEYS) validateNullableString(snapshot.components[key], `snapshot.components.${key}`);
  }
}

function validateSnapshotShape(snapshot) {
  assertExactKeys(snapshot, [
    'format', 'fmi', 'source', 'application', 'cell', 'pack', 'architecture', 'layout', 'components',
  ], 'snapshot');
  if (snapshot.format !== FMI_EXPORT_SNAPSHOT_FORMAT) fail('snapshot format is unsupported.');
  assertExactKeys(snapshot.fmi, [
    'version', 'standardPatch', 'modelRevision', 'modelIdentifier', 'ioContractChecksum', 'parameterDefaults',
  ], 'snapshot.fmi');
  requireString(snapshot.fmi.version, 'snapshot.fmi.version');
  requireString(snapshot.fmi.standardPatch, 'snapshot.fmi.standardPatch');
  requireString(snapshot.fmi.modelRevision, 'snapshot.fmi.modelRevision');
  if (!MODEL_IDENTIFIER.test(snapshot.fmi.modelIdentifier || '')) fail('snapshot.fmi.modelIdentifier is invalid.');
  requireSha(snapshot.fmi.ioContractChecksum, 'snapshot.fmi.ioContractChecksum');
  sortedFiniteDefaults(snapshot.fmi.parameterDefaults);

  assertExactKeys(snapshot.source, ['kind', 'complete', 'apiVersion', 'binding', 'configuration'], 'snapshot.source');
  if (!['design-result', 'legacy-cell-sp'].includes(snapshot.source.kind)) fail('snapshot source kind is unsupported.');
  if (typeof snapshot.source.complete !== 'boolean') fail('snapshot.source.complete must be boolean.');
  assertExactKeys(snapshot.source.configuration, [
    'schemaVersion', 'applicationId', 'cellId', 'seriesCells', 'parallelCells', 'market',
    'depthOfDischarge', 'isolationContext', 'isolationStatus', 'sizingDecision', 'traceChecksum',
  ], 'snapshot.source.configuration');
  requireInteger(snapshot.source.configuration.seriesCells, 'snapshot configuration seriesCells', { positive: true });
  requireInteger(snapshot.source.configuration.parallelCells, 'snapshot configuration parallelCells', { positive: true });
  if (snapshot.source.configuration.traceChecksum != null) {
    requireSha(snapshot.source.configuration.traceChecksum, 'snapshot source traceChecksum');
  }

  if (snapshot.source.complete) {
    if (snapshot.source.kind !== 'design-result') fail('a complete snapshot must have design-result provenance.');
    requireString(snapshot.source.apiVersion, 'snapshot.source.apiVersion');
    validateBindingShape(requireRecord(snapshot.source.binding, 'snapshot.source.binding'));
    requireRecord(snapshot.application, 'snapshot.application');
    requireRecord(snapshot.layout, 'snapshot.layout');
    requireRecord(snapshot.components, 'snapshot.components');
    requireRecord(snapshot.architecture?.modulePartition, 'snapshot.architecture.modulePartition');
  } else {
    if (snapshot.source.kind !== 'legacy-cell-sp' || snapshot.source.apiVersion !== null
        || snapshot.source.binding !== null || snapshot.application !== null
        || snapshot.layout !== null || snapshot.components !== null
        || snapshot.architecture?.modulePartition !== null) {
      fail('an incomplete legacy snapshot must not claim full design provenance.');
    }
  }

  requireRecord(snapshot.cell, 'snapshot.cell');
  requireRecord(snapshot.pack, 'snapshot.pack');
  requireRecord(snapshot.architecture, 'snapshot.architecture');
  validateProjectedFacts(snapshot);
  validateConfigurationIdentity(snapshot);
  validatePackArithmetic(snapshot);
  if (snapshot.pack.seriesCells !== snapshot.source.configuration.seriesCells
      || snapshot.pack.parallelCells !== snapshot.source.configuration.parallelCells) {
    fail('snapshot pack counts do not match its source configuration.');
  }
  if (snapshot.pack.cellCount !== snapshot.pack.seriesCells * snapshot.pack.parallelCells) {
    fail('snapshot pack cellCount does not equal series multiplied by parallel.');
  }
  validateDefaultsForCellAndPack(
    snapshot.fmi.parameterDefaults,
    {
      capacityAh: snapshot.cell.capacityAh,
      vMin: snapshot.cell.minimumVoltageV,
      vMax: snapshot.cell.maximumVoltageV,
      massG: snapshot.cell.massKg * 1000,
    },
    snapshot.pack.seriesCells,
    snapshot.pack.parallelCells,
  );
  if (snapshot.layout && own(snapshot.layout, 'positions')) fail('layout positions are not allowed in the compact FMU resource.');
}

/**
 * Verify a parsed packaged resource without rebuilding its DesignSpec. Any
 * supplied expected contract fields are checked against the snapshot.
 */
export function verifyFmiDesignResource(resource, expected = {}) {
  assertExactKeys(resource, ['format', 'guid', 'snapshotChecksum', 'snapshot'], 'resource');
  if (resource.format !== FMI_DESIGN_RESOURCE_FORMAT) fail('resource format is unsupported.');
  if (typeof resource.guid !== 'string' || !GUID.test(resource.guid)) fail('resource guid is invalid.');
  requireSha(resource.snapshotChecksum, 'resource.snapshotChecksum');
  const snapshot = requireRecord(resource.snapshot, 'resource.snapshot');
  validateSnapshotShape(snapshot);
  const calculated = semanticDigest(snapshot);
  if (calculated !== resource.snapshotChecksum) fail('snapshot checksum does not match its content.');
  const fmi = snapshot.fmi;
  const checks = [
    ['guid', resource.guid],
    ['modelIdentifier', fmi.modelIdentifier],
    ['ioContractChecksum', fmi.ioContractChecksum],
    ['modelRevision', fmi.modelRevision],
    ['fmiVersion', fmi.version],
    ['fmiStandardVersion', fmi.standardPatch],
  ];
  for (const [name, actual] of checks) {
    if (own(expected, name) && expected[name] !== actual) fail(`${name} does not match the expected FMU contract.`);
  }
  if (own(expected, 'defaults')) {
    const wanted = sortedFiniteDefaults(expected.defaults);
    if (canonicalJson(wanted) !== canonicalJson(fmi.parameterDefaults)) {
      fail('parameter defaults do not match the expected FMU contract.');
    }
  }
  if (expected.requireComplete === true && snapshot.source.complete !== true) {
    fail('a complete design-bound resource is required.');
  }
  return immutableSnapshot(resource);
}

/** Add the final GUID outside the checksum-bearing snapshot. */
export function materializeFmiDesignResource({ snapshot, snapshotChecksum, guid } = {}) {
  const resource = {
    format: FMI_DESIGN_RESOURCE_FORMAT,
    guid,
    snapshotChecksum,
    snapshot,
  };
  return verifyFmiDesignResource(resource, { guid });
}

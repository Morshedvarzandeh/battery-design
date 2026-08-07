// The GUI and MCP inspection surfaces must project the same generated FMU
// resources. They may not grow a second port list or echo the source design.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

import { designFromSpec, normalizeDesignSpec } from '../js/api.js';
import { buildFmu } from '../js/fmi.js';
import { FMI_INSPECTION_FORMAT, inspectFmiBuild } from '../js/desktop-link.js';
import { handleMessage } from '../desktop/mcp-server.mjs';
import { semanticDigest } from '../js/ontology.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RELEASE_SPEC = JSON.parse(readFileSync(
  path.join(ROOT, 'fmi', 'battery-design-ev.design-spec.json'), 'utf8',
));

function releaseBuild(options = {}) {
  const spec = normalizeDesignSpec(RELEASE_SPEC, { strict: true, closed: true });
  return buildFmu({ design: designFromSpec(spec), ...options });
}

test('one safe inspection view projects canonical ports and static design facts', () => {
  const build = releaseBuild();
  const inspection = inspectFmiBuild(build);

  assert.equal(build.generatedOn, '1970-01-01T00:00:00Z',
    'the timestamp used to generate modelDescription remains available for authentication');
  assert.equal(inspection.format, FMI_INSPECTION_FORMAT);
  assert.equal(inspection.identity.guid, build.guid);
  assert.equal(inspection.identity.ioContractChecksum, build.ioMap.contractChecksum);
  assert.equal(inspection.identity.designSnapshotChecksum, build.designResource.snapshotChecksum);
  assert.deepEqual(
    inspection.ports.parameters.map(({ name }) => name),
    build.ioMap.variables.filter(({ causality }) => causality === 'parameter').map(({ name }) => name),
  );
  assert.deepEqual(
    inspection.ports.inputs.map(({ name }) => name),
    ['I_pack', 'T_ambient', 'coolant_flow'],
  );
  assert.deepEqual(
    inspection.ports.outputs.map(({ name }) => name),
    ['V_pack', 'SoC', 'T_cell', 'Q_loss', 'V_cell_min', 'P_terminal'],
  );
  assert.equal(inspection.staticDesign.pack.cellCount, 4730);
  assert.equal(inspection.staticDesign.architecture.modulePartition.moduleCount, 10);
  assert.equal(inspection.staticDesign.layout.columns, 64);
  assert.equal(inspection.staticDesign.source.binding.designChecksum, build.designBinding.designChecksum);
  assert.equal(inspection.ports.inputs[0].cSymbol, undefined,
    'host inspection omits C implementation details while retaining contract semantics');
  assert.ok(JSON.stringify(inspection).length < 16_000, 'the structured inspection remains compact');
  assert.ok(Object.isFrozen(inspection) && Object.isFrozen(inspection.ports.inputs[0])
    && Object.isFrozen(inspection.staticDesign.pack), 'the inspection snapshot is deeply immutable');

  const nestedTamper = JSON.parse(JSON.stringify(build));
  nestedTamper.designResource.snapshot.pack.cellCount = 1;
  nestedTamper.designResource.snapshot.pack.privateEvidence = 'PRIVATE-INSPECTION-MARKER';
  assert.throws(() => inspectFmiBuild(nestedTamper), /resource|snapshot|keys/i,
    'nested data cannot be changed or injected beneath duplicated outer checksums');

  for (const mutate of [
    (value) => { value.ioMap.variables.pop(); },
    (value) => { value.ioMap.variables[14].name = 'rewritten_current'; },
    (value) => { value.ioMap.variables.push({ ...value.ioMap.variables[14] }); },
  ]) {
    const mappedTamper = JSON.parse(JSON.stringify(build));
    mutate(mappedTamper);
    mappedTamper.files['resources/battery-design-io-map.json']
      = `${JSON.stringify(mappedTamper.ioMap, null, 2)}\n`;
    assert.throws(() => inspectFmiBuild(mappedTamper), /canonical FMU resource/,
      'rewritten, removed or duplicated ports cannot retain the canonical contract claim');
  }

  const modelTamper = JSON.parse(JSON.stringify(build));
  modelTamper.designResource.snapshot.fmi.modelIdentifier = 'OtherModel';
  modelTamper.designResource.snapshotChecksum = semanticDigest(modelTamper.designResource.snapshot);
  modelTamper.designSnapshotChecksum = modelTamper.designResource.snapshotChecksum;
  modelTamper.files['resources/battery-design-design.json']
    = `${JSON.stringify(modelTamper.designResource, null, 2)}\n`;
  assert.throws(() => inspectFmiBuild(modelTamper), /modelIdentifier does not match/,
    'a coordinated resource/checksum rewrite cannot change the component identity');

  const fileTamper = JSON.parse(JSON.stringify(build));
  const fileMap = JSON.parse(fileTamper.files['resources/battery-design-io-map.json']);
  fileMap.variables[14].signConvention = 'ambiguous';
  fileTamper.files['resources/battery-design-io-map.json'] = `${JSON.stringify(fileMap, null, 2)}\n`;
  assert.throws(() => inspectFmiBuild(fileTamper), /battery-design-io-map\.json/,
    'the downloaded resource and inspected object must be the same mapping');

  for (const [label, mutate] of [
    ['XML', (value) => { value.files['modelDescription.xml'] += '\n<!-- changed -->\n'; }],
    ['C source', (value) => { value.files['sources/BatteryPack.c'] += '\n/* changed */\n'; }],
    ['README', (value) => { value.files['README.md'] += '\nChanged instructions.\n'; }],
    ['extra file', (value) => { value.files['sources/unreviewed.c'] = 'unreviewed'; }],
    ['missing file', (value) => { delete value.files['README.md']; }],
  ]) {
    const sourceTamper = JSON.parse(JSON.stringify(build));
    mutate(sourceTamper);
    assert.throws(() => inspectFmiBuild(sourceTamper), /source-kit/i,
      `${label} tampering cannot retain the authenticated source-kit claim`);
  }

  const generatedOn = '2026-08-07T10:15:30.000Z';
  const datedBuild = releaseBuild({ generatedOn });
  assert.equal(datedBuild.generatedOn, generatedOn);
  assert.doesNotThrow(() => inspectFmiBuild(datedBuild),
    'a caller-selected generation time is retained and regenerates the exact XML bytes');
  assert.throws(() => buildFmu({
    design: designFromSpec(normalizeDesignSpec(RELEASE_SPEC, { strict: true, closed: true })),
    generatedOn: 'not-a-timestamp',
  }), /generatedOn/);
});

test('MCP exposes a closed read-only DesignSpec-to-FMI mapping tool', () => {
  const tools = handleMessage({ id: 1, method: 'tools/list' }).tools;
  const tool = tools.find(({ name }) => name === 'inspect_fmi_mapping');
  assert.ok(tool, 'the mapping inspector is discoverable');
  assert.equal(tool.annotations.readOnlyHint, true);
  assert.equal(tool.annotations.openWorldHint, false);
  assert.equal(tool.inputSchema.additionalProperties, false);
  assert.equal(tool.inputSchema.properties.layout.additionalProperties, false);
  assert.equal(tool.inputSchema.properties.components.additionalProperties, false);
  assert.equal(tool.inputSchema.$defs.shunt.properties.supplier.additionalProperties, true,
    'intentionally open supplier evidence remains representable in the advertised schema');
  assert.equal(tool.inputSchema.$defs.shunt.properties.currentSegments.items.additionalProperties, true,
    'intentionally open current segments remain representable in the advertised schema');
  assert.equal(tool.inputSchema.$defs.twinValidationEvidence.additionalProperties, false);
  assert.ok(tool.inputSchema.$defs.twinValidationEvidence.properties.trialId
    && tool.inputSchema.$defs.twinValidationEvidence.properties.result,
  'composed validation evidence is advertised as one satisfiable closed object');
  assert.ok(tool.inputSchema.required.includes('schemaVersion'));

  const result = handleMessage({
    id: 2,
    method: 'tools/call',
    params: { name: 'inspect_fmi_mapping', arguments: RELEASE_SPEC },
  });
  assert.equal(result.isError, undefined);
  assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent,
    'legacy text clients and structured MCP clients see the same generated mapping');
  assert.equal(result.structuredContent.format, FMI_INSPECTION_FORMAT);
  assert.equal(result.structuredContent.ports.parameters.length, 14);
  assert.equal(result.structuredContent.ports.inputs.length, 3);
  assert.equal(result.structuredContent.ports.outputs.length, 6);
  assert.equal(result.structuredContent.staticDesign.source.complete, true);
  assert.equal(result.structuredContent.staticDesign.pack.cellCount, 4730);
  assert.ok(result.structuredContent.ports.inputs.every((port) => port.role && port.sourceBinding
    && port.signConvention && port.updateSemantics), 'host-facing semantics come from the canonical contract');
  assert.doesNotMatch(result.content[0].text, /modelDescription\.xml|sources\/|rawPrivateEvidence/,
    'the read-only result does not expose source-kit files or raw evidence');

  const privateSpec = {
    ...RELEASE_SPEC,
    twinShip: {
      readiness: {
        powerBasis: 'dc-bus-trace',
        assetEvidence: {
          assetId: 'PRIVATE-MCP-ASSET-DO-NOT-ECHO', vesselId: 'ntnu-gunnerus',
          evidenceId: 'PRIVATE-MCP-EVIDENCE-DO-NOT-ECHO', revision: 'private-revision',
          issuedAt: '2026-08-01T00:00:00Z', sha256: 'a'.repeat(64),
        },
      },
    },
  };
  const privateResult = handleMessage({
    id: 3,
    method: 'tools/call',
    params: { name: 'inspect_fmi_mapping', arguments: privateSpec },
  });
  assert.equal(privateResult.isError, undefined);
  assert.doesNotMatch(privateResult.content[0].text,
    /PRIVATE-MCP-ASSET-DO-NOT-ECHO|PRIVATE-MCP-EVIDENCE-DO-NOT-ECHO|private-revision/,
    'governed evidence can affect the binding checksum without being echoed');

  const validationEvidence = {
    trialId: 'trial-001', vesselId: 'ntnu-gunnerus', assetId: 'asset-001',
    datasetSha256: 'b'.repeat(64), modelArtifactSha256: 'c'.repeat(64),
    completedAt: '2026-08-01T00:00:00Z', result: 'pass',
    metrics: { speedRmsKn: 0.1, courseRmsDeg: 0.2, powerRmsFraction: 0.03 },
    limits: { speedRmsKn: 0.5, courseRmsDeg: 1, powerRmsFraction: 0.1 },
  };
  const composed = handleMessage({
    id: 31,
    method: 'tools/call',
    params: {
      name: 'inspect_fmi_mapping',
      arguments: {
        ...RELEASE_SPEC,
        twinShip: { readiness: { powerBasis: 'dc-bus-trace', validationEvidence } },
        electricalProtection: {
          shunt: {
            supplier: { part: 'CUSTOM-50', revision: 'A' },
            currentSegments: [{ currentA: 100, durationS: 5 }],
          },
        },
      },
    },
  });
  assert.equal(composed.isError, undefined,
    composed.content?.[0]?.text || 'composed/open governed evidence should be accepted');

  const typo = handleMessage({
    id: 4,
    method: 'tools/call',
    params: { name: 'inspect_fmi_mapping', arguments: { ...RELEASE_SPEC, enrgyWh: 60_000 } },
  });
  assert.equal(typo.isError, true);
  assert.match(typo.content[0].text, /enrgyWh: Field is not declared/);

  const unversioned = handleMessage({
    id: 5,
    method: 'tools/call',
    params: { name: 'inspect_fmi_mapping', arguments: { application: 'ev' } },
  });
  assert.equal(unversioned.isError, true);
  assert.match(unversioned.content[0].text, /must declare schemaVersion/);
});

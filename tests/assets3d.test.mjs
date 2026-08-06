// Reusable 3D asset-library integrity and renderer-boundary tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  ASSET_LIBRARY3D_LICENSE,
  ASSET_LIBRARY3D_VERSION,
  HOST_ASSET_KINDS,
  REPORT_ASSET_IDS,
  VESSEL_ASSET_IDS,
  asset3dCatalog,
  fixedAsset3dById,
  instantiateHostAsset3d,
  validateAsset3d,
} from '../assets3d/catalog.js';

test('the standalone 3D catalog has stable identity and explicit reusable licensing', () => {
  const catalog = asset3dCatalog();
  assert.equal(catalog.version, ASSET_LIBRARY3D_VERSION);
  assert.equal(ASSET_LIBRARY3D_LICENSE.spdx, 'MIT');
  assert.equal(ASSET_LIBRARY3D_LICENSE.thirdPartyAsset, false);
  const ids = [...catalog.fixed, ...catalog.templates].map((entry) => entry.assetId);
  assert.equal(new Set(ids).size, ids.length, 'asset ids are globally unique');
  for (const entry of [...catalog.fixed, ...catalog.templates]) {
    assert.match(entry.version, /^\d+\.\d+\.\d+$/);
    assert.equal(entry.licence.spdx, 'MIT');
    assert.equal(entry.licence.thirdPartyAsset, false);
    assert.equal(entry.visualStyle, 'flat-technical');
    assert.deepEqual(entry.effects, { castShadows: false, decorativeWake: false });
  }
});

test('every car, vessel, machine and product host is supplied by the asset library', () => {
  assert.deepEqual(HOST_ASSET_KINDS, [
    'car', 'bus', 'van', 'bike', 'scooter', 'boat', 'drone', 'agv',
    'humanoid', 'quadruped', 'puck', 'cabinet', 'box', 'handtool', 'wrist',
  ]);
  for (const kind of HOST_ASSET_KINDS) {
    const asset = instantiateHostAsset3d(kind, { x: 2, y: 4, z: 1.5 });
    const validation = validateAsset3d(asset);
    assert.equal(validation.valid, true, `${kind}: ${validation.errors.join('; ')}`);
    assert.equal(asset.assetId, `host/${kind}`);
    assert.ok(asset.primitives.length > 0, `${kind}: drawable geometry`);
  }
});

test('both marine visuals are mesh-led engineering assets, not box-count massing models', () => {
  for (const assetId of Object.values(VESSEL_ASSET_IDS)) {
    const asset = fixedAsset3dById(assetId);
    const validation = validateAsset3d(asset);
    assert.equal(validation.valid, true, `${assetId}: ${validation.errors.join('; ')}`);
    const meshes = asset.primitives.filter((primitive) => primitive.kind === 'mesh');
    const triangles = meshes.reduce((sum, primitive) => sum + primitive.triangles.length, 0);
    assert.ok(meshes.some((primitive) => primitive.role === 'hull'), `${assetId}: shaped hull mesh`);
    assert.ok(triangles >= 80, `${assetId}: enough faceted surface definition at screenshot distance`);
    assert.equal(asset.scenePreset, 'ocean');
    assert.equal(asset.kind, 'low-poly-engineering-visual');
    assert.match(asset.geometryDigest, /^fnv1a32:[0-9a-f]{8}$/);
  }
});

test('the report library contains reusable stationary-storage and thermal-system assets', () => {
  const storage = fixedAsset3dById(REPORT_ASSET_IDS.stationaryStorage);
  const forcedAir = fixedAsset3dById(REPORT_ASSET_IDS.forcedAirThermalSystem);
  const radiator = fixedAsset3dById(REPORT_ASSET_IDS.liquidRadiatorThermalSystem);
  const chilled = fixedAsset3dById(REPORT_ASSET_IDS.liquidThermalSystem);
  for (const asset of [storage, forcedAir, radiator, chilled]) {
    const validation = validateAsset3d(asset);
    assert.equal(validation.valid, true, validation.errors.join('; '));
    assert.match(asset.geometryDigest, /^fnv1a32:[0-9a-f]{8}$/);
  }
  assert.ok(storage.primitives.some((primitive) => primitive.role === 'battery-cabinet'));
  assert.ok(storage.primitives.some((primitive) => primitive.role === 'pcs-cabinet'));
  for (const role of ['air-filter', 'fan', 'air-duct']) {
    assert.ok(forcedAir.primitives.some((primitive) => primitive.role === role), `forced-air system exposes ${role}`);
  }
  for (const role of ['cold-plate', 'coolant-channel', 'pump', 'radiator']) {
    assert.ok(radiator.primitives.some((primitive) => primitive.role === role), `radiator loop exposes ${role}`);
  }
  assert.equal(radiator.primitives.some((primitive) => primitive.role === 'chiller'), false);
  assert.ok(chilled.primitives.some((primitive) => primitive.role === 'chiller'));
});

test('geometry digests fail closed when a reusable primitive is changed', () => {
  const asset = fixedAsset3dById(REPORT_ASSET_IDS.stationaryStorage);
  const changed = JSON.parse(JSON.stringify(asset));
  changed.primitives[0].sizeM.x += 0.01;
  const result = validateAsset3d(changed);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => /digest does not match/.test(error)));
});

test('every fixed asset remains inside its declared visual envelope', () => {
  for (const { assetId } of asset3dCatalog().fixed) {
    const asset = fixedAsset3dById(assetId);
    const envelope = asset.envelopeM;
    for (const primitive of asset.primitives) {
      assert.ok(Math.abs(primitive.atM.x) + primitive.sizeM.x / 2 <= envelope.x / 2 + 1e-9, `${assetId}/${primitive.name}: beam`);
      assert.ok(Math.abs(primitive.atM.y) + primitive.sizeM.y / 2 <= envelope.y / 2 + 1e-9, `${assetId}/${primitive.name}: length`);
      assert.ok(primitive.atM.z - primitive.sizeM.z / 2 >= envelope.zMin - 1e-9, `${assetId}/${primitive.name}: lower bound`);
      assert.ok(primitive.atM.z + primitive.sizeM.z / 2 <= envelope.zMax + 1e-9, `${assetId}/${primitive.name}: upper bound`);
    }
  }
});

test('malformed or unlicensed models fail closed at the asset boundary', () => {
  assert.equal(validateAsset3d(null).valid, false);
  const valid = fixedAsset3dById(VESSEL_ASSET_IDS.milliAmpere1);
  const unlicensed = { ...valid, licence: { spdx: 'unknown', thirdPartyAsset: true } };
  assert.equal(validateAsset3d(unlicensed).valid, false);
  const corrupt = { ...valid, primitives: [{ ...valid.primitives[0], sizeM: { x: 0, y: 1, z: 1 } }] };
  assert.equal(validateAsset3d(corrupt).valid, false);
});

test('Godot is a generic asset consumer and contains no car or ship model library', () => {
  const renderer = readFileSync(new URL('../garage3d/garage.gd', import.meta.url), 'utf8');
  assert.doesNotMatch(renderer, /func _build_machine|func _wheel|func _glass/);
  assert.match(renderer, /kind not in \["box", "mesh", "cylinder"\]/);
  assert.match(renderer, /surface\.generate_normals\(\)/);
  assert.match(renderer, /func _asset_material/);
  for (const assetId of Object.values(VESSEL_ASSET_IDS)) assert.equal(renderer.includes(assetId), false);
  for (const kind of HOST_ASSET_KINDS.filter((entry) => entry !== 'box')) {
    assert.equal(renderer.includes(`"${kind}":`), false, `${kind}: no renderer-owned model`);
  }
});

test('the marine presentation contract includes a clean camera, ocean and mobile controls', () => {
  const renderer = readFileSync(new URL('../garage3d/garage.gd', import.meta.url), 'utf8');
  for (const token of ['WaterPlane', 'BOW', 'PORT', 'AFT', 'TOP']) assert.ok(renderer.includes(token));
  assert.doesNotMatch(renderer, /shadow_enabled\s*=\s*true|WakeRibbon/);
  assert.match(renderer, /result\.shading_mode\s*=\s*BaseMaterial3D\.SHADING_MODE_UNSHADED/);
  assert.match(renderer, /InputEventScreenDrag/);
  assert.match(renderer, /_current_pinch_distance/);
  assert.match(renderer, /InputEventMagnifyGesture/);
});

// The 3D scene — a face over the engine, and nothing more.
//
// The whole safety argument for putting a game engine in this tool is that
// the engine computes nothing. These tests are what makes that argument
// checkable rather than a promise in a comment: every coordinate, size and
// name in the scene has to be traceable to the design it came from, so a
// renderer written in another language cannot quietly acquire an opinion.
//
// They also guard the boundary itself. A payload crossing a postMessage gap
// into GDScript has no type checker on the far side; if a field is renamed
// here it fails silently over there, and the customer sees a pack from two
// swaps ago rather than an error.
import { test } from 'node:test';
import { ok, near } from './helpers.mjs';
import { buildScene, SCENE_VERSION, MSG, isSceneMessage } from '../js/scene3d.js';
import { designFromSpec } from '../js/api.js';
import { layoutPack, defaultArrangement } from '../js/pack-engine.js';
import { cellById, CHEMISTRIES } from '../js/cells.js';
import { componentById } from '../js/components.js';
import { PRESETS } from '../js/presets.js';
import { hostFor, packSeat, fitInHost } from '../js/hosts.js';
import { vehicleDefaultsFor } from '../js/vehicle.js';

// Build a design and the layout that goes with it, the way the app does:
// the cooling system is chosen first because it takes space out of the box.
function sceneFor(spec) {
  const design = designFromSpec(spec);
  const cell = cellById(design.spec.resolved.cell);
  const cool = componentById('cooling', design.spec.resolved.components.cooling);
  const space = cool?.spaceMm || { bottom: 0, side: 0, rowGap: 0 };
  const layout = layoutPack(cell, design.pack.s, design.pack.p, {
    arrangement: defaultArrangement(cell), spacingMm: 1, wallMm: 2, headroomMm: 8,
    underMm: space.bottom, rowExtraMm: space.rowGap,
  });
  return { design, layout, scene: buildScene({ design, layout }) };
}

test('every cell in the scene is where the pack engine put it', () => {
  // The claim the whole module rests on. Not "close to" — the same number.
  const { layout, scene } = sceneFor({ application: 'ebike' });
  ok(scene.cells.count === layout.positions.length, 'every cell is in the scene');
  ok(scene.cells.xyz.length === layout.positions.length * 3, 'three coordinates each');
  for (let i = 0; i < layout.positions.length; i++) {
    const q = layout.positions[i];
    // Rounded to 1/100 mm for the wire; a hundredth of a millimetre is well
    // below any tolerance a battery is built to and saves a third of the payload.
    near(scene.cells.xyz[i * 3], Math.round(q.x * 100) / 100, 1e-9, `cell ${i} x`);
    near(scene.cells.xyz[i * 3 + 1], Math.round(q.y * 100) / 100, 1e-9, `cell ${i} y`);
    near(scene.cells.xyz[i * 3 + 2], Math.round(q.z * 100) / 100, 1e-9, `cell ${i} z`);
    ok(scene.cells.group[i] === q.sIndex, `cell ${i} is in the series group the engine assigned`);
  }
  // And the box is the engine's box, not a bounding box of the cells.
  for (const k of ['x', 'y', 'z']) {
    near(scene.pack.outer[k], layout.outer[k], 1e-9, `outer ${k}`);
    near(scene.pack.inner[k], layout.inner[k], 1e-9, `inner ${k}`);
  }
});

test('the scene draws the parts that were actually fitted', () => {
  const { design, scene } = sceneFor({ application: 'ev', energyWh: 60000 });
  const fitted = design.spec.resolved.components;
  for (const p of scene.parts) {
    ok(p.id === (fitted[p.category] ?? null),
      `${p.category}: the scene shows what the engine fitted, not a default of its own`);
  }
  // A category with nothing fitted is stated, not omitted — an absent vent is
  // a fact about the design, and a silently missing row reads as an oversight.
  ok(scene.parts.length === 6, 'all six categories are accounted for');
});

test('the cooling system changes the scene, because it changes the pack', () => {
  const passive = sceneFor({ application: 'ev', energyWh: 60000, components: { cooling: 'passive-air' } });
  const plate = sceneFor({ application: 'ev', energyWh: 60000, components: { cooling: 'bottom-cold-plate' } });
  ok(plate.scene.pack.outer.z > passive.scene.pack.outer.z,
    'a cold plate makes the box taller, in the scene as in the design');
  const coolShapes = (s) => s.parts.find((p) => p.category === 'cooling').shapes;
  ok(coolShapes(passive.scene).length === 0, 'natural convection is not hardware, so nothing is drawn');
  ok(coolShapes(plate.scene).length === 1, 'a cold plate is');
  const slab = coolShapes(plate.scene)[0];
  ok(slab.at.z < -passive.scene.pack.inner.z / 2, 'and it sits under the cells, where the layout reserved the space');

  // Between-cell cooling draws one ribbon per row gap, in the gaps the layout
  // actually opened — not a decorative number chosen to look busy.
  const ribbon = sceneFor({ application: 'ev', energyWh: 60000, components: { cooling: 'serpentine-ribbon' } });
  const ribbons = coolShapes(ribbon.scene);
  ok(ribbons.length === ribbon.layout.ny - 1,
    `${ribbons.length} ribbons for ${ribbon.layout.ny} rows — one per gap, no more`);
  for (const r of ribbons) near(r.size.y, 2, 1e-9, 'each is the width the layout reserved');
});

test('chemistry colour comes from the cell database, not a copy of it', () => {
  // It was a copy once, keyed in lower case against chemistries spelled NCA
  // and NMC, so every cell fell through to grey and the 3D view was the one
  // place chemistry did not show.
  for (const id of ['samsung-inr21700-50e', 'catl-302ah-lfp']) {
    const { scene } = sceneFor({ application: 'ev', cell: id, s: 10, p: 4 });
    const chem = cellById(id).chemistry;
    ok(scene.cell.color === CHEMISTRIES[chem].color,
      `${id} (${chem}) is drawn in the palette's colour, ${CHEMISTRIES[chem].color}`);
    ok(scene.cell.color !== '#6f7b78', 'and not the fallback grey');
  }
});

test('the audit travels with the scene', () => {
  // So a failing pack cannot be admired in 3D while the panel that says it
  // fails sits on a tab nobody opened.
  const { design, scene } = sceneFor({ application: 'ev', energyWh: 60000 });
  ok(scene.audit.fail === design.findings.filter((f) => f.severity === 'fail').length, 'fails counted');
  ok(scene.audit.warn === design.findings.filter((f) => f.severity === 'warn').length, 'warns counted');
  if (scene.audit.fail > 0) ok(scene.audit.worst, 'and the first one is named');
});

test('every machine produces a drawable scene that fits through the pipe', () => {
  // A 250 kWh bus is fifteen thousand cells. As objects that is megabytes of
  // JSON on every swap, which is why the positions are a flat number array.
  for (const p of PRESETS) {
    const { scene } = sceneFor({ application: p.id });
    ok(scene, `${p.id}: has a scene`);
    ok(scene.v === SCENE_VERSION, `${p.id}: stamped with the version the renderer checks`);
    ok(scene.cells.count > 0 && scene.title && scene.subtitle, `${p.id}: is captioned`);
    ok(scene.cell.size.x > 0 && scene.cell.size.z > 0, `${p.id}: the cell has a drawn size`);
    const bytes = JSON.stringify(scene).length;
    ok(bytes < 2_000_000, `${p.id}: ${(bytes / 1024).toFixed(0)} KB crosses the boundary, not megabytes`);
    // Nothing in a scene may be a function, a class or an undefined — it has
    // to survive structured clone into another language.
    ok(JSON.parse(JSON.stringify(scene)).cells.count === scene.cells.count,
      `${p.id}: survives the round trip that postMessage performs`);
  }
});

test('the protocol refuses what it does not understand', () => {
  // Both sides of the boundary check the version. Half-drawing a payload this
  // build does not speak produces a picture of nothing, presented as a pack.
  ok(isSceneMessage({ type: MSG.SCENE, v: SCENE_VERSION }), 'a current message is accepted');
  ok(isSceneMessage({ type: MSG.READY }), 'an unversioned handshake is accepted');
  ok(!isSceneMessage({ type: MSG.SCENE, v: SCENE_VERSION + 1 }), 'a future version is refused');
  ok(!isSceneMessage({ type: 'something-else' }), 'someone else\'s message is ignored');
  ok(!isSceneMessage(null) && !isSceneMessage('scene') && !isSceneMessage(42), 'and rubbish is ignored');
  // The message names exist in exactly one place, because the other side of
  // this conversation is written in GDScript and cannot be renamed with it.
  for (const [k, v] of Object.entries(MSG)) ok(v.startsWith('bd3d:'), `${k} is namespaced`);
});

test('buildScene refuses to guess', () => {
  ok(buildScene({}) === null, 'no design, no scene');
  ok(buildScene({ design: designFromSpec({ application: 'ev' }) }) === null, 'no layout, no scene');
  ok(buildScene() === null, 'and no arguments at all is not a crash');
});

test('the machine is off unless asked for, and desktop is what asks', () => {
  // A silhouette is INDICATIVE where everything else in this tool is measured.
  // Turning up unrequested next to numbers that are not indicative is how a
  // massing block ends up in somebody's slide deck as a vehicle drawing.
  const { design, layout } = sceneFor({ application: 'ev' });
  ok(buildScene({ design, layout }).host === null, 'off by default');
  ok(buildScene({ design, layout, showHost: true }).host !== null, 'on when asked');
});

test('every application that is a machine says which machine, and where the pack goes', () => {
  for (const p of PRESETS) {
    const h = hostFor(p.id);
    if (!h) continue;                       // a real answer: not every preset is a vehicle
    ok(h.kind && h.name, `${p.id}: names its machine`);
    ok(h.sizeM.x > 0 && h.sizeM.y > 0 && h.sizeM.z > 0, `${p.id}: has an envelope`);
    ok(h.mount?.id && h.mount.what, `${p.id}: says where the pack goes and why that matters`);
    ok(['frontal-area', 'class-typical'].includes(h.dimsFrom), `${p.id}: says how it was sized`);
    ok(h.note, `${p.id}: and admits which half of that is a guess`);
  }
  // Filtering has to bite: if every machine were the same shape the whole
  // module would be decoration.
  const kinds = new Set(PRESETS.map((p) => hostFor(p.id)?.kind).filter(Boolean));
  ok(kinds.size >= 8, `${kinds.size} distinct machine shapes across the presets`);
  const mounts = new Set(PRESETS.map((p) => hostFor(p.id)?.mount?.id).filter(Boolean));
  ok(mounts.size >= 6, `${mounts.size} distinct mountings — a bus roof is not a car floor`);
});

test('a measured frontal area beats a class-typical guess, and says so', () => {
  // Five applications have a vehicle model with a measured frontal area. Those
  // silhouettes carry at least one number that is not invented, and the scene
  // has to distinguish them from the ones that do not.
  const car = hostFor('ev');
  ok(car.dimsFrom === 'frontal-area', 'a car is sized from its measured frontal area');
  ok(/frontal area/.test(car.note), 'and the note says which number did it');
  const veh = vehicleDefaultsFor('ev');
  // Cross-section reproduces the frontal area it came from, within the fill
  // factor. If this drifts, the silhouette is no longer derived from anything.
  near(car.sizeM.x * car.sizeM.z * 0.85, veh.frontalAreaM2, 0.01,
    'width x height x fill returns the frontal area it was derived from');

  const boat = hostFor('marine');
  ok(boat.dimsFrom === 'class-typical', 'a boat has no vehicle model, so it is class-typical');
  ok(/§8|class-typical/.test(boat.note), 'and says so rather than implying measurement');
});

test('an oversized pack bursts out of the machine instead of quietly rescaling it', () => {
  // The failure this whole idea has to avoid: a silhouette that grows to fit
  // whatever pack it is given would make every design look like it fits.
  const host = hostFor('ev');
  const huge = fitInHost(host, { x: 3.0, y: 6.0, z: 0.4 });
  ok(huge.fits === false, 'a pack bigger than the car does not fit the car');
  ok(huge.over.includes('x') && huge.over.includes('y'), 'and it names the axes');
  ok(/not a measurement/.test(huge.note), 'while admitting the silhouette is indicative');
  const fine = fitInHost(host, { x: 1.2, y: 1.2, z: 0.1 });
  ok(fine.fits === true && fine.note === null, 'a pack that fits says nothing');

  // Roof and belly mounts sit OUTSIDE the body, so height cannot constrain them.
  const bus = hostFor('ebus');
  ok(bus.mount.id === 'roof', 'a city bus carries its pack on the roof');
  ok(fitInHost(bus, { x: 1, y: 1, z: 99 }).over.includes('z') === false,
    'a roof pack is not limited by the height of the bus under it');
});

test('the seat comes from the mounting, so the pack moves and the machine does not', () => {
  const car = hostFor('ev');
  const small = packSeat(car, { x: 1, y: 1, z: 0.1 });
  const tall = packSeat(car, { x: 1, y: 1, z: 0.3 });
  ok(tall.z > small.z, 'a taller pack sits higher off the car floor, as it must');
  const bus = hostFor('ebus');
  ok(packSeat(bus, { x: 1, y: 1, z: 0.2 }).z > bus.sizeM.z / 2, 'a roof pack sits above the roof');
  ok(packSeat(hostFor('drone'), { x: 0.2, y: 0.2, z: 0.05 }).z < 0, 'a belly pack hangs below');
});

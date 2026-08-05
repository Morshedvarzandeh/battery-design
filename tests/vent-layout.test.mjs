import test from 'node:test';
import assert from 'node:assert/strict';

import {
  selectVentHardwareLayout,
  ventMarketProfile,
} from '../js/vent-layout.js';

const UNIT = {
  id: 'supplier-vent-a',
  name: 'Verified relief vent A',
  supplier: 'Example supplier',
  partNumber: 'VENT-A-30',
  freeAreaCm2: 30,
  widthMm: 80,
  heightMm: 50,
  mechanism: 'pressure-relief-device',
  openingGaugePressureKPa: 4,
  temperatureRatingC: 500,
  marketProfiles: ['road-pack', 'grid-home-pack'],
  evidenceBasis: 'Supplier drawing D-17 and flow report F-22, revision C',
  evidenceRevision: 'C',
  evidenceDate: '2026-06-15',
};

const BASE = {
  market: 'road',
  segment: null,
  requiredFreeAreaCm2: 92,
  allowableGaugePressureKPa: 10,
  ventGasTemperatureC: 400,
  enclosure: { x: 500, y: 300, z: 160 },
  source: { x: 245, y: 145, z: 130 },
  allowedFaces: ['top', 'rear'],
  preferredFace: 'top',
  edgeClearanceMm: 20,
  minimumSpacingMm: 20,
  maxVentCount: 32,
  unit: UNIT,
};

test('market profiles remain isolated by Road and Grid customer scale', () => {
  assert.equal(ventMarketProfile('road').id, 'road-pack');
  assert.equal(ventMarketProfile('grid', 'home').id, 'grid-home-pack');
  assert.equal(ventMarketProfile('grid', 'small-company').id, 'grid-commercial-cabinet');
  assert.equal(ventMarketProfile('grid', 'industrial').id, 'grid-industrial-enclosure');
  assert.throws(() => ventMarketProfile('grid', null), /segment/i);
});

test('large required area selects multiple supplier vents and places every unit', () => {
  const result = selectVentHardwareLayout(BASE);
  assert.deepEqual(result, selectVentHardwareLayout(BASE), 'the same reviewed inputs produce the same layout');
  assert.equal(result.status, 'provisional');
  assert.equal(result.requiredQuantity, 4, 'ceil(92/30) selects four units');
  assert.equal(result.placedQuantity, 4);
  assert.equal(result.totalDeclaredFreeAreaCm2, 120);
  assert.equal(result.freeAreaMarginCm2, 28);
  assert.equal(result.openingPressureHeadroomKPa, 6);
  assert.ok(result.placements.every((item) => item.face === 'top'), 'preferred permitted face is used when it fits');
  assert.ok(result.placements.every((item) => item.centerMm.z === BASE.enclosure.z));
  assert.ok(result.placements.every((item) => item.dischargeDirection.z === 1));
  assert.match(result.placementBasis, /human preference/i);
  assert.ok(result.approvalChecklist.some((item) => /egress|occupants/i.test(item)));
});

test('units continue onto the next permitted face when one face is full', () => {
  const result = selectVentHardwareLayout({
    ...BASE,
    requiredFreeAreaCm2: 50,
    enclosure: { x: 200, y: 100, z: 100 },
    source: { x: 100, y: 50, z: 80 },
    allowedFaces: ['top', 'rear'], preferredFace: 'top',
  });
  assert.equal(result.status, 'provisional');
  assert.equal(result.requiredQuantity, 2);
  assert.deepEqual(result.placements.map((item) => item.face), ['top', 'rear']);
});

test('placement coordinates respect edge and inter-vent clearances', () => {
  const result = selectVentHardwareLayout(BASE);
  const top = result.placements;
  for (const item of top) {
    const halfW = item.footprintMm.width / 2;
    const halfH = item.footprintMm.height / 2;
    assert.ok(item.centerMm.x - halfW >= BASE.edgeClearanceMm - 1e-9);
    assert.ok(item.centerMm.x + halfW <= BASE.enclosure.x - BASE.edgeClearanceMm + 1e-9);
    assert.ok(item.centerMm.y - halfH >= BASE.edgeClearanceMm - 1e-9);
    assert.ok(item.centerMm.y + halfH <= BASE.enclosure.y - BASE.edgeClearanceMm + 1e-9);
  }
  for (let i = 0; i < top.length; i++) {
    for (let j = i + 1; j < top.length; j++) {
      const a = top[i], b = top[j];
      const separatedX = Math.abs(a.centerMm.x - b.centerMm.x)
        >= (a.footprintMm.width + b.footprintMm.width) / 2 + BASE.minimumSpacingMm - 1e-9;
      const separatedY = Math.abs(a.centerMm.y - b.centerMm.y)
        >= (a.footprintMm.height + b.footprintMm.height) / 2 + BASE.minimumSpacingMm - 1e-9;
      assert.ok(separatedX || separatedY, `${a.id} and ${b.id} do not overlap`);
    }
  }
});

test('a layout is blocked when the required units cannot fit permitted faces', () => {
  const result = selectVentHardwareLayout({
    ...BASE,
    requiredFreeAreaCm2: 80,
    enclosure: { x: 200, y: 100, z: 80 },
    source: { x: 100, y: 50, z: 40 },
    allowedFaces: ['top'], preferredFace: 'top',
  });
  assert.equal(result.status, 'blocked');
  assert.equal(result.requiredQuantity, 3);
  assert.equal(result.faceCapacity.top, 1);
  assert.match(result.headline, /only 1 fit/i);
  assert.ok(result.correctiveActions.some((item) => /Do not raise allowable enclosure pressure/i.test(item)));
});

test('supplier market, footprint, evidence and safe-face declarations are mandatory', () => {
  assert.throws(() => selectVentHardwareLayout({
    ...BASE,
    market: 'grid', segment: 'industrial',
  }), /not declared for market profile grid-industrial-enclosure/i);
  assert.throws(() => selectVentHardwareLayout({ ...BASE, allowedFaces: [] }), /discharge face/i);
  assert.throws(() => selectVentHardwareLayout({
    ...BASE, unit: { ...UNIT, freeAreaCm2: 100 },
  }), /cannot exceed the physical vent footprint/i);
  assert.throws(() => selectVentHardwareLayout({
    ...BASE, unit: { ...UNIT, evidenceBasis: '' },
  }), /evidence basis/i);
  assert.throws(() => selectVentHardwareLayout({
    ...BASE, unit: { ...UNIT, openingGaugePressureKPa: 10 },
  }), /opening pressure.*below/i);
  assert.throws(() => selectVentHardwareLayout({
    ...BASE, unit: { ...UNIT, temperatureRatingC: 399 },
  }), /temperature rating.*cover/i);
  assert.throws(() => selectVentHardwareLayout({
    ...BASE, unit: { ...UNIT, evidenceDate: '2026-02-30' },
  }), /real calendar date/i);
});

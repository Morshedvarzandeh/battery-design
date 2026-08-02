// Geometry — lying-orientation layouts must never exceed 100% packing
// efficiency, and lying cells must not overlap in 3D.
import { test } from 'node:test';
import { ok } from './helpers.mjs';
import { cellById } from '../js/cells.js';
import { layoutPack } from '../js/pack-engine.js';
import { optimizeSpace } from '../js/optimizer.js';

const c = cellById('molicel-inr21700-p42a');

test('every arrangement × orientation × layer count stays physical', () => {
  for (const arrangement of ['grid', 'hex']) {
    for (const orientation of ['upright', 'lying']) {
      for (const nz of [1, 2]) {
        const L = layoutPack(c, 12, 3, { arrangement, orientation, nz, spacingMm: 1 });
        ok(L.packingEfficiency <= 0.9069 + 1e-6,
          `${arrangement}/${orientation}/nz${nz} eff ${(L.packingEfficiency * 100).toFixed(0)}% <= 90.7%`);
        // 3D overlap: same-layer XY distance >= d; cross-layer handled by pitchZ
        for (let i = 0; i < L.positions.length; i++) for (let j = i + 1; j < L.positions.length; j++) {
          const a = L.positions[i], b = L.positions[j];
          if (a.layer !== b.layer) continue;
          const dxy = Math.hypot(a.x - b.x, a.y - b.y);
          const minAllowed = orientation === 'lying'
            ? (Math.abs(a.y - b.y) < 1e-6 ? c.dims.d : 0) // same row: centers d apart in x; different rows: y pitch covers h
            : c.dims.d;
          if (orientation === 'lying' && Math.abs(a.y - b.y) > 1e-6) {
            ok(Math.abs(a.y - b.y) >= c.dims.h - 1e-6,
              `${arrangement}/${orientation} row separation ${(Math.abs(a.y - b.y)).toFixed(1)} >= h`);
          } else {
            ok(dxy >= minAllowed - 1e-6, `${arrangement}/${orientation} overlap dxy ${dxy.toFixed(1)}`);
          }
        }
      }
    }
  }
});

test('optimizeSpace candidates keep positive volume', () => {
  for (const cd of optimizeSpace(c, 12, 3, {}, null, 8)) {
    ok(cd.volumeL > 0, 'vol > 0');
  }
});

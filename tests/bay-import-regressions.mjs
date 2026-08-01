// Regressions for the CAD outline importer (DXF / SVG / CSV / JSON).
import { parseOutline } from '../js/bay-import.js';

let fails = 0;
const ok = (c, m) => { if (!c) { console.error('FAIL:', m); fails++; } };
const throws = (fn, m) => { try { fn(); ok(false, m + ' (no error thrown)'); } catch { ok(true, m); } };

// DXF with an LWPOLYLINE rectangle 300x200 plus a small noise polyline —
// the larger closed outline must win.
{
  const dxf = ['0','SECTION','2','ENTITIES',
    '0','LWPOLYLINE','90','4','10','0','20','0','10','300','20','0','10','300','20','200','10','0','20','200',
    '0','LWPOLYLINE','90','3','10','5','20','5','10','15','20','5','10','10','20','15',
    '0','ENDSEC','0','EOF'].join('\n');
  const r = parseOutline('bay.dxf', dxf);
  ok(r.source === 'DXF' && r.vertexCount === 4, `DXF rect parsed (${r.vertexCount} pts)`);
  ok(Math.abs(r.bbox.x - 300) < 0.2 && Math.abs(r.bbox.y - 200) < 0.2, `DXF bbox ${r.bbox.x}x${r.bbox.y}`);
  ok(Math.abs(r.areaMm2 - 60000) < 10, `DXF area ${r.areaMm2}`);
}

// DXF CIRCLE
{
  const dxf = ['0','SECTION','2','ENTITIES','0','CIRCLE','10','100','20','100','40','150','0','ENDSEC','0','EOF'].join('\n');
  const r = parseOutline('round.dxf', dxf);
  ok(Math.abs(r.bbox.x - 300) < 3 && Math.abs(r.bbox.y - 300) < 3, `DXF circle bbox ~300 (${r.bbox.x})`);
  ok(Math.abs(r.areaMm2 - Math.PI * 150 * 150) < 700, 'DXF circle area ~ pi r^2');
}

// SVG polygon + path; polygon larger, must win.
{
  const svg = '<svg><polygon points="0,0 400,0 400,250 0,250"/><path d="M0 0 L50 0 L50 50 Z"/></svg>';
  const r = parseOutline('bay.svg', svg);
  ok(r.vertexCount === 4 && Math.abs(r.bbox.x - 400) < 0.2, `SVG polygon wins (${r.bbox.x})`);
}
// SVG path-only L-shape with H/V commands.
{
  const svg = '<svg><path d="M0 0 H300 V100 H150 V200 H0 Z"/></svg>';
  const r = parseOutline('l.svg', svg);
  ok(r.vertexCount >= 5 && Math.abs(r.areaMm2 - 45000) < 10, `SVG L-shape area ${r.areaMm2}`);
}
// SVG rect fallback.
{
  const r = parseOutline('r.svg', '<svg><rect x="10" y="10" width="200" height="120"/></svg>');
  ok(Math.abs(r.bbox.x - 200) < 0.2 && Math.abs(r.bbox.y - 120) < 0.2, 'SVG rect parsed');
}

// CSV and JSON.
{
  const r = parseOutline('pts.csv', '0,0\n500,0\n500,300\n0,300\n');
  ok(Math.abs(r.areaMm2 - 150000) < 1, 'CSV rect area');
  const j = parseOutline('pts.json', JSON.stringify({ points: [[0, 0], [100, 0], [100, 80], [0, 80]] }));
  ok(Math.abs(j.areaMm2 - 8000) < 1, 'JSON rect area');
}

// Normalization: negative-origin CAD coordinates land at (0,0), Y flipped.
{
  const r = parseOutline('n.csv', '-100,-50\n200,-50\n200,150\n-100,150\n');
  ok(r.points.every(([x, y]) => x >= 0 && y >= 0), 'normalized to positive origin');
  ok(Math.abs(r.bbox.x - 300) < 0.2 && Math.abs(r.bbox.y - 200) < 0.2, 'span preserved');
}

// Vertex cap: a 720-point circle decimates below 100 without losing area.
{
  const pts = Array.from({ length: 720 }, (_, k) => {
    const a = (k / 720) * 2 * Math.PI;
    return [200 + 200 * Math.cos(a), 200 + 200 * Math.sin(a)];
  });
  const r = parseOutline('c.json', JSON.stringify(pts));
  ok(r.vertexCount <= 100, `decimated to ${r.vertexCount} pts`);
  ok(Math.abs(r.areaMm2 - Math.PI * 200 * 200) / (Math.PI * 200 * 200) < 0.02, 'area kept within 2%');
}

// Honest failures.
throws(() => parseOutline('x.step', ''), 'unsupported extension rejected');
throws(() => parseOutline('x.dxf', '0\nSECTION\n0\nENDSEC'), 'DXF without outline rejected');
throws(() => parseOutline('x.csv', '1,1\n2,2\n'), 'two points rejected');
throws(() => parseOutline('x.csv', '0,0\n100,0\n200,0\n'), 'zero-area outline rejected');

console.log(fails === 0 ? 'BAY-IMPORT REGRESSIONS PASSED' : `${fails} FAILURES`);
process.exit(fails ? 1 : 0);

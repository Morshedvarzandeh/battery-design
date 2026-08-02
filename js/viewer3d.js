// viewer3d.js — Three.js rendering of a pack layout.
//
// Mapping between engine coordinates and the scene: the engine is Z-up
// (X width, Y depth, Z height); Three.js scenes here are Y-up. So
// scene.x = layout.x, scene.y = layout.z, scene.z = layout.y.

import * as THREE from 'three';
import { OrbitControls } from '../vendor/OrbitControls.js';

const GROUP_SATURATION = 0.62;

export class PackViewer {
  constructor(container) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(40, 1, 1, 50000);
    this.camera.position.set(260, 200, 320);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;

    const hemi = new THREE.HemisphereLight(0xffffff, 0x556065, 1.1);
    const dir = new THREE.DirectionalLight(0xffffff, 1.6);
    dir.position.set(1, 1.6, 0.8);
    const dir2 = new THREE.DirectionalLight(0xffffff, 0.5);
    dir2.position.set(-1, 0.6, -0.9);
    this.scene.add(hemi, dir, dir2);

    this.packGroup = new THREE.Group();
    this.scene.add(this.packGroup);

    this.layout = null;
    this.colorMode = 'series';
    this.chemColor = '#2a78d6';
    this.explodeF = 0;
    this.showEnclosure = true;
    this.showWiring = true;
    // Component visualization: { cooling:'bottom'|'side'|'between'|null,
    //   vent:boolean, housing:'aluminum-sheet'|'plastic-v0'|...|null }
    this.compViz = null;

    this._ro = new ResizeObserver(() => this.resize());
    this._ro.observe(container);
    this.resize();

    this._loop = () => {
      this._raf = requestAnimationFrame(this._loop);
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
    };
    this._loop();
  }

  // The render loop only runs while the 3D view is on screen — 2D is the
  // default working view, 3D is the (costlier) final render.
  pause() {
    if (this._raf != null) { cancelAnimationFrame(this._raf); this._raf = null; }
  }

  resume() {
    if (this._raf == null) this._loop();
  }

  setTheme(dark) {
    this._dark = dark;
    if (this._grid) this._grid.material.color.set(dark ? 0x38423f : 0xc4cdca);
    if (this._encLines) this._encLines.material.color.set(dark ? 0x93a29e : 0x5f6d69);
  }

  resize() {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  setExploded(f) {
    this.explodeF = f;
    if (this.layout) this._placeInstances();
  }

  setColorMode(mode, chemColor) {
    this.colorMode = mode;
    if (chemColor) this.chemColor = chemColor;
    if (this.layout) this._colorInstances();
  }

  setToggles({ enclosure, wiring }) {
    if (enclosure != null) this.showEnclosure = enclosure;
    if (wiring != null) this.showWiring = wiring;
    if (this._encGroup) this._encGroup.visible = this.showEnclosure && this.explodeF < 0.05;
    // Wire vertices are built from unexploded positions, so it hides with
    // the enclosure while exploded.
    if (this._wire) this._wire.visible = this.showWiring && this.explodeF < 0.05;
  }

  setPack(layout, chemColor, compViz) {
    this.layout = layout;
    if (chemColor) this.chemColor = chemColor;
    if (compViz !== undefined) this.compViz = compViz;
    this._rebuild();
    if (layout) this._frame();
  }

  setComponents(compViz) {
    this.compViz = compViz;
    if (this.layout) this._rebuild();
  }

  _clearPack() {
    // InstancedMesh.dispose() releases the instanceMatrix/instanceColor GPU
    // buffers, which geometry/material disposal does not cover.
    this._cells?.dispose();
    this._caps?.dispose();
    this.packGroup.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m.dispose());
    });
    this.packGroup.clear();
    this._cells = this._caps = this._wire = this._encGroup = this._encLines = this._compGroup = null;
  }

  _rebuild() {
    this._clearPack();
    const L = this.layout;
    if (!L) return;
    const N = L.positions.length;
    const fp = L.cellFootprint;

    // Cell bodies.
    let geo;
    if (fp.round) {
      const r = (L.cell.dims.d / 2) - 0.15;
      geo = new THREE.CylinderGeometry(r, r, L.cell.dims.h - 0.3, 26);
    } else {
      geo = new THREE.BoxGeometry(fp.fx - 0.4, fp.fz - 0.4, fp.fy - 0.4);
    }
    const mat = new THREE.MeshStandardMaterial({ metalness: 0.35, roughness: 0.45 });
    this._cells = new THREE.InstancedMesh(geo, mat, N);
    this._cells.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.packGroup.add(this._cells);

    // Positive-terminal caps for upright cylinders — a small nub like the
    // real button top, so orientation reads at a glance.
    if (fp.round && fp.axis === 'z') {
      const capGeo = new THREE.CylinderGeometry(L.cell.dims.d * 0.22, L.cell.dims.d * 0.22, 1.6, 16);
      const capMat = new THREE.MeshStandardMaterial({ color: 0xd8d8d2, metalness: 0.85, roughness: 0.3 });
      this._caps = new THREE.InstancedMesh(capGeo, capMat, N);
      this._caps.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.packGroup.add(this._caps);
    }

    // Enclosure: extruded bay outline for shaped fills, box otherwise.
    const enc = new THREE.Group();
    const lineMat = new THREE.LineBasicMaterial({ color: this._dark ? 0x93a29e : 0x5f6d69 });
    let lines, panel;
    if (L.bayZonesOut) {
      lines = new THREE.Group();
      for (const zone of L.bayZonesOut) {
        const yBot = -L.outer.z / 2, yTop = -L.outer.z / 2 + zone.z;
        for (const yy of [yBot, yTop]) {
          const pts = zone.poly.map(([px, py]) => new THREE.Vector3(px, yy, py));
          lines.add(new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts), lineMat));
        }
        for (const [px, py] of zone.poly) {
          lines.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([
            new THREE.Vector3(px, yBot, py), new THREE.Vector3(px, yTop, py),
          ]), lineMat));
        }
      }
      panel = new THREE.Group(); // no translucent shell for shaped bays
    } else {
      const box = new THREE.BoxGeometry(L.outer.x, L.outer.z, L.outer.y);
      lines = new THREE.LineSegments(new THREE.EdgesGeometry(box), lineMat);
      panel = new THREE.Mesh(box, new THREE.MeshBasicMaterial({
        color: 0x4fd1b5, transparent: true, opacity: 0.05, depthWrite: false, side: THREE.DoubleSide,
      }));
    }
    // Walls are symmetric; headroom raises the lid, reserved under-cell
    // space (cold plate) lowers the floor.
    const encCenterY = (L.headroomMm - (L.underMm || 0)) / 2;
    enc.position.set(0, encCenterY, 0);
    enc.add(lines, panel);
    // Housing material tints the translucent shell.
    const HOUSING_TINT = {
      'aluminum-sheet': [0x4fd1b5, 0.05], 'aluminum-extrusion': [0x4fd1b5, 0.06],
      steel: [0x8899aa, 0.08], 'plastic-v0': [0xd9a441, 0.08], potted: [0x8a7f66, 0.16],
    };
    const tint = HOUSING_TINT[this.compViz?.housing] || HOUSING_TINT['aluminum-sheet'];
    if (panel.material) {
      panel.material.color.set(tint[0]);
      panel.material.opacity = tint[1];
    }
    // Pack-level vent nub on the lid — scaled to the pack, so a Gore-vent-
    // sized part never towers over a gadget enclosure like a boulder.
    if (this.compViz?.vent) {
      const vs = Math.min(1, Math.max(0.2, Math.min(L.outer.x, L.outer.y) / 120));
      const ventMesh = new THREE.Mesh(
        new THREE.CylinderGeometry(5 * vs, 6 * vs, 3.2 * vs, 20),
        new THREE.MeshStandardMaterial({ color: 0x30363a, metalness: 0.4, roughness: 0.6 })
      );
      ventMesh.position.set(L.outer.x / 2 - 14 * vs, L.outer.z / 2 + 1.6 * vs, L.outer.y / 2 - 14 * vs);
      enc.add(ventMesh);
    }
    this._encLines = lines;
    this._encGroup = enc;
    this.packGroup.add(enc);
    this._buildCooling();

    // Series wiring hint: a line through the cells in electrical order at
    // cap height.
    const wirePts = [];
    const topY = fp.axis === 'z' ? fp.fz / 2 + 2 : fp.fz / 2 + 2;
    for (const q of L.positions) wirePts.push(new THREE.Vector3(q.x, q.z + topY, q.y));
    const wireGeo = new THREE.BufferGeometry().setFromPoints(wirePts);
    this._wire = new THREE.Line(wireGeo, new THREE.LineBasicMaterial({
      color: 0xd2551f, transparent: true, opacity: 0.55,
    }));
    this.packGroup.add(this._wire);

    // Ground grid.
    const span = Math.max(L.outer.x, L.outer.y) * 1.8;
    this._grid = new THREE.GridHelper(span, 20, 0x000000, 0x000000);
    this._grid.material.color.set(this._dark ? 0x38423f : 0xc4cdca);
    this._grid.material.transparent = true;
    this._grid.material.opacity = 0.6;
    this._grid.position.y = -(L.inner.z / 2) - (L.underMm || 0) - L.wallMm - 2;
    this.packGroup.add(this._grid);

    this._placeInstances();
    this._colorInstances();
    this.setToggles({});
  }

  // Cooling hardware: bottom / side cold plates, or Tesla-style between-row
  // ribbons (thin conductive walls in the row gaps).
  _buildCooling() {
    const L = this.layout;
    const viz = this.compViz?.cooling;
    if (!viz) return;
    const g = new THREE.Group();
    const plateMat = new THREE.MeshStandardMaterial({
      color: 0x3f7fd0, metalness: 0.75, roughness: 0.35,
    });
    const bottomY = -(L.inner.z / 2);
    // Each mesh remembers where it lives assembled and which way it flies
    // apart, so the exploded view keeps the selected components visible and
    // identifiable instead of hiding them.
    const remember = (mesh, exDir, exDist) => {
      mesh.userData.basePos = mesh.position.clone();
      mesh.userData.exDir = exDir;
      mesh.userData.exDist = exDist;
      g.add(mesh);
    };
    if (viz === 'bottom') {
      const plate = new THREE.Mesh(new THREE.BoxGeometry(L.inner.x, 4, L.inner.y), plateMat);
      plate.position.set(0, bottomY - 2.5, 0);
      remember(plate, new THREE.Vector3(0, -1, 0), L.inner.z * 0.7);
    } else if (viz === 'side') {
      for (const sx of [-1, 1]) {
        const plate = new THREE.Mesh(new THREE.BoxGeometry(4, L.inner.z, L.inner.y), plateMat);
        plate.position.set(sx * (L.inner.x / 2 + 2.5), 0, 0);
        remember(plate, new THREE.Vector3(sx, 0, 0), L.inner.x * 0.55);
      }
    } else if (viz === 'between') {
      // Wall at the midpoint between each pair of adjacent rows.
      const rows = [...new Set(L.positions.filter((p) => p.layer === 0)
        .map((p) => Math.round(p.y * 10) / 10))].sort((a, b) => a - b);
      const t = Math.min(2, Math.max(0.8, L.spacingMm * 0.8));
      const h = L.inner.z - 1; // spans all layers
      for (let i = 1; i < rows.length; i++) {
        const wall = new THREE.Mesh(new THREE.BoxGeometry(L.inner.x - 1, h, t), plateMat);
        wall.position.set(0, 0, (rows[i - 1] + rows[i]) / 2);
        // Ribbons live between rows: they track the rows' own spread.
        wall.userData.basePos = wall.position.clone();
        wall.userData.trackRows = true;
        g.add(wall);
      }
    }
    this._compGroup = g;
    this.packGroup.add(g);
  }

  _placeInstances() {
    const L = this.layout;
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const lying = L.cellFootprint.round && L.cellFootprint.axis !== 'z';
    if (lying) q.setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);
    const f = this.explodeF;
    const s = new THREE.Vector3(1, 1, 1);
    for (let i = 0; i < L.positions.length; i++) {
      const c = L.positions[i];
      const ex = c.x * (1 + f * 0.9);
      const ey = c.y * (1 + f * 0.9);
      const ez = c.z * (1 + f * 0.9) + c.layer * f * L.cellFootprint.fz * 0.6;
      m.compose(new THREE.Vector3(ex, ez, ey), q, s);
      this._cells.setMatrixAt(i, m);
      if (this._caps) {
        m.compose(new THREE.Vector3(ex, ez + L.cellFootprint.fz / 2 + 0.8, ey), new THREE.Quaternion(), s);
        this._caps.setMatrixAt(i, m);
      }
    }
    this._cells.instanceMatrix.needsUpdate = true;
    if (this._caps) this._caps.instanceMatrix.needsUpdate = true;
    // Wiring and the enclosure only make sense assembled, but the selected
    // cooling hardware stays VISIBLE while exploding — it flies apart with
    // the cells so the customer can see which component is which.
    if (this._wire) this._wire.visible = this.showWiring && f < 0.05;
    if (this._encGroup) this._encGroup.visible = this.showEnclosure && f < 0.05;
    if (this._compGroup) {
      this._compGroup.visible = true;
      for (const child of this._compGroup.children) {
        const u = child.userData;
        if (!u?.basePos) continue;
        if (u.trackRows) {
          child.position.set(u.basePos.x, u.basePos.y, u.basePos.z * (1 + f * 0.9));
        } else {
          child.position.copy(u.basePos).addScaledVector(u.exDir, f * u.exDist);
        }
      }
    }
  }

  _colorInstances() {
    const L = this.layout;
    const col = new THREE.Color();
    for (let i = 0; i < L.positions.length; i++) {
      const c = L.positions[i];
      if (this.colorMode === 'chemistry') {
        col.set(this.chemColor);
        // Slight per-parallel-cell variation so individual cells stay legible.
        const v = 0.92 + 0.08 * ((c.pIndex % 4) / 3);
        col.multiplyScalar(v);
      } else {
        // Golden-angle hue walk over series groups.
        const hue = (c.sIndex * 0.618034) % 1;
        col.setHSL(hue, GROUP_SATURATION, 0.52);
      }
      this._cells.setColorAt(i, col);
    }
    this._cells.instanceColor.needsUpdate = true;
  }

  _frame() {
    const L = this.layout;
    const span = Math.max(L.outer.x, L.outer.y, L.outer.z);
    const d = span * 1.9 + 60;
    this.camera.position.set(d * 0.75, d * 0.62, d * 0.9);
    this.camera.near = Math.max(0.5, d / 200);
    this.camera.far = d * 30;
    this.camera.updateProjectionMatrix();
    this.controls.target.set(0, 0, 0);
    this.controls.update();
  }

  dispose() {
    cancelAnimationFrame(this._raf);
    this._ro.disconnect();
    this._clearPack();
    this.renderer.dispose();
  }
}

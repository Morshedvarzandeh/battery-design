#!/usr/bin/env node
// validate.mjs — the integration gate for the databases.
//
// Every cell, component and preset added to the library must pass this before
// it merges (CI runs it on every pull request). It checks the data contracts
// the app depends on, so a new market find integrates by construction: add
// the record, run `node tools/validate.mjs`, and if it passes the pickers,
// optimizer, analysis and 2D/3D views all pick it up with no further wiring.

import { CELLS, CHEMISTRIES, cellById } from '../js/cells.js';
import {
  COMPONENT_CATEGORIES, COMPONENTS, DEFAULTS_BY_FORM, componentsFor, componentById,
} from '../js/components.js';
import { PRESETS } from '../js/presets.js';

let errors = 0;
const err = (msg) => { console.error('  ✗', msg); errors++; };
const FORMS = ['cylindrical', 'prismatic', 'pouch'];

// ---------------------------------------------------------------------------
console.log(`cells.js — ${CELLS.length} cells`);
{
  const ids = new Set();
  for (const c of CELLS) {
    const w = (m) => err(`cell ${c.id || '?'}: ${m}`);
    if (!c.id || ids.has(c.id)) w('missing or duplicate id');
    ids.add(c.id);
    if (!CHEMISTRIES[c.chemistry]) w(`unknown chemistry ${c.chemistry}`);
    if (!FORMS.includes(c.form)) w(`unknown form ${c.form}`);
    if (c.form === 'cylindrical') {
      if (!(c.dims?.d > 0 && c.dims?.h > 0)) w('cylindrical dims need d,h > 0');
    } else {
      if (!(c.dims?.w > 0 && c.dims?.t > 0 && c.dims?.h > 0)) w('box dims need w,t,h > 0');
      else if (c.dims.t > c.dims.w) w(`thickness ${c.dims.t} > width ${c.dims.w} (convention: t ≤ w)`);
    }
    if (!(c.vMin < c.nominalV && c.nominalV < c.vMax)) w('voltage ordering vMin < nominal < vMax');
    if (!(c.massG > 0 && c.capacityAh > 0)) w('mass and capacity must be > 0');
    if (!(c.maxContDischargeA > 0 && c.maxContChargeA > 0)) w('current limits must be > 0 (estimate conservatively rather than omitting)');
    for (const k of ['tempDischargeC', 'tempChargeC']) {
      if (!Array.isArray(c[k]) || c[k].length !== 2 || c[k][0] >= c[k][1]) w(`${k} must be [min,max]`);
    }
    if (!['datasheet', 'estimate'].includes(c.dataQuality)) w('dataQuality must be datasheet|estimate');
    if (!c.sourceNote) w('sourceNote is required — say where the numbers came from');
    const whKg = (c.nominalV * c.capacityAh) / (c.massG / 1000);
    if (!(whKg > 25 && whKg < 400)) w(`implausible ${whKg.toFixed(0)} Wh/kg`);
  }
}

// ---------------------------------------------------------------------------
console.log(`components.js — ${Object.values(COMPONENTS).flat().length} components in ${COMPONENT_CATEGORIES.length} categories`);
{
  const catKeys = COMPONENT_CATEGORIES.map((c) => c.key);
  if (JSON.stringify(Object.keys(COMPONENTS).sort()) !== JSON.stringify([...catKeys].sort())) {
    err('COMPONENTS keys must match COMPONENT_CATEGORIES');
  }
  const REQUIRED_BY_CAT = {
    busbar: ['material', 'crossSectionMm2', 'ampacityAPerJoint', 'resistivityNOhmM', 'joinMethod', 'massGPerCell'],
    spacer: ['providesGapMm', 'thermalBarrier', 'thermalCondWmK', 'flameRating', 'massGPerCell'],
    vent: ['level', 'mechanism'],
    cooling: ['placement', 'htcWm2K', 'massKgPerM2', 'needsPump', 'viz'],
    tim: ['thermalCondWmK', 'thicknessMm', 'dielectricKVPerMm'],
    housing: ['material', 'densityKgM3', 'flameRating', 'ipClass'],
  };
  const ids = new Set();
  for (const [cat, list] of Object.entries(COMPONENTS)) {
    for (const o of list) {
      const w = (m) => err(`${cat}/${o.id || '?'}: ${m}`);
      if (!o.id || ids.has(cat + ':' + o.id)) w('missing or duplicate id');
      ids.add(cat + ':' + o.id);
      if (!o.name || !o.kind || !o.notes) w('name, kind and notes are required');
      if (!Array.isArray(o.forms) || !o.forms.length || o.forms.some((f) => !FORMS.includes(f))) {
        w('forms must be a non-empty subset of cylindrical|prismatic|pouch');
      }
      // "Absence" entries (no hardware: natural convection, dry contact,
      // direct bond…) legitimately have no supplier; everything else needs
      // at least one representative example.
      const isNoneEntry = /none|natural-convection|dry-contact|direct-bond/.test(o.kind) || /^none/.test(o.id);
      const hasSuppliers = Array.isArray(o.suppliers) && o.suppliers.length > 0;
      if (!hasSuppliers && !isNoneEntry) w('at least one representative supplier (or a none/passive kind)');
      if (o.dataQuality !== 'typical-class') w("dataQuality must be 'typical-class'");
      for (const f of REQUIRED_BY_CAT[cat] || []) {
        if (!(f in o)) w(`missing field ${f} (use null for unknown, never omit)`);
      }
      if (cat === 'cooling') {
        if (!(Array.isArray(o.htcWm2K) && o.htcWm2K.length === 2 && o.htcWm2K[0] <= o.htcWm2K[1])) {
          w('htcWm2K must be [lo,hi]');
        }
        if (o.viz != null && !['bottom', 'side', 'between'].includes(o.viz)) w(`viz ${o.viz} unknown to the viewers`);
        // The max-fill algorithm reserves this space before packing cells.
        const sp = o.spaceMm;
        if (!sp || !['bottom', 'side', 'rowGap'].every((k) => typeof sp[k] === 'number' && sp[k] >= 0)) {
          w('spaceMm must be { bottom, side, rowGap } with numbers ≥ 0');
        }
      }
      if (cat === 'tim' && !(Array.isArray(o.thicknessMm) && o.thicknessMm.length === 2)) w('thicknessMm must be [lo,hi]');
      if (cat === 'vent' && !['cell', 'pack'].includes(o.level)) w('vent level must be cell|pack');
    }
  }
  // Defaults integrity: every form must resolve a full, form-compatible set.
  for (const form of FORMS) {
    for (const key of catKeys) {
      const id = DEFAULTS_BY_FORM[form]?.[key];
      const o = id && componentById(key, id);
      if (!o) err(`DEFAULTS_BY_FORM.${form}.${key} = ${id} does not exist`);
      else if (!o.forms.includes(form)) err(`DEFAULTS_BY_FORM.${form}.${key} = ${id} does not support ${form}`);
      if (!componentsFor(key, form).length) err(`no ${key} options at all for ${form}`);
    }
  }
}

// ---------------------------------------------------------------------------
console.log(`presets.js — ${PRESETS.length} presets`);
{
  const ids = new Set();
  for (const p of PRESETS) {
    const w = (m) => err(`preset ${p.id || '?'}: ${m}`);
    if (!p.id || ids.has(p.id)) w('missing or duplicate id');
    ids.add(p.id);
    if (!(Array.isArray(p.systemV) && p.systemV[0] <= p.typicalV && p.typicalV <= p.systemV[1])) {
      w('typicalV must sit inside systemV window');
    }
    if (!(p.typicalEnergyWh >= p.energyWh?.[0] && p.typicalEnergyWh <= p.energyWh?.[1])) {
      w('typicalEnergyWh must sit inside energyWh window');
    }
    if (!Array.isArray(p.preferredChemistries) || p.preferredChemistries.some((c) => !CHEMISTRIES[c])) {
      w('preferredChemistries must name known chemistries');
    }
  }
}

// ---------------------------------------------------------------------------
if (errors) {
  console.error(`\nVALIDATION FAILED — ${errors} error(s)`);
  process.exit(1);
}
console.log('\nALL DATABASES VALID');

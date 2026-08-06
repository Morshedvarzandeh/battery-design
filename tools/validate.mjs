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
import { existsSync, readFileSync } from 'node:fs';
import {
  ARCHITECTURE_MODULE_DEFINITIONS,
  CLASS_DEFINITIONS,
  COMPETENCY_QUESTIONS,
  ENGINEERING_RULE_DEFINITIONS,
  JSON_LD_CONTEXT,
  MODULE_DEFINITIONS,
  ONTOLOGY,
  RELATION_DEFINITIONS,
} from '../js/ontology-schema.js';
import { validateEngineeringRule } from '../js/ontology-rules.js';
import {
  generatedCompetencyQuestionsJson, generatedContextJson, generatedCoreTurtle,
} from './generate-ontology.mjs';
import { validateGraph as validateKnowledgeGraph } from '../js/knowledge.js';

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
    const BASES = ['contrib', 'external_datasheet', 'teardown', 'trade_press',
                   'composite', 'recalled'];
    if (!BASES.includes(c.basis)) w(`basis must be one of ${BASES.join('|')}`);
    // basis 'contrib' asserts a document in the battery-data repo backs this
    // record. Unchecked it is decoration, so at minimum the two fields have to
    // agree and the uid has to look like a product uid over there.
    if ((c.basis === 'contrib') !== !!c.contribUid) {
      w("basis 'contrib' and contribUid must agree — one names the other");
    }
    if (c.contribUid && !/^[a-z_]+\/[a-z0-9-]+\/[a-z0-9._-]+$/.test(c.contribUid)) {
      w(`contribUid ${c.contribUid} is not a battery-data product uid`);
    }
    if (!Array.isArray(c.inferredFields)) {
      w('inferredFields must be an array — [] if nothing was inferred, ["ALL"] if everything was');
    } else if (c.basis === 'contrib' && c.inferredFields.includes('ALL')) {
      w("basis 'contrib' with inferredFields ['ALL'] — if everything is inferred, the document is not the basis");
    }
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
console.log(`ontology ${ONTOLOGY.version} — ${Object.keys(CLASS_DEFINITIONS).length} classes, ${Object.keys(RELATION_DEFINITIONS).length} relations, ${Object.keys(MODULE_DEFINITIONS).length} modules`);
{
  const knownOrExternal = (id) => !!CLASS_DEFINITIONS[id] || /^(prov|sosa|qudt|skos|time):/.test(id || '');
  for (const [id, definition] of Object.entries(CLASS_DEFINITIONS)) {
    if (!id.startsWith('bd:')) err(`${id}: local ontology class id must use bd:`);
    for (const parent of (Array.isArray(definition.parent) ? definition.parent : [definition.parent]).filter(Boolean)) {
      if (!knownOrExternal(parent)) err(`${id}: unknown parent ${parent}`);
    }
  }
  for (const [id, definition] of Object.entries(RELATION_DEFINITIONS)) {
    if (!id.startsWith('bd:')) err(`${id}: local relation id must use bd:`);
    if (!knownOrExternal(definition.domain)) err(`${id}: unknown domain ${definition.domain}`);
    if (!knownOrExternal(definition.range)) err(`${id}: unknown range ${definition.range}`);
  }
  for (const [key, definition] of Object.entries(MODULE_DEFINITIONS)) {
    if (!existsSync(new URL(`../${definition.module}`, import.meta.url))) err(`module:${key}: missing implementation ${definition.module}`);
    if (!CLASS_DEFINITIONS[definition.runType]) err(`module:${key}: unknown run type ${definition.runType}`);
  }
  for (const [key, definition] of Object.entries(ARCHITECTURE_MODULE_DEFINITIONS)) {
    for (const implementation of definition.implementation) {
      if (!existsSync(new URL(`../${implementation}`, import.meta.url))) err(`architecture-module:${key}: missing implementation ${implementation}`);
    }
  }
  for (const [key, definition] of Object.entries(ENGINEERING_RULE_DEFINITIONS)) {
    for (const problem of validateEngineeringRule(definition)) err(`rule:${key}: ${problem}`);
    if (!ARCHITECTURE_MODULE_DEFINITIONS[definition.module]) err(`rule:${key}: unknown architecture module ${definition.module}`);
    if (!existsSync(new URL(`../${definition.implementation}`, import.meta.url))) err(`rule:${key}: missing implementation ${definition.implementation}`);
  }
  for (const question of COMPETENCY_QUESTIONS) {
    for (const relation of question.answerPath) if (!RELATION_DEFINITIONS[relation]) err(`${question.id}: unknown answer-path relation ${relation}`);
  }
  for (const problem of validateKnowledgeGraph()) err(`knowledge projection: ${problem}`);
  for (const file of ['context.v1.jsonld', 'data-inventory.v1.json', 'competency-questions.v1.json']) {
    try { JSON.parse(readFileSync(new URL(`../ontology/${file}`, import.meta.url), 'utf8')); }
    catch (e) { err(`ontology/${file}: invalid JSON (${e.message})`); }
  }
  const checkedContext = JSON.parse(readFileSync(new URL('../ontology/context.v1.jsonld', import.meta.url), 'utf8'))['@context'];
  if (JSON.stringify(checkedContext) !== JSON.stringify(JSON_LD_CONTEXT)) err('context.v1.jsonld does not exactly match the runtime JSON-LD context');
  const ttl = readFileSync(new URL('../ontology/core.v1.ttl', import.meta.url), 'utf8');
  const shapes = readFileSync(new URL('../ontology/shapes.v1.ttl', import.meta.url), 'utf8');
  if (!ttl.includes(`owl:versionInfo "${ONTOLOGY.version}"`)) err('core.v1.ttl version does not match the runtime ontology');
  if (ttl !== generatedCoreTurtle()) err('core.v1.ttl drifted from ontology-schema.js; run node tools/generate-ontology.mjs --write');
  if (readFileSync(new URL('../ontology/context.v1.jsonld', import.meta.url), 'utf8') !== generatedContextJson()) {
    err('context.v1.jsonld drifted from ontology-schema.js; run node tools/generate-ontology.mjs --write');
  }
  if (readFileSync(new URL('../ontology/competency-questions.v1.json', import.meta.url), 'utf8') !== generatedCompetencyQuestionsJson()) {
    err('competency-questions.v1.json drifted from ontology-schema.js; run node tools/generate-ontology.mjs --write');
  }
  if (!shapes.includes('bd:QuantityValueShape') || !shapes.includes('bd:ModelRunShape')) err('SHACL file is missing calculation-ready core shapes');
  for (const block of shapes.matchAll(/sh:sparql\s*\[(.*?)\]\s*\./gs)) {
    const query = block[1].match(/sh:select\s*"""([\s\S]*?)"""/)?.[1] || '';
    if (/\bbd:/.test(query) && !/PREFIX\s+bd:\s*<https:\/\/morshedvarzandeh\.github\.io\/battery-design\/ontology\/core#>/i.test(query)) {
      err('SHACL SPARQL query uses bd: without declaring its prefix inside the query');
    }
  }
}

// ---------------------------------------------------------------------------
if (errors) {
  console.error(`\nVALIDATION FAILED — ${errors} error(s)`);
  process.exit(1);
}
console.log('\nALL DATABASES VALID');

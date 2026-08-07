import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import {
  ARCHITECTURE_MODULE_DEFINITIONS,
  CONCEPT_APPLICABILITY,
  CONCEPT_DEFINITIONS,
} from '../js/ontology-schema.js';
import {
  buildArchitectureSemanticGraph,
  createSemanticIndex,
  querySemanticGraph,
  semanticId,
} from '../js/ontology.js';
import { needed } from '../js/knowledge.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(resolve(ROOT, path), 'utf8');

test('root-cause memory is a truthful architecture module with one canonical capability', () => {
  const definition = ARCHITECTURE_MODULE_DEFINITIONS.qualityMemory;
  assert.ok(definition, 'qualityMemory is registered in the product architecture');
  assert.deepEqual(definition.implementation, [
    'js/root-cause-library.js',
    'knowledge/root-causes/schema.v1.js',
    'knowledge/root-causes/records.v1.js',
  ]);
  assert.deepEqual(definition.capabilities, ['root-cause-memory']);
  assert.deepEqual(definition.surfaces, {
    browser: 'importable-library',
    desktop: 'cli',
    api: 'library',
    mcp: 'assistant',
    report: 'references',
  });
  assert.equal(CONCEPT_DEFINITIONS['root-cause-memory'].label, 'Root-cause engineering memory');
  assert.ok(CONCEPT_APPLICABILITY['root-cause-memory']);
  for (const app of ['ev', 'solar-ess', 'marine', 'drone']) {
    assert.equal(needed(app, 'root-cause-memory'), true, app);
  }
});

test('architecture queries expose capability ownership and its declared surfaces', () => {
  const graph = buildArchitectureSemanticGraph();
  const index = createSemanticIndex(graph);
  const moduleId = semanticId('architecture-module', 'qualityMemory');
  const capabilityId = semanticId('capability', 'root-cause-memory');
  const queried = querySemanticGraph(graph, { type: 'bd:Capability', text: 'root-cause-memory' });
  assert.deepEqual(queried.nodes.map(({ id }) => id), [capabilityId]);
  assert.ok(index.outgoing(moduleId, 'bd:implementsCapability')
    .some(({ to }) => to === capabilityId));
  const available = new Map(index.outgoing(capabilityId, 'bd:availableOn')
    .map((edge) => [edge.to, edge.properties.availability[0].mode]));
  assert.deepEqual(available, new Map([
    [semanticId('product-surface', 'api'), 'library'],
    [semanticId('product-surface', 'browser'), 'importable-library'],
    [semanticId('product-surface', 'desktop'), 'cli'],
    [semanticId('product-surface', 'mcp'), 'assistant'],
    [semanticId('product-surface', 'report'), 'references'],
  ]));
  assert.equal(graph.validation.conforms, true);
});

test('repository validation includes the root-cause schema, catalog and local references', () => {
  const validator = read('tools/validate.mjs');
  assert.match(validator, /validateRootCauseCatalog\(ROOT_CAUSE_CATALOG\)/);
  assert.match(validator, /every governed record field must be required/);
  assert.match(validator, /missing regression test/);
  assert.match(validator, /missing local reference/);
  const run = spawnSync(process.execPath, ['tools/validate.mjs'], {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
  });
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  assert.match(run.stdout, /root-cause memory 1\.0\.0 — \d+ records/);
});

test('contributor documentation makes resolved-defect memory a review requirement', () => {
  const guide = read('docs/ROOT_CAUSE_LIBRARY.md');
  const template = read('.github/pull_request_template.md');
  for (const text of [guide, template]) {
    assert.match(text, /root cause/i);
    assert.match(text, /resolution/i);
    assert.match(text, /prevention/i);
    assert.match(text, /regression/i);
    assert.match(text, /rc-[a-z0-9-]+/i);
  }
  assert.match(guide, /npm run test:root-causes/);
  assert.match(template, /existing record|add or update/i);
  assert.match(template, /no defect resolved/i);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { designFromSpec } from '../js/api.js';

const runner = new URL('../desktop/bd.mjs', import.meta.url);
const runJson = (...args) => JSON.parse(execFileSync(process.execPath, [runner.pathname, ...args, '--json'], {
  encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
}));

test('desktop exports the complete architecture graph independently of a design', () => {
  const graph = runJson('ontology', '--architecture');
  assert.equal(graph.ontology.version, '1.0.0');
  assert.equal(graph.validation.conforms, true);
  const modules = graph.nodes.filter((node) => node.types.includes('bd:DomainModule'));
  assert.equal(modules.length, 23);
  assert.equal(new Set(modules.map((node) => node.id)).size, 23);
  assert.ok(modules.some((node) => node.label === 'Charging and bidirectional power'));
  const qualityMemory = modules.find((node) => node.properties?.key === 'qualityMemory');
  assert.equal(qualityMemory?.label, 'Root-cause quality memory');
  assert.deepEqual(qualityMemory?.properties?.implementation, [
    'js/root-cause-library.js',
    'knowledge/root-causes/schema.v1.js',
    'knowledge/root-causes/records.v1.js',
  ]);
  assert.ok(graph.nodes.some((node) => node.types.includes('bd:EngineeringRule')));
});

test('desktop architecture JSON-LD preserves the validated graph identity', () => {
  const graph = runJson('ontology', '--architecture');
  const jsonld = runJson('ontology', '--architecture', '--format', 'jsonld');
  assert.equal(jsonld.ontology.checksum, graph.checksum);
  assert.ok(jsonld['@graph'].some((row) => row['@type']?.includes?.('bd:DomainModule')));
  assert.ok(jsonld['@context'].prov && jsonld['@context'].qudt);
});

test('desktop EU flags produce the exact API passport evaluation', () => {
  const desktop = runJson(
    'design', '--app', 'solar-ess', '--energy', '10000',
    '--battery-category', 'industrial', '--evaluation-date', '2027-02-18',
  );
  const api = designFromSpec({
    application: 'solar-ess', energyWh: 10000,
    batteryCategory: 'industrial', evaluationDate: '2027-02-18',
  });
  assert.deepEqual(desktop.eu, api.eu);
  assert.equal(desktop.spec.batteryCategory, 'industrial');
  assert.equal(desktop.spec.evaluationDate, '2027-02-18');
  assert.ok(desktop.eu.findings.some((finding) =>
    finding.ontologyRuleId === 'bd:rule/eu-battery-passport'
    && /passport applies/i.test(finding.title)));
});

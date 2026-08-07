import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ROOT_CAUSE_CATALOG,
  ROOT_CAUSE_CATALOG_FORMAT,
  ROOT_CAUSE_RECORD_FORMAT,
  ROOT_CAUSE_RECORD_SCHEMA,
  ROOT_CAUSE_RECORDS,
  ROOT_CAUSE_SCHEMA_VERSION,
  findSimilarRootCauses,
  getRootCauseRecord,
  listRootCauseRecords,
  searchRootCauses,
  validateRootCauseCatalog,
  validateRootCauseRecord,
} from '../js/root-cause-library.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function assertDeepFrozen(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  assert.ok(Object.isFrozen(value), 'every exported knowledge object is frozen');
  for (const child of Object.values(value)) assertDeepFrozen(child, seen);
}

test('versioned seed catalog is closed, valid, immutable and locally referenced', () => {
  assert.equal(ROOT_CAUSE_CATALOG.format, ROOT_CAUSE_CATALOG_FORMAT);
  assert.equal(ROOT_CAUSE_CATALOG.version, ROOT_CAUSE_SCHEMA_VERSION);
  assert.equal(ROOT_CAUSE_RECORD_FORMAT, 'battery-design/root-cause-record@1');
  assert.equal(ROOT_CAUSE_RECORDS.length, 10);
  assert.deepEqual(validateRootCauseCatalog(), []);
  assert.equal(ROOT_CAUSE_RECORD_SCHEMA.additionalProperties, false);
  assertDeepFrozen(ROOT_CAUSE_RECORD_SCHEMA);
  assertDeepFrozen(ROOT_CAUSE_CATALOG);

  const requiredFields = [
    'symptom', 'evidence', 'detection', 'causalChain', 'rootCause', 'resolution',
    'prevention', 'regressionTests', 'affectedSurfaces', 'tags', 'status', 'references',
  ];
  for (const field of requiredFields) assert.ok(ROOT_CAUSE_RECORD_SCHEMA.required.includes(field), field);

  for (const record of ROOT_CAUSE_RECORDS) {
    assert.deepEqual(validateRootCauseRecord(record), [], record.id);
    for (const regression of record.regressionTests) {
      assert.ok(existsSync(resolve(ROOT, regression.path)), `${record.id}: ${regression.path}`);
    }
    for (const reference of record.references) {
      if (/^(?:\.|[a-z0-9_-]+)\//i.test(reference.locator)) {
        assert.ok(existsSync(resolve(ROOT, reference.locator)), `${record.id}: ${reference.locator}`);
      }
    }
  }
});

test('seed knowledge covers the requested recurring engineering failure classes', () => {
  assert.deepEqual(ROOT_CAUSE_RECORDS.map(({ id }) => id), [
    'rc-allof-closure-collision',
    'rc-capability-contract-mismatch',
    'rc-cli-typo-default-fallback',
    'rc-final-artifact-identity-gap',
    'rc-fmi-calibration-key-ignored',
    'rc-fmi-representation-drift',
    'rc-resource-self-checksum-trust',
    'rc-schema-envelope-permissive',
    'rc-source-revision-self-claim',
    'rc-tree-link-containment',
  ]);

  for (const record of ROOT_CAUSE_RECORDS) {
    assert.ok(record.causalChain.length >= 2);
    assert.ok(record.resolution.length && record.prevention.length);
    assert.ok(record.detection.every((item) => item.method && item.signal && item.failureCondition));
  }
});

test('validation is deterministic, non-mutating and rejects unknown or ambiguous data', () => {
  const bad = structuredClone(ROOT_CAUSE_RECORDS[0]);
  bad.tags = ['validation', 'allof'];
  bad.unreviewedGuess = true;
  const before = structuredClone(bad);
  const first = validateRootCauseRecord(bad);
  const second = validateRootCauseRecord(bad);
  assert.deepEqual(first, second);
  assert.deepEqual(bad, before, 'validation does not normalize or freeze caller input');
  assert.ok(first.some(({ path, code }) => path === '$/unreviewedGuess' && code === 'additionalProperties'));
  assert.ok(first.some(({ path, code }) => path === '$/tags' && code === 'canonicalOrder'));
  assertDeepFrozen(first);
  assert.throws(() => validateRootCauseRecord(bad, { pth: '$' }), /does not accept option/);

  const duplicateCatalog = structuredClone(ROOT_CAUSE_CATALOG);
  duplicateCatalog.records.splice(1, 0, structuredClone(duplicateCatalog.records[0]));
  const catalogErrors = validateRootCauseCatalog(duplicateCatalog);
  assert.ok(catalogErrors.some(({ code }) => code === 'uniqueId'));
  assert.ok(catalogErrors.some(({ code }) => code === 'canonicalOrder'));

  const cyclic = structuredClone(ROOT_CAUSE_RECORDS[0]);
  cyclic.evidence[0] = cyclic;
  const cyclicErrors = validateRootCauseRecord(cyclic);
  assert.ok(cyclicErrors.some(({ code }) => code === 'cycle'));
});

test('listing and exact lookup stay immutable and fail closed on option typos', () => {
  assert.equal(getRootCauseRecord('rc-fmi-representation-drift')?.rootCause.length > 20, true);
  assert.equal(getRootCauseRecord('rc-not-known'), null);

  const fmi = listRootCauseRecords({ tags: ['fmi'] });
  assert.deepEqual(fmi.map(({ id }) => id), [
    'rc-capability-contract-mismatch',
    'rc-fmi-calibration-key-ignored',
    'rc-fmi-representation-drift',
  ]);
  assert.ok(Object.isFrozen(fmi));
  assert.throws(() => fmi.push(ROOT_CAUSE_RECORDS[0]), TypeError);
  assert.throws(() => listRootCauseRecords({ tag: ['fmi'] }), /does not accept option/);
  assert.throws(() => listRootCauseRecords({ affectedSurfaces: ['cloud-service'] }), /unsupported value/);
});

test('lexical search deterministically retrieves causes, fixes and containment patterns', () => {
  const cases = [
    ['unknown option defaults typo', 'rc-cli-typo-default-fallback'],
    ['XML I/O map C binary mismatch', 'rc-fmi-representation-drift'],
    ['trusted expected SHA provenance', 'rc-source-revision-self-claim'],
    ['symlink hardlink containment', 'rc-tree-link-containment'],
    ['allOf additional properties', 'rc-allof-closure-collision'],
  ];
  for (const [query, expected] of cases) {
    const first = searchRootCauses(query, { limit: 3 });
    const second = searchRootCauses(query, { limit: 3 });
    assert.equal(first[0]?.id, expected, query);
    assert.deepEqual(first, second, `${query} is deterministic`);
    assertDeepFrozen(first);
  }
  assert.deepEqual(searchRootCauses('   '), []);
  assert.deepEqual(searchRootCauses('the and of'), []);
  assert.throws(() => searchRootCauses('fmi', { limt: 2 }), /does not accept option/);
});

test('similar-issue matching uses evidence, tags and affected surfaces without mutation', () => {
  const issue = {
    symptom: 'modelDescription advertises state serialization but native functions return errors',
    evidence: ['The imported FMU reports an optional operation that its binary rejects.'],
    tags: ['capability', 'fmi'],
    affectedSurfaces: ['compiled-fmu'],
  };
  const before = structuredClone(issue);
  const results = findSimilarRootCauses(issue, { limit: 3 });
  assert.equal(results[0]?.id, 'rc-capability-contract-mismatch');
  assert.ok(results[0].score > results[1].score);
  assert.ok(results[0].sharedTokens.includes('capability'));
  assert.deepEqual(issue, before, 'similarity does not modify caller evidence');
  assertDeepFrozen(results);

  const envelope = findSimilarRootCauses({
    symptom: 'A request param typo is ignored and the default is used.',
    tags: ['validation'],
    affectedSurfaces: ['local-api'],
  });
  assert.equal(envelope[0]?.id, 'rc-schema-envelope-permissive');
  assert.throws(() => findSimilarRootCauses({ guess: 'maybe' }), /does not accept field/);
});

test('runtime library remains import-safe in browser and Node with no hidden I/O', () => {
  for (const path of [
    'js/root-cause-library.js',
    'knowledge/root-causes/schema.v1.js',
    'knowledge/root-causes/records.v1.js',
  ]) {
    const source = readFileSync(resolve(ROOT, path), 'utf8');
    assert.doesNotMatch(source, /from ['"]node:|require\s*\(|\bfetch\s*\(|XMLHttpRequest|WebSocket/);
  }
});

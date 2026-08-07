// The persistent engineering memory must be reachable from both automation
// surfaces without turning a catalog lookup into a mutable or networked task.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync, readFileSync, rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { handleMessage } from '../desktop/mcp-server.mjs';
import { getRootCauseRecord } from '../js/root-cause-library.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function cli(...args) {
  return spawnSync(process.execPath, ['desktop/bd.mjs', 'root-cause', ...args], {
    cwd: ROOT,
    encoding: 'utf8',
  });
}

function mcpCall(args) {
  return handleMessage({
    id: 1,
    method: 'tools/call',
    params: { name: 'diagnose_known_issue', arguments: args },
  });
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

test('root-cause CLI retrieves and searches the immutable catalog in human and JSON forms', (t) => {
  const exactRun = cli('--id', 'rc-fmi-representation-drift', '--json');
  assert.equal(exactRun.status, 0, exactRun.stderr);
  const exact = JSON.parse(exactRun.stdout);
  assert.equal(exact.format, 'battery-design/root-cause-query@1');
  assert.equal(exact.knowledge.kind, 'versioned-curated-catalog');
  assert.equal(exact.knowledge.schemaVersion, '1.0.0');
  assert.match(exact.knowledge.notice, /not AI certainty|not.*proof/i);
  assert.equal(exact.matches.length, 1);
  assert.equal(exact.matches[0].id, 'rc-fmi-representation-drift');
  assert.match(exact.matches[0].symptom, /FMU imports/i);
  assert.match(exact.matches[0].rootCause, /self-describing evidence/i);
  for (const field of ['evidence', 'resolution', 'prevention', 'regressionTests']) {
    assert.ok(exact.matches[0][field].length, `${field} remains available to the assistant`);
  }

  const queryArgs = [
    '--query', 'modelDescription XML generated C and binary defaults drift apart',
    '--surface', 'compiled-fmu', '--tag', 'fmi', '--status', 'resolved', '--limit', '3', '--json',
  ];
  const firstQuery = cli(...queryArgs);
  const secondQuery = cli(...queryArgs);
  assert.equal(firstQuery.status, 0, firstQuery.stderr);
  assert.equal(secondQuery.status, 0, secondQuery.stderr);
  assert.equal(secondQuery.stdout, firstQuery.stdout, 'the same catalog query is byte-for-byte deterministic');
  const searched = JSON.parse(firstQuery.stdout);
  assert.equal(searched.matches[0].id, 'rc-fmi-representation-drift');
  assert.ok(searched.matches.every((match) => match.status === 'resolved'
    && match.affectedSurfaces.includes('compiled-fmu') && match.tags.includes('fmi')));

  const human = cli('--query', 'XML C binary drift', '--limit', '1');
  assert.equal(human.status, 0, human.stderr);
  for (const heading of ['Symptom:', 'Evidence:', 'Root cause:', 'Resolution:', 'Prevention:', 'Regression tests:']) {
    assert.match(human.stdout, new RegExp(heading), `human output includes ${heading}`);
  }

  const temporary = mkdtempSync(join(tmpdir(), 'battery-design-root-cause-'));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const output = join(temporary, 'diagnosis.json');
  const written = cli('--id', 'rc-fmi-representation-drift', '--out', output);
  assert.equal(written.status, 0, written.stderr);
  assert.match(written.stdout, /Written:/);
  assert.equal(JSON.parse(readFileSync(output, 'utf8')).matches[0].id,
    'rc-fmi-representation-drift');

  const help = spawnSync(process.execPath, ['desktop/bd.mjs', 'help'], {
    cwd: ROOT, encoding: 'utf8',
  });
  assert.match(help.stdout, /root-cause search recorded engineering fixes/);
});

test('root-cause CLI fails closed on typoed, duplicate, missing and ambiguous inputs', () => {
  const cases = [
    [['--qurey', 'fmi drift'], /does not accept option\(s\): --qurey/],
    [['--query', 'first', '--query', 'second'], /may be supplied only once: --query/],
    [[], /requires exactly one of --id ID or --query TEXT/],
    [['--id'], /--id requires a non-empty value/],
    [['--id', 'rc-fmi-representation-drift', '--query', 'drift'], /requires exactly one/],
    [['--id', 'rc-does-not-exist'], /Unknown root-cause id/],
    [['--query', 'drift', '--surface', 'not-a-surface'], /unsupported value/],
    [['--query', 'drift', '--limit', '1.5'], /--limit requires an integer/],
    [['--query', 'drift', '--json', 'yes'], /--json is a boolean flag/],
    [['--query', 'drift', 'unexpected'], /does not accept positional arguments/],
  ];
  for (const [args, expected] of cases) {
    const result = cli(...args);
    assert.equal(result.status, 2, `${args.join(' ')} unexpectedly succeeded:\n${result.stdout}`);
    assert.match(result.stderr, expected, args.join(' '));
  }
});

test('MCP exposes a strict read-only known-issue diagnosis with deterministic catalog evidence', () => {
  const tool = handleMessage({ id: 1, method: 'tools/list' }).tools
    .find(({ name }) => name === 'diagnose_known_issue');
  assert.ok(tool);
  assert.equal(tool.inputSchema.additionalProperties, false);
  assert.deepEqual(tool.inputSchema.required, ['symptom']);
  assert.deepEqual(Object.keys(tool.inputSchema.properties).sort(),
    ['affectedSurfaces', 'evidence', 'limit', 'symptom', 'tags']);
  assert.equal(tool.inputSchema.properties.affectedSurfaces.items.enum.includes('compiled-fmu'), true);
  assert.equal(tool.annotations.readOnlyHint, true);
  assert.equal(tool.annotations.destructiveHint, false);
  assert.equal(tool.annotations.idempotentHint, true);
  assert.equal(tool.annotations.openWorldHint, false);

  const request = deepFreeze({
    symptom: 'modelDescription XML, the generated C, and native binary defaults drift apart',
    evidence: ['The value references no longer agree.'],
    tags: ['fmi'],
    affectedSurfaces: ['compiled-fmu'],
    limit: 3,
  });
  const before = JSON.stringify(request);
  const originalFetch = globalThis.fetch;
  let networkAttempted = false;
  globalThis.fetch = () => {
    networkAttempted = true;
    throw new Error('network access is forbidden during catalog diagnosis');
  };
  let first;
  let second;
  try {
    first = mcpCall(request);
    second = mcpCall(request);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(networkAttempted, false, 'known-issue diagnosis performs no network access');
  assert.equal(JSON.stringify(request), before, 'known-issue diagnosis does not mutate caller input');
  assert.equal(first.isError, undefined);
  assert.deepEqual(second, first, 'the read-only tool is deterministic');
  assert.deepEqual(JSON.parse(first.content[0].text), first.structuredContent);
  const diagnosis = first.structuredContent;
  assert.equal(diagnosis.format, 'battery-design/root-cause-diagnosis@1');
  assert.equal(diagnosis.knowledge.schemaVersion, '1.0.0');
  assert.match(diagnosis.knowledge.notice, /not AI certainty.*proof of causation/i);
  assert.equal(diagnosis.matches[0].id, 'rc-fmi-representation-drift');
  for (const field of ['evidence', 'rootCause', 'resolution', 'prevention', 'regressionTests']) {
    assert.ok(diagnosis.matches[0][field]?.length,
      `structured catalog match contains ${field}`);
  }
  const catalogRecord = getRootCauseRecord('rc-fmi-representation-drift');
  assert.ok(Object.isFrozen(catalogRecord));
  assert.equal(JSON.stringify(catalogRecord), JSON.stringify(getRootCauseRecord(catalogRecord.id)),
    'retrieval leaves the catalog record unchanged');
});

test('MCP known-issue diagnosis rejects undeclared or malformed inputs', () => {
  for (const [input, expected] of [
    [{ sympton: 'drift' }, /does not accept field\(s\): sympton/],
    [{ evidence: ['drift'] }, /requires a non-empty symptom/],
    [{ symptom: 'drift', tags: ['fmi', 'fmi'] }, /must not contain duplicates/],
    [{ symptom: 'drift', affectedSurfaces: ['remote-cloud'] }, /unsupported value/],
    [{ symptom: 'drift', limit: 0 }, /limit must be an integer from 1 to 10/],
  ]) {
    const result = mcpCall(input);
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, expected);
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  AUDIENCES,
  GRID_SEGMENTS,
  audienceFor,
  createDesignRecord,
  gridCustomerQuestions,
  personHistory,
  productSurface,
  projectHistory,
  recordMaterialChange,
  scopeForApplication,
  transitionDesign,
} from '../js/governance.js';

const AI = {
  id: 'design-guide', kind: 'ai', role: 'assistant', organization: 'battery-design',
  marketAccess: ['road', 'grid', 'marine'],
};
const VALIDATOR = {
  id: 'rust-validation', kind: 'system', role: 'validation-system', organization: 'battery-design',
  marketAccess: ['road', 'grid', 'marine'],
};
const ENGINEER = {
  id: 'eng-42', kind: 'human', role: 'application-engineer', organization: 'Example Engineering',
  marketAccess: ['road', 'grid'], authorities: ['review'],
};
const MANAGER = {
  id: 'mgr-7', kind: 'human', role: 'manager', organization: 'Example Engineering',
  marketAccess: ['grid', 'road'], authorities: ['approve', 'release'],
};
const TIMES = [
  '2026-08-05T08:00:00Z', '2026-08-05T09:00:00Z', '2026-08-05T10:00:00Z',
  '2026-08-05T11:00:00Z', '2026-08-05T12:00:00Z', '2026-08-05T13:00:00Z',
];

function approvedRecord() {
  let record = createDesignRecord({
    projectId: 'grid-demo',
    scope: scopeForApplication('solar-ess', { gridSegment: 'home' }),
    version: '1.0.0', actor: AI, reason: 'Prepare a four-hour home-outage design.', at: TIMES[0],
  });
  record = transitionDesign(record, {
    to: 'validated', actor: VALIDATOR, reason: 'All model, units and market gates passed.',
    evidence: 'validation/run-101', at: TIMES[1],
  });
  record = transitionDesign(record, {
    to: 'reviewed', actor: ENGINEER, reason: 'Critical loads and zero-solar fallback were reviewed.',
    evidence: 'review/eng-42', at: TIMES[2],
  });
  return transitionDesign(record, {
    to: 'approved', actor: MANAGER, reason: 'The reviewed design meets the required service.',
    evidence: 'approval/mgr-7', at: TIMES[3],
  });
}

test('audience depth is progressive and the manager has five calm sections', () => {
  assert.equal(AUDIENCES.manager.defaultMode, 'guided');
  assert.equal(AUDIENCES.manager.sections.length, 5);
  assert.equal(AUDIENCES.manager.canEditGraph, false);
  assert.equal(AUDIENCES['simulation-specialist'].canTuneSolvers, true);
  assert.deepEqual(audienceFor('integration-client').allowedModes, ['integration']);
  assert.throws(() => audienceFor('unknown'), /unknown product role/i);
});

test('each grid customer sees only its own questions plus solar and inverter', () => {
  const required = ['outage-duration', 'solar-during-outage', 'inverter', 'location'];
  for (const segment of Object.keys(GRID_SEGMENTS)) {
    const questions = gridCustomerQuestions(segment);
    const ids = questions.map((question) => question.id);
    for (const id of required) assert.ok(ids.includes(id), `${segment} includes ${id}`);
    assert.doesNotMatch(JSON.stringify(questions), /ship|marine|vehicle|flight|voyage/i);
  }
  assert.ok(gridCustomerQuestions('home').some((q) => q.id === 'essential-circuits'));
  assert.ok(!gridCustomerQuestions('home').some((q) => q.id === 'motor-surges'));
  assert.ok(gridCustomerQuestions('industrial').some((q) => q.id === 'motor-surges'));
  assert.ok(!gridCustomerQuestions('industrial').some((q) => q.id === 'essential-circuits'));
});

test('market scope cannot borrow another domain or omit grid segmentation', () => {
  assert.deepEqual(scopeForApplication('ev'), { application: 'ev', domain: 'road' });
  assert.deepEqual(
    scopeForApplication('solar-ess', { gridSegment: 'small-company' }),
    { application: 'solar-ess', domain: 'grid', gridSegment: 'small-company' },
  );
  assert.throws(() => scopeForApplication('solar-ess'), /require.*segmentation/i);
  assert.throws(() => scopeForApplication('marine', { gridSegment: 'home' }), /cannot be applied/i);
  assert.throws(
    () => productSurface('manager', { application: 'marine', domain: 'grid' }),
    /belongs to marine/i,
  );
});

test('AI drafts, the system validates, and named humans review and approve', () => {
  const approved = approvedRecord();
  assert.equal(approved.state, 'approved');
  assert.deepEqual(approved.history.map((event) => event.action), [
    'created', 'validated', 'reviewed', 'approved',
  ]);
  for (const event of approved.history) {
    assert.ok(event.actorId && event.actorKind && event.actorRole && event.actorOrganization);
    assert.ok(event.reason && event.at && event.toVersion);
    assert.ok(Array.isArray(event.actorAuthorities));
  }
  assert.ok(Object.isFrozen(approved));
  assert.ok(Object.isFrozen(approved.history));
  assert.ok(Object.isFrozen(approved.history[0]));
});

test('AI and unqualified people cannot approve their own output', () => {
  let draft = createDesignRecord({
    projectId: 'guarded', scope: scopeForApplication('ev'), version: '1',
    actor: AI, reason: 'Draft a road pack.', at: TIMES[0],
  });
  assert.throws(() => transitionDesign(draft, {
    to: 'validated', actor: AI, reason: 'I checked it.', evidence: 'self', at: TIMES[1],
  }), /validation system|authorized human/i);
  draft = transitionDesign(draft, {
    to: 'validated', actor: VALIDATOR, reason: 'Automated gates passed.', evidence: 'run/1', at: TIMES[1],
  });
  assert.throws(() => transitionDesign(draft, {
    to: 'reviewed', actor: AI, reason: 'I reviewed it.', evidence: 'self', at: TIMES[2],
  }), /identified human/i);
  assert.throws(() => transitionDesign(draft, {
    to: 'reviewed', actor: MANAGER, reason: 'Looks good.', evidence: 'note', at: TIMES[2],
  }), /review authority/i);
});

test('human authority is limited to the markets assigned to that person', () => {
  let record = createDesignRecord({
    projectId: 'marine-guarded', scope: scopeForApplication('marine'), version: '1',
    actor: AI, reason: 'Draft a marine pack.', at: TIMES[0],
  });
  record = transitionDesign(record, {
    to: 'validated', actor: VALIDATOR, reason: 'Automated gates passed.',
    evidence: 'run/marine-1', at: TIMES[1],
  });
  assert.throws(() => transitionDesign(record, {
    to: 'reviewed', actor: ENGINEER, reason: 'Review it.',
    evidence: 'review/out-of-scope', at: TIMES[2],
  }), /no marine market access/i);
});

test('a material change removes approval and preserves the exact history', () => {
  const approved = approvedRecord();
  const changed = recordMaterialChange(approved, {
    nextVersion: '1.1.0', actor: AI,
    reason: 'Customer added a larger critical refrigeration load.', at: TIMES[4],
  });
  assert.equal(approved.state, 'approved', 'the earlier immutable record is unchanged');
  assert.equal(changed.state, 'draft');
  assert.equal(changed.version, '1.1.0');
  assert.equal(changed.history.at(-1).fromState, 'approved');
  assert.equal(changed.history.at(-1).fromVersion, '1.0.0');
  assert.equal(changed.history.at(-1).toVersion, '1.1.0');
  assert.throws(() => recordMaterialChange(changed, {
    nextVersion: '1.1.0', actor: AI, reason: 'Silent edit', at: TIMES[5],
  }), /new design version/i);
});

test('release is a separate human decision on the exact approved version', () => {
  const approved = approvedRecord();
  const released = transitionDesign(approved, {
    to: 'released', actor: MANAGER,
    reason: 'Release the approved result and reproducible report.',
    evidence: 'release/report-1.0.0', at: TIMES[4],
  });
  assert.equal(released.state, 'released');
  assert.equal(released.version, approved.version);
  assert.equal(released.history.at(-1).action, 'released');
  assert.throws(() => transitionDesign(approved, {
    to: 'released', actor: ENGINEER, reason: 'Release it.',
    evidence: 'release/unqualified', at: TIMES[4],
  }), /release authority/i);
});

test('manager and person history are calm projections of one complete audit', () => {
  const approved = approvedRecord();
  const guided = projectHistory(approved, 'manager');
  const expert = projectHistory(approved, 'simulation-specialist');
  assert.equal(guided.events.length, expert.events.length);
  assert.ok(!('evidence' in guided.events[1]), 'guided history omits internal evidence identifiers');
  assert.equal(expert.events[1].evidence, 'validation/run-101');
  assert.match(guided.nextAction, /release/i);

  const managerEvents = personHistory([approved], MANAGER.id, 'manager');
  assert.equal(managerEvents.length, 1);
  assert.equal(managerEvents[0].projectId, 'grid-demo');
  assert.ok(!('evidence' in managerEvents[0]));
  assert.equal(personHistory([approved], MANAGER.id, 'simulation-specialist')[0].evidence, 'approval/mgr-7');
});

test('a manager surface never receives raw engineering concepts', () => {
  const scope = scopeForApplication('solar-ess', { gridSegment: 'industrial' });
  const manager = productSurface('manager', scope);
  const engineer = productSurface('application-engineer', scope);
  assert.equal(manager.engineeringConcepts.length, 0);
  assert.ok(engineer.engineeringConcepts.includes('ems-arch'));
  assert.equal(manager.customerQuestions.length, gridCustomerQuestions('industrial').length);
  assert.equal(manager.canTuneSolvers, false);
});

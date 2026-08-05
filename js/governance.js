// @ts-check
// governance.js — one calm product surface over one disciplined record.
//
// The numerical engine answers whether a design works. This module answers
// who may see which depth, which market the project belongs to, and who must
// accept responsibility before a result becomes authoritative. It is pure:
// no DOM, storage or network, so browser, desktop and API clients cannot give
// the same project different approval semantics.

import { familyOfApp } from './families.js';
import { appNeeds } from './knowledge.js';

/** @typedef {import('../types/core.ts').ProductRole} ProductRole */
/** @typedef {import('../types/core.ts').ProductDomain} ProductDomain */
/** @typedef {import('../types/core.ts').GridCustomerSegment} GridCustomerSegment */
/** @typedef {import('../types/core.ts').ProjectScope} ProjectScope */
/** @typedef {import('../types/core.ts').WorkflowActor} WorkflowActor */
/** @typedef {import('../types/core.ts').WorkflowAuthority} WorkflowAuthority */
/** @typedef {import('../types/core.ts').DesignState} DesignState */
/** @typedef {import('../types/core.ts').DesignHistoryAction} DesignHistoryAction */
/** @typedef {import('../types/core.ts').DesignHistoryEvent} DesignHistoryEvent */
/** @typedef {import('../types/core.ts').DesignRecord} DesignRecord */
/** @typedef {import('../types/core.ts').GridCustomerQuestion} GridCustomerQuestion */

const freeze = Object.freeze;

const MANAGER_SECTIONS = freeze([
  'What are we designing?',
  'What must it achieve?',
  'What assumptions are being used?',
  'What does the simulation predict?',
  'What decision requires approval?',
]);

// Roles select a default depth; authority is kept on the individual actor.
// A manager may have release authority without being shown solver controls,
// while a simulation specialist does not gain approval authority merely by
// seeing the equations.
export const AUDIENCES = freeze({
  manager: freeze({
    label: 'Guided Design', defaultMode: 'guided',
    allowedModes: freeze(['guided']), sections: MANAGER_SECTIONS,
    canEditGraph: false, canTuneSolvers: false, showsCompleteAudit: false,
  }),
  'application-engineer': freeze({
    label: 'Engineering Workbench', defaultMode: 'engineering',
    allowedModes: freeze(['guided', 'engineering']), sections: MANAGER_SECTIONS,
    canEditGraph: true, canTuneSolvers: false, showsCompleteAudit: true,
  }),
  'simulation-specialist': freeze({
    label: 'Expert Co-Simulation', defaultMode: 'expert',
    allowedModes: freeze(['guided', 'engineering', 'expert']), sections: MANAGER_SECTIONS,
    canEditGraph: true, canTuneSolvers: true, showsCompleteAudit: true,
  }),
  'integration-client': freeze({
    label: 'Integration API', defaultMode: 'integration',
    allowedModes: freeze(['integration']), sections: freeze([]),
    canEditGraph: false, canTuneSolvers: false, showsCompleteAudit: true,
  }),
});

/** @type {Readonly<Record<string, ProductDomain>>} */
const DOMAIN_BY_FAMILY = freeze({
  road: 'road', storage: 'grid', marine: 'marine', aerial: 'aerial',
  robotics: 'robotics', lmt: 'light-mobility', portable: 'portable',
  leisure: 'auxiliary',
});

const COMMON_GRID_QUESTIONS = freeze([
  freeze({
    id: 'outage-duration', label: 'How long must the critical service run?',
    why: 'The guaranteed result is sized for the required outage, not the average interruption.',
  }),
  freeze({
    id: 'solar-during-outage', label: 'Is dependable solar available during the outage?',
    why: 'Solar reduces guaranteed battery energy only when minimum outage-time production is verified; otherwise it receives zero credit.',
  }),
  freeze({
    id: 'inverter', label: 'What inverter is available?',
    why: 'Continuous power, surge, islanding and black-start are checked separately from battery energy.',
  }),
  freeze({
    id: 'location', label: 'Where will the system operate?',
    why: 'Temperature and site conditions change usable capacity and equipment limits.',
  }),
]);

/** @param {readonly GridCustomerQuestion[]} specific */
const gridQuestions = (specific) => freeze([...specific, ...COMMON_GRID_QUESTIONS]);

// Each segment owns its own words and questions. Shared solar and inverter
// questions are composed once; marine, vehicle and flight concepts never
// enter this customer flow.
export const GRID_SEGMENTS = freeze({
  home: freeze({
    label: 'Home',
    questions: gridQuestions([
      freeze({
        id: 'essential-circuits', label: 'Which essential circuits must stay on?',
        why: 'Lighting, refrigeration, communications, pumps and medical loads are sized as the protected service, not the whole house by default.',
      }),
    ]),
  }),
  'small-company': freeze({
    label: 'Small Company',
    questions: gridQuestions([
      freeze({
        id: 'critical-operations', label: 'Which business operations must continue?',
        why: 'Only the refrigeration, IT, point-of-sale, security, lighting or equipment named as critical is guaranteed.',
      }),
      freeze({
        id: 'measured-demand', label: 'Is measured demand data available?',
        why: 'A measured critical-load trace is preferred; otherwise the estimate and its assumptions remain explicit.',
      }),
    ]),
  }),
  industrial: freeze({
    label: 'Industrial',
    questions: gridQuestions([
      freeze({
        id: 'tier-1-loads', label: 'Which safety and control loads must never stop?',
        why: 'Tier 1 establishes the non-negotiable islanded service.',
      }),
      freeze({
        id: 'tier-2-loads', label: 'Which production loads should continue?',
        why: 'Tier 2 is retained only when energy, power and restart margins support it.',
      }),
      freeze({
        id: 'motor-surges', label: 'Which motors or compressors must start?',
        why: 'Starting current can size the inverter even when the four-hour energy is sufficient.',
      }),
      freeze({
        id: 'measured-demand', label: 'Is measured demand data available?',
        why: 'Interval and event data prevent a generic profile from standing in for the plant.',
      }),
    ]),
  }),
});

/** @param {ProductRole} roleId */
export function audienceFor(roleId) {
  const audience = AUDIENCES[roleId];
  if (!audience) throw new RangeError(`Unknown product role: ${roleId}`);
  return audience;
}

/** @param {GridCustomerSegment} segmentId */
export function gridCustomerQuestions(segmentId) {
  const segment = GRID_SEGMENTS[segmentId];
  if (!segment) throw new RangeError(`Unknown grid customer segment: ${segmentId}`);
  return segment.questions;
}

/**
 * Resolve one application into one product domain. Grid projects require the
 * customer segment because a house, a shop and a plant do not share a front.
 *
 * @param {string} application
 * @param {{ gridSegment?: GridCustomerSegment }} [options]
 * @returns {ProjectScope}
 */
export function scopeForApplication(application, options = {}) {
  const family = familyOfApp(application);
  if (!family) throw new RangeError(`Unknown application: ${application}`);
  const domain = DOMAIN_BY_FAMILY[family.id];
  if (!domain) throw new RangeError(`Application ${application} has no product domain.`);

  if (domain === 'grid') {
    const segment = options.gridSegment;
    if (!segment || !GRID_SEGMENTS[segment]) {
      throw new RangeError('Grid projects require home, small-company or industrial segmentation.');
    }
    return freeze({ application, domain, gridSegment: segment });
  }
  if (options.gridSegment != null) {
    throw new RangeError(`Grid segment ${options.gridSegment} cannot be applied to ${domain}.`);
  }
  return freeze({ application, domain });
}

/**
 * The product surface is a view of the same scope, never a second model.
 * Managers receive the five-question decision surface; engineering depth is
 * returned only to roles that deliberately open it.
 *
 * @param {ProductRole} roleId
 * @param {ProjectScope} requestedScope
 */
export function productSurface(roleId, requestedScope) {
  const audience = audienceFor(roleId);
  const scope = scopeForApplication(requestedScope.application, {
    ...(requestedScope.gridSegment ? { gridSegment: requestedScope.gridSegment } : {}),
  });
  if (scope.domain !== requestedScope.domain) {
    throw new RangeError(`Application ${scope.application} belongs to ${scope.domain}, not ${requestedScope.domain}.`);
  }
  return freeze({
    role: roleId,
    mode: audience.defaultMode,
    label: audience.label,
    scope,
    sections: audience.sections,
    customerQuestions: scope.domain === 'grid'
      ? gridCustomerQuestions(/** @type {GridCustomerSegment} */ (scope.gridSegment))
      : freeze([]),
    engineeringConcepts: audience.canEditGraph ? freeze(appNeeds(scope.application)) : freeze([]),
    canEditGraph: audience.canEditGraph,
    canTuneSolvers: audience.canTuneSolvers,
    showsCompleteAudit: audience.showsCompleteAudit,
  });
}

export const DESIGN_STATES = freeze(['draft', 'validated', 'reviewed', 'approved', 'released']);

/** @param {DesignState[]} states @returns {readonly DesignState[]} */
const stateList = (states) => freeze(states);

/** @type {Readonly<Record<DesignState, readonly DesignState[]>>} */
const NEXT_STATE = freeze({
  draft: stateList(['validated']),
  validated: stateList(['reviewed']),
  reviewed: stateList(['approved']),
  approved: stateList(['released']),
  released: stateList([]),
});

/** @param {WorkflowActor} actor */
function validateActor(actor) {
  if (!actor?.id || !actor.role || !actor.organization
      || !Array.isArray(actor.marketAccess)
      || !['human', 'ai', 'system'].includes(actor.kind)) {
    throw new TypeError('Every workflow action requires an identified human, AI or system actor.');
  }
}

/** @param {WorkflowActor} actor @param {WorkflowAuthority} authority */
const hasAuthority = (actor, authority) => actor.authorities?.includes(authority) === true;

/** @param {WorkflowActor} actor @param {ProductDomain} domain */
function requireMarketAccess(actor, domain) {
  if (!actor.marketAccess.includes(domain)) {
    throw new Error(`${actor.id} has no ${domain} market access.`);
  }
}

/** @param {string | undefined} at */
function eventTime(at) {
  const value = at || new Date().toISOString();
  if (Number.isNaN(Date.parse(value))) throw new TypeError(`Invalid workflow time: ${value}`);
  return value;
}

/** @param {string} value @param {string} label */
function requiredText(value, label) {
  const text = String(value || '').trim();
  if (!text) throw new TypeError(`${label} is required.`);
  return text;
}

/** @param {DesignRecord} record */
function immutableRecord(record) {
  return freeze({
    ...record,
    scope: freeze({ ...record.scope }),
    history: freeze(record.history.map((event) => freeze({
      ...event, actorAuthorities: freeze([...event.actorAuthorities]),
    }))),
  });
}

/**
 * @param {string} projectId
 * @param {number} index
 * @param {DesignHistoryAction} action
 */
const eventId = (projectId, index, action) => `${projectId}:${String(index + 1).padStart(4, '0')}:${action}`;

/**
 * Begin one governed design. AI may prepare the draft, but that gives it no
 * authority over validation, review, approval or release.
 *
 * @param {{ projectId: string, scope: ProjectScope, version: string, actor: WorkflowActor, reason: string, at?: string }} input
 * @returns {DesignRecord}
 */
export function createDesignRecord(input) {
  validateActor(input.actor);
  const projectId = requiredText(input.projectId, 'Project id');
  const version = requiredText(input.version, 'Design version');
  const reason = requiredText(input.reason, 'Creation reason');
  const scope = scopeForApplication(input.scope.application, {
    ...(input.scope.gridSegment ? { gridSegment: input.scope.gridSegment } : {}),
  });
  if (scope.domain !== input.scope.domain) throw new RangeError('The supplied project scope does not match the application.');
  requireMarketAccess(input.actor, scope.domain);
  const at = eventTime(input.at);
  /** @type {DesignHistoryEvent} */
  const created = {
    id: eventId(projectId, 0, 'created'), action: 'created',
    actorId: input.actor.id, actorKind: input.actor.kind, actorRole: input.actor.role,
    actorOrganization: input.actor.organization,
    actorAuthorities: freeze([...(input.actor.authorities || [])]),
    fromState: null, toState: 'draft', fromVersion: null, toVersion: version,
    reason, at, evidence: null,
  };
  return immutableRecord({ projectId, scope, state: 'draft', version, history: [created] });
}

/**
 * Advance through the authoritative path. Evidence is required at every gate;
 * AI can never mark its own draft reviewed, approved or released.
 *
 * @param {DesignRecord} record
 * @param {{ to: DesignState, actor: WorkflowActor, reason: string, evidence: string, at?: string }} command
 * @returns {DesignRecord}
 */
export function transitionDesign(record, command) {
  validateActor(command.actor);
  requireMarketAccess(command.actor, record.scope.domain);
  if (!DESIGN_STATES.includes(command.to)) throw new RangeError(`Unknown design state: ${command.to}`);
  if (!NEXT_STATE[record.state].includes(command.to)) {
    throw new RangeError(`Design state cannot move directly from ${record.state} to ${command.to}.`);
  }

  if (command.to === 'validated') {
    if (command.actor.kind !== 'system' && !(command.actor.kind === 'human' && hasAuthority(command.actor, 'validate'))) {
      throw new Error('Validation must come from the validation system or an authorized human.');
    }
  } else {
    const authority = /** @type {WorkflowAuthority} */ (command.to === 'reviewed' ? 'review' : command.to === 'approved' ? 'approve' : 'release');
    if (command.actor.kind !== 'human' || !hasAuthority(command.actor, authority)) {
      throw new Error(`${command.to} requires an identified human with ${authority} authority.`);
    }
  }

  const reason = requiredText(command.reason, 'Decision reason');
  const evidence = requiredText(command.evidence, 'Decision evidence');
  const at = eventTime(command.at);
  const action = /** @type {DesignHistoryAction} */ (command.to);
  /** @type {DesignHistoryEvent} */
  const event = {
    id: eventId(record.projectId, record.history.length, action), action,
    actorId: command.actor.id, actorKind: command.actor.kind, actorRole: command.actor.role,
    actorOrganization: command.actor.organization,
    actorAuthorities: freeze([...(command.actor.authorities || [])]),
    fromState: record.state, toState: command.to,
    fromVersion: record.version, toVersion: record.version,
    reason, at, evidence,
  };
  return immutableRecord({
    ...record, state: command.to,
    history: [...record.history, event],
  });
}

/**
 * A material change creates a new draft version. It never edits an approved
 * event or quietly leaves the approval badge on a changed design.
 *
 * @param {DesignRecord} record
 * @param {{ nextVersion: string, actor: WorkflowActor, reason: string, at?: string }} command
 * @returns {DesignRecord}
 */
export function recordMaterialChange(record, command) {
  validateActor(command.actor);
  requireMarketAccess(command.actor, record.scope.domain);
  const nextVersion = requiredText(command.nextVersion, 'Next design version');
  if (nextVersion === record.version) throw new Error('A material change must create a new design version.');
  const reason = requiredText(command.reason, 'Change reason');
  const at = eventTime(command.at);
  /** @type {DesignHistoryEvent} */
  const event = {
    id: eventId(record.projectId, record.history.length, 'material-change'), action: 'material-change',
    actorId: command.actor.id, actorKind: command.actor.kind, actorRole: command.actor.role,
    actorOrganization: command.actor.organization,
    actorAuthorities: freeze([...(command.actor.authorities || [])]),
    fromState: record.state, toState: 'draft',
    fromVersion: record.version, toVersion: nextVersion,
    reason, at, evidence: null,
  };
  return immutableRecord({
    ...record, state: 'draft', version: nextVersion,
    history: [...record.history, event],
  });
}

/** @param {DesignState} state */
export function nextWorkflowAction(state) {
  return ({
    draft: 'Run the engineering validation before asking anyone to accept the design.',
    validated: 'A named human engineer must review the assumptions and evidence.',
    reviewed: 'An authorized human must approve this exact version.',
    approved: 'An authorized human must release the preserved result and report.',
    released: 'This version is preserved; any material change starts a new draft.',
  })[state];
}

/**
 * Guided history keeps milestones readable and omits evidence identifiers;
 * engineering and expert roles receive the complete immutable events.
 *
 * @param {DesignRecord} record
 * @param {ProductRole} roleId
 */
export function projectHistory(record, roleId) {
  const audience = audienceFor(roleId);
  const events = audience.showsCompleteAudit
    ? record.history
    : freeze(record.history.map((event) => freeze({
      action: event.action, actorId: event.actorId, at: event.at,
      state: event.toState, version: event.toVersion, reason: event.reason,
    })));
  return freeze({
    projectId: record.projectId, state: record.state, version: record.version,
    nextAction: nextWorkflowAction(record.state), events,
  });
}

/**
 * Build the person's cross-project history from the same event records. This
 * is a projection, not a second audit log, so it cannot drift from a project.
 *
 * @param {readonly DesignRecord[]} records
 * @param {string} actorId
 * @param {ProductRole} roleId
 */
export function personHistory(records, actorId, roleId) {
  const id = requiredText(actorId, 'Actor id');
  const complete = audienceFor(roleId).showsCompleteAudit;
  const events = records.flatMap((record) => record.history
    .filter((event) => event.actorId === id)
    .map((event) => complete
      ? freeze({ projectId: record.projectId, ...event })
      : freeze({
        projectId: record.projectId, action: event.action, at: event.at,
        state: event.toState, version: event.toVersion, reason: event.reason,
      })))
    .sort((a, b) => String(a.at).localeCompare(String(b.at)));
  return freeze(events);
}

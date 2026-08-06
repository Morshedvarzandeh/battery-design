// isolation-rule.js — one topology-aware resolver for UN Regulation No. 100
// vehicle isolation-resistance cases.
//
// Pure data and functions: browser, Node.js and Worker-safe. The resolver
// deliberately refuses a number until the electrical-bus topology is known.
// UN R100 Rev. 3, paragraphs 5.1.3.1 and 5.1.3.2 distinguish:
//   - galvanically separated DC bus: 100 ohm/V;
//   - galvanically separated AC bus: 500 ohm/V;
//   - galvanically connected AC/DC buses: 500 ohm/V baseline;
//   - connected AC/DC buses with the specified protection on every AC bus:
//     100 ohm/V.
// These are topology cases, not conflicting values to average and not a
// general rule for stationary or marine IT distribution systems.

import { evaluateRuleApplicability, ruleDefinition } from './ontology-rules.js';

export const UN_R100_ISOLATION_SOURCE = Object.freeze({
  code: 'UN R100 Rev. 3',
  clauses: Object.freeze(['5.1.3.1', '5.1.3.2']),
  title: 'UN Regulation No. 100, Revision 3 — electric power train safety',
  url: 'https://unece.org/sites/default/files/2024-01/R0100r3e.pdf',
});

export const ISOLATION_CONTEXTS = Object.freeze({
  'un-r100-separate-dc': Object.freeze({
    applicationContext: 'road-vehicle',
    busType: 'dc',
    topology: 'galvanically-separated',
    clause: '5.1.3.1',
    label: 'UN R100 — separate DC bus',
  }),
  'un-r100-separate-ac': Object.freeze({
    applicationContext: 'road-vehicle',
    busType: 'ac',
    topology: 'galvanically-separated',
    clause: '5.1.3.1',
    label: 'UN R100 — separate AC bus',
  }),
  'un-r100-connected-ac-dc': Object.freeze({
    applicationContext: 'road-vehicle',
    busType: 'ac-dc',
    topology: 'galvanically-connected',
    clause: '5.1.3.2',
    label: 'UN R100 — connected AC/DC buses (baseline)',
  }),
  'un-r100-connected-ac-dc-protected': Object.freeze({
    applicationContext: 'road-vehicle',
    busType: 'ac-dc',
    topology: 'galvanically-connected',
    clause: '5.1.3.2',
    requiresAcProtectionEvidence: true,
    label: 'UN R100 — connected AC/DC buses with protected AC buses',
  }),
});

const ONTOLOGY_RULE_KEY = 'un-r100-isolation';

function canonicalIsolationRule() {
  const rule = ruleDefinition(ONTOLOGY_RULE_KEY);
  if (!rule) throw new Error('The governed UN R100 ontology rule is missing.');
  return rule;
}

function conditionsOf(expression) {
  return Array.isArray(expression?.conditions) ? expression.conditions : [expression];
}

function protectedAcTypes(rule) {
  const protectedCriterion = (rule.criteria || []).find((criterion) =>
    conditionsOf(criterion.when).some((condition) =>
      condition?.fact === 'architecture.isolationContext'
      && condition?.operator === 'eq'
      && condition?.value === 'un-r100-connected-ac-dc-protected'));
  const protectionCondition = conditionsOf(protectedCriterion?.when).find((condition) =>
    condition?.fact === 'architecture.acProtection' && condition?.operator === 'in');
  return Array.isArray(protectionCondition?.value) ? protectionCondition.value : [];
}

// This compatibility export is derived from the governed rule. It does not
// maintain a second list beside the ontology criterion.
export const AC_PROTECTION_TYPES = Object.freeze([...protectedAcTypes(canonicalIsolationRule())]);

// Kept only so existing projects remain reproducible. Each legacy selector
// now resolves to a named topology case; neither is treated as a blanket
// statement about an entire standard.
export const LEGACY_ISOLATION_CONTEXT_ALIASES = Object.freeze({
  'ece-r100': 'un-r100-connected-ac-dc',
  'iso-6469-dc': 'un-r100-separate-dc',
});

function isPositiveFinite(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function contextIdFromFields({ busType, topology, acProtection }) {
  if (!busType || !topology) return null;
  if (topology === 'galvanically-separated' && busType === 'dc') {
    return 'un-r100-separate-dc';
  }
  if (topology === 'galvanically-separated' && busType === 'ac') {
    return 'un-r100-separate-ac';
  }
  if (topology === 'galvanically-connected' && busType === 'ac-dc') {
    return acProtection && acProtection !== 'none'
      ? 'un-r100-connected-ac-dc-protected'
      : 'un-r100-connected-ac-dc';
  }
  return null;
}

function ontologyFacts({ workingVoltageV, applicationContext, contextId, acProtection }) {
  return {
    application: {
      class: applicationContext === 'road-vehicle'
        ? 'vehicle'
        : applicationContext === 'marine-it' ? 'marine' : 'non-road',
    },
    pack: { maximumVoltage: { value: workingVoltageV, unit: 'V' } },
    architecture: {
      isolationContext: contextId,
      electricalReference: applicationContext === 'road-vehicle'
        ? 'electrical-chassis'
        : 'unearthed-or-project-defined',
      acProtection,
    },
  };
}

function ontologyTrace(rule, evaluation, criterion = null) {
  return Object.freeze({
    id: rule.id,
    authority: rule.authority,
    basis: rule.basis,
    applies: evaluation.applies,
    complete: evaluation.complete,
    missingFacts: Object.freeze([...evaluation.missingFacts]),
    unmatchedCriteriaOutcome: evaluation.unmatchedCriteriaOutcome,
    criterion: criterion ? Object.freeze({
      kind: criterion.kind,
      coefficient: Object.freeze({ ...criterion.coefficient }),
    }) : null,
    evidence: rule.evidence,
  });
}

function governedCriterion({
  workingVoltageV, applicationContext, contextId, acProtection,
  outOfScopeOutcome = 'throw',
}) {
  const rule = canonicalIsolationRule();
  const evaluation = evaluateRuleApplicability(ONTOLOGY_RULE_KEY, ontologyFacts({
    workingVoltageV, applicationContext, contextId, acProtection,
  }));
  if (applicationContext !== 'road-vehicle') {
    return { rule, evaluation, criterion: null, trace: ontologyTrace(rule, evaluation) };
  }
  if (!evaluation.applies) {
    if (outOfScopeOutcome === 'review') {
      return { rule, evaluation, criterion: null, trace: ontologyTrace(rule, evaluation) };
    }
    throw new RangeError(
      `The governed UN R100 ontology rule does not apply at ${workingVoltageV} V for this application.`
    );
  }
  if (!evaluation.complete || evaluation.criteria.length !== 1) {
    throw new Error(
      `The governed UN R100 ontology rule did not resolve exactly one complete criterion for ${contextId}.`
    );
  }
  const criterion = evaluation.criteria[0];
  const coefficient = criterion?.coefficient;
  if (criterion.kind !== 'minimum-resistance-per-working-voltage'
      || coefficient?.unit !== 'OhmPerV'
      || !(Number.isFinite(coefficient.numericValue) && coefficient.numericValue > 0)) {
    throw new Error(`The governed UN R100 criterion for ${contextId} has no valid OhmPerV coefficient.`);
  }
  return { rule, evaluation, criterion, trace: ontologyTrace(rule, evaluation, criterion) };
}

function reviewOnlyResult({
  workingVoltageV, contextId, applicationContext, ontologyRule, outOfScope = false,
}) {
  const marine = applicationContext === 'marine-it';
  return {
    applies: false,
    status: 'review-required',
    contextId,
    applicationContext,
    workingVoltageV,
    busType: null,
    topology: null,
    ohmsPerVolt: null,
    floorOhm: null,
    floorKOhm: null,
    standard: UN_R100_ISOLATION_SOURCE.code,
    standardLabel: outOfScope
      ? 'UN R100 voltage scope requires a different system treatment'
      : marine
      ? 'Marine IT isolation basis not selected'
      : 'Non-road isolation basis not selected',
    clause: null,
    basis: outOfScope
      ? `The declared ${workingVoltageV} V working voltage is outside the governed UN R100 ontology rule scope ` +
        '(above 60 V and not above 1500 V). No numeric isolation floor is reported; review system segmentation and the applicable high-voltage installation rule.'
      : marine
      ? 'UN R100 is a road-vehicle rule and is not applied as the design floor. ' +
        'For a marine IT system, declare the distribution topology, earthing philosophy, ' +
        'insulation-monitoring arrangement, class rules and flag-state requirements.'
      : 'UN R100 is a road-vehicle rule and is not applied as the design floor. ' +
        'Declare the applicable installation standard, distribution topology and earthing arrangement.',
    groundingNote: outOfScope
      ? 'Do not extrapolate the UN R100 ohms-per-volt coefficient beyond its declared voltage scope.'
      : marine
      ? 'Marine IT systems are normally assessed as intentionally unearthed systems; ' +
        'do not substitute a chassis-referenced UN R100 calculation.'
      : 'Do not substitute a road-vehicle chassis calculation for a different earthing topology.',
    ontologyRule,
  };
}

/**
 * Resolve one UN R100 isolation rule without inference or averaging.
 *
 * Callers may provide a contextId, or the explicit busType + topology pair.
 * applicationContext is mandatory so a road-vehicle rule cannot silently
 * become a marine or stationary-system rule.
 */
export function resolveIsolationRule(input = {}) {
  const {
    workingVoltageV,
    applicationContext,
    busType,
    topology,
    acProtection = 'none',
  } = input;
  if (!isPositiveFinite(workingVoltageV)) {
    throw new RangeError('Isolation resolution requires a positive finite workingVoltageV.');
  }
  if (!applicationContext) {
    throw new Error('Isolation resolution requires applicationContext (for example road-vehicle or marine-it).');
  }

  const requestedId = input.contextId || null;
  const aliasedId = requestedId
    ? (LEGACY_ISOLATION_CONTEXT_ALIASES[requestedId] || requestedId)
    : contextIdFromFields({ busType, topology, acProtection });
  if (requestedId && !ISOLATION_CONTEXTS[aliasedId]) {
    throw new Error(`Unknown isolation context: ${requestedId}`);
  }
  if (applicationContext !== 'road-vehicle') {
    const governed = governedCriterion({
      workingVoltageV, applicationContext, contextId: aliasedId, acProtection,
    });
    return reviewOnlyResult({
      workingVoltageV,
      contextId: aliasedId,
      applicationContext,
      ontologyRule: governed.trace,
    });
  }
  if (!aliasedId) {
    throw new Error(
      'Isolation resolution requires a recognized contextId or an explicit busType/topology pair; ' +
      'DC, AC and connected AC/DC cases must not be averaged.'
    );
  }

  const rule = ISOLATION_CONTEXTS[aliasedId];
  if (!rule) {
    throw new Error(`Unknown isolation context: ${requestedId || aliasedId}`);
  }
  if (rule.requiresAcProtectionEvidence && !AC_PROTECTION_TYPES.includes(acProtection)) {
    throw new Error(
      'The 100 ohm/V connected-bus exception requires evidence that every AC bus has either ' +
      'double-or-more solid insulation or mechanically robust protection.'
    );
  }

  // A contextId is itself an explicit topology choice. If fields are also
  // supplied they must agree; conflicting inputs are rejected.
  if (busType && busType !== rule.busType) {
    throw new Error(`Isolation busType ${busType} conflicts with context ${aliasedId} (${rule.busType}).`);
  }
  if (topology && topology !== rule.topology) {
    throw new Error(`Isolation topology ${topology} conflicts with context ${aliasedId} (${rule.topology}).`);
  }

  const governed = governedCriterion({
    workingVoltageV, applicationContext, contextId: aliasedId, acProtection,
    outOfScopeOutcome: input.outOfScopeOutcome,
  });
  if (!governed.evaluation.applies) {
    return reviewOnlyResult({
      workingVoltageV,
      contextId: aliasedId,
      applicationContext,
      ontologyRule: governed.trace,
      outOfScope: true,
    });
  }
  const coefficient = governed.criterion.coefficient.numericValue;
  const floorOhm = workingVoltageV * coefficient;
  return {
    applies: true,
    status: 'calculated',
    contextId: aliasedId,
    requestedContextId: requestedId,
    legacyAlias: requestedId && requestedId !== aliasedId ? requestedId : null,
    applicationContext,
    busType: rule.busType,
    topology: rule.topology,
    acProtection: rule.requiresAcProtectionEvidence ? acProtection : 'not-applicable',
    ohmsPerVolt: coefficient,
    floorOhm,
    floorKOhm: floorOhm / 1000,
    standard: UN_R100_ISOLATION_SOURCE.code,
    standardLabel: `${rule.label}, §${rule.clause}`,
    clause: rule.clause,
    basis:
      `${coefficient} Ω/V applies to the declared ${rule.busType.toUpperCase()} ` +
      `${rule.topology.replace('galvanically-', 'galvanically ')} vehicle-bus case.`,
    oemPracticeNote:
      'A higher project or manufacturer target may be selected, but it must remain separate from the regulatory floor.',
    groundingNote:
      'This calculation is between the vehicle high-voltage bus and electrical chassis. ' +
      'Do not apply it unchanged to an ungrounded marine IT distribution system.',
    source: UN_R100_ISOLATION_SOURCE,
    ontologyRule: governed.trace,
  };
}

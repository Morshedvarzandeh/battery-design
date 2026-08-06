// ontology-rules.js — portable, closed-world evaluation for declarative
// ontology rules. This runtime deliberately supports a tiny allowlisted
// grammar; it never executes rule-supplied JavaScript or mutates a design.

import {
  RULE_DEFINITIONS,
  RULE_EFFECTS,
  RULE_OPERATORS,
  UNIT_DEFINITIONS,
} from './ontology-schema.js';

const FACT_PATH = /^[A-Za-z][A-Za-z0-9_-]*(?:\.[A-Za-z][A-Za-z0-9_-]*)*$/;
const FORBIDDEN_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);
const ORDER_OPERATORS = new Set(['gt', 'gte', 'lt', 'lte']);
const DATE_OPERATORS = new Set(['onOrAfter']);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isoDateEpoch(value) {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) return null;
  const [year, month, day] = value.split('-').map(Number);
  const epoch = Date.UTC(year, month - 1, day);
  const date = new Date(epoch);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day ? epoch : null;
}

const safeFactPath = (path) => FACT_PATH.test(path || '')
  && !String(path).split('.').some((part) => FORBIDDEN_SEGMENTS.has(part));

function ruleError(rule, message) {
  return `${rule?.id || '(unnamed rule)'}: ${message}`;
}

/** Return stable schema problems without executing a rule. */
export function validateEngineeringRule(rule) {
  const problems = [];
  if (!rule || typeof rule !== 'object') return ['Rule must be an object.'];
  if (!/^bd:rule\/[a-z0-9-]+$/.test(rule.id || '')) problems.push(ruleError(rule, 'id must use bd:rule/<stable-key>.'));
  if (!rule.label) problems.push(ruleError(rule, 'label is required.'));
  if (rule.evaluator !== 'ontology-rule-runtime@1') problems.push(ruleError(rule, 'unknown evaluator.'));
  if (!['all', 'any'].includes(rule.match)) problems.push(ruleError(rule, 'match must be all or any.'));
  if (!Array.isArray(rule.when) || !rule.when.length) problems.push(ruleError(rule, 'at least one condition is required.'));
  for (const [index, condition] of (rule.when || []).entries()) {
    const prefix = `condition ${index}`;
    if (!safeFactPath(condition?.fact)) {
      problems.push(ruleError(rule, `${prefix} has an unsafe fact path.`));
    }
    if (!RULE_OPERATORS.includes(condition?.operator)) problems.push(ruleError(rule, `${prefix} uses unknown operator ${condition?.operator}.`));
    if (condition?.unit != null && !UNIT_DEFINITIONS[condition.unit]) problems.push(ruleError(rule, `${prefix} uses unknown unit ${condition.unit}.`));
    if (['in', 'notIn'].includes(condition?.operator) && !Array.isArray(condition.value)) {
      problems.push(ruleError(rule, `${prefix} requires an array value.`));
    }
    if (ORDER_OPERATORS.has(condition?.operator) && !Number.isFinite(condition.value)) {
      problems.push(ruleError(rule, `${prefix} requires a finite numeric comparison value.`));
    }
    if (DATE_OPERATORS.has(condition?.operator)
        && isoDateEpoch(condition?.value) == null) {
      problems.push(ruleError(rule, `${prefix} requires an ISO calendar date (YYYY-MM-DD).`));
    }
    if (!['exists', 'truthy', 'falsy'].includes(condition?.operator)
        && !Object.hasOwn(condition || {}, 'value')) {
      problems.push(ruleError(rule, `${prefix} requires a comparison value.`));
    }
  }
  for (const [index, requirement] of (rule.requiredFacts || []).entries()) {
    if (!safeFactPath(requirement?.fact)) {
      problems.push(ruleError(rule, `required fact ${index} has an unsafe fact path.`));
    }
    if (requirement?.oneOf != null && (!Array.isArray(requirement.oneOf) || !requirement.oneOf.length)) {
      problems.push(ruleError(rule, `required fact ${index} oneOf must be a non-empty array.`));
    }
  }
  if (rule.effect != null) {
    if (!RULE_EFFECTS.includes(rule.effect?.type)) problems.push(ruleError(rule, `unknown effect ${rule.effect?.type}.`));
    if (!rule.effect?.target || !rule.effect?.message) problems.push(ruleError(rule, 'effect target and message are required.'));
  } else if (!Array.isArray(rule.criteria) || !rule.criteria.length) {
    problems.push(ruleError(rule, 'a rule requires either a non-mutating effect or normative criteria.'));
  }
  for (const [index, criterion] of (rule.criteria || []).entries()) {
    if (!criterion?.kind) problems.push(ruleError(rule, `criterion ${index} kind is required.`));
    if (!criterion.coefficient && !Array.isArray(criterion.requirements)) {
      problems.push(ruleError(rule, `criterion ${index} needs a coefficient or requirement list.`));
    }
    if (criterion.coefficient && !Number.isFinite(criterion.coefficient.numericValue)) problems.push(ruleError(rule, `criterion ${index} needs a finite coefficient.`));
    if (criterion.coefficient && !UNIT_DEFINITIONS[criterion.coefficient.unit]) problems.push(ruleError(rule, `criterion ${index} uses an unknown coefficient unit.`));
    if (criterion.when) {
      const conditions = Array.isArray(criterion.when.conditions)
        ? criterion.when.conditions : [criterion.when];
      if (criterion.when.conditions && !['all', 'any'].includes(criterion.when.match)) {
        problems.push(ruleError(rule, `criterion ${index} condition group must match all or any.`));
      }
      for (const condition of conditions) {
        if (!safeFactPath(condition.fact) || !RULE_OPERATORS.includes(condition.operator)) {
          problems.push(ruleError(rule, `criterion ${index} has an invalid when condition.`));
        }
        if (condition.unit != null && !UNIT_DEFINITIONS[condition.unit]) {
          problems.push(ruleError(rule, `criterion ${index} uses unknown unit ${condition.unit}.`));
        }
        if (['in', 'notIn'].includes(condition.operator) && !Array.isArray(condition.value)) {
          problems.push(ruleError(rule, `criterion ${index} requires an array comparison value.`));
        }
        if (ORDER_OPERATORS.has(condition.operator) && !Number.isFinite(condition.value)) {
          problems.push(ruleError(rule, `criterion ${index} requires a finite numeric comparison value.`));
        }
        if (DATE_OPERATORS.has(condition.operator) && isoDateEpoch(condition.value) == null) {
          problems.push(ruleError(rule, `criterion ${index} requires an ISO calendar date (YYYY-MM-DD).`));
        }
        if (!['exists', 'truthy', 'falsy'].includes(condition.operator)
            && !Object.hasOwn(condition, 'value')) {
          problems.push(ruleError(rule, `criterion ${index} when condition requires a comparison value.`));
        }
      }
    }
  }
  return problems.sort();
}

function factAt(facts, path) {
  let value = facts;
  for (const part of path.split('.')) {
    if (value == null || typeof value !== 'object' || !Object.hasOwn(value, part)) {
      return { found: false, value: undefined };
    }
    value = value[part];
  }
  return { found: true, value };
}

function compare(operator, actual, expected) {
  if (operator === 'eq') return actual === expected;
  if (operator === 'neq') return actual !== expected;
  if (operator === 'in') return expected.includes(actual);
  if (operator === 'notIn') return !expected.includes(actual);
  if (operator === 'gt') return actual > expected;
  if (operator === 'gte') return actual >= expected;
  if (operator === 'lt') return actual < expected;
  if (operator === 'lte') return actual <= expected;
  if (operator === 'onOrAfter') {
    const actualMs = isoDateEpoch(actual);
    const expectedMs = isoDateEpoch(expected);
    return actualMs != null && expectedMs != null && actualMs >= expectedMs;
  }
  if (operator === 'truthy') return !!actual;
  if (operator === 'falsy') return !actual;
  return false;
}

function evaluateCondition(condition, facts) {
  const raw = factAt(facts, condition.fact);
  if (condition.operator === 'exists') {
    return {
      fact: condition.fact, operator: condition.operator, status: 'evaluated',
      matched: raw.found && raw.value != null,
    };
  }
  if (!raw.found || raw.value == null) {
    return { fact: condition.fact, operator: condition.operator, status: 'missing', matched: false };
  }
  if (DATE_OPERATORS.has(condition.operator) && isoDateEpoch(raw.value) == null) {
    return { fact: condition.fact, operator: condition.operator, status: 'invalid-fact', matched: false };
  }
  let actual = raw.value;
  if (condition.unit) {
    if (typeof actual !== 'object' || actual == null || !Object.hasOwn(actual, 'value') || !actual.unit) {
      return { fact: condition.fact, operator: condition.operator, status: 'missing-unit', expectedUnit: condition.unit, matched: false };
    }
    if (actual.unit !== condition.unit) {
      return { fact: condition.fact, operator: condition.operator, status: 'unit-mismatch', expectedUnit: condition.unit, actualUnit: actual.unit, matched: false };
    }
    actual = actual.value;
  }
  if (ORDER_OPERATORS.has(condition.operator) && !Number.isFinite(actual)) {
    return { fact: condition.fact, operator: condition.operator, status: 'invalid-fact', matched: false };
  }
  return {
    fact: condition.fact, operator: condition.operator, status: 'evaluated',
    matched: compare(condition.operator, actual, condition.value),
  };
}

function evaluateExpression(expression, facts) {
  const conditions = Array.isArray(expression?.conditions) ? expression.conditions : [expression];
  const results = conditions.map((condition) => evaluateCondition(condition, facts));
  const match = expression?.conditions ? expression.match : 'all';
  const complete = results.every((result) => result.status === 'evaluated');
  const matched = match === 'any'
    ? results.some((result) => result.status === 'evaluated' && result.matched)
    : complete && results.every((result) => result.matched);
  return {
    complete, matched, results,
    missingFacts: results.filter((result) => result.status !== 'evaluated').map((result) => result.fact),
  };
}

/** Evaluate one data-only rule. Missing or dimensionally incompatible facts
 * never match and are returned explicitly to the caller. */
export function evaluateEngineeringRule(rule, facts = {}) {
  const problems = validateEngineeringRule(rule);
  if (problems.length) throw new TypeError(problems.join(' '));
  const conditionResults = rule.when.map((condition) => evaluateCondition(condition, facts));
  const applicabilityComplete = conditionResults.every((result) => result.status === 'evaluated');
  const applies = rule.match === 'all'
    ? applicabilityComplete && conditionResults.every((result) => result.matched)
    : conditionResults.some((result) => result.status === 'evaluated' && result.matched);
  const requiredFactResults = (rule.requiredFacts || []).map((requirement) => {
    const raw = factAt(facts, requirement.fact);
    const accepted = raw.found && raw.value != null
      && (!requirement.oneOf || requirement.oneOf.includes(raw.value));
    return { fact: requirement.fact, status: accepted ? 'present' : 'missing', accepted };
  });
  const missingRequiredFacts = applies
    ? requiredFactResults.filter((result) => !result.accepted).map((result) => result.fact)
    : [];
  const missingConditionFacts = conditionResults
    .filter((result) => result.status !== 'evaluated').map((result) => result.fact);
  const criterionResults = applies && !missingRequiredFacts.length
    ? (rule.criteria || []).map((criterion) => ({
      criterion,
      evaluation: criterion.when
        ? evaluateExpression(criterion.when, facts)
        : { complete: true, matched: true, missingFacts: [] },
    })) : [];
  const matchingCriteria = criterionResults.filter((row) => row.evaluation.matched)
    .map((row) => row.criterion);
  const missingCriterionFacts = criterionResults
    .filter((row) => !row.evaluation.complete && row.evaluation.results?.some((result) => result.matched))
    .flatMap((row) => row.evaluation.missingFacts);
  const unmatchedCriteria = applies && Array.isArray(rule.criteria)
    && rule.criteria.length > 0 && matchingCriteria.length === 0;
  const missingFactOutcome = (missingConditionFacts.length
    || (applies && (missingRequiredFacts.length || missingCriterionFacts.length)))
    ? (rule.missingFactOutcome || 'review') : null;
  const unmatchedCriteriaOutcome = unmatchedCriteria && !missingCriterionFacts.length
    ? (rule.unmatchedCriteriaOutcome || 'review') : null;
  const complete = applicabilityComplete && missingRequiredFacts.length === 0
    && missingCriterionFacts.length === 0
    && (!unmatchedCriteria || unmatchedCriteriaOutcome === 'not-applicable');
  return {
    id: rule.id,
    label: rule.label,
    evaluator: rule.evaluator,
    complete,
    applies,
    applicabilityComplete,
    missingFacts: [...new Set([...missingConditionFacts, ...missingRequiredFacts, ...missingCriterionFacts])].sort(),
    conditionResults,
    requiredFactResults,
    missingFactOutcome,
    unmatchedCriteriaOutcome,
    effect: applies && rule.effect ? { ...rule.effect } : null,
    criteria: matchingCriteria.map((criterion) => ({ ...criterion })),
  };
}

export function ruleDefinition(id) {
  if (RULE_DEFINITIONS[id]) return RULE_DEFINITIONS[id];
  return Object.values(RULE_DEFINITIONS).find((rule) => rule.id === id) || null;
}

export function evaluateRuleApplicability(id, facts = {}) {
  const rule = ruleDefinition(id);
  if (!rule) throw new RangeError(`Unknown ontology rule "${id}".`);
  return evaluateEngineeringRule(rule, facts);
}

export function evaluateEngineeringRules(facts = {}, rules = RULE_DEFINITIONS) {
  return Object.entries(rules).sort(([a], [b]) => a.localeCompare(b)).map(([key, rule]) => ({
    key,
    ...evaluateEngineeringRule(rule, facts),
  }));
}

// root-cause-library.js — deterministic, dependency-free engineering memory.
//
// Keep this module browser-safe. It is the common read/validation/search layer
// intended for future browser, CLI and MCP projections; it performs no I/O and
// never fetches remote content.

import {
  ROOT_CAUSE_CATALOG_FORMAT,
  ROOT_CAUSE_RECORD_FORMAT,
  ROOT_CAUSE_RECORD_SCHEMA,
  ROOT_CAUSE_SCHEMA_VERSION,
  ROOT_CAUSE_STATUSES,
  ROOT_CAUSE_SURFACES,
} from '../knowledge/root-causes/schema.v1.js';
import { ROOT_CAUSE_SEED_CATALOG } from '../knowledge/root-causes/records.v1.js';

export {
  ROOT_CAUSE_CATALOG_FORMAT,
  ROOT_CAUSE_RECORD_FORMAT,
  ROOT_CAUSE_RECORD_SCHEMA,
  ROOT_CAUSE_SCHEMA_VERSION,
};

function deepFreeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function codepointCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function stableValueKey(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  if (seen.has(value)) return '"[Circular]"';
  seen.add(value);
  const result = Array.isArray(value)
    ? `[${value.map((item) => stableValueKey(item, seen)).join(',')}]`
    : `{${Object.keys(value).sort(codepointCompare)
      .map((key) => `${JSON.stringify(key)}:${stableValueKey(value[key], seen)}`).join(',')}}`;
  seen.delete(value);
  return result;
}

function pointerToken(value) {
  return String(value).replaceAll('~', '~0').replaceAll('/', '~1');
}

function schemaTypeMatches(value, type) {
  if (type === 'object') return value != null && typeof value === 'object' && !Array.isArray(value);
  if (type === 'array') return Array.isArray(value);
  if (type === 'string') return typeof value === 'string';
  if (type === 'integer') return Number.isInteger(value);
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (type === 'boolean') return typeof value === 'boolean';
  if (type === 'null') return value === null;
  return false;
}

function validationError(path, code, message) {
  return { path, code, message };
}

function validateSchemaValue(value, schema, path, errors, ancestors) {
  const objectValue = value != null && typeof value === 'object';
  if (objectValue && ancestors.has(value)) {
    errors.push(validationError(path, 'cycle', 'must be an acyclic JSON value'));
    return;
  }
  if (Object.prototype.hasOwnProperty.call(schema, 'const') && !Object.is(value, schema.const)) {
    errors.push(validationError(path, 'const', `must equal ${JSON.stringify(schema.const)}`));
    return;
  }
  if (schema.enum && !schema.enum.some((entry) => Object.is(entry, value))) {
    errors.push(validationError(path, 'enum', `must be one of: ${schema.enum.join(', ')}`));
    return;
  }
  if (schema.type && !schemaTypeMatches(value, schema.type)) {
    errors.push(validationError(path, 'type', `must be ${schema.type}`));
    return;
  }
  if (typeof value === 'string') {
    if (schema.minLength != null && value.length < schema.minLength) {
      errors.push(validationError(path, 'minLength', `must contain at least ${schema.minLength} characters`));
    }
    if (schema.pattern && !(new RegExp(schema.pattern, 'u')).test(value)) {
      errors.push(validationError(path, 'pattern', `must match ${schema.pattern}`));
    }
  }
  if (typeof value === 'number' && schema.minimum != null && value < schema.minimum) {
    errors.push(validationError(path, 'minimum', `must be at least ${schema.minimum}`));
  }
  if (!objectValue) return;
  ancestors.add(value);
  if (Array.isArray(value)) {
    if (schema.minItems != null && value.length < schema.minItems) {
      errors.push(validationError(path, 'minItems', `must contain at least ${schema.minItems} items`));
    }
    if (schema.uniqueItems) {
      const seen = new Set();
      for (let index = 0; index < value.length; index += 1) {
        const key = stableValueKey(value[index]);
        if (seen.has(key)) {
          errors.push(validationError(`${path}/${index}`, 'uniqueItems', 'must not duplicate another item'));
        }
        seen.add(key);
      }
    }
    if (schema.items) {
      for (let index = 0; index < value.length; index += 1) {
        validateSchemaValue(value[index], schema.items, `${path}/${index}`, errors, ancestors);
      }
    }
  } else {
    const properties = schema.properties || {};
    for (const key of schema.required || []) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) {
        errors.push(validationError(`${path}/${pointerToken(key)}`, 'required', 'is required'));
      }
    }
    for (const key of Object.keys(value).sort(codepointCompare)) {
      if (Object.prototype.hasOwnProperty.call(properties, key)) {
        validateSchemaValue(value[key], properties[key], `${path}/${pointerToken(key)}`, errors, ancestors);
      } else if (schema.additionalProperties === false) {
        errors.push(validationError(`${path}/${pointerToken(key)}`, 'additionalProperties', 'is not allowed'));
      }
    }
  }
  ancestors.delete(value);
}

function sortedUnique(values) {
  return [...new Set(values)].sort(codepointCompare);
}

function appendOrderingIssue(errors, record, field, path) {
  const values = record[field];
  if (!Array.isArray(values) || values.some((value) => typeof value !== 'string')) return;
  if (values.join('\n') !== sortedUnique(values).join('\n')) {
    errors.push(validationError(`${path}/${field}`, 'canonicalOrder', 'must be unique and sorted in code-point order'));
  }
}

/** Validate one record without mutating or freezing caller-owned input. */
export function validateRootCauseRecord(value, options = {}) {
  requireOptions(options, ['path'], 'Root-cause validation');
  const path = options.path ?? '$';
  if (typeof path !== 'string' || !path) throw new TypeError('Root-cause validation path must be a non-empty string.');
  const errors = [];
  validateSchemaValue(value, ROOT_CAUSE_RECORD_SCHEMA, path, errors, new WeakSet());
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    appendOrderingIssue(errors, value, 'affectedSurfaces', path);
    appendOrderingIssue(errors, value, 'tags', path);
  }
  return deepFreeze(errors);
}

/** Validate catalog identity, record order, uniqueness and every closed record. */
export function validateRootCauseCatalog(catalog = ROOT_CAUSE_SEED_CATALOG) {
  const errors = [];
  if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog)) {
    return deepFreeze([validationError('$', 'type', 'catalog must be an object')]);
  }
  const allowed = new Set(['format', 'version', 'records']);
  for (const key of Object.keys(catalog).sort(codepointCompare)) {
    if (!allowed.has(key)) errors.push(validationError(`$/${pointerToken(key)}`, 'additionalProperties', 'is not allowed'));
  }
  if (catalog.format !== ROOT_CAUSE_CATALOG_FORMAT) {
    errors.push(validationError('$/format', 'const', `must equal ${ROOT_CAUSE_CATALOG_FORMAT}`));
  }
  if (catalog.version !== ROOT_CAUSE_SCHEMA_VERSION) {
    errors.push(validationError('$/version', 'const', `must equal ${ROOT_CAUSE_SCHEMA_VERSION}`));
  }
  if (!Array.isArray(catalog.records)) {
    errors.push(validationError('$/records', 'type', 'must be an array'));
    return deepFreeze(errors);
  }
  const ids = new Set();
  let priorId = null;
  for (let index = 0; index < catalog.records.length; index += 1) {
    const current = catalog.records[index];
    errors.push(...validateRootCauseRecord(current, { path: `$/records/${index}` }));
    if (typeof current?.id !== 'string') continue;
    if (ids.has(current.id)) {
      errors.push(validationError(`$/records/${index}/id`, 'uniqueId', `duplicates ${current.id}`));
    }
    if (priorId != null && codepointCompare(priorId, current.id) >= 0) {
      errors.push(validationError(`$/records/${index}/id`, 'canonicalOrder', 'record ids must be unique and strictly increasing'));
    }
    ids.add(current.id);
    priorId = current.id;
  }
  return deepFreeze(errors);
}

const seedErrors = validateRootCauseCatalog(ROOT_CAUSE_SEED_CATALOG);
if (seedErrors.length) {
  const detail = seedErrors.map(({ path, message }) => `${path}: ${message}`).join('; ');
  throw new Error(`Invalid built-in root-cause catalog: ${detail}`);
}

export const ROOT_CAUSE_CATALOG = ROOT_CAUSE_SEED_CATALOG;
export const ROOT_CAUSE_RECORDS = ROOT_CAUSE_CATALOG.records;

const RECORDS_BY_ID = new Map(ROOT_CAUSE_RECORDS.map((entry) => [entry.id, entry]));

function normalizeText(value) {
  return String(value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, ' ')
    .trim();
}

const TOKEN_STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'for', 'from',
  'in', 'into', 'is', 'it', 'of', 'on', 'or', 'that', 'the', 'their', 'this',
  'to', 'was', 'when', 'while', 'with',
]);

function tokens(value) {
  const normalized = normalizeText(value);
  return normalized
    ? sortedUnique(normalized.split(/\s+/u).filter((token) => token && !TOKEN_STOP_WORDS.has(token)))
    : [];
}

function requireOptions(options, allowed, label) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError(`${label} options must be one object.`);
  }
  const unknown = Object.keys(options).filter((key) => !allowed.includes(key)).sort(codepointCompare);
  if (unknown.length) throw new TypeError(`${label} does not accept option(s): ${unknown.join(', ')}.`);
}

function requireLimit(value, fallback) {
  const limit = value ?? fallback;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new RangeError('Root-cause result limit must be an integer from 1 to 100.');
  }
  return limit;
}

function requireStatus(value) {
  if (value == null) return null;
  if (typeof value !== 'string' || !ROOT_CAUSE_STATUSES.includes(value)) {
    throw new TypeError(`Root-cause status must be one of: ${ROOT_CAUSE_STATUSES.join(', ')}.`);
  }
  return value;
}

function requireStringList(value, label, allowed = null) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item)) {
    throw new TypeError(`${label} must be an array of non-empty strings.`);
  }
  const result = sortedUnique(value);
  if (allowed) {
    const unknown = result.filter((item) => !allowed.includes(item));
    if (unknown.length) throw new TypeError(`${label} contains unsupported value(s): ${unknown.join(', ')}.`);
  }
  return result;
}

/** Return immutable records filtered with exact, closed option semantics. */
export function listRootCauseRecords(options = {}) {
  requireOptions(options, ['affectedSurfaces', 'status', 'tags'], 'Root-cause list');
  const status = requireStatus(options.status);
  const wantedTags = requireStringList(options.tags, 'Root-cause tags');
  const wantedSurfaces = requireStringList(options.affectedSurfaces, 'Root-cause affectedSurfaces', ROOT_CAUSE_SURFACES);
  const result = ROOT_CAUSE_RECORDS.filter((entry) => (
    (status == null || entry.status === status)
    && wantedTags.every((tag) => entry.tags.includes(tag))
    && wantedSurfaces.every((surface) => entry.affectedSurfaces.includes(surface))
  ));
  return Object.freeze([...result]);
}

/** Resolve one stable record id. Unknown ids return null. */
export function getRootCauseRecord(id) {
  if (typeof id !== 'string' || !id) throw new TypeError('Root-cause id must be a non-empty string.');
  return RECORDS_BY_ID.get(id) || null;
}

function recordSearchFields(entry) {
  return [
    ['id', [entry.id], 16],
    ['title', [entry.title], 12],
    ['tags', entry.tags, 10],
    ['affectedSurfaces', entry.affectedSurfaces, 8],
    ['symptom', [entry.symptom], 7],
    ['rootCause', [entry.rootCause], 7],
    ['evidence', entry.evidence, 4],
    ['detection', entry.detection.flatMap((item) => [item.method, item.signal, item.failureCondition]), 4],
    ['causalChain', entry.causalChain, 3],
    ['resolution', entry.resolution, 3],
    ['prevention', entry.prevention, 2],
    ['regressionTests', entry.regressionTests.flatMap((item) => [item.path, item.assertion]), 2],
    ['references', entry.references.flatMap((item) => [item.kind, item.locator, item.note]), 1],
  ];
}

const SEARCH_INDEX = ROOT_CAUSE_RECORDS.map((entry) => ({
  entry,
  fields: recordSearchFields(entry).map(([name, values, weight]) => ({
    name,
    normalized: normalizeText(values.join(' ')),
    tokenSet: new Set(values.flatMap(tokens)),
    weight,
  })),
}));

/** Deterministic lexical search over symptoms, causes, evidence and fixes. */
export function searchRootCauses(query, options = {}) {
  if (typeof query !== 'string') throw new TypeError('Root-cause query must be a string.');
  requireOptions(options, ['limit', 'status'], 'Root-cause search');
  const normalizedQuery = normalizeText(query);
  if (!normalizedQuery) return Object.freeze([]);
  const queryTokens = tokens(query);
  if (!queryTokens.length) return Object.freeze([]);
  const status = requireStatus(options.status);
  const limit = requireLimit(options.limit, 10);
  const results = [];
  for (const indexed of SEARCH_INDEX) {
    if (status != null && indexed.entry.status !== status) continue;
    let score = 0;
    const matchedFields = [];
    const matchedTokens = new Set();
    for (const field of indexed.fields) {
      let fieldScore = 0;
      for (const token of queryTokens) {
        if (field.tokenSet.has(token)) {
          fieldScore += field.weight;
          matchedTokens.add(token);
        }
      }
      if (field.normalized.includes(normalizedQuery)) fieldScore += field.weight * 2;
      if (fieldScore > 0) {
        score += fieldScore;
        matchedFields.push(field.name);
      }
    }
    if (score > 0) {
      results.push(deepFreeze({
        id: indexed.entry.id,
        score,
        matchedFields: sortedUnique(matchedFields),
        matchedTokens: sortedUnique([...matchedTokens]),
        record: indexed.entry,
      }));
    }
  }
  results.sort((left, right) => right.score - left.score || codepointCompare(left.id, right.id));
  return Object.freeze(results.slice(0, limit));
}

function addWeightedTokens(target, value, weight) {
  for (const token of tokens(Array.isArray(value) ? value.join(' ') : value)) {
    target.set(token, Math.max(target.get(token) || 0, weight));
  }
}

function recordFingerprint(entry) {
  const result = new Map();
  addWeightedTokens(result, entry.tags, 6);
  addWeightedTokens(result, entry.affectedSurfaces, 6);
  addWeightedTokens(result, [entry.title, entry.symptom, entry.rootCause], 4);
  addWeightedTokens(result, [
    ...entry.evidence,
    ...entry.causalChain,
    ...entry.detection.flatMap((item) => [item.method, item.signal, item.failureCondition]),
  ], 2);
  addWeightedTokens(result, [...entry.resolution, ...entry.prevention], 1);
  return result;
}

const SIMILARITY_INDEX = ROOT_CAUSE_RECORDS.map((entry) => ({
  entry,
  fingerprint: recordFingerprint(entry),
}));

function issueFingerprint(issue) {
  const result = new Map();
  if (typeof issue === 'string') {
    addWeightedTokens(result, issue, 4);
    return result;
  }
  if (!issue || typeof issue !== 'object' || Array.isArray(issue)) {
    throw new TypeError('Similar-issue input must be a string or one object.');
  }
  const allowed = ['affectedSurfaces', 'evidence', 'symptom', 'tags'];
  const unknown = Object.keys(issue).filter((key) => !allowed.includes(key)).sort(codepointCompare);
  if (unknown.length) throw new TypeError(`Similar-issue input does not accept field(s): ${unknown.join(', ')}.`);
  if (issue.symptom != null && typeof issue.symptom !== 'string') {
    throw new TypeError('Similar-issue symptom must be a string.');
  }
  const evidence = typeof issue.evidence === 'string'
    ? [issue.evidence]
    : requireStringList(issue.evidence, 'Similar-issue evidence');
  const tags = requireStringList(issue.tags, 'Similar-issue tags');
  const surfaces = requireStringList(issue.affectedSurfaces, 'Similar-issue affectedSurfaces', ROOT_CAUSE_SURFACES);
  addWeightedTokens(result, issue.symptom || '', 4);
  addWeightedTokens(result, evidence, 3);
  addWeightedTokens(result, tags, 6);
  addWeightedTokens(result, surfaces, 6);
  return result;
}

function weightedJaccard(left, right) {
  const union = new Set([...left.keys(), ...right.keys()]);
  let intersectionWeight = 0;
  let unionWeight = 0;
  const shared = [];
  for (const token of union) {
    const leftWeight = left.get(token) || 0;
    const rightWeight = right.get(token) || 0;
    intersectionWeight += Math.min(leftWeight, rightWeight);
    unionWeight += Math.max(leftWeight, rightWeight);
    if (leftWeight && rightWeight) shared.push(token);
  }
  return {
    score: unionWeight ? intersectionWeight / unionWeight : 0,
    sharedTokens: shared.sort(codepointCompare),
  };
}

/** Rank known causes against a newly observed issue using weighted Jaccard. */
export function findSimilarRootCauses(issue, options = {}) {
  requireOptions(options, ['limit', 'minScore', 'status'], 'Root-cause similarity');
  const query = issueFingerprint(issue);
  if (!query.size) return Object.freeze([]);
  const limit = requireLimit(options.limit, 5);
  const status = requireStatus(options.status);
  const minScore = options.minScore ?? 0.02;
  if (typeof minScore !== 'number' || !Number.isFinite(minScore) || minScore < 0 || minScore > 1) {
    throw new RangeError('Root-cause similarity minScore must be from 0 to 1.');
  }
  const results = [];
  for (const indexed of SIMILARITY_INDEX) {
    if (status != null && indexed.entry.status !== status) continue;
    const similarity = weightedJaccard(query, indexed.fingerprint);
    if (similarity.score < minScore) continue;
    results.push(deepFreeze({
      id: indexed.entry.id,
      score: Math.round(similarity.score * 1e6) / 1e6,
      sharedTokens: similarity.sharedTokens,
      record: indexed.entry,
    }));
  }
  results.sort((left, right) => right.score - left.score || codepointCompare(left.id, right.id));
  return Object.freeze(results.slice(0, limit));
}

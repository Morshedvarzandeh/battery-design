// Browser-safe JSON Schema for persistent battery-design root-cause records.
// This JavaScript representation is deliberate: the browser, desktop runner,
// CLI and MCP server can import the same closed schema without filesystem or
// JSON-module support.

export const ROOT_CAUSE_SCHEMA_VERSION = '1.0.0';
export const ROOT_CAUSE_RECORD_FORMAT = 'battery-design/root-cause-record@1';
export const ROOT_CAUSE_CATALOG_FORMAT = 'battery-design/root-cause-catalog@1';

export const ROOT_CAUSE_STATUSES = Object.freeze([
  'open',
  'mitigated',
  'resolved',
  'external-blocked',
]);

export const ROOT_CAUSE_SURFACES = Object.freeze([
  'browser',
  'ci',
  'cli',
  'compiled-fmu',
  'design-spec',
  'documentation',
  'fmi-source-kit',
  'local-api',
  'mcp',
  'packaging',
  'release',
]);

export const ROOT_CAUSE_REFERENCE_KINDS = Object.freeze([
  'implementation',
  'test',
  'workflow',
  'documentation',
  'standard',
  'incident',
  'commit',
  'pull-request',
]);

function deepFreeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

export const ROOT_CAUSE_RECORD_SCHEMA = deepFreeze({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://morshedvarzandeh.github.io/battery-design/knowledge/root-causes/schema.v1',
  title: 'battery-design root-cause record',
  type: 'object',
  additionalProperties: false,
  required: [
    'format',
    'id',
    'revision',
    'title',
    'status',
    'symptom',
    'evidence',
    'detection',
    'causalChain',
    'rootCause',
    'resolution',
    'prevention',
    'regressionTests',
    'affectedSurfaces',
    'tags',
    'references',
  ],
  properties: {
    format: { const: ROOT_CAUSE_RECORD_FORMAT },
    id: { type: 'string', pattern: '^rc-[a-z0-9]+(?:-[a-z0-9]+)*$', minLength: 6 },
    revision: { type: 'integer', minimum: 1 },
    title: { type: 'string', minLength: 8 },
    status: { type: 'string', enum: ROOT_CAUSE_STATUSES },
    symptom: { type: 'string', minLength: 12 },
    evidence: {
      type: 'array',
      minItems: 1,
      uniqueItems: true,
      items: { type: 'string', minLength: 8 },
    },
    detection: {
      type: 'array',
      minItems: 1,
      uniqueItems: true,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['method', 'signal', 'failureCondition'],
        properties: {
          method: { type: 'string', minLength: 3 },
          signal: { type: 'string', minLength: 8 },
          failureCondition: { type: 'string', minLength: 8 },
        },
      },
    },
    causalChain: {
      type: 'array',
      minItems: 2,
      uniqueItems: true,
      items: { type: 'string', minLength: 8 },
    },
    rootCause: { type: 'string', minLength: 12 },
    resolution: {
      type: 'array',
      minItems: 1,
      uniqueItems: true,
      items: { type: 'string', minLength: 8 },
    },
    prevention: {
      type: 'array',
      minItems: 1,
      uniqueItems: true,
      items: { type: 'string', minLength: 8 },
    },
    regressionTests: {
      type: 'array',
      minItems: 1,
      uniqueItems: true,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'assertion'],
        properties: {
          path: {
            type: 'string',
            pattern: '^(?:(?:tests|tools)/(?!\\.{1,2}(?:/|$))(?!.*\\/\\.{1,2}(?:/|$))[A-Za-z0-9._-]+(?:/[A-Za-z0-9._-]+)*|rust-core/tests/(?!\\.{1,2}(?:/|$))(?!.*\\/\\.{1,2}(?:/|$))[A-Za-z0-9._-]+(?:/[A-Za-z0-9._-]+)*\\.rs)$',
            minLength: 8,
          },
          assertion: { type: 'string', minLength: 8 },
        },
      },
    },
    affectedSurfaces: {
      type: 'array',
      minItems: 1,
      uniqueItems: true,
      items: { type: 'string', enum: ROOT_CAUSE_SURFACES },
    },
    tags: {
      type: 'array',
      minItems: 1,
      uniqueItems: true,
      items: { type: 'string', pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$' },
    },
    references: {
      type: 'array',
      minItems: 1,
      uniqueItems: true,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'locator', 'note'],
        properties: {
          kind: { type: 'string', enum: ROOT_CAUSE_REFERENCE_KINDS },
          locator: { type: 'string', minLength: 3 },
          note: { type: 'string', minLength: 8 },
        },
      },
    },
  },
});

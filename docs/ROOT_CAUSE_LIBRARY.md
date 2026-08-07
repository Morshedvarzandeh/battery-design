# Root-cause engineering memory

The root-cause library turns resolved battery-design defects into versioned,
searchable engineering knowledge. Each record preserves the observable
symptom, evidence, detection method, causal chain, root cause, implemented
resolution, prevention control, regression tests and local references.

The canonical sources are:

- `knowledge/root-causes/schema.v1.js` — closed record schema and vocabularies
- `knowledge/root-causes/records.v1.js` — immutable, deterministically ordered catalog
- `js/root-cause-library.js` — validation, exact lookup, lexical search and similar-issue matching

There is no second incident index. Browser, desktop and assistant projections
must call this library so fixes and prevention advice cannot drift by surface.

## Product surfaces

| Surface | Current exposure | Boundary |
|---|---|---|
| Browser | `js/root-cause-library.js` is directly importable | Library only; no dedicated browser panel is shipped |
| Desktop CLI | `root-cause --id` exact lookup and `root-cause --query` search | Local, deterministic catalog retrieval |
| JavaScript API | Named exports from `js/root-cause-library.js` | Library API, not a local HTTP endpoint |
| MCP | Read-only `diagnose_known_issue` assistant | Similarity is a ranked hint, never certainty or proof |
| Reports | Records expose implementation, test, workflow and documentation references | Standard design reports do not automatically diagnose failures |

Examples:

```js
import {
  getRootCauseRecord,
  searchRootCauses,
  findSimilarRootCauses,
} from './js/root-cause-library.js';

const known = getRootCauseRecord('rc-fmi-representation-drift');
const search = searchRootCauses('XML I/O map C binary mismatch');
const candidates = findSimilarRootCauses({
  symptom: 'The release archive differs from the artifact tested on Windows.',
  tags: ['artifact-identity', 'release'],
  affectedSurfaces: ['release'],
});
```

```bash
node desktop/bd.mjs root-cause --id rc-fmi-representation-drift
node desktop/bd.mjs root-cause --query "trusted source SHA" --limit 3 --json
```

The MCP assistant accepts a symptom and optional evidence, tags and affected
surfaces. It returns matching records with their evidence, cause, resolution,
prevention and regression tests. A human or a failing test must still confirm
that a retrieved cause applies to the new incident.

## Required defect workflow

Every pull request that resolves a defect must do one of the following:

1. Link an existing `rc-*` record and verify that its cause, resolution,
   prevention and regression information still describes the defect; or
2. add a new record, or update the existing record when the incident reveals
   a materially different cause, fix or prevention control.

“The test is green” is not a root-cause record. A resolved record must explain
why the failure was possible, what changed, what prevents recurrence and which
automated regression would fail if the defect returned. The pull request
template makes this decision explicit, including the legitimate case where no
defect was resolved.

When adding or updating a record:

1. Preserve concrete reproduction evidence without credentials or customer data.
2. Trace the causal chain beyond the final failing line.
3. Record the implemented resolution, not a proposed workaround.
4. Add a prevention control and at least one existing local regression test.
5. Keep ids, tags and affected surfaces in deterministic order.
6. Link local implementation/test/workflow references and verify they exist.

Run the focused gate:

```bash
npm run test:root-causes
node tools/validate.mjs
```

`tools/validate.mjs` checks the schema identity and closure, the complete
required-field contract, every catalog record, deterministic catalog rules,
and every local regression/reference path. CI runs the same repository gate.

## Trust boundary

Records are curated project memory, not runtime telemetry, a safety case or an
automated root-cause verdict. Search and similarity functions perform no
network access and execute no referenced file. A reference is a reviewer
locator; it becomes evidence only after the reviewer inspects the cited test,
workflow or implementation in the relevant revision.

# Root-cause knowledge library

This directory is persistent engineering memory for battery-design. It records
failures as reusable causal knowledge: observable symptom, evidence and
detection method, causal chain, root cause, resolution, prevention, regression
tests, affected surfaces and local references.

The current formats are:

- catalog: `battery-design/root-cause-catalog@1`, version `1.0.0`
- record: `battery-design/root-cause-record@1`
- closed schema: `schema.v1.js`
- immutable seed catalog: `records.v1.js`

The schema and records are JavaScript modules rather than JSON imports so the
same source loads in a browser and Node without a filesystem API, bundler or
network request. Their exported values are recursively frozen.

`js/root-cause-library.js` validates the catalog when imported and exposes
deterministic listing, exact-id lookup, lexical search and weighted similar-
issue matching. The module is the foundation for later CLI and MCP projections;
those projections must call this library rather than create another incident
index.

## Adding a record

1. Reproduce the symptom and preserve concrete evidence.
2. Write the causal chain through the underlying root cause, not only the last
   failing line.
3. Record the implemented resolution and a prevention control.
4. Name at least one regression test and local architecture reference.
5. Keep `affectedSurfaces` and `tags` unique and sorted, then insert the record
   in stable id order.
6. Run `node --test tests/root-cause-library.test.mjs`.

Records never execute their references or retrieve remote content. A reference
is a locator for a reviewer or assistant, not trusted evidence by itself.

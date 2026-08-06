# battery-design ontology

This directory is the architecture-wide semantic contract. It covers product,
host, electrical, charging, thermal/safety, geometry, model execution,
verification, vessel twin, lifecycle, capability and governance concepts.
Charging is one module; it does not own the ontology.

The ontology uses OWL/RDF meaning, SHACL release profiles and JSON-LD exchange.
The dependency-free JavaScript mirror in `js/ontology-schema.js` and
`js/ontology.js` performs deterministic calculation-ready validation in the
browser and desktop. Neo4j is an offline, validated projection produced from
that graph, never the ontology authority.

## Identity rules

- A model/specification and a serial physical asset never share an identity.
- Mutable names, chemistry, status and supplier text never form an IRI.
- Legacy catalog ids are aliases scoped by entity kind.
- A simulation result is not a physical observation.
- A study retrofit is not an as-built installation.
- Diagnostic severity, evidence maturity, feasibility, workflow and release
  decision remain separate controlled vocabularies.

## Evidence boundary

Portable graphs may contain governed evidence metadata, revisions, dates and
content hashes. They must not contain raw customer files, replay samples,
private asset identifiers, storage handles, local paths or personal data. A
hash proves content identity, not authenticity or approval.

Portable design identity is built from an allowlist of calculation inputs.
Route geometry is represented only by a digest; TwinShip evidence, replay
samples, physical-asset identifiers, personal actor identifiers and
caller-supplied semantic claims cannot enter or alter a design IRI. Each
finished module result has a separate SHA-256 digest over a portable result
projection, so a numerical-result change alters the graph snapshot without
copying raw evidence or traces into it.

## Profiles

`authoring` accepts incomplete claims; `calculation-ready` requires typed
quantities and model-run lineage; `release-ready`, `twin-ready`,
`passport-ready` and `hil-ready` add their domain evidence gates. Missing or
provisional evidence cannot become a green release decision.

External BattINFO/EMMO and Battery Passport mappings belong in separately
versioned mapping modules. They are not copied into this upper ontology and
must not use `owl:sameAs` without proven logical identity.

## Rules and calculations

Ontology rules are serializable data evaluated by `js/ontology-rules.js` with
an allowlisted grammar (`eq`, `in`, `gt`, `exists`, and related closed-world
operators). Rule records may activate review, require evidence or block a
release; they never execute embedded JavaScript, silently choose hardware or
replace the numerical model owned by a calculation module.

Every rule must identify its scope, implementation/evaluator, required facts,
units, evidence basis and missing-context outcome. A value such as an
isolation-resistance floor is therefore resolved only after the governing
standard edition, application, bus nature and topology are declared. Design
practice such as a temperature-sensor ratio remains an assumption-labelled
advisory rather than becoming a universal safety requirement.

The canonical registry includes the published UN R100 isolation criteria
(typed in `OhmPerV`), the assumed/report-only temperature sensor benchmark,
the marine shore-source evidence boundary and the EU battery passport gate.
Unknown categories, malformed assessment dates and missing topology facts
resolve to review, never to a silent pass.

## Marine host choices

A marine specification exposes both NTNU-based vessel catalog choices and
both complete low-detail engineering massing models. One
`InstallationStudy` targets exactly the selected vessel model; the other
remains a candidate. A study never asserts `installedIn`, and cell-source
evidence maturity remains separate from the selected study's TwinShip
maturity.

## JSON-LD relations

Every edge is emitted as a direct RDF predicate on its subject. A parallel
`bd:Relation` record carries edge metadata through the `bd:from`,
`bd:predicate` and `bd:to` IRI-valued properties declared in
`core.v1.ttl`; these are defined ontology terms rather than unmapped JSON
fields.

The full product architecture (browser, desktop, API, MCP, report, target
runtime and all engineering modules) is queried separately from each design
instance. This avoids copying the whole static catalog into every result while
preserving one shared ontology version and checksum.

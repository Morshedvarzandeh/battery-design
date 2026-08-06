#!/usr/bin/env node
// Generate the published RDF vocabulary from the dependency-free runtime
// schema. ontology-schema.js is authoritative; checked-in RDF/JSON-LD files
// exist for standards tooling and must compare byte-for-byte in validation.

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  CLASS_DEFINITIONS, COMPETENCY_QUESTIONS, JSON_LD_CONTEXT, ONTOLOGY,
  RELATION_DEFINITIONS,
} from '../js/ontology-schema.js';

const prefixes = `@prefix bd: <https://morshedvarzandeh.github.io/battery-design/ontology/core#> .
@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix prov: <http://www.w3.org/ns/prov#> .
@prefix qudt: <http://qudt.org/schema/qudt/> .
@prefix sosa: <http://www.w3.org/ns/sosa/> .
@prefix skos: <http://www.w3.org/2004/02/skos/core#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
`;

const literal = (value) => `"${String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n')}"`;
const parents = (value) => (Array.isArray(value) ? value : value ? [value] : []);

export function generatedCoreTurtle() {
  const lines = [prefixes.trimEnd(), '',
    `<${ONTOLOGY.id}>`,
    '  a owl:Ontology ;',
    `  owl:versionIRI <${ONTOLOGY.versionIri}> ;`,
    `  owl:versionInfo ${literal(ONTOLOGY.version)} ;`,
    '  rdfs:label "battery-design architecture ontology" ;',
    '  rdfs:comment "Architecture-wide semantics for battery products, host applications, calculations, simulations, evidence, verification and governance. Charging is one peer domain module." .',
    '', '# Classes — generated from CLASS_DEFINITIONS.',
  ];
  for (const [id, definition] of Object.entries(CLASS_DEFINITIONS).sort(([a], [b]) => a.localeCompare(b))) {
    const clauses = ['a owl:Class', `rdfs:label ${literal(definition.label)}`,
      `rdfs:comment ${literal(definition.description)}`];
    const superclasses = parents(definition.parent);
    if (superclasses.length) clauses.push(`rdfs:subClassOf ${superclasses.join(', ')}`);
    lines.push(`${id} ${clauses.join(' ; ')} .`);
  }
  lines.push('', '# Object properties — generated from RELATION_DEFINITIONS.');
  for (const [id, definition] of Object.entries(RELATION_DEFINITIONS).sort(([a], [b]) => a.localeCompare(b))) {
    const clauses = ['a owl:ObjectProperty', `rdfs:label ${literal(definition.label)}`,
      `rdfs:comment ${literal(definition.description)}`,
      `rdfs:domain ${definition.domain}`, `rdfs:range ${definition.range}`];
    if (definition.external) clauses.push(`rdfs:subPropertyOf ${definition.external}`);
    lines.push(`${id} ${clauses.join(' ; ')} .`);
  }
  lines.push('', '# Portable literal properties used by JSON-LD and SHACL.',
    'bd:basis a owl:DatatypeProperty ; rdfs:domain bd:Claim ; rdfs:range xsd:string .',
    'bd:quantityKind a owl:DatatypeProperty ; rdfs:domain bd:QuantityValue ; rdfs:range xsd:string .',
    'bd:revision a owl:DatatypeProperty ; rdfs:domain bd:EvidenceRecord ; rdfs:range xsd:string .',
    'bd:issuedAt a owl:DatatypeProperty ; rdfs:domain bd:EvidenceRecord ; rdfs:range xsd:dateTime .',
    'bd:result a owl:DatatypeProperty ; rdfs:range xsd:string .',
    'bd:designChecksum a owl:DatatypeProperty ; rdfs:range xsd:string .',
    'bd:contentDigest a owl:DatatypeProperty ; rdfs:range xsd:string .',
    'bd:kind a owl:DatatypeProperty ; rdfs:range xsd:string .',
    'bd:authorities a owl:DatatypeProperty ; rdfs:range xsd:string .',
    'bd:unitCode a owl:DatatypeProperty ; rdfs:domain bd:QuantityValue ; rdfs:range xsd:string .',
    'bd:targetIdentity a owl:DatatypeProperty ; rdfs:domain bd:HILRun ; rdfs:range xsd:string .',
    'bd:samplePeriodS a owl:DatatypeProperty ; rdfs:domain bd:HILRun ; rdfs:range xsd:double .',
    'bd:measuredTiming a owl:DatatypeProperty ; rdfs:domain bd:HILRun .',
    'bd:safeStateEvidence a owl:DatatypeProperty ; rdfs:domain bd:HILRun .',
    'bd:faultEvidence a owl:DatatypeProperty ; rdfs:domain bd:HILRun .',
    'bd:from a owl:ObjectProperty ; rdfs:domain bd:Relation ; rdfs:range bd:Entity .',
    'bd:to a owl:ObjectProperty ; rdfs:domain bd:Relation ; rdfs:range bd:Entity .',
    'bd:predicate a owl:ObjectProperty ; rdfs:domain bd:Relation .');
  return `${lines.join('\n')}\n`;
}

export function generatedContextJson() {
  return `${JSON.stringify({ '@context': JSON_LD_CONTEXT }, null, 2)}\n`;
}

export function generatedCompetencyQuestionsJson() {
  return `${JSON.stringify({
    ontologyVersion: ONTOLOGY.version,
    questions: COMPETENCY_QUESTIONS,
  }, null, 2)}\n`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv.includes('--write')) {
    writeFileSync(new URL('../ontology/core.v1.ttl', import.meta.url), generatedCoreTurtle());
    writeFileSync(new URL('../ontology/context.v1.jsonld', import.meta.url), generatedContextJson());
    writeFileSync(new URL('../ontology/competency-questions.v1.json', import.meta.url), generatedCompetencyQuestionsJson());
  } else {
    process.stdout.write(generatedCoreTurtle());
  }
}

// ontology-schema.js — the stable semantic vocabulary shared by every
// battery-design surface. This module defines meaning only; calculators keep
// owning physics and no browser/desktop code is allowed to invent relations.
//
// The compact `bd:*` terms expand through ontology/context.v1.jsonld. The
// repository URL is used as the resolvable namespace until a w3id redirect is
// registered; changing that base requires an explicit ontology migration.

export const ONTOLOGY = Object.freeze({
  id: 'https://morshedvarzandeh.github.io/battery-design/ontology/core',
  version: '1.0.0',
  versionIri: 'https://morshedvarzandeh.github.io/battery-design/ontology/core/1.0.0',
  graphFormat: 'battery-design/semantic-graph@1',
  shapesVersion: '1.0.0',
  profile: 'calculation-ready',
});

export const NAMESPACES = Object.freeze({
  bd: 'https://morshedvarzandeh.github.io/battery-design/ontology/core#',
  bdr: 'https://morshedvarzandeh.github.io/battery-design/resource/',
  prov: 'http://www.w3.org/ns/prov#',
  qudt: 'http://qudt.org/schema/qudt/',
  unit: 'http://qudt.org/vocab/unit/',
  sosa: 'http://www.w3.org/ns/sosa/',
  skos: 'http://www.w3.org/2004/02/skos/core#',
  time: 'http://www.w3.org/2006/time#',
  xsd: 'http://www.w3.org/2001/XMLSchema#',
});

// Runtime JSON-LD uses this exported context verbatim. The checked-in
// ontology/context.v1.jsonld is validated against it so RDF and JavaScript
// cannot acquire separate meanings.
export const JSON_LD_CONTEXT = Object.freeze({
  '@vocab': NAMESPACES.bd,
  bd: NAMESPACES.bd,
  bdr: NAMESPACES.bdr,
  prov: NAMESPACES.prov,
  qudt: NAMESPACES.qudt,
  unitVocabulary: NAMESPACES.unit,
  sosa: NAMESPACES.sosa,
  skos: NAMESPACES.skos,
  time: NAMESPACES.time,
  xsd: NAMESPACES.xsd,
  id: '@id',
  type: '@type',
  label: 'http://www.w3.org/2000/01/rdf-schema#label',
  from: Object.freeze({ '@id': 'bd:from', '@type': '@id' }),
  to: Object.freeze({ '@id': 'bd:to', '@type': '@id' }),
  predicate: Object.freeze({ '@id': 'bd:predicate', '@type': '@id' }),
  numericValue: Object.freeze({ '@id': 'qudt:numericValue', '@type': 'xsd:double' }),
  unit: Object.freeze({ '@id': 'qudt:unit', '@type': '@id' }),
  unitCode: 'bd:unitCode',
  quantityKind: 'bd:quantityKind',
  revision: 'bd:revision',
  issuedAt: Object.freeze({ '@id': 'bd:issuedAt', '@type': 'xsd:dateTime' }),
  result: 'bd:result',
  designChecksum: 'bd:designChecksum',
  contentDigest: 'bd:contentDigest',
  kind: 'bd:kind',
  authorities: 'bd:authorities',
  wasGeneratedBy: Object.freeze({ '@id': 'prov:wasGeneratedBy', '@type': '@id' }),
  wasDerivedFrom: Object.freeze({ '@id': 'prov:wasDerivedFrom', '@type': '@id' }),
  used: Object.freeze({ '@id': 'prov:used', '@type': '@id' }),
});

const cls = (label, module, description, parent = 'bd:Entity') =>
  Object.freeze({ label, module, description, parent });

// Deliberately separate specification/model/instance, result/observation and
// the several status vocabularies. Treating all of these as a generic object
// or a generic "status" caused the ambiguity this ontology is meant to stop.
export const CLASS_DEFINITIONS = Object.freeze({
  'bd:Entity': cls('Entity', 'core', 'Anything with a stable semantic identity.', null),
  'bd:PhysicalAsset': cls('Physical asset', 'core', 'An identified real-world asset.', ['bd:Entity', 'prov:Entity']),
  'bd:AssetModel': cls('Asset model', 'core', 'A model or catalog description, not a serial physical asset.', ['bd:Entity', 'prov:Entity']),
  'bd:Design': cls('Design', 'core', 'A versioned engineering proposal.', ['bd:Entity', 'prov:Entity']),
  'bd:DesignSpecification': cls('Design specification', 'core', 'Inputs and requirements defining a design.'),
  'bd:Relation': cls('Relation', 'core', 'A reified relationship used when edge metadata travels in JSON-LD.'),
  'bd:System': cls('System', 'product', 'A bounded engineered system.'),
  'bd:BatterySystem': cls('Battery system', 'product', 'Battery packs plus system equipment.', 'bd:System'),
  'bd:PackDesign': cls('Pack design', 'product', 'A battery pack design, distinct from an as-built pack.', 'bd:System'),
  'bd:ModuleDesign': cls('Module design', 'product', 'A module partition in a pack design.', 'bd:System'),
  'bd:CellSpecification': cls('Cell specification', 'product', 'A cell product or generic cell specification.', 'bd:AssetModel'),
  'bd:ChemistryFamily': cls('Chemistry family', 'product', 'A controlled battery-chemistry family.', 'bd:AssetModel'),
  'bd:Component': cls('Component', 'product', 'A selected or catalogued system component.', 'bd:AssetModel'),
  'bd:Material': cls('Material', 'product', 'A controlled material definition.', 'bd:AssetModel'),
  'bd:Application': cls('Application', 'host', 'A product/application profile.', 'bd:AssetModel'),
  'bd:ApplicationFamily': cls('Application family', 'host', 'A business/product grouping.', 'bd:AssetModel'),
  'bd:ApplicationClass': cls('Application class', 'host', 'A regulatory/technical classification.', 'bd:AssetModel'),
  'bd:Domain': cls('Domain', 'host', 'A physics and market domain.', 'bd:AssetModel'),
  'bd:HostAsset': cls('Host asset', 'host', 'The machine or site that hosts the battery.', 'bd:PhysicalAsset'),
  'bd:VesselModel': cls('Vessel model', 'host', 'A generic vessel model, not an identified vessel.', 'bd:AssetModel'),
  'bd:EngineeringMassingModel': cls('Engineering massing model', 'host', 'A versioned low-detail geometry representation, not production CAD.', 'bd:EngineeringModel'),
  'bd:InstallationStudy': cls('Installation study', 'host', 'A proposed installation that is not as-built.', 'bd:Design'),
  'bd:Mission': cls('Mission', 'host', 'A bounded operational duty.'),
  'bd:Voyage': cls('Voyage', 'host', 'A marine mission.', 'bd:Mission'),
  'bd:OperatingPolicy': cls('Operating policy', 'host', 'A governed EMS, PMS or duty-dispatch policy.', 'bd:EngineeringModel'),
  'bd:LoadProfile': cls('Load profile', 'host', 'A versioned or generated time-series duty description.', 'bd:EngineeringResult'),
  'bd:Capability': cls('Capability', 'capability', 'A user-visible engineering capability.', 'bd:AssetModel'),
  'bd:Concept': cls('Concept', 'capability', 'A customer or engineering concept.', 'bd:AssetModel'),
  'bd:SoftwareModule': cls('Software module', 'capability', 'An implementation module with a declared scope.', 'bd:AssetModel'),
  'bd:DomainModule': cls('Domain module', 'capability', 'A system-wide architectural module shared by product surfaces.', 'bd:SoftwareModule'),
  'bd:ProductSurface': cls('Product surface', 'capability', 'Browser, desktop, API, MCP or report surface.', 'bd:AssetModel'),
  'bd:EngineeringRule': cls('Engineering rule', 'capability', 'Declarative applicability, evidence and implementation metadata; equations remain in calculators.', 'bd:AssetModel'),
  'bd:Requirement': cls('Requirement', 'core', 'A mandatory need that can be satisfied or violated.'),
  'bd:Constraint': cls('Constraint', 'core', 'A closed-world limit evaluated against facts.'),
  'bd:Claim': cls('Claim', 'evidence', 'A published, supplier, measured, calculated, derived or assumed assertion.'),
  'bd:Assumption': cls('Assumption', 'evidence', 'An input not yet supported as measured or supplier fact.', 'bd:Claim'),
  'bd:EvidenceRecord': cls('Evidence record', 'evidence', 'Governed metadata for a document or dataset.', ['bd:Entity', 'prov:Entity']),
  'bd:Standard': cls('Standard', 'evidence', 'A versioned standard or regulation.', 'bd:EvidenceRecord'),
  'bd:TestEvidence': cls('Test evidence', 'evidence', 'A governed test result bound to an exact design or model.', 'bd:EvidenceRecord'),
  'bd:CalibrationTrial': cls('Calibration trial', 'evidence', 'A governed dataset used to fit an identified model.', ['bd:EvidenceRecord', 'prov:Activity']),
  'bd:ValidationTrial': cls('Validation trial', 'evidence', 'An independent governed dataset used to validate an identified model.', ['bd:EvidenceRecord', 'prov:Activity']),
  'bd:ReplayDataset': cls('Replay dataset', 'evidence', 'A governed representative operational replay.', 'bd:EvidenceRecord'),
  'bd:QuantityValue': cls('Quantity value', 'quantity', 'A numeric value with explicit quantity kind and unit.'),
  'bd:Unit': cls('Unit', 'quantity', 'A controlled unit with a UCUM-compatible code.', 'bd:AssetModel'),
  'bd:EngineeringModel': cls('Engineering model', 'model', 'A versioned equation, policy or simulation model.', 'bd:AssetModel'),
  'bd:EquationSet': cls('Equation set', 'model', 'A versioned collection of equations.', 'bd:EngineeringModel'),
  'bd:Solver': cls('Solver', 'model', 'A numerical solver implementation.', 'bd:AssetModel'),
  'bd:ModelRun': cls('Model run', 'model', 'An execution using stated inputs and a model.', ['bd:Entity', 'prov:Activity']),
  'bd:CalculationRun': cls('Calculation run', 'model', 'A deterministic engineering calculation.', 'bd:ModelRun'),
  'bd:SimulationRun': cls('Simulation run', 'model', 'A time-domain or scenario simulation.', 'bd:ModelRun'),
  'bd:SILRun': cls('SIL run', 'verification', 'Software-in-the-loop execution.', 'bd:SimulationRun'),
  'bd:HILRun': cls('HIL run', 'verification', 'Execution on identified hardware with measured timing.', 'bd:SimulationRun'),
  'bd:EngineeringResult': cls('Engineering result', 'model', 'A result generated by a model run.', ['bd:Entity', 'prov:Entity']),
  'bd:Observation': cls('Observation', 'twin', 'A physical observation, not a simulation result.', ['bd:Entity', 'sosa:Observation']),
  'bd:DigitalTwin': cls('Digital twin', 'twin', 'A validated model bound to an identified physical asset and current representative evidence.', 'bd:AssetModel'),
  'bd:Diagnostic': cls('Diagnostic', 'verification', 'A calculation finding with an explicit severity vocabulary.'),
  'bd:EvidenceMaturity': cls('Evidence maturity', 'verification', 'Evidence completeness/maturity, separate from feasibility.'),
  'bd:TwinMaturity': cls('Twin maturity', 'verification', 'Model-to-asset readiness, separate from cell or document evidence maturity.'),
  'bd:EngineeringFeasibility': cls('Engineering feasibility', 'verification', 'Pass/review/fail feasibility, separate from workflow.'),
  'bd:WorkflowState': cls('Workflow state', 'governance', 'Draft/validated/reviewed/approved/released state.'),
  'bd:ReleaseDecision': cls('Release decision', 'governance', 'A human release decision on an exact version.', ['bd:Entity', 'prov:Activity']),
  'bd:Agent': cls('Agent', 'governance', 'A human, organization, system or AI actor.', ['bd:Entity', 'prov:Agent']),
  'bd:GovernanceActivity': cls('Governance activity', 'governance', 'A workflow transition or review event, not an engineering calculation.', ['bd:Entity', 'prov:Activity']),
  'bd:Approval': cls('Approval', 'governance', 'A qualified human approval of an exact design version.', ['bd:Entity', 'prov:Activity']),
  'bd:ChargingSource': cls('Charging source', 'charging', 'External AC, DC, shore, dock or PCS supply.', 'bd:Component'),
  'bd:Charger': cls('Charger', 'charging', 'Power-conversion equipment controlling charge.', 'bd:Component'),
  'bd:ChargingInterface': cls('Charging interface', 'charging', 'Electrical/mechanical connection at the charging boundary.', 'bd:Component'),
  'bd:ChargingStrategy': cls('Charging strategy', 'charging', 'Operational charging policy.', 'bd:AssetModel'),
  'bd:ChargeSession': cls('Charge session', 'charging', 'A bounded charging execution.', 'bd:Mission'),
  'bd:ThermalPath': cls('Thermal path', 'thermal-safety', 'A conduction, convection or radiation path.', 'bd:AssetModel'),
  'bd:SafetyBarrier': cls('Safety barrier', 'thermal-safety', 'A thermal/safety barrier product or study selection.', 'bd:Component'),
  'bd:VentRequirement': cls('Vent requirement', 'thermal-safety', 'Calculated required unobstructed free area.', 'bd:Requirement'),
  'bd:VentProduct': cls('Vent product', 'thermal-safety', 'Supplier-qualified pressure-relief hardware.', 'bd:Component'),
  'bd:VentPlacement': cls('Vent placement', 'thermal-safety', 'A reviewed geometric placement and discharge direction.', 'bd:InstallationStudy'),
});

const rel = (label, domain, range, description, external = null) =>
  Object.freeze({ label, domain, range, description, external });

export const RELATION_DEFINITIONS = Object.freeze({
  'bd:hasPart': rel('has part', 'bd:System', 'bd:Entity', 'Structural containment inside an engineered system.'),
  'bd:partOf': rel('part of', 'bd:Entity', 'bd:System', 'Inverse structural containment.'),
  'bd:selects': rel('selects', 'bd:Design', 'bd:Entity', 'A design selects a catalog/model entity.'),
  'bd:hasSpecification': rel('has specification', 'bd:Design', 'bd:DesignSpecification', 'Links a proposal to its distinct input specification.'),
  'bd:specifiesSystem': rel('specifies system', 'bd:DesignSpecification', 'bd:System', 'A specification defines a proposed system.'),
  'bd:hasStudy': rel('has study', 'bd:Design', 'bd:InstallationStudy', 'A design contains a proposed installation study.'),
  'bd:studiesInstallationOf': rel('studies installation of', 'bd:InstallationStudy', 'bd:System', 'A study evaluates a proposed system installation without asserting an as-built relationship.'),
  'bd:hasCandidateHostModel': rel('has candidate host model', 'bd:DesignSpecification', 'bd:VesselModel', 'A specification exposes a governed host-model choice.'),
  'bd:installedIn': rel('installed in', 'bd:System', 'bd:HostAsset', 'An as-built system is installed in an identified physical host asset.'),
  'bd:targetsAssetModel': rel('targets asset model', 'bd:InstallationStudy', 'bd:AssetModel', 'The exact host catalog model targeted by an installation study.'),
  'bd:instanceOf': rel('instance of', 'bd:PhysicalAsset', 'bd:AssetModel', 'A serial physical asset instantiates a catalog/model identity.'),
  'bd:hasRepresentation': rel('has representation', 'bd:AssetModel', 'bd:EngineeringMassingModel', 'A model has a versioned visual or geometric representation.'),
  'bd:specifiedBy': rel('specified by', 'bd:Entity', 'bd:AssetModel', 'Instance/design specification relation.'),
  'bd:hasChemistry': rel('has chemistry', 'bd:Entity', 'bd:ChemistryFamily', 'Battery chemistry classification.'),
  'bd:memberOf': rel('member of', 'bd:Entity', 'bd:Entity', 'Membership in a controlled grouping.'),
  'bd:classifiedAs': rel('classified as', 'bd:Entity', 'bd:ApplicationClass', 'Technical/regulatory classification.'),
  'bd:belongsToDomain': rel('belongs to domain', 'bd:Entity', 'bd:Domain', 'Physics/market domain.'),
  'bd:requiresCapability': rel('requires capability', 'bd:Application', 'bd:Capability', 'Capability required by an application.'),
  'bd:implementsCapability': rel('implements capability', 'bd:SoftwareModule', 'bd:Capability', 'Implementation ownership.'),
  'bd:availableOn': rel('available on', 'bd:Capability', 'bd:ProductSurface', 'Product-surface availability.'),
  'bd:implementsRule': rel('implements rule', 'bd:SoftwareModule', 'bd:EngineeringRule', 'A module implements the executable side of a declarative rule.'),
  'bd:appliesRule': rel('applies rule', 'bd:Entity', 'bd:EngineeringRule', 'A declarative rule matched this entity using explicit facts.'),
  'bd:governedBy': rel('governed by', 'bd:EngineeringRule', 'bd:EvidenceRecord', 'Versioned evidence or standard governing a rule.'),
  'bd:dependsOn': rel('depends on', 'bd:Entity', 'bd:Entity', 'Explicit semantic dependency.'),
  'bd:hasRequirement': rel('has requirement', 'bd:Entity', 'bd:Requirement', 'Requirement applicable to an entity.'),
  'bd:satisfies': rel('satisfies', 'bd:Entity', 'bd:Requirement', 'Requirement satisfaction.'),
  'bd:violates': rel('violates', 'bd:Entity', 'bd:Requirement', 'Requirement violation.'),
  'bd:requiresEvidence': rel('requires evidence', 'bd:Entity', 'bd:Requirement', 'Evidence needed before a claim/release.'),
  'bd:supportedByEvidence': rel('supported by evidence', 'bd:Claim', 'bd:EvidenceRecord', 'Evidence support.', 'prov:wasDerivedFrom'),
  'bd:basedOnAssumption': rel('based on assumption', 'bd:Entity', 'bd:Assumption', 'Explicit assumption lineage.'),
  'bd:hasQuantity': rel('has quantity', 'bd:Entity', 'bd:QuantityValue', 'Explicit quantified property.'),
  'bd:hasUnit': rel('has unit', 'bd:QuantityValue', 'bd:Unit', 'Unit of a quantity.', 'qudt:unit'),
  'bd:usesModel': rel('uses model', 'bd:ModelRun', 'bd:EngineeringModel', 'Model execution lineage.', 'prov:used'),
  'bd:implementedBy': rel('implemented by', 'bd:EngineeringModel', 'bd:SoftwareModule', 'Separates engineering meaning from code implementation.'),
  'bd:usesInput': rel('uses input', 'bd:ModelRun', 'bd:Entity', 'Input lineage.', 'prov:used'),
  'bd:usesSolver': rel('uses solver', 'bd:ModelRun', 'bd:Solver', 'Numerical implementation lineage.'),
  'bd:produces': rel('produces', 'bd:ModelRun', 'bd:EngineeringResult', 'Run output.', 'prov:generated'),
  'bd:generatedBy': rel('generated by', 'bd:EngineeringResult', 'bd:ModelRun', 'Inverse run-output lineage.', 'prov:wasGeneratedBy'),
  'bd:derivedFrom': rel('derived from', 'bd:Entity', 'bd:Entity', 'Derivation lineage.', 'prov:wasDerivedFrom'),
  'bd:hasFinding': rel('has finding', 'bd:Design', 'bd:Diagnostic', 'Audit finding on a design.'),
  'bd:evaluates': rel('evaluates', 'bd:Diagnostic', 'bd:Entity', 'Entity or claim evaluated by a diagnostic.'),
  'bd:referencesRule': rel('references rule', 'bd:Diagnostic', 'bd:Standard', 'Standard/rule cited by a finding.'),
  'bd:hasEvidenceMaturity': rel('has evidence maturity', 'bd:Entity', 'bd:EvidenceMaturity', 'Evidence status only.'),
  'bd:hasTwinMaturity': rel('has twin maturity', 'bd:InstallationStudy', 'bd:TwinMaturity', 'Vessel-twin readiness only.'),
  'bd:hasFeasibility': rel('has feasibility', 'bd:Entity', 'bd:EngineeringFeasibility', 'Engineering feasibility only.'),
  'bd:hasWorkflowState': rel('has workflow state', 'bd:Design', 'bd:WorkflowState', 'Governance state only.'),
  'bd:hasReleaseDecision': rel('has release decision', 'bd:Design', 'bd:ReleaseDecision', 'Release decision only.'),
  'bd:performedBy': rel('performed by', 'prov:Activity', 'bd:Agent', 'Responsible actor.', 'prov:wasAssociatedWith'),
  'bd:approves': rel('approves', 'bd:Approval', 'bd:Design', 'Approval of an exact design version.'),
  'bd:authorizes': rel('authorizes', 'bd:Approval', 'bd:ReleaseDecision', 'A qualified human approval authorizes one release decision.'),
  'bd:releases': rel('releases', 'bd:ReleaseDecision', 'bd:Design', 'A release decision applies to one exact design version.'),
  'bd:verifies': rel('verifies', 'bd:TestEvidence', 'bd:Design', 'Passing governed test evidence verifies an exact design version.'),
  'bd:boundToAsset': rel('bound to asset', 'bd:Entity', 'bd:PhysicalAsset', 'Serial-asset binding.'),
  'bd:modelOf': rel('model of', 'bd:EngineeringModel', 'bd:AssetModel', 'A versioned engineering model represents an asset model.'),
  'bd:observesAsset': rel('observes asset', 'bd:EvidenceRecord', 'bd:PhysicalAsset', 'Evidence was collected from one identified physical asset.'),
  'bd:calibrates': rel('calibrates', 'bd:CalibrationTrial', 'bd:EngineeringModel', 'A governed trial calibrates an identified model version.'),
  'bd:validates': rel('validates', 'bd:ValidationTrial', 'bd:EngineeringModel', 'An independent governed trial validates an identified model version.'),
  'bd:evaluatesModel': rel('evaluates model', 'bd:EvidenceRecord', 'bd:EngineeringModel', 'Evidence or replay evaluates an identified model.'),
  'bd:representsAsset': rel('represents asset', 'bd:DigitalTwin', 'bd:PhysicalAsset', 'A digital twin represents exactly one physical asset.'),
  'bd:supportedBy': rel('supported by', 'bd:Entity', 'bd:EvidenceRecord', 'Evidence support for an entity without weakening claim-specific provenance.'),
  'bd:forAssetModel': rel('for asset model', 'bd:Mission', 'bd:AssetModel', 'A mission is scoped to one host model.'),
  'bd:usesPolicy': rel('uses policy', 'bd:Mission', 'bd:OperatingPolicy', 'A mission uses one governed operating policy.'),
  'bd:connectsTo': rel('connects to', 'bd:Entity', 'bd:Entity', 'Typed interface connection.'),
  'bd:generatesProfile': rel('generates profile', 'bd:OperatingPolicy', 'bd:LoadProfile', 'Policy-to-profile relation.'),
  'bd:observes': rel('observes', 'bd:Observation', 'bd:Entity', 'Feature/property observed.', 'sosa:hasFeatureOfInterest'),
  'bd:hasAlias': rel('has legacy alias', 'bd:Entity', 'bd:Entity', 'Legacy catalog identifier mapping.'),
});

export const UNIT_DEFINITIONS = Object.freeze({
  Wh: { label: 'watt hour', symbol: 'Wh', ucum: 'W.h', quantityKind: 'energy' },
  kWh: { label: 'kilowatt hour', symbol: 'kWh', ucum: 'kW.h', quantityKind: 'energy' },
  J: { label: 'joule', symbol: 'J', ucum: 'J', quantityKind: 'energy' },
  V: { label: 'volt', symbol: 'V', ucum: 'V', quantityKind: 'voltage' },
  mV: { label: 'millivolt', symbol: 'mV', ucum: 'mV', quantityKind: 'voltage' },
  A: { label: 'ampere', symbol: 'A', ucum: 'A', quantityKind: 'current' },
  Ah: { label: 'ampere hour', symbol: 'Ah', ucum: 'A.h', quantityKind: 'electric-charge' },
  W: { label: 'watt', symbol: 'W', ucum: 'W', quantityKind: 'power' },
  kW: { label: 'kilowatt', symbol: 'kW', ucum: 'kW', quantityKind: 'power' },
  kg: { label: 'kilogram', symbol: 'kg', ucum: 'kg', quantityKind: 'mass' },
  g: { label: 'gram', symbol: 'g', ucum: 'g', quantityKind: 'mass' },
  mm: { label: 'millimetre', symbol: 'mm', ucum: 'mm', quantityKind: 'length' },
  m: { label: 'metre', symbol: 'm', ucum: 'm', quantityKind: 'length' },
  L: { label: 'litre', symbol: 'L', ucum: 'L', quantityKind: 'volume' },
  Ohm: { label: 'ohm', symbol: 'Ω', ucum: 'Ohm', quantityKind: 'resistance' },
  mOhm: { label: 'milliohm', symbol: 'mΩ', ucum: 'mOhm', quantityKind: 'resistance' },
  uOhm: { label: 'microohm', symbol: 'µΩ', ucum: 'uOhm', quantityKind: 'resistance' },
  OhmPerV: { label: 'ohm per volt', symbol: 'Ω/V', ucum: 'Ohm/V', quantityKind: 'resistance-per-voltage' },
  s: { label: 'second', symbol: 's', ucum: 's', quantityKind: 'time' },
  h: { label: 'hour', symbol: 'h', ucum: 'h', quantityKind: 'time' },
  Cel: { label: 'degree Celsius', symbol: '°C', ucum: 'Cel', quantityKind: 'thermodynamic-temperature' },
  K: { label: 'kelvin difference', symbol: 'K', ucum: 'K', quantityKind: 'temperature-difference' },
  pct: { label: 'percent', symbol: '%', ucum: '%', quantityKind: 'dimensionless' },
  one: { label: 'one', symbol: '1', ucum: '1', quantityKind: 'dimensionless' },
  kn: { label: 'knot', symbol: 'kn', ucum: '[kn_i]', quantityKind: 'speed' },
  nmi: { label: 'nautical mile', symbol: 'nmi', ucum: '[nmi_i]', quantityKind: 'length' },
});

export const PRODUCT_SURFACES = Object.freeze({
  browser: Object.freeze({ label: 'Browser', execution: 'interactive-browser' }),
  desktop: Object.freeze({ label: 'Desktop', execution: 'local-native' }),
  api: Object.freeze({ label: 'Headless API', execution: 'shared-js-runtime' }),
  mcp: Object.freeze({ label: 'MCP', execution: 'shared-js-runtime' }),
  report: Object.freeze({ label: 'Report', execution: 'read-only-evidence' }),
  'desktop-target': Object.freeze({ label: 'Deterministic HIL target', execution: 'real-time-target' }),
});

// Architecture modules are always present even when a particular design has
// no run for them. This is the system map. MODULE_DEFINITIONS below remains the
// registry of concrete calculation-result families returned by designFromSpec.
const surfaces = (browser = 'full', desktop = 'full', api = 'full', mcp = 'full', report = 'summary') =>
  Object.freeze({ browser, desktop, api, mcp, report });
const architectureModule = (label, domain, implementation, capabilities, availability = surfaces()) =>
  Object.freeze({ label, domain, implementation, capabilities: Object.freeze(capabilities), surfaces: availability });

export const ARCHITECTURE_MODULE_DEFINITIONS = Object.freeze({
  requirements: architectureModule('Requirements and application scope', 'requirements', ['js/knowledge.js', 'js/presets.js'], ['duty-economics', 'load-profile', 'energy-policy', 'driving-mode', 'payload', 'host-machine']),
  standards: architectureModule('Standards and compliance audit', 'compliance', ['js/standards.js', 'js/markets.js', 'js/eurules.js'], ['release-rules']),
  geometry: architectureModule('Pack and host geometry', 'geometry', ['js/pack-engine.js', 'js/scene3d.js', 'js/vessels.js', 'assets3d/catalog.js'], ['space-fill', 'integration-allowance', 'spaces-why', 'module-tier', 'stacks-racks', 'showroom']),
  electrical: architectureModule('Electrical architecture and protection', 'electrical', ['js/architecture.js', 'js/electrical-protection.js'], ['hv-chain', 'bms-topology', 'ems-arch', 'round-trip-efficiency']),
  wiring: architectureModule('Conductors, joints and wiring', 'electrical', ['js/topology.js', 'js/wiring.js'], ['conductors', 'corrosion']),
  grounding: architectureModule('Grounding and bonding', 'electrical-safety', ['js/grounding.js'], ['bonding']),
  thermal: architectureModule('Thermal system', 'thermal', ['js/btms.js', 'js/seasons.js'], ['btms-loop', 'seasons', 'thermal-field']),
  sensors: architectureModule('Sensor plan and observability', 'control', ['js/sensors.js'], ['sensors-plan']),
  faultSafety: architectureModule('Short-circuit and structural safety', 'safety', ['js/shortcircuit.js', 'js/diagnostics.js'], ['fault-study', 'crush', 'vibration']),
  propagation: architectureModule('Thermal-runaway propagation', 'thermal-safety', ['js/runaway.js'], ['propagation']),
  venting: architectureModule('Emergency vent sizing and placement', 'thermal-safety', ['js/venting.js', 'js/vent-layout.js'], ['propagation']),
  charging: architectureModule('Charging and bidirectional power', 'charging', ['js/charging.js', 'js/v2x.js'], ['ac-side', 'charging-strategy', 'v2x']),
  mission: architectureModule('Host mission and operating policy', 'mission', ['js/vehicle.js', 'js/marine.js', 'js/flight.js', 'js/operating-policy.js'], ['vehicle-dynamics', 'route-road', 'terrain', 'hull-resistance', 'vessel-twin', 'flight-weather', 'legged-gait']),
  simulation: architectureModule('Battery simulation and governed calibration', 'simulation', [
    'js/sim1d.js',
    'js/sim2.js',
    'js/calibration-dataset.js',
    'js/calibration-import.js',
    'desktop/bd.mjs',
    'rust-core/',
  ], ['simulation']),
  cosimulation: architectureModule('Co-simulation graph and transport', 'simulation', ['js/cosim-graph.js', 'js/cosim-studio.js'], ['cosim']),
  fmi: architectureModule('FMI model exchange', 'simulation', ['js/fmi.js'], ['cosim']),
  sil: architectureModule('Software-in-the-loop verification', 'verification', ['js/loop-testing.js'], ['cosim'], surfaces('run-review', 'configure-run', 'run', 'run', 'evidence')),
  hil: architectureModule('Hardware-in-the-loop verification', 'verification', ['js/loop-testing.js', 'desktop-app/'], ['cosim'], Object.freeze({
    ...surfaces('status', 'configure', 'contract', 'contract', 'evidence'),
    'desktop-target': 'real-time-execution',
  })),
  lifecycle: architectureModule('Lifecycle, service and circular value', 'lifecycle', ['js/lca.js', 'js/optimizer.js', 'js/swap.js'], ['footprint', 'circular-value', 'swappable']),
  workspace: architectureModule('Interactive design workspace', 'product', ['js/garage.js', 'js/garage-ui.js', 'garage3d/'], ['part-swap', 'showroom', 'multi-objective']),
  reporting: architectureModule('Traceable reporting', 'reporting', ['js/report.js', 'js/visual-report.js', 'js/brief.js'], ['report', 'duty-economics', 'multi-objective']),
  qualityMemory: architectureModule('Root-cause quality memory', 'quality-governance', [
    'js/root-cause-library.js',
    'knowledge/root-causes/schema.v1.js',
    'knowledge/root-causes/records.v1.js',
  ], ['root-cause-memory'], surfaces('importable-library', 'cli', 'library', 'assistant', 'references')),
  governance: architectureModule('Approval and release governance', 'governance', ['js/governance.js'], ['release-rules']),
});

// Declarative rule grammar. Rule definitions contain no callbacks, code
// strings or implicit defaults; all operators and effects are allowlisted.
// Calculators continue to own equations and hardware selections.
export const RULE_OPERATORS = Object.freeze([
  'eq', 'neq', 'in', 'notIn', 'gt', 'gte', 'lt', 'lte', 'onOrAfter',
  'exists', 'truthy', 'falsy',
]);

export const RULE_EFFECTS = Object.freeze([
  'inform', 'activate-review', 'require-evidence', 'block',
]);

export const RULE_DEFINITIONS = Object.freeze({
  'un-r100-isolation': Object.freeze({
    id: 'bd:rule/un-r100-isolation', type: 'bd:Constraint',
    label: 'UN R100 high-voltage isolation', module: 'standards',
    implementation: 'js/isolation-rule.js#resolveIsolationRule',
    authority: 'normative', basis: 'published', evaluator: 'ontology-rule-runtime@1',
    match: 'all',
    when: Object.freeze([
      Object.freeze({ fact: 'application.class', operator: 'eq', value: 'vehicle' }),
      Object.freeze({ fact: 'pack.maximumVoltage', operator: 'gt', value: 60, unit: 'V' }),
      Object.freeze({ fact: 'pack.maximumVoltage', operator: 'lte', value: 1500, unit: 'V' }),
    ]),
    requiredFacts: Object.freeze([
      Object.freeze({
        fact: 'architecture.isolationContext',
        oneOf: Object.freeze([
          'un-r100-separate-dc',
          'un-r100-separate-ac',
          'un-r100-connected-ac-dc',
          'un-r100-connected-ac-dc-protected',
        ]),
      }),
      Object.freeze({ fact: 'architecture.electricalReference', oneOf: Object.freeze(['electrical-chassis']) }),
    ]),
    criteria: Object.freeze([
      Object.freeze({ when: Object.freeze({ fact: 'architecture.isolationContext', operator: 'eq', value: 'un-r100-separate-dc' }), kind: 'minimum-resistance-per-working-voltage', coefficient: Object.freeze({ numericValue: 100, unit: 'OhmPerV' }) }),
      Object.freeze({ when: Object.freeze({ fact: 'architecture.isolationContext', operator: 'eq', value: 'un-r100-separate-ac' }), kind: 'minimum-resistance-per-working-voltage', coefficient: Object.freeze({ numericValue: 500, unit: 'OhmPerV' }) }),
      Object.freeze({ when: Object.freeze({ fact: 'architecture.isolationContext', operator: 'eq', value: 'un-r100-connected-ac-dc' }), kind: 'minimum-resistance-per-working-voltage', coefficient: Object.freeze({ numericValue: 500, unit: 'OhmPerV' }) }),
      Object.freeze({
        when: Object.freeze({
          match: 'all',
          conditions: Object.freeze([
            Object.freeze({ fact: 'architecture.isolationContext', operator: 'eq', value: 'un-r100-connected-ac-dc-protected' }),
            Object.freeze({ fact: 'architecture.acProtection', operator: 'in', value: Object.freeze(['double-or-more-solid-insulation', 'mechanically-robust-protection']) }),
          ]),
        }),
        kind: 'minimum-resistance-per-working-voltage',
        coefficient: Object.freeze({ numericValue: 100, unit: 'OhmPerV' }),
      }),
    ]),
    missingFactOutcome: 'review', unmatchedCriteriaOutcome: 'review', owner: 'architecture',
    consumers: Object.freeze(['standards', 'engineering', 'sensors']),
    evidence: Object.freeze([Object.freeze({
      id: 'standard:un-r100-r3', revision: 'Revision 3',
      source: 'https://unece.org/sites/default/files/2024-01/R0100r3e.pdf',
    })]),
  }),
  'temperature-sensor-benchmark': Object.freeze({
    id: 'bd:rule/temperature-sensor-benchmark', type: 'bd:EngineeringRule',
    label: 'Temperature sensor observability benchmark', module: 'sensors',
    implementation: 'js/architecture.js#bmsArchitecture',
    authority: 'design-practice', basis: 'assumed', evaluator: 'ontology-rule-runtime@1',
    match: 'all',
    when: Object.freeze([Object.freeze({ fact: 'pack.seriesCount', operator: 'gt', value: 0, unit: 'one' })]),
    advisory: Object.freeze({ kind: 'cells-per-temperature-sensor', numericValue: 3, unit: 'one' }),
    effect: Object.freeze({ type: 'inform', target: 'sensors.temperatureCount', message: 'Report the 1:3 observability benchmark as an assumed advisory; never use it as a release blocker.' }),
    missingFactOutcome: 'not-applicable', owner: 'sensors', normative: false,
    evidence: Object.freeze([Object.freeze({ id: 'assumption:temperature-observability', source: 'REFERENCES.md#engineering-assumptions' })]),
  }),
  'marine-shore-source-evidence': Object.freeze({
    id: 'bd:rule/marine-shore-source-evidence', type: 'bd:EngineeringRule',
    label: 'Marine shore source evidence', module: 'charging',
    implementation: 'js/charging.js',
    authority: 'engineering-boundary', basis: 'derived', evaluator: 'ontology-rule-runtime@1',
    match: 'all',
    when: Object.freeze([
      Object.freeze({ fact: 'application.id', operator: 'eq', value: 'marine' }),
      Object.freeze({ fact: 'charging.resultPresent', operator: 'truthy' }),
      Object.freeze({ fact: 'charging.sourceResolved', operator: 'falsy' }),
    ]),
    effect: Object.freeze({
      type: 'require-evidence', target: 'charging.shoreSource',
      message: 'Declare marine shore equipment, interface and supplier evidence before reporting charge time.',
    }),
    requiredFacts: Object.freeze([
      Object.freeze({ fact: 'application.id' }), Object.freeze({ fact: 'charging.resultPresent' }),
      Object.freeze({ fact: 'charging.sourceResolved' }),
    ]),
    missingFactOutcome: 'review', owner: 'charging',
  }),
  'eu-battery-passport': Object.freeze({
    id: 'bd:rule/eu-battery-passport', type: 'bd:Constraint',
    label: 'EU battery passport applicability', module: 'standards',
    implementation: 'js/eurules.js', authority: 'normative', basis: 'published',
    evaluator: 'ontology-rule-runtime@1', match: 'all',
    when: Object.freeze([
      Object.freeze({ fact: 'evaluation.date', operator: 'onOrAfter', value: '2027-02-18' }),
    ]),
    requiredFacts: Object.freeze([Object.freeze({
      fact: 'battery.category',
      oneOf: Object.freeze(['ev', 'lmt', 'industrial', 'portable', 'sli']),
    })]),
    criteria: Object.freeze([
      Object.freeze({
        when: Object.freeze({ fact: 'battery.category', operator: 'in', value: Object.freeze(['lmt', 'ev']) }),
        kind: 'battery-passport-obligation',
        requirements: Object.freeze(['accessible-current-passport-data', 'accessible-current-state-of-health-data']),
      }),
      Object.freeze({
        when: Object.freeze({ match: 'all', conditions: Object.freeze([
          Object.freeze({ fact: 'battery.category', operator: 'eq', value: 'industrial' }),
          Object.freeze({ fact: 'battery.energyWh', operator: 'gt', value: 2000, unit: 'Wh' }),
        ]) }),
        kind: 'battery-passport-obligation',
        requirements: Object.freeze(['accessible-current-passport-data', 'accessible-current-state-of-health-data']),
      }),
    ]),
    missingFactOutcome: 'review', unmatchedCriteriaOutcome: 'not-applicable',
    owner: 'standards', consumers: Object.freeze(['eurules']),
    implementationOptions: Object.freeze(['uds', 'documented-service-interface', 'documented-network-api']),
    evidence: Object.freeze([Object.freeze({
      id: 'regulation:eu-2023-1542', revision: '2023/1542',
      source: 'https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32023R1542',
    })]),
  }),
});

// Compatibility alias. RULE_DEFINITIONS is the canonical data contract.
export const ENGINEERING_RULE_DEFINITIONS = RULE_DEFINITIONS;

export const MATURITY_SCHEMES = Object.freeze({
  twinShip: Object.freeze({
    id: 'twinShip', label: 'Vessel twin maturity', cumulative: true,
    levels: Object.freeze([
      Object.freeze({ id: 'screening', label: 'Screening model', requires: Object.freeze([]) }),
      Object.freeze({ id: 'vessel-model', label: 'Vessel model', requires: Object.freeze(['identified-vessel', 'power-basis']) }),
      Object.freeze({ id: 'calibrated', label: 'Calibrated model', requires: Object.freeze(['asset-binding', 'model-version', 'calibration-trial']) }),
      Object.freeze({ id: 'validated', label: 'Validated model', requires: Object.freeze(['validation-trial', 'validation-result']) }),
      Object.freeze({ id: 'digital-twin', label: 'Digital twin', requires: Object.freeze([
        'current-data', 'replay-representative', 'replay-coherent',
        'replay-content-address', 'replay-mode-coverage',
      ]) }),
    ]),
  }),
});

// Canonical capability vocabulary and applicability edges. knowledge.js is a
// query surface over this data; it must not maintain a second concept graph.
const concept = (label, why) => Object.freeze({ label, why });
const applies = (classes, apps = []) => Object.freeze({
  classes: Object.freeze(classes), apps: Object.freeze(apps),
});

export const CONCEPT_DEFINITIONS = Object.freeze({
  'duty-economics': concept('Duty cycle & lifetime cost', 'Cycles/year, DoD and cycle life set the real cost of every design.'),
  'load-profile': concept('Load profiles', 'The shape of the demand sizes the pack, not the average.'),
  'energy-policy': concept('Operating goal', 'EMS or PMS policy decides which part of external demand the battery must carry.'),
  'driving-mode': concept('Driving mode', 'Eco, Normal and Sport change the battery demand without changing the route.'),
  payload: concept('Passenger, cargo or mission payload', 'What the machine carries changes road, marine and flight energy before the battery is sized.'),
  'round-trip-efficiency': concept('Round-trip efficiency', 'Charge, battery, discharge and auxiliary losses decide how much energy must be bought for every unit delivered.'),
  'space-fill': concept('Space-first max fill', 'The bay is fixed; the design is extracted from it.'),
  'multi-objective': concept('Multi-objective weights & Pareto', 'Energy vs cost vs mass is a trade, not a formula.'),
  'integration-allowance': concept('Integration allowance', 'Real packs lose plan area to structure — calibrated against production packs.'),
  'spaces-why': concept('Why the spaces exist', 'Swelling, crash tests and vent paths are the reason for every millimetre.'),
  seasons: concept('Climate & seasons', 'The system temperature swings with the seasons; winter changes charging.'),
  'module-tier': concept('Module partition', 'Bigger packs split into modules; the electronics follow the mechanics.'),
  'stacks-racks': concept('Stacks & racks (multi-pack systems)', 'MWh-scale systems are many packs in parallel — the tool models one.'),
  'hv-chain': concept('HV chain (precharge, contactors, isolation)', 'Above 60 V DC the switching and isolation hardware becomes mandatory.'),
  'bms-topology': concept('BMS topology', 'Centralized vs daisy chain vs wireless — each carries costs.'),
  'ems-arch': concept('EMS architecture', 'Plants with an energy management system choose centralized / hierarchical / distributed.'),
  'btms-loop': concept('Thermal loop & BTMS', 'Pumped loops, chillers and the thermal control unit — where heat is a system.'),
  'sensors-plan': concept('Sensor plan', 'What the harness must carry, by level.'),
  'release-rules': concept('Release rules & market checklist', 'What certification will demand in each target market.'),
  report: concept('Report & sensitivity', 'The customer document, stress-tested.'),
  'root-cause-memory': concept('Root-cause engineering memory', 'Resolved defects become searchable cause, resolution, prevention and regression knowledge instead of being rediscovered.'),
  simulation: concept('Mission simulation', 'The design run through time — SoC, sag and temperature over the real profile.'),
  'ac-side': concept('AC side & charging', 'How the pack meets the grid — on-board charger, connectors, charge time.'),
  'charging-strategy': concept('Charging strategy', 'Depot vs opportunity vs tariff windows — a pack-sizing decision, not an afterthought.'),
  v2x: concept('Feeding power back (V2X)', 'V2L, V2H, V2G — and the wear floor that decides whether selling energy back ever pays.'),
  'vehicle-dynamics': concept('The vehicle & driving mode', 'Mass, drag and the driver decide the demand — and the pack carries its own weight.'),
  conductors: concept('Conductor sizing & the connection graph', 'Every run has a material, a length and a section — and a temperature that decides whether it survives the current it carries.'),
  bonding: concept('Grounding & bonding', 'Isolation keeps fault current off the case; bonding decides what happens once it fails.'),
  corrosion: concept('Galvanic corrosion at joints', 'Two metals that must not touch, and the one that dissolves when they do.'),
  'fault-study': concept('Short circuit & fault currents', 'The first milliseconds: whether the fuse clears before the busbar fails.'),
  propagation: concept('Runaway propagation', 'One cell goes — what the spacing, the barrier and the state of charge do about the next one.'),
  footprint: concept('Life-cycle footprint', 'What it costs to build, run and recycle, and which of those you can actually change.'),
  swappable: concept('Swappable-pack policy', 'Fixed, swappable or hot-swappable — a decision that changes the mass, the connector and how many packs you buy.'),
  cosim: concept('Co-simulation & model export', 'The pack as a component inside the toolchain you already run.'),
  'part-swap': concept('Fitting a different part', 'What one change actually buys and costs, priced before you commit to it rather than after.'),
  showroom: concept('The pack in three dimensions', 'Standing in front of the thing rather than reading a table about it — the same geometry, at the size it really is.'),
  'circular-value': concept('Value by life stage and place', 'A pack does not have a price — it has a price here, at this point in its life, to someone. The three move independently.'),
  'host-machine': concept('The machine it goes into', 'Does it fit, and where does it go — the first question anyone asks, and the one a table of millimetres has never answered.'),
  'route-road': concept('Route simulation (road)', 'A real journey rather than a synthetic cycle: the hill outside town, and what it costs.'),
  terrain: concept('Terrain & off-road surfaces', 'Sand is fifteen times the rolling resistance of tarmac, and at low speed that IS the consumption.'),
  'hull-resistance': concept('Hull resistance & sea state', 'A boat is not a slow car: resistance rises with the cube of speed, and current and waves decide the crossing.'),
  'vessel-twin': concept('Vessel twin readiness & voyage replay', 'A model becomes a vessel twin only when it is bound to an identified asset, calibrated, independently validated and checked against governed replay or live data.'),
  'flight-weather': concept('Flight physics & weather', 'Lift has to be paid for continuously, and wind, air density and temperature change what a flight costs.'),
  'legged-gait': concept('Legged locomotion & gait', 'Legs pay for every step and for standing still — a duty cycle that looks nothing like rolling.'),
  crush: concept('Crush & intrusion', 'The crash tests prescribe an outcome, not a dimension. This is what the structure does when something presses on it.'),
  vibration: concept('Vibration & shock', 'Mount loads and the first natural frequency against what the road, the sea or the airframe actually shakes it with.'),
  'thermal-field': concept('Thermal field across the pack', 'Not the loop that removes the heat, but where the heat IS — the gradient that ages one module faster than the rest.'),
});

const ALL_APPLICATION_CLASSES = Object.freeze(['vehicle', 'lmt', 'stationary', 'marine', 'industrial', 'portable', 'auxiliary']);
export const CONCEPT_APPLICABILITY = Object.freeze({
  conductors: applies(ALL_APPLICATION_CLASSES),
  corrosion: applies(ALL_APPLICATION_CLASSES),
  'fault-study': applies(ALL_APPLICATION_CLASSES),
  propagation: applies(ALL_APPLICATION_CLASSES),
  footprint: applies(ALL_APPLICATION_CLASSES),
  bonding: applies(['vehicle', 'stationary', 'industrial', 'auxiliary', 'marine']),
  swappable: applies(['lmt', 'industrial', 'portable', 'auxiliary'], ['ev', 'ebus']),
  cosim: applies(['vehicle', 'marine', 'industrial', 'stationary']),
  'part-swap': applies(ALL_APPLICATION_CLASSES),
  showroom: applies(ALL_APPLICATION_CLASSES),
  'circular-value': applies(ALL_APPLICATION_CLASSES),
  'host-machine': applies(ALL_APPLICATION_CLASSES),
  'route-road': applies(['vehicle', 'lmt'], ['robot']),
  terrain: applies(['lmt'], ['ev', 'ebus', 'robot', 'cyberdog']),
  'hull-resistance': applies(['marine']),
  'vessel-twin': applies(['marine']),
  'flight-weather': applies([], ['drone']),
  'legged-gait': applies([], ['cyberdog', 'humanoid']),
  crush: applies(['vehicle', 'lmt', 'marine', 'auxiliary']),
  vibration: applies(['vehicle', 'lmt', 'marine', 'industrial', 'auxiliary'], ['drone']),
  'thermal-field': applies(['vehicle', 'stationary', 'marine', 'industrial']),
  'duty-economics': applies(ALL_APPLICATION_CLASSES),
  'load-profile': applies(ALL_APPLICATION_CLASSES),
  'energy-policy': applies([], ['solar-ess', 'marine']),
  'driving-mode': applies([], ['ev', 'ebus', 'ebike', 'escooter', 'robot']),
  payload: applies([], ['ebus', 'marine', 'drone', 'robot']),
  'round-trip-efficiency': applies(ALL_APPLICATION_CLASSES),
  'space-fill': applies(ALL_APPLICATION_CLASSES),
  'multi-objective': applies(ALL_APPLICATION_CLASSES),
  'integration-allowance': applies(['vehicle', 'stationary', 'marine', 'industrial', 'auxiliary']),
  'spaces-why': applies(ALL_APPLICATION_CLASSES),
  seasons: applies(ALL_APPLICATION_CLASSES),
  'module-tier': applies(['vehicle', 'stationary', 'marine', 'industrial', 'auxiliary']),
  'stacks-racks': applies(['vehicle', 'stationary', 'marine'], ['robot']),
  'hv-chain': applies(['vehicle', 'stationary', 'marine']),
  'bms-topology': applies(['vehicle', 'stationary', 'marine', 'industrial', 'auxiliary']),
  'ems-arch': applies([], ['solar-ess', 'ups', 'ebus', 'marine', 'robot']),
  'btms-loop': applies(['vehicle', 'stationary', 'marine', 'industrial', 'auxiliary']),
  'sensors-plan': applies(ALL_APPLICATION_CLASSES),
  'release-rules': applies(ALL_APPLICATION_CLASSES),
  report: applies(ALL_APPLICATION_CLASSES),
  'root-cause-memory': applies(ALL_APPLICATION_CLASSES),
  simulation: applies(ALL_APPLICATION_CLASSES),
  'ac-side': applies(['vehicle', 'auxiliary', 'marine', 'stationary'], ['powerstation']),
  'charging-strategy': applies(['vehicle', 'industrial', 'stationary', 'marine', 'auxiliary']),
  v2x: applies([], ['ev', 'ebus', 'rv', 'marine']),
  'vehicle-dynamics': applies([], ['ev', 'ebus', 'ebike', 'escooter', 'robot']),
});

export const COMPETENCY_QUESTIONS = Object.freeze([
  Object.freeze({ id: 'CQ-01', question: 'Which exact inputs, model version and solver produced this engineering result?', answerPath: ['bd:usesInput', 'bd:usesModel', 'bd:usesSolver', 'bd:produces'] }),
  Object.freeze({ id: 'CQ-02', question: 'Which requirement, evidence record or assumption supports or blocks this design?', answerPath: ['bd:hasRequirement', 'bd:requiresEvidence', 'bd:supportedByEvidence', 'bd:basedOnAssumption'] }),
  Object.freeze({ id: 'CQ-03', question: 'Which capabilities are available in browser, desktop, API, MCP and reports?', answerPath: ['bd:implementsCapability', 'bd:availableOn'] }),
  Object.freeze({ id: 'CQ-04', question: 'Is a vessel result a catalog model, installation study, validated model or physical-asset-bound digital twin?', answerPath: ['bd:targetsAssetModel', 'bd:studiesInstallationOf', 'bd:boundToAsset', 'bd:representsAsset'] }),
  Object.freeze({ id: 'CQ-05', question: 'Can evidence from one vessel, model or design version be reused for another?', answerPath: ['bd:instanceOf', 'bd:modelOf', 'bd:observesAsset', 'bd:evaluatesModel'] }),
  Object.freeze({ id: 'CQ-06', question: 'What human approval and passing test evidence authorize this exact release?', answerPath: ['bd:verifies', 'bd:authorizes', 'bd:releases'] }),
]);

// One semantic registration for every top-level calculation family returned
// by designFromSpec(). Charging is intentionally one row among its peers.
export const MODULE_DEFINITIONS = Object.freeze({
  pack: { label: 'Pack geometry and sizing', module: 'js/pack-engine.js', runType: 'bd:CalculationRun', domain: 'product', capabilities: ['space-fill', 'integration-allowance', 'spaces-why', 'module-tier'] },
  analysis: { label: 'Engineering perspectives', module: 'js/engineering.js', runType: 'bd:CalculationRun', domain: 'cross-domain', capabilities: ['conductors', 'corrosion', 'multi-objective'] },
  architecture: { label: 'Electrical architecture', module: 'js/architecture.js', runType: 'bd:CalculationRun', domain: 'electrical', capabilities: ['module-tier', 'stacks-racks', 'hv-chain', 'bms-topology', 'ems-arch'] },
  thermal: { label: 'Thermal system', module: 'js/btms.js', runType: 'bd:CalculationRun', domain: 'thermal', capabilities: ['btms-loop', 'thermal-field', 'seasons'] },
  sensors: { label: 'Sensor plan', module: 'js/sensors.js', runType: 'bd:CalculationRun', domain: 'control', capabilities: ['sensors-plan'] },
  diagnostics: { label: 'Engineering diagnostics', module: 'js/diagnostics.js', runType: 'bd:CalculationRun', domain: 'verification', capabilities: ['vibration'] },
  charging: { label: 'Charging system', module: 'js/charging.js', runType: 'bd:CalculationRun', domain: 'charging', capabilities: ['ac-side', 'charging-strategy'] },
  v2x: { label: 'Bidirectional-power policy', module: 'js/v2x.js', runType: 'bd:CalculationRun', domain: 'charging', capabilities: ['v2x'] },
  vehicle: { label: 'Road-vehicle duty', module: 'js/vehicle.js', runType: 'bd:SimulationRun', domain: 'road', capabilities: ['vehicle-dynamics', 'route-road', 'terrain', 'driving-mode', 'payload'] },
  marine: { label: 'Marine voyage duty', module: 'js/marine.js', runType: 'bd:SimulationRun', domain: 'marine', capabilities: ['hull-resistance', 'energy-policy', 'payload'] },
  twinShip: { label: 'Vessel twin evidence', module: 'js/marine-workspace.js', runType: 'bd:CalculationRun', domain: 'marine', capabilities: ['vessel-twin'] },
  flight: { label: 'Flight duty', module: 'js/flight.js', runType: 'bd:SimulationRun', domain: 'aerial', capabilities: ['flight-weather', 'payload'] },
  energyPerformance: { label: 'Round-trip efficiency', module: 'js/efficiency.js', runType: 'bd:CalculationRun', domain: 'electrical', capabilities: ['round-trip-efficiency'] },
  simulation: { label: 'Battery mission simulation', module: 'js/sim1d.js', runType: 'bd:SimulationRun', domain: 'model', capabilities: ['load-profile', 'simulation'] },
  shortCircuit: { label: 'Short-circuit study', module: 'js/shortcircuit.js', runType: 'bd:SimulationRun', domain: 'safety', capabilities: ['fault-study'] },
  electricalProtection: { label: 'Electrical protection coordination', module: 'js/electrical-protection.js', runType: 'bd:SimulationRun', domain: 'electrical', capabilities: ['hv-chain', 'conductors'] },
  cost: { label: 'Lifetime cost model', module: 'js/optimizer.js', runType: 'bd:CalculationRun', domain: 'lifecycle', capabilities: ['duty-economics', 'multi-objective'] },
  co2: { label: 'Carbon screening model', module: 'js/report.js', runType: 'bd:CalculationRun', domain: 'lifecycle', capabilities: ['footprint'] },
  regulatory: { label: 'Regulatory applicability audit', module: 'js/eurules.js', runType: 'bd:CalculationRun', domain: 'compliance', capabilities: ['release-rules'], resultKeys: ['regulatory', 'eu'] },
  checklist: { label: 'Market release checklist', module: 'js/markets.js', runType: 'bd:CalculationRun', domain: 'governance', capabilities: ['release-rules'] },
  comparison: { label: 'Cell comparison', module: 'js/sim1d.js', runType: 'bd:SimulationRun', domain: 'model', capabilities: ['multi-objective'] },
});

export const STATUS_VOCABULARIES = Object.freeze({
  diagnosticSeverity: ['pass', 'info', 'warn', 'fail'],
  evidenceMaturity: ['missing', 'assumed', 'provisional', 'published', 'supplier', 'measured', 'validated'],
  engineeringFeasibility: ['pass', 'review', 'fail', 'not-applicable'],
  workflowState: ['draft', 'validated', 'reviewed', 'approved', 'released'],
  releaseDecision: ['not-requested', 'blocked', 'approved', 'released'],
});

export const SHAPE_DEFINITIONS = Object.freeze([
  { id: 'bd:QuantityValueShape', target: 'bd:QuantityValue', required: ['quantityKind', 'numericValue', 'unit'], profile: 'calculation-ready', implemented: true },
  { id: 'bd:ModelRunShape', target: 'bd:ModelRun', required: ['inputDigest', 'modelVersion', 'solverVersion'], requiredRelations: ['bd:usesModel', 'bd:usesInput', 'bd:usesSolver', 'bd:produces'], profile: 'calculation-ready', implemented: true },
  { id: 'bd:EngineeringResultShape', target: 'bd:EngineeringResult', required: ['resultDigest'], digest: 'sha256', profile: 'calculation-ready', implemented: true },
  { id: 'bd:ProvenancedClaimShape', target: 'bd:Claim', required: ['basis'], allowedBasis: ['published', 'supplier', 'measured', 'calculated', 'derived', 'assumed'], profile: 'authoring', implemented: true },
  { id: 'bd:EvidenceRecordShape', target: 'bd:EvidenceRecord', governedTargets: ['bd:TestEvidence', 'bd:CalibrationTrial', 'bd:ValidationTrial', 'bd:ReplayDataset'], required: ['revision', 'issuedAt'], profile: 'release-ready', implemented: true },
  { id: 'bd:ReleaseShape', target: 'bd:ReleaseDecision', required: ['designChecksum'], requiredRelations: ['bd:releases', 'bd:performedBy'], requiresIncoming: ['bd:authorizes'], requiresBoundTestEvidence: true, profile: 'release-ready', implemented: true },
  { id: 'bd:TwinReadinessShape', target: 'bd:DigitalTwin', exactRelations: ['bd:representsAsset'], requiredEvidenceTypes: ['bd:CalibrationTrial', 'bd:ValidationTrial', 'bd:ReplayDataset'], sameAssetBinding: true, profile: 'twin-ready', implemented: true },
  { id: 'bd:HILRunShape', target: 'bd:HILRun', required: ['targetIdentity', 'samplePeriodS', 'measuredTiming', 'safeStateEvidence', 'faultEvidence'], profile: 'hil-ready', implemented: true },
]);

export function ontologyCatalog() {
  return {
    ontology: { ...ONTOLOGY },
    namespaces: { ...NAMESPACES },
    jsonLdContext: { ...JSON_LD_CONTEXT },
    classes: Object.entries(CLASS_DEFINITIONS).map(([id, definition]) => ({ id, ...definition })),
    relations: Object.entries(RELATION_DEFINITIONS).map(([id, definition]) => ({ id, ...definition })),
    units: Object.entries(UNIT_DEFINITIONS).map(([id, definition]) => ({ id: `unit:${id}`, code: id, ...definition })),
    productSurfaces: Object.entries(PRODUCT_SURFACES).map(([id, definition]) => ({ id: `surface:${id}`, key: id, ...definition })),
    architectureModules: Object.entries(ARCHITECTURE_MODULE_DEFINITIONS).map(([id, definition]) => ({ id: `architecture-module:${id}`, key: id, ...definition })),
    modules: Object.entries(MODULE_DEFINITIONS).map(([id, definition]) => ({ id: `module:${id}`, key: id, ...definition })),
    ruleGrammar: { operators: [...RULE_OPERATORS], effects: [...RULE_EFFECTS] },
    rules: Object.entries(RULE_DEFINITIONS).map(([id, definition]) => ({ key: id, ...definition })),
    maturitySchemes: Object.values(MATURITY_SCHEMES).map((scheme) => ({
      ...scheme, levels: scheme.levels.map((level) => ({ ...level, requires: [...level.requires] })),
    })),
    concepts: Object.entries(CONCEPT_DEFINITIONS).map(([id, definition]) => ({
      id: `concept:${id}`, key: id, ...definition,
      applicability: { classes: [...CONCEPT_APPLICABILITY[id].classes], apps: [...CONCEPT_APPLICABILITY[id].apps] },
    })),
    competencyQuestions: COMPETENCY_QUESTIONS.map((item) => ({ ...item, answerPath: [...item.answerPath] })),
    shapes: SHAPE_DEFINITIONS.map((shape) => ({ ...shape })),
  };
}

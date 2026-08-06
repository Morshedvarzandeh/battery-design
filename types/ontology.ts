export type DiagnosticSeverity = 'pass' | 'info' | 'warn' | 'fail';
export type EvidenceMaturity =
  | 'missing' | 'assumed' | 'provisional' | 'published' | 'supplier' | 'measured' | 'validated';
export type EngineeringFeasibility = 'pass' | 'review' | 'fail' | 'not-applicable';
export type WorkflowState = 'draft' | 'validated' | 'reviewed' | 'approved' | 'released';
export type ReleaseDecision = 'not-requested' | 'blocked' | 'approved' | 'released';
export type ClaimBasis = 'published' | 'supplier' | 'measured' | 'calculated' | 'derived' | 'assumed';
export type RuleOperator = 'eq' | 'neq' | 'in' | 'notIn' | 'gt' | 'gte' | 'lt' | 'lte' | 'exists' | 'truthy' | 'falsy';
export type RuleEffectType = 'inform' | 'activate-review' | 'require-evidence' | 'block';

export interface RuleCondition {
  fact: string;
  operator: RuleOperator;
  value?: unknown;
  unit?: string;
}

export interface RuleDefinition {
  id: string;
  label: string;
  evaluator: 'ontology-rule-runtime@1';
  match: 'all' | 'any';
  when: RuleCondition[];
  requiredFacts?: Array<{ fact: string; oneOf?: unknown[] }>;
  effect?: { type: RuleEffectType; target: string; message: string };
  missingFactOutcome?: 'review' | 'not-applicable' | 'block';
}

export interface RuleEvaluation {
  id: string;
  label: string;
  evaluator: 'ontology-rule-runtime@1';
  applies: boolean;
  complete: boolean;
  missingFacts: string[];
  conditionResults: Array<{
    fact: string;
    operator: RuleOperator;
    status: 'evaluated' | 'missing' | 'missing-unit' | 'unit-mismatch' | 'invalid-fact';
    matched: boolean;
  }>;
  effect: RuleDefinition['effect'] | null;
}

export interface OntologyIdentity {
  id: string;
  version: string;
  shapesVersion: string;
}

export interface SemanticNode {
  id: string;
  types: string[];
  label: string;
  properties: Record<string, unknown>;
}

export interface SemanticEdge {
  id: string;
  from: string;
  type: string;
  to: string;
  properties: Record<string, unknown>;
}

export interface SemanticViolation {
  shapeId: string;
  focusNode: string;
  path: string;
  severity: 'error' | 'warning';
  code: string;
  message: string;
}

export interface SemanticValidation {
  conforms: boolean;
  profile: string;
  shapesVersion: string;
  checkedShapes: string[];
  issues: SemanticViolation[];
}

export interface SemanticGraph {
  format: 'battery-design/semantic-graph@1';
  ontology: OntologyIdentity;
  rootId: string | null;
  nodes: SemanticNode[];
  edges: SemanticEdge[];
  checksum: string;
  validation: SemanticValidation;
}

export interface QuantityValue {
  quantityKind: string;
  numericValue: number;
  unit: string;
  uncertainty?: number;
  tolerance?: number;
}

export interface EvidenceReference {
  id: string;
  kind: string;
  revision: string;
  issuedAt: string;
  sha256?: string;
  classification: 'public' | 'supplier-confidential' | 'project-confidential';
  boundTo: string[];
}

export interface ProvenancedClaim<T = unknown> {
  id: string;
  subject: string;
  predicate: string;
  value: T;
  basis: ClaimBasis;
  generatedBy?: string;
  supportedBy: string[];
}

export interface DesignSemanticSummary {
  ontology: OntologyIdentity & { checksum: string };
  rootId: string;
  conforms: boolean;
  profile: string;
  counts: { nodes: number; edges: number; modelRuns: number };
  feasibility: EngineeringFeasibility | null;
  evidenceMaturity: EvidenceMaturity | null;
  unresolvedEvidence: Array<{ id: string; label: string }>;
  diagnosticCounts: Record<DiagnosticSeverity, number>;
  issues: SemanticViolation[];
  graph: SemanticGraph;
}

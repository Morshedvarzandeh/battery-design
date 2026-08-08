#![cfg(feature = "sundials-ida-klu")]

use battery_design_core::dae::DaeResidualSystem;
use battery_design_core::equations::{
    Block, BlockKind, CompiledGraph, EquationGraph, Quantity, SolverSettings,
};
use battery_design_dae_native::{
    IdaAbsoluteTolerance, IdaError, IdaInitialConditionPolicy, IdaKluBackend, IdaKluSettings,
    MAX_KLU_DIMENSION, MAX_KLU_JACOBIAN_ENTRY_WORK, MAX_KLU_JACOBIAN_EVALUATIONS,
    MAX_KLU_KNOWN_CSC_BYTES, MAX_KLU_NONZEROS, MAX_KLU_RESULT_VALUES, NATIVE_IDA_BACKEND_CONTRACT,
    NATIVE_IDA_BACKEND_ID, NATIVE_IDA_KLU_BACKEND_CONTRACT, NATIVE_IDA_KLU_BACKEND_ID,
    PINNED_KLU_VERSION, PINNED_SUITESPARSE_VERSION, PINNED_SUNDIALS_VERSION,
};

fn core_settings() -> SolverSettings {
    SolverSettings {
        end_s: 0.0,
        ..SolverSettings::default()
    }
}

fn exponential_graph() -> CompiledGraph {
    let mut graph = EquationGraph::new();
    let target = graph
        .add_block(Block::new(
            "target",
            Quantity::Dimensionless,
            BlockKind::Constant { value: 1.0 },
        ))
        .unwrap();
    let state = graph
        .add_block(Block::new(
            "state",
            Quantity::Dimensionless,
            BlockKind::FirstOrder {
                tau_s: 1.0,
                initial: 0.0,
            },
        ))
        .unwrap();
    graph.connect(target, state, 0).unwrap();
    graph.compile().unwrap()
}

fn chain_graph(dimension: usize) -> CompiledGraph {
    assert!(dimension > 0);
    let mut graph = EquationGraph::new();
    let mut previous = graph
        .add_block(Block::new(
            "chain 0",
            Quantity::Dimensionless,
            BlockKind::Constant { value: 1.0 },
        ))
        .unwrap();
    for index in 1..dimension {
        let current = graph
            .add_block(Block::new(
                format!("chain {index}"),
                Quantity::Dimensionless,
                BlockKind::Gain {
                    gain: 1.0,
                    input: Quantity::Dimensionless,
                },
            ))
            .unwrap();
        graph.connect(previous, current, 0).unwrap();
        previous = current;
    }
    graph.compile().unwrap()
}

fn lower(graph: &CompiledGraph) -> DaeResidualSystem<'_> {
    DaeResidualSystem::lower(graph, 0.0, &core_settings()).unwrap()
}

fn settings() -> IdaKluSettings {
    IdaKluSettings {
        initial_time_s: 0.0,
        output_times_s: vec![0.25],
        relative_tolerance: 1.0e-8,
        absolute_tolerance: IdaAbsoluteTolerance::Scalar(1.0e-10),
        max_order: 5,
        max_steps: 250_000,
        max_dimension: MAX_KLU_DIMENSION,
        max_nonzeros: MAX_KLU_NONZEROS,
        max_known_csc_bytes: MAX_KLU_KNOWN_CSC_BYTES,
        max_jacobian_evaluations: 10_000,
        max_jacobian_entry_work: MAX_KLU_JACOBIAN_ENTRY_WORK,
        max_result_values: MAX_KLU_RESULT_VALUES,
        suppress_algebraic_error: true,
        initial_conditions: IdaInitialConditionPolicy::ContractConsistent,
    }
}

#[test]
fn pinned_klu_backend_initializes_with_sparse_identity() {
    let identity = IdaKluBackend::new().unwrap().identity();
    assert_eq!(identity.backend_id, NATIVE_IDA_KLU_BACKEND_ID);
    assert_eq!(identity.contract, NATIVE_IDA_KLU_BACKEND_CONTRACT);
    assert!(identity.sparse);
}

#[test]
fn identity_binds_all_three_pinned_versions() {
    let version = IdaKluBackend::new().unwrap().identity().version;
    for expected in [
        PINNED_SUNDIALS_VERSION,
        PINNED_SUITESPARSE_VERSION,
        PINNED_KLU_VERSION,
    ] {
        assert!(
            version.contains(expected),
            "missing {expected} from {version}"
        );
    }
}

#[test]
fn identity_binds_serial_csc_klu_colamd_surface() {
    let identity = IdaKluBackend::new().unwrap().identity();
    assert_eq!(identity.vector, "NVECTOR_SERIAL");
    assert_eq!(identity.matrix, "SUNMATRIX_SPARSE_CSC");
    assert_eq!(identity.linear_solver, "SUNLINSOL_KLU_COLAMD");
    assert_eq!(identity.precision, "double");
    assert_eq!(identity.index_bits, 64);
}

#[test]
fn identity_is_disjoint_from_dense_contract_and_backend() {
    assert_ne!(NATIVE_IDA_KLU_BACKEND_ID, NATIVE_IDA_BACKEND_ID);
    assert_ne!(NATIVE_IDA_KLU_BACKEND_CONTRACT, NATIVE_IDA_BACKEND_CONTRACT);
}

#[test]
fn fresh_klu_contexts_have_identical_public_evidence() {
    let first = IdaKluBackend::new().unwrap().identity();
    let second = IdaKluBackend::new().unwrap().identity();
    assert_eq!(first, second);
}

#[test]
fn backend_owned_sparse_ceilings_are_exact_and_nonzero() {
    assert_eq!(MAX_KLU_DIMENSION, 10_000);
    assert_eq!(MAX_KLU_RESULT_VALUES, 25_600_000);
    assert!(MAX_KLU_NONZEROS >= 2 * MAX_KLU_DIMENSION - 1);
    assert!(MAX_KLU_KNOWN_CSC_BYTES > 0);
    assert!(MAX_KLU_JACOBIAN_EVALUATIONS > 0);
    assert!(MAX_KLU_JACOBIAN_ENTRY_WORK > 0);
}

#[test]
fn one_thousand_variable_chain_has_exact_sorted_unique_csc_and_known_bytes() {
    let graph = chain_graph(1_000);
    let system = lower(&graph);
    assert_eq!(system.variables().len(), 1_000);
    assert_eq!(system.csc_pattern().nonzero_count(), 1_999);
    assert_eq!(IdaKluSettings::known_csc_bytes(1_000, 1_999), Some(55_984));
    assert_csc_contract(&system);
    settings().validate_for(&system).unwrap();
}

#[test]
fn ten_thousand_variable_chain_has_exact_sorted_unique_csc_and_known_bytes() {
    let graph = chain_graph(10_000);
    let system = lower(&graph);
    assert_eq!(system.variables().len(), 10_000);
    assert_eq!(system.csc_pattern().nonzero_count(), 19_999);
    assert_eq!(
        IdaKluSettings::known_csc_bytes(10_000, 19_999),
        Some(559_984)
    );
    assert_csc_contract(&system);
    settings().validate_for(&system).unwrap();
}

fn assert_csc_contract(system: &DaeResidualSystem<'_>) {
    let dimension = system.variables().len();
    let pattern = system.csc_pattern();
    assert_eq!(pattern.column_pointers().len(), dimension + 1);
    assert_eq!(pattern.column_pointers()[0], 0);
    assert_eq!(
        pattern.column_pointers()[dimension],
        pattern.nonzero_count()
    );
    for column in 0..dimension {
        let rows = &pattern.row_indices()
            [pattern.column_pointers()[column]..pattern.column_pointers()[column + 1]];
        assert!(rows.windows(2).all(|pair| pair[0] < pair[1]));
        assert!(rows.binary_search(&column).is_ok());
    }
}

#[test]
fn lowered_exponential_passes_complete_sparse_admission() {
    let graph = exponential_graph();
    settings().validate_for(&lower(&graph)).unwrap();
}

#[test]
fn zero_applied_dimension_is_rejected() {
    let graph = exponential_graph();
    let mut request = settings();
    request.max_dimension = 0;
    assert_eq!(
        request.validate_for(&lower(&graph)).unwrap_err().code(),
        "ida.klu.max_dimension.out_of_range"
    );
}

#[test]
fn dimension_setting_cannot_exceed_backend_ceiling() {
    let graph = exponential_graph();
    let mut request = settings();
    request.max_dimension = MAX_KLU_DIMENSION + 1;
    assert_eq!(
        request.validate_for(&lower(&graph)).unwrap_err().code(),
        "ida.klu.max_dimension.out_of_range"
    );
}

#[test]
fn applied_dimension_limit_reports_actual_and_both_ceilings() {
    let graph = exponential_graph();
    let system = lower(&graph);
    let mut request = settings();
    request.max_dimension = 1;
    assert_eq!(
        request.validate_for(&system).unwrap_err(),
        IdaError::KluDimensionLimit {
            actual: 2,
            applied_maximum: 1,
            backend_maximum: MAX_KLU_DIMENSION,
        }
    );
}

#[test]
fn zero_applied_nonzero_limit_is_rejected() {
    let graph = exponential_graph();
    let mut request = settings();
    request.max_nonzeros = 0;
    assert_eq!(
        request.validate_for(&lower(&graph)).unwrap_err().code(),
        "ida.klu.max_nonzeros.out_of_range"
    );
}

#[test]
fn nonzero_setting_cannot_exceed_backend_ceiling() {
    let graph = exponential_graph();
    let mut request = settings();
    request.max_nonzeros = MAX_KLU_NONZEROS + 1;
    assert_eq!(
        request.validate_for(&lower(&graph)).unwrap_err().code(),
        "ida.klu.max_nonzeros.out_of_range"
    );
}

#[test]
fn applied_nonzero_limit_reports_exact_pattern_count() {
    let graph = exponential_graph();
    let system = lower(&graph);
    let actual = system.csc_pattern().nonzero_count();
    let mut request = settings();
    request.max_nonzeros = actual - 1;
    assert_eq!(
        request.validate_for(&system).unwrap_err(),
        IdaError::KluNonzeroLimit {
            actual,
            applied_maximum: actual - 1,
            backend_maximum: MAX_KLU_NONZEROS,
        }
    );
}

#[test]
fn zero_known_csc_byte_limit_is_rejected() {
    let graph = exponential_graph();
    let mut request = settings();
    request.max_known_csc_bytes = 0;
    assert_eq!(
        request.validate_for(&lower(&graph)).unwrap_err().code(),
        "ida.klu.max_known_csc_bytes.out_of_range"
    );
}

#[test]
fn known_csc_byte_setting_cannot_exceed_backend_ceiling() {
    let graph = exponential_graph();
    let mut request = settings();
    request.max_known_csc_bytes = MAX_KLU_KNOWN_CSC_BYTES + 1;
    assert_eq!(
        request.validate_for(&lower(&graph)).unwrap_err().code(),
        "ida.klu.max_known_csc_bytes.out_of_range"
    );
}

#[test]
fn applied_known_csc_byte_limit_is_exact_and_excludes_factor_fill() {
    let graph = exponential_graph();
    let system = lower(&graph);
    let actual = IdaKluSettings::known_csc_bytes(
        system.variables().len(),
        system.csc_pattern().nonzero_count(),
    )
    .unwrap();
    let mut request = settings();
    request.max_known_csc_bytes = actual - 1;
    assert_eq!(
        request.validate_for(&system).unwrap_err(),
        IdaError::KluKnownCscByteLimit {
            actual,
            applied_maximum: actual - 1,
            backend_maximum: MAX_KLU_KNOWN_CSC_BYTES,
        }
    );
}

#[test]
fn zero_jacobian_evaluation_limit_is_rejected() {
    let graph = exponential_graph();
    let mut request = settings();
    request.max_jacobian_evaluations = 0;
    assert_eq!(
        request.validate_for(&lower(&graph)).unwrap_err().code(),
        "ida.klu.max_jacobian_evaluations.out_of_range"
    );
}

#[test]
fn jacobian_evaluation_setting_cannot_exceed_backend_ceiling() {
    let graph = exponential_graph();
    let mut request = settings();
    request.max_jacobian_evaluations = MAX_KLU_JACOBIAN_EVALUATIONS + 1;
    assert_eq!(
        request.validate_for(&lower(&graph)).unwrap_err().code(),
        "ida.klu.max_jacobian_evaluations.out_of_range"
    );
}

#[test]
fn zero_jacobian_entry_work_limit_is_rejected() {
    let graph = exponential_graph();
    let mut request = settings();
    request.max_jacobian_entry_work = 0;
    assert_eq!(
        request.validate_for(&lower(&graph)).unwrap_err().code(),
        "ida.klu.max_jacobian_entry_work.out_of_range"
    );
}

#[test]
fn configured_jacobian_entry_projection_must_fit_applied_limit() {
    let graph = exponential_graph();
    let system = lower(&graph);
    let nonzeros = system.csc_pattern().nonzero_count() as u64;
    let mut request = settings();
    request.max_jacobian_evaluations = 2;
    request.max_jacobian_entry_work = 2 * nonzeros - 1;
    assert_eq!(
        request.validate_for(&system).unwrap_err(),
        IdaError::KluJacobianEntryWorkLimit {
            attempted: 2 * nonzeros,
            maximum: 2 * nonzeros - 1,
        }
    );
}

#[test]
fn zero_result_value_limit_is_rejected() {
    let graph = exponential_graph();
    let mut request = settings();
    request.max_result_values = 0;
    assert_eq!(
        request.validate_for(&lower(&graph)).unwrap_err().code(),
        "ida.klu.max_result_values.out_of_range"
    );
}

#[test]
fn result_value_setting_cannot_exceed_independent_backend_ceiling() {
    let graph = exponential_graph();
    let mut request = settings();
    request.max_result_values = MAX_KLU_RESULT_VALUES + 1;
    assert_eq!(
        request.validate_for(&lower(&graph)).unwrap_err().code(),
        "ida.klu.max_result_values.out_of_range"
    );
}

#[test]
fn applied_result_value_limit_uses_exact_grid_times_output_product() {
    let graph = exponential_graph();
    let system = lower(&graph);
    let mut request = settings();
    request.output_times_s = vec![0.1, 0.2];
    request.max_result_values = 3;
    assert_eq!(
        request.validate_for(&system).unwrap_err(),
        IdaError::ResultValueLimit {
            actual: 4,
            maximum: 3,
        }
    );
}

#![cfg(feature = "sundials-ida")]

use battery_design_dae_native::{
    IdaDenseBackend, NATIVE_IDA_BACKEND_CONTRACT, NATIVE_IDA_BACKEND_ID, PINNED_SUNDIALS_VERSION,
};

#[test]
fn feature_on_backend_reports_the_exact_dense_serial_identity() {
    let backend = IdaDenseBackend::new().expect("the exact pinned native backend must initialize");
    let identity = backend.identity();

    assert_eq!(identity.backend_id, NATIVE_IDA_BACKEND_ID);
    assert_eq!(identity.contract, NATIVE_IDA_BACKEND_CONTRACT);
    assert_eq!(identity.provider, "SUNDIALS");
    assert_eq!(identity.solver, "IDA");
    assert_eq!(identity.version, PINNED_SUNDIALS_VERSION);
    assert_eq!(identity.vector, "NVECTOR_SERIAL");
    assert_eq!(identity.matrix, "SUNMATRIX_DENSE");
    assert_eq!(identity.linear_solver, "SUNLINSOL_DENSE");
    assert_eq!(identity.precision, "double");
    assert_eq!(identity.index_bits, 64);
    assert!(!identity.sparse);
}

#[test]
fn native_context_can_be_destroyed_and_recreated_without_shared_state() {
    for _ in 0..3 {
        let backend = IdaDenseBackend::new().expect("each context must initialize independently");
        assert_eq!(backend.identity().version, PINNED_SUNDIALS_VERSION);
        drop(backend);
    }
}

#![cfg(not(feature = "sundials-ida"))]

use battery_design_dae_native::{
    IdaDenseBackend, IdaError, NATIVE_IDA_BACKEND_ID, REQUIRED_FEATURE,
};

#[test]
fn default_build_reports_unavailable_without_falling_back() {
    let error = IdaDenseBackend::new().expect_err("feature-off construction must fail closed");
    assert_eq!(error.code(), "ida.backend.unavailable");
    assert_eq!(
        error,
        IdaError::Unavailable {
            backend: NATIVE_IDA_BACKEND_ID,
            required_feature: REQUIRED_FEATURE,
        }
    );
}

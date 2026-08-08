#![cfg(not(feature = "sundials-ida-klu"))]

use battery_design_dae_native::{
    IdaError, IdaKluBackend, IdaKluSettings, NATIVE_IDA_BACKEND_ID,
    NATIVE_IDA_KLU_BACKEND_CONTRACT, NATIVE_IDA_KLU_BACKEND_ID, REQUIRED_KLU_FEATURE,
};

#[test]
fn klu_construction_fails_closed_without_its_feature() {
    assert_eq!(
        IdaKluBackend::new().unwrap_err(),
        IdaError::Unavailable {
            backend: NATIVE_IDA_KLU_BACKEND_ID,
            required_feature: REQUIRED_KLU_FEATURE,
        }
    );
}

#[test]
fn klu_identity_cannot_be_confused_with_dense_identity() {
    assert_ne!(NATIVE_IDA_KLU_BACKEND_ID, NATIVE_IDA_BACKEND_ID);
    assert!(NATIVE_IDA_KLU_BACKEND_CONTRACT.ends_with("@1"));
    assert!(NATIVE_IDA_KLU_BACKEND_CONTRACT.contains("klu"));
}

#[test]
fn known_csc_accounting_is_available_without_native_code() {
    assert_eq!(IdaKluSettings::known_csc_bytes(1, 1), Some(40));
    assert_eq!(
        IdaKluSettings::known_csc_bytes(10_000, 19_999),
        Some(559_984)
    );
}

#[test]
fn known_csc_accounting_rejects_integer_overflow() {
    assert_eq!(IdaKluSettings::known_csc_bytes(usize::MAX, 1), None);
    assert_eq!(IdaKluSettings::known_csc_bytes(1, usize::MAX), None);
}

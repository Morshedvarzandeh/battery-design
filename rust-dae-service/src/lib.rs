//! Source-only protocol primitives for an isolated native DAE worker.
//!
//! Phase 1 defines framing and the strict request wire shape. Phase 2 adds
//! bounded, native-free request admission. Phase 3 adds a source-only Linux
//! one-shot process supervisor. None of these phases calls a native solver,
//! exposes a desktop endpoint, or adds a packaged capability.

pub mod admission;
pub mod protocol;
pub mod supervision;

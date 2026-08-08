//! Source-only protocol primitives for an isolated native DAE worker.
//!
//! Phase 1 defines framing and the strict request wire shape only. It does not
//! launch a process, call a native solver, expose a desktop endpoint, or add a
//! packaged capability.

pub mod protocol;

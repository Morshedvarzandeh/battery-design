//! Source-only protocol primitives for an isolated native DAE worker.
//!
//! Phase 1 defines framing and the strict request wire shape. Phase 2 adds
//! bounded, native-free request admission. Neither phase launches a process,
//! calls a native solver, exposes a desktop endpoint, or adds a packaged
//! capability.

pub mod admission;
pub mod protocol;

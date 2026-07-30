//! Deterministic core. ECS, fixed-step tick, deterministic RNG, canonical state hashing.
//!
//! Per ADR-0004 (Deterministic WASM profile). Determinism rules enforced at multiple layers:
//! - per-crate clippy denials below;
//! - workspace `clippy.toml` (disallowed types + methods);
//! - `tools/wasm-determinism-audit/` over wasm32 outputs (no relaxed-SIMD, no `memory.grow` post-init);
//! - native ↔ WASM replay-trace `diff -u` in CI.
//!
//! See `docs/VERIFICATION.md` for the active gates and replay expectations.

#![forbid(unsafe_code)]
#![deny(clippy::float_arithmetic)]
#![deny(clippy::disallowed_types)]
#![deny(clippy::disallowed_methods)]

pub mod canonical;
pub mod coord;
pub mod ecs;
pub mod fx;
pub mod hash;
pub mod rng;
pub mod spatial;
pub mod tick;

pub use canonical::{CanonicalHash, StateWriter};
pub use coord::{CellAabb2, CellCoord2, CellDelta2, Level, ZoneCell, ZoneId};
pub use ecs::{EntityId, Generation};
pub use fx::SimFx;
pub use hash::StateHasher;
pub use rng::DeterministicRng;
pub use spatial::{
    AoiEntry, AoiPriorityRing, AoiRadii, SpatialCategory, SpatialEntry, SpatialIndex,
    SpatialOccupancyKind,
};
pub use tick::{TickIndex, TickRate};

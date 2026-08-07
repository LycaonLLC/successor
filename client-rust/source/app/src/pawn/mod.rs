//! Animated humanoid pawns: body templates loaded from PawnForge GLB packs,
//! the per-actor animation lane driving the skinning palette, and (later)
//! equipment/appearance. Builds on `engine-core::{glb, anim}` and the renderer's
//! skinned-mesh path proven in Wave 1.

pub mod animator;
pub mod appearance;
pub mod catalog;
pub mod creatures;
pub mod face;
pub mod lod;
pub mod pack;
pub mod scene;

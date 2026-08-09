//! Successor Rust client — engine core.
//!
//! `no_std` + `alloc`. Contains the ECS, fixed-point-free f32 math (via `libm`),
//! shared input codes, and the runtime shims (allocation counter, panic hook,
//! numeric logging, global cell). It depends only on `core`, `alloc`, and
//! `libm`, so it builds for bare-metal (`thumbv7em-none-eabihf`) as a no_std
//! purity proof.
//!
//! The `std` feature is enabled ONLY for the libtest harness (unit tests) and
//! host tooling. It must never be enabled for a shipping game build.

#![cfg_attr(not(feature = "std"), no_std)]

extern crate alloc;

pub mod anim;
pub mod assets;
pub mod audio;
pub mod ecs;
pub mod glb;
pub mod image;
pub mod input;
pub mod json;
pub mod math;
pub mod prefab;
pub mod rt;

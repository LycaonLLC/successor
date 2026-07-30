//! Runtime shims: allocation counter, numeric logging, a single-threaded global
//! cell, and an optional bare-metal panic handler. All `no_std`-safe.

pub mod alloc;
pub mod cell;
pub mod log;
pub mod panic;

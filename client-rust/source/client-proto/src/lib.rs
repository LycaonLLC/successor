//! Successor Rust client — wire protocol (Step 5).
//! Implements a minimal Colyseus 0.17 protocol and handles server packet structures.

pub mod colyseus;
pub mod packets;
pub mod session;

#[cfg(test)]
mod tests;

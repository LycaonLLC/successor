//! Playable-slice systems: projecting streamed authority state into the ECS,
//! turning input into movement commands, and the chat overlay. Native-only —
//! the wasm runtime's networking is a later parity wave.

pub mod chat;
pub mod movement;
pub mod projection;

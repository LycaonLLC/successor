//! Playable-slice systems: projecting streamed authority state into the ECS,
//! turning input into movement commands, and the chat overlay. Native-only —
//! the wasm runtime's networking is a later parity wave.

pub mod authority;
pub mod combat_fx;
pub mod command_queue;
pub mod interp;
pub mod prediction;
pub mod chat;
pub mod chat_net;
pub mod chat_ui;
pub mod movement;
pub mod projection;

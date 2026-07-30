//! Successor Rust client — platform backend.

#[cfg(not(target_arch = "wasm32"))]
pub mod native;

#[cfg(target_arch = "wasm32")]
pub mod web;

pub mod gl_gpu;

// Common GPU re-exports
pub use gl_gpu::GlGpu;

pub fn create_gpu() -> GlGpu {
    GlGpu::new()
}

// target-specific re-exports of free-function surface
#[cfg(not(target_arch = "wasm32"))]
pub use native::window::{
    init, should_quit, begin_frame, end_frame, deinit, framebuffer_size, now_ms,
    is_key_down, set_cursor_visible, poll_text_input, read_pixels_rgba, gl_error,
};

#[cfg(target_arch = "wasm32")]
pub use web::{
    init, should_quit, begin_frame, end_frame, deinit, framebuffer_size, now_ms,
    is_key_down, set_cursor_visible, poll_text_input,
};

// Network transport re-exports
#[cfg(not(target_arch = "wasm32"))]
pub use native::net::{ws_connect, ws_send, ws_poll, WsHandle, WsEvent};
#[cfg(not(target_arch = "wasm32"))]
pub use native::http::http_post_json;

#[cfg(target_arch = "wasm32")]
pub use web::net::{ws_connect, ws_send, ws_poll, WsHandle, WsEvent};
#[cfg(target_arch = "wasm32")]
pub use web::net::http_post_json;

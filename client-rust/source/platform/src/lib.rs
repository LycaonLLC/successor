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
    begin_frame, deinit, end_frame, framebuffer_size, gl_error, init, is_key_down,
    mouse_button_down, mouse_position, now_ms, poll_text_input, read_pixels_rgba,
    set_cursor_visible, should_quit,
};

#[cfg(target_arch = "wasm32")]
pub use web::{
    begin_frame, deinit, end_frame, framebuffer_size, init, is_key_down, mouse_button_down,
    mouse_position, now_ms, poll_text_input, read_pixels_rgba, set_cursor_visible, should_quit,
};

// Network transport re-exports
#[cfg(not(target_arch = "wasm32"))]
pub use native::audio::{AudioOutput, FillFn};
#[cfg(not(target_arch = "wasm32"))]
pub use native::fs::{fs_exists, fs_read};
#[cfg(not(target_arch = "wasm32"))]
pub use native::http::{http_get, http_post_json};
#[cfg(not(target_arch = "wasm32"))]
pub use native::net::{ws_connect, ws_poll, ws_send, WsEvent, WsHandle};

#[cfg(target_arch = "wasm32")]
pub use web::net::{http_get, http_post_json};
#[cfg(target_arch = "wasm32")]
pub use web::net::{ws_connect, ws_poll, ws_send, WsEvent, WsHandle};

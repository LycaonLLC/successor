//! Web platform implementation.

pub mod gl;
pub mod net;

use successor_engine_core::input::Key;

extern "C" {
    fn js_init(title_ptr: *const u8, title_len: u32, w: i32, h: i32);
    fn js_log(ptr: *const u8, len: u32);
    fn js_get_canvas_size(w_ptr: *mut i32, h_ptr: *mut i32);
    fn js_now_ms() -> f64;
    fn js_is_key_down(key: u32) -> u32;
    fn js_set_cursor_visible(visible: u32);
    fn js_poll_char() -> i32;
}

fn web_log_sink(s: &str) {
    unsafe {
        js_log(s.as_ptr(), s.len() as u32);
    }
}

pub fn init(title: &str, w: i32, h: i32) -> bool {
    successor_engine_core::rt::log::set_sink(web_log_sink);
    unsafe {
        js_init(title.as_ptr(), title.len() as u32, w, h);
    }
    true
}

pub fn should_quit() -> bool {
    false
}

pub fn begin_frame() {}

pub fn end_frame() {}

pub fn deinit() {}

pub fn framebuffer_size() -> (i32, i32) {
    let mut w = 0;
    let mut h = 0;
    unsafe {
        js_get_canvas_size(&mut w, &mut h);
    }
    (w, h)
}

pub fn now_ms() -> f64 {
    unsafe { js_now_ms() }
}

pub fn is_key_down(key: Key) -> bool {
    unsafe { js_is_key_down(key as u32) != 0 }
}

pub fn set_cursor_visible(visible: bool) {
    unsafe {
        js_set_cursor_visible(if visible { 1 } else { 0 });
    }
}

pub fn poll_text_input() -> Option<char> {
    let res = unsafe { js_poll_char() };
    if res >= 0 {
        std::char::from_u32(res as u32)
    } else {
        None
    }
}

/// Mouse position (framebuffer px). Web input routing lands in the wasm wave;
/// until then this reports the origin so the shared UI code compiles/runs.
pub fn mouse_position() -> (f32, f32) {
    (0.0, 0.0)
}

pub fn mouse_button_down(_button: i32) -> bool {
    false
}

pub mod http {
    pub use super::net::http_post_json;
}

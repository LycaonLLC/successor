//! Web platform implementation.

pub mod gl;
pub mod net;

use successor_engine_core::input::Key;

#[link(wasm_import_module = "env")]
extern "C" {
    fn js_log(ptr: *const u8, len: u32);
    fn js_init(ptr: *const u8, len: u32, width: i32, height: i32);
    fn js_get_canvas_size(width: *mut i32, height: *mut i32);
    fn js_now_ms() -> f64;
    fn js_is_key_down(key: u32) -> u32;
    fn js_set_cursor_visible(visible: u32);
    fn js_poll_char() -> i32;
    fn js_poll_scroll_x() -> f32;
    fn js_poll_scroll_y() -> f32;
    fn js_get_mouse_x() -> f32;
    fn js_get_mouse_y() -> f32;
    fn js_mouse_button_down(button: u32) -> u32;
    fn js_launch_context_len() -> u32;
    fn js_launch_context_copy(ptr: *mut u8, max_len: u32) -> u32;
    fn js_audio_unlock();
    fn js_audio_play(
        ptr: *const u8,
        len: u32,
        key: u32,
        gain: f32,
        pan: f32,
        looped: u32,
        polyphony: u32,
    ) -> u32;
    fn js_audio_stop(key: u32);
    fn js_audio_active_voices() -> u32;
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

pub fn mouse_position() -> (f32, f32) {
    unsafe { (js_get_mouse_x(), js_get_mouse_y()) }
}

pub fn mouse_button_down(button: i32) -> bool {
    button >= 0 && unsafe { js_mouse_button_down(button as u32) != 0 }
}

pub fn launch_context() -> Option<Vec<u8>> {
    let len = unsafe { js_launch_context_len() } as usize;
    if len == 0 || len > 1024 * 1024 {
        return None;
    }
    let mut bytes = vec![0; len];
    let copied = unsafe { js_launch_context_copy(bytes.as_mut_ptr(), len as u32) } as usize;
    (copied == len).then_some(bytes)
}

pub fn unlock_audio() {
    unsafe { js_audio_unlock() }
}

pub fn audio_play(
    path: &str,
    key: u32,
    gain: f32,
    pan: f32,
    looped: bool,
    polyphony: u32,
) -> bool {
    unsafe {
        js_audio_play(
            path.as_ptr(),
            path.len() as u32,
            key,
            gain,
            pan,
            looped as u32,
            polyphony,
        ) != 0
    }
}

pub fn audio_stop(key: u32) {
    unsafe { js_audio_stop(key) }
}

pub fn audio_active_voices() -> u32 {
    unsafe { js_audio_active_voices() }
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

pub fn poll_scroll_delta() -> Option<(f32, f32)> {
    let delta = unsafe { (js_poll_scroll_x(), js_poll_scroll_y()) };
    if delta.0 == 0.0 && delta.1 == 0.0 {
        None
    } else {
        Some(delta)
    }
}

pub mod http {
    pub use super::net::http_post_json;
}

pub fn read_pixels_rgba(width: i32, height: i32) -> Vec<u8> {
    let mut pixels = vec![0; (width.max(0) * height.max(0) * 4) as usize];
    gl::read_pixels(
        0,
        0,
        width,
        height,
        gl::RGBA,
        gl::UNSIGNED_BYTE,
        &mut pixels,
    );
    pixels
}

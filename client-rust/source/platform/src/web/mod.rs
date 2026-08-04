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
    fn js_creator_mode() -> u32;
    fn js_creator_ready();
    fn js_creator_message_len() -> u32;
    fn js_creator_message_copy(ptr: *mut u8, max_len: u32) -> u32;
    fn js_creator_message_discard();
    fn js_creator_post_create(ptr: *const u8, len: u32) -> u32;
    fn js_creator_post_select(ptr: *const u8, len: u32) -> u32;
    fn js_audio_unlock();
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

/// Creator parent bridge is only active for the public `?mode=creator` child
/// surface. It cannot become an alternate launch or account path.
pub fn creator_mode() -> bool {
    unsafe { js_creator_mode() != 0 }
}

/// Announce the child after its Rust creator state is ready to receive the
/// parent’s bounded roster projection.
pub fn creator_ready() {
    unsafe { js_creator_ready() }
}

/// Takes one normalized parent message. The JavaScript bridge enforces exact
/// source/origin and a fixed queue; this is a second byte bound before parsing.
pub fn take_creator_message() -> Option<Vec<u8>> {
    const MAX_MESSAGE_BYTES: usize = 16 * 1024;
    let len = unsafe { js_creator_message_len() } as usize;
    if len == 0 {
        return None;
    }
    if len > MAX_MESSAGE_BYTES {
        unsafe { js_creator_message_discard() };
        return None;
    }
    let mut bytes = vec![0; len];
    let copied = unsafe { js_creator_message_copy(bytes.as_mut_ptr(), len as u32) } as usize;
    (copied == len).then_some(bytes)
}

/// Sends the fixed creator-create envelope. JavaScript parses and rebuilds it
/// before `postMessage`, so arbitrary fields can never cross the iframe fence.
pub fn post_creator_create(message: &str) -> bool {
    const MAX_CREATE_BYTES: usize = 4 * 1024;
    !message.is_empty()
        && message.len() <= MAX_CREATE_BYTES
        && unsafe { js_creator_post_create(message.as_ptr(), message.len() as u32) != 0 }
}

/// Sends a stable, bounded opaque character id for the parent’s one-shot
/// handoff. The browser side validates it again before it leaves the frame.
pub fn post_creator_select(character_id: &str) -> bool {
    !character_id.is_empty()
        && character_id.len() <= 128
        && unsafe { js_creator_post_select(character_id.as_ptr(), character_id.len() as u32) != 0 }
}

pub fn unlock_audio() {
    unsafe { js_audio_unlock() }
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

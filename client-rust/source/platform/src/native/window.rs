//! Native windowing and input implementation via GLFW.
#![allow(dead_code)]

use parking_lot::Mutex;
use std::os::raw::c_void;
use successor_engine_core::input::Key;

// GLFW Constants
const GLFW_CONTEXT_VERSION_MAJOR: i32 = 0x00022002;
const GLFW_CONTEXT_VERSION_MINOR: i32 = 0x00022003;
const GLFW_OPENGL_PROFILE: i32 = 0x00022008;
const GLFW_OPENGL_CORE_PROFILE: i32 = 0x00032001;
const GLFW_OPENGL_FORWARD_COMPAT: i32 = 0x00022006;
const GLFW_VISIBLE: i32 = 0x00020002;
const GLFW_COCOA_RETINA_FRAMEBUFFER: i32 = 0x00023001;
const GLFW_TRUE: i32 = 1;
const GLFW_FALSE: i32 = 0;
const GLFW_CURSOR: i32 = 0x00033001;
const GLFW_CURSOR_NORMAL: i32 = 0x00034001;
const GLFW_CURSOR_HIDDEN: i32 = 0x00034002;

type GLFWwindow = c_void;

extern "C" {
    fn glfwInit() -> i32;
    fn glfwTerminate();
    fn glfwWindowHint(hint: i32, value: i32);
    fn glfwCreateWindow(
        width: i32,
        height: i32,
        title: *const u8,
        monitor: *mut c_void,
        share: *mut c_void,
    ) -> *mut GLFWwindow;
    fn glfwDestroyWindow(window: *mut GLFWwindow);
    fn glfwWindowShouldClose(window: *mut GLFWwindow) -> i32;
    fn glfwMakeContextCurrent(window: *mut GLFWwindow);
    fn glfwSwapInterval(interval: i32);
    fn glfwPollEvents();
    fn glfwSwapBuffers(window: *mut GLFWwindow);
    fn glfwGetFramebufferSize(window: *mut GLFWwindow, width: *mut i32, height: *mut i32);
    fn glfwGetWindowSize(window: *mut GLFWwindow, width: *mut i32, height: *mut i32);
    fn glfwGetTime() -> f64;
    fn glfwGetKey(window: *mut GLFWwindow, key: i32) -> i32;
    fn glfwGetMouseButton(window: *mut GLFWwindow, button: i32) -> i32;
    fn glfwGetCursorPos(window: *mut GLFWwindow, xpos: *mut f64, ypos: *mut f64);
    fn glfwSetInputMode(window: *mut GLFWwindow, mode: i32, value: i32);
    fn glfwSetCharCallback(
        window: *mut GLFWwindow,
        callback: Option<extern "C" fn(*mut GLFWwindow, u32)>,
    ) -> *mut c_void;
}

struct NativeState {
    window: *mut GLFWwindow,
    start_time: f64,
}

unsafe impl Send for NativeState {}
unsafe impl Sync for NativeState {}

static STATE: Mutex<NativeState> = Mutex::new(NativeState {
    window: std::ptr::null_mut(),
    start_time: 0.0,
});

static TEXT_INPUT_QUEUE: Mutex<Vec<char>> = Mutex::new(Vec::new());

extern "C" fn char_callback(_window: *mut GLFWwindow, codepoint: u32) {
    if let Some(ch) = std::char::from_u32(codepoint) {
        TEXT_INPUT_QUEUE.lock().push(ch);
    }
}

fn native_log_sink(s: &str) {
    use std::io::Write;
    let _ = std::io::stderr().write_all(s.as_bytes());
    let _ = std::io::stderr().flush();
}

pub fn init(title: &str, w: i32, h: i32) -> bool {
    // Install log sink
    successor_engine_core::rt::log::set_sink(native_log_sink);

    unsafe {
        if glfwInit() == GLFW_FALSE {
            return false;
        }

        glfwWindowHint(GLFW_CONTEXT_VERSION_MAJOR, 3);
        glfwWindowHint(GLFW_CONTEXT_VERSION_MINOR, 3);
        glfwWindowHint(GLFW_OPENGL_PROFILE, GLFW_OPENGL_CORE_PROFILE);
        glfwWindowHint(GLFW_OPENGL_FORWARD_COMPAT, GLFW_TRUE);
        // Verification and presentation budgets use physical 1280x720 pixels.
        glfwWindowHint(GLFW_COCOA_RETINA_FRAMEBUFFER, GLFW_FALSE);

        // Check for headless/hidden environment variable
        let hidden = std::env::var("SUCCESSOR_HEADLESS").is_ok()
            || std::env::var("GLFW_VISIBLE")
                .map(|v| v == "false")
                .unwrap_or(false);

        if hidden {
            glfwWindowHint(GLFW_VISIBLE, GLFW_FALSE);
        }

        // Null-terminate title string
        let title_c =
            std::ffi::CString::new(title).unwrap_or_else(|_| std::ffi::CString::new("").unwrap());

        let win = glfwCreateWindow(
            w,
            h,
            title_c.as_ptr() as *const u8,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        );

        if win.is_null() {
            glfwTerminate();
            return false;
        }

        glfwMakeContextCurrent(win);
        glfwSwapInterval(1);

        // Set char callback for text input
        glfwSetCharCallback(win, Some(char_callback));

        let mut state = STATE.lock();
        state.window = win;
        state.start_time = glfwGetTime();

        true
    }
}

pub fn should_quit() -> bool {
    let state = STATE.lock();
    if state.window.is_null() {
        true
    } else {
        unsafe { glfwWindowShouldClose(state.window) != 0 }
    }
}

pub fn begin_frame() {
    unsafe {
        glfwPollEvents();
    }
}

pub fn end_frame() {
    let state = STATE.lock();
    if !state.window.is_null() {
        unsafe {
            glfwSwapBuffers(state.window);
        }
    }
}

pub fn deinit() {
    unsafe {
        let mut state = STATE.lock();
        if !state.window.is_null() {
            glfwDestroyWindow(state.window);
            state.window = std::ptr::null_mut();
        }
        glfwTerminate();
    }
}

pub fn framebuffer_size() -> (i32, i32) {
    let state = STATE.lock();
    if state.window.is_null() {
        (0, 0)
    } else {
        let mut w = 0;
        let mut h = 0;
        unsafe {
            glfwGetFramebufferSize(state.window, &mut w, &mut h);
        }
        (w, h)
    }
}

pub fn now_ms() -> f64 {
    let state = STATE.lock();
    unsafe { (glfwGetTime() - state.start_time) * 1000.0 }
}

pub fn is_key_down(key: Key) -> bool {
    let state = STATE.lock();
    if state.window.is_null() {
        return false;
    }
    let glfw_key = match key {
        Key::W => 87,
        Key::A => 65,
        Key::S => 83,
        Key::D => 68,
        Key::Up => 265,
        Key::Down => 264,
        Key::Left => 263,
        Key::Right => 262,
        Key::Space => 32,
        Key::Enter => 257,
        Key::Escape => 256,
        Key::Backspace => 259,
        Key::LeftShift => 340,
    };
    unsafe { glfwGetKey(state.window, glfw_key) == 1 }
}

pub fn set_cursor_visible(visible: bool) {
    let state = STATE.lock();
    if !state.window.is_null() {
        unsafe {
            glfwSetInputMode(
                state.window,
                GLFW_CURSOR,
                if visible {
                    GLFW_CURSOR_NORMAL
                } else {
                    GLFW_CURSOR_HIDDEN
                },
            );
        }
    }
}

/// Cursor position in framebuffer pixels (top-left origin). GLFW reports window
/// coordinates; on HiDPI the framebuffer is scaled, so we rescale to match
/// `framebuffer_size()`.
pub fn mouse_position() -> (f32, f32) {
    let state = STATE.lock();
    if state.window.is_null() {
        return (0.0, 0.0);
    }
    let (mut x, mut y) = (0.0f64, 0.0f64);
    let (mut ww, mut wh) = (0i32, 0i32);
    let (mut fw, mut fh) = (0i32, 0i32);
    unsafe {
        glfwGetCursorPos(state.window, &mut x, &mut y);
        glfwGetWindowSize(state.window, &mut ww, &mut wh);
        glfwGetFramebufferSize(state.window, &mut fw, &mut fh);
    }
    let sx = if ww > 0 { fw as f64 / ww as f64 } else { 1.0 };
    let sy = if wh > 0 { fh as f64 / wh as f64 } else { 1.0 };
    ((x * sx) as f32, (y * sy) as f32)
}

/// Whether the given mouse button (0 = left, 1 = right, 2 = middle) is pressed.
pub fn mouse_button_down(button: i32) -> bool {
    let state = STATE.lock();
    if state.window.is_null() {
        return false;
    }
    unsafe { glfwGetMouseButton(state.window, button) == 1 }
}

pub fn poll_text_input() -> Option<char> {
    let mut queue = TEXT_INPUT_QUEUE.lock();
    if !queue.is_empty() {
        return Some(queue.remove(0));
    }
    None
}

/// Read the current framebuffer as RGBA8, bottom-up (GL row order).
pub fn read_pixels_rgba(w: i32, h: i32) -> Vec<u8> {
    let mut buf = vec![0u8; (w.max(0) * h.max(0) * 4) as usize];
    crate::native::gl::read_pixels(
        0,
        0,
        w,
        h,
        crate::native::gl::RGBA,
        crate::native::gl::UNSIGNED_BYTE,
        &mut buf,
    );
    buf
}

/// Last GL error code (0 = none).
pub fn gl_error() -> u32 {
    crate::native::gl::get_error()
}

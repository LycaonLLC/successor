//! Platform-agnostic input codes. The platform backend maps its native key
//! identifiers (GLFW key codes / DOM `KeyboardEvent.code`) onto these, so engine
//! and game code never sees a backend-specific constant.

/// Keys the client actually consumes. `repr(u16)` so the platform can pass a
/// code across the FFI boundary and `Key::from_u16` it back.
#[repr(u16)]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Key {
    W = 0,
    A = 1,
    S = 2,
    D = 3,
    Up = 4,
    Down = 5,
    Left = 6,
    Right = 7,
    Space = 8,
    Enter = 9,
    Escape = 10,
    Backspace = 11,
    LeftShift = 12,
    Backquote = 13,
}

impl Key {
    pub const COUNT: usize = 14;

    pub fn from_u16(v: u16) -> Option<Key> {
        if (v as usize) < Key::COUNT {
            // SAFETY: bounds-checked against COUNT; the enum is a contiguous
            // 0..COUNT sequence of `u16` discriminants.
            Some(unsafe { core::mem::transmute::<u16, Key>(v) })
        } else {
            None
        }
    }
}

#[repr(u8)]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum MouseButton {
    Left = 0,
    Right = 1,
    Middle = 2,
}

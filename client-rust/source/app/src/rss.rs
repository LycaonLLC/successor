//! Peak resident-set-size sampling for the runtime memory budget.
//!
//! Uses `getrusage(RUSAGE_SELF).ru_maxrss` — in `libSystem`/`libc`, always
//! linked, no crate dependency. macOS reports bytes; Linux reports kibibytes.
//! The `_rest` padding is deliberately oversized so the kernel never writes
//! past our buffer.

#[cfg(not(target_arch = "wasm32"))]
#[repr(C)]
#[derive(Clone, Copy)]
struct Timeval {
    sec: i64,
    usec: i64,
}

#[cfg(not(target_arch = "wasm32"))]
#[repr(C)]
struct Rusage {
    ru_utime: Timeval,
    ru_stime: Timeval,
    ru_maxrss: i64,
    _rest: [i64; 32],
}

#[cfg(not(target_arch = "wasm32"))]
extern "C" {
    fn getrusage(who: i32, usage: *mut Rusage) -> i32;
}

/// Peak resident set size in bytes since process start (0 if unavailable).
#[cfg(not(target_arch = "wasm32"))]
pub fn peak_rss_bytes() -> u64 {
    // SAFETY: `Rusage` is oversized vs the real struct, so `getrusage` writes
    // within bounds; we only read the leading `ru_maxrss` field.
    unsafe {
        let mut u: Rusage = core::mem::zeroed();
        if getrusage(0 /* RUSAGE_SELF */, &mut u) != 0 {
            return 0;
        }
        let maxrss = u.ru_maxrss.max(0) as u64;
        if cfg!(target_os = "macos") {
            maxrss // bytes
        } else {
            maxrss * 1024 // kibibytes -> bytes
        }
    }
}

#[cfg(target_arch = "wasm32")]
pub fn peak_rss_bytes() -> u64 {
    0
}

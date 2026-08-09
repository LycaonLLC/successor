//! `no_std` logging with no `core::fmt`.
//!
//! The platform installs a `fn(&str)` sink at startup (`stderr` on native,
//! `console.log` on web). Numeric helpers format into a stack buffer without
//! pulling in the `core::fmt` machinery the size gate forbids.

use super::cell::GlobalCell;

static SINK: GlobalCell<fn(&str)> = GlobalCell::new();

/// Install the platform log sink.
pub fn set_sink(f: fn(&str)) {
    SINK.set(f);
}

/// Emit a raw string line (no newline appended by the engine; the sink decides).
pub fn log_str(s: &str) {
    if let Some(f) = SINK.get_mut() {
        (*f)(s);
    }
}

/// `label` then an unsigned integer, e.g. `log1u("frame-allocs ", 0)`.
pub fn log1u(label: &str, n: u64) {
    log_str(label);
    let mut buf = [0u8; 20];
    log_str(u64_to_str(n, &mut buf));
}

/// `label` then a signed integer.
pub fn log1i(label: &str, n: i64) {
    log_str(label);
    if n < 0 {
        log_str("-");
        let mut buf = [0u8; 20];
        log_str(u64_to_str(n.unsigned_abs(), &mut buf));
    } else {
        let mut buf = [0u8; 20];
        log_str(u64_to_str(n as u64, &mut buf));
    }
}

/// Format an unsigned integer into `buf`, returning the populated suffix.
pub fn u64_to_str(mut n: u64, buf: &mut [u8; 20]) -> &str {
    if n == 0 {
        buf[0] = b'0';
        // SAFETY: single ASCII digit.
        return core::str::from_utf8(&buf[..1]).unwrap();
    }
    let mut i = buf.len();
    while n > 0 {
        i -= 1;
        buf[i] = b'0' + (n % 10) as u8;
        n /= 10;
    }
    // SAFETY: bytes written are ASCII digits.
    core::str::from_utf8(&buf[i..]).unwrap()
}

#[cfg(all(test, feature = "std"))]
mod tests {
    use super::*;

    #[test]
    fn u64_formatting() {
        let mut b = [0u8; 20];
        assert_eq!(u64_to_str(0, &mut b), "0");
        let mut b = [0u8; 20];
        assert_eq!(u64_to_str(1234567890, &mut b), "1234567890");
        let mut b = [0u8; 20];
        assert_eq!(u64_to_str(u64::MAX, &mut b), "18446744073709551615");
    }
}

//! `GlobalCell<T>` — a single-threaded lazily-initialized global slot.
//!
//! The client runs one frame loop on one thread on every target (no async, no
//! worker threads touch engine state), so a non-atomic cell is sound. Marked
//! `Sync` to allow use in a `static`; callers must not share across threads.

use core::cell::UnsafeCell;

pub struct GlobalCell<T> {
    slot: UnsafeCell<Option<T>>,
}

// SAFETY: single-threaded access only (documented invariant of the frame loop).
unsafe impl<T> Sync for GlobalCell<T> {}

impl<T> GlobalCell<T> {
    pub const fn new() -> Self {
        Self {
            slot: UnsafeCell::new(None),
        }
    }

    /// Install the value. Overwrites any previous one.
    pub fn set(&self, value: T) {
        // SAFETY: single-threaded; no outstanding borrow from `get_mut`/`with`.
        unsafe {
            *self.slot.get() = Some(value);
        }
    }

    pub fn is_set(&self) -> bool {
        // SAFETY: single-threaded read.
        unsafe { (*self.slot.get()).is_some() }
    }

    /// Mutable access to the stored value, if set.
    #[allow(clippy::mut_from_ref)]
    pub fn get_mut(&self) -> Option<&mut T> {
        // SAFETY: single-threaded; caller holds no other borrow concurrently.
        unsafe { (*self.slot.get()).as_mut() }
    }

    /// Run `f` with a mutable borrow if the value is set.
    pub fn with<R>(&self, f: impl FnOnce(&mut T) -> R) -> Option<R> {
        self.get_mut().map(f)
    }
}

impl<T> Default for GlobalCell<T> {
    fn default() -> Self {
        Self::new()
    }
}

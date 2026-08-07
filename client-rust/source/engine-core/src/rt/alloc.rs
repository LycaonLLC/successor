//! Allocation counter. When the `alloc-count` feature is on, the app installs
//! [`CountingAllocator`] as the `#[global_allocator]`; the demo resets the
//! counter each frame start and reads it at frame end to prove zero
//! steady-state per-frame allocations. With the feature off, the counter API
//! is a zero-cost no-op so app/demo code compiles unconditionally.

use core::sync::atomic::{AtomicUsize, Ordering};

static ALLOC_COUNT: AtomicUsize = AtomicUsize::new(0);

/// Total live allocation calls since the last [`reset_alloc_count`].
#[inline]
pub fn alloc_count() -> u64 {
    ALLOC_COUNT.load(Ordering::Relaxed) as u64
}
/// Reset the per-frame counter (call at frame start).
#[inline]
pub fn reset_alloc_count() {
    ALLOC_COUNT.store(0, Ordering::Relaxed);
}

/// Record one allocation. Called by [`CountingAllocator::alloc`] when the
/// feature is enabled; exposed so tests can exercise the counter without a
/// global allocator swap.
#[inline]
pub fn record_alloc() {
    ALLOC_COUNT.fetch_add(1, Ordering::Relaxed);
}

#[cfg(feature = "alloc-count")]
mod counting {
    use super::record_alloc;
    use core::alloc::{GlobalAlloc, Layout};

    /// Global-allocator wrapper that counts `alloc`/`realloc` calls. Install in
    /// the app with `#[global_allocator] static A: CountingAllocator<System> = …`.
    pub struct CountingAllocator<A> {
        pub inner: A,
    }

    impl<A> CountingAllocator<A> {
        pub const fn new(inner: A) -> Self {
            Self { inner }
        }
    }

    // SAFETY: forwards verbatim to the wrapped allocator; only adds a relaxed
    // atomic increment on the allocating paths.
    unsafe impl<A: GlobalAlloc> GlobalAlloc for CountingAllocator<A> {
        unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
            record_alloc();
            self.inner.alloc(layout)
        }
        unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
            self.inner.dealloc(ptr, layout);
        }
        unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
            record_alloc();
            self.inner.realloc(ptr, layout, new_size)
        }
    }
}

#[cfg(feature = "alloc-count")]
pub use counting::CountingAllocator;

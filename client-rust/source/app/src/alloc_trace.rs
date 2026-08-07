//! Allocation tracing (native, `alloc-count` only). The app installs
//! [`TraceAllocator`] as the global allocator in place of the plain counting
//! wrapper; it forwards every allocation to the same `record_alloc` counter,
//! and — only when `SUCCESSOR_ALLOC_TRACE=1` is set in the environment —
//! captures a backtrace per allocation and aggregates counts by call stack.
//! With the variable unset the only added cost over the counting wrapper is
//! one relaxed branch per allocation, so the steady-state alloc gates stay
//! exact. Trace runs themselves are *not* count-accurate (capture allocates;
//! the re-entrancy guard keeps it finite), they exist to name call sites.

#[cfg(all(feature = "alloc-count", not(target_arch = "wasm32")))]
mod imp {
    use std::alloc::{GlobalAlloc, Layout, System};
    use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};

    use successor_engine_core::rt::alloc::record_alloc;

    /// Backtrace capture is impossible inside a global allocator (std's
    /// backtrace init touches TLS that allocates → abort), so the trace hook
    /// records a *size histogram* instead: exact byte sizes 0..=512 plus a
    /// power-of-two bucket table above that, in fixed statics (no heap, no
    /// TLS, no env read — nothing that can re-enter the allocator). Recording
    /// is unconditional under `alloc-count` (two relaxed atomics, same order
    /// as the existing counter); `SUCCESSOR_ALLOC_TRACE=1` gates only the
    /// dump. Match the reported sizes to call sites by code inspection.
    const EXACT_SIZES: usize = 513;
    /// 512..=2^41 in power-of-two buckets.
    const BUCKETS: usize = 33;

    static EXACT: [AtomicU64; EXACT_SIZES] = {
        const ZERO: AtomicU64 = AtomicU64::new(0);
        [ZERO; EXACT_SIZES]
    };
    static BUCKET: [AtomicU64; BUCKETS] = {
        const ZERO: AtomicU64 = AtomicU64::new(0);
        [ZERO; BUCKETS]
    };
    /// Cumulative histogram for frames the caller flagged as steady-state
    /// (via [`absorb_frame`]); the dump reads this, not the live frame table.
    static STEADY_EXACT: [AtomicU64; EXACT_SIZES] = {
        const ZERO: AtomicU64 = AtomicU64::new(0);
        [ZERO; EXACT_SIZES]
    };
    static STEADY_BUCKET: [AtomicU64; BUCKETS] = {
        const ZERO: AtomicU64 = AtomicU64::new(0);
        [ZERO; BUCKETS]
    };
    /// First/last absorbed frame numbers (0 = none) and absorbed frame count,
    /// so the dump shows whether a source is continuous or a bounded phase.
    static FIRST_FRAME: AtomicU64 = AtomicU64::new(0);
    static LAST_FRAME: AtomicU64 = AtomicU64::new(0);
    static FRAMES_WITH_ALLOCS: AtomicU64 = AtomicU64::new(0);

    /// Armed at the start of the steady window (main.rs calls [`arm_trace`]);
    /// breakpoints on [`capture`] then hit only steady-state allocations.
    /// `#[no_mangle]` so debugger breakpoint conditions can read it as
    /// plain `SUCCESSOR_TRACE_ARMED`.
    // Plain value (not atomic) so debugger breakpoint conditions read it
    // directly; the frame loop is single-threaded, so a torn/missed read on a
    // foreign allocating thread is benign for diagnostics.
    #[no_mangle]
    pub static mut SUCCESSOR_TRACE_ARMED: u64 = 0;

    /// Set while the connected `scene.frame()` body executes (alloc-count
    /// diagnostic builds). Chain recording is restricted to this window so the
    /// dump names exactly the allocations the connected gate counts.
    #[no_mangle]
    pub static mut SUCCESSOR_SCENE_ACTIVE: u64 = 0;

    /// Enable tracing (steady window start).
    pub fn arm_trace() {
        unsafe { SUCCESSOR_TRACE_ARMED = 1 };
    }

    /// Mark scene-frame entry/exit for chain capture.
    pub fn scene_active(active: bool) {
        unsafe { SUCCESSOR_SCENE_ACTIVE = u64::from(active) };
    }

    #[inline(never)]
    fn capture(size: usize) {
        if unsafe { SUCCESSOR_TRACE_ARMED } == 0 {
            return;
        }
        if size < EXACT_SIZES {
            EXACT[size].fetch_add(1, Ordering::Relaxed);
        } else {
            let log2 = (usize::BITS - size.leading_zeros()) as usize; // floor(log2(size))+1
            let index = log2.saturating_sub(9).min(BUCKETS - 1);
            BUCKET[index].fetch_add(1, Ordering::Relaxed);
        }
        #[cfg(target_arch = "aarch64")]
        if unsafe { SUCCESSOR_SCENE_ACTIVE } != 0 {
            record_chain(size);
        }
    }

    // --- diagnostic: frame-pointer callchain capture (aarch64) ---
    // Walks x29 without allocation or TLS; requires
    // `-C force-frame-pointers=yes`. Offline-symbolicated from the exit dump.

    const CHAIN_DEPTH: usize = 8;
    const CHAIN_SLOTS: usize = 48;

    struct ChainEntry {
        pcs: [usize; CHAIN_DEPTH],
        depth: u8,
        count: u64,
        sizes: [u64; 8],
    }

    static mut CHAINS: [ChainEntry; CHAIN_SLOTS] = [const {
        ChainEntry {
            pcs: [0; CHAIN_DEPTH],
            depth: 0,
            count: 0,
            sizes: [0; 8],
        }
    }; CHAIN_SLOTS];
    static CHAIN_LEN: AtomicUsize = AtomicUsize::new(0);

    #[cfg(target_arch = "aarch64")]
    unsafe fn walk_frames(out: &mut [usize; CHAIN_DEPTH]) -> usize {
        let mut fp: usize;
        unsafe { core::arch::asm!("mov {}, x29", out(reg) fp) };
        let mut n = 0usize;
        while n < CHAIN_DEPTH && fp != 0 {
            let lr = unsafe { *((fp + 8) as *const usize) };
            if lr == 0 {
                break;
            }
            out[n] = lr;
            n += 1;
            fp = unsafe { *(fp as *const usize) };
        }
        n
    }

    #[cfg(target_arch = "aarch64")]
    fn record_chain(size: usize) {
        let mut pcs = [0usize; CHAIN_DEPTH];
        let depth = unsafe { walk_frames(&mut pcs) };
        let key = pcs[0] ^ pcs[1].rotate_left(13) ^ pcs[2].rotate_left(27);
        unsafe {
            let len = CHAIN_LEN.load(Ordering::Relaxed);
            for i in 0..len {
                let entry = &mut CHAINS[i];
                let ekey =
                    entry.pcs[0] ^ entry.pcs[1].rotate_left(13) ^ entry.pcs[2].rotate_left(27);
                if ekey == key && entry.pcs[..3] == pcs[..3] {
                    entry.count += 1;
                    let slot = ((usize::BITS - size.leading_zeros()) as usize).min(7);
                    entry.sizes[slot] += 1;
                    return;
                }
            }
            if len < CHAIN_SLOTS {
                let entry = &mut CHAINS[len];
                entry.pcs = pcs;
                entry.depth = depth as u8;
                entry.count = 1;
                let slot = ((usize::BITS - size.leading_zeros()) as usize).min(7);
                entry.sizes[slot] += 1;
                CHAIN_LEN.store(len + 1, Ordering::Relaxed);
            }
        }
    }

    /// Global-allocator wrapper: counting semantics identical to
    /// `CountingAllocator`, plus env-gated backtrace capture.
    pub struct TraceAllocator;

    // SAFETY: forwards verbatim to the system allocator; adds a relaxed atomic
    // increment and an env-gated, re-entrancy-guarded backtrace capture.
    unsafe impl GlobalAlloc for TraceAllocator {
        unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
            record_alloc();
            capture(layout.size());
            System.alloc(layout)
        }
        unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
            System.dealloc(ptr, layout);
        }
        unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
            record_alloc();
            capture(new_size);
            System.realloc(ptr, layout, new_size)
        }
    }

    /// Zero the per-frame histogram (same reset point as `reset_alloc_count`).
    pub fn reset_histogram() {
        for cell in EXACT.iter() {
            cell.store(0, Ordering::Relaxed);
        }
        for cell in BUCKET.iter() {
            cell.store(0, Ordering::Relaxed);
        }
    }

    /// Fold the per-frame table into the steady cumulative table. Called when
    /// a frame inside the counted steady window allocated, so the exit dump
    /// names every steady-state source, intermittent ones included.
    pub fn absorb_frame(frame: u64) {
        FRAMES_WITH_ALLOCS.fetch_add(1, Ordering::Relaxed);
        let mut first = FIRST_FRAME.load(Ordering::Relaxed);
        while first == 0 || frame < first {
            match FIRST_FRAME.compare_exchange(first, frame, Ordering::Relaxed, Ordering::Relaxed) {
                Ok(_) => break,
                Err(current) => first = current,
            }
        }
        LAST_FRAME.fetch_max(frame, Ordering::Relaxed);
        for (index, cell) in EXACT.iter().enumerate() {
            let count = cell.load(Ordering::Relaxed);
            if count > 0 {
                STEADY_EXACT[index].fetch_add(count, Ordering::Relaxed);
            }
        }
        for (index, cell) in BUCKET.iter().enumerate() {
            let count = cell.load(Ordering::Relaxed);
            if count > 0 {
                STEADY_BUCKET[index].fetch_add(count, Ordering::Relaxed);
            }
        }
    }

    /// Print the recorded allocation-size histogram to stderr. No-op unless
    /// `SUCCESSOR_ALLOC_TRACE=1` is set.
    pub fn dump_alloc_trace(_top: usize) {
        if std::env::var_os("SUCCESSOR_ALLOC_TRACE").is_none() {
            return;
        }
        eprintln!(
            "=== alloc trace: steady-window size histogram (frames with allocs: {}, first {}, last {}) ===",
            FRAMES_WITH_ALLOCS.load(Ordering::Relaxed),
            FIRST_FRAME.load(Ordering::Relaxed),
            LAST_FRAME.load(Ordering::Relaxed)
        );
        for (size, cell) in STEADY_EXACT.iter().enumerate() {
            let count = cell.load(Ordering::Relaxed);
            if count > 0 {
                eprintln!("{count:>10} x {size}B");
            }
        }
        #[cfg(target_arch = "aarch64")]
        unsafe {
            eprintln!(
                "=== alloc trace: callchains (anchor record_chain={:#x}) ===",
                record_chain as *const () as usize
            );
            let len = CHAIN_LEN.load(Ordering::Relaxed);
            let mut idx: Vec<usize> = (0..len).collect();
            idx.sort_by_key(|i| core::cmp::Reverse(CHAINS[*i].count));
            for i in idx.iter().take(8) {
                let e = &CHAINS[*i];
                eprintln!(
                    "count={} sizes={:?} pcs={:?}",
                    e.count,
                    e.sizes,
                    &e.pcs[..e.depth as usize]
                );
            }
        }
        for (index, cell) in STEADY_BUCKET.iter().enumerate() {
            let count = cell.load(Ordering::Relaxed);
            if count > 0 {
                eprintln!(
                    "{count:>10} x {}B..{}B",
                    1usize << (index + 9),
                    1usize << (index + 10)
                );
            }
        }
    }
}

#[cfg(all(feature = "alloc-count", not(target_arch = "wasm32")))]
pub use imp::{absorb_frame, arm_trace, dump_alloc_trace, reset_histogram, scene_active, TraceAllocator};

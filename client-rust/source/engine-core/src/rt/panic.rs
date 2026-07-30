//! Optional bare-metal panic handler.
//!
//! Our shipping artifacts are `std` at the app layer (native binary and the
//! wasm cdylib), so `std` supplies the panic handler and this file contributes
//! nothing to them. It exists for a future genuinely-`no_std` embedding (e.g. a
//! bare-metal `thumbv7em` *binary*), enabled by the off-by-default
//! `panic-handler` feature. The `nostd` build gate compiles the engine crates
//! as libraries, which need no handler, so that gate never enables this.

#[cfg(all(not(feature = "std"), feature = "panic-handler"))]
#[panic_handler]
fn panic(_info: &core::panic::PanicInfo) -> ! {
    // No unwinding in no_std; spin. A real embedder would reset or trap.
    loop {
        core::hint::spin_loop();
    }
}

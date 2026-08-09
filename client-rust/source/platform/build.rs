// Native link flags for the desktop backend. Web (wasm32) links nothing here:
// its GL/WebSocket/fetch surface is satisfied by the JS shim at runtime.
//
// macOS: Homebrew GLFW + Apple frameworks (mirrors
// ~/code/sandbox/voxel_engine/source/engine/build.rs). Linux: pkg-config glfw3
// plus the system GL loader.

fn main() {
    let target_arch = std::env::var("CARGO_CFG_TARGET_ARCH").unwrap_or_default();
    if target_arch == "wasm32" {
        return;
    }
    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    match target_os.as_str() {
        "macos" => {
            // Homebrew default prefixes (Apple Silicon then Intel).
            println!("cargo:rustc-link-search=native=/opt/homebrew/lib");
            println!("cargo:rustc-link-search=native=/usr/local/lib");
            println!("cargo:rustc-link-lib=glfw");
            println!("cargo:rustc-link-lib=framework=OpenGL");
            println!("cargo:rustc-link-lib=framework=Cocoa");
            println!("cargo:rustc-link-lib=framework=IOKit");
            println!("cargo:rustc-link-lib=framework=CoreFoundation");
            println!("cargo:rustc-link-lib=framework=CoreVideo");
        }
        "linux" => {
            // Prefer pkg-config; fall back to bare -lglfw -lGL.
            if pkg_config_glfw().is_err() {
                println!("cargo:rustc-link-lib=glfw");
            }
            println!("cargo:rustc-link-lib=GL");
        }
        other => {
            println!("cargo:warning=successor-platform: unhandled target_os `{other}`; no GL link flags emitted");
        }
    }
}

#[cfg(not(target_arch = "wasm32"))]
fn pkg_config_glfw() -> Result<(), ()> {
    let out = std::process::Command::new("pkg-config")
        .args(["--libs", "glfw3"])
        .output()
        .map_err(|_| ())?;
    if !out.status.success() {
        return Err(());
    }
    let flags = String::from_utf8_lossy(&out.stdout);
    for tok in flags.split_whitespace() {
        if let Some(dir) = tok.strip_prefix("-L") {
            println!("cargo:rustc-link-search=native={dir}");
        } else if let Some(lib) = tok.strip_prefix("-l") {
            println!("cargo:rustc-link-lib={lib}");
        }
    }
    Ok(())
}

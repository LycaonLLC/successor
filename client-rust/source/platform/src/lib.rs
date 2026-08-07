//! Successor Rust client — platform backend.

#[cfg(not(target_arch = "wasm32"))]
pub mod native;

#[cfg(target_arch = "wasm32")]
pub mod web;

pub mod gl_gpu;

// Common GPU re-exports
pub use gl_gpu::GlGpu;

pub fn create_gpu() -> GlGpu {
    GlGpu::new()
}

/// Stable platform-facing contracts shared by native and WebGL2 shells.
/// Gameplay and rendering code must not access filesystem/DOM/GL directly.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AppMode {
    Entry,
    CharacterSelect,
    Loading,
    Connected,
    Fatal,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SettingsScope {
    Local,
    Account,
    Character,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AssetError {
    MissingRequired(&'static str),
    InvalidId,
    Unreadable,
}

/// Opaque handle for an in-flight asynchronous asset request.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct AssetHandle(pub u64);

/// Poll result for an asynchronous asset request.
#[derive(Debug)]
pub enum AssetPoll {
    Pending,
    Ready(Vec<u8>),
    Failed,
}

/// Services required by the renderer-neutral application state machine.
pub trait Platform {
    fn monotonic_ms(&self) -> u64;
    fn logical_size(&self) -> (u32, u32);
    fn read_asset(&self, stable_id: &str) -> Result<Vec<u8>, AssetError>;
    /// Begin an asynchronous fetch of `stable_id`. `None` means the backend
    /// has no async channel; callers then fall back to `read_asset`.
    fn begin_asset(&mut self, _stable_id: &str) -> Option<AssetHandle> {
        None
    }
    /// Poll a handle previously returned by `begin_asset`.
    fn poll_asset(&mut self, _handle: AssetHandle) -> AssetPoll {
        AssetPoll::Failed
    }
    fn load_settings(&self, scope: SettingsScope) -> Option<Vec<u8>>;
    fn save_settings(&mut self, scope: SettingsScope, bytes: &[u8]) -> Result<(), String>;
    fn report_fatal(&mut self, message: &str);
}

#[cfg(not(target_arch = "wasm32"))]
pub struct NativePlatform {
    pub asset_root: std::path::PathBuf,
    pub settings_root: std::path::PathBuf,
    /// Completed immediate reads awaiting `poll_asset`.
    pub asset_requests: std::collections::HashMap<u64, Result<Vec<u8>, AssetError>>,
    pub next_asset_handle: u64,
}

#[cfg(not(target_arch = "wasm32"))]
impl Platform for NativePlatform {
    fn monotonic_ms(&self) -> u64 {
        now_ms().max(0.0) as u64
    }
    fn logical_size(&self) -> (u32, u32) {
        let (width, height) = framebuffer_size();
        (width.max(0) as u32, height.max(0) as u32)
    }
    fn read_asset(&self, stable_id: &str) -> Result<Vec<u8>, AssetError> {
        if stable_id.is_empty() || stable_id.contains("..") || stable_id.starts_with('/') {
            return Err(AssetError::InvalidId);
        }
        let relative = if stable_id.starts_with("assets/") {
            std::path::PathBuf::from("client-3d/public").join(stable_id)
        } else if let Some(path) = stable_id.strip_prefix("successor-slice/") {
            std::path::PathBuf::from("client/public/successor-slice").join(path)
        } else if let Some(path) = stable_id.strip_prefix("successor-audio/") {
            std::path::PathBuf::from("client/public/successor-audio").join(path)
        } else if let Some(path) = stable_id.strip_prefix("render/") {
            std::path::PathBuf::from("client-3d/src/render").join(path)
        } else {
            return Err(AssetError::InvalidId);
        };
        let path = self.asset_root.join(relative);
        fs_read(path.to_str().ok_or(AssetError::InvalidId)?).map_err(|_| AssetError::Unreadable)
    }
    /// Native "async" is immediate: local disk reads are fast, so begin
    /// resolves inline and the first poll delivers the bytes.
    fn begin_asset(&mut self, stable_id: &str) -> Option<AssetHandle> {
        self.next_asset_handle = self.next_asset_handle.max(1);
        let handle = AssetHandle(self.next_asset_handle);
        self.next_asset_handle += 1;
        let result = self.read_asset(stable_id);
        self.asset_requests.insert(handle.0, result);
        Some(handle)
    }
    fn poll_asset(&mut self, handle: AssetHandle) -> AssetPoll {
        match self.asset_requests.remove(&handle.0) {
            Some(Ok(bytes)) => AssetPoll::Ready(bytes),
            Some(Err(_)) | None => AssetPoll::Failed,
        }
    }
    fn load_settings(&self, scope: SettingsScope) -> Option<Vec<u8>> {
        let name = match scope {
            SettingsScope::Local => "local",
            SettingsScope::Account => "account",
            SettingsScope::Character => "character",
        };
        fs_read(self.settings_root.join(format!("{name}.json")).to_str()?).ok()
    }
    fn save_settings(&mut self, scope: SettingsScope, bytes: &[u8]) -> Result<(), String> {
        let name = match scope {
            SettingsScope::Local => "local",
            SettingsScope::Account => "account",
            SettingsScope::Character => "character",
        };
        fs_write_atomic(
            self.settings_root
                .join(format!("{name}.json"))
                .to_str()
                .ok_or("invalid settings path")?,
            bytes,
        )
    }
    fn report_fatal(&mut self, message: &str) {
        eprintln!("fatal launch: {message}");
    }
}

#[cfg(target_arch = "wasm32")]
pub struct WebPlatform;

#[cfg(target_arch = "wasm32")]
impl Platform for WebPlatform {
    fn monotonic_ms(&self) -> u64 {
        now_ms().max(0.0) as u64
    }
    fn logical_size(&self) -> (u32, u32) {
        let (width, height) = framebuffer_size();
        (width.max(0) as u32, height.max(0) as u32)
    }
    fn read_asset(&self, stable_id: &str) -> Result<Vec<u8>, AssetError> {
        http_get(stable_id).map_err(|_| AssetError::Unreadable)
    }
    fn begin_asset(&mut self, stable_id: &str) -> Option<AssetHandle> {
        web::net::asset_begin(stable_id).map(|id| AssetHandle(id as u64))
    }
    fn poll_asset(&mut self, handle: AssetHandle) -> AssetPoll {
        web::net::asset_poll(handle.0 as u32)
    }
    fn load_settings(&self, _scope: SettingsScope) -> Option<Vec<u8>> {
        None
    }
    fn save_settings(&mut self, _scope: SettingsScope, _bytes: &[u8]) -> Result<(), String> {
        Ok(())
    }
    fn report_fatal(&mut self, _message: &str) {}
}
#[cfg(not(target_arch = "wasm32"))]
pub use native::control::{
    configure as configure_control, publish_control_status, shutdown as shutdown_control,
    take_ui_intents, ControlConfig, ControlMovementStatus, ControlStatus, ControlStatusV2,
    ControlUiIntent, ControlWindowFrame, DEFAULT_CONTROL_PORT,
};

// target-specific re-exports of free-function surface
#[cfg(not(target_arch = "wasm32"))]
pub use native::window::{
    begin_frame, deinit, end_frame, framebuffer_size, gl_error, init, is_key_down,
    mouse_button_down, mouse_position, now_ms, poll_scroll_delta, poll_text_input,
    read_pixels_rgba, set_cursor_visible, should_quit, window_focused,
};

#[cfg(target_arch = "wasm32")]
pub use web::{
    begin_frame, deinit, end_frame, framebuffer_size, init, is_key_down, mouse_button_down,
    mouse_position, now_ms, poll_scroll_delta, poll_text_input, read_pixels_rgba,
    set_cursor_visible, should_quit,
};

// Network transport re-exports
#[cfg(not(target_arch = "wasm32"))]
pub use native::audio::{AudioOutput, FillFn};
#[cfg(not(target_arch = "wasm32"))]
pub use native::fs::{fs_exists, fs_read, fs_write_atomic};
#[cfg(not(target_arch = "wasm32"))]
pub use native::http::{http_get, http_post_json};
#[cfg(not(target_arch = "wasm32"))]
pub use native::net::{ws_connect, ws_poll, ws_send, WsEvent, WsHandle};

#[cfg(target_arch = "wasm32")]
pub use web::net::{http_get, http_post_json};
#[cfg(target_arch = "wasm32")]
pub use web::net::{ws_connect, ws_poll, ws_send, WsEvent, WsHandle};

#[cfg(all(test, not(target_arch = "wasm32")))]
mod tests {
    use super::*;

    #[test]
    fn native_async_channel_resolves_immediately() {
        let root = std::env::temp_dir().join(format!("successor-platform-test-{}", std::process::id()));
        let asset_dir = root.join("client-3d/public/assets/test");
        std::fs::create_dir_all(&asset_dir).expect("create asset dir");
        std::fs::write(asset_dir.join("probe.bin"), b"probe-bytes").expect("write asset");
        let mut platform = NativePlatform {
            asset_root: root.clone(),
            settings_root: root.join("settings"),
            asset_requests: std::collections::HashMap::new(),
            next_asset_handle: 0,
        };
        let handle = platform
            .begin_asset("assets/test/probe.bin")
            .expect("native channel always begins");
        match platform.poll_asset(handle) {
            AssetPoll::Ready(bytes) => assert_eq!(bytes, b"probe-bytes"),
            _ => panic!("native first poll must deliver bytes"),
        }
        // Consumed handles fail closed; distinct ids get distinct handles.
        assert!(matches!(platform.poll_asset(handle), AssetPoll::Failed));
        let second = platform.begin_asset("assets/test/probe.bin").expect("re-begin");
        assert_ne!(handle, second);
        let missing = platform.begin_asset("assets/test/absent.bin").expect("begin succeeds");
        assert!(matches!(platform.poll_asset(missing), AssetPoll::Failed));
        std::fs::remove_dir_all(&root).ok();
    }
}

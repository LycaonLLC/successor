//! Web WebSocket and fetch transport implementation.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WsEvent {
    Open,
    Frame(usize),
    Closed,
    Error,
    None,
}

pub struct WsHandle {
    pub(crate) id: u32,
}

#[link(wasm_import_module = "env")]
extern "C" {
    fn js_ws_connect(url_ptr: *const u8, url_len: u32) -> u32;
    fn js_ws_send(id: u32, data_ptr: *const u8, data_len: u32);
    fn js_ws_poll(id: u32, buf_ptr: *mut u8, max_len: u32) -> i32;
    #[allow(dead_code)]
    fn js_ws_close(id: u32);

    fn js_fetch_post_json(
        url_ptr: *const u8,
        url_len: u32,
        body_ptr: *const u8,
        body_len: u32,
        out_buf_ptr: *mut u8,
        out_buf_max_len: u32,
    ) -> i32;

    // Two-phase blob fetch: call with a null/zero buffer to learn the total
    // length, then call again with an allocated buffer to copy. Returns the
    // resource's total byte length on success (>=0), or -1 on error. The shim
    // caches the last fetched url so the network hit happens once.
    fn js_fetch_get(
        url_ptr: *const u8,
        url_len: u32,
        out_buf_ptr: *mut u8,
        out_buf_max_len: u32,
    ) -> i32;

    // Async asset channel. begin starts a shim-side fetch (pack-index and
    // object-store aware, exactly like js_fetch_get's fallback chain) and
    // returns a nonzero handle, or 0 when the request cannot start. poll
    // mirrors the two-phase protocol with one extra state: -1 pending,
    // -2 failed, >=0 ready (byte length).
    fn js_asset_begin(path_ptr: *const u8, path_len: u32) -> u32;
    fn js_asset_poll(id: u32, out_buf_ptr: *mut u8, out_buf_max_len: u32) -> i32;
}

pub fn ws_connect(url_str: &str) -> Result<WsHandle, String> {
    let id = unsafe { js_ws_connect(url_str.as_ptr(), url_str.len() as u32) };
    if id == 0 {
        Err("Failed to connect WebSocket".to_string())
    } else {
        Ok(WsHandle { id })
    }
}

pub fn ws_send(handle: &mut WsHandle, data: &[u8]) {
    unsafe {
        js_ws_send(handle.id, data.as_ptr(), data.len() as u32);
    }
}

pub fn ws_poll(handle: &mut WsHandle, out_buf: &mut Vec<u8>) -> WsEvent {
    let capacity = out_buf.capacity();
    if capacity < 65536 {
        out_buf.reserve(65536 - capacity);
    }

    let spare_ptr = out_buf.as_mut_ptr();
    let res = unsafe { js_ws_poll(handle.id, spare_ptr, 65536) };

    match res {
        0 => WsEvent::None,
        -1 => WsEvent::Closed,
        -2 => WsEvent::Error,
        -3 => WsEvent::Open,
        len if len > 0 => {
            unsafe {
                out_buf.set_len(len as usize);
            }
            WsEvent::Frame(len as usize)
        }
        _ => WsEvent::Error,
    }
}

pub fn http_post_json(url_str: &str, body: &[u8]) -> Result<Vec<u8>, String> {
    let mut out_buf = vec![0u8; 65536];
    let res = unsafe {
        js_fetch_post_json(
            url_str.as_ptr(),
            url_str.len() as u32,
            body.as_ptr(),
            body.len() as u32,
            out_buf.as_mut_ptr(),
            out_buf.len() as u32,
        )
    };
    if res < 0 {
        Err(format!("fetch_post_json failed with code {}", res))
    } else {
        out_buf.truncate(res as usize);
        Ok(out_buf)
    }
}

/// HTTP GET returning the raw response body via the two-phase shim protocol.
pub fn http_get(url_str: &str) -> Result<Vec<u8>, String> {
    let total = unsafe {
        js_fetch_get(
            url_str.as_ptr(),
            url_str.len() as u32,
            core::ptr::null_mut(),
            0,
        )
    };
    if total < 0 {
        return Err(format!("fetch_get failed for {url_str}"));
    }
    let mut buf = vec![0u8; total as usize];
    let written = unsafe {
        js_fetch_get(
            url_str.as_ptr(),
            url_str.len() as u32,
            buf.as_mut_ptr(),
            buf.len() as u32,
        )
    };
    if written < 0 {
        return Err(format!("fetch_get copy failed for {url_str}"));
    }
    buf.truncate(written as usize);
    Ok(buf)
}

/// Start an asynchronous fetch of `stable_id`; `None` when the shim cannot
/// start the request.
pub fn asset_begin(stable_id: &str) -> Option<u32> {
    let id = unsafe { js_asset_begin(stable_id.as_ptr(), stable_id.len() as u32) };
    if id == 0 {
        None
    } else {
        Some(id)
    }
}

/// Poll an in-flight async fetch; on `Ready` the bytes are copied out and the
/// shim-side entry is consumed.
pub fn asset_poll(id: u32) -> crate::AssetPoll {
    let total = unsafe { js_asset_poll(id, core::ptr::null_mut(), 0) };
    if total == -1 {
        return crate::AssetPoll::Pending;
    }
    if total < 0 {
        return crate::AssetPoll::Failed;
    }
    let mut buf = vec![0u8; total as usize];
    let written = unsafe { js_asset_poll(id, buf.as_mut_ptr(), total as u32) };
    if written < 0 {
        return crate::AssetPoll::Failed;
    }
    buf.truncate(written as usize);
    crate::AssetPoll::Ready(buf)
}

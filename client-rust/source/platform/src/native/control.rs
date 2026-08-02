//! Developer-only loopback control, input recording, and deterministic replay.
//!
//! The server is disabled unless explicitly configured. While a client is
//! connected (or a remote key/button remains held), remote input replaces local
//! GLFW input. Requests and responses are newline-delimited so a tiny CLI can
//! drive the client from argv or stdin without an SDK.

use parking_lot::Mutex;
use std::collections::VecDeque;
use std::fs::File;
use std::io::{Read, Write};
use std::net::{Ipv4Addr, SocketAddrV4, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::LazyLock;
use successor_engine_core::input::Key;

pub const DEFAULT_CONTROL_PORT: u16 = 47_778;
pub const RECORDING_HEADER: &str = "successor.input.v1";
const MAX_REQUEST_BUFFER: usize = 16 * 1024;
const MOUSE_BUTTON_COUNT: usize = 3;

static CONFIGURED: AtomicBool = AtomicBool::new(false);
static CONTROL: LazyLock<Mutex<ControlState>> = LazyLock::new(|| Mutex::new(ControlState::new()));

#[derive(Clone, Debug, Default)]
pub struct ControlConfig {
    pub port: Option<u16>,
    pub record_path: Option<PathBuf>,
    pub replay_path: Option<PathBuf>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ControlStatus {
    pub listen_port: Option<u16>,
    pub replaying: bool,
    pub recording: bool,
}

/// Secret-free status payload contract. Values are owned so the status can be
/// published from the connected frame without borrowing runtime state.
#[derive(Clone, Debug, Default)]
pub struct ControlStatusV2 {
    pub frame: u64,
    pub framebuffer: Option<(u32, u32)>,
    pub app_mode: Option<String>,
    pub game_connection: String,
    pub chat_connection: String,
    pub shard: Option<String>,
    pub tick: Option<u64>,
    pub area: Option<String>,
    pub source_hashes: Vec<String>,
    pub player_actor_id: Option<String>,
    pub player_position: Option<(f32, f32)>,
    pub life: Option<String>,
    pub selection: Option<String>,
    pub windows: Vec<String>,
    pub focused_window: Option<String>,
    pub pending_command_kinds: Vec<String>,
    pub last_receipt: Option<String>,
    pub renderer_degradation_ids: Vec<String>,
}
#[derive(Clone, Debug)]
pub struct NativeInputSnapshot {
    pub keys: [bool; Key::COUNT],
    pub mouse_position: (f32, f32),
    pub mouse_buttons: [bool; MOUSE_BUTTON_COUNT],
    pub text: Vec<char>,
    pub scroll: (f32, f32),
}

impl Default for NativeInputSnapshot {
    fn default() -> Self {
        Self {
            keys: [false; Key::COUNT],
            mouse_position: (0.0, 0.0),
            mouse_buttons: [false; MOUSE_BUTTON_COUNT],
            text: Vec::new(),
            scroll: (0.0, 0.0),
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
enum Command {
    Key { key: Key, action: KeyAction },
    MouseMove { relative: bool, x: f32, y: f32 },
    MouseButton { button: usize, pressed: bool },
    Text(String),
    Scroll(f32, f32),
    Screenshot(PathBuf),
    RecordStart(PathBuf),
    RecordStop,
    Status,
    Quit,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum KeyAction {
    Down,
    Up,
    Tap,
}

#[derive(Clone, Debug)]
struct ReplayEvent {
    frame: u64,

    command: Command,
}

struct Recorder {
    file: File,
    start_frame: u64,
    native_keys: [bool; Key::COUNT],
    native_mouse_position: (f32, f32),
    native_mouse_buttons: [bool; MOUSE_BUTTON_COUNT],
}

struct PendingWrite {
    bytes: Vec<u8>,
    sent: usize,
}
#[derive(Clone, Debug)]
pub struct ScreenshotRequest {
    pub sequence: u64,
    pub path: PathBuf,
}

struct ControlState {
    listener: Option<TcpListener>,
    listen_port: Option<u16>,
    client: Option<TcpStream>,
    receive: Vec<u8>,
    writes: VecDeque<PendingWrite>,
    frame: u64,
    latest_status: ControlStatusV2,
    remote_keys: [bool; Key::COUNT],
    remote_mouse_position: (f32, f32),
    remote_mouse_buttons: [bool; MOUSE_BUTTON_COUNT],
    release_frame: [u64; Key::COUNT],
    native: NativeInputSnapshot,
    text: VecDeque<char>,
    scroll: (f32, f32),
    screenshot_requests: VecDeque<ScreenshotRequest>,
    recorder: Option<Recorder>,
    replay: Vec<ReplayEvent>,
    replay_index: usize,
    replaying: bool,
    quit_requested: bool,
}

impl ControlState {
    fn new() -> Self {
        Self {
            listener: None,
            listen_port: None,
            client: None,
            receive: Vec::with_capacity(4096),
            writes: VecDeque::new(),
            frame: 0,
            latest_status: ControlStatusV2::default(),
            remote_keys: [false; Key::COUNT],
            remote_mouse_position: (0.0, 0.0),
            remote_mouse_buttons: [false; MOUSE_BUTTON_COUNT],
            release_frame: [u64::MAX; Key::COUNT],
            native: NativeInputSnapshot::default(),
            text: VecDeque::new(),
            scroll: (0.0, 0.0),
            screenshot_requests: VecDeque::new(),
            recorder: None,
            replay: Vec::new(),
            replay_index: 0,
            replaying: false,
            quit_requested: false,
        }
    }

    fn override_active(&self) -> bool {
        self.replaying
            || self.client.is_some()
            || self.remote_keys.iter().any(|pressed| *pressed)
            || self.remote_mouse_buttons.iter().any(|pressed| *pressed)
    }

    fn start_recording(&mut self, path: &Path) -> Result<(), String> {
        if self.recorder.is_some() {
            return Err("input recording is already active".into());
        }
        let mut file = File::create(path)
            .map_err(|error| format!("cannot create recording {}: {error}", path.display()))?;
        writeln!(file, "{RECORDING_HEADER}")
            .map_err(|error| format!("cannot write recording {}: {error}", path.display()))?;
        self.recorder = Some(Recorder {
            file,
            start_frame: self.frame,
            native_keys: [false; Key::COUNT],
            native_mouse_position: (0.0, 0.0),
            native_mouse_buttons: [false; MOUSE_BUTTON_COUNT],
        });
        Ok(())
    }

    fn stop_recording(&mut self) -> Result<(), String> {
        let Some(mut recorder) = self.recorder.take() else {
            return Err("input recording is not active".into());
        };
        recorder
            .file
            .flush()
            .map_err(|error| format!("cannot flush input recording: {error}"))
    }

    fn record(&mut self, command: &str) {
        let Some(recorder) = self.recorder.as_mut() else {
            return;
        };
        let relative_frame = self.frame.saturating_sub(recorder.start_frame);
        let _ = writeln!(recorder.file, "frame\t{relative_frame}\t{command}");
    }

    fn record_native_changes(&mut self) {
        if self.recorder.is_none() || self.override_active() {
            return;
        }

        let mut commands = Vec::new();
        {
            let recorder = self.recorder.as_mut().expect("checked above");
            for index in 0..Key::COUNT {
                if recorder.native_keys[index] != self.native.keys[index] {
                    recorder.native_keys[index] = self.native.keys[index];
                    let key = Key::from_u16(index as u16).expect("bounded key index");
                    commands.push(format!(
                        "key {} {}",
                        if self.native.keys[index] {
                            "down"
                        } else {
                            "up"
                        },
                        key_name(key)
                    ));
                }
            }
            if recorder.native_mouse_position != self.native.mouse_position {
                recorder.native_mouse_position = self.native.mouse_position;
                commands.push(format!(
                    "mouse move abs {} {}",
                    format_float(self.native.mouse_position.0),
                    format_float(self.native.mouse_position.1)
                ));
            }
            for index in 0..MOUSE_BUTTON_COUNT {
                if recorder.native_mouse_buttons[index] != self.native.mouse_buttons[index] {
                    recorder.native_mouse_buttons[index] = self.native.mouse_buttons[index];
                    commands.push(format!(
                        "mouse {} {}",
                        if self.native.mouse_buttons[index] {
                            "down"
                        } else {
                            "up"
                        },
                        button_name(index)
                    ));
                }
            }
        }
        for command in commands {
            self.record(&command);
        }
        let text: String = self.native.text.iter().collect();
        if !text.is_empty() {
            self.record(&format!("text {text}"));
        }
        if self.native.scroll != (0.0, 0.0) {
            self.record(&format!(
                "scroll {} {}",
                format_float(self.native.scroll.0),
                format_float(self.native.scroll.1)
            ));
        }
    }

    fn apply_releases(&mut self) {
        for index in 0..Key::COUNT {
            if self.release_frame[index] <= self.frame {
                self.release_frame[index] = u64::MAX;
                if self.remote_keys[index] {
                    self.remote_keys[index] = false;
                    let key = Key::from_u16(index as u16).expect("bounded key index");
                    self.record(&format!("key up {}", key_name(key)));
                }
            }
        }
    }

    fn apply_replay(&mut self) {
        while self.replay_index < self.replay.len()
            && self.replay[self.replay_index].frame <= self.frame
        {
            let command = self.replay[self.replay_index].command.clone();
            self.replay_index += 1;
            let _ = self.apply_input(command, false);
        }
    }

    fn apply_input(&mut self, command: Command, record: bool) -> Result<(), String> {
        match command {
            Command::Key { key, action } => {
                let index = key as usize;
                match action {
                    KeyAction::Down => {
                        self.remote_keys[index] = true;
                        self.release_frame[index] = u64::MAX;
                        if record {
                            self.record(&format!("key down {}", key_name(key)));
                        }
                    }
                    KeyAction::Up => {
                        self.remote_keys[index] = false;
                        self.release_frame[index] = u64::MAX;
                        if record {
                            self.record(&format!("key up {}", key_name(key)));
                        }
                    }
                    KeyAction::Tap => {
                        self.remote_keys[index] = true;
                        self.release_frame[index] = self.frame.saturating_add(1);
                        if record {
                            self.record(&format!("key down {}", key_name(key)));
                        }
                    }
                }
            }
            Command::MouseMove { relative, x, y } => {
                if relative {
                    self.remote_mouse_position.0 += x;
                    self.remote_mouse_position.1 += y;
                } else {
                    self.remote_mouse_position = (x, y);
                }
                if record {
                    self.record(&format!(
                        "mouse move abs {} {}",
                        format_float(self.remote_mouse_position.0),
                        format_float(self.remote_mouse_position.1)
                    ));
                }
            }
            Command::MouseButton { button, pressed } => {
                self.remote_mouse_buttons[button] = pressed;
                if record {
                    self.record(&format!(
                        "mouse {} {}",
                        if pressed { "down" } else { "up" },
                        button_name(button)
                    ));
                }
            }
            Command::Text(value) => {
                self.text.extend(value.chars());
                if record {
                    self.record(&format!("text {value}"));
                }
            }
            Command::Scroll(x, y) => {
                self.scroll.0 += x;
                self.scroll.1 += y;
                if record {
                    self.record(&format!("scroll {} {}", format_float(x), format_float(y)));
                }
            }
            _ => return Err("command is not an input command".into()),
        }
        Ok(())
    }

    fn handle_request(&mut self, sequence: u64, command: Command) {
        if self.replaying
            && matches!(
                command,
                Command::Key { .. }
                    | Command::MouseMove { .. }
                    | Command::MouseButton { .. }
                    | Command::Text(_)
                    | Command::Scroll(_, _)
            )
        {
            self.queue_error(sequence, "live input is disabled during replay");
            return;
        }

        match command {
            input @ (Command::Key { .. }
            | Command::MouseMove { .. }
            | Command::MouseButton { .. }
            | Command::Text(_)
            | Command::Scroll(_, _)) => match self.apply_input(input, true) {
                Ok(()) => self.queue_ok(sequence, ""),
                Err(error) => self.queue_error(sequence, &error),
            },
            Command::Screenshot(path) => {
                self.screenshot_requests
                    .push_back(ScreenshotRequest { sequence, path });
            }
            Command::RecordStart(path) => match self.start_recording(&path) {
                Ok(()) => self.queue_ok(sequence, "\"recording\":true"),
                Err(error) => self.queue_error(sequence, &error),
            },
            Command::RecordStop => match self.stop_recording() {
                Ok(()) => self.queue_ok(sequence, "\"recording\":false"),
                Err(error) => self.queue_error(sequence, &error),
            },
            Command::Status => {
                let details = self.status_details();
                self.queue_ok(sequence, &details);
            }
            Command::Quit => {
                self.quit_requested = true;
                self.queue_ok(sequence, "\"quitting\":true");
            }
        }
    }

    fn queue_ok(&mut self, sequence: u64, details: &str) {
        let suffix = if details.is_empty() {
            String::new()
        } else {
            format!(",{details}")
        };
        self.queue_response(format!("{{\"ok\":true,\"sequence\":{sequence}{suffix}}}\n"));
    }

    fn queue_error(&mut self, sequence: u64, error: &str) {
        self.queue_response(format!(
            "{{\"ok\":false,\"sequence\":{sequence},\"error\":\"{}\"}}\n",
            json_escape(error)
        ));
    }
    fn status_details(&self) -> String {
        let s = &self.latest_status;
        let framebuffer = s
            .framebuffer
            .map(|(w, h)| format!("[{w},{h}]"))
            .unwrap_or_else(|| "null".into());
        let position = s
            .player_position
            .map(|(x, y)| format!("[{},{}]", format_float(x), format_float(y)))
            .unwrap_or_else(|| "null".into());
        let app_mode = s
            .app_mode
            .as_deref()
            .map(json_string)
            .unwrap_or_else(|| "null".into());
        let shard = s
            .shard
            .as_deref()
            .map(json_string)
            .unwrap_or_else(|| "null".into());
        let area = s
            .area
            .as_deref()
            .map(json_string)
            .unwrap_or_else(|| "null".into());
        let actor = s
            .player_actor_id
            .as_deref()
            .map(json_string)
            .unwrap_or_else(|| "null".into());
        let life = s
            .life
            .as_deref()
            .map(json_string)
            .unwrap_or_else(|| "null".into());
        let selection = s
            .selection
            .as_deref()
            .map(json_string)
            .unwrap_or_else(|| "null".into());
        let focused = s
            .focused_window
            .as_deref()
            .map(json_string)
            .unwrap_or_else(|| "null".into());
        let receipt = s
            .last_receipt
            .as_deref()
            .map(json_string)
            .unwrap_or_else(|| "null".into());
        format!(
            "\"schema\":\"successor.control.status.v2\",\"frame\":{},\"framebuffer\":{},\
             \"app_mode\":{},\"game_connection\":{},\"chat_connection\":{},\"shard\":{},\
             \"tick\":{},\"area\":{},\"source_hashes\":{},\"player_actor_id\":{},\
             \"player_position\":{},\"life\":{},\"selection\":{},\"windows\":{},\
             \"focused_window\":{},\"pending_command_kinds\":{},\"last_receipt\":{},\
             \"recording\":{},\"replaying\":{},\"renderer_degradation_ids\":{},\
             \"input_override\":{},\"listen_port\":{}",
            s.frame,
            framebuffer,
            app_mode,
            json_string(&s.game_connection),
            json_string(&s.chat_connection),
            shard,
            s.tick
                .map(|v| v.to_string())
                .unwrap_or_else(|| "null".into()),
            area,
            json_list(&s.source_hashes),
            actor,
            position,
            life,
            selection,
            json_list(&s.windows),
            focused,
            json_list(&s.pending_command_kinds),
            receipt,
            self.recorder.is_some(),
            self.replaying,
            json_list(&s.renderer_degradation_ids),
            self.override_active(),
            self.listen_port
                .map(|p| p.to_string())
                .unwrap_or_else(|| "null".into())
        )
    }

    fn queue_response(&mut self, response: String) {
        self.writes.push_back(PendingWrite {
            bytes: response.into_bytes(),
            sent: 0,
        });
    }

    fn accept_client(&mut self) {
        if self.client.is_some() {
            return;
        }
        let accepted = self
            .listener
            .as_ref()
            .and_then(|listener| match listener.accept() {
                Ok((stream, _)) => Some(Ok(stream)),
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => None,
                Err(error) => Some(Err(error)),
            });
        if let Some(Ok(stream)) = accepted {
            if stream.set_nonblocking(true).is_ok() {
                self.client = Some(stream);
                self.receive.clear();
                self.writes.clear();
                self.remote_mouse_position = self.native.mouse_position;
            }
        }
    }

    fn read_client(&mut self) {
        let mut disconnected = false;
        let mut bytes = [0u8; 4096];
        if let Some(stream) = self.client.as_mut() {
            loop {
                match stream.read(&mut bytes) {
                    Ok(0) => {
                        disconnected = true;
                        break;
                    }
                    Ok(count) => {
                        if self.receive.len() + count > MAX_REQUEST_BUFFER {
                            disconnected = true;
                            break;
                        }
                        self.receive.extend_from_slice(&bytes[..count]);
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => break,
                    Err(_) => {
                        disconnected = true;
                        break;
                    }
                }
            }
        }

        while let Some(newline) = self.receive.iter().position(|byte| *byte == b'\n') {
            let line: Vec<u8> = self.receive.drain(..=newline).collect();
            let line = match std::str::from_utf8(&line[..line.len().saturating_sub(1)]) {
                Ok(line) => line.trim_end_matches('\r'),
                Err(_) => {
                    self.queue_error(0, "request is not UTF-8");
                    continue;
                }
            };
            match parse_request(line) {
                Ok((sequence, command)) => self.handle_request(sequence, command),
                Err((sequence, error)) => self.queue_error(sequence, &error),
            }
        }

        if disconnected {
            self.client = None;
            self.receive.clear();
            self.writes.clear();
        }
    }

    fn flush_client(&mut self) {
        let Some(stream) = self.client.as_mut() else {
            return;
        };
        while let Some(write) = self.writes.front_mut() {
            match stream.write(&write.bytes[write.sent..]) {
                Ok(0) => break,
                Ok(count) => {
                    write.sent += count;
                    if write.sent == write.bytes.len() {
                        self.writes.pop_front();
                    }
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => break,
                Err(_) => {
                    self.client = None;
                    self.writes.clear();
                    break;
                }
            }
        }
    }
}

pub fn configure(config: ControlConfig) -> Result<ControlStatus, String> {
    if config.record_path.is_some() && config.replay_path.is_some() {
        return Err("--record-input and --replay-input cannot be used together".into());
    }

    let mut next = ControlState::new();
    if let Some(path) = config.replay_path.as_deref() {
        next.replay = load_replay(path)?;
        next.replaying = true;
    }
    if let Some(port) = config.port {
        let listener = TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, port))
            .map_err(|error| format!("cannot bind control server on 127.0.0.1:{port}: {error}"))?;
        listener
            .set_nonblocking(true)
            .map_err(|error| format!("cannot make control server nonblocking: {error}"))?;
        next.listen_port = Some(
            listener
                .local_addr()
                .map_err(|error| format!("cannot read control server address: {error}"))?
                .port(),
        );
        next.listener = Some(listener);
    }
    if let Some(path) = config.record_path.as_deref() {
        next.start_recording(path)?;
    }

    let status = ControlStatus {
        listen_port: next.listen_port,
        replaying: next.replaying,
        recording: next.recorder.is_some(),
    };
    *CONTROL.lock() = next;
    CONFIGURED.store(true, Ordering::Release);
    Ok(status)
}

pub fn shutdown() {
    if !is_configured() {
        return;
    }
    let mut state = CONTROL.lock();
    if let Some(recorder) = state.recorder.as_mut() {
        let _ = recorder.file.flush();
    }
    *state = ControlState::new();
    CONFIGURED.store(false, Ordering::Release);
}

pub fn is_configured() -> bool {
    CONFIGURED.load(Ordering::Acquire)
}
/// Publish the latest connected runtime status as one atomic owned snapshot.
pub fn publish_control_status(status: ControlStatusV2) {
    CONTROL.lock().latest_status = status;
}

pub fn begin_frame(snapshot: NativeInputSnapshot) {
    if !is_configured() {
        return;
    }
    let mut state = CONTROL.lock();
    state.native = snapshot;
    state.text.clear();
    state.scroll = (0.0, 0.0);
    state.apply_releases();
    if state.replaying {
        state.apply_replay();
    }
    state.accept_client();
    state.read_client();

    if !state.override_active() {
        let text = state.native.text.clone();
        state.text.extend(text);
        state.scroll = state.native.scroll;
        state.record_native_changes();
    }
    state.flush_client();
    state.frame = state.frame.saturating_add(1);
}

pub fn flush() {
    if is_configured() {
        CONTROL.lock().flush_client();
    }
}

pub fn key_down(key: Key) -> Option<bool> {
    if !is_configured() {
        return None;
    }
    let state = CONTROL.lock();
    Some(if state.override_active() {
        state.remote_keys[key as usize]
    } else {
        state.native.keys[key as usize]
    })
}

pub fn mouse_position() -> Option<(f32, f32)> {
    if !is_configured() {
        return None;
    }
    let state = CONTROL.lock();
    Some(if state.override_active() {
        state.remote_mouse_position
    } else {
        state.native.mouse_position
    })
}

pub fn mouse_button_down(button: usize) -> Option<bool> {
    if !is_configured() || button >= MOUSE_BUTTON_COUNT {
        return None;
    }
    let state = CONTROL.lock();
    Some(if state.override_active() {
        state.remote_mouse_buttons[button]
    } else {
        state.native.mouse_buttons[button]
    })
}

pub fn poll_text_input() -> Option<char> {
    if !is_configured() {
        return None;
    }
    CONTROL.lock().text.pop_front()
}

pub fn poll_scroll_delta() -> Option<(f32, f32)> {
    if !is_configured() {
        return None;
    }
    let mut state = CONTROL.lock();
    let value = state.scroll;
    state.scroll = (0.0, 0.0);
    (value != (0.0, 0.0)).then_some(value)
}

pub fn quit_requested() -> bool {
    is_configured() && CONTROL.lock().quit_requested
}

pub fn take_screenshot_request() -> Option<ScreenshotRequest> {
    if !is_configured() {
        return None;
    }
    CONTROL.lock().screenshot_requests.pop_front()
}

pub fn finish_screenshot(request: ScreenshotRequest, result: Result<(u32, u32), String>) {
    if !is_configured() {
        return;
    }
    let mut state = CONTROL.lock();
    match result {
        Ok((width, height)) => {
            let details = format!(
                "\"screenshot\":{{\"path\":\"{}\",\"width\":{width},\"height\":{height}}}",
                json_escape(&request.path.display().to_string())
            );
            state.queue_ok(request.sequence, &details);
        }
        Err(error) => state.queue_error(request.sequence, &error),
    }
    state.flush_client();
}

pub fn write_bmp(path: &Path, rgba: &[u8], width: u32, height: u32) -> Result<(), String> {
    let row_bytes = (width as usize)
        .checked_mul(3)
        .ok_or_else(|| "screenshot width overflow".to_string())?;
    let padded_row_bytes = (row_bytes + 3) & !3;
    let pixel_bytes = padded_row_bytes
        .checked_mul(height as usize)
        .ok_or_else(|| "screenshot height overflow".to_string())?;
    let expected_rgba = (width as usize)
        .checked_mul(height as usize)
        .and_then(|pixels| pixels.checked_mul(4))
        .ok_or_else(|| "screenshot dimensions overflow".to_string())?;
    if rgba.len() != expected_rgba {
        return Err(format!(
            "screenshot pixel size mismatch: expected {expected_rgba}, got {}",
            rgba.len()
        ));
    }

    let file_size = 54usize
        .checked_add(pixel_bytes)
        .ok_or_else(|| "screenshot file size overflow".to_string())?;
    let mut file = File::create(path)
        .map_err(|error| format!("cannot create screenshot {}: {error}", path.display()))?;
    let mut header = [0u8; 54];
    header[0..2].copy_from_slice(b"BM");
    header[2..6].copy_from_slice(&(file_size as u32).to_le_bytes());
    header[10..14].copy_from_slice(&54u32.to_le_bytes());
    header[14..18].copy_from_slice(&40u32.to_le_bytes());
    header[18..22].copy_from_slice(&width.to_le_bytes());
    header[22..26].copy_from_slice(&height.to_le_bytes());
    header[26..28].copy_from_slice(&1u16.to_le_bytes());
    header[28..30].copy_from_slice(&24u16.to_le_bytes());
    header[34..38].copy_from_slice(&(pixel_bytes as u32).to_le_bytes());
    file.write_all(&header)
        .map_err(|error| format!("cannot write screenshot header: {error}"))?;

    let padding = [0u8; 3];
    for row in 0..height as usize {
        let row_start = row * width as usize * 4;
        for column in 0..width as usize {
            let pixel = row_start + column * 4;
            file.write_all(&[rgba[pixel + 2], rgba[pixel + 1], rgba[pixel]])
                .map_err(|error| format!("cannot write screenshot pixels: {error}"))?;
        }
        file.write_all(&padding[..padded_row_bytes - row_bytes])
            .map_err(|error| format!("cannot write screenshot padding: {error}"))?;
    }
    Ok(())
}

fn parse_request(line: &str) -> Result<(u64, Command), (u64, String)> {
    let (sequence, command_text) = if let Some((prefix, rest)) = line.split_once('\t') {
        match prefix.parse::<u64>() {
            Ok(sequence) => (sequence, rest),
            Err(_) => (0, line),
        }
    } else {
        (0, line)
    };
    parse_command(command_text)
        .map(|command| (sequence, command))
        .map_err(|error| (sequence, error))
}

fn parse_command(line: &str) -> Result<Command, String> {
    let line = line.trim();
    if line.is_empty() {
        return Err("empty command".into());
    }
    if let Some(text) = line.strip_prefix("text ") {
        if text.is_empty() {
            return Err("text command requires content".into());
        }
        return Ok(Command::Text(text.to_string()));
    }
    if let Some(path) = line.strip_prefix("screenshot ") {
        return nonempty_path(path).map(Command::Screenshot);
    }
    if let Some(path) = line.strip_prefix("record start ") {
        return nonempty_path(path).map(Command::RecordStart);
    }

    let words: Vec<&str> = line.split_whitespace().collect();
    match words.as_slice() {
        ["key", action, key] => Ok(Command::Key {
            key: parse_key(key)?,
            action: match *action {
                "down" => KeyAction::Down,
                "up" => KeyAction::Up,
                "tap" => KeyAction::Tap,
                _ => return Err("key action must be down, up, or tap".into()),
            },
        }),
        ["mouse", "move", mode, x, y] => Ok(Command::MouseMove {
            relative: match *mode {
                "abs" | "absolute" => false,
                "rel" | "relative" => true,
                _ => return Err("mouse move mode must be abs or rel".into()),
            },
            x: parse_finite(x, "mouse x")?,
            y: parse_finite(y, "mouse y")?,
        }),
        ["mouse", action, button] => Ok(Command::MouseButton {
            button: parse_button(button)?,
            pressed: match *action {
                "down" => true,
                "up" => false,
                _ => return Err("mouse action must be down or up".into()),
            },
        }),
        ["scroll", x, y] => Ok(Command::Scroll(
            parse_finite(x, "scroll x")?,
            parse_finite(y, "scroll y")?,
        )),
        ["record", "stop"] => Ok(Command::RecordStop),
        ["status"] => Ok(Command::Status),
        ["quit"] => Ok(Command::Quit),
        _ => Err("unknown command".into()),
    }
}

fn nonempty_path(value: &str) -> Result<PathBuf, String> {
    let value = value.trim();
    if value.is_empty() {
        Err("command requires a path".into())
    } else {
        Ok(PathBuf::from(value))
    }
}

fn parse_finite(value: &str, name: &str) -> Result<f32, String> {
    let parsed = value
        .parse::<f32>()
        .map_err(|_| format!("{name} must be a number"))?;
    if parsed.is_finite() {
        Ok(parsed)
    } else {
        Err(format!("{name} must be finite"))
    }
}

fn parse_key(value: &str) -> Result<Key, String> {
    match value.to_ascii_lowercase().as_str() {
        "w" => Ok(Key::W),
        "a" => Ok(Key::A),
        "s" => Ok(Key::S),
        "d" => Ok(Key::D),
        "up" => Ok(Key::Up),
        "down" => Ok(Key::Down),
        "left" => Ok(Key::Left),
        "right" => Ok(Key::Right),
        "space" => Ok(Key::Space),
        "enter" | "return" => Ok(Key::Enter),
        "escape" | "esc" => Ok(Key::Escape),
        "backspace" => Ok(Key::Backspace),
        "leftshift" | "shift" => Ok(Key::LeftShift),
        "backquote" | "grave" | "`" => Ok(Key::Backquote),
        "r" => Ok(Key::R),
        "f" => Ok(Key::F),
        "i" => Ok(Key::I),
        "c" => Ok(Key::C),
        "semicolon" | ";" => Ok(Key::Semicolon),
        "o" => Ok(Key::O),
        "tab" => Ok(Key::Tab),
        "v" => Ok(Key::V),
        "x" => Ok(Key::X),
        "n" => Ok(Key::N),
        "0" | "digit0" => Ok(Key::Digit0),
        "1" | "digit1" => Ok(Key::Digit1),
        "2" | "digit2" => Ok(Key::Digit2),
        "3" | "digit3" => Ok(Key::Digit3),
        "4" | "digit4" => Ok(Key::Digit4),
        "5" | "digit5" => Ok(Key::Digit5),
        "6" | "digit6" => Ok(Key::Digit6),
        "7" | "digit7" => Ok(Key::Digit7),
        "8" | "digit8" => Ok(Key::Digit8),
        "9" | "digit9" => Ok(Key::Digit9),
        _ => Err(format!("unknown key: {value}")),
    }
}

fn key_name(key: Key) -> &'static str {
    match key {
        Key::W => "w",
        Key::A => "a",
        Key::S => "s",
        Key::D => "d",
        Key::Up => "up",
        Key::Down => "down",
        Key::Left => "left",
        Key::Right => "right",
        Key::Space => "space",
        Key::Enter => "enter",
        Key::Escape => "escape",
        Key::Backspace => "backspace",
        Key::LeftShift => "leftshift",
        Key::Backquote => "backquote",
        Key::R => "r",
        Key::F => "f",
        Key::I => "i",
        Key::C => "c",
        Key::Semicolon => "semicolon",
        Key::O => "o",
        Key::Tab => "tab",
        Key::V => "v",
        Key::X => "x",
        Key::N => "n",
        Key::Digit0 => "0",
        Key::Digit1 => "1",
        Key::Digit2 => "2",
        Key::Digit3 => "3",
        Key::Digit4 => "4",
        Key::Digit5 => "5",
        Key::Digit6 => "6",
        Key::Digit7 => "7",
        Key::Digit8 => "8",
        Key::Digit9 => "9",
    }
}

fn parse_button(value: &str) -> Result<usize, String> {
    match value.to_ascii_lowercase().as_str() {
        "left" => Ok(0),
        "right" => Ok(1),
        "middle" => Ok(2),
        _ => Err(format!("unknown mouse button: {value}")),
    }
}

fn button_name(button: usize) -> &'static str {
    match button {
        0 => "left",
        1 => "right",
        2 => "middle",
        _ => "unknown",
    }
}

fn format_float(value: f32) -> String {
    let mut value = value.to_string();
    if !value.contains(['.', 'e', 'E']) {
        value.push_str(".0");
    }
    value
}

fn load_replay(path: &Path) -> Result<Vec<ReplayEvent>, String> {
    let source = std::fs::read_to_string(path)
        .map_err(|error| format!("cannot read replay {}: {error}", path.display()))?;
    let mut lines = source.lines();
    if lines.next() != Some(RECORDING_HEADER) {
        return Err(format!(
            "unsupported input replay schema in {}",
            path.display()
        ));
    }

    let mut events = Vec::new();
    let mut previous_frame = 0;
    for (index, line) in lines.enumerate() {
        if line.trim().is_empty() || line.trim_start().starts_with('#') {
            continue;
        }
        let mut fields = line.splitn(3, '\t');
        if fields.next() != Some("frame") {
            return Err(format!("invalid replay line {}", index + 2));
        }
        let frame = fields
            .next()
            .and_then(|value| value.parse::<u64>().ok())
            .ok_or_else(|| format!("invalid replay frame on line {}", index + 2))?;
        if !events.is_empty() && frame < previous_frame {
            return Err(format!(
                "replay frames are out of order on line {}",
                index + 2
            ));
        }
        let command_text = fields
            .next()
            .ok_or_else(|| format!("missing replay command on line {}", index + 2))?;
        let command = parse_command(command_text)
            .map_err(|error| format!("invalid replay command on line {}: {error}", index + 2))?;
        if !matches!(
            command,
            Command::Key { .. }
                | Command::MouseMove { .. }
                | Command::MouseButton { .. }
                | Command::Text(_)
                | Command::Scroll(_, _)
        ) {
            return Err(format!("non-input replay command on line {}", index + 2));
        }
        previous_frame = frame;
        events.push(ReplayEvent { frame, command });
    }
    Ok(events)
}

fn json_escape(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len());
    for character in value.chars() {
        match character {
            '"' => escaped.push_str("\\\""),
            '\\' => escaped.push_str("\\\\"),
            '\n' => escaped.push_str("\\n"),
            '\r' => escaped.push_str("\\r"),
            '\t' => escaped.push_str("\\t"),
            c if c.is_control() => escaped.push_str(&format!("\\u{:04x}", c as u32)),
            c => escaped.push(c),
        }
    }
    escaped
}
fn json_string(value: &str) -> String {
    format!("\"{}\"", json_escape(value))
}

fn json_list(values: &[String]) -> String {
    let mut out = String::from("[");
    for (i, value) in values.iter().enumerate() {
        if i != 0 {
            out.push(',');
        }
        out.push_str(&json_string(value));
    }
    out.push(']');
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn parses_command_vocabulary_and_rejects_non_finite_values() {
        assert_eq!(
            parse_command("key tap w").unwrap(),
            Command::Key {
                key: Key::W,
                action: KeyAction::Tap
            }
        );
        assert_eq!(
            parse_command("mouse move rel -2 3.5").unwrap(),
            Command::MouseMove {
                relative: true,
                x: -2.0,
                y: 3.5
            }
        );
        assert_eq!(
            parse_command("text hello world").unwrap(),
            Command::Text("hello world".into())
        );
        assert!(parse_command("scroll NaN 1").is_err());
        assert!(parse_command("key down unknown").is_err());
    }

    #[test]
    fn replay_is_schema_checked_ordered_and_input_only() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!("successor-replay-{nonce}.txt"));
        std::fs::write(
            &path,
            "successor.input.v1\nframe\t0\tkey down w\nframe\t2\tkey up w\n",
        )
        .unwrap();
        let replay = load_replay(&path).unwrap();
        assert_eq!(replay.len(), 2);
        assert_eq!(replay[0].frame, 0);
        assert_eq!(replay[1].frame, 2);

        std::fs::write(&path, "successor.input.v1\nframe\t0\tquit\n").unwrap();
        assert!(load_replay(&path).is_err());
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn bmp_writer_emits_expected_header_and_pixels() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!("successor-shot-{nonce}.bmp"));
        write_bmp(&path, &[255, 0, 0, 255], 1, 1).unwrap();
        let bytes = std::fs::read(&path).unwrap();
        assert_eq!(&bytes[..2], b"BM");
        assert_eq!(bytes.len(), 58);
        assert_eq!(&bytes[54..57], &[0, 0, 255]);
        let _ = std::fs::remove_file(path);
    }
}

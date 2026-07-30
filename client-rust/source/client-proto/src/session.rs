use crate::colyseus;
use crate::packets::{self, GameHello, GameServerPacket};
use serde_json::Value;

#[derive(Debug, Clone, PartialEq)]
pub enum SessionEvent {
    Hello(GameHello),
    Packet(GameServerPacket),
    Error(String),
    Closed,
    ReconnectAttempt { attempt: u32, max_attempts: u32 },
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum WsInput<'a> {
    Open,
    Frame(&'a [u8]),
    Closed,
    Error(&'a str),
}

#[derive(Debug, Clone, PartialEq)]
pub enum SessionOut {
    SendFrame(Vec<u8>),
    Emit(SessionEvent),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionState {
    Disconnected,
    Connecting,
    AwaitingJoinRoom,
    ExpectingHello,
    Ready,
    Failed,
}

pub struct Session {
    state: SessionState,
    reconnect_attempts: u32,
    max_reconnect_attempts: u32,
}

impl Session {
    pub fn new() -> Self {
        Self {
            state: SessionState::Disconnected,
            reconnect_attempts: 0,
            max_reconnect_attempts: 5,
        }
    }
    
    pub fn state(&self) -> SessionState {
        self.state
    }
    
    pub fn start_connecting(&mut self) {
        self.state = SessionState::Connecting;
    }
    
    pub fn on_ws_event(&mut self, ev: WsInput<'_>) -> Vec<SessionOut> {
        let mut outs = Vec::new();
        match &ev {
            WsInput::Open => {
                if self.state == SessionState::Connecting || self.state == SessionState::Disconnected {
                    self.state = SessionState::AwaitingJoinRoom;
                }
            }
            WsInput::Frame(bytes) => {
                match &self.state {
                    SessionState::AwaitingJoinRoom => {
                        match colyseus::decode_inbound_frame(*bytes) {
                            Ok(colyseus::InboundFrame::JoinRoom { .. }) => {
                                // Acknowledge successful JOIN_ROOM, then send
                                // game.ready immediately — the server emits
                                // game.hello in response to game.ready (see
                                // server colyseusRoom `connectClient`), so we
                                // must NOT wait for hello before readying.
                                outs.push(SessionOut::SendFrame(vec![colyseus::opcodes::JOIN_ROOM]));
                                if let Ok(ready_frame) = colyseus::encode_room_message(
                                    packets::MSG_GAME_READY,
                                    &serde_json::Value::Null,
                                ) {
                                    outs.push(SessionOut::SendFrame(ready_frame));
                                }
                                self.state = SessionState::ExpectingHello;
                            }
                            Ok(colyseus::InboundFrame::Error { code, message }) => {
                                self.state = SessionState::Disconnected;
                                outs.push(SessionOut::Emit(SessionEvent::Error(format!(
                                    "JoinRoom error (code {}): {}", code, message
                                ))));
                                self.handle_disconnect(&mut outs);
                            }
                            _ => {
                                // Unexpected frame in AwaitingJoinRoom
                            }
                        }
                    }
                    SessionState::ExpectingHello => {
                        match colyseus::decode_inbound_frame(*bytes) {
                            Ok(colyseus::InboundFrame::RoomData { msg_type, payload }) => {
                                if msg_type == "game.packet" {
                                    match serde_json::from_value::<GameServerPacket>(payload) {
                                        Ok(GameServerPacket::Hello(hello)) => {
                                            self.state = SessionState::Ready;
                                            self.reconnect_attempts = 0;
                                            outs.push(SessionOut::Emit(SessionEvent::Hello(hello)));
                                        }
                                        Ok(packet) => {
                                            outs.push(SessionOut::Emit(SessionEvent::Packet(packet)));
                                        }
                                        Err(e) => {
                                            outs.push(SessionOut::Emit(SessionEvent::Error(format!(
                                                "Failed to deserialize Hello packet: {}", e
                                            ))));
                                        }
                                    }
                                }
                            }
                            Ok(colyseus::InboundFrame::Error { code, message }) => {
                                outs.push(SessionOut::Emit(SessionEvent::Error(format!(
                                    "Error frame (code {}): {}", code, message
                                ))));
                                self.handle_disconnect(&mut outs);
                            }
                            _ => {}
                        }
                    }
                    SessionState::Ready => {
                        match colyseus::decode_inbound_frame(*bytes) {
                            Ok(colyseus::InboundFrame::RoomData { msg_type, payload }) => {
                                if msg_type == "game.packet" {
                                    match serde_json::from_value::<GameServerPacket>(payload) {
                                        Ok(packet) => {
                                            outs.push(SessionOut::Emit(SessionEvent::Packet(packet)));
                                        }
                                        Err(e) => {
                                            outs.push(SessionOut::Emit(SessionEvent::Error(format!(
                                                "Failed to deserialize server packet: {}", e
                                            ))));
                                        }
                                    }
                                }
                            }
                            Ok(colyseus::InboundFrame::Error { code, message }) => {
                                outs.push(SessionOut::Emit(SessionEvent::Error(format!(
                                    "Error frame (code {}): {}", code, message
                                ))));
                                self.handle_disconnect(&mut outs);
                            }
                            Ok(colyseus::InboundFrame::LeaveRoom) => {
                                outs.push(SessionOut::Emit(SessionEvent::Closed));
                                self.handle_disconnect(&mut outs);
                            }
                            _ => {}
                        }
                    }
                    _ => {}
                }
            }
            WsInput::Closed | WsInput::Error(_) => {
                self.handle_disconnect(&mut outs);
            }
        }
        outs
    }
    
    fn handle_disconnect(&mut self, outs: &mut Vec<SessionOut>) {
        if self.state == SessionState::Failed {
            return;
        }
        if self.reconnect_attempts < self.max_reconnect_attempts {
            self.reconnect_attempts += 1;
            self.state = SessionState::Connecting;
            outs.push(SessionOut::Emit(SessionEvent::ReconnectAttempt {
                attempt: self.reconnect_attempts,
                max_attempts: self.max_reconnect_attempts,
            }));
        } else {
            self.state = SessionState::Failed;
            outs.push(SessionOut::Emit(SessionEvent::Closed));
        }
    }
    
    pub fn send_command(
        &mut self,
        envelope: &successor_net::ClientCommandEnvelope,
    ) -> Result<SessionOut, rmp_serde::encode::Error> {
        // Serialize via JSON then drop null-valued fields. `successor-net`
        // serializes `Option::None` as `null` (e.g. `SetMoveIntent.facing`),
        // but the server's zod schema treats those fields as `.optional()`
        // (absent), and rejects an explicit `null`. Stripping nulls matches how
        // the TS client omits `undefined` fields.
        let mut value = serde_json::to_value(envelope).expect("ClientCommandEnvelope serializes to JSON");
        strip_nulls(&mut value);
        let frame = colyseus::encode_room_message(packets::MSG_GAME_COMMAND, &value)?;
        Ok(SessionOut::SendFrame(frame))
    }
    
    pub fn send_view(&mut self, view: &Value) -> Result<SessionOut, rmp_serde::encode::Error> {
        let frame = colyseus::encode_room_message(packets::MSG_GAME_VIEW, view)?;
        Ok(SessionOut::SendFrame(frame))
    }
    
    pub fn exit_world(&mut self) -> Result<SessionOut, rmp_serde::encode::Error> {
        let frame = colyseus::encode_room_message(
            packets::MSG_EXIT_WORLD,
            &Value::Object(serde_json::Map::new()),
        )?;
        Ok(SessionOut::SendFrame(frame))
    }
}

/// Recursively remove object fields whose value is JSON `null`. The server's
/// command schema uses `.optional()` (absent), not `.nullable()`, so an
/// explicit `null` from `Option::None` would be rejected.
fn strip_nulls(value: &mut Value) {
    match value {
        Value::Object(map) => {
            map.retain(|_, v| !v.is_null());
            for v in map.values_mut() {
                strip_nulls(v);
            }
        }
        Value::Array(items) => {
            for v in items.iter_mut() {
                strip_nulls(v);
            }
        }
        _ => {}
    }
}

impl Default for Session {
    fn default() -> Self {
        Self::new()
    }
}

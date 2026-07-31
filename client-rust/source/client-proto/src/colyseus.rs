use serde::{Deserialize, Serialize};
use serde_json::Value;

// Colyseus 0.17 Protocol opcodes transcribed from node_modules/@colyseus/shared-types/src/Protocol.ts
pub mod opcodes {
    pub const JOIN_ROOM: u8 = 10;
    pub const ERROR: u8 = 11;
    pub const LEAVE_ROOM: u8 = 12;
    pub const ROOM_DATA: u8 = 13;
    pub const ROOM_STATE: u8 = 14;
    pub const ROOM_STATE_PATCH: u8 = 15;
    pub const ROOM_DATA_BYTES: u8 = 17;
    pub const PING: u8 = 18;
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SeatReservation {
    pub room_id: String,
    pub session_id: String,
    pub process_id: Option<String>,
    pub protocol: Option<String>,
    pub name: Option<String>,
    pub public_address: Option<String>,
}

/// Builds the matchmaking HTTP request URL/path and body bytes.
/// Method: POST, path: `/matchmake/joinOrCreate/game`
/// Transcribed from client/node_modules/@colyseus/sdk/src/Client.ts
pub fn build_matchmake_request(
    endpoint: &str,
    join_options: &Value,
) -> Result<(String, Vec<u8>), serde_json::Error> {
    let mut base = endpoint.to_string();
    if base.starts_with("ws://") {
        base = base.replacen("ws://", "http://", 1);
    } else if base.starts_with("wss://") {
        base = base.replacen("wss://", "https://", 1);
    }
    let base = base.trim_end_matches('/');
    let url = format!("{}/matchmake/joinOrCreate/game", base);
    let body = serde_json::to_vec(join_options)?;
    Ok((url, body))
}

/// Parses the seat reservation JSON response from the matchmaker.
pub fn parse_seat_reservation(json_bytes: &[u8]) -> Result<SeatReservation, serde_json::Error> {
    serde_json::from_slice(json_bytes)
}

/// Builds the WebSocket connection URL.
/// Transcribed from client/node_modules/@colyseus/sdk/src/Client.ts (buildEndpoint)
pub fn build_ws_url(endpoint: &str, seat_res: &SeatReservation) -> String {
    let mut base = endpoint.to_string();
    if base.starts_with("http://") {
        base = base.replacen("http://", "ws://", 1);
    } else if base.starts_with("https://") {
        base = base.replacen("https://", "wss://", 1);
    }
    let base = base.trim_end_matches('/');

    if let Some(proc_id) = &seat_res.process_id {
        if !proc_id.is_empty() {
            return format!(
                "{}/{}/{}?sessionId={}",
                base, proc_id, seat_res.room_id, seat_res.session_id
            );
        }
    }
    format!(
        "{}/{}?sessionId={}",
        base, seat_res.room_id, seat_res.session_id
    )
}

/// Encodes a room message `room.send(type, payload)` into msgpack bytes.
/// Format: [ROOM_DATA (13), messageType string (msgpack), payload (msgpack)]
/// Transcribed from client/node_modules/@colyseus/sdk/src/Room.ts (send)
pub fn encode_room_message<T: Serialize>(
    msg_type: &str,
    payload: &T,
) -> Result<Vec<u8>, rmp_serde::encode::Error> {
    let mut buf = Vec::new();
    buf.push(opcodes::ROOM_DATA);
    rmp_serde::encode::write(&mut buf, msg_type)?;
    rmp_serde::encode::write(&mut buf, payload)?;
    Ok(buf)
}

#[derive(Debug, Clone, PartialEq)]
pub enum InboundFrame {
    JoinRoom {
        reconnection_token: String,
        serializer_id: String,
    },
    Error {
        code: u16,
        message: String,
    },
    LeaveRoom,
    RoomState(Vec<u8>),
    RoomStatePatch(Vec<u8>),
    RoomData {
        msg_type: String,
        payload: Value,
    },
    RoomDataBytes {
        msg_type: String,
        payload: Vec<u8>,
    },
    Ping,
    Unknown(u8),
}

/// Decodes an inbound WebSocket binary frame.
/// Transcribed from client/node_modules/@colyseus/sdk/src/Room.ts (onMessageCallback)
pub fn decode_inbound_frame(bytes: &[u8]) -> Result<InboundFrame, String> {
    if bytes.is_empty() {
        return Err("Empty frame".to_string());
    }
    let code = bytes[0];
    match code {
        opcodes::JOIN_ROOM => {
            let mut offset = 1;
            if bytes.len() <= offset {
                return Err("Malformed JOIN_ROOM frame".to_string());
            }
            let token_len = bytes[offset] as usize;
            offset += 1;
            if bytes.len() < offset + token_len {
                return Err("Malformed JOIN_ROOM token".to_string());
            }
            let token = String::from_utf8_lossy(&bytes[offset..offset + token_len]).into_owned();
            offset += token_len;

            if bytes.len() <= offset {
                return Err("Malformed JOIN_ROOM frame trailing".to_string());
            }
            let serializer_len = bytes[offset] as usize;
            offset += 1;
            if bytes.len() < offset + serializer_len {
                return Err("Malformed JOIN_ROOM serializer".to_string());
            }
            let serializer =
                String::from_utf8_lossy(&bytes[offset..offset + serializer_len]).into_owned();

            Ok(InboundFrame::JoinRoom {
                reconnection_token: token,
                serializer_id: serializer,
            })
        }
        opcodes::ERROR => {
            let mut cursor = std::io::Cursor::new(&bytes[1..]);
            let mut de = rmp_serde::Deserializer::new(&mut cursor);
            let code: u16 = Deserialize::deserialize(&mut de)
                .map_err(|e| format!("Failed to decode error code: {}", e))?;
            let message: String = Deserialize::deserialize(&mut de)
                .map_err(|e| format!("Failed to decode error message: {}", e))?;
            Ok(InboundFrame::Error { code, message })
        }
        opcodes::LEAVE_ROOM => Ok(InboundFrame::LeaveRoom),
        opcodes::ROOM_STATE => Ok(InboundFrame::RoomState(bytes[1..].to_vec())),
        opcodes::ROOM_STATE_PATCH => Ok(InboundFrame::RoomStatePatch(bytes[1..].to_vec())),
        opcodes::ROOM_DATA => {
            let mut cursor = std::io::Cursor::new(&bytes[1..]);
            let mut de = rmp_serde::Deserializer::new(&mut cursor);
            let msg_type: String = Deserialize::deserialize(&mut de)
                .map_err(|e| format!("Failed to decode message type: {}", e))?;
            let current_pos = cursor.position() as usize;
            let payload_bytes = &bytes[1 + current_pos..];

            let payload = if !payload_bytes.is_empty() {
                rmp_serde::from_slice(payload_bytes)
                    .map_err(|e| format!("Failed to decode payload: {}", e))?
            } else {
                Value::Null
            };

            Ok(InboundFrame::RoomData { msg_type, payload })
        }
        opcodes::ROOM_DATA_BYTES => {
            let mut cursor = std::io::Cursor::new(&bytes[1..]);
            let mut de = rmp_serde::Deserializer::new(&mut cursor);
            let msg_type: String = Deserialize::deserialize(&mut de)
                .map_err(|e| format!("Failed to decode message type: {}", e))?;
            let current_pos = cursor.position() as usize;
            let payload = bytes[1 + current_pos..].to_vec();
            Ok(InboundFrame::RoomDataBytes { msg_type, payload })
        }
        opcodes::PING => Ok(InboundFrame::Ping),
        _ => Ok(InboundFrame::Unknown(code)),
    }
}

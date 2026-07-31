//! Native WebSocket transport implementation using tungstenite.

use std::net::TcpStream;
use tungstenite::{stream::MaybeTlsStream, Message, WebSocket};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WsEvent {
    Open,
    Frame(usize),
    Closed,
    Error,
    None,
}

pub struct WsHandle {
    pub(crate) socket: WebSocket<MaybeTlsStream<TcpStream>>,
    pub(crate) opened_reported: bool,
}

pub fn ws_connect(url_str: &str) -> Result<WsHandle, String> {
    let (mut socket, _) = tungstenite::connect(url_str).map_err(|e| e.to_string())?;

    // Set non-blocking on the underlying TcpStream
    match socket.get_mut() {
        MaybeTlsStream::Plain(s) => {
            s.set_nonblocking(true).map_err(|e| e.to_string())?;
        }
        MaybeTlsStream::NativeTls(s) => {
            s.get_mut()
                .set_nonblocking(true)
                .map_err(|e| e.to_string())?;
        }
        _ => {}
    }

    Ok(WsHandle {
        socket,
        opened_reported: false,
    })
}

pub fn ws_send(handle: &mut WsHandle, data: &[u8]) {
    let _ = handle.socket.write(Message::Binary(data.to_vec()));
    let _ = handle.socket.flush();
}

pub fn ws_poll(handle: &mut WsHandle, out_buf: &mut Vec<u8>) -> WsEvent {
    if !handle.opened_reported {
        handle.opened_reported = true;
        return WsEvent::Open;
    }

    match handle.socket.read() {
        Ok(Message::Binary(bin)) => {
            out_buf.clear();
            out_buf.extend_from_slice(&bin);
            WsEvent::Frame(bin.len())
        }
        Ok(Message::Text(txt)) => {
            out_buf.clear();
            out_buf.extend_from_slice(txt.as_bytes());
            WsEvent::Frame(txt.len())
        }
        Ok(Message::Close(_)) => WsEvent::Closed,
        Ok(Message::Ping(_)) => {
            // tungstenite handles responder automatically, return None to continue
            WsEvent::None
        }
        Ok(Message::Pong(_)) => WsEvent::None,
        Ok(Message::Frame(_)) => WsEvent::None,
        Err(tungstenite::Error::Io(e)) if e.kind() == std::io::ErrorKind::WouldBlock => {
            WsEvent::None
        }
        Err(tungstenite::Error::ConnectionClosed) => WsEvent::Closed,
        Err(_) => WsEvent::Error,
    }
}

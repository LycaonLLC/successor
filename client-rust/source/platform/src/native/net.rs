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
        // A server-sent Close carries the code and reason that say WHY the
        // shard hung up (e.g. 1011 "durable character entry failed"). Dropping
        // it leaves only "reconnect 1/5" and hides an authority-side refusal.
        Ok(Message::Close(frame)) => {
            match frame {
                Some(frame) => eprintln!("ws closed by peer: code={} reason={}", frame.code, frame.reason),
                None => eprintln!("ws closed by peer: no close frame"),
            }
            WsEvent::Closed
        }
        Ok(Message::Ping(_)) => {
            // tungstenite QUEUES the Pong; it only leaves the socket on the next
            // write or flush. An idle client never writes, so without this flush
            // the reply is never sent and Colyseus terminates the connection on
            // its liveness timeout -- an abrupt reset with no close frame, which
            // the client then reports only as "reconnect 1/5". A client that was
            // being driven kept the socket alive purely because its outbound
            // commands flushed the pong as a side effect.
            if let Err(error) = handle.socket.flush() {
                if !matches!(&error, tungstenite::Error::Io(io) if io.kind() == std::io::ErrorKind::WouldBlock)
                {
                    eprintln!("ws pong flush failed: {error}");
                    return WsEvent::Error;
                }
            }
            WsEvent::None
        }
        Ok(Message::Pong(_)) => WsEvent::None,
        Ok(Message::Frame(_)) => WsEvent::None,
        Err(tungstenite::Error::Io(e)) if e.kind() == std::io::ErrorKind::WouldBlock => {
            WsEvent::None
        }
        Err(tungstenite::Error::ConnectionClosed) => WsEvent::Closed,
        // `WsEvent` is a `Copy` enum shared with the wasm backend, so the cause
        // cannot ride along with it. Print it here rather than discard it: a
        // silent drop reports only "reconnect 1/5" and hides why the transport
        // died, which is indistinguishable from the authority refusing the join.
        Err(error) => {
            eprintln!("ws transport error: {error}");
            WsEvent::Error
        }
    }
}

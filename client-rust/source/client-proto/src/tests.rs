#[cfg(test)]
#[allow(clippy::module_inception)]
mod tests {
    use crate::colyseus;
    use crate::packets::{self, GameServerPacket};
    use crate::session::{Session, SessionEvent, SessionOut, SessionState, WsInput};
    use serde_json::json;

    // Load JSON fixtures
    const HELLO_JSON: &str = include_str!("../fixtures/game_hello.json");
    const SNAPSHOT_JSON: &str = include_str!("../fixtures/game_snapshot.json");
    const DELTA_JSON: &str = include_str!("../fixtures/game_delta.json");
    const RECEIPTS_JSON: &str = include_str!("../fixtures/game_receipts.json");
    const ACKS_JSON: &str = include_str!("../fixtures/game_acks.json");
    const ERROR_JSON: &str = include_str!("../fixtures/game_error.json");
    const PONG_JSON: &str = include_str!("../fixtures/pong.json");

    #[test]
    fn test_fixture_decoding() {
        // game.hello
        let packet: GameServerPacket = serde_json::from_str(HELLO_JSON).expect("decode game.hello");
        if let GameServerPacket::Hello(hello) = &packet {
            assert_eq!(hello.session_id, "test-session-id-12345");
            assert_eq!(hello.player_actor_id, "actor-player-1");
            assert_eq!(hello.snapshot.tick, 42);
            assert_eq!(hello.snapshot.shard_id, "open-desert-persistent");
            let player = hello
                .snapshot
                .actors
                .get("actor-player-1")
                .expect("player actor present");
            assert_eq!(player.display_name, "Dev Player");
            assert_eq!(player.vitals.health, 100.0);
        } else {
            panic!("Expected Hello packet");
        }

        // game.snapshot
        let packet: GameServerPacket =
            serde_json::from_str(SNAPSHOT_JSON).expect("decode game.snapshot");
        if let GameServerPacket::Snapshot {
            snapshot,
            receipts,
            events,
            ..
        } = &packet
        {
            assert_eq!(snapshot.tick, 43);
            assert_eq!(receipts.len(), 1);
            assert_eq!(receipts[0].command_id, 101);
            assert!(receipts[0].accepted);
            assert!(events.is_empty());
        } else {
            panic!("Expected Snapshot packet");
        }

        // game.delta
        let packet: GameServerPacket = serde_json::from_str(DELTA_JSON).expect("decode game.delta");
        if let GameServerPacket::Delta {
            delta,
            receipts,
            events,
            ..
        } = &packet
        {
            assert_eq!(delta.tick, 44);
            let patch = delta
                .actor_patches
                .get("actor-player-1")
                .expect("player patch present");
            assert_eq!(patch.x, Some(523.0));
            assert_eq!(receipts.len(), 1);
            assert!(events.is_empty());
        } else {
            panic!("Expected Delta packet");
        }

        // game.receipts
        let packet: GameServerPacket =
            serde_json::from_str(RECEIPTS_JSON).expect("decode game.receipts");
        if let GameServerPacket::Receipts {
            receipts, events, ..
        } = &packet
        {
            assert_eq!(receipts.len(), 1);
            assert_eq!(receipts[0].command_id, 103);
            assert!(events.is_empty());
        } else {
            panic!("Expected Receipts packet");
        }

        // game.acks
        let packet: GameServerPacket = serde_json::from_str(ACKS_JSON).expect("decode game.acks");
        if let GameServerPacket::Acks {
            acks,
            player_actor,
            player_position,
            ..
        } = &packet
        {
            assert_eq!(acks.len(), 1);
            assert_eq!(acks[0].0, 104);
            assert_eq!(acks[0].1, 1);
            assert_eq!(acks[0].2, 45);
            let player = player_actor.as_ref().expect("player actor present");
            assert_eq!(player.display_name, "Dev Player");
            let pos = player_position.as_ref().expect("player position present");
            assert_eq!(pos.0, 524.0);
            assert_eq!(pos.1, 520.0);
        } else {
            panic!("Expected Acks packet");
        }

        // game.error
        let packet: GameServerPacket = serde_json::from_str(ERROR_JSON).expect("decode game.error");
        if let GameServerPacket::Error { code, message } = &packet {
            assert_eq!(code, "INVALID_COMMAND");
            assert_eq!(message, "The move intent parameters are invalid.");
        } else {
            panic!("Expected Error packet");
        }

        // pong
        let packet: GameServerPacket = serde_json::from_str(PONG_JSON).expect("decode pong");
        if let GameServerPacket::Pong { request_id, at } = &packet {
            assert_eq!(request_id.as_deref(), Some("ping-req-456"));
            assert_eq!(*at, 1785293204217.0);
        } else {
            panic!("Expected Pong packet");
        }
    }

    #[test]
    fn test_colyseus_roundtrip() {
        let payload = json!({"foo": "bar", "val": 42});
        let encoded = colyseus::encode_room_message("my_test_type", &payload).unwrap();
        let decoded = colyseus::decode_inbound_frame(&encoded).unwrap();
        if let colyseus::InboundFrame::RoomData {
            msg_type,
            payload: decoded_payload,
        } = &decoded
        {
            assert_eq!(msg_type, "my_test_type");
            assert_eq!(decoded_payload, &payload);
        } else {
            panic!("Expected RoomData frame");
        }
    }

    #[test]
    fn test_matchmake_request_shape() {
        let endpoint = "ws://127.0.0.1:28093";
        let options = json!({"playerId": "test"});
        let (url, body) = colyseus::build_matchmake_request(endpoint, &options).unwrap();
        assert_eq!(url, "http://127.0.0.1:28093/matchmake/joinOrCreate/game");
        let body_val: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(body_val["playerId"], "test");
    }

    #[test]
    fn test_session_state_machine() {
        let mut session = Session::new();
        assert_eq!(session.state(), SessionState::Disconnected);

        session.start_connecting();
        assert_eq!(session.state(), SessionState::Connecting);

        // Open
        let outs = session.on_ws_event(WsInput::Open);
        assert_eq!(session.state(), SessionState::AwaitingJoinRoom);
        assert!(outs.is_empty());

        // JoinRoom frame
        let join_frame = vec![10, 3, b't', b'o', b'k', 4, b'j', b's', b'o', b'n'];
        let outs = session.on_ws_event(WsInput::Frame(&join_frame));
        assert_eq!(session.state(), SessionState::ExpectingHello);
        assert_eq!(outs.len(), 2, "join acks JOIN_ROOM then sends game.ready");
        assert_eq!(
            outs[0],
            SessionOut::SendFrame(vec![colyseus::opcodes::JOIN_ROOM])
        );
        match &outs[1] {
            SessionOut::SendFrame(ready_bytes) => {
                let decoded = colyseus::decode_inbound_frame(ready_bytes).unwrap();
                if let colyseus::InboundFrame::RoomData { msg_type, payload } = decoded {
                    assert_eq!(msg_type, packets::MSG_GAME_READY);
                    assert_eq!(payload, serde_json::Value::Null);
                } else {
                    panic!("Expected RoomData frame for game.ready on join");
                }
            }
            _ => panic!("Expected game.ready SendFrame on join"),
        }

        // game.hello packet
        let hello_packet = json!({
            "type": "game.hello",
            "sessionId": "sess-123",
            "playerActorId": "actor-1",
            "snapshot": {
                "schema": "successor.authoritative-shard-snapshot.v1",
                "shardId": "desert",
                "tick": 1,
                "playerActorId": "actor-1",
                "actors": {}
            },
            "serverTime": "time"
        });
        let hello_frame = colyseus::encode_room_message("game.packet", &hello_packet).unwrap();
        let outs = session.on_ws_event(WsInput::Frame(&hello_frame));
        assert_eq!(session.state(), SessionState::Ready);
        assert_eq!(outs.len(), 1, "hello only emits the Hello event now");
        match &outs[0] {
            SessionOut::Emit(SessionEvent::Hello(hello)) => {
                assert_eq!(hello.session_id, "sess-123");
            }
            _ => panic!("Expected Hello event"),
        }
    }

    #[test]
    fn test_reconnect_policy() {
        let mut session = Session::new();
        session.start_connecting();

        // Closed/Error triggers reconnect up to 5 times
        for i in 1..=5 {
            let outs = session.on_ws_event(WsInput::Closed);
            assert_eq!(session.state(), SessionState::Connecting);
            assert_eq!(outs.len(), 1);
            match &outs[0] {
                SessionOut::Emit(SessionEvent::ReconnectAttempt {
                    attempt,
                    max_attempts,
                }) => {
                    assert_eq!(*attempt, i);
                    assert_eq!(*max_attempts, 5);
                }
                _ => panic!("Expected ReconnectAttempt event"),
            }
        }

        // 6th event exhausts retries -> Failed state
        let outs = session.on_ws_event(WsInput::Closed);
        assert_eq!(session.state(), SessionState::Failed);
        assert_eq!(outs.len(), 1);
        assert_eq!(outs[0], SessionOut::Emit(SessionEvent::Closed));
    }

    fn http_post(url: &str, body: &[u8]) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
        use std::io::{Read, Write};
        use std::net::TcpStream;
        let parsed_url = url.replace("http://", "");
        let mut parts = parsed_url.splitn(2, '/');
        let host_port = parts.next().ok_or("Invalid host")?;
        let path = parts.next().unwrap_or("");

        let mut stream = TcpStream::connect(host_port)?;
        let request = format!(
            "POST /{} HTTP/1.1\r\nHost: {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            path, host_port, body.len()
        );
        stream.write_all(request.as_bytes())?;
        stream.write_all(body)?;

        let mut response = Vec::new();
        stream.read_to_end(&mut response)?;

        if let Some(pos) = response.windows(4).position(|w| w == b"\r\n\r\n") {
            Ok(response[pos + 4..].to_vec())
        } else {
            Err("Invalid HTTP response".into())
        }
    }

    #[test]
    #[ignore]
    fn test_live_integration() {
        use tungstenite::{connect, Message};

        let endpoint = "ws://127.0.0.1:28093";
        let options = json!({
            "playerId": "integration-test-player",
            "actorId": "integration-test-player",
            "displayName": "Rust Integration Test Agent",
            "zoneId": "open-desert",
            "spawnArea": "open-desert-overworld"
        });

        // 1. Matchmake
        let (matchmake_url, body) = colyseus::build_matchmake_request(endpoint, &options).unwrap();
        let seat_res_bytes =
            http_post(&matchmake_url, &body).expect("HTTP matchmaking request failed");
        let seat_res = colyseus::parse_seat_reservation(&seat_res_bytes)
            .expect("Failed to parse seat reservation");
        let ws_url = colyseus::build_ws_url(endpoint, &seat_res);

        // 2. WebSocket connect
        let (mut socket, _resp) = connect(ws_url).expect("WebSocket connection failed");
        let mut session = Session::new();
        session.start_connecting();

        let outs = session.on_ws_event(WsInput::Open);
        for out in outs {
            if let SessionOut::SendFrame(frame) = out {
                socket.send(Message::Binary(frame)).unwrap();
            }
        }

        // 3. Message loop
        loop {
            let msg = socket.read().expect("WebSocket read failed");
            match msg {
                Message::Binary(bytes) => {
                    let outs = session.on_ws_event(WsInput::Frame(&bytes));
                    for out in outs {
                        match out {
                            SessionOut::SendFrame(frame) => {
                                socket.send(Message::Binary(frame)).unwrap();
                            }
                            SessionOut::Emit(SessionEvent::Hello(_hello)) => {
                                // Success! Joined and authenticated.
                                socket.close(None).ok();
                                return;
                            }
                            SessionOut::Emit(SessionEvent::Closed) => {
                                panic!("Session closed unexpectedly");
                            }
                            SessionOut::Emit(SessionEvent::Error(err)) => {
                                panic!("Session error: {}", err);
                            }
                            _ => {}
                        }
                    }
                }
                Message::Close(_) => {
                    break;
                }
                _ => {}
            }
        }
    }
}

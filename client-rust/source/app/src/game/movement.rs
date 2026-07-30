//! WASD/arrow input -> `SetMoveIntent` command envelope. No local prediction:
//! the player capsule advances only when the authority streams the new position
//! (via `game.delta` / `game.acks`), exactly like the existing clients.

use successor_engine_core::input::Key;
use successor_net::{ClientCommand, ClientCommandEnvelope, PlayerId, SessionId};

/// Directional intent from the current key state. Convention: `+dx` = east
/// (D/Right), `+dy` = south (S/Down); the authority interprets the axes.
pub fn intent_from_keys(down: impl Fn(Key) -> bool) -> (i32, i32, bool) {
    let mut dx = 0;
    let mut dy = 0;
    if down(Key::A) || down(Key::Left) {
        dx -= 1;
    }
    if down(Key::D) || down(Key::Right) {
        dx += 1;
    }
    if down(Key::W) || down(Key::Up) {
        dy -= 1;
    }
    if down(Key::S) || down(Key::Down) {
        dy += 1;
    }
    let sprint = down(Key::LeftShift);
    (dx, dy, sprint)
}

/// Build a `SetMoveIntent` envelope reusing the shared `successor-net` vocabulary.
pub fn move_envelope(
    session: u64,
    player: u32,
    command_id: u64,
    tick: u64,
    dx: i32,
    dy: i32,
    sprint: bool,
) -> ClientCommandEnvelope {
    ClientCommandEnvelope {
        session: SessionId(session),
        player: PlayerId(player),
        command_id,
        issued_at_tick: tick,
        command: ClientCommand::SetMoveIntent { dx, dy, facing: None, sprint },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wd_gives_east_forward() {
        let down = |k: Key| matches!(k, Key::W | Key::D);
        assert_eq!(intent_from_keys(down), (1, -1, false));
    }

    #[test]
    fn shift_sprints_and_idle_is_zero() {
        assert_eq!(intent_from_keys(|k| k == Key::LeftShift), (0, 0, true));
        assert_eq!(intent_from_keys(|_| false), (0, 0, false));
    }

    #[test]
    fn envelope_carries_set_move_intent() {
        let e = move_envelope(7, 3, 1, 42, 1, 0, true);
        assert!(matches!(
            e.command,
            ClientCommand::SetMoveIntent { dx: 1, dy: 0, sprint: true, .. }
        ));
        assert_eq!((e.session.0, e.player.0, e.command_id, e.issued_at_tick), (7, 3, 1, 42));
    }
}

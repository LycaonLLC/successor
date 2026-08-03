//! WASD/arrow input -> `SetMoveIntent` command envelope. No local prediction:
//! the player capsule advances only when the authority streams the new position
//! (via `game.delta` / `game.acks`), exactly like the existing clients.

use std::collections::{HashMap, VecDeque};
use successor_engine_core::input::Key;
use successor_net::{CardinalDirection, ClientCommand, ClientCommandEnvelope, PlayerId, SessionId};

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

/// Convert the current directional intent to the protocol's four-way facing.
/// Diagonal movement keeps its dominant axis; a tie is resolved horizontally
/// for deterministic replay.
pub fn facing_from_intent(dx: i32, dy: i32) -> Option<CardinalDirection> {
    match (dx, dy) {
        (0, y) if y < 0 => Some(CardinalDirection::Front),
        (x, 0) if x > 0 => Some(CardinalDirection::Right),
        (0, y) if y > 0 => Some(CardinalDirection::Back),
        (x, 0) if x < 0 => Some(CardinalDirection::Left),
        (x, y) if x.abs() >= y.abs() && x > 0 => Some(CardinalDirection::Right),
        (x, y) if x.abs() >= y.abs() && x < 0 => Some(CardinalDirection::Left),
        (_, y) if y < 0 => Some(CardinalDirection::Front),
        (_, y) if y > 0 => Some(CardinalDirection::Back),
        _ => None,
    }
}

/// An input edge that must stop movement. This is intentionally independent
/// of rendering/window state so every platform shell can apply it identically.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StopReason {
    FocusLost,
    ModalInput,
    Disconnected,
    Transition,
    Dead,
    ControlReleased,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct IntentState {
    pub dx: i32,
    pub dy: i32,
    pub sprint: bool,
}

impl IntentState {
    pub fn stopped(self) -> bool {
        self.dx == 0 && self.dy == 0 && !self.sprint
    }
    pub fn release(&mut self, _reason: StopReason) {
        *self = Self::default();
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PointerTarget {
    Actor,
    Prop,
    Empty,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PointerGesture {
    LeftClick,
    RightClick,
    DoubleLeft,
    RightHold,
}

/// Normalize pointer grammar before verb lookup. Empty clicks never teleport:
/// the caller turns `MoveTo` into successive authority intents.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PointerAction {
    Select,
    OpenRadial,
    DefaultAction,
    MoveTo,
    FaceOrStrafe,
    ClearSelection,
}

pub fn pointer_action(target: PointerTarget, gesture: PointerGesture) -> PointerAction {
    match (target, gesture) {
        (PointerTarget::Actor, PointerGesture::LeftClick) => PointerAction::Select,
        (PointerTarget::Actor, PointerGesture::RightClick) => PointerAction::OpenRadial,
        (PointerTarget::Actor, PointerGesture::RightHold) => PointerAction::FaceOrStrafe,
        (PointerTarget::Actor, PointerGesture::DoubleLeft) => PointerAction::DefaultAction,
        (PointerTarget::Empty, PointerGesture::LeftClick) => PointerAction::MoveTo,
        (PointerTarget::Empty, PointerGesture::RightHold) => PointerAction::FaceOrStrafe,
        (PointerTarget::Empty, _) => PointerAction::ClearSelection,
        (PointerTarget::Prop, PointerGesture::RightClick) => PointerAction::OpenRadial,
        (PointerTarget::Prop, PointerGesture::DoubleLeft) => PointerAction::DefaultAction,
        (PointerTarget::Prop, _) => PointerAction::Select,
    }
}
/// Deterministic eight-neighbor route. Search is bounded around the endpoints;
/// diagonal steps require both adjacent cardinal cells to be clear.
pub fn route_grid(
    start: (i32, i32),
    goal: (i32, i32),
    mut blocked: impl FnMut(i32, i32) -> bool,
) -> Option<Vec<(i32, i32)>> {
    const NEIGHBORS: [(i32, i32); 8] = [
        (0, -1),
        (1, 0),
        (0, 1),
        (-1, 0),
        (1, -1),
        (1, 1),
        (-1, 1),
        (-1, -1),
    ];
    let margin = 32;
    let min_x = start.0.min(goal.0) - margin;
    let max_x = start.0.max(goal.0) + margin;
    let min_y = start.1.min(goal.1) - margin;
    let max_y = start.1.max(goal.1) + margin;
    let mut queue = VecDeque::from([start]);
    let mut previous = HashMap::from([(start, start)]);
    while let Some(cell) = queue.pop_front() {
        if cell == goal {
            let mut route = Vec::new();
            let mut cursor = goal;
            while cursor != start {
                route.push(cursor);
                cursor = previous[&cursor];
            }
            route.reverse();
            return Some(route);
        }
        for (dx, dy) in NEIGHBORS {
            let next = (cell.0 + dx, cell.1 + dy);
            if next.0 < min_x
                || next.0 > max_x
                || next.1 < min_y
                || next.1 > max_y
                || previous.contains_key(&next)
                || (next != goal && blocked(next.0, next.1))
                || (dx != 0
                    && dy != 0
                    && (blocked(cell.0 + dx, cell.1) || blocked(cell.0, cell.1 + dy)))
            {
                continue;
            }
            previous.insert(next, cell);
            queue.push_back(next);
        }
    }
    None
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
        command: ClientCommand::SetMoveIntent {
            dx,
            dy,
            facing: facing_from_intent(dx, dy),
            sprint,
        },
    }
}

/// A stopped intent is still sent through the queue so the authority observes
/// key-up/focus-loss, rather than the client merely hiding local movement.
pub fn stop_envelope(
    session: u64,
    player: u32,
    command_id: u64,
    tick: u64,
) -> ClientCommandEnvelope {
    move_envelope(session, player, command_id, tick, 0, 0, false)
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
            ClientCommand::SetMoveIntent {
                dx: 1,
                dy: 0,

                sprint: true,
                ..
            }
        ));
        assert_eq!(
            (e.session.0, e.player.0, e.command_id, e.issued_at_tick),
            (7, 3, 1, 42)
        );
    }
    #[test]
    fn facing_is_cardinal_and_release_is_authoritative() {
        assert_eq!(facing_from_intent(1, -1), Some(CardinalDirection::Right));
        let mut intent = IntentState {
            dx: 1,
            dy: 0,
            sprint: true,
        };
        intent.release(StopReason::FocusLost);
        assert!(intent.stopped());
        let stop = stop_envelope(1, 2, 3, 4);
        assert!(matches!(
            stop.command,
            ClientCommand::SetMoveIntent {
                dx: 0,
                dy: 0,
                sprint: false,
                ..
            }
        ));
    }
    #[test]
    fn pointer_grammar_is_deterministic() {
        assert_eq!(
            pointer_action(PointerTarget::Actor, PointerGesture::RightClick),
            PointerAction::OpenRadial
        );
        assert_eq!(
            pointer_action(PointerTarget::Empty, PointerGesture::LeftClick),
            PointerAction::MoveTo
        );
        assert_eq!(
            pointer_action(PointerTarget::Empty, PointerGesture::RightHold),
            PointerAction::FaceOrStrafe
        );
    }
    #[test]
    fn route_detours_around_blocked_cells() {
        let blocked = [(1, 0), (1, 1), (1, 2)];
        let route = route_grid((0, 1), (2, 1), |x, y| blocked.contains(&(x, y)))
            .expect("route around wall");
        assert_eq!(route.last(), Some(&(2, 1)));
        assert!(route.iter().all(|cell| !blocked.contains(cell)));
    }

    #[test]
    fn route_rejects_diagonal_corner_cutting() {
        let blocked = [(1, 0), (0, 1)];
        let route = route_grid((0, 0), (1, 1), |x, y| blocked.contains(&(x, y)));
        assert!(route.is_some());
        assert_ne!(route.unwrap().first(), Some(&(1, 1)));
    }
}

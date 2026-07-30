//! Outbound authority command queue — port of `authorityCommandSystem.ts`
//! queue semantics: a per-process command-id floor (ms-timestamp namespace so
//! reconnects never restart at 1), priority-ordered flush (not global FIFO) with
//! command-id tiebreak, and settle-on-receipt / defer-in-flight. Commands reuse
//! `successor_net::{ClientCommand, ClientCommandEnvelope}`.

use successor_net::{ClientCommand, ClientCommandEnvelope, PlayerId, SessionId};

/// Server tick rate the move cadence targets (`targetMoveCommandsPerSecond`).
pub const MOVE_COMMANDS_PER_SECOND: u32 = 20;

/// Milliseconds between move-intent sends at the target cadence.
pub fn move_interval_ms() -> f32 {
    1000.0 / MOVE_COMMANDS_PER_SECOND as f32
}

/// A fresh command-id floor: `ms * 1000 + seq` (seq wraps 1..=999) so two
/// clients created in the same millisecond, and reconnects, never collide.
pub fn next_command_id_floor(now_ms: u64, seq: &mut u64) -> u64 {
    *seq = if *seq >= 999 { 1 } else { *seq + 1 };
    now_ms.max(1) * 1000 + *seq
}

/// Priority class for flush ordering (lower = sent first). Mirrors
/// `gameAuthoritySystem.ts::commandPriority`.
pub fn command_priority(command: &ClientCommand) -> u8 {
    match command_kind(command).as_str() {
        "CloneRespawn" | "ReviveActor" | "UseConsumable" | "RefillAmmo" | "ApplyServiceBuff"
        | "SampleResource" | "HarvestCorpse" | "TakeLootItem" | "CraftItem" | "PurchaseSkillBox"
        | "SetProfessionTitle" | "SetCareerGoal" => 0,
        "Move" => 2,
        _ => 3,
    }
}

/// The externally-tagged variant name of a command (its serde object key).
pub fn command_kind(command: &ClientCommand) -> String {
    serde_json::to_value(command)
        .ok()
        .and_then(|v| v.as_object().and_then(|o| o.keys().next().cloned()))
        .unwrap_or_default()
}

pub struct CommandQueue {
    session: SessionId,
    player: PlayerId,
    next_id: u64,
    pending: Vec<ClientCommandEnvelope>,
    in_flight: Option<ClientCommandEnvelope>,
    pub total_queued: u64,
}

impl CommandQueue {
    pub fn new(session: SessionId, player: PlayerId, command_id_floor: u64) -> Self {
        CommandQueue {
            session,
            player,
            next_id: command_id_floor.max(1),
            pending: Vec::new(),
            in_flight: None,
            total_queued: 0,
        }
    }

    /// Enqueue a command; returns its assigned command id.
    pub fn enqueue(&mut self, command: ClientCommand, issued_at_tick: u64) -> u64 {
        let command_id = self.next_id;
        self.next_id += 1;
        self.total_queued += 1;
        self.pending.push(ClientCommandEnvelope {
            session: self.session,
            player: self.player,
            command_id,
            issued_at_tick,
            command,
        });
        command_id
    }

    /// A copy of the pending commands in transmission order (priority, then id).
    pub fn flush_order(&self) -> Vec<ClientCommandEnvelope> {
        let mut out = self.pending.clone();
        out.sort_by(|a, b| {
            command_priority(&a.command)
                .cmp(&command_priority(&b.command))
                .then(a.command_id.cmp(&b.command_id))
        });
        out
    }

    /// Move the highest-priority pending command into the in-flight slot and
    /// return it (for sending). Only one command is in flight at a time.
    pub fn take_next(&mut self) -> Option<ClientCommandEnvelope> {
        if self.in_flight.is_some() || self.pending.is_empty() {
            return None;
        }
        // Pick the flush-order head.
        let mut best = 0usize;
        for i in 1..self.pending.len() {
            let (pi, ci) = (command_priority(&self.pending[i].command), self.pending[i].command_id);
            let (pb, cb) = (command_priority(&self.pending[best].command), self.pending[best].command_id);
            if pi < pb || (pi == pb && ci < cb) {
                best = i;
            }
        }
        let env = self.pending.remove(best);
        self.in_flight = Some(env.clone());
        Some(env)
    }

    /// Settle the command named by a receipt: clears the in-flight slot if it
    /// matches, else removes it from pending. Returns true if found.
    pub fn settle(&mut self, command_id: u64) -> bool {
        if self.in_flight.as_ref().map(|e| e.command_id) == Some(command_id) {
            self.in_flight = None;
            return true;
        }
        if let Some(pos) = self.pending.iter().position(|e| e.command_id == command_id) {
            self.pending.remove(pos);
            return true;
        }
        false
    }

    /// Requeue an unsettled in-flight command at the pending head (flush still
    /// re-orders by priority).
    pub fn defer_in_flight(&mut self) -> bool {
        if let Some(env) = self.in_flight.take() {
            self.pending.insert(0, env);
            true
        } else {
            false
        }
    }

    pub fn pending_len(&self) -> usize {
        self.pending.len()
    }

    pub fn in_flight(&self) -> Option<&ClientCommandEnvelope> {
        self.in_flight.as_ref()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn q() -> CommandQueue {
        CommandQueue::new(SessionId(1), PlayerId(1), 1000)
    }

    #[test]
    fn id_floor_namespaced() {
        let mut seq = 0;
        let a = next_command_id_floor(5, &mut seq);
        let b = next_command_id_floor(5, &mut seq);
        assert_eq!(a, 5001);
        assert_eq!(b, 5002);
        // Wraps seq at 999.
        let mut seq = 999;
        assert_eq!(next_command_id_floor(2, &mut seq), 2001);
    }

    #[test]
    fn priority_classes() {
        assert_eq!(command_priority(&ClientCommand::CloneRespawn { facility_id: None }), 0);
        assert_eq!(command_priority(&ClientCommand::Peace {}), 3);
    }

    #[test]
    fn enqueue_assigns_increasing_ids() {
        let mut q = q();
        let a = q.enqueue(ClientCommand::Peace {}, 1);
        let b = q.enqueue(ClientCommand::Peace {}, 1);
        assert_eq!(a, 1000);
        assert_eq!(b, 1001);
        assert_eq!(q.total_queued, 2);
    }

    #[test]
    fn flush_order_priority_then_id() {
        let mut q = q();
        // Enqueue a low-priority Peace FIRST, then a high-priority CloneRespawn.
        q.enqueue(ClientCommand::Peace {}, 1); // id 1000, priority 3
        q.enqueue(ClientCommand::CloneRespawn { facility_id: None }, 1); // id 1001, priority 0
        let order = q.flush_order();
        assert_eq!(order[0].command_id, 1001, "high-priority CloneRespawn first");
        assert_eq!(order[1].command_id, 1000);
    }

    #[test]
    fn take_settle_and_defer() {
        let mut q = q();
        q.enqueue(ClientCommand::Peace {}, 1); // 1000
        let cr = q.enqueue(ClientCommand::CloneRespawn { facility_id: None }, 1); // 1001
        // take_next picks the high-priority one.
        let taken = q.take_next().unwrap();
        assert_eq!(taken.command_id, cr);
        // While one is in flight, take_next yields nothing.
        assert!(q.take_next().is_none());
        // Defer requeues it.
        assert!(q.defer_in_flight());
        assert_eq!(q.pending_len(), 2);
        // Settle by id removes from pending.
        assert!(q.settle(1000));
        assert_eq!(q.pending_len(), 1);
    }
}

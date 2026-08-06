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

/// Movement receipts are diagnostic, not a serialization barrier. Retain only
/// a bounded recent set while newer intent commands continue transmitting.
const MAX_MOVEMENT_IN_FLIGHT: usize = 8;

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
        | "SampleResource" | "HarvestCorpse" | "TakeLootItem" | "CraftItem"
        | "PurchaseSkillBox" | "SetProfessionTitle" | "SetCareerGoal" => 0,
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

#[derive(Clone)]
pub struct CommandQueue {
    session: SessionId,
    player: PlayerId,
    next_id: u64,
    pending: Vec<ClientCommandEnvelope>,
    in_flight: Option<ClientCommandEnvelope>,
    movement_in_flight: Vec<ClientCommandEnvelope>,
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
            movement_in_flight: Vec::with_capacity(MAX_MOVEMENT_IN_FLIGHT),
            total_queued: 0,
        }
    }

    fn is_move(command: &ClientCommand) -> bool {
        matches!(command, ClientCommand::SetMoveIntent { .. })
    }

    /// Enqueue a command; returns its assigned command id. A queued movement
    /// heartbeat is superseded by the latest intent while another command is
    /// in flight, keeping held movement bounded during authority latency.
    pub fn enqueue(&mut self, command: ClientCommand, issued_at_tick: u64) -> u64 {
        let command_id = self.next_id;
        self.next_id += 1;
        self.total_queued += 1;
        let envelope = ClientCommandEnvelope {
            session: self.session,
            player: self.player,
            command_id,
            issued_at_tick,
            command,
        };
        if Self::is_move(&envelope.command) {
            if let Some(index) = self
                .pending
                .iter()
                .rposition(|pending| Self::is_move(&pending.command))
            {
                self.pending[index] = envelope;
                return command_id;
            }
        }
        self.pending.push(envelope);
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

    /// Move the highest-priority eligible command into its lane and return it.
    /// Transactional commands remain single-flight; movement uses an independent
    /// bounded lane so a delayed inventory/crafting receipt cannot stall input.
    pub fn take_next(&mut self) -> Option<ClientCommandEnvelope> {
        if self.pending.is_empty() {
            return None;
        }
        let mut best = None;
        for (index, pending) in self.pending.iter().enumerate() {
            if self.in_flight.is_some() && !Self::is_move(&pending.command) {
                continue;
            }
            let replace = best.is_none_or(|current: usize| {
                let candidate = (
                    command_priority(&pending.command),
                    pending.command_id,
                );
                let selected = (
                    command_priority(&self.pending[current].command),
                    self.pending[current].command_id,
                );
                candidate < selected
            });
            if replace {
                best = Some(index);
            }
        }
        let env = self.pending.remove(best?);
        if Self::is_move(&env.command) {
            if self.movement_in_flight.len() == MAX_MOVEMENT_IN_FLIGHT {
                self.movement_in_flight.remove(0);
            }
            self.movement_in_flight.push(env.clone());
        } else {
            self.in_flight = Some(env.clone());
        }
        Some(env)
    }

    /// Settle the command named by a receipt: clears the in-flight slot if it
    /// matches, else removes it from pending. Returns true if found.
    pub fn settle(&mut self, command_id: u64) -> bool {
        if self.in_flight.as_ref().map(|e| e.command_id) == Some(command_id) {
            self.in_flight = None;
            return true;
        }
        if let Some(pos) = self
            .movement_in_flight
            .iter()
            .position(|envelope| envelope.command_id == command_id)
        {
            self.movement_in_flight.remove(pos);
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
    /// Reconnects replay transactional commands idempotently. Movement already
    /// sent on the old transport is discarded; the controller re-announces the
    /// current desired state on its bounded wall-clock cadence.
    pub fn reconcile_reconnect(&mut self) {
        let _ = self.defer_in_flight();
        self.movement_in_flight.clear();
    }

    pub fn settle_many(&mut self, command_ids: impl IntoIterator<Item = u64>) {
        for id in command_ids {
            self.settle(id);
        }
    }

    pub fn pending_envelopes(&self) -> impl Iterator<Item = &ClientCommandEnvelope> {
        self.pending
            .iter()
            .chain(self.in_flight.iter())
            .chain(self.movement_in_flight.iter())
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
        assert_eq!(
            command_priority(&ClientCommand::CloneRespawn { facility_id: None }),
            0
        );
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
        assert_eq!(
            order[0].command_id, 1001,
            "high-priority CloneRespawn first"
        );
        assert_eq!(order[1].command_id, 1000);
    }
    #[test]
    fn queued_movement_is_coalesced_while_receipt_is_delayed() {
        let mut q = q();
        let first = q.enqueue(
            ClientCommand::SetMoveIntent {
                dx: 1,
                dy: 0,
                facing: None,
                sprint: false,
            },
            1,
        );
        assert_eq!(q.take_next().unwrap().command_id, first);
        q.enqueue(
            ClientCommand::SetMoveIntent {
                dx: 1,
                dy: 0,
                facing: None,
                sprint: false,
            },
            2,
        );
        let latest = q.enqueue(
            ClientCommand::SetMoveIntent {
                dx: 0,
                dy: -1,
                facing: None,
                sprint: true,
            },
            3,
        );
        assert_eq!(q.pending_len(), 1);
        assert!(q.settle(first));
        assert_eq!(q.take_next().unwrap().command_id, latest);
    }

    #[test]
    fn movement_lane_bypasses_delayed_transaction_receipt() {
        let mut q = q();
        let transaction =
            q.enqueue(ClientCommand::CloneRespawn { facility_id: None }, 1);
        assert_eq!(q.take_next().unwrap().command_id, transaction);
        let movement = q.enqueue(
            ClientCommand::SetMoveIntent {
                dx: 1,
                dy: 0,
                facing: None,
                sprint: false,
            },
            2,
        );
        assert_eq!(q.take_next().unwrap().command_id, movement);
        assert!(q.in_flight().is_some_and(|env| env.command_id == transaction));
        assert!(q.settle(movement));
        assert!(q.settle(transaction));
    }

    #[test]
    fn reconnect_drops_old_transport_movement_but_replays_transaction() {
        let mut q = q();
        let transaction =
            q.enqueue(ClientCommand::CloneRespawn { facility_id: None }, 1);
        assert_eq!(q.take_next().unwrap().command_id, transaction);
        let movement = q.enqueue(
            ClientCommand::SetMoveIntent {
                dx: 0,
                dy: -1,
                facing: None,
                sprint: true,
            },
            2,
        );
        assert_eq!(q.take_next().unwrap().command_id, movement);
        q.reconcile_reconnect();
        assert_eq!(q.pending_len(), 1);
        assert!(!q.pending_envelopes().any(|env| env.command_id == movement));
        assert_eq!(q.take_next().unwrap().command_id, transaction);
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

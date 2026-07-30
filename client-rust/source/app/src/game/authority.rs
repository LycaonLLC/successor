//! App-side authority store — mirrors `PlayState.serverAuthority` and applies
//! snapshots/deltas/receipts with the semantics ported from
//! `gameAuthoritySystem.ts`:
//!   - snapshot fully replaces actors + present sections;
//!   - delta merges actor patches / compact moves, honours `actorRemovals`,
//!     and uses the present-key-replaces / absent-key-retains rule for sections;
//!   - actor updates are gated on `lifecycleSeq` (stale generations ignored);
//!   - `respawning` actors are excluded from the render set;
//!   - receipts are de-duplicated over a bounded window (512).
//!
//! Values for the optional sections are retained as `serde_json::Value` (the
//! window layer decodes what it needs); the actor and counter data are typed.

use std::collections::{HashMap, VecDeque};

use serde_json::Value;
use successor_client_proto::packets::{
    GameActorPatch, GameActorSnapshot, GameCounters, GameShardDelta, GameShardSnapshot,
};

const RECEIPT_DEDUPE_MAX: usize = 512;
const MOVE_QUANTIZATION: f32 = 100.0;

#[derive(Default)]
pub struct AuthorityStore {
    pub tick: u64,
    pub player_actor_id: String,
    pub actors: HashMap<String, GameActorSnapshot>,
    pub inventory: Vec<Value>,
    pub bank: Option<Value>,
    pub building: Option<Value>,
    pub groups: Option<Value>,
    pub guilds: Option<Value>,
    pub duels: Option<Value>,
    pub prop_states: HashMap<String, Value>,
    pub world_clock: Option<Value>,
    pub weather: Vec<Value>,
    pub counters: Option<GameCounters>,
    pub source_state_hash: Option<String>,
    /// net id → actor id (built from delta `actorRefs`, persistent).
    net_refs: HashMap<u32, String>,
    receipt_seen: VecDeque<u64>,
    receipt_set: std::collections::HashSet<u64>,
}

impl AuthorityStore {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn apply_snapshot(&mut self, snap: &GameShardSnapshot) {
        self.tick = snap.tick;
        self.player_actor_id = snap.player_actor_id.clone();
        self.actors = snap.actors.clone();
        // Present-key sections replace wholesale.
        self.inventory = snap.inventory.clone();
        self.bank = snap.bank.clone();
        self.building = snap.building.clone();
        self.groups = snap.groups.clone();
        self.guilds = snap.guilds.clone();
        self.duels = snap.duels.clone();
        self.prop_states = snap.prop_states.clone();
        self.world_clock = snap.world_clock.clone();
        self.weather = snap.weather.clone();
        self.counters = snap.counters;
        self.source_state_hash = snap.source_state_hash.clone();
    }

    pub fn apply_delta(&mut self, delta: &GameShardDelta) {
        self.tick = delta.tick;
        // Update the netId table first (refs precede compact moves).
        for r in &delta.actor_refs {
            self.net_refs.insert(r.0, r.1.clone());
        }
        // Full actor entries replace/insert.
        for (id, actor) in &delta.actors {
            if self.actor_is_stale(id, actor.lifecycle_seq) {
                continue;
            }
            self.actors.insert(id.clone(), actor.clone());
        }
        // Field patches merge.
        for (id, patch) in &delta.actor_patches {
            self.apply_patch(id, patch);
        }
        // Compact moves (netId → actor, /100 dequant).
        for m in &delta.compact_actor_moves {
            if let Some(id) = self.net_refs.get(&m.0).cloned() {
                if let Some(actor) = self.actors.get_mut(&id) {
                    actor.x = m.1 as f32 / MOVE_QUANTIZATION;
                    actor.y = m.2 as f32 / MOVE_QUANTIZATION;
                    actor.direction = direction_from_compact(m.3);
                }
            }
        }
        for id in &delta.actor_removals {
            self.actors.remove(id);
        }
        // Sections: present replaces, absent retains.
        if !delta.inventory.is_empty() {
            self.inventory = delta.inventory.clone();
        }
        if delta.bank.is_some() {
            self.bank = delta.bank.clone();
        }
        if delta.building.is_some() {
            self.building = delta.building.clone();
        }
        if delta.groups.is_some() {
            self.groups = delta.groups.clone();
        }
        if delta.guilds.is_some() {
            self.guilds = delta.guilds.clone();
        }
        if delta.duels.is_some() {
            self.duels = delta.duels.clone();
        }
        if !delta.prop_states.is_empty() {
            for (k, v) in &delta.prop_states {
                self.prop_states.insert(k.clone(), v.clone());
            }
        }
        if delta.world_clock.is_some() {
            self.world_clock = delta.world_clock.clone();
        }
        if !delta.weather.is_empty() {
            self.weather = delta.weather.clone();
        }
        if delta.counters.is_some() {
            self.counters = delta.counters;
        }
        if delta.source_state_hash.is_some() {
            self.source_state_hash = delta.source_state_hash.clone();
        }
    }

    fn apply_patch(&mut self, id: &str, patch: &GameActorPatch) {
        if let Some(seq) = patch.lifecycle_seq {
            if self.actor_is_stale(id, seq) {
                return;
            }
        }
        let Some(a) = self.actors.get_mut(id) else { return };
        if let Some(v) = &patch.area_id {
            a.area_id = v.clone();
        }
        if let Some(v) = patch.x {
            a.x = v;
        }
        if let Some(v) = patch.y {
            a.y = v;
        }
        if let Some(v) = &patch.direction {
            a.direction = v.clone();
        }
        if let Some(v) = patch.vitals {
            a.vitals = v;
        }
        if let Some(v) = patch.max_vitals {
            a.max_vitals = v;
        }
        if let Some(v) = &patch.life_state {
            a.life_state = v.clone();
        }
        if let Some(v) = patch.lifecycle_seq {
            a.lifecycle_seq = v;
        }
        if let Some(v) = &patch.label {
            a.label = v.clone();
        }
        if let Some(v) = &patch.sprite {
            a.sprite = Some(v.clone());
        }
        if let Some(v) = &patch.role {
            a.role = Some(v.clone());
        }
        if let Some(v) = &patch.posture {
            a.posture = Some(v.clone());
        }
        if let Some(v) = &patch.appearance {
            a.appearance = Some(v.clone());
        }
        if let Some(v) = &patch.worn {
            a.worn = v.clone();
        }
    }

    /// An update for `id` is stale if it carries a lower `lifecycleSeq` than the
    /// actor we already hold (a late packet from a previous life).
    fn actor_is_stale(&self, id: &str, incoming_seq: i64) -> bool {
        self.actors.get(id).map(|a| incoming_seq < a.lifecycle_seq).unwrap_or(false)
    }

    /// De-duplicate a command receipt over a bounded window. Returns true if the
    /// receipt is new (should be processed), false if already seen.
    pub fn accept_receipt(&mut self, command_id: u64) -> bool {
        if self.receipt_set.contains(&command_id) {
            return false;
        }
        self.receipt_set.insert(command_id);
        self.receipt_seen.push_back(command_id);
        if self.receipt_seen.len() > RECEIPT_DEDUPE_MAX {
            if let Some(old) = self.receipt_seen.pop_front() {
                self.receipt_set.remove(&old);
            }
        }
        true
    }

    /// Actors that should be rendered: alive/downed, excluding `respawning`.
    pub fn render_actors(&self) -> impl Iterator<Item = (&String, &GameActorSnapshot)> {
        self.actors.iter().filter(|(_, a)| a.life_state != "respawning")
    }
}

fn direction_from_compact(dir: u8) -> String {
    match dir {
        1 => "right",
        2 => "back",
        3 => "left",
        _ => "front",
    }
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use successor_client_proto::packets::{GameActorNetRef, GameActorVitals, GameCompactActorMove};

    fn actor(id: &str, x: f32, y: f32, seq: i64) -> GameActorSnapshot {
        GameActorSnapshot {
            id: id.into(),
            x,
            y,
            life_state: "alive".into(),
            lifecycle_seq: seq,
            vitals: GameActorVitals { health: 100.0, action: 100.0, spirit: 100.0 },
            ..Default::default()
        }
    }

    fn snap_with(actors: Vec<GameActorSnapshot>) -> GameShardSnapshot {
        let mut s = GameShardSnapshot { tick: 1, player_actor_id: "me".into(), ..Default::default() };
        for a in actors {
            s.actors.insert(a.id.clone(), a);
        }
        s
    }

    #[test]
    fn snapshot_then_delta_patch_and_remove() {
        let mut store = AuthorityStore::new();
        store.apply_snapshot(&snap_with(vec![actor("me", 0.0, 0.0, 1), actor("bob", 5.0, 5.0, 1)]));
        assert_eq!(store.actors.len(), 2);

        let mut d = GameShardDelta { tick: 2, ..Default::default() };
        d.actor_patches.insert("bob".into(), GameActorPatch { id: "bob".into(), x: Some(9.0), ..Default::default() });
        d.actor_removals.push("me".into());
        store.apply_delta(&d);
        assert!(store.actors.get("me").is_none());
        assert_eq!(store.actors.get("bob").unwrap().x, 9.0);
        assert_eq!(store.tick, 2);
    }

    #[test]
    fn compact_move_resolves_netid() {
        let mut store = AuthorityStore::new();
        store.apply_snapshot(&snap_with(vec![actor("bob", 0.0, 0.0, 1)]));
        let mut d = GameShardDelta { tick: 2, ..Default::default() };
        d.actor_refs.push(GameActorNetRef(7, "bob".into()));
        d.compact_actor_moves.push(GameCompactActorMove(7, 51200, 50300, 2));
        store.apply_delta(&d);
        let bob = store.actors.get("bob").unwrap();
        assert!((bob.x - 512.0).abs() < 1e-3);
        assert!((bob.y - 503.0).abs() < 1e-3);
        assert_eq!(bob.direction, "back");
    }

    #[test]
    fn stale_generation_ignored() {
        let mut store = AuthorityStore::new();
        store.apply_snapshot(&snap_with(vec![actor("bob", 0.0, 0.0, 5)]));
        let mut d = GameShardDelta { tick: 2, ..Default::default() };
        // Late patch from a previous life (seq 3 < current 5): ignored.
        d.actor_patches.insert("bob".into(), GameActorPatch { id: "bob".into(), x: Some(99.0), lifecycle_seq: Some(3), ..Default::default() });
        store.apply_delta(&d);
        assert_eq!(store.actors.get("bob").unwrap().x, 0.0);
    }

    #[test]
    fn section_present_replaces_absent_retains() {
        let mut store = AuthorityStore::new();
        let mut s = snap_with(vec![]);
        s.bank = Some(serde_json::json!({"credits": 100}));
        store.apply_snapshot(&s);
        assert!(store.bank.is_some());
        // Delta without bank retains it.
        store.apply_delta(&GameShardDelta { tick: 2, ..Default::default() });
        assert!(store.bank.is_some());
        // Delta with bank replaces it.
        let mut d = GameShardDelta { tick: 3, ..Default::default() };
        d.bank = Some(serde_json::json!({"credits": 250}));
        store.apply_delta(&d);
        assert_eq!(store.bank.as_ref().unwrap()["credits"], 250);
    }

    #[test]
    fn receipt_dedupe_window() {
        let mut store = AuthorityStore::new();
        assert!(store.accept_receipt(1));
        assert!(!store.accept_receipt(1));
        assert!(store.accept_receipt(2));
    }

    #[test]
    fn respawning_excluded_from_render() {
        let mut store = AuthorityStore::new();
        let mut dead = actor("ghost", 1.0, 1.0, 1);
        dead.life_state = "respawning".into();
        store.apply_snapshot(&snap_with(vec![actor("bob", 0.0, 0.0, 1), dead]));
        let rendered: Vec<_> = store.render_actors().map(|(id, _)| id.clone()).collect();
        assert!(rendered.contains(&"bob".to_string()));
        assert!(!rendered.contains(&"ghost".to_string()));
    }
}

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

use std::collections::{HashMap, HashSet, VecDeque};

use serde_json::Value;
use successor_client_proto::packets::{
    GameActorPatch, GameActorSnapshot, GameCommandReceipt, GameCounters, GameShardDelta,
    GameShardSnapshot,
};

const RECEIPT_DEDUPE_MAX: usize = 512;
const MOVE_QUANTIZATION: f32 = 100.0;

#[derive(Default, Clone)]
pub struct AuthorityStore {
    pub tick: u64,
    pub player_actor_id: String,
    pub actors: HashMap<String, GameActorSnapshot>,
    pub inventory: Vec<Value>,
    pub reservations: Vec<Value>,
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
    net_refs: HashMap<u32, String>,
    combat_events: VecDeque<Value>,
    receipt_set: HashSet<u64>,
    receipt_seen: VecDeque<u64>,
    pub player_corpses: Vec<Value>,
    pub resource_spawns: Vec<Value>,
    pub placed_extractors: Vec<Value>,
    pub placed_camps: Vec<Value>,
    pub placed_parcels: Vec<Value>,
    pub farm_plots: Vec<Value>,
    pub drafted_schematics: Vec<Value>,
    pub craft_session: Option<Value>,
    pub splice_session: Option<Value>,
    pub trade_session: Option<Value>,
    pub survey_results: Vec<Value>,
    pub genome_scans: Vec<Value>,
    pub duel_outcomes: Vec<Value>,
    pub bug_report_result: Option<Value>,
    pub dialogue_deliveries: Vec<Value>,
    pub ability_queue: Option<Value>,
    pub last_receipt: Option<GameCommandReceipt>,
}

impl AuthorityStore {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn apply_snapshot(&mut self, snap: &GameShardSnapshot) {
        self.tick = snap.tick;
        self.player_actor_id = snap.player_actor_id.clone();
        self.actors = snap.actors.clone();
        self.inventory = snap.inventory.clone();
        self.reservations = snap.reservations.clone();
        self.player_corpses = snap.player_corpses.clone();
        self.resource_spawns = snap.resource_spawns.clone();
        self.placed_extractors = snap.placed_extractors.clone();
        self.placed_camps = snap.placed_camps.clone();
        self.placed_parcels = snap.placed_parcels.clone();
        self.farm_plots = snap.farm_plots.clone();
        self.drafted_schematics = snap.drafted_schematics.clone();
        self.craft_session = snap.craft_session.clone();
        self.ability_queue = snap.ability_queue.clone();
        self.bank = snap.bank.clone();
        self.building = snap.building.clone();
        self.groups = snap.groups.clone();
        self.guilds = snap.guilds.clone();
        self.duels = snap.duels.clone();
        self.prop_states = snap.prop_states.clone();
        self.weather = snap.weather.clone();
        self.world_clock = snap.world_clock.clone();
        self.counters = snap.counters;
        self.source_state_hash = snap.source_state_hash.clone();
        // A complete snapshot replaces the prior projection, including
        // transient room/event sections that are not part of the snapshot.
        self.splice_session = None;
        self.trade_session = None;
        self.survey_results.clear();
        self.genome_scans.clear();
        self.duel_outcomes.clear();
        self.bug_report_result = None;
        self.dialogue_deliveries.clear();
        self.combat_events.clear();
        self.net_refs.clear();
    }

    fn clone_for_transaction(&self) -> Self {
        self.clone()
    }

    /// Apply a delta transactionally: malformed compact references or
    /// non-finite coordinates leave the previously accepted projection intact.
    pub fn apply_delta(&mut self, delta: &GameShardDelta) {
        let mut next = self.clone_for_transaction();
        if !delta.schema.is_empty() && !delta.schema.contains("delta") {
            return;
        }
        next.tick = delta.tick;
        for r in &delta.actor_refs {
            next.net_refs.insert(r.0, r.1.clone());
        }
        for (id, actor) in &delta.actors {
            if !actor.x.is_finite()
                || !actor.y.is_finite()
                || next.actor_is_stale(id, actor.lifecycle_seq)
            {
                return;
            }
            next.actors.insert(id.clone(), actor.clone());
        }
        for row in &delta.compact_actors {
            let raw = Value::Array(row.0.clone());
            let actor = match compact_snapshot(&raw) {
                Ok(actor) => actor,
                Err(_) => return,
            };
            if !actor.x.is_finite() || !actor.y.is_finite() {
                return;
            }
            next.actors.insert(actor.id.clone(), actor);
        }
        for row in &delta.compact_actor_patches {
            let raw = Value::Array(row.0.clone());
            let (id, patch) = match compact_patch(&raw) {
                Ok(value) => value,
                Err(_) => return,
            };
            if !next.apply_compact_patch(&id, &patch) {
                return;
            }
        }
        for id in &delta.actor_removals {
            next.actors.remove(id);
        }
        for (id, patch) in &delta.actor_patches {
            if !next.apply_patch(id, patch) {
                return;
            }
        }
        for m in &delta.compact_actor_moves {
            let Some(id) = next.net_refs.get(&m.0).cloned() else {
                return;
            };
            let Some(actor) = next.actors.get_mut(&id) else {
                return;
            };
            let x = m.1 as f32 / MOVE_QUANTIZATION;
            let y = m.2 as f32 / MOVE_QUANTIZATION;
            if !x.is_finite() || !y.is_finite() {
                return;
            }
            actor.x = x;
            actor.y = y;
            actor.direction = direction_from_compact(m.3);
        }
        if let Some(v) = &delta.inventory {
            next.inventory = v.clone();
        }
        if let Some(v) = &delta.reservations {
            next.reservations = v.clone();
        }
        if let Some(v) = &delta.bank {
            next.bank = v.clone();
        }
        if let Some(v) = &delta.building {
            next.building = v.clone();
        }
        if let Some(v) = &delta.player_corpses {
            next.player_corpses = v.clone();
        }
        if let Some(v) = &delta.resource_spawns {
            next.resource_spawns = v.clone();
        }
        if let Some(v) = &delta.placed_extractors {
            next.placed_extractors = v.clone();
        }
        if let Some(v) = &delta.placed_camps {
            next.placed_camps = v.clone();
        }
        if let Some(v) = &delta.placed_parcels {
            next.placed_parcels = v.clone();
        }
        if let Some(v) = &delta.farm_plots {
            next.farm_plots = v.clone();
        }
        if let Some(v) = &delta.drafted_schematics {
            next.drafted_schematics = v.clone();
        }
        if let Some(v) = &delta.craft_session {
            next.craft_session = v.clone();
        }
        if let Some(v) = &delta.ability_queue {
            next.ability_queue = v.clone();
        }
        if let Some(v) = &delta.groups {
            next.groups = v.clone();
        }
        if let Some(v) = &delta.guilds {
            next.guilds = v.clone();
        }
        if let Some(v) = &delta.duels {
            next.duels = v.clone();
        }
        if let Some(v) = &delta.prop_states {
            next.prop_states = v.clone();
        }
        if let Some(v) = &delta.world_clock {
            next.world_clock = v.clone();
        }
        if let Some(v) = &delta.weather {
            next.weather = v.clone();
        }
        if let Some(v) = &delta.dialogue_deliveries {
            next.dialogue_deliveries = v.clone();
        }
        if let Some(v) = &delta.source_state_hash {
            next.source_state_hash = Some(v.clone());
        }
        if let Some(v) = &delta.counters {
            next.counters = Some(*v);
        }
        *self = next;
    }

    fn apply_compact_patch(&mut self, id: &str, row: &Value) -> bool {
        let Some(v) = row.as_array() else {
            return false;
        };
        if v.len() != 52 {
            return false;
        }
        let Some(a) = self.actors.get_mut(id) else {
            return false;
        };
        if let Some(x) = v[1].as_str() {
            a.area_id = x.into()
        } else if !v[1].is_null() {
            return false;
        }
        if !v[2].is_null() {
            let Some(x) = v[2].as_f64() else { return false };
            if !x.is_finite() {
                return false;
            };
            a.x = x as f32
        }
        if !v[3].is_null() {
            let Some(x) = v[3].as_f64() else { return false };
            if !x.is_finite() {
                return false;
            };
            a.y = x as f32
        }
        if !v[4].is_null() {
            let Some(x) = v[4].as_u64().and_then(|n| u8::try_from(n).ok()) else {
                return false;
            };
            if x > 3 {
                return false;
            };
            a.direction = direction_from_compact(x)
        }
        if !v[5].is_null() {
            let Some(x) = v[5].as_u64() else { return false };
            a.life_state = life_from_compact(x).into()
        }
        if let Some(x) = v[6].as_i64() {
            a.lifecycle_seq = x
        } else if !v[6].is_null() {
            return false;
        }
        if !v[7].is_null() {
            a.vitals = match serde_json::from_value(v[7].clone()) {
                Ok(x) => x,
                Err(_) => return false,
            }
        }
        if !v[8].is_null() {
            a.max_vitals = match serde_json::from_value(v[8].clone()) {
                Ok(x) => x,
                Err(_) => return false,
            }
        }
        if v[10].is_null() {
        } else if let Some(x) = v[10].as_array() {
            a.statuses = x.clone()
        } else {
            return false;
        }
        if v[19].is_string() {
            a.label = v[19].as_str().unwrap().into()
        } else if !v[19].is_null() {
            return false;
        }
        if v[41].is_string() {
            a.display_name = v[41].as_str().unwrap().into()
        } else if v[41].is_null() {
            a.display_name.clear()
        } else {
            return false;
        }
        if v[42].is_boolean() {
            a.link_dead = v[42].as_bool().unwrap()
        } else if !v[42].is_null() {
            return false;
        }
        if v[11].is_null() {
        } else if let Some(x) = v[11].as_i64() {
            a.body_vanish_at_tick = Some(x)
        } else {
            return false;
        }
        if v[12].is_null() {
            a.respawn_at_tick = None
        } else if let Some(x) = v[12].as_i64() {
            a.respawn_at_tick = Some(x)
        } else {
            return false;
        }
        if v[13].is_null() {
            a.professions.clear()
        } else if let Ok(x) = serde_json::from_value(v[13].clone()) {
            a.professions = x
        } else {
            return false;
        }
        if v[14].is_null() {
            a.active_title = None
        } else {
            a.active_title = Some(v[14].clone())
        }
        if v[15].is_null() {
            a.skill_points_used = None
        } else if let Some(x) = v[15].as_i64() {
            a.skill_points_used = Some(x)
        } else {
            return false;
        }
        if v[16].is_null() {
            a.skill_points_cap = None
        } else if let Some(x) = v[16].as_i64() {
            a.skill_points_cap = Some(x)
        } else {
            return false;
        }
        if v[17].is_null() {
            a.credits = None
        } else if let Some(x) = v[17].as_i64() {
            a.credits = Some(x)
        } else {
            return false;
        }
        if v[18].is_null() || v[18] == Value::Bool(false) {
            a.personal_shield = None
        } else {
            a.personal_shield = Some(v[18].clone())
        }
        if v[20].is_null() {
            a.sprite = None
        } else if let Some(x) = v[20].as_str() {
            a.sprite = Some(x.into())
        } else {
            return false;
        }
        if v[21].is_null() {
            a.role = None
        } else if let Some(x) = v[21].as_str() {
            a.role = Some(x.into())
        } else {
            return false;
        }
        if v[22].is_null() || v[22] == Value::Bool(false) {
            a.player_organization_id = None
        } else if let Some(x) = v[22].as_str() {
            a.player_organization_id = Some(x.into())
        } else {
            return false;
        }
        if v[23].is_null() || v[23] == Value::Bool(false) {
            a.player_organization_tag = None
        } else if let Some(x) = v[23].as_str() {
            a.player_organization_tag = Some(x.into())
        } else {
            return false;
        }
        if v[24].is_null() || v[24] == Value::Bool(false) {
            a.weapon = None
        } else if let Ok(x) = serde_json::from_value(v[24].clone()) {
            a.weapon = Some(x)
        } else {
            return false;
        }
        if v[25].is_null() {
            a.shot_spread_degrees_milli = None
        } else if let Some(x) = v[25].as_i64() {
            a.shot_spread_degrees_milli = Some(x)
        } else {
            return false;
        }
        if v[26].is_null() {
            a.posture = None
        } else if let Some(x) = v[26].as_str() {
            a.posture = Some(x.into())
        } else {
            return false;
        }
        if v[27].is_null() {
            a.posture_until_tick = None
        } else if let Some(x) = v[27].as_i64() {
            a.posture_until_tick = Some(x)
        } else {
            return false;
        }
        if v[28].is_null() || v[28] == Value::Bool(false) {
            a.combat_queue = None
        } else {
            a.combat_queue = Some(v[28].clone())
        }
        if v[29].is_null() {
            a.in_combat = None
        } else if let Some(x) = v[29].as_bool() {
            a.in_combat = Some(x)
        } else {
            return false;
        }
        if v[30].is_null() {
            a.clone_sickness_remaining_ms = None
        } else if let Some(x) = v[30].as_i64() {
            a.clone_sickness_remaining_ms = Some(x)
        } else {
            return false;
        }
        if v[31].is_null() {
            a.peace_requested = None
        } else if let Some(x) = v[31].as_bool() {
            a.peace_requested = Some(x)
        } else {
            return false;
        }
        if v[32].is_null() {
            a.ai_attitude = None
        } else if let Some(x) = v[32].as_str() {
            a.ai_attitude = Some(x.into())
        } else {
            return false;
        }
        if v[33].is_null() || v[33] == Value::Bool(false) {
            a.engagement_target_id = None
        } else if let Some(x) = v[33].as_str() {
            a.engagement_target_id = Some(x.into())
        } else {
            return false;
        }
        if v[34].is_null() {
            a.lootable = None
        } else if let Some(x) = v[34].as_bool() {
            a.lootable = Some(x)
        } else {
            return false;
        }
        if v[35].is_null() {
            a.has_loot = None
        } else if let Some(x) = v[35].as_bool() {
            a.has_loot = Some(x)
        } else {
            return false;
        }
        if v[36].is_null() || v[36] == Value::Bool(false) {
            a.loot_rights_actor_id = None
        } else if let Some(x) = v[36].as_str() {
            a.loot_rights_actor_id = Some(x.into())
        } else {
            return false;
        }
        if v[37].is_null() {
            a.body_vanish_tick = None
        } else if let Some(x) = v[37].as_i64() {
            a.body_vanish_tick = Some(x)
        } else {
            return false;
        }
        if v[38].is_null() {
            a.incap_remaining_ms = None
        } else if let Some(x) = v[38].as_i64() {
            a.incap_remaining_ms = Some(x)
        } else {
            return false;
        }
        if v[39].is_null() {
            a.incap_count = None
        } else if let Some(x) = v[39].as_i64() {
            a.incap_count = Some(x)
        } else {
            return false;
        }
        if v[40].is_null() {
            a.incap_window_ms = None
        } else if let Some(x) = v[40].as_i64() {
            a.incap_window_ms = Some(x)
        } else {
            return false;
        }
        if v[43].is_null() {
            a.appearance = None
        } else if let Ok(x) = serde_json::from_value(v[43].clone()) {
            a.appearance = Some(x)
        } else {
            return false;
        }
        if v[44].is_null() {
            a.next_sample_tick = None
        } else if let Some(x) = v[44].as_i64() {
            a.next_sample_tick = Some(x)
        } else {
            return false;
        }
        if v[45].is_null() {
            a.worn.clear()
        } else if let Ok(x) = serde_json::from_value(v[45].clone()) {
            a.worn = x
        } else {
            return false;
        }
        if v[46].is_null() {
            a.will_auto_aggro = None
        } else if let Some(x) = v[46].as_bool() {
            a.will_auto_aggro = Some(x)
        } else {
            return false;
        }
        if v[47].is_null() {
            a.descriptor = None
        } else if let Some(x) = v[47].as_str() {
            a.descriptor = Some(x.into())
        } else {
            return false;
        }
        if v[48].is_null() {
            a.worn.clear()
        } else if let Ok(x) = serde_json::from_value(v[48].clone()) {
            a.worn = x
        } else {
            return false;
        }
        if v[49].is_null() {
            a.will_auto_aggro = None
        } else if let Some(x) = v[49].as_bool() {
            a.will_auto_aggro = Some(x)
        } else {
            return false;
        }
        if v[50].is_null() {
            a.descriptor = None
        } else if let Some(x) = v[50].as_str() {
            a.descriptor = Some(x.into())
        } else {
            return false;
        }
        if !v[51].is_null() {
            a.mobility = Some(v[51].clone())
        }
        true
    }

    fn apply_patch(&mut self, id: &str, patch: &GameActorPatch) -> bool {
        if let Some(seq) = patch.lifecycle_seq {
            if self.actor_is_stale(id, seq) {
                return true;
            }
        }
        let Some(a) = self.actors.get_mut(id) else {
            return false;
        };
        if let Some(v) = &patch.label {
            a.label = v.clone();
        }
        if let Some(v) = &patch.display_name {
            a.display_name = v.clone();
        }
        if let Some(v) = &patch.area_id {
            a.area_id = v.clone();
        }
        if let Some(v) = patch.x {
            if !v.is_finite() {
                return false;
            }
            a.x = v;
        }
        if let Some(v) = patch.y {
            if !v.is_finite() {
                return false;
            }
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
        if let Some(v) = &patch.weapon {
            a.weapon = Some(v.clone());
        }
        if let Some(v) = &patch.statuses {
            a.statuses = v.clone();
        }
        if let Some(v) = &patch.professions {
            a.professions = v.clone();
        }
        if let Some(v) = &patch.personal_shield {
            a.personal_shield = Some(v.clone());
        }
        if let Some(v) = patch.credits {
            a.credits = Some(v);
        }
        if let Some(v) = &patch.faction_id {
            a.faction_id = Some(v.clone());
        }
        if let Some(v) = &patch.social_group {
            a.social_group = Some(v.clone());
        }
        if let Some(v) = &patch.pvp_status {
            a.pvp_status = Some(v.clone());
        }
        if let Some(v) = &patch.engagement_target_id {
            a.engagement_target_id = Some(v.clone());
        }
        true
    }

    /// An update for `id` is stale if it carries a lower `lifecycleSeq` than the
    /// actor we already hold (a late packet from a previous life).
    fn actor_is_stale(&self, id: &str, incoming_seq: i64) -> bool {
        self.actors
            .get(id)
            .map(|a| incoming_seq < a.lifecycle_seq)
            .unwrap_or(false)
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

    /// Apply the authoritative player position from a `game.acks` packet (the
    /// server acks your move command with your reconciled position — this does
    /// not arrive as an AOI delta since you are the AOI centre).
    pub fn apply_player_position(&mut self, x: f32, y: f32) {
        if let Some(a) = self.actors.get_mut(&self.player_actor_id) {
            a.x = x;
            a.y = y;
        }
    }
    /// Full actor acknowledgements replace the player projection atomically.
    pub fn apply_player_actor(&mut self, actor: GameActorSnapshot) {
        if self.player_actor_id.is_empty() {
            self.player_actor_id = actor.id.clone();
        }
        if actor.id == self.player_actor_id {
            self.actors.insert(actor.id.clone(), actor);
        }
    }

    /// Actors that should be rendered: alive/downed, excluding `respawning`.
    pub fn render_actors(&self) -> impl Iterator<Item = (&String, &GameActorSnapshot)> {
        self.actors
            .iter()
            .filter(|(_, a)| a.life_state != "respawning")
    }
    pub fn world_clock(&self) -> Option<&Value> {
        self.world_clock.as_ref()
    }
    pub fn weather(&self) -> &[Value] {
        &self.weather
    }
    pub fn prop_states(&self) -> &HashMap<String, Value> {
        &self.prop_states
    }
    pub fn frame(&self) -> AuthorityFrameView<'_> {
        AuthorityFrameView { store: self }
    }
    pub fn push_combat_events(&mut self, events: impl IntoIterator<Item = Value>) {
        for event in events {
            self.combat_events.push_back(event);
            while self.combat_events.len() > 256 {
                self.combat_events.pop_front();
            }
        }
    }
    pub fn drain_combat_events(&mut self, out: &mut Vec<Value>) {
        out.extend(self.combat_events.drain(..));
    }
    pub fn apply_room_message(&mut self, name: &str, payload: &Value) {
        match name {
            "craftSession" => self.craft_session = Some(payload.clone()),
            "spliceSession" => self.splice_session = Some(payload.clone()),
            "tradeSession" => self.trade_session = Some(payload.clone()),
            "surveyResult" => {
                self.survey_results.push(payload.clone());
                if self.survey_results.len() > 128 {
                    self.survey_results.remove(0);
                }
            }
            "genomeScan" => {
                self.genome_scans.push(payload.clone());
                if self.genome_scans.len() > 128 {
                    self.genome_scans.remove(0);
                }
            }
            "duelOutcome" => {
                self.duel_outcomes.push(payload.clone());
                if self.duel_outcomes.len() > 128 {
                    self.duel_outcomes.remove(0);
                }
            }
            "bugReportResult" => self.bug_report_result = Some(payload.clone()),
            _ => {}
        }
    }
}
/// Immutable borrowed frame view; callers cannot mutate or clone authority
/// collections while rendering.
pub struct AuthorityFrameView<'a> {
    store: &'a AuthorityStore,
}

impl<'a> AuthorityFrameView<'a> {
    pub fn actors(&self) -> impl Iterator<Item = (&'a String, &'a GameActorSnapshot)> {
        self.store.render_actors()
    }
    pub fn world_clock(&self) -> Option<&'a Value> {
        self.store.world_clock()
    }
    pub fn weather(&self) -> &'a [Value] {
        self.store.weather()
    }
    pub fn prop_states(&self) -> &'a HashMap<String, Value> {
        self.store.prop_states()
    }
}

fn direction_from_compact(v: u8) -> String {
    match v {
        1 => "right",
        2 => "back",
        3 => "left",
        _ => "front",
    }
    .into()
}

fn life_from_compact(v: u64) -> &'static str {
    match v {
        1 => "downed",
        2 => "respawning",
        _ => "alive",
    }
}

fn compact_snapshot(row: &Value) -> Result<GameActorSnapshot, ()> {
    let a = row.as_array().ok_or(())?;
    if a.len() != 52 {
        return Err(());
    }
    let mut o = serde_json::Map::new();
    let put = |o: &mut serde_json::Map<String, Value>, k: &str, v: &Value| {
        o.insert(k.into(), v.clone());
    };
    for (i, k) in [
        (0, "id"),
        (1, "label"),
        (2, "areaId"),
        (3, "x"),
        (4, "y"),
        (7, "lifecycleSeq"),
        (8, "vitals"),
        (9, "maxVitals"),
        (10, "bleed"),
        (11, "statuses"),
        (12, "factionId"),
        (13, "socialGroup"),
        (14, "pvpStatus"),
        (15, "bodyVanishAtTick"),
        (16, "respawnAtTick"),
        (17, "professions"),
        (18, "activeTitle"),
        (19, "skillPointsUsed"),
        (20, "skillPointsCap"),
        (21, "credits"),
        (22, "personalShield"),
        (23, "sprite"),
        (24, "role"),
        (25, "playerOrganizationId"),
        (26, "playerOrganizationTag"),
        (27, "weapon"),
        (28, "shotSpreadDegreesMilli"),
        (29, "posture"),
        (30, "postureUntilTick"),
        (31, "combatQueue"),
        (32, "inCombat"),
        (33, "cloneSicknessRemainingMs"),
        (34, "peaceRequested"),
        (35, "aiAttitude"),
        (36, "engagementTargetId"),
        (37, "lootable"),
        (38, "hasLoot"),
        (39, "lootRightsActorId"),
        (40, "bodyVanishTick"),
        (41, "incapRemainingMs"),
        (42, "incapCount"),
        (43, "incapWindowMs"),
        (44, "displayName"),
        (45, "linkDead"),
        (46, "appearance"),
        (47, "nextSampleTick"),
        (48, "worn"),
        (49, "willAutoAggro"),
        (50, "descriptor"),
    ] {
        put(&mut o, k, &a[i]);
    }
    let d = a[5]
        .as_u64()
        .and_then(|v| u8::try_from(v).ok())
        .filter(|v| *v <= 3)
        .ok_or(())?;
    let l = a[6].as_u64().ok_or(())?;
    put(
        &mut o,
        "direction",
        &Value::String(direction_from_compact(d)),
    );
    put(
        &mut o,
        "lifeState",
        &Value::String(life_from_compact(l).into()),
    );
    put(&mut o, "sprintRecoveryLocked", &a[51]);
    put(&mut o, "mobility", &a[51]);
    serde_json::from_value(Value::Object(o)).map_err(|_| ())
}
fn compact_patch(row: &Value) -> Result<(String, Value), ()> {
    let a = row.as_array().ok_or(())?;
    if a.len() != 52 {
        return Err(());
    }
    let id = a[0].as_str().ok_or(())?.to_string();
    Ok((id, row.clone()))
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
            vitals: GameActorVitals {
                health: 100.0,
                action: 100.0,
                spirit: 100.0,
            },
            ..Default::default()
        }
    }

    fn snap_with(actors: Vec<GameActorSnapshot>) -> GameShardSnapshot {
        let mut s = GameShardSnapshot {
            tick: 1,
            player_actor_id: "me".into(),
            ..Default::default()
        };
        for a in actors {
            s.actors.insert(a.id.clone(), a);
        }
        s
    }

    #[test]
    fn snapshot_then_delta_patch_and_remove() {
        let mut store = AuthorityStore::new();
        store.apply_snapshot(&snap_with(vec![
            actor("me", 0.0, 0.0, 1),
            actor("bob", 5.0, 5.0, 1),
        ]));
        assert_eq!(store.actors.len(), 2);

        let mut d = GameShardDelta {
            tick: 2,
            ..Default::default()
        };
        d.actor_patches.insert(
            "bob".into(),
            GameActorPatch {
                id: "bob".into(),
                x: Some(9.0),
                ..Default::default()
            },
        );
        d.actor_removals.push("me".into());
        store.apply_delta(&d);
        assert!(!store.actors.contains_key("me"));
        assert_eq!(store.actors.get("bob").unwrap().x, 9.0);
        assert_eq!(store.tick, 2);
    }

    #[test]
    fn compact_move_resolves_netid() {
        let mut store = AuthorityStore::new();
        store.apply_snapshot(&snap_with(vec![actor("bob", 0.0, 0.0, 1)]));
        let mut d = GameShardDelta {
            tick: 2,
            ..Default::default()
        };
        d.actor_refs.push(GameActorNetRef(7, "bob".into()));
        d.compact_actor_moves
            .push(GameCompactActorMove(7, 51200, 50300, 2));
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
        let mut d = GameShardDelta {
            tick: 2,
            ..Default::default()
        };
        // Late patch from a previous life (seq 3 < current 5): ignored.
        d.actor_patches.insert(
            "bob".into(),
            GameActorPatch {
                id: "bob".into(),
                x: Some(99.0),
                lifecycle_seq: Some(3),
                ..Default::default()
            },
        );
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
        store.apply_delta(&GameShardDelta {
            tick: 2,
            ..Default::default()
        });
        assert!(store.bank.is_some());
        // Delta with bank replaces it.
        let mut d = GameShardDelta {
            tick: 3,
            ..Default::default()
        };
        d.bank = Some(Some(serde_json::json!({"credits": 250})));
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

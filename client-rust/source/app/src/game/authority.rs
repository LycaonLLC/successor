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
    GameActorPatch, GameActorSnapshot, GameActorVitals, GameCommandReceipt, GameCounters,
    GameShardDelta, GameShardSnapshot,
};

const RECEIPT_DEDUPE_MAX: usize = 512;
const MOVE_QUANTIZATION: f32 = 100.0;
fn compact_bool(value: &Value) -> Option<bool> {
    value.as_bool().or_else(|| match value.as_i64() {
        Some(0) => Some(false),
        Some(1) => Some(true),
        _ => None,
    })
}

fn compact_vitals(value: &Value) -> Option<GameActorVitals> {
    let values = value.as_array()?;
    if values.len() != 3 {
        return None;
    }
    let health = values[0].as_f64()? as f32;
    let action = values[1].as_f64()? as f32;
    let spirit = values[2].as_f64()? as f32;
    (health.is_finite() && action.is_finite() && spirit.is_finite()).then_some(GameActorVitals {
        health,
        action,
        spirit,
    })
}

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
    /// Latest command the authority refused, with its reason code. Cleared as
    /// soon as the HUD has shown it.
    pub command_rejection: Option<Value>,
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
        fn update_string(value: &Value, target: &mut String) -> bool {
            if value.is_null() {
                true
            } else if let Some(value) = value.as_str() {
                target.clear();
                target.push_str(value);
                true
            } else {
                false
            }
        }

        fn update_optional_string(value: &Value, target: &mut Option<String>) -> bool {
            if value.is_null() {
                true
            } else if let Some(value) = value.as_str() {
                *target = Some(value.to_owned());
                true
            } else {
                false
            }
        }

        // Compact nullable fields use `false` for "unchanged" and `null` for
        // "clear". `GameActorPatch::Option<T>` cannot represent both states.
        fn update_nullable_string(value: &Value, target: &mut Option<String>) -> bool {
            if value == &Value::Bool(false) {
                true
            } else if value.is_null() {
                *target = None;
                true
            } else if let Some(value) = value.as_str() {
                *target = Some(value.to_owned());
                true
            } else {
                false
            }
        }

        fn update_optional_i64(value: &Value, target: &mut Option<i64>) -> bool {
            if value.is_null() {
                true
            } else if let Some(value) = value.as_i64() {
                *target = Some(value);
                true
            } else {
                false
            }
        }

        fn update_optional_bool(value: &Value, target: &mut Option<bool>) -> bool {
            if value.is_null() {
                true
            } else if let Some(value) = compact_bool(value) {
                *target = Some(value);
                true
            } else {
                false
            }
        }

        let Some(values) = row.as_array() else {
            return false;
        };
        if values.len() != 52 || values[0].as_str() != Some(id) {
            return false;
        }
        if let Some(sequence) = values[6].as_i64() {
            if self.actor_is_stale(id, sequence) {
                return true;
            }
        } else if !values[6].is_null() {
            return false;
        }
        let Some(actor) = self.actors.get_mut(id) else {
            return false;
        };

        if !update_string(&values[1], &mut actor.area_id) {
            return false;
        }
        if !values[2].is_null() {
            let Some(value) = values[2].as_f64() else {
                return false;
            };
            if !value.is_finite() {
                return false;
            }
            actor.x = value as f32;
        }
        if !values[3].is_null() {
            let Some(value) = values[3].as_f64() else {
                return false;
            };
            if !value.is_finite() {
                return false;
            }
            actor.y = value as f32;
        }
        if !values[4].is_null() {
            let Some(value) = values[4]
                .as_u64()
                .and_then(|value| u8::try_from(value).ok())
            else {
                return false;
            };
            if value > 3 {
                return false;
            }
            actor.direction = direction_from_compact(value);
        }
        if !values[5].is_null() {
            let Some(value) = values[5].as_u64() else {
                return false;
            };
            actor.life_state = life_from_compact(value).to_owned();
        }
        if let Some(sequence) = values[6].as_i64() {
            actor.lifecycle_seq = sequence;
        }
        if !values[7].is_null() {
            let Some(vitals) = compact_vitals(&values[7]) else {
                return false;
            };
            actor.vitals = vitals;
        }
        if !values[8].is_null() {
            let Some(max_vitals) = compact_vitals(&values[8]) else {
                return false;
            };
            actor.max_vitals = max_vitals;
        }
        if !values[9].is_null() {
            actor.bleed = Some(values[9].clone());
        }
        if !values[10].is_null() {
            actor.statuses = match serde_json::from_value(values[10].clone()) {
                Ok(value) => value,
                Err(_) => return false,
            };
        }
        if !update_optional_i64(&values[11], &mut actor.body_vanish_at_tick)
            || !update_optional_i64(&values[12], &mut actor.respawn_at_tick)
        {
            return false;
        }
        if !values[13].is_null() {
            actor.professions = match serde_json::from_value(values[13].clone()) {
                Ok(value) => value,
                Err(_) => return false,
            };
        }
        if !values[14].is_null() {
            actor.active_title = Some(values[14].clone());
        }
        if !update_optional_i64(&values[15], &mut actor.skill_points_used)
            || !update_optional_i64(&values[16], &mut actor.skill_points_cap)
            || !update_optional_i64(&values[17], &mut actor.credits)
        {
            return false;
        }
        if values[18] != Value::Bool(false) {
            actor.personal_shield = if values[18].is_null() {
                None
            } else {
                Some(values[18].clone())
            };
        }
        if !update_string(&values[19], &mut actor.label)
            || !update_optional_string(&values[20], &mut actor.sprite)
            || !update_optional_string(&values[21], &mut actor.role)
            || !update_nullable_string(&values[22], &mut actor.player_organization_id)
            || !update_nullable_string(&values[23], &mut actor.player_organization_tag)
        {
            return false;
        }
        if values[24] != Value::Bool(false) {
            actor.weapon = if values[24].is_null() {
                None
            } else {
                match serde_json::from_value(values[24].clone()) {
                    Ok(value) => Some(value),
                    Err(_) => return false,
                }
            };
        }
        if !update_nullable_string(&values[25], &mut actor.faction_id)
            || !update_nullable_string(&values[26], &mut actor.social_group)
            || !update_nullable_string(&values[27], &mut actor.pvp_status)
            || !update_optional_i64(&values[28], &mut actor.shot_spread_degrees_milli)
            || !update_optional_string(&values[29], &mut actor.posture)
            || !update_optional_i64(&values[30], &mut actor.posture_until_tick)
        {
            return false;
        }
        if values[31] != Value::Bool(false) {
            actor.combat_queue = if values[31].is_null() {
                None
            } else {
                Some(values[31].clone())
            };
        }
        if !update_optional_bool(&values[32], &mut actor.in_combat)
            || !update_optional_i64(&values[33], &mut actor.clone_sickness_remaining_ms)
            || !update_optional_bool(&values[34], &mut actor.peace_requested)
            || !update_optional_string(&values[35], &mut actor.ai_attitude)
            || !update_nullable_string(&values[36], &mut actor.engagement_target_id)
            || !update_optional_bool(&values[37], &mut actor.lootable)
            || !update_optional_bool(&values[38], &mut actor.has_loot)
            || !update_nullable_string(&values[39], &mut actor.loot_rights_actor_id)
            || !update_optional_i64(&values[40], &mut actor.body_vanish_tick)
            || !update_optional_i64(&values[41], &mut actor.incap_remaining_ms)
            || !update_optional_i64(&values[42], &mut actor.incap_count)
            || !update_optional_i64(&values[43], &mut actor.incap_window_ms)
        {
            return false;
        }
        if !update_string(&values[44], &mut actor.display_name) {
            return false;
        }
        if !values[45].is_null() {
            let Some(value) = compact_bool(&values[45]) else {
                return false;
            };
            actor.link_dead = value;
        }
        if !values[46].is_null() {
            actor.appearance = match serde_json::from_value(values[46].clone()) {
                Ok(value) => Some(value),
                Err(_) => return false,
            };
        }
        if !update_optional_i64(&values[47], &mut actor.next_sample_tick) {
            return false;
        }
        if !values[48].is_null() {
            actor.worn = match serde_json::from_value(values[48].clone()) {
                Ok(value) => value,
                Err(_) => return false,
            };
        }
        if !update_optional_bool(&values[49], &mut actor.will_auto_aggro)
            || !update_optional_string(&values[50], &mut actor.descriptor)
        {
            return false;
        }
        if !values[51].is_null() {
            let Some(locked) = compact_bool(&values[51]) else {
                return false;
            };
            actor.sprint_recovery_locked = Some(locked);
            actor.mobility = Some(serde_json::json!({ "sprintRecoveryLocked": locked }));
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
            // The authority refused a command this client sent. Kept as the
            // latest one only: a refusal is about the press the player just
            // made, and a queue of them would surface stale reasons.
            "commandRejected" => self.command_rejection = Some(payload.clone()),
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
    let vitals = compact_vitals(&a[8]).ok_or(())?;
    o.insert(
        "vitals".into(),
        serde_json::json!({
            "health": vitals.health,
            "action": vitals.action,
            "spirit": vitals.spirit,
        }),
    );
    let max_vitals = compact_vitals(&a[9]).ok_or(())?;
    o.insert(
        "maxVitals".into(),
        serde_json::json!({
            "health": max_vitals.health,
            "action": max_vitals.action,
            "spirit": max_vitals.spirit,
        }),
    );
    for (index, key) in [
        (32, "inCombat"),
        (34, "peaceRequested"),
        (37, "lootable"),
        (38, "hasLoot"),
        (45, "linkDead"),
        (49, "willAutoAggro"),
    ] {
        o.insert(key.into(), Value::Bool(compact_bool(&a[index]).ok_or(())?));
    }
    if a[48].is_null() {
        o.insert("worn".into(), Value::Array(Vec::new()));
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
    let sprint_recovery_locked = compact_bool(&a[51]).ok_or(())?;
    o.insert(
        "sprintRecoveryLocked".into(),
        Value::Bool(sprint_recovery_locked),
    );
    o.insert(
        "mobility".into(),
        serde_json::json!({ "sprintRecoveryLocked": sprint_recovery_locked }),
    );
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
    use successor_client_proto::packets::{
        GameActorNetRef, GameActorVitals, GameCompactActorMove, GameCompactActorPatch,
        GameCompactActorSnapshot,
    };

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
    fn current_compact_actor_schema_decodes_snapshot_and_weapon_patch() {
        let mut snapshot_row = vec![Value::Null; 52];
        snapshot_row[0] = serde_json::json!("rogue");
        snapshot_row[1] = serde_json::json!("Wrenn Vale");
        snapshot_row[2] = serde_json::json!("open-desert-overworld");
        snapshot_row[3] = serde_json::json!(611.0);
        snapshot_row[4] = serde_json::json!(570.0);
        snapshot_row[5] = serde_json::json!(3);
        snapshot_row[6] = serde_json::json!(0);
        snapshot_row[7] = serde_json::json!(1);
        snapshot_row[8] = serde_json::json!([74.0, 73.0, 68.0]);
        snapshot_row[9] = serde_json::json!([100.0, 100.0, 100.0]);
        snapshot_row[11] = serde_json::json!([]);
        snapshot_row[12] = serde_json::json!("rogue_troopers");
        snapshot_row[13] = serde_json::json!("open_desert_rogues");
        snapshot_row[14] = serde_json::json!("overt");
        snapshot_row[15] = serde_json::json!(0);
        snapshot_row[16] = serde_json::json!(0);
        snapshot_row[17] = serde_json::json!([]);
        snapshot_row[19] = serde_json::json!(0);
        snapshot_row[20] = serde_json::json!(0);
        snapshot_row[21] = serde_json::json!(0);
        snapshot_row[24] = serde_json::json!("skirmisher");
        snapshot_row[27] = serde_json::json!({
            "weaponId": "vibrosword",
            "weaponItemId": 3103,
            "weaponVariantId": 0,
            "ammoType": "melee",
            "loadedRounds": 1,
            "magazineSize": 1,
            "reloadRemainingTicks": 0,
            "reloadTotalTicks": 1
        });
        snapshot_row[28] = serde_json::json!(0);
        snapshot_row[29] = serde_json::json!("standing");
        snapshot_row[30] = serde_json::json!(0);
        snapshot_row[32] = serde_json::json!(0);
        snapshot_row[33] = serde_json::json!(0);
        snapshot_row[34] = serde_json::json!(0);
        snapshot_row[37] = serde_json::json!(0);
        snapshot_row[38] = serde_json::json!(0);
        snapshot_row[40] = serde_json::json!(0);
        snapshot_row[41] = serde_json::json!(0);
        snapshot_row[42] = serde_json::json!(0);
        snapshot_row[43] = serde_json::json!(0);
        snapshot_row[44] = serde_json::json!("Wrenn Vale");
        snapshot_row[45] = serde_json::json!(0);
        snapshot_row[46] = serde_json::json!({
            "skin": "#c78f62",
            "hair": "hair_mop",
            "hair_mat": "hair_raven"
        });
        snapshot_row[47] = serde_json::json!(0);
        snapshot_row[48] = serde_json::json!([{
            "item": "under_bodysuit",
            "colors": ["#89cff0"]
        }]);
        snapshot_row[49] = serde_json::json!(0);
        snapshot_row[50] = serde_json::json!("a rogue drifter");
        snapshot_row[51] = serde_json::json!(0);

        let mut store = AuthorityStore::new();
        let mut snapshot_delta = GameShardDelta {
            tick: 2,
            ..Default::default()
        };
        snapshot_delta
            .compact_actors
            .push(GameCompactActorSnapshot(snapshot_row));
        store.apply_delta(&snapshot_delta);

        let rogue = store.actors.get("rogue").expect("compact actor accepted");
        assert_eq!(rogue.vitals.health, 74.0);
        assert_eq!(rogue.faction_id.as_deref(), Some("rogue_troopers"));
        assert_eq!(rogue.pvp_status.as_deref(), Some("overt"));
        assert_eq!(rogue.role.as_deref(), Some("skirmisher"));
        assert_eq!(
            rogue
                .appearance
                .as_ref()
                .and_then(|appearance| appearance.skin_tone.as_deref()),
            Some("#c78f62")
        );
        assert_eq!(
            rogue
                .appearance
                .as_ref()
                .and_then(|appearance| appearance.hair_material.as_deref()),
            Some("hair_raven")
        );
        assert_eq!(rogue.worn[0].item_id.as_deref(), Some("under_bodysuit"));
        assert_eq!(rogue.worn[0].colors, ["#89cff0"]);
        assert_eq!(rogue.sprint_recovery_locked, Some(false));

        let mut patch_row = vec![Value::Null; 52];
        patch_row[0] = serde_json::json!("rogue");
        for index in [18, 22, 23, 24, 25, 26, 27, 31, 36, 39] {
            patch_row[index] = Value::Bool(false);
        }
        patch_row[24] = serde_json::json!({
            "weaponId": "wpn-launcher",
            "weaponItemId": 3127,
            "weaponVariantId": 0,
            "ammoType": "slug_iron",
            "loadedRounds": 30,
            "magazineSize": 30,
            "reloadRemainingTicks": 0,
            "reloadTotalTicks": 60
        });
        let mut patch_delta = GameShardDelta {
            tick: 3,
            ..Default::default()
        };
        patch_delta
            .compact_actor_patches
            .push(GameCompactActorPatch(patch_row));
        store.apply_delta(&patch_delta);

        let rogue = store.actors.get("rogue").expect("patched actor retained");
        let weapon = rogue.weapon.as_ref().expect("weapon patch applied");
        assert_eq!(weapon.weapon_id.as_deref(), Some("wpn-launcher"));
        assert_eq!(weapon.weapon_item_id, Some(3127));
        assert_eq!(rogue.faction_id.as_deref(), Some("rogue_troopers"));
        assert_eq!(rogue.vitals.health, 74.0);
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

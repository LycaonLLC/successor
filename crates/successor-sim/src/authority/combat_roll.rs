use super::*;

pub(in crate::authority) const PLAYER_ABILITY_QUEUE_CAPACITY: usize = 15;
pub(in crate::authority) const AI_ABILITY_QUEUE_CAPACITY: usize = 5;
const AIMED_SHOT_ACTION_COST: i32 = 25;
const AIMED_SHOT_SPEED_MULTIPLIER_MILLI: u32 = 1_500;
const AIMED_SHOT_DAMAGE_MULTIPLIER_NUMERATOR: u32 = 3;
const AIMED_SHOT_DAMAGE_MULTIPLIER_DENOMINATOR: u32 = 2;
const AIMED_SHOT_ACCURACY_BONUS: i32 = 15;
const KNEELING_ACCURACY_BONUS: i32 = 15;
const BASE_DEFENSE_TOTAL: i32 = 30;
const RECENT_MOVEMENT_DEFENSE_BONUS: i32 = 25;
const RECENT_MOVEMENT_WINDOW_TICKS: u64 = 10;
const ROLL_COMBAT_DURATION_MS: u64 = 8_000;
const NPC_ROLL_ATTACK_SPEED_MS: u64 = 2_000;
const ROLL_HEALTH_POOL: &str = "health";
const RANGED_ROLL_EVENT_KIND: &str = "ranged_roll";
const ROLL_BURST_ROUNDS: u32 = 6;
const RANGED_ROLL_NPC_SALT: u64 = 0x4e50_4352_4f4c_4c21;
const RANGED_ROLL_QUEUE_SALT: u64 = 0x5155_4555_4552_4f4c;
const RANGED_ROLL_DODGE_SALT: u64 = 0x444f_4447_455f_524f;
const RANGED_ROLL_DAMAGE_SALT: u64 = 0xbf58_476d_1ce4_e5b9;
const RANGED_ROLL_BLOCK_SALT: u64 = 0x424c_4f43_4b5f_524f;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RollOutcome {
    Hit,
    Miss,
    Dodge,
    Deflected,
}

impl RollOutcome {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Hit => "hit",
            Self::Miss => "miss",
            Self::Dodge => "dodge",
            Self::Deflected => "deflected",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub(in crate::authority) enum CombatActionId {
    BasicShot,
    AimedShot,
}

impl CombatActionId {
    fn from_wire(value: &str) -> Option<Self> {
        match value {
            "basic_shot" => Some(Self::BasicShot),
            "aimed_shot" => Some(Self::AimedShot),
            _ => None,
        }
    }

    pub(in crate::authority) const fn as_str(self) -> &'static str {
        match self {
            Self::BasicShot => "basic_shot",
            Self::AimedShot => "aimed_shot",
        }
    }

    pub(in crate::authority) const fn icon_id(self) -> &'static str {
        match self {
            Self::BasicShot => "basic_shot",
            Self::AimedShot => "aimed_shot",
        }
    }

    const fn accuracy_bonus(self) -> i32 {
        match self {
            Self::BasicShot => 0,
            Self::AimedShot => AIMED_SHOT_ACCURACY_BONUS,
        }
    }

    const fn speed_multiplier_milli(self) -> u32 {
        match self {
            Self::BasicShot => 1_000,
            Self::AimedShot => AIMED_SHOT_SPEED_MULTIPLIER_MILLI,
        }
    }

    const fn requires_action(self) -> bool {
        matches!(self, Self::AimedShot)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub(in crate::authority) enum CombatRepeatSource {
    Owner,
    Auto,
}

impl CombatRepeatSource {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Owner => "owner",
            Self::Auto => "auto",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(in crate::authority) struct AbilityQueueEntry {
    pub(in crate::authority) queue_id: u32,
    pub(in crate::authority) action_id: CombatActionId,
    pub(in crate::authority) target_actor_id: String,
    pub(in crate::authority) enqueued_at_tick: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(in crate::authority) struct CombatRepeatIntent {
    pub(in crate::authority) queue_id: u32,
    pub(in crate::authority) action_id: CombatActionId,
    pub(in crate::authority) target_actor_id: String,
    pub(in crate::authority) source: CombatRepeatSource,
    pub(in crate::authority) armed_at_tick: u64,
    pub(in crate::authority) fire_seq: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(in crate::authority) struct PostureQueueEntry {
    pub(in crate::authority) queue_id: u32,
    pub(in crate::authority) posture: AuthorityActorPosture,
    pub(in crate::authority) enqueued_at_tick: u64,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub(in crate::authority) struct AbilityQueue {
    pub(in crate::authority) next_ready_tick: u64,
    pub(in crate::authority) entries: Vec<AbilityQueueEntry>,
    pub(in crate::authority) repeat_intent: Option<CombatRepeatIntent>,
    pub(in crate::authority) pending_posture: Option<PostureQueueEntry>,
    pub(in crate::authority) sequence: u32,
}

impl AbilityQueue {
    fn reset_timing_if_empty(&mut self) {
        if self.entries.is_empty() && self.repeat_intent.is_none() && self.pending_posture.is_none()
        {
            self.next_ready_tick = 0;
            self.sequence = 0;
        }
    }

    fn combat_is_empty(&self) -> bool {
        self.entries.is_empty() && self.repeat_intent.is_none()
    }

    fn retained_depth(&self) -> usize {
        self.entries.len()
            + usize::from(self.repeat_intent.is_some())
            + usize::from(self.pending_posture.is_some())
    }

    fn is_due(&self, tick: u64) -> bool {
        (!self.entries.is_empty() || self.repeat_intent.is_some()) && tick >= self.next_ready_tick
    }

    fn next_queue_id(&mut self) -> u32 {
        self.sequence = self.sequence.wrapping_add(1);
        self.sequence
    }

    fn push_explicit(
        &mut self,
        action_id: CombatActionId,
        target_actor_id: &str,
        enqueued_at_tick: u64,
        capacity: usize,
    ) -> Result<u32, AuthorityRejectReason> {
        if self.retained_depth().saturating_add(1) > capacity {
            return Err(AuthorityRejectReason::QueueFull);
        }
        let queue_id = self.next_queue_id();
        self.entries.push(AbilityQueueEntry {
            queue_id,
            action_id,
            target_actor_id: target_actor_id.to_owned(),
            enqueued_at_tick,
        });
        if self.next_ready_tick == 0 {
            self.next_ready_tick = enqueued_at_tick;
        }
        Ok(queue_id)
    }

    fn arm_repeat(
        &mut self,
        action_id: CombatActionId,
        target_actor_id: &str,
        source: CombatRepeatSource,
        armed_at_tick: u64,
        capacity: usize,
    ) -> Result<u32, AuthorityRejectReason> {
        if self.repeat_intent.is_none() && self.retained_depth().saturating_add(1) > capacity {
            return Err(AuthorityRejectReason::QueueFull);
        }
        let queue_id = self
            .repeat_intent
            .as_ref()
            .map(|intent| intent.queue_id)
            .unwrap_or_else(|| self.next_queue_id());
        let fire_seq = self
            .repeat_intent
            .as_ref()
            .map(|intent| intent.fire_seq)
            .unwrap_or(0);
        self.repeat_intent = Some(CombatRepeatIntent {
            queue_id,
            action_id,
            target_actor_id: target_actor_id.to_owned(),
            source,
            armed_at_tick,
            fire_seq,
        });
        if self.next_ready_tick == 0 {
            self.next_ready_tick = armed_at_tick;
        }
        Ok(queue_id)
    }

    fn pop_front_entry(&mut self) -> Option<AbilityQueueEntry> {
        if self.entries.is_empty() {
            None
        } else {
            Some(self.entries.remove(0))
        }
    }

    fn clear_combat_entries(&mut self) -> Vec<AbilityQueueEntry> {
        std::mem::take(&mut self.entries)
    }

    fn clear_repeat(&mut self) -> Option<CombatRepeatIntent> {
        let repeat = self.repeat_intent.take();
        self.reset_timing_if_empty();
        repeat
    }

    fn clear_combat(&mut self) -> (Vec<AbilityQueueEntry>, Option<CombatRepeatIntent>) {
        let entries = self.clear_combat_entries();
        let repeat = self.repeat_intent.take();
        self.reset_timing_if_empty();
        (entries, repeat)
    }

    fn clear_all(
        &mut self,
    ) -> (
        Vec<AbilityQueueEntry>,
        Option<CombatRepeatIntent>,
        Option<PostureQueueEntry>,
    ) {
        let entries = self.clear_combat_entries();
        let repeat = self.repeat_intent.take();
        let posture = self.pending_posture.take();
        self.reset_timing_if_empty();
        (entries, repeat, posture)
    }

    fn cancel_queue_id(
        &mut self,
        queue_id: u32,
    ) -> Option<(
        Option<AbilityQueueEntry>,
        Option<CombatRepeatIntent>,
        Option<PostureQueueEntry>,
    )> {
        if let Some(index) = self
            .entries
            .iter()
            .position(|entry| entry.queue_id == queue_id)
        {
            let entry = self.entries.remove(index);
            self.reset_timing_if_empty();
            return Some((Some(entry), None, None));
        }
        if self
            .repeat_intent
            .as_ref()
            .is_some_and(|intent| intent.queue_id == queue_id)
        {
            let repeat = self.repeat_intent.take();
            self.reset_timing_if_empty();
            return Some((None, repeat, None));
        }
        if self
            .pending_posture
            .as_ref()
            .is_some_and(|entry| entry.queue_id == queue_id)
        {
            let posture = self.pending_posture.take();
            self.reset_timing_if_empty();
            return Some((None, None, posture));
        }
        None
    }

    pub(in crate::authority) fn iter(&self) -> impl Iterator<Item = &AbilityQueueEntry> {
        self.entries.iter()
    }

    pub(in crate::authority) fn write_stable_hash(&self, w: &mut StateWriter) {
        w.write_tick(self.next_ready_tick).write_u32(self.sequence);
        match self.pending_posture.as_ref() {
            Some(entry) => {
                w.write_bool(true).write_u32(entry.queue_id);
                w.write_u32(entry.posture.code());
                w.write_tick(entry.enqueued_at_tick);
            }
            None => {
                w.write_bool(false);
            }
        }
        match self.repeat_intent.as_ref() {
            Some(intent) => {
                w.write_bool(true).write_u32(intent.queue_id);
                write_string(w, intent.action_id.as_str());
                write_string(w, intent.source.as_str());
                write_string(w, &intent.target_actor_id);
                w.write_tick(intent.armed_at_tick)
                    .write_u32(intent.fire_seq);
            }
            None => {
                w.write_bool(false);
            }
        }
        w.write_u32(u32::try_from(self.entries.len()).expect("ability queue count fits u32"));
        for entry in self.iter() {
            w.write_u32(entry.queue_id);
            write_string(w, entry.action_id.as_str());
            write_string(w, &entry.target_actor_id);
            w.write_tick(entry.enqueued_at_tick);
        }
    }
}

fn ability_queue_capacity_for_actor(actor: &ActorAuthorityState) -> usize {
    if actor.ai.is_some() || !is_player_like_role(&actor.role) {
        AI_ABILITY_QUEUE_CAPACITY
    } else {
        PLAYER_ABILITY_QUEUE_CAPACITY
    }
}

fn queue_entry_id_string(queue_id: u32) -> String {
    format!("q{queue_id}")
}

fn queue_entry_id_from_wire(value: &str) -> Option<u32> {
    value.strip_prefix('q').unwrap_or(value).parse::<u32>().ok()
}

fn ability_queue_event(
    actor_id: &str,
    queue_id: u32,
    lifecycle: AbilityQueueLifecycle,
    tick: u64,
    action_id: Option<CombatActionId>,
    reason: Option<AuthorityRejectReason>,
    fire_seq: Option<u32>,
) -> AuthorityAbilityQueueEventSnapshot {
    AuthorityAbilityQueueEventSnapshot {
        actor_id: actor_id.to_owned(),
        id: queue_entry_id_string(queue_id),
        lifecycle,
        tick,
        reason_code: reason.map(|reason| reason.code().to_owned()),
        fire_seq,
        ability_id: action_id.map(|action| action.as_str().to_owned()),
        icon_id: action_id.map(|action| action.icon_id().to_owned()),
    }
}

impl CombatModel {
    pub(in crate::authority) fn from_slice_value(
        value: Option<&str>,
    ) -> Result<Self, SliceAuthorityBuildError> {
        match value.unwrap_or("roll") {
            "roll" => Ok(Self::Roll),
            other => Err(SliceAuthorityBuildError::InvalidCombatModel(
                other.to_owned(),
            )),
        }
    }

    pub(in crate::authority) const fn code(self) -> u32 {
        1
    }
}

impl AuthorityCombatQueueSnapshot {
    pub(in crate::authority) fn from_actor(actor: &ActorAuthorityState) -> Option<Self> {
        if actor.combat_queue.combat_is_empty() {
            return None;
        }
        let mut entries = actor
            .combat_queue
            .iter()
            .map(|entry| AuthorityCombatQueueEntrySnapshot {
                action_id: entry.action_id.as_str().to_owned(),
                target_actor_id: entry.target_actor_id.clone(),
                auto: false,
            })
            .collect::<Vec<_>>();
        if let Some(repeat) = actor.combat_queue.repeat_intent.as_ref() {
            entries.push(AuthorityCombatQueueEntrySnapshot {
                action_id: repeat.action_id.as_str().to_owned(),
                target_actor_id: repeat.target_actor_id.clone(),
                auto: repeat.source == CombatRepeatSource::Auto,
            });
        }
        Some(Self {
            next_ready_tick: actor.combat_queue.next_ready_tick,
            entries,
        })
    }
}

fn ability_queue_entry_snapshot_for_combat_entry(
    entry: &AbilityQueueEntry,
    ready_tick: u64,
) -> AuthorityAbilityQueueEntrySnapshot {
    AuthorityAbilityQueueEntrySnapshot {
        id: queue_entry_id_string(entry.queue_id),
        ability_id: entry.action_id.as_str().to_owned(),
        icon_id: entry.action_id.icon_id().to_owned(),
        entry_class: AbilityQueueEntryClass::Combat,
        target_actor_id: Some(entry.target_actor_id.clone()),
        lifecycle: AbilityQueueLifecycle::Pending,
        enqueued_at_tick: entry.enqueued_at_tick,
        ready_tick: Some(ready_tick),
        fired_at_tick: None,
        dismissed_at_tick: None,
        reason_code: None,
        fire_seq: None,
    }
}

fn ability_queue_entry_snapshot_for_repeat_intent(
    intent: &CombatRepeatIntent,
    ready_tick: u64,
) -> AuthorityAbilityQueueEntrySnapshot {
    AuthorityAbilityQueueEntrySnapshot {
        id: queue_entry_id_string(intent.queue_id),
        ability_id: intent.action_id.as_str().to_owned(),
        icon_id: intent.action_id.icon_id().to_owned(),
        entry_class: AbilityQueueEntryClass::Combat,
        target_actor_id: Some(intent.target_actor_id.clone()),
        lifecycle: AbilityQueueLifecycle::Pending,
        enqueued_at_tick: intent.armed_at_tick,
        ready_tick: Some(ready_tick),
        fired_at_tick: None,
        dismissed_at_tick: None,
        reason_code: None,
        fire_seq: Some(intent.fire_seq),
    }
}

fn ability_queue_entry_snapshot_for_posture(
    entry: &PostureQueueEntry,
) -> AuthorityAbilityQueueEntrySnapshot {
    let posture_id = match entry.posture {
        AuthorityActorPosture::Standing => "standing",
        AuthorityActorPosture::KneelingDown => "kneeling_down",
        AuthorityActorPosture::Kneeling => "kneeling",
        AuthorityActorPosture::StandingUp => "standing_up",
    };
    AuthorityAbilityQueueEntrySnapshot {
        id: queue_entry_id_string(entry.queue_id),
        ability_id: posture_id.to_owned(),
        icon_id: "posture".to_owned(),
        entry_class: AbilityQueueEntryClass::Posture,
        target_actor_id: None,
        lifecycle: AbilityQueueLifecycle::Pending,
        enqueued_at_tick: entry.enqueued_at_tick,
        ready_tick: None,
        fired_at_tick: None,
        dismissed_at_tick: None,
        reason_code: None,
        fire_seq: None,
    }
}

impl AuthorityAbilityQueueSnapshot {
    pub(in crate::authority) fn from_actor(actor: &ActorAuthorityState) -> Option<Self> {
        let queue = &actor.combat_queue;
        if queue.entries.is_empty()
            && queue.repeat_intent.is_none()
            && queue.pending_posture.is_none()
        {
            return None;
        }
        let mut entries = queue
            .entries
            .iter()
            .map(|entry| {
                ability_queue_entry_snapshot_for_combat_entry(entry, queue.next_ready_tick)
            })
            .collect::<Vec<_>>();
        if let Some(posture) = queue.pending_posture.as_ref() {
            entries.push(ability_queue_entry_snapshot_for_posture(posture));
        }
        let repeat_intent = queue.repeat_intent.as_ref().map(|intent| {
            ability_queue_entry_snapshot_for_repeat_intent(intent, queue.next_ready_tick)
        });
        Some(Self {
            actor_id: actor.id.clone(),
            next_ready_tick: queue.next_ready_tick,
            entries,
            repeat_intent,
        })
    }
}

impl ActorAuthorityState {
    pub(in crate::authority) fn in_combat_snapshot(&self, tick: u64) -> Option<bool> {
        if self.combat_until_tick == 0 {
            None
        } else {
            Some(tick < self.combat_until_tick)
        }
    }
}

impl SliceAuthorityState {
    pub(in crate::authority) fn roll_range_bands_for_weapon(
        &self,
        weapon_id: AuthorityWeaponId,
        stats: WeaponRollStats,
    ) -> WeaponRollRangeBands {
        self.runtime
            .durable
            .world
            .weapon_range_bands
            .get(&weapon_id)
            .copied()
            .unwrap_or_else(|| stats.range_bands())
    }

    pub(in crate::authority) fn roll_max_range_milli_for_weapon(
        &self,
        weapon_id: AuthorityWeaponId,
        stats: WeaponRollStats,
    ) -> i32 {
        self.roll_range_bands_for_weapon(weapon_id, stats)
            .max_cells
            .saturating_mul(MILLI_CELLS_PER_CELL)
    }

    pub(in crate::authority) fn roll_ideal_range_milli_for_weapon(
        &self,
        weapon_id: AuthorityWeaponId,
        stats: WeaponRollStats,
    ) -> i32 {
        self.roll_range_bands_for_weapon(weapon_id, stats)
            .ideal_cells
            .saturating_mul(MILLI_CELLS_PER_CELL)
    }

    pub(in crate::authority) fn roll_range_bands_milli_for_actor(
        &self,
        actor: &ActorAuthorityState,
    ) -> Option<(i32, i32)> {
        let weapon_id = actor
            .equipped_weapon_id
            .unwrap_or(AuthorityWeaponId::Unarmed);
        let stats = weapon_profile(Some(weapon_id)).roll_stats?;
        Some((
            self.roll_ideal_range_milli_for_weapon(weapon_id, stats),
            self.roll_max_range_milli_for_weapon(weapon_id, stats),
        ))
    }

    #[cfg(test)]
    pub(in crate::authority) fn roll_line_of_sight_cell_walk_cost(
        from: AuthorityPosition,
        to: AuthorityPosition,
    ) -> i32 {
        let from = from.cell();
        let to = to.cell();
        (to.x - from.x)
            .abs()
            .max((to.y - from.y).abs())
            .saturating_sub(1)
    }

    pub(in crate::authority) fn roll_line_of_sight_clear(
        &self,
        area_id: &str,
        from: AuthorityPosition,
        to: AuthorityPosition,
    ) -> bool {
        let from = from.cell();
        let to = to.cell();
        if from == to {
            return true;
        }

        let mut x = from.x;
        let mut y = from.y;
        let dx = (to.x - from.x).abs();
        let dy = -(to.y - from.y).abs();
        let step_x = if from.x < to.x { 1 } else { -1 };
        let step_y = if from.y < to.y { 1 } else { -1 };
        let mut err = dx + dy;
        let mut blocked_key = CellKey::new(area_id, x, y);

        loop {
            if x == to.x && y == to.y {
                return true;
            }
            let err_twice = err.saturating_mul(2);
            if err_twice >= dy {
                err = err.saturating_add(dy);
                x = x.saturating_add(step_x);
            }
            if err_twice <= dx {
                err = err.saturating_add(dx);
                y = y.saturating_add(step_y);
            }
            if x == to.x && y == to.y {
                return true;
            }
            blocked_key.x = x;
            blocked_key.y = y;
            if self
                .runtime
                .durable
                .world
                .blocked_cells
                .contains(&blocked_key)
            {
                return false;
            }
        }
    }

    pub(in crate::authority) fn roll_line_of_sight_clear_between_actors(
        &self,
        actor: &ActorAuthorityState,
        target: &ActorAuthorityState,
    ) -> bool {
        actor.area_id == target.area_id
            && self.roll_line_of_sight_clear(&actor.area_id, actor.position, target.position)
    }

    pub(in crate::authority) fn resolve_npc_roll_attack(
        &mut self,
        attacker_id: &str,
        target_actor_id: &str,
    ) -> Result<(), AuthorityRejectReason> {
        resolve_npc_roll_attack(self, attacker_id, target_actor_id)
    }

    pub(in crate::authority) fn mark_npc_target_acquired(&mut self, actor_id: &str) {
        mark_npc_target_acquired(self, actor_id);
    }

    pub(in crate::authority) fn drain_due_combat_action_queues(&mut self) {
        self.prune_roll_engagement_targets();
        self.enqueue_auto_return_fire_actions();
        let mut actor_resolution_budgets = BTreeMap::<String, usize>::new();
        let mut deferred_actor_ids = BTreeSet::<String>::new();
        while let Some(actor_id) = self
            .runtime
            .durable
            .actors
            .iter()
            .find(|(actor_id, actor)| {
                !deferred_actor_ids.contains(actor_id.as_str())
                    && actor.combat_queue.is_due(self.runtime.durable.tick)
            })
            .map(|(actor_id, _)| actor_id.clone())
        {
            let initial_resolution_budget = self
                .runtime
                .durable
                .actors
                .get(&actor_id)
                .map(|actor| {
                    actor
                        .combat_queue
                        .retained_depth()
                        .saturating_add(1)
                        .min(ability_queue_capacity_for_actor(actor).saturating_add(1))
                        .max(1)
                })
                .unwrap_or(1);
            let remaining_resolutions = actor_resolution_budgets
                .entry(actor_id.clone())
                .or_insert(initial_resolution_budget);
            if *remaining_resolutions == 0 {
                // A permanent repeat rejection can otherwise be auto-armed again at the
                // same tick forever. Defer only the cyclic actor so other due actors can
                // continue draining, and retry after authority state advances.
                if let Some(actor) = self.runtime.durable.actors.get_mut(&actor_id) {
                    actor.combat_queue.next_ready_tick = actor
                        .combat_queue
                        .next_ready_tick
                        .max(self.runtime.durable.tick.saturating_add(1));
                }
                // At u64::MAX the ready tick cannot advance. Suppress this actor for
                // the rest of the drain so later due actors still get a fair turn.
                deferred_actor_ids.insert(actor_id);
                continue;
            }
            *remaining_resolutions = remaining_resolutions.saturating_sub(1);
            self.resolve_next_queued_combat_action(&actor_id);
            self.prune_roll_engagement_targets();
            self.enqueue_auto_return_fire_actions();
        }
    }

    fn resolve_next_queued_combat_action(&mut self, actor_id: &str) {
        let explicit = self
            .runtime
            .durable
            .actors
            .get(actor_id)
            .and_then(|actor| actor.combat_queue.entries.first().cloned());
        let repeat = if explicit.is_none() {
            self.runtime
                .durable
                .actors
                .get(actor_id)
                .and_then(|actor| actor.combat_queue.repeat_intent.clone())
        } else {
            None
        };
        let (queue_id, action_id, target_actor_id, enqueued_at_tick, repeat_fire_seq) =
            if let Some(entry) = explicit.as_ref() {
                (
                    entry.queue_id,
                    entry.action_id,
                    entry.target_actor_id.clone(),
                    entry.enqueued_at_tick,
                    None,
                )
            } else if let Some(intent) = repeat.as_ref() {
                (
                    intent.queue_id,
                    intent.action_id,
                    intent.target_actor_id.clone(),
                    intent.armed_at_tick,
                    Some(intent.fire_seq),
                )
            } else {
                return;
            };
        let speed_ticks = self
            .roll_attack_speed_ticks_for_actor(actor_id, action_id)
            .unwrap_or_else(|| {
                ms_to_ticks_round(
                    SLUGTHROWER_ROLL_ATTACK_SPEED_MS,
                    self.runtime.durable.world.tick_rate_hz,
                )
                .max(1)
            });
        let result = self.resolve_roll_attack(
            actor_id,
            &target_actor_id,
            action_id,
            Some(enqueued_at_tick),
            false,
        );
        match result {
            Ok(()) => {
                let next_ready_tick = self.runtime.durable.tick.saturating_add(speed_ticks);
                if repeat_fire_seq.is_some() {
                    let fired_seq = repeat_fire_seq.unwrap_or(0).wrapping_add(1);
                    if let Some(actor) = self.runtime.durable.actors.get_mut(actor_id) {
                        if let Some(intent) = actor.combat_queue.repeat_intent.as_mut() {
                            intent.fire_seq = fired_seq;
                        }
                        actor.combat_queue.next_ready_tick = next_ready_tick;
                    }
                    self.runtime
                        .pending_ability_queue_events
                        .push(ability_queue_event(
                            actor_id,
                            queue_id,
                            AbilityQueueLifecycle::Fired,
                            self.runtime.durable.tick,
                            Some(action_id),
                            None,
                            Some(fired_seq),
                        ));
                    self.runtime
                        .pending_ability_queue_events
                        .push(ability_queue_event(
                            actor_id,
                            queue_id,
                            AbilityQueueLifecycle::Pending,
                            self.runtime.durable.tick,
                            Some(action_id),
                            None,
                            Some(fired_seq),
                        ));
                } else if let Some(entry) =
                    self.runtime
                        .durable
                        .actors
                        .get_mut(actor_id)
                        .and_then(|actor| {
                            actor.combat_queue.next_ready_tick = next_ready_tick;
                            actor.combat_queue.pop_front_entry()
                        })
                {
                    self.runtime
                        .pending_ability_queue_events
                        .push(ability_queue_event(
                            actor_id,
                            entry.queue_id,
                            AbilityQueueLifecycle::Fired,
                            self.runtime.durable.tick,
                            Some(entry.action_id),
                            None,
                            None,
                        ));
                    self.runtime
                        .pending_ability_queue_events
                        .push(ability_queue_event(
                            actor_id,
                            entry.queue_id,
                            AbilityQueueLifecycle::Dismissed,
                            self.runtime.durable.tick,
                            Some(entry.action_id),
                            None,
                            None,
                        ));
                }
            }
            Err(AuthorityRejectReason::FireCooldown) => {
                let readiness_tick = self.combat_readiness_tick_for_actor(actor_id);
                if let Some(actor) = self.runtime.durable.actors.get_mut(actor_id) {
                    actor.combat_queue.next_ready_tick =
                        actor.combat_queue.next_ready_tick.max(readiness_tick);
                }
                self.runtime
                    .pending_ability_queue_events
                    .push(ability_queue_event(
                        actor_id,
                        queue_id,
                        AbilityQueueLifecycle::Pending,
                        self.runtime.durable.tick,
                        Some(action_id),
                        None,
                        repeat_fire_seq,
                    ));
            }
            Err(reason) => {
                if repeat_fire_seq.is_some() {
                    let cleared = self
                        .runtime
                        .durable
                        .actors
                        .get_mut(actor_id)
                        .and_then(|actor| actor.combat_queue.clear_repeat());
                    if let Some(intent) = cleared {
                        self.runtime
                            .pending_ability_queue_events
                            .push(ability_queue_event(
                                actor_id,
                                intent.queue_id,
                                AbilityQueueLifecycle::Dismissed,
                                self.runtime.durable.tick,
                                Some(intent.action_id),
                                Some(reason),
                                Some(intent.fire_seq),
                            ));
                    }
                } else {
                    let cleared = self
                        .runtime
                        .durable
                        .actors
                        .get_mut(actor_id)
                        .and_then(|actor| actor.combat_queue.pop_front_entry());
                    if let Some(entry) = cleared {
                        self.runtime
                            .pending_ability_queue_events
                            .push(ability_queue_event(
                                actor_id,
                                entry.queue_id,
                                AbilityQueueLifecycle::Dismissed,
                                self.runtime.durable.tick,
                                Some(entry.action_id),
                                Some(reason),
                                None,
                            ));
                    }
                }
            }
        }
    }

    fn roll_attack_speed_ticks_for_actor(
        &self,
        actor_id: &str,
        action_id: CombatActionId,
    ) -> Option<u64> {
        let actor = self.runtime.durable.actors.get(actor_id)?;
        let weapon_id = actor.equipped_weapon_id.or_else(|| {
            (action_id == CombatActionId::BasicShot).then_some(AuthorityWeaponId::Unarmed)
        })?;
        let weapon = weapon_profile(Some(weapon_id));
        let attack_speed_ms = if is_melee_weapon_id(weapon_id) {
            self.melee_attack_interval_ms_for_actor(actor, weapon)
        } else {
            let attack_speed_ms = weapon.roll_stats?.attack_speed_ms;
            if uses_crafted_ranged_variant(weapon_id) {
                slugthrower_attack_interval_ms(attack_speed_ms, actor.equipped_weapon_variant_id)
            } else {
                attack_speed_ms
            }
        };
        Some(roll_attack_speed_ticks(
            attack_speed_ms,
            action_id,
            self.runtime.durable.world.tick_rate_hz,
        ))
    }

    fn combat_readiness_tick_for_actor(&self, actor_id: &str) -> u64 {
        let next_tick = self.runtime.durable.tick.saturating_add(1);
        self.runtime
            .durable
            .actors
            .get(actor_id)
            .map(|actor| {
                next_tick
                    .max(actor.next_fire_tick)
                    .max(actor.slugthrower_magazine.reload_until_tick)
            })
            .unwrap_or(next_tick)
    }

    fn enqueue_auto_return_fire_actions(&mut self) {
        let actor_ids = self
            .runtime
            .durable
            .actors
            .keys()
            .cloned()
            .collect::<Vec<_>>();
        for actor_id in actor_ids {
            let Some(target_actor_id) = self.auto_return_fire_target_id(&actor_id) else {
                continue;
            };
            let Some(actor) = self.runtime.durable.actors.get_mut(&actor_id) else {
                continue;
            };
            let capacity = ability_queue_capacity_for_actor(actor);
            if actor
                .combat_queue
                .arm_repeat(
                    CombatActionId::BasicShot,
                    &target_actor_id,
                    CombatRepeatSource::Auto,
                    self.runtime.durable.tick,
                    capacity,
                )
                .is_ok()
            {
                let queue_id = actor
                    .combat_queue
                    .repeat_intent
                    .as_ref()
                    .map(|intent| intent.queue_id)
                    .unwrap_or(0);
                self.runtime
                    .pending_ability_queue_events
                    .push(ability_queue_event(
                        &actor_id,
                        queue_id,
                        AbilityQueueLifecycle::Enqueued,
                        self.runtime.durable.tick,
                        Some(CombatActionId::BasicShot),
                        None,
                        Some(0),
                    ));
            }
        }
    }

    fn auto_return_fire_target_id(&self, actor_id: &str) -> Option<String> {
        let actor = self.runtime.durable.actors.get(actor_id)?;
        if !is_human_player_actor(actor)
            || actor.life_state != AuthorityLifeState::Alive
            || actor.peace_requested
            || actor.combat_queue.repeat_intent.is_some()
            || actor.in_combat_snapshot(self.runtime.durable.tick) != Some(true)
            || !self.actor_weapon_can_auto_queue(actor_id, actor)
        {
            return None;
        }
        let target_actor_id = actor.engagement_target_id.as_ref()?;
        if self.engagement_target_valid_for_actor(actor, target_actor_id, false)
            && self
                .runtime
                .durable
                .actors
                .get(target_actor_id)
                .is_some_and(|target| self.roll_line_of_sight_clear_between_actors(actor, target))
        {
            Some(target_actor_id.clone())
        } else {
            None
        }
    }

    fn actor_weapon_can_auto_queue(&self, actor_id: &str, actor: &ActorAuthorityState) -> bool {
        let weapon_id = actor
            .equipped_weapon_id
            .unwrap_or(AuthorityWeaponId::Unarmed);
        if is_melee_weapon_id(weapon_id) && !posture_allows_melee_attack(actor.posture) {
            return false;
        }
        let weapon = weapon_profile(Some(weapon_id));
        if weapon.roll_stats.is_none() {
            return false;
        }
        if is_melee_weapon_id(weapon_id) {
            return true;
        }
        let ammo = ammo_profile(weapon, Some(weapon.default_ammo_type));
        if actor.slugthrower_magazine.reload_until_tick > self.runtime.durable.tick {
            return false;
        }
        if actor.slugthrower_magazine.loaded_rounds >= ROLL_BURST_ROUNDS {
            return true;
        }
        ammo_item_id_for_type(ammo.id)
            .and_then(|item_id| self.tracked_actor_ammo_available(actor_id, item_id))
            .is_none_or(|available| available >= ROLL_BURST_ROUNDS)
    }

    fn consume_roll_burst_ammo_or_start_reload(
        &mut self,
        actor_id: &str,
        weapon: WeaponProfile,
        ammo_type: AuthorityAmmoTypeId,
    ) -> Result<u32, AuthorityRejectReason> {
        if is_melee_weapon_id(weapon.id) {
            return Ok(1);
        }

        let profile = self.slugthrower_magazine_profile(actor_id);
        let actor = self
            .runtime
            .durable
            .actors
            .get(actor_id)
            .ok_or(AuthorityRejectReason::UnknownActor)?;
        if actor_uses_unlimited_ammo(actor) {
            if let Some(actor) = self.runtime.durable.actors.get_mut(actor_id) {
                if actor.slugthrower_magazine.loaded_rounds < ROLL_BURST_ROUNDS {
                    actor.slugthrower_magazine.loaded_rounds = profile.magazine_size;
                }
                actor.slugthrower_magazine.loaded_rounds = actor
                    .slugthrower_magazine
                    .loaded_rounds
                    .saturating_sub(ROLL_BURST_ROUNDS);
                actor.slugthrower_magazine.reload_until_tick = 0;
            }
            return Ok(ROLL_BURST_ROUNDS);
        }

        self.complete_actor_weapon_reload_if_due(actor_id, weapon.id, ammo_type)?;
        let reserve_available = ammo_item_id_for_type(ammo_type)
            .and_then(|item_id| self.tracked_actor_ammo_available(actor_id, item_id));
        let current = self
            .runtime
            .durable
            .actors
            .get(actor_id)
            .ok_or(AuthorityRejectReason::UnknownActor)?
            .slugthrower_magazine;
        if current.reload_until_tick > self.runtime.durable.tick {
            return Err(AuthorityRejectReason::FireCooldown);
        }
        if current.loaded_rounds < ROLL_BURST_ROUNDS {
            match consume_round_or_start_reload(
                current,
                profile,
                self.runtime.durable.tick,
                reserve_available,
            ) {
                WeaponFireReadiness::StartedReload(next) | WeaponFireReadiness::Reloading(next) => {
                    if let Some(actor) = self.runtime.durable.actors.get_mut(actor_id) {
                        actor.slugthrower_magazine = next;
                        actor.next_fire_tick = actor.next_fire_tick.max(next.reload_until_tick);
                    }
                    return Err(AuthorityRejectReason::FireCooldown);
                }
                WeaponFireReadiness::Empty(next) => {
                    if let Some(actor) = self.runtime.durable.actors.get_mut(actor_id) {
                        actor.slugthrower_magazine = next;
                    }
                    return Err(AuthorityRejectReason::AmmoUnavailable);
                }
                WeaponFireReadiness::Ready(_) => {
                    return Err(AuthorityRejectReason::AmmoUnavailable)
                }
            }
        }
        if let Some(actor) = self.runtime.durable.actors.get_mut(actor_id) {
            actor.slugthrower_magazine.loaded_rounds = actor
                .slugthrower_magazine
                .loaded_rounds
                .saturating_sub(ROLL_BURST_ROUNDS);
            actor.slugthrower_magazine.reload_until_tick = 0;
        }
        Ok(ROLL_BURST_ROUNDS)
    }

    pub(in crate::authority) fn engagement_target_valid_for_actor(
        &self,
        actor: &ActorAuthorityState,
        target_actor_id: &str,
        allow_approach_slack: bool,
    ) -> bool {
        if actor.life_state != AuthorityLifeState::Alive {
            return false;
        }
        let Some(target) = self.runtime.durable.actors.get(target_actor_id) else {
            return false;
        };
        if target.life_state != AuthorityLifeState::Alive || target.area_id != actor.area_id {
            return false;
        }
        if !self.can_actor_attack(actor, target) {
            return false;
        }
        let weapon_id = actor
            .equipped_weapon_id
            .unwrap_or(AuthorityWeaponId::Unarmed);
        let weapon = weapon_profile(Some(weapon_id));
        let Some(stats) = weapon.roll_stats else {
            return false;
        };
        let max_range = self.roll_max_range_milli_for_weapon(weapon_id, stats);
        let limit = if allow_approach_slack {
            max_range.saturating_mul(3) / 2
        } else {
            max_range
        };
        position_distance_milli(actor.position, target.position) <= limit
    }

    fn prune_roll_engagement_targets(&mut self) {
        let actor_ids = self
            .runtime
            .durable
            .actors
            .keys()
            .cloned()
            .collect::<Vec<_>>();
        for actor_id in actor_ids {
            let should_clear = self
                .runtime
                .durable
                .actors
                .get(&actor_id)
                .is_some_and(|actor| {
                    let Some(target_actor_id) = actor.engagement_target_id.as_ref() else {
                        return false;
                    };
                    !roll_actor_can_hold_engagement_target(actor)
                        || actor.in_combat_snapshot(self.runtime.durable.tick) != Some(true)
                        || !self.engagement_target_valid_for_actor(actor, target_actor_id, true)
                });
            if should_clear {
                let cleared = if let Some(actor) = self.runtime.durable.actors.get_mut(&actor_id) {
                    let cleared_target_id = actor.engagement_target_id.take();
                    let cleared = actor.combat_queue.clear_combat();
                    if let Some(cleared_target_id) = cleared_target_id.as_deref() {
                        clear_roll_ai_target_if_matches(actor, cleared_target_id);
                    }
                    Some(cleared)
                } else {
                    None
                };
                if let Some((entries, repeat)) = cleared {
                    for entry in entries {
                        self.runtime
                            .pending_ability_queue_events
                            .push(ability_queue_event(
                                &actor_id,
                                entry.queue_id,
                                AbilityQueueLifecycle::Dismissed,
                                self.runtime.durable.tick,
                                Some(entry.action_id),
                                Some(AuthorityRejectReason::TargetUnavailable),
                                None,
                            ));
                    }
                    if let Some(intent) = repeat {
                        self.runtime
                            .pending_ability_queue_events
                            .push(ability_queue_event(
                                &actor_id,
                                intent.queue_id,
                                AbilityQueueLifecycle::Dismissed,
                                self.runtime.durable.tick,
                                Some(intent.action_id),
                                Some(AuthorityRejectReason::TargetUnavailable),
                                Some(intent.fire_seq),
                            ));
                    }
                }
            }
        }
    }

    fn set_roll_engagement_target(&mut self, actor_id: &str, target_actor_id: &str) {
        let should_set = {
            let Some(actor) = self.runtime.durable.actors.get(actor_id) else {
                return;
            };
            let Some(target) = self.runtime.durable.actors.get(target_actor_id) else {
                return;
            };
            roll_actor_can_hold_engagement_target(actor)
                && actor.life_state == AuthorityLifeState::Alive
                && target.life_state == AuthorityLifeState::Alive
                && actor.area_id == target.area_id
        };
        if should_set {
            if let Some(actor) = self.runtime.durable.actors.get_mut(actor_id) {
                actor.engagement_target_id = Some(target_actor_id.to_owned());
                set_roll_ai_target(actor, target_actor_id);
            }
        }
    }

    fn resolve_roll_attack(
        &mut self,
        attacker_id: &str,
        target_actor_id: &str,
        action_id: CombatActionId,
        queue_entropy_tick: Option<u64>,
        npc_attack: bool,
    ) -> Result<(), AuthorityRejectReason> {
        let attacker = self
            .runtime
            .durable
            .actors
            .get(attacker_id)
            .ok_or(AuthorityRejectReason::UnknownActor)?
            .clone();
        if attacker.life_state != AuthorityLifeState::Alive {
            return Err(AuthorityRejectReason::ActorNotAlive);
        }
        if npc_attack && self.runtime.durable.tick < attacker.next_fire_tick {
            return Err(AuthorityRejectReason::FireCooldown);
        }
        let target = self
            .runtime
            .durable
            .actors
            .get(target_actor_id)
            .ok_or(AuthorityRejectReason::TargetUnavailable)?
            .clone();
        if target.life_state != AuthorityLifeState::Alive || target.area_id != attacker.area_id {
            return Err(AuthorityRejectReason::TargetUnavailable);
        }
        if !self.can_actor_attack(&attacker, &target) {
            return Err(AuthorityRejectReason::TargetUnavailable);
        }
        let weapon_id = match attacker.equipped_weapon_id {
            Some(weapon_id) => weapon_id,
            None if action_id == CombatActionId::BasicShot => AuthorityWeaponId::Unarmed,
            None => return Err(AuthorityRejectReason::NoWeaponEquipped),
        };
        let melee_attack = is_melee_weapon_id(weapon_id);
        if melee_attack && !posture_allows_melee_attack(attacker.posture) {
            return Err(AuthorityRejectReason::MeleeWhileKneeling);
        }
        let weapon = weapon_profile(Some(weapon_id));
        let stats = weapon
            .roll_stats
            .ok_or(AuthorityRejectReason::NoWeaponEquipped)?;
        let range_bands = self.roll_range_bands_for_weapon(weapon_id, stats);
        let distance_milli = position_distance_milli(attacker.position, target.position);
        if distance_milli > range_bands.max_cells.saturating_mul(MILLI_CELLS_PER_CELL) {
            return Err(AuthorityRejectReason::OutOfRange);
        }
        if !self.roll_line_of_sight_clear_between_actors(&attacker, &target) {
            return Err(AuthorityRejectReason::LosBlocked);
        }
        // Tactics track: the ranged special (aimed shot) action cost drops -0..-25%.
        let aimed_shot_action_cost = aimed_shot_action_cost_for_actor(&attacker);
        if action_id.requires_action() && attacker.vitals.action < aimed_shot_action_cost {
            return Err(AuthorityRejectReason::InsufficientAction);
        }

        let ammo = ammo_profile(weapon, Some(weapon.default_ammo_type));
        let burst_rounds =
            self.consume_roll_burst_ammo_or_start_reload(attacker_id, weapon, ammo.id)?;
        self.provoke_rogue_social_assist(target_actor_id, attacker_id);
        self.provoke_creature_retaliation(target_actor_id, attacker_id);
        self.set_roll_engagement_target(attacker_id, target_actor_id);
        if let Some(actor) = self.runtime.durable.actors.get_mut(attacker_id) {
            if action_id.requires_action() {
                apply_vital_damage(&mut actor.vitals.action, aimed_shot_action_cost);
            }
            actor.direction = direction_for_milli_delta(
                target.position.x.saturating_sub(attacker.position.x),
                target.position.y.saturating_sub(attacker.position.y),
            )
            .to_owned();
            actor.shots_fired = actor.shots_fired.saturating_add(u64::from(burst_rounds));
            actor.last_shot_tick = Some(self.runtime.durable.tick);
            for _ in 0..burst_rounds {
                actor.stats.record_shot(
                    self.runtime.durable.tick,
                    self.runtime.durable.world.tick_rate_hz,
                );
            }
            record_actor_weapon_recoil(
                actor,
                weapon,
                self.runtime.durable.tick,
                self.runtime.durable.world.tick_rate_hz,
            );
            if npc_attack {
                actor.next_fire_tick = self.runtime.durable.tick.saturating_add(
                    ms_to_ticks_round(
                        NPC_ROLL_ATTACK_SPEED_MS,
                        self.runtime.durable.world.tick_rate_hz,
                    )
                    .max(1),
                );
            }
        }
        bump_actor_combat_until(self, attacker_id, self.runtime.durable.tick);

        let accuracy_total = roll_accuracy_total(
            &attacker,
            &target,
            stats,
            range_bands,
            action_id,
            distance_milli,
        );
        let defense_total = roll_defense_total(&target, self.runtime.durable.tick);
        let to_hit_milli = roll_to_hit_milli(accuracy_total, defense_total);
        let entropy_tick = queue_entropy_tick.unwrap_or(self.runtime.durable.tick);
        let roll_salt = if npc_attack {
            RANGED_ROLL_NPC_SALT
        } else {
            RANGED_ROLL_QUEUE_SALT
        };
        let mut current_target = target;
        for _round_index in 0..burst_rounds {
            if current_target.life_state != AuthorityLifeState::Alive {
                break;
            }
            let event_id = self.runtime.durable.next_combat_event_id;
            let roll_milli = deterministic_roll_milli(
                attacker_id,
                target_actor_id,
                action_id,
                entropy_tick,
                self.runtime.durable.tick,
                event_id,
                roll_salt,
            );
            if roll_milli > to_hit_milli {
                let event = self.ranged_roll_zero_damage_event(
                    &attacker,
                    &current_target,
                    action_id,
                    RollOutcome::Miss,
                    roll_milli,
                    to_hit_milli,
                    None,
                    None,
                    None,
                );
                self.runtime.pending_combat_events.push(event);
                continue;
            }

            if !melee_attack {
                let dodge_chance_milli =
                    combat_dodge_chance_milli(&current_target, self.runtime.durable.tick);
                let dodge_roll_milli = (dodge_chance_milli > 0).then(|| {
                    deterministic_dodge_milli(
                        attacker_id,
                        target_actor_id,
                        action_id,
                        entropy_tick,
                        self.runtime.durable.tick,
                        event_id,
                    )
                });
                if dodge_roll_milli.is_some_and(|roll| {
                    i32::try_from(roll).unwrap_or(i32::MAX) <= dodge_chance_milli
                }) {
                    let event = self.ranged_roll_zero_damage_event(
                        &attacker,
                        &current_target,
                        action_id,
                        RollOutcome::Dodge,
                        roll_milli,
                        to_hit_milli,
                        dodge_roll_milli,
                        None,
                        None,
                    );
                    bump_actor_combat_until(self, target_actor_id, self.runtime.durable.tick);
                    self.set_roll_engagement_target(target_actor_id, attacker.id.as_str());
                    self.runtime.pending_combat_events.push(event);
                    continue;
                }

                let block_chance_milli = ranged_block_chance_milli(&current_target, distance_milli);
                if block_chance_milli > 0 {
                    let block_roll_milli = deterministic_ranged_block_milli(
                        attacker_id,
                        target_actor_id,
                        action_id.as_str(),
                        entropy_tick,
                        self.runtime.durable.tick,
                        event_id,
                    );
                    if block_roll_milli <= block_chance_milli {
                        let event = self.ranged_roll_zero_damage_event(
                            &attacker,
                            &current_target,
                            action_id,
                            RollOutcome::Deflected,
                            roll_milli,
                            to_hit_milli,
                            None,
                            Some(block_roll_milli),
                            Some(block_chance_milli),
                        );
                        bump_actor_combat_until(self, target_actor_id, self.runtime.durable.tick);
                        self.set_roll_engagement_target(target_actor_id, attacker.id.as_str());
                        self.runtime.pending_combat_events.push(event);
                        continue;
                    }
                }
            }

            if melee_attack {
                // Guard track: a melee-armed guard parries the incoming strike (melee block).
                let parry_chance_milli = melee_parry_block_chance_milli(&current_target);
                if parry_chance_milli > 0 {
                    let parry_roll_milli = deterministic_ranged_block_milli(
                        attacker_id,
                        target_actor_id,
                        "melee-parry",
                        entropy_tick,
                        self.runtime.durable.tick,
                        event_id,
                    );
                    if parry_roll_milli <= parry_chance_milli {
                        let event = self.ranged_roll_zero_damage_event(
                            &attacker,
                            &current_target,
                            action_id,
                            RollOutcome::Deflected,
                            roll_milli,
                            to_hit_milli,
                            None,
                            Some(parry_roll_milli),
                            Some(parry_chance_milli),
                        );
                        bump_actor_combat_until(self, target_actor_id, self.runtime.durable.tick);
                        self.set_roll_engagement_target(target_actor_id, attacker.id.as_str());
                        self.runtime.pending_combat_events.push(event);
                        continue;
                    }
                }
            }

            let mut damage = deterministic_roll_burst_damage(
                attacker_id,
                target_actor_id,
                action_id,
                entropy_tick,
                self.runtime.durable.tick,
                event_id,
                stats,
                burst_rounds,
            );
            if !melee_attack
                && attacker
                    .equipped_weapon_id
                    .is_some_and(uses_crafted_ranged_variant)
            {
                damage = u32::try_from(
                    u64::from(damage).saturating_mul(
                        u64::try_from(slugthrower_power_damage_multiplier_per_100(
                            attacker.equipped_weapon_variant_id,
                        ))
                        .unwrap_or(100),
                    ) / 100,
                )
                .unwrap_or(u32::MAX);
            }
            if melee_attack {
                // Brawler melee track: variance floor (min-roll raised) then damage bonus.
                damage =
                    apply_melee_damage_shaping(&attacker.professions, stats, damage, burst_rounds);
            }
            if let Some(event) = self.apply_ranged_roll_health_hit(
                &attacker,
                &current_target,
                action_id,
                damage,
                roll_milli,
                to_hit_milli,
            ) {
                if event.damage > 0 {
                    bump_actor_combat_until(self, target_actor_id, self.runtime.durable.tick);
                    self.set_roll_engagement_target(target_actor_id, attacker.id.as_str());
                }
                let ended = event.life_state != AuthorityLifeState::Alive;
                self.runtime.pending_combat_events.push(event);
                if let Some(next_target) = self.runtime.durable.actors.get(target_actor_id).cloned()
                {
                    current_target = next_target;
                }
                if ended {
                    break;
                }
            }
        }
        Ok(())
    }

    fn apply_ranged_roll_health_hit(
        &mut self,
        attacker: &ActorAuthorityState,
        target: &ActorAuthorityState,
        action_id: CombatActionId,
        damage: u32,
        roll_milli: u32,
        to_hit_milli: u32,
    ) -> Option<AuthorityCombatEventSnapshot> {
        let current_attacker = self.runtime.durable.actors.get(&attacker.id)?;
        if current_attacker.life_state != AuthorityLifeState::Alive
            || current_attacker.lifecycle_seq != attacker.lifecycle_seq
        {
            return None;
        }
        {
            let current_target = self.runtime.durable.actors.get(&target.id)?;
            if current_target.lifecycle_seq != target.lifecycle_seq
                || current_target.life_state == AuthorityLifeState::Respawning
                || (current_target.life_state == AuthorityLifeState::Downed
                    && current_target.body_vanish_tick > 0)
                || is_profession_trainer_authority_actor(current_target)
                || current_target.area_id != attacker.area_id
                || current_target.incap_grace_until_tick > self.runtime.durable.tick
                || !self.can_actor_attack(current_attacker, current_target)
            {
                return None;
            }
        }

        self.provoke_rogue_social_assist(&target.id, attacker.id.as_str());
        self.provoke_creature_retaliation(&target.id, attacker.id.as_str());
        let origin = actor_center_position(attacker);
        let impact = actor_center_position(target);
        let weapon_id = attacker
            .equipped_weapon_id
            .unwrap_or(AuthorityWeaponId::Unarmed);
        let ammo_type = ammo_profile(weapon_profile(Some(weapon_id)), None).id;
        let event_id = self.runtime.durable.next_combat_event_id;
        let (mut event, pressure_source) = {
            let target_actor = self.runtime.durable.actors.get_mut(&target.id)?;
            if target_actor.lifecycle_seq != target.lifecycle_seq
                || target_actor.life_state == AuthorityLifeState::Respawning
                || (target_actor.life_state == AuthorityLifeState::Downed
                    && target_actor.body_vanish_tick > 0)
                || target_actor.area_id != attacker.area_id
                || target_actor.incap_grace_until_tick > self.runtime.durable.tick
            {
                return None;
            }

            let previous_life_state = target_actor.life_state;
            let can_pressure_react = target_actor.life_state == AuthorityLifeState::Alive
                && target_actor.sleep.remaining_ticks == 0
                && is_pressure_reactive_actor(target_actor);
            let mut damage = apply_defender_damage_taken_reduction(
                target_actor,
                i32::try_from(damage).unwrap_or(i32::MAX),
            );
            let mut lifecycle = AuthorityCombatLifecycleKind::Hit;
            let mut effect = None;
            let mut lifecycle_cause = "ranged roll hit".to_owned();
            let shielded = if let Some(shield_outcome) = Self::try_block_with_personal_shield(
                target_actor,
                self.runtime.durable.tick,
                self.runtime.durable.world.tick_rate_hz,
                damage,
            ) {
                damage = shield_outcome.damage_after_shield;
                effect = Some(shield_outcome.effect);
                lifecycle_cause = if damage > 0 {
                    "personal shield overflow".to_owned()
                } else {
                    "personal shield".to_owned()
                };
                true
            } else {
                false
            };
            if !shielded {
                Self::record_personal_shield_damage_seen(target_actor, self.runtime.durable.tick);
            }
            if damage > 0 {
                apply_vital_damage(&mut target_actor.vitals.health, damage);
                if target_actor.life_state == AuthorityLifeState::Downed {
                    Self::kill_actor_for_respawn(
                        self.runtime.durable.tick,
                        self.runtime.durable.world.tick_rate_hz,
                        target_actor,
                    );
                    self.runtime.durable.deaths = self.runtime.durable.deaths.saturating_add(1);
                    lifecycle = AuthorityCombatLifecycleKind::Killed;
                    lifecycle_cause = "roll hit while downed".to_owned();
                } else if target_actor.vitals.health <= 0 {
                    if Self::uses_npc_corpse_respawn_timer(target_actor) {
                        Self::kill_actor_for_respawn(
                            self.runtime.durable.tick,
                            self.runtime.durable.world.tick_rate_hz,
                            target_actor,
                        );
                        self.runtime.durable.deaths = self.runtime.durable.deaths.saturating_add(1);
                        lifecycle = AuthorityCombatLifecycleKind::Killed;
                        lifecycle_cause = "critical roll trauma".to_owned();
                    } else if Self::down_player_like_actor_or_kill(
                        self.runtime.durable.tick,
                        self.runtime.durable.world.tick_rate_hz,
                        target_actor,
                    ) {
                        self.runtime.durable.deaths = self.runtime.durable.deaths.saturating_add(1);
                        lifecycle = AuthorityCombatLifecycleKind::Killed;
                        lifecycle_cause = "incap threshold".to_owned();
                    } else {
                        lifecycle = AuthorityCombatLifecycleKind::Downed;
                        lifecycle_cause = "critical roll trauma".to_owned();
                    }
                }
            }

            let pressure_source = if can_pressure_react
                && target_actor.life_state == AuthorityLifeState::Alive
                && target_actor.sleep.remaining_ticks == 0
            {
                Some(origin)
            } else {
                None
            };
            self.runtime.durable.hits = self.runtime.durable.hits.saturating_add(1);
            self.runtime.durable.next_combat_event_id =
                self.runtime.durable.next_combat_event_id.saturating_add(1);
            self.runtime.durable.combat_event_count =
                self.runtime.durable.combat_event_count.saturating_add(1);
            (
                AuthorityCombatEventSnapshot {
                    id: event_id,
                    command_id: None,
                    tick: self.runtime.durable.tick,
                    shooter_actor_id: attacker.id.clone(),
                    target_actor_id: target_actor.id.clone(),
                    origin_x: Some(cell_units_from_milli(origin.x)),
                    origin_y: Some(cell_units_from_milli(origin.y)),
                    hit_x: cell_units_from_milli(impact.x),
                    hit_y: cell_units_from_milli(impact.y),
                    damage,
                    previous_life_state,
                    life_state: target_actor.life_state,
                    target_lifecycle_seq: target_actor.lifecycle_seq,
                    bleed_stack_count: bleed_stack_count(target_actor),
                    lifecycle,
                    zone: "torso".to_owned(),
                    weapon_id,
                    ammo_type,
                    effect,
                    lifecycle_cause,
                    kind: None,
                    attacker_actor_id: None,
                    action_id: None,
                    hit: None,
                    pool: None,
                    roll_milli: None,
                    to_hit_milli: None,
                    block_roll_milli: None,
                    block_chance_milli: None,
                },
                pressure_source,
            )
        };

        if let Some(source) = pressure_source {
            self.apply_suppression_to_actor(
                &event.target_actor_id,
                RANGED_SUPPRESSION_MAX_AMOUNT_MILLI,
                source,
            );
        }
        self.record_combat_event_stats(&event);
        if event.damage > 0
            && !self
                .runtime
                .durable
                .actors
                .get(&event.shooter_actor_id)
                .is_some_and(is_human_player_actor)
        {
            let xp = u64::try_from(event.damage).unwrap_or(0);
            if is_melee_weapon_id(event.weapon_id) {
                let _ = self.award_profession_tracks_xp(
                    &event.shooter_actor_id,
                    AuthorityProfessionKind::Brawler,
                    &["melee", "guard", "movement-speed", "attack-speed"],
                    xp,
                );
            } else {
                let _ = self.award_profession_track_xp(
                    &event.shooter_actor_id,
                    AuthorityProfessionKind::Marksman,
                    "rifle",
                    xp,
                );
            }
        }
        if event.previous_life_state == AuthorityLifeState::Alive
            && event.life_state != AuthorityLifeState::Alive
        {
            self.award_kill_combat_xp_to_damagers(&event.target_actor_id);
        }
        decorate_ranged_roll_event(
            &mut event,
            attacker.id.as_str(),
            action_id,
            RollOutcome::Hit,
            true,
            roll_milli,
            to_hit_milli,
        );
        Some(event)
    }

    fn ranged_roll_zero_damage_event(
        &mut self,
        attacker: &ActorAuthorityState,
        target: &ActorAuthorityState,
        action_id: CombatActionId,
        outcome: RollOutcome,
        roll_milli: u32,
        to_hit_milli: u32,
        _dodge_roll_milli: Option<u32>,
        block_roll_milli: Option<u32>,
        block_chance_milli: Option<u32>,
    ) -> AuthorityCombatEventSnapshot {
        let event_id = self.runtime.durable.next_combat_event_id;
        self.runtime.durable.next_combat_event_id =
            self.runtime.durable.next_combat_event_id.saturating_add(1);
        self.runtime.durable.combat_event_count =
            self.runtime.durable.combat_event_count.saturating_add(1);
        let origin = actor_center_position(attacker);
        let impact = actor_center_position(target);
        let resolved_hit = matches!(outcome, RollOutcome::Dodge | RollOutcome::Deflected);
        let weapon_id = attacker
            .equipped_weapon_id
            .unwrap_or(AuthorityWeaponId::Unarmed);
        let ammo_type = ammo_profile(weapon_profile(Some(weapon_id)), None).id;
        let mut event = AuthorityCombatEventSnapshot {
            id: event_id,
            command_id: None,
            tick: self.runtime.durable.tick,
            shooter_actor_id: attacker.id.clone(),
            target_actor_id: target.id.clone(),
            origin_x: Some(cell_units_from_milli(origin.x)),
            origin_y: Some(cell_units_from_milli(origin.y)),
            hit_x: cell_units_from_milli(impact.x),
            hit_y: cell_units_from_milli(impact.y),
            damage: 0,
            previous_life_state: target.life_state,
            life_state: target.life_state,
            target_lifecycle_seq: target.lifecycle_seq,
            bleed_stack_count: bleed_stack_count(target),
            lifecycle: AuthorityCombatLifecycleKind::Hit,
            zone: "torso".to_owned(),
            weapon_id,
            ammo_type,
            effect: match outcome {
                RollOutcome::Dodge => Some(AuthorityCombatEffectSnapshot {
                    kind: "dodge".to_owned(),
                    stacks: 0,
                    threshold: 0,
                    remaining_ticks: 0,
                }),
                RollOutcome::Deflected => Some(AuthorityCombatEffectSnapshot {
                    kind: "deflected".to_owned(),
                    stacks: 0,
                    threshold: 0,
                    remaining_ticks: 0,
                }),
                RollOutcome::Hit | RollOutcome::Miss => None,
            },
            lifecycle_cause: match outcome {
                RollOutcome::Dodge => "dodged",
                RollOutcome::Deflected => "deflected",
                RollOutcome::Hit => "ranged roll hit",
                RollOutcome::Miss => "ranged roll miss",
            }
            .to_owned(),
            kind: None,
            attacker_actor_id: None,
            action_id: None,
            hit: None,
            pool: None,
            roll_milli: None,
            to_hit_milli: None,
            block_roll_milli,
            block_chance_milli,
        };
        decorate_ranged_roll_event(
            &mut event,
            attacker.id.as_str(),
            action_id,
            outcome,
            resolved_hit,
            roll_milli,
            to_hit_milli,
        );
        event
    }
}

fn roll_actor_can_hold_engagement_target(actor: &ActorAuthorityState) -> bool {
    is_player_like_role(&actor.role) || actor_uses_combat_tactics(actor)
}

fn set_roll_ai_target(actor: &mut ActorAuthorityState, target_actor_id: &str) {
    if let Some(AuthorityAiState::Skirmisher(ai)) = actor.ai.as_mut() {
        ai.target_actor_id = Some(target_actor_id.to_owned());
        ai.target = None;
        ai.cover = None;
    }
}

fn clear_roll_ai_target_if_matches(actor: &mut ActorAuthorityState, target_actor_id: &str) {
    match actor.ai.as_mut() {
        Some(AuthorityAiState::Skirmisher(ai))
            if ai.target_actor_id.as_deref() == Some(target_actor_id) =>
        {
            ai.target_actor_id = None;
            ai.target = None;
            ai.cover = None;
        }
        _ => {}
    }
}

fn roll_ammo_permanently_unavailable_on_enqueue(
    state: &SliceAuthorityState,
    actor_id: &str,
    actor: &ActorAuthorityState,
    weapon: WeaponProfile,
) -> bool {
    if is_melee_weapon_id(weapon.id) || actor_uses_unlimited_ammo(actor) {
        return false;
    }
    let ammo = ammo_profile(weapon, Some(weapon.default_ammo_type));
    let Some(item_id) = ammo_item_id_for_type(ammo.id) else {
        return false;
    };
    if !state.actor_tracks_ammo_item(actor_id, item_id) {
        return false;
    }
    if actor.slugthrower_magazine.loaded_rounds >= ROLL_BURST_ROUNDS
        || actor.slugthrower_magazine.reload_until_tick > state.runtime.durable.tick
    {
        return false;
    }
    state
        .tracked_actor_ammo_available(actor_id, item_id)
        .is_some_and(|available| available < ROLL_BURST_ROUNDS)
}

pub(in crate::authority) fn queue_combat_action(
    state: &mut SliceAuthorityState,
    actor_id: &str,
    action_id: &str,
    target_actor_id: &str,
) -> Result<(), AuthorityRejectReason> {
    let actor = state
        .runtime
        .durable
        .actors
        .get(actor_id)
        .ok_or(AuthorityRejectReason::UnknownActor)?
        .clone();
    if actor.life_state != AuthorityLifeState::Alive {
        return Err(AuthorityRejectReason::ActorNotAlive);
    }
    if actor.sleep.remaining_ticks > 0 {
        return Err(AuthorityRejectReason::ActorAsleep);
    }
    let action_id =
        CombatActionId::from_wire(action_id).ok_or(AuthorityRejectReason::TargetUnavailable)?;
    let weapon_id = match actor.equipped_weapon_id {
        Some(weapon_id) => weapon_id,
        None if action_id == CombatActionId::BasicShot => AuthorityWeaponId::Unarmed,
        None => return Err(AuthorityRejectReason::NoWeaponEquipped),
    };
    if is_melee_weapon_id(weapon_id) && !posture_allows_melee_attack(actor.posture) {
        return Err(AuthorityRejectReason::MeleeWhileKneeling);
    }
    let weapon = weapon_profile(Some(weapon_id));
    let stats = weapon
        .roll_stats
        .ok_or(AuthorityRejectReason::NoWeaponEquipped)?;
    if action_id.requires_action() && actor.vitals.action < aimed_shot_action_cost_for_actor(&actor)
    {
        return Err(AuthorityRejectReason::InsufficientAction);
    }
    if roll_ammo_permanently_unavailable_on_enqueue(state, actor_id, &actor, weapon) {
        return Err(AuthorityRejectReason::AmmoUnavailable);
    }
    let target = state
        .runtime
        .durable
        .actors
        .get(target_actor_id)
        .ok_or(AuthorityRejectReason::TargetUnavailable)?
        .clone();
    if target.life_state != AuthorityLifeState::Alive || target.area_id != actor.area_id {
        return Err(AuthorityRejectReason::TargetUnavailable);
    }
    if is_noncombat_civilian_actor(&target) {
        // DEF-10: an honest, specific reject for shooting a non-combat civilian.
        return Err(AuthorityRejectReason::TargetProtected);
    }
    if !state.can_actor_attack(&actor, &target) {
        return Err(AuthorityRejectReason::TargetUnavailable);
    }
    let distance_milli = position_distance_milli(actor.position, target.position);
    if distance_milli > state.roll_max_range_milli_for_weapon(weapon_id, stats) {
        return Err(AuthorityRejectReason::OutOfRange);
    }
    if !state.roll_line_of_sight_clear_between_actors(&actor, &target) {
        return Err(AuthorityRejectReason::LosBlocked);
    }
    let (queue_id, fire_seq) = {
        let actor = state
            .runtime
            .durable
            .actors
            .get_mut(actor_id)
            .ok_or(AuthorityRejectReason::UnknownActor)?;
        let capacity = ability_queue_capacity_for_actor(actor);
        let queue_id = if action_id == CombatActionId::BasicShot {
            actor.combat_queue.arm_repeat(
                action_id,
                target_actor_id,
                CombatRepeatSource::Owner,
                state.runtime.durable.tick,
                capacity,
            )?
        } else {
            actor.combat_queue.push_explicit(
                action_id,
                target_actor_id,
                state.runtime.durable.tick,
                capacity,
            )?
        };
        actor.peace_requested = false;
        actor.engagement_target_id = Some(target_actor_id.to_owned());
        let fire_seq = actor
            .combat_queue
            .repeat_intent
            .as_ref()
            .filter(|intent| intent.queue_id == queue_id)
            .map(|intent| intent.fire_seq);
        (queue_id, fire_seq)
    };
    state
        .runtime
        .pending_ability_queue_events
        .push(ability_queue_event(
            actor_id,
            queue_id,
            AbilityQueueLifecycle::Enqueued,
            state.runtime.durable.tick,
            Some(action_id),
            None,
            fire_seq,
        ));
    bump_actor_combat_until(state, actor_id, state.runtime.durable.tick);
    Ok(())
}

pub(in crate::authority) fn request_peace(
    state: &mut SliceAuthorityState,
    actor_id: &str,
) -> Result<(), AuthorityRejectReason> {
    let actor = state
        .runtime
        .durable
        .actors
        .get_mut(actor_id)
        .ok_or(AuthorityRejectReason::UnknownActor)?;
    if actor.life_state != AuthorityLifeState::Alive {
        return Err(AuthorityRejectReason::ActorNotAlive);
    }
    if !is_player_like_role(&actor.role) {
        return Err(AuthorityRejectReason::TargetUnavailable);
    }
    actor.peace_requested = true;
    let (entries, repeat) = actor.combat_queue.clear_combat();
    let _ = actor;
    for entry in entries {
        state
            .runtime
            .pending_ability_queue_events
            .push(ability_queue_event(
                actor_id,
                entry.queue_id,
                AbilityQueueLifecycle::Dismissed,
                state.runtime.durable.tick,
                Some(entry.action_id),
                None,
                None,
            ));
    }
    if let Some(intent) = repeat {
        state
            .runtime
            .pending_ability_queue_events
            .push(ability_queue_event(
                actor_id,
                intent.queue_id,
                AbilityQueueLifecycle::Dismissed,
                state.runtime.durable.tick,
                Some(intent.action_id),
                None,
                Some(intent.fire_seq),
            ));
    }
    Ok(())
}

pub(in crate::authority) fn cancel_ability_queue(
    state: &mut SliceAuthorityState,
    actor_id: &str,
    queue_entry_id: Option<&str>,
    scope: Option<&str>,
) -> Result<(), AuthorityRejectReason> {
    let actor = state
        .runtime
        .durable
        .actors
        .get_mut(actor_id)
        .ok_or(AuthorityRejectReason::UnknownActor)?;
    if actor.life_state != AuthorityLifeState::Alive {
        return Err(AuthorityRejectReason::ActorNotAlive);
    }
    if let Some(queue_entry_id) = queue_entry_id {
        let queue_id = queue_entry_id_from_wire(queue_entry_id)
            .ok_or(AuthorityRejectReason::QueueEntryUnknown)?;
        let cleared = actor
            .combat_queue
            .cancel_queue_id(queue_id)
            .ok_or(AuthorityRejectReason::QueueEntryUnknown)?;
        let _ = actor;
        emit_cancelled_queue_entries(state, actor_id, cleared, None);
        return Ok(());
    }
    let scope = scope.unwrap_or("all");
    match scope {
        "owner_repeat" => {
            let repeat = actor.combat_queue.clear_repeat();
            let _ = actor;
            if let Some(intent) = repeat {
                emit_cancelled_repeat(state, actor_id, intent, None);
            }
            Ok(())
        }
        "combat" => {
            let cleared = actor.combat_queue.clear_combat();
            let _ = actor;
            emit_cancelled_combat(state, actor_id, cleared, None);
            Ok(())
        }
        "posture" => {
            let posture = actor.combat_queue.pending_posture.take();
            let _ = actor;
            if let Some(posture) = posture {
                emit_cancelled_queue_entries(state, actor_id, (None, None, Some(posture)), None);
            }
            Ok(())
        }
        "all" => {
            let (entries, repeat, posture) = actor.combat_queue.clear_all();
            let _ = actor;
            emit_cancelled_queue_entries(state, actor_id, (None, repeat, posture), None);
            for entry in entries {
                emit_cancelled_entry(state, actor_id, entry, None);
            }
            Ok(())
        }
        _ => Err(AuthorityRejectReason::TargetUnavailable),
    }
}

fn emit_cancelled_combat(
    state: &mut SliceAuthorityState,
    actor_id: &str,
    cleared: (Vec<AbilityQueueEntry>, Option<CombatRepeatIntent>),
    reason: Option<AuthorityRejectReason>,
) {
    let (entries, repeat) = cleared;
    for entry in entries {
        emit_cancelled_entry(state, actor_id, entry, reason);
    }
    if let Some(intent) = repeat {
        emit_cancelled_repeat(state, actor_id, intent, reason);
    }
}

fn emit_cancelled_queue_entries(
    state: &mut SliceAuthorityState,
    actor_id: &str,
    cleared: (
        Option<AbilityQueueEntry>,
        Option<CombatRepeatIntent>,
        Option<PostureQueueEntry>,
    ),
    reason: Option<AuthorityRejectReason>,
) {
    let (entry, repeat, posture) = cleared;
    if let Some(entry) = entry {
        emit_cancelled_entry(state, actor_id, entry, reason);
    }
    if let Some(intent) = repeat {
        emit_cancelled_repeat(state, actor_id, intent, reason);
    }
    if let Some(posture) = posture {
        state
            .runtime
            .pending_ability_queue_events
            .push(ability_queue_event(
                actor_id,
                posture.queue_id,
                AbilityQueueLifecycle::Dismissed,
                state.runtime.durable.tick,
                None,
                reason,
                None,
            ));
    }
}

fn emit_cancelled_entry(
    state: &mut SliceAuthorityState,
    actor_id: &str,
    entry: AbilityQueueEntry,
    reason: Option<AuthorityRejectReason>,
) {
    state
        .runtime
        .pending_ability_queue_events
        .push(ability_queue_event(
            actor_id,
            entry.queue_id,
            AbilityQueueLifecycle::Dismissed,
            state.runtime.durable.tick,
            Some(entry.action_id),
            reason,
            None,
        ));
}

fn emit_cancelled_repeat(
    state: &mut SliceAuthorityState,
    actor_id: &str,
    intent: CombatRepeatIntent,
    reason: Option<AuthorityRejectReason>,
) {
    state
        .runtime
        .pending_ability_queue_events
        .push(ability_queue_event(
            actor_id,
            intent.queue_id,
            AbilityQueueLifecycle::Dismissed,
            state.runtime.durable.tick,
            Some(intent.action_id),
            reason,
            Some(intent.fire_seq),
        ));
}

pub(in crate::authority) fn resolve_npc_roll_attack(
    state: &mut SliceAuthorityState,
    attacker_id: &str,
    target_actor_id: &str,
) -> Result<(), AuthorityRejectReason> {
    state.resolve_roll_attack(
        attacker_id,
        target_actor_id,
        CombatActionId::BasicShot,
        None,
        true,
    )
}

pub(in crate::authority) fn mark_npc_target_acquired(
    state: &mut SliceAuthorityState,
    actor_id: &str,
) {
    bump_actor_combat_until(state, actor_id, state.runtime.durable.tick);
}

pub(in crate::authority) fn bump_actor_combat_until(
    state: &mut SliceAuthorityState,
    actor_id: &str,
    tick: u64,
) {
    let duration_ticks = ms_to_ticks_round(
        ROLL_COMBAT_DURATION_MS,
        state.runtime.durable.world.tick_rate_hz,
    )
    .max(1);
    if let Some(actor) = state.runtime.durable.actors.get_mut(actor_id) {
        actor.combat_until_tick = actor
            .combat_until_tick
            .max(tick.saturating_add(duration_ticks));
    }
}

#[cfg(test)]
pub(in crate::authority) fn roll_range_accuracy(
    stats: WeaponRollStats,
    distance_milli: i32,
) -> i32 {
    roll_range_accuracy_for_bands(stats, stats.range_bands(), distance_milli)
}

pub(in crate::authority) fn roll_range_accuracy_for_bands(
    stats: WeaponRollStats,
    range_bands: WeaponRollRangeBands,
    distance_milli: i32,
) -> i32 {
    let point_blank = range_bands
        .point_blank_cells
        .saturating_mul(MILLI_CELLS_PER_CELL);
    let ideal = range_bands.ideal_cells.saturating_mul(MILLI_CELLS_PER_CELL);
    let max = range_bands.max_cells.saturating_mul(MILLI_CELLS_PER_CELL);
    if distance_milli <= point_blank {
        return stats.point_blank_acc;
    }
    if distance_milli <= ideal {
        return lerp_i32(
            distance_milli,
            point_blank,
            ideal,
            stats.point_blank_acc,
            stats.ideal_acc,
        );
    }
    if distance_milli <= max {
        return lerp_i32(distance_milli, ideal, max, stats.ideal_acc, stats.max_acc);
    }
    stats.max_acc
}

pub(in crate::authority) fn roll_to_hit_milli(accuracy_total: i32, defense_total: i32) -> u32 {
    let diff = accuracy_total.saturating_sub(defense_total);
    let delta = diff.abs().saturating_mul(500).min(75_000);
    let value = if diff >= 0 {
        75_000_i32.saturating_add(delta)
    } else {
        75_000_i32.saturating_sub(delta)
    };
    u32::try_from(value.clamp(0, 100_000)).unwrap_or(0)
}

fn roll_accuracy_total(
    attacker: &ActorAuthorityState,
    target: &ActorAuthorityState,
    stats: WeaponRollStats,
    range_bands: WeaponRollRangeBands,
    action_id: CombatActionId,
    distance_milli: i32,
) -> i32 {
    let _ = target;
    let kneeling_bonus = if attacker.posture == AuthorityActorPosture::Kneeling {
        KNEELING_ACCURACY_BONUS
    } else {
        0
    };
    let handling_bonus = if attacker
        .equipped_weapon_id
        .is_some_and(uses_crafted_ranged_variant)
    {
        slugthrower_handling_accuracy_bonus(attacker.equipped_weapon_variant_id)
    } else {
        0
    };
    roll_range_accuracy_for_bands(stats, range_bands, distance_milli)
        .saturating_add(kneeling_bonus)
        .saturating_add(action_id.accuracy_bonus())
        .saturating_add(handling_bonus)
}

fn roll_defense_total(target: &ActorAuthorityState, tick: u64) -> i32 {
    let moved_bonus = target
        .last_moved_tick
        .filter(|last_tick| tick.saturating_sub(*last_tick) <= RECENT_MOVEMENT_WINDOW_TICKS)
        .map(|_| RECENT_MOVEMENT_DEFENSE_BONUS)
        .unwrap_or(0);
    BASE_DEFENSE_TOTAL.saturating_add(moved_bonus)
}

fn roll_attack_speed_ticks(
    attack_speed_ms: u64,
    action_id: CombatActionId,
    tick_rate_hz: u32,
) -> u64 {
    let scaled_ms = attack_speed_ms
        .saturating_mul(u64::from(action_id.speed_multiplier_milli()))
        .saturating_add(999)
        / 1_000;
    ms_to_ticks_round(scaled_ms.max(1_000), tick_rate_hz).max(1)
}

fn deterministic_roll_milli(
    attacker_id: &str,
    target_actor_id: &str,
    action_id: CombatActionId,
    entropy_tick: u64,
    tick: u64,
    event_id: u64,
    salt: u64,
) -> u32 {
    let seed = string_hash32(&format!(
        "roll:{}:{}:{}:{}",
        attacker_id,
        target_actor_id,
        action_id.as_str(),
        entropy_tick
    ));
    ((ai_rand(
        seed,
        tick,
        salt ^ event_id.wrapping_mul(0x9e37_79b9_7f4a_7c15),
    ) * 100_000.0) as u32)
        .min(99_999)
        .saturating_add(1)
}

fn deterministic_dodge_milli(
    attacker_id: &str,
    target_actor_id: &str,
    action_id: CombatActionId,
    entropy_tick: u64,
    tick: u64,
    event_id: u64,
) -> u32 {
    let seed = string_hash32(&format!(
        "roll-dodge:{}:{}:{}:{}",
        target_actor_id,
        attacker_id,
        action_id.as_str(),
        entropy_tick
    ));
    ((ai_rand(
        seed,
        tick,
        RANGED_ROLL_DODGE_SALT ^ event_id.wrapping_mul(0xbf58_476d_1ce4_e5b9),
    ) * 1_000.0) as u32)
        .min(999)
        .saturating_add(1)
}

pub(in crate::authority) fn deterministic_ranged_block_milli(
    attacker_id: &str,
    target_actor_id: &str,
    action_label: &str,
    entropy_tick: u64,
    tick: u64,
    event_id: u64,
) -> u32 {
    let seed = string_hash32(&format!(
        "roll-ranged-block:{}:{}:{}:{}",
        target_actor_id, attacker_id, action_label, entropy_tick
    ));
    ((ai_rand(
        seed,
        tick,
        RANGED_ROLL_BLOCK_SALT ^ event_id.wrapping_mul(0xbf58_476d_1ce4_e5b9),
    ) * 1_000.0) as u32)
        .min(999)
        .saturating_add(1)
}

pub(in crate::authority) fn ranged_block_chance_milli(
    target: &ActorAuthorityState,
    distance_milli: i32,
) -> u32 {
    if distance_milli <= super::ai::MELEE_STRIKE_RANGE_MILLI_CELLS {
        return 0;
    }
    if !target.equipped_weapon_id.is_some_and(is_melee_weapon_id) {
        return 0;
    }
    target.professions.brawler_ranged_block_chance_milli()
}

fn roll_burst_damage_band(stats: WeaponRollStats, attack_rounds: u32) -> (u32, u32) {
    let attack_rounds = attack_rounds.max(1);
    let base_min = stats.damage_min.min(stats.damage_max);
    let base_max = stats.damage_min.max(stats.damage_max);
    // Integer per-round damage is rounded up on both bounds: a literal floor of the
    // configured band divided by the attack's round count underpays the attack once
    // normal hit/miss RNG is applied.
    let min = (base_min.saturating_add(attack_rounds.saturating_sub(1)) / attack_rounds).max(1);
    let max = base_max.saturating_add(attack_rounds.saturating_sub(1)) / attack_rounds;
    (min, max.max(min))
}

/// Tactics track: the ranged special (aimed shot) action cost drops -0..-25% with the
/// marksman tactics ladder. Floored at 1 so an aimed shot is never free.
fn aimed_shot_action_cost_for_actor(actor: &ActorAuthorityState) -> i32 {
    let reduction = actor
        .professions
        .marksman_tactics_special_action_cost_reduction_milli()
        .clamp(0, 1_000);
    (AIMED_SHOT_ACTION_COST.saturating_mul(1_000 - reduction) / 1_000).max(1)
}

/// Guard track: chance (permille) a melee-armed guard parries an incoming melee strike.
fn melee_parry_block_chance_milli(target: &ActorAuthorityState) -> u32 {
    if target.life_state != AuthorityLifeState::Alive {
        return 0;
    }
    if !target.equipped_weapon_id.is_some_and(is_melee_weapon_id) {
        return 0;
    }
    u32::try_from(
        target
            .professions
            .brawler_guard_parry_block_permille()
            .max(0),
    )
    .unwrap_or(0)
}

/// Brawler melee track: raise the min-roll floor (variance shrink) then apply the damage
/// bonus. The floor lifts the uniform roll's low end toward the band max; the bonus
/// multiplies afterward and MAY exceed the raw band — that is the +damage.
fn apply_melee_damage_shaping(
    professions: &ActorProfessionState,
    stats: WeaponRollStats,
    damage: u32,
    attack_rounds: u32,
) -> u32 {
    let (min, max) = roll_burst_damage_band(stats, attack_rounds);
    let floor_milli = professions
        .brawler_melee_variance_floor_milli()
        .clamp(0, 1_000);
    let effective_min = min.saturating_add(
        u32::try_from(
            i64::from(max.saturating_sub(min)).saturating_mul(i64::from(floor_milli)) / 1_000,
        )
        .unwrap_or(0),
    );
    let floored = damage.max(effective_min);
    let bonus = professions.brawler_melee_damage_bonus_milli().max(0);
    u32::try_from(i64::from(floored).saturating_mul(i64::from(1_000 + bonus)) / 1_000)
        .unwrap_or(u32::MAX)
}

fn deterministic_roll_burst_damage(
    attacker_id: &str,
    target_actor_id: &str,
    action_id: CombatActionId,
    entropy_tick: u64,
    tick: u64,
    event_id: u64,
    stats: WeaponRollStats,
    attack_rounds: u32,
) -> u32 {
    let seed = string_hash32(&format!(
        "roll-burst-damage:{}:{}:{}:{}",
        attacker_id,
        target_actor_id,
        action_id.as_str(),
        entropy_tick
    ));
    let (min, max) = roll_burst_damage_band(stats, attack_rounds);
    let span = max.saturating_sub(min).saturating_add(1);
    let raw = min.saturating_add(
        ((ai_rand(seed, tick, event_id ^ RANGED_ROLL_DAMAGE_SALT) * f64::from(span)) as u32)
            .min(span.saturating_sub(1)),
    );
    if action_id == CombatActionId::AimedShot {
        raw.saturating_mul(AIMED_SHOT_DAMAGE_MULTIPLIER_NUMERATOR)
            .saturating_add(AIMED_SHOT_DAMAGE_MULTIPLIER_DENOMINATOR / 2)
            / AIMED_SHOT_DAMAGE_MULTIPLIER_DENOMINATOR
    } else {
        raw
    }
}

fn decorate_ranged_roll_event(
    event: &mut AuthorityCombatEventSnapshot,
    attacker_actor_id: &str,
    action_id: CombatActionId,
    outcome: RollOutcome,
    hit: bool,
    roll_milli: u32,
    to_hit_milli: u32,
) {
    let _ = outcome.as_str();
    event.kind = Some(RANGED_ROLL_EVENT_KIND.to_owned());
    event.attacker_actor_id = Some(attacker_actor_id.to_owned());
    event.action_id = Some(action_id.as_str().to_owned());
    event.hit = Some(hit);
    event.pool = Some(ROLL_HEALTH_POOL.to_owned());
    event.roll_milli = Some(roll_milli);
    event.to_hit_milli = Some(to_hit_milli);
}

fn lerp_i32(
    value: i32,
    start_value: i32,
    end_value: i32,
    start_output: i32,
    end_output: i32,
) -> i32 {
    let span = end_value.saturating_sub(start_value);
    if span <= 0 {
        return end_output;
    }
    let offset = value.saturating_sub(start_value).clamp(0, span);
    let delta = end_output.saturating_sub(start_output);
    let numerator = i64::from(delta).saturating_mul(i64::from(offset));
    let rounded = if numerator >= 0 {
        numerator.saturating_add(i64::from(span / 2)) / i64::from(span)
    } else {
        numerator.saturating_sub(i64::from(span / 2)) / i64::from(span)
    };
    i32::try_from(i64::from(start_output).saturating_add(rounded)).unwrap_or(end_output)
}

#[cfg(test)]
pub(in crate::authority) fn roll_attack_speed_ticks_for_test(
    attack_speed_ms: u64,
    action_id: &str,
    tick_rate_hz: u32,
) -> Option<u64> {
    CombatActionId::from_wire(action_id)
        .map(|action_id| roll_attack_speed_ticks(attack_speed_ms, action_id, tick_rate_hz))
}

#[cfg(test)]
pub(in crate::authority) const fn roll_burst_rounds_for_test() -> u32 {
    ROLL_BURST_ROUNDS
}

#[cfg(test)]
pub(in crate::authority) fn roll_burst_damage_band_for_test(stats: WeaponRollStats) -> (u32, u32) {
    roll_burst_damage_band(stats, ROLL_BURST_ROUNDS)
}

#[cfg(test)]
pub(in crate::authority) fn melee_roll_damage_band_for_test(stats: WeaponRollStats) -> (u32, u32) {
    roll_burst_damage_band(stats, 1)
}

#[cfg(test)]
pub(in crate::authority) fn apply_melee_damage_shaping_for_test(
    professions: &ActorProfessionState,
    stats: WeaponRollStats,
    damage: u32,
    attack_rounds: u32,
) -> u32 {
    apply_melee_damage_shaping(professions, stats, damage, attack_rounds)
}

use super::*;
use std::collections::{BTreeMap, BTreeSet, VecDeque};

pub(crate) const EXCHANGE_METRICS_RING_CAPACITY: usize = 256;
const EXCHANGE_METRICS_SCHEMA: &str = "successor.authority.exchange-metrics.v1";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorityExchangeMetricsSnapshot {
    pub schema: String,
    pub tick: u64,
    pub ring_capacity: usize,
    pub active_exchanges: Vec<AuthorityActiveExchangeSnapshot>,
    pub closed_exchanges: Vec<AuthorityClosedExchangeSnapshot>,
    pub weapon_counters: Vec<AuthorityWeaponExchangeCounterSnapshot>,
    pub totals: AuthorityExchangeTotalsSnapshot,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorityExchangeTotalsSnapshot {
    pub active: usize,
    pub closed_retained: usize,
    pub closed_lifetime: u64,
    pub swings: u64,
    pub hits: u64,
    pub misses: u64,
    pub deflects: u64,
    pub blocks: u64,
    pub damage: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorityActiveExchangeSnapshot {
    pub participants: Vec<String>,
    pub weapons_used: Vec<String>,
    pub opened_tick: u64,
    pub last_activity_tick: u64,
    pub duration_ticks: u64,
    pub area: String,
    pub swings: u64,
    pub hits: u64,
    pub misses: u64,
    pub deflects: u64,
    pub blocks: u64,
    pub damage_dealt: BTreeMap<String, i64>,
    pub damage_taken: BTreeMap<String, i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorityClosedExchangeSnapshot {
    pub participants: Vec<String>,
    pub weapons_used: Vec<String>,
    pub opened_tick: u64,
    pub closed_tick: u64,
    pub duration_ticks: u64,
    pub outcome: String,
    pub area: String,
    pub swings: u64,
    pub hits: u64,
    pub misses: u64,
    pub deflects: u64,
    pub blocks: u64,
    pub damage_dealt: BTreeMap<String, i64>,
    pub damage_taken: BTreeMap<String, i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorityWeaponExchangeCounterSnapshot {
    pub weapon: String,
    pub swings: u64,
    pub closed_exchanges: u64,
    pub total_ttk_ticks: u64,
    pub mean_ttk_ticks: u64,
    pub total_damage: i64,
    pub mean_damage_per_exchange: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ExchangeMetricsStore {
    active: BTreeMap<ExchangeKey, ActiveExchange>,
    closed: VecDeque<AuthorityClosedExchangeSnapshot>,
    weapon_counters: BTreeMap<String, WeaponExchangeCounter>,
    closed_lifetime: u64,
}

impl Default for ExchangeMetricsStore {
    fn default() -> Self {
        Self {
            active: BTreeMap::new(),
            closed: VecDeque::with_capacity(EXCHANGE_METRICS_RING_CAPACITY),
            weapon_counters: BTreeMap::new(),
            closed_lifetime: 0,
        }
    }
}

impl ExchangeMetricsStore {
    pub(crate) fn record_queue_entry(
        &mut self,
        actor_id: &str,
        target_actor_id: &str,
        area: &str,
        tick: u64,
    ) {
        self.open_or_touch(actor_id, target_actor_id, area, tick);
    }

    pub(crate) fn record_combat_event(&mut self, event: &AuthorityCombatEventSnapshot, area: &str) {
        let attacker_id = event
            .attacker_actor_id
            .as_deref()
            .unwrap_or(&event.shooter_actor_id);
        if attacker_id.is_empty()
            || event.target_actor_id.is_empty()
            || attacker_id == event.target_actor_id
        {
            return;
        }
        let weapon = authority_weapon_id_label(event.weapon_id).to_owned();
        let damage = i64::from(event.damage.max(0));
        let outcome = exchange_outcome_for_event(event);
        let key = ExchangeKey::new(attacker_id, &event.target_actor_id);
        {
            let exchange =
                self.open_or_touch(attacker_id, &event.target_actor_id, area, event.tick);
            exchange.weapons_used.insert(weapon.clone());
            exchange.swings = exchange.swings.saturating_add(1);
            let deflected = event_counts_as_deflect(event);
            let blocked = event_counts_as_block(event);
            if damage > 0 {
                exchange.hits = exchange.hits.saturating_add(1);
                if blocked {
                    exchange.blocks = exchange.blocks.saturating_add(1);
                }
            } else if deflected {
                exchange.deflects = exchange.deflects.saturating_add(1);
                exchange.blocks = exchange.blocks.saturating_add(1);
            } else if blocked {
                exchange.blocks = exchange.blocks.saturating_add(1);
            } else {
                exchange.misses = exchange.misses.saturating_add(1);
            }
            if damage > 0 {
                add_i64(&mut exchange.damage_dealt, attacker_id, damage);
                add_i64(&mut exchange.damage_taken, &event.target_actor_id, damage);
                add_i64(&mut exchange.damage_by_weapon, &weapon, damage);
            }
        }
        let weapon_counter = self.weapon_counters.entry(weapon.clone()).or_default();
        weapon_counter.swings = weapon_counter.swings.saturating_add(1);
        if let Some(outcome) = outcome {
            self.close_key(&key, event.tick, outcome);
        }
    }

    pub(crate) fn record_peace(&mut self, actor_id: &str, tick: u64) {
        self.close_actor_exchanges(actor_id, tick, "peace");
    }

    pub(crate) fn record_leash_actor(&mut self, actor_id: &str, tick: u64) {
        self.close_actor_exchanges(actor_id, tick, "leash");
    }

    pub(crate) fn close_timeouts(&mut self, tick: u64, timeout_ticks: u64) {
        let expired = self
            .active
            .iter()
            .filter(|(_, exchange)| {
                tick >= exchange
                    .last_activity_tick
                    .saturating_add(timeout_ticks.max(1))
            })
            .map(|(key, _)| key.clone())
            .collect::<Vec<_>>();
        for key in expired {
            self.close_key(&key, tick, "timeout");
        }
    }

    pub(crate) fn snapshot(&self, tick: u64) -> AuthorityExchangeMetricsSnapshot {
        let active_exchanges = self
            .active
            .values()
            .map(|exchange| exchange.snapshot(tick))
            .collect();
        let closed_exchanges = self.closed.iter().cloned().collect::<Vec<_>>();
        let weapon_counters = self
            .weapon_counters
            .iter()
            .map(|(weapon, counter)| counter.snapshot(weapon))
            .collect::<Vec<_>>();
        let totals = self.totals();
        AuthorityExchangeMetricsSnapshot {
            schema: EXCHANGE_METRICS_SCHEMA.to_owned(),
            tick,
            ring_capacity: EXCHANGE_METRICS_RING_CAPACITY,
            active_exchanges,
            closed_exchanges,
            weapon_counters,
            totals,
        }
    }

    fn open_or_touch(
        &mut self,
        actor_id: &str,
        target_actor_id: &str,
        area: &str,
        tick: u64,
    ) -> &mut ActiveExchange {
        let key = ExchangeKey::new(actor_id, target_actor_id);
        if self.active.get(&key).is_some_and(|exchange| {
            !exchange.area.is_empty() && !area.is_empty() && exchange.area != area
        }) {
            self.close_key(&key, tick, "leash");
        }
        self.active
            .entry(key.clone())
            .or_insert_with(|| ActiveExchange::new(key.participants, area, tick))
            .touch(area, tick)
    }

    fn close_actor_exchanges(&mut self, actor_id: &str, tick: u64, outcome: &'static str) {
        let keys = self
            .active
            .keys()
            .filter(|key| {
                key.participants
                    .iter()
                    .any(|participant| participant == actor_id)
            })
            .cloned()
            .collect::<Vec<_>>();
        for key in keys {
            self.close_key(&key, tick, outcome);
        }
    }

    fn close_key(&mut self, key: &ExchangeKey, closed_tick: u64, outcome: &'static str) {
        let Some(exchange) = self.active.remove(key) else {
            return;
        };
        let damage_by_weapon = exchange.damage_by_weapon.clone();
        let closed = exchange.close(closed_tick, outcome);
        self.closed_lifetime = self.closed_lifetime.saturating_add(1);
        for weapon in &closed.weapons_used {
            let counter = self.weapon_counters.entry(weapon.clone()).or_default();
            counter.closed_exchanges = counter.closed_exchanges.saturating_add(1);
            counter.total_ttk_ticks = counter
                .total_ttk_ticks
                .saturating_add(closed.duration_ticks);
            counter.total_damage = counter
                .total_damage
                .saturating_add(damage_by_weapon.get(weapon).copied().unwrap_or(0));
        }
        self.closed.push_back(closed);
        while self.closed.len() > EXCHANGE_METRICS_RING_CAPACITY {
            self.closed.pop_front();
        }
    }

    fn totals(&self) -> AuthorityExchangeTotalsSnapshot {
        let mut totals = AuthorityExchangeTotalsSnapshot {
            active: self.active.len(),
            closed_retained: self.closed.len(),
            closed_lifetime: self.closed_lifetime,
            swings: 0,
            hits: 0,
            misses: 0,
            deflects: 0,
            blocks: 0,
            damage: 0,
        };
        for exchange in self.active.values() {
            totals.swings = totals.swings.saturating_add(exchange.swings);
            totals.hits = totals.hits.saturating_add(exchange.hits);
            totals.misses = totals.misses.saturating_add(exchange.misses);
            totals.deflects = totals.deflects.saturating_add(exchange.deflects);
            totals.blocks = totals.blocks.saturating_add(exchange.blocks);
            totals.damage = totals.damage.saturating_add(exchange.total_damage());
        }
        for exchange in &self.closed {
            totals.swings = totals.swings.saturating_add(exchange.swings);
            totals.hits = totals.hits.saturating_add(exchange.hits);
            totals.misses = totals.misses.saturating_add(exchange.misses);
            totals.deflects = totals.deflects.saturating_add(exchange.deflects);
            totals.blocks = totals.blocks.saturating_add(exchange.blocks);
            totals.damage = totals
                .damage
                .saturating_add(exchange.damage_dealt.values().copied().sum::<i64>());
        }
        totals
    }
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
struct ExchangeKey {
    participants: [String; 2],
}

impl ExchangeKey {
    fn new(left: &str, right: &str) -> Self {
        if left <= right {
            Self {
                participants: [left.to_owned(), right.to_owned()],
            }
        } else {
            Self {
                participants: [right.to_owned(), left.to_owned()],
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ActiveExchange {
    participants: [String; 2],
    weapons_used: BTreeSet<String>,
    opened_tick: u64,
    last_activity_tick: u64,
    area: String,
    swings: u64,
    hits: u64,
    misses: u64,
    deflects: u64,
    blocks: u64,
    damage_dealt: BTreeMap<String, i64>,
    damage_taken: BTreeMap<String, i64>,
    damage_by_weapon: BTreeMap<String, i64>,
}

impl ActiveExchange {
    fn new(participants: [String; 2], area: &str, tick: u64) -> Self {
        Self {
            participants,
            weapons_used: BTreeSet::new(),
            opened_tick: tick,
            last_activity_tick: tick,
            area: area.to_owned(),
            swings: 0,
            hits: 0,
            misses: 0,
            deflects: 0,
            blocks: 0,
            damage_dealt: BTreeMap::new(),
            damage_taken: BTreeMap::new(),
            damage_by_weapon: BTreeMap::new(),
        }
    }

    fn touch(&mut self, area: &str, tick: u64) -> &mut Self {
        if !area.is_empty() {
            self.area = area.to_owned();
        }
        self.last_activity_tick = self.last_activity_tick.max(tick);
        self
    }

    fn snapshot(&self, tick: u64) -> AuthorityActiveExchangeSnapshot {
        AuthorityActiveExchangeSnapshot {
            participants: self.participants.to_vec(),
            weapons_used: self.weapons_used.iter().cloned().collect(),
            opened_tick: self.opened_tick,
            last_activity_tick: self.last_activity_tick,
            duration_ticks: tick.saturating_sub(self.opened_tick),
            area: self.area.clone(),
            swings: self.swings,
            hits: self.hits,
            misses: self.misses,
            deflects: self.deflects,
            blocks: self.blocks,
            damage_dealt: self.damage_dealt.clone(),
            damage_taken: self.damage_taken.clone(),
        }
    }

    fn close(&self, closed_tick: u64, outcome: &str) -> AuthorityClosedExchangeSnapshot {
        AuthorityClosedExchangeSnapshot {
            participants: self.participants.to_vec(),
            weapons_used: self.weapons_used.iter().cloned().collect(),
            opened_tick: self.opened_tick,
            closed_tick,
            duration_ticks: closed_tick.saturating_sub(self.opened_tick),
            outcome: outcome.to_owned(),
            area: self.area.clone(),
            swings: self.swings,
            hits: self.hits,
            misses: self.misses,
            deflects: self.deflects,
            blocks: self.blocks,
            damage_dealt: self.damage_dealt.clone(),
            damage_taken: self.damage_taken.clone(),
        }
    }

    fn total_damage(&self) -> i64 {
        self.damage_dealt.values().copied().sum()
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct WeaponExchangeCounter {
    swings: u64,
    closed_exchanges: u64,
    total_ttk_ticks: u64,
    total_damage: i64,
}

impl WeaponExchangeCounter {
    fn snapshot(&self, weapon: &str) -> AuthorityWeaponExchangeCounterSnapshot {
        AuthorityWeaponExchangeCounterSnapshot {
            weapon: weapon.to_owned(),
            swings: self.swings,
            closed_exchanges: self.closed_exchanges,
            total_ttk_ticks: self.total_ttk_ticks,
            mean_ttk_ticks: mean_u64(self.total_ttk_ticks, self.closed_exchanges),
            total_damage: self.total_damage,
            mean_damage_per_exchange: mean_i64(self.total_damage, self.closed_exchanges),
        }
    }
}

fn add_i64(map: &mut BTreeMap<String, i64>, key: &str, value: i64) {
    let entry = map.entry(key.to_owned()).or_insert(0);
    *entry = entry.saturating_add(value);
}

fn mean_u64(total: u64, count: u64) -> u64 {
    total.checked_div(count).unwrap_or(0)
}

fn mean_i64(total: i64, count: u64) -> i64 {
    if count == 0 {
        0
    } else {
        total / i64::try_from(count).unwrap_or(i64::MAX).max(1)
    }
}

fn exchange_outcome_for_event(event: &AuthorityCombatEventSnapshot) -> Option<&'static str> {
    match event.lifecycle {
        AuthorityCombatLifecycleKind::Killed => Some("death"),
        AuthorityCombatLifecycleKind::Downed => Some("death"),
        AuthorityCombatLifecycleKind::Hit => {
            (event.life_state != AuthorityLifeState::Alive).then_some("death")
        }
    }
}

fn event_counts_as_deflect(event: &AuthorityCombatEventSnapshot) -> bool {
    event
        .effect
        .as_ref()
        .is_some_and(|effect| effect.kind == "deflected")
        || event.lifecycle_cause.contains("deflect")
}

fn event_counts_as_block(event: &AuthorityCombatEventSnapshot) -> bool {
    event_counts_as_deflect(event)
        || event.lifecycle_cause.contains("shield")
        || event.block_chance_milli.is_some()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exchange_lifecycle_closes_on_peace_leash_timeout_and_death() {
        let mut store = ExchangeMetricsStore::default();
        store.record_queue_entry("alpha", "beta", "arena", 10);
        assert_eq!(store.snapshot(10).totals.active, 1);
        store.record_peace("alpha", 12);
        let snapshot = store.snapshot(12);
        assert_eq!(snapshot.totals.active, 0);
        assert_eq!(snapshot.closed_exchanges.last().unwrap().outcome, "peace");

        store.record_queue_entry("alpha", "gamma", "arena", 20);
        store.record_leash_actor("gamma", 24);
        let snapshot = store.snapshot(24);
        assert_eq!(snapshot.closed_exchanges.last().unwrap().outcome, "leash");

        store.record_queue_entry("delta", "epsilon", "arena", 30);
        store.close_timeouts(35, 5);
        let snapshot = store.snapshot(35);
        assert_eq!(snapshot.closed_exchanges.last().unwrap().outcome, "timeout");

        store.record_combat_event(
            &combat_event(
                "zeta",
                "eta",
                40,
                33,
                AuthorityCombatLifecycleKind::Killed,
                "torso hit",
            ),
            "arena",
        );
        let snapshot = store.snapshot(40);
        assert_eq!(snapshot.closed_exchanges.last().unwrap().outcome, "death");
        assert_eq!(snapshot.totals.closed_lifetime, 4);
    }

    #[test]
    fn exchange_counters_and_weapon_means_are_deterministic() {
        let left = scripted_store_snapshot();
        let right = scripted_store_snapshot();
        assert_eq!(left, right);
        assert_eq!(left.totals.swings, 3);
        assert_eq!(left.totals.hits, 1);
        assert_eq!(left.totals.misses, 1);
        assert_eq!(left.totals.deflects, 1);
        assert_eq!(left.totals.blocks, 1);
        assert_eq!(left.totals.damage, 12);
        let closed = left.closed_exchanges.last().unwrap();
        assert_eq!(
            closed.participants,
            vec!["alpha".to_owned(), "beta".to_owned()]
        );
        assert_eq!(closed.weapons_used, vec!["slugthrower".to_owned()]);
        assert_eq!(closed.damage_dealt["alpha"], 12);
        assert_eq!(closed.damage_taken["beta"], 12);
        let weapon = left
            .weapon_counters
            .iter()
            .find(|row| row.weapon == "slugthrower")
            .unwrap();
        assert_eq!(weapon.swings, 3);
        assert_eq!(weapon.closed_exchanges, 1);
        assert_eq!(weapon.mean_ttk_ticks, 4);
    }

    #[test]
    fn exchange_ring_keeps_last_256_closed_records() {
        let mut store = ExchangeMetricsStore::default();
        for index in 0..300_u64 {
            let attacker = format!("a{index}");
            let target = format!("b{index}");
            store.record_queue_entry(&attacker, &target, "arena", index);
            store.record_peace(&attacker, index.saturating_add(1));
        }
        let snapshot = store.snapshot(301);
        assert_eq!(
            snapshot.closed_exchanges.len(),
            EXCHANGE_METRICS_RING_CAPACITY
        );
        assert_eq!(snapshot.totals.closed_lifetime, 300);
        assert_eq!(
            snapshot.closed_exchanges.first().unwrap().participants[0],
            "a44"
        );
        assert_eq!(
            snapshot.closed_exchanges.last().unwrap().participants[0],
            "a299"
        );
    }

    fn scripted_store_snapshot() -> AuthorityExchangeMetricsSnapshot {
        let mut store = ExchangeMetricsStore::default();
        store.record_queue_entry("alpha", "beta", "arena", 100);
        store.record_combat_event(
            &combat_event(
                "alpha",
                "beta",
                101,
                12,
                AuthorityCombatLifecycleKind::Hit,
                "torso hit",
            ),
            "arena",
        );
        store.record_combat_event(
            &combat_event(
                "alpha",
                "beta",
                102,
                0,
                AuthorityCombatLifecycleKind::Hit,
                "ranged roll miss",
            ),
            "arena",
        );
        store.record_combat_event(
            &combat_event(
                "alpha",
                "beta",
                103,
                0,
                AuthorityCombatLifecycleKind::Hit,
                "deflected",
            ),
            "arena",
        );
        store.record_peace("alpha", 104);
        store.snapshot(104)
    }

    fn combat_event(
        shooter_actor_id: &str,
        target_actor_id: &str,
        tick: u64,
        damage: i32,
        lifecycle: AuthorityCombatLifecycleKind,
        cause: &str,
    ) -> AuthorityCombatEventSnapshot {
        AuthorityCombatEventSnapshot {
            id: tick,
            command_id: None,
            tick,
            shooter_actor_id: shooter_actor_id.to_owned(),
            target_actor_id: target_actor_id.to_owned(),
            origin_x: Some(0.0),
            origin_y: Some(0.0),
            hit_x: 1.0,
            hit_y: 1.0,
            damage,
            previous_life_state: AuthorityLifeState::Alive,
            life_state: if lifecycle == AuthorityCombatLifecycleKind::Killed {
                AuthorityLifeState::Downed
            } else {
                AuthorityLifeState::Alive
            },
            target_lifecycle_seq: 1,
            bleed_stack_count: 0,
            lifecycle,
            zone: "torso".to_owned(),
            weapon_id: AuthorityWeaponId::Slugthrower,
            ammo_type: AuthorityAmmoTypeId::SlugIron,
            effect: (cause == "deflected").then(|| AuthorityCombatEffectSnapshot {
                kind: "deflected".to_owned(),
                stacks: 0,
                threshold: 0,
                remaining_ticks: 0,
            }),
            lifecycle_cause: cause.to_owned(),
            kind: None,
            attacker_actor_id: None,
            action_id: None,
            hit: None,
            pool: None,
            roll_milli: None,
            to_hit_milli: None,
            block_roll_milli: None,
            block_chance_milli: (cause == "deflected").then_some(900),
        }
    }
}

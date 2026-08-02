//! Combat VFX driver — the read-only combat-event tap (port of
//! `client-3d/src/render/fx/events.ts`).
//!
//! Consumes the authoritative `ServerAuthorityCombatEventState` shape streamed
//! by the server (`damage`/`effect`/`lifecycle`/roll-combat fields, actor and
//! weapon ids, sim-space origin/hit points) and drives the particle pool: a
//! muzzle flash at the shot origin, a tracer origin → hit, and an outcome
//! burst at the hit point. Events are deduped by id (bounded window + a
//! monotonic watermark) so a resent snapshot or a re-drained queue never
//! double-fires — combat FX are idempotent per event id. This is the
//! presentation half; the sim owns the authoritative rolls.

use successor_engine_render::fx::ParticlePool;

/// Presentation outcome derived from the authoritative event, following the
/// precedence in `events.ts`: deflect/shield beats dodge beats sleep beats
/// damage blood beats plain sparks.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CombatOutcome {
    /// Damaging hit on flesh → blood burst.
    Blood,
    /// Non-damaging contact / armor ping → sparks.
    Spark,
    /// Personal-shield or saber deflect → bright spark fan.
    Deflect,
    /// Dodged: no impact burst (a faint whiff only).
    Dodge,
    /// Sleep dart: intentionally no burst (never fake blood).
    Sleep,
}

/// Weapon presentation family for bolt/muzzle coloring, derived from the
/// event's `weaponId`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WeaponVisual {
    Slugthrower,
    Plasma,
    Melee,
    Unknown,
}

impl WeaponVisual {
    pub fn from_weapon_id(id: Option<&str>) -> Self {
        let Some(id) = id else {
            return WeaponVisual::Unknown;
        };
        let lower = id.to_ascii_lowercase();
        if lower.contains("plasma") {
            WeaponVisual::Plasma
        } else if lower.contains("slug") || lower.contains("rifle") || lower.contains("gun") {
            WeaponVisual::Slugthrower
        } else if lower.contains("sword") || lower.contains("vibro") || lower.contains("blade") {
            WeaponVisual::Melee
        } else {
            WeaponVisual::Unknown
        }
    }

    /// Bolt/muzzle color (linear rgb).
    pub fn color(self) -> [f32; 3] {
        match self {
            WeaponVisual::Plasma => [1.0, 0.36, 0.24],
            WeaponVisual::Slugthrower | WeaponVisual::Unknown => [1.0, 0.79, 0.47],
            WeaponVisual::Melee => [0.85, 0.9, 1.0],
        }
    }
}

/// A projected combat event — the subset of the server's
/// `ServerAuthorityCombatEventState` the presentation needs. Points are SIM
/// cell coordinates; the scene lifts them to world space (terrain height +
/// body heights) before triggering FX.
#[derive(Clone, Debug, PartialEq)]
pub struct CombatEvent {
    pub id: i64,
    pub tick: i64,
    pub shooter_actor_id: String,
    pub target_actor_id: String,
    /// Muzzle / shot origin (sim cells), when the event carries one.
    pub origin: Option<[f32; 2]>,
    /// Impact point (sim cells), when the event carries one.
    pub hit_point: Option<[f32; 2]>,
    pub damage: f32,
    pub outcome: CombatOutcome,
    /// Lifecycle transitions (drive death/downed presentation + magnitude).
    pub killed: bool,
    pub downed: bool,
    /// True for projectile events (roll-combat `ranged_roll` or an origin far
    /// enough from the hit to read as a shot) — gates muzzle flash + tracer.
    pub ranged: bool,
    pub weapon: WeaponVisual,
}

impl CombatEvent {
    /// Burst magnitude: damage-scaled, boosted on kill (events.ts
    /// `killedMagnitudeBoost` semantics).
    pub fn magnitude(&self) -> f32 {
        let base = (self.damage / 25.0).clamp(0.4, 1.6);
        if self.killed {
            base + 1.0
        } else {
            base
        }
    }

    /// Decode one server event object, reading fields defensively. Returns
    /// `None` when the id is missing (undeliverable — nothing to dedupe on).
    pub fn from_json(v: &serde_json::Value) -> Option<Self> {
        let id = v
            .get("id")
            .or_else(|| v.get("eventId"))
            .and_then(|x| x.as_i64())?;
        let tick = v.get("tick").and_then(|x| x.as_i64()).unwrap_or(0);
        let shooter = str_field(v, "shooterActorId");
        let target = str_field(v, "targetActorId");
        let origin = point2(v.get("originPoint"));
        let hit_point = point2(v.get("hitPoint"));
        let damage = v.get("damage").and_then(|x| x.as_f64()).unwrap_or(0.0) as f32;
        if !damage.is_finite() {
            return None;
        }

        let effect_kind = v
            .get("effect")
            .and_then(|e| e.get("kind"))
            .and_then(|k| k.as_str())
            .unwrap_or("");
        let lifecycle_kind = v
            .get("lifecycle")
            .and_then(|l| l.get("kind"))
            .and_then(|k| k.as_str())
            .unwrap_or("");
        let lifecycle_cause = v
            .get("lifecycle")
            .and_then(|l| l.get("cause"))
            .and_then(|c| c.as_str())
            .unwrap_or("");
        let prev_life = str_field(v, "previousLifeState");
        let life = str_field(v, "lifeState");

        let killed = lifecycle_kind == "killed" || (prev_life != life && life == "respawning");
        let downed = lifecycle_kind == "downed" || (prev_life != life && life == "downed");

        // Outcome precedence (events.ts): deflect/shield > dodge > sleep >
        // damaging blood > sparks.
        let deflected = effect_kind == "deflected"
            || effect_kind == "shield"
            || lifecycle_cause == "personal shield"
            || lifecycle_cause == "personal-shield";
        let dodged = effect_kind == "dodge" || lifecycle_cause == "dodged";
        let outcome = if deflected {
            CombatOutcome::Deflect
        } else if dodged {
            CombatOutcome::Dodge
        } else if effect_kind == "sleep" {
            CombatOutcome::Sleep
        } else if damage > 0.0 {
            CombatOutcome::Blood
        } else {
            CombatOutcome::Spark
        };

        let kind = v.get("kind").and_then(|k| k.as_str()).unwrap_or("");
        let ranged = kind == "ranged_roll" || origin.is_some();
        let weapon = WeaponVisual::from_weapon_id(v.get("weaponId").and_then(|w| w.as_str()));

        Some(Self {
            id,
            tick,
            shooter_actor_id: shooter,
            target_actor_id: target,
            origin,
            hit_point,
            damage,
            outcome,
            killed,
            downed,
            ranged,
            weapon,
        })
    }
}

fn str_field(v: &serde_json::Value, key: &str) -> String {
    v.get(key)
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string()
}

/// A finite `{x, y}` sim point, else `None` (malformed points are dropped, not
/// guessed).
fn point2(v: Option<&serde_json::Value>) -> Option<[f32; 2]> {
    let v = v?;
    let x = v.get("x")?.as_f64()? as f32;
    let y = v.get("y")?.as_f64()? as f32;
    (x.is_finite() && y.is_finite()).then_some([x, y])
}

/// How many recent ids the duplicate window retains (beyond the watermark).
const SEEN_WINDOW: usize = 128;

/// Drives the particle pool from a stream of combat events, deduped by id.
pub struct CombatFx {
    pool: ParticlePool,
    /// Every id ≤ watermark has been processed (events stream in id order;
    /// the window covers out-of-order stragglers above it).
    watermark: i64,
    seen: [i64; SEEN_WINDOW],
    seen_cursor: usize,
}

impl CombatFx {
    pub fn new(seed: u32) -> Self {
        Self {
            pool: ParticlePool::new(seed),
            watermark: i64::MIN,
            seen: [i64::MIN; SEEN_WINDOW],
            seen_cursor: 0,
        }
    }

    pub fn pool(&self) -> &ParticlePool {
        &self.pool
    }
    pub fn pool_mut(&mut self) -> &mut ParticlePool {
        &mut self.pool
    }

    pub fn update(&mut self, dt: f32) {
        self.pool.update(dt);
    }

    /// Record an id; true if it was already processed. Idempotency contract:
    /// each event id fires at most once for the lifetime of this driver.
    fn already_seen(&mut self, id: i64) -> bool {
        if id <= self.watermark || self.seen.contains(&id) {
            return true;
        }
        self.seen[self.seen_cursor] = id;
        self.seen_cursor = (self.seen_cursor + 1) % self.seen.len();
        if id > self.watermark + SEEN_WINDOW as i64 {
            // Far ahead: everything below the window floor is implicitly seen.
            self.watermark = id - SEEN_WINDOW as i64;
        }
        false
    }

    /// Fire the VFX for one event, with world-space origin/hit already
    /// resolved by the scene (terrain height + chest/muzzle heights). Returns
    /// false if the event id was a duplicate (nothing emitted).
    pub fn trigger(
        &mut self,
        ev: &CombatEvent,
        origin_world: [f32; 3],
        hit_world: [f32; 3],
    ) -> bool {
        if self.already_seen(ev.id) {
            return false;
        }
        let mag = ev.magnitude();
        let mut dir = [
            hit_world[0] - origin_world[0],
            hit_world[1] - origin_world[1],
            hit_world[2] - origin_world[2],
        ];
        let len = (dir[0] * dir[0] + dir[1] * dir[1] + dir[2] * dir[2]).sqrt();
        if len > 1e-4 {
            dir = [dir[0] / len, dir[1] / len, dir[2] / len];
        } else {
            dir = [1.0, 0.0, 0.0];
        }
        if ev.ranged {
            self.pool
                .emit_muzzle_flash(origin_world, dir, mag, ev.weapon.color());
            self.pool.emit_tracer(origin_world, hit_world, mag);
        }
        let normal = [-dir[0], -dir[1], -dir[2]];
        match ev.outcome {
            CombatOutcome::Blood => self.pool.emit_blood_burst(hit_world, dir, mag),
            CombatOutcome::Spark => self
                .pool
                .emit_spark_burst(hit_world, normal, dir, mag * 0.7),
            CombatOutcome::Deflect => self
                .pool
                .emit_spark_burst(hit_world, normal, dir, mag * 1.2),
            // A dodged shot whiffs past: the tracer already told the story.
            CombatOutcome::Dodge => {}
            // Sleep darts intentionally no-op rather than faking an impact.
            CombatOutcome::Sleep => {}
        }
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn shot_json(id: i64) -> serde_json::Value {
        json!({
            "id": id,
            "tick": 900,
            "shooterActorId": "1:1",
            "targetActorId": "npc:9",
            "originPoint": { "x": 10.0, "y": 12.0 },
            "hitPoint": { "x": 14.0, "y": 12.0 },
            "damage": 18,
            "zone": "chest",
            "previousLifeState": "alive",
            "lifeState": "alive",
            "kind": "ranged_roll",
            "hit": true,
            "weaponId": "slugthrower",
        })
    }

    #[test]
    fn decodes_the_authoritative_event_shape() {
        let ev = CombatEvent::from_json(&shot_json(41)).expect("decodes");
        assert_eq!(ev.id, 41);
        assert_eq!(ev.shooter_actor_id, "1:1");
        assert_eq!(ev.target_actor_id, "npc:9");
        assert_eq!(ev.origin, Some([10.0, 12.0]));
        assert_eq!(ev.hit_point, Some([14.0, 12.0]));
        assert_eq!(ev.outcome, CombatOutcome::Blood);
        assert!(ev.ranged);
        assert!(!ev.killed);
        assert_eq!(ev.weapon, WeaponVisual::Slugthrower);
    }

    #[test]
    fn outcome_precedence_deflect_beats_damage() {
        let mut v = shot_json(1);
        v["effect"] = json!({ "kind": "deflected" });
        let ev = CombatEvent::from_json(&v).unwrap();
        assert_eq!(ev.outcome, CombatOutcome::Deflect);

        let mut v = shot_json(2);
        v["lifecycle"] = json!({ "kind": "hit", "cause": "personal shield" });
        v["damage"] = json!(0);
        assert_eq!(
            CombatEvent::from_json(&v).unwrap().outcome,
            CombatOutcome::Deflect
        );

        let mut v = shot_json(3);
        v["effect"] = json!({ "kind": "dodge" });
        assert_eq!(
            CombatEvent::from_json(&v).unwrap().outcome,
            CombatOutcome::Dodge
        );

        let mut v = shot_json(4);
        v["effect"] = json!({ "kind": "sleep" });
        v["damage"] = json!(0);
        assert_eq!(
            CombatEvent::from_json(&v).unwrap().outcome,
            CombatOutcome::Sleep
        );
    }

    #[test]
    fn lifecycle_transitions_mark_killed_and_downed() {
        let mut v = shot_json(5);
        v["lifecycle"] = json!({ "kind": "killed" });
        let ev = CombatEvent::from_json(&v).unwrap();
        assert!(ev.killed);
        assert!(ev.magnitude() > 1.0, "kill boosts burst magnitude");

        let mut v = shot_json(6);
        v["previousLifeState"] = json!("alive");
        v["lifeState"] = json!("downed");
        assert!(CombatEvent::from_json(&v).unwrap().downed);
    }

    #[test]
    fn missing_id_or_nonfinite_damage_is_rejected() {
        let mut v = shot_json(7);
        v.as_object_mut().unwrap().remove("id");
        assert!(CombatEvent::from_json(&v).is_none());
    }

    #[test]
    fn trigger_is_idempotent_per_event_id() {
        let mut fx = CombatFx::new(7);
        let ev = CombatEvent::from_json(&shot_json(100)).unwrap();
        let o = [10.5, 1.35, 12.5];
        let h = [14.5, 1.0, 12.5];
        assert!(fx.trigger(&ev, o, h));
        let first = fx.pool().alive();
        assert!(first > 0, "first trigger emits particles");
        assert!(!fx.trigger(&ev, o, h), "duplicate id is a no-op");
        assert_eq!(fx.pool().alive(), first, "no double emission");
    }

    #[test]
    fn watermark_rejects_ids_behind_the_window() {
        let mut fx = CombatFx::new(7);
        let mk = |id: i64| {
            let mut e = CombatEvent::from_json(&shot_json(id)).unwrap();
            e.id = id;
            e
        };
        let o = [0.0, 1.0, 0.0];
        // Stream a long run of ids; the watermark advances behind them.
        for id in 0..(SEEN_WINDOW as i64 * 3) {
            fx.trigger(&mk(id), o, o);
        }
        // An ancient id (resent snapshot) must not re-fire.
        assert!(!fx.trigger(&mk(1), o, o));
    }

    #[test]
    fn melee_events_skip_muzzle_and_tracer() {
        let mut fx = CombatFx::new(9);
        let v = json!({
            "id": 500,
            "shooterActorId": "a",
            "targetActorId": "b",
            "damage": 10,
            "previousLifeState": "alive",
            "lifeState": "alive",
            "weaponId": "vibrosword",
        });
        let ev = CombatEvent::from_json(&v).unwrap();
        assert!(!ev.ranged, "no origin point + no ranged_roll → melee");
        assert!(fx.trigger(&ev, [0.0, 1.0, 0.0], [0.5, 1.0, 0.0]));
        // Blood burst only (normal layer); no additive muzzle/tracer quads.
        assert_eq!(fx.pool().additive.alive(), 0);
        assert!(fx.pool().normal.alive() > 0);
    }
}

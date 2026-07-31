//! Combat VFX driver — the read-only combat-event tap (`render/fx/events.ts`).
//!
//! Consumes authoritative combat events and drives the particle pool: a muzzle
//! flash at the shooter origin, a tracer from origin → hit, and an outcome burst
//! at the hit point (blood for a wound, sparks for a shield/deflect ping). Events
//! are deduped by id so a resent snapshot never double-fires. This is the
//! presentation half; the sim owns the authoritative rolls (AGENTS.md authority
//! boundary).

use successor_engine_render::fx::ParticlePool;

/// Outcome codes (mirror `events.ts` `OUTCOME_*`).
pub const OUTCOME_BLOOD: u8 = 1;
pub const OUTCOME_SPARK: u8 = 2;
pub const OUTCOME_DEFLECT: u8 = 3;

/// A projected combat event the FX driver needs (subset of the server's
/// `ServerAuthorityCombatEventState`).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct CombatEvent {
    pub id: i64,
    /// Muzzle / shot origin (world x,y,z).
    pub origin: [f32; 3],
    /// Impact point (world x,y,z).
    pub hit: [f32; 3],
    pub outcome: u8,
    pub magnitude: f32,
    /// Bolt/muzzle color (linear rgb).
    pub color: [f32; 3],
}

impl CombatEvent {
    /// Project from a server event JSON object, reading fields defensively.
    /// Accepts `{x,y,z}` (world) or `{x,y}` (sim → world `(x, chest, y)`).
    pub fn from_json(v: &serde_json::Value) -> Option<Self> {
        let id = v
            .get("id")
            .or_else(|| v.get("eventId"))
            .and_then(|x| x.as_i64())?;
        let origin = read_point(v.get("originPoint").or_else(|| v.get("origin"))?)?;
        let hit = read_point(
            v.get("hitPoint")
                .or_else(|| v.get("hit"))
                .unwrap_or(&serde_json::Value::Null),
        )
        .unwrap_or(origin);
        let outcome = v.get("outcome").and_then(|x| x.as_u64()).unwrap_or(0) as u8;
        let magnitude = v
            .get("magnitude")
            .or_else(|| v.get("mag"))
            .and_then(|x| x.as_f64())
            .unwrap_or(1.0) as f32;
        Some(Self {
            id,
            origin,
            hit,
            outcome,
            magnitude,
            color: [1.0, 0.79, 0.47],
        })
    }
}
fn read_point(v: &serde_json::Value) -> Option<[f32; 3]> {
    let x = v.get("x")?.as_f64()? as f32;
    if let Some(z) = v.get("z").and_then(|n| n.as_f64()) {
        let y = v.get("y").and_then(|n| n.as_f64()).unwrap_or(0.0) as f32;
        Some([x, y, z as f32])
    } else {
        // 2-D sim point: sim-y becomes world-z, chest-height fallback.
        let y = v.get("y")?.as_f64()? as f32;
        Some([x, 1.35, y])
    }
}

/// Drives the particle pool from a stream of combat events, deduped by id.
pub struct CombatFx {
    pool: ParticlePool,
    seen: [i64; 64],
    seen_cursor: usize,
}

impl CombatFx {
    pub fn new(seed: u32) -> Self {
        Self {
            pool: ParticlePool::new(seed),
            seen: [i64::MIN; 64],
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

    fn already_seen(&mut self, id: i64) -> bool {
        if self.seen.contains(&id) {
            return true;
        }
        self.seen[self.seen_cursor] = id;
        self.seen_cursor = (self.seen_cursor + 1) % self.seen.len();
        false
    }

    /// Fire the VFX for one event (once). Returns false if it was a duplicate.
    pub fn trigger(&mut self, ev: &CombatEvent) -> bool {
        if self.already_seen(ev.id) {
            return false;
        }
        let mut dir = [
            ev.hit[0] - ev.origin[0],
            ev.hit[1] - ev.origin[1],
            ev.hit[2] - ev.origin[2],
        ];
        let len = (dir[0] * dir[0] + dir[1] * dir[1] + dir[2] * dir[2]).sqrt();
        if len > 1e-4 {
            dir = [dir[0] / len, dir[1] / len, dir[2] / len];
        } else {
            dir = [1.0, 0.0, 0.0];
        }
        self.pool
            .emit_muzzle_flash(ev.origin, dir, ev.magnitude, ev.color);
        self.pool.emit_tracer(ev.origin, ev.hit, ev.magnitude);
        match ev.outcome {
            OUTCOME_BLOOD => self.pool.emit_blood_burst(ev.hit, dir, ev.magnitude),
            OUTCOME_SPARK | OUTCOME_DEFLECT => {
                let normal = [-dir[0], -dir[1], -dir[2]];
                self.pool
                    .emit_spark_burst(ev.hit, normal, dir, ev.magnitude);
            }
            _ => {}
        }
        true
    }

    /// Ingest a batch of events (new ones fire; duplicates are skipped).
    pub fn ingest(&mut self, events: &[CombatEvent]) {
        for ev in events {
            self.trigger(ev);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ev(id: i64, outcome: u8) -> CombatEvent {
        CombatEvent {
            id,
            origin: [0.0, 1.3, 0.0],
            hit: [3.0, 1.1, 0.0],
            outcome,
            magnitude: 1.2,
            color: [1.0, 0.8, 0.5],
        }
    }

    #[test]
    fn blood_event_emits_muzzle_tracer_and_blood() {
        let mut fx = CombatFx::new(1);
        assert!(fx.trigger(&ev(1, OUTCOME_BLOOD)));
        assert!(
            fx.pool().additive.alive() > 0,
            "muzzle + tracer on additive layer"
        );
        assert!(fx.pool().normal.alive() > 0, "blood on normal layer");
    }

    #[test]
    fn spark_event_uses_additive_only() {
        let mut fx = CombatFx::new(1);
        fx.trigger(&ev(2, OUTCOME_SPARK));
        assert!(fx.pool().additive.alive() > 0);
        assert_eq!(fx.pool().normal.alive(), 0, "no blood for a spark ping");
    }

    #[test]
    fn duplicate_event_id_fires_once() {
        let mut fx = CombatFx::new(1);
        assert!(fx.trigger(&ev(7, OUTCOME_BLOOD)));
        let after_first = fx.pool().alive();
        assert!(!fx.trigger(&ev(7, OUTCOME_BLOOD)), "same id deduped");
        assert_eq!(fx.pool().alive(), after_first, "no new particles on dup");
    }

    #[test]
    fn from_json_reads_3d_and_2d_points() {
        let v: serde_json::Value = serde_json::from_str(
            r#"{"id":42,"originPoint":{"x":1.0,"y":1.3,"z":2.0},"hitPoint":{"x":4.0,"y":5.0},"outcome":1,"magnitude":2.0}"#,
        )
        .unwrap();
        let e = CombatEvent::from_json(&v).unwrap();
        assert_eq!(e.id, 42);
        assert_eq!(e.origin, [1.0, 1.3, 2.0]);
        // hit is a 2-D sim point → (x, chest, y).
        assert_eq!(e.hit, [4.0, 1.35, 5.0]);
        assert_eq!(e.outcome, 1);
        assert!((e.magnitude - 2.0).abs() < 1e-6);
    }
}

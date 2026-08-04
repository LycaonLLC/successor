//! WAYPOINT store — client-side, per-character navigation marks (port of
//! `ui/waypoints/store.ts`).
//!
//! Persistence is local and immediate: every mutation rewrites the small
//! (≤100 rows) character-scoped section (`persist.rs`, key `waypoints`,
//! schema `successor3d.waypoints.v1`). Readers (datapad, radar, world beams,
//! slash command) share one in-memory list through a monotonic version
//! counter instead of subscriptions.

use serde_json::{json, Value};

pub const MAX_WAYPOINTS: usize = 100;
pub const NAME_MAX: usize = 48;
const COORD_PRECISION: f32 = 100.0;
pub const STORAGE_SCHEMA: &str = "successor3d.waypoints.v1";

#[derive(Clone, Debug, PartialEq)]
pub struct Waypoint {
    pub id: u32,
    pub name: String,
    pub x: f32,
    pub y: f32,
    pub area_id: String,
    pub active: bool,
    pub created_at_ms: u64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct MutationResult {
    pub ok: bool,
    pub status: String,
}

fn round_coord(v: f32) -> f32 {
    (v * COORD_PRECISION).round() / COORD_PRECISION
}

fn normalize_name(value: Option<&str>, fallback: &str) -> String {
    let name = super::sanitize_text(value.unwrap_or(""), NAME_MAX);
    if name.is_empty() {
        fallback.to_string()
    } else {
        name
    }
}

#[derive(Default)]
pub struct WaypointStore {
    list: Vec<Waypoint>,
    version: u64,
    id_seq: u32,
    dirty: bool,
}

impl WaypointStore {
    pub fn new() -> Self {
        Self::default()
    }

    /// Monotonic change counter — cheap poll for radar/map/beam readers.
    pub fn version(&self) -> u64 {
        self.version
    }

    pub fn waypoints(&self) -> &[Waypoint] {
        &self.list
    }

    pub fn count(&self) -> usize {
        self.list.len()
    }

    /// Active waypoints inside `area_id` (the beam/radar filter).
    pub fn active_in_area<'a>(&'a self, area_id: &'a str) -> impl Iterator<Item = &'a Waypoint> {
        self.list
            .iter()
            .filter(move |w| w.active && w.area_id == area_id)
    }

    /// Whether a mutation happened since the last `mark_saved` — the host
    /// persists the section and clears the flag.
    pub fn dirty(&self) -> bool {
        self.dirty
    }
    pub fn mark_saved(&mut self) {
        self.dirty = false;
    }

    /// First unused `Waypoint N` name.
    pub fn default_name(&self) -> String {
        for i in 1..=(MAX_WAYPOINTS + 1) {
            let candidate = format!("Waypoint {i}");
            if !self.list.iter().any(|w| w.name == candidate) {
                return candidate;
            }
        }
        format!("Waypoint {}", self.list.len() + 1)
    }

    pub fn create(
        &mut self,
        name: Option<&str>,
        x: f32,
        y: f32,
        area_id: &str,
        active: bool,
        now_ms: u64,
    ) -> MutationResult {
        if self.list.len() >= MAX_WAYPOINTS {
            return MutationResult {
                ok: false,
                status: format!("WAYPOINT CAP {MAX_WAYPOINTS}/{MAX_WAYPOINTS} - DELETE ONE FIRST"),
            };
        }
        if !x.is_finite() || !y.is_finite() || area_id.trim().is_empty() {
            return MutationResult {
                ok: false,
                status: "WAYPOINT DENIED - BAD LOCATION".into(),
            };
        }
        self.id_seq += 1;
        let fallback = self.default_name();
        let wp = Waypoint {
            id: self.id_seq,
            name: normalize_name(name, &fallback),
            x: round_coord(x),
            y: round_coord(y),
            area_id: area_id.trim().to_string(),
            active,
            created_at_ms: now_ms,
        };
        let status = format!("{} CREATED", wp.name.to_uppercase());
        self.list.push(wp);
        self.mutated();
        MutationResult { ok: true, status }
    }

    pub fn rename(&mut self, id: u32, next_name: &str) -> MutationResult {
        let Some(wp) = self.list.iter_mut().find(|w| w.id == id) else {
            return gone();
        };
        let normalized = super::sanitize_text(next_name, NAME_MAX);
        if normalized.is_empty() {
            return MutationResult {
                ok: false,
                status: "WAYPOINT NAME REQUIRED".into(),
            };
        }
        if wp.name == normalized {
            return MutationResult {
                ok: true,
                status: format!("{} UNCHANGED", wp.name.to_uppercase()),
            };
        }
        wp.name = normalized;
        let status = format!("{} RENAMED", wp.name.to_uppercase());
        self.mutated();
        MutationResult { ok: true, status }
    }

    pub fn set_active(&mut self, id: u32, active: bool) -> MutationResult {
        let Some(wp) = self.list.iter_mut().find(|w| w.id == id) else {
            return gone();
        };
        let label = if active { "ACTIVE" } else { "INACTIVE" };
        let status = format!("{} {label}", wp.name.to_uppercase());
        if wp.active != active {
            wp.active = active;
            self.mutated();
        }
        MutationResult { ok: true, status }
    }

    pub fn delete(&mut self, id: u32) -> MutationResult {
        let Some(index) = self.list.iter().position(|w| w.id == id) else {
            return gone();
        };
        let wp = self.list.remove(index);
        self.mutated();
        MutationResult {
            ok: true,
            status: format!("{} DELETED", wp.name.to_uppercase()),
        }
    }

    fn mutated(&mut self) {
        self.version += 1;
        self.dirty = true;
    }

    // ── Persistence (section value under the Character scope) ────────────

    pub fn save(&self) -> Value {
        let rows: Vec<Value> = self
            .list
            .iter()
            .map(|w| {
                json!({
                    "id": w.id,
                    "name": w.name,
                    "x": w.x,
                    "y": w.y,
                    "areaId": w.area_id,
                    "active": w.active,
                    "createdAtMs": w.created_at_ms,
                })
            })
            .collect();
        json!({"schema": STORAGE_SCHEMA, "waypoints": rows})
    }

    /// Load from a persisted section; malformed rows are dropped, a schema
    /// mismatch resets to empty (per-field reset policy).
    pub fn load(section: Option<&Value>) -> Self {
        let mut store = Self::new();
        let Some(v) = section else { return store };
        if v.get("schema").and_then(|s| s.as_str()) != Some(STORAGE_SCHEMA) {
            return store;
        }
        let Some(rows) = v.get("waypoints").and_then(|r| r.as_array()) else {
            return store;
        };
        for row in rows.iter().take(MAX_WAYPOINTS) {
            let (Some(x), Some(y)) = (
                row.get("x").and_then(|v| v.as_f64()),
                row.get("y").and_then(|v| v.as_f64()),
            ) else {
                continue;
            };
            let Some(area_id) = row.get("areaId").and_then(|v| v.as_str()) else {
                continue;
            };
            if area_id.trim().is_empty() || !x.is_finite() || !y.is_finite() {
                continue;
            }
            let id = row.get("id").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
            store.id_seq = store.id_seq.max(id);
            let fallback = store.default_name();
            store.list.push(Waypoint {
                id: if id == 0 {
                    store.id_seq += 1;
                    store.id_seq
                } else {
                    id
                },
                name: normalize_name(row.get("name").and_then(|v| v.as_str()), &fallback),
                x: round_coord(x as f32),
                y: round_coord(y as f32),
                area_id: area_id.trim().to_string(),
                active: row.get("active").and_then(|v| v.as_bool()).unwrap_or(false),
                created_at_ms: row.get("createdAtMs").and_then(|v| v.as_u64()).unwrap_or(0),
            });
        }
        store
    }
}

fn gone() -> MutationResult {
    MutationResult {
        ok: false,
        status: "WAYPOINT GONE".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn create_rename_toggle_delete_round_trip() {
        let mut s = WaypointStore::new();
        let r = s.create(None, 12.345, -7.891, "open-desert", true, 5);
        assert!(r.ok);
        assert_eq!(r.status, "WAYPOINT 1 CREATED");
        let wp = &s.waypoints()[0];
        assert_eq!(wp.x, 12.35, "coords round to 1/100 cell");
        assert_eq!(wp.y, -7.89);
        let id = wp.id;
        assert!(s.rename(id, "The Spire").ok);
        assert_eq!(s.waypoints()[0].name, "The Spire");
        assert!(s.set_active(id, false).ok);
        assert!(!s.waypoints()[0].active);
        assert!(s.delete(id).ok);
        assert_eq!(s.count(), 0);
        assert!(!s.delete(id).ok, "double delete reports GONE");
    }

    #[test]
    fn cap_and_bad_location_are_denied() {
        let mut s = WaypointStore::new();
        for i in 0..MAX_WAYPOINTS {
            assert!(s.create(None, i as f32, 0.0, "area", false, 0).ok);
        }
        let r = s.create(None, 1.0, 1.0, "area", false, 0);
        assert!(!r.ok);
        assert!(r.status.contains("CAP"));
        let mut s2 = WaypointStore::new();
        assert!(!s2.create(None, f32::NAN, 0.0, "area", false, 0).ok);
        assert!(!s2.create(None, 0.0, 0.0, "  ", false, 0).ok);
    }

    #[test]
    fn names_are_sanitized_and_bounded() {
        let mut s = WaypointStore::new();
        let long = "x".repeat(NAME_MAX + 20);
        s.create(Some(&long), 0.0, 0.0, "area", false, 0);
        assert_eq!(s.waypoints()[0].name.chars().count(), NAME_MAX);
        s.create(Some("  ctrl\u{7}chars  "), 1.0, 1.0, "area", false, 0);
        assert_eq!(s.waypoints()[1].name, "ctrlchars");
    }

    #[test]
    fn persistence_round_trips_and_rejects_wrong_schema() {
        let mut s = WaypointStore::new();
        s.create(Some("Alpha"), 3.0, 4.0, "forest", true, 9);
        s.create(None, -1.0, 2.0, "open-desert", false, 10);
        let saved = s.save();
        let loaded = WaypointStore::load(Some(&saved));
        assert_eq!(loaded.waypoints(), s.waypoints());
        assert_eq!(
            loaded.active_in_area("forest").count(),
            1,
            "active-area filter"
        );
        let wrong = json!({"schema": "other.v9", "waypoints": []});
        assert_eq!(WaypointStore::load(Some(&wrong)).count(), 0);
        // Malformed rows drop; valid rows survive.
        let mixed = json!({"schema": STORAGE_SCHEMA, "waypoints": [
            {"x": 1.0, "y": 2.0, "areaId": "a", "id": 7, "name": "Keep"},
            {"x": "bad"},
            {"y": 2.0, "areaId": ""}
        ]});
        let m = WaypointStore::load(Some(&mixed));
        assert_eq!(m.count(), 1);
        assert_eq!(m.waypoints()[0].name, "Keep");
    }

    #[test]
    fn dirty_flag_gates_persistence() {
        let mut s = WaypointStore::new();
        assert!(!s.dirty());
        s.create(None, 0.0, 0.0, "area", false, 0);
        assert!(s.dirty());
        s.mark_saved();
        assert!(!s.dirty());
        // Idempotent set_active does not re-dirty.
        let id = s.waypoints()[0].id;
        s.set_active(id, false);
        assert!(!s.dirty());
    }
}

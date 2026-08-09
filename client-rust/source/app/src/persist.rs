//! Scoped settings-document helper.
//!
//! Each [`SettingsScope`] maps to ONE platform blob (`Platform::load_settings`
//! / `save_settings`). Multiple subsystems persist into the same scope, so the
//! blob is a JSON object where every subsystem owns exactly one top-level key
//! (contract agreed with the shared-app owner):
//!
//! - `runtime`    — `RuntimeSettings` (shared app owner)
//! - `theme`      — UI theme id (Local)
//! - `toolbar`    — toolbar doc, schema 3 (Local)
//! - `chat`       — chat pane prefs (Local)
//! - `splitSnap`  — inventory split-snap step (Local)
//! - `waypoints`  — waypoint store (Character)
//! - `macros`     — character-owned macros (Character)
//! - `firstSteps` — first-steps record (Character)
//!
//! Writers MUST read-modify-write and preserve unknown keys; a corrupt blob
//! resets only on write (the unreadable payload is replaced by a fresh object
//! carrying the new section — the documented per-field reset policy).

use serde_json::{Map, Value};
use successor_platform::{Platform, SettingsScope};

/// Parse a scope blob into its top-level object; corrupt/missing → empty.
fn parse_doc(bytes: Option<Vec<u8>>) -> Map<String, Value> {
    bytes
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
        .and_then(|v| match v {
            Value::Object(m) => Some(m),
            _ => None,
        })
        .unwrap_or_default()
}

/// Read one subsystem section from a scope document.
pub fn load_section<P: Platform>(platform: &P, scope: SettingsScope, key: &str) -> Option<Value> {
    parse_doc(platform.load_settings(scope)).remove(key)
}

/// Write one subsystem section, preserving every other key in the scope doc.
pub fn store_section<P: Platform>(
    platform: &mut P,
    scope: SettingsScope,
    key: &str,
    value: Value,
) -> Result<(), String> {
    let mut doc = parse_doc(platform.load_settings(scope));
    doc.insert(key.to_string(), value);
    let bytes = serde_json::to_vec(&Value::Object(doc)).map_err(|e| e.to_string())?;
    platform.save_settings(scope, &bytes)
}

/// Remove one subsystem section (used by two-step deletes / resets).
pub fn remove_section<P: Platform>(
    platform: &mut P,
    scope: SettingsScope,
    key: &str,
) -> Result<(), String> {
    let mut doc = parse_doc(platform.load_settings(scope));
    if doc.remove(key).is_none() {
        return Ok(());
    }
    let bytes = serde_json::to_vec(&Value::Object(doc)).map_err(|e| e.to_string())?;
    platform.save_settings(scope, &bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use successor_platform::AssetError;

    struct MemPlatform {
        blobs: HashMap<&'static str, Vec<u8>>,
    }
    impl MemPlatform {
        fn new() -> Self {
            Self {
                blobs: HashMap::new(),
            }
        }
        fn name(scope: SettingsScope) -> &'static str {
            match scope {
                SettingsScope::Local => "local",
                SettingsScope::Account => "account",
                SettingsScope::Character => "character",
            }
        }
    }
    impl Platform for MemPlatform {
        fn monotonic_ms(&self) -> u64 {
            0
        }
        fn logical_size(&self) -> (u32, u32) {
            (1280, 720)
        }
        fn read_asset(&self, _stable_id: &str) -> Result<Vec<u8>, AssetError> {
            Err(AssetError::Unreadable)
        }
        fn load_settings(&self, scope: SettingsScope) -> Option<Vec<u8>> {
            self.blobs.get(Self::name(scope)).cloned()
        }
        fn save_settings(&mut self, scope: SettingsScope, bytes: &[u8]) -> Result<(), String> {
            self.blobs.insert(Self::name(scope), bytes.to_vec());
            Ok(())
        }
        fn report_fatal(&mut self, _message: &str) {}
    }

    #[test]
    fn sections_are_independent_and_preserved() {
        let mut p = MemPlatform::new();
        store_section(
            &mut p,
            SettingsScope::Local,
            "toolbar",
            serde_json::json!({"schema": 3}),
        )
        .unwrap();
        store_section(
            &mut p,
            SettingsScope::Local,
            "theme",
            serde_json::json!("amber"),
        )
        .unwrap();
        // Unknown keys written by another subsystem survive our writes.
        let mut doc = parse_doc(p.load_settings(SettingsScope::Local));
        doc.insert("runtime".into(), serde_json::json!({"zoom": 100}));
        let bytes = serde_json::to_vec(&Value::Object(doc)).unwrap();
        p.save_settings(SettingsScope::Local, &bytes).unwrap();
        store_section(
            &mut p,
            SettingsScope::Local,
            "theme",
            serde_json::json!("oxide"),
        )
        .unwrap();

        assert_eq!(
            load_section(&p, SettingsScope::Local, "theme"),
            Some(serde_json::json!("oxide"))
        );
        assert_eq!(
            load_section(&p, SettingsScope::Local, "toolbar"),
            Some(serde_json::json!({"schema": 3}))
        );
        assert_eq!(
            load_section(&p, SettingsScope::Local, "runtime"),
            Some(serde_json::json!({"zoom": 100}))
        );
    }

    #[test]
    fn corrupt_blob_reads_empty_and_recovers_on_write() {
        let mut p = MemPlatform::new();
        p.save_settings(SettingsScope::Character, b"{not json")
            .unwrap();
        assert_eq!(
            load_section(&p, SettingsScope::Character, "waypoints"),
            None
        );
        store_section(
            &mut p,
            SettingsScope::Character,
            "waypoints",
            serde_json::json!([]),
        )
        .unwrap();
        assert_eq!(
            load_section(&p, SettingsScope::Character, "waypoints"),
            Some(serde_json::json!([]))
        );
    }

    #[test]
    fn remove_section_leaves_others() {
        let mut p = MemPlatform::new();
        store_section(&mut p, SettingsScope::Local, "a", serde_json::json!(1)).unwrap();
        store_section(&mut p, SettingsScope::Local, "b", serde_json::json!(2)).unwrap();
        remove_section(&mut p, SettingsScope::Local, "a").unwrap();
        assert_eq!(load_section(&p, SettingsScope::Local, "a"), None);
        assert_eq!(
            load_section(&p, SettingsScope::Local, "b"),
            Some(serde_json::json!(2))
        );
    }
}

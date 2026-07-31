//! Asset resolution tailored to this repository's conventions (NOT the voxel
//! VPAK model).
//!
//! This repo describes runtime assets with small manifest JSON files that carry
//! an `assetBase` plus `entries` keyed by a stable id, and resolves the final
//! public URL through `client/src/slice-core/runtimePublicPaths.ts`
//! (`resolveRuntimePublicPath`). Two manifest shapes exist and both are
//! accepted here:
//!
//! * object-keyed (e.g. `client-3d/src/render/props-mapping.json`):
//!   `{ "format": "...", "assetBase": "/assets/world-items/",
//!      "entries": { "road_barrier": { "glb": "barricade_concrete.glb" }, ... } }`
//! * array-with-id (e.g. `client-3d/public/assets/wave-props/manifest.json`):
//!   `{ "format": "...", "assetBase": "/assets/wave-props/",
//!      "entries": [ { "id": "ammo_001", "glb": "...", "kind": "..." }, ... ] }`
//!
//! `engine-core` performs no I/O: the platform fetches the manifest bytes
//! (`fetch` on web, filesystem on native), and this module parses + indexes the
//! already-decoded [`Json`]. URL resolution mirrors `props.ts`: an entry `glb`
//! that itself starts with `/` is treated as an absolute public path; otherwise
//! it is joined onto `assetBase`.

use alloc::collections::BTreeMap;
use alloc::string::{String, ToString};
use alloc::vec::Vec;

use crate::json::Json;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum AssetError {
    /// Manifest was not a JSON object, or `entries` had an unusable shape.
    Malformed,
    /// An array entry was missing its required `id`.
    MissingId,
    /// `expect_format`/`expect_schema` discriminator did not match.
    WrongSchema,
}

#[derive(Clone, PartialEq, Debug)]
pub struct AssetEntry {
    pub key: String,
    /// The `glb` (or `path`) field, relative to `assetBase` unless it is itself
    /// an absolute `/…` public path.
    pub glb: String,
    pub kind: Option<String>,
    /// The full original entry object, so callers can read extra fields
    /// (`interactable`, `assetRotationDegrees`, `animatedScreen`, …).
    pub extra: Json,
}

pub struct AssetManifest {
    pub format: Option<String>,
    pub asset_base: String,
    entries: Vec<AssetEntry>,
    index: BTreeMap<String, usize>,
}

impl AssetManifest {
    /// Parse an already-decoded manifest `Json`.
    pub fn from_json(root: &Json) -> Result<AssetManifest, AssetError> {
        if root.as_object().is_none() {
            return Err(AssetError::Malformed);
        }
        let format = root
            .get("format")
            .or_else(|| root.get("schema"))
            .and_then(Json::as_str)
            .map(|s| s.to_string());
        let asset_base = root
            .get("assetBase")
            .and_then(Json::as_str)
            .unwrap_or("")
            .to_string();

        let mut entries = Vec::new();
        match root.get("entries") {
            Some(Json::Obj(fields)) => {
                for (key, val) in fields {
                    entries.push(entry_from(key.clone(), val));
                }
            }
            Some(Json::Arr(items)) => {
                for item in items {
                    let key = item
                        .get("id")
                        .and_then(Json::as_str)
                        .ok_or(AssetError::MissingId)?
                        .to_string();
                    entries.push(entry_from(key, item));
                }
            }
            _ => return Err(AssetError::Malformed),
        }

        let mut index = BTreeMap::new();
        for (i, e) in entries.iter().enumerate() {
            index.insert(e.key.clone(), i);
        }
        Ok(AssetManifest {
            format,
            asset_base,
            entries,
            index,
        })
    }

    pub fn expect_format(&self, want: &str) -> Result<(), AssetError> {
        match self.format.as_deref() {
            Some(f) if f == want => Ok(()),
            _ => Err(AssetError::WrongSchema),
        }
    }

    /// Alias for manifests that use the `"schema"` discriminator convention.
    pub fn expect_schema(&self, want: &str) -> Result<(), AssetError> {
        self.expect_format(want)
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub fn get(&self, key: &str) -> Option<&AssetEntry> {
        self.index.get(key).map(|&i| &self.entries[i])
    }

    pub fn entries(&self) -> &[AssetEntry] {
        &self.entries
    }

    /// Resolve a stable asset key to its final public URL through `resolver`.
    /// Mirrors `props.ts`: an absolute `glb` is used directly; otherwise it is
    /// joined onto `assetBase`.
    pub fn resolve_url(&self, key: &str, resolver: &PublicPathResolver) -> Option<String> {
        let entry = self.get(key)?;
        let joined = if entry.glb.starts_with('/') {
            entry.glb.clone()
        } else {
            let mut s = self.asset_base.clone();
            s.push_str(&entry.glb);
            s
        };
        resolver.resolve(&joined)
    }
}

fn entry_from(key: String, val: &Json) -> AssetEntry {
    let glb = val
        .get("glb")
        .or_else(|| val.get("path"))
        .and_then(Json::as_str)
        .unwrap_or("")
        .to_string();
    let kind = val
        .get("kind")
        .and_then(Json::as_str)
        .map(|s| s.to_string());
    AssetEntry {
        key,
        glb,
        kind,
        extra: val.clone(),
    }
}

/// Read the `"schema"` discriminator of any decoded JSON, if present.
pub fn schema_of(root: &Json) -> Option<&str> {
    root.get("schema").and_then(Json::as_str)
}

/// Read the `"format"` discriminator of any decoded JSON, if present.
pub fn format_of(root: &Json) -> Option<&str> {
    root.get("format").and_then(Json::as_str)
}

/// Resolves manifest-relative public paths to servable URLs, porting the
/// fail-closed rules of `resolveRuntimePublicPath`. `base_dir` is the directory
/// the immutable client is served from (e.g. `/releases/<id>/`); empty or `/`
/// means root-relative (headless / native).
#[derive(Clone, Debug, Default)]
pub struct PublicPathResolver {
    pub base_dir: String,
}

impl PublicPathResolver {
    pub fn new(base_dir: impl Into<String>) -> Self {
        Self {
            base_dir: base_dir.into(),
        }
    }

    /// Root-relative resolver (native / headless).
    pub fn root() -> Self {
        Self {
            base_dir: String::new(),
        }
    }

    /// Returns the servable path, or `None` if the input is unsafe: a
    /// protocol-relative `//…`, an absolute-scheme `foo:…`, or any `..`
    /// traversal. Relative inputs are returned unchanged; absolute `/…` inputs
    /// are prefixed with `base_dir` unless already under it.
    pub fn resolve(&self, path: &str) -> Option<String> {
        if path.starts_with("//") || has_scheme(path) {
            return None;
        }
        if path.contains("..") {
            return None;
        }
        if !path.starts_with('/') {
            return Some(path.to_string());
        }
        let base = self.base_dir.trim_end_matches('/');
        if base.is_empty() || path.starts_with(base) {
            return Some(path.to_string());
        }
        let mut s = String::from(base);
        s.push_str(path);
        Some(s)
    }
}

/// True if `s` begins with a URL scheme (`[a-z][a-z0-9+.-]*:`) before any `/`.
fn has_scheme(s: &str) -> bool {
    let b = s.as_bytes();
    if b.is_empty() || !b[0].is_ascii_alphabetic() {
        return false;
    }
    for &c in &b[1..] {
        if c == b':' {
            return true;
        }
        if !(c.is_ascii_alphanumeric() || c == b'+' || c == b'-' || c == b'.') {
            return false;
        }
    }
    false
}

#[cfg(all(test, feature = "std"))]
mod tests {
    use super::*;

    #[test]
    fn object_keyed_manifest() {
        let j = Json::parse(
            r#"{ "format": "successor/props-mapping/1", "assetBase": "/assets/world-items/",
                "entries": { "road_barrier": { "glb": "barricade_concrete.glb" },
                             "chest": { "glb": "supply_cache.glb", "interactable": true } } }"#,
        )
        .unwrap();
        let m = AssetManifest::from_json(&j).unwrap();
        assert!(m.expect_format("successor/props-mapping/1").is_ok());
        assert_eq!(m.len(), 2);
        let e = m.get("chest").unwrap();
        assert_eq!(e.glb, "supply_cache.glb");
        assert_eq!(
            e.extra.get("interactable").and_then(Json::as_bool),
            Some(true)
        );
        assert_eq!(
            m.resolve_url("road_barrier", &PublicPathResolver::root())
                .as_deref(),
            Some("/assets/world-items/barricade_concrete.glb")
        );
    }

    #[test]
    fn array_with_id_manifest() {
        let j = Json::parse(
            r#"{ "format": "successor/trial-props/1", "assetBase": "/assets/wave-props/",
                "entries": [ { "id": "ammo_001", "glb": "a/ammo_001.glb", "kind": "ammo" } ] }"#,
        )
        .unwrap();
        let m = AssetManifest::from_json(&j).unwrap();
        let e = m.get("ammo_001").unwrap();
        assert_eq!(e.kind.as_deref(), Some("ammo"));
        assert_eq!(
            m.resolve_url("ammo_001", &PublicPathResolver::root())
                .as_deref(),
            Some("/assets/wave-props/a/ammo_001.glb")
        );
    }

    #[test]
    fn absolute_glb_bypasses_asset_base() {
        let j = Json::parse(
            r#"{ "assetBase": "/assets/world-items/",
                "entries": { "k": { "glb": "/assets/wave-props/x.glb" } } }"#,
        )
        .unwrap();
        let m = AssetManifest::from_json(&j).unwrap();
        assert_eq!(
            m.resolve_url("k", &PublicPathResolver::root()).as_deref(),
            Some("/assets/wave-props/x.glb")
        );
    }

    #[test]
    fn release_dir_prefixing() {
        let r = PublicPathResolver::new("/releases/abc/");
        assert_eq!(
            r.resolve("/assets/x.glb").as_deref(),
            Some("/releases/abc/assets/x.glb")
        );
        assert_eq!(
            r.resolve("/releases/abc/assets/x.glb").as_deref(),
            Some("/releases/abc/assets/x.glb")
        );
    }

    #[test]
    fn resolver_fails_closed() {
        let r = PublicPathResolver::root();
        assert_eq!(r.resolve("//evil.example/x"), None);
        assert_eq!(r.resolve("https://evil/x"), None);
        assert_eq!(r.resolve("/a/../../etc/passwd"), None);
        assert_eq!(
            r.resolve("relative/x.glb").as_deref(),
            Some("relative/x.glb")
        );
    }
}

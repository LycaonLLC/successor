//! Pawn asset catalog: body routing (player/NPC humanoids, special
//! humanoids, creatures), the loaded template registry, worn-equipment
//! resolution, and weapon rig models — the Rust port of the asset side of
//! `client-3d/src/render/pawns.ts` (`pawnBodyForActor`,
//! `specialPawnBodyKeyForActor`, `CREATURE_SPECIES_BY_SPRITE`,
//! `defaultRemotePawnEquipmentIds`) over the platform asset reader.
//!
//! Degradation contract: `pawn_male` / `pawn_female` are REQUIRED — a missing
//! body fails catalog construction (world entry stops at Fatal upstream).
//! Special bodies, creatures, equipment pieces, and weapon rigs are optional:
//! a miss records a typed [`PawnAssetIssue`] exactly once and the actor stays
//! visible on its explicit fallback (base body / no attachment).

use std::collections::HashMap;

use successor_engine_core::math::Mat4;
use successor_engine_render::components::{MaterialId, MeshId};
use successor_engine_render::gpu::Gpu;
use successor_engine_render::renderer::Renderer;

use super::creatures::{species_for_sprite, CreatureSpecies};
use super::pack::{upload_static_parts, PawnTemplate};
use crate::world::area::fnv1a32;
use crate::world::ADULT_PAWN_HEIGHT_METERS;

/// Byte provider over stable asset ids (`Platform::read_asset` adapter).
pub type AssetRead<'a> = dyn FnMut(&str) -> Option<Vec<u8>> + 'a;

pub const MALE_BODY_ID: &str = "assets/pawn-pack/pawn_male.glb";
pub const FEMALE_BODY_ID: &str = "assets/pawn-pack/pawn_female.glb";

/// Exact actor sprite → authored special-humanoid body (NPC-only bodies).
const SPECIAL_HUMANOID_BODY_BY_SPRITE: [(&str, &str); 1] =
    [("droid-grok-humanoid", "droid_grok_humanoid")];

/// How an actor's visible body is sourced.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum BodyRoute {
    Human { female: bool },
    Special { body_key: &'static str },
    Creature { species: CreatureSpecies },
}

/// `pawnBodyForActor` / `specialPawnBodyKeyForActor` / creature routing, in
/// the reference precedence: creature sprite → special sprite → sprite
/// male/female → id-hash male/female (¼ female).
pub fn route_for(sprite: Option<&str>, actor_id: &str) -> BodyRoute {
    if let Some(sprite) = sprite.filter(|s| !s.is_empty()) {
        if let Some(species) = species_for_sprite(sprite) {
            return BodyRoute::Creature { species };
        }
        for (key, body) in SPECIAL_HUMANOID_BODY_BY_SPRITE {
            if key == sprite {
                return BodyRoute::Special { body_key: body };
            }
        }
        return BodyRoute::Human {
            female: sprite.contains("female"),
        };
    }
    BodyRoute::Human {
        female: fnv1a32(actor_id).is_multiple_of(4),
    }
}

/// Weapon rig model families (socket-welded rigid meshes).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum WeaponRigKind {
    Slugthrower,
    Vibrosword,
    PlasmaHilt,
}

impl WeaponRigKind {
    pub fn stable_id(self) -> &'static str {
        match self {
            WeaponRigKind::Slugthrower => "assets/pawn-pack/slugthrower.glb",
            WeaponRigKind::Vibrosword => "assets/pawn-pack/vibrosword.glb",
            WeaponRigKind::PlasmaHilt => "assets/pawn-pack/plasma_hilt.glb",
        }
    }
}

/// Equipped weapon id → rig family (None → nothing socketed).
pub fn rig_for_weapon_id(weapon_id: Option<&str>) -> Option<WeaponRigKind> {
    let id = weapon_id?.to_ascii_lowercase();
    if id.contains("plasma") {
        Some(WeaponRigKind::PlasmaHilt)
    } else if id.contains("sword") || id.contains("vibro") || id.contains("blade") {
        Some(WeaponRigKind::Vibrosword)
    } else if id.contains("slug") || id.contains("rifle") || id.contains("gun") {
        Some(WeaponRigKind::Slugthrower)
    } else {
        None
    }
}

/// Typed optional-asset degradation. Each variant identifies the exact stable
/// id (or item id) that failed so the probe/bug-report path can name it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PawnAssetIssue {
    MissingSpecialBody { stable_id: String },
    MissingCreature { stable_id: String },
    MissingWeaponRig { stable_id: &'static str },
    MissingEquipment { item_id: String },
    IncompatibleEquipmentRig { item_id: String },
    MissingEquipmentManifest,
}

/// A loaded, GPU-resident body: template + canonical scale + uploaded parts.
pub struct BodyAssets {
    pub template: PawnTemplate,
    pub scale: f32,
    pub part_meshes: Vec<(MeshId, MaterialId)>,
}

fn load_body<G: Gpu>(
    gpu: &mut G,
    renderer: &mut Renderer,
    bytes: &[u8],
    target_height: Option<f32>,
) -> Option<BodyAssets> {
    let template = PawnTemplate::from_bytes(bytes).ok()?;
    let scale = match target_height {
        Some(h) => template.uniform_scale_for_height(h)?,
        None => 1.0,
    };
    let gpu_parts = template.upload(gpu, renderer);
    Some(BodyAssets {
        template,
        scale,
        part_meshes: gpu_parts.parts,
    })
}

/// A rigid weapon rig model: uploaded static parts + their node-local mats.
pub struct RigModel {
    pub parts: Vec<(MeshId, MaterialId, Mat4)>,
}

/// One baked worn-equipment piece: skinned parts sharing the body palette.
pub struct EquipmentPiece {
    pub part_meshes: Vec<(MeshId, MaterialId)>,
    /// Joint count of the piece's own rig — must match the body skeleton.
    pub joint_count: usize,
}

pub struct PawnCatalog {
    male: BodyAssets,
    female: BodyAssets,
    special: HashMap<&'static str, Option<BodyAssets>>,
    creatures: HashMap<&'static str, Option<BodyAssets>>,
    weapons: HashMap<WeaponRigKind, Option<RigModel>>,
    /// item id → glb path (relative to the equipment dir), from the manifest.
    equipment_paths: HashMap<String, String>,
    equipment: HashMap<String, Option<EquipmentPiece>>,
    issues: Vec<PawnAssetIssue>,
}

const MAX_ISSUES: usize = 64;

impl PawnCatalog {
    /// Load the required bodies + optional equipment manifest. A missing or
    /// unparseable required body is a hard error (world entry must stop).
    pub fn load<G: Gpu>(
        gpu: &mut G,
        renderer: &mut Renderer,
        read: &mut AssetRead<'_>,
    ) -> Result<Self, String> {
        let male_bytes = read(MALE_BODY_ID)
            .ok_or_else(|| format!("required body asset missing: {MALE_BODY_ID}"))?;
        let male = load_body(gpu, renderer, &male_bytes, Some(ADULT_PAWN_HEIGHT_METERS))
            .ok_or_else(|| format!("required body asset invalid: {MALE_BODY_ID}"))?;
        let female_bytes = read(FEMALE_BODY_ID)
            .ok_or_else(|| format!("required body asset missing: {FEMALE_BODY_ID}"))?;
        let female = load_body(gpu, renderer, &female_bytes, Some(ADULT_PAWN_HEIGHT_METERS))
            .ok_or_else(|| format!("required body asset invalid: {FEMALE_BODY_ID}"))?;

        let mut equipment_paths = HashMap::new();
        let mut issues = Vec::new();
        match read("assets/pawn-pack/equipment/manifest.json")
            .and_then(|b| String::from_utf8(b).ok())
            .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        {
            Some(manifest) => {
                if let Some(items) = manifest.get("items").and_then(|i| i.as_array()) {
                    for item in items {
                        let (Some(id), Some(glb)) = (
                            item.get("id").and_then(|v| v.as_str()),
                            item.get("glb").and_then(|v| v.as_str()),
                        ) else {
                            continue;
                        };
                        equipment_paths.insert(id.to_ascii_lowercase(), glb.to_string());
                    }
                }
            }
            None => issues.push(PawnAssetIssue::MissingEquipmentManifest),
        }

        Ok(Self {
            male,
            female,
            special: HashMap::new(),
            creatures: HashMap::new(),
            weapons: HashMap::new(),
            equipment_paths,
            equipment: HashMap::new(),
            issues,
        })
    }

    /// Typed degradation log (bounded; each issue recorded once).
    pub fn issues(&self) -> &[PawnAssetIssue] {
        &self.issues
    }

    fn record(&mut self, issue: PawnAssetIssue) {
        if self.issues.len() < MAX_ISSUES && !self.issues.contains(&issue) {
            self.issues.push(issue);
        }
    }

    pub fn human(&self, female: bool) -> &BodyAssets {
        if female {
            &self.female
        } else {
            &self.male
        }
    }

    /// The body for a route; lazily loads special/creature templates. `None`
    /// means "typed fallback" — the caller renders the explicit missing-asset
    /// presentation (base human body for specials, marker for creatures).
    pub fn body_for<G: Gpu>(
        &mut self,
        gpu: &mut G,
        renderer: &mut Renderer,
        read: &mut AssetRead<'_>,
        route: BodyRoute,
    ) -> Option<&BodyAssets> {
        match route {
            BodyRoute::Human { female } => Some(self.human(female)),
            BodyRoute::Special { body_key } => {
                if !self.special.contains_key(body_key) {
                    let stable_id = format!("assets/pawn-pack/special/{body_key}.glb");
                    let loaded = read(&stable_id).and_then(|bytes| {
                        load_body(gpu, renderer, &bytes, Some(ADULT_PAWN_HEIGHT_METERS))
                    });
                    if loaded.is_none() {
                        self.record(PawnAssetIssue::MissingSpecialBody { stable_id });
                    }
                    self.special.insert(body_key, loaded);
                }
                self.special.get(body_key).and_then(|b| b.as_ref())
            }
            BodyRoute::Creature { species } => {
                let key = species.species_id;
                if !self.creatures.contains_key(key) {
                    // Creature GLBs are authored at world scale; per-species
                    // mesh_scale applies on top (no height normalization).
                    let stable_id = species.asset_path.trim_start_matches('/').to_string();
                    let loaded = read(&stable_id).and_then(|bytes| {
                        load_body(gpu, renderer, &bytes, None).map(|mut b| {
                            b.scale = species.mesh_scale;
                            b
                        })
                    });
                    if loaded.is_none() {
                        self.record(PawnAssetIssue::MissingCreature { stable_id });
                    }
                    self.creatures.insert(key, loaded);
                }
                self.creatures.get(key).and_then(|b| b.as_ref())
            }
        }
    }

    /// Mutable access to an already-loaded body (animation sampling needs
    /// `&mut PawnTemplate`). Never loads: `None` means the route was not
    /// resolved by a prior [`Self::body_for`] call (caller falls back).
    pub fn body_mut(&mut self, route: BodyRoute) -> Option<&mut BodyAssets> {
        match route {
            BodyRoute::Human { female } => Some(if female {
                &mut self.female
            } else {
                &mut self.male
            }),
            BodyRoute::Special { body_key } => {
                self.special.get_mut(body_key).and_then(|b| b.as_mut())
            }
            BodyRoute::Creature { species } => self
                .creatures
                .get_mut(species.species_id)
                .and_then(|b| b.as_mut()),
        }
    }

    /// The rigid weapon rig for a family; lazily loaded, typed miss.
    pub fn weapon_rig<G: Gpu>(
        &mut self,
        gpu: &mut G,
        renderer: &mut Renderer,
        read: &mut AssetRead<'_>,
        kind: WeaponRigKind,
    ) -> Option<&RigModel> {
        if !self.weapons.contains_key(&kind) {
            let loaded = read(kind.stable_id())
                .and_then(|bytes| upload_static_parts(gpu, renderer, &bytes).ok())
                .map(|parts| RigModel { parts });
            if loaded.is_none() {
                self.record(PawnAssetIssue::MissingWeaponRig {
                    stable_id: kind.stable_id(),
                });
            }
            self.weapons.insert(kind, loaded);
        }
        self.weapons.get(&kind).and_then(|r| r.as_ref())
    }

    /// A worn/hair equipment piece by manifest item id (case-insensitive).
    /// Pieces whose rig disagrees with the body skeleton are rejected with a
    /// typed issue instead of binding to the wrong palette.
    pub fn equipment_piece<G: Gpu>(
        &mut self,
        gpu: &mut G,
        renderer: &mut Renderer,
        read: &mut AssetRead<'_>,
        item_id: &str,
        body_joints: usize,
    ) -> Option<&EquipmentPiece> {
        let key = item_id.to_ascii_lowercase();
        if !self.equipment.contains_key(&key) {
            let loaded = self
                .equipment_paths
                .get(&key)
                .cloned()
                .and_then(|glb| read(&format!("assets/pawn-pack/equipment/{glb}")))
                .and_then(|bytes| PawnTemplate::from_bytes(&bytes).ok())
                .map(|template| {
                    let joint_count = template.joint_count();
                    let gpu_parts = template.upload(gpu, renderer);
                    EquipmentPiece {
                        part_meshes: gpu_parts.parts,
                        joint_count,
                    }
                });
            match &loaded {
                None => self.record(PawnAssetIssue::MissingEquipment {
                    item_id: key.clone(),
                }),
                Some(piece) if piece.joint_count != body_joints => {
                    self.record(PawnAssetIssue::IncompatibleEquipmentRig {
                        item_id: key.clone(),
                    });
                    self.equipment.insert(key, None);
                    return None;
                }
                Some(_) => {}
            }
            self.equipment.insert(key.clone(), loaded);
        }
        match self.equipment.get(&key) {
            Some(Some(piece)) if piece.joint_count == body_joints => Some(piece),
            _ => None,
        }
    }

    /// Whether the manifest knows an item id (without loading it).
    pub fn knows_equipment(&self, item_id: &str) -> bool {
        self.equipment_paths
            .contains_key(&item_id.to_ascii_lowercase())
    }

    /// The default NPC outfit (port of `defaultRemotePawnEquipmentIds`):
    /// underclothes + harness set, plus a deterministic head piece when the
    /// server didn't author hair. `out` is reused by the caller.
    pub fn default_outfit(
        &self,
        actor_id: &str,
        role: Option<&str>,
        hair: Option<&str>,
        out: &mut Vec<&'static str>,
    ) {
        out.clear();
        const BASE: [&str; 8] = [
            "under_tank",
            "under_shorts",
            "armor_harness",
            "armor_nape_reinforcement",
            "armor_reinforcement",
            "armor_gorget",
            "armor_bicep_l",
            "armor_bicep_r",
        ];
        for id in BASE {
            if self.knows_equipment(id) {
                out.push(id);
            }
        }
        if hair.is_none() {
            // Deterministic helmet/hat pick per actor id; players prefer S3.
            const HEADS: [&str; 5] = ["helmet_s3", "helmet_a", "helmet_b", "helmet_c", "hat_warm"];
            let preferred = if role == Some("player") {
                0
            } else {
                (fnv1a32(actor_id) % HEADS.len() as u32) as usize
            };
            if self.knows_equipment(HEADS[preferred]) {
                out.push(HEADS[preferred]);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn creature_sprites_route_to_species() {
        let r = route_for(Some("creature-bellback-adult"), "npc:1");
        assert!(matches!(r, BodyRoute::Creature { species } if species.species_id == "bellback"));
    }

    #[test]
    fn special_sprite_routes_to_authored_body() {
        assert_eq!(
            route_for(Some("droid-grok-humanoid"), "npc:2"),
            BodyRoute::Special {
                body_key: "droid_grok_humanoid"
            }
        );
    }

    #[test]
    fn sprite_gender_and_hash_fallback() {
        assert_eq!(
            route_for(Some("wanderer-female"), "x"),
            BodyRoute::Human { female: true }
        );
        assert_eq!(
            route_for(Some("wanderer"), "x"),
            BodyRoute::Human { female: false }
        );
        // No sprite → deterministic ¼-ish female split by id hash.
        let ids = ["1:1", "1:2", "1:3", "1:4", "1:5", "1:6", "1:7", "1:8"];
        let females = ids
            .iter()
            .filter(|id| matches!(route_for(None, id), BodyRoute::Human { female: true }))
            .count();
        assert!(females < ids.len(), "hash split, not constant female");
        assert_eq!(route_for(None, "1:1"), route_for(None, "1:1"));
    }

    #[test]
    fn weapon_rig_routing() {
        assert_eq!(
            rig_for_weapon_id(Some("slugthrower")),
            Some(WeaponRigKind::Slugthrower)
        );
        assert_eq!(
            rig_for_weapon_id(Some("scrap_rifle")),
            Some(WeaponRigKind::Slugthrower)
        );
        assert_eq!(
            rig_for_weapon_id(Some("vibrosword")),
            Some(WeaponRigKind::Vibrosword)
        );
        assert_eq!(
            rig_for_weapon_id(Some("plasma_blade")),
            Some(WeaponRigKind::PlasmaHilt)
        );
        assert_eq!(rig_for_weapon_id(Some("bandage")), None);
        assert_eq!(rig_for_weapon_id(None), None);
    }
}

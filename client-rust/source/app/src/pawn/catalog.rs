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

use serde::Deserialize;
use successor_engine_core::math::{vec3, Mat4, Quat};
use successor_engine_render::components::{MaterialId, MeshId};
use successor_engine_render::gpu::Gpu;
use successor_engine_render::primitives;
use successor_engine_render::renderer::{MaterialDesc, Renderer};

use super::creatures::{species_for_sprite, CreatureSpecies};
use super::pack::{upload_static_parts, PawnTemplate};
use crate::world::area::fnv1a32;
use crate::world::ADULT_PAWN_HEIGHT_METERS;

/// Byte provider over stable asset ids (`Platform::read_asset` adapter).
pub type AssetRead<'a> = dyn FnMut(&str) -> Option<Vec<u8>> + 'a;

pub const MALE_BODY_ID: &str = "assets/pawn-pack/pawn_male.glb";
pub const FEMALE_BODY_ID: &str = "assets/pawn-pack/pawn_female.glb";

/// Canonical segmented-skin vocabulary shared by the authored pack and both
/// runtime renderers. Material names are exactly `BodyZone_<zone>`.
pub const BODY_ZONE_NAMES: [&str; 16] = [
    "torso",
    "pelvis",
    "neck",
    "head",
    "left_upper_arm",
    "right_upper_arm",
    "left_forearm",
    "right_forearm",
    "left_hand",
    "right_hand",
    "left_thigh",
    "right_thigh",
    "left_calf",
    "right_calf",
    "left_foot",
    "right_foot",
];

/// Compact union of the canonical body zones. It is parsed once per manifest
/// item and combined when a pawn is spawned or respawned.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct BodyZoneMask(u16);

impl BodyZoneMask {
    fn bit_for_zone(name: &str) -> Option<u16> {
        Some(match name {
            "torso" => 1 << 0,
            "pelvis" => 1 << 1,
            "neck" => 1 << 2,
            "head" => 1 << 3,
            "left_upper_arm" => 1 << 4,
            "right_upper_arm" => 1 << 5,
            "left_forearm" => 1 << 6,
            "right_forearm" => 1 << 7,
            "left_hand" => 1 << 8,
            "right_hand" => 1 << 9,
            "left_thigh" => 1 << 10,
            "right_thigh" => 1 << 11,
            "left_calf" => 1 << 12,
            "right_calf" => 1 << 13,
            "left_foot" => 1 << 14,
            "right_foot" => 1 << 15,
            _ => return None,
        })
    }

    fn insert_named(&mut self, name: &str) -> bool {
        let Some(bit) = Self::bit_for_zone(name) else {
            return false;
        };
        self.0 |= bit;
        true
    }

    fn union(self, other: Self) -> Self {
        Self(self.0 | other.0)
    }

    /// Returns true only for an exact, canonical segmented body material.
    pub fn hides_material_name(self, material_name: Option<&str>) -> bool {
        let Some(zone) = material_name.and_then(|name| name.strip_prefix("BodyZone_")) else {
            return false;
        };
        let Some(bit) = Self::bit_for_zone(zone) else {
            return false;
        };
        self.0 & bit != 0
    }
}

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

    pub fn attach_stable_id(self) -> &'static str {
        match self {
            WeaponRigKind::Slugthrower => "assets/pawn-pack/slugthrower_attach.json",
            WeaponRigKind::Vibrosword | WeaponRigKind::PlasmaHilt => {
                "assets/pawn-pack/vibrosword_attach.json"
            }
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
    MissingWeaponRig { stable_id: String },
    MissingEquipment { item_id: String },
    IncompatibleEquipmentRig { item_id: String },
    UnknownEquipmentHideBodyZone { item_id: String, zone: String },
    InvalidEquipmentHideBodyZones { item_id: String },
    MissingEquipmentManifest,
    MissingWeaponManifest,
}

/// A loaded, GPU-resident body: template + canonical scale + uploaded parts.
pub struct BodyAssets {
    pub template: PawnTemplate,
    pub scale: f32,
    pub part_meshes: Vec<(MeshId, MaterialId)>,
    pub part_material_names: Vec<Option<String>>,
}

/// Material name of the authored face panel drawn over the head.
const FACE_PANEL_MATERIAL: &str = "RB_Face";

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
    let mut part_meshes = gpu_parts.parts;
    key_face_panel_material(
        gpu,
        renderer,
        bytes,
        &gpu_parts.material_names,
        &mut part_meshes,
    );
    Some(BodyAssets {
        template,
        scale,
        part_meshes,
        part_material_names: gpu_parts.material_names,
    })
}

/// Replace the face panel's opaque texture with one whose baked skin canvas is
/// keyed to transparency, so the head's tinted skin shows through and only the
/// painted features remain. A body without the panel is left untouched.
fn key_face_panel_material<G: Gpu>(
    gpu: &mut G,
    renderer: &mut Renderer,
    bytes: &[u8],
    material_names: &[Option<String>],
    parts: &mut [(MeshId, MaterialId)],
) {
    let Some(index) = material_names
        .iter()
        .position(|name| name.as_deref() == Some(FACE_PANEL_MATERIAL))
    else {
        return;
    };
    let Some((_, material)) = parts.get(index).copied() else {
        return;
    };
    let Some(mut desc) = renderer.material_desc(material) else {
        return;
    };
    let Ok(doc) = successor_engine_core::glb::parse(bytes) else {
        return;
    };
    // The panel carries exactly one image: its painted face canvas.
    let Some(image) = doc.images.first() else {
        return;
    };
    let Ok(decoded) = successor_engine_core::image::decode_png(&image.bytes) else {
        return;
    };
    let keyed = crate::pawn::face::key_face_panel(&decoded);
    let texture = gpu.create_texture(
        &successor_engine_render::gpu::TextureDesc {
            width: keyed.width,
            height: keyed.height,
            format: successor_engine_render::gpu::TextureFormat::Srgba8,
            mag_filter: successor_engine_render::gpu::Filter::Linear,
            min_filter: successor_engine_render::gpu::MinFilter::LinearMipmapLinear,
            wrap_s: successor_engine_render::gpu::Wrap::ClampToEdge,
            wrap_t: successor_engine_render::gpu::Wrap::ClampToEdge,
            mipmaps: true,
        },
        Some(&keyed.pixels),
    );
    desc.base_color_texture = Some(texture);
    desc.blend = true;
    parts[index].1 = renderer.add_material_desc(desc);
}

/// A rigid weapon rig model: uploaded static parts + their node-local mats.
pub struct RigModel {
    pub parts: Vec<(MeshId, MaterialId, Mat4)>,
    pub mount: Mat4,
    pub foregrip: successor_engine_core::math::Vec3,
    pub grip: successor_engine_core::math::Vec3,
    pub muzzle: successor_engine_core::math::Vec3,
    pub foregrip_contact: successor_engine_core::math::Vec3,
    pub resting_yaw_rad: f32,
    pub support_arm: Option<SupportArmPosture>,
    pub melee: bool,
    pub support_hand: bool,
    pub plasma_blade_part: Option<usize>,
    pub stow: Option<WeaponStow>,
}

#[derive(Deserialize)]
struct WeaponAttachSpec {
    #[serde(default)]
    item_id: Option<i64>,
    #[serde(default)]
    scale_to_pawn: Option<f32>,
    #[serde(default)]
    attach: Option<String>,
    mount_hand_r_local: WeaponMountSpec,
    sockets: WeaponSocketSpec,
    #[serde(default)]
    hold: Option<WeaponHoldSpec>,
    #[serde(default)]
    stow_socket: Option<WeaponStowSpec>,
}

#[derive(Deserialize)]
struct WeaponMountSpec {
    pos: [f32; 3],
    quat: [f32; 4],
}

#[derive(Deserialize)]
struct WeaponSocketSpec {
    grip: [f32; 3],
    foregrip: [f32; 3],
    muzzle: [f32; 3],
    #[serde(default)]
    foregrip_contact: Option<[f32; 3]>,
}

#[derive(Deserialize)]
struct WeaponHoldSpec {
    #[serde(default)]
    resting_yaw_deg: Option<f32>,
    #[serde(default)]
    support_arm: Option<WeaponSupportArmSpec>,
}

#[derive(Deserialize)]
struct WeaponSupportArmSpec {
    #[serde(default)]
    min_elbow_bend_deg: Option<f32>,
    #[serde(default)]
    shoulder_advance_max_m: Option<f32>,
    #[serde(default)]
    elbow_pole_deg: Option<f32>,
}

/// Per-model support-arm hold posture. Mirror of `SupportArmSpec` in
/// `client-3d/src/assets/pawnRigTypes.ts`; both runtimes read the same
/// `hold.support_arm` block out of the weapon's attach json, so a model
/// authored once poses identically in the browser and in native.
#[derive(Clone, Copy)]
pub struct SupportArmPosture {
    pub min_bend_rad: f32,
    /// Metres the clavicle may swing the shoulder toward an out-of-reach target.
    pub shoulder_advance_max_m: f32,
    /// Elbow roll about the shoulder->wrist axis, radians from world-down.
    pub pole_rad: f32,
}

/// Anatomical rails, identical to the browser parser's.
const MAX_SUPPORT_BEND_DEG: f32 = 80.0;
const MAX_SHOULDER_ADVANCE_M: f32 = 0.12;

#[derive(Deserialize)]
struct WeaponStowSpec {
    space: String,
    pos: [f32; 3],
    rot_deg: [f32; 3],
    #[serde(default)]
    arc_lift: Option<f32>,
}

#[derive(Clone)]
pub struct WeaponStow {
    pub bone: String,
    pub mount: Mat4,
    pub arc_lift: f32,
}

#[derive(Clone)]
pub(super) struct WeaponHandSpec {
    pub mount: Mat4,
    pub foregrip: successor_engine_core::math::Vec3,
    pub grip: successor_engine_core::math::Vec3,
    pub muzzle: successor_engine_core::math::Vec3,
    pub foregrip_contact: successor_engine_core::math::Vec3,
    pub resting_yaw_rad: f32,
    pub support_arm: Option<SupportArmPosture>,
    pub stow: Option<WeaponStow>,
    pub scale_to_pawn: Option<f32>,
    pub two_handed: bool,
}

pub(super) fn parse_weapon_hand_spec(bytes: &[u8]) -> Option<WeaponHandSpec> {
    let spec = serde_json::from_slice::<WeaponAttachSpec>(bytes).ok()?;
    let pos = spec.mount_hand_r_local.pos;
    let quat = spec.mount_hand_r_local.quat;
    let grip = spec.sockets.grip;
    let foregrip = spec.sockets.foregrip;
    let muzzle = spec.sockets.muzzle;
    let foregrip_contact = spec
        .sockets
        .foregrip_contact
        .unwrap_or([0.0, -0.02, -0.055]);
    let resting_yaw_rad = spec
        .hold
        .as_ref()
        .and_then(|hold| hold.resting_yaw_deg)
        .map(f32::to_radians)
        .unwrap_or(0.1);
    let support_arm = spec
        .hold
        .as_ref()
        .and_then(|hold| hold.support_arm.as_ref())
        .and_then(|arm| {
            // Both a bend floor and a pole angle or nothing: rolling an elbow
            // with no bend holding it would spin a straight arm about itself.
            let bend_deg = arm.min_elbow_bend_deg?;
            let pole_deg = arm.elbow_pole_deg?;
            Some(SupportArmPosture {
                min_bend_rad: bend_deg.clamp(0.0, MAX_SUPPORT_BEND_DEG).to_radians(),
                shoulder_advance_max_m: arm
                    .shoulder_advance_max_m
                    .unwrap_or(0.0)
                    .clamp(0.0, MAX_SHOULDER_ADVANCE_M),
                pole_rad: pole_deg.to_radians(),
            })
        });
    let scale_to_pawn = spec.scale_to_pawn;
    let two_handed = spec.attach.as_deref() == Some("two_hand");
    let stow = spec.stow_socket.map(|stow| {
        let radians = stow.rot_deg.map(f32::to_radians);
        let rotation = Quat::from_axis_angle(vec3(1.0, 0.0, 0.0), radians[0])
            .mul(Quat::from_axis_angle(
                successor_engine_core::math::Vec3::Y,
                radians[1],
            ))
            .mul(Quat::from_axis_angle(vec3(0.0, 0.0, 1.0), radians[2]))
            .normalize();
        WeaponStow {
            bone: stow.space.trim_end_matches("_local").to_string(),
            mount: Mat4::from_trs(
                vec3(stow.pos[0], stow.pos[1], stow.pos[2]),
                rotation,
                vec3(1.0, 1.0, 1.0),
            ),
            arc_lift: stow.arc_lift.unwrap_or(0.14),
        }
    });
    Some(WeaponHandSpec {
        mount: Mat4::from_trs(
            vec3(pos[0], pos[1], pos[2]),
            Quat {
                x: quat[0],
                y: quat[1],
                z: quat[2],
                w: quat[3],
            }
            .normalize(),
            vec3(1.0, 1.0, 1.0),
        ),
        foregrip: vec3(foregrip[0], foregrip[1], foregrip[2]),
        grip: vec3(grip[0], grip[1], grip[2]),
        muzzle: vec3(muzzle[0], muzzle[1], muzzle[2]),
        foregrip_contact: vec3(
            foregrip_contact[0],
            foregrip_contact[1],
            foregrip_contact[2],
        ),
        resting_yaw_rad,
        support_arm,
        stow,
        scale_to_pawn,
        two_handed,
    })
}

fn append_plasma_blade<G: Gpu>(
    gpu: &mut G,
    renderer: &mut Renderer,
    parts: &mut Vec<(MeshId, MaterialId, Mat4)>,
) -> usize {
    let (vertices, indices) = primitives::capsule(0.014, 0.75, 10, 4);
    let mesh = renderer.upload_mesh(gpu, &vertices, &indices);
    let material = renderer.add_material_desc(MaterialDesc {
        base_color: [0.18, 0.9, 1.0, 1.0],
        metallic: 0.0,
        roughness: 0.22,
        emissive_factor: [0.39, 0.94, 1.0],
        emissive_strength: 7.5,
        ..MaterialDesc::default()
    });
    let local = Mat4::from_trs(
        vec3(0.0, 0.0, 0.465),
        Quat::from_axis_angle(vec3(1.0, 0.0, 0.0), core::f32::consts::FRAC_PI_2),
        vec3(1.0, 1.0, 1.0),
    );
    let index = parts.len();
    parts.push((mesh, material, local));
    index
}

/// One baked worn-equipment piece: skinned parts sharing the body palette.
pub struct EquipmentPiece {
    pub part_meshes: Vec<(MeshId, MaterialId)>,
    pub part_material_names: Vec<Option<String>>,
    /// Joint count of the piece's own rig — must match the body skeleton.
    pub joint_count: usize,
}

#[derive(Clone)]
struct EquipmentPaletteZone {
    slots: Vec<String>,
    default: [f32; 4],
}

#[derive(Clone)]
struct EquipmentPaths {
    default: String,
    female: Option<String>,
    material: Option<String>,
    palette_zones: Vec<EquipmentPaletteZone>,
    hide_body_zones: BodyZoneMask,
}

#[derive(Clone)]
struct WeaponPaths {
    glb: String,
    attach: String,
    melee: bool,
    scale: f32,
}

pub struct PawnCatalog {
    male: BodyAssets,
    female: BodyAssets,
    special: HashMap<&'static str, Option<BodyAssets>>,
    creatures: HashMap<&'static str, Option<BodyAssets>>,
    legacy_weapons: HashMap<WeaponRigKind, Option<RigModel>>,
    custom_weapon_paths: HashMap<String, WeaponPaths>,
    custom_weapon_by_item: HashMap<i64, String>,
    custom_weapons: HashMap<String, Option<RigModel>>,
    /// Item id → sex-specific GLB paths (relative to the equipment directory).
    equipment_paths: HashMap<String, EquipmentPaths>,
    /// Cached by item id, with a `female:` prefix only for authored variants.
    equipment: HashMap<String, Option<EquipmentPiece>>,
    /// Material-preset id → authored flat color from the wardrobe palette.
    material_colors: HashMap<String, [f32; 4]>,
    issues: Vec<PawnAssetIssue>,
}

const MAX_ISSUES: usize = 64;

fn record_issue(issues: &mut Vec<PawnAssetIssue>, issue: PawnAssetIssue) {
    if issues.len() < MAX_ISSUES && !issues.contains(&issue) {
        issues.push(issue);
    }
}

fn parse_hide_body_zones(
    item_id: &str,
    value: Option<&serde_json::Value>,
    issues: &mut Vec<PawnAssetIssue>,
) -> BodyZoneMask {
    let mut zones = BodyZoneMask::default();
    let Some(value) = value else {
        return zones;
    };
    let Some(entries) = value.as_array() else {
        record_issue(
            issues,
            PawnAssetIssue::InvalidEquipmentHideBodyZones {
                item_id: item_id.to_string(),
            },
        );
        return zones;
    };
    for entry in entries {
        let Some(zone) = entry.as_str() else {
            record_issue(
                issues,
                PawnAssetIssue::InvalidEquipmentHideBodyZones {
                    item_id: item_id.to_string(),
                },
            );
            continue;
        };
        if !zones.insert_named(zone) {
            record_issue(
                issues,
                PawnAssetIssue::UnknownEquipmentHideBodyZone {
                    item_id: item_id.to_string(),
                    zone: zone.to_string(),
                },
            );
        }
    }
    zones
}

fn parse_hex_color(value: &str) -> Option<[f32; 4]> {
    let hex = value.strip_prefix('#')?;
    if hex.len() != 6 || !hex.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return None;
    }
    Some([
        u8::from_str_radix(&hex[0..2], 16).ok()? as f32 / 255.0,
        u8::from_str_radix(&hex[2..4], 16).ok()? as f32 / 255.0,
        u8::from_str_radix(&hex[4..6], 16).ok()? as f32 / 255.0,
        1.0,
    ])
}

fn parse_equipment_palette(item: &serde_json::Value) -> Vec<EquipmentPaletteZone> {
    item.get("palette")
        .and_then(|value| value.get("zones"))
        .and_then(|value| value.as_array())
        .into_iter()
        .flatten()
        .filter_map(|zone| {
            let slots = zone
                .get("slots")?
                .as_array()?
                .iter()
                .filter_map(|slot| slot.as_str().map(str::to_string))
                .collect::<Vec<_>>();
            let default = parse_hex_color(zone.get("default")?.as_str()?)?;
            (!slots.is_empty()).then_some(EquipmentPaletteZone { slots, default })
        })
        .collect()
}

fn parse_material_colors(value: &serde_json::Value) -> HashMap<String, [f32; 4]> {
    let mut colors = HashMap::new();
    let Some(palettes) = value.get("palettes").and_then(|entry| entry.as_object()) else {
        return colors;
    };
    for palette in palettes.values() {
        let Some(swatches) = palette.get("swatches").and_then(|entry| entry.as_array()) else {
            continue;
        };
        for swatch in swatches {
            let Some((id, color)) = swatch.get("id").and_then(|entry| entry.as_str()).zip(
                swatch
                    .get("hex")
                    .and_then(|entry| entry.as_str())
                    .and_then(parse_hex_color),
            ) else {
                continue;
            };
            colors.insert(id.to_string(), color);
        }
    }
    colors
}

fn clean_material_name(name: &str) -> &str {
    let bytes = name.as_bytes();
    if bytes.len() >= 4
        && bytes[bytes.len() - 4] == b'.'
        && bytes[bytes.len() - 3..]
            .iter()
            .all(|byte| byte.is_ascii_digit())
    {
        &name[..name.len() - 4]
    } else {
        name
    }
}

fn atlas_slot_suffix(name: &str) -> Option<&str> {
    let clean = clean_material_name(name);
    let start = clean.rfind("_c")? + 1;
    let suffix = &clean[start..];
    (suffix.len() >= 2 && suffix[1..].bytes().all(|byte| byte.is_ascii_digit())).then_some(suffix)
}

fn palette_zone_color(
    paths: &EquipmentPaths,
    material_name: Option<&str>,
    worn_colors: &[String],
) -> Option<[f32; 4]> {
    let name = material_name?;
    let clean = clean_material_name(name);
    let suffix = atlas_slot_suffix(name);
    for (index, zone) in paths.palette_zones.iter().enumerate() {
        if !zone
            .slots
            .iter()
            .any(|slot| slot == clean || suffix.is_some_and(|suffix| slot == suffix))
        {
            continue;
        }
        return worn_colors
            .get(index)
            .and_then(|color| parse_hex_color(color))
            .or(Some(zone.default));
    }
    None
}

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
                        let item_key = id.to_ascii_lowercase();
                        let hide_body_zones = parse_hide_body_zones(
                            &item_key,
                            item.get("hideBodyZones"),
                            &mut issues,
                        );
                        equipment_paths.insert(
                            item_key,
                            EquipmentPaths {
                                default: glb.to_string(),
                                female: item
                                    .get("glbFemale")
                                    .and_then(|v| v.as_str())
                                    .map(str::to_string),
                                material: item
                                    .get("mat")
                                    .and_then(|value| value.as_str())
                                    .map(str::to_string),
                                palette_zones: parse_equipment_palette(item),
                                hide_body_zones,
                            },
                        );
                    }
                }
            }
            None => record_issue(&mut issues, PawnAssetIssue::MissingEquipmentManifest),
        }

        let material_colors = read("assets/pawn-pack/equipment/wardrobe_palette.json")
            .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
            .map(|value| parse_material_colors(&value))
            .unwrap_or_default();

        let mut custom_weapon_paths = HashMap::new();
        let mut custom_weapon_by_item = HashMap::new();
        match read("assets/pawn-pack/weapons/weapons_manifest.json")
            .and_then(|b| String::from_utf8(b).ok())
            .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        {
            Some(manifest) => {
                if let Some(items) = manifest.get("items").and_then(|i| i.as_array()) {
                    for item in items {
                        let (Some(id), Some(glb), Some(attach), Some(class)) = (
                            item.get("id").and_then(|v| v.as_str()),
                            item.get("glb").and_then(|v| v.as_str()),
                            item.get("attach").and_then(|v| v.as_str()),
                            item.get("class").and_then(|v| v.as_str()),
                        ) else {
                            continue;
                        };
                        let key = id.to_ascii_lowercase();
                        if let Some(item_ids) = item.get("item_ids").and_then(|v| v.as_array()) {
                            for item_id in item_ids.iter().filter_map(|v| v.as_i64()) {
                                custom_weapon_by_item.insert(item_id, key.clone());
                            }
                        }
                        if let Some(item_id) = read(&format!("assets/pawn-pack/weapons/{attach}"))
                            .and_then(|bytes| {
                                serde_json::from_slice::<WeaponAttachSpec>(&bytes)
                                    .ok()
                                    .and_then(|spec| spec.item_id)
                            })
                        {
                            custom_weapon_by_item.insert(item_id, key.clone());
                        }
                        custom_weapon_paths.insert(
                            key,
                            WeaponPaths {
                                glb: glb.to_string(),
                                attach: attach.to_string(),
                                melee: class.eq_ignore_ascii_case("melee"),
                                scale: item
                                    .get("scale")
                                    .and_then(|value| value.as_f64())
                                    .map(|value| value as f32)
                                    .unwrap_or(1.0),
                            },
                        );
                    }
                }
            }
            None => record_issue(&mut issues, PawnAssetIssue::MissingWeaponManifest),
        }

        Ok(Self {
            male,
            female,
            special: HashMap::new(),
            creatures: HashMap::new(),
            legacy_weapons: HashMap::new(),
            custom_weapon_paths,
            custom_weapon_by_item,
            custom_weapons: HashMap::new(),
            equipment_paths,
            equipment: HashMap::new(),
            material_colors,
            issues,
        })
    }

    /// Typed degradation log (bounded; each issue recorded once).
    pub fn issues(&self) -> &[PawnAssetIssue] {
        &self.issues
    }

    fn record(&mut self, issue: PawnAssetIssue) {
        record_issue(&mut self.issues, issue);
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
        if !self.legacy_weapons.contains_key(&kind) {
            let hand_spec =
                read(kind.attach_stable_id()).and_then(|bytes| parse_weapon_hand_spec(&bytes));
            let loaded = hand_spec.and_then(|hand_spec| {
                read(kind.stable_id())
                    .and_then(|bytes| upload_static_parts(gpu, renderer, &bytes).ok())
                    .map(|parts| RigModel {
                        parts,
                        mount: hand_spec.mount,
                        foregrip: hand_spec.foregrip,
                        grip: hand_spec.grip,
                        muzzle: hand_spec.muzzle,
                        foregrip_contact: hand_spec.foregrip_contact,
                        resting_yaw_rad: hand_spec.resting_yaw_rad,
                        support_arm: hand_spec.support_arm,
                        melee: !matches!(kind, WeaponRigKind::Slugthrower),
                        support_hand: hand_spec.two_handed,
                        stow: hand_spec.stow,
                        plasma_blade_part: None,
                    })
            });
            if loaded.is_none() {
                self.record(PawnAssetIssue::MissingWeaponRig {
                    stable_id: kind.stable_id().to_string(),
                });
            }
            self.legacy_weapons.insert(kind, loaded);
        }
        self.legacy_weapons.get(&kind).and_then(|r| r.as_ref())
    }

    /// Resolve an authority weapon snapshot to its exact presentation model.
    /// The backing item id wins; the normalized weapon id is the legacy
    /// fallback for snapshots that predate `weaponItemId`.
    pub fn weapon_rig_for<G: Gpu>(
        &mut self,
        gpu: &mut G,
        renderer: &mut Renderer,
        read: &mut AssetRead<'_>,
        weapon_id: Option<&str>,
        weapon_item_id: Option<i64>,
    ) -> Option<&RigModel> {
        let custom_key = weapon_item_id
            .and_then(|item_id| self.custom_weapon_by_item.get(&item_id).cloned())
            .or_else(|| {
                weapon_id
                    .map(|id| id.to_ascii_lowercase().replace('-', "_"))
                    .filter(|id| self.custom_weapon_paths.contains_key(id))
            });
        let Some(key) = custom_key else {
            if weapon_item_id == Some(3104) {
                return self.weapon_rig(gpu, renderer, read, WeaponRigKind::PlasmaHilt);
            }
            return rig_for_weapon_id(weapon_id)
                .and_then(|kind| self.weapon_rig(gpu, renderer, read, kind));
        };
        if !self.custom_weapons.contains_key(&key) {
            let paths = self.custom_weapon_paths.get(&key)?.clone();
            let hand_spec = read(&format!("assets/pawn-pack/weapons/{}", paths.attach))
                .and_then(|bytes| parse_weapon_hand_spec(&bytes));
            let loaded = hand_spec.and_then(|hand_spec| {
                let model_scale = hand_spec.scale_to_pawn.unwrap_or(paths.scale);
                read(&format!("assets/pawn-pack/weapons/{}", paths.glb))
                    .and_then(|bytes| upload_static_parts(gpu, renderer, &bytes).ok())
                    .map(|mut parts| {
                        if (model_scale - 1.0).abs() > f32::EPSILON {
                            let scale = Mat4::from_trs(
                                successor_engine_core::math::Vec3::ZERO,
                                Quat::IDENTITY,
                                vec3(model_scale, model_scale, model_scale),
                            );
                            for (_, _, local) in &mut parts {
                                *local = scale.mul(*local);
                            }
                        }
                        let plasma_blade_part = (key == "plasma_sword")
                            .then(|| append_plasma_blade(gpu, renderer, &mut parts));
                        RigModel {
                            parts,
                            mount: hand_spec.mount,
                            foregrip: hand_spec.foregrip.scale(model_scale),
                            grip: hand_spec.grip.scale(model_scale),
                            muzzle: hand_spec.muzzle.scale(model_scale),
                            foregrip_contact: hand_spec.foregrip_contact.scale(model_scale),
                            resting_yaw_rad: hand_spec.resting_yaw_rad,
                            support_arm: hand_spec.support_arm,
                            melee: paths.melee,
                            support_hand: hand_spec.two_handed,
                            stow: hand_spec.stow,
                            plasma_blade_part,
                        }
                    })
            });
            if loaded.is_none() {
                self.record(PawnAssetIssue::MissingWeaponRig {
                    stable_id: format!("assets/pawn-pack/weapons/{}", paths.glb),
                });
            }
            self.custom_weapons.insert(key.clone(), loaded);
        }
        self.custom_weapons.get(&key).and_then(|rig| rig.as_ref())
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
        female: bool,
    ) -> Option<&EquipmentPiece> {
        let item_key = item_id.to_ascii_lowercase();
        let paths = self.equipment_paths.get(&item_key)?;
        let use_female_variant = female && paths.female.is_some();
        let cache_key = if use_female_variant {
            format!("female:{item_key}")
        } else {
            item_key.clone()
        };
        if !self.equipment.contains_key(&cache_key) {
            let glb = if use_female_variant {
                paths
                    .female
                    .as_ref()
                    .expect("checked female equipment path")
            } else {
                &paths.default
            }
            .clone();
            let loaded = read(&format!("assets/pawn-pack/equipment/{glb}"))
                .and_then(|bytes| PawnTemplate::from_bytes(&bytes).ok())
                .map(|template| {
                    let joint_count = template.joint_count();
                    let gpu_parts = template.upload(gpu, renderer);
                    EquipmentPiece {
                        part_meshes: gpu_parts.parts,
                        part_material_names: gpu_parts.material_names,
                        joint_count,
                    }
                });
            match &loaded {
                None => self.record(PawnAssetIssue::MissingEquipment {
                    item_id: item_key.clone(),
                }),
                Some(piece) if piece.joint_count != body_joints => {
                    self.record(PawnAssetIssue::IncompatibleEquipmentRig { item_id: item_key });
                    self.equipment.insert(cache_key, None);
                    return None;
                }
                Some(_) => {}
            }
            self.equipment.insert(cache_key.clone(), loaded);
        }
        match self.equipment.get(&cache_key) {
            Some(Some(piece)) if piece.joint_count == body_joints => Some(piece),
            _ => None,
        }
    }

    /// Resolve an authored equipment material slot to its actor-specific color.
    /// Worn colors are index-aligned with manifest palette zones; hair uses the
    /// character's saved hair material, then the piece's manifest preset.
    pub fn equipment_part_color(
        &self,
        item_id: &str,
        material_name: Option<&str>,
        worn_colors: &[String],
        hair_material: Option<&str>,
    ) -> Option<[f32; 4]> {
        let item_key = item_id.to_ascii_lowercase();
        let paths = self.equipment_paths.get(&item_key)?;
        if item_key.starts_with("hair_") {
            return hair_material
                .or(paths.material.as_deref())
                .and_then(|material| self.material_colors.get(material).copied());
        }
        if let Some(color) = palette_zone_color(paths, material_name, worn_colors) {
            return Some(color);
        }
        paths
            .material
            .as_deref()
            .and_then(|material| self.material_colors.get(material).copied())
    }

    /// Whether the manifest knows an item id (without loading it).
    pub fn knows_equipment(&self, item_id: &str) -> bool {
        self.equipment_paths
            .contains_key(&item_id.to_ascii_lowercase())
    }

    /// Union the declared skin coverage for the exact resolved equipment ids.
    /// The manifest vocabulary is shared by male and female GLB variants; sex
    /// is selected only when their equipment mesh is loaded.
    pub fn hidden_body_zones<'a>(
        &self,
        item_ids: impl IntoIterator<Item = &'a str>,
    ) -> BodyZoneMask {
        let mut zones = BodyZoneMask::default();
        for item_id in item_ids {
            if let Some(paths) = self.equipment_paths.get(item_id) {
                zones = zones.union(paths.hide_body_zones);
                continue;
            }
            if item_id.bytes().any(|byte| byte.is_ascii_uppercase()) {
                let item_key = item_id.to_ascii_lowercase();
                if let Some(paths) = self.equipment_paths.get(&item_key) {
                    zones = zones.union(paths.hide_body_zones);
                }
            }
        }
        zones
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
    fn body_zone_masks_union_known_zones_and_ignore_unknowns() {
        let mut issues = Vec::new();
        let torso = parse_hide_body_zones(
            "cover_torso",
            Some(&serde_json::json!(["torso", "not_a_zone"])),
            &mut issues,
        );
        let pelvis = parse_hide_body_zones(
            "cover_pelvis",
            Some(&serde_json::json!(["pelvis"])),
            &mut issues,
        );
        let union = torso.union(pelvis);

        assert!(union.hides_material_name(Some("BodyZone_torso")));
        assert!(union.hides_material_name(Some("BodyZone_pelvis")));
        assert!(torso.hides_material_name(Some("BodyZone_torso")));
        assert!(!torso.hides_material_name(Some("BodyZone_pelvis")));
        assert!(!union.hides_material_name(Some("RB_Face")));
        assert!(!union.hides_material_name(Some("BodyZone_not_a_zone")));
        assert_eq!(
            issues,
            vec![PawnAssetIssue::UnknownEquipmentHideBodyZone {
                item_id: "cover_torso".to_string(),
                zone: "not_a_zone".to_string(),
            }]
        );
    }

    #[test]
    fn equipment_palette_matches_atlas_suffixes_and_full_material_names() {
        let paths = EquipmentPaths {
            default: "piece.glb".into(),
            female: None,
            material: None,
            palette_zones: parse_equipment_palette(&serde_json::json!({
                "palette": {
                    "zones": [
                        { "slots": ["c1"], "default": "#303030" },
                        { "slots": ["PF2_Cloth"], "default": "#89cff0" }
                    ]
                }
            })),
            hide_body_zones: BodyZoneMask::default(),
        };
        assert_eq!(
            palette_zone_color(
                &paths,
                Some("boots_canvas_ankle_c1.001"),
                &["#102030".into()]
            ),
            parse_hex_color("#102030")
        );
        assert_eq!(
            palette_zone_color(&paths, Some("PF2_Cloth.001"), &[]),
            parse_hex_color("#89cff0")
        );
        assert_eq!(
            palette_zone_color(&paths, Some("fixed_hardware"), &[]),
            None
        );
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

    #[test]
    fn weapon_mount_uses_authored_hand_local_transform() {
        let json = br#"{
            "scale_to_pawn": 1.25,
            "attach": "two_hand",
            "mount_hand_r_local": {
                "pos": [-0.03788, 0.14408, 0.05585],
                "quat": [-0.09279, 0.83834, 0.53009, -0.08703]
            },
            "sockets": {
                "grip": [0.0, 0.0, 0.0],
                "foregrip": [0.0, 0.2, 0.01],
                "muzzle": [0.0, 0.0, 0.8],
                "foregrip_contact": [0.01, -0.03, -0.04]
            },
            "hold": {
                "resting_yaw_deg": 3.0
            },
            "stow_socket": {
                "space": "spine_03_local",
                "pos": [0.16, 0.0, -0.14],
                "rot_deg": [85.0, -45.0, 0.0]
            }
        }"#;
        let hand_spec = parse_weapon_hand_spec(json).expect("authored hand spec");
        let (pos, rotation, scale) = hand_spec.mount.to_trs();
        assert!((pos.x + 0.03788).abs() < 1.0e-5);
        assert!((pos.y - 0.14408).abs() < 1.0e-5);
        assert!((pos.z - 0.05585).abs() < 1.0e-5);
        assert!((rotation.x.abs() - 0.09279).abs() < 1.0e-4);
        assert!((rotation.y.abs() - 0.83834).abs() < 1.0e-4);
        assert!((scale.x - 1.0).abs() < 1.0e-5);
        assert!((hand_spec.foregrip.y - 0.2).abs() < 1.0e-5);
        assert!((hand_spec.foregrip_contact.x - 0.01).abs() < 1.0e-5);
        assert!((hand_spec.resting_yaw_rad.to_degrees() - 3.0).abs() < 1.0e-5);
        assert_eq!(hand_spec.scale_to_pawn, Some(1.25));
        assert!(hand_spec.two_handed);
        let stow = hand_spec.stow.expect("authored stow socket");
        assert_eq!(stow.bone, "spine_03");
        let (stow_pos, _, _) = stow.mount.to_trs();
        assert!((stow_pos.x - 0.16).abs() < 1.0e-5);
        assert!((stow_pos.z + 0.14).abs() < 1.0e-5);
        assert!((stow.arc_lift - 0.14).abs() < 1.0e-5);
        assert_eq!(
            WeaponRigKind::Slugthrower.attach_stable_id(),
            "assets/pawn-pack/slugthrower_attach.json"
        );
    }
}

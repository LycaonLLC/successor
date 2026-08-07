//! The connected-mode scene: composes the real world backdrop (terrain + GLB
//! props), GLB pawns per streamed actor, environment lighting, HUD, and combat
//! FX into one `GameWorld`/`Renderer`, driven by the authoritative
//! [`AuthorityStore`]. This replaces the placeholder ground-plane + capsule
//! projection so the live client renders like `client-3d`.
//!
//! Coordinate contract: one authority cell is one metre/world unit. Actor
//! `(x, y)` addresses the cell whose world-space centre is `(x + 0.5, y + 0.5)`;
//! terrain supplies elevation, props use fixture footprints, and pawn source
//! geometry is normalized to the canonical adult height.

use std::collections::HashMap;
use core::fmt::{self, Write};

use successor_client_proto::packets::{
    GameActorSnapshot, GameCommandReceipt, GameServerPacket, GameShardDelta, GameShardSnapshot,
};
use successor_engine_core::ecs::{Entity, WorldOps};
use successor_engine_core::input::Key;
use successor_engine_core::math::{vec3, Mat4, Quat, Vec3};
use successor_engine_render::components::{
    CamTarget, Camera, CompositeQuad, DirectionalLight, MeshRenderer, Projection, RectNorm,
    SkinRef, Transform,
};
use successor_engine_render::gpu::{
    ClearSpec, Filter, Gpu, PassTarget, RectPx, RenderTargetDesc, RenderTargetId,
};
use successor_engine_render::renderer::Renderer;
use successor_engine_render::ui::UiBuilder;
use successor_engine_render::{environment, fx::glow_sprite};
use successor_net::ClientCommand;

use crate::game::actions::{self, DispatchOutcome};
use crate::game::authority::AuthorityStore;
use crate::game::chat_net::{ChatChannel, ChatMessage};
use crate::game::combat_fx::CombatFx;
use crate::game::command_queue::CommandQueue;
use crate::game::interp::ActorInterp;
use crate::game::movement;
use crate::game::prediction::MovePredictor;
use crate::hud::{self, HudState, Icons};
use crate::item_preview::ItemPreviewRenderer;
use crate::pawn::animator::{weapon_hand_bone, PawnAnimator, WeaponLane};
use crate::pawn::appearance::{faction_tinted, skin_tint, weapon_lane};
use crate::pawn::catalog::{route_for, BodyRoute, PawnCatalog, SupportArmPosture};
use crate::world::area::{biome_for_area, effective_world_seed};
use crate::world::chunks::TerrainStreamer;
use crate::world::collision_debug::CollisionDebugOverlay;
use crate::world::environs::Environs;
use crate::world::props::{building_terrain_exclusions, PropsLoader};
use crate::world::streamed::StreamedWorld;
use crate::world::terrain::Biome;
use crate::world::{ADULT_PAWN_HEIGHT_METERS, WORLD_UNITS_PER_CELL};
use successor_platform::Platform;
use crate::GameWorld;
use successor_engine_render::cursor::{self, CursorKind, CursorStyle};

#[derive(Clone, Copy)]
struct HeldWeaponRig {
    mount: Mat4,
    grip: Vec3,
    foregrip: Vec3,
    muzzle: Vec3,
    foregrip_contact: Vec3,
    resting_yaw_rad: f32,
    support_arm: Option<SupportArmPosture>,
    support_hand: bool,
}

/// A rigid weapon attachment, updated from its animated hand socket each frame.
struct WeaponAttachment {
    entities: Vec<(Entity, Mat4)>,
    hand: usize,
    held: HeldWeaponRig,
    plasma_blade: Option<Entity>,
    stow: Option<(usize, Mat4, f32)>,
    stow_blend: f32,
    stow_target: bool,
    stow_seconds: f32,
    ik_weight: f32,
}

#[derive(Clone, PartialEq, Eq)]
struct WornPresentation {
    item_id: String,
    colors: Vec<String>,
}

#[derive(Clone)]
struct PawnPresentation {
    skin: Option<String>,
    faction: Option<String>,
    sprite: Option<String>,
    role: Option<String>,
    hair: Option<String>,
    hair_material: Option<String>,
    worn: Vec<WornPresentation>,
    weapon: Option<String>,
    weapon_item_id: Option<i64>,
}

impl PawnPresentation {
    fn matches(&self, actor: &GameActorSnapshot) -> bool {
        let appearance = actor.appearance.as_ref();
        let mut actor_worn = actor.worn.iter().filter_map(|piece| {
            piece
                .item_id
                .as_deref()
                .map(|item_id| (item_id, &piece.colors))
        });
        let worn_matches = self.worn.iter().all(|expected| {
            actor_worn.next().is_some_and(|(item_id, colors)| {
                item_id == expected.item_id && colors == &expected.colors
            })
        }) && actor_worn.next().is_none();
        self.skin.as_deref() == appearance.and_then(|value| value.skin_tone.as_deref())
            && self.faction.as_deref() == actor.faction_id.as_deref()
            && self.sprite.as_deref() == actor.sprite.as_deref()
            && self.role.as_deref() == actor.role.as_deref()
            && self.hair.as_deref() == appearance.and_then(|value| value.hair.as_deref())
            && self.hair_material.as_deref()
                == appearance.and_then(|value| value.hair_material.as_deref())
            && worn_matches
            && self.weapon.as_deref()
                == actor
                    .weapon
                    .as_ref()
                    .and_then(|weapon| weapon.weapon_id.as_deref())
            && self.weapon_item_id
                == actor
                    .weapon
                    .as_ref()
                    .and_then(|weapon| weapon.weapon_item_id)
    }
}

/// A rendered pawn for one live actor: one entity per body/equipment part.
struct ActorPawn {
    id: String,
    name: String,
    descriptor: Option<String>,
    presentation: PawnPresentation,
    entities: Vec<Entity>,
    weapon: Option<WeaponAttachment>,
    animator: PawnAnimator,
    route: BodyRoute,
    lane: WeaponLane,
    scale: f32,
    alive: bool,
    interp: ActorInterp,
    predictor: MovePredictor,
    lifecycle_seq: i64,
    /// Authoritative sim target position (from the store).
    target: (f32, f32),
    /// Smoothed rendered position (lerped toward `target` each frame) — this is
    /// what drives both the transform and the gait speed, so neither snaps.
    render_pos: (f32, f32),
    /// Presentation height after floor/terrain transition filtering.
    ground_y: f32,
    speed: f32,
    yaw: f32,
    present: bool,
    /// Equipment item ids whose models were still in flight at spawn; the
    /// gear-retry pass respawns the pawn once they settle.
    pending_equipment: Vec<String>,
    /// The weapon rig was still in flight at spawn.
    pending_weapon: bool,
}

/// Motion held across a wardrobe rebuild.
///
/// Changing clothes swaps the pawn's meshes, not the person wearing them. The
/// rebuild destroys the old entities, so a naive respawn hands the actor a
/// fresh `PawnAnimator` sitting at its bind pose and the arms snap up into a
/// T-pose while the blend runs. Carrying the animator, gait and interpolation
/// across the swap keeps the stride unbroken: only the clothing changes.
struct CarriedMotion {
    animator: PawnAnimator,
    route: BodyRoute,
    lane: WeaponLane,
    interp: ActorInterp,
    predictor: MovePredictor,
    render_pos: (f32, f32),
    ground_y: f32,
    target: (f32, f32),
    speed: f32,
    yaw: f32,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct MovementDiagnostics {
    pub authoritative: (f32, f32),
    pub predicted: (f32, f32),
    pub rendered: (f32, f32),
    pub correction_cells: f32,
    pub intent: (i32, i32, bool),
    pub applied_command_id: u64,
    pub blocker_count: usize,
    pub presented_ground_y: f32,
    pub sampled_ground_y: f32,
    pub frame_dt_ms: f32,
    pub last_change_ms: u64,
    pub last_send_ms: u64,
    pub next_send_ms: u64,
    pub sampled_at_ms: u64,
}

struct DebugText<const N: usize> {
    bytes: [u8; N],
    len: usize,
}

impl<const N: usize> DebugText<N> {
    fn new() -> Self {
        Self {
            bytes: [0; N],
            len: 0,
        }
    }

    fn as_str(&self) -> &str {
        core::str::from_utf8(&self.bytes[..self.len]).expect("debug text remains UTF-8")
    }
}

impl<const N: usize> Write for DebugText<N> {
    fn write_str(&mut self, value: &str) -> fmt::Result {
        let remaining = N.saturating_sub(self.len);
        if value.len() > remaining {
            return Err(fmt::Error);
        }
        self.bytes[self.len..self.len + value.len()].copy_from_slice(value.as_bytes());
        self.len += value.len();
        Ok(())
    }
}

fn draw_movement_debug(ui: &mut UiBuilder, movement: MovementDiagnostics) {
    let mut position = DebugText::<192>::new();
    let mut timing = DebugText::<192>::new();
    let mut terrain = DebugText::<192>::new();
    let _ = write!(
        &mut position,
        "AUTH {:.3},{:.3}  PRED {:.3},{:.3}  RENDER {:.3},{:.3}  CORR {:.3}c",
        movement.authoritative.0,
        movement.authoritative.1,
        movement.predicted.0,
        movement.predicted.1,
        movement.rendered.0,
        movement.rendered.1,
        movement.correction_cells,
    );
    let send_age = movement.sampled_at_ms.saturating_sub(movement.last_send_ms);
    let next_send = movement.next_send_ms.saturating_sub(movement.sampled_at_ms);
    let _ = write!(
        &mut timing,
        "INTENT {},{}{}  APPLIED {}  BLOCKERS {}  FRAME {:.2}ms  SEND AGE {}ms NEXT {}ms",
        movement.intent.0,
        movement.intent.1,
        if movement.intent.2 { " SPRINT" } else { "" },
        movement.applied_command_id,
        movement.blocker_count,
        movement.frame_dt_ms,
        send_age,
        next_send,
    );
    let _ = write!(
        &mut terrain,
        "GROUND PRESENT {:.3}m  SAMPLE {:.3}m  DELTA {:.3}m",
        movement.presented_ground_y,
        movement.sampled_ground_y,
        movement.sampled_ground_y - movement.presented_ground_y,
    );
    ui.rect(8.0, 110.0, 610.0, 59.0, [3, 8, 12, 224]);
    ui.border(8.0, 110.0, 610.0, 59.0, 1.0, [42, 225, 231, 255]);
    ui.text(
        "SHIFT-C COLLISION  RED STATIC  ORANGE DYNAMIC  GREEN CLEARANCE  CYAN AUTH  YELLOW PRED  MAGENTA RENDER",
        14.0,
        115.0,
        1.0,
        [220, 245, 248, 255],
    );
    ui.text(position.as_str(), 14.0, 129.0, 1.0, [220, 245, 248, 255]);
    ui.text(timing.as_str(), 14.0, 142.0, 1.0, [220, 245, 248, 255]);
    ui.text(terrain.as_str(), 14.0, 155.0, 1.0, [220, 245, 248, 255]);
}

struct LiveActor {
    name: String,
    id: String,
    x: f32,
    y: f32,
    skin: Option<String>,
    faction: Option<String>,
    sprite: Option<String>,
    role: Option<String>,
    hair: Option<String>,
    hair_material: Option<String>,
    worn: Vec<WornPresentation>,
    weapon: Option<String>,
    weapon_item_id: Option<i64>,
    in_combat: bool,
    alive: bool,
    lifecycle_seq: i64,
}

#[derive(Clone, Copy)]
struct InteractionProp<'a> {
    id: &'a str,
    kind: &'a str,
    label: &'a str,
    x: f32,
    y: f32,
}

fn spatial_chat_payload(message: &ChatMessage) -> Option<(&str, &str)> {
    (message.channel == ChatChannel::Local
        && !message.sender_id.is_empty()
        && !message.text.trim().is_empty())
    .then_some((message.sender_id.as_str(), message.text.as_str()))
}

/// Keys sampled by both connected hosts. The permanent-window entries are
/// deliberately represented by their advertised `KeyboardEvent.code` mapping
/// below rather than a second hand-maintained registry.
pub const CONNECTED_INPUT_KEYS: [Key; 24] = [
    Key::C,
    Key::I,
    Key::P,
    Key::K,
    Key::B,
    Key::M,
    Key::O,
    Key::G,
    Key::Escape,
    Key::X,
    Key::R,
    Key::F,
    Key::Space,
    Key::Tab,
    Key::Digit1,
    Key::Digit2,
    Key::Digit3,
    Key::Digit4,
    Key::Digit5,
    Key::Digit6,
    Key::Digit7,
    Key::Digit8,
    Key::Digit9,
    Key::Digit0,
];

#[derive(Clone, Copy, Debug, PartialEq)]
enum ContextMenu {
    Actor { x: f32, y: f32 },
    InventoryRadial { x: f32, y: f32 },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum InventoryRadialAction {
    Use,
    Equip,
    Unequip,
    Examine,
    Drop,
    Split,
    Splice,
}

impl InventoryRadialAction {
    const fn label(self) -> &'static str {
        match self {
            Self::Use => "USE",
            Self::Equip => "EQUIP",
            Self::Unequip => "UNEQUIP",
            Self::Examine => "EXAMINE",
            Self::Drop => "DISCARD",
            Self::Split => "SPLIT",
            Self::Splice => "SPLICE",
        }
    }
}

fn inventory_has_genome(row: &crate::windows::InventoryRow) -> bool {
    row.metadata
        .as_ref()
        .is_some_and(|metadata| metadata.get("genome").is_some())
}

fn inventory_radial_can_use(row: &crate::windows::InventoryRow) -> bool {
    matches!(
        row.kind(),
        crate::windows::ItemKind::Medical
            | crate::windows::ItemKind::Ammo
            | crate::windows::ItemKind::Currency
    )
}

fn inventory_radial_can_equip(row: &crate::windows::InventoryRow) -> bool {
    matches!(
        row.kind(),
        crate::windows::ItemKind::Gear | crate::windows::ItemKind::Weapon
    )
}

fn inventory_radial_actions(
    row: &crate::windows::InventoryRow,
    splice_available: bool,
    out: &mut [InventoryRadialAction; 6],
) -> usize {
    let mut count = 0;
    if inventory_radial_can_equip(row) {
        out[count] = if row.equipped {
            InventoryRadialAction::Unequip
        } else {
            InventoryRadialAction::Equip
        };
        count += 1;
    }
    out[count] = InventoryRadialAction::Examine;
    count += 1;
    if inventory_radial_can_use(row) {
        out[count] = InventoryRadialAction::Use;
        count += 1;
    }
    out[count] = InventoryRadialAction::Drop;
    count += 1;
    if row.available > 1 {
        out[count] = InventoryRadialAction::Split;
        count += 1;
    }
    if splice_available || inventory_has_genome(row) {
        out[count] = InventoryRadialAction::Splice;
        count += 1;
    }
    count
}

fn inventory_radial_window_action(
    row: &crate::windows::InventoryRow,
    action: InventoryRadialAction,
) -> Option<crate::windows::WindowAction> {
    use crate::windows::WindowAction;

    let command = match action {
        InventoryRadialAction::Use if row.is_credit_chip() => ClientCommand::RedeemCreditChip {
            container: row.container.clone(),
            stack_id: row.stack_id.clone(),
        },
        InventoryRadialAction::Use if row.kind() == crate::windows::ItemKind::Ammo => {
            ClientCommand::RefillAmmo {
                item_id: row
                    .item_key
                    .clone()
                    .unwrap_or_else(|| row.item_id.to_string()),
            }
        }
        InventoryRadialAction::Use if inventory_radial_can_use(row) => {
            ClientCommand::UseConsumable {
                item_id: row
                    .item_key
                    .clone()
                    .unwrap_or_else(|| row.item_id.to_string()),
                item_numeric_id: Some(row.item_id),
                variant_id: Some(row.variant_id),
            }
        }
        InventoryRadialAction::Equip | InventoryRadialAction::Unequip
            if row.kind() == crate::windows::ItemKind::Gear =>
        {
            ClientCommand::SetEquippedClothing {
                item_id: row.item_id,
                equipped: action == InventoryRadialAction::Equip,
                container: Some(row.container.clone()),
                stack_id: Some(row.stack_id.clone()),
                variant_id: Some(row.variant_id),
            }
        }
        InventoryRadialAction::Equip | InventoryRadialAction::Unequip
            if row.kind() == crate::windows::ItemKind::Weapon =>
        {
            ClientCommand::SetEquippedWeapon {
                weapon_id: None,
                weapon_item_id: (action == InventoryRadialAction::Equip).then_some(row.item_id),
                weapon_variant_id: (action == InventoryRadialAction::Equip)
                    .then_some(row.variant_id),
            }
        }
        InventoryRadialAction::Drop => ClientCommand::DiscardStack {
            container: row.container.clone(),
            stack_id: row.stack_id.clone(),
            item_id: row.item_id,
            variant_id: row.variant_id,
        },
        InventoryRadialAction::Split if row.available > 1 => ClientCommand::SplitStack {
            container: row.container.clone(),
            stack_id: row.stack_id.clone(),
            item_id: row.item_id,
            variant_id: row.variant_id,
            quantity: (row.available / 2).max(1) as u32,
        },
        InventoryRadialAction::Examine => return Some(WindowAction::OpenWindow("examine".into())),
        InventoryRadialAction::Splice => return Some(WindowAction::OpenWindow("splice".into())),
        _ => return None,
    };
    Some(WindowAction::Command(command))
}

/// Select an authoritative corpse in interact range without creating one
/// locally. A missing/invalid row is simply not interactable.
fn nearest_loot_corpse_id<'a>(
    corpses: &'a [serde_json::Value],
    area_id: &str,
    player: (f32, f32),
) -> Option<&'a str> {
    let reach_sq = crate::windows::EXTRACTOR_REACH_CELLS.powi(2);
    corpses
        .iter()
        .filter_map(|corpse| {
            let id = corpse.get("id").and_then(serde_json::Value::as_str)?;
            if corpse.get("areaId").and_then(serde_json::Value::as_str) != Some(area_id) {
                return None;
            }
            let coordinate = |axis: &str, cell_axis: &str| {
                corpse
                    .get(axis)
                    .and_then(serde_json::Value::as_f64)
                    .or_else(|| {
                        corpse
                            .get(cell_axis)
                            .and_then(serde_json::Value::as_i64)
                            .map(|value| value as f64)
                    })
                    .map(|value| value as f32)
            };
            let (x, y) = (coordinate("x", "cellX")?, coordinate("y", "cellY")?);
            let dx = x - player.0;
            let dy = y - player.1;
            let distance_sq = dx * dx + dy * dy;
            (distance_sq.is_finite() && distance_sq <= reach_sq).then_some((id, distance_sq))
        })
        .min_by(|left, right| left.1.total_cmp(&right.1).then_with(|| left.0.cmp(right.0)))
        .map(|(id, _)| id)
}

fn dismiss_context_or_focused(
    context_menu: &mut Option<ContextMenu>,
    graphics_tuner: &mut crate::graphics_tuning::GraphicsTuner,
    manager: &mut successor_engine_render::window::WindowManager,
) -> bool {
    context_menu.take().is_some() || graphics_tuner.dismiss() || manager.close_focused().is_some()
}

const INVENTORY_RADIAL_RADIUS: f32 = 48.0;
const INVENTORY_RADIAL_INNER_RADIUS: f32 = 27.0;
const INVENTORY_RADIAL_NUMBERS: [&str; 6] = ["1", "2", "3", "4", "5", "6"];
const INVENTORY_RADIAL_ANGLES: [f32; 6] = [
    -core::f32::consts::FRAC_PI_2,
    -core::f32::consts::FRAC_PI_4,
    0.0,
    core::f32::consts::FRAC_PI_4,
    core::f32::consts::FRAC_PI_2,
    core::f32::consts::FRAC_PI_2 * 1.5,
];

// ── Character viewer, matched to the original client's object viewer ────────
// Values derived from the decompiled `CuiWidget3dObjectListViewer` paperdoll
// configuration via the legacy oracle: a narrow portrait FOV, a drag that spins
// the doll, a multiplicative flick decay, and a resting park angle.

/// Windows that host a live 3D character viewer, and the viewport each one
/// draws through. Viewport 0 is the world; item icons start after these.
const DOLL_WINDOWS: [&str; 4] = ["inventory", "character", "examine", "converse"];

/// Composite layers reserved per window band. A band holds one doll plus the
/// item-icon lanes belonging to the same window, so `z_rank * DOLL_BAND` never
/// collides with its neighbours.
pub const DOLL_BAND: i16 = 64;

/// One window's 3D viewer: its own camera and surface over the shared pawn.
struct DollSlot {
    camera: Entity,
    quad: Entity,
    target: RenderTargetId,
    /// Live viewer cell in framebuffer pixels, for drag hit-testing.
    viewport: Option<[f32; 4]>,
}

/// Viewport id a doll slot draws through. Viewport 0 is the world.
const fn doll_viewport(slot: usize) -> u8 {
    1 + slot as u8
}

/// Floats per UI quad: 6 vertices of 8 floats. Splitting the UI vertex stream
/// at a quad boundary means slicing at a multiple of this.
const QUAD_FLOATS: usize = 6 * 8;

/// Viewports a pawn is visible in: always the world, plus one bit per open
/// viewer showing that same pawn. One instance, many views.
fn doll_viewport_mask(subjects: &[Option<&str>; DOLL_WINDOWS.len()], pawn_id: &str) -> u32 {
    subjects
        .iter()
        .enumerate()
        .filter(|(_, subject)| **subject == Some(pawn_id))
        .fold(1u32, |mask, (slot, _)| mask | (1 << doll_viewport(slot)))
}

/// Viewer field of view: 22.5°, the original's paperdoll FOV. Narrow on
/// purpose — it keeps the doll portrait-flat instead of wide-angle distorted.
const PAPERDOLL_FOVY: f32 = core::f32::consts::PI / 8.0;
/// Yaw applied per pixel of horizontal drag.
const PAPERDOLL_DRAG_YAW_PER_PX: f32 = 0.010;
/// Flick decay per 60 Hz frame; resolved against real dt when applied.
const PAPERDOLL_SPIN_DECAY: f32 = 0.96;
/// Spin ceiling in rad/s.
const PAPERDOLL_MAX_SPIN: f32 = 1.0;
/// Below this the flick is spent and the doll holds where the player left it.
const PAPERDOLL_SPIN_EPS: f32 = 0.02;
/// Default viewer offset: zero, so the camera sits in front of the character's
/// own facing and the doll always presents front-on no matter which way the
/// pawn is turned in the world. The original's viewers likewise open on a
/// fixed front view (`ViewerState::new` starts at yaw PI in its own frame);
/// its 215° resting angle is only where an auto-rotating object parks, and
/// inventory objects do not auto-rotate unless the player asks them to.
const PAPERDOLL_RESTING_YAW: f32 = 0.0;

/// Pointer slop for selecting a streamed actor, in framebuffer pixels. Sized
/// to the projected torso at the shipped camera pitch, not to the sprite.
const ACTOR_PICK_RADIUS_PX: f32 = 32.0;
/// Pointer slop for a world verb prop. Tighter than an actor: a door is a
/// fixed volume and should not steal the pointer from the ground behind it.
const PROP_PICK_RADIUS_PX: f32 = 26.0;

fn draw_inventory_radial_arc(
    ui: &mut successor_engine_render::ui::UiBuilder,
    x: f32,
    y: f32,
    start: f32,
    end: f32,
) {
    let steps = 12;
    let mut previous = (
        x + libm::cosf(start) * INVENTORY_RADIAL_RADIUS,
        y + libm::sinf(start) * INVENTORY_RADIAL_RADIUS,
    );
    for step in 1..=steps {
        let t = step as f32 / steps as f32;
        let angle = start + (end - start) * t;
        let next = (
            x + libm::cosf(angle) * INVENTORY_RADIAL_RADIUS,
            y + libm::sinf(angle) * INVENTORY_RADIAL_RADIUS,
        );
        ui.line(
            previous.0,
            previous.1,
            next.0,
            next.1,
            1.5,
            [34, 206, 222, 236],
        );
        previous = next;
    }
}

fn inventory_radial_capsule_rect(
    ui: &UiBuilder,
    anchor: (f32, f32),
    action_index: usize,
    label: &str,
    screen: (f32, f32),
) -> [f32; 4] {
    let angle = INVENTORY_RADIAL_ANGLES[action_index];
    let (sin, cos) = libm::sincosf(angle);
    let edge_x = anchor.0 + cos * INVENTORY_RADIAL_RADIUS;
    let edge_y = anchor.1 + sin * INVENTORY_RADIAL_RADIUS;
    let width = (ui.measure_text(label, 1.15) + 27.0).ceil();
    let height = 18.0;
    let x = if cos >= -0.1 {
        edge_x + cos * 9.0 + 3.0
    } else {
        edge_x + cos * 9.0 - width - 3.0
    }
    .clamp(3.0, (screen.0 - width - 3.0).max(3.0));
    let y = (edge_y + sin * 9.0 - height * 0.5).clamp(3.0, (screen.1 - height - 3.0).max(3.0));
    [x, y, width, height]
}

fn draw_inventory_radial(
    ui: &mut successor_engine_render::ui::UiBuilder,
    row: &crate::windows::InventoryRow,
    anchor: (f32, f32),
    splice_available: bool,
    screen: (f32, f32),
) -> (bool, Option<crate::windows::WindowAction>) {
    let mut actions = [InventoryRadialAction::Examine; 6];
    let action_count = inventory_radial_actions(row, splice_available, &mut actions);
    draw_inventory_radial_arc(
        ui,
        anchor.0,
        anchor.1,
        -core::f32::consts::PI * 0.82,
        core::f32::consts::FRAC_PI_2 * 1.12,
    );
    ui.ring(
        anchor.0,
        anchor.1,
        INVENTORY_RADIAL_INNER_RADIUS,
        12,
        1.0,
        [21, 122, 135, 236],
    );
    ui.line(
        anchor.0,
        anchor.1 - INVENTORY_RADIAL_INNER_RADIUS,
        anchor.0,
        anchor.1 - INVENTORY_RADIAL_RADIUS + 5.0,
        1.4,
        [51, 221, 231, 246],
    );

    let (mx, my) = ui.mouse();
    let mut close = false;
    let mut selected = None;
    for (index, action) in actions.iter().take(action_count).copied().enumerate() {
        let angle = INVENTORY_RADIAL_ANGLES[index];
        let (sin, cos) = libm::sincosf(angle);
        let from = (
            anchor.0 + cos * INVENTORY_RADIAL_RADIUS,
            anchor.1 + sin * INVENTORY_RADIAL_RADIUS,
        );
        let [x, y, width, height] =
            inventory_radial_capsule_rect(ui, anchor, index, action.label(), screen);
        let response = ui.interact(x, y, width, height);
        let fill = if response.hovered {
            [12, 63, 70, 248]
        } else {
            [3, 31, 36, 238]
        };
        ui.line(
            from.0,
            from.1,
            x + if cos >= -0.1 { 2.0 } else { width - 2.0 },
            y + height * 0.5,
            1.0,
            [34, 174, 188, 222],
        );
        ui.rect(x, y, width, height, fill);
        ui.line(
            x + 3.0,
            y + 1.0,
            x + width - 3.0,
            y + 1.0,
            1.0,
            [50, 191, 202, 220],
        );
        ui.text(
            INVENTORY_RADIAL_NUMBERS[index],
            x + 5.0,
            y + 5.0,
            1.1,
            [214, 242, 244, 255],
        );
        ui.text(action.label(), x + 15.0, y + 5.0, 1.1, [229, 244, 245, 255]);
        if response.clicked {
            selected = inventory_radial_window_action(row, action);
            close = true;
        }
    }
    let dx = mx - anchor.0;
    let dy = my - anchor.1;
    let in_ring = dx * dx + dy * dy <= (INVENTORY_RADIAL_RADIUS + 8.0).powi(2);
    let in_capsule = actions
        .iter()
        .take(action_count)
        .enumerate()
        .any(|(index, action)| {
            let [x, y, width, height] =
                inventory_radial_capsule_rect(ui, anchor, index, action.label(), screen);
            UiBuilder::hit(x, y, width, height, mx, my)
        });
    if ui.interact(0.0, 0.0, screen.0, screen.1).pressed && !in_ring && !in_capsule {
        close = true;
    }
    (close, selected)
}

/// UI cue an accepted command earns on settlement.
///
/// Mirrors the web client's `item_transfer` / `credits_chime` /
/// `area_transition` vocabulary: the sound belongs to the authority's receipt,
/// not to the click, so a refused transfer never sounds like a completed one.
fn ui_cue_for_settled(command: &ClientCommand) -> Option<crate::audio::UiCue> {
    match command {
        ClientCommand::SetEquippedWeapon { .. }
        | ClientCommand::SetEquippedClothing { .. }
        | ClientCommand::BankStoreItem { .. }
        | ClientCommand::BankRetrieveItem { .. }
        | ClientCommand::TakeLootItem { .. }
        | ClientCommand::HarvestCorpse { .. }
        | ClientCommand::DiscardStack { .. }
        | ClientCommand::SplitStack { .. }
        | ClientCommand::MergeStacks { .. }
        | ClientCommand::StoreToExchange { .. } => Some(crate::audio::UiCue::ItemTransfer),
        ClientCommand::RedeemCreditChip { .. } => Some(crate::audio::UiCue::CreditsChime),
        ClientCommand::EnterTransition { .. } => Some(crate::audio::UiCue::AreaTransition),
        _ => None,
    }
}

/// One optional JSON value per persisted section, in the order
/// `ConnectedScene::take_persisted` returns them: theme, toolbar, split snap,
/// waypoints, macros, window layout, UI opacity.
pub type PersistedSections = (
    Option<serde_json::Value>,
    Option<serde_json::Value>,
    Option<serde_json::Value>,
    Option<serde_json::Value>,
    Option<serde_json::Value>,
    Option<serde_json::Value>,
    Option<serde_json::Value>,
);

/// Active travel transition: the loading screen stays up until the
/// destination's spawn-neighborhood props stream in, or the deadline forces
/// fail-closed marker placement.
struct TravelHold {
    deadline_ms: u64,
}

pub struct ConnectedScene {
    pub world: GameWorld,
    pub renderer: Renderer,
    pub store: AuthorityStore,
    pawn_catalog: PawnCatalog,
    terrain: TerrainStreamer,
    slice: successor_engine_core::json::Json,
    props_loader: PropsLoader,
    collision_debug: CollisionDebugOverlay,
    movement_collision: crate::world::movement_collision::MovementCollisionWorld,
    loaded_area_id: String,
    streamed_world: StreamedWorld,
    pawns: HashMap<String, ActorPawn>,
    missing_pawns: Vec<String>,
    /// Motion parked by a wardrobe rebuild, claimed by the respawn that
    /// follows it in the same frame.
    carried_motion: HashMap<String, CarriedMotion>,
    stale_pawns: Vec<String>,
    center: Vec3,
    follow: Entity,
    sun: Entity,
    combat_fx: CombatFx,
    /// One live 3D viewer per doll-capable window. The original gives every
    /// `CuiWidget3dObjectViewer` its own camera over the *same* world object,
    /// so the player is on screen in the world and in every open viewer at
    /// once; these slots are that, one per window.
    dolls: [DollSlot; DOLL_WINDOWS.len()],
    /// Viewer turntable yaw offset, in radians, applied on top of the pawn's
    /// own facing. A drag spins it; the flick then decays and parks.
    paperdoll_yaw: f32,
    /// Viewer spin velocity in rad/s, decaying after a drag is released.
    paperdoll_spin: f32,
    /// Pointer x at the start of a viewer drag, while the button is held.
    paperdoll_drag_x: Option<f32>,
    item_previews: ItemPreviewRenderer,
    fx_buf: Vec<f32>,
    icons: Icons,
    ui: successor_engine_render::ui::UiBuilder,
    hud_state: HudState,
    overlays: hud::overlays::Overlays,
    last_dialogue_tick: i64,
    last_applied_move_command_id: u64,
    toolbar: hud::toolbar::Toolbar,
    waypoints: hud::waypoints::WaypointStore,
    macro_runtime: crate::game::macro_runtime::MacroRuntime,
    macro_actions: Vec<actions::GameplayAction>,
    hud_actions: Vec<hud::HudAction>,
    theme_index: usize,
    dust_strength: f32,
    /// Workspace frame fill opacity (persisted player setting).
    window_opacity: f32,
    /// HUD pane fill opacity, separate because the HUD sits over gameplay for
    /// the whole session while a window is transient.
    hud_opacity: f32,
    split_snap: u32,
    rebind_pending: Option<usize>,
    preferences_dirty: bool,
    /// Layout changes that do not alter manager geometry: visibility, focus
    /// order, iconification, and HUD pane locks.
    window_layout_dirty: bool,
    pending_bug_report: Option<serde_json::Value>,
    bug_report_sequence: u32,
    right_was_down: bool,
    hud_right_was_down: bool,
    /// A pointer route consumed a right-click to toggle one HUD pane's layout
    /// lock. The render pass consumes this once to gate HUD controls on that
    /// same input edge without toggling the lock a second time.
    hud_layout_input_consumed: bool,
    /// Whether the client currently owns the pointer and is drawing it. Only
    /// the transition touches the platform, so a hidden desktop cursor is not
    /// re-asserted every frame.
    owns_cursor: bool,
    /// View-projection retained from the last drawn frame; see
    /// [`ConnectedScene::viewport_projection`].
    pointer_vp: Option<Mat4>,
    /// A fresh registry or an older workspace document can be missing
    /// individual panes. Only those slots receive first-run defaults.
    hud_defaults_pending: [bool; hud::HUD_SURFACE_COUNT],
    /// Viewport the live HUD rects are anchored to. `load_persisted` stamps it
    /// from the restored document; `frame` re-anchors whenever the real
    /// framebuffer disagrees. Construction cannot decide this: the scene is
    /// built before the first framebuffer is known, so a layout matched at that
    /// point is matched against a placeholder.
    hud_layout_viewport: Option<(f32, f32)>,
    framebuffer: (u32, u32),
    selected_actor_id: Option<String>,
    selected_inventory: Option<(String, String)>,
    loot_corpse_id: Option<String>,
    context_menu: Option<ContextMenu>,
    left_was_down: bool,
    pointer_prev: (f32, f32),
    zoom_percent: f32,
    key_was_down: [bool; Key::COUNT],
    /// Persistent sprint toggle (X), independent of held Shift.
    sprint_toggle: bool,
    pub loading_screen: crate::screens::LoadingScreen,
    pub loading: bool,
    window_order: Vec<usize>,
    /// `(ui quad count, window draw rank)` captured while the windows draw, so
    /// the frame can flush the UI up to each window and composite its 3D
    /// surfaces there. Reused every frame; never reallocated.
    composite_marks: Vec<(u32, i16)>,
    window_id_scratch: String,
    wm: successor_engine_render::window::WindowManager,
    win_model: crate::windows::WindowModel,
    graphics_tuner: crate::graphics_tuning::GraphicsTuner,
    command_queue: Option<CommandQueue>,
    pending_window_commands: Vec<u64>,
    window_rejection: Option<String>,
    weather: successor_engine_render::weather::Weather,
    environs: Environs,
    sfx: crate::audio::SfxPlayer,
    weather_audio: Option<&'static str>,
    music_audio: Option<&'static str>,
    music_combat_index: u32,
    music_was_in_combat: bool,
    settlement_audio: bool,
    footstep_distance: f32,
    footstep_index: u32,
    footstep_position: Option<(f32, f32)>,
    ambience_timer: f32,
    ambience_roll: u32,
    player_id: String,
    shard_id: String,
    area_id: String,
    /// Transient muzzle-flash point lights: (entity, remaining seconds).
    muzzle_lights: Vec<(Entity, f32)>,
    sim_time: f32,
    last_frame_dt: f32,
    movement_timing: movement::MovementTiming,
    movement_sampled_at_ms: u64,
    move_intent: (i32, i32, bool),
    walk_speed_cells_per_second: f32,
    sprint_speed_cells_per_second: f32,
    click_route: Vec<(i32, i32)>,
    click_route_index: usize,
    click_goal: Option<(i32, i32)>,
    /// Inspection orbit. `None` is the shipped locked camera.
    debug_camera: Option<DebugCamera>,
    /// Bounded async asset fetches (wardrobe, creatures, region props).
    streamer: crate::assets::stream::AssetStreamer,
    /// Travel transition in progress, if any.
    travel_hold: Option<TravelHold>,
    /// Scratch id list for the streamed-gear retry pass (reused each frame).
    gear_retry: Vec<String>,
}

fn follow_focus(ground: Vec3) -> Vec3 {
    ground.add(vec3(0.0, ADULT_PAWN_HEIGHT_METERS * 0.5, 0.0))
}

fn follow_eye(ground: Vec3) -> Vec3 {
    // Locked north-up reference camera: 96 m from focus at a 60° pitch.
    let distance = 96.0;
    let pitch = 60.0_f32.to_radians();
    follow_focus(ground).add(vec3(0.0, distance * pitch.sin(), distance * pitch.cos()))
}

/// Free orbit for inspection, off by default.
///
/// The shipped camera is locked north-up at a fixed pitch, which is correct for
/// play and useless for judging geometry: you cannot see which way a door
/// slides, how far it travels, or whether a wall sits where its collision says,
/// from one angle directly overhead. This orbits the same focus without
/// touching the game, so the world can be read from any side.
#[derive(Clone, Copy)]
struct DebugCamera {
    yaw: f32,
    pitch: f32,
    distance: f32,
}

impl Default for DebugCamera {
    fn default() -> Self {
        // Opens exactly on the shipped view, so switching it on changes nothing
        // until it is actually moved.
        Self {
            yaw: 0.0,
            pitch: 60.0_f32.to_radians(),
            distance: 96.0,
        }
    }
}

impl DebugCamera {
    /// Smallest pitch that still looks down at the ground, and the largest that
    /// has not flipped over the top.
    const MIN_PITCH: f32 = 0.12;
    const MAX_PITCH: f32 = 1.50;

    fn eye(self, ground: Vec3) -> Vec3 {
        let horizontal = self.distance * self.pitch.cos();
        follow_focus(ground).add(vec3(
            horizontal * self.yaw.sin(),
            self.distance * self.pitch.sin(),
            horizontal * self.yaw.cos(),
        ))
    }

    fn orbit(&mut self, yaw: f32, pitch: f32) {
        self.yaw = (self.yaw + yaw).rem_euclid(core::f32::consts::TAU);
        self.pitch = (self.pitch + pitch).clamp(Self::MIN_PITCH, Self::MAX_PITCH);
    }

    fn dolly(&mut self, factor: f32) {
        self.distance = (self.distance * factor).clamp(6.0, 240.0);
    }
}

/// Registration geometry for a window id. The surface spec owns default bounds
/// and the resize floor (`windows::spec`), so a frame's size, its minimum, and
/// its family density all come from one table. `index` is retained for the
/// caller's registration order; the spec's per-surface anchor replaces the old
/// cascade offset, which only produced distinct positions at one framebuffer.
fn window_geometry(id: &str, _index: usize) -> ([f32; 4], f32, f32) {
    crate::windows::spec::geometry(id, WINDOW_BASELINE.0, WINDOW_BASELINE.1)
}

/// Viewport the registration defaults are evaluated against. `WindowManager`
/// clamps to the live framebuffer on the first frame, and the inventory frame is
/// a fixed 660x521 at every framebuffer, so this baseline only decides where
/// viewport-relative frames start before the player moves them.
const WINDOW_BASELINE: (f32, f32) = (1280.0, 720.0);

const WINDOW_LAYOUT_SCHEMA: &str = "successor.window-layout.v1";

/// Viewport a saved layout document was captured at, when it records one.
/// A document predating the field returns `None` and is treated as foreign.
fn layout_viewport(value: Option<&serde_json::Value>) -> Option<(f32, f32)> {
    let saved = value?
        .get("viewport")?
        .as_array()
        .filter(|saved| saved.len() == 2)?;
    Some((saved[0].as_f64()? as f32, saved[1].as_f64()? as f32))
}

/// Whether HUD rects stamped for `stamp` still belong to the `live` viewport.
/// A document with no stamp is foreign and always re-anchors.
fn hud_anchor_is_stale(stamp: Option<(f32, f32)>, live: (f32, f32)) -> bool {
    stamp.is_none_or(|stamp| (stamp.0 - live.0).abs() >= 0.5 || (stamp.1 - live.1).abs() >= 0.5)
}

/// Restore geometry plus workspace visibility/order and HUD lock state.
/// Returns one `true` slot for each HUD pane absent from the document, so a
/// schema predating a newly registered pane preserves every rect it did save.
///
/// Saved HUD rects are applied verbatim here. Whether they still fit is not
/// knowable at restore time — the scene is constructed before the first
/// framebuffer arrives — so the caller stamps [`layout_viewport`] and
/// `ConnectedScene::frame` re-anchors once the real viewport disagrees.
fn restore_window_layout(
    manager: &mut successor_engine_render::window::WindowManager,
    value: Option<&serde_json::Value>,
) -> [bool; crate::hud::HUD_SURFACE_COUNT] {
    let Some(rows) = value
        .filter(|document| {
            document.get("schema").and_then(serde_json::Value::as_str) == Some(WINDOW_LAYOUT_SCHEMA)
        })
        .and_then(|document| document.get("windows"))
        .and_then(serde_json::Value::as_array)
    else {
        return [true; crate::hud::HUD_SURFACE_COUNT];
    };



    let mut missing_hud = [true; crate::hud::HUD_SURFACE_COUNT];
    let mut open_rows = Vec::new();
    for (row_index, row) in rows.iter().enumerate() {
        let Some(id) = row.get("id").and_then(serde_json::Value::as_str) else {
            continue;
        };
        let Some(raw) = row.get("bounds").and_then(serde_json::Value::as_array) else {
            continue;
        };
        if raw.len() != 4 {
            continue;
        }
        let mut bounds = [0.0; 4];
        let mut valid = true;
        for (index, value) in raw.iter().enumerate() {
            let Some(number) = value.as_f64() else {
                valid = false;
                break;
            };
            bounds[index] = number as f32;
        }
        let is_hud = crate::hud::HUD_SURFACES
            .iter()
            .position(|surface| surface.id == id);
        let apply_geometry = valid;
        if apply_geometry && manager.set_rect(id, bounds) {
            if let Some(index) = is_hud {
                missing_hud[index] = false;
            }
        }
        if let Some(locked) = row.get("locked").and_then(serde_json::Value::as_bool) {
            crate::hud::set_hud_surface_locked(manager, id, locked);
        }
        if let Some(open) = row.get("open").and_then(serde_json::Value::as_bool) {
            manager.close(id);
            if open {
                let z = row
                    .get("z")
                    .and_then(serde_json::Value::as_u64)
                    .unwrap_or(row_index as u64);
                let iconified = row
                    .get("iconified")
                    .and_then(serde_json::Value::as_bool)
                    .unwrap_or(false);
                open_rows.push((z, row_index, id, iconified));
            }
        }
    }
    // Opening back-to-front recreates the saved focus order without exposing
    // the manager's internal z counter in the persistence schema.
    open_rows.sort_unstable_by_key(|(z, row_index, _, _)| (*z, *row_index));
    for (_, _, id, iconified) in open_rows {
        manager.open(id);
        if iconified {
            let _ = manager.iconify(id);
        }
    }
    missing_hud
}

fn save_window_layout(
    manager: &successor_engine_render::window::WindowManager,
    viewport: (f32, f32),
) -> serde_json::Value {
    let mut z_order = Vec::new();
    manager.fill_z_order(&mut z_order);
    let mut windows = Vec::new();
    manager.for_each_geometry(|id, bounds| {
        let mut row = serde_json::Map::new();
        row.insert("id".into(), serde_json::Value::String(id.into()));
        row.insert("bounds".into(), serde_json::json!(bounds));
        row.insert("open".into(), serde_json::Value::Bool(manager.is_open(id)));
        if let Some(z) = z_order
            .iter()
            .position(|index| manager.window_id(*index) == id)
        {
            row.insert("z".into(), serde_json::Value::from(z as u64));
        }
        if crate::hud::is_hud_surface(id) {
            row.insert(
                "locked".into(),
                serde_json::Value::Bool(!manager.is_interactive(id)),
            );
            row.insert(
                "iconified".into(),
                serde_json::Value::Bool(manager.is_iconified(id)),
            );
        }
        windows.push(serde_json::Value::Object(row));
    });
    serde_json::json!({
        "schema": WINDOW_LAYOUT_SCHEMA,
        "viewport": [viewport.0, viewport.1],
        "windows": windows,
    })
}

fn filtered_gait_speed(previous: f32, displacement_cells: f32, dt_seconds: f32) -> f32 {
    if dt_seconds <= 0.0 {
        return previous;
    }
    if displacement_cells > 2.0 {
        return 0.0;
    }
    let instantaneous = displacement_cells / dt_seconds;
    let alpha = 1.0 - (-dt_seconds / 0.05).exp();
    previous + (instantaneous - previous) * alpha
}

const GROUND_HYSTERESIS_METERS: f32 = 0.025;
const GROUND_SNAP_METERS: f32 = 3.0;
const GROUND_FOLLOW_METERS_PER_SECOND: f32 = 6.0;

fn smooth_ground_height(current: f32, target: f32, dt_seconds: f32) -> f32 {
    if !current.is_finite() || !target.is_finite() {
        return target;
    }
    let delta = target - current;
    let distance = delta.abs();
    if distance <= GROUND_HYSTERESIS_METERS {
        return current;
    }
    if distance >= GROUND_SNAP_METERS {
        return target;
    }
    let step = (GROUND_FOLLOW_METERS_PER_SECOND * dt_seconds.max(0.0))
        .min(distance - GROUND_HYSTERESIS_METERS);
    current + delta.signum() * step
}

impl ConnectedScene {
    /// Build renderer resources from stable asset ids. Area-scoped terrain and
    /// props are deferred until the first accepted authority snapshot.
    pub fn build<G: Gpu>(
        gpu: &mut G,
        player_id: &str,
        read_asset: &mut dyn FnMut(&str) -> Option<Vec<u8>>,
    ) -> Result<Self, String> {
        let mapping = read_asset("render/props-mapping.json")
            .and_then(|bytes| String::from_utf8(bytes).ok())
            .ok_or_else(|| "required asset missing: render/props-mapping.json".to_string())?;
        let slice_str = read_asset("successor-slice/open-desert-slice.json")
            .and_then(|bytes| String::from_utf8(bytes).ok())
            .ok_or_else(|| {
                "required asset missing: successor-slice/open-desert-slice.json".to_string()
            })?;
        let slice = successor_engine_core::json::Json::parse(&slice_str)
            .map_err(|_| "slice parse".to_string())?;
        let mut renderer = crate::configured_renderer(gpu).expect("renderer initialization failed");
        // Time-of-day owns fog and its authored base grade; the render settings
        // asset owns ambient, sun, bloom, shadows, AA, AO, and mastering.
        let env = environment::sample(720.0);
        renderer.set_fog(env.fog, 160.0, 340.0);
        renderer.set_grade(
            env.bone_tint,
            env.desaturate,
            env.scene_darken,
            env.black_lift,
        );
        let mut world = GameWorld::new();

        let center = Vec3::ZERO;
        renderer.gi_set_focus([center.x, center.y, center.z]);

        // Empty until the accepted player area is known. `sync_active_area`
        // creates the correctly seeded/biomed streamer and scoped prop set.
        let streamer = TerrainStreamer::new(
            crate::world::area::FALLBACK_WORLD_SEED as i32,
            Biome::Desert,
            64.0 * WORLD_UNITS_PER_CELL as f64,
            3,
            0b1,
        );
        let loader = PropsLoader::new(&mapping).map_err(|_| "props loader".to_string())?;
        let pawn_catalog = PawnCatalog::load(gpu, &mut renderer, read_asset)?;
        let sun_angle = -45.0_f32.to_radians();
        let (sun_sin, sun_cos) = sun_angle.sin_cos();
        let sun_dir = vec3(
            env.sun_dir[0] * sun_cos + env.sun_dir[2] * sun_sin,
            env.sun_dir[1],
            -env.sun_dir[0] * sun_sin + env.sun_dir[2] * sun_cos,
        )
        .normalize();
        let sun = world.spawn();
        world.set_component(
            sun,
            DirectionalLight {
                dir: sun_dir,
                color: env.sun_color,
                cast_shadows: true,
            },
        );

        // Follow camera. The tactical radar is rendered by the HUD from
        // authority contacts; a second live world view duplicated it, obscured
        // the top-right instrument and cost an avoidable render pass.
        let follow = world.spawn();
        world.set_component(
            follow,
            Camera {
                viewport_id: 0,
                order: 0,
                projection: Projection::Ortho {
                    half_height: 12.5,
                    near: 0.1,
                    far: 320.0,
                },
                target: CamTarget::Screen(RectNorm::FULL),
                clear: ClearSpec {
                    color: Some([env.fog[0], env.fog[1], env.fog[2], 1.0]),
                    depth: Some(1.0),
                },
                eye: follow_eye(center),
                look_at: follow_focus(center),
                up: Vec3::Y,
            },
        );
        let dolls = core::array::from_fn(|_| DollSlot {
            camera: world.spawn(),
            quad: world.spawn(),
            target: gpu.create_render_target(&RenderTargetDesc {
                width: 384,
                height: 640,
                color: true,
                depth: true,
                filter: Filter::Linear,
            }),
            viewport: None,
        });

        let item_previews = ItemPreviewRenderer::new(gpu, &mut world);
        // Combat FX + HUD.
        let glow = glow_sprite(64);
        renderer.set_particle_atlas(gpu, 64, 64, &glow);
        let icons = Icons::load();
        renderer.set_ui_atlas(gpu, icons.meta.width, icons.meta.height, &icons.rgba);
        let ui = icons.ui_builder();
        // Interactive window manager: register the game windows with cascaded
        // bounds + toolbar icons (opened from the action bar).
        let mut wm = successor_engine_render::window::WindowManager::new();
        let mut window_index = 0usize;
        for (id, title, icon, _) in crate::hud::PERMANENT_WINDOWS {
            let (bounds, min_w, min_h) = window_geometry(id, window_index);
            wm.register(id, title, icons.cell(icon), bounds, min_w, min_h);
            window_index += 1;
        }
        for (id, title, icon) in crate::hud::CONTEXT_WINDOWS {
            let (bounds, min_w, min_h) = window_geometry(id, window_index);
            wm.register(id, title, icons.cell(icon), bounds, min_w, min_h);
            window_index += 1;
        }
        hud::register_hud_surfaces(&mut wm, &icons);
        wm.set_title(
            "inventory",
            &format!("{} (INVENTORY)", player_id.to_ascii_uppercase()),
        );
        let weather = successor_engine_render::weather::Weather::new(0x0d3d);
        let sfx = {
            let mut player = crate::audio::SfxPlayer::new();
            if let Some(manifest) = read_asset("successor-audio/sfx/manifest.json")
                .and_then(|bytes| String::from_utf8(bytes).ok())
            {
                player.load_with(&manifest, read_asset);
            }
            player
        };
        let collision_debug = CollisionDebugOverlay::new(&mut renderer, gpu);

        Ok(Self {
            world,
            renderer,
            store: AuthorityStore::new(),
            pawn_catalog,
            terrain: streamer,
            carried_motion: HashMap::new(),
            pawns: HashMap::new(),
            missing_pawns: Vec::with_capacity(32),
            stale_pawns: Vec::with_capacity(8),
            follow,
            slice,
            props_loader: loader,
            collision_debug,
            movement_collision: crate::world::movement_collision::MovementCollisionWorld::default(),
            sun,
            loaded_area_id: String::new(),
            streamed_world: StreamedWorld::new(),
            dolls,
            paperdoll_yaw: PAPERDOLL_RESTING_YAW,
            paperdoll_spin: 0.0,
            paperdoll_drag_x: None,
            item_previews,
            combat_fx: CombatFx::new(0x51ce_57ed),
            fx_buf: Vec::with_capacity(64 * 1024),
            icons,
            ui,
            hud_state: HudState::default(),
            overlays: hud::overlays::Overlays::new(),
            last_dialogue_tick: i64::MIN,
            last_applied_move_command_id: 0,
            toolbar: hud::toolbar::Toolbar::new(hud::toolbar::ToolbarDoc::default_loadout()),
            waypoints: hud::waypoints::WaypointStore::new(),
            macro_runtime: crate::game::macro_runtime::MacroRuntime::default(),
            macro_actions: Vec::with_capacity(crate::game::macro_runtime::STEPS_PER_TICK_MAX),
            hud_actions: Vec::with_capacity(8),
            theme_index: 0,
            dust_strength: 0.5,
            window_opacity: 0.92,
            hud_opacity: 0.90,
            split_snap: 100,
            rebind_pending: None,
            preferences_dirty: false,
            window_layout_dirty: false,
            pending_bug_report: None,
            bug_report_sequence: 0,
            hud_right_was_down: false,
            right_was_down: false,
            hud_layout_input_consumed: false,
            owns_cursor: false,
            pointer_vp: None,
            hud_defaults_pending: [true; hud::HUD_SURFACE_COUNT],
            left_was_down: false,
            pointer_prev: (0.0, 0.0),
            zoom_percent: 100.0,
            key_was_down: [false; Key::COUNT],
            sprint_toggle: false,
            hud_layout_viewport: None,
            framebuffer: (1280, 720),
            selected_actor_id: None,
            selected_inventory: None,
            loot_corpse_id: None,
            context_menu: None,
            wm,
            window_order: Vec::with_capacity(32),
            composite_marks: Vec::with_capacity(32),
            window_id_scratch: String::with_capacity(32),
            win_model: crate::windows::WindowModel::default(),
            graphics_tuner: crate::graphics_tuning::GraphicsTuner::new(),
            command_queue: None,
            pending_window_commands: Vec::with_capacity(16),
            window_rejection: None,
            weather,
            player_id: player_id.to_string(),
            shard_id: String::new(),
            environs: Environs::new(),
            sfx,
            weather_audio: None,
            music_audio: None,
            music_combat_index: 0,
            music_was_in_combat: false,
            settlement_audio: false,
            footstep_distance: 0.0,
            footstep_index: 0,
            footstep_position: None,
            ambience_timer: 1.0,
            ambience_roll: 0,
            area_id: String::new(),
            center,
            muzzle_lights: Vec::with_capacity(32),
            sim_time: 0.0,
            last_frame_dt: 0.0,
            movement_timing: movement::MovementTiming::default(),
            movement_sampled_at_ms: 0,
            move_intent: (0, 0, false),
            click_route: Vec::new(),
            walk_speed_cells_per_second: crate::game::prediction::BASE_SPEED_CELLS,
            sprint_speed_cells_per_second: crate::game::prediction::BASE_SPEED_CELLS
                * crate::game::prediction::SPRINT_MULTIPLIER,
            click_route_index: 0,
            click_goal: None,
            debug_camera: None,
            loading_screen: {
                let mut screen =
                    crate::screens::LoadingScreen::new("PLANETFALL", "AWAITING WORLD SNAPSHOT");
                screen.set_indeterminate(true);
                screen
            },
            loading: true,
            streamer: crate::assets::stream::AssetStreamer::new(),
            travel_hold: None,
            gear_retry: Vec::new(),
        })
    }

    pub fn on_snapshot(&mut self, snap: &GameShardSnapshot) {
        self.loading = false;
        self.shard_id = snap.shard_id.clone();
        self.area_id = snap
            .actors
            .get(&snap.player_actor_id)
            .map(|a| a.area_id.clone())
            .unwrap_or_default();
        self.store.apply_snapshot(snap);
        self.project_windows();
    }

    pub fn set_loading(&mut self, loading: bool) {
        self.loading = loading;
    }
    pub fn shard_id(&self) -> Option<&str> {
        (!self.shard_id.is_empty()).then_some(self.shard_id.as_str())
    }
    pub fn area_id(&self) -> Option<&str> {
        (!self.area_id.is_empty()).then_some(self.area_id.as_str())
    }
    pub fn player_actor(&self) -> Option<&successor_client_proto::packets::GameActorSnapshot> {
        self.store.actors.get(&self.store.player_actor_id)
    }
    pub fn on_delta(&mut self, delta: &GameShardDelta) {
        self.shard_id = delta.shard_id.clone();
        self.store.apply_delta(delta);
        if let Some(actor) = self.player_actor() {
            self.area_id = actor.area_id.clone();
        }
        self.project_windows();
    }
    /// Apply a targeted room message - the per-player results of gameplay
    /// commands, which arrive beside the world packet stream rather than in it.
    pub fn apply_room_message(&mut self, msg_type: &str, payload: &serde_json::Value) {
        self.store.apply_room_message(msg_type, payload);
        self.project_windows();
    }

    pub fn apply_server_packet(&mut self, packet: GameServerPacket) {
        match packet {
            GameServerPacket::Snapshot {
                snapshot,
                receipts,
                events,
                compact_events,
            } => {
                self.on_snapshot(&snapshot);
                self.settle_packet_receipts(&receipts);
                self.ingest_packet_events(&events);
                self.ingest_packet_events(compact_events.as_deref().unwrap_or(&[]));
            }
            GameServerPacket::Delta {
                delta,
                receipts,
                events,
                compact_events,
            } => {
                self.on_delta(&delta);
                self.settle_packet_receipts(&receipts);
                self.ingest_packet_events(&events);
                self.ingest_packet_events(compact_events.as_deref().unwrap_or(&[]));
            }
            GameServerPacket::Receipts {
                receipts,
                events,
                compact_events,
            } => {
                self.settle_packet_receipts(&receipts);
                self.ingest_packet_events(&events);
                self.ingest_packet_events(compact_events.as_deref().unwrap_or(&[]));
            }
            GameServerPacket::Acks {
                acks,
                movement_profile,
                player_actor,
                player_position,
                events,
                compact_events,
            } => {
                for ack in acks {
                    self.settle_command(ack.0, ack.1 != 0, ack.3);
                }
                if let Some(player_actor) = player_actor {
                    self.on_player_pos(player_actor.x, player_actor.y);
                } else if let Some(position) = player_position.as_ref() {
                    self.on_player_pos(position.0, position.1);
                }
                if let Some(applied_command_id) =
                    player_position.and_then(|position| position.2)
                {
                    self.last_applied_move_command_id = self
                        .last_applied_move_command_id
                        .max(applied_command_id);
                }
                if let Some(profile) = movement_profile {
                    self.walk_speed_cells_per_second =
                        profile.walk_speed_milli_per_second.max(0) as f32 / 1_000.0;
                    self.sprint_speed_cells_per_second =
                        profile.sprint_speed_milli_per_second.max(0) as f32 / 1_000.0;
                }
                if let Some(events) = events {
                    self.ingest_packet_events(&events);
                }
                self.ingest_packet_events(compact_events.as_deref().unwrap_or(&[]));
            }
            _ => {}
        }
    }

    fn settle_packet_receipts(&mut self, receipts: &[GameCommandReceipt]) {
        for receipt in receipts {
            self.settle_command(
                receipt.command_id,
                receipt.accepted,
                receipt.reason_code.clone(),
            );
        }
    }

    fn ingest_packet_events(&mut self, events: &[serde_json::Value]) {
        for event in events {
            if let Some(combat) = crate::game::combat_fx::CombatEvent::from_json(event) {
                self.ingest_combat(&combat);
            }
        }
    }

    /// Rebuild the live window sections from the accepted store. Wholesale, so
    /// a present-empty wire section clears the prior rows and an absent player
    /// actor clears the player-scoped summaries. Runs per applied packet, not
    /// per frame.
    fn project_windows(&mut self) {
        use crate::windows::model::{
            BuildCatalogItem, BuildGhost, Gate, TrainerView, TravelCity, TravelPlanet,
        };
        use crate::windows::project::ProjectContext;

        let pending = self
            .command_queue
            .as_ref()
            .map(|queue| {
                queue
                    .pending_envelopes()
                    .map(|envelope| {
                        (
                            envelope.command_id,
                            crate::game::command_queue::command_kind(&envelope.command),
                        )
                    })
                    .collect()
            })
            .unwrap_or_default();
        let player = self.store.actors.get(&self.player_id);
        if let Some(actor) = player {
            let name = hud::clean_actor_name(&actor.display_name, &actor.label, &self.player_id);
            self.wm.set_title(
                "inventory",
                &format!("{} (INVENTORY)", name.to_ascii_uppercase()),
            );
        }
        let player_cell = player.map(|actor| (actor.x, actor.y)).unwrap_or((0.0, 0.0));
        let mut context = ProjectContext {
            selected_actor_id: self.selected_actor_id.clone(),
            selected_inventory: self.selected_inventory.clone(),
            loot_corpse_id: self.loot_corpse_id.clone(),
            pending,
            now_ms: successor_platform::now_ms(),
            ..ProjectContext::default()
        };
        context.build_catalog = [
            (
                "floor_1x1",
                "FLOOR PANEL",
                "floors",
                vec![("structural", 2)],
                1,
                1,
                false,
            ),
            (
                "wall_1m",
                "WALL SEGMENT",
                "walls",
                vec![("structural", 2)],
                1,
                0,
                false,
            ),
            (
                "door_slide_1m",
                "SLIDE DOOR",
                "openings",
                vec![("structural", 3), ("mechanical", 1)],
                1,
                0,
                true,
            ),
            (
                "window_1m",
                "WINDOW",
                "openings",
                vec![("structural", 2), ("glass", 1)],
                1,
                0,
                false,
            ),
            (
                "roof_1x1",
                "ROOF PANEL",
                "roofs",
                vec![("structural", 2)],
                1,
                1,
                false,
            ),
        ]
        .into_iter()
        .map(
            |(id, label, category, costs, w, h, is_door)| BuildCatalogItem {
                catalog_id: id.into(),
                label: label.into(),
                category: category.into(),
                costs: costs
                    .into_iter()
                    .map(|(material, units)| (material.into(), units))
                    .collect(),
                w,
                h,
                is_door,
            },
        )
        .collect();
        context.build_ghost = Some(BuildGhost {
            cell_x: player_cell.0.floor() as i64,
            cell_y: player_cell.1.floor() as i64,
            valid: true,
            ..BuildGhost::default()
        });

        if let Some(props) = self
            .slice
            .get("props")
            .and_then(successor_engine_core::json::Json::as_array)
        {
            for prop in props {
                if prop
                    .get("areaId")
                    .and_then(successor_engine_core::json::Json::as_str)
                    != Some(self.area_id.as_str())
                {
                    continue;
                }
                let Some(cell) = prop.get("cell") else {
                    continue;
                };
                let x = cell
                    .get("x")
                    .and_then(successor_engine_core::json::Json::as_f32)
                    .unwrap_or(f32::INFINITY);
                let y = cell
                    .get("y")
                    .and_then(successor_engine_core::json::Json::as_f32)
                    .unwrap_or(f32::INFINITY);
                let distance = ((x - player_cell.0).powi(2) + (y - player_cell.1).powi(2)).sqrt();
                let id = prop
                    .get("id")
                    .and_then(successor_engine_core::json::Json::as_str)
                    .unwrap_or("");
                let kind = prop
                    .get("kind")
                    .and_then(successor_engine_core::json::Json::as_str)
                    .unwrap_or("");
                if distance <= crate::windows::KIOSK_REACH_CELLS {
                    match kind {
                        kind if kind.contains("bank") => context.bank_gate = Gate::open(id),
                        kind if kind.contains("clone_terminal") => {
                            context.clone_gate = Gate::open(id)
                        }
                        kind if kind.contains("factory") => context.factory_gate = Gate::open(id),
                        kind if kind.contains("guild") || kind.contains("association") => {
                            context.guild_gate = Gate::open(id)
                        }
                        _ => {}
                    }
                }
                if distance <= crate::windows::TRAVEL_USE_RANGE_CELLS
                    && kind.contains("travel_terminal")
                {
                    context.travel_gate = Gate::open(id);
                }
            }
        }

        context.trainer = self
            .store
            .actors
            .iter()
            .filter(|(_, actor)| {
                actor.area_id == self.area_id
                    && actor
                        .role
                        .as_deref()
                        .is_some_and(|role| role.contains("trainer"))
            })
            .filter_map(|(id, actor)| {
                let distance =
                    ((actor.x - player_cell.0).powi(2) + (actor.y - player_cell.1).powi(2)).sqrt();
                let in_range = distance <= 2.5;
                (distance <= 16.0).then_some(TrainerView {
                    actor_id: id.clone(),
                    name: if actor.display_name.is_empty() {
                        actor.label.clone()
                    } else {
                        actor.display_name.clone()
                    },
                    profession_id: actor
                        .role
                        .as_deref()
                        .and_then(|role| role.strip_prefix("profession_trainer:"))
                        .unwrap_or("")
                        .to_string(),
                    in_range,
                })
            })
            .next();
        if context.trainer.is_some() {
            context.career_goals = [
                ("rifle_utility", "Rifle Utility"),
                ("ranged_specialist", "Ranged Specialist"),
                ("melee_specialist", "Melee Specialist"),
                ("rifle_quartermaster", "Rifle Quartermaster"),
            ]
            .into_iter()
            .map(|(id, label)| (id.to_string(), label.to_string()))
            .collect();
        }

        if let Some(planets) = self
            .slice
            .get("travelCatalog")
            .and_then(|catalog| catalog.get("planets"))
            .and_then(successor_engine_core::json::Json::as_array)
        {
            for planet in planets {
                let planet_id = planet
                    .get("id")
                    .and_then(successor_engine_core::json::Json::as_str)
                    .unwrap_or("")
                    .to_string();
                if planet
                    .get("areaId")
                    .and_then(successor_engine_core::json::Json::as_str)
                    == Some(self.area_id.as_str())
                {
                    context.planet_id = planet_id.clone();
                }
                let mut cities = Vec::new();
                if let Some(rows) = planet
                    .get("cities")
                    .and_then(successor_engine_core::json::Json::as_array)
                {
                    for city in rows {
                        let city_id = city
                            .get("id")
                            .and_then(successor_engine_core::json::Json::as_str)
                            .unwrap_or("")
                            .to_string();
                        let terminal = city
                            .get("terminalPropId")
                            .and_then(successor_engine_core::json::Json::as_str)
                            .unwrap_or("")
                            .to_string();
                        if context.travel_gate.prop_id.as_deref() == Some(terminal.as_str()) {
                            context.travel_origin = Some((planet_id.clone(), city_id.clone()));
                        }
                        cities.push(TravelCity {
                            id: city_id,
                            label: city
                                .get("label")
                                .and_then(successor_engine_core::json::Json::as_str)
                                .unwrap_or("")
                                .to_string(),
                            terminal_prop_id: terminal,
                            price: 0,
                        });
                    }
                }
                context.travel_planets.push(TravelPlanet {
                    id: planet_id,
                    label: planet
                        .get("label")
                        .and_then(successor_engine_core::json::Json::as_str)
                        .unwrap_or("")
                        .to_string(),
                    cities,
                });
            }
        }
        crate::windows::project::project(
            &self.store,
            &self.player_id,
            &context,
            &mut self.win_model,
        );
        // The host-owned identity and the inventory pane's thread-local
        // selection are one contract. A snapshot can remove or reserve the
        // picked stack between frames, so never leave the footer or radial
        // pointing at a row that is no longer live.
        let selected_inventory_is_live =
            self.selected_inventory
                .as_ref()
                .is_some_and(|(container, stack_id)| {
                    self.win_model
                        .inventory
                        .row(container, stack_id)
                        .is_some_and(|row| !row.in_exchange())
                });
        if selected_inventory_is_live {
            if let Some((container, stack_id)) = &self.selected_inventory {
                crate::windows::inventory::select_identity(container, stack_id);
            }
        } else {
            self.selected_inventory = None;
            crate::windows::inventory::clear_selection();
            if matches!(self.context_menu, Some(ContextMenu::InventoryRadial { .. })) {
                self.context_menu = None;
            }
        }
        self.hud_state.project(
            &self.store,
            &self.player_id,
            self.selected_actor_id.as_deref(),
        );
        self.hud_state.world_seed = effective_world_seed(&self.slice, &self.area_id) as i32;
        self.hud_state.biome = biome_for_area(&self.slice, &self.area_id);
        if let Some(weapon) = &self.win_model.character.player.weapon {
            let melee = weapon.ammo_type == "melee";
            let reloading = weapon.reload_remaining_ticks > 0;
            let recovery_frac = if reloading && weapon.reload_total_ticks > 0 {
                1.0 - (weapon.reload_remaining_ticks as f32 / weapon.reload_total_ticks as f32)
                    .clamp(0.0, 1.0)
            } else {
                1.0
            };
            self.hud_state.weapon = Some(hud::WeaponHud {
                label: weapon.weapon_id.replace(['_', '-'], " ").to_uppercase(),
                melee,
                magazine_size: weapon.magazine_size.max(0) as u32,
                loaded_rounds: weapon.loaded_rounds.max(0) as u32,
                rounds_text: if melee {
                    if reloading {
                        "RECOVERING...".into()
                    } else {
                        "READY".into()
                    }
                } else if reloading {
                    "REARMING...".into()
                } else {
                    format!(
                        "{}/{}",
                        weapon.loaded_rounds.max(0),
                        weapon.magazine_size.max(0)
                    )
                },
                reloading,
                reload_frac: recovery_frac,
                swing_ready: !reloading,
                swing_frac: recovery_frac,
            });
        }
        self.hud_state.group_members = self
            .win_model
            .group
            .group
            .members
            .iter()
            .filter(|member| member.actor_id != self.player_id)
            .take(hud::GROUP_CHIP_MAX)
            .map(|member| hud::GroupMemberHud {
                actor_id: member.actor_id.clone(),
                name: member.name.to_uppercase(),
                leader: member.is_leader,
                health_frac: if member.max_vitals.health > 0.0 {
                    member.vitals.health / member.max_vitals.health
                } else {
                    0.0
                },
                down: member.life_state != "alive",
                link_dead: member.link_dead,
            })
            .collect();
        self.hud_state.group_invite_from = self
            .win_model
            .group
            .group
            .pending_invite
            .as_ref()
            .map(|invite| invite.inviter_name.to_uppercase());
        self.hud_state.sampler_text =
            (self.win_model.survey.sample_cooldown_ticks > 0).then(|| {
                format!(
                    "AUTO-SAMPLE / {} TICKS",
                    self.win_model.survey.sample_cooldown_ticks
                )
            });
        self.hud_state.sheltered = self
            .win_model
            .survey
            .camps
            .iter()
            .any(|camp| camp.in_footprint);
        self.hud_state.camp_countdown = self
            .win_model
            .survey
            .camps
            .iter()
            .find_map(|camp| camp.vm.abandon_seconds_remaining)
            .map(|seconds| format!("CAMP COLLAPSE / {:02}:{:02}", seconds / 60, seconds % 60));
        self.hud_state.extraction_toast = self
            .win_model
            .survey
            .extractors
            .iter()
            .find(|extractor| extractor.vm.collectable_units > 0)
            .map(|extractor| hud::BannerHud {
                text: format!(
                    "{} / {} READY",
                    extractor.vm.family_label.to_uppercase(),
                    extractor.vm.collectable_units
                ),
                bad: false,
                until_ms: successor_platform::now_ms() as u64 + 2_000,
            });
        // A refused command is the only feedback the player gets that the
        // press did something. The reason code is rendered as-is rather than
        // through a lookup table: the authority owns 156 of them and any table
        // here would silently go stale as it adds more.
        if let Some(rejection) = self.store.command_rejection.take() {
            let reason = rejection
                .get("reasonCode")
                .and_then(|v| v.as_str())
                .unwrap_or("refused");
            let mut text = String::with_capacity(reason.len() + 8);
            for ch in reason.chars() {
                text.push(if ch == '_' { ' ' } else { ch.to_ascii_uppercase() });
            }
            self.hud_state.banner = Some(hud::BannerHud {
                text,
                bad: true,
                until_ms: successor_platform::now_ms() as u64 + 3_000,
            });
        }
        let dialogue_floor = self.last_dialogue_tick;
        let mut received_dialogue = false;
        for delivery in self
            .win_model
            .converse
            .deliveries
            .iter()
            .filter(|delivery| delivery.tick > dialogue_floor)
        {
            self.overlays
                .push_bubble(&delivery.actor_id, &delivery.body);
            received_dialogue = true;
            self.last_dialogue_tick = self.last_dialogue_tick.max(delivery.tick);
        }
        if received_dialogue && self.win_model.converse.npc.is_some() {
            self.open_workspace_window("converse");
        }
        self.hud_state.interact = if let Some(prop) = self.nearest_interaction_prop() {
            Some(hud::InteractHud {
                label: format!("[F] {}", prop.label.to_uppercase()),
                hold_frac: None,
            })
        } else if let Some(actor_id) = self.selected_actor_id.as_deref() {
            self.store.actors.get(actor_id).and_then(|actor| {
                let player = self.store.actors.get(&self.player_id)?;
                (((actor.x - player.x).powi(2) + (actor.y - player.y).powi(2)).sqrt() <= 2.5).then(
                    || hud::InteractHud {
                        label: "[F] INTERACT".into(),
                        hold_frac: None,
                    },
                )
            })
        } else {
            None
        };
        self.win_model.waypoints = self.waypoints.waypoints().to_vec();
        if let Some((px, py)) = self.hud_state.position {
            self.hud_state.radar_waypoints = self
                .waypoints
                .active_in_area(&self.area_id)
                .map(|waypoint| hud::RadarWaypointHud {
                    id: waypoint.id,
                    dx_cells: waypoint.x - px,
                    dy_cells: waypoint.y - py,
                })
                .collect();
        }
        self.win_model.macros = self.macro_runtime.macros().to_vec();
        crate::windows::set_options_model(crate::windows::options::OptionsModel {
            theme_index: self.theme_index,
            dust_strength: self.dust_strength,
            window_opacity: self.window_opacity,
            hud_opacity: self.hud_opacity,
            zoom_percent: self.zoom_percent.round() as u16,
            split_snap: self.split_snap,
            toolbar_binds: self.toolbar.doc.binds.clone(),
            rebind_pending: self.rebind_pending,
            binding_reference: vec![
                ("MOVE".into(), "W A S D".into()),
                ("SPRINT".into(), "SHIFT / X".into()),
                ("INTERACT".into(), "F".into()),
                ("TARGET".into(), "POINTER / RADAR".into()),
                ("RELOAD".into(), "R".into()),
                ("PRIMARY ATTACK".into(), "SPACE".into()),
            ],
        });
        if let Some(result) = self.store.bug_report_result.as_ref() {
            crate::windows::apply_bug_report_result(result);
        }
    }
    pub fn on_player_pos(&mut self, x: f32, y: f32) {
        self.store.apply_player_position(x, y);
    }
    pub fn last_applied_move_command_id(&self) -> u64 {
        self.last_applied_move_command_id
    }
    pub fn movement_diagnostics(&self) -> Option<MovementDiagnostics> {
        let pawn = self.pawns.get(&self.player_id)?;
        let authoritative = pawn.predictor.authoritative();
        let predicted = pawn.predictor.render_pos();
        let correction_cells = ((predicted.0 - authoritative.0).powi(2)
            + (predicted.1 - authoritative.1).powi(2))
        .sqrt();
        let wx = (pawn.render_pos.0 + 0.5) * WORLD_UNITS_PER_CELL;
        let wz = (pawn.render_pos.1 + 0.5) * WORLD_UNITS_PER_CELL;
        Some(MovementDiagnostics {
            authoritative,
            predicted,
            rendered: pawn.render_pos,
            correction_cells,
            intent: self.move_intent,
            applied_command_id: self.last_applied_move_command_id,
            blocker_count: self.movement_collision.blocker_count(),
            presented_ground_y: pawn.ground_y,
            sampled_ground_y: self.ground_height_at(wx, wz),
            frame_dt_ms: self.last_frame_dt * 1_000.0,
            last_change_ms: self.movement_timing.last_change_ms,
            last_send_ms: self.movement_timing.last_send_ms,
            next_send_ms: self.movement_timing.next_send_ms,
            sampled_at_ms: self.movement_sampled_at_ms,
        })
    }
    pub fn handle_tuning_toggle(&mut self, down: bool) -> bool {
        self.graphics_tuner.handle_toggle(down)
    }

    pub fn tuning_open(&self) -> bool {
        self.graphics_tuner.is_open()
    }
    pub fn combat_fx_mut(&mut self) -> &mut CombatFx {
        &mut self.combat_fx
    }
    pub fn ingest_chat_message(&mut self, message: &ChatMessage) {
        // Own speech ticks on send, everyone else's on receipt — the web
        // client's two chat cues.
        if message.sender_id == self.store.player_actor_id {
            crate::audio::play_ui(&mut self.sfx, crate::audio::UiCue::ChatSend);
        } else {
            crate::audio::play_ui(&mut self.sfx, crate::audio::UiCue::ChatReceive);
        }
        if let Some((actor_id, body)) = spatial_chat_payload(message) {
            self.overlays.push_bubble(actor_id, body);
        }
    }
    #[allow(clippy::too_many_arguments)]
    pub fn load_persisted(
        &mut self,
        theme: Option<&serde_json::Value>,
        toolbar: Option<&serde_json::Value>,
        split_snap: Option<&serde_json::Value>,
        waypoints: Option<&serde_json::Value>,
        macros: Option<&serde_json::Value>,
        window_layout: Option<&serde_json::Value>,
        ui_opacity: Option<&serde_json::Value>,
    ) {
        if let Some(id) = theme.and_then(serde_json::Value::as_str) {
            if let Some(index) = hud::THEME_IDS.iter().position(|candidate| *candidate == id) {
                self.theme_index = index;
            }
        }
        self.toolbar = hud::toolbar::Toolbar::new(hud::toolbar::ToolbarDoc::load(toolbar));
        self.split_snap = split_snap
            .and_then(serde_json::Value::as_u64)
            .map(|value| value as u32)
            .filter(|value| crate::windows::options::SPLIT_SNAP_STEPS.contains(value))
            .unwrap_or(100);
        self.waypoints = hud::waypoints::WaypointStore::load(waypoints);
        self.macro_runtime = crate::game::macro_runtime::MacroRuntime::load(macros);
        // A corrupt or out-of-band opacity resets to its default rather than
        // clamping: a near-zero value would read as a broken client.
        let opacity = |key: &str, default: f32| {
            ui_opacity
                .and_then(|doc| doc.get(key))
                .and_then(serde_json::Value::as_f64)
                .map(|value| value as f32)
                .filter(|value| {
                    value.is_finite() && (hud::MIN_UI_OPACITY..=hud::MAX_UI_OPACITY).contains(value)
                })
                .unwrap_or(default)
        };
        self.window_opacity = opacity("window", 0.92);
        self.hud_opacity = opacity("hud", 0.90);
        self.hud_layout_viewport = layout_viewport(window_layout);
        self.hud_defaults_pending = restore_window_layout(&mut self.wm, window_layout);
        self.window_layout_dirty = false;
        self.preferences_dirty = false;
        self.project_windows();
    }

    /// Live framebuffer as layout floats: the space every window rect is
    /// measured in, and the stamp a saved layout is matched against.
    fn viewport_size(&self) -> (f32, f32) {
        (self.framebuffer.0 as f32, self.framebuffer.1 as f32)
    }

    pub fn take_persisted(&mut self) -> PersistedSections {
        let local = self.preferences_dirty;
        self.preferences_dirty = false;
        let waypoint = self.waypoints.dirty();
        let macros = self.macro_runtime.dirty();
        let window_layout =
            self.wm.take_geometry_dirty() || core::mem::take(&mut self.window_layout_dirty);
        let result = (
            local.then(|| serde_json::Value::String(hud::THEME_IDS[self.theme_index].into())),
            local.then(|| self.toolbar.doc.save()),
            local.then(|| serde_json::Value::from(self.split_snap)),
            waypoint.then(|| self.waypoints.save()),
            macros.then(|| self.macro_runtime.save()),
            window_layout.then(|| save_window_layout(&self.wm, self.viewport_size())),
            local.then(|| {
                serde_json::json!({
                    "window": self.window_opacity,
                    "hud": self.hud_opacity,
                })
            }),
        );
        if waypoint {
            self.waypoints.mark_saved();
        }
        if macros {
            self.macro_runtime.mark_saved();
        }
        result
    }
    pub fn take_bug_report(&mut self) -> Option<serde_json::Value> {
        self.pending_bug_report.take()
    }
    /// Workspace visibility/focus is part of the persisted layout, not a
    /// transient UI preference.
    fn open_workspace_window(&mut self, id: &str) {
        if !self.wm.is_open(id) {
            crate::audio::play_ui(&mut self.sfx, crate::audio::UiCue::PanelOpen);
        }
        self.wm.open(id);
        self.window_layout_dirty = true;
    }

    fn toggle_workspace_window(&mut self, id: &str) {
        let cue = if self.wm.is_open(id) {
            crate::audio::UiCue::PanelClose
        } else {
            crate::audio::UiCue::PanelOpen
        };
        crate::audio::play_ui(&mut self.sfx, cue);
        self.wm.toggle(id);
        self.window_layout_dirty = true;
    }

    /// Install the authenticated session queue. Until installed, command
    /// intents are rejected visibly rather than assigned a synthetic identity.
    pub fn pointer_captured(&self) -> bool {
        self.graphics_tuner.is_open()
            || self.wm.pointer_captured()
            || self.context_menu.is_some()
            || self.hud_layout_input_consumed
    }
    pub fn set_command_queue(&mut self, queue: CommandQueue) {
        self.command_queue = Some(queue);
        self.project_windows();
    }

    /// Restore renderer-neutral connected state after the browser recreates a
    /// lost WebGL context. GPU resources come from `Self::build`; authority,
    /// input, and workspace state survive without reconnecting or replaying launch tickets.
    pub fn restore_projection_from(&mut self, previous: &Self) {
        self.store = previous.store.clone();
        self.command_queue = previous.command_queue.clone();
        self.pending_window_commands = previous.pending_window_commands.clone();
        self.window_rejection = previous.window_rejection.clone();
        self.selected_actor_id = previous.selected_actor_id.clone();
        self.selected_inventory = previous.selected_inventory.clone();
        self.last_dialogue_tick = previous.last_dialogue_tick;
        self.last_applied_move_command_id = previous.last_applied_move_command_id;
        self.framebuffer = previous.framebuffer;
        self.wm.restore_workspace_state_from(&previous.wm);
        self.hud_defaults_pending = previous.hud_defaults_pending;
        self.hud_layout_viewport = previous.hud_layout_viewport;
        self.window_layout_dirty = previous.window_layout_dirty;
        if let Some((container, stack_id)) = &self.selected_inventory {
            crate::windows::inventory::select_identity(container, stack_id);
        } else {
            crate::windows::inventory::clear_selection();
        }
        self.loot_corpse_id = previous.loot_corpse_id.clone();
        self.zoom_percent = previous.zoom_percent;
        self.sprint_toggle = previous.sprint_toggle;
        self.collision_debug
            .set_enabled(&mut self.world, previous.collision_debug.enabled());
        self.theme_index = previous.theme_index;
        self.dust_strength = previous.dust_strength;
        self.window_opacity = previous.window_opacity;
        self.hud_opacity = previous.hud_opacity;
        self.split_snap = previous.split_snap;
        self.shard_id.clone_from(&previous.shard_id);
        self.area_id.clone_from(&previous.area_id);
        self.move_intent = previous.move_intent;
        self.weather_audio = previous.weather_audio;
        self.music_audio = previous.music_audio;
        self.music_combat_index = previous.music_combat_index;
        self.music_was_in_combat = previous.music_was_in_combat;
        self.settlement_audio = previous.settlement_audio;
        self.loading = previous.loading;
        self.footstep_distance = previous.footstep_distance;
        self.footstep_index = previous.footstep_index;
        self.footstep_position = previous.footstep_position;
        self.ambience_timer = previous.ambience_timer;
        self.ambience_roll = previous.ambience_roll;
        self.project_windows();
    }

    pub fn pending_window_commands(&self) -> &[u64] {
        &self.pending_window_commands
    }

    pub fn window_rejection(&self) -> Option<&str> {
        self.window_rejection.as_deref()
    }

    pub fn open_window_ids(&self) -> Vec<String> {
        self.wm
            .z_order()
            .into_iter()
            .map(|index| self.wm.window_id(index).to_owned())
            .collect()
    }

    /// The looking player's guild/faction id, used to tell an allied player
    /// from a merely neutral one. `None` when unaffiliated, which makes every
    /// other player neutral rather than guessing at standing.
    fn viewer_org(&self) -> Option<&str> {
        self.store
            .actors
            .get(&self.store.player_actor_id)
            .or_else(|| self.store.actors.get(&self.player_id))
            .and_then(|actor| actor.player_organization_id.as_deref())
            .filter(|org| !org.is_empty())
    }

    pub fn focused_window_id(&self) -> Option<String> {
        self.wm
            .z_order()
            .last()
            .map(|index| self.wm.window_id(*index).to_owned())
    }

    /// Apply a developer inspection intent from the control protocol.
    ///
    /// Routed through the same entry points the player's own action uses, so a
    /// captured pane is the pane the player would see — not a special
    /// inspection rendering. Returns false only for an unregistered window id.
    #[cfg(not(target_arch = "wasm32"))]
    pub fn apply_control_ui_intent(&mut self, intent: &successor_platform::ControlUiIntent) -> bool {
        match intent {
            successor_platform::ControlUiIntent::Window { id, open } => {
                if self.wm.rect(id).is_none() {
                    return false;
                }
                match open {
                    Some(true) => self.open_workspace_window(id),
                    Some(false) => {
                        self.wm.close(id);
                        self.window_layout_dirty = true;
                    }
                    None => self.toggle_workspace_window(id),
                }
                true
            }
            successor_platform::ControlUiIntent::Theme(index) => {
                self.theme_index = index % hud::THEME_COUNT;
                self.preferences_dirty = true;
                self.project_windows();
                true
            }
            successor_platform::ControlUiIntent::Opacity { hud: is_hud, value } => {
                let value = value.clamp(hud::MIN_UI_OPACITY, hud::MAX_UI_OPACITY);
                if *is_hud {
                    self.hud_opacity = value;
                } else {
                    self.window_opacity = value;
                }
                self.preferences_dirty = true;
                self.project_windows();
                true
            }
        }
    }

    /// Every registered frame with its live geometry, for the control
    /// protocol. Development-only inspection: a UI journey asserts move,
    /// resize, and layout persistence against these numbers rather than
    /// against pixels.
    #[cfg(not(target_arch = "wasm32"))]
    pub fn window_frames(&self) -> Vec<successor_platform::ControlWindowFrame> {
        let mut frames = Vec::new();
        self.wm.for_each_geometry(|id, rect| {
            frames.push(successor_platform::ControlWindowFrame {
                id: id.to_owned(),
                rect,
                open: self.wm.is_open(id),
                iconified: self.wm.is_iconified(id),
                interactive: self.wm.is_interactive(id),
            });
        });
        frames
    }

    /// View-projection the last drawn frame used, or `None` before the first
    /// sized frame. Pointer picking and pointer-shape resolution both read it
    /// so a click resolves against the image the player actually saw, and so
    /// neither path needs `&mut` access to the ECS.
    fn viewport_projection(&self) -> Option<Mat4> {
        self.pointer_vp
    }

    /// Screen position of a world cell centre.
    fn cell_to_screen(&self, vp: &Mat4, cell_x: f32, cell_y: f32, height_bias: f32) -> (f32, f32) {
        let wx = (cell_x + 0.5) * WORLD_UNITS_PER_CELL;
        let wz = (cell_y + 0.5) * WORLD_UNITS_PER_CELL;
        let ndc = vp.project_point(vec3(wx, self.terrain.height_at(wx, wz) + height_bias, wz));
        (
            (ndc.x * 0.5 + 0.5) * self.framebuffer.0 as f32,
            (0.5 - ndc.y * 0.5) * self.framebuffer.1 as f32,
        )
    }

    /// Nearest streamed actor whose projected torso is inside the pick radius.
    /// Borrowed, not cloned: the pointer shape resolves this every frame and
    /// the frame loop must not allocate.
    fn actor_id_at_pointer(&self, x: f32, y: f32) -> Option<&str> {
        let vp = self.viewport_projection()?;
        self.store
            .actors
            .iter()
            .filter(|(id, actor)| {
                id.as_str() != self.store.player_actor_id
                    && actor.area_id == self.area_id
                    && actor.life_state != "respawning"
            })
            .filter_map(|(id, actor)| {
                let (sx, sy) = self.cell_to_screen(&vp, actor.x, actor.y, 0.9);
                let d2 = (sx - x) * (sx - x) + (sy - y) * (sy - y);
                (d2 <= ACTOR_PICK_RADIUS_PX * ACTOR_PICK_RADIUS_PX).then_some((id.as_str(), d2))
            })
            .min_by(|left, right| left.1.total_cmp(&right.1))
            .map(|(id, _)| id)
    }

    /// Pointer shape for this frame, resolved the way the original resolves a
    /// cursor: the mediator under the pointer wins, and only when nothing owns
    /// the pointer does the world get to speak.
    fn pointer_cursor(&self, x: f32, y: f32) -> CursorKind {
        if let Some(hint) = self.wm.cursor_hint(x, y) {
            return hint;
        }
        if self.graphics_tuner.is_open() || self.context_menu.is_some() || self.wm.covers(x, y) {
            return CursorKind::Arrow;
        }
        if self.hud_state.life != hud::LifeHud::Alive {
            return CursorKind::Arrow;
        }
        if let Some(actor_id) = self.actor_id_at_pointer(x, y) {
            let hostile = self
                .store
                .actors
                .get(actor_id)
                .map(|actor| hud::relation_for(actor, &self.player_id, self.viewer_org()))
                .is_some_and(|relation| {
                    matches!(
                        relation,
                        hud::RelationHud::Hostile | hud::RelationHud::Attackable
                    )
                });
            // Attack only reads as a promise while something is wielded; the
            // authority refuses the swing otherwise.
            return if hostile && self.hud_state.weapon.is_some() {
                CursorKind::Attack
            } else {
                CursorKind::Select
            };
        }
        // Proximity alone is not a pointer verb: the prop also has to be under
        // the pointer, or every door in reach would claim the cursor.
        if let (Some(vp), Some(prop)) = (self.viewport_projection(), self.nearest_interaction_prop())
        {
            let (sx, sy) = self.cell_to_screen(&vp, prop.x, prop.y, 1.45);
            let d2 = (sx - x) * (sx - x) + (sy - y) * (sy - y);
            if d2 <= PROP_PICK_RADIUS_PX * PROP_PICK_RADIUS_PX {
                return CursorKind::Interact;
            }
        }
        CursorKind::Arrow
    }

    pub fn pending_command_kinds(&self) -> Vec<String> {
        self.command_queue
            .as_ref()
            .map(|queue| {
                queue
                    .pending_envelopes()
                    .map(|envelope| crate::game::command_queue::command_kind(&envelope.command))
                    .collect()
            })
            .unwrap_or_default()
    }

    pub fn dispatch_window_action(&mut self, action: crate::windows::WindowAction) {
        let Some(queue) = self.command_queue.as_mut() else {
            self.window_rejection = Some("not authenticated".into());
            crate::audio::play_ui(&mut self.sfx, crate::audio::UiCue::Deny);
            return;
        };
        match actions::enqueue_window_action(queue, action, self.store.tick) {
            DispatchOutcome::Queued(id) => self.pending_window_commands.push(id),
            DispatchOutcome::Rejected(reason) => {
                self.window_rejection = Some(reason);
                crate::audio::play_ui(&mut self.sfx, crate::audio::UiCue::Deny);
            }
            DispatchOutcome::Local(local) => self.apply_local_window_action(local),
        }
    }

    /// Queue a gameplay action. Authority-owned state changes only after a receipt.
    pub fn dispatch_gameplay_action(&mut self, action: actions::GameplayAction) -> Option<u64> {
        let queue = self.command_queue.as_mut()?;
        actions::enqueue_action(queue, action, self.store.tick)
    }

    /// Apply the only intents emitted by the authority-backed radar renderer.
    fn dispatch_radar_hud_action(&mut self, action: hud::HudAction) {
        match action {
            hud::HudAction::RadarSelect(actor_id) => {
                self.selected_actor_id = Some(actor_id);
                self.selected_inventory = None;
                crate::windows::inventory::clear_selection();
                self.project_windows();
            }
            hud::HudAction::RadarMove { dx_cells, dy_cells } => {
                let dx = dx_cells.signum() as i32;
                let dy = dy_cells.signum() as i32;
                self.dispatch_gameplay_action(actions::GameplayAction::Move {
                    dx,
                    dy,
                    facing: movement::facing_from_intent(dx, dy),
                    sprint: self.sprint_toggle,
                });
            }
            _ => unreachable!("radar renderer emits only radar actions"),
        }
    }

    pub fn selected_actor_id(&self) -> Option<&str> {
        self.selected_actor_id.as_deref()
    }

    #[cfg(not(target_arch = "wasm32"))]
    pub fn audio_mixer(
        &self,
    ) -> std::sync::Arc<std::sync::Mutex<successor_engine_core::audio::Mixer>> {
        self.sfx.shared_mixer()
    }

    /// Take the next authenticated command for transmission.
    pub fn take_next_command(&mut self) -> Option<successor_net::ClientCommandEnvelope> {
        self.command_queue
            .as_mut()
            .and_then(CommandQueue::take_next)
    }

    /// Requeue an in-flight command after a lost connection.
    pub fn reconcile_commands(&mut self) {
        if let Some(queue) = self.command_queue.as_mut() {
            queue.reconcile_reconnect();
        }
    }

    /// Release all movement state and enqueue an authoritative stop intent.
    pub fn release_movement(&mut self, _reason: movement::StopReason) -> Option<u64> {
        self.dispatch_gameplay_action(actions::GameplayAction::Stop)
    }
    pub fn set_movement_timing(&mut self, timing: movement::MovementTiming, sampled_at_ms: u64) {
        self.movement_timing = timing;
        self.movement_sampled_at_ms = sampled_at_ms;
    }

    /// Feed the held authority movement intent into local prediction.
    pub fn set_move_intent(&mut self, dx: i32, dy: i32, sprint: bool) {
        self.move_intent = (dx, dy, sprint);
    }
    /// Resolve the current click route against streamed authority position.
    /// Manual movement always wins and cancels navigation.
    pub fn navigation_intent(&mut self, manual_dx: i32, manual_dy: i32) -> (i32, i32) {
        if manual_dx != 0 || manual_dy != 0 {
            self.click_route.clear();
            self.click_route_index = 0;
            self.click_goal = None;
            self.streamed_world.set_waypoint(None);
            return (manual_dx, manual_dy);
        }
        let Some(player) = self.store.actors.get(&self.store.player_actor_id) else {
            return (0, 0);
        };
        if let (Some(goal), Some(next)) = (
            self.click_goal,
            self.click_route.get(self.click_route_index).copied(),
        ) {
            let next_blocked = !self
                .movement_collision
                .anchor_clear(next.0 as f32 + 0.5, next.1 as f32 + 0.5);
            if next_blocked {
                let start = (player.x.floor() as i32, player.y.floor() as i32);
                self.click_route = movement::route_grid(start, goal, |x, y| {
                    !self
                        .movement_collision
                        .anchor_clear(x as f32 + 0.5, y as f32 + 0.5)
                })
                .unwrap_or_default();
                self.click_route_index = 0;
            }
        }
        while let Some(&(x, y)) = self.click_route.get(self.click_route_index) {
            let dx = x as f32 + 0.5 - player.x;
            let dy = y as f32 + 0.5 - player.y;
            if dx * dx + dy * dy <= 0.35 * 0.35 {
                self.click_route_index += 1;
                continue;
            }
            return (
                if dx.abs() < 0.2 {
                    0
                } else {
                    dx.signum() as i32
                },
                if dy.abs() < 0.2 {
                    0
                } else {
                    dy.signum() as i32
                },
            );
        }
        self.click_route.clear();
        self.click_route_index = 0;
        self.click_goal = None;
        self.streamed_world.set_waypoint(None);
        (0, 0)
    }
    fn interaction_window_for_kind(kind: &str) -> Option<&'static str> {
        if kind.contains("bank") {
            Some("bank")
        } else if kind.contains("clone") {
            Some("clone")
        } else if kind.contains("factory") {
            Some("craft")
        } else if kind.contains("trade") {
            Some("trade")
        } else if kind.contains("travel") {
            Some("travel")
        } else if kind.contains("guild") || kind.contains("association") {
            Some("pa")
        } else {
            None
        }
    }

    fn nearest_interaction_prop(&self) -> Option<InteractionProp<'_>> {
        let player = self.store.actors.get(&self.player_id)?;
        self.slice
            .get("props")
            .and_then(successor_engine_core::json::Json::as_array)?
            .iter()
            .filter(|prop| {
                prop.get("areaId")
                    .and_then(successor_engine_core::json::Json::as_str)
                    == Some(self.area_id.as_str())
            })
            .filter_map(|prop| {
                let cell = prop.get("cell")?;
                let cell_x = cell
                    .get("x")
                    .and_then(successor_engine_core::json::Json::as_f32)?;
                let cell_y = cell
                    .get("y")
                    .and_then(successor_engine_core::json::Json::as_f32)?;
                let id = prop
                    .get("id")
                    .and_then(successor_engine_core::json::Json::as_str)?;
                let authored_kind = prop
                    .get("kind")
                    .and_then(successor_engine_core::json::Json::as_str)?;
                let label = prop
                    .get("label")
                    .and_then(successor_engine_core::json::Json::as_str)
                    .unwrap_or(authored_kind);
                let (kind, target_x, target_y, radius) = if let Some(door) = prop.get("door") {
                    let blocker = door.get("blocker")?;
                    let x_milli = blocker.get("xMilli")?.as_f32()?;
                    let y_milli = blocker.get("yMilli")?.as_f32()?;
                    let w_milli = blocker.get("wMilli")?.as_f32()?;
                    let h_milli = blocker.get("hMilli")?.as_f32()?;
                    (
                        "door",
                        cell_x + (x_milli + w_milli * 0.5) / 1_000.0,
                        cell_y + (y_milli + h_milli * 0.5) / 1_000.0,
                        door.get("interactRadiusCells")
                            .and_then(successor_engine_core::json::Json::as_f32)
                            .unwrap_or(2.5),
                    )
                } else {
                    (authored_kind, cell_x, cell_y, 2.5)
                };
                if kind != "door" && Self::interaction_window_for_kind(kind).is_none() {
                    return None;
                }
                let distance =
                    ((target_x - player.x).powi(2) + (target_y - player.y).powi(2)).sqrt();
                (distance <= radius).then_some((
                    InteractionProp {
                        id,
                        kind,
                        label,
                        x: target_x,
                        y: target_y,
                    },
                    distance,
                ))
            })
            .min_by(|left, right| left.1.total_cmp(&right.1))
            .map(|(prop, _)| prop)
    }

    /// Return the exact held stack under an open inventory card, together with
    /// the card centre used as the radial anchor. This follows the inventory
    /// renderer's pagination and card geometry rather than guessing from an
    /// item id (which can be shared by multiple stacks).
    fn inventory_item_at(&self, x: f32, y: f32) -> Option<(String, String, (f32, f32))> {
        if !self.wm.is_open("inventory") {
            return None;
        }
        let content = self.wm.content_rect("inventory")?;
        let held_count = self.win_model.inventory.held().count();
        let (visible_start, visible_end) =
            crate::windows::inventory::visible_held_range(content, held_count);
        self.win_model
            .inventory
            .held()
            .skip(visible_start)
            .take(visible_end - visible_start)
            .enumerate()
            .find_map(|(index, row)| {
                let [card_x, card_y, card_w, card_h] =
                    crate::windows::inventory::grid_card_rect(content, index)?;
                successor_engine_render::ui::UiBuilder::hit(card_x, card_y, card_w, card_h, x, y)
                    .then(|| {
                        (
                            row.container.clone(),
                            row.stack_id.clone(),
                            (card_x + card_w * 0.5, card_y + card_h * 0.5),
                        )
                    })
            })
    }

    /// Handle edge-triggered connected bindings. Window actions stay local;
    fn key_code(key: Key) -> &'static str {
        match key {
            Key::W => "KeyW",
            Key::A => "KeyA",
            Key::S => "KeyS",
            Key::D => "KeyD",
            Key::R => "KeyR",
            Key::F => "KeyF",
            Key::I => "KeyI",
            Key::C => "KeyC",
            Key::O => "KeyO",
            Key::V => "KeyV",
            Key::X => "KeyX",
            Key::N => "KeyN",
            Key::P => "KeyP",
            Key::K => "KeyK",
            Key::B => "KeyB",
            Key::M => "KeyM",
            Key::G => "KeyG",
            Key::Digit0 => "Digit0",
            Key::Digit1 => "Digit1",
            Key::Digit2 => "Digit2",
            Key::Digit3 => "Digit3",
            Key::Digit4 => "Digit4",
            Key::Digit5 => "Digit5",
            Key::Digit6 => "Digit6",
            Key::Digit7 => "Digit7",
            Key::Digit8 => "Digit8",
            Key::Digit9 => "Digit9",
            Key::Space => "Space",
            Key::Enter => "Enter",
            Key::Escape => "Escape",
            Key::Backspace => "Backspace",
            Key::LeftShift => "ShiftLeft",
            Key::Backquote => "Backquote",
            Key::Semicolon => "Semicolon",
            Key::Tab => "Tab",
            Key::Up => "ArrowUp",
            Key::Down => "ArrowDown",
            Key::Left => "ArrowLeft",
            Key::Right => "ArrowRight",
        }
    }

    fn permanent_window_for_key(key: Key) -> Option<&'static str> {
        hud::window_for_code(Self::key_code(key))
    }

    fn collision_debug_chord(key: Key, shift: bool) -> bool {
        key == Key::C && shift
    }

    /// gameplay verbs are returned for the host to enqueue through the queue.
    pub fn handle_key(
        &mut self,
        key: Key,
        down: bool,
        shift: bool,
    ) -> Option<actions::GameplayAction> {
        let index = key as usize;
        let pressed = down && !self.key_was_down[index];
        self.key_was_down[index] = down;
        if !pressed {
            return None;
        }
        if Self::collision_debug_chord(key, shift) {
            self.collision_debug.toggle(&mut self.world);
            return None;
        }
        // Shift+V frees the camera; the arrows then orbit it and Shift+arrow
        // dollies. Arrows keep driving the player while it is off, so the
        // inspection controls never sit on top of a gameplay binding.
        if key == Key::V && shift {
            self.debug_camera = match self.debug_camera {
                Some(_) => None,
                None => Some(DebugCamera::default()),
            };
            return None;
        }
        if let Some(orbit) = self.debug_camera.as_mut() {
            const STEP: f32 = 0.12;
            match (key, shift) {
                (Key::Left, false) => orbit.orbit(-STEP, 0.0),
                (Key::Right, false) => orbit.orbit(STEP, 0.0),
                (Key::Up, false) => orbit.orbit(0.0, STEP),
                (Key::Down, false) => orbit.orbit(0.0, -STEP),
                (Key::Up, true) => orbit.dolly(0.85),
                (Key::Down, true) => orbit.dolly(1.18),
                _ => return None,
            }
            return None;
        }
        if key == Key::Escape {
            if dismiss_context_or_focused(
                &mut self.context_menu,
                &mut self.graphics_tuner,
                &mut self.wm,
            ) {
                crate::audio::play_ui(&mut self.sfx, crate::audio::UiCue::PanelClose);
                self.window_layout_dirty = true;
            }
            return None;
        }
        if let Some(window) = Self::permanent_window_for_key(key) {
            crate::audio::play_ui(&mut self.sfx, crate::audio::UiCue::ButtonTick);
            self.toggle_workspace_window(window);
            return None;
        }
        let code = Self::key_code(key);
        if let Some(slot) = self.rebind_pending.take() {
            if slot < self.toolbar.doc.binds.len() {
                self.toolbar.doc.binds[slot] = code.into();
                self.preferences_dirty = true;
            }
            self.project_windows();
            return None;
        }
        // A bound slot owns its key even when it cannot fire; the ineligible
        // cue is the feedback that says why nothing happened.
        match self.toolbar.press_code_result(code, &mut self.hud_actions) {
            hud::toolbar::PressResult::Used => {
                crate::audio::play_ui(&mut self.sfx, crate::audio::UiCue::ToolbarUse);
                return None;
            }
            hud::toolbar::PressResult::Ineligible => {
                crate::audio::play_ui(&mut self.sfx, crate::audio::UiCue::ToolbarIneligible);
                return None;
            }
            hud::toolbar::PressResult::Passthrough => {}
        }
        crate::audio::play_ui(&mut self.sfx, crate::audio::UiCue::ButtonTick);
        match key {
            Key::X => self.sprint_toggle = !self.sprint_toggle,
            Key::R => {
                return Some(actions::GameplayAction::Reload {
                    weapon_id: None,
                    ammo_type: None,
                })
            }
            Key::Space => return self.shot_action("basic_shot"),
            Key::Tab => {
                self.cycle_target();
                return None;
            }
            Key::F => {
                if let Some(prop) = self.nearest_interaction_prop() {
                    if prop.kind.contains("door") {
                        return Some(actions::GameplayAction::ToggleDoor {
                            prop_id: prop.id.to_string(),
                        });
                    }
                    if let Some(window) = Self::interaction_window_for_kind(prop.kind) {
                        self.project_windows();
                        self.open_workspace_window(window);
                        return None;
                    }
                }
                let corpse_id = self
                    .store
                    .actors
                    .get(&self.player_id)
                    .and_then(|player| {
                        nearest_loot_corpse_id(
                            &self.store.player_corpses,
                            &self.area_id,
                            (player.x, player.y),
                        )
                    })
                    .map(str::to_owned)
                    .or_else(|| self.nearest_lootable_actor_corpse());
                if let Some(corpse_id) = corpse_id {
                    self.loot_corpse_id = Some(corpse_id);
                    self.project_windows();
                    self.open_workspace_window("loot");
                    return None;
                }
                let target = self
                    .selected_actor_id
                    .as_ref()
                    .and_then(|id| self.store.actors.get(id).map(|_| id.clone()))
                    .or_else(|| {
                        let player = self.store.actors.get(&self.player_id)?;
                        self.store
                            .actors
                            .iter()
                            .filter(|(id, actor)| {
                                id.as_str() != self.player_id && actor.area_id == self.area_id
                            })
                            .filter_map(|(id, actor)| {
                                let distance = ((actor.x - player.x).powi(2)
                                    + (actor.y - player.y).powi(2))
                                .sqrt();
                                (distance <= 2.5).then_some((id.clone(), distance))
                            })
                            .min_by(|left, right| left.1.total_cmp(&right.1))
                            .map(|(id, _)| id)
                    })?;
                return Some(actions::GameplayAction::Interact {
                    verb: "interact".into(),
                    target_id: target,
                });
            }
            _ => {}
        }
        None
    }

    /// Queue a combat action against the selected target, else the nearest
    /// hostile — the shared body behind Space, `1` (basic) and `2` (aimed).
    fn shot_action(&self, action_id: &str) -> Option<actions::GameplayAction> {
        let player = self.store.actors.get(&self.store.player_actor_id);
        let player_faction = player.and_then(|actor| actor.faction_id.as_deref());
        let player_position = player.map(|actor| (actor.x, actor.y)).unwrap_or_default();
        let selected_target = self
            .selected_actor_id
            .as_ref()
            .filter(|id| id.as_str() != self.store.player_actor_id)
            .filter(|id| {
                self.store
                    .actors
                    .get(id.as_str())
                    .is_some_and(|actor| actor.life_state == "alive")
            })
            .cloned();
        let target = selected_target.or_else(|| {
            self.store
                .actors
                .values()
                .filter(|actor| {
                    actor.id != self.store.player_actor_id
                        && actor.life_state == "alive"
                        && (actor.pvp_status.as_deref() == Some("overt")
                            || actor.role.as_deref() == Some("skirmisher"))
                        && actor.faction_id.as_deref() != player_faction
                })
                .min_by(|left, right| {
                    let left_distance = (left.x - player_position.0).powi(2)
                        + (left.y - player_position.1).powi(2);
                    let right_distance = (right.x - player_position.0).powi(2)
                        + (right.y - player_position.1).powi(2);
                    left_distance.total_cmp(&right_distance)
                })
                .map(|actor| actor.id.clone())
        })?;
        Some(actions::GameplayAction::Attack {
            action_id: action_id.to_string(),
            target_actor_id: target,
        })
    }

    /// Tab targeting: cycle the live non-self actors in this area by distance,
    /// starting after the current selection (wrapping).
    fn cycle_target(&mut self) {
        let Some(player) = self.store.actors.get(&self.store.player_actor_id) else {
            return;
        };
        let (px, py) = (player.x, player.y);
        let mut candidates: Vec<(String, f32)> = self
            .store
            .actors
            .values()
            .filter(|actor| {
                actor.id != self.store.player_actor_id
                    && actor.area_id == self.area_id
                    && actor.life_state == "alive"
            })
            .map(|actor| {
                (
                    actor.id.clone(),
                    (actor.x - px).powi(2) + (actor.y - py).powi(2),
                )
            })
            .collect();
        if candidates.is_empty() {
            return;
        }
        candidates.sort_by(|left, right| left.1.total_cmp(&right.1).then(left.0.cmp(&right.0)));
        let next = match self
            .selected_actor_id
            .as_deref()
            .and_then(|current| candidates.iter().position(|(id, _)| id == current))
        {
            Some(at) => (at + 1) % candidates.len(),
            None => 0,
        };
        self.selected_actor_id = Some(candidates[next].0.clone());
        self.project_windows();
    }

    /// Nearest authority-marked lootable world corpse (rogues, wildlife) —
    /// `player_corpses` only carries player bodies, but the actor snapshot
    /// flags every corpse the authority will open for us.
    fn nearest_lootable_actor_corpse(&self) -> Option<String> {
        let player = self.store.actors.get(&self.player_id)?;
        let (px, py) = (player.x, player.y);
        let reach_sq = crate::windows::EXTRACTOR_REACH_CELLS.powi(2);
        self.store
            .actors
            .values()
            .filter(|actor| {
                actor.id != self.player_id
                    && actor.area_id == self.area_id
                    && actor.lootable == Some(true)
            })
            .map(|actor| {
                (
                    actor.id.clone(),
                    (actor.x - px).powi(2) + (actor.y - py).powi(2),
                )
            })
            .filter(|(_, distance_sq)| *distance_sq <= reach_sq)
            .min_by(|left, right| left.1.total_cmp(&right.1))
            .map(|(id, _)| id)
    }

    pub fn sprint_toggled(&self) -> bool {
        self.sprint_toggle
    }

    /// Apply wheel zoom in the connected orthographic camera.
    pub fn handle_scroll(&mut self, y: f32) {
        if !y.is_finite() || y == 0.0 {
            return;
        }
        self.zoom_percent = (self.zoom_percent - y * 5.0).clamp(55.0, 125.0);
        if let Some(cam) = self.world.get_component::<Camera>(self.follow) {
            cam.projection = Projection::Ortho {
                half_height: 12.5 * self.zoom_percent / 100.0,
                near: 0.1,
                far: 320.0,
            };
        }
    }

    /// Route pointer grammar against streamed actor targets. Empty left clicks
    /// become directional authority intents, never local teleports.
    pub fn handle_pointer(
        &mut self,
        x: f32,
        y: f32,
        left: bool,
        right: bool,
        captured: bool,
    ) -> Option<actions::GameplayAction> {
        let dx = x - self.pointer_prev.0;
        let dy = y - self.pointer_prev.1;
        self.pointer_prev = (x, y);
        let left_pressed = left && !self.left_was_down;
        let right_pressed = right && !self.right_was_down;
        self.left_was_down = left;
        self.right_was_down = right;
        // A left-drag inside the live viewer cell spins the doll instead of
        // routing a world intent — the original's draggable object viewer.
        let in_viewer = self.dolls.iter().any(|slot| {
            slot.viewport.is_some_and(|[vx, vy, vw, vh]| {
                successor_engine_render::ui::UiBuilder::hit(vx, vy, vw, vh, x, y)
            })
        });
        if left && (self.paperdoll_drag_x.is_some() || (left_pressed && in_viewer)) {
            if self.paperdoll_drag_x.is_some() {
                let step = dx * PAPERDOLL_DRAG_YAW_PER_PX;
                self.paperdoll_yaw += step;
                // Carry the drag as velocity so releasing mid-sweep flicks the
                // doll on, exactly as the original viewer does.
                self.paperdoll_spin = (step * 60.0).clamp(-PAPERDOLL_MAX_SPIN, PAPERDOLL_MAX_SPIN);
            }
            self.paperdoll_drag_x = Some(x);
            return None;
        }
        self.paperdoll_drag_x = None;
        // A press that lands on a panel belongs to the panel. `captured` alone
        // cannot say so: it latches while the windows run, which is after the
        // host has already routed this press, so on the press itself it still
        // reads false and the click walks a move intent out from under the
        // open window - which then clears the very selection the player was
        // about to act on.
        //
        // One press IS window content and still has to be resolved here: the
        // right-click that opens an inventory card's object radial. The cards
        // only exist inside the inventory window, so leaving this below the
        // swallow made the radial unreachable - every right-press over the
        // grid returned early as "belongs to the panel" and no panel code
        // could see the button (the widget response carries left-click only).
        if right_pressed && !left && !captured {
            if let Some((container, stack_id, (anchor_x, anchor_y))) = self.inventory_item_at(x, y)
            {
                crate::windows::inventory::select_identity(&container, &stack_id);
                self.selected_inventory = Some((container, stack_id));
                self.selected_actor_id = None;
                self.project_windows();
                self.context_menu = Some(ContextMenu::InventoryRadial {
                    x: anchor_x,
                    y: anchor_y,
                });
                return None;
            }
        }
        if captured || self.wm.covers(x, y) {
            return None;
        }
        let picked_actor = self.actor_id_at_pointer(x, y).map(str::to_owned);
        if right_pressed && !left {
            // A right-click on a HUD pane toggles that pane's layout lock, the
            // original's per-window `window_lock` / `window_unlock` control.
            // It is consumed here, before actor/context routing can see it.
            if hud::toggle_hud_surface_lock_at(&mut self.wm, x, y).is_some() {
                self.window_layout_dirty = true;
                self.hud_layout_input_consumed = true;
                return None;
            }
        }
        if right_pressed && !left {
            if let Some(target_id) = picked_actor.clone() {
                self.selected_actor_id = Some(target_id.clone());
                self.selected_inventory = None;
                crate::windows::inventory::clear_selection();
                self.project_windows();
                self.context_menu = Some(ContextMenu::Actor { x, y });
                return Some(actions::GameplayAction::Interact {
                    verb: "radial".into(),
                    target_id,
                });
            }
        }

        if right && (right_pressed || dx.abs() + dy.abs() > 0.5) {
            let (mx, my) = if dx.abs() >= dy.abs() {
                (dx.signum() as i32, 0)
            } else {
                (0, dy.signum() as i32)
            };
            return Some(actions::GameplayAction::Move {
                dx: mx,
                dy: my,
                facing: movement::facing_from_intent(mx, my),
                sprint: self.sprint_toggle,
            });
        }
        if !left_pressed {
            return None;
        }
        if let Some(target_id) = picked_actor {
            self.selected_actor_id = Some(target_id);
            self.selected_inventory = None;
            crate::windows::inventory::clear_selection();
            self.project_windows();
            return None;
        }
        self.selected_actor_id = None;
        self.selected_inventory = None;
        crate::windows::inventory::clear_selection();
        self.project_windows();
        if self.framebuffer.0 == 0 || self.framebuffer.1 == 0 {
            return None;
        }
        let camera = self.world.get_component::<Camera>(self.follow).copied()?;
        let Projection::Ortho {
            half_height,
            near,
            far,
        } = camera.projection
        else {
            return None;
        };
        let aspect = self.framebuffer.0 as f32 / self.framebuffer.1 as f32;
        let vp = Mat4::ortho(
            -half_height * aspect,
            half_height * aspect,
            -half_height,
            half_height,
            near,
            far,
        )
        .mul(Mat4::look_at(camera.eye, camera.look_at, camera.up));
        let inv = vp.inverse();
        let ndc_x = x / self.framebuffer.0 as f32 * 2.0 - 1.0;
        let ndc_y = 1.0 - y / self.framebuffer.1 as f32 * 2.0;
        let near_point = inv.project_point(vec3(ndc_x, ndc_y, -1.0));
        let far_point = inv.project_point(vec3(ndc_x, ndc_y, 1.0));
        let ray = far_point.sub(near_point);
        if ray.y.abs() < 1e-5 {
            return None;
        }
        let hit = near_point.add(ray.scale(-near_point.y / ray.y));
        let goal = (
            (hit.x / WORLD_UNITS_PER_CELL).floor() as i32,
            (hit.z / WORLD_UNITS_PER_CELL).floor() as i32,
        );
        let player = self.store.actors.get(&self.store.player_actor_id)?;
        let start = (player.x.floor() as i32, player.y.floor() as i32);
        self.click_route = movement::route_grid(start, goal, |cx, cy| {
            !self
                .movement_collision
                .anchor_clear(cx as f32 + 0.5, cy as f32 + 0.5)
        })
        .unwrap_or_default();
        self.click_route_index = 0;
        self.click_goal = (!self.click_route.is_empty()).then_some(goal);
        self.streamed_world
            .set_waypoint((!self.click_route.is_empty()).then_some((goal.0 as f32, goal.1 as f32)));
        None
    }

    /// Apply a receipt to the queue and visible pending/rejection state.
    pub fn settle_window_command(
        &mut self,
        command_id: u64,
        accepted: bool,
        reason: Option<String>,
    ) {
        if let Some(queue) = self.command_queue.as_mut() {
            queue.settle(command_id);
        }
        self.pending_window_commands.retain(|id| *id != command_id);
        if !accepted {
            self.window_rejection = Some(reason.unwrap_or_else(|| "command rejected".into()));
        }
    }
    pub fn settle_command(&mut self, command_id: u64, accepted: bool, reason: Option<String>) {
        // The envelope is still queued at this point, so the settling command
        // can be identified before it is retired. Both the diegetic clip and
        // the UI cue are chosen here for that reason.
        let (accepted_audio, accepted_cue) = accepted
            .then(|| {
                self.command_queue
                    .as_ref()?
                    .pending_envelopes()
                    .find_map(|envelope| {
                        (envelope.command_id == command_id).then(|| match envelope.command {
                            ClientCommand::ToggleDoor { .. }
                            | ClientCommand::BuildToggleDoor { .. } => {
                                (Some(crate::audio::DOOR_CLIP), None)
                            }
                            ClientCommand::ReloadWeapon { .. } => {
                                (Some(crate::audio::RELOAD_CLIP), None)
                            }
                            _ => (None, ui_cue_for_settled(&envelope.command)),
                        })
                    })
            })
            .flatten()
            .unwrap_or((None, None));
        if let Some(queue) = self.command_queue.as_mut() {
            queue.settle(command_id);
        }
        self.store.last_receipt = Some(GameCommandReceipt {
            command_id,
            accepted,
            tick: self.store.tick,
            reason_code: reason.clone(),
        });
        if let Some(clip) = accepted_audio {
            self.sfx.play_ui(clip);
        }
        if let Some(cue) = accepted_cue {
            crate::audio::play_ui(&mut self.sfx, cue);
        }
        if !accepted {
            crate::audio::play_ui(&mut self.sfx, crate::audio::UiCue::Deny);
            self.window_rejection = Some(reason.unwrap_or_else(|| "command rejected".into()));
        }
    }

    fn open_inventory_radial(&mut self, container: String, stack_id: String) {
        let selected = self
            .win_model
            .inventory
            .row(&container, &stack_id)
            .is_some_and(|row| !row.in_exchange());
        if !selected {
            return;
        }
        crate::windows::inventory::select_identity(&container, &stack_id);
        self.selected_inventory = Some((container, stack_id));
        self.selected_actor_id = None;
        self.context_menu = Some(ContextMenu::InventoryRadial {
            x: self.pointer_prev.0,
            y: self.pointer_prev.1,
        });
        self.project_windows();
    }

    fn apply_local_window_action(&mut self, local: crate::windows::WindowLocalAction) {
        use crate::windows::WindowLocalAction::*;
        match local {
            Close => self.window_rejection = Some("local: close".into()),
            Select(id) => {
                self.selected_inventory = crate::windows::inventory::selected_identity()
                    .filter(|(container, stack_id)| {
                        self.win_model
                            .inventory
                            .row(container, stack_id)
                            .is_some_and(|row| !row.in_exchange())
                    })
                    .or_else(|| {
                        self.win_model
                            .inventory
                            .rows
                            .iter()
                            .find(|row| row.item_id == id && !row.in_exchange())
                            .map(|row| (row.container.clone(), row.stack_id.clone()))
                    });
                if let Some((container, stack_id)) = &self.selected_inventory {
                    crate::windows::inventory::select_identity(container, stack_id);
                } else {
                    crate::windows::inventory::clear_selection();
                }
                self.selected_actor_id = None;
                self.context_menu = None;
                self.window_rejection = Some(format!("local: select {id}"));
                self.project_windows();
            }
            OpenWindow(id) => self.open_workspace_window(&id),
            OpenInventoryRadial {
                container,
                stack_id,
            } => self.open_inventory_radial(container, stack_id),
            SetTheme(i) => {
                self.theme_index = i % hud::THEME_COUNT;
                self.preferences_dirty = true;
                self.project_windows();
            }
            SetDust(v) => {
                self.dust_strength = v.clamp(0.0, 1.0);
                self.project_windows();
            }
            SetWindowOpacity(v) => {
                self.window_opacity = v.clamp(hud::MIN_UI_OPACITY, hud::MAX_UI_OPACITY);
                self.preferences_dirty = true;
                self.project_windows();
            }
            SetHudOpacity(v) => {
                self.hud_opacity = v.clamp(hud::MIN_UI_OPACITY, hud::MAX_UI_OPACITY);
                self.preferences_dirty = true;
                self.project_windows();
            }
            SetSplitSnap(v) => {
                self.split_snap = v;
                self.preferences_dirty = true;
                self.project_windows();
            }
            RebindToolbarSlot(i) => {
                self.rebind_pending = (i < self.toolbar.doc.binds.len()).then_some(i);
                self.project_windows();
            }
            BeginAssignAction(id) => self.window_rejection = Some(format!("local: assign {id}")),
            RunMacro(id) => {
                self.window_rejection = self.macro_runtime.start(&id).err().map(str::to_string);
            }
            StopMacro(id) => self.macro_runtime.stop(&id),
            SaveMacro { name, body } => {
                self.window_rejection = self
                    .macro_runtime
                    .save_macro(&name, &body)
                    .err()
                    .map(str::to_string);
                self.project_windows();
            }
            DeleteMacro(id) => {
                if !self.macro_runtime.delete(&id) {
                    self.window_rejection = Some("macro_not_found".into());
                }
                self.project_windows();
            }
            SubmitBugReport { category, body } => {
                self.bug_report_sequence = self.bug_report_sequence.wrapping_add(1);
                let request_id = format!(
                    "00000000-0000-4000-8000-{:012x}",
                    (successor_platform::now_ms() as u64)
                        .wrapping_mul(1_000)
                        .wrapping_add(self.bug_report_sequence as u64)
                        & 0x000f_ffff_ffff_ffff
                );
                let player = self.store.actors.get(&self.player_id);
                let diagnostics = crate::windows::bugreport::collect_diagnostics(
                    &crate::windows::bugreport::DiagnosticsInput {
                        client_release_id: option_env!("SUCCESSOR_CLIENT_RELEASE_ID")
                            .unwrap_or("source-build")
                            .into(),
                        server_release_id: String::new(),
                        shard_id: self.shard_id.clone(),
                        source_state_hash: self.store.source_state_hash.clone().unwrap_or_default(),
                        area_id: self.area_id.clone(),
                        position: player.map(|actor| (actor.x, actor.y)),
                        life_state: player
                            .map(|actor| actor.life_state.clone())
                            .unwrap_or_default(),
                        selected_actor_id: self.selected_actor_id.clone(),
                        weapon_id: player
                            .and_then(|actor| actor.weapon.as_ref())
                            .and_then(|weapon| weapon.weapon_id.clone()),
                        connected: true,
                        authority_tick: self.store.tick,
                        accepted_commands: 0,
                        rejected_commands: 0,
                        recent_receipts: self
                            .store
                            .last_receipt
                            .as_ref()
                            .map(|receipt| {
                                vec![(
                                    receipt.command_id,
                                    receipt.accepted,
                                    receipt.reason_code.clone().unwrap_or_default(),
                                )]
                            })
                            .unwrap_or_default(),
                        recent_errors: self.window_rejection.iter().cloned().collect(),
                        open_windows: self.open_window_ids(),
                        viewport: self.framebuffer,
                        fps: 0.0,
                        uptime_ms: successor_platform::now_ms() as u64,
                    },
                );
                self.pending_bug_report = Some(serde_json::json!({
                    "schema": "successor.bug-report-submission.v1",
                    "requestId": request_id,
                    "category": category,
                    "body": crate::hud::sanitize_text(&body, crate::windows::bugreport::BODY_MAX_CHARS),
                    "diagnostics": diagnostics,
                }));
                crate::windows::set_bug_report_pending(request_id);
            }
            BugReportReset => {
                self.window_rejection = None;
                crate::windows::reset_bug_report();
            }
            CreateWaypoint { x, y, name } => {
                let result = self.waypoints.create(
                    name.as_deref(),
                    x,
                    y,
                    &self.area_id,
                    true,
                    successor_platform::now_ms() as u64,
                );
                self.window_rejection = Some(result.status);
                self.project_windows();
            }
            RenameWaypoint { id, name } => {
                let result = self.waypoints.rename(id, &name);
                self.window_rejection = Some(result.status);
                self.project_windows();
            }
            SetWaypointActive { id, active } => {
                let result = self.waypoints.set_active(id, active);
                self.window_rejection = Some(result.status);
                self.project_windows();
            }
            DeleteWaypoint(id) => {
                let result = self.waypoints.delete(id);
                self.window_rejection = Some(result.status);
                self.project_windows();
            }
        }
    }
    /// Ingest a combat event: fire its VFX and, if new, spawn a short-lived
    /// muzzle-flash point light at the shot origin (decays over 0.12 s).
    pub fn ingest_combat(&mut self, ev: &crate::game::combat_fx::CombatEvent) {
        let actor_point = |actor_id: &str| {
            self.store.actors.get(actor_id).map(|actor| {
                [
                    (actor.x + 0.5) * WORLD_UNITS_PER_CELL,
                    (actor.y + 0.5) * WORLD_UNITS_PER_CELL,
                ]
            })
        };
        let Some(origin) = ev
            .origin
            .map(|point| {
                [
                    point[0] * WORLD_UNITS_PER_CELL,
                    point[1] * WORLD_UNITS_PER_CELL,
                ]
            })
            .or_else(|| actor_point(&ev.shooter_actor_id))
        else {
            return;
        };
        let Some(hit) = ev
            .hit_point
            .map(|point| {
                [
                    point[0] * WORLD_UNITS_PER_CELL,
                    point[1] * WORLD_UNITS_PER_CELL,
                ]
            })
            .or_else(|| actor_point(&ev.target_actor_id))
        else {
            return;
        };
        let origin_world = [
            origin[0],
            self.terrain.height_at(origin[0], origin[1]) + ADULT_PAWN_HEIGHT_METERS * 0.7,
            origin[1],
        ];
        let hit_world = [
            hit[0],
            self.terrain.height_at(hit[0], hit[1]) + ADULT_PAWN_HEIGHT_METERS * 0.5,
            hit[1],
        ];
        if self.combat_fx.trigger(ev, origin_world, hit_world) {
            let (text, tone) = match ev.outcome {
                crate::game::combat_fx::CombatOutcome::Dodge => {
                    ("MISS".to_string(), hud::overlays::FloatTone::Miss)
                }
                crate::game::combat_fx::CombatOutcome::Deflect => {
                    ("DEFLECT".to_string(), hud::overlays::FloatTone::Deflect)
                }
                crate::game::combat_fx::CombatOutcome::Sleep => {
                    ("SLEEP".to_string(), hud::overlays::FloatTone::Status)
                }
                _ if ev.damage > 0.0 => (
                    format!("-{:.0}", ev.damage),
                    hud::overlays::FloatTone::Damage,
                ),
                _ => ("0".to_string(), hud::overlays::FloatTone::Deflect),
            };
            self.overlays.push_float(&ev.target_actor_id, &text, tone);
            crate::audio::play_combat(&mut self.sfx, ev, origin_world, hit_world);
            let e = self.world.spawn();
            self.world.set_component(
                e,
                Transform {
                    pos: vec3(origin_world[0], origin_world[1], origin_world[2]),
                    rot: successor_engine_core::math::Quat::IDENTITY,
                    scale: Vec3::ONE,
                },
            );
            self.world.set_component(
                e,
                successor_engine_render::components::PointLight {
                    color: ev.weapon.color(),
                    intensity: 6.0,
                    radius: 5.0,
                },
            );
            self.muzzle_lights.push((e, 0.12));
            self.world.flush();
        }
    }

    /// Decay transient muzzle lights; despawn expired ones.
    fn decay_muzzle_lights(&mut self, dt: f32) {
        let mut i = 0;
        while i < self.muzzle_lights.len() {
            let (e, ttl) = self.muzzle_lights[i];
            let ttl = ttl - dt;
            if ttl <= 0.0 {
                self.world.destroy(e);
                self.muzzle_lights.swap_remove(i);
            } else {
                self.muzzle_lights[i].1 = ttl;
                if let Some(pl) = self
                    .world
                    .get_component::<successor_engine_render::components::PointLight>(e)
                {
                    let mut pl = *pl;
                    pl.intensity = 6.0 * (ttl / 0.12);
                    self.world.set_component(e, pl);
                }
                i += 1;
            }
        }
        self.world.flush();
    }

    fn ground_height_at(&self, x: f32, z: f32) -> f32 {
        self.props_loader
            .floor_height_at(x, z)
            .unwrap_or_else(|| self.terrain.height_at(x, z))
    }

    /// The player's current world position (falls back to the slice centre).
    pub fn player_pos(&self) -> Vec3 {
        if let Some(pawn) = self.pawns.get(&self.player_id) {
            return vec3(
                (pawn.render_pos.0 + 0.5) * WORLD_UNITS_PER_CELL,
                pawn.ground_y,
                (pawn.render_pos.1 + 0.5) * WORLD_UNITS_PER_CELL,
            );
        }
        if let Some(actor) = self.store.actors.get(&self.player_id) {
            let x = (actor.x + 0.5) * WORLD_UNITS_PER_CELL;
            let z = (actor.y + 0.5) * WORLD_UNITS_PER_CELL;
            return vec3(x, self.ground_height_at(x, z), z);
        }
        self.center
    }

    /// The player's current smoothed gait speed (diagnostic: should be stable
    /// while walking, not oscillating 0↔spike).
    pub fn player_speed(&self) -> f32 {
        self.pawns
            .get(&self.player_id)
            .map(|p| p.speed)
            .unwrap_or(0.0)
    }
    pub fn actor_count(&self) -> usize {
        self.store.actors.len()
    }

    /// Spawn a pawn using the actor's authoritative archetype and attachments.
    /// Streamed-gear retry: pawns spawned while wardrobe/weapon models were
    /// still in flight are rebuilt through the ordinary stale-pawn path once
    /// every outstanding model settles (Ready or terminally Missing).
    fn retry_pending_gear<G: Gpu>(&mut self, gpu: &mut G, platform: &mut dyn Platform) {
        self.gear_retry.clear();
        for (id, pawn) in &self.pawns {
            if !pawn.pending_equipment.is_empty() || pawn.pending_weapon {
                self.gear_retry.push(id.clone());
            }
        }
        for id in self.gear_retry.drain(..) {
            let Some(pawn) = self.pawns.get(&id) else {
                continue;
            };
            let route = pawn.route;
            let pending_equipment = pawn.pending_equipment.clone();
            let pending_weapon = pawn.pending_weapon;
            let weapon_id = pawn.presentation.weapon.clone();
            let weapon_item_id = pawn.presentation.weapon_item_id;
            let Some(body) = self.pawn_catalog.body_mut(route) else {
                continue;
            };
            let joints = body.template.joint_count();
            let female = matches!(route, BodyRoute::Human { female: true });
            let mut settled = true;
            for item_id in &pending_equipment {
                let stream = self.pawn_catalog.equipment_piece(
                    gpu,
                    &mut self.renderer,
                    platform,
                    &mut self.streamer,
                    item_id,
                    joints,
                    female,
                );
                if matches!(stream, crate::assets::stream::Streamed::Pending) {
                    settled = false;
                }
            }
            if pending_weapon {
                let stream = self.pawn_catalog.weapon_rig_for(
                    gpu,
                    &mut self.renderer,
                    platform,
                    &mut self.streamer,
                    weapon_id.as_deref(),
                    weapon_item_id,
                );
                if matches!(stream, crate::assets::stream::Streamed::Pending) {
                    settled = false;
                }
            }
            if settled {
                self.stale_pawns.push(id);
            }
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn spawn_pawn<G: Gpu>(
        &mut self,
        gpu: &mut G,
        platform: &mut dyn Platform,
        actor: &LiveActor,
        faction: Option<[f32; 3]>,
    ) {
        let requested = route_for(actor.sprite.as_deref(), &actor.id);
        // A streamed body still in flight defers the whole pawn: it stays
        // absent (projection continues, no meshes) and spawn retries on a
        // later frame. A terminal miss keeps the typed fallback presentation.
        let body_stream = self.pawn_catalog.body_for(
            gpu,
            &mut self.renderer,
            platform,
            &mut self.streamer,
            requested,
        );
        let route = match body_stream {
            crate::assets::stream::Streamed::Pending => return,
            crate::assets::stream::Streamed::Ready(body) => {
                if body.is_some() {
                    requested
                } else {
                    BodyRoute::Human { female: false }
                }
            }
        };
        let (body_parts, scale, joints, hand, animator) = {
            let body = self
                .pawn_catalog
                .body_mut(route)
                .expect("required fallback body loaded");
            (
                body.part_meshes
                    .iter()
                    .zip(&body.part_material_names)
                    .map(|((mesh, material), name)| (*mesh, *material, name.clone()))
                    .collect::<Vec<_>>(),
                body.scale,
                body.template.joint_count(),
                weapon_hand_bone(&body.template),
                PawnAnimator::new(&body.template),
            )
        };

        let mut equipment = actor.worn.clone();
        if equipment.is_empty()
            && matches!(route, BodyRoute::Human { .. })
            && actor.role.as_deref() != Some("player")
        {
            let mut defaults = Vec::new();
            self.pawn_catalog.default_outfit(
                &actor.id,
                actor.role.as_deref(),
                actor.hair.as_deref(),
                &mut defaults,
            );
            equipment.extend(defaults.into_iter().map(|item_id| WornPresentation {
                item_id: item_id.to_string(),
                colors: Vec::new(),
            }));
        }
        if let Some(hair) = actor
            .hair
            .as_deref()
            .filter(|item_id| self.pawn_catalog.knows_equipment(item_id))
        {
            if !equipment.iter().any(|piece| piece.item_id == hair) {
                equipment.push(WornPresentation {
                    item_id: hair.to_string(),
                    colors: Vec::new(),
                });
            }
        }
        let mut equipment_meshes = Vec::new();
        let mut attached_equipment_ids = Vec::with_capacity(equipment.len());
        let mut pending_equipment: Vec<String> = Vec::new();
        for worn_piece in &equipment {
            let piece_stream = self.pawn_catalog.equipment_piece(
                gpu,
                &mut self.renderer,
                platform,
                &mut self.streamer,
                &worn_piece.item_id,
                joints,
                matches!(route, BodyRoute::Human { female: true }),
            );
            let loaded = match piece_stream {
                crate::assets::stream::Streamed::Pending => {
                    pending_equipment.push(worn_piece.item_id.clone());
                    continue;
                }
                crate::assets::stream::Streamed::Ready(piece) => {
                    piece.map(|piece| (piece.part_meshes.clone(), piece.part_material_names.clone()))
                }
            };
            let Some((part_meshes, material_names)) = loaded else {
                continue;
            };
            if part_meshes.is_empty() {
                continue;
            }
            for ((mesh, authored_material), material_name) in
                part_meshes.into_iter().zip(material_names)
            {
                let material = self
                    .pawn_catalog
                    .equipment_part_color(
                        &worn_piece.item_id,
                        material_name.as_deref(),
                        &worn_piece.colors,
                        actor.hair_material.as_deref(),
                    )
                    .map(|color| {
                        let mut desc = self
                            .renderer
                            .material_desc(authored_material)
                            .unwrap_or_default();
                        desc.base_color = color;
                        desc.blend = color[3] < 1.0;
                        self.renderer.add_material_desc(desc)
                    })
                    .unwrap_or(authored_material);
                equipment_meshes.push((mesh, material));
            }
            attached_equipment_ids.push(worn_piece.item_id.as_str());
        }
        // Coverage is only defined for the standard human bodies. A failed
        // special-body load may fall back to this mesh, but must retain its
        // pre-existing special/creature presentation semantics. Only renderable
        // apparel can claim skin, so an optional-asset degradation stays whole.
        let hidden_body_zones = if matches!(requested, BodyRoute::Human { .. }) {
            self.pawn_catalog.hidden_body_zones(attached_equipment_ids)
        } else {
            Default::default()
        };

        let base = skin_tint(actor.skin.as_deref());
        let color = faction_tinted(base, faction);
        let mut tinted_body_parts = Vec::with_capacity(body_parts.len());
        for (mesh, authored_material, material_name) in body_parts {
            if hidden_body_zones.hides_material_name(material_name.as_deref()) {
                continue;
            }
            let material = if material_name.as_deref() == Some("RB_Face") {
                authored_material
            } else {
                let mut desc = self
                    .renderer
                    .material_desc(authored_material)
                    .unwrap_or_default();
                desc.base_color = color;
                desc.blend = color[3] < 1.0;
                self.renderer.add_material_desc(desc)
            };
            tinted_body_parts.push((mesh, material));
        }
        let mut entities = Vec::with_capacity(tinted_body_parts.len() + equipment_meshes.len());
        for (mesh, material) in tinted_body_parts.into_iter().chain(equipment_meshes) {
            let e = self.world.spawn();
            self.world.set_component(
                e,
                Transform {
                    pos: self.center,
                    rot: Quat::IDENTITY,
                    scale: vec3(scale, scale, scale),
                },
            );
            self.world.set_component(
                e,
                MeshRenderer {
                    mesh,
                    material,
                    viewport_mask: 0b1,
                    skin: SkinRef::NONE,
                },
            );
            entities.push(e);
        }

        let weapon_stream = self.pawn_catalog.weapon_rig_for(
            gpu,
            &mut self.renderer,
            platform,
            &mut self.streamer,
            actor.weapon.as_deref(),
            actor.weapon_item_id,
        );
        let mut pending_weapon = false;
        let resolved_weapon = match weapon_stream {
            crate::assets::stream::Streamed::Pending => {
                pending_weapon = true;
                None
            }
            crate::assets::stream::Streamed::Ready(rig) => rig,
        };
        let resolved_weapon = resolved_weapon
            .map(|rig| {
                (
                    rig.parts.clone(),
                    HeldWeaponRig {
                        mount: rig.mount,
                        grip: rig.grip,
                        foregrip: rig.foregrip,
                        muzzle: rig.muzzle,
                        foregrip_contact: rig.foregrip_contact,
                        resting_yaw_rad: rig.resting_yaw_rad,
                        support_arm: rig.support_arm,
                        support_hand: rig.support_hand,
                    },
                    rig.melee,
                    rig.plasma_blade_part,
                    rig.stow.clone(),
                )
            });
        let lane = resolved_weapon
            .as_ref()
            .map(|(_, _, melee, _, _)| {
                if *melee {
                    WeaponLane::Melee
                } else {
                    WeaponLane::Rifle
                }
            })
            .unwrap_or_else(|| weapon_lane(actor.weapon.as_deref()));
        let stow = resolved_weapon
            .as_ref()
            .and_then(|(_, _, _, _, stow)| stow.as_ref())
            .and_then(|stow| {
                self.pawn_catalog
                    .body_mut(route)
                    .and_then(|body| body.template.skeleton.find_bone(&stow.bone))
                    .map(|bone| (bone, stow.mount, stow.arc_lift))
            });
        let weapon = resolved_weapon
            .map(|(parts, held, _, plasma_blade_part, _)| (parts, held, plasma_blade_part))
            .zip(hand)
            .map(|((parts, held, plasma_blade_part), hand)| {
                let mut weapon_entities = Vec::with_capacity(parts.len());
                let mut plasma_blade = None;
                for (part_index, (mesh, material, local)) in parts.into_iter().enumerate() {
                    let entity = self.world.spawn();
                    let (pos, rot, part_scale) = local.to_trs();
                    self.world.set_component(
                        entity,
                        Transform {
                            pos,
                            rot,
                            scale: part_scale,
                        },
                    );
                    self.world.set_component(
                        entity,
                        MeshRenderer {
                            mesh,
                            material,
                            viewport_mask: 0b1,
                            skin: SkinRef::NONE,
                        },
                    );
                    if plasma_blade_part == Some(part_index) {
                        plasma_blade = Some(entity);
                    }
                    weapon_entities.push((entity, local));
                }
                WeaponAttachment {
                    entities: weapon_entities,
                    hand,
                    held,
                    plasma_blade,
                    stow,
                    stow_blend: if stow.is_some() && !actor.in_combat {
                        1.0
                    } else {
                        0.0
                    },
                    stow_target: stow.is_some() && !actor.in_combat,
                    stow_seconds: 0.28,
                    ik_weight: if stow.is_some() && !actor.in_combat {
                        0.0
                    } else {
                        1.0
                    },
                }
            });

        // A wardrobe rebuild parked the stride this actor was mid-way through.
        // Reclaim it when the body underneath is the same one, so a clothing
        // swap never restarts the animation from its bind pose. A different
        // body is a different skeleton, and starts clean.
        let carried = self
            .carried_motion
            .remove(&actor.id)
            .filter(|carried| carried.route == route);

        let (animator, lane, interp, predictor, target, render_pos, ground_y, speed, yaw) =
            match carried {
                Some(carried) => (
                    carried.animator,
                    carried.lane,
                    carried.interp,
                    carried.predictor,
                    carried.target,
                    carried.render_pos,
                    carried.ground_y,
                    carried.speed,
                    carried.yaw,
                ),
                None => {
                    let mut interp = ActorInterp::new();
                    interp.push(self.sim_time, actor.x, actor.y, actor.lifecycle_seq);
                    let wx = (actor.x + 0.5) * WORLD_UNITS_PER_CELL;
                    let wz = (actor.y + 0.5) * WORLD_UNITS_PER_CELL;
                    (
                        animator,
                        lane,
                        interp,
                        MovePredictor::new(actor.x, actor.y),
                        (actor.x, actor.y),
                        (actor.x, actor.y),
                        self.ground_height_at(wx, wz),
                        0.0,
                        0.0,
                    )
                }
            };

        self.pawns.insert(
            actor.id.clone(),
            ActorPawn {
                id: actor.id.clone(),
                name: actor.name.clone(),
                descriptor: actor
                    .role
                    .as_deref()
                    .map(|role| {
                        format!(
                            "({})",
                            hud::sanitize_text(&role.replace(['_', '-'], " "), 32)
                        )
                    })
                    .filter(|role| role != "()"),
                presentation: PawnPresentation {
                    skin: actor.skin.clone(),
                    faction: actor.faction.clone(),
                    sprite: actor.sprite.clone(),
                    role: actor.role.clone(),
                    hair: actor.hair.clone(),
                    hair_material: actor.hair_material.clone(),
                    worn: actor.worn.clone(),
                    weapon: actor.weapon.clone(),
                    weapon_item_id: actor.weapon_item_id,
                },
                entities,
                weapon,
                animator,
                route,
                lane,
                scale,
                interp,
                predictor,
                lifecycle_seq: actor.lifecycle_seq,
                alive: actor.alive,
                target,
                render_pos,
                ground_y,
                speed,
                yaw,
                present: true,
                pending_equipment,
                pending_weapon,
            },
        );
    }

    fn sync_active_area<G: Gpu>(&mut self, gpu: &mut G, platform: &mut dyn Platform) {
        if self.area_id.is_empty() || self.loaded_area_id == self.area_id {
            return;
        }
        let area_id = self.area_id.clone();
        let player = self.player_pos();
        let player_cell = (
            player.x / WORLD_UNITS_PER_CELL,
            player.z / WORLD_UNITS_PER_CELL,
        );
        self.props_loader.clear(&mut self.world);
        self.collision_debug.clear_area(&mut self.world);
        self.streamed_world.clear(&mut self.world);
        self.terrain.clear(&mut self.world, &mut self.renderer, gpu);
        let mut terrain = TerrainStreamer::new(
            effective_world_seed(&self.slice, &area_id) as i32,
            biome_for_area(&self.slice, &area_id),
            64.0 * WORLD_UNITS_PER_CELL as f64,
            3,
            0b1,
        );
        let exclusions = building_terrain_exclusions(&self.slice, Some(&area_id), 1.5);
        terrain.set_exclusions(&exclusions);
        terrain.ensure_around(
            &mut self.world,
            &mut self.renderer,
            gpu,
            player.x as f64,
            player.z as f64,
        );
        self.props_loader.begin_area(&self.slice, Some(&area_id));
        self.collision_debug.load_area(
            &mut self.world,
            &mut self.renderer,
            gpu,
            &self.slice,
            &area_id,
            &terrain,
            &self.store.prop_states,
        );
        self.movement_collision
            .rebuild(&self.slice, &area_id, &self.collision_debug);
        self.terrain = terrain;
        self.loaded_area_id = area_id;
        // Region-streamed props: place whatever of the destination spawn
        // neighborhood is already cached, queue the rest, and hold the travel
        // transition until the neighborhood settles (deadline: fail-closed
        // marker placement via force_place_neighborhood).
        self.travel_hold = Some(TravelHold {
            deadline_ms: platform.monotonic_ms() + 30_000,
        });
        let placed = self.props_loader.sync_regions(
            &mut self.world,
            &mut self.renderer,
            gpu,
            &self.terrain,
            platform,
            &mut self.streamer,
            player_cell,
            0b1,
        );
        eprintln!(
            "connected: active area {} streaming, {placed} props placed, {} region-gated",
            self.loaded_area_id,
            self.props_loader.pending_count(),
        );
    }

    /// Per-frame: reconcile pawns with the authoritative actor set, animate, and
    /// render the full scene + FX + HUD.
    #[allow(clippy::too_many_arguments)]
    pub fn frame<G: Gpu>(
        &mut self,
        gpu: &mut G,
        w: u32,
        h: u32,
        dt: f32,
        platform: &mut dyn Platform,
        chat_client: &mut crate::game::chat_net::ChatClient,
        chat_input: &mut successor_engine_render::ui::TextField,
    ) {
        self.last_frame_dt = dt.max(0.0);
        // Stream completions land before anything consumes them this frame.
        self.streamer.pump(platform);
        // Travel hold: keep streaming the destination spawn neighborhood and
        // release the transition once it settles; the deadline forces
        // fail-closed marker placement rather than hanging the transition.
        if let Some(hold) = &self.travel_hold {
            let deadline_ms = hold.deadline_ms;
            let player_cell = self
                .store
                .actors
                .get(&self.store.player_actor_id)
                .map(|actor| (actor.x, actor.y))
                .unwrap_or((0.0, 0.0));
            self.props_loader.sync_regions(
                &mut self.world,
                &mut self.renderer,
                gpu,
                &self.terrain,
                platform,
                &mut self.streamer,
                player_cell,
                0b1,
            );
            if self.props_loader.pending_in_region(player_cell) == 0 {
                self.travel_hold = None;
            } else if platform.monotonic_ms() > deadline_ms {
                eprintln!("connected: travel stream deadline; marker-placing stragglers");
                self.props_loader.force_place_region(
                    &mut self.world,
                    &mut self.renderer,
                    gpu,
                    &self.terrain,
                    player_cell,
                    0b1,
                );
                self.travel_hold = None;
            }
        }
        if self.loading || self.travel_hold.is_some() {
            self.ui.begin(w, h);
            self.loading_screen.tick(dt);
            self.loading_screen.draw(&mut self.ui, w as f32, h as f32);
            gpu.begin_pass(
                PassTarget::Screen,
                RectPx {
                    x: 0,
                    y: 0,
                    w: w as i32,
                    h: h as i32,
                },
                ClearSpec {
                    color: Some([0.012, 0.027, 0.039, 1.0]),
                    depth: Some(1.0),
                },
            );
            gpu.end_pass();
            self.renderer
                .render_ui(gpu, &self.ui.buf, self.ui.quads, w, h);
            return;
        }
        self.framebuffer = (w, h);
        // HUD panes are edge-anchored furniture, not player-arranged windows: a
        // rect captured at one framebuffer strands the bottom band mid-screen at
        // any other. This is the first point the real viewport is known, so it
        // is where a restored layout is reconciled against it — and where a live
        // window resize re-anchors the band to the new edges.
        let live = (w as f32, h as f32);
        if hud_anchor_is_stale(self.hud_layout_viewport, live) {
            self.hud_defaults_pending = [true; hud::HUD_SURFACE_COUNT];
            self.hud_layout_viewport = Some(live);
        }
        if self.hud_defaults_pending.iter().any(|missing| *missing) {
            hud::apply_missing_hud_surface_defaults(
                &mut self.wm,
                live,
                &self.hud_defaults_pending,
            );
            self.hud_defaults_pending = [false; hud::HUD_SURFACE_COUNT];
        }
        self.sync_active_area(gpu, platform);
        // Region watcher: stream prop models for the player's 3×3 region
        // neighborhood; pending props place on the frame their bytes land.
        if self.props_loader.pending_count() > 0 {
            let player_cell = self
                .store
                .actors
                .get(&self.store.player_actor_id)
                .map(|actor| (actor.x, actor.y))
                .unwrap_or((0.0, 0.0));
            self.props_loader.sync_regions(
                &mut self.world,
                &mut self.renderer,
                gpu,
                &self.terrain,
                platform,
                &mut self.streamer,
                player_cell,
                0b1,
            );
        }
        self.macro_actions.clear();
        self.macro_runtime.tick(
            self.store.tick,
            self.selected_actor_id.as_deref(),
            &mut self.macro_actions,
        );
        let mut macro_actions = core::mem::take(&mut self.macro_actions);
        for action in macro_actions.drain(..) {
            self.dispatch_gameplay_action(action);
        }
        self.macro_actions = macro_actions;
        // 1) Reconcile pawn set with live actors.
        for p in self.pawns.values_mut() {
            p.present = false;
        }
        self.missing_pawns.clear();
        self.stale_pawns.clear();
        self.retry_pending_gear(gpu, platform);
        for (id, actor) in self.store.render_actors() {
            if !self.pawns.contains_key(id) {
                self.missing_pawns.push(id.clone());
            }
            if let Some(pawn) = self.pawns.get_mut(id) {
                if !pawn.presentation.matches(actor) {
                    self.stale_pawns.push(id.clone());
                    continue;
                }
                pawn.present = true;
                let authority_changed =
                    pawn.target != (actor.x, actor.y) || pawn.lifecycle_seq != actor.lifecycle_seq;
                pawn.target = (actor.x, actor.y);
                pawn.alive = actor.life_state == "alive";
                if let Some(weapon) = pawn.weapon.as_mut() {
                    weapon.stow_target = weapon.stow.is_some() && !actor.in_combat.unwrap_or(false);
                }
                if authority_changed {
                    pawn.lifecycle_seq = actor.lifecycle_seq;
                    if id == &self.player_id {
                        let moving = self.move_intent.0 != 0 || self.move_intent.1 != 0;
                        pawn.predictor
                            .reconcile(actor.x, actor.y, moving, self.move_intent.2);
                    } else {
                        pawn.interp
                            .push(self.sim_time, actor.x, actor.y, actor.lifecycle_seq);
                    }
                }
            }
        }
        while let Some(id) = self.stale_pawns.pop() {
            if let Some(pawn) = self.pawns.remove(&id) {
                for entity in pawn.entities {
                    self.world.destroy(entity);
                }
                if let Some(weapon) = pawn.weapon {
                    for (entity, _) in weapon.entities {
                        self.world.destroy(entity);
                    }
                }
                self.carried_motion.insert(
                    id.clone(),
                    CarriedMotion {
                        animator: pawn.animator,
                        route: pawn.route,
                        lane: pawn.lane,
                        interp: pawn.interp,
                        predictor: pawn.predictor,
                        render_pos: pawn.render_pos,
                        ground_y: pawn.ground_y,
                        target: pawn.target,
                        speed: pawn.speed,
                        yaw: pawn.yaw,
                    },
                );
            }
            self.missing_pawns.push(id);
        }
        self.world.flush();
        while let Some(id) = self.missing_pawns.pop() {
            let Some(actor) = self.store.actors.get(&id) else {
                continue;
            };
            let live = LiveActor {
                id,
                x: actor.x,
                name: hud::clean_actor_name(&actor.display_name, &actor.label, &actor.id),
                y: actor.y,
                skin: actor
                    .appearance
                    .as_ref()
                    .and_then(|ap| ap.skin_tone.clone()),
                faction: actor.faction_id.clone(),
                sprite: actor.sprite.clone(),
                role: actor.role.clone(),
                hair: actor.appearance.as_ref().and_then(|ap| ap.hair.clone()),
                hair_material: actor
                    .appearance
                    .as_ref()
                    .and_then(|appearance| appearance.hair_material.clone()),
                worn: actor
                    .worn
                    .iter()
                    .filter_map(|piece| {
                        piece.item_id.as_ref().map(|item_id| WornPresentation {
                            item_id: item_id.clone(),
                            colors: piece.colors.clone(),
                        })
                    })
                    .collect(),
                weapon: actor
                    .weapon
                    .as_ref()
                    .and_then(|weapon| weapon.weapon_id.clone()),
                weapon_item_id: actor
                    .weapon
                    .as_ref()
                    .and_then(|weapon| weapon.weapon_item_id),
                in_combat: actor.in_combat.unwrap_or(false),
                alive: actor.life_state == "alive",
                lifecycle_seq: actor.lifecycle_seq,
            };
            let faction = live.faction.as_deref().map(faction_rgb);
            self.spawn_pawn(gpu, platform, &live, faction);
        }
        self.sim_time += dt.max(0.0);
        // Every open viewer renders its own subject this frame. Each composite
        // is banded by the owning window's draw rank, so a viewer paints over
        // its own panel and under anything stacked above it — the original
        // flushes the UI queue, renders the widget's 3D scene, then carries on
        // with the panels above. Nothing here picks a single winner.
        let mut doll_subjects: [Option<&str>; DOLL_WINDOWS.len()] = [None; DOLL_WINDOWS.len()];
        for (slot, window) in DOLL_WINDOWS.iter().enumerate() {
            if !self.wm.is_open(window) || self.wm.is_iconified(window) {
                continue;
            }
            doll_subjects[slot] = match *window {
                "examine" => self
                    .win_model
                    .examine
                    .actor
                    .as_ref()
                    .map(|actor| actor.actor_id.as_str()),
                "converse" => self
                    .win_model
                    .converse
                    .npc
                    .as_ref()
                    .map(|npc| npc.actor_id.as_str()),
                _ => Some(self.player_id.as_str()),
            };
        }
        // Viewer rotation follows the original object viewer: a drag spins the
        // doll, the flick decays multiplicatively once released, and the doll
        // then parks at the resting yaw instead of turning forever.
        if self.paperdoll_drag_x.is_none() {
            let dt = dt.max(0.0);
            if self.paperdoll_spin.abs() > PAPERDOLL_SPIN_EPS {
                self.paperdoll_yaw += self.paperdoll_spin * dt;
                // 0.96 per 60 Hz frame, resolved for this frame's dt.
                self.paperdoll_spin *= PAPERDOLL_SPIN_DECAY.powf(dt * 60.0);
            } else {
                // The flick is spent: the doll holds the angle the player left
                // it at rather than springing back or turning on its own.
                self.paperdoll_spin = 0.0;
            }
        }
        self.paperdoll_yaw = self.paperdoll_yaw.rem_euclid(core::f32::consts::TAU);

        // 2) Animate + place pawns (skinned).
        self.renderer.begin_skin_frame();
        // The world pawn and every viewer share one instance: the same meshes,
        // skinning and animation tick feed all of them, exactly as the original
        // hands its live `ClientObject` to each widget rather than cloning.
        // Visibility is per-viewport, so one pawn can be in the world and in
        // several dolls in the same frame.
        let doll_mask_for = |pawn_id: &str| doll_viewport_mask(&doll_subjects, pawn_id);
        let terrain = &self.terrain;
        let props_loader = &self.props_loader;
        for pawn in self.pawns.values_mut() {
            if !pawn.present {
                for entity in pawn.entities.iter().chain(
                    pawn.weapon
                        .iter()
                        .flat_map(|weapon| weapon.entities.iter().map(|(entity, _)| entity)),
                ) {
                    if let Some(transform) = self.world.get_component::<Transform>(*entity) {
                        transform.pos = vec3(0.0, -10_000.0, 0.0);
                    }
                }
                continue;
            }

            let (rx, ry) = pawn.render_pos;
            let (nx, ny, gait_distance) = if pawn.id == self.player_id {
                let input_distance = pawn.predictor.predict(
                    &self.movement_collision,
                    self.move_intent.0 as f32,
                    self.move_intent.1 as f32,
                    self.move_intent.2,
                    if self.move_intent.2 {
                        self.sprint_speed_cells_per_second
                    } else {
                        self.walk_speed_cells_per_second
                    },
                    dt,
                );
                let predicted = pawn.predictor.render_pos();
                (predicted.0, predicted.1, input_distance)
            } else {
                let sampled = pawn.interp.sample(self.sim_time).unwrap_or(pawn.target);
                let distance =
                    ((sampled.0 - rx).powi(2) + (sampled.1 - ry).powi(2)).sqrt();
                (sampled.0, sampled.1, distance)
            };
            let moved = ((nx - rx) * (nx - rx) + (ny - ry) * (ny - ry)).sqrt();
            pawn.speed = filtered_gait_speed(pawn.speed, gait_distance, dt);
            if moved > 1e-4 {
                pawn.yaw = (nx - rx).atan2(ny - ry);
            }
            pawn.render_pos = (nx, ny);
            if let Some(weapon) = pawn.weapon.as_mut() {
                let step = (dt.max(0.0) / weapon.stow_seconds.max(1.0e-3)).min(1.0);
                weapon.stow_blend = if weapon.stow_target {
                    (weapon.stow_blend + step).min(1.0)
                } else {
                    (weapon.stow_blend - step).max(0.0)
                };
                let ik_target = if weapon.stow_blend < 1.0e-3 { 1.0 } else { 0.0 };
                let ik_step = (dt.max(0.0) / 0.12).min(1.0);
                weapon.ik_weight += (ik_target - weapon.ik_weight).clamp(-ik_step, ik_step);
            }
            let armed_blend = pawn
                .weapon
                .as_ref()
                .map_or(0.0, |weapon| 1.0 - weapon.stow_blend);
            let transition = pawn.weapon.as_ref().and_then(|weapon| {
                (pawn.lane == WeaponLane::Melee
                    && weapon.stow_blend > 0.0
                    && weapon.stow_blend < 1.0)
                    .then_some(if weapon.stow_target {
                        ("melee_sheath", weapon.stow_blend)
                    } else {
                        ("melee_draw", 1.0 - weapon.stow_blend)
                    })
            });

            let body = self
                .pawn_catalog
                .body_mut(pawn.route)
                .expect("spawned pawn body remains loaded");
            pawn.animator.update_weapon_transition(
                &mut body.template,
                pawn.lane,
                armed_blend,
                transition,
                pawn.speed,
                false,
                pawn.alive,
                (pawn.id == self.player_id).then_some(self.move_intent.2),
                dt,
            );
            if pawn.alive && pawn.lane == WeaponLane::Rifle {
                if let Some(weapon) = &pawn.weapon {
                    if weapon.held.support_hand {
                        let hand_global = body.template.skeleton.bone_global(weapon.hand);
                        let held_socket = apply_weapon_bore_correction(
                            hand_global.mul(weapon.held.mount),
                            weapon.held,
                        );
                        let corrected_mount = hand_global.inverse().mul(held_socket);
                        pawn.animator.apply_rifle_support_ik_weighted(
                            &mut body.template,
                            corrected_mount,
                            weapon.held.foregrip,
                            weapon.held.foregrip_contact,
                            weapon.ik_weight,
                            weapon.held.support_arm,
                        );
                    }
                }
            }
            let palette = pawn.animator.palette();
            let count = palette.len() as u32;
            let offset = self.renderer.push_skin_palette(palette);
            let rotation = Quat::from_axis_angle(Vec3::Y, pawn.yaw);
            let wx = (nx + 0.5) * WORLD_UNITS_PER_CELL;
            let wz = (ny + 0.5) * WORLD_UNITS_PER_CELL;
            let target_ground_y = props_loader
                .floor_height_at(wx, wz)
                .unwrap_or_else(|| terrain.height_at(wx, wz));
            pawn.ground_y = smooth_ground_height(pawn.ground_y, target_ground_y, dt);
            let pawn_mask = doll_mask_for(&pawn.id);
            for entity in &pawn.entities {
                if let Some(transform) = self.world.get_component::<Transform>(*entity) {
                    transform.pos = vec3(wx, pawn.ground_y, wz);
                    transform.rot = rotation;
                }
                if let Some(renderer) = self.world.get_component::<MeshRenderer>(*entity) {
                    renderer.viewport_mask = pawn_mask;
                    renderer.skin = SkinRef { offset, count };
                }
            }
            if let Some(weapon) = &pawn.weapon {
                let raw_held_socket = body
                    .template
                    .skeleton
                    .bone_global(weapon.hand)
                    .mul(weapon.held.mount);
                let held_socket = if pawn.lane == WeaponLane::Rifle {
                    apply_weapon_bore_correction(raw_held_socket, weapon.held)
                } else {
                    raw_held_socket
                };
                let rig_socket = weapon.stow.map_or(held_socket, |(bone, mount, arc_lift)| {
                    let ease =
                        weapon.stow_blend * weapon.stow_blend * (3.0 - 2.0 * weapon.stow_blend);
                    let blended = interpolate_mount(
                        held_socket,
                        body.template.skeleton.bone_global(bone).mul(mount),
                        ease,
                    );
                    let (mut pos, rotation, scale) = blended.to_trs();
                    pos.y += arc_lift * (core::f32::consts::PI * ease).sin();
                    Mat4::from_trs(pos, rotation, scale)
                });
                let actor_world = Mat4::from_trs(
                    vec3(wx, pawn.ground_y, wz),
                    rotation,
                    vec3(pawn.scale, pawn.scale, pawn.scale),
                );
                for &(entity, local) in &weapon.entities {
                    let part_local = if weapon.plasma_blade == Some(entity) {
                        let (_, rotation, scale) = local.to_trs();
                        Mat4::from_trs(
                            vec3(0.0, 0.0, 0.09 + 0.375 * armed_blend),
                            rotation,
                            vec3(scale.x, scale.y * armed_blend, scale.z),
                        )
                    } else {
                        local
                    };
                    let (pos, rig_rotation, rig_scale) =
                        actor_world.mul(rig_socket).mul(part_local).to_trs();
                    if let Some(transform) = self.world.get_component::<Transform>(entity) {
                        transform.pos = pos;
                        transform.rot = rig_rotation;
                        transform.scale = rig_scale;
                    }
                    if let Some(renderer) = self.world.get_component::<MeshRenderer>(entity) {
                        // Inventory/examine portraits frame the actor silhouette;
                        // the wielded prop has its own rotating item preview.
                        renderer.viewport_mask = 0b1;
                    }
                }
            }
        }

        // 3) Cameras track the player's terrain elevation and eye-level focus.
        let p = self.player_pos();
        let focus = follow_focus(p);
        self.center = p;
        self.renderer.gi_set_focus([p.x, p.y, p.z]);
        let eye = match self.debug_camera {
            Some(orbit) => orbit.eye(p),
            None => follow_eye(p),
        };
        if let Some(cam) = self.world.get_component::<Camera>(self.follow) {
            cam.look_at = focus;
            cam.eye = eye;
        }

        if let Some(player) = self.store.actors.get(&self.store.player_actor_id) {
            self.props_loader.update_cutaways(
                &mut self.world,
                self.store.tick,
                player.x,
                player.y,
                p.y,
                dt,
            );
        }

        {
            let mut read_asset = |stable_id: &str| platform.read_asset(stable_id).ok();
            self.streamed_world.sync(
                &mut self.world,
                &mut self.renderer,
                gpu,
                &self.terrain,
                &self.store,
                &self.area_id,
                &mut read_asset,
                dt,
            );
        }

        // Streamed clock and weather own sun, clear color, grade, fog, and
        // precipitation. The noon/clear build state lasts only until accepted
        // authority sections arrive.
        self.environs.apply_clock(self.store.world_clock());
        let player_cell = self
            .store
            .actors
            .get(&self.player_id)
            .map(|actor| (actor.x, actor.y))
            .unwrap_or((0.0, 0.0));
        self.environs
            .apply_weather(self.store.weather(), &self.area_id, player_cell);
        let env = self.environs.sample(dt);
        let half_height = 12.5 * self.zoom_percent / 100.0;
        let (fog_near, fog_far) = self.environs.fog_range(half_height);
        self.renderer.set_fog(env.fog, fog_near, fog_far);
        self.renderer.set_grade(
            env.bone_tint,
            env.desaturate,
            env.scene_darken,
            env.black_lift,
        );
        let sun_angle = -45.0_f32.to_radians();
        let (sun_sin, sun_cos) = sun_angle.sin_cos();
        if let Some(light) = self.world.get_component::<DirectionalLight>(self.sun) {
            light.dir = vec3(
                env.sun_dir[0] * sun_cos + env.sun_dir[2] * sun_sin,
                env.sun_dir[1],
                -env.sun_dir[0] * sun_sin + env.sun_dir[2] * sun_cos,
            )
            .normalize();
            light.color = env.sun_color;
        }
        if let Some(camera) = self.world.get_component::<Camera>(self.follow) {
            camera.clear.color = Some([env.fog[0], env.fog[1], env.fog[2], 1.0]);
        }
        for (slot, window) in DOLL_WINDOWS.iter().enumerate() {
            let subject = doll_subjects[slot];
            let preview = subject
                .and_then(|_| self.wm.content_rect(window))
                .map(|content| match *window {
                    "inventory" => crate::windows::inventory::layout(content).preview,
                    "character" => crate::windows::character::preview_rect(content),
                    "examine" => crate::windows::live::examine_preview_rect(content),
                    _ => crate::windows::live::converse_preview_rect(content),
                });
            let (Some(subject), Some(preview)) = (subject, preview) else {
                self.dolls[slot].viewport = None;
                let camera = self.dolls[slot].camera;
                let quad = self.dolls[slot].quad;
                self.world.remove_component::<Camera>(camera);
                self.world.remove_component::<CompositeQuad>(quad);
                continue;
            };
            // A collapsed cell renders nothing, matching the original's bail
            // when its clipped widget rect comes out empty.
            if preview[2] <= 1.0 || preview[3] <= 1.0 {
                self.dolls[slot].viewport = None;
                let camera = self.dolls[slot].camera;
                self.world.remove_component::<Camera>(camera);
                self.world
                    .remove_component::<CompositeQuad>(self.dolls[slot].quad);
                continue;
            }
            let (portrait_ground, yaw) = self
                .pawns
                .get(subject)
                .map(|pawn| {
                    let wx = (pawn.render_pos.0 + 0.5) * WORLD_UNITS_PER_CELL;
                    let wz = (pawn.render_pos.1 + 0.5) * WORLD_UNITS_PER_CELL;
                    (vec3(wx, pawn.ground_y, wz), pawn.yaw)
                })
                .unwrap_or((p, 0.0));
            // Framing is preserved while adopting the original's 22.5° FOV:
            // the subject height a camera covers is `2 * d * tan(fovy / 2)`, so
            // pulling the lens in from the old wide angle means pushing the
            // camera back by the ratio of those tangents.
            let (focus_height, prior_distance, prior_fovy): (f32, f32, f32) = match *window {
                "converse" => (1.28, 0.95, 0.58),
                _ => (0.90, 2.75, 0.68),
            };
            let camera_distance =
                prior_distance * (prior_fovy * 0.5).tan() / (PAPERDOLL_FOVY * 0.5).tan();
            let focus = portrait_ground.add(vec3(0.0, focus_height, 0.0));
            // Drag spins the doll; the flick decays and parks at the resting
            // The converse bust looks the player in the eye: camera is dead-on
            // facing the NPC's front (+Z in pawn space). Paperdoll viewers for
            // inventory/character follow pawn yaw + player orbit drag.
            let orbit = if *window == "converse" {
                yaw + core::f32::consts::PI
            } else {
                yaw + self.paperdoll_yaw
            };
            let facing = vec3(orbit.sin(), 0.0, orbit.cos());
            let band = self
                .wm
                .z_rank(window)
                .map_or(0, |rank| rank as i16 * DOLL_BAND);
            let slot_state = &self.dolls[slot];
            self.world.set_component(
                slot_state.camera,
                Camera {
                    viewport_id: doll_viewport(slot),
                    order: -1,
                    projection: Projection::Perspective {
                        fovy: PAPERDOLL_FOVY,
                        near: 0.05,
                        far: 20.0,
                    },
                    target: CamTarget::Texture(slot_state.target),
                    // Transparent behind the doll: the original clears only
                    // depth/stencil for its 3D viewers, leaving the panel
                    // visible around the character.
                    clear: ClearSpec {
                        color: Some([0.0, 0.0, 0.0, 0.0]),
                        depth: Some(1.0),
                    },
                    eye: focus
                        .add(facing.scale(camera_distance))
                        .add(vec3(0.0, 0.08, 0.0)),
                    look_at: focus,
                    up: Vec3::Y,
                },
            );
            self.world.set_component(
                slot_state.quad,
                CompositeQuad {
                    source: slot_state.target,
                    rect: RectNorm {
                        x: preview[0] / w as f32,
                        y: 1.0 - (preview[1] + preview[3]) / h as f32,
                        w: preview[2] / w as f32,
                        h: preview[3] / h as f32,
                    },
                    order: band,
                },
            );
            self.dolls[slot].viewport = Some(preview);
        }
        if self.dolls.iter().all(|slot| slot.viewport.is_none()) {
            self.paperdoll_drag_x = None;
        }
        self.item_previews.sync(
            gpu,
            &mut self.renderer,
            &mut self.world,
            &self.wm,
            &self.win_model,
            w,
            h,
            self.sim_time,
            platform,
            &mut self.streamer,
        );
        // Enterable cutaways advance only against the accepted authority tick.
        // Prefer the same authority actor centre used by the browser renderer;
        // the rendered camera position is only a startup fallback.
        let (cutaway_x, cutaway_z) = self
            .store
            .actors
            .get(&self.store.player_actor_id)
            .map(|actor| {
                (
                    (actor.x + 0.5) * WORLD_UNITS_PER_CELL,
                    (actor.y + 0.5) * WORLD_UNITS_PER_CELL,
                )
            })
            .unwrap_or((p.x, p.z));
        let snapshot_tick = self.store.tick;
        let prop_states = &self.store.prop_states;
        self.props_loader.sync_enterable_presentation(
            &mut self.world,
            snapshot_tick,
            cutaway_x,
            p.y,
            cutaway_z,
            prop_states,
            dt,
        );
        let active_weather = self.environs.active_weather();
        self.weather
            .set(active_weather.kind, active_weather.strength);
        self.weather.update(dt);
        {
            use successor_engine_core::audio::{Point, SpatialOpts};
            const WEATHER_LOOP_KEY: u32 = 0x5745_4154;
            let listener = Point { x: p.x, y: p.z };
            self.sfx.set_listener(listener);
            const MUSIC_LOOP_KEY: u32 = 0x4d55_5343;
            const SETTLEMENT_LOOP_KEY: u32 = 0x5345_5454;

            if let Some((last_x, last_z)) = self.footstep_position {
                let dx = p.x - last_x;
                let dz = p.z - last_z;
                let distance = (dx * dx + dz * dz).sqrt();
                if (0.002..=2.0).contains(&distance) {
                    self.footstep_distance += distance;
                } else if distance > 2.0 {
                    self.footstep_distance = 0.0;
                }
            }
            self.footstep_position = Some((p.x, p.z));
            let stride = if self.sprint_toggle || self.move_intent.2 {
                0.72
            } else {
                0.90
            };
            if self.footstep_distance >= stride {
                self.footstep_distance %= stride;
                let clip = crate::audio::footstep_id(
                    self.footstep_index,
                    self.props_loader.player_inside_enterable(),
                );
                self.sfx.play_at(clip, listener, SpatialOpts::default());
                self.footstep_index = self.footstep_index.wrapping_add(1);
            }

            let in_combat = self
                .store
                .actors
                .get(&self.store.player_actor_id)
                .and_then(|actor| actor.in_combat)
                .unwrap_or(false);
            if in_combat && !self.music_was_in_combat {
                self.music_combat_index = self.music_combat_index.wrapping_add(1);
            }
            self.music_was_in_combat = in_combat;
            if self.area_id == "open-desert-overworld" {
                let minute = self.environs.minute_of_day();
                let is_day = (360.0..1080.0).contains(&minute);
                let desired_music =
                    crate::audio::open_desert_music_id(is_day, in_combat, self.music_combat_index);
                if self.music_audio != Some(desired_music) {
                    self.sfx.stop_loop(MUSIC_LOOP_KEY);
                    self.sfx.play_loop(desired_music, MUSIC_LOOP_KEY, None, 1.0);
                    self.music_audio = Some(desired_music);
                }
                if !self.settlement_audio {
                    self.sfx.play_loop(
                        crate::audio::SETTLEMENT_LOOP,
                        SETTLEMENT_LOOP_KEY,
                        None,
                        0.14,
                    );
                    self.settlement_audio = true;
                }
            } else {
                if self.music_audio.take().is_some() {
                    self.sfx.stop_loop(MUSIC_LOOP_KEY);
                }
                if self.settlement_audio {
                    self.sfx.stop_loop(SETTLEMENT_LOOP_KEY);
                    self.settlement_audio = false;
                }
            }
            let desired =
                crate::audio::weather_loop_id(active_weather.kind, active_weather.strength);
            if desired != self.weather_audio {
                self.sfx.stop_loop(WEATHER_LOOP_KEY);
                if let Some(clip) = desired {
                    self.sfx.play_loop(clip, WEATHER_LOOP_KEY, None, 1.0);
                }
                self.weather_audio = desired;
            }
            self.ambience_timer -= dt.max(0.0);
            if self.ambience_timer <= 0.0 {
                let biome = biome_for_area(&self.slice, &self.area_id);
                let minute = self.environs.minute_of_day();
                let is_day = (360.0..1080.0).contains(&minute);
                let clip = crate::audio::ambience_one_shot(biome, is_day, self.ambience_roll);
                let offset = (self.ambience_roll as f32 * 2.399_963_1).sin_cos();
                self.sfx.play_at(
                    clip,
                    Point {
                        x: p.x + offset.0 * 14.0,
                        y: p.z + offset.1 * 14.0,
                    },
                    SpatialOpts::default(),
                );
                self.ambience_roll = self.ambience_roll.wrapping_add(1);
                self.ambience_timer = 12.0 + (self.ambience_roll % 9) as f32;
            }
        }
        let collision_changed = self.collision_debug.sync_dynamic(
            &mut self.world,
            &self.area_id,
            &self.terrain,
            &self.store.prop_states,
            self.store.building.as_ref(),
        );
        if collision_changed {
            self.movement_collision
                .rebuild(&self.slice, &self.area_id, &self.collision_debug);
        }
        if self.collision_debug.enabled() {
            if let Some(pawn) = self.pawns.get(&self.player_id) {
                self.collision_debug.update_player(
                    &mut self.world,
                    pawn.render_pos,
                    pawn.predictor.authoritative(),
                    pawn.predictor.render_pos(),
                    pawn.ground_y,
                );
            }
        }

        // 5) Render scene → screen (+ minimap composite).
        self.renderer
            .render(gpu, &mut self.world, w, h)
            .expect("render failed");

        // 6) Weather (ambient dust) → the FX pool, then integrate + draw all
        //    billboards over the scene in the follow-camera frame.
        self.weather
            .emit_into(self.combat_fx.pool_mut(), [p.x, 0.0, p.z], 40.0);
        self.combat_fx.update(dt);
        self.decay_muzzle_lights(dt);
        let eye = follow_eye(p);
        let fwd = focus.sub(eye).normalize();
        let right = fwd.cross(Vec3::Y).normalize();
        let up = right.cross(fwd);
        let camera = self
            .world
            .get_component::<Camera>(self.follow)
            .copied()
            .expect("follow camera exists");
        let Projection::Ortho {
            half_height,
            near,
            far,
        } = camera.projection
        else {
            unreachable!("connected camera remains orthographic")
        };
        let aspect = w as f32 / h as f32;
        let vp_mat = Mat4::ortho(
            -half_height * aspect,
            half_height * aspect,
            -half_height,
            half_height,
            near,
            far,
        )
        .mul(Mat4::look_at(camera.eye, camera.look_at, camera.up));
        let vp = vp_mat.to_cols_array();
        // Retained for pointer picking and pointer-shape resolution, which run
        // outside the render borrow and must resolve against the image the
        // player actually saw.
        self.pointer_vp = Some(vp_mat);
        let (r, u) = ([right.x, right.y, right.z], [up.x, up.y, up.z]);
        self.fx_buf.clear();
        let qa = self
            .combat_fx
            .pool()
            .additive
            .fill_billboards(r, u, &mut self.fx_buf);
        self.renderer
            .render_particles(gpu, &self.fx_buf, qa, &vp, true, w, h);
        self.fx_buf.clear();
        let mut qn = self
            .combat_fx
            .pool()
            .normal
            .fill_billboards(r, u, &mut self.fx_buf);
        qn += self
            .combat_fx
            .pool()
            .residue
            .fill_billboards(r, u, &mut self.fx_buf);
        self.renderer
            .render_particles(gpu, &self.fx_buf, qn, &vp, false, w, h);

        // 7) HUD chrome + interactive windows (mouse-routed; action bar toggles
        //    windows, exactly as `--demo ui`).
        let (mx, my) = successor_platform::mouse_position();
        let down = successor_platform::mouse_button_down(0);
        self.ui.set_input(mx, my, down);
        self.ui.begin(w, h);
        self.overlays.update(dt * 1_000.0);
        let palette = hud::palette(self.theme_index);
        // One theme for the whole UI: window surfaces read their ink from the
        // active palette instead of carrying their own literals, so a theme
        // change reaches every frame and not just the HUD.
        hud::set_active_palette(palette);
        if self.collision_debug.enabled() {
            if let Some(movement) = self.movement_diagnostics() {
                draw_movement_debug(&mut self.ui, movement);
            }
        }
        hud::set_fill_opacity(self.hud_opacity);
        let interaction = self
            .nearest_interaction_prop()
            .map(|prop| (prop.label.to_string(), prop.kind == "door", prop.x, prop.y));
        let store = &self.store;
        let terrain = &self.terrain;
        let area_id = self.area_id.as_str();
        let player_position = store
            .actors
            .get(&self.player_id)
            .map(|actor| (actor.x, actor.y));
        let anchor = |actor_id: &str| {
            let actor = store.actors.get(actor_id)?;
            if actor.area_id != area_id {
                return None;
            }
            let world_x = (actor.x + 0.5) * WORLD_UNITS_PER_CELL;
            let world_z = (actor.y + 0.5) * WORLD_UNITS_PER_CELL;
            let world = vec3(
                world_x,
                terrain.height_at(world_x, world_z) + ADULT_PAWN_HEIGHT_METERS + 0.35,
                world_z,
            );
            let ndc = vp_mat.project_point(world);
            (ndc.x >= -1.05
                && ndc.x <= 1.05
                && ndc.y >= -1.05
                && ndc.y <= 1.05
                && ndc.z >= -1.0
                && ndc.z <= 1.0)
                .then_some((
                    (ndc.x * 0.5 + 0.5) * w as f32,
                    (0.5 - ndc.y * 0.5) * h as f32,
                ))
        };

        // Bubbles are range-bound and render first; plates sit in front exactly
        // as the original text manager's depth bias intended.
        self.overlays
            .draw(&mut self.ui, &palette, w as f32, h as f32, |actor_id| {
                let actor = store.actors.get(actor_id)?;
                let player = player_position?;
                let distance = ((actor.x - player.0).powi(2) + (actor.y - player.1).powi(2)).sqrt();
                (distance <= 24.0).then(|| anchor(actor_id)).flatten()
            });

        // Read once: the loop below holds `self.ui` mutably, and standing does
        // not change between nameplates in a frame.
        let viewer_org = store
            .actors
            .get(&store.player_actor_id)
            .or_else(|| store.actors.get(&self.player_id))
            .and_then(|actor| actor.player_organization_id.as_deref())
            .filter(|org| !org.is_empty());
        for (actor_id, actor) in store.actors.iter() {
            if actor_id == &self.player_id {
                continue;
            }
            let Some((screen_x, screen_y)) = anchor(actor_id) else {
                continue;
            };
            let distance = player_position
                .map(|player| ((actor.x - player.0).powi(2) + (actor.y - player.1).powi(2)).sqrt())
                .unwrap_or(0.0);
            if distance > 28.0 {
                continue;
            }
            let opacity = if distance > 18.0 {
                (1.0 - (distance - 18.0) / 10.0).clamp(0.0, 1.0)
            } else {
                1.0
            };
            let life_tag = match actor.life_state.as_str() {
                "downed" => Some("DOWN"),
                "dead" | "respawning" => Some("DEAD"),
                _ => None,
            };
            let pawn = self.pawns.get(actor_id);
            let name = pawn.map(|pawn| pawn.name.as_str()).unwrap_or(actor_id);
            let descriptor = pawn.and_then(|pawn| pawn.descriptor.as_deref());
            hud::overlays::draw_nameplate(
                &mut self.ui,
                &palette,
                name,
                descriptor,
                hud::relation_for(actor, &self.player_id, viewer_org),
                life_tag,
                self.selected_actor_id.as_deref() == Some(actor_id.as_str()),
                opacity,
                screen_x,
                screen_y - hud::overlays::NAMEPLATE_SCREEN_LIFT_PX,
            );
        }

        if let Some((label, door, cell_x, cell_y)) = interaction {
            let world_x = (cell_x + 0.5) * WORLD_UNITS_PER_CELL;
            let world_z = (cell_y + 0.5) * WORLD_UNITS_PER_CELL;
            let world = vec3(world_x, terrain.height_at(world_x, world_z) + 1.45, world_z);
            let ndc = vp_mat.project_point(world);
            if ndc.x >= -1.0 && ndc.x <= 1.0 && ndc.y >= -1.0 && ndc.y <= 1.0 {
                hud::overlays::draw_world_label(
                    &mut self.ui,
                    &palette,
                    &label,
                    Some(if door { "[F] OPEN" } else { "[F] USE" }),
                    (ndc.x * 0.5 + 0.5) * w as f32,
                    (0.5 - ndc.y * 0.5) * h as f32,
                );
            }
        }
        let tuning_open = self.graphics_tuner.is_open();
        let context_open = self.context_menu.is_some();
        self.ui.set_input_enabled(!tuning_open && !context_open);
        let right_down = successor_platform::mouse_button_down(1);
        let right_pressed = right_down && !self.hud_right_was_down;
        self.hud_right_was_down = right_down;
        // `handle_pointer` owns the right-click lock transition so it can
        // suppress gameplay/context routing. Consume its flag here only to
        // gate same-frame HUD controls; never toggle the manager twice.
        let hud_lock_changed = core::mem::take(&mut self.hud_layout_input_consumed);
        let now_ms = successor_platform::now_ms().max(0.0) as u64;
        if !tuning_open && !context_open {
            self.wm.update_at(&self.ui, w, h, now_ms);
        }
        let manager_captured = self.wm.pointer_captured();
        if manager_captured {
            // Focus order can change on a press before a drag completes, and
            // therefore belongs to the same durable workspace record.
            self.window_layout_dirty = true;
        }
        let captured = tuning_open || context_open || manager_captured || hud_lock_changed;
        self.hud_actions.clear();
        let mut hud_frame = hud::HudFrame {
            state: &self.hud_state,
            toolbar: &mut self.toolbar,
            chat: Some((chat_client, chat_input)),
            palette: hud::palette(self.theme_index),
            now_ms,
            captured,
            right_pressed,
        };
        // The chat console is a managed pane, so it draws inside `build_hud`
        // with the rest of the HUD; only its input gate stays here.
        self.ui.set_input_enabled(!captured);
        hud::build_hud(
            &mut self.ui,
            &self.icons,
            &mut hud_frame,
            &self.wm,
            w,
            h,
            &mut self.hud_actions,
        );
        self.ui.set_input_enabled(!tuning_open && !context_open);
        let mut hud_actions = core::mem::take(&mut self.hud_actions);
        for action in hud_actions.drain(..) {
            match action {
                hud::HudAction::ToggleWindow(id) => {
                    self.wm.toggle(id);
                    self.window_layout_dirty = true;
                }
                hud::HudAction::OpenWindow(id) => {
                    self.wm.open(id);
                    self.window_layout_dirty = true;
                }
                hud::HudAction::CycleTheme => {
                    self.theme_index = (self.theme_index + 1) % hud::THEME_COUNT;
                }
                hud::HudAction::RunVerb(verb) => {
                    let gameplay = match verb {
                        "attack" => self.shot_action("basic_shot"),
                        "aimed" => self.shot_action("aimed_shot"),
                        "kneel" | "stand" => Some(actions::GameplayAction::SetPosture {
                            posture: verb.into(),
                        }),
                        "reload" => Some(actions::GameplayAction::Reload {
                            weapon_id: None,
                            ammo_type: None,
                        }),
                        "peace" => Some(actions::GameplayAction::Peace),
                        "clone" => {
                            Some(actions::GameplayAction::CloneRespawn { facility_id: None })
                        }
                        _ => None,
                    };
                    if let Some(gameplay) = gameplay {
                        self.dispatch_gameplay_action(gameplay);
                    }
                }
                hud::HudAction::UseToolbarItem(item_id) => {
                    self.dispatch_gameplay_action(actions::GameplayAction::UseConsumable {
                        item_id,
                    });
                }
                hud::HudAction::ToggleSprint => self.sprint_toggle = !self.sprint_toggle,
                hud::HudAction::GroupAccept => self.dispatch_window_action(
                    crate::windows::WindowAction::Command(ClientCommand::GroupAccept {}),
                ),
                hud::HudAction::GroupDecline => self.dispatch_window_action(
                    crate::windows::WindowAction::Command(ClientCommand::GroupDecline {}),
                ),
                hud::HudAction::CloneRespawn => {
                    self.dispatch_gameplay_action(actions::GameplayAction::CloneRespawn {
                        facility_id: None,
                    });
                }
                action @ (hud::HudAction::RadarSelect(_) | hud::HudAction::RadarMove { .. }) => {
                    self.dispatch_radar_hud_action(action);
                }
                hud::HudAction::QueueCancel(entry_id) => {
                    self.dispatch_gameplay_action(actions::GameplayAction::CancelAbilityQueue {
                        queue_entry_id: Some(entry_id),
                    });
                }
                hud::HudAction::ToolbarChanged => self.preferences_dirty = true,
            }
        }
        self.hud_actions = hud_actions;
        // Windows draw at the window opacity; the HUD already drew at its own.
        hud::set_fill_opacity(self.window_opacity);
        let mut style = hud::window_style(&palette);
        style.fade_fills(self.window_opacity);
        self.wm.fill_z_order(&mut self.window_order);
        for order_index in 0..self.window_order.len() {
            let index = self.window_order[order_index];
            let pane_id = self.wm.window_id(index);
            let hud_pane = hud::is_hud_surface(pane_id);
            // The dark backdrop a composited model needs belongs to the viewer
            // cell, not the whole frame: `chrome::viewer_seat` paints it. A
            // pane-wide override turned an empty examine or converse window
            // into a black rectangle that no theme could reach.
            let window_style = style;
            let rect = self.wm.draw_chrome(&mut self.ui, index, window_style);
            // HUD panes drew their own content and layout affordance in
            // `build_hud`; the chromeless frame adds nothing here.
            if !hud_pane {
                self.window_id_scratch.clear();
                self.window_id_scratch.push_str(pane_id);
                let mut actions = Vec::new();
                crate::windows::content(
                    &mut self.ui,
                    &self.window_id_scratch,
                    rect,
                    &self.win_model,
                    &self.icons,
                    &mut actions,
                );
                for action in actions {
                    self.dispatch_window_action(action);
                }
            }
            // Mark where this window's 2D content ends. Its 3D surfaces are
            // flushed in at this point so later windows paint over them.
            self.composite_marks
                .push((self.ui.quads, order_index as i16));
        }
        if let Some(menu) = self.context_menu {
            self.ui.set_input_enabled(!tuning_open);
            let mut close_menu = false;
            match menu {
                ContextMenu::Actor {
                    x: menu_x,
                    y: menu_y,
                } => {
                    let selected_actor = self.selected_actor_id.as_deref();
                    let can_converse = selected_actor.is_some_and(|selected| {
                        self.win_model
                            .converse
                            .npc
                            .as_ref()
                            .is_some_and(|npc| npc.actor_id == selected)
                    });
                    let can_trade = selected_actor.is_some_and(|selected| {
                        self.win_model
                            .trade
                            .propose_target
                            .as_ref()
                            .is_some_and(|(actor_id, _)| actor_id == selected)
                    });
                    let rows = 3 + usize::from(can_converse) + usize::from(can_trade);
                    let menu_w = 138.0;
                    let row_h = 24.0;
                    let x = menu_x.clamp(4.0, (w as f32 - menu_w - 4.0).max(4.0));
                    let y = menu_y.clamp(4.0, (h as f32 - rows as f32 * row_h - 4.0).max(4.0));
                    let style = successor_engine_render::ui::ButtonStyle {
                        fill: [6, 13, 14, 242],
                        hover: [14, 39, 43, 250],
                        active: [20, 60, 66, 255],
                        edge: [38, 82, 89, 255],
                        text: [220, 234, 235, 255],
                    };
                    let mut action_y = y;
                    if self.ui.button(x, action_y, menu_w, row_h, "Examine", style) {
                        self.open_workspace_window("examine");
                        close_menu = true;
                    }
                    action_y += row_h;
                    if can_converse {
                        if self
                            .ui
                            .button(x, action_y, menu_w, row_h, "Converse", style)
                        {
                            self.open_workspace_window("converse");
                            close_menu = true;
                        }
                        action_y += row_h;
                    }
                    if can_trade {
                        if self.ui.button(x, action_y, menu_w, row_h, "Trade", style) {
                            self.open_workspace_window("trade");
                            close_menu = true;
                        }
                        action_y += row_h;
                    }
                    if self.ui.button(x, action_y, menu_w, row_h, "Group", style) {
                        self.open_workspace_window("group");
                        close_menu = true;
                    }
                    action_y += row_h;
                    if self.ui.button(x, action_y, menu_w, row_h, "Attack", style) {
                        if let Some(target_actor_id) = self.selected_actor_id.clone() {
                            self.dispatch_gameplay_action(actions::GameplayAction::Attack {
                                action_id: "basic_shot".into(),
                                target_actor_id,
                            });
                        }
                        close_menu = true;
                    }
                    let (mx, my) = self.ui.mouse();
                    if self.ui.interact(0.0, 0.0, w as f32, h as f32).pressed
                        && !UiBuilder::hit(x, y, menu_w, rows as f32 * row_h, mx, my)
                    {
                        close_menu = true;
                    }
                }
                ContextMenu::InventoryRadial { x, y } => {
                    let radial = self
                        .selected_inventory
                        .as_ref()
                        .and_then(|(container, stack_id)| {
                            self.win_model.inventory.row(container, stack_id)
                        })
                        .map(|row| {
                            draw_inventory_radial(
                                &mut self.ui,
                                row,
                                (x, y),
                                self.win_model.splice.session.is_some(),
                                (w as f32, h as f32),
                            )
                        });
                    match radial {
                        Some((close, action)) => {
                            if let Some(action) = action {
                                self.dispatch_window_action(action);
                            }
                            close_menu = close;
                        }
                        None => {
                            self.selected_inventory = None;
                            crate::windows::inventory::clear_selection();
                            close_menu = true;
                        }
                    }
                }
            }
            if close_menu {
                self.context_menu = None;
            }
        }
        self.ui.set_input_enabled(true);
        self.graphics_tuner
            .draw(&mut self.ui, &mut self.renderer, gpu, w, h);

        // The pointer is the last thing drawn, after the composite bands
        // below, so no 3D viewer can paint over it. The original hides the
        // desktop cursor and clips the hardware one to the client rect
        // (`Graphics::constrainMouseCursor`); GLFW has no portable clip, so
        // the equivalent is to own the pointer while it is inside the
        // framebuffer and hand it back the moment it leaves.
        let inside = mx >= 0.0 && my >= 0.0 && mx < w as f32 && my < h as f32;
        if inside != self.owns_cursor {
            successor_platform::set_cursor_visible(!inside);
            self.owns_cursor = inside;
        }
        if inside {
            let kind = self.pointer_cursor(mx, my);
            // The pointer is chrome: it takes the frame's tones so a theme
            // change reaches it too. Opacity deliberately does not — a faded
            // cursor is a lost cursor.
            let chrome = hud::window_style(&palette);
            let style = CursorStyle {
                fill: chrome.edge,
                edge: chrome.caption_text,
                accent: palette.ink,
                danger: palette.danger,
                ..CursorStyle::default()
            };
            cursor::draw(
                &mut self.ui,
                kind,
                mx.clamp(0.0, w as f32 - 1.0),
                my.clamp(0.0, h as f32 - 1.0),
                style,
                now_ms,
            );
        }
        // Walk the UI stream window by window: flush the 2D quads drawn so far,
        // then composite the 3D surfaces belonging to that window. Panels drawn
        // later land on top, so several live viewers coexist and none punches
        // through the windows above it. This is the original's per-widget
        // `flushRenderQueue()` then `renderScene()`, one band at a time.
        let mut drawn = 0u32;
        for index in 0..self.composite_marks.len() {
            let (mark, rank) = self.composite_marks[index];
            if mark > drawn {
                let floats = QUAD_FLOATS * drawn as usize..QUAD_FLOATS * mark as usize;
                self.renderer
                    .render_ui(gpu, &self.ui.buf[floats], mark - drawn, w, h);
                drawn = mark;
            }
            let base = rank * DOLL_BAND;
            self.renderer.render_composites_overlay_band(
                gpu,
                &mut self.world,
                w,
                h,
                base..=base + DOLL_BAND - 1,
            );
        }
        if self.ui.quads > drawn {
            let floats = QUAD_FLOATS * drawn as usize..QUAD_FLOATS * self.ui.quads as usize;
            self.renderer
                .render_ui(gpu, &self.ui.buf[floats], self.ui.quads - drawn, w, h);
        }
        self.composite_marks.clear();
    }
}

fn apply_weapon_bore_correction(socket: Mat4, held: HeldWeaponRig) -> Mat4 {
    let grip = socket.transform_point(held.grip);
    let bore = socket.transform_point(held.muzzle).sub(grip).normalize();
    let horizontal_sq = bore.x * bore.x + bore.z * bore.z;
    if horizontal_sq < 1.0e-8 || bore.y.abs() > 0.995 {
        return socket;
    }

    let horizontal_len = horizontal_sq.sqrt();
    let level_bore = vec3(bore.x / horizontal_len, 0.0, bore.z / horizontal_len);
    let pitch_axis = Vec3::Y.cross(level_bore).normalize();
    let pitch = bore.y.clamp(-1.0, 1.0).asin().clamp(-0.6, 0.6);

    let bore_yaw = bore.x.atan2(bore.z);
    let mut yaw = held.resting_yaw_rad - bore_yaw;
    while yaw > core::f32::consts::PI {
        yaw -= core::f32::consts::PI * 2.0;
    }
    while yaw < -core::f32::consts::PI {
        yaw += core::f32::consts::PI * 2.0;
    }
    yaw = yaw.clamp(-0.45, 0.45);
    if pitch.abs() < 1.0e-5 && yaw.abs() < 1.0e-5 {
        return socket;
    }

    let correction = Mat4::from_trs(Vec3::ZERO, Quat::from_axis_angle(Vec3::Y, yaw), Vec3::ONE)
        .mul(Mat4::from_trs(
            Vec3::ZERO,
            Quat::from_axis_angle(pitch_axis, pitch),
            Vec3::ONE,
        ));
    Mat4::from_trs(grip, Quat::IDENTITY, Vec3::ONE)
        .mul(correction)
        .mul(Mat4::from_trs(grip.scale(-1.0), Quat::IDENTITY, Vec3::ONE))
        .mul(socket)
}

fn interpolate_mount(from: Mat4, to: Mat4, t: f32) -> Mat4 {
    let t = t.clamp(0.0, 1.0);
    let (from_pos, from_rot, from_scale) = from.to_trs();
    let (to_pos, to_rot, to_scale) = to.to_trs();
    Mat4::from_trs(
        vec3(
            from_pos.x + (to_pos.x - from_pos.x) * t,
            from_pos.y + (to_pos.y - from_pos.y) * t,
            from_pos.z + (to_pos.z - from_pos.z) * t,
        ),
        quat_slerp(from_rot, to_rot, t),
        vec3(
            from_scale.x + (to_scale.x - from_scale.x) * t,
            from_scale.y + (to_scale.y - from_scale.y) * t,
            from_scale.z + (to_scale.z - from_scale.z) * t,
        ),
    )
}

fn quat_slerp(from: Quat, mut to: Quat, t: f32) -> Quat {
    let mut dot = from.x * to.x + from.y * to.y + from.z * to.z + from.w * to.w;
    if dot < 0.0 {
        dot = -dot;
        to = Quat {
            x: -to.x,
            y: -to.y,
            z: -to.z,
            w: -to.w,
        };
    }
    if dot > 0.9995 {
        return Quat {
            x: from.x + (to.x - from.x) * t,
            y: from.y + (to.y - from.y) * t,
            z: from.z + (to.z - from.z) * t,
            w: from.w + (to.w - from.w) * t,
        }
        .normalize();
    }
    let theta = dot.clamp(-1.0, 1.0).acos();
    let sin_theta = theta.sin();
    let from_weight = ((1.0 - t) * theta).sin() / sin_theta;
    let to_weight = (t * theta).sin() / sin_theta;
    Quat {
        x: from.x * from_weight + to.x * to_weight,
        y: from.y * from_weight + to.y * to_weight,
        z: from.z * from_weight + to.z * to_weight,
        w: from.w * from_weight + to.w * to_weight,
    }
    .normalize()
}

/// Faction id → a tint bias rgb (best-effort; unknown factions untinted).
fn faction_rgb(faction: &str) -> [f32; 3] {
    match faction {
        f if f.contains("red") || f.contains("raider") => [0.8, 0.25, 0.2],
        f if f.contains("blue") || f.contains("law") => [0.3, 0.4, 0.8],
        f if f.contains("green") => [0.3, 0.6, 0.3],
        _ => [0.5, 0.5, 0.5],
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn converge_speed(hz: u32) -> f32 {
        let dt = 1.0 / hz as f32;
        let mut speed = 0.0;
        for _ in 0..hz {
            speed = filtered_gait_speed(speed, 4.0 * dt, dt);
        }
        speed
    }

    #[test]
    fn gait_speed_filter_is_frame_rate_independent_and_fail_closed() {
        let at_30 = converge_speed(30);
        assert!((at_30 - converge_speed(60)).abs() < 1.0e-4);
        assert!((at_30 - converge_speed(120)).abs() < 1.0e-4);
        assert_eq!(filtered_gait_speed(2.5, 1.0, 0.0), 2.5);
        assert_eq!(filtered_gait_speed(2.5, 2.01, 1.0 / 60.0), 0.0);
    }

    #[test]
    fn ground_height_hysteresis_smooths_floor_transitions_and_snaps_teleports() {
        assert_eq!(smooth_ground_height(1.0, 1.02, 1.0 / 60.0), 1.0);
        let first = smooth_ground_height(1.0, 1.5, 1.0 / 60.0);
        assert!((first - 1.1).abs() < 1.0e-6, "first={first}");
        let mut height = 1.0;
        for _ in 0..120 {
            height = smooth_ground_height(height, 1.5, 1.0 / 60.0);
        }
        assert!((height - 1.475).abs() < 1.0e-5, "height={height}");
        assert_eq!(smooth_ground_height(1.0, 4.0, 1.0 / 60.0), 4.0);
    }

    #[test]
    fn follow_camera_is_locked_north_up_sixty_degree_ortho() {
        let ground = vec3(10.0, 2.0, 20.0);
        let focus = follow_focus(ground);
        let eye = follow_eye(ground);
        assert!((focus.y - 2.9).abs() < 1.0e-6);
        assert!((eye.sub(focus).length() - 96.0).abs() < 1.0e-4);
        assert!((eye.x - focus.x).abs() < 1.0e-6);
        assert!(eye.y > focus.y && eye.z > focus.z);
    }

    #[test]
    fn weapon_mount_interpolation_reaches_held_and_stowed_endpoints() {
        let held = Mat4::from_trs(vec3(0.0, 0.0, 0.0), Quat::IDENTITY, vec3(1.0, 1.0, 1.0));
        let stowed = Mat4::from_trs(
            vec3(0.16, 0.0, -0.14),
            Quat::from_axis_angle(Vec3::Y, core::f32::consts::FRAC_PI_2),
            vec3(1.0, 1.0, 1.0),
        );
        assert_eq!(interpolate_mount(held, stowed, 0.0), held);
        let (end, _, _) = interpolate_mount(held, stowed, 1.0).to_trs();
        assert!((end.x - 0.16).abs() < 1.0e-5);
        assert!((end.z + 0.14).abs() < 1.0e-5);
        let (mid, mid_rotation, _) = interpolate_mount(held, stowed, 0.5).to_trs();
        assert!((mid.x - 0.08).abs() < 1.0e-5);
        let norm = mid_rotation.x * mid_rotation.x
            + mid_rotation.y * mid_rotation.y
            + mid_rotation.z * mid_rotation.z
            + mid_rotation.w * mid_rotation.w;
        assert!((norm - 1.0).abs() < 1.0e-5);
    }

    #[test]
    fn bore_correction_levels_pitch_and_rotates_yaw_around_the_grip() {
        let socket = Mat4::from_trs(
            vec3(0.4, 1.2, -0.3),
            Quat::from_axis_angle(vec3(1.0, 0.0, 0.0), -0.24),
            Vec3::ONE,
        );
        let held = HeldWeaponRig {
            mount: Mat4::IDENTITY,
            grip: vec3(0.02, 0.01, 0.1),
            foregrip: vec3(0.0, 0.0, 0.4),
            muzzle: vec3(0.02, 0.01, 0.9),
            foregrip_contact: Vec3::ZERO,
            resting_yaw_rad: 0.12,
            support_arm: None,

            support_hand: true,
        };
        let grip_before = socket.transform_point(held.grip);
        let corrected = apply_weapon_bore_correction(socket, held);
        let grip_after = corrected.transform_point(held.grip);
        assert!(grip_after.sub(grip_before).length() < 1.0e-5);
        let bore = corrected.transform_point(held.muzzle).sub(grip_after);
        assert!(bore.normalize().y.abs() < 1.0e-5);
        assert!((bore.x.atan2(bore.z) - held.resting_yaw_rad).abs() < 1.0e-5);
    }

    #[test]
    fn presentation_identity_detects_live_loadout_changes() {
        let mut actor: GameActorSnapshot = serde_json::from_str(
            r##"{
                "id":"dev-1",
                "appearance":{"skin":"#cc9978","hair":"hair_short","hair_mat":"hair_raven"},
                "factionId":"desert-law",
                "sprite":"wanderer-female",
                "role":"player",
                "worn":[{"item":"under_tank","colors":["#89cff0"]}],
                "weapon":{"weaponId":"wpn-smg","weaponItemId":3111}
            }"##,
        )
        .expect("actor snapshot");
        let presentation = PawnPresentation {
            skin: Some("#cc9978".into()),
            faction: Some("desert-law".into()),
            sprite: Some("wanderer-female".into()),
            role: Some("player".into()),
            hair: Some("hair_short".into()),
            hair_material: Some("hair_raven".into()),
            worn: vec![WornPresentation {
                item_id: "under_tank".into(),
                colors: vec!["#89cff0".into()],
            }],
            weapon: Some("wpn-smg".into()),
            weapon_item_id: Some(3111),
        };
        assert!(presentation.matches(&actor));

        actor.weapon.as_mut().unwrap().weapon_item_id = Some(3112);
        assert!(
            !presentation.matches(&actor),
            "weapon model change respawns"
        );
        actor.weapon.as_mut().unwrap().weapon_item_id = Some(3111);
        actor.worn[0].item_id = Some("under_bodysuit".into());
        assert!(!presentation.matches(&actor), "wardrobe change respawns");
        actor.worn[0].item_id = Some("under_tank".into());
        actor.worn[0].colors[0] = "#303030".into();
        assert!(
            !presentation.matches(&actor),
            "wardrobe color change respawns"
        );
    }
    #[test]
    fn window_layout_round_trips_known_finite_bounds_only() {
        let mut manager = successor_engine_render::window::WindowManager::new();
        manager.register(
            "inventory",
            "INVENTORY",
            None,
            [10.0, 20.0, 500.0, 400.0],
            320.0,
            240.0,
        );
        restore_window_layout(
            &mut manager,
            Some(&serde_json::json!({
                "schema": WINDOW_LAYOUT_SCHEMA,
                "viewport": [1280.0, 720.0],
                "windows": [
                    {"id": "inventory", "bounds": [33.0, 44.0, 660.0, 521.0]},
                    {"id": "missing", "bounds": [1.0, 2.0, 3.0, 4.0]},
                    {"id": "inventory", "bounds": ["bad", 2.0, 3.0, 4.0]}
                ]
            })),
        );
        assert_eq!(manager.rect("inventory"), Some([33.0, 44.0, 660.0, 521.0]));

        let saved = save_window_layout(&manager, (1280.0, 720.0));
        assert_eq!(
            saved.get("schema").and_then(serde_json::Value::as_str),
            Some(WINDOW_LAYOUT_SCHEMA)
        );
        assert_eq!(
            saved["windows"][0]["bounds"],
            serde_json::json!([33.0, 44.0, 660.0, 521.0])
        );
    }

    #[test]
    fn persisted_hud_workspace_keeps_bounds_visibility_order_and_lock() {
        let icons = crate::hud::Icons::load();
        let viewport = (1280.0, 1024.0);
        let mut source = successor_engine_render::window::WindowManager::new();
        crate::hud::register_hud_surfaces_at(&mut source, &icons, viewport);
        assert!(crate::hud::set_hud_surface_locked(
            &mut source,
            crate::hud::PLAYER_STATUS_ID,
            false
        ));
        assert!(source.set_rect(crate::hud::PLAYER_STATUS_ID, [90.0, 70.0, 360.0, 220.0]));
        source.close(crate::hud::TARGET_STATUS_ID);
        source.open(crate::hud::COMMAND_BAR_ID);
        let saved = save_window_layout(&source, viewport);

        let mut restored = successor_engine_render::window::WindowManager::new();
        crate::hud::register_hud_surfaces_at(&mut restored, &icons, viewport);
        let missing = restore_window_layout(&mut restored, Some(&saved));

        assert_eq!(missing, [false; crate::hud::HUD_SURFACE_COUNT]);
        assert_eq!(
            restored.rect(crate::hud::PLAYER_STATUS_ID),
            Some([90.0, 70.0, 360.0, 220.0])
        );
        assert!(restored.is_interactive(crate::hud::PLAYER_STATUS_ID));
        assert!(!restored.is_open(crate::hud::TARGET_STATUS_ID));
        let order = restored.z_order();
        assert_eq!(
            restored.window_id(*order.last().expect("command bar is open")),
            crate::hud::COMMAND_BAR_ID
        );
    }

    #[test]
    fn hud_surfaces_re_anchor_when_the_framebuffer_changes() {
        let icons = crate::hud::Icons::load();
        let small = (1280.0, 720.0);
        let large = (1728.0, 1052.0);

        let mut source = successor_engine_render::window::WindowManager::new();
        crate::hud::register_hud_surfaces_at(&mut source, &icons, small);
        let saved = save_window_layout(&source, small);

        // The stamp decides, not the restore. A scene is constructed before its
        // first framebuffer exists, so matching a document at restore time
        // matches it against a placeholder and strands the band at 720p.
        assert_eq!(layout_viewport(Some(&saved)), Some(small));
        assert!(!hud_anchor_is_stale(Some(small), small));
        assert!(hud_anchor_is_stale(Some(small), large));
        assert!(
            hud_anchor_is_stale(None, small),
            "a document with no viewport stamp is foreign and re-anchors"
        );

        // Restoring 720p rects onto a larger viewport really does strand the
        // bottom band mid-screen: that is the regression this guards.
        let mut grown = successor_engine_render::window::WindowManager::new();
        crate::hud::register_hud_surfaces_at(&mut grown, &icons, large);
        restore_window_layout(&mut grown, Some(&saved));
        let stranded = grown.rect(crate::hud::CHAT_CONSOLE_ID).expect("chat rect");
        assert!(
            stranded[1] + stranded[3] < large.1 - 64.0,
            "the restored 720p rect sits mid-screen, got {stranded:?}"
        );

        // Reconciling against the live framebuffer pulls it back to the edge.
        crate::hud::apply_missing_hud_surface_defaults(
            &mut grown,
            large,
            &[true; crate::hud::HUD_SURFACE_COUNT],
        );
        let chat = grown.rect(crate::hud::CHAT_CONSOLE_ID).expect("chat rect");
        assert!(
            chat[1] + chat[3] > large.1 - 64.0,
            "chat console stays anchored to the bottom edge, got {chat:?}"
        );
    }

    #[test]
    fn one_pawn_is_visible_in_the_world_and_every_viewer_showing_it() {
        let player = "player-1";
        let npc = "npc-7";

        // Inventory + character sheet both open on the player, examine on an
        // NPC. The player must reach the world and BOTH of its viewers.
        let mut subjects: [Option<&str>; DOLL_WINDOWS.len()] = [None; DOLL_WINDOWS.len()];
        subjects[0] = Some(player);
        subjects[1] = Some(player);
        subjects[2] = Some(npc);

        let player_mask = doll_viewport_mask(&subjects, player);
        assert!(player_mask & 1 != 0, "the world view is never dropped");
        assert!(player_mask & (1 << doll_viewport(0)) != 0, "inventory doll");
        assert!(player_mask & (1 << doll_viewport(1)) != 0, "character doll");
        assert_eq!(
            player_mask & (1 << doll_viewport(2)),
            0,
            "the player does not render into someone else's examine viewer"
        );

        let npc_mask = doll_viewport_mask(&subjects, npc);
        assert_eq!(npc_mask, 1 | (1 << doll_viewport(2)));

        // A pawn nobody is viewing stays world-only.
        assert_eq!(doll_viewport_mask(&subjects, "bystander"), 1);
    }

    #[test]
    fn viewer_bands_never_collide_and_follow_window_order() {
        // Item lanes ride inside their window's band, so the last lane of one
        // window must still sort below the next window's doll.
        let lanes = crate::item_preview::INVENTORY_LANES as i16;
        assert!(
            lanes + 1 < DOLL_BAND,
            "a window band holds its doll plus every item lane"
        );
        for rank in 0..8i16 {
            let base = rank * DOLL_BAND;
            let last_lane = base + 1 + lanes;
            assert!(
                last_lane < (rank + 1) * DOLL_BAND,
                "band {rank} overflows into the window above it"
            );
        }
    }

    #[test]
    fn every_viewer_and_item_lane_fits_the_viewport_mask() {
        // 32 mask bits total: world, one per viewer, then the icon lanes.
        let lanes = crate::item_preview::INVENTORY_LANES + 1;
        let highest = 5 + lanes - 1;
        assert_eq!(doll_viewport(0), 1);
        assert_eq!(doll_viewport(DOLL_WINDOWS.len() - 1), 4);
        assert!(
            highest < 32,
            "viewport ids must stay inside the u32 mask, got {highest}"
        );
    }

    #[test]
    fn permanent_key_registry_uses_every_advertised_badge() {
        let expected = [
            (Key::C, "character"),
            (Key::I, "inventory"),
            (Key::P, "datapad"),
            (Key::K, "skills"),
            (Key::B, "actions"),
            (Key::M, "macros"),
            (Key::O, "options"),
            (Key::G, "pa"),
        ];
        for (key, window) in expected {
            assert_eq!(ConnectedScene::permanent_window_for_key(key), Some(window));
            assert!(CONNECTED_INPUT_KEYS.contains(&key));
        }
    }

    #[test]
    fn shift_c_is_reserved_for_collision_debug_while_plain_c_remains_character() {
        assert!(ConnectedScene::collision_debug_chord(Key::C, true));
        assert!(!ConnectedScene::collision_debug_chord(Key::C, false));
        assert!(!ConnectedScene::collision_debug_chord(Key::I, true));
        assert_eq!(
            ConnectedScene::permanent_window_for_key(Key::C),
            Some("character")
        );
    }

    #[test]
    fn context_routes_require_authoritative_terminal_or_corpse_state() {
        assert_eq!(
            ConnectedScene::interaction_window_for_kind("trade-terminal"),
            Some("trade")
        );
        assert_eq!(
            ConnectedScene::interaction_window_for_kind("bank-terminal"),
            Some("bank")
        );
        assert_eq!(
            ConnectedScene::interaction_window_for_kind("decorative-prop"),
            None
        );
        let corpses = vec![
            serde_json::json!({"id":"far","areaId":"a","x":13.0,"y":10.0}),
            serde_json::json!({"id":"near","areaId":"a","cellX":11,"cellY":10}),
            serde_json::json!({"id":"other-area","areaId":"b","x":10.0,"y":10.0}),
        ];
        assert_eq!(
            nearest_loot_corpse_id(&corpses, "a", (10.0, 10.0)),
            Some("near")
        );
    }

    #[test]
    fn escape_dismisses_context_then_modal_then_focused_frame() {
        let mut manager = successor_engine_render::window::WindowManager::new();
        manager.register(
            "inventory",
            "INVENTORY",
            None,
            [10.0, 20.0, 500.0, 400.0],
            320.0,
            240.0,
        );
        manager.open("inventory");
        let mut menu = Some(ContextMenu::Actor { x: 10.0, y: 10.0 });
        let mut tuner = crate::graphics_tuning::GraphicsTuner::new();
        tuner.handle_toggle(true);

        assert!(dismiss_context_or_focused(
            &mut menu,
            &mut tuner,
            &mut manager
        ));
        assert!(menu.is_none());
        assert!(tuner.is_open());
        assert!(manager.is_open("inventory"));

        assert!(dismiss_context_or_focused(
            &mut menu,
            &mut tuner,
            &mut manager
        ));
        assert!(!tuner.is_open());
        assert!(manager.is_open("inventory"));

        assert!(dismiss_context_or_focused(
            &mut menu,
            &mut tuner,
            &mut manager
        ));
        assert!(!manager.is_open("inventory"));
    }

    #[test]
    fn equipped_inventory_radial_routes_to_typed_unequip() {
        let row = crate::windows::InventoryRow {
            container: "player:pack".into(),
            stack_id: "vest-1".into(),
            item: "FIELD JACKET".into(),
            item_id: 9001,
            variant_id: 4,
            available: 2,
            equipped: true,
            ..Default::default()
        };
        let mut actions = [InventoryRadialAction::Examine; 6];
        let count = inventory_radial_actions(&row, false, &mut actions);
        assert_eq!(
            &actions[..count],
            &[
                InventoryRadialAction::Unequip,
                InventoryRadialAction::Examine,
                InventoryRadialAction::Drop,
                InventoryRadialAction::Split,
            ]
        );
        assert!(matches!(
            inventory_radial_window_action(&row, InventoryRadialAction::Unequip),
            Some(crate::windows::WindowAction::Command(
                ClientCommand::SetEquippedClothing {
                    equipped: false,
                    ..
                }
            ))
        ));
        assert_eq!(
            inventory_radial_window_action(&row, InventoryRadialAction::Splice),
            Some(crate::windows::WindowAction::OpenWindow("splice".into()))
        );
    }

    #[test]
    fn only_identified_local_chat_becomes_spatial_prose() {
        let local = ChatMessage {
            channel: ChatChannel::Local,
            sender_id: "actor-7".into(),
            sender: "Rook".into(),
            text: "Meet me by the terminal.".into(),
            whisper_to: None,
        };
        assert_eq!(
            spatial_chat_payload(&local),
            Some(("actor-7", "Meet me by the terminal."))
        );
        let mut global = local.clone();
        global.channel = ChatChannel::Global;
        assert!(spatial_chat_payload(&global).is_none());
        let mut anonymous = local;
        anonymous.sender_id.clear();
        assert!(spatial_chat_payload(&anonymous).is_none());
    }
}

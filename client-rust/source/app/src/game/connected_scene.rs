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

use successor_client_proto::packets::{
    GameCommandReceipt, GameServerPacket, GameShardDelta, GameShardSnapshot,
};
use successor_engine_core::ecs::{Entity, WorldOps};
use successor_engine_core::input::Key;
use successor_engine_core::math::{vec3, Mat4, Quat, Vec3};
use successor_engine_render::components::{
    CamTarget, Camera, CompositeQuad, DirectionalLight, MeshRenderer, Projection, RectNorm,
    SkinRef, Transform,
};
use successor_engine_render::gpu::{ClearSpec, Filter, Gpu, RenderTargetDesc};
use successor_engine_render::renderer::Renderer;
use successor_engine_render::{environment, fx::glow_sprite};
use successor_net::ClientCommand;

use crate::game::actions::{self, DispatchOutcome};
use crate::game::authority::AuthorityStore;
use crate::game::combat_fx::CombatFx;
use crate::game::command_queue::CommandQueue;
use crate::game::interp::ActorInterp;
use crate::game::movement;
use crate::game::prediction::MovePredictor;
use crate::hud::{self, HudState, Icons};
use crate::pawn::animator::{PawnAnimator, WeaponLane};
use crate::pawn::appearance::{faction_tinted, skin_tint, weapon_lane};
use crate::pawn::catalog::{rig_for_weapon_id, route_for, BodyRoute, PawnCatalog};
use crate::world::area::{biome_for_area, effective_world_seed};
use crate::world::chunks::TerrainStreamer;
use crate::world::environs::Environs;
use crate::world::props::{building_terrain_exclusions, PropsLoader};
use crate::world::streamed::StreamedWorld;
use crate::world::terrain::Biome;
use crate::world::{ADULT_PAWN_HEIGHT_METERS, WORLD_UNITS_PER_CELL};
use crate::GameWorld;

/// A rigid weapon attachment, updated from its animated hand socket each frame.
struct WeaponAttachment {
    entities: Vec<(Entity, Mat4)>,
    hand: usize,
}

/// A rendered pawn for one live actor: one entity per body/equipment part.
struct ActorPawn {
    id: String,
    name: String,
    descriptor: Option<String>,
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
    speed: f32,
    yaw: f32,
    present: bool,
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
    worn: Vec<String>,
    weapon: Option<String>,
    alive: bool,
    lifecycle_seq: i64,
}

pub type PersistedSections = (
    Option<serde_json::Value>,
    Option<serde_json::Value>,
    Option<serde_json::Value>,
    Option<serde_json::Value>,
    Option<serde_json::Value>,
);

pub struct ConnectedScene {
    pub world: GameWorld,
    pub renderer: Renderer,
    pub store: AuthorityStore,
    pawn_catalog: PawnCatalog,
    terrain: TerrainStreamer,
    slice: successor_engine_core::json::Json,
    props_loader: PropsLoader,
    loaded_area_id: String,
    streamed_world: StreamedWorld,
    pawns: HashMap<String, ActorPawn>,
    missing_pawns: Vec<String>,
    center: Vec3,
    follow: Entity,
    sun: Entity,
    minimap: Entity,
    combat_fx: CombatFx,
    fx_buf: Vec<f32>,
    icons: Icons,
    ui: successor_engine_render::ui::UiBuilder,
    hud_state: HudState,
    overlays: hud::overlays::Overlays,
    last_dialogue_tick: i64,
    toolbar: hud::toolbar::Toolbar,
    waypoints: hud::waypoints::WaypointStore,
    macro_runtime: crate::game::macro_runtime::MacroRuntime,
    macro_actions: Vec<actions::GameplayAction>,
    hud_actions: Vec<hud::HudAction>,
    theme_index: usize,
    dust_strength: f32,
    split_snap: u32,
    rebind_pending: Option<usize>,
    preferences_dirty: bool,
    pending_bug_report: Option<serde_json::Value>,
    bug_report_sequence: u32,
    right_was_down: bool,
    framebuffer: (u32, u32),
    selected_actor_id: Option<String>,
    left_was_down: bool,
    pointer_prev: (f32, f32),
    zoom_percent: f32,
    key_was_down: [bool; Key::COUNT],
    /// Persistent sprint toggle (X), independent of held Shift.
    sprint_toggle: bool,
    window_order: Vec<usize>,
    window_id_scratch: String,
    wm: successor_engine_render::window::WindowManager,
    win_model: crate::windows::WindowModel,
    graphics_tuner: crate::graphics_tuning::GraphicsTuner,
    command_queue: Option<CommandQueue>,
    pending_window_commands: Vec<u64>,
    window_rejection: Option<String>,
    weather: successor_engine_render::weather::Weather,
    environs: Environs,
    #[cfg(not(target_arch = "wasm32"))]
    sfx: crate::audio::SfxPlayer,
    #[cfg(not(target_arch = "wasm32"))]
    weather_audio: Option<&'static str>,
    #[cfg(not(target_arch = "wasm32"))]
    ambience_timer: f32,
    #[cfg(not(target_arch = "wasm32"))]
    ambience_roll: u32,
    player_id: String,
    shard_id: String,
    area_id: String,
    /// Transient muzzle-flash point lights: (entity, remaining seconds).
    muzzle_lights: Vec<(Entity, f32)>,
    sim_time: f32,
    move_intent: (i32, i32, bool),
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

        // Follow camera (screen) + minimap (RTT → composite corner).
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
        let rt = gpu.create_render_target(&RenderTargetDesc {
            width: 256,
            height: 256,
            color: true,
            depth: true,
            filter: Filter::Linear,
        });
        let minimap = world.spawn();
        world.set_component(
            minimap,
            Camera {
                viewport_id: 1,
                order: -1,
                projection: Projection::Ortho {
                    half_height: 40.0,
                    near: 0.1,
                    far: 400.0,
                },
                target: CamTarget::Texture(rt),
                clear: ClearSpec {
                    color: Some([0.06, 0.07, 0.05, 1.0]),
                    depth: Some(1.0),
                },
                eye: center.add(vec3(0.0, 160.0, 0.0)),
                look_at: center,
                up: vec3(0.0, 0.0, -1.0),
            },
        );
        let cq = world.spawn();
        world.set_component(
            cq,
            CompositeQuad {
                source: rt,
                rect: RectNorm {
                    x: 0.76,
                    y: 0.74,
                    w: 0.23,
                    h: 0.23,
                },
                order: 0,
            },
        );

        // Combat FX + HUD.
        let glow = glow_sprite(64);
        renderer.set_particle_atlas(gpu, 64, 64, &glow);
        let icons = Icons::load();
        renderer.set_ui_atlas(gpu, icons.meta.width, icons.meta.height, &icons.rgba);
        let ui = successor_engine_render::ui::UiBuilder::new(icons.meta);
        // Interactive window manager: register the game windows with cascaded
        // bounds + toolbar icons (opened from the action bar).
        let mut wm = successor_engine_render::window::WindowManager::new();
        let mut window_index = 0usize;
        for (id, title, icon, _) in crate::hud::PERMANENT_WINDOWS {
            let ox = 360.0 + (window_index % 6) as f32 * 40.0;
            let oy = 120.0 + (window_index % 6) as f32 * 40.0;
            wm.register(
                id,
                title,
                icons.cell(icon),
                [ox, oy, 380.0, 300.0],
                220.0,
                150.0,
            );
            window_index += 1;
        }
        for (id, title, icon) in crate::hud::CONTEXT_WINDOWS {
            let ox = 360.0 + (window_index % 6) as f32 * 40.0;
            let oy = 120.0 + (window_index % 6) as f32 * 40.0;
            wm.register(
                id,
                title,
                icons.cell(icon),
                [ox, oy, 380.0, 300.0],
                220.0,
                150.0,
            );
            window_index += 1;
        }
        let weather = successor_engine_render::weather::Weather::new(0x0d3d);
        #[cfg(not(target_arch = "wasm32"))]
        let sfx = {
            let mut player = crate::audio::SfxPlayer::new();
            if let Some(manifest) = read_asset("successor-audio/sfx/manifest.json")
                .and_then(|bytes| String::from_utf8(bytes).ok())
            {
                player.load_with(&manifest, read_asset);
            }
            player
        };

        Ok(Self {
            world,
            renderer,
            store: AuthorityStore::new(),
            pawn_catalog,
            terrain: streamer,
            pawns: HashMap::new(),
            missing_pawns: Vec::with_capacity(32),
            follow,
            slice,
            props_loader: loader,
            sun,
            loaded_area_id: String::new(),
            streamed_world: StreamedWorld::new(),
            minimap,
            combat_fx: CombatFx::new(0x51ce_57ed),
            fx_buf: Vec::with_capacity(64 * 1024),
            icons,
            ui,
            hud_state: HudState::default(),
            overlays: hud::overlays::Overlays::new(),
            last_dialogue_tick: i64::MIN,
            toolbar: hud::toolbar::Toolbar::new(hud::toolbar::ToolbarDoc::blank()),
            waypoints: hud::waypoints::WaypointStore::new(),
            macro_runtime: crate::game::macro_runtime::MacroRuntime::default(),
            macro_actions: Vec::with_capacity(crate::game::macro_runtime::STEPS_PER_TICK_MAX),
            hud_actions: Vec::with_capacity(8),
            theme_index: 0,
            dust_strength: 0.5,
            split_snap: 100,
            rebind_pending: None,
            preferences_dirty: false,
            pending_bug_report: None,
            bug_report_sequence: 0,
            right_was_down: false,
            left_was_down: false,
            pointer_prev: (0.0, 0.0),
            zoom_percent: 100.0,
            key_was_down: [false; Key::COUNT],
            sprint_toggle: false,
            framebuffer: (1280, 720),
            selected_actor_id: None,
            wm,
            window_order: Vec::with_capacity(32),
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
            #[cfg(not(target_arch = "wasm32"))]
            sfx,
            #[cfg(not(target_arch = "wasm32"))]
            weather_audio: None,
            #[cfg(not(target_arch = "wasm32"))]
            ambience_timer: 1.0,
            #[cfg(not(target_arch = "wasm32"))]
            ambience_roll: 0,
            area_id: String::new(),
            center,
            muzzle_lights: Vec::with_capacity(32),
            sim_time: 0.0,
            move_intent: (0, 0, false),
        })
    }

    pub fn on_snapshot(&mut self, snap: &GameShardSnapshot) {
        self.shard_id = snap.shard_id.clone();
        self.area_id = snap
            .actors
            .get(&snap.player_actor_id)
            .map(|a| a.area_id.clone())
            .unwrap_or_default();
        self.store.apply_snapshot(snap);
        self.project_windows();
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
                } else if let Some(position) = player_position {
                    self.on_player_pos(position.0, position.1);
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
        let player_cell = player.map(|actor| (actor.x, actor.y)).unwrap_or((0.0, 0.0));
        let mut context = ProjectContext {
            selected_actor_id: self.selected_actor_id.clone(),
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
                (distance <= 2.5).then_some(TrainerView {
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
                    in_range: true,
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
        self.hud_state.project(
            &self.store,
            &self.player_id,
            self.selected_actor_id.as_deref(),
        );
        if let Some(weapon) = &self.win_model.character.player.weapon {
            let melee = weapon.weapon_id.contains("sword") || weapon.weapon_id.contains("melee");
            let reloading = weapon.reload_remaining_ticks > 0;
            self.hud_state.weapon = Some(hud::WeaponHud {
                label: weapon.weapon_id.replace(['_', '-'], " ").to_uppercase(),
                melee,
                magazine_size: weapon.magazine_size.max(0) as u32,
                loaded_rounds: weapon.loaded_rounds.max(0) as u32,
                rounds_text: if melee {
                    if reloading {
                        "RECOVERING…".into()
                    } else {
                        "READY".into()
                    }
                } else if reloading {
                    "REARMING…".into()
                } else {
                    format!(
                        "{}/{}",
                        weapon.loaded_rounds.max(0),
                        weapon.magazine_size.max(0)
                    )
                },
                reloading,
                reload_frac: if reloading { 0.0 } else { 1.0 },
                swing_ready: !reloading,
                swing_frac: if reloading { 0.0 } else { 1.0 },
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
                    "AUTO-SAMPLE · {} TICKS",
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
            .map(|seconds| format!("CAMP COLLAPSE · {:02}:{:02}", seconds / 60, seconds % 60));
        self.hud_state.extraction_toast = self
            .win_model
            .survey
            .extractors
            .iter()
            .find(|extractor| extractor.vm.collectable_units > 0)
            .map(|extractor| hud::BannerHud {
                text: format!(
                    "{} · {} READY",
                    extractor.vm.family_label.to_uppercase(),
                    extractor.vm.collectable_units
                ),
                bad: false,
                until_ms: successor_platform::now_ms() as u64 + 2_000,
            });
        let dialogue_floor = self.last_dialogue_tick;
        for delivery in self
            .win_model
            .converse
            .deliveries
            .iter()
            .filter(|delivery| delivery.tick > dialogue_floor)
        {
            self.overlays
                .push_bubble(&delivery.actor_id, &delivery.body);
            self.last_dialogue_tick = self.last_dialogue_tick.max(delivery.tick);
        }
        self.hud_state.interact = if let Some((_, kind)) = self.nearest_interaction_prop() {
            Some(hud::InteractHud {
                label: format!("[F] {}", kind.replace(['_', '-'], " ").to_uppercase()),
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
        self.hud_state.crosshair = true;
    }
    pub fn on_player_pos(&mut self, x: f32, y: f32) {
        self.store.apply_player_position(x, y);
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
    pub fn load_persisted(
        &mut self,
        theme: Option<&serde_json::Value>,
        toolbar: Option<&serde_json::Value>,
        split_snap: Option<&serde_json::Value>,
        waypoints: Option<&serde_json::Value>,
        macros: Option<&serde_json::Value>,
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
        self.preferences_dirty = false;
        self.project_windows();
    }

    pub fn take_persisted(&mut self) -> PersistedSections {
        let local = self.preferences_dirty;
        self.preferences_dirty = false;
        let waypoint = self.waypoints.dirty();
        let macros = self.macro_runtime.dirty();
        let result = (
            local.then(|| serde_json::Value::String(hud::THEME_IDS[self.theme_index].into())),
            local.then(|| self.toolbar.doc.save()),
            local.then(|| serde_json::Value::from(self.split_snap)),
            waypoint.then(|| self.waypoints.save()),
            macros.then(|| self.macro_runtime.save()),
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

    /// Install the authenticated session queue. Until installed, command
    /// intents are rejected visibly rather than assigned a synthetic identity.
    pub fn pointer_captured(&self) -> bool {
        self.graphics_tuner.is_open() || self.wm.pointer_captured()
    }
    pub fn set_command_queue(&mut self, queue: CommandQueue) {
        self.command_queue = Some(queue);
        self.project_windows();
    }

    /// Restore renderer-neutral connected state after the browser recreates a
    /// lost WebGL context. GPU resources come from `Self::build`; authority and
    /// input state survive without reconnecting or replaying launch tickets.
    pub fn restore_projection_from(&mut self, previous: &Self) {
        self.store = previous.store.clone();
        self.command_queue = previous.command_queue.clone();
        self.pending_window_commands = previous.pending_window_commands.clone();
        self.window_rejection = previous.window_rejection.clone();
        self.selected_actor_id = previous.selected_actor_id.clone();
        self.zoom_percent = previous.zoom_percent;
        self.sprint_toggle = previous.sprint_toggle;
        self.theme_index = previous.theme_index;
        self.dust_strength = previous.dust_strength;
        self.split_snap = previous.split_snap;
        self.shard_id.clone_from(&previous.shard_id);
        self.area_id.clone_from(&previous.area_id);
        self.move_intent = previous.move_intent;
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

    pub fn focused_window_id(&self) -> Option<String> {
        self.wm
            .z_order()
            .last()
            .map(|index| self.wm.window_id(*index).to_owned())
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
            return;
        };
        match actions::enqueue_window_action(queue, action, self.store.tick) {
            DispatchOutcome::Queued(id) => self.pending_window_commands.push(id),
            DispatchOutcome::Rejected(reason) => self.window_rejection = Some(reason),
            DispatchOutcome::Local(local) => self.apply_local_window_action(local),
        }
    }

    /// Queue a gameplay action. Authority-owned state changes only after a receipt.
    pub fn dispatch_gameplay_action(&mut self, action: actions::GameplayAction) -> Option<u64> {
        let queue = self.command_queue.as_mut()?;
        actions::enqueue_action(queue, action, self.store.tick)
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

    /// Feed the held authority movement intent into local prediction.
    pub fn set_move_intent(&mut self, dx: i32, dy: i32, sprint: bool) {
        self.move_intent = (dx, dy, sprint);
    }
    fn nearest_interaction_prop(&self) -> Option<(String, String)> {
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
                let x = cell
                    .get("x")
                    .and_then(successor_engine_core::json::Json::as_f32)?;
                let y = cell
                    .get("y")
                    .and_then(successor_engine_core::json::Json::as_f32)?;
                let distance = ((x - player.x).powi(2) + (y - player.y).powi(2)).sqrt();
                let id = prop
                    .get("id")
                    .and_then(successor_engine_core::json::Json::as_str)?;
                let kind = prop
                    .get("kind")
                    .and_then(successor_engine_core::json::Json::as_str)?;
                (distance <= 2.5).then_some((id.to_string(), kind.to_string(), distance))
            })
            .min_by(|left, right| left.2.total_cmp(&right.2))
            .map(|(id, kind, _)| (id, kind))
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

    /// gameplay verbs are returned for the host to enqueue through the queue.
    pub fn handle_key(&mut self, key: Key, down: bool) -> Option<actions::GameplayAction> {
        let index = key as usize;
        let pressed = down && !self.key_was_down[index];
        self.key_was_down[index] = down;
        if !pressed {
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
        if self.toolbar.press_code(code, &mut self.hud_actions) {
            return None;
        }
        #[cfg(not(target_arch = "wasm32"))]
        crate::audio::play_ui(&mut self.sfx, crate::audio::UiCue::ButtonTick);
        match key {
            Key::I => self.wm.toggle("inventory"),
            Key::C => self.wm.toggle("character"),
            Key::Semicolon => self.wm.toggle("datapad"),
            Key::O => self.wm.toggle("options"),
            Key::Tab => self.wm.toggle("actions"),
            Key::V => self.wm.toggle("skills"),
            Key::N => self.wm.toggle("build"),
            Key::X => self.sprint_toggle = !self.sprint_toggle,
            Key::R => {
                return Some(actions::GameplayAction::Reload {
                    weapon_id: None,
                    ammo_type: None,
                })
            }
            Key::Space => {
                let target = self
                    .store
                    .actors
                    .keys()
                    .find(|id| id.as_str() != self.store.player_actor_id)
                    .cloned()?;
                return Some(actions::GameplayAction::Attack {
                    action_id: "basic_shot".into(),
                    target_actor_id: target,
                });
            }
            Key::F => {
                if let Some((prop_id, kind)) = self.nearest_interaction_prop() {
                    if kind.contains("door") {
                        return Some(actions::GameplayAction::ToggleDoor { prop_id });
                    }
                    let window = if kind.contains("bank") {
                        Some("bank")
                    } else if kind.contains("clone") {
                        Some("clone")
                    } else if kind.contains("factory") {
                        Some("craft")
                    } else if kind.contains("travel") {
                        Some("travel")
                    } else if kind.contains("guild") || kind.contains("association") {
                        Some("pa")
                    } else {
                        None
                    };
                    if let Some(window) = window {
                        self.project_windows();
                        self.wm.open(window);
                        return None;
                    }
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
        if captured {
            return None;
        }
        let picked_actor = if self.framebuffer.0 > 0 && self.framebuffer.1 > 0 {
            let camera = self.world.get_component::<Camera>(self.follow).copied();
            camera.and_then(|camera| {
                let aspect = self.framebuffer.0 as f32 / self.framebuffer.1 as f32;
                let Projection::Ortho {
                    half_height,
                    near,
                    far,
                } = camera.projection
                else {
                    return None;
                };
                let vp = Mat4::ortho(
                    -half_height * aspect,
                    half_height * aspect,
                    -half_height,
                    half_height,
                    near,
                    far,
                )
                .mul(Mat4::look_at(camera.eye, camera.look_at, camera.up));
                self.store
                    .actors
                    .iter()
                    .filter(|(id, actor)| {
                        id.as_str() != self.store.player_actor_id
                            && actor.area_id == self.area_id
                            && actor.life_state != "respawning"
                    })
                    .filter_map(|(id, actor)| {
                        let wx = (actor.x + 0.5) * WORLD_UNITS_PER_CELL;
                        let wz = (actor.y + 0.5) * WORLD_UNITS_PER_CELL;
                        let world = vec3(wx, self.terrain.height_at(wx, wz) + 0.9, wz);
                        let ndc = vp.project_point(world);
                        let sx = (ndc.x * 0.5 + 0.5) * self.framebuffer.0 as f32;
                        let sy = (0.5 - ndc.y * 0.5) * self.framebuffer.1 as f32;
                        let d2 = (sx - x) * (sx - x) + (sy - y) * (sy - y);
                        (d2 <= 32.0 * 32.0).then_some((id.clone(), d2))
                    })
                    .min_by(|a, b| a.1.total_cmp(&b.1))
                    .map(|(id, _)| id)
            })
        } else {
            None
        };
        if right_pressed && !left {
            if let Some(target_id) = picked_actor.clone() {
                self.selected_actor_id = Some(target_id.clone());
                self.project_windows();
                return Some(actions::GameplayAction::Interact {
                    verb: "radial".into(),
                    target_id,
                });
            }
        }
        self.right_was_down = right;
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
            self.project_windows();
            return None;
        }
        self.selected_actor_id = None;
        self.project_windows();
        let center_x = self.framebuffer.0 as f32 * 0.5;
        let center_y = self.framebuffer.1 as f32 * 0.5;
        let mx = if (x - center_x).abs() < 8.0 {
            0
        } else {
            (x - center_x).signum() as i32
        };
        let my = if (y - center_y).abs() < 8.0 {
            0
        } else {
            (y - center_y).signum() as i32
        };
        Some(actions::GameplayAction::Move {
            dx: mx,
            dy: my,
            facing: movement::facing_from_intent(mx, my),
            sprint: self.sprint_toggle,
        })
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
        #[cfg(not(target_arch = "wasm32"))]
        let accepted_door = accepted
            && self.command_queue.as_ref().is_some_and(|queue| {
                queue.pending_envelopes().any(|envelope| {
                    envelope.command_id == command_id
                        && matches!(
                            envelope.command,
                            ClientCommand::ToggleDoor { .. }
                                | ClientCommand::BuildToggleDoor { .. }
                        )
                })
            });
        if let Some(queue) = self.command_queue.as_mut() {
            queue.settle(command_id);
        }
        self.store.last_receipt = Some(GameCommandReceipt {
            command_id,
            accepted,
            tick: self.store.tick,
            reason_code: reason.clone(),
        });
        #[cfg(not(target_arch = "wasm32"))]
        if accepted_door {
            self.sfx.play_ui(crate::audio::DOOR_CLIP);
        }
        if !accepted {
            self.window_rejection = Some(reason.unwrap_or_else(|| "command rejected".into()));
        }
    }

    fn apply_local_window_action(&mut self, local: crate::windows::WindowLocalAction) {
        use crate::windows::WindowLocalAction::*;
        match local {
            Close => self.window_rejection = Some("local: close".into()),
            Select(id) => self.window_rejection = Some(format!("local: select {id}")),
            OpenWindow(id) => self.wm.open(&id),
            SetTheme(i) => {
                self.theme_index = i % hud::THEME_COUNT;
                self.preferences_dirty = true;
                self.project_windows();
            }
            SetDust(v) => {
                self.dust_strength = v.clamp(0.0, 1.0);
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
            #[cfg(not(target_arch = "wasm32"))]
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

    /// The player's current world position (falls back to the slice centre).
    pub fn player_pos(&self) -> Vec3 {
        let (x, z) = if let Some(p) = self.pawns.get(&self.player_id) {
            (
                (p.render_pos.0 + 0.5) * WORLD_UNITS_PER_CELL,
                (p.render_pos.1 + 0.5) * WORLD_UNITS_PER_CELL,
            )
        } else if let Some(actor) = self.store.actors.get(&self.player_id) {
            (
                (actor.x + 0.5) * WORLD_UNITS_PER_CELL,
                (actor.y + 0.5) * WORLD_UNITS_PER_CELL,
            )
        } else {
            return self.center;
        };
        vec3(x, self.terrain.height_at(x, z), z)
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
    #[allow(clippy::too_many_arguments)]
    fn spawn_pawn<G: Gpu>(
        &mut self,
        gpu: &mut G,
        read_asset: &mut dyn FnMut(&str) -> Option<Vec<u8>>,
        actor: &LiveActor,
        faction: Option<[f32; 3]>,
    ) {
        let requested = route_for(actor.sprite.as_deref(), &actor.id);
        let route = if self
            .pawn_catalog
            .body_for(gpu, &mut self.renderer, read_asset, requested)
            .is_some()
        {
            requested
        } else {
            BodyRoute::Human { female: false }
        };
        let (part_meshes, scale, joints, hand, animator) = {
            let body = self
                .pawn_catalog
                .body_mut(route)
                .expect("required fallback body loaded");
            (
                body.part_meshes
                    .iter()
                    .map(|(mesh, _)| *mesh)
                    .collect::<Vec<_>>(),
                body.scale,
                body.template.joint_count(),
                body.template
                    .skeleton
                    .find_bone("RightHand")
                    .or_else(|| body.template.skeleton.find_bone("Hand"))
                    .or_else(|| body.template.skeleton.find_bone("hand")),
                PawnAnimator::new(&body.template),
            )
        };

        let mut equipment_ids = actor.worn.clone();
        if equipment_ids.is_empty() && matches!(route, BodyRoute::Human { .. }) {
            let mut defaults = Vec::new();
            self.pawn_catalog.default_outfit(
                &actor.id,
                actor.role.as_deref(),
                actor.hair.as_deref(),
                &mut defaults,
            );
            equipment_ids.extend(defaults.into_iter().map(str::to_string));
        }
        let mut equipment_meshes = Vec::new();
        for item_id in &equipment_ids {
            if let Some(piece) = self.pawn_catalog.equipment_piece(
                gpu,
                &mut self.renderer,
                read_asset,
                item_id,
                joints,
            ) {
                equipment_meshes.extend(piece.part_meshes.iter().copied());
            }
        }

        let base = skin_tint(actor.skin.as_deref());
        let color = faction_tinted(base, faction);
        let body_material =
            self.renderer
                .add_material_desc(successor_engine_render::renderer::MaterialDesc {
                    base_color: color,
                    blend: color[3] < 1.0,
                    ..successor_engine_render::renderer::MaterialDesc::default()
                });
        let mut entities = Vec::with_capacity(part_meshes.len() + equipment_meshes.len());
        for (mesh, material) in part_meshes
            .into_iter()
            .map(|mesh| (mesh, body_material))
            .chain(equipment_meshes)
        {
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
                    viewport_mask: 0b11,
                    skin: SkinRef::NONE,
                },
            );
            entities.push(e);
        }

        let weapon = rig_for_weapon_id(actor.weapon.as_deref())
            .and_then(|kind| {
                self.pawn_catalog
                    .weapon_rig(gpu, &mut self.renderer, read_asset, kind)
                    .map(|rig| rig.parts.clone())
            })
            .zip(hand)
            .map(|(parts, hand)| {
                let mut weapon_entities = Vec::with_capacity(parts.len());
                for (mesh, material, local) in parts {
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
                            viewport_mask: 0b11,
                            skin: SkinRef::NONE,
                        },
                    );
                    weapon_entities.push((entity, local));
                }
                WeaponAttachment {
                    entities: weapon_entities,
                    hand,
                }
            });

        self.pawns.insert(
            actor.id.clone(),
            ActorPawn {
                id: actor.id.clone(),
                name: actor.name.clone(),
                descriptor: actor
                    .role
                    .as_deref()
                    .map(|role| hud::sanitize_text(role, 32))
                    .filter(|role| !role.is_empty()),
                entities,
                weapon,
                animator,
                route,
                lane: weapon_lane(actor.weapon.as_deref()),
                scale,
                interp: {
                    let mut interp = ActorInterp::new();
                    interp.push(self.sim_time, actor.x, actor.y, actor.lifecycle_seq);
                    interp
                },
                predictor: MovePredictor::new(actor.x, actor.y),
                lifecycle_seq: actor.lifecycle_seq,
                alive: actor.alive,
                target: (actor.x, actor.y),
                render_pos: (actor.x, actor.y),
                speed: 0.0,
                yaw: 0.0,
                present: true,
            },
        );
    }

    fn sync_active_area<G: Gpu>(
        &mut self,
        gpu: &mut G,
        read_asset: &mut dyn FnMut(&str) -> Option<Vec<u8>>,
    ) {
        if self.area_id.is_empty() || self.loaded_area_id == self.area_id {
            return;
        }
        let area_id = self.area_id.clone();
        let player = self.player_pos();
        self.props_loader.clear(&mut self.world);
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
        let placed = self.props_loader.load(
            &mut self.world,
            &mut self.renderer,
            gpu,
            &self.slice,
            &terrain,
            Some(&area_id),
            read_asset,
            0b1,
        );
        self.terrain = terrain;
        self.loaded_area_id = area_id;
        eprintln!(
            "connected: active area {} streamed, {placed} props placed",
            self.loaded_area_id
        );
    }

    /// Per-frame: reconcile pawns with the authoritative actor set, animate, and
    /// render the full scene + FX + HUD.
    pub fn frame<G: Gpu>(
        &mut self,
        gpu: &mut G,
        w: u32,
        h: u32,
        dt: f32,
        read_asset: &mut dyn FnMut(&str) -> Option<Vec<u8>>,
    ) {
        self.framebuffer = (w, h);
        self.sync_active_area(gpu, read_asset);
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
        for (id, actor) in self.store.render_actors() {
            if !self.pawns.contains_key(id) {
                self.missing_pawns.push(id.clone());
            }
            if let Some(pawn) = self.pawns.get_mut(id) {
                pawn.present = true;
                let authority_changed =
                    pawn.target != (actor.x, actor.y) || pawn.lifecycle_seq != actor.lifecycle_seq;
                pawn.target = (actor.x, actor.y);
                pawn.alive = actor.life_state == "alive";
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
                worn: actor
                    .worn
                    .iter()
                    .filter_map(|piece| piece.item_id.clone())
                    .collect(),
                weapon: actor
                    .weapon
                    .as_ref()
                    .and_then(|weapon| weapon.weapon_id.clone()),
                alive: actor.life_state == "alive",
                lifecycle_seq: actor.lifecycle_seq,
            };
            let faction = live.faction.as_deref().map(faction_rgb);
            self.spawn_pawn(gpu, read_asset, &live, faction);
        }
        self.sim_time += dt.max(0.0);

        // 2) Animate + place pawns (skinned).
        self.renderer.begin_skin_frame();
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
            let (nx, ny) = if pawn.id == self.player_id {
                pawn.predictor.predict(
                    self.move_intent.0 as f32,
                    self.move_intent.1 as f32,
                    self.move_intent.2,
                    1.0,
                    dt,
                );
                pawn.predictor.render_pos()
            } else {
                pawn.interp.sample(self.sim_time).unwrap_or(pawn.target)
            };
            let moved = ((nx - rx) * (nx - rx) + (ny - ry) * (ny - ry)).sqrt();
            let instantaneous_speed = if dt > 0.0 { moved / dt } else { 0.0 };
            pawn.speed = pawn.speed * 0.72 + instantaneous_speed * 0.28;
            if moved > 1e-4 {
                pawn.yaw = (nx - rx).atan2(ny - ry);
            }
            pawn.render_pos = (nx, ny);

            let body = self
                .pawn_catalog
                .body_mut(pawn.route)
                .expect("spawned pawn body remains loaded");
            let palette = pawn.animator.update(
                &mut body.template,
                pawn.lane,
                pawn.speed,
                false,
                pawn.alive,
                dt,
            );
            let count = palette.len() as u32;
            let offset = self.renderer.push_skin_palette(palette);
            let rotation = Quat::from_axis_angle(Vec3::Y, pawn.yaw);
            let wx = (nx + 0.5) * WORLD_UNITS_PER_CELL;
            let wz = (ny + 0.5) * WORLD_UNITS_PER_CELL;
            let ground_y = self.terrain.height_at(wx, wz);
            for entity in &pawn.entities {
                if let Some(transform) = self.world.get_component::<Transform>(*entity) {
                    transform.pos = vec3(wx, ground_y, wz);
                    transform.rot = rotation;
                }
                if let Some(renderer) = self.world.get_component::<MeshRenderer>(*entity) {
                    renderer.skin = SkinRef { offset, count };
                }
            }
            if let Some(weapon) = &pawn.weapon {
                let socket = body.template.skeleton.bone_global(weapon.hand);
                let actor_world = Mat4::from_trs(
                    vec3(wx, ground_y, wz),
                    rotation,
                    vec3(pawn.scale, pawn.scale, pawn.scale),
                );
                for &(entity, local) in &weapon.entities {
                    let (pos, rig_rotation, rig_scale) =
                        actor_world.mul(socket).mul(local).to_trs();
                    if let Some(transform) = self.world.get_component::<Transform>(entity) {
                        transform.pos = pos;
                        transform.rot = rig_rotation;
                        transform.scale = rig_scale;
                    }
                }
            }
        }

        // 3) Cameras track the player's terrain elevation and eye-level focus.
        let p = self.player_pos();
        let focus = follow_focus(p);
        self.center = p;
        self.renderer.gi_set_focus([p.x, p.y, p.z]);
        if let Some(cam) = self.world.get_component::<Camera>(self.follow) {
            cam.look_at = focus;
            cam.eye = follow_eye(p);
        }
        if let Some(cam) = self.world.get_component::<Camera>(self.minimap) {
            cam.eye = p.add(vec3(0.0, 160.0, 0.0));
            cam.look_at = p;
        }

        self.streamed_world.sync(
            &mut self.world,
            &mut self.renderer,
            gpu,
            &self.terrain,
            &self.store,
            &self.area_id,
            read_asset,
            dt,
        );

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
        let active_weather = self.environs.active_weather();
        self.weather
            .set(active_weather.kind, active_weather.strength);
        self.weather.update(dt);
        #[cfg(not(target_arch = "wasm32"))]
        {
            use successor_engine_core::audio::{Point, SpatialOpts};
            const WEATHER_LOOP_KEY: u32 = 0x5745_4154;
            let listener = Point { x: p.x, y: p.z };
            self.sfx.set_listener(listener);
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
        let anchor = |actor_id: &str| {
            let actor = self.store.actors.get(actor_id)?;
            if actor.area_id != self.area_id {
                return None;
            }
            let wx = (actor.x + 0.5) * WORLD_UNITS_PER_CELL;
            let wz = (actor.y + 0.5) * WORLD_UNITS_PER_CELL;
            let world = vec3(
                wx,
                self.terrain.height_at(wx, wz) + ADULT_PAWN_HEIGHT_METERS + 0.35,
                wz,
            );
            let ndc = vp_mat.project_point(world);
            (ndc.z >= -1.0 && ndc.z <= 1.0).then_some((
                (ndc.x * 0.5 + 0.5) * w as f32,
                (0.5 - ndc.y * 0.5) * h as f32,
            ))
        };
        for (actor_id, actor) in self.store.actors.iter() {
            if actor_id == &self.player_id {
                continue;
            }
            let Some((sx, sy)) = anchor(actor_id) else {
                continue;
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
                hud::relation_for(actor, &self.player_id),
                life_tag,
                sx,
                sy + 8.0,
            );
        }
        self.overlays
            .draw(&mut self.ui, &palette, w as f32, h as f32, anchor);
        let tuning_open = self.graphics_tuner.is_open();
        self.ui.set_input_enabled(!tuning_open);
        if !tuning_open {
            self.wm.update(&self.ui, w, h);
        }
        let captured = tuning_open || self.wm.pointer_captured();
        let now_ms = successor_platform::now_ms().max(0.0) as u64;
        let right_down = successor_platform::mouse_button_down(1);
        let right_pressed = right_down && !self.right_was_down;
        self.right_was_down = right_down;
        self.hud_actions.clear();
        let mut hud_frame = hud::HudFrame {
            state: &self.hud_state,
            toolbar: &mut self.toolbar,
            palette: hud::palette(self.theme_index),
            now_ms,
            captured,
            right_pressed,
        };
        hud::build_hud(
            &mut self.ui,
            &self.icons,
            &mut hud_frame,
            w,
            h,
            &mut self.hud_actions,
        );
        let mut hud_actions = core::mem::take(&mut self.hud_actions);
        for action in hud_actions.drain(..) {
            match action {
                hud::HudAction::ToggleWindow(id) => self.wm.toggle(id),
                hud::HudAction::OpenWindow(id) => self.wm.open(id),
                hud::HudAction::CycleTheme => {
                    self.theme_index = (self.theme_index + 1) % hud::THEME_COUNT;
                }
                hud::HudAction::RunVerb(verb) => {
                    let gameplay = match verb {
                        "attack" => self.selected_actor_id.clone().map(|target_actor_id| {
                            actions::GameplayAction::Attack {
                                action_id: "basic_shot".into(),
                                target_actor_id,
                            }
                        }),
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
                hud::HudAction::RadarSelect(actor_id) => {
                    self.selected_actor_id = Some(actor_id);
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
                hud::HudAction::QueueCancel(entry_id) => {
                    self.dispatch_gameplay_action(actions::GameplayAction::CancelAbilityQueue {
                        queue_entry_id: Some(entry_id),
                    });
                }
                hud::HudAction::ToolbarChanged => self.preferences_dirty = true,
            }
        }
        self.hud_actions = hud_actions;
        let style = successor_engine_render::window::WindowStyle::default();
        self.wm.fill_z_order(&mut self.window_order);
        for order_index in 0..self.window_order.len() {
            let index = self.window_order[order_index];
            let rect = self.wm.draw_chrome(&mut self.ui, index, style);
            self.window_id_scratch.clear();
            self.window_id_scratch.push_str(self.wm.window_id(index));
            let mut actions = Vec::new();
            crate::windows::content(
                &mut self.ui,
                &self.window_id_scratch,
                rect,
                &self.win_model,
                &self.icons,
                &mut actions,
            );
            for a in actions {
                self.dispatch_window_action(a);
            }
        }
        self.ui.set_input_enabled(true);
        self.graphics_tuner
            .draw(&mut self.ui, &mut self.renderer, gpu, w, h);
        self.renderer
            .render_ui(gpu, &self.ui.buf, self.ui.quads, w, h);
    }
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
}

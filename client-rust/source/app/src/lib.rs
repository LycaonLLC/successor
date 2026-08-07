//! Successor Rust client — composition root (library side).
//!
//! Binds the engine, renderer, and (native) platform + protocol into the
//! `GameWorld` and the demo/playable runners. The native binary is `main.rs`;
//! the wasm cdylib exports live here behind `target_arch = "wasm32"`.

pub mod audio;
pub mod assets;
#[cfg(all(feature = "alloc-count", not(target_arch = "wasm32")))]
pub mod alloc_trace;
pub mod demo;
pub mod game;
#[cfg(not(target_arch = "wasm32"))]
pub mod glb_scene;
pub mod graphics_tuning;
pub mod hosted_creator;
pub mod hud;
mod item_preview;
pub mod material_parity;
pub mod net;
pub mod pawn;
pub mod persist;
pub mod render_settings;
pub mod rss;
pub mod screens;
pub mod windows;
pub mod world;
use successor_platform::Platform;

pub struct App<P: Platform> {
    pub mode: AppMode,
    pub platform: P,
    pub settings: RuntimeSettings,
    pub fatal_error: Option<String>,
}

/// Renderer-neutral application state. Native and WebGL2 shells only provide
/// platform services; this state machine owns mode transitions and frame time.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AppMode {
    Entry,
    CharacterSelect,
    Loading,
    Connected,
    Fatal,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UiTheme {
    Signal,
    Phosphor,
    Amber,
    Oxide,
}

#[derive(Clone, Debug, PartialEq)]
pub struct RuntimeSettings {
    pub mouse_sensitivity: f32,
    pub orthographic_zoom_percent: u16,
    /// Workspace frame pane opacity. The original exposes window transparency
    /// as a player setting; fills fade, type and the bright perimeter do not.
    pub window_opacity: f32,
    /// HUD pane opacity, separate because the HUD sits over gameplay the whole
    /// session while a window is transient.
    pub hud_opacity: f32,
    pub ui_theme: UiTheme,
    pub dust_edge_fog: f32,
    pub inventory_split_snap: u32,
    pub toolbar_hotkeys: [u16; 12],
}

impl Default for RuntimeSettings {
    fn default() -> Self {
        Self {
            mouse_sensitivity: 1.0,
            orthographic_zoom_percent: 100,
            window_opacity: 0.92,
            hud_opacity: 0.90,
            ui_theme: UiTheme::Signal,
            dust_edge_fog: 0.5,
            inventory_split_snap: 100,
            toolbar_hotkeys: [0; 12],
        }
    }
}

/// A persisted opacity outside the usable band is not clamped to the extreme:
/// a value of zero would hide the UI and read as a broken client, so a corrupt
/// row resets to its default.
fn normalized_opacity(value: f32, default: f32) -> f32 {
    if value.is_finite() && (hud::MIN_UI_OPACITY..=hud::MAX_UI_OPACITY).contains(&value) {
        value
    } else {
        default
    }
}

impl RuntimeSettings {
    /// Normalize fields independently; movement remains available even when
    /// persisted data is corrupt or partially missing.
    pub fn normalized(mut self) -> Self {
        if !self.mouse_sensitivity.is_finite() || self.mouse_sensitivity <= 0.0 {
            self.mouse_sensitivity = 1.0;
        }
        if !(55..=125).contains(&self.orthographic_zoom_percent) {
            self.orthographic_zoom_percent = 100;
        }
        if !matches!(self.inventory_split_snap, 1 | 5 | 10 | 100 | 1000 | 10000) {
            self.inventory_split_snap = 100;
        }
        if !self.dust_edge_fog.is_finite() || !(0.0..=1.0).contains(&self.dust_edge_fog) {
            self.dust_edge_fog = 0.5;
        }
        self.window_opacity = normalized_opacity(self.window_opacity, 0.92);
        self.hud_opacity = normalized_opacity(self.hud_opacity, 0.90);
        self
    }
}

impl<P: Platform> App<P> {
    pub fn new(platform: P) -> Self {
        Self {
            mode: AppMode::Entry,
            platform,
            settings: RuntimeSettings::default(),
            fatal_error: None,
        }
    }
    pub fn fail(&mut self, message: impl Into<String>) {
        let message = message.into();
        self.mode = AppMode::Fatal;
        self.fatal_error = Some(message.clone());
        self.platform.report_fatal(&message);
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AssetRequirement {
    Required,
    Optional,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AssetSpec {
    pub stable_id: &'static str,
    pub requirement: AssetRequirement,
}

pub struct AssetCatalog {
    pub specs: &'static [AssetSpec],
}

impl AssetCatalog {
    pub fn load<P: Platform>(&self, platform: &P) -> Result<usize, String> {
        let mut loaded = 0;
        for spec in self.specs {
            match platform.read_asset(spec.stable_id) {
                Ok(_) => loaded += 1,
                Err(error) if spec.requirement == AssetRequirement::Required => {
                    return Err(format!(
                        "required asset {} unavailable: {error:?}",
                        spec.stable_id
                    ))
                }
                Err(_) => {}
            }
        }
        Ok(loaded)
    }
}
use successor_engine_core::world;
use successor_engine_render::components::{
    Camera, CompositeQuad, DirectionalLight, HeightCutaway, MeshRenderer, ModelRef, PointLight,
    TextOverlay, Transform,
};

// The concrete ECS world: the render component set (Transform/Mesh/Camera/…)
// plus `ModelRef` so asset-key prefabs resolve into `MeshRenderer`s.
world! { pub struct GameWorld {
    transform: Transform,
    model: ModelRef,
    mesh: MeshRenderer,
    cutaway: HeightCutaway,
    camera: Camera,
    light: DirectionalLight,
    point_light: PointLight,
    composite: CompositeQuad,
    text: TextOverlay,
} }

// --- render quality selection (process-global; set from `--quality`/`?quality=`) ---
use core::sync::atomic::{AtomicU8, Ordering};
use successor_engine_render::gpu::Gpu;
use successor_engine_render::renderer::{RenderQuality, Renderer, RendererLimits};

static RENDER_QUALITY: AtomicU8 = AtomicU8::new(1); // 0=Low, 1=Medium, 2=High

/// Set the process-wide render quality tier (call before building any scene).
pub fn set_render_quality(q: RenderQuality) {
    let v = match q {
        RenderQuality::Low => 0,
        RenderQuality::Medium => 1,
        RenderQuality::High => 2,
    };
    RENDER_QUALITY.store(v, Ordering::Relaxed);
}

/// Parse a quality string (`low`/`medium`/`high`); unknown → Medium.
pub fn parse_quality(s: &str) -> RenderQuality {
    match s {
        "low" => RenderQuality::Low,
        "high" => RenderQuality::High,
        _ => RenderQuality::Medium,
    }
}

/// Current render quality tier.
pub fn render_quality() -> RenderQuality {
    match RENDER_QUALITY.load(Ordering::Relaxed) {
        0 => RenderQuality::Low,
        2 => RenderQuality::High,
        _ => RenderQuality::Medium,
    }
}

pub fn initialize_render_settings() {
    render_settings::initialize();
    set_render_quality(render_settings::selected_preset().render_quality());
}

fn active_preset() -> render_settings::PresetSettings {
    let preset = match render_quality() {
        RenderQuality::Low => render_settings::QualityPreset::Low,
        RenderQuality::Medium => render_settings::QualityPreset::Medium,
        RenderQuality::High => render_settings::QualityPreset::High,
    };
    render_settings::document().preset(preset).clone()
}

/// Renderer limits at the current quality tier (tier-derived shadow size).
pub fn quality_limits() -> RendererLimits {
    let quality = render_quality();
    let preset = active_preset();
    RendererLimits {
        quality,
        shadow_size: preset.shadows.map_size,
        shadow_world_radius: preset.shadows.world_radius,
        ..RendererLimits::default()
    }
}

/// Construct a renderer with the active preset already applied. Scene-specific
/// fog and time-of-day grading may layer on top; mastering controls remain
/// process-global and data-driven.
pub fn configured_renderer<G: Gpu>(gpu: &mut G) -> Result<Renderer, String> {
    let preset = active_preset();
    let mut renderer = Renderer::new(gpu, quality_limits())
        .map_err(|error| format!("renderer initialization: {error:?}"))?;
    renderer
        .apply_settings(gpu, preset.renderer_settings())
        .map_err(|error| format!("apply render settings: {error:?}"))?;
    Ok(renderer)
}

// Allocation-counting global allocator: installed only under `alloc-count`, so
// the `make check-allocs` build proves zero steady-state per-frame allocations
// while normal builds pay nothing. Native installs the tracing variant
// (SUCCESSOR_ALLOC_TRACE=1 names offending call sites; zero-cost when unset).
#[cfg(all(feature = "alloc-count", not(target_arch = "wasm32")))]
#[global_allocator]
static GLOBAL: crate::alloc_trace::TraceAllocator = crate::alloc_trace::TraceAllocator;
#[cfg(all(feature = "alloc-count", target_arch = "wasm32"))]
#[global_allocator]
static GLOBAL: successor_engine_core::rt::alloc::CountingAllocator<std::alloc::System> =
    successor_engine_core::rt::alloc::CountingAllocator::new(std::alloc::System);

// --- wasm runtime -----------------------------------------------------------
// Exported entry points the JS shim (`web/successor.js`) drives. Keeping the
// render/engine code reachable from these `#[no_mangle]` exports is also what
// gives the wasm module a meaningful (non-DCE'd) size for the size gate.
#[cfg(target_arch = "wasm32")]
mod web_runtime {
    use crate::demo::{build_scene, Scene};
    use crate::game::actions;
    use crate::game::chat_net::ChatClient;
    use crate::game::command_queue::CommandQueue;
    use crate::game::connected_scene::{ConnectedScene, CONNECTED_INPUT_KEYS};
    use crate::game::movement;
    use crate::hosted_creator::{
        parse_inbound_message, CreateEffect, CreateStartError, CreatorInbound, HostedCreatorFlow,
    };
    use crate::net::session::LaunchEnvelope;
    use crate::screens::{CharacterScreen, CharacterStage, ScreenAction};
    use serde_json::json;
    use successor_client_proto::colyseus;

    use successor_client_proto::session::{
        Session, SessionEvent, SessionOut, SessionState, WsInput,
    };
    use successor_engine_core::input::Key;
    use successor_engine_core::rt::cell::GlobalCell;
    use successor_engine_render::gpu::{ClearSpec, Gpu, PassTarget, RectPx};
    use successor_engine_render::renderer::Renderer;
    use successor_engine_render::ui::UiBuilder;
    use successor_net::{PlayerId, SessionId};
    use successor_platform::GlGpu;
    static GPU: GlobalCell<GlGpu> = GlobalCell::new();
    static SCENE: GlobalCell<Scene> = GlobalCell::new();
    static PARITY_SCENE: GlobalCell<crate::material_parity::Scene> = GlobalCell::new();
    static TERRAIN_SCENE: GlobalCell<crate::world::chunks::TerrainScene> = GlobalCell::new();
    static DEMO_SELECTOR: GlobalCell<u32> = GlobalCell::new();
    static FRAME: GlobalCell<u64> = GlobalCell::new();
    static SIZE: GlobalCell<(u32, u32)> = GlobalCell::new();
    static LAUNCH: GlobalCell<LaunchEnvelope> = GlobalCell::new();
    static CONNECTED_SCENE: GlobalCell<ConnectedScene> = GlobalCell::new();
    static CONNECTED_DT: GlobalCell<f32> = GlobalCell::new();
    static VIEW_SENT: GlobalCell<bool> = GlobalCell::new();
    static MOVEMENT_CONTROLLER: GlobalCell<movement::MovementController> = GlobalCell::new();
    static FATAL: GlobalCell<bool> = GlobalCell::new();
    static EXITING: GlobalCell<bool> = GlobalCell::new();
    static CREATOR_MODE: GlobalCell<bool> = GlobalCell::new();
    static CREATOR_FLOW: GlobalCell<HostedCreatorFlow> = GlobalCell::new();
    static CREATOR_SCREEN: GlobalCell<CharacterScreen> = GlobalCell::new();
    static CREATOR_RENDERER: GlobalCell<Renderer> = GlobalCell::new();
    static CREATOR_UI: GlobalCell<UiBuilder> = GlobalCell::new();
    static CREATOR_INPUT: GlobalCell<CreatorInput> = GlobalCell::new();

    #[derive(Default)]
    struct CreatorInput {
        tab_was: bool,
        enter_was: bool,
        backspace_was: bool,
        escape_was: bool,
        up_was: bool,
        down_was: bool,
    }

    fn read_web_asset(stable_id: &str) -> Option<Vec<u8>> {
        if stable_id.is_empty() || stable_id.contains("..") || stable_id.starts_with('/') {
            return None;
        }
        let path = if stable_id.starts_with("assets/") {
            stable_id.to_string()
        } else if let Some(path) = stable_id.strip_prefix("successor-slice/") {
            format!("successor-slice/{path}")
        } else if let Some(path) = stable_id.strip_prefix("successor-audio/") {
            format!("successor-audio/{path}")
        } else if let Some(path) = stable_id.strip_prefix("render/") {
            format!("render/{path}")
        } else {
            return None;
        };
        successor_platform::http_get(&path).ok()
    }

    fn creator_mode() -> bool {
        CREATOR_MODE.get_mut().copied().unwrap_or(false)
    }

    fn build_creator_surface(gpu: &mut GlGpu) -> Result<(), String> {
        let mut renderer = crate::configured_renderer(gpu)?;
        let icons = crate::hud::Icons::load();
        renderer.set_ui_atlas(&mut *gpu, icons.meta.width, icons.meta.height, &icons.rgba);
        CREATOR_RENDERER.set(renderer);
        CREATOR_UI.set(icons.ui_builder());
        Ok(())
    }

    #[no_mangle]
    pub extern "C" fn init(demo_selector: u32) {
        crate::initialize_render_settings();
        successor_platform::init("Successor", 1280, 720);
        DEMO_SELECTOR.set(demo_selector);
        let is_creator = demo_selector == 0 && successor_platform::web::creator_mode();
        CREATOR_MODE.set(is_creator);
        FATAL.set(false);
        if demo_selector == 0 && !is_creator {
            let bytes = successor_platform::web::launch_context()
                .and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok())
                .and_then(|v| {
                    LaunchEnvelope::from_json(&v, successor_platform::now_ms() as u64).ok()
                });
            if let Some(envelope) = bytes {
                LAUNCH.set(envelope);
            } else {
                FATAL.set(true);
                successor_engine_core::rt::log::log_str(
                    "fatal launch: missing or invalid launch context",
                );
            }
        }
        let mut gpu = successor_platform::create_gpu();
        if demo_selector == 1 {
            let assets = [
                successor_platform::http_get("parity-assets/commerce_facility.glb")
                    .expect("commerce asset"),
                successor_platform::http_get("parity-assets/lightning_carbine.glb")
                    .expect("lightning asset"),
                successor_platform::http_get("parity-assets/mossmuff_adult.glb")
                    .expect("mossmuff asset"),
                successor_platform::http_get("parity-assets/successor_food_beer_mug.glb")
                    .expect("beer mug asset"),
                successor_platform::http_get("parity-assets/field_cap.glb")
                    .expect("field cap asset"),
                successor_platform::http_get("parity-assets/megalith_brick_hex.glb")
                    .expect("megalith asset"),
            ];
            let scene =
                crate::material_parity::build(&mut gpu, &assets).expect("material parity scene");
            PARITY_SCENE.set(scene);
        } else if matches!(demo_selector, 2 | 3) {
            let biome = if demo_selector == 3 {
                crate::world::terrain::Biome::Forest
            } else {
                crate::world::terrain::Biome::Desert
            };
            let mut scene = crate::world::chunks::TerrainScene::build(&mut gpu, biome);
            scene.use_material_detail_view();
            TERRAIN_SCENE.set(scene);
        } else if is_creator {
            match build_creator_surface(&mut gpu) {
                Ok(()) => {
                    CREATOR_FLOW.set(HostedCreatorFlow::default());
                    CREATOR_SCREEN.set(CharacterScreen::with_entries(Vec::new()));
                    CREATOR_INPUT.set(CreatorInput::default());
                    successor_platform::web::creator_ready();
                }
                Err(error) => {
                    FATAL.set(true);
                    successor_engine_core::rt::log::log_str(&error);
                }
            }
        } else if demo_selector == 0 {
            let player_id = LAUNCH
                .get_mut()
                .map(|launch| launch.character_id.clone())
                .unwrap_or_default();
            let mut read_asset = read_web_asset;
            match ConnectedScene::build(&mut gpu, &player_id, &mut read_asset) {
                Ok(mut scene) => {
                    let session = successor_platform::now_ms().max(1.0) as u64;
                    let player = player_id.bytes().fold(2_166_136_261u32, |hash, byte| {
                        (hash ^ byte as u32).wrapping_mul(16_777_619)
                    });
                    scene.set_command_queue(CommandQueue::new(
                        SessionId(session),
                        PlayerId(player.max(1)),
                        session.saturating_mul(1000),
                    ));
                    CONNECTED_SCENE.set(scene);
                    VIEW_SENT.set(false);
                    MOVEMENT_CONTROLLER.set(movement::MovementController::default());
                }
                Err(error) => {
                    FATAL.set(true);
                    successor_engine_core::rt::log::log_str(&error);
                }
            }
        } else {
            SCENE.set(build_scene(&mut gpu));
        }
        GPU.set(gpu);
        DEMO_SELECTOR.set(demo_selector);
        FRAME.set(0);
        SIZE.set((1280, 720));
        EXITING.set(false);
    }

    #[no_mangle]
    pub extern "C" fn resize(w: i32, h: i32) {
        SIZE.set((w.max(1) as u32, h.max(1) as u32));
    }

    fn bounded_creator_error(prefix: &str, detail: &str) -> String {
        const MAX_STATUS_BYTES: usize = 128;
        let mut status = String::from(prefix);
        let remaining = MAX_STATUS_BYTES.saturating_sub(status.len());
        status.push_str(&detail[..detail.len().min(remaining)]);
        status
    }

    fn complete_creator_create(screen: &mut CharacterScreen, character_id: &str) {
        screen.draft = Default::default();
        screen.set_stage(CharacterStage::Roster);
        screen.select_stable_id(character_id);
        screen.set_status("CHARACTER CREATED. SELECT TO ENTER WORLD.");
    }

    fn apply_creator_effect(effect: CreateEffect) {
        let Some(screen) = CREATOR_SCREEN.get_mut() else {
            return;
        };
        match effect {
            CreateEffect::Ignored => {}
            CreateEffect::WaitingForRoster => {
                screen.set_status("CREATE ACCEPTED. REFRESHING ROSTER.");
            }
            CreateEffect::Rejected(error) => {
                screen.set_status_error(&bounded_creator_error("CREATE REJECTED: ", &error));
            }
            CreateEffect::Created(character_id) => complete_creator_create(screen, &character_id),
            CreateEffect::TimedOut => {
                screen.set_status_error("CREATE TIMED OUT. TRY AGAIN.");
            }
        }
    }

    fn drain_creator_messages() {
        for _ in 0..8 {
            let Some(bytes) = successor_platform::web::take_creator_message() else {
                break;
            };
            let Some(message) = parse_inbound_message(&bytes) else {
                continue;
            };
            match message {
                CreatorInbound::State(state) => {
                    let Some(flow) = CREATOR_FLOW.get_mut() else {
                        continue;
                    };
                    let effect = flow.apply_state(state);
                    let roster = flow.roster_entries();
                    let Some(screen) = CREATOR_SCREEN.get_mut() else {
                        continue;
                    };
                    screen.replace_roster(roster);
                    if let Some(id) = effect.selected_character_id.as_deref() {
                        screen.select_stable_id(id);
                    }
                    if let Some(id) = effect.created_character_id.as_deref() {
                        complete_creator_create(screen, id);
                    }
                }
                CreatorInbound::CreateResult(result) => {
                    let effect = CREATOR_FLOW
                        .get_mut()
                        .map(|flow| flow.handle_create_result(result))
                        .unwrap_or(CreateEffect::Ignored);
                    apply_creator_effect(effect);
                }
            }
        }
    }

    fn handle_creator_action(action: ScreenAction) {
        match action {
            ScreenAction::SelectCharacter(index) => {
                let id = CREATOR_SCREEN
                    .get_mut()
                    .and_then(|screen| screen.roster.get(index).map(|entry| entry.id.clone()))
                    .filter(|id| !id.is_empty());
                let Some(id) = id else {
                    return;
                };
                let posted = successor_platform::web::post_creator_select(&id);
                if let Some(screen) = CREATOR_SCREEN.get_mut() {
                    if posted {
                        screen.set_status("HANDOFF REQUESTED.");
                    } else {
                        screen.set_status_error("CHARACTER HANDOFF UNAVAILABLE.");
                    }
                }
            }
            ScreenAction::CreateCharacter(display_name) => {
                let Some((vocation, female)) = CREATOR_SCREEN
                    .get_mut()
                    .map(|screen| (screen.draft.vocation(), screen.draft.female))
                else {
                    return;
                };
                let now_ms = successor_platform::now_ms().max(0.0) as u64;
                let request = CREATOR_FLOW
                    .get_mut()
                    .map(|flow| flow.begin_create(&display_name, vocation, female, now_ms));
                match request {
                    Some(Ok(request)) => {
                        if successor_platform::web::post_creator_create(&request.to_json()) {
                            if let Some(screen) = CREATOR_SCREEN.get_mut() {
                                screen.set_status("CREATING CHARACTER...");
                            }
                        } else {
                            if let Some(flow) = CREATOR_FLOW.get_mut() {
                                flow.cancel_pending();
                            }
                            if let Some(screen) = CREATOR_SCREEN.get_mut() {
                                screen.set_status_error("CREATE REQUEST UNAVAILABLE.");
                            }
                        }
                    }
                    Some(Err(CreateStartError::Pending)) => {
                        if let Some(screen) = CREATOR_SCREEN.get_mut() {
                            screen.set_status("CREATE ALREADY IN PROGRESS.");
                        }
                    }
                    Some(Err(CreateStartError::InvalidName)) => {
                        if let Some(screen) = CREATOR_SCREEN.get_mut() {
                            screen
                                .set_status_error("NAME: 3-16 LETTERS; USE HYPHENS BETWEEN WORDS.");
                        }
                    }
                    Some(Err(CreateStartError::UnsupportedProfession)) | None => {
                        if let Some(screen) = CREATOR_SCREEN.get_mut() {
                            screen.set_status_error("SELECT A STARTING VOCATION.");
                        }
                    }
                }
            }
            ScreenAction::Back => {
                if let Some(screen) = CREATOR_SCREEN.get_mut() {
                    screen.set_status("SELECT OR CREATE A CHARACTER.");
                }
            }
            ScreenAction::Connect(_) | ScreenAction::CancelConnect | ScreenAction::Quit => {}
        }
    }

    fn update_creator(dt: f32) {
        drain_creator_messages();
        let now_ms = successor_platform::now_ms().max(0.0) as u64;
        let effect = CREATOR_FLOW
            .get_mut()
            .map(|flow| flow.expire(now_ms))
            .unwrap_or(CreateEffect::Ignored);
        apply_creator_effect(effect);

        let (w, h) = SIZE.get_mut().copied().unwrap_or((1280, 720));
        if w == 0 || h == 0 {
            return;
        }
        let action = {
            let (Some(screen), Some(ui), Some(input)) = (
                CREATOR_SCREEN.get_mut(),
                CREATOR_UI.get_mut(),
                CREATOR_INPUT.get_mut(),
            ) else {
                return;
            };
            let (mouse_x, mouse_y) = successor_platform::mouse_position();
            ui.set_input(mouse_x, mouse_y, successor_platform::mouse_button_down(0));

            let shift = successor_platform::is_key_down(Key::LeftShift);
            let tab = successor_platform::is_key_down(Key::Tab);
            let tab_edge = tab && !input.tab_was;
            input.tab_was = tab;
            let enter = successor_platform::is_key_down(Key::Enter);
            let enter_edge = enter && !input.enter_was;
            input.enter_was = enter;
            let backspace = successor_platform::is_key_down(Key::Backspace);
            let backspace_edge = backspace && !input.backspace_was;
            input.backspace_was = backspace;
            let escape = successor_platform::is_key_down(Key::Escape);
            let escape_edge = escape && !input.escape_was;
            input.escape_was = escape;
            let up = successor_platform::is_key_down(Key::Up);
            let up_edge = up && !input.up_was;
            input.up_was = up;
            let down = successor_platform::is_key_down(Key::Down);
            let down_edge = down && !input.down_was;
            input.down_was = down;

            screen.tick(dt);
            while let Some(character) = successor_platform::poll_text_input() {
                screen.input_char(character);
            }
            if tab_edge {
                if shift {
                    screen.focus_prev();
                } else {
                    screen.focus_next();
                }
            }
            if backspace_edge {
                screen.backspace();
            }
            if up_edge {
                screen.move_selection(-1, w as f32, h as f32);
            }
            if down_edge {
                screen.move_selection(1, w as f32, h as f32);
            }
            if escape_edge {
                match screen.stage() {
                    CharacterStage::CreateIdentity => {
                        screen.set_stage(CharacterStage::CreateProfile)
                    }
                    CharacterStage::CreateProfile => screen.set_stage(CharacterStage::Roster),
                    CharacterStage::Roster => screen.set_status("SELECT OR CREATE A CHARACTER."),
                }
            }

            ui.begin(w, h);
            let mut action = screen.draw(ui, w as f32, h as f32);
            if enter_edge && action.is_none() {
                action = match screen.stage() {
                    CharacterStage::Roster => {
                        Some(ScreenAction::SelectCharacter(screen.selected()))
                    }
                    CharacterStage::CreateProfile => {
                        screen.set_stage(CharacterStage::CreateIdentity);
                        None
                    }
                    CharacterStage::CreateIdentity => {
                        let name = screen.draft.full_name();
                        (!name.is_empty()).then_some(ScreenAction::CreateCharacter(name))
                    }
                };
            }
            action
        };
        if let Some(action) = action {
            handle_creator_action(action);
        }
    }

    #[no_mangle]
    pub extern "C" fn update(dt: f32) {
        FRAME.get_mut().map(|frame| *frame += 1);
        CONNECTED_DT.set(dt.clamp(0.0, 0.1));
        if creator_mode() {
            update_creator(dt.clamp(0.0, 0.1));
            return;
        }
        if DEMO_SELECTOR.get_mut().copied().unwrap_or(0) != 0 {
            return;
        }
        let Some(scene) = CONNECTED_SCENE.get_mut() else {
            return;
        };
        let movement_now_ms = successor_platform::now_ms().max(0.0) as u64;
        let ready = SESSION
            .get_mut()
            .is_some_and(|session| session.state() == SessionState::Ready);
        let actor_dead = scene
            .player_actor()
            .is_some_and(|actor| actor.life_state != "alive");
        let input_locked = scene.tuning_open() || actor_dead;
        let intent = if ready && !input_locked {
            let (manual_dx, manual_dy, held_sprint) =
                movement::intent_from_keys(successor_platform::is_key_down);
            let (dx, dy) = scene.navigation_intent(manual_dx, manual_dy);
            (dx, dy, held_sprint || scene.sprint_toggled())
        } else {
            (0, 0, false)
        };
        scene.set_move_intent(intent.0, intent.1, intent.2);
        let movement_update = MOVEMENT_CONTROLLER.get_mut().and_then(|controller| {
            if !ready {
                controller.release(movement_now_ms, movement::StopReason::Disconnected)
            } else if actor_dead {
                controller.release(movement_now_ms, movement::StopReason::Dead)
            } else if input_locked {
                controller.release(movement_now_ms, movement::StopReason::ModalInput)
            } else {
                controller.update(
                    movement::IntentState {
                        dx: intent.0,
                        dy: intent.1,
                        sprint: intent.2,
                    },
                    movement_now_ms,
                )
            }
        });
        if let Some(intent) = movement_update {
            let _ = scene.dispatch_gameplay_action(actions::GameplayAction::Move {
                dx: intent.dx,
                dy: intent.dy,
                facing: movement::facing_from_intent(intent.dx, intent.dy),
                sprint: intent.sprint,
            });
        }
        if let Some(controller) = MOVEMENT_CONTROLLER.get_mut() {
            scene.set_movement_timing(controller.timing(), movement_now_ms);
        }
        if !ready {
            flush_scene_commands();
            return;
        }
        let shift_down = successor_platform::is_key_down(Key::LeftShift);
        for key in CONNECTED_INPUT_KEYS {
            if let Some(action) =
                scene.handle_key(key, successor_platform::is_key_down(key), shift_down)
            {
                let _ = scene.dispatch_gameplay_action(action);
            }
        }
        let (mouse_x, mouse_y) = successor_platform::mouse_position();
        if let Some(action) = scene.handle_pointer(
            mouse_x,
            mouse_y,
            successor_platform::mouse_button_down(0),
            successor_platform::mouse_button_down(1),
            scene.pointer_captured(),
        ) {
            let _ = scene.dispatch_gameplay_action(action);
        }
        if let Some((_, scroll_y)) = successor_platform::poll_scroll_delta() {
            scene.handle_scroll(scroll_y);
        }
        flush_scene_commands();
    }

    #[no_mangle]
    pub extern "C" fn release_movement_input(reason: u32) {
        let stop_reason = match reason {
            0 => movement::StopReason::FocusLost,
            _ => movement::StopReason::Transition,
        };
        let now_ms = successor_platform::now_ms().max(0.0) as u64;
        let movement_update = MOVEMENT_CONTROLLER
            .get_mut()
            .and_then(|controller| controller.release(now_ms, stop_reason));
        if let Some(scene) = CONNECTED_SCENE.get_mut() {
            scene.set_move_intent(0, 0, false);
            if let Some(intent) = movement_update {
                let _ = scene.dispatch_gameplay_action(actions::GameplayAction::Move {
                    dx: intent.dx,
                    dy: intent.dy,
                    facing: movement::facing_from_intent(intent.dx, intent.dy),
                    sprint: intent.sprint,
                });
            }
        }
        flush_scene_commands();
    }

    /// Allocation-free connected movement probe. Indices are stable and mirrored
    /// by `web/successor.js`; unknown/unavailable values return NaN.
    #[no_mangle]
    pub extern "C" fn movement_probe(index: u32) -> f64 {
        let Some(scene) = CONNECTED_SCENE.get_mut() else {
            return f64::NAN;
        };
        let Some(movement) = scene.movement_diagnostics() else {
            return f64::NAN;
        };
        let timing = MOVEMENT_CONTROLLER
            .get_mut()
            .map(|controller| controller.timing())
            .unwrap_or_default();
        match index {
            0 => movement.authoritative.0 as f64,
            1 => movement.authoritative.1 as f64,
            2 => movement.predicted.0 as f64,
            3 => movement.predicted.1 as f64,
            4 => movement.rendered.0 as f64,
            5 => movement.rendered.1 as f64,
            6 => movement.correction_cells as f64,
            7 => movement.intent.0 as f64,
            8 => movement.intent.1 as f64,
            9 => movement.intent.2 as u8 as f64,
            10 => movement.applied_command_id as f64,
            11 => movement.blocker_count as f64,
            12 => movement.presented_ground_y as f64,
            13 => movement.sampled_ground_y as f64,
            14 => movement.frame_dt_ms as f64,
            15 => timing.last_change_ms as f64,
            16 => timing.last_send_ms as f64,
            17 => timing.next_send_ms as f64,
            18 => timing.stop_retry_until_ms as f64,
            19 => successor_platform::now_ms(),
            _ => f64::NAN,
        }
    }

    #[no_mangle]
    pub extern "C" fn render() {
        let (w, h) = SIZE.get_mut().copied().unwrap_or((1280, 720));
        if let Some(gpu) = GPU.get_mut() {
            if creator_mode() {
                if let (Some(renderer), Some(ui)) =
                    (CREATOR_RENDERER.get_mut(), CREATOR_UI.get_mut())
                {
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
                    renderer.render_ui(gpu, &ui.buf, ui.quads, w, h);
                }
                return;
            }
            if DEMO_SELECTOR.get_mut().copied().unwrap_or(0) == 1 {
                if let Some(scene) = PARITY_SCENE.get_mut() {
                    scene
                        .renderer
                        .render(gpu, &mut scene.world, w, h)
                        .expect("render failed");
                }
            } else if matches!(DEMO_SELECTOR.get_mut().copied().unwrap_or(0), 2 | 3) {
                if let Some(scene) = TERRAIN_SCENE.get_mut() {
                    scene
                        .renderer
                        .render(gpu, &mut scene.world, w, h)
                        .expect("terrain render failed");
                }
            } else if DEMO_SELECTOR.get_mut().copied().unwrap_or(0) == 0 {
                if let (Some(scene), Some(chat_client), Some(chat_input)) = (
                    CONNECTED_SCENE.get_mut(),
                    CHAT_CLIENT.get_mut(),
                    CHAT_INPUT.get_mut(),
                ) {
                    let dt = CONNECTED_DT.get_mut().copied().unwrap_or(1.0 / 60.0);
                    let mut platform = successor_platform::WebPlatform;
                    scene.frame(gpu, w, h, dt, &mut platform, chat_client, chat_input);
                }
            } else if let Some(scene) = SCENE.get_mut() {
                scene
                    .renderer
                    .render(gpu, &mut scene.world, w, h)
                    .expect("render failed");
            }
        }
    }

    #[no_mangle]
    pub extern "C" fn probe_material_parity() -> u32 {
        if DEMO_SELECTOR.get_mut().copied().unwrap_or(0) != 1 {
            return 0;
        }
        let (width, height) = SIZE.get_mut().copied().unwrap_or((0, 0));
        let pixels = successor_platform::read_pixels_rgba(width as i32, height as i32);
        match crate::material_parity::probe_rgba_top_left(&pixels, width, height) {
            Ok(_) => 1,
            Err(error) => {
                successor_engine_core::rt::log::log_str(&error);
                0
            }
        }
    }

    #[no_mangle]
    pub extern "C" fn probe_terrain_material() -> u32 {
        if !matches!(DEMO_SELECTOR.get_mut().copied().unwrap_or(0), 2 | 3) {
            return 0;
        }
        let (width, height) = SIZE.get_mut().copied().unwrap_or((0, 0));
        let pixels = successor_platform::read_pixels_rgba(width as i32, height as i32);
        match crate::world::terrain_material::probe_rgba(&pixels, width, height) {
            Ok(probe) => {
                successor_engine_core::rt::log::log_str(&format!(
                    "terrain probe stddev={:.5} neighbor={:.5} repeat={:.5}\n",
                    probe.luma_stddev, probe.neighbor_delta, probe.repeat_delta
                ));
                1
            }
            Err(error) => {
                successor_engine_core::rt::log::log_str(&error);
                0
            }
        }
    }

    // --- wasm networking runtime --------------------------------------------
    // The sans-IO `Session` FSM + Colyseus matchmake/framing (client-proto) are
    // target-agnostic; here they run on the browser WebSocket/fetch shim
    // (`platform::web::net`). JS drives `net_connect` once, then `net_poll` each
    // frame; `net_state` exposes the handshake state for the page.

    static SESSION: GlobalCell<Session> = GlobalCell::new();
    static WS: GlobalCell<successor_platform::WsHandle> = GlobalCell::new();
    static CHAT_CLIENT: GlobalCell<ChatClient> = GlobalCell::new();
    static CHAT_INPUT: GlobalCell<successor_engine_render::ui::TextField> = GlobalCell::new();
    static CHAT_TICKET: GlobalCell<Option<String>> = GlobalCell::new();
    static CHAT_WS: GlobalCell<successor_platform::WsHandle> = GlobalCell::new();
    static CLIENT_RELEASE: GlobalCell<String> = GlobalCell::new();

    #[no_mangle]
    pub extern "C" fn net_connect() {
        let envelope = match LAUNCH.get_mut() {
            Some(envelope) => envelope,
            None => return,
        };
        let game_ticket = match envelope.consume_game_ticket() {
            Ok(ticket) => ticket,
            Err(_) => return,
        };
        let chat_ticket = match envelope.consume_chat_ticket() {
            Ok(ticket) => ticket,
            Err(_) => return,
        };
        let endpoint = envelope.game_endpoint.clone();
        let chat_endpoint = envelope.chat_endpoint.clone();
        let client_release = envelope.client_release.clone();
        let http = endpoint
            .replacen("wss://", "https://", 1)
            .replacen("ws://", "http://", 1);
        let opts = if game_ticket == "dev-identity" {
            let mut opts = json!({
                "playerId": envelope.character_id,
                "actorId": envelope.character_id,
            });
            if let (Some(object), Some(spawn)) = (opts.as_object_mut(), envelope.dev_spawn.as_ref()) {
                object.insert("spawnArea".into(), json!(spawn.area));
                object.insert("spawnX".into(), json!(spawn.x));
                object.insert("spawnY".into(), json!(spawn.y));
                object.insert("facing".into(), json!(spawn.facing));
            }
            opts
        } else {
            json!({
                "gameTicket": game_ticket,
                "release": envelope.client_release,
            })
        };
        let (url, body) = match colyseus::build_matchmake_request(&http, &opts) {
            Ok(v) => v,
            Err(_) => return,
        };
        let resp = match successor_platform::http_post_json(&url, &body) {
            Ok(r) => r,
            Err(_) => return,
        };
        let seat = match colyseus::parse_seat_reservation(&resp) {
            Ok(s) => s,
            Err(_) => return,
        };
        let ws_url = colyseus::build_ws_url(&endpoint, &seat);
        if let Ok(ws) = successor_platform::ws_connect(&ws_url) {
            let mut s = Session::new();
            s.start_connecting();
            SESSION.set(s);
            WS.set(ws);
        }
        let mut chat_client = ChatClient::with_endpoint(128, chat_endpoint.clone());
        chat_client.connection.begin();
        CHAT_CLIENT.set(chat_client);
        CHAT_INPUT.set(successor_engine_render::ui::TextField::new(320));
        if let Ok(chat_ws) = successor_platform::ws_connect(&chat_endpoint) {
            CHAT_TICKET.set(Some(chat_ticket));
            CHAT_WS.set(chat_ws);
            CLIENT_RELEASE.set(client_release);
        }
    }

    #[no_mangle]
    pub extern "C" fn net_exit_world() -> u32 {
        let (session, socket) = match (SESSION.get_mut(), WS.get_mut()) {
            (Some(session), Some(socket)) if session.state() == SessionState::Ready => {
                (session, socket)
            }
            _ => return 0,
        };
        match session.exit_world() {
            Ok(SessionOut::SendFrame(frame)) => {
                successor_platform::ws_send(socket, &frame);
                EXITING.set(true);
                1
            }
            _ => 0,
        }
    }

    #[no_mangle]
    pub extern "C" fn net_exit_complete() -> u32 {
        if !EXITING.get_mut().copied().unwrap_or(false) {
            return 0;
        }
        SESSION
            .get_mut()
            .is_some_and(|session| session.state() != SessionState::Ready) as u32
    }
    #[no_mangle]
    pub extern "C" fn context_restored() {
        let player_id = LAUNCH
            .get_mut()
            .map(|launch| launch.character_id.clone())
            .unwrap_or_default();
        let mut gpu = successor_platform::create_gpu();
        let mut read_asset = read_web_asset;
        match ConnectedScene::build(&mut gpu, &player_id, &mut read_asset) {
            Ok(mut rebuilt) => {
                if let Some(previous) = CONNECTED_SCENE.get_mut() {
                    rebuilt.restore_projection_from(previous);
                }
                CONNECTED_SCENE.set(rebuilt);
                GPU.set(gpu);
                successor_engine_core::rt::log::log_str("webgl context restored");
            }
            Err(error) => {
                FATAL.set(true);
                successor_engine_core::rt::log::log_str(&error);
            }
        }
    }

    #[no_mangle]
    pub extern "C" fn net_poll() {
        let (session, socket) = match (SESSION.get_mut(), WS.get_mut()) {
            (Some(session), Some(socket)) => (session, socket),
            _ => return,
        };
        let mut buffer = Vec::with_capacity(64 * 1024);
        for _ in 0..64 {
            buffer.clear();
            let event = successor_platform::ws_poll(socket, &mut buffer);
            let (outputs, stop) = match event {
                successor_platform::WsEvent::Open => (session.on_ws_event(WsInput::Open), false),
                successor_platform::WsEvent::Frame(length) => (
                    session.on_ws_event(WsInput::Frame(&buffer[..length])),
                    false,
                ),
                successor_platform::WsEvent::Closed => (session.on_ws_event(WsInput::Closed), true),
                successor_platform::WsEvent::Error => {
                    (session.on_ws_event(WsInput::Error("ws error")), true)
                }
                successor_platform::WsEvent::None => break,
            };
            for output in outputs {
                match output {
                    SessionOut::SendFrame(frame) => successor_platform::ws_send(socket, &frame),
                    SessionOut::Emit(SessionEvent::Hello(hello)) => {
                        if let Some(scene) = CONNECTED_SCENE.get_mut() {
                            scene.on_snapshot(&hello.snapshot);
                        }
                    }
                    SessionOut::Emit(SessionEvent::Packet(packet)) => {
                        if let Some(scene) = CONNECTED_SCENE.get_mut() {
                            scene.apply_server_packet(packet);
                        }
                    }
                    SessionOut::Emit(SessionEvent::Room { msg_type, payload }) => {
                        if let Some(scene) = CONNECTED_SCENE.get_mut() {
                            scene.apply_room_message(&msg_type, &payload);
                        }
                    }
                    SessionOut::Emit(SessionEvent::Error(message)) => {
                        FATAL.set(true);
                        successor_engine_core::rt::log::log_str(&message);
                    }
                    SessionOut::Emit(SessionEvent::Closed)
                    | SessionOut::Emit(SessionEvent::ReconnectAttempt { .. }) => {}
                }
            }
            if stop {
                break;
            }
        }
        if session.state() == SessionState::Ready && !VIEW_SENT.get_mut().copied().unwrap_or(false)
        {
            let view = json!({ "viewport_width_cells": 96, "viewport_height_cells": 96, "margin_cells": 32 });
            if let Ok(SessionOut::SendFrame(frame)) = session.send_view(&view) {
                successor_platform::ws_send(socket, &frame);
                VIEW_SENT.set(true);
            }
        }
        let (chat_client, chat_ticket, chat_socket, client_release) = match (
            CHAT_CLIENT.get_mut(),
            CHAT_TICKET.get_mut(),
            CHAT_WS.get_mut(),
            CLIENT_RELEASE.get_mut(),
        ) {
            (Some(client), Some(ticket), Some(socket), Some(release)) => {
                (client, ticket, socket, release)
            }
            _ => return,
        };
        let mut chat_buffer = Vec::with_capacity(64 * 1024);
        for _ in 0..32 {
            chat_buffer.clear();
            match successor_platform::ws_poll(chat_socket, &mut chat_buffer) {
                successor_platform::WsEvent::Open => {
                    if let Some(frame) = chat_client
                        .connection
                        .authenticate(chat_ticket, client_release)
                    {
                        successor_platform::ws_send(chat_socket, frame.as_bytes());
                    }
                }
                successor_platform::WsEvent::Frame(length) => {
                    let _ =
                        chat_client.on_incoming(&String::from_utf8_lossy(&chat_buffer[..length]));
                }
                successor_platform::WsEvent::Closed | successor_platform::WsEvent::Error => {
                    let _ = chat_client.connection.lost();
                    break;
                }
                successor_platform::WsEvent::None => break,
            }
        }
    }

    fn flush_scene_commands() {
        let (scene, session, socket) =
            match (CONNECTED_SCENE.get_mut(), SESSION.get_mut(), WS.get_mut()) {
                (Some(scene), Some(session), Some(socket)) => (scene, session, socket),
                _ => return,
            };
        while let Some(envelope) = scene.take_next_command() {
            if let Ok(SessionOut::SendFrame(frame)) = session.send_command(&envelope) {
                successor_platform::ws_send(socket, &frame);
            }
        }
    }

    /// Session handshake state as a small code for the page (0 = not started).
    #[no_mangle]
    pub extern "C" fn net_state() -> u32 {
        SESSION.get_mut().map(|s| s.state() as u32).unwrap_or(0)
    }

    #[no_mangle]
    pub extern "C" fn net_fatal() -> u32 {
        FATAL.get_mut().copied().unwrap_or(false) as u32
    }
}

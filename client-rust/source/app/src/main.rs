#![allow(clippy::same_item_push, clippy::unnecessary_unwrap)]

//! Successor Rust client — native entry point.
//!
//! Modes:
//!   successor --demo parity-basic --frames 600 [--stats-json PATH] [--assert-zero-allocs]
//!       Headless: runs the standard scene through `NullGpu`, measuring frame
//!       p50/p99, peak RSS, and steady-state allocations. No window. Used by
//!       `make runtime-check` / `make check-allocs`.
//!   successor --demo parity-basic --gl
//!       Opens a GL window (visual QA) and renders the scene until closed.
//!   successor --demo ui [--surface actions|inventory|...] [--screenshot PATH]
//!       Captures one registered movable/resizable surface over clean game HUD.
//!   successor --demo pregame [--stage entry|connecting|roster|roster-empty|
//!                                     create-profile|create-summary|loading]
//!                            [--frames N] [--screenshot PATH]
//!       Opens a GL window on the pregame flow (login → roster → creation).
//!       Presentation only: no socket, no launch context, no roster authority.
//!   successor --endpoint ws://127.0.0.1:28093 --player-id dev-1 --actor-id dev-1
//!       (Playable slice — wired in the PlayableSlice phase.)

use successor_client::demo;
use successor_client::net::session::LaunchEnvelope;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.iter().any(|arg| arg == "--model-corpus") {
        #[cfg(feature = "dev-tools")]
        {
            run_model_corpus();
            return;
        }
        #[cfg(not(feature = "dev-tools"))]
        {
            eprintln!("developer probes and demo modes require the `dev-tools` capability");
            std::process::exit(2);
        }
    }
    #[cfg(all(not(target_arch = "wasm32"), feature = "dev-tools"))]
    configure_automation(&args);
    #[cfg(all(not(target_arch = "wasm32"), not(feature = "dev-tools")))]
    if args.iter().any(|arg| {
        matches!(
            arg.as_str(),
            "--control"
                | "--control-port"
                | "--record-input"
                | "--replay-input"
                | "--screenshot"
                | "--stats-json"
                | "--gpu-stats-json"
                | "--assert-zero-allocs"
                | "--assert-material-parity"
                | "--assert-terrain-material"
        ) || arg.starts_with("--demo")
    }) {
        eprintln!("developer probes and demo modes require the `dev-tools` capability");
        std::process::exit(2);
    }

    let mode = arg_value(&args, "--demo");
    let frames: u64 = arg_value(&args, "--frames")
        .and_then(|s| s.parse().ok())
        .unwrap_or(600);
    let stats_json = arg_value(&args, "--stats-json");
    let assert_zero = args.iter().any(|a| a == "--assert-zero-allocs");
    let gl = args.iter().any(|a| a == "--gl");
    let endpoint = arg_value(&args, "--endpoint");
    let player_arg = arg_value(&args, "--player-id");
    let actor_arg = arg_value(&args, "--actor-id");
    let dev_identity = args.iter().any(|a| a == "--dev-identity");
    #[cfg(not(feature = "dev-tools"))]
    let _ = dev_identity;

    // Raw identity flags are strictly a development capability. In release
    // builds they cannot accidentally become an alternate authenticated path.
    if endpoint.is_some() || player_arg.is_some() || actor_arg.is_some() {
        #[cfg(not(feature = "dev-tools"))]
        {
            eprintln!("raw endpoint/identity launch requires dev-tools");
            std::process::exit(2);
        }
        #[cfg(feature = "dev-tools")]
        if !dev_identity || endpoint.is_none() || player_arg.is_none() || actor_arg.is_none() {
            eprintln!(
                "raw launch requires --dev-identity, --endpoint, --player-id, and --actor-id"
            );
            std::process::exit(2);
        }
    }
    if let Some(q) = arg_value(&args, "--quality") {
        successor_client::set_render_quality(successor_client::parse_quality(&q));
    }

    #[cfg(not(target_arch = "wasm32"))]
    if mode.is_none() {
        let max_frames = arg_value(&args, "--frames").and_then(|s| s.parse::<u64>().ok());
        let screenshot = arg_value(&args, "--screenshot");
        let auto_walk = args.iter().any(|a| a == "--auto-walk");
        #[cfg(feature = "dev-tools")]
        if let (Some(endpoint), Some(player), Some(actor)) = (endpoint, player_arg, actor_arg) {
            std::process::exit(connected::run_dev(
                &endpoint,
                &player,
                &actor,
                max_frames,
                screenshot.as_deref(),
                auto_walk,
                assert_zero,
            ));
        }
        let raw = arg_value(&args, "--launch-context").unwrap_or_else(|| {
            eprintln!("ordinary launch requires --launch-context <json-or-file>");
            std::process::exit(2);
        });
        let text = if raw.trim_start().starts_with('{') {
            raw
        } else {
            std::fs::read_to_string(&raw).unwrap_or_else(|e| {
                eprintln!("failed to read launch context: {e}");
                std::process::exit(2);
            })
        };
        let value: serde_json::Value = serde_json::from_str(&text).unwrap_or_else(|e| {
            eprintln!("invalid launch context JSON: {e}");
            std::process::exit(2);
        });
        let mut envelope = LaunchEnvelope::from_json(
            &value,
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0),
        )
        .unwrap_or_else(|e| {
            eprintln!("launch rejected: {e:?}");
            std::process::exit(2);
        });
        std::process::exit(connected::run_launch(
            &mut envelope,
            max_frames,
            screenshot.as_deref(),
            auto_walk,
            assert_zero,
        ));
    }

    if mode.as_deref() == Some("glb-view") {
        let glb = arg_value(&args, "--glb").unwrap_or_else(|| {
            eprintln!("--demo glb-view requires --glb <path.glb>");
            std::process::exit(2);
        });
        let clip = arg_value(&args, "--clip");
        let screenshot = arg_value(&args, "--screenshot");
        run_glb_view(&glb, clip.as_deref(), frames, screenshot.as_deref());
        return;
    }

    if matches!(mode.as_deref(), Some("terrain" | "terrain-material")) {
        let biome = arg_value(&args, "--biome");
        let screenshot = arg_value(&args, "--screenshot");
        let gpu_stats = arg_value(&args, "--gpu-stats-json");
        let assert_material = args.iter().any(|arg| arg == "--assert-terrain-material");
        run_terrain(
            biome.as_deref(),
            frames,
            screenshot.as_deref(),
            gpu_stats.as_deref(),
            assert_material,
            mode.as_deref() == Some("terrain-material"),
        );
        return;
    }

    if mode.as_deref() == Some("props") {
        let screenshot = arg_value(&args, "--screenshot");
        run_props(frames, screenshot.as_deref());
        return;
    }

    if mode.as_deref() == Some("gi") {
        let screenshot = arg_value(&args, "--screenshot");
        let animate_camera = args.iter().any(|arg| arg == "--animate-camera");
        let assert_stable_gi = args.iter().any(|arg| arg == "--assert-stable-gi");
        run_gi(
            frames,
            screenshot.as_deref(),
            animate_camera,
            assert_stable_gi,
        );
        return;
    }

    if mode.as_deref() == Some("pawns") {
        let screenshot = arg_value(&args, "--screenshot");
        let camera_distance = arg_value(&args, "--camera-distance")
            .and_then(|value| value.parse::<f32>().ok())
            .unwrap_or(6.0)
            .clamp(1.5, 20.0);
        let camera_height = arg_value(&args, "--camera-height")
            .and_then(|value| value.parse::<f32>().ok())
            .unwrap_or(1.5)
            .clamp(-2.0, 10.0);
        let camera_yaw = arg_value(&args, "--camera-yaw-deg")
            .and_then(|value| value.parse::<f32>().ok())
            .unwrap_or(0.0)
            .to_radians();
        let orbit_speed = if args.iter().any(|arg| arg == "--camera-static") {
            0.0
        } else {
            0.01
        };
        run_pawns(
            frames,
            screenshot.as_deref(),
            camera_distance,
            camera_height,
            camera_yaw,
            orbit_speed,
        );
        return;
    }

    if mode.as_deref() == Some("ui") {
        let screenshot = arg_value(&args, "--screenshot");
        let surface = arg_value(&args, "--surface");
        run_ui(frames, screenshot.as_deref(), surface.as_deref());
        return;
    }

    // Pregame parity host. Presentation only: it drives `screens.rs` with a
    // local demo roster and never touches launch/auth authority.
    #[cfg(not(target_arch = "wasm32"))]
    if mode.as_deref() == Some("pregame") {
        let screenshot = arg_value(&args, "--screenshot");
        let stage = arg_value(&args, "--stage");
        run_pregame(frames, screenshot.as_deref(), stage.as_deref());
        return;
    }

    if mode.as_deref() == Some("fx") {
        let screenshot = arg_value(&args, "--screenshot");
        run_fx(frames, screenshot.as_deref());
        return;
    }

    if mode.as_deref() == Some("env") {
        let screenshot = arg_value(&args, "--screenshot");
        let minute = arg_value(&args, "--minute")
            .and_then(|s| s.parse::<f32>().ok())
            .unwrap_or(720.0);
        run_env(minute, frames, screenshot.as_deref());
        return;
    }

    if mode.as_deref() == Some("material-parity") {
        let screenshot = arg_value(&args, "--screenshot");
        let gpu_stats = arg_value(&args, "--gpu-stats-json");
        let assert_parity = args.iter().any(|arg| arg == "--assert-material-parity");
        run_material_parity(
            frames,
            screenshot.as_deref(),
            gpu_stats.as_deref(),
            assert_parity,
        );
        return;
    }

    if mode.is_some() || stats_json.is_some() || assert_zero {
        if gl {
            let screenshot = arg_value(&args, "--screenshot");
            run_windowed(frames, screenshot.as_deref(), None);
        } else {
            run_headless(frames, stats_json.as_deref(), assert_zero);
        }
        return;
    }

    eprintln!(
        "successor: no mode selected. Try `--demo parity-basic [--gl] [--frames N] \
         [--stats-json PATH] [--assert-zero-allocs]`, or `--demo pregame \
         [--stage entry|connecting|roster|roster-empty|create-profile|create-summary|loading] \
         [--frames N] [--screenshot PATH]`."
    );
    std::process::exit(2);
}

fn run_headless(frames: u64, stats_json: Option<&str>, assert_zero: bool) {
    let stats = demo::run_headless(frames);
    println!(
        "parity-basic headless: {} frames | p50={:.3}ms p99={:.3}ms peak_rss={}B frame-allocs {}",
        frames,
        stats.frame_p50_ms,
        stats.frame_p99_ms,
        stats.peak_rss_bytes,
        stats.frame_allocs_steady
    );
    if let Some(path) = stats_json {
        if let Err(e) = std::fs::write(path, stats.to_json()) {
            eprintln!("failed to write stats json {path}: {e}");
            std::process::exit(1);
        }
    }
    if assert_zero && stats.frame_allocs_steady != 0 {
        eprintln!(
            "ALLOC GATE FAIL: {} steady-state per-frame allocations (expected 0)",
            stats.frame_allocs_steady
        );
        std::process::exit(1);
    }
    println!("frame-allocs {}", stats.frame_allocs_steady);
}

#[cfg(not(target_arch = "wasm32"))]
fn run_material_parity(
    frames: u64,
    screenshot: Option<&str>,
    gpu_stats_json: Option<&str>,
    assert_parity: bool,
) {
    use successor_client::material_parity;
    use successor_engine_render::gpu::Gpu;
    if !successor_platform::init(
        "Successor Material Parity",
        material_parity::WIDTH as i32,
        material_parity::HEIGHT as i32,
    ) {
        eprintln!("platform init failed (no display?)");
        std::process::exit(1);
    }
    let assets: [Vec<u8>; 6] = material_parity::ASSET_PATHS.map(|path| {
        std::fs::read(path).unwrap_or_else(|error| {
            eprintln!("failed to read parity asset {path}: {error}");
            std::process::exit(1);
        })
    });
    let mut gpu = successor_platform::create_gpu();
    let mut scene = material_parity::build(&mut gpu, &assets).unwrap_or_else(|error| {
        eprintln!("failed to build material parity scene: {error}");
        std::process::exit(1);
    });
    let total = frames.max(1);
    let mut gpu_times = Vec::with_capacity(total.saturating_sub(120) as usize);
    let mut final_rgba = None;
    for frame in 0..total {
        successor_platform::begin_frame();
        let (width, height) = successor_platform::framebuffer_size();
        let start = std::time::Instant::now();
        if width > 0 && height > 0 {
            scene
                .renderer
                .render(&mut gpu, &mut scene.world, width as u32, height as u32)
                .expect("material parity render");
        }
        if gpu_stats_json.is_some() {
            gpu.finish();
            if frame >= 120 {
                gpu_times.push(start.elapsed().as_secs_f64() * 1_000.0);
            }
        }
        if frame + 1 == total && width > 0 && height > 0 && (screenshot.is_some() || assert_parity)
        {
            final_rgba = Some((
                successor_platform::read_pixels_rgba(width, height),
                width as u32,
                height as u32,
            ));
        }
        successor_platform::end_frame();
        if successor_platform::should_quit() {
            break;
        }
    }
    if let Some((rgba, width, height)) = final_rgba {
        if let Some(path) = screenshot {
            write_bmp(path, &rgba, width, height).unwrap_or_else(|error| {
                eprintln!("screenshot failed: {error}");
                std::process::exit(1);
            });
            println!("screenshot written: {path} ({width}x{height})");
        }
        if assert_parity {
            material_parity::probe_rgba_top_left(&rgba, width, height).unwrap_or_else(|error| {
                eprintln!("{error}");
                std::process::exit(1);
            });
        }
    }
    if let Some(path) = gpu_stats_json {
        if gpu_times.is_empty() {
            eprintln!("GPU stats require more than 120 rendered frames");
            std::process::exit(1);
        }
        gpu_times.sort_by(f64::total_cmp);
        let index = ((gpu_times.len() - 1) as f64 * 0.99).ceil() as usize;
        let p99 = gpu_times[index];
        let json = format!(
            "{{\"demo\":\"material-parity\",\"width\":{},\"height\":{},\"warmup_frames\":120,\"measured_frames\":{},\"render_gpu_p99_ms\":{:.6}}}\n",
            material_parity::WIDTH,
            material_parity::HEIGHT,
            gpu_times.len(),
            p99
        );
        std::fs::write(path, json).unwrap_or_else(|error| {
            eprintln!("failed to write GPU stats {path}: {error}");
            std::process::exit(1);
        });
        println!("material-parity render_gpu_p99_ms={p99:.3}");
    }
    successor_platform::deinit();
}

#[cfg(not(target_arch = "wasm32"))]
fn run_windowed(frames: u64, screenshot: Option<&str>, gpu_stats_json: Option<&str>) {
    use successor_engine_core::input::Key;
    use successor_engine_render::gpu::Gpu;
    if !successor_platform::init(
        "Successor (Rust client)",
        demo::SCREEN_W as i32,
        demo::SCREEN_H as i32,
    ) {
        eprintln!("platform init failed (no display?)");
        std::process::exit(1);
    }
    let mut gpu = successor_platform::create_gpu();
    let mut scene = demo::build_scene(&mut gpu);
    let icons = successor_client::hud::Icons::load();
    scene
        .renderer
        .set_ui_atlas(&mut gpu, icons.meta.width, icons.meta.height, &icons.rgba);
    let mut ui = icons.ui_builder();
    let mut graphics_tuner = successor_client::graphics_tuning::GraphicsTuner::new();
    let total = frames.max(1);
    let mut frame = 0u64;
    let mut gpu_times = Vec::with_capacity(total.saturating_sub(120) as usize);
    while !successor_platform::should_quit() && frame < total {
        successor_platform::begin_frame();
        scene.animate(frame);
        graphics_tuner.handle_toggle(successor_platform::is_key_down(Key::Backquote));
        let (w, h) = successor_platform::framebuffer_size();
        let start = std::time::Instant::now();
        if w > 0 && h > 0 {
            scene
                .renderer
                .render(&mut gpu, &mut scene.world, w as u32, h as u32)
                .expect("render failed");
        }
        if w > 0 && h > 0 {
            let (mx, my) = successor_platform::mouse_position();
            ui.set_input(mx, my, successor_platform::mouse_button_down(0));
            ui.begin(w as u32, h as u32);
            graphics_tuner.draw(&mut ui, &mut scene.renderer, &mut gpu, w as u32, h as u32);
            scene
                .renderer
                .render_ui(&mut gpu, &ui.buf, ui.quads, w as u32, h as u32);
        }
        if gpu_stats_json.is_some() {
            gpu.finish();
            if frame >= 120 {
                gpu_times.push(start.elapsed().as_secs_f64() * 1_000.0);
            }
        }
        if screenshot.is_some() && frame + 1 == total && w > 0 && h > 0 {
            let err = successor_platform::gl_error();
            if err != 0 {
                eprintln!("GL error before readback: 0x{err:04x}");
            }
            let rgba = successor_platform::read_pixels_rgba(w, h);
            match write_bmp(screenshot.unwrap(), &rgba, w as u32, h as u32) {
                Ok(()) => println!("screenshot written: {} ({}x{})", screenshot.unwrap(), w, h),
                Err(e) => eprintln!("screenshot failed: {e}"),
            }
        }
        successor_platform::end_frame();
        frame += 1;
    }
    if let Some(path) = gpu_stats_json {
        if gpu_times.is_empty() {
            eprintln!("GPU stats require more than 120 rendered frames");
            std::process::exit(1);
        }
        gpu_times.sort_by(f64::total_cmp);
        let index = ((gpu_times.len() - 1) as f64 * 0.99).ceil() as usize;
        let p99 = gpu_times[index];
        let json = format!(
            "{{\"demo\":\"material-parity\",\"width\":{},\"height\":{},\"warmup_frames\":120,\"measured_frames\":{},\"render_gpu_p99_ms\":{:.6}}}\n",
            demo::SCREEN_W,
            demo::SCREEN_H,
            gpu_times.len(),
            p99
        );
        if let Err(error) = std::fs::write(path, json) {
            eprintln!("failed to write GPU stats {path}: {error}");
            std::process::exit(1);
        }
        println!("material-parity render_gpu_p99_ms={p99:.3}");
    }
    successor_platform::deinit();
}

#[cfg(not(target_arch = "wasm32"))]
fn run_ui(frames: u64, screenshot: Option<&str>, surface: Option<&str>) {
    use successor_client::hud;
    use successor_engine_render::gpu::Gpu;
    use successor_engine_render::window::{WindowManager, WindowStyle};
    if !successor_platform::init("Successor UI", demo::SCREEN_W as i32, demo::SCREEN_H as i32) {
        eprintln!("platform init failed (no display?)");
        std::process::exit(1);
    }
    let mut gpu = successor_platform::create_gpu();
    let _ = &mut gpu as &mut dyn Gpu;
    let mut scene = demo::build_ui_scene(&mut gpu);
    let icons = hud::Icons::load();
    scene
        .renderer
        .set_ui_atlas(&mut gpu, icons.meta.width, icons.meta.height, &icons.rgba);
    let mut ui = icons.ui_builder();
    let mut hud_state = hud::HudState::default();
    let mut toolbar = hud::toolbar::Toolbar::new(hud::toolbar::ToolbarDoc::blank());
    // Demo-only slot seeding so the bar photographs occupied (connected mode
    // starts blank per the owner spec and loads the persisted doc).
    toolbar
        .doc
        .assign(0, hud::toolbar::SlotRef::Action("attack".into()));
    toolbar
        .doc
        .assign(1, hud::toolbar::SlotRef::Action("reload".into()));
    toolbar
        .doc
        .assign(4, hud::toolbar::SlotRef::Action("window:inventory".into()));
    let mut hud_actions: Vec<hud::HudAction> = Vec::with_capacity(8);
    let mut right_was_down = false;
    let win_model = successor_client::windows::WindowModel::visual_sample();
    // This fixture lives only in the `--demo ui` host; it is not a connected
    // projection. Pointerless inventory captures seed a concrete first stack
    // so the footer shows its details and authority-shaped actions.
    successor_client::windows::inventory::clear_selection();
    if surface == Some("inventory") {
        if let Some(row) = win_model.inventory.held().next() {
            successor_client::windows::inventory::select_identity(&row.container, &row.stack_id);
        }
    }
    // The demo consumes the same geometry registry as connected mode; a
    // screenshot is therefore proof of the shipping defaults, not a second
    // cascade policy.
    let mut wm = WindowManager::new();
    for (id, title, icon) in hud::DEMO_WINDOWS {
        let (rect, min_w, min_h) = successor_client::windows::spec::geometry(
            id,
            demo::SCREEN_W as f32,
            demo::SCREEN_H as f32,
        );
        wm.register(id, title, icons.cell(icon), rect, min_w, min_h);
    }
    hud::register_hud_surfaces_at(
        &mut wm,
        &icons,
        (demo::SCREEN_W as f32, demo::SCREEN_H as f32),
    );
    // A screenshot run is pointer-less, so seed one requested surface plus
    // representative live HUD state. One window at a time keeps overlap from
    // obscuring the component being reviewed. Pool depths come from the
    // original client's own authority export (`world-entry` checkpoint:
    // health 700, action 900, mind 1000), so the triple bar photographs at
    // real proportions instead of invented ones.
    if screenshot.is_some() {
        wm.open(surface.unwrap_or("actions"));
        hud_state.connection = hud::ConnectionHud::Live;
        hud_state.fine_text = "LIVE / 3 IN FIELD".into();
        hud_state.name = "DEMO OPERATIVE".into();
        hud_state.health = hud::GaugeHud {
            value: 616.0,
            max: 700.0,
        };
        hud_state.action = hud::GaugeHud {
            value: 540.0,
            max: 900.0,
        };
        hud_state.spirit = hud::GaugeHud {
            value: 1000.0,
            max: 1000.0,
        };
        hud_state.health_text = "616".into();
        hud_state.action_text = "540".into();
        hud_state.spirit_text = "1000".into();
        hud_state.area_label = "OPEN-DESERT".into();
        hud_state.weapon = Some(hud::WeaponHud {
            label: "SLUGTHROWER PISTOL".into(),
            melee: false,
            magazine_size: 8,
            loaded_rounds: 6,
            rounds_text: "6/8 - 24".into(),
            reloading: false,
            reload_frac: 0.0,
            swing_ready: false,
            swing_frac: 0.0,
        });
        hud_state.target = Some(hud::TargetHud {
            actor_id: "raider".into(),
            name: "RAIDER SCOUT".into(),
            relation: hud::RelationHud::Hostile,
            health: hud::GaugeHud {
                value: 434.0,
                max: 700.0,
            },
            action: Some(hud::GaugeHud {
                value: 720.0,
                max: 900.0,
            }),
            spirit: Some(hud::GaugeHud {
                value: 850.0,
                max: 1000.0,
            }),
            distance_m: Some(23.0),
            level: None,
            alive: true,
            stamp: None,
            chips: vec![hud::ChipHud {
                label: "HOSTILE".into(),
                danger: true,
            }],
        });
    }
    let total = frames.max(1);
    let mut frame = 0u64;
    while !successor_platform::should_quit() && frame < total {
        successor_platform::begin_frame();
        scene.animate(frame);
        // Route pointer + text input into the UI.
        let (mx, my) = successor_platform::mouse_position();
        ui.set_input(mx, my, successor_platform::mouse_button_down(0));
        let right_down = successor_platform::mouse_button_down(1);
        let right_pressed = right_down && !right_was_down;
        right_was_down = right_down;
        while successor_platform::poll_text_input().is_some() {}
        let (w, h) = successor_platform::framebuffer_size();
        if w > 0 && h > 0 {
            // The live rotating paperdoll fills whichever open pane owns a
            // viewer cell, so a UI capture shows the same doll connected mode
            // composites behind that cell.
            let paperdoll_pane = ["inventory", "examine", "converse"]
                .into_iter()
                .find(|id| wm.is_open(id) && !wm.is_iconified(id))
                .and_then(|id| wm.content_rect(id).map(|content| (id, content)))
                .map(|(id, content)| match id {
                    "examine" => successor_client::windows::live::examine_preview_rect(content),
                    "converse" => successor_client::windows::live::converse_preview_rect(content),
                    _ => successor_client::windows::inventory::layout(content).preview,
                });
            scene.set_paperdoll_viewport(paperdoll_pane, w as f32, h as f32);
            scene
                .renderer
                .render(&mut gpu, &mut scene.world, w as u32, h as u32)
                .expect("render failed");
            ui.begin(w as u32, h as u32);
            // HUD panes are locked by default. Their right-click context
            // toggle is intentionally separate from left-button manager input,
            // so normal gameplay clicks pass straight through.
            let hud_lock_changed = right_pressed
                .then(|| hud::toggle_hud_surface_lock_at(&mut wm, mx, my))
                .flatten();
            // Windows resolve pointer first (topmost consumes drag/close/focus).
            wm.update_at(
                &ui,
                w as u32,
                h as u32,
                successor_platform::now_ms().max(0.0) as u64,
            );
            let captured = wm.pointer_captured() || hud_lock_changed.is_some();
            ui.set_input_enabled(!captured);
            let palette = hud::palette(0);
            hud_actions.clear();
            let mut hud_frame = hud::HudFrame {
                state: &hud_state,
                toolbar: &mut toolbar,
                chat: None,
                palette,
                now_ms: successor_platform::now_ms().max(0.0) as u64,
                captured,
                right_pressed,
            };
            hud::build_hud(
                &mut ui,
                &icons,
                &mut hud_frame,
                &wm,
                w as u32,
                h as u32,
                &mut hud_actions,
            );
            ui.set_input_enabled(true);
            for action in hud_actions.drain(..) {
                match action {
                    hud::HudAction::ToggleWindow(id) => wm.toggle(id),
                    hud::HudAction::OpenWindow(id) => wm.open(id),
                    other => println!("ui action: {other:?}"),
                }
            }
            // Draw open windows back-to-front over the HUD. HUD panes already
            // drew their own content and layout affordance in `build_hud`.
            let style = WindowStyle::default();
            for idx in wm.z_order() {
                let id = wm.window_id(idx).to_string();
                let rect = wm.draw_chrome(&mut ui, idx, style);
                if hud::is_hud_surface(&id) {
                    continue;
                }
                // Demo windows discard emitted intents (no live authority to
                // route them to); inventory examine selection is window-local.
                let mut actions = Vec::new();
                successor_client::windows::content(
                    &mut ui,
                    &id,
                    rect,
                    &win_model,
                    &icons,
                    &mut actions,
                );
                drop(actions);
            }
            scene
                .renderer
                .render_ui(&mut gpu, &ui.buf, ui.quads, w as u32, h as u32);
        }
        if screenshot.is_some() && frame + 1 == total && w > 0 && h > 0 {
            let rgba = successor_platform::read_pixels_rgba(w, h);
            match write_bmp(screenshot.unwrap(), &rgba, w as u32, h as u32) {
                Ok(()) => println!("screenshot written: {} ({}x{})", screenshot.unwrap(), w, h),
                Err(e) => eprintln!("screenshot failed: {e}"),
            }
        }
        successor_platform::end_frame();
        frame += 1;
    }
    successor_platform::deinit();
}

#[cfg(not(target_arch = "wasm32"))]
fn run_fx(frames: u64, screenshot: Option<&str>) {
    use successor_engine_core::math::{Mat4, Vec3};
    use successor_engine_render::fx::{glow_sprite, ParticlePool};
    use successor_engine_render::gpu::{ClearSpec, Gpu, PassTarget, RectPx};
    if !successor_platform::init("Successor FX", demo::SCREEN_W as i32, demo::SCREEN_H as i32) {
        eprintln!("platform init failed (no display?)");
        std::process::exit(1);
    }
    let mut gpu = successor_platform::create_gpu();
    let mut renderer =
        successor_client::configured_renderer(&mut gpu).expect("renderer initialization failed");
    let sprite = glow_sprite(64);
    renderer.set_particle_atlas(&mut gpu, 64, 64, &sprite);
    let mut pool = ParticlePool::new(0x51ce_57ed);
    let eye = Vec3 {
        x: 5.0,
        y: 4.0,
        z: 5.0,
    };
    let center = Vec3 {
        x: 0.0,
        y: 1.0,
        z: 0.0,
    };
    // Billboard basis from the camera frame.
    let fwd = center.sub(eye).normalize();
    let right = fwd.cross(Vec3::Y).normalize();
    let up = right.cross(fwd);
    let total = frames.max(1);
    let mut frame = 0u64;
    let mut buf: Vec<f32> = Vec::with_capacity(64 * 1024);
    while !successor_platform::should_quit() && frame < total {
        successor_platform::begin_frame();
        let (w, h) = successor_platform::framebuffer_size();
        if w > 0 && h > 0 {
            // Clear to a dusk sky + depth.
            gpu.begin_pass(
                PassTarget::Screen,
                RectPx { x: 0, y: 0, w, h },
                ClearSpec {
                    color: Some([0.06, 0.07, 0.10, 1.0]),
                    depth: Some(1.0),
                },
            );
            gpu.end_pass();
            let aspect = w as f32 / h as f32;
            let vp = Mat4::perspective(0.9, aspect, 0.1, 100.0)
                .mul(Mat4::look_at(eye, center, Vec3::Y))
                .to_cols_array();
            // Sustained fire: a spark + blood burst every few frames.
            if frame.is_multiple_of(6) {
                pool.emit_spark_burst([0.0, 1.1, 0.0], [0.0, 1.0, 0.0], [1.0, -0.2, 0.3], 1.6);
                pool.emit_blood_burst([0.0, 1.1, 0.0], [1.0, 0.0, 0.3], 1.2);
            }
            pool.update(1.0 / 60.0);
            // Additive layer.
            buf.clear();
            let qa = pool.additive.fill_billboards(
                [right.x, right.y, right.z],
                [up.x, up.y, up.z],
                &mut buf,
            );
            renderer.render_particles(&mut gpu, &buf, qa, &vp, true, w as u32, h as u32);
            // Normal-blend layers (blood + residue).
            buf.clear();
            let mut qn = pool.normal.fill_billboards(
                [right.x, right.y, right.z],
                [up.x, up.y, up.z],
                &mut buf,
            );
            qn += pool.residue.fill_billboards(
                [right.x, right.y, right.z],
                [up.x, up.y, up.z],
                &mut buf,
            );
            renderer.render_particles(&mut gpu, &buf, qn, &vp, false, w as u32, h as u32);
        }
        if screenshot.is_some() && frame + 1 == total && w > 0 && h > 0 {
            let rgba = successor_platform::read_pixels_rgba(w, h);
            match write_bmp(screenshot.unwrap(), &rgba, w as u32, h as u32) {
                Ok(()) => println!("screenshot written: {} ({}x{})", screenshot.unwrap(), w, h),
                Err(e) => eprintln!("screenshot failed: {e}"),
            }
        }
        successor_platform::end_frame();
        frame += 1;
    }
    successor_platform::deinit();
}

#[cfg(not(target_arch = "wasm32"))]
fn run_env(minute: f32, frames: u64, screenshot: Option<&str>) {
    use successor_client::world::flora;
    use successor_client::GameWorld;
    use successor_engine_core::ecs::WorldOps;
    use successor_engine_core::math::{vec3, Quat, Vec3};
    use successor_engine_render::components::{
        CamTarget, Camera, DirectionalLight, MeshRenderer, Projection, RectNorm, Transform,
    };
    use successor_engine_render::environment;
    use successor_engine_render::gpu::ClearSpec;
    use successor_engine_render::primitives;
    if !successor_platform::init(
        "Successor env",
        demo::SCREEN_W as i32,
        demo::SCREEN_H as i32,
    ) {
        eprintln!("platform init failed (no display?)");
        std::process::exit(1);
    }
    let mut gpu = successor_platform::create_gpu();
    let mut renderer =
        successor_client::configured_renderer(&mut gpu).expect("renderer initialization failed");
    let mut world = GameWorld::new();

    let env = environment::sample(minute);
    // Grade + fog now run inside the deferred tonemap pass.
    renderer.set_grade(
        env.bone_tint,
        env.desaturate,
        env.scene_darken,
        env.black_lift,
    );
    renderer
        .set_bloom(1.0, env.bloom)
        .expect("sampled bloom settings are valid");
    renderer.set_fog(env.fog, 180.0, 340.0);

    let (gv, gi) = primitives::plane(200.0);
    let ground = renderer.upload_mesh(&mut gpu, &gv, &gi);
    let ground_mat = renderer.add_material_desc(successor_engine_render::renderer::MaterialDesc {
        base_color: [0.42, 0.36, 0.24, 1.0],
        blend: false,
        ..successor_engine_render::renderer::MaterialDesc::default()
    });
    let g = world.spawn();
    world.set_component(
        g,
        Transform {
            pos: Vec3::ZERO,
            rot: Quat::IDENTITY,
            scale: Vec3::ONE,
        },
    );
    world.set_component(
        g,
        MeshRenderer {
            mesh: ground,
            material: ground_mat,
            viewport_mask: 0b1,
            ..Default::default()
        },
    );

    // Flora / world objects scattered deterministically over the ground, each
    // rendered as a small shrub cube (verifies placement + density).
    let (cv, ci) = primitives::cube();
    let shrub = renderer.upload_mesh(&mut gpu, &cv, &ci);
    let shrub_mat = renderer.add_material_desc(successor_engine_render::renderer::MaterialDesc {
        base_color: [0.28, 0.42, 0.20, 1.0],
        blend: false,
        ..successor_engine_render::renderer::MaterialDesc::default()
    });
    let instances = flora::scatter(0x0d3d, [-20.0, -20.0], [20.0, 20.0], 0.5, |_p| false);
    for f in instances.iter().take(400) {
        let e = world.spawn();
        world.set_component(
            e,
            Transform {
                pos: vec3(f.pos[0], f.scale * 0.5, f.pos[2]),
                rot: Quat::from_axis_angle(Vec3::Y, f.yaw),
                scale: vec3(f.scale * 0.5, f.scale, f.scale * 0.5),
            },
        );
        world.set_component(
            e,
            MeshRenderer {
                mesh: shrub,
                material: shrub_mat,
                viewport_mask: 0b1,
                ..Default::default()
            },
        );
    }

    let sun = world.spawn();
    world.set_component(
        sun,
        DirectionalLight {
            dir: vec3(env.sun_dir[0], env.sun_dir[1], env.sun_dir[2]),
            color: env.sun_color,
            cast_shadows: true,
        },
    );

    let cam = world.spawn();
    world.set_component(
        cam,
        Camera {
            viewport_id: 0,
            order: 0,
            projection: Projection::Perspective {
                fovy: 0.9,
                near: 0.1,
                far: 400.0,
            },
            target: CamTarget::Screen(RectNorm::FULL),
            clear: ClearSpec {
                color: Some([env.fog[0], env.fog[1], env.fog[2], 1.0]),
                depth: Some(1.0),
            },
            eye: vec3(24.0, 20.0, 28.0),
            look_at: Vec3::ZERO,
            up: Vec3::Y,
        },
    );

    let total = frames.max(1);
    let mut frame = 0u64;
    while !successor_platform::should_quit() && frame < total {
        successor_platform::begin_frame();
        let (w, h) = successor_platform::framebuffer_size();
        if w > 0 && h > 0 {
            renderer
                .render(&mut gpu, &mut world, w as u32, h as u32)
                .expect("render failed");
        }
        if screenshot.is_some() && frame + 1 == total && w > 0 && h > 0 {
            let rgba = successor_platform::read_pixels_rgba(w, h);
            match write_bmp(screenshot.unwrap(), &rgba, w as u32, h as u32) {
                Ok(()) => println!(
                    "screenshot written: {} ({}x{}) minute={}",
                    screenshot.unwrap(),
                    w,
                    h,
                    minute
                ),
                Err(e) => eprintln!("screenshot failed: {e}"),
            }
        }
        successor_platform::end_frame();
        frame += 1;
    }
    successor_platform::deinit();
}

#[cfg(not(target_arch = "wasm32"))]
fn run_gi(frames: u64, screenshot: Option<&str>, animate_camera: bool, assert_stable_gi: bool) {
    use successor_client::GameWorld;
    use successor_engine_core::ecs::WorldOps;
    use successor_engine_core::math::{vec3, Mat4, Quat, Vec3};
    use successor_engine_render::components::{
        CamTarget, Camera, DirectionalLight, MeshRenderer, Projection, RectNorm, Transform,
    };
    use successor_engine_render::gi::GiOccluder;
    use successor_engine_render::gpu::ClearSpec;
    use successor_engine_render::primitives;

    if !successor_platform::init("Successor GI", demo::SCREEN_W as i32, demo::SCREEN_H as i32) {
        eprintln!("platform init failed (no display?)");
        std::process::exit(1);
    }
    let mut gpu = successor_platform::create_gpu();
    let mut renderer =
        successor_client::configured_renderer(&mut gpu).expect("renderer initialization failed");
    renderer.set_ambient(0.12);
    renderer.set_fog([0.02, 0.02, 0.03], 400.0, 800.0); // effectively off at this scale
    let mut world = GameWorld::new();

    let (cv, ci) = primitives::cube();
    let unit = renderer.upload_mesh(&mut gpu, &cv, &ci);

    // White ground: a thin scaled cube (outward-wound top face, unlike plane()).
    let ground_mat = renderer.add_material_desc(successor_engine_render::renderer::MaterialDesc {
        base_color: [1.0, 1.0, 1.0, 1.0],
        metallic: 0.0,
        roughness: 0.9,
        ..successor_engine_render::renderer::MaterialDesc::default()
    });
    let g = world.spawn();
    world.set_component(
        g,
        Transform {
            pos: vec3(0.0, -0.1, 6.0),
            rot: Quat::IDENTITY,
            scale: vec3(120.0, 0.2, 120.0),
        },
    );
    world.set_component(
        g,
        MeshRenderer {
            mesh: unit,
            material: ground_mat,
            viewport_mask: 0b1,
            ..Default::default()
        },
    );

    // Tall red wall at z=0 spanning x, front face (+z) toward the camera/floor.
    let wall_mat = renderer.add_material_desc(successor_engine_render::renderer::MaterialDesc {
        base_color: [0.85, 0.05, 0.05, 1.0],
        metallic: 0.0,
        roughness: 0.9,
        ..successor_engine_render::renderer::MaterialDesc::default()
    });
    let wall_c = vec3(0.0, 3.0, 0.0);
    let wall_h = vec3(8.0, 3.0, 0.4);
    let wall = world.spawn();
    world.set_component(
        wall,
        Transform {
            pos: wall_c,
            rot: Quat::IDENTITY,
            scale: vec3(wall_h.x * 2.0, wall_h.y * 2.0, wall_h.z * 2.0),
        },
    );
    world.set_component(
        wall,
        MeshRenderer {
            mesh: unit,
            material: wall_mat,
            viewport_mask: 0b1,
            ..Default::default()
        },
    );

    // White cube on the visible floor (casts a soft shadow toward the camera).
    let cube_mat = renderer.add_material_desc(successor_engine_render::renderer::MaterialDesc {
        base_color: [0.95, 0.95, 0.95, 1.0],
        metallic: 0.0,
        roughness: 0.9,
        ..successor_engine_render::renderer::MaterialDesc::default()
    });
    let cube_c = vec3(3.0, 1.0, 8.0);
    let cube = world.spawn();
    world.set_component(
        cube,
        Transform {
            pos: cube_c,
            rot: Quat::IDENTITY,
            scale: vec3(2.0, 2.0, 2.0),
        },
    );
    world.set_component(
        cube,
        MeshRenderer {
            mesh: unit,
            material: cube_mat,
            viewport_mask: 0b1,
            ..Default::default()
        },
    );

    // Static GI occluder proxies.
    renderer.gi_set_ground_albedo([1.0, 1.0, 1.0]);
    renderer.gi_set_occluders(&[
        GiOccluder {
            center: [wall_c.x, wall_c.y, wall_c.z],
            half_extents: [wall_h.x, wall_h.y, wall_h.z],
            yaw: 0.0,
            albedo: [0.85, 0.05, 0.05],
        },
        GiOccluder {
            center: [cube_c.x, cube_c.y, cube_c.z],
            half_extents: [1.0, 1.0, 1.0],
            yaw: 0.0,
            albedo: [0.95, 0.95, 0.95],
        },
    ]);

    // Sun raking from +z and above onto the wall's front face.
    let sun = world.spawn();
    let sd = Vec3 {
        x: 0.0,
        y: -1.0,
        z: -1.0,
    }
    .normalize();
    world.set_component(
        sun,
        DirectionalLight {
            dir: sd,
            color: [1.0, 1.0, 1.0],
            cast_shadows: true,
        },
    );

    let eye = vec3(0.0, 12.0, 24.0);
    let look = vec3(0.0, 1.0, 6.0);
    renderer.gi_set_focus([look.x, look.y, look.z]);
    let cam = world.spawn();
    world.set_component(
        cam,
        Camera {
            viewport_id: 0,
            order: 0,
            projection: Projection::Perspective {
                fovy: 0.7,
                near: 0.1,
                far: 400.0,
            },
            target: CamTarget::Screen(RectNorm::FULL),
            clear: ClearSpec {
                color: Some([0.02, 0.02, 0.03, 1.0]),
                depth: Some(1.0),
            },
            eye,
            look_at: look,
            up: Vec3::Y,
        },
    );

    let mut stability_before = None;
    let mut scroll_before = None;
    let mut stability_frames = 0u64;
    let mut stability_samples = Vec::with_capacity(600);
    let mut scroll_samples = Vec::with_capacity(256);
    let mut diagnostic_complete = !animate_camera;

    let total = if animate_camera {
        frames.max(900)
    } else {
        frames.max(1)
    };
    let mut frame = 0u64;
    while !successor_platform::should_quit() && frame < total {
        if animate_camera && stability_before.is_some() && stability_frames < 600 {
            let angle = stability_frames as f32 * core::f32::consts::TAU / 600.0;
            if let Some(camera) = world.get_component::<Camera>(cam) {
                camera.eye = eye.add(vec3(angle.sin() * 8.0, 0.0, angle.cos() * 8.0));
                camera.look_at = look.add(vec3(angle.cos() * 8.0, 0.0, angle.sin() * 8.0));
            }
        }
        let render_started = std::time::Instant::now();
        successor_platform::begin_frame();
        let (w, h) = successor_platform::framebuffer_size();
        if w > 0 && h > 0 {
            renderer
                .render(&mut gpu, &mut world, w as u32, h as u32)
                .expect("render failed");
        }
        let render_ms = render_started.elapsed().as_secs_f64() * 1000.0;
        if animate_camera {
            if stability_before.is_none() && renderer.gi_is_idle() {
                stability_before = Some(renderer.gi_work_counters());
            } else if stability_before.is_some() && stability_frames < 600 {
                stability_samples.push(render_ms);
                stability_frames += 1;
                if stability_frames == 600 {
                    let before = stability_before.expect("GI stability baseline");
                    let after = renderer.gi_work_counters();
                    let delta = gi_counter_delta(after, before);
                    let (p50, p99) = percentiles(&mut stability_samples);
                    println!(
                        "gi-stability albedo_builds={} radiance_builds={} resident_uploads={} mipmap_rebuilds={} full_rebuilds={} p50_ms={:.3} p99_ms={:.3}",
                        delta.albedo_builds,
                        delta.radiance_builds,
                        delta.resident_uploads,
                        delta.mipmap_rebuilds,
                        delta.full_rebuilds,
                        p50,
                        p99
                    );
                    if assert_stable_gi && delta != Default::default() {
                        eprintln!("camera motion scheduled GI work");
                        std::process::exit(1);
                    }
                    scroll_before = Some(after);
                    renderer.gi_set_focus([look.x + 6.0, look.y, look.z]);
                }
            } else if let Some(before) = scroll_before {
                scroll_samples.push(render_ms);
                if renderer.gi_is_idle() && !diagnostic_complete {
                    let delta = gi_counter_delta(renderer.gi_work_counters(), before);
                    let (p50, p99) = percentiles(&mut scroll_samples);
                    println!(
                        "gi-scroll albedo_builds={} radiance_builds={} resident_uploads={} mipmap_rebuilds={} full_rebuilds={} p50_ms={:.3} p99_ms={:.3}",
                        delta.albedo_builds,
                        delta.radiance_builds,
                        delta.resident_uploads,
                        delta.mipmap_rebuilds,
                        delta.full_rebuilds,
                        p50,
                        p99
                    );
                    let expected = successor_engine_render::gi::GiWorkCounters {
                        albedo_builds: 8,
                        radiance_builds: 8,
                        resident_uploads: 8,
                        mipmap_rebuilds: 1,
                        full_rebuilds: 0,
                    };
                    if assert_stable_gi && delta != expected {
                        eprintln!("GI scroll work was not bounded: {delta:?}");
                        std::process::exit(1);
                    }
                    if let Some(camera) = world.get_component::<Camera>(cam) {
                        camera.eye = eye;
                        camera.look_at = look;
                    }
                    diagnostic_complete = true;
                }
            }
        }
        if frame + 1 == total && w > 0 && h > 0 {
            let rgba = successor_platform::read_pixels_rgba(w, h);
            let aspect = w as f32 / h as f32;
            let view = Mat4::look_at(eye, look, Vec3::Y);
            let proj = Mat4::perspective(0.7, aspect, 0.1, 400.0);
            let vp = proj.mul(view).to_cols_array();
            let wf = w as f32;
            let hf = h as f32;
            // Project a world floor point to a pixel (GL bottom-up).
            let project = |p: [f32; 3]| -> (i32, i32) {
                let cx = vp[0] * p[0] + vp[4] * p[1] + vp[8] * p[2] + vp[12];
                let cy = vp[1] * p[0] + vp[5] * p[1] + vp[9] * p[2] + vp[13];
                let cw = vp[3] * p[0] + vp[7] * p[1] + vp[11] * p[2] + vp[15];
                let ndx = cx / cw;
                let ndy = cy / cw;
                (
                    ((ndx * 0.5 + 0.5) * wf) as i32,
                    ((ndy * 0.5 + 0.5) * hf) as i32,
                )
            };
            let win = 10i32;
            let sample = |px: i32, py: i32| -> (f32, f32, f32) {
                let (mut r, mut gg, mut b, mut n) = (0.0f32, 0.0f32, 0.0f32, 0.0f32);
                for dy in -win..=win {
                    for dx in -win..=win {
                        let x = px + dx;
                        let y = py + dy;
                        if x < 0 || y < 0 || x >= w || y >= h {
                            continue;
                        }
                        let i = ((y as u32 * w as u32 + x as u32) * 4) as usize;
                        r += rgba[i] as f32;
                        gg += rgba[i + 1] as f32;
                        b += rgba[i + 2] as f32;
                        n += 1.0;
                    }
                }
                if n > 0.0 {
                    (r / n, gg / n, b / n)
                } else {
                    (0.0, 0.0, 0.0)
                }
            };
            // Floor probes: near the red wall vs far from it.
            let (nx, ny) = project([0.0, 0.02, 1.0]);
            let (fx, fy) = project([0.0, 0.02, 14.0]);
            let (nr, _ng, nb) = sample(nx, ny);
            let (fr, _fg, fb) = sample(fx, fy);
            let near_rb = nr / nb.max(1.0);
            let far_rb = fr / fb.max(1.0);
            println!(
                "gi-check quality={:?} near_r/b={:.3} far_r/b={:.3} ratio={:.3} (expect >=1.15 with GI)",
                successor_client::render_quality(), near_rb, far_rb, near_rb / far_rb.max(1e-3)
            );
            // Shadow probes: behind the cube (shadowed) vs open floor.
            let (sx, sy) = project([3.0, 0.02, 6.0]);
            let (lx, ly) = project([-4.0, 0.02, 6.0]);
            let lum = |c: (f32, f32, f32)| 0.299 * c.0 + 0.587 * c.1 + 0.114 * c.2;
            let shadow_lum = lum(sample(sx, sy));
            let lit_lum = lum(sample(lx, ly));
            // Penumbra width: scan the row between shadow and lit probes, count
            // pixels in the mid-luminance transition band.
            let row = (sy + ly) / 2;
            let (x0, x1) = (sx.min(lx), sx.max(lx));
            let mut penumbra = 0i32;
            for x in x0..=x1 {
                if x < 0 || x >= w || row < 0 || row >= h {
                    continue;
                }
                let i = ((row as u32 * w as u32 + x as u32) * 4) as usize;
                let l = 0.299 * rgba[i] as f32
                    + 0.587 * rgba[i + 1] as f32
                    + 0.114 * rgba[i + 2] as f32;
                let t = (l - shadow_lum) / (lit_lum - shadow_lum).max(1.0);
                if t > 0.2 && t < 0.8 {
                    penumbra += 1;
                }
            }
            println!(
                "shadow-check quality={:?} lit_lum={:.1} shadow_lum={:.1} penumbra_px={}",
                successor_client::render_quality(),
                lit_lum,
                shadow_lum,
                penumbra
            );
            if let Some(path) = screenshot {
                match write_bmp(path, &rgba, w as u32, h as u32) {
                    Ok(()) => println!("screenshot written: {} ({}x{})", path, w, h),
                    Err(e) => eprintln!("screenshot failed: {e}"),
                }
            }
        }
        successor_platform::end_frame();
        frame += 1;
    }
    successor_platform::deinit();
}

#[cfg(not(target_arch = "wasm32"))]
fn gi_counter_delta(
    after: successor_engine_render::gi::GiWorkCounters,
    before: successor_engine_render::gi::GiWorkCounters,
) -> successor_engine_render::gi::GiWorkCounters {
    successor_engine_render::gi::GiWorkCounters {
        albedo_builds: after.albedo_builds - before.albedo_builds,
        radiance_builds: after.radiance_builds - before.radiance_builds,
        resident_uploads: after.resident_uploads - before.resident_uploads,
        mipmap_rebuilds: after.mipmap_rebuilds - before.mipmap_rebuilds,
        full_rebuilds: after.full_rebuilds - before.full_rebuilds,
    }
}

#[cfg(not(target_arch = "wasm32"))]
fn percentiles(samples: &mut [f64]) -> (f64, f64) {
    if samples.is_empty() {
        return (0.0, 0.0);
    }
    samples.sort_by(f64::total_cmp);
    let at = |quantile: f64| {
        let index = ((samples.len() - 1) as f64 * quantile).round() as usize;
        samples[index]
    };
    (at(0.50), at(0.99))
}

#[cfg(not(target_arch = "wasm32"))]
fn run_glb_view(glb_path: &str, clip: Option<&str>, frames: u64, screenshot: Option<&str>) {
    use successor_client::glb_scene::GlbScene;
    use successor_engine_render::gpu::Gpu;
    let bytes = match std::fs::read(glb_path) {
        Ok(b) => b,
        Err(e) => {
            eprintln!("failed to read {glb_path}: {e}");
            std::process::exit(1);
        }
    };
    if !successor_platform::init(
        "Successor GLB viewer",
        demo::SCREEN_W as i32,
        demo::SCREEN_H as i32,
    ) {
        eprintln!("platform init failed (no display?)");
        std::process::exit(1);
    }
    let mut gpu = successor_platform::create_gpu();
    let _ = &mut gpu as &mut dyn Gpu;
    let mut scene = match GlbScene::build(&mut gpu, &bytes, clip) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("GLB parse failed for {glb_path}: {e:?}");
            successor_platform::deinit();
            std::process::exit(1);
        }
    };
    let total = frames.max(1);
    let mut frame = 0u64;
    while !successor_platform::should_quit() && frame < total {
        successor_platform::begin_frame();
        scene.animate(frame);
        let (w, h) = successor_platform::framebuffer_size();
        if w > 0 && h > 0 {
            scene
                .renderer
                .render(&mut gpu, &mut scene.world, w as u32, h as u32)
                .expect("render failed");
        }
        if screenshot.is_some() && frame + 1 == total && w > 0 && h > 0 {
            let err = successor_platform::gl_error();
            if err != 0 {
                eprintln!("GL error before readback: 0x{err:04x}");
            }
            let rgba = successor_platform::read_pixels_rgba(w, h);
            match write_bmp(screenshot.unwrap(), &rgba, w as u32, h as u32) {
                Ok(()) => println!("screenshot written: {} ({}x{})", screenshot.unwrap(), w, h),
                Err(e) => eprintln!("screenshot failed: {e}"),
            }
        }
        successor_platform::end_frame();
        frame += 1;
    }
    successor_platform::deinit();
}

#[cfg(not(target_arch = "wasm32"))]
fn run_terrain(
    biome: Option<&str>,
    frames: u64,
    screenshot: Option<&str>,
    gpu_stats_json: Option<&str>,
    assert_material: bool,
    detail_view: bool,
) {
    use successor_client::world::chunks::TerrainScene;
    use successor_client::world::terrain::Biome;
    use successor_engine_render::gpu::Gpu;
    let biome = match biome {
        Some("forest") => Biome::Forest,
        _ => Biome::Desert,
    };
    if !successor_platform::init(
        "Successor terrain material",
        demo::SCREEN_W as i32,
        demo::SCREEN_H as i32,
    ) {
        eprintln!("platform init failed (no display?)");
        std::process::exit(1);
    }
    let mut gpu = successor_platform::create_gpu();
    let _ = &mut gpu as &mut dyn Gpu;
    let mut scene = TerrainScene::build(&mut gpu, biome);
    if detail_view {
        scene.use_material_detail_view();
    }
    assert_eq!(
        successor_platform::gl_error(),
        0,
        "terrain GPU resource initialization failed"
    );
    let total = frames.max(1);
    let mut gpu_times = Vec::with_capacity(total.saturating_sub(120) as usize);
    let mut final_rgba = None;
    for frame in 0..total {
        successor_platform::begin_frame();
        scene.animate(frame);
        let (width, height) = successor_platform::framebuffer_size();
        let start = std::time::Instant::now();
        if width > 0 && height > 0 {
            scene
                .renderer
                .render(&mut gpu, &mut scene.world, width as u32, height as u32)
                .expect("terrain render failed");
            if gpu_stats_json.is_some() {
                gpu.finish();
                if frame >= 120 {
                    gpu_times.push(start.elapsed().as_secs_f64() * 1_000.0);
                }
            }
            assert_eq!(
                successor_platform::gl_error(),
                0,
                "terrain render produced an OpenGL error"
            );
        }
        if frame + 1 == total
            && width > 0
            && height > 0
            && (screenshot.is_some() || assert_material)
        {
            final_rgba = Some((
                successor_platform::read_pixels_rgba(width, height),
                width as u32,
                height as u32,
            ));
        }
        successor_platform::end_frame();
        if successor_platform::should_quit() {
            break;
        }
    }
    if let Some((rgba, width, height)) = final_rgba {
        if let Some(path) = screenshot {
            write_bmp(path, &rgba, width, height).unwrap_or_else(|error| {
                eprintln!("screenshot failed: {error}");
                std::process::exit(1);
            });
            println!("screenshot written: {path} ({width}x{height})");
        }
        if assert_material {
            assert_terrain_material_pixels(&rgba, width, height);
        }
    }
    if let Some(path) = gpu_stats_json {
        if gpu_times.is_empty() {
            eprintln!("terrain GPU stats require more than 120 rendered frames");
            std::process::exit(1);
        }
        gpu_times.sort_by(f64::total_cmp);
        let index = ((gpu_times.len() - 1) as f64 * 0.99).ceil() as usize;
        let p99 = gpu_times[index];
        let json = format!(
            "{{\"demo\":\"terrain-material\",\"width\":{},\"height\":{},\"warmup_frames\":120,\"measured_frames\":{},\"render_gpu_p99_ms\":{:.6}}}\n",
            demo::SCREEN_W,
            demo::SCREEN_H,
            gpu_times.len(),
            p99
        );
        std::fs::write(path, json).unwrap_or_else(|error| {
            eprintln!("failed to write terrain GPU stats {path}: {error}");
            std::process::exit(1);
        });
        println!("terrain-material render_gpu_p99_ms={p99:.3}");
    }
    successor_platform::deinit();
}

#[cfg(not(target_arch = "wasm32"))]
fn assert_terrain_material_pixels(rgba: &[u8], width: u32, height: u32) {
    let probe = successor_client::world::terrain_material::probe_rgba(rgba, width, height)
        .unwrap_or_else(|error| panic!("{error}"));
    println!(
        "terrain-material luma_mean={:.5} luma_stddev={:.5} neighbor_delta={:.5} repeat_delta={:.5}",
        probe.luma_mean, probe.luma_stddev, probe.neighbor_delta, probe.repeat_delta
    );
}

#[cfg(not(target_arch = "wasm32"))]
fn run_props(frames: u64, screenshot: Option<&str>) {
    use successor_client::world::props::WorldScene;
    use successor_engine_render::gpu::Gpu;
    let assets_dir = "../client-3d/public/assets";
    let mapping = match std::fs::read_to_string("../client-3d/src/render/props-mapping.json") {
        Ok(s) => s,
        Err(e) => {
            eprintln!("read props-mapping: {e}");
            std::process::exit(1);
        }
    };
    let slice =
        match std::fs::read_to_string("../client/public/successor-slice/open-desert-slice.json") {
            Ok(s) => s,
            Err(e) => {
                eprintln!("read slice: {e}");
                std::process::exit(1);
            }
        };
    if !successor_platform::init(
        "Successor world",
        demo::SCREEN_W as i32,
        demo::SCREEN_H as i32,
    ) {
        eprintln!("platform init failed (no display?)");
        std::process::exit(1);
    }
    let mut gpu = successor_platform::create_gpu();
    let _ = &mut gpu as &mut dyn Gpu;
    let mut scene = match WorldScene::build(&mut gpu, assets_dir, &mapping, &slice) {
        Ok(s) => s,
        Err(()) => {
            eprintln!("world scene build failed");
            successor_platform::deinit();
            std::process::exit(1);
        }
    };
    let total = frames.max(1);
    let mut frame = 0u64;
    while !successor_platform::should_quit() && frame < total {
        successor_platform::begin_frame();
        scene.animate(frame);
        let (w, h) = successor_platform::framebuffer_size();
        if w > 0 && h > 0 {
            scene
                .renderer
                .render(&mut gpu, &mut scene.world, w as u32, h as u32)
                .expect("render failed");
        }
        if screenshot.is_some() && frame + 1 == total && w > 0 && h > 0 {
            let rgba = successor_platform::read_pixels_rgba(w, h);
            match write_bmp(screenshot.unwrap(), &rgba, w as u32, h as u32) {
                Ok(()) => println!("screenshot written: {} ({}x{})", screenshot.unwrap(), w, h),
                Err(e) => eprintln!("screenshot failed: {e}"),
            }
        }
        successor_platform::end_frame();
        frame += 1;
    }
    successor_platform::deinit();
}

#[cfg(not(target_arch = "wasm32"))]
fn run_pawns(
    frames: u64,
    screenshot: Option<&str>,
    camera_distance: f32,
    camera_height: f32,
    camera_yaw: f32,
    orbit_speed: f32,
) {
    use successor_client::pawn::scene::{PawnScene, PawnView};
    use successor_engine_render::gpu::Gpu;
    let path = "../client-3d/public/assets/pawn-pack/pawn_male.glb";
    let bytes = match std::fs::read(path) {
        Ok(b) => b,
        Err(e) => {
            eprintln!("read {path}: {e}");
            std::process::exit(1);
        }
    };
    if !successor_platform::init(
        "Successor pawns",
        demo::SCREEN_W as i32,
        demo::SCREEN_H as i32,
    ) {
        eprintln!("platform init failed (no display?)");
        std::process::exit(1);
    }
    let mut gpu = successor_platform::create_gpu();
    let _ = &mut gpu as &mut dyn Gpu;
    let mut scene = match PawnScene::build(
        &mut gpu,
        &bytes,
        PawnView {
            distance: camera_distance,
            height: camera_height,
            yaw_radians: camera_yaw,
            orbit_speed,
        },
    ) {
        Ok(s) => s,
        Err(()) => {
            eprintln!("pawn scene build failed");
            successor_platform::deinit();
            std::process::exit(1);
        }
    };
    let total = frames.max(1);
    let mut frame = 0u64;
    while !successor_platform::should_quit() && frame < total {
        successor_platform::begin_frame();
        scene.animate(frame);
        let (w, h) = successor_platform::framebuffer_size();
        if w > 0 && h > 0 {
            scene
                .renderer
                .render(&mut gpu, &mut scene.world, w as u32, h as u32)
                .expect("render failed");
        }
        if screenshot.is_some() && frame + 1 == total && w > 0 && h > 0 {
            let rgba = successor_platform::read_pixels_rgba(w, h);
            match write_bmp(screenshot.unwrap(), &rgba, w as u32, h as u32) {
                Ok(()) => println!("screenshot written: {} ({}x{})", screenshot.unwrap(), w, h),
                Err(e) => eprintln!("screenshot failed: {e}"),
            }
        }
        successor_platform::end_frame();
        frame += 1;
    }
    successor_platform::deinit();
}

/// Write RGBA8 bottom-up pixels as a 24-bit BMP (BMP is bottom-up, matching GL).
#[cfg(not(target_arch = "wasm32"))]
fn write_bmp(path: &str, rgba: &[u8], w: u32, h: u32) -> std::io::Result<()> {
    let row_bytes = (w * 3 + 3) & !3; // padded to 4 bytes
    let img_size = row_bytes * h;
    let file_size = 54 + img_size;
    let mut out: Vec<u8> = Vec::with_capacity(file_size as usize);
    out.extend_from_slice(b"BM");
    out.extend_from_slice(&file_size.to_le_bytes());
    out.extend_from_slice(&0u32.to_le_bytes());
    out.extend_from_slice(&54u32.to_le_bytes());
    out.extend_from_slice(&40u32.to_le_bytes());
    out.extend_from_slice(&(w as i32).to_le_bytes());
    out.extend_from_slice(&(h as i32).to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&24u16.to_le_bytes());
    out.extend_from_slice(&0u32.to_le_bytes());
    out.extend_from_slice(&img_size.to_le_bytes());
    out.extend_from_slice(&2835i32.to_le_bytes());
    out.extend_from_slice(&2835i32.to_le_bytes());
    out.extend_from_slice(&0u32.to_le_bytes());
    out.extend_from_slice(&0u32.to_le_bytes());
    for y in 0..h {
        for x in 0..w {
            let i = ((y * w + x) * 4) as usize;
            // RGBA -> BGR
            out.push(rgba[i + 2]);
            out.push(rgba[i + 1]);
            out.push(rgba[i]);
        }
        for _ in 0..(row_bytes - w * 3) {
            out.push(0);
        }
    }
    std::fs::write(path, out)
}

fn arg_value(args: &[String], key: &str) -> Option<String> {
    let mut it = args.iter();
    while let Some(a) = it.next() {
        if a == key {
            return it.next().cloned();
        }
        if let Some(v) = a.strip_prefix(key).and_then(|r| r.strip_prefix('=')) {
            return Some(v.to_string());
        }
    }
    None
}
#[cfg(all(not(target_arch = "wasm32"), feature = "dev-tools"))]
fn environment_flag(name: &str) -> bool {
    std::env::var(name).ok().is_some_and(|value| {
        matches!(
            value.to_ascii_lowercase().as_str(),
            "1" | "true" | "yes" | "on"
        )
    })
}
#[cfg(all(not(target_arch = "wasm32"), feature = "dev-tools"))]
fn configure_automation(args: &[String]) {
    let control_requested =
        args.iter().any(|arg| arg == "--control") || environment_flag("SUCCESSOR_CONTROL");
    let explicit_port = arg_value(args, "--control-port");
    if args.iter().any(|arg| arg == "--control-port") && explicit_port.is_none() {
        eprintln!("--control-port requires a port number");
        std::process::exit(2);
    }
    let port = if let Some(value) = explicit_port {
        Some(value.parse::<u16>().unwrap_or_else(|_| {
            eprintln!("invalid --control-port: {value}");
            std::process::exit(2);
        }))
    } else if control_requested {
        Some(
            std::env::var("SUCCESSOR_CONTROL_PORT")
                .ok()
                .map(|value| {
                    value.parse::<u16>().unwrap_or_else(|_| {
                        eprintln!("invalid SUCCESSOR_CONTROL_PORT: {value}");
                        std::process::exit(2);
                    })
                })
                .unwrap_or(successor_platform::DEFAULT_CONTROL_PORT),
        )
    } else {
        None
    };
    let record_path = arg_value(args, "--record-input").map(std::path::PathBuf::from);
    let replay_path = arg_value(args, "--replay-input").map(std::path::PathBuf::from);
    if port.is_none() && record_path.is_none() && replay_path.is_none() {
        return;
    }

    let status = successor_platform::configure_control(successor_platform::ControlConfig {
        port,
        record_path,
        replay_path,
    })
    .unwrap_or_else(|error| {
        eprintln!("control configuration failed: {error}");
        std::process::exit(2);
    });
    if let Some(port) = status.listen_port {
        println!("successor_control_server=127.0.0.1:{port}");
    }
    if status.recording {
        println!("successor_input_recording=active");
    }
    if status.replaying {
        println!("successor_input_replay=active");
    }
}

/// Live playable slice: connect to a local authority, project actors, send
/// movement, render with the GL backend. Native-only. Requires a display and a
/// running authority; verified by compile/link here and by the headless
/// projection/movement/chat unit tests. Live run command is in PARITY.md.
#[cfg(not(target_arch = "wasm32"))]
mod connected {
    use serde_json::json;
    use successor_client::game::actions;
    use successor_client::game::chat_net::{ChatClient, ChatConnectionState};
    use successor_client::game::command_queue::CommandQueue;
    use successor_client::game::connected_scene::{ConnectedScene, CONNECTED_INPUT_KEYS};
    use successor_client::game::movement;
    use successor_client_proto::colyseus;
    use successor_client_proto::packets::GameServerPacket;
    use successor_client_proto::session::{
        Session, SessionEvent, SessionOut, SessionState, WsInput,
    };
    use successor_engine_core::input::Key;
    use successor_engine_render::gpu::Gpu;
    use successor_engine_render::ui::TextField;
    use successor_platform as plat;

    use std::path::PathBuf;
    use successor_client::net::session::{GameConnection, GameLifecycle, LaunchEnvelope};
    use successor_client::{App, AppMode};
    use successor_platform::{NativePlatform, Platform, SettingsScope};

    #[cfg(feature = "dev-tools")]
    pub fn run_dev(
        endpoint: &str,
        player_id: &str,
        actor_id: &str,
        max_frames: Option<u64>,
        screenshot: Option<&str>,
        auto_walk: bool,
        assert_zero: bool,
    ) -> i32 {
        let chat_endpoint = successor_client::net::connect::dev_chat_endpoint(endpoint, player_id);
        run_inner(
            endpoint,
            player_id,
            actor_id,
            None,
            None,
            chat_endpoint,
            None,
            None,
            max_frames,
            screenshot,
            auto_walk,
            assert_zero,
        )
    }

    pub fn run_launch(
        envelope: &mut LaunchEnvelope,
        max_frames: Option<u64>,
        screenshot: Option<&str>,
        auto_walk: bool,
        assert_zero: bool,
    ) -> i32 {
        let game_ticket = match envelope.consume_game_ticket() {
            Ok(ticket) => ticket,
            Err(error) => {
                eprintln!("game ticket rejected: {error:?}");
                return 2;
            }
        };
        // Keep this distinct capability only until the chat socket's first
        // authentication frame; ChatConnection takes it and immediately clears it.
        let chat_ticket = match envelope.consume_chat_ticket() {
            Ok(ticket) => ticket,
            Err(error) => {
                eprintln!("chat ticket rejected: {error:?}");
                return 2;
            }
        };
        let endpoint = envelope.game_endpoint.clone();
        let chat_endpoint = envelope.chat_endpoint.clone();
        let client_release = envelope.client_release.clone();
        let character = envelope.character_id.clone();
        run_inner(
            &endpoint,
            &character,
            &character,
            Some(game_ticket),
            Some(chat_ticket),
            Some(chat_endpoint),
            Some(client_release),
            envelope.shard.as_deref(),
            max_frames,
            screenshot,
            auto_walk,
            assert_zero,
        )
    }
    #[allow(clippy::too_many_arguments)]
    fn run_inner(
        endpoint: &str,
        player_id: &str,
        actor_id: &str,
        game_ticket: Option<String>,
        chat_ticket: Option<String>,
        chat_endpoint: Option<String>,
        client_release: Option<String>,
        expected_shard: Option<&str>,
        max_frames: Option<u64>,
        screenshot: Option<&str>,
        auto_walk: bool,
        assert_zero: bool,
    ) -> i32 {
        // Ordinary launch carries a one-use ticket; only explicit dev mode
        // reaches this function without one.
        let http_endpoint = endpoint
            .replacen("wss://", "https://", 1)
            .replacen("ws://", "http://", 1);
        let opts = if let Some(ticket) = game_ticket.as_deref() {
            json!({ "characterId": player_id, "gameTicket": ticket })
        } else {
            json!({ "playerId": player_id, "actorId": actor_id })
        };
        let settings_root = std::env::var_os("HOME")
            .map(PathBuf::from)
            .unwrap_or_else(std::env::temp_dir)
            .join("Library")
            .join("Application Support")
            .join("Successor")
            .join("rust-client");
        let mut app = App::new(NativePlatform {
            asset_root: PathBuf::from(".."),
            settings_root,
        });
        app.mode = AppMode::Loading;
        let mut lifecycle = GameLifecycle::default();
        lifecycle.begin_matchmake();
        let (url, body) = match colyseus::build_matchmake_request(&http_endpoint, &opts) {
            Ok(v) => v,
            Err(e) => {
                eprintln!("matchmake request build failed: {e}");
                return 1;
            }
        };
        let resp = match plat::http_post_json(&url, &body) {
            Ok(r) => r,
            Err(e) => {
                eprintln!("matchmake POST failed: {e}");
                return 1;
            }
        };
        let seat = match colyseus::parse_seat_reservation(&resp) {
            Ok(s) => s,
            Err(e) => {
                eprintln!("seat reservation parse failed: {e}");
                return 1;
            }
        };
        let ws_url = colyseus::build_ws_url(endpoint, &seat);

        // 2) Window + GL + the composed connected scene (terrain + props + pawns
        //    + HUD), driven by the authority store.
        if !plat::init("Successor (Rust client)", 1280, 720) {
            eprintln!("platform init failed (no display?)");
            return 1;
        }
        let mut gpu = plat::create_gpu();
        let _ = &mut gpu as &mut dyn Gpu;
        let theme =
            successor_client::persist::load_section(&app.platform, SettingsScope::Local, "theme");
        let toolbar =
            successor_client::persist::load_section(&app.platform, SettingsScope::Local, "toolbar");
        let split_snap = successor_client::persist::load_section(
            &app.platform,
            SettingsScope::Local,
            "splitSnap",
        );
        let waypoints = successor_client::persist::load_section(
            &app.platform,
            SettingsScope::Character,
            "waypoints",
        );
        let macros = successor_client::persist::load_section(
            &app.platform,
            SettingsScope::Character,
            "macros",
        );
        let window_layout = successor_client::persist::load_section(
            &app.platform,
            SettingsScope::Local,
            "windowLayout",
        );
        let mut read_asset = |stable_id: &str| app.platform.read_asset(stable_id).ok();
        let mut scene = match ConnectedScene::build(&mut gpu, player_id, &mut read_asset) {
            Ok(s) => s,
            Err(e) => {
                eprintln!("connected scene build failed: {e}");
                plat::deinit();
                return 1;
            }
        };
        scene.load_persisted(
            theme.as_ref(),
            toolbar.as_ref(),
            split_snap.as_ref(),
            waypoints.as_ref(),
            macros.as_ref(),
            window_layout.as_ref(),
        );
        let audio_mixer = scene.audio_mixer();
        let _audio_output = if assert_zero {
            None
        } else {
            Some(plat::AudioOutput::start(
                successor_client::audio::OUT_RATE,
                Box::new(move |out| {
                    audio_mixer
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner)
                        .mix_into(out);
                }),
            ))
        };

        // Namespace commands with process time and the authenticated player;
        // movement and verbs never use a synthetic command id.
        let player_num = player_id
            .bytes()
            .fold(2166136261u64, |hash, byte| {
                (hash ^ byte as u64).wrapping_mul(16777619)
            })
            .max(1);
        let session_num = plat::now_ms().max(1.0) as u64;
        let command_floor = session_num.saturating_mul(1000).max(1);
        scene.set_command_queue(CommandQueue::new(
            successor_net::SessionId(session_num),
            successor_net::PlayerId(player_num as u32),
            command_floor,
        ));
        // 3) Connect + drive.
        let mut ws = match plat::ws_connect(&ws_url) {
            Ok(w) => w,
            Err(e) => {
                eprintln!("ws connect failed: {e}");
                plat::deinit();
                return 1;
            }
        };
        let mut sess = Session::new();
        sess.start_connecting();
        let mut buf: Vec<u8> = Vec::with_capacity(64 * 1024);
        let mut chat_ticket = chat_ticket;
        let mut chat_client =
            ChatClient::with_endpoint(128, chat_endpoint.clone().unwrap_or_default());
        chat_client.connection.begin();
        let mut chat_ws = chat_endpoint
            .as_deref()
            .and_then(|url| match plat::ws_connect(url) {
                Ok(socket) => Some(socket),
                Err(error) => {
                    chat_client.connection.failed(&error);
                    None
                }
            });
        let mut last_intent = (0i32, 0i32, false);
        let mut chat_buf = Vec::with_capacity(64 * 1024);
        let mut chat_input = TextField::new(320);
        let mut chat_enter_was_down = false;
        let mut chat_backspace_was_down = false;
        let mut chat_escape_was_down = false;
        let mut view_sent = false;
        let mut frame: u64 = 0;
        #[cfg(feature = "alloc-count")]
        let mut connected_frame_allocs = 0u64;
        #[cfg(feature = "alloc-count")]
        let mut connected_actor_count = 0usize;
        #[cfg(feature = "alloc-count")]
        let mut connected_stable_frames = 0u64;
        #[cfg(feature = "alloc-count")]
        let mut connected_alloc_frame = None;

        while !plat::should_quit() && max_frames.is_none_or(|m| frame < m) {
            plat::begin_frame();
            // Chat is deliberately independent: loss degrades only chat while
            // the authoritative game scene and movement continue rendering.
            if let Some(socket) = chat_ws.as_mut() {
                chat_buf.clear();
                for _ in 0..64 {
                    match plat::ws_poll(socket, &mut chat_buf) {
                        plat::WsEvent::Frame(n) => {
                            if let Some(message) =
                                chat_client.on_incoming(&String::from_utf8_lossy(&chat_buf[..n]))
                            {
                                scene.ingest_chat_message(&message);
                            }
                        }
                        plat::WsEvent::None => break,
                        plat::WsEvent::Open => {
                            if let Some(frame) = chat_client.connection.authenticate(
                                &mut chat_ticket,
                                client_release.as_deref().unwrap_or_default(),
                            ) {
                                plat::ws_send(socket, frame.as_bytes());
                            }
                        }
                        plat::WsEvent::Closed | plat::WsEvent::Error => {
                            chat_client.connection.lost();
                            break;
                        }
                    }
                }
            }

            // Drain socket → session; feed packets into the scene + combat FX.
            // Bound socket work so a continuously streaming authority cannot
            // starve input, rendering, status probes, or screenshot acks.
            for _ in 0..64 {
                buf.clear();
                let ev = plat::ws_poll(&mut ws, &mut buf);
                let (outs, brk) = match ev {
                    plat::WsEvent::Open => (sess.on_ws_event(WsInput::Open), false),
                    plat::WsEvent::Frame(n) => (sess.on_ws_event(WsInput::Frame(&buf[..n])), false),
                    plat::WsEvent::Closed => (sess.on_ws_event(WsInput::Closed), true),
                    plat::WsEvent::Error => (sess.on_ws_event(WsInput::Error("ws error")), true),
                    plat::WsEvent::None => break,
                };
                for out in outs {
                    match out {
                        SessionOut::SendFrame(f) => plat::ws_send(&mut ws, &f),
                        SessionOut::Emit(SessionEvent::Hello(hello)) => {
                            lifecycle.authenticated();
                            if let Err(error) =
                                lifecycle.validate_hello(&hello, None, expected_shard)
                            {
                                app.fail(format!("game hello rejected: {error:?}"));
                                eprintln!("game hello rejected: {error:?}");
                                return 2;
                            }
                            if lifecycle.state != GameConnection::Connected {
                                app.fail("game lifecycle did not reach Connected");
                                return 2;
                            }
                            app.mode = AppMode::Connected;
                            scene.set_loading(false);
                            scene.on_snapshot(&hello.snapshot);
                        }
                        SessionOut::Emit(SessionEvent::Packet(packet)) => {
                            if let GameServerPacket::Error { code, message } = &packet {
                                eprintln!("game.error {code}: {message}");
                            }
                            scene.apply_server_packet(packet);
                        }
                        SessionOut::Emit(SessionEvent::Error(m)) => eprintln!("session error: {m}"),
                        SessionOut::Emit(SessionEvent::Closed) => eprintln!("session closed"),
                        SessionOut::Emit(SessionEvent::ReconnectAttempt {
                            attempt,
                            max_attempts,
                        }) => {
                            eprintln!("reconnect {attempt}/{max_attempts}");
                        }
                    }
                }
                if brk {
                    if lifecycle.socket_lost().is_none()
                        && lifecycle.state == GameConnection::Exhausted
                    {
                        app.fail("game reconnect exhausted");
                    }
                    break;
                }
            }

            // Declare AOI view interest once ready so deltas stream.
            if !view_sent && sess.state() == SessionState::Ready {
                let view = json!({ "viewport_width_cells": 96, "viewport_height_cells": 96, "margin_cells": 32 });
                if let Ok(SessionOut::SendFrame(f)) = sess.send_view(&view) {
                    plat::ws_send(&mut ws, &f);
                }
                view_sent = true;
            }
            while let Some(c) = plat::poll_text_input() {
                if chat_input.focused {
                    chat_input.insert(c);
                }
            }
            let enter_down = plat::is_key_down(Key::Enter);
            let backspace_down = plat::is_key_down(Key::Backspace);
            let escape_down = plat::is_key_down(Key::Escape);
            let enter_pressed = enter_down && !chat_enter_was_down;
            let backspace_pressed = backspace_down && !chat_backspace_was_down;
            let escape_pressed = escape_down && !chat_escape_was_down;
            chat_enter_was_down = enter_down;
            chat_backspace_was_down = backspace_down;
            chat_escape_was_down = escape_down;
            let chat_consumed_escape = escape_pressed && chat_input.focused;
            if chat_consumed_escape {
                chat_input.focused = false;
            } else if enter_pressed {
                if chat_input.focused && !chat_input.text.trim().is_empty() {
                    let line = chat_input.text.clone();
                    let command = chat_client.submit_input(&line);
                    if let Some(payload) = chat_client.command_frame(command) {
                        if let Some(socket) = chat_ws.as_mut() {
                            plat::ws_send(socket, payload.as_bytes());
                            chat_input.clear();
                        }
                    }
                } else {
                    chat_input.focused = true;
                }
            } else if backspace_pressed && chat_input.focused {
                chat_input.backspace();
            }

            scene.handle_tuning_toggle(plat::is_key_down(Key::Backquote));

            // Connected input is translated into gameplay actions, then queued
            // with fresh ids. UI/window keys are consumed by the scene locally.
            scene.set_move_intent(0, 0, false);
            if sess.state() == SessionState::Ready {
                let intent = if scene.tuning_open() || chat_input.focused {
                    (0, 0, false)
                } else if auto_walk {
                    (0, -1, false)
                } else {
                    let (manual_dx, manual_dy, held_sprint) =
                        movement::intent_from_keys(plat::is_key_down);
                    let (dx, dy) = scene.navigation_intent(manual_dx, manual_dy);
                    (dx, dy, held_sprint || scene.sprint_toggled())
                };
                let actor_dead = scene
                    .player_actor()
                    .is_some_and(|actor| actor.life_state != "alive");
                let predicted_intent = if actor_dead { (0, 0, false) } else { intent };
                scene.set_move_intent(predicted_intent.0, predicted_intent.1, predicted_intent.2);
                let moving = intent != (0, 0, false);
                if actor_dead {
                    if last_intent != (0, 0, false) {
                        let _ = scene.release_movement(movement::StopReason::Dead);
                        last_intent = (0, 0, false);
                    }
                } else if intent != last_intent || (moving && frame.is_multiple_of(6)) {
                    last_intent = intent;
                    let _ = scene.dispatch_gameplay_action(actions::GameplayAction::Move {
                        dx: intent.0,
                        dy: intent.1,
                        facing: movement::facing_from_intent(intent.0, intent.1),
                        sprint: intent.2,
                    });
                }
                if chat_consumed_escape || chat_input.focused {
                    // Chat owns Escape while editing; keep the scene edge reset
                    // so releasing the key cannot close a window afterward.
                    let _ = scene.handle_key(Key::Escape, false);
                } else {
                    let _ = scene.handle_key(Key::Escape, escape_pressed);
                }
                if !chat_input.focused {
                    for key in CONNECTED_INPUT_KEYS {
                        if key == Key::Escape {
                            continue;
                        }
                        if let Some(action) = scene.handle_key(key, plat::is_key_down(key)) {
                            let _ = scene.dispatch_gameplay_action(action);
                        }
                    }
                }
                let (mx, my) = plat::mouse_position();
                if let Some(action) = scene.handle_pointer(
                    mx,
                    my,
                    plat::mouse_button_down(0),
                    plat::mouse_button_down(1),
                    scene.pointer_captured(),
                ) {
                    let _ = scene.dispatch_gameplay_action(action);
                }
                if let Some((_, scroll_y)) = plat::poll_scroll_delta() {
                    scene.handle_scroll(scroll_y);
                }
                while let Some(env) = scene.take_next_command() {
                    if let Ok(SessionOut::SendFrame(f)) = sess.send_command(&env) {
                        plat::ws_send(&mut ws, &f);
                    }
                }
            } else if last_intent != (0, 0, false) {
                let _ = scene.release_movement(movement::StopReason::Disconnected);
                last_intent = (0, 0, false);
            }
            let _ = plat::is_key_down(Key::Escape);

            let (w, h) = plat::framebuffer_size();
            if w > 0
                && h > 0
                && chat_client.connection.state == ChatConnectionState::Online
                && frame.is_multiple_of(300)
            {
                if let Some(socket) = chat_ws.as_mut() {
                    let ping = chat_client.ping();
                    plat::ws_send(socket, ping.as_bytes());
                }
            }
            let actor = scene.player_actor();
            let status = plat::ControlStatusV2 {
                frame,
                framebuffer: (w > 0 && h > 0).then_some((w as u32, h as u32)),
                app_mode: Some(format!("{:?}", app.mode)),
                game_connection: format!("{:?}", lifecycle.state),
                chat_connection: match chat_client.connection.state {
                    ChatConnectionState::Online => "connected",
                    ChatConnectionState::Connecting
                    | ChatConnectionState::Authenticating
                    | ChatConnectionState::SyncingHistory
                    | ChatConnectionState::Reconnecting => "reconnecting",
                    ChatConnectionState::Offline
                    | ChatConnectionState::Degraded
                    | ChatConnectionState::Exhausted => "degraded",
                }
                .into(),
                shard: scene.shard_id().map(str::to_owned),
                tick: Some(scene.store.tick),
                area: scene.area_id().map(str::to_owned),
                source_hashes: scene.store.source_state_hash.iter().cloned().collect(),
                player_actor_id: (!scene.store.player_actor_id.is_empty())
                    .then(|| scene.store.player_actor_id.clone()),
                player_position: actor.map(|a| (a.x, a.y)),
                life: actor.map(|a| a.life_state.clone()),
                selection: scene.selected_actor_id().map(str::to_owned),
                windows: scene.open_window_ids(),
                focused_window: scene.focused_window_id(),
                pending_command_kinds: scene.pending_command_kinds(),
                last_receipt: scene.store.last_receipt.as_ref().map(|r| {
                    format!(
                        "{}:{}",
                        if r.accepted { "accepted" } else { "rejected" },
                        r.reason_code.as_deref().unwrap_or("ok")
                    )
                }),
                renderer_degradation_ids: Vec::new(),
            };
            plat::publish_control_status(status);
            #[cfg(feature = "alloc-count")]
            successor_engine_core::rt::alloc::reset_alloc_count();
            if w > 0 && h > 0 {
                let mut read_asset = |stable_id: &str| app.platform.read_asset(stable_id).ok();
                scene.frame(
                    &mut gpu,
                    w as u32,
                    h as u32,
                    1.0 / 60.0,
                    &mut read_asset,
                    &mut chat_client,
                    &mut chat_input,
                );
                #[cfg(feature = "alloc-count")]
                {
                    let actor_count = scene.actor_count();
                    if actor_count != connected_actor_count {
                        connected_actor_count = actor_count;
                        connected_stable_frames = 0;
                        connected_frame_allocs = 0;
                    } else {
                        connected_stable_frames = connected_stable_frames.saturating_add(1);
                        if connected_stable_frames > 240 {
                            let allocations = successor_engine_core::rt::alloc::alloc_count();
                            connected_frame_allocs = connected_frame_allocs.max(allocations);
                            if allocations != 0 {
                                connected_alloc_frame.get_or_insert(frame);
                            }
                        }
                    }
                }
            }
            if let Some(report) = scene.take_bug_report() {
                if let Ok(SessionOut::SendFrame(frame)) =
                    sess.send_message("support.bug-report", &report)
                {
                    plat::ws_send(&mut ws, &frame);
                }
            }
            let (theme, toolbar, split_snap, waypoints, macros, window_layout) =
                scene.take_persisted();
            for (scope, key, value) in [
                (SettingsScope::Local, "theme", theme),
                (SettingsScope::Local, "toolbar", toolbar),
                (SettingsScope::Local, "splitSnap", split_snap),
                (SettingsScope::Character, "waypoints", waypoints),
                (SettingsScope::Character, "macros", macros),
                (SettingsScope::Local, "windowLayout", window_layout),
            ] {
                if let Some(value) = value {
                    if let Err(error) = successor_client::persist::store_section(
                        &mut app.platform,
                        scope,
                        key,
                        value,
                    ) {
                        eprintln!("settings save failed for {key}: {error}");
                    }
                }
            }
            if let (Some(path), true) = (screenshot, max_frames.is_some_and(|m| frame + 1 == m)) {
                if w > 0 && h > 0 {
                    let rgba = plat::read_pixels_rgba(w, h);
                    match crate::write_bmp(path, &rgba, w as u32, h as u32) {
                        Ok(()) => println!("screenshot written: {} ({}x{})", path, w, h),
                        Err(e) => eprintln!("screenshot failed: {e}"),
                    }
                }
            }
            plat::end_frame();
            frame += 1;
        }

        if sess.state() != SessionState::Ready || lifecycle.state != GameConnection::Connected {
            eprintln!(
                "connected run failed: session={:?} lifecycle={:?}",
                sess.state(),
                lifecycle.state
            );
            plat::deinit();
            return 1;
        }

        let p = scene.player_pos();
        println!(
            "connected summary: actors={} player_pos=({:.2},{:.2},{:.2}) session_state={:?}",
            scene.actor_count(),
            p.x,
            p.y,
            p.z,
            sess.state()
        );
        if last_intent != (0, 0, false) {
            let _ = scene.release_movement(movement::StopReason::ControlReleased);
            while let Some(env) = scene.take_next_command() {
                if let Ok(SessionOut::SendFrame(f)) = sess.send_command(&env) {
                    plat::ws_send(&mut ws, &f);
                }
            }
        }
        lifecycle.intentional_exit();
        app.mode = AppMode::Entry;
        if let Ok(SessionOut::SendFrame(f)) = sess.exit_world() {
            plat::ws_send(&mut ws, &f);
        }
        if assert_zero {
            #[cfg(feature = "alloc-count")]
            {
                if connected_stable_frames < 240 {
                    eprintln!(
                        "CONNECTED ALLOC GATE FAIL: only {connected_stable_frames} stable frames"
                    );
                    plat::deinit();
                    return 1;
                }
                println!(
                    "connected-frame-allocs {connected_frame_allocs} first-frame {:?}",
                    connected_alloc_frame
                );
                if connected_frame_allocs != 0 {
                    eprintln!(
                        "CONNECTED ALLOC GATE FAIL: {connected_frame_allocs} steady-state allocations"
                    );
                    plat::deinit();
                    return 1;
                }
            }
            #[cfg(not(feature = "alloc-count"))]
            {
                eprintln!("connected allocation probe requires alloc-count");
                plat::deinit();
                return 2;
            }
        }
        plat::deinit();
        0
    }
}

#[cfg(feature = "dev-tools")]
fn run_model_corpus() {
    use std::io::Read;

    let mut input = Vec::new();
    if let Err(error) = std::io::stdin().read_to_end(&mut input) {
        eprintln!("failed to read model list: {error}");
        std::process::exit(1);
    }
    let mut models = 0usize;
    let mut primitives = 0usize;
    let mut materials = 0usize;
    let mut images = 0usize;
    let mut decode_errors = 0usize;
    let mut transform_errors = 0usize;
    let mut unsupported = 0usize;
    let mut skipped = 0usize;
    for path_bytes in input
        .split(|byte| *byte == 0)
        .filter(|path| !path.is_empty())
    {
        let Ok(path) = std::str::from_utf8(path_bytes) else {
            skipped += 1;
            continue;
        };
        if !path.ends_with(".glb") {
            eprintln!("unsupported tracked model: {path}");
            unsupported += 1;
            continue;
        }
        let full_path = std::path::Path::new("..").join(path);
        let bytes = match std::fs::read(&full_path) {
            Ok(bytes) => bytes,
            Err(error) => {
                eprintln!("failed to read {}: {error}", full_path.display());
                skipped += 1;
                continue;
            }
        };
        let document = match successor_engine_core::glb::parse(&bytes) {
            Ok(document) => document,
            Err(error) => {
                eprintln!("failed to parse {path}: {error:?}");
                unsupported += 1;
                continue;
            }
        };
        models += 1;
        primitives += document
            .meshes
            .iter()
            .map(|mesh| mesh.primitives.len())
            .sum::<usize>();
        materials += document.materials.len();
        images += document.images.len();
        for image in &document.images {
            if successor_engine_core::image::decode_image(&image.mime_type, &image.bytes).is_err() {
                eprintln!("failed to decode embedded image in {path}");
                decode_errors += 1;
            }
        }
        let rest_pose: Vec<successor_engine_core::anim::JointTransform> = document
            .nodes
            .iter()
            .map(|node| successor_engine_core::anim::JointTransform {
                t: node.translation,
                r: node.rotation,
                s: node.scale,
            })
            .collect();
        if rest_pose
            .iter()
            .any(|transform| transform.matrix().m.iter().any(|value| !value.is_finite()))
        {
            transform_errors += 1;
        }
        for animation in &document.animations {
            if animation.samplers.iter().any(|sampler| {
                sampler
                    .input
                    .iter()
                    .chain(sampler.output.iter())
                    .any(|value| !value.is_finite())
            }) {
                transform_errors += 1;
                continue;
            }
            for time in [0.0, animation.duration * 0.5, animation.duration] {
                let mut pose = rest_pose.clone();
                successor_engine_core::anim::apply_animation(animation, time, &mut pose);
                if pose
                    .iter()
                    .any(|transform| transform.matrix().m.iter().any(|value| !value.is_finite()))
                {
                    transform_errors += 1;
                }
                for skin_index in 0..document.skins.len() {
                    let Some(mut skeleton) =
                        successor_engine_core::anim::Skeleton::from_document(&document, skin_index)
                    else {
                        transform_errors += 1;
                        continue;
                    };
                    let mut palette = Vec::with_capacity(skeleton.joint_count());
                    skeleton.compute_palette(&pose, &mut palette);
                    if palette.iter().flatten().any(|value| !value.is_finite()) {
                        transform_errors += 1;
                    }
                }
            }
        }
        if document.skins.iter().any(|skin| skin.joints.len() > 64) {
            unsupported += 1;
        }
    }
    println!(
        "{{\"models\":{models},\"primitives\":{primitives},\"materials\":{materials},\"images\":{images},\"unsupported\":{unsupported},\"decode_errors\":{decode_errors},\"transform_errors\":{transform_errors},\"skipped\":{skipped}}}"
    );
    if unsupported + decode_errors + transform_errors + skipped != 0 {
        std::process::exit(1);
    }
}

/// Pregame parity host — renders the entry → roster → creation flow from
/// `screens.rs` against a local demo roster so the surfaces can be exercised
/// and photographed without a server.
///
/// **Auth invariant:** this is a `--demo` mode, so it is already behind the
/// `dev-tools` gate in `main`. It never opens a socket and never constructs a
/// `LaunchEnvelope`; the `Connect` intent is printed and answered with a local
/// simulated link, and `SelectCharacter` / `CreateCharacter` are printed and
/// acknowledged on-screen. Ordinary native launch still requires
/// `--launch-context` and the production ticket path, untouched by this code.
#[cfg(not(target_arch = "wasm32"))]
fn run_pregame(frames: u64, screenshot: Option<&str>, stage: Option<&str>) {
    use successor_client::hud;
    use successor_client::screens::{
        CharacterScreen, CharacterStage, EntryScreen, LoadingScreen, RosterEntry, ScreenAction,
    };
    use successor_engine_core::input::Key;
    use successor_engine_render::gpu::{ClearSpec, Gpu, PassTarget, RectPx};
    use successor_platform as plat;

    /// Which surface the host is showing. The demo owns this transition table;
    /// each screen owns its own internal stages.
    enum Phase {
        Entry(EntryScreen),
        Character(Box<CharacterScreen>),
        Loading(LoadingScreen),
    }

    // Demo rows are presentation-only: they carry no host stable id, which is
    // exactly what `selected_stable_id()` reports as absent.
    fn demo_roster() -> Vec<RosterEntry> {
        vec![
            RosterEntry {
                name: "Sarath Halvex".into(),
                lineage: "TERRAN".into(),
                vocation: "MARKSMAN".into(),
                location: "OPEN-DESERT".into(),
                played: "31H 12M".into(),
                ..Default::default()
            },
            RosterEntry {
                name: "Velira Okoro".into(),
                lineage: "IRIDIAN".into(),
                vocation: "SCOUT".into(),
                location: "SALT FLATS".into(),
                played: "8H 40M".into(),
                ..Default::default()
            },
            RosterEntry {
                name: "Tordan Moss".into(),
                lineage: "VOSKAN".into(),
                vocation: "TECHNICIAN".into(),
                location: "TIDEWORKS".into(),
                played: "112H 05M".into(),
                ..Default::default()
            },
        ]
    }

    let stage = stage.unwrap_or("entry");
    let known = [
        "entry",
        "connecting",
        "roster",
        "roster-empty",
        "create-profile",
        "create-summary",
        "loading",
    ];
    if !known.contains(&stage) {
        eprintln!(
            "--demo pregame --stage must be one of: {}",
            known.join(", ")
        );
        std::process::exit(2);
    }

    // Seed the requested stage directly so a pointer-less screenshot run can
    // photograph any surface in the flow.
    let mut phase = match stage {
        "connecting" => {
            let mut entry = EntryScreen::new();
            entry.begin_connecting();
            Phase::Entry(entry)
        }
        "entry" => Phase::Entry(EntryScreen::new()),
        "loading" => {
            let mut screen = LoadingScreen::default();
            screen.set_indeterminate(true);
            Phase::Loading(screen)
        }
        other => {
            let roster = if other == "roster-empty" {
                Vec::new()
            } else {
                demo_roster()
            };
            let mut screen = CharacterScreen::with_entries(roster);
            screen.set_stage(match other {
                "create-profile" => CharacterStage::CreateProfile,
                "create-summary" => CharacterStage::CreateIdentity,
                _ => CharacterStage::Roster,
            });
            if other == "create-summary" {
                screen.draft.lineage = 2;
                screen.draft.vocation = 1;
                screen.draft.build = 0.62;
                screen.draft.generate();
            }
            Phase::Character(Box::new(screen))
        }
    };

    if !plat::init(
        "Successor Pregame",
        demo::SCREEN_W as i32,
        demo::SCREEN_H as i32,
    ) {
        eprintln!("platform init failed (no display?)");
        std::process::exit(1);
    }
    let mut gpu = plat::create_gpu();
    let mut renderer =
        successor_client::configured_renderer(&mut gpu).expect("renderer initialization failed");
    let icons = hud::Icons::load();
    renderer.set_ui_atlas(&mut gpu, icons.meta.width, icons.meta.height, &icons.rgba);
    let mut ui = icons.ui_builder();

    println!(
        "pregame demo: stage={stage} (presentation only — no network, no launch context)\n  \
         mouse: click to interact · TAB / SHIFT+TAB: field focus · UP / DOWN: roster\n  \
         ENTER: confirm · ESC: back one step · typing edits the focused field"
    );

    // Simulated link: the demo answers its own Connect intent after a beat so
    // the connecting surface is observable, then hands over a local roster.
    let mut link_deadline: Option<f64> = None;
    let mut tab_was = false;
    let (mut enter_was, mut back_was, mut esc_was) = (false, false, false);
    let (mut up_was, mut down_was) = (false, false);

    let total = frames.max(1);
    let mut frame = 0u64;
    let mut quit = false;
    while !plat::should_quit() && frame < total && !quit {
        plat::begin_frame();
        let now = plat::now_ms().max(0.0);
        let (w, h) = plat::framebuffer_size();
        if w <= 0 || h <= 0 {
            plat::end_frame();
            frame += 1;
            continue;
        }

        // A screenshot run has no pointer; park it off-surface so nothing
        // photographs in a hover state.
        let (mx, my) = if screenshot.is_some() {
            (-1.0, -1.0)
        } else {
            plat::mouse_position()
        };
        ui.set_input(mx, my, screenshot.is_none() && plat::mouse_button_down(0));

        let shift = plat::is_key_down(Key::LeftShift);
        let tab = plat::is_key_down(Key::Tab);
        let tab_edge = tab && !tab_was;
        tab_was = tab;
        let enter = plat::is_key_down(Key::Enter);
        let enter_edge = enter && !enter_was;
        enter_was = enter;
        let backspace = plat::is_key_down(Key::Backspace);
        let backspace_edge = backspace && !back_was;
        back_was = backspace;
        let escape = plat::is_key_down(Key::Escape);
        let escape_edge = escape && !esc_was;
        esc_was = escape;
        let up = plat::is_key_down(Key::Up);
        let up_edge = up && !up_was;
        up_was = up;
        let down = plat::is_key_down(Key::Down);
        let down_edge = down && !down_was;
        down_was = down;

        let fw = w as f32;
        let fh = h as f32;
        let dt = 1.0 / 60.0;

        // Keyboard + text routing, then draw, then act on the emitted intent.
        let mut action = None;
        match &mut phase {
            Phase::Entry(entry) => {
                entry.tick(dt);
                while let Some(c) = plat::poll_text_input() {
                    entry.input_char(c);
                }
                if tab_edge {
                    if shift {
                        entry.focus_prev();
                    } else {
                        entry.focus_next();
                    }
                }
                if backspace_edge {
                    entry.backspace();
                }
                if escape_edge {
                    entry.reset();
                    link_deadline = None;
                }

                ui.begin(w as u32, h as u32);
                action = entry.draw(&mut ui, fw, fh);
                if enter_edge && action.is_none() {
                    action = Some(ScreenAction::Connect(entry.join_options()));
                    entry.begin_connecting();
                }
            }
            Phase::Character(screen) => {
                screen.tick(dt);
                while let Some(c) = plat::poll_text_input() {
                    screen.input_char(c);
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
                    screen.move_selection(-1, fw, fh);
                }
                if down_edge {
                    screen.move_selection(1, fw, fh);
                }
                if escape_edge {
                    match screen.stage() {
                        CharacterStage::CreateIdentity => {
                            screen.set_stage(CharacterStage::CreateProfile)
                        }
                        CharacterStage::CreateProfile => screen.set_stage(CharacterStage::Roster),
                        CharacterStage::Roster => action = Some(ScreenAction::Back),
                    }
                }

                ui.begin(w as u32, h as u32);
                let drawn = screen.draw(&mut ui, fw, fh);
                if drawn.is_some() {
                    action = drawn;
                }
            }
            Phase::Loading(screen) => {
                screen.tick(dt);
                if escape_edge {
                    action = Some(ScreenAction::Back);
                }
                ui.begin(w as u32, h as u32);
                let drawn = screen.draw(&mut ui, fw, fh);
                if drawn.is_some() {
                    action = drawn;
                }
            }
        }

        match action {
            Some(ScreenAction::Connect(opts)) => {
                println!(
                    "pregame: CONNECT intent endpoint={} player={} (demo simulates the link)",
                    opts.endpoint, opts.player_id
                );
                link_deadline = Some(now + 1400.0);
            }
            Some(ScreenAction::CancelConnect) => {
                println!("pregame: link attempt cancelled");
                link_deadline = None;
            }
            Some(ScreenAction::SelectCharacter(index)) => {
                println!("pregame: SELECT character #{index} (no authority to route to)");
                if let Phase::Character(screen) = &mut phase {
                    let name = screen
                        .roster
                        .get(index)
                        .map(|entry| entry.name.clone())
                        .unwrap_or_default();
                    screen.set_status(format!(
                        "HANDOFF WOULD ENTER WORLD AS {}",
                        name.to_uppercase()
                    ));
                }
            }
            Some(ScreenAction::CreateCharacter(name)) => {
                println!("pregame: CREATE character '{name}' (no authority to route to)");
                if let Phase::Character(screen) = &mut phase {
                    let upper = name.to_uppercase();
                    screen.roster.push(RosterEntry {
                        name,
                        lineage: screen.draft.lineage().name.to_string(),
                        vocation: screen.draft.vocation().to_string(),
                        location: screen.draft.lineage().home.to_string(),
                        played: "NEW".into(),
                        ..Default::default()
                    });
                    screen.draft = Default::default();
                    screen.set_stage(CharacterStage::Roster);
                    screen.set_status(format!("{upper} FILED TO THE LOCAL DEMO ROSTER"));
                }
            }
            Some(ScreenAction::Back) => match &phase {
                Phase::Entry(_) => {
                    println!("pregame: BACK from entry — leaving the flow");
                    quit = true;
                }
                Phase::Character(_) | Phase::Loading(_) => {
                    println!("pregame: BACK to entry");
                    phase = Phase::Entry(EntryScreen::new());
                    link_deadline = None;
                }
            },
            Some(ScreenAction::Quit) => {
                println!("pregame: QUIT");
                quit = true;
            }
            None => {}
        }

        // Simulated link completes → hand over to the character surfaces.
        if let Some(deadline) = link_deadline {
            if now >= deadline {
                link_deadline = None;
                println!("pregame: simulated link established — showing demo roster");
                phase = Phase::Character(Box::new(CharacterScreen::with_entries(demo_roster())));
            }
        }

        gpu.begin_pass(
            PassTarget::Screen,
            RectPx { x: 0, y: 0, w, h },
            ClearSpec {
                color: Some([0.012, 0.027, 0.039, 1.0]),
                depth: Some(1.0),
            },
        );
        gpu.end_pass();
        renderer.render_ui(&mut gpu, &ui.buf, ui.quads, w as u32, h as u32);

        if let Some(path) = screenshot {
            if frame + 1 == total {
                let rgba = plat::read_pixels_rgba(w, h);
                write_bmp(path, &rgba, w as u32, h as u32).unwrap_or_else(|error| {
                    eprintln!("screenshot failed: {error}");
                    std::process::exit(1);
                });
                println!("screenshot written: {path} ({w}x{h})");
            }
        }
        plat::end_frame();
        frame += 1;
    }
    plat::deinit();
}

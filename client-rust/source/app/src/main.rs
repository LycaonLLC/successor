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
//!   successor --endpoint ws://127.0.0.1:28093 --player-id dev-1 --actor-id dev-1
//!       (Playable slice — wired in the PlayableSlice phase.)

use successor_client::demo;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.iter().any(|arg| arg == "--model-corpus") {
        run_model_corpus();
        return;
    }
    #[cfg(not(target_arch = "wasm32"))]
    configure_automation(&args);
    successor_client::initialize_render_settings();

    let mode = arg_value(&args, "--demo");
    let frames: u64 = arg_value(&args, "--frames")
        .and_then(|s| s.parse().ok())
        .unwrap_or(600);
    let stats_json = arg_value(&args, "--stats-json");
    let assert_zero = args.iter().any(|a| a == "--assert-zero-allocs");
    let gl = args.iter().any(|a| a == "--gl");
    let endpoint = arg_value(&args, "--endpoint");
    if let Some(q) = arg_value(&args, "--quality") {
        successor_client::set_render_quality(successor_client::parse_quality(&q));
    }

    #[cfg(not(target_arch = "wasm32"))]
    if mode.is_none() {
        if let Some(endpoint) = endpoint {
            let player_id = arg_value(&args, "--player-id").unwrap_or_else(|| "dev-1".to_string());
            let actor_id = arg_value(&args, "--actor-id").unwrap_or_else(|| player_id.clone());
            let max_frames = arg_value(&args, "--frames").and_then(|s| s.parse::<u64>().ok());
            let screenshot = arg_value(&args, "--screenshot");
            let auto_walk = args.iter().any(|a| a == "--auto-walk");
            std::process::exit(connected::run(
                &endpoint,
                &player_id,
                &actor_id,
                max_frames,
                screenshot.as_deref(),
                auto_walk,
            ));
        }
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
        run_pawns(frames, screenshot.as_deref());
        return;
    }

    if mode.as_deref() == Some("ui") {
        let screenshot = arg_value(&args, "--screenshot");
        run_ui(frames, screenshot.as_deref());
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

    eprintln!("successor: no mode selected. Try `--demo parity-basic [--gl] [--frames N] [--stats-json PATH] [--assert-zero-allocs]`.");
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
    let mut ui = successor_engine_render::ui::UiBuilder::new(icons.meta);
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
fn run_ui(frames: u64, screenshot: Option<&str>) {
    use successor_client::hud;
    use successor_engine_core::input::Key;
    use successor_engine_render::gpu::Gpu;
    use successor_engine_render::ui::{TextField, UiBuilder};
    use successor_engine_render::window::{WindowManager, WindowStyle};
    if !successor_platform::init("Successor UI", demo::SCREEN_W as i32, demo::SCREEN_H as i32) {
        eprintln!("platform init failed (no display?)");
        std::process::exit(1);
    }
    let mut gpu = successor_platform::create_gpu();
    let _ = &mut gpu as &mut dyn Gpu;
    let mut scene = demo::build_scene(&mut gpu);
    let icons = hud::Icons::load();
    scene
        .renderer
        .set_ui_atlas(&mut gpu, icons.meta.width, icons.meta.height, &icons.rgba);
    let mut ui = UiBuilder::new(icons.meta);
    let mut search = TextField::new(48);
    let mut hud_state = hud::HudState::default();
    let mut win_model = successor_client::windows::WindowModel::sample();
    // Register the demo windows with cascaded default bounds + toolbar icons.
    let mut wm = WindowManager::new();
    for (i, (id, title, icon)) in hud::DEMO_WINDOWS.iter().enumerate() {
        let ox = 360.0 + (i % 6) as f32 * 40.0;
        let oy = 140.0 + (i % 6) as f32 * 40.0;
        wm.register(
            id,
            title,
            icons.cell(icon),
            [ox, oy, 380.0, 300.0],
            220.0,
            150.0,
        );
    }
    // A screenshot run is pointer-less, so seed some open state so the chrome +
    // content + focused text edit are captured; a live run drives them for real.
    if screenshot.is_some() {
        search.focused = true;
        for c in "rifle ammo".chars() {
            search.insert(c);
        }
        wm.open("loot");
        wm.open("converse");
        wm.open("clone");
        wm.open("craft");
        hud_state.target = Some(("RAIDER SCOUT".into(), 0.62));
        hud_state.shield = 72.0;
    }
    let total = frames.max(1);
    let mut frame = 0u64;
    let mut prev_backspace = false;
    while !successor_platform::should_quit() && frame < total {
        successor_platform::begin_frame();
        scene.animate(frame);
        // Route pointer + text input into the UI.
        let (mx, my) = successor_platform::mouse_position();
        ui.set_input(mx, my, successor_platform::mouse_button_down(0));
        while let Some(c) = successor_platform::poll_text_input() {
            if search.focused {
                search.insert(c);
            }
        }
        let bk = successor_platform::is_key_down(Key::Backspace);
        if bk && !prev_backspace && search.focused {
            search.backspace();
        }
        prev_backspace = bk;
        let (w, h) = successor_platform::framebuffer_size();
        if w > 0 && h > 0 {
            scene
                .renderer
                .render(&mut gpu, &mut scene.world, w as u32, h as u32)
                .expect("render failed");
            ui.begin(w as u32, h as u32);
            // Windows resolve pointer first (topmost consumes drag/close/focus).
            wm.update(&ui, w as u32, h as u32);
            let captured = wm.pointer_captured();
            if let Some(action) = hud::build_hud(
                &mut ui,
                &icons,
                &hud_state,
                &mut search,
                captured,
                w as u32,
                h as u32,
            ) {
                // Toolbar buttons that name a window toggle it; others are actions.
                if hud::DEMO_WINDOWS.iter().any(|(id, _, _)| *id == action) {
                    wm.toggle(action);
                } else {
                    println!("ui action: {action}");
                }
            }
            // Draw open windows back-to-front over the HUD.
            let style = WindowStyle::default();
            for idx in wm.z_order() {
                let rect = wm.draw_chrome(&mut ui, idx, style);
                let id = wm.window_id(idx).to_string();
                let mut actions = Vec::new();
                successor_client::windows::content(
                    &mut ui,
                    &id,
                    rect,
                    &win_model,
                    &icons,
                    &mut actions,
                );
                for a in actions {
                    if let successor_client::windows::WindowAction::Select(item) = a {
                        win_model.inventory.selected = Some(item);
                    }
                }
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
fn run_pawns(frames: u64, screenshot: Option<&str>) {
    use successor_client::pawn::scene::PawnScene;
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
    let mut scene = match PawnScene::build(&mut gpu, &bytes) {
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
#[cfg(not(target_arch = "wasm32"))]
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

#[cfg(not(target_arch = "wasm32"))]
fn environment_flag(name: &str) -> bool {
    std::env::var(name).ok().is_some_and(|value| {
        matches!(
            value.to_ascii_lowercase().as_str(),
            "1" | "true" | "yes" | "on"
        )
    })
}

/// Live playable slice: connect to a local authority, project actors, send
/// movement, render with the GL backend. Native-only. Requires a display and a
/// running authority; verified by compile/link here and by the headless
/// projection/movement/chat unit tests. Live run command is in PARITY.md.
#[cfg(not(target_arch = "wasm32"))]
mod connected {
    use serde_json::json;
    use successor_client::game::combat_fx::CombatEvent;
    use successor_client::game::connected_scene::ConnectedScene;
    use successor_client::game::movement;
    use successor_client_proto::colyseus;
    use successor_client_proto::packets::GameServerPacket;
    use successor_client_proto::session::{
        Session, SessionEvent, SessionOut, SessionState, WsInput,
    };
    use successor_engine_core::input::Key;
    use successor_engine_render::gpu::Gpu;
    use successor_platform as plat;

    pub fn run(
        endpoint: &str,
        player_id: &str,
        actor_id: &str,
        max_frames: Option<u64>,
        screenshot: Option<&str>,
        auto_walk: bool,
    ) -> i32 {
        // 1) Colyseus matchmake over HTTP (dev identity; server gates on
        //    GAME_ALLOW_DEV_IDENTITY=1).
        let http_endpoint = endpoint
            .replacen("wss://", "https://", 1)
            .replacen("ws://", "http://", 1);
        let opts = json!({ "playerId": player_id, "actorId": actor_id });
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
        let mut scene = match ConnectedScene::build(&mut gpu, player_id) {
            Ok(s) => s,
            Err(e) => {
                eprintln!("connected scene build failed: {e}");
                plat::deinit();
                return 1;
            }
        };

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
        let mut last_intent = (0i32, 0i32, false);
        let mut cmd_id = 0u64;
        let mut view_sent = false;
        let mut frame: u64 = 0;

        while !plat::should_quit() && max_frames.is_none_or(|m| frame < m) {
            plat::begin_frame();

            // Drain socket → session; feed packets into the scene + combat FX.
            loop {
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
                            scene.on_snapshot(&hello.snapshot)
                        }
                        SessionOut::Emit(SessionEvent::Packet(pkt)) => {
                            apply_packet(pkt, &mut scene)
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
            scene.handle_tuning_toggle(plat::is_key_down(Key::Backquote));

            // Movement (WASD or --auto-walk); resend a live intent periodically.
            if sess.state() == SessionState::Ready {
                let intent = if scene.tuning_open() {
                    (0, 0, false)
                } else if auto_walk {
                    (0, -1, false)
                } else {
                    movement::intent_from_keys(plat::is_key_down)
                };
                let moving = intent != (0, 0, false);
                if intent != last_intent || (moving && frame.is_multiple_of(6)) {
                    last_intent = intent;
                    cmd_id += 1;
                    let env = movement::move_envelope(
                        0,
                        0,
                        cmd_id,
                        scene.store.tick,
                        intent.0,
                        intent.1,
                        intent.2,
                    );
                    if let Ok(SessionOut::SendFrame(f)) = sess.send_command(&env) {
                        plat::ws_send(&mut ws, &f);
                    }
                }
            }
            let _ = plat::is_key_down(Key::Escape);

            let (w, h) = plat::framebuffer_size();
            if w > 0 && h > 0 {
                scene.frame(&mut gpu, w as u32, h as u32, 1.0 / 60.0);
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

        let p = scene.player_pos();
        println!(
            "connected summary: actors={} player_pos=({:.2},{:.2},{:.2}) session_state={:?}",
            scene.actor_count(),
            p.x,
            p.y,
            p.z,
            sess.state()
        );
        if let Ok(SessionOut::SendFrame(f)) = sess.exit_world() {
            plat::ws_send(&mut ws, &f);
        }
        plat::deinit();
        0
    }

    /// Route a decoded packet into the scene's authority store + combat FX.
    fn apply_packet(pkt: GameServerPacket, scene: &mut ConnectedScene) {
        match pkt {
            GameServerPacket::Snapshot {
                snapshot, events, ..
            } => {
                scene.on_snapshot(&snapshot);
                fire_events(scene, &events);
            }
            GameServerPacket::Delta { delta, events, .. } => {
                scene.on_delta(&delta);
                fire_events(scene, &events);
            }
            GameServerPacket::Receipts { events, .. } => fire_events(scene, &events),
            GameServerPacket::Acks {
                player_actor,
                player_position,
                events,
                ..
            } => {
                if let Some(pa) = player_actor {
                    scene.on_player_pos(pa.x, pa.y);
                } else if let Some(pos) = player_position {
                    scene.on_player_pos(pos.0, pos.1);
                }
                if let Some(evs) = events {
                    fire_events(scene, &evs);
                }
            }
            GameServerPacket::Error { code, message } => eprintln!("game.error {code}: {message}"),
            _ => {}
        }
    }

    fn fire_events(scene: &mut ConnectedScene, events: &[serde_json::Value]) {
        for jv in events {
            if let Some(ce) = CombatEvent::from_json(jv) {
                scene.ingest_combat(&ce);
            }
        }
    }
}

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

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
    let mode = arg_value(&args, "--demo");
    let frames: u64 = arg_value(&args, "--frames").and_then(|s| s.parse().ok()).unwrap_or(600);
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
            std::process::exit(connected::run(&endpoint, &player_id, &actor_id, max_frames, screenshot.as_deref(), auto_walk));
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

    if mode.as_deref() == Some("terrain") {
        let biome = arg_value(&args, "--biome");
        let screenshot = arg_value(&args, "--screenshot");
        run_terrain(biome.as_deref(), frames, screenshot.as_deref());
        return;
    }

    if mode.as_deref() == Some("props") {
        let screenshot = arg_value(&args, "--screenshot");
        run_props(frames, screenshot.as_deref());
        return;
    }

    if mode.as_deref() == Some("gi") {
        let screenshot = arg_value(&args, "--screenshot");
        run_gi(frames, screenshot.as_deref());
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
        let minute = arg_value(&args, "--minute").and_then(|s| s.parse::<f32>().ok()).unwrap_or(720.0);
        run_env(minute, frames, screenshot.as_deref());
        return;
    }

    if mode.is_some() || stats_json.is_some() || assert_zero {
        if gl {
            let screenshot = arg_value(&args, "--screenshot");
            run_windowed(frames, screenshot.as_deref());
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
        frames, stats.frame_p50_ms, stats.frame_p99_ms, stats.peak_rss_bytes, stats.frame_allocs_steady
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
fn run_windowed(frames: u64, screenshot: Option<&str>) {
    use successor_engine_render::gpu::Gpu;
    if !successor_platform::init("Successor (Rust client)", demo::SCREEN_W as i32, demo::SCREEN_H as i32) {
        eprintln!("platform init failed (no display?). Falling back to headless.");
        run_headless(frames, None, false);
        return;
    }
    let mut gpu = successor_platform::create_gpu();
    let _ = &mut gpu as &mut dyn Gpu; // ensure trait is in scope
    let mut scene = demo::build_scene(&mut gpu);
    let total = frames.max(1);
    let mut frame = 0u64;
    while !successor_platform::should_quit() && frame < total {
        successor_platform::begin_frame();
        scene.animate(frame);
        let (w, h) = successor_platform::framebuffer_size();
        if w > 0 && h > 0 {
            scene.renderer.render(&mut gpu, &mut scene.world, w as u32, h as u32);
        }
        // Capture the final rendered frame from the back buffer before swap.
        if screenshot.is_some() && frame + 1 == total {
            if w > 0 && h > 0 {
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
        }
        successor_platform::end_frame();
        frame += 1;
    }
    successor_platform::deinit();
}

#[cfg(not(target_arch = "wasm32"))]
fn run_ui(frames: u64, screenshot: Option<&str>) {
    use successor_client::hud;
    use successor_engine_render::gpu::Gpu;
    use successor_engine_render::ui::{TextField, UiBuilder};
    use successor_engine_render::window::{WindowManager, WindowStyle};
    use successor_engine_core::input::Key;
    if !successor_platform::init("Successor UI", demo::SCREEN_W as i32, demo::SCREEN_H as i32) {
        eprintln!("platform init failed (no display?)");
        std::process::exit(1);
    }
    let mut gpu = successor_platform::create_gpu();
    let _ = &mut gpu as &mut dyn Gpu;
    let mut scene = demo::build_scene(&mut gpu);
    let icons = hud::Icons::load();
    scene.renderer.set_ui_atlas(&mut gpu, icons.meta.width, icons.meta.height, &icons.rgba);
    let mut ui = UiBuilder::new(icons.meta);
    let mut search = TextField::new(48);
    let mut hud_state = hud::HudState::default();
    let mut win_model = successor_client::windows::WindowModel::sample();
    // Register the demo windows with cascaded default bounds + toolbar icons.
    let mut wm = WindowManager::new();
    for (i, (id, title, icon)) in hud::DEMO_WINDOWS.iter().enumerate() {
        let ox = 360.0 + (i % 6) as f32 * 40.0;
        let oy = 140.0 + (i % 6) as f32 * 40.0;
        wm.register(id, title, icons.cell(icon), [ox, oy, 380.0, 300.0], 220.0, 150.0);
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
            scene.renderer.render(&mut gpu, &mut scene.world, w as u32, h as u32);
            ui.begin(w as u32, h as u32);
            // Windows resolve pointer first (topmost consumes drag/close/focus).
            wm.update(&ui, w as u32, h as u32);
            let captured = wm.pointer_captured();
            if let Some(action) = hud::build_hud(&mut ui, &icons, &hud_state, &mut search, captured, w as u32, h as u32) {
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
                successor_client::windows::content(&mut ui, &id, rect, &win_model, &icons, &mut actions);
                for a in actions {
                    if let successor_client::windows::WindowAction::Select(item) = a {
                        win_model.inventory.selected = Some(item);
                    }
                }
            }
            scene.renderer.render_ui(&mut gpu, &ui.buf, ui.quads, w as u32, h as u32);
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
    use successor_engine_render::renderer::Renderer;
    if !successor_platform::init("Successor FX", demo::SCREEN_W as i32, demo::SCREEN_H as i32) {
        eprintln!("platform init failed (no display?)");
        std::process::exit(1);
    }
    let mut gpu = successor_platform::create_gpu();
    let mut renderer = Renderer::new(&mut gpu, successor_client::quality_limits());
    let sprite = glow_sprite(64);
    renderer.set_particle_atlas(&mut gpu, 64, 64, &sprite);
    let mut pool = ParticlePool::new(0x51ce_57ed);
    let eye = Vec3 { x: 5.0, y: 4.0, z: 5.0 };
    let center = Vec3 { x: 0.0, y: 1.0, z: 0.0 };
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
                ClearSpec { color: Some([0.06, 0.07, 0.10, 1.0]), depth: Some(1.0) },
            );
            gpu.end_pass();
            let aspect = w as f32 / h as f32;
            let vp = Mat4::perspective(0.9, aspect, 0.1, 100.0).mul(Mat4::look_at(eye, center, Vec3::Y)).to_cols_array();
            // Sustained fire: a spark + blood burst every few frames.
            if frame % 6 == 0 {
                pool.emit_spark_burst([0.0, 1.1, 0.0], [0.0, 1.0, 0.0], [1.0, -0.2, 0.3], 1.6);
                pool.emit_blood_burst([0.0, 1.1, 0.0], [1.0, 0.0, 0.3], 1.2);
            }
            pool.update(1.0 / 60.0);
            // Additive layer.
            buf.clear();
            let qa = pool.additive.fill_billboards([right.x, right.y, right.z], [up.x, up.y, up.z], &mut buf);
            renderer.render_particles(&mut gpu, &buf, qa, &vp, true, w as u32, h as u32);
            // Normal-blend layers (blood + residue).
            buf.clear();
            let mut qn = pool.normal.fill_billboards([right.x, right.y, right.z], [up.x, up.y, up.z], &mut buf);
            qn += pool.residue.fill_billboards([right.x, right.y, right.z], [up.x, up.y, up.z], &mut buf);
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
    use successor_engine_core::ecs::WorldOps;
    use successor_engine_core::math::{vec3, Quat, Vec3};
    use successor_engine_render::components::{
        CamTarget, Camera, DirectionalLight, MeshRenderer, Projection, RectNorm, Transform,
    };
    use successor_engine_render::environment;
    use successor_engine_render::gpu::ClearSpec;
    use successor_engine_render::primitives;
    use successor_engine_render::renderer::Renderer;
    use successor_client::GameWorld;
    if !successor_platform::init("Successor env", demo::SCREEN_W as i32, demo::SCREEN_H as i32) {
        eprintln!("platform init failed (no display?)");
        std::process::exit(1);
    }
    let mut gpu = successor_platform::create_gpu();
    let mut renderer = Renderer::new(&mut gpu, successor_client::quality_limits());
    let mut world = GameWorld::new();

    let env = environment::sample(minute);
    // Grade + fog now run inside the deferred tonemap pass.
    renderer.set_grade(env.bone_tint, env.desaturate, env.scene_darken, env.black_lift, env.bloom);
    renderer.set_fog(env.fog, 180.0, 340.0);

    let (gv, gi) = primitives::plane(200.0);
    let ground = renderer.upload_mesh(&mut gpu, &gv, &gi);
    let ground_mat = renderer.add_material([0.42, 0.36, 0.24, 1.0]);
    let g = world.spawn();
    world.set_component(g, Transform { pos: Vec3::ZERO, rot: Quat::IDENTITY, scale: Vec3::ONE });
    world.set_component(g, MeshRenderer { mesh: ground, material: ground_mat, viewport_mask: 0b1, ..Default::default() });

    // Flora / world objects scattered deterministically over the ground, each
    // rendered as a small shrub cube (verifies placement + density).
    let (cv, ci) = primitives::cube();
    let shrub = renderer.upload_mesh(&mut gpu, &cv, &ci);
    let shrub_mat = renderer.add_material([0.28, 0.42, 0.20, 1.0]);
    let instances = flora::scatter(0x0d3d, [-20.0, -20.0], [20.0, 20.0], 0.5, |_p| false);
    for f in instances.iter().take(400) {
        let e = world.spawn();
        world.set_component(e, Transform {
            pos: vec3(f.pos[0], f.scale * 0.5, f.pos[2]),
            rot: Quat::from_axis_angle(Vec3::Y, f.yaw),
            scale: vec3(f.scale * 0.5, f.scale, f.scale * 0.5),
        });
        world.set_component(e, MeshRenderer { mesh: shrub, material: shrub_mat, viewport_mask: 0b1, ..Default::default() });
    }

    let sun = world.spawn();
    world.set_component(sun, DirectionalLight { dir: vec3(env.sun_dir[0], env.sun_dir[1], env.sun_dir[2]), color: env.sun_color, cast_shadows: true });

    let cam = world.spawn();
    world.set_component(cam, Camera {
        viewport_id: 0, order: 0,
        projection: Projection::Perspective { fovy: 0.9, near: 0.1, far: 400.0 },
        target: CamTarget::Screen(RectNorm::FULL),
        clear: ClearSpec { color: Some([env.fog[0], env.fog[1], env.fog[2], 1.0]), depth: Some(1.0) },
        eye: vec3(24.0, 20.0, 28.0), look_at: Vec3::ZERO, up: Vec3::Y,
    });

    let total = frames.max(1);
    let mut frame = 0u64;
    while !successor_platform::should_quit() && frame < total {
        successor_platform::begin_frame();
        let (w, h) = successor_platform::framebuffer_size();
        if w > 0 && h > 0 {
            renderer.render(&mut gpu, &mut world, w as u32, h as u32);
        }
        if screenshot.is_some() && frame + 1 == total && w > 0 && h > 0 {
            let rgba = successor_platform::read_pixels_rgba(w, h);
            match write_bmp(screenshot.unwrap(), &rgba, w as u32, h as u32) {
                Ok(()) => println!("screenshot written: {} ({}x{}) minute={}", screenshot.unwrap(), w, h, minute),
                Err(e) => eprintln!("screenshot failed: {e}"),
            }
        }
        successor_platform::end_frame();
        frame += 1;
    }
    successor_platform::deinit();
}

#[cfg(not(target_arch = "wasm32"))]
fn run_gi(frames: u64, screenshot: Option<&str>) {
    use successor_engine_core::ecs::WorldOps;
    use successor_engine_core::math::{vec3, Mat4, Quat, Vec3};
    use successor_engine_render::components::{
        CamTarget, Camera, DirectionalLight, MeshRenderer, Projection, RectNorm, Transform,
    };
    use successor_engine_render::gi::GiOccluder;
    use successor_engine_render::gpu::ClearSpec;
    use successor_engine_render::primitives;
    use successor_engine_render::renderer::Renderer;
    use successor_client::GameWorld;

    if !successor_platform::init("Successor GI", demo::SCREEN_W as i32, demo::SCREEN_H as i32) {
        eprintln!("platform init failed (no display?)");
        std::process::exit(1);
    }
    let mut gpu = successor_platform::create_gpu();
    let mut renderer = Renderer::new(&mut gpu, successor_client::quality_limits());
    renderer.set_ambient(0.12);
    renderer.set_fog([0.02, 0.02, 0.03], 400.0, 800.0); // effectively off at this scale
    let mut world = GameWorld::new();

    let (cv, ci) = primitives::cube();
    let unit = renderer.upload_mesh(&mut gpu, &cv, &ci);

    // White ground: a thin scaled cube (outward-wound top face, unlike plane()).
    let ground_mat = renderer.add_material_pbr([1.0, 1.0, 1.0, 1.0], 0.0, 0.9);
    let g = world.spawn();
    world.set_component(g, Transform { pos: vec3(0.0, -0.1, 6.0), rot: Quat::IDENTITY, scale: vec3(120.0, 0.2, 120.0) });
    world.set_component(g, MeshRenderer { mesh: unit, material: ground_mat, viewport_mask: 0b1, ..Default::default() });

    // Tall red wall at z=0 spanning x, front face (+z) toward the camera/floor.
    let wall_mat = renderer.add_material_pbr([0.85, 0.05, 0.05, 1.0], 0.0, 0.9);
    let wall_c = vec3(0.0, 3.0, 0.0);
    let wall_h = vec3(8.0, 3.0, 0.4);
    let wall = world.spawn();
    world.set_component(wall, Transform { pos: wall_c, rot: Quat::IDENTITY, scale: vec3(wall_h.x * 2.0, wall_h.y * 2.0, wall_h.z * 2.0) });
    world.set_component(wall, MeshRenderer { mesh: unit, material: wall_mat, viewport_mask: 0b1, ..Default::default() });

    // White cube on the visible floor (casts a soft shadow toward the camera).
    let cube_mat = renderer.add_material_pbr([0.95, 0.95, 0.95, 1.0], 0.0, 0.9);
    let cube_c = vec3(3.0, 1.0, 8.0);
    let cube = world.spawn();
    world.set_component(cube, Transform { pos: cube_c, rot: Quat::IDENTITY, scale: vec3(2.0, 2.0, 2.0) });
    world.set_component(cube, MeshRenderer { mesh: unit, material: cube_mat, viewport_mask: 0b1, ..Default::default() });

    // Static GI occluder proxies.
    renderer.gi_set_ground_albedo([1.0, 1.0, 1.0]);
    renderer.gi_set_occluders(&[
        GiOccluder { center: [wall_c.x, wall_c.y, wall_c.z], half_extents: [wall_h.x, wall_h.y, wall_h.z], yaw: 0.0, albedo: [0.85, 0.05, 0.05] },
        GiOccluder { center: [cube_c.x, cube_c.y, cube_c.z], half_extents: [1.0, 1.0, 1.0], yaw: 0.0, albedo: [0.95, 0.95, 0.95] },
    ]);

    // Sun raking from +z and above onto the wall's front face.
    let sun = world.spawn();
    let sd = Vec3 { x: 0.0, y: -1.0, z: -1.0 }.normalize();
    world.set_component(sun, DirectionalLight { dir: sd, color: [1.0, 1.0, 1.0], cast_shadows: true });

    let eye = vec3(0.0, 12.0, 24.0);
    let look = vec3(0.0, 1.0, 6.0);
    let cam = world.spawn();
    world.set_component(cam, Camera {
        viewport_id: 0, order: 0,
        projection: Projection::Perspective { fovy: 0.7, near: 0.1, far: 400.0 },
        target: CamTarget::Screen(RectNorm::FULL),
        clear: ClearSpec { color: Some([0.02, 0.02, 0.03, 1.0]), depth: Some(1.0) },
        eye, look_at: look, up: Vec3::Y,
    });

    let total = frames.max(1);
    let mut frame = 0u64;
    while !successor_platform::should_quit() && frame < total {
        successor_platform::begin_frame();
        let (w, h) = successor_platform::framebuffer_size();
        if w > 0 && h > 0 {
            renderer.render(&mut gpu, &mut world, w as u32, h as u32);
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
                (((ndx * 0.5 + 0.5) * wf) as i32, ((ndy * 0.5 + 0.5) * hf) as i32)
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
                if n > 0.0 { (r / n, gg / n, b / n) } else { (0.0, 0.0, 0.0) }
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
                let l = 0.299 * rgba[i] as f32 + 0.587 * rgba[i + 1] as f32 + 0.114 * rgba[i + 2] as f32;
                let t = (l - shadow_lum) / (lit_lum - shadow_lum).max(1.0);
                if t > 0.2 && t < 0.8 {
                    penumbra += 1;
                }
            }
            println!(
                "shadow-check quality={:?} lit_lum={:.1} shadow_lum={:.1} penumbra_px={}",
                successor_client::render_quality(), lit_lum, shadow_lum, penumbra
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
    if !successor_platform::init("Successor GLB viewer", demo::SCREEN_W as i32, demo::SCREEN_H as i32) {
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
            scene.renderer.render(&mut gpu, &mut scene.world, w as u32, h as u32);
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
fn run_terrain(biome: Option<&str>, frames: u64, screenshot: Option<&str>) {
    use successor_client::world::chunks::TerrainScene;
    use successor_client::world::terrain::Biome;
    use successor_engine_render::gpu::Gpu;
    let biome = match biome {
        Some("forest") => Biome::Forest,
        _ => Biome::Desert,
    };
    if !successor_platform::init("Successor terrain", demo::SCREEN_W as i32, demo::SCREEN_H as i32) {
        eprintln!("platform init failed (no display?)");
        std::process::exit(1);
    }
    let mut gpu = successor_platform::create_gpu();
    let _ = &mut gpu as &mut dyn Gpu;
    let mut scene = TerrainScene::build(&mut gpu, biome);
    let total = frames.max(1);
    let mut frame = 0u64;
    while !successor_platform::should_quit() && frame < total {
        successor_platform::begin_frame();
        scene.animate(frame);
        let (w, h) = successor_platform::framebuffer_size();
        if w > 0 && h > 0 {
            scene.renderer.render(&mut gpu, &mut scene.world, w as u32, h as u32);
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
fn run_props(frames: u64, screenshot: Option<&str>) {
    use successor_client::world::props::WorldScene;
    use successor_engine_render::gpu::Gpu;
    let assets_dir = "../client-3d/public/assets";
    let mapping = match std::fs::read_to_string("../client-3d/src/render/props-mapping.json") {
        Ok(s) => s,
        Err(e) => { eprintln!("read props-mapping: {e}"); std::process::exit(1); }
    };
    let slice = match std::fs::read_to_string("../client/public/successor-slice/open-desert-slice.json") {
        Ok(s) => s,
        Err(e) => { eprintln!("read slice: {e}"); std::process::exit(1); }
    };
    if !successor_platform::init("Successor world", demo::SCREEN_W as i32, demo::SCREEN_H as i32) {
        eprintln!("platform init failed (no display?)");
        std::process::exit(1);
    }
    let mut gpu = successor_platform::create_gpu();
    let _ = &mut gpu as &mut dyn Gpu;
    let mut scene = match WorldScene::build(&mut gpu, assets_dir, &mapping, &slice) {
        Ok(s) => s,
        Err(()) => { eprintln!("world scene build failed"); successor_platform::deinit(); std::process::exit(1); }
    };
    let total = frames.max(1);
    let mut frame = 0u64;
    while !successor_platform::should_quit() && frame < total {
        successor_platform::begin_frame();
        scene.animate(frame);
        let (w, h) = successor_platform::framebuffer_size();
        if w > 0 && h > 0 {
            scene.renderer.render(&mut gpu, &mut scene.world, w as u32, h as u32);
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
        Err(e) => { eprintln!("read {path}: {e}"); std::process::exit(1); }
    };
    if !successor_platform::init("Successor pawns", demo::SCREEN_W as i32, demo::SCREEN_H as i32) {
        eprintln!("platform init failed (no display?)");
        std::process::exit(1);
    }
    let mut gpu = successor_platform::create_gpu();
    let _ = &mut gpu as &mut dyn Gpu;
    let mut scene = match PawnScene::build(&mut gpu, &bytes) {
        Ok(s) => s,
        Err(()) => { eprintln!("pawn scene build failed"); successor_platform::deinit(); std::process::exit(1); }
    };
    let total = frames.max(1);
    let mut frame = 0u64;
    while !successor_platform::should_quit() && frame < total {
        successor_platform::begin_frame();
        scene.animate(frame);
        let (w, h) = successor_platform::framebuffer_size();
        if w > 0 && h > 0 {
            scene.renderer.render(&mut gpu, &mut scene.world, w as u32, h as u32);
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
    use successor_client_proto::session::{Session, SessionEvent, SessionOut, SessionState, WsInput};
    use successor_engine_core::input::Key;
    use successor_engine_render::gpu::Gpu;
    use successor_platform as plat;

    pub fn run(endpoint: &str, player_id: &str, actor_id: &str, max_frames: Option<u64>, screenshot: Option<&str>, auto_walk: bool) -> i32 {
        // 1) Colyseus matchmake over HTTP (dev identity; server gates on
        //    GAME_ALLOW_DEV_IDENTITY=1).
        let http_endpoint = endpoint.replacen("wss://", "https://", 1).replacen("ws://", "http://", 1);
        let opts = json!({ "playerId": player_id, "actorId": actor_id });
        let (url, body) = match colyseus::build_matchmake_request(&http_endpoint, &opts) {
            Ok(v) => v,
            Err(e) => { eprintln!("matchmake request build failed: {e}"); return 1; }
        };
        let resp = match plat::http_post_json(&url, &body) {
            Ok(r) => r,
            Err(e) => { eprintln!("matchmake POST failed: {e}"); return 1; }
        };
        let seat = match colyseus::parse_seat_reservation(&resp) {
            Ok(s) => s,
            Err(e) => { eprintln!("seat reservation parse failed: {e}"); return 1; }
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
            Err(e) => { eprintln!("connected scene build failed: {e}"); plat::deinit(); return 1; }
        };

        // 3) Connect + drive.
        let mut ws = match plat::ws_connect(&ws_url) {
            Ok(w) => w,
            Err(e) => { eprintln!("ws connect failed: {e}"); plat::deinit(); return 1; }
        };
        let mut sess = Session::new();
        sess.start_connecting();
        let mut buf: Vec<u8> = Vec::with_capacity(64 * 1024);
        let mut last_intent = (0i32, 0i32, false);
        let mut cmd_id = 0u64;
        let mut view_sent = false;
        let mut frame: u64 = 0;

        while !plat::should_quit() && max_frames.map_or(true, |m| frame < m) {
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
                        SessionOut::Emit(SessionEvent::Hello(hello)) => scene.on_snapshot(&hello.snapshot),
                        SessionOut::Emit(SessionEvent::Packet(pkt)) => apply_packet(pkt, &mut scene),
                        SessionOut::Emit(SessionEvent::Error(m)) => eprintln!("session error: {m}"),
                        SessionOut::Emit(SessionEvent::Closed) => eprintln!("session closed"),
                        SessionOut::Emit(SessionEvent::ReconnectAttempt { attempt, max_attempts }) => {
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

            // Movement (WASD or --auto-walk); resend a live intent periodically.
            if sess.state() == SessionState::Ready {
                let intent = if auto_walk { (0, -1, false) } else { movement::intent_from_keys(|k| plat::is_key_down(k)) };
                let moving = intent != (0, 0, false);
                if intent != last_intent || (moving && frame % 6 == 0) {
                    last_intent = intent;
                    cmd_id += 1;
                    let env = movement::move_envelope(0, 0, cmd_id, scene.store.tick, intent.0, intent.1, intent.2);
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
            if let (Some(path), true) = (screenshot, max_frames.map_or(false, |m| frame + 1 == m)) {
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
            scene.actor_count(), p.x, p.y, p.z, sess.state()
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
            GameServerPacket::Snapshot { snapshot, events, .. } => {
                scene.on_snapshot(&snapshot);
                fire_events(scene, &events);
            }
            GameServerPacket::Delta { delta, events, .. } => {
                scene.on_delta(&delta);
                fire_events(scene, &events);
            }
            GameServerPacket::Receipts { events, .. } => fire_events(scene, &events),
            GameServerPacket::Acks { player_actor, player_position, events, .. } => {
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

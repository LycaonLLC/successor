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
    use successor_client::game::{chat::ChatState, movement, projection::WorldActors};
    use successor_client::GameWorld;
    use successor_client_proto::packets::GameServerPacket;
    use successor_client_proto::session::{Session, SessionEvent, SessionOut, SessionState, WsInput};
    use successor_client_proto::colyseus;
    use successor_engine_core::ecs::{Entity, WorldOps};
    use successor_engine_core::input::Key;
    use successor_engine_core::math::{vec3, Quat, Vec2, Vec3};
    use successor_engine_render::components::{
        CamTarget, Camera, CompositeQuad, DirectionalLight, MeshRenderer, Projection, RectNorm,
        TextOverlay, Transform,
    };
    use successor_engine_render::gpu::{ClearSpec, Filter, Gpu, RenderTargetDesc};
    use successor_engine_render::primitives;
    use successor_engine_render::renderer::{Renderer, RendererLimits};
    use successor_platform as plat;

    const CHAT_SLOTS: usize = 9;

    pub fn run(endpoint: &str, player_id: &str, actor_id: &str, max_frames: Option<u64>, screenshot: Option<&str>, auto_walk: bool) -> i32 {
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

        // 2) Window + GL.
        if !plat::init("Successor (Rust client)", 1280, 720) {
            eprintln!("platform init failed (no display?)");
            return 1;
        }
        let mut gpu = plat::create_gpu();
        let mut renderer = Renderer::new(&mut gpu, RendererLimits::default());
        let mut world = GameWorld::new();

        // Ground, capsule, materials, light, cameras, minimap composite.
        let (gv, gi) = primitives::plane(2048.0);
        let ground = renderer.upload_mesh(&mut gpu, &gv, &gi);
        let ground_mat = renderer.add_material([0.30, 0.26, 0.18, 1.0]);
        let g = world.spawn();
        world.set_component(g, Transform { pos: Vec3::ZERO, rot: Quat::IDENTITY, scale: Vec3::ONE });
        world.set_component(g, MeshRenderer { mesh: ground, material: ground_mat, viewport_mask: 0b011 });

        let (kv, ki) = primitives::capsule(0.4, 1.8, 12, 6);
        let capsule = renderer.upload_mesh(&mut gpu, &kv, &ki);
        let mat_player = renderer.add_material([0.95, 0.85, 0.25, 1.0]);
        let mat_other = renderer.add_material([0.55, 0.65, 0.75, 1.0]);
        let mut actors = WorldActors::new(capsule, mat_player, mat_other);

        let sun = world.spawn();
        world.set_component(sun, DirectionalLight { dir: vec3(-0.5, -1.0, -0.35), color: [1.0, 0.97, 0.9], cast_shadows: true });

        let rt = gpu.create_render_target(&RenderTargetDesc { width: 256, height: 256, color: true, depth: true, filter: Filter::Linear });
        let follow = world.spawn();
        world.set_component(follow, Camera {
            viewport_id: 0, order: 0,
            projection: Projection::Perspective { fovy: 1.05, near: 0.1, far: 800.0 },
            target: CamTarget::Screen(RectNorm::FULL),
            clear: ClearSpec { color: Some([0.05, 0.06, 0.08, 1.0]), depth: Some(1.0) },
            eye: vec3(0.0, 8.0, 12.0), look_at: Vec3::ZERO, up: Vec3::Y,
        });
        let minimap = world.spawn();
        world.set_component(minimap, Camera {
            viewport_id: 1, order: -1,
            projection: Projection::Ortho { half_height: 30.0, near: 0.1, far: 400.0 },
            target: CamTarget::Texture(rt),
            clear: ClearSpec { color: Some([0.02, 0.03, 0.04, 1.0]), depth: Some(1.0) },
            eye: vec3(0.0, 120.0, 0.0), look_at: Vec3::ZERO, up: vec3(0.0, 0.0, -1.0),
        });
        let cq = world.spawn();
        world.set_component(cq, CompositeQuad { source: rt, rect: RectNorm { x: 0.75, y: 0.74, w: 0.24, h: 0.24 }, order: 0 });

        // Chat overlay slot pool (updated in place — no per-frame spawn).
        let mut chat_slots: Vec<Entity> = Vec::with_capacity(CHAT_SLOTS);
        for _ in 0..CHAT_SLOTS {
            let e = world.spawn();
            world.set_component(e, TextOverlay::new("", Vec2 { x: 0.02, y: 0.80 }, [0, 0, 0, 0]));
            chat_slots.push(e);
        }

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
        let mut chat = ChatState::new(8);
        let mut buf: Vec<u8> = Vec::with_capacity(64 * 1024);
        let mut last_intent = (0i32, 0i32, false);
        let mut cmd_id = 0u64;
        let mut tick = 0u64;
        let mut last_enter = false;
        let mut view_sent = false;

        let mut frame: u64 = 0;
        while !plat::should_quit() && max_frames.map_or(true, |m| frame < m) {
            plat::begin_frame();

            // Drain socket.
            loop {
                buf.clear();
                match plat::ws_poll(&mut ws, &mut buf) {
                    plat::WsEvent::Open => drive(sess.on_ws_event(WsInput::Open), &mut ws, &mut world, &mut actors, &mut tick),
                    plat::WsEvent::Frame(n) => {
                        let outs = sess.on_ws_event(WsInput::Frame(&buf[..n]));
                        drive(outs, &mut ws, &mut world, &mut actors, &mut tick);
                    }
                    plat::WsEvent::Closed => {
                        drive(sess.on_ws_event(WsInput::Closed), &mut ws, &mut world, &mut actors, &mut tick);
                        break;
                    }
                    plat::WsEvent::Error => {
                        drive(sess.on_ws_event(WsInput::Error("ws error")), &mut ws, &mut world, &mut actors, &mut tick);
                        break;
                    }
                    plat::WsEvent::None => break,
                }
            }

            // Once joined, declare AOI view interest so the shard streams
            // deltas/acks (without this the stream stops after the hello).
            if !view_sent && sess.state() == SessionState::Ready {
                let view = json!({
                    "viewport_width_cells": 96,
                    "viewport_height_cells": 96,
                    "margin_cells": 32
                });
                if let Ok(SessionOut::SendFrame(f)) = sess.send_view(&view) {
                    plat::ws_send(&mut ws, &f);
                }
                view_sent = true;
            }

            // Chat input (text queue + Enter edge).
            while let Some(c) = plat::poll_text_input() {
                if c != '\r' && c != '\n' {
                    chat.on_char(c);
                }
            }
            let enter = plat::is_key_down(Key::Enter);
            if enter && !last_enter {
                let _submitted = chat.on_enter(); // LOCAL chat-room send is a PARITY follow-up.
            }
            last_enter = enter;
            if plat::is_key_down(Key::Escape) {
                chat.escape();
            }

            // Movement (only when chat closed). `--auto-walk` forces a constant
            // north intent. `SetMoveIntent` is a per-tick input, so resend it
            // periodically while the intent is nonzero (not only on change).
            if !chat.open && sess.state() == SessionState::Ready {
                let intent = if auto_walk {
                    (0, -1, false)
                } else {
                    movement::intent_from_keys(|k| plat::is_key_down(k))
                };
                let moving = intent != (0, 0, false);
                if intent != last_intent || (moving && frame % 6 == 0) {
                    last_intent = intent;
                    cmd_id += 1;
                    let env = movement::move_envelope(0, 0, cmd_id, tick, intent.0, intent.1, intent.2);
                    if let Ok(SessionOut::SendFrame(f)) = sess.send_command(&env) {
                        plat::ws_send(&mut ws, &f);
                    }
                }
            }

            // Follow + minimap cameras track the player.
            let p = actors.player_pos();
            if let Some(cam) = world.get_component::<Camera>(follow) {
                cam.look_at = p;
                cam.eye = vec3(p.x, p.y + 8.0, p.z + 12.0);
            }
            if let Some(cam) = world.get_component::<Camera>(minimap) {
                cam.eye = vec3(p.x, 120.0, p.z);
                cam.look_at = p;
            }

            // Refresh chat overlay slots in place.
            let lines = chat.lines();
            for (i, &slot) in chat_slots.iter().enumerate() {
                let text = lines.get(i).map(String::as_str).unwrap_or("");
                let rgba = if text.is_empty() { [0, 0, 0, 0] } else { [200, 210, 220, 255] };
                if let Some(ov) = world.get_component::<TextOverlay>(slot) {
                    *ov = TextOverlay::new(text, Vec2 { x: 0.02, y: 0.80 + i as f32 * 0.03 }, rgba);
                }
            }

            let (w, h) = plat::framebuffer_size();
            if w > 0 && h > 0 {
                renderer.render(&mut gpu, &mut world, w as u32, h as u32);
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
            tick += 1;
            frame += 1;
        }

        let p = actors.player_pos();
        println!(
            "connected summary: actors_projected={} player_actor={:?} player_pos=({:.2},{:.2},{:.2}) session_state={:?}",
            actors.actor_count(), actors.player_actor_id(), p.x, p.y, p.z, sess.state()
        );

        // Clean exit: ask the authority to remove us, then tear down.
        if let Ok(SessionOut::SendFrame(f)) = sess.exit_world() {
            plat::ws_send(&mut ws, &f);
        }
        plat::deinit();
        0
    }

    fn drive(
        outs: Vec<SessionOut>,
        ws: &mut plat::WsHandle,
        world: &mut GameWorld,
        actors: &mut WorldActors,
        tick: &mut u64,
    ) {
        for out in outs {
            match out {
                SessionOut::SendFrame(f) => {
                    plat::ws_send(ws, &f);
                }
                SessionOut::Emit(ev) => match ev {
                    SessionEvent::Hello(hello) => {
                        *tick = hello.snapshot.tick;
                        actors.apply_hello(world, &hello);
                    }
                    SessionEvent::Packet(pkt) => apply_packet(pkt, world, actors, tick),
                    SessionEvent::Error(msg) => eprintln!("session error: {msg}"),
                    SessionEvent::Closed => eprintln!("session closed"),
                    SessionEvent::ReconnectAttempt { attempt, max_attempts } => {
                        eprintln!("reconnect {attempt}/{max_attempts}");
                    }
                },
            }
        }
    }

    fn apply_packet(pkt: GameServerPacket, world: &mut GameWorld, actors: &mut WorldActors, tick: &mut u64) {
        match pkt {
            GameServerPacket::Snapshot { snapshot, .. } => {
                *tick = snapshot.tick;
                actors.apply_snapshot(world, &snapshot);
            }
            GameServerPacket::Delta { delta, .. } => {
                *tick = delta.tick;
                actors.apply_delta(world, &delta);
            }
            GameServerPacket::Acks { player_actor, player_position, .. } => {
                if let Some(pa) = player_actor {
                    actors.apply_player_position(world, pa.x, pa.y);
                } else if let Some(pos) = player_position {
                    actors.apply_player_position(world, pos.0, pos.1);
                }
            }
            GameServerPacket::Error { code, message } => eprintln!("game.error {code}: {message}"),
            _ => {}
        }
    }
}

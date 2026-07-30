//! The connected-mode scene: composes the real world backdrop (terrain + GLB
//! props), GLB pawns per streamed actor, environment lighting, HUD, and combat
//! FX into one `GameWorld`/`Renderer`, driven by the authoritative
//! [`AuthorityStore`]. This replaces the placeholder ground-plane + capsule
//! projection so the live client renders like `client-3d`.
//!
//! Coordinate contract (config): sim `(x, y)` → world `(x, 0, y)`; a pawn centre
//! sits at `actor.x + 0.5`. Terrain/props are authored in world cells.

use std::collections::HashMap;

use successor_client_proto::packets::{GameShardDelta, GameShardSnapshot};
use successor_engine_core::ecs::{Entity, WorldOps};
use successor_engine_core::math::{vec3, Mat4, Quat, Vec3};
use successor_engine_render::components::{
    CamTarget, Camera, CompositeQuad, DirectionalLight, MeshRenderer, Projection, RectNorm, SkinRef, Transform,
};
use successor_engine_render::gpu::{ClearSpec, Filter, Gpu, RenderTargetDesc};
use successor_engine_render::renderer::Renderer;
use successor_engine_render::{environment, fx::glow_sprite};

use crate::game::authority::AuthorityStore;
use crate::game::combat_fx::CombatFx;
use crate::hud::{self, HudState, Icons};
use crate::pawn::animator::{PawnAnimator, WeaponLane};
use crate::pawn::appearance::{faction_tinted, skin_tint};
use crate::pawn::pack::PawnTemplate;
use crate::world::chunks::TerrainStreamer;
use crate::world::props::PropsLoader;
use crate::world::terrain::Biome;
use crate::GameWorld;

/// A rendered pawn for one live actor: one entity per body part + its animator.
struct ActorPawn {
    entities: Vec<Entity>,
    animator: PawnAnimator,
    lane: WeaponLane,
    /// Authoritative sim target position (from the store).
    target: (f32, f32),
    /// Smoothed rendered position (lerped toward `target` each frame) — this is
    /// what drives both the transform and the gait speed, so neither snaps.
    render_pos: (f32, f32),
    speed: f32,
    yaw: f32,
    present: bool,
}

pub struct ConnectedScene {
    pub world: GameWorld,
    pub renderer: Renderer,
    pub store: AuthorityStore,
    template: PawnTemplate,
    part_meshes: Vec<successor_engine_render::components::MeshId>,
    pawns: HashMap<String, ActorPawn>,
    follow: Entity,
    minimap: Entity,
    combat_fx: CombatFx,
    fx_buf: Vec<f32>,
    icons: Icons,
    ui: successor_engine_render::ui::UiBuilder,
    hud_state: HudState,
    search: successor_engine_render::ui::TextField,
    wm: successor_engine_render::window::WindowManager,
    win_model: crate::windows::WindowModel,
    weather: successor_engine_render::weather::Weather,
    player_id: String,
    center: Vec3,
    /// Transient muzzle-flash point lights: (entity, remaining seconds).
    muzzle_lights: Vec<(Entity, f32)>,
}

impl ConnectedScene {
    /// Build the world backdrop + pawn template + HUD from the checked-in slice
    /// fixture and pawn pack (same assets `client-3d` loads).
    pub fn build<G: Gpu>(gpu: &mut G, player_id: &str) -> Result<Self, String> {
        let assets_dir = "../client-3d/public/assets";
        let mapping = std::fs::read_to_string("../client-3d/src/render/props-mapping.json")
            .map_err(|e| format!("read props-mapping: {e}"))?;
        let slice_str = std::fs::read_to_string("../client/public/successor-slice/open-desert-slice.json")
            .map_err(|e| format!("read slice: {e}"))?;
        let pawn_bytes = std::fs::read("../client-3d/public/assets/pawn-pack/pawn_male.glb")
            .map_err(|e| format!("read pawn pack: {e}"))?;

        let mut renderer = Renderer::new(gpu, crate::quality_limits());
        // Environment: noon desert grade → ambient/fog/clear + sun. The grade now
        // runs inside the deferred tonemap pass.
        let env = environment::sample(720.0);
        renderer.set_ambient(0.5);
        renderer.set_fog(env.fog, 160.0, 340.0);
        renderer.set_grade(env.bone_tint, env.desaturate, env.scene_darken, env.black_lift, env.bloom);
        let mut world = GameWorld::new();

        let center = vec3(512.0, 0.0, 513.0);

        // Terrain under the slice.
        let mut streamer = TerrainStreamer::new(0x0d3d_071e, Biome::Desert, 64.0, 128, 3, 0b1);
        streamer.ensure_around(&mut world, &mut renderer, gpu, center.x as f64, center.z as f64);

        // Props from the slice fixture.
        let slice = successor_engine_core::json::Json::parse(&slice_str).map_err(|_| "slice parse".to_string())?;
        let mut loader = PropsLoader::new(assets_dir, &mapping).map_err(|_| "props loader".to_string())?;
        let placed = loader.load(&mut world, &mut renderer, gpu, &slice, 0b1);
        eprintln!("connected: terrain streamed, {placed} props placed");

        // Pawn template (uploaded once; per-actor materials are tinted).
        let template = PawnTemplate::from_bytes(&pawn_bytes).map_err(|_| "pawn parse".to_string())?;
        let gpu_parts = template.upload(gpu, &mut renderer);
        let part_meshes: Vec<_> = gpu_parts.parts.iter().map(|(m, _)| *m).collect();

        // Sun from the environment sample.
        let sun = world.spawn();
        world.set_component(
            sun,
            DirectionalLight {
                dir: vec3(env.sun_dir[0], env.sun_dir[1], env.sun_dir[2]),
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
                projection: Projection::Perspective { fovy: 0.9, near: 0.2, far: 900.0 },
                target: CamTarget::Screen(RectNorm::FULL),
                clear: ClearSpec { color: Some([env.fog[0], env.fog[1], env.fog[2], 1.0]), depth: Some(1.0) },
                eye: center.add(vec3(0.0, 9.0, 13.0)),
                look_at: center,
                up: Vec3::Y,
            },
        );
        let rt = gpu.create_render_target(&RenderTargetDesc { width: 256, height: 256, color: true, depth: true, filter: Filter::Linear });
        let minimap = world.spawn();
        world.set_component(
            minimap,
            Camera {
                viewport_id: 1,
                order: -1,
                projection: Projection::Ortho { half_height: 40.0, near: 0.1, far: 400.0 },
                target: CamTarget::Texture(rt),
                clear: ClearSpec { color: Some([0.06, 0.07, 0.05, 1.0]), depth: Some(1.0) },
                eye: center.add(vec3(0.0, 160.0, 0.0)),
                look_at: center,
                up: vec3(0.0, 0.0, -1.0),
            },
        );
        let cq = world.spawn();
        world.set_component(cq, CompositeQuad { source: rt, rect: RectNorm { x: 0.76, y: 0.74, w: 0.23, h: 0.23 }, order: 0 });

        // Combat FX + HUD.
        let glow = glow_sprite(64);
        renderer.set_particle_atlas(gpu, 64, 64, &glow);
        let icons = Icons::load();
        renderer.set_ui_atlas(gpu, icons.meta.width, icons.meta.height, &icons.rgba);
        let ui = successor_engine_render::ui::UiBuilder::new(icons.meta);
        // Interactive window manager: register the game windows with cascaded
        // bounds + toolbar icons (opened from the action bar).
        let mut wm = successor_engine_render::window::WindowManager::new();
        for (i, (id, title, icon)) in crate::hud::DEMO_WINDOWS.iter().enumerate() {
            let ox = 360.0 + (i % 6) as f32 * 40.0;
            let oy = 120.0 + (i % 6) as f32 * 40.0;
            wm.register(id, title, icons.cell(icon), [ox, oy, 380.0, 300.0], 220.0, 150.0);
        }
        let mut weather = successor_engine_render::weather::Weather::new(0x0d3d);
        weather.set(successor_engine_render::weather::WeatherKind::DustStorm, 0.35);

        Ok(Self {
            world,
            renderer,
            store: AuthorityStore::new(),
            template,
            part_meshes,
            pawns: HashMap::new(),
            follow,
            minimap,
            combat_fx: CombatFx::new(0x51ce_57ed),
            fx_buf: Vec::with_capacity(64 * 1024),
            icons,
            ui,
            hud_state: HudState::default(),
            search: successor_engine_render::ui::TextField::new(48),
            wm,
            win_model: crate::windows::WindowModel::sample(),
            weather,
            player_id: player_id.to_string(),
            center,
            muzzle_lights: Vec::with_capacity(32),
        })
    }

    pub fn on_snapshot(&mut self, snap: &GameShardSnapshot) {
        self.store.apply_snapshot(snap);
    }
    pub fn on_delta(&mut self, delta: &GameShardDelta) {
        self.store.apply_delta(delta);
    }
    pub fn on_player_pos(&mut self, x: f32, y: f32) {
        self.store.apply_player_position(x, y);
    }
    pub fn combat_fx_mut(&mut self) -> &mut CombatFx {
        &mut self.combat_fx
    }

    /// Ingest a combat event: fire its VFX and, if new, spawn a short-lived
    /// muzzle-flash point light at the shot origin (decays over 0.12 s).
    pub fn ingest_combat(&mut self, ev: &crate::game::combat_fx::CombatEvent) {
        if self.combat_fx.trigger(ev) {
            let e = self.world.spawn();
            self.world.set_component(e, Transform {
                pos: vec3(ev.origin[0], ev.origin[1], ev.origin[2]),
                rot: successor_engine_core::math::Quat::IDENTITY,
                scale: Vec3::ONE,
            });
            self.world.set_component(e, successor_engine_render::components::PointLight {
                color: ev.color,
                intensity: 6.0,
                radius: 5.0,
            });
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
                if let Some(pl) = self.world.get_component::<successor_engine_render::components::PointLight>(e) {
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
        if let Some(p) = self.pawns.get(&self.player_id) {
            return vec3(p.render_pos.0 + 0.5, 0.0, p.render_pos.1 + 0.5);
        }
        self.store
            .actors
            .get(&self.player_id)
            .map(|a| vec3(a.x + 0.5, 0.0, a.y + 0.5))
            .unwrap_or(self.center)
    }

    /// The player's current smoothed gait speed (diagnostic: should be stable
    /// while walking, not oscillating 0↔spike).
    pub fn player_speed(&self) -> f32 {
        self.pawns.get(&self.player_id).map(|p| p.speed).unwrap_or(0.0)
    }
    pub fn actor_count(&self) -> usize {
        self.store.actors.len()
    }

    /// Spawn a pawn (one entity per body part) for a new actor.
    fn spawn_pawn(&mut self, id: &str, x: f32, y: f32, skin_hex: Option<&str>, faction: Option<[f32; 3]>) {
        let base = skin_tint(skin_hex);
        let color = faction_tinted(base, faction);
        let material = self.renderer.add_material(color);
        let mut entities = Vec::with_capacity(self.part_meshes.len());
        for &mesh in &self.part_meshes {
            let e = self.world.spawn();
            self.world.set_component(e, Transform { pos: self.center, rot: Quat::IDENTITY, scale: Vec3::ONE });
            self.world.set_component(e, MeshRenderer { mesh, material, viewport_mask: 0b11, skin: SkinRef::NONE });
            entities.push(e);
        }
        self.pawns.insert(
            id.to_string(),
            ActorPawn {
                entities,
                animator: PawnAnimator::new(&self.template),
                lane: WeaponLane::Unarmed,
                target: (x, y),
                render_pos: (x, y),
                speed: 0.0,
                yaw: 0.0,
                present: true,
            },
        );
    }

    /// Per-frame: reconcile pawns with the authoritative actor set, animate, and
    /// render the full scene + FX + HUD.
    pub fn frame<G: Gpu>(&mut self, gpu: &mut G, w: u32, h: u32, dt: f32) {
        // 1) Reconcile pawn set with live actors.
        for p in self.pawns.values_mut() {
            p.present = false;
        }
        // Collect (id, x, y, skin, faction) to avoid borrow conflicts.
        let live: Vec<(String, f32, f32, Option<String>, Option<String>)> = self
            .store
            .render_actors()
            .map(|(id, a)| {
                let skin = a.appearance.as_ref().and_then(|ap| ap.skin_tone.clone());
                (id.clone(), a.x, a.y, skin, a.faction_id.clone())
            })
            .collect();
        for (id, x, y, skin, faction) in &live {
            if !self.pawns.contains_key(id) {
                let fac = faction.as_deref().map(faction_rgb);
                self.spawn_pawn(id, *x, *y, skin.as_deref(), fac);
            }
            if let Some(p) = self.pawns.get_mut(id) {
                p.present = true;
                p.target = (*x, *y);
            }
        }

        // 2) Animate + place pawns (skinned).
        self.renderer.begin_skin_frame();
        // Take ids to iterate (avoid borrow of self.pawns while borrowing renderer).
        let ids: Vec<String> = self.pawns.keys().cloned().collect();
        for id in ids {
            let (present, speed, yaw, wx, wz, entities) = {
                let p = self.pawns.get_mut(&id).unwrap();
                if !p.present {
                    (false, 0.0, 0.0, 0.0, 0.0, p.entities.clone())
                } else {
                    // Chase the authoritative target smoothly; derive gait speed
                    // from the *rendered* motion so it never spikes to 0 between
                    // sparse position packets.
                    let (tx, ty) = p.target;
                    let (rx, ry) = p.render_pos;
                    let k = (dt * 12.0).min(1.0);
                    let nx = rx + (tx - rx) * k;
                    let ny = ry + (ty - ry) * k;
                    let moved = ((nx - rx) * (nx - rx) + (ny - ry) * (ny - ry)).sqrt();
                    let inst = if dt > 0.0 { moved / dt } else { 0.0 };
                    p.speed = p.speed * 0.72 + inst * 0.28; // EMA → stable gait input
                    if moved > 1e-4 {
                        p.yaw = (tx - rx).atan2(ty - ry);
                    }
                    p.render_pos = (nx, ny);
                    (true, p.speed, p.yaw, nx + 0.5, ny + 0.5, p.entities.clone())
                }
            };
            if !present {
                // Hide departed pawns below the world.
                for e in &entities {
                    if let Some(tr) = self.world.get_component::<Transform>(*e) {
                        tr.pos = vec3(0.0, -10_000.0, 0.0);
                    }
                }
                continue;
            }
            let palette = {
                let p = self.pawns.get_mut(&id).unwrap();
                p.animator.update(&mut self.template, p.lane, speed, false, true, dt)
            };
            let count = palette.len() as u32;
            let offset = self.renderer.push_skin_palette(palette);
            let rot = Quat::from_axis_angle(Vec3::Y, yaw);
            for e in &entities {
                if let Some(tr) = self.world.get_component::<Transform>(*e) {
                    tr.pos = vec3(wx, 0.0, wz);
                    tr.rot = rot;
                }
                if let Some(mr) = self.world.get_component::<MeshRenderer>(*e) {
                    mr.skin = SkinRef { offset, count };
                }
            }
        }

        // 3) Cameras track the player.
        let p = self.player_pos();
        self.center = p;
        if let Some(cam) = self.world.get_component::<Camera>(self.follow) {
            cam.look_at = p;
            cam.eye = p.add(vec3(0.0, 9.0, 13.0));
        }
        if let Some(cam) = self.world.get_component::<Camera>(self.minimap) {
            cam.eye = p.add(vec3(0.0, 160.0, 0.0));
            cam.look_at = p;
        }

        // 4) HUD state from the player's vitals.
        if let Some(a) = self.store.actors.get(&self.player_id) {
            self.hud_state.hp = a.vitals.health;
            self.hud_state.hp_max = a.max_vitals.health.max(1.0);
            self.hud_state.ap = a.vitals.action;
            self.hud_state.ap_max = a.max_vitals.action.max(1.0);
            self.hud_state.name = a.label.clone().to_uppercase();
            self.hud_state.coord = (a.x as i32, a.y as i32);
        }

        // 5) Render scene → screen (+ minimap composite).
        self.renderer.render(gpu, &mut self.world, w, h);

        // 6) Weather (ambient dust) → the FX pool, then integrate + draw all
        //    billboards over the scene in the follow-camera frame.
        self.weather.emit_into(self.combat_fx.pool_mut(), [p.x, 0.0, p.z], 40.0);
        self.combat_fx.update(dt);
        self.decay_muzzle_lights(dt);
        let eye = p.add(vec3(0.0, 9.0, 13.0));
        let fwd = p.sub(eye).normalize();
        let right = fwd.cross(Vec3::Y).normalize();
        let up = right.cross(fwd);
        let vp = Mat4::perspective(0.9, w as f32 / h as f32, 0.2, 900.0).mul(Mat4::look_at(eye, p, Vec3::Y)).to_cols_array();
        let (r, u) = ([right.x, right.y, right.z], [up.x, up.y, up.z]);
        self.fx_buf.clear();
        let qa = self.combat_fx.pool().additive.fill_billboards(r, u, &mut self.fx_buf);
        self.renderer.render_particles(gpu, &self.fx_buf, qa, &vp, true, w, h);
        self.fx_buf.clear();
        let mut qn = self.combat_fx.pool().normal.fill_billboards(r, u, &mut self.fx_buf);
        qn += self.combat_fx.pool().residue.fill_billboards(r, u, &mut self.fx_buf);
        self.renderer.render_particles(gpu, &self.fx_buf, qn, &vp, false, w, h);

        // 7) HUD chrome + interactive windows (mouse-routed; action bar toggles
        //    windows, exactly as `--demo ui`).
        let (mx, my) = successor_platform::mouse_position();
        let down = successor_platform::mouse_button_down(0);
        self.ui.set_input(mx, my, down);
        self.ui.begin(w, h);
        self.wm.update(&self.ui, w, h);
        let captured = self.wm.pointer_captured();
        if let Some(action) = hud::build_hud(&mut self.ui, &self.icons, &self.hud_state, &mut self.search, captured, w, h) {
            if crate::hud::DEMO_WINDOWS.iter().any(|(id, _, _)| *id == action) {
                self.wm.toggle(action);
            }
        }
        let style = successor_engine_render::window::WindowStyle::default();
        for idx in self.wm.z_order() {
            let rect = self.wm.draw_chrome(&mut self.ui, idx, style);
            let id = self.wm.window_id(idx).to_string();
            let mut actions = Vec::new();
            crate::windows::content(&mut self.ui, &id, rect, &self.win_model, &self.icons, &mut actions);
            for a in actions {
                match a {
                    crate::windows::WindowAction::Select(item) => {
                        self.win_model.inventory.selected = Some(item);
                    }
                    crate::windows::WindowAction::EquipItem(item) => {
                        if let Some(it) = self.win_model.inventory.items.iter_mut().find(|i| i.id == item) {
                            it.equipped = !it.equipped;
                        }
                    }
                    _ => {}
                }
            }
        }
        self.renderer.render_ui(gpu, &self.ui.buf, self.ui.quads, w, h);
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

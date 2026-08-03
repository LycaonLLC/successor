//! `--demo pawns`: load a pawn body pack and render a row of animated pawns at
//! different gaits (idle/walk/run) and skin/faction tints, exercising the
//! template + animator + appearance integration end-to-end. Native visual QA.

use successor_engine_core::ecs::{Entity, WorldOps};
use successor_engine_core::math::{vec3, Mat4, Quat, Vec3};
use successor_engine_render::components::{
    CamTarget, Camera, DirectionalLight, MeshRenderer, Projection, RectNorm, SkinRef, Transform,
};
use successor_engine_render::gi::GiOccluder;
use successor_engine_render::gpu::{ClearSpec, Gpu};
use successor_engine_render::primitives;
use successor_engine_render::renderer::Renderer;

use super::animator::{weapon_hand_bone, PawnAnimator, WeaponLane};
use super::appearance::{faction_tinted, skin_tint};
use super::catalog::parse_weapon_hand_spec;
use super::pack::{PawnGpuParts, PawnTemplate};
use crate::GameWorld;

struct PawnActor {
    animator: PawnAnimator,
    entities: Vec<Entity>,
    speed: f32,
    lane: WeaponLane,
    against_facing: bool,
    alive: bool,
    pos_x: f32,
}

/// A weapon mesh socketed to a pawn's hand bone.
struct WeaponRig {
    entities: Vec<(Entity, Mat4)>,
    actor_index: usize,
    hand: usize,
    mount: Mat4,
    foregrip: Vec3,
}

pub struct PawnScene {
    pub world: GameWorld,
    pub renderer: Renderer,
    template: PawnTemplate,
    pawn_scale: f32,
    actors: Vec<PawnActor>,
    weapon: Option<WeaponRig>,
    camera: Entity,
    center: Vec3,
    view: PawnView,
}

#[derive(Clone, Copy)]
pub struct PawnView {
    pub distance: f32,
    pub height: f32,
    pub yaw_radians: f32,
    pub orbit_speed: f32,
}

impl PawnView {
    fn eye(self, center: Vec3, frame: u64) -> Vec3 {
        let angle = self.yaw_radians + frame as f32 * self.orbit_speed;
        center.add(vec3(
            angle.sin() * self.distance,
            self.height,
            angle.cos() * self.distance,
        ))
    }
}

impl PawnScene {
    #[allow(clippy::result_unit_err)]
    pub fn build<G: Gpu>(gpu: &mut G, bytes: &[u8], view: PawnView) -> Result<PawnScene, ()> {
        let template = PawnTemplate::from_bytes(bytes).map_err(|_| ())?;
        let pawn_scale = template
            .uniform_scale_for_height(crate::world::ADULT_PAWN_HEIGHT_METERS)
            .ok_or(())?;
        let mut renderer = crate::configured_renderer(gpu).expect("renderer initialization failed");
        renderer.set_ambient(0.45);
        renderer.set_fog([0.09, 0.10, 0.12], 40.0, 80.0);
        let mut world = GameWorld::new();
        let gpu_parts: PawnGpuParts = template.upload(gpu, &mut renderer);

        // A row of pawns, each with a gait + tint.
        #[allow(clippy::type_complexity)]
        let specs: [(f32, WeaponLane, bool, Option<[f32; 3]>, Option<&str>); 5] = [
            (0.0, WeaponLane::Unarmed, false, None, Some("#cc9978")),
            (1.0, WeaponLane::Unarmed, false, None, Some("#8d5a3c")),
            (
                3.0,
                WeaponLane::Rifle,
                false,
                Some([0.8, 0.2, 0.2]),
                Some("#e0b48a"),
            ),
            (1.0, WeaponLane::Unarmed, true, None, Some("#5b3a29")),
            (0.0, WeaponLane::Unarmed, false, None, None),
        ];
        let mut actors = Vec::new();
        for (i, (speed, lane, against, faction, skin)) in specs.iter().enumerate() {
            let base = skin_tint(*skin);
            let color = faction_tinted(base, *faction);
            let x = i as f32 * 1.6 - (specs.len() as f32 - 1.0) * 0.8;
            let mut entities = Vec::new();
            for ((mesh, authored_material), material_name) in
                gpu_parts.parts.iter().zip(&gpu_parts.material_names)
            {
                let material = if material_name.as_deref() == Some("RB_Face") {
                    *authored_material
                } else {
                    let mut desc = renderer
                        .material_desc(*authored_material)
                        .unwrap_or_default();
                    desc.base_color = color;
                    desc.blend = color[3] < 1.0;
                    renderer.add_material_desc(desc)
                };
                let e = world.spawn();
                world.set_component(
                    e,
                    Transform {
                        pos: vec3(x, 0.0, 0.0),
                        rot: Quat::IDENTITY,
                        scale: vec3(pawn_scale, pawn_scale, pawn_scale),
                    },
                );
                world.set_component(
                    e,
                    MeshRenderer {
                        mesh: *mesh,
                        material,
                        viewport_mask: 0b1,
                        skin: SkinRef::NONE,
                    },
                );
                entities.push(e);
            }
            actors.push(PawnActor {
                animator: PawnAnimator::new(&template),
                entities,
                speed: *speed,
                lane: *lane,
                against_facing: *against,
                alive: true,
                pos_x: x,
            });
        }

        let center = vec3(0.0, 1.0, 0.0);
        renderer.gi_set_focus([center.x, center.y, center.z]);
        renderer.gi_set_ground_albedo([0.38, 0.40, 0.44]);
        let (cube_vertices, cube_indices) = primitives::cube();
        let cube = renderer.upload_mesh(gpu, &cube_vertices, &cube_indices);
        let ground_material =
            renderer.add_material_desc(successor_engine_render::renderer::MaterialDesc {
                base_color: [0.38, 0.40, 0.44, 1.0],
                metallic: 0.0,
                roughness: 0.92,
                ..successor_engine_render::renderer::MaterialDesc::default()
            });
        let ground = world.spawn();
        world.set_component(
            ground,
            Transform {
                pos: vec3(0.0, -0.1, 0.0),
                rot: Quat::IDENTITY,
                scale: vec3(18.0, 0.2, 14.0),
            },
        );
        world.set_component(
            ground,
            MeshRenderer {
                mesh: cube,
                material: ground_material,
                viewport_mask: 0b1,
                ..Default::default()
            },
        );
        let wall_center = vec3(-4.5, 1.5, -1.5);
        let wall_half = vec3(0.35, 1.5, 2.5);
        let wall_material =
            renderer.add_material_desc(successor_engine_render::renderer::MaterialDesc {
                base_color: [0.16, 0.38, 0.78, 1.0],
                metallic: 0.0,
                roughness: 0.82,
                ..successor_engine_render::renderer::MaterialDesc::default()
            });
        let wall = world.spawn();
        world.set_component(
            wall,
            Transform {
                pos: wall_center,
                rot: Quat::IDENTITY,
                scale: vec3(wall_half.x * 2.0, wall_half.y * 2.0, wall_half.z * 2.0),
            },
        );
        world.set_component(
            wall,
            MeshRenderer {
                mesh: cube,
                material: wall_material,
                viewport_mask: 0b1,
                ..Default::default()
            },
        );
        renderer.gi_set_occluders(&[GiOccluder {
            center: [wall_center.x, wall_center.y, wall_center.z],
            half_extents: [wall_half.x, wall_half.y, wall_half.z],
            yaw: 0.0,
            albedo: [0.16, 0.38, 0.78],
        }]);

        let sun = world.spawn();
        world.set_component(
            sun,
            DirectionalLight {
                // Side-lit at a forty-five-degree elevation from the initial view.
                dir: vec3(-1.0, -1.0, 0.0).normalize(),
                color: [1.0, 0.98, 0.92],
                cast_shadows: true,
            },
        );

        let camera = world.spawn();
        world.set_component(
            camera,
            Camera {
                viewport_id: 0,
                order: 0,
                projection: Projection::Perspective {
                    fovy: 45.0_f32.to_radians(),
                    near: 0.05,
                    far: 200.0,
                },
                target: CamTarget::Screen(RectNorm::FULL),
                clear: ClearSpec {
                    color: Some([0.09, 0.10, 0.12, 1.0]),
                    depth: Some(1.0),
                },
                eye: view.eye(center, 0),
                look_at: center,
                up: Vec3::Y,
            },
        );

        // Socket a slugthrower to the rifle pawn's hand (best-effort).
        let weapon = load_weapon(gpu, &mut renderer, &mut world, &template, &actors);

        Ok(PawnScene {
            world,
            renderer,
            template,
            pawn_scale,
            actors,
            weapon,
            camera,
            center,
            view,
        })
    }

    pub fn animate(&mut self, frame: u64) {
        let dt = 1.0 / 60.0;
        let eye = self.view.eye(self.center, frame);
        if let Some(cam) = self.world.get_component::<Camera>(self.camera) {
            cam.eye = eye;
        }
        self.renderer.begin_skin_frame();
        for (idx, actor) in self.actors.iter_mut().enumerate() {
            actor.animator.update(
                &mut self.template,
                actor.lane,
                actor.speed,
                actor.against_facing,
                actor.alive,
                dt,
            );
            if actor.alive {
                if let Some(rig) = &self.weapon {
                    if rig.actor_index == idx {
                        actor.animator.apply_rifle_support_ik(
                            &mut self.template,
                            rig.mount,
                            rig.foregrip,
                        );
                    }
                }
            }
            let palette = actor.animator.palette();
            let count = palette.len() as u32;
            let offset = self.renderer.push_skin_palette(palette);
            for &e in &actor.entities {
                if let Some(mr) = self.world.get_component::<MeshRenderer>(e) {
                    mr.skin = SkinRef { offset, count };
                }
            }
            // Socket the weapon while this actor's bone globals are current.
            if let Some(rig) = &self.weapon {
                if rig.actor_index == idx {
                    let bone = self.template.skeleton.bone_global(rig.hand);
                    let world_mat = successor_engine_core::math::Mat4::from_trs(
                        vec3(actor.pos_x, 0.0, 0.0),
                        Quat::IDENTITY,
                        vec3(self.pawn_scale, self.pawn_scale, self.pawn_scale),
                    )
                    .mul(bone)
                    .mul(rig.mount);
                    for &(entity, local) in &rig.entities {
                        let (t, r, s) = world_mat.mul(local).to_trs();
                        if let Some(tr) = self.world.get_component::<Transform>(entity) {
                            tr.pos = t;
                            tr.rot = r;
                            tr.scale = s;
                        }
                    }
                }
            }
        }
    }
}

/// Load `slugthrower.glb` and spawn its parts for the first Rifle-lane pawn,
/// resolving the hand socket bone by name. Best-effort: returns `None` if the
/// asset is missing, no rifle pawn exists, or no hand bone is found.
fn load_weapon<G: Gpu>(
    gpu: &mut G,
    renderer: &mut Renderer,
    world: &mut GameWorld,
    template: &PawnTemplate,
    actors: &[PawnActor],
) -> Option<WeaponRig> {
    let actor_index = actors.iter().position(|a| a.lane == WeaponLane::Rifle)?;
    let hand = weapon_hand_bone(template)?;
    let bytes = std::fs::read("../client-3d/public/assets/pawn-pack/slugthrower.glb").ok()?;
    let mount_bytes =
        std::fs::read("../client-3d/public/assets/pawn-pack/slugthrower_attach.json").ok()?;
    let hand_spec = parse_weapon_hand_spec(&mount_bytes)?;
    let parts = super::pack::upload_static_parts(gpu, renderer, &bytes).ok()?;
    let mut entities = Vec::new();
    for (mesh, material, local) in parts {
        let e = world.spawn();
        let (pos, rot, scale) = local.to_trs();
        world.set_component(e, Transform { pos, rot, scale });
        world.set_component(
            e,
            MeshRenderer {
                mesh,
                material,
                viewport_mask: 0b1,
                skin: SkinRef::NONE,
            },
        );
        entities.push((e, local));
    }
    Some(WeaponRig {
        entities,
        actor_index,
        hand,
        mount: hand_spec.mount,
        foregrip: hand_spec.foregrip,
    })
}

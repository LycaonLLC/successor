//! Project streamed authority state (`game.hello` / `game.snapshot` /
//! `game.delta` / `game.acks`) into ECS entities: one capsule per actor on a
//! flat ground plane. Map-bundle world geometry and GLB pawns are later parity
//! waves; this is the barebones "see actors, watch them move" slice.
//!
//! Authority `(x, y)` are planar metre/cell coordinates; capsules use the same
//! world-unit contract as terrain, GLB props, and connected-mode pawns.

use std::collections::BTreeMap;

use successor_client_proto::packets::{GameHello, GameShardDelta, GameShardSnapshot};
use successor_engine_core::ecs::{Entity, WorldOps};
use successor_engine_core::math::{vec3, Quat, Vec3};
use successor_engine_render::components::{MaterialId, MeshId, MeshRenderer, Transform};

use crate::world::{ADULT_PAWN_HEIGHT_METERS, WORLD_UNITS_PER_CELL};
use crate::GameWorld;

const HERO_Y: f32 = ADULT_PAWN_HEIGHT_METERS * 0.5;
/// All actors are visible in the main (0) and minimap (1) viewports.
const ACTOR_MASK: u32 = 0b011;

pub struct WorldActors {
    capsule: MeshId,
    mat_player: MaterialId,
    mat_other: MaterialId,
    entities: BTreeMap<String, Entity>,
    player_actor_id: Option<String>,
    player_pos: Vec3,
}

impl WorldActors {
    pub fn new(capsule: MeshId, mat_player: MaterialId, mat_other: MaterialId) -> Self {
        Self {
            capsule,
            mat_player,
            mat_other,
            entities: BTreeMap::new(),
            player_actor_id: None,
            player_pos: vec3(0.0, HERO_Y, 0.0),
        }
    }

    pub fn player_actor_id(&self) -> Option<&str> {
        self.player_actor_id.as_deref()
    }

    /// Current player world position (follow-camera focus).
    pub fn player_pos(&self) -> Vec3 {
        self.player_pos
    }

    pub fn actor_count(&self) -> usize {
        self.entities.len()
    }

    pub fn apply_hello(&mut self, world: &mut GameWorld, hello: &GameHello) {
        self.player_actor_id = Some(hello.player_actor_id.clone());
        self.apply_snapshot(world, &hello.snapshot);
    }

    pub fn apply_snapshot(&mut self, world: &mut GameWorld, snap: &GameShardSnapshot) {
        if self.player_actor_id.is_none() && !snap.player_actor_id.is_empty() {
            self.player_actor_id = Some(snap.player_actor_id.clone());
        }
        for (id, actor) in &snap.actors {
            self.upsert(world, id, actor.x, actor.y, &actor.direction);
        }
    }

    pub fn apply_delta(&mut self, world: &mut GameWorld, delta: &GameShardDelta) {
        // Full actor snapshots included in the delta.
        for (id, actor) in &delta.actors {
            self.upsert(world, id, actor.x, actor.y, &actor.direction);
        }
        // Field-level patches.
        for (id, patch) in &delta.actor_patches {
            let (x, y) = (patch.x, patch.y);
            if let (Some(x), Some(y)) = (x, y) {
                let dir = patch.direction.clone().unwrap_or_default();
                self.upsert(world, id, x, y, &dir);
            }
        }
        // Removals.
        for id in &delta.actor_removals {
            if let Some(e) = self.entities.remove(id) {
                world.destroy(e);
            }
        }
        world.flush();
    }

    /// Apply a `game.acks` player-actor position correction.
    pub fn apply_player_position(&mut self, world: &mut GameWorld, x: f32, y: f32) {
        if let Some(id) = self.player_actor_id.clone() {
            self.upsert(world, &id, x, y, "");
        }
    }

    fn upsert(&mut self, world: &mut GameWorld, id: &str, x: f32, y: f32, direction: &str) {
        let pos = vec3(x * WORLD_UNITS_PER_CELL, HERO_Y, y * WORLD_UNITS_PER_CELL);
        let rot = yaw_for_direction(direction);
        let is_player = self.player_actor_id.as_deref() == Some(id);
        if is_player {
            self.player_pos = pos;
        }
        if let Some(&e) = self.entities.get(id) {
            if let Some(tr) = world.get_component::<Transform>(e) {
                tr.pos = pos;
                tr.rot = rot;
            }
            return;
        }
        let e = world.spawn();
        world.set_component(
            e,
            Transform {
                pos,
                rot,
                scale: Vec3::ONE,
            },
        );
        world.set_component(
            e,
            MeshRenderer {
                mesh: self.capsule,
                material: if is_player {
                    self.mat_player
                } else {
                    self.mat_other
                },
                viewport_mask: ACTOR_MASK,
                ..Default::default()
            },
        );
        self.entities.insert(id.to_string(), e);
    }
}

fn yaw_for_direction(direction: &str) -> Quat {
    let d = direction.to_ascii_lowercase();
    let yaw = if d.starts_with('n') {
        0.0
    } else if d.starts_with('e') {
        core::f32::consts::FRAC_PI_2
    } else if d.starts_with('s') {
        core::f32::consts::PI
    } else if d.starts_with('w') {
        -core::f32::consts::FRAC_PI_2
    } else {
        0.0
    };
    Quat::from_yaw(yaw)
}

#[cfg(test)]
mod tests {
    use super::*;
    use successor_client_proto::packets::{GameActorSnapshot, GameActorVitals};
    use successor_engine_render::gpu::NullGpu;
    use successor_engine_render::primitives;
    use successor_engine_render::renderer::{Renderer, RendererLimits};

    fn actor(id: &str, x: f32, y: f32) -> GameActorSnapshot {
        GameActorSnapshot {
            id: id.into(),
            label: "npc".into(),
            display_name: id.into(),
            area_id: "open-desert".into(),
            x,
            y,
            direction: "north".into(),
            vitals: GameActorVitals {
                health: 100.0,
                action: 100.0,
                spirit: 100.0,
            },
            life_state: "alive".into(),
            ..Default::default()
        }
    }

    #[test]
    fn hello_then_delta_spawns_moves_and_removes() {
        let mut gpu = NullGpu::default();
        let mut r = Renderer::new(&mut gpu, RendererLimits::default())
            .expect("renderer initialization failed");
        let (v, i) = primitives::capsule(0.4, 1.8, 8, 4);
        let capsule = r.upload_mesh(&mut gpu, &v, &i);
        let mp = r.add_material_desc(successor_engine_render::renderer::MaterialDesc {
            base_color: [0.9, 0.8, 0.2, 1.0],
            blend: ([0.9, 0.8, 0.2, 1.0])[3] < 1.0,
            ..successor_engine_render::renderer::MaterialDesc::default()
        });
        let mo = r.add_material_desc(successor_engine_render::renderer::MaterialDesc {
            base_color: [0.5, 0.6, 0.7, 1.0],
            blend: ([0.5, 0.6, 0.7, 1.0])[3] < 1.0,
            ..successor_engine_render::renderer::MaterialDesc::default()
        });
        let mut wa = WorldActors::new(capsule, mp, mo);
        let mut world = GameWorld::new();

        // Hello: player + one other actor.
        let mut snap = GameShardSnapshot {
            player_actor_id: "me".into(),
            ..Default::default()
        };
        snap.actors.insert("me".into(), actor("me", 10.0, 20.0));
        snap.actors.insert("bob".into(), actor("bob", 5.0, 5.0));
        let hello = GameHello {
            session_id: "s".into(),
            player_actor_id: "me".into(),
            snapshot: snap,
            server_time: "t".into(),
        };
        wa.apply_hello(&mut world, &hello);
        assert_eq!(wa.actor_count(), 2);
        assert_eq!(wa.player_actor_id(), Some("me"));
        assert_eq!(wa.player_pos(), vec3(10.0, HERO_Y, 20.0));

        // Delta: move player, remove bob.
        let mut delta = GameShardDelta::default();
        delta.actor_patches.insert(
            "me".into(),
            successor_client_proto::packets::GameActorPatch {
                id: "me".into(),
                x: Some(12.0),
                y: Some(22.0),
                direction: Some("east".into()),
                ..Default::default()
            },
        );
        delta.actor_removals.push("bob".into());
        wa.apply_delta(&mut world, &delta);
        assert_eq!(wa.actor_count(), 1, "bob removed");
        assert_eq!(
            wa.player_pos(),
            vec3(12.0, HERO_Y, 22.0),
            "player moved by authority"
        );
    }
}

//! Prefab (entity template) save/load, tailored to this repo's versioned-schema
//! JSON convention.
//!
//! A prefab is JSON shaped like the repo's other specs — a `"schema"`
//! discriminator plus payload:
//!
//! ```json
//! { "schema": "successor.prefab.v1",
//!   "components": { "transform": { ... }, "mesh": { ... } } }
//! ```
//!
//! Loading is strict and fails closed (like `parseActorArchetypes` in
//! `client/src/slice-core/actorArchetypes.ts`): an unknown component name or a
//! wrong schema is an error, not a silent skip.
//!
//! Prefab capability is opt-in per world via [`world_prefab!`], so a world may
//! contain transient/render-only components that are not serializable. Only the
//! components listed in `world_prefab!` participate in save/load.

use alloc::string::String;

use crate::ecs::Entity;
use crate::json::{Json, JsonWriter};

pub const PREFAB_SCHEMA: &str = "successor.prefab.v1";

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum PrefabError {
    /// Top-level shape wrong (not an object, missing `components`, …).
    Malformed,
    /// `schema` field absent or not equal to [`PREFAB_SCHEMA`].
    WrongSchema,
    /// A component name in the prefab is not registered on this world.
    UnknownComponent,
    /// A registered component's `from_json` rejected its payload.
    BadComponent,
}

/// A component that can round-trip through prefab JSON.
pub trait PrefabComponent: Sized {
    /// Stable field name under `"components"`.
    const NAME: &'static str;
    /// Parse this component from its JSON value.
    fn from_json(value: &Json) -> Result<Self, PrefabError>;
    /// Emit exactly one JSON value for this component (the value after the key).
    fn to_json(&self, w: &mut JsonWriter);
    /// Return false to omit this component when saving (e.g. runtime-derived).
    fn save_enabled(&self) -> bool {
        true
    }
}

/// Implemented by the `world_prefab!` macro. Bridges prefab JSON and the ECS.
pub trait WorldPrefab {
    fn apply_components(&mut self, entity: Entity, components: &Json) -> Result<(), PrefabError>;
    fn write_components(&mut self, entity: Entity, w: &mut JsonWriter);
    fn flush_world(&mut self);
}

/// Spawn an entity from an already-decoded prefab `Json`. Validates the schema,
/// then applies its components strictly. On failure the partially-built entity
/// is destroyed so the world is not left with a half-applied template.
pub fn create_entity_from_json<W>(world: &mut W, prefab: &Json) -> Result<Entity, PrefabError>
where
    W: WorldPrefab + crate::ecs::WorldOps,
{
    match prefab.get("schema").and_then(Json::as_str) {
        Some(s) if s == PREFAB_SCHEMA => {}
        _ => return Err(PrefabError::WrongSchema),
    }
    let components = prefab.get("components").ok_or(PrefabError::Malformed)?;
    if components.as_object().is_none() {
        return Err(PrefabError::Malformed);
    }
    let entity = world.spawn();
    if let Err(e) = world.apply_components(entity, components) {
        world.destroy(entity);
        world.flush_world();
        return Err(e);
    }
    Ok(entity)
}

/// Serialize an entity's prefab-capable components to a prefab JSON string.
pub fn save_entity_alloc<W>(world: &mut W, entity: Entity) -> String
where
    W: WorldPrefab,
{
    let mut w = JsonWriter::new();
    w.begin_obj();
    w.field_str("schema", PREFAB_SCHEMA);
    w.key("components");
    w.begin_obj();
    world.write_components(entity, &mut w);
    w.end_obj();
    w.end_obj();
    w.into_string()
}

/// Generate `impl WorldPrefab` for a world, listing the prefab-capable
/// components (a subset of those in the matching `world!`). Each listed type
/// must implement [`PrefabComponent`] and be a component of the world.
///
/// ```ignore
/// successor_engine_core::world_prefab! { GameWorld {
///     transform: Transform,
///     mesh: MeshRenderer,
/// } }
/// ```
#[macro_export]
macro_rules! world_prefab {
    ($W:ident { $($field:ident : $C:ty),+ $(,)? }) => {
        impl $crate::prefab::WorldPrefab for $W {
            fn flush_world(&mut self) {
                $W::flush(self);
            }

            fn apply_components(
                &mut self,
                entity: $crate::ecs::Entity,
                components: &$crate::json::Json,
            ) -> Result<(), $crate::prefab::PrefabError> {
                let fields = components
                    .as_object()
                    .ok_or($crate::prefab::PrefabError::Malformed)?;
                // Strict: reject any unknown component name before applying.
                for (key, _) in fields {
                    let known = false
                        $( || key.as_str() == <$C as $crate::prefab::PrefabComponent>::NAME )+;
                    if !known {
                        return Err($crate::prefab::PrefabError::UnknownComponent);
                    }
                }
                $(
                    if let Some(v) = components.get(<$C as $crate::prefab::PrefabComponent>::NAME) {
                        let component = <$C as $crate::prefab::PrefabComponent>::from_json(v)?;
                        $crate::ecs::WorldOps::set_component::<$C>(self, entity, component);
                    }
                )+
                Ok(())
            }

            fn write_components(
                &mut self,
                entity: $crate::ecs::Entity,
                w: &mut $crate::json::JsonWriter,
            ) {
                $(
                    if let Some(c) =
                        $crate::ecs::WorldOps::get_component::<$C>(self, entity)
                    {
                        if $crate::prefab::PrefabComponent::save_enabled(&*c) {
                            w.key(<$C as $crate::prefab::PrefabComponent>::NAME);
                            $crate::prefab::PrefabComponent::to_json(&*c, w);
                        }
                    }
                )+
            }
        }
    };
}

#[cfg(all(test, feature = "std"))]
mod tests {
    use super::*;
    use crate::ecs::WorldOps;
    use crate::{impl_component, world};

    #[derive(Clone, Copy, PartialEq, Debug)]
    struct Transform {
        x: f32,
        y: f32,
    }
    #[derive(Clone, Copy, PartialEq, Debug)]
    struct Health(i64);
    // A render-only component deliberately left out of the prefab set.
    #[derive(Clone, Copy, PartialEq, Debug)]
    struct Scratch(u32);

    impl_component!(Transform: dense);
    impl_component!(Health: sparse);
    impl_component!(Scratch: dense);

    impl PrefabComponent for Transform {
        const NAME: &'static str = "transform";
        fn from_json(v: &Json) -> Result<Self, PrefabError> {
            Ok(Transform {
                x: v.get("x").and_then(Json::as_f32).ok_or(PrefabError::BadComponent)?,
                y: v.get("y").and_then(Json::as_f32).ok_or(PrefabError::BadComponent)?,
            })
        }
        fn to_json(&self, w: &mut JsonWriter) {
            w.begin_obj();
            w.field_f32("x", self.x);
            w.field_f32("y", self.y);
            w.end_obj();
        }
    }

    impl PrefabComponent for Health {
        const NAME: &'static str = "health";
        fn from_json(v: &Json) -> Result<Self, PrefabError> {
            Ok(Health(v.as_i64().ok_or(PrefabError::BadComponent)?))
        }
        fn to_json(&self, w: &mut JsonWriter) {
            w.value_i64(self.0);
        }
    }

    world! { pub struct GameWorld { transform: Transform, health: Health, scratch: Scratch } }
    world_prefab! { GameWorld { transform: Transform, health: Health } }

    #[test]
    fn create_from_prefab_json() {
        let prefab = Json::parse(
            r#"{ "schema": "successor.prefab.v1",
                 "components": { "transform": { "x": 1.5, "y": -2.0 }, "health": 42 } }"#,
        )
        .unwrap();
        let mut w = GameWorld::new();
        let e = create_entity_from_json(&mut w, &prefab).unwrap();
        assert_eq!(w.get_component::<Transform>(e), Some(&mut Transform { x: 1.5, y: -2.0 }));
        assert_eq!(w.get_component::<Health>(e), Some(&mut Health(42)));
    }

    #[test]
    fn unknown_component_rejected() {
        let prefab = Json::parse(
            r#"{ "schema": "successor.prefab.v1", "components": { "bogus": {} } }"#,
        )
        .unwrap();
        let mut w = GameWorld::new();
        assert_eq!(create_entity_from_json(&mut w, &prefab), Err(PrefabError::UnknownComponent));
        assert_eq!(w.entity_count(), 0, "failed prefab leaves no entity");
    }

    #[test]
    fn wrong_schema_rejected() {
        let prefab = Json::parse(r#"{ "schema": "other.v1", "components": {} }"#).unwrap();
        let mut w = GameWorld::new();
        assert_eq!(create_entity_from_json(&mut w, &prefab), Err(PrefabError::WrongSchema));
    }

    #[test]
    fn save_then_load_roundtrips() {
        let mut w = GameWorld::new();
        let e = w.spawn();
        w.set_component(e, Transform { x: 3.25, y: 0.5 });
        w.set_component(e, Health(7));
        w.set_component(e, Scratch(999)); // not serialized
        let json_str = save_entity_alloc(&mut w, e);

        let prefab = Json::parse(&json_str).unwrap();
        // Scratch must NOT appear in the prefab.
        assert!(prefab.get("components").and_then(|c| c.get("scratch")).is_none());
        let mut w2 = GameWorld::new();
        let e2 = create_entity_from_json(&mut w2, &prefab).unwrap();
        assert_eq!(w2.get_component::<Transform>(e2), Some(&mut Transform { x: 3.25, y: 0.5 }));
        assert_eq!(w2.get_component::<Health>(e2), Some(&mut Health(7)));
        assert!(!w2.has_component::<Scratch>(e2));
    }
}

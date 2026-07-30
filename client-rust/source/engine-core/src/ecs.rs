//! Minimal archetype-free ECS.
//!
//! Design ported from `~/code/sandbox/voxel_engine/source/engine/src/ecs.rs`
//! (itself a port of the Zig `vibe-jam-2026` ECS). Reimplemented fresh here,
//! with the prefab/JSON coupling removed — this engine loads no prefab files.
//!
//! Semantics preserved exactly:
//! - `Entity { index, generation }`, recycled indices, bumped generations.
//! - Dense storage: packed arrays + lookup map, swap-remove.
//! - Sparse storage (opt-in per component): map only.
//! - Deferred destruction: `destroy()` queues, `flush()` applies.
//! - Queries driven by the first component; other components checked via
//!   `has()`; dead entities skipped.
//!
//! Query invariants (same as the reference): never mutate the driving
//! component's storage during iteration; refs yielded by `next()` are
//! invalidated by inserting into any queried storage — don't hold them across
//! mutations.

use alloc::collections::BTreeMap;
use alloc::vec::Vec;
use core::marker::PhantomData;
use core::ops::Bound;

// ============================================================================
// Entity
// ============================================================================

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Entity {
    pub index: u64,
    pub generation: u64,
}

impl Entity {
    pub const NIL: Entity = Entity {
        index: u64::MAX,
        generation: u64::MAX,
    };

    pub fn is_nil(self) -> bool {
        self.index == u64::MAX
    }
}

impl Default for Entity {
    fn default() -> Self {
        Entity::NIL
    }
}

// ============================================================================
// Storage
// ============================================================================

/// Iteration cursor for the driving storage of a query.
pub enum Cursor {
    Dense(usize),
    /// Last yielded key (None = before first).
    Sparse(Option<u64>),
}

pub trait Storage<T>: Default {
    fn has(&self, ei: u64) -> bool;
    fn get(&mut self, ei: u64) -> Option<&mut T>;
    fn set(&mut self, ei: u64, value: T);
    fn remove(&mut self, ei: u64);
    fn count(&self) -> usize;
    fn start(&self) -> Cursor;
    /// Advances the cursor; yields (entity index, component ptr).
    fn drive(&mut self, cursor: &mut Cursor) -> Option<(u64, *mut T)>;
}

/// Packed-array storage for cache-friendly iteration.
pub struct DenseStorage<T> {
    pub data: Vec<T>,
    pub entities: Vec<u64>,
    lookup: BTreeMap<u64, usize>,
}

impl<T> Default for DenseStorage<T> {
    fn default() -> Self {
        Self {
            data: Vec::new(),
            entities: Vec::new(),
            lookup: BTreeMap::new(),
        }
    }
}

impl<T> Storage<T> for DenseStorage<T> {
    fn has(&self, ei: u64) -> bool {
        self.lookup.contains_key(&ei)
    }

    fn get(&mut self, ei: u64) -> Option<&mut T> {
        let di = *self.lookup.get(&ei)?;
        Some(&mut self.data[di])
    }

    fn set(&mut self, ei: u64, value: T) {
        if let Some(&di) = self.lookup.get(&ei) {
            self.data[di] = value;
        } else {
            let di = self.data.len();
            self.data.push(value);
            self.entities.push(ei);
            self.lookup.insert(ei, di);
        }
    }

    fn remove(&mut self, ei: u64) {
        let Some(di) = self.lookup.remove(&ei) else {
            return;
        };
        let last = self.data.len() - 1;
        if di != last {
            self.data.swap(di, last);
            let moved_ei = self.entities[last];
            self.entities[di] = moved_ei;
            *self.lookup.get_mut(&moved_ei).unwrap() = di;
        }
        self.data.pop();
        self.entities.pop();
    }

    fn count(&self) -> usize {
        self.data.len()
    }

    fn start(&self) -> Cursor {
        Cursor::Dense(0)
    }

    fn drive(&mut self, cursor: &mut Cursor) -> Option<(u64, *mut T)> {
        let Cursor::Dense(i) = cursor else {
            return None;
        };
        if *i >= self.entities.len() {
            return None;
        }
        let ei = self.entities[*i];
        let ptr = &mut self.data[*i] as *mut T;
        *i += 1;
        Some((ei, ptr))
    }
}

/// Map-only storage for rare components.
pub struct SparseStorage<T> {
    pub map: BTreeMap<u64, T>,
}

impl<T> Default for SparseStorage<T> {
    fn default() -> Self {
        Self {
            map: BTreeMap::new(),
        }
    }
}

impl<T> Storage<T> for SparseStorage<T> {
    fn has(&self, ei: u64) -> bool {
        self.map.contains_key(&ei)
    }

    fn get(&mut self, ei: u64) -> Option<&mut T> {
        self.map.get_mut(&ei)
    }

    fn set(&mut self, ei: u64, value: T) {
        self.map.insert(ei, value);
    }

    fn remove(&mut self, ei: u64) {
        self.map.remove(&ei);
    }

    fn count(&self) -> usize {
        self.map.len()
    }

    fn start(&self) -> Cursor {
        Cursor::Sparse(None)
    }

    fn drive(&mut self, cursor: &mut Cursor) -> Option<(u64, *mut T)> {
        let Cursor::Sparse(last) = cursor else {
            return None;
        };
        let lower = match *last {
            None => Bound::Unbounded,
            Some(k) => Bound::Excluded(k),
        };
        let (&k, v) = self.map.range_mut((lower, Bound::Unbounded)).next()?;
        *last = Some(k);
        Some((k, v as *mut T))
    }
}

// ============================================================================
// Component registration
// ============================================================================

pub trait Component: 'static + Sized {
    type Storage: Storage<Self>;
}

/// `impl_component!(Transform: dense);` / `impl_component!(Camera: sparse);`
#[macro_export]
macro_rules! impl_component {
    ($T:ty : dense) => {
        impl $crate::ecs::Component for $T {
            type Storage = $crate::ecs::DenseStorage<$T>;
        }
    };
    ($T:ty : sparse) => {
        impl $crate::ecs::Component for $T {
            type Storage = $crate::ecs::SparseStorage<$T>;
        }
    };
}

// ============================================================================
// Entity pool + world traits
// ============================================================================

pub struct EntityPool {
    pub generations: Vec<u64>,
    pub alive: Vec<bool>,
    pub free_list: Vec<u64>,
    pub entity_count: u64,
    pub pending_destroy: Vec<Entity>,
}

impl Default for EntityPool {
    fn default() -> Self {
        Self::new()
    }
}

impl EntityPool {
    pub fn new() -> Self {
        Self {
            generations: Vec::new(),
            alive: Vec::new(),
            free_list: Vec::new(),
            entity_count: 0,
            pending_destroy: Vec::new(),
        }
    }

    pub fn is_alive(&self, entity: Entity) -> bool {
        if entity.is_nil() {
            return false;
        }
        let i = entity.index as usize;
        if i >= self.generations.len() {
            return false;
        }
        self.alive[i] && self.generations[i] == entity.generation
    }
}

pub trait WorldCore {
    fn pool(&self) -> &EntityPool;
    fn pool_mut(&mut self) -> &mut EntityPool;
}

pub trait HasStorage<T: Component>: WorldCore {
    fn storage(&mut self) -> &mut T::Storage;
    fn storage_ref(&self) -> &T::Storage;
}

/// Blanket entity/component operations.
pub trait WorldOps: WorldCore + Sized {
    fn spawn(&mut self) -> Entity {
        let pool = self.pool_mut();
        if let Some(index) = pool.free_list.pop() {
            pool.alive[index as usize] = true;
            pool.entity_count += 1;
            return Entity {
                index,
                generation: pool.generations[index as usize],
            };
        }
        let index = pool.generations.len() as u64;
        pool.generations.push(0);
        pool.alive.push(true);
        pool.entity_count += 1;
        Entity {
            index,
            generation: 0,
        }
    }

    /// Queue an entity for destruction; components stay live until `flush()`.
    fn destroy(&mut self, entity: Entity) {
        if !self.is_alive(entity) {
            return;
        }
        self.pool_mut().pending_destroy.push(entity);
    }

    fn is_alive(&self, entity: Entity) -> bool {
        self.pool().is_alive(entity)
    }

    fn entity_count(&self) -> u64 {
        self.pool().entity_count
    }

    fn set_component<T: Component>(&mut self, entity: Entity, value: T)
    where
        Self: HasStorage<T>,
    {
        if !self.is_alive(entity) {
            return;
        }
        HasStorage::<T>::storage(self).set(entity.index, value);
    }

    fn get_component<T: Component>(&mut self, entity: Entity) -> Option<&mut T>
    where
        Self: HasStorage<T>,
    {
        if !self.is_alive(entity) {
            return None;
        }
        HasStorage::<T>::storage(self).get(entity.index)
    }

    fn has_component<T: Component>(&self, entity: Entity) -> bool
    where
        Self: HasStorage<T>,
    {
        if !self.is_alive(entity) {
            return false;
        }
        HasStorage::<T>::storage_ref(self).has(entity.index)
    }

    fn remove_component<T: Component>(&mut self, entity: Entity)
    where
        Self: HasStorage<T>,
    {
        if !self.is_alive(entity) {
            return;
        }
        HasStorage::<T>::storage(self).remove(entity.index);
    }

    /// Iterate entities that have `A`, skipping dead ones.
    fn query1<A: Component>(&mut self) -> Query1<A, Self>
    where
        Self: HasStorage<A>,
    {
        Query1 {
            world: self as *mut Self,
            cursor: HasStorage::<A>::storage_ref(self).start(),
            _m: PhantomData,
        }
    }

    /// Iterate entities that have both `A` and `B`; `A` drives iteration —
    /// put the most selective component first.
    fn query2<A: Component, B: Component>(&mut self) -> Query2<A, B, Self>
    where
        Self: HasStorage<A> + HasStorage<B>,
    {
        Query2 {
            world: self as *mut Self,
            cursor: HasStorage::<A>::storage_ref(self).start(),
            _m: PhantomData,
        }
    }
}

impl<W: WorldCore> WorldOps for W {}

// ============================================================================
// Queries
// ============================================================================

pub struct Query1<A: Component, W> {
    world: *mut W,
    cursor: Cursor,
    _m: PhantomData<A>,
}

impl<A: Component, W: WorldCore + HasStorage<A>> Query1<A, W> {
    #[allow(clippy::should_implement_trait)]
    pub fn next(&mut self) -> Option<(Entity, &mut A)> {
        // SAFETY: the query holds a unique `*mut W` for its lifetime; the caller
        // must not mutate the driving storage during iteration (documented
        // invariant). We reborrow per step and never alias the yielded ref.
        unsafe {
            loop {
                let (ei, ptr) = HasStorage::<A>::storage(&mut *self.world).drive(&mut self.cursor)?;
                let i = ei as usize;
                if !(*self.world).pool().alive[i] {
                    continue;
                }
                let generation = (*self.world).pool().generations[i];
                return Some((
                    Entity {
                        index: ei,
                        generation,
                    },
                    &mut *ptr,
                ));
            }
        }
    }
}

pub struct Query2<A: Component, B: Component, W> {
    world: *mut W,
    cursor: Cursor,
    _m: PhantomData<(A, B)>,
}

impl<A: Component, B: Component, W: WorldCore + HasStorage<A> + HasStorage<B>> Query2<A, B, W> {
    #[allow(clippy::should_implement_trait)]
    pub fn next(&mut self) -> Option<(Entity, &mut A, &mut B)> {
        // SAFETY: see Query1::next. `A` and `B` are distinct component types, so
        // their storages are distinct fields — the two `&mut` never alias.
        unsafe {
            loop {
                let (ei, a_ptr) =
                    HasStorage::<A>::storage(&mut *self.world).drive(&mut self.cursor)?;
                let i = ei as usize;
                if !(*self.world).pool().alive[i] {
                    continue;
                }
                if !HasStorage::<B>::storage_ref(&*self.world).has(ei) {
                    continue;
                }
                let b_ptr = HasStorage::<B>::storage(&mut *self.world).get(ei).unwrap() as *mut B;
                let generation = (*self.world).pool().generations[i];
                return Some((
                    Entity {
                        index: ei,
                        generation,
                    },
                    &mut *a_ptr,
                    &mut *b_ptr,
                ));
            }
        }
    }
}

// ============================================================================
// world! macro
// ============================================================================

/// Generates the concrete World struct.
///
/// ```ignore
/// successor_engine_core::world! { pub struct GameWorld {
///     transform: Transform,
///     camera: Camera,
/// } }
/// ```
///
/// Every listed component must implement `Component` (via `impl_component!`).
#[macro_export]
macro_rules! world {
    (pub struct $W:ident { $($field:ident : $C:ty),+ $(,)? }) => {
        pub struct $W {
            pool: $crate::ecs::EntityPool,
            $( $field: <$C as $crate::ecs::Component>::Storage, )+
        }

        impl $W {
            pub fn new() -> Self {
                Self {
                    pool: $crate::ecs::EntityPool::new(),
                    $( $field: core::default::Default::default(), )+
                }
            }

            /// Process all deferred destructions.
            pub fn flush(&mut self) {
                let mut pending = core::mem::take(&mut self.pool.pending_destroy);
                for entity in pending.iter().copied() {
                    self.destroy_immediate(entity);
                }
                pending.clear(); // retains capacity
                self.pool.pending_destroy = pending;
            }

            fn destroy_immediate(&mut self, entity: $crate::ecs::Entity) {
                if !self.pool.is_alive(entity) {
                    return;
                }
                let i = entity.index as usize;
                $( $crate::ecs::Storage::remove(&mut self.$field, entity.index); )+
                self.pool.alive[i] = false;
                self.pool.generations[i] += 1;
                self.pool.free_list.push(entity.index);
                self.pool.entity_count -= 1;
            }
        }

        impl core::default::Default for $W {
            fn default() -> Self {
                Self::new()
            }
        }

        impl $crate::ecs::WorldCore for $W {
            fn pool(&self) -> &$crate::ecs::EntityPool {
                &self.pool
            }
            fn pool_mut(&mut self) -> &mut $crate::ecs::EntityPool {
                &mut self.pool
            }
        }

        $(
            impl $crate::ecs::HasStorage<$C> for $W {
                fn storage(&mut self) -> &mut <$C as $crate::ecs::Component>::Storage {
                    &mut self.$field
                }
                fn storage_ref(&self) -> &<$C as $crate::ecs::Component>::Storage {
                    &self.$field
                }
            }
        )+
    };
}

#[cfg(all(test, feature = "std"))]
mod tests {
    use super::*;

    #[derive(Clone, Copy, PartialEq, Debug)]
    struct Pos(u32);
    #[derive(Clone, Copy, PartialEq, Debug)]
    struct Vel(u32);
    #[derive(Clone, Copy, PartialEq, Debug)]
    struct Tag(u32);

    impl_component!(Pos: dense);
    impl_component!(Vel: dense);
    impl_component!(Tag: sparse);

    crate::world! { pub struct W { pos: Pos, vel: Vel, tag: Tag } }

    #[test]
    fn entity_recycle_bumps_generation() {
        let mut w = W::new();
        let a = w.spawn();
        assert_eq!(a.generation, 0);
        w.destroy(a);
        w.flush();
        assert!(!w.is_alive(a));
        let b = w.spawn();
        assert_eq!(b.index, a.index, "index recycled");
        assert_eq!(b.generation, 1, "generation bumped");
        assert!(w.is_alive(b));
        assert!(!w.is_alive(a), "stale handle stays dead");
    }

    #[test]
    fn dense_swap_remove_preserves_others() {
        let mut w = W::new();
        let e: Vec<_> = (0..4).map(|i| { let x = w.spawn(); w.set_component(x, Pos(i)); x }).collect();
        w.destroy(e[1]);
        w.flush();
        assert!(!w.has_component::<Pos>(e[1]));
        assert_eq!(w.get_component::<Pos>(e[0]), Some(&mut Pos(0)));
        assert_eq!(w.get_component::<Pos>(e[2]), Some(&mut Pos(2)));
        assert_eq!(w.get_component::<Pos>(e[3]), Some(&mut Pos(3)));
    }

    #[test]
    fn query1_visits_live_only() {
        let mut w = W::new();
        for i in 0..5 {
            let x = w.spawn();
            w.set_component(x, Pos(i));
        }
        let dead = w.spawn();
        w.set_component(dead, Pos(99));
        w.destroy(dead);
        w.flush();
        let mut sum = 0u32;
        let mut q = w.query1::<Pos>();
        while let Some((_, p)) = q.next() {
            sum += p.0;
        }
        assert_eq!(sum, 0 + 1 + 2 + 3 + 4);
    }

    #[test]
    fn query1_mid_iteration_insert_other_storage() {
        // The documented capability: inserting a DIFFERENT-typed component while
        // iterating the driving storage is sound.
        let mut w = W::new();
        let ids: Vec<_> = (0..3).map(|i| { let x = w.spawn(); w.set_component(x, Pos(i)); x }).collect();
        let mut seen = 0;
        let mut q = w.query1::<Pos>();
        while let Some((e, _)) = q.next() {
            // Insert Vel into a component storage that is NOT the driver.
            unsafe { (*(&mut w as *mut W)).set_component(e, Vel(7)); }
            seen += 1;
        }
        assert_eq!(seen, 3);
        for id in ids {
            assert_eq!(w.get_component::<Vel>(id), Some(&mut Vel(7)));
        }
    }

    #[test]
    fn query2_intersects() {
        let mut w = W::new();
        let both = w.spawn();
        w.set_component(both, Pos(1));
        w.set_component(both, Vel(2));
        let pos_only = w.spawn();
        w.set_component(pos_only, Pos(3));
        let mut count = 0;
        let mut q = w.query2::<Pos, Vel>();
        while let Some((_, p, v)) = q.next() {
            assert_eq!((p.0, v.0), (1, 2));
            count += 1;
        }
        assert_eq!(count, 1, "only the entity with both components");
    }

    #[test]
    fn sparse_component_roundtrip() {
        let mut w = W::new();
        let e = w.spawn();
        w.set_component(e, Tag(42));
        assert_eq!(w.get_component::<Tag>(e), Some(&mut Tag(42)));
        w.remove_component::<Tag>(e);
        assert!(!w.has_component::<Tag>(e));
    }
}

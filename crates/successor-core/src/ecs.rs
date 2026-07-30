//! Entity identifiers for deterministic simulation storage.
//!
//! This is intentionally small: Successor can still choose any ECS/storage backend later,
//! but save files, net receipts, spatial indexes, and replay traces need a stable generational
//! handle now.

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Generation(u32);

impl Generation {
    pub const FIRST: Self = Self(1);

    pub const fn new(value: u32) -> Self {
        Self(value)
    }

    pub const fn get(self) -> u32 {
        self.0
    }

    pub const fn next(self) -> Self {
        Self(self.0.wrapping_add(1))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct EntityId {
    index: u32,
    generation: Generation,
}

impl EntityId {
    pub const fn new(index: u32, generation: Generation) -> Self {
        Self { index, generation }
    }

    pub const fn first(index: u32) -> Self {
        Self::new(index, Generation::FIRST)
    }

    pub const fn index(self) -> u32 {
        self.index
    }

    pub const fn generation(self) -> Generation {
        self.generation
    }
}

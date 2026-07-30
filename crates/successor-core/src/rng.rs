//! Deterministic RNG. Wraps `rand_chacha::ChaCha8Rng` with explicit seeding and a
//! restricted, project-defined API surface (per ADR-0004).
//!
//! The wrapper exposes only primitives whose value-stability the project owns end-to-end:
//! `next_u32`, `next_u64`, `range_u32`, `fill_bytes`, `split` (domain-keyed substream).
//!
//! Convenience methods that change between `rand` versions (distribution helpers, `gen()`,
//! shuffle helpers, fork helpers) are intentionally absent. Subsystem-specific samplers
//! (e.g. `weighted_index` for loot tables) live in subsystem crates with their own
//! algorithm pinned and golden vectors stored.

use rand::{RngCore, SeedableRng};
use rand_chacha::ChaCha8Rng;

use crate::ecs::EntityId;
use crate::tick::TickIndex;

#[derive(Debug, Clone)]
pub struct DeterministicRng {
    inner: ChaCha8Rng,
    seed: [u8; 32],
}

impl DeterministicRng {
    /// Seed from a 32-byte value. The recommended derivation is BLAKE3 over
    /// `(project_magic, sim_version, domain, shard_id, entity_id, tick, user_seed)`.
    pub fn from_seed32(seed: [u8; 32]) -> Self {
        Self {
            inner: ChaCha8Rng::from_seed(seed),
            seed,
        }
    }

    /// Compatibility wrapper for `seed_from_u64`. Prefer `from_seed32` for production code;
    /// `seed_from_u64` retains its own value-stability surface that may shift between
    /// `rand_chacha` versions. Used in early tests where the 32-byte derivation is overkill.
    pub fn from_seed_u64_compat(seed: u64) -> Self {
        Self {
            inner: ChaCha8Rng::seed_from_u64(seed),
            seed: {
                let mut s = [0u8; 32];
                s[..8].copy_from_slice(&seed.to_le_bytes());
                s
            },
        }
    }

    pub fn seed(&self) -> [u8; 32] {
        self.seed
    }

    pub fn next_u32(&mut self) -> u32 {
        self.inner.next_u32()
    }

    pub fn next_u64(&mut self) -> u64 {
        self.inner.next_u64()
    }

    /// Project-owned bounded-uniform sampler. Documented rejection-sampling approach.
    pub fn range_u32(&mut self, upper_exclusive: u32) -> u32 {
        debug_assert!(upper_exclusive > 0, "range_u32 upper must be > 0");
        // Lemire's nearly-divisionless bounded sampling.
        let bound = u64::from(upper_exclusive);
        loop {
            let x = u64::from(self.next_u32());
            let m = x * bound;
            let l = (m as u32) as u64;
            if l < bound {
                let t = (u64::from(0u32).wrapping_sub(bound)) % bound;
                if l < t {
                    continue;
                }
            }
            return (m >> 32) as u32;
        }
    }

    pub fn fill_bytes(&mut self, dest: &mut [u8]) {
        self.inner.fill_bytes(dest);
    }

    /// Derive a child RNG keyed by domain, entity, and tick. Used for per-subsystem
    /// substreams so that one subsystem's draws do not influence another's value sequence.
    pub fn split(&self, domain: &[u8], entity: EntityId, tick: TickIndex) -> Self {
        let mut hasher = blake3::Hasher::new();
        hasher.update(&self.seed);
        hasher.update(domain);
        hasher.update(&entity.index().to_le_bytes());
        hasher.update(&entity.generation().get().to_le_bytes());
        hasher.update(&tick.0.to_le_bytes());
        let derived: [u8; 32] = *hasher.finalize().as_bytes();
        Self::from_seed32(derived)
    }
}

#[cfg(test)]
mod smoke {
    use super::*;

    #[test]
    fn determinism_same_seed() {
        let mut a = DeterministicRng::from_seed32([0u8; 32]);
        let mut b = DeterministicRng::from_seed32([0u8; 32]);
        for _ in 0..1024 {
            assert_eq!(a.next_u64(), b.next_u64());
        }
    }

    #[test]
    fn split_diverges_by_domain() {
        let parent = DeterministicRng::from_seed32([1u8; 32]);
        let mut a = parent.split(b"resource", EntityId::first(0), TickIndex(0));
        let mut b = parent.split(b"combat", EntityId::first(0), TickIndex(0));
        // Streams must diverge in the first few draws (probabilistically certain).
        let same: bool = (0..16).all(|_| a.next_u64() == b.next_u64());
        assert!(!same, "split RNGs should not produce identical streams");
    }
}

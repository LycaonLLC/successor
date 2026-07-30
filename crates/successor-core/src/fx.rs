//! Fixed-point math. Per ADR-0004: no `f32`/`f64` in deterministic state.
//!
//! `SimFx` is the canonical numeric type for positions, velocities, durations, and
//! probability weights. Backed by `fixed::types::I40F24`: 24 fractional bits give
//! ~5.96e-8 unit resolution, with enough integer range for large local coordinate spaces.
//! For planet-scale global coordinates, use `(zone_id, chunk_i32_x, chunk_i32_y, local_SimFx_*)`
//! rather than widening fractional precision.
//!
//! Overflow handling: every callsite picks `checked` / `saturating` / `wrapping` / `strict` per
//! domain decision. Never rely on debug-vs-release behavior.

pub type SimFx = fixed::types::I40F24;

/// Construct a `SimFx` from milli-units (×1000 scaled integer).
/// Useful for content-table values that designers author as decimals.
pub fn from_milli_units(v: i64) -> SimFx {
    use fixed::traits::FromFixed;
    let units = SimFx::from_num(v) / SimFx::from_num(1000);
    SimFx::from_fixed(units)
}

/// Raw bit pattern of a `SimFx` for canonical state hashing.
/// Per ADR-0004: hash by raw bits, never by decimal string.
pub fn to_bits(v: SimFx) -> i64 {
    v.to_bits()
}

/// Construct a `SimFx` from raw bits.
pub fn from_bits(bits: i64) -> SimFx {
    SimFx::from_bits(bits)
}

#[cfg(test)]
mod smoke {
    use super::*;

    #[test]
    fn round_trip_bits() {
        let v = from_milli_units(12_345);
        let bits = to_bits(v);
        let v2 = from_bits(bits);
        assert_eq!(v, v2);
    }

    #[test]
    fn deterministic_construction() {
        assert_eq!(from_milli_units(1_000), from_milli_units(1_000));
    }
}

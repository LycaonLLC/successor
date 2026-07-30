//! Canonical state-writer protocol for deterministic hashing (per ADR-0004).
//!
//! Hash format:
//!
//!   domain_header | schema_version | tick | subsystem_id | sorted_entity_records*
//!
//! Each entity record:
//!
//!   entity_id | component_tag | component_version | byte_length | canonical_fields
//!
//! Canonical fields:
//!   - fixed-point: little-endian raw bits
//!   - integer: little-endian
//!   - bool: 1 byte (0 or 1)
//!   - Option: 0 or 1 prefix + payload
//!   - Vec: u32 LE length + items in canonical order
//!   - Map: forbidden — convert to sorted entries
//!
//! State hashing must use this writer, never serde defaults, never `Debug`, never
//! `HashMap` iteration.

use crate::hash::StateHasher;

pub trait CanonicalHash {
    fn write_canonical(&self, w: &mut StateWriter);
}

#[derive(Debug, Clone, Default)]
pub struct StateWriter {
    inner: StateHasher,
}

impl StateWriter {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn write_domain_header(&mut self, domain: &[u8]) -> &mut Self {
        self.inner.write_bytes(b"successor:");
        self.inner.write_bytes(domain);
        self.inner.write_bytes(b":");
        self
    }

    pub fn write_schema_version(&mut self, v: u32) -> &mut Self {
        self.inner.write_bytes(&v.to_le_bytes());
        self
    }

    pub fn write_tick(&mut self, tick: u64) -> &mut Self {
        self.inner.write_u64(tick);
        self
    }

    pub fn write_subsystem_id(&mut self, id: &str) -> &mut Self {
        self.inner.write_bytes(id.as_bytes());
        self.inner.write_bytes(b":");
        self
    }

    pub fn write_u32(&mut self, v: u32) -> &mut Self {
        self.inner.write_bytes(&v.to_le_bytes());
        self
    }

    pub fn write_u64(&mut self, v: u64) -> &mut Self {
        self.inner.write_u64(v);
        self
    }

    pub fn write_i64(&mut self, v: i64) -> &mut Self {
        self.inner.write_i64(v);
        self
    }

    pub fn write_bool(&mut self, b: bool) -> &mut Self {
        self.inner.write_bytes(&[if b { 1 } else { 0 }]);
        self
    }

    pub fn write_bytes(&mut self, v: &[u8]) -> &mut Self {
        self.inner.write_bytes(v);
        self
    }

    pub fn write_optional<T, F: FnOnce(&mut StateWriter, &T)>(
        &mut self,
        opt: &Option<T>,
        f: F,
    ) -> &mut Self {
        match opt {
            None => {
                self.inner.write_bytes(&[0]);
            }
            Some(v) => {
                self.inner.write_bytes(&[1]);
                f(self, v);
            }
        }
        self
    }

    pub fn write_vec<T, F: Fn(&mut StateWriter, &T)>(&mut self, items: &[T], f: F) -> &mut Self {
        let len = u32::try_from(items.len()).expect("vec length fits in u32 in canonical hash");
        self.write_u32(len);
        for item in items {
            f(self, item);
        }
        self
    }

    pub fn finalize(&self) -> [u8; 32] {
        self.inner.finalize()
    }

    pub fn finalize_hex(&self) -> String {
        self.inner.finalize_hex()
    }
}

#[cfg(test)]
mod smoke {
    use super::*;

    #[test]
    fn deterministic_round_trip() {
        let mut a = StateWriter::new();
        a.write_domain_header(b"resource")
            .write_schema_version(1)
            .write_tick(42)
            .write_subsystem_id("pool")
            .write_u64(0xC0FFEE)
            .write_bool(true)
            .write_bytes(b"abc");
        let mut b = StateWriter::new();
        b.write_domain_header(b"resource")
            .write_schema_version(1)
            .write_tick(42)
            .write_subsystem_id("pool")
            .write_u64(0xC0FFEE)
            .write_bool(true)
            .write_bytes(b"abc");
        assert_eq!(a.finalize(), b.finalize());
    }
}

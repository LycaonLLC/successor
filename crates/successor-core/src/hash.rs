//! Canonical state hashing. Used as the per-tick fingerprint asserted in determinism tests.

use blake3::Hasher;

#[derive(Debug, Clone, Default)]
pub struct StateHasher {
    inner: Hasher,
}

impl StateHasher {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn write_u64(&mut self, v: u64) -> &mut Self {
        self.inner.update(&v.to_le_bytes());
        self
    }

    pub fn write_i64(&mut self, v: i64) -> &mut Self {
        self.inner.update(&v.to_le_bytes());
        self
    }

    pub fn write_bytes(&mut self, v: &[u8]) -> &mut Self {
        self.inner.update(v);
        self
    }

    pub fn finalize(&self) -> [u8; 32] {
        *self.inner.finalize().as_bytes()
    }

    pub fn finalize_hex(&self) -> String {
        let bytes = self.finalize();
        let mut s = String::with_capacity(64);
        for b in bytes {
            use std::fmt::Write;
            let _ = write!(s, "{:02x}", b);
        }
        s
    }
}

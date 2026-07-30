//! Fixed-step tick.

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct TickIndex(pub u64);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TickRate {
    pub hz: u32,
}

impl TickRate {
    pub const SERVER: TickRate = TickRate { hz: 30 };
    pub const CLIENT_INTERP: TickRate = TickRate { hz: 60 };
}

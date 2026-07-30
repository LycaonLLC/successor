//! Release identity + reconnect policy for the playable slice.
//!
//! The server gates joins on a client release allowlist (`server/src/auth/
//! runtime.ts`). Per AGENTS.md the Rust client stays UNPUBLISHED/unallowlisted
//! until parity + product promotion, so it advertises a clearly non-production
//! identity — it must never impersonate an allowlisted web/desktop release.
//!
//! `ReconnectPolicy` is the backoff schedule the connect loop waits between
//! attempts (the session FSM counts attempts; this owns the timing).

/// This client's release identity. Intentionally an `unlisted` channel: it will
/// NOT match the production allowlist until a deliberate product decision
/// registers it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ReleaseIdentity {
    pub name: &'static str,
    pub version: &'static str,
    pub channel: &'static str,
}

pub const CURRENT: ReleaseIdentity = ReleaseIdentity {
    name: "successor-rust-client",
    version: env!("CARGO_PKG_VERSION"),
    channel: "unlisted",
};

impl ReleaseIdentity {
    /// The identity string sent to the server on join (`name/version+channel`).
    pub fn header(&self) -> String {
        format!("{}/{}+{}", self.name, self.version, self.channel)
    }

    /// Whether this identity claims a production/allowlisted channel (it must
    /// not — a guard so we never accidentally point an unrecognized client at
    /// the live authority as if promoted).
    pub fn is_production(&self) -> bool {
        matches!(self.channel, "stable" | "release" | "production")
    }
}

/// Exponential-backoff reconnect schedule with a cap and a hard attempt limit.
#[derive(Clone, Copy, Debug)]
pub struct ReconnectPolicy {
    pub attempt: u32,
    pub max_attempts: u32,
    pub base_delay_ms: u32,
    pub max_delay_ms: u32,
}

impl Default for ReconnectPolicy {
    fn default() -> Self {
        Self { attempt: 0, max_attempts: 6, base_delay_ms: 500, max_delay_ms: 8_000 }
    }
}

impl ReconnectPolicy {
    pub fn new(max_attempts: u32, base_delay_ms: u32, max_delay_ms: u32) -> Self {
        Self { attempt: 0, max_attempts, base_delay_ms, max_delay_ms }
    }

    /// Record a failed connection; returns the delay (ms) to wait before the
    /// next attempt, or `None` once the attempt budget is exhausted (give up).
    pub fn record_failure(&mut self) -> Option<u32> {
        if self.attempt >= self.max_attempts {
            return None;
        }
        let delay = self.delay_for(self.attempt);
        self.attempt += 1;
        Some(delay)
    }

    /// Backoff delay for a zero-based attempt index (base × 2^n, capped).
    pub fn delay_for(&self, attempt: u32) -> u32 {
        let shifted = self.base_delay_ms.saturating_mul(1u32 << attempt.min(16));
        shifted.min(self.max_delay_ms)
    }

    /// A successful connection resets the schedule.
    pub fn reset(&mut self) {
        self.attempt = 0;
    }

    pub fn exhausted(&self) -> bool {
        self.attempt >= self.max_attempts
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn release_identity_is_unlisted_not_production() {
        assert!(!CURRENT.is_production(), "Rust client must stay unallowlisted");
        assert_eq!(CURRENT.channel, "unlisted");
        let h = CURRENT.header();
        assert!(h.starts_with("successor-rust-client/"));
        assert!(h.ends_with("+unlisted"));
    }

    #[test]
    fn backoff_grows_and_caps() {
        let p = ReconnectPolicy::default(); // base 500, cap 8000
        assert_eq!(p.delay_for(0), 500);
        assert_eq!(p.delay_for(1), 1000);
        assert_eq!(p.delay_for(2), 2000);
        assert_eq!(p.delay_for(3), 4000);
        assert_eq!(p.delay_for(4), 8000);
        assert_eq!(p.delay_for(5), 8000, "capped at max_delay");
        assert_eq!(p.delay_for(20), 8000, "no overflow at large attempt");
    }

    #[test]
    fn gives_up_after_max_attempts() {
        let mut p = ReconnectPolicy::new(3, 100, 1000);
        assert_eq!(p.record_failure(), Some(100));
        assert_eq!(p.record_failure(), Some(200));
        assert_eq!(p.record_failure(), Some(400));
        assert_eq!(p.record_failure(), None, "budget exhausted");
        assert!(p.exhausted());
    }

    #[test]
    fn reset_after_success_restarts_schedule() {
        let mut p = ReconnectPolicy::new(4, 100, 1000);
        p.record_failure();
        p.record_failure();
        p.reset();
        assert_eq!(p.attempt, 0);
        assert_eq!(p.record_failure(), Some(100), "back to base after reset");
    }
}

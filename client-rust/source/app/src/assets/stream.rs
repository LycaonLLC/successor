//! Bounded asynchronous asset streaming.
//!
//! `AssetStreamer` multiplexes asset fetches through the platform async
//! channel (`begin_asset`/`poll_asset`) with a fixed in-flight capacity.
//! Backends without an async channel (native tests, immediate reads) resolve
//! synchronously inside `request`/`pump`, so consumers behave identically on
//! every platform. `pump` is allocation-free when nothing is in flight, which
//! keeps it safe to call from the steady-state frame loop.

use std::collections::{HashSet, VecDeque};

use successor_platform::{AssetHandle, AssetPoll, Platform};

/// Maximum concurrent in-flight fetches.
pub const MAX_IN_FLIGHT: usize = 64;

/// Three-way byte resolution for streaming consumers: bytes in hand, fetch
/// still in flight, or terminally unavailable (treat like a sync miss).
pub enum ByteSource {
    Ready(Vec<u8>),
    Pending,
    Missing,
}

/// Resolution state for consumers bridging async fetches into sync-shaped
/// call sites: `Pending` means "render without this piece and retry".
pub enum Streamed<T> {
    Ready(T),
    Pending,
}

struct InFlight {
    id: String,
    handle: AssetHandle,
}

pub struct AssetStreamer {
    /// Fixed-capacity slot table; `None` marks a vacant slot.
    in_flight: Vec<Option<InFlight>>,
    /// Requests accepted beyond capacity, started as slots free up.
    queued: VecDeque<String>,
    /// Stable ids already claimed (in flight or queued); dedupe guard.
    active: HashSet<String>,
    /// Ids whose fetch terminally failed; consumers see `Missing` forever.
    failed: HashSet<String>,
    /// Completed fetches awaiting consumer pickup.
    completed: VecDeque<(String, Vec<u8>)>,
    /// Monotonic counter bumped whenever `pump`/`request` deliver results;
    /// cheap change detection so consumers skip probing when unchanged.
    ready_epoch: u64,
}

impl Default for AssetStreamer {
    fn default() -> Self {
        Self::new()
    }
}

impl AssetStreamer {
    pub fn new() -> Self {
        Self {
            in_flight: std::iter::repeat_with(|| None)
                .take(MAX_IN_FLIGHT)
                .collect(),
            queued: VecDeque::new(),
            active: HashSet::new(),
            failed: HashSet::new(),
            completed: VecDeque::new(),
            ready_epoch: 0,
        }
    }

    /// Request `id`. Deduplicates against in-flight, queued, un-drained
    /// completions, and terminal failures. When the platform exposes no async
    /// channel the read resolves synchronously and lands directly in
    /// `completed` (or `failed`).
    pub fn request(&mut self, platform: &mut dyn Platform, id: &str) {
        if self.active.contains(id)
            || self.failed.contains(id)
            || self.completed.iter().any(|(done, _)| done == id)
        {
            return;
        }
        match platform.begin_asset(id) {
            Some(handle) => {
                if let Some(slot) = self.in_flight.iter_mut().find(|slot| slot.is_none()) {
                    *slot = Some(InFlight {
                        id: id.to_string(),
                        handle,
                    });
                    self.active.insert(id.to_string());
                } else {
                    self.queued.push_back(id.to_string());
                    self.active.insert(id.to_string());
                }
            }
            None => match platform.read_asset(id) {
                Ok(bytes) => {
                    self.completed.push_back((id.to_string(), bytes));
                    self.ready_epoch += 1;
                }
                Err(_) => {
                    self.failed.insert(id.to_string());
                }
            },
        }
    }

    /// Poll in-flight fetches and start queued requests as capacity frees.
    /// Allocation-free when idle: with no in-flight slots and an empty queue
    /// this touches no heap memory.
    pub fn pump(&mut self, platform: &mut dyn Platform) {
        for slot in &mut self.in_flight {
            let Some(in_flight) = slot else {
                continue;
            };
            match platform.poll_asset(in_flight.handle) {
                AssetPoll::Pending => {}
                AssetPoll::Ready(bytes) => {
                    let id = std::mem::take(&mut in_flight.id);
                    self.active.remove(&id);
                    self.completed.push_back((id, bytes));
                    self.ready_epoch += 1;
                    *slot = None;
                }
                AssetPoll::Failed => {
                    let id = std::mem::take(&mut in_flight.id);
                    self.active.remove(&id);
                    self.failed.insert(id);
                    *slot = None;
                }
            }
        }
        while !self.queued.is_empty() {
            let Some(slot) = self.in_flight.iter_mut().find(|slot| slot.is_none()) else {
                break;
            };
            let id = self.queued.pop_front().expect("queue checked non-empty");
            match platform.begin_asset(&id) {
                Some(handle) => {
                    *slot = Some(InFlight { id, handle });
                }
                None => {
                    self.active.remove(&id);
                    match platform.read_asset(&id) {
                        Ok(bytes) => {
                            self.completed.push_back((id, bytes));
                            self.ready_epoch += 1;
                        }
                        Err(_) => {
                            self.failed.insert(id);
                        }
                    }
                }
            }
        }
    }

    /// Drain a completed fetch for `id`, if one is waiting.
    pub fn take(&mut self, id: &str) -> Option<Vec<u8>> {
        let position = self.completed.iter().position(|(done, _)| done == id)?;
        Some(self.completed.remove(position).expect("position found").1)
    }

    /// Drain every waiting completion. Allocation-free when empty.
    pub fn drain_ready(&mut self) -> std::collections::vec_deque::Drain<'_, (String, Vec<u8>)> {
        self.completed.drain(..)
    }

    /// Completion epoch: changes exactly when new results land in `completed`.
    pub fn ready_epoch(&self) -> u64 {
        self.ready_epoch
    }

    /// Resolve bytes for `id`: drain a completion when one is waiting,
    /// otherwise (idempotently) issue the request and report `Pending`.
    /// Terminal failures report `Missing` without ever re-fetching.
    pub fn resolve(&mut self, platform: &mut dyn Platform, id: &str) -> ByteSource {
        if self.failed.contains(id) {
            return ByteSource::Missing;
        }
        match self.take(id) {
            Some(bytes) => ByteSource::Ready(bytes),
            None => {
                self.request(platform, id);
                ByteSource::Pending
            }
        }
    }

    /// True while `id` is in flight or queued.
    pub fn is_active(&self, id: &str) -> bool {
        self.active.contains(id)
    }

    /// Number of occupied in-flight slots.
    pub fn in_flight_count(&self) -> usize {
        self.in_flight.iter().flatten().count()
    }

    /// Completed fetches not yet drained by a consumer.
    pub fn pending_drain(&self) -> usize {
        self.completed.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use successor_platform::{AssetError, SettingsScope};

    struct AsyncMock {
        bytes: Vec<u8>,
        pending: Vec<(u64, u32)>, // (handle, polls until ready)
        polls_until_ready: u32,
        next_handle: u64,
        began: Vec<String>,
    }

    impl AsyncMock {
        fn new(bytes: &[u8], polls_until_ready: u32) -> Self {
            Self {
                bytes: bytes.to_vec(),
                pending: Vec::new(),
                polls_until_ready,
                next_handle: 1,
                began: Vec::new(),
            }
        }
    }

    impl Platform for AsyncMock {
        fn monotonic_ms(&self) -> u64 {
            0
        }
        fn logical_size(&self) -> (u32, u32) {
            (0, 0)
        }
        fn read_asset(&self, _stable_id: &str) -> Result<Vec<u8>, AssetError> {
            Ok(self.bytes.clone())
        }
        fn begin_asset(&mut self, stable_id: &str) -> Option<AssetHandle> {
            self.began.push(stable_id.to_string());
            let handle = self.next_handle;
            self.next_handle += 1;
            self.pending.push((handle, self.polls_until_ready));
            Some(AssetHandle(handle))
        }
        fn poll_asset(&mut self, handle: AssetHandle) -> AssetPoll {
            let Some(entry) = self.pending.iter_mut().find(|(h, _)| *h == handle.0) else {
                return AssetPoll::Failed;
            };
            if entry.1 > 0 {
                entry.1 -= 1;
                return AssetPoll::Pending;
            }
            self.pending.retain(|(h, _)| *h != handle.0);
            AssetPoll::Ready(self.bytes.clone())
        }
        fn load_settings(&self, _scope: SettingsScope) -> Option<Vec<u8>> {
            None
        }
        fn save_settings(&mut self, _scope: SettingsScope, _bytes: &[u8]) -> Result<(), String> {
            Ok(())
        }
        fn report_fatal(&mut self, _message: &str) {}
    }

    struct SyncMock;

    impl Platform for SyncMock {
        fn monotonic_ms(&self) -> u64 {
            0
        }
        fn logical_size(&self) -> (u32, u32) {
            (0, 0)
        }
        fn read_asset(&self, stable_id: &str) -> Result<Vec<u8>, AssetError> {
            Ok(stable_id.as_bytes().to_vec())
        }
        fn load_settings(&self, _scope: SettingsScope) -> Option<Vec<u8>> {
            None
        }
        fn save_settings(&mut self, _scope: SettingsScope, _bytes: &[u8]) -> Result<(), String> {
            Ok(())
        }
        fn report_fatal(&mut self, _message: &str) {}
    }

    #[test]
    fn sync_backend_resolves_inside_request() {
        let mut platform = SyncMock;
        let mut streamer = AssetStreamer::new();
        streamer.request(&mut platform, "assets/x.glb");
        let Some(bytes) = streamer.take("assets/x.glb") else {
            panic!("sync request must complete immediately");
        };
        assert_eq!(bytes, b"assets/x.glb");
        assert_eq!(streamer.in_flight_count(), 0);
    }

    #[test]
    fn async_backend_pends_then_delivers() {
        let mut platform = AsyncMock::new(b"payload", 2);
        let mut streamer = AssetStreamer::new();
        streamer.request(&mut platform, "assets/y.glb");
        assert!(streamer.take("assets/y.glb").is_none());
        streamer.pump(&mut platform); // pending
        streamer.pump(&mut platform); // pending
        assert!(streamer.take("assets/y.glb").is_none());
        streamer.pump(&mut platform); // ready
        let Some(bytes) = streamer.take("assets/y.glb") else {
            panic!("poll must deliver bytes once ready");
        };
        assert_eq!(bytes, b"payload");
        assert_eq!(streamer.in_flight_count(), 0);
        assert!(!streamer.is_active("assets/y.glb"));
    }

    #[test]
    fn duplicate_requests_are_ignored() {
        let mut platform = AsyncMock::new(b"z", 0);
        let mut streamer = AssetStreamer::new();
        streamer.request(&mut platform, "assets/dup.glb");
        streamer.request(&mut platform, "assets/dup.glb");
        assert_eq!(platform.began.len(), 1);
        streamer.pump(&mut platform);
        streamer.request(&mut platform, "assets/dup.glb");
        assert_eq!(platform.began.len(), 1, "un-drained completion dedupes");
        assert!(streamer.take("assets/dup.glb").is_some());
    }

    #[test]
    fn resolve_reports_pending_then_ready_then_missing_is_terminal() {
        struct FailOnce;
        impl Platform for FailOnce {
            fn monotonic_ms(&self) -> u64 {
                0
            }
            fn logical_size(&self) -> (u32, u32) {
                (0, 0)
            }
            fn read_asset(&self, _stable_id: &str) -> Result<Vec<u8>, AssetError> {
                Err(AssetError::Unreadable)
            }
            fn load_settings(&self, _scope: SettingsScope) -> Option<Vec<u8>> {
                None
            }
            fn save_settings(&mut self, _scope: SettingsScope, _b: &[u8]) -> Result<(), String> {
                Ok(())
            }
            fn report_fatal(&mut self, _message: &str) {}
        }

        let mut platform = AsyncMock::new(b"resolved", 1);
        let mut streamer = AssetStreamer::new();
        assert!(matches!(
            streamer.resolve(&mut platform, "assets/pending.glb"),
            ByteSource::Pending
        ));
        streamer.pump(&mut platform);
        assert!(matches!(
            streamer.resolve(&mut platform, "assets/pending.glb"),
            ByteSource::Pending
        ));
        streamer.pump(&mut platform);
        match streamer.resolve(&mut platform, "assets/pending.glb") {
            ByteSource::Ready(bytes) => assert_eq!(bytes, b"resolved"),
            _ => panic!("completion must resolve to bytes"),
        }

        let mut failing = FailOnce;
        assert!(matches!(
            streamer.resolve(&mut failing, "assets/absent.glb"),
            ByteSource::Pending
        ));
        assert!(matches!(
            streamer.resolve(&mut failing, "assets/absent.glb"),
            ByteSource::Missing
        ));
        // Terminal: a third resolve must not re-issue a platform read.
        assert!(matches!(
            streamer.resolve(&mut failing, "assets/absent.glb"),
            ByteSource::Missing
        ));
    }

    #[test]
    fn capacity_queues_and_drains_in_order() {
        let mut platform = AsyncMock::new(b"w", 0);
        let mut streamer = AssetStreamer::new();
        for index in 0..(MAX_IN_FLIGHT + 4) {
            let id = format!("assets/bulk/{index}.glb");
            streamer.request(&mut platform, &id);
        }
        assert_eq!(streamer.in_flight_count(), MAX_IN_FLIGHT);
        // Every pump completes all in-flight (0 polls) and starts the queued.
        for _ in 0..2 {
            streamer.pump(&mut platform);
        }
        assert_eq!(streamer.pending_drain(), MAX_IN_FLIGHT + 4);
        for index in 0..(MAX_IN_FLIGHT + 4) {
            let id = format!("assets/bulk/{index}.glb");
            assert!(streamer.take(&id).is_some(), "missing {id}");
        }
        assert_eq!(streamer.in_flight_count(), 0);
    }
}

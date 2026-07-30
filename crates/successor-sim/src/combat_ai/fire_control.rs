#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct WeaponMagazineProfile {
    pub(crate) magazine_size: u32,
    pub(crate) reload_ticks: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub(crate) struct WeaponMagazineState {
    pub(crate) loaded_rounds: u32,
    pub(crate) reload_until_tick: u64,
}

impl WeaponMagazineState {
    pub(crate) const fn full(profile: WeaponMagazineProfile) -> Self {
        Self {
            loaded_rounds: profile.magazine_size,
            reload_until_tick: 0,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum WeaponFireReadiness {
    Ready(WeaponMagazineState),
    StartedReload(WeaponMagazineState),
    Reloading(WeaponMagazineState),
    Empty(WeaponMagazineState),
}

pub(crate) fn completed_magazine_state(
    mut state: WeaponMagazineState,
    profile: WeaponMagazineProfile,
    tick: u64,
    reserve_available: Option<u32>,
) -> WeaponMagazineState {
    state.loaded_rounds = state.loaded_rounds.min(profile.magazine_size);
    if state.reload_until_tick > 0 && tick >= state.reload_until_tick {
        let needed = profile.magazine_size.saturating_sub(state.loaded_rounds);
        let moved = reserve_available
            .map(|reserve| reserve.min(needed))
            .unwrap_or(needed);
        state.loaded_rounds = state
            .loaded_rounds
            .saturating_add(moved)
            .min(profile.magazine_size);
        state.reload_until_tick = 0;
    }
    state
}

pub(crate) fn consume_round_or_start_reload(
    state: WeaponMagazineState,
    profile: WeaponMagazineProfile,
    tick: u64,
    reserve_available: Option<u32>,
) -> WeaponFireReadiness {
    let mut state = completed_magazine_state(state, profile, tick, reserve_available);
    if state.reload_until_tick > tick {
        return WeaponFireReadiness::Reloading(state);
    }
    if state.loaded_rounds > 0 {
        state.loaded_rounds = state.loaded_rounds.saturating_sub(1);
        return WeaponFireReadiness::Ready(state);
    }

    let can_reload = reserve_available.map(|reserve| reserve > 0).unwrap_or(true);
    if !can_reload {
        return WeaponFireReadiness::Empty(state);
    }

    state.reload_until_tick = tick.saturating_add(profile.reload_ticks.max(1));
    WeaponFireReadiness::StartedReload(state)
}

pub(crate) fn reload_remaining_ticks(state: WeaponMagazineState, tick: u64) -> u64 {
    state.reload_until_tick.saturating_sub(tick)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn magazine_starts_reload_when_loaded_rounds_are_empty() {
        let profile = WeaponMagazineProfile {
            magazine_size: 30,
            reload_ticks: 60,
        };
        let state = WeaponMagazineState {
            loaded_rounds: 0,
            reload_until_tick: 0,
        };

        assert_eq!(
            consume_round_or_start_reload(state, profile, 10, Some(24)),
            WeaponFireReadiness::StartedReload(WeaponMagazineState {
                loaded_rounds: 0,
                reload_until_tick: 70,
            })
        );
    }

    #[test]
    fn magazine_completion_refills_only_available_reserve() {
        let profile = WeaponMagazineProfile {
            magazine_size: 30,
            reload_ticks: 60,
        };
        let state = WeaponMagazineState {
            loaded_rounds: 0,
            reload_until_tick: 70,
        };

        assert_eq!(
            completed_magazine_state(state, profile, 71, Some(8)),
            WeaponMagazineState {
                loaded_rounds: 8,
                reload_until_tick: 0,
            }
        );
    }
}

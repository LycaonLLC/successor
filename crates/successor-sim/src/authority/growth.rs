//! Pure crop-growth math — §C.1-C.4 (agriculture-design.md), worked from first
//! principles, integer/milli only, no wall-clock, native == wasm32. This module
//! holds NO stored state: it is the deterministic per-game-day advance the lazy
//! `settle_tile` (farming.rs) drives, plus the farm-time + calendar model and the
//! derived readouts (stage, dormancy). Every rate here is unit-tested against the
//! §C.8 worked examples and §C.9 degenerate cases.
use super::*;

// ── FARM-TIME MODEL (F-Time; "Time-model ruling") ──────────────────────────────
// Crops anchor to GAME-DAYS (seasonal coherence), stored/derived in ticks. The
// single owner tuning knob is `real_seconds_per_game_day`: production ~3600
// (1 real hr/game-day), DEV-OVERRIDABLE to 300 (5 real min/game-day) for fast QA.
// One number sets the whole cadence; every §C relationship holds when it changes.
pub(super) const FARM_REAL_SECONDS_PER_GAME_DAY_PRODUCTION: u32 = 3_600;
// Dev override value is 300 (5 real min/game-day); applied at runtime via
// SliceAuthorityState::set_farm_real_seconds_per_game_day (F-Time §H).

/// ticks per game-day = tickRateHz * realSecondsPerGameDay (dev: 30*300 = 9_000).
pub(super) fn ticks_per_game_day(tick_rate_hz: u32, real_seconds_per_game_day: u32) -> u64 {
    u64::from(tick_rate_hz.max(1)).saturating_mul(u64::from(real_seconds_per_game_day.max(1)))
}

/// Whole game-day index for an authority tick, epoch-anchored at tick 0. The
/// season calendar (below) is a pure fn of this, matching the worldClock month
/// six-cycle calendar. Growth advances across each WHOLE day boundary.
pub(super) fn game_day_index_for_tick(tick: u64, ticks_per_game_day: u64) -> u64 {
    tick / ticks_per_game_day.max(1)
}

// ── SEASON CALENDAR (mirrors worldClockSystem.ts: 6 months x 30 days) ───────────
pub(super) const GAME_DAYS_PER_MONTH: u64 = 30;
pub(super) const MONTHS_PER_YEAR: u64 = 6;
pub(super) const GAME_DAYS_PER_YEAR: u64 = GAME_DAYS_PER_MONTH * MONTHS_PER_YEAR; // 180

/// Cycle index (0..5) for a whole game-day, pure fn of the day.
pub(super) fn month_index_for_game_day(game_day: u64) -> u8 {
    ((game_day % GAME_DAYS_PER_YEAR) / GAME_DAYS_PER_MONTH) as u8
}

/// `season_affinity` is a bitmask: bit i set => month i is favourable. A crop with
/// no bits set is in-season nowhere (always off-season). All-bits => evergreen.
pub(super) fn in_season(season_affinity: u8, month_index: u8) -> bool {
    month_index < 8 && (season_affinity & (1u8 << month_index)) != 0
}

// ── GROWTH CONSTANTS (§C.1) ─────────────────────────────────────────────────────
pub(super) const MILLI: u32 = 1_000;
pub(super) const MOISTURE_FULL_MILLI: u16 = 1_000;
pub(super) const MOISTURE_DECAY_BASE_PER_GAME_DAY: u32 = 1_000;
pub(super) const MOISTURE_GROWTH_THRESHOLD_MILLI: u16 = 0; // any moisture > 0 counts as watered
pub(super) const NUM_VISUAL_STAGES: u32 = 5; // sprout -> seedling -> growing -> budding -> mature
pub(super) const WITHER_GRACE_BASE_DAYS: u32 = 2;
pub(super) const WITHER_GRACE_MAX_EXTRA_DAYS: u32 = 6; // grace = 2 + hardiness*6/1000 -> 2..8 dry days

// ── YIELD / QUALITY TENDING (§C.4) ──────────────────────────────────────────────
pub(super) const TENDING_START_MILLI: u16 = 500;
pub(super) const TENDING_GOOD_DAY_DELTA: u16 = 60; // on-time watered, in-season day
pub(super) const TENDING_BAD_DAY_DELTA: u16 = 90; // dry/neglected day (bad bites harder than good heals)

/// Bound the offline catch-up loop. Beyond the runway + wither grace, an unwatered
/// crop collapses to a Dormant fixed point (no further change), so the caller
/// breaks early; this cap is the absolute ceiling on iterations per settle so a
/// year-long offline gap is still O(1)-ish and never a runaway loop.
pub(super) const MAX_SETTLE_GAME_DAYS_PER_CALL: u64 = 400; // > one full year of daily change

/// maturity target in milli-game-days (growth_days_base * 1000).
pub(super) fn maturity_milli_days(profile: &AgronomicProfile) -> u64 {
    u64::from(profile.growth_days_base).saturating_mul(u64::from(MILLI))
}

/// Per-game-day moisture decay = BASE * water_need_milli / 1000 (= water_need_milli
/// at BASE 1000). water_need 1000 -> 1-day runway; 250 -> 4-day; 0 -> never dries.
pub(super) fn decay_per_day(water_need_milli: u16) -> u16 {
    u16::try_from(
        MOISTURE_DECAY_BASE_PER_GAME_DAY.saturating_mul(u32::from(water_need_milli)) / MILLI,
    )
    .unwrap_or(u16::MAX)
}

/// Dry-day grace before dormancy = 2 + hardiness*6/1000, clamped 2..8.
pub(super) fn wither_grace_days(hardiness_milli: u16) -> u32 {
    WITHER_GRACE_BASE_DAYS
        + WITHER_GRACE_MAX_EXTRA_DAYS.saturating_mul(u32::from(hardiness_milli)) / MILLI
}

/// Derived visual stage 0..NUM_VISUAL_STAGES-1 from accrued progress. maturity 0
/// (degenerate growth_days_base==0) reads as fully mature (never a div-by-zero).
pub(super) fn stage_for_progress(
    accumulated_growth_days_milli: u64,
    maturity_milli_days: u64,
) -> u8 {
    if maturity_milli_days == 0 {
        return (NUM_VISUAL_STAGES - 1) as u8;
    }
    let stage = accumulated_growth_days_milli.saturating_mul(u64::from(NUM_VISUAL_STAGES))
        / maturity_milli_days;
    stage.min(u64::from(NUM_VISUAL_STAGES - 1)) as u8
}

pub(super) fn is_mature(accumulated_growth_days_milli: u64, profile: &AgronomicProfile) -> bool {
    accumulated_growth_days_milli >= maturity_milli_days(profile)
}

/// Dormancy is DERIVED (never stored, §A.2): consecutive dry days >= grace.
/// Recoverable forever (F-Wither) — one WaterTile resets drought_days to 0 and
/// growth resumes from the SAME accumulated progress (no seed loss).
pub(super) fn is_dormant(drought_days: u16, hardiness_milli: u16) -> bool {
    u32::from(drought_days) >= wither_grace_days(hardiness_milli)
}

/// The mutable growth accrual a crop carries. moisture lives on the TILE and is
/// passed in/out so this stays free of the tile struct (testable in isolation).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct CropGrowthAccrual {
    pub(super) accumulated_growth_days_milli: u64,
    pub(super) drought_days: u16,
    pub(super) tending_quality_milli: u16,
}

/// The derived per-day effect of an applied fertilizer (§C.4), keyed on the tile's
/// FertilizerKind and passed into the day loop. `growth_bonus_milli` scales the
/// watered-day growth increment (speed), `tending_bonus_milli` adds to per-good-day
/// tending realization (quality), `yield_bonus_milli` multiplies harvest qty
/// (read at HarvestCrop, not in the loop). NONE for an unfertilized tile.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct FertilizerEffect {
    pub(super) growth_bonus_milli: u16,
    pub(super) tending_bonus_milli: u16,
    pub(super) yield_bonus_milli: u16,
}

impl FertilizerEffect {
    pub(super) const NONE: Self = Self {
        growth_bonus_milli: 0,
        tending_bonus_milli: 0,
        yield_bonus_milli: 0,
    };
}

/// Advance ONE whole game-day (§C.1 loop body, verbatim). `sprinkler`/`rain`
/// refill moisture to full at day end and count the tile watered that day;
/// otherwise moisture decays and a dry day accrues drought + saps tending. Growth
/// only advances on a watered day, by `season_factor` milli-days (1000 in-season,
/// off_season_penalty_milli off-season), capped at maturity. Pure integer math.
pub(super) fn settle_one_game_day(
    accrual: &mut CropGrowthAccrual,
    moisture_milli: &mut u16,
    profile: &AgronomicProfile,
    fert: FertilizerEffect,
    sprinkler: bool,
    rain: bool,
    in_season_today: bool,
) {
    let maturity = maturity_milli_days(profile);
    let watered = sprinkler || rain || *moisture_milli > MOISTURE_GROWTH_THRESHOLD_MILLI;
    let season_factor: u32 = if in_season_today {
        MILLI
    } else {
        u32::from(profile.off_season_penalty_milli)
    };
    if watered {
        // §C.4 speed fertilizer scales the watered-day growth increment (+bonus%).
        let day_growth = u64::from(season_factor)
            .saturating_mul(u64::from(MILLI).saturating_add(u64::from(fert.growth_bonus_milli)))
            / u64::from(MILLI);
        accrual.accumulated_growth_days_milli = accrual
            .accumulated_growth_days_milli
            .saturating_add(day_growth)
            .min(maturity);
        accrual.drought_days = 0;
        if in_season_today {
            // §C.4 quality fertilizer lifts per-good-day tending realization.
            let tending_gain = TENDING_GOOD_DAY_DELTA.saturating_add(fert.tending_bonus_milli);
            accrual.tending_quality_milli = accrual
                .tending_quality_milli
                .saturating_add(tending_gain)
                .min(u16::try_from(MILLI).unwrap_or(u16::MAX));
        }
    } else {
        accrual.drought_days = accrual.drought_days.saturating_add(1);
        accrual.tending_quality_milli = accrual
            .tending_quality_milli
            .saturating_sub(TENDING_BAD_DAY_DELTA);
    }
    *moisture_milli = if sprinkler || rain {
        MOISTURE_FULL_MILLI
    } else {
        moisture_milli.saturating_sub(decay_per_day(profile.water_need_milli))
    };
}

/// Produce quality at harvest (§C.4): genome ceiling (quality_potential) scaled by
/// realized tending; never exceeds the ceiling. Pure; used by W5 harvest + the
/// farmPlot "quality so far" readout.
pub(super) fn produce_quality_milli(
    quality_potential_milli: u16,
    tending_quality_milli: u16,
) -> u16 {
    let scaled =
        u32::from(quality_potential_milli).saturating_mul(u32::from(tending_quality_milli)) / MILLI;
    u16::try_from(scaled)
        .unwrap_or(u16::MAX)
        .min(quality_potential_milli)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn grubroot() -> AgronomicProfile {
        // §C.8 worked example: 4-day, thirsty (1d runway), grace~4d, second cycle.
        AgronomicProfile {
            growth_days_base: 4,
            water_need_milli: 1_000,
            yield_base: 12,
            hardiness_milli: 300,
            season_affinity: 1 << 1, // Second Cycle (month index 1)
            off_season_penalty_milli: 300,
            storm_resistance_milli: 200,
            blight_resistance_milli: 400,
            regrowth_days: 0,
            tile_footprint: 1,
            quality_potential_milli: 700,
        }
    }

    fn fresh() -> CropGrowthAccrual {
        CropGrowthAccrual {
            accumulated_growth_days_milli: 0,
            drought_days: 0,
            tending_quality_milli: TENDING_START_MILLI,
        }
    }

    #[test]
    fn farm_time_dev_day_is_9000_ticks() {
        assert_eq!(ticks_per_game_day(30, 300), 9_000); // dev day-length (F-Time)
        assert_eq!(
            ticks_per_game_day(30, FARM_REAL_SECONDS_PER_GAME_DAY_PRODUCTION),
            108_000
        );
        // game-day index advances every whole day.
        assert_eq!(game_day_index_for_tick(8_999, 9_000), 0);
        assert_eq!(game_day_index_for_tick(9_000, 9_000), 1);
        assert_eq!(game_day_index_for_tick(9_000 * 4, 9_000), 4);
    }

    #[test]
    fn season_calendar_matches_six_month_year() {
        assert_eq!(month_index_for_game_day(0), 0); // First Cycle
        assert_eq!(month_index_for_game_day(30), 1); // Second Cycle
        assert_eq!(month_index_for_game_day(59), 1);
        assert_eq!(month_index_for_game_day(60), 2); // Third Cycle
        assert_eq!(month_index_for_game_day(179), 5); // Sixth Cycle
        assert_eq!(month_index_for_game_day(180), 0); // wraps to next year
        assert!(in_season(1 << 1, 1));
        assert!(!in_season(1 << 1, 2));
        assert!(!in_season(0, 3)); // no affinity => never in season
    }

    #[test]
    fn moisture_decay_matches_water_need_runway_table() {
        // §C.2 table: decay/day == water_need_milli at BASE 1000.
        assert_eq!(decay_per_day(1_000), 1_000); // 1-day runway
        assert_eq!(decay_per_day(500), 500); // 2-day
        assert_eq!(decay_per_day(250), 250); // 4-day
        assert_eq!(decay_per_day(0), 0); // never dries (cactus genome, degenerate #4)
    }

    #[test]
    fn wither_grace_scales_with_hardiness_two_to_eight() {
        assert_eq!(wither_grace_days(0), 2);
        assert_eq!(wither_grace_days(1_000), 8);
        assert_eq!(wither_grace_days(300), 3); // grubroot ~grace 3 (2 + 1)
        assert_eq!(wither_grace_days(800), 6);
    }

    #[test]
    fn growth_ideal_matures_in_growth_days_base() {
        // §C.8 #1: watered daily, in-season -> mature at growth_days_base.
        let profile = grubroot();
        let mut a = fresh();
        let mut moisture = MOISTURE_FULL_MILLI;
        for _ in 0..4 {
            settle_one_game_day(
                &mut a,
                &mut moisture,
                &profile,
                FertilizerEffect::NONE,
                true,
                false,
                true,
            );
        }
        assert!(is_mature(a.accumulated_growth_days_milli, &profile));
        assert_eq!(
            a.accumulated_growth_days_milli,
            maturity_milli_days(&profile)
        );
        assert_eq!(
            stage_for_progress(
                a.accumulated_growth_days_milli,
                maturity_milli_days(&profile)
            ),
            4
        );
        // tending climbed 4 good days from 500.
        assert_eq!(
            a.tending_quality_milli,
            TENDING_START_MILLI + 4 * TENDING_GOOD_DAY_DELTA
        );
    }

    #[test]
    fn growth_skipped_water_day_delays_by_one_not_death() {
        // §C.8 #2: one dry day pauses growth by exactly one day; no death.
        let profile = grubroot();
        let mut a = fresh();
        let mut moisture = MOISTURE_FULL_MILLI;
        // day 1 watered (sprinkler stand-in false; rely on moisture>0)
        settle_one_game_day(
            &mut a,
            &mut moisture,
            &profile,
            FertilizerEffect::NONE,
            false,
            false,
            true,
        );
        // moisture decayed to 0 (water_need 1000). day 2 dry -> pause.
        assert_eq!(moisture, 0);
        let before = a.accumulated_growth_days_milli;
        settle_one_game_day(
            &mut a,
            &mut moisture,
            &profile,
            FertilizerEffect::NONE,
            false,
            false,
            true,
        );
        assert_eq!(
            a.accumulated_growth_days_milli, before,
            "dry day pauses, no advance"
        );
        assert_eq!(a.drought_days, 1);
        // re-water -> resume from SAME progress (no loss).
        moisture = MOISTURE_FULL_MILLI;
        settle_one_game_day(
            &mut a,
            &mut moisture,
            &profile,
            FertilizerEffect::NONE,
            false,
            false,
            true,
        );
        assert_eq!(a.accumulated_growth_days_milli, before + u64::from(MILLI));
        assert_eq!(a.drought_days, 0);
    }

    #[test]
    fn growth_drought_tolerant_genome_survives_runway_plus_grace() {
        // §C.8 #3: water_need 250 (4-day runway), hardiness 800 (grace 6).
        let profile = AgronomicProfile {
            water_need_milli: 250,
            hardiness_milli: 800,
            ..grubroot()
        };
        let mut a = fresh();
        let mut moisture = MOISTURE_FULL_MILLI;
        // Water once, then never again. 4 days of runway grow (moisture>0), then dry.
        let mut grew_days = 0;
        for _ in 0..30 {
            let m_before = moisture;
            settle_one_game_day(
                &mut a,
                &mut moisture,
                &profile,
                FertilizerEffect::NONE,
                false,
                false,
                true,
            );
            if m_before > 0 {
                grew_days += 1;
            }
        }
        assert_eq!(
            grew_days, 4,
            "4-day runway of watered growth from a single fill"
        );
        // After runway (4) + grace (6) dry days it is dormant, never dead.
        assert!(is_dormant(a.drought_days, profile.hardiness_milli));
        assert!(a.accumulated_growth_days_milli > 0, "kept its progress");
    }

    #[test]
    fn growth_off_season_penalty_scales_rate() {
        // §C.8 #4: off-season penalty 300 -> 30% growth/day.
        let profile = grubroot();
        let mut a = fresh();
        let mut moisture = MOISTURE_FULL_MILLI;
        settle_one_game_day(
            &mut a,
            &mut moisture,
            &profile,
            FertilizerEffect::NONE,
            true,
            false,
            false,
        );
        assert_eq!(
            a.accumulated_growth_days_milli,
            u64::from(profile.off_season_penalty_milli),
            "off-season day advances by penalty milli (300), not full 1000"
        );
        // tending does NOT climb off-season (only in-season good days heal tending).
        assert_eq!(a.tending_quality_milli, TENDING_START_MILLI);
    }

    #[test]
    fn growth_off_season_zero_pauses_without_dormancy() {
        // §C.9 degenerate #5: penalty 0 planted off-season -> 0 growth, but a WATERED
        // day is NOT a drought day, so it never goes Dormant from season alone.
        let profile = AgronomicProfile {
            off_season_penalty_milli: 0,
            ..grubroot()
        };
        let mut a = fresh();
        let mut moisture = MOISTURE_FULL_MILLI;
        for _ in 0..20 {
            settle_one_game_day(
                &mut a,
                &mut moisture,
                &profile,
                FertilizerEffect::NONE,
                true,
                false,
                false,
            );
        }
        assert_eq!(a.accumulated_growth_days_milli, 0, "hard seasonal pause");
        assert_eq!(
            a.drought_days, 0,
            "watered => no drought => never dormant from season"
        );
        assert!(!is_dormant(a.drought_days, profile.hardiness_milli));
    }

    #[test]
    fn wither_is_dormant_and_recoverable_never_seed_loss() {
        // §C.8 #7 / F-Wither: neglect -> Dormant; one water resumes from saved progress.
        let profile = grubroot();
        let mut a = fresh();
        let mut moisture = MOISTURE_FULL_MILLI;
        // Grow 2 in-season days, then neglect a long time.
        settle_one_game_day(
            &mut a,
            &mut moisture,
            &profile,
            FertilizerEffect::NONE,
            false,
            false,
            true,
        );
        moisture = MOISTURE_FULL_MILLI;
        settle_one_game_day(
            &mut a,
            &mut moisture,
            &profile,
            FertilizerEffect::NONE,
            false,
            false,
            true,
        );
        let saved = a.accumulated_growth_days_milli;
        for _ in 0..100 {
            settle_one_game_day(
                &mut a,
                &mut moisture,
                &profile,
                FertilizerEffect::NONE,
                false,
                false,
                true,
            );
        }
        assert!(is_dormant(a.drought_days, profile.hardiness_milli));
        assert_eq!(
            a.accumulated_growth_days_milli, saved,
            "dormancy never loses progress"
        );
        // Revive: one watered day, drought resets, growth resumes.
        moisture = MOISTURE_FULL_MILLI;
        settle_one_game_day(
            &mut a,
            &mut moisture,
            &profile,
            FertilizerEffect::NONE,
            false,
            false,
            true,
        );
        assert_eq!(a.drought_days, 0);
        assert_eq!(a.accumulated_growth_days_milli, saved + u64::from(MILLI));
    }

    #[test]
    fn sprinkler_never_dries_offline_safe() {
        // §C.2: a sprinkler holds moisture full every day -> grows the whole span.
        let profile = grubroot();
        let mut a = fresh();
        let mut moisture = 0; // starts bone dry; sprinkler covers it
        for _ in 0..4 {
            settle_one_game_day(
                &mut a,
                &mut moisture,
                &profile,
                FertilizerEffect::NONE,
                true,
                false,
                true,
            );
            assert_eq!(moisture, MOISTURE_FULL_MILLI, "sprinkler refills every day");
        }
        assert!(is_mature(a.accumulated_growth_days_milli, &profile));
    }

    #[test]
    fn quality_capped_by_potential_and_scaled_by_tending() {
        // §C.4: perfect tending realizes full potential; sloppy wastes it; never exceeds.
        assert_eq!(produce_quality_milli(700, 1_000), 700);
        assert_eq!(produce_quality_milli(700, 500), 350);
        assert_eq!(produce_quality_milli(700, 0), 0); // §C.9 #3: worthless but valid
        assert_eq!(produce_quality_milli(0, 1_000), 0); // degenerate potential 0
    }

    #[test]
    fn stage_never_divides_by_zero_on_instant_crop() {
        // §C.9 degenerate: growth_days_base 0 -> maturity 0 -> reads fully mature.
        let profile = AgronomicProfile {
            growth_days_base: 0,
            ..grubroot()
        };
        assert_eq!(maturity_milli_days(&profile), 0);
        assert_eq!(stage_for_progress(0, 0), 4);
        assert!(is_mature(0, &profile));
    }
}

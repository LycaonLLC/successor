#![cfg_attr(not(test), allow(dead_code))]
#![deny(clippy::float_arithmetic)]

pub(super) const EXTRACTOR_TICK_RATE_HZ: u64 = 30;
pub(super) const EXTRACTOR_TICK_INTERVAL_TICKS: u64 = EXTRACTOR_TICK_RATE_HZ;
pub(super) const EXTRACTOR_FULL_FILL_SECONDS: u64 = 86_400;
pub(super) const EXTRACTOR_FULL_FILL_TICKS: u64 =
    EXTRACTOR_FULL_FILL_SECONDS * EXTRACTOR_TICK_INTERVAL_TICKS;

pub(super) const BASE_EXTRACTION_MILLI_PER_SEC: u32 = 1_000;
pub(super) const HOPPER_CAP_UNITS: u64 =
    EXTRACTOR_FULL_FILL_SECONDS * (BASE_EXTRACTION_MILLI_PER_SEC as u64) / 1_000;
pub(super) const HOPPER_CAP_MILLI: u64 = HOPPER_CAP_UNITS * 1_000;

pub(super) const BATTERY_MAX_RUNTIME_SECONDS: u32 = 86_400;
pub(super) const BATTERY_MIN_FRACTION_MILLI: u32 = 100;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum ExtractorStopReason {
    NoExtraction,
    HopperFull,
    BatteryDepleted,
    HopperFullAndBatteryDepleted,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct ExtractionTickAccounting {
    pub(super) hopper_milli: u64,
    pub(super) extracted_milli: u32,
    pub(super) battery_remaining_seconds: Option<u32>,
    pub(super) battery_drained_seconds: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct ExtractorAutonomyOutcome {
    pub(super) work_seconds: u32,
    pub(super) extracted_milli: u64,
    pub(super) hopper_milli: u64,
    pub(super) battery_remaining_seconds: u32,
    pub(super) battery_drained_seconds: u32,
    pub(super) stop_reason: ExtractorStopReason,
}

/// Milli-units added to the hopper per extractor-tick (= per real second).
pub(super) fn extractor_extraction_milli_per_sec(
    tool_rate_milli: u16,
    concentration_milli: u16,
) -> u32 {
    let tool = u32::from(tool_rate_milli.min(1_000));
    let concentration = u32::from(concentration_milli.min(1_000));
    concentration.saturating_mul(tool) / 1_000
}

/// Runtime seconds a crafted battery grants.
pub(super) fn battery_runtime_seconds(conductivity_milli: u16, craft_quality_milli: u16) -> u32 {
    let conductivity = u32::from(conductivity_milli.min(1_000));
    let craft_quality = u32::from(craft_quality_milli.min(1_000));
    let weighted_fraction_milli =
        (conductivity.saturating_mul(600) + craft_quality.saturating_mul(400)) / 1_000;
    let floored_fraction_milli = weighted_fraction_milli.clamp(BATTERY_MIN_FRACTION_MILLI, 1_000);
    BATTERY_MAX_RUNTIME_SECONDS.saturating_mul(floored_fraction_milli) / 1_000
}

pub(super) fn hopper_fill_work_seconds_from(
    hopper_milli: u64,
    extraction_milli_per_sec: u32,
) -> Option<u32> {
    let hopper_milli = hopper_milli.min(HOPPER_CAP_MILLI);
    let remaining_milli = HOPPER_CAP_MILLI.saturating_sub(hopper_milli);
    if remaining_milli == 0 {
        return Some(0);
    }
    if extraction_milli_per_sec == 0 {
        return None;
    }
    let rate = u64::from(extraction_milli_per_sec);
    let seconds = remaining_milli.saturating_add(rate.saturating_sub(1)) / rate;
    Some(u32::try_from(seconds).unwrap_or(u32::MAX))
}

/// Applies one extractor work tick. `battery_remaining_seconds == None` is manual power.
pub(super) fn account_extractor_tick(
    hopper_milli: u64,
    extraction_milli_per_sec: u32,
    battery_remaining_seconds: Option<u32>,
) -> ExtractionTickAccounting {
    let hopper_milli = hopper_milli.min(HOPPER_CAP_MILLI);
    let no_battery_power = battery_remaining_seconds == Some(0);
    if hopper_milli == HOPPER_CAP_MILLI || extraction_milli_per_sec == 0 || no_battery_power {
        return ExtractionTickAccounting {
            hopper_milli,
            extracted_milli: 0,
            battery_remaining_seconds,
            battery_drained_seconds: 0,
        };
    }

    let remaining_hopper_milli = HOPPER_CAP_MILLI.saturating_sub(hopper_milli);
    let extracted_milli = u64::from(extraction_milli_per_sec).min(remaining_hopper_milli);
    let battery_drained_seconds = if battery_remaining_seconds.is_some() && extracted_milli > 0 {
        1
    } else {
        0
    };
    let battery_remaining_seconds =
        battery_remaining_seconds.map(|seconds| seconds.saturating_sub(battery_drained_seconds));

    ExtractionTickAccounting {
        hopper_milli: hopper_milli.saturating_add(extracted_milli),
        extracted_milli: u32::try_from(extracted_milli).unwrap_or(u32::MAX),
        battery_remaining_seconds,
        battery_drained_seconds,
    }
}

pub(super) fn compose_extractor_bottleneck(
    hopper_milli: u64,
    extraction_milli_per_sec: u32,
    battery_runtime_seconds: u32,
) -> ExtractorAutonomyOutcome {
    let hopper_milli = hopper_milli.min(HOPPER_CAP_MILLI);
    let remaining_hopper_milli = HOPPER_CAP_MILLI.saturating_sub(hopper_milli);

    if remaining_hopper_milli == 0 {
        return ExtractorAutonomyOutcome {
            work_seconds: 0,
            extracted_milli: 0,
            hopper_milli,
            battery_remaining_seconds: battery_runtime_seconds,
            battery_drained_seconds: 0,
            stop_reason: ExtractorStopReason::HopperFull,
        };
    }
    if extraction_milli_per_sec == 0 {
        return ExtractorAutonomyOutcome {
            work_seconds: 0,
            extracted_milli: 0,
            hopper_milli,
            battery_remaining_seconds: battery_runtime_seconds,
            battery_drained_seconds: 0,
            stop_reason: ExtractorStopReason::NoExtraction,
        };
    }
    if battery_runtime_seconds == 0 {
        return ExtractorAutonomyOutcome {
            work_seconds: 0,
            extracted_milli: 0,
            hopper_milli,
            battery_remaining_seconds: 0,
            battery_drained_seconds: 0,
            stop_reason: ExtractorStopReason::BatteryDepleted,
        };
    }

    let seconds_to_fill =
        hopper_fill_work_seconds_from(hopper_milli, extraction_milli_per_sec).unwrap_or(u32::MAX);
    let work_seconds = battery_runtime_seconds.min(seconds_to_fill);
    let extracted_milli = u64::from(extraction_milli_per_sec)
        .saturating_mul(u64::from(work_seconds))
        .min(remaining_hopper_milli);
    let hopper_milli = hopper_milli.saturating_add(extracted_milli);
    let battery_remaining_seconds = battery_runtime_seconds.saturating_sub(work_seconds);
    let stop_reason = match (
        hopper_milli == HOPPER_CAP_MILLI,
        battery_remaining_seconds == 0,
    ) {
        (true, true) => ExtractorStopReason::HopperFullAndBatteryDepleted,
        (true, false) => ExtractorStopReason::HopperFull,
        (false, true) => ExtractorStopReason::BatteryDepleted,
        (false, false) => ExtractorStopReason::NoExtraction,
    };

    ExtractorAutonomyOutcome {
        work_seconds,
        extracted_milli,
        hopper_milli,
        battery_remaining_seconds,
        battery_drained_seconds: work_seconds,
        stop_reason,
    }
}

pub(super) fn compose_extractor_bottleneck_from_components(
    tool_rate_milli: u16,
    concentration_milli: u16,
    battery_conductivity_milli: u16,
    battery_craft_quality_milli: u16,
) -> ExtractorAutonomyOutcome {
    compose_extractor_bottleneck(
        0,
        extractor_extraction_milli_per_sec(tool_rate_milli, concentration_milli),
        battery_runtime_seconds(battery_conductivity_milli, battery_craft_quality_milli),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn assert_outcome_units(outcome: ExtractorAutonomyOutcome, expected_units: u64) {
        assert_eq!(outcome.extracted_milli, expected_units * 1_000);
        assert_eq!(outcome.hopper_milli, expected_units * 1_000);
    }

    #[test]
    fn extractor_rate_best_full_is_one_unit_per_second() {
        assert_eq!(
            extractor_extraction_milli_per_sec(1_000, 1_000),
            BASE_EXTRACTION_MILLI_PER_SEC
        );
    }

    #[test]
    fn extractor_rate_half_conc_and_half_tool_each_halve() {
        assert_eq!(extractor_extraction_milli_per_sec(500, 1_000), 500);
        assert_eq!(extractor_extraction_milli_per_sec(1_000, 500), 500);
        assert_eq!(extractor_extraction_milli_per_sec(500, 500), 250);
    }

    #[test]
    fn extractor_rate_is_zero_when_conc_zero() {
        assert_eq!(extractor_extraction_milli_per_sec(1_000, 0), 0);
    }

    #[test]
    fn extractor_rate_monotonic_in_tool_and_conc() {
        let mut previous_for_tool = 0;
        for tool in (0..=1_000).step_by(25) {
            let rate = extractor_extraction_milli_per_sec(tool, 750);
            assert!(rate >= previous_for_tool);
            previous_for_tool = rate;
        }

        let mut previous_for_concentration = 0;
        for concentration in (0..=1_000).step_by(25) {
            let rate = extractor_extraction_milli_per_sec(750, concentration);
            assert!(rate >= previous_for_concentration);
            previous_for_concentration = rate;
        }
    }

    #[test]
    fn extractor_rate_is_player_independent() {
        let baseline = extractor_extraction_milli_per_sec(640, 875);
        for ignored_actor_stat in [0_u16, 250, 500, 1_000] {
            for ignored_profession_bonus in [0_u16, 1_000, 1_500] {
                let _ignored = (ignored_actor_stat, ignored_profession_bonus);
                assert_eq!(extractor_extraction_milli_per_sec(640, 875), baseline);
            }
        }
    }

    #[test]
    fn hopper_best_full_fills_in_exactly_extractor_full_fill_seconds() {
        assert_eq!(EXTRACTOR_TICK_RATE_HZ, 30);
        assert_eq!(EXTRACTOR_TICK_INTERVAL_TICKS, 30);
        assert_eq!(EXTRACTOR_FULL_FILL_SECONDS, 86_400);
        assert_eq!(EXTRACTOR_FULL_FILL_TICKS, 2_592_000);
        assert_eq!(HOPPER_CAP_UNITS, 86_400);
        assert_eq!(HOPPER_CAP_MILLI, 86_400_000);
        assert_eq!(
            hopper_fill_work_seconds_from(0, BASE_EXTRACTION_MILLI_PER_SEC),
            Some(u32::try_from(EXTRACTOR_FULL_FILL_SECONDS).unwrap())
        );
    }

    #[test]
    fn hopper_never_exceeds_cap() {
        let near_full = account_extractor_tick(HOPPER_CAP_MILLI - 10, 1_000, None);
        assert_eq!(near_full.hopper_milli, HOPPER_CAP_MILLI);
        assert_eq!(near_full.extracted_milli, 10);

        let overfull = account_extractor_tick(HOPPER_CAP_MILLI + 1_000, 1_000, None);
        assert_eq!(overfull.hopper_milli, HOPPER_CAP_MILLI);
        assert_eq!(overfull.extracted_milli, 0);
    }

    #[test]
    fn battery_best_is_24h_runtime() {
        assert_eq!(battery_runtime_seconds(1_000, 1_000), 86_400);
        assert_eq!(battery_runtime_seconds(1_001, 1_001), 86_400);
    }

    #[test]
    fn battery_floor_respected_and_monotonic() {
        assert_eq!(battery_runtime_seconds(0, 0), 8_640);
        assert_eq!(battery_runtime_seconds(10, 10), 8_640);

        let mut previous_for_conductivity = battery_runtime_seconds(0, 500);
        for conductivity in (25..=1_000).step_by(25) {
            let runtime = battery_runtime_seconds(conductivity, 500);
            assert!(runtime >= previous_for_conductivity);
            previous_for_conductivity = runtime;
        }

        let mut previous_for_craft = battery_runtime_seconds(500, 0);
        for craft_quality in (25..=1_000).step_by(25) {
            let runtime = battery_runtime_seconds(500, craft_quality);
            assert!(runtime >= previous_for_craft);
            previous_for_craft = runtime;
        }
    }

    #[test]
    fn battery_copper_beats_iron_expected_runtime() {
        let copper_expected_conductivity = 750;
        let iron_expected_conductivity = 625;
        let craft_quality = 500;
        assert_eq!(
            battery_runtime_seconds(copper_expected_conductivity, craft_quality),
            56_160
        );
        assert_eq!(
            battery_runtime_seconds(iron_expected_conductivity, craft_quality),
            49_680
        );
        assert!(
            battery_runtime_seconds(copper_expected_conductivity, craft_quality)
                > battery_runtime_seconds(iron_expected_conductivity, craft_quality)
        );
    }

    #[test]
    fn autonomy_all_100_hopper_full_as_battery_dies() {
        let outcome = compose_extractor_bottleneck_from_components(1_000, 1_000, 1_000, 1_000);
        assert_eq!(outcome.work_seconds, 86_400);
        assert_eq!(outcome.battery_drained_seconds, 86_400);
        assert_eq!(outcome.battery_remaining_seconds, 0);
        assert_eq!(
            outcome.stop_reason,
            ExtractorStopReason::HopperFullAndBatteryDepleted
        );
        assert_outcome_units(outcome, 86_400);
    }

    #[test]
    fn autonomy_poor_battery_stops_early_partial_hopper() {
        let outcome = compose_extractor_bottleneck_from_components(1_000, 1_000, 300, 400);
        assert_eq!(battery_runtime_seconds(300, 400), 29_376);
        assert_eq!(outcome.work_seconds, 29_376);
        assert_eq!(outcome.battery_remaining_seconds, 0);
        assert_eq!(outcome.stop_reason, ExtractorStopReason::BatteryDepleted);
        assert_outcome_units(outcome, 29_376);
    }

    #[test]
    fn autonomy_poor_tool_full_runtime_half_hopper() {
        let outcome = compose_extractor_bottleneck_from_components(500, 1_000, 1_000, 1_000);
        assert_eq!(extractor_extraction_milli_per_sec(500, 1_000), 500);
        assert_eq!(outcome.work_seconds, 86_400);
        assert_eq!(outcome.battery_remaining_seconds, 0);
        assert_eq!(outcome.stop_reason, ExtractorStopReason::BatteryDepleted);
        assert_outcome_units(outcome, 43_200);
    }

    #[test]
    fn autonomy_barren_cell_preserves_battery() {
        let outcome = compose_extractor_bottleneck_from_components(1_000, 0, 1_000, 1_000);
        assert_eq!(outcome.work_seconds, 0);
        assert_eq!(outcome.extracted_milli, 0);
        assert_eq!(outcome.hopper_milli, 0);
        assert_eq!(outcome.battery_remaining_seconds, 86_400);
        assert_eq!(outcome.battery_drained_seconds, 0);
        assert_eq!(outcome.stop_reason, ExtractorStopReason::NoExtraction);
    }

    #[test]
    fn autonomy_poor_concentration_full_runtime_quarter_hopper() {
        let outcome = compose_extractor_bottleneck_from_components(1_000, 250, 1_000, 1_000);
        assert_eq!(extractor_extraction_milli_per_sec(1_000, 250), 250);
        assert_eq!(outcome.work_seconds, 86_400);
        assert_eq!(outcome.battery_remaining_seconds, 0);
        assert_eq!(outcome.stop_reason, ExtractorStopReason::BatteryDepleted);
        assert_outcome_units(outcome, 21_600);
    }

    #[test]
    fn autonomy_compound_bottleneck_matches_table() {
        let outcome = compose_extractor_bottleneck_from_components(500, 500, 800, 700);
        assert_eq!(extractor_extraction_milli_per_sec(500, 500), 250);
        assert_eq!(battery_runtime_seconds(800, 700), 65_664);
        assert_eq!(outcome.work_seconds, 65_664);
        assert_eq!(outcome.battery_remaining_seconds, 0);
        assert_eq!(outcome.stop_reason, ExtractorStopReason::BatteryDepleted);
        assert_outcome_units(outcome, 16_416);
    }

    #[test]
    fn extractor_degenerate_barren_cell_preserves_battery() {
        let tick = account_extractor_tick(0, 0, Some(123));
        assert_eq!(tick.hopper_milli, 0);
        assert_eq!(tick.extracted_milli, 0);
        assert_eq!(tick.battery_remaining_seconds, Some(123));
        assert_eq!(tick.battery_drained_seconds, 0);
    }

    #[test]
    fn extractor_degenerate_zero_tool_preserves_battery() {
        let rate = extractor_extraction_milli_per_sec(0, 1_000);
        let tick = account_extractor_tick(0, rate, Some(123));
        assert_eq!(rate, 0);
        assert_eq!(tick.hopper_milli, 0);
        assert_eq!(tick.battery_remaining_seconds, Some(123));
        assert_eq!(tick.battery_drained_seconds, 0);
    }

    #[test]
    fn extractor_degenerate_full_hopper_stops_without_drain() {
        let tick = account_extractor_tick(HOPPER_CAP_MILLI, 1_000, Some(123));
        assert_eq!(tick.hopper_milli, HOPPER_CAP_MILLI);
        assert_eq!(tick.extracted_milli, 0);
        assert_eq!(tick.battery_remaining_seconds, Some(123));
        assert_eq!(tick.battery_drained_seconds, 0);
    }

    #[test]
    fn extractor_degenerate_dead_battery_stops_but_manual_still_works() {
        let battery_tick = account_extractor_tick(0, 1_000, Some(0));
        assert_eq!(battery_tick.hopper_milli, 0);
        assert_eq!(battery_tick.extracted_milli, 0);
        assert_eq!(battery_tick.battery_remaining_seconds, Some(0));

        let manual_tick = account_extractor_tick(0, 1_000, None);
        assert_eq!(manual_tick.hopper_milli, 1_000);
        assert_eq!(manual_tick.extracted_milli, 1_000);
        assert_eq!(manual_tick.battery_remaining_seconds, None);
    }

    #[test]
    fn extractor_degenerate_inputs_above_one_thousand_are_clamped() {
        assert_eq!(extractor_extraction_milli_per_sec(1_200, 1_000), 1_000);
        assert_eq!(extractor_extraction_milli_per_sec(1_000, 1_200), 1_000);
        assert_eq!(extractor_extraction_milli_per_sec(1_200, 1_200), 1_000);
        assert_eq!(battery_runtime_seconds(1_200, 1_200), 86_400);
    }

    #[test]
    fn battery_degenerate_quality_floor_prevents_zero_second_duds() {
        assert_eq!(battery_runtime_seconds(0, 0), 8_640);
        assert_eq!(battery_runtime_seconds(1, 0), 8_640);
        assert_eq!(battery_runtime_seconds(0, 1), 8_640);
    }

    #[test]
    fn extractor_degenerate_integer_truncation_is_deterministic() {
        assert_eq!(extractor_extraction_milli_per_sec(999, 999), 998);
        assert_eq!(battery_runtime_seconds(999, 998), 86_227);
        let outcome = compose_extractor_bottleneck(0, 998, 86_227);
        assert_eq!(outcome.work_seconds, 86_227);
        assert_eq!(outcome.extracted_milli, 86_054_546);
        assert_eq!(outcome.hopper_milli, 86_054_546);
        assert_eq!(outcome.stop_reason, ExtractorStopReason::BatteryDepleted);
    }
}

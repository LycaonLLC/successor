#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct TacticalManeuverRequest<'a> {
    pub(crate) reason: &'a str,
    pub(crate) under_fire: bool,
    pub(crate) base_step_milli: i32,
}

pub(crate) fn committed_evasion_step_milli(base_step_milli: i32, prefer_evasion: bool) -> i32 {
    if !prefer_evasion {
        return base_step_milli;
    }
    base_step_milli
        .saturating_mul(9)
        .saturating_div(4)
        .max(base_step_milli.saturating_add(2_400))
}

pub(crate) fn tactical_min_reposition_milli(
    base_min_reposition_milli: i32,
    prefer_evasion: bool,
) -> i32 {
    if prefer_evasion {
        base_min_reposition_milli.max(3_200)
    } else {
        base_min_reposition_milli
    }
}

pub(crate) fn tactical_maneuver_step_milli(request: TacticalManeuverRequest<'_>) -> i32 {
    if !request.under_fire || !reason_is_committed_maneuver(request.reason) {
        return request.base_step_milli;
    }
    request
        .base_step_milli
        .saturating_mul(14)
        .saturating_div(10)
        .max(request.base_step_milli.saturating_add(90))
}

fn reason_is_committed_maneuver(reason: &str) -> bool {
    matches!(
        reason,
        "evasion"
            | "retreat"
            | "home"
            | "flank"
            | "high_cover"
            | "soft_cover"
            | "firing_lane"
            | "peek_lane"
            | "local_peek_lane"
            | "melee_advance"
            | "melee_disengage"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn committed_evasion_uses_deeper_candidate_distance() {
        assert_eq!(committed_evasion_step_milli(2_400, false), 2_400);
        assert!(committed_evasion_step_milli(2_400, true) >= 5_400);
    }

    #[test]
    fn under_fire_maneuver_steps_are_faster_for_tactical_moves() {
        assert_eq!(
            tactical_maneuver_step_milli(TacticalManeuverRequest {
                reason: "holding_cover",
                under_fire: true,
                base_step_milli: 180,
            }),
            180
        );
        assert!(
            tactical_maneuver_step_milli(TacticalManeuverRequest {
                reason: "evasion",
                under_fire: true,
                base_step_milli: 180,
            }) > 180
        );
        assert!(
            tactical_maneuver_step_milli(TacticalManeuverRequest {
                reason: "evasion",
                under_fire: true,
                base_step_milli: 218,
            }) <= 310
        );
        assert!(
            tactical_maneuver_step_milli(TacticalManeuverRequest {
                reason: "melee_advance",
                under_fire: true,
                base_step_milli: 180,
            }) > 180
        );
    }
}

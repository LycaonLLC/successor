use super::behavior::{TacticalEngagementPolicy, TacticalStageKind};

const CRITICAL_FORCE_DISADVANTAGE_MILLI: i32 = 700;
const CAUTIOUS_FORCE_DISADVANTAGE_MILLI: i32 = 900;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CombatPosture {
    Hold,
    Pressure,
    Regroup,
    Withdraw,
}

impl CombatPosture {
    pub(crate) const fn label(self) -> &'static str {
        match self {
            Self::Hold => "hold",
            Self::Pressure => "pressure",
            Self::Regroup => "regroup",
            Self::Withdraw => "withdraw",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CombatSquadOrderHint {
    None,
    Retreat,
    Defend,
    Advance,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CombatSituationSnapshot {
    pub(crate) posture: CombatPosture,
    pub(crate) local_force_ratio_milli: i32,
    pub(crate) incoming_pressure_milli: i32,
    pub(crate) cover_readiness_milli: i32,
    pub(crate) cohesion_milli: i32,
    pub(crate) isolation_risk_milli: i32,
    pub(crate) resource_risk_milli: i32,
    pub(crate) stall_ticks: u64,
    pub(crate) reasons: Vec<&'static str>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct CombatSituationRequest {
    pub(crate) friendly_strength_milli: i32,
    pub(crate) enemy_strength_milli: i32,
    pub(crate) health_percent_milli: i32,
    pub(crate) suppression_pressure_milli: i32,
    pub(crate) cover_pressure_milli: i32,
    pub(crate) incoming_fire: bool,
    pub(crate) recently_damaged: bool,
    pub(crate) has_current_shot: bool,
    pub(crate) protected_by_cover: bool,
    pub(crate) squad_order: CombatSquadOrderHint,
    pub(crate) distance_to_squad_center_milli: i32,
    pub(crate) squad_cohesion_radius_milli: i32,
    pub(crate) nearby_friendly_count: usize,
    pub(crate) nearby_hostile_count: usize,
    pub(crate) stalled_ticks: u64,
}

pub(crate) fn assess_combat_situation(request: CombatSituationRequest) -> CombatSituationSnapshot {
    let local_force_ratio_milli = force_ratio_milli(
        request.friendly_strength_milli,
        request.enemy_strength_milli,
    );
    let incoming_pressure_milli = incoming_pressure_milli(request);
    let cover_readiness_milli = cover_readiness_milli(request);
    let cohesion_milli = cohesion_milli(request);
    let isolation_risk_milli = isolation_risk_milli(request, cohesion_milli);
    let resource_risk_milli = resource_risk_milli(request);
    let posture = classify_posture(
        request,
        local_force_ratio_milli,
        incoming_pressure_milli,
        cohesion_milli,
        isolation_risk_milli,
        resource_risk_milli,
    );
    let reasons = situation_reasons(
        request,
        local_force_ratio_milli,
        incoming_pressure_milli,
        isolation_risk_milli,
        resource_risk_milli,
    );

    CombatSituationSnapshot {
        posture,
        local_force_ratio_milli,
        incoming_pressure_milli,
        cover_readiness_milli,
        cohesion_milli,
        isolation_risk_milli,
        resource_risk_milli,
        stall_ticks: request.stalled_ticks,
        reasons,
    }
}

pub(crate) fn tactical_policy_for_combat_situation(
    mut policy: TacticalEngagementPolicy,
    situation: &CombatSituationSnapshot,
) -> TacticalEngagementPolicy {
    match situation.posture {
        CombatPosture::Pressure => {
            policy.prefer_evasion = false;
            policy.cover_required = false;
            policy.allow_flank = policy.allow_flank && policy.allow_offensive_maneuver;
        }
        CombatPosture::Hold => {
            let force_disadvantage =
                situation.local_force_ratio_milli < CAUTIOUS_FORCE_DISADVANTAGE_MILLI;
            policy.prefer_cover = policy.prefer_cover
                || situation.incoming_pressure_milli >= 500
                || force_disadvantage;
            if force_disadvantage {
                policy.allow_offensive_maneuver = false;
                policy.allow_flank = false;
            }
        }
        CombatPosture::Regroup => {
            policy.prefer_cover = true;
            policy.prefer_evasion = situation.incoming_pressure_milli >= 650;
            policy.allow_offensive_maneuver = false;
            policy.allow_flank = false;
        }
        CombatPosture::Withdraw => {
            policy.require_shot = false;
            policy.prefer_cover = true;
            policy.cover_required = false;
            policy.prefer_evasion = true;
            policy.allow_offensive_maneuver = false;
            policy.allow_flank = false;
            policy.allow_retreat = true;
        }
    }
    policy
}

pub(crate) fn tactical_situation_stage_score_bias(
    situation: &CombatSituationSnapshot,
    stage: TacticalStageKind,
) -> i64 {
    let posture_bias = match situation.posture {
        CombatPosture::Pressure => match stage {
            TacticalStageKind::FiringLane => 6_500,
            TacticalStageKind::AdvanceLine => 3_500,
            TacticalStageKind::Flank => 2_500,
            TacticalStageKind::GoodCover | TacticalStageKind::SoftCover => 1_500,
            TacticalStageKind::Evasion => -4_000,
            TacticalStageKind::Retreat => -6_000,
        },
        CombatPosture::Hold => match stage {
            TacticalStageKind::GoodCover => 3_500,
            TacticalStageKind::FiringLane => 2_500,
            TacticalStageKind::SoftCover => 1_500,
            TacticalStageKind::AdvanceLine | TacticalStageKind::Flank => 0,
            TacticalStageKind::Evasion => -1_000,
            TacticalStageKind::Retreat => -2_500,
        },
        CombatPosture::Regroup => match stage {
            TacticalStageKind::GoodCover => 3_500,
            TacticalStageKind::SoftCover => 3_000,
            TacticalStageKind::Evasion => 1_500,
            TacticalStageKind::Retreat => 1_000,
            TacticalStageKind::FiringLane => 500,
            TacticalStageKind::AdvanceLine => -3_000,
            TacticalStageKind::Flank => -2_500,
        },
        CombatPosture::Withdraw => match stage {
            TacticalStageKind::Retreat => 12_000,
            TacticalStageKind::Evasion => 7_000,
            TacticalStageKind::GoodCover => 3_500,
            TacticalStageKind::SoftCover => 2_000,
            TacticalStageKind::FiringLane => -2_500,
            TacticalStageKind::Flank => -8_000,
            TacticalStageKind::AdvanceLine => -9_000,
        },
    };
    let pressure_bias = if situation.incoming_pressure_milli >= 700 {
        match stage {
            TacticalStageKind::GoodCover | TacticalStageKind::Evasion => 2_000,
            TacticalStageKind::SoftCover => 1_000,
            _ => 0,
        }
    } else {
        0
    };
    let resource_bias = if situation.resource_risk_milli >= 800 {
        match stage {
            TacticalStageKind::Retreat | TacticalStageKind::GoodCover => 1_000,
            TacticalStageKind::AdvanceLine | TacticalStageKind::Flank => -1_500,
            _ => 0,
        }
    } else {
        0
    };
    i64::from(posture_bias + pressure_bias + resource_bias)
}

fn classify_posture(
    request: CombatSituationRequest,
    local_force_ratio_milli: i32,
    incoming_pressure_milli: i32,
    cohesion_milli: i32,
    isolation_risk_milli: i32,
    resource_risk_milli: i32,
) -> CombatPosture {
    let low_health_under_pressure =
        request.health_percent_milli <= 350 && incoming_pressure_milli >= 500;
    let squad_retreat = request.squad_order == CombatSquadOrderHint::Retreat;
    let badly_outnumbered = local_force_ratio_milli < CRITICAL_FORCE_DISADVANTAGE_MILLI;
    let survival_withdrawal = low_health_under_pressure
        || (request.health_percent_milli <= 550
            && incoming_pressure_milli >= 750
            && (squad_retreat || badly_outnumbered)
            && !request.protected_by_cover);
    if survival_withdrawal {
        return CombatPosture::Withdraw;
    }

    if isolation_risk_milli >= 750 || (cohesion_milli < 350 && request.nearby_friendly_count > 0) {
        return CombatPosture::Regroup;
    }

    if local_force_ratio_milli >= 1_250
        && request.has_current_shot
        && incoming_pressure_milli < 650
        && resource_risk_milli < 600
    {
        return CombatPosture::Pressure;
    }

    CombatPosture::Hold
}

fn force_ratio_milli(friendly_strength_milli: i32, enemy_strength_milli: i32) -> i32 {
    if enemy_strength_milli <= 0 {
        return 2_000;
    }
    let ratio = i64::from(friendly_strength_milli.max(0)).saturating_mul(1_000)
        / i64::from(enemy_strength_milli.max(1));
    ratio.clamp(0, 2_000) as i32
}

fn incoming_pressure_milli(request: CombatSituationRequest) -> i32 {
    let cover_pressure = request.cover_pressure_milli.max(1);
    let suppression = i64::from(request.suppression_pressure_milli.max(0)).saturating_mul(1_000)
        / i64::from(cover_pressure);
    let event_pressure = if request.incoming_fire { 350 } else { 0 }
        + if request.recently_damaged { 250 } else { 0 };
    (suppression as i32)
        .saturating_add(event_pressure)
        .clamp(0, 1_000)
}

fn cover_readiness_milli(request: CombatSituationRequest) -> i32 {
    if request.protected_by_cover {
        1_000
    } else if request.has_current_shot {
        450
    } else {
        250
    }
}

fn cohesion_milli(request: CombatSituationRequest) -> i32 {
    let radius = request.squad_cohesion_radius_milli.max(1);
    let distance = request.distance_to_squad_center_milli.max(0);
    (1_000_i64 - i64::from(distance).saturating_mul(1_000) / i64::from(radius)).clamp(0, 1_000)
        as i32
}

fn isolation_risk_milli(request: CombatSituationRequest, cohesion_milli: i32) -> i32 {
    let mut risk = 1_000_i32.saturating_sub(cohesion_milli);
    if request.nearby_hostile_count > 0 && request.nearby_friendly_count == 0 {
        risk = risk.max(850);
    } else if request.nearby_hostile_count > request.nearby_friendly_count.saturating_mul(2) {
        risk = risk.max(650);
    }
    risk.clamp(0, 1_000)
}

fn resource_risk_milli(request: CombatSituationRequest) -> i32 {
    match request.health_percent_milli {
        ..=300 => 950,
        301..=500 => 650,
        501..=700 => 250,
        _ => 0,
    }
}

fn situation_reasons(
    request: CombatSituationRequest,
    local_force_ratio_milli: i32,
    incoming_pressure_milli: i32,
    isolation_risk_milli: i32,
    resource_risk_milli: i32,
) -> Vec<&'static str> {
    let mut reasons = Vec::new();
    if local_force_ratio_milli >= 1_250 {
        reasons.push("force_advantage");
    } else if local_force_ratio_milli < CRITICAL_FORCE_DISADVANTAGE_MILLI {
        reasons.push("outnumbered");
    } else if local_force_ratio_milli < CAUTIOUS_FORCE_DISADVANTAGE_MILLI {
        reasons.push("force_disadvantage");
    }
    if incoming_pressure_milli >= 650 {
        reasons.push("under_pressure");
    }
    if request.health_percent_milli <= 500 {
        reasons.push("low_health");
    }
    if isolation_risk_milli >= 750 {
        reasons.push("isolated");
    }
    if resource_risk_milli >= 800 {
        reasons.push("resource_risk");
    }
    if request.protected_by_cover {
        reasons.push("protected");
    }
    if request.has_current_shot {
        reasons.push("firing_lane");
    }
    match request.squad_order {
        CombatSquadOrderHint::Retreat => reasons.push("squad_retreat"),
        CombatSquadOrderHint::Defend => reasons.push("squad_defend"),
        CombatSquadOrderHint::Advance => reasons.push("squad_advance"),
        CombatSquadOrderHint::None => {}
    }
    if request.stalled_ticks >= 45 {
        reasons.push("no_progress");
    }
    reasons
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base_request() -> CombatSituationRequest {
        CombatSituationRequest {
            friendly_strength_milli: 2_000,
            enemy_strength_milli: 2_000,
            health_percent_milli: 1_000,
            suppression_pressure_milli: 0,
            cover_pressure_milli: 20_000,
            incoming_fire: false,
            recently_damaged: false,
            has_current_shot: false,
            protected_by_cover: false,
            squad_order: CombatSquadOrderHint::Defend,
            distance_to_squad_center_milli: 1_000,
            squad_cohesion_radius_milli: 6_000,
            nearby_friendly_count: 1,
            nearby_hostile_count: 1,
            stalled_ticks: 0,
        }
    }

    #[test]
    fn covered_advantage_with_firing_lane_pressures() {
        let situation = assess_combat_situation(CombatSituationRequest {
            friendly_strength_milli: 4_000,
            enemy_strength_milli: 2_000,
            has_current_shot: true,
            protected_by_cover: true,
            squad_order: CombatSquadOrderHint::Advance,
            ..base_request()
        });

        assert_eq!(situation.posture, CombatPosture::Pressure);
        assert!(situation.reasons.contains(&"force_advantage"));
        assert!(situation.reasons.contains(&"firing_lane"));
    }

    #[test]
    fn outnumbered_exposed_pawn_does_not_pressure() {
        let situation = assess_combat_situation(CombatSituationRequest {
            friendly_strength_milli: 1_000,
            enemy_strength_milli: 3_000,
            has_current_shot: true,
            incoming_fire: true,
            suppression_pressure_milli: 10_000,
            ..base_request()
        });

        assert_eq!(situation.posture, CombatPosture::Hold);
        assert!(situation.reasons.contains(&"outnumbered"));
    }

    #[test]
    fn outnumbered_before_contact_holds_instead_of_pushing() {
        let situation = assess_combat_situation(CombatSituationRequest {
            friendly_strength_milli: 2_000,
            enemy_strength_milli: 5_000,
            has_current_shot: false,
            incoming_fire: false,
            recently_damaged: false,
            suppression_pressure_milli: 0,
            ..base_request()
        });

        assert_eq!(situation.posture, CombatPosture::Hold);
        assert_eq!(situation.incoming_pressure_milli, 0);
        assert!(situation.reasons.contains(&"outnumbered"));
    }

    #[test]
    fn hurt_outnumbered_exposed_pawn_can_withdraw_for_survival() {
        let situation = assess_combat_situation(CombatSituationRequest {
            friendly_strength_milli: 1_000,
            enemy_strength_milli: 3_000,
            health_percent_milli: 500,
            incoming_fire: true,
            recently_damaged: true,
            suppression_pressure_milli: 20_000,
            protected_by_cover: false,
            squad_order: CombatSquadOrderHint::Retreat,
            ..base_request()
        });

        assert_eq!(situation.posture, CombatPosture::Withdraw);
        assert!(situation.reasons.contains(&"outnumbered"));
        assert!(situation.reasons.contains(&"under_pressure"));
        assert!(situation.reasons.contains(&"low_health"));
    }

    #[test]
    fn disadvantaged_hold_blocks_offensive_maneuvers() {
        let policy = TacticalEngagementPolicy {
            require_shot: true,
            prefer_cover: false,
            cover_required: false,
            prefer_evasion: false,
            allow_offensive_maneuver: true,
            allow_flank: true,
            allow_retreat: false,
        };
        let situation = CombatSituationSnapshot {
            posture: CombatPosture::Hold,
            local_force_ratio_milli: 800,
            incoming_pressure_milli: 0,
            cover_readiness_milli: 250,
            cohesion_milli: 900,
            isolation_risk_milli: 0,
            resource_risk_milli: 0,
            stall_ticks: 0,
            reasons: vec!["force_disadvantage"],
        };

        let adjusted = tactical_policy_for_combat_situation(policy, &situation);
        assert!(adjusted.prefer_cover);
        assert!(!adjusted.allow_offensive_maneuver);
        assert!(!adjusted.allow_flank);
    }

    #[test]
    fn isolated_pawn_regroups_before_holding() {
        let situation = assess_combat_situation(CombatSituationRequest {
            distance_to_squad_center_milli: 9_000,
            squad_cohesion_radius_milli: 6_000,
            nearby_friendly_count: 0,
            nearby_hostile_count: 1,
            ..base_request()
        });

        assert_eq!(situation.posture, CombatPosture::Regroup);
        assert!(situation.isolation_risk_milli >= 750);
    }

    #[test]
    fn withdraw_policy_enables_retreat_and_evasion() {
        let policy = TacticalEngagementPolicy {
            require_shot: true,
            prefer_cover: false,
            cover_required: true,
            prefer_evasion: false,
            allow_offensive_maneuver: true,
            allow_flank: true,
            allow_retreat: false,
        };
        let situation = CombatSituationSnapshot {
            posture: CombatPosture::Withdraw,
            local_force_ratio_milli: 500,
            incoming_pressure_milli: 900,
            cover_readiness_milli: 250,
            cohesion_milli: 400,
            isolation_risk_milli: 600,
            resource_risk_milli: 0,
            stall_ticks: 0,
            reasons: vec!["outnumbered"],
        };

        let adjusted = tactical_policy_for_combat_situation(policy, &situation);
        assert!(!adjusted.require_shot);
        assert!(adjusted.prefer_cover);
        assert!(adjusted.prefer_evasion);
        assert!(!adjusted.allow_offensive_maneuver);
        assert!(!adjusted.allow_flank);
        assert!(adjusted.allow_retreat);
    }

    #[test]
    fn stage_bias_matches_readable_postures() {
        let situation = CombatSituationSnapshot {
            posture: CombatPosture::Pressure,
            local_force_ratio_milli: 1_600,
            incoming_pressure_milli: 0,
            cover_readiness_milli: 450,
            cohesion_milli: 900,
            isolation_risk_milli: 100,
            resource_risk_milli: 0,
            stall_ticks: 0,
            reasons: vec![],
        };

        assert!(
            tactical_situation_stage_score_bias(&situation, TacticalStageKind::FiringLane)
                > tactical_situation_stage_score_bias(&situation, TacticalStageKind::Evasion)
        );
    }
}

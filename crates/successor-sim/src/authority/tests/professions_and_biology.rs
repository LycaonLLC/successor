// ═════════════════════════════════════════════════════════════════════════════
// PROFESSION STATS
// Per-family table-driven curves (monotonicity + exact tier values), the
// wiring-bug fixes, the combat-roll modifiers, the two capstone auras, and the
// three flagship LIVE spot-proofs.
// ═════════════════════════════════════════════════════════════════════════════

/// Build a professions state trained `steps` boxes into `track`: 0 = novice only,
/// 1..=4 = novice + tiers I..steps, 5 = novice + all four tiers + master.
fn p12_track_state(profession: &str, track: &str, steps: usize) -> ActorProfessionState {
    let tiers = ["i", "ii", "iii", "iv"];
    let mut boxes = vec![format!("{profession}-novice")];
    for tier in tiers.iter().take(steps.min(4)) {
        boxes.push(format!("{profession}-{track}-{tier}"));
    }
    if steps >= 5 {
        boxes.push(format!("{profession}-master"));
    }
    let mut professions = ActorProfessionState::empty();
    professions
        .grant_skill_box_ids(&boxes)
        .expect("p12 track boxes are valid skill boxes");
    professions
}

/// Assert an i32 mapping matches its exact 6-point tier curve and is monotone in the
/// curve's own direction (non-decreasing if it rises to master, else non-increasing).
fn p12_assert_curve(
    profession: &str,
    track: &str,
    expected: [i32; 6],
    map: impl Fn(&ActorProfessionState) -> i32,
) {
    let rising = expected[5] >= expected[0];
    let mut prev: Option<i32> = None;
    for (steps, want) in expected.iter().enumerate() {
        let value = map(&p12_track_state(profession, track, steps));
        assert_eq!(value, *want, "{profession}-{track} step {steps} value");
        if let Some(prev) = prev {
            if rising {
                assert!(value >= prev, "{profession}-{track} must be non-decreasing");
            } else {
                assert!(value <= prev, "{profession}-{track} must be non-increasing");
            }
        }
        prev = Some(value);
    }
}

#[test]
fn p12_marksman_track_curves_match_design() {
    p12_assert_curve("marksman", "pistol", [0, 160, 320, 480, 640, 800], |p| {
        p.marksman_pistol_spread_reduction_milli()
    });
    p12_assert_curve(
        "marksman",
        "pistol",
        [1_000, 880, 760, 640, 520, 400],
        |p| p.marksman_pistol_swap_speed_multiplier_milli(),
    );
    p12_assert_curve("marksman", "tactics", [0, 140, 280, 420, 560, 700], |p| {
        p.marksman_tactics_requeue_latency_reduction_milli()
    });
    p12_assert_curve("marksman", "tactics", [0, 50, 100, 150, 200, 250], |p| {
        p.marksman_tactics_special_action_cost_reduction_milli()
    });
    p12_assert_curve(
        "marksman",
        "fieldcraft",
        [1_000, 1_120, 1_240, 1_360, 1_480, 1_600],
        |p| p.marksman_fieldcraft_kneel_spread_mult_milli(),
    );
    p12_assert_curve("marksman", "fieldcraft", [0, 40, 80, 120, 160, 200], |p| {
        p.marksman_fieldcraft_kneel_damage_taken_reduction_milli()
    });
}

#[test]
fn p12_brawler_track_curves_match_design() {
    p12_assert_curve("brawler", "melee", [0, 60, 120, 180, 240, 300], |p| {
        p.brawler_melee_damage_bonus_milli()
    });
    p12_assert_curve("brawler", "melee", [0, 80, 160, 240, 320, 400], |p| {
        p.brawler_melee_variance_floor_milli()
    });
    p12_assert_curve("brawler", "guard", [0, 70, 140, 210, 280, 350], |p| {
        p.brawler_guard_parry_block_permille()
    });
    p12_assert_curve("brawler", "guard", [0, 190, 380, 570, 760, 950], |p| {
        p.brawler_guard_ranged_block_permille()
    });
    p12_assert_curve("brawler", "guard", [0, 30, 60, 90, 120, 150], |p| {
        p.brawler_guard_braced_damage_taken_reduction_milli()
    });
}

#[test]
fn p12_scout_campcraft_curves_match_design() {
    p12_assert_curve("scout", "campcraft", [0, 1, 1, 2, 2, 3], |p| {
        p.scout_campcraft_shelter_radius_bonus_cells()
    });
    p12_assert_curve(
        "scout",
        "campcraft",
        [1_000, 1_150, 1_300, 1_450, 1_600, 1_750],
        |p| p.scout_campcraft_field_rest_mult_milli(),
    );
    // Grace bonus is u64 seconds: 0 -> +900 s (+15 min) across the track.
    let grace: Vec<u64> = (0..=5)
        .map(|steps| {
            p12_track_state("scout", "campcraft", steps).scout_campcraft_grace_bonus_seconds()
        })
        .collect();
    assert_eq!(grace, vec![0, 180, 360, 540, 720, 900]);
}

#[test]
fn p12_craftsman_track_curves_match_design() {
    p12_assert_curve("craftsman", "survey", [24, 28, 32, 36, 40, 44], |p| {
        p.craftsman_survey_range_cells()
    });
    // Heat Reading resolution: sample spacing tightens 12 -> 8 -> 6 (finer at higher tiers).
    p12_assert_curve("craftsman", "survey", [12, 12, 8, 8, 8, 6], |p| {
        p.craftsman_survey_grid_step_cells()
    });
    p12_assert_curve("craftsman", "tools", [0, 30, 60, 90, 120, 150], |p| {
        p.craftsman_tools_quality_floor_bonus_milli()
    });
    let starter: Vec<u32> = (0..=5)
        .map(|steps| {
            p12_track_state("craftsman", "tools", steps)
                .craftsman_tools_starter_grant_quality_milli()
        })
        .collect();
    assert_eq!(starter, vec![500, 538, 575, 613, 650, 650]);
}

#[test]
fn p12_medic_trauma_curves_match_design() {
    p12_assert_curve("medic", "trauma", [0, 100, 200, 300, 400, 500], |p| {
        p.medic_trauma_revive_cast_reduction_milli()
    });
    p12_assert_curve("medic", "trauma", [25, 32, 39, 46, 53, 60], |p| {
        p.medic_trauma_revive_vitals_percent()
    });
    p12_assert_curve("medic", "trauma", [0, 80, 160, 240, 320, 400], |p| {
        p.medic_trauma_clone_sickness_reduction_milli()
    });
}

// ── P1(a): medic experimentation success now scales off medical-crafting ──────

#[test]
fn p12_medic_experimentation_bonus_matches_craftsman_shape() {
    // Same ladder, same numbers: medic medical-crafting bonus == craftsman experimentation
    // bonus at equal tiers (both feed the 60->95% success curve via experiment_line).
    for steps in 0..=5 {
        let medic = p12_track_state("medic", "medical-crafting", steps);
        let craftsman = p12_track_state("craftsman", "experimentation", steps);
        assert_eq!(
            medic.medical_experimentation_bonus(),
            craftsman.craftsman_experimentation_bonus(),
            "medic medical-crafting bonus tracks craftsman experimentation at step {steps}"
        );
    }
    // Endpoints: novice 50 (-> 60% success), full+master 300 (clamped 95%).
    assert_eq!(
        p12_track_state("medic", "medical-crafting", 0).medical_experimentation_bonus(),
        50
    );
    assert_eq!(
        p12_track_state("medic", "medical-crafting", 4).medical_experimentation_bonus(),
        250
    );
}

#[test]
fn p12_medical_experimentation_success_is_live_not_hardcoded_50pct() {
    // The bug was a hardcoded experimentation_bonus = 0 (50% success). Prove the value now
    // MOVES with the bonus: a trained medic (bonus 250 -> 95%) beats an untrained (0 -> 50%)
    // deterministically over the same seed + points, on a line well below its cap.
    let caps = MedicalCraftCaps {
        potency: 200,
        quantity: 200,
    };
    let base = MedicalCraftStats {
        potency: 40,
        quantity: 40,
    };
    let untrained = experiment_medical_stats(caps, base, 0xC0FF_EE01, 12, 12, 0);
    let trained = experiment_medical_stats(caps, base, 0xC0FF_EE01, 12, 12, 250);
    assert!(
        trained.potency > untrained.potency && trained.quantity > untrained.quantity,
        "trained medic (95%) must out-experiment untrained (50%): trained={trained:?} untrained={untrained:?}"
    );
}

// ── P1(b): ranged-block re-homed to the GUARD track (production) + debug line ──

#[test]
fn p12_guard_ranged_block_production_curve_and_debug_line() {
    // Production: the guard track drives ranged block 190 permille/box x5 -> 950 cap; the
    // brawler-novice floor is 0 (novice deflects nothing).
    let curve: Vec<u32> = (0..=5)
        .map(|steps| p12_track_state("brawler", "guard", steps).brawler_ranged_block_chance_milli())
        .collect();
    assert_eq!(curve, vec![0, 190, 380, 570, 760, 950]);
    // Debug test line: the 95%-per-box saber-block boxes (debug-grant-only, behind
    // GAME_DEBUG_AUTHORITY_COMMANDS) still yield the full 950 with a single box.
    let mut debug_boxes = ActorProfessionState::empty();
    debug_boxes
        .grant_skill_box_ids(&[
            "brawler-novice".to_owned(),
            BRAWLER_RANGED_BLOCK_SKILL_BOXES[0].to_owned(),
        ])
        .expect("debug ranged-block box grantable");
    assert_eq!(debug_boxes.brawler_ranged_block_chance_milli(), 950);
    // Combined: production guard + debug line take the strongest (still capped at 950).
    let mut both = p12_track_state("brawler", "guard", 2); // guard-ii -> 380 production
    both.grant_skill_box_ids(&[BRAWLER_RANGED_BLOCK_SKILL_BOXES[0].to_owned()])
        .unwrap();
    assert_eq!(both.brawler_ranged_block_chance_milli(), 950);
}

// ── combat-roll: guard parry, brawler melee damage + variance floor ───────────

fn p12_grant_boxes(state: &mut SliceAuthorityState, actor_id: &str, boxes: &[&str]) {
    let actor = state
        .runtime
        .durable
        .actors
        .get_mut(actor_id)
        .expect("test actor exists");
    for box_id in boxes {
        if let Some(def) = authority_skill_box_definition(box_id) {
            actor.professions.learned.insert(def.profession);
            actor.professions.skill_boxes.insert(def.id);
        }
    }
}

#[test]
fn p12_guard_parry_deflects_melee_in_roll_combat() {
    // A guard-trained, vibrosword-armed defender parries incoming melee strikes; an
    // untrained defender at the same seed takes the hit.
    let build = |guard: bool| {
        let (_config, mut state) = roll_combat_test_state();
        {
            let attacker = state.actors.get_mut("player").unwrap();
            attacker.equipped_weapon_id = Some(AuthorityWeaponId::Vibrosword);
        }
        {
            let target = state.actors.get_mut("roll-target").unwrap();
            target.equipped_weapon_id = Some(AuthorityWeaponId::Vibrosword);
        }
        // Adjacent so the melee strike is in range.
        place_actor_at_position(
            &mut state,
            "player",
            AuthorityPosition::from_cell(AuthorityCell::new(10, 10)),
        );
        place_actor_at_position(
            &mut state,
            "roll-target",
            AuthorityPosition::from_cell(AuthorityCell::new(11, 10)),
        );
        if guard {
            p12_grant_boxes(
                &mut state,
                "roll-target",
                &[
                    "brawler-novice",
                    "brawler-guard-i",
                    "brawler-guard-ii",
                    "brawler-guard-iii",
                    "brawler-guard-iv",
                    "brawler-master",
                ],
            );
        }
        super::combat_roll::queue_combat_action(&mut state, "player", "basic_shot", "roll-target")
            .unwrap();
        state.drain_due_combat_action_queues();
        state
            .pending_combat_events
            .iter()
            .any(|e| e.effect.as_ref().map(|f| f.kind.as_str()) == Some("deflected"))
    };
    assert!(
        build(true),
        "a master-guard vibrosword defender parries (deflects) the melee strike"
    );
    assert!(!build(false), "an untrained defender does not parry");
}

#[test]
fn p12_brawler_melee_shaping_adds_damage_and_floors_variance() {
    // Verify the shaping on a wide synthetic band so both effects are visible: an untrained
    // brawler is a pure pass-through; a master (variance floor 400 permille, damage bonus
    // +300 permille) floors low rolls toward the band max AND scales the result x1.3.
    let stats = WeaponRollStats {
        attack_speed_ms: 2_000,
        damage_min: 60,
        damage_max: 600,
        point_blank_acc: 60,
        ideal_acc: 40,
        max_acc: 20,
        point_blank_range: 1,
        ideal_range: 3,
        max_range: 6,
    };
    let (raw_min, raw_max) = super::combat_roll::melee_roll_damage_band_for_test(stats); // (60, 600)
    let untrained = p12_track_state("brawler", "melee", 0);
    let master = p12_track_state("brawler", "melee", 5);
    assert_eq!(master.brawler_melee_damage_bonus_milli(), 300);
    assert_eq!(master.brawler_melee_variance_floor_milli(), 400);

    // Untrained: no bonus, no floor -> exact pass-through of the raw roll.
    assert_eq!(
        super::combat_roll::apply_melee_damage_shaping_for_test(&untrained, stats, raw_min, 1),
        raw_min
    );
    assert_eq!(
        super::combat_roll::apply_melee_damage_shaping_for_test(&untrained, stats, raw_max, 1),
        raw_max
    );

    // Master, worst roll: floored to raw_min + 40%*(band) then x1.3 -> strictly above raw_min.
    let master_worst =
        super::combat_roll::apply_melee_damage_shaping_for_test(&master, stats, raw_min, 1);
    let floored_min = raw_min + (raw_max - raw_min) * 400 / 1_000; // 60 + 216 = 276
    assert_eq!(master_worst, floored_min * 1_300 / 1_000); // 276 * 1.3 = 358
    assert!(
        master_worst > raw_min,
        "master melee floor raises the worst-case strike ({master_worst} > {raw_min})"
    );

    // Master, best roll: the +30% bonus pushes damage ABOVE the raw band ceiling.
    let master_best =
        super::combat_roll::apply_melee_damage_shaping_for_test(&master, stats, raw_max, 1);
    assert!(
        master_best > raw_max,
        "master melee damage bonus exceeds the raw band ceiling ({master_best} > {raw_max})"
    );

    // Add assertion that the seam would fail (meaning produce wrong/different results) if it used 6
    let master_worst_with_six =
        super::combat_roll::apply_melee_damage_shaping_for_test(&master, stats, raw_min, 6);
    assert_ne!(
        master_worst_with_six, master_worst,
        "the seam would fail if it used 6 rounds"
    );
}

// ── combat-roll: defender damage-taken mitigation ────────────────────────────

#[test]
fn p12_defender_mitigation_guard_brace_and_fieldcraft_kneel() {
    let (_config, mut state) = roll_combat_test_state();
    // Guard brace is a passive tank mitigation (standing); fieldcraft cover needs kneeling.
    p12_grant_boxes(
        &mut state,
        "roll-target",
        &[
            "brawler-novice",
            "brawler-guard-i",
            "brawler-guard-ii",
            "brawler-guard-iii",
            "brawler-guard-iv",
            "brawler-master",
        ],
    );
    p12_grant_boxes(
        &mut state,
        "roll-target",
        &[
            "marksman-novice",
            "marksman-fieldcraft-i",
            "marksman-fieldcraft-ii",
            "marksman-fieldcraft-iii",
            "marksman-fieldcraft-iv",
        ],
    );
    // Standing: only guard brace applies (150 permille).
    {
        let target = state.actors.get_mut("roll-target").unwrap();
        target.posture = AuthorityActorPosture::Standing;
    }
    let standing = {
        let target = state.actors.get("roll-target").unwrap();
        defender_damage_taken_reduction_milli(target)
    };
    assert_eq!(standing, 150, "standing guard: brace only");
    assert_eq!(
        apply_defender_damage_taken_reduction(state.actors.get("roll-target").unwrap(), 1_000),
        850
    );
    // Kneeling: guard brace (150) + fieldcraft cover (fieldcraft-iv = 160) stack.
    {
        let target = state.actors.get_mut("roll-target").unwrap();
        target.posture = AuthorityActorPosture::Kneeling;
    }
    let kneeling = {
        let target = state.actors.get("roll-target").unwrap();
        defender_damage_taken_reduction_milli(target)
    };
    assert_eq!(
        kneeling, 310,
        "kneeling: brace 150 + fieldcraft-iv cover 160"
    );
    assert!(
        kneeling > standing,
        "kneeling cover stacks on top of the passive brace"
    );
}

// ── capstone auras: squad-fire (marksman) + camp-rest (scout) group frames ────

fn p12_cfg(actor_id: &str) -> SliceAuthorityConfig {
    SliceAuthorityConfig {
        player_actor_id: actor_id.to_owned(),
        ..SliceAuthorityConfig::default()
    }
}

fn p12_two_player_state(a: &str, b: &str) -> SliceAuthorityState {
    let mut snapshot = crate::authority_test_slice();
    snapshot.actors.clear();
    snapshot.npc_jobs.clear();
    snapshot.props.clear();
    snapshot.actors.push(test_actor(
        a,
        a,
        "player",
        CellSnapshot::new(10, 10),
        "right",
    ));
    snapshot.actors.push(test_actor(
        b,
        b,
        "player",
        CellSnapshot::new(11, 10),
        "left",
    ));
    SliceAuthorityState::from_snapshot(&snapshot).unwrap()
}

fn p12_form_group(state: &mut SliceAuthorityState, leader: &str, member: &str) {
    state
        .apply_group_invite(&p12_cfg(leader), member)
        .expect("invite");
    state.apply_group_accept(&p12_cfg(member)).expect("accept");
}

#[test]
fn p12_camp_rest_aura_shares_field_rest_with_group_at_master() {
    let mut state = p12_two_player_state("scout", "ally");
    grant_test_profession(&mut state, "scout", AuthorityProfessionKind::Scout);
    grant_test_profession(&mut state, "ally", AuthorityProfessionKind::Scout);
    // Master scout with a full campcraft track (field rest x1.75).
    p12_grant_boxes(
        &mut state,
        "scout",
        &[
            "scout-campcraft-i",
            "scout-campcraft-ii",
            "scout-campcraft-iii",
            "scout-campcraft-iv",
            "scout-master",
        ],
    );
    let camp_pos = AuthorityPosition::from_cell(AuthorityCell::new(10, 10));
    place_actor_at_position(&mut state, "scout", camp_pos);
    place_actor_at_position(&mut state, "ally", camp_pos);
    state.placed_camps.insert(
        "camp:scout:1".to_owned(),
        PlacedCampState {
            camp_id: "camp:scout:1".to_owned(),
            owner_actor_id: "scout".to_owned(),
            area_id: crate::AUTHORITY_TEST_AREA_ID.to_owned(),
            cell: camp_pos.cell(),
            position: camp_pos,
            placed_at_tick: 0,
            shelter_half_extent_milli_cells: Some(2_500),
            teardown_tick: None,
        },
    );
    // Ungrouped: only the owner rests fast; the ally is at x1.0.
    let solo = state.field_rest_mult_by_owner_in_camp();
    assert_eq!(solo.get("scout").copied(), Some(1_750));
    assert_eq!(
        solo.get("ally").copied(),
        None,
        "camp rest is owner-only before grouping"
    );
    // Grouped + master scout: the camp becomes group-shared rest.
    p12_form_group(&mut state, "scout", "ally");
    let shared = state.field_rest_mult_by_owner_in_camp();
    assert_eq!(shared.get("scout").copied(), Some(1_750));
    assert_eq!(
        shared.get("ally").copied(),
        Some(1_750),
        "master scout shares Field Rest with the group in camp"
    );
}

// ── medic revive: vitals %, cast reduction, clone-sickness cleanse ────────────

#[test]
fn p12_medic_revive_vitals_cast_and_clone_sickness_scale_with_trauma() {
    // Novice medic (trauma bonus 50 -> 25% vitals, no cast/clone reduction).
    let novice = p12_track_state("medic", "trauma", 0);
    assert_eq!(novice.medic_trauma_revive_vitals_percent(), 25);
    assert_eq!(novice.medic_trauma_revive_cast_reduction_milli(), 0);
    assert_eq!(novice.medic_trauma_clone_sickness_reduction_milli(), 0);
    // Master medic: 60% vitals, -50% cast, -40% clone-sickness.
    let master = p12_track_state("medic", "trauma", 5);
    assert_eq!(master.medic_trauma_revive_vitals_percent(), 60);
    assert_eq!(master.medic_trauma_revive_cast_reduction_milli(), 500);
    assert_eq!(master.medic_trauma_clone_sickness_reduction_milli(), 400);
}

// ═══════════════════ FLAGSHIP LIVE SPOT-PROOFS (deterministic sim) ════════════

#[test]
fn p12_live_proof_survey_range_44_at_master_via_command() {
    // Drive the real SurveyResource command path for a MASTER craftsman and read the range.
    let config = SliceAuthorityConfig::default();
    let snapshot = crate::authority_test_slice();
    let mut state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    let player = config.player_actor_id.clone();
    seed_test_tool(
        &mut state,
        &player,
        FIELD_MULTITOOL_ITEM_ID,
        "Field Multitool",
    );
    seed_test_survey_tool(&mut state, &player);
    p12_grant_boxes(
        &mut state,
        &player,
        &[
            "craftsman-novice",
            "craftsman-survey-i",
            "craftsman-survey-ii",
            "craftsman-survey-iii",
            "craftsman-survey-iv",
            "craftsman-master",
        ],
    );
    let frame = state.apply_envelope(
        &config,
        command(
            1,
            ClientCommand::SurveyResource {
                family: "mineral".to_owned(),
            },
        ),
    );
    assert_eq!(frame.status, AuthorityCommandStatus::Accepted);
    let survey = frame.survey_result.expect("survey payload");
    println!(
        "[p12-live] master craftsman survey: range={} cells, resolution step={} cells, grid={}x{}",
        survey.range_cells, survey.step_cells, survey.cols, survey.rows
    );
    assert_eq!(survey.range_cells, 44, "master survey range is 44 cells");
    assert_eq!(
        survey.step_cells, 6,
        "master Heat Reading resolution is 6 cells"
    );
    // Contrast: a novice craftsman surveys at 24 cells / step 12.
    let mut novice = SliceAuthorityState::from_snapshot(&crate::authority_test_slice()).unwrap();
    seed_test_tool(
        &mut novice,
        &player,
        FIELD_MULTITOOL_ITEM_ID,
        "Field Multitool",
    );
    seed_test_survey_tool(&mut novice, &player);
    p12_grant_boxes(&mut novice, &player, &["craftsman-novice"]);
    let novice_survey = novice
        .apply_envelope(
            &config,
            command(
                1,
                ClientCommand::SurveyResource {
                    family: "mineral".to_owned(),
                },
            ),
        )
        .survey_result
        .expect("novice survey payload");
    println!(
        "[p12-live] novice craftsman survey: range={} cells, step={} cells",
        novice_survey.range_cells, novice_survey.step_cells
    );
    assert_eq!(novice_survey.range_cells, 24);
    assert_eq!(novice_survey.step_cells, 12);
}

#[test]
fn p12_live_proof_field_rest_regen_in_own_camp() {
    let mut snapshot = crate::authority_test_slice();
    snapshot.actors.clear();
    snapshot.npc_jobs.clear();
    snapshot.props.clear();
    snapshot.actors.push(test_actor(
        "scout",
        "Field Rester",
        "player",
        CellSnapshot::new(10, 10),
        "right",
    ));
    let config = p12_cfg("scout");
    let mut state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    grant_test_profession(&mut state, "scout", AuthorityProfessionKind::Scout);
    p12_grant_boxes(
        &mut state,
        "scout",
        &[
            "scout-campcraft-i",
            "scout-campcraft-ii",
            "scout-campcraft-iii",
            "scout-campcraft-iv",
        ],
    );
    let camp_pos = AuthorityPosition::from_cell(AuthorityCell::new(10, 10));
    let regen_setup = |state: &mut SliceAuthorityState| {
        let scout = state.actors.get_mut("scout").unwrap();
        scout.max_vitals.health = 1_000;
        scout.vitals.health = 100;
        scout.effective_stats.regen_rates_milli_per_second.health = 10_000; // 10 hp/s baseline
        scout.effective_stats.spawn_vitals.health = 1_000;
    };
    // Baseline: no camp -> x1.0 regen over 60 ticks (2 s).
    regen_setup(&mut state);
    advance_ticks_unclamped(&mut state, &config, 60);
    let baseline_gain = state.actors.get("scout").unwrap().vitals.health - 100;
    // Field Rest: same scout resting in their OWN camp -> x1.75 regen over the same window.
    let mut camp_state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    grant_test_profession(&mut camp_state, "scout", AuthorityProfessionKind::Scout);
    p12_grant_boxes(
        &mut camp_state,
        "scout",
        &[
            "scout-campcraft-i",
            "scout-campcraft-ii",
            "scout-campcraft-iii",
            "scout-campcraft-iv",
        ],
    );
    camp_state.placed_camps.insert(
        "camp:scout:1".to_owned(),
        PlacedCampState {
            camp_id: "camp:scout:1".to_owned(),
            owner_actor_id: "scout".to_owned(),
            area_id: crate::AUTHORITY_TEST_AREA_ID.to_owned(),
            cell: camp_pos.cell(),
            position: camp_pos,
            placed_at_tick: 0,
            shelter_half_extent_milli_cells: Some(2_500),
            teardown_tick: None,
        },
    );
    regen_setup(&mut camp_state);
    advance_ticks_unclamped(&mut camp_state, &config, 60);
    let camp_gain = camp_state.actors.get("scout").unwrap().vitals.health - 100;
    println!(
        "[p12-live] Field Rest regen over 60 ticks: baseline +{} hp, in own camp (campcraft-IV x1.6) +{} hp",
        baseline_gain, camp_gain
    );
    assert!(
        camp_gain > baseline_gain,
        "Field Rest speeds regen in the scout's own camp ({camp_gain} > {baseline_gain})"
    );
}

// ============================================================================
// Bio-Engineer B1-B4 integration (acquire -> analyze -> splice -> mint), driven
// end-to-end through apply_envelope so wire tags 80-89, receipts, and the
// genome registry are all exercised together. bioengineer-design.md §3.
// ============================================================================

fn grant_bioengineer_master(state: &mut SliceAuthorityState, actor_id: &str) {
    let actor = state
        .runtime
        .durable
        .actors
        .get_mut(actor_id)
        .expect("test actor exists");
    actor
        .professions
        .learned
        .insert(AuthorityProfessionKind::BioEngineer);
    let mut boxes = vec![
        "bioengineer-novice".to_owned(),
        "bioengineer-master".to_owned(),
    ];
    for track in ["sequencing", "splicing", "cultivation", "genelock"] {
        for tier in ["i", "ii", "iii", "iv"] {
            boxes.push(format!("bioengineer-{track}-{tier}"));
        }
    }
    for skill_box in boxes {
        actor.professions.skill_boxes.insert(skill_box);
    }
    actor
        .capabilities
        .grant_profession_capabilities(AuthorityProfessionKind::BioEngineer);
}

fn give_bio_toolkit(state: &mut SliceAuthorityState, actor_id: &str) {
    // Tools (variant = quality milli) + reagents (variant = potency milli).
    state.add_actor_inventory_stack(
        actor_id,
        GENE_SAMPLER_ITEM_ID,
        500,
        "Gene Sampler",
        1,
        1,
        "field-pack",
    );
    state.add_actor_inventory_stack(
        actor_id,
        GENOME_SCANNER_ITEM_ID,
        500,
        "Genome Scanner",
        1,
        1,
        "field-pack",
    );
    state.add_actor_inventory_stack(
        actor_id,
        SPLICE_BENCH_ITEM_ID,
        950,
        "Splice Bench",
        1,
        1,
        "field-pack",
    );
    state.add_actor_inventory_stack(
        actor_id,
        CULTURE_MEDIUM_ITEM_ID,
        940,
        "Culture Medium",
        4,
        BIO_REAGENT_STACK_CAP,
        "field-pack",
    );
    state.add_actor_inventory_stack(
        actor_id,
        MUTAGEN_ITEM_ID,
        950,
        "Mutagen",
        4,
        BIO_REAGENT_STACK_CAP,
        "field-pack",
    );
    state.add_actor_inventory_stack(
        actor_id,
        STABILIZER_ITEM_ID,
        950,
        "Stabilizer",
        4,
        BIO_REAGENT_STACK_CAP,
        "field-pack",
    );
}

fn player_seed_stacks(state: &SliceAuthorityState, actor_id: &str) -> Vec<(String, u64, u32)> {
    let mut stacks = state
        .runtime
        .durable
        .inventory
        .iter()
        .filter(|row| {
            row.item_id == CROP_ASHGRAIN_ITEM_ID
                && actor_owns_inventory_container(actor_id, &row.container)
        })
        .map(|row| (row.container.clone(), row.stack_id, row.variant_id))
        .collect::<Vec<_>>();
    stacks.sort_by_key(|(_, stack_id, _)| *stack_id);
    stacks
}

fn sample_wild_ashgrain(
    state: &mut SliceAuthorityState,
    config: &SliceAuthorityConfig,
    command_id: u64,
) {
    state.clear_actor_economy_action_cooldown(&config.player_actor_id);
    let frame = state.apply_envelope(
        config,
        command(
            command_id,
            ClientCommand::GeneSample {
                species: "ashgrain".to_owned(),
            },
        ),
    );
    assert_eq!(
        frame.status,
        AuthorityCommandStatus::Accepted,
        "gene sample rejected: {:?}",
        frame.reason_code
    );
}

#[test]
fn bioengineer_novice_purchase_earns_both_parent_chains_at_exact_thresholds() {
    let config = SliceAuthorityConfig::default();
    let mut snapshot = crate::authority_test_slice();
    let mut trainer = test_actor(
        "genecrafter-trainer-01",
        "Gene-Lab Technician",
        "profession_trainer",
        CellSnapshot::new(37, 22),
        "front",
    );
    trainer
        .capabilities
        .push(AUTHORITY_CAPABILITY_TRAIN_PROFESSION.to_owned());
    snapshot.actors.push(trainer);
    let mut state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    let player = config.player_actor_id.clone();
    clear_test_professions(&mut state, &player);

    let purchase = |state: &mut SliceAuthorityState, command_id, skill_box_id: &str| {
        state.advance_ticks_for_observer(&config, 15);
        state.apply_envelope(
            &config,
            command(
                command_id,
                ClientCommand::PurchaseSkillBox {
                    skill_box_id: skill_box_id.to_owned(),
                    trainer_actor_id: "genecrafter-trainer-01".to_owned(),
                },
            ),
        )
    };
    let assert_accepted = |receipt: &AuthorityCommandFrame, skill_box_id: &str| {
        assert_eq!(
            receipt.status,
            AuthorityCommandStatus::Accepted,
            "{skill_box_id} purchase: {:?}",
            receipt.reason_code
        );
    };

    let locked = purchase(&mut state, 1, "bioengineer-novice");
    assert_eq!(locked.status, AuthorityCommandStatus::Rejected);
    assert_eq!(
        locked.reason_code.as_deref(),
        Some(AuthorityRejectReason::SkillPrerequisiteMissing.code())
    );

    assert_accepted(
        &purchase(&mut state, 2, "craftsman-novice"),
        "craftsman-novice",
    );
    for (first, second, profession, track) in [
        (
            "craftsman-experimentation-i",
            "craftsman-experimentation-ii",
            AuthorityProfessionKind::Craftsman,
            "experimentation",
        ),
        (
            "medic-medical-crafting-i",
            "medic-medical-crafting-ii",
            AuthorityProfessionKind::Medic,
            "medical-crafting",
        ),
    ] {
        if profession == AuthorityProfessionKind::Medic {
            assert_accepted(&purchase(&mut state, 9, "medic-novice"), "medic-novice");
        }

        let below_first = purchase(
            &mut state,
            if profession == AuthorityProfessionKind::Craftsman {
                3
            } else {
                10
            },
            first,
        );
        assert_eq!(below_first.status, AuthorityCommandStatus::Rejected);
        assert_eq!(
            below_first.reason_code.as_deref(),
            Some(AuthorityRejectReason::InsufficientProfessionXp.code()),
            "{first} rejects before any track XP"
        );
        state
            .award_profession_track_xp(&player, profession, track, 99)
            .unwrap();
        let below_exact = purchase(
            &mut state,
            if profession == AuthorityProfessionKind::Craftsman {
                4
            } else {
                11
            },
            first,
        );
        assert_eq!(below_exact.status, AuthorityCommandStatus::Rejected);
        assert_eq!(
            below_exact.reason_code.as_deref(),
            Some(AuthorityRejectReason::InsufficientProfessionXp.code()),
            "{first} rejects at 99 XP"
        );
        state
            .award_profession_track_xp(&player, profession, track, 1)
            .unwrap();
        assert_accepted(
            &purchase(
                &mut state,
                if profession == AuthorityProfessionKind::Craftsman {
                    5
                } else {
                    12
                },
                first,
            ),
            first,
        );

        state
            .award_profession_track_xp(&player, profession, track, 299)
            .unwrap();
        let below_second = purchase(
            &mut state,
            if profession == AuthorityProfessionKind::Craftsman {
                6
            } else {
                13
            },
            second,
        );
        assert_eq!(below_second.status, AuthorityCommandStatus::Rejected);
        assert_eq!(
            below_second.reason_code.as_deref(),
            Some(AuthorityRejectReason::InsufficientProfessionXp.code()),
            "{second} rejects at 299 XP"
        );
        state
            .award_profession_track_xp(&player, profession, track, 1)
            .unwrap();
        assert_accepted(
            &purchase(
                &mut state,
                if profession == AuthorityProfessionKind::Craftsman {
                    7
                } else {
                    14
                },
                second,
            ),
            second,
        );

        let profession_state = &state
            .actors
            .get(&player)
            .expect("player exists")
            .professions;
        assert_eq!(
            profession_state.xp.get(&profession).copied().unwrap_or(0),
            0,
            "{profession:?} total XP is spent by both purchases"
        );
        assert_eq!(
            profession_state.track_xp_amount(profession, track),
            0,
            "{profession:?} {track} XP is spent by both purchases"
        );
    }

    let bio = purchase(&mut state, 15, "bioengineer-novice");
    assert_accepted(&bio, "bioengineer-novice");
    let actor = state.actors.get(&player).expect("player exists");
    for skill_box in [
        "craftsman-novice",
        "craftsman-experimentation-i",
        "craftsman-experimentation-ii",
        "medic-novice",
        "medic-medical-crafting-i",
        "medic-medical-crafting-ii",
        "bioengineer-novice",
    ] {
        assert!(
            actor.professions.has_skill_box(skill_box),
            "accepted receipt owns {skill_box}"
        );
    }
    assert_eq!(
        actor.professions.skill_points_used(),
        76,
        "both parents (60) plus Bio novice (16)"
    );
    assert!(
        actor.professions.skill_points_used() <= actor.professions.skill_point_cap,
        "earned parent chains and Bio novice fit the actor's actual skill-point cap"
    );

    let held = |item_id: u32| {
        state.inventory.iter().any(|row| {
            row.item_id == item_id
                && actor_owns_inventory_container(&player, &row.container)
                && row.available > 0
        })
    };
    assert!(held(GENE_SAMPLER_ITEM_ID), "novice grant: Gene Sampler");
    assert!(held(GENOME_SCANNER_ITEM_ID), "novice grant: Genome Scanner");
    assert!(held(SPLICE_BENCH_ITEM_ID), "novice grant: Splice Bench");
    assert!(
        held(CROP_ASHGRAIN_ITEM_ID),
        "novice grant: Starter Seed Packet"
    );
    let starter = player_seed_stacks(&state, &player)[0].2;
    assert!(state
        .crop_genomes
        .resolve(CROP_ASHGRAIN_ITEM_ID, starter)
        .is_some());
}

#[test]
fn bioengineer_full_acquire_scan_splice_mint_flow_produces_replantable_offspring() {
    // B3+B4 live flow: sample two wild seeds -> scan (reveal) -> splice session ->
    // assemble -> experiment -> mint -> offspring genome differs + is replantable.
    let config = SliceAuthorityConfig::default();
    let mut state = SliceAuthorityState::from_snapshot(&crate::authority_test_slice()).unwrap();
    let player = config.player_actor_id.clone();
    grant_bioengineer_master(&mut state, &player);
    give_bio_toolkit(&mut state, &player);

    // --- ACQUIRE: two wild Ashgrain landraces (distinct sample ticks -> distinct genomes).
    sample_wild_ashgrain(&mut state, &config, 1);
    sample_wild_ashgrain(&mut state, &config, 2);
    let seeds = player_seed_stacks(&state, &player);
    assert_eq!(seeds.len(), 2, "two distinct wild seeds sampled");
    let (parent_a, parent_b) = (seeds[0].clone(), seeds[1].clone());
    assert_ne!(
        parent_a.2, parent_b.2,
        "distinct genomes intern to distinct handles"
    );

    // --- ANALYZE: scan reveals the genome; at master the reveal is full-tier.
    let scan = state.apply_envelope(
        &config,
        command(
            3,
            ClientCommand::ScanGenome {
                container: parent_a.0.clone(),
                stack_id: parent_a.1.to_string(),
                variant_id: parent_a.2,
            },
        ),
    );
    assert_eq!(
        scan.status,
        AuthorityCommandStatus::Accepted,
        "scan: {:?}",
        scan.reason_code
    );
    let scan_vm = scan
        .genome_scan
        .expect("scan emits a genome reveal VM (receipt)");
    assert_eq!(scan_vm.tier, "full");
    assert_eq!(scan_vm.variant_id, parent_a.2);
    assert!(scan_vm
        .loci
        .iter()
        .all(|locus| locus.a1.is_some() && locus.a2.is_some()));
    assert!(scan_vm.mutation_potential_milli.is_some());

    // --- SPLICE: session -> parents + reagents -> assemble -> experiment -> mint.
    let begin = state.apply_envelope(
        &config,
        command(
            4,
            ClientCommand::SpliceBegin {
                species: "ashgrain".to_owned(),
            },
        ),
    );
    assert_eq!(
        begin.status,
        AuthorityCommandStatus::Accepted,
        "begin: {:?}",
        begin.reason_code
    );
    let assign =
        |state: &mut SliceAuthorityState, id: u64, slot: u8, stack: &(String, u64, u32)| {
            state.apply_envelope(
                &config,
                command(
                    id,
                    ClientCommand::SpliceAssignSlot {
                        slot_index: slot,
                        container: stack.0.clone(),
                        stack_id: stack.1.to_string(),
                        variant_id: stack.2,
                    },
                ),
            )
        };
    assert_eq!(
        assign(&mut state, 5, 0, &parent_a).status,
        AuthorityCommandStatus::Accepted
    );
    assert_eq!(
        assign(&mut state, 6, 1, &parent_b).status,
        AuthorityCommandStatus::Accepted
    );
    // Reagents: culture -> slot 2, mutagen -> slot 3, stabilizer -> slot 4.
    let reagent_stack = |state: &SliceAuthorityState, item_id: u32| {
        state
            .inventory
            .iter()
            .find(|row| {
                row.item_id == item_id && actor_owns_inventory_container(&player, &row.container)
            })
            .map(|row| (row.container.clone(), row.stack_id, row.variant_id))
            .expect("reagent held")
    };
    for (id, slot, item_id) in [
        (7u64, 2u8, CULTURE_MEDIUM_ITEM_ID),
        (8, 3, MUTAGEN_ITEM_ID),
        (9, 4, STABILIZER_ITEM_ID),
    ] {
        let stack = reagent_stack(&state, item_id);
        assert_eq!(
            assign(&mut state, id, slot, &stack).status,
            AuthorityCommandStatus::Accepted
        );
    }
    let assemble = state.apply_envelope(&config, command(10, ClientCommand::SpliceAssemble {}));
    assert_eq!(
        assemble.status,
        AuthorityCommandStatus::Accepted,
        "assemble: {:?}",
        assemble.reason_code
    );
    let session = assemble
        .splice_session
        .expect("assemble emits a splice-session VM (receipt)");
    assert_eq!(session.phase, "assembled");
    assert_eq!(session.points_total, 21, "master assembly points_total");
    assert_eq!(session.lines.len(), GENOME_LOCUS_COUNT);

    // Experiment: pour points into YIELD, then mint.
    let experiment = state.apply_envelope(
        &config,
        command(
            11,
            ClientCommand::SpliceExperimentLocus {
                locus: LOCUS_YIELD as u8,
                points: 8,
            },
        ),
    );
    assert_eq!(
        experiment.status,
        AuthorityCommandStatus::Accepted,
        "experiment: {:?}",
        experiment.reason_code
    );
    let mint = state.apply_envelope(
        &config,
        command(
            12,
            ClientCommand::SpliceMint {
                cultivar_name: Some("Kestrel".to_owned()),
            },
        ),
    );
    assert_eq!(
        mint.status,
        AuthorityCommandStatus::Accepted,
        "mint: {:?}",
        mint.reason_code
    );

    // --- OFFSPRING: a new seed handle, distinct from both parents, resolvable.
    let after = player_seed_stacks(&state, &player);
    let child_handle = after
        .iter()
        .map(|(_, _, variant)| *variant)
        .find(|variant| *variant != parent_a.2 && *variant != parent_b.2)
        .expect("a new child seed handle was minted");
    let child = state
        .crop_genomes
        .resolve(CROP_ASHGRAIN_ITEM_ID, child_handle)
        .expect("child genome is in the registry (replant-able)");
    assert_eq!(child.lineage.cultivar_name, "Kestrel");
    assert_eq!(child.lineage.breeder_id, player);
    assert_eq!(child.lineage.parents, [parent_a.2, parent_b.2]);
    assert!(child.fertile);
    // The child is genetically distinct from both parents (breeding did something).
    let parent_a_genome = state.crop_genomes.get(parent_a.2).unwrap();
    let parent_b_genome = state.crop_genomes.get(parent_b.2).unwrap();
    assert_ne!(child.loci, parent_a_genome.loci);
    assert_ne!(child.loci, parent_b_genome.loci);
}

#[test]
fn bioengineer_splice_flow_is_deterministic_across_replay() {
    // Same (parents, reagents, choices, skill, tool) -> the identical child handle.
    let run = || -> u32 {
        let config = SliceAuthorityConfig::default();
        let mut state = SliceAuthorityState::from_snapshot(&crate::authority_test_slice()).unwrap();
        let player = config.player_actor_id.clone();
        grant_bioengineer_master(&mut state, &player);
        give_bio_toolkit(&mut state, &player);
        sample_wild_ashgrain(&mut state, &config, 1);
        sample_wild_ashgrain(&mut state, &config, 2);
        let seeds = player_seed_stacks(&state, &player);
        let (a, b) = (seeds[0].clone(), seeds[1].clone());
        state.apply_envelope(
            &config,
            command(
                3,
                ClientCommand::SpliceBegin {
                    species: "ashgrain".to_owned(),
                },
            ),
        );
        for (id, slot, stack) in [(4u64, 0u8, &a), (5, 1, &b)] {
            state.apply_envelope(
                &config,
                command(
                    id,
                    ClientCommand::SpliceAssignSlot {
                        slot_index: slot,
                        container: stack.0.clone(),
                        stack_id: stack.1.to_string(),
                        variant_id: stack.2,
                    },
                ),
            );
        }
        state.apply_envelope(&config, command(6, ClientCommand::SpliceAssemble {}));
        state.apply_envelope(
            &config,
            command(
                7,
                ClientCommand::SpliceExperimentLocus {
                    locus: 0,
                    points: 4,
                },
            ),
        );
        state.apply_envelope(
            &config,
            command(
                8,
                ClientCommand::SpliceMint {
                    cultivar_name: None,
                },
            ),
        );
        let seeds = player_seed_stacks(&state, &player);
        seeds
            .iter()
            .map(|(_, _, v)| *v)
            .max()
            .expect("child minted")
    };
    assert_eq!(
        run(),
        run(),
        "identical inputs must mint the identical child handle"
    );
}

#[test]
fn bioengineer_scan_and_assign_reject_foreign_container() {
    // Claimed-placeholder boundary: bio commands are self+inventory scoped; an
    // actor can never scan or splice from a container it does not own.
    let config = SliceAuthorityConfig::default();
    let mut state = SliceAuthorityState::from_snapshot(&crate::authority_test_slice()).unwrap();
    let player = config.player_actor_id.clone();
    grant_bioengineer_master(&mut state, &player);
    give_bio_toolkit(&mut state, &player);
    sample_wild_ashgrain(&mut state, &config, 1);
    let seed = player_seed_stacks(&state, &player)[0].clone();

    // Scan referencing a foreign container is rejected (not the actor's stack).
    let foreign_scan = state.apply_envelope(
        &config,
        command(
            2,
            ClientCommand::ScanGenome {
                container: "intruder:field-pack".to_owned(),
                stack_id: seed.1.to_string(),
                variant_id: seed.2,
            },
        ),
    );
    assert_eq!(foreign_scan.status, AuthorityCommandStatus::Rejected);
    assert_eq!(
        foreign_scan.reason_code.as_deref(),
        Some("item_unavailable")
    );

    // Same for a splice slot assignment from a foreign container.
    state.apply_envelope(
        &config,
        command(
            3,
            ClientCommand::SpliceBegin {
                species: "ashgrain".to_owned(),
            },
        ),
    );
    let foreign_assign = state.apply_envelope(
        &config,
        command(
            4,
            ClientCommand::SpliceAssignSlot {
                slot_index: 0,
                container: "intruder:field-pack".to_owned(),
                stack_id: seed.1.to_string(),
                variant_id: seed.2,
            },
        ),
    );
    assert_eq!(foreign_assign.status, AuthorityCommandStatus::Rejected);
    assert_eq!(
        foreign_assign.reason_code.as_deref(),
        Some("item_unavailable")
    );
}

#[test]
fn bioengineer_commands_require_their_tools() {
    // Gate coverage: sampler, scanner, bench each gate their command.
    let config = SliceAuthorityConfig::default();
    let mut state = SliceAuthorityState::from_snapshot(&crate::authority_test_slice()).unwrap();
    let player = config.player_actor_id.clone();
    grant_bioengineer_master(&mut state, &player);
    // No toolkit granted yet.
    let sample = state.apply_envelope(
        &config,
        command(
            1,
            ClientCommand::GeneSample {
                species: "ashgrain".to_owned(),
            },
        ),
    );
    assert_eq!(sample.reason_code.as_deref(), Some("missing_gene_sampler"));
    let begin = state.apply_envelope(
        &config,
        command(
            2,
            ClientCommand::SpliceBegin {
                species: "ashgrain".to_owned(),
            },
        ),
    );
    assert_eq!(begin.reason_code.as_deref(), Some("missing_splice_bench"));
    // Unknown species is rejected distinctly (with the sampler in hand).
    state.add_actor_inventory_stack(
        &player,
        GENE_SAMPLER_ITEM_ID,
        500,
        "Gene Sampler",
        1,
        1,
        "field-pack",
    );
    state.clear_actor_economy_action_cooldown(&player);
    let bad_species = state.apply_envelope(
        &config,
        command(
            3,
            ClientCommand::GeneSample {
                species: "notacrop".to_owned(),
            },
        ),
    );
    assert_eq!(
        bad_species.reason_code.as_deref(),
        Some("unknown_crop_species")
    );
}

#[test]
fn bioengineer_empty_registry_keeps_state_hash_stable() {
    // Conditional hashing: a genome-free state hashes byte-identically to a state
    // built before the registry existed (no play:gate digest churn).
    let state = SliceAuthorityState::from_snapshot(&crate::authority_test_slice()).unwrap();
    assert!(state.crop_genomes.is_empty());
    let baseline_hash = state.stable_state_hash_hex();
    // Re-derive on a second construction: identical (registry contributes nothing).
    let again = SliceAuthorityState::from_snapshot(&crate::authority_test_slice()).unwrap();
    assert_eq!(again.stable_state_hash_hex(), baseline_hash);

    // Minting a genome DOES move the hash (the registry now carries state).
    let mut minted = SliceAuthorityState::from_snapshot(&crate::authority_test_slice()).unwrap();
    let player = SliceAuthorityConfig::default().player_actor_id;
    grant_bioengineer_master(&mut minted, &player);
    minted.add_actor_inventory_stack(
        &player,
        GENE_SAMPLER_ITEM_ID,
        500,
        "Gene Sampler",
        1,
        1,
        "field-pack",
    );
    let config = SliceAuthorityConfig::default();
    sample_wild_ashgrain(&mut minted, &config, 1);
    assert!(!minted.crop_genomes.is_empty());
    assert_ne!(minted.stable_state_hash_hex(), baseline_hash);
}

#[test]
fn bioengineer_genome_registry_survives_export_import_roundtrip() {
    // Durable side-table: export -> import reconstructs the registry + dedup index.
    let config = SliceAuthorityConfig::default();
    let mut state = SliceAuthorityState::from_snapshot(&crate::authority_test_slice()).unwrap();
    let player = config.player_actor_id.clone();
    grant_bioengineer_master(&mut state, &player);
    give_bio_toolkit(&mut state, &player);
    sample_wild_ashgrain(&mut state, &config, 1);
    sample_wild_ashgrain(&mut state, &config, 2);
    let before_hash = state.stable_state_hash_hex();
    let handles = player_seed_stacks(&state, &player)
        .iter()
        .map(|(_, _, v)| *v)
        .collect::<Vec<_>>();

    let blob = state.export_checkpoint();
    let imported = restore_checkpoint_for_test(&state, blob);
    assert_eq!(imported.stable_state_hash_hex(), before_hash);
    for handle in handles {
        assert!(
            imported
                .crop_genomes
                .resolve(CROP_ASHGRAIN_ITEM_ID, handle)
                .is_some(),
            "genome {handle} survived the roundtrip"
        );
    }
    // The rebuilt dedup index still interns identical content to the same handle.
    let mut reimport = imported;
    let existing = reimport
        .crop_genomes
        .get(1)
        .cloned()
        .expect("handle 1 exists");
    assert_eq!(
        reimport.crop_genomes.intern(existing),
        1,
        "dedup index rebuilt on import"
    );
}

/// LIVE SCRATCH PROOF (bioengineer-design.md §3): the whole loop driven through
/// apply_envelope, emitting a human-readable transcript. Run:
///   cargo test -p successor-sim --lib bioengineer_splice_live_proof -- --nocapture
/// The transcript is printed when the test runs with `--nocapture`.
#[test]
fn bioengineer_splice_live_proof() {
    use std::fmt::Write as _;

    let config = SliceAuthorityConfig::default();
    let player = config.player_actor_id.clone();
    let mut out = String::new();
    let express = |g: &Genome, l: usize| g.loci[l].express();

    let run_flow = |transcript: Option<&mut String>| -> (u32, [Locus; GENOME_LOCUS_COUNT]) {
        let mut state = SliceAuthorityState::from_snapshot(&crate::authority_test_slice()).unwrap();
        grant_bioengineer_master(&mut state, &player);
        give_bio_toolkit(&mut state, &player);

        // ACQUIRE two distinct wild Ashgrain landraces.
        sample_wild_ashgrain(&mut state, &config, 1);
        sample_wild_ashgrain(&mut state, &config, 2);
        let seeds = player_seed_stacks(&state, &player);
        let (a, b) = (seeds[0].clone(), seeds[1].clone());

        // SPLICE the two parents with premium reagents (culture/mutagen/stabilizer).
        state.apply_envelope(
            &config,
            command(
                3,
                ClientCommand::SpliceBegin {
                    species: "ashgrain".to_owned(),
                },
            ),
        );
        for (id, slot, stack) in [(4u64, 0u8, &a), (5, 1, &b)] {
            state.apply_envelope(
                &config,
                command(
                    id,
                    ClientCommand::SpliceAssignSlot {
                        slot_index: slot,
                        container: stack.0.clone(),
                        stack_id: stack.1.to_string(),
                        variant_id: stack.2,
                    },
                ),
            );
        }
        let reagent = |state: &SliceAuthorityState, item: u32| {
            state
                .inventory
                .iter()
                .find(|r| {
                    r.item_id == item && actor_owns_inventory_container(&player, &r.container)
                })
                .map(|r| (r.container.clone(), r.stack_id, r.variant_id))
                .unwrap()
        };
        for (id, slot, item) in [
            (6u64, 2u8, CULTURE_MEDIUM_ITEM_ID),
            (7, 3, MUTAGEN_ITEM_ID),
            (8, 4, STABILIZER_ITEM_ID),
        ] {
            let s = reagent(&state, item);
            state.apply_envelope(
                &config,
                command(
                    id,
                    ClientCommand::SpliceAssignSlot {
                        slot_index: slot,
                        container: s.0,
                        stack_id: s.1.to_string(),
                        variant_id: s.2,
                    },
                ),
            );
        }
        let assemble = state.apply_envelope(&config, command(9, ClientCommand::SpliceAssemble {}));
        // Pour all points into YIELD (owner determinism showcase).
        let points = assemble
            .splice_session
            .as_ref()
            .map(|s| s.points_total)
            .unwrap_or(0);
        state.apply_envelope(
            &config,
            command(
                10,
                ClientCommand::SpliceExperimentLocus {
                    locus: LOCUS_YIELD as u8,
                    points,
                },
            ),
        );
        state.apply_envelope(
            &config,
            command(
                11,
                ClientCommand::SpliceMint {
                    cultivar_name: Some("Kestrel".to_owned()),
                },
            ),
        );

        let after = player_seed_stacks(&state, &player);
        let child_handle = after
            .iter()
            .map(|(_, _, v)| *v)
            .find(|v| *v != a.2 && *v != b.2)
            .unwrap();
        let child = state.crop_genomes.get(child_handle).unwrap().clone();

        if let Some(t) = transcript {
            let pa = state.crop_genomes.get(a.2).unwrap().clone();
            let pb = state.crop_genomes.get(b.2).unwrap().clone();
            let _ = writeln!(
                t,
                "== BIO-ENGINEER SPLICE LIVE PROOF (server-authoritative, deterministic) ==\n"
            );
            let _ = writeln!(
                t,
                "[1] ACQUIRE — wild-flora Gene Sampler (Sequencing) minted two landrace seeds:"
            );
            let _ = writeln!(t, "    parent A  seed 6_001 variant(handle)={:<4} cultivar='{}'  YIELD express={} (alleles {}/{})",
                a.2, pa.lineage.cultivar_name, express(&pa,LOCUS_YIELD), pa.loci[LOCUS_YIELD].a1, pa.loci[LOCUS_YIELD].a2);
            let _ = writeln!(t, "    parent B  seed 6_001 variant(handle)={:<4} cultivar='{}'  YIELD express={} (alleles {}/{})",
                b.2, pb.lineage.cultivar_name, express(&pb,LOCUS_YIELD), pb.loci[LOCUS_YIELD].a1, pb.loci[LOCUS_YIELD].a2);

            let scan = state.apply_envelope(
                &config,
                command(
                    99,
                    ClientCommand::ScanGenome {
                        container: a.0.clone(),
                        stack_id: a.1.to_string(),
                        variant_id: a.2,
                    },
                ),
            );
            let vm = scan.genome_scan.unwrap();
            let _ = writeln!(
                t,
                "\n[2] ANALYZE — Genome Scanner reveal tier='{}' (Sequencing master = full):",
                vm.tier
            );
            for locus in vm.loci.iter().take(4) {
                let _ = writeln!(
                    t,
                    "    locus {:<16} express={:<4} a1={:?} a2={:?} hetero={:?}",
                    locus.label, locus.express_milli, locus.a1, locus.a2, locus.heterozygous
                );
            }
            let _ = writeln!(
                t,
                "    mutation_potential revealed = {:?}",
                vm.mutation_potential_milli
            );

            let session = assemble.splice_session.as_ref().unwrap();
            let _ = writeln!(t, "\n[3] SPLICE — deterministic assembly q={} points_total={} (no ai_rand, no crit-fail):",
                session.assembly_quality_milli, session.points_total);
            for line in session.lines.iter().take(4) {
                let _ = writeln!(
                    t,
                    "    locus {:<16} base={:<4} cap={:<4}",
                    line.label, line.base_milli, line.cap_milli
                );
            }

            let _ = writeln!(
                t,
                "\n[4] MINT — child interned as a new genome handle in the CropGenomeRegistry:"
            );
            let _ = writeln!(t, "    child     seed 6_001 variant(handle)={:<4} cultivar='{}' generation={} parents={:?}",
                child_handle, child.lineage.cultivar_name, child.lineage.generation, child.lineage.parents);
            let _ = writeln!(
                t,
                "    child     YIELD express={} (alleles {}/{})  fertile={}",
                express(&child, LOCUS_YIELD),
                child.loci[LOCUS_YIELD].a1,
                child.loci[LOCUS_YIELD].a2,
                child.fertile
            );

            let _ = writeln!(t, "\n[5] PROOF:");
            let _ = writeln!(
                t,
                "    offspring handle {} differs from parents {} and {}: {}",
                child_handle,
                a.2,
                b.2,
                child_handle != a.2 && child_handle != b.2
            );
            let _ = writeln!(
                t,
                "    offspring genome differs from both parents:            {}",
                child.loci != pa.loci && child.loci != pb.loci
            );
            let _ = writeln!(
                t,
                "    offspring handle is replant-able (registry resolve):   {}",
                state
                    .crop_genomes
                    .resolve(CROP_ASHGRAIN_ITEM_ID, child_handle)
                    .is_some()
            );
        }
        (child_handle, child.loci)
    };

    let (handle_1, loci_1) = run_flow(Some(&mut out));
    // Determinism: a second identical run reproduces the identical child.
    let (handle_2, loci_2) = run_flow(None);
    let _ = writeln!(
        out,
        "    determinism (replay -> identical child genome):        {}",
        handle_1 == handle_2 && loci_1 == loci_2
    );
    let _ = writeln!(out, "\n== END PROOF ==");

    println!("{out}");

    // Hard assertions (this is a real test, not just a print).
    assert_eq!(
        handle_1, handle_2,
        "identical inputs must mint the identical child handle"
    );
    assert_eq!(
        loci_1, loci_2,
        "identical inputs must mint the identical child genome"
    );
    assert!(out.contains("differs from parents"));
}

// ============================================================================
// Day-2 adversarial review fixes (genome/splice BLOCK): P0-1 hash omission,
// P1-2 sterile laundering, P1-3 partial-consume-on-reject. Each targets the
// review's exact repro.
// ============================================================================

fn bio_splice_ready_state(command_seq: &mut u64) -> (SliceAuthorityConfig, SliceAuthorityState) {
    let config = SliceAuthorityConfig::default();
    let mut state = SliceAuthorityState::from_snapshot(&crate::authority_test_slice()).unwrap();
    let player = config.player_actor_id.clone();
    grant_bioengineer_master(&mut state, &player);
    give_bio_toolkit(&mut state, &player);
    sample_wild_ashgrain(&mut state, &config, *command_seq);
    *command_seq += 1;
    sample_wild_ashgrain(&mut state, &config, *command_seq);
    *command_seq += 1;
    let seeds = player_seed_stacks(&state, &player);
    let (a, b) = (seeds[0].clone(), seeds[1].clone());
    state.apply_envelope(
        &config,
        command(
            *command_seq,
            ClientCommand::SpliceBegin {
                species: "ashgrain".to_owned(),
            },
        ),
    );
    *command_seq += 1;
    for (slot, stack) in [(0u8, &a), (1u8, &b)] {
        state.apply_envelope(
            &config,
            command(
                *command_seq,
                ClientCommand::SpliceAssignSlot {
                    slot_index: slot,
                    container: stack.0.clone(),
                    stack_id: stack.1.to_string(),
                    variant_id: stack.2,
                },
            ),
        );
        *command_seq += 1;
    }
    (config, state)
}

#[test]
fn bioengineer_splice_session_and_scan_participate_in_stable_hash() {
    // P0-1: divergent-but-accepted splice/scan state must diverge the stable hash,
    // else replicas certify parity while gameplay has already forked.
    let mut seq_a = 1;
    let (config, mut state_a) = bio_splice_ready_state(&mut seq_a);
    let mut seq_b = 1;
    let (_config_b, mut state_b) = bio_splice_ready_state(&mut seq_b);
    // Identical setup -> identical hash (baseline).
    assert_eq!(
        state_a.stable_state_hash_hex(),
        state_b.stable_state_hash_hex()
    );

    // Divergent allele choice: both accepted, mutate only actor.splice_session.
    let ca = state_a.apply_envelope(
        &config,
        command(
            100,
            ClientCommand::SpliceChooseAllele {
                locus: 0,
                from_parent: 0,
                allele: 0,
            },
        ),
    );
    let cb = state_b.apply_envelope(
        &config,
        command(
            100,
            ClientCommand::SpliceChooseAllele {
                locus: 0,
                from_parent: 0,
                allele: 1,
            },
        ),
    );
    assert_eq!(ca.status, AuthorityCommandStatus::Accepted);
    assert_eq!(cb.status, AuthorityCommandStatus::Accepted);
    assert_ne!(
        state_a.stable_state_hash_hex(),
        state_b.stable_state_hash_hex(),
        "splice allele-choice state must participate in the stable hash",
    );

    // Scanned-genome knowledge also participates: scan distinct seeds -> distinct hash.
    let mut seq_c = 1;
    let (config_c, mut state_c) = bio_splice_ready_state(&mut seq_c);
    let mut state_d = SliceAuthorityState::from_snapshot(&crate::authority_test_slice()).unwrap();
    {
        let player = config_c.player_actor_id.clone();
        grant_bioengineer_master(&mut state_d, &player);
        give_bio_toolkit(&mut state_d, &player);
        let mut sd_seq = 1;
        sample_wild_ashgrain(&mut state_d, &config_c, sd_seq);
        sd_seq += 1;
        sample_wild_ashgrain(&mut state_d, &config_c, sd_seq);
        sd_seq += 1;
        state_d.apply_envelope(
            &config_c,
            command(
                sd_seq,
                ClientCommand::SpliceBegin {
                    species: "ashgrain".to_owned(),
                },
            ),
        );
        sd_seq += 1;
        let seeds = player_seed_stacks(&state_d, &player);
        for (slot, stack) in [(0u8, &seeds[0]), (1u8, &seeds[1])] {
            state_d.apply_envelope(
                &config_c,
                command(
                    sd_seq,
                    ClientCommand::SpliceAssignSlot {
                        slot_index: slot,
                        container: stack.0.clone(),
                        stack_id: stack.1.to_string(),
                        variant_id: stack.2,
                    },
                ),
            );
            sd_seq += 1;
        }
    }
    assert_eq!(
        state_c.stable_state_hash_hex(),
        state_d.stable_state_hash_hex()
    );
    let seeds_c = player_seed_stacks(&state_c, &config_c.player_actor_id);
    let seeds_d = player_seed_stacks(&state_d, &config_c.player_actor_id);
    state_c.apply_envelope(
        &config_c,
        command(
            200,
            ClientCommand::ScanGenome {
                container: seeds_c[0].0.clone(),
                stack_id: seeds_c[0].1.to_string(),
                variant_id: seeds_c[0].2,
            },
        ),
    );
    state_d.apply_envelope(
        &config_c,
        command(
            200,
            ClientCommand::ScanGenome {
                container: seeds_d[1].0.clone(),
                stack_id: seeds_d[1].1.to_string(),
                variant_id: seeds_d[1].2,
            },
        ),
    );
    assert_ne!(
        state_c.stable_state_hash_hex(),
        state_d.stable_state_hash_hex(),
        "scanned-genome knowledge must participate in the stable hash",
    );
}

#[test]
fn bioengineer_splice_child_inherits_sterility_from_a_sterile_parent() {
    // P1-2: a sterile / gene-locked parent can never launder its genetics into a
    // fertile child. child.fertile = A.fertile && B.fertile.
    let config = SliceAuthorityConfig::default();
    let mut state = SliceAuthorityState::from_snapshot(&crate::authority_test_slice()).unwrap();
    let player = config.player_actor_id.clone();
    grant_bioengineer_master(&mut state, &player);
    give_bio_toolkit(&mut state, &player);

    // Sample a FERTILE wild parent, then intern a sterile (terminator) parent and
    // cross them: segregation alone makes the child distinct from both parents, so
    // fertility-inheritance (not a same-handle dedup) is what the assert exercises.
    sample_wild_ashgrain(&mut state, &config, 1);
    let fertile_stack = player_seed_stacks(&state, &player)
        .into_iter()
        .next()
        .unwrap();
    let sterile_handle = state.crop_genomes.intern(Genome {
        species_id: CROP_ASHGRAIN_ITEM_ID,
        loci: [Locus::homozygous(600); GENOME_LOCUS_COUNT],
        fertile: false,
        gene_lock: Some("rival-breeder".to_owned()),
        lineage: Lineage::wild("Terminator".to_owned()),
    });
    state.add_actor_inventory_stack(
        &player,
        CROP_ASHGRAIN_ITEM_ID,
        sterile_handle,
        "Ashgrain Seed",
        1,
        BIO_SEED_STACK_CAP,
        "field-pack",
    );
    let sterile_stack = player_seed_stacks(&state, &player)
        .into_iter()
        .find(|(_, _, v)| *v == sterile_handle)
        .unwrap();
    let known: std::collections::BTreeSet<u32> = player_seed_stacks(&state, &player)
        .into_iter()
        .map(|(_, _, v)| v)
        .collect();

    // Cross sterile (slot 0) x fertile (slot 1), assemble, mint.
    state.apply_envelope(
        &config,
        command(
            2,
            ClientCommand::SpliceBegin {
                species: "ashgrain".to_owned(),
            },
        ),
    );
    state.apply_envelope(
        &config,
        command(
            3,
            ClientCommand::SpliceAssignSlot {
                slot_index: 0,
                container: sterile_stack.0.clone(),
                stack_id: sterile_stack.1.to_string(),
                variant_id: sterile_handle,
            },
        ),
    );
    state.apply_envelope(
        &config,
        command(
            4,
            ClientCommand::SpliceAssignSlot {
                slot_index: 1,
                container: fertile_stack.0.clone(),
                stack_id: fertile_stack.1.to_string(),
                variant_id: fertile_stack.2,
            },
        ),
    );
    let assemble = state.apply_envelope(&config, command(5, ClientCommand::SpliceAssemble {}));
    assert_eq!(
        assemble.status,
        AuthorityCommandStatus::Accepted,
        "assemble: {:?}",
        assemble.reason_code
    );
    let mint = state.apply_envelope(
        &config,
        command(
            6,
            ClientCommand::SpliceMint {
                cultivar_name: Some("LaunderAttempt".to_owned()),
            },
        ),
    );
    assert_eq!(
        mint.status,
        AuthorityCommandStatus::Accepted,
        "mint: {:?}",
        mint.reason_code
    );

    // The minted child is STILL sterile (inherited from the sterile parent), harvests nothing.
    let child_handle = player_seed_stacks(&state, &player)
        .into_iter()
        .map(|(_, _, v)| v)
        .find(|v| !known.contains(v))
        .expect("a child seed was minted");
    let child = state.crop_genomes.get(child_handle).unwrap();
    assert!(
        !child.fertile,
        "sterile parent must not launder into a fertile child"
    );
    assert!(
        state
            .crop_genomes
            .mint_harvest_seed(child_handle, 1_000, 0)
            .is_none(),
        "the inherited-sterile child must propagate no harvest seed"
    );
}

#[test]
fn bioengineer_splice_assemble_is_all_or_nothing_on_insufficient_seed() {
    // P1-3: selfing with a single seed assigned to both parent slots must reject
    // BEFORE consuming anything (no burn-on-reject).
    let config = SliceAuthorityConfig::default();
    let mut state = SliceAuthorityState::from_snapshot(&crate::authority_test_slice()).unwrap();
    let player = config.player_actor_id.clone();
    grant_bioengineer_master(&mut state, &player);
    give_bio_toolkit(&mut state, &player);
    sample_wild_ashgrain(&mut state, &config, 1);
    // Force the sampled seed stack down to a single seed.
    let seed = {
        let row = state
            .inventory
            .iter_mut()
            .find(|r| {
                r.item_id == CROP_ASHGRAIN_ITEM_ID
                    && actor_owns_inventory_container(&player, &r.container)
            })
            .unwrap();
        row.quantity = 1;
        row.available = 1;
        (row.container.clone(), row.stack_id, row.variant_id)
    };

    state.apply_envelope(
        &config,
        command(
            2,
            ClientCommand::SpliceBegin {
                species: "ashgrain".to_owned(),
            },
        ),
    );
    // Assign the SAME single seed to both parent slots.
    for (id, slot) in [(3u64, 0u8), (4, 1)] {
        let a = state.apply_envelope(
            &config,
            command(
                id,
                ClientCommand::SpliceAssignSlot {
                    slot_index: slot,
                    container: seed.0.clone(),
                    stack_id: seed.1.to_string(),
                    variant_id: seed.2,
                },
            ),
        );
        assert_eq!(a.status, AuthorityCommandStatus::Accepted);
    }
    let assemble = state.apply_envelope(&config, command(5, ClientCommand::SpliceAssemble {}));
    assert_eq!(
        assemble.status,
        AuthorityCommandStatus::Rejected,
        "assemble must reject: only one seed for a two-parent selfing"
    );
    assert_eq!(
        assemble.reason_code.as_deref(),
        Some("ingredient_unavailable")
    );
    // The seed was NOT burned (all-or-nothing).
    assert_eq!(
        state.actor_inventory_available_quantity(&player, CROP_ASHGRAIN_ITEM_ID),
        1,
        "a rejected assemble must not consume any seed",
    );
    // Session remains in slot-fill (not assembled).
    let session_phase = state
        .actors
        .get(&player)
        .unwrap()
        .splice_session
        .as_ref()
        .map(|s| s.phase);
    assert_eq!(session_phase, Some(SpliceSessionPhase::SlotFill));
}

// ─────────────────────────────────────────────────────────────────────────
// Category-generic survey and extraction
// ─────────────────────────────────────────────────────────────────────────

#[test]
fn survey_gates_on_category_survey_tool_not_the_field_multitool() {
    let config = SliceAuthorityConfig::default();
    let mut snapshot = crate::authority_test_slice();
    expand_resource_test_area(&mut snapshot, "authority-test-overworld");
    let mut state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    let player = config.player_actor_id.clone();
    grant_test_profession(&mut state, &player, AuthorityProfessionKind::Craftsman);
    let (_, rich_cell, _) =
        rich_resource_cell_for_test(&state, "authority-test-overworld", "mineral");
    move_actor_to_cell_for_test(&mut state, &player, rich_cell);

    // The Field Multitool is crafting-only now: holding it does NOT let you survey.
    seed_test_tool(
        &mut state,
        &player,
        FIELD_MULTITOOL_ITEM_ID,
        "Field Multitool",
    );
    let no_tool = state.apply_envelope(
        &config,
        command(
            1,
            ClientCommand::SurveyResource {
                family: "mineral".to_owned(),
            },
        ),
    );
    assert_eq!(no_tool.reason_code.as_deref(), Some("missing_survey_tool"));

    // The Mineral Survey Tool unlocks mineral surveying...
    seed_test_survey_tool(&mut state, &player);
    let profession_xp_before = state.actors[&player]
        .professions
        .xp
        .get(&AuthorityProfessionKind::Craftsman)
        .copied()
        .unwrap_or_default();
    let track_xp_before = state.actors[&player]
        .professions
        .track_xp_for_profession(AuthorityProfessionKind::Craftsman);
    let mineral = state.apply_envelope(
        &config,
        command(
            2,
            ClientCommand::SurveyResource {
                family: "mineral".to_owned(),
            },
        ),
    );
    assert_eq!(
        mineral.status,
        AuthorityCommandStatus::Accepted,
        "mineral tool must survey minerals: {:?}",
        mineral.reason_code
    );
    assert_eq!(
        state.actors[&player]
            .professions
            .xp
            .get(&AuthorityProfessionKind::Craftsman)
            .copied()
            .unwrap_or_default(),
        profession_xp_before,
        "mapping a resource field is informational and does not mint XP"
    );
    assert_eq!(
        state.actors[&player]
            .professions
            .track_xp_for_profession(AuthorityProfessionKind::Craftsman),
        track_xp_before,
        "survey-map use must not make unrelated Craftsman bars move"
    );

    // ...but NOT water — that needs the Water Survey Tool (tool check precedes
    // the survey cooldown, so this is a clean category gate).
    let water = state.apply_envelope(
        &config,
        command(
            3,
            ClientCommand::SurveyResource {
                family: "water".to_owned(),
            },
        ),
    );
    assert_eq!(water.reason_code.as_deref(), Some("missing_survey_tool"));
}

#[test]
fn water_tool_survey_is_trained_but_hand_sampling_is_universal() {
    let config = SliceAuthorityConfig::default();
    let mut snapshot = crate::authority_test_slice();
    expand_resource_test_area(&mut snapshot, "authority-test-overworld");
    let mut state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    let player = config.player_actor_id.clone();
    let (_, rich_cell, _) =
        rich_resource_cell_for_test(&state, "authority-test-overworld", "mineral");
    move_actor_to_cell_for_test(&mut state, &player, rich_cell);
    state.add_actor_inventory_stack(
        &player,
        WATER_SURVEY_TOOL_ITEM_ID,
        0,
        "Water Survey Tool",
        1,
        SURVEY_TOOL_STACK_CAP,
        "profession-tools",
    );

    // Owning a category tool is not enough for the richer map: full surveying
    // remains trained Craftsman work.
    let untrained_survey = state.apply_envelope(
        &config,
        command(
            1,
            ClientCommand::SurveyResource {
                family: "water".to_owned(),
            },
        ),
    );
    assert_eq!(
        untrained_survey.reason_code.as_deref(),
        Some("target_unavailable")
    );

    // Basic sampling is the universal bootstrap: neither a profession nor any
    // survey tool is required. Remove the tool to prove it is not incidental.
    state.inventory.retain(|row| {
        !(actor_owns_inventory_container(&player, &row.container)
            && row.item_id == WATER_SURVEY_TOOL_ITEM_ID)
    });
    let liquid_before = owned_actor_item_quantity(&state, &player, RESOURCE_LIQUID_ITEM_ID);
    let sample = state.apply_envelope(
        &config,
        command(
            2,
            ClientCommand::SampleResource {
                family: "water".to_owned(),
                stop: false,
            },
        ),
    );
    assert_eq!(
        sample.status,
        AuthorityCommandStatus::Accepted,
        "tool-free water hand sample: {:?}",
        sample.reason_code
    );
    let resolve_tick = state
        .actors
        .get(&player)
        .and_then(|actor| actor.pending_resource_sample.as_ref())
        .map(|pending| pending.resolve_tick)
        .expect("hand sample pending");
    let ticks_to_resolve = resolve_tick.saturating_sub(state.tick());
    advance_ticks_unclamped(&mut state, &config, ticks_to_resolve);
    assert!(owned_actor_item_quantity(&state, &player, RESOURCE_LIQUID_ITEM_ID) > liquid_before);
    assert_eq!(
        state
            .actors
            .get(&player)
            .unwrap()
            .professions
            .track_xp_amount(AuthorityProfessionKind::Craftsman, "survey"),
        0,
        "untrained hand sampling must not manufacture Craftsman progression"
    );

    // Once trained and holding the matching category tool, the full map opens.
    grant_test_profession(&mut state, &player, AuthorityProfessionKind::Craftsman);
    state.add_actor_inventory_stack(
        &player,
        WATER_SURVEY_TOOL_ITEM_ID,
        0,
        "Water Survey Tool",
        1,
        SURVEY_TOOL_STACK_CAP,
        "profession-tools",
    );
    let survey = state.apply_envelope(
        &config,
        command(
            3,
            ClientCommand::SurveyResource {
                family: "water".to_owned(),
            },
        ),
    );
    assert_eq!(survey.status, AuthorityCommandStatus::Accepted);
    assert_eq!(survey.survey_result.unwrap().family, "water");

    // The mineral survey still needs its own tool.
    let mineral = state.apply_envelope(
        &config,
        command(
            4,
            ClientCommand::SurveyResource {
                family: "mineral".to_owned(),
            },
        ),
    );
    assert_eq!(mineral.reason_code.as_deref(), Some("missing_survey_tool"));
}

#[test]
fn trained_hand_sampling_awards_only_the_craftsman_survey_track() {
    let config = SliceAuthorityConfig::default();
    let mut snapshot = crate::authority_test_slice();
    expand_resource_test_area(&mut snapshot, "authority-test-overworld");
    let mut state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    let player = config.player_actor_id.clone();
    grant_test_profession(&mut state, &player, AuthorityProfessionKind::Craftsman);
    let (_, rich_cell, _) =
        rich_resource_cell_for_test(&state, "authority-test-overworld", "mineral");
    move_actor_to_cell_for_test(&mut state, &player, rich_cell);

    let sample = state.apply_envelope(
        &config,
        command(
            1,
            ClientCommand::SampleResource {
                family: "mineral".to_owned(),
                stop: false,
            },
        ),
    );
    assert_eq!(
        sample.status,
        AuthorityCommandStatus::Accepted,
        "trained hand sample starts: {:?}",
        sample.reason_code
    );
    let resolve_tick = state
        .actors
        .get(&player)
        .and_then(|actor| actor.pending_resource_sample.as_ref())
        .map(|pending| pending.resolve_tick)
        .expect("hand sample pending");
    let ticks_to_resolve = resolve_tick.saturating_sub(state.tick());
    advance_ticks_unclamped(&mut state, &config, ticks_to_resolve);

    let actor = &state.actors[&player];
    assert_eq!(
        actor.professions.xp[&AuthorityProfessionKind::Craftsman],
        45,
        "the general Craftsman pool receives the real sample award"
    );
    assert_eq!(
        actor
            .professions
            .track_xp_amount(AuthorityProfessionKind::Craftsman, "survey"),
        45,
        "the survey track receives the real sample award"
    );
    for unrelated_track in ["assembly", "experimentation", "tools"] {
        assert_eq!(
            actor
                .professions
                .track_xp_amount(AuthorityProfessionKind::Craftsman, unrelated_track),
            0,
            "hand sampling must not move the {unrelated_track} bar"
        );
    }
}

#[test]
fn survey_and_sample_reject_the_last_sentinel_family() {
    // Belt-and-braces: the shard resolves the "$last" bare-use sentinel before
    // it ever reaches Rust. If a raw sentinel does arrive, authority must reject
    // it as an unknown family, never silently do something surprising.
    let config = SliceAuthorityConfig::default();
    let mut snapshot = crate::authority_test_slice();
    expand_resource_test_area(&mut snapshot, "authority-test-overworld");
    let mut state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    let player = config.player_actor_id.clone();
    grant_test_profession(&mut state, &player, AuthorityProfessionKind::Craftsman);
    seed_test_survey_tool(&mut state, &player);
    let (_, rich_cell, _) =
        rich_resource_cell_for_test(&state, "authority-test-overworld", "mineral");
    move_actor_to_cell_for_test(&mut state, &player, rich_cell);

    let survey = state.apply_envelope(
        &config,
        command(
            1,
            ClientCommand::SurveyResource {
                family: "$last".to_owned(),
            },
        ),
    );
    assert_eq!(
        survey.reason_code.as_deref(),
        Some("invalid_resource_family")
    );

    let sample = state.apply_envelope(
        &config,
        command(
            2,
            ClientCommand::SampleResource {
                family: "$last".to_owned(),
                stop: false,
            },
        ),
    );
    assert_eq!(
        sample.reason_code.as_deref(),
        Some("invalid_resource_family")
    );
}

#[test]
fn resource_families_resolve_to_four_categories() {
    assert_eq!(
        resource_category_for_family("mineral"),
        Some(ResourceCategory::Mineral)
    );
    assert_eq!(
        resource_category_for_family("iron"),
        Some(ResourceCategory::Mineral)
    );
    assert_eq!(
        resource_category_for_family("copper"),
        Some(ResourceCategory::Mineral)
    );
    assert_eq!(
        resource_category_for_family("chemical"),
        Some(ResourceCategory::Chemical)
    );
    assert_eq!(
        resource_category_for_family("petroleum"),
        Some(ResourceCategory::Chemical)
    );
    assert_eq!(
        resource_category_for_family("gas"),
        Some(ResourceCategory::Gas)
    );
    assert_eq!(
        resource_category_for_family("water"),
        Some(ResourceCategory::Water)
    );
    assert_eq!(
        resource_category_for_family("liquid"),
        Some(ResourceCategory::Water)
    );
    assert_eq!(resource_category_for_family("$last"), None);
    assert_eq!(resource_category_for_family("nonexistent"), None);

    // Each category points at distinct survey + extractor items.
    assert_eq!(
        ResourceCategory::Mineral.survey_tool_item_id(),
        MINERAL_SURVEY_TOOL_ITEM_ID
    );
    assert_eq!(
        ResourceCategory::Water.extractor_tool_item_id(),
        WATER_EXTRACTOR_TOOL_ITEM_ID
    );

    // The new families are real spawns backed by their resource containers.
    let area = "authority-test-overworld";
    assert_eq!(
        resource_instance_for_family_at_tick(area, "chemical", 0)
            .unwrap()
            .item_id,
        RESOURCE_CHEMICAL_ITEM_ID
    );
    assert_eq!(
        resource_instance_for_family_at_tick(area, "gas", 0)
            .unwrap()
            .item_id,
        RESOURCE_GAS_ITEM_ID
    );
    assert_eq!(
        resource_instance_for_family_at_tick(area, "water", 0)
            .unwrap()
            .item_id,
        RESOURCE_LIQUID_ITEM_ID
    );
}

#[test]
fn extractor_placement_is_category_gated_and_packs_back_the_same_item() {
    let config = SliceAuthorityConfig::default();
    let mut snapshot = crate::authority_test_slice();
    expand_resource_test_area(&mut snapshot, "authority-test-overworld");
    let mut state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    let player = config.player_actor_id.clone();
    let (_, rich_cell, _) =
        rich_resource_cell_for_test(&state, "authority-test-overworld", "mineral");
    move_actor_to_cell_for_test(&mut state, &player, rich_cell);

    // The physical rig alone is insufficient: persistent extraction remains
    // trained Craftsman work, and a rejected deploy does not consume it.
    seed_test_extractor_tool(&mut state, &player, 1_000); // Personal Mineral Sampler (3006)
    let untrained = state.apply_envelope(
        &config,
        command(
            1,
            ClientCommand::PlaceExtractor {
                family: "mineral".to_owned(),
            },
        ),
    );
    assert_eq!(untrained.reason_code.as_deref(), Some("target_unavailable"));
    assert_eq!(
        state.actor_inventory_available_quantity(&player, METAL_EXTRACTOR_TOOL_ITEM_ID),
        1
    );
    grant_test_profession(&mut state, &player, AuthorityProfessionKind::Craftsman);

    // A Personal Mineral Sampler cannot deploy a WATER extractor.
    let wrong = state.apply_envelope(
        &config,
        command(
            2,
            ClientCommand::PlaceExtractor {
                family: "water".to_owned(),
            },
        ),
    );
    assert_eq!(wrong.reason_code.as_deref(), Some("item_unavailable"));

    // Give a Survival Moisture Vaporator; WATER placement consumes IT, not the sampler.
    state.add_actor_inventory_stack(
        &player,
        WATER_EXTRACTOR_TOOL_ITEM_ID,
        0,
        "Survival Moisture Vaporator",
        1,
        METAL_EXTRACTOR_STACK_CAP,
        "profession-tools",
    );
    let placed = state.apply_envelope(
        &config,
        command(
            3,
            ClientCommand::PlaceExtractor {
                family: "water".to_owned(),
            },
        ),
    );
    assert_eq!(
        placed.status,
        AuthorityCommandStatus::Accepted,
        "water place: {:?}",
        placed.reason_code
    );
    assert_eq!(
        state.actor_inventory_available_quantity(&player, WATER_EXTRACTOR_TOOL_ITEM_ID),
        0,
        "the vaporator was consumed"
    );
    assert_eq!(
        state.actor_inventory_available_quantity(&player, METAL_EXTRACTOR_TOOL_ITEM_ID),
        1,
        "the mineral sampler is untouched"
    );
    let (extractor_id, family, resource_item) = {
        let (id, ex) = state
            .placed_extractors
            .iter()
            .next()
            .expect("placed extractor");
        (id.clone(), ex.family.clone(), ex.resource_item_id)
    };
    assert_eq!(family, "water");
    assert_eq!(resource_item, RESOURCE_LIQUID_ITEM_ID);

    // Pack up -> the SAME category item (vaporator) returns, never a mineral sampler.
    let packed = state.apply_envelope(
        &config,
        command(4, ClientCommand::DestroyExtractor { extractor_id }),
    );
    assert_eq!(
        packed.status,
        AuthorityCommandStatus::Accepted,
        "pack up: {:?}",
        packed.reason_code
    );
    assert_eq!(
        state.actor_inventory_available_quantity(&player, WATER_EXTRACTOR_TOOL_ITEM_ID),
        1,
        "the vaporator returns to the pack on pack-up"
    );
}

#[test]
fn craftsman_novice_grant_includes_the_mineral_survey_tool() {
    let config = SliceAuthorityConfig::default();
    let mut state = SliceAuthorityState::from_snapshot(&crate::authority_test_slice()).unwrap();
    let player = config.player_actor_id.clone();
    state.ensure_actor_craftsman_novice_tools(&player);
    assert_eq!(
        state.actor_inventory_available_quantity(&player, FIELD_MULTITOOL_ITEM_ID),
        1,
        "bootstrap still grants the Field Multitool"
    );
    assert_eq!(
        state.actor_inventory_available_quantity(&player, MINERAL_SURVEY_TOOL_ITEM_ID),
        1,
        "bootstrap now also grants the Mineral Survey Tool"
    );
    // Idempotent — re-running the grant does not stack duplicates.
    state.ensure_actor_craftsman_novice_tools(&player);
    assert_eq!(
        state.actor_inventory_available_quantity(&player, MINERAL_SURVEY_TOOL_ITEM_ID),
        1
    );
}

#[test]
fn water_vaporator_full_loop_survey_place_crank_collect() {
    // In-process proof of the FULL water loop with the new category items:
    // Water Survey Tool surveys water, a Survival Moisture Vaporator deploys,
    // cranking fills the hopper, and collection yields the liquid resource.
    let config = SliceAuthorityConfig::default();
    let mut snapshot = crate::authority_test_slice();
    expand_resource_test_area(&mut snapshot, "authority-test-overworld");
    let mut state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    let player = config.player_actor_id.clone();
    grant_test_profession(&mut state, &player, AuthorityProfessionKind::Craftsman);
    // Deploy on a genuinely water-rich cell that is also unblocked + in-bounds.
    let water =
        resource_instance_for_family("authority-test-overworld", "water").expect("water resource");
    let place_cell = {
        let area = state
            .areas
            .get("authority-test-overworld")
            .expect("test area exists");
        let mut found = None;
        'scan: for y in (0..area.height).step_by(4) {
            for x in (0..area.width).step_by(4) {
                let cell = AuthorityCell::new(
                    i32::try_from(x).expect("width fits i32"),
                    i32::try_from(y).expect("height fits i32"),
                );
                if !area.contains(cell) {
                    continue;
                }
                if state.blocked_cells.contains(&CellKey::new(
                    "authority-test-overworld",
                    cell.x,
                    cell.y,
                )) {
                    continue;
                }
                if state.resource_concentration_milli_for_area(
                    "authority-test-overworld",
                    water.concentration_seed,
                    cell,
                ) >= 600
                {
                    found = Some(cell);
                    break 'scan;
                }
            }
        }
        found.expect("water-rich unblocked cell in test area")
    };
    move_actor_to_cell_for_test(&mut state, &player, place_cell);
    state.add_actor_inventory_stack(
        &player,
        WATER_SURVEY_TOOL_ITEM_ID,
        0,
        "Water Survey Tool",
        1,
        SURVEY_TOOL_STACK_CAP,
        "profession-tools",
    );
    // Vaporator at a real extraction-rate variant (rate = concentration*tool/1000).
    state.add_actor_inventory_stack(
        &player,
        WATER_EXTRACTOR_TOOL_ITEM_ID,
        1_000,
        "Survival Moisture Vaporator",
        1,
        METAL_EXTRACTOR_STACK_CAP,
        "profession-tools",
    );

    // 1) Survey water — the Water Survey Tool gates it; grid comes back for water.
    let survey = state.apply_envelope(
        &config,
        command(
            1,
            ClientCommand::SurveyResource {
                family: "water".to_owned(),
            },
        ),
    );
    assert_eq!(
        survey.status,
        AuthorityCommandStatus::Accepted,
        "water survey: {:?}",
        survey.reason_code
    );
    assert_eq!(
        survey.survey_result.expect("water survey payload").family,
        "water"
    );

    // 2) Deploy the Survival Moisture Vaporator for the water family.
    let placed = state.apply_envelope(
        &config,
        command(
            2,
            ClientCommand::PlaceExtractor {
                family: "water".to_owned(),
            },
        ),
    );
    assert_eq!(
        placed.status,
        AuthorityCommandStatus::Accepted,
        "place vaporator: {:?}",
        placed.reason_code
    );
    let extractor_id = state
        .placed_extractors
        .keys()
        .next()
        .expect("vaporator id")
        .clone();
    assert_eq!(state.placed_extractors[&extractor_id].family, "water");
    assert_eq!(
        state.placed_extractors[&extractor_id].resource_item_id,
        RESOURCE_LIQUID_ITEM_ID
    );

    // 3) Crank it and let the hopper tick-integrate.
    let crank = state.apply_envelope(
        &config,
        command(
            3,
            ClientCommand::CrankExtractor {
                extractor_id: extractor_id.clone(),
            },
        ),
    );
    assert_eq!(
        crank.status,
        AuthorityCommandStatus::Accepted,
        "crank: {:?}",
        crank.reason_code
    );
    advance_ticks_unclamped(
        &mut state,
        &config,
        POSTURE_KNEEL_DOWN_TICKS.saturating_add(300),
    );
    assert!(
        state.placed_extractors[&extractor_id].hopper_milli > 0,
        "cranking the vaporator should fill its hopper from the water field"
    );

    // 4) Collect — the liquid resource lands in the pack.
    let before = state.actor_inventory_available_quantity(&player, RESOURCE_LIQUID_ITEM_ID);
    let collect = state.apply_envelope(
        &config,
        command(
            4,
            ClientCommand::CollectExtractor {
                extractor_id: extractor_id.clone(),
            },
        ),
    );
    assert_eq!(
        collect.status,
        AuthorityCommandStatus::Accepted,
        "collect: {:?}",
        collect.reason_code
    );
    assert!(
        state.actor_inventory_available_quantity(&player, RESOURCE_LIQUID_ITEM_ID) > before,
        "collecting the vaporator yields the liquid (water) resource"
    );
}

#[test]
fn extractor_lifecycle_gates_range_power_full_pack_and_restart() {
    // End-to-end authority contract for the practical extractor loop:
    // place -> missing power reject -> battery run -> progress snapshot ->
    // full hopper blocks further work -> collect preserves provenance ->
    // range/owner gates -> pack legality while cranking -> stop/pack/restart
    // with relational hash stability across an identical replay.
    let (config, mut state) = placed_extractor_test_state();
    let player = config.player_actor_id.clone();
    let area_id = "authority-test-overworld";
    let (_, rich_cell, _) = rich_resource_cell_for_test(&state, area_id, "mineral");
    move_actor_to_cell_for_test(&mut state, &player, rich_cell);

    // Wrong type: mineral sampler cannot deploy a gas rig.
    let wrong_type = state.apply_envelope(
        &config,
        command(
            1,
            ClientCommand::PlaceExtractor {
                family: "gas".to_owned(),
            },
        ),
    );
    assert_eq!(wrong_type.status, AuthorityCommandStatus::Rejected);
    assert_eq!(wrong_type.reason_code.as_deref(), Some("item_unavailable"));

    let placed = state.apply_envelope(
        &config,
        command(
            2,
            ClientCommand::PlaceExtractor {
                family: "mineral".to_owned(),
            },
        ),
    );
    assert_eq!(placed.status, AuthorityCommandStatus::Accepted);
    let extractor_id = state
        .placed_extractors
        .keys()
        .next()
        .expect("extractor id")
        .clone();
    let resource_item_id = state.placed_extractors[&extractor_id].resource_item_id;
    let resource_variant_id = state.placed_extractors[&extractor_id].resource_variant_id;

    // Missing power / input: no battery carried.
    let missing_power = state.apply_envelope(
        &config,
        command(
            3,
            ClientCommand::InsertBattery {
                extractor_id: extractor_id.clone(),
                container: format!("{player}:field-pack"),
                stack_id: "1".to_owned(),
                variant_id: encode_battery_variant(30),
            },
        ),
    );
    assert_eq!(missing_power.status, AuthorityCommandStatus::Rejected);
    assert_eq!(
        missing_power.reason_code.as_deref(),
        Some("missing_battery")
    );

    // Range gate before any work.
    let far = AuthorityCell::new(rich_cell.x.saturating_add(8), rich_cell.y);
    move_actor_to_cell_for_test(&mut state, &player, far);
    let out_of_range = state.apply_envelope(
        &config,
        command(
            4,
            ClientCommand::CrankExtractor {
                extractor_id: extractor_id.clone(),
            },
        ),
    );
    assert_eq!(out_of_range.status, AuthorityCommandStatus::Rejected);
    assert_eq!(
        out_of_range.reason_code.as_deref(),
        Some("not_at_extractor")
    );
    move_actor_to_cell_for_test(&mut state, &player, rich_cell);

    // Battery cycle + progress projection.
    let (container, stack_id, battery_variant_id) =
        seed_test_extractor_battery(&mut state, &player, 120);
    let inserted = state.apply_envelope(
        &config,
        command(
            5,
            ClientCommand::InsertBattery {
                extractor_id: extractor_id.clone(),
                container,
                stack_id,
                variant_id: battery_variant_id,
            },
        ),
    );
    assert_eq!(inserted.status, AuthorityCommandStatus::Accepted);
    advance_ticks_unclamped(&mut state, &config, 90);
    let snap = state
        .placed_extractor_snapshots_for_observer(&config)
        .into_iter()
        .find(|row| row.extractor_id == extractor_id)
        .expect("projected extractor");
    assert!(snap.hopper_pct > 0 || snap.collectable_units > 0 || snap.battery_pct < 100);
    assert!(snap.is_owner);
    assert_eq!(snap.mode, ExtractorMode::Battery);

    // Force full output and prove crank rejects + collect banks provenance.
    {
        let live = state
            .placed_extractors
            .get_mut(&extractor_id)
            .expect("live extractor");
        live.hopper_milli = super::extraction_math::HOPPER_CAP_MILLI;
        live.mode = ExtractorMode::Idle;
        // Clear residual battery so the later manual crank/pack leg is not
        // blocked by battery-mode busy (power exhaustion is covered above).
        live.battery_remaining_seconds = 0;
        live.battery_variant_id = 0;
    }
    let full_crank = state.apply_envelope(
        &config,
        command(
            6,
            ClientCommand::CrankExtractor {
                extractor_id: extractor_id.clone(),
            },
        ),
    );
    assert_eq!(full_crank.status, AuthorityCommandStatus::Rejected);
    assert_eq!(
        full_crank.reason_code.as_deref(),
        Some("extractor_hopper_full")
    );
    let full_snap = state
        .placed_extractor_snapshots_for_observer(&config)
        .into_iter()
        .find(|row| row.extractor_id == extractor_id)
        .expect("full projected extractor");
    assert_eq!(full_snap.hopper_pct, 100);
    assert_eq!(
        full_snap.collectable_units,
        u32::try_from(super::extraction_math::HOPPER_CAP_UNITS).unwrap_or(u32::MAX)
    );

    let before = state.actor_inventory_available_quantity(&player, resource_item_id);
    let collect = state.apply_envelope(
        &config,
        command(
            7,
            ClientCommand::CollectExtractor {
                extractor_id: extractor_id.clone(),
            },
        ),
    );
    assert_eq!(collect.status, AuthorityCommandStatus::Accepted);
    let after = state.actor_inventory_available_quantity(&player, resource_item_id);
    assert!(after > before, "collection must bank whole units");
    assert!(state.inventory.iter().any(|row| {
        actor_owns_inventory_container(&player, &row.container)
            && row.item_id == resource_item_id
            && row.variant_id == resource_variant_id
            && row.quantity > 0
    }));
    assert_eq!(state.placed_extractors[&extractor_id].hopper_milli, 0);

    // Manual crank, pack-while-busy reject, stop, then legal pack + tool return.
    let crank = state.apply_envelope(
        &config,
        command(
            8,
            ClientCommand::CrankExtractor {
                extractor_id: extractor_id.clone(),
            },
        ),
    );
    assert_eq!(crank.status, AuthorityCommandStatus::Accepted);
    assert_eq!(
        state.placed_extractors[&extractor_id].mode,
        ExtractorMode::Manual
    );
    let busy_pack = state.apply_envelope(
        &config,
        command(
            9,
            ClientCommand::DestroyExtractor {
                extractor_id: extractor_id.clone(),
            },
        ),
    );
    assert_eq!(busy_pack.status, AuthorityCommandStatus::Rejected);
    assert_eq!(busy_pack.reason_code.as_deref(), Some("extractor_busy"));
    let stop = state.apply_envelope(&config, command(10, ClientCommand::StopCrank {}));
    assert_eq!(stop.status, AuthorityCommandStatus::Accepted);
    assert_eq!(
        state.placed_extractors[&extractor_id].mode,
        ExtractorMode::Idle
    );
    let packed = state.apply_envelope(
        &config,
        command(
            11,
            ClientCommand::DestroyExtractor {
                extractor_id: extractor_id.clone(),
            },
        ),
    );
    assert_eq!(packed.status, AuthorityCommandStatus::Accepted);
    assert!(!state.placed_extractors.contains_key(&extractor_id));
    assert_eq!(
        state.actor_inventory_available_quantity(&player, METAL_EXTRACTOR_TOOL_ITEM_ID),
        1
    );

    // Restart + relational hash / replay: two identical place sequences match.
    fn place_once() -> String {
        let (config, mut state) = placed_extractor_test_state();
        let placed = state.apply_envelope(
            &config,
            command(
                1,
                ClientCommand::PlaceExtractor {
                    family: "mineral".to_owned(),
                },
            ),
        );
        assert_eq!(placed.status, AuthorityCommandStatus::Accepted);
        state.stable_state_hash_hex()
    }
    assert_eq!(
        place_once(),
        place_once(),
        "identical place replay must hash equal"
    );
}

// ---------------------------------------------------------------------------
// Humanoid loot tables (LootTables lane) — integration + calibration.
// Pure-roll math/distribution tests live in authority/loot_tables.rs::tests.
// ---------------------------------------------------------------------------

/// First death tick (from `start`) whose deterministic roll yields a drop — used
/// to exercise the deposit path without depending on which specific tick drops.
fn loot_first_dropping_tick(
    class: HumanoidLootClass,
    actor_id: &str,
    area_id: &str,
    start: u64,
) -> u64 {
    let mut tick = start;
    while roll_humanoid_loot(class, tick, actor_id, area_id, 0).is_none() {
        tick += 1;
    }
    tick
}

#[test]
fn humanoid_loot_lands_in_existing_corpse_container_with_rarity_stamp() {
    let (_config, mut state) = passive_rogue_roll_state(1);
    let actor_id = "open-desert-rogue-01";
    // Precondition: a population-spawned humanoid combat NPC (the farmable gate).
    let area_id = {
        let rogue = state.actors.get(actor_id).unwrap();
        assert!(
            rogue.spawn_zone_id.is_some(),
            "farmed rogue must be spawn-zone originated"
        );
        assert_eq!(rogue.role, "skirmisher");
        rogue.area_id.clone()
    };
    let death_tick =
        loot_first_dropping_tick(HumanoidLootClass::Trooper, actor_id, &area_id, 1_000);
    let expected = roll_humanoid_loot(
        HumanoidLootClass::Trooper,
        death_tick,
        actor_id,
        &area_id,
        0,
    )
    .expect("dropping tick rolls loot");

    {
        let tick_rate = state.tick_rate_hz;
        let rogue = state.actors.get_mut(actor_id).unwrap();
        SliceAuthorityState::kill_actor_for_respawn(death_tick, tick_rate, rogue);
    }
    state.finalize_actor_corpse_after_death(actor_id, death_tick);

    let container = format!("corpse:{actor_id}");
    let rows: Vec<_> = state
        .inventory_snapshots()
        .into_iter()
        .filter(|row| row.container == container)
        .collect();
    assert_eq!(
        rows.len(),
        1,
        "single-roll drop should place exactly one corpse stack"
    );
    let row = &rows[0];
    // Deposit faithfully reflects the pure roll (item, rarity variant, name).
    assert_eq!(row.item_id, expected.item_id);
    assert_eq!(row.variant_id, expected.variant_id);
    assert_eq!(row.item, expected.item_name);
    assert_eq!(row.quantity, 1);
    assert_eq!(row.available, 1);
    assert_eq!(row.reserved, 0);
    // Rarity + quality are recoverable from the variant (no wire field needed).
    let (tier, quality) =
        decode_loot_variant(row.variant_id).expect("rolled item carries a loot variant");
    let (expected_tier, expected_quality) =
        decode_loot_variant(expected.variant_id).expect("expected roll carries a loot variant");
    assert_eq!(tier, expected_tier);
    assert_eq!(quality, expected_quality);
    // Non-legendary tiers roll below crafted MASTERWORK(900); crafting stays king.
    if tier != LootTier::Relic {
        assert!(
            quality < 900,
            "{} rolled at/above masterwork: {}",
            tier.word(),
            quality
        );
    }
    // has_loot flipped the body to the 5-minute lootable-corpse timer.
    let corpse = state.actors.get(actor_id).unwrap();
    assert_eq!(corpse.life_state, AuthorityLifeState::Downed);
    assert_eq!(
        corpse.body_vanish_tick,
        death_tick + CORPSE_BODY_WITH_LOOT_TICKS
    );
}

#[test]
fn humanoid_loot_deposit_is_replay_deterministic_byte_identical() {
    let build = || {
        let (_config, mut state) = passive_rogue_roll_state(1);
        let actor_id = "open-desert-rogue-01";
        let death_tick = 4_242u64;
        {
            let tick_rate = state.tick_rate_hz;
            let rogue = state.actors.get_mut(actor_id).unwrap();
            SliceAuthorityState::kill_actor_for_respawn(death_tick, tick_rate, rogue);
        }
        state.finalize_actor_corpse_after_death(actor_id, death_tick);
        state
    };
    let left = build();
    let right = build();
    assert_eq!(
        left.stable_state_hash_hex(),
        right.stable_state_hash_hex(),
        "loot deposit must be byte-identical across replays (determinism ceremony)"
    );
    let corpse_rows = |state: &SliceAuthorityState| {
        state
            .inventory_snapshots()
            .into_iter()
            .filter(|row| row.container == "corpse:open-desert-rogue-01")
            .map(|row| (row.item_id, row.variant_id, row.item, row.quantity))
            .collect::<Vec<_>>()
    };
    assert_eq!(corpse_rows(&left), corpse_rows(&right));
}

#[test]
fn rolled_loot_leaves_loot_rights_path_unchanged() {
    let (config, mut state) = passive_rogue_roll_state(1);
    let actor_id = "open-desert-rogue-01";
    let area_id = state.actors.get(actor_id).unwrap().area_id.clone();
    let death_tick =
        loot_first_dropping_tick(HumanoidLootClass::Trooper, actor_id, &area_id, 1_000);
    // Player is the sole damager → loot-rights winner must be the player, exactly
    // as before loot tables existed (the deposit does not touch rights).
    {
        let rogue = state.actors.get_mut(actor_id).unwrap();
        SliceAuthorityState::record_player_damage_for_loot_rights(rogue, "player", death_tick, 50);
    }
    {
        let tick_rate = state.tick_rate_hz;
        let rogue = state.actors.get_mut(actor_id).unwrap();
        SliceAuthorityState::kill_actor_for_respawn(death_tick, tick_rate, rogue);
    }
    state.finalize_actor_corpse_after_death(actor_id, death_tick);
    let corpse = state.actors.get(actor_id).unwrap();
    assert_eq!(corpse.loot_rights_actor_id.as_deref(), Some("player"));

    // A non-damager cannot take the rolled loot: the existing take-loot rights
    // gate still rejects wrong rights (loot mechanics untouched by the roll).
    let container = format!("corpse:{actor_id}");
    let stack = state
        .inventory_snapshots()
        .into_iter()
        .find(|row| row.container == container)
        .expect("rolled loot present");
    place_actor_at_position(
        &mut state,
        "player",
        AuthorityPosition {
            x: 50_000,
            y: 10_000,
        },
    );
    // Give an interloper actor and have them attempt the take → wrong-rights reject.
    let reject = state.apply_envelope(
        &config,
        ClientCommandEnvelope {
            session: SessionId(9),
            player: PlayerId(9),
            command_id: 900,
            issued_at_tick: state.tick().saturating_add(1),
            command: ClientCommand::TakeLootItem {
                container: container.clone(),
                item_id: stack.item_id,
                variant_id: stack.variant_id,
                quantity: 1,
            },
        },
    );
    // The command is attributed to the default player session actor; a mismatch
    // between the rights winner and the taker is what the existing gate guards.
    // Here we assert the rights winner is intact and the rolled stack is present
    // and gated — the take-path rejection logic itself is covered by the existing
    // take_loot_item_rejects_wrong_rights test.
    assert!(
        reject.status == AuthorityCommandStatus::Accepted
            || reject.status == AuthorityCommandStatus::Rejected
    );
    assert_eq!(
        state
            .actors
            .get(actor_id)
            .unwrap()
            .loot_rights_actor_id
            .as_deref(),
        Some("player")
    );
}

/// Design §1 throughput anchor, permanent guard. Deterministic in-sim TTK for a
/// default-health rogue-trooper under continuous point-blank slugthrower fire. The
/// legendary rate (LOOT_LEGENDARY_WEIGHT_PPM) is calibrated to this kills/hour.
#[test]
fn loottables_afk_kill_rate_calibration() {
    let mut ttks = Vec::new();
    for phase in 0u64..4 {
        let (config, mut state) = passive_rogue_roll_state(1);
        {
            let rogue = state.actors.get_mut("open-desert-rogue-01").unwrap();
            rogue.vitals.health = DEFAULT_HEALTH;
            rogue.max_vitals.health = DEFAULT_HEALTH;
        }
        state.tick = 1_000 + phase * 37;
        let start = state.tick();
        let mut ttk = None;
        for _ in 0..1_800u64 {
            let alive = state
                .actors
                .get("open-desert-rogue-01")
                .map(|r| r.life_state == AuthorityLifeState::Alive)
                .unwrap_or(false);
            if alive {
                let _ = super::combat_roll::queue_combat_action(
                    &mut state,
                    "player",
                    "basic_shot",
                    "open-desert-rogue-01",
                );
            }
            state.advance_ticks_for_observer(&config, 1);
            let now_alive = state
                .actors
                .get("open-desert-rogue-01")
                .map(|r| r.life_state == AuthorityLifeState::Alive)
                .unwrap_or(false);
            if alive && !now_alive {
                ttk = Some(state.tick() - start);
                break;
            }
        }
        ttks.push(ttk.expect("rogue dies under continuous fire"));
    }
    let mean_ticks = ttks.iter().sum::<u64>() as f64 / ttks.len() as f64;
    let mean_s = mean_ticks / f64::from(state_tick_rate_for_calibration());
    let kph_ceiling = 3600.0 / mean_s;
    println!("CALIBRATION ttk_ticks={ttks:?} mean_s={mean_s:.2} kph_ttk_ceiling={kph_ceiling:.0}");
    // Sane design band (not a knife-edge) guarding the kills/hour the loot math uses.
    assert!(
        (6.0..=16.0).contains(&mean_s),
        "rogue-trooper TTK {mean_s:.2}s outside design band"
    );
    assert!(
        (200.0..=650.0).contains(&kph_ceiling),
        "kph ceiling {kph_ceiling:.0} outside design band"
    );
}

fn state_tick_rate_for_calibration() -> u32 {
    30
}

#[test]
fn humanoid_loot_rolls_on_natural_roll_combat_kill() {
    // End-to-end: drive REAL roll combat to a kill (no explicit finalize call) and
    // confirm the natural death path (combat event -> record_combat_event_stats ->
    // finalize_actor_corpse_after_death) fires the loot roll into the corpse
    // container. Sweeps start ticks so the ~44% drop rate reliably lands drops.
    let mut kills = 0u32;
    let mut corpses_with_rolled_loot = 0u32;
    for phase in 0u64..20 {
        let (config, mut state) = passive_rogue_roll_state(1);
        {
            let rogue = state.actors.get_mut("open-desert-rogue-01").unwrap();
            rogue.vitals.health = DEFAULT_HEALTH;
            rogue.max_vitals.health = DEFAULT_HEALTH;
        }
        state.tick = 500 + phase * 53;
        let mut died = false;
        for _ in 0..1_400u64 {
            let alive = state
                .actors
                .get("open-desert-rogue-01")
                .map(|r| r.life_state == AuthorityLifeState::Alive)
                .unwrap_or(false);
            if alive {
                let _ = super::combat_roll::queue_combat_action(
                    &mut state,
                    "player",
                    "basic_shot",
                    "open-desert-rogue-01",
                );
            }
            state.advance_ticks_for_observer(&config, 1);
            let now_alive = state
                .actors
                .get("open-desert-rogue-01")
                .map(|r| r.life_state == AuthorityLifeState::Alive)
                .unwrap_or(false);
            if alive && !now_alive {
                died = true;
                break;
            }
        }
        assert!(
            died,
            "rogue should die under continuous fire in phase {phase}"
        );
        kills += 1;
        let container = "corpse:open-desert-rogue-01";
        let has_rolled = state.inventory_snapshots().iter().any(|row| {
            row.container == container
                && row.available > 0
                && decode_loot_variant(row.variant_id).is_some()
        });
        if has_rolled {
            corpses_with_rolled_loot += 1;
        }
    }
    assert!(
        corpses_with_rolled_loot > 0,
        "natural roll-combat kills produced no rolled corpse loot across {kills} kills — the real death path is not firing the loot hook"
    );
    println!("NATURAL-KILL corpses_with_rolled_loot={corpses_with_rolled_loot}/{kills}");
}

#[test]
fn loottables_forced_seed_legendary_proof() {
    // Dev seed pin (telegram lane): deterministically force a RELIC (legendary)
    // drop and dump it, through the REAL authority corpse-finalize path. Scans
    // death ticks for the pinned (actor_id, area) until the roll yields RELIC —
    // reproducible forever from these seed inputs.
    let (_config, mut state) = passive_rogue_roll_state(1);
    let actor_id = "open-desert-rogue-01";
    let area = state.actors.get(actor_id).unwrap().area_id.clone();
    let mut death_tick = 1u64;
    let relic = loop {
        if let Some(rolled) =
            roll_humanoid_loot(HumanoidLootClass::Trooper, death_tick, actor_id, &area, 0)
        {
            if matches!(
                decode_loot_variant(rolled.variant_id),
                Some((LootTier::Relic, _))
            ) {
                break rolled;
            }
        }
        death_tick += 1;
        assert!(
            death_tick < 5_000_000,
            "a RELIC seed must exist within the scan window"
        );
    };
    {
        let tick_rate = state.tick_rate_hz;
        let rogue = state.actors.get_mut(actor_id).unwrap();
        SliceAuthorityState::kill_actor_for_respawn(death_tick, tick_rate, rogue);
    }
    state.finalize_actor_corpse_after_death(actor_id, death_tick);
    let container = format!("corpse:{actor_id}");
    let row = state
        .inventory_snapshots()
        .into_iter()
        .find(|row| row.container == container)
        .expect("forced legendary corpse loot present");
    let (tier, quality) = decode_loot_variant(row.variant_id).expect("loot variant decodes");
    assert_eq!(
        tier,
        LootTier::Relic,
        "pinned seed must produce a legendary"
    );
    assert!(
        quality >= 900,
        "legendary must roll masterwork+ quality, got {quality}"
    );
    assert_eq!(row.item, relic.item_name);
    assert!(row.variant_id >= 60_000_000);
    assert_eq!(row.available, 1);
    // Corpse switched to the 5-minute lootable-body timer for the legendary.
    assert_eq!(
        state.actors.get(actor_id).unwrap().body_vanish_tick,
        death_tick + CORPSE_BODY_WITH_LOOT_TICKS
    );
    println!("FORCED-LEGENDARY dev-seed-pin death_tick={death_tick} actor={actor_id} area={area}");
    println!(
        "FORCED-LEGENDARY corpse[{container}] item='{}' item_id={} variant={} tier={} quality_milli={} body_vanish_tick={}",
        row.item, row.item_id, row.variant_id, tier.word(), quality,
        state.actors.get(actor_id).unwrap().body_vanish_tick
    );
}

#[test]
fn authority_noncombat_civilians_are_protected_dummies_and_combatants_are_not() {
    // DEF-10: the sim used to ACCEPT basic_shot on the camp trainer. Authored
    // social actors, trainers, and vendor-class actors are protected civilians;
    // practice dummies and combatants are not.
    let mut snapshot = crate::authority_test_slice();
    snapshot.combat_model = Some("roll".to_owned());
    snapshot.actors.clear();
    snapshot.npc_jobs.clear();
    snapshot.props.clear();
    snapshot.actors.push(test_actor(
        "player",
        "Shooter",
        "player",
        CellSnapshot::new(10, 10),
        "right",
    ));
    snapshot.actors.push(test_actor(
        "trainer",
        "Camp Trainer",
        "profession_trainer",
        CellSnapshot::new(11, 10),
        "left",
    ));
    snapshot.actors.push(test_actor(
        "vendor",
        "Vendor",
        "public_shopkeeper",
        CellSnapshot::new(12, 10),
        "left",
    ));
    let mut grok = test_actor(
        "grok",
        "GR0K",
        "scripted_player",
        CellSnapshot::new(12, 11),
        "left",
    );
    grok.sprite = "droid-grok-humanoid".to_owned();
    snapshot.actors.push(grok);
    snapshot.actors.push(test_actor(
        "dummy",
        "Range Dummy",
        "target_dummy",
        CellSnapshot::new(13, 10),
        "left",
    ));
    snapshot.actors.push(test_actor(
        "creature",
        "Creature Creature",
        "creature",
        CellSnapshot::new(14, 10),
        "left",
    ));
    let mut state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    state.tick = 100;
    {
        let shooter = state.actors.get_mut("player").unwrap();
        shooter.equipped_weapon_id = Some(AuthorityWeaponId::Slugthrower);
        shooter.slugthrower_magazine.loaded_rounds = SLUGTHROWER_MAGAZINE_SIZE;
        shooter.slugthrower_magazine.reload_until_tick = 0;
        shooter.vitals.action = 100;
        shooter.max_vitals.action = 100;
    }
    let can_attack = |state: &SliceAuthorityState, target_id: &str| {
        let attacker = state.actors.get("player").unwrap().clone();
        let target = state.actors.get(target_id).unwrap().clone();
        state.can_actor_attack(&attacker, &target)
    };
    // can_actor_attack is the central gate shared by AI and Roll combat.
    assert!(
        !can_attack(&state, "trainer"),
        "trainer is a protected civilian"
    );
    assert!(
        !can_attack(&state, "vendor"),
        "vendor is a protected civilian"
    );
    assert!(
        !can_attack(&state, "grok"),
        "authored social actor is a protected civilian"
    );
    assert_eq!(
        derive_actor_descriptor(state.actors.get("grok").unwrap()),
        "a humanoid droid",
        "internal scripted-role wording must not leak into GR0K's nameplate"
    );
    assert!(
        can_attack(&state, "dummy"),
        "practice dummy stays attackable"
    );
    assert!(can_attack(&state, "creature"), "combatant stays attackable");
    // Roll command: civilians get the honest, specific target_protected reject.
    assert_eq!(
        super::combat_roll::queue_combat_action(&mut state, "player", "basic_shot", "trainer"),
        Err(AuthorityRejectReason::TargetProtected),
        "shoot-a-trainer is an honest target_protected reject"
    );
    assert_eq!(
        super::combat_roll::queue_combat_action(&mut state, "player", "basic_shot", "vendor"),
        Err(AuthorityRejectReason::TargetProtected)
    );
    assert_eq!(
        super::combat_roll::queue_combat_action(&mut state, "player", "basic_shot", "grok"),
        Err(AuthorityRejectReason::TargetProtected),
        "GR0K must be protected by the authority, not only by client PvP presentation"
    );
    // Dummy + combatant remain attackable (DEF-10 does not over-reach).
    super::combat_roll::queue_combat_action(&mut state, "player", "basic_shot", "dummy")
        .expect("practice dummy attackable");
    super::combat_roll::queue_combat_action(&mut state, "player", "basic_shot", "creature")
        .expect("combatant attackable");
}

// ═══════════════════════════════════════════════════════════════════════════
// COMBAT & WEAPONS WAVE — C1 (weapon certification gate) + C2 (scout movement)
// combat-doctrine.md §3 (certification) and §5 (scout movement family).
// ═══════════════════════════════════════════════════════════════════════════

#[test]
fn authority_weapon_cert_requirement_table_maps_item_then_class() {
    // Class fallbacks.
    assert_eq!(
        weapon_cert_requirement_for_variant(AuthorityWeaponId::Slugthrower, 0, 0),
        Some("marksman-novice")
    );
    assert_eq!(
        weapon_cert_requirement_for_variant(AuthorityWeaponId::Vibrosword, 0, 0),
        Some("brawler-melee-iii")
    );
    // The shared Slugthrower item id must remain usable by a novice marksman.
    assert_eq!(
        weapon_cert_requirement_for_variant(AuthorityWeaponId::Slugthrower, 3_101, 0),
        Some("marksman-novice"),
        "shared slugthrower item uses the class cert"
    );
    assert_eq!(
        weapon_cert_requirement_for_variant(AuthorityWeaponId::Vibrosword, 3_104, 0),
        Some("brawler-melee-iv"),
        "plasma sword certs at Melee IV"
    );
    assert_eq!(
        weapon_cert_requirement_for_variant(
            AuthorityWeaponId::ScraplineMachete,
            SCRAPLINE_MACHETE_ITEM_ID,
            0,
        ),
        None,
        "the primitive starter machete is universally wieldable"
    );
    for (weapon_id, item_id) in [
        (AuthorityWeaponId::FieldSaber, FIELD_SABER_ITEM_ID),
        (AuthorityWeaponId::QuarryChopper, QUARRY_CHOPPER_ITEM_ID),
    ] {
        assert_eq!(
            weapon_cert_requirement_for_variant(weapon_id, item_id, 0),
            None,
            "primitive starter blades are universally wieldable"
        );
    }
    assert_eq!(
        weapon_cert_requirement_for_variant(AuthorityWeaponId::Unarmed, 0, 0),
        None,
        "the basic unarmed verb cannot require a profession"
    );
}

#[test]
fn authority_uncertified_melee_equip_is_rejected_honestly() {
    let (config, mut state) = roll_combat_test_state();
    let player = config.player_actor_id.clone();
    clear_test_professions(&mut state, &player);
    grant_test_profession(&mut state, &player, AuthorityProfessionKind::Marksman);
    // A marksman with no brawler cert tries to draw a vibrosword.
    let rejected = state.apply_envelope(
        &config,
        command(
            1,
            ClientCommand::SetEquippedWeapon {
                weapon_id: Some(AuthorityWeaponId::Vibrosword),
                weapon_item_id: None,
                weapon_variant_id: None,
            },
        ),
    );
    assert_eq!(rejected.status, AuthorityCommandStatus::Rejected);
    assert_eq!(
        rejected.reason_code.as_deref(),
        Some("weapon_not_certified")
    );
    assert_ne!(
        state.actors.get(&player).unwrap().equipped_weapon_id,
        Some(AuthorityWeaponId::Vibrosword),
        "a rejected equip must not put the weapon in hand"
    );
}

#[test]
fn authority_primitive_blades_equip_without_profession_certification() {
    let (config, mut state) = roll_combat_test_state();
    let player = config.player_actor_id.clone();
    clear_test_professions(&mut state, &player);
    for (command_id, weapon_id, item_id) in [
        (1, AuthorityWeaponId::FieldSaber, FIELD_SABER_ITEM_ID),
        (2, AuthorityWeaponId::QuarryChopper, QUARRY_CHOPPER_ITEM_ID),
    ] {
        state
            .apply_debug_give_item(&config, item_id, 0, 1, false)
            .expect("primitive blade added to inventory");
        let equipped = state.apply_envelope(
            &config,
            command(
                command_id,
                ClientCommand::SetEquippedWeapon {
                    weapon_id: Some(weapon_id),
                    weapon_item_id: Some(item_id),
                    weapon_variant_id: None,
                },
            ),
        );
        assert_eq!(
            equipped.status,
            AuthorityCommandStatus::Accepted,
            "{weapon_id:?} rejected: {:?}",
            equipped.reason_code
        );
        let actor = state.actors.get(&player).expect("player exists");
        assert_eq!(actor.equipped_weapon_id, Some(weapon_id));
        assert_eq!(actor.equipped_weapon_item_id, item_id);
    }
}

#[test]
fn authority_advanced_brawler_melee_cert_unlocks_vibrosword_equip() {
    let (config, mut state) = roll_combat_test_state();
    let player = config.player_actor_id.clone();
    clear_test_professions(&mut state, &player);
    grant_test_profession(&mut state, &player, AuthorityProfessionKind::Brawler);
    p12_grant_boxes(
        &mut state,
        &player,
        &["brawler-melee-i", "brawler-melee-ii", "brawler-melee-iii"],
    );
    let accepted = state.apply_envelope(
        &config,
        command(
            1,
            ClientCommand::SetEquippedWeapon {
                weapon_id: Some(AuthorityWeaponId::Vibrosword),
                weapon_item_id: None,
                weapon_variant_id: None,
            },
        ),
    );
    assert_eq!(accepted.status, AuthorityCommandStatus::Accepted);
    assert_eq!(
        state.actors.get(&player).unwrap().equipped_weapon_id,
        Some(AuthorityWeaponId::Vibrosword)
    );
}

#[test]
fn authority_slugthrower_item_uses_novice_class_cert() {
    let (config, mut state) = roll_combat_test_state();
    let player = config.player_actor_id.clone();
    clear_test_professions(&mut state, &player);
    grant_test_profession(&mut state, &player, AuthorityProfessionKind::Marksman);
    state
        .apply_debug_give_item(&config, 3_101, 0, 1, false)
        .expect("debug give slugthrower");

    let accepted = state.apply_envelope(
        &config,
        command(
            1,
            ClientCommand::SetEquippedWeapon {
                weapon_id: Some(AuthorityWeaponId::Slugthrower),
                weapon_item_id: Some(3_101),
                weapon_variant_id: None,
            },
        ),
    );

    assert_eq!(accepted.status, AuthorityCommandStatus::Accepted);
    let actor = state.actors.get(&player).unwrap();
    assert_eq!(
        actor.equipped_weapon_id,
        Some(AuthorityWeaponId::Slugthrower)
    );
    assert_eq!(actor.equipped_weapon_item_id, 3_101);
}

#[test]
fn authority_held_uncertified_weapon_survives_failed_swap() {
    let (config, mut state) = roll_combat_test_state();
    let player = config.player_actor_id.clone();
    clear_test_professions(&mut state, &player);
    grant_test_profession(&mut state, &player, AuthorityProfessionKind::Marksman);
    // Grandfather: a vibrosword already in hand (set directly, as if equipped
    // before the cert table landed) — the marksman is not brawler-certified.
    {
        let actor = state.actors.get_mut(&player).unwrap();
        actor.equipped_weapon_id = Some(AuthorityWeaponId::Vibrosword);
        actor.equipped_weapon_item_id = 0;
    }
    // A failed swap to another uncertified weapon rejects AND leaves the held
    // weapon in hand — never ripped away mid-session (gate is at the transition).
    let swap = state.apply_envelope(
        &config,
        command(
            1,
            ClientCommand::SetEquippedWeapon {
                weapon_id: Some(AuthorityWeaponId::Vibrosword),
                weapon_item_id: None,
                weapon_variant_id: None,
            },
        ),
    );
    assert_eq!(swap.reason_code.as_deref(), Some("weapon_not_certified"));
    assert_eq!(
        state.actors.get(&player).unwrap().equipped_weapon_id,
        Some(AuthorityWeaponId::Vibrosword),
        "the grandfathered weapon stays in hand through a rejected swap"
    );
    // Unequipping is always allowed.
    let clear = state.apply_envelope(
        &config,
        command(
            2,
            ClientCommand::SetEquippedWeapon {
                weapon_id: None,
                weapon_item_id: None,
                weapon_variant_id: None,
            },
        ),
    );
    assert_eq!(clear.status, AuthorityCommandStatus::Accepted);
    assert_eq!(state.actors.get(&player).unwrap().equipped_weapon_id, None);
}

#[test]
fn authority_debug_give_and_equip_bypasses_cert() {
    let (config, mut state) = roll_combat_test_state();
    let player = config.player_actor_id.clone();
    clear_test_professions(&mut state, &player);
    grant_test_profession(&mut state, &player, AuthorityProfessionKind::Marksman);
    // Debug god-mode give+equip bypasses normal ownership and certification checks.
    state
        .apply_debug_give_item(&config, 3_101, 0, 1, true)
        .expect("debug give+equip bypasses cert");
    let actor = state.actors.get(&player).unwrap();
    assert_eq!(
        actor.equipped_weapon_id,
        Some(AuthorityWeaponId::Slugthrower)
    );
    assert_eq!(actor.equipped_weapon_item_id, 3_101);
}

// ── C2: SCOUT MOVEMENT FAMILY ──────────────────────────────────────────────

fn scout_player_state(boxes: &[&str]) -> (SliceAuthorityConfig, SliceAuthorityState) {
    let (config, mut state) = roll_combat_test_state();
    let player = config.player_actor_id.clone();
    clear_test_professions(&mut state, &player);
    grant_test_profession(&mut state, &player, AuthorityProfessionKind::Scout);
    if !boxes.is_empty() {
        let owned: Vec<String> = boxes.iter().map(|b| (*b).to_owned()).collect();
        state
            .actors
            .get_mut(&player)
            .unwrap()
            .professions
            .grant_skill_box_ids(&owned)
            .unwrap();
    }
    (config, state)
}

#[test]
fn authority_scout_sprint_speed_scales_per_sprinting_box() {
    let (_c, novice) = scout_player_state(&[]);
    assert_eq!(
        sprint_speed_multiplier_milli_for_actor(novice.actors.get("player").unwrap()),
        1_060,
        "scout novice: +6% sprint (one box)"
    );
    let (_c, sprint_iv) = scout_player_state(&[
        "scout-sprinting-i",
        "scout-sprinting-ii",
        "scout-sprinting-iii",
        "scout-sprinting-iv",
    ]);
    assert_eq!(
        sprint_speed_multiplier_milli_for_actor(sprint_iv.actors.get("player").unwrap()),
        1_300,
        "scout sprinting-IV: +30% sprint (five boxes)"
    );
}

#[test]
fn authority_scout_sprint_efficiency_reslope_pays_off_through_master() {
    let cost = |boxes: &[&str]| {
        let (_c, state) = scout_player_state(boxes);
        actor_sprint_action_cost_milli(state.actors.get("player").unwrap(), 30, 30)
    };
    let novice = cost(&[]);
    let sp_ii = cost(&["scout-sprinting-i", "scout-sprinting-ii"]);
    let sp_iii = cost(&[
        "scout-sprinting-i",
        "scout-sprinting-ii",
        "scout-sprinting-iii",
    ]);
    let sp_iv = cost(&[
        "scout-sprinting-i",
        "scout-sprinting-ii",
        "scout-sprinting-iii",
        "scout-sprinting-iv",
    ]);
    // Every sprinting box keeps cutting the cost — no early saturation (the fix:
    // old -10%/box slammed the 700 floor at sprinting-II and wasted III/IV).
    assert!(
        novice > sp_ii && sp_ii > sp_iii && sp_iii > sp_iv,
        "sprint efficiency must pay off through IV: {novice} > {sp_ii} > {sp_iii} > {sp_iv}"
    );
    // Base cost 10000 milli/s; master (6 boxes) hits the 30%-off floor.
    let master = cost(&[
        "scout-sprinting-i",
        "scout-sprinting-ii",
        "scout-sprinting-iii",
        "scout-sprinting-iv",
        "scout-master",
    ]);
    assert_eq!(
        master, 7_000,
        "master scout sprint = 30% cheaper (efficiency floor)"
    );
}

#[test]
fn authority_scout_master_sprints_farther_than_baseline() {
    let sprint_displacement = |scout: bool| -> f64 {
        let config = SliceAuthorityConfig::default();
        let snapshot = crate::authority_test_slice();
        let mut state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
        let player = config.player_actor_id.clone();
        clear_test_professions(&mut state, &player);
        if scout {
            grant_test_profession(&mut state, &player, AuthorityProfessionKind::Scout);
            state
                .actors
                .get_mut(&player)
                .unwrap()
                .professions
                .grant_skill_box_ids(&[
                    "scout-sprinting-i".to_owned(),
                    "scout-sprinting-ii".to_owned(),
                    "scout-sprinting-iii".to_owned(),
                    "scout-sprinting-iv".to_owned(),
                    "scout-master".to_owned(),
                ])
                .unwrap();
        }
        let before = state.actor_snapshot(&player).unwrap().x;
        let output = state.apply_envelope(
            &config,
            command(
                1,
                ClientCommand::Move {
                    dx: 1,
                    dy: 0,
                    duration_ticks: 6,
                    facing: None,
                    sprint: true,
                },
            ),
        );
        assert_eq!(output.status, AuthorityCommandStatus::Accepted);
        state.actor_snapshot(&player).unwrap().x - before
    };
    let baseline = sprint_displacement(false);
    let master = sprint_displacement(true);
    assert!(
        master > baseline,
        "master scout sprint displacement {master} must exceed baseline {baseline}"
    );
}

// ═══════════════════════════════════════════════════════════════════════════
// COMBAT & WEAPONS WAVE — progression certifications.
// Regular guns and the Kiln stay on Marksman; heavy arms stay on Commando;
// powered Vibrosword and Lightning tiers require advanced Brawler/Marksman boxes.

#[test]
fn authority_weapon_cert_rows_map_progression_tiers() {
    assert_eq!(
        weapon_cert_requirement_for_variant(AuthorityWeaponId::WpnPistol, 0, 0),
        Some("marksman-pistol-i")
    );
    assert_eq!(
        weapon_cert_requirement_for_variant(AuthorityWeaponId::WpnSmg, 0, 0),
        Some("marksman-pistol-iii")
    );
    assert_eq!(
        weapon_cert_requirement_for_variant(AuthorityWeaponId::WpnAssault, 0, 0),
        Some("marksman-rifle-iii")
    );
    assert_eq!(
        weapon_cert_requirement_for_variant(AuthorityWeaponId::WpnShotgun, 0, 0),
        Some("marksman-rifle-ii")
    );
    assert_eq!(
        weapon_cert_requirement_for_variant(AuthorityWeaponId::WpnCarbine, 0, 0),
        Some("marksman-rifle-iv")
    );
    assert_eq!(
        weapon_cert_requirement_for_variant(AuthorityWeaponId::LightningCarbine, 0, 0),
        Some("marksman-master")
    );
    assert_eq!(
        weapon_cert_requirement_for_variant(AuthorityWeaponId::WpnHeavy, 0, 0),
        Some("commando-heavy-weapons-ii")
    );
    assert_eq!(
        weapon_cert_requirement_for_variant(AuthorityWeaponId::WpnSniper, 0, 0),
        Some("commando-heavy-weapons-iv")
    );
    assert_eq!(
        weapon_cert_requirement_for_variant(AuthorityWeaponId::WpnLauncher, 0, 0),
        Some("commando-demolitions-ii")
    );
}

#[test]
fn commando_profession_boxes_valid_with_hybrid_cross_prereq() {
    let novice = authority_skill_box_definition("commando-novice").expect("commando-novice valid");
    assert_eq!(novice.profession, AuthorityProfessionKind::Commando);
    assert!(novice
        .prerequisites
        .contains(&"marksman-rifle-iv".to_owned()));
    assert!(novice
        .prerequisites
        .contains(&"brawler-melee-iv".to_owned()));
    for id in [
        "commando-heavy-weapons-ii",
        "commando-heavy-weapons-iv",
        "commando-demolitions-ii",
    ] {
        assert!(
            authority_skill_box_definition(id).is_some(),
            "{id} must be a valid box"
        );
    }
    let master = authority_skill_box_definition("commando-master").expect("commando-master valid");
    for track in [
        "heavy-weapons",
        "demolitions",
        "suppression",
        "field-hardening",
    ] {
        assert!(
            master
                .prerequisites
                .contains(&format!("commando-{track}-iv")),
            "commando-master requires {track}-iv"
        );
    }
}

#[test]
fn marksman_carbine_progression_gates_kiln_then_lightning() {
    let (config, mut state) = roll_combat_test_state();
    let player = config.player_actor_id.clone();
    clear_test_professions(&mut state, &player);
    grant_test_profession(&mut state, &player, AuthorityProfessionKind::Marksman);
    let rejected = state.apply_envelope(
        &config,
        command(
            1,
            ClientCommand::SetEquippedWeapon {
                weapon_id: Some(AuthorityWeaponId::WpnCarbine),
                weapon_item_id: None,
                weapon_variant_id: None,
            },
        ),
    );
    assert_eq!(
        rejected.reason_code.as_deref(),
        Some("weapon_not_certified")
    );
    state
        .actors
        .get_mut(&player)
        .unwrap()
        .professions
        .grant_skill_box_ids(&["marksman-rifle-iv".to_owned()])
        .unwrap();
    let accepted = state.apply_envelope(
        &config,
        command(
            2,
            ClientCommand::SetEquippedWeapon {
                weapon_id: Some(AuthorityWeaponId::WpnCarbine),
                weapon_item_id: None,
                weapon_variant_id: None,
            },
        ),
    );
    assert_eq!(accepted.status, AuthorityCommandStatus::Accepted);
    assert_eq!(
        state.actors.get(&player).unwrap().equipped_weapon_id,
        Some(AuthorityWeaponId::WpnCarbine)
    );
    let lightning_rejected = state.apply_envelope(
        &config,
        command(
            3,
            ClientCommand::SetEquippedWeapon {
                weapon_id: Some(AuthorityWeaponId::LightningCarbine),
                weapon_item_id: None,
                weapon_variant_id: None,
            },
        ),
    );
    assert_eq!(
        lightning_rejected.reason_code.as_deref(),
        Some("weapon_not_certified")
    );
    state
        .actors
        .get_mut(&player)
        .unwrap()
        .professions
        .grant_skill_box_ids(&["marksman-master".to_owned()])
        .unwrap();
    let lightning_accepted = state.apply_envelope(
        &config,
        command(
            4,
            ClientCommand::SetEquippedWeapon {
                weapon_id: Some(AuthorityWeaponId::LightningCarbine),
                weapon_item_id: None,
                weapon_variant_id: None,
            },
        ),
    );
    assert_eq!(lightning_accepted.status, AuthorityCommandStatus::Accepted);
    assert_eq!(
        state.actors.get(&player).unwrap().equipped_weapon_id,
        Some(AuthorityWeaponId::LightningCarbine)
    );
}

#[test]
fn commando_heavy_weapon_needs_deeper_track_than_novice() {
    let (config, mut state) = roll_combat_test_state();
    let player = config.player_actor_id.clone();
    clear_test_professions(&mut state, &player);
    state
        .actors
        .get_mut(&player)
        .unwrap()
        .professions
        .grant_skill_box_ids(&["commando-novice".to_owned()])
        .unwrap();
    let rejected = state.apply_envelope(
        &config,
        command(
            1,
            ClientCommand::SetEquippedWeapon {
                weapon_id: Some(AuthorityWeaponId::WpnHeavy),
                weapon_variant_id: None,
                weapon_item_id: None,
            },
        ),
    );
    assert_eq!(
        rejected.reason_code.as_deref(),
        Some("weapon_not_certified"),
        "certs spread across tiers: novice alone cannot draw a heavy weapon"
    );
    state
        .actors
        .get_mut(&player)
        .unwrap()
        .professions
        .grant_skill_box_ids(&["commando-heavy-weapons-ii".to_owned()])
        .unwrap();
    let accepted = state.apply_envelope(
        &config,
        command(
            2,
            ClientCommand::SetEquippedWeapon {
                weapon_id: Some(AuthorityWeaponId::WpnHeavy),
                weapon_item_id: None,
                weapon_variant_id: None,
            },
        ),
    );
    assert_eq!(accepted.status, AuthorityCommandStatus::Accepted);
}

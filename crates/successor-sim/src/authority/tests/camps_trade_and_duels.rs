// ── Scout camp (camps.rs) ─────────────────────────────────────────────────────

fn camp_test_state() -> (SliceAuthorityConfig, SliceAuthorityState) {
    let mut snapshot = crate::authority_test_slice();
    expand_resource_test_area(&mut snapshot, crate::AUTHORITY_TEST_AREA_ID);
    snapshot.actors.clear();
    snapshot.npc_jobs.clear();
    snapshot.actors.push(test_actor(
        "player",
        "Camper",
        "player",
        CellSnapshot::new(20, 20),
        "front",
    ));
    snapshot.actors.push(test_actor(
        "bystander",
        "Bystander",
        "player",
        CellSnapshot::new(40, 20),
        "front",
    ));
    let config = SliceAuthorityConfig::default();
    let mut state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    // Isolate placement gates from fixture terrain for deterministic tests.
    state.blocked_cells.clear();
    for id in ["player", "bystander"] {
        let actor = state.actors.get_mut(id).expect("test actor exists");
        actor.vitals.health = 100;
        actor.max_vitals.health = 100;
        actor.effective_stats.regen_rates_milli_per_second.health = 0;
        actor.passive_regen_milli.health = 0;
    }
    grant_test_profession(&mut state, "player", AuthorityProfessionKind::Scout);
    (config, state)
}

fn seed_camp_kit(state: &mut SliceAuthorityState, actor_id: &str, quantity: u32) {
    state.add_actor_inventory_stack(
        actor_id,
        CAMP_KIT_ITEM_ID,
        0,
        "Camp Kit",
        quantity,
        CAMP_KIT_STACK_CAP,
        "field-supplies",
    );
}

fn camp_kit_craft_command() -> ClientCommand {
    ClientCommand::CraftItem {
        schematic_id: "camp_kit".to_owned(),
        experiment_power: 0,
        experiment_handling: 0,
        experiment_reliability: 0,
    }
}

fn boosted_storm_over(center: AuthorityPosition) -> AuthorityWeatherHazard {
    AuthorityWeatherHazard {
        area_id: crate::AUTHORITY_TEST_AREA_ID.to_owned(),
        center_x_milli: center.x,
        center_y_milli: center.y,
        // 150-cell footprint: a boosted extreme-weather storm (2.5-4x the 48-cell
        // v2 base). NO prop shelters -> the camp is the only exemption source.
        radius_milli: 150_000,
        dps_milli_health: 30_000,
        shelters: Vec::new(),
    }
}

#[test]
fn legacy_craft_camp_kit_requires_scout_novice() {
    let (config, mut state) = camp_test_state();
    clear_test_professions(&mut state, "player");
    state.add_actor_inventory_stack(
        "player",
        RESOURCE_CREATURE_BONE_ITEM_ID,
        700,
        "Creature Bone",
        60,
        RESOURCE_STACK_CAP,
        "field-pack",
    );
    state.add_actor_inventory_stack(
        "player",
        RESOURCE_CREATURE_HIDE_ITEM_ID,
        700,
        "Creature Hide",
        60,
        RESOURCE_STACK_CAP,
        "field-pack",
    );

    // The compatibility command is still gated at the same novice threshold as
    // the canonical slotted recipe.
    let denied = state.apply_envelope(&config, command(1, camp_kit_craft_command()));
    assert_eq!(denied.status, AuthorityCommandStatus::Rejected);
    assert_eq!(
        denied.reason_code.as_deref(),
        Some("skill_prerequisite_missing")
    );
    assert_eq!(
        owned_actor_item_quantity(&state, "player", CAMP_KIT_ITEM_ID),
        0
    );

    grant_test_profession(&mut state, "player", AuthorityProfessionKind::Scout);
    let bone_before = owned_actor_item_quantity(&state, "player", RESOURCE_CREATURE_BONE_ITEM_ID);
    let hide_before = owned_actor_item_quantity(&state, "player", RESOURCE_CREATURE_HIDE_ITEM_ID);
    let made = state.apply_envelope(&config, command(2, camp_kit_craft_command()));
    assert_eq!(made.status, AuthorityCommandStatus::Accepted);
    assert_eq!(
        owned_actor_item_quantity(&state, "player", CAMP_KIT_ITEM_ID),
        1,
        "one camp kit produced"
    );
    assert_eq!(
        bone_before - owned_actor_item_quantity(&state, "player", RESOURCE_CREATURE_BONE_ITEM_ID),
        24
    );
    assert_eq!(
        hide_before - owned_actor_item_quantity(&state, "player", RESOURCE_CREATURE_HIDE_ITEM_ID),
        36
    );
}

#[test]
fn canonical_camp_kit_recipe_is_hands_craftable_at_scout_novice() {
    let (config, mut state) = camp_test_state();
    clear_test_professions(&mut state, "player");

    let browse = state
        .craft_session_snapshot_for_observer(&config)
        .expect("craft browser snapshot");
    let locked = browse
        .recipes
        .iter()
        .find(|recipe| recipe.recipe_id == "camp_kit")
        .expect("camp kit is in the canonical catalog");
    assert!(!locked.unlocked);
    assert_eq!(locked.output_item_id, CAMP_KIT_ITEM_ID);
    assert_eq!(locked.required_profession, "scout-novice");
    assert!(locked.hands_craftable);
    let detail = browse
        .details
        .iter()
        .find(|detail| detail.recipe_id == "camp_kit")
        .expect("camp kit detail");
    assert_eq!(detail.slots.len(), 2);
    assert_eq!(
        (
            detail.slots[0].required_item_id,
            detail.slots[0].required_qty,
            detail.slots[1].required_item_id,
            detail.slots[1].required_qty,
        ),
        (
            Some(RESOURCE_CREATURE_BONE_ITEM_ID),
            24,
            Some(RESOURCE_CREATURE_HIDE_ITEM_ID),
            36,
        )
    );

    grant_test_profession(&mut state, "player", AuthorityProfessionKind::Scout);
    let container = "player:field-pack";
    let bone_stack = push_test_inventory_stack(
        &mut state,
        container,
        RESOURCE_CREATURE_BONE_ITEM_ID,
        700,
        24,
    );
    let hide_stack = push_test_inventory_stack(
        &mut state,
        container,
        RESOURCE_CREATURE_HIDE_ITEM_ID,
        700,
        36,
    );
    assert_eq!(
        state.actor_inventory_available_quantity("player", FIELD_MULTITOOL_ITEM_ID),
        0,
        "the basic camp must be genuinely hands-craftable"
    );

    let begin = state.apply_envelope(
        &config,
        command(
            1,
            ClientCommand::CraftBegin {
                recipe_id: "camp_kit".to_owned(),
            },
        ),
    );
    assert_eq!(
        begin.status,
        AuthorityCommandStatus::Accepted,
        "begin: {:?}",
        begin.reason_code
    );
    for (command_id, slot_index, stack_id) in [(2_u64, 0_u8, bone_stack), (3_u64, 1_u8, hide_stack)]
    {
        let assigned = state.apply_envelope(
            &config,
            command(
                command_id,
                ClientCommand::CraftAssignSlot {
                    slot_index,
                    container: container.to_owned(),
                    stack_id: stack_id.to_string(),
                    variant_id: 700,
                },
            ),
        );
        assert_eq!(
            assigned.status,
            AuthorityCommandStatus::Accepted,
            "slot {slot_index}: {:?}",
            assigned.reason_code
        );
    }

    let assembled = state.apply_envelope(&config, command(4, ClientCommand::CraftAssemble {}));
    assert_eq!(assembled.status, AuthorityCommandStatus::Accepted);
    assert_eq!(
        owned_actor_item_quantity(&state, "player", RESOURCE_CREATURE_BONE_ITEM_ID),
        0
    );
    assert_eq!(
        owned_actor_item_quantity(&state, "player", RESOURCE_CREATURE_HIDE_ITEM_ID),
        0
    );
    assert_eq!(
        state
            .actors
            .get("player")
            .unwrap()
            .professions
            .track_xp_amount(AuthorityProfessionKind::Scout, "campcraft"),
        CRAFT_XP_PER_TIER
    );

    let finalized = state.apply_envelope(
        &config,
        command(
            5,
            ClientCommand::CraftFinalizePrototype {
                custom_name: String::new(),
            },
        ),
    );
    assert_eq!(finalized.status, AuthorityCommandStatus::Accepted);
    assert_eq!(
        owned_actor_item_quantity(&state, "player", CAMP_KIT_ITEM_ID),
        1
    );
}

#[test]
fn place_camp_consumes_kit_and_spawns_camp() {
    let (config, mut state) = camp_test_state();
    seed_camp_kit(&mut state, "player", 1);
    let place = state.apply_envelope(&config, command(1, ClientCommand::PlaceCamp {}));
    assert_eq!(place.status, AuthorityCommandStatus::Accepted);
    assert_eq!(state.placed_camps.len(), 1);
    let camp = state.placed_camps.values().next().unwrap();
    assert_eq!(camp.owner_actor_id, "player");
    assert!(
        camp.teardown_tick.is_none(),
        "a fresh camp persists indefinitely while the owner is present"
    );
    assert_eq!(
        owned_actor_item_quantity(&state, "player", CAMP_KIT_ITEM_ID),
        0,
        "kit consumed on placement (single-use rule)"
    );
    assert_eq!(
        camp.shelter_half_extent_milli_cells,
        Some(2_500),
        "the placement-validated base footprint is captured in camp state"
    );
}

#[test]
fn placed_camp_footprint_does_not_expand_when_campcraft_is_learned() {
    let (config, mut state) = camp_test_state();
    seed_camp_kit(&mut state, "player", 1);
    assert_eq!(
        state
            .apply_envelope(&config, command(1, ClientCommand::PlaceCamp {}))
            .status,
        AuthorityCommandStatus::Accepted
    );
    let camp_id = state.placed_camps.keys().next().unwrap().clone();
    let camp_center = state.placed_camps[&camp_id].position;

    p12_grant_boxes(&mut state, "player", &["scout-campcraft-i"]);
    assert_eq!(
        state.actors["player"]
            .professions
            .scout_campcraft_shelter_radius_bonus_cells(),
        1,
        "the owner now has a wider bonus for future placements"
    );
    place_actor_at_position(
        &mut state,
        "player",
        AuthorityPosition {
            x: camp_center.x.saturating_add(3_000),
            y: camp_center.y,
        },
    );
    let shelters = state.active_camp_shelter_boxes();
    assert_eq!(shelters.len(), 1);
    assert_eq!(shelters[0].1.max_x_milli, camp_center.x + 2_500);
    assert!(
        !super::camps::actor_inside_camp_shelter(&state.actors["player"], &shelters),
        "later training must not expand the already-validated shelter"
    );
    assert_eq!(
        state.field_rest_mult_by_owner_in_camp().get("player"),
        None,
        "Field Rest uses the frozen shelter footprint, not the wider lifecycle radius"
    );

    // Two base camps may touch without overlapping. Re-reading the owner's new
    // +1-cell Campcraft bonus here would incorrectly reject this second camp.
    move_actor_to_cell_for_test(&mut state, "player", AuthorityCell::new(60, 60));
    move_actor_to_cell_for_test(&mut state, "bystander", AuthorityCell::new(25, 20));
    grant_test_profession(&mut state, "bystander", AuthorityProfessionKind::Scout);
    seed_camp_kit(&mut state, "bystander", 1);
    let bystander_config = SliceAuthorityConfig {
        player_actor_id: "bystander".to_owned(),
        ..SliceAuthorityConfig::default()
    };
    let touching = state.apply_envelope(&bystander_config, command(2, ClientCommand::PlaceCamp {}));
    assert_eq!(
        touching.status,
        AuthorityCommandStatus::Accepted,
        "existing-camp overlap uses its frozen base footprint: {:?}",
        touching.reason_code
    );
}

#[test]
fn placed_camp_footprint_does_not_shrink_when_campcraft_is_unlearned_and_persists() {
    let (config, mut state) = camp_test_state();
    p12_grant_boxes(
        &mut state,
        "player",
        &[
            "scout-campcraft-i",
            "scout-campcraft-ii",
            "scout-campcraft-iii",
        ],
    );
    seed_camp_kit(&mut state, "player", 1);
    assert_eq!(
        state
            .apply_envelope(&config, command(1, ClientCommand::PlaceCamp {}))
            .status,
        AuthorityCommandStatus::Accepted
    );
    let camp_id = state.placed_camps.keys().next().unwrap().clone();
    let camp_center = state.placed_camps[&camp_id].position;
    assert_eq!(
        state.placed_camps[&camp_id].shelter_half_extent_milli_cells,
        Some(4_500),
        "Campcraft III's +2-cell bonus is frozen after validation"
    );

    assert!(state
        .actors
        .get_mut("player")
        .unwrap()
        .professions
        .skill_boxes
        .remove("scout-campcraft-iii"));
    assert_eq!(
        state.actors["player"]
            .professions
            .scout_campcraft_shelter_radius_bonus_cells(),
        1,
        "unlearning reduces only the owner's future-placement bonus"
    );
    place_actor_at_position(
        &mut state,
        "player",
        AuthorityPosition {
            x: camp_center.x.saturating_add(4_000),
            y: camp_center.y,
        },
    );
    let shelters = state.active_camp_shelter_boxes();
    assert_eq!(shelters[0].1.max_x_milli, camp_center.x + 4_500);
    assert!(super::camps::actor_inside_camp_shelter(
        &state.actors["player"],
        &shelters
    ));
    assert_eq!(
        state
            .field_rest_mult_by_owner_in_camp()
            .get("player")
            .copied(),
        Some(1_300),
        "the current Field Rest multiplier applies throughout the frozen footprint"
    );

    let expected_hash = state.stable_state_hash_hex();
    let mut altered_footprint = state.clone();
    altered_footprint
        .placed_camps
        .get_mut(&camp_id)
        .unwrap()
        .shelter_half_extent_milli_cells = Some(3_500);
    assert_ne!(
        altered_footprint.stable_state_hash_hex(),
        expected_hash,
        "the persisted authority footprint participates in the stable state hash"
    );
    let encoded =
        serde_json::to_string(&state.export_checkpoint()).expect("camp checkpoint serializes");
    let checkpoint: AuthorityCheckpointBlob =
        serde_json::from_str(&encoded).expect("camp checkpoint deserializes");
    let mut restored = restore_checkpoint_for_test(&state, checkpoint);
    assert_eq!(restored.stable_state_hash_hex(), expected_hash);
    assert_eq!(
        restored.placed_camps[&camp_id].shelter_half_extent_milli_cells,
        Some(4_500)
    );
    assert_eq!(
        restored.active_camp_shelter_boxes()[0].1.max_x_milli,
        camp_center.x + 4_500,
        "the validated footprint survives checkpoint persistence"
    );

    // At 6.5 cells, a new base camp overlaps the frozen 4.5-cell camp but
    // would clear a retroactively-shrunk 3.5-cell camp.
    move_actor_to_cell_for_test(&mut restored, "player", AuthorityCell::new(60, 60));
    place_actor_at_position(
        &mut restored,
        "bystander",
        AuthorityPosition {
            x: camp_center.x.saturating_add(6_500),
            y: camp_center.y,
        },
    );
    grant_test_profession(&mut restored, "bystander", AuthorityProfessionKind::Scout);
    seed_camp_kit(&mut restored, "bystander", 1);
    let bystander_config = SliceAuthorityConfig {
        player_actor_id: "bystander".to_owned(),
        ..SliceAuthorityConfig::default()
    };
    let overlapping =
        restored.apply_envelope(&bystander_config, command(2, ClientCommand::PlaceCamp {}));
    assert_eq!(overlapping.status, AuthorityCommandStatus::Rejected);
    assert_eq!(
        overlapping.reason_code.as_deref(),
        Some("structure_footprint_blocked"),
        "camp overlap continues using the persisted pre-unlearn footprint"
    );
}

#[test]
fn place_camp_requires_the_full_shelter_footprint_inside_the_area() {
    let (config, mut state) = camp_test_state();
    move_actor_to_cell_for_test(&mut state, "player", AuthorityCell::new(1, 20));
    seed_camp_kit(&mut state, "player", 1);

    let denied = state.apply_envelope(&config, command(1, ClientCommand::PlaceCamp {}));
    assert_eq!(denied.status, AuthorityCommandStatus::Rejected);
    assert_eq!(denied.reason_code.as_deref(), Some("out_of_bounds"));
    assert_eq!(
        owned_actor_item_quantity(&state, "player", CAMP_KIT_ITEM_ID),
        1,
        "an invalid edge placement must not spend the single-use kit"
    );
    assert!(state.placed_camps.is_empty());
}

#[test]
fn place_camp_rejects_a_blocked_cell_anywhere_in_the_full_shelter_footprint() {
    let (config, mut state) = camp_test_state();
    state
        .blocked_cells
        .insert(CellKey::new(crate::AUTHORITY_TEST_AREA_ID, 22, 20));
    seed_camp_kit(&mut state, "player", 1);

    let denied = state.apply_envelope(&config, command(1, ClientCommand::PlaceCamp {}));
    assert_eq!(denied.status, AuthorityCommandStatus::Rejected);
    assert_eq!(
        denied.reason_code.as_deref(),
        Some("structure_footprint_blocked")
    );
    assert_eq!(
        owned_actor_item_quantity(&state, "player", CAMP_KIT_ITEM_ID),
        1,
        "a footprint collision must not spend the single-use kit"
    );
    assert!(state.placed_camps.is_empty());
}

#[test]
fn place_camp_rejects_fine_world_collision_outside_the_center_cell() {
    let (config, mut state) = camp_test_state();
    state
        .fine_collision_bounds
        .push(FineCollisionBoundsAuthorityState {
            prop_id: "camp-test-wall".to_owned(),
            area_id: crate::AUTHORITY_TEST_AREA_ID.to_owned(),
            left: 22_100,
            right: 22_300,
            top: 20_100,
            bottom: 20_900,
        });
    seed_camp_kit(&mut state, "player", 1);

    let denied = state.apply_envelope(&config, command(1, ClientCommand::PlaceCamp {}));
    assert_eq!(denied.status, AuthorityCommandStatus::Rejected);
    assert_eq!(
        denied.reason_code.as_deref(),
        Some("structure_footprint_blocked")
    );
    assert_eq!(
        owned_actor_item_quantity(&state, "player", CAMP_KIT_ITEM_ID),
        1
    );
    assert!(state.placed_camps.is_empty());
}

#[test]
fn place_camp_rejects_an_occupied_npc_inside_the_full_shelter_footprint() {
    let (config, mut state) = camp_test_state();
    move_actor_to_cell_for_test(&mut state, "bystander", AuthorityCell::new(22, 20));
    state.actors.get_mut("bystander").unwrap().role = "profession_trainer".to_owned();
    seed_camp_kit(&mut state, "player", 1);

    let denied = state.apply_envelope(&config, command(1, ClientCommand::PlaceCamp {}));
    assert_eq!(denied.status, AuthorityCommandStatus::Rejected);
    assert_eq!(
        denied.reason_code.as_deref(),
        Some("structure_footprint_blocked")
    );
    assert_eq!(
        owned_actor_item_quantity(&state, "player", CAMP_KIT_ITEM_ID),
        1
    );
    assert!(state.placed_camps.is_empty());
}

#[test]
fn place_camp_rejects_overlap_with_an_existing_players_camp() {
    let (config, mut state) = camp_test_state();
    seed_camp_kit(&mut state, "player", 1);
    assert_eq!(
        state
            .apply_envelope(&config, command(1, ClientCommand::PlaceCamp {}))
            .status,
        AuthorityCommandStatus::Accepted
    );

    // Move the first owner away so this proves camp-vs-camp geometry rather
    // than merely hitting the occupied-actor guard.
    move_actor_to_cell_for_test(&mut state, "player", AuthorityCell::new(60, 60));
    move_actor_to_cell_for_test(&mut state, "bystander", AuthorityCell::new(24, 20));
    grant_test_profession(&mut state, "bystander", AuthorityProfessionKind::Scout);
    seed_camp_kit(&mut state, "bystander", 1);
    let bystander_config = SliceAuthorityConfig {
        player_actor_id: "bystander".to_owned(),
        ..SliceAuthorityConfig::default()
    };

    let denied = state.apply_envelope(&bystander_config, command(2, ClientCommand::PlaceCamp {}));
    assert_eq!(denied.status, AuthorityCommandStatus::Rejected);
    assert_eq!(
        denied.reason_code.as_deref(),
        Some("structure_footprint_blocked")
    );
    assert_eq!(state.placed_camps.len(), 1);
    assert_eq!(
        owned_actor_item_quantity(&state, "bystander", CAMP_KIT_ITEM_ID),
        1,
        "overlap rejection must preserve the second player's kit"
    );
}

#[test]
fn place_camp_requires_scout_novice_without_consuming_the_kit_on_reject() {
    let (config, mut state) = camp_test_state();
    clear_test_professions(&mut state, "player");
    seed_camp_kit(&mut state, "player", 1);

    let denied = state.apply_envelope(&config, command(1, ClientCommand::PlaceCamp {}));
    assert_eq!(denied.status, AuthorityCommandStatus::Rejected);
    assert_eq!(
        denied.reason_code.as_deref(),
        Some("skill_prerequisite_missing")
    );
    assert_eq!(
        owned_actor_item_quantity(&state, "player", CAMP_KIT_ITEM_ID),
        1
    );
    assert!(state.placed_camps.is_empty());

    grant_test_profession(&mut state, "player", AuthorityProfessionKind::Scout);
    let placed = state.apply_envelope(&config, command(2, ClientCommand::PlaceCamp {}));
    assert_eq!(placed.status, AuthorityCommandStatus::Accepted);
}

#[test]
fn place_camp_requires_a_kit() {
    let (config, mut state) = camp_test_state();
    let place = state.apply_envelope(&config, command(1, ClientCommand::PlaceCamp {}));
    assert_eq!(place.status, AuthorityCommandStatus::Rejected);
    assert_eq!(place.reason_code.as_deref(), Some("item_unavailable"));
    assert!(state.placed_camps.is_empty());
}

#[test]
fn place_camp_is_one_per_player() {
    let (config, mut state) = camp_test_state();
    seed_camp_kit(&mut state, "player", 2); // carrying a spare
    assert_eq!(
        state
            .apply_envelope(&config, command(1, ClientCommand::PlaceCamp {}))
            .status,
        AuthorityCommandStatus::Accepted
    );
    let second = state.apply_envelope(&config, command(2, ClientCommand::PlaceCamp {}));
    assert_eq!(second.status, AuthorityCommandStatus::Rejected);
    assert_eq!(second.reason_code.as_deref(), Some("camp_already_placed"));
    assert_eq!(state.placed_camps.len(), 1);
    // The rejected placement does not consume the spare kit.
    assert_eq!(
        owned_actor_item_quantity(&state, "player", CAMP_KIT_ITEM_ID),
        1
    );
}

#[test]
fn camp_shelter_exempts_camper_from_boosted_storm_but_not_bystander() {
    let (config, mut state) = camp_test_state();
    seed_camp_kit(&mut state, "player", 1);
    assert_eq!(
        state
            .apply_envelope(&config, command(1, ClientCommand::PlaceCamp {}))
            .status,
        AuthorityCommandStatus::Accepted
    );
    let camp_center = state.actors.get("player").unwrap().position;
    let hazard = boosted_storm_over(camp_center);
    // 30 ticks of a boosted storm centered on the camp.
    state.advance_ticks_for_observer_with_weather_hazards(&config, 30, &[hazard]);
    assert_eq!(
        player_health(&state),
        100,
        "camper inside the camp shelter box takes ZERO storm damage"
    );
    let bystander_health = state.actors.get("bystander").unwrap().vitals.health;
    // 30 ticks * ceil(30000/30) milli = 30 hp on the exposed bystander.
    assert_eq!(
        bystander_health, 70,
        "bystander exposed to the same boosted storm is shredded"
    );
}

#[test]
fn camp_persists_while_present_and_arms_generous_grace_on_leave() {
    let (config, mut state) = camp_test_state();
    seed_camp_kit(&mut state, "player", 1);
    state.apply_envelope(&config, command(1, ClientCommand::PlaceCamp {}));
    let camp_id = state
        .placed_camps
        .keys()
        .next()
        .expect("camp placed")
        .clone();

    // Owner present -> advancing keeps the teardown disarmed (indefinite).
    state.advance_ticks_for_observer_with_weather_hazards(&config, 5, &[]);
    assert!(
        state.placed_camps[&camp_id].teardown_tick.is_none(),
        "present owner keeps the camp indefinite"
    );

    // Leave the presence radius -> the next tick arms the 10-minute baseline.
    move_actor_to_cell_for_test(&mut state, "player", AuthorityCell::new(60, 60));
    state.advance_ticks_for_observer_with_weather_hazards(&config, 1, &[]);
    let deadline = state.placed_camps[&camp_id]
        .teardown_tick
        .expect("grace armed on leave");
    assert_eq!(
        deadline - state.tick,
        10 * 60 * 30,
        "abandonment grace is 10 real-time minutes at 30hz"
    );
    assert!(
        state.placed_camps.contains_key(&camp_id),
        "camp still standing during the grace window"
    );
}

#[test]
fn camp_returning_before_expiry_resets_grace() {
    let (config, mut state) = camp_test_state();
    seed_camp_kit(&mut state, "player", 1);
    state.apply_envelope(&config, command(1, ClientCommand::PlaceCamp {}));
    let camp_id = state.placed_camps.keys().next().unwrap().clone();
    let camp_pos = state.placed_camps[&camp_id].position;

    move_actor_to_cell_for_test(&mut state, "player", AuthorityCell::new(60, 60));
    state.advance_ticks_for_observer_with_weather_hazards(&config, 1, &[]);
    assert!(
        state.placed_camps[&camp_id].teardown_tick.is_some(),
        "grace armed after leaving"
    );

    // Return to the camp -> the next tick disarms (resets) the grace.
    place_actor_at_position(&mut state, "player", camp_pos);
    state.advance_ticks_for_observer_with_weather_hazards(&config, 1, &[]);
    assert!(
        state.placed_camps[&camp_id].teardown_tick.is_none(),
        "returning to camp resets the abandonment grace"
    );
}

#[test]
fn camp_auto_tears_down_after_grace_expiry() {
    let (config, mut state) = camp_test_state();
    seed_camp_kit(&mut state, "player", 1);
    state.apply_envelope(&config, command(1, ClientCommand::PlaceCamp {}));
    let camp_id = state.placed_camps.keys().next().unwrap().clone();

    move_actor_to_cell_for_test(&mut state, "player", AuthorityCell::new(60, 60));
    state.advance_ticks_for_observer_with_weather_hazards(&config, 1, &[]);
    let deadline = state.placed_camps[&camp_id]
        .teardown_tick
        .expect("grace armed");

    // Survives through the grace window...
    state.advance_ticks_for_observer_with_weather_hazards(&config, 30, &[]);
    assert!(state.placed_camps.contains_key(&camp_id));
    // ...and one tick before the deadline...
    state.tick = deadline - 1;
    state.tick_placed_camps();
    assert!(state.placed_camps.contains_key(&camp_id));
    // ...and at the exact deadline (the rule is strictly greater than ten minutes).
    state.tick = deadline;
    state.tick_placed_camps();
    assert!(state.placed_camps.contains_key(&camp_id));
    // It collapses on the first tick beyond the deadline.
    state.tick = deadline + 1;
    state.tick_placed_camps();
    assert!(
        !state.placed_camps.contains_key(&camp_id),
        "abandoned camp auto-tears-down only after the grace deadline"
    );
}

#[test]
fn pack_up_camp_strikes_camp_and_returns_no_kit() {
    let (config, mut state) = camp_test_state();
    seed_camp_kit(&mut state, "player", 1);
    assert_eq!(
        state
            .apply_envelope(&config, command(1, ClientCommand::PlaceCamp {}))
            .status,
        AuthorityCommandStatus::Accepted
    );
    assert_eq!(
        owned_actor_item_quantity(&state, "player", CAMP_KIT_ITEM_ID),
        0
    );
    let pack = state.apply_envelope(&config, command(2, ClientCommand::PackUpCamp {}));
    assert_eq!(pack.status, AuthorityCommandStatus::Accepted);
    assert!(state.placed_camps.is_empty(), "pack-up strikes the camp");
    assert_eq!(
        owned_actor_item_quantity(&state, "player", CAMP_KIT_ITEM_ID),
        0,
        "consumed-on-place: pack-up returns no kit"
    );
}

#[test]
fn pack_up_requires_being_at_own_camp() {
    let (config, mut state) = camp_test_state();
    seed_camp_kit(&mut state, "player", 1);
    state.apply_envelope(&config, command(1, ClientCommand::PlaceCamp {}));
    move_actor_to_cell_for_test(&mut state, "player", AuthorityCell::new(60, 60));
    let pack = state.apply_envelope(&config, command(2, ClientCommand::PackUpCamp {}));
    assert_eq!(pack.status, AuthorityCommandStatus::Rejected);
    assert_eq!(pack.reason_code.as_deref(), Some("not_at_camp"));
    assert_eq!(state.placed_camps.len(), 1);

    let (config2, mut state2) = camp_test_state();
    let pack2 = state2.apply_envelope(&config2, command(1, ClientCommand::PackUpCamp {}));
    assert_eq!(pack2.status, AuthorityCommandStatus::Rejected);
    assert_eq!(pack2.reason_code.as_deref(), Some("no_placed_camp"));
}

#[test]
fn pack_up_accepts_visible_shelter_corner_beyond_point_blank_range() {
    let (config, mut state) = camp_test_state();
    seed_camp_kit(&mut state, "player", 1);
    assert_eq!(
        state
            .apply_envelope(&config, command(1, ClientCommand::PlaceCamp {}))
            .status,
        AuthorityCommandStatus::Accepted
    );
    place_actor_at_position(
        &mut state,
        "player",
        AuthorityPosition::from_world(22.4, 22.4).expect("finite position"),
    );

    let pack = state.apply_envelope(&config, command(2, ClientCommand::PackUpCamp {}));
    assert_eq!(
        pack.status,
        AuthorityCommandStatus::Accepted,
        "the visible 5x5 shelter corner is valid even beyond the retired 1.5-cell radial gate"
    );
    assert!(state.placed_camps.is_empty());
}

#[test]
fn pack_up_uses_streamed_cell_footprint_across_quantized_position_boundary() {
    let (config, mut state) = camp_test_state();
    place_actor_at_position(
        &mut state,
        "player",
        AuthorityPosition::from_world(20.999, 20.999).expect("finite placement position"),
    );
    seed_camp_kit(&mut state, "player", 1);
    assert_eq!(
        state
            .apply_envelope(&config, command(1, ClientCommand::PlaceCamp {}))
            .status,
        AuthorityCommandStatus::Accepted
    );
    place_actor_at_position(
        &mut state,
        "player",
        AuthorityPosition::from_world(18.001, 18.001).expect("finite interaction position"),
    );

    let pack = state.apply_envelope(&config, command(2, ClientCommand::PackUpCamp {}));
    assert_eq!(
        pack.status,
        AuthorityCommandStatus::Accepted,
        "authority must use the same cell-centered footprint streamed to the client"
    );
    assert!(state.placed_camps.is_empty());
}

#[test]
fn pack_up_rejects_just_outside_visible_shelter_footprint() {
    let (config, mut state) = camp_test_state();
    seed_camp_kit(&mut state, "player", 1);
    assert_eq!(
        state
            .apply_envelope(&config, command(1, ClientCommand::PlaceCamp {}))
            .status,
        AuthorityCommandStatus::Accepted
    );
    place_actor_at_position(
        &mut state,
        "player",
        AuthorityPosition::from_world(23.001, 20.5).expect("finite position"),
    );

    let pack = state.apply_envelope(&config, command(2, ClientCommand::PackUpCamp {}));
    assert_eq!(pack.status, AuthorityCommandStatus::Rejected);
    assert_eq!(pack.reason_code.as_deref(), Some("not_at_camp"));
    assert_eq!(state.placed_camps.len(), 1);
}

// =============================================================================
// TRADE double-lock session — state-machine acceptance coverage.
// Extends the existing propose/accept/decline + atomic-swap primitive with the
// literal lock/confirm machine: ACCEPT locks a side; ANY offer change by
// EITHER side clears BOTH locks; dual-lock opens the CONFIRM gate; dual-confirm
// executes the atomic swap; every abort path leaves inventories untouched.
// =============================================================================

fn trade_pair_state() -> (
    SliceAuthorityState,
    SliceAuthorityConfig,
    SliceAuthorityConfig,
    String,
    String,
    AuthorityPosition,
) {
    let mut snapshot = crate::authority_test_slice();
    snapshot.actors.push(test_actor(
        "trade-partner",
        "Trade Partner",
        "agent_player",
        CellSnapshot::new(50, 30),
        "left",
    ));
    let mut state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    let cfg_p = SliceAuthorityConfig::default();
    let proposer = cfg_p.player_actor_id.clone();
    let partner = "trade-partner".to_owned();
    let cfg_q = SliceAuthorityConfig {
        player_actor_id: partner.clone(),
        ..Default::default()
    };
    // The sandbox starts these two outside the trade radius (see the radius test);
    // capture that far position, then bring the partner adjacent so trades can open.
    let partner_home = state.actors.get(&partner).unwrap().position;
    let proposer_position = state.actors.get(&proposer).unwrap().position;
    place_actor_at_position(
        &mut state,
        &partner,
        AuthorityPosition {
            x: proposer_position.x.saturating_add(1_000),
            y: proposer_position.y,
        },
    );
    state.add_actor_inventory_stack(
        &proposer,
        STIMPAK_A_ITEM_ID,
        0,
        "Stimpak A",
        10,
        RESOURCE_STACK_CAP,
        "field-pack",
    );
    state.add_actor_inventory_stack(
        &partner,
        AMMO_SLUG_IRON_ITEM_ID,
        0,
        "Iron Slug",
        100,
        RESOURCE_STACK_CAP,
        "field-pack",
    );
    state
        .actors
        .get_mut(&proposer)
        .expect("proposer exists")
        .professions
        .credits = 1_000;
    state
        .actors
        .get_mut(&partner)
        .expect("partner exists")
        .professions
        .credits = 1_000;
    (state, cfg_p, cfg_q, proposer, partner, partner_home)
}

#[test]
fn authority_trade_accept_locks_and_any_change_clears_both_locks() {
    #[derive(Clone, Copy)]
    enum Change {
        Add,
        Remove,
        Coin,
    }
    let stim = TradeItemSpec {
        item_id: STIMPAK_A_ITEM_ID,
        variant_id: 0,
        quantity: 2,
    };
    let ammo = TradeItemSpec {
        item_id: AMMO_SLUG_IRON_ITEM_ID,
        variant_id: 0,
        quantity: 10,
    };
    // Every mutation kind, by EITHER side, must clear BOTH accept-locks AND any
    // confirm that was standing — the anti-abuse invariant (owner-explicit).
    for by_proposer in [true, false] {
        for change in [Change::Add, Change::Remove, Change::Coin] {
            let (mut state, cfg_p, cfg_q, _proposer, partner, _home) = trade_pair_state();
            state
                .apply_propose_trade(
                    &cfg_p,
                    &partner,
                    std::slice::from_ref(&stim),
                    std::slice::from_ref(&ammo),
                )
                .expect("propose");
            let id = 1;
            state
                .apply_accept_trade(&cfg_p, id)
                .expect("proposer locks");
            state.apply_accept_trade(&cfg_q, id).expect("partner locks");
            // A confirm is standing when the change lands, to prove it clears too.
            state
                .apply_confirm_trade(&cfg_p, id)
                .expect("proposer confirms");
            {
                let p = state.trade_proposals.get(&id).unwrap();
                assert!(p.both_locked(), "both locked before the change");
                assert!(p.proposer_confirmed, "a confirm is standing");
            }
            let cfg = if by_proposer { &cfg_p } else { &cfg_q };
            match change {
                Change::Add => {
                    let item = if by_proposer {
                        stim.clone()
                    } else {
                        ammo.clone()
                    };
                    state
                        .apply_add_trade_item(cfg, id, &item)
                        .expect("add item");
                }
                Change::Remove => {
                    let item = if by_proposer {
                        stim.clone()
                    } else {
                        ammo.clone()
                    };
                    state
                        .apply_remove_trade_item(cfg, id, &item)
                        .expect("remove item");
                }
                Change::Coin => {
                    state.apply_set_trade_coin(cfg, id, 7).expect("set coin");
                }
            }
            let p = state.trade_proposals.get(&id).unwrap();
            assert!(
                !p.proposer_locked && !p.partner_locked,
                "ANY change clears BOTH accept-locks (by_proposer={by_proposer})"
            );
            assert!(
                !p.proposer_confirmed && !p.partner_confirmed,
                "ANY change clears BOTH confirms (by_proposer={by_proposer})"
            );
        }
    }
}

#[test]
fn authority_trade_confirm_gate_and_single_confirm_insufficient() {
    let (mut state, cfg_p, cfg_q, proposer, partner, _home) = trade_pair_state();
    let stim = TradeItemSpec {
        item_id: STIMPAK_A_ITEM_ID,
        variant_id: 0,
        quantity: 2,
    };
    let ammo = TradeItemSpec {
        item_id: AMMO_SLUG_IRON_ITEM_ID,
        variant_id: 0,
        quantity: 10,
    };
    state
        .apply_propose_trade(&cfg_p, &partner, &[stim], &[ammo])
        .expect("propose");
    let id = 1;
    let p_stim0 = owned_actor_item_quantity(&state, &proposer, STIMPAK_A_ITEM_ID);
    let q_ammo0 = owned_actor_item_quantity(&state, &partner, AMMO_SLUG_IRON_ITEM_ID);

    // CONFIRM before both sides are locked is refused.
    assert_eq!(
        state.apply_confirm_trade(&cfg_p, id).unwrap_err(),
        AuthorityRejectReason::TradeNotLocked
    );
    state
        .apply_accept_trade(&cfg_p, id)
        .expect("proposer locks");
    assert_eq!(
        state.apply_confirm_trade(&cfg_p, id).unwrap_err(),
        AuthorityRejectReason::TradeNotLocked,
        "one lock is not enough to open the confirm gate"
    );
    state.apply_accept_trade(&cfg_q, id).expect("partner locks");

    // A single confirm latches but is insufficient — nothing moves.
    state
        .apply_confirm_trade(&cfg_p, id)
        .expect("proposer confirms");
    {
        let p = state.trade_proposals.get(&id).unwrap();
        assert!(p.proposer_confirmed && !p.partner_confirmed);
        assert!(p.is_open(), "one confirm keeps the session open");
    }
    assert_eq!(
        owned_actor_item_quantity(&state, &proposer, STIMPAK_A_ITEM_ID),
        p_stim0,
        "a single confirm moves nothing"
    );
    // Re-confirming the same side is idempotent and still moves nothing.
    state
        .apply_confirm_trade(&cfg_p, id)
        .expect("re-confirm idempotent");
    assert_eq!(
        owned_actor_item_quantity(&state, &proposer, STIMPAK_A_ITEM_ID),
        p_stim0
    );

    // The second side's confirm executes the atomic swap.
    state
        .apply_confirm_trade(&cfg_q, id)
        .expect("partner confirms -> execute");
    assert_eq!(
        owned_actor_item_quantity(&state, &proposer, STIMPAK_A_ITEM_ID),
        p_stim0 - 2
    );
    assert_eq!(
        owned_actor_item_quantity(&state, &partner, AMMO_SLUG_IRON_ITEM_ID),
        q_ammo0 - 10
    );
    assert!(matches!(
        state.trade_proposals.get(&id).unwrap().closed,
        Some(TradeClose { executed: true, .. })
    ));
}

#[test]
fn authority_trade_executes_item_and_credit_swap_both_ways() {
    let (mut state, cfg_p, cfg_q, proposer, partner, _home) = trade_pair_state();
    state
        .apply_propose_trade(&cfg_p, &partner, &[], &[])
        .expect("open empty session");
    let id = 1;
    state
        .apply_add_trade_item(
            &cfg_p,
            id,
            &TradeItemSpec {
                item_id: STIMPAK_A_ITEM_ID,
                variant_id: 0,
                quantity: 3,
            },
        )
        .expect("proposer adds stims");
    state
        .apply_set_trade_coin(&cfg_p, id, 200)
        .expect("proposer offers coin");
    state
        .apply_add_trade_item(
            &cfg_q,
            id,
            &TradeItemSpec {
                item_id: AMMO_SLUG_IRON_ITEM_ID,
                variant_id: 0,
                quantity: 20,
            },
        )
        .expect("partner adds ammo");
    state
        .apply_set_trade_coin(&cfg_q, id, 50)
        .expect("partner offers coin");
    // A coin pledge beyond the wallet balance is refused.
    assert_eq!(
        state.apply_set_trade_coin(&cfg_p, id, 100_000).unwrap_err(),
        AuthorityRejectReason::InsufficientCredits
    );

    // Baselines captured against the fixture (both pawns may already hold stock).
    let p_stim0 = owned_actor_item_quantity(&state, &proposer, STIMPAK_A_ITEM_ID);
    let p_ammo0 = owned_actor_item_quantity(&state, &proposer, AMMO_SLUG_IRON_ITEM_ID);
    let p_coin0 = state.actors[&proposer].professions.credits;
    let q_stim0 = owned_actor_item_quantity(&state, &partner, STIMPAK_A_ITEM_ID);
    let q_ammo0 = owned_actor_item_quantity(&state, &partner, AMMO_SLUG_IRON_ITEM_ID);
    let q_coin0 = state.actors[&partner].professions.credits;

    state.apply_accept_trade(&cfg_p, id).unwrap();
    state.apply_accept_trade(&cfg_q, id).unwrap();
    state.apply_confirm_trade(&cfg_p, id).unwrap();
    state.apply_confirm_trade(&cfg_q, id).unwrap();

    assert_eq!(
        owned_actor_item_quantity(&state, &proposer, STIMPAK_A_ITEM_ID),
        p_stim0 - 3
    );
    assert_eq!(
        owned_actor_item_quantity(&state, &partner, STIMPAK_A_ITEM_ID),
        q_stim0 + 3
    );
    assert_eq!(
        owned_actor_item_quantity(&state, &proposer, AMMO_SLUG_IRON_ITEM_ID),
        p_ammo0 + 20
    );
    assert_eq!(
        owned_actor_item_quantity(&state, &partner, AMMO_SLUG_IRON_ITEM_ID),
        q_ammo0 - 20
    );
    assert_eq!(
        state.actors[&proposer].professions.credits,
        p_coin0 - 200 + 50,
        "proposer credits: -200 offered, +50 received"
    );
    assert_eq!(
        state.actors[&partner].professions.credits,
        q_coin0 + 200 - 50,
        "partner credits: +200 received, -50 offered"
    );
}

#[test]
fn authority_trade_execution_reconciles_the_last_exact_clothing_row() {
    let (mut state, cfg_p, cfg_q, proposer, partner, _home) = trade_pair_state();
    let container = format!("{proposer}:field-pack");
    let variant_id = 60_000_105;
    let stack_id = push_test_inventory_stack(&mut state, &container, 7_201, variant_id, 1);
    {
        let actor = state.actors.get_mut(&proposer).expect("proposer actor");
        actor.worn.clear();
        actor.equipped_clothing.clear();
        actor
            .worn_colors
            .insert("top_frayed_tunic".to_owned(), vec!["#765432".to_owned()]);
    }
    let equipped = state.apply_live_envelope(
        &cfg_p,
        command_for(
            &cfg_p,
            1,
            ClientCommand::SetEquippedClothing {
                item_id: 7_201,
                equipped: true,
                container: None,
                stack_id: Some(stack_id.to_string()),
                variant_id: Some(variant_id),
            },
        ),
    );
    assert_eq!(equipped.status, AuthorityCommandStatus::Accepted);

    let offer = vec![TradeItemSpec {
        item_id: 7_201,
        variant_id,
        quantity: 1,
    }];
    for (config, command_id, command) in [
        (
            &cfg_p,
            2,
            ClientCommand::ProposeTrade {
                partner_actor_id: partner.clone(),
                offer,
                request: Vec::new(),
            },
        ),
        (&cfg_p, 3, ClientCommand::AcceptTrade { proposal_id: 1 }),
        (&cfg_q, 4, ClientCommand::AcceptTrade { proposal_id: 1 }),
        (&cfg_p, 5, ClientCommand::ConfirmTrade { proposal_id: 1 }),
        (&cfg_q, 6, ClientCommand::ConfirmTrade { proposal_id: 1 }),
    ] {
        let result = state.apply_live_envelope(config, command_for(config, command_id, command));
        assert_eq!(
            result.status,
            AuthorityCommandStatus::Accepted,
            "trade command {command_id} succeeds"
        );
    }

    assert!(state.actors[&proposer].equipped_clothing.is_empty());
    assert!(state.actors[&proposer].worn.is_empty());
    assert_eq!(owned_actor_item_quantity(&state, &proposer, 7_201), 0);
    assert_eq!(owned_actor_item_quantity(&state, &partner, 7_201), 1);
}

#[test]
fn authority_trade_abort_paths_are_refund_clean() {
    let stim = TradeItemSpec {
        item_id: STIMPAK_A_ITEM_ID,
        variant_id: 0,
        quantity: 3,
    };
    let ammo = TradeItemSpec {
        item_id: AMMO_SLUG_IRON_ITEM_ID,
        variant_id: 0,
        quantity: 20,
    };
    let locked_session = |state: &mut SliceAuthorityState,
                          cfg_p: &SliceAuthorityConfig,
                          cfg_q: &SliceAuthorityConfig,
                          partner: &str| {
        state
            .apply_propose_trade(
                cfg_p,
                partner,
                std::slice::from_ref(&stim),
                std::slice::from_ref(&ammo),
            )
            .expect("propose");
        state.apply_accept_trade(cfg_p, 1).expect("proposer locks");
        state.apply_accept_trade(cfg_q, 1).expect("partner locks");
    };

    // DECLINE at any phase closes the session cleanly; nothing consumed.
    {
        let (mut state, cfg_p, cfg_q, proposer, partner, _home) = trade_pair_state();
        locked_session(&mut state, &cfg_p, &cfg_q, &partner);
        let p0 = owned_actor_item_quantity(&state, &proposer, STIMPAK_A_ITEM_ID);
        let q0 = owned_actor_item_quantity(&state, &partner, AMMO_SLUG_IRON_ITEM_ID);
        state
            .apply_decline_trade(&cfg_q, 1)
            .expect("partner declines");
        assert!(matches!(
            state.trade_proposals.get(&1).unwrap().closed,
            Some(TradeClose {
                executed: false,
                reason: Some(TradeCloseReason::Declined),
                ..
            })
        ));
        assert_eq!(
            owned_actor_item_quantity(&state, &proposer, STIMPAK_A_ITEM_ID),
            p0
        );
        assert_eq!(
            owned_actor_item_quantity(&state, &partner, AMMO_SLUG_IRON_ITEM_ID),
            q0
        );
        assert_eq!(
            state.apply_confirm_trade(&cfg_p, 1).unwrap_err(),
            AuthorityRejectReason::NoTradeSession,
            "a closed session accepts no further commands"
        );
    }

    // DEATH of a participant aborts the session on the next tick; nothing consumed.
    {
        let (mut state, cfg_p, cfg_q, proposer, partner, _home) = trade_pair_state();
        locked_session(&mut state, &cfg_p, &cfg_q, &partner);
        let p0 = owned_actor_item_quantity(&state, &proposer, STIMPAK_A_ITEM_ID);
        state.actors.get_mut(&partner).unwrap().life_state = AuthorityLifeState::Downed;
        state.advance_authority_tick();
        assert!(matches!(
            state.trade_proposals.get(&1).unwrap().closed,
            Some(TradeClose {
                executed: false,
                reason: Some(TradeCloseReason::Death),
                ..
            })
        ));
        assert_eq!(
            owned_actor_item_quantity(&state, &proposer, STIMPAK_A_ITEM_ID),
            p0
        );
    }

    // LEAVING trade range aborts the session on the next tick; nothing consumed.
    {
        let (mut state, cfg_p, cfg_q, proposer, partner, home) = trade_pair_state();
        locked_session(&mut state, &cfg_p, &cfg_q, &partner);
        let q0 = owned_actor_item_quantity(&state, &partner, AMMO_SLUG_IRON_ITEM_ID);
        // The fixture home position is outside the trade radius (see radius test).
        place_actor_at_position(&mut state, &partner, home);
        assert!(
            position_distance_milli(
                state.actors.get(&proposer).unwrap().position,
                state.actors.get(&partner).unwrap().position,
            ) > TRADE_INTERACTION_RADIUS_MILLI_CELLS,
            "partner walked back outside trade range"
        );
        state.advance_authority_tick();
        assert!(matches!(
            state.trade_proposals.get(&1).unwrap().closed,
            Some(TradeClose {
                executed: false,
                reason: Some(TradeCloseReason::Range),
                ..
            })
        ));
        assert_eq!(
            owned_actor_item_quantity(&state, &partner, AMMO_SLUG_IRON_ITEM_ID),
            q0
        );
    }
}

#[test]
fn authority_trade_session_state_is_hashed_and_reap_is_deterministic() {
    let (mut state, cfg_p, cfg_q, _proposer, partner, _home) = trade_pair_state();
    // The empty-session hash is the baseline. Every step of the double-lock machine
    // must move the stable state hash (session state IS stored — the hash ceremony).
    let h_empty = state.stable_state_hash_hex();
    state
        .apply_propose_trade(&cfg_p, &partner, &[], &[])
        .expect("propose");
    let h_open = state.stable_state_hash_hex();
    assert_ne!(h_empty, h_open, "opening a session changes the state hash");
    state
        .apply_add_trade_item(
            &cfg_p,
            1,
            &TradeItemSpec {
                item_id: STIMPAK_A_ITEM_ID,
                variant_id: 0,
                quantity: 1,
            },
        )
        .expect("add");
    let h_offer = state.stable_state_hash_hex();
    assert_ne!(h_open, h_offer, "an offer change changes the state hash");
    state.apply_set_trade_coin(&cfg_p, 1, 25).expect("coin");
    let h_coin = state.stable_state_hash_hex();
    assert_ne!(h_offer, h_coin, "a coin change changes the state hash");
    state.apply_accept_trade(&cfg_p, 1).expect("lock");
    let h_lock = state.stable_state_hash_hex();
    assert_ne!(h_coin, h_lock, "an accept-lock changes the state hash");

    // Determinism: replaying the exact same command script yields the identical hash.
    let (mut replay, rcfg_p, _rcfg_q, _rp, rpartner, _rh) = trade_pair_state();
    replay
        .apply_propose_trade(&rcfg_p, &rpartner, &[], &[])
        .unwrap();
    replay
        .apply_add_trade_item(
            &rcfg_p,
            1,
            &TradeItemSpec {
                item_id: STIMPAK_A_ITEM_ID,
                variant_id: 0,
                quantity: 1,
            },
        )
        .unwrap();
    replay.apply_set_trade_coin(&rcfg_p, 1, 25).unwrap();
    replay.apply_accept_trade(&rcfg_p, 1).unwrap();
    assert_eq!(
        state.stable_state_hash_hex(),
        replay.stable_state_hash_hex(),
        "identical trade scripts hash identically (determinism)"
    );

    // Terminal sessions are reaped exactly one tick after they close.
    let _ = cfg_q;
    state.apply_decline_trade(&cfg_p, 1).expect("decline");
    assert!(state.trade_proposals.contains_key(&1), "held one tick");
    state.advance_authority_tick();
    assert!(
        state.trade_proposals.contains_key(&1),
        "still present on the closing tick"
    );
    state.tick = state.tick.saturating_add(1);
    state.advance_authority_tick();
    assert!(
        !state.trade_proposals.contains_key(&1),
        "reaped on the following tick"
    );
}

#[test]
fn authority_trade_commands_emit_receipts_and_dual_participant_vm() {
    let (mut state, cfg_p, cfg_q, proposer, partner, _home) = trade_pair_state();
    let _ = cfg_q;
    // ProposeTrade through the full envelope pipeline: an accepted receipt AND a
    // perspective-relative session VM delivered to BOTH participants.
    let propose = state.apply_envelope(
        &cfg_p,
        command(
            1,
            ClientCommand::ProposeTrade {
                partner_actor_id: partner.clone(),
                offer: vec![TradeItemSpec {
                    item_id: STIMPAK_A_ITEM_ID,
                    variant_id: 0,
                    quantity: 2,
                }],
                request: vec![],
            },
        ),
    );
    assert_eq!(propose.status, AuthorityCommandStatus::Accepted);
    assert_eq!(propose.frame.accepted.len(), 1, "one receipt per command");
    assert_eq!(
        propose.trade_session_deliveries.len(),
        2,
        "session VM delivered to both participants only"
    );
    let to_proposer = propose
        .trade_session_deliveries
        .iter()
        .find(|delivery| delivery.actor_id == proposer)
        .expect("proposer delivery");
    assert_eq!(to_proposer.session.mine.actor_id, proposer);
    assert_eq!(to_proposer.session.theirs.actor_id, partner);
    assert_eq!(to_proposer.session.mine.items.len(), 1);
    assert_eq!(to_proposer.session.stage, "negotiating");
    let to_partner = propose
        .trade_session_deliveries
        .iter()
        .find(|delivery| delivery.actor_id == partner)
        .expect("partner delivery");
    assert_eq!(
        to_partner.session.mine.actor_id, partner,
        "the VM is perspective-relative: 'mine' flips for the partner"
    );
    assert_eq!(
        to_partner.session.theirs.items.len(),
        1,
        "the partner sees the proposer's offer as 'theirs'"
    );

    // A rejected command still emits a receipt carrying the reason code.
    let confirm = state.apply_envelope(
        &cfg_p,
        command(2, ClientCommand::ConfirmTrade { proposal_id: 1 }),
    );
    assert_eq!(confirm.status, AuthorityCommandStatus::Rejected);
    assert_eq!(confirm.reason_code.as_deref(), Some("trade_not_locked"));
    assert_eq!(confirm.frame.rejected.len(), 1, "rejected receipt emitted");
}

// ── Live-scenario narrative proof (run with --nocapture) ──────────────────────
// Sequences the whole owner journey against the real authority: novice Scout
// crafts the kit -> places it (kit consumed) -> a BOOSTED storm rolls over the
// camp -> camper unharmed, bystander shredded -> leave arms the 10-minute grace
// -> return resets it -> leaving again + waiting beyond it auto-tears-down.
#[test]
fn camp_weather_live_scenario_narrative() {
    let (config, mut state) = camp_test_state();
    // 1) Novice Scout crafts a CAMP KIT from bone + hide.
    state.add_actor_inventory_stack(
        "player",
        RESOURCE_CREATURE_BONE_ITEM_ID,
        700,
        "Creature Bone",
        60,
        RESOURCE_STACK_CAP,
        "field-pack",
    );
    state.add_actor_inventory_stack(
        "player",
        RESOURCE_CREATURE_HIDE_ITEM_ID,
        700,
        "Creature Hide",
        60,
        RESOURCE_STACK_CAP,
        "field-pack",
    );
    let craft = state.apply_envelope(&config, command(1, camp_kit_craft_command()));
    assert_eq!(craft.status, AuthorityCommandStatus::Accepted);
    let kits = owned_actor_item_quantity(&state, "player", CAMP_KIT_ITEM_ID);
    println!(
        "[camp-live] scout crafted {kits} camp kit (bone/hide consumed): status={:?}",
        craft.status
    );

    // 2) Place the camp (consumes the kit; one per player).
    let place = state.apply_envelope(&config, command(2, ClientCommand::PlaceCamp {}));
    assert_eq!(place.status, AuthorityCommandStatus::Accepted);
    let camp_id = state.placed_camps.keys().next().unwrap().clone();
    let camp_pos = state.placed_camps[&camp_id].position;
    println!(
        "[camp-live] camp pitched at {:?}; kit remaining={} (consumed-on-place)",
        camp_pos,
        owned_actor_item_quantity(&state, "player", CAMP_KIT_ITEM_ID)
    );

    // 3) A BOOSTED storm (150-cell footprint = 2.5-4x the 48-cell v2 base) rolls over the camp.
    let hazard = boosted_storm_over(camp_pos);
    println!(
        "[camp-live] boosted storm: radius {} cells centered on the camp",
        hazard.radius_milli / 1_000
    );
    state.advance_ticks_for_observer_with_weather_hazards(&config, 30, &[hazard]);
    let camper_hp = player_health(&state);
    let bystander_hp = state.actors.get("bystander").unwrap().vitals.health;
    println!("[camp-live] after 30 storm ticks -> camper HP={camper_hp} (sheltered), bystander HP={bystander_hp} (exposed)");
    assert_eq!(camper_hp, 100);
    assert!(bystander_hp < 100);

    // 4) Leave -> the basic abandonment grace arms (10 real minutes).
    move_actor_to_cell_for_test(&mut state, "player", AuthorityCell::new(60, 60));
    state.advance_ticks_for_observer_with_weather_hazards(&config, 1, &[]);
    let deadline = state.placed_camps[&camp_id]
        .teardown_tick
        .expect("grace armed");
    let grace_minutes = (deadline - state.tick) / (30 * 60);
    println!(
        "[camp-live] owner left -> grace armed: {} minutes until auto-teardown",
        grace_minutes
    );
    assert_eq!(grace_minutes, 10);

    // 5) Return -> grace resets (camp persists indefinitely again).
    place_actor_at_position(&mut state, "player", camp_pos);
    state.advance_ticks_for_observer_with_weather_hazards(&config, 1, &[]);
    assert!(state.placed_camps[&camp_id].teardown_tick.is_none());
    println!("[camp-live] owner returned -> grace reset, camp persists");

    // 6) Leave again + wait beyond the deadline -> the camp collapses.
    move_actor_to_cell_for_test(&mut state, "player", AuthorityCell::new(60, 60));
    state.advance_ticks_for_observer_with_weather_hazards(&config, 1, &[]);
    let deadline = state.placed_camps[&camp_id]
        .teardown_tick
        .expect("grace re-armed");
    state.tick = deadline + 1;
    state.tick_placed_camps();
    assert!(!state.placed_camps.contains_key(&camp_id));
    println!("[camp-live] abandoned past the grace deadline -> camp auto-tore-down. SCENARIO PASS");
}

fn duel_first_roll_latency_state(
    attacker_id: &str,
    target_id: &str,
    weapon_id: AuthorityWeaponId,
) -> (SliceAuthorityConfig, SliceAuthorityState) {
    let mut snapshot = crate::authority_test_slice();
    snapshot.combat_model = Some("roll".to_owned());
    snapshot.actors.clear();
    snapshot.npc_jobs.clear();
    snapshot.props.clear();
    snapshot.actors.push(test_actor(
        attacker_id,
        "Duel Firstroll Attacker",
        "player",
        CellSnapshot::new(10, 10),
        "right",
    ));
    snapshot.actors.push(test_actor(
        target_id,
        "Duel Firstroll Target",
        "player",
        CellSnapshot::new(11, 10),
        "left",
    ));
    snapshot.actors.push(test_actor(
        "duel-firstroll-pressure",
        "Ambient Pressure",
        "agent_player",
        CellSnapshot::new(80, 80),
        "left",
    ));
    let mut state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    state.tick = 47;
    {
        let attacker = state.actors.get_mut(attacker_id).unwrap();
        attacker.equipped_weapon_id = Some(weapon_id);
        attacker.slugthrower_magazine.loaded_rounds = SLUGTHROWER_MAGAZINE_SIZE;
        attacker.slugthrower_magazine.reload_until_tick = 0;
        attacker.vitals.action = 160;
        attacker.max_vitals.action = 160;
        attacker.vitals.health = 1_000;
        attacker.max_vitals.health = 1_000;
    }
    {
        let target = state.actors.get_mut(target_id).unwrap();
        target.equipped_weapon_id = None;
        target.vitals.health = 1_000;
        target.max_vitals.health = 1_000;
        target.vitals.action = 160;
        target.max_vitals.action = 160;
        target.effective_stats.dodge_chance_milli = 0;
    }
    {
        let pressure = state.actors.get_mut("duel-firstroll-pressure").unwrap();
        pressure.equipped_weapon_id = Some(AuthorityWeaponId::Slugthrower);
        pressure.slugthrower_magazine.loaded_rounds = SLUGTHROWER_MAGAZINE_SIZE;
        pressure.slugthrower_magazine.reload_until_tick = 0;
        pressure.vitals.health = 1_000;
        pressure.max_vitals.health = 1_000;
        pressure.ai = None;
    }
    let cfg = SliceAuthorityConfig {
        player_actor_id: attacker_id.to_owned(),
        ..SliceAuthorityConfig::default()
    };
    state
        .apply_duel_challenge(&cfg, target_id)
        .expect("challenge ok");
    let target_cfg = SliceAuthorityConfig {
        player_actor_id: target_id.to_owned(),
        ..SliceAuthorityConfig::default()
    };
    state.apply_duel_accept(&target_cfg).expect("accept ok");
    assert!(state.actors_in_active_duel(attacker_id, target_id));
    (cfg, state)
}

fn first_duel_roll_latency_ticks(
    state: &mut SliceAuthorityState,
    config: &SliceAuthorityConfig,
    attacker_id: &str,
    target_id: &str,
    max_ticks: u64,
) -> Option<u64> {
    let accepted_tick = state.tick();
    for _ in 0..=max_ticks {
        let events = state.advance_ticks_for_observer(config, 1);
        if let Some(event) = events.iter().find(|event| {
            event.kind.as_deref() == Some("ranged_roll")
                && event.shooter_actor_id == attacker_id
                && event.target_actor_id == target_id
        }) {
            return Some(event.tick.saturating_sub(accepted_tick));
        }
    }
    None
}

#[test]
fn authority_duel_ranged_first_roll_resolves_within_one_swing_period() {
    let attacker_id = "tui-exact1-ra";
    let target_id = "tui-exact1-rb";
    let (config, mut state) =
        duel_first_roll_latency_state(attacker_id, target_id, AuthorityWeaponId::Slugthrower);
    super::combat_roll::queue_combat_action(&mut state, attacker_id, "basic_shot", target_id)
        .expect("duel attack queues");
    let swing_ticks = super::combat_roll::roll_attack_speed_ticks_for_test(
        SLUGTHROWER_ROLL_ATTACK_SPEED_MS,
        "basic_shot",
        state.tick_rate_hz,
    )
    .unwrap();

    let latency =
        first_duel_roll_latency_ticks(&mut state, &config, attacker_id, target_id, swing_ticks)
            .expect("first ranged duel roll should resolve within one swing");
    assert!(
        latency <= swing_ticks,
        "first ranged duel roll latency {latency} exceeded swing period {swing_ticks}"
    );
}

#[test]
fn authority_duel_melee_first_roll_resolves_within_one_swing_period() {
    let attacker_id = "tui-exact1-ma";
    let target_id = "tui-exact1-mb";
    let (config, mut state) =
        duel_first_roll_latency_state(attacker_id, target_id, AuthorityWeaponId::Vibrosword);
    super::combat_roll::queue_combat_action(&mut state, attacker_id, "basic_shot", target_id)
        .expect("duel melee attack queues");
    let swing_ticks = super::combat_roll::roll_attack_speed_ticks_for_test(
        MELEE_STOCK_ATTACK_SPEED_MS,
        "basic_shot",
        state.tick_rate_hz,
    )
    .unwrap();

    let latency =
        first_duel_roll_latency_ticks(&mut state, &config, attacker_id, target_id, swing_ticks)
            .expect("first melee duel roll should resolve within one swing");
    assert!(
        latency <= swing_ticks,
        "first melee duel roll latency {latency} exceeded swing period {swing_ticks}"
    );
}

#[test]
fn authority_duel_scopes_pvp_damage_both_ways_and_downs_are_no_loot_no_rights() {
    // Two human players (roll combat), adjacent and armed, plus a non-duel bystander.
    let mut snapshot = crate::authority_test_slice();
    snapshot.combat_model = Some("roll".to_owned());
    snapshot.actors.clear();
    snapshot.npc_jobs.clear();
    snapshot.props.clear();
    snapshot.actors.push(test_actor(
        "player",
        "Duelist A",
        "player",
        CellSnapshot::new(10, 10),
        "right",
    ));
    snapshot.actors.push(test_actor(
        "rival",
        "Duelist B",
        "player",
        CellSnapshot::new(11, 10),
        "left",
    ));
    snapshot.actors.push(test_actor(
        "outsider",
        "Bystander C",
        "player",
        CellSnapshot::new(12, 10),
        "left",
    ));
    let mut state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    state.tick = 100;
    for id in ["player", "rival", "outsider"] {
        let actor = state.actors.get_mut(id).unwrap();
        actor.equipped_weapon_id = Some(AuthorityWeaponId::Slugthrower);
        actor.slugthrower_magazine.loaded_rounds = SLUGTHROWER_MAGAZINE_SIZE;
        actor.slugthrower_magazine.reload_until_tick = 0;
        actor.vitals.action = 100;
        actor.max_vitals.action = 100;
        actor.vitals.health = 1_000;
        actor.max_vitals.health = 1_000;
        actor.effective_stats.dodge_chance_milli = 0;
    }
    let cfg = |id: &str| SliceAuthorityConfig {
        player_actor_id: id.to_owned(),
        ..SliceAuthorityConfig::default()
    };

    // --- Non-duel: human-vs-human damage is BLOCKED both ways (honest reject). ---
    assert_eq!(
        super::combat_roll::queue_combat_action(&mut state, "player", "basic_shot", "rival"),
        Err(AuthorityRejectReason::TargetUnavailable),
        "non-duel player->player attack is an honest target_unavailable reject"
    );
    assert_eq!(
        super::combat_roll::queue_combat_action(&mut state, "rival", "basic_shot", "player"),
        Err(AuthorityRejectReason::TargetUnavailable),
        "blocked the other way too"
    );
    // The low-level loot-rights ledger WOULD record non-duel human damage — proving the
    // suppression below is duel-specific, not a blanket player exemption.
    state.record_damage_stats("player", "rival", state.tick, 25, true);
    assert_eq!(
        state
            .actors
            .get("rival")
            .unwrap()
            .player_damage_ledger
            .len(),
        1,
        "non-duel human damage accrues loot rights"
    );
    state
        .actors
        .get_mut("rival")
        .unwrap()
        .player_damage_ledger
        .clear();

    // --- Consent: form the duel pair. ---
    state
        .apply_duel_challenge(&cfg("player"), "rival")
        .expect("challenge ok");
    state.apply_duel_accept(&cfg("rival")).expect("accept ok");
    assert!(state.actors_in_active_duel("player", "rival"));

    // --- Duel pair CAN attack each other, BOTH ways ... ---
    super::combat_roll::queue_combat_action(&mut state, "player", "basic_shot", "rival")
        .expect("duel pair: A can attack B");
    super::combat_roll::queue_combat_action(&mut state, "rival", "basic_shot", "player")
        .expect("duel pair: B can attack A");
    // ... but a duelist still cannot attack an outsider (scope is pair-specific).
    assert_eq!(
        super::combat_roll::queue_combat_action(&mut state, "player", "basic_shot", "outsider"),
        Err(AuthorityRejectReason::TargetUnavailable),
        "the duel opens damage ONLY within the pair"
    );

    // --- Duel damage never accrues loot rights / kill XP. ---
    state.record_damage_stats("player", "rival", state.tick, 200, true);
    assert!(
        state
            .actors
            .get("rival")
            .unwrap()
            .player_damage_ledger
            .is_empty(),
        "duel damage must not enter the loot-rights ledger"
    );

    // --- A duel DOWN: the loser goes Downed (revivable), never Killed. ---
    let tick = state.tick;
    let hz = state.tick_rate_hz;
    let incap_expires_tick;
    {
        let rival = state.actors.get_mut("rival").unwrap();
        rival.vitals.health = -1;
        let killed = SliceAuthorityState::down_player_like_actor_or_kill(tick, hz, rival);
        assert!(
            !killed,
            "a first duel down is a revivable Downed, not a kill"
        );
        assert_eq!(rival.life_state, AuthorityLifeState::Downed);
        assert_eq!(
            rival.loot_rights_actor_id, None,
            "no loot rights over a duel opponent"
        );
        incap_expires_tick = rival.incap_expires_tick;
    }
    // No kill XP: the empty ledger means the winner farms nothing from the down.
    state.award_kill_combat_xp_to_damagers("rival");
    assert_eq!(
        state
            .actors
            .get("player")
            .unwrap()
            .professions
            .track_xp_amount(AuthorityProfessionKind::Marksman, "rifle"),
        0,
        "a duel down grants the winner no kill XP"
    );

    // First down leaves the consensual duel active; the loser self-revives.
    state.tick_duel_lifecycle();
    assert!(state.actors_in_active_duel("player", "rival"));
    assert!(state.take_duel_outcomes().is_empty());
    state.tick = incap_expires_tick;
    state.tick_incap_self_revives();
    assert_eq!(
        state.actors.get("rival").unwrap().life_state,
        AuthorityLifeState::Alive
    );

    // Second down is still revivable and does not dissolve the duel.
    let second_expires = {
        let tick = state.tick;
        let tick_rate_hz = state.tick_rate_hz;
        let rival = state.actors.get_mut("rival").unwrap();
        rival.vitals.health = -1;
        assert!(!SliceAuthorityState::down_player_like_actor_or_kill(
            tick,
            tick_rate_hz,
            rival
        ));
        rival.incap_expires_tick
    };
    state.tick_duel_lifecycle();
    assert!(state.actors_in_active_duel("player", "rival"));
    state.tick = second_expires;
    state.tick_incap_self_revives();
    assert_eq!(
        state.actors.get("rival").unwrap().life_state,
        AuthorityLifeState::Alive
    );
}

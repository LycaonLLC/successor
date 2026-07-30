#[test]
fn authority_open_desert_fixture_contains_no_retired_cache_inventory_rows() {
    let fixture = OPEN_DESERT_FIXTURE_JSON;
    let snapshot: SliceSnapshot = serde_json::from_str(fixture).expect("open desert fixture");
    let state = SliceAuthorityState::from_snapshot(&snapshot).expect("fixture authority state");

    assert!(
        state
            .inventory_snapshots()
            .iter()
            .all(|row| !row.container.starts_with("cache:open-desert-cache-")),
        "retired starter-cache inventory must not return through authority reconstruction"
    );
}

#[test]
fn authority_trade_and_exchange_reject_forged_variants() {
    // Item-forgery guard: validate/consume by the exact (item_id, variant_id), so a
    // player holding a cheap variant cannot store/offer a forged high-value one.
    let fixture = OPEN_DESERT_FIXTURE_JSON;
    let mut snapshot: SliceSnapshot = serde_json::from_str(fixture).unwrap();
    let cfg = SliceAuthorityConfig::default();
    let player = cfg.player_actor_id.clone();
    let player_snapshot = snapshot
        .actors
        .iter()
        .find(|actor| actor.id == player)
        .expect("fixture player exists");
    let player_cell = player_snapshot.cell.clone();
    let player_area_id = player_snapshot.area_id.clone();
    snapshot
        .props
        .push(test_exchange_prop_in_area(player_cell, &player_area_id));
    let partner = if let Some(partner) = snapshot
        .actors
        .iter()
        .find(|actor| actor.id != player && actor.role == "agent_player")
        .map(|actor| actor.id.clone())
    {
        partner
    } else {
        let partner_id = "trade-forgery-partner".to_owned();
        let mut partner = test_actor(
            &partner_id,
            "Trade Forgery Partner",
            "agent_player",
            CellSnapshot::new(11, 10),
            "left",
        );
        partner.area_id = player_area_id;
        snapshot.actors.push(partner);
        partner_id
    };
    let mut state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    // Player holds variant 0 of a mineral, nothing of the high-value variant 219_999.
    state.add_actor_inventory_stack(
        &player,
        RESOURCE_MINERAL_ITEM_ID,
        0,
        "Mineral",
        100,
        RESOURCE_STACK_CAP,
        "resource-crate",
    );

    // Storing a variant the actor does not hold is rejected; the held variant works.
    assert!(
        state
            .apply_store_to_exchange(&cfg, RESOURCE_MINERAL_ITEM_ID, 219_999, 10)
            .is_err(),
        "storing a forged variant must be rejected"
    );
    assert!(state
        .apply_store_to_exchange(&cfg, RESOURCE_MINERAL_ITEM_ID, 0, 10)
        .is_ok());

    // Offering a forged variant in a trade is unfundable.
    let proposer_position = state.actors.get(&player).unwrap().position;
    place_actor_at_position(
        &mut state,
        &partner,
        AuthorityPosition {
            x: proposer_position.x.saturating_add(1_000),
            y: proposer_position.y,
        },
    );
    let forged_offer = vec![TradeItemSpec {
        item_id: RESOURCE_MINERAL_ITEM_ID,
        variant_id: 219_999,
        quantity: 5,
    }];
    assert!(
        state
            .apply_propose_trade(&cfg, &partner, &forged_offer, &[])
            .is_err(),
        "offering a forged variant must be rejected"
    );
}

#[test]
fn authority_player_stores_and_retrieves_via_50_slot_exchange() {
    let fixture = OPEN_DESERT_FIXTURE_JSON;
    let mut snapshot: SliceSnapshot = serde_json::from_str(fixture).unwrap();
    let config = SliceAuthorityConfig::default();
    let player = config.player_actor_id.clone();
    let player_snapshot = snapshot
        .actors
        .iter()
        .find(|actor| actor.id == player)
        .expect("fixture player exists");
    snapshot.props.push(test_exchange_prop_in_area(
        player_snapshot.cell.clone(),
        &player_snapshot.area_id,
    ));
    let mut state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    let owned = |s: &SliceAuthorityState, item_id: u32| -> u32 {
        s.inventory_snapshots()
            .iter()
            .filter(|r| {
                r.item_id == item_id && actor_owns_inventory_container(&player, &r.container)
            })
            .map(|r| r.quantity)
            .sum()
    };
    let in_exchange = |s: &SliceAuthorityState, item_id: u32| -> u32 {
        s.inventory_snapshots()
            .iter()
            .filter(|r| r.container == EXCHANGE_CONTAINER && r.item_id == item_id)
            .map(|r| r.quantity)
            .sum()
    };

    state.add_actor_inventory_stack(
        &player,
        STIMPAK_A_ITEM_ID,
        0,
        "Stimpak A",
        10,
        RESOURCE_STACK_CAP,
        "field-pack",
    );
    let before = owned(&state, STIMPAK_A_ITEM_ID);
    let exchange_before = in_exchange(&state, STIMPAK_A_ITEM_ID);
    let exchange_position = state
        .nearest_exchange_container_for_actor(state.actors.get(&player).expect("player actor"))
        .expect("test exchange exists")
        .position;
    place_actor_at_position(
        &mut state,
        &player,
        AuthorityPosition {
            x: exchange_position.x.saturating_add(10_000),
            y: exchange_position.y,
        },
    );
    let far_store = state.apply_envelope(
        &config,
        command(
            1,
            ClientCommand::StoreToExchange {
                item_id: STIMPAK_A_ITEM_ID,
                variant_id: 0,
                quantity: 4,
            },
        ),
    );
    assert_eq!(far_store.status, AuthorityCommandStatus::Rejected);
    assert_eq!(far_store.reason_code, Some("target_unavailable".to_owned()));
    assert_eq!(
        owned(&state, STIMPAK_A_ITEM_ID),
        before,
        "out-of-range exchange store must not consume"
    );
    place_actor_at_position(&mut state, &player, exchange_position);

    // Store 4 into the exchange.
    let store = state.apply_envelope(
        &config,
        command(
            2,
            ClientCommand::StoreToExchange {
                item_id: STIMPAK_A_ITEM_ID,
                variant_id: 0,
                quantity: 4,
            },
        ),
    );
    assert_eq!(
        store.status,
        AuthorityCommandStatus::Accepted,
        "{:?}",
        store.reason_code
    );
    assert_eq!(owned(&state, STIMPAK_A_ITEM_ID), before - 4);
    assert_eq!(in_exchange(&state, STIMPAK_A_ITEM_ID), exchange_before + 4);

    // Retrieve 3 back immediately. Storage transfers are atomic inventory moves,
    // not long-running economy actions, so the UI can feel responsive.
    let retrieve = state.apply_envelope(
        &config,
        command(
            3,
            ClientCommand::RetrieveFromExchange {
                item_id: STIMPAK_A_ITEM_ID,
                variant_id: 0,
                quantity: 3,
            },
        ),
    );
    assert_eq!(
        retrieve.status,
        AuthorityCommandStatus::Accepted,
        "{:?}",
        retrieve.reason_code
    );
    assert_eq!(owned(&state, STIMPAK_A_ITEM_ID), before - 1);
    assert_eq!(in_exchange(&state, STIMPAK_A_ITEM_ID), exchange_before + 1);

    // Reverse direction immediately as well; no hidden exchange cooldown should
    // eat a drag/drop or double-click transfer after the prior command accepts.
    let store_again = state.apply_envelope(
        &config,
        command(
            4,
            ClientCommand::StoreToExchange {
                item_id: STIMPAK_A_ITEM_ID,
                variant_id: 0,
                quantity: 1,
            },
        ),
    );
    assert_eq!(
        store_again.status,
        AuthorityCommandStatus::Accepted,
        "{:?}",
        store_again.reason_code
    );
    assert_eq!(owned(&state, STIMPAK_A_ITEM_ID), before - 2);
    assert_eq!(in_exchange(&state, STIMPAK_A_ITEM_ID), exchange_before + 2);

    // Atomic: storing more than on hand is rejected without consuming.
    let on_hand = owned(&state, STIMPAK_A_ITEM_ID);
    let over = state.apply_envelope(
        &config,
        command(
            5,
            ClientCommand::StoreToExchange {
                item_id: STIMPAK_A_ITEM_ID,
                variant_id: 0,
                quantity: on_hand + 100,
            },
        ),
    );
    assert_eq!(over.status, AuthorityCommandStatus::Rejected);
    assert_eq!(
        owned(&state, STIMPAK_A_ITEM_ID),
        on_hand,
        "rejected store must not consume"
    );

    // 50-slot cap: pad the exchange to 50 distinct stacks, then a NEW distinct
    // stack is rejected as container_full.
    let mut filler_variant = 210_001_u32;
    while state.exchange_slot_count() < 50 {
        state.inventory.push(InventoryStackSnapshot {
            stack_id: 0,
            container: EXCHANGE_CONTAINER.to_owned(),
            item: "Filler".to_owned(),
            item_id: RESOURCE_MINERAL_ITEM_ID,
            variant_id: filler_variant,
            quantity: 1,
            reserved: 0,
            available: 1,
        });
        filler_variant = filler_variant.saturating_add(1);
    }
    assert_eq!(state.exchange_slot_count(), 50);
    let new_full_exchange_variant = 909_909;
    state.add_actor_inventory_stack(
        &player,
        AMMO_SLUG_IRON_ITEM_ID,
        new_full_exchange_variant,
        "Iron Slug",
        20,
        RESOURCE_STACK_CAP,
        "field-pack",
    );
    let full = state.apply_envelope(
        &config,
        command(
            6,
            ClientCommand::StoreToExchange {
                item_id: AMMO_SLUG_IRON_ITEM_ID,
                variant_id: new_full_exchange_variant,
                quantity: 5,
            },
        ),
    );
    assert_eq!(
        full.status,
        AuthorityCommandStatus::Rejected,
        "exchange at 50 slots must reject a new distinct stack"
    );
}

#[test]
fn authority_survey_reports_concentration_without_extracting() {
    let config = SliceAuthorityConfig::default();
    let snapshot = crate::authority_test_slice();
    let mut state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    let player = config.player_actor_id.clone();
    grant_test_profession(&mut state, &player, AuthorityProfessionKind::Craftsman);
    seed_test_tool(
        &mut state,
        &player,
        FIELD_MULTITOOL_ITEM_ID,
        "Field Multitool",
    );
    seed_test_survey_tool(&mut state, &player);
    let mineral = |s: &SliceAuthorityState| -> u32 {
        s.inventory_snapshots()
            .iter()
            .filter(|r| {
                r.item_id == RESOURCE_MINERAL_ITEM_ID
                    && actor_owns_inventory_container(&player, &r.container)
            })
            .map(|r| r.quantity)
            .sum()
    };
    let before = mineral(&state);

    let survey = state.apply_envelope(
        &config,
        command(
            1,
            ClientCommand::SurveyResource {
                family: "mineral".to_owned(),
            },
        ),
    );
    assert_eq!(
        survey.status,
        AuthorityCommandStatus::Accepted,
        "survey: {:?}",
        survey.reason_code
    );
    // Survey scans only — it must not extract anything.
    assert_eq!(mineral(&state), before, "survey must not change inventory");
    assert!(state
        .timeline_event_snapshots()
        .iter()
        .any(|event| event.label.contains("surveyed")));

    // An unknown family is rejected.
    let bad = state.apply_envelope(
        &config,
        command(
            2,
            ClientCommand::SurveyResource {
                family: "not_a_family".to_owned(),
            },
        ),
    );
    assert_eq!(bad.status, AuthorityCommandStatus::Rejected);
}

#[test]
fn authority_crafts_field_supplies_from_clodpowder_and_iron() {
    let config = SliceAuthorityConfig::default();
    let mut snapshot = crate::authority_test_slice();
    expand_resource_test_area(&mut snapshot, "authority-test-overworld");
    let mut state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    let player = config.player_actor_id.clone();
    grant_test_profession(&mut state, &player, AuthorityProfessionKind::Craftsman);
    grant_test_profession(&mut state, &player, AuthorityProfessionKind::Medic);
    seed_test_tool(
        &mut state,
        &player,
        FIELD_MULTITOOL_ITEM_ID,
        "Field Multitool",
    );
    seed_test_survey_tool(&mut state, &player);
    let owned = |s: &SliceAuthorityState, item_id: u32| -> u32 {
        s.inventory_snapshots()
            .iter()
            .filter(|row| {
                row.item_id == item_id && actor_owns_inventory_container(&player, &row.container)
            })
            .map(|row| row.quantity)
            .sum()
    };
    let has_encoded_medical_stack =
        |s: &SliceAuthorityState, item_id: u32, kind: MedicalSchematicKind| -> bool {
            s.inventory_snapshots().iter().any(|row| {
                row.item_id == item_id
                    && actor_owns_inventory_container(&player, &row.container)
                    && decode_medical_variant(kind, row.variant_id).is_some()
            })
        };

    // Iron (mineral) comes from the ground via the survey/sample loop.
    let (resource, rich_cell, concentration_milli) =
        rich_resource_cell_for_test(&state, "authority-test-overworld", "mineral");
    let expected_sample_yield = resource_sample_yield(
        resource.stats.extraction_yield,
        concentration_milli,
        state.actor_crafting_tool_quality_milli(&player),
    );
    assert!(
        expected_sample_yield > 0,
        "known-rich cell should yield iron for field-supply crafting"
    );
    move_actor_to_cell_for_test(&mut state, &player, rich_cell);
    let iron_before_sampling = owned(&state, RESOURCE_MINERAL_ITEM_ID);
    let mut command_id = 1;
    for _ in 0..8 {
        let frame = state.apply_envelope(
            &config,
            command(
                command_id,
                ClientCommand::SampleResource {
                    family: "mineral".to_owned(),
                    stop: false,
                },
            ),
        );
        assert_eq!(
            frame.status,
            AuthorityCommandStatus::Accepted,
            "sample rejected: {:?}",
            frame.reason_code
        );
        command_id += 1;
        let resolve_tick = state
            .actors
            .get(&player)
            .and_then(|actor| actor.pending_resource_sample.as_ref())
            .map(|sample| sample.resolve_tick)
            .expect("sample should be pending");
        let ticks_to_resolve = resolve_tick.saturating_sub(state.tick());
        advance_ticks_unclamped(&mut state, &config, ticks_to_resolve);
        state.stop_actor_resource_sample_loop(&player);
        state.clear_actor_economy_action_cooldown(&player);
    }
    assert_eq!(
        owned(&state, RESOURCE_MINERAL_ITEM_ID),
        iron_before_sampling + expected_sample_yield.saturating_mul(8),
        "sampling on the selected rich cell should add the derived field yield each time"
    );
    // Clodpowder is looted from Creatures; seed a stack to stand in for that loot.
    state.add_actor_inventory_stack(
        &player,
        RESOURCE_CLODPOWDER_ITEM_ID,
        46_000_000,
        "Clodpowder",
        200,
        RESOURCE_STACK_CAP,
        "resource-crate",
    );

    let iron_before = owned(&state, RESOURCE_MINERAL_ITEM_ID);
    let powder_before = owned(&state, RESOURCE_CLODPOWDER_ITEM_ID);
    assert!(
        iron_before >= CRAFT_SUPPLY_AMMO_IRON_QTY,
        "need sampled iron, got {iron_before}"
    );
    let expected_ammo_output = CRAFT_SUPPLY_AMMO_OUTPUT_QTY;
    let expected_bandage_output = CRAFT_SUPPLY_BANDAGE_OUTPUT_QTY;
    let expected_res_kit_output = CRAFT_SUPPLY_RESUSCITATION_KIT_OUTPUT_QTY;
    let expected_personal_shield_output = CRAFT_SUPPLY_PERSONAL_SHIELD_GENERATOR_OUTPUT_QTY;

    // Craft ammo: consumes {clodpowder + iron}, yields a batch of rounds.
    let ammo_before = owned(&state, AMMO_SLUG_IRON_ITEM_ID);
    let ammo = state.apply_envelope(
        &config,
        command(
            command_id,
            ClientCommand::CraftItem {
                schematic_id: "slug_iron".to_owned(),
                experiment_power: 0,
                experiment_handling: 0,
                experiment_reliability: 0,
            },
        ),
    );
    command_id += 1;
    assert_eq!(
        ammo.status,
        AuthorityCommandStatus::Accepted,
        "ammo craft: {:?}",
        ammo.reason_code
    );
    assert_eq!(
        owned(&state, AMMO_SLUG_IRON_ITEM_ID),
        ammo_before + expected_ammo_output
    );
    assert_eq!(
        owned(&state, RESOURCE_CLODPOWDER_ITEM_ID),
        powder_before - CRAFT_SUPPLY_AMMO_CLODPOWDER_QTY
    );
    assert_eq!(
        owned(&state, RESOURCE_MINERAL_ITEM_ID),
        iron_before - CRAFT_SUPPLY_AMMO_IRON_QTY
    );
    let ammo_batch_ticks = state.economy_action_ticks(CRAFT_SUPPLY_AMMO_BATCH_MS);
    advance_ticks_unclamped(&mut state, &config, ammo_batch_ticks);

    // Craft a bandage and a stimpak from the same shared inputs.
    let bandage_before = owned(&state, FIELD_BANDAGE_ITEM_ID);
    let bandage = state.apply_envelope(
        &config,
        command(
            command_id,
            ClientCommand::CraftItem {
                schematic_id: "field_bandage".to_owned(),
                experiment_power: 0,
                experiment_handling: 0,
                experiment_reliability: 0,
            },
        ),
    );
    command_id += 1;
    assert_eq!(
        bandage.status,
        AuthorityCommandStatus::Accepted,
        "bandage craft: {:?}",
        bandage.reason_code
    );
    assert_eq!(
        owned(&state, FIELD_BANDAGE_ITEM_ID),
        bandage_before + expected_bandage_output
    );
    let bandage_batch_ticks = state.economy_action_ticks(CRAFT_SUPPLY_BANDAGE_BATCH_MS);
    advance_ticks_unclamped(&mut state, &config, bandage_batch_ticks);

    let stim_before = owned(&state, STIMPAK_A_ITEM_ID);
    let stim = state.apply_envelope(
        &config,
        command(
            command_id,
            ClientCommand::CraftItem {
                schematic_id: "stimpak".to_owned(),
                experiment_power: 0,
                experiment_handling: 0,
                experiment_reliability: 0,
            },
        ),
    );
    command_id += 1;
    assert_eq!(
        stim.status,
        AuthorityCommandStatus::Accepted,
        "stimpak craft: {:?}",
        stim.reason_code
    );
    let stim_delta = owned(&state, STIMPAK_A_ITEM_ID).saturating_sub(stim_before);
    assert!(
        (4..=20).contains(&stim_delta),
        "Stimpak A craft should use quality-derived stack output, got {stim_delta}"
    );
    assert!(
        has_encoded_medical_stack(&state, STIMPAK_A_ITEM_ID, MedicalSchematicKind::StimpakA),
        "Stimpak A craft should produce an encoded medical variant"
    );
    let stimpak_batch_ticks = state.economy_action_ticks(CRAFT_SUPPLY_STIMPAK_BATCH_MS);
    advance_ticks_unclamped(&mut state, &config, stimpak_batch_ticks);

    let body_pack_before = owned(&state, BODY_ENHANCEMENT_PACK_A_ITEM_ID);
    let body_pack = state.apply_envelope(
        &config,
        command(
            command_id,
            ClientCommand::CraftItem {
                schematic_id: "body_enhancement_pack_a".to_owned(),
                experiment_power: 0,
                experiment_handling: 0,
                experiment_reliability: 0,
            },
        ),
    );
    command_id += 1;
    assert_eq!(
        body_pack.status,
        AuthorityCommandStatus::Accepted,
        "body enhancement pack craft: {:?}",
        body_pack.reason_code
    );
    let body_delta =
        owned(&state, BODY_ENHANCEMENT_PACK_A_ITEM_ID).saturating_sub(body_pack_before);
    assert!(
        (20..=40).contains(&body_delta),
        "Body Enhancement Pack A craft should use quality-derived stack output, got {body_delta}"
    );
    assert!(
        has_encoded_medical_stack(
            &state,
            BODY_ENHANCEMENT_PACK_A_ITEM_ID,
            MedicalSchematicKind::BodyEnhancementPackA
        ),
        "Body Enhancement Pack A craft should produce an encoded medical variant"
    );
    let enhancement_batch_ticks =
        state.economy_action_ticks(CRAFT_SUPPLY_ENHANCEMENT_PACK_BATCH_MS);
    advance_ticks_unclamped(&mut state, &config, enhancement_batch_ticks);

    let spirit_pack_before = owned(&state, SPIRIT_ENHANCEMENT_PACK_A_ITEM_ID);
    let spirit_pack = state.apply_envelope(
        &config,
        command(
            command_id,
            ClientCommand::CraftItem {
                schematic_id: "spirit_enhancement_pack_a".to_owned(),
                experiment_power: 0,
                experiment_handling: 0,
                experiment_reliability: 0,
            },
        ),
    );
    command_id += 1;
    assert_eq!(
        spirit_pack.status,
        AuthorityCommandStatus::Accepted,
        "spirit enhancement pack craft: {:?}",
        spirit_pack.reason_code
    );
    let spirit_delta =
        owned(&state, SPIRIT_ENHANCEMENT_PACK_A_ITEM_ID).saturating_sub(spirit_pack_before);
    assert!(
        (20..=40).contains(&spirit_delta),
        "Spirit Enhancement Pack A craft should use quality-derived stack output, got {spirit_delta}"
    );
    assert!(
        has_encoded_medical_stack(
            &state,
            SPIRIT_ENHANCEMENT_PACK_A_ITEM_ID,
            MedicalSchematicKind::SpiritEnhancementPackA
        ),
        "Spirit Enhancement Pack A craft should produce an encoded medical variant"
    );
    let enhancement_batch_ticks =
        state.economy_action_ticks(CRAFT_SUPPLY_ENHANCEMENT_PACK_BATCH_MS);
    advance_ticks_unclamped(&mut state, &config, enhancement_batch_ticks);

    let res_kit_before = owned(&state, RESUSCITATION_KIT_ITEM_ID);
    let res_kit = state.apply_envelope(
        &config,
        command(
            command_id,
            ClientCommand::CraftItem {
                schematic_id: "resuscitation_kit".to_owned(),
                experiment_power: 0,
                experiment_handling: 0,
                experiment_reliability: 0,
            },
        ),
    );
    command_id += 1;
    assert_eq!(
        res_kit.status,
        AuthorityCommandStatus::Accepted,
        "resuscitation kit craft: {:?}",
        res_kit.reason_code
    );
    assert_eq!(
        owned(&state, RESUSCITATION_KIT_ITEM_ID),
        res_kit_before + expected_res_kit_output
    );
    let res_kit_batch_ticks = state.economy_action_ticks(CRAFT_SUPPLY_RESUSCITATION_KIT_BATCH_MS);
    advance_ticks_unclamped(&mut state, &config, res_kit_batch_ticks);

    let personal_shield_before = owned(&state, PERSONAL_SHIELD_GENERATOR_ITEM_ID);
    let personal_shield = state.apply_envelope(
        &config,
        command(
            command_id,
            ClientCommand::CraftItem {
                schematic_id: "personal_shield_generator".to_owned(),
                experiment_power: 0,
                experiment_handling: 0,
                experiment_reliability: 0,
            },
        ),
    );
    command_id += 1;
    assert_eq!(
        personal_shield.status,
        AuthorityCommandStatus::Accepted,
        "personal shield generator craft: {:?}",
        personal_shield.reason_code
    );
    assert_eq!(
        owned(&state, PERSONAL_SHIELD_GENERATOR_ITEM_ID),
        personal_shield_before + expected_personal_shield_output
    );
    let personal_shield_rows = state
        .inventory_snapshots()
        .into_iter()
        .filter(|row| {
            row.item_id == PERSONAL_SHIELD_GENERATOR_ITEM_ID
                && actor_owns_inventory_container(&player, &row.container)
        })
        .collect::<Vec<_>>();
    assert!(personal_shield_rows
        .iter()
        .all(|row| row.quantity <= PERSONAL_SHIELD_GENERATOR_STACK_CAP));
    assert_eq!(
        owned(&state, RESOURCE_CLODPOWDER_ITEM_ID),
        powder_before
            - CRAFT_SUPPLY_AMMO_CLODPOWDER_QTY
            - CRAFT_SUPPLY_BANDAGE_CLODPOWDER_QTY
            - CRAFT_SUPPLY_STIMPAK_CLODPOWDER_QTY
            - CRAFT_SUPPLY_ENHANCEMENT_PACK_CLODPOWDER_QTY
            - CRAFT_SUPPLY_ENHANCEMENT_PACK_CLODPOWDER_QTY
            - CRAFT_SUPPLY_RESUSCITATION_KIT_CLODPOWDER_QTY
            - CRAFT_SUPPLY_PERSONAL_SHIELD_GENERATOR_CLODPOWDER_QTY
    );
    let personal_shield_batch_ticks =
        state.economy_action_ticks(CRAFT_SUPPLY_PERSONAL_SHIELD_GENERATOR_BATCH_MS);
    advance_ticks_unclamped(&mut state, &config, personal_shield_batch_ticks);

    // Exhaust clodpowder, then a further craft is rejected WITHOUT burning iron
    // (atomic pre-check).
    let powder_left = owned(&state, RESOURCE_CLODPOWDER_ITEM_ID);
    if powder_left > 0 {
        state
            .consume_actor_inventory_quantity(&player, RESOURCE_CLODPOWDER_ITEM_ID, powder_left)
            .unwrap();
    }
    let iron_guard = owned(&state, RESOURCE_MINERAL_ITEM_ID);
    let denied = state.apply_envelope(
        &config,
        command(
            command_id,
            ClientCommand::CraftItem {
                schematic_id: "slug_iron".to_owned(),
                experiment_power: 0,
                experiment_handling: 0,
                experiment_reliability: 0,
            },
        ),
    );
    command_id += 1;
    assert_eq!(denied.status, AuthorityCommandStatus::Rejected);
    assert_eq!(
        owned(&state, RESOURCE_MINERAL_ITEM_ID),
        iron_guard,
        "rejected craft must not burn iron"
    );

    // An unknown schematic is rejected.
    let unknown = state.apply_envelope(
        &config,
        command(
            command_id,
            ClientCommand::CraftItem {
                schematic_id: "rocket_launcher".to_owned(),
                experiment_power: 0,
                experiment_handling: 0,
                experiment_reliability: 0,
            },
        ),
    );
    assert_eq!(unknown.status, AuthorityCommandStatus::Rejected);

    assert!(state
        .timeline_event_snapshots()
        .iter()
        .any(|event| event.label.contains("crafted Iron Slug")));
}

#[test]
fn authority_inventory_stack_caps_split_actor_and_exchange_stacks() {
    let config = SliceAuthorityConfig::default();
    let mut snapshot = crate::authority_test_slice();
    snapshot.actors.clear();
    snapshot.inventory.clear();
    snapshot.npc_jobs.clear();
    snapshot
        .props
        .push(test_exchange_prop(CellSnapshot::new(20, 20)));
    snapshot.actors.push(test_actor(
        "player",
        "Field Observer",
        "player",
        CellSnapshot::new(20, 20),
        "right",
    ));
    let mut state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();

    assert_eq!(
        state.add_actor_inventory_stack(
            "player",
            AMMO_SLUG_IRON_ITEM_ID,
            0,
            "Iron Slug",
            2_500,
            RESOURCE_STACK_CAP,
            "field-pack",
        ),
        2_500
    );
    assert_eq!(
        state.add_actor_inventory_stack(
            "player",
            STIMPAK_A_ITEM_ID,
            0,
            "Stimpak A",
            60,
            RESOURCE_STACK_CAP,
            "field-pack",
        ),
        60
    );
    assert_eq!(
        state.add_actor_inventory_stack(
            "player",
            FIELD_BANDAGE_ITEM_ID,
            0,
            "Field Bandage",
            60,
            RESOURCE_STACK_CAP,
            "field-pack",
        ),
        60
    );
    assert_eq!(
        state.add_actor_inventory_stack(
            "player",
            RESOURCE_MINERAL_ITEM_ID,
            7,
            "Iron Resource Container",
            120_500,
            RESOURCE_STACK_CAP,
            "resource-crate",
        ),
        120_500
    );
    let actor_rows = state.inventory_snapshots();
    let actor_item_rows = |item_id: u32| -> Vec<InventoryStackSnapshot> {
        actor_rows
            .iter()
            .filter(|row| {
                row.item_id == item_id && actor_owns_inventory_container("player", &row.container)
            })
            .cloned()
            .collect()
    };
    let ammo_rows = actor_item_rows(AMMO_SLUG_IRON_ITEM_ID);
    assert_eq!(
        ammo_rows.iter().map(|row| row.available).sum::<u32>(),
        2_500
    );
    assert!(ammo_rows
        .iter()
        .all(|row| row.quantity <= AMMO_SLUG_STACK_CAP));
    let stim_rows = actor_item_rows(STIMPAK_A_ITEM_ID);
    assert_eq!(stim_rows.iter().map(|row| row.available).sum::<u32>(), 60);
    assert!(stim_rows
        .iter()
        .all(|row| row.quantity <= STIMPAK_A_STACK_CAP));
    let bandage_rows = actor_item_rows(FIELD_BANDAGE_ITEM_ID);
    assert_eq!(
        bandage_rows.iter().map(|row| row.available).sum::<u32>(),
        60
    );
    assert!(bandage_rows
        .iter()
        .all(|row| row.quantity <= FIELD_BANDAGE_STACK_CAP));
    let resource_rows = actor_item_rows(RESOURCE_MINERAL_ITEM_ID);
    assert_eq!(
        resource_rows.iter().map(|row| row.available).sum::<u32>(),
        120_500
    );
    assert!(resource_rows
        .iter()
        .all(|row| row.quantity <= RESOURCE_STACK_CAP));

    state.inventory.push(InventoryStackSnapshot {
        stack_id: 0,
        container: EXCHANGE_CONTAINER.to_owned(),
        item: "Iron Slug".to_owned(),
        item_id: AMMO_SLUG_IRON_ITEM_ID,
        variant_id: 0,
        quantity: 990,
        reserved: 0,
        available: 990,
    });
    state
        .apply_store_to_exchange(&config, AMMO_SLUG_IRON_ITEM_ID, 0, 20)
        .unwrap();
    let exchange_ammo_rows: Vec<_> = state
        .inventory_snapshots()
        .into_iter()
        .filter(|row| row.container == EXCHANGE_CONTAINER && row.item_id == AMMO_SLUG_IRON_ITEM_ID)
        .collect();
    assert_eq!(
        exchange_ammo_rows
            .iter()
            .map(|row| row.available)
            .sum::<u32>(),
        1_010
    );
    assert!(exchange_ammo_rows
        .iter()
        .all(|row| row.quantity <= AMMO_SLUG_STACK_CAP));

    state.clear_actor_economy_action_cooldown("player");
    state.inventory.push(InventoryStackSnapshot {
        stack_id: 0,
        container: EXCHANGE_CONTAINER.to_owned(),
        item: "Field Bandage".to_owned(),
        item_id: FIELD_BANDAGE_ITEM_ID,
        variant_id: 0,
        quantity: 24,
        reserved: 0,
        available: 24,
    });
    state
        .apply_store_to_exchange(&config, FIELD_BANDAGE_ITEM_ID, 0, 10)
        .unwrap();
    let exchange_bandage_rows: Vec<_> = state
        .inventory_snapshots()
        .into_iter()
        .filter(|row| row.container == EXCHANGE_CONTAINER && row.item_id == FIELD_BANDAGE_ITEM_ID)
        .collect();
    assert_eq!(
        exchange_bandage_rows
            .iter()
            .map(|row| row.available)
            .sum::<u32>(),
        34
    );
    assert!(exchange_bandage_rows
        .iter()
        .all(|row| row.quantity <= FIELD_BANDAGE_STACK_CAP));
}

#[test]
fn authority_crafting_session_battery_full_flow_consumes_exact_slots_and_awards_xp() {
    let config = SliceAuthorityConfig::default();
    let snapshot = crate::authority_test_slice();
    let mut state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    let player = config.player_actor_id.clone();
    grant_test_profession(&mut state, &player, AuthorityProfessionKind::Craftsman);
    grant_craftsman_session_test_skills(&mut state, &player);
    seed_test_tool(
        &mut state,
        &player,
        FIELD_MULTITOOL_ITEM_ID,
        "Field Multitool",
    );
    let (copper, iron, fuel) = seed_test_battery_resources(&mut state, &player, 221_001, 211_001);

    let begin = state.apply_envelope(
        &config,
        command(
            1,
            ClientCommand::CraftBegin {
                recipe_id: "extractor_battery".to_owned(),
            },
        ),
    );
    assert_eq!(
        begin.status,
        AuthorityCommandStatus::Accepted,
        "CraftBegin rejected: {:?}",
        begin.reason_code
    );
    let begin_vm = begin
        .craft_session
        .as_ref()
        .expect("begin publishes session VM");
    assert_eq!(begin_vm.phase, "slots");
    assert!(begin_vm.recipes.iter().any(|recipe| {
        recipe.recipe_id == "extractor_battery"
            && recipe.unlocked
            && recipe.required_tool_item_id == FIELD_MULTITOOL_ITEM_ID
    }));
    let slot_screen = begin_vm.slot_screen.as_ref().expect("slot screen");
    assert!(!slot_screen.can_assemble);
    assert_eq!(slot_screen.slots[0].eligible[0].variant_id, copper.2);
    assert!(slot_screen.slots[0].eligible[0].recommended);

    for (command_id, slot_index, assignment) in [
        (2, 0_u8, copper.clone()),
        (3, 1_u8, iron.clone()),
        (4, 2_u8, fuel.clone()),
    ] {
        let assigned = state.apply_envelope(
            &config,
            command(
                command_id,
                ClientCommand::CraftAssignSlot {
                    slot_index,
                    container: assignment.0,
                    stack_id: assignment.1,
                    variant_id: assignment.2,
                },
            ),
        );
        assert_eq!(
            assigned.status,
            AuthorityCommandStatus::Accepted,
            "CraftAssignSlot {slot_index} rejected: {:?}",
            assigned.reason_code
        );
    }

    let assemble = state.apply_envelope(&config, command(5, ClientCommand::CraftAssemble {}));
    assert_eq!(
        assemble.status,
        AuthorityCommandStatus::Accepted,
        "CraftAssemble rejected: {:?}",
        assemble.reason_code
    );
    let assembled_session = state
        .actors
        .get(&player)
        .and_then(|actor| actor.craft_session.as_ref())
        .expect("assembled session remains open");
    assert_eq!(assembled_session.phase, CraftSessionPhase::Assembled);
    assert!(assembled_session.assembly_quality_milli > 0);
    assert!(assembled_session.experimentation_points_remaining > 0);
    let line_before = assembled_session.lines[0].value_milli;
    assert_eq!(
        state
            .actors
            .get(&player)
            .and_then(|actor| actor
                .professions
                .xp
                .get(&AuthorityProfessionKind::Craftsman))
            .copied()
            .unwrap_or(0),
        CRAFT_XP_PER_TIER * 2
    );
    let craftsman = &state.actors[&player].professions;
    assert_eq!(
        craftsman.track_xp_amount(AuthorityProfessionKind::Craftsman, "assembly"),
        CRAFT_XP_PER_TIER * 2,
        "assembly pays only the Assembly track"
    );
    assert_eq!(
        craftsman.track_xp_amount(AuthorityProfessionKind::Craftsman, "experimentation"),
        0,
        "assembling does not paint unearned Experimentation progress"
    );

    let experiment = state.apply_envelope(
        &config,
        command(
            6,
            ClientCommand::CraftExperiment {
                line_id: 0,
                points: 1,
            },
        ),
    );
    assert_eq!(
        experiment.status,
        AuthorityCommandStatus::Accepted,
        "CraftExperiment rejected: {:?}",
        experiment.reason_code
    );
    let line_after = state
        .actors
        .get(&player)
        .and_then(|actor| actor.craft_session.as_ref())
        .and_then(|session| session.lines.first())
        .map(|line| line.value_milli)
        .expect("experimented line");
    assert!(line_after >= line_before);
    assert_eq!(
        state
            .actors
            .get(&player)
            .and_then(|actor| actor
                .professions
                .xp
                .get(&AuthorityProfessionKind::Craftsman))
            .copied()
            .unwrap_or(0),
        CRAFT_XP_PER_TIER * 2 + CRAFT_XP_PER_EXPERIMENT_POINT
    );
    let craftsman = &state.actors[&player].professions;
    assert_eq!(
        craftsman.track_xp_amount(AuthorityProfessionKind::Craftsman, "assembly"),
        CRAFT_XP_PER_TIER * 2
    );
    assert_eq!(
        craftsman.track_xp_amount(AuthorityProfessionKind::Craftsman, "experimentation"),
        CRAFT_XP_PER_EXPERIMENT_POINT,
        "only a real experimentation attempt pays Experimentation XP"
    );

    let finalize = state.apply_envelope(
        &config,
        command(
            7,
            ClientCommand::CraftFinalizePrototype {
                custom_name: String::new(),
            },
        ),
    );
    assert_eq!(
        finalize.status,
        AuthorityCommandStatus::Accepted,
        "CraftFinalizePrototype rejected: {:?}",
        finalize.reason_code
    );
    assert!(state
        .actors
        .get(&player)
        .and_then(|actor| actor.craft_session.as_ref())
        .is_none());
    let battery = state
        .inventory_snapshots()
        .into_iter()
        .find(|row| {
            row.item_id == EXTRACTOR_BATTERY_ITEM_ID
                && actor_owns_inventory_container(&player, &row.container)
        })
        .expect("prototype battery added to inventory");
    assert!(decode_battery_runtime_seconds(battery.variant_id).is_some());
    assert!(!state.inventory_snapshots().iter().any(|row| {
        actor_owns_inventory_container(&player, &row.container)
            && row.item_id == RESOURCE_COPPER_ITEM_ID
            && row.variant_id == copper.2
            && row.available > 0
    }));
    assert!(!state.inventory_snapshots().iter().any(|row| {
        actor_owns_inventory_container(&player, &row.container)
            && row.item_id == RESOURCE_MINERAL_ITEM_ID
            && row.variant_id == iron.2
            && row.available > 0
    }));
}

#[test]
fn authority_irrigation_sprinkler_catalog_exposes_canonical_slots_and_career_tool_gates() {
    let config = SliceAuthorityConfig::default();
    let snapshot = crate::authority_test_slice();
    let mut state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    let player = config.player_actor_id.clone();
    clear_test_professions(&mut state, &player);
    state.inventory.retain(|row| {
        !(actor_owns_inventory_container(&player, &row.container)
            && row.item_id == FIELD_MULTITOOL_ITEM_ID)
    });

    let locked_browse = state
        .craft_session_snapshot_for_observer(&config)
        .expect("craft browse snapshot");
    let locked_recipe = locked_browse
        .recipes
        .iter()
        .find(|recipe| recipe.recipe_id == "irrigation_sprinkler")
        .expect("irrigation sprinkler recipe is exposed in the catalog");
    assert!(!locked_recipe.unlocked);
    assert_eq!(locked_recipe.output_item_id, 6_301);
    assert_eq!(locked_recipe.required_profession, "craftsman-novice");
    assert_eq!(locked_recipe.required_tool_item_id, FIELD_MULTITOOL_ITEM_ID);
    assert!(!locked_recipe.hands_craftable);
    let detail = locked_browse
        .details
        .iter()
        .find(|detail| detail.recipe_id == "irrigation_sprinkler")
        .expect("irrigation sprinkler detail is exposed with the catalog");
    let slots = detail
        .slots
        .iter()
        .map(|slot| {
            (
                slot.slot_index,
                slot.required_item_id,
                slot.required_family.as_deref(),
                slot.required_qty,
            )
        })
        .collect::<Vec<_>>();
    assert_eq!(
        slots,
        vec![
            (0, Some(2_007), Some("copper"), 24),
            (1, Some(2_010), Some("polymer"), 12),
        ],
        "the catalog must publish the canonical material families, catalog IDs, and quantities"
    );

    let locked_begin = state.apply_envelope(
        &config,
        command(
            1,
            ClientCommand::CraftBegin {
                recipe_id: "irrigation_sprinkler".to_owned(),
            },
        ),
    );
    assert_eq!(locked_begin.status, AuthorityCommandStatus::Rejected);
    assert_eq!(
        locked_begin.reason_code.as_deref(),
        Some(AuthorityRejectReason::UnknownSchematic.code())
    );
    assert!(state
        .actors
        .get(&player)
        .and_then(|actor| actor.craft_session.as_ref())
        .is_none());

    grant_test_profession(&mut state, &player, AuthorityProfessionKind::Craftsman);
    let unlocked_browse = state
        .craft_session_snapshot_for_observer(&config)
        .expect("craft browse snapshot after profession unlock");
    let unlocked_recipe = unlocked_browse
        .recipes
        .iter()
        .find(|recipe| recipe.recipe_id == "irrigation_sprinkler")
        .expect("irrigation sprinkler recipe remains cataloged");
    assert!(unlocked_recipe.unlocked);
    assert_eq!(unlocked_recipe.source, "profession");

    let missing_tool = state.apply_envelope(
        &config,
        command(
            2,
            ClientCommand::CraftBegin {
                recipe_id: "irrigation_sprinkler".to_owned(),
            },
        ),
    );
    assert_eq!(missing_tool.status, AuthorityCommandStatus::Rejected);
    assert_eq!(
        missing_tool.reason_code.as_deref(),
        Some(AuthorityRejectReason::MissingSurveyTool.code())
    );
    assert!(state
        .actors
        .get(&player)
        .and_then(|actor| actor.craft_session.as_ref())
        .is_none());
}

#[test]
fn authority_slugthrower_catalog_has_one_canonical_output_and_rejects_unregistered_recipe_ids() {
    let config = SliceAuthorityConfig::default();
    let snapshot = crate::authority_test_slice();
    let mut state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    let browse = state
        .craft_session_snapshot_for_observer(&config)
        .expect("craft browse snapshot");
    let slugthrower_recipes = browse
        .recipes
        .iter()
        .filter(|recipe| recipe.output_item_id == 3_101)
        .collect::<Vec<_>>();
    assert_eq!(
        slugthrower_recipes.len(),
        1,
        "catalog item 3101 must have exactly one craft recipe"
    );
    assert_eq!(slugthrower_recipes[0].recipe_id, "slugthrower");

    let mapped_slugthrower_outputs = browse
        .recipes
        .iter()
        .filter(|recipe| {
            weapon_id_for_inventory_item(recipe.output_item_id)
                == Some(AuthorityWeaponId::Slugthrower)
        })
        .map(|recipe| (recipe.recipe_id.as_str(), recipe.output_item_id))
        .collect::<Vec<_>>();
    assert_eq!(mapped_slugthrower_outputs, vec![("slugthrower", 3_101)]);
    let weapon = weapon_id_for_inventory_item(3_101).expect("catalog item 3101 is equippable");
    assert_eq!(weapon, AuthorityWeaponId::Slugthrower);
    assert_eq!(authority_weapon_id_label(weapon), "slugthrower");
    assert_eq!(
        authority_weapon_id_from_label("slugthrower"),
        Some(AuthorityWeaponId::Slugthrower)
    );
    assert_eq!(
        weapon_profile(Some(weapon)).id,
        AuthorityWeaponId::Slugthrower
    );

    let unregistered_recipe_id = (0_u32..)
        .map(|suffix| format!("unregistered-craft-{suffix}"))
        .find(|candidate| {
            !browse
                .recipes
                .iter()
                .any(|recipe| recipe.recipe_id == *candidate)
        })
        .expect("finite craft catalog leaves an unregistered recipe id");
    let rejected = state.apply_envelope(
        &config,
        command(
            1,
            ClientCommand::CraftBegin {
                recipe_id: unregistered_recipe_id,
            },
        ),
    );
    assert_eq!(rejected.status, AuthorityCommandStatus::Rejected);
    assert_eq!(
        rejected.reason_code.as_deref(),
        Some(AuthorityRejectReason::UnknownSchematic.code())
    );
    assert!(state
        .actors
        .get(&config.player_actor_id)
        .and_then(|actor| actor.craft_session.as_ref())
        .is_none());
}

#[test]
fn authority_weapon_stats_form_the_primitive_powered_and_carbine_progression_ladders() {
    let field = weapon_profile(Some(AuthorityWeaponId::FieldSaber))
        .roll_stats
        .expect("field saber roll stats");
    let quarry = weapon_profile(Some(AuthorityWeaponId::QuarryChopper))
        .roll_stats
        .expect("quarry chopper roll stats");
    let vibro = weapon_profile(Some(AuthorityWeaponId::Vibrosword))
        .roll_stats
        .expect("vibrosword roll stats");
    assert!(field.attack_speed_ms < quarry.attack_speed_ms);
    assert!(field.damage_max < quarry.damage_max);
    assert!(quarry.damage_max < vibro.damage_max);
    assert_eq!(field.max_range, quarry.max_range);
    assert!(vibro.max_acc > quarry.max_acc);

    let sten = weapon_profile(Some(AuthorityWeaponId::WpnSmg))
        .roll_stats
        .expect("STEN roll stats");
    let kiln = weapon_profile(Some(AuthorityWeaponId::WpnCarbine))
        .roll_stats
        .expect("Kiln roll stats");
    let lightning = weapon_profile(Some(AuthorityWeaponId::LightningCarbine))
        .roll_stats
        .expect("Lightning roll stats");
    assert!(kiln.damage_max > sten.damage_max);
    assert!(kiln.ideal_range > sten.ideal_range);
    assert!(lightning.damage_max > kiln.damage_max);
    assert!(lightning.attack_speed_ms < kiln.attack_speed_ms);
    assert!(lightning.ideal_acc > kiln.ideal_acc);
}

#[test]
fn authority_weapon_progression_recipes_craft_existing_variant_contracts() {
    fn craft_once(
        recipe_id: &str,
        output_item_id: u32,
        resources: &[(u32, u32, u32)],
    ) -> InventoryStackSnapshot {
        let config = SliceAuthorityConfig::default();
        let mut state = SliceAuthorityState::from_snapshot(&crate::authority_test_slice()).unwrap();
        let player = config.player_actor_id.clone();
        grant_test_profession(&mut state, &player, AuthorityProfessionKind::Craftsman);
        {
            let actor = state.actors.get_mut(&player).expect("player exists");
            for skill_box_id in [
                "craftsman-assembly-i",
                "craftsman-assembly-ii",
                "craftsman-assembly-iii",
                "craftsman-assembly-iv",
            ] {
                actor
                    .professions
                    .skill_boxes
                    .insert(skill_box_id.to_owned());
            }
        }
        seed_test_tool(
            &mut state,
            &player,
            FIELD_MULTITOOL_ITEM_ID,
            "Field Multitool",
        );
        let container = format!("{player}:field-pack");
        let assignments = resources
            .iter()
            .map(|(item_id, variant_id, quantity)| {
                let stack_id = push_test_inventory_stack(
                    &mut state,
                    &container,
                    *item_id,
                    *variant_id,
                    *quantity,
                );
                (stack_id, *variant_id)
            })
            .collect::<Vec<_>>();
        let begin = state.apply_envelope(
            &config,
            command(
                1,
                ClientCommand::CraftBegin {
                    recipe_id: recipe_id.to_owned(),
                },
            ),
        );
        assert_eq!(
            begin.status,
            AuthorityCommandStatus::Accepted,
            "{recipe_id} CraftBegin rejected: {:?}",
            begin.reason_code
        );
        for (index, (stack_id, variant_id)) in assignments.into_iter().enumerate() {
            let assigned = state.apply_envelope(
                &config,
                command(
                    u64::try_from(index).unwrap_or(0).saturating_add(2),
                    ClientCommand::CraftAssignSlot {
                        slot_index: u8::try_from(index).unwrap_or(u8::MAX),
                        container: container.clone(),
                        stack_id: stack_id.to_string(),
                        variant_id,
                    },
                ),
            );
            assert_eq!(
                assigned.status,
                AuthorityCommandStatus::Accepted,
                "{recipe_id} slot {index} rejected: {:?}",
                assigned.reason_code
            );
        }
        let assemble_id = u64::try_from(resources.len())
            .unwrap_or(0)
            .saturating_add(2);
        let assembled = state.apply_envelope(
            &config,
            command(assemble_id, ClientCommand::CraftAssemble {}),
        );
        assert_eq!(
            assembled.status,
            AuthorityCommandStatus::Accepted,
            "{recipe_id} CraftAssemble rejected: {:?}",
            assembled.reason_code
        );
        let finalized = state.apply_envelope(
            &config,
            command(
                assemble_id.saturating_add(1),
                ClientCommand::CraftFinalizePrototype {
                    custom_name: String::new(),
                },
            ),
        );
        assert_eq!(
            finalized.status,
            AuthorityCommandStatus::Accepted,
            "{recipe_id} finalize rejected: {:?}",
            finalized.reason_code
        );
        state
            .inventory_snapshots()
            .into_iter()
            .find(|row| {
                row.item_id == output_item_id
                    && actor_owns_inventory_container(&player, &row.container)
            })
            .expect("crafted weapon added to actor inventory")
    }

    let config = SliceAuthorityConfig::default();
    let state = SliceAuthorityState::from_snapshot(&crate::authority_test_slice()).unwrap();
    let browse = state
        .craft_session_snapshot_for_observer(&config)
        .expect("craft browse snapshot");
    for (recipe_id, output_item_id, required_skill, line_labels, slot_count) in [
        (
            "field_saber",
            FIELD_SABER_ITEM_ID,
            "craftsman-novice",
            vec!["tempo"],
            2,
        ),
        (
            "quarry_chopper",
            QUARRY_CHOPPER_ITEM_ID,
            "craftsman-assembly-i",
            vec!["tempo"],
            2,
        ),
        (
            "kiln_carbine",
            KILN_ENERGY_CELL_ITEM_ID,
            "craftsman-assembly-iii",
            vec!["power", "handling", "reliability"],
            3,
        ),
        (
            "lightning_carbine",
            LIGHTNING_CARBINE_ITEM_ID,
            "craftsman-assembly-iv",
            vec!["power", "handling", "reliability"],
            4,
        ),
    ] {
        let recipe = browse
            .recipes
            .iter()
            .find(|recipe| recipe.recipe_id == recipe_id)
            .expect("weapon recipe is present in the authoritative catalog");
        assert_eq!(recipe.output_item_id, output_item_id);
        assert_eq!(recipe.category, "weapon");
        assert_eq!(recipe.required_profession, required_skill);
        assert!(
            !recipe.unlocked,
            "untrained fixture must not unlock {recipe_id}"
        );
        let detail = browse
            .details
            .iter()
            .find(|detail| detail.recipe_id == recipe_id)
            .expect("weapon recipe publishes slot and experiment detail");
        assert_eq!(detail.slots.len(), slot_count);
        assert_eq!(
            detail
                .stat_lines
                .iter()
                .map(|line| line.label.as_str())
                .collect::<Vec<_>>(),
            line_labels
        );
    }

    let field_saber = craft_once(
        "field_saber",
        FIELD_SABER_ITEM_ID,
        &[
            (RESOURCE_MINERAL_ITEM_ID, 221_001, 10),
            (RESOURCE_CARBON_ITEM_ID, 228_001, 3),
        ],
    );
    let field_speed = decode_melee_weapon_speed_variant_ms(field_saber.variant_id)
        .expect("field saber uses the existing crafted melee-speed variant");
    assert!((900..=1_150).contains(&field_speed));
    assert!(field_saber.item.contains("Field Saber"));

    let quarry_chopper = craft_once(
        "quarry_chopper",
        QUARRY_CHOPPER_ITEM_ID,
        &[
            (RESOURCE_MINERAL_ITEM_ID, 221_002, 14),
            (RESOURCE_CARBON_ITEM_ID, 228_002, 4),
        ],
    );
    let quarry_speed = decode_melee_weapon_speed_variant_ms(quarry_chopper.variant_id)
        .expect("quarry chopper uses the existing crafted melee-speed variant");
    assert!((1_200..=1_500).contains(&quarry_speed));
    assert!(quarry_chopper.item.contains("Quarry Chopper"));

    let kiln = craft_once(
        "kiln_carbine",
        KILN_ENERGY_CELL_ITEM_ID,
        &[
            (
                RESOURCE_MINERAL_ITEM_ID,
                221_003,
                CRAFT_SLUGTHROWER_MINERAL_QTY,
            ),
            (
                RESOURCE_CHEMICAL_ITEM_ID,
                222_777,
                CRAFT_SLUGTHROWER_CHEMICAL_QTY,
            ),
            (
                RESOURCE_POLYMER_ITEM_ID,
                polymer_variant_from_source_variants(222_777, 228_003, 720),
                CRAFT_SLUGTHROWER_POLYMER_QTY,
            ),
        ],
    );
    let kiln_stats = decode_slugthrower_variant(kiln.variant_id)
        .expect("Kiln uses the existing power/handling/reliability variant");
    assert!(kiln_stats.power > 0);
    assert!(kiln_stats.handling > 0);
    assert!(kiln_stats.reliability > 0);
    assert_eq!(
        weapon_id_for_inventory_item(kiln.item_id),
        Some(AuthorityWeaponId::WpnCarbine)
    );

    let lightning = craft_once(
        "lightning_carbine",
        LIGHTNING_CARBINE_ITEM_ID,
        &[
            (RESOURCE_COPPER_ITEM_ID, 227_001, 18),
            (RESOURCE_MINERAL_ITEM_ID, 221_002, 12),
            (
                RESOURCE_POLYMER_ITEM_ID,
                polymer_variant_from_source_variants(227_001, 228_001, 720),
                10,
            ),
            (RESOURCE_GAS_ITEM_ID, 224_004, 6),
        ],
    );
    let lightning_stats = decode_slugthrower_variant(lightning.variant_id)
        .expect("Lightning uses the existing power/handling/reliability variant");
    assert!(lightning_stats.power > 0);
    assert!(lightning_stats.handling > 0);
    assert!(lightning_stats.reliability > 0);
    assert_eq!(
        weapon_id_for_inventory_item(lightning.item_id),
        Some(AuthorityWeaponId::LightningCarbine)
    );
}

#[test]
fn authority_lightning_carbine_rejects_wrong_missing_and_insufficient_slot_inputs() {
    let config = SliceAuthorityConfig::default();
    let mut state = SliceAuthorityState::from_snapshot(&crate::authority_test_slice()).unwrap();
    let player = config.player_actor_id.clone();
    grant_craftsman_session_test_skills(&mut state, &player);
    {
        let actor = state.actors.get_mut(&player).expect("player exists");
        for skill_box_id in [
            "craftsman-assembly-ii",
            "craftsman-assembly-iii",
            "craftsman-assembly-iv",
        ] {
            actor
                .professions
                .skill_boxes
                .insert(skill_box_id.to_owned());
        }
    }
    seed_test_tool(
        &mut state,
        &player,
        FIELD_MULTITOOL_ITEM_ID,
        "Field Multitool",
    );
    let container = format!("{player}:field-pack");
    let copper_variant = 221_501;
    let iron_variant = 211_501;
    let gas_variant = 224_501;
    let copper_stack_id = push_test_inventory_stack(
        &mut state,
        &container,
        RESOURCE_COPPER_ITEM_ID,
        copper_variant,
        18,
    );
    let insufficient_iron_stack_id = push_test_inventory_stack(
        &mut state,
        &container,
        RESOURCE_MINERAL_ITEM_ID,
        iron_variant,
        11,
    );
    let wrong_gas_stack_id =
        push_test_inventory_stack(&mut state, &container, RESOURCE_GAS_ITEM_ID, gas_variant, 6);

    let begin = state.apply_envelope(
        &config,
        command(
            1,
            ClientCommand::CraftBegin {
                recipe_id: "lightning_carbine".to_owned(),
            },
        ),
    );
    assert_eq!(begin.status, AuthorityCommandStatus::Accepted);

    let wrong_receiver = state.apply_envelope(
        &config,
        command(
            2,
            ClientCommand::CraftAssignSlot {
                slot_index: 0,
                container: container.clone(),
                stack_id: wrong_gas_stack_id.to_string(),
                variant_id: gas_variant,
            },
        ),
    );
    assert_eq!(wrong_receiver.status, AuthorityCommandStatus::Rejected);
    assert_eq!(
        wrong_receiver.reason_code.as_deref(),
        Some(AuthorityRejectReason::CraftSlotMismatch.code())
    );

    let copper_assigned = state.apply_envelope(
        &config,
        command(
            3,
            ClientCommand::CraftAssignSlot {
                slot_index: 0,
                container: container.clone(),
                stack_id: copper_stack_id.to_string(),
                variant_id: copper_variant,
            },
        ),
    );
    assert_eq!(copper_assigned.status, AuthorityCommandStatus::Accepted);

    let insufficient_frame = state.apply_envelope(
        &config,
        command(
            4,
            ClientCommand::CraftAssignSlot {
                slot_index: 1,
                container: container.clone(),
                stack_id: insufficient_iron_stack_id.to_string(),
                variant_id: iron_variant,
            },
        ),
    );
    assert_eq!(insufficient_frame.status, AuthorityCommandStatus::Rejected);
    assert_eq!(
        insufficient_frame.reason_code.as_deref(),
        Some(AuthorityRejectReason::CraftSlotMismatch.code())
    );

    let missing_slots = state.apply_envelope(&config, command(5, ClientCommand::CraftAssemble {}));
    assert_eq!(missing_slots.status, AuthorityCommandStatus::Rejected);
    assert_eq!(
        missing_slots.reason_code.as_deref(),
        Some(AuthorityRejectReason::CraftSlotUnfilled.code())
    );
    assert_eq!(
        state.actor_inventory_available_variant(&player, RESOURCE_COPPER_ITEM_ID, copper_variant,),
        18,
        "a rejected incomplete Lightning craft must not consume its accepted receiver stack"
    );
}

#[test]
fn authority_kiln_carbine_rejects_wrong_missing_and_insufficient_slot_inputs() {
    let config = SliceAuthorityConfig::default();
    let mut state = SliceAuthorityState::from_snapshot(&crate::authority_test_slice()).unwrap();
    let player = config.player_actor_id.clone();
    grant_test_profession(&mut state, &player, AuthorityProfessionKind::Craftsman);
    {
        let actor = state.actors.get_mut(&player).expect("player exists");
        for skill_box_id in [
            "craftsman-assembly-ii",
            "craftsman-assembly-iii",
            "craftsman-experimentation-i",
            "craftsman-experimentation-ii",
            "craftsman-experimentation-iii",
            "craftsman-experimentation-iv",
        ] {
            actor
                .professions
                .skill_boxes
                .insert(skill_box_id.to_owned());
        }
    }
    seed_test_tool(
        &mut state,
        &player,
        FIELD_MULTITOOL_ITEM_ID,
        "Field Multitool",
    );
    let container = format!("{player}:field-pack");
    let mineral_variant = 221_601;
    let chemical_variant = 222_601;
    let gas_variant = 224_601;
    let mineral_stack_id = push_test_inventory_stack(
        &mut state,
        &container,
        RESOURCE_MINERAL_ITEM_ID,
        mineral_variant,
        CRAFT_SLUGTHROWER_MINERAL_QTY,
    );
    let insufficient_chemical_stack_id = push_test_inventory_stack(
        &mut state,
        &container,
        RESOURCE_CHEMICAL_ITEM_ID,
        chemical_variant,
        CRAFT_SLUGTHROWER_CHEMICAL_QTY.saturating_sub(1),
    );
    let wrong_gas_stack_id =
        push_test_inventory_stack(&mut state, &container, RESOURCE_GAS_ITEM_ID, gas_variant, 6);

    let begin = state.apply_envelope(
        &config,
        command(
            1,
            ClientCommand::CraftBegin {
                recipe_id: "kiln_carbine".to_owned(),
            },
        ),
    );
    assert_eq!(begin.status, AuthorityCommandStatus::Accepted);

    let wrong_receiver = state.apply_envelope(
        &config,
        command(
            2,
            ClientCommand::CraftAssignSlot {
                slot_index: 0,
                container: container.clone(),
                stack_id: wrong_gas_stack_id.to_string(),
                variant_id: gas_variant,
            },
        ),
    );
    assert_eq!(wrong_receiver.status, AuthorityCommandStatus::Rejected);
    assert_eq!(
        wrong_receiver.reason_code.as_deref(),
        Some(AuthorityRejectReason::CraftSlotMismatch.code())
    );

    let mineral_assigned = state.apply_envelope(
        &config,
        command(
            3,
            ClientCommand::CraftAssignSlot {
                slot_index: 0,
                container: container.clone(),
                stack_id: mineral_stack_id.to_string(),
                variant_id: mineral_variant,
            },
        ),
    );
    assert_eq!(mineral_assigned.status, AuthorityCommandStatus::Accepted);

    let insufficient_frame = state.apply_envelope(
        &config,
        command(
            4,
            ClientCommand::CraftAssignSlot {
                slot_index: 1,
                container: container.clone(),
                stack_id: insufficient_chemical_stack_id.to_string(),
                variant_id: chemical_variant,
            },
        ),
    );
    assert_eq!(insufficient_frame.status, AuthorityCommandStatus::Rejected);
    assert_eq!(
        insufficient_frame.reason_code.as_deref(),
        Some(AuthorityRejectReason::CraftSlotMismatch.code())
    );

    let missing_slots = state.apply_envelope(&config, command(5, ClientCommand::CraftAssemble {}));
    assert_eq!(missing_slots.status, AuthorityCommandStatus::Rejected);
    assert_eq!(
        missing_slots.reason_code.as_deref(),
        Some(AuthorityRejectReason::CraftSlotUnfilled.code())
    );
    assert_eq!(
        state
            .actor_inventory_available_variant(&player, RESOURCE_MINERAL_ITEM_ID, mineral_variant,),
        CRAFT_SLUGTHROWER_MINERAL_QTY,
        "a rejected incomplete Kiln craft must not consume its accepted receiver stack"
    );
}

#[test]
fn authority_weapon_crafting_requires_the_recipe_assembly_skill_box() {
    for (recipe_id, granted_skill_box) in [
        ("kiln_carbine", "craftsman-assembly-ii"),
        ("lightning_carbine", "craftsman-assembly-iii"),
    ] {
        let config = SliceAuthorityConfig::default();
        let mut state = SliceAuthorityState::from_snapshot(&crate::authority_test_slice()).unwrap();
        let player = config.player_actor_id.clone();
        grant_test_profession(&mut state, &player, AuthorityProfessionKind::Craftsman);
        state
            .actors
            .get_mut(&player)
            .expect("player exists")
            .professions
            .skill_boxes
            .insert(granted_skill_box.to_owned());
        seed_test_tool(
            &mut state,
            &player,
            FIELD_MULTITOOL_ITEM_ID,
            "Field Multitool",
        );

        let begin = state.apply_envelope(
            &config,
            command(
                1,
                ClientCommand::CraftBegin {
                    recipe_id: recipe_id.to_owned(),
                },
            ),
        );
        assert_eq!(
            begin.status,
            AuthorityCommandStatus::Rejected,
            "{recipe_id} must stay locked with only {granted_skill_box}"
        );
        assert_eq!(
            begin.reason_code.as_deref(),
            Some(AuthorityRejectReason::UnknownSchematic.code())
        );
        assert!(state
            .actors
            .get(&player)
            .and_then(|actor| actor.craft_session.as_ref())
            .is_none());
    }
}

#[test]
fn authority_lightning_carbine_experimentation_maps_power_handling_and_reliability() {
    let config = SliceAuthorityConfig::default();
    let mut state = SliceAuthorityState::from_snapshot(&crate::authority_test_slice()).unwrap();
    let player = config.player_actor_id.clone();
    grant_test_profession(&mut state, &player, AuthorityProfessionKind::Craftsman);
    grant_craftsman_session_test_skills(&mut state, &player);
    {
        let actor = state.actors.get_mut(&player).expect("player exists");
        for skill_box_id in [
            "craftsman-assembly-ii",
            "craftsman-assembly-iii",
            "craftsman-assembly-iv",
        ] {
            actor
                .professions
                .skill_boxes
                .insert(skill_box_id.to_owned());
        }
    }
    seed_test_tool(
        &mut state,
        &player,
        FIELD_MULTITOOL_ITEM_ID,
        "Field Multitool",
    );
    let container = format!("{player}:field-pack");
    let resources = [
        (RESOURCE_COPPER_ITEM_ID, 227_001, 18),
        (RESOURCE_MINERAL_ITEM_ID, 221_002, 12),
        (
            RESOURCE_POLYMER_ITEM_ID,
            polymer_variant_from_source_variants(227_001, 228_001, 720),
            10,
        ),
        (RESOURCE_GAS_ITEM_ID, 224_004, 6),
    ];
    let assignments = resources
        .iter()
        .map(|(item_id, variant_id, quantity)| {
            let stack_id =
                push_test_inventory_stack(&mut state, &container, *item_id, *variant_id, *quantity);
            (stack_id, *variant_id)
        })
        .collect::<Vec<_>>();

    let begin = state.apply_envelope(
        &config,
        command(
            1,
            ClientCommand::CraftBegin {
                recipe_id: "lightning_carbine".to_owned(),
            },
        ),
    );
    assert_eq!(begin.status, AuthorityCommandStatus::Accepted);
    for (index, (stack_id, variant_id)) in assignments.into_iter().enumerate() {
        let assigned = state.apply_envelope(
            &config,
            command(
                2 + u64::try_from(index).unwrap_or(0),
                ClientCommand::CraftAssignSlot {
                    slot_index: u8::try_from(index).unwrap_or(u8::MAX),
                    container: container.clone(),
                    stack_id: stack_id.to_string(),
                    variant_id,
                },
            ),
        );
        assert_eq!(
            assigned.status,
            AuthorityCommandStatus::Accepted,
            "Lightning slot {index} rejected: {:?}",
            assigned.reason_code
        );
    }
    let assembled = state.apply_envelope(&config, command(6, ClientCommand::CraftAssemble {}));
    assert_eq!(assembled.status, AuthorityCommandStatus::Accepted);
    let initial_lines = state
        .actors
        .get(&player)
        .and_then(|actor| actor.craft_session.as_ref())
        .expect("assembled Lightning session")
        .lines
        .iter()
        .map(|line| line.value_milli)
        .collect::<Vec<_>>();
    assert_eq!(
        state
            .actors
            .get(&player)
            .and_then(|actor| actor
                .professions
                .xp
                .get(&AuthorityProfessionKind::Craftsman))
            .copied()
            .unwrap_or(0),
        CRAFT_XP_PER_TIER * 5
    );

    for line_id in 0_u8..=2 {
        let experimented = state.apply_envelope(
            &config,
            command(
                7 + u64::from(line_id),
                ClientCommand::CraftExperiment { line_id, points: 1 },
            ),
        );
        assert_eq!(
            experimented.status,
            AuthorityCommandStatus::Accepted,
            "Lightning line {line_id} rejected: {:?}",
            experimented.reason_code
        );
    }
    let experimented_lines = state
        .actors
        .get(&player)
        .and_then(|actor| actor.craft_session.as_ref())
        .expect("experimented Lightning session")
        .lines
        .iter()
        .map(|line| line.value_milli)
        .collect::<Vec<_>>();
    assert_eq!(experimented_lines.len(), 3);
    assert!(experimented_lines
        .iter()
        .zip(initial_lines.iter())
        .all(|(after, before)| after >= before));
    assert_eq!(
        state
            .actors
            .get(&player)
            .and_then(|actor| actor
                .professions
                .xp
                .get(&AuthorityProfessionKind::Craftsman))
            .copied()
            .unwrap_or(0),
        CRAFT_XP_PER_TIER * 5 + CRAFT_XP_PER_EXPERIMENT_POINT * 3
    );

    let finalized = state.apply_envelope(
        &config,
        command(
            10,
            ClientCommand::CraftFinalizePrototype {
                custom_name: String::new(),
            },
        ),
    );
    assert_eq!(finalized.status, AuthorityCommandStatus::Accepted);
    let output = state
        .inventory_snapshots()
        .into_iter()
        .find(|row| {
            row.item_id == LIGHTNING_CARBINE_ITEM_ID
                && actor_owns_inventory_container(&player, &row.container)
        })
        .expect("Lightning output added to inventory");
    let stats = decode_slugthrower_variant(output.variant_id).expect("Lightning variant decodes");
    assert_eq!(stats.power, experimented_lines[0] / 10);
    assert_eq!(stats.handling, experimented_lines[1] / 10);
    assert_eq!(stats.reliability, experimented_lines[2] / 10);
}

#[test]
fn authority_kiln_and_lightning_crafts_consume_resources_and_award_tier_xp() {
    let craft_and_assert =
        |recipe_id: &str, output_item_id: u32, resources: &[(u32, u32, u32)], tier: u64| {
            let config = SliceAuthorityConfig::default();
            let mut state =
                SliceAuthorityState::from_snapshot(&crate::authority_test_slice()).unwrap();
            let player = config.player_actor_id.clone();
            grant_test_profession(&mut state, &player, AuthorityProfessionKind::Craftsman);
            grant_craftsman_session_test_skills(&mut state, &player);
            {
                let actor = state.actors.get_mut(&player).expect("player exists");
                for skill_box_id in [
                    "craftsman-assembly-ii",
                    "craftsman-assembly-iii",
                    "craftsman-assembly-iv",
                ] {
                    actor
                        .professions
                        .skill_boxes
                        .insert(skill_box_id.to_owned());
                }
            }
            seed_test_tool(
                &mut state,
                &player,
                FIELD_MULTITOOL_ITEM_ID,
                "Field Multitool",
            );
            let container = format!("{player}:field-pack");
            let assignments = resources
                .iter()
                .map(|(item_id, variant_id, quantity)| {
                    let stack_id = push_test_inventory_stack(
                        &mut state,
                        &container,
                        *item_id,
                        *variant_id,
                        *quantity,
                    );
                    (stack_id, *variant_id)
                })
                .collect::<Vec<_>>();

            assert_eq!(
                state
                    .apply_envelope(
                        &config,
                        command(
                            1,
                            ClientCommand::CraftBegin {
                                recipe_id: recipe_id.to_owned(),
                            },
                        ),
                    )
                    .status,
                AuthorityCommandStatus::Accepted,
                "{recipe_id} begin"
            );
            for (index, (stack_id, variant_id)) in assignments.into_iter().enumerate() {
                assert_eq!(
                    state
                        .apply_envelope(
                            &config,
                            command(
                                2 + u64::try_from(index).unwrap_or(0),
                                ClientCommand::CraftAssignSlot {
                                    slot_index: u8::try_from(index).unwrap_or(u8::MAX),
                                    container: container.clone(),
                                    stack_id: stack_id.to_string(),
                                    variant_id,
                                },
                            ),
                        )
                        .status,
                    AuthorityCommandStatus::Accepted,
                    "{recipe_id} slot {index}"
                );
            }
            assert_eq!(
                state
                    .apply_envelope(&config, command(8, ClientCommand::CraftAssemble {}))
                    .status,
                AuthorityCommandStatus::Accepted,
                "{recipe_id} assemble"
            );
            assert_eq!(
                state
                    .actors
                    .get(&player)
                    .and_then(|actor| actor
                        .professions
                        .xp
                        .get(&AuthorityProfessionKind::Craftsman))
                    .copied()
                    .unwrap_or(0),
                CRAFT_XP_PER_TIER * tier,
                "{recipe_id} tier XP"
            );
            for (item_id, variant_id, _) in resources {
                assert_eq!(
                    state.actor_inventory_available_variant(&player, *item_id, *variant_id),
                    0,
                    "{recipe_id} consumes item {item_id} variant {variant_id}"
                );
            }
            assert_eq!(
                state
                    .apply_envelope(
                        &config,
                        command(
                            9,
                            ClientCommand::CraftFinalizePrototype {
                                custom_name: String::new()
                            }
                        ),
                    )
                    .status,
                AuthorityCommandStatus::Accepted,
                "{recipe_id} finalize"
            );
            assert_eq!(
                owned_actor_item_quantity(&state, &player, output_item_id),
                1,
                "{recipe_id} output quantity"
            );
        };

    craft_and_assert(
        "kiln_carbine",
        KILN_ENERGY_CELL_ITEM_ID,
        &[
            (
                RESOURCE_MINERAL_ITEM_ID,
                221_003,
                CRAFT_SLUGTHROWER_MINERAL_QTY,
            ),
            (
                RESOURCE_CHEMICAL_ITEM_ID,
                222_777,
                CRAFT_SLUGTHROWER_CHEMICAL_QTY,
            ),
            (
                RESOURCE_POLYMER_ITEM_ID,
                polymer_variant_from_source_variants(222_777, 228_003, 720),
                CRAFT_SLUGTHROWER_POLYMER_QTY,
            ),
        ],
        4,
    );
    craft_and_assert(
        "lightning_carbine",
        LIGHTNING_CARBINE_ITEM_ID,
        &[
            (RESOURCE_COPPER_ITEM_ID, 227_001, 18),
            (RESOURCE_MINERAL_ITEM_ID, 221_002, 12),
            (
                RESOURCE_POLYMER_ITEM_ID,
                polymer_variant_from_source_variants(227_001, 228_001, 720),
                10,
            ),
            (RESOURCE_GAS_ITEM_ID, 224_004, 6),
        ],
        5,
    );
}

#[test]
fn authority_irrigation_sprinkler_rejects_wrong_missing_and_insufficient_slot_inputs() {
    let config = SliceAuthorityConfig::default();
    let snapshot = crate::authority_test_slice();
    let mut state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    let player = config.player_actor_id.clone();
    grant_test_profession(&mut state, &player, AuthorityProfessionKind::Craftsman);
    seed_test_tool(
        &mut state,
        &player,
        FIELD_MULTITOOL_ITEM_ID,
        "Field Multitool",
    );
    let container = format!("{player}:field-pack");
    let copper_variant = 221_001;
    let copper_stack_id = push_test_inventory_stack(
        &mut state,
        &container,
        RESOURCE_COPPER_ITEM_ID,
        copper_variant,
        24,
    );
    let polymer_variant = polymer_variant_from_source_variants(222_777, 266_666, 720);
    let insufficient_polymer_stack_id = push_test_inventory_stack(
        &mut state,
        &container,
        RESOURCE_POLYMER_ITEM_ID,
        polymer_variant,
        11,
    );
    let wrong_stack_id = push_test_inventory_stack(
        &mut state,
        &container,
        RESOURCE_MINERAL_ITEM_ID,
        211_001,
        24,
    );

    let begin = state.apply_envelope(
        &config,
        command(
            1,
            ClientCommand::CraftBegin {
                recipe_id: "irrigation_sprinkler".to_owned(),
            },
        ),
    );
    assert_eq!(begin.status, AuthorityCommandStatus::Accepted);

    for (command_id, slot_index, stack_id, variant_id) in [
        (2, 0_u8, wrong_stack_id, 211_001),
        (4, 1_u8, wrong_stack_id, 211_001),
        (5, 1_u8, insufficient_polymer_stack_id, polymer_variant),
    ] {
        let rejected = state.apply_envelope(
            &config,
            command(
                command_id,
                ClientCommand::CraftAssignSlot {
                    slot_index,
                    container: container.clone(),
                    stack_id: stack_id.to_string(),
                    variant_id,
                },
            ),
        );
        assert_eq!(rejected.status, AuthorityCommandStatus::Rejected);
        assert_eq!(
            rejected.reason_code.as_deref(),
            Some(AuthorityRejectReason::CraftSlotMismatch.code()),
            "slot {slot_index} must reject a resource that does not meet its exact item and quantity contract"
        );
    }
    assert_eq!(
        state.actor_inventory_available_variant(&player, RESOURCE_COPPER_ITEM_ID, copper_variant),
        24
    );
    assert_eq!(
        state.actor_inventory_available_variant(&player, RESOURCE_POLYMER_ITEM_ID, polymer_variant),
        11
    );
    assert_eq!(
        state.actor_inventory_available_variant(&player, RESOURCE_MINERAL_ITEM_ID, 211_001),
        24
    );

    let copper_assigned = state.apply_envelope(
        &config,
        command(
            3,
            ClientCommand::CraftAssignSlot {
                slot_index: 0,
                container: container.clone(),
                stack_id: copper_stack_id.to_string(),
                variant_id: copper_variant,
            },
        ),
    );
    assert_eq!(copper_assigned.status, AuthorityCommandStatus::Accepted);
    let assignment = state
        .actors
        .get(&player)
        .and_then(|actor| actor.craft_session.as_ref())
        .and_then(|session| session.slots[0].as_ref())
        .expect("accepted copper assignment is retained in the authority session");
    assert_eq!(assignment.variant_id, copper_variant);
    assert_eq!(assignment.quantity, 24);

    let missing_slot = state.apply_envelope(&config, command(6, ClientCommand::CraftAssemble {}));
    assert_eq!(missing_slot.status, AuthorityCommandStatus::Rejected);
    assert_eq!(
        missing_slot.reason_code.as_deref(),
        Some(AuthorityRejectReason::CraftSlotUnfilled.code())
    );
    assert_eq!(
        state.actor_inventory_available_variant(&player, RESOURCE_COPPER_ITEM_ID, copper_variant),
        24,
        "an incomplete craft must not consume an already-assigned source stack"
    );
}

#[test]
fn authority_irrigation_sprinkler_crafting_consumes_exact_resources_and_splits_at_structure_cap() {
    let config = SliceAuthorityConfig::default();
    let snapshot = crate::authority_test_slice();
    let mut state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    let player = config.player_actor_id.clone();
    grant_test_profession(&mut state, &player, AuthorityProfessionKind::Craftsman);
    seed_test_tool(
        &mut state,
        &player,
        FIELD_MULTITOOL_ITEM_ID,
        "Field Multitool",
    );
    let container = format!("{player}:field-pack");
    let craft_count = FARM_STRUCTURE_STACK_CAP + 1;
    let copper_variant = 221_001;
    let polymer_variant = polymer_variant_from_source_variants(222_777, 266_666, 720);
    let copper_stack_id = push_test_inventory_stack(
        &mut state,
        &container,
        RESOURCE_COPPER_ITEM_ID,
        copper_variant,
        24 * craft_count,
    );
    let polymer_stack_id = push_test_inventory_stack(
        &mut state,
        &container,
        RESOURCE_POLYMER_ITEM_ID,
        polymer_variant,
        12 * craft_count,
    );

    for craft_index in 0..craft_count {
        let command_id = 1 + u64::from(craft_index) * 5;
        let begin = state.apply_envelope(
            &config,
            command(
                command_id,
                ClientCommand::CraftBegin {
                    recipe_id: "irrigation_sprinkler".to_owned(),
                },
            ),
        );
        assert_eq!(begin.status, AuthorityCommandStatus::Accepted);
        for (offset, slot_index, stack_id, variant_id) in [
            (1, 0_u8, copper_stack_id, copper_variant),
            (2, 1_u8, polymer_stack_id, polymer_variant),
        ] {
            let assigned = state.apply_envelope(
                &config,
                command(
                    command_id + offset,
                    ClientCommand::CraftAssignSlot {
                        slot_index,
                        container: container.clone(),
                        stack_id: stack_id.to_string(),
                        variant_id,
                    },
                ),
            );
            assert_eq!(assigned.status, AuthorityCommandStatus::Accepted);
        }
        // Keep the deterministic authority clock fixed at assembly so every real craft
        // produces the same quality variant and exercises that variant's stack cap.
        state.tick = 99;
        let assembled = state.apply_envelope(
            &config,
            command(command_id + 3, ClientCommand::CraftAssemble {}),
        );
        assert_eq!(assembled.status, AuthorityCommandStatus::Accepted);
        assert_eq!(
            state.actor_inventory_available_variant(
                &player,
                RESOURCE_COPPER_ITEM_ID,
                copper_variant
            ),
            24 * (craft_count - craft_index - 1),
            "each assembled sprinkler consumes exactly 24 Copper"
        );
        assert_eq!(
            state.actor_inventory_available_variant(
                &player,
                RESOURCE_POLYMER_ITEM_ID,
                polymer_variant
            ),
            12 * (craft_count - craft_index - 1),
            "each assembled sprinkler consumes exactly 12 Polymer"
        );
        let finalized = state.apply_envelope(
            &config,
            command(
                command_id + 4,
                ClientCommand::CraftFinalizePrototype {
                    custom_name: String::new(),
                },
            ),
        );
        assert_eq!(finalized.status, AuthorityCommandStatus::Accepted);
        assert_eq!(
            state
                .inventory_snapshots()
                .iter()
                .filter(|row| {
                    row.item_id == 6_301 && actor_owns_inventory_container(&player, &row.container)
                })
                .map(|row| row.available)
                .sum::<u32>(),
            craft_index + 1,
            "each finalized irrigation sprinkler adds exactly one catalog item 6301"
        );
    }

    let mut sprinkler_stacks = state
        .inventory_snapshots()
        .into_iter()
        .filter(|row| {
            row.item_id == 6_301 && actor_owns_inventory_container(&player, &row.container)
        })
        .collect::<Vec<_>>();
    sprinkler_stacks.sort_by_key(|row| row.quantity);
    assert_eq!(
        sprinkler_stacks
            .iter()
            .map(|row| row.quantity)
            .collect::<Vec<_>>(),
        vec![1, FARM_STRUCTURE_STACK_CAP],
        "organic crafting must split the eleventh sprinkler instead of exceeding the structure stack cap"
    );
    assert!(sprinkler_stacks
        .iter()
        .all(|row| row.variant_id == sprinkler_stacks[0].variant_id));
}

#[test]
fn authority_crafted_irrigation_sprinkler_places_and_removes_through_farm_commands() {
    let config = SliceAuthorityConfig::default();
    let snapshot = crate::authority_test_slice();
    let mut state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    if let Some(area) = state.areas.get_mut(crate::AUTHORITY_TEST_AREA_ID) {
        area.width = 1_025;
        area.height = 1_025;
    }
    state.blocked_cells.clear();
    state.clone_facilities.clear();
    state.transitions.clear();
    let player = config.player_actor_id.clone();
    state
        .actors
        .get_mut(&player)
        .expect("player exists")
        .professions
        .credits = 100_000;
    grant_test_profession(&mut state, &player, AuthorityProfessionKind::Craftsman);
    seed_test_tool(
        &mut state,
        &player,
        FIELD_MULTITOOL_ITEM_ID,
        "Field Multitool",
    );
    let container = format!("{player}:field-pack");
    let copper_variant = 221_001;
    let polymer_variant = polymer_variant_from_source_variants(222_777, 266_666, 720);
    let copper_stack_id = push_test_inventory_stack(
        &mut state,
        &container,
        RESOURCE_COPPER_ITEM_ID,
        copper_variant,
        24,
    );
    let polymer_stack_id = push_test_inventory_stack(
        &mut state,
        &container,
        RESOURCE_POLYMER_ITEM_ID,
        polymer_variant,
        12,
    );

    let begin = state.apply_envelope(
        &config,
        command(
            1,
            ClientCommand::CraftBegin {
                recipe_id: "irrigation_sprinkler".to_owned(),
            },
        ),
    );
    assert_eq!(begin.status, AuthorityCommandStatus::Accepted);
    for (command_id, slot_index, stack_id, variant_id) in [
        (2, 0_u8, copper_stack_id, copper_variant),
        (3, 1_u8, polymer_stack_id, polymer_variant),
    ] {
        let assigned = state.apply_envelope(
            &config,
            command(
                command_id,
                ClientCommand::CraftAssignSlot {
                    slot_index,
                    container: container.clone(),
                    stack_id: stack_id.to_string(),
                    variant_id,
                },
            ),
        );
        assert_eq!(assigned.status, AuthorityCommandStatus::Accepted);
    }
    let assemble = state.apply_envelope(&config, command(4, ClientCommand::CraftAssemble {}));
    assert_eq!(assemble.status, AuthorityCommandStatus::Accepted);
    let finalize = state.apply_envelope(
        &config,
        command(
            5,
            ClientCommand::CraftFinalizePrototype {
                custom_name: String::new(),
            },
        ),
    );
    assert_eq!(finalize.status, AuthorityCommandStatus::Accepted);
    assert_eq!(
        state.actor_inventory_available_quantity(&player, IRRIGATION_SPRINKLER_ITEM_ID),
        1,
        "farm placement starts from the sprinkler produced by CraftFinalizePrototype"
    );

    let claim = state.apply_envelope(
        &config,
        command(
            6,
            ClientCommand::ClaimParcel {
                planet_id: "planet-a".to_owned(),
                area_id: crate::AUTHORITY_TEST_AREA_ID.to_owned(),
                x: 40,
                y: 40,
                tier: "homestead".to_owned(),
            },
        ),
    );
    assert_eq!(claim.status, AuthorityCommandStatus::Accepted);
    let parcel_id = state
        .parcels
        .keys()
        .next()
        .expect("claim creates a parcel")
        .clone();
    let cell = {
        let yard = state.parcels[&parcel_id].farm_yard;
        AuthorityCell::new(yard.x + 1, yard.y + 1)
    };
    let placed = state.apply_envelope(
        &config,
        command(
            7,
            ClientCommand::PlaceFarmStructure {
                parcel_id: parcel_id.clone(),
                structure_item_id: IRRIGATION_SPRINKLER_ITEM_ID,
                cell_x: cell.x,
                cell_y: cell.y,
            },
        ),
    );
    assert_eq!(placed.status, AuthorityCommandStatus::Accepted);
    assert_eq!(
        state.actor_inventory_available_quantity(&player, IRRIGATION_SPRINKLER_ITEM_ID),
        0,
        "placing consumes the organically crafted sprinkler"
    );
    let structure_id = state.parcels[&parcel_id]
        .structures
        .keys()
        .next()
        .expect("placement persists a farm structure")
        .clone();

    let removed = state.apply_envelope(
        &config,
        command(
            8,
            ClientCommand::RemoveFarmStructure {
                parcel_id: parcel_id.clone(),
                structure_id,
            },
        ),
    );
    assert_eq!(removed.status, AuthorityCommandStatus::Accepted);
    assert!(state.parcels[&parcel_id].structures.is_empty());
    let returned = state
        .inventory_snapshots()
        .into_iter()
        .filter(|row| {
            row.item_id == IRRIGATION_SPRINKLER_ITEM_ID
                && row.available > 0
                && actor_owns_inventory_container(&player, &row.container)
        })
        .collect::<Vec<_>>();
    assert_eq!(returned.len(), 1);
    assert_eq!(returned[0].available, 1);
    assert_eq!(returned[0].variant_id, 0);
    assert_eq!(returned[0].quantity, 1);
    assert_eq!(returned[0].container, format!("{player}:field-pack"));
}

#[test]
fn authority_craft_cancel_without_session_publishes_browse_without_starting_session() {
    let config = SliceAuthorityConfig::default();
    let snapshot = crate::authority_test_slice();
    let mut state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();

    let cancel = state.apply_envelope(&config, command(1, ClientCommand::CraftCancel {}));

    assert_eq!(
        cancel.status,
        AuthorityCommandStatus::Accepted,
        "CraftCancel rejected: {:?}",
        cancel.reason_code
    );
    let browse = cancel.craft_session.expect("browse VM published");
    assert_eq!(browse.phase, "browse");
    assert!(browse.recipe_id.is_none());
    assert!(!browse.recipes.is_empty());
    assert!(state
        .actors
        .get(&config.player_actor_id)
        .and_then(|actor| actor.craft_session.as_ref())
        .is_none());
}

#[test]
fn authority_craft_slot_eligible_resources_sort_by_relevant_stat_desc() {
    let config = SliceAuthorityConfig::default();
    let snapshot = crate::authority_test_slice();
    let mut state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    let player = config.player_actor_id.clone();
    grant_test_profession(&mut state, &player, AuthorityProfessionKind::Craftsman);
    grant_craftsman_session_test_skills(&mut state, &player);
    seed_test_tool(
        &mut state,
        &player,
        FIELD_MULTITOOL_ITEM_ID,
        "Field Multitool",
    );
    let mut copper_variants = (221_000..221_080)
        .map(|variant_id| {
            let stats = resource_stats_for_item_variant(RESOURCE_COPPER_ITEM_ID, variant_id)
                .expect("copper stats");
            (variant_id, resource_stat_value(stats, "conductivity"))
        })
        .collect::<Vec<_>>();
    copper_variants.sort_by_key(|(_, conductivity)| *conductivity);
    let (low_variant, low_conductivity) = copper_variants[0];
    let (high_variant, high_conductivity) = *copper_variants
        .iter()
        .rev()
        .find(|(_, conductivity)| *conductivity > low_conductivity)
        .expect("distinct copper conductivity in deterministic test window");
    assert!(high_conductivity > low_conductivity);

    let container = format!("{player}:field-pack");
    push_test_inventory_stack(
        &mut state,
        &container,
        RESOURCE_COPPER_ITEM_ID,
        low_variant,
        CRAFT_EXTRACTOR_BATTERY_COPPER_QTY,
    );
    push_test_inventory_stack(
        &mut state,
        &container,
        RESOURCE_COPPER_ITEM_ID,
        high_variant,
        CRAFT_EXTRACTOR_BATTERY_COPPER_QTY,
    );

    let begin = state.apply_envelope(
        &config,
        command(
            1,
            ClientCommand::CraftBegin {
                recipe_id: "extractor_battery".to_owned(),
            },
        ),
    );

    assert_eq!(
        begin.status,
        AuthorityCommandStatus::Accepted,
        "CraftBegin rejected: {:?}",
        begin.reason_code
    );
    let slot_screen = begin
        .craft_session
        .as_ref()
        .and_then(|session| session.slot_screen.as_ref())
        .expect("slot screen published");
    let conductor_slot = &slot_screen.slots[0];
    assert_eq!(conductor_slot.symbol, "conductor");
    assert_eq!(conductor_slot.eligible[0].variant_id, high_variant);
    assert!(conductor_slot.eligible[0].recommended);
    assert!(conductor_slot
        .eligible
        .windows(2)
        .all(|pair| { pair[0].craft_relevant_stat_value >= pair[1].craft_relevant_stat_value }));
}

#[test]
fn authority_crafting_tool_quality_improves_assembly_and_experimentation() {
    let assemble_with_tool_quality = |tool_quality: u32| -> (u16, u16) {
        let config = SliceAuthorityConfig::default();
        let snapshot = crate::authority_test_slice();
        let mut state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
        let player = config.player_actor_id.clone();
        grant_test_profession(&mut state, &player, AuthorityProfessionKind::Craftsman);
        grant_craftsman_session_test_skills(&mut state, &player);
        state.add_actor_inventory_stack(
            &player,
            FIELD_MULTITOOL_ITEM_ID,
            tool_quality,
            "Field Multitool",
            1,
            1,
            "profession-tools",
        );
        let (copper, iron, fuel) =
            seed_test_battery_resources(&mut state, &player, 221_777, 211_777);
        assert_eq!(
            state
                .apply_envelope(
                    &config,
                    command(
                        1,
                        ClientCommand::CraftBegin {
                            recipe_id: "extractor_battery".to_owned(),
                        },
                    ),
                )
                .status,
            AuthorityCommandStatus::Accepted
        );
        for (command_id, slot_index, assignment) in
            [(2, 0_u8, copper), (3, 1_u8, iron), (4, 2_u8, fuel)]
        {
            assert_eq!(
                state
                    .apply_envelope(
                        &config,
                        command(
                            command_id,
                            ClientCommand::CraftAssignSlot {
                                slot_index,
                                container: assignment.0,
                                stack_id: assignment.1,
                                variant_id: assignment.2,
                            },
                        ),
                    )
                    .status,
                AuthorityCommandStatus::Accepted
            );
        }
        assert_eq!(
            state
                .apply_envelope(&config, command(5, ClientCommand::CraftAssemble {}))
                .status,
            AuthorityCommandStatus::Accepted
        );
        let assembly_quality = state
            .actors
            .get(&player)
            .and_then(|actor| actor.craft_session.as_ref())
            .map(|session| session.assembly_quality_milli)
            .expect("assembled quality");
        assert_eq!(
            state
                .apply_envelope(
                    &config,
                    command(
                        6,
                        ClientCommand::CraftExperiment {
                            line_id: 0,
                            points: 1
                        }
                    ),
                )
                .status,
            AuthorityCommandStatus::Accepted
        );
        let experimented_value = state
            .actors
            .get(&player)
            .and_then(|actor| actor.craft_session.as_ref())
            .and_then(|session| session.lines.first())
            .map(|line| line.value_milli)
            .expect("experimented line value");
        (assembly_quality, experimented_value)
    };

    let starter = assemble_with_tool_quality(STARTER_FIELD_MULTITOOL_QUALITY_MILLI);
    let masterwork = assemble_with_tool_quality(1_000);
    assert!(
        masterwork.0 > starter.0,
        "higher-quality tool should improve assembly roll"
    );
    assert!(
        masterwork.1 >= starter.1,
        "higher-quality tool should not reduce experimentation result"
    );
}

#[test]
fn authority_crafts_experimented_slugthrower_from_sampled_resources() {
    let config = SliceAuthorityConfig::default();
    let mut snapshot = crate::authority_test_slice();
    expand_resource_test_area(&mut snapshot, "authority-test-overworld");
    let mut state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    grant_test_profession(
        &mut state,
        &config.player_actor_id,
        AuthorityProfessionKind::Craftsman,
    );
    {
        let craftsman = state
            .actors
            .get_mut(&config.player_actor_id)
            .expect("test player exists");
        for skill_box_id in [
            "craftsman-assembly-i",
            "craftsman-assembly-ii",
            "craftsman-assembly-iii",
            "craftsman-assembly-iv",
            "craftsman-experimentation-i",
            "craftsman-experimentation-ii",
            "craftsman-experimentation-iii",
            "craftsman-experimentation-iv",
            "craftsman-master",
        ] {
            craftsman
                .professions
                .skill_boxes
                .insert(skill_box_id.to_owned());
        }
        assert_eq!(craftsman.professions.craftsman_experimentation_points(), 15);
        assert!(craftsman.professions.craftsman_assembly_bonus() > 0);
    }
    seed_test_tool(
        &mut state,
        &config.player_actor_id,
        FIELD_MULTITOOL_ITEM_ID,
        "Field Multitool",
    );
    seed_test_survey_tool(&mut state, &config.player_actor_id);
    let (mineral_resource, rich_cell, concentration_milli) =
        rich_resource_cell_for_test(&state, "authority-test-overworld", "mineral");
    move_actor_to_cell_for_test(&mut state, &config.player_actor_id, rich_cell);
    let sample_yield = resource_sample_yield(
        mineral_resource.stats.extraction_yield,
        concentration_milli,
        state.actor_crafting_tool_quality_milli(&config.player_actor_id),
    );
    assert!(sample_yield > 0, "rich mineral cell should produce samples");
    let samples_needed = CRAFT_SLUGTHROWER_MINERAL_QTY.div_ceil(sample_yield);
    let mut command_id = 1;
    for _ in 0..samples_needed {
        let frame = state.apply_envelope(
            &config,
            command(
                command_id,
                ClientCommand::SampleResource {
                    family: "mineral".to_owned(),
                    stop: false,
                },
            ),
        );
        assert_eq!(
            frame.status,
            AuthorityCommandStatus::Accepted,
            "sample rejected: {:?}",
            frame.reason_code
        );
        let resolve_tick = state
            .actors
            .get(&config.player_actor_id)
            .and_then(|actor| actor.pending_resource_sample.as_ref())
            .map(|sample| sample.resolve_tick)
            .expect("sample should be pending");
        let ticks_to_resolve = resolve_tick.saturating_sub(state.tick());
        advance_ticks_unclamped(&mut state, &config, ticks_to_resolve);
        state.stop_actor_resource_sample_loop(&config.player_actor_id);
        state.clear_actor_economy_action_cooldown(&config.player_actor_id);
        command_id += 1;
    }
    let mineral = state
        .inventory_snapshots()
        .into_iter()
        .find(|row| {
            row.item_id == RESOURCE_MINERAL_ITEM_ID
                && row.available >= CRAFT_SLUGTHROWER_MINERAL_QTY
                && actor_owns_inventory_container(&config.player_actor_id, &row.container)
        })
        .expect("sampled mineral stack for Slugthrower barrel");
    let resource_container = format!("{}:resource-crate", config.player_actor_id);
    let chemical_stack_id = push_test_inventory_stack(
        &mut state,
        &resource_container,
        RESOURCE_CHEMICAL_ITEM_ID,
        222_777,
        CRAFT_SLUGTHROWER_CHEMICAL_QTY,
    );
    let polymer_variant_id = polymer_variant_from_source_variants(222_777, 266_666, 720);
    let polymer_stack_id = push_test_inventory_stack(
        &mut state,
        &resource_container,
        RESOURCE_POLYMER_ITEM_ID,
        polymer_variant_id,
        CRAFT_SLUGTHROWER_POLYMER_QTY,
    );

    let begin = state.apply_envelope(
        &config,
        command(
            command_id,
            ClientCommand::CraftBegin {
                recipe_id: "slugthrower".to_owned(),
            },
        ),
    );
    command_id += 1;
    assert_eq!(
        begin.status,
        AuthorityCommandStatus::Accepted,
        "CraftBegin rejected: {:?}",
        begin.reason_code
    );
    for (slot_index, container, stack_id, variant_id) in [
        (
            0_u8,
            mineral.container.clone(),
            mineral.stack_id.to_string(),
            mineral.variant_id,
        ),
        (
            1_u8,
            resource_container.clone(),
            chemical_stack_id.to_string(),
            222_777,
        ),
        (
            2_u8,
            resource_container.clone(),
            polymer_stack_id.to_string(),
            polymer_variant_id,
        ),
    ] {
        let assigned = state.apply_envelope(
            &config,
            command(
                command_id,
                ClientCommand::CraftAssignSlot {
                    slot_index,
                    container,
                    stack_id,
                    variant_id,
                },
            ),
        );
        command_id += 1;
        assert_eq!(
            assigned.status,
            AuthorityCommandStatus::Accepted,
            "CraftAssignSlot {slot_index} rejected: {:?}",
            assigned.reason_code
        );
    }
    let assemble = state.apply_envelope(
        &config,
        command(command_id, ClientCommand::CraftAssemble {}),
    );
    command_id += 1;
    assert_eq!(
        assemble.status,
        AuthorityCommandStatus::Accepted,
        "CraftAssemble rejected: {:?}",
        assemble.reason_code
    );
    let invalid = state.apply_envelope(
        &config,
        command(
            command_id,
            ClientCommand::CraftExperiment {
                line_id: 0,
                points: 16,
            },
        ),
    );
    command_id += 1;
    assert_eq!(invalid.status, AuthorityCommandStatus::Rejected);
    assert_eq!(
        invalid.reason_code.as_deref(),
        Some("invalid_experimentation")
    );
    for (line_id, points) in [(0_u8, 7_u8), (1_u8, 5_u8), (2_u8, 3_u8)] {
        let experiment = state.apply_envelope(
            &config,
            command(
                command_id,
                ClientCommand::CraftExperiment { line_id, points },
            ),
        );
        command_id += 1;
        assert_eq!(
            experiment.status,
            AuthorityCommandStatus::Accepted,
            "CraftExperiment line {line_id} rejected: {:?}",
            experiment.reason_code
        );
    }
    let craft = state.apply_envelope(
        &config,
        command(
            command_id,
            ClientCommand::CraftFinalizePrototype {
                custom_name: String::new(),
            },
        ),
    );
    assert_eq!(
        craft.status,
        AuthorityCommandStatus::Accepted,
        "CraftFinalizePrototype rejected: {:?}",
        craft.reason_code
    );
    let crafted = state
        .inventory_snapshots()
        .into_iter()
        .find(|row| row.item_id == CRAFTED_SLUGTHROWER_ITEM_ID)
        .unwrap();
    let stats = decode_slugthrower_variant(crafted.variant_id).unwrap();
    assert!(stats.power > 0);
    assert!(stats.handling > 0);
    assert!(stats.reliability > 0);
    assert!(state
        .inventory_snapshots()
        .iter()
        .any(|row| row.item_id == FIELD_MULTITOOL_ITEM_ID && row.available == 1));
    assert!(state
        .timeline_event_snapshots()
        .iter()
        .any(|event| event.label.contains("finalized Crafted Slugthrower Mk I")));
}

#[test]
fn authority_skirmisher_outnumbered_distant_wave_advances_to_contact() {
    let config = SliceAuthorityConfig::default();
    let mut snapshot = crate::authority_test_slice();
    add_test_factions(&mut snapshot);
    snapshot.actors.clear();
    snapshot.npc_jobs.clear();
    snapshot.props.clear();
    snapshot.blocked_cells.clear();

    let red_id = "red-outnumbered-wave";
    let mut red = test_actor(
        red_id,
        "Red Outnumbered Wave",
        "skirmisher",
        CellSnapshot::new(62, 20),
        "left",
    );
    red.faction_id = Some("red_crew".to_owned());
    red.social_group = Some("red_squad".to_owned());
    red.pvp_status = Some("overt".to_owned());
    snapshot.actors.push(red);
    for (id, cell) in [
        ("blue-pressure-1", CellSnapshot::new(2, 20)),
        ("blue-pressure-2", CellSnapshot::new(4, 22)),
        ("blue-pressure-3", CellSnapshot::new(6, 18)),
    ] {
        snapshot
            .actors
            .push(test_actor(id, id, "skirmisher", cell, "left"));
    }

    let mut state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    for id in ["blue-pressure-1", "blue-pressure-2", "blue-pressure-3"] {
        state.actors.get_mut(id).unwrap().ai = None;
    }

    let red = state.actors.get(red_id).unwrap().clone();
    let target = state.actors.get("blue-pressure-1").unwrap().clone();
    let start_gap = position_distance_milli(red.position, target.position);
    let (_, roll_max_range_milli) = state
        .roll_range_bands_milli_for_actor(&red)
        .expect("test skirmisher should carry a Roll-ranged weapon");
    assert!(start_gap > roll_max_range_milli);
    assert!(start_gap <= SKIRMISHER_ACQUIRE_RADIUS_MILLI_CELLS);

    let mut closest_gap = start_gap;
    let mut closing_steps = 0_u32;
    let mut away_steps = 0_u32;
    let mut previous_position = red.position;
    let mut saw_roll_approach = false;
    let mut last_debug_reason = None;
    let mut last_debug_target = None;
    let mut last_debug_candidates = Vec::new();
    for _ in 0..180 {
        state.advance_ticks_for_observer(&config, 1);
        let red = state.actors.get(red_id).unwrap();
        let previous_gap = position_distance_milli(previous_position, target.position);
        let current_gap = position_distance_milli(red.position, target.position);
        if position_distance_milli(previous_position, red.position) > 1 {
            if current_gap < previous_gap {
                closing_steps = closing_steps.saturating_add(1);
            } else if current_gap > previous_gap.saturating_add(100) {
                away_steps = away_steps.saturating_add(1);
            }
        }
        previous_position = red.position;
        closest_gap = closest_gap.min(current_gap);
        if let Some(row) = state
            .ai_debug_snapshot()
            .actors
            .iter()
            .find(|row| row.actor_id == red_id)
        {
            last_debug_reason = Some(row.reason.clone());
            last_debug_target = row.move_target.clone();
            last_debug_candidates = row
                .candidates
                .iter()
                .map(|candidate| {
                    (
                        candidate.stage.clone(),
                        candidate.kind.clone(),
                        candidate.accepted,
                        candidate.rejection.clone(),
                    )
                })
                .collect();
            saw_roll_approach |= row.reason == "roll_ideal_approach";
        }
    }

    assert!(
        closest_gap <= start_gap.saturating_sub(2_000),
        "outnumbered but unpressured skirmisher should still close contact ({start_gap} -> {closest_gap}); reason={last_debug_reason:?} target={last_debug_target:?} candidates={last_debug_candidates:?}"
    );
    assert!(
        closing_steps >= 5 && away_steps <= 2,
        "distant unpressured skirmisher should not jitter away from contact; closing_steps={closing_steps} away_steps={away_steps} reason={last_debug_reason:?}"
    );
    assert!(
        saw_roll_approach,
        "outnumbered long-range skirmisher should expose the current Roll approach reason"
    );
}

#[test]
fn authority_skirmisher_far_spawn_wave_acquires_contact_beyond_local_radius() {
    let config = SliceAuthorityConfig::default();
    let mut snapshot = crate::authority_test_slice();
    add_test_factions(&mut snapshot);
    snapshot.actors.clear();
    snapshot.npc_jobs.clear();
    snapshot.props.clear();
    snapshot.blocked_cells.clear();
    snapshot.zone.width = 170;
    for area in &mut snapshot.areas {
        if area.id == crate::AUTHORITY_TEST_AREA_ID {
            area.width = 170;
        }
    }

    let red_id = "red-far-spawn-wave";
    let mut red = test_actor(
        red_id,
        "Red Far Spawn Wave",
        "skirmisher",
        CellSnapshot::new(154, 56),
        "left",
    );
    red.faction_id = Some("red_crew".to_owned());
    red.social_group = Some("red_squad".to_owned());
    red.pvp_status = Some("overt".to_owned());
    snapshot.actors.push(red);
    for (id, cell) in [
        ("blue-far-contact-1", CellSnapshot::new(24, 54)),
        ("blue-far-contact-2", CellSnapshot::new(27, 58)),
        ("blue-far-contact-3", CellSnapshot::new(30, 52)),
    ] {
        snapshot
            .actors
            .push(test_actor(id, id, "skirmisher", cell, "left"));
    }

    let mut state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    for id in [
        "blue-far-contact-1",
        "blue-far-contact-2",
        "blue-far-contact-3",
    ] {
        state.actors.get_mut(id).unwrap().ai = None;
    }

    let red = state.actors.get(red_id).unwrap().clone();
    let profile = skirmisher_profile_for_ai_state(&red);
    assert!(
        state.nearest_skirmisher_target(&red, profile).is_none(),
        "test premise: target must start beyond local skirmisher acquire radius"
    );
    let target = state
        .nearest_attackable_actor_unbounded(&red)
        .expect("far wave should still have an attackable enemy in the same area");
    let start_gap = position_distance_milli(red.position, target.position);
    assert!(
        start_gap > SKIRMISHER_ACQUIRE_RADIUS_MILLI_CELLS,
        "test premise: far contact starts beyond local acquisition ({start_gap})"
    );

    let mut closest_gap = start_gap;
    let mut closing_steps = 0_u32;
    let mut saw_roll_approach = false;
    let mut saw_no_hostile_after_warmup = false;
    let mut previous_position = red.position;
    let mut last_debug_reason = None;
    let mut last_debug_target = None;
    for tick_index in 0..240 {
        state.advance_ticks_for_observer(&config, 1);
        let red = state.actors.get(red_id).unwrap();
        let previous_gap = position_distance_milli(previous_position, target.position);
        let current_gap = position_distance_milli(red.position, target.position);
        if position_distance_milli(previous_position, red.position) > 1
            && current_gap < previous_gap
        {
            closing_steps = closing_steps.saturating_add(1);
        }
        previous_position = red.position;
        closest_gap = closest_gap.min(current_gap);
        if let Some(row) = state
            .ai_debug_snapshot()
            .actors
            .iter()
            .find(|row| row.actor_id == red_id)
        {
            last_debug_reason = Some(row.reason.clone());
            last_debug_target = row.move_target.clone();
            saw_roll_approach |= row.reason == "roll_ideal_approach";
            if tick_index > 30 && row.reason == "no_hostile_target" {
                saw_no_hostile_after_warmup = true;
            }
        }
    }

    assert!(
        saw_roll_approach,
        "far spawned wave should use the current Roll approach instead of idling; reason={last_debug_reason:?} target={last_debug_target:?}"
    );
    assert!(
        closest_gap <= start_gap.saturating_sub(2_000) && closing_steps >= 5,
        "far spawned wave should close distance ({start_gap} -> {closest_gap}); closing_steps={closing_steps} reason={last_debug_reason:?}"
    );
    assert!(
        !saw_no_hostile_after_warmup,
        "far spawned wave should not keep reporting no_hostile_target after warmup; reason={last_debug_reason:?}"
    );
}

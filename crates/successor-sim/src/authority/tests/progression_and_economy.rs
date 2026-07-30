#[test]
fn authority_exchange_retrieve_accepts_large_prop_side_footprint_range() {
    let mut snapshot = crate::authority_test_slice();
    snapshot.actors.clear();
    snapshot.npc_jobs.clear();
    snapshot.factions.clear();
    snapshot.props.clear();
    snapshot.inventory.clear();
    snapshot.props.push(test_exchange_prop_with_size(
        CellSnapshot::new(20, 20),
        crate::CellSizeSnapshot { w: 2, h: 3 },
    ));
    snapshot.actors.push(test_actor(
        "exchange-footprint-agent",
        "Exchange Footprint Agent",
        "agent_player",
        CellSnapshot::new(23, 21),
        "left",
    ));

    let mut state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    state.add_exchange_inventory_stack(PERSONAL_SHIELD_GENERATOR_ITEM_ID, 0, "PSG", 1);
    place_actor_at_position(
        &mut state,
        "exchange-footprint-agent",
        AuthorityPosition {
            x: 23_240,
            y: 21_540,
        },
    );
    let actor = state
        .actors
        .get("exchange-footprint-agent")
        .expect("actor")
        .clone();
    let container = state
        .nearest_exchange_container_for_actor(&actor)
        .expect("exchange container");

    assert!(
        position_distance_milli(actor.position, container.position)
            > EXCHANGE_INTERACTION_RADIUS_MILLI_CELLS,
        "regression setup must sit outside the old center-only radius"
    );
    assert!(
        state.actor_within_exchange_interaction_range(&actor),
        "side-adjacent positions should count against the exchange footprint, not only the center"
    );

    let config = SliceAuthorityConfig {
        player_actor_id: "exchange-footprint-agent".to_owned(),
        ..SliceAuthorityConfig::default()
    };
    state
        .apply_retrieve_from_exchange(&config, PERSONAL_SHIELD_GENERATOR_ITEM_ID, 0, 1)
        .expect("side-adjacent retrieve should complete");
    assert_eq!(
        state.actor_inventory_available_quantity(
            "exchange-footprint-agent",
            PERSONAL_SHIELD_GENERATOR_ITEM_ID
        ),
        1
    );
}

#[test]
fn authority_actor_capability_grants_are_part_of_stable_state_hash() {
    let mut state = SliceAuthorityState::from_snapshot(&crate::authority_test_slice()).unwrap();
    let before_hash = state.stable_state_hash_hex();
    grant_test_capability(&mut state, "player", "debug:test_capability");
    assert_ne!(
        state.stable_state_hash_hex(),
        before_hash,
        "actor-owned capability grants must participate in authoritative state hashing"
    );
}

#[test]
fn authority_actor_capability_grants_load_from_snapshot_content() {
    let mut snapshot = crate::authority_test_slice();
    let mut actor = test_actor(
        "content-carrier-01",
        "Content Carrier",
        "agent_player",
        CellSnapshot::new(9, 9),
        "front",
    );
    actor.capabilities = vec![
        " debug:fixture_capability ".to_owned(),
        String::new(),
        "debug:fixture_capability".to_owned(),
    ];
    snapshot.actors.push(actor);

    let state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    let actor = state
        .actors
        .get("content-carrier-01")
        .expect("content actor exists");
    assert!(
        !actor_has_profession(actor, AuthorityProfessionKind::Marksman),
        "explicit capability grants should not require readable-id profession seeding"
    );
    assert!(actor_has_capability(actor, "debug:fixture_capability"));
    assert_eq!(
        actor
            .capabilities
            .granted
            .iter()
            .filter(|capability| capability.as_str() == "debug:fixture_capability")
            .count(),
        1,
        "content capability grants should be trimmed and deduplicated"
    );
    assert!(state
        .actor_snapshot("content-carrier-01")
        .expect("content actor snapshot exists")
        .capabilities
        .iter()
        .any(|capability| capability.id == "debug:fixture_capability"));
}

#[test]
fn authority_actor_profession_ids_load_from_snapshot_content() {
    let mut snapshot = crate::authority_test_slice();
    let mut actor = test_actor(
        "content-worker-02",
        "Content Worker",
        "agent_player",
        CellSnapshot::new(10, 9),
        "front",
    );
    actor.profession_ids = vec![" scout ".to_owned(), String::new(), "scout".to_owned()];
    snapshot.actors.push(actor);

    let state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    let actor = state
        .actors
        .get("content-worker-02")
        .expect("content actor exists");
    assert!(actor_has_profession(actor, AuthorityProfessionKind::Scout));
    assert!(
        !actor_has_profession(actor, AuthorityProfessionKind::Marksman),
        "explicit profession grants should not require readable-id profession seeding"
    );
    assert_eq!(actor_profession_bonus_milli(actor, "scout"), 1_500);
    assert!(actor_has_capability(
        actor,
        AUTHORITY_CAPABILITY_CRAFT_SCOUT_PROCESSING
    ));
    assert!(actor_has_capability(
        actor,
        AUTHORITY_CAPABILITY_HARVEST_CREATURE
    ));
    assert_eq!(
        state
            .actor_snapshot("content-worker-02")
            .expect("content actor snapshot exists")
            .professions
            .iter()
            .filter(|profession| profession.id == "scout")
            .count(),
        1,
        "content profession grants should be trimmed and deduplicated"
    );
}

#[test]
fn authority_profession_title_defaults_to_auxiliary_novice_box() {
    let mut snapshot = crate::authority_test_slice();
    let mut actor = test_actor(
        "content-title-worker-01",
        "Content Title Worker",
        "agent_player",
        CellSnapshot::new(10, 10),
        "front",
    );
    actor.profession_ids = vec!["marksman".to_owned(), "scout".to_owned()];
    snapshot.actors.push(actor);

    let state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    let active_title = state
        .actor_snapshot("content-title-worker-01")
        .expect("content actor snapshot exists")
        .active_title
        .expect("novice title should be active");

    assert_eq!(active_title.id, "scout-novice");
    assert_eq!(active_title.label, "Novice Scout");
    assert_eq!(active_title.skill_box_id, "scout-novice");
}

#[test]
fn authority_actor_upsert_honors_explicit_active_title_seed() {
    let mut state = SliceAuthorityState::from_snapshot(&crate::authority_test_slice()).unwrap();
    let mut input = creator_clothing_upsert(Vec::new(), BTreeMap::new());
    input.id = "active-title-seed".to_owned();
    input.entity = input.id.clone();
    input.profession_ids = vec!["marksman".to_owned()];
    input.skill_box_ids = vec!["craftsman-novice".to_owned()];
    input.profession_xp =
        BTreeMap::from([("marksman".to_owned(), 240), ("craftsman".to_owned(), 80)]);
    input.profession_track_xp = BTreeMap::from([
        ("marksman:rifle".to_owned(), 200),
        ("craftsman:assembly".to_owned(), 60),
    ]);
    input.skill_point_cap = Some(300);
    input.active_title_id = Some("craftsman-novice".to_owned());

    let actor = state
        .upsert_actor(input)
        .expect("active title seed is valid");
    let active_title = actor.active_title.expect("seeded title should be active");

    assert_eq!(active_title.id, "craftsman-novice");
    assert_eq!(active_title.label, "Novice Craftsman");
    assert_eq!(active_title.skill_box_id, "craftsman-novice");
    let marksman = actor
        .professions
        .iter()
        .find(|profession| profession.id == "marksman")
        .expect("marksman progress should be projected");
    assert_eq!(marksman.xp, 240);
    assert_eq!(marksman.track_xp.get("rifle"), Some(&200));
    let craftsman = actor
        .professions
        .iter()
        .find(|profession| profession.id == "craftsman")
        .expect("craftsman progress should be projected");
    assert_eq!(craftsman.xp, 80);
    assert_eq!(craftsman.track_xp.get("assembly"), Some(&60));
    assert_eq!(actor.skill_points_cap, 300);
}

#[test]
fn authority_set_profession_title_accepts_only_learned_title_boxes() {
    let config = SliceAuthorityConfig::default();
    let mut state = SliceAuthorityState::from_snapshot(&crate::authority_test_slice()).unwrap();
    let player = config.player_actor_id.clone();
    grant_test_profession(&mut state, &player, AuthorityProfessionKind::Marksman);
    grant_test_profession(&mut state, &player, AuthorityProfessionKind::Scout);

    let set_scout = state.apply_envelope(
        &config,
        command(
            1,
            ClientCommand::SetProfessionTitle {
                title_id: Some("scout-novice".to_owned()),
            },
        ),
    );
    assert_eq!(set_scout.status, AuthorityCommandStatus::Accepted);
    let active_title = state
        .actor_snapshot(&player)
        .expect("player snapshot exists")
        .active_title
        .expect("title should be active");
    assert_eq!(active_title.id, "scout-novice");
    assert_eq!(active_title.label, "Novice Scout");

    let unlearned_medic = state.apply_envelope(
        &config,
        command(
            2,
            ClientCommand::SetProfessionTitle {
                title_id: Some("medic-novice".to_owned()),
            },
        ),
    );
    assert_eq!(unlearned_medic.status, AuthorityCommandStatus::Rejected);
    assert_eq!(
        unlearned_medic.reason_code.as_deref(),
        Some(AuthorityRejectReason::UnknownProfessionTitle.code())
    );
    assert_eq!(
        state
            .actor_snapshot(&player)
            .expect("player snapshot exists")
            .active_title
            .expect("title should still be active")
            .id,
        "scout-novice"
    );
}

#[test]
fn authority_purchase_skill_box_trains_at_nearby_profession_trainer() {
    let config = SliceAuthorityConfig::default();
    let mut snapshot = crate::authority_test_slice();
    let mut trainer = test_actor(
        "profession-trainer-01",
        "Vela Orr",
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
    grant_test_profession(&mut state, &player, AuthorityProfessionKind::Marksman);
    state
        .award_profession_track_xp(&player, AuthorityProfessionKind::Marksman, "rifle", 120)
        .unwrap();
    let credits_before = state
        .actors
        .get(&player)
        .expect("player exists")
        .professions
        .credits;

    let buy = state.apply_envelope(
        &config,
        command(
            1,
            ClientCommand::PurchaseSkillBox {
                skill_box_id: "marksman-rifle-i".to_owned(),
                trainer_actor_id: "profession-trainer-01".to_owned(),
            },
        ),
    );
    assert_eq!(
        buy.status,
        AuthorityCommandStatus::Accepted,
        "purchase: {:?}",
        buy.reason_code
    );
    let actor = state.actors.get(&player).expect("player exists");
    assert!(actor.professions.has_skill_box("marksman-rifle-i"));
    assert_eq!(actor.professions.credits, credits_before);
    assert_eq!(actor.professions.skill_points_used(), 24);
    let snapshot = state
        .actor_snapshot(&player)
        .expect("player snapshot exists");
    let marksman = snapshot
        .professions
        .iter()
        .find(|profession| profession.id == "marksman")
        .expect("marksman profession snapshot exists");
    assert!(marksman
        .skill_boxes
        .iter()
        .any(|skill_box| skill_box == "marksman-rifle-i"));
    assert_eq!(marksman.xp, 20);
    assert_eq!(marksman.track_xp.get("rifle"), Some(&20));

    let too_expensive = state.apply_envelope(
        &config,
        command(
            2,
            ClientCommand::PurchaseSkillBox {
                skill_box_id: "marksman-rifle-ii".to_owned(),
                trainer_actor_id: "profession-trainer-01".to_owned(),
            },
        ),
    );
    assert_eq!(too_expensive.status, AuthorityCommandStatus::Rejected);
    assert_eq!(
        too_expensive.reason_code.as_deref(),
        Some(AuthorityRejectReason::InsufficientProfessionXp.code())
    );

    let duplicate = state.apply_envelope(
        &config,
        command(
            4,
            ClientCommand::PurchaseSkillBox {
                skill_box_id: "marksman-rifle-i".to_owned(),
                trainer_actor_id: "profession-trainer-01".to_owned(),
            },
        ),
    );
    assert_eq!(duplicate.status, AuthorityCommandStatus::Rejected);
    assert_eq!(
        duplicate.reason_code.as_deref(),
        Some(AuthorityRejectReason::SkillAlreadyLearned.code())
    );
}

#[test]
fn progression_hover_unlock_metadata_matches_authority_certs_and_recipes() {
    let payload: serde_json::Value = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../client/src/slice-core/specs/progression.v1.json"
    )))
    .expect("progression specs parse");
    let nodes = payload["skillNodes"]
        .as_array()
        .expect("skillNodes is an array");
    let metadata_catalog = |field: &str| {
        nodes
            .iter()
            .filter_map(|node| {
                let values = node[field].as_array()?;
                if values.is_empty() {
                    return None;
                }
                Some((
                    node["id"].as_str()?.to_owned(),
                    values
                        .iter()
                        .map(|value| {
                            value
                                .as_str()
                                .expect("unlock metadata is a string")
                                .to_owned()
                        })
                        .collect::<Vec<_>>(),
                ))
            })
            .collect::<BTreeMap<_, _>>()
    };

    assert_eq!(
        metadata_catalog("weaponCertifications"),
        authority_weapon_certification_catalog(),
        "hover cert claims must be generated from the same boxes enforced by equip authority"
    );
    assert_eq!(
        metadata_catalog("craftingSchematics"),
        authority_crafting_unlock_catalog(),
        "hover schematic claims must match every trained recipe gate"
    );
    assert_eq!(
        metadata_catalog("authorityCapabilities"),
        authority_capability_unlock_catalog(),
        "hover ability claims must map to every exact capability granted by profession authority"
    );
    let ability_labels = metadata_catalog("abilities");
    let authority_capabilities = metadata_catalog("authorityCapabilities");
    assert_eq!(
        ability_labels.keys().collect::<Vec<_>>(),
        authority_capabilities.keys().collect::<Vec<_>>(),
        "every exact authority capability set needs player-facing hover copy"
    );
    for (skill_box_id, capability_ids) in authority_capabilities {
        assert_eq!(
            ability_labels[&skill_box_id].len(),
            capability_ids.len(),
            "{skill_box_id} needs one player-facing ability name per authority capability"
        );
    }
}

#[test]
fn legacy_inventory_currency_migrates_without_destroying_value() {
    let mut snapshot = crate::authority_test_slice();
    snapshot
        .actors
        .iter_mut()
        .find(|actor| actor.id == "player")
        .expect("fixture player")
        .credits = Some(700);
    snapshot.inventory.push(InventoryStackSnapshot {
        stack_id: 90_001,
        container: "player:wallet".to_owned(),
        item: "Legacy Currency".to_owned(),
        item_id: 9_001,
        variant_id: 0,
        quantity: 25,
        reserved: 0,
        available: 25,
    });
    snapshot.inventory.push(InventoryStackSnapshot {
        stack_id: 90_002,
        container: "district-exchange".to_owned(),
        item: "Legacy Currency".to_owned(),
        item_id: 9_001,
        variant_id: 0,
        quantity: 9,
        reserved: 0,
        available: 9,
    });

    let authority = SliceAuthorityState::from_snapshot(&snapshot).expect("authority builds");
    assert_eq!(authority.actors["player"].professions.credits, 725);
    assert!(
        authority.inventory.iter().all(|row| row.item_id != 9_001),
        "retired currency rows must not survive authority load"
    );
    assert!(authority.inventory.iter().any(|row| {
        row.container == "district-exchange"
            && row.item_id == CREDIT_CHIP_ITEM_ID
            && row.item == "Credit Chip"
            && row.quantity == 9
    }));
}

#[test]
fn legacy_currency_trade_lines_migrate_into_credit_fields_and_break_locks() {
    let mut proposals = BTreeMap::from([(
        7,
        TradeProposal {
            proposer: "player".to_owned(),
            partner: "rogue".to_owned(),
            offer: vec![TradeItemSpec {
                item_id: 9_001,
                variant_id: 0,
                quantity: 20,
            }],
            request: vec![TradeItemSpec {
                item_id: 9_001,
                variant_id: 0,
                quantity: 5,
            }],
            proposer_coin: 3,
            partner_coin: 2,
            proposer_locked: true,
            partner_locked: true,
            proposer_confirmed: true,
            partner_confirmed: true,
            closed: None,
        },
    )]);

    state::migrate_legacy_currency_trade_proposals(&mut proposals);
    let proposal = &proposals[&7];
    assert_eq!(proposal.proposer_coin, 23);
    assert_eq!(proposal.partner_coin, 7);
    assert!(proposal.offer.is_empty());
    assert!(proposal.request.is_empty());
    assert!(!proposal.proposer_locked);
    assert!(!proposal.partner_locked);
    assert!(!proposal.proposer_confirmed);
    assert!(!proposal.partner_confirmed);
}

#[test]
fn authority_tracked_skill_box_requires_both_xp_pools_and_preserves_trainer_gate() {
    let definition = authority_skill_box_definition("marksman-rifle-i")
        .expect("marksman rifle I definition exists");
    for (profession_xp, track_xp, expected_effective_xp, should_spend) in [
        (50_u64, 150_u64, 50_u64, false),
        (150_u64, 50_u64, 50_u64, false),
        (150_u64, 150_u64, 150_u64, true),
    ] {
        let mut professions = ActorProfessionState::from_profession_ids(&["marksman".to_owned()])
            .expect("marksman parses");
        professions
            .xp
            .insert(AuthorityProfessionKind::Marksman, profession_xp);
        professions
            .track_xp
            .insert("marksman:rifle".to_owned(), track_xp);
        assert_eq!(
            professions.xp_for_skill_box_definition(&definition),
            expected_effective_xp,
            "tracked skill eligibility uses the smaller XP pool",
        );
        let result = professions.spend_xp_for_skill_box_definition(&definition);
        assert_eq!(result.is_ok(), should_spend);
        if should_spend {
            assert_eq!(professions.xp[&AuthorityProfessionKind::Marksman], 50);
            assert_eq!(professions.track_xp["marksman:rifle"], 50);
        } else {
            assert_eq!(
                professions.xp[&AuthorityProfessionKind::Marksman],
                profession_xp
            );
            assert_eq!(professions.track_xp["marksman:rifle"], track_xp);
        }
    }

    let config = SliceAuthorityConfig::default();
    let mut state = SliceAuthorityState::from_snapshot(&crate::authority_test_slice()).unwrap();
    let player = config.player_actor_id.clone();
    grant_test_profession(&mut state, &player, AuthorityProfessionKind::Marksman);
    let rejected = state.apply_envelope(
        &config,
        command(
            1,
            ClientCommand::PurchaseSkillBox {
                skill_box_id: definition.id.clone(),
                trainer_actor_id: "not-a-trainer".to_owned(),
            },
        ),
    );
    assert_eq!(rejected.status, AuthorityCommandStatus::Rejected);
    assert_eq!(
        rejected.reason_code.as_deref(),
        Some(AuthorityRejectReason::TrainerUnavailable.code()),
        "trainer mismatch remains distinct from XP denial",
    );
}

#[test]
fn authority_unlearn_skill_box_refunds_sp_preserves_progress_and_enforces_dependencies() {
    let mut snapshot = roll_combat_test_snapshot();
    let mut trainer = test_actor(
        "profession-trainer-01",
        "Vela Orr",
        "profession_trainer",
        CellSnapshot::new(10, 10),
        "front",
    );
    trainer
        .capabilities
        .push(AUTHORITY_CAPABILITY_TRAIN_PROFESSION.to_owned());
    snapshot.actors.push(trainer);
    let (config, mut state) = roll_combat_test_state_from_snapshot(snapshot);
    let player = config.player_actor_id.clone();
    grant_test_profession(&mut state, &player, AuthorityProfessionKind::Marksman);
    {
        let actor = state.actors.get_mut(&player).expect("player exists");
        actor
            .professions
            .skill_boxes
            .insert("marksman-rifle-i".to_owned());
        actor
            .professions
            .award_track_xp(AuthorityProfessionKind::Marksman, "rifle", 175);
    }
    let credits_before = state.actors[&player].professions.credits;
    let rifle_cost = authority_skill_box_definition("marksman-rifle-i")
        .expect("rifle I definition exists")
        .xp_required;
    let profession_xp_before = state.actors[&player]
        .professions
        .xp
        .get(&AuthorityProfessionKind::Marksman)
        .copied()
        .unwrap_or_default();
    let track_xp_before = state.actors[&player]
        .professions
        .track_xp_amount(AuthorityProfessionKind::Marksman, "rifle");
    let ammo_before = state.actor_inventory_available_quantity(&player, AMMO_SLUG_IRON_ITEM_ID);
    assert_eq!(state.actors[&player].professions.skill_points_used(), 24);

    let blocked = state.apply_envelope(
        &config,
        command(
            1,
            ClientCommand::UnlearnSkillBox {
                skill_box_id: "marksman-novice".to_owned(),
                trainer_actor_id: "profession-trainer-01".to_owned(),
            },
        ),
    );
    assert_eq!(blocked.status, AuthorityCommandStatus::Rejected);
    assert_eq!(
        blocked.reason_code.as_deref(),
        Some(AuthorityRejectReason::SkillRequiredByLearnedBox.code())
    );
    assert_eq!(state.actors[&player].professions.skill_points_used(), 24);
    assert_eq!(
        state.actors[&player].professions.xp[&AuthorityProfessionKind::Marksman],
        profession_xp_before,
        "blocked removal does not refund general XP"
    );
    assert_eq!(
        state.actors[&player]
            .professions
            .track_xp_amount(AuthorityProfessionKind::Marksman, "rifle"),
        track_xp_before,
        "blocked removal does not refund track XP"
    );

    let unlearn_rifle = state.apply_envelope(
        &config,
        command(
            2,
            ClientCommand::UnlearnSkillBox {
                skill_box_id: "marksman-rifle-i".to_owned(),
                trainer_actor_id: "profession-trainer-01".to_owned(),
            },
        ),
    );
    assert_eq!(
        unlearn_rifle.status,
        AuthorityCommandStatus::Accepted,
        "unlearn rifle: {:?}",
        unlearn_rifle.reason_code
    );
    let actor = &state.actors[&player];
    assert_eq!(actor.professions.skill_points_used(), 16);
    assert!(actor.professions.has(AuthorityProfessionKind::Marksman));
    assert_eq!(actor.professions.credits, credits_before);
    assert_eq!(
        actor.professions.xp[&AuthorityProfessionKind::Marksman],
        profession_xp_before.saturating_add(rifle_cost),
        "unlearning restores the exact general profession XP cost"
    );
    assert_eq!(
        actor
            .professions
            .track_xp_amount(AuthorityProfessionKind::Marksman, "rifle"),
        track_xp_before.saturating_add(rifle_cost),
        "tracked unlearning restores the exact track XP cost"
    );
    assert_eq!(
        actor.equipped_weapon_id,
        Some(AuthorityWeaponId::Slugthrower)
    );

    state.clear_actor_economy_action_cooldown(&player);
    let duplicate_rifle = state.apply_envelope(
        &config,
        command(
            3,
            ClientCommand::UnlearnSkillBox {
                skill_box_id: "marksman-rifle-i".to_owned(),
                trainer_actor_id: "profession-trainer-01".to_owned(),
            },
        ),
    );
    assert_eq!(duplicate_rifle.status, AuthorityCommandStatus::Rejected);
    assert_eq!(
        duplicate_rifle.reason_code.as_deref(),
        Some(AuthorityRejectReason::SkillNotLearned.code())
    );
    let actor = &state.actors[&player];
    assert_eq!(
        actor.professions.xp[&AuthorityProfessionKind::Marksman],
        profession_xp_before.saturating_add(rifle_cost),
        "invalid duplicate unlearn does not refund general XP twice"
    );
    assert_eq!(
        actor
            .professions
            .track_xp_amount(AuthorityProfessionKind::Marksman, "rifle"),
        track_xp_before.saturating_add(rifle_cost),
        "invalid duplicate unlearn does not refund track XP twice"
    );

    state.clear_actor_economy_action_cooldown(&player);
    let repurchase = state.apply_envelope(
        &config,
        command(
            4,
            ClientCommand::PurchaseSkillBox {
                skill_box_id: "marksman-rifle-i".to_owned(),
                trainer_actor_id: "profession-trainer-01".to_owned(),
            },
        ),
    );
    assert_eq!(repurchase.status, AuthorityCommandStatus::Accepted);
    let actor = &state.actors[&player];
    assert!(actor.professions.has_skill_box("marksman-rifle-i"));
    assert_eq!(
        actor.professions.xp[&AuthorityProfessionKind::Marksman],
        profession_xp_before,
        "purchase after unlearn returns the general XP pool to its starting value"
    );
    assert_eq!(
        actor
            .professions
            .track_xp_amount(AuthorityProfessionKind::Marksman, "rifle"),
        track_xp_before,
        "purchase after unlearn returns the track XP pool to its starting value"
    );

    state.clear_actor_economy_action_cooldown(&player);
    super::combat_roll::queue_combat_action(&mut state, &player, "basic_shot", "roll-target")
        .expect("certified weapon action queues before novice removal");
    assert!(ability_queue_depth_for_test(&state.actors[&player]) > 0);

    let unlearn_rifle_again = state.apply_envelope(
        &config,
        command(
            5,
            ClientCommand::UnlearnSkillBox {
                skill_box_id: "marksman-rifle-i".to_owned(),
                trainer_actor_id: "profession-trainer-01".to_owned(),
            },
        ),
    );
    assert_eq!(unlearn_rifle_again.status, AuthorityCommandStatus::Accepted);

    state.clear_actor_economy_action_cooldown(&player);
    let unlearn_novice = state.apply_envelope(
        &config,
        command(
            6,
            ClientCommand::UnlearnSkillBox {
                skill_box_id: "marksman-novice".to_owned(),
                trainer_actor_id: "profession-trainer-01".to_owned(),
            },
        ),
    );
    assert_eq!(
        unlearn_novice.status,
        AuthorityCommandStatus::Accepted,
        "unlearn novice: {:?}",
        unlearn_novice.reason_code
    );
    let actor = &state.actors[&player];
    assert_eq!(actor.professions.skill_points_used(), 0);
    assert!(!actor.professions.has(AuthorityProfessionKind::Marksman));
    assert!(actor.professions.active_title_id.is_none());
    assert_eq!(actor.professions.credits, credits_before);
    assert_eq!(actor.equipped_weapon_id, None);
    assert_eq!(actor.equipped_weapon_item_id, 0);
    assert_eq!(actor.equipped_weapon_variant_id, 0);
    assert_eq!(ability_queue_depth_for_test(actor), 0);
    assert_eq!(
        state.actor_inventory_available_quantity(&player, AMMO_SLUG_IRON_ITEM_ID),
        ammo_before,
        "unlearning does not reissue or consume one-time starter ammunition"
    );

    state.clear_actor_economy_action_cooldown(&player);
    let duplicate = state.apply_envelope(
        &config,
        command(
            7,
            ClientCommand::UnlearnSkillBox {
                skill_box_id: "marksman-novice".to_owned(),
                trainer_actor_id: "profession-trainer-01".to_owned(),
            },
        ),
    );
    assert_eq!(duplicate.status, AuthorityCommandStatus::Rejected);
    assert_eq!(
        duplicate.reason_code.as_deref(),
        Some(AuthorityRejectReason::SkillNotLearned.code())
    );
}

#[test]
fn authority_unlearn_untracked_box_refunds_only_general_xp_and_rebuilds_membership() {
    let mut professions = ActorProfessionState::from_profession_ids(&["marksman".to_owned()])
        .expect("marksman parses");
    professions
        .xp
        .insert(AuthorityProfessionKind::Marksman, u64::MAX - 500);
    professions.track_xp.insert("marksman:rifle".to_owned(), 77);
    professions.skill_boxes.insert("marksman-master".to_owned());
    let master_cost = authority_skill_box_definition("marksman-master")
        .expect("marksman master definition exists")
        .xp_required;

    professions
        .unlearn_skill_box("marksman-master")
        .expect("untracked master unlearn succeeds");
    assert!(!professions.has_skill_box("marksman-master"));
    assert_eq!(
        professions.xp[&AuthorityProfessionKind::Marksman],
        u64::MAX,
        "general XP refund saturates instead of wrapping"
    );
    assert_eq!(
        professions.track_xp_amount(AuthorityProfessionKind::Marksman, "rifle"),
        77,
        "untracked boxes do not refund a track pool"
    );
    assert_eq!(
        master_cost, 1_800,
        "master definition supplies the inverse XP cost"
    );
    assert!(professions.has(AuthorityProfessionKind::Marksman));

    professions
        .unlearn_skill_box("marksman-novice")
        .expect("novice unlearn succeeds after its dependents are gone");
    assert!(!professions.has(AuthorityProfessionKind::Marksman));
}

#[test]
fn authority_career_respec_auto_unequips_a_now_uncertified_weapon_and_clears_queue() {
    let mut snapshot = roll_combat_test_snapshot();
    let mut trainer = test_actor(
        "profession-trainer-01",
        "Vela Orr",
        "profession_trainer",
        CellSnapshot::new(10, 10),
        "front",
    );
    trainer
        .capabilities
        .push(AUTHORITY_CAPABILITY_TRAIN_PROFESSION.to_owned());
    snapshot.actors.push(trainer);
    let (config, mut state) = roll_combat_test_state_from_snapshot(snapshot);
    let player = config.player_actor_id.clone();
    clear_test_professions(&mut state, &player);
    grant_test_profession(&mut state, &player, AuthorityProfessionKind::Brawler);
    {
        let actor = state.actors.get_mut(&player).expect("player exists");
        actor.equipped_weapon_id = Some(AuthorityWeaponId::Vibrosword);
        actor.equipped_weapon_item_id = 0;
        actor.equipped_weapon_variant_id = 0;
    }
    super::combat_roll::queue_combat_action(&mut state, &player, "basic_shot", "roll-target")
        .expect("certified melee action queues before respec");
    assert!(ability_queue_depth_for_test(&state.actors[&player]) > 0);

    let respec = state.apply_envelope(
        &config,
        command(
            1,
            ClientCommand::SetCareerGoal {
                goal_id: "ranged_specialist".to_owned(),
                trainer_actor_id: "profession-trainer-01".to_owned(),
            },
        ),
    );
    assert_eq!(
        respec.status,
        AuthorityCommandStatus::Accepted,
        "respec: {:?}",
        respec.reason_code
    );
    let actor = &state.actors[&player];
    assert!(!actor.professions.has_skill_box("brawler-novice"));
    assert_eq!(actor.equipped_weapon_id, None);
    assert_eq!(actor.equipped_weapon_item_id, 0);
    assert_eq!(actor.equipped_weapon_variant_id, 0);
    assert_eq!(ability_queue_depth_for_test(actor), 0);
}

#[test]
fn authority_purchase_novice_skill_box_learns_new_profession_at_trainer() {
    let config = SliceAuthorityConfig::default();
    let mut snapshot = crate::authority_test_slice();
    let mut trainer = test_actor(
        "profession-trainer-01",
        "Vela Orr",
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
    let credits_before = state
        .actors
        .get(&player)
        .expect("player exists")
        .professions
        .credits;

    let buy = state.apply_envelope(
        &config,
        command(
            1,
            ClientCommand::PurchaseSkillBox {
                skill_box_id: "medic-novice".to_owned(),
                trainer_actor_id: "profession-trainer-01".to_owned(),
            },
        ),
    );
    assert_eq!(
        buy.status,
        AuthorityCommandStatus::Accepted,
        "novice purchase: {:?}",
        buy.reason_code
    );
    let actor = state.actors.get(&player).expect("player exists");
    assert!(actor.professions.has(AuthorityProfessionKind::Medic));
    assert!(actor.professions.has_skill_box("medic-novice"));
    assert_eq!(actor.professions.credits, credits_before);
    assert_eq!(actor.professions.skill_points_used(), 16);

    let snapshot = state
        .actor_snapshot(&player)
        .expect("player snapshot exists");
    let medic = snapshot
        .professions
        .iter()
        .find(|profession| profession.id == "medic")
        .expect("medic profession snapshot exists");
    assert!(medic
        .skill_boxes
        .iter()
        .any(|skill_box| skill_box == "medic-novice"));
}

#[test]
fn authority_purchase_craftsman_novice_spends_points_without_reissuing_creation_tools() {
    let config = SliceAuthorityConfig::default();
    let mut snapshot = crate::authority_test_slice();
    let mut trainer = test_actor(
        "profession-trainer-01",
        "Vela Orr",
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
    state.inventory.retain(|row| {
        !(actor_owns_inventory_container(&player, &row.container)
            && row.item_id == FIELD_MULTITOOL_ITEM_ID)
    });
    let buy = state.apply_envelope(
        &config,
        command(
            1,
            ClientCommand::PurchaseSkillBox {
                skill_box_id: "craftsman-novice".to_owned(),
                trainer_actor_id: "profession-trainer-01".to_owned(),
            },
        ),
    );
    assert_eq!(
        buy.status,
        AuthorityCommandStatus::Accepted,
        "craftsman novice purchase: {:?}",
        buy.reason_code
    );
    let actor = state.actors.get(&player).expect("player exists");
    assert!(actor.professions.has(AuthorityProfessionKind::Craftsman));
    assert!(actor.professions.has_skill_box("craftsman-novice"));
    assert_eq!(actor.professions.skill_points_used(), 16);
    assert_eq!(
        state.actor_inventory_available_quantity(&player, FIELD_MULTITOOL_ITEM_ID),
        0,
        "learning later changes the skill budget, not the one-time creation kit"
    );

    let duplicate = state.apply_envelope(
        &config,
        command(
            2,
            ClientCommand::PurchaseSkillBox {
                skill_box_id: "craftsman-novice".to_owned(),
                trainer_actor_id: "profession-trainer-01".to_owned(),
            },
        ),
    );
    assert_eq!(duplicate.status, AuthorityCommandStatus::Rejected);
    assert_eq!(
        duplicate.reason_code.as_deref(),
        Some(AuthorityRejectReason::SkillAlreadyLearned.code())
    );
    assert_eq!(
        state.actor_inventory_available_quantity(&player, FIELD_MULTITOOL_ITEM_ID),
        0
    );
}

#[test]
fn authority_request_starter_tools_grants_and_backfills_the_complete_kit() {
    let config = SliceAuthorityConfig::default();
    let mut snapshot = crate::authority_test_slice();
    let mut trainer = test_actor(
        "profession-trainer-01",
        "Vela Orr",
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
    state.inventory.retain(|row| {
        !(actor_owns_inventory_container(&player, &row.container)
            && matches!(
                row.item_id,
                FIELD_MULTITOOL_ITEM_ID | MINERAL_SURVEY_TOOL_ITEM_ID
            ))
    });

    let grant = state.apply_envelope(
        &config,
        command(
            1,
            ClientCommand::RequestStarterTool {
                trainer_actor_id: "profession-trainer-01".to_owned(),
            },
        ),
    );
    assert_eq!(
        grant.status,
        AuthorityCommandStatus::Accepted,
        "RequestStarterTool rejected: {:?}",
        grant.reason_code
    );
    for (item_id, variant_id) in [
        (
            FIELD_MULTITOOL_ITEM_ID,
            STARTER_FIELD_MULTITOOL_QUALITY_MILLI,
        ),
        (
            MINERAL_SURVEY_TOOL_ITEM_ID,
            STARTER_FIELD_MULTITOOL_QUALITY_MILLI,
        ),
    ] {
        assert!(state.inventory_snapshots().iter().any(|row| {
            actor_owns_inventory_container(&player, &row.container)
                && row.item_id == item_id
                && row.variant_id == variant_id
                && row.available == 1
        }));
    }

    state.inventory.retain(|row| {
        !(actor_owns_inventory_container(&player, &row.container)
            && row.item_id == MINERAL_SURVEY_TOOL_ITEM_ID)
    });
    let cooldown = state.apply_envelope(
        &config,
        command(
            2,
            ClientCommand::RequestStarterTool {
                trainer_actor_id: "profession-trainer-01".to_owned(),
            },
        ),
    );
    assert_eq!(cooldown.status, AuthorityCommandStatus::Rejected);
    assert_eq!(
        cooldown.reason_code.as_deref(),
        Some(AuthorityRejectReason::StarterToolCooldown.code())
    );
    state
        .actors
        .get_mut(&player)
        .expect("player exists")
        .next_starter_tool_request_tick = 0;
    let backfill = state.apply_envelope(
        &config,
        command(
            3,
            ClientCommand::RequestStarterTool {
                trainer_actor_id: "profession-trainer-01".to_owned(),
            },
        ),
    );
    assert_eq!(backfill.status, AuthorityCommandStatus::Accepted);
    assert_eq!(
        state.actor_inventory_available_quantity(&player, FIELD_MULTITOOL_ITEM_ID),
        1,
        "backfill must not duplicate an existing multitool"
    );
    assert_eq!(
        state.actor_inventory_available_quantity(&player, MINERAL_SURVEY_TOOL_ITEM_ID),
        1
    );

    let duplicate = state.apply_envelope(
        &config,
        command(
            4,
            ClientCommand::RequestStarterTool {
                trainer_actor_id: "profession-trainer-01".to_owned(),
            },
        ),
    );
    assert_eq!(duplicate.status, AuthorityCommandStatus::Rejected);
    assert_eq!(
        duplicate.reason_code.as_deref(),
        Some(AuthorityRejectReason::ToolAlreadyHeld.code())
    );
}

#[test]
fn authority_starter_tool_request_ignores_remote_exchange_rows() {
    let config = SliceAuthorityConfig::default();
    let mut snapshot = crate::authority_test_slice();
    snapshot.props.clear();
    snapshot.inventory.clear();
    let mut trainer = test_actor(
        "profession-trainer-01",
        "Vela Orr",
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
    let actor = state.actors.get(&player).expect("player exists").clone();
    assert!(!state.actor_within_exchange_interaction_range(&actor));
    state.add_exchange_inventory_stack(
        FIELD_MULTITOOL_ITEM_ID,
        STARTER_FIELD_MULTITOOL_QUALITY_MILLI,
        "Field Multitool",
        1,
    );
    state.add_exchange_inventory_stack(
        MINERAL_SURVEY_TOOL_ITEM_ID,
        STARTER_FIELD_MULTITOOL_QUALITY_MILLI,
        "Mineral Survey Tool",
        1,
    );

    let grant = state.apply_envelope(
        &config,
        command(
            1,
            ClientCommand::RequestStarterTool {
                trainer_actor_id: "profession-trainer-01".to_owned(),
            },
        ),
    );
    assert_eq!(grant.status, AuthorityCommandStatus::Accepted);
    assert_eq!(
        state.actor_inventory_available_quantity(&player, FIELD_MULTITOOL_ITEM_ID),
        1
    );
    assert_eq!(
        state.actor_inventory_available_quantity(&player, MINERAL_SURVEY_TOOL_ITEM_ID),
        1
    );
}

#[test]
fn authority_starter_tool_request_counts_partial_and_complete_in_range_exchange_bundles() {
    let config = SliceAuthorityConfig::default();
    let mut snapshot = crate::authority_test_slice();
    snapshot.inventory.clear();
    snapshot
        .props
        .push(test_exchange_prop(CellSnapshot::new(36, 21)));
    let mut trainer = test_actor(
        "profession-trainer-01",
        "Vela Orr",
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
    let actor = state.actors.get(&player).expect("player exists").clone();
    assert!(state.actor_within_exchange_interaction_range(&actor));

    state.add_exchange_inventory_stack(
        FIELD_MULTITOOL_ITEM_ID,
        STARTER_FIELD_MULTITOOL_QUALITY_MILLI,
        "Field Multitool",
        1,
    );
    let partial = state.apply_envelope(
        &config,
        command(
            1,
            ClientCommand::RequestStarterTool {
                trainer_actor_id: "profession-trainer-01".to_owned(),
            },
        ),
    );
    assert_eq!(partial.status, AuthorityCommandStatus::Accepted);
    assert_eq!(
        state.actor_inventory_available_quantity(&player, FIELD_MULTITOOL_ITEM_ID),
        0,
        "exchange-held multitool must not be duplicated into carried inventory"
    );
    assert_eq!(
        state.actor_inventory_available_quantity(&player, MINERAL_SURVEY_TOOL_ITEM_ID),
        1,
        "only the missing mineral tool should be backfilled"
    );

    state.inventory.retain(|row| {
        !(actor_owns_inventory_container(&player, &row.container)
            && row.item_id == MINERAL_SURVEY_TOOL_ITEM_ID)
    });
    state.add_exchange_inventory_stack(
        MINERAL_SURVEY_TOOL_ITEM_ID,
        STARTER_FIELD_MULTITOOL_QUALITY_MILLI,
        "Mineral Survey Tool",
        1,
    );
    state
        .actors
        .get_mut(&player)
        .expect("player exists")
        .next_starter_tool_request_tick = 0;
    let complete = state.apply_envelope(
        &config,
        command(
            2,
            ClientCommand::RequestStarterTool {
                trainer_actor_id: "profession-trainer-01".to_owned(),
            },
        ),
    );
    assert_eq!(complete.status, AuthorityCommandStatus::Rejected);
    assert_eq!(
        complete.reason_code.as_deref(),
        Some(AuthorityRejectReason::ToolAlreadyHeld.code())
    );
}

#[test]
fn authority_career_goal_templates_fit_two_and_half_profession_budget() {
    assert_eq!(
        authority_skill_box_definition("marksman-novice")
            .unwrap()
            .skill_point_cost,
        16
    );
    assert_eq!(
        authority_skill_box_definition("marksman-rifle-i")
            .unwrap()
            .skill_point_cost,
        8
    );
    assert_eq!(
        authority_skill_box_definition("marksman-rifle-ii")
            .unwrap()
            .skill_point_cost,
        6
    );
    assert_eq!(
        authority_skill_box_definition("marksman-rifle-iii")
            .unwrap()
            .skill_point_cost,
        4
    );
    assert_eq!(
        authority_skill_box_definition("marksman-rifle-iv")
            .unwrap()
            .skill_point_cost,
        2
    );
    assert_eq!(
        authority_skill_box_definition("marksman-master")
            .unwrap()
            .skill_point_cost,
        1
    );
    for goal_id in [
        "rifle_utility",
        "ranged_specialist",
        "melee_specialist",
        "rifle_quartermaster",
    ] {
        let goal = authority_career_goal_template(goal_id).expect("career goal exists");
        assert_eq!(
            goal.target_skill_points(),
            DEFAULT_SKILL_POINT_CAP,
            "{goal_id} should consume the 250 point cap exactly"
        );
    }
}

#[test]
fn authority_auto_train_player_like_rifle_utility_grabs_novice_medic_from_same_area_trainer() {
    let mut snapshot = crate::authority_test_slice();
    let mut trainer = test_actor(
        "profession-trainer-01",
        "Vela Orr",
        "profession_trainer",
        CellSnapshot::new(37, 22),
        "front",
    );
    trainer
        .capabilities
        .push(AUTHORITY_CAPABILITY_TRAIN_PROFESSION.to_owned());
    snapshot.actors.push(trainer);
    let mut guard = test_actor(
        "auto-guard-01",
        "Auto Guard",
        "agent_player",
        CellSnapshot::new(52, 34),
        "front",
    );
    guard.career_goal_id = Some("rifle_utility".to_owned());
    snapshot.actors.push(guard);

    let mut state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    grant_test_profession(
        &mut state,
        "auto-guard-01",
        AuthorityProfessionKind::Marksman,
    );
    state.tick = u64::from(state.tick_rate_hz.max(1));
    state.tick_auto_train_player_like_pawns();

    let actor = state
        .actors
        .get("auto-guard-01")
        .expect("auto guard exists");
    assert!(actor.professions.has(AuthorityProfessionKind::Medic));
    assert!(actor.professions.has_skill_box("medic-novice"));
    assert!(actor_has_capability(
        actor,
        AUTHORITY_CAPABILITY_CRAFT_MEDICINE
    ));
    assert!(actor_has_capability(
        actor,
        AUTHORITY_CAPABILITY_REVIVE_BASIC
    ));
    let career_goal = state
        .actor_snapshot("auto-guard-01")
        .expect("auto guard snapshot")
        .career_goal
        .expect("career goal snapshot");
    assert_eq!(career_goal.id, "rifle_utility");
    assert_eq!(career_goal.target_skill_points, DEFAULT_SKILL_POINT_CAP);
}

#[test]
fn authority_auto_train_player_like_career_goal_buys_rifle_accuracy() {
    let mut snapshot = crate::authority_test_slice();
    let mut trainer = test_actor(
        "profession-trainer-01",
        "Vela Orr",
        "profession_trainer",
        CellSnapshot::new(37, 22),
        "front",
    );
    trainer
        .capabilities
        .push(AUTHORITY_CAPABILITY_TRAIN_PROFESSION.to_owned());
    snapshot.actors.push(trainer);
    let mut guard = test_actor(
        "auto-guard-01",
        "Auto Guard",
        "agent_player",
        CellSnapshot::new(52, 34),
        "front",
    );
    guard.career_goal_id = Some("ranged_specialist".to_owned());
    snapshot.actors.push(guard);

    let mut state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    grant_test_profession(
        &mut state,
        "auto-guard-01",
        AuthorityProfessionKind::Marksman,
    );
    state
        .award_profession_track_xp(
            "auto-guard-01",
            AuthorityProfessionKind::Marksman,
            "rifle",
            2_000,
        )
        .unwrap();
    let interval = u64::from(state.tick_rate_hz.max(1));
    state.tick = interval;
    state.tick_auto_train_player_like_pawns();

    let actor = state
        .actors
        .get("auto-guard-01")
        .expect("auto guard exists");
    assert!(actor.professions.has_skill_box("marksman-rifle-i"));
    assert_eq!(
        actor
            .professions
            .track_xp_amount(AuthorityProfessionKind::Marksman, "rifle"),
        1_900
    );
    let breakdown = shot_spread_breakdown_for_actor(
        actor,
        weapon_profile(Some(AuthorityWeaponId::Slugthrower)),
        state.tick,
    );
    assert_eq!(breakdown.skill_reduction_milli, 500);
}

#[test]
fn authority_set_career_goal_respec_drops_only_non_target_boxes_and_charges_credits() {
    let config = SliceAuthorityConfig::default();
    let mut snapshot = crate::authority_test_slice();
    let mut trainer = test_actor(
        "profession-trainer-01",
        "Vela Orr",
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
    grant_test_profession(&mut state, &player, AuthorityProfessionKind::Marksman);
    {
        let actor = state.actors.get_mut(&player).expect("player exists");
        for skill_box_id in [
            "marksman-rifle-i",
            "marksman-rifle-ii",
            "marksman-rifle-iii",
            "marksman-rifle-iv",
            "marksman-pistol-i",
            "marksman-pistol-ii",
            "marksman-pistol-iii",
            "marksman-pistol-iv",
            "marksman-tactics-i",
            "marksman-tactics-ii",
            "marksman-tactics-iii",
            "marksman-tactics-iv",
            "marksman-fieldcraft-i",
            "marksman-fieldcraft-ii",
            "marksman-fieldcraft-iii",
            "marksman-fieldcraft-iv",
            "marksman-master",
        ] {
            actor
                .professions
                .skill_boxes
                .insert(skill_box_id.to_owned());
        }
        actor
            .professions
            .award_track_xp(AuthorityProfessionKind::Marksman, "rifle", 275);
    }
    let credits_before = state.actors.get(&player).unwrap().professions.credits;
    let profession_xp_before = state.actors[&player]
        .professions
        .xp
        .get(&AuthorityProfessionKind::Marksman)
        .copied()
        .unwrap_or_default();
    let pistol_xp_before = state.actors[&player]
        .professions
        .track_xp_amount(AuthorityProfessionKind::Marksman, "pistol");
    let tactics_xp_before = state.actors[&player]
        .professions
        .track_xp_amount(AuthorityProfessionKind::Marksman, "tactics");
    let removed_pistol_xp = [
        "marksman-pistol-i",
        "marksman-pistol-ii",
        "marksman-pistol-iii",
        "marksman-pistol-iv",
    ]
    .into_iter()
    .map(|skill_box_id| {
        authority_skill_box_definition(skill_box_id)
            .expect("pistol skill box exists")
            .xp_required
    })
    .sum::<u64>();
    let removed_tactics_xp = [
        "marksman-tactics-i",
        "marksman-tactics-ii",
        "marksman-tactics-iii",
        "marksman-tactics-iv",
    ]
    .into_iter()
    .map(|skill_box_id| {
        authority_skill_box_definition(skill_box_id)
            .expect("tactics skill box exists")
            .xp_required
    })
    .sum::<u64>();
    let removed_master_xp = authority_skill_box_definition("marksman-master")
        .expect("master skill box exists")
        .xp_required;
    assert_eq!(
        state
            .actors
            .get(&player)
            .unwrap()
            .professions
            .skill_points_used(),
        97
    );

    let respec = state.apply_envelope(
        &config,
        command(
            1,
            ClientCommand::SetCareerGoal {
                goal_id: "rifle_utility".to_owned(),
                trainer_actor_id: "profession-trainer-01".to_owned(),
            },
        ),
    );
    assert_eq!(
        respec.status,
        AuthorityCommandStatus::Accepted,
        "respec: {:?}",
        respec.reason_code
    );
    let actor = state.actors.get(&player).expect("player exists");
    assert_eq!(actor.career_goal_id.as_deref(), Some("rifle_utility"));
    assert!(actor.professions.has_skill_box("marksman-rifle-iv"));
    assert!(actor.professions.has_skill_box("marksman-fieldcraft-iv"));
    assert!(!actor.professions.has_skill_box("marksman-pistol-i"));
    assert!(!actor.professions.has_skill_box("marksman-tactics-iv"));
    assert!(!actor.professions.has_skill_box("marksman-master"));
    assert_eq!(actor.professions.skill_points_used(), 56);
    assert_eq!(
        actor
            .professions
            .track_xp_amount(AuthorityProfessionKind::Marksman, "rifle"),
        275
    );
    assert_eq!(
        actor.professions.xp[&AuthorityProfessionKind::Marksman],
        profession_xp_before
            .saturating_add(removed_pistol_xp)
            .saturating_add(removed_tactics_xp)
            .saturating_add(removed_master_xp),
        "bulk career respec restores every removed box's general XP cost"
    );
    assert_eq!(
        actor
            .professions
            .track_xp_amount(AuthorityProfessionKind::Marksman, "pistol"),
        pistol_xp_before.saturating_add(removed_pistol_xp),
        "bulk career respec restores removed pistol-box XP to its exact track"
    );
    assert_eq!(
        actor
            .professions
            .track_xp_amount(AuthorityProfessionKind::Marksman, "tactics"),
        tactics_xp_before.saturating_add(removed_tactics_xp),
        "bulk career respec restores removed tactics-box XP to its exact track"
    );
    assert_eq!(actor.professions.credits, credits_before - 1_400);
}

#[test]
fn authority_actor_professions_do_not_seed_from_readable_actor_ids() {
    let mut snapshot = crate::authority_test_slice();
    snapshot.actors.push(test_actor(
        "medic-scout-readable-id-compat",
        "Readable Id Should Not Grant",
        "agent_player",
        CellSnapshot::new(11, 9),
        "front",
    ));

    let state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    let actor = state
        .actors
        .get("medic-scout-readable-id-compat")
        .expect("content actor exists");
    assert!(
        !actor_has_profession(actor, AuthorityProfessionKind::Medic),
        "actor ids must not grant medic profession authority"
    );
    assert!(
        !actor_has_profession(actor, AuthorityProfessionKind::Scout),
        "actor ids must not grant scout profession authority"
    );
    assert!(
        !actor_has_profession(actor, AuthorityProfessionKind::Marksman),
        "actor ids must not grant Marksman profession authority"
    );
    assert!(
        !actor_has_capability(actor, AUTHORITY_CAPABILITY_CRAFT_MEDICINE),
        "profession-derived capabilities must require explicit profession ids"
    );
    assert!(
        !actor_has_capability(actor, AUTHORITY_CAPABILITY_COMBAT_RANGED_BASIC),
        "Marksman combat capabilities must require explicit profession ids or capability grants"
    );
}

#[test]
fn authority_actor_unknown_profession_ids_are_rejected_from_snapshot_content() {
    let mut snapshot = crate::authority_test_slice();
    let mut actor = test_actor(
        "content-worker-invalid-profession",
        "Content Worker",
        "agent_player",
        CellSnapshot::new(12, 9),
        "front",
    );
    actor.profession_ids = vec!["scrapper".to_owned()];
    snapshot.actors.push(actor);

    let error = SliceAuthorityState::from_snapshot(&snapshot).unwrap_err();
    assert_eq!(
        error,
        SliceAuthorityBuildError::UnknownActorProfessionId {
            actor_id: "content-worker-invalid-profession".to_owned(),
            profession_id: "scrapper".to_owned(),
        }
    );
}

#[test]
fn authority_actor_unknown_career_goal_ids_are_rejected_from_snapshot_content() {
    let mut snapshot = crate::authority_test_slice();
    let mut actor = test_actor(
        "content-worker-invalid-career-goal",
        "Content Worker",
        "agent_player",
        CellSnapshot::new(12, 10),
        "front",
    );
    actor.career_goal_id = Some("sage-fisherman".to_owned());
    snapshot.actors.push(actor);

    let error = SliceAuthorityState::from_snapshot(&snapshot).unwrap_err();
    assert_eq!(
        error,
        SliceAuthorityBuildError::UnknownActorCareerGoalId {
            actor_id: "content-worker-invalid-career-goal".to_owned(),
            career_goal_id: "sage_fisherman".to_owned(),
        }
    );
}

#[test]
fn authority_population_unknown_career_goal_ids_are_rejected_from_snapshot_content() {
    let mut snapshot = crate::authority_test_slice();
    snapshot
        .population_templates
        .push(crate::PopulationTemplateSnapshot {
            id: "invalid-career-population".to_owned(),
            label_prefix: "Invalid Career".to_owned(),
            labels: vec!["Invalid Career".to_owned()],
            role: "agent_player".to_owned(),
            faction_id: None,
            social_group: None,
            pvp_status: None,
            player_organization_id: None,
            player_organization_tag: None,
            profession_ids: Vec::new(),
            skill_box_ids: Vec::new(),
            credits: None,
            capabilities: Vec::new(),
            career_goal_id: Some("sage-fisherman".to_owned()),
            sprite: "adventurer-premium-male".to_owned(),
            pose_set: "idle".to_owned(),
            direction: "front".to_owned(),
            scale: None,
            vitals: None,
            max_vitals: None,
        });

    let error = SliceAuthorityState::from_snapshot(&snapshot).unwrap_err();
    assert_eq!(
        error,
        SliceAuthorityBuildError::UnknownPopulationCareerGoalId {
            template_id: "invalid-career-population".to_owned(),
            career_goal_id: "sage_fisherman".to_owned(),
        }
    );
}

#[test]
fn authority_combat_slot_position_does_not_fallback_to_illegal_rally() {
    let mut snapshot = crate::authority_test_slice();
    snapshot.actors.clear();
    snapshot.npc_jobs.clear();
    snapshot.factions.clear();

    let mut actor = test_actor(
        "slot-agent",
        "Slot Agent",
        "agent_player",
        CellSnapshot::new(5, 5),
        "right",
    );
    actor.social_group = Some("slotters".to_owned());
    snapshot.actors.push(actor);
    let state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    let actor = state.actors.get("slot-agent").unwrap();
    let destination = AuthorityPosition {
        x: 20_000,
        y: 20_000,
    };
    let slot_distance = AI_ACTOR_BODY_SEPARATION_MILLI_CELLS
        .saturating_mul(2)
        .max(MILLI_CELLS_PER_CELL);
    let mut claims = vec![SkirmisherPositionClaim {
        actor_id: "claim-raw".to_owned(),
        area_id: actor.area_id.clone(),
        position: destination,
    }];
    for (index, (dx, dy)) in [
        (slot_distance, 0),
        (0, slot_distance),
        (-slot_distance, 0),
        (0, -slot_distance),
        (slot_distance, slot_distance),
        (-slot_distance, slot_distance),
        (-slot_distance, -slot_distance),
        (slot_distance, -slot_distance),
    ]
    .into_iter()
    .enumerate()
    {
        claims.push(SkirmisherPositionClaim {
            actor_id: format!("claim-{index}"),
            area_id: actor.area_id.clone(),
            position: AuthorityPosition {
                x: destination.x.saturating_add(dx),
                y: destination.y.saturating_add(dy),
            },
        });
    }

    let selected =
        state.combat_slot_position(actor, destination, None, &SkirmisherReservations { claims });

    assert_eq!(
        selected, actor.position,
        "when every rally slot is unavailable, selector should keep the current legal position instead of claiming raw rally"
    );
}

#[test]
fn authority_split_stack_validates_edges_and_exchange_capacity() {
    let cfg = SliceAuthorityConfig::default();
    let mut state = SliceAuthorityState::from_snapshot(&crate::authority_test_slice()).unwrap();
    let container = "player:resource-crate";
    state.inventory.clear();
    state.inventory_stack_counters.clear();

    let source = push_test_inventory_stack(
        &mut state,
        container,
        RESOURCE_MINERAL_ITEM_ID,
        7,
        RESOURCE_STACK_CAP,
    );
    state
        .apply_split_stack(
            &cfg,
            container,
            &source.to_string(),
            RESOURCE_MINERAL_ITEM_ID,
            7,
            1,
        )
        .unwrap();
    let quantities = state
        .inventory_snapshots()
        .into_iter()
        .filter(|row| row.container == container && row.item_id == RESOURCE_MINERAL_ITEM_ID)
        .map(|row| row.quantity)
        .collect::<Vec<_>>();
    assert_eq!(quantities, vec![RESOURCE_STACK_CAP - 1, 1]);

    state.inventory.clear();
    state.inventory_stack_counters.clear();
    let source = push_test_inventory_stack(
        &mut state,
        container,
        RESOURCE_MINERAL_ITEM_ID,
        7,
        RESOURCE_STACK_CAP,
    );
    state
        .apply_split_stack(
            &cfg,
            container,
            &source.to_string(),
            RESOURCE_MINERAL_ITEM_ID,
            7,
            RESOURCE_STACK_CAP - 1,
        )
        .unwrap();
    let quantities = state
        .inventory_snapshots()
        .into_iter()
        .filter(|row| row.container == container && row.item_id == RESOURCE_MINERAL_ITEM_ID)
        .map(|row| row.quantity)
        .collect::<Vec<_>>();
    assert_eq!(quantities, vec![1, RESOURCE_STACK_CAP - 1]);

    assert_eq!(
        state.apply_split_stack(
            &cfg,
            container,
            &source.to_string(),
            RESOURCE_MINERAL_ITEM_ID,
            7,
            0,
        ),
        Err(AuthorityRejectReason::ItemUnavailable)
    );
    assert_eq!(
        state.apply_split_stack(
            &cfg,
            container,
            &source.to_string(),
            RESOURCE_MINERAL_ITEM_ID,
            7,
            1,
        ),
        Err(AuthorityRejectReason::ItemUnavailable)
    );

    let mut snapshot = crate::authority_test_slice();
    let player_cell = snapshot
        .actors
        .iter()
        .find(|actor| actor.id == cfg.player_actor_id)
        .map(|actor| actor.cell.clone())
        .expect("demo player exists");
    snapshot.props.push(test_exchange_prop(player_cell));
    let mut full_exchange = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    full_exchange.inventory.clear();
    full_exchange.inventory_stack_counters.clear();
    for variant_id in 0..EXCHANGE_CONTAINER_SLOTS {
        push_test_inventory_stack(
            &mut full_exchange,
            EXCHANGE_CONTAINER,
            STIMPAK_A_ITEM_ID,
            u32::try_from(variant_id).unwrap(),
            2,
        );
    }
    let full_source = full_exchange.inventory_snapshots()[0].stack_id;
    assert_eq!(
        full_exchange.apply_split_stack(
            &cfg,
            EXCHANGE_CONTAINER,
            &full_source.to_string(),
            STIMPAK_A_ITEM_ID,
            0,
            1,
        ),
        Err(AuthorityRejectReason::ContainerFull)
    );
}

#[test]
fn credit_chip_redeem_banks_quantity_as_credits_and_consumes_stack() {
    let cfg = SliceAuthorityConfig::default();
    let mut state = SliceAuthorityState::from_snapshot(&crate::authority_test_slice()).unwrap();
    state.inventory.clear();
    state.inventory_stack_counters.clear();
    let container = "player:field-pack";
    let stack = push_test_inventory_stack(&mut state, container, CREDIT_CHIP_ITEM_ID, 0, 5_000);
    let before = state.actors.get("player").unwrap().professions.credits;

    state
        .apply_redeem_credit_chip(&cfg, container, &stack.to_string())
        .expect("redeem accepts an owned chip");

    assert_eq!(
        state.actors.get("player").unwrap().professions.credits,
        before + 5_000,
        "the chip's quantity is banked into the credit balance"
    );
    assert!(
        !state
            .inventory
            .iter()
            .any(|row| row.item_id == CREDIT_CHIP_ITEM_ID),
        "the redeemed chip stack is consumed"
    );
}

#[test]
fn credit_chip_redeem_rejects_non_chip_reserved_and_loot_containers() {
    let cfg = SliceAuthorityConfig::default();
    let mut state = SliceAuthorityState::from_snapshot(&crate::authority_test_slice()).unwrap();
    state.inventory.clear();
    state.inventory_stack_counters.clear();
    let container = "player:field-pack";

    // A non-chip stack never redeems.
    let bandage = push_test_inventory_stack(&mut state, container, FIELD_BANDAGE_ITEM_ID, 0, 3);
    assert_eq!(
        state.apply_redeem_credit_chip(&cfg, container, &bandage.to_string()),
        Err(AuthorityRejectReason::ItemUnavailable),
        "only Credit Chips redeem"
    );

    // A reserved chip (mid-trade escrow) is off-limits.
    let reserved_chip =
        push_test_inventory_stack(&mut state, container, CREDIT_CHIP_ITEM_ID, 0, 900);
    if let Some(row) = state
        .inventory
        .iter_mut()
        .find(|row| row.stack_id == reserved_chip)
    {
        row.reserved = 900;
        row.available = 0;
    }
    let before = state.actors.get("player").unwrap().professions.credits;
    assert_eq!(
        state.apply_redeem_credit_chip(&cfg, container, &reserved_chip.to_string()),
        Err(AuthorityRejectReason::ItemUnavailable),
        "a reserved chip cannot be redeemed out from under a trade"
    );
    assert_eq!(
        state.actors.get("player").unwrap().professions.credits,
        before,
        "a rejected redeem never moves the balance"
    );

    // A chip in a read-only loot container is refused (take it first).
    let loot = push_test_inventory_stack(&mut state, "corpse:x", CREDIT_CHIP_ITEM_ID, 0, 10);
    assert_eq!(
        state.apply_redeem_credit_chip(&cfg, "corpse:x", &loot.to_string()),
        Err(AuthorityRejectReason::ItemUnavailable),
        "you redeem from your own pack, not from a corpse"
    );
}

#[test]
fn credit_chip_split_and_merge_preserve_value_under_the_billion_cap() {
    let cfg = SliceAuthorityConfig::default();
    let mut state = SliceAuthorityState::from_snapshot(&crate::authority_test_slice()).unwrap();
    state.inventory.clear();
    state.inventory_stack_counters.clear();
    let container = "player:field-pack";

    // Chip stack cap is one billion; splitting shears value off like any stack.
    assert_eq!(
        SliceAuthorityState::inventory_stack_cap_for_item(CREDIT_CHIP_ITEM_ID, 1),
        CREDIT_CHIP_STACK_CAP
    );
    let source = push_test_inventory_stack(&mut state, container, CREDIT_CHIP_ITEM_ID, 0, 1_000);
    state
        .apply_split_stack(
            &cfg,
            container,
            &source.to_string(),
            CREDIT_CHIP_ITEM_ID,
            0,
            250,
        )
        .expect("split a chip");
    let values: Vec<u32> = state
        .inventory
        .iter()
        .filter(|row| row.container == container && row.item_id == CREDIT_CHIP_ITEM_ID)
        .map(|row| row.quantity)
        .collect();
    assert_eq!(
        values.iter().sum::<u32>(),
        1_000,
        "split conserves total value"
    );
    assert!(values.contains(&250) && values.contains(&750));

    // Merge respects the 1e9 cap: a near-cap chip plus a large chip only pulls up
    // to the cap, leaving the remainder behind (identical to resource merges).
    state.inventory.clear();
    state.inventory_stack_counters.clear();
    let target = push_test_inventory_stack(
        &mut state,
        container,
        CREDIT_CHIP_ITEM_ID,
        0,
        CREDIT_CHIP_STACK_CAP - 100,
    );
    let src = push_test_inventory_stack(&mut state, container, CREDIT_CHIP_ITEM_ID, 0, 500);
    state
        .apply_merge_stacks(&cfg, container, &src.to_string(), &target.to_string())
        .expect("merge chips");
    let mut sorted: Vec<u32> = state
        .inventory
        .iter()
        .filter(|row| row.container == container && row.item_id == CREDIT_CHIP_ITEM_ID)
        .map(|row| row.quantity)
        .collect();
    sorted.sort_unstable();
    assert_eq!(
        sorted,
        vec![400, CREDIT_CHIP_STACK_CAP],
        "merge fills to the cap and leaves the 400-credit remainder"
    );
}

#[test]
fn credit_chip_redeem_is_deterministic_by_state_hash() {
    let cfg = SliceAuthorityConfig::default();
    let build = |value: u32| {
        let mut state = SliceAuthorityState::from_snapshot(&crate::authority_test_slice()).unwrap();
        state.inventory.clear();
        state.inventory_stack_counters.clear();
        let stack = push_test_inventory_stack(
            &mut state,
            "player:field-pack",
            CREDIT_CHIP_ITEM_ID,
            0,
            value,
        );
        state
            .apply_redeem_credit_chip(&cfg, "player:field-pack", &stack.to_string())
            .expect("redeem");
        state.stable_state_hash_hex()
    };
    assert_eq!(
        build(5_000),
        build(5_000),
        "identical redeems hash identically"
    );
    assert_ne!(
        build(5_000),
        build(4_999),
        "a different banked value changes the hash"
    );
}

#[test]
fn dropped_credit_chip_respects_loot_rights() {
    let (cfg, mut state) = take_loot_corpse_state();
    // A looted credit chip is a dropped chip: seed one on the corpse and lock
    // rights to another raider — the player cannot strip it.
    let corpse = "corpse:loot-trooper";
    push_test_inventory_stack(&mut state, corpse, CREDIT_CHIP_ITEM_ID, 0, 2_500);
    state
        .actors
        .get_mut("loot-trooper")
        .unwrap()
        .loot_rights_actor_id = Some("other-raider".to_owned());

    let take = ClientCommand::TakeLootItem {
        container: corpse.to_owned(),
        item_id: CREDIT_CHIP_ITEM_ID,
        variant_id: 0,
        quantity: 2_500,
    };
    assert_eq!(
        state.apply_take_loot_item(&cfg, corpse, CREDIT_CHIP_ITEM_ID, 0, 2_500),
        Err(AuthorityRejectReason::LootNoRights),
        "a chip on a rights-locked corpse is not the player's to take"
    );
    let _ = take;

    // Free the rights → the chip comes home, ready to redeem from the pack.
    state
        .actors
        .get_mut("loot-trooper")
        .unwrap()
        .loot_rights_actor_id = None;
    state
        .apply_take_loot_item(&cfg, corpse, CREDIT_CHIP_ITEM_ID, 0, 2_500)
        .expect("free-loot chip is takeable");
    assert_eq!(
        state.actor_inventory_available_quantity("player", CREDIT_CHIP_ITEM_ID),
        2_500,
        "the chip landed in the player pack"
    );
}

#[test]
fn authority_merge_stacks_caps_resource_remainder_and_exact_cap() {
    let cfg = SliceAuthorityConfig::default();
    let container = "player:resource-crate";
    let mut state = SliceAuthorityState::from_snapshot(&crate::authority_test_slice()).unwrap();
    state.inventory.clear();
    state.inventory_stack_counters.clear();
    let target =
        push_test_inventory_stack(&mut state, container, RESOURCE_MINERAL_ITEM_ID, 11, 90_000);
    let source =
        push_test_inventory_stack(&mut state, container, RESOURCE_MINERAL_ITEM_ID, 11, 20_000);
    state
        .apply_merge_stacks(&cfg, container, &source.to_string(), &target.to_string())
        .unwrap();
    let target_row = state
        .inventory_snapshots()
        .into_iter()
        .find(|row| row.stack_id == target)
        .unwrap();
    let source_row = state
        .inventory_snapshots()
        .into_iter()
        .find(|row| row.stack_id == source)
        .unwrap();
    assert_eq!(target_row.quantity, RESOURCE_STACK_CAP);
    assert_eq!(source_row.quantity, 10_000);

    state.inventory.clear();
    state.inventory_stack_counters.clear();
    let target =
        push_test_inventory_stack(&mut state, container, RESOURCE_MINERAL_ITEM_ID, 11, 80_000);
    let source =
        push_test_inventory_stack(&mut state, container, RESOURCE_MINERAL_ITEM_ID, 11, 20_000);
    state
        .apply_merge_stacks(&cfg, container, &source.to_string(), &target.to_string())
        .unwrap();
    let rows = state.inventory_snapshots();
    assert_eq!(
        rows.iter()
            .find(|row| row.stack_id == target)
            .map(|row| row.quantity),
        Some(RESOURCE_STACK_CAP)
    );
    assert!(
        rows.iter().all(|row| row.stack_id != source),
        "source stack should be removed on exact cap merge"
    );

    state.inventory.clear();
    state.inventory_stack_counters.clear();
    let target = push_test_inventory_stack(&mut state, container, RESOURCE_MINERAL_ITEM_ID, 11, 10);
    let source = push_test_inventory_stack(&mut state, container, RESOURCE_MINERAL_ITEM_ID, 12, 10);
    assert_eq!(
        state.apply_merge_stacks(&cfg, container, &source.to_string(), &target.to_string()),
        Err(AuthorityRejectReason::ItemUnavailable)
    );
}

#[test]
fn take_loot_item_cache_take_is_per_stack_and_partial() {
    let cfg = SliceAuthorityConfig::default();
    let player = cfg.player_actor_id.clone();
    let mut snapshot = crate::authority_test_slice();
    let player_cell = snapshot
        .actors
        .iter()
        .find(|actor| actor.id == player)
        .map(|actor| actor.cell.clone())
        .expect("demo player exists");
    snapshot
        .props
        .push(test_loot_cache_prop("open-desert-cache-test", player_cell));
    let mut state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    state.inventory.clear();
    state.inventory_stack_counters.clear();
    push_test_inventory_stack(
        &mut state,
        "player:field-pack",
        RESOURCE_MINERAL_ITEM_ID,
        7,
        2,
    );
    push_test_inventory_stack(
        &mut state,
        "cache:open-desert-cache-test",
        RESOURCE_MINERAL_ITEM_ID,
        7,
        3,
    );

    let take_two = state.apply_envelope(
        &cfg,
        command(
            1,
            ClientCommand::TakeLootItem {
                container: "cache:open-desert-cache-test".to_owned(),
                item_id: RESOURCE_MINERAL_ITEM_ID,
                variant_id: 7,
                quantity: 2,
            },
        ),
    );

    assert_eq!(take_two.status, AuthorityCommandStatus::Accepted);
    assert_eq!(
        state.actor_inventory_available_variant(&player, RESOURCE_MINERAL_ITEM_ID, 7),
        4
    );
    assert_eq!(
        available_in_container(
            &state,
            "cache:open-desert-cache-test",
            RESOURCE_MINERAL_ITEM_ID,
            7,
        ),
        1
    );
    assert!(
        !state
            .loot_caches
            .get("open-desert-cache-test")
            .expect("cache state exists")
            .emptied
    );

    let take_last = state.apply_envelope(
        &cfg,
        command(
            2,
            ClientCommand::TakeLootItem {
                container: "cache:open-desert-cache-test".to_owned(),
                item_id: RESOURCE_MINERAL_ITEM_ID,
                variant_id: 7,
                quantity: 1,
            },
        ),
    );

    assert_eq!(take_last.status, AuthorityCommandStatus::Accepted);
    assert_eq!(
        state.actor_inventory_available_variant(&player, RESOURCE_MINERAL_ITEM_ID, 7),
        5
    );
    assert_eq!(
        available_in_container(
            &state,
            "cache:open-desert-cache-test",
            RESOURCE_MINERAL_ITEM_ID,
            7,
        ),
        0
    );
    assert!(
        state
            .loot_caches
            .get("open-desert-cache-test")
            .expect("cache state exists")
            .emptied
    );
}

#[test]
fn loot_cache_uses_authored_container_identity_with_legacy_fallback() {
    let cfg = SliceAuthorityConfig::default();
    let player = cfg.player_actor_id.clone();
    let mut snapshot = crate::authority_test_slice();
    let player_cell = snapshot
        .actors
        .iter()
        .find(|actor| actor.id == player)
        .map(|actor| actor.cell.clone())
        .expect("demo player exists");
    let mut prop = test_loot_cache_prop("open-desert-footlocker-test", player_cell);
    prop.container = Some("footlocker:open-desert-footlocker-test".to_owned());
    snapshot.props.push(prop);

    let state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    assert_eq!(
        state
            .loot_caches
            .get("open-desert-footlocker-test")
            .expect("authored cache state exists")
            .container,
        "footlocker:open-desert-footlocker-test"
    );
}

#[test]
fn authored_footlocker_take_accepts_in_range_and_rejects_unknown_or_emptied() {
    let cfg = SliceAuthorityConfig::default();
    let player = cfg.player_actor_id.clone();
    let container = "footlocker:authored-footlocker-test";
    let mut snapshot = crate::authority_test_slice();
    let player_cell = snapshot
        .actors
        .iter()
        .find(|actor| actor.id == player)
        .map(|actor| actor.cell.clone())
        .expect("demo player exists");
    let mut prop = test_loot_cache_prop("authored-footlocker-test", player_cell);
    prop.container = Some(container.to_owned());
    snapshot.props.push(prop);
    let mut state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    state.inventory.clear();
    state.inventory_stack_counters.clear();
    push_test_inventory_stack(&mut state, container, RESOURCE_MINERAL_ITEM_ID, 7, 1);

    let accepted = state.apply_envelope(
        &cfg,
        command(
            1,
            ClientCommand::TakeLootItem {
                container: container.to_owned(),
                item_id: RESOURCE_MINERAL_ITEM_ID,
                variant_id: 7,
                quantity: 1,
            },
        ),
    );
    assert_eq!(accepted.status, AuthorityCommandStatus::Accepted);
    assert_eq!(
        state.actor_inventory_available_variant(&player, RESOURCE_MINERAL_ITEM_ID, 7),
        1
    );

    let duplicate = state.apply_envelope(
        &cfg,
        command(
            2,
            ClientCommand::TakeLootItem {
                container: container.to_owned(),
                item_id: RESOURCE_MINERAL_ITEM_ID,
                variant_id: 7,
                quantity: 1,
            },
        ),
    );
    assert_eq!(duplicate.status, AuthorityCommandStatus::Rejected);

    let unknown = state.apply_envelope(
        &cfg,
        command(
            3,
            ClientCommand::TakeLootItem {
                container: "footlocker:not-authored".to_owned(),
                item_id: RESOURCE_MINERAL_ITEM_ID,
                variant_id: 7,
                quantity: 1,
            },
        ),
    );
    assert_eq!(unknown.status, AuthorityCommandStatus::Rejected);
}

#[test]
fn authority_passive_creature_harvest_all_families_without_capability() {
    let cfg = SliceAuthorityConfig::default();
    let mut snapshot = roll_combat_test_snapshot();
    {
        let creature = snapshot
            .actors
            .iter_mut()
            .find(|actor| actor.id == "roll-target")
            .expect("target actor exists");
        creature.label = "Bellback Creature".to_owned();
        creature.role = "creature".to_owned();
        creature.sprite = "creature-bellback-adult".to_owned();
        creature.cell = CellSnapshot::new(11, 10);
        creature.vitals = Some(crate::ActorVitalsSnapshot {
            health: 60,
            action: 45,
            spirit: 40,
        });
        creature.max_vitals = creature.vitals;
    }
    let (_config, mut state) = roll_combat_test_state_from_snapshot(snapshot);
    state.inventory.clear();
    state.inventory_stack_counters.clear();
    clear_test_capabilities(&mut state, "player");
    {
        let creature = state.actors.get_mut("roll-target").unwrap();
        creature.life_state = AuthorityLifeState::Downed;
        creature.body_vanish_tick = 9_999;
        creature
            .gaia_harvest_entitled_actor_ids
            .insert("player".to_owned());
    }
    state.apply_harvest_corpse(&cfg, "roll-target").unwrap();

    let rows = state.inventory_snapshots();
    let owned_quantity = |item_id| {
        rows.iter()
            .filter(|row| row.container.starts_with("player:") && row.item_id == item_id)
            .map(|row| row.quantity)
            .sum::<u32>()
    };
    for item_id in [
        RESOURCE_CREATURE_MEAT_ITEM_ID,
        RESOURCE_CREATURE_BONE_ITEM_ID,
        RESOURCE_CREATURE_HIDE_ITEM_ID,
    ] {
        assert!(owned_quantity(item_id) >= 5);
    }
    let bone = rows
        .iter()
        .find(|row| {
            row.container.starts_with("player:") && row.item_id == RESOURCE_CREATURE_BONE_ITEM_ID
        })
        .expect("bone row");
    assert!(bone.item.contains("Bellback bone"));
    let creature = state.actors.get("roll-target").unwrap();
    assert_eq!(creature.life_state, AuthorityLifeState::Downed);
    assert_eq!(creature.corpse_exhausted_tick, Some(state.tick()));
    assert_eq!(
        creature.body_vanish_tick,
        state.tick() + CREATURE_CORPSE_EXHAUSTED_LINGER_TICKS
    );
    assert_eq!(creature.respawn_tick, 0);
}

#[test]
fn authority_direct_craftsman_training_does_not_issue_creation_tools() {
    let cfg = SliceAuthorityConfig::default();
    let player = cfg.player_actor_id.clone();
    let mut state = SliceAuthorityState::from_snapshot(&crate::authority_test_slice()).unwrap();
    clear_test_professions(&mut state, &player);
    state.inventory.clear();
    state.inventory_stack_counters.clear();
    let definition = authority_skill_box_definition("craftsman-novice").unwrap();

    state
        .train_skill_box_for_actor(&player, &definition)
        .expect("novice craftsman trains");
    state
        .train_skill_box_for_actor(&player, &definition)
        .expect("retraining path stays idempotent");

    assert_eq!(
        state.actor_inventory_available_quantity(&player, FIELD_MULTITOOL_ITEM_ID),
        0
    );
    assert_eq!(
        state.actor_inventory_available_quantity(&player, MINERAL_SURVEY_TOOL_ITEM_ID),
        0
    );
}

#[test]
fn authority_direct_brawler_training_does_not_issue_or_swap_a_creation_weapon() {
    let definition = authority_skill_box_definition("brawler-novice").expect("brawler novice");
    let player = "player";

    let mut equipped_state =
        SliceAuthorityState::from_snapshot(&crate::authority_test_slice()).unwrap();
    clear_test_professions(&mut equipped_state, player);
    equipped_state.inventory.clear();
    equipped_state.inventory_stack_counters.clear();
    push_test_inventory_stack(
        &mut equipped_state,
        "player:field-pack",
        CRAFTED_SLUGTHROWER_ITEM_ID,
        77,
        1,
    );
    {
        let actor = equipped_state.actors.get_mut(player).expect("player actor");
        actor.equipped_weapon_id = Some(AuthorityWeaponId::Slugthrower);
        actor.equipped_weapon_item_id = CRAFTED_SLUGTHROWER_ITEM_ID;
        actor.equipped_weapon_variant_id = 77;
    }
    equipped_state
        .train_skill_box_for_actor(player, &definition)
        .expect("pre-equipped brawler trains");
    let actor = equipped_state.actors.get(player).expect("player actor");
    assert_eq!(
        actor.equipped_weapon_id,
        Some(AuthorityWeaponId::Slugthrower)
    );
    assert_eq!(actor.equipped_weapon_item_id, CRAFTED_SLUGTHROWER_ITEM_ID);
    assert_eq!(actor.equipped_weapon_variant_id, 77);
    assert_eq!(
        equipped_state.actor_inventory_available_quantity(player, VIBROSWORD_WEAPON_ITEM_ID),
        0
    );
    assert_eq!(
        equipped_state.actor_inventory_available_quantity(player, SCRAPLINE_MACHETE_ITEM_ID),
        0,
        "learning later never reissues the one-time machete"
    );
    equipped_state
        .train_skill_box_for_actor(player, &definition)
        .expect("retraining stays idempotent");
    assert_eq!(
        equipped_state.actor_inventory_available_quantity(player, VIBROSWORD_WEAPON_ITEM_ID),
        0,
    );

    let mut unarmed_state =
        SliceAuthorityState::from_snapshot(&crate::authority_test_slice()).unwrap();
    clear_test_professions(&mut unarmed_state, player);
    unarmed_state.inventory.clear();
    unarmed_state.inventory_stack_counters.clear();
    {
        let actor = unarmed_state.actors.get_mut(player).expect("player actor");
        actor.equipped_weapon_id = None;
        actor.equipped_weapon_item_id = 0;
        actor.equipped_weapon_variant_id = 0;
    }
    unarmed_state
        .train_skill_box_for_actor(player, &definition)
        .expect("unarmed brawler trains");
    let actor = unarmed_state.actors.get(player).expect("player actor");
    assert_eq!(actor.equipped_weapon_id, None);
    assert_eq!(actor.equipped_weapon_item_id, 0);
    assert_eq!(actor.equipped_weapon_variant_id, 0);
    assert_eq!(
        unarmed_state.actor_inventory_available_quantity(player, VIBROSWORD_WEAPON_ITEM_ID),
        0
    );
    assert_eq!(
        unarmed_state.actor_inventory_available_quantity(player, SCRAPLINE_MACHETE_ITEM_ID),
        0
    );
}

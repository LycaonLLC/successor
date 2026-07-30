fn clone_respawn_command(facility_id: Option<&str>) -> ClientCommand {
    ClientCommand::CloneRespawn {
        facility_id: facility_id.map(str::to_owned),
    }
}

fn clone_respawn_facility(
    id: &str,
    label: &str,
    respawn_cell: CellSnapshot,
) -> crate::CloneFacilitySnapshot {
    crate::CloneFacilitySnapshot {
        id: id.to_owned(),
        label: label.to_owned(),
        area_id: crate::AUTHORITY_TEST_AREA_ID.to_owned(),
        respawn_cell,
        respawn_facing: "front".to_owned(),
        sickness_duration_ms: 30_000,
    }
}

fn two_facility_clone_respawn_state() -> (SliceAuthorityConfig, SliceAuthorityState) {
    let mut snapshot = crate::authority_test_slice();
    snapshot.clone_facilities = vec![
        clone_respawn_facility("clone-alpha", "Clone Alpha", CellSnapshot::new(4, 5)),
        clone_respawn_facility("clone-beta", "Clone Beta", CellSnapshot::new(34, 21)),
    ];
    let config = SliceAuthorityConfig::default();
    let mut state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    let tick = state.tick();
    let tick_rate_hz = state.tick_rate_hz;
    {
        let player = state.actors.get_mut("player").unwrap();
        player.area_id = crate::AUTHORITY_TEST_AREA_ID.to_owned();
        player.cell = AuthorityCell::new(33, 21);
        player.position = AuthorityPosition::from_cell(player.cell);
        SliceAuthorityState::kill_actor_for_respawn(tick, tick_rate_hz, player);
    }
    (config, state)
}
fn bank_clone_terminal_prop(id: &str, kind: &str, cell: CellSnapshot) -> PropSnapshot {
    PropSnapshot {
        id: id.to_owned(),
        entity: format!("terminal:{kind}"),
        area_id: crate::AUTHORITY_TEST_AREA_ID.to_owned(),
        label: id.to_owned(),
        kind: kind.to_owned(),
        cell,
        size: CellSizeSnapshot { w: 1, h: 1 },
        interactive: true,
        cover: None,
        collision_bounds: Vec::new(),
        door: None,
        container: None,
    }
}

fn bank_clone_test_state() -> (
    SliceAuthorityConfig,
    SliceAuthorityConfig,
    SliceAuthorityState,
) {
    let mut snapshot = crate::authority_test_slice();
    snapshot.actors.clear();
    snapshot.npc_jobs.clear();
    snapshot.inventory.clear();
    snapshot.actors.push(test_actor(
        "player",
        "Player",
        "player",
        CellSnapshot::new(10, 10),
        "right",
    ));
    snapshot.actors.push(test_actor(
        "looter",
        "Looter",
        "player",
        CellSnapshot::new(10, 10),
        "left",
    ));
    snapshot.clone_facilities = vec![clone_respawn_facility(
        "clone-alpha",
        "Clone Alpha",
        CellSnapshot::new(10, 10),
    )];
    snapshot.props.push(bank_clone_terminal_prop(
        "test-bank-terminal",
        "bank_terminal",
        CellSnapshot::new(10, 10),
    ));
    snapshot.props.push(bank_clone_terminal_prop(
        "test-clone-terminal",
        "clone_terminal",
        CellSnapshot::new(10, 10),
    ));
    let player_config = SliceAuthorityConfig::default();
    let looter_config = SliceAuthorityConfig {
        session: SessionId(2),
        player: PlayerId(2),
        player_actor_id: "looter".to_owned(),
        ..SliceAuthorityConfig::default()
    };
    (
        player_config,
        looter_config,
        SliceAuthorityState::from_snapshot(&snapshot).unwrap(),
    )
}
#[test]
fn authority_bank_roundtrip_persists_items_credits_and_terminals() {
    let (config, _, mut state) = bank_clone_test_state();
    let source_stack_id = push_test_inventory_stack(
        &mut state,
        "player:field-pack",
        FIELD_BANDAGE_ITEM_ID,
        17,
        5,
    );
    state.actors.get_mut("player").unwrap().professions.credits = 2_000;

    let stored = state.apply_envelope(
        &config,
        command_for(
            &config,
            1,
            ClientCommand::BankStoreItem {
                source_stack_id: source_stack_id.to_string(),
                quantity: 3,
            },
        ),
    );
    let deposited = state.apply_envelope(
        &config,
        command_for(
            &config,
            2,
            ClientCommand::BankDepositCredits { amount: 700 },
        ),
    );
    assert_eq!(stored.status, AuthorityCommandStatus::Accepted);
    assert_eq!(deposited.status, AuthorityCommandStatus::Accepted);
    assert_eq!(state.actors["player"].professions.credits, 1_300);
    let bank_before = state.bank_snapshot_for_observer(&config).unwrap();
    assert_eq!(bank_before.bank_credits, 700);
    assert_eq!(bank_before.items.len(), 1);
    assert_eq!(bank_before.items[0].quantity, 3);
    assert_eq!(
        state
            .inventory
            .iter()
            .find(|row| { row.container == "player:field-pack" && row.stack_id == source_stack_id })
            .unwrap()
            .quantity,
        2
    );

    let blob = state.export_checkpoint();
    assert_eq!(blob.version(), 1);
    let mut restored = restore_checkpoint_for_test(&state, blob);
    assert!(restored
        .terminals
        .iter()
        .any(|terminal| terminal.id == "test-bank-terminal"));
    let bank_stack_id = restored.bank_snapshot_for_observer(&config).unwrap().items[0]
        .stack_id
        .to_string();
    let retrieved = restored.apply_envelope(
        &config,
        command_for(
            &config,
            3,
            ClientCommand::BankRetrieveItem {
                bank_stack_id,
                quantity: 2,
            },
        ),
    );
    let withdrawn = restored.apply_envelope(
        &config,
        command_for(
            &config,
            4,
            ClientCommand::BankWithdrawCredits { amount: 200 },
        ),
    );
    assert_eq!(retrieved.status, AuthorityCommandStatus::Accepted);
    assert_eq!(withdrawn.status, AuthorityCommandStatus::Accepted);
    let bank_after = restored.bank_snapshot_for_observer(&config).unwrap();
    assert_eq!(bank_after.bank_credits, 500);
    assert_eq!(bank_after.items[0].quantity, 1);
    assert_eq!(restored.actors["player"].professions.credits, 1_500);
}

#[test]
fn authority_rejected_bank_credit_commands_do_not_create_accounts() {
    let (config, _, mut state) = bank_clone_test_state();
    state.bank_accounts.remove("player");
    state.actors.get_mut("player").unwrap().professions.credits = 5;

    assert_eq!(
        state.apply_bank_deposit_credits(&config, 6),
        Err(AuthorityRejectReason::InsufficientCredits)
    );
    assert!(!state.bank_accounts.contains_key("player"));
    assert_eq!(state.actors["player"].professions.credits, 5);

    assert_eq!(
        state.apply_bank_withdraw_credits(&config, 1),
        Err(AuthorityRejectReason::InsufficientCredits)
    );
    assert!(!state.bank_accounts.contains_key("player"));
    assert_eq!(state.actors["player"].professions.credits, 5);
}

#[test]
fn authority_bank_rejects_storing_the_equipped_weapon_fingerprint() {
    let (config, _, mut state) = bank_clone_test_state();
    let stack_id = push_test_inventory_stack(
        &mut state,
        "player:field-pack",
        VIBROSWORD_WEAPON_ITEM_ID,
        17,
        1,
    );
    {
        let player = state.actors.get_mut("player").unwrap();
        player.equipped_weapon_id = Some(AuthorityWeaponId::Vibrosword);
        player.equipped_weapon_item_id = VIBROSWORD_WEAPON_ITEM_ID;
        player.equipped_weapon_variant_id = 17;
    }

    let rejected = state.apply_envelope(
        &config,
        command_for(
            &config,
            1,
            ClientCommand::BankStoreItem {
                source_stack_id: stack_id.to_string(),
                quantity: 1,
            },
        ),
    );

    assert_eq!(rejected.status, AuthorityCommandStatus::Rejected);
    assert_eq!(rejected.reason_code.as_deref(), Some("bank_stack_missing"));
    assert!(state
        .inventory
        .iter()
        .any(|row| row.stack_id == stack_id && row.container == "player:field-pack"));
    assert!(state
        .bank_snapshot_for_observer(&config)
        .unwrap()
        .items
        .is_empty());
}

#[test]
fn authority_bank_store_reconciles_the_last_exact_clothing_row() {
    let (config, _, mut state) = bank_clone_test_state();
    let container = "player:field-pack";
    let variant_id = 60_000_105;
    let stack_id = push_test_inventory_stack(&mut state, container, 7_201, variant_id, 1);
    state
        .actors
        .get_mut("player")
        .expect("player actor")
        .worn_colors
        .insert("top_frayed_tunic".to_owned(), vec!["#765432".to_owned()]);
    let equipped = state.apply_live_envelope(
        &config,
        command_for(
            &config,
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
    assert_eq!(state.actors["player"].equipped_clothing.len(), 1);

    let stored = state.apply_live_envelope(
        &config,
        command_for(
            &config,
            2,
            ClientCommand::BankStoreItem {
                source_stack_id: stack_id.to_string(),
                quantity: 1,
            },
        ),
    );
    assert_eq!(stored.status, AuthorityCommandStatus::Accepted);
    assert!(state.actors["player"].equipped_clothing.is_empty());
    assert!(state.actors["player"].worn.is_empty());
    assert!(state.inventory.iter().any(|row| {
        row.container == "bank:player"
            && row.item_id == 7_201
            && row.variant_id == variant_id
            && row.quantity == 1
    }));
}

#[test]
fn authority_fixed_starter_clothing_rejects_bank_discard_and_both_trade_sides() {
    let (config, _, mut bank_state) = bank_clone_test_state();
    bank_state.ensure_fixed_player_starter_clothing("player");
    bank_state.reconcile_actor_clothing("player");
    let bodysuit = bank_state
        .inventory
        .iter()
        .find(|row| row.container == "player:field-pack" && row.item_id == 9_900_001)
        .expect("fixed bodysuit row")
        .clone();
    let boots = bank_state
        .inventory
        .iter()
        .find(|row| row.container == "player:field-pack" && row.item_id == 7_319)
        .expect("fixed boots row")
        .clone();
    let before_bank_hash = bank_state.stable_state_hash_hex();

    let bank_rejected = bank_state.apply_live_envelope(
        &config,
        command_for(
            &config,
            1,
            ClientCommand::BankStoreItem {
                source_stack_id: bodysuit.stack_id.to_string(),
                quantity: 1,
            },
        ),
    );
    assert_eq!(bank_rejected.status, AuthorityCommandStatus::Rejected);
    assert_eq!(
        bank_rejected.reason_code.as_deref(),
        Some(AuthorityRejectReason::ItemUnavailable.code())
    );
    assert_eq!(bank_state.stable_state_hash_hex(), before_bank_hash);

    let discard_rejected = bank_state.apply_live_envelope(
        &config,
        command_for(
            &config,
            2,
            ClientCommand::DiscardStack {
                container: boots.container.clone(),
                stack_id: boots.stack_id.to_string(),
                item_id: boots.item_id,
                variant_id: boots.variant_id,
            },
        ),
    );
    assert_eq!(discard_rejected.status, AuthorityCommandStatus::Rejected);
    assert_eq!(
        discard_rejected.reason_code.as_deref(),
        Some(AuthorityRejectReason::ItemUnavailable.code())
    );
    assert_eq!(bank_state.stable_state_hash_hex(), before_bank_hash);

    let (mut trade_state, cfg_p, _cfg_q, proposer, partner, _home) = trade_pair_state();
    trade_state.ensure_fixed_player_starter_clothing(&proposer);
    trade_state.ensure_fixed_player_starter_clothing(&partner);
    trade_state.reconcile_actor_clothing(&proposer);
    trade_state.reconcile_actor_clothing(&partner);
    let before_trade_hash = trade_state.stable_state_hash_hex();
    for (command_id, offer, request) in [
        (
            1,
            vec![TradeItemSpec {
                item_id: 9_900_001,
                variant_id: 0,
                quantity: 1,
            }],
            Vec::new(),
        ),
        (
            2,
            Vec::new(),
            vec![TradeItemSpec {
                item_id: 7_319,
                variant_id: 0,
                quantity: 1,
            }],
        ),
    ] {
        let rejected = trade_state.apply_live_envelope(
            &cfg_p,
            command_for(
                &cfg_p,
                command_id,
                ClientCommand::ProposeTrade {
                    partner_actor_id: partner.clone(),
                    offer,
                    request,
                },
            ),
        );
        assert_eq!(rejected.status, AuthorityCommandStatus::Rejected);
        assert_eq!(
            rejected.reason_code.as_deref(),
            Some(AuthorityRejectReason::ItemUnavailable.code())
        );
        assert_eq!(trade_state.stable_state_hash_hex(), before_trade_hash);
        assert!(trade_state.trade_proposals.is_empty());
    }
}

#[test]
fn authority_bank_capacity_allows_matching_merge_and_preserves_reservations() {
    let (config, _, mut state) = bank_clone_test_state();
    for item_offset in 0..100 {
        push_test_inventory_stack(
            &mut state,
            "bank:player",
            800_000 + u32::try_from(item_offset).unwrap(),
            u32::try_from(item_offset).unwrap(),
            1,
        );
    }
    let merge_stack_id = push_test_inventory_stack(&mut state, "player:field-pack", 800_000, 0, 10);
    let merge_source = state
        .inventory
        .iter_mut()
        .find(|row| row.container == "player:field-pack" && row.stack_id == merge_stack_id)
        .unwrap();
    merge_source.reserved = 3;
    merge_source.available = 7;

    let merged = state.apply_envelope(
        &config,
        command_for(
            &config,
            1,
            ClientCommand::BankStoreItem {
                source_stack_id: merge_stack_id.to_string(),
                quantity: 7,
            },
        ),
    );
    assert_eq!(merged.status, AuthorityCommandStatus::Accepted);
    let merge_source = state
        .inventory
        .iter()
        .find(|row| row.container == "player:field-pack" && row.stack_id == merge_stack_id)
        .unwrap();
    assert_eq!(
        (
            merge_source.quantity,
            merge_source.reserved,
            merge_source.available
        ),
        (3, 3, 0)
    );
    assert_eq!(
        state
            .inventory
            .iter()
            .filter(|row| row.container == "bank:player" && row.quantity > 0)
            .count(),
        100
    );

    let unique_stack_id =
        push_test_inventory_stack(&mut state, "player:field-pack", 999_999, 77, 1);
    let rejected = state.apply_envelope(
        &config,
        command_for(
            &config,
            2,
            ClientCommand::BankStoreItem {
                source_stack_id: unique_stack_id.to_string(),
                quantity: 1,
            },
        ),
    );
    assert_eq!(rejected.status, AuthorityCommandStatus::Rejected);
    assert_eq!(rejected.reason_code.as_deref(), Some("bank_capacity"));
    assert_eq!(
        state
            .inventory
            .iter()
            .find(|row| { row.container == "player:field-pack" && row.stack_id == unique_stack_id })
            .unwrap()
            .quantity,
        1
    );
}

#[test]
fn authority_bank_is_owner_scoped_and_requires_terminal_range() {
    let (player_config, looter_config, mut state) = bank_clone_test_state();
    let bank_stack_id =
        push_test_inventory_stack(&mut state, "bank:player", FIELD_BANDAGE_ITEM_ID, 0, 1);
    move_actor_to_cell_for_test(&mut state, "looter", AuthorityCell::new(20, 20));
    let out_of_range = state.apply_envelope(
        &looter_config,
        command_for(
            &looter_config,
            1,
            ClientCommand::BankDepositCredits { amount: 1 },
        ),
    );
    assert_eq!(out_of_range.status, AuthorityCommandStatus::Rejected);
    assert_eq!(
        out_of_range.reason_code.as_deref(),
        Some("not_at_bank_terminal")
    );

    move_actor_to_cell_for_test(&mut state, "looter", AuthorityCell::new(10, 10));
    let foreign = state.apply_envelope(
        &looter_config,
        command_for(
            &looter_config,
            2,
            ClientCommand::BankRetrieveItem {
                bank_stack_id: bank_stack_id.to_string(),
                quantity: 1,
            },
        ),
    );
    assert_eq!(foreign.status, AuthorityCommandStatus::Rejected);
    assert_eq!(foreign.reason_code.as_deref(), Some("bank_stack_missing"));
    assert_eq!(
        state
            .bank_snapshot_for_observer(&player_config)
            .unwrap()
            .items
            .len(),
        1
    );
    assert!(state
        .bank_snapshot_for_observer(&looter_config)
        .unwrap()
        .items
        .is_empty());
}

#[test]
fn authority_skill_backup_spends_bank_first_and_is_atomic_on_insufficient_funds() {
    let (config, _, mut state) = bank_clone_test_state();
    {
        let actor = state.actors.get_mut("player").unwrap();
        actor
            .professions
            .skill_boxes
            .insert("marksman-novice".to_owned());
        actor.professions.active_title_id = Some("marksman-novice".to_owned());
        actor.professions.credits = 500;
    }
    state.bank_accounts.get_mut("player").unwrap().bank_credits = 700;

    let saved = state.apply_envelope(
        &config,
        command_for(&config, 1, ClientCommand::CloneSaveSkillBackup {}),
    );
    assert_eq!(saved.status, AuthorityCommandStatus::Accepted);
    assert_eq!(state.bank_accounts["player"].bank_credits, 0);
    assert_eq!(state.actors["player"].professions.credits, 200);
    let paid_backup = state.bank_accounts["player"].skill_backup.clone().unwrap();
    assert!(paid_backup.skill_boxes.contains("marksman-novice"));

    state.bank_accounts.get_mut("player").unwrap().bank_credits = 100;
    state.actors.get_mut("player").unwrap().professions.credits = 899;
    state
        .actors
        .get_mut("player")
        .unwrap()
        .professions
        .skill_boxes
        .insert("brawler-novice".to_owned());
    let rejected = state.apply_envelope(
        &config,
        command_for(&config, 2, ClientCommand::CloneSaveSkillBackup {}),
    );
    assert_eq!(rejected.status, AuthorityCommandStatus::Rejected);
    assert_eq!(
        rejected.reason_code.as_deref(),
        Some("insufficient_credits")
    );
    assert_eq!(state.bank_accounts["player"].bank_credits, 100);
    assert_eq!(state.actors["player"].professions.credits, 899);
    assert_eq!(
        state.bank_accounts["player"].skill_backup.as_ref().unwrap(),
        &paid_backup
    );
}
#[test]
fn authority_clone_rejects_alive_and_ordinary_incap_without_mutating_property() {
    let (config, _, mut state) = bank_clone_test_state();
    push_test_inventory_stack(&mut state, "player:field-pack", FIELD_BANDAGE_ITEM_ID, 0, 2);
    let inventory_before = state.inventory.clone();
    let wallet_before = state.actors["player"].professions.credits;

    let alive = state.apply_envelope(
        &config,
        command_for(&config, 1, clone_respawn_command(Some("clone-alpha"))),
    );
    assert_eq!(alive.status, AuthorityCommandStatus::Rejected);
    assert_eq!(alive.reason_code.as_deref(), Some("invalid_clone_respawn"));
    assert_eq!(state.inventory, inventory_before);
    assert_eq!(state.actors["player"].professions.credits, wallet_before);
    assert!(state.player_corpses.is_empty());

    {
        let tick = state.tick();
        let player = state.actors.get_mut("player").unwrap();
        SliceAuthorityState::set_actor_life_state(player, AuthorityLifeState::Downed);
        player.body_vanish_tick = 0;
        player.incap_expires_tick = tick.saturating_add(900);
    }
    let ordinary_incap = state.apply_envelope(
        &config,
        command_for(&config, 2, clone_respawn_command(Some("clone-alpha"))),
    );
    assert_eq!(ordinary_incap.status, AuthorityCommandStatus::Rejected);
    assert_eq!(
        ordinary_incap.reason_code.as_deref(),
        Some("invalid_clone_respawn")
    );
    assert_eq!(state.inventory, inventory_before);
    assert_eq!(state.actors["player"].professions.credits, wallet_before);
    assert!(state.player_corpses.is_empty());
}

#[test]
fn authority_lethal_clone_drops_carried_property_restores_backup_and_preserves_bank() {
    let (config, _, mut state) = bank_clone_test_state();
    let initial_backup = state.bank_accounts["player"].skill_backup.clone().unwrap();
    state.ensure_fixed_player_starter_clothing("player");
    push_test_inventory_stack(
        &mut state,
        "player:field-pack",
        FIELD_BANDAGE_ITEM_ID,
        41,
        3,
    );
    push_test_inventory_stack(&mut state, "bank:player", RESOURCE_CARBON_ITEM_ID, 88, 9);
    {
        let player = state.actors.get_mut("player").unwrap();
        player.professions.credits = 345;
        player
            .professions
            .skill_boxes
            .insert("brawler-novice".to_owned());
        player.professions.active_title_id = Some("brawler-novice".to_owned());
    }
    state.bank_accounts.get_mut("player").unwrap().bank_credits = 777;
    let death_tick = state.tick();
    let tick_rate_hz = state.tick_rate_hz;
    SliceAuthorityState::kill_actor_for_respawn(
        death_tick,
        tick_rate_hz,
        state.actors.get_mut("player").unwrap(),
    );

    let cloned = state.apply_envelope(
        &config,
        command_for(&config, 1, clone_respawn_command(Some("clone-alpha"))),
    );
    assert_eq!(cloned.status, AuthorityCommandStatus::Accepted);
    let player = &state.actors["player"];
    assert_eq!(player.life_state, AuthorityLifeState::Alive);
    assert_eq!(player.professions.credits, 0);
    assert_eq!(player.professions.learned, initial_backup.learned);
    assert_eq!(player.professions.xp, initial_backup.xp);
    assert_eq!(player.professions.track_xp, initial_backup.track_xp);
    assert_eq!(player.professions.skill_boxes, initial_backup.skill_boxes);
    assert_eq!(
        player.professions.active_title_id,
        initial_backup.active_title_id
    );
    assert_eq!(
        player.professions.skill_point_cap,
        initial_backup.skill_point_cap
    );
    assert_eq!(
        player.worn,
        vec![
            AuthorityActorWornPiece {
                item: "under_bodysuit".to_owned(),
                colors: vec!["#89cff0".to_owned()],
            },
            AuthorityActorWornPiece {
                item: "boots_canvas_ankle".to_owned(),
                colors: vec!["#303030".to_owned(), "#808080".to_owned()],
            },
        ]
    );
    assert!(player.equipped_weapon_id.is_none());
    let carried = state
        .inventory
        .iter()
        .filter(|row| actor_owns_inventory_container("player", &row.container))
        .collect::<Vec<_>>();
    assert_eq!(carried.len(), 2);
    assert_eq!(
        carried
            .iter()
            .map(|row| row.item.as_str())
            .collect::<Vec<_>>(),
        vec!["under_bodysuit", "boots_canvas_ankle"]
    );
    assert_eq!(
        carried.iter().map(|row| row.quantity).collect::<Vec<_>>(),
        vec![1, 1]
    );
    assert_eq!(state.bank_accounts["player"].bank_credits, 777);
    assert_eq!(
        state
            .inventory
            .iter()
            .find(|row| row.container == "bank:player")
            .unwrap()
            .quantity,
        9
    );
    let corpse = state.player_corpses.values().next().unwrap();
    assert_eq!(corpse.owner_actor_id, "player");
    assert_eq!(corpse.credits, 345);
    assert_eq!(
        corpse.expiry_tick,
        corpse.created_tick + 120 * 60 * u64::from(tick_rate_hz)
    );
    assert_eq!(
        state
            .inventory
            .iter()
            .find(|row| {
                row.container == corpse.container && row.item_id == FIELD_BANDAGE_ITEM_ID
            })
            .unwrap()
            .quantity,
        3
    );
    assert!(state.inventory.iter().all(|row| {
        row.container != corpse.container || !matches!(row.item_id, 9_900_001 | 7_319)
    }));
    assert!(state
        .inventory
        .iter()
        .all(|row| row.container != corpse.container || row.item_id != RESOURCE_CARBON_ITEM_ID));
}

#[test]
fn authority_lethal_respawn_deadline_uses_clone_death_drop() {
    let (config, _, mut state) = bank_clone_test_state();
    push_test_inventory_stack(
        &mut state,
        "player:field-pack",
        FIELD_BANDAGE_ITEM_ID,
        91,
        2,
    );
    state.actors.get_mut("player").unwrap().professions.credits = 345;
    let death_tick = state.tick();
    let tick_rate_hz = state.tick_rate_hz;
    SliceAuthorityState::kill_actor_for_respawn(
        death_tick,
        tick_rate_hz,
        state.actors.get_mut("player").unwrap(),
    );
    let respawn_tick = state.actors["player"].respawn_tick;

    state.tick = respawn_tick - 1;
    state.tick_respawn_lifecycle();
    assert_eq!(
        state.actors["player"].life_state,
        AuthorityLifeState::Respawning
    );
    assert!(state.player_corpses.is_empty());

    state.tick = respawn_tick;
    state.tick_respawn_lifecycle();
    assert_eq!(state.actors["player"].life_state, AuthorityLifeState::Alive);
    assert_eq!(state.actors["player"].professions.credits, 0);
    assert_eq!(state.player_corpses.len(), 1);
    let corpse = state.player_corpses.values().next().unwrap();
    assert_eq!(corpse.credits, 345);
    assert!(state
        .inventory
        .iter()
        .any(|row| row.container == corpse.container && row.item_id == FIELD_BANDAGE_ITEM_ID));
    let carried = state
        .inventory
        .iter()
        .filter(|row| actor_owns_inventory_container("player", &row.container))
        .collect::<Vec<_>>();
    assert_eq!(carried.len(), 2);
    assert_eq!(
        carried
            .iter()
            .map(|row| row.item.as_str())
            .collect::<Vec<_>>(),
        vec!["under_bodysuit", "boots_canvas_ankle"]
    );
    assert!(
        state
            .bank_snapshot_for_observer(&config)
            .unwrap()
            .backup_present
    );
}

fn assert_bridge_owner_bank_and_raw_corpse(value: &serde_json::Value) {
    assert_eq!(
        value
            .pointer("/playerCorpses")
            .and_then(serde_json::Value::as_array)
            .map(Vec::len),
        Some(2),
        "full bridge outputs must carry every live corpse, not observer AOI"
    );
    assert_eq!(
        value
            .pointer("/playerCorpses/1/ownerActorId")
            .and_then(serde_json::Value::as_str),
        Some("far-owner")
    );
    assert_eq!(
        value
            .pointer("/bank/bankCredits")
            .and_then(serde_json::Value::as_u64),
        Some(777)
    );
    assert_eq!(
        value
            .pointer("/playerCorpses/0/ownerActorId")
            .and_then(serde_json::Value::as_str),
        Some("player")
    );
    assert_eq!(
        value
            .pointer("/playerCorpses/0/cell/x")
            .and_then(serde_json::Value::as_i64),
        Some(10)
    );
    assert_eq!(
        value
            .pointer("/playerCorpses/0/cell/y")
            .and_then(serde_json::Value::as_i64),
        Some(10)
    );
    assert_eq!(
        value
            .pointer("/playerCorpses/0/position/x")
            .and_then(serde_json::Value::as_i64),
        Some(10_321),
        "Rust bridge must retain raw milli-cell corpse coordinates"
    );
    assert_eq!(
        value
            .pointer("/playerCorpses/0/position/y")
            .and_then(serde_json::Value::as_i64),
        Some(10_654),
        "Rust bridge must retain raw milli-cell corpse coordinates"
    );
}

#[test]
fn authority_bridge_full_step_tick_and_actor_outputs_project_bank_and_raw_corpses() {
    let (config, _, mut state) = bank_clone_test_state();
    push_test_inventory_stack(
        &mut state,
        "player:field-pack",
        FIELD_BANDAGE_ITEM_ID,
        71,
        2,
    );
    state.bank_accounts.get_mut("player").unwrap().bank_credits = 777;
    {
        let player = state.actors.get_mut("player").unwrap();
        player.professions.credits = 345;
        player.position = AuthorityPosition {
            x: 10_321,
            y: 10_654,
        };
        player.cell = player.position.cell();
    }
    let death_tick = state.tick();
    let tick_rate_hz = state.tick_rate_hz;
    SliceAuthorityState::kill_actor_for_respawn(
        death_tick,
        tick_rate_hz,
        state.actors.get_mut("player").unwrap(),
    );
    let cloned = state.apply_envelope(
        &config,
        command_for(&config, 1, clone_respawn_command(Some("clone-alpha"))),
    );
    assert_eq!(cloned.status, AuthorityCommandStatus::Accepted);
    let far_created_tick = state.tick();
    state.player_corpses.insert(
        "player-corpse:999".to_owned(),
        PlayerCorpseState {
            id: "player-corpse:999".to_owned(),
            owner_actor_id: "far-owner".to_owned(),
            owner_label: "Far Owner".to_owned(),
            area_id: "dustgate".to_owned(),
            cell: AuthorityCell { x: 999, y: 999 },
            position: AuthorityPosition {
                x: 999_000,
                y: 999_000,
            },
            created_tick: far_created_tick,
            expiry_tick: far_created_tick + 1_000,
            credits: 0,
            container: "corpse:player-corpse:999".to_owned(),
        },
    );

    let blob = state.export_checkpoint();
    let expected_hash = blob.state_hash().to_owned();
    let mut bridge = AuthorityBridge::from_snapshot(&crate::authority_test_slice()).unwrap();
    let imported = bridge
        .import_state(AuthorityBridgeImportStateRequest {
            request_type: "importState".to_owned(),
            request_id: Some(40),
            state: blob,
            expected_state_hash: Some(expected_hash),
        })
        .unwrap();
    let imported_json = serde_json::to_value(imported).unwrap();
    assert!(
        imported_json.pointer("/bank").is_none(),
        "global import observer must not receive an owner's private bank"
    );
    assert_eq!(
        imported_json
            .pointer("/playerCorpses/0/position/x")
            .and_then(serde_json::Value::as_i64),
        Some(10_321)
    );

    let step_json: serde_json::Value = serde_json::from_str(
        &bridge
            .step_json(
                r#"{
                  "requestId": 41,
                  "config": {
                    "session": 1,
                    "player": 1,
                    "playerActorId": "player",
                    "areaInterestRadiusCells": 64
                  },
                  "envelope": {
                    "session": 1,
                    "player": 1,
                    "command_id": 41,
                    "issued_at_tick": 41,
                    "command": {
                      "Move": {
                        "dx": 0,
                        "dy": 0,
                        "duration_ticks": 1,
                        "facing": "Front"
                      }
                    }
                  }
                }"#,
            )
            .unwrap(),
    )
    .unwrap();
    assert_bridge_owner_bank_and_raw_corpse(&step_json);

    let tick_json: serde_json::Value = serde_json::from_str(
        &bridge
            .tick_json(
                r#"{
                  "type": "tick",
                  "requestId": 42,
                  "ticks": 1,
                  "config": {
                    "session": 1,
                    "player": 1,
                    "playerActorId": "player",
                    "areaInterestRadiusCells": 64
                  }
                }"#,
            )
            .unwrap(),
    )
    .unwrap();
    assert_bridge_owner_bank_and_raw_corpse(&tick_json);

    let actor_json: serde_json::Value = serde_json::from_str(
        &bridge
            .set_actor_link_dead_json(
                r#"{
                  "type": "setActorLinkDead",
                  "requestId": 43,
                  "actorId": "player",
                  "linkDead": true,
                  "deadlineTick": 600
                }"#,
            )
            .unwrap(),
    )
    .unwrap();
    assert_bridge_owner_bank_and_raw_corpse(&actor_json);
}

#[test]
fn authority_bridge_full_outputs_serialize_an_explicit_empty_corpse_list() {
    let mut bridge = AuthorityBridge::from_snapshot(&crate::authority_test_slice()).unwrap();
    let tick_json: serde_json::Value = serde_json::from_str(
        &bridge
            .tick_json(
                r#"{
                  "type": "tick",
                  "requestId": 44,
                  "ticks": 1,
                  "config": {
                    "session": 1,
                    "player": 1,
                    "playerActorId": "player",
                    "areaInterestRadiusCells": 64
                  }
                }"#,
            )
            .unwrap(),
    )
    .unwrap();
    assert_eq!(
        tick_json.pointer("/playerCorpses"),
        Some(&serde_json::json!([]))
    );
}

#[test]
fn authority_player_corpse_items_and_credits_are_public_at_exact_loot_radius() {
    let (player_config, looter_config, mut state) = bank_clone_test_state();
    push_test_inventory_stack(&mut state, "player:field-pack", FIELD_BANDAGE_ITEM_ID, 9, 2);
    state.actors.get_mut("player").unwrap().professions.credits = 50;
    let death_tick = state.tick();
    let tick_rate_hz = state.tick_rate_hz;
    SliceAuthorityState::kill_actor_for_respawn(
        death_tick,
        tick_rate_hz,
        state.actors.get_mut("player").unwrap(),
    );
    let cloned = state.apply_envelope(
        &player_config,
        command_for(
            &player_config,
            1,
            clone_respawn_command(Some("clone-alpha")),
        ),
    );
    assert_eq!(cloned.status, AuthorityCommandStatus::Accepted);
    let corpse = state.player_corpses.values().next().unwrap().clone();
    {
        let looter = state.actors.get_mut("looter").unwrap();
        looter.position = AuthorityPosition {
            x: corpse.position.x + HARVEST_INTERACTION_RADIUS_MILLI_CELLS + 1,
            y: corpse.position.y,
        };
        looter.cell = looter.position.cell();
    }
    let too_far = state.apply_envelope(
        &looter_config,
        command_for(
            &looter_config,
            1,
            ClientCommand::CorpseTakeCredits {
                corpse_id: corpse.id.clone(),
            },
        ),
    );
    assert_eq!(too_far.status, AuthorityCommandStatus::Rejected);
    assert_eq!(too_far.reason_code.as_deref(), Some("loot_out_of_range"));
    assert_eq!(state.player_corpses[&corpse.id].credits, 50);

    {
        let looter = state.actors.get_mut("looter").unwrap();
        looter.position = AuthorityPosition {
            x: corpse.position.x + HARVEST_INTERACTION_RADIUS_MILLI_CELLS,
            y: corpse.position.y,
        };
        looter.cell = looter.position.cell();
    }
    let item_loot = state.apply_envelope(
        &looter_config,
        command_for(
            &looter_config,
            2,
            ClientCommand::TakeLootItem {
                container: corpse.container.clone(),
                item_id: FIELD_BANDAGE_ITEM_ID,
                variant_id: 9,
                quantity: 2,
            },
        ),
    );
    assert_eq!(item_loot.status, AuthorityCommandStatus::Accepted);
    assert!(state.player_corpses.contains_key(&corpse.id));
    assert_eq!(state.player_corpses[&corpse.id].credits, 50);

    let wallet_before = state.actors["looter"].professions.credits;
    let credit_loot = state.apply_envelope(
        &looter_config,
        command_for(
            &looter_config,
            3,
            ClientCommand::CorpseTakeCredits {
                corpse_id: corpse.id.clone(),
            },
        ),
    );
    assert_eq!(credit_loot.status, AuthorityCommandStatus::Accepted);
    assert_eq!(
        state.actors["looter"].professions.credits,
        wallet_before + 50
    );
    assert!(!state.player_corpses.contains_key(&corpse.id));
}

#[test]
fn authority_multiple_player_corpses_expire_at_exact_individual_deadlines() {
    let (config, _, mut state) = bank_clone_test_state();
    let tick_rate_hz = state.tick_rate_hz;
    let first_death_tick = state.tick();
    SliceAuthorityState::kill_actor_for_respawn(
        first_death_tick,
        tick_rate_hz,
        state.actors.get_mut("player").unwrap(),
    );
    assert_eq!(
        state
            .apply_envelope(
                &config,
                command_for(&config, 1, clone_respawn_command(Some("clone-alpha"))),
            )
            .status,
        AuthorityCommandStatus::Accepted
    );
    state.advance_ticks_for_observer(&config, 1);
    state.actors.get_mut("player").unwrap().professions.credits = 1;
    let second_death_tick = state.tick();
    SliceAuthorityState::kill_actor_for_respawn(
        second_death_tick,
        tick_rate_hz,
        state.actors.get_mut("player").unwrap(),
    );
    assert_eq!(
        state
            .apply_envelope(
                &config,
                command_for(&config, 2, clone_respawn_command(Some("clone-alpha"))),
            )
            .status,
        AuthorityCommandStatus::Accepted
    );
    assert_eq!(state.player_corpses.len(), 2);
    let deadlines = state
        .player_corpses
        .values()
        .map(|corpse| (corpse.id.clone(), corpse.created_tick, corpse.expiry_tick))
        .collect::<Vec<_>>();
    for (_, created_tick, expiry_tick) in &deadlines {
        assert_eq!(
            *expiry_tick,
            created_tick + 120 * 60 * u64::from(tick_rate_hz)
        );
    }
    assert!(deadlines[1].1 > deadlines[0].1);

    state.tick = deadlines[0].2 - 1;
    state.expire_player_corpses();
    assert_eq!(state.player_corpses.len(), 2);
    state.tick = deadlines[0].2;
    state.expire_player_corpses();
    assert!(!state.player_corpses.contains_key(&deadlines[0].0));
    assert!(state.player_corpses.contains_key(&deadlines[1].0));
    state.tick = deadlines[1].2;
    state.expire_player_corpses();
    assert!(state.player_corpses.is_empty());
}
#[test]
fn authority_medic_revive_preserves_target_property_skills_equipment_and_position() {
    let (_, medic_config, mut state) = bank_clone_test_state();
    grant_test_profession(&mut state, "looter", AuthorityProfessionKind::Medic);
    push_test_inventory_stack(
        &mut state,
        "looter:field-pack",
        RESUSCITATION_KIT_ITEM_ID,
        0,
        1,
    );
    push_test_inventory_stack(
        &mut state,
        "player:field-pack",
        FIELD_BANDAGE_ITEM_ID,
        23,
        4,
    );
    {
        let player = state.actors.get_mut("player").unwrap();
        player.professions.credits = 432;
        player
            .professions
            .skill_boxes
            .insert("brawler-novice".to_owned());
        player.worn = vec![AuthorityActorWornPiece {
            item: "dust-jacket".to_owned(),
            colors: vec!["#112233".to_owned()],
        }];
        player.equipped_weapon_id = Some(AuthorityWeaponId::Vibrosword);
        player.equipped_weapon_item_id = VIBROSWORD_WEAPON_ITEM_ID;
        player.equipped_weapon_variant_id = 17;
        player.clone_sickness_ticks = 77;
    }
    let death_tick = state.tick();
    {
        let player = state.actors.get_mut("player").unwrap();
        SliceAuthorityState::set_actor_life_state(player, AuthorityLifeState::Downed);
        player.vitals.health = 0;
        player.incap_expires_tick = 0;
        player.body_vanish_tick = death_tick.saturating_add(900);
        player.respawn_tick = 0;
    }
    let property_before = state
        .inventory
        .iter()
        .filter(|row| actor_owns_inventory_container("player", &row.container))
        .cloned()
        .collect::<Vec<_>>();
    let player_before = state.actors["player"].clone();

    let revived = state.apply_envelope(
        &medic_config,
        command_for(
            &medic_config,
            1,
            ClientCommand::ReviveActor {
                target_actor_id: "player".to_owned(),
            },
        ),
    );
    assert_eq!(revived.status, AuthorityCommandStatus::Accepted);
    let player = &state.actors["player"];
    assert_eq!(player.life_state, AuthorityLifeState::Alive);
    assert_eq!(player.area_id, player_before.area_id);
    assert_eq!(player.cell, player_before.cell);
    assert_eq!(player.position, player_before.position);
    assert_eq!(player.professions, player_before.professions);
    assert_eq!(player.worn, player_before.worn);
    assert_eq!(player.equipped_weapon_id, player_before.equipped_weapon_id);
    assert_eq!(
        player.equipped_weapon_item_id,
        player_before.equipped_weapon_item_id
    );
    assert_eq!(
        player.equipped_weapon_variant_id,
        player_before.equipped_weapon_variant_id
    );
    assert_eq!(
        state
            .inventory
            .iter()
            .filter(|row| actor_owns_inventory_container("player", &row.container))
            .cloned()
            .collect::<Vec<_>>(),
        property_before
    );
    assert!(state.player_corpses.is_empty());
}

#[test]
fn authority_clone_respawn_command_with_facility_id_moves_to_requested_facility() {
    let (config, mut state) = two_facility_clone_respawn_state();
    {
        let sprint_regen_block_until_tick = state.tick.saturating_add(90);
        let player = state.actors.get_mut("player").unwrap();
        player.sprint_recovery_locked = true;
        player.sprint_recovery_regen_carry = 713;
        player.sprint_action_drain_milli = 919;
        player.sprint_regen_block_until_tick = sprint_regen_block_until_tick;
    }

    let respawn = state.apply_envelope(
        &config,
        command(1, clone_respawn_command(Some("clone-alpha"))),
    );

    assert_eq!(respawn.status, AuthorityCommandStatus::Accepted);
    let player = state.actors.get("player").unwrap();
    assert_eq!(player.life_state, AuthorityLifeState::Alive);
    assert_eq!(player.area_id, crate::AUTHORITY_TEST_AREA_ID);
    assert_eq!(player.cell, AuthorityCell::new(4, 5));
    assert_eq!(player.clone_sickness_ticks, 900);
    assert!(!player.sprint_recovery_locked);
    assert_eq!(player.sprint_recovery_regen_carry, 0);
    assert_eq!(player.sprint_action_drain_milli, 0);
    assert_eq!(player.sprint_regen_block_until_tick, 0);
}

#[test]
fn authority_clone_respawn_command_rejects_unknown_facility_id() {
    let (config, mut state) = two_facility_clone_respawn_state();

    let respawn = state.apply_envelope(
        &config,
        command(1, clone_respawn_command(Some("missing-cloner"))),
    );

    assert_eq!(respawn.status, AuthorityCommandStatus::Rejected);
    assert_eq!(
        respawn.reason_code.as_deref(),
        Some("unknown_clone_facility")
    );
    let player = state.actors.get("player").unwrap();
    assert_eq!(player.life_state, AuthorityLifeState::Respawning);
    assert_eq!(player.cell, AuthorityCell::new(33, 21));
}

#[test]
fn authority_clone_respawn_empty_payload_uses_nearest_facility() {
    let (config, mut state) = two_facility_clone_respawn_state();

    let respawn = state.apply_envelope(&config, command(1, clone_respawn_command(None)));

    assert_eq!(respawn.status, AuthorityCommandStatus::Accepted);
    let player = state.actors.get("player").unwrap();
    assert_eq!(player.cell, AuthorityCell::new(34, 21));
}

#[test]
fn authority_clone_respawn_snapshots_report_respawn_and_sickness_state() {
    let (config, mut state) = two_facility_clone_respawn_state();
    let respawn_tick = state.tick().saturating_add(42);
    {
        let player = state.actors.get_mut("player").unwrap();
        SliceAuthorityState::set_actor_life_state(player, AuthorityLifeState::Respawning);
        player.respawn_tick = respawn_tick;
    }
    assert_eq!(
        state.actor_snapshot("player").unwrap().respawn_tick,
        respawn_tick
    );

    let respawn = state.apply_envelope(
        &config,
        command(1, clone_respawn_command(Some("clone-alpha"))),
    );

    assert_eq!(respawn.status, AuthorityCommandStatus::Accepted);
    assert_eq!(
        state.actor_snapshot("player").unwrap().clone_sickness_ticks,
        900
    );
}

fn normalize_cell_coordinates(val: &mut serde_json::Value) {
    match val {
        serde_json::Value::Object(map) => {
            if map.contains_key("x") && map.contains_key("y") {
                if let Some(x_val) = map.get_mut("x") {
                    if let Some(x_f) = x_val.as_f64() {
                        *x_val =
                            serde_json::Value::Number(serde_json::Number::from(x_f.round() as i64));
                    }
                }
                if let Some(y_val) = map.get_mut("y") {
                    if let Some(y_f) = y_val.as_f64() {
                        *y_val =
                            serde_json::Value::Number(serde_json::Number::from(y_f.round() as i64));
                    }
                }
            }
            for child in map.values_mut() {
                normalize_cell_coordinates(child);
            }
        }
        serde_json::Value::Array(arr) => {
            for child in arr.iter_mut() {
                normalize_cell_coordinates(child);
            }
        }
        _ => {}
    }
}

#[test]
fn authority_player_clone_respawn_command_moves_to_cloning_center() {
    let fixture = OPEN_DESERT_FIXTURE_JSON;
    let mut val: serde_json::Value = serde_json::from_str(fixture).unwrap();
    normalize_cell_coordinates(&mut val);
    let snapshot: SliceSnapshot = serde_json::from_value(val).unwrap();
    let config = SliceAuthorityConfig::default();
    let mut state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    let tick = state.tick();
    let tick_rate_hz = state.tick_rate_hz;
    {
        let player = state.actors.get_mut("player").unwrap();
        SliceAuthorityState::kill_actor_for_respawn(tick, tick_rate_hz, player);
    }

    let respawn = state.apply_envelope(&config, command(1, clone_respawn_command(None)));

    assert_eq!(respawn.status, AuthorityCommandStatus::Accepted);
    let player = state.actors.get("player").unwrap();
    assert_eq!(player.life_state, AuthorityLifeState::Alive);
    assert_eq!(player.area_id, "open-desert-overworld");
    assert_eq!(player.cell, AuthorityCell::new(519, 503));
    assert!(player.respawn_return.is_empty());
}
#[test]
fn authority_clone_respawn_command_rejects_non_player_like_actor() {
    let mut snapshot = crate::authority_test_slice();
    snapshot.actors.clear();
    snapshot.npc_jobs.clear();
    snapshot
        .clone_facilities
        .push(crate::CloneFacilitySnapshot {
            id: "test-cloner".to_owned(),
            label: "Test Cloner".to_owned(),
            area_id: "authority-test-overworld".to_owned(),
            respawn_cell: CellSnapshot::new(10, 14),
            respawn_facing: "front".to_owned(),
            sickness_duration_ms: 180_000,
        });
    snapshot.actors.push(test_actor(
        "respawned-creature",
        "Respawned Creature",
        "creature",
        CellSnapshot::new(18, 15),
        "front",
    ));
    let config = SliceAuthorityConfig {
        player_actor_id: "respawned-creature".to_owned(),
        ..SliceAuthorityConfig::default()
    };
    let mut state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    {
        let tick = state.tick();
        let hz = state.tick_rate_hz;
        let creature = state.actors.get_mut("respawned-creature").unwrap();
        SliceAuthorityState::kill_actor_for_respawn(tick, hz, creature);
    }

    let respawn = state.apply_envelope(&config, command(1, clone_respawn_command(None)));

    assert_eq!(respawn.status, AuthorityCommandStatus::Rejected);
    assert_eq!(
        respawn.reason_code.as_deref(),
        Some("invalid_clone_respawn")
    );
    let creature = state.actors.get("respawned-creature").unwrap();
    assert_eq!(creature.area_id, creature.home_area_id);
    assert_eq!(creature.cell, creature.home_cell);
    assert_ne!(creature.cell, AuthorityCell::new(10, 14));
}

#[test]
fn authority_field_bandage_removes_one_bleed_stack_per_use() {
    let config = SliceAuthorityConfig::default();
    let mut snapshot = crate::authority_test_slice();
    snapshot.inventory.retain(|row| {
        !(actor_owns_inventory_container("player", &row.container)
            && row.item_id == FIELD_BANDAGE_ITEM_ID)
    });
    snapshot.inventory.push(InventoryStackSnapshot {
        stack_id: 0,
        container: "player:field-pack".to_owned(),
        item: "Field Bandage".to_owned(),
        item_id: FIELD_BANDAGE_ITEM_ID,
        variant_id: 0,
        quantity: 2,
        reserved: 0,
        available: 2,
    });
    let mut state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    {
        let player = state.actors.get_mut("player").unwrap();
        player.bleed_stacks.push(BleedStackAuthorityState {
            damage_milli_per_tick: 1_000,
            accumulated_damage_milli: 0,
            source_actor_id: "rogue-trooper-alpha-01".to_owned(),
            remaining_ticks: 900,
        });
        player.bleed_stacks.push(BleedStackAuthorityState {
            damage_milli_per_tick: 3_000,
            accumulated_damage_milli: 0,
            source_actor_id: "rogue-trooper-alpha-02".to_owned(),
            remaining_ticks: 900,
        });
        player.downed_action_drain_milli = 123;
        player.downed_spirit_drain_milli = 456;
    }

    let first = state.apply_envelope(
        &config,
        command(
            1,
            ClientCommand::UseConsumable {
                item_id: "field_bandage".to_owned(),
                item_numeric_id: None,
                variant_id: None,
            },
        ),
    );

    assert_eq!(first.status, AuthorityCommandStatus::Accepted);
    let player = state.actors.get("player").unwrap();
    assert_eq!(player.bleed_stacks.len(), 1);
    assert_eq!(player.bleed_stacks[0].damage_milli_per_tick, 1_000);
    assert_eq!(player.downed_action_drain_milli, 123);
    assert_eq!(player.downed_spirit_drain_milli, 456);
    assert_eq!(
        state.actor_inventory_available_quantity("player", FIELD_BANDAGE_ITEM_ID),
        1
    );

    let second = state.apply_envelope(
        &config,
        command(
            2,
            ClientCommand::UseConsumable {
                item_id: "field_bandage".to_owned(),
                item_numeric_id: None,
                variant_id: None,
            },
        ),
    );

    assert_eq!(second.status, AuthorityCommandStatus::Accepted);
    let player = state.actors.get("player").unwrap();
    assert!(player.bleed_stacks.is_empty());
    assert_eq!(player.downed_action_drain_milli, 0);
    assert_eq!(player.downed_spirit_drain_milli, 0);
    assert_eq!(
        state.actor_inventory_available_quantity("player", FIELD_BANDAGE_ITEM_ID),
        0
    );
}

#[test]
fn authority_player_stimpak_command_is_open_use() {
    // MEDIC WAVE (F-M1, owner-ratified): stim USE is OPEN to anyone — universal-use rule
    // (only CRAFTING is medic-gated). This is the INTENDED flip of the former
    // `authority_player_stimpak_command_requires_medic_profession` gate: a non-medic
    // must be able to use Stimpak A + buff packs (e.g. their respawn stimpaks).
    let config = SliceAuthorityConfig::default();
    let snapshot = crate::authority_test_slice();
    let mut state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    clear_test_professions(&mut state, "player");
    assert!(
        !state
            .actors
            .get("player")
            .unwrap()
            .professions
            .has_skill_box("medic-novice"),
        "test premise: the player is NOT a medic"
    );
    state.add_actor_inventory_stack(
        "player",
        STIMPAK_A_ITEM_ID,
        0,
        "Stimpak A",
        2,
        STIMPAK_A_STACK_CAP,
        "field-pack",
    );
    state.add_actor_inventory_stack(
        "player",
        BODY_ENHANCEMENT_PACK_A_ITEM_ID,
        0,
        "Body Enhancement Pack A",
        1,
        ENHANCEMENT_PACK_A_STACK_CAP,
        "field-pack",
    );
    {
        let player = state.actors.get_mut("player").unwrap();
        player.vitals.health = 40;
    }
    let stimpak_before = state.actor_inventory_available_quantity("player", STIMPAK_A_ITEM_ID);
    let body_before =
        state.actor_inventory_available_quantity("player", BODY_ENHANCEMENT_PACK_A_ITEM_ID);

    let stimpak = state.apply_envelope(
        &config,
        command(
            1,
            ClientCommand::UseConsumable {
                item_id: "stimpak_a".to_owned(),
                item_numeric_id: Some(STIMPAK_A_ITEM_ID),
                variant_id: Some(0),
            },
        ),
    );
    assert_eq!(
        stimpak.status,
        AuthorityCommandStatus::Accepted,
        "a non-medic can use a Stimpak A (universal use)"
    );
    assert_eq!(
        state.actor_inventory_available_quantity("player", STIMPAK_A_ITEM_ID),
        stimpak_before - 1
    );
    assert!(state
        .actors
        .get("player")
        .unwrap()
        .consumable_effects
        .iter()
        .any(|effect| effect.effect_id == "stimpak_a_heal"));

    let body = state.apply_envelope(
        &config,
        command(
            2,
            ClientCommand::UseConsumable {
                item_id: "body_enhancement_pack_a".to_owned(),
                item_numeric_id: Some(BODY_ENHANCEMENT_PACK_A_ITEM_ID),
                variant_id: Some(0),
            },
        ),
    );
    assert_eq!(
        body.status,
        AuthorityCommandStatus::Accepted,
        "a non-medic can use a buff pack (universal use)"
    );
    assert_eq!(
        state.actor_inventory_available_quantity("player", BODY_ENHANCEMENT_PACK_A_ITEM_ID),
        body_before - 1
    );
    assert!(state
        .actors
        .get("player")
        .unwrap()
        .service_buffs
        .iter()
        .any(|buff| buff.effect_id == MEDIC_PREP_EFFECT_ID));
}

#[test]
fn authority_consumable_command_consumes_exact_variant() {
    let config = SliceAuthorityConfig::default();
    let snapshot = crate::authority_test_slice();
    let mut state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    grant_test_profession(&mut state, "player", AuthorityProfessionKind::Medic);
    state.add_actor_inventory_stack(
        "player",
        STIMPAK_A_ITEM_ID,
        0,
        "Stimpak A",
        3,
        STIMPAK_A_STACK_CAP,
        "field-pack",
    );
    state.add_actor_inventory_stack(
        "player",
        STIMPAK_A_ITEM_ID,
        7,
        "Stimpak A Q7",
        2,
        STIMPAK_A_STACK_CAP,
        "field-pack",
    );
    {
        let player = state.actors.get_mut("player").unwrap();
        player.vitals.health = 40;
    }
    let variant_zero_before =
        state.actor_inventory_available_variant("player", STIMPAK_A_ITEM_ID, 0);
    let variant_seven_before =
        state.actor_inventory_available_variant("player", STIMPAK_A_ITEM_ID, 7);

    let accepted = state.apply_envelope(
        &config,
        command(
            1,
            ClientCommand::UseConsumable {
                item_id: "stimpak_a".to_owned(),
                item_numeric_id: Some(STIMPAK_A_ITEM_ID),
                variant_id: Some(7),
            },
        ),
    );

    assert_eq!(accepted.status, AuthorityCommandStatus::Accepted);
    assert_eq!(
        state.actor_inventory_available_variant("player", STIMPAK_A_ITEM_ID, 0),
        variant_zero_before
    );
    assert_eq!(
        state.actor_inventory_available_variant("player", STIMPAK_A_ITEM_ID, 7),
        variant_seven_before - 1
    );
}

#[test]
fn authority_clone_respawn_resets_player_to_bodysuit_only() {
    let fixture = OPEN_DESERT_FIXTURE_JSON;
    let mut val: serde_json::Value = serde_json::from_str(fixture).unwrap();
    normalize_cell_coordinates(&mut val);
    let snapshot: SliceSnapshot = serde_json::from_value(val).unwrap();
    let config = SliceAuthorityConfig {
        player_actor_id: "player".to_owned(),
        ..SliceAuthorityConfig::default()
    };
    let mut state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    for row in state.inventory.iter_mut().filter(|row| {
        row.container.starts_with("player:")
            && (row.item_id == STIMPAK_A_ITEM_ID || row.item_id == FIELD_BANDAGE_ITEM_ID)
    }) {
        row.quantity = 0;
        row.available = 0;
        row.reserved = 0;
    }
    let tick = state.tick();
    let tick_rate_hz = state.tick_rate_hz;
    {
        let player_actor = state.actors.get_mut("player").unwrap();
        SliceAuthorityState::kill_actor_for_respawn(tick, tick_rate_hz, player_actor);
    }

    let respawn = state.apply_envelope(&config, command(1, clone_respawn_command(None)));

    assert_eq!(respawn.status, AuthorityCommandStatus::Accepted);
    let carried = state
        .inventory_snapshots()
        .into_iter()
        .filter(|row| actor_owns_inventory_container("player", &row.container))
        .collect::<Vec<_>>();
    assert_eq!(carried.len(), 2);
    assert_eq!(carried[0].item, "under_bodysuit");
    assert_eq!(carried[0].quantity, 1);
    assert_eq!(carried[0].available, 1);
    assert_eq!(carried[1].item, "boots_canvas_ankle");
    assert_eq!(carried[1].quantity, 1);
    assert_eq!(carried[1].available, 1);
    let player = state.actors.get("player").unwrap();
    assert_eq!(
        player.worn,
        vec![
            AuthorityActorWornPiece {
                item: "under_bodysuit".to_owned(),
                colors: vec!["#89cff0".to_owned()],
            },
            AuthorityActorWornPiece {
                item: "boots_canvas_ankle".to_owned(),
                colors: vec!["#303030".to_owned(), "#808080".to_owned()],
            },
        ]
    );
    assert_eq!(player.equipped_weapon_id, None);
    assert_eq!(player.equipped_weapon_item_id, 0);
    assert_eq!(player.equipped_weapon_variant_id, 0);
}

#[test]
fn authority_vital_damage_clamps_to_zero() {
    let mut value = 3;
    apply_vital_damage(&mut value, 10);
    assert_eq!(value, 0);

    apply_vital_damage(&mut value, -10);
    assert_eq!(value, 0);
}

#[test]
fn authority_refills_tracked_rifle_ammo_from_nearby_stockpile() {
    let config = SliceAuthorityConfig::default();
    let mut snapshot = crate::authority_test_slice();
    let player_cell = snapshot
        .actors
        .iter()
        .find(|actor| actor.id == "player")
        .unwrap()
        .cell
        .clone();
    snapshot.props.push(PropSnapshot {
        id: "test-ammo-stockpile".to_owned(),
        entity: "stockpile:ammo".to_owned(),
        area_id: "authority-test-overworld".to_owned(),
        label: "Ammo Stockpile".to_owned(),
        kind: "prop".to_owned(),
        cell: player_cell,
        size: CellSizeSnapshot { w: 2, h: 2 },
        interactive: false,
        cover: None,
        collision_bounds: Vec::new(),
        door: None,
        container: None,
    });
    snapshot.inventory.push(InventoryStackSnapshot {
        stack_id: 0,
        container: "player:field-pack".to_owned(),
        item: "Iron Slug".to_owned(),
        item_id: AMMO_SLUG_IRON_ITEM_ID,
        variant_id: 0,
        quantity: 0,
        reserved: 0,
        available: 0,
    });
    snapshot.inventory.push(InventoryStackSnapshot {
        stack_id: 0,
        container: "player:field-pack".to_owned(),
        item: "Stimpak A".to_owned(),
        item_id: STIMPAK_A_ITEM_ID,
        variant_id: 0,
        quantity: 0,
        reserved: 0,
        available: 0,
    });
    snapshot.inventory.push(InventoryStackSnapshot {
        stack_id: 0,
        container: "player:field-pack".to_owned(),
        item: "Field Bandage".to_owned(),
        item_id: FIELD_BANDAGE_ITEM_ID,
        variant_id: 0,
        quantity: 0,
        reserved: 0,
        available: 0,
    });
    let mut state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();

    let refill = state.apply_envelope(
        &config,
        command(
            1,
            ClientCommand::RefillAmmo {
                item_id: "slug_iron".to_owned(),
            },
        ),
    );

    assert_eq!(refill.status, AuthorityCommandStatus::Accepted);
    assert_eq!(
        state
            .inventory_snapshots()
            .iter()
            .find(|row| row.item_id == AMMO_SLUG_IRON_ITEM_ID)
            .unwrap()
            .available,
        AMMO_REFILL_BATCH_QUANTITY
    );
    assert_eq!(
        state
            .inventory_snapshots()
            .iter()
            .find(|row| row.item_id == STIMPAK_A_ITEM_ID)
            .unwrap()
            .available,
        PLAYER_RESPAWN_STIMPAK_A_QUANTITY
    );
    assert_eq!(
        state
            .inventory_snapshots()
            .iter()
            .find(|row| row.item_id == FIELD_BANDAGE_ITEM_ID)
            .unwrap()
            .available,
        PLAYER_RESPAWN_FIELD_BANDAGE_QUANTITY
    );
}

#[test]
fn authority_refill_command_full_reserved_stack_is_idempotent() {
    let config = SliceAuthorityConfig::default();
    let mut snapshot = crate::authority_test_slice();
    snapshot
        .inventory
        .retain(|row| !actor_owns_inventory_container("player", &row.container));
    let player_cell = snapshot
        .actors
        .iter()
        .find(|actor| actor.id == "player")
        .unwrap()
        .cell
        .clone();
    snapshot.props.push(PropSnapshot {
        id: "full-reserved-ammo-stockpile".to_owned(),
        entity: "stockpile:ammo".to_owned(),
        area_id: crate::AUTHORITY_TEST_AREA_ID.to_owned(),
        label: "Full Reserved Ammo Stockpile".to_owned(),
        kind: "prop".to_owned(),
        cell: player_cell,
        size: CellSizeSnapshot { w: 2, h: 2 },
        interactive: false,
        cover: None,
        collision_bounds: Vec::new(),
        door: None,
        container: None,
    });
    snapshot.inventory.push(InventoryStackSnapshot {
        stack_id: 0,
        container: "player:field-pack".to_owned(),
        item: "Iron Slug".to_owned(),
        item_id: AMMO_SLUG_IRON_ITEM_ID,
        variant_id: 0,
        quantity: AMMO_REFILL_BATCH_QUANTITY,
        reserved: AMMO_REFILL_BATCH_QUANTITY - 1,
        available: 1,
    });
    snapshot.inventory.push(InventoryStackSnapshot {
        stack_id: 0,
        container: "player:field-pack".to_owned(),
        item: "Stimpak A".to_owned(),
        item_id: STIMPAK_A_ITEM_ID,
        variant_id: 0,
        quantity: PLAYER_RESPAWN_STIMPAK_A_QUANTITY,
        reserved: 0,
        available: PLAYER_RESPAWN_STIMPAK_A_QUANTITY,
    });
    snapshot.inventory.push(InventoryStackSnapshot {
        stack_id: 0,
        container: "player:field-pack".to_owned(),
        item: "Field Bandage".to_owned(),
        item_id: FIELD_BANDAGE_ITEM_ID,
        variant_id: 0,
        quantity: PLAYER_RESPAWN_FIELD_BANDAGE_QUANTITY,
        reserved: 0,
        available: PLAYER_RESPAWN_FIELD_BANDAGE_QUANTITY,
    });
    snapshot.inventory.push(InventoryStackSnapshot {
        stack_id: 0,
        container: "player:field-pack".to_owned(),
        item: "Plasma Sword".to_owned(),
        item_id: PLASMA_SWORD_ITEM_ID,
        variant_id: 0,
        quantity: 1,
        reserved: 0,
        available: 1,
    });
    let mut state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    let refill_events_before = state
        .timeline_event_snapshots()
        .iter()
        .filter(|event| event.label.contains("player refilled"))
        .count();

    let refill = state.apply_envelope(
        &config,
        command(
            1,
            ClientCommand::RefillAmmo {
                item_id: "slug_iron".to_owned(),
            },
        ),
    );

    assert_eq!(refill.status, AuthorityCommandStatus::Accepted);
    assert_eq!(
        state.actor_inventory_available_quantity("player", AMMO_SLUG_IRON_ITEM_ID),
        1
    );
    let refill_events_after = state
        .timeline_event_snapshots()
        .iter()
        .filter(|event| event.label.contains("player refilled"))
        .count();
    assert_eq!(refill_events_after, refill_events_before);
}

#[test]
fn authority_rejects_ammo_stockpile_prop_with_unknown_area() {
    let mut snapshot = crate::authority_test_slice();
    snapshot.props.clear();
    snapshot.props.push(PropSnapshot {
        id: "orphan-ammo-stockpile".to_owned(),
        entity: "stockpile:ammo".to_owned(),
        area_id: "missing-area".to_owned(),
        label: "Orphan Ammo Stockpile".to_owned(),
        kind: "prop".to_owned(),
        cell: CellSnapshot::new(1, 1),
        size: CellSizeSnapshot { w: 2, h: 2 },
        interactive: false,
        cover: None,
        collision_bounds: Vec::new(),
        door: None,
        container: None,
    });

    let error = match SliceAuthorityState::from_snapshot(&snapshot) {
        Ok(_) => panic!("unknown-area ammo stockpile props must fail authority build"),
        Err(error) => error,
    };

    assert_eq!(
        error,
        SliceAuthorityBuildError::UnknownAmmoStockpileArea {
            prop_id: "orphan-ammo-stockpile".to_owned(),
            area_id: "missing-area".to_owned(),
        }
    );
}

#[test]
fn authority_rejects_ammo_stockpile_prop_outside_area() {
    let mut snapshot = crate::authority_test_slice();
    snapshot.props.clear();
    snapshot.props.push(PropSnapshot {
        id: "off-map-ammo-stockpile".to_owned(),
        entity: "stockpile:ammo".to_owned(),
        area_id: crate::AUTHORITY_TEST_AREA_ID.to_owned(),
        label: "Off Map Ammo Stockpile".to_owned(),
        kind: "prop".to_owned(),
        cell: CellSnapshot::new(10_000, 10_000),
        size: CellSizeSnapshot { w: 2, h: 2 },
        interactive: false,
        cover: None,
        collision_bounds: Vec::new(),
        door: None,
        container: None,
    });

    let error = match SliceAuthorityState::from_snapshot(&snapshot) {
        Ok(_) => panic!("out-of-area ammo stockpile props must fail authority build"),
        Err(error) => error,
    };

    assert_eq!(
        error,
        SliceAuthorityBuildError::AmmoStockpileOutOfBounds {
            prop_id: "off-map-ammo-stockpile".to_owned(),
            area_id: crate::AUTHORITY_TEST_AREA_ID.to_owned(),
            x: 10_000,
            y: 10_000,
        }
    );
}

#[test]
fn authority_samples_resource_containers_with_stack_cap() {
    let config = SliceAuthorityConfig::default();
    let mut snapshot = crate::authority_test_slice();
    expand_resource_test_area(&mut snapshot, "authority-test-overworld");
    snapshot
        .actors
        .iter_mut()
        .find(|actor| actor.id == "player")
        .expect("demo player exists")
        .profession_ids = vec!["craftsman".to_owned()];
    let mut state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    seed_test_tool(
        &mut state,
        "player",
        FIELD_MULTITOOL_ITEM_ID,
        "Field Multitool",
    );
    seed_test_survey_tool(&mut state, "player");
    let (resource, rich_cell, concentration_milli) =
        rich_resource_cell_for_test(&state, "authority-test-overworld", "mineral");
    assert!(
        resource_sample_yield(
            resource.stats.extraction_yield,
            concentration_milli,
            state.actor_crafting_tool_quality_milli("player")
        ) >= 3,
        "rich cell should yield enough iron to exercise stack-cap clamp"
    );
    move_actor_to_cell_for_test(&mut state, "player", rich_cell);
    state.add_actor_inventory_stack(
        "player",
        resource.item_id,
        resource.variant_id,
        &resource.label,
        RESOURCE_STACK_CAP - 3,
        RESOURCE_STACK_CAP,
        "resource-crate",
    );

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

    assert_eq!(sample.status, AuthorityCommandStatus::Accepted);
    let resolve_tick = state
        .actors
        .get("player")
        .and_then(|actor| actor.pending_resource_sample.as_ref())
        .map(|sample| sample.resolve_tick)
        .expect("sample should be pending");
    let ticks_to_resolve = resolve_tick.saturating_sub(state.tick());
    advance_ticks_unclamped(&mut state, &config, ticks_to_resolve);
    let row = state
        .inventory_snapshots()
        .into_iter()
        .find(|row| {
            row.item_id == RESOURCE_MINERAL_ITEM_ID && row.variant_id == resource.variant_id
        })
        .unwrap();
    assert_eq!(row.quantity, RESOURCE_STACK_CAP);
    assert_eq!(row.available, RESOURCE_STACK_CAP);
    assert!(state
        .timeline_event_snapshots()
        .iter()
        .any(|event| event.label.contains("sampled")));
}

#[test]
fn authority_posture_transitions_tick_driven() {
    let config = SliceAuthorityConfig::default();
    let snapshot = crate::authority_test_slice();
    let mut state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();

    let kneel = state.apply_envelope(
        &config,
        command(
            1,
            ClientCommand::SetPosture {
                posture: "kneel".to_owned(),
            },
        ),
    );
    assert_eq!(kneel.status, AuthorityCommandStatus::Accepted);
    let kneel_start_tick = state.tick();
    let actor = state.actor_snapshot(&config.player_actor_id).unwrap();
    assert_eq!(actor.posture, AuthorityActorPosture::KneelingDown);
    assert_eq!(
        actor.posture_until_tick,
        kneel_start_tick.saturating_add(POSTURE_KNEEL_DOWN_TICKS)
    );

    advance_ticks_unclamped(&mut state, &config, POSTURE_KNEEL_DOWN_TICKS - 1);
    assert_eq!(
        state
            .actor_snapshot(&config.player_actor_id)
            .unwrap()
            .posture,
        AuthorityActorPosture::KneelingDown
    );
    advance_ticks_unclamped(&mut state, &config, 1);
    let kneeling = state.actor_snapshot(&config.player_actor_id).unwrap();
    assert_eq!(kneeling.posture, AuthorityActorPosture::Kneeling);
    assert_eq!(kneeling.posture_until_tick, 0);

    let stand = state.apply_envelope(
        &config,
        command(
            2,
            ClientCommand::SetPosture {
                posture: "stand".to_owned(),
            },
        ),
    );
    assert_eq!(stand.status, AuthorityCommandStatus::Accepted);
    let stand_start_tick = state.tick();
    let standing_up = state.actor_snapshot(&config.player_actor_id).unwrap();
    assert_eq!(standing_up.posture, AuthorityActorPosture::StandingUp);
    assert_eq!(
        standing_up.posture_until_tick,
        stand_start_tick.saturating_add(POSTURE_STAND_UP_TICKS)
    );

    advance_ticks_unclamped(&mut state, &config, POSTURE_STAND_UP_TICKS - 1);
    assert_eq!(
        state
            .actor_snapshot(&config.player_actor_id)
            .unwrap()
            .posture,
        AuthorityActorPosture::StandingUp
    );
    advance_ticks_unclamped(&mut state, &config, 1);
    let standing = state.actor_snapshot(&config.player_actor_id).unwrap();
    assert_eq!(standing.posture, AuthorityActorPosture::Standing);
    assert_eq!(standing.posture_until_tick, 0);
}

#[test]
fn authority_rejects_movement_until_posture_stand_completes() {
    let config = SliceAuthorityConfig::default();
    let snapshot = crate::authority_test_slice();
    let mut state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();

    let kneel = state.apply_envelope(
        &config,
        command(
            1,
            ClientCommand::SetPosture {
                posture: "kneel".to_owned(),
            },
        ),
    );
    assert_eq!(kneel.status, AuthorityCommandStatus::Accepted);
    advance_ticks_unclamped(&mut state, &config, POSTURE_KNEEL_DOWN_TICKS);

    let locked_move = state.apply_envelope(
        &config,
        command(
            2,
            ClientCommand::Move {
                dx: 1,
                dy: 0,
                duration_ticks: 3,
                facing: None,
                sprint: true,
            },
        ),
    );
    assert_eq!(locked_move.status, AuthorityCommandStatus::Rejected);
    assert_eq!(locked_move.reason_code.as_deref(), Some("posture_locked"));

    let stand = state.apply_envelope(
        &config,
        command(
            3,
            ClientCommand::SetPosture {
                posture: "stand".to_owned(),
            },
        ),
    );
    assert_eq!(stand.status, AuthorityCommandStatus::Accepted);
    let standing_up_move = state.apply_envelope(
        &config,
        command(
            4,
            ClientCommand::Move {
                dx: 1,
                dy: 0,
                duration_ticks: 3,
                facing: None,
                sprint: false,
            },
        ),
    );
    assert_eq!(standing_up_move.status, AuthorityCommandStatus::Rejected);
    assert_eq!(
        standing_up_move.reason_code.as_deref(),
        Some("posture_locked")
    );

    advance_ticks_unclamped(&mut state, &config, POSTURE_STAND_UP_TICKS);
    let unlocked_move = state.apply_envelope(
        &config,
        command(
            5,
            ClientCommand::Move {
                dx: 1,
                dy: 0,
                duration_ticks: 3,
                facing: None,
                sprint: false,
            },
        ),
    );
    assert_eq!(unlocked_move.status, AuthorityCommandStatus::Accepted);
}

#[test]
fn authority_sample_auto_kneels_and_resolves_after_duration() {
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
    place_actor_at_position(
        &mut state,
        &player,
        AuthorityPosition::from_cell(AuthorityCell::new(288, 96)),
    );
    let mineral = |s: &SliceAuthorityState| -> u32 {
        s.inventory_snapshots()
            .iter()
            .filter(|row| {
                row.item_id == RESOURCE_MINERAL_ITEM_ID
                    && actor_owns_inventory_container(&player, &row.container)
            })
            .map(|row| row.quantity)
            .sum()
    };
    let before = mineral(&state);

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
    assert_eq!(sample.status, AuthorityCommandStatus::Accepted);
    let actor = state.actors.get(&player).expect("player exists");
    assert_eq!(actor.posture, AuthorityActorPosture::KneelingDown);
    let pending = actor
        .pending_resource_sample
        .as_ref()
        .expect("sample should be pending");
    assert_eq!(
        pending.resolve_tick,
        actor
            .posture_until_tick
            .saturating_add(RESOURCE_SAMPLE_DURATION_TICKS)
    );
    assert_eq!(
        mineral(&state),
        before,
        "sample should not resolve immediately"
    );

    advance_ticks_unclamped(&mut state, &config, POSTURE_KNEEL_DOWN_TICKS);
    assert_eq!(
        state.actor_snapshot(&player).unwrap().posture,
        AuthorityActorPosture::Kneeling
    );
    assert_eq!(
        mineral(&state),
        before,
        "kneel completion alone is not enough"
    );

    let resolve_tick = state
        .actors
        .get(&player)
        .and_then(|actor| actor.pending_resource_sample.as_ref())
        .map(|sample| sample.resolve_tick)
        .expect("sample should still be pending");
    let before_resolve = resolve_tick.saturating_sub(state.tick()).saturating_sub(1);
    advance_ticks_unclamped(&mut state, &config, before_resolve);
    assert_eq!(
        mineral(&state),
        before,
        "sample resolves only at resolve tick"
    );
    advance_ticks_unclamped(&mut state, &config, 1);
    assert!(mineral(&state) > before);
    assert!(state
        .timeline_event_snapshots()
        .iter()
        .any(|event| event.label.contains("sampled")));
}

#[test]
fn extraction_sample_auto_repeat_runs_multiple_cycles_at_exact_cadence() {
    let (config, mut state) = resource_sample_loop_test_state();
    let player = config.player_actor_id.clone();
    let before = owned_actor_item_quantity(&state, &player, RESOURCE_MINERAL_ITEM_ID);

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
    assert_eq!(sample.status, AuthorityCommandStatus::Accepted);
    let first_loop_tick = sample.actor.as_ref().unwrap().next_sample_tick;
    assert_eq!(
        first_loop_tick,
        sample
            .tick
            .saturating_add(RESOURCE_SAMPLE_AUTO_REPEAT_CADENCE_TICKS)
    );
    let first_resolve_tick = state
        .actors
        .get(&player)
        .and_then(|actor| actor.pending_resource_sample.as_ref())
        .map(|pending| pending.resolve_tick)
        .expect("initial sample should be pending");
    let ticks_to_first_resolve = first_resolve_tick.saturating_sub(state.tick());
    advance_ticks_unclamped(&mut state, &config, ticks_to_first_resolve);
    let after_first = owned_actor_item_quantity(&state, &player, RESOURCE_MINERAL_ITEM_ID);
    assert!(after_first > before);
    assert!(state
        .actors
        .get(&player)
        .unwrap()
        .pending_resource_sample
        .is_none());

    let ticks_before_repeat = first_loop_tick
        .saturating_sub(state.tick())
        .saturating_sub(1);
    advance_ticks_unclamped(&mut state, &config, ticks_before_repeat);
    assert!(state
        .actors
        .get(&player)
        .unwrap()
        .pending_resource_sample
        .is_none());
    advance_ticks_unclamped(&mut state, &config, 1);

    let actor = state.actors.get(&player).unwrap();
    let second_pending = actor
        .pending_resource_sample
        .as_ref()
        .expect("auto-repeat sample should be pending exactly on cadence");
    assert_eq!(
        second_pending.resolve_tick,
        first_loop_tick.saturating_add(RESOURCE_SAMPLE_DURATION_TICKS)
    );
    assert_eq!(
        actor
            .resource_sample_loop
            .as_ref()
            .unwrap()
            .next_sample_tick,
        first_loop_tick.saturating_add(RESOURCE_SAMPLE_AUTO_REPEAT_CADENCE_TICKS)
    );
    let second_resolve_tick = second_pending.resolve_tick;
    let ticks_to_second_resolve = second_resolve_tick.saturating_sub(state.tick());
    advance_ticks_unclamped(&mut state, &config, ticks_to_second_resolve);
    assert!(owned_actor_item_quantity(&state, &player, RESOURCE_MINERAL_ITEM_ID) > after_first);
}

#[test]
fn extraction_sample_repress_rejects_with_next_tick_and_preserves_loop() {
    let (config, mut state) = resource_sample_loop_test_state();

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
    assert_eq!(sample.status, AuthorityCommandStatus::Accepted);
    let next_sample_tick = sample.actor.as_ref().unwrap().next_sample_tick;
    assert!(next_sample_tick > sample.tick);

    let repeat = state.apply_envelope(
        &config,
        command(
            2,
            ClientCommand::SampleResource {
                family: "mineral".to_owned(),
                stop: false,
            },
        ),
    );
    assert_eq!(repeat.status, AuthorityCommandStatus::Rejected);
    assert_eq!(repeat.reason_code.as_deref(), Some("sample_cooldown"));
    assert_eq!(
        repeat.actor.as_ref().unwrap().next_sample_tick,
        next_sample_tick
    );
    assert_eq!(
        state
            .actors
            .get(&config.player_actor_id)
            .unwrap()
            .resource_sample_loop
            .as_ref()
            .unwrap()
            .next_sample_tick,
        next_sample_tick
    );
}

#[test]
fn extraction_sample_loop_breaks_on_stop_posture_movement_area_and_death() {
    let (config, mut state) = resource_sample_loop_test_state();
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
    assert_eq!(sample.status, AuthorityCommandStatus::Accepted);
    let stop = state.apply_envelope(
        &config,
        command(
            2,
            ClientCommand::SampleResource {
                family: "mineral".to_owned(),
                stop: true,
            },
        ),
    );
    assert_eq!(stop.status, AuthorityCommandStatus::Accepted);
    let actor = state.actors.get(&config.player_actor_id).unwrap();
    assert!(actor.pending_resource_sample.is_none());
    assert!(actor.resource_sample_loop.is_none());

    let (config, mut state) = resource_sample_loop_test_state();
    assert_eq!(
        state
            .apply_envelope(
                &config,
                command(
                    1,
                    ClientCommand::SampleResource {
                        family: "mineral".to_owned(),
                        stop: false,
                    },
                ),
            )
            .status,
        AuthorityCommandStatus::Accepted
    );
    let kneel = state.apply_envelope(
        &config,
        command(
            2,
            ClientCommand::SetPosture {
                posture: "kneel".to_owned(),
            },
        ),
    );
    assert_eq!(kneel.status, AuthorityCommandStatus::Accepted);
    let actor = state.actors.get(&config.player_actor_id).unwrap();
    assert!(actor.pending_resource_sample.is_none());
    assert!(actor.resource_sample_loop.is_none());

    let (config, mut state) = resource_sample_loop_test_state();
    assert_eq!(
        state
            .apply_envelope(
                &config,
                command(
                    1,
                    ClientCommand::SampleResource {
                        family: "mineral".to_owned(),
                        stop: false,
                    },
                ),
            )
            .status,
        AuthorityCommandStatus::Accepted
    );
    let stand = state.apply_envelope(
        &config,
        command(
            2,
            ClientCommand::SetPosture {
                posture: "stand".to_owned(),
            },
        ),
    );
    assert_eq!(stand.status, AuthorityCommandStatus::Accepted);
    let actor = state.actors.get(&config.player_actor_id).unwrap();
    assert!(actor.pending_resource_sample.is_none());
    assert!(actor.resource_sample_loop.is_none());

    let (config, mut state) = resource_sample_loop_test_state();
    seed_resource_sample_loop_for_test(&mut state, &config.player_actor_id, "mineral", 100);
    let moved = state.apply_envelope(
        &config,
        command(
            1,
            ClientCommand::Move {
                dx: 1,
                dy: 0,
                duration_ticks: 1,
                facing: None,
                sprint: false,
            },
        ),
    );
    assert_eq!(moved.status, AuthorityCommandStatus::Accepted);
    assert!(state
        .actors
        .get(&config.player_actor_id)
        .unwrap()
        .resource_sample_loop
        .is_none());

    let (config, mut state) = resource_sample_loop_test_state();
    move_actor_to_cell_for_test(
        &mut state,
        &config.player_actor_id,
        AuthorityCell::new(39, 20),
    );
    seed_resource_sample_loop_for_test(&mut state, &config.player_actor_id, "mineral", 100);
    let transition = state.apply_envelope(
        &config,
        command(
            1,
            ClientCommand::EnterTransition {
                transition_id: "test-workshop-entry".to_owned(),
            },
        ),
    );
    assert_eq!(transition.status, AuthorityCommandStatus::Accepted);
    assert!(state
        .actors
        .get(&config.player_actor_id)
        .unwrap()
        .resource_sample_loop
        .is_none());

    let (config, mut state) = resource_sample_loop_test_state();
    seed_resource_sample_loop_for_test(&mut state, &config.player_actor_id, "mineral", 100);
    let actor = state.actors.get_mut(&config.player_actor_id).unwrap();
    SliceAuthorityState::set_actor_life_state(actor, AuthorityLifeState::Downed);
    assert!(state
        .actors
        .get(&config.player_actor_id)
        .unwrap()
        .resource_sample_loop
        .is_none());
}

#[test]
fn extraction_sample_loop_hash_is_relational() {
    fn run_sequence() -> (String, SliceAuthorityState) {
        let (config, mut state) = resource_sample_loop_test_state();
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
        assert_eq!(sample.status, AuthorityCommandStatus::Accepted);
        let first_resolve_tick = state
            .actors
            .get(&config.player_actor_id)
            .and_then(|actor| actor.pending_resource_sample.as_ref())
            .map(|pending| pending.resolve_tick)
            .expect("initial sample should be pending");
        let ticks_to_first_resolve = first_resolve_tick.saturating_sub(state.tick());
        advance_ticks_unclamped(&mut state, &config, ticks_to_first_resolve);
        let first_loop_tick = state
            .actors
            .get(&config.player_actor_id)
            .and_then(|actor| actor.resource_sample_loop.as_ref())
            .map(|sample_loop| sample_loop.next_sample_tick)
            .expect("loop should remain armed after first sample");
        let ticks_to_first_loop = first_loop_tick.saturating_sub(state.tick());
        advance_ticks_unclamped(&mut state, &config, ticks_to_first_loop);
        let second_resolve_tick = state
            .actors
            .get(&config.player_actor_id)
            .and_then(|actor| actor.pending_resource_sample.as_ref())
            .map(|pending| pending.resolve_tick)
            .expect("auto-repeat sample should be pending");
        let ticks_to_second_resolve = second_resolve_tick.saturating_sub(state.tick());
        advance_ticks_unclamped(&mut state, &config, ticks_to_second_resolve);
        (state.stable_state_hash_hex(), state)
    }

    let (first_hash, _) = run_sequence();
    let (second_hash, mut mutated) = run_sequence();
    assert_eq!(first_hash, second_hash);
    mutated
        .actors
        .get_mut("player")
        .unwrap()
        .resource_sample_loop
        .as_mut()
        .unwrap()
        .next_sample_tick = mutated
        .actors
        .get("player")
        .unwrap()
        .resource_sample_loop
        .as_ref()
        .unwrap()
        .next_sample_tick
        .saturating_add(1);
    assert_ne!(second_hash, mutated.stable_state_hash_hex());
}

#[test]
fn authority_resource_sample_yield_is_monotonic_by_concentration() {
    let poor = resource_sample_yield(500, 100, 500);
    let medium = resource_sample_yield(500, 500, 500);
    let rich = resource_sample_yield(500, 900, 500);

    // Gram doctrine rebalance (resource-units-design.md s5.1): fine pulls are 30-120 g; a
    // rich vein with a middling tool/exyield pulls ~87 g (was 450 g pre-doctrine).
    assert_eq!(poor, 9);
    assert_eq!(rich, 87);
    assert!(poor < medium && medium < rich);
}

#[test]
fn authority_kneel_sample_sequence_hash_is_deterministic() {
    fn run_sequence() -> String {
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
        assert_eq!(sample.status, AuthorityCommandStatus::Accepted);
        let resolve_tick = state
            .actors
            .get(&player)
            .and_then(|actor| actor.pending_resource_sample.as_ref())
            .map(|sample| sample.resolve_tick)
            .expect("sample should be pending");
        let ticks_to_resolve = resolve_tick.saturating_sub(state.tick());
        advance_ticks_unclamped(&mut state, &config, ticks_to_resolve);

        let stand = state.apply_envelope(
            &config,
            command(
                2,
                ClientCommand::SetPosture {
                    posture: "stand".to_owned(),
                },
            ),
        );
        assert_eq!(stand.status, AuthorityCommandStatus::Accepted);
        advance_ticks_unclamped(&mut state, &config, POSTURE_STAND_UP_TICKS);
        state.stable_state_hash_hex()
    }

    assert_eq!(run_sequence(), run_sequence());
}

#[test]
fn authority_placed_extractor_hash_is_relational() {
    fn place_once() -> (String, SliceAuthorityState) {
        let (config, mut state) = placed_extractor_test_state();
        let before = state.stable_state_hash_hex();
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
        assert_ne!(state.stable_state_hash_hex(), before);
        (before, state)
    }

    let (_before, first) = place_once();
    let (_before_again, second) = place_once();
    assert_eq!(
        first.stable_state_hash_hex(),
        second.stable_state_hash_hex()
    );

    let mut mutated = first.clone();
    let extractor = mutated
        .placed_extractors
        .values_mut()
        .next()
        .expect("placed extractor exists");
    extractor.hopper_milli = extractor.hopper_milli.saturating_add(1);
    assert_ne!(
        first.stable_state_hash_hex(),
        mutated.stable_state_hash_hex()
    );
}

#[test]
fn authority_manual_extractor_crank_collect_and_destroy_are_owner_gated() {
    let config = SliceAuthorityConfig::default();
    let mut snapshot = crate::authority_test_slice();
    expand_resource_test_area(&mut snapshot, "authority-test-overworld");
    snapshot.actors.push(test_actor(
        "extractor-thief",
        "Extractor Thief",
        "enemy",
        CellSnapshot::new(1, 1),
        "front",
    ));
    let mut state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    let player = config.player_actor_id.clone();
    grant_test_profession(&mut state, &player, AuthorityProfessionKind::Craftsman);
    let (_, rich_cell, _) =
        rich_resource_cell_for_test(&state, "authority-test-overworld", "mineral");
    move_actor_to_cell_for_test(&mut state, &player, rich_cell);
    move_actor_to_cell_for_test(&mut state, "extractor-thief", rich_cell);
    seed_test_extractor_tool(&mut state, &player, 1_000);

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
    let extractor_id = state
        .placed_extractors
        .keys()
        .next()
        .expect("extractor id")
        .clone();
    assert_eq!(
        state.actor_inventory_available_quantity(&player, METAL_EXTRACTOR_TOOL_ITEM_ID),
        0
    );

    let crank = state.apply_envelope(
        &config,
        command(
            2,
            ClientCommand::CrankExtractor {
                extractor_id: extractor_id.clone(),
            },
        ),
    );
    assert_eq!(crank.status, AuthorityCommandStatus::Accepted);
    advance_ticks_unclamped(
        &mut state,
        &config,
        POSTURE_KNEEL_DOWN_TICKS.saturating_add(60),
    );
    assert!(
        state.placed_extractors[&extractor_id].hopper_milli > 0,
        "manual cranking should tick-integrate into the hopper"
    );

    let thief_config = SliceAuthorityConfig {
        player_actor_id: "extractor-thief".to_owned(),
        ..SliceAuthorityConfig::default()
    };
    let thief_collect = state.apply_envelope(
        &thief_config,
        command(
            3,
            ClientCommand::CollectExtractor {
                extractor_id: extractor_id.clone(),
            },
        ),
    );
    assert_eq!(thief_collect.status, AuthorityCommandStatus::Rejected);
    assert_eq!(
        thief_collect.reason_code.as_deref(),
        Some("not_extractor_owner")
    );

    let before_resource =
        state.actor_inventory_available_quantity(&player, RESOURCE_MINERAL_ITEM_ID);
    let collect = state.apply_envelope(
        &config,
        command(
            4,
            ClientCommand::CollectExtractor {
                extractor_id: extractor_id.clone(),
            },
        ),
    );
    assert_eq!(collect.status, AuthorityCommandStatus::Accepted);
    assert!(
        state.actor_inventory_available_quantity(&player, RESOURCE_MINERAL_ITEM_ID)
            > before_resource
    );
    assert_eq!(state.placed_extractors[&extractor_id].hopper_milli, 0);

    let stop = state.apply_envelope(&config, command(5, ClientCommand::StopCrank {}));
    assert_eq!(stop.status, AuthorityCommandStatus::Accepted);
    assert!(state.actors[&player].cranking_extractor_id.is_none());
    assert_eq!(
        state.placed_extractors[&extractor_id].mode,
        ExtractorMode::Idle
    );

    let destroyed = state.apply_envelope(
        &config,
        command(
            6,
            ClientCommand::DestroyExtractor {
                extractor_id: extractor_id.clone(),
            },
        ),
    );
    assert_eq!(destroyed.status, AuthorityCommandStatus::Accepted);
    assert!(!state.placed_extractors.contains_key(&extractor_id));
    assert_eq!(
        state.actor_inventory_available_quantity(&player, METAL_EXTRACTOR_TOOL_ITEM_ID),
        1
    );
}

#[test]
fn authority_battery_extractor_insert_autonomous_drain_and_death_are_deterministic() {
    let (config, mut state) = placed_extractor_test_state();
    let player = config.player_actor_id.clone();
    let (_, rich_cell, _) =
        rich_resource_cell_for_test(&state, "authority-test-overworld", "mineral");
    move_actor_to_cell_for_test(&mut state, &player, rich_cell);
    seed_test_extractor_tool(&mut state, &player, 1_000);
    let (container, stack_id, battery_variant_id) =
        seed_test_extractor_battery(&mut state, &player, 5);

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
    let extractor_id = state
        .placed_extractors
        .keys()
        .next()
        .expect("extractor id")
        .clone();
    let inserted = state.apply_envelope(
        &config,
        command(
            2,
            ClientCommand::InsertBattery {
                extractor_id: extractor_id.clone(),
                container,
                stack_id,
                variant_id: battery_variant_id,
            },
        ),
    );
    assert_eq!(inserted.status, AuthorityCommandStatus::Accepted);
    assert_eq!(
        state.actor_inventory_available_quantity(&player, EXTRACTOR_BATTERY_ITEM_ID),
        0
    );
    assert_eq!(
        state.placed_extractors[&extractor_id].mode,
        ExtractorMode::Battery
    );
    assert_eq!(
        state.placed_extractors[&extractor_id].battery_remaining_seconds,
        5
    );
    let hash_after_insert = state.stable_state_hash_hex();
    let mut mutated = state.clone();
    mutated
        .placed_extractors
        .get_mut(&extractor_id)
        .expect("mutated extractor")
        .battery_remaining_seconds = 4;
    assert_ne!(hash_after_insert, mutated.stable_state_hash_hex());

    advance_ticks_unclamped(&mut state, &config, 7 * 30);
    let stored = &state.placed_extractors[&extractor_id];
    assert_eq!(
        stored.battery_remaining_seconds, 5,
        "autonomous battery mode should not mutate stored state every second"
    );
    let extractor = state.materialized_placed_extractor_state(stored);
    assert!(extractor.hopper_milli > 0);
    assert_eq!(extractor.battery_remaining_seconds, 0);
    assert_eq!(extractor.battery_variant_id, 0);
    assert_eq!(extractor.mode, ExtractorMode::Idle);
}

#[test]
fn authority_battery_extractor_serialized_checkpoint_preserves_owned_hopper_and_collects_once() {
    let (config, mut state) = placed_extractor_test_state();
    let player = config.player_actor_id.clone();
    let (container, stack_id, battery_variant_id) =
        seed_test_extractor_battery(&mut state, &player, 60);

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
    let extractor_id = state
        .placed_extractors
        .keys()
        .next()
        .expect("placed extractor id")
        .clone();

    let inserted = state.apply_envelope(
        &config,
        command(
            2,
            ClientCommand::InsertBattery {
                extractor_id: extractor_id.clone(),
                container,
                stack_id,
                variant_id: battery_variant_id,
            },
        ),
    );
    assert_eq!(inserted.status, AuthorityCommandStatus::Accepted);
    advance_ticks_unclamped(&mut state, &config, 2 * 30);

    let checkpoint =
        serde_json::to_string(&state.export_checkpoint()).expect("authority checkpoint serializes");
    let checkpoint: AuthorityCheckpointBlob =
        serde_json::from_str(&checkpoint).expect("authority checkpoint deserializes");
    let mut restored = restore_checkpoint_for_test(&state, checkpoint);

    let extractor_snapshot = restored
        .placed_extractor_snapshots_for_observer(&config)
        .into_iter()
        .find(|snapshot| snapshot.extractor_id == extractor_id)
        .expect("restored extractor is visible to its owner");
    assert_eq!(extractor_snapshot.owner_actor_id, player);
    assert!(extractor_snapshot.is_owner);
    assert_eq!(extractor_snapshot.mode, ExtractorMode::Battery);
    assert!(extractor_snapshot.collectable_units > 0);

    let expected_yield = extractor_snapshot.collectable_units;
    let resource_item_id = restored.placed_extractors[&extractor_id].resource_item_id;
    let inventory_before = restored.actor_inventory_available_quantity(&player, resource_item_id);
    let collected = restored.apply_envelope(
        &config,
        command(
            3,
            ClientCommand::CollectExtractor {
                extractor_id: extractor_id.clone(),
            },
        ),
    );
    assert_eq!(collected.status, AuthorityCommandStatus::Accepted);
    assert_eq!(
        restored.actor_inventory_available_quantity(&player, resource_item_id),
        inventory_before + expected_yield,
        "checkpoint restore must deliver the persisted hopper exactly once"
    );
    assert_eq!(restored.placed_extractors[&extractor_id].hopper_milli, 0);

    let repeated_collect = restored.apply_envelope(
        &config,
        command(4, ClientCommand::CollectExtractor { extractor_id }),
    );
    assert_eq!(repeated_collect.status, AuthorityCommandStatus::Rejected);
    assert_eq!(
        repeated_collect.reason_code.as_deref(),
        Some("extractor_hopper_empty"),
        "the emptied post-checkpoint hopper must reject a duplicate collect"
    );
}

#[test]
fn authority_destroy_extractor_returns_live_battery_with_remaining_runtime_variant() {
    let (config, mut state) = placed_extractor_test_state();
    let player = config.player_actor_id.clone();
    let (_, rich_cell, _) =
        rich_resource_cell_for_test(&state, "authority-test-overworld", "mineral");
    move_actor_to_cell_for_test(&mut state, &player, rich_cell);
    seed_test_extractor_tool(&mut state, &player, 1_000);
    let (container, stack_id, battery_variant_id) =
        seed_test_extractor_battery(&mut state, &player, 60);

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
    let extractor_id = state
        .placed_extractors
        .keys()
        .next()
        .expect("extractor id")
        .clone();
    let inserted = state.apply_envelope(
        &config,
        command(
            2,
            ClientCommand::InsertBattery {
                extractor_id: extractor_id.clone(),
                container,
                stack_id,
                variant_id: battery_variant_id,
            },
        ),
    );
    assert_eq!(inserted.status, AuthorityCommandStatus::Accepted);
    advance_ticks_unclamped(&mut state, &config, 2 * 30);
    let remaining = state
        .materialized_placed_extractor_state(&state.placed_extractors[&extractor_id])
        .battery_remaining_seconds;
    assert!(remaining < 60 && remaining > 0);

    let destroyed = state.apply_envelope(
        &config,
        command(
            3,
            ClientCommand::DestroyExtractor {
                extractor_id: extractor_id.clone(),
            },
        ),
    );
    assert_eq!(destroyed.status, AuthorityCommandStatus::Accepted);
    assert_eq!(
        state.actor_inventory_available_quantity(&player, EXTRACTOR_BATTERY_ITEM_ID),
        1
    );
    assert!(state.inventory.iter().any(|row| {
        actor_owns_inventory_container(&player, &row.container)
            && row.item_id == EXTRACTOR_BATTERY_ITEM_ID
            && row.variant_id == encode_battery_variant(remaining)
            && row.available == 1
    }));
}

#[test]
fn authority_resource_field_is_deterministic_for_same_seed_and_cell() {
    let resource = resource_instance_for_family("authority-test-overworld", "metal").unwrap();
    let cell = AuthorityCell::new(137, -42);
    let first = resource_concentration_milli(resource.concentration_seed, cell);

    for _ in 0..8 {
        assert_eq!(
            resource_concentration_milli(resource.concentration_seed, cell),
            first
        );
    }
}

#[test]
fn authority_resource_field_is_smooth_between_neighbor_cells() {
    let resource = resource_instance_for_family("authority-test-overworld", "metal").unwrap();
    let mut max_neighbor_delta = 0_u16;

    for y in (-128..=128).step_by(8) {
        for x in (-128..=128).step_by(8) {
            let here =
                resource_concentration_milli(resource.concentration_seed, AuthorityCell::new(x, y));
            let right = resource_concentration_milli(
                resource.concentration_seed,
                AuthorityCell::new(x + 1, y),
            );
            let down = resource_concentration_milli(
                resource.concentration_seed,
                AuthorityCell::new(x, y + 1),
            );
            max_neighbor_delta = max_neighbor_delta
                .max(here.max(right).saturating_sub(here.min(right)))
                .max(here.max(down).saturating_sub(here.min(down)));
        }
    }

    assert!(
        max_neighbor_delta <= 180,
        "adjacent cells should not jump like white noise; saw {max_neighbor_delta}"
    );
}

#[test]
fn authority_resource_field_has_barrens_and_rich_lobes() {
    let resource = resource_instance_for_family("authority-test-overworld", "metal").unwrap();
    let mut min_milli = 1_000_u16;
    let mut max_milli = 0_u16;

    for y in (0..=1_024).step_by(8) {
        for x in (0..=1_024).step_by(8) {
            let value =
                resource_concentration_milli(resource.concentration_seed, AuthorityCell::new(x, y));
            min_milli = min_milli.min(value);
            max_milli = max_milli.max(value);
        }
    }

    assert!(
        min_milli <= 50,
        "sampled 1024² field should include barrens; min {min_milli}"
    );
    assert!(
        max_milli >= 900,
        "sampled 1024² field should include rich lobes; max {max_milli}"
    );
}

#[test]
fn authority_resource_field_guarantees_rich_lobe_in_every_area() {
    let resource = resource_instance_for_family("authority-test-overworld", "metal").unwrap();
    let snapshot = crate::authority_test_slice();
    let mut areas: Vec<(String, u32, u32)> = snapshot
        .areas
        .iter()
        .map(|area| (area.id.clone(), area.width, area.height))
        .collect();
    areas.push(("synthetic-resource-canary".to_owned(), 176, 112));

    for (area_id, width, height) in areas {
        let mut max_milli = 0_u16;
        for y in 0..height {
            for x in 0..width {
                let value = resource_concentration_milli_in_area(
                    resource.concentration_seed,
                    &area_id,
                    width,
                    height,
                    AuthorityCell::new(
                        i32::try_from(x).expect("test area width fits i32"),
                        i32::try_from(y).expect("test area height fits i32"),
                    ),
                );
                max_milli = max_milli.max(value);
                if max_milli >= 900 {
                    break;
                }
            }
            if max_milli >= 900 {
                break;
            }
        }
        assert!(
            max_milli >= 900,
            "area {area_id} ({width}x{height}) should contain a guaranteed rich lobe; max {max_milli}"
        );
    }
}

#[test]
fn resource_registry_growth_keeps_iron_identity_stable() {
    fn replay_bytes(
        seed: u32,
        concentration_seed: u32,
        variant_id: u32,
        stats: ResourceStats,
        cells: &[AuthorityCell],
    ) -> Vec<u8> {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&seed.to_le_bytes());
        bytes.extend_from_slice(&variant_id.to_le_bytes());
        for value in [
            stats.conductivity,
            stats.malleability,
            stats.shock_resistance,
            stats.thermal_resistance,
            stats.chemical_purity,
            stats.density,
            stats.tensile_strength,
            stats.flexibility,
            stats.potency,
            stats.nutrition,
            stats.stability,
            stats.extraction_yield,
        ] {
            bytes.extend_from_slice(&value.to_le_bytes());
        }
        for cell in cells.iter().copied() {
            bytes.extend_from_slice(
                &resource_concentration_milli(concentration_seed, cell).to_le_bytes(),
            );
        }
        bytes
    }

    let area_id = "authority-test-overworld";
    let field_cells = [
        AuthorityCell::new(-32, -17),
        AuthorityCell::new(0, 0),
        AuthorityCell::new(137, -42),
        AuthorityCell::new(288, 96),
        AuthorityCell::new(1_024, 1_024),
    ];
    let metal = resource_instance_for_family_at_tick(area_id, "metal", 0).unwrap();
    let legacy = resource_instance_for_family_at_tick(
        area_id,
        "mineral",
        RESOURCE_CYCLE_TICKS.saturating_mul(4),
    )
    .unwrap();
    let spawns = active_resource_spawn_snapshots_for_area(area_id, 42);

    assert_eq!(RESOURCE_SPAWN_REGISTRY.len(), 6);
    assert_eq!(spawns.len(), 6);
    assert_eq!(spawns[0].family, "metal");
    assert_eq!(spawns[1].family, "copper");
    assert_eq!(spawns[2].family, "chemical");
    assert_eq!(spawns[3].family, "gas");
    assert_eq!(spawns[4].family, "water");
    assert_eq!(spawns[5].family, "carbon");
    assert_eq!(metal.family, "metal");
    assert_eq!(metal.spawn_id, legacy.spawn_id);
    assert_eq!(metal.variant_id, legacy.variant_id);
    assert_eq!(metal.stats, legacy.stats);

    let expected_iron_seed = string_hash32(&format!(
        "resource-spawn:{area_id}:metal:iron:v1-eternal-iron"
    ));
    let expected_iron_concentration_seed = string_hash32(&format!(
        "resource-spawn:{area_id}:metal:iron:v1-eternal-iron:0"
    ));
    let expected_iron_variant = 200_000_u32 + 10_000 + expected_iron_seed % 9_973;
    let expected_iron_stats =
        resource_stats_for_item_variant(RESOURCE_MINERAL_ITEM_ID, expected_iron_variant).unwrap();
    assert_eq!(metal.seed, expected_iron_seed);
    assert_eq!(metal.concentration_seed, expected_iron_concentration_seed);
    assert_eq!(metal.variant_id, expected_iron_variant);
    assert_eq!(
        replay_bytes(
            metal.seed,
            metal.concentration_seed,
            metal.variant_id,
            metal.stats,
            &field_cells
        ),
        replay_bytes(
            expected_iron_seed,
            expected_iron_concentration_seed,
            expected_iron_variant,
            expected_iron_stats,
            &field_cells
        ),
        "iron identity bytes and epoch-0 concentration bytes must stay identical when copper is appended"
    );

    let iron_spawn = spawns
        .iter()
        .find(|spawn| spawn.family == "metal")
        .expect("iron spawn remains active");
    assert_eq!(iron_spawn.spawn_id, metal.spawn_id);
    assert_eq!(iron_spawn.class_label, "Iron");
    assert_eq!(iron_spawn.variant_id, metal.variant_id);
    assert_eq!(iron_spawn.active_until_tick, None);
    // Chemical/gas/water are now real families (appended after iron+copper).
    assert!(resource_instance_for_family(area_id, "chemical").is_some());
    assert!(resource_instance_for_family(area_id, "gas").is_some());
    assert!(resource_instance_for_family(area_id, "water").is_some());
    let reconstructed = resource_stats_for_item_variant(metal.item_id, metal.variant_id).unwrap();
    assert_eq!(metal.stats, reconstructed);

    let state = SliceAuthorityState::from_snapshot(&crate::authority_test_slice()).unwrap();
    let before_hash = state.stable_state_hash_hex();
    let derived = active_resource_spawn_snapshots_for_area(area_id, state.tick());
    assert_eq!(derived.len(), 6);
    assert_eq!(
        state.stable_state_hash_hex(),
        before_hash,
        "derived resource spawns must not mutate or participate in stored state hash"
    );
}

#[test]
fn authority_copper_spawn_derives_plausible_stats_and_concentration_fields() {
    let area_id = "authority-test-overworld";
    let copper = resource_instance_for_family_at_tick(area_id, "copper", 0).unwrap();
    let copper_alias = resource_instance_for_family_at_tick(area_id, "cu", 0).unwrap();
    let copper_conductor = resource_instance_for_family_at_tick(area_id, "conductor", 0).unwrap();
    let iron = resource_instance_for_family_at_tick(area_id, "metal", 0).unwrap();

    assert_eq!(copper.item_id, RESOURCE_COPPER_ITEM_ID);
    assert_eq!(copper.family, "copper");
    assert_eq!(copper.spawn_id, format!("{area_id}:copper"));
    assert_eq!(copper_alias.spawn_id, copper.spawn_id);
    assert_eq!(copper_conductor.spawn_id, copper.spawn_id);
    assert!((220_000..230_000).contains(&copper.variant_id));
    assert_ne!(copper.seed, iron.seed);
    assert_ne!(copper.variant_id, iron.variant_id);
    assert!((500..=1_000).contains(&copper.stats.conductivity));
    assert_eq!(copper.stats.chemical_purity, 0);
    assert_eq!(copper.stats.flexibility, 0);
    assert_eq!(copper.stats.potency, 0);
    assert_eq!(copper.stats.nutrition, 0);
    assert!(copper.stats.malleability > 0);
    assert!(copper.stats.tensile_strength > 0);
    assert!(copper.stats.extraction_yield > 0);

    let reconstructed = resource_stats_for_item_variant(copper.item_id, copper.variant_id).unwrap();
    assert_eq!(copper.stats, reconstructed);
    let copper_spawn = active_resource_spawn_snapshots_for_area(area_id, 42)
        .into_iter()
        .find(|spawn| spawn.family == "copper")
        .expect("copper spawn is active");
    assert_eq!(copper_spawn.class_label, "Copper");
    assert_eq!(copper_spawn.variant_id, copper.variant_id);
    assert_eq!(copper_spawn.active_until_tick, None);

    let probe_cells = [
        AuthorityCell::new(0, 0),
        AuthorityCell::new(17, 31),
        AuthorityCell::new(137, -42),
        AuthorityCell::new(288, 96),
        AuthorityCell::new(511, 277),
        AuthorityCell::new(1_024, 1_024),
    ];
    let copper_field =
        probe_cells.map(|cell| resource_concentration_milli(copper.concentration_seed, cell));
    let iron_field =
        probe_cells.map(|cell| resource_concentration_milli(iron.concentration_seed, cell));
    assert!(copper_field.iter().all(|value| *value <= 1_000));
    assert!(copper_field.iter().any(|value| *value > 0));
    assert_ne!(
        copper_field, iron_field,
        "copper concentration should be derived from its own concentration seed"
    );
}

#[test]
fn authority_resource_spawn_concentration_seed_rotates_by_epoch_without_identity_drift() {
    let area_id = "authority-test-overworld";
    let first_epoch = resource_instance_for_family_at_tick(area_id, "metal", 0).unwrap();
    let second_epoch =
        resource_instance_for_family_at_tick(area_id, "metal", RESOURCE_SPAWN_EPOCH_TICKS).unwrap();
    let cell = AuthorityCell::new(137, -42);

    assert_eq!(resource_spawn_epoch(0), 0);
    assert_eq!(resource_spawn_epoch(RESOURCE_SPAWN_EPOCH_TICKS), 1);
    assert_eq!(first_epoch.seed, second_epoch.seed);
    assert_eq!(first_epoch.variant_id, second_epoch.variant_id);
    assert_eq!(first_epoch.stats, second_epoch.stats);
    assert_ne!(
        first_epoch.concentration_seed, second_epoch.concentration_seed,
        "prospecting field should shift on the resource epoch"
    );
    assert_ne!(
        resource_concentration_milli(first_epoch.concentration_seed, cell),
        resource_concentration_milli(second_epoch.concentration_seed, cell),
        "same cell should sample against the current epoch's field"
    );
}

#[test]
fn authority_survey_resource_resolves_copper_family() {
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
    let actor = state.actors.get(&player).expect("player exists").clone();

    let frame = state.apply_envelope(
        &config,
        command(
            1,
            ClientCommand::SurveyResource {
                family: "copper".to_owned(),
            },
        ),
    );

    assert_eq!(frame.status, AuthorityCommandStatus::Accepted);
    let survey = frame.survey_result.expect("survey result payload");
    assert_eq!(survey.family, "copper");
    assert_eq!(survey.area_id, actor.area_id);
    assert_eq!(survey.center_x, actor.cell.x);
    assert_eq!(survey.center_y, actor.cell.y);
    assert_eq!(
        survey.range_cells,
        actor.professions.craftsman_survey_range_cells()
    );
    assert_eq!(
        survey.step_cells,
        actor.professions.craftsman_survey_grid_step_cells()
    );
    assert!(
        survey.cols >= 3 && survey.cols % 2 == 1,
        "odd, centered survey grid"
    );
    assert_eq!(survey.rows, survey.cols);
    assert_eq!(
        survey.concentration_milli.len(),
        usize::from(survey.cols) * usize::from(survey.rows)
    );
    let resource =
        resource_instance_for_family_at_tick(&actor.area_id, "copper", survey.tick).unwrap();
    assert_eq!(survey.spawn_id, resource.spawn_id);
    assert_eq!(survey.spawn_name, resource.spawn_name);
    let center_index =
        usize::from(survey.rows / 2) * usize::from(survey.cols) + usize::from(survey.cols / 2);
    assert_eq!(
        survey.concentration_milli[center_index],
        state.resource_concentration_milli_for_area(
            &actor.area_id,
            resource.concentration_seed,
            actor.cell
        )
    );
}

#[test]
fn authority_survey_resource_returns_grid_payload_and_cooldown() {
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
    let actor = state.actors.get(&player).expect("player exists").clone();

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
    let survey = frame.survey_result.expect("survey result payload");
    assert_eq!(survey.family, "metal");
    assert_eq!(survey.area_id, actor.area_id);
    assert_eq!(survey.center_x, actor.cell.x);
    assert_eq!(survey.center_y, actor.cell.y);
    assert_eq!(
        survey.range_cells,
        actor.professions.craftsman_survey_range_cells()
    );
    assert_eq!(
        survey.step_cells,
        actor.professions.craftsman_survey_grid_step_cells()
    );
    assert!(
        survey.cols >= 3 && survey.cols % 2 == 1,
        "odd, centered survey grid"
    );
    assert_eq!(survey.rows, survey.cols);
    assert_eq!(
        survey.concentration_milli.len(),
        usize::from(survey.cols) * usize::from(survey.rows)
    );
    assert_eq!(
        survey.cooldown_until_tick,
        survey
            .tick
            .saturating_add(state.economy_action_ticks(RESOURCE_SURVEY_ACTION_MS))
    );
    assert_eq!(survey.tick, frame.tick);
    let resource =
        resource_instance_for_family_at_tick(&actor.area_id, "metal", survey.tick).unwrap();
    assert_eq!(survey.spawn_id, resource.spawn_id);
    assert_eq!(survey.spawn_name, resource.spawn_name);
    let center_index =
        usize::from(survey.rows / 2) * usize::from(survey.cols) + usize::from(survey.cols / 2);
    assert_eq!(
        survey.concentration_milli[center_index],
        state.resource_concentration_milli_for_area(
            &actor.area_id,
            resource.concentration_seed,
            actor.cell
        )
    );
    assert!(state
        .timeline_event_snapshots()
        .iter()
        .any(|event| event.label.contains("surveyed")));
}

#[test]
fn authority_survey_and_sample_use_independent_cooldown_lanes() {
    let config = SliceAuthorityConfig::default();
    let snapshot = crate::authority_test_slice();
    let player = config.player_actor_id.clone();
    let prepare = |state: &mut SliceAuthorityState| {
        grant_test_profession(state, &player, AuthorityProfessionKind::Craftsman);
        seed_test_tool(state, &player, FIELD_MULTITOOL_ITEM_ID, "Field Multitool");
        seed_test_survey_tool(state, &player);
    };

    let mut survey_then_sample = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    prepare(&mut survey_then_sample);
    let survey = survey_then_sample.apply_envelope(
        &config,
        command(
            1,
            ClientCommand::SurveyResource {
                family: "mineral".to_owned(),
            },
        ),
    );
    assert_eq!(survey.status, AuthorityCommandStatus::Accepted);
    let sample_after_survey = survey_then_sample.apply_envelope(
        &config,
        command(
            2,
            ClientCommand::SampleResource {
                family: "mineral".to_owned(),
                stop: false,
            },
        ),
    );
    assert_eq!(
        sample_after_survey.status,
        AuthorityCommandStatus::Accepted,
        "survey cooldown must not block immediate sample"
    );
    let actor = survey_then_sample.actors.get(&player).unwrap();
    assert!(actor.next_resource_survey_tick > survey_then_sample.tick());
    assert!(actor.next_economy_action_tick > survey_then_sample.tick());
    let repeat_survey = survey_then_sample.apply_envelope(
        &config,
        command(
            3,
            ClientCommand::SurveyResource {
                family: "mineral".to_owned(),
            },
        ),
    );
    assert_eq!(repeat_survey.status, AuthorityCommandStatus::Rejected);
    assert_eq!(
        repeat_survey.reason_code.as_deref(),
        Some("economy_cooldown")
    );

    let mut sample_then_survey = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    prepare(&mut sample_then_survey);
    let sample = sample_then_survey.apply_envelope(
        &config,
        command(
            1,
            ClientCommand::SampleResource {
                family: "mineral".to_owned(),
                stop: false,
            },
        ),
    );
    assert_eq!(sample.status, AuthorityCommandStatus::Accepted);
    let survey_after_sample = sample_then_survey.apply_envelope(
        &config,
        command(
            2,
            ClientCommand::SurveyResource {
                family: "mineral".to_owned(),
            },
        ),
    );
    assert_eq!(
        survey_after_sample.status,
        AuthorityCommandStatus::Accepted,
        "sample cooldown must not block immediate survey"
    );
    let repeat_sample = sample_then_survey.apply_envelope(
        &config,
        command(
            3,
            ClientCommand::SampleResource {
                family: "mineral".to_owned(),
                stop: false,
            },
        ),
    );
    assert_eq!(repeat_sample.status, AuthorityCommandStatus::Rejected);
    assert_eq!(
        repeat_sample.reason_code.as_deref(),
        Some("sample_cooldown")
    );
}

#[test]
fn authority_clodpowder_inherits_relevant_stats_from_source_bone() {
    let bone_variant_id = 330_001;
    let bone =
        resource_stats_for_item_variant(RESOURCE_CREATURE_BONE_ITEM_ID, bone_variant_id).unwrap();
    let powder = clodpowder_resource_instance_from_bone_variant(bone_variant_id);
    let reconstructed =
        resource_stats_for_item_variant(RESOURCE_CLODPOWDER_ITEM_ID, powder.variant_id).unwrap();

    assert_eq!(powder.stats, reconstructed);
    assert_eq!(reconstructed.chemical_purity, bone.chemical_purity);
    assert_eq!(reconstructed.potency, bone.potency);
    assert_eq!(reconstructed.stability, bone.stability);
    assert_eq!(reconstructed.extraction_yield, bone.extraction_yield);
    assert_eq!(reconstructed.tensile_strength, 0);
    assert_eq!(reconstructed.nutrition, 0);
}

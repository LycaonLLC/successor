const CORPSE_TEST_LOOT_ITEM_ID: u32 = FIELD_BANDAGE_ITEM_ID;
const CORPSE_TEST_LOOT_VARIANT_ID: u32 = 0;
const CORPSE_TEST_LOOT_QUANTITY: u32 = 37;

fn take_loot_corpse_state() -> (SliceAuthorityConfig, SliceAuthorityState) {
    let config = SliceAuthorityConfig::default();
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
        "loot-trooper",
        "Loot Trooper",
        "skirmisher",
        CellSnapshot::new(11, 10),
        "left",
    ));
    let mut state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    state.inventory.clear();
    state.inventory_stack_counters.clear();
    let tick = state.tick();
    {
        let corpse = state.actors.get_mut("loot-trooper").unwrap();
        corpse.life_state = AuthorityLifeState::Downed;
        corpse.body_vanish_tick = tick.saturating_add(10_000);
        corpse.loot_rights_actor_id = None;
        corpse.corpse_exhausted_tick = None;
    }
    push_test_inventory_stack(
        &mut state,
        "corpse:loot-trooper",
        CORPSE_TEST_LOOT_ITEM_ID,
        CORPSE_TEST_LOOT_VARIANT_ID,
        CORPSE_TEST_LOOT_QUANTITY,
    );
    (config, state)
}

fn take_loot_item_command(quantity: i32) -> ClientCommand {
    ClientCommand::TakeLootItem {
        container: "corpse:loot-trooper".to_owned(),
        item_id: CORPSE_TEST_LOOT_ITEM_ID,
        variant_id: CORPSE_TEST_LOOT_VARIANT_ID,
        quantity,
    }
}

fn available_in_container(
    state: &SliceAuthorityState,
    container: &str,
    item_id: u32,
    variant_id: u32,
) -> u32 {
    state
        .inventory_snapshots()
        .iter()
        .filter(|row| {
            row.container == container && row.item_id == item_id && row.variant_id == variant_id
        })
        .map(|row| row.available)
        .sum()
}

#[test]
fn corpse_lifecycle_damage_rights_use_human_player_ledger_only() {
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
        "game-ws-rival",
        "Rival",
        "player",
        CellSnapshot::new(10, 11),
        "right",
    ));
    snapshot.actors.push(test_actor(
        "agent-bot",
        "Agent Bot",
        "agent_player",
        CellSnapshot::new(10, 12),
        "right",
    ));
    snapshot.actors.push(test_actor(
        "rights-target",
        "Rights Target",
        "skirmisher",
        CellSnapshot::new(11, 10),
        "left",
    ));
    let mut state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    let tick = state.tick();

    state.record_damage_stats("agent-bot", "rights-target", tick, 200, false);
    state.record_damage_stats("player", "rights-target", tick, 7, false);
    state.record_damage_stats(
        "game-ws-rival",
        "rights-target",
        tick.saturating_add(1),
        7,
        false,
    );
    {
        let tick_rate_hz = state.tick_rate_hz;
        let target = state.actors.get_mut("rights-target").unwrap();
        SliceAuthorityState::kill_actor_for_respawn(tick.saturating_add(2), tick_rate_hz, target);
    }

    let corpse = state.actors.get("rights-target").unwrap();
    assert_eq!(corpse.loot_rights_actor_id.as_deref(), Some("player"));
    assert_eq!(corpse.player_damage_ledger.len(), 2);
}

#[test]
fn corpse_lifecycle_no_loot_vanish_then_respawn_timer_starts() {
    let (config, mut state) = take_loot_corpse_state();
    state.inventory.clear();
    let death_tick = state.tick();
    {
        let tick_rate_hz = state.tick_rate_hz;
        let actor = state.actors.get_mut("loot-trooper").unwrap();
        actor.role = "npc".to_owned();
        actor.life_state = AuthorityLifeState::Alive;
        SliceAuthorityState::kill_actor_for_respawn(death_tick, tick_rate_hz, actor);
    }

    let corpse = state.actors.get("loot-trooper").unwrap();
    assert_eq!(
        corpse.body_vanish_tick,
        death_tick + CORPSE_BODY_NO_LOOT_TICKS
    );
    assert_eq!(corpse.respawn_tick, 0);

    // Simulate a restored legacy snapshot that eagerly counted respawn while
    // the corpse was still visible. Vanish must replace, not preserve, it.
    state.actors.get_mut("loot-trooper").unwrap().respawn_tick =
        death_tick + CORPSE_BODY_NO_LOOT_TICKS + 1;

    advance_ticks_unclamped(&mut state, &config, CORPSE_BODY_NO_LOOT_TICKS);
    let hidden = state.actors.get("loot-trooper").unwrap();
    assert_eq!(hidden.life_state, AuthorityLifeState::Respawning);
    assert_eq!(hidden.body_vanish_tick, 0);
    assert_eq!(
        hidden.respawn_tick,
        death_tick + CORPSE_BODY_NO_LOOT_TICKS + CORPSE_BODY_NO_LOOT_TICKS
    );
}

#[test]
fn corpse_lifecycle_loot_body_uses_five_minutes_and_poofs_on_vanish() {
    let (config, mut state) = take_loot_corpse_state();
    let death_tick = state.tick();
    state.finalize_actor_corpse_after_death("loot-trooper", death_tick);

    let corpse = state.actor_snapshot("loot-trooper").unwrap();
    assert!(corpse.lootable);
    assert!(corpse.has_loot);
    assert_eq!(
        corpse.body_vanish_tick,
        death_tick + CORPSE_BODY_WITH_LOOT_TICKS
    );
    assert_eq!(corpse.respawn_tick, 0);

    advance_ticks_unclamped(&mut state, &config, CORPSE_BODY_WITH_LOOT_TICKS);
    let hidden = state.actors.get("loot-trooper").unwrap();
    assert_eq!(hidden.life_state, AuthorityLifeState::Respawning);
    assert_eq!(hidden.body_vanish_tick, 0);
    assert_eq!(
        hidden.respawn_tick,
        death_tick + CORPSE_BODY_WITH_LOOT_TICKS + CORPSE_BODY_NO_LOOT_TICKS
    );
    assert_eq!(
        available_in_container(
            &state,
            "corpse:loot-trooper",
            CORPSE_TEST_LOOT_ITEM_ID,
            CORPSE_TEST_LOOT_VARIANT_ID
        ),
        0
    );
}

#[test]
fn corpse_lifecycle_exhaustion_schedules_body_then_starts_respawn_at_vanish() {
    let (config, mut state) = take_loot_corpse_state();
    let take = state.apply_envelope(&config, command(1, take_loot_item_command(37)));

    assert_eq!(take.status, AuthorityCommandStatus::Accepted);
    let corpse = state.actors.get("loot-trooper").unwrap();
    assert_eq!(corpse.corpse_exhausted_tick, Some(take.tick));
    assert_eq!(
        corpse.body_vanish_tick,
        take.tick + CORPSE_EXHAUSTED_CLAMP_TICKS
    );
    assert_eq!(corpse.respawn_tick, 0);

    advance_ticks_unclamped(&mut state, &config, CORPSE_EXHAUSTED_CLAMP_TICKS);
    let hidden = state.actors.get("loot-trooper").unwrap();
    assert_eq!(hidden.life_state, AuthorityLifeState::Respawning);
    assert_eq!(hidden.body_vanish_tick, 0);
    assert_eq!(
        hidden.respawn_tick,
        take.tick + CORPSE_EXHAUSTED_CLAMP_TICKS + CORPSE_BODY_NO_LOOT_TICKS
    );
}

#[test]
fn corpse_lifecycle_player_real_death_respawns_without_lootable_corpse() {
    let (_config, mut state) = take_loot_corpse_state();
    let death_tick = state.tick();
    {
        let tick_rate_hz = state.tick_rate_hz;
        let player = state.actors.get_mut("player").unwrap();
        SliceAuthorityState::kill_actor_for_respawn(death_tick, tick_rate_hz, player);
    }

    let snapshot = state.actor_snapshot("player").unwrap();
    assert_eq!(snapshot.life_state, AuthorityLifeState::Respawning);
    assert_eq!(snapshot.body_vanish_tick, 0);
    assert_eq!(snapshot.respawn_tick, death_tick + SESSION_RESPAWN_TICKS);
    assert!(!snapshot.lootable);
    assert!(!snapshot.has_loot);
}

#[test]
fn take_loot_item_transfers_exact_quantity_from_corpse() {
    let (config, mut state) = take_loot_corpse_state();
    let blocked_until = state.tick().saturating_add(999);
    state
        .actors
        .get_mut("player")
        .unwrap()
        .next_economy_action_tick = blocked_until;

    let take = state.apply_envelope(&config, command(1, take_loot_item_command(37)));

    assert_eq!(take.status, AuthorityCommandStatus::Accepted);
    assert_eq!(
        state.actor_inventory_available_quantity("player", CORPSE_TEST_LOOT_ITEM_ID),
        CORPSE_TEST_LOOT_QUANTITY
    );
    assert_eq!(
        available_in_container(
            &state,
            "corpse:loot-trooper",
            CORPSE_TEST_LOOT_ITEM_ID,
            CORPSE_TEST_LOOT_VARIANT_ID
        ),
        0
    );
    assert_eq!(
        state
            .actors
            .get("loot-trooper")
            .unwrap()
            .corpse_exhausted_tick,
        Some(take.tick)
    );
    assert!(state.timeline_event_snapshots().iter().any(|event| event
        .label
        .contains("player took Field Bandage x37 from corpse:loot-trooper")));
}

#[test]
fn take_loot_item_partial_quantity_leaves_remainder() {
    let (config, mut state) = take_loot_corpse_state();

    let take = state.apply_envelope(&config, command(1, take_loot_item_command(12)));

    assert_eq!(take.status, AuthorityCommandStatus::Accepted);
    assert_eq!(
        state.actor_inventory_available_quantity("player", CORPSE_TEST_LOOT_ITEM_ID),
        12
    );
    assert_eq!(
        available_in_container(
            &state,
            "corpse:loot-trooper",
            CORPSE_TEST_LOOT_ITEM_ID,
            CORPSE_TEST_LOOT_VARIANT_ID
        ),
        25
    );
    assert_eq!(
        state
            .actors
            .get("loot-trooper")
            .unwrap()
            .corpse_exhausted_tick,
        None
    );
}

#[test]
fn take_loot_item_rejects_out_of_range() {
    let (config, mut state) = take_loot_corpse_state();
    place_actor_at_position(
        &mut state,
        "player",
        AuthorityPosition {
            x: 10_000,
            y: 10_000,
        },
    );
    place_actor_at_position(
        &mut state,
        "loot-trooper",
        AuthorityPosition {
            x: 12_000,
            y: 10_000,
        },
    );

    let take = state.apply_envelope(&config, command(1, take_loot_item_command(1)));

    assert_eq!(take.status, AuthorityCommandStatus::Rejected);
    assert_eq!(take.reason_code.as_deref(), Some("loot_out_of_range"));
}

#[test]
fn take_loot_item_rejects_wrong_rights() {
    let (config, mut state) = take_loot_corpse_state();
    state
        .actors
        .get_mut("loot-trooper")
        .unwrap()
        .loot_rights_actor_id = Some("other-player".to_owned());

    let take = state.apply_envelope(&config, command(1, take_loot_item_command(1)));

    assert_eq!(take.status, AuthorityCommandStatus::Rejected);
    assert_eq!(take.reason_code.as_deref(), Some("loot_no_rights"));
}

#[test]
fn take_loot_item_rejects_unknown_target() {
    let (config, mut state) = take_loot_corpse_state();

    let take = state.apply_envelope(
        &config,
        command(
            1,
            ClientCommand::TakeLootItem {
                container: "corpse:missing".to_owned(),
                item_id: CORPSE_TEST_LOOT_ITEM_ID,
                variant_id: CORPSE_TEST_LOOT_VARIANT_ID,
                quantity: 1,
            },
        ),
    );

    assert_eq!(take.status, AuthorityCommandStatus::Rejected);
    assert_eq!(take.reason_code.as_deref(), Some("loot_target_unknown"));
}

#[test]
fn take_loot_item_rejects_not_lootable_target() {
    let (config, mut state) = take_loot_corpse_state();
    state.actors.get_mut("loot-trooper").unwrap().life_state = AuthorityLifeState::Alive;

    let take = state.apply_envelope(&config, command(1, take_loot_item_command(1)));

    assert_eq!(take.status, AuthorityCommandStatus::Rejected);
    assert_eq!(take.reason_code.as_deref(), Some("loot_not_lootable"));
}

#[test]
fn take_loot_item_rejects_missing_stack() {
    let (config, mut state) = take_loot_corpse_state();

    let take = state.apply_envelope(
        &config,
        command(
            1,
            ClientCommand::TakeLootItem {
                container: "corpse:loot-trooper".to_owned(),
                item_id: CORPSE_TEST_LOOT_ITEM_ID,
                variant_id: 7,
                quantity: 1,
            },
        ),
    );

    assert_eq!(take.status, AuthorityCommandStatus::Rejected);
    assert_eq!(take.reason_code.as_deref(), Some("loot_missing_stack"));
}

#[test]
fn take_loot_item_rejects_invalid_quantity() {
    let (config, mut state) = take_loot_corpse_state();

    let zero = state.apply_envelope(&config, command(1, take_loot_item_command(0)));
    let negative = state.apply_envelope(&config, command(2, take_loot_item_command(-3)));

    assert_eq!(zero.status, AuthorityCommandStatus::Rejected);
    assert_eq!(zero.reason_code.as_deref(), Some("loot_invalid_quantity"));
    assert_eq!(negative.status, AuthorityCommandStatus::Rejected);
    assert_eq!(
        negative.reason_code.as_deref(),
        Some("loot_invalid_quantity")
    );
}

#[test]
fn take_loot_item_rejects_insert_into_corpse_container() {
    let (config, mut state) = take_loot_corpse_state();
    let stack_id = state
        .inventory_snapshots()
        .iter()
        .find(|row| row.container == "corpse:loot-trooper")
        .unwrap()
        .stack_id
        .to_string();

    let split = state.apply_envelope(
        &config,
        command(
            1,
            ClientCommand::SplitStack {
                container: "corpse:loot-trooper".to_owned(),
                stack_id,
                item_id: CORPSE_TEST_LOOT_ITEM_ID,
                variant_id: CORPSE_TEST_LOOT_VARIANT_ID,
                quantity: 1,
            },
        ),
    );

    assert_eq!(split.status, AuthorityCommandStatus::Rejected);
    assert_eq!(split.reason_code.as_deref(), Some("item_unavailable"));
    assert_eq!(
        available_in_container(
            &state,
            "corpse:loot-trooper",
            CORPSE_TEST_LOOT_ITEM_ID,
            CORPSE_TEST_LOOT_VARIANT_ID
        ),
        CORPSE_TEST_LOOT_QUANTITY
    );
}

#[test]
fn harvest_corpse_creature_marks_exhaustion_without_hiding_body() {
    let config = SliceAuthorityConfig::default();
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
        "harvest-creature",
        "Harvest PassiveCreature",
        "creature",
        CellSnapshot::new(11, 10),
        "front",
    ));
    let mut state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    {
        let tick = state.tick();
        let creature = state.actors.get_mut("harvest-creature").unwrap();
        creature.life_state = AuthorityLifeState::Downed;
        creature.body_vanish_tick = tick.saturating_add(10_000);
        creature
            .gaia_harvest_entitled_actor_ids
            .insert("player".to_owned());
    }

    let harvest = state.apply_envelope(
        &config,
        command(
            1,
            ClientCommand::HarvestCorpse {
                target_actor_id: "harvest-creature".to_owned(),
            },
        ),
    );

    assert_eq!(harvest.status, AuthorityCommandStatus::Accepted);
    let creature = state.actors.get("harvest-creature").unwrap();
    assert_eq!(creature.life_state, AuthorityLifeState::Downed);
    assert_eq!(creature.corpse_exhausted_tick, Some(harvest.tick));
    assert_eq!(
        creature.body_vanish_tick,
        harvest.tick + CREATURE_CORPSE_EXHAUSTED_LINGER_TICKS
    );
    assert_eq!(creature.respawn_tick, 0);
    assert!(state.actor_inventory_available_quantity("player", RESOURCE_CREATURE_BONE_ITEM_ID) > 0);

    advance_ticks_unclamped(
        &mut state,
        &config,
        CREATURE_CORPSE_EXHAUSTED_LINGER_TICKS.saturating_sub(1),
    );
    let corpse = state.actors.get("harvest-creature").unwrap();
    assert_eq!(corpse.life_state, AuthorityLifeState::Downed);
    assert_eq!(corpse.respawn_tick, 0);

    advance_ticks_unclamped(&mut state, &config, 1);
    let hidden = state.actors.get("harvest-creature").unwrap();
    assert_eq!(hidden.life_state, AuthorityLifeState::Respawning);
    assert_eq!(hidden.body_vanish_tick, 0);
    assert_eq!(
        hidden.respawn_tick,
        harvest.tick + CREATURE_CORPSE_EXHAUSTED_LINGER_TICKS + CORPSE_BODY_NO_LOOT_TICKS
    );
}

#[test]
fn authority_storm_kill_freezes_gaia_rights_and_allows_full_harvest() {
    let (config, mut state) = creature_harvest_test_state("storm-gaia", CellSnapshot::new(11, 10));
    {
        let creature = state.actors.get_mut("storm-gaia").unwrap();
        creature.life_state = AuthorityLifeState::Alive;
        creature.vitals.health = 1;
        creature.max_vitals.health = 100;
    }
    state
        .actors
        .get_mut("player")
        .unwrap()
        .professions
        .learned
        .insert(AuthorityProfessionKind::Brawler);
    state
        .actors
        .get_mut("player")
        .unwrap()
        .professions
        .learned
        .insert(AuthorityProfessionKind::Marksman);
    let death_tick = state.tick();
    SliceAuthorityState::record_player_damage_for_loot_rights(
        state.actors.get_mut("storm-gaia").unwrap(),
        "player",
        death_tick,
        25,
    );
    state.advance_ticks_for_observer_with_weather_hazards(
        &config,
        1,
        &[weather_test_hazard(Vec::new())],
    );
    let corpse = state.actors.get("storm-gaia").unwrap();
    assert_eq!(corpse.life_state, AuthorityLifeState::Downed);
    assert!(corpse.gaia_harvest_entitled_actor_ids.contains("player"));
    let professions = &state.actors["player"].professions;
    let combat_xp = [
        AuthorityProfessionKind::Brawler,
        AuthorityProfessionKind::Marksman,
    ]
    .iter()
    .flat_map(|profession| {
        ["melee", "rifle", "guard", "movement-speed", "attack-speed"]
            .iter()
            .map(|track| professions.track_xp_amount(*profession, track))
    })
    .sum::<u64>();
    assert!(combat_xp > 0);
    let harvest = state.apply_envelope(
        &config,
        command(
            1,
            ClientCommand::HarvestCorpse {
                target_actor_id: "storm-gaia".to_owned(),
            },
        ),
    );
    assert_eq!(harvest.status, AuthorityCommandStatus::Accepted);
    assert!(state.actor_inventory_available_quantity("player", RESOURCE_CREATURE_BONE_ITEM_ID) > 0);
}

#[test]
fn authority_bleed_kill_awards_gaia_combat_xp_before_harvest() {
    let (config, mut state) = creature_harvest_test_state("bleed-gaia", CellSnapshot::new(11, 10));
    state
        .actors
        .get_mut("player")
        .unwrap()
        .professions
        .learned
        .insert(AuthorityProfessionKind::Brawler);
    let death_tick = state.tick();
    {
        state.actors.get_mut("player").unwrap().equipped_weapon_id = None;
        let creature = state.actors.get_mut("bleed-gaia").unwrap();
        creature.life_state = AuthorityLifeState::Alive;
        creature.vitals.health = 1;
        creature.max_vitals.health = 100;
        SliceAuthorityState::record_player_damage_for_loot_rights(
            creature, "player", death_tick, 25,
        );
        creature.bleed_stacks.push(BleedStackAuthorityState {
            damage_milli_per_tick: 1_000,
            accumulated_damage_milli: 0,
            source_actor_id: "player".to_owned(),
            remaining_ticks: 2,
        });
    }
    state.advance_ticks_for_observer(&config, 1);
    assert!(state.actors["bleed-gaia"]
        .gaia_harvest_entitled_actor_ids
        .contains("player"));
    assert_eq!(state.actors["bleed-gaia"].player_damage_ledger.len(), 1);
    assert!(
        state.actors["player"]
            .professions
            .track_xp_amount(AuthorityProfessionKind::Brawler, "melee")
            > 0
    );
}

fn creature_harvest_test_state(
    target_id: &str,
    cell: CellSnapshot,
) -> (SliceAuthorityConfig, SliceAuthorityState) {
    let config = SliceAuthorityConfig::default();
    let mut snapshot = crate::authority_test_slice();
    snapshot.actors.clear();
    snapshot.npc_jobs.clear();
    snapshot.inventory.clear();
    snapshot.actors.push(test_actor(
        "player",
        "Player",
        "player",
        cell.clone(),
        "right",
    ));
    snapshot.actors.push(test_actor(
        target_id,
        "Harvest Bellback",
        "creature",
        cell,
        "front",
    ));
    let mut state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    let vanish_tick = state.tick().saturating_add(10_000);
    let creature = state.actors.get_mut(target_id).unwrap();
    creature.life_state = AuthorityLifeState::Downed;
    creature.body_vanish_tick = vanish_tick;
    creature
        .gaia_harvest_entitled_actor_ids
        .insert("player".to_owned());
    (config, state)
}

fn creature_harvest_extreme_cell_for_test(
    material: CreatureMaterial,
    high: bool,
) -> (CellSnapshot, u16) {
    let state = SliceAuthorityState::from_snapshot(&crate::authority_test_slice()).unwrap();
    let area_id = crate::AUTHORITY_TEST_AREA_ID;
    let seed = creature_harvest_concentration_seed(area_id, material);
    let mut best_cell = CellSnapshot::new(0, 0);
    let mut best_concentration = if high { 0 } else { u16::MAX };
    for y in 0..64 {
        for x in 0..64 {
            let cell = AuthorityCell::new(x, y);
            let concentration = state.resource_concentration_milli_for_area(area_id, seed, cell);
            if (high && concentration > best_concentration)
                || (!high && concentration < best_concentration)
            {
                best_cell = CellSnapshot::new(x, y);
                best_concentration = concentration;
            }
        }
    }
    (best_cell, best_concentration)
}

fn expected_creature_harvest_quantity(
    state: &SliceAuthorityState,
    actor_id: &str,
    target_id: &str,
    material: CreatureMaterial,
) -> u32 {
    let target = state.runtime.durable.actors.get(target_id).unwrap();
    let actor = state.runtime.durable.actors.get(actor_id).unwrap();
    let seed = creature_harvest_concentration_seed(&target.area_id, material);
    let concentration =
        state.resource_concentration_milli_for_area(&target.area_id, seed, target.cell);
    let harvest_bonus_milli = u32::try_from(
        1_000_i32.saturating_add(
            actor
                .professions
                .scout_creature_harvesting_bonus()
                .saturating_mul(2),
        ),
    )
    .unwrap_or(1_000);
    creature_harvest_quantity_from_concentration(concentration, harvest_bonus_milli)
}
#[test]
fn creature_harvest_quantity_bounds() {
    assert_eq!(
        creature_harvest_quantity_from_concentration(0, 1_000),
        CREATURE_HARVEST_MIN_QUANTITY
    );
    assert_eq!(
        creature_harvest_quantity_from_concentration(1_000, 2_000),
        CREATURE_HARVEST_MAX_QUANTITY
    );
}

#[test]
fn creature_harvest_yield_scales_with_hidden_concentration() {
    let (low_cell, low_concentration) =
        creature_harvest_extreme_cell_for_test(CreatureMaterial::Meat, false);
    let (high_cell, high_concentration) =
        creature_harvest_extreme_cell_for_test(CreatureMaterial::Meat, true);
    assert!(high_concentration > low_concentration);

    let (config, mut low_state) = creature_harvest_test_state("creature-low", low_cell);
    let low_expected = expected_creature_harvest_quantity(
        &low_state,
        "player",
        "creature-low",
        CreatureMaterial::Meat,
    );
    let low = low_state.apply_envelope(
        &config,
        command(
            1,
            ClientCommand::HarvestCorpse {
                target_actor_id: "creature-low".to_owned(),
            },
        ),
    );
    assert_eq!(low.status, AuthorityCommandStatus::Accepted);

    let (config, mut high_state) = creature_harvest_test_state("creature-high", high_cell);
    let high_expected = expected_creature_harvest_quantity(
        &high_state,
        "player",
        "creature-high",
        CreatureMaterial::Meat,
    );
    let high = high_state.apply_envelope(
        &config,
        command(
            1,
            ClientCommand::HarvestCorpse {
                target_actor_id: "creature-high".to_owned(),
            },
        ),
    );
    assert_eq!(high.status, AuthorityCommandStatus::Accepted);

    assert_eq!(
        low_state.actor_inventory_available_quantity("player", RESOURCE_CREATURE_MEAT_ITEM_ID),
        low_expected
    );
    assert_eq!(
        high_state.actor_inventory_available_quantity("player", RESOURCE_CREATURE_MEAT_ITEM_ID),
        high_expected
    );
    assert!(high_expected > low_expected);
}

#[test]
fn creature_harvest_all_families_consumes_one_corpse_budget() {
    let (config, mut state) =
        creature_harvest_test_state("single-pick-creature", CellSnapshot::new(11, 10));
    let harvest = state.apply_envelope(
        &config,
        command(
            1,
            ClientCommand::HarvestCorpse {
                target_actor_id: "single-pick-creature".to_owned(),
            },
        ),
    );
    assert_eq!(harvest.status, AuthorityCommandStatus::Accepted);
    for item_id in [
        RESOURCE_CREATURE_HIDE_ITEM_ID,
        RESOURCE_CREATURE_MEAT_ITEM_ID,
        RESOURCE_CREATURE_BONE_ITEM_ID,
    ] {
        assert!(state.actor_inventory_available_quantity("player", item_id) >= 5);
    }

    let second = state.apply_envelope(
        &config,
        command(
            2,
            ClientCommand::HarvestCorpse {
                target_actor_id: "single-pick-creature".to_owned(),
            },
        ),
    );
    assert_eq!(second.status, AuthorityCommandStatus::Rejected);
    assert_eq!(
        second.reason_code.as_deref(),
        Some("target_not_harvestable")
    );
    assert_eq!(
        state
            .actors
            .get("single-pick-creature")
            .unwrap()
            .creature_corpse_harvested_tick,
        Some(harvest.tick)
    );
}

#[test]
fn creature_harvest_never_extends_an_earlier_body_deadline() {
    let (config, mut state) =
        creature_harvest_test_state("late-harvest-creature", CellSnapshot::new(11, 10));
    let earlier_vanish_tick = state.tick().saturating_add(120);
    state
        .actors
        .get_mut("late-harvest-creature")
        .unwrap()
        .body_vanish_tick = earlier_vanish_tick;

    let harvest = state.apply_envelope(
        &config,
        command(
            1,
            ClientCommand::HarvestCorpse {
                target_actor_id: "late-harvest-creature".to_owned(),
            },
        ),
    );

    assert_eq!(harvest.status, AuthorityCommandStatus::Accepted);
    let corpse = state.actors.get("late-harvest-creature").unwrap();
    assert_eq!(corpse.life_state, AuthorityLifeState::Downed);
    assert_eq!(corpse.body_vanish_tick, earlier_vanish_tick);
    assert_eq!(corpse.respawn_tick, 0);

    advance_ticks_unclamped(&mut state, &config, 120);
    let hidden = state.actors.get("late-harvest-creature").unwrap();
    assert_eq!(hidden.life_state, AuthorityLifeState::Respawning);
    assert_eq!(hidden.body_vanish_tick, 0);
    assert_eq!(
        hidden.respawn_tick,
        earlier_vanish_tick + CORPSE_BODY_NO_LOOT_TICKS
    );
}

#[test]
fn gaia_creature_is_harvestable_passive_and_non_aggressive() {
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
        "gaia-bellback",
        "Bellback",
        "creature",
        CellSnapshot::new(11, 10),
        "front",
    ));
    snapshot.actors.push(test_actor(
        "neutral-npc",
        "Neutral NPC",
        "skirmisher_brawler",
        CellSnapshot::new(12, 10),
        "left",
    ));
    add_test_factions(&mut snapshot);
    let state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    let player = state.actors.get("player").unwrap();
    let creature = state.actors.get("gaia-bellback").unwrap();
    let npc = state.actors.get("neutral-npc").unwrap();

    assert!(is_harvestable_creature_actor(creature));
    assert!(!is_harvestable_creature_actor(player));
    // Calm Bellback is proactive (red name) but has not locked a target yet, so
    // attack permission stays closed until Engage focuses a living player.
    assert!(!state.can_actor_attack(creature, player));
    assert!(!state.can_actor_attack(creature, npc));
    assert!(actor_will_auto_aggro(creature));
    assert_eq!(derive_actor_descriptor(creature), "a bellback");
}

#[test]
fn creature_species_descriptors_are_sprite_specific() {
    let mut snapshot = crate::authority_test_slice();
    snapshot.actors.clear();
    snapshot.npc_jobs.clear();
    snapshot.inventory.clear();
    snapshot.actors.push(test_actor(
        "creature",
        "Creature",
        "creature",
        CellSnapshot::new(10, 10),
        "right",
    ));
    let mut state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    let expected = [
        ("creature-bellback-adult", "a bellback"),
        ("creature-pebblehorn-adult", "a pebblehorn"),
        ("creature-snufflefin-adult", "a snufflefin"),
        ("creature-pocketclod-adult", "a pocketclod"),
        ("creature-mossmuff-adult", "a mossmuff"),
        ("creature-dapplepod-adult", "a dapplepod"),
    ];
    for (sprite, descriptor) in expected {
        let creature = state.actors.get_mut("creature").unwrap();
        creature.sprite = sprite.to_owned();
        assert_eq!(derive_actor_descriptor(creature), descriptor);
    }
}
#[test]
fn creature_species_resource_variants_separate_by_sprite() {
    let mut snapshot = crate::authority_test_slice();
    snapshot.actors.clear();
    snapshot.npc_jobs.clear();
    snapshot.inventory.clear();
    snapshot.actors.push(test_actor(
        "creature",
        "Creature",
        "creature",
        CellSnapshot::new(10, 10),
        "right",
    ));
    let state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    let mut bellback = state.actors.get("creature").unwrap().clone();
    let mut pebblehorn = bellback.clone();
    bellback.sprite = "creature-bellback-adult".to_owned();
    pebblehorn.sprite = "creature-pebblehorn-adult".to_owned();
    let bellback_hide = creature_resource_instance(&bellback, CreatureMaterial::Hide, 0);
    let pebblehorn_hide = creature_resource_instance(&pebblehorn, CreatureMaterial::Hide, 0);
    assert_ne!(bellback_hide.variant_id, pebblehorn_hide.variant_id);
    assert_eq!(bellback_hide.short_label, "Bellback hide");
    assert_eq!(pebblehorn_hide.short_label, "Pebblehorn hide");
}

#[test]
fn creature_harvest_is_universal_but_only_trained_scouts_gain_xp_and_yield_depth() {
    let probe = SliceAuthorityState::from_snapshot(&crate::authority_test_slice()).unwrap();
    let area_id = crate::AUTHORITY_TEST_AREA_ID;
    let seed = creature_harvest_concentration_seed(area_id, CreatureMaterial::Hide);
    let mut test_cell = None;
    'cells: for y in 0..64 {
        for x in 0..64 {
            let cell = AuthorityCell::new(x, y);
            let concentration = probe.resource_concentration_milli_for_area(area_id, seed, cell);
            if (250..=650).contains(&concentration) {
                test_cell = Some(CellSnapshot::new(x, y));
                break 'cells;
            }
        }
    }
    let test_cell = test_cell.expect("test area exposes a mid-concentration harvest cell");

    let (untrained_config, mut untrained) =
        creature_harvest_test_state("untrained-creature", test_cell.clone());
    let untrained_harvest = untrained.apply_envelope(
        &untrained_config,
        command(
            1,
            ClientCommand::HarvestCorpse {
                target_actor_id: "untrained-creature".to_owned(),
            },
        ),
    );
    assert_eq!(untrained_harvest.status, AuthorityCommandStatus::Accepted);
    let untrained_hide =
        untrained.actor_inventory_available_quantity("player", RESOURCE_CREATURE_HIDE_ITEM_ID);
    assert!(
        untrained_hide > 0,
        "universal harvesting still yields materials"
    );
    let untrained_actor = &untrained.actors["player"];
    assert_eq!(
        untrained_actor
            .professions
            .xp
            .get(&AuthorityProfessionKind::Scout)
            .copied()
            .unwrap_or(0),
        0
    );
    assert_eq!(
        untrained_actor
            .professions
            .track_xp_amount(AuthorityProfessionKind::Scout, "creature-harvesting"),
        0
    );

    let (trained_config, mut trained) = creature_harvest_test_state("trained-creature", test_cell);
    grant_test_profession(&mut trained, "player", AuthorityProfessionKind::Scout);
    trained
        .actors
        .get_mut("player")
        .unwrap()
        .professions
        .skill_boxes
        .insert("scout-creature-harvesting-i".to_owned());
    let trained_harvest = trained.apply_envelope(
        &trained_config,
        command(
            1,
            ClientCommand::HarvestCorpse {
                target_actor_id: "trained-creature".to_owned(),
            },
        ),
    );
    assert_eq!(trained_harvest.status, AuthorityCommandStatus::Accepted);
    let trained_hide =
        trained.actor_inventory_available_quantity("player", RESOURCE_CREATURE_HIDE_ITEM_ID);
    assert!(
        trained_hide > untrained_hide,
        "creature-harvesting training must deepen yield at equal concentration"
    );
    let trained_actor = &trained.actors["player"];
    assert_eq!(
        trained_actor
            .professions
            .xp
            .get(&AuthorityProfessionKind::Scout)
            .copied()
            .unwrap_or(0),
        70
    );
    assert_eq!(
        trained_actor
            .professions
            .track_xp_amount(AuthorityProfessionKind::Scout, "creature-harvesting"),
        70
    );
}

#[test]
fn creature_harvest_is_deterministic_and_applies_scout_after_concentration() {
    let (cell, _) = creature_harvest_extreme_cell_for_test(CreatureMaterial::Hide, true);
    let (config, mut first_state) =
        creature_harvest_test_state("deterministic-creature", cell.clone());
    grant_test_profession(&mut first_state, "player", AuthorityProfessionKind::Scout);
    let expected = expected_creature_harvest_quantity(
        &first_state,
        "player",
        "deterministic-creature",
        CreatureMaterial::Hide,
    );
    let first = first_state.apply_envelope(
        &config,
        command(
            1,
            ClientCommand::HarvestCorpse {
                target_actor_id: "deterministic-creature".to_owned(),
            },
        ),
    );
    assert_eq!(first.status, AuthorityCommandStatus::Accepted);
    let first_quantity =
        first_state.actor_inventory_available_quantity("player", RESOURCE_CREATURE_HIDE_ITEM_ID);
    assert_eq!(first_quantity, expected);

    let (config, mut second_state) = creature_harvest_test_state("deterministic-creature", cell);
    grant_test_profession(&mut second_state, "player", AuthorityProfessionKind::Scout);
    let second = second_state.apply_envelope(
        &config,
        command(
            1,
            ClientCommand::HarvestCorpse {
                target_actor_id: "deterministic-creature".to_owned(),
            },
        ),
    );
    assert_eq!(second.status, AuthorityCommandStatus::Accepted);
    assert_eq!(
        second_state.actor_inventory_available_quantity("player", RESOURCE_CREATURE_HIDE_ITEM_ID),
        first_quantity
    );
}

#[test]
fn take_loot_item_creature_corpse_clamps_after_harvest_and_last_item() {
    let config = SliceAuthorityConfig::default();
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
        "harvest-creature",
        "Harvest PassiveCreature",
        "creature",
        CellSnapshot::new(11, 10),
        "front",
    ));
    let mut state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    let original_vanish = state.tick().saturating_add(10_000);
    {
        let creature = state.actors.get_mut("harvest-creature").unwrap();
        creature.life_state = AuthorityLifeState::Downed;
        creature.body_vanish_tick = original_vanish;
        creature
            .gaia_harvest_entitled_actor_ids
            .insert("player".to_owned());
    }
    push_test_inventory_stack(
        &mut state,
        "corpse:harvest-creature",
        RESOURCE_MINERAL_ITEM_ID,
        7,
        2,
    );

    let harvest = state.apply_envelope(
        &config,
        command(
            1,
            ClientCommand::HarvestCorpse {
                target_actor_id: "harvest-creature".to_owned(),
            },
        ),
    );
    assert_eq!(harvest.status, AuthorityCommandStatus::Accepted);
    {
        let creature = state.actors.get("harvest-creature").unwrap();
        assert_eq!(creature.creature_corpse_harvested_tick, Some(harvest.tick));
        assert_eq!(creature.corpse_exhausted_tick, None);
        assert_eq!(
            creature.body_vanish_tick, original_vanish,
            "creature corpse with remaining item loot should not clamp until the last item is taken"
        );
    }

    let take = state.apply_envelope(
        &config,
        command(
            2,
            ClientCommand::TakeLootItem {
                container: "corpse:harvest-creature".to_owned(),
                item_id: RESOURCE_MINERAL_ITEM_ID,
                variant_id: 7,
                quantity: 2,
            },
        ),
    );

    assert_eq!(take.status, AuthorityCommandStatus::Accepted);
    let creature = state.actors.get("harvest-creature").unwrap();
    assert_eq!(creature.life_state, AuthorityLifeState::Downed);
    assert_eq!(creature.creature_corpse_harvested_tick, Some(harvest.tick));
    assert_eq!(creature.corpse_exhausted_tick, Some(take.tick));
    assert_eq!(
        creature.body_vanish_tick,
        take.tick + CREATURE_CORPSE_EXHAUSTED_LINGER_TICKS
    );
    assert_eq!(creature.respawn_tick, 0);
}

#[test]
fn harvest_corpse_humanoid_rejected_without_hiding_body() {
    let (config, mut state) = take_loot_corpse_state();
    let before_vanish = state.actors.get("loot-trooper").unwrap().body_vanish_tick;

    let harvest = state.apply_envelope(
        &config,
        command(
            1,
            ClientCommand::HarvestCorpse {
                target_actor_id: "loot-trooper".to_owned(),
            },
        ),
    );

    assert_eq!(harvest.status, AuthorityCommandStatus::Rejected);
    assert_eq!(
        harvest.reason_code.as_deref(),
        Some("target_not_harvestable")
    );
    let corpse = state.actors.get("loot-trooper").unwrap();
    assert_eq!(corpse.life_state, AuthorityLifeState::Downed);
    assert_eq!(corpse.body_vanish_tick, before_vanish);
    assert_eq!(
        available_in_container(
            &state,
            "corpse:loot-trooper",
            CORPSE_TEST_LOOT_ITEM_ID,
            CORPSE_TEST_LOOT_VARIANT_ID
        ),
        CORPSE_TEST_LOOT_QUANTITY
    );
}

#[test]
fn authority_auto_train_melee_specialist_gets_scout_novice_before_medic() {
    let mut snapshot = crate::authority_test_slice();
    let mut trainer = test_actor(
        "profession-trainer-01",
        "Vela Orr",
        "profession_trainer",
        CellSnapshot::new(10, 10),
        "front",
    );
    trainer.capabilities = vec!["train:profession".to_owned()];
    snapshot.actors.push(trainer);
    let mut brawler = test_actor(
        "desert-warden-brawler-01",
        "Desert Warden Brawler",
        "agent_player",
        CellSnapshot::new(11, 10),
        "right",
    );
    brawler.profession_ids = vec!["brawler".to_owned()];
    brawler.career_goal_id = Some("melee_specialist".to_owned());
    snapshot.actors.push(brawler);

    let mut state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    state.tick = u64::from(state.tick_rate_hz.max(1));
    state.tick_auto_train_player_like_pawns();

    let actor = state.actors.get("desert-warden-brawler-01").unwrap();
    assert!(actor.professions.has_skill_box("scout-novice"));
    assert!(
        !actor.professions.has_skill_box("medic-novice"),
        "melee specialists should unlock safe Creature harvesting/mobility before utility medic"
    );
}

fn open_desert_activation_test_snapshot() -> SliceSnapshot {
    let mut snapshot = crate::authority_test_slice();
    snapshot.actors.clear();
    snapshot.npc_jobs.clear();
    snapshot.inventory.clear();
    snapshot.population_templates.clear();
    snapshot.spawn_zones.clear();
    snapshot.actors.push(test_actor(
        "player",
        "Player",
        "player",
        CellSnapshot::new(10, 10),
        "right",
    ));
    snapshot
        .population_templates
        .push(crate::PopulationTemplateSnapshot {
            id: "open-desert-rogue-template".to_owned(),
            label_prefix: "Open Desert Rogue".to_owned(),
            labels: Vec::new(),
            role: "skirmisher".to_owned(),
            faction_id: Some("blue_crew".to_owned()),
            social_group: Some("open_desert_rogues".to_owned()),
            pvp_status: Some("overt".to_owned()),
            player_organization_id: None,
            player_organization_tag: None,
            profession_ids: vec!["marksman".to_owned()],
            skill_box_ids: Vec::new(),
            credits: None,
            capabilities: Vec::new(),
            career_goal_id: None,
            sprite: "adventurer-premium-male".to_owned(),
            pose_set: "idle".to_owned(),
            direction: "left".to_owned(),
            scale: None,
            vitals: None,
            max_vitals: None,
        });
    snapshot
        .spawn_zones
        .push(crate::PopulationSpawnZoneSnapshot {
            id: "open-desert-rogue-zone".to_owned(),
            actor_id_prefix: "open-desert-rogue".to_owned(),
            template_id: "open-desert-rogue-template".to_owned(),
            area_id: crate::AUTHORITY_TEST_AREA_ID.to_owned(),
            candidate_cells: vec![
                CellSnapshot::new(50, 10),
                CellSnapshot::new(51, 10),
                CellSnapshot::new(50, 11),
            ],
            initial_count: 2,
            max_alive: 2,
            spawn_every_seconds: 0,
            batch_min: 0,
            batch_max: 0,
            seed: 0x00D3_5EA7,
            activation: Some(crate::PopulationSpawnZoneActivationSnapshot {
                radius_cells: 5,
                leash_radius_cells: Some(8),
                deactivation_radius_cells: None,
                release_ticks: Some(3),
                check_every_ticks: Some(1),
                linger_ticks: None,
            }),
        });
    snapshot
}

fn open_desert_roll_combat_test_snapshot() -> SliceSnapshot {
    let mut snapshot = open_desert_activation_test_snapshot();
    snapshot.combat_model = Some("roll".to_owned());
    snapshot.tick = 0;
    add_test_factions(&mut snapshot);
    {
        let player = snapshot
            .actors
            .iter_mut()
            .find(|actor| actor.id == "player")
            .expect("roll combat test player exists");
        player.faction_id = Some("red_crew".to_owned());
        player.social_group = Some("red_squad".to_owned());
        player.pvp_status = Some("overt".to_owned());
        player.profession_ids = vec!["marksman".to_owned()];
        player.cell = CellSnapshot::new(48, 10);
        player.vitals = Some(crate::ActorVitalsSnapshot {
            health: 400,
            action: 400,
            spirit: 400,
        });
        player.max_vitals = player.vitals;
    }
    let zone = snapshot
        .spawn_zones
        .first_mut()
        .expect("roll combat test zone exists");
    zone.candidate_cells = vec![CellSnapshot::new(50, 10)];
    zone.initial_count = 1;
    zone.max_alive = 1;
    zone.activation = Some(crate::PopulationSpawnZoneActivationSnapshot {
        radius_cells: 6,
        leash_radius_cells: Some(12),
        deactivation_radius_cells: None,
        release_ticks: Some(60),
        check_every_ticks: Some(1),
        linger_ticks: None,
    });
    snapshot
}

fn open_desert_roll_combat_state() -> (SliceAuthorityConfig, SliceAuthorityState) {
    let config = SliceAuthorityConfig::default();
    let snapshot = open_desert_roll_combat_test_snapshot();
    let state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    (config, state)
}

fn skirmisher_ai_for_test<'a>(
    state: &'a SliceAuthorityState,
    actor_id: &str,
) -> &'a SkirmisherAiState {
    match state
        .actors
        .get(actor_id)
        .and_then(|actor| actor.ai.as_ref())
        .expect("test skirmisher actor has AI")
    {
        AuthorityAiState::Skirmisher(ai) => ai,
        _ => panic!("test actor {actor_id} should use skirmisher AI"),
    }
}

fn skirmisher_attitude_for_test(state: &SliceAuthorityState, actor_id: &str) -> NpcAiAttitude {
    skirmisher_ai_for_test(state, actor_id).attitude
}

fn passive_rogue_roll_state(rogue_count: u16) -> (SliceAuthorityConfig, SliceAuthorityState) {
    let mut snapshot = open_desert_roll_combat_test_snapshot();
    snapshot.blocked_cells.clear();
    {
        let zone = snapshot
            .spawn_zones
            .first_mut()
            .expect("roll combat test zone exists");
        zone.activation = None;
        zone.candidate_cells = vec![
            CellSnapshot::new(50, 10),
            CellSnapshot::new(60, 10),
            CellSnapshot::new(62, 10),
        ];
        zone.initial_count = rogue_count;
        zone.max_alive = rogue_count;
    }
    let config = SliceAuthorityConfig::default();
    let mut state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    place_actor_at_position(
        &mut state,
        "player",
        AuthorityPosition {
            x: 48_000,
            y: 10_000,
        },
    );
    {
        let player = state.actors.get_mut("player").unwrap();
        player.equipped_weapon_id = Some(AuthorityWeaponId::Slugthrower);
        player.slugthrower_magazine.loaded_rounds = SLUGTHROWER_MAGAZINE_SIZE;
        player.slugthrower_magazine.reload_until_tick = 0;
        player.next_fire_tick = 0;
        player.vitals.action = 400;
        player.max_vitals.action = 400;
    }
    for index in 1..=rogue_count {
        let actor_id = format!("open-desert-rogue-{index:02}");
        if let Some(rogue) = state.actors.get_mut(&actor_id) {
            rogue.vitals.health = 1_000;
            rogue.max_vitals.health = 1_000;
            rogue.equipped_weapon_id = Some(AuthorityWeaponId::Slugthrower);
        }
    }
    place_actor_at_position(
        &mut state,
        "open-desert-rogue-01",
        AuthorityPosition {
            x: 50_000,
            y: 10_000,
        },
    );
    (config, state)
}

#[test]
fn authority_open_desert_spawn_zone_activates_and_releases() {
    let config = SliceAuthorityConfig::default();
    let snapshot = open_desert_activation_test_snapshot();
    let mut state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    assert!(!state.actors.contains_key("open-desert-rogue-01"));
    assert!(
        !state
            .population
            .spawn_zones
            .get("open-desert-rogue-zone")
            .expect("zone exists")
            .active
    );

    place_actor_at_position(
        &mut state,
        "player",
        AuthorityPosition {
            x: 48_000,
            y: 10_500,
        },
    );
    state.advance_ticks_for_observer(&config, 1);

    let zone = state
        .population
        .spawn_zones
        .get("open-desert-rogue-zone")
        .expect("zone exists");
    assert!(zone.active);
    assert_eq!(zone.total_spawned, 2);
    assert_eq!(
        state
            .actors
            .values()
            .filter(|actor| {
                actor.spawn_zone_id.as_deref() == Some("open-desert-rogue-zone")
                    && actor.life_state == AuthorityLifeState::Alive
            })
            .count(),
        2
    );

    place_actor_at_position(
        &mut state,
        "player",
        AuthorityPosition {
            x: 10_000,
            y: 10_000,
        },
    );
    advance_ticks_unclamped(&mut state, &config, 4);

    let zone = state
        .population
        .spawn_zones
        .get("open-desert-rogue-zone")
        .expect("zone exists");
    assert!(!zone.active);
    assert_eq!(
        state
            .actors
            .values()
            .filter(|actor| {
                actor.spawn_zone_id.as_deref() == Some("open-desert-rogue-zone")
                    && actor.life_state == AuthorityLifeState::Alive
            })
            .count(),
        0
    );
    assert!(state
        .current_removed_actor_ids
        .iter()
        .any(|actor_id| actor_id == "open-desert-rogue-01"));
}

#[test]
fn authority_population_npc_death_discards_ammo_instead_of_corpse_loot() {
    let config = SliceAuthorityConfig::default();
    let mut snapshot = open_desert_activation_test_snapshot();
    let zone = snapshot.spawn_zones.first_mut().expect("spawn zone exists");
    zone.candidate_cells = vec![CellSnapshot::new(50, 10)];
    zone.initial_count = 1;
    zone.max_alive = 1;
    let mut state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    place_actor_at_position(
        &mut state,
        "player",
        AuthorityPosition {
            x: 50_500,
            y: 10_500,
        },
    );
    state.advance_ticks_for_observer(&config, 1);

    let actor_id = "open-desert-rogue-01";
    assert!(state.actors.contains_key(actor_id));
    assert!(!state.actor_tracks_ammo_item(actor_id, AMMO_SLUG_IRON_ITEM_ID));
    assert_eq!(
        state.actor_inventory_item_available(actor_id, AMMO_SLUG_IRON_ITEM_ID),
        None
    );
    push_test_inventory_stack(
        &mut state,
        "open-desert-rogue-01:field-pack",
        AMMO_SLUG_IRON_ITEM_ID,
        0,
        17,
    );
    assert!(!state.actor_tracks_ammo_item(actor_id, AMMO_SLUG_IRON_ITEM_ID));
    assert_eq!(
        state.actor_inventory_item_available(actor_id, AMMO_SLUG_IRON_ITEM_ID),
        None
    );
    let death_tick = state.tick();
    {
        let tick_rate_hz = state.tick_rate_hz;
        let actor = state.actors.get_mut(actor_id).unwrap();
        SliceAuthorityState::kill_actor_for_respawn(death_tick, tick_rate_hz, actor);
    }
    state.finalize_actor_corpse_after_death(actor_id, death_tick);

    let corpse_container = format!("corpse:{actor_id}");
    assert_eq!(
        available_in_container(&state, &corpse_container, AMMO_SLUG_IRON_ITEM_ID, 0),
        0
    );
    assert!(!state.inventory_snapshots().iter().any(|row| {
        row.item_id == AMMO_SLUG_IRON_ITEM_ID
            && (row.container == corpse_container
                || actor_owns_inventory_container(actor_id, &row.container))
    }));
}

#[test]
fn authority_spawn_zone_deactivation_hysteresis_keeps_actors_alive_on_brief_leash_out() {
    // Deactivation radius (12) > leash (8) + linger (6 ticks): a brief
    // leash-out must NOT despawn the rogues — they survive and would leash
    // back to post. Despawn only fires once the player is beyond the
    // deactivation radius for the full linger window. Zone centre for a
    // single candidate cell (50,10) is (50_500, 10_500) milli.
    let config = SliceAuthorityConfig::default();
    let mut snapshot = open_desert_activation_test_snapshot();
    let zone = snapshot.spawn_zones.first_mut().expect("spawn zone exists");
    zone.candidate_cells = vec![CellSnapshot::new(50, 10)];
    zone.initial_count = 1;
    zone.max_alive = 1;
    zone.activation = Some(crate::PopulationSpawnZoneActivationSnapshot {
        radius_cells: 5,
        leash_radius_cells: Some(8),
        deactivation_radius_cells: Some(12),
        release_ticks: Some(3),
        linger_ticks: Some(6),
        check_every_ticks: Some(1),
    });
    let mut state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();

    // Player starts far away (well beyond deactivation): zone dormant, no rogues.
    place_actor_at_position(
        &mut state,
        "player",
        AuthorityPosition { x: 1_000, y: 1_000 },
    );
    advance_ticks_unclamped(&mut state, &config, 1);
    assert!(!state.population.spawn_zones["open-desert-rogue-zone"].active);
    assert!(!state.actors.contains_key("open-desert-rogue-01"));

    // Walk within the activation radius (3.5 cells): zone activates, rogue spawns.
    place_actor_at_position(
        &mut state,
        "player",
        AuthorityPosition {
            x: 50_500,
            y: 14_000,
        },
    );
    advance_ticks_unclamped(&mut state, &config, 1);
    assert!(state.population.spawn_zones["open-desert-rogue-zone"].active);
    assert!(state.actors.contains_key("open-desert-rogue-01"));

    // Brief leash-out: step to 10 cells (past leash 8, still inside
    // deactivation 12). Several ticks pass — the rogue MUST stay alive.
    place_actor_at_position(
        &mut state,
        "player",
        AuthorityPosition {
            x: 50_500,
            y: 20_500,
        },
    );
    advance_ticks_unclamped(&mut state, &config, 4);
    assert!(
        state.population.spawn_zones["open-desert-rogue-zone"].active,
        "brief leash-out inside deactivation must keep the zone active"
    );
    assert!(
        state.actors.contains_key("open-desert-rogue-01"),
        "brief leash-out inside deactivation must NOT despawn the rogue"
    );

    // Retreat beyond deactivation (14 cells). Linger window (6 ticks) has not
    // elapsed yet — rogue still alive.
    place_actor_at_position(
        &mut state,
        "player",
        AuthorityPosition {
            x: 50_500,
            y: 24_500,
        },
    );
    advance_ticks_unclamped(&mut state, &config, 5);
    assert!(
        state.population.spawn_zones["open-desert-rogue-zone"].active,
        "linger window not yet elapsed: zone stays active"
    );
    assert!(state.actors.contains_key("open-desert-rogue-01"));

    // One more tick completes the linger window past deactivation: now the
    // rogue releases (despawn), only after the full hysteresis.
    advance_ticks_unclamped(&mut state, &config, 1);
    assert!(!state.population.spawn_zones["open-desert-rogue-zone"].active);
    assert!(!state.actors.contains_key("open-desert-rogue-01"));
    assert!(state
        .current_removed_actor_ids
        .iter()
        .any(|actor_id| actor_id == "open-desert-rogue-01"));
}

#[test]
fn authority_population_spawn_falls_back_to_occupied_candidate_when_all_candidates_are_taken() {
    let config = SliceAuthorityConfig::default();
    let mut snapshot = open_desert_activation_test_snapshot();
    let zone = snapshot.spawn_zones.first_mut().expect("spawn zone exists");
    zone.candidate_cells = vec![CellSnapshot::new(50, 10)];
    zone.initial_count = 1;
    zone.max_alive = 1;
    snapshot.actors.push(test_actor(
        "spawn-cell-occupant",
        "Spawn Cell Occupant",
        "public_shopkeeper",
        CellSnapshot::new(50, 10),
        "left",
    ));
    let mut state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    place_actor_at_position(
        &mut state,
        "player",
        AuthorityPosition {
            x: 48_000,
            y: 10_500,
        },
    );

    state.advance_ticks_for_observer(&config, 1);

    let spawned = state
        .actors
        .get("open-desert-rogue-01")
        .expect("population should fall back to occupied candidate");
    assert_eq!(spawned.cell, AuthorityCell::new(50, 10));
    assert_eq!(
        spawned.cell,
        state.actors.get("spawn-cell-occupant").unwrap().cell
    );
}

#[test]
fn authority_open_desert_activation_is_deterministic_for_same_inputs() {
    let config = SliceAuthorityConfig::default();
    let snapshot = open_desert_activation_test_snapshot();
    let mut left = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    let mut right = SliceAuthorityState::from_snapshot(&snapshot).unwrap();

    for state in [&mut left, &mut right] {
        place_actor_at_position(
            state,
            "player",
            AuthorityPosition {
                x: 48_000,
                y: 10_500,
            },
        );
        advance_ticks_unclamped(state, &config, 6);
        place_actor_at_position(
            state,
            "player",
            AuthorityPosition {
                x: 10_000,
                y: 10_000,
            },
        );
        advance_ticks_unclamped(state, &config, 6);
    }

    assert_eq!(left.stable_state_hash_hex(), right.stable_state_hash_hex());
    assert_eq!(
        left.population
            .spawn_zones
            .get("open-desert-rogue-zone")
            .unwrap()
            .total_spawned,
        right
            .population
            .spawn_zones
            .get("open-desert-rogue-zone")
            .unwrap()
            .total_spawned
    );
}

#[test]
fn authority_skirmisher_role_normalizes_exact_two_and_never_respawns_defeated_slot() {
    let config = SliceAuthorityConfig::default();
    let mut snapshot = open_desert_activation_test_snapshot();
    let zone = snapshot.spawn_zones.first_mut().unwrap();
    zone.initial_count = 1;
    zone.max_alive = 1;
    zone.activation = None;
    let mut state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    let zone_state = state
        .population
        .spawn_zones
        .get("open-desert-rogue-zone")
        .unwrap();
    assert_eq!(zone_state.initial_count, 2);
    assert_eq!(zone_state.max_alive, 2);
    assert!(state.actors.contains_key("open-desert-rogue-01"));
    assert!(state.actors.contains_key("open-desert-rogue-02"));
    state
        .actors
        .get_mut("open-desert-rogue-01")
        .unwrap()
        .life_state = AuthorityLifeState::Respawning;
    state
        .actors
        .get_mut("open-desert-rogue-01")
        .unwrap()
        .respawn_tick = state.tick().saturating_add(1_000);
    state.advance_ticks_for_observer(&config, 1);
    assert!(state.population.spawn_zones["open-desert-rogue-zone"]
        .defeated_slots
        .contains(&1));
    state
        .actors
        .get_mut("open-desert-rogue-01")
        .unwrap()
        .respawn_tick = state.tick() + 1;
    state.advance_ticks_for_observer(&config, 2);
    assert!(!state.actors.contains_key("open-desert-rogue-01"));
    assert!(!state.actors.contains_key("open-desert-rogue-03"));
}

#[test]
fn authority_bark_ignores_nearer_archetype_less_speaker() {
    let config = SliceAuthorityConfig::default();
    let mut snapshot = open_desert_activation_test_snapshot();
    let zone = snapshot.spawn_zones.first_mut().unwrap();
    zone.activation = None;
    zone.candidate_cells = vec![CellSnapshot::new(50, 10), CellSnapshot::new(51, 10)];
    let mut state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    place_actor_at_position(
        &mut state,
        "player",
        AuthorityPosition {
            x: 50_000,
            y: 10_000,
        },
    );
    for (actor_id, x) in [
        ("open-desert-rogue-01", 50_000),
        ("open-desert-rogue-02", 51_000),
    ] {
        let actor = state.actors.get_mut(actor_id).unwrap();
        actor.position = AuthorityPosition { x, y: 10_000 };
    }
    {
        let nearer = state.actors.get_mut("open-desert-rogue-01").unwrap();
        nearer.faction.faction_id = None;
        nearer.faction.social_group = None;
    }
    state.advance_ticks_for_observer(&config, 1);
    assert_eq!(state.pending_dialogue_deliveries.len(), 1);
    assert_eq!(
        state.pending_dialogue_deliveries[0].actor_id,
        "open-desert-rogue-02"
    );
    assert!(state
        .bark_claims
        .contains_encounter("open-desert-rogue-zone"));
}

#[test]
fn authority_creature_population_deaths_do_not_clear_zone_or_block_repopulation() {
    let config = SliceAuthorityConfig::default();
    let mut snapshot = open_desert_activation_test_snapshot();
    let template = snapshot.population_templates.first_mut().unwrap();
    template.role = "creature".to_owned();
    template.faction_id = None;
    template.social_group = None;
    let zone = snapshot.spawn_zones.first_mut().unwrap();
    zone.initial_count = 2;
    zone.max_alive = 2;
    zone.spawn_every_seconds = 1;
    zone.batch_min = 1;
    zone.batch_max = 1;
    zone.activation = None;
    let mut state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    let respawn_tick = state.tick() + 1;
    for actor in state
        .actors
        .values_mut()
        .filter(|a| a.spawn_zone_id.is_some())
    {
        actor.life_state = AuthorityLifeState::Respawning;
        actor.respawn_tick = respawn_tick;
    }
    state.advance_ticks_for_observer(&config, 40);
    let zone = &state.population.spawn_zones["open-desert-rogue-zone"];
    assert!(!zone.cleared);
    assert!(zone.defeated_slots.is_empty());
    assert!(state.actors.values().any(|a| a.spawn_zone_id.is_some()));
}

#[test]
fn authority_roll_mode_zone_rogue_alerts_without_combat_until_provoked() {
    let (config, mut state) = open_desert_roll_combat_state();
    let starting_health = state.actors.get("player").unwrap().vitals.health;
    let mut events = Vec::new();
    for _ in 0..20 {
        events.extend(state.advance_ticks_for_observer(&config, 1));
        if state.actors.contains_key("open-desert-rogue-01") {
            break;
        }
    }

    assert!(
        state.actors.contains_key("open-desert-rogue-01"),
        "activation should spawn the passive rogue"
    );
    assert!(
        events.is_empty(),
        "passive alert acquisition should not damage immediately"
    );
    let rogue = state
        .actor_snapshot("open-desert-rogue-01")
        .expect("activated rogue snapshot");
    assert_eq!(
        rogue.in_combat, None,
        "active zone passive rogue should stay yellow/uncommitted on proximity"
    );
    assert_eq!(rogue.ai_attitude.as_deref(), Some("alerted"));
    assert_eq!(
        state.actors.get("player").unwrap().vitals.health,
        starting_health,
        "alert telegraph must not damage before provocation"
    );
    let ai = skirmisher_ai_for_test(&state, "open-desert-rogue-01");
    assert_eq!(ai.attitude, NpcAiAttitude::Alerted);
    assert_eq!(ai.target_actor_id.as_deref(), None);

    state.provoke_rogue_social_assist("open-desert-rogue-01", "player");
    let rogue = state
        .actor_snapshot("open-desert-rogue-01")
        .expect("provoked rogue snapshot");
    assert_eq!(
        rogue.in_combat,
        Some(true),
        "provoked rogue should unsling once the player attacks first"
    );
    assert_eq!(rogue.ai_attitude.as_deref(), Some("hostile"));
    let ai = skirmisher_ai_for_test(&state, "open-desert-rogue-01");
    assert_eq!(ai.attitude, NpcAiAttitude::Hostile);
    assert_eq!(ai.target_actor_id.as_deref(), Some("player"));
    assert_eq!(
        state.actors.get("player").unwrap().vitals.health,
        starting_health,
        "provocation state change itself should not apply damage"
    );
}

#[test]
fn authority_roll_mode_zone_rogue_damage_is_deterministic() {
    fn run() -> (i32, usize, u32, String) {
        let (config, mut state) = open_desert_roll_combat_state();
        let mut events = Vec::new();
        for _ in 0..20_u64 {
            events.extend(state.advance_ticks_for_observer(&config, 1));
            if state.actors.contains_key("open-desert-rogue-01") {
                break;
            }
        }
        assert!(
            state.actors.contains_key("open-desert-rogue-01"),
            "activation should spawn the passive rogue before provocation"
        );
        assert!(
            events.is_empty(),
            "passive rogue activation should not emit roll damage before provocation"
        );
        state.provoke_rogue_social_assist("open-desert-rogue-01", "player");
        for _ in 0..480_u64 {
            events.extend(state.advance_ticks_for_observer(&config, 1));
        }
        assert!(events
            .iter()
            .all(|event| event.kind.as_deref() == Some("ranged_roll")));
        let mut roll_damage_events = 0_usize;
        let mut roll_health_damage = 0_i32;
        for event in events.iter().filter(|event| {
            event.kind.as_deref() == Some("ranged_roll")
                && event.attacker_actor_id.as_deref() == Some("open-desert-rogue-01")
                && event.target_actor_id == "player"
                && event.action_id.as_deref() == Some("basic_shot")
                && event.hit == Some(true)
                && event.pool.as_deref() == Some("health")
                && event.damage > 0
        }) {
            roll_damage_events = roll_damage_events.saturating_add(1);
            roll_health_damage = roll_health_damage.saturating_add(event.damage);
        }
        let loaded_rounds = state
            .actors
            .get("open-desert-rogue-01")
            .unwrap()
            .slugthrower_magazine
            .loaded_rounds;
        (
            roll_health_damage,
            roll_damage_events,
            loaded_rounds,
            state.stable_state_hash_hex(),
        )
    }

    let left = run();
    let right = run();
    assert_eq!(
        left, right,
        "roll-mode NPC combat should replay deterministically"
    );
    assert!(
        left.0 > 0,
        "roll-mode rogue should land health damage over the replay"
    );
    assert!(
        left.1 > 0,
        "roll damage should be reported as ranged_roll combat events"
    );
}

#[test]
fn authority_roll_mode_dormant_zone_tick_shape_stays_empty() {
    let config = SliceAuthorityConfig::default();
    let mut snapshot = open_desert_activation_test_snapshot();
    snapshot.combat_model = Some("roll".to_owned());
    let mut state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();

    let mut events = Vec::new();
    for _ in 0..20_u64 {
        events.extend(state.advance_ticks_for_observer(&config, 1));
    }
    let timing = state.last_advance_timing();

    assert!(events.is_empty());
    assert!(!state.actors.contains_key("open-desert-rogue-01"));
    assert_eq!(state.combat_event_count, 0);
    assert_eq!(timing.ai_updates, 0);
    assert_eq!(timing.ai_skipped, 0);
    assert_eq!(timing.path_queries, 0);
    assert_eq!(timing.path_expansions, 0);
}

#[test]
fn take_loot_item_open_desert_rogue_corpse_container() {
    let config = SliceAuthorityConfig::default();
    let mut snapshot = open_desert_activation_test_snapshot();
    snapshot.spawn_zones[0].activation = None;
    snapshot.spawn_zones[0].initial_count = 1;
    snapshot.spawn_zones[0].max_alive = 1;
    snapshot.spawn_zones[0].candidate_cells = vec![CellSnapshot::new(11, 10)];
    let mut state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    let target_id = "open-desert-rogue-01";
    {
        let tick = state.tick();
        let tick_rate_hz = state.tick_rate_hz;
        let target = state.actors.get_mut(target_id).unwrap();
        target.slugthrower_magazine.loaded_rounds = SLUGTHROWER_MAGAZINE_SIZE;
        SliceAuthorityState::kill_actor_for_respawn(tick, tick_rate_hz, target);
    }
    let container = format!("corpse:{target_id}");
    push_test_inventory_stack(&mut state, &container, AMMO_SLUG_IRON_ITEM_ID, 0, 12);
    let available = available_in_container(&state, &container, AMMO_SLUG_IRON_ITEM_ID, 0);
    assert_eq!(available, 12);

    let before = state.actor_inventory_available_quantity("player", AMMO_SLUG_IRON_ITEM_ID);
    let take = state.apply_envelope(
        &config,
        command(
            1,
            ClientCommand::TakeLootItem {
                container,
                item_id: AMMO_SLUG_IRON_ITEM_ID,
                variant_id: 0,
                quantity: i32::try_from(available).unwrap(),
            },
        ),
    );

    assert_eq!(take.status, AuthorityCommandStatus::Accepted);
    assert_eq!(
        state.actor_inventory_available_quantity("player", AMMO_SLUG_IRON_ITEM_ID) - before,
        available
    );
    assert_eq!(
        state.actor_snapshot(target_id).unwrap().life_state,
        AuthorityLifeState::Downed
    );
}
// --- deterministic NPC naming doctrine: oracle sweep + determinism + creature register ---

/// Mutate a seeded rogue slot into an arbitrary creature/humanoid identity and
/// (re)run the presentation generator, returning (display_name, descriptor).

#[test]
fn authority_authored_npc_respawn_is_not_pruned_as_population() {
    let config = SliceAuthorityConfig::default();
    let mut snapshot = crate::authority_test_slice();
    snapshot.actors.clear();
    snapshot.npc_jobs.clear();
    snapshot.inventory.clear();
    snapshot.population_templates.clear();
    snapshot.spawn_zones.clear();
    snapshot.actors.push(test_actor(
        "authored-rogue",
        "Authored Rogue",
        "skirmisher",
        CellSnapshot::new(12, 12),
        "left",
    ));

    let mut state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    let tick = state.tick();
    {
        let actor = state.actors.get_mut("authored-rogue").unwrap();
        SliceAuthorityState::set_actor_life_state(actor, AuthorityLifeState::Respawning);
        actor.body_vanish_tick = 0;
        actor.respawn_tick = tick;
    }

    state.advance_ticks_for_observer(&config, 1);

    let actor = state
        .actors
        .get("authored-rogue")
        .expect("authored NPC should remain in actor table");
    assert_eq!(actor.life_state, AuthorityLifeState::Alive);
    assert_eq!(actor.respawn_tick, 0);
}

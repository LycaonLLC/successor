fn grant_test_capability(state: &mut SliceAuthorityState, actor_id: &str, capability: &str) {
    state
        .runtime
        .durable
        .actors
        .get_mut(actor_id)
        .expect("test actor exists")
        .capabilities
        .grant(capability);
}

fn clear_test_capabilities(state: &mut SliceAuthorityState, actor_id: &str) {
    state
        .runtime
        .durable
        .actors
        .get_mut(actor_id)
        .expect("test actor exists")
        .capabilities
        .granted
        .clear();
}

fn seed_test_tool(state: &mut SliceAuthorityState, actor_id: &str, item_id: u32, label: &str) {
    if state.actor_inventory_available_quantity(actor_id, item_id) > 0 {
        return;
    }
    let variant_id = if item_id == FIELD_MULTITOOL_ITEM_ID {
        STARTER_FIELD_MULTITOOL_QUALITY_MILLI
    } else {
        0
    };
    state.add_actor_inventory_stack(
        actor_id,
        item_id,
        variant_id,
        label,
        1,
        1,
        "profession-tools",
    );
}

fn seed_test_survey_tool(state: &mut SliceAuthorityState, actor_id: &str) {
    // Category survey tools gate /survey + /sample under Option A; the Mineral
    // Survey Tool is the entry-category tool used across the sim survey tests.
    seed_test_tool(
        state,
        actor_id,
        MINERAL_SURVEY_TOOL_ITEM_ID,
        "Mineral Survey Tool",
    );
}

fn grant_craftsman_session_test_skills(state: &mut SliceAuthorityState, actor_id: &str) {
    let actor = state
        .runtime
        .durable
        .actors
        .get_mut(actor_id)
        .expect("test actor exists");
    for skill_box_id in [
        "craftsman-assembly-i",
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

type TestBatteryResource = (String, String, u32);
type TestBatteryResources = (
    TestBatteryResource,
    TestBatteryResource,
    TestBatteryResource,
);

fn seed_test_battery_resources(
    state: &mut SliceAuthorityState,
    actor_id: &str,
    copper_variant_id: u32,
    iron_variant_id: u32,
) -> TestBatteryResources {
    let container = format!("{actor_id}:field-pack");
    let copper_stack_id = push_test_inventory_stack(
        state,
        &container,
        RESOURCE_COPPER_ITEM_ID,
        copper_variant_id,
        CRAFT_EXTRACTOR_BATTERY_COPPER_QTY,
    );
    let iron_stack_id = push_test_inventory_stack(
        state,
        &container,
        RESOURCE_MINERAL_ITEM_ID,
        iron_variant_id,
        CRAFT_EXTRACTOR_BATTERY_IRON_QTY,
    );
    let fuel_variant_id = fuel_variant_from_chemical_variant(222_777);
    let fuel_stack_id = push_test_inventory_stack(
        state,
        &container,
        RESOURCE_FUEL_ITEM_ID,
        fuel_variant_id,
        CRAFT_EXTRACTOR_BATTERY_FUEL_QTY,
    );
    (
        (
            container.clone(),
            copper_stack_id.to_string(),
            copper_variant_id,
        ),
        (
            container.clone(),
            iron_stack_id.to_string(),
            iron_variant_id,
        ),
        (container, fuel_stack_id.to_string(), fuel_variant_id),
    )
}

fn test_cover_prop(
    id: &str,
    cell: CellSnapshot,
    size: crate::CellSizeSnapshot,
) -> crate::PropSnapshot {
    crate::PropSnapshot {
        id: id.to_owned(),
        entity: format!("test:{id}"),
        area_id: crate::AUTHORITY_TEST_AREA_ID.to_owned(),
        label: "Cover Prop".to_owned(),
        kind: "cover".to_owned(),
        cell,
        size,
        interactive: false,
        cover: Some(crate::CoverSnapshot {
            rating: 82,
            height: "high".to_owned(),
        }),
        collision_bounds: Vec::new(),
        door: None,
        container: None,
    }
}

fn test_exchange_prop(cell: CellSnapshot) -> crate::PropSnapshot {
    test_exchange_prop_with_size(cell, crate::CellSizeSnapshot { w: 2, h: 2 })
}

fn test_exchange_prop_in_area(cell: CellSnapshot, area_id: &str) -> crate::PropSnapshot {
    let mut prop = test_exchange_prop(cell);
    prop.area_id = area_id.to_owned();
    prop
}

fn test_exchange_prop_with_size(
    cell: CellSnapshot,
    size: crate::CellSizeSnapshot,
) -> crate::PropSnapshot {
    crate::PropSnapshot {
        id: "district-exchange-test".to_owned(),
        entity: "container:district-exchange".to_owned(),
        area_id: crate::AUTHORITY_TEST_AREA_ID.to_owned(),
        label: "District Exchange".to_owned(),
        kind: "resource_container".to_owned(),
        cell,
        size,
        interactive: true,
        cover: None,
        collision_bounds: Vec::new(),
        door: None,
        container: None,
    }
}

fn test_loot_cache_prop(id: &str, cell: CellSnapshot) -> crate::PropSnapshot {
    crate::PropSnapshot {
        id: id.to_owned(),
        entity: format!("cache:{id}"),
        area_id: crate::AUTHORITY_TEST_AREA_ID.to_owned(),
        label: "Supply Cache".to_owned(),
        kind: "storage_chest".to_owned(),
        cell,
        size: crate::CellSizeSnapshot { w: 1, h: 1 },
        interactive: true,
        cover: None,
        collision_bounds: Vec::new(),
        door: None,
        container: None,
    }
}

#[test]
fn authority_weapon_spread_primitives_follow_marksman_rifle_training() {
    let mut snapshot = crate::authority_test_slice();
    snapshot.actors.clear();
    snapshot.npc_jobs.clear();
    snapshot.actors.push(test_actor(
        "agent",
        "Agent",
        "agent_player",
        CellSnapshot::new(10, 10),
        "right",
    ));
    snapshot.actors.push(test_actor(
        "rogue",
        "Rogue",
        "skirmisher",
        CellSnapshot::new(20, 10),
        "left",
    ));
    snapshot.actors.push(test_actor(
        "human",
        "Human",
        "player",
        CellSnapshot::new(12, 10),
        "right",
    ));
    let mut state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    let weapon = weapon_profile(Some(AuthorityWeaponId::Slugthrower));
    let tick = state.tick;
    let human_base = state.actors.get("human").unwrap().clone();
    grant_test_profession(&mut state, "agent", AuthorityProfessionKind::Marksman);
    grant_test_profession(&mut state, "human", AuthorityProfessionKind::Marksman);
    let agent = state.actors.get("agent").unwrap().clone();
    let human_marksman = state.actors.get("human").unwrap().clone();
    let rogue = state.actors.get("rogue").unwrap().clone();
    let agent_breakdown = shot_spread_breakdown_for_actor(&agent, weapon, tick);
    let human_base_breakdown = shot_spread_breakdown_for_actor(&human_base, weapon, tick);
    let human_marksman_breakdown = shot_spread_breakdown_for_actor(&human_marksman, weapon, tick);
    let rogue_breakdown = shot_spread_breakdown_for_actor(&rogue, weapon, tick);

    assert_eq!(
        agent_breakdown.weapon_degrees_milli,
        SLUGTHROWER_BASE_SPREAD_DEGREES_MILLI
    );
    assert_eq!(
        agent_breakdown.role_degrees_milli,
        SKIRMISHER_SPREAD_BIAS_DEGREES_MILLI
    );
    assert_eq!(
        agent_breakdown.novice_penalty_degrees_milli,
        MARKSMAN_NOVICE_RIFLE_SPREAD_PENALTY_DEGREES_MILLI
    );
    assert!(agent_breakdown.bare_novice_marksman);
    assert_eq!(agent_breakdown.skill_reduction_milli, 0);
    assert_eq!(
        agent_breakdown.total_degrees_milli,
        SLUGTHROWER_BASE_SPREAD_DEGREES_MILLI
            + SKIRMISHER_SPREAD_BIAS_DEGREES_MILLI
            + MARKSMAN_NOVICE_RIFLE_SPREAD_PENALTY_DEGREES_MILLI,
        "bare novice Marksman rifle fire should keep the full role envelope"
    );
    assert_eq!(
        rogue_breakdown.role_degrees_milli,
        SKIRMISHER_SPREAD_BIAS_DEGREES_MILLI
    );
    assert_eq!(rogue_breakdown.skill_reduction_milli, 0);
    assert_eq!(rogue_breakdown.novice_penalty_degrees_milli, 0);
    assert!(!rogue_breakdown.bare_novice_marksman);
    assert_eq!(
        rogue_breakdown.total_degrees_milli,
        rogue_breakdown
            .weapon_degrees_milli
            .saturating_add(rogue_breakdown.role_degrees_milli)
    );

    assert_eq!(
        shot_spread_degrees_milli_for_actor(&agent, weapon, tick),
        shot_spread_degrees_milli_for_actor(&rogue, weapon, tick)
            + MARKSMAN_NOVICE_RIFLE_SPREAD_PENALTY_DEGREES_MILLI,
        "bare novice Marksman radius should no longer exceed the untrained skirmisher envelope"
    );
    assert_eq!(
        human_base_breakdown.total_degrees_milli,
        SLUGTHROWER_BASE_SPREAD_DEGREES_MILLI + HUMAN_PLAYER_SPREAD_BIAS_DEGREES_MILLI,
        "plain human players keep the player role accuracy envelope"
    );
    assert_eq!(
        human_marksman_breakdown.total_degrees_milli, agent_breakdown.total_degrees_milli,
        "bare novice Marksman penalty is profession/training based, not actor-kind based"
    );

    let mut rifle_i_agent = agent.clone();
    rifle_i_agent
        .professions
        .grant_skill_box_ids(&["marksman-rifle-i".to_owned()])
        .unwrap();
    let rifle_i_breakdown = shot_spread_breakdown_for_actor(&rifle_i_agent, weapon, tick);
    assert_eq!(rifle_i_breakdown.skill_reduction_milli, 500);
    assert_eq!(
        rifle_i_breakdown.role_degrees_milli,
        SKIRMISHER_SPREAD_BIAS_DEGREES_MILLI / 2
    );
    assert_eq!(rifle_i_breakdown.novice_penalty_degrees_milli, 0);
    assert!(!rifle_i_breakdown.bare_novice_marksman);
    assert_eq!(
        rifle_i_breakdown.total_degrees_milli,
        SLUGTHROWER_BASE_SPREAD_DEGREES_MILLI + 12_000
    );
    assert!(rifle_i_breakdown.total_degrees_milli < agent_breakdown.total_degrees_milli);

    let mut master_agent = rifle_i_agent.clone();
    master_agent
        .professions
        .grant_skill_box_ids(&[
            "marksman-rifle-ii".to_owned(),
            "marksman-rifle-iii".to_owned(),
            "marksman-rifle-iv".to_owned(),
            "marksman-master".to_owned(),
        ])
        .unwrap();
    let master_breakdown = shot_spread_breakdown_for_actor(&master_agent, weapon, tick);
    assert_eq!(master_breakdown.skill_reduction_milli, 920);
    assert_eq!(
        master_breakdown.total_degrees_milli,
        SLUGTHROWER_BASE_SPREAD_DEGREES_MILLI + 1_920
    );
    assert!(master_breakdown.total_degrees_milli < rifle_i_breakdown.total_degrees_milli);

    let mut hot_agent = agent.clone();
    record_actor_weapon_recoil(&mut hot_agent, weapon, tick, DEFAULT_AUTHORITY_TICK_RATE_HZ);
    let hot_breakdown = shot_spread_breakdown_for_actor(&hot_agent, weapon, tick);
    assert!(
        hot_breakdown.recoil_degrees_milli > agent_breakdown.recoil_degrees_milli,
        "successive rifle fire should add recoil spread"
    );

    let mut hot_master = master_agent.clone();
    record_actor_weapon_recoil(
        &mut hot_master,
        weapon,
        tick,
        DEFAULT_AUTHORITY_TICK_RATE_HZ,
    );
    let hot_master_breakdown = shot_spread_breakdown_for_actor(&hot_master, weapon, tick);
    assert!(
        hot_master_breakdown.recoil_degrees_milli < hot_breakdown.recoil_degrees_milli,
        "rifle accuracy boxes should also control recoil bloom"
    );
    let recoil_probe_tick = tick + 5;
    assert!(
        decayed_weapon_recoil_heat_milli_for_actor(
            &hot_master,
            weapon,
            recoil_probe_tick,
            DEFAULT_AUTHORITY_TICK_RATE_HZ,
        ) < decayed_weapon_recoil_heat_milli_for_actor(
            &hot_agent,
            weapon,
            recoil_probe_tick,
            DEFAULT_AUTHORITY_TICK_RATE_HZ,
        ),
        "rifle accuracy boxes should recover sustained-fire recoil faster"
    );

    let mut moving_agent = agent.clone();
    moving_agent.next_move_tick = tick.saturating_add(1);
    let moving_agent_breakdown = shot_spread_breakdown_for_actor(&moving_agent, weapon, tick);
    assert_eq!(
        moving_agent_breakdown.movement_degrees_milli,
        SKIRMISHER_MOVING_FIRE_SPREAD_DEGREES_MILLI
    );

    let mut moving_rogue = rogue.clone();
    moving_rogue.next_move_tick = tick.saturating_add(1);
    let moving_rogue_breakdown = shot_spread_breakdown_for_actor(&moving_rogue, weapon, tick);
    assert_eq!(
        moving_rogue_breakdown.movement_degrees_milli,
        SKIRMISHER_MOVING_FIRE_SPREAD_DEGREES_MILLI
    );
    assert_eq!(
        moving_agent_breakdown.total_degrees_milli,
        moving_rogue_breakdown
            .total_degrees_milli
            .saturating_add(MARKSMAN_NOVICE_RIFLE_SPREAD_PENALTY_DEGREES_MILLI)
    );

    let mut moving_trained_agent = master_agent.clone();
    moving_trained_agent.next_move_tick = tick.saturating_add(1);
    let moving_trained_breakdown =
        shot_spread_breakdown_for_actor(&moving_trained_agent, weapon, tick);
    assert!(
        moving_trained_breakdown.movement_degrees_milli
            < moving_agent_breakdown.movement_degrees_milli
    );
    assert_eq!(ammo_profile(weapon, None).damage_multiplier_per_100, 100);

    let winded = state.actors.get_mut("agent").unwrap();
    winded.vitals.action = 1;
    assert!(
        shot_spread_degrees_milli_for_actor(winded, weapon, tick)
            > shot_spread_degrees_milli_for_actor(&agent, weapon, tick)
    );
}

#[test]
fn authority_actor_snapshot_exposes_authoritative_shot_spread() {
    let mut snapshot = crate::authority_test_slice();
    snapshot.actors.clear();
    snapshot.npc_jobs.clear();
    snapshot.actors.push(test_actor(
        "agent",
        "Agent",
        "agent_player",
        CellSnapshot::new(10, 10),
        "right",
    ));
    let mut state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    grant_test_profession(&mut state, "agent", AuthorityProfessionKind::Marksman);
    let tick = state.tick;
    let agent = state.actors.get("agent").unwrap().clone();
    let weapon = weapon_profile(Some(AuthorityWeaponId::Slugthrower));
    let expected = shot_spread_degrees_milli_for_actor(&agent, weapon, tick);
    assert_eq!(
        expected,
        SLUGTHROWER_BASE_SPREAD_DEGREES_MILLI
            + SKIRMISHER_SPREAD_BIAS_DEGREES_MILLI
            + MARKSMAN_NOVICE_RIFLE_SPREAD_PENALTY_DEGREES_MILLI,
        "bare novice marksman carries the full role envelope"
    );
    let agent_snapshot = state.actor_snapshot("agent").expect("agent snapshot");
    assert_eq!(agent_snapshot.shot_spread_degrees_milli, expected);

    state.actors.get_mut("agent").unwrap().equipped_weapon_id = None;
    let unarmed_snapshot = state.actor_snapshot("agent").expect("agent snapshot");
    assert_eq!(
        unarmed_snapshot.shot_spread_degrees_milli, 0,
        "unarmed actors expose no spread envelope"
    );
}

#[test]
fn authority_body_spirit_traits_derive_role_vitals() {
    let mut snapshot = crate::authority_test_slice();
    snapshot.actors.clear();
    snapshot.npc_jobs.clear();
    snapshot.actors.push(test_actor(
        "vendor",
        "Vendor",
        "public_shopkeeper",
        CellSnapshot::new(10, 10),
        "front",
    ));
    snapshot.actors.push(test_actor(
        "creature",
        "Gaia Creature",
        "creature",
        CellSnapshot::new(12, 10),
        "front",
    ));

    let state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    let vendor = state.actor_snapshot("vendor").unwrap();
    let creature = state.actor_snapshot("creature").unwrap();

    assert_eq!(
        vendor.vitals,
        AuthorityVitals {
            health: 92,
            action: 91,
            spirit: 86
        }
    );
    assert_eq!(vendor.max_vitals, AuthorityVitals::default());
    assert_eq!(
        creature.vitals,
        AuthorityVitals {
            health: 58,
            action: 56,
            spirit: 42
        }
    );
    assert_eq!(creature.max_vitals, AuthorityVitals::default());
}

#[test]
fn authority_spirit_changes_suppression_panic_utility() {
    let mut snapshot = crate::authority_test_slice();
    snapshot.actors.clear();
    snapshot.npc_jobs.clear();
    snapshot.actors.push(test_actor(
        "low-spirit-creature",
        "Low Spirit Creature",
        "creature",
        CellSnapshot::new(20, 20),
        "left",
    ));
    snapshot.actors.push(test_actor(
        "high-spirit-creature",
        "High Spirit Creature",
        "creature",
        CellSnapshot::new(22, 20),
        "left",
    ));
    let mut state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    {
        let high = state.actors.get_mut("high-spirit-creature").unwrap();
        high.effective_stats = derive_effective_actor_stats(ActorTraits {
            body: 58,
            spirit: 140,
        });
        high.max_vitals = high.effective_stats.max_vitals;
        high.vitals.spirit = high.max_vitals.spirit;
    }

    let source = AuthorityPosition::from_cell(AuthorityCell::new(18, 20));
    state.apply_suppression_to_actor("low-spirit-creature", 14_000, source);
    state.apply_suppression_to_actor("high-spirit-creature", 14_000, source);

    let low = state.actors.get("low-spirit-creature").unwrap();
    let high = state.actors.get("high-spirit-creature").unwrap();
    assert!(matches!(
        low.ai,
        Some(AuthorityAiState::PassiveCreature(PassiveCreatureAiState {
            mode: PassiveCreatureMode::Flee,
            ..
        }))
    ));
    assert!(matches!(
        high.ai,
        Some(AuthorityAiState::PassiveCreature(PassiveCreatureAiState {
            mode: PassiveCreatureMode::Roam,
            ..
        }))
    ));
    assert!(
        suppression_threshold_milli_for_actor(high) > suppression_threshold_milli_for_actor(low)
    );
}

#[test]
fn authority_spirit_regens_after_suppression_when_alive() {
    let config = SliceAuthorityConfig::default();
    let mut snapshot = crate::authority_test_slice();
    snapshot.actors.clear();
    snapshot.npc_jobs.clear();
    snapshot.actors.push(test_actor(
        "player",
        "Field Observer",
        "player",
        CellSnapshot::new(20, 20),
        "right",
    ));
    let mut state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    let source = AuthorityPosition::from_cell(AuthorityCell::new(16, 20));

    let before = state.actors.get("player").unwrap().vitals.spirit;
    state.apply_suppression_to_actor("player", 24_000, source);
    let drained = state.actors.get("player").unwrap().vitals.spirit;
    assert!(
        drained < before,
        "suppression should spend Spirit/composure"
    );

    state.advance_ticks_for_observer(&config, 90);
    let recovered = state.actors.get("player").unwrap().vitals.spirit;
    assert!(
        recovered > drained,
        "alive unbled actors should recover Spirit"
    );
    assert!(recovered <= before);
}

#[test]
fn authority_generates_cover_points_from_authored_cover_props() {
    let mut snapshot = crate::authority_test_slice();
    snapshot.actors.clear();
    snapshot.npc_jobs.clear();
    snapshot.props.clear();
    snapshot.blocked_cells.clear();
    snapshot.props.push(test_cover_prop(
        "cover-wall",
        CellSnapshot::new(10, 9),
        crate::CellSizeSnapshot { w: 1, h: 3 },
    ));
    for y in 9..12 {
        snapshot.blocked_cells.push(crate::BlockedCellSnapshot::new(
            crate::AUTHORITY_TEST_AREA_ID,
            10,
            y,
        ));
    }

    let state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    let points = state
        .cover_points
        .iter()
        .filter(|point| point.prop_id == "cover-wall")
        .collect::<Vec<_>>();
    assert!(
        points.len() > 8,
        "high cover should expose the original edge points plus a larger trunk shadow"
    );
    assert!(points.iter().any(|point| point.side == CoverSide::East));
    assert!(points.iter().any(|point| point.side == CoverSide::West));
    assert!(points.iter().any(|point| point.side == CoverSide::North));
    assert!(points.iter().any(|point| point.side == CoverSide::South));
    assert!(points.iter().any(|point| {
        point.side == CoverSide::East && point.cell == AuthorityCell::new(14, 10)
    }));
    assert!(points
        .iter()
        .any(|point| { point.side == CoverSide::West && point.cell == AuthorityCell::new(7, 10) }));
}

#[test]
fn authority_generates_cover_points_from_fine_collision_bounds() {
    let mut snapshot = crate::authority_test_slice();
    snapshot.actors.clear();
    snapshot.npc_jobs.clear();
    snapshot.props.clear();
    snapshot.blocked_cells.clear();
    let mut prop = test_cover_prop(
        "tree-core",
        CellSnapshot::new(10, 9),
        crate::CellSizeSnapshot { w: 4, h: 4 },
    );
    prop.collision_bounds.push(crate::CollisionBoundsSnapshot {
        x_milli: 1_500,
        y_milli: 1_500,
        w_milli: 500,
        h_milli: 500,
    });
    snapshot.props.push(prop);

    let state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    let points = state
        .cover_points
        .iter()
        .filter(|point| point.prop_id == "tree-core")
        .collect::<Vec<_>>();

    assert!(
        points.len() > 4,
        "fine collision bounds should seed edge points at the trunk and expand only the high-cover shadow"
    );
    assert!(points
        .iter()
        .any(|point| point.side == CoverSide::North && point.cell == AuthorityCell::new(11, 9)));
    assert!(points.iter().any(|point| {
        point.side == CoverSide::South && point.cell == AuthorityCell::new(11, 11)
    }));
    assert!(points
        .iter()
        .any(|point| point.side == CoverSide::West && point.cell == AuthorityCell::new(10, 10)));
    assert!(points
        .iter()
        .any(|point| point.side == CoverSide::East && point.cell == AuthorityCell::new(12, 10)));
    assert!(points.iter().any(|point| {
        point.side == CoverSide::East && point.cell == AuthorityCell::new(15, 10)
    }));
    assert!(points.iter().any(|point| {
        point.side == CoverSide::North && point.cell == AuthorityCell::new(11, 6)
    }));
}

#[test]
fn authority_fine_collision_bounds_block_circle_overlap() {
    let mut snapshot = crate::authority_test_slice();
    snapshot.actors.clear();
    snapshot.npc_jobs.clear();
    snapshot.props.clear();
    snapshot.blocked_cells.clear();
    let mut prop = test_cover_prop(
        "narrow-post",
        CellSnapshot::new(10, 10),
        crate::CellSizeSnapshot { w: 3, h: 2 },
    );
    prop.collision_bounds.push(crate::CollisionBoundsSnapshot {
        x_milli: 1_000,
        y_milli: 0,
        w_milli: 1_000,
        h_milli: 1_000,
    });
    snapshot.props.push(prop);

    let state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();

    assert!(!state.position_blocked(
        crate::AUTHORITY_TEST_AREA_ID,
        AuthorityPosition::from_cell(AuthorityCell::new(10, 10))
    ));
    assert!(state.position_blocked(
        crate::AUTHORITY_TEST_AREA_ID,
        AuthorityPosition::from_cell(AuthorityCell::new(11, 10))
    ));
    assert!(!state.position_blocked(
        crate::AUTHORITY_TEST_AREA_ID,
        AuthorityPosition::from_cell(AuthorityCell::new(12, 10))
    ));
    assert!(!state.position_blocked(
        crate::AUTHORITY_TEST_AREA_ID,
        AuthorityPosition::from_cell(AuthorityCell::new(13, 10))
    ));
}

#[test]
fn authority_slugthrower_manual_reload_spends_pack_reserve_on_completion() {
    let config = SliceAuthorityConfig::default();
    let mut snapshot = crate::authority_test_slice();
    snapshot.actors.clear();
    snapshot.npc_jobs.clear();
    snapshot.props.clear();
    snapshot.blocked_cells.clear();
    snapshot.inventory.clear();
    snapshot.actors.push(test_actor(
        "player",
        "Field Observer",
        "player",
        CellSnapshot::new(20, 20),
        "right",
    ));
    snapshot.inventory.push(InventoryStackSnapshot {
        stack_id: 0,
        container: "player:ammo".to_owned(),
        item: "Iron Slug".to_owned(),
        item_id: AMMO_SLUG_IRON_ITEM_ID,
        variant_id: 0,
        quantity: 300,
        reserved: 0,
        available: 300,
    });

    let mut state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    state
        .actors
        .get_mut("player")
        .expect("player exists")
        .slugthrower_magazine
        .loaded_rounds = SLUGTHROWER_MAGAZINE_SIZE - 1;
    assert_eq!(
        state
            .actors
            .get("player")
            .expect("player exists")
            .slugthrower_magazine
            .loaded_rounds,
        SLUGTHROWER_MAGAZINE_SIZE - 1
    );
    assert_eq!(
        state
            .actor_inventory_item_available("player", AMMO_SLUG_IRON_ITEM_ID)
            .expect("ammo is tracked"),
        300
    );

    let frame = state.apply_envelope(
        &config,
        command(
            1,
            ClientCommand::ReloadWeapon {
                weapon_id: Some(AuthorityWeaponId::Slugthrower),
                ammo_type: Some(AuthorityAmmoTypeId::SlugIron),
            },
        ),
    );
    assert_eq!(frame.status, AuthorityCommandStatus::Accepted);
    let reload_until_tick = state
        .actors
        .get("player")
        .expect("player exists")
        .slugthrower_magazine
        .reload_until_tick;
    assert!(reload_until_tick > state.tick);
    assert_eq!(
        state
            .actor_inventory_item_available("player", AMMO_SLUG_IRON_ITEM_ID)
            .expect("ammo is tracked"),
        300
    );

    while state.tick < reload_until_tick {
        state.advance_ticks_for_observer(&config, 1);
    }
    assert_eq!(
        state
            .actors
            .get("player")
            .expect("player exists")
            .slugthrower_magazine
            .loaded_rounds,
        SLUGTHROWER_MAGAZINE_SIZE
    );
    assert_eq!(
        state
            .actor_inventory_item_available("player", AMMO_SLUG_IRON_ITEM_ID)
            .expect("ammo is tracked"),
        299
    );
}

#[test]
fn authority_crafted_carbine_loaded_magazine_fires_with_tracked_empty_reserve() {
    let (_config, mut state) = roll_combat_test_state();
    state
        .inventory
        .retain(|row| row.item_id != AMMO_SLUG_IRON_ITEM_ID);
    push_test_inventory_stack(
        &mut state,
        "player:field-pack",
        AMMO_SLUG_IRON_ITEM_ID,
        0,
        0,
    );
    {
        let shooter = state.actors.get_mut("player").expect("test shooter exists");
        shooter.equipped_weapon_id = Some(AuthorityWeaponId::WpnCarbine);
        shooter.equipped_weapon_item_id = KILN_ENERGY_CELL_ITEM_ID;
        shooter.equipped_weapon_variant_id = 0;
        shooter.slugthrower_magazine.loaded_rounds = SLUGTHROWER_MAGAZINE_SIZE;
        shooter.slugthrower_magazine.reload_until_tick = 0;
    }
    state.tick = 100;
    assert_eq!(
        state.actor_inventory_item_available("player", AMMO_SLUG_IRON_ITEM_ID),
        Some(0),
        "the zero-quantity row must keep reserve ammo tracked"
    );

    let shots_before = state.actors.get("player").unwrap().shots_fired;
    super::combat_roll::queue_combat_action(&mut state, "player", "aimed_shot", "roll-target")
        .expect("a loaded carbine must queue despite empty tracked reserve");
    state.drain_due_combat_action_queues();

    let shooter = state.actors.get("player").unwrap();
    assert_eq!(
        shooter.shots_fired,
        shots_before + u64::from(super::combat_roll::roll_burst_rounds_for_test())
    );
    assert_eq!(
        shooter.slugthrower_magazine.loaded_rounds,
        SLUGTHROWER_MAGAZINE_SIZE - super::combat_roll::roll_burst_rounds_for_test()
    );
    let repeat = shooter
        .combat_queue
        .repeat_intent
        .as_ref()
        .expect("loaded carbine remains eligible for automatic return fire");
    assert_eq!(
        repeat.action_id,
        super::combat_roll::CombatActionId::BasicShot
    );
    assert_eq!(repeat.source, super::combat_roll::CombatRepeatSource::Auto);
}

#[test]
fn authority_crafted_carbine_consumes_magazine_rounds_and_reloads() {
    let (config, mut state) = roll_combat_test_state();
    state
        .inventory
        .retain(|row| row.item_id != AMMO_SLUG_IRON_ITEM_ID);
    {
        let shooter = state.actors.get_mut("player").expect("test shooter exists");
        shooter.equipped_weapon_id = Some(AuthorityWeaponId::WpnCarbine);
        shooter.equipped_weapon_item_id = KILN_ENERGY_CELL_ITEM_ID;
        shooter.equipped_weapon_variant_id = 0;
        shooter.slugthrower_magazine.loaded_rounds = SLUGTHROWER_MAGAZINE_SIZE;
        shooter.slugthrower_magazine.reload_until_tick = 0;
    }
    state.tick = 100;
    let burst_rounds = super::combat_roll::roll_burst_rounds_for_test();
    super::combat_roll::queue_combat_action(&mut state, "player", "basic_shot", "roll-target")
        .expect("Kiln burst queues");
    state.drain_due_combat_action_queues();
    assert_eq!(
        state
            .actors
            .get("player")
            .expect("test shooter exists")
            .slugthrower_magazine
            .loaded_rounds,
        SLUGTHROWER_MAGAZINE_SIZE - burst_rounds
    );
    let peace = state.apply_envelope(&config, command(2, ClientCommand::Peace {}));
    assert_eq!(peace.status, AuthorityCommandStatus::Accepted);

    let reload = state.apply_envelope(
        &config,
        command(
            3,
            ClientCommand::ReloadWeapon {
                weapon_id: Some(AuthorityWeaponId::WpnCarbine),
                ammo_type: Some(AuthorityAmmoTypeId::SlugIron),
            },
        ),
    );
    assert_eq!(reload.status, AuthorityCommandStatus::Accepted);
    let reload_until_tick = state
        .actors
        .get("player")
        .expect("test shooter exists")
        .slugthrower_magazine
        .reload_until_tick;
    assert!(reload_until_tick > state.tick);
    while state.tick < reload_until_tick {
        state.advance_ticks_for_observer(&config, 1);
    }
    let weapon = &state
        .actors
        .get("player")
        .expect("test shooter exists")
        .slugthrower_magazine;
    assert_eq!(weapon.loaded_rounds, SLUGTHROWER_MAGAZINE_SIZE);
    assert_eq!(weapon.reload_until_tick, 0);
}

#[test]
fn authority_rejects_cover_points_exposed_to_threat_fire_lane() {
    let mut snapshot = crate::authority_test_slice();
    snapshot.actors.clear();
    snapshot.npc_jobs.clear();
    snapshot.props.clear();
    snapshot.blocked_cells.clear();
    snapshot.actors.push(test_actor(
        "skirmish-red-anchor",
        "Red Anchor",
        "skirmisher_anchor",
        CellSnapshot::new(13, 10),
        "left",
    ));
    snapshot.props.push(test_cover_prop(
        "tree-core",
        CellSnapshot::new(10, 10),
        crate::CellSizeSnapshot { w: 1, h: 1 },
    ));
    snapshot.blocked_cells.push(crate::BlockedCellSnapshot::new(
        crate::AUTHORITY_TEST_AREA_ID,
        10,
        10,
    ));

    let state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    let actor = state.actors.get("skirmish-red-anchor").unwrap();
    let profile = skirmisher_profile_for_actor(actor, 1);

    let exposed_position = AuthorityPosition::from_cell(AuthorityCell::new(12, 9));
    assert!(
        !state.actor_position_protected_from_threat(
            actor,
            exposed_position,
            AuthorityPosition::from_cell(AuthorityCell::new(6, 7)),
        ),
        "cover is not valid unless the Roll line of sight is actually occluded"
    );

    let aligned_cover = state
        .best_cover_position_for_actor(
            actor,
            AuthorityPosition::from_cell(AuthorityCell::new(6, 10)),
            profile,
        )
        .expect("aligned threat lane should produce a real occluding cover point");
    assert_ne!(aligned_cover, exposed_position);
    assert!(state.actor_position_protected_from_threat(
        actor,
        aligned_cover,
        AuthorityPosition::from_cell(AuthorityCell::new(6, 10)),
    ));
}

#[test]
fn authority_skirmisher_switches_stale_focus_to_immediate_threat() {
    let config = SliceAuthorityConfig::default();
    let mut snapshot = crate::authority_test_slice();
    snapshot.actors.clear();
    add_test_factions(&mut snapshot);
    snapshot.npc_jobs.clear();
    snapshot.props.clear();
    snapshot.blocked_cells.clear();
    snapshot.actors.push(test_actor(
        "skirmish-red-stale-focus",
        "Red Stale Focus",
        "skirmisher",
        CellSnapshot::new(10, 20),
        "right",
    ));
    snapshot.actors.push(test_actor(
        "skirmish-blue-far",
        "Blue Far",
        "skirmisher",
        CellSnapshot::new(43, 20),
        "left",
    ));
    snapshot.actors.push(test_actor(
        "skirmish-blue-near",
        "Blue Near",
        "skirmisher",
        CellSnapshot::new(30, 20),
        "left",
    ));

    let mut state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    {
        let red = state.actors.get_mut("skirmish-red-stale-focus").unwrap();
        let Some(AuthorityAiState::Skirmisher(ai)) = red.ai.as_mut() else {
            panic!("red actor should use skirmisher AI");
        };
        ai.target_actor_id = Some("skirmish-blue-far".to_owned());
        ai.next_decision_tick = 10_000;
        ai.next_shot_tick = 0;
        ai.next_update_tick = 0;
        ai.last_update_tick = 0;
    }

    state.advance_ticks_for_observer(&config, 8);

    let red = state.actors.get("skirmish-red-stale-focus").unwrap();
    assert!(
        red.shots_fired > 0,
        "skirmisher should shoot the closer immediate threat instead of chasing stale focus"
    );
    let Some(AuthorityAiState::Skirmisher(ai)) = red.ai.as_ref() else {
        panic!("red actor should use skirmisher AI");
    };
    assert_eq!(ai.target_actor_id.as_deref(), Some("skirmish-blue-near"));
}

#[test]
fn authority_skirmisher_zero_inventory_ammo_fires_without_refill_behavior() {
    let config = SliceAuthorityConfig::default();
    let mut snapshot = crate::authority_test_slice();
    snapshot.actors.clear();
    add_test_factions(&mut snapshot);
    snapshot.npc_jobs.clear();
    snapshot.props.clear();
    snapshot.inventory.clear();
    snapshot.blocked_cells.clear();
    snapshot.actors.push(test_actor(
        "skirmish-red-unlimited-ammo",
        "Red Unlimited Ammo",
        "skirmisher",
        CellSnapshot::new(10, 20),
        "right",
    ));
    snapshot.actors.push(test_actor(
        "skirmish-blue-threat",
        "Blue Threat",
        "skirmisher",
        CellSnapshot::new(26, 20),
        "left",
    ));

    let mut state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    {
        let red = state.actors.get_mut("skirmish-red-unlimited-ammo").unwrap();
        red.vitals.health = 100_000;
        red.max_vitals.health = 100_000;
        red.slugthrower_magazine.loaded_rounds = 0;
        red.slugthrower_magazine.reload_until_tick = 0;
        let Some(AuthorityAiState::Skirmisher(ai)) = red.ai.as_mut() else {
            panic!("red actor should use skirmisher AI");
        };
        ai.next_shot_tick = 0;
        ai.next_update_tick = 0;
        ai.last_update_tick = 0;
    }
    {
        let blue = state.actors.get_mut("skirmish-blue-threat").unwrap();
        blue.vitals.health = 100_000;
        blue.max_vitals.health = 100_000;
    }
    assert!(!state.actor_tracks_ammo_item("skirmish-red-unlimited-ammo", AMMO_SLUG_IRON_ITEM_ID));
    assert_eq!(
        state.actor_inventory_item_available("skirmish-red-unlimited-ammo", AMMO_SLUG_IRON_ITEM_ID),
        None
    );

    let refill_reasons = [
        "seek_ammo_stockpile",
        "ammo_stockpile_no_stockpile",
        "ammo_stockpile_path_blocked",
        "ammo_stockpile_no_slot",
        "refilled_ammo",
        "ammo_refill_satisfied",
        "ammo_refill_failed",
    ];
    let mut forbidden_reason = None;
    for _ in 0..360 {
        state.advance_ticks_for_observer(&config, 1);
        forbidden_reason = state
            .ai_debug_snapshot()
            .actors
            .into_iter()
            .find(|row| {
                row.actor_id == "skirmish-red-unlimited-ammo"
                    && refill_reasons.contains(&row.reason.as_str())
            })
            .map(|row| row.reason);
        if forbidden_reason.is_some() {
            break;
        }
        if state
            .actors
            .get("skirmish-red-unlimited-ammo")
            .is_some_and(|actor| actor.shots_fired >= 8)
        {
            break;
        }
    }

    assert_eq!(forbidden_reason, None);
    let red = state.actors.get("skirmish-red-unlimited-ammo").unwrap();
    assert!(
        red.shots_fired >= 8,
        "NPC with zero inventory ammo should keep firing multiple bursts"
    );
}

#[test]
fn authority_ai_debug_trim_preserves_best_accepted_candidate() {
    let rejected = |index: i32| AuthorityAiTacticalCandidateDebug {
        stage: "good_cover".to_owned(),
        kind: format!("rejected-{index}"),
        position: authority_ai_debug_position_from_position(AuthorityPosition {
            x: index * 1_000,
            y: 0,
        }),
        score: i64::from(index),
        accepted: false,
        rejection: Some("blocked".to_owned()),
        has_shot: false,
        protected: false,
        pathable: false,
        terrain_pathable: false,
        pathfinder_pathable: false,
        body_blocked: false,
        claimed: false,
        inside_lane: true,
        crosses_no_mans_land: false,
        range_error_milli: 0,
        lane_error_milli: 0,
        cover_prop_id: None,
    };
    let mut candidates: Vec<_> = (0..SKIRMISHER_TACTICAL_CANDIDATE_DEBUG_LIMIT)
        .map(|index| rejected(index as i32))
        .collect();
    candidates.push(AuthorityAiTacticalCandidateDebug {
        stage: "evasion".to_owned(),
        kind: "chosen-late".to_owned(),
        position: authority_ai_debug_position_from_position(AuthorityPosition { x: 99_000, y: 0 }),
        score: 90_000,
        accepted: true,
        rejection: None,
        has_shot: false,
        protected: false,
        pathable: true,
        terrain_pathable: true,
        pathfinder_pathable: true,
        body_blocked: false,
        claimed: false,
        inside_lane: true,
        crosses_no_mans_land: false,
        range_error_milli: 0,
        lane_error_milli: 0,
        cover_prop_id: None,
    });

    let trimmed = crate::combat_ai::debug::trim_authority_tactical_candidates(
        candidates,
        SKIRMISHER_TACTICAL_CANDIDATE_DEBUG_LIMIT,
    );

    assert_eq!(trimmed.len(), SKIRMISHER_TACTICAL_CANDIDATE_DEBUG_LIMIT);
    assert!(trimmed
        .iter()
        .any(|candidate| candidate.stage == "evasion" && candidate.accepted));
}

#[test]
fn authority_skirmisher_pathfinding_routes_around_blocked_cells() {
    let mut snapshot = crate::authority_test_slice();
    snapshot.actors.clear();
    snapshot.npc_jobs.clear();
    snapshot.props.clear();
    snapshot.blocked_cells.clear();
    snapshot.actors.push(test_actor(
        "skirmish-red-assault",
        "Red Assault",
        "skirmisher_assault",
        CellSnapshot::new(8, 10),
        "right",
    ));
    snapshot.blocked_cells.push(crate::BlockedCellSnapshot::new(
        crate::AUTHORITY_TEST_AREA_ID,
        9,
        10,
    ));

    let mut state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    let moved = state.move_ai_actor_toward_position_pathing(
        "skirmish-red-assault",
        AuthorityPosition::from_cell(AuthorityCell::new(12, 10)),
        MILLI_CELLS_PER_CELL,
    );

    let actor = state.actors.get("skirmish-red-assault").unwrap();
    assert!(moved);
    assert_ne!(actor.cell, AuthorityCell::new(9, 10));
    assert!(
        actor.cell.y != 10 || actor.cell.x <= 8,
        "pathing should choose a detour instead of stepping into the blocked straight lane"
    );
}

#[test]
fn authority_ai_pathfinding_routes_with_body_clearance_around_cover_block() {
    let mut snapshot = crate::authority_test_slice();
    snapshot.actors.clear();
    snapshot.npc_jobs.clear();
    snapshot.props.clear();
    snapshot.blocked_cells.clear();
    snapshot.actors.push(test_actor(
        "skirmish-red-assault",
        "Red Assault",
        "skirmisher_assault",
        CellSnapshot::new(8, 10),
        "right",
    ));
    let mut prop = test_cover_prop(
        "cover-block",
        CellSnapshot::new(10, 8),
        crate::CellSizeSnapshot { w: 4, h: 6 },
    );
    prop.collision_bounds.push(crate::CollisionBoundsSnapshot {
        x_milli: 0,
        y_milli: 0,
        w_milli: 4_000,
        h_milli: 6_000,
    });
    snapshot.props.push(prop);

    let mut state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    let moved = state.move_ai_actor_toward_position_pathing(
        "skirmish-red-assault",
        AuthorityPosition::from_cell(AuthorityCell::new(16, 10)),
        MILLI_CELLS_PER_CELL,
    );

    let actor = state.actors.get("skirmish-red-assault").unwrap().clone();
    assert!(moved);
    assert_eq!(
        actor.cell.x, 8,
        "pathing should start a berth-preserving detour instead of walking straight at cover"
    );
    assert_ne!(
        actor.cell.y, 10,
        "pathing should route around the cover clearance envelope"
    );
    assert!(
        !state.ai_position_clearance_blocked(&actor.area_id, actor.position),
        "accepted movement must keep the actor body plus clearance out of cover"
    );
}

#[test]
fn authority_ai_body_collision_blocks_cover_overlap_even_when_center_is_clear() {
    let mut snapshot = crate::authority_test_slice();
    snapshot.actors.clear();
    snapshot.npc_jobs.clear();
    snapshot.props.clear();
    snapshot.blocked_cells.clear();
    snapshot.actors.push(test_actor(
        "skirmish-red-assault",
        "Red Assault",
        "skirmisher_assault",
        CellSnapshot::new(9, 10),
        "right",
    ));
    let mut prop = test_cover_prop(
        "narrow-post",
        CellSnapshot::new(10, 10),
        crate::CellSizeSnapshot { w: 3, h: 2 },
    );
    prop.collision_bounds.push(crate::CollisionBoundsSnapshot {
        x_milli: 1_000,
        y_milli: 0,
        w_milli: 1_000,
        h_milli: 1_000,
    });
    snapshot.props.push(prop);

    let state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    let actor = state.actors.get("skirmish-red-assault").unwrap();
    let body_overlap = AuthorityPosition {
        x: 10_100,
        y: 10_000,
    };

    assert!(
        !state.position_blocked(crate::AUTHORITY_TEST_AREA_ID, body_overlap),
        "the legacy center-point check alone would allow this position"
    );
    assert!(
        state.ai_actor_body_blocked(actor, body_overlap),
        "AI movement must reject actor-body overlap with fine collision"
    );
}

#[test]
fn authority_ai_debug_splits_body_blocked_candidate_reasons() {
    let mut snapshot = crate::authority_test_slice();
    snapshot.actors.clear();
    snapshot.npc_jobs.clear();
    snapshot.props.clear();
    snapshot.blocked_cells.clear();
    snapshot.actors.push(test_actor(
        "skirmish-red-assault",
        "Red Assault",
        "skirmisher_assault",
        CellSnapshot::new(9, 10),
        "right",
    ));
    snapshot.actors.push(test_actor(
        "skirmish-blue-target",
        "Blue Target",
        "target_dummy",
        CellSnapshot::new(14, 10),
        "left",
    ));
    let mut prop = test_cover_prop(
        "narrow-post",
        CellSnapshot::new(10, 10),
        crate::CellSizeSnapshot { w: 3, h: 2 },
    );
    prop.collision_bounds.push(crate::CollisionBoundsSnapshot {
        x_milli: 1_000,
        y_milli: 0,
        w_milli: 1_000,
        h_milli: 1_000,
    });
    snapshot.props.push(prop);

    let state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    let actor = state.actors.get("skirmish-red-assault").unwrap();
    let target = state.actors.get("skirmish-blue-target").unwrap();
    let candidate = AuthorityPosition {
        x: 10_100,
        y: 10_000,
    };
    let mut debug = Vec::new();
    let request = TacticalEngagementPolicy {
        require_shot: false,
        prefer_cover: true,
        cover_required: false,
        prefer_evasion: false,
        allow_offensive_maneuver: false,
        allow_flank: false,
        allow_retreat: false,
    };

    let accepted = state.consider_skirmisher_tactical_candidate(
        None,
        actor,
        combat_micro_state(actor.ai.as_ref()),
        target,
        skirmisher_profile_for_actor(actor, 1),
        None,
        &SkirmisherReservations::default(),
        request,
        SkirmisherTacticalStage::GoodCover,
        candidate,
        "high_cover",
        None,
        None,
        &mut debug,
    );

    assert!(accepted.is_none());
    let row = debug.first().expect("candidate debug row");
    assert_eq!(row.rejection.as_deref(), Some("body_blocked"));
    assert!(row.body_blocked);
    assert!(!row.terrain_pathable);
    assert!(!row.pathfinder_pathable);
    assert!(!row.pathable);
}

#[test]
fn authority_skirmisher_tactical_choice_rejects_recently_blocked_slot() {
    let mut snapshot = crate::authority_test_slice();
    snapshot.actors.clear();
    add_test_factions(&mut snapshot);
    snapshot.npc_jobs.clear();
    snapshot.props.clear();
    snapshot.blocked_cells.clear();
    snapshot.actors.push(test_actor(
        "skirmish-red-assault",
        "Red Assault",
        "skirmisher_assault",
        CellSnapshot::new(10, 20),
        "right",
    ));
    snapshot.actors.push(test_actor(
        "skirmish-blue-target",
        "Blue Target",
        "skirmisher",
        CellSnapshot::new(35, 20),
        "left",
    ));

    let mut state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    state.tick = 42;
    let actor = state.actors.get("skirmish-red-assault").unwrap();
    let target = state.actors.get("skirmish-blue-target").unwrap();
    let mut ai = match actor.ai.clone().expect("red actor should have AI") {
        AuthorityAiState::Skirmisher(ai) => ai,
        _ => panic!("red actor should use skirmisher AI"),
    };
    let blocked = AuthorityPosition {
        x: actor.position.x,
        y: actor.position.y.saturating_add(1_500),
    };
    note_skirmisher_blocked_target(
        &mut ai,
        state.tick,
        blocked,
        SKIRMISHER_BLOCKED_TARGET_MEMORY_TICKS,
    );
    let request = TacticalEngagementPolicy {
        require_shot: true,
        prefer_cover: false,
        cover_required: false,
        prefer_evasion: false,
        allow_offensive_maneuver: true,
        allow_flank: true,
        allow_retreat: false,
    };

    let choice = state
        .best_skirmisher_tactical_choice(
            actor,
            Some(&ai),
            ai.seed,
            target,
            skirmisher_profile_for_actor(actor, ai.seed),
            None,
            &SkirmisherReservations::default(),
            request,
        )
        .expect("other tactical firing lanes should remain available");

    assert_ne!(
        choice.position, blocked,
        "recently blocked slots must not be selected again immediately"
    );
    let row = choice
        .candidates
        .iter()
        .find(|candidate| {
            candidate.position.x_milli == blocked.x && candidate.position.y_milli == blocked.y
        })
        .expect("blocked local peek candidate should be represented in debug");
    assert!(!row.accepted);
    assert_eq!(row.rejection.as_deref(), Some("recently_blocked"));
}

#[test]
fn authority_protective_cover_rejects_body_blocked_cover_points() {
    let mut snapshot = crate::authority_test_slice();
    snapshot.actors.clear();
    snapshot.npc_jobs.clear();
    snapshot.props.clear();
    snapshot.blocked_cells.clear();
    snapshot.actors.push(test_actor(
        "skirmish-red-assault",
        "Red Assault",
        "skirmisher_assault",
        CellSnapshot::new(9, 10),
        "right",
    ));
    let mut prop = test_cover_prop(
        "narrow-post",
        CellSnapshot::new(10, 10),
        crate::CellSizeSnapshot { w: 3, h: 2 },
    );
    prop.collision_bounds.push(crate::CollisionBoundsSnapshot {
        x_milli: 1_000,
        y_milli: 0,
        w_milli: 1_000,
        h_milli: 1_000,
    });
    snapshot.props.push(prop);

    let mut state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    state.cover_points.clear();
    let actor = state.actors.get("skirmish-red-assault").unwrap().clone();
    let body_blocked_cover = AuthorityPosition {
        x: 10_100,
        y: 10_000,
    };
    let valid_cover = AuthorityPosition {
        x: 6_000,
        y: 10_000,
    };
    assert!(
        !state.position_blocked(crate::AUTHORITY_TEST_AREA_ID, body_blocked_cover),
        "the cover center is intentionally passable"
    );
    assert!(
        state.ai_actor_body_blocked(&actor, body_blocked_cover),
        "the actor body must reject this authored cover position"
    );
    state.cover_points.push(CoverPointAuthorityState {
        prop_id: "body-blocked-cover".to_owned(),
        area_id: crate::AUTHORITY_TEST_AREA_ID.to_owned(),
        position: body_blocked_cover,
        cell: body_blocked_cover.cell(),
        side: CoverSide::South,
        rating_milli: 2_000,
        high: true,
        prop_left: 10_000,
        prop_right: 13_000,
        prop_top: 10_000,
        prop_bottom: 12_000,
    });
    state.cover_points.push(CoverPointAuthorityState {
        prop_id: "valid-cover".to_owned(),
        area_id: crate::AUTHORITY_TEST_AREA_ID.to_owned(),
        position: valid_cover,
        cell: valid_cover.cell(),
        side: CoverSide::West,
        rating_milli: 1_000,
        high: true,
        prop_left: 5_000,
        prop_right: 7_000,
        prop_top: 10_000,
        prop_bottom: 12_000,
    });

    let selected = state.nearest_protective_cover_position(
        &actor,
        AuthorityPosition { x: 9_000, y: 7_000 },
        skirmisher_profile_for_actor(&actor, 7),
        &SkirmisherReservations::default(),
    );

    assert_eq!(
        selected,
        Some(valid_cover),
        "HOLD/PROTECT cover selection must use actor-body legality, not only center legality"
    );
}

#[test]
fn authority_skirmisher_tick_ai_preserves_move_memory() {
    let config = SliceAuthorityConfig::default();
    let mut snapshot = crate::authority_test_slice();
    snapshot.actors.clear();
    add_test_factions(&mut snapshot);
    snapshot.npc_jobs.clear();
    snapshot.props.clear();
    snapshot.blocked_cells.clear();
    snapshot.actors.push(test_actor(
        "skirmish-red-assault",
        "Red Assault",
        "skirmisher_assault",
        CellSnapshot::new(10, 20),
        "right",
    ));
    snapshot.actors.push(test_actor(
        "skirmish-blue-anchor",
        "Blue Anchor",
        "skirmisher_anchor",
        CellSnapshot::new(70, 20),
        "left",
    ));

    let mut state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    let before = state.actors.get("skirmish-red-assault").unwrap().position;
    state.advance_ticks_for_observer(&config, 20);
    let red = state.actors.get("skirmish-red-assault").unwrap();
    assert!(
        position_distance_milli(before, red.position) > 0,
        "test setup should make the red skirmisher advance toward contact"
    );
    let AuthorityAiState::Skirmisher(ai) = red.ai.as_ref().unwrap() else {
        panic!("red actor should use skirmisher AI");
    };
    assert!(
        ai.last_move_tick > 0
            && distance_milli_components(ai.last_move_dx_milli, ai.last_move_dy_milli) > 0,
        "live tick path should preserve skirmisher move memory used by jitter guards"
    );
}

#[test]
fn authority_skirmisher_patrol_waits_during_hostile_contact_without_ai_order() {
    let mut snapshot = crate::authority_test_slice();
    snapshot.actors.clear();
    add_test_factions(&mut snapshot);
    snapshot.npc_jobs.clear();
    snapshot.props.clear();
    snapshot.blocked_cells.clear();
    let mut red = test_actor(
        "skirmish-red-patrol",
        "Red Patrol",
        "skirmisher",
        CellSnapshot::new(10, 20),
        "right",
    );
    red.route = vec![CellSnapshot::new(12, 20), CellSnapshot::new(10, 20)];
    snapshot.actors.push(red);
    snapshot.actors.push(test_actor(
        "skirmish-blue-threat",
        "Blue Threat",
        "skirmisher",
        CellSnapshot::new(20, 20),
        "left",
    ));

    let mut state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    state.tick = 100;
    {
        let red = state.actors.get_mut("skirmish-red-patrol").unwrap();
        red.next_route_tick = 0;
        if let Some(AuthorityAiState::Skirmisher(ai)) = red.ai.as_mut() {
            ai.target_actor_id = None;
            ai.target = None;
            ai.cover = None;
        }
    }
    let before = state.actors.get("skirmish-red-patrol").unwrap().position;
    state.tick_route_actors();
    assert_eq!(
        state.actors.get("skirmish-red-patrol").unwrap().position,
        before,
        "route patrol must not seize a skirmisher that has hostile tactical contact"
    );
}

#[test]
fn authority_skirmisher_ignores_near_axis_locked_micro_corrections() {
    let mut snapshot = crate::authority_test_slice();
    snapshot.actors.clear();
    snapshot.npc_jobs.clear();
    snapshot.props.clear();
    snapshot.blocked_cells.clear();
    snapshot.actors.push(test_actor(
        "skirmish-red-assault",
        "Red Assault",
        "skirmisher_assault",
        CellSnapshot::new(20, 20),
        "right",
    ));

    let mut state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    let before = state.actors.get("skirmish-red-assault").unwrap().position;
    let moved = state.move_ai_actor_toward_position_pathing(
        "skirmish-red-assault",
        AuthorityPosition {
            x: before.x.saturating_add(120),
            y: before
                .y
                .saturating_add(SKIRMISHER_MICRO_CORRECTION_DEADBAND_MILLI_CELLS - 80),
        },
        140,
    );
    let after = state.actors.get("skirmish-red-assault").unwrap().position;

    assert!(!moved);
    assert_eq!(
        before, after,
        "skirmisher AI should not visibly flip through tiny near-cover axis corrections"
    );
}

#[test]
fn authority_skirmisher_blocks_long_micro_x_reversal() {
    let mut snapshot = crate::authority_test_slice();
    snapshot.actors.clear();
    snapshot.npc_jobs.clear();
    snapshot.props.clear();
    snapshot.blocked_cells.clear();
    snapshot.actors.push(test_actor(
        "skirmish-red-assault",
        "Red Assault",
        "skirmisher_assault",
        CellSnapshot::new(20, 20),
        "right",
    ));

    let mut state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    state.tick = 100;
    {
        let last_move_tick = state.tick.saturating_sub(1);
        let actor = state.actors.get_mut("skirmish-red-assault").unwrap();
        let Some(AuthorityAiState::Skirmisher(ai)) = actor.ai.as_mut() else {
            panic!("skirmisher should have skirmisher AI");
        };
        ai.last_move_dx_milli = 140;
        ai.last_move_dy_milli = 0;
        ai.last_move_tick = last_move_tick;
    }

    let before = state.actors.get("skirmish-red-assault").unwrap().position;
    let moved = state.move_ai_actor_toward_position_pathing(
        "skirmish-red-assault",
        AuthorityPosition {
            x: before.x.saturating_sub(3_000),
            y: before.y,
        },
        140,
    );

    let after = state.actors.get("skirmish-red-assault").unwrap().position;
    assert!(
        moved,
        "skirmisher may still take a perpendicular pathing detour"
    );
    assert!(
        after.x >= before.x,
        "default skirmisher tactical pathing should reject immediate back-and-forth x-axis micro corrections; before={before:?} after={after:?}"
    );
}

#[test]
fn authority_fallback_avoidance_skips_last_move_micro_reversal() {
    let mut snapshot = crate::authority_test_slice();
    snapshot.actors.clear();
    snapshot.npc_jobs.clear();
    snapshot.props.clear();
    snapshot.blocked_cells.clear();
    snapshot.actors.push(test_actor(
        "skirmish-red-assault",
        "Red Assault",
        "skirmisher_assault",
        CellSnapshot::new(10, 10),
        "left",
    ));

    let mut state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    state.tick = 100;
    {
        let last_move_tick = state.tick.saturating_sub(1);
        let actor = state.actors.get_mut("skirmish-red-assault").unwrap();
        let Some(AuthorityAiState::Skirmisher(ai)) = actor.ai.as_mut() else {
            panic!("skirmisher should have skirmisher AI");
        };
        ai.last_move_dx_milli = 0;
        ai.last_move_dy_milli = AI_AVOIDANCE_STEP_MIN_MILLI_CELLS;
        ai.last_move_tick = last_move_tick;
    }
    let actor = state.actors.get("skirmish-red-assault").unwrap().clone();

    let avoidance = state
        .ai_avoidance_position(
            &actor,
            AuthorityPosition {
                x: actor.position.x.saturating_sub(4_000),
                y: actor.position.y,
            },
            AI_AVOIDANCE_STEP_MIN_MILLI_CELLS,
        )
        .expect("non-reversing lateral avoidance candidate should remain available");

    assert!(
        avoidance.y >= actor.position.y,
        "fallback avoidance should skip the first clear candidate when it would immediately undo the last tactical micro-step; actor={:?} avoidance={avoidance:?}",
        actor.position
    );
}

#[test]
fn authority_ai_movement_slides_along_cover_edge_when_diagonal_step_is_body_blocked() {
    let mut snapshot = crate::authority_test_slice();
    snapshot.actors.clear();
    snapshot.npc_jobs.clear();
    snapshot.props.clear();
    snapshot.blocked_cells.clear();
    snapshot.actors.push(test_actor(
        "skirmish-red-assault",
        "Red Assault",
        "skirmisher_assault",
        CellSnapshot::new(9, 10),
        "right",
    ));
    let mut prop = test_cover_prop(
        "narrow-post",
        CellSnapshot::new(10, 10),
        crate::CellSizeSnapshot { w: 3, h: 2 },
    );
    prop.collision_bounds.push(crate::CollisionBoundsSnapshot {
        x_milli: 1_000,
        y_milli: 0,
        w_milli: 1_000,
        h_milli: 1_000,
    });
    snapshot.props.push(prop);

    let mut state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    let before = state.actors.get("skirmish-red-assault").unwrap().clone();
    let blocked_diagonal = AuthorityPosition {
        x: before.position.x.saturating_add(2_200),
        y: before.position.y.saturating_add(1_100),
    };
    assert!(state.ai_actor_body_blocked(&before, blocked_diagonal));

    let moved = state.move_ai_actor_to_position("skirmish-red-assault", &before, blocked_diagonal);
    let after = state.actors.get("skirmish-red-assault").unwrap();

    assert!(
        moved,
        "AI should slide along a free axis instead of failing the whole diagonal cover-edge step"
    );
    assert!(!state.ai_actor_body_blocked(after, after.position));
    assert_ne!(after.position, before.position);
    assert_ne!(
        after.position, blocked_diagonal,
        "the blocked diagonal target itself must not be accepted"
    );
}

#[test]
fn authority_skirmisher_scheduled_wait_continues_existing_destination_one_tick() {
    let mut snapshot = crate::authority_test_slice();
    snapshot.actors.clear();
    snapshot.npc_jobs.clear();
    snapshot.props.clear();
    snapshot.blocked_cells.clear();
    snapshot.actors.push(test_actor(
        "skirmisher",
        "Skirmisher",
        "skirmisher",
        CellSnapshot::new(10, 10),
        "right",
    ));
    snapshot.actors.push(test_actor(
        "target",
        "Target",
        "agent_player",
        CellSnapshot::new(80, 10),
        "left",
    ));

    let mut state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    state.tick = 100;
    let actor = state.actors.get("skirmisher").unwrap().clone();
    let mut ai = match actor.ai.clone().expect("skirmisher should have AI") {
        AuthorityAiState::Skirmisher(ai) => ai,
        _ => panic!("skirmisher should be raw skirmisher"),
    };
    ai.target_actor_id = Some("target".to_owned());
    ai.target = Some(AuthorityPosition {
        x: actor.position.x.saturating_add(6_000),
        y: actor.position.y,
    });
    ai.next_update_tick = state.tick.saturating_add(AI_DECISION_CADENCE_TICKS);
    ai.last_update_tick = state.tick.saturating_sub(AI_DECISION_CADENCE_TICKS);

    let profile = skirmisher_profile_for_actor(&actor, ai.seed);
    let one_tick_step_milli = distance_for_ticks(
        scaled_milli(
            profile.speed_milli_cells_per_second,
            movement_speed_multiplier_milli_for_actor(&actor),
        ),
        AI_UPDATE_CADENCE_TICKS,
        state.tick_rate_hz,
    );
    let start = actor.position;
    let reservations = state.skirmisher_reservations();
    let moved = state.advance_skirmisher_ai("skirmisher", &actor, &mut ai, None, &reservations);

    let after = state.actors.get("skirmisher").unwrap().position;
    let moved_milli = position_distance_milli(start, after);
    assert!(moved, "scheduled-wait skirmisher movement should continue");
    assert!(
        moved_milli > 0 && moved_milli <= one_tick_step_milli.saturating_add(1),
        "scheduled-wait skirmisher movement should advance one smooth tick, moved {moved_milli} vs one tick {one_tick_step_milli}"
    );
    assert_eq!(
        ai.next_update_tick,
        state.tick.saturating_add(AI_DECISION_CADENCE_TICKS),
        "locomotion should not pull the expensive decision scheduler forward"
    );
}

#[test]
fn authority_skirmisher_rejects_short_reverse_jitter_at_cover_edge() {
    let mut snapshot = crate::authority_test_slice();
    snapshot.actors.clear();
    snapshot.npc_jobs.clear();
    snapshot.props.clear();
    snapshot.blocked_cells.clear();
    snapshot.actors.push(test_actor(
        "skirmish-red-assault",
        "Red Assault",
        "skirmisher_assault",
        CellSnapshot::new(16, 16),
        "right",
    ));

    let mut state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    state.tick = 100;
    {
        let actor = state.actors.get_mut("skirmish-red-assault").unwrap();
        actor.position = AuthorityPosition {
            x: 16_990,
            y: 16_930,
        };
        actor.cell = actor.position.cell();
        if let Some(AuthorityAiState::Skirmisher(ai)) = actor.ai.as_mut() {
            ai.last_move_dx_milli = 0;
            ai.last_move_dy_milli = 120;
            ai.last_move_tick = 90;
        }
    }
    let before = state.actors.get("skirmish-red-assault").unwrap().clone();
    assert!(is_skirmisher_role(&before.role));
    assert!(
        skirmisher_micro_reversal_blocked(&before, state.tick, 0, -120),
        "test setup should be recognized as a short reverse step"
    );
    let reversed = state.move_ai_actor_to_position(
        "skirmish-red-assault",
        &before,
        AuthorityPosition {
            x: before.position.x,
            y: before.position.y - 120,
        },
    );
    let after_reverse = state.actors.get("skirmish-red-assault").unwrap();

    assert!(!reversed);
    assert_eq!(
        after_reverse.position, before.position,
        "short immediate reverse movement should be treated as cover-edge jitter"
    );

    let before_forward = state.actors.get("skirmish-red-assault").unwrap().clone();
    let continued = state.move_ai_actor_to_position(
        "skirmish-red-assault",
        &before_forward,
        AuthorityPosition {
            x: before_forward.position.x,
            y: before_forward.position.y + 120,
        },
    );
    assert!(
        continued,
        "same-direction micro movement should remain legal so smooth movement still accumulates"
    );
}

#[test]
fn authority_skirmisher_rejects_slow_cover_edge_ping_pong() {
    let mut snapshot = crate::authority_test_slice();
    snapshot.actors.clear();
    snapshot.npc_jobs.clear();
    snapshot.props.clear();
    snapshot.blocked_cells.clear();
    snapshot.actors.push(test_actor(
        "skirmish-red-assault",
        "Red Assault",
        "skirmisher_assault",
        CellSnapshot::new(16, 16),
        "right",
    ));

    let mut state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    state.tick = 220;
    {
        let actor = state.actors.get_mut("skirmish-red-assault").unwrap();
        actor.position = AuthorityPosition {
            x: 16_990,
            y: 16_930,
        };
        actor.cell = actor.position.cell();
        if let Some(AuthorityAiState::Skirmisher(ai)) = actor.ai.as_mut() {
            ai.last_move_dx_milli = 130;
            ai.last_move_dy_milli = 0;
            ai.last_move_tick = 100;
        }
    }
    let before = state.actors.get("skirmish-red-assault").unwrap().clone();
    assert!(
        skirmisher_micro_reversal_blocked(&before, state.tick, -130, 0),
        "sub-cell cover-edge ping-pong should be suppressed beyond the immediate frame"
    );
    let reversed = state.move_ai_actor_to_position(
        "skirmish-red-assault",
        &before,
        AuthorityPosition {
            x: before.position.x - 130,
            y: before.position.y,
        },
    );

    assert!(!reversed);
    assert_eq!(
        state.actors.get("skirmish-red-assault").unwrap().position,
        before.position
    );
}

#[test]
fn authority_skirmisher_rejects_visible_half_cell_reverse_jitter() {
    let mut snapshot = crate::authority_test_slice();
    snapshot.actors.clear();
    snapshot.npc_jobs.clear();
    snapshot.props.clear();
    snapshot.blocked_cells.clear();
    snapshot.actors.push(test_actor(
        "skirmish-red-assault",
        "Red Assault",
        "skirmisher_assault",
        CellSnapshot::new(16, 16),
        "right",
    ));

    let mut state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    state.tick = 220;
    {
        let actor = state.actors.get_mut("skirmish-red-assault").unwrap();
        actor.position = AuthorityPosition {
            x: 16_500,
            y: 16_000,
        };
        actor.cell = actor.position.cell();
        if let Some(AuthorityAiState::Skirmisher(ai)) = actor.ai.as_mut() {
            ai.last_move_dx_milli = 640;
            ai.last_move_dy_milli = 0;
            ai.last_move_tick = 210;
        }
    }
    let before = state.actors.get("skirmish-red-assault").unwrap().clone();
    assert!(
        skirmisher_micro_reversal_blocked(&before, state.tick, -620, 0),
        "half-cell snap-back should be treated as visible skirmisher jitter"
    );
    let reversed = state.move_ai_actor_to_position(
        "skirmish-red-assault",
        &before,
        AuthorityPosition {
            x: before.position.x - 620,
            y: before.position.y,
        },
    );
    assert!(!reversed);
    assert_eq!(
        state.actors.get("skirmish-red-assault").unwrap().position,
        before.position
    );
}

#[test]
fn authority_faction_skirmishers_target_enemy_team() {
    let config = SliceAuthorityConfig::default();
    let mut snapshot = crate::authority_test_slice();
    snapshot.actors.clear();
    add_test_factions(&mut snapshot);
    snapshot.npc_jobs.clear();
    snapshot.props.clear();
    snapshot.blocked_cells.clear();
    snapshot.actors.push(test_actor(
        "skirmish-red-assault",
        "Red Assault",
        "skirmisher_assault",
        CellSnapshot::new(10, 20),
        "right",
    ));
    snapshot.actors.push(test_actor(
        "skirmish-red-anchor",
        "Red Anchor",
        "skirmisher_anchor",
        CellSnapshot::new(10, 23),
        "right",
    ));
    snapshot.actors.push(test_actor(
        "skirmish-blue-assault",
        "Blue Assault",
        "skirmisher_assault",
        CellSnapshot::new(18, 20),
        "left",
    ));

    let mut state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    let roll_cadence_ticks = u16::try_from(ms_to_ticks_round(2_000, state.tick_rate_hz).max(1))
        .expect("roll cadence fits test tick span");
    state.advance_ticks_for_observer(&config, roll_cadence_ticks);

    let blue = state.actors.get("skirmish-blue-assault").unwrap();
    let blue_ai = match blue.ai.as_ref().unwrap() {
        AuthorityAiState::Skirmisher(ai) => ai,
        _ => panic!("blue actor should use skirmisher AI"),
    };
    assert_eq!(
        blue_ai.target_actor_id.as_deref(),
        Some("skirmish-red-assault")
    );
    assert!(
        blue.shots_fired > 0,
        "skirmisher should fire on the hostile faction lane"
    );
    let red_anchor = state.actors.get("skirmish-red-anchor").unwrap();
    let red_anchor_ai = match red_anchor.ai.as_ref().unwrap() {
        AuthorityAiState::Skirmisher(ai) => ai,
        _ => panic!("red anchor should use skirmisher AI"),
    };
    assert_eq!(
        red_anchor_ai.target_actor_id.as_deref(),
        Some("skirmish-blue-assault"),
        "red support actors should spend vector aim on hostile lanes, never same-faction actors"
    );
}

#[test]
fn authority_skirmisher_brawler_strikes_with_vibrosword_in_melee_range() {
    let config = SliceAuthorityConfig::default();
    let mut snapshot = crate::authority_test_slice();
    snapshot.actors.clear();
    add_test_factions(&mut snapshot);
    snapshot.npc_jobs.clear();
    snapshot.props.clear();
    snapshot.blocked_cells.clear();

    let mut brawler = test_actor(
        "skirmish-blue-brawler",
        "Blue Brawler",
        "skirmisher_brawler",
        CellSnapshot::new(10, 20),
        "left",
    );
    brawler.profession_ids.push("brawler".to_owned());
    snapshot.actors.push(brawler);

    let mut target = test_actor(
        "red-melee-target",
        "Red Melee Target",
        "combat_npc",
        CellSnapshot::new(11, 20),
        "right",
    );
    target.faction_id = Some("red_crew".to_owned());
    target.social_group = Some("red_squad".to_owned());
    target.pvp_status = Some("overt".to_owned());
    snapshot.actors.push(target);

    let mut state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    let mut events = Vec::new();
    for _ in 0..60 {
        events.extend(state.advance_ticks_for_observer(&config, 1));
        if events.iter().any(|event| {
            event.shooter_actor_id == "skirmish-blue-brawler"
                && event.weapon_id == AuthorityWeaponId::Vibrosword
        }) {
            break;
        }
    }

    let melee_event = events
        .iter()
        .find(|event| {
            event.shooter_actor_id == "skirmish-blue-brawler"
                && event.target_actor_id == "red-melee-target"
                && event.weapon_id == AuthorityWeaponId::Vibrosword
        })
        .expect("brawler should strike the adjacent hostile with a vibrosword event");
    assert_eq!(melee_event.ammo_type, AuthorityAmmoTypeId::Melee);
    assert_eq!(melee_event.damage, 20);
    assert_eq!(
        state
            .actors
            .get("skirmish-blue-brawler")
            .expect("brawler exists")
            .shots_fired,
        1
    );
}

#[test]
fn authority_skirmisher_brawler_does_not_melee_from_kneel() {
    let config = SliceAuthorityConfig::default();
    let mut snapshot = crate::authority_test_slice();
    snapshot.actors.clear();
    add_test_factions(&mut snapshot);
    snapshot.npc_jobs.clear();
    snapshot.props.clear();
    snapshot.blocked_cells.clear();

    let mut brawler = test_actor(
        "skirmish-blue-brawler",
        "Blue Brawler",
        "skirmisher_brawler",
        CellSnapshot::new(10, 20),
        "left",
    );
    brawler.profession_ids.push("brawler".to_owned());
    snapshot.actors.push(brawler);

    let mut target = test_actor(
        "red-melee-target",
        "Red Melee Target",
        "combat_npc",
        CellSnapshot::new(11, 20),
        "right",
    );
    target.faction_id = Some("red_crew".to_owned());
    target.social_group = Some("red_squad".to_owned());
    target.pvp_status = Some("overt".to_owned());
    snapshot.actors.push(target);

    let mut state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    {
        let brawler = state.actors.get_mut("skirmish-blue-brawler").unwrap();
        brawler.posture = AuthorityActorPosture::Kneeling;
        brawler.posture_until_tick = 0;
    }
    let mut events = Vec::new();
    for _ in 0..60 {
        events.extend(state.advance_ticks_for_observer(&config, 1));
    }

    assert!(
        events.iter().all(|event| {
            !(event.shooter_actor_id == "skirmish-blue-brawler"
                && event.weapon_id == AuthorityWeaponId::Vibrosword)
        }),
        "kneeling brawler AI must not emit melee events: {events:?}"
    );
    assert_eq!(
        state
            .actors
            .get("skirmish-blue-brawler")
            .expect("brawler exists")
            .shots_fired,
        0
    );
}

#[test]
fn authority_skirmisher_brawler_closes_to_contact_before_vibrosword_strike() {
    let config = SliceAuthorityConfig::default();
    let mut snapshot = crate::authority_test_slice();
    snapshot.actors.clear();
    add_test_factions(&mut snapshot);
    snapshot.npc_jobs.clear();
    snapshot.props.clear();
    snapshot.blocked_cells.clear();

    let mut brawler = test_actor(
        "skirmish-blue-brawler",
        "Blue Brawler",
        "skirmisher_brawler",
        CellSnapshot::new(10, 20),
        "right",
    );
    brawler.profession_ids.push("brawler".to_owned());
    snapshot.actors.push(brawler);

    let mut target = test_actor(
        "red-melee-target",
        "Red Melee Target",
        "combat_npc",
        CellSnapshot::new(16, 20),
        "left",
    );
    target.faction_id = Some("red_crew".to_owned());
    target.social_group = Some("red_squad".to_owned());
    target.pvp_status = Some("overt".to_owned());
    snapshot.actors.push(target);

    let mut state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    state
        .actors
        .get_mut("red-melee-target")
        .unwrap()
        .equipped_weapon_id = Some(AuthorityWeaponId::Unarmed);
    let start_gap = position_distance_milli(
        state.actors.get("skirmish-blue-brawler").unwrap().position,
        state.actors.get("red-melee-target").unwrap().position,
    );
    let mut events = Vec::new();
    for _ in 0..180 {
        events.extend(state.advance_ticks_for_observer(&config, 1));
        if events.iter().any(|event| {
            event.shooter_actor_id == "skirmish-blue-brawler"
                && event.target_actor_id == "red-melee-target"
                && event.weapon_id == AuthorityWeaponId::Vibrosword
        }) {
            break;
        }
    }

    let brawler = state.actors.get("skirmish-blue-brawler").unwrap();
    let target = state.actors.get("red-melee-target").unwrap();
    let final_gap = position_distance_milli(brawler.position, target.position);
    assert!(
        final_gap < start_gap,
        "brawler should close distance before striking, start={start_gap}, final={final_gap}"
    );
    assert!(
        events.iter().any(|event| {
            event.shooter_actor_id == "skirmish-blue-brawler"
                && event.target_actor_id == "red-melee-target"
                && event.weapon_id == AuthorityWeaponId::Vibrosword
        }),
        "brawler should keep target focus and produce a melee strike after closing"
    );
}

#[test]
fn authority_close_brawler_pressure_beats_distant_rifle_target_priority() {
    let mut snapshot = crate::authority_test_slice();
    add_test_factions(&mut snapshot);
    snapshot.actors.clear();
    snapshot.npc_jobs.clear();
    snapshot.props.clear();
    snapshot.blocked_cells.clear();

    snapshot.actors.push(test_actor(
        "red-rifle",
        "Red Rifle",
        "skirmisher",
        CellSnapshot::new(10, 20),
        "right",
    ));
    snapshot.actors.push(test_actor(
        "blue-distant-rifle",
        "Blue Distant Rifle",
        "skirmisher",
        CellSnapshot::new(30, 20),
        "left",
    ));
    let mut brawler = test_actor(
        "blue-close-brawler",
        "Blue Close Brawler",
        "skirmisher_brawler",
        CellSnapshot::new(13, 20),
        "left",
    );
    brawler.profession_ids.push("brawler".to_owned());
    snapshot.actors.push(brawler);

    let state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    let rifle = state.actors.get("red-rifle").unwrap();
    let profile = skirmisher_profile_for_ai_state(rifle);
    let target = state
        .nearest_skirmisher_target(rifle, profile)
        .expect("rifle should acquire a hostile target");

    assert_eq!(
        target.id, "blue-close-brawler",
        "close melee pressure must preempt a more comfortable distant rifle lane"
    );
}

#[test]
fn authority_downed_skirmisher_brawler_does_not_keep_facing_targets() {
    let mut snapshot = crate::authority_test_slice();
    snapshot.actors.clear();
    add_test_factions(&mut snapshot);
    snapshot.npc_jobs.clear();
    snapshot.props.clear();
    snapshot.blocked_cells.clear();

    let mut brawler = test_actor(
        "skirmish-blue-brawler",
        "Blue Brawler",
        "skirmisher_brawler",
        CellSnapshot::new(10, 20),
        "front",
    );
    brawler.profession_ids.push("brawler".to_owned());
    snapshot.actors.push(brawler);

    let mut target = test_actor(
        "red-melee-target",
        "Red Melee Target",
        "combat_npc",
        CellSnapshot::new(11, 20),
        "right",
    );
    target.faction_id = Some("red_crew".to_owned());
    target.social_group = Some("red_squad".to_owned());
    target.pvp_status = Some("overt".to_owned());
    snapshot.actors.push(target);

    let mut state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    let tick = state.tick();
    {
        let brawler = state.actors.get_mut("skirmish-blue-brawler").unwrap();
        SliceAuthorityState::kill_actor_for_respawn(tick, 30, brawler);
    }

    state.face_combat_actors_toward_engagement_targets();

    let corpse = state.actors.get("skirmish-blue-brawler").unwrap();
    assert_eq!(corpse.life_state, AuthorityLifeState::Downed);
    assert_eq!(
        corpse.direction, "front",
        "downed brawler corpses must not keep looking around at live targets"
    );
}

#[test]
fn authority_skirmisher_roll_attack_respects_npc_cadence() {
    let config = SliceAuthorityConfig::default();
    let mut snapshot = crate::authority_test_slice();
    snapshot.actors.clear();
    add_test_factions(&mut snapshot);
    snapshot.npc_jobs.clear();
    snapshot.props.clear();
    snapshot.blocked_cells.clear();
    snapshot.actors.push(test_actor(
        "skirmish-red-trooper",
        "Red Trooper",
        "skirmisher",
        CellSnapshot::new(10, 20),
        "right",
    ));
    snapshot.actors.push(test_actor(
        "skirmish-blue-trooper",
        "Blue Trooper",
        "skirmisher",
        CellSnapshot::new(34, 20),
        "left",
    ));

    let mut state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    for actor_id in ["skirmish-red-trooper", "skirmish-blue-trooper"] {
        let actor = state.actors.get_mut(actor_id).unwrap();
        actor.vitals.health = 100_000;
        actor.max_vitals.health = 100_000;
    }
    let start_distance_milli = position_distance_milli(
        state.actors.get("skirmish-red-trooper").unwrap().position,
        state.actors.get("skirmish-blue-trooper").unwrap().position,
    );
    state.advance_ticks_for_observer(&config, 18);

    let red = state.actors.get("skirmish-red-trooper").unwrap();
    let blue = state.actors.get("skirmish-blue-trooper").unwrap();
    let burst_rounds = u64::from(super::combat_roll::roll_burst_rounds_for_test());
    assert_eq!(red.shots_fired, burst_rounds);
    assert_eq!(blue.shots_fired, burst_rounds);
    assert!(
        (23_500..=24_500).contains(&start_distance_milli),
        "test should begin at the current 24-cell Slugthrower ideal range"
    );

    let next_shot_tick = match red.ai.as_ref().unwrap() {
        AuthorityAiState::Skirmisher(ai) => ai.next_shot_tick,
        _ => panic!("red actor should use skirmisher AI"),
    };
    let ticks_until_due = next_shot_tick.saturating_sub(state.tick());
    assert!(ticks_until_due > 1);
    state.advance_ticks_for_observer(
        &config,
        u16::try_from(ticks_until_due - 1).expect("test cadence fits in u16"),
    );
    assert_eq!(
        state
            .actors
            .get("skirmish-red-trooper")
            .unwrap()
            .shots_fired,
        burst_rounds,
        "the NPC Roll attack must not repeat before its cadence expires"
    );
    state.advance_ticks_for_observer(&config, 1);
    let red = state.actors.get("skirmish-red-trooper").unwrap();
    let blue = state.actors.get("skirmish-blue-trooper").unwrap();
    assert!(
        red.shots_fired >= burst_rounds.saturating_mul(2)
            || blue.shots_fired >= burst_rounds.saturating_mul(2),
        "Roll combatants should fire again after the NPC cadence elapses; red={}, blue={}",
        red.shots_fired,
        blue.shots_fired
    );
}

#[test]
fn authority_skirmisher_roll_fire_gate_uses_slugthrower_range() {
    let mut snapshot = crate::authority_test_slice();
    snapshot.actors.clear();
    add_test_factions(&mut snapshot);
    snapshot.npc_jobs.clear();
    snapshot.props.clear();
    snapshot.blocked_cells.clear();
    snapshot.zone.width = 100;
    for area in &mut snapshot.areas {
        if area.id == crate::AUTHORITY_TEST_AREA_ID {
            area.width = 100;
        }
    }
    snapshot.actors.push(test_actor(
        "skirmish-red-trooper",
        "Red Trooper",
        "skirmisher",
        CellSnapshot::new(10, 20),
        "right",
    ));
    snapshot.actors.push(test_actor(
        "blue-max-range-target",
        "Blue Max Range Target",
        "skirmisher",
        CellSnapshot::new(66, 20),
        "left",
    ));
    snapshot.actors.push(test_actor(
        "blue-too-far-target",
        "Blue Too Far Target",
        "skirmisher",
        CellSnapshot::new(67, 20),
        "left",
    ));

    let state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    let red = state.actors.get("skirmish-red-trooper").unwrap().clone();
    let max_range_target = state.actors.get("blue-max-range-target").unwrap().clone();
    let too_far_target = state.actors.get("blue-too-far-target").unwrap().clone();
    let profile = skirmisher_profile_for_actor(&red, 1);
    let (ideal_range_milli, max_range_milli) = state
        .roll_range_bands_milli_for_actor(&red)
        .expect("test skirmisher should carry a Roll-ranged weapon");

    assert_eq!(ideal_range_milli, 24_000);
    assert_eq!(max_range_milli, 56_000);
    let mut max_range_probe = state.clone();
    let mut max_range_ai = match red.ai.clone().unwrap() {
        AuthorityAiState::Skirmisher(ai) => ai,
        _ => panic!("red actor should use skirmisher AI"),
    };
    max_range_ai.next_shot_tick = 0;
    assert!(
        max_range_probe.fire_skirmisher_if_ready(
            "skirmish-red-trooper",
            &red,
            &max_range_target,
            &mut max_range_ai,
            profile,
        ),
        "the current 56-cell Slugthrower maximum should remain fireable"
    );

    let mut too_far_probe = state.clone();
    let mut too_far_ai = match red.ai.clone().unwrap() {
        AuthorityAiState::Skirmisher(ai) => ai,
        _ => panic!("red actor should use skirmisher AI"),
    };
    too_far_ai.next_shot_tick = 0;
    assert!(
        !too_far_probe.fire_skirmisher_if_ready(
            "skirmish-red-trooper",
            &red,
            &too_far_target,
            &mut too_far_ai,
            profile,
        ),
        "a target one cell beyond the current Roll range must remain unfireable"
    );
}

#[test]
fn authority_routed_skirmisher_aggros_before_readable_fire_range() {
    let config = SliceAuthorityConfig::default();
    let mut snapshot = crate::authority_test_slice();
    snapshot.actors.clear();
    add_test_factions(&mut snapshot);
    snapshot.npc_jobs.clear();
    snapshot.props.clear();
    snapshot.blocked_cells.clear();
    if let Some(area) = snapshot
        .areas
        .iter_mut()
        .find(|area| area.id == crate::AUTHORITY_TEST_AREA_ID)
    {
        area.width = 160;
        area.height = 160;
    }
    let mut red = test_actor(
        "skirmish-red-patrol",
        "Red Patrol",
        "skirmisher",
        CellSnapshot::new(120, 120),
        "right",
    );
    red.route = vec![
        CellSnapshot::new(120, 120),
        CellSnapshot::new(120, 130),
        CellSnapshot::new(120, 120),
    ];
    snapshot.actors.push(red);
    snapshot.actors.push(test_actor(
        "skirmish-blue-distant",
        "Blue Distant",
        "skirmisher",
        CellSnapshot::new(48, 48),
        "left",
    ));

    let mut state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    let before = state.actors.get("skirmish-red-patrol").unwrap().position;
    state.advance_ticks_for_observer(&config, 90);

    let red = state.actors.get("skirmish-red-patrol").unwrap();
    let blue = state.actors.get("skirmish-blue-distant").unwrap();
    let profile = skirmisher_profile_for_actor(red, 1);
    let red_ai = match red.ai.as_ref().unwrap() {
        AuthorityAiState::Skirmisher(ai) => ai,
        _ => panic!("red actor should use skirmisher AI"),
    };
    assert_eq!(
        red_ai.target_actor_id.as_deref(),
        Some("skirmish-blue-distant"),
        "routed skirmishers should aggro instead of staying on a patrol rail"
    );
    let red_debug = state
        .ai_debug_snapshot()
        .actors
        .iter()
        .find(|actor| actor.actor_id == "skirmish-red-patrol")
        .map(|actor| actor.reason.clone());
    assert!(
        red.position.x < before.x && red.position.y < before.y,
        "long-contact aggro should advance toward the enemy before firing; before=({}, {}), after=({}, {}), target={:?}, reason={:?}",
        before.x,
        before.y,
        red.position.x,
        red.position.y,
        red_ai.target,
        red_debug
    );
    assert!(
        !state.skirmisher_can_fire_at(red, blue, profile),
        "the aggro band should allow advancing while the readable fire gate remains closed"
    );
}

#[test]
fn authority_skirmisher_returns_fire_from_valid_cover_when_pressured() {
    let config = SliceAuthorityConfig::default();
    let mut snapshot = crate::authority_test_slice();
    snapshot.actors.clear();
    add_test_factions(&mut snapshot);
    snapshot.npc_jobs.clear();
    snapshot.props.clear();
    snapshot.blocked_cells.clear();
    snapshot.actors.push(test_actor(
        "skirmish-red-anchor",
        "Red Anchor",
        "skirmisher_anchor",
        CellSnapshot::new(12, 20),
        "right",
    ));
    snapshot.actors.push(test_actor(
        "skirmish-blue-assault",
        "Blue Assault",
        "skirmisher_assault",
        CellSnapshot::new(18, 20),
        "left",
    ));

    let mut state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    let red_position = state.actors.get("skirmish-red-anchor").unwrap().position;
    {
        let red = state.actors.get_mut("skirmish-red-anchor").unwrap();
        let ai = match red.ai.as_mut().unwrap() {
            AuthorityAiState::Skirmisher(ai) => ai,
            _ => panic!("red actor should use skirmisher AI"),
        };
        ai.mode = SkirmisherMode::HoldCover;
        ai.cover = Some(red_position);
        ai.target = Some(red_position);
        ai.next_decision_tick = 1_000;
        ai.next_shot_tick = 0;
        ai.next_update_tick = 0;
        ai.last_update_tick = 0;
    }
    state.apply_suppression_to_actor(
        "skirmish-red-anchor",
        RANGED_SUPPRESSION_THRESHOLD_MILLI,
        AuthorityPosition::from_cell(AuthorityCell::new(8, 20)),
    );

    state.advance_ticks_for_observer(&config, 8);

    let red = state.actors.get("skirmish-red-anchor").unwrap();
    assert!(
        red.shots_fired > 0,
        "cover-needed state should not pacify an actor that has a valid return-fire lane"
    );
}

#[test]
fn authority_skirmisher_hard_suppression_still_allows_return_fire() {
    let config = SliceAuthorityConfig::default();
    let mut snapshot = crate::authority_test_slice();
    snapshot.actors.clear();
    add_test_factions(&mut snapshot);
    snapshot.npc_jobs.clear();
    snapshot.props.clear();
    snapshot.blocked_cells.clear();
    snapshot.actors.push(test_actor(
        "skirmish-red-suppressed",
        "Red Suppressed",
        "skirmisher_anchor",
        CellSnapshot::new(12, 20),
        "right",
    ));
    snapshot.actors.push(test_actor(
        "skirmish-blue-threat",
        "Blue Threat",
        "skirmisher_assault",
        CellSnapshot::new(20, 20),
        "left",
    ));

    let mut state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    {
        let red = state.actors.get_mut("skirmish-red-suppressed").unwrap();
        red.suppression.pressure_milli = 100_000;
        red.suppression.source = Some(AuthorityPosition::from_cell(AuthorityCell::new(20, 20)));
        let Some(AuthorityAiState::Skirmisher(ai)) = red.ai.as_mut() else {
            panic!("red actor should use skirmisher AI");
        };
        ai.next_shot_tick = 0;
        ai.next_update_tick = 0;
        ai.last_update_tick = 0;
    }

    state.advance_ticks_for_observer(&config, 8);

    let red = state.actors.get("skirmish-red-suppressed").unwrap();
    assert!(
        red.shots_fired > 0,
        "hard suppression should drive cover/evasion without disabling ready return fire"
    );
}

#[test]
fn authority_faction_skirmishers_acquire_ungrouped_player_targets() {
    let config = SliceAuthorityConfig::default();
    let mut snapshot = crate::authority_test_slice();
    snapshot.actors.clear();
    add_test_factions(&mut snapshot);
    snapshot.npc_jobs.clear();
    snapshot.props.clear();
    snapshot.blocked_cells.clear();
    snapshot.actors.push(test_actor(
        "player",
        "Field Observer",
        "player",
        CellSnapshot::new(14, 20),
        "right",
    ));
    snapshot.actors.push(test_actor(
        "skirmish-red-flanker",
        "Red Flanker",
        "skirmisher_flanker",
        CellSnapshot::new(10, 20),
        "right",
    ));
    snapshot.actors.push(test_actor(
        "skirmish-red-deadeye",
        "Red Deadeye",
        "skirmisher_deadeye",
        CellSnapshot::new(10, 24),
        "right",
    ));

    let mut state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    state.advance_ticks_for_observer(&config, 12);

    for actor_id in ["skirmish-red-flanker", "skirmish-red-deadeye"] {
        let actor = state.actors.get(actor_id).unwrap();
        let ai = match actor.ai.as_ref().unwrap() {
            AuthorityAiState::Skirmisher(ai) => ai,
            _ => panic!("{actor_id} should use skirmisher AI"),
        };
        assert_eq!(ai.target_actor_id.as_deref(), Some("player"));
        assert!(
            actor.shots_fired > 0,
            "{actor_id} should retaliate against an eligible ungrouped player"
        );
    }
}

#[test]
fn authority_skirmisher_uses_fast_respawn_loop() {
    let config = SliceAuthorityConfig::default();
    let mut snapshot = crate::authority_test_slice();
    snapshot.actors.clear();
    snapshot.npc_jobs.clear();
    snapshot.props.clear();
    snapshot.blocked_cells.clear();
    snapshot.actors.push(test_actor(
        "skirmish-red-assault",
        "Red Assault",
        "skirmisher_assault",
        CellSnapshot::new(10, 20),
        "right",
    ));

    let mut state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    assert!(!state.actor_tracks_ammo_item("skirmish-red-assault", AMMO_SLUG_IRON_ITEM_ID));
    assert_eq!(
        state.actor_inventory_item_available("skirmish-red-assault", AMMO_SLUG_IRON_ITEM_ID),
        None
    );
    let start_tick = state.tick();
    {
        let actor = state.actors.get_mut("skirmish-red-assault").unwrap();
        SliceAuthorityState::kill_actor_for_respawn(start_tick, 30, actor);
        assert_eq!(
            actor.body_vanish_tick,
            start_tick + CORPSE_BODY_NO_LOOT_TICKS
        );
        assert_eq!(actor.respawn_tick, 0);
    }

    advance_ticks_unclamped(&mut state, &config, CORPSE_BODY_NO_LOOT_TICKS);
    let hidden = state.actors.get("skirmish-red-assault").unwrap();
    assert_eq!(hidden.life_state, AuthorityLifeState::Respawning);
    assert_eq!(
        hidden.respawn_tick,
        start_tick + CORPSE_BODY_NO_LOOT_TICKS + CORPSE_BODY_NO_LOOT_TICKS
    );
    assert_eq!(
        state.actor_inventory_item_available("skirmish-red-assault", AMMO_SLUG_IRON_ITEM_ID),
        None
    );
    advance_ticks_unclamped(&mut state, &config, CORPSE_BODY_NO_LOOT_TICKS);
    let respawned = state.actors.get("skirmish-red-assault").unwrap();
    assert_eq!(respawned.life_state, AuthorityLifeState::Alive);
    assert_eq!(
        respawned.position,
        AuthorityPosition::from_cell(respawned.home_cell)
    );
    assert_eq!(
        state.actor_inventory_item_available("skirmish-red-assault", AMMO_SLUG_IRON_ITEM_ID),
        None
    );
}

#[test]
fn authority_skirmisher_duel_respawns_wait_for_opponent_ready() {
    let config = SliceAuthorityConfig::default();
    let mut snapshot = crate::authority_test_slice();
    snapshot.actors.clear();
    add_test_factions(&mut snapshot);
    snapshot.npc_jobs.clear();
    snapshot.props.clear();
    snapshot.blocked_cells.clear();
    snapshot.zone.width = 128;
    snapshot.zone.height = 128;
    for area in &mut snapshot.areas {
        if area.id == crate::AUTHORITY_TEST_AREA_ID {
            area.width = 128;
            area.height = 128;
        }
    }
    snapshot.actors.push(test_actor(
        "skirmish-red-trooper",
        "Red Trooper",
        "skirmisher",
        CellSnapshot::new(60, 80),
        "right",
    ));
    snapshot.actors.push(test_actor(
        "skirmish-blue-trooper",
        "Blue Trooper",
        "skirmisher",
        CellSnapshot::new(90, 80),
        "left",
    ));

    let mut state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    let start_tick = state.tick();
    let red_body_vanish_tick = {
        let actor = state.actors.get_mut("skirmish-red-trooper").unwrap();
        SliceAuthorityState::kill_actor_for_respawn(start_tick, 30, actor);
        assert_eq!(actor.respawn_tick, 0);
        actor.body_vanish_tick
    };

    state.advance_ticks_for_observer(&config, 60);
    let blue_death_tick = state.tick();
    let blue_body_vanish_tick = {
        let actor = state.actors.get_mut("skirmish-blue-trooper").unwrap();
        SliceAuthorityState::kill_actor_for_respawn(blue_death_tick, 30, actor);
        assert_eq!(actor.respawn_tick, 0);
        actor.body_vanish_tick
    };
    assert!(blue_body_vanish_tick > red_body_vanish_tick);

    while state.tick() < red_body_vanish_tick {
        let remaining = (red_body_vanish_tick - state.tick()).min(30) as u16;
        state.advance_ticks_for_observer(&config, remaining);
    }
    let red_respawn_tick = state
        .actors
        .get("skirmish-red-trooper")
        .unwrap()
        .respawn_tick;
    assert!(red_respawn_tick > red_body_vanish_tick);

    while state.tick() < blue_body_vanish_tick {
        let remaining = (blue_body_vanish_tick - state.tick()).min(30) as u16;
        state.advance_ticks_for_observer(&config, remaining);
    }
    let blue_respawn_tick = state
        .actors
        .get("skirmish-blue-trooper")
        .unwrap()
        .respawn_tick;
    assert!(blue_respawn_tick > red_respawn_tick);

    while state.tick() < red_respawn_tick {
        let remaining = (red_respawn_tick - state.tick()).min(30) as u16;
        state.advance_ticks_for_observer(&config, remaining);
    }
    assert_eq!(state.tick(), red_respawn_tick);
    assert_eq!(
        state.actors.get("skirmish-red-trooper").unwrap().life_state,
        AuthorityLifeState::Respawning,
        "first skirmisher ready to respawn must stay hidden while the wiped opponent is not ready"
    );

    while state.tick() < blue_respawn_tick {
        let remaining = (blue_respawn_tick - state.tick()).min(30) as u16;
        state.advance_ticks_for_observer(&config, remaining);
    }
    {
        let red = state.actors.get("skirmish-red-trooper").unwrap();
        let blue = state.actors.get("skirmish-blue-trooper").unwrap();
        assert_eq!(red.life_state, AuthorityLifeState::Alive);
        assert_eq!(blue.life_state, AuthorityLifeState::Alive);
        assert!(
            position_distance_milli(red.position, AuthorityPosition::from_cell(red.home_cell))
                <= 200,
            "red may begin its first post-respawn AI step but must still be at home"
        );
        assert!(
            position_distance_milli(blue.position, AuthorityPosition::from_cell(blue.home_cell))
                <= 200,
            "blue may begin its first post-respawn AI step but must still be at home"
        );
    }

    for _ in 0..120 {
        state.advance_ticks_for_observer(&config, 1);
    }
    let red_after = state.actors.get("skirmish-red-trooper").unwrap();
    let blue_after = state.actors.get("skirmish-blue-trooper").unwrap();
    let debug = state.ai_debug_snapshot();
    assert!(
        red_after.shots_fired > 0 || blue_after.shots_fired > 0,
        "synchronized respawn should re-enter an active engagement instead of freezing at home; red={red_after:?} blue={blue_after:?} debug={debug:?}"
    );
}

#[test]
fn authority_skirmisher_respawn_lifecycle_repairs_stale_downed_deadline() {
    let config = SliceAuthorityConfig::default();
    let mut snapshot = crate::authority_test_slice();
    snapshot.actors.clear();
    snapshot.npc_jobs.clear();
    snapshot.props.clear();
    snapshot.blocked_cells.clear();
    snapshot.actors.push(test_actor(
        "skirmish-red-assault",
        "Red Assault",
        "skirmisher_assault",
        CellSnapshot::new(10, 20),
        "right",
    ));

    let mut state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    state.tick = 1_000;
    let death_tick = state.tick;
    {
        let actor = state.actors.get_mut("skirmish-red-assault").unwrap();
        SliceAuthorityState::set_actor_life_state(actor, AuthorityLifeState::Downed);
        actor.vitals.health = 0;
        actor.body_vanish_tick = death_tick.saturating_add(90_000);
        actor.respawn_tick = death_tick.saturating_add(120_000);
        actor.stats.record_death(
            death_tick,
            snapshot.tick_rate_hz,
            ActorDeathStats {
                tick: death_tick,
                killer_actor_id: "test-shooter".to_owned(),
                cause: "test stale deadline".to_owned(),
                weapon_id: AuthorityWeaponId::Slugthrower,
                ammo_type: AuthorityAmmoTypeId::SlugIron,
            },
        );
    }

    let expected_body_deadline = death_tick + CORPSE_BODY_NO_LOOT_TICKS;
    while state.tick() < expected_body_deadline {
        let remaining = (expected_body_deadline - state.tick()).min(30) as u16;
        state.advance_ticks_for_observer(&config, remaining);
    }
    let hidden_respawn_tick = {
        let hidden = state.actors.get("skirmish-red-assault").unwrap();
        assert_eq!(hidden.life_state, AuthorityLifeState::Respawning);
        assert_eq!(hidden.body_vanish_tick, 0);
        hidden.respawn_tick
    };
    assert_eq!(
        hidden_respawn_tick,
        death_tick + CORPSE_BODY_NO_LOOT_TICKS + CORPSE_BODY_NO_LOOT_TICKS
    );

    while state.tick() < hidden_respawn_tick {
        let remaining = (hidden_respawn_tick - state.tick()).min(30) as u16;
        state.advance_ticks_for_observer(&config, remaining);
    }
    let respawned = state.actors.get("skirmish-red-assault").unwrap();
    assert_eq!(respawned.life_state, AuthorityLifeState::Alive);
    assert_eq!(
        respawned.position,
        AuthorityPosition::from_cell(respawned.home_cell)
    );
}

#[test]
fn authority_skirmisher_respawn_lifecycle_repairs_stale_hidden_wave_deadline() {
    let config = SliceAuthorityConfig::default();
    let mut snapshot = crate::authority_test_slice();
    snapshot.actors.clear();
    add_test_factions(&mut snapshot);
    snapshot.npc_jobs.clear();
    snapshot.props.clear();
    snapshot.blocked_cells.clear();
    for (index, actor_id) in [
        "skirmish-red-lead",
        "skirmish-red-support-01",
        "skirmish-red-support-02",
        "skirmish-red-support-03",
    ]
    .into_iter()
    .enumerate()
    {
        snapshot.actors.push(test_actor(
            actor_id,
            actor_id,
            "skirmisher",
            CellSnapshot::new(10, 20 + i32::try_from(index).unwrap() * 2),
            "right",
        ));
    }

    let mut state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    state.tick = 1_000;
    let death_tick = state.tick;
    let expected_respawn_tick = death_tick + CORPSE_BODY_NO_LOOT_TICKS + CORPSE_BODY_NO_LOOT_TICKS;
    for actor_id in [
        "skirmish-red-lead",
        "skirmish-red-support-01",
        "skirmish-red-support-02",
        "skirmish-red-support-03",
    ] {
        let actor = state.actors.get_mut(actor_id).unwrap();
        SliceAuthorityState::set_actor_life_state(actor, AuthorityLifeState::Respawning);
        actor.vitals.health = 0;
        actor.body_vanish_tick = 0;
        actor.respawn_tick = death_tick.saturating_add(120_000);
        actor.stats.record_death(
            death_tick,
            snapshot.tick_rate_hz,
            ActorDeathStats {
                tick: death_tick,
                killer_actor_id: "test-shooter".to_owned(),
                cause: "stale hidden wave deadline".to_owned(),
                weapon_id: AuthorityWeaponId::Slugthrower,
                ammo_type: AuthorityAmmoTypeId::SlugIron,
            },
        );
    }

    while state.tick() < expected_respawn_tick {
        let remaining = (expected_respawn_tick - state.tick()).min(30) as u16;
        state.advance_ticks_for_observer(&config, remaining);
    }

    for actor_id in [
        "skirmish-red-lead",
        "skirmish-red-support-01",
        "skirmish-red-support-02",
        "skirmish-red-support-03",
    ] {
        let actor = state.actors.get(actor_id).unwrap();
        assert_eq!(actor.life_state, AuthorityLifeState::Alive, "{actor_id}");
        assert_eq!(actor.respawn_tick, 0, "{actor_id}");
        assert_eq!(
            actor.position,
            AuthorityPosition::from_cell(actor.home_cell)
        );
    }
}

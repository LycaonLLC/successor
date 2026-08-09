fn restore_checkpoint_for_test(
    current: &SliceAuthorityState,
    blob: AuthorityCheckpointBlob,
) -> SliceAuthorityState {
    let mut restored = current.clone();
    restored
        .restore_checkpoint(blob)
        .expect("current authority checkpoint restores");
    restored
}

fn command(command_id: u64, command: ClientCommand) -> ClientCommandEnvelope {
    ClientCommandEnvelope {
        session: SessionId(1),
        player: PlayerId(1),
        command_id,
        issued_at_tick: 24 + command_id,
        command,
    }
}
fn command_for(
    config: &SliceAuthorityConfig,
    command_id: u64,
    command: ClientCommand,
) -> ClientCommandEnvelope {
    ClientCommandEnvelope {
        session: config.session,
        player: config.player,
        command_id,
        issued_at_tick: 24 + command_id,
        command,
    }
}

fn creator_clothing_upsert(
    worn: Vec<AuthorityActorWornPiece>,
    worn_colors: BTreeMap<String, Vec<String>>,
) -> AuthorityActorUpsert {
    AuthorityActorUpsert {
        id: "player".to_owned(),
        entity: "player".to_owned(),
        label: Some("Creator Player".to_owned()),
        sprite: None,
        display_name: Some("Creator Player".to_owned()),
        link_dead: false,
        bare_start: true,
        returning: false,
        appearance: None,
        worn,
        worn_colors,
        template_id: None,
        spawn_zone_id: None,
        role: "player".to_owned(),
        profession_ids: Vec::new(),
        skill_box_ids: Vec::new(),
        profession_xp: BTreeMap::new(),
        profession_track_xp: BTreeMap::new(),
        skill_point_cap: None,
        active_title_id: None,
        credits: None,
        capabilities: Vec::new(),
        career_goal_id: None,
        faction_id: None,
        social_group: None,
        pvp_status: None,
        player_organization_id: None,
        player_organization_tag: None,
        area_id: crate::AUTHORITY_TEST_AREA_ID.to_owned(),
        x: 12.0,
        y: 12.0,
        direction: "right".to_owned(),
        scale: 1,
        vitals: AuthorityVitals::default(),
        max_vitals: AuthorityVitals::default(),
    }
}

fn initial_profession_upsert(profession_id: &str) -> AuthorityActorUpsert {
    let mut input = creator_clothing_upsert(Vec::new(), BTreeMap::new());
    input.skill_box_ids = vec![format!("{profession_id}-novice")];
    input
}

fn move_intent_command(
    config: &SliceAuthorityConfig,
    command_id: u64,
    issued_at_tick: u64,
    dx: i32,
    dy: i32,
    sprint: bool,
) -> ClientCommandEnvelope {
    ClientCommandEnvelope {
        session: config.session,
        player: config.player,
        command_id,
        issued_at_tick,
        command: ClientCommand::SetMoveIntent {
            dx,
            dy,
            facing: None,
            sprint,
        },
    }
}

fn advance_ticks_unclamped(
    state: &mut SliceAuthorityState,
    config: &SliceAuthorityConfig,
    mut ticks: u64,
) {
    while ticks > 0 {
        let batch = ticks.min(u64::from(MAX_MOVE_DURATION_TICKS)) as u16;
        state.advance_ticks_for_observer(config, batch);
        ticks = ticks.saturating_sub(u64::from(batch));
    }
}

fn expand_resource_test_area(snapshot: &mut SliceSnapshot, area_id: &str) {
    let area = snapshot
        .areas
        .iter_mut()
        .find(|area| area.id == area_id)
        .expect("test area exists");
    area.width = area.width.max(1_025);
    area.height = area.height.max(1_025);
}

fn rich_resource_cell_for_test(
    state: &SliceAuthorityState,
    area_id: &str,
    family: &str,
) -> (ResourceInstanceAuthority, AuthorityCell, u16) {
    let area = state
        .runtime
        .durable
        .world
        .areas
        .get(area_id)
        .expect("test area exists");
    let resource = resource_instance_for_family(area_id, family).expect("test resource exists");
    for y in (0..area.height).step_by(8) {
        for x in (0..area.width).step_by(8) {
            let cell = AuthorityCell::new(
                i32::try_from(x).expect("test area width fits i32"),
                i32::try_from(y).expect("test area height fits i32"),
            );
            let concentration_milli = state.resource_concentration_milli_for_area(
                area_id,
                resource.concentration_seed,
                cell,
            );
            if concentration_milli >= 600 {
                return (resource, cell, concentration_milli);
            }
        }
    }
    panic!("expected rich {family} cell for test area {area_id}");
}

fn move_actor_to_cell_for_test(
    state: &mut SliceAuthorityState,
    actor_id: &str,
    cell: AuthorityCell,
) {
    let actor = state
        .runtime
        .durable
        .actors
        .get_mut(actor_id)
        .expect("test actor exists");
    actor.cell = cell;
    actor.position = AuthorityPosition::from_cell(cell);
}

fn seed_test_extractor_tool(state: &mut SliceAuthorityState, actor_id: &str, variant_id: u32) {
    state.add_actor_inventory_stack(
        actor_id,
        METAL_EXTRACTOR_TOOL_ITEM_ID,
        variant_id,
        "Personal Mineral Sampler",
        1,
        METAL_EXTRACTOR_STACK_CAP,
        "profession-tools",
    );
}

fn seed_test_extractor_battery(
    state: &mut SliceAuthorityState,
    actor_id: &str,
    runtime_seconds: u32,
) -> (String, String, u32) {
    let container = format!("{actor_id}:field-pack");
    let variant_id = encode_battery_variant(runtime_seconds);
    let stack_id =
        push_test_inventory_stack(state, &container, EXTRACTOR_BATTERY_ITEM_ID, variant_id, 1);
    (container, stack_id.to_string(), variant_id)
}

fn placed_extractor_test_state() -> (SliceAuthorityConfig, SliceAuthorityState) {
    let config = SliceAuthorityConfig::default();
    let mut snapshot = crate::authority_test_slice();
    expand_resource_test_area(&mut snapshot, "authority-test-overworld");
    let mut state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    grant_test_profession(&mut state, "player", AuthorityProfessionKind::Craftsman);
    let (_, rich_cell, _) =
        rich_resource_cell_for_test(&state, "authority-test-overworld", "mineral");
    move_actor_to_cell_for_test(&mut state, "player", rich_cell);
    seed_test_extractor_tool(&mut state, "player", 1_000);
    (config, state)
}

fn resource_sample_loop_test_state() -> (SliceAuthorityConfig, SliceAuthorityState) {
    let config = SliceAuthorityConfig::default();
    let mut snapshot = crate::authority_test_slice();
    expand_resource_test_area(&mut snapshot, "authority-test-overworld");
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
    let (_, rich_cell, _) =
        rich_resource_cell_for_test(&state, "authority-test-overworld", "mineral");
    move_actor_to_cell_for_test(&mut state, &player, rich_cell);
    (config, state)
}

fn owned_actor_item_quantity(state: &SliceAuthorityState, actor_id: &str, item_id: u32) -> u32 {
    state
        .inventory_snapshots()
        .iter()
        .filter(|row| {
            row.item_id == item_id && actor_owns_inventory_container(actor_id, &row.container)
        })
        .map(|row| row.quantity)
        .sum()
}

fn seed_resource_sample_loop_for_test(
    state: &mut SliceAuthorityState,
    actor_id: &str,
    family: &str,
    next_sample_tick: u64,
) {
    let actor = state
        .runtime
        .durable
        .actors
        .get_mut(actor_id)
        .expect("test actor exists");
    actor.resource_sample_loop = Some(ResourceSampleLoopState {
        family: family.to_owned(),
        area_id: actor.area_id.clone(),
        cell: actor.cell,
        next_sample_tick,
    });
}

fn weather_test_hazard(shelters: Vec<AuthorityWeatherShelterBox>) -> AuthorityWeatherHazard {
    AuthorityWeatherHazard {
        area_id: crate::AUTHORITY_TEST_AREA_ID.to_owned(),
        center_x_milli: 10_000,
        center_y_milli: 10_000,
        radius_milli: 2_000,
        dps_milli_health: 30_000,
        shelters,
    }
}

fn weather_test_state(role: &str) -> (SliceAuthorityConfig, SliceAuthorityState) {
    let mut snapshot = crate::authority_test_slice();
    snapshot.actors.clear();
    snapshot.npc_jobs.clear();
    snapshot.actors.push(test_actor(
        "player",
        "Weather Target",
        role,
        CellSnapshot::new(10, 10),
        "front",
    ));
    let config = SliceAuthorityConfig::default();
    let mut state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    let actor = state.actors.get_mut("player").unwrap();
    actor.vitals.health = 100;
    actor.max_vitals.health = 100;
    actor.effective_stats.regen_rates_milli_per_second.health = 0;
    actor.passive_regen_milli.health = 0;
    (config, state)
}

fn player_health(state: &SliceAuthorityState) -> i32 {
    state
        .runtime
        .durable
        .actors
        .get("player")
        .unwrap()
        .vitals
        .health
}

fn assert_actor_position(actor: &AuthorityActorSnapshot, x: f64, y: f64) {
    assert!(
        (actor.x - x).abs() < 0.001 && (actor.y - y).abs() < 0.001,
        "expected actor {} at ({x}, {y}), got ({}, {})",
        actor.id,
        actor.x,
        actor.y
    );
}

fn test_factions() -> Vec<crate::FactionSnapshot> {
    vec![
        crate::FactionSnapshot {
            id: "red_crew".to_owned(),
            label: "Red Crew".to_owned(),
            player_allowed: true,
            enemies: vec!["blue_crew".to_owned()],
            allies: Vec::new(),
            adjust_factor_milli: 1_000,
        },
        crate::FactionSnapshot {
            id: "blue_crew".to_owned(),
            label: "Blue Crew".to_owned(),
            player_allowed: true,
            enemies: vec!["red_crew".to_owned()],
            allies: Vec::new(),
            adjust_factor_milli: 1_000,
        },
    ]
}

fn add_test_factions(snapshot: &mut crate::SliceSnapshot) {
    snapshot.factions = test_factions();
}

fn test_actor_faction(
    id: &str,
    role: &str,
    direction: &str,
) -> (Option<String>, Option<String>, Option<String>) {
    if !is_skirmisher_role(role) {
        return (None, None, None);
    }
    if id.contains("blue") || direction.eq_ignore_ascii_case("left") {
        return (
            Some("blue_crew".to_owned()),
            Some("blue_squad".to_owned()),
            Some("overt".to_owned()),
        );
    }
    (
        Some("red_crew".to_owned()),
        Some("red_squad".to_owned()),
        Some("overt".to_owned()),
    )
}

fn test_actor(
    id: &str,
    label: &str,
    role: &str,
    cell: CellSnapshot,
    direction: &str,
) -> crate::ActorSnapshot {
    let (faction_id, social_group, pvp_status) = if role == "creature" {
        (Some("gaia".to_owned()), Some("gaia".to_owned()), None)
    } else {
        test_actor_faction(id, role, direction)
    };
    crate::ActorSnapshot {
        id: id.to_owned(),
        entity: format!("test:{id}"),
        area_id: crate::AUTHORITY_TEST_AREA_ID.to_owned(),
        label: label.to_owned(),
        role: role.to_owned(),
        template_id: None,
        profession_ids: Vec::new(),
        skill_box_ids: Vec::new(),
        credits: None,
        capabilities: Vec::new(),
        career_goal_id: None,
        faction_id,
        social_group,
        pvp_status,
        player_organization_id: None,
        player_organization_tag: None,
        sprite: match role {
            "creature" => "creature-bellback-adult".to_owned(),
            _ => "adventurer-premium-male".to_owned(),
        },
        pose_set: "idle".to_owned(),
        direction: direction.to_owned(),
        cell,
        route: Vec::new(),
        scale: None,
        vitals: None,
        max_vitals: None,
        initial_respawn_delay_ms: None,
    }
}

fn place_actor_at_position(
    state: &mut SliceAuthorityState,
    actor_id: &str,
    position: AuthorityPosition,
) {
    let actor = state
        .runtime
        .durable
        .actors
        .get_mut(actor_id)
        .unwrap_or_else(|| panic!("missing actor {actor_id}"));
    actor.position = position;
    actor.cell = position.cell();
    actor.home_cell = position.cell();
}

fn grant_test_profession(
    state: &mut SliceAuthorityState,
    actor_id: &str,
    profession: AuthorityProfessionKind,
) {
    let actor = state
        .runtime
        .durable
        .actors
        .get_mut(actor_id)
        .expect("test actor exists");
    let novice_skill_box_id = format!("{}-novice", profession.id());
    actor.professions.learned.insert(profession);
    actor
        .professions
        .skill_boxes
        .insert(novice_skill_box_id.clone());
    actor.capabilities.grant_profession_capabilities(profession);
    if actor.professions.active_title_id.is_none() {
        actor.professions.active_title_id = Some(novice_skill_box_id);
    }
}

fn clear_test_professions(state: &mut SliceAuthorityState, actor_id: &str) {
    let actor = state
        .runtime
        .durable
        .actors
        .get_mut(actor_id)
        .expect("test actor exists");
    actor.professions.learned.clear();
    actor.professions.track_xp.clear();
    actor.professions.skill_boxes.clear();
    actor.professions.active_title_id = None;
}

fn link_dead_test_state() -> (SliceAuthorityConfig, SliceAuthorityState) {
    let mut snapshot = crate::authority_test_slice();
    snapshot.actors.clear();
    snapshot.npc_jobs.clear();
    snapshot.actors.push(test_actor(
        "player",
        "Link Dead Player",
        "player",
        CellSnapshot::new(10, 10),
        "right",
    ));
    let config = SliceAuthorityConfig::default();
    let mut state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    grant_test_profession(&mut state, "player", AuthorityProfessionKind::Scout);
    (config, state)
}

#[test]
fn link_dead_update_sets_flag_and_state_hash() {
    let (_config, mut state) = link_dead_test_state();
    let before_hash = state.stable_state_hash_hex();
    let deadline_tick = state.tick().saturating_add(3);

    let snapshot = state
        .set_actor_link_dead("player", true, Some(deadline_tick))
        .expect("player can be marked link-dead");

    assert!(snapshot.link_dead);
    assert_eq!(
        state.actors.get("player").unwrap().link_dead_expires_tick,
        deadline_tick
    );
    assert_ne!(state.stable_state_hash_hex(), before_hash);
}

#[test]
fn link_dead_deadline_emits_logout_snapshot_and_despawns() {
    let (config, mut state) = link_dead_test_state();
    let deadline_tick = state.tick().saturating_add(2);
    state
        .set_actor_link_dead("player", true, Some(deadline_tick))
        .expect("player can be marked link-dead");
    {
        let actor = state.actors.get_mut("player").unwrap();
        actor.position = AuthorityPosition {
            x: 12_250,
            y: 13_750,
        };
        actor.cell = actor.position.cell();
        actor.vitals = AuthorityVitals {
            health: 77,
            action: 66,
            spirit: 55,
        };
    }

    advance_ticks_unclamped(&mut state, &config, 1);
    assert!(state.actors.contains_key("player"));
    advance_ticks_unclamped(&mut state, &config, 1);

    assert!(!state.actors.contains_key("player"));
    assert_eq!(state.current_removed_actor_ids, vec!["player".to_owned()]);
    let logout = state
        .current_linkdead_logout_actors
        .first()
        .expect("link-dead timeout emits final actor snapshot");
    assert_eq!(logout.id, "player");
    assert_eq!(logout.vitals.health, 77);
    assert_eq!(logout.vitals.action, 66);
    assert_eq!(logout.vitals.spirit, 55);
    assert!((logout.x - 12.25).abs() < 0.001);
    assert!((logout.y - 13.75).abs() < 0.001);
    assert!(logout
        .professions
        .iter()
        .any(|profession| profession.id == "scout"));
}

#[test]
fn link_dead_reattach_clears_deadline_and_preserves_actor() {
    let (config, mut state) = link_dead_test_state();
    let deadline_tick = state.tick().saturating_add(2);
    state
        .set_actor_link_dead("player", true, Some(deadline_tick))
        .expect("player can be marked link-dead");
    let snapshot = state
        .set_actor_link_dead("player", false, None)
        .expect("player can reattach before timeout");

    assert!(!snapshot.link_dead);
    assert_eq!(
        state.actors.get("player").unwrap().link_dead_expires_tick,
        0
    );
    advance_ticks_unclamped(&mut state, &config, 3);
    assert!(state.actors.contains_key("player"));
    assert!(state.current_linkdead_logout_actors.is_empty());
}

#[test]
fn starter_loadout_slugthrower_reattach_materializes_one_reserve_ammo_stack() {
    let (_config, mut state) = link_dead_test_state();
    {
        let actor = state.actors.get_mut("player").unwrap();
        actor.equipped_weapon_id = Some(AuthorityWeaponId::Slugthrower);
        actor.equipped_weapon_item_id = CRAFTED_SLUGTHROWER_ITEM_ID;
        actor.equipped_weapon_variant_id = 0;
    }
    state.inventory.retain(|row| {
        row.item_id != AMMO_SLUG_IRON_ITEM_ID
            || !actor_owns_inventory_container("player", &row.container)
    });

    state
        .set_actor_link_dead("player", false, None)
        .expect("starter-loadout player can reattach");
    state
        .set_actor_link_dead("player", false, None)
        .expect("repeated ready is idempotent");

    let ammo_rows: Vec<_> = state
        .inventory_snapshots()
        .into_iter()
        .filter(|row| {
            row.item_id == AMMO_SLUG_IRON_ITEM_ID
                && actor_owns_inventory_container("player", &row.container)
        })
        .collect();
    assert_eq!(ammo_rows.len(), 1);
    assert_eq!(ammo_rows[0].quantity, PLAYER_RESPAWN_SLUG_AMMO_QUANTITY);
    assert_eq!(ammo_rows[0].available, PLAYER_RESPAWN_SLUG_AMMO_QUANTITY);
}

fn roll_combat_test_snapshot() -> crate::SliceSnapshot {
    let mut snapshot = crate::authority_test_slice();
    snapshot.combat_model = Some("roll".to_owned());
    snapshot.actors.clear();
    snapshot.npc_jobs.clear();
    snapshot.props.clear();
    snapshot.actors.push(test_actor(
        "player",
        "Roll Shooter",
        "player",
        CellSnapshot::new(10, 10),
        "right",
    ));
    snapshot.actors.push(test_actor(
        "roll-target",
        "Roll Target",
        "agent_player",
        CellSnapshot::new(12, 10),
        "left",
    ));
    snapshot
}

fn roll_combat_test_state_from_snapshot(
    snapshot: crate::SliceSnapshot,
) -> (SliceAuthorityConfig, SliceAuthorityState) {
    let config = SliceAuthorityConfig::default();
    let mut state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    {
        let shooter = state.actors.get_mut("player").unwrap();
        shooter.equipped_weapon_id = Some(AuthorityWeaponId::Slugthrower);
        shooter.slugthrower_magazine.loaded_rounds = SLUGTHROWER_MAGAZINE_SIZE;
        shooter.slugthrower_magazine.reload_until_tick = 0;
        shooter.vitals.action = 100;
        shooter.max_vitals.action = 100;
    }
    {
        let target = state.actors.get_mut("roll-target").unwrap();
        target.vitals.health = 1_000;
        target.max_vitals.health = 1_000;
        target.vitals.action = 100;
        target.vitals.spirit = 100;
        target.effective_stats.dodge_chance_milli = 0;
    }
    (config, state)
}

fn roll_combat_test_state() -> (SliceAuthorityConfig, SliceAuthorityState) {
    roll_combat_test_state_from_snapshot(roll_combat_test_snapshot())
}

fn equip_slugthrower_full_for_test(state: &mut SliceAuthorityState, actor_id: &str) {
    let actor = state
        .runtime
        .durable
        .actors
        .get_mut(actor_id)
        .expect("test actor exists");
    actor.equipped_weapon_id = Some(AuthorityWeaponId::Slugthrower);
    actor.slugthrower_magazine.loaded_rounds = SLUGTHROWER_MAGAZINE_SIZE;
    actor.slugthrower_magazine.reload_until_tick = 0;
    actor.vitals.action = actor.vitals.action.max(100);
    actor.max_vitals.action = actor.max_vitals.action.max(100);
}

fn ability_queue_depth_for_test(actor: &ActorAuthorityState) -> usize {
    actor.combat_queue.entries.len()
        + usize::from(actor.combat_queue.repeat_intent.is_some())
        + usize::from(actor.combat_queue.pending_posture.is_some())
}

#[test]
fn authority_state_export_import_roundtrip_advances_identically() {
    let (config, mut never_exported) = roll_combat_test_state();
    let give_item = never_exported.apply_live_envelope(
        &config,
        command(
            1,
            ClientCommand::DebugGiveItem {
                item_id: PLASMA_SWORD_ITEM_ID,
                variant_id: 0,
                quantity: 1,
                equip: true,
            },
        ),
    );
    assert_eq!(give_item.status, AuthorityCommandStatus::Accepted);
    let export_hash = never_exported.stable_state_hash_hex();
    let blob = never_exported.export_checkpoint();
    assert_eq!(blob.state_hash(), export_hash);
    let mut restored = restore_checkpoint_for_test(&never_exported, blob);
    assert_eq!(restored.stable_state_hash_hex(), export_hash);
    assert_eq!(
        restored.actor_inventory_available_quantity("player", PLASMA_SWORD_ITEM_ID),
        1
    );

    for state in [&mut never_exported, &mut restored] {
        let move_intent = state.apply_live_envelope(
            &config,
            command(
                2,
                ClientCommand::SetMoveIntent {
                    dx: 1,
                    dy: 0,
                    facing: Some(CardinalDirection::Right),
                    sprint: false,
                },
            ),
        );
        assert_eq!(move_intent.status, AuthorityCommandStatus::Accepted);
    }
    assert_eq!(
        never_exported.stable_state_hash_hex(),
        restored.stable_state_hash_hex()
    );

    for step in 0..24 {
        let left_events = never_exported.advance_ticks_for_observer(&config, 1);
        let right_events = restored.advance_ticks_for_observer(&config, 1);
        assert_eq!(
            left_events, right_events,
            "event divergence after tick {step}"
        );
        assert_eq!(
            never_exported.stable_state_hash_hex(),
            restored.stable_state_hash_hex(),
            "stable hash divergence after tick {step}"
        );
    }
}

#[test]
fn authority_pre_itemized_player_weapon_can_unequip_and_reequip_from_inventory() {
    let (config, mut state) = roll_combat_test_state();
    let player_id = config.player_actor_id.clone();
    grant_test_profession(&mut state, &player_id, AuthorityProfessionKind::Marksman);
    state.inventory.retain(|row| {
        !actor_owns_inventory_container(&player_id, &row.container)
            || row.item_id != CRAFTED_SLUGTHROWER_ITEM_ID
    });
    {
        let player = state.actors.get_mut(&player_id).expect("player actor");
        player.equipped_weapon_id = Some(AuthorityWeaponId::Slugthrower);
        player.equipped_weapon_item_id = 0;
        player.equipped_weapon_variant_id = 0;
    }

    let checkpoint = state.export_checkpoint();
    let mut restored = restore_checkpoint_for_test(&state, checkpoint);
    let player = restored.actors.get(&player_id).expect("restored player");
    assert_eq!(player.equipped_weapon_item_id, 0);
    assert_eq!(player.equipped_weapon_variant_id, 0);
    assert!(restored.inventory_snapshots().iter().any(|row| {
        actor_owns_inventory_container(&player_id, &row.container)
            && row.item_id == CRAFTED_SLUGTHROWER_ITEM_ID
            && row.variant_id == 0
            && row.available == 1
    }));

    let unequip = restored.apply_envelope(
        &config,
        command(
            1,
            ClientCommand::SetEquippedWeapon {
                weapon_id: None,
                weapon_item_id: None,
                weapon_variant_id: None,
            },
        ),
    );
    assert_eq!(unequip.status, AuthorityCommandStatus::Accepted);
    assert_eq!(
        restored.actors[&player_id].equipped_weapon_id, None,
        "pre-itemized snapshot row must expose a real unequip path"
    );
    assert_eq!(
        restored.actor_inventory_available_quantity(&player_id, CRAFTED_SLUGTHROWER_ITEM_ID),
        1,
        "unequipping materializes the synthetic pre-itemized row for future re-equip"
    );

    let equip = restored.apply_envelope(
        &config,
        command(
            2,
            ClientCommand::SetEquippedWeapon {
                weapon_id: Some(AuthorityWeaponId::Slugthrower),
                weapon_item_id: Some(CRAFTED_SLUGTHROWER_ITEM_ID),
                weapon_variant_id: Some(0),
            },
        ),
    );
    assert_eq!(equip.status, AuthorityCommandStatus::Accepted);
    assert_eq!(
        restored.actors[&player_id].equipped_weapon_item_id,
        CRAFTED_SLUGTHROWER_ITEM_ID
    );
}

fn grant_roll_target_ranged_block_boxes(state: &mut SliceAuthorityState) {
    let skill_box_ids = BRAWLER_RANGED_BLOCK_SKILL_BOXES
        .iter()
        .map(|skill_box_id| (*skill_box_id).to_owned())
        .collect::<Vec<_>>();
    let target = state
        .runtime
        .durable
        .actors
        .get_mut("roll-target")
        .expect("roll target exists");
    target
        .professions
        .grant_skill_box_ids(&skill_box_ids)
        .expect("ranged block skill boxes parse");
    target
        .capabilities
        .grant_profession_capabilities(AuthorityProfessionKind::Brawler);
}

fn roll_ranged_block_test_state(
    target_position: AuthorityPosition,
    target_weapon: Option<AuthorityWeaponId>,
    grant_block_boxes: bool,
) -> (SliceAuthorityConfig, SliceAuthorityState) {
    let (config, mut state) = roll_combat_test_state();
    state.tick = 100;
    place_actor_at_position(&mut state, "roll-target", target_position);
    {
        let target = state
            .actors
            .get_mut("roll-target")
            .expect("roll target exists");
        target.equipped_weapon_id = target_weapon;
        target.vitals.health = 10_000;
        target.max_vitals.health = 10_000;
        target.effective_stats.dodge_chance_milli = 0;
    }
    if grant_block_boxes {
        grant_roll_target_ranged_block_boxes(&mut state);
    }
    super::combat_roll::queue_combat_action(&mut state, "player", "basic_shot", "roll-target")
        .unwrap();
    state.drain_due_combat_action_queues();
    (config, state)
}

fn deflected_roll_events(state: &SliceAuthorityState) -> Vec<&AuthorityCombatEventSnapshot> {
    state
        .runtime
        .pending_combat_events
        .iter()
        .filter(|event| {
            event.kind.as_deref() == Some("ranged_roll")
                && event.effect.as_ref().map(|effect| effect.kind.as_str()) == Some("deflected")
        })
        .collect()
}

fn assert_no_ranged_block(events: &[AuthorityCombatEventSnapshot]) {
    assert!(
        events.iter().all(|event| {
            event.effect.as_ref().map(|effect| effect.kind.as_str()) != Some("deflected")
                && event.block_roll_milli.is_none()
                && event.block_chance_milli.is_none()
        }),
        "ranged block should not be present in events: {events:?}"
    );
}

fn slugthrower_combat_tuning(
    point_blank_cells: i32,
    ideal_cells: i32,
    max_cells: i32,
) -> crate::CombatTuningSnapshot {
    let mut weapon_range_bands = std::collections::BTreeMap::new();
    weapon_range_bands.insert(
        "slugthrower".to_owned(),
        crate::WeaponRangeBandTuningSnapshot {
            point_blank_cells,
            ideal_cells,
            max_cells,
        },
    );
    crate::CombatTuningSnapshot { weapon_range_bands }
}

#[test]
fn authority_roll_to_hit_curve_matches_core3_goldens() {
    assert_eq!(super::combat_roll::roll_to_hit_milli(30, 30), 75_000);
    assert_eq!(super::combat_roll::roll_to_hit_milli(80, 30), 100_000);
    assert_eq!(super::combat_roll::roll_to_hit_milli(0, 150), 0);
    assert_eq!(super::combat_roll::roll_to_hit_milli(55, 30), 87_500);
}

#[test]
fn authority_roll_range_lerps_weapon_accuracy_bands() {
    let stats = weapon_profile(Some(AuthorityWeaponId::Slugthrower))
        .roll_stats
        .unwrap();
    assert_eq!(super::combat_roll::roll_range_accuracy(stats, 0), 60);
    assert_eq!(super::combat_roll::roll_range_accuracy(stats, 8_000), 60);
    assert_eq!(super::combat_roll::roll_range_accuracy(stats, 16_000), 52);
    assert_eq!(super::combat_roll::roll_range_accuracy(stats, 24_000), 45);
    assert_eq!(super::combat_roll::roll_range_accuracy(stats, 40_000), 30);
    assert_eq!(super::combat_roll::roll_range_accuracy(stats, 56_000), 15);
}

#[test]
fn authority_roll_combat_tuning_absent_uses_registry_range_bands() {
    let (_config, state) = roll_combat_test_state();
    let stats = weapon_profile(Some(AuthorityWeaponId::Slugthrower))
        .roll_stats
        .unwrap();
    let range_bands = state.roll_range_bands_for_weapon(AuthorityWeaponId::Slugthrower, stats);
    assert_eq!(range_bands, stats.range_bands());
    assert_eq!(
        super::combat_roll::roll_range_accuracy_for_bands(stats, range_bands, 40_000),
        30
    );
}

#[test]
fn authority_roll_combat_tuning_overrides_only_range_distances() {
    let mut snapshot = roll_combat_test_snapshot();
    snapshot.combat_tuning = Some(slugthrower_combat_tuning(6, 14, 28));
    let (_config, mut state) = roll_combat_test_state_from_snapshot(snapshot);
    place_actor_at_position(
        &mut state,
        "roll-target",
        AuthorityPosition::from_cell(AuthorityCell::new(30, 10)),
    );

    let stats = weapon_profile(Some(AuthorityWeaponId::Slugthrower))
        .roll_stats
        .unwrap();
    let range_bands = state.roll_range_bands_for_weapon(AuthorityWeaponId::Slugthrower, stats);
    assert_eq!(range_bands.point_blank_cells, 6);
    assert_eq!(range_bands.ideal_cells, 14);
    assert_eq!(range_bands.max_cells, 28);
    let tuned_accuracy =
        super::combat_roll::roll_range_accuracy_for_bands(stats, range_bands, 20_000);
    assert_eq!(tuned_accuracy, 32);
    assert_eq!(
        super::combat_roll::roll_range_accuracy(stats, 20_000),
        49,
        "registry band distances should still be available as defaults"
    );

    super::combat_roll::queue_combat_action(&mut state, "player", "basic_shot", "roll-target")
        .unwrap();
    state.tick = state.tick.saturating_add(
        super::combat_roll::roll_attack_speed_ticks_for_test(
            SLUGTHROWER_ROLL_ATTACK_SPEED_MS,
            "basic_shot",
            state.tick_rate_hz,
        )
        .unwrap(),
    );
    state.drain_due_combat_action_queues();
    let event = state
        .pending_combat_events
        .last()
        .expect("roll attack should emit a combat event");
    assert_eq!(
        event.to_hit_milli,
        Some(super::combat_roll::roll_to_hit_milli(tuned_accuracy, 30))
    );
}

#[test]
fn authority_roll_combat_tuning_validates_weapon_ids_and_band_order() {
    let mut invalid_band_snapshot = roll_combat_test_snapshot();
    invalid_band_snapshot.combat_tuning = Some(slugthrower_combat_tuning(6, 28, 14));
    assert_eq!(
        SliceAuthorityState::from_snapshot(&invalid_band_snapshot).unwrap_err(),
        SliceAuthorityBuildError::InvalidCombatTuningWeaponRangeBands {
            weapon_id: "slugthrower".to_owned(),
            point_blank_cells: 6,
            ideal_cells: 28,
            max_cells: 14,
        }
    );

    let mut weapon_range_bands = std::collections::BTreeMap::new();
    weapon_range_bands.insert(
        "ghost-blaster".to_owned(),
        crate::WeaponRangeBandTuningSnapshot {
            point_blank_cells: 6,
            ideal_cells: 14,
            max_cells: 28,
        },
    );
    let mut unknown_weapon_snapshot = roll_combat_test_snapshot();
    unknown_weapon_snapshot.combat_tuning =
        Some(crate::CombatTuningSnapshot { weapon_range_bands });
    assert_eq!(
        SliceAuthorityState::from_snapshot(&unknown_weapon_snapshot).unwrap_err(),
        SliceAuthorityBuildError::UnknownCombatTuningWeaponId {
            weapon_id: "ghost-blaster".to_owned(),
        }
    );
}

#[test]
fn authority_roll_npc_fire_decision_uses_tuned_weapon_max_range() {
    fn fires_at_40_cells(combat_tuning: Option<crate::CombatTuningSnapshot>) -> bool {
        let mut snapshot = open_desert_roll_combat_test_snapshot();
        snapshot.combat_tuning = combat_tuning;
        snapshot.blocked_cells.clear();
        snapshot.spawn_zones[0].activation = None;
        let mut state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
        place_actor_at_position(
            &mut state,
            "open-desert-rogue-01",
            AuthorityPosition::from_cell(AuthorityCell::new(88, 10)),
        );
        {
            let rogue = state.actors.get_mut("open-desert-rogue-01").unwrap();
            rogue.equipped_weapon_id = Some(AuthorityWeaponId::Slugthrower);
            rogue.slugthrower_magazine.loaded_rounds = SLUGTHROWER_MAGAZINE_SIZE;
            rogue.slugthrower_magazine.reload_until_tick = 0;
            rogue.next_fire_tick = 0;
        }
        let actor = state.actors.get("open-desert-rogue-01").unwrap().clone();
        let target = state.actors.get("player").unwrap().clone();
        let profile = skirmisher_profile_for_actor(&actor, 1);
        let mut ai = match actor.ai.clone().expect("rogue should have AI") {
            AuthorityAiState::Skirmisher(ai) => ai,
            _ => panic!("rogue should use skirmisher AI"),
        };
        ai.next_shot_tick = state.tick();
        state.fire_skirmisher_if_ready("open-desert-rogue-01", &actor, &target, &mut ai, profile)
    }

    assert!(
        fires_at_40_cells(None),
        "registry max 56 cells should allow the roll NPC to fire at 40 cells"
    );
    assert!(
        !fires_at_40_cells(Some(slugthrower_combat_tuning(6, 14, 28))),
        "tuned max 28 cells should stop the roll NPC fire decision at 40 cells"
    );
}

#[test]
fn authority_roll_simple_rogue_approaches_ideal_then_holds_and_fires_without_tactical_candidates() {
    let config = SliceAuthorityConfig::default();
    let mut snapshot = open_desert_roll_combat_test_snapshot();
    snapshot.combat_tuning = Some(slugthrower_combat_tuning(6, 12, 20));
    snapshot.spawn_zones[0].activation = None;
    snapshot.blocked_cells.clear();
    let mut state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    place_actor_at_position(
        &mut state,
        "player",
        AuthorityPosition {
            x: 48_000,
            y: 10_000,
        },
    );
    place_actor_at_position(
        &mut state,
        "open-desert-rogue-01",
        AuthorityPosition {
            x: 72_000,
            y: 10_000,
        },
    );
    {
        let rogue = state.actors.get_mut("open-desert-rogue-01").unwrap();
        rogue.equipped_weapon_id = Some(AuthorityWeaponId::Slugthrower);
        rogue.slugthrower_magazine.loaded_rounds = SLUGTHROWER_MAGAZINE_SIZE;
        rogue.slugthrower_magazine.reload_until_tick = 0;
        rogue.next_fire_tick = 0;
    }
    state.provoke_rogue_social_assist("open-desert-rogue-01", "player");
    assert_eq!(
        skirmisher_attitude_for_test(&state, "open-desert-rogue-01"),
        NpcAiAttitude::Hostile
    );
    let ideal_milli = 12_000;
    let start_gap = position_distance_milli(
        state.actors.get("open-desert-rogue-01").unwrap().position,
        state.actors.get("player").unwrap().position,
    );
    assert!(start_gap > ideal_milli);

    let mut reached_ideal = false;
    for _ in 0..180 {
        state.advance_ticks_for_observer(&config, 1);
        let gap = position_distance_milli(
            state.actors.get("open-desert-rogue-01").unwrap().position,
            state.actors.get("player").unwrap().position,
        );
        if gap <= ideal_milli {
            reached_ideal = true;
            break;
        }
    }
    assert!(
        reached_ideal,
        "roll rogue should approach into the weapon ideal band"
    );
    let hold_position = state.actors.get("open-desert-rogue-01").unwrap().position;
    let shots_before_hold = state
        .actors
        .get("open-desert-rogue-01")
        .unwrap()
        .shots_fired;

    for _ in 0..90 {
        state.advance_ticks_for_observer(&config, 1);
    }

    let rogue = state.actors.get("open-desert-rogue-01").unwrap();
    assert_eq!(
        rogue.position, hold_position,
        "roll rogue should stop micro-shuffling once it holds the ideal band"
    );
    assert!(
        rogue.shots_fired > shots_before_hold,
        "held roll rogue should continue firing on the existing roll cadence"
    );
    let debug = state.ai_debug_snapshot();
    assert!(
        debug.squads.is_empty(),
        "roll simple brain should not build squad/tactical debug"
    );
    let rogue_debug = debug
        .actors
        .iter()
        .find(|actor| actor.actor_id == "open-desert-rogue-01")
        .expect("roll rogue should have an AI debug row");
    assert!(
        rogue_debug.candidates.is_empty(),
        "roll simple brain must not generate tactical candidates"
    );
    assert!(state.cached_skirmisher_tactical_state.is_none());
    let reapproach_start = state.actors.get("open-desert-rogue-01").unwrap().position;
    place_actor_at_position(
        &mut state,
        "player",
        AuthorityPosition {
            x: 40_000,
            y: 10_000,
        },
    );
    for _ in 0..10 {
        state.advance_ticks_for_observer(&config, 1);
    }
    assert!(
        state.actors.get("open-desert-rogue-01").unwrap().position.x < reapproach_start.x,
        "roll rogue should re-approach once the target drifts beyond the ideal slack band"
    );
}

#[test]
fn authority_roll_simple_rogue_holds_fire_behind_blocked_los_and_resumes_when_clear() {
    let config = SliceAuthorityConfig::default();
    let mut snapshot = open_desert_roll_combat_test_snapshot();
    snapshot.combat_tuning = Some(slugthrower_combat_tuning(6, 12, 20));
    snapshot.spawn_zones[0].activation = None;
    snapshot.blocked_cells.clear();
    let mut state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    place_actor_at_position(
        &mut state,
        "player",
        AuthorityPosition {
            x: 48_000,
            y: 10_000,
        },
    );
    place_actor_at_position(
        &mut state,
        "open-desert-rogue-01",
        AuthorityPosition {
            x: 58_000,
            y: 10_000,
        },
    );
    {
        let rogue = state.actors.get_mut("open-desert-rogue-01").unwrap();
        rogue.equipped_weapon_id = Some(AuthorityWeaponId::Slugthrower);
        rogue.slugthrower_magazine.loaded_rounds = SLUGTHROWER_MAGAZINE_SIZE;
        rogue.slugthrower_magazine.reload_until_tick = 0;
        rogue.next_fire_tick = 0;
    }
    state.provoke_rogue_social_assist("open-desert-rogue-01", "player");
    assert_eq!(
        skirmisher_attitude_for_test(&state, "open-desert-rogue-01"),
        NpcAiAttitude::Hostile
    );
    let blocker = CellKey::new(crate::AUTHORITY_TEST_AREA_ID, 53, 10);
    state.blocked_cells.insert(blocker.clone());
    assert_eq!(
        SliceAuthorityState::roll_line_of_sight_cell_walk_cost(
            state.actors.get("player").unwrap().position,
            state.actors.get("open-desert-rogue-01").unwrap().position,
        ),
        9
    );
    let hold_position = state.actors.get("open-desert-rogue-01").unwrap().position;

    for _ in 0..90 {
        state.advance_ticks_for_observer(&config, 1);
    }

    let rogue = state.actors.get("open-desert-rogue-01").unwrap();
    assert_eq!(rogue.position, hold_position);
    assert_eq!(rogue.shots_fired, 0);
    let blocked_debug = state
        .ai_debug_snapshot()
        .actors
        .into_iter()
        .find(|actor| actor.actor_id == "open-desert-rogue-01")
        .expect("blocked LOS debug row");
    assert_eq!(blocked_debug.reason, "roll_hold_los_blocked");

    state.blocked_cells.remove(&blocker);
    for _ in 0..90 {
        state.advance_ticks_for_observer(&config, 1);
    }

    assert!(
        state
            .actors
            .get("open-desert-rogue-01")
            .unwrap()
            .shots_fired
            > 0,
        "roll rogue should resume fire once the blockedCells line is clear"
    );
}

#[test]
fn authority_roll_queue_and_resolution_reject_blocked_los() {
    let (_config, mut state) = roll_combat_test_state();
    state
        .blocked_cells
        .insert(CellKey::new(crate::AUTHORITY_TEST_AREA_ID, 11, 10));
    assert_eq!(
        super::combat_roll::queue_combat_action(&mut state, "player", "basic_shot", "roll-target"),
        Err(AuthorityRejectReason::LosBlocked)
    );
    let shooter = state.actors.get("player").unwrap();
    assert_eq!(shooter.combat_queue.iter().count(), 0);
    assert_eq!(shooter.engagement_target_id, None);

    state
        .blocked_cells
        .remove(&CellKey::new(crate::AUTHORITY_TEST_AREA_ID, 11, 10));
    super::combat_roll::queue_combat_action(&mut state, "player", "basic_shot", "roll-target")
        .unwrap();
    let loaded_before = state
        .actors
        .get("player")
        .unwrap()
        .slugthrower_magazine
        .loaded_rounds;
    state
        .blocked_cells
        .insert(CellKey::new(crate::AUTHORITY_TEST_AREA_ID, 11, 10));
    state.drain_due_combat_action_queues();
    let shooter = state.actors.get("player").unwrap();
    assert_eq!(
        shooter.slugthrower_magazine.loaded_rounds, loaded_before,
        "resolve-time LOS must reject without consuming ammo"
    );
    assert_eq!(shooter.shots_fired, 0);
    assert_eq!(shooter.combat_queue.iter().count(), 0);
    assert!(state.pending_combat_events.is_empty());
}

#[test]
fn authority_roll_basic_shot_resolves_six_round_burst_and_spends_six_rounds() {
    let (_config, mut state) = roll_combat_test_state();
    let burst_rounds = super::combat_roll::roll_burst_rounds_for_test();
    state.tick = 100;
    super::combat_roll::queue_combat_action(&mut state, "player", "basic_shot", "roll-target")
        .unwrap();
    state.drain_due_combat_action_queues();

    assert_eq!(state.pending_combat_events.len(), burst_rounds as usize);
    let stats = weapon_profile(Some(AuthorityWeaponId::Slugthrower))
        .roll_stats
        .unwrap();
    let (damage_min, damage_max) = super::combat_roll::roll_burst_damage_band_for_test(stats);
    for event in &state.pending_combat_events {
        assert_eq!(event.kind.as_deref(), Some("ranged_roll"));
        assert_eq!(event.action_id.as_deref(), Some("basic_shot"));
        assert_eq!(event.pool.as_deref(), Some("health"));
        assert!(event.roll_milli.is_some());
        assert!(event.to_hit_milli.is_some());
        if event.hit == Some(true)
            && event.effect.as_ref().map(|effect| effect.kind.as_str()) != Some("dodge")
        {
            assert!(
                event.damage >= i32::try_from(damage_min).unwrap()
                    && event.damage <= i32::try_from(damage_max).unwrap(),
                "burst hit damage should be per-round, got {}",
                event.damage
            );
        } else {
            assert_eq!(event.damage, 0);
        }
    }
    assert_eq!(
        state
            .actors
            .get("player")
            .unwrap()
            .slugthrower_magazine
            .loaded_rounds,
        SLUGTHROWER_MAGAZINE_SIZE - burst_rounds
    );
    assert_eq!(
        state.actors.get("player").unwrap().shots_fired,
        u64::from(burst_rounds)
    );
}

#[test]
fn authority_roll_ranged_shot_deflects_against_capped_vibrosword_defender() {
    let (_config, state) = roll_ranged_block_test_state(
        AuthorityPosition {
            x: 25_000,
            y: 10_000,
        },
        Some(AuthorityWeaponId::Vibrosword),
        true,
    );

    let deflections = deflected_roll_events(&state);
    assert!(
        deflections.len() >= 4,
        "capped vibrosword defender should deflect the deterministic blocked-hit majority, got {} deflections",
        deflections.len()
    );
    for event in deflections {
        assert_eq!(event.damage, 0);
        assert_eq!(event.hit, Some(true));
        assert_eq!(event.lifecycle_cause, "deflected");
        assert_eq!(
            event.block_chance_milli,
            Some(950),
            "deflection should use the owner-test capped block chance"
        );
        assert!(event.block_roll_milli.is_some());
        assert_eq!(event.shooter_actor_id, "player");
        assert_eq!(event.target_actor_id, "roll-target");
        assert_eq!(event.weapon_id, AuthorityWeaponId::Slugthrower);
        assert_eq!(event.ammo_type, AuthorityAmmoTypeId::SlugIron);
    }
}

#[test]
fn authority_roll_ranged_block_is_zero_inside_melee_reach() {
    let (_config, state) = roll_ranged_block_test_state(
        AuthorityPosition {
            x: 12_000,
            y: 10_000,
        },
        Some(AuthorityWeaponId::Vibrosword),
        true,
    );
    let distance = position_distance_milli(
        state.actors.get("player").unwrap().position,
        state.actors.get("roll-target").unwrap().position,
    );
    assert!(distance <= super::ai::MELEE_STRIKE_RANGE_MILLI_CELLS);
    assert_no_ranged_block(&state.pending_combat_events);
}

#[test]
fn authority_roll_ranged_block_requires_melee_weapon_equipped() {
    let (_config, state) = roll_ranged_block_test_state(
        AuthorityPosition {
            x: 25_000,
            y: 10_000,
        },
        None,
        true,
    );
    assert_no_ranged_block(&state.pending_combat_events);
}

#[test]
fn authority_roll_ranged_vs_ranged_never_deflects() {
    let (_config, state) = roll_ranged_block_test_state(
        AuthorityPosition {
            x: 25_000,
            y: 10_000,
        },
        Some(AuthorityWeaponId::Slugthrower),
        true,
    );
    assert_no_ranged_block(&state.pending_combat_events);
}

#[test]
fn authority_roll_deflected_event_is_encoded_for_client_stream() {
    let (config, state) = roll_ranged_block_test_state(
        AuthorityPosition {
            x: 25_000,
            y: 10_000,
        },
        Some(AuthorityWeaponId::Vibrosword),
        true,
    );
    let payload = AuthorityCombatEventDeltaPayload {
        schema: "successor.authority-combat-events.v1".to_owned(),
        tick: state.tick,
        events: state.combat_events_for_observer(&config, &state.pending_combat_events),
    };
    let encoded = serde_json::to_value(&payload).expect("combat-event payload encodes");
    let events = encoded
        .get("events")
        .and_then(|events| events.as_array())
        .expect("combat events encode as array");
    let deflected = events
        .iter()
        .find(|event| {
            event.pointer("/effect/kind").and_then(|kind| kind.as_str()) == Some("deflected")
        })
        .expect("encoded client stream contains a deflected event");

    assert_eq!(
        deflected.get("kind").and_then(|value| value.as_str()),
        Some("ranged_roll")
    );
    assert_eq!(
        deflected
            .get("shooterActorId")
            .and_then(|value| value.as_str()),
        Some("player")
    );
    assert_eq!(
        deflected
            .get("targetActorId")
            .and_then(|value| value.as_str()),
        Some("roll-target")
    );
    assert_eq!(
        deflected.get("damage").and_then(|value| value.as_i64()),
        Some(0)
    );
    assert_eq!(
        deflected.get("hit").and_then(|value| value.as_bool()),
        Some(true)
    );
    assert_eq!(
        deflected
            .get("lifecycleCause")
            .and_then(|value| value.as_str()),
        Some("deflected")
    );
    assert_eq!(
        deflected
            .get("blockChanceMilli")
            .and_then(|value| value.as_u64()),
        Some(950)
    );
    assert!(deflected.get("blockRollMilli").is_some());
}

#[test]
fn authority_plasma_sword_debug_give_equips_as_vibrosword_and_encodes_item_id() {
    let (config, mut state) = roll_combat_test_state();

    let frame = state.apply_envelope(
        &config,
        command(
            1,
            ClientCommand::DebugGiveItem {
                item_id: PLASMA_SWORD_ITEM_ID,
                variant_id: 0,
                quantity: 1,
                equip: true,
            },
        ),
    );

    assert_eq!(frame.status, AuthorityCommandStatus::Accepted);
    let player = state.actors.get("player").unwrap();
    assert_eq!(
        player.equipped_weapon_id,
        Some(AuthorityWeaponId::Vibrosword)
    );
    assert_eq!(player.equipped_weapon_item_id, PLASMA_SWORD_ITEM_ID);
    assert_eq!(
        state.actor_inventory_available_quantity("player", PLASMA_SWORD_ITEM_ID),
        1
    );
    let snapshot = state.actor_snapshot("player").expect("player snapshot");
    let weapon = snapshot.weapon.expect("plasma sword weapon snapshot");
    assert_eq!(weapon.weapon_id, "vibrosword");
    assert_eq!(weapon.weapon_item_id, PLASMA_SWORD_ITEM_ID);
    let encoded = serde_json::to_value(&weapon).expect("weapon snapshot encodes");
    assert_eq!(
        encoded.get("weaponItemId").and_then(|value| value.as_u64()),
        Some(u64::from(PLASMA_SWORD_ITEM_ID))
    );
}

#[test]
fn authority_concrete_ranged_inventory_items_equip_with_certification_and_encode_identity() {
    let (config, mut state) = roll_combat_test_state();
    let player_id = config.player_actor_id.clone();
    clear_test_professions(&mut state, &player_id);
    p12_grant_boxes(
        &mut state,
        &player_id,
        &[
            "marksman-pistol-i",
            "marksman-rifle-ii",
            "marksman-rifle-iii",
            "commando-heavy-weapons-ii",
            "commando-heavy-weapons-iv",
            "commando-demolitions-ii",
        ],
    );

    for (command_id, weapon_id, item_id) in [
        (
            1,
            AuthorityWeaponId::WpnPistol,
            BADGE_BOLT_PISTOL_ITEM_ID,
        ),
        (
            2,
            AuthorityWeaponId::WpnAssault,
            SLAGRAIL_VANGUARD_ITEM_ID,
        ),
        (
            3,
            AuthorityWeaponId::WpnShotgun,
            COILGATE_SCATTER_ITEM_ID,
        ),
        (
            4,
            AuthorityWeaponId::WpnSniper,
            KILN_LONG_PATTERN_ITEM_ID,
        ),
        (5, AuthorityWeaponId::WpnHeavy, BASTION_LMG_ITEM_ID),
        (
            6,
            AuthorityWeaponId::WpnLauncher,
            FLARE_NET_LAUNCHER_ITEM_ID,
        ),
    ] {
        let variant_id = 90_000 + command_id as u32;
        state
            .apply_debug_give_item(&config, item_id, variant_id, 1, false)
            .expect("concrete weapon added to inventory");
        let frame = state.apply_envelope(
            &config,
            command(
                command_id,
                ClientCommand::SetEquippedWeapon {
                    weapon_id: Some(weapon_id),
                    weapon_item_id: Some(item_id),
                    weapon_variant_id: Some(variant_id),
                },
            ),
        );
        assert_eq!(
            frame.status,
            AuthorityCommandStatus::Accepted,
            "{weapon_id:?} rejected: {:?}",
            frame.reason_code
        );

        let snapshot = state.actor_snapshot(&player_id).expect("player snapshot");
        let weapon = snapshot.weapon.expect("equipped concrete weapon snapshot");
        assert_eq!(weapon.weapon_id, authority_weapon_id_label(weapon_id));
        assert_eq!(weapon.weapon_item_id, item_id);
        assert_eq!(weapon.weapon_variant_id, variant_id);
    }
}

#[test]
fn authority_combat_helm_debug_give_creates_real_inventory_row() {
    let (config, mut state) = roll_combat_test_state();

    let frame = state.apply_envelope(
        &config,
        command(
            1,
            ClientCommand::DebugGiveItem {
                item_id: COMBAT_HELM_ITEM_ID,
                variant_id: 0,
                quantity: 1,
                equip: false,
            },
        ),
    );

    assert_eq!(frame.status, AuthorityCommandStatus::Accepted);
    let row = state
        .inventory_snapshots()
        .into_iter()
        .find(|row| {
            row.item_id == COMBAT_HELM_ITEM_ID
                && actor_owns_inventory_container("player", &row.container)
        })
        .expect("debug-granted combat helmet must be a player inventory row");
    assert_eq!(row.item, "Combat Helm");
    assert_eq!(row.variant_id, 0);
    assert_eq!(row.available, 1);
}

#[test]
fn authority_rolled_loot_debug_give_restores_exact_variant_name() {
    let (config, mut state) = roll_combat_test_state();
    let variant_id = encode_loot_variant(LootTier::Marked, 244);
    assert_eq!(variant_id, 62_000_244);

    let frame = state.apply_envelope(
        &config,
        command(
            1,
            ClientCommand::DebugGiveItem {
                item_id: 7_202,
                variant_id,
                quantity: 1,
                equip: false,
            },
        ),
    );

    assert_eq!(frame.status, AuthorityCommandStatus::Accepted);
    let row = state
        .inventory_snapshots()
        .into_iter()
        .find(|row| {
            row.item_id == 7_202
                && row.variant_id == variant_id
                && actor_owns_inventory_container("player", &row.container)
        })
        .expect("debug-granted rolled cargo trousers must be a player inventory row");
    assert_eq!(row.item, "Marked Cargo Trousers");
    assert_eq!(row.available, 1);
}

#[test]
fn authority_actor_snapshot_serializes_null_weapon_when_unequipped() {
    let (_config, mut state) = roll_combat_test_state();
    {
        let player = state.actors.get_mut("player").unwrap();
        player.equipped_weapon_id = None;
        player.equipped_weapon_item_id = 0;
    }

    let snapshot = state.actor_snapshot("player").expect("player snapshot");
    assert!(snapshot.weapon.is_none());
    let encoded = serde_json::to_value(&snapshot).expect("actor snapshot encodes");
    assert!(
        encoded.get("weapon").is_some_and(|value| value.is_null()),
        "unequipped actor snapshots must carry explicit weapon:null so TS mirrors clear only explicit unequips; encoded={encoded}",
    );
}

#[test]
fn authority_actor_snapshot_serializes_empty_professions_when_untrained() {
    let (_config, mut state) = roll_combat_test_state();
    state.actors.get_mut("player").unwrap().professions = ActorProfessionState::empty();

    let snapshot = state.actor_snapshot("player").expect("player snapshot");
    assert!(snapshot.professions.is_empty());
    let encoded = serde_json::to_value(&snapshot).expect("actor snapshot encodes");
    assert_eq!(
        encoded.get("professions"),
        Some(&serde_json::Value::Array(Vec::new())),
        "untrained full snapshots must carry professions:[] so TS mirrors clear only explicit empty state; encoded={encoded}",
    );
}

#[test]
fn authority_actor_checkpoint_defaults_missing_wardrobe_fields() {
    let (_config, state) = roll_combat_test_state();
    let actor = state.actors.get("player").expect("player actor");
    let mut encoded = serde_json::to_value(actor).expect("actor checkpoint encodes");
    let object = encoded.as_object_mut().expect("actor checkpoint object");
    object.remove("worn");
    object.remove("worn_colors");

    let restored: ActorAuthorityState =
        serde_json::from_value(encoded).expect("legacy actor checkpoint restores");

    assert!(restored.worn.is_empty());
    assert!(restored.worn_colors.is_empty());
}

#[test]
fn authority_plasma_sword_equipped_deflects_and_rejects_melee_from_kneel() {
    let (_config, mut state) = roll_ranged_block_test_state(
        AuthorityPosition {
            x: 25_000,
            y: 10_000,
        },
        Some(AuthorityWeaponId::Vibrosword),
        true,
    );
    state
        .actors
        .get_mut("roll-target")
        .unwrap()
        .equipped_weapon_item_id = PLASMA_SWORD_ITEM_ID;
    assert!(
        !deflected_roll_events(&state).is_empty(),
        "plasma sword should use the vibrosword melee family for ranged deflection"
    );

    let (_config, mut kneeling_state) = roll_combat_test_state();
    {
        let player = kneeling_state.actors.get_mut("player").unwrap();
        player.equipped_weapon_id = Some(AuthorityWeaponId::Vibrosword);
        player.equipped_weapon_item_id = PLASMA_SWORD_ITEM_ID;
        player.posture = AuthorityActorPosture::Kneeling;
    }
    grant_test_profession(
        &mut kneeling_state,
        "player",
        AuthorityProfessionKind::Brawler,
    );

    assert_eq!(
        super::combat_roll::queue_combat_action(
            &mut kneeling_state,
            "player",
            "basic_shot",
            "roll-target"
        ),
        Err(AuthorityRejectReason::MeleeWhileKneeling)
    );
}

#[test]
fn authority_debug_grant_skill_boxes_adds_brawler_ranged_block_boxes() {
    let (config, mut state) = roll_combat_test_state();
    let skill_box_ids = BRAWLER_RANGED_BLOCK_SKILL_BOXES
        .iter()
        .map(|skill_box_id| (*skill_box_id).to_owned())
        .collect::<Vec<_>>();

    let mut one_box = std::collections::BTreeSet::new();
    one_box.insert("brawler-ranged-block-i".to_owned());
    assert_eq!(
        brawler_ranged_block_chance_milli_from_skill_boxes(&one_box),
        950
    );
    assert_eq!(
        brawler_ranged_block_chance_milli_from_skill_boxes(
            &skill_box_ids
                .iter()
                .cloned()
                .collect::<std::collections::BTreeSet<_>>()
        ),
        950,
        "extra ranged-block boxes should still cap at the owner-test ceiling"
    );

    let frame = state.apply_envelope(
        &config,
        command(
            1,
            ClientCommand::DebugGrantSkillBoxes {
                skill_box_ids: skill_box_ids.clone(),
            },
        ),
    );

    assert_eq!(frame.status, AuthorityCommandStatus::Accepted);
    let player = state.actors.get("player").unwrap();
    for skill_box_id in &skill_box_ids {
        assert!(player.professions.has_skill_box(skill_box_id));
    }
    assert_eq!(player.professions.brawler_ranged_block_chance_milli(), 950);
}

#[test]
fn authority_debug_give_credits_adjusts_and_saturates_wallet() {
    let (config, mut state) = roll_combat_test_state();
    let initial_credits = state.actors.get("player").unwrap().professions.credits;

    let grant = state.apply_envelope(
        &config,
        command(1, ClientCommand::DebugGiveCredits { amount: 250 }),
    );
    assert_eq!(grant.status, AuthorityCommandStatus::Accepted);
    assert_eq!(
        state.actors.get("player").unwrap().professions.credits,
        initial_credits + 250
    );

    let drain = state.apply_envelope(
        &config,
        command(2, ClientCommand::DebugGiveCredits { amount: i64::MIN }),
    );
    assert_eq!(drain.status, AuthorityCommandStatus::Accepted);
    assert_eq!(state.actors.get("player").unwrap().professions.credits, 0);
}

#[test]
fn authority_roll_vibrosword_basic_attack_uses_melee_profile_without_per_hit_xp() {
    let (_config, mut state) = roll_combat_test_state();
    {
        let player = state.actors.get_mut("player").unwrap();
        player.equipped_weapon_id = Some(AuthorityWeaponId::Vibrosword);
        player.slugthrower_magazine.loaded_rounds = 0;
    }
    grant_test_profession(&mut state, "player", AuthorityProfessionKind::Brawler);

    let mut hit_event = None;
    for attempt in 0..32 {
        state.tick = 200 + attempt * 40;
        state.actors.get_mut("player").unwrap().shots_fired = 0;
        super::combat_roll::queue_combat_action(&mut state, "player", "basic_shot", "roll-target")
            .unwrap();
        state.drain_due_combat_action_queues();
        hit_event = state
            .pending_combat_events
            .iter()
            .find(|event| event.damage > 0)
            .cloned();
        if hit_event.is_some() {
            break;
        }
        state.pending_combat_events.clear();
    }

    let event = hit_event.expect("vibrosword roll attack should land within deterministic sample");
    assert_eq!(event.kind.as_deref(), Some("ranged_roll"));
    assert_eq!(event.action_id.as_deref(), Some("basic_shot"));
    assert_eq!(event.weapon_id, AuthorityWeaponId::Vibrosword);
    assert_eq!(event.ammo_type, AuthorityAmmoTypeId::Melee);
    assert_eq!(state.actors.get("player").unwrap().shots_fired, 1);
    // Combat XP cutover (owner-ratified): a human player earns NO per-hit combat XP.
    // The 1000-hp target survives the single strike, so the brawler melee track stays
    // at zero — combat XP is now paid only at kill time to every ledger damager
    // (exercised by the groups module's kill-XP tests).
    assert_eq!(
        state.actors.get("roll-target").unwrap().life_state,
        AuthorityLifeState::Alive,
        "high-health target survives a single vibrosword strike"
    );
    let brawler_melee_xp = state
        .actors
        .get("player")
        .unwrap()
        .professions
        .track_xp_amount(AuthorityProfessionKind::Brawler, "melee");
    assert_eq!(
        brawler_melee_xp, 0,
        "human players no longer earn per-hit combat XP; combat XP is kill-time only"
    );
}

#[test]
fn authority_unarmed_basic_attack_is_universal_and_deliberately_weak() {
    let (_config, mut state) = roll_combat_test_state();
    clear_test_professions(&mut state, "player");
    place_actor_at_position(
        &mut state,
        "roll-target",
        AuthorityPosition::from_cell(AuthorityCell::new(11, 10)),
    );
    {
        let player = state.actors.get_mut("player").unwrap();
        player.equipped_weapon_id = None;
        player.equipped_weapon_item_id = 0;
        player.equipped_weapon_variant_id = 0;
    }
    assert_eq!(
        super::combat_roll::queue_combat_action(&mut state, "player", "aimed_shot", "roll-target",),
        Err(AuthorityRejectReason::NoWeaponEquipped),
        "the universal fallback is the basic attack, not a synthetic aimed weapon action"
    );

    let mut hit_event = None;
    for attempt in 0..32 {
        state.tick = 400 + attempt * 40;
        super::combat_roll::queue_combat_action(&mut state, "player", "basic_shot", "roll-target")
            .expect("an untrained, unequipped actor still has the basic combat verb");
        state.drain_due_combat_action_queues();
        hit_event = state
            .pending_combat_events
            .iter()
            .find(|event| event.damage > 0)
            .cloned();
        if hit_event.is_some() {
            break;
        }
        state.pending_combat_events.clear();
    }

    let event = hit_event.expect("unarmed attack should land within deterministic sample");
    assert_eq!(event.weapon_id, AuthorityWeaponId::Unarmed);
    assert_eq!(event.ammo_type, AuthorityAmmoTypeId::Melee);
    assert!(
        (1..=3).contains(&event.damage),
        "unarmed remains an emergency fallback, not a substitute for a weapon"
    );
    assert!(
        state.actor_snapshot("player").unwrap().weapon.is_none(),
        "the synthetic unarmed profile is not serialized as an equipped item"
    );
}

#[test]
fn authority_incap_timer_self_revives_and_keeps_rolling_count() {
    let config = SliceAuthorityConfig::default();
    let mut snapshot = crate::authority_test_slice();
    snapshot.actors.clear();
    snapshot.npc_jobs.clear();
    snapshot.actors.push(test_actor(
        "player",
        "Incap Target",
        "player",
        CellSnapshot::new(10, 10),
        "front",
    ));
    let mut state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    state.tick = 10;
    {
        let tick = state.tick;
        let tick_rate_hz = state.tick_rate_hz;
        let actor = state.actors.get_mut("player").unwrap();
        actor.vitals.health = -7;
        assert!(!SliceAuthorityState::down_player_like_actor_or_kill(
            tick,
            tick_rate_hz,
            actor,
        ));
    }
    let downed = state.actors.get("player").unwrap();
    assert_eq!(downed.life_state, AuthorityLifeState::Downed);
    assert_eq!(downed.incap_count, 1);
    assert!(downed.incap_expires_tick > state.tick);
    let expires = downed.incap_expires_tick;

    state.tick = expires;
    state.tick_incap_self_revives();
    let revived = state.actors.get("player").unwrap();
    assert_eq!(revived.life_state, AuthorityLifeState::Alive);
    assert_eq!(revived.incap_count, 1);
    assert_eq!(revived.incap_expires_tick, 0);
    assert!(revived.incap_grace_until_tick > state.tick);
    assert_eq!(
        revived.active_incap_count(state.tick, state.tick_rate_hz),
        1
    );
    assert!(revived.vitals.health > 0);

    advance_ticks_unclamped(&mut state, &config, 1);
}

#[test]
fn authority_third_incap_inside_window_becomes_real_death() {
    let mut snapshot = crate::authority_test_slice();
    snapshot.actors.clear();
    snapshot.npc_jobs.clear();
    snapshot.actors.push(test_actor(
        "player",
        "Triple Incap Target",
        "player",
        CellSnapshot::new(10, 10),
        "front",
    ));
    let mut state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    for cycle in 0..2 {
        state.tick = 20 + cycle;
        {
            let tick = state.tick;
            let tick_rate_hz = state.tick_rate_hz;
            let actor = state.actors.get_mut("player").unwrap();
            actor.vitals.health = -1;
            assert!(!SliceAuthorityState::down_player_like_actor_or_kill(
                tick,
                tick_rate_hz,
                actor,
            ));
            assert_eq!(actor.life_state, AuthorityLifeState::Downed);
            SliceAuthorityState::revive_actor_from_corpse(actor, REVIVE_RESTORE_VITALS_PERCENT);
        }
    }

    state.tick = 30;
    {
        let tick = state.tick;
        let tick_rate_hz = state.tick_rate_hz;
        let actor = state.actors.get_mut("player").unwrap();
        actor.vitals.health = -1;
        assert!(SliceAuthorityState::down_player_like_actor_or_kill(
            tick,
            tick_rate_hz,
            actor,
        ));
        assert_eq!(actor.life_state, AuthorityLifeState::Respawning);
        assert_eq!(actor.body_vanish_tick, 0);
        assert!(actor.respawn_tick > tick);
    }
}

#[test]
fn authority_hostile_brawler_does_not_auto_deathblow_downed_player() {
    let mut snapshot = crate::authority_test_slice();
    snapshot.factions.clear();
    snapshot.actors.clear();
    snapshot.npc_jobs.clear();
    snapshot.actors.push(test_actor(
        "player",
        "Downed Player",
        "player",
        CellSnapshot::new(10, 10),
        "front",
    ));
    snapshot.actors.push(test_actor(
        "badgrug-finisher",
        "Badgrug Finisher",
        "skirmisher_brawler",
        CellSnapshot::new(11, 10),
        "left",
    ));
    let mut state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    state.tick = 50;
    let tick = state.tick;
    let tick_rate_hz = state.tick_rate_hz;
    {
        let attacker = state.actors.get_mut("badgrug-finisher").unwrap();
        attacker.equipped_weapon_id = Some(AuthorityWeaponId::Vibrosword);
    }
    {
        let target = state.actors.get_mut("player").unwrap();
        target.vitals.health = -1;
        assert!(!SliceAuthorityState::down_player_like_actor_or_kill(
            tick,
            tick_rate_hz,
            target,
        ));
    }
    let target = state.actors.get("player").unwrap().clone();
    assert!(state
        .apply_melee_contact_strike(
            "badgrug-finisher",
            &target,
            None,
            state.actors.get("badgrug-finisher").unwrap().position,
            target.position,
        )
        .is_none());
    assert_eq!(
        state.actors.get("player").unwrap().life_state,
        AuthorityLifeState::Downed
    );

    state.actors.get_mut("player").unwrap().life_state = AuthorityLifeState::Alive;
    {
        let target = state.actors.get_mut("player").unwrap();
        target.vitals.health = -1;
        assert!(!SliceAuthorityState::down_player_like_actor_or_kill(
            tick,
            tick_rate_hz,
            target,
        ));
    }
    {
        let attacker = state.actors.get_mut("badgrug-finisher").unwrap();
        attacker.faction.social_group = Some("open_desert_rogues".to_owned());
    }
    let target = state.actors.get("player").unwrap().clone();
    assert!(state
        .apply_melee_contact_strike(
            "badgrug-finisher",
            &target,
            None,
            state.actors.get("badgrug-finisher").unwrap().position,
            target.position,
        )
        .is_none());
    assert_eq!(
        state.actors.get("player").unwrap().life_state,
        AuthorityLifeState::Downed
    );
}

#[test]
fn authority_roll_burst_can_emit_dodge_outcomes() {
    let (_config, mut state) = roll_combat_test_state();
    let burst_rounds = super::combat_roll::roll_burst_rounds_for_test();
    {
        let target = state.actors.get_mut("roll-target").unwrap();
        target.effective_stats.dodge_chance_milli = 950;
        target.vitals.health = 10_000;
        target.max_vitals.health = 10_000;
    }

    let mut saw_dodge = false;
    for attempt in 0..(SLUGTHROWER_MAGAZINE_SIZE / burst_rounds) {
        state.tick = 100 + u64::from(attempt) * 40;
        super::combat_roll::queue_combat_action(&mut state, "player", "basic_shot", "roll-target")
            .unwrap();
        state.drain_due_combat_action_queues();
        saw_dodge = state.pending_combat_events.iter().any(|event| {
            event.kind.as_deref() == Some("ranged_roll")
                && event.hit == Some(true)
                && event.damage == 0
                && event.effect.as_ref().map(|effect| effect.kind.as_str()) == Some("dodge")
                && event.lifecycle_cause == "dodged"
        });
        if saw_dodge {
            break;
        }
        state.pending_combat_events.clear();
        super::combat_roll::request_peace(&mut state, "player").unwrap();
    }

    assert!(
        saw_dodge,
        "high-dodge target should produce at least one streamed dodge round"
    );
}

#[test]
fn authority_roll_auto_face_applies_to_queued_and_auto_return_fire() {
    let (_config, mut state) = roll_combat_test_state();
    state.tick = 100;
    {
        let player = state.actors.get_mut("player").unwrap();
        player.effective_stats.dodge_chance_milli = 0;
        player.direction = "back".to_owned();
    }
    {
        let target = state.actors.get_mut("roll-target").unwrap();
        target.equipped_weapon_id = Some(AuthorityWeaponId::Slugthrower);
        target.slugthrower_magazine.loaded_rounds = SLUGTHROWER_MAGAZINE_SIZE;
        target.slugthrower_magazine.reload_until_tick = 0;
        target.next_fire_tick = 0;
        target.direction = "front".to_owned();
    }

    state
        .resolve_npc_roll_attack("roll-target", "player")
        .expect("npc burst should resolve");
    assert_eq!(state.actors.get("roll-target").unwrap().direction, "left");
    state.actors.get_mut("player").unwrap().direction = "back".to_owned();
    state.drain_due_combat_action_queues();

    let player = state.actors.get("player").unwrap();
    assert_eq!(player.engagement_target_id.as_deref(), Some("roll-target"));
    assert_eq!(player.direction, "right");
}

#[test]
fn authority_npc_roll_attack_uses_unlimited_ammo_without_inventory_or_reload_starvation() {
    let (_config, mut state) = roll_combat_test_state();
    let burst_rounds = super::combat_roll::roll_burst_rounds_for_test();
    state.inventory.retain(|row| {
        row.item_id != AMMO_SLUG_IRON_ITEM_ID
            || !actor_owns_inventory_container("roll-target", &row.container)
    });
    {
        let player = state.actors.get_mut("player").unwrap();
        player.vitals.health = 100_000;
        player.max_vitals.health = 100_000;
        player.effective_stats.dodge_chance_milli = 0;
    }
    {
        let target = state.actors.get_mut("roll-target").unwrap();
        target.equipped_weapon_id = Some(AuthorityWeaponId::Slugthrower);
        target.slugthrower_magazine.loaded_rounds = 0;
        target.slugthrower_magazine.reload_until_tick = u64::MAX / 2;
        target.next_fire_tick = 0;
    }
    assert!(!state.actor_tracks_ammo_item("roll-target", AMMO_SLUG_IRON_ITEM_ID));

    for attempt in 0..6 {
        state.tick = 200 + attempt * 100;
        state.actors.get_mut("roll-target").unwrap().next_fire_tick = 0;
        state
            .resolve_npc_roll_attack("roll-target", "player")
            .expect("NPC roll burst should ignore inventory ammo and stale reload state");
    }

    let target = state.actors.get("roll-target").unwrap();
    assert_eq!(target.shots_fired, u64::from(burst_rounds) * 6);
    assert_eq!(target.slugthrower_magazine.reload_until_tick, 0);
    assert_eq!(
        state.actor_inventory_item_available("roll-target", AMMO_SLUG_IRON_ITEM_ID),
        None
    );
}

#[test]
fn authority_roll_damage_sets_skirmisher_engagement_target_for_attack_back() {
    let mut snapshot = open_desert_roll_combat_test_snapshot();
    snapshot.spawn_zones[0].activation = None;
    snapshot.blocked_cells.clear();
    let mut state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    place_actor_at_position(
        &mut state,
        "player",
        AuthorityPosition {
            x: 48_000,
            y: 10_000,
        },
    );
    place_actor_at_position(
        &mut state,
        "open-desert-rogue-01",
        AuthorityPosition {
            x: 50_000,
            y: 10_000,
        },
    );
    {
        let player = state.actors.get_mut("player").unwrap();
        player.equipped_weapon_id = Some(AuthorityWeaponId::Slugthrower);
        player.slugthrower_magazine.loaded_rounds = SLUGTHROWER_MAGAZINE_SIZE;
        player.slugthrower_magazine.reload_until_tick = 0;
        player.vitals.action = 100;
        player.max_vitals.action = 100;
    }
    {
        let rogue = state.actors.get_mut("open-desert-rogue-01").unwrap();
        rogue.vitals.health = 1_000;
        rogue.max_vitals.health = 1_000;
        rogue.equipped_weapon_id = Some(AuthorityWeaponId::Slugthrower);
    }

    for attempt in 0..20 {
        state.tick = 100 + attempt * 60;
        state.actors.get_mut("player").unwrap().next_fire_tick = 0;
        let _ = super::combat_roll::queue_combat_action(
            &mut state,
            "player",
            "basic_shot",
            "open-desert-rogue-01",
        );
        state.drain_due_combat_action_queues();
        if state
            .actors
            .get("open-desert-rogue-01")
            .unwrap()
            .engagement_target_id
            .as_deref()
            == Some("player")
        {
            break;
        }
    }

    let rogue = state.actors.get("open-desert-rogue-01").unwrap();
    assert_eq!(rogue.engagement_target_id.as_deref(), Some("player"));
    let AuthorityAiState::Skirmisher(ai) = rogue.ai.as_ref().expect("rogue has skirmisher AI")
    else {
        panic!("open desert rogue should use skirmisher AI");
    };
    assert_eq!(ai.target_actor_id.as_deref(), Some("player"));
}

#[test]
fn authority_passive_creature_takes_damage_without_retaliating() {
    let mut snapshot = roll_combat_test_snapshot();
    add_test_factions(&mut snapshot);
    {
        let player = snapshot
            .actors
            .iter_mut()
            .find(|actor| actor.id == "player")
            .expect("player actor exists");
        player.faction_id = Some("red_crew".to_owned());
        player.social_group = Some("red_squad".to_owned());
        player.pvp_status = Some("overt".to_owned());
        player.profession_ids = vec!["marksman".to_owned()];
    }
    {
        let creature = snapshot
            .actors
            .iter_mut()
            .find(|actor| actor.id == "roll-target")
            .expect("target actor exists");
        creature.label = "Duskback PassiveCreature".to_owned();
        creature.role = "creature".to_owned();
        creature.sprite = "creature-snufflefin-adult".to_owned();
        creature.faction_id = Some("blue_crew".to_owned());
        creature.social_group = Some("blue_creatures".to_owned());
        creature.pvp_status = Some("overt".to_owned());
        creature.vitals = Some(crate::ActorVitalsSnapshot {
            health: 1_000,
            action: 100,
            spirit: 100,
        });
        creature.max_vitals = creature.vitals;
    }
    let (_config, mut state) = roll_combat_test_state_from_snapshot(snapshot);
    let mut saw_hit = false;
    for attempt in 0..40 {
        state.tick = 100 + attempt * 60;
        state.actors.get_mut("player").unwrap().next_fire_tick = 0;
        super::combat_roll::queue_combat_action(&mut state, "player", "basic_shot", "roll-target")
            .unwrap();
        state.drain_due_combat_action_queues();
        if state
            .pending_combat_events
            .iter()
            .any(|event| event.target_actor_id == "roll-target" && event.hit == Some(true))
        {
            saw_hit = true;
            break;
        }
    }
    assert!(
        saw_hit,
        "test setup should land at least one hit on the creature"
    );
    let creature = state.actors.get("roll-target").unwrap();
    assert_eq!(creature.engagement_target_id, None);
    assert_eq!(creature.combat_queue.iter().count(), 0);
    assert_eq!(creature.shots_fired, 0);
    assert!(
        matches!(
            creature.ai.as_ref(),
            Some(AuthorityAiState::PassiveCreature(_))
        ),
        "passive_creature role should keep passive creature AI"
    );
    assert!(
        !state.actor_snapshot("roll-target").unwrap().will_auto_aggro,
        "a passive-retaliate creature never auto-aggros (yellow name)"
    );
}

#[test]
fn authority_will_auto_aggro_tracks_class_and_live_attitude() {
    // Owner threat-legibility doctrine (2026-07-08): RED nameplate = the NPC
    // will auto-aggro the player, YELLOW = it won't aggro unless attacked.
    // `will_auto_aggro` is recomputed per snapshot from the LIVE attitude.
    let (config, mut state) = passive_rogue_roll_state(1);
    state.advance_ticks_for_observer(&config, 1);

    // Passive open-desert rogue: provoked-only while passive/alerted (yellow).
    assert!(
        matches!(
            skirmisher_attitude_for_test(&state, "open-desert-rogue-01"),
            NpcAiAttitude::Passive | NpcAiAttitude::Alerted
        ),
        "fixture rogue should start passive/alerted"
    );
    assert!(
        !state
            .actor_snapshot("open-desert-rogue-01")
            .unwrap()
            .will_auto_aggro,
        "an un-provoked passive rogue reads provoked-only (yellow)"
    );

    // Provoke -> hostile flips will_auto_aggro true (RED) the same snapshot.
    if let Some(AuthorityAiState::Skirmisher(ai)) = state
        .actors
        .get_mut("open-desert-rogue-01")
        .unwrap()
        .ai
        .as_mut()
    {
        ai.attitude = NpcAiAttitude::Hostile;
    }
    assert!(
        state
            .actor_snapshot("open-desert-rogue-01")
            .unwrap()
            .will_auto_aggro,
        "a provoked (hostile) passive rogue reads auto-aggro (red)"
    );

    // Decay back out of hostility -> provoked-only yellow again.
    if let Some(AuthorityAiState::Skirmisher(ai)) = state
        .actors
        .get_mut("open-desert-rogue-01")
        .unwrap()
        .ai
        .as_mut()
    {
        ai.attitude = NpcAiAttitude::Passive;
    }
    assert!(
        !state
            .actor_snapshot("open-desert-rogue-01")
            .unwrap()
            .will_auto_aggro,
        "decay out of hostility returns the rogue to provoked-only (yellow)"
    );

    // A hostile patrol uses the same skirmisher engagement brain but is not a
    // provoked-only open-desert drifter, so it auto-aggros on sight.
    state
        .actors
        .get_mut("open-desert-rogue-01")
        .unwrap()
        .faction
        .social_group = Some("hostile_patrol".to_owned());
    assert!(
        state
            .actor_snapshot("open-desert-rogue-01")
            .unwrap()
            .will_auto_aggro,
        "a hostile patrol skirmisher auto-aggros regardless of attitude"
    );
}

#[test]
fn authority_passive_rogue_alerts_without_attacking_adjacent_player() {
    let (config, mut state) = passive_rogue_roll_state(1);

    let events = state.advance_ticks_for_observer(&config, 120);

    assert!(
        events.is_empty(),
        "alerted passive rogue should not initiate attacks"
    );
    let rogue = state.actors.get("open-desert-rogue-01").unwrap();
    assert_eq!(
        skirmisher_attitude_for_test(&state, "open-desert-rogue-01"),
        NpcAiAttitude::Alerted
    );
    assert_eq!(rogue.engagement_target_id, None);
    assert_eq!(rogue.combat_queue.iter().count(), 0);
    assert_eq!(rogue.shots_fired, 0);
}

#[test]
fn authority_alerted_rogue_decays_to_passive_after_player_leaves() {
    let (config, mut state) = passive_rogue_roll_state(1);
    state.advance_ticks_for_observer(&config, 1);
    assert_eq!(
        skirmisher_attitude_for_test(&state, "open-desert-rogue-01"),
        NpcAiAttitude::Alerted
    );

    place_actor_at_position(
        &mut state,
        "player",
        AuthorityPosition {
            x: 90_000,
            y: 10_000,
        },
    );
    let decay_ticks = ms_to_ticks_round(8_000, state.tick_rate_hz).saturating_add(2);
    advance_ticks_unclamped(&mut state, &config, decay_ticks);

    assert_eq!(
        skirmisher_attitude_for_test(&state, "open-desert-rogue-01"),
        NpcAiAttitude::Passive
    );
}

#[test]
fn authority_roll_attack_makes_passive_rogue_hostile_even_on_first_shot() {
    let (_config, mut state) = passive_rogue_roll_state(1);
    super::combat_roll::queue_combat_action(
        &mut state,
        "player",
        "basic_shot",
        "open-desert-rogue-01",
    )
    .unwrap();
    state.drain_due_combat_action_queues();

    let rogue = state.actors.get("open-desert-rogue-01").unwrap();
    assert_eq!(
        skirmisher_attitude_for_test(&state, "open-desert-rogue-01"),
        NpcAiAttitude::Hostile
    );
    assert_eq!(rogue.engagement_target_id.as_deref(), Some("player"));
}

#[test]
fn authority_passive_rogue_social_assist_pulls_same_group_only() {
    let (_config, mut state) = passive_rogue_roll_state(2);
    place_actor_at_position(
        &mut state,
        "open-desert-rogue-02",
        AuthorityPosition {
            x: 60_000,
            y: 10_000,
        },
    );

    super::combat_roll::queue_combat_action(
        &mut state,
        "player",
        "basic_shot",
        "open-desert-rogue-01",
    )
    .unwrap();
    state.drain_due_combat_action_queues();

    assert_eq!(
        skirmisher_attitude_for_test(&state, "open-desert-rogue-01"),
        NpcAiAttitude::Hostile
    );
    assert_eq!(
        skirmisher_attitude_for_test(&state, "open-desert-rogue-02"),
        NpcAiAttitude::Hostile
    );
    assert_eq!(
        state
            .actors
            .get("open-desert-rogue-02")
            .unwrap()
            .engagement_target_id
            .as_deref(),
        Some("player")
    );
}

#[test]
fn authority_ability_queue_caps_player_ai_and_repeat_replacement_does_not_increase_depth() {
    let (_config, mut state) = roll_combat_test_state();
    state.tick = 100;
    state.actors.get_mut("roll-target").unwrap().vitals.health = 100_000;

    super::combat_roll::queue_combat_action(&mut state, "player", "basic_shot", "roll-target")
        .unwrap();
    for _ in 0..14 {
        super::combat_roll::queue_combat_action(&mut state, "player", "aimed_shot", "roll-target")
            .unwrap();
    }
    let player = state.actors.get("player").unwrap();
    let repeat_id = player.combat_queue.repeat_intent.as_ref().unwrap().queue_id;
    assert_eq!(ability_queue_depth_for_test(player), 15);
    assert_eq!(
        super::combat_roll::queue_combat_action(&mut state, "player", "aimed_shot", "roll-target"),
        Err(AuthorityRejectReason::QueueFull)
    );
    super::combat_roll::queue_combat_action(&mut state, "player", "basic_shot", "roll-target")
        .unwrap();
    let player = state.actors.get("player").unwrap();
    assert_eq!(ability_queue_depth_for_test(player), 15);
    assert_eq!(
        player.combat_queue.repeat_intent.as_ref().unwrap().queue_id,
        repeat_id,
        "repeat replacement must retain the same queue id and not append"
    );
    assert_eq!(player.combat_queue.entries.len(), 14);

    let mut snapshot = roll_combat_test_snapshot();
    snapshot.actors.push(test_actor(
        "ai-shooter",
        "AI Shooter",
        "skirmisher",
        CellSnapshot::new(14, 10),
        "left",
    ));
    let (_config, mut ai_state) = roll_combat_test_state_from_snapshot(snapshot);
    ai_state.tick = 100;
    equip_slugthrower_full_for_test(&mut ai_state, "ai-shooter");
    ai_state
        .actors
        .get_mut("roll-target")
        .unwrap()
        .vitals
        .health = 100_000;
    super::combat_roll::queue_combat_action(
        &mut ai_state,
        "ai-shooter",
        "basic_shot",
        "roll-target",
    )
    .unwrap();
    for _ in 0..4 {
        super::combat_roll::queue_combat_action(
            &mut ai_state,
            "ai-shooter",
            "aimed_shot",
            "roll-target",
        )
        .unwrap();
    }
    let ai = ai_state.actors.get("ai-shooter").unwrap();
    let ai_repeat_id = ai.combat_queue.repeat_intent.as_ref().unwrap().queue_id;
    assert_eq!(ability_queue_depth_for_test(ai), 5);
    assert_eq!(
        super::combat_roll::queue_combat_action(
            &mut ai_state,
            "ai-shooter",
            "aimed_shot",
            "roll-target",
        ),
        Err(AuthorityRejectReason::QueueFull)
    );
    super::combat_roll::queue_combat_action(
        &mut ai_state,
        "ai-shooter",
        "basic_shot",
        "roll-target",
    )
    .unwrap();
    let ai = ai_state.actors.get("ai-shooter").unwrap();
    assert_eq!(ability_queue_depth_for_test(ai), 5);
    assert_eq!(
        ai.combat_queue.repeat_intent.as_ref().unwrap().queue_id,
        ai_repeat_id
    );
}

#[test]
fn authority_ability_queue_budget_bounds_growth_and_preserves_later_actor_at_max_tick() {
    let mut snapshot = roll_combat_test_snapshot();
    snapshot.actors.push(test_actor(
        "zz-fair-shooter",
        "Fair Shooter",
        "skirmisher",
        CellSnapshot::new(14, 10),
        "left",
    ));
    let (_config, mut state) = roll_combat_test_state_from_snapshot(snapshot);
    equip_slugthrower_full_for_test(&mut state, "zz-fair-shooter");
    state.tick = u64::MAX;
    state.actors.get_mut("roll-target").unwrap().vitals.health = 100_000;
    let current_tick = state.tick;

    {
        let queue = &mut state.actors.get_mut("player").unwrap().combat_queue;
        queue.entries = (1..=(super::combat_roll::PLAYER_ABILITY_QUEUE_CAPACITY as u32 + 2))
            .map(|queue_id| super::combat_roll::AbilityQueueEntry {
                queue_id,
                action_id: super::combat_roll::CombatActionId::AimedShot,
                target_actor_id: "missing-target".to_owned(),
                enqueued_at_tick: current_tick,
            })
            .collect();
        queue.next_ready_tick = current_tick;
        queue.sequence = super::combat_roll::PLAYER_ABILITY_QUEUE_CAPACITY as u32 + 2;
    }
    {
        let shooter = state.actors.get_mut("zz-fair-shooter").unwrap();
        shooter
            .combat_queue
            .entries
            .push(super::combat_roll::AbilityQueueEntry {
                queue_id: 1,
                action_id: super::combat_roll::CombatActionId::AimedShot,
                target_actor_id: "roll-target".to_owned(),
                enqueued_at_tick: current_tick,
            });
        shooter.combat_queue.next_ready_tick = current_tick;
        shooter.combat_queue.sequence = 1;
    }

    let events_before = state.pending_ability_queue_events.len();
    let later_actor_shots_before = state.actors.get("zz-fair-shooter").unwrap().shots_fired;
    state.drain_due_combat_action_queues();

    let player = state.actors.get("player").unwrap();
    assert_eq!(player.combat_queue.entries.len(), 1);
    assert_eq!(player.combat_queue.next_ready_tick, u64::MAX);
    assert_eq!(
        state.actors.get("zz-fair-shooter").unwrap().shots_fired,
        later_actor_shots_before + u64::from(super::combat_roll::roll_burst_rounds_for_test()),
        "exhausting one actor's budget must not starve a later due actor"
    );
    assert!(
        state
            .pending_ability_queue_events
            .len()
            .saturating_sub(events_before)
            <= super::combat_roll::PLAYER_ABILITY_QUEUE_CAPACITY + 3,
        "one drain must keep queue-event growth bounded"
    );
}

#[test]
fn authority_ability_queue_basic_repeat_drains_multiple_weapon_speed_ticks() {
    let (_config, mut state) = roll_combat_test_state();
    let burst_rounds = super::combat_roll::roll_burst_rounds_for_test();
    state.tick = 100;
    state.actors.get_mut("roll-target").unwrap().vitals.health = 100_000;
    assert_eq!(
        super::combat_roll::roll_attack_speed_ticks_for_test(500, "basic_shot", 30),
        Some(30)
    );
    assert_eq!(
        super::combat_roll::roll_attack_speed_ticks_for_test(
            SLUGTHROWER_ROLL_ATTACK_SPEED_MS,
            "basic_shot",
            30,
        ),
        Some(33)
    );
    assert_eq!(
        super::combat_roll::roll_attack_speed_ticks_for_test(
            SLUGTHROWER_ROLL_ATTACK_SPEED_MS,
            "aimed_shot",
            30,
        ),
        Some(50)
    );

    super::combat_roll::queue_combat_action(&mut state, "player", "basic_shot", "roll-target")
        .unwrap();
    let repeat_id = state
        .actors
        .get("player")
        .unwrap()
        .combat_queue
        .repeat_intent
        .as_ref()
        .unwrap()
        .queue_id;

    state.drain_due_combat_action_queues();
    let shooter = state.actors.get("player").unwrap();
    assert_eq!(
        shooter.slugthrower_magazine.loaded_rounds,
        SLUGTHROWER_MAGAZINE_SIZE - burst_rounds
    );
    assert_eq!(shooter.combat_queue.next_ready_tick, 133);
    let repeat = shooter.combat_queue.repeat_intent.as_ref().unwrap();
    assert_eq!(repeat.queue_id, repeat_id);
    assert_eq!(repeat.fire_seq, 1);
    assert_eq!(shooter.combat_queue.iter().count(), 0);

    state.tick = 132;
    state.drain_due_combat_action_queues();
    assert_eq!(
        state
            .actors
            .get("player")
            .unwrap()
            .combat_queue
            .repeat_intent
            .as_ref()
            .unwrap()
            .fire_seq,
        1
    );

    state.tick = 133;
    state.drain_due_combat_action_queues();
    let shooter = state.actors.get("player").unwrap();
    assert_eq!(
        shooter.slugthrower_magazine.loaded_rounds,
        SLUGTHROWER_MAGAZINE_SIZE - burst_rounds * 2
    );
    assert_eq!(shooter.combat_queue.next_ready_tick, 166);
    assert_eq!(
        shooter
            .combat_queue
            .repeat_intent
            .as_ref()
            .unwrap()
            .fire_seq,
        2
    );
}

#[test]
fn authority_roll_owner_repeat_tracks_engagement_and_serializes_legacy_queue_view() {
    let (_config, mut state) = roll_combat_test_state();
    let burst_rounds = super::combat_roll::roll_burst_rounds_for_test();
    state.tick = 100;
    state.actors.get_mut("roll-target").unwrap().vitals.health = 100_000;

    super::combat_roll::queue_combat_action(&mut state, "player", "basic_shot", "roll-target")
        .unwrap();
    assert_eq!(
        state
            .actors
            .get("player")
            .unwrap()
            .engagement_target_id
            .as_deref(),
        Some("roll-target")
    );

    state.drain_due_combat_action_queues();
    let shooter = state.actors.get("player").unwrap();
    assert_eq!(
        shooter.slugthrower_magazine.loaded_rounds,
        SLUGTHROWER_MAGAZINE_SIZE - burst_rounds
    );
    let repeat = shooter.combat_queue.repeat_intent.as_ref().unwrap();
    assert_eq!(
        repeat.action_id,
        super::combat_roll::CombatActionId::BasicShot
    );
    assert_eq!(repeat.target_actor_id, "roll-target");
    assert_eq!(repeat.source, super::combat_roll::CombatRepeatSource::Owner);

    let snapshot = state.actor_snapshot("player").unwrap();
    let queue = snapshot.combat_queue.unwrap();
    assert_eq!(queue.next_ready_tick, 133);
    assert_eq!(queue.entries[0].action_id, "basic_shot");
    assert_eq!(queue.entries[0].target_actor_id, "roll-target");
    assert!(!queue.entries[0].auto);

    state.tick = 133;
    state.drain_due_combat_action_queues();
    let shooter = state.actors.get("player").unwrap();
    assert_eq!(
        shooter.slugthrower_magazine.loaded_rounds,
        SLUGTHROWER_MAGAZINE_SIZE - burst_rounds * 2
    );
    assert_eq!(shooter.combat_queue.next_ready_tick, 166);
}

#[test]
fn authority_roll_ranged_damage_sets_victim_engagement_for_auto_return_fire() {
    let (_config, mut state) = roll_combat_test_state();
    {
        let target = state.actors.get_mut("roll-target").unwrap();
        target.equipped_weapon_id = Some(AuthorityWeaponId::Slugthrower);
        target.slugthrower_magazine.loaded_rounds = SLUGTHROWER_MAGAZINE_SIZE;
        target.slugthrower_magazine.reload_until_tick = 0;
    }

    for attempt in 0..20 {
        state.tick = 200 + attempt * 40;
        state.actors.get_mut("roll-target").unwrap().next_fire_tick = 0;
        let _ = state.resolve_npc_roll_attack("roll-target", "player");
        if state
            .actors
            .get("player")
            .unwrap()
            .engagement_target_id
            .as_deref()
            == Some("roll-target")
        {
            break;
        }
    }

    assert_eq!(
        state
            .actors
            .get("player")
            .unwrap()
            .engagement_target_id
            .as_deref(),
        Some("roll-target")
    );
    state.drain_due_combat_action_queues();
    let queued = state
        .actors
        .get("player")
        .unwrap()
        .combat_queue
        .repeat_intent
        .as_ref()
        .unwrap();
    assert_eq!(queued.source, super::combat_roll::CombatRepeatSource::Auto);
    assert_eq!(queued.target_actor_id, "roll-target");
}

#[test]
fn authority_roll_peace_suppresses_auto_fire_without_ending_combat() {
    let (_config, mut state) = roll_combat_test_state();
    state.tick = 100;
    super::combat_roll::queue_combat_action(&mut state, "player", "basic_shot", "roll-target")
        .unwrap();
    state.drain_due_combat_action_queues();
    assert!(state
        .actors
        .get("player")
        .unwrap()
        .combat_queue
        .repeat_intent
        .is_some());

    super::combat_roll::request_peace(&mut state, "player").unwrap();
    let snapshot = state.actor_snapshot("player").unwrap();
    assert_eq!(snapshot.in_combat, Some(true));
    assert!(snapshot.peace_requested);
    assert!(snapshot.combat_queue.is_none());

    state.tick = 133;
    state.drain_due_combat_action_queues();
    let shooter = state.actors.get("player").unwrap();
    assert_eq!(
        shooter.slugthrower_magazine.loaded_rounds,
        SLUGTHROWER_MAGAZINE_SIZE - super::combat_roll::roll_burst_rounds_for_test()
    );
    assert_eq!(shooter.combat_queue.iter().count(), 0);
}

#[test]
fn authority_roll_explicit_queue_clears_peace_and_appends_one_shot() {
    let (_config, mut state) = roll_combat_test_state();
    state.tick = 100;
    super::combat_roll::queue_combat_action(&mut state, "player", "basic_shot", "roll-target")
        .unwrap();
    state.drain_due_combat_action_queues();
    super::combat_roll::request_peace(&mut state, "player").unwrap();
    assert!(state.actors.get("player").unwrap().peace_requested);

    super::combat_roll::queue_combat_action(&mut state, "player", "aimed_shot", "roll-target")
        .unwrap();
    let shooter = state.actors.get("player").unwrap();
    assert!(!shooter.peace_requested);
    assert_eq!(shooter.combat_queue.iter().count(), 1);
    let queued = shooter.combat_queue.iter().next().unwrap();
    assert_eq!(
        queued.action_id,
        super::combat_roll::CombatActionId::AimedShot
    );
}

#[test]
fn authority_ability_queue_aimed_interleaves_before_repeat_and_repeat_resumes() {
    let (_config, mut state) = roll_combat_test_state();
    let burst_rounds = super::combat_roll::roll_burst_rounds_for_test();
    state.tick = 100;
    state.actors.get_mut("roll-target").unwrap().vitals.health = 100_000;

    super::combat_roll::queue_combat_action(&mut state, "player", "basic_shot", "roll-target")
        .unwrap();
    super::combat_roll::queue_combat_action(&mut state, "player", "aimed_shot", "roll-target")
        .unwrap();
    {
        let shooter = state.actors.get("player").unwrap();
        assert!(shooter.combat_queue.repeat_intent.is_some());
        assert_eq!(shooter.combat_queue.entries.len(), 1);
    }

    state.drain_due_combat_action_queues();
    {
        let shooter = state.actors.get("player").unwrap();
        assert_eq!(shooter.combat_queue.entries.len(), 0);
        assert_eq!(
            shooter
                .combat_queue
                .repeat_intent
                .as_ref()
                .unwrap()
                .fire_seq,
            0
        );
        assert_eq!(shooter.combat_queue.next_ready_tick, 150);
        assert_eq!(shooter.shots_fired, u64::from(burst_rounds));
        assert_eq!(shooter.vitals.action, 75);
    }
    assert!(state.pending_ability_queue_events.iter().any(|event| {
        event.lifecycle == AbilityQueueLifecycle::Fired
            && event.ability_id.as_deref() == Some("aimed_shot")
    }));

    state.tick = 150;
    state.drain_due_combat_action_queues();
    let shooter = state.actors.get("player").unwrap();
    assert_eq!(shooter.shots_fired, u64::from(burst_rounds) * 2);
    assert_eq!(
        shooter
            .combat_queue
            .repeat_intent
            .as_ref()
            .unwrap()
            .fire_seq,
        1
    );
}

#[test]
fn authority_cancel_ability_queue_is_idempotent_and_rejects_unknown_ids() {
    let (_config, mut state) = roll_combat_test_state();
    state.tick = 100;
    super::combat_roll::queue_combat_action(&mut state, "player", "basic_shot", "roll-target")
        .unwrap();
    super::combat_roll::queue_combat_action(&mut state, "player", "aimed_shot", "roll-target")
        .unwrap();
    let explicit_id = state.actors.get("player").unwrap().combat_queue.entries[0].queue_id;

    super::combat_roll::cancel_ability_queue(&mut state, "player", None, Some("owner_repeat"))
        .unwrap();
    let player = state.actors.get("player").unwrap();
    assert!(player.combat_queue.repeat_intent.is_none());
    assert_eq!(player.combat_queue.entries.len(), 1);
    super::combat_roll::cancel_ability_queue(&mut state, "player", None, Some("owner_repeat"))
        .unwrap();
    assert_eq!(
        state
            .actors
            .get("player")
            .unwrap()
            .combat_queue
            .entries
            .len(),
        1
    );

    super::combat_roll::cancel_ability_queue(
        &mut state,
        "player",
        Some(&format!("q{explicit_id}")),
        None,
    )
    .unwrap();
    assert_eq!(
        ability_queue_depth_for_test(state.actors.get("player").unwrap()),
        0
    );
    assert_eq!(
        super::combat_roll::cancel_ability_queue(&mut state, "player", Some("q999"), None),
        Err(AuthorityRejectReason::QueueEntryUnknown)
    );

    super::combat_roll::queue_combat_action(&mut state, "player", "basic_shot", "roll-target")
        .unwrap();
    super::combat_roll::queue_combat_action(&mut state, "player", "aimed_shot", "roll-target")
        .unwrap();
    super::combat_roll::cancel_ability_queue(&mut state, "player", None, Some("combat")).unwrap();
    assert_eq!(
        ability_queue_depth_for_test(state.actors.get("player").unwrap()),
        0,
        "scope=combat clears explicit entries plus repeat_intent in this lane"
    );
}

#[test]
fn authority_ability_queue_clears_on_death_respawn_and_weapon_unequip() {
    let (_config, mut state) = roll_combat_test_state();
    state.tick = 100;
    super::combat_roll::queue_combat_action(&mut state, "player", "basic_shot", "roll-target")
        .unwrap();
    {
        let actor = state.actors.get_mut("player").unwrap();
        SliceAuthorityState::set_actor_life_state(actor, AuthorityLifeState::Downed);
    }
    assert_eq!(
        ability_queue_depth_for_test(state.actors.get("player").unwrap()),
        0
    );
    {
        let actor = state.actors.get_mut("player").unwrap();
        SliceAuthorityState::revive_actor_from_corpse(actor, REVIVE_RESTORE_VITALS_PERCENT);
    }
    assert_eq!(
        ability_queue_depth_for_test(state.actors.get("player").unwrap()),
        0
    );

    let (config, mut unequip_state) = roll_combat_test_state();
    unequip_state.tick = 100;
    super::combat_roll::queue_combat_action(
        &mut unequip_state,
        "player",
        "basic_shot",
        "roll-target",
    )
    .unwrap();
    let frame = unequip_state.apply_live_envelope(
        &config,
        command(
            1,
            ClientCommand::SetEquippedWeapon {
                weapon_id: None,
                weapon_item_id: None,
                weapon_variant_id: None,
            },
        ),
    );
    assert_eq!(frame.status, AuthorityCommandStatus::Accepted);
    assert_eq!(
        ability_queue_depth_for_test(unequip_state.actors.get("player").unwrap()),
        0
    );
}

#[test]
fn authority_ability_queue_posture_lock_clears_melee_but_preserves_ranged() {
    let (_config, mut melee_state) = roll_combat_test_state();
    melee_state.tick = 100;
    {
        let player = melee_state.actors.get_mut("player").unwrap();
        player.equipped_weapon_id = Some(AuthorityWeaponId::Vibrosword);
    }
    grant_test_profession(&mut melee_state, "player", AuthorityProfessionKind::Brawler);
    super::combat_roll::queue_combat_action(
        &mut melee_state,
        "player",
        "aimed_shot",
        "roll-target",
    )
    .unwrap();
    melee_state.actors.get_mut("player").unwrap().posture = AuthorityActorPosture::Kneeling;
    melee_state.drain_due_combat_action_queues();
    assert_eq!(
        ability_queue_depth_for_test(melee_state.actors.get("player").unwrap()),
        0
    );
    assert!(melee_state
        .pending_ability_queue_events
        .iter()
        .any(|event| {
            event.lifecycle == AbilityQueueLifecycle::Dismissed
                && event.reason_code.as_deref() == Some("melee_while_kneeling")
        }));

    let (_config, mut ranged_state) = roll_combat_test_state();
    ranged_state.tick = 100;
    ranged_state
        .actors
        .get_mut("roll-target")
        .unwrap()
        .vitals
        .health = 100_000;
    super::combat_roll::queue_combat_action(
        &mut ranged_state,
        "player",
        "aimed_shot",
        "roll-target",
    )
    .unwrap();
    ranged_state.actors.get_mut("player").unwrap().posture = AuthorityActorPosture::Kneeling;
    ranged_state.drain_due_combat_action_queues();
    let player = ranged_state.actors.get("player").unwrap();
    assert_eq!(player.combat_queue.entries.len(), 0);
    assert!(player.shots_fired > 0);
}

#[test]
fn authority_ability_queue_cooldown_waits_and_permanent_ammo_unavailable_clears() {
    let (_config, mut wait_state) = roll_combat_test_state();
    wait_state.tick = 100;
    wait_state
        .actors
        .get_mut("roll-target")
        .unwrap()
        .vitals
        .health = 100_000;
    {
        let player = wait_state.actors.get_mut("player").unwrap();
        player.slugthrower_magazine.loaded_rounds = 0;
        player.slugthrower_magazine.reload_until_tick = 0;
    }
    push_test_inventory_stack(
        &mut wait_state,
        "player:field-pack",
        AMMO_SLUG_IRON_ITEM_ID,
        0,
        SLUGTHROWER_MAGAZINE_SIZE,
    );
    assert!(
        wait_state
            .actor_inventory_item_available("player", AMMO_SLUG_IRON_ITEM_ID)
            .unwrap_or(0)
            >= super::combat_roll::roll_burst_rounds_for_test()
    );
    super::combat_roll::queue_combat_action(&mut wait_state, "player", "aimed_shot", "roll-target")
        .unwrap();
    wait_state.drain_due_combat_action_queues();
    let reload_until_tick = wait_state
        .actors
        .get("player")
        .unwrap()
        .slugthrower_magazine
        .reload_until_tick;
    assert!(reload_until_tick > wait_state.tick);
    assert_eq!(
        wait_state
            .actors
            .get("player")
            .unwrap()
            .combat_queue
            .entries
            .len(),
        1
    );
    assert_eq!(
        wait_state
            .actors
            .get("player")
            .unwrap()
            .combat_queue
            .next_ready_tick,
        reload_until_tick
    );
    wait_state.tick = reload_until_tick;
    wait_state.tick_weapon_reloads();
    assert_eq!(
        wait_state
            .actor_inventory_item_available("player", AMMO_SLUG_IRON_ITEM_ID)
            .unwrap_or(0),
        0,
        "the completed reload should consume the final reserve stack"
    );
    assert_eq!(
        wait_state
            .actors
            .get("player")
            .unwrap()
            .slugthrower_magazine
            .loaded_rounds,
        SLUGTHROWER_MAGAZINE_SIZE,
        "the magazine remains authoritative after reserve reaches zero"
    );
    let shots_before = wait_state.actors.get("player").unwrap().shots_fired;
    wait_state.drain_due_combat_action_queues();
    let player = wait_state.actors.get("player").unwrap();
    assert_eq!(player.combat_queue.entries.len(), 0);
    assert_eq!(
        player.shots_fired,
        shots_before + u64::from(super::combat_roll::roll_burst_rounds_for_test()),
        "a loaded magazine must fire even when tracked reserve is empty"
    );
    assert_eq!(
        player.slugthrower_magazine.loaded_rounds,
        SLUGTHROWER_MAGAZINE_SIZE - super::combat_roll::roll_burst_rounds_for_test()
    );

    let (_config, mut empty_state) = roll_combat_test_state();
    empty_state.tick = 100;
    empty_state
        .actors
        .get_mut("roll-target")
        .unwrap()
        .vitals
        .health = 100_000;
    empty_state
        .actors
        .get_mut("player")
        .unwrap()
        .slugthrower_magazine
        .loaded_rounds = 0;
    push_test_inventory_stack(
        &mut empty_state,
        "player:field-pack",
        AMMO_SLUG_IRON_ITEM_ID,
        0,
        SLUGTHROWER_MAGAZINE_SIZE,
    );
    super::combat_roll::queue_combat_action(
        &mut empty_state,
        "player",
        "aimed_shot",
        "roll-target",
    )
    .unwrap();
    for row in &mut empty_state.inventory {
        if row.item_id == AMMO_SLUG_IRON_ITEM_ID {
            row.quantity = 0;
            row.reserved = 0;
            row.available = 0;
        }
    }
    empty_state.drain_due_combat_action_queues();
    assert_eq!(
        empty_state
            .actors
            .get("player")
            .unwrap()
            .combat_queue
            .entries
            .len(),
        0
    );
    assert!(empty_state
        .pending_ability_queue_events
        .iter()
        .any(|event| {
            event.lifecycle == AbilityQueueLifecycle::Dismissed
                && event.reason_code.as_deref() == Some("ammo_unavailable")
        }));
}

#[test]
fn authority_ability_queue_stable_hash_replay_and_clear_relations_hold() {
    fn hash_after_stream(stream: &[ClientCommand]) -> String {
        let (config, mut state) = roll_combat_test_state();
        state.tick = 100;
        for (index, client_command) in stream.iter().cloned().enumerate() {
            let frame =
                state.apply_live_envelope(&config, command((index + 1) as u64, client_command));
            assert_eq!(frame.status, AuthorityCommandStatus::Accepted);
        }
        state.stable_state_hash_hex()
    }

    let stream = vec![
        ClientCommand::QueueCombatAction {
            action_id: "basic_shot".to_owned(),
            target_actor_id: "roll-target".to_owned(),
        },
        ClientCommand::QueueCombatAction {
            action_id: "aimed_shot".to_owned(),
            target_actor_id: "roll-target".to_owned(),
        },
    ];
    assert_eq!(hash_after_stream(&stream), hash_after_stream(&stream));

    let (_config, mut cancel_state) = roll_combat_test_state();
    cancel_state.tick = 100;
    cancel_state
        .actors
        .get_mut("player")
        .unwrap()
        .engagement_target_id = Some("roll-target".to_owned());
    super::combat_roll::bump_actor_combat_until(&mut cancel_state, "player", 100);
    let empty_hash = cancel_state.stable_state_hash_hex();
    super::combat_roll::queue_combat_action(
        &mut cancel_state,
        "player",
        "basic_shot",
        "roll-target",
    )
    .unwrap();
    assert_ne!(cancel_state.stable_state_hash_hex(), empty_hash);
    super::combat_roll::cancel_ability_queue(
        &mut cancel_state,
        "player",
        None,
        Some("owner_repeat"),
    )
    .unwrap();
    assert_eq!(cancel_state.stable_state_hash_hex(), empty_hash);

    let (_config, mut peace_state) = roll_combat_test_state();
    peace_state.tick = 100;
    peace_state
        .actors
        .get_mut("player")
        .unwrap()
        .peace_requested = true;
    peace_state
        .actors
        .get_mut("player")
        .unwrap()
        .engagement_target_id = Some("roll-target".to_owned());
    super::combat_roll::bump_actor_combat_until(&mut peace_state, "player", 100);
    let peace_empty_hash = peace_state.stable_state_hash_hex();
    super::combat_roll::queue_combat_action(
        &mut peace_state,
        "player",
        "basic_shot",
        "roll-target",
    )
    .unwrap();
    assert_ne!(peace_state.stable_state_hash_hex(), peace_empty_hash);
    super::combat_roll::request_peace(&mut peace_state, "player").unwrap();
    assert_eq!(peace_state.stable_state_hash_hex(), peace_empty_hash);
}

#[test]
fn authority_roll_engagement_clears_when_target_dies_or_exceeds_slack_range() {
    let (_config, mut state) = roll_combat_test_state();
    state.tick = 100;
    super::combat_roll::queue_combat_action(&mut state, "player", "basic_shot", "roll-target")
        .unwrap();
    state.drain_due_combat_action_queues();
    assert_eq!(
        state
            .actors
            .get("player")
            .unwrap()
            .engagement_target_id
            .as_deref(),
        Some("roll-target")
    );

    state.actors.get_mut("roll-target").unwrap().life_state = AuthorityLifeState::Downed;
    state.tick = 101;
    state.drain_due_combat_action_queues();
    let shooter = state.actors.get("player").unwrap();
    assert!(shooter.engagement_target_id.is_none());
    assert_eq!(shooter.combat_queue.iter().count(), 0);

    state.actors.get_mut("roll-target").unwrap().life_state = AuthorityLifeState::Alive;
    super::combat_roll::queue_combat_action(&mut state, "player", "basic_shot", "roll-target")
        .unwrap();
    state.actors.get_mut("roll-target").unwrap().position = AuthorityPosition {
        x: 100_000,
        y: 10_000,
    };
    state.tick = 102;
    state.drain_due_combat_action_queues();
    assert!(state
        .actors
        .get("player")
        .unwrap()
        .engagement_target_id
        .is_none());
}

#[test]
fn authority_roll_aimed_shot_costs_action_and_rejects_when_short() {
    let (_config, mut state) = roll_combat_test_state();
    state.tick = 200;
    state.actors.get_mut("player").unwrap().vitals.action = 24;
    assert_eq!(
        super::combat_roll::queue_combat_action(&mut state, "player", "aimed_shot", "roll-target"),
        Err(AuthorityRejectReason::InsufficientAction)
    );

    state.actors.get_mut("player").unwrap().vitals.action = 25;
    super::combat_roll::queue_combat_action(&mut state, "player", "aimed_shot", "roll-target")
        .unwrap();
    state.drain_due_combat_action_queues();
    assert_eq!(state.actors.get("player").unwrap().vitals.action, 0);
}

#[test]
fn authority_roll_melee_queue_rejects_while_kneeling() {
    let (_config, mut state) = roll_combat_test_state();
    {
        let player = state.actors.get_mut("player").unwrap();
        player.equipped_weapon_id = Some(AuthorityWeaponId::Vibrosword);
        player.posture = AuthorityActorPosture::Kneeling;
    }
    grant_test_profession(&mut state, "player", AuthorityProfessionKind::Brawler);

    assert_eq!(
        super::combat_roll::queue_combat_action(&mut state, "player", "basic_shot", "roll-target"),
        Err(AuthorityRejectReason::MeleeWhileKneeling)
    );
    assert_eq!(
        state
            .actors
            .get("player")
            .unwrap()
            .combat_queue
            .iter()
            .count(),
        0
    );
}

#[test]
fn authority_roll_in_combat_bumps_attacker_and_victim_then_expires() {
    let (_config, mut state) = roll_combat_test_state();
    state.tick = 10;
    state.actors.get_mut("player").unwrap().posture = AuthorityActorPosture::Kneeling;
    super::combat_roll::queue_combat_action(&mut state, "player", "aimed_shot", "roll-target")
        .unwrap();
    assert_eq!(
        state.actor_snapshot("player").unwrap().in_combat,
        Some(true)
    );
    assert_eq!(state.actor_snapshot("roll-target").unwrap().in_combat, None);

    state.tick = 20;
    state.drain_due_combat_action_queues();
    assert_eq!(
        state.actor_snapshot("player").unwrap().in_combat,
        Some(true)
    );
    assert_eq!(
        state.actor_snapshot("roll-target").unwrap().in_combat,
        Some(true)
    );
    let expiry_tick = 20 + ms_to_ticks_round(8_000, state.tick_rate_hz);
    state.tick = expiry_tick;
    assert_eq!(
        state.actor_snapshot("player").unwrap().in_combat,
        Some(false)
    );
    assert_eq!(
        state.actor_snapshot("roll-target").unwrap().in_combat,
        Some(false)
    );
}

#[test]
fn authority_roll_queue_resolve_sequence_hash_is_deterministic() {
    fn run_once() -> String {
        let (_config, mut state) = roll_combat_test_state();
        state.tick = 300;
        super::combat_roll::queue_combat_action(&mut state, "player", "basic_shot", "roll-target")
            .unwrap();
        state.tick = 301;
        state.drain_due_combat_action_queues();
        state.stable_state_hash_hex()
    }

    assert_eq!(run_once(), run_once());
}

fn push_test_inventory_stack(
    state: &mut SliceAuthorityState,
    container: &str,
    item_id: u32,
    variant_id: u32,
    quantity: u32,
) -> u64 {
    let stack_id = state.next_inventory_stack_id(container);
    state
        .runtime
        .durable
        .inventory
        .push(InventoryStackSnapshot {
            stack_id,
            container: container.to_owned(),
            item: inventory_item_name(item_id)
                .unwrap_or("Test Item")
                .to_owned(),
            item_id,
            variant_id,
            quantity,
            reserved: 0,
            available: quantity,
        });
    stack_id
}

#[test]
fn authority_discard_stack_requires_exact_owned_unprotected_fingerprint() {
    let config = SliceAuthorityConfig::default();
    let mut state = SliceAuthorityState::from_snapshot(&crate::authority_test_slice()).unwrap();
    let player = config.player_actor_id.clone();
    let container = format!("{player}:field-pack");
    let stack_id = push_test_inventory_stack(&mut state, &container, 2_001, 77, 80);
    let before = state.stable_state_hash_hex();
    assert_eq!(
        state.apply_discard_stack(&config, &container, &stack_id.to_string(), 2_001, 78),
        Err(AuthorityRejectReason::ItemUnavailable)
    );
    assert_eq!(state.stable_state_hash_hex(), before);
    assert_eq!(
        state.apply_discard_stack(
            &config,
            "other:field-pack",
            &stack_id.to_string(),
            2_001,
            77
        ),
        Err(AuthorityRejectReason::ItemUnavailable)
    );
    assert_eq!(state.stable_state_hash_hex(), before);
    assert_eq!(
        state.apply_discard_stack(&config, &container, "stale", 2_001, 77),
        Err(AuthorityRejectReason::ItemUnavailable)
    );
    assert_eq!(state.stable_state_hash_hex(), before);
    state
        .apply_discard_stack(&config, &container, &stack_id.to_string(), 2_001, 77)
        .expect("exact carried stack is discarded atomically");
    assert!(!state.inventory.iter().any(|row| {
        row.container == container
            && row.stack_id == stack_id
            && row.item_id == 2_001
            && row.variant_id == 77
    }));

    let reserved_id = push_test_inventory_stack(&mut state, &container, 2_001, 78, 2);
    let reserved_row = state
        .inventory
        .iter_mut()
        .find(|row| {
            row.container == container
                && row.stack_id == reserved_id
                && row.item_id == 2_001
                && row.variant_id == 78
        })
        .unwrap();
    reserved_row.reserved = 1;
    reserved_row.available = 1;
    let before_reserved = state.stable_state_hash_hex();
    assert_eq!(
        state.apply_discard_stack(&config, &container, &reserved_id.to_string(), 2_001, 78),
        Err(AuthorityRejectReason::ItemUnavailable)
    );
    assert_eq!(state.stable_state_hash_hex(), before_reserved);

    let equipped_id = push_test_inventory_stack(&mut state, &container, 2_001, 79, 1);
    state
        .actors
        .get_mut(&player)
        .unwrap()
        .equipped_weapon_item_id = 2_001;
    let before_equipped = state.stable_state_hash_hex();
    assert_eq!(
        state.apply_discard_stack(&config, &container, &equipped_id.to_string(), 2_001, 79),
        Err(AuthorityRejectReason::ItemUnavailable)
    );
    assert_eq!(state.stable_state_hash_hex(), before_equipped);
}

#[test]
fn authority_discard_reconciles_the_last_exact_clothing_row() {
    let config = SliceAuthorityConfig::default();
    let mut state = SliceAuthorityState::from_snapshot(&crate::authority_test_slice()).unwrap();
    let actor_id = config.player_actor_id.clone();
    let container = format!("{actor_id}:field-pack");
    let variant_id = 60_000_105;
    let stack_id = push_test_inventory_stack(&mut state, &container, 7_201, variant_id, 1);
    {
        let actor = state.actors.get_mut(&actor_id).expect("player actor");
        actor.worn.clear();
        actor.equipped_clothing.clear();
        actor
            .worn_colors
            .insert("top_frayed_tunic".to_owned(), vec!["#765432".to_owned()]);
    }
    let equipped = state.apply_live_envelope(
        &config,
        command(
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

    let discarded = state.apply_live_envelope(
        &config,
        command(
            2,
            ClientCommand::DiscardStack {
                container: container.clone(),
                stack_id: stack_id.to_string(),
                item_id: 7_201,
                variant_id,
            },
        ),
    );
    assert_eq!(discarded.status, AuthorityCommandStatus::Accepted);
    assert!(state.actors[&actor_id].equipped_clothing.is_empty());
    assert!(state.actors[&actor_id].worn.is_empty());
    assert!(!state.inventory.iter().any(|row| {
        row.container == container
            && row.stack_id == stack_id
            && row.item_id == 7_201
            && row.variant_id == variant_id
    }));
}

#[test]
fn authority_melee_cadence_formula_floors_and_uses_crafted_speed() {
    assert_eq!(melee_attack_interval_ms(5_000, 0), 5_000);
    assert_eq!(melee_attack_interval_ms(5_000, 18), 4_100);
    assert_eq!(melee_attack_interval_ms(5_000, 36), 3_200);
    assert_eq!(melee_attack_interval_ms(5_000, 54), 2_300);
    assert_eq!(melee_attack_interval_ms(5_000, 72), 1_400);
    assert_eq!(melee_attack_interval_ms(5_000, 90), 1_000);
    assert_eq!(melee_attack_interval_ms(3_200, 90), 1_000);

    let (config, mut state) = roll_combat_test_state();
    let player = config.player_actor_id.clone();
    grant_test_profession(&mut state, &player, AuthorityProfessionKind::Brawler);
    let crafted_speed_variant = encode_melee_weapon_speed_variant_ms(3_200);
    {
        let actor = state.actors.get_mut(&player).expect("test player exists");
        actor.equipped_weapon_id = Some(AuthorityWeaponId::Vibrosword);
        actor.equipped_weapon_item_id = PLASMA_SWORD_ITEM_ID;
        actor.equipped_weapon_variant_id = crafted_speed_variant;
    }
    push_test_inventory_stack(
        &mut state,
        "player:field-pack",
        PLASMA_SWORD_ITEM_ID,
        crafted_speed_variant,
        1,
    );

    let actor = state.actors.get(&player).expect("test player exists");
    let weapon = weapon_profile(Some(AuthorityWeaponId::Vibrosword));
    assert_eq!(
        state.melee_weapon_base_attack_speed_ms_for_actor(actor, weapon),
        3_200,
        "plasma sword item variant should override the stock vibrosword base speed"
    );
    assert_eq!(
        actor.professions.brawler_melee_speed_points(),
        BRAWLER_NOVICE_MELEE_SPEED_POINTS
    );
    assert_eq!(
        state.melee_attack_interval_ms_for_actor(actor, weapon),
        2_880
    );
    assert_eq!(
        state.melee_attack_interval_ticks_for_actor(actor, weapon),
        86,
        "crafted 3.2s novice swing should apply the +10 Brawler head start before tick rounding"
    );

    let master = state.actors.get_mut(&player).expect("test player exists");
    for skill_box_id in [
        "brawler-attack-speed-i",
        "brawler-attack-speed-ii",
        "brawler-attack-speed-iii",
        "brawler-attack-speed-iv",
        "brawler-master",
    ] {
        master
            .professions
            .skill_boxes
            .insert(skill_box_id.to_owned());
    }
    let master = state.actors.get(&player).expect("test player exists");
    assert_eq!(master.professions.brawler_melee_speed_points(), 90);
    assert_eq!(
        state.melee_attack_interval_ms_for_actor(master, weapon),
        MELEE_MIN_ATTACK_INTERVAL_MS,
        "crafted fast bases still clamp at the pre-tick 1s floor"
    );
}

#[test]
fn authority_brawler_speed_tracks_scale_movement_and_attack_tempo() {
    let (config, mut state) = roll_combat_test_state();
    let player = config.player_actor_id.clone();
    grant_test_profession(&mut state, &player, AuthorityProfessionKind::Brawler);
    {
        let brawler = state.actors.get_mut(&player).expect("test player exists");
        brawler.equipped_weapon_id = Some(AuthorityWeaponId::Vibrosword);
        brawler.slugthrower_magazine.loaded_rounds = 0;
    }
    state
        .actors
        .get_mut("roll-target")
        .expect("roll target exists")
        .vitals
        .health = 100_000;
    state.tick = 100;

    let novice = state
        .actors
        .get(&player)
        .expect("test player exists")
        .clone();
    let novice_movement_multiplier = movement_speed_multiplier_milli_for_actor(&novice);
    let novice_speed_points = novice.professions.brawler_melee_speed_points();
    assert_eq!(
        novice_speed_points, BRAWLER_NOVICE_MELEE_SPEED_POINTS,
        "novice Brawler should get the small melee speed head start"
    );
    super::combat_roll::queue_combat_action(&mut state, &player, "basic_shot", "roll-target")
        .unwrap();
    state.drain_due_combat_action_queues();
    let novice_next_ready_tick = state
        .actors
        .get(&player)
        .expect("test player exists")
        .combat_queue
        .next_ready_tick;
    let novice_attack_ticks = novice_next_ready_tick.saturating_sub(100);
    let expected_novice_ticks = ms_to_ticks_round(
        melee_attack_interval_ms(
            MELEE_STOCK_ATTACK_SPEED_MS,
            BRAWLER_NOVICE_MELEE_SPEED_POINTS,
        ),
        state.tick_rate_hz,
    )
    .max(1);
    assert_eq!(
        novice_attack_ticks, expected_novice_ticks,
        "stock novice melee cadence should be 4.5s/135 ticks at 30Hz"
    );

    {
        let brawler = state.actors.get_mut(&player).expect("test player exists");
        for skill_box_id in [
            "brawler-movement-speed-i",
            "brawler-movement-speed-ii",
            "brawler-movement-speed-iii",
            "brawler-movement-speed-iv",
            "brawler-attack-speed-i",
            "brawler-attack-speed-ii",
            "brawler-attack-speed-iii",
            "brawler-attack-speed-iv",
            "brawler-master",
        ] {
            brawler
                .professions
                .skill_boxes
                .insert(skill_box_id.to_owned());
        }
    }

    state.tick = novice_next_ready_tick;
    state.drain_due_combat_action_queues();
    let trained = state.actors.get(&player).expect("test player exists");
    let trained_speed_points = trained.professions.brawler_melee_speed_points();
    let trained_attack_ticks = trained
        .combat_queue
        .next_ready_tick
        .saturating_sub(novice_next_ready_tick);
    assert!(
        movement_speed_multiplier_milli_for_actor(trained) > novice_movement_multiplier,
        "movement-speed boxes should increase Brawler movement"
    );
    assert_eq!(
        trained_speed_points, BRAWLER_MELEE_SPEED_POINTS_CAP,
        "four attack-speed boxes plus master should still cap at +90 melee speed points"
    );
    assert!(
        trained_attack_ticks.saturating_mul(4) <= novice_attack_ticks,
        "trained attack-speed boxes should still beat the boofed novice cadence from novice={novice_attack_ticks} ticks to trained={trained_attack_ticks} ticks"
    );
    assert_eq!(
        trained_attack_ticks,
        ms_to_ticks_round(MELEE_MIN_ATTACK_INTERVAL_MS, state.tick_rate_hz).max(1),
        "master Brawler should land on the 1s floor at 30Hz"
    );
}

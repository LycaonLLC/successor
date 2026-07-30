#[test]
fn authority_skirmisher_contact_approach_closes_just_outside_range_deterministically() {
    let mut snapshot = crate::authority_test_slice();
    add_test_factions(&mut snapshot);
    snapshot.actors.clear();
    snapshot.npc_jobs.clear();
    snapshot.props.clear();
    snapshot.blocked_cells.clear();
    snapshot.actors.push(test_actor(
        "red-contact-approach",
        "Red Contact Approach",
        "skirmisher",
        CellSnapshot::new(10, 20),
        "right",
    ));
    snapshot.actors.push(test_actor(
        "blue-contact-target",
        "Blue Contact Target",
        "skirmisher",
        CellSnapshot::new(40, 20),
        "left",
    ));
    let mut state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    place_actor_at_position(
        &mut state,
        "red-contact-approach",
        AuthorityPosition {
            x: 10_000,
            y: 20_000,
        },
    );
    place_actor_at_position(
        &mut state,
        "blue-contact-target",
        AuthorityPosition {
            x: 40_500,
            y: 20_000,
        },
    );
    let actor = state.actors.get("red-contact-approach").unwrap().clone();
    let target = state.actors.get("blue-contact-target").unwrap().clone();
    let profile = skirmisher_profile_for_ai_state(&actor);
    let start_gap = position_distance_milli(actor.position, target.position);
    assert!(start_gap > profile.max_range_milli);
    assert!(start_gap <= profile.max_range_milli.saturating_add(1_500));

    let first = state
        .skirmisher_contact_approach_position(
            &actor,
            &target,
            profile,
            None,
            &SkirmisherReservations::default(),
        )
        .expect("just-outside target must produce a direct attack-band approach");
    let second = state
        .skirmisher_contact_approach_position(
            &actor,
            &target,
            profile,
            None,
            &SkirmisherReservations::default(),
        )
        .expect("repeat approach must remain available");
    assert_eq!(first, second, "approach selection must be deterministic");
    let destination_gap = position_distance_milli(first, target.position);
    assert!(destination_gap >= profile.min_range_milli);
    assert!(destination_gap <= profile.max_range_milli);
    assert!(state.ai_tactical_candidate_reachable(&actor, first));
    assert!(state.ai_destination_available(&actor, first, &SkirmisherReservations::default()));
}

#[test]
fn authority_skirmisher_contact_approach_skips_blocked_slot() {
    let mut snapshot = crate::authority_test_slice();
    add_test_factions(&mut snapshot);
    snapshot.actors.clear();
    snapshot.npc_jobs.clear();
    snapshot.props.clear();
    snapshot.blocked_cells.clear();
    snapshot.actors.push(test_actor(
        "red-blocked-approach",
        "Red Blocked Approach",
        "skirmisher",
        CellSnapshot::new(10, 20),
        "right",
    ));
    snapshot.actors.push(test_actor(
        "blue-blocked-target",
        "Blue Blocked Target",
        "skirmisher",
        CellSnapshot::new(40, 20),
        "left",
    ));
    let mut state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    place_actor_at_position(
        &mut state,
        "red-blocked-approach",
        AuthorityPosition {
            x: 10_000,
            y: 20_000,
        },
    );
    place_actor_at_position(
        &mut state,
        "blue-blocked-target",
        AuthorityPosition {
            x: 40_500,
            y: 20_000,
        },
    );
    let actor = state.actors.get("red-blocked-approach").unwrap().clone();
    let target = state.actors.get("blue-blocked-target").unwrap().clone();
    let profile = skirmisher_profile_for_ai_state(&actor);
    let open = state
        .skirmisher_contact_approach_position(
            &actor,
            &target,
            profile,
            None,
            &SkirmisherReservations::default(),
        )
        .expect("open lane should produce an approach");
    state.blocked_cells.insert(CellKey::new(
        crate::AUTHORITY_TEST_AREA_ID,
        open.cell().x,
        open.cell().y,
    ));
    let alternate = state
        .skirmisher_contact_approach_position(
            &actor,
            &target,
            profile,
            None,
            &SkirmisherReservations::default(),
        )
        .expect("blocked preferred slot should fall back to another safe slot");
    assert_ne!(alternate, open);
    assert!(!state.ai_position_blocked(&actor.area_id, alternate));
    assert!(state.ai_tactical_candidate_reachable(&actor, alternate));
    let alternate_gap = position_distance_milli(alternate, target.position);
    assert!(alternate_gap >= profile.min_range_milli);
    assert!(alternate_gap <= profile.max_range_milli);
}

#[test]
fn authority_skirmisher_no_shot_deadband_closes_toward_contact() {
    let mut snapshot = crate::authority_test_slice();
    add_test_factions(&mut snapshot);
    snapshot.actors.clear();
    snapshot.npc_jobs.clear();
    snapshot.props.clear();
    snapshot.blocked_cells.clear();
    snapshot.actors.push(test_actor(
        "red-no-shot-deadband",
        "Red No Shot Deadband",
        "skirmisher",
        CellSnapshot::new(10, 20),
        "right",
    ));
    snapshot.actors.push(test_actor(
        "blue-no-shot-target",
        "Blue No Shot Target",
        "skirmisher",
        CellSnapshot::new(40, 20),
        "left",
    ));
    let mut state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    place_actor_at_position(
        &mut state,
        "red-no-shot-deadband",
        AuthorityPosition {
            x: 10_000,
            y: 20_000,
        },
    );
    place_actor_at_position(
        &mut state,
        "blue-no-shot-target",
        AuthorityPosition {
            x: 40_500,
            y: 20_000,
        },
    );
    state
        .blocked_cells
        .insert(CellKey::new(crate::AUTHORITY_TEST_AREA_ID, 25, 20));
    let before = state.actors.get("red-no-shot-deadband").unwrap().position;
    let target = state.actors.get("blue-no-shot-target").unwrap().clone();
    let actor = state.actors.get("red-no-shot-deadband").unwrap().clone();
    let profile = skirmisher_profile_for_ai_state(&actor);
    let start_gap = position_distance_milli(before, target.position);
    assert!(!state.skirmisher_can_fire_at(&actor, &target, profile));
    let destination = state
        .skirmisher_contact_approach_position(
            &actor,
            &target,
            profile,
            None,
            &SkirmisherReservations::default(),
        )
        .expect("occluded no-shot target in max..max+1_500 deadband must close");
    assert!(state.move_ai_actor_toward_position_pathing(
        "red-no-shot-deadband",
        destination,
        2_000
    ));
    let after = state.actors.get("red-no-shot-deadband").unwrap().position;
    let end_gap = position_distance_milli(after, target.position);
    assert!(
        end_gap < start_gap,
        "occluded no-shot target in max..max+1_500 deadband must still close ({start_gap} -> {end_gap})"
    );
}

#[test]
fn authority_skirmisher_direct_contact_approach_refuses_target_return_fire() {
    let mut snapshot = crate::authority_test_slice();
    add_test_factions(&mut snapshot);
    snapshot.actors.clear();
    snapshot.npc_jobs.clear();
    snapshot.props.clear();
    snapshot.blocked_cells.clear();
    snapshot.actors.push(test_actor(
        "red-short-range",
        "Red Short Range",
        "skirmisher",
        CellSnapshot::new(10, 20),
        "right",
    ));
    snapshot.actors.push(test_actor(
        "blue-long-range",
        "Blue Long Range",
        "skirmisher",
        CellSnapshot::new(40, 20),
        "left",
    ));
    let mut state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    place_actor_at_position(
        &mut state,
        "red-short-range",
        AuthorityPosition {
            x: 10_000,
            y: 20_000,
        },
    );
    place_actor_at_position(
        &mut state,
        "blue-long-range",
        AuthorityPosition {
            x: 40_500,
            y: 20_000,
        },
    );
    state
        .actors
        .get_mut("red-short-range")
        .unwrap()
        .equipped_weapon_id = Some(AuthorityWeaponId::Vibrosword);
    {
        let target = state.actors.get_mut("blue-long-range").unwrap();
        target.equipped_weapon_id = Some(AuthorityWeaponId::Slugthrower);
        target.slugthrower_magazine.loaded_rounds = SLUGTHROWER_MAGAZINE_SIZE;
        target.slugthrower_magazine.reload_until_tick = 0;
    }

    let actor = state.actors.get("red-short-range").unwrap();
    let target = state.actors.get("blue-long-range").unwrap();
    assert!(!state.skirmisher_can_fire_at(actor, target, skirmisher_profile_for_ai_state(actor),));
    assert!(state.skirmisher_can_fire_at(target, actor, skirmisher_profile_for_ai_state(target),));
    assert!(
        !ai::direct_contact_approach_allowed(false, false, false, true, false),
        "direct contact fallback must not close while the target can return fire",
    );
    assert!(
        ai::direct_contact_approach_allowed(false, false, false, false, false),
        "an otherwise safe no-shot contact must still be allowed to close",
    );
}

#[test]
fn authority_skirmisher_avoids_suicidal_melee_charge_under_return_fire() {
    let mut snapshot = crate::authority_test_slice();
    add_test_factions(&mut snapshot);
    snapshot.actors.clear();
    snapshot.npc_jobs.clear();
    snapshot.props.clear();
    snapshot.blocked_cells.clear();
    snapshot.actors.push(test_actor(
        "red-contact-flow",
        "Red Contact Flow",
        "skirmisher_brawler",
        CellSnapshot::new(10, 20),
        "right",
    ));
    snapshot.actors.push(test_actor(
        "blue-contact-flow",
        "Blue Contact Flow",
        "skirmisher",
        CellSnapshot::new(40, 20),
        "left",
    ));

    let mut state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    state.tick = 100;
    place_actor_at_position(
        &mut state,
        "red-contact-flow",
        AuthorityPosition {
            x: 10_000,
            y: 20_000,
        },
    );
    place_actor_at_position(
        &mut state,
        "blue-contact-flow",
        AuthorityPosition {
            x: 40_500,
            y: 20_000,
        },
    );
    state
        .actors
        .get_mut("red-contact-flow")
        .unwrap()
        .equipped_weapon_id = Some(AuthorityWeaponId::Vibrosword);
    {
        let target = state.actors.get_mut("blue-contact-flow").unwrap();
        target.equipped_weapon_id = Some(AuthorityWeaponId::Slugthrower);
        target.slugthrower_magazine.loaded_rounds = SLUGTHROWER_MAGAZINE_SIZE;
        target.slugthrower_magazine.reload_until_tick = 0;
    }

    let actor = state.actors.get("red-contact-flow").unwrap().clone();
    let mut ai = match actor.ai.clone().expect("red actor has skirmisher AI") {
        AuthorityAiState::Skirmisher(ai) => ai,
        _ => panic!("red actor should use skirmisher AI"),
    };
    ai.next_update_tick = 0;
    ai.last_update_tick = 0;
    let reservations = state.skirmisher_reservations();
    let moved =
        state.advance_skirmisher_ai("red-contact-flow", &actor, &mut ai, None, &reservations);
    let blocked_debug = state
        .ai_debug_snapshot()
        .actors
        .into_iter()
        .find(|row| row.actor_id == "red-contact-flow")
        .expect("production AI records the blocked decision");

    assert!(
        !moved,
        "return fire must block the melee direct-contact fallback: {blocked_debug:?}"
    );
    assert_eq!(
        state.actors["red-contact-flow"].position, actor.position,
        "the short-range actor must not advance into a target's live firing lane"
    );
    assert!(
        ai.target.is_none(),
        "the melee skirmisher must not retain an unsafe contact target"
    );
    assert_eq!(blocked_debug.reason, "melee_hold_return_fire");

    state
        .actors
        .get_mut("blue-contact-flow")
        .unwrap()
        .equipped_weapon_id = Some(AuthorityWeaponId::Unarmed);
    ai.next_update_tick = state.tick;
    ai.last_update_tick = 0;
    let safe_actor = state.actors.get("red-contact-flow").unwrap().clone();
    let moved_without_return_fire = state.advance_skirmisher_ai(
        "red-contact-flow",
        &safe_actor,
        &mut ai,
        None,
        &reservations,
    );
    let safe_debug = state
        .ai_debug_snapshot()
        .actors
        .into_iter()
        .rev()
        .find(|row| row.actor_id == "red-contact-flow")
        .expect("production AI records the safe advance");
    assert!(
        moved_without_return_fire,
        "the same no-shot geometry must close when the target cannot return fire"
    );
    assert_eq!(safe_debug.reason, "melee_advance");
    assert!(
        state.actors["red-contact-flow"].position.x > safe_actor.position.x,
        "safe fallback movement must reduce the contact gap"
    );
}

fn gaia_danger_test_state(
    creature_id: &str,
    creature_sprite: &str,
    creature_cell: CellSnapshot,
    extra_players: &[(&str, CellSnapshot)],
) -> (SliceAuthorityConfig, SliceAuthorityState) {
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
    for (id, cell) in extra_players {
        snapshot
            .actors
            .push(test_actor(id, id, "player", cell.clone(), "left"));
    }
    let mut creature = test_actor(creature_id, creature_id, "creature", creature_cell, "front");
    creature.sprite = creature_sprite.to_owned();
    snapshot.actors.push(creature);
    add_test_factions(&mut snapshot);
    let config = SliceAuthorityConfig {
        player_actor_id: "player".to_owned(),
        ..SliceAuthorityConfig::default()
    };
    let state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    (config, state)
}

#[test]
fn authority_gaia_passive_species_never_engage() {
    for sprite in [
        "creature-snufflefin-adult",
        "creature-pocketclod-adult",
        "creature-mossmuff-adult",
        "creature-dapplepod-adult",
    ] {
        let (config, mut state) =
            gaia_danger_test_state("passive-wildlife", sprite, CellSnapshot::new(11, 10), &[]);
        place_actor_at_position(
            &mut state,
            "player",
            AuthorityPosition {
                x: 11_000,
                y: 10_000,
            },
        );
        place_actor_at_position(
            &mut state,
            "passive-wildlife",
            AuthorityPosition {
                x: 12_000,
                y: 10_000,
            },
        );
        state.provoke_creature_retaliation("passive-wildlife", "player");
        state.advance_ticks_for_observer(&config, 8);
        let creature = state.actors.get("passive-wildlife").unwrap();
        assert!(
            !actor_will_auto_aggro(creature),
            "{sprite} must stay yellow"
        );
        assert_eq!(creature.engagement_target_id, None);
        assert_eq!(creature.shots_fired, 0);
        match creature.ai.as_ref() {
            Some(AuthorityAiState::PassiveCreature(ai)) => {
                assert_ne!(ai.mode, PassiveCreatureMode::Engage, "{sprite}");
                assert!(ai.threat_actor_id.is_none(), "{sprite}");
            }
            other => panic!("expected passive creature ai, got {other:?}"),
        }
        assert!(!state.can_actor_attack(creature, state.actors.get("player").unwrap()));
    }
}

#[test]
fn authority_gaia_danger_pebblehorn_retaliates_after_player_damage() {
    let (config, mut state) = gaia_danger_test_state(
        "pebblehorn",
        "creature-pebblehorn-adult",
        CellSnapshot::new(12, 10),
        &[],
    );
    place_actor_at_position(
        &mut state,
        "player",
        AuthorityPosition {
            x: 12_000,
            y: 10_000,
        },
    );
    place_actor_at_position(
        &mut state,
        "pebblehorn",
        AuthorityPosition {
            x: 13_000,
            y: 10_000,
        },
    );
    // Deterministic contact damage: player dodge would otherwise eat every strike.
    state
        .actors
        .get_mut("player")
        .unwrap()
        .effective_stats
        .dodge_chance_milli = 0;
    {
        let creature = state.actors.get("pebblehorn").unwrap();
        assert!(!actor_will_auto_aggro(creature));
        assert!(!state.can_actor_attack(creature, state.actors.get("player").unwrap()));
    }
    state.provoke_creature_retaliation("pebblehorn", "player");
    {
        let creature = state.actors.get("pebblehorn").unwrap();
        assert_eq!(creature.engagement_target_id.as_deref(), Some("player"));
        match creature.ai.as_ref() {
            Some(AuthorityAiState::PassiveCreature(ai)) => {
                assert_eq!(ai.mode, PassiveCreatureMode::Engage);
                assert_eq!(ai.threat_actor_id.as_deref(), Some("player"));
            }
            other => panic!("expected engage ai, got {other:?}"),
        }
        assert!(state.can_actor_attack(creature, state.actors.get("player").unwrap()));
    }
    let health_before = state.actors.get("player").unwrap().vitals.health;
    let mut saw_damaging_event = false;
    for _ in 0..120 {
        // advance_ticks drains pending_combat_events into the returned vec.
        let events = state.advance_ticks_for_observer(&config, 1);
        if events.iter().any(|event| {
            event.shooter_actor_id == "pebblehorn"
                && event.target_actor_id == "player"
                && event.damage > 0
        }) {
            saw_damaging_event = true;
            break;
        }
    }
    assert!(
        saw_damaging_event,
        "pebblehorn should emit damaging melee combat events after provocation"
    );
    let health_after = state.actors.get("player").unwrap().vitals.health;
    assert!(
        health_after < health_before,
        "retaliation must damage the player"
    );
    assert!(
        state.actors.get("pebblehorn").unwrap().shots_fired > 0,
        "retaliation path must count creature strikes"
    );
}

#[test]
fn authority_gaia_danger_bellback_proactively_acquires_nearby_player() {
    let (config, mut state) = gaia_danger_test_state(
        "bellback",
        "creature-bellback-adult",
        CellSnapshot::new(12, 10),
        &[],
    );
    place_actor_at_position(
        &mut state,
        "player",
        AuthorityPosition {
            x: 12_500,
            y: 10_000,
        },
    );
    place_actor_at_position(
        &mut state,
        "bellback",
        AuthorityPosition {
            x: 13_000,
            y: 10_000,
        },
    );
    {
        let creature = state.actors.get("bellback").unwrap();
        assert!(actor_will_auto_aggro(creature), "bellback is proactive red");
    }
    state.advance_ticks_for_observer(&config, 6);
    let creature = state.actors.get("bellback").unwrap();
    assert_eq!(creature.engagement_target_id.as_deref(), Some("player"));
    match creature.ai.as_ref() {
        Some(AuthorityAiState::PassiveCreature(ai)) => {
            assert_eq!(ai.mode, PassiveCreatureMode::Engage);
            assert_eq!(ai.threat_actor_id.as_deref(), Some("player"));
        }
        other => panic!("expected engage ai, got {other:?}"),
    }
}

#[test]
fn authority_gaia_danger_target_ties_break_by_actor_id() {
    let (_config, mut state) = gaia_danger_test_state(
        "bellback",
        "creature-bellback-adult",
        CellSnapshot::new(20, 20),
        &[
            ("player-b", CellSnapshot::new(21, 20)),
            ("player-a", CellSnapshot::new(21, 20)),
        ],
    );
    let origin = AuthorityPosition {
        x: 20_000,
        y: 20_000,
    };
    place_actor_at_position(&mut state, "bellback", origin);
    place_actor_at_position(
        &mut state,
        "player-a",
        AuthorityPosition {
            x: 24_000,
            y: 20_000,
        },
    );
    place_actor_at_position(
        &mut state,
        "player-b",
        AuthorityPosition {
            x: 24_000,
            y: 20_000,
        },
    );
    place_actor_at_position(
        &mut state,
        "player",
        AuthorityPosition {
            x: 80_000,
            y: 80_000,
        },
    );
    let creature = state.actors.get("bellback").unwrap().clone();
    let chosen = state
        .nearest_creature_hostile_player(&creature, CREATURE_DETECT_RADIUS_MILLI_CELLS)
        .expect("should find a player");
    assert_eq!(chosen.id, "player-a");
}

#[test]
fn authority_gaia_danger_respects_range_and_attack_cooldown() {
    let (config, mut state) = gaia_danger_test_state(
        "bellback",
        "creature-bellback-adult",
        CellSnapshot::new(12, 10),
        &[],
    );
    place_actor_at_position(
        &mut state,
        "bellback",
        AuthorityPosition {
            x: 12_000,
            y: 10_000,
        },
    );
    place_actor_at_position(
        &mut state,
        "player",
        AuthorityPosition {
            x: 12_000 + CREATURE_DETECT_RADIUS_MILLI_CELLS + 2_000,
            y: 10_000,
        },
    );
    state.advance_ticks_for_observer(&config, 5);
    {
        let creature = state.actors.get("bellback").unwrap();
        assert_eq!(creature.engagement_target_id, None);
    }
    place_actor_at_position(
        &mut state,
        "player",
        AuthorityPosition {
            x: 12_500,
            y: 10_000,
        },
    );
    state.advance_ticks_for_observer(&config, 4);
    let mut first_shot_tick = None;
    let mut second_shot_tick = None;
    for _ in 0..120 {
        let before = state.actors.get("bellback").unwrap().shots_fired;
        state.pending_combat_events.clear();
        state.advance_ticks_for_observer(&config, 1);
        let after = state.actors.get("bellback").unwrap().shots_fired;
        if after > before {
            if first_shot_tick.is_none() {
                first_shot_tick = Some(state.tick);
            } else {
                second_shot_tick = Some(state.tick);
                break;
            }
        }
    }
    let first = first_shot_tick.expect("first strike");
    let second = second_shot_tick.expect("second strike");
    let min_gap = ms_to_ticks_round(CREATURE_ATTACK_INTERVAL_MS, state.tick_rate_hz).max(1);
    assert!(
        second.saturating_sub(first) >= min_gap,
        "attack cadence must honor cooldown: first={first} second={second} min_gap={min_gap}"
    );
}

#[test]
fn authority_gaia_danger_leash_and_escape_disengage() {
    let (config, mut state) = gaia_danger_test_state(
        "pebblehorn",
        "creature-pebblehorn-adult",
        CellSnapshot::new(10, 10),
        &[],
    );
    place_actor_at_position(
        &mut state,
        "pebblehorn",
        AuthorityPosition {
            x: 10_000,
            y: 10_000,
        },
    );
    place_actor_at_position(
        &mut state,
        "player",
        AuthorityPosition {
            x: 11_000,
            y: 10_000,
        },
    );
    state.provoke_creature_retaliation("pebblehorn", "player");
    // Drag far past leash without rewriting home_cell (place_actor_at_position
    // would rebase home and defeat the leash check).
    {
        let creature = state.actors.get_mut("pebblehorn").unwrap();
        creature.position = AuthorityPosition {
            x: 10_000 + CREATURE_LEASH_RADIUS_MILLI_CELLS + 1_000,
            y: 10_000,
        };
        creature.cell = creature.position.cell();
    }
    {
        let player = state.actors.get_mut("player").unwrap();
        player.position = AuthorityPosition {
            x: 10_000 + CREATURE_LEASH_RADIUS_MILLI_CELLS + 1_500,
            y: 10_000,
        };
        player.cell = player.position.cell();
    }
    state.advance_ticks_for_observer(&config, 3);
    let creature = state.actors.get("pebblehorn").unwrap();
    assert_eq!(creature.engagement_target_id, None);
    match creature.ai.as_ref() {
        Some(AuthorityAiState::PassiveCreature(ai)) => {
            assert_eq!(ai.mode, PassiveCreatureMode::Flee);
            assert!(ai.threat_actor_id.is_none());
        }
        other => panic!("expected flee after leash break, got {other:?}"),
    }
}

#[test]
fn authority_gaia_danger_rejects_invalid_targets() {
    let (_config, mut state) = gaia_danger_test_state(
        "pebblehorn",
        "creature-pebblehorn-adult",
        CellSnapshot::new(12, 10),
        &[("other-player", CellSnapshot::new(13, 10))],
    );
    place_actor_at_position(
        &mut state,
        "pebblehorn",
        AuthorityPosition {
            x: 12_000,
            y: 10_000,
        },
    );
    place_actor_at_position(
        &mut state,
        "player",
        AuthorityPosition {
            x: 12_500,
            y: 10_000,
        },
    );
    state.actors.get_mut("player").unwrap().life_state = AuthorityLifeState::Downed;
    state.provoke_creature_retaliation("pebblehorn", "player");
    assert_eq!(
        state.actors.get("pebblehorn").unwrap().engagement_target_id,
        None
    );
    state.actors.get_mut("player").unwrap().life_state = AuthorityLifeState::Alive;
    state.actors.get_mut("player").unwrap().link_dead = true;
    state.provoke_creature_retaliation("pebblehorn", "player");
    assert_eq!(
        state.actors.get("pebblehorn").unwrap().engagement_target_id,
        None
    );
    state.actors.get_mut("player").unwrap().link_dead = false;

    let mut tmp = crate::authority_test_slice();
    tmp.actors.clear();
    tmp.npc_jobs.clear();
    tmp.actors.push(test_actor(
        "neutral-npc",
        "Neutral",
        "skirmisher_brawler",
        CellSnapshot::new(12, 11),
        "left",
    ));
    add_test_factions(&mut tmp);
    let npc_state = SliceAuthorityState::from_snapshot(&tmp).unwrap();
    let npc_actor = npc_state.actors.values().next().unwrap().clone();
    state.actors.insert(npc_actor.id.clone(), npc_actor);
    state.provoke_creature_retaliation("pebblehorn", "neutral-npc");
    assert_eq!(
        state.actors.get("pebblehorn").unwrap().engagement_target_id,
        None
    );

    state.actors.get_mut("other-player").unwrap().area_id = "other-area".to_owned();
    state.provoke_creature_retaliation("pebblehorn", "other-player");
    assert_eq!(
        state.actors.get("pebblehorn").unwrap().engagement_target_id,
        None
    );
}

#[test]
fn authority_gaia_danger_death_corpse_respawn_and_harvest_continue() {
    let (config, mut state) = gaia_danger_test_state(
        "pebblehorn",
        "creature-pebblehorn-adult",
        CellSnapshot::new(12, 10),
        &[],
    );
    place_actor_at_position(
        &mut state,
        "player",
        AuthorityPosition {
            x: 12_000,
            y: 10_000,
        },
    );
    place_actor_at_position(
        &mut state,
        "pebblehorn",
        AuthorityPosition {
            x: 12_400,
            y: 10_000,
        },
    );
    state.provoke_creature_retaliation("pebblehorn", "player");
    // Force a deterministic corpse, then follow the authority corpse timer
    // deadlines (body vanish -> hidden respawn), same as passive creature tests.
    let start_tick = state.tick;
    let tick_rate_hz = state.tick_rate_hz;
    let body_vanish_tick = {
        let creature = state.actors.get_mut("pebblehorn").unwrap();
        creature.vitals.health = 0;
        SliceAuthorityState::kill_actor_for_respawn(start_tick, tick_rate_hz, creature);
        assert_eq!(creature.life_state, AuthorityLifeState::Downed);
        assert!(creature.body_vanish_tick > start_tick);
        creature.body_vanish_tick
    };
    state.finalize_actor_corpse_after_death("pebblehorn", start_tick);
    {
        let dead = state.actors.get("pebblehorn").unwrap();
        assert_eq!(dead.life_state, AuthorityLifeState::Downed);
        assert!(is_harvestable_creature_actor(dead));
        assert!(dead.body_vanish_tick > 0);
    }
    let body_vanish_delta = body_vanish_tick
        .saturating_sub(state.tick())
        .saturating_add(1);
    advance_ticks_unclamped(&mut state, &config, body_vanish_delta);
    let respawn_tick = {
        let hidden = state.actors.get("pebblehorn").unwrap();
        assert_eq!(hidden.life_state, AuthorityLifeState::Respawning);
        assert!(hidden.respawn_tick > state.tick());
        hidden.respawn_tick
    };
    let respawn_delta = respawn_tick.saturating_sub(state.tick()).saturating_add(1);
    advance_ticks_unclamped(&mut state, &config, respawn_delta);
    let respawned = state.actors.get("pebblehorn").unwrap();
    assert_eq!(respawned.life_state, AuthorityLifeState::Alive);
    match respawned.ai.as_ref() {
        Some(AuthorityAiState::PassiveCreature(ai)) => {
            assert_ne!(ai.mode, PassiveCreatureMode::Engage);
            assert!(ai.threat_actor_id.is_none());
        }
        other => panic!("respawned creature should restore calm passive AI, got {other:?}"),
    }
}

#[test]
fn authority_gaia_danger_export_import_preserves_engage_state() {
    let (_config, mut state) = gaia_danger_test_state(
        "pebblehorn",
        "creature-pebblehorn-adult",
        CellSnapshot::new(12, 10),
        &[],
    );
    place_actor_at_position(
        &mut state,
        "player",
        AuthorityPosition {
            x: 12_000,
            y: 10_000,
        },
    );
    place_actor_at_position(
        &mut state,
        "pebblehorn",
        AuthorityPosition {
            x: 12_400,
            y: 10_000,
        },
    );
    state.provoke_creature_retaliation("pebblehorn", "player");
    let before_hash = state.stable_state_hash_hex();
    let blob = state.export_checkpoint();
    let restored = restore_checkpoint_for_test(&state, blob);
    assert_eq!(restored.stable_state_hash_hex(), before_hash);
    let creature = restored.actors.get("pebblehorn").unwrap();
    match creature.ai.as_ref() {
        Some(AuthorityAiState::PassiveCreature(ai)) => {
            assert_eq!(ai.mode, PassiveCreatureMode::Engage);
            assert_eq!(ai.threat_actor_id.as_deref(), Some("player"));
            assert!(ai.chase_until_tick > 0);
        }
        other => panic!("expected restored engage state, got {other:?}"),
    }
}

fn gaia_danger_unarmored_player_setup(
    creature_id: &str,
    creature_sprite: &str,
    creature_cell: CellSnapshot,
    player_pos: AuthorityPosition,
    creature_pos: AuthorityPosition,
) -> (SliceAuthorityConfig, SliceAuthorityState) {
    let (config, mut state) =
        gaia_danger_test_state(creature_id, creature_sprite, creature_cell, &[]);
    place_actor_at_position(&mut state, "player", player_pos);
    place_actor_at_position(&mut state, creature_id, creature_pos);
    // Standing unarmored starter: no weapon, no dodge, full default health.
    {
        let player = state.actors.get_mut("player").unwrap();
        player.equipped_weapon_id = None;
        player.equipped_weapon_item_id = 0;
        player.equipped_weapon_variant_id = 0;
        player.effective_stats.dodge_chance_milli = 0;
        player.vitals.health = DEFAULT_HEALTH;
        player.max_vitals.health = DEFAULT_HEALTH;
        assert!(
            player.personal_shield.is_none(),
            "starter unarmored player must not start with a personal shield"
        );
    }
    // Creature keeps wildlife role + no weapon slot (uses CREATURE_MELEE_BASE_DAMAGE).
    {
        let creature = state.actors.get_mut(creature_id).unwrap();
        creature.equipped_weapon_id = None;
        creature.equipped_weapon_item_id = 0;
        creature.equipped_weapon_variant_id = 0;
    }
    (config, state)
}

/// Shared live-tick encounter runner: engage, then advance until downed or timeout.
fn run_gaia_danger_standing_encounter(
    config: &SliceAuthorityConfig,
    state: &mut SliceAuthorityState,
    creature_id: &str,
    max_ticks: u64,
) -> (u32, u64, i32, AuthorityLifeState, u64) {
    let start_tick = state.runtime.durable.tick;
    let health_before = state
        .runtime
        .durable
        .actors
        .get("player")
        .unwrap()
        .vitals
        .health;
    let mut damaging_hits = 0_u32;
    let mut first_damage_tick = None;
    let mut down_tick = None;
    for _ in 0..max_ticks {
        let events = state.advance_ticks_for_observer(config, 1);
        for event in &events {
            if event.shooter_actor_id == creature_id
                && event.target_actor_id == "player"
                && event.damage > 0
            {
                damaging_hits = damaging_hits.saturating_add(1);
                if first_damage_tick.is_none() {
                    first_damage_tick = Some(state.runtime.durable.tick);
                }
            }
        }
        let player = state.runtime.durable.actors.get("player").unwrap();
        if player.life_state == AuthorityLifeState::Downed {
            down_tick = Some(state.runtime.durable.tick);
            break;
        }
    }
    let player = state.runtime.durable.actors.get("player").unwrap();
    let first = first_damage_tick.unwrap_or(start_tick);
    let end = down_tick.unwrap_or(state.runtime.durable.tick);
    let elapsed_ticks = end.saturating_sub(first);
    (
        damaging_hits,
        elapsed_ticks,
        health_before.saturating_sub(player.vitals.health.max(0)),
        player.life_state,
        state
            .runtime
            .durable
            .actors
            .get(creature_id)
            .unwrap()
            .shots_fired,
    )
}

#[test]
fn authority_gaia_danger_downs_unarmored_player_in_contract_window() {
    // Contract: standing unarmored player downs in ~8-12 landed strikes / 14-20s
    // of real tick execution (not a synthetic formula).
    let (config, mut state) = gaia_danger_unarmored_player_setup(
        "pebblehorn",
        "creature-pebblehorn-adult",
        CellSnapshot::new(12, 10),
        AuthorityPosition {
            x: 12_000,
            y: 10_000,
        },
        AuthorityPosition {
            x: 12_400,
            y: 10_000,
        },
    );
    // Prove starter truth: player weapon slot empty, shared Unarmed profile still 2.
    assert_eq!(state.actors.get("player").unwrap().equipped_weapon_id, None);
    assert_eq!(
        weapon_profile(Some(AuthorityWeaponId::Unarmed)).base_damage,
        2
    );
    assert_eq!(CREATURE_MELEE_BASE_DAMAGE, 18);
    assert!(
        CREATURE_MELEE_BASE_DAMAGE > weapon_profile(Some(AuthorityWeaponId::Unarmed)).base_damage
    );

    state.provoke_creature_retaliation("pebblehorn", "player");
    let start_tick = state.tick;
    let (hits, elapsed_from_first, health_lost, life, shots) =
        run_gaia_danger_standing_encounter(&config, &mut state, "pebblehorn", 900);
    assert_eq!(life, AuthorityLifeState::Downed, "player must be downed");
    assert!(
        (8..=12).contains(&hits),
        "landed damaging strikes must be 8-12, got {hits} (shots_fired={shots}, health_lost={health_lost})"
    );
    let elapsed_ms =
        elapsed_from_first.saturating_mul(1_000) / u64::from(state.tick_rate_hz.max(1));
    assert!(
        (14_000..=20_000).contains(&elapsed_ms),
        "time from first landed strike to down must be 14-20s, got {elapsed_ms}ms over {elapsed_from_first} ticks"
    );
    // Total wall from engage start stays in the same dangerous band (includes close-in).
    let total_ms = state.tick.saturating_sub(start_tick).saturating_mul(1_000)
        / u64::from(state.tick_rate_hz.max(1));
    assert!(
        total_ms <= 22_000,
        "full standing encounter should resolve promptly, got {total_ms}ms"
    );
    assert!(
        health_lost >= DEFAULT_HEALTH,
        "must expend full unarmored pool"
    );
}

#[test]
fn authority_gaia_danger_engage_outruns_player_walk_not_sprint() {
    // Walk must not free-kite; sprint must still break contact inside 8s chase.
    // Measure the REAL authority composition path (role move mult * body_output
    // via movement_speed_multiplier_milli_for_actor) — do not hand-multiply.
    let walk_speed = PLAYER_SPEED_MILLI_CELLS_PER_SECOND;
    let (creature, player) = {
        let (_c, state) = gaia_danger_test_state(
            "bellback",
            "creature-bellback-adult",
            CellSnapshot::new(10, 10),
            &[],
        );
        (
            state.actors.get("bellback").unwrap().clone(),
            state.actors.get("player").unwrap().clone(),
        )
    };
    let composed_mult = movement_speed_multiplier_milli_for_actor(&creature);
    let engage_effective =
        scaled_milli(CREATURE_ENGAGE_SPEED_MILLI_CELLS_PER_SECOND, composed_mult);
    assert!(
        engage_effective > walk_speed,
        "engaged wildlife effective speed ({engage_effective}) from base {} * composed_mult {composed_mult} must beat player walk ({walk_speed})",
        CREATURE_ENGAGE_SPEED_MILLI_CELLS_PER_SECOND
    );
    let player_walk_effective = scaled_milli(
        PLAYER_SPEED_MILLI_CELLS_PER_SECOND,
        movement_speed_multiplier_milli_for_actor(&player),
    );
    assert!(
        engage_effective > player_walk_effective,
        "creature engage ({engage_effective}) must also beat composed player walk ({player_walk_effective})"
    );
    let sprint_effective = scaled_milli(
        player_walk_effective,
        scaled_milli(
            SPRINT_SPEED_MULTIPLIER_MILLI,
            sprint_speed_multiplier_milli_for_actor(&player),
        ),
    );
    assert!(
        sprint_effective > engage_effective,
        "player sprint ({sprint_effective}) must remain faster than engage ({engage_effective})"
    );

    // Live tick: walking player stays contactable; sprinting player escapes chase window.
    let (config, mut state) = gaia_danger_unarmored_player_setup(
        "bellback",
        "creature-bellback-adult",
        CellSnapshot::new(10, 10),
        AuthorityPosition {
            x: 12_000,
            y: 10_000,
        },
        AuthorityPosition {
            x: 12_500,
            y: 10_000,
        },
    );
    // Ensure proactive acquire.
    state.advance_ticks_for_observer(&config, 2);
    {
        let creature = state.actors.get("bellback").unwrap();
        assert_eq!(creature.engagement_target_id.as_deref(), Some("player"));
    }
    let chase_ticks = ms_to_ticks_round(CREATURE_CHASE_TIMEOUT_MS, state.tick_rate_hz).max(1);

    // Walking kite attempt: slide player away at walk pace each tick; creature must keep engage.
    let mut still_engaged = false;
    let mut saw_hit_while_walking = false;
    let walk_step = distance_for_ticks(player_walk_effective, 1, state.tick_rate_hz);
    for _ in 0..chase_ticks.saturating_sub(2) {
        {
            let player = state.actors.get_mut("player").unwrap();
            // Pure positional walk sample (authority move path is command-driven;
            // this mirrors walk distance per tick without inventing inventory).
            player.position.x = player.position.x.saturating_add(walk_step);
            player.cell = player.position.cell();
        }
        let events = state.advance_ticks_for_observer(&config, 1);
        if events.iter().any(|e| {
            e.shooter_actor_id == "bellback" && e.target_actor_id == "player" && e.damage > 0
        }) {
            saw_hit_while_walking = true;
        }
        let creature = state.actors.get("bellback").unwrap();
        if matches!(
            creature.ai.as_ref(),
            Some(AuthorityAiState::PassiveCreature(ai))
                if ai.mode == PassiveCreatureMode::Engage
                    && ai.threat_actor_id.as_deref() == Some("player")
        ) {
            still_engaged = true;
        }
    }
    assert!(
        still_engaged,
        "walk kiting must not free the player from engage before chase timeout"
    );
    assert!(
        saw_hit_while_walking,
        "walk kiting must still allow wildlife to land strikes"
    );

    // Fresh sprint escape: open a gap beyond disengage with sprint speed inside chase window.
    let (config, mut state) = gaia_danger_unarmored_player_setup(
        "bellback",
        "creature-bellback-adult",
        CellSnapshot::new(10, 10),
        AuthorityPosition {
            x: 12_000,
            y: 10_000,
        },
        AuthorityPosition {
            x: 12_300,
            y: 10_000,
        },
    );
    state.advance_ticks_for_observer(&config, 2);
    let start_tick = state.tick;
    let sprint_step = distance_for_ticks(sprint_effective, 1, state.tick_rate_hz);
    let mut escaped = false;
    for _ in 0..chase_ticks {
        {
            let player = state.actors.get_mut("player").unwrap();
            player.position.x = player.position.x.saturating_add(sprint_step);
            player.cell = player.position.cell();
        }
        state.advance_ticks_for_observer(&config, 1);
        let creature = state.actors.get("bellback").unwrap();
        let disengaged = match creature.ai.as_ref() {
            Some(AuthorityAiState::PassiveCreature(ai)) => {
                ai.mode != PassiveCreatureMode::Engage || ai.threat_actor_id.is_none()
            }
            _ => true,
        };
        if disengaged {
            escaped = true;
            break;
        }
    }
    let elapsed_ms = state.tick.saturating_sub(start_tick).saturating_mul(1_000)
        / u64::from(state.tick_rate_hz.max(1));
    assert!(
        escaped,
        "sprint must break wildlife engage inside the chase window"
    );
    assert!(
        elapsed_ms <= CREATURE_CHASE_TIMEOUT_MS + 500,
        "sprint escape must complete within ~8s chase, got {elapsed_ms}ms"
    );
}

#[test]
fn authority_gaia_danger_never_finishes_downed_player() {
    let (config, mut state) = gaia_danger_unarmored_player_setup(
        "pebblehorn",
        "creature-pebblehorn-adult",
        CellSnapshot::new(12, 10),
        AuthorityPosition {
            x: 12_000,
            y: 10_000,
        },
        AuthorityPosition {
            x: 12_400,
            y: 10_000,
        },
    );
    state.provoke_creature_retaliation("pebblehorn", "player");
    // Force downed without killing through the wildlife path.
    {
        let tick = state.tick;
        let tick_rate_hz = state.tick_rate_hz;
        let player = state.actors.get_mut("player").unwrap();
        player.vitals.health = 0;
        assert!(!SliceAuthorityState::down_player_like_actor_or_kill(
            tick,
            tick_rate_hz,
            player,
        ));
        assert_eq!(player.life_state, AuthorityLifeState::Downed);
    }
    let lifecycle_before = state.actors.get("player").unwrap().lifecycle_seq;
    let shots_before = state.actors.get("pebblehorn").unwrap().shots_fired;
    for _ in 0..90 {
        let events = state.advance_ticks_for_observer(&config, 1);
        assert!(
            events.iter().all(|event| {
                !(event.shooter_actor_id == "pebblehorn"
                    && event.target_actor_id == "player"
                    && event.damage > 0)
            }),
            "wildlife must not damage a downed player"
        );
    }
    let player = state.actors.get("player").unwrap();
    assert_eq!(player.life_state, AuthorityLifeState::Downed);
    assert_eq!(player.lifecycle_seq, lifecycle_before);
    assert_eq!(
        state.actors.get("pebblehorn").unwrap().shots_fired,
        shots_before,
        "creature must stop striking once the player is downed"
    );
}

#[test]
fn authority_gaia_danger_retaliation_proactive_split_and_passives_hold() {
    // Bellback proactive, Pebblehorn retaliatory, four others never engage.
    let (_c, mut bell) = gaia_danger_unarmored_player_setup(
        "bellback",
        "creature-bellback-adult",
        CellSnapshot::new(12, 10),
        AuthorityPosition {
            x: 12_200,
            y: 10_000,
        },
        AuthorityPosition {
            x: 12_600,
            y: 10_000,
        },
    );
    assert!(actor_will_auto_aggro(bell.actors.get("bellback").unwrap()));
    bell.advance_ticks_for_observer(
        &SliceAuthorityConfig {
            player_actor_id: "player".to_owned(),
            ..SliceAuthorityConfig::default()
        },
        3,
    );
    assert_eq!(
        bell.actors
            .get("bellback")
            .unwrap()
            .engagement_target_id
            .as_deref(),
        Some("player")
    );

    let (_c, mut pebble) = gaia_danger_unarmored_player_setup(
        "pebblehorn",
        "creature-pebblehorn-adult",
        CellSnapshot::new(12, 10),
        AuthorityPosition {
            x: 12_200,
            y: 10_000,
        },
        AuthorityPosition {
            x: 12_600,
            y: 10_000,
        },
    );
    assert!(!actor_will_auto_aggro(
        pebble.actors.get("pebblehorn").unwrap()
    ));
    pebble.advance_ticks_for_observer(
        &SliceAuthorityConfig {
            player_actor_id: "player".to_owned(),
            ..SliceAuthorityConfig::default()
        },
        8,
    );
    assert_eq!(
        pebble
            .actors
            .get("pebblehorn")
            .unwrap()
            .engagement_target_id,
        None,
        "pebblehorn stays calm until damaged"
    );
    pebble.provoke_creature_retaliation("pebblehorn", "player");
    assert_eq!(
        pebble
            .actors
            .get("pebblehorn")
            .unwrap()
            .engagement_target_id
            .as_deref(),
        Some("player")
    );

    for sprite in [
        "creature-snufflefin-adult",
        "creature-pocketclod-adult",
        "creature-mossmuff-adult",
        "creature-dapplepod-adult",
    ] {
        let (config, mut state) =
            gaia_danger_test_state("passive", sprite, CellSnapshot::new(11, 10), &[]);
        place_actor_at_position(
            &mut state,
            "player",
            AuthorityPosition {
                x: 11_000,
                y: 10_000,
            },
        );
        place_actor_at_position(
            &mut state,
            "passive",
            AuthorityPosition {
                x: 11_500,
                y: 10_000,
            },
        );
        state.provoke_creature_retaliation("passive", "player");
        state.advance_ticks_for_observer(&config, 10);
        let creature = state.actors.get("passive").unwrap();
        assert!(!actor_will_auto_aggro(creature), "{sprite}");
        assert_eq!(creature.engagement_target_id, None, "{sprite}");
        match creature.ai.as_ref() {
            Some(AuthorityAiState::PassiveCreature(ai)) => {
                assert_ne!(ai.mode, PassiveCreatureMode::Engage, "{sprite}");
            }
            other => panic!("expected passive ai for {sprite}, got {other:?}"),
        }
    }
}

#[test]
fn authority_gaia_danger_replay_hash_stable_across_engage_damage() {
    let (config, mut state) = gaia_danger_unarmored_player_setup(
        "pebblehorn",
        "creature-pebblehorn-adult",
        CellSnapshot::new(12, 10),
        AuthorityPosition {
            x: 12_000,
            y: 10_000,
        },
        AuthorityPosition {
            x: 12_400,
            y: 10_000,
        },
    );
    state.provoke_creature_retaliation("pebblehorn", "player");
    let hash_engage = state.stable_state_hash_hex();
    let blob = state.export_checkpoint();
    let restored = restore_checkpoint_for_test(&state, blob);
    assert_eq!(restored.stable_state_hash_hex(), hash_engage);

    // Twin deterministic advance after engage damage path.
    let mut a = restored;
    let second_checkpoint = state.export_checkpoint();
    let mut b = restore_checkpoint_for_test(&state, second_checkpoint);
    for _ in 0..48 {
        a.advance_ticks_for_observer(&config, 1);
        b.advance_ticks_for_observer(&config, 1);
    }
    assert_eq!(a.stable_state_hash_hex(), b.stable_state_hash_hex());
    assert_eq!(
        a.actors.get("player").unwrap().vitals.health,
        b.actors.get("player").unwrap().vitals.health
    );
    assert_eq!(
        a.actors.get("pebblehorn").unwrap().shots_fired,
        b.actors.get("pebblehorn").unwrap().shots_fired
    );
    assert!(
        a.actors.get("player").unwrap().vitals.health < DEFAULT_HEALTH,
        "engage window must apply real creature damage for hash coverage"
    );
}

#[test]
fn authority_gaia_creature_melee_does_not_buff_shared_unarmed() {
    // Guardrail: player/NPC Unarmed profile remains the weak bare-hand baseline.
    let unarmed = weapon_profile(Some(AuthorityWeaponId::Unarmed));
    assert_eq!(unarmed.base_damage, 2);
    assert_eq!(unarmed.roll_stats.unwrap().damage_min, 1);
    assert_eq!(unarmed.roll_stats.unwrap().damage_max, 3);
    const { assert!(CREATURE_MELEE_BASE_DAMAGE >= 10) };
    assert_ne!(CREATURE_MELEE_BASE_DAMAGE, unarmed.base_damage);

    // Direct contact strike from a humanoid with no weapon still uses Unarmed=2.
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
        "brawler",
        "Brawler",
        "skirmisher_brawler",
        CellSnapshot::new(11, 10),
        "left",
    ));
    add_test_factions(&mut snapshot);
    let mut state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    state
        .actors
        .get_mut("player")
        .unwrap()
        .effective_stats
        .dodge_chance_milli = 0;
    state.actors.get_mut("brawler").unwrap().equipped_weapon_id = None;
    let target = state.actors.get("player").unwrap().clone();
    let origin = state.actors.get("brawler").unwrap().position;
    let event = state
        .apply_melee_contact_strike("brawler", &target, None, origin, target.position)
        .expect("unarmed humanoid strike");
    assert_eq!(event.damage, 2);
    assert_eq!(event.weapon_id, AuthorityWeaponId::Unarmed);
}

// ── Physical factory manufacture (drafted schematic consumption) ─────────────
fn seed_factory_terminal(state: &mut SliceAuthorityState, factory_id: &str, cell: AuthorityCell) {
    state
        .runtime
        .durable
        .world
        .terminals
        .push(AuthorityTerminalState {
            id: factory_id.to_owned(),
            kind: "factory".to_owned(),
            area_id: "authority-test-overworld".to_owned(),
            cell,
        });
}

fn seed_owned_drafted_schematic(
    state: &mut SliceAuthorityState,
    owner: &str,
    schematic_id: &str,
    sequence: u64,
    remaining_uses: u16,
    locks: Vec<(u32, u32, u32)>,
) -> u32 {
    let variant_id = 53_000_000u32.saturating_add(u32::try_from(sequence).unwrap_or(u32::MAX));
    state.runtime.durable.drafted_schematics.insert(
        schematic_id.to_owned(),
        DraftedSchematicState {
            id: schematic_id.to_owned(),
            owner_actor_id: owner.to_owned(),
            recipe_id: "extractor_battery".to_owned(),
            resource_locks: locks
                .iter()
                .map(|(item_id, variant_id, quantity)| CraftResourceLock {
                    item_id: *item_id,
                    variant_id: *variant_id,
                    quantity: *quantity,
                })
                .collect(),
            output_item_id: EXTRACTOR_BATTERY_ITEM_ID,
            output_variant_id: 42,
            schematic_item_variant_id: variant_id,
            max_uses: remaining_uses.max(1),
            remaining_uses,
        },
    );
    state.runtime.durable.next_drafted_schematic_id = state
        .runtime
        .durable
        .next_drafted_schematic_id
        .max(sequence.saturating_add(1));
    let container = format!("{owner}:datapad");
    push_test_inventory_stack(state, &container, DRAFTED_SCHEMATIC_ITEM_ID, variant_id, 1);
    variant_id
}

fn place_player_at_factory(state: &mut SliceAuthorityState, player: &str, cell: AuthorityCell) {
    if let Some(actor) = state.runtime.durable.actors.get_mut(player) {
        actor.cell = cell;
        actor.position = AuthorityPosition::from_cell(cell);
        actor.area_id = "authority-test-overworld".to_owned();
        actor.life_state = AuthorityLifeState::Alive;
    }
}

#[test]
fn factory_manufacture_split_stack_success_and_reject_matrix() {
    let config = SliceAuthorityConfig::default();
    let mut state = SliceAuthorityState::from_snapshot(&crate::authority_test_slice()).unwrap();
    let player = config.player_actor_id.clone();
    let factory_id = "dustgate-occupation-workbench";
    let factory_cell = AuthorityCell::new(37, 21);
    seed_factory_terminal(&mut state, factory_id, factory_cell);
    place_player_at_factory(&mut state, &player, factory_cell);

    let schematic_id = "draft:player:7";
    let lock_item = RESOURCE_MINERAL_ITEM_ID;
    let lock_variant = 9u32;
    let physical_variant = seed_owned_drafted_schematic(
        &mut state,
        &player,
        schematic_id,
        7,
        2,
        vec![(lock_item, lock_variant, 5)],
    );
    let pack = format!("{player}:field-pack");
    push_test_inventory_stack(&mut state, &pack, lock_item, lock_variant, 2);
    push_test_inventory_stack(&mut state, &pack, lock_item, lock_variant, 4);
    push_test_inventory_stack(&mut state, &pack, lock_item, lock_variant + 1, 50);

    let before = state.stable_state_hash_hex();
    let rej = state.apply_live_envelope(
        &config,
        command(
            9001,
            ClientCommand::FactoryManufacture {
                factory_id: "no-such-factory".to_owned(),
                schematic_id: schematic_id.to_owned(),
            },
        ),
    );
    assert_eq!(rej.status, AuthorityCommandStatus::Rejected);
    assert_eq!(rej.reason_code.as_deref(), Some("unknown_factory"));
    assert_eq!(state.stable_state_hash_hex(), before);

    place_player_at_factory(&mut state, &player, AuthorityCell::new(1, 1));
    let before = state.stable_state_hash_hex();
    let rej = state.apply_live_envelope(
        &config,
        command(
            9002,
            ClientCommand::FactoryManufacture {
                factory_id: factory_id.to_owned(),
                schematic_id: schematic_id.to_owned(),
            },
        ),
    );
    assert_eq!(rej.status, AuthorityCommandStatus::Rejected);
    assert_eq!(rej.reason_code.as_deref(), Some("not_at_factory"));
    assert_eq!(state.stable_state_hash_hex(), before);
    place_player_at_factory(&mut state, &player, factory_cell);

    state
        .drafted_schematics
        .get_mut(schematic_id)
        .unwrap()
        .owner_actor_id = "someone-else".to_owned();
    let before = state.stable_state_hash_hex();
    let rej = state.apply_live_envelope(
        &config,
        command(
            9003,
            ClientCommand::FactoryManufacture {
                factory_id: factory_id.to_owned(),
                schematic_id: schematic_id.to_owned(),
            },
        ),
    );
    assert_eq!(rej.status, AuthorityCommandStatus::Rejected);
    assert_eq!(rej.reason_code.as_deref(), Some("factory_draft_mismatch"));
    assert_eq!(state.stable_state_hash_hex(), before);
    state
        .drafted_schematics
        .get_mut(schematic_id)
        .unwrap()
        .owner_actor_id = player.clone();

    state.inventory.retain(|row| {
        !(row.item_id == DRAFTED_SCHEMATIC_ITEM_ID && row.variant_id == physical_variant)
    });
    let before = state.stable_state_hash_hex();
    let rej = state.apply_live_envelope(
        &config,
        command(
            9004,
            ClientCommand::FactoryManufacture {
                factory_id: factory_id.to_owned(),
                schematic_id: schematic_id.to_owned(),
            },
        ),
    );
    assert_eq!(rej.status, AuthorityCommandStatus::Rejected);
    assert_eq!(rej.reason_code.as_deref(), Some("factory_draft_missing"));
    assert_eq!(state.stable_state_hash_hex(), before);
    push_test_inventory_stack(
        &mut state,
        &format!("{player}:datapad"),
        DRAFTED_SCHEMATIC_ITEM_ID,
        physical_variant,
        1,
    );

    state.inventory.retain(|row| {
        !(row.item_id == lock_item
            && row.variant_id == lock_variant
            && actor_owns_inventory_container(&player, &row.container))
    });
    push_test_inventory_stack(&mut state, &pack, lock_item, lock_variant, 1);
    let before = state.stable_state_hash_hex();
    let mat_before = state.actor_inventory_available_variant(&player, lock_item, lock_variant);
    let rej = state.apply_live_envelope(
        &config,
        command(
            9005,
            ClientCommand::FactoryManufacture {
                factory_id: factory_id.to_owned(),
                schematic_id: schematic_id.to_owned(),
            },
        ),
    );
    assert_eq!(rej.status, AuthorityCommandStatus::Rejected);
    assert_eq!(rej.reason_code.as_deref(), Some("ingredient_unavailable"));
    assert_eq!(state.stable_state_hash_hex(), before);
    assert_eq!(
        state.actor_inventory_available_variant(&player, lock_item, lock_variant),
        mat_before
    );

    state.inventory.retain(|row| {
        !(row.item_id == lock_item
            && row.variant_id == lock_variant
            && actor_owns_inventory_container(&player, &row.container))
    });
    push_test_inventory_stack(&mut state, &pack, lock_item, lock_variant, 2);
    push_test_inventory_stack(&mut state, &pack, lock_item, lock_variant, 3);
    let before_uses = state.drafted_schematics[schematic_id].remaining_uses;
    let frame = state.apply_live_envelope(
        &config,
        command(
            9006,
            ClientCommand::FactoryManufacture {
                factory_id: factory_id.to_owned(),
                schematic_id: schematic_id.to_owned(),
            },
        ),
    );
    assert_eq!(frame.status, AuthorityCommandStatus::Accepted);
    assert!(frame.factory_receipt.is_some());
    let receipt = frame.factory_receipt.unwrap();
    assert_eq!(receipt.factory_id, factory_id);
    assert_eq!(receipt.schematic_id, schematic_id);
    assert_eq!(receipt.remaining_uses, before_uses - 1);
    assert!(!receipt.spent);
    assert_eq!(
        state.actor_inventory_available_variant(&player, lock_item, lock_variant),
        0
    );
    assert_eq!(
        state.actor_inventory_available_variant(&player, EXTRACTOR_BATTERY_ITEM_ID, 42),
        1
    );
    assert_eq!(
        state.drafted_schematics[schematic_id].remaining_uses,
        before_uses - 1
    );
    assert_eq!(
        state.actor_inventory_available_variant(
            &player,
            DRAFTED_SCHEMATIC_ITEM_ID,
            physical_variant
        ),
        1
    );

    let before = state.stable_state_hash_hex();
    let dup = state.apply_live_envelope(
        &config,
        command(
            9006,
            ClientCommand::FactoryManufacture {
                factory_id: factory_id.to_owned(),
                schematic_id: schematic_id.to_owned(),
            },
        ),
    );
    assert_eq!(dup.status, AuthorityCommandStatus::Rejected);
    assert_eq!(dup.reason_code.as_deref(), Some("duplicate_command"));
    assert_eq!(state.stable_state_hash_hex(), before);

    push_test_inventory_stack(&mut state, &pack, lock_item, lock_variant, 5);
    let frame = state.apply_live_envelope(
        &config,
        command(
            9007,
            ClientCommand::FactoryManufacture {
                factory_id: factory_id.to_owned(),
                schematic_id: schematic_id.to_owned(),
            },
        ),
    );
    assert_eq!(frame.status, AuthorityCommandStatus::Accepted);
    let receipt = frame.factory_receipt.unwrap();
    assert!(receipt.spent);
    assert_eq!(receipt.remaining_uses, 0);
    assert!(!state.drafted_schematics.contains_key(schematic_id));
    assert_eq!(
        state.actor_inventory_available_variant(
            &player,
            DRAFTED_SCHEMATIC_ITEM_ID,
            physical_variant
        ),
        0
    );
    assert_eq!(
        state.actor_inventory_available_variant(&player, EXTRACTOR_BATTERY_ITEM_ID, 42),
        2
    );
}

#[test]
fn factory_manufacture_owner_only_projection_and_checkpoint_replay() {
    let config = SliceAuthorityConfig::default();
    let mut state = SliceAuthorityState::from_snapshot(&crate::authority_test_slice()).unwrap();
    let player = config.player_actor_id.clone();
    let factory_id = "dustgate-occupation-workbench";
    let factory_cell = AuthorityCell::new(37, 21);
    seed_factory_terminal(&mut state, factory_id, factory_cell);
    place_player_at_factory(&mut state, &player, factory_cell);
    let schematic_id = "draft:player:3";
    let lock_item = RESOURCE_MINERAL_ITEM_ID;
    let lock_variant = 3u32;
    seed_owned_drafted_schematic(
        &mut state,
        &player,
        schematic_id,
        3,
        4,
        vec![(lock_item, lock_variant, 2)],
    );
    let pack = format!("{player}:field-pack");
    push_test_inventory_stack(&mut state, &pack, lock_item, lock_variant, 2);
    let frame = state.apply_envelope(
        &config,
        command(
            9101,
            ClientCommand::FactoryManufacture {
                factory_id: factory_id.to_owned(),
                schematic_id: schematic_id.to_owned(),
            },
        ),
    );
    assert_eq!(frame.status, AuthorityCommandStatus::Accepted);
    assert_eq!(state.drafted_schematics[schematic_id].remaining_uses, 3);

    let owner_view = state.drafted_schematic_snapshots_for_observer(&config);
    assert!(owner_view.iter().any(|d| d.id == schematic_id));
    let mut other = config.clone();
    other.player_actor_id = "vendor".to_owned();
    let stranger_view = state.drafted_schematic_snapshots_for_observer(&other);
    assert!(!stranger_view.iter().any(|d| d.id == schematic_id));

    let blob = state.export_checkpoint();
    assert_eq!(blob.version(), 1);
    let restored = restore_checkpoint_for_test(&state, blob);
    assert_eq!(
        restored.stable_state_hash_hex(),
        state.stable_state_hash_hex()
    );
    assert_eq!(restored.drafted_schematics[schematic_id].remaining_uses, 3);
    assert_eq!(
        restored.drafted_schematics[schematic_id].schematic_item_variant_id,
        state.drafted_schematics[schematic_id].schematic_item_variant_id
    );
}

#[test]
fn factory_manufacture_wire_tag_is_stable() {
    let command = ClientCommand::FactoryManufacture {
        factory_id: "dustgate-occupation-workbench".to_owned(),
        schematic_id: "draft:player:1".to_owned(),
    };
    assert_eq!(command.wire_tag(), 154);
}

#[test]
fn factory_draft_projection_survives_server_tick_and_non_owner_command() {
    // Unfiltered authority snapshot is the shard cache source of truth.
    // Observer filtering is session-only and must not erase other owners.
    let config_a = SliceAuthorityConfig {
        player_actor_id: "player".to_owned(),
        ..SliceAuthorityConfig::default()
    };
    let mut state = SliceAuthorityState::from_snapshot(&crate::authority_test_slice()).unwrap();
    if !state.actors.contains_key("vendor") {
        panic!("authority_test_slice must include vendor actor for two-owner projection test");
    }
    let factory_cell = AuthorityCell::new(37, 21);
    seed_factory_terminal(&mut state, "dustgate-occupation-workbench", factory_cell);
    place_player_at_factory(&mut state, "player", factory_cell);
    place_player_at_factory(&mut state, "vendor", factory_cell);

    seed_owned_drafted_schematic(
        &mut state,
        "player",
        "draft:player:21",
        21,
        3,
        vec![(RESOURCE_MINERAL_ITEM_ID, 1, 1)],
    );
    seed_owned_drafted_schematic(
        &mut state,
        "vendor",
        "draft:vendor:22",
        22,
        5,
        vec![(RESOURCE_MINERAL_ITEM_ID, 2, 1)],
    );

    let all = state.drafted_schematic_snapshots();
    assert!(all
        .iter()
        .any(|d| d.id == "draft:player:21" && d.owner_actor_id == "player"));
    assert!(all
        .iter()
        .any(|d| d.id == "draft:vendor:22" && d.owner_actor_id == "vendor"));

    let only_a = state.drafted_schematic_snapshots_for_observer(&config_a);
    assert!(only_a.iter().all(|d| d.owner_actor_id == "player"));
    assert!(only_a.iter().any(|d| d.id == "draft:player:21"));
    assert!(!only_a.iter().any(|d| d.id == "draft:vendor:22"));

    let config_b = SliceAuthorityConfig {
        player_actor_id: "vendor".to_owned(),
        ..SliceAuthorityConfig::default()
    };
    let only_b = state.drafted_schematic_snapshots_for_observer(&config_b);
    assert!(only_b.iter().all(|d| d.owner_actor_id == "vendor"));
    assert!(only_b.iter().any(|d| d.id == "draft:vendor:22"));
    assert!(!only_b.iter().any(|d| d.id == "draft:player:21"));

    let tick_observer = SliceAuthorityConfig {
        player_actor_id: "__server_tick_observer__".to_owned(),
        ..SliceAuthorityConfig::default()
    };
    let tick_filtered = state.drafted_schematic_snapshots_for_observer(&tick_observer);
    assert!(
        tick_filtered.is_empty(),
        "tick observer must not receive owner drafts via observer filter"
    );
    let after_tick_all = state.drafted_schematic_snapshots();
    assert_eq!(after_tick_all.len(), all.len());
    assert!(after_tick_all.iter().any(|d| d.id == "draft:player:21"));
    assert!(after_tick_all.iter().any(|d| d.id == "draft:vendor:22"));

    let pack = "vendor:field-pack".to_owned();
    push_test_inventory_stack(&mut state, &pack, RESOURCE_MINERAL_ITEM_ID, 2, 1);
    let frame = state.apply_live_envelope(
        &config_b,
        command(
            9201,
            ClientCommand::FactoryManufacture {
                factory_id: "dustgate-occupation-workbench".to_owned(),
                schematic_id: "draft:vendor:22".to_owned(),
            },
        ),
    );
    assert_eq!(frame.status, AuthorityCommandStatus::Accepted);
    let all_after = state.drafted_schematic_snapshots();
    assert!(
        all_after.iter().any(|d| d.id == "draft:player:21"),
        "player draft must survive vendor manufacture"
    );
    assert!(
        all_after
            .iter()
            .any(|d| d.id == "draft:vendor:22" && d.remaining_uses == 4),
        "vendor draft uses must decrement without dropping peer drafts"
    );
    let only_a_after = state.drafted_schematic_snapshots_for_observer(&config_a);
    assert!(only_a_after.iter().any(|d| d.id == "draft:player:21"));
    assert!(!only_a_after.iter().any(|d| d.id == "draft:vendor:22"));
    let only_b_after = state.drafted_schematic_snapshots_for_observer(&config_b);
    assert!(only_b_after.iter().any(|d| d.id == "draft:vendor:22"));
    assert!(!only_b_after.iter().any(|d| d.id == "draft:player:21"));
}

#[test]
fn factory_manufacture_reject_keeps_state_hash_for_ingredient_and_draft_failures() {
    let config = SliceAuthorityConfig::default();
    let mut state = SliceAuthorityState::from_snapshot(&crate::authority_test_slice()).unwrap();
    let player = config.player_actor_id.clone();
    let factory_id = "dustgate-occupation-workbench";
    let factory_cell = AuthorityCell::new(37, 21);
    seed_factory_terminal(&mut state, factory_id, factory_cell);
    place_player_at_factory(&mut state, &player, factory_cell);
    let schematic_id = "draft:player:31";
    let lock_item = RESOURCE_MINERAL_ITEM_ID;
    let lock_variant = 4u32;
    let physical_variant = seed_owned_drafted_schematic(
        &mut state,
        &player,
        schematic_id,
        31,
        1,
        vec![(lock_item, lock_variant, 3)],
    );
    let pack = format!("{player}:field-pack");

    push_test_inventory_stack(&mut state, &pack, lock_item, lock_variant, 1);
    let before = state.stable_state_hash_hex();
    let before_inv = state.inventory_snapshots();
    let before_drafts = state.drafted_schematic_snapshots();
    let rej = state.apply_live_envelope(
        &config,
        command(
            9301,
            ClientCommand::FactoryManufacture {
                factory_id: factory_id.to_owned(),
                schematic_id: schematic_id.to_owned(),
            },
        ),
    );
    assert_eq!(rej.status, AuthorityCommandStatus::Rejected);
    assert_eq!(rej.reason_code.as_deref(), Some("ingredient_unavailable"));
    assert_eq!(state.stable_state_hash_hex(), before);
    assert_eq!(state.inventory_snapshots(), before_inv);
    assert_eq!(state.drafted_schematic_snapshots(), before_drafts);

    state.inventory.retain(|row| {
        !(row.item_id == DRAFTED_SCHEMATIC_ITEM_ID && row.variant_id == physical_variant)
    });
    state.inventory.retain(|row| {
        !(row.item_id == lock_item
            && row.variant_id == lock_variant
            && actor_owns_inventory_container(&player, &row.container))
    });
    push_test_inventory_stack(&mut state, &pack, lock_item, lock_variant, 3);
    let before = state.stable_state_hash_hex();
    let before_inv = state.inventory_snapshots();
    let before_drafts = state.drafted_schematic_snapshots();
    let rej = state.apply_live_envelope(
        &config,
        command(
            9302,
            ClientCommand::FactoryManufacture {
                factory_id: factory_id.to_owned(),
                schematic_id: schematic_id.to_owned(),
            },
        ),
    );
    assert_eq!(rej.status, AuthorityCommandStatus::Rejected);
    assert_eq!(rej.reason_code.as_deref(), Some("factory_draft_missing"));
    assert_eq!(state.stable_state_hash_hex(), before);
    assert_eq!(state.inventory_snapshots(), before_inv);
    assert_eq!(state.drafted_schematic_snapshots(), before_drafts);

    push_test_inventory_stack(
        &mut state,
        &format!("{player}:datapad"),
        DRAFTED_SCHEMATIC_ITEM_ID,
        physical_variant,
        1,
    );
    state
        .drafted_schematics
        .get_mut(schematic_id)
        .unwrap()
        .recipe_id = "not-a-real-recipe".to_owned();
    let before = state.stable_state_hash_hex();
    let before_inv = state.inventory_snapshots();
    let rej = state.apply_live_envelope(
        &config,
        command(
            9303,
            ClientCommand::FactoryManufacture {
                factory_id: factory_id.to_owned(),
                schematic_id: schematic_id.to_owned(),
            },
        ),
    );
    assert_eq!(rej.status, AuthorityCommandStatus::Rejected);
    assert_eq!(rej.reason_code.as_deref(), Some("unknown_schematic"));
    assert_eq!(state.stable_state_hash_hex(), before);
    assert_eq!(state.inventory_snapshots(), before_inv);
}

#[test]
fn factory_bridge_tick_keeps_unfiltered_multi_owner_draft_cache() {
    use crate::authority_bridge::{
        AuthorityBridge, AuthorityBridgeConfigInput, AuthorityBridgeImportStateRequest,
        AuthorityBridgeTickRequest,
    };
    let mut state = SliceAuthorityState::from_snapshot(&crate::authority_test_slice()).unwrap();
    seed_owned_drafted_schematic(
        &mut state,
        "player",
        "draft:player:51",
        51,
        2,
        vec![(RESOURCE_MINERAL_ITEM_ID, 1, 1)],
    );
    seed_owned_drafted_schematic(
        &mut state,
        "vendor",
        "draft:vendor:52",
        52,
        2,
        vec![(RESOURCE_MINERAL_ITEM_ID, 1, 1)],
    );
    let blob = state.export_checkpoint();
    let mut bridge =
        AuthorityBridge::from_snapshot(&crate::authority_test_slice()).expect("bridge boots");
    bridge
        .import_state(AuthorityBridgeImportStateRequest {
            request_type: "importState".to_owned(),
            request_id: Some(1),
            expected_state_hash: None,
            state: blob,
        })
        .expect("import seeded drafts");
    let tick = bridge
        .tick(AuthorityBridgeTickRequest {
            request_type: "tick".to_owned(),
            request_id: Some(2),
            config: AuthorityBridgeConfigInput {
                session: 1,
                player: 1,
                player_actor_id: "__server_tick_observer__".to_owned(),
                area_interest_radius_cells: Some(32),
                craft_roll_key: None,
            },
            ticks: Some(1),
            include_ai_debug: false,
            weather_hazards: Vec::new(),
            weather_hazards_by_tick: None,
        })
        .expect("server tick");
    assert!(
        tick.drafted_schematics
            .iter()
            .any(|d| d.id == "draft:player:51" && d.owner_actor_id == "player"),
        "tick cache must retain player draft under server_tick_observer"
    );
    assert!(
        tick.drafted_schematics
            .iter()
            .any(|d| d.id == "draft:vendor:52" && d.owner_actor_id == "vendor"),
        "tick cache must retain vendor draft under server_tick_observer"
    );
}

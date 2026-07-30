fn transition_script() -> Vec<ClientCommandEnvelope> {
    let mut script = vec![command(
        1,
        ClientCommand::EnterTransition {
            transition_id: "test-workshop-entry".to_owned(),
        },
    )];
    let mut command_id = 2;
    for _ in 0..40 {
        script.push(command(
            command_id,
            ClientCommand::Move {
                dx: 1,
                dy: 0,
                duration_ticks: 1,
                facing: None,
                sprint: false,
            },
        ));
        command_id += 1;
    }
    for _ in 0..14 {
        script.push(command(
            command_id,
            ClientCommand::Move {
                dx: 0,
                dy: -1,
                duration_ticks: 1,
                facing: None,
                sprint: false,
            },
        ));
        command_id += 1;
    }
    script.push(command(
        command_id,
        ClientCommand::EnterTransition {
            transition_id: "test-workshop-entry".to_owned(),
        },
    ));
    script
}

#[test]
fn authority_accepts_valid_move_and_emits_snapshot_frame() {
    let config = SliceAuthorityConfig::default();
    let snapshot = crate::authority_test_slice();
    let mut state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    let before = state.stable_state_hash_hex();
    let output = state.apply_envelope(
        &config,
        command(
            1,
            ClientCommand::Move {
                dx: 1,
                dy: 0,
                duration_ticks: 3,
                facing: None,
                sprint: false,
            },
        ),
    );

    assert_eq!(output.status, AuthorityCommandStatus::Accepted);
    assert_eq!(output.previous_state_hash, before);
    assert_ne!(output.target_state_hash, before);
    assert_eq!(output.frame.accepted.len(), 1);
    assert_eq!(output.frame.rejected.len(), 0);
    let section_subsystems: Vec<&str> = output
        .bundle
        .sections
        .iter()
        .map(|section| section.subsystem.as_str())
        .collect();
    assert_eq!(
        section_subsystems,
        vec![
            "authority.actors",
            "authority.combatEvents",
            "authority.inventory",
            "authority.bank",
            "authority.corpses",
            "authority.npcJobs",
            "authority.placedExtractors",
            "authority.placedCamps",
            "authority.parcels",
            "authority.building",
            "authority.farmPlot",
            "authority.craftSession",
            "authority.guilds",
            "authority.draftedSchematics",
            "authority.timelineEvents",
            "authority.groups",
        ]
    );
    assert_actor_position(&output.actor.unwrap(), 37.135, 21.0);
}

#[test]
fn authority_actor_collision_player_move_into_occupied_actor_cell_succeeds() {
    let config = SliceAuthorityConfig::default();
    let mut snapshot = crate::authority_test_slice();
    snapshot.actors.clear();
    snapshot.npc_jobs.clear();
    snapshot.props.clear();
    snapshot.blocked_cells.clear();
    snapshot.actors.push(test_actor(
        "player",
        "Field Observer",
        "player",
        CellSnapshot::new(10, 10),
        "right",
    ));
    snapshot.actors.push(test_actor(
        "standing-npc",
        "Standing NPC",
        "public_shopkeeper",
        CellSnapshot::new(11, 10),
        "left",
    ));
    let mut state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();

    let output = state.apply_envelope(
        &config,
        command(
            1,
            ClientCommand::Move {
                dx: 1,
                dy: 0,
                duration_ticks: 23,
                facing: None,
                sprint: false,
            },
        ),
    );

    assert_eq!(output.status, AuthorityCommandStatus::Accepted);
    let player = state.actors.get("player").unwrap();
    let standing = state.actors.get("standing-npc").unwrap();
    assert_eq!(player.cell, standing.cell);
}

#[test]
fn authority_player_move_clamps_at_blocked_cell() {
    let config = SliceAuthorityConfig::default();
    let mut snapshot = crate::authority_test_slice();
    snapshot.actors.clear();
    snapshot.npc_jobs.clear();
    snapshot.props.clear();
    snapshot.blocked_cells.clear();
    snapshot.actors.push(test_actor(
        "player",
        "Field Observer",
        "player",
        CellSnapshot::new(10, 10),
        "right",
    ));
    snapshot.blocked_cells.push(crate::BlockedCellSnapshot::new(
        crate::AUTHORITY_TEST_AREA_ID,
        11,
        10,
    ));
    let mut state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();

    let output = state.apply_envelope(
        &config,
        command(
            1,
            ClientCommand::Move {
                dx: 1,
                dy: 0,
                duration_ticks: 23,
                facing: None,
                sprint: false,
            },
        ),
    );

    assert_eq!(output.status, AuthorityCommandStatus::Accepted);
    assert_eq!(output.reason_code.as_deref(), None);
    let player = state.actor_snapshot("player").unwrap();
    // The stored anchor is 500 milli-cells behind the swept ground center.
    assert_actor_position(&player, 10.198, 10.0);
    assert_eq!(
        state.actors.get("player").unwrap().cell,
        AuthorityCell::new(10, 10)
    );
}

#[test]
fn authority_player_diagonal_move_slides_along_blocked_cell_for_all_signs() {
    let config = SliceAuthorityConfig::default();
    for (command_id, dx, dy, blocked_cell, start_x, start_y) in [
        (1, 1, 1, AuthorityCell::new(11, 11), 10.05, 10.05),
        (2, 1, -1, AuthorityCell::new(11, 9), 10.05, 10.95),
        (3, -1, 1, AuthorityCell::new(9, 11), 10.95, 10.05),
        (4, -1, -1, AuthorityCell::new(9, 9), 10.95, 10.95),
    ] {
        let mut snapshot = crate::authority_test_slice();
        snapshot.actors.clear();
        snapshot.npc_jobs.clear();
        snapshot.props.clear();
        snapshot.blocked_cells.clear();
        snapshot.actors.push(test_actor(
            "player",
            "Field Observer",
            "player",
            CellSnapshot::new(10, 10),
            "right",
        ));
        snapshot.blocked_cells.push(crate::BlockedCellSnapshot::new(
            crate::AUTHORITY_TEST_AREA_ID,
            blocked_cell.x,
            blocked_cell.y,
        ));
        let mut state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
        let start_position = AuthorityPosition::from_world(start_x, start_y).unwrap();
        {
            let actor = state.actors.get_mut("player").unwrap();
            actor.position = start_position;
            actor.cell = start_position.cell();
        }

        let output = state.apply_envelope(
            &config,
            command(
                command_id,
                ClientCommand::Move {
                    dx,
                    dy,
                    duration_ticks: 30,
                    facing: None,
                    sprint: false,
                },
            ),
        );

        assert_eq!(output.status, AuthorityCommandStatus::Accepted);
        let actor = state.actors.get("player").unwrap();
        assert_ne!(actor.position, start_position);
        // The stored anchor may remain in the authored blocked cell while its
        // canonical ground center has slid clear of the wall.
        assert!(!state.circle_position_blocked(&actor.area_id, actor.position));
    }
}

#[test]
fn authority_player_diagonal_move_clamps_when_both_slide_axes_are_blocked() {
    let config = SliceAuthorityConfig::default();
    for (command_id, dx, dy, blocked_cell, x_slide_cell, y_slide_cell, start_x, start_y) in [
        (
            1,
            1,
            1,
            AuthorityCell::new(11, 11),
            AuthorityCell::new(11, 10),
            AuthorityCell::new(10, 11),
            10.05,
            10.05,
        ),
        (
            2,
            1,
            -1,
            AuthorityCell::new(11, 9),
            AuthorityCell::new(11, 10),
            AuthorityCell::new(10, 9),
            10.05,
            10.95,
        ),
        (
            3,
            -1,
            1,
            AuthorityCell::new(9, 11),
            AuthorityCell::new(9, 10),
            AuthorityCell::new(10, 11),
            10.95,
            10.05,
        ),
        (
            4,
            -1,
            -1,
            AuthorityCell::new(9, 9),
            AuthorityCell::new(9, 10),
            AuthorityCell::new(10, 9),
            10.95,
            10.95,
        ),
    ] {
        let mut snapshot = crate::authority_test_slice();
        snapshot.actors.clear();
        snapshot.npc_jobs.clear();
        snapshot.props.clear();
        snapshot.blocked_cells.clear();
        snapshot.actors.push(test_actor(
            "player",
            "Field Observer",
            "player",
            CellSnapshot::new(10, 10),
            "right",
        ));
        for cell in [blocked_cell, x_slide_cell, y_slide_cell] {
            snapshot.blocked_cells.push(crate::BlockedCellSnapshot::new(
                crate::AUTHORITY_TEST_AREA_ID,
                cell.x,
                cell.y,
            ));
        }
        let mut state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
        let start_position = AuthorityPosition::from_world(start_x, start_y).unwrap();
        {
            let actor = state.actors.get_mut("player").unwrap();
            actor.position = start_position;
            actor.cell = start_position.cell();
        }

        let output = state.apply_envelope(
            &config,
            command(
                command_id,
                ClientCommand::Move {
                    dx,
                    dy,
                    duration_ticks: 30,
                    facing: None,
                    sprint: false,
                },
            ),
        );

        assert_eq!(output.status, AuthorityCommandStatus::Accepted);
        assert_eq!(output.reason_code.as_deref(), None);
        let actor = state.actors.get("player").unwrap();
        // Cell ownership follows the resolved stored anchor, not its center.
        assert_eq!(actor.cell, actor.position.cell());
        assert!(!state.circle_position_blocked(&actor.area_id, actor.position));
    }
}

#[test]
fn authority_accepts_normalized_diagonal_move() {
    let config = SliceAuthorityConfig::default();
    let snapshot = crate::authority_test_slice();
    let mut state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();

    let output = state.apply_envelope(
        &config,
        command(
            1,
            ClientCommand::Move {
                dx: 1,
                dy: -1,
                duration_ticks: 3,
                facing: Some(CardinalDirection::Back),
                sprint: false,
            },
        ),
    );

    assert_eq!(output.status, AuthorityCommandStatus::Accepted);
    let actor = output.actor.unwrap();
    assert_actor_position(&actor, 37.095, 20.905);
    assert_eq!(actor.direction, "back");
}

#[test]
fn authority_normal_movement_is_action_free() {
    let config = SliceAuthorityConfig::default();
    let snapshot = crate::authority_test_slice();
    let mut state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    let before = state.actor_snapshot(&config.player_actor_id).unwrap();

    let output = state.apply_envelope(
        &config,
        command(
            1,
            ClientCommand::Move {
                dx: 1,
                dy: 0,
                duration_ticks: 10,
                facing: None,
                sprint: false,
            },
        ),
    );

    assert_eq!(output.status, AuthorityCommandStatus::Accepted);
    let after = state.actor_snapshot(&config.player_actor_id).unwrap();
    assert!(after.x > before.x);
    assert_eq!(after.vitals.action, before.vitals.action);
}

#[test]
fn authority_sprint_uses_fractional_action_cost_for_smooth_moves() {
    let config = SliceAuthorityConfig::default();
    let snapshot = crate::authority_test_slice();
    let mut state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    let before = state.actor_snapshot(&config.player_actor_id).unwrap();

    for command_id in 1..=6 {
        let output = state.apply_envelope(
            &config,
            command(
                command_id,
                ClientCommand::Move {
                    dx: 1,
                    dy: 0,
                    duration_ticks: 1,
                    facing: None,
                    sprint: true,
                },
            ),
        );
        assert_eq!(output.status, AuthorityCommandStatus::Accepted);
        if command_id < 6 {
            state.advance_ticks_for_observer(&config, 1);
        }
    }

    let after = state.actor_snapshot(&config.player_actor_id).unwrap();
    assert!(after.x > before.x + 0.5);
    assert_eq!(
        after.vitals.action,
        before.vitals.action - (sprint_action_cost_milli(1, 30) * 6) / 1_000
    );
    assert_eq!(
        state
            .actors
            .get(&config.player_actor_id)
            .unwrap()
            .sprint_action_drain_milli,
        (sprint_action_cost_milli(1, 30) * 6) % 1_000
    );
}

#[test]
fn authority_sprint_spends_action_for_faster_move() {
    let config = SliceAuthorityConfig::default();
    let snapshot = crate::authority_test_slice();
    let mut state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    let before = state.actor_snapshot(&config.player_actor_id).unwrap();

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
    let after = state.actor_snapshot(&config.player_actor_id).unwrap();
    assert!(
        after.x > before.x + 0.5,
        "sprint should exceed normal three-tick movement"
    );
    assert_eq!(
        after.vitals.action,
        before.vitals.action - sprint_action_cost_milli(6, 30) / 1_000
    );
}

#[test]
fn authority_regenerates_sprint_action_to_spawn_capacity() {
    let config = SliceAuthorityConfig::default();
    let snapshot = crate::authority_test_slice();
    let mut state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    let before = state.actor_snapshot(&config.player_actor_id).unwrap();

    state.apply_envelope(
        &config,
        command(
            1,
            ClientCommand::Move {
                dx: 1,
                dy: 0,
                // 15 ticks @ 30Hz drains 5000 milli = 5 action points under
                // SPRINT_ACTION_DRAIN_PER_SECOND=10. Verifies sprint cost + regen
                // back to spawn capacity under the current drain rate.
                duration_ticks: 15,
                facing: None,
                sprint: true,
            },
        ),
    );
    assert!(
        state
            .actor_snapshot(&config.player_actor_id)
            .unwrap()
            .vitals
            .action
            < before.vitals.action
    );

    // Action regen is slower than sprint drain; advance well past full recovery.
    // regen_vital caps at spawn capacity, so over-advancing is safe.
    for _ in 0..20 {
        state.advance_ticks_for_observer(&config, 30);
    }

    assert_eq!(
        state
            .actor_snapshot(&config.player_actor_id)
            .unwrap()
            .vitals
            .action,
        before.vitals.action
    );
}

#[test]
fn authority_action_regen_uses_fast_combat_tuning() {
    let config = SliceAuthorityConfig::default();
    let snapshot = crate::authority_test_slice();
    let state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    let actor = state.actors.get(&config.player_actor_id).unwrap();
    let body = actor.effective_stats.traits.body;
    let expected_base = 450 + div_round_nearest_i32(body.saturating_mul(195), 10);

    assert_eq!(
        actor.effective_stats.regen_rates_milli_per_second.action,
        expected_base.saturating_mul(ACTION_REGEN_RATE_MULTIPLIER)
    );
    assert!(
        actor.effective_stats.regen_rates_milli_per_second.action
            > SPRINT_ACTION_DRAIN_PER_SECOND.saturating_mul(1_000),
        "passive action regen should now recover faster than sprint drain once sprinting stops"
    );
}

#[test]
fn authority_action_regen_continues_while_bleeding() {
    let config = SliceAuthorityConfig::default();
    let snapshot = crate::authority_test_slice();
    let mut state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    {
        let actor = state.actors.get_mut(&config.player_actor_id).unwrap();
        actor.vitals.health = 50;
        actor.vitals.action = 0;
        actor.bleed_stacks.push(BleedStackAuthorityState {
            damage_milli_per_tick: 0,
            accumulated_damage_milli: 0,
            source_actor_id: "bleed-source".to_owned(),
            remaining_ticks: 120,
        });
    }

    state.advance_ticks_for_observer(&config, 30);
    let actor = state.actor_snapshot(&config.player_actor_id).unwrap();

    assert_eq!(
        actor.vitals.health, 50,
        "bleeding should still block passive health regeneration"
    );
    assert!(
        actor.vitals.action > 0,
        "bleeding must not pin action at zero and strand combat actors under fire"
    );
}

#[test]
fn authority_sprint_pauses_action_regen_until_move_duration_finishes() {
    let config = SliceAuthorityConfig::default();
    let snapshot = crate::authority_test_slice();
    let mut state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    let before = state.actor_snapshot(&config.player_actor_id).unwrap();

    let output = state.apply_envelope(
        &config,
        command(
            1,
            ClientCommand::Move {
                dx: 1,
                dy: 0,
                duration_ticks: 30,
                facing: None,
                sprint: true,
            },
        ),
    );

    assert_eq!(output.status, AuthorityCommandStatus::Accepted);
    let after_sprint = state.actor_snapshot(&config.player_actor_id).unwrap();
    assert_eq!(
        after_sprint.vitals.action,
        before.vitals.action - sprint_action_cost_milli(30, 30) / 1_000
    );

    state.advance_ticks_for_observer(&config, 1);

    assert_eq!(
        state
            .actor_snapshot(&config.player_actor_id)
            .unwrap()
            .vitals
            .action,
        after_sprint.vitals.action
    );
}

#[test]
fn authority_sprint_regen_stays_paused_between_short_move_packets() {
    let config = SliceAuthorityConfig::default();
    let snapshot = crate::authority_test_slice();
    let mut state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    state.tick = 100;
    let tick_rate_hz = state.tick_rate_hz.max(1);
    {
        let actor = state.actors.get_mut(&config.player_actor_id).unwrap();
        actor.vitals.action = 50;
        let divisor = i32::try_from(tick_rate_hz)
            .unwrap_or(i32::MAX)
            .saturating_mul(1_000)
            .max(1);
        actor.passive_regen_milli.action =
            divisor.saturating_sub(actor.effective_stats.regen_rates_milli_per_second.action);
    }

    let output = state.apply_live_envelope(
        &config,
        ClientCommandEnvelope {
            session: config.session,
            player: config.player,
            command_id: 71,
            issued_at_tick: state.tick,
            command: ClientCommand::Move {
                dx: 1,
                dy: 0,
                duration_ticks: 1,
                facing: None,
                sprint: true,
            },
        },
    );

    assert_eq!(output.status, AuthorityCommandStatus::Accepted);
    let action_after_sprint = state
        .actor_snapshot(&config.player_actor_id)
        .unwrap()
        .vitals
        .action;
    for _ in 0..=SPRINT_REGEN_BLOCK_GRACE_TICKS {
        state.advance_ticks_for_observer(&config, 1);
    }
    assert_eq!(
        state
            .actor_snapshot(&config.player_actor_id)
            .unwrap()
            .vitals
            .action,
        action_after_sprint,
        "short sprint move packets should pause regen across ordinary packet gaps"
    );

    state.advance_ticks_for_observer(&config, 1);
    assert!(
        state
            .actor_snapshot(&config.player_actor_id)
            .unwrap()
            .vitals
            .action
            > action_after_sprint,
        "regen should resume once the sprint grace window ends"
    );
}

#[test]
fn authority_rate_limits_rapid_axis_switch_move_commands() {
    let config = SliceAuthorityConfig::default();
    let snapshot = crate::authority_test_slice();
    let mut state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();

    let first = state.apply_envelope(
        &config,
        command(
            1,
            ClientCommand::Move {
                dx: 1,
                dy: 0,
                duration_ticks: 5,
                facing: None,
                sprint: false,
            },
        ),
    );
    let second = state.apply_envelope(
        &config,
        command(
            2,
            ClientCommand::Move {
                dx: 0,
                dy: -1,
                duration_ticks: 5,
                facing: None,
                sprint: false,
            },
        ),
    );

    assert_eq!(first.status, AuthorityCommandStatus::Accepted);
    assert_eq!(second.status, AuthorityCommandStatus::Rejected);
    assert_eq!(second.reason_code.as_deref(), Some("move_cooldown"));
    let after_rejected = state.actor_snapshot(&config.player_actor_id).unwrap();
    assert_actor_position(&after_rejected, 37.226, 21.0);

    state.advance_ticks_for_observer(&config, 3);
    let accepted_after_cooldown = state.apply_envelope(
        &config,
        command(
            3,
            ClientCommand::Move {
                dx: 0,
                dy: -1,
                duration_ticks: 5,
                facing: None,
                sprint: false,
            },
        ),
    );

    assert_eq!(
        accepted_after_cooldown.status,
        AuthorityCommandStatus::Accepted
    );
    let final_actor = state.actor_snapshot(&config.player_actor_id).unwrap();
    assert_actor_position(&final_actor, 37.226, 20.774);
}

#[test]
fn authority_set_move_intent_moves_only_on_fixed_ticks() {
    let config = SliceAuthorityConfig::default();
    let mut snapshot = crate::authority_test_slice();
    snapshot.blocked_cells.clear();
    snapshot.props.clear();
    snapshot.npc_jobs.clear();
    let mut state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    state.tick = 100;
    place_actor_at_position(
        &mut state,
        &config.player_actor_id,
        AuthorityPosition {
            x: 10_000,
            y: 10_000,
        },
    );
    let before = state.actor_snapshot(&config.player_actor_id).unwrap();

    let frame = state.apply_live_envelope(
        &config,
        move_intent_command(&config, 20_001, state.tick, 1, 0, false),
    );

    assert_eq!(frame.status, AuthorityCommandStatus::Accepted);
    let after_ingress = state.actor_snapshot(&config.player_actor_id).unwrap();
    assert_eq!(
        (after_ingress.x, after_ingress.y),
        (before.x, before.y),
        "live command ingress must only store held intent; movement is owned by the fixed tick"
    );
    assert!(state
        .actors
        .get(&config.player_actor_id)
        .unwrap()
        .move_intent
        .is_some());

    state.advance_ticks_for_observer(&config, 1);
    let after_tick = state.actor_snapshot(&config.player_actor_id).unwrap();
    assert!(after_tick.x > before.x);
    assert_eq!(after_tick.y, before.y);
    let actor = state.actors.get(&config.player_actor_id).unwrap();
    assert_eq!(actor.next_move_tick, state.tick.saturating_add(1));
}

#[test]
fn authority_set_move_intent_stop_clears_fixed_tick_motion() {
    let config = SliceAuthorityConfig::default();
    let mut snapshot = crate::authority_test_slice();
    snapshot.blocked_cells.clear();
    snapshot.props.clear();
    snapshot.npc_jobs.clear();
    let mut state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    state.tick = 100;
    place_actor_at_position(
        &mut state,
        &config.player_actor_id,
        AuthorityPosition {
            x: 10_000,
            y: 10_000,
        },
    );
    assert_eq!(
        state
            .apply_live_envelope(
                &config,
                move_intent_command(&config, 21_001, state.tick, 1, 0, false),
            )
            .status,
        AuthorityCommandStatus::Accepted
    );
    state.advance_ticks_for_observer(&config, 1);
    let moving_position = state.actor_snapshot(&config.player_actor_id).unwrap();
    assert!(moving_position.x > 10.0);

    assert_eq!(
        state
            .apply_live_envelope(
                &config,
                move_intent_command(&config, 21_002, state.tick, 0, 0, false),
            )
            .status,
        AuthorityCommandStatus::Accepted
    );
    assert!(state
        .actors
        .get(&config.player_actor_id)
        .unwrap()
        .move_intent
        .is_none());
    let stopped_position = state.actor_snapshot(&config.player_actor_id).unwrap();

    state.advance_ticks_for_observer(&config, 3);
    let after_stop_ticks = state.actor_snapshot(&config.player_actor_id).unwrap();
    assert_eq!(
        (after_stop_ticks.x, after_stop_ticks.y),
        (stopped_position.x, stopped_position.y),
        "zero-vector intent ends the stream without queuing synthetic Move packets"
    );
}

#[test]
fn authority_set_move_intent_flip_storm_never_move_cooldown_rejects() {
    let config = SliceAuthorityConfig::default();
    let mut snapshot = crate::authority_test_slice();
    snapshot.blocked_cells.clear();
    snapshot.props.clear();
    snapshot.npc_jobs.clear();
    let mut state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    state.tick = 100;
    place_actor_at_position(
        &mut state,
        &config.player_actor_id,
        AuthorityPosition {
            x: 10_000,
            y: 10_000,
        },
    );
    let directions = [(1, 0), (0, -1), (-1, 0), (0, 1), (1, 1), (-1, -1)];

    for step in 0..72 {
        let (dx, dy) = directions[step % directions.len()];
        let frame = state.apply_live_envelope(
            &config,
            move_intent_command(
                &config,
                22_000 + step as u64,
                state.tick,
                dx,
                dy,
                step % 3 == 0,
            ),
        );
        assert_eq!(
            frame.status,
            AuthorityCommandStatus::Accepted,
            "held-intent flip {step} should not interact with Move cooldown; reason={:?}",
            frame.reason_code
        );
        assert_ne!(frame.reason_code.as_deref(), Some("move_cooldown"));
        if step % 2 == 0 {
            state.advance_ticks_for_observer(&config, 1);
        }
        assert!(
            state
                .actors
                .get(&config.player_actor_id)
                .unwrap()
                .next_move_tick
                <= state.tick.saturating_add(1),
            "fixed tick integration owns window advancement, not command ingress"
        );
    }
}

#[test]
fn authority_accepts_one_tick_early_move_when_issued_tick_reaches_cooldown() {
    let config = SliceAuthorityConfig::default();
    let snapshot = crate::authority_test_slice();
    let mut state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    state.tick = 100;
    {
        let actor = state.actors.get_mut(&config.player_actor_id).unwrap();
        actor.next_move_tick = 101;
    }

    let frame = state.apply_envelope(
        &config,
        ClientCommandEnvelope {
            session: config.session,
            player: config.player,
            command_id: 9_001,
            issued_at_tick: 101,
            command: ClientCommand::Move {
                dx: 1,
                dy: 0,
                duration_ticks: 1,
                facing: None,
                sprint: false,
            },
        },
    );

    assert_eq!(
        frame.status,
        AuthorityCommandStatus::Accepted,
        "a valid 30Hz command that arrives just before the Rust tick flush should not become move_cooldown"
    );
    assert_eq!(
        state
            .actors
            .get(&config.player_actor_id)
            .unwrap()
            .next_move_tick,
        102
    );
}

#[test]
fn authority_accepts_paced_sprint_move_burst_within_hitch_window() {
    let config = SliceAuthorityConfig::default();
    let mut snapshot = crate::authority_test_slice();
    snapshot.blocked_cells.clear();
    snapshot.props.clear();
    let mut state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    place_actor_at_position(
        &mut state,
        &config.player_actor_id,
        AuthorityPosition {
            x: 10_000,
            y: 10_000,
        },
    );
    state.tick = 100;

    let sprint_move = |command_id: u64, issued_at_tick: u64| ClientCommandEnvelope {
        session: config.session,
        player: config.player,
        command_id,
        issued_at_tick,
        command: ClientCommand::Move {
            dx: 1,
            dy: 0,
            duration_ticks: 2,
            facing: None,
            sprint: true,
        },
    };

    for (command_id, issued_at_tick) in [(1, 100), (2, 102), (3, 104), (4, 106)] {
        let frame = state.apply_live_envelope(&config, sprint_move(command_id, issued_at_tick));
        assert_eq!(
            frame.status,
            AuthorityCommandStatus::Accepted,
            "paced sprint command {command_id} at issued tick {issued_at_tick} should survive one same-tick transport burst; reason={:?}",
            frame.reason_code
        );
    }
    assert_eq!(
        state
            .actors
            .get(&config.player_actor_id)
            .unwrap()
            .next_move_tick,
        108
    );

    let before_rejected = state.actor_snapshot(&config.player_actor_id).unwrap();
    let over_budget = state.apply_live_envelope(&config, sprint_move(5, 108));
    assert_eq!(over_budget.status, AuthorityCommandStatus::Rejected);
    assert_eq!(over_budget.reason_code.as_deref(), Some("move_cooldown"));
    let after_rejected = state.actor_snapshot(&config.player_actor_id).unwrap();
    assert_eq!(
        (after_rejected.x, after_rejected.y),
        (before_rejected.x, before_rejected.y)
    );
}

#[test]
fn authority_ticks_route_patrols_in_rust() {
    let config = SliceAuthorityConfig::default();
    let mut snapshot = crate::authority_test_slice();
    snapshot.npc_jobs.clear();
    let mut state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    let before = state.actor_snapshot("runner").unwrap();
    assert_actor_position(&before, 24.0, 22.0);

    state.advance_ticks_for_observer(
        &config,
        u16::try_from(ROUTE_PATROL_UPDATE_CADENCE_TICKS).unwrap(),
    );
    let partial = state.actor_snapshot("runner").unwrap();
    assert!(
        partial.x > 24.0 && partial.x < 25.0,
        "route patrol should advance smoothly between cells, got {}",
        partial.x
    );

    state.advance_ticks_for_observer(
        &config,
        u16::try_from(NPC_ROUTE_STEP_INTERVAL_TICKS - ROUTE_PATROL_UPDATE_CADENCE_TICKS).unwrap(),
    );
    let first = state.actor_snapshot("runner").unwrap();
    assert!(
        (first.x - 25.0).abs() < 0.01 && (first.y - 22.0).abs() < 0.001,
        "expected smooth route actor near (25, 22), got ({}, {})",
        first.x,
        first.y
    );
    assert_eq!(first.direction, "right");

    for _ in 0..3 {
        state.advance_ticks_for_observer(
            &config,
            u16::try_from(NPC_ROUTE_STEP_INTERVAL_TICKS).unwrap(),
        );
    }
    let later = state.actor_snapshot("runner").unwrap();
    assert_actor_position(&later, 28.0, 22.0);
}

#[test]
fn authority_batched_odd_tick_output_includes_routine_motion_snapshot() {
    let config = SliceAuthorityConfig::default();
    let mut snapshot = crate::authority_test_slice();
    snapshot.npc_jobs.clear();
    let mut state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();

    let (actors, _events) =
        state.advance_ticks_with_changed_actor_snapshots_for_observer(&config, 3);
    assert_eq!(state.tick() % 2, 1);
    let runner = actors.iter().find(|actor| actor.id == "runner").expect(
        "batched live bridge output should include moved route actor even on odd final tick",
    );
    assert!(
        runner.x > 24.0 && runner.x < 25.0,
        "runner should be delivered at its smooth partial route position, got ({}, {})",
        runner.x,
        runner.y
    );
}

#[test]
fn authority_route_patrols_hold_cardinal_segments_between_corners() {
    let config = SliceAuthorityConfig::default();
    let mut snapshot = crate::authority_test_slice();
    snapshot.actors.clear();
    snapshot.npc_jobs.clear();

    let mut actor = test_actor(
        "corner-patrol",
        "Corner Patrol",
        "social_npc",
        CellSnapshot::new(22, 16),
        "front",
    );
    actor.route = vec![CellSnapshot::new(22, 19), CellSnapshot::new(16, 19)];
    snapshot.actors.push(actor);

    let mut state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    state.advance_ticks_for_observer(
        &config,
        u16::try_from(NPC_ROUTE_STEP_INTERVAL_TICKS).unwrap(),
    );
    let vertical = state.actor_snapshot("corner-patrol").unwrap();
    assert!(
        (vertical.x - 22.0).abs() < 0.001 && vertical.y > 16.0 && vertical.y < 19.0,
        "route patrol should stay on the vertical segment before the corner, got ({}, {})",
        vertical.x,
        vertical.y
    );

    for _ in 0..2 {
        state.advance_ticks_for_observer(
            &config,
            u16::try_from(NPC_ROUTE_STEP_INTERVAL_TICKS).unwrap(),
        );
    }
    let corner = state.actor_snapshot("corner-patrol").unwrap();
    assert_actor_position(&corner, 22.0, 19.0);

    state.advance_ticks_for_observer(
        &config,
        u16::try_from(ROUTE_PATROL_UPDATE_CADENCE_TICKS).unwrap(),
    );
    let horizontal = state.actor_snapshot("corner-patrol").unwrap();
    assert!(
        horizontal.x < 22.0 && horizontal.x > 21.0 && (horizontal.y - 19.0).abs() < 0.001,
        "route patrol should stay on the horizontal segment after the corner, got ({}, {})",
        horizontal.x,
        horizontal.y
    );
}

#[test]
fn authority_route_patrol_wraps_without_shortcutting() {
    let config = SliceAuthorityConfig::default();
    let mut snapshot = crate::authority_test_slice();
    snapshot.actors.clear();
    snapshot.npc_jobs.clear();

    let mut actor = test_actor(
        "rectangle-patrol",
        "Rectangle Patrol",
        "social_npc",
        CellSnapshot::new(30, 18),
        "right",
    );
    actor.route = vec![
        CellSnapshot::new(30, 18),
        CellSnapshot::new(34, 18),
        CellSnapshot::new(34, 21),
        CellSnapshot::new(30, 21),
    ];
    snapshot.actors.push(actor);

    let mut state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    let mut previous = state.actor_snapshot("rectangle-patrol").unwrap();
    for _ in 0..220 {
        state.advance_ticks_for_observer(&config, 1);
        let current = state.actor_snapshot("rectangle-patrol").unwrap();
        let dx = (current.x - previous.x).abs();
        let dy = (current.y - previous.y).abs();
        assert!(
            dx <= 0.18 && dy <= 0.18,
            "route patrol should not skip delivered authority positions, moved dx={dx}, dy={dy}"
        );
        assert!(
            dx <= 0.001 || dy <= 0.001,
            "route patrol should stay cardinal through route wrap, moved dx={dx}, dy={dy}"
        );
        previous = current;
    }
}

#[test]
fn authority_ticks_passive_creatures_roam_without_grid_bounce() {
    let config = SliceAuthorityConfig::default();
    let mut snapshot = crate::authority_test_slice();
    snapshot.actors.clear();
    snapshot.npc_jobs.clear();
    snapshot.actors.push(test_actor(
        "ambient-creature",
        "Ambient Creature",
        "creature",
        CellSnapshot::new(50, 30),
        "front",
    ));
    let mut state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    let before = state.actor_snapshot("ambient-creature").unwrap();
    assert_actor_position(&before, 50.0, 30.0);

    let mut positions = Vec::new();
    for _ in 0..120 {
        state.advance_ticks_for_observer(&config, 1);
        let actor = state.actor_snapshot("ambient-creature").unwrap();
        positions.push((actor.x, actor.y));
    }

    assert!(positions
        .iter()
        .any(|(x, y)| { (x - x.round()).abs() > 0.001 || (y - y.round()).abs() > 0.001 }));
    let unique_cells = positions
        .iter()
        .map(|(x, y)| (x.floor() as i32, y.floor() as i32))
        .collect::<std::collections::BTreeSet<_>>();
    assert!(
        unique_cells.len() >= 2,
        "expected ambient creature to keep roaming across cells, got {unique_cells:?}"
    );
}

#[test]
fn authority_timed_passive_creature_respawn_ignores_clone_facility() {
    let config = SliceAuthorityConfig::default();
    let mut snapshot = crate::authority_test_slice();
    snapshot.actors.clear();
    snapshot.npc_jobs.clear();
    snapshot
        .clone_facilities
        .push(crate::CloneFacilitySnapshot {
            id: "desert-warden-field-cloner".to_owned(),
            label: "Desert Warden Field Cloner".to_owned(),
            area_id: "authority-test-overworld".to_owned(),
            respawn_cell: CellSnapshot::new(30, 18),
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
    let mut state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    let start_tick = state.tick();
    let tick_rate_hz = state.tick_rate_hz;
    let body_vanish_tick = {
        let actor = state.actors.get_mut("respawned-creature").unwrap();
        SliceAuthorityState::kill_actor_for_respawn(start_tick, tick_rate_hz, actor);
        assert!(actor.body_vanish_tick > start_tick);
        assert_eq!(actor.respawn_tick, 0);
        actor.body_vanish_tick
    };

    let body_vanish_delta = body_vanish_tick
        .saturating_sub(state.tick())
        .saturating_add(1);
    advance_ticks_unclamped(&mut state, &config, body_vanish_delta);
    let respawn_tick = {
        let hidden = state.actors.get("respawned-creature").unwrap();
        assert_eq!(hidden.life_state, AuthorityLifeState::Respawning);
        assert!(hidden.respawn_tick > state.tick());
        hidden.respawn_tick
    };
    let respawn_delta = respawn_tick.saturating_sub(state.tick()).saturating_add(1);
    advance_ticks_unclamped(&mut state, &config, respawn_delta);
    let respawned = state.actors.get("respawned-creature").unwrap();
    assert_eq!(respawned.life_state, AuthorityLifeState::Alive);
    assert_eq!(respawned.area_id, "authority-test-overworld");
    assert_ne!(respawned.cell, AuthorityCell::new(30, 18));
    assert!(
        position_distance_milli(
            respawned.position,
            AuthorityPosition::from_cell(respawned.home_cell)
        ) < 3_000,
        "PassiveCreature timed respawn should return near authored home, not the field cloner"
    );
    assert_eq!(respawned.clone_sickness_ticks, 0);
    assert!(respawned.respawn_return.is_empty());
    assert!(matches!(
        respawned.ai,
        Some(AuthorityAiState::PassiveCreature(PassiveCreatureAiState {
            mode: PassiveCreatureMode::Idle | PassiveCreatureMode::Roam,
            ..
        }))
    ));
}

#[test]
fn authority_weather_hazard_accumulates_exact_tick_damage_for_player() {
    let (config, mut state) = weather_test_state("player");
    let hazard = weather_test_hazard(Vec::new());

    state.advance_ticks_for_observer_with_weather_hazards(&config, 3, &[hazard]);

    assert_eq!(player_health(&state), 97);
}

#[test]
fn authority_weather_hazard_exempts_actor_inside_shelter_box() {
    let (config, mut state) = weather_test_state("player");
    let shelter = AuthorityWeatherShelterBox {
        min_x_milli: 9_000,
        min_y_milli: 9_000,
        max_x_milli: 11_000,
        max_y_milli: 11_000,
    };
    let hazard = weather_test_hazard(vec![shelter]);

    state.advance_ticks_for_observer_with_weather_hazards(&config, 3, &[hazard]);

    assert_eq!(player_health(&state), 100);
}

#[test]
fn authority_weather_hazard_exempts_downed_actor() {
    let (config, mut state) = weather_test_state("player");
    {
        let actor = state.actors.get_mut("player").unwrap();
        actor.life_state = AuthorityLifeState::Downed;
        actor.body_vanish_tick = 9_999;
        actor.respawn_tick = 9_999;
    }
    let hazard = weather_test_hazard(Vec::new());

    state.advance_ticks_for_observer_with_weather_hazards(&config, 3, &[hazard]);

    assert_eq!(player_health(&state), 100);
}

#[test]
fn authority_weather_hazard_exempts_actor_outside_radius() {
    let (config, mut state) = weather_test_state("player");
    let mut hazard = weather_test_hazard(Vec::new());
    hazard.center_x_milli = 20_000;
    hazard.center_y_milli = 20_000;
    hazard.radius_milli = 1_000;

    state.advance_ticks_for_observer_with_weather_hazards(&config, 3, &[hazard]);

    assert_eq!(player_health(&state), 100);
}

#[test]
fn authority_weather_hazard_exempts_service_non_combat_role() {
    let (config, mut state) = weather_test_state("public_shopkeeper");
    let hazard = weather_test_hazard(Vec::new());

    state.advance_ticks_for_observer_with_weather_hazards(&config, 3, &[hazard]);

    assert_eq!(player_health(&state), 100);
}

#[test]
fn authority_suppression_interrupt_does_not_bank_idle_ticks() {
    let config = SliceAuthorityConfig::default();
    let mut snapshot = crate::authority_test_slice();
    snapshot.actors.clear();
    snapshot.npc_jobs.clear();
    snapshot.actors.push(test_actor(
        "aged-creature",
        "Aged Creature",
        "creature",
        CellSnapshot::new(20, 20),
        "left",
    ));
    let mut state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    state.tick = 240;
    let before = state.actors.get("aged-creature").unwrap().position;

    {
        let next_update_tick = state.tick + 120;
        let actor = state.actors.get_mut("aged-creature").unwrap();
        let Some(AuthorityAiState::PassiveCreature(ai)) = actor.ai.as_mut() else {
            panic!("test actor should have PassiveCreature AI");
        };
        ai.mode = PassiveCreatureMode::Idle;
        ai.target = None;
        ai.next_update_tick = next_update_tick;
        ai.last_update_tick = 1;
    }

    state.apply_suppression_to_actor(
        "aged-creature",
        RANGED_SUPPRESSION_THRESHOLD_MILLI,
        AuthorityPosition::from_cell(AuthorityCell::new(18, 20)),
    );
    state.advance_ticks_for_observer(&config, 1);

    let after = state.actors.get("aged-creature").unwrap().position;
    let moved = position_distance_milli(before, after);
    let one_tick_flee = distance_for_ticks(
        PASSIVE_CREATURE_FLEE_SPEED_MILLI_CELLS_PER_SECOND,
        1,
        state.tick_rate_hz,
    );
    assert!(
        moved <= one_tick_flee + 1,
        "suppression interrupt should move one flee tick, not banked idle ticks: moved {moved} milli-cells"
    );
}

#[test]
fn authority_ai_scheduler_does_not_bank_skipped_ticks() {
    let mut next_update_tick = 240;
    let mut last_update_tick = 1;
    let elapsed = scheduled_ai_elapsed_ticks(
        7,
        240,
        AI_UPDATE_CADENCE_TICKS,
        101,
        &mut next_update_tick,
        &mut last_update_tick,
    )
    .unwrap();
    assert_eq!(elapsed, AI_UPDATE_CADENCE_TICKS);

    let mut next_idle_update_tick = 240;
    let mut last_idle_update_tick = 1;
    let idle_elapsed = scheduled_ai_elapsed_ticks(
        7,
        240,
        PASSIVE_CREATURE_IDLE_CADENCE_TICKS,
        101,
        &mut next_idle_update_tick,
        &mut last_idle_update_tick,
    )
    .unwrap();
    assert_eq!(idle_elapsed, PASSIVE_CREATURE_IDLE_CADENCE_TICKS);
}

#[test]
fn authority_expires_inventory_reservations_in_rust_tick() {
    let config = SliceAuthorityConfig::default();
    let snapshot = crate::authority_test_slice();
    let mut state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();

    assert_eq!(state.metrics().reservations, 2);
    assert_eq!(
        state
            .inventory_snapshots()
            .iter()
            .map(|row| row.reserved)
            .sum::<u32>(),
        2
    );

    state.advance_ticks_for_observer(&config, 21);

    assert_eq!(state.metrics().reservations, 0);
    assert_eq!(
        state
            .inventory_snapshots()
            .iter()
            .map(|row| row.reserved)
            .sum::<u32>(),
        0
    );
    assert!(state
        .timeline_event_snapshots()
        .iter()
        .any(|event| event.label == "reservation #1 expired"));
}

#[test]
fn authority_drives_npc_job_movement_in_rust_tick() {
    let config = SliceAuthorityConfig::default();
    let snapshot = crate::authority_test_slice();
    let mut state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();

    let before = state.actor_snapshot("mechanic").unwrap();
    assert_actor_position(&before, 9.0, 5.0);

    state.advance_ticks_for_observer(
        &config,
        u16::try_from(NPC_ROUTE_STEP_INTERVAL_TICKS).unwrap(),
    );
    let first = state.actor_snapshot("mechanic").unwrap();
    assert_actor_position(&first, 8.0, 5.0);
    assert_eq!(first.direction, "left");
    assert_eq!(
        state
            .npc_job_snapshots()
            .iter()
            .find(|job| job.actor == "mechanic")
            .unwrap()
            .state,
        "moving"
    );

    for _ in 0..6 {
        state.advance_ticks_for_observer(
            &config,
            u16::try_from(NPC_ROUTE_STEP_INTERVAL_TICKS).unwrap(),
        );
    }
    let done = state.actor_snapshot("mechanic").unwrap();
    assert_actor_position(&done, 3.0, 4.0);
    assert_eq!(
        state
            .npc_job_snapshots()
            .iter()
            .find(|job| job.actor == "mechanic")
            .unwrap()
            .state,
        "working"
    );
}

#[test]
fn authority_rejects_invalid_duplicate_and_unready_transition_commands() {
    let config = SliceAuthorityConfig::default();
    let snapshot = crate::authority_test_slice();
    let mut state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();

    let transition = state.apply_envelope(
        &config,
        command(
            1,
            ClientCommand::EnterTransition {
                transition_id: "test-workshop-entry".to_owned(),
            },
        ),
    );
    assert_eq!(transition.status, AuthorityCommandStatus::Rejected);
    assert_eq!(
        transition.reason_code.as_deref(),
        Some("not_at_transition_trigger")
    );

    let invalid_vector = state.apply_envelope(
        &config,
        command(
            2,
            ClientCommand::Move {
                dx: 2,
                dy: 0,
                duration_ticks: 1,
                facing: None,
                sprint: false,
            },
        ),
    );
    assert_eq!(invalid_vector.status, AuthorityCommandStatus::Rejected);
    assert_eq!(
        invalid_vector.reason_code.as_deref(),
        Some("invalid_move_vector")
    );

    let duplicate = state.apply_envelope(
        &config,
        command(
            2,
            ClientCommand::Move {
                dx: 1,
                dy: 0,
                duration_ticks: 1,
                facing: None,
                sprint: false,
            },
        ),
    );
    assert_eq!(duplicate.status, AuthorityCommandStatus::Rejected);
    assert_eq!(duplicate.reason_code.as_deref(), Some("duplicate_command"));

    let second_session_config = SliceAuthorityConfig {
        session: SessionId(2),
        ..config.clone()
    };
    let mut second_session_command = command(
        2,
        ClientCommand::Move {
            dx: 0,
            dy: 1,
            duration_ticks: 1,
            facing: None,
            sprint: false,
        },
    );
    second_session_command.session = SessionId(2);
    let second_session_result =
        state.apply_envelope(&second_session_config, second_session_command);
    assert_eq!(
        second_session_result.status,
        AuthorityCommandStatus::Accepted
    );
}

#[test]
fn authority_transitions_when_actor_reaches_trigger_cell() {
    let config = SliceAuthorityConfig::default();
    let snapshot = crate::authority_test_slice();
    let mut state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();

    for envelope in transition_script() {
        state.apply_envelope(&config, envelope);
    }

    let actor = state.actor_snapshot("player").unwrap();
    assert_eq!(actor.area_id, "authority-test-workshop");
    assert_eq!(actor.direction, "back");
}

#[test]
fn authority_transition_preserves_character_state_and_checkpoint_roundtrip() {
    let config = SliceAuthorityConfig::default();
    let mut state = SliceAuthorityState::from_snapshot(&crate::authority_test_slice()).unwrap();
    {
        let actor = state.actors.get_mut("player").unwrap();
        actor.vitals.health = actor.vitals.health.saturating_sub(17);
        actor.vitals.action = actor.vitals.action.saturating_sub(9);
        actor.professions.credits = 7_654;
        actor
            .professions
            .track_xp
            .insert("scout:sprinting".to_owned(), 321);
        actor.known_recipe_ids.insert("travel-proof-recipe".to_owned());
        actor.scanned_genomes.insert(0xfeed_beef);
    }
    let skill = state.apply_envelope(
        &config,
        command(
            1,
            ClientCommand::DebugGrantSkillBoxes {
                skill_box_ids: vec!["scout-novice".to_owned()],
            },
        ),
    );
    let item = state.apply_envelope(
        &config,
        command(
            2,
            ClientCommand::DebugGiveItem {
                item_id: PLASMA_SWORD_ITEM_ID,
                variant_id: 42,
                quantity: 2,
                equip: true,
            },
        ),
    );
    assert_eq!(skill.status, AuthorityCommandStatus::Accepted);
    assert_eq!(item.status, AuthorityCommandStatus::Accepted);

    move_actor_to_cell_for_test(&mut state, "player", AuthorityCell::new(39, 20));
    let transition = state.transitions["test-workshop-entry"].clone();
    let actor_before = state.actors["player"].clone();
    let vitals_before = actor_before.vitals;
    let inventory_before = state.inventory.clone();
    let mut expected_actor = actor_before;
    expected_actor.area_id = transition.to_area_id.clone();
    expected_actor.cell = transition.to_cell;
    expected_actor.position = AuthorityPosition::from_cell(transition.to_cell);
    expected_actor.direction = transition.to_facing.clone();
    expected_actor.pending_resource_sample = None;
    expected_actor.resource_sample_loop = None;

    let output = state.apply_envelope(
        &config,
        command(
            3,
            ClientCommand::EnterTransition {
                transition_id: transition.id,
            },
        ),
    );
    assert_eq!(output.status, AuthorityCommandStatus::Accepted);
    let actor_after = state.actors["player"].clone();
    assert_eq!(actor_after.vitals.health, vitals_before.health);
    assert_eq!(actor_after.vitals.spirit, vitals_before.spirit);
    assert!(
        actor_after.vitals.action >= vitals_before.action
            && actor_after.vitals.action <= vitals_before.action.saturating_add(1),
        "the ordinary authority regen step may recover at most one action point"
    );
    // Every accepted command runs the normal passive-regen accumulator. Ignore
    // only those two clock-driven fields in the structural transition check.
    expected_actor.vitals = actor_after.vitals;
    expected_actor.passive_regen_milli = actor_after.passive_regen_milli;
    assert_eq!(
        actor_after, expected_actor,
        "a portal transition may only change spatial state and cancel resource sampling"
    );
    assert_eq!(
        state.inventory, inventory_before,
        "inventory must remain byte-for-byte unchanged across a portal transition"
    );

    let saved_hash = state.stable_state_hash_hex();
    let encoded = serde_json::to_string(&state.export_checkpoint())
        .expect("transition checkpoint serializes");
    let checkpoint: AuthorityCheckpointBlob =
        serde_json::from_str(&encoded).expect("transition checkpoint deserializes");
    let restored = restore_checkpoint_for_test(&state, checkpoint);
    assert_eq!(restored.stable_state_hash_hex(), saved_hash);
    assert_eq!(restored.actors["player"], expected_actor);
    assert_eq!(restored.inventory, inventory_before);
}

#[test]
fn authority_transition_into_occupied_destination_succeeds() {
    let config = SliceAuthorityConfig::default();
    let mut snapshot = crate::authority_test_slice();
    let mut destination_actor = test_actor(
        "transition-destination-actor",
        "Transition Destination Actor",
        "public_shopkeeper",
        CellSnapshot::new(9, 8),
        "left",
    );
    destination_actor.area_id = crate::AUTHORITY_TEST_INTERIOR_ID.to_owned();
    snapshot.actors.push(destination_actor);
    let mut state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    move_actor_to_cell_for_test(&mut state, "player", AuthorityCell::new(39, 20));

    let output = state.apply_envelope(
        &config,
        command(
            1,
            ClientCommand::EnterTransition {
                transition_id: "test-workshop-entry".to_owned(),
            },
        ),
    );

    assert_eq!(output.status, AuthorityCommandStatus::Accepted);
    let player = state.actors.get("player").unwrap();
    let destination_actor = state.actors.get("transition-destination-actor").unwrap();
    assert_eq!(player.area_id, crate::AUTHORITY_TEST_INTERIOR_ID);
    assert_eq!(player.cell, destination_actor.cell);
}

#[test]
fn authority_upsert_actor_allows_occupied_cell() {
    let mut snapshot = crate::authority_test_slice();
    snapshot.actors.clear();
    snapshot.npc_jobs.clear();
    snapshot.props.clear();
    snapshot.blocked_cells.clear();
    snapshot.actors.push(test_actor(
        "existing-actor",
        "Existing Actor",
        "public_shopkeeper",
        CellSnapshot::new(12, 12),
        "left",
    ));
    let mut state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();

    state
        .upsert_actor(AuthorityActorUpsert {
            id: "overlapping-actor".to_owned(),
            entity: "test:overlapping-actor".to_owned(),
            label: Some("Overlapping Actor".to_owned()),
            sprite: None,
            display_name: Some("Overlapping Actor".to_owned()),
            link_dead: false,
            bare_start: false,
            returning: false,
            appearance: None,
            worn: Vec::new(),
            worn_colors: BTreeMap::new(),
            template_id: None,
            spawn_zone_id: None,
            role: "player".to_owned(),
            profession_ids: Vec::new(),
            skill_box_ids: Vec::new(),
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
        })
        .expect("actor upsert onto occupied cell should succeed");

    assert_eq!(
        state.actors.get("overlapping-actor").unwrap().cell,
        state.actors.get("existing-actor").unwrap().cell
    );
}

#[test]
fn authority_bare_start_upsert_strips_owned_inventory_and_default_weapon() {
    let mut state = SliceAuthorityState::from_snapshot(&crate::authority_test_slice()).unwrap();
    state.inventory.push(InventoryStackSnapshot {
        stack_id: 90_001,
        container: "player:field-pack".to_owned(),
        item: inventory_item_name(CRAFTED_SLUGTHROWER_ITEM_ID)
            .unwrap()
            .to_owned(),
        item_id: CRAFTED_SLUGTHROWER_ITEM_ID,
        variant_id: 0,
        quantity: 1,
        reserved: 0,
        available: 1,
    });
    state.inventory.push(InventoryStackSnapshot {
        stack_id: 90_002,
        container: "player/backpack".to_owned(),
        item: inventory_item_name(FIELD_MULTITOOL_ITEM_ID)
            .unwrap()
            .to_owned(),
        item_id: FIELD_MULTITOOL_ITEM_ID,
        variant_id: STARTER_FIELD_MULTITOOL_QUALITY_MILLI,
        quantity: 1,
        reserved: 0,
        available: 1,
    });
    state.inventory.push(InventoryStackSnapshot {
        stack_id: 90_003,
        container: "npc-cache".to_owned(),
        item: inventory_item_name(STIMPAK_A_ITEM_ID).unwrap().to_owned(),
        item_id: STIMPAK_A_ITEM_ID,
        variant_id: 0,
        quantity: 1,
        reserved: 0,
        available: 1,
    });
    state.reservations.push(ReservationSnapshot {
        id: 90_001,
        actor: "player".to_owned(),
        purpose: "bare-start-strip".to_owned(),
        from: "player:field-pack".to_owned(),
        item: inventory_item_name(CRAFTED_SLUGTHROWER_ITEM_ID)
            .unwrap()
            .to_owned(),
        quantity: 1,
        expires_at_tick: None,
    });

    let mut upsert = creator_clothing_upsert(
        vec![AuthorityActorWornPiece {
            item: "top_rigged_tank".to_owned(),
            colors: vec!["#d14b35".to_owned()],
        }],
        BTreeMap::from([("top_rigged_tank".to_owned(), vec!["#d14b35".to_owned()])]),
    );
    upsert.skill_box_ids = vec!["marksman-novice".to_owned()];
    let actor = state
        .upsert_actor(upsert)
        .expect("bare-start player upsert succeeds");

    assert_eq!(
        actor.worn,
        vec![
            AuthorityActorWornPiece {
                item: "under_bodysuit".to_owned(),
                colors: vec!["#89cff0".to_owned()],
            },
            AuthorityActorWornPiece {
                item: "boots_canvas_ankle".to_owned(),
                colors: vec!["#303030".to_owned(), "#808080".to_owned()],
            },
        ],
        "submitted legacy clothing is ignored"
    );
    assert_eq!(
        state.actors["player"].worn_colors,
        BTreeMap::from([
            ("under_bodysuit".to_owned(), vec!["#89cff0".to_owned()]),
            (
                "boots_canvas_ankle".to_owned(),
                vec!["#303030".to_owned(), "#808080".to_owned()],
            ),
        ]),
        "submitted legacy palette metadata is ignored"
    );
    assert!(actor.weapon.is_none());
    assert_eq!(state.actors["player"].professions.skill_points_used(), 16);
    let mut owned = state
        .inventory_snapshots()
        .into_iter()
        .filter(|row| actor_owns_inventory_container("player", &row.container))
        .map(|row| (row.item_id, row.variant_id, row.quantity))
        .collect::<Vec<_>>();
    owned.sort_unstable();
    assert_eq!(
        owned,
        vec![(7_319, 0, 1), (9_900_001, 0, 1)],
        "bare start owns exactly the immutable two-piece starter outfit"
    );
    assert!(state
        .inventory_snapshots()
        .iter()
        .any(|row| row.container == "npc-cache"));
    assert!(state.inventory_snapshots().iter().all(|row| {
        !actor_owns_inventory_container("player", &row.container)
            || matches!(row.item_id, 7_319 | 9_900_001)
    }));
    assert!(state.reservation_snapshots().iter().all(|row| {
        row.actor != "player" && !actor_owns_inventory_container("player", &row.from)
    }));
}

#[test]
fn authority_bare_start_retains_selected_profession_without_kit_retry_safely() {
    for profession_id in ["marksman", "scout", "craftsman", "medic", "brawler"] {
        let mut state = SliceAuthorityState::from_snapshot(&crate::authority_test_slice()).unwrap();
        let upsert = initial_profession_upsert(profession_id);

        for attempt in 0..2 {
            let actor = state
                .upsert_actor(upsert.clone())
                .unwrap_or_else(|error| panic!("{profession_id} attempt {attempt}: {error:?}"));
            assert!(
                actor.weapon.is_none(),
                "{profession_id} has no starter weapon"
            );
            assert_eq!(
                actor.skill_points_used, 16,
                "{profession_id} novice allocation persists"
            );
            assert_eq!(
                actor.worn,
                vec![
                    AuthorityActorWornPiece {
                        item: "under_bodysuit".to_owned(),
                        colors: vec!["#89cff0".to_owned()],
                    },
                    AuthorityActorWornPiece {
                        item: "boots_canvas_ankle".to_owned(),
                        colors: vec!["#303030".to_owned(), "#808080".to_owned()],
                    },
                ],
                "{profession_id} fixed worn starter outfit"
            );
            let mut owned = state
                .inventory_snapshots()
                .into_iter()
                .filter(|row| actor_owns_inventory_container("player", &row.container))
                .map(|row| (row.item_id, row.variant_id, row.quantity))
                .collect::<Vec<_>>();
            owned.sort_unstable();
            assert_eq!(
                owned,
                vec![(7_319, 0, 1), (9_900_001, 0, 1)],
                "{profession_id} retry carries only the fixed outfit"
            );
        }
    }
}

#[test]
fn authority_bare_start_reupsert_does_not_duplicate_nearby_exchange_starter_tools() {
    let mut snapshot = crate::authority_test_slice();
    snapshot.inventory.clear();
    snapshot.props.clear();
    snapshot
        .props
        .push(test_exchange_prop(CellSnapshot::new(12, 12)));
    let mut state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    let upsert = initial_profession_upsert("craftsman");

    state
        .upsert_actor(upsert.clone())
        .expect("initial craftsman upsert succeeds");
    assert_eq!(
        state.actor_inventory_available_quantity("player", FIELD_MULTITOOL_ITEM_ID),
        0,
        "bare start carries no profession field tool"
    );
    assert_eq!(
        state.actor_inventory_available_quantity("player", MINERAL_SURVEY_TOOL_ITEM_ID),
        0,
        "bare start carries no profession survey tool"
    );
    assert_eq!(state.actors["player"].equipped_weapon_id, None);
    let mut initial_owned = state
        .inventory_snapshots()
        .into_iter()
        .filter(|row| actor_owns_inventory_container("player", &row.container))
        .map(|row| (row.item_id, row.variant_id, row.quantity))
        .collect::<Vec<_>>();
    initial_owned.sort_unstable();
    assert_eq!(initial_owned, vec![(7_319, 0, 1), (9_900_001, 0, 1)]);

    state.inventory.retain(|row| {
        !(actor_owns_inventory_container("player", &row.container)
            && matches!(
                row.item_id,
                FIELD_MULTITOOL_ITEM_ID | MINERAL_SURVEY_TOOL_ITEM_ID
            ))
    });
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

    state
        .upsert_actor(upsert)
        .expect("bare-start craftsman re-upsert succeeds");
    for item_id in [FIELD_MULTITOOL_ITEM_ID, MINERAL_SURVEY_TOOL_ITEM_ID] {
        assert_eq!(
            state.actor_inventory_available_quantity("player", item_id),
            0,
            "nearby exchange starter tool is not duplicated into carried inventory"
        );
        assert_eq!(
            state
                .inventory_snapshots()
                .iter()
                .filter(|row| row.container == EXCHANGE_CONTAINER && row.item_id == item_id)
                .map(|row| row.quantity)
                .sum::<u32>(),
            1,
            "nearby exchange starter tool quantity remains stable"
        );
    }
}

#[test]
fn authority_returning_upsert_preserves_exact_owned_stacks_and_reservations() {
    let mut state = SliceAuthorityState::from_snapshot(&crate::authority_test_slice()).unwrap();
    state
        .inventory
        .retain(|row| !actor_owns_inventory_container("player", &row.container));
    state.reservations.retain(|row| {
        row.actor != "player" && !actor_owns_inventory_container("player", &row.from)
    });
    state.inventory.extend([
        InventoryStackSnapshot {
            stack_id: 91_001,
            container: "player:field-pack".to_owned(),
            item: inventory_item_name(RESOURCE_CREATURE_HIDE_ITEM_ID)
                .unwrap()
                .to_owned(),
            item_id: RESOURCE_CREATURE_HIDE_ITEM_ID,
            variant_id: 7,
            quantity: 13,
            reserved: 2,
            available: 11,
        },
        InventoryStackSnapshot {
            stack_id: 91_002,
            container: "player:bank".to_owned(),
            item: inventory_item_name(RESOURCE_CREATURE_BONE_ITEM_ID)
                .unwrap()
                .to_owned(),
            item_id: RESOURCE_CREATURE_BONE_ITEM_ID,
            variant_id: 9,
            quantity: 5,
            reserved: 0,
            available: 5,
        },
        InventoryStackSnapshot {
            stack_id: 91_003,
            container: "player:field-pack".to_owned(),
            item: inventory_item_name(RESOURCE_CREATURE_MEAT_ITEM_ID)
                .unwrap()
                .to_owned(),
            item_id: RESOURCE_CREATURE_MEAT_ITEM_ID,
            variant_id: 3,
            quantity: 4,
            reserved: 0,
            available: 4,
        },
    ]);
    state.reservations.push(ReservationSnapshot {
        id: 91_001,
        actor: "player".to_owned(),
        purpose: "returning-preserve".to_owned(),
        from: "player:field-pack".to_owned(),
        item: inventory_item_name(RESOURCE_CREATURE_HIDE_ITEM_ID)
            .unwrap()
            .to_owned(),
        quantity: 2,
        expires_at_tick: None,
    });
    let owned_inventory_before = state
        .inventory
        .iter()
        .filter(|row| actor_owns_inventory_container("player", &row.container))
        .cloned()
        .collect::<Vec<_>>();
    let owned_reservations_before = state
        .reservation_snapshots()
        .into_iter()
        .filter(|row| row.actor == "player" || actor_owns_inventory_container("player", &row.from))
        .collect::<Vec<_>>();

    assert!(state.remove_actor("player"));
    let mut returning = creator_clothing_upsert(Vec::new(), BTreeMap::new());
    returning.entity = "char-returning".to_owned();
    returning.returning = true;
    let actor = state
        .upsert_actor(returning)
        .expect("returning player upsert succeeds");

    let owned_inventory_after = state
        .inventory
        .iter()
        .filter(|row| actor_owns_inventory_container("player", &row.container))
        .cloned()
        .collect::<Vec<_>>();
    let owned_reservations_after = state
        .reservation_snapshots()
        .into_iter()
        .filter(|row| row.actor == "player" || actor_owns_inventory_container("player", &row.from))
        .collect::<Vec<_>>();
    assert_eq!(owned_inventory_after, owned_inventory_before);
    assert_eq!(owned_reservations_after, owned_reservations_before);
    assert_eq!(actor.entity, "char-returning");
    assert!(actor.weapon.is_none());
    assert!(owned_inventory_after.iter().all(|row| {
        ![
            CRAFTED_SLUGTHROWER_ITEM_ID,
            FIELD_MULTITOOL_ITEM_ID,
            STIMPAK_A_ITEM_ID,
        ]
        .contains(&row.item_id)
    }));
}

#[test]
fn authority_player_like_personal_shield_absorbs_roll_damage_then_recharges() {
    let config = SliceAuthorityConfig {
        player_actor_id: "shield-target".to_owned(),
        ..SliceAuthorityConfig::default()
    };
    let mut snapshot = crate::authority_test_slice();
    snapshot.actors.clear();
    snapshot.npc_jobs.clear();
    snapshot.actors.push(test_actor(
        "shield-shooter",
        "Shield Shooter",
        "combat_npc",
        CellSnapshot::new(34, 21),
        "right",
    ));
    snapshot.actors.push(test_actor(
        "shield-target",
        "Shield Target",
        "agent_player",
        CellSnapshot::new(40, 21),
        "left",
    ));
    let mut state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    let tick = state.tick();
    {
        let target = state.actors.get_mut("shield-target").unwrap();
        target.effective_stats.dodge_chance_milli = 0;
        target.equipped_weapon_id = Some(AuthorityWeaponId::Vibrosword);
        target.personal_shield = Some(PersonalShieldAuthorityState::fresh(tick));
    }
    let absorbed_damage = u32::try_from(TEST_ROLL_DAMAGE).unwrap();
    let expected_remaining_hit_points =
        PERSONAL_SHIELD_MAX_HIT_POINTS.saturating_sub(absorbed_damage);
    let tick_rate_hz = state.tick_rate_hz;
    let outcome = SliceAuthorityState::try_block_with_personal_shield(
        state.actors.get_mut("shield-target").unwrap(),
        tick,
        tick_rate_hz,
        TEST_ROLL_DAMAGE,
    )
    .expect("melee player shield absorbs Roll damage");

    assert_eq!(outcome.damage_after_shield, 0);
    let effect = &outcome.effect;
    assert_eq!(effect.kind, "shield");
    assert_eq!(
        effect.stacks,
        u8::try_from(expected_remaining_hit_points).unwrap()
    );
    assert_eq!(
        effect.threshold,
        u8::try_from(PERSONAL_SHIELD_MAX_HIT_POINTS).unwrap()
    );
    assert_eq!(
        u64::from(effect.remaining_ticks),
        ms_to_ticks_round(PERSONAL_SHIELD_RECHARGE_DELAY_MS, state.tick_rate_hz)
    );
    let target = state.actors.get("shield-target").unwrap();
    let shield = target
        .personal_shield
        .as_ref()
        .expect("shield keeps remaining durability after one blocked hit");
    assert_eq!(
        shield.charge_milli,
        expected_remaining_hit_points.saturating_mul(PERSONAL_SHIELD_HIT_POINT_MILLI)
    );
    assert_eq!(
        shield.durability_charges,
        PERSONAL_SHIELD_MAX_DURABILITY_CHARGES
    );
    assert_eq!(
        shield.durability_milli,
        PERSONAL_SHIELD_MAX_DURABILITY_MILLI
    );
    state.actors.remove("shield-shooter");
    let delay_ticks = ms_to_ticks_round(PERSONAL_SHIELD_RECHARGE_DELAY_MS, state.tick_rate_hz);
    let recharge_ticks = ms_to_ticks_round(PERSONAL_SHIELD_RECHARGE_FULL_MS, state.tick_rate_hz);
    advance_ticks_unclamped(&mut state, &config, delay_ticks + recharge_ticks + 1);

    let snapshot = state.actor_snapshot("shield-target").unwrap();
    let shield = snapshot
        .personal_shield
        .as_ref()
        .expect("shield snapshot survives recharge");
    assert_eq!(shield.charge_milli, PERSONAL_SHIELD_MAX_CHARGE_MILLI);
    assert_eq!(
        shield.durability_milli,
        PERSONAL_SHIELD_MAX_DURABILITY_MILLI
            .saturating_sub(absorbed_damage.saturating_mul(PERSONAL_SHIELD_HIT_POINT_MILLI))
    );
    assert_eq!(
        shield.durability_charges,
        PERSONAL_SHIELD_MAX_DURABILITY_CHARGES
    );
    assert!(!shield.recharge_blocked);
}

#[test]
fn authority_personal_shield_reports_overflow_then_breaks() {
    let mut snapshot = crate::authority_test_slice();
    snapshot.actors.clear();
    snapshot.npc_jobs.clear();
    snapshot.actors.push(test_actor(
        "shield-shooter",
        "Shield Shooter",
        "combat_npc",
        CellSnapshot::new(34, 21),
        "right",
    ));
    snapshot.actors.push(test_actor(
        "shield-target",
        "Shield Target",
        "agent_player",
        CellSnapshot::new(40, 21),
        "left",
    ));
    let mut state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    let partial_shield_hit_points = 4;
    let tick = state.tick();
    {
        let target = state.actors.get_mut("shield-target").unwrap();
        target.effective_stats.dodge_chance_milli = 0;
        target.equipped_weapon_id = Some(AuthorityWeaponId::Vibrosword);
        target.personal_shield = Some(PersonalShieldAuthorityState {
            charge_milli: partial_shield_hit_points * PERSONAL_SHIELD_HIT_POINT_MILLI,
            durability_milli: 0,
            durability_charges: 0,
            last_damage_tick: tick,
            last_block_tick: 0,
        });
    }
    let tick_rate_hz = state.tick_rate_hz;
    let blocked = SliceAuthorityState::try_block_with_personal_shield(
        state.actors.get_mut("shield-target").unwrap(),
        tick,
        tick_rate_hz,
        TEST_ROLL_DAMAGE,
    )
    .expect("remaining shield charge absorbs part of the Roll damage");
    assert_eq!(
        blocked.damage_after_shield,
        TEST_ROLL_DAMAGE - i32::try_from(partial_shield_hit_points).unwrap()
    );
    assert_eq!(blocked.effect.kind, "shield");
    assert!(state
        .actors
        .get("shield-target")
        .unwrap()
        .personal_shield
        .is_none());

    assert!(SliceAuthorityState::try_block_with_personal_shield(
        state.actors.get_mut("shield-target").unwrap(),
        tick,
        tick_rate_hz,
        TEST_ROLL_DAMAGE,
    )
    .is_none());
}

#[test]
fn authority_personal_shield_at_zero_charge_recharges_when_durable() {
    let config = SliceAuthorityConfig {
        player_actor_id: "shield-target".to_owned(),
        ..SliceAuthorityConfig::default()
    };
    let mut snapshot = crate::authority_test_slice();
    snapshot.actors.clear();
    snapshot.npc_jobs.clear();
    snapshot.actors.push(test_actor(
        "shield-shooter",
        "Shield Shooter",
        "combat_npc",
        CellSnapshot::new(34, 21),
        "right",
    ));
    snapshot.actors.push(test_actor(
        "shield-target",
        "Shield Target",
        "agent_player",
        CellSnapshot::new(40, 21),
        "left",
    ));
    let mut state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    let partial_shield_hit_points = 4;
    let tick = state.tick();
    {
        let target = state.actors.get_mut("shield-target").unwrap();
        target.effective_stats.dodge_chance_milli = 0;
        target.equipped_weapon_id = Some(AuthorityWeaponId::Vibrosword);
        target.personal_shield = Some(PersonalShieldAuthorityState {
            charge_milli: partial_shield_hit_points * PERSONAL_SHIELD_HIT_POINT_MILLI,
            durability_milli: PERSONAL_SHIELD_MAX_DURABILITY_MILLI,
            durability_charges: PERSONAL_SHIELD_MAX_DURABILITY_CHARGES,
            last_damage_tick: tick,
            last_block_tick: 0,
        });
    }
    let tick_rate_hz = state.tick_rate_hz;
    let blocked = SliceAuthorityState::try_block_with_personal_shield(
        state.actors.get_mut("shield-target").unwrap(),
        tick,
        tick_rate_hz,
        TEST_ROLL_DAMAGE,
    )
    .expect("durable shield absorbs its remaining charge");
    assert_eq!(
        blocked.damage_after_shield,
        TEST_ROLL_DAMAGE - i32::try_from(partial_shield_hit_points).unwrap()
    );
    let shield = state
        .actors
        .get("shield-target")
        .unwrap()
        .personal_shield
        .as_ref()
        .expect("zero-charge durable shield remains equipped");
    assert_eq!(shield.charge_milli, 0);
    assert_eq!(
        shield.durability_milli,
        PERSONAL_SHIELD_MAX_DURABILITY_MILLI
    );

    state.actors.remove("shield-shooter");
    let delay_ticks = ms_to_ticks_round(PERSONAL_SHIELD_RECHARGE_DELAY_MS, state.tick_rate_hz);
    let recharge_ticks = ms_to_ticks_round(PERSONAL_SHIELD_RECHARGE_FULL_MS, state.tick_rate_hz);
    advance_ticks_unclamped(&mut state, &config, delay_ticks + recharge_ticks + 1);

    let shield = state
        .actors
        .get("shield-target")
        .unwrap()
        .personal_shield
        .as_ref()
        .expect("durable zero-charge shield recharges instead of disappearing");
    assert_eq!(shield.charge_milli, PERSONAL_SHIELD_MAX_CHARGE_MILLI);
    assert_eq!(
        shield.durability_milli,
        PERSONAL_SHIELD_MAX_DURABILITY_MILLI.saturating_sub(PERSONAL_SHIELD_MAX_CHARGE_MILLI)
    );
}

#[test]
fn authority_ranged_player_like_personal_shield_does_not_activate() {
    let config = SliceAuthorityConfig::default();
    let mut snapshot = crate::authority_test_slice();
    snapshot.actors.clear();
    snapshot.npc_jobs.clear();
    snapshot.actors.push(test_actor(
        "shield-shooter",
        "Shield Shooter",
        "combat_npc",
        CellSnapshot::new(34, 21),
        "right",
    ));
    snapshot.actors.push(test_actor(
        "shield-target",
        "Shield Target",
        "agent_player",
        CellSnapshot::new(40, 21),
        "left",
    ));
    let mut state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    let tick = state.tick();
    {
        let target = state.actors.get_mut("shield-target").unwrap();
        target.effective_stats.dodge_chance_milli = 0;
        target.equipped_weapon_id = Some(AuthorityWeaponId::Slugthrower);
        target.personal_shield = Some(PersonalShieldAuthorityState::fresh(tick));
    }
    let tick_rate_hz = state.tick_rate_hz;
    assert!(SliceAuthorityState::try_block_with_personal_shield(
        state.actors.get_mut("shield-target").unwrap(),
        tick,
        tick_rate_hz,
        TEST_ROLL_DAMAGE,
    )
    .is_none());

    advance_ticks_unclamped(&mut state, &config, 1);
    assert!(state
        .actor_snapshot("shield-target")
        .unwrap()
        .personal_shield
        .is_none());
}

#[test]
fn authority_ranged_player_like_does_not_auto_equip_personal_shield_from_inventory() {
    let config = SliceAuthorityConfig::default();
    let snapshot = crate::authority_test_slice();
    let mut state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    state.add_actor_inventory_stack(
        "player",
        PERSONAL_SHIELD_GENERATOR_ITEM_ID,
        0,
        "Personal Shield Generator",
        1,
        PERSONAL_SHIELD_GENERATOR_STACK_CAP,
        "field-pack",
    );

    advance_ticks_unclamped(&mut state, &config, 1);

    let player = state.actors.get("player").expect("player actor exists");
    assert!(
        player.personal_shield.is_none(),
        "ranged player should not auto-equip melee-only PSG"
    );
    assert_eq!(
        state.actor_inventory_available_quantity("player", PERSONAL_SHIELD_GENERATOR_ITEM_ID),
        1,
        "ranged player should keep the carried PSG inventory item"
    );
}

#[test]
fn authority_melee_player_like_auto_equips_personal_shield_from_inventory() {
    let config = SliceAuthorityConfig::default();
    let snapshot = crate::authority_test_slice();
    let mut state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    grant_test_profession(&mut state, "player", AuthorityProfessionKind::Brawler);
    state
        .actors
        .get_mut("player")
        .expect("player actor exists")
        .equipped_weapon_id = Some(AuthorityWeaponId::Vibrosword);
    state.add_actor_inventory_stack(
        "player",
        PERSONAL_SHIELD_GENERATOR_ITEM_ID,
        0,
        "Personal Shield Generator",
        1,
        PERSONAL_SHIELD_GENERATOR_STACK_CAP,
        "field-pack",
    );

    advance_ticks_unclamped(&mut state, &config, 1);

    let player = state.actors.get("player").expect("player actor exists");
    let shield = player
        .personal_shield
        .as_ref()
        .expect("melee player-like actor should auto-equip carried PSG");
    assert_eq!(shield.charge_milli, PERSONAL_SHIELD_MAX_CHARGE_MILLI);
    assert_eq!(
        shield.durability_charges,
        PERSONAL_SHIELD_MAX_DURABILITY_CHARGES
    );
    assert_eq!(
        state.actor_inventory_available_quantity("player", PERSONAL_SHIELD_GENERATOR_ITEM_ID),
        0,
        "equipping consumes the carried PSG inventory item"
    );
}

#[test]
fn authority_keeps_npc_corpse_visible_before_home_respawn_when_cloner_exists() {
    let config = SliceAuthorityConfig::default();
    let mut snapshot = crate::authority_test_slice();
    snapshot
        .clone_facilities
        .push(crate::CloneFacilitySnapshot {
            id: "bolt-cloner".to_owned(),
            label: "Bolt Cloner".to_owned(),
            area_id: "authority-test-workshop".to_owned(),
            respawn_cell: CellSnapshot::new(9, 5),
            respawn_facing: "back".to_owned(),
            sickness_duration_ms: 180_000,
        });
    let mut state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    // DEF-10: public_shopkeeper is now a protected civilian (can_actor_attack rejects it).
    // This test exercises NPC corpse/home-respawn mechanics, so retarget the dummy to
    // the damageable practice-dummy role (still a non-player NPC using the corpse timer).
    state.actors.get_mut("vendor").unwrap().role = "target_dummy".to_owned();
    let (home_area_id, home_cell, home_direction) = {
        let vendor = state.actors.get("vendor").unwrap();
        (
            vendor.home_area_id.clone(),
            vendor.home_cell,
            vendor.home_direction.clone(),
        )
    };
    let tick = state.tick();
    let tick_rate_hz = state.tick_rate_hz;
    let vendor = state.actors.get_mut("vendor").unwrap();
    vendor.vitals.health = 0;
    SliceAuthorityState::kill_actor_for_respawn(tick, tick_rate_hz, vendor);

    let corpse = state.actor_snapshot("vendor").unwrap();
    assert_eq!(corpse.life_state, AuthorityLifeState::Downed);
    assert_eq!(
        corpse.body_vanish_tick,
        state.tick() + CORPSE_BODY_NO_LOOT_TICKS
    );
    assert_eq!(corpse.respawn_tick, 0);

    advance_ticks_unclamped(&mut state, &config, CORPSE_BODY_NO_LOOT_TICKS);
    assert_eq!(
        state.actor_snapshot("vendor").unwrap().life_state,
        AuthorityLifeState::Respawning
    );

    advance_ticks_unclamped(&mut state, &config, CORPSE_BODY_NO_LOOT_TICKS);
    let respawned = state.actor_snapshot("vendor").unwrap();
    assert_eq!(respawned.life_state, AuthorityLifeState::Alive);
    assert_eq!(respawned.area_id, home_area_id);
    assert_actor_position(&respawned, f64::from(home_cell.x), f64::from(home_cell.y));
    assert_eq!(respawned.direction, home_direction);
    assert_eq!(respawned.vitals, AuthorityVitals::default());
    assert!(!respawned.sleep.active);
}

#[test]
fn authority_respawn_return_walks_smoothly_instead_of_cell_snapping() {
    let config = SliceAuthorityConfig::default();
    let mut snapshot = crate::authority_test_slice();
    snapshot.actors.clear();
    snapshot.npc_jobs.clear();
    snapshot.actors.push(test_actor(
        "returning-creature",
        "Returning Creature",
        "creature",
        CellSnapshot::new(12, 14),
        "left",
    ));
    let mut state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    {
        let tick = state.tick();
        let actor = state.actors.get_mut("returning-creature").unwrap();
        actor.cell = AuthorityCell::new(28, 14);
        actor.position = AuthorityPosition::from_cell(actor.cell);
        actor.respawn_return = vec![RespawnReturnStepAuthorityState::Walk {
            area_id: crate::AUTHORITY_TEST_AREA_ID.to_owned(),
            cell: AuthorityCell::new(12, 14),
        }];
        actor.next_route_tick = tick;
    }

    state.advance_ticks_for_observer(
        &config,
        u16::try_from(ROUTE_PATROL_UPDATE_CADENCE_TICKS).unwrap(),
    );

    let returning = state.actor_snapshot("returning-creature").unwrap();
    assert!(
        returning.x < 28.0 && returning.x > 27.75,
        "respawn return should move smoothly from 28 toward 12, got {}",
        returning.x
    );
    assert_eq!(
        state
            .actors
            .get("returning-creature")
            .unwrap()
            .respawn_return
            .len(),
        1
    );
}

#[test]
fn authority_respawn_return_walks_through_occupied_cell() {
    let config = SliceAuthorityConfig::default();
    let mut snapshot = crate::authority_test_slice();
    snapshot.actors.clear();
    snapshot.npc_jobs.clear();
    snapshot.actors.push(test_actor(
        "returning-creature",
        "Returning Creature",
        "creature",
        CellSnapshot::new(12, 14),
        "left",
    ));
    snapshot.actors.push(test_actor(
        "blocking-shopkeeper",
        "Blocking Shopkeeper",
        "public_shopkeeper",
        CellSnapshot::new(27, 14),
        "left",
    ));
    let mut state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    state
        .actors
        .get_mut("blocking-shopkeeper")
        .unwrap()
        .sleep
        .remaining_ticks = 999;
    {
        let tick = state.tick();
        let actor = state.actors.get_mut("returning-creature").unwrap();
        actor.cell = AuthorityCell::new(28, 14);
        actor.position = AuthorityPosition::from_cell(actor.cell);
        actor.respawn_return = vec![RespawnReturnStepAuthorityState::Walk {
            area_id: crate::AUTHORITY_TEST_AREA_ID.to_owned(),
            cell: AuthorityCell::new(12, 14),
        }];
        actor.next_route_tick = tick;
    }

    state.advance_ticks_for_observer(
        &config,
        u16::try_from(NPC_ROUTE_STEP_INTERVAL_TICKS).unwrap(),
    );

    let returning = state.actor_snapshot("returning-creature").unwrap();
    assert!(
        returning.x < 27.0,
        "respawn return should pass through the occupied next cell, got {}",
        returning.x
    );
    assert_eq!(
        state
            .actors
            .get("returning-creature")
            .unwrap()
            .respawn_return
            .len(),
        1
    );
}

#[test]
fn authority_replay_hash_is_deterministic_for_current_client_fixture() {
    let fixture = OPEN_DESERT_FIXTURE_JSON;
    let snapshot: SliceSnapshot = serde_json::from_str(fixture).unwrap();
    let config = SliceAuthorityConfig::default();

    let commands = crate::current_authority_replay_commands(&config);
    let expected_frame_count = commands.len();
    let mut left = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    let mut right = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    let left_replay = left.apply_script(&config, commands.clone());
    let right_replay = right.apply_script(&config, commands);

    assert_eq!(left_replay.replay_hash, right_replay.replay_hash);
    assert_eq!(left_replay.final_state_hash, right_replay.final_state_hash);
    assert_eq!(left_replay.frames.len(), expected_frame_count);
    assert!(left_replay
        .frames
        .iter()
        .any(|frame| frame.status == AuthorityCommandStatus::Accepted));
    assert!(left_replay
        .frames
        .iter()
        .any(|frame| frame.status == AuthorityCommandStatus::Rejected));
}

#[test]
fn authority_brawler_profile_is_a_committed_melee_archetype() {
    let mut snapshot = crate::authority_test_slice();
    snapshot.actors.clear();
    let mut brawler = test_actor(
        "test-brawler-01",
        "Rogue Brawler",
        "skirmisher_brawler",
        CellSnapshot::new(140, 56),
        "left",
    );
    brawler.profession_ids.push("brawler".to_owned());
    snapshot.actors.push(brawler);

    let state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    let brawler = state.actors.get("test-brawler-01").unwrap();
    let profile = skirmisher_profile_for_ai_state(brawler);

    assert_eq!(profile.variant, SkirmisherVariant::Brawler);
    assert!(
        brawler.max_vitals.health >= 124,
        "melee brawlers need their role stats, not default actor health"
    );
    assert!(profile.speed_milli_cells_per_second >= 8_500);
    assert!(profile.max_range_milli >= 2_250);
    assert!(!profile.hold_cover_between_shots);
}

#[test]
fn authority_player_organization_blocks_same_org_friendly_fire() {
    let mut snapshot = crate::authority_test_slice();
    snapshot.factions = vec![
        crate::FactionSnapshot {
            id: "desert_wardens".to_owned(),
            label: "Desert Wardens".to_owned(),
            player_allowed: true,
            enemies: vec!["rogue_troopers".to_owned()],
            allies: Vec::new(),
            adjust_factor_milli: 1_000,
        },
        crate::FactionSnapshot {
            id: "rogue_troopers".to_owned(),
            label: "Rogue Troopers".to_owned(),
            player_allowed: false,
            enemies: vec!["desert_wardens".to_owned()],
            allies: Vec::new(),
            adjust_factor_milli: 1_000,
        },
    ];
    snapshot
        .player_organizations
        .push(crate::PlayerOrganizationSnapshot {
            id: "dwrd".to_owned(),
            label: "Desert Warden Cooperative".to_owned(),
            tag: "DWRD".to_owned(),
            member_actor_ids: vec![
                "player".to_owned(),
                "range-guard".to_owned(),
                "desert-warden-regression-ally".to_owned(),
            ],
            ally_organization_ids: Vec::new(),
            enemy_organization_ids: Vec::new(),
        });
    for actor in &mut snapshot.actors {
        if actor.id == "player" || actor.id == "range-guard" {
            actor.faction_id = Some("desert_wardens".to_owned());
            actor.social_group = Some("desert_wardens_player_org_dwrd".to_owned());
            actor.pvp_status = Some("overt".to_owned());
            actor.player_organization_id = Some("DWRD".to_owned());
            actor.player_organization_tag = Some("DWRD".to_owned());
            if actor.id == "player" {
                actor.profession_ids = vec!["marksman".to_owned()];
            }
        }
    }
    let mut armed_ally = test_actor(
        "desert-warden-regression-ally",
        "Desert Warden Regression Ally",
        "agent_player",
        CellSnapshot::new(38, 21),
        "right",
    );
    armed_ally.faction_id = Some("desert_wardens".to_owned());
    armed_ally.social_group = Some("desert_wardens_player_org_dwrd".to_owned());
    armed_ally.pvp_status = Some("overt".to_owned());
    armed_ally.player_organization_id = Some("DWRD".to_owned());
    armed_ally.player_organization_tag = Some("DWRD".to_owned());
    armed_ally.profession_ids = vec!["marksman".to_owned()];
    snapshot.actors.push(armed_ally);

    let mut rogue = test_actor(
        "rogue-trooper-alpha-01",
        "Rogue Alpha",
        "skirmisher",
        CellSnapshot::new(40, 21),
        "left",
    );
    rogue.faction_id = Some("rogue_troopers".to_owned());
    rogue.social_group = Some("rogue_trooper_wave_alpha".to_owned());
    rogue.pvp_status = Some("overt".to_owned());
    snapshot.actors.push(rogue);

    let state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    let player = state.actors.get("player").unwrap();
    let guard = state.actors.get("range-guard").unwrap();

    assert_eq!(player.player_organization_id.as_deref(), Some("dwrd"));
    assert_eq!(player.player_organization_tag.as_deref(), Some("DWRD"));
    assert!(!state.can_actor_attack(player, guard));
    assert!(!state.can_actor_attack(guard, player));
    assert!(actor_has_capability(
        player,
        AUTHORITY_CAPABILITY_COMBAT_RANGED_BASIC
    ));
    assert!(
        skirmisher_enemy_applies_ranged_pressure(player),
        "Marksman-capable player actors must count as live combat pressure"
    );

    let rogue = state.actors.get("rogue-trooper-alpha-01").unwrap();
    assert!(state.can_actor_attack(rogue, player));
    assert!(
        state.target_allowed_while_under_ranged_pressure(rogue, player),
        "rogues must not filter out the human DWRD player while other armed DWRD pawns exist"
    );
}

#[test]
fn authority_hostile_skirmisher_opens_fire_from_midrange_lane() {
    let config = SliceAuthorityConfig::default();
    let mut snapshot = crate::authority_test_slice();
    add_test_factions(&mut snapshot);
    snapshot.actors.clear();
    snapshot.npc_jobs.clear();
    snapshot.props.clear();
    snapshot.blocked_cells.clear();

    let rogue_id = "hostile-skirmisher-fire-probe";
    let target_id = "blue-midrange-target";
    let mut rogue = test_actor(
        rogue_id,
        "Rogue Fire Probe",
        "skirmisher",
        CellSnapshot::new(20, 20),
        "right",
    );
    rogue.social_group = Some("hostile_patrol".to_owned());
    snapshot.actors.push(rogue);
    snapshot.actors.push(test_actor(
        target_id,
        "Blue Midrange Target",
        "skirmisher",
        CellSnapshot::new(44, 20),
        "left",
    ));

    let mut state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    {
        let target = state.actors.get_mut(target_id).unwrap();
        target.ai = None;
    }
    {
        let rogue = state.actors.get_mut(rogue_id).unwrap();
        let Some(AuthorityAiState::Skirmisher(ai)) = rogue.ai.as_mut() else {
            panic!("rogue should be a skirmisher");
        };
        ai.next_update_tick = 0;
        ai.last_update_tick = 0;
        ai.next_shot_tick = 0;
        ai.next_decision_tick = 0;
    }

    let rogue = state.actors.get(rogue_id).unwrap().clone();
    let target = state.actors.get(target_id).unwrap().clone();
    let start_gap = position_distance_milli(rogue.position, target.position);
    let (ideal_range_milli, max_range_milli) = state
        .roll_range_bands_milli_for_actor(&rogue)
        .expect("hostile skirmisher should carry a Roll-ranged weapon");
    assert_eq!(start_gap, ideal_range_milli);
    assert!(start_gap <= max_range_milli);

    for _ in 0..12 {
        state.advance_ticks_for_observer(&config, 1);
    }

    let rogue = state.actors.get(rogue_id).unwrap();
    let debug = state
        .ai_debug_snapshot()
        .actors
        .iter()
        .find(|row| row.actor_id == rogue_id)
        .cloned();
    assert!(
        rogue.shots_fired > 0,
        "hostile skirmisher should fire from the current Roll ideal range; gap={start_gap}, debug={debug:?}"
    );
}
